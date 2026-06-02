# -*- coding: utf-8 -*-
"""
server.py (v2) — “简单剪辑”多轨非线性编辑器本地后端（纯 Python 标准库，零安装）。

实现 _build/contract_v2.md §2 的全部 HTTP API：
  GET  /                              -> static/index.html
  GET  /static/<file>                 -> 静态资源（正确 mimetype，禁止路径穿越）
  GET  /api/stream?id=<streamId>      -> HTTP Range 流式回放（206/Accept-Ranges/Content-Range）
  POST /api/pick                      -> 系统对话框选 mp4（零拷贝原路径），入库，返回 {media:[...]}
  POST /api/pick-save                 -> 另存为对话框，返回 {path:...}
  GET  /api/fonts                     -> {fonts:[{name,path}...]}（仅列存在者）
  POST /api/upload      【新增】       -> 拖拽上传：流式保存到工作目录→ffprobe→缩略图→返回 media
  GET  /api/thumb?id=<mediaId> 【新增】 -> 该 media 的缩略图 jpg（按需生成+缓存）
  POST /api/export                    -> 后台线程跑 ffmpeg 多轨合成，立即返回 {jobId}
  GET  /api/export/status?id=<jobId>  -> {state,progress,outputPath,error,log}

约定（沿用 v1 已实测可靠结论）：
  - 监听 127.0.0.1，端口默认 8765，被占用自动 +1 找空闲。
  - 所有 JSON UTF-8（ensure_ascii=False）。所有文本读写 UTF-8（无 BOM）。
  - subprocess 调 ffmpeg/ffprobe/picker 一律用 list 参数（含中文/空格路径安全）+ CREATE_NO_WINDOW 防黑框。
  - 维护 streamId -> 绝对路径 映射，供 /api/stream；mediaId -> media 元数据，供 /api/thumb 与导出。
  - 启动后自动 webbrowser.open 打开首页。

v2 媒体库模型：每个导入文件分配 mediaId("med_N") + streamId("src_N")。
  - /api/pick：零拷贝，path 为原始绝对路径。
  - /api/upload：流式复制到工作目录 uploads，path 为副本绝对路径。
  两者都 ffprobe + 预生成缩略图，返回 media 对象（含 thumbUrl=/api/thumb?id=med_N）。
"""

import os
import sys
import json
import time
import random
import shutil
import tempfile
import threading
import subprocess
import webbrowser
import mimetypes
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 让本目录可被 import（双击启动时 cwd 可能不同）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import ffmpeg_build  # noqa: E402

STATIC_DIR = os.path.join(BASE_DIR, "static")
PICKER_PY = os.path.join(BASE_DIR, "picker.py")
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
STREAM_CHUNK = 64 * 1024  # 64KB/块

# 工作目录（导出临时文件 / 缩略图缓存）
WORK_ROOT = os.path.join(tempfile.gettempdir(), "jianjianji_work")
UPLOAD_DIR = os.path.join(WORK_ROOT, "uploads")  # 历史目录（保留，不再写入）
THUMB_DIR = os.path.join(WORK_ROOT, "thumbs")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

# 工程库 / 持久素材库（app 目录下，便携；见 project_design.md §1.1）
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")           # 工程库：projects/<id>/project.json
MEDIA_STORE_DIR = os.path.join(BASE_DIR, "media_store")     # 持久素材库：/api/upload 副本落点
MEDIA_THUMB_DIR = os.path.join(MEDIA_STORE_DIR, "thumbs")   # 可选缩略图缓存（预留）
os.makedirs(PROJECTS_DIR, exist_ok=True)
os.makedirs(MEDIA_STORE_DIR, exist_ok=True)
os.makedirs(MEDIA_THUMB_DIR, exist_ok=True)

# 工程文件 schema 版本（project.json）
PROJECT_SCHEMA = 1
# 探测时长差异阈值（秒）：超过则判定 changed
_DUR_EPS = 0.05

# 候选 CJK 字体（仅列存在者；见 contract_v2.md §8）
FONT_CANDIDATES = [
    ("微软雅黑", "msyh.ttc"),
    ("微软雅黑 Bold", "msyhbd.ttc"),
    ("黑体", "simhei.ttf"),
    ("宋体", "simsun.ttc"),
    ("楷体", "simkai.ttf"),
    ("仿宋", "simfang.ttf"),
    ("等线", "Deng.ttf"),
]

# 接受的上传容器扩展名（ffprobe 仍会做实质校验）
ACCEPT_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}

# 单个上传上限（防御，4GB）
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

# ---------------------------------------------------------------------------
# 全局状态（带锁）
# ---------------------------------------------------------------------------
_state_lock = threading.Lock()
_streams = {}            # streamId -> 绝对路径
_media = {}              # mediaId  -> media 元数据 dict（含 streamId/path/width/...）
_media_seq = 0           # media id 递增计数
_source_seq = 0          # stream id 递增计数
_jobs = {}               # jobId -> job dict
_job_seq = 0             # job id 递增计数

FFMPEG = ffmpeg_build.find_ffmpeg()
FFPROBE = ffmpeg_build.find_ffprobe()

# Windows 下用 CREATE_NO_WINDOW 防止子进程弹黑框
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _next_stream_id():
    global _source_seq
    with _state_lock:
        _source_seq += 1
        return "src_%d" % _source_seq


def _next_media_id():
    global _media_seq
    with _state_lock:
        _media_seq += 1
        return "med_%d" % _media_seq


def _next_job_id():
    global _job_seq
    with _state_lock:
        _job_seq += 1
        return "job_%d" % _job_seq


def register_stream(path):
    """登记一个源文件，返回 streamId（供 /api/stream）。"""
    sid = _next_stream_id()
    with _state_lock:
        _streams[sid] = os.path.abspath(path)
    return sid


def get_stream_path(sid):
    with _state_lock:
        return _streams.get(sid)


