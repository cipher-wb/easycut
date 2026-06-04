# CLAUDE.md — 项目指南（给 Claude Code）

## ⚠️ 最重要的约定
**每次修改功能，都必须同步更新 `README.md`。**
`README.md` 是面向用户的**唯一使用说明**（中文）。任何改动只要影响到用户怎么用（新功能、交互变化、快捷键、按钮、导出选项、启动方式等），都要在同一次提交里把 README 改到与实际行为一致。改完自检：README 里描述的操作，按字面做一遍能否走通。

## ⚠️ UI 风格标准（以后都用这套）
界面统一用**暖色「Claude 风格」**（浅色：米白底 `--bg #F0EEE6` + 陶土橙点缀 `--accent #D97757`；预览区暖近黑）。
- **一切颜色走 CSS 变量**（`--bg/--panel/--panel-2/--panel-3/--line/--text/--text-dim/--accent/--accent-2/--accent-soft/--danger/--ok/--clip-*` 等，见 `style.css` 顶部 `:root`）。**新增 UI 一律复用变量，禁止写死颜色**；需要新色就加变量并同时补 dark 值。
- **日夜模式**：深色由 `<html data-theme="dark">` 驱动（`style.css` 的 `:root[data-theme="dark"]` 覆盖整套变量）。切换逻辑在 `static/theme.js`（顶栏 `#btnTheme`，持久化到 `localStorage['qj-theme']`）；`index.html <head>` 有预置脚本防首屏闪烁。加新组件无需写切换逻辑，用变量即自动适配。
- **字体**：走系统字体（CSS 已有回退链 `"Noto Sans SC","PingFang SC","Microsoft YaHei"` / 标题 `"Noto Serif SC","Songti SC",serif`），**不引入网络字体**（离线优先）。标题/品牌用衬线。
- 圆角用 `--r-sm/--r-md/--r-lg`，阴影用 `--shadow/--shadow-pop`。
- 原型参考：`易剪/轻剪-Claude风格/`（设计稿，非运行代码）。

## 项目是什么
**轻剪 EasyCut** —— 一个零安装、可离线的**本地多轨视频剪辑桌面工具**（面向非专业用户给视频加中文说明、做画中画/变速/简单剪辑拼接）。形态是「本地网页 + 原生窗口外壳」：网页负责 UI，一个本地 Python 进程负责调 ffmpeg/读写文件。
- 后端：`server.py`，**核心逻辑坚持 Python 标准库** HTTP 服务，`subprocess` 调用本机 `ffmpeg`/`ffprobe`。**禁止 Flask 等 Web 框架**；**剪辑/导出/工程等核心逻辑禁止引入 pip 依赖**。
- 前端：`static/`，**纯原生 HTML/CSS/JS**，无框架、无 CDN、必须可离线。
- **唯一允许的 pip 依赖范围 = 桌面外壳/打包**（`pywebview`、将来 `pyinstaller`），见 `requirements.txt`；且必须可选——没装也能靠浏览器回退跑起来。除此之外一律标准库。
- 所有文本文件 UTF-8（无 BOM）；`排错启动(看日志).bat` 的**内容**必须保持**纯 ASCII**（中文 echo 会在某些 cmd 代码页下乱码导致启动失败；文件名可中文）。

## 形态：桌面版（pywebview 原生窗口，三级回退）
**轻剪是「桌面应用」**：`main()` 默认桌面模式 = 后台线程跑 `serve_forever`，主线程承载一个桌面外壳窗口，**关窗即 `httpd.shutdown()` 退出**。外壳按可用性三级回退：
1. **首选 `run_native_window(url)`** —— `import webview`（pywebview，Windows 走自带 **WebView2** 运行时 + pythonnet）。真·原生窗口，不依赖外部浏览器；`webview.start()` 必须在**主线程**、阻塞至窗口关闭。**这是要打包成 exe 的目标形态。**
2. **回退① `launch_app_window(url)`** —— 未装 pywebview 时，用本机 **Edge/Chrome `--app` 模式**（`find_app_browser()`：winreg App Paths→常见路径→PATH，优先 Edge）开无地址栏窗口，独立 `APP_PROFILE_DIR` 保证随窗口关闭而退。
3. **回退② `webbrowser.open`** —— 连浏览器都没有时，开普通标签（保留控制台）。
- `--no-app`/`--server-only`/`--browser` 任一参数 → 强制浏览器标签模式（开发用）。
- 用户入口：`轻剪.pyw`（`.pyw` 由 pythonw 运行，**无黑窗**，日常首选；已替代旧的 VBS——VBScript 被微软弃用）；`排错启动(看日志).bat`（py 运行、保留命令行日志窗，仅排错用，内容纯 ASCII）。
- 打包路线（稳定后）：PyInstaller 把 `server.py`+`static/` 打成单 exe（pywebview 一起进去），同事零 Python 依赖；ffmpeg 是否一并打包另议。**不要用 Tauri**（要 Rust/Node/VS Build Tools 工具链 + 重写后端，对保留 Python 的场景过重，已评估否决）。

