# -*- coding: utf-8 -*-
"""
ffmpeg_build.py (v2) — 纯函数模块：把 v2 多轨合成 project 模型（见 _build/contract_v2.md §1）
翻译成一次离线合成所需的全部材料：

  1. 每条 text-clip 的独立 UTF-8(无 BOM) textfile（content 原样写入，规避滤镜转义）
  2. 整张多轨合成滤镜图的 UTF-8 -filter_complex_script 脚本文件
  3. 完整的 ffmpeg 参数列表（list，非 shell 字符串）

实现严格依据 _build/ffmpeg_recipe_v2.md 的本机实测结论（v1 低层结论全部沿用）：
  - 路径转义 ff_escape_path：先把 '\\' 全换 '/'，再把 ':' 换成 '\\:'（单 \\:），
    结果形如 C\\:/Windows/Fonts/msyh.ttc；textfile=/fontfile= 的值用单引号包裹。
  - 视频合成 = 黑底底图(d=totalDuration) + 逐视频轨(底→顶=z序)逐片段
      trim -> setpts=PTS-STARTPTS+start/TB -> scale=clipW:clipH -> setsar=1
      [-> format=yuva420p,colorchannelmixer=aa=opacity (仅 opacity<1)]
    然后 overlay=x:y:eof_action=pass:enable='between(t,start,end)' 接力叠加。
  - 文字轨 = 在合成结果上按 z 序、轨内 start 链式 drawtext（enable=between(t,start,end)）。
  - 音频 = anullsrc 全长静音底轨锚定 T（★实测必须，规避坑1/坑2）
      + 每条未静音有声轨每片段 atrim/asetpts/aresample/aformat/volume/adelay
      + amix(inputs=N, normalize=0, dropout_transition=0) -> atrim=end=T。
  - 整图走 -filter_complex_script <UTF-8 脚本>；进度 -progress pipe:1 -nostats。
  - 总时长 totalDuration = max over all clips of (start + 时长)（多轨有重叠/间隙）。

本模块不依赖任何第三方库，可被 server.py import，也可被单测直接调用。
所有写文件统一 UTF-8 无 BOM。
"""

import os


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def ff_escape_path(p):
    """把一个 Windows/任意路径转成 ffmpeg 滤镜图里安全的写法。
    规则（实测，见 ffmpeg_recipe_v2.md / v1 §6）：
      1) 反斜杠 '\\' -> 正斜杠 '/'
      2) 冒号 ':' -> '\\:'
    返回的字符串还需在外层用单引号包裹（调用处负责）。
    """
    return str(p).replace("\\", "/").replace(":", "\\:")


def hex_to_0x(color):
    """'#RRGGBB' -> 'rrggbb'（小写，去 '#'）。容错 #RGB；非法返回 None。"""
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


def atempo_chain(speed):
    """返回 atempo 因子列表；乘积 == clamp 后的 speed，每个因子 ∈ [0.5, 2.0]。
    （见 _build/speed_ffmpeg.md §3.3，本机实测 7 个倍率 product 全 == speed。）
    speed>2 反复除以 2、speed<0.5 反复除以 0.5，各得一个 2.0/0.5 因子，余数作末级。
    -> 0.25:[0.5,0.5] 0.5:[0.5] 1.0:[1.0] 1.5:[1.5] 2.0:[2.0] 3.0:[2.0,1.5] 4.0:[2.0,2.0]
    """
    speed = _clampf(speed, 0.25, 4.0)               # 钳制到 [0.25,4]
    factors = []
    s = speed
    while s > 2.0 + 1e-9:                            # 快放超 2 -> 拆 2.0
        factors.append(2.0)
        s /= 2.0
    while s < 0.5 - 1e-9:                            # 慢放低于 0.5 -> 拆 0.5
        factors.append(0.5)
        s /= 0.5
    factors.append(round(s, 6))                      # 余数（必在 [0.5,2]）
    return factors


def atempo_filter_str(speed):
    """拼成 atempo 滤镜串；speed==1 返回空串（整段不加 atempo，省一次重采样/相位处理）。
    speed=4 -> "atempo=2,atempo=2"; speed=0.25 -> "atempo=0.5,atempo=0.5"; speed=3 -> "atempo=2,atempo=1.5"
    """
    if abs(_clampf(speed, 0.25, 4.0) - 1.0) < 1e-9:
        return ""
    return ",".join("atempo=%s" % _fmt_num(f) for f in atempo_chain(speed))


def _to_even(n, minimum=2):
    """向下取偶（libx264 + yuv420p 要求宽高偶数），最小 minimum。"""
    n = int(round(float(n)))
    if n < minimum:
        n = minimum
    if n % 2 != 0:
        n -= 1
    if n < minimum:
        n = minimum
    return n


