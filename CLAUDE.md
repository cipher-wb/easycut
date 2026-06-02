# CLAUDE.md — 项目指南（给 Claude Code）

## ⚠️ 最重要的约定
**每次修改功能，都必须同步更新 `README.md`。**
`README.md` 是面向用户的**唯一使用说明**（中文）。任何改动只要影响到用户怎么用（新功能、交互变化、快捷键、按钮、导出选项、启动方式等），都要在同一次提交里把 README 改到与实际行为一致。改完自检：README 里描述的操作，按字面做一遍能否走通。

## 项目是什么
**轻剪 EasyCut** —— 一个零安装、可离线的**本地网页版多轨视频剪辑工具**（面向非专业用户给视频加中文说明、做画中画/变速/简单剪辑拼接）。
- 后端：`server.py`，**纯 Python 标准库** HTTP 服务，`subprocess` 调用本机 `ffmpeg`/`ffprobe`。禁止引入 pip 依赖、禁止 Flask 等框架。
- 前端：`static/`，**纯原生 HTML/CSS/JS**，无框架、无 CDN、必须可离线。
- 所有文本文件 UTF-8（无 BOM）；`启动.bat` 必须保持**纯 ASCII**（中文会在某些 cmd 代码页下乱码导致启动失败）。

## 怎么运行 / 怎么测
- 运行：双击 `启动.bat`，或 `py -3 server.py`（监听 `127.0.0.1:8765`，端口占用自动 +1，启动自动开浏览器）。
- ffmpeg/ffprobe 已确认装在本机（WinGet 目录或 PATH），`ffmpeg_build.find_ffmpeg/find_ffprobe` 会自动定位。
- **验证方式**：本机有全局 `playwright`（`npm root -g`）+ msedge。可用 headless 脚本打开 `http://127.0.0.1:8765/` 做 DOM/交互断言与截图；后端导出可直接 `import ffmpeg_build` 用 lavfi 造源真跑 ffmpeg + ffprobe 校验。改完 JS 跑 `node --check`，改完 Python 跑 `ast.parse` 自检。测完记得停掉占用 8765 的进程。

## 关键文件
| 文件 | 职责 |
|------|------|
| `server.py` | HTTP API：静态资源 / Range 视频流 `/api/stream` / 文件对话框 `/api/pick`,`/api/pick-save` / 拖拽上传 `/api/upload` / 缩略图 `/api/thumb` / 字体 `/api/fonts` / 导出 `/api/export`,`/api/export/status` |
| `ffmpeg_build.py` | 由 project 模型生成多轨合成滤镜图与参数（overlay 画中画 + drawtext 中文 + amix 混音 + setpts/atempo 变速），走 `-filter_complex_script` |
| `picker.py` | 系统「打开/另存为」对话框（tkinter 独立子进程，JSON 输出） |
| `static/app.js` | 唯一状态源 `project` + 撤销重做 + 事件总线 `bus` + `api.*` + 素材库 + 属性面板 + 导入 |
| `static/timeline.js` | 多轨时间轴渲染与交互（拖动/裁剪/磁吸/分割/变速拖拽/缩放/快捷键分发入口） |
| `static/player.js` | 多视频同步合成预览引擎（主时钟 + 每轨一个 `<video>` + 漂移纠偏 + playbackRate 变速） |
| `static/overlay.js` | 画中画与文字的选中变换手柄（拖动/缩放回写百分比） |
| `static/shortcuts.js` | 剪映/CapCut 风格快捷键 + 「⌨ 快捷键」说明面板（键表与面板同源） |
| `static/export.js` | 导出流程（pick-save → /api/export → 轮询进度） |
| `_build/` | 设计文档与实测记录（contract / ffmpeg_recipe / engine / timeline / speed 等），**已 .gitignore，不进仓库**；属内部脚手架 |

## 核心数据模型（前端状态 == 导出请求体）
```
project = {
  output: { width, height, fps, crf, keepAudio },
  media: [ { id, streamId, path, name, width, height, duration, fps, hasAudio, thumbUrl } ],
  tracks: [ {                 // 数组顺序 = z 序：index0 最底层，末尾最顶层（UI 顶行）
    id, kind:"video"|"text", name, muted, volume, hidden, locked,
    clips: [
      // 视频片段：
      { id, mediaId, in, out, start, speed, scale, cx, cy, opacity }
      // 文字片段：
      { id, content, start, duration, xPct, yPct, wPct, fontFile, fontSizePct,
        color, opacity, align, border, borderColor, borderWPct, box, boxColor, boxOpacity }
    ]
  } ]
}
```
**不变量**（改任何相关代码都要保持一致，否则预览/时间轴/导出会不同步）：
- 视频片段时间轴长度 `tlLen = (out - in) / speed`；源时间 `sourceTime = in + (时间轴t - start) * speed`。
- 几何全用百分比 / 比例（预览乘显示尺寸、导出乘 output 真实分辨率，二者同比）。
- 时间轴绝对秒 == 导出输出流时间；drawtext/overlay 用 `enable=between(t, start, start+tlLen)`。

## 已知约束 / 坑（别再踩）
- ffmpeg 滤镜里 Windows 路径转义：先 `\`→`/`，再 `:`→`\:`（单反斜杠），如 `C\:/Windows/Fonts/msyh.ttc`；中文经独立 UTF-8 `textfile` + `-filter_complex_script`。
- `atempo` 单级仅 [0.5,2]，变速需多级串联覆盖 [0.25,4]（见 `_build/speed_ffmpeg.md`）。
- OS 文件拖入导入只在 `app.js` 绑定一处 window 监听（曾因 app.js + timeline.js 双绑导致一次拖放上传两次）。
- 预览多视频同步是“近似”（浏览器限制），最终精度以 ffmpeg 离线导出为准。

## 提交规范
- 用中文提交信息；功能性改动同时改 README（见顶部约定）。
- commit message 结尾加：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 远端：`github.com/cipher-wb/easycut`（main 分支）。
