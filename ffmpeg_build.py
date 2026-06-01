# -*- coding: utf-8 -*-
"""
ffmpeg_build.py — 纯函数模块：把 project 模型（见 _build/contract.md §1）翻译成
一次重编码完成的 ffmpeg 调用所需的全部材料：

  1. 每条 text 的独立 UTF-8(无 BOM) textfile（content 原样写入，规避滤镜转义）
  2. 整张滤镜图的 UTF-8 -filter_complex_script 脚本文件
  3. 完整的 ffmpeg 参数列表（list，非 shell 字符串）

实现严格依据 _build/ffmpeg_recipe.md 的实测结论：
  - 路径转义：先把 '\\' 全换 '/'，再把 ':' 换成 '\\:'（单 \\: 即可，内联/脚本通用），
    并用单引号包裹 textfile=/fontfile= 的值。
  - 每 clip：trim/atrim + setpts/asetpts + scale+pad+setsar=1+fps+format=yuv420p。
  - 无音轨源用 anullsrc 按 clip 时长补静音；keepAudio=False 则全程不产音频链。
  - concat=n=N:v=1:a=1（或 a=0）。
  - [vcat] 上按 texts 数组顺序链式 drawtext，enable=between(t,start,end)。
  - 进度走 -progress pipe:1 -nostats。

本模块不依赖任何第三方库，可被 server.py import，也可被单测直接调用。
所有写文件统一 UTF-8 无 BOM。
"""

import os
import json


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def ff_escape_path(p):
    """把一个 Windows/任意路径转成 ffmpeg 滤镜图里安全的写法。
    规则（实测，见 ffmpeg_recipe.md §6）：
      1) 反斜杠 '\\' -> 正斜杠 '/'
      2) 冒号 ':' -> '\\:'
    返回的字符串还需在外层用单引号包裹（调用处负责）。
    """
    return str(p).replace("\\", "/").replace(":", "\\:")


def hex_to_0x(color):
    """'#RRGGBB' -> 'RRGGBB'（小写归一，去掉 '#'）。容错：缺失/格式错时回退到给定默认。
    drawtext 用 '0xRRGGBB' 或直接 '#RRGGBB' 都可；这里统一输出不带前缀的 6 位，
    调用处拼成 0xRRGGBB@alpha。
    """
    if not color:
        return None
    c = str(color).strip()
    if c.startswith("#"):
        c = c[1:]
    if len(c) == 3:  # 容错 #RGB
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        return None
    try:
        int(c, 16)
    except ValueError:
        return None
    return c.lower()


def _color_at(color, alpha, default_hex):
    """生成 drawtext 颜色串 '0xRRGGBB@<alpha>'。color 非法时用 default_hex。alpha clamp 到 [0,1]。"""
    hx = hex_to_0x(color) or hex_to_0x(default_hex) or "000000"
    a = _clampf(alpha if alpha is not None else 1.0, 0.0, 1.0)
    # 用定点表示，避免科学计数法
    return "0x%s@%s" % (hx, _fmt_num(a))


