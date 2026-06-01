@echo off
rem ============================================================
rem  Jian Dan Jian Ji - Launcher / 简单剪辑 启动器
rem  Double-click this file to start the local video editor.
rem  双击本文件即可启动本地视频剪辑工具。
rem ============================================================

rem -- Use UTF-8 codepage so Python's Chinese output is not garbled --
rem -- 切换控制台为 UTF-8 代码页, 避免中文乱码 --
chcp 65001 >nul

rem -- Run from the directory where this .bat lives --
rem -- 切换到本脚本所在目录, 保证能找到 server.py --
cd /d "%~dp0"

title Jian Dan Jian Ji  -  Video Editor Server

echo ============================================================
echo   Jian Dan Jian Ji  /  Simple Video Editor
echo ============================================================
echo.
echo   Starting the local server...  / 正在启动本地服务...
echo   A browser tab will open automatically.
echo   浏览器会自动打开编辑界面。
echo.
echo   KEEP THIS WINDOW OPEN while you work.
echo   使用期间请勿关闭本窗口。
echo   Close this window to stop the service.
echo   关闭本窗口即可停止服务。
echo ------------------------------------------------------------
echo.

rem -- Locate server.py next to this launcher --
if not exist "%~dp0server.py" (
  echo [ERROR] server.py not found next to this launcher.
  echo [错误]  未在本目录找到 server.py, 文件可能被移动或缺失。
  echo.
  echo   Expected: "%~dp0server.py"
  echo.
  pause
  exit /b 1
)

rem -- Prefer the Python launcher "py -3", fall back to "python" --
rem -- 优先使用 py -3, 不可用时回退到 python --
where py >nul 2>nul
if %errorlevel%==0 (
  echo Using interpreter: py -3   / 使用解释器: py -3
  echo.
  py -3 "%~dp0server.py"
  goto :ended
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Using interpreter: python  / 使用解释器: python
  echo.
  python "%~dp0server.py"
  goto :ended
)

echo [ERROR] Python was not found on this computer.
echo [错误]  未检测到 Python, 请先安装 Python 3 并加入 PATH。
echo         Download / 下载: https://www.python.org/downloads/
echo.
pause
exit /b 1

:ended
rem -- We reach here after server.py exits (normal stop or crash) --
rem -- server.py 退出后到达此处 (正常停止或异常退出) --
echo.
echo ------------------------------------------------------------
echo   The server has stopped.  / 服务已停止。
echo   You can close this window now.  / 现在可以关闭本窗口。
echo ------------------------------------------------------------
echo.
pause
