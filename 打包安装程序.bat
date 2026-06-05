@echo off
REM ============================================================
REM  Build Lyra installer (double-click this file).
REM  It runs packaging\build.ps1 : PyInstaller -> copy ffmpeg -> Inno Setup.
REM  Result:  dist\Lyra-Setup-1.0.0.exe
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ============================================================
echo   Building Lyra installer ... (1-3 minutes, please wait)
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\build.ps1"
echo.
echo ------------------------------------------------------------
echo   Done. Installer is in the  dist\  folder:
echo       dist\Lyra-Setup-1.0.0.exe
echo ------------------------------------------------------------
echo.
pause
