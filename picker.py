# -*- coding: utf-8 -*-
"""
picker.py — 独立子进程，用 tkinter.filedialog 弹出系统“打开文件 / 另存为”对话框。

作为独立进程运行（由 server.py 用 sys.executable 启动），以规避 tkinter 必须在主线程、
与 http.server 工作线程冲突的问题。

用法（命令行）：
    python picker.py open            # 单选媒体，打印所选绝对路径(UTF-8)，一行
    python picker.py open-multiple   # 多选媒体，每个绝对路径一行
    python picker.py save [建议文件名]  # 另存为，打印所选绝对路径，一行

输出协议：
    - 结果以 JSON 打印到 stdout：{"paths": [...]} 或 {"path": "..."} / {"path": null}
      （server.py 解析 JSON；这样含特殊字符的中文路径也不会因换行歧义出错）。
    - 用户取消 / 无选择：{"paths": []} 或 {"path": null}。
    - stdout 统一 UTF-8。

用完即销毁隐藏的 root 窗口。
"""

import sys
import os
import json

MEDIA_FILETYPES = [
    ("媒体文件", ("*.mp4", "*.mov", "*.m4v", "*.mkv", "*.webm", "*.avi", "*.mp3", "*.wav", "*.m4a", "*.aac", "*.flac", "*.ogg", "*.opus")),
    ("视频文件", ("*.mp4", "*.mov", "*.m4v", "*.mkv", "*.webm", "*.avi")),
    ("音频文件", ("*.mp3", "*.wav", "*.m4a", "*.aac", "*.flac", "*.ogg", "*.opus")),
    ("MP4 视频", "*.mp4"),
    ("MP3 音频", "*.mp3"),
    ("所有文件", "*.*"),
]
EXPORT_FILETYPES = [("MP4 视频", "*.mp4"), ("所有文件", "*.*")]


def _make_root():
    import tkinter as tk
    root = tk.Tk()
    # 不用 withdraw()：被 CREATE_NO_WINDOW 启动时，withdraw 的对话框会失去前台父窗口、
    # 常常打开在浏览器“后面”，用户看着像“点了没反应”。改用一个**全透明、置顶、抢焦点**的
    # 1x1 窗口作父窗口，确保系统文件对话框出现在最前面。
    try:
        root.attributes("-alpha", 0.0)     # 完全透明，肉眼不可见
    except Exception:
        pass
    root.attributes("-topmost", True)
    root.geometry("1x1+0+0")
    try:
        root.deiconify(); root.lift(); root.focus_force()
    except Exception:
        pass
    try:
        root.update()
    except Exception:
        pass
    return root


def do_open(multiple):
    from tkinter import filedialog
    root = _make_root()
    try:
        if multiple:
            sel = filedialog.askopenfilenames(
                title="选择媒体（可多选）",
                filetypes=MEDIA_FILETYPES,
                parent=root,
            )
            # askopenfilenames 在某些平台返回 tcl 字符串元组，规范成 list[str]
            if isinstance(sel, str):
                sel = root.tk.splitlist(sel)
            paths = [os.path.abspath(p) for p in sel if p]
        else:
            p = filedialog.askopenfilename(
                title="选择媒体",
                filetypes=MEDIA_FILETYPES,
                parent=root,
            )
            paths = [os.path.abspath(p)] if p else []
        return {"paths": paths}
    finally:
        try:
            root.destroy()
        except Exception:
            pass


def do_save(suggest_name):
    from tkinter import filedialog
    root = _make_root()
    try:
        initialfile = suggest_name or "导出视频.mp4"
        # 确保有 .mp4 扩展名建议
        if not initialfile.lower().endswith(".mp4"):
            initialfile += ".mp4"
        p = filedialog.asksaveasfilename(
            title="导出为 mp4 文件",
            defaultextension=".mp4",
            initialfile=initialfile,
            filetypes=EXPORT_FILETYPES,
            parent=root,
        )
        return {"path": os.path.abspath(p) if p else None}
    finally:
        try:
            root.destroy()
        except Exception:
            pass


def main():
    # stdout 用 UTF-8（Windows 控制台默认可能是 GBK）
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    args = sys.argv[1:]
    mode = args[0] if args else "open"

    try:
        if mode == "open":
            result = do_open(multiple=False)
        elif mode == "open-multiple":
            result = do_open(multiple=True)
        elif mode == "save":
            suggest = args[1] if len(args) > 1 else ""
            result = do_save(suggest)
        else:
            result = {"error": "未知模式: %s" % mode}
    except Exception as e:
        # tkinter 不可用或对话框异常：返回空结果 + 错误信息，server 端按取消处理
        result = {"error": "对话框失败: %s" % e}
        if mode in ("open", "open-multiple"):
            result["paths"] = []
        else:
            result["path"] = None

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