def register_media(probe_info, imported, original_name=None):
    """根据 ffprobe 结果登记一条 media（含 streamId），返回 media 对象（已含 thumbUrl）。"""
    path = probe_info["path"]
    stream_id = register_stream(path)
    media_id = _next_media_id()
    name = original_name or os.path.basename(path)
    media = {
        "id": media_id,
        "streamId": stream_id,
        "path": path.replace("\\", "/"),
        "name": name,
        "width": probe_info["width"],
        "height": probe_info["height"],
        "duration": probe_info["duration"],
        "fps": probe_info["fps"],
        "hasAudio": probe_info["hasAudio"],
        "thumbUrl": "/api/thumb?id=%s" % media_id,
        "imported": imported,
    }
    with _state_lock:
        _media[media_id] = media
    return media


def get_media(media_id):
    with _state_lock:
        return _media.get(media_id)


def snapshot_streams():
    with _state_lock:
        return dict(_streams)


def snapshot_media_meta():
    """mediaId -> {streamId,width,height,duration,fps,hasAudio}（后端权威元数据，供导出覆盖前端回传）。"""
    with _state_lock:
        out = {}
        for mid, m in _media.items():
            out[mid] = {
                "streamId": m["streamId"],
                "width": m["width"], "height": m["height"],
                "duration": m["duration"], "fps": m["fps"],
                "hasAudio": m["hasAudio"],
            }
        return out


# ---------------------------------------------------------------------------
# ffprobe：解析源信息
# ---------------------------------------------------------------------------
def probe_source(path):
    """对一个视频文件跑 ffprobe，返回 {path,width,height,duration,fps,hasAudio}。失败返回 None。"""
    args = [FFPROBE, "-hide_banner", "-v", "error",
            "-print_format", "json", "-show_format", "-show_streams", path]
    try:
        proc = subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception as e:
        print("[ffprobe] 启动失败:", e)
        return None
    if proc.returncode != 0:
        print("[ffprobe] 退出码", proc.returncode, ":", proc.stderr.decode("utf-8", "replace")[:300])
        return None
    try:
        info = json.loads(proc.stdout.decode("utf-8", "replace"))
    except Exception as e:
        print("[ffprobe] JSON 解析失败:", e)
        return None

    streams = info.get("streams", [])
    fmt = info.get("format", {})

    vstream = None
    has_audio = False
    for s in streams:
        ct = s.get("codec_type")
        if ct == "video" and vstream is None:
            if s.get("disposition", {}).get("attached_pic") == 1:
                continue  # 跳过封面图
            vstream = s
        elif ct == "audio":
            has_audio = True
    if vstream is None:
        for s in streams:
            if s.get("codec_type") == "video":
                vstream = s
                break
    if vstream is None:
        return None

    width = int(vstream.get("width") or 0)
    height = int(vstream.get("height") or 0)
    if width <= 0 or height <= 0:
        return None

    duration = None
    for cand in (fmt.get("duration"), vstream.get("duration")):
        if cand not in (None, "", "N/A"):
            try:
                duration = float(cand)
                break
            except (TypeError, ValueError):
                pass
    if not duration or duration <= 0:
        duration = 0.0

    fps = _parse_fps(vstream.get("avg_frame_rate")) or _parse_fps(vstream.get("r_frame_rate")) or 30.0

    return {
        "path": os.path.abspath(path),
        "width": width,
        "height": height,
        "duration": round(duration, 6),
        "fps": round(fps, 6),
        "hasAudio": has_audio,
    }


def _parse_fps(val):
    if not val or val in ("0/0", "N/A"):
        return None
    try:
        if "/" in val:
            num, den = val.split("/", 1)
            num = float(num); den = float(den)
            if den == 0:
                return None
            return num / den
        return float(val)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 缩略图：抽首帧 jpg 缓存到 THUMB_DIR/<mediaId>.jpg
# ---------------------------------------------------------------------------
def _thumb_cache_path(media_id):
    return os.path.join(THUMB_DIR, "%s.jpg" % media_id)


def generate_thumb(media):
    """为 media 生成缩略图（若已缓存则跳过）。返回缓存 jpg 绝对路径，失败返回 None。"""
    media_id = media["id"]
    out_jpg = _thumb_cache_path(media_id)
    if os.path.isfile(out_jpg) and os.path.getsize(out_jpg) > 0:
        return out_jpg
    src = get_stream_path(media["streamId"]) or media["path"]
    args = ffmpeg_build.build_thumb_command(
        src, out_jpg, duration=media.get("duration"), ffmpeg_exe=FFMPEG)
    try:
        proc = subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception as e:
        print("[thumb] 启动失败:", e)
        return None
    if proc.returncode != 0 or not os.path.isfile(out_jpg):
        print("[thumb] 生成失败:", proc.stderr.decode("utf-8", "replace")[:200])
        return None
    return out_jpg


# 1x1 灰底 jpg 占位（生成失败时返回，避免 <img> 破图）。预编码常量。
_PLACEHOLDER_JPG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707"
    "07090908"
    "0a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c283729"
    "2c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc40014"
    "00010000000000000000000000000000000000ffc4001410010000000000000000000"
    "00000000000000000ffda0008010100003f0037ffd9"
)


# ---------------------------------------------------------------------------
# picker.py 子进程调用
# ---------------------------------------------------------------------------
def run_picker(mode, suggest_name=None):
    """调用 picker.py（独立子进程），返回其解析后的 dict。失败返回 {}。"""
    args = [sys.executable, PICKER_PY, mode]
    if mode == "save":
        args.append(suggest_name or "导出视频.mp4")
    try:
        proc = subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception as e:
        print("[picker] 启动失败:", e)
        return {}
    out = proc.stdout.decode("utf-8", "replace").strip()
    if not out:
        err = proc.stderr.decode("utf-8", "replace").strip()
        if err:
            print("[picker] stderr:", err[:300])
        return {}
    try:
        return json.loads(out)
    except Exception as e:
        print("[picker] JSON 解析失败:", e, "raw:", out[:200])
        return {}


