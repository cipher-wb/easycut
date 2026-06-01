# -*- coding: utf-8 -*-
"""
server.py — “简单剪辑”本地后端（纯 Python 标准库，零安装）。

实现 _build/contract.md §2 的全部 HTTP API：
  GET  /                         -> static/index.html
  GET  /static/<file>            -> 静态资源（正确 mimetype，禁止路径穿越）
  POST /api/pick                 -> 调 picker.py 选 mp4，ffprobe 解析，返回 {sources:[...]}
  POST /api/pick-save            -> 调 picker.py 另存为，返回 {path:...}
  GET  /api/stream?id=<sid>      -> HTTP Range 流式回放（206/Accept-Ranges/Content-Range）
  POST /api/export               -> 后台线程跑 ffmpeg，立即返回 {jobId}
  GET  /api/export/status?id=... -> {state,progress,outputPath,error,log}
  GET  /api/fonts                -> {fonts:[{name,path}...]}（前端字体下拉用，仅列存在者）

约定：
  - 监听 127.0.0.1，端口默认 8765，被占用自动 +1 找空闲。
  - 所有 JSON UTF-8（ensure_ascii=False）。所有文本读写 UTF-8。
  - subprocess 调 ffmpeg/ffprobe/picker 一律用 list 参数（含中文/空格路径安全）。
  - 维护 sourceId -> 绝对路径 映射，供 /api/stream。
  - 启动后自动 webbrowser.open 打开首页。
"""

import os
import sys
import json
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

# 候选 CJK 字体（仅列存在者；见 contract.md §7）
FONT_CANDIDATES = [
    ("微软雅黑", "msyh.ttc"),
    ("微软雅黑 Bold", "msyhbd.ttc"),
    ("黑体", "simhei.ttf"),
    ("宋体", "simsun.ttc"),
    ("楷体", "simkai.ttf"),
    ("仿宋", "simfang.ttf"),
    ("等线", "Deng.ttf"),
]

# ---------------------------------------------------------------------------
# 全局状态（带锁）
# ---------------------------------------------------------------------------
_state_lock = threading.Lock()
_sources = {}            # sourceId -> 绝对路径
_source_seq = 0          # 源 id 递增计数
_jobs = {}               # jobId -> job dict
_job_seq = 0             # job id 递增计数

FFMPEG = ffmpeg_build.find_ffmpeg()
FFPROBE = ffmpeg_build.find_ffprobe()

# Windows 下用 CREATE_NO_WINDOW 防止子进程弹黑框
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _next_source_id():
    global _source_seq
    with _state_lock:
        _source_seq += 1
        return "src_%d" % _source_seq


def _next_job_id():
    global _job_seq
    with _state_lock:
        _job_seq += 1
        return "job_%d" % _job_seq


def register_source(path):
    """登记一个源文件，返回 sourceId。"""
    sid = _next_source_id()
    with _state_lock:
        _sources[sid] = os.path.abspath(path)
    return sid


def get_source_path(sid):
    with _state_lock:
        return _sources.get(sid)


