# Build the Lyra installer (PyInstaller -> copy ffmpeg -> Inno Setup).
# Run from repo root:   .\packaging\build.ps1   (or double-click the build .bat in repo root)
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 on a Chinese
# (GBK) system mis-decodes UTF-8 .ps1 files and breaks parsing, so no non-ASCII here.
#
# One-time prerequisites:
#   1) py -3 -m pip install -r requirements.txt        (pywebview)
#   2) py -3 -m pip install --user pyinstaller
#   3) winget install JRSoftware.InnoSetup
#   4) put ffmpeg.exe / ffprobe.exe into  packaging\ffmpeg\  (gyan essentials build is fine)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[1/3] PyInstaller ..." -ForegroundColor Cyan
py -3 -m PyInstaller packaging\Lyra.spec --noconfirm --distpath dist --workpath build
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)" }

Write-Host "[2/3] copy bundled ffmpeg ..." -ForegroundColor Cyan
$ff = "packaging\ffmpeg\ffmpeg.exe"
$fp = "packaging\ffmpeg\ffprobe.exe"
if (-not (Test-Path $ff) -or -not (Test-Path $fp)) {
  throw "Missing packaging\ffmpeg\ffmpeg.exe / ffprobe.exe -- put them there first (gyan essentials build)."
}
Copy-Item $ff, $fp -Destination "dist\Lyra" -Force

Write-Host "[2.5/3] generate user guide (help html) ..." -ForegroundColor Cyan
py -3 packaging\gen_help.py
if ($LASTEXITCODE -ne 0) { throw "gen_help.py failed (exit $LASTEXITCODE)" }

Write-Host "[3/3] compile installer (Inno Setup) ..." -ForegroundColor Cyan
$iscc = Get-ChildItem "$env:LOCALAPPDATA\Programs\Inno Setup*\ISCC.exe", `
                      "${env:ProgramFiles(x86)}\Inno Setup*\ISCC.exe", `
                      "$env:ProgramFiles\Inno Setup*\ISCC.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $iscc) { throw "ISCC.exe not found -- install Inno Setup: winget install JRSoftware.InnoSetup" }
& $iscc.FullName "packaging\Lyra.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "DONE.  Installer:  dist\Lyra-Setup-1.0.0.exe" -ForegroundColor Green