# ---------------------------------------------------------------------------
# 上传文件流式保存（去重命名）
# ---------------------------------------------------------------------------
def _dedup_path(directory, filename):
    """在 directory 内为 filename 取一个不冲突的绝对路径（冲突加 _1/_2...）。"""
    base, ext = os.path.splitext(filename)
    if not ext:
        ext = ".mp4"
    candidate = os.path.join(directory, base + ext)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, "%s_%d%s" % (base, i, ext))
        i += 1
    return candidate


def _safe_basename(name):
    """从用户提供的文件名取安全 basename（去路径分隔符与非法字符）。"""
    name = os.path.basename(str(name or "").replace("\\", "/"))
    bad = '<>:"/\\|?*'
    name = "".join(("_" if ch in bad else ch) for ch in name)
    name = name.strip().strip(".")
    return name or "上传视频.mp4"


# ---------------------------------------------------------------------------
# 导出任务（后台线程跑 ffmpeg + 解析进度）
# ---------------------------------------------------------------------------
def _filter_offline_clips(project, source_path_map):
    """导出前剔除引用了离线/缺源素材的视频片段（见 project_design.md §2.8）。
    判定缺源：media.streamId 不在 source_path_map，或其路径不存在。
    返回 (filtered_project, warnings)。不修改入参（浅拷贝 tracks/clips）。
    全空交由后续 ExportValidationError 拦截，本函数不抛。"""
    if not isinstance(project, dict):
        return project, []

    media_by_id = {}
    for m in (project.get("media") or []):
        if isinstance(m, dict) and m.get("id") is not None:
            media_by_id[m["id"]] = m

    def _is_offline(media):
        if not isinstance(media, dict):
            return True
        if media.get("offline") is True:
            return True
        sid = media.get("streamId")
        if not sid or sid not in source_path_map:
            return True
        p = source_path_map.get(sid)
        return not (p and os.path.isfile(p))

    warnings = []
    skipped_names = set()
    new_tracks = []
    changed = False
    for tr in (project.get("tracks") or []):
        if not isinstance(tr, dict) or tr.get("kind") != "video":
            new_tracks.append(tr)
            continue
        kept = []
        for c in (tr.get("clips") or []):
            if not isinstance(c, dict):
                kept.append(c)
                continue
            media = media_by_id.get(c.get("mediaId"))
            if _is_offline(media):
                changed = True
                nm = (media or {}).get("name") or c.get("mediaId") or "未知素材"
                skipped_names.add(str(nm))
                continue
            kept.append(c)
        ntr = dict(tr)
        ntr["clips"] = kept
        new_tracks.append(ntr)

    if not changed:
        return project, []

    if skipped_names:
        warnings.append("已跳过 %d 个离线素材的相关片段：%s。"
                        % (len(skipped_names), "、".join(sorted(skipped_names))))
    filtered = dict(project)
    filtered["tracks"] = new_tracks
    return filtered, warnings


def start_export_job(project, output_path):
    """构建 ffmpeg 命令并启动后台线程。返回 jobId。
    构建/校验失败抛 ffmpeg_build.ExportValidationError（同步 400）。
    含离线素材时：剔除其相关片段并记 warning（§2.8）；全空仍由校验拦截。
    """
    job_id = _next_job_id()
    work_dir = os.path.join(WORK_ROOT, job_id)
    os.makedirs(work_dir, exist_ok=True)

    source_path_map = snapshot_streams()
    media_meta = snapshot_media_meta()

    project, skip_warnings = _filter_offline_clips(project, source_path_map)

    built = ffmpeg_build.build_export(
        project, output_path, source_path_map, work_dir,
        ffmpeg_exe=FFMPEG, media_meta=media_meta, preset="medium",
    )

    job = {
        "id": job_id,
        "state": "running",
        "progress": 0.0,
        "outputPath": built["output_path"],
        "error": None,
        "log": [],
        "warnings": skip_warnings,
        "total_duration": built["total_duration"],
        "args": built["args"],
        "work_dir": work_dir,
        "proc": None,
    }
    with _state_lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_ffmpeg_thread, args=(job,), daemon=True)
    t.start()
    return job_id


def _run_ffmpeg_thread(job):
    args = job["args"]
    total = job["total_duration"] or 0.0
    log_lines = []
    log_lock = threading.Lock()

    def push_log(line):
        with log_lock:
            log_lines.append(line)
            if len(log_lines) > 60:
                del log_lines[: len(log_lines) - 60]
            job["log"] = list(log_lines[-40:])

    print("[export] %s 启动 ffmpeg:" % job["id"])
    print("         ", " ".join('"%s"' % a if (" " in a) else a for a in args))

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception as e:
        job["state"] = "error"
        job["error"] = "无法启动 ffmpeg：%s" % e
        push_log(str(e))
        return

    job["proc"] = proc

    def read_stderr():
        try:
            for raw in iter(proc.stderr.readline, b""):
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line:
                    push_log(line)
        except Exception:
            pass

    err_thread = threading.Thread(target=read_stderr, daemon=True)
    err_thread.start()

    # stdout 读进度（-progress pipe:1）。totalDuration = max(start+dur)（多轨）。
    try:
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                _key, _, val = line.partition("=")
                if val not in ("N/A", ""):
                    try:
                        us = int(val)
                        secs = us / 1e6
                        if total > 0:
                            p = secs / total
                            job["progress"] = min(max(p, 0.0), 1.0)
                    except ValueError:
                        pass
            elif line == "progress=end":
                job["progress"] = 1.0
    except Exception as e:
        push_log("读取进度异常: %s" % e)

    proc.wait()
    err_thread.join(timeout=2.0)

    if proc.returncode == 0:
        job["state"] = "done"
        job["progress"] = 1.0
        job["error"] = None
        print("[export] %s 完成 -> %s" % (job["id"], job["outputPath"]))
    else:
        job["state"] = "error"
        tail = "\n".join(job.get("log") or [])
        job["error"] = "ffmpeg 退出码 %d。%s" % (proc.returncode, _guess_error_hint(tail))
        job["progress"] = job.get("progress", 0.0)
        print("[export] %s 失败 退出码=%d" % (job["id"], proc.returncode))