def _clampf(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = lo
    if v != v:  # NaN
        v = lo
    return lo if v < lo else (hi if v > hi else v)


def _fmt_num(v):
    """把 float 格式化为简洁、确定（无科学计数法、无多余 0）的字符串，供 ffmpeg 表达式使用。"""
    f = float(v)
    if f == int(f):
        return str(int(f))
    s = ("%.6f" % f).rstrip("0").rstrip(".")
    return s if s else "0"


def _to_even(n, minimum=2):
    n = int(round(float(n)))
    if n < minimum:
        n = minimum
    if n % 2 != 0:
        n -= 1
    if n < minimum:
        n = minimum
    return n


# ---------------------------------------------------------------------------
# 默认值（与 contract.md §1 一致）
# ---------------------------------------------------------------------------

TEXT_DEFAULTS = {
    "content": "双击编辑文字",
    "xPct": 0.1, "yPct": 0.1, "wPct": 0.3,
    "fontFile": "C:/Windows/Fonts/msyh.ttc",
    "fontSizePct": 0.05, "color": "#FFFFFF", "opacity": 1.0,
    "align": "left",
    "border": False, "borderColor": "#000000", "borderWPct": 0.004,
    "box": False, "boxColor": "#000000", "boxOpacity": 0.5,
    "start": 0.0, "end": None,
}

OUTPUT_DEFAULTS = {
    "width": 1920, "height": 1080, "fps": 30,
    "keepAudio": True, "crf": 18,
}

AUDIO_SR = 48000  # 统一音频采样率


# ---------------------------------------------------------------------------
# project 规范化 / 校验
# ---------------------------------------------------------------------------

class ExportValidationError(Exception):
    """project 校验失败（同步返回 400）。message 为中文描述。"""
    pass


def normalize_output(project):
    """读出 output 设置，套默认、取偶、clamp。返回规范化后的 dict（不修改入参）。"""
    out = dict(OUTPUT_DEFAULTS)
    o = (project or {}).get("output") or {}
    # 默认宽高：第一个 clip 所属源 -> 第一个源 -> 1920x1080
    def_w, def_h, def_fps = _default_output_dims(project)
    out["width"] = _to_even(o.get("width", def_w), 2)
    out["height"] = _to_even(o.get("height", def_h), 2)
    fps = o.get("fps", def_fps)
    try:
        fps = int(round(float(fps)))
    except (TypeError, ValueError):
        fps = def_fps
    out["fps"] = min(max(fps, 1), 120)
    out["keepAudio"] = bool(o.get("keepAudio", True))
    try:
        crf = int(round(float(o.get("crf", 18))))
    except (TypeError, ValueError):
        crf = 18
    out["crf"] = min(max(crf, 0), 51)
    return out


def _default_output_dims(project):
    sources = (project or {}).get("sources") or []
    clips = (project or {}).get("clips") or []
    src_by_id = {s.get("id"): s for s in sources if isinstance(s, dict)}
    src = None
    if clips and isinstance(clips[0], dict):
        src = src_by_id.get(clips[0].get("sourceId"))
    if src is None and sources:
        src = sources[0]
    if src and src.get("width") and src.get("height"):
        w = int(src["width"]); h = int(src["height"])
        fps = src.get("fps") or 30
        try:
            fps = int(round(float(fps)))
        except (TypeError, ValueError):
            fps = 30
        return w, h, max(1, fps)
    return 1920, 1080, 30


def validate_and_normalize(project, source_path_map):
    """校验 project，clamp 越界值，返回 (clips_norm, texts_norm, output_norm, ordered_sources)。

    - clips_norm: [{id, sourceId, in, out, dur}]（已 clamp 到源时长，out>in）
    - texts_norm: [{...全部字段已套默认/clamp...}]（已过滤掉 end<=start 的）
    - output_norm: dict
    - ordered_sources: [(sourceId, abs_path)]，去重后按首次出现顺序，给 -i 用；
                       同时给出 sourceId -> 输入序号 的映射 source_index。
    抛 ExportValidationError 表示 400。
    """
    if not isinstance(project, dict):
        raise ExportValidationError("导出请求缺少 project 数据")

    sources = project.get("sources") or []
    clips = project.get("clips") or []
    texts = project.get("texts") or []

    if not clips:
        raise ExportValidationError("时间轴为空，无法导出")

    # 源元数据索引（用于 clamp in/out 到 duration）
    src_meta = {}
    for s in sources:
        if isinstance(s, dict) and s.get("id") is not None:
            src_meta[s["id"]] = s

    output = normalize_output(project)

    # ---- 规范化 clips ----
    clips_norm = []
    for c in clips:
        if not isinstance(c, dict):
            raise ExportValidationError("clip 数据格式错误")
        cid = c.get("id")
        sid = c.get("sourceId")
        if sid not in source_path_map:
            raise ExportValidationError("片段 %s 引用了未知的源 id: %s" % (cid, sid))
        try:
            cin = float(c.get("in", 0.0))
            cout = float(c.get("out", 0.0))
        except (TypeError, ValueError):
            raise ExportValidationError("片段 %s 的 in/out 不是数字" % cid)
        # clamp 到源时长（防御）
        meta = src_meta.get(sid) or {}
        dur_src = meta.get("duration")
        if cin < 0:
            cin = 0.0
        if dur_src:
            try:
                dur_src = float(dur_src)
                if cout > dur_src:
                    cout = dur_src
                if cin > dur_src:
                    cin = dur_src
            except (TypeError, ValueError):
                pass
        if not (cout > cin):
            raise ExportValidationError("片段 %s 的出点必须大于入点 (in=%s, out=%s)" % (cid, cin, cout))
        clips_norm.append({"id": cid, "sourceId": sid, "in": cin, "out": cout, "dur": cout - cin})

    total_duration = sum(c["dur"] for c in clips_norm)
    if total_duration <= 0:
        raise ExportValidationError("时间轴总时长为 0，无法导出")

    # ---- 去重源、定输入顺序 ----
    ordered_ids = []
    seen = set()
    for c in clips_norm:
        if c["sourceId"] not in seen:
            seen.add(c["sourceId"])
            ordered_ids.append(c["sourceId"])
    ordered_sources = [(sid, source_path_map[sid]) for sid in ordered_ids]
    source_index = {sid: i for i, sid in enumerate(ordered_ids)}

    # 校验源音轨信息（用于无音轨补静音判断）
    src_has_audio = {}
    for sid in ordered_ids:
        meta = src_meta.get(sid) or {}
        src_has_audio[sid] = bool(meta.get("hasAudio", False))

    # ---- 规范化 texts ----
    texts_norm = []
    for t in texts:
        if not isinstance(t, dict):
            continue
        tn = dict(TEXT_DEFAULTS)
        tn.update({k: v for k, v in t.items() if v is not None})
        # 套默认 end
        if t.get("end") is None and tn.get("end") is None:
            tn["end"] = total_duration
        # 时间 clamp（B6）
        try:
            start = float(tn.get("start", 0.0))
        except (TypeError, ValueError):
            start = 0.0
        try:
            end = float(tn.get("end", total_duration))
        except (TypeError, ValueError):
            end = total_duration
        start = max(0.0, start)
        end = min(end, total_duration)
        if not (end > start):
            # B6：丢弃无效区间的 text
            continue
        tn["start"] = start
        tn["end"] = end
        # 位置/尺寸 clamp（B5）
        tn["xPct"] = _clampf(tn.get("xPct", 0.1), 0.0, 1.0)
        tn["yPct"] = _clampf(tn.get("yPct", 0.1), 0.0, 1.0)
        tn["wPct"] = _clampf(tn.get("wPct", 0.3), 0.001, 1.0)
        tn["fontSizePct"] = _clampf(tn.get("fontSizePct", 0.05), 0.001, 0.5)
        tn["borderWPct"] = _clampf(tn.get("borderWPct", 0.004), 0.0, 0.05)
        tn["opacity"] = _clampf(tn.get("opacity", 1.0), 0.0, 1.0)
        tn["boxOpacity"] = _clampf(tn.get("boxOpacity", 0.5), 0.0, 1.0)
        tn["border"] = bool(tn.get("border", False))
        tn["box"] = bool(tn.get("box", False))
        if str(tn.get("align")) not in ("left", "center", "right"):
            tn["align"] = "left"
        tn["content"] = "" if tn.get("content") is None else str(tn.get("content"))
        texts_norm.append(tn)

    # ---- 字体存在性校验（B13）----
    for tn in texts_norm:
        font = tn.get("fontFile") or TEXT_DEFAULTS["fontFile"]
        # 容许正/反斜杠；存在性用规范路径判断
        font_check = font.replace("/", os.sep).replace("\\", os.sep)
        if not os.path.isfile(font_check):
            raise ExportValidationError("找不到字体文件: %s" % font)
        tn["fontFile"] = font

    return {
        "clips": clips_norm,
        "texts": texts_norm,
        "output": output,
        "ordered_sources": ordered_sources,
        "source_index": source_index,
        "src_has_audio": src_has_audio,
        "total_duration": total_duration,
    }


# ---------------------------------------------------------------------------
# 滤镜图构建
# ---------------------------------------------------------------------------

def _build_clip_chains(norm):
    """生成每个 clip 的视频链（必产）与音频链（keepAudio 时产）。
    返回 (lines, v_labels, a_labels)。
    """
    clips = norm["clips"]
    output = norm["output"]
    source_index = norm["source_index"]
    src_has_audio = norm["src_has_audio"]
    keep_audio = output["keepAudio"]

    W = output["width"]
    H = output["height"]
    FPS = output["fps"]

    lines = []
    v_labels = []
    a_labels = []

    for k, c in enumerate(clips):
        idx = source_index[c["sourceId"]]
        cin = _fmt_num(c["in"])
        cout = _fmt_num(c["out"])
        vlab = "v%d" % k
        # 视频链：trim -> setpts -> scale -> pad -> setsar -> fps -> format
        vchain = (
            "[%d:v]trim=start=%s:end=%s,setpts=PTS-STARTPTS,"
            "scale=%d:%d:force_original_aspect_ratio=decrease,"
            "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,"
            "setsar=1,fps=%d,format=yuv420p[%s]"
            % (idx, cin, cout, W, H, W, H, FPS, vlab)
        )
        lines.append(vchain)
        v_labels.append(vlab)

        if keep_audio:
            alab = "a%d" % k
            if src_has_audio.get(c["sourceId"]):
                achain = (
                    "[%d:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS,"
                    "aresample=%d[%s]"
                    % (idx, cin, cout, AUDIO_SR, alab)
                )
            else:
                # 无音轨源：anullsrc 补静音，时长 = clip 时长
                achain = (
                    "anullsrc=channel_layout=stereo:sample_rate=%d,"
                    "atrim=duration=%s,asetpts=PTS-STARTPTS[%s]"
                    % (AUDIO_SR, _fmt_num(c["dur"]), alab)
                )
            lines.append(achain)
            a_labels.append(alab)

    return lines, v_labels, a_labels


def _build_concat(norm, v_labels, a_labels):
    """生成 concat 行，返回 (line, vcat_label, acat_label_or_None)。"""
    keep_audio = norm["output"]["keepAudio"]
    n = len(v_labels)
    if keep_audio:
        inputs = "".join("[%s][%s]" % (v_labels[i], a_labels[i]) for i in range(n))
        line = "%sconcat=n=%d:v=1:a=1[vcat][acat]" % (inputs, n)
        return line, "vcat", "acat"
    else:
        inputs = "".join("[%s]" % v_labels[i] for i in range(n))
        line = "%sconcat=n=%d:v=1:a=0[vcat]" % (inputs, n)
        return line, "vcat", None


def _build_drawtext_chain(norm, in_label, textfile_paths):
    """在 in_label（通常 vcat）上按 texts 顺序链式叠加 drawtext。
    textfile_paths: [abs_path]，与 norm['texts'] 一一对应。
    返回 (lines, final_label)。无 text 时返回 ([], in_label)。
    """
    texts = norm["texts"]
    output = norm["output"]
    H = output["height"]
    W = output["width"]

    if not texts:
        return [], in_label

    lines = []
    cur = in_label
    n = len(texts)
    for i, t in enumerate(texts):
        is_last = (i == n - 1)
        out_label = "vout" if is_last else ("vt%d" % (i + 1))

        # 字号：相对画面高度，至少 8
        fontsize = int(round(t["fontSizePct"] * H))
        if fontsize < 8:
            fontsize = 8

        textfile_esc = ff_escape_path(textfile_paths[i])
        fontfile_esc = ff_escape_path(t["fontFile"])

        parts = []
        parts.append("textfile='%s'" % textfile_esc)
        parts.append("fontfile='%s'" % fontfile_esc)
        parts.append("fontsize=%d" % fontsize)
        parts.append("fontcolor=%s" % _color_at(t["color"], t["opacity"], "#FFFFFF"))

        # 描边
        if t["border"]:
            bw = int(round(t["borderWPct"] * H))
            if bw < 1:
                bw = 1
            parts.append("borderw=%d" % bw)
            parts.append("bordercolor=%s" % _color_at(t["borderColor"], 1.0, "#000000"))

        # 半透明底框
        if t["box"]:
            parts.append("box=1")
            parts.append("boxcolor=%s" % _color_at(t["boxColor"], t["boxOpacity"], "#000000"))
            # 内边距 boxborderw：随字号给一点，视觉贴近预览
            boxborderw = max(2, int(round(fontsize * 0.18)))
            parts.append("boxborderw=%d" % boxborderw)

        # x 表达式按 align（以文字框 [x0, x0+BW]，x0=w*xPct, BW=w*wPct）
        xpct = _fmt_num(t["xPct"])
        wpct = _fmt_num(t["wPct"])
        ypct = _fmt_num(t["yPct"])
        align = t["align"]
        if align == "center":
            x_expr = "w*%s+(w*%s-text_w)/2" % (xpct, wpct)
        elif align == "right":
            x_expr = "w*%s+w*%s-text_w" % (xpct, wpct)
        else:  # left
            x_expr = "w*%s" % xpct
        parts.append("x=%s" % x_expr)
        parts.append("y=h*%s" % ypct)

        # 显隐区间
        parts.append("enable='between(t,%s,%s)'" % (_fmt_num(t["start"]), _fmt_num(t["end"])))

        line = "[%s]drawtext=%s[%s]" % (cur, ":".join(parts), out_label)
        lines.append(line)
        cur = out_label

    return lines, cur


def build_filter_script(norm, textfile_paths):
    """组装整张滤镜图脚本字符串（UTF-8）。
    返回 (script_text, vout_label, acat_label_or_None)。
    """
    lines = []

    clip_lines, v_labels, a_labels = _build_clip_chains(norm)
    lines.extend(clip_lines)

    concat_line, vcat, acat = _build_concat(norm, v_labels, a_labels)
    lines.append(concat_line)

    dt_lines, vout = _build_drawtext_chain(norm, vcat, textfile_paths)
    lines.extend(dt_lines)

    # 每条链以 ';' 结尾并换行（ffmpeg 8.1 允许 ';' 后换行，实测 EXIT 0）
    script_text = ";\n".join(lines) + "\n"
    return script_text, vout, acat


# ---------------------------------------------------------------------------
# 落盘 + 组装 ffmpeg 参数
# ---------------------------------------------------------------------------

def _write_utf8(path, text):
    """UTF-8 无 BOM 写文本。"""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_textfiles(norm, work_dir):
    """把每条 text 的 content 写入独立 UTF-8(无 BOM) 文件。
    返回 [abs_path] 与 norm['texts'] 一一对应。
    """
    paths = []
    for i, t in enumerate(norm["texts"]):
        p = os.path.join(work_dir, "text_%03d.txt" % i)
        # content 原样写入（含中文/换行/特殊字符），不做任何转义
        _write_utf8(p, t["content"])
        paths.append(os.path.abspath(p))
    return paths


def find_ffmpeg():
    """返回可用的 ffmpeg 可执行路径（PATH 优先，回退已知 WinGet 安装位置）。"""
    return _find_tool("ffmpeg")


def find_ffprobe():
    return _find_tool("ffprobe")


def _find_tool(name):
    import shutil
    exe = shutil.which(name)
    if exe:
        return exe
    # 回退：常见 gyan WinGet 安装目录
    candidates = []
    localapp = os.environ.get("LOCALAPPDATA")
    if localapp:
        base = os.path.join(localapp, "Microsoft", "WinGet", "Packages")
        if os.path.isdir(base):
            try:
                for d in os.listdir(base):
                    if "FFmpeg" in d or "ffmpeg" in d:
                        pkg = os.path.join(base, d)
                        for root, _dirs, files in os.walk(pkg):
                            fn = name + ".exe"
                            if fn in files:
                                candidates.append(os.path.join(root, fn))
            except OSError:
                pass
    if candidates:
        return candidates[0]
    # 实在找不到，返回裸名让 subprocess 去碰运气（也便于报错）
    return name


def build_ffmpeg_command(norm, output_path, work_dir, ffmpeg_exe=None):
    """生成完整 ffmpeg 参数列表 + 写好滤镜脚本与 textfile。

    返回 dict:
      {
        "args": [...],                # subprocess 用的 list
        "filter_script": <abs path>,
        "textfiles": [<abs path>...],
        "total_duration": float,      # 用于进度计算
        "vout": "vout", "acat": "acat"|None,
        "output_path": <abs path>,
      }
    要求 work_dir 已存在。
    """
    if ffmpeg_exe is None:
        ffmpeg_exe = find_ffmpeg()

    output = norm["output"]
    keep_audio = output["keepAudio"]

    # 1) textfiles
    textfile_paths = write_textfiles(norm, work_dir)

    # 2) 滤镜脚本
    script_text, vout, acat = build_filter_script(norm, textfile_paths)
    filter_script = os.path.abspath(os.path.join(work_dir, "filter.txt"))
    _write_utf8(filter_script, script_text)

    # 3) ffmpeg 参数列表
    args = [ffmpeg_exe, "-hide_banner", "-y"]
    for _sid, path in norm["ordered_sources"]:
        args += ["-i", path]
    args += ["-filter_complex_script", filter_script]
    args += ["-map", "[%s]" % vout]
    if keep_audio and acat:
        args += ["-map", "[%s]" % acat]
    args += ["-c:v", "libx264", "-crf", str(output["crf"]),
             "-preset", "medium", "-pix_fmt", "yuv420p", "-r", str(output["fps"])]
    if keep_audio and acat:
        args += ["-c:a", "aac", "-b:a", "192k"]
    args += ["-movflags", "+faststart"]
    args += ["-progress", "pipe:1", "-nostats"]
    args += [os.path.abspath(output_path)]

    return {
        "args": args,
        "filter_script": filter_script,
        "textfiles": textfile_paths,
        "total_duration": norm["total_duration"],
        "vout": vout,
        "acat": acat,
        "output_path": os.path.abspath(output_path),
    }


def build_export(project, output_path, source_path_map, work_dir, ffmpeg_exe=None):
    """一站式：校验+规范化 project，写文件，返回 build_ffmpeg_command 的结果。
    校验失败抛 ExportValidationError。
    """
    norm = validate_and_normalize(project, source_path_map)
    if not os.path.isdir(work_dir):
        os.makedirs(work_dir, exist_ok=True)
    return build_ffmpeg_command(norm, output_path, work_dir, ffmpeg_exe=ffmpeg_exe)


# ---------------------------------------------------------------------------
# 自测（python ffmpeg_build.py 时打印一个示例滤镜脚本，不实际跑 ffmpeg）
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import tempfile

    demo_project = {
        "sources": [
            {"id": "src_1", "path": "F:/视频素材/演示 A.mp4", "width": 1920, "height": 1080,
             "duration": 62.5, "fps": 29.97, "hasAudio": True},
            {"id": "src_2", "path": "F:/视频素材/补充片段 B.mp4", "width": 1280, "height": 720,
             "duration": 18.0, "fps": 30.0, "hasAudio": False},
        ],
        "clips": [
            {"id": "clip_1", "sourceId": "src_1", "in": 3.0, "out": 12.5},
            {"id": "clip_2", "sourceId": "src_2", "in": 0.0, "out": 6.0},
            {"id": "clip_3", "sourceId": "src_1", "in": 40.0, "out": 47.25},
        ],
        "texts": [
            {"id": "text_1", "content": "第一步：打开“设置”面板，点击右上角的齿轮 ⚙",
             "xPct": 0.08, "yPct": 0.78, "wPct": 0.84,
             "fontFile": "C:/Windows/Fonts/msyh.ttc",
             "fontSizePct": 0.06, "color": "#FFFFFF", "opacity": 1.0, "align": "center",
             "border": True, "borderColor": "#000000", "borderWPct": 0.004,
             "box": True, "boxColor": "#000000", "boxOpacity": 0.45,
             "start": 0.0, "end": 9.5},
        ],
        "output": {"width": 1920, "height": 1080, "fps": 30, "keepAudio": True, "crf": 18},
    }
    src_map = {s["id"]: s["path"] for s in demo_project["sources"]}
    work = os.path.join(tempfile.gettempdir(), "jianjianji_selftest")
    os.makedirs(work, exist_ok=True)
    try:
        result = build_export(demo_project, os.path.join(work, "out.mp4"), src_map, work)
        print("=== filter.txt ===")
        with open(result["filter_script"], encoding="utf-8") as f:
            print(f.read())
        print("=== ffmpeg args ===")
        print(json.dumps(result["args"], ensure_ascii=False, indent=2))
        print("total_duration =", result["total_duration"])
    except ExportValidationError as e:
        print("校验失败:", e)
