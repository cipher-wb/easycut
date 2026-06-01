/* =========================================================================
 * player.js — 虚拟播放头预览引擎（engine.md §2/§3 落地）
 * 单个 <video id="video"> 跨多 clip 连续播放；换源；seek；
 * 每帧按时间轴时间驱动 overlay 显隐与时间轴播放头。
 * DOM id 按 contract.md §4.2：#stage #videoWrap #video #overlayLayer
 * ========================================================================= */
(function () {
  'use strict';
  var App = window.App;
  var bus = App.bus;

  /* ---------- 时间轴时间 -> 片段定位（engine.md §2） ---------- */
  function findSegmentIndex(t) {
    var tl = App.getTimeline();
    var seg = tl.segments;
    if (seg.length === 0) return -1;
    if (t <= 0) return 0;
    if (t >= tl.totalDuration) return seg.length - 1;
    var lo = 0, hi = seg.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (seg[mid].timelineStart <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }
  function timelineTimeToClip(t) {
    var tl = App.getTimeline();
    var idx = findSegmentIndex(t);
    if (idx < 0) return null;
    var s = tl.segments[idx];
    var tt = Math.min(Math.max(t, s.timelineStart), s.timelineEnd);
    var sourceTime = s.clip.in + (tt - s.timelineStart);
    if (sourceTime > s.clip.out) sourceTime = s.clip.out;
    if (sourceTime < s.clip.in) sourceTime = s.clip.in;
    return {
      clipIndex: idx, clip: s.clip, source: s.source, sourceTime: sourceTime,
      timelineStart: s.timelineStart, timelineEnd: s.timelineEnd,
      localOffset: tt - s.timelineStart
    };
  }
  function clipTimeToTimeline(clipIndex, sourceTime) {
    var s = App.getTimeline().segments[clipIndex];
    if (!s) return 0;
    return s.timelineStart + (sourceTime - s.clip.in);
  }

  /* ---------- 文字节点构建（engine.md §3.3，WYSIWYG） ---------- */
  function hexToRgba(hex, alpha) {
    var h = ('' + (hex || '#FFFFFF')).replace('#', '');
    if (h.length !== 6) h = 'FFFFFF';
    var r = parseInt(h.substring(0, 2), 16);
    var g = parseInt(h.substring(2, 4), 16);
    var b = parseInt(h.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha != null ? alpha : 1) + ')';
  }

  function buildTextNode(tx, boxW, boxH) {
    var el = document.createElement('div');
    el.className = 'textbox';
    el.dataset.textId = tx.id;
    if (App.selectedTextId === tx.id) el.classList.add('selected');

    el.style.left = (tx.xPct * boxW) + 'px';
    el.style.top = (tx.yPct * boxH) + 'px';
    el.style.width = (tx.wPct * boxW) + 'px';

    var fontPx = tx.fontSizePct * boxH;
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

    // 文本内容节点（overlay.js 会把它变成可编辑；这里先放文本）
    var content = document.createElement('div');
    content.className = 'tb-content';
    content.textContent = tx.content || '';
    el.appendChild(content);

    // 手柄（缩放 wPct / 字号），由 overlay.js 处理交互
    ['nw', 'ne', 'sw', 'se'].forEach(function (pos) {
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
  App.buildTextNode = buildTextNode; // overlay.js 复用

  /* ---------- letterbox 布局 #videoWrap（engine.md §0） ---------- */
  function layoutVideoBox() {
    var stage = document.getElementById('stage');
    var wrap = document.getElementById('videoWrap');
    if (!stage || !wrap) return { boxW: 0, boxH: 0 };
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var out = App.project.output;
    var ar = (out.width && out.height) ? out.width / out.height : 16 / 9;
    var w = sw, h = Math.round(sw / ar);
    if (h > sh) { h = sh; w = Math.round(sh * ar); }
    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';
    return { boxW: w, boxH: h };
  }

  /* ===================================================================== *
   * PreviewEngine
   * ===================================================================== */
  function PreviewEngine(video, overlay) {
    this.v = video;
    this.overlay = overlay;
    this.playhead = 0;
    this.playing = false;
    this.curIndex = -1;
    this.switching = false;
    this.rafId = 0;
    this.EPS = 0.035;
    this._pendingSeek = null;
    this._forceTextRefresh = false;
    this._lastSig = '';
    this._curSrcId = null;
    this._bind();
  }

  PreviewEngine.prototype._tl = function () { return App.getTimeline(); };

  PreviewEngine.prototype._bind = function () {
    var self = this;
    this._onLoaded = function () {
      if (self._pendingSeek != null) { self._safeSeek(self._pendingSeek); self._pendingSeek = null; }
    };
    this._onSeeked = function () {
      self.switching = false;
      if (self.playing && self.v.paused) self.v.play().catch(function () {});
    };
    this._onEnded = function () { self._tryAdvanceAtBoundary(true); };
    this._onError = function () {
      self.switching = false;
      App.toast('该视频片段加载失败，已跳过', 'error', 2200);
      self._jumpToTimeline(self._segEnd(self.curIndex) + self.EPS, self.playing);
    };
    this.v.addEventListener('loadeddata', this._onLoaded);
    this.v.addEventListener('seeked', this._onSeeked);
    this.v.addEventListener('ended', this._onEnded);
    this.v.addEventListener('error', this._onError);
  };
  PreviewEngine.prototype._segEnd = function (i) { var s = this._tl().segments[i]; return s ? s.timelineEnd : 0; };

  /* ---------- 公共 API ---------- */
  PreviewEngine.prototype.play = function () {
    var tl = this._tl();
    if (tl.totalDuration <= 0) return;
    if (this.playhead >= tl.totalDuration - 1e-6) this.playhead = 0;
    this.playing = true;
    this._onPlayState(true);
    this._ensureSourceForPlayhead(true);
    this._startLoop();
  };
  PreviewEngine.prototype.pause = function () {
    this.playing = false;
    this.v.pause();
    this._stopLoop();
    this._onPlayState(false);
  };
  PreviewEngine.prototype.toggle = function () { this.playing ? this.pause() : this.play(); };

  PreviewEngine.prototype.seekTimeline = function (t) {
    var tl = this._tl();
    t = Math.min(Math.max(t, 0), tl.totalDuration);
    this._jumpToTimeline(t, this.playing);
  };
  PreviewEngine.prototype.renderTextsNow = function () { this._renderTexts(this.playhead); };

  /* ---------- 内部：定位/换源 ---------- */
  PreviewEngine.prototype._ensureSourceForPlayhead = function (resumePlay) {
    var loc = timelineTimeToClip(this.playhead);
    if (!loc) { this.pause(); return; }
    var needSwitchSrc = (this._curSrcId !== loc.source.id) || !this.v.src;
    this.curIndex = loc.clipIndex;
    if (needSwitchSrc) {
      this._loadSourceAndSeek(loc.source.id, loc.sourceTime, resumePlay);
    } else {
      this._safeSeekAndMaybePlay(loc.sourceTime, resumePlay);
    }
  };

  PreviewEngine.prototype._loadSourceAndSeek = function (sourceId, sourceTime, resumePlay) {
    this.switching = true;
    this._pendingSeek = sourceTime;
    var url = App.api.streamUrl(sourceId);
    var abs = new URL(url, location.href).href;
    if (this.v.src !== abs || this._curSrcId !== sourceId) {
      this._curSrcId = sourceId;
      this.v.src = url;
      this.v.load();
    } else {
      this._pendingSeek = null;
      this._safeSeek(sourceTime);
    }
  };
  PreviewEngine.prototype._safeSeekAndMaybePlay = function (sourceTime) {
    this.switching = true;
    this._safeSeek(sourceTime);
  };
  PreviewEngine.prototype._safeSeek = function (sourceTime) {
    if (this.v.readyState < 1) { this._pendingSeek = sourceTime; return; }
    try { this.v.currentTime = sourceTime; } catch (e) {}
  };

  PreviewEngine.prototype._jumpToTimeline = function (t, resumePlay) {
    var tl = this._tl();
    if (tl.totalDuration <= 0) {
      this.playhead = 0; this.curIndex = -1; this._curSrcId = null;
      this.v.removeAttribute('src'); this.v.load && this.v.load();
      this._renderTexts(0); this._onTimeUpdate(0, 0);
      return;
    }
    if (t >= tl.totalDuration - 1e-6) {
      this.playhead = tl.totalDuration;
      this.curIndex = tl.segments.length - 1;
      // 仍把视频定位到末帧
      var locEnd = timelineTimeToClip(this.playhead);
      if (locEnd) {
        if (this._curSrcId !== locEnd.source.id) this._loadSourceAndSeek(locEnd.source.id, locEnd.sourceTime, false);
        else this._safeSeek(locEnd.sourceTime);
      }
      this._renderTexts(this.playhead);
      this._onTimeUpdate(this.playhead, tl.totalDuration);
      this.pause();
      return;
    }
    this.playhead = Math.max(0, t);
    this._ensureSourceForPlayhead(resumePlay);
    this._renderTexts(this.playhead);
    this._onTimeUpdate(this.playhead, tl.totalDuration);
  };

  /* ---------- 主循环 ---------- */
  PreviewEngine.prototype._startLoop = function () {
    var self = this;
    this._stopLoop();
    var tick = function () { self.rafId = requestAnimationFrame(tick); self._frame(); };
    this.rafId = requestAnimationFrame(tick);
  };
  PreviewEngine.prototype._stopLoop = function () {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
  };
  PreviewEngine.prototype._frame = function () {
    var tl = this._tl();
    if (tl.totalDuration <= 0) { this.pause(); return; }
    if (!this.switching && this.curIndex >= 0) {
      var seg = tl.segments[this.curIndex];
      if (seg) {
        var st = this.v.currentTime;
        var clamped = Math.min(Math.max(st, seg.clip.in), seg.clip.out);
        this.playhead = clipTimeToTimeline(this.curIndex, clamped);
        if (st >= seg.clip.out - this.EPS) this._tryAdvanceAtBoundary(false);
      }
    }
    this._renderTexts(this.playhead);
    this._onTimeUpdate(this.playhead, tl.totalDuration);
  };

  PreviewEngine.prototype._tryAdvanceAtBoundary = function (fromEnded) {
    var tl = this._tl();
    var nextIndex = this.curIndex + 1;
    if (nextIndex >= tl.segments.length) {
      this.playhead = tl.totalDuration;
      this._renderTexts(this.playhead);
      this._onTimeUpdate(this.playhead, tl.totalDuration);
      this.pause();
      return;
    }
    var cur = tl.segments[this.curIndex];
    var nxt = tl.segments[nextIndex];
    this.playhead = nxt.timelineStart;
    this.curIndex = nextIndex;
    if (cur.source.id === nxt.source.id) {
      this.switching = true;
      this._safeSeek(nxt.clip.in);
    } else {
      this._loadSourceAndSeek(nxt.source.id, nxt.clip.in, this.playing);
    }
  };

  /* ---------- 文字叠加（与 drawtext enable=between(t,start,end) 等价） ---------- */
  PreviewEngine.prototype._renderTexts = function (t) {
    // 正在编辑文本时不重建 overlay（避免销毁 contenteditable 节点丢焦点）
    if (App.isEditingText && App.isEditingText()) { this._forceTextRefresh = false; return; }
    var visible = [];
    var texts = App.project.texts;
    for (var i = 0; i < texts.length; i++) {
      var tx = texts[i];
      if (t >= tx.start && t < tx.end) visible.push(tx);
    }
    // 末帧特例：t === total 时也显示 end===total 的文字，便于查看
    if (t >= this._tl().totalDuration - 1e-6) {
      for (var k = 0; k < texts.length; k++) {
        var tx2 = texts[k];
        if (visible.indexOf(tx2) < 0 && Math.abs(tx2.end - t) < 1e-3 && t >= tx2.start) visible.push(tx2);
      }
    }
    var box = App.getBoxSize();
    var sig = box.boxW + 'x' + box.boxH + '|' + visible.map(function (x) { return x.id; }).join(',');
    if (sig === this._lastSig && !this._forceTextRefresh) {
      // 纯播放、集合未变也不强制刷新：跳过 DOM 重建（编辑时由 _forceTextRefresh 强制）
      return;
    }
    this._lastSig = sig;
    this._forceTextRefresh = false;
    this.overlay.innerHTML = '';
    for (var m = 0; m < visible.length; m++) {
      this.overlay.appendChild(buildTextNode(visible[m], box.boxW, box.boxH));
    }
    // 通知 overlay.js：DOM 重建后需要重新接上编辑能力（事件用委托，无需额外）
    bus.emit('overlay:rendered', { ids: visible.map(function (x) { return x.id; }) });
  };

  /* ---------- UI 回调 ---------- */
  PreviewEngine.prototype._onTimeUpdate = function (ph, total) {
    bus.emit('time:update', ph);
    var lbl = document.getElementById('lblTimecode');
    if (lbl) lbl.textContent = App.fmtTime(ph) + ' / ' + App.fmtTime(total);
  };
  PreviewEngine.prototype._onPlayState = function (p) {
    var btn = document.getElementById('btnPlayPause');
    if (btn) btn.textContent = p ? '❚❚' : '▶';
    bus.emit(p ? 'play' : 'pause', {});
  };

  PreviewEngine.prototype.dispose = function () {
    this.pause();
    this.v.removeEventListener('loadeddata', this._onLoaded);
    this.v.removeEventListener('seeked', this._onSeeked);
    this.v.removeEventListener('ended', this._onEnded);
    this.v.removeEventListener('error', this._onError);
  };

  /* ===================================================================== *
   * 初始化
   * ===================================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    var video = document.getElementById('video');
    var overlay = document.getElementById('overlayLayer');
    video.muted = true;            // 预览静音；导出才管音频
    video.controls = false;
    video.playsInline = true;

    var engine = new PreviewEngine(video, overlay);
    App.engine = engine;

    // 初次布局
    layoutVideoBox();

    // seek 事件（来自时间轴/进度滑块）
    bus.on('seek', function (tOut) { engine.seekTimeline(tOut); });

    // clips 变化：按 engine.md §5 onProjectMutated 重新对齐
    bus.on('clips:changed', function () {
      App.rebuildTimeline();
      var tl = App.getTimeline();
      if (engine.playhead > tl.totalDuration) engine.playhead = tl.totalDuration;
      engine.curIndex = -1;
      engine._curSrcId_pending = engine._curSrcId; // 记忆
      engine._forceTextRefresh = true;
      if (tl.totalDuration <= 0) {
        engine.playing && engine.pause();
        engine._curSrcId = null;
        engine.playhead = 0;
      }
      engine._jumpToTimeline(engine.playhead, false);
    });

    // 源/输出比例变化 -> 重排盒子 + 强制刷新文字
    bus.on('output:changed', function () {
      layoutVideoBox();
      engine._forceTextRefresh = true;
      engine.renderTextsNow();
    });
    bus.on('sources:changed', function () { layoutVideoBox(); });

    // 文字变化（内容/样式/位置）-> 强制刷新当前帧
    bus.on('texts:changed', function () {
      engine._forceTextRefresh = true;
      engine.renderTextsNow();
    });
    // 选中态变化 -> 重画以更新 .selected
    bus.on('text:selected', function () {
      engine._forceTextRefresh = true;
      engine.renderTextsNow();
    });

    // 窗口 resize
    window.addEventListener('resize', function () {
      layoutVideoBox();
      engine._forceTextRefresh = true;
      engine.renderTextsNow();
    });

    // 暴露 layout 供其它模块用
    App.layoutVideoBox = layoutVideoBox;
  });

})();
