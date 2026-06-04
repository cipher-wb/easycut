@echo off
REM ============================================================
REM  Simple Editor - Launcher
REM  Double-click to start the local video editor.
REM  (All messages here are English on purpose, so this file
REM   runs correctly on any Windows system codepage.)
REM ============================================================

chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
title QingJian EasyCut - Server

echo ============================================================
echo   QingJian EasyCut  -  local multi-track video editor
echo ============================================================
echo.
echo   Starting EasyCut... a desktop app window will open.
echo   Close THAT window to quit; this console stops with it.
echo.
echo   This is the LOG / TROUBLESHOOT launcher (shows errors).
echo   For normal daily use, double-click the .pyw launcher
echo   (no black console). Use this .bat only when something
echo   goes wrong and you need to read the messages below.
echo ------------------------------------------------------------
echo.

if not exist "%~dp0server.py" (
  echo [ERROR] server.py not found next to this launcher.
  echo         Expected: "%~dp0server.py"
  echo.
  pause
  exit /b 1
)

REM Prefer the Python launcher "py -3", fall back to "python".
where py >nul 2>nul
if %errorlevel%==0 (
  echo Using interpreter: py -3
  echo.
  py -3 "%~dp0server.py"
  goto ended
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Using interpreter: python
  echo.
  python "%~dp0server.py"
  goto ended
)

echo [ERROR] Python 3 was not found on this computer.
echo         Please install Python 3 and add it to PATH.
echo         Download: https://www.python.org/downloads/
echo.
pause
exit /b 1

:ended
echo.
echo ------------------------------------------------------------
echo   The server has stopped. You can close this window now.
echo ------------------------------------------------------------
echo.
pause