# ---------------------------------------------------------------------------
# 默认值（与 contract_v2.md §1 一致）
# ---------------------------------------------------------------------------

OUTPUT_DEFAULTS = {
    "width": 1920, "height": 1080, "fps": 30,
    "keepAudio": True, "crf": 18,
}

VIDEO_CLIP_DEFAULTS = {
    "in": 0.0, "out": None, "start": 0.0,
    "scale": 1.0, "cx": 0.5, "cy": 0.5, "opacity": 1.0,
}

TEXT_CLIP_DEFAULTS = {
    "content": "双击编辑文字",
    "start": 0.0, "duration": 3.0,
    "xPct": 0.1, "yPct": 0.1, "wPct": 0.5,
    "fontFile": "C:/Windows/Fonts/msyh.ttc",
    "fontSizePct": 0.06, "color": "#FFFFFF", "opacity": 1.0,
    "align": "left",
    "border": False, "borderColor": "#000000", "borderWPct": 0.004,
    "box": False, "boxColor": "#000000", "boxOpacity": 0.5,
}

TRACK_DEFAULTS = {
    "muted": False, "volume": 1.0, "hidden": False, "locked": False,
}

AUDIO_SR = 48000   # 统一音频采样率
AUDIO_BR = "192k"  # aac 码率
MIN_CLIP = 0.04    # 最小片段时长（秒）；契约 §6.1 = max(1/fps, 0.04)


# ---------------------------------------------------------------------------
# project 规范化 / 校验
# ---------------------------------------------------------------------------

class ExportValidationError(Exception):
    """project 校验失败（同步返回 400）。message 为中文描述。"""
    pass


def _default_output_dims(project, media_by_id):
    """默认宽高/帧率：首个入轨视频片段的 media -> 首个 media -> 1920x1080@30。"""
    first_media = None
    for tr in (project or {}).get("tracks") or []:
        if not isinstance(tr, dict) or tr.get("kind") != "video":
            continue
        for c in tr.get("clips") or []:
            if isinstance(c, dict):
                m = media_by_id.get(c.get("mediaId"))
                if m:
                    first_media = m
                    break
        if first_media:
            break
    if first_media is None:
        media = (project or {}).get("media") or []
        if media and isinstance(media[0], dict):
            first_media = media[0]
    if first_media and first_media.get("width") and first_media.get("height"):
        w = int(first_media["width"])
        h = int(first_media["height"])
        try:
            fps = int(round(float(first_media.get("fps") or 30)))
        except (TypeError, ValueError):
            fps = 30
        return w, h, max(1, fps)
    return 1920, 1080, 30


def normalize_output(project, media_by_id):
    """读出 output 设置，套默认、取偶、clamp。返回规范化后的 dict（不修改入参）。"""
    out = dict(OUTPUT_DEFAULTS)
    o = (project or {}).get("output") or {}
    def_w, def_h, def_fps = _default_output_dims(project, media_by_id)
    out["width"] = _to_even(o.get("width", def_w), 2)    # B15：向下取偶
    out["height"] = _to_even(o.get("height", def_h), 2)
    try:
        fps = int(round(float(o.get("fps", def_fps))))
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


def _pip_rect(clip, src_w, src_h, OW, OH):
    """PiP 像素换算（与契约 §5.1 / 预览逐字一致）。返回 (clipW, clipH, x, y)。
    clipW = round(scale*OW)；clipH = round(clipW*srcH/srcW)；
    x = round(cx*OW - clipW/2)；y = round(cy*OH - clipH/2)。
    clipW/clipH 取偶（libx264 友好；overlay 不强制但更稳）。
    """
    scale = _clampf(clip.get("scale", 1.0), 0.001, 16.0)
    cx = float(clip.get("cx", 0.5)) if clip.get("cx") is not None else 0.5
    cy = float(clip.get("cy", 0.5)) if clip.get("cy") is not None else 0.5
    clip_w = int(round(scale * OW))
    if clip_w < 2:
        clip_w = 2
    if clip_w % 2 != 0:
        clip_w -= 1
        if clip_w < 2:
            clip_w = 2
    clip_h = int(round(clip_w * float(src_h) / float(src_w)))
    if clip_h < 2:
        clip_h = 2
    if clip_h % 2 != 0:
        clip_h -= 1
        if clip_h < 2:
            clip_h = 2
    x = int(round(cx * OW - clip_w / 2.0))
    y = int(round(cy * OH - clip_h / 2.0))
    return clip_w, clip_h, x, y