## 怎么运行 / 怎么测
- 装外壳依赖（一次）：`python -m pip install -r requirements.txt`（装 pywebview；不装则自动回退 Edge --app）。
- 运行：双击 `轻剪.pyw`（无控制台原生窗口）或 `排错启动(看日志).bat`（带日志），或 `py -3 server.py`（默认开桌面窗口；`--no-app` 走浏览器标签，监听 `127.0.0.1:8765`，端口占用自动 +1）。
- 测原生窗口：起服后会拉起 WebView2（进程名 `msedgewebview2.exe`，**注意按命令行 user-data-dir 过滤——本机 clash-verge 也在用 WebView2，别误杀**；它还会拦本地 curl/Invoke-WebRequest，校验 HTTP 用 `curl --noproxy '*'` 或 `Get-NetTCPConnection`）。pywebview 的 `webview.start()` 在窗口关闭后返回 → 触发 `httpd.shutdown()`。
- 测 Edge 回退：`find_app_browser()` 应返回 msedge 路径；关掉**带 `jianjianji_work\appwindow` 的 msedge 进程**后服务应自动停。**别误杀用户日常 msedge**。
- 测完务必停掉本次起的 `python/pythonw server.py` 进程（force-kill 时其 WebView2 子进程会随父退出）。
- ffmpeg/ffprobe 已确认装在本机（WinGet 目录或 PATH），`ffmpeg_build.find_ffmpeg/find_ffprobe` 会自动定位。
- **验证方式**：本机有全局 `playwright`（`npm root -g`）+ msedge。可用 headless 脚本打开 `http://127.0.0.1:8765/` 做 DOM/交互断言与截图；后端导出可直接 `import ffmpeg_build` 用 lavfi 造源真跑 ffmpeg + ffprobe 校验。改完 JS 跑 `node --check`，改完 Python 跑 `ast.parse` 自检。测完记得停掉占用 8765 的进程。

