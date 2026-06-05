# 打包 / 分发（Lyra · ASTRA）

把 Lyra 打成**真·安装程序** `Lyra-Setup-1.0.0.exe`，同事双击即可安装、零依赖（已内置 ffmpeg）。

## 产物
- `dist\Lyra-Setup-1.0.0.exe` —— 发给同事的**安装程序**（~66MB）。
  - 双击 → 每用户安装（**无需管理员**）到 `%LOCALAPPDATA%\Programs\Lyra`，建开始菜单/桌面快捷方式。
  - 内置 **ffmpeg/ffprobe**，同事电脑无需另装 Python / ffmpeg / 浏览器（WebView2 一般系统自带）。
  - 用户数据（工程 / 素材库 / AI 配置）写到 `%LOCALAPPDATA%\Lyra`，不污染安装目录。

## 一键重建
前置（每台打包机一次）：
```powershell
py -3 -m pip install -r requirements.txt        # pywebview
py -3 -m pip install --user pyinstaller
winget install JRSoftware.InnoSetup
# 并把 ffmpeg.exe / ffprobe.exe 放到 packaging\ffmpeg\（gyan essentials 构建即可，~97MB 一个）
```
然后在仓库根目录：
```powershell
.\packaging\build.ps1
```

## 换图标
占位图标在 `packaging\icon.ico`（陶土橙 + 白色 L + ASTRA 星）。**替换成你的 .ico**（建议含 16/32/48/64/128/256 多尺寸）后重跑 `build.ps1` 即可——`Lyra.spec`（exe 图标）和 `Lyra.iss`（安装程序图标）都引用它。

## 文件说明
| 文件 | 作用 |
|------|------|
| `lyra_app.py` | PyInstaller 入口（= `server.main()`） |
| `Lyra.spec` | PyInstaller 配置（onedir，收集 pywebview/pythonnet，排除 tkinter） |
| `Lyra.iss` | Inno Setup 安装脚本（每用户安装、快捷方式、卸载） |
| `build.ps1` | 一键：PyInstaller → 拷 ffmpeg → ISCC 编译 |
| `icon.ico/.png` | 占位图标（替换我） |
| `ffmpeg/` | 随包 ffmpeg（**不进 git**，打包前自备） |

## 改了什么以支持冻结(exe)
- `server.py`：`RESOURCE_DIR`(_MEIPASS, 只读资源) 与 `DATA_DIR`(%LOCALAPPDATA%\Lyra, 用户数据) 分流；
  新增 `native_save()`（pywebview 原生另存为，替代冻结后会失效的 picker.py 子进程）。
- `ffmpeg_build.py`：`_find_tool` 优先找 exe 同目录的 ffmpeg（随包）。

## 提升版本号
改 `Lyra.iss` 顶部 `#define MyAppVersion "1.0.0"`，产物名随之变化。
