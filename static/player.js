/* =========================================================================
 * player.js — 多视频多轨同步合成预览引擎 (PreviewEngine)
 *
 * 落地 _build/engine_v2.md 的 PreviewEngine, 字段/API/DOM id/bus 事件名严格
 * 遵循 _build/contract_v2.md (权威)。与 engine_v2.md 的 DOM 命名冲突处一律以
 * contract_v2.md §4.3 为准:
 *   - 画布盒        #canvasBox          (维持 output 比例, letterbox 居中)
 *   - 视频层容器    #videoLayers        (内含每条视频轨一个 <video>)
 *   - 单轨 video    <video id="vlayer-<trackId>" class="video-layer" data-track-id>
 *   - 文字/手柄层   #overlayLayer       (文字 WYSIWYG + 选中手柄, overlay.js 用)
 *
 * 核心:
 *   - 主时钟 performance.now() 驱动 playhead (时间轴绝对秒), 引擎唯一真值。
 *   - 每条视频轨一个 <video>; 每帧把各轨 currentTime 对齐到映射源时间;
 *     漂移 > DRIFT(0.1s) 才纠正; 片段边界换源走 loadeddata; switching 期不纠正。
 *   - PiP: scale/cx/cy/opacity 用 CSS 内联定位 (与导出 overlay 像素同公式);
 *     z-index = 轨道在 tracks 数组中的 index (越大越上层)。
 *   - 文字层: 复用 v1 buildTextNode, 按 start<=t<start+duration 显隐。
 *   - 音频: 各 <video> 并发出声(浏览器混音), 按轨 muted/volume 控制, 同源不重复发声。
 *
 * 复用 v1 player.js 已实测可靠: letterbox 布局、换源时序(src→load→loadeddata→
 * seek→seeked)、_safeSeek 防御、buildTextNode/hexToRgba 文字节点、error 跳过、
 * /api/stream Range 流、time:update/overlay:rendered 事件。
 * ========================================================================= */