def validate_and_normalize(project, source_path_map, media_meta=None):
    """校验 v2 project，clamp 越界值，返回规范化后的合成所需数据结构。

    参数：
      - project：见 contract_v2 §1（output/media/tracks）。
      - source_path_map：streamId -> 绝对路径（server 维护，用于 -i）。
      - media_meta：可选 mediaId -> {streamId,width,height,duration,fps,hasAudio}。
                    若缺省，从 project.media 自取（前端回传含这些字段）。

    返回 norm dict：
      {
        output, total_duration,
        ordered_sources: [(streamId, abs_path)],   # 去重后按出现顺序，给 -i
        video_clips: [ {streamIdx, in, out, start, end, clipW, clipH, x, y, opacity, trackIdx, clipIdx} ],
                       # 已按 z 序(底→顶) + 轨内 start 排好，可直接顺序 overlay
        text_clips:  [ {content, start, end, fontFile, fontsize, ... 全部已套默认/clamp} ],
                       # 已按 z 序(底→顶) + 轨内 start 排好；隐藏文字轨已剔除
        audio_clips: [ {streamIdx, in, out, start, volume} ],  # keepAudio 且未静音有声轨的片段
      }
    抛 ExportValidationError 表示同步 400。
    """
    if not isinstance(project, dict):
        raise ExportValidationError("导出请求缺少 project 数据")

    media_list = project.get("media") or []
    tracks = project.get("tracks") or []

    # ---- media 索引（含元数据，用于 clamp in/out 与 PiP 换算）----
    media_by_id = {}
    for m in media_list:
        if isinstance(m, dict) and m.get("id") is not None:
            media_by_id[m["id"]] = m
    if media_meta:
        # 后端权威元数据覆盖前端回传（更可信）
        for mid, meta in media_meta.items():
            base = dict(media_by_id.get(mid, {}))
            base.update({k: v for k, v in meta.items() if v is not None})
            media_by_id[mid] = base

    output = normalize_output(project, media_by_id)
    OW, OH = output["width"], output["height"]

    # ---- 第一遍：收集所有视频片段与文字片段，计算 totalDuration ----
    # 保留 tracks 数组顺序（index 0 = 底层 = 最先 overlay）。
    raw_video = []   # (trackIdx, clipIdx, clip, track, media)
    raw_text = []    # (trackIdx, clipIdx, clip, track)
    total_duration = 0.0
    has_any_clip = False

    for ti, track in enumerate(tracks):
        if not isinstance(track, dict):
            continue
        kind = track.get("kind")
        clips = track.get("clips") or []
        if kind == "video":
            for ci, clip in enumerate(clips):
                if not isinstance(clip, dict):
                    continue
                has_any_clip = True
                mid = clip.get("mediaId")
                media = media_by_id.get(mid)
                if media is None:
                    raise ExportValidationError(
                        "片段 %s 引用了未知素材 id: %s" % (clip.get("id"), mid))
                # streamId 必须可流式访问
                stream_id = media.get("streamId")
                if not stream_id or stream_id not in source_path_map:
                    raise ExportValidationError(
                        "素材 %s 的源不可用（streamId=%s）" % (mid, stream_id))
                raw_video.append((ti, ci, clip, track, media))
        elif kind == "text":
            for ci, clip in enumerate(clips):
                if not isinstance(clip, dict):
                    continue
                has_any_clip = True
                raw_text.append((ti, ci, clip, track))

    if not has_any_clip:
        raise ExportValidationError("时间轴为空，无法导出")

    # ---- 去重源、定 -i 顺序（按视频片段出现顺序）----
    ordered_ids = []
    seen = set()
    for (_ti, _ci, clip, _tr, media) in raw_video:
        sid = media.get("streamId")
        if sid not in seen:
            seen.add(sid)
            ordered_ids.append(sid)
    ordered_sources = [(sid, source_path_map[sid]) for sid in ordered_ids]
    stream_index = {sid: i for i, sid in enumerate(ordered_ids)}

    # ---- 规范化视频片段（clamp in/out 到 media.duration，校验 out>in）----
    video_clips = []
    for (ti, ci, clip, track, media) in raw_video:
        if bool(track.get("hidden", False)):
            continue  # 隐藏轨不渲染（视频不画）
        cid = clip.get("id")
        dur_src = media.get("duration")
        try:
            dur_src = float(dur_src) if dur_src not in (None, "", "N/A") else None
        except (TypeError, ValueError):
            dur_src = None
        try:
            start = float(clip.get("start", 0.0))
        except (TypeError, ValueError):
            start = 0.0
        if start < 0:
            start = 0.0
        try:
            src_fps = float(media.get("fps") or 0) or 30.0
        except (TypeError, ValueError):
            src_fps = 30.0

        freeze = bool(clip.get("freeze", False))
        if freeze:
            # 定格：源某一帧 T 冻结显示 duration 秒（时间轴长度与 in/out 解耦，强制静音）。
            try:
                ft = float(clip.get("freezeAt", clip.get("in", 0.0)))
            except (TypeError, ValueError):
                ft = 0.0
            ft = max(0.0, ft)
            if dur_src:
                ft = min(ft, max(0.0, dur_src - 1.0 / src_fps))   # 留 1 帧余量，保证能抽到帧
            try:
                fdur = float(clip.get("duration", 3.0))
            except (TypeError, ValueError):
                fdur = 3.0
            if not (fdur > 0):
                fdur = 3.0
            cin = cout = ft
            speed = 1.0
            tl_len = fdur
        else:
            try:
                cin = float(clip.get("in", 0.0))
                cout = clip.get("out")
                cout = float(cout) if cout is not None else None
            except (TypeError, ValueError):
                raise ExportValidationError("片段 %s 的 in/out 不是数字" % cid)
            if cout is None:
                cout = dur_src if dur_src else (cin + 1.0)
            # B4 clamp 到源时长
            if cin < 0:
                cin = 0.0
            if dur_src:
                if cout > dur_src:
                    cout = dur_src
                if cin > dur_src:
                    cin = dur_src
            if not (cout > cin):
                raise ExportValidationError(
                    "片段 %s 的出点必须大于入点 (in=%s, out=%s)" % (cid, _fmt_num(cin), _fmt_num(cout)))
            # 变速：tlLen = (out-in)/speed（公式 A）；end / totalDuration 全用 tlLen 累加（贯穿点）。
            speed = _clampf(clip.get("speed", 1.0), 0.25, 4.0)
            tl_len = (cout - cin) / speed

        end = start + tl_len
        if end > total_duration:
            total_duration = end

        clip_w, clip_h, x, y = _pip_rect(clip, media["width"], media["height"], OW, OH)
        opacity = _clampf(clip.get("opacity", 1.0), 0.0, 1.0)

        video_clips.append({
            "streamIdx": stream_index[media["streamId"]],
            "streamId": media["streamId"],
            "mediaId": media.get("id"),
            "hasAudio": bool(media.get("hasAudio", False)),
            "in": cin, "out": cout, "start": start, "end": end,
            "speed": speed, "tlLen": tl_len,
            "freeze": freeze, "srcFps": src_fps,
            "clipW": clip_w, "clipH": clip_h, "x": x, "y": y,
            "opacity": opacity,
            "trackIdx": ti, "clipIdx": ci,
            "muted": (True if freeze else bool(track.get("muted", False))),  # 定格段静音
            "trackVolume": _clampf(track.get("volume", 1.0), 0.0, 1.0),
        })

    # video_clips 已按 (trackIdx 升序, clipIdx) 顺序追加；同轨内再按 start 稳定排序，
    # 跨轨保持 trackIdx（z 序底→顶）优先，确保 overlay 顺序 = z 序。
    video_clips.sort(key=lambda v: (v["trackIdx"], v["start"]))

    # ---- 规范化文字片段 ----
    text_clips = []
    for (ti, ci, clip, track) in raw_text:
        if bool(track.get("hidden", False)):
            continue
        tn = dict(TEXT_CLIP_DEFAULTS)
        tn.update({k: v for k, v in clip.items() if v is not None})
        try:
            start = float(tn.get("start", 0.0))
        except (TypeError, ValueError):
            start = 0.0
        try:
            duration = float(tn.get("duration", 3.0))
        except (TypeError, ValueError):
            duration = 3.0
        start = max(0.0, start)
        if not (duration > 0):
            # B2：duration<=0 的文字直接跳过（前端应禁止产生）
            continue
        end = start + duration
        if end > total_duration:
            total_duration = end

        tn["start"] = start
        tn["end"] = end
        tn["trackIdx"] = ti
        # 位置/尺寸 clamp（B6）
        tn["xPct"] = _clampf(tn.get("xPct", 0.1), 0.0, 1.0)
        tn["yPct"] = _clampf(tn.get("yPct", 0.1), 0.0, 1.0)
        tn["wPct"] = _clampf(tn.get("wPct", 0.5), 0.001, 1.0)
        tn["fontSizePct"] = _clampf(tn.get("fontSizePct", 0.06), 0.01, 0.5)
        tn["borderWPct"] = _clampf(tn.get("borderWPct", 0.004), 0.0, 0.05)
        tn["opacity"] = _clampf(tn.get("opacity", 1.0), 0.0, 1.0)
        tn["boxOpacity"] = _clampf(tn.get("boxOpacity", 0.5), 0.0, 1.0)
        tn["border"] = bool(tn.get("border", False))
        tn["box"] = bool(tn.get("box", False))
        if str(tn.get("align")) not in ("left", "center", "right"):
            tn["align"] = "left"
        tn["content"] = "" if tn.get("content") is None else str(tn.get("content"))
        text_clips.append(tn)

    # 文字按 z 序(底→顶) + 轨内 start 排序（链式 drawtext，后画在更上）
    text_clips.sort(key=lambda t: (t["trackIdx"], t["start"]))

    if total_duration <= 0:
        raise ExportValidationError("时间轴总时长为 0，无法导出")

    # ---- 字体存在性校验（B13）----
    for tn in text_clips:
        font = tn.get("fontFile") or TEXT_CLIP_DEFAULTS["fontFile"]
        font_check = font.replace("/", os.sep).replace("\\", os.sep)
        if not os.path.isfile(font_check):
            raise ExportValidationError("找不到字体文件: %s" % font)
        tn["fontFile"] = font

    # ---- 音频片段（keepAudio 且未静音有声轨）----
    audio_clips = []
    if output["keepAudio"]:
        for v in video_clips:
            if v["muted"] or v["trackVolume"] <= 0:
                continue            # B9：muted/音量 0 的轨不参与混音
            if not v["hasAudio"]:
                continue            # 无音轨源不生成音频链
            audio_clips.append({
                "streamIdx": v["streamIdx"],
                "in": v["in"], "out": v["out"], "start": v["start"],
                "volume": v["trackVolume"], "speed": v["speed"],
            })

    return {
        "output": output,
        "total_duration": total_duration,
        "ordered_sources": ordered_sources,
        "video_clips": video_clips,
        "text_clips": text_clips,
        "audio_clips": audio_clips,
    }


