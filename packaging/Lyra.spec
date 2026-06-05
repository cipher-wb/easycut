# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 打包配置：Lyra（ASTRA）桌面版。
# 在仓库根目录重建：  py -3 -m PyInstaller packaging/Lyra.spec --noconfirm --distpath dist --workpath build
# 产物：dist/Lyra/Lyra.exe（onedir）。ffmpeg.exe/ffprobe.exe 由打包脚本另外拷到 dist/Lyra/ 旁边。
import os
from PyInstaller.utils.hooks import collect_all

# SPECPATH 由 PyInstaller 注入 = 本 spec 所在目录(packaging/)；据此推出仓库根，全部用绝对路径，避免 cwd 歧义
HERE = SPECPATH
ROOT = os.path.dirname(HERE)

datas = [
    (os.path.join(ROOT, 'static'), 'static'),
    (os.path.join(ROOT, 'picker.py'), '.'),
    (os.path.join(ROOT, 'ai_config.example.json'), '.'),
    (os.path.join(ROOT, 'README.md'), '.'),   # 应用内「使用说明」(/help) 读它
]
binaries = []
hiddenimports = ['server', 'ffmpeg_build']

# pywebview(WebView2 后端) + pythonnet 运行时：整包收集，确保冻结后窗口能起来
for mod in ('webview', 'clr_loader', 'pythonnet'):
    try:
        d, b, h = collect_all(mod)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as e:
        print('[spec] collect_all skip %s: %s' % (mod, e))

a = Analysis(
    [os.path.join(HERE, 'lyra_app.py')],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter'],   # 冻结后用 pywebview 原生对话框，不再依赖 tkinter/picker 子进程
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='Lyra',
    icon=os.path.join(HERE, 'icon.ico'),
    console=False,                       # 无控制台（等同 pythonw）
    disable_windowed_traceback=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name='Lyra')