def _guess_error_hint(tail):
    """从 ffmpeg stderr 尾部给一句中文提示，否则回显末行。"""
    low = tail.lower()
    if "no such file or directory" in low and "font" in low:
        return "可能是字体文件路径无效。"
    if "permission denied" in low:
        return "输出目录不可写或文件被占用。"
    if "invalid argument" in low or "error initializing filters" in low:
        return "滤镜参数有误（请检查片段/文字/路径设置）。"
    for ln in reversed(tail.splitlines()):
        if ln.strip():
            return ln.strip()[:200]
    return ""


# ---------------------------------------------------------------------------
# 字体列表
# ---------------------------------------------------------------------------
def list_fonts():
    fonts_dir = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
    result = []
    for name, fn in FONT_CANDIDATES:
        p = os.path.join(fonts_dir, fn)
        if os.path.isfile(p):
            result.append({"name": name, "path": p.replace("\\", "/")})
    return result


# ---------------------------------------------------------------------------
# 工程（项目）系统：存储布局 / project.json 读写 / 加载探测
# 见 project_design.md §1（布局/schema）、§2（HTTP API 契约）。
# ---------------------------------------------------------------------------
_PROJECT_ID_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def _safe_project_id(pid):
    """校验 projectId 只含 [A-Za-z0-9_-]，拒绝穿越/分隔符/空。非法返回 None。"""
    if not pid or not isinstance(pid, str):
        return None
    if ".." in pid or "/" in pid or "\\" in pid or os.sep in pid:
        return None
    for ch in pid:
        if ch not in _PROJECT_ID_OK:
            return None
    return pid


def _new_project_id():
    """生成文件系统安全的唯一 projectId：p_<毫秒时间戳>_<4位随机>，确保目录不存在。"""
    for _ in range(50):
        rnd = "".join(random.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(4))
        pid = "p_%d_%s" % (int(time.time() * 1000), rnd)
        if not os.path.exists(os.path.join(PROJECTS_DIR, pid)):
            return pid
    # 极端回退：用计数避免无限冲突
    i = 1
    while os.path.exists(os.path.join(PROJECTS_DIR, "p_%d" % i)):
        i += 1
    return "p_%d" % i


def _project_dir(pid):
    return os.path.join(PROJECTS_DIR, pid)


def _project_path(pid):
    return os.path.join(PROJECTS_DIR, pid, "project.json")


def _now_ms():
    return int(time.time() * 1000)


def _read_project_json(pid):
    """读取并解析 projects/<pid>/project.json。失败返回 None（容错，不抛）。"""
    p = _project_path(pid)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if isinstance(obj, dict):
            return obj
    except Exception as e:
        print("[projects] 读取损坏，跳过 %s: %s" % (pid, e))
    return None


def _write_project_json(pid, obj):
    """原子写 projects/<pid>/project.json（先写 .tmp 再 os.replace）。"""
    d = _project_dir(pid)
    os.makedirs(d, exist_ok=True)
    final = _project_path(pid)
    tmp = final + ".tmp"
    body = json.dumps(obj, ensure_ascii=False, indent=2)
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    os.replace(tmp, final)


def _project_meta_from_obj(pid, obj):
    """从 project.json 对象抽取列表用元信息（容错缺字段）。"""
    name = obj.get("name")
    if not name or not str(name).strip():
        name = "未命名工程"
    try:
        created = int(obj.get("createdAt") or 0)
    except (TypeError, ValueError):
        created = 0
    try:
        modified = int(obj.get("modifiedAt") or created or 0)
    except (TypeError, ValueError):
        modified = created
    return {"id": pid, "name": str(name), "createdAt": created, "modifiedAt": modified}


def list_projects():
    """扫描 projects/*/project.json，返回按 modifiedAt 倒序的元信息列表（容错跳过损坏）。"""
    out = []
    try:
        entries = os.listdir(PROJECTS_DIR)
    except OSError:
        entries = []
    for name in entries:
        pid = _safe_project_id(name)
        if not pid:
            continue
        if not os.path.isfile(_project_path(pid)):
            continue
        obj = _read_project_json(pid)
        if obj is None:
            print("[projects] 跳过无法解析的工程: %s" % name)
            continue
        out.append(_project_meta_from_obj(pid, obj))
    out.sort(key=lambda m: m["modifiedAt"], reverse=True)
    return out


def _sanitize_media_for_save(media):
    """保存时清洗一条 media：剥离 transient（streamId/thumbUrl/offline），path 正斜杠。"""
    if not isinstance(media, dict):
        return {}
    keep = ("id", "path", "name", "width", "height",
            "duration", "fps", "hasAudio", "imported")
    out = {}
    for k in keep:
        if k in media:
            out[k] = media[k]
    if "path" in out and isinstance(out["path"], str):
        out["path"] = out["path"].replace("\\", "/")
    return out


