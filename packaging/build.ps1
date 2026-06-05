# 一键打包 Lyra 安装程序（PyInstaller → 拷 ffmpeg → Inno Setup）。
# 在仓库根目录 PowerShell 里运行：  .\packaging\build.ps1
#
# 前置（只需一次）：
#   1) py -3 -m pip install -r requirements.txt        # pywebview
#   2) py -3 -m pip install --user pyinstaller
#   3) winget install JRSoftware.InnoSetup
#   4) 把 ffmpeg.exe / ffprobe.exe 放到 packaging\ffmpeg\ 下（essentials 版即可）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[1/3] PyInstaller 打包 dist\Lyra ..." -ForegroundColor Cyan
py -3 -m PyInstaller packaging\Lyra.spec --noconfirm --distpath dist --workpath build

Write-Host "[2/3] 拷贝随包 ffmpeg ..." -ForegroundColor Cyan
$ff = "packaging\ffmpeg\ffmpeg.exe"; $fp = "packaging\ffmpeg\ffprobe.exe"
if (-not (Test-Path $ff) -or -not (Test-Path $fp)) {
  throw "缺少 packaging\ffmpeg\ffmpeg.exe / ffprobe.exe —— 请先放进去（gyan essentials 构建即可）"
}
Copy-Item $ff, $fp -Destination "dist\Lyra" -Force

Write-Host "[3/3] 编译安装程序 ..." -ForegroundColor Cyan
$iscc = Get-ChildItem "$env:LOCALAPPDATA\Programs\Inno Setup*\ISCC.exe", `
                      "${env:ProgramFiles(x86)}\Inno Setup*\ISCC.exe", `
                      "$env:ProgramFiles\Inno Setup*\ISCC.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $iscc) { throw "未找到 ISCC.exe，请先安装 Inno Setup：winget install JRSoftware.InnoSetup" }
& $iscc.FullName "packaging\Lyra.iss"

Write-Host "`n完成 ✓  安装程序： dist\Lyra-Setup-1.0.0.exe" -ForegroundColor Green
