# -*- coding: utf-8 -*-
# 打包步骤：把 README.md 渲染成一份面向使用者的独立帮助页，写到 dist/Lyra/使用说明.html。
# 由 build.ps1 调用（build.ps1 保持纯 ASCII，中文文件名放在这个 .py 里）。
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

html = server.build_help_html()
out_dir = os.path.join(ROOT, "dist", "Lyra")
out = os.path.join(out_dir, "使用说明.html")
if html and os.path.isdir(out_dir):
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print("[gen_help] wrote", out)
else:
    print("[gen_help] WARN: README not found or dist/Lyra missing; skipped")