# ---------------------------------------------------------------------------
# 滤镜图构建（多轨合成，依据 ffmpeg_recipe_v2 §9 模板）
# ---------------------------------------------------------------------------

def _build_video_chains(norm):
    """生成底图 + 逐视频片段处理链 + overlay 接力链。
    返回 (lines, last_label)。last_label 为最终 overlay 输出标签（无片段时为 base）。
    """
    output = norm["output"]
    W, H, FPS = output["width"], output["height"], output["fps"]
    T = _fmt_num(norm["total_duration"])

    lines = []
    # 黑底底图，贯穿 totalDuration
    lines.append("color=c=black:s=%dx%d:r=%d:d=%s,format=yuv420p[base]" % (W, H, FPS, T))

    accum = "base"
    n = 0
    for v in norm["video_clips"]:
        vlab = "v_%d_%d" % (v["trackIdx"], v["clipIdx"])
        if v.get("freeze"):
            # 定格：抽源 T 处一帧 → tpad 克隆该帧填满 D 秒 → 平移到时间轴 start。
            # 实际流略长于 D，无妨：overlay 的 enable=between(start,start+D) 把可见窗口钉在 D。
            T = v["in"]
            fps_src = v.get("srcFps") or 30.0
            slice_len = max(0.08, 2.0 / fps_src)         # 至少覆盖一帧
            chain = (
                "[%d:v]trim=start=%s:end=%s,setpts=PTS-STARTPTS,fps=%d,"
                "tpad=stop_mode=clone:stop_duration=%s,scale=%d:%d,setsar=1,"
                "setpts=PTS-STARTPTS+%s/TB"
                % (v["streamIdx"], _fmt_num(T), _fmt_num(T + slice_len), FPS,
                   _fmt_num(v["tlLen"]), v["clipW"], v["clipH"], _fmt_num(v["start"]))
            )
        else:
            # 变速：speed≠1 时 setpts=(PTS-STARTPTS)/speed+start/TB（源 out-in 拉伸/压缩为 tlLen 再平移）；
            # speed==1 退回 v2 原写法（零回归）。overlay enable 的 end 已按 tlLen 算好，无需改。
            speed = v.get("speed", 1.0)
            if abs(speed - 1.0) < 1e-9:
                setpts = "setpts=PTS-STARTPTS+%s/TB" % _fmt_num(v["start"])
            else:
                setpts = "setpts=(PTS-STARTPTS)/%s+%s/TB" % (_fmt_num(speed), _fmt_num(v["start"]))
            chain = (
                "[%d:v]trim=start=%s:end=%s,"
                "%s,"
                "scale=%d:%d,setsar=1"
                % (v["streamIdx"], _fmt_num(v["in"]), _fmt_num(v["out"]),
                   setpts, v["clipW"], v["clipH"])
            )
        if v["opacity"] < 1.0:
            chain += ",format=yuva420p,colorchannelmixer=aa=%s" % _fmt_num(v["opacity"])
        lines.append(chain + "[%s]" % vlab)

        n += 1
        next_accum = "bg%d" % n
        lines.append(
            "[%s][%s]overlay=x=%d:y=%d:eof_action=pass:enable='between(t,%s,%s)'[%s]"
            % (accum, vlab, v["x"], v["y"],
               _fmt_num(v["start"]), _fmt_num(v["end"]), next_accum)
        )
        accum = next_accum

    return lines, accum


