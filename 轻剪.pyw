# -*- coding: utf-8 -*-
# 轻剪 EasyCut — 桌面版启动器
# .pyw 文件由 Windows 的 pythonw 运行：双击即用、无黑色控制台窗口，
# 也不依赖已被微软弃用的 VBScript。
#
# 启动后：若已安装 pywebview，则弹出一个原生桌面窗口（WebView2）；
# 否则自动回退到 Edge/Chrome 应用窗口，再不行回退浏览器标签。
# 关闭窗口即退出程序（后台服务自动停止）。
#
# 想看运行日志 / 排错：改为双击 "启动.bat"（会保留命令行日志窗口）。
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
os.chdir(HERE)

import server  # noqa: E402

if __name__ == "__main__":
    server.main()
