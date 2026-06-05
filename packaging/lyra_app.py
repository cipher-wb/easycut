# -*- coding: utf-8 -*-
# PyInstaller 打包入口：启动 Lyra（ASTRA）桌面应用。
# 等价于双击 Lyra.pyw —— 直接跑 server.main()（默认 pywebview 原生窗口，关窗即退出）。
import server

if __name__ == "__main__":
    server.main()