def _build_drawtext_chains(norm, in_label, textfile_paths):
    """在 in_label 上按 text_clips 顺序链式叠加 drawtext。
    textfile_paths 与 norm['text_clips'] 一一对应。
    返回 (lines, final_label)。无文字时返回 ([], in_label)。
    """
    texts = norm["text_clips"]
    output = norm["output"]
    H = output["height"]

    if not texts:
        return [], in_label

    lines = []
    cur = in_label
    n = len(texts)
    for i, t in enumerate(texts):
        is_last = (i == n - 1)
        out_label = "vout" if is_last else ("vt%d" % (i + 1))

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

        if t["border"]:
            bw = int(round(t["borderWPct"] * H))
            if bw < 1:
                bw = 1
            parts.append("borderw=%d" % bw)
            parts.append("bordercolor=%s" % _color_at(t["borderColor"], 1.0, "#000000"))

        if t["box"]:
            parts.append("box=1")
            parts.append("boxcolor=%s" % _color_at(t["boxColor"], t["boxOpacity"], "#000000"))
            boxborderw = max(2, int(round(fontsize * 0.18)))
            parts.append("boxborderw=%d" % boxborderw)

        # x 按 align，框 [w*xPct, w*xPct + w*wPct]
        xpct = _fmt_num(t["xPct"])
        wpct = _fmt_num(t["wPct"])
        ypct = _fmt_num(t["yPct"])
        align = t["align"]
        if align == "center":
            x_expr = "w*%s+(w*%s-text_w)/2" % (xpct, wpct)
        elif align == "right":
            x_expr = "w*%s+w*%s-text_w" % (xpct, wpct)
        else:
            x_expr = "w*%s" % xpct
        parts.append("x=%s" % x_expr)
        parts.append("y=h*%s" % ypct)

        parts.append("enable='between(t,%s,%s)'" % (_fmt_num(t["start"]), _fmt_num(t["end"])))

        lines.append("[%s]drawtext=%s[%s]" % (cur, ":".join(parts), out_label))
        cur = out_label

    return lines, cur