# ---------------------------------------------------------------------------
# ffprobe：解析源信息
# ---------------------------------------------------------------------------
def probe_source(path):
    """对一个视频文件跑 ffprobe，返回 source 对象（不含 id）。失败返回 None。"""
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
            # 跳过封面图等 attached_pic
            if s.get("disposition", {}).get("attached_pic") == 1:
                continue
            vstream = s
        elif ct == "audio":
            has_audio = True
    if vstream is None:
        # 没有真正的视频流
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

    # duration：format 优先，缺失退 video stream
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

    # fps：优先 avg_frame_rate，再 r_frame_rate（形如 30000/1001）
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
# 导出任务（后台线程跑 ffmpeg + 解析进度）
# ---------------------------------------------------------------------------
def start_export_job(project, output_path):
    """构建 ffmpeg 命令并启动后台线程。返回 jobId。
    构建/校验失败抛 ffmpeg_build.ExportValidationError。
    """
    import tempfile

    job_id = _next_job_id()
    work_dir = os.path.join(tempfile.gettempdir(), "jianjianji_work", job_id)
    os.makedirs(work_dir, exist_ok=True)

    source_path_map = {}
    with _state_lock:
        source_path_map = dict(_sources)

    # 可能抛 ExportValidationError（同步 400）
    built = ffmpeg_build.build_export(
        project, output_path, source_path_map, work_dir, ffmpeg_exe=FFMPEG
    )

    job = {
        "id": job_id,
        "state": "running",
        "progress": 0.0,
        "outputPath": built["output_path"],
        "error": None,
        "log": [],
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
    log_lines = []          # stderr 尾部
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

    # stderr 读线程（取日志/错误尾部）
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

    # stdout 读进度（-progress pipe:1）
    try:
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                key, _, val = line.partition("=")
                if val not in ("N/A", ""):
                    try:
                        us = int(val)
                        if key == "out_time_ms":
                            # 某些版本 out_time_ms 实际是微秒；统一按微秒，若过大则当毫秒
                            secs = us / 1e6
                        else:
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
        job["error"] = "ffmpeg 退出码 %d。%s" % (
            proc.returncode,
            _guess_error_hint(tail),
        )
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
        return "滤镜参数有误（请检查文字/路径设置）。"
    # 回显最后一非空行
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
            # 前端 fontFile 用正斜杠绝对路径，便于直接进契约模型
            result.append({"name": name, "path": p.replace("\\", "/")})
    return result


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "JianJianJi/1.0"
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
        return json.loads(raw.decode("utf-8"))

    def log_message(self, fmt, *args):
        # 精简日志（避免噪音），仅打印非 stream 请求
        msg = fmt % args
        if "/api/stream" not in msg:
            sys.stderr.write("  %s - %s\n" % (self.address_string(), msg))

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
            elif path == "/api/export/status":
                self._handle_export_status(qs)
            elif path == "/api/fonts":
                self._send_json({"fonts": list_fonts()})
            elif path == "/favicon.ico":
                # 浏览器自动请求，无图标，回 204 避免控制台 404 噪音
                self.send_response(204)
                self.end_headers()
            else:
                self._send_error_json(404, "未找到: %s" % path)
        except BrokenPipeError:
            pass
        except ConnectionResetError:
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
            elif path == "/api/export":
                self._handle_export()
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
        # path 形如 /static/xxx
        rel = path[len("/static/"):]
        # 禁止路径穿越
        if not rel or ".." in rel.split("/") or rel.startswith("/") or ":" in rel:
            self._send_error_json(404, "非法路径")
            return
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        # 必须仍在 STATIC_DIR 内
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
        if ctype.startswith("text/") or ctype in (
            "application/javascript", "application/json",
        ):
            ctype += "; charset=utf-8"
        # .js 的 mimetype 在部分系统被识别为 text/plain，强制纠正
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

    # ---- /api/pick ----
    def _handle_pick(self):
        body = self._read_json_body()
        multiple = bool(body.get("multiple", True))
        mode = "open-multiple" if multiple else "open"
        picked = run_picker(mode)
        paths = picked.get("paths") or []

        sources = []
        skipped = []
        for p in paths:
            if not os.path.isfile(p):
                skipped.append(p)
                continue
            info = probe_source(p)
            if info is None:
                skipped.append(p)
                continue
            sid = register_source(p)
            info["id"] = sid
            # 把 path 用正斜杠回传，便于前端展示（契约只要求绝对路径）
            info["path"] = info["path"].replace("\\", "/")
            sources.append(info)

        resp = {"sources": sources}
        if skipped:
            resp["error"] = "以下文件无法解析，已跳过：" + "; ".join(os.path.basename(s) for s in skipped)
        self._send_json(resp)

    # ---- /api/pick-save ----
    def _handle_pick_save(self):
        body = self._read_json_body()
        suggest = body.get("suggestName") or "导出视频.mp4"
        picked = run_picker("save", suggest_name=suggest)
        path = picked.get("path")
        if path:
            path = os.path.abspath(path).replace("\\", "/")
        self._send_json({"path": path})

    # ---- /api/export ----
    def _handle_export(self):
        body = self._read_json_body()
        project = body.get("project")
        output_path = body.get("outputPath")
        if not output_path:
            self._send_error_json(400, "缺少 outputPath")
            return
        # start_export_job 内部 build_export 可能抛 ExportValidationError -> 400
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
        })

    # ---- /api/stream（HTTP Range）----
    def _handle_stream(self, qs):
        sid = (qs.get("id") or [None])[0]
        path = get_source_path(sid)
        if not path or not os.path.isfile(path):
            self._send_error_json(404, "未知源 id")
            return

        file_size = os.path.getsize(path)
        range_header = self.headers.get("Range")

        if range_header:
            start, end = self._parse_range(range_header, file_size)
            if start is None:
                # 不可满足
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
            # 只处理第一个区间
            rng = rng.split(",")[0].strip()
            start_s, _, end_s = rng.partition("-")
            if start_s == "":
                # 后缀范围: -N (最后 N 字节)
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
            # 浏览器中断（seek/关闭）属正常
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
    # 确保关键文件存在
    if not os.path.isfile(os.path.join(STATIC_DIR, "index.html")):
        print("[启动错误] 未找到 static/index.html，前端文件可能缺失。")
    if not os.path.isfile(PICKER_PY):
        print("[启动警告] 未找到 picker.py，导入/另存为对话框将不可用。")

    # mimetypes 兜底
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    port = find_free_port(HOST, DEFAULT_PORT)
    url = "http://%s:%d/" % (HOST, port)

    httpd = ThreadingHTTPServer((HOST, port), Handler)
    httpd.daemon_threads = True

    print("=" * 60)
    print("  简单剪辑  /  Simple Video Editor  —  本地服务已启动")
    print("=" * 60)
    print("  访问地址 / URL : %s" % url)
    print("  ffmpeg          : %s" % FFMPEG)
    print("  ffprobe         : %s" % FFPROBE)
    fonts = list_fonts()
    print("  可用 CJK 字体   : %d 个 (%s)" % (
        len(fonts), ", ".join(f["name"] for f in fonts) if fonts else "无"))
    print("  静态目录        : %s" % STATIC_DIR)
    print("-" * 60)
    print("  浏览器将自动打开编辑界面；请保持本窗口开启。")
    print("  按 Ctrl+C 可停止服务。")
    print("-" * 60)

    # 自动打开浏览器（延迟一点，确保服务已就绪）
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