def save_project(pid, name, project):
    """新建/覆盖工程。pid 为 None/空 → 新建生成 id；存在则覆盖（保留 createdAt）。
    返回 {id, name, modifiedAt}。"""
    name = (str(name).strip() if name is not None else "") or "未命名工程"

    created = None
    pid = _safe_project_id(pid) if pid else None
    if pid:
        existing = _read_project_json(pid)
        if existing is not None:
            try:
                created = int(existing.get("createdAt") or 0) or None
            except (TypeError, ValueError):
                created = None
        else:
            # 传了 id 但目录不存在/损坏 → 当作新建到该 id
            pass
    if not pid:
        pid = _new_project_id()

    now = _now_ms()
    if created is None:
        created = now

    proj = project if isinstance(project, dict) else {}
    out_media = [_sanitize_media_for_save(m) for m in (proj.get("media") or [])]
    obj = {
        "schema": PROJECT_SCHEMA,
        "id": pid,
        "name": name,
        "createdAt": created,
        "modifiedAt": now,
        "project": {
            "output": proj.get("output") or {},
            "media": out_media,
            "tracks": proj.get("tracks") or [],
        },
    }
    _write_project_json(pid, obj)
    return {"id": pid, "name": name, "modifiedAt": now}


def delete_project(pid):
    """删除 projects/<pid>/ 整目录（media_store 副本不删）。返回 True/False。"""
    pid = _safe_project_id(pid)
    if not pid:
        return False
    d = _project_dir(pid)
    if not os.path.isdir(d):
        return False
    shutil.rmtree(d, ignore_errors=True)
    return not os.path.isdir(d)


def rename_project(pid, name):
    """只改 project.json 的 name + modifiedAt，不动目录。返回 modifiedAt 或 None。"""
    pid = _safe_project_id(pid)
    if not pid:
        return None
    obj = _read_project_json(pid)
    if obj is None:
        return None
    name = (str(name).strip() if name is not None else "") or "未命名工程"
    now = _now_ms()
    obj["name"] = name
    obj["modifiedAt"] = now
    # 确保元字段齐全
    obj.setdefault("schema", PROJECT_SCHEMA)
    obj.setdefault("id", pid)
    obj.setdefault("createdAt", now)
    _write_project_json(pid, obj)
    return now


def _probe_and_register(path):
    """对 path 探测 + 登记 streamId。成功返回 (streamId, probe_info)；失败 (None, None)。"""
    if not path or not os.path.isfile(path):
        return None, None
    info = probe_source(path)
    if info is None:
        return None, None
    sid = register_stream(path)
    return sid, info


def register_loaded_media(m):
    """把加载工程时已在线的一条 media 注册进全局 _media，使 /api/thumb?id=<mediaId>
    能按 mediaId 找到源并生成缩略图（与 /api/pick、/api/upload 的 register_media 行为一致）。
    m 需已含 id/streamId/path/duration 等 generate_thumb 所需字段。无 id 则跳过。"""
    mid = m.get("id")
    if not mid:
        return
    with _state_lock:
        _media[mid] = dict(m)


def load_project(pid):
    """加载工程：读 json → 对每个 media 重探测+重登记 streamId → 拼 mediaStatus/warnings。
    离线不阻塞。返回 dict（见契约 §2.3）；工程不存在返回 None。"""
    pid = _safe_project_id(pid)
    if not pid:
        return None
    obj = _read_project_json(pid)
    if obj is None:
        return None

    warnings = []
    try:
        schema = int(obj.get("schema") or 0)
    except (TypeError, ValueError):
        schema = 0
    if schema != PROJECT_SCHEMA:
        warnings.append("工程文件版本与当前不一致（schema=%s），已尽量兼容加载。" % obj.get("schema"))

    proj = obj.get("project") or {}
    media_list = proj.get("media") or []
    media_status = []
    offline_names = []

    for m in media_list:
        if not isinstance(m, dict):
            continue
        mid = m.get("id")
        name = m.get("name") or (os.path.basename(m.get("path") or "") or "素材")
        path = m.get("path") or ""
        # 旧保存值（用于离线回填 / changed 比较）
        try:
            saved_dur = float(m.get("duration")) if m.get("duration") not in (None, "", "N/A") else None
        except (TypeError, ValueError):
            saved_dur = None
        saved_w = m.get("width")
        saved_h = m.get("height")

        sid, info = _probe_and_register(path)
        if info is not None:
            # 在线：就地更新 media 的 streamId/dims/duration/fps/hasAudio
            m["streamId"] = sid
            m["width"] = info["width"]
            m["height"] = info["height"]
            m["duration"] = info["duration"]
            m["fps"] = info["fps"]
            m["hasAudio"] = info["hasAudio"]
            m["path"] = info["path"].replace("\\", "/")
            if "thumbUrl" not in m and mid:
                m["thumbUrl"] = "/api/thumb?id=%s" % mid
            # 注册进全局 _media，使 /api/thumb?id=<mediaId> 能按 mediaId 取源生成缩略图
            # （否则 get_media 返回 None → 404 → 占位图，素材库/时间轴缩略图全退化为灰底）
            register_loaded_media(m)
            # changed 判定：时长差异或分辨率变化
            changed = False
            if saved_dur is not None and abs(info["duration"] - saved_dur) > _DUR_EPS:
                changed = True
            if (saved_w not in (None,) and int(saved_w or 0) != info["width"]) or \
               (saved_h not in (None,) and int(saved_h or 0) != info["height"]):
                changed = True
            if changed and saved_dur is not None:
                warnings.append(
                    "素材“%s”的时长已变化（%.2fs → %.2fs），相关片段已自动修正。"
                    % (name, saved_dur, info["duration"]))
            elif changed:
                warnings.append("素材“%s”的属性已变化，相关片段已自动修正。" % name)
            media_status.append({
                "mediaId": mid,
                "online": True,
                "streamId": sid,
                "path": m["path"],
                "width": info["width"], "height": info["height"],
                "duration": info["duration"], "fps": info["fps"],
                "hasAudio": info["hasAudio"],
                "changed": changed,
            })
        else:
            # 离线：保留保存值，streamId=null
            m["streamId"] = None
            if "thumbUrl" not in m and mid:
                m["thumbUrl"] = "/api/thumb?id=%s" % mid
            offline_names.append(name)
            media_status.append({
                "mediaId": mid,
                "online": False,
                "streamId": None,
                "path": (path or "").replace("\\", "/"),
                "width": saved_w, "height": saved_h,
                "duration": saved_dur, "fps": m.get("fps"),
                "hasAudio": m.get("hasAudio"),
                "changed": False,
                "error": "文件不存在或无法解析",
            })

    if offline_names:
        warnings.append("%d 个素材离线：%s。" % (len(offline_names), "、".join(offline_names)))

    return {
        "id": obj.get("id") or pid,
        "name": obj.get("name") or "未命名工程",
        "project": {
            "output": proj.get("output") or {},
            "media": media_list,
            "tracks": proj.get("tracks") or [],
        },
        "mediaStatus": media_status,
        "warnings": warnings,
    }