def _build_audio_chains(norm):
    """生成音频混音链（全长静音底轨 + 逐片段 + amix）。
    返回 (lines, aout_label_or_None)。keepAudio=False 或无任何输出音频时返回 ([], None)。
    """
    output = norm["output"]
    if not output["keepAudio"]:
        return [], None

    T = _fmt_num(norm["total_duration"])
    lines = []

    # 全长静音底轨，锚定总时长 T（★实测必须：规避坑1 apad 溢出 / 坑2 音频短于 T）
    lines.append(
        "anullsrc=channel_layout=stereo:sample_rate=%d,atrim=end=%s,asetpts=PTS-STARTPTS[abase]"
        % (AUDIO_SR, T)
    )
    alabs = ["abase"]
    for j, a in enumerate(norm["audio_clips"]):
        alab = "a%d" % j
        ms = int(round(a["start"] * 1000))
        # 变速保音调：atempo 串联（总因子=speed），插在 asetpts(归零) 之后、aresample 之前；
        # speed==1 返回空串，整段不加 atempo（零回归）。adelay(平移) 仍用 start*1000，不被缩放。
        atempo = atempo_filter_str(a.get("speed", 1.0))
        atempo_part = (atempo + ",") if atempo else ""
        lines.append(
            "[%d:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS,"
            "%s"
            "aresample=%d,aformat=channel_layouts=stereo,"
            "volume=%s,adelay=%d|%d[%s]"
            % (a["streamIdx"], _fmt_num(a["in"]), _fmt_num(a["out"]),
               atempo_part, AUDIO_SR, _fmt_num(a["volume"]), ms, ms, alab)
        )
        alabs.append(alab)

    # 混音（normalize=0 保持单轨音量；末尾 atrim=end=T 双保险）
    inputs = "".join("[%s]" % l for l in alabs)
    lines.append(
        "%samix=inputs=%d:normalize=0:dropout_transition=0,atrim=end=%s,asetpts=PTS-STARTPTS[aout]"
        % (inputs, len(alabs), T)
    )
    return lines, "aout"