## 关键文件
| 文件 | 职责 |
|------|------|
| `server.py` | HTTP API：静态资源 / Range 视频流 `/api/stream` / 文件对话框 `/api/pick`(桌面下走 pywebview 原生对话框、零拷贝引用原路径，否则回退 tkinter),`/api/pick-save` / **引用导入 `/api/link`**(按文件名认领 pywebview 拖入的真实路径，零拷贝引用入库) / 能力探测 `/api/caps`(nativeImport=是否支持引用导入) / 打开所在文件夹 `/api/reveal`(explorer /select 选中文件，本机服务各模式可用) / 拖拽上传 `/api/upload`(复制存 media_store，浏览器回退用) / 缩略图 `/api/thumb` / 字体 `/api/fonts` / 导出 `/api/export`,`/api/export/status` / 工程 `/api/projects`,`/api/projects/save|load|delete|rename` / 重新链接 `/api/relink` / **AI 代理 `/api/ai`**(stdlib urllib 转发用户自配大模型，Key 留后端、无 CORS) + 配置 `/api/ai/config`(GET 脱敏读 / POST 写 `ai_config.json`) |
| `ffmpeg_build.py` | 由 project 模型生成多轨合成滤镜图与参数（overlay 画中画 + drawtext 中文 + amix 混音 + setpts/atempo 变速），走 `-filter_complex_script` |
| `picker.py` | 系统「打开/另存为」对话框（tkinter 独立子进程，JSON 输出） |
| `static/app.js` | 唯一状态源 `project` + 撤销重做 + 事件总线 `bus` + `api.*` + 素材库 + 属性面板 + 导入 + 工程序列化/加载/脏标记/relink + **评论批注 mutator**（addComment/updateComment/removeComment/setCommentStatus，进 snapshot/序列化） |
| `static/timeline.js` | 多轨时间轴渲染与交互（拖动/裁剪/磁吸/分割/变速拖拽/缩放/快捷键分发入口）+ **评论标签层**（整轨带 + 每轨贴标签、贪心分层 `packLanes` 自动错开、右键加评论 / 编辑 / 区间 A–B 手柄） |
| `static/player.js` | 多视频同步合成预览引擎（主时钟 + 每轨一个 `<video>` + 漂移纠偏 + playbackRate 变速） |
| `static/overlay.js` | 画中画与文字的选中变换手柄（拖动/缩放回写百分比） |
| `static/shortcuts.js` | 剪映/CapCut 风格快捷键 + 「⌨ 快捷键」说明面板（键表与面板同源）。Ctrl+S=保存工程 / Ctrl+Shift+S=另存为 / Ctrl+E=导出 |
| `static/projects.js` | 工程系统 UI：工程面板（启动弹出）/ 保存/另存为对话框 / 离线横幅 / relink 流程 |
| `static/export.js` | 导出流程（pick-save → /api/export → 轮询进度） |
| `static/theme.js` | 白天/夜间主题切换（`#btnTheme`，data-theme=dark，localStorage `qj-theme`） |
| `static/ai.js` | **AI 剪辑助手**：自然语言→结构化剪辑指令。①指令注册表 `OPS`（op→{check,run}，加功能=注册新 op）②解析器（名字/前缀/选中/"中间1/3"等→id/秒）③解释器（整体校验→删除/导出确认→单步撤销执行）④AI 桥（系统提示注入指令表+工程快照→`/api/ai`→只输出 `{say,commands}` JSON→校验不过自动修复≤2 次）。全部编辑走 `App.*` mutator，撤销/刷新自动正确。面板 `#aiPanel`（同层并排可拖宽）、设置 `#aiConfigDialog`、顶栏 `#btnAi`。**`executeComments()`**：把时间轴待执行批注汇成结构化清单喂 AI→出 `{say,commands,done}`→**总是先列计划确认**→整批一步撤销执行→**执行成功的批注 removeComment 删除（不保留）**（面板「▶ 执行批注 (N)」#btnRunComments）。调试入口 `window.QJAi.run(cmds)` / `QJAi.runComments()` |
| `ai_config.json` | AI 配置（protocol/baseURL/**apiKey**/model），后端读写、原子写。**已 .gitignore，含密钥，绝不进仓库/不分发**。仓库内提交 `ai_config.example.json` 作模板（无真实 key；`load_ai_config` 只读 `AI_DEFAULT` 里的键，模板里的 `_说明` 等额外键被忽略） |
| `projects/`、`media_store/` | 运行时用户数据（工程库 / 持久素材副本），**已 .gitignore** |
| `_build/` | 设计文档与实测记录（contract / ffmpeg_recipe / engine / timeline / speed / project_design 等），**已 .gitignore，不进仓库**；属内部脚手架 |

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
      // 定格(冻结帧)片段：仍在视频轨，freeze:true，in==out==源帧时刻，
      //   时间轴长度由 duration 决定（与 in/out 解耦），speed=1，导出时强制静音
      { id, mediaId, freeze:true, in, out, start, speed:1, duration, scale, cx, cy, opacity }
      // 文字片段：
      { id, content, start, duration, xPct, yPct, wPct, fontFile, fontSizePct,
        color, opacity, align, border, borderColor, borderWPct, box, boxColor, boxOpacity }
    ]
  } ],
  // 时间轴批注（导演式剪辑指令，给 AI 执行；不直接改剪辑）。见 §评论系统
  comments: [ { id, text, kind:"point"|"range", scope:"clip"|"global",
                clipId?, at?|start?|end?,        // 时间轴绝对秒：point 用 at；range 用 start/end
                status:"pending"|"done"|"stale", createdAt, executedAt? } ]
}
```
**不变量**（改任何相关代码都要保持一致，否则预览/时间轴/导出会不同步）：
- 视频片段时间轴长度 `tlLen = (out - in) / speed`；源时间 `sourceTime = in + (时间轴t - start) * speed`。**定格片段** `tlLen = duration`（freeze:true，预览端把该轨视频钉在 in 帧并暂停；导出端 `trim` 抽一帧 + `tpad=clone` 保持 duration 秒）。
- 几何全用百分比 / 比例（预览乘显示尺寸、导出乘 output 真实分辨率，二者同比）。
- 时间轴绝对秒 == 导出输出流时间；drawtext/overlay 用 `enable=between(t, start, start+tlLen)`。

## 已知约束 / 坑（别再踩）
- ffmpeg 滤镜里 Windows 路径转义：先 `\`→`/`，再 `:`→`\:`（单反斜杠），如 `C\:/Windows/Fonts/msyh.ttc`；中文经独立 UTF-8 `textfile` + `-filter_complex_script`。
- `atempo` 单级仅 [0.5,2]，变速需多级串联覆盖 [0.25,4]（见 `_build/speed_ffmpeg.md`）。
- OS 文件拖入导入只在 `app.js` 绑定一处 window 监听（曾因 app.js + timeline.js 双绑导致一次拖放上传两次）。
- 预览多视频同步是“近似”（浏览器限制），最终精度以 ffmpeg 离线导出为准。
- 工程：`media.streamId/thumbUrl/offline` 是 **transient**——保存时剥离、加载时由后端按路径重新探测/分配（在线重登记进 `_media` 否则缩略图 404）；`tracks/clips` 引用稳定 `mediaId`。加载/relink 文件变短要 clamp 越界片段。

## 提交规范
- 用中文提交信息；功能性改动同时改 README（见顶部约定）。
- commit message 结尾加：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 远端：`github.com/cipher-wb/easycut`（main 分支）。