def relink_media(media_id, path):
    """对 path 重探测+重登记，作为某离线素材的新源。
    成功返回 {online:True, streamId, width,...}；失败 {online:False, error}。
    注：进程级映射，不落盘（落盘靠用户后续 save）。media_id 仅用于错误文案。"""
    name = os.path.basename(str(path or "")) or "素材"
    sid, info = _probe_and_register(path)
    if info is None:
        return {"online": False, "error": "无法解析视频文件：%s" % name}
    # 注册进全局 _media（同一 mediaId，新源），使重新链接后该素材的 /api/thumb 立即可用
    if media_id:
        register_loaded_media({
            "id": media_id,
            "streamId": sid,
            "path": info["path"].replace("\\", "/"),
            "width": info["width"],
            "height": info["height"],
            "duration": info["duration"],
            "fps": info["fps"],
            "hasAudio": info["hasAudio"],
        })
    return {
        "online": True,
        "streamId": sid,
        "width": info["width"],
        "height": info["height"],
        "duration": info["duration"],
        "fps": info["fps"],
        "hasAudio": info["hasAudio"],
    }


# ---------------------------------------------------------------------------
# multipart/form-data 解析（极简，仅取首个 file 字段；纯标准库）
# ---------------------------------------------------------------------------
def _parse_multipart(rfile, content_type, content_length):
    """流式解析 multipart/form-data，返回 (filename, file_bytes, fields_dict)。
    仅支持取第一个文件型字段（name 形如 file）。其余文本字段进 fields。
    失败返回 (None, None, {})。
    """
    # 取 boundary
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("boundary="):
            boundary = part[len("boundary="):].strip().strip('"')
    if not boundary:
        return None, None, {}

    data = rfile.read(content_length)
    delim = ("--" + boundary).encode("utf-8")
    segments = data.split(delim)

    filename = None
    file_bytes = None
    fields = {}
    for seg in segments:
        if not seg or seg in (b"--\r\n", b"--", b"\r\n"):
            continue
        if seg.startswith(b"\r\n"):
            seg = seg[2:]
        if seg.endswith(b"\r\n"):
            seg = seg[:-2]
        head_end = seg.find(b"\r\n\r\n")
        if head_end < 0:
            continue
        header_blob = seg[:head_end].decode("utf-8", "replace")
        body = seg[head_end + 4:]

        disp_name = None
        disp_filename = None
        for hline in header_blob.split("\r\n"):
            if hline.lower().startswith("content-disposition:"):
                for piece in hline.split(";"):
                    piece = piece.strip()
                    if piece.startswith("name="):
                        disp_name = piece[len("name="):].strip().strip('"')
                    elif piece.startswith("filename="):
                        disp_filename = piece[len("filename="):].strip().strip('"')
        if disp_filename is not None:
            if file_bytes is None:
                filename = _decode_header_word(disp_filename)
                file_bytes = body
        elif disp_name is not None:
            fields[disp_name] = body.decode("utf-8", "replace")

    return filename, file_bytes, fields