def build_filter_script(norm, textfile_paths):
    """组装整张滤镜图脚本字符串（UTF-8）。
    返回 (script_text, vout_label, aout_label_or_None)。
    """
    lines = []

    v_lines, comp_label = _build_video_chains(norm)
    lines.extend(v_lines)

    dt_lines, vout = _build_drawtext_chains(norm, comp_label, textfile_paths)
    lines.extend(dt_lines)

    a_lines, aout = _build_audio_chains(norm)
    lines.extend(a_lines)

    # 每条链以 ';' 结尾并换行（ffmpeg 8.1 允许 ';' 后换行，实测 EXIT 0）
    script_text = ";\n".join(lines) + "\n"
    return script_text, vout, aout


# ---------------------------------------------------------------------------
# 落盘 + 组装 ffmpeg 参数
# ---------------------------------------------------------------------------

def _write_utf8(path, text):
    """UTF-8 无 BOM 写文本。"""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_textfiles(norm, work_dir):
    """把每条 text-clip 的 content 写入独立 UTF-8(无 BOM) 文件。
    返回 [abs_path] 与 norm['text_clips'] 一一对应。
    """
    paths = []
    for i, t in enumerate(norm["text_clips"]):
        p = os.path.join(work_dir, "text_%03d.txt" % i)
        _write_utf8(p, t["content"])   # content 原样写入，不做任何转义
        paths.append(os.path.abspath(p))
    return paths


def find_ffmpeg():
    """返回可用的 ffmpeg 可执行路径（PATH 优先，回退已知 WinGet 安装位置）。"""
    return _find_tool("ffmpeg")


def find_ffprobe():
    return _find_tool("ffprobe")


def _find_tool(name):
    import shutil, sys
    # 同目录/同 exe 目录回退：把 ffmpeg.exe / ffprobe.exe 放在本程序旁边即可（无需改 PATH）。
    # 打包成 exe(frozen) 后优先用随包附带的 ffmpeg —— 放在 Lyra.exe 旁边或 ffmpeg\ 子目录。
    here = os.path.dirname(os.path.abspath(__file__))
    exedir = os.path.dirname(os.path.abspath(sys.executable))
    for d in (exedir, os.path.join(exedir, "ffmpeg"), here):
        p = os.path.join(d, name + ".exe")
        if os.path.isfile(p):
            return p
    exe = shutil.which(name)
    if exe:
        return exe
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
    return name


def build_ffmpeg_command(norm, output_path, work_dir, ffmpeg_exe=None, preset="medium"):
    """生成完整 ffmpeg 参数列表 + 写好滤镜脚本与 textfile。

    返回 dict:
      {
        "args": [...],
        "filter_script": <abs path>,
        "textfiles": [<abs path>...],
        "total_duration": float,        # 进度计算用 T = max(start+dur)
        "vout": "vout", "aout": "aout"|None,
        "output_path": <abs path>,
      }
    要求 work_dir 已存在。
    """
    if ffmpeg_exe is None:
        ffmpeg_exe = find_ffmpeg()

    output = norm["output"]

    # 1) textfiles
    textfile_paths = write_textfiles(norm, work_dir)

    # 2) 滤镜脚本
    script_text, vout, aout = build_filter_script(norm, textfile_paths)
    filter_script = os.path.abspath(os.path.join(work_dir, "filter.txt"))
    _write_utf8(filter_script, script_text)

    # 3) ffmpeg 参数列表
    args = [ffmpeg_exe, "-hide_banner", "-y"]
    for _sid, path in norm["ordered_sources"]:
        args += ["-i", path]
    args += ["-filter_complex_script", filter_script]
    args += ["-map", "[%s]" % vout]
    if aout:
        args += ["-map", "[%s]" % aout]
    args += ["-c:v", "libx264", "-crf", str(output["crf"]),
             "-preset", preset, "-pix_fmt", "yuv420p", "-r", str(output["fps"])]
    if aout:
        args += ["-c:a", "aac", "-b:a", AUDIO_BR]
    args += ["-movflags", "+faststart"]
    args += ["-progress", "pipe:1", "-nostats"]
    args += [os.path.abspath(output_path)]

    return {
        "args": args,
        "filter_script": filter_script,
        "textfiles": textfile_paths,
        "total_duration": norm["total_duration"],
        "vout": vout,
        "aout": aout,
        "output_path": os.path.abspath(output_path),
    }


def build_export(project, output_path, source_path_map, work_dir,
                 ffmpeg_exe=None, media_meta=None, preset="medium"):
    """一站式：校验+规范化 v2 project，写文件，返回 build_ffmpeg_command 的结果。
    校验失败抛 ExportValidationError。
    """
    norm = validate_and_normalize(project, source_path_map, media_meta=media_meta)
    if not os.path.isdir(work_dir):
        os.makedirs(work_dir, exist_ok=True)
    return build_ffmpeg_command(norm, output_path, work_dir,
                                ffmpeg_exe=ffmpeg_exe, preset=preset)