(function () {
  'use strict';
  var App = window.App;
  var bus = App.bus;

  /* ---------- 兼容读取: 优先契约方法, 回退字段 ---------- */
  function P() { return App.getProject ? App.getProject() : App.project; }

  /* =====================================================================
   * 几何 (§0.3 engine_v2 / §5.1 contract_v2) — 预览与导出逐字相同
   * ===================================================================== */
  // 默认 contain 变换 (拖入新片段时由 app 计算, 这里供引擎/overlay 复用)
  function defaultTransform(srcW, srcH, W, H) {
    var canvasAR = W / H, srcAR = srcW / srcH;
    var scale = (srcAR >= canvasAR) ? 1.0 : srcAR * (H / W);
    return { scale: scale, cx: 0.5, cy: 0.5, opacity: 1 };
  }
  App.defaultTransform = defaultTransform;

  // 片段屏幕矩形: 预览传 boxW/boxH, 导出传 output.W/H, 与 ffmpeg overlay 像素逐字相同
  function pipRect(clip, srcW, srcH, W, H) {
    var clipW = Math.round((clip.scale != null ? clip.scale : 1) * W);
    var clipH = Math.round(clipW * srcH / srcW);
    var cx = clip.cx != null ? clip.cx : 0.5;
    var cy = clip.cy != null ? clip.cy : 0.5;
    var x = Math.round(cx * W - clipW / 2);
    var y = Math.round(cy * H - clipH / 2);
    return { x: x, y: y, w: clipW, h: clipH };
  }
  App.pipRect = pipRect;

  /* ---------- 变速: 设 playbackRate + 保持音调(含前缀回退) ---------- */
  // speed_design.md §3.1: 变速预览用 playbackRate, 音频不变调用 preservesPitch。
  function applyRate(v, speed) {
    var r = (speed == null ? 1 : speed);
    if (!(r > 0)) r = 1;
    if (v.playbackRate !== r) { try { v.playbackRate = r; } catch (e) {} }
    if ('preservesPitch' in v) v.preservesPitch = true;
    if ('mozPreservesPitch' in v) v.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
  }

  /* =====================================================================
   * letterbox 画布布局 #canvasBox (复用 v1 layoutVideoBox, 改 id)
   * ===================================================================== */
  function layoutCanvasBox() {
    var stage = document.getElementById('stage');
    var box = document.getElementById('canvasBox');
    if (!stage || !box) return { boxW: 0, boxH: 0 };
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var out = P().output || { width: 1920, height: 1080 };
    var ar = (out.width && out.height) ? out.width / out.height : 16 / 9;
    var w = sw, h = Math.round(sw / ar);
    if (h > sh) { h = sh; w = Math.round(sh * ar); }
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    _boxSize = { boxW: w, boxH: h };
    return _boxSize;
  }
  var _boxSize = { boxW: 0, boxH: 0 };
  // 若 app.js 未自定义 getBoxSize, 由本模块提供 (返回最近一次 layout 结果)
  App.getBoxSize = function () { return _boxSize; };
  App.layoutCanvasBox = layoutCanvasBox;

  /* =====================================================================
   * 文字节点构建 (复用 v1, 适配 v2 字段名: id 用 data-clip-id/data-track-id)
   * ===================================================================== */
  function hexToRgba(hex, alpha) {
    var h = ('' + (hex || '#FFFFFF')).replace('#', '');
    if (h.length !== 6) h = 'FFFFFF';
    var r = parseInt(h.substring(0, 2), 16);
    var g = parseInt(h.substring(2, 4), 16);
    var b = parseInt(h.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha != null ? alpha : 1) + ')';
  }
  App.hexToRgba = hexToRgba;

  // tx: text-clip; trackId: 所属文字轨 id (用于 data-track-id)
  function buildTextNode(tx, boxW, boxH, trackId) {
    var el = document.createElement('div');
    el.className = 'textbox';
    el.dataset.clipId = tx.id;
    if (trackId != null) el.dataset.trackId = trackId;
    var selId = App.getSelection && App.getSelection();
    if (selId && selId.kind === 'text' && selId.clipId === tx.id) el.classList.add('selected');

    el.style.left = (tx.xPct * boxW) + 'px';
    el.style.top = (tx.yPct * boxH) + 'px';
    el.style.width = (tx.wPct * boxW) + 'px';
    if (tx.hPct != null) el.style.height = (tx.hPct * boxH) + 'px';   // 显式框高（纵向拉过才有）

    var fontPx = (tx.fontSizePct != null ? tx.fontSizePct : 0.06) * boxH;
    el.style.fontSize = fontPx + 'px';
    el.style.lineHeight = 1.2;
    el.style.fontFamily = '"Microsoft YaHei","微软雅黑",sans-serif';
    el.style.textAlign = tx.align || 'left';
    el.style.color = hexToRgba(tx.color || '#FFFFFF', tx.opacity != null ? tx.opacity : 1);

    if (tx.box) {
      el.style.background = hexToRgba(tx.boxColor || '#000000', tx.boxOpacity != null ? tx.boxOpacity : 0.5);
      el.style.padding = Math.max(2, Math.round(fontPx * 0.12)) + 'px';
    }
    if (tx.border) {
      var bw = Math.max(1, Math.round((tx.borderWPct || 0) * boxH));
      var bc = tx.borderColor || '#000000';
      if (window.CSS && CSS.supports && CSS.supports('-webkit-text-stroke', '1px black')) {
        el.style.webkitTextStroke = bw + 'px ' + bc;
        el.style.paintOrder = 'stroke fill';
      } else {
        el.style.textShadow =
          '-' + bw + 'px -' + bw + 'px 0 ' + bc + ', ' + bw + 'px -' + bw + 'px 0 ' + bc + ', ' +
          '-' + bw + 'px ' + bw + 'px 0 ' + bc + ', ' + bw + 'px ' + bw + 'px 0 ' + bc;
      }
    }

    var content = document.createElement('div');
    content.className = 'tb-content';
    content.textContent = tx.content || '';
    el.appendChild(content);

    // 四角 + 四边手柄：拖框只改框宽/框高（不动字号）；四边单轴、四角双轴
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (pos) {
      var hd = document.createElement('div');
      hd.className = 'tb-handle ' + pos;
      hd.dataset.handle = pos;
      el.appendChild(hd);
    });
    var fh = document.createElement('div');
    fh.className = 'tb-fonth';
    fh.dataset.handle = 'font';
    fh.title = '上下拖动改字号';
    el.appendChild(fh);
    return el;
  }
  App.buildTextNode = buildTextNode;

  /* =====================================================================
   * 派生时间轴索引 (engine_v2 §1) — 若 app.js 已提供 getTimeline 则复用其结构,
   * 否则本模块自建并暴露 App.getTimeline / App.rebuildTimeline。
   * timeline 结构: { videoTracks:[{track, clips:[{clip,media,tStart,tEnd}]}],
   *                  textClips:[{clip,track}], totalDuration, mediaById }
   * ===================================================================== */
  var timeline = { videoTracks: [], textClips: [], totalDuration: 0, mediaById: new Map() };

  function rebuildTimeline() {
    var proj = P();
    var mediaById = new Map();
    var media = proj.media || [];
    for (var i = 0; i < media.length; i++) mediaById.set(media[i].id, media[i]);

    var videoTracks = [], textClips = [], total = 0;
    var tracks = proj.tracks || [];
    for (var ti = 0; ti < tracks.length; ti++) {
      var track = tracks[ti];
      if (track.kind === 'video') {
        var segs = [];
        var clips = track.clips || [];
        for (var ci = 0; ci < clips.length; ci++) {
          var clip = clips[ci];
          var m = mediaById.get(clip.mediaId);
          if (!m) continue;                         // 源缺失: 跳过
          // 公式 A: 视频片段时间轴长度 = (out-in)/speed；定格片段 = duration（与 in/out 解耦）
          var dur = clip.freeze ? (clip.duration || 0) : (clip.out - clip.in) / (clip.speed || 1);
          if (!(dur > 0)) continue;                 // 非法区间: 跳过
          var tStart = clip.start, tEnd = clip.start + dur;
          segs.push({ clip: clip, media: m, tStart: tStart, tEnd: tEnd });
          if (tEnd > total) total = tEnd;
        }
        segs.sort(function (a, b) { return a.tStart - b.tStart; });
        videoTracks.push({ track: track, clips: segs, zIndex: ti });
      } else if (track.kind === 'text') {
        var tclips = track.clips || [];
        for (var k = 0; k < tclips.length; k++) {
          var tc = tclips[k];
          textClips.push({ clip: tc, track: track });
          var te = tc.start + tc.duration;
          if (te > total) total = te;
        }
      }
    }
    timeline = { videoTracks: videoTracks, textClips: textClips, totalDuration: total, mediaById: mediaById };
    return timeline;
  }

  // 若 app.js 已实现 getTimeline (返回不同结构), 优先用 app 的。否则用本模块的。
  if (!App.getTimeline) App.getTimeline = function () { return timeline; };
  if (!App.rebuildTimeline) App.rebuildTimeline = rebuildTimeline;
  // 引擎内部恒用本模块的 timeline 结构, 不依赖 app 的 getTimeline 形态。
  function TL() { return timeline; }

  // 在某条视频轨上二分定位 t 时刻的活动片段 (半开区间), 无则 null (该轨此刻透明)
  function activeClipOnTrack(vt, t) {
    var segs = vt.clips, lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].tStart <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return null;
    var s = segs[ans];
    if (t < s.tEnd) return s;
    return null;
  }

  /* =====================================================================
   * TrackPlayer — 管理一条视频轨的单个 <video>
   * ===================================================================== */
  function TrackPlayer(trackId, container) {
    this.trackId = trackId;
    var v = document.createElement('video');
    v.id = 'vlayer-' + trackId;            // contract §4.3: #vlayer-<trackId>
    v.className = 'video-layer';
    v.dataset.trackId = trackId;
    v.muted = true;                         // 默认静音, applyAudio 按轨解除
    v.playsInline = true; v.preload = 'auto'; v.controls = false;
    container.appendChild(v);
    this.v = v;
    this.curMediaId = null;
    this.curClipId = null;
    this.switching = false;
    this._pendingSeek = null;
    this._wantPlay = false;
    this._bind();
  }

  TrackPlayer.prototype._bind = function () {
    var self = this;
    this._onLoaded = function () {
      if (self._pendingSeek != null) { self._safeSeek(self._pendingSeek); self._pendingSeek = null; }
    };
    this._onSeeked = function () {
      self.switching = false;
      if (self._wantPlay && self.v.paused) self.v.play().catch(function () {});
    };
    this._onError = function () {
      self.switching = false; self.curMediaId = null; self.curClipId = null;
      if (App.toast) App.toast('某轨视频片段加载失败，该轨此处留空', 'error', 1800);
    };
    this.v.addEventListener('loadeddata', this._onLoaded);
    this.v.addEventListener('seeked', this._onSeeked);
    this.v.addEventListener('error', this._onError);
  };

  TrackPlayer.prototype._safeSeek = function (st) {
    if (this.v.readyState < 1) { this._pendingSeek = st; return; }   // 元数据未就绪, 挂起
    try { this.v.currentTime = st; } catch (e) {}
  };

  // 换源: 仅 mediaId 变化时重设 src (复用 v1 时序), 否则直接 seek
  TrackPlayer.prototype.setMedia = function (media, sourceTime, wantPlay) {
    this._wantPlay = wantPlay;
    if (this.curMediaId === media.id && this.v.getAttribute('src')) {
      this.switching = true; this._safeSeek(sourceTime); return;     // 同源: 直接安全 seek
    }
    this.curMediaId = media.id;
    this.switching = true;
    this._pendingSeek = sourceTime;
    this.v.src = App.api.streamUrl(media.streamId);                  // /api/stream?id=... Range 流式
    this.v.load();                                                  // → loadeddata → seek → seeked
  };

  TrackPlayer.prototype.clearMedia = function () {       // 该轨此刻无活动片段 → 透明
    if (this.curMediaId == null && this._wantPlay === false && this.v.style.display === 'none') return;
    this.curMediaId = null; this.curClipId = null; this._wantPlay = false;
    if (!this.v.paused) { try { this.v.pause(); } catch (e) {} }
    this.v.style.display = 'none';
  };

  TrackPlayer.prototype.dispose = function () {
    try { this.v.pause(); } catch (e) {}
    this.v.removeEventListener('loadeddata', this._onLoaded);
    this.v.removeEventListener('seeked', this._onSeeked);
    this.v.removeEventListener('error', this._onError);
    this.v.removeAttribute('src'); try { this.v.load(); } catch (e) {}
    if (this.v.parentNode) this.v.parentNode.removeChild(this.v);
  };

  /* =====================================================================
   * PreviewEngine — 主时钟 + 多轨同步 + 合成
   * ===================================================================== */
  function PreviewEngine() {
    this.videoLayer = document.getElementById('videoLayers'); // contract §4.3
    this.textLayer = document.getElementById('overlayLayer'); // 文字 WYSIWYG 层(契约合并 text+fx)
    this.players = new Map();        // trackId -> TrackPlayer
    this.playhead = 0;               // 时间轴秒, 引擎真值
    this.playing = false;
    this.rate = 1;
    this._startedWall = 0;
    this._startedHead = 0;
    this.rafId = 0;
    this.DRIFT = 0.10;               // 漂移阈值(秒), 超过才强制纠正 (DRIFT_EPS contract §6.1)
    this._lastTextSig = '';
    this._forceTextRefresh = false;
    this._bindVisibility();
  }

  /* ---------- 轨道 ↔ TrackPlayer 同步 (tracks 增删/改后调用) ---------- */
  PreviewEngine.prototype.rebuild = function () {
    rebuildTimeline();
    var tl = TL();
    var want = new Set();
    for (var i = 0; i < tl.videoTracks.length; i++) {
      var id = tl.videoTracks[i].track.id;
      want.add(id);
      if (!this.players.has(id)) this.players.set(id, new TrackPlayer(id, this.videoLayer));
    }
    var self = this;
    this.players.forEach(function (p, id) {
      if (!want.has(id)) { p.dispose(); self.players.delete(id); }
    });
    if (this.playhead > tl.totalDuration) this.playhead = tl.totalDuration;
    if (this.playhead < 0) this.playhead = 0;
    this._forceTextRefresh = true;
    this._rebaseClock();
    this.applyAudio();
    this.syncVideos(this.playhead, true);
    this.layoutAll();
    this.renderTexts(this.playhead);
    this._emitTime();
    this._refreshEmptyHint();
    if (this.playing && tl.totalDuration <= 0) this.pause();
  };

  /* ---------- 主时钟 ---------- */
  PreviewEngine.prototype._rebaseClock = function () {
    this._startedWall = (window.performance && performance.now) ? performance.now() : Date.now();
    this._startedHead = this.playhead;
  };
  PreviewEngine.prototype._advanceClock = function () {
    if (!this.playing) return;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var dt = (now - this._startedWall) / 1000 * this.rate;
    this.playhead = this._startedHead + dt;
  };

  /* ---------- 公共 API ---------- */
  PreviewEngine.prototype.play = function () {
    var tl = TL();
    if (tl.totalDuration <= 0) return;
    if (this.playhead >= tl.totalDuration - 1e-6) this.playhead = 0;   // 末尾再播 → 回头
    this.playing = true;
    this._rebaseClock();
    this.applyAudio();
    this.syncVideos(this.playhead, true);
    this.players.forEach(function (p) {
      if (p.curMediaId && !p.switching) p.v.play().catch(function () {});
    });
    this._startLoop();
    this._emitPlayState(true);
  };
  PreviewEngine.prototype.pause = function () {
    this.playing = false;
    this.players.forEach(function (p) {
      p._wantPlay = false; if (!p.v.paused) { try { p.v.pause(); } catch (e) {} }
    });
    this._stopLoop();
    this._emitPlayState(false);
  };
  PreviewEngine.prototype.toggle = function () { this.playing ? this.pause() : this.play(); };

  PreviewEngine.prototype.stop = function () {        // 到末尾: 钉末尾, 暂停, 保留末帧
    var tl = TL();
    this.playhead = tl.totalDuration;
    this.pause();
    this.syncVideos(this.playhead, true);
    this.layoutAll();
    this.renderTexts(this.playhead);
    this._emitTime();
  };

  PreviewEngine.prototype.seek = function (t) {       // 拖游标/点击时间轴/步进/进度条
    var tl = TL();
    t = Math.min(Math.max(t, 0), tl.totalDuration);
    this.playhead = t;
    this._rebaseClock();
    this.applyAudio();
    this.syncVideos(t, true);
    this.layoutAll();
    this.renderTexts(t);
    this._emitTime();
  };
  // 兼容 v1 命名
  PreviewEngine.prototype.seekTimeline = function (t) { this.seek(t); };

  PreviewEngine.prototype.stepFrame = function (dir) {
    var fps = (P().output && P().output.fps) || 30;
    this.pause();
    this.seek(this.playhead + dir / fps);
  };

  /* ---------- 主循环 (rAF 唯一) ---------- */
  PreviewEngine.prototype._startLoop = function () {
    var self = this; this._stopLoop();
    var tick = function () { self.rafId = requestAnimationFrame(tick); self.renderFrame(); };
    this.rafId = requestAnimationFrame(tick);
  };
  PreviewEngine.prototype._stopLoop = function () {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
  };
  PreviewEngine.prototype.renderFrame = function () {
    var tl = TL();
    if (tl.totalDuration <= 0) { this.pause(); return; }
    this._advanceClock();
    if (this.playhead >= tl.totalDuration) { this.stop(); return; }
    this.syncVideos(this.playhead, false);
    this.layoutAll();
    this.renderTexts(this.playhead);
    this._emitTime();
  };

  /* ---------- 多轨同步: 每帧把各轨 video 对齐到 t ---------- */
  PreviewEngine.prototype.syncVideos = function (t, forceReseek) {
    var tl = TL();
    for (var i = 0; i < tl.videoTracks.length; i++) {
      var vt = tl.videoTracks[i];
      var p = this.players.get(vt.track.id);
      if (!p) continue;
      var seg = vt.track.hidden ? null : activeClipOnTrack(vt, t);

      if (!seg) { p.clearMedia(); continue; }            // 间隙/隐藏 → 透明
      // 离线素材(streamId 失效)无可播放源 → 该段留黑, 不请求 /api/stream?id=null (设计 §4.1)
      if (!seg.media || !seg.media.streamId || seg.media.offline) { p.clearMedia(); continue; }

      // 定格片段: 把该轨视频定位到源帧 clip.in 并钉住(暂停 + 不前进), 整段显示同一静止帧。
      if (seg.clip.freeze) {
        var ft = seg.clip.in;
        if (p.curClipId !== seg.clip.id || p.curMediaId !== seg.media.id) {
          p.curClipId = seg.clip.id;
          p.setMedia(seg.media, ft, false);              // 换源/seek 到源帧, 不播放
        } else if (!p.switching) {
          if (!p.v.paused) { try { p.v.pause(); } catch (e) {} }   // 钉住: 不随主时钟前进
          if (Math.abs(p.v.currentTime - ft) > this.DRIFT) { p._wantPlay = false; p._safeSeek(ft); }
        }
        p.v.style.display = '';
        continue;
      }

      var spd = (seg.clip.speed || 1);                   // 变速倍率(默认 1)
      // 公式 B: 期望源时刻 = in + (t - start) * speed (video 以 playbackRate 自行前进, 此为源秒域)
      var want = seg.clip.in + (t - seg.clip.start) * spd;
      var clipChanged = (p.curClipId !== seg.clip.id);
      var mediaChanged = (p.curMediaId !== seg.media.id);

      if (mediaChanged || clipChanged) {                 // 片段边界: 换源或同源 seek
        p.curClipId = seg.clip.id;
        p.setMedia(seg.media, want, this.playing);
        applyRate(p.v, spd);                             // 换源后浏览器会复位 rate, 故每次都设
        p.v.style.display = '';
      } else if (!p.switching) {                          // 同片段播放中
        applyRate(p.v, spd);                             // 同源持续保证 rate/保音调不被复位
        if (forceReseek) {
          p._wantPlay = this.playing; p.switching = true; p._safeSeek(want);
        } else {
          // 漂移判定在源秒域: want 已含 speed, currentTime 本就是源秒, 同域直接比较
          var have = p.v.currentTime;
          if (Math.abs(have - want) > this.DRIFT) {       // 漂移过大 → 纠正(否则放任防抖)
            p._wantPlay = this.playing; p._safeSeek(want);
          }
          if (this.playing && p.v.paused && !p.switching) p.v.play().catch(function () {});
        }
        p.v.style.display = '';
      } else {
        applyRate(p.v, spd);                             // switching 中也设, 保证 seeked 后即正确
        p.v.style.display = '';                            // switching 中: 保持上一帧
      }
    }
  };

  /* ---------- 合成布局: PiP 矩形 + z 序 + opacity ---------- */
  PreviewEngine.prototype.layoutAll = function () {
    var box = App.getBoxSize();
    var tl = TL();
    for (var i = 0; i < tl.videoTracks.length; i++) {
      var vt = tl.videoTracks[i];
      var p = this.players.get(vt.track.id);
      if (!p) continue;
      var seg = vt.track.hidden ? null : activeClipOnTrack(vt, this.playhead);
      if (!seg) { p.v.style.display = 'none'; continue; }
      this.layoutTrackVideo(p, seg.clip, seg.media, box, vt.zIndex);
    }
  };
  PreviewEngine.prototype.layoutTrackVideo = function (p, clip, media, box, zIndex) {
    var r = pipRect(clip, media.width, media.height, box.boxW, box.boxH);
    var st = p.v.style;
    st.left = r.x + 'px'; st.top = r.y + 'px';
    st.width = r.w + 'px'; st.height = r.h + 'px';
    st.zIndex = zIndex;
    st.opacity = (clip.opacity != null ? clip.opacity : 1);
    if (st.display === 'none') st.display = '';
  };

  /* ---------- 音频: 按轨 muted/volume, 避免重复源 ---------- */
  PreviewEngine.prototype.applyAudio = function () {
    var keepAudio = !P().output || P().output.keepAudio !== false;
    var tl = TL();
    for (var i = 0; i < tl.videoTracks.length; i++) {
      var vt = tl.videoTracks[i];
      var p = this.players.get(vt.track.id);
      if (!p) continue;
      var seg = activeClipOnTrack(vt, this.playhead);
      var hasAudio = !!(seg && seg.media && seg.media.hasAudio);
      p.v.muted = !!(vt.track.muted) || !keepAudio || !hasAudio;
      p.v.volume = (vt.track.volume != null ? vt.track.volume : 1);
    }
  };

  /* ---------- 文字层 (复用 v1 buildTextNode, 按时间显隐) ---------- */
  PreviewEngine.prototype.renderTexts = function (t) {
    if (App.isEditingText && App.isEditingText()) { this._forceTextRefresh = false; return; }
    if (!this.textLayer) return;
    var tl = TL();
    var visible = [];
    for (var i = 0; i < tl.textClips.length; i++) {
      var tc = tl.textClips[i];
      if (tc.track.hidden) continue;
      var c = tc.clip;
      if (t >= c.start && t < c.start + c.duration) visible.push(tc);
    }
    // 末帧特例: t===total 时也显示恰好 end===total 的文字, 便于查看末帧
    if (t >= tl.totalDuration - 1e-6) {
      for (var k = 0; k < tl.textClips.length; k++) {
        var tc2 = tl.textClips[k];
        if (tc2.track.hidden) continue;
        var c2 = tc2.clip, end2 = c2.start + c2.duration;
        if (visible.indexOf(tc2) < 0 && Math.abs(end2 - t) < 1e-3 && t >= c2.start) visible.push(tc2);
      }
    }
    var box = App.getBoxSize();
    var sig = box.boxW + 'x' + box.boxH + '|' +
      visible.map(function (x) { return x.clip.id; }).join(',');
    if (sig === this._lastTextSig && !this._forceTextRefresh) return;  // 纯播放且集合未变: 跳过
    this._lastTextSig = sig;
    this._forceTextRefresh = false;
    this.textLayer.innerHTML = '';
    for (var m = 0; m < visible.length; m++) {
      this.textLayer.appendChild(buildTextNode(visible[m].clip, box.boxW, box.boxH, visible[m].track.id));
    }
    bus.emit('overlay:rendered', { ids: visible.map(function (x) { return x.clip.id; }) });
  };
  PreviewEngine.prototype.renderTextsNow = function () { this.renderTexts(this.playhead); };

  /* ---------- overlay.js 用: 画布矩形 + 选中视频片段屏幕矩形 ---------- */
  PreviewEngine.prototype.getCanvasRect = function () {
    var box = App.getBoxSize();
    return { x: 0, y: 0, w: box.boxW, h: box.boxH };
  };
  PreviewEngine.prototype.clipScreenRect = function (clipId) {
    var box = App.getBoxSize(), tl = TL();
    for (var i = 0; i < tl.videoTracks.length; i++) {
      var segs = tl.videoTracks[i].clips;
      for (var j = 0; j < segs.length; j++) {
        if (segs[j].clip.id === clipId) {
          return pipRect(segs[j].clip, segs[j].media.width, segs[j].media.height, box.boxW, box.boxH);
        }
      }
    }
    return null;
  };
  // 给定 clipId 返回 {clip, media} (overlay 缩放/移动回写时取源宽高)
  PreviewEngine.prototype.findVideoClip = function (clipId) {
    var tl = TL();
    for (var i = 0; i < tl.videoTracks.length; i++) {
      var segs = tl.videoTracks[i].clips;
      for (var j = 0; j < segs.length; j++) {
        if (segs[j].clip.id === clipId) return { clip: segs[j].clip, media: segs[j].media, trackId: tl.videoTracks[i].track.id };
      }
    }
    return null;
  };

  /* ---------- 可见性 / 资源回收 ---------- */
  PreviewEngine.prototype._bindVisibility = function () {
    var self = this;
    this._onVis = function () {
      if (document.hidden) return;
      if (self.playing) self._rebaseClock();   // 切回前台: 重置时钟基准防跳变
    };
    document.addEventListener('visibilitychange', this._onVis);
  };
  PreviewEngine.prototype.dispose = function () {
    this.pause();
    document.removeEventListener('visibilitychange', this._onVis);
    this.players.forEach(function (p) { p.dispose(); });
    this.players.clear();
    if (this.textLayer) this.textLayer.innerHTML = '';
  };

  /* ---------- UI 回调 (bus + 时间码) ---------- */
  PreviewEngine.prototype._refreshEmptyHint = function () {
    var hint = document.getElementById('emptyHint');
    if (hint) hint.style.display = (TL().totalDuration > 0) ? 'none' : '';
  };
  PreviewEngine.prototype._emitTime = function () {
    var total = TL().totalDuration;
    // contract §3.1: time:update payload = { t, total, playing }
    bus.emit('time:update', { t: this.playhead, total: total, playing: this.playing });
    var lbl = document.getElementById('lblTimecode');
    if (lbl) lbl.textContent = App.fmtTime(this.playhead) + ' / ' + App.fmtTime(total);
  };
  PreviewEngine.prototype._emitPlayState = function (playing) {
    var btn = document.getElementById('btnPlayPause');
    if (btn) btn.textContent = playing ? '❚❚' : '▶';
    bus.emit('playstate:changed', { playing: playing });
    bus.emit(playing ? 'play' : 'pause', {});
  };

  // App 代理: getPlayhead
  App.getPlayhead = function () { return App.engine ? App.engine.playhead : 0; };

  /* =====================================================================
   * 初始化 + 事件接线
   * ===================================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    layoutCanvasBox();
    rebuildTimeline();

    var engine = new PreviewEngine();
    App.engine = engine;
    engine.rebuild();

    /* ---- 播放控制 ---- */
    var btnPlay = document.getElementById('btnPlayPause');
    if (btnPlay) btnPlay.addEventListener('click', function () { engine.toggle(); });
    bus.on('play', function (p) { if (!engine.playing) engine.play(); });
    bus.on('pause', function (p) { if (engine.playing) engine.pause(); });
    bus.on('seek', function (t) { engine.seek(typeof t === 'number' ? t : (t && t.t) || 0); });

    /* ---- 项目结构变化: 整体重建 (换源/重排轨道) ---- */
    // contract 权威事件: project:changed / tracks:changed。
    // 同时兼容 timeline_v2 的 clips:changed (片段增删改, 不一定动轨道集合)。
    bus.on('project:changed', function () { engine.rebuild(); });
    bus.on('tracks:changed', function () { engine.rebuild(); });
    bus.on('clips:changed', function () {
      rebuildTimeline();
      if (engine.playhead > timeline.totalDuration) engine.playhead = timeline.totalDuration;
      engine._forceTextRefresh = true;
      engine._rebaseClock();
      engine.applyAudio();
      engine.syncVideos(engine.playhead, true);
      engine.layoutAll();
      engine.renderTexts(engine.playhead);
      engine._emitTime();
      engine._refreshEmptyHint();
      if (engine.playing && timeline.totalDuration <= 0) engine.pause();
    });

    /* ---- 轨道音频属性变化 (mute/volume) ---- */
    bus.on('audio:changed', function () { engine.applyAudio(); });

    /* ---- 片段变换 (scale/cx/cy/opacity, 来自 overlay 手柄): 仅重排不换源 ---- */
    bus.on('transform:changed', function () { engine.layoutAll(); });

    /* ---- 文字变化 / 选中 ---- */
    bus.on('texts:changed', function () { engine._forceTextRefresh = true; engine.renderTextsNow(); });
    bus.on('text:selected', function () { engine._forceTextRefresh = true; engine.renderTextsNow(); });
    // contract 权威选中事件:
    bus.on('selection:changed', function () { engine._forceTextRefresh = true; engine.renderTextsNow(); });

    /* ---- 输出比例变化 → 重排画布盒 + 重布局 + 重刷文字 ---- */
    bus.on('output:changed', function () {
      layoutCanvasBox();
      engine.layoutAll();
      engine._forceTextRefresh = true;
      engine.renderTextsNow();
    });

    /* ---- 窗口 resize ---- */
    var _rsz = null;
    window.addEventListener('resize', function () {
      if (_rsz) cancelAnimationFrame(_rsz);
      _rsz = requestAnimationFrame(function () {
        layoutCanvasBox();
        engine.layoutAll();
        engine._forceTextRefresh = true;
        engine.renderTextsNow();
      });
    });
  });

})();