def _decode_header_word(s):
    """解码 multipart 头里的文件名：浏览器按 WHATWG 直接发 UTF-8 原文；
    某些 HTTP 客户端（如 .NET HttpClient）会按 RFC 2047 编码为 =?utf-8?B?...?=。
    两种都正确还原。"""
    if not s:
        return s
    if "=?" in s and "?=" in s:
        try:
            from email.header import decode_header
            parts = decode_header(s)
            out = []
            for txt, enc in parts:
                if isinstance(txt, bytes):
                    out.append(txt.decode(enc or "utf-8", "replace"))
                else:
                    out.append(txt)
            return "".join(out)
        except Exception:
            return s
    return s


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "JianJianJi/2.0"
    protocol_version = "HTTP/1.1"  # 支持持久连接 + Range

    # ---- 通用响应工具 ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_error_json(self, status, message):
        self._send_json({"error": message}, status=status)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            # 请求体非合法 UTF-8（编码错误或 keep-alive 体长错位）→ 当作非法 JSON，
            # 由 do_POST 统一返回 400，而非未捕获的 500 traceback。
            raise json.JSONDecodeError("请求体不是合法 UTF-8", "", 0)
        return json.loads(text)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/api/stream" not in msg and "/api/thumb" not in msg:
            sys.stderr.write("  %s - %s\n" % (self.address_string(), msg))

    def handle_one_request(self):
        """包一层：客户端中途断开连接（浏览器 seek/关闭页/keep-alive 复用）属正常，
        静默吞掉 ConnectionResetError，避免 socketserver 打印一长串无意义 traceback。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    # ---- 路由 ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/" or path == "/index.html":
                self._serve_static_file(os.path.join(STATIC_DIR, "index.html"))
            elif path.startswith("/static/"):
                self._serve_static(path)
            elif path == "/api/stream":
                self._handle_stream(qs)
            elif path == "/api/thumb":
                self._handle_thumb(qs)
            elif path == "/api/export/status":
                self._handle_export_status(qs)
            elif path == "/api/projects":
                self._handle_projects_list()
            elif path == "/api/projects/load":
                self._handle_projects_load(qs)
            elif path == "/api/fonts":
                self._send_json({"fonts": list_fonts()})
            elif path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
            else:
                self._send_error_json(404, "未找到: %s" % path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._safe_500(e)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        try:
            if path == "/api/pick":
                self._handle_pick()
            elif path == "/api/pick-save":
                self._handle_pick_save()
            elif path == "/api/upload":
                self._handle_upload()
            elif path == "/api/export":
                self._handle_export()
            elif path == "/api/projects/save":
                self._handle_projects_save()
            elif path == "/api/projects/delete":
                self._handle_projects_delete()
            elif path == "/api/projects/rename":
                self._handle_projects_rename()
            elif path == "/api/relink":
                self._handle_relink()
            else:
                self._send_error_json(404, "未找到: %s" % path)
        except json.JSONDecodeError:
            self._send_error_json(400, "请求体不是合法 JSON")
        except ffmpeg_build.ExportValidationError as e:
            self._send_error_json(400, str(e))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._safe_500(e)

    def _safe_500(self, e):
        import traceback
        traceback.print_exc()
        try:
            self._send_error_json(500, "服务器内部错误: %s" % e)
        except Exception:
            pass

    # ---- 静态文件 ----
    def _serve_static(self, path):
        rel = path[len("/static/"):]
        if not rel or ".." in rel.split("/") or rel.startswith("/") or ":" in rel:
            self._send_error_json(404, "非法路径")
            return
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if os.path.commonpath([os.path.abspath(full), STATIC_DIR]) != STATIC_DIR:
            self._send_error_json(404, "非法路径")
            return
        self._serve_static_file(full)

    def _serve_static_file(self, full):
        if not os.path.isfile(full):
            self._send_error_json(404, "文件不存在")
            return
        ctype, _ = mimetypes.guess_type(full)
        if ctype is None:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        if full.lower().endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif full.lower().endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full.lower().endswith(".html"):
            ctype = "text/html; charset=utf-8"

        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- /api/pick（系统对话框，零拷贝原路径，入库）----
    def _handle_pick(self):
        body = self._read_json_body()
        multiple = bool(body.get("multiple", True))
        mode = "open-multiple" if multiple else "open"
        picked = run_picker(mode)
        paths = picked.get("paths") or []

        media_list = []
        skipped = []
        for p in paths:
            if not os.path.isfile(p):
                skipped.append(p)
                continue
            info = probe_source(p)
            if info is None:
                skipped.append(p)
                continue
            media = register_media(info, imported="pick")
            generate_thumb(media)  # 预生成缩略图
            media_list.append(media)

        resp = {"media": media_list}
        if skipped:
            resp["error"] = "以下文件无法解析，已跳过：" + "; ".join(os.path.basename(s) for s in skipped)
        self._send_json(resp)

    # ---- /api/pick-save（另存为）----
    def _handle_pick_save(self):
        body = self._read_json_body()
        suggest = body.get("suggestName") or "导出视频.mp4"
        picked = run_picker("save", suggest_name=suggest)
        path = picked.get("path")
        if path:
            path = os.path.abspath(path).replace("\\", "/")
        self._send_json({"path": path})

    # ---- /api/upload（拖拽上传，流式复制到工作目录，入库）----
    def _handle_upload(self):
        ctype = self.headers.get("Content-Type") or ""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send_error_json(400, "上传内容为空")
            return
        if length > MAX_UPLOAD_BYTES:
            self._send_error_json(400, "上传文件过大")
            return

        if "multipart/form-data" not in ctype.lower():
            self._send_error_json(400, "上传需 multipart/form-data")
            return

        try:
            filename, file_bytes, fields = _parse_multipart(self.rfile, ctype, length)
        except Exception as e:
            self._send_error_json(500, "保存上传文件失败：%s" % e)
            return

        if file_bytes is None:
            self._send_error_json(400, "未找到上传文件字段 file")
            return

        # 优先用 fields['name']，否则 multipart filename
        raw_name = fields.get("name") or filename or "上传视频.mp4"
        name = _safe_basename(raw_name)
        ext = os.path.splitext(name)[1].lower()
        if ext and ext not in ACCEPT_EXTS:
            # 扩展名不在白名单也允许（ffprobe 再判），但补 .mp4 便于流式
            pass

        # 拖入副本改存到持久素材库 media_store/（不再放临时目录，随工程长期保管）
        dest = _dedup_path(MEDIA_STORE_DIR, name)
        try:
            with open(dest, "wb") as f:
                f.write(file_bytes)
        except Exception as e:
            self._send_error_json(500, "保存上传文件失败：%s" % e)
            return

        info = probe_source(dest)
        if info is None:
            try:
                os.remove(dest)
            except OSError:
                pass
            self._send_error_json(400, "无法解析视频文件：%s" % name)
            return

        media = register_media(info, imported="upload", original_name=name)
        generate_thumb(media)
        # 约定：单文件返回对象
        self._send_json({"media": media})

    # ---- /api/thumb（缩略图 jpg）----
    def _handle_thumb(self, qs):
        media_id = (qs.get("id") or [None])[0]
        media = get_media(media_id)
        if media is None:
            self._send_error_json(404, "未知素材 id")
            return
        jpg = generate_thumb(media)
        if jpg and os.path.isfile(jpg):
            with open(jpg, "rb") as f:
                data = f.read()
            ctype = "image/jpeg"
        else:
            data = _PLACEHOLDER_JPG  # 生成失败：返回占位 jpg，避免破图
            ctype = "image/jpeg"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- /api/export ----
    def _handle_export(self):
        body = self._read_json_body()
        project = body.get("project")
        output_path = body.get("outputPath")
        if not output_path:
            self._send_error_json(400, "缺少 outputPath")
            return
        job_id = start_export_job(project, output_path)
        self._send_json({"jobId": job_id})

    # ---- /api/export/status ----
    def _handle_export_status(self, qs):
        job_id = (qs.get("id") or [None])[0]
        with _state_lock:
            job = _jobs.get(job_id)
        if job is None:
            self._send_error_json(404, "未知任务 id")
            return
        self._send_json({
            "state": job["state"],
            "progress": round(job.get("progress", 0.0), 4),
            "outputPath": job.get("outputPath"),
            "error": job.get("error"),
            "log": job.get("log") or [],
            "warnings": job.get("warnings") or [],
        })

    # ---- /api/projects（列出工程，按 modifiedAt 倒序）----
    def _handle_projects_list(self):
        self._send_json({"projects": list_projects()})

    # ---- /api/projects/load?id=（加载，离线不阻塞）----
    def _handle_projects_load(self, qs):
        pid = (qs.get("id") or [None])[0]
        loaded = load_project(pid)
        if loaded is None:
            self._send_error_json(404, "工程不存在或无法读取")
            return
        self._send_json(loaded)

    # ---- /api/projects/save（新建 / 覆盖 / 另存为）----
    def _handle_projects_save(self):
        body = self._read_json_body()
        project = body.get("project")
        if not isinstance(project, dict):
            self._send_error_json(400, "缺少 project 数据")
            return
        result = save_project(body.get("id"), body.get("name"), project)
        self._send_json(result)

    # ---- /api/projects/delete ----
    def _handle_projects_delete(self):
        body = self._read_json_body()
        pid = _safe_project_id(body.get("id"))
        if not pid:
            self._send_error_json(400, "非法工程 id")
            return
        ok = delete_project(pid)
        self._send_json({"ok": bool(ok)})

    # ---- /api/projects/rename ----
    def _handle_projects_rename(self):
        body = self._read_json_body()
        pid = _safe_project_id(body.get("id"))
        if not pid:
            self._send_error_json(400, "非法工程 id")
            return
        modified = rename_project(pid, body.get("name"))
        if modified is None:
            self._send_error_json(404, "工程不存在")
            return
        self._send_json({"ok": True, "modifiedAt": modified})

    # ---- /api/relink（重新链接离线素材；进程级映射，不落盘）----
    def _handle_relink(self):
        body = self._read_json_body()
        media_id = body.get("mediaId")
        path = body.get("path")
        if not path:
            self._send_error_json(400, "缺少 path")
            return
        self._send_json(relink_media(media_id, path))

    # ---- /api/stream（HTTP Range，沿用 v1）----
    def _handle_stream(self, qs):
        sid = (qs.get("id") or [None])[0]
        path = get_stream_path(sid)
        if not path or not os.path.isfile(path):
            self._send_error_json(404, "未知源 id")
            return

        file_size = os.path.getsize(path)
        range_header = self.headers.get("Range")

        if range_header:
            start, end = self._parse_range(range_header, file_size)
            if start is None:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % file_size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, file_size))
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self._send_file_range(path, start, length)
        else:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(file_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self._send_file_range(path, 0, file_size)

    def _parse_range(self, range_header, file_size):
        """解析 'bytes=START-END'。返回 (start, end) 闭区间，不可满足返回 (None, None)。"""
        try:
            unit, _, rng = range_header.partition("=")
            if unit.strip().lower() != "bytes":
                return None, None
            rng = rng.split(",")[0].strip()
            start_s, _, end_s = rng.partition("-")
            if start_s == "":
                if end_s == "":
                    return None, None
                n = int(end_s)
                if n <= 0:
                    return None, None
                start = max(0, file_size - n)
                end = file_size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else file_size - 1
            if start < 0 or start >= file_size:
                return None, None
            if end >= file_size:
                end = file_size - 1
            if end < start:
                return None, None
            return start, end
        except (ValueError, TypeError):
            return None, None

    def _send_file_range(self, path, start, length):
        remaining = length
        try:
            with open(path, "rb") as f:
                f.seek(start)
                while remaining > 0:
                    chunk = f.read(min(STREAM_CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
def find_free_port(host, start_port, max_tries=50):
    import socket
    port = start_port
    for _ in range(max_tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, port))
            s.close()
            return port
        except OSError:
            s.close()
            port += 1
    raise OSError("找不到可用端口（从 %d 起试了 %d 个）" % (start_port, max_tries))


def main():
    if not os.path.isfile(os.path.join(STATIC_DIR, "index.html")):
        print("[启动错误] 未找到 static/index.html，前端文件可能缺失。")
    if not os.path.isfile(PICKER_PY):
        print("[启动警告] 未找到 picker.py，导入/另存为对话框将不可用。")

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    port = find_free_port(HOST, DEFAULT_PORT)
    url = "http://%s:%d/" % (HOST, port)

    httpd = ThreadingHTTPServer((HOST, port), Handler)
    httpd.daemon_threads = True

    print("=" * 60)
    print("  轻剪 EasyCut v2  /  Multi-track NLE  —  本地服务已启动")
    print("=" * 60)
    print("  访问地址 / URL : %s" % url)
    print("  ffmpeg          : %s" % FFMPEG)
    print("  ffprobe         : %s" % FFPROBE)
    fonts = list_fonts()
    print("  可用 CJK 字体   : %d 个 (%s)" % (
        len(fonts), ", ".join(f["name"] for f in fonts) if fonts else "无"))
    print("  静态目录        : %s" % STATIC_DIR)
    print("  工作目录        : %s" % WORK_ROOT)
    print("  工程库          : %s" % PROJECTS_DIR)
    print("  持久素材库      : %s" % MEDIA_STORE_DIR)
    print("-" * 60)
    print("  浏览器将自动打开编辑界面；请保持本窗口开启。")
    print("  按 Ctrl+C 可停止服务。")
    print("-" * 60)

    def _open():
        try:
            webbrowser.open(url)
        except Exception as e:
            print("[提示] 自动打开浏览器失败，请手动访问：%s（%s）" % (url, e))

    threading.Timer(0.6, _open).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[停止] 收到 Ctrl+C，正在关闭服务...")
    finally:
        httpd.server_close()
        print("[停止] 服务已关闭。")


if __name__ == "__main__":
    main()