# ---------------------------------------------------------------------------
# 缩略图命令（供 server.py 调用；抽首帧 jpg）
# ---------------------------------------------------------------------------

def build_thumb_command(src_path, out_jpg, duration=None, ffmpeg_exe=None, width=320):
    """抽取代表帧缩略图的 ffmpeg 参数列表。
    -ss 在 -i 前快速定位到 min(duration*0.1, 1s)；scale=width:-2 保比例取偶高。
    """
    if ffmpeg_exe is None:
        ffmpeg_exe = find_ffmpeg()
    try:
        d = float(duration) if duration else 0.0
    except (TypeError, ValueError):
        d = 0.0
    ss = min(d * 0.1, 1.0) if d > 0 else 0.0
    args = [ffmpeg_exe, "-hide_banner", "-v", "error", "-y"]
    if ss > 0:
        args += ["-ss", _fmt_num(ss)]
    args += ["-i", src_path,
             "-frames:v", "1",
             "-vf", "scale=%d:-2:force_original_aspect_ratio=decrease" % width,
             "-q:v", "3",
             os.path.abspath(out_jpg)]
    return args


# ---------------------------------------------------------------------------
# 自测（python ffmpeg_build.py 时打印一个示例滤镜脚本，不实际跑 ffmpeg）
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import json
    import tempfile

    demo_project = {
        "output": {"width": 1920, "height": 1080, "fps": 30, "crf": 18, "keepAudio": True},
        "media": [
            {"id": "med_1", "streamId": "src_1", "path": "F:/视频素材/演示 A.mp4",
             "name": "演示 A.mp4", "width": 1920, "height": 1080,
             "duration": 62.5, "fps": 29.97, "hasAudio": True},
            {"id": "med_2", "streamId": "src_2", "path": "F:/视频素材/补充片段 B.mp4",
             "name": "补充片段 B.mp4", "width": 1280, "height": 720,
             "duration": 18.0, "fps": 30.0, "hasAudio": False},
        ],
        "tracks": [
            {"id": "trk_1", "kind": "video", "name": "视频 1", "muted": False, "volume": 1.0,
             "hidden": False, "locked": False, "clips": [
                {"id": "clip_1", "mediaId": "med_1", "in": 3.0, "out": 12.5, "start": 0.0,
                 "scale": 1.0, "cx": 0.5, "cy": 0.5, "opacity": 1.0},
                {"id": "clip_2", "mediaId": "med_1", "in": 40.0, "out": 47.25, "start": 9.5,
                 "scale": 1.0, "cx": 0.5, "cy": 0.5, "opacity": 1.0},
             ]},
            {"id": "trk_2", "kind": "video", "name": "视频 2", "muted": True, "volume": 0.0,
             "hidden": False, "locked": False, "clips": [
                {"id": "clip_3", "mediaId": "med_2", "in": 0.0, "out": 6.0, "start": 1.0,
                 "scale": 0.35, "cx": 0.78, "cy": 0.25, "opacity": 0.85},
             ]},
            {"id": "trk_3", "kind": "text", "name": "文字 1", "hidden": False, "locked": False,
             "clips": [
                {"id": "txt_1", "content": "第一步：打开“设置”面板，点击右上角的齿轮 ⚙",
                 "start": 0.0, "duration": 9.5, "xPct": 0.08, "yPct": 0.78, "wPct": 0.84,
                 "fontFile": "C:/Windows/Fonts/msyh.ttc", "fontSizePct": 0.06,
                 "color": "#FFFFFF", "opacity": 1.0, "align": "center",
                 "border": True, "borderColor": "#000000", "borderWPct": 0.004,
                 "box": True, "boxColor": "#000000", "boxOpacity": 0.45},
             ]},
        ],
    }
    src_map = {m["streamId"]: m["path"] for m in demo_project["media"]}
    work = os.path.join(tempfile.gettempdir(), "jianjianji_v2_selftest")
    os.makedirs(work, exist_ok=True)
    try:
        result = build_export(demo_project, os.path.join(work, "out.mp4"), src_map, work, preset="ultrafast")
        print("=== filter.txt ===")
        with open(result["filter_script"], encoding="utf-8") as f:
            print(f.read())
        print("=== ffmpeg args ===")
        print(json.dumps(result["args"], ensure_ascii=False, indent=2))
        print("total_duration =", result["total_duration"])
    except ExportValidationError as e:
        print("校验失败:", e)
