/* =========================================================================
 * timeline.js — v2 多轨时间轴（渲染 + 交互）
 *
 * 权威依据：_build/contract_v2.md（数据模型 §1 / App API §3.2 / bus §3.1 /
 *           DOM id §4.5 / 坐标 §5.4 / 语义 §6 / 快捷键 §7）。
 *           设计参考：_build/timeline_v2.md。
 *
 * 职责（纯视图 + 交互层，绝不直接改 project）：
 *   - 多轨渲染：轨道头（名/静音/音量/隐藏/锁/删除），顶层轨画在最上一行；
 *     刻度尺 + 播放头；各轨道行 .track-row；片段块 .clip / .text-clip 绝对定位。
 *   - 交互：选中、拖动移动（可跨同类型轨，改 start）、两端 edge-trim（改 in/out/start，
 *     不越源界）、磁吸（片段边 / 播放头 / 0 点，按住 Alt 临时关）、播放头分割、
 *     删除 / 波纹删除、时间轴缩放（pxPerSec：+/- 与 Ctrl+滚轮）、横向滚动、
 *     点击 / 拖动刻度尺 seek、+轨道（视频/文字）、从素材库拖拽生成片段、
 *     OS 文件拖入窗口上传入库。
 *   - 撤销栈遵循 contract_v2 §6.8「一次手势=一个撤销步」：单次操作直接调 App.* mutator
 *     （由其内部压栈一次）；连续手势（片段拖动/edge-trim/音量滑块）在落地/松手时由本模块
 *     显式 pushHistory() 一次，并对 mutator 传 {noHistory:true} 避免双压。
 *
 * 与 v1 差异：放弃 HTML5 draggable 重排 / flex 百分比块宽，统一改用 pointer 事件
 *             + 绝对像素定位（left=start*pxPerSec, width=dur*pxPerSec）。
 * ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  var bus = App.bus;

  /* ---------- 常量（contract_v2 §6.1 / §3 / §5.4） ---------- */
  var pxPerSec = 80;            // 缩放因子（contract §5.4 默认 80）
  var PX_MIN = 10, PX_MAX = 400; // 缩放范围（contract §7）
  var TRACK_H = 56;             // 轨道行高
  var MIN_PX = 6;               // 片段最小可点像素宽
  var SNAP_PX = 8;              // 磁吸命中阈值（屏幕像素，恒定手感）
  var RULER_TARGET_PX = 90;     // 刻度主格目标像素间距
  var RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

  /* ---------- DOM 句柄（解析时容错 contract 权威 id 与 timeline_v2 草案 id） ---------- */
  var elPanel, elScroll, elRuler, elHeads, elArea, elLanes, elPlayhead, elSnap, elTotalDur, elDrop;
  var elBtnZoomIn, elBtnZoomOut, elRngZoom, elBtnAddTrack, elAddTrackMenu;
  var ready = false;

  /* 拖动状态机：{ mode, clip, track, el, startX, orig, pending, targetTrack } */
  var drag = null;
  var snapLinesCache = null;

  function $(id) { return document.getElementById(id); }
  function pick() { for (var i = 0; i < arguments.length; i++) { var e = $(arguments[i]); if (e) return e; } return null; }

  function resolveDom() {
    // contract_v2 §4.5 权威 id 优先；timeline_v2.md 草案 id 作回退
    elPanel = pick('timelinePanel');
    elScroll = pick('timelineScroll', 'tlScroll');
    elRuler = pick('timelineRuler', 'tlRuler');
    elHeads = pick('trackHeads', 'tlHeads');
    elLanes = pick('timelineLanes', 'tlLanesWrap');   // 横向滚动容器（overflow-x:auto），#tracksArea/#timelineRuler 的父
    elArea = pick('tracksArea', 'tlLanes');
    elPlayhead = pick('playhead', 'tlPlayhead');
    elSnap = pick('snapGuide', 'tlSnapGuide');
    elTotalDur = pick('lblTotalDur');
    elDrop = pick('dropOverlay', 'dropMask');
    elBtnZoomIn = pick('btnZoomIn');
    elBtnZoomOut = pick('btnZoomOut');
    elRngZoom = pick('rngZoom');
    elBtnAddTrack = pick('btnAddTrack');
    elAddTrackMenu = pick('addTrackMenu');
    return !!(elScroll && elArea && elHeads && elRuler);
  }

  /* ---------- 时间 / 像素换算（contract §5.4） ---------- */
  function timeToX(sec) { return sec * pxPerSec; }
  function xToTime(px) { return px / pxPerSec; }

  /* 时间轴横向像素原点 = #tracksArea 左缘（与 #playhead/#snapGuide/片段块的 left 同一个 0 点）。
   * 布局事实（style.css §311+ 实核）：#timelineScroll 是 flex 容器且 overflow-x:hidden，其首个
   * flex 子 #trackHeads(position:sticky;left:0) 占据左侧 var(--head-w) 宽；真正的横向滚动发生在
   * #timelineLanes(overflow-x:auto) 上。#tracksArea 在 #timelineLanes 内、随其一起平移，所以
   * elArea.getBoundingClientRect().left 已经包含了横向滚动量——X→time 只需 (clientX - laneOriginX())，
   * 绝不可再叠加任何 scrollLeft，更不可用 #timelineScroll 的 rect（会整体偏移一个轨道头列宽，导致
   * 播放头/落点与刻度、片段错位）。 */
  function laneOriginX() {
    var ref = elArea || elLanes || elScroll;
    return ref ? ref.getBoundingClientRect().left : 0;
  }
  // 屏幕 clientX → 时间轴绝对秒（>=0），统一入口
  function clientXToTime(clientX) { return Math.max(0, xToTime(clientX - laneOriginX())); }

  function clamp(v, a, b) { return (App.clamp ? App.clamp(v, a, b) : Math.min(b, Math.max(a, v))); }
  function fmt(s) { return (App.fmtTime ? App.fmtTime(s) : ('' + (Math.round(s * 10) / 10))); }

  /* ---------- 读 project / playhead（容错 contract 代理与 engine 真值） ---------- */
  function project() { return App.getProject ? App.getProject() : App.project; }
  function tracks() { var p = project(); return (p && p.tracks) || []; }
  function fps() { var p = project(); return (p && p.output && p.output.fps) || 30; }

  function playhead() {
    if (typeof App.getPlayhead === 'function') return App.getPlayhead() || 0;
    if (App.engine && typeof App.engine.playhead === 'number') return App.engine.playhead;
    return 0;
  }
  function totalDuration() {
    if (typeof App.getTimeline === 'function') { var t = App.getTimeline(); if (t && typeof t.totalDuration === 'number') return t.totalDuration; }
    if (typeof App.totalDuration === 'function') return App.totalDuration();
    // 兜底自算
    var max = 0;
    tracks().forEach(function (tr) { tr.clips.forEach(function (c) { var e = c.start + clipDur(c, tr); if (e > max) max = e; }); });
    return max;
  }
  function minClipLen() { return Math.max(1 / fps(), 0.04); }

  /* ---------- 查找工具 ---------- */
  function findTrack(trackId) { var a = tracks(); for (var i = 0; i < a.length; i++) if (a[i].id === trackId) return a[i]; return null; }
  function findClipInTrack(track, clipId) { if (!track) return null; for (var i = 0; i < track.clips.length; i++) if (track.clips[i].id === clipId) return track.clips[i]; return null; }
  function locateClip(clipId) {
    var a = tracks();
    for (var i = 0; i < a.length; i++) { var c = findClipInTrack(a[i], clipId); if (c) return { track: a[i], clip: c }; }
    return null;
  }
  function clipDur(clip, track) {
    if (track && track.kind === 'text') return clip.duration || 0;
    if (clip.duration != null && clip.out == null) return clip.duration; // 文字片段
    return (clip.out || 0) - (clip.in || 0);
  }

  /* ---------- 选中态读取（容错 contract getSelection 与 v1 selectedClipId） ---------- */
  function selectedClipId() {
    if (typeof App.getSelection === 'function') {
      var s = App.getSelection();
      if (s && (s.kind === 'clip' || s.kind === 'text')) return s.clipId;
      return null;
    }
    return App.selectedClipId || null;
  }

  /* =======================================================================
   * 渲染
   * ===================================================================== */
  function contentWidth() {
    var viewSec = elScroll ? (elScroll.clientWidth / pxPerSec) : 10;
    var total = totalDuration();
    return Math.max(timeToX(Math.max(total, viewSec)) + pxPerSec * 2, 200); // 末尾留白可拖
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function iconBtn(cls, label, action, title) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.dataset.action = action;
    if (title) b.title = title;
    return b;
  }

  function renderAll() {
    if (!ready) return;
    renderHeads();
    renderTracks();
    renderRuler();
    updatePlayhead(playhead());
    refreshToolbar();
  }

  /* 4.1 轨道头（左列）——顶层在第一行（数组末尾先画） */
  function renderHeads() {
    var tr = tracks(), frag = document.createDocumentFragment();
    for (var i = tr.length - 1; i >= 0; i--) {
      var t = tr[i];
      var h = el('div', 'track-head ' + t.kind + (t.locked ? ' locked' : '') + (t.hidden ? ' hidden' : ''));
      h.dataset.trackId = t.id;
      h.style.height = TRACK_H + 'px';

      var name = el('span', 'th-name', t.name || (t.kind === 'video' ? '视频轨' : '文字轨'));
      name.title = '双击重命名';
      h.appendChild(name);

      var ctrls = el('div', 'th-ctrls');
      if (t.kind === 'video') {
        ctrls.appendChild(iconBtn('th-mute', t.muted ? '🔇' : '🔊', 'toggleMute', '静音'));
        var vol = el('input', 'th-volume');
        vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.01';
        vol.value = (t.volume == null ? 1 : t.volume);
        vol.title = '音量';
        vol.dataset.trackId = t.id;
        ctrls.appendChild(vol);
      }
      ctrls.appendChild(iconBtn('th-hide', t.hidden ? '🙈' : '👁', 'toggleHidden', '隐藏'));
      ctrls.appendChild(iconBtn('th-lock', t.locked ? '🔒' : '🔓', 'toggleLock', '锁定'));
      ctrls.appendChild(iconBtn('th-del', '🗑', 'removeTrack', '删除轨道'));
      h.appendChild(ctrls);
      frag.appendChild(h);
    }
    elHeads.replaceChildren(frag);
  }

  /* 4.2 轨道行 + 片段 */
  function renderTracks() {
    var tr = tracks(), cw = contentWidth();
    elArea.style.height = (tr.length * TRACK_H) + 'px';
    elArea.style.width = cw + 'px';
    if (elRuler) elRuler.style.width = cw + 'px';

    var frag = document.createDocumentFragment();
    for (var i = tr.length - 1; i >= 0; i--) {
      var t = tr[i], row = (tr.length - 1) - i;
      var lane = el('div', 'track-row ' + t.kind + (t.locked ? ' locked' : '') + (t.hidden ? ' hidden' : ''));
      lane.dataset.trackId = t.id;
      lane.dataset.kind = t.kind;
      lane.style.top = (row * TRACK_H) + 'px';
      lane.style.height = TRACK_H + 'px';
      lane.style.width = cw + 'px';
      (function (track) {
        track.clips.forEach(function (c) { lane.appendChild(renderClip(c, track)); });
      })(t);
      frag.appendChild(lane);
    }
    // #playhead / #snapGuide 是 #tracksArea 的静态子节点（index.html），
    // replaceChildren 会一并清除它们；故先把它们并入本次片段，确保渲染后仍挂在
    // #tracksArea 内（保持与片段同一坐标系：left=time*pxPerSec，height=轨道总高）。
    if (elPlayhead && elPlayhead.parentNode !== frag) frag.appendChild(elPlayhead);
    if (elSnap && elSnap.parentNode !== frag) frag.appendChild(elSnap);
    elArea.replaceChildren(frag);
    if (elPlayhead) { elPlayhead.style.height = (tr.length * TRACK_H) + 'px'; }
    if (elSnap) { elSnap.style.height = (tr.length * TRACK_H) + 'px'; }
  }

  /* 4.3 单个片段块 */
  function renderClip(clip, track) {
    var dur = clipDur(clip, track);
    var isText = (track.kind === 'text');
    var c = el('div', (isText ? 'text-clip' : 'clip') + ' ' + track.kind);
    c.dataset.clipId = clip.id;
    c.dataset.trackId = track.id;
    c.style.left = timeToX(clip.start) + 'px';
    c.style.width = Math.max(MIN_PX, timeToX(dur)) + 'px';
    if (clip.id === selectedClipId()) c.classList.add('selected');

    if (isText) {
      c.appendChild(el('span', 'tc-label clip-label', (clip.content || '文字').replace(/\n/g, ' ').slice(0, 24)));
    } else {
      var m = App.getMedia ? App.getMedia(clip.mediaId) : null;
      if (m && m.thumbUrl) c.style.backgroundImage = 'url("' + m.thumbUrl + '")';
      c.appendChild(el('span', 'clip-label', m ? m.name : '片段'));
      var thumb = el('div', 'clip-thumb');
      c.appendChild(thumb);
    }
    c.appendChild(el('div', 'clip-trim left'));
    c.appendChild(el('div', 'clip-trim right'));
    c.appendChild(el('div', 'clip-label-dur', fmt(dur)));
    return c;
  }

  /* 4.4 刻度尺（按 pxPerSec 选档；主刻度标时间码） */
  function renderRuler() {
    if (!elRuler) return;
    elRuler.replaceChildren();
    var cw = contentWidth();
    var rawSec = RULER_TARGET_PX / pxPerSec;
    var step = RULER_STEPS[RULER_STEPS.length - 1];
    for (var s = 0; s < RULER_STEPS.length; s++) { if (RULER_STEPS[s] >= rawSec) { step = RULER_STEPS[s]; break; } }
    var totalSec = cw / pxPerSec;
    var frag = document.createDocumentFragment();
    for (var t = 0; t <= totalSec + 1e-6; t += step) {
      var tick = el('div', 'tl-tick');
      tick.style.left = timeToX(t) + 'px';
      tick.appendChild(el('span', 'tl-tick-label', fmt(t)));
      frag.appendChild(tick);
    }
    elRuler.appendChild(frag);
  }

  /* ---------- 播放头 ---------- */
  function updatePlayhead(t) {
    if (!elPlayhead) return;
    var x = timeToX(t);
    elPlayhead.style.left = x + 'px';
    // 自动滚动跟随：横向滚动发生在 #timelineLanes（overflow-x:auto），而非 overflow-x:hidden 的 #timelineScroll
    var sc = elLanes || elScroll; if (!sc) return;
    var L = sc.scrollLeft, R = L + sc.clientWidth;
    if (x < L + 20 || x > R - 20) sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.5);
  }

  function refreshToolbar() {
    var hasSel = !!selectedClipId();
    [['btnSplit', !hasSel], ['btnDeleteClip', !hasSel], ['btnRippleDelete', !hasSel],
     ['btnSplitClip', !hasSel], ['btnDeleteClip', !hasSel]].forEach(function (p) {
      var b = $(p[0]); if (b) b.disabled = p[1];
    });
    if (App.canUndo) { var u = pick('btnUndo', 'btnTlUndo'); if (u) u.disabled = !App.canUndo(); }
    if (App.canRedo) { var r = pick('btnRedo', 'btnTlRedo'); if (r) r.disabled = !App.canRedo(); }
    if (elTotalDur) elTotalDur.textContent = fmt(totalDuration());
    if (elRngZoom) elRngZoom.value = pxPerSec;
  }

  /* =======================================================================
   * 磁吸（contract §6.2 / timeline_v2 §6）
   * ===================================================================== */
  function buildSnapLines(excludeClipId) {
    var lines = [0, playhead()];
    tracks().forEach(function (t) {
      t.clips.forEach(function (c) {
        if (c.id === excludeClipId) return;
        var d = clipDur(c, t);
        lines.push(c.start, c.start + d);
      });
    });
    return lines;
  }

  // move：左右缘均尝试吸附，取像素距离最近者；返回吸附后的 start（>=0），并显示 guide
  function snapStart(newStart, dur, excludeId) {
    var lines = snapLinesCache || buildSnapLines(excludeId);
    var best = null, bestPx = SNAP_PX + 1, guideAt = null;
    var leftX = timeToX(newStart), rightX = timeToX(newStart + dur);
    lines.forEach(function (L) {
      var lx = timeToX(L);
      var dL = Math.abs(leftX - lx);
      if (dL < bestPx) { bestPx = dL; best = L; guideAt = L; }
      var dR = Math.abs(rightX - lx);
      if (dR < bestPx) { bestPx = dR; best = L - dur; guideAt = L; }
    });
    if (best != null) { showSnapGuide(guideAt); return Math.max(0, best); }
    hideSnapGuide(); return newStart;
  }

  // trim：只吸被拖的那条边缘
  function snapEdge(edgeTime, excludeId) {
    var lines = snapLinesCache || buildSnapLines(excludeId);
    var best = null, bestPx = SNAP_PX + 1;
    var ex = timeToX(edgeTime);
    lines.forEach(function (L) { var d = Math.abs(ex - timeToX(L)); if (d < bestPx) { bestPx = d; best = L; } });
    if (best != null) { showSnapGuide(best); return { hit: true, value: best }; }
    hideSnapGuide(); return { hit: false, value: edgeTime };
  }

  function showSnapGuide(t) { if (!elSnap) return; elSnap.style.left = timeToX(t) + 'px'; elSnap.hidden = false; elSnap.style.display = ''; }
  function hideSnapGuide() { if (!elSnap) return; elSnap.hidden = true; elSnap.style.display = 'none'; }

  /* =======================================================================
   * 片段交互：选中 / move（跨轨）/ edge-trim（pointer 事件）
   * ===================================================================== */
  function bindLaneEvents() {
    elArea.addEventListener('pointerdown', onLanePointerDown);
    elArea.addEventListener('pointermove', onLanePointerMove);
    ['pointerup', 'pointercancel'].forEach(function (ev) { elArea.addEventListener(ev, onLanePointerUp); });

    // 空白处点击：取消选中 + 定位播放头
    elArea.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.clip') || e.target.closest('.text-clip')) return;
      doClearSelection();
      startScrub(e);
    });
  }

  function onLanePointerDown(e) {
    var clipEl = e.target.closest('.clip') || e.target.closest('.text-clip');
    if (!clipEl) return;
    var track = findTrack(clipEl.dataset.trackId);
    var clip = findClipInTrack(track, clipEl.dataset.clipId);
    if (!track || !clip) return;
    if (track.locked) { App.toast && App.toast('该轨道已锁定', 'info'); return; }

    doSelectClip(track.id, clip.id);

    var trimSide = e.target.classList && e.target.classList.contains('clip-trim')
      ? (e.target.classList.contains('left') ? 'left' : 'right') : null;

    // 一次手势 = 一个撤销步（contract_v2 §6.8）。
    // 不在 pointerdown 预压历史（避免“仅点击未移动”残留空撤销步，见静态审查 medium）；
    // 拖动期间只改 DOM 样式做视觉预览、不调 mutator；
    // pointerup 落地时 commitDrag() 显式 pushHistory 一次，再调 mutator（传 noHistory:true）。
    drag = {
      mode: trimSide ? ('trim-' + trimSide) : 'move',
      clip: clip, track: track, el: clipEl,
      startX: e.clientX,
      orig: { start: clip.start, in: clip.in, out: clip.out, duration: clip.duration },
      targetTrack: track,
      pending: null,
      moved: false
    };
    snapLinesCache = buildSnapLines(clip.id);
    try { clipEl.setPointerCapture(e.pointerId); } catch (x) {}
    clipEl.classList.add('dragging');
    e.preventDefault();
    e.stopPropagation();
  }

  function onLanePointerMove(e) {
    if (!drag) return;
    var dxSec = xToTime(e.clientX - drag.startX);
    if (Math.abs(e.clientX - drag.startX) > 2) drag.moved = true;
    var snapOff = e.altKey; // 实时读 Alt：拖动中可临时关吸附
    if (drag.mode === 'move') doMove(e, dxSec, snapOff);
    else doTrim(e, dxSec, snapOff, drag.mode === 'trim-left');
  }

  function onLanePointerUp() {
    if (!drag) return;
    drag.el.classList.remove('dragging');
    hideSnapGuide();
    commitDrag();
    drag = null;
    snapLinesCache = null;
  }

  /* move（含跨轨）—— 仅视觉更新，松手才落数据 */
  function doMove(e, dxSec, snapOff) {
    var dur = clipDur(drag.clip, drag.track);
    var newStart = Math.max(0, drag.orig.start + dxSec);

    // 跨轨：按鼠标 Y 命中的 lane 决定目标轨，kind 必须匹配且未锁
    var targetTrack = drag.track;
    var stack = (document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : []);
    for (var i = 0; i < stack.length; i++) {
      var n = stack[i];
      if (n.classList && n.classList.contains('track-row')) { var tt = findTrack(n.dataset.trackId); if (tt) { targetTrack = tt; } break; }
    }
    if (!targetTrack || targetTrack.kind !== drag.track.kind || targetTrack.locked) targetTrack = drag.track;

    if (!snapOff) newStart = snapStart(newStart, dur, drag.clip.id);
    else hideSnapGuide();

    drag.targetTrack = targetTrack;
    drag.pending = { start: newStart };
    drag.el.style.left = timeToX(newStart) + 'px';
    moveElToLane(drag.el, targetTrack);
  }

  function moveElToLane(clipEl, track) {
    var lane = elArea.querySelector('.track-row[data-track-id="' + cssEsc(track.id) + '"]');
    if (lane && clipEl.parentNode !== lane) lane.appendChild(clipEl);
    clipEl.dataset.trackId = track.id;
  }
  function cssEsc(s) { return ('' + s).replace(/["\\]/g, '\\$&'); }

  /* edge-trim（拖两端修剪）—— 仅视觉更新 */
  function doTrim(e, dxSec, snapOff, isLeft) {
    var o = drag.orig, track = drag.track, isText = (track.kind === 'text');
    var media = (!isText && App.getMedia) ? App.getMedia(drag.clip.mediaId) : null;
    var MIN = minClipLen();

    if (isText) {
      var dur0 = o.duration || 0;
      if (isLeft) {
        // 左缘：start += d, duration -= d；start>=0 且 duration>=MIN
        var dL = clamp(dxSec, -o.start, dur0 - MIN);
        var ns = o.start + dL;
        if (!snapOff) { var s = snapEdge(ns, drag.clip.id); if (s.hit) { dL += (s.value - ns); ns = s.value; } }
        ns = Math.max(0, ns);
        drag.pending = { start: ns, in: null, out: null, duration: o.duration - (ns - o.start) };
      } else {
        // 右缘：duration += d；duration>=MIN
        var newDur = Math.max(MIN, dur0 + dxSec);
        var ne = o.start + newDur;                          // 绝对结束时间
        if (!snapOff) { var s2 = snapEdge(ne, drag.clip.id); if (s2.hit && s2.value > o.start + MIN) ne = s2.value; }
        drag.pending = { start: o.start, in: null, out: null, duration: Math.max(MIN, ne - o.start) };
      }
      applyTrimVisual(track);
      return;
    }

    // 视频片段
    if (isLeft) {
      // 左缘随鼠标：start' = start + d, in' = in + d（保持右缘 out 不变）
      // 边界：in' >= 0 -> d >= -in；dur' = out - in' >= MIN -> d <= (out-in)-MIN
      var d = dxSec;
      var lo = -o.in, hi = (o.out - o.in) - MIN;
      d = clamp(d, lo, hi);
      var newStart = o.start + d;
      if (!snapOff) { var sl = snapEdge(newStart, drag.clip.id); if (sl.hit) { var dd = sl.value - newStart; d += dd; d = clamp(d, lo, hi); newStart = o.start + d; } }
      drag.pending = { start: Math.max(0, newStart), in: o.in + d, out: o.out };
    } else {
      // 右缘：out' = out + d；dur'>=MIN, out'<=media.duration
      var d2 = dxSec;
      var maxDur = media ? media.duration : Infinity;
      var hiR = maxDur - o.out;
      var loR = MIN - (o.out - o.in);
      d2 = clamp(d2, loR, hiR);
      var endTime = o.start + (o.out - o.in) + d2;
      if (!snapOff) { var sr = snapEdge(endTime, drag.clip.id); if (sr.hit) { var de = sr.value - endTime; d2 = clamp(d2 + de, loR, hiR); } }
      drag.pending = { start: o.start, in: o.in, out: o.out + d2 };
    }
    applyTrimVisual(track);
  }

  function applyTrimVisual(track) {
    var p = drag.pending;
    var dur = (track.kind === 'text') ? p.duration : (p.out - p.in);
    drag.el.style.left = timeToX(p.start) + 'px';
    drag.el.style.width = Math.max(MIN_PX, timeToX(dur)) + 'px';
  }

  /* 松手落数据：调 contract §3.2 mutator。
   * 约定（contract_v2 §6.8）：一次手势=一个撤销步。pointerdown 不预压历史；
   * 仅当真正发生移动（drag.moved）且落地合法时，在此显式 pushHistory() 一次，
   * 随后调 mutator 一律传 {noHistory:true}，避免双压（静态审查 critical）。
   * 仅点击未拖动 / 落位非法 → 不压栈、不调 mutator，撤销栈保持干净。 */
  function commitDrag() {
    if (!drag.moved) { return; }  // 仅点击未拖动：保留选中，不动撤销栈
    var d = drag;
    if (d.mode === 'move') {
      var dur = clipDur(d.clip, d.track);
      var resolved = resolveOverlap(d.targetTrack, d.clip.id, d.pending.start, dur, d.track);
      if (resolved == null) {
        // 无合法空位：取消移动。此前未压栈，故只需重渲让元素弹回原位（不可调 App.undo，
        // 否则会误撤销上一条无关操作）。
        App.toast && App.toast('该位置与其他片段重叠，已取消移动', 'error');
        return renderAll();
      }
      App.pushHistory();
      // contract §3.2: App.moveClip(trackId, clipId, newStartSec, newTrackId?, opts)
      var newTrackId = (d.targetTrack.id !== d.track.id) ? d.targetTrack.id : undefined;
      App.moveClip(d.track.id, d.clip.id, resolved, newTrackId, { noHistory: true });
    } else if (d.mode === 'trim-left') {
      App.pushHistory();
      // contract §3.2: App.trimClip(trackId, clipId, edge, deltaSec, opts)；in 边
      if (d.track.kind === 'text') {
        var deltaT = d.pending.start - d.orig.start;        // text：左缘平移量
        App.trimClip(d.track.id, d.clip.id, 'in', deltaT, { noHistory: true });
      } else {
        var deltaIn = d.pending.in - d.orig.in;             // video：源 in 增量（=start 增量）
        App.trimClip(d.track.id, d.clip.id, 'in', deltaIn, { noHistory: true });
      }
    } else { // trim-right
      App.pushHistory();
      if (d.track.kind === 'text') {
        var d0 = d.orig.duration || 0;
        var deltaDur = d.pending.duration - d0;
        App.trimClip(d.track.id, d.clip.id, 'out', deltaDur, { noHistory: true });
      } else {
        var deltaOut = d.pending.out - d.orig.out;
        App.trimClip(d.track.id, d.clip.id, 'out', deltaOut, { noHistory: true });
      }
    }
    // mutator 内部 emit project:changed -> renderAll
  }

  /* 防重叠（同轨）裁决（contract §6.3）：返回合法 start，或 null 表示无法放置 */
  function resolveOverlap(track, clipId, start, dur, fromTrack) {
    var others = track.clips.filter(function (c) { return c.id !== clipId; })
      .map(function (c) { return { s: c.start, e: c.start + clipDur(c, track) }; })
      .sort(function (a, b) { return a.s - b.s; });
    var end = start + dur;
    var overlaps = others.some(function (o) { return start < o.e - 1e-6 && end > o.s + 1e-6; });
    if (!overlaps) return Math.max(0, start);

    // 尝试吸附到最近的无重叠空位：紧贴邻接片段边缘
    var candidates = [0];
    others.forEach(function (o) { candidates.push(o.e); candidates.push(o.s - dur); });
    candidates = candidates.filter(function (s) { return s >= 0; });
    var best = null, bestDist = Infinity;
    candidates.forEach(function (s) {
      var e = s + dur;
      var bad = others.some(function (o) { return s < o.e - 1e-6 && e > o.s + 1e-6; });
      if (bad) return;
      var dist = Math.abs(s - start);
      if (dist < bestDist) { bestDist = dist; best = s; }
    });
    return best; // 可能为 null（无空位）
  }

  /* =======================================================================
   * 选中 / 取消选中（容错 contract 与 v1 接口）
   * ===================================================================== */
  function doSelectClip(trackId, clipId) {
    if (typeof App.selectClip === 'function' && App.selectClip.length >= 2) App.selectClip(trackId, clipId);
    else if (typeof App.selectClip === 'function') App.selectClip(clipId);
    else { App.selectedClipId = clipId; bus.emit('selection:changed', { kind: 'clip', trackId: trackId, clipId: clipId }); }
  }
  function doClearSelection() {
    if (typeof App.clearSelection === 'function') App.clearSelection();
    else if (typeof App.selectClip === 'function') { try { App.selectClip(null); } catch (x) {} }
    else { App.selectedClipId = null; bus.emit('selection:changed', { kind: null }); }
  }

  /* =======================================================================
   * 轨道头交互（事件委托）
   * ===================================================================== */
  function bindHeadEvents() {
    elHeads.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      var headEl = e.target.closest('.track-head');
      if (!headEl) return;
      var track = findTrack(headEl.dataset.trackId);
      if (!track) return;
      if (!btn) { selectTrack(track.id); return; }

      var action = btn.dataset.action;
      // 注意：App.removeTrack / App.setTrackProp 内部各自 pushHistory（§3.2 / app.js 实核）。
      // 此处一律不再显式 pushHistory，否则双压（多一步空撤销）。统一依赖 mutator 内部单次压栈。
      if (action === 'removeTrack') {
        var hasClips = track.clips && track.clips.length;
        if (hasClips && !window.confirm('该轨道含 ' + track.clips.length + ' 个片段，确认删除整条轨道？')) return;
        App.removeTrack(track.id);
        return;
      }
      if (action === 'toggleMute') setTrackProp(track.id, 'muted', !track.muted);
      else if (action === 'toggleHidden') setTrackProp(track.id, 'hidden', !track.hidden);
      else if (action === 'toggleLock') setTrackProp(track.id, 'locked', !track.locked);
    });

    // 音量滑块：一次拖动手势 = 一个撤销步（contract_v2 §6.8 连续微调合并）。
    // pointerdown 压一次历史；input 期间经 App.setTrackProp(...,{noHistory:true}) 落地（不再压栈），
    // change（松手）复位标记。键盘改值无 pointerdown 时，首个 input 补压一次。
    var volPushed = false;
    elHeads.addEventListener('pointerdown', function (e) {
      if (e.target.classList && e.target.classList.contains('th-volume') && !volPushed) {
        App.pushHistory(); volPushed = true;
      }
    });
    elHeads.addEventListener('input', function (e) {
      if (e.target.classList && e.target.classList.contains('th-volume')) {
        var tid = e.target.dataset.trackId;
        if (!volPushed) { App.pushHistory(); volPushed = true; }
        setTrackProp(tid, 'volume', parseFloat(e.target.value), { noHistory: true });
      }
    });
    elHeads.addEventListener('change', function (e) {
      if (e.target.classList && e.target.classList.contains('th-volume')) volPushed = false;
    });

    // 双击轨道名重命名（App.setTrackProp 内部 pushHistory，不再显式压栈）
    elHeads.addEventListener('dblclick', function (e) {
      var nameEl = e.target.closest('.th-name');
      var headEl = e.target.closest('.track-head');
      if (!nameEl || !headEl) return;
      var track = findTrack(headEl.dataset.trackId);
      if (!track) return;
      var nv = window.prompt('重命名轨道', track.name || '');
      if (nv != null && nv !== track.name) setTrackProp(track.id, 'name', nv);
    });
  }

  function setTrackProp(trackId, key, value, opts) {
    // contract §3.2: App.setTrackProp(trackId, key, value, opts)（默认内部单次 pushHistory；
    // 传 {noHistory:true} 时由调用方负责压栈，用于连续拖动合并为一步）。
    App.setTrackProp(trackId, key, value, opts);
  }
  function selectTrack(trackId) {
    if (typeof App.selectTrack === 'function') App.selectTrack(trackId);
    else bus.emit('selection:changed', { kind: 'track', trackId: trackId });
  }

  /* =======================================================================
   * +轨道（视频 / 文字）
   * ===================================================================== */
  function bindAddTrack() {
    if (!elBtnAddTrack) return;
    elBtnAddTrack.addEventListener('click', function (e) {
      e.stopPropagation();
      if (elAddTrackMenu) {
        var open = elAddTrackMenu.hidden === false || elAddTrackMenu.classList.contains('open');
        if (open) closeAddTrackMenu(); else openAddTrackMenu();
      } else {
        // 无菜单容器时退化为 confirm 选择
        var kind = window.confirm('确定新增视频轨？（取消 = 新增文字轨）') ? 'video' : 'text';
        onAddTrack(kind);
      }
    });
    if (elAddTrackMenu) {
      elAddTrackMenu.addEventListener('click', function (e) {
        var item = e.target.closest('[data-kind]');
        if (!item) return;
        onAddTrack(item.dataset.kind === 'text' ? 'text' : 'video');
        closeAddTrackMenu();
      });
      document.addEventListener('click', function () { closeAddTrackMenu(); });
    }
  }
  function openAddTrackMenu() { if (!elAddTrackMenu) return; elAddTrackMenu.hidden = false; elAddTrackMenu.classList.add('open'); }
  function closeAddTrackMenu() { if (!elAddTrackMenu) return; elAddTrackMenu.hidden = true; elAddTrackMenu.classList.remove('open'); }
  function onAddTrack(kind) {
    // 单次压栈由 App.addTrack 内部完成（§3.2 / §6.8）；此处不得再 pushHistory，否则双压。
    App.addTrack(kind); // 默认插到顶层（数组末尾），画在第一行
  }

  /* =======================================================================
   * 从素材库拖入轨道（dropFromBin）—— HTML5 drag
   * ===================================================================== */
  var insertCueEl = null;
  function bindBinDrop() {
    elArea.addEventListener('dragover', function (e) {
      if (!hasMediaId(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      var lane = e.target.closest('.track-row');
      if (lane) {
        var track = findTrack(lane.dataset.trackId);
        if (track && track.kind === 'video' && !track.locked) {
          showInsertCue(lane, dropTimeAt(e.clientX, e.altKey, 0));
          return;
        }
      }
      hideInsertCue();
    });
    elArea.addEventListener('dragleave', function (e) { if (e.target === elArea) hideInsertCue(); });
    elArea.addEventListener('drop', function (e) {
      var mediaId = getMediaId(e);
      if (!mediaId) return;
      e.preventDefault();
      hideInsertCue();
      var lane = e.target.closest('.track-row');
      if (!lane) return;
      var track = findTrack(lane.dataset.trackId);
      if (!track || track.kind !== 'video' || track.locked) { App.toast && App.toast('请拖到未锁定的视频轨', 'error'); return; }
      var media = App.getMedia ? App.getMedia(mediaId) : null;
      var dur = media ? (media.duration || 0) : 0;
      var startSec = dropTimeAt(e.clientX, e.altKey, dur);
      // 防重叠
      var resolved = resolveOverlap(track, '__new__', startSec, dur, track);
      if (resolved == null) { App.toast && App.toast('该位置放不下整段，请换位置', 'error'); return; }
      // 单次压栈由 addClipFromMedia 内部完成（§3.2）；此处不得再 pushHistory，否则双压（多一步撤销）。
      // 传 resolved 为最终落点；addClipFromMedia 不再重复磁吸（其默认 in/out + contain 变换见 app.js）。
      var clipId = App.addClipFromMedia(mediaId, track.id, resolved, { noHistory: false });
      if (clipId) doSelectClip(track.id, (typeof clipId === 'object' ? clipId.id : clipId));
    });
  }
  function hasMediaId(e) {
    var ty = e.dataTransfer && e.dataTransfer.types;
    if (!ty) return false;
    for (var i = 0; i < ty.length; i++) if (ty[i] === 'application/x-mediaid' || ty[i] === 'text/x-mediaid') return true;
    return false;
  }
  function getMediaId(e) {
    if (!e.dataTransfer) return '';
    return e.dataTransfer.getData('application/x-mediaid') || e.dataTransfer.getData('text/x-mediaid') || '';
  }
  function dropTimeAt(clientX, altKey, dur) {
    var t = clientXToTime(clientX);   // 以 #tracksArea 左缘为原点（含滚动），与片段/播放头同 0 点
    if (altKey) return t;
    snapLinesCache = buildSnapLines('__new__');
    var snapped = snapStart(t, dur || 0, '__new__');
    snapLinesCache = null;
    return Math.max(0, snapped);
  }
  function showInsertCue(lane, t) {
    // class 必须用 style.css 已定义的 .drop-cue（§466），否则元素无尺寸/背景不可见
    if (!insertCueEl) { insertCueEl = el('div', 'drop-cue'); insertCueEl.hidden = true; elArea.appendChild(insertCueEl); }
    if (insertCueEl.parentNode !== elArea) elArea.appendChild(insertCueEl);
    insertCueEl.style.left = timeToX(t) + 'px';
    insertCueEl.style.top = lane.style.top;
    insertCueEl.style.height = TRACK_H + 'px';
    insertCueEl.hidden = false;
  }
  function hideInsertCue() { if (insertCueEl) insertCueEl.hidden = true; }

  /* =======================================================================
   * OS 文件拖入窗口（上传入库）—— contract §2.7 /api/upload，§4.7 #dropOverlay
   * ===================================================================== */
  function bindOsFileDrop() {
    var depth = 0;
    function showDrop(msg) {
      if (!elDrop) return;
      elDrop.hidden = false; elDrop.style.display = '';
      if (msg) { var inner = elDrop.querySelector('.do-inner, .dm-inner, .drop-inner'); if (inner) inner.textContent = msg; }
    }
    function hideDrop() { if (elDrop) { elDrop.hidden = true; elDrop.style.display = 'none'; } }

    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return; depth++; showDrop('松开以导入视频到素材库'); e.preventDefault();
    });
    window.addEventListener('dragover', function (e) {
      if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }
    });
    window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; hideDrop(); } });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; hideDrop();
      var files = [].filter.call(e.dataTransfer.files, function (f) { return /\.(mp4|mov|m4v|mkv|webm)$/i.test(f.name); });
      if (!files.length) { App.toast && App.toast('请拖入 mp4 视频文件', 'error'); return; }
      uploadSequential(files, 0, showDrop, hideDrop);
    });
  }
  function uploadSequential(files, i, showDrop, hideDrop) {
    if (i >= files.length) { hideDrop(); App.toast && App.toast('已导入 ' + files.length + ' 个视频到素材库', 'ok'); return; }
    showDrop('上传中 ' + (i + 1) + '/' + files.length + ' …');
    var done = function () { uploadSequential(files, i + 1, showDrop, hideDrop); };
    // 优先用 contract App.importViaUpload(File)；否则直接 POST /api/upload
    if (typeof App.importViaUpload === 'function') {
      App.importViaUpload(files[i]).then(done).catch(function (err) {
        App.toast && App.toast('上传失败：' + (err && err.message || err), 'error'); done();
      });
    } else {
      var fd = new FormData(); fd.append('file', files[i], files[i].name);
      fetch('/api/upload', { method: 'POST', body: fd }).then(function (r) { return r.json(); })
        .then(function (res) {
          var m = res && (res.media || (res.length ? res[0] : null));
          if (m && App.addMedia) { App.addMedia(m); }
          done();
        }).catch(function (err) { App.toast && App.toast('上传失败：' + (err && err.message || err), 'error'); done(); });
    }
  }
  function hasFiles(e) {
    var ty = e.dataTransfer && e.dataTransfer.types;
    if (!ty) return false;
    return [].indexOf.call(ty, 'Files') >= 0;
  }

  /* =======================================================================
   * 刻度尺 / 播放头拖动 seek
   * ===================================================================== */
  function startScrub(e) {
    function seekAt(cx) {
      doSeek(clientXToTime(cx));  // 以 #tracksArea 左缘为原点（含滚动），与刻度/片段/播放头同 0 点
    }
    seekAt(e.clientX);
    function mv(ev) { seekAt(ev.clientX); }
    function up() { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); }
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  }
  function doSeek(t) {
    if (typeof App.seek === 'function') App.seek(t);
    else bus.emit('seek', t);
  }
  function bindRuler() {
    if (!elRuler) return;
    elRuler.addEventListener('pointerdown', function (e) { e.preventDefault(); startScrub(e); });
  }

  /* =======================================================================
   * 缩放（Ctrl+滚轮锚点保持 / rngZoom / +- 按钮 / shortcuts 的 tl:zoom）
   * ===================================================================== */
  function setZoom(next, anchorT, anchorClientX) {
    next = clamp(next, PX_MIN, PX_MAX);
    if (next === pxPerSec) return;
    // 横向滚动容器是 #timelineLanes（overflow-x:auto）；#timelineScroll 是 overflow-x:hidden（scrollLeft 恒 0）。
    var sc = elLanes || elScroll;
    if (anchorT == null) {
      // 缺省锚 = lane 视口横向中心；锚时间统一用 laneOriginX 原点（已含滚动），与片段/播放头一致
      anchorClientX = laneOriginX() + sc.clientWidth / 2;
      anchorT = clientXToTime(anchorClientX);
    }
    pxPerSec = next;
    if (elRngZoom) elRngZoom.value = pxPerSec;
    renderAll();
    // 保持锚点屏幕位置不变：新 scrollLeft = 锚的新像素位置 - 锚屏幕 X 相对 lane 视口左缘的偏移
    var laneLeft = sc.getBoundingClientRect().left;
    sc.scrollLeft = Math.max(0, timeToX(anchorT) - ((anchorClientX || laneLeft) - laneLeft));
    bus.emit('zoom:changed', { pxPerSec: pxPerSec });
  }
  function zoomStep(dir, anchorT, anchorClientX) {
    setZoom(pxPerSec * (dir > 0 ? 1.25 : 1 / 1.25), anchorT, anchorClientX);
  }
  function bindZoom() {
    if (elBtnZoomIn) elBtnZoomIn.addEventListener('click', function () { zoomStep(+1); });
    if (elBtnZoomOut) elBtnZoomOut.addEventListener('click', function () { zoomStep(-1); });
    if (elRngZoom) {
      elRngZoom.min = PX_MIN; elRngZoom.max = PX_MAX; elRngZoom.value = pxPerSec;
      elRngZoom.addEventListener('input', function () { setZoom(parseFloat(elRngZoom.value) || pxPerSec); });
    }
    if (!elScroll) return;
    var sc = elLanes || elScroll;   // 横向真正滚动的容器
    // Ctrl+滚轮缩放（以鼠标为锚）——锚时间用统一原点（laneOriginX，含滚动），不再用 #timelineScroll 的 rect/scrollLeft
    elScroll.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      var anchorT = clientXToTime(e.clientX);
      zoomStep(e.deltaY < 0 ? +1 : -1, anchorT, e.clientX);
    }, { passive: false });
    // 普通纵向滚轮 → 横向滚动（浏览长时间轴）——写到 #timelineLanes（真正可横向滚动者）
    elScroll.addEventListener('wheel', function (e) {
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { sc.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
  }

  /* =======================================================================
   * bus 接线 + 初始化
   * ===================================================================== */
  function bindBus() {
    bus.on('project:changed', renderAll);
    bus.on('tracks:changed', function () { renderHeads(); renderTracks(); refreshToolbar(); });
    bus.on('clips:changed', renderAll);   // 兼容草案事件名
    bus.on('selection:changed', onSelectionChanged);
    bus.on('time:update', function (p) { updatePlayhead(p && typeof p.t === 'number' ? p.t : (typeof p === 'number' ? p : playhead())); });
    bus.on('zoom:changed', function () { /* 自身触发，避免回环 */ });
    bus.on('output:changed', function () { renderRuler(); });
    // shortcuts.js 解耦缩放（contract §11 / timeline_v2 §11）
    bus.on('tl:zoom', function (dir) { zoomStep(dir > 0 ? +1 : -1); });
  }

  function onSelectionChanged(p) {
    // 只更新高亮，不全量重渲（性能）
    var id = p && (p.clipId || (p.kind === null ? null : null));
    if (typeof App.getSelection === 'function') { var s = App.getSelection(); id = s && (s.kind === 'clip' || s.kind === 'text') ? s.clipId : null; }
    var els = elArea.querySelectorAll('.clip.selected, .text-clip.selected');
    els.forEach(function (e) { e.classList.remove('selected'); });
    if (id) {
      var sel = elArea.querySelector('.clip[data-clip-id="' + cssEsc(id) + '"], .text-clip[data-clip-id="' + cssEsc(id) + '"]');
      if (sel) sel.classList.add('selected');
    }
    refreshToolbar();
  }

  function init() {
    if (!resolveDom()) {
      console.warn('[timeline] 时间轴 DOM 未就绪（缺少 #timelineScroll/#tracksArea/#trackHeads/#timelineRuler）');
      return;
    }
    ready = true;
    if (elRngZoom) { elRngZoom.min = PX_MIN; elRngZoom.max = PX_MAX; }
    bindLaneEvents();
    bindHeadEvents();
    bindRuler();
    bindZoom();
    bindAddTrack();
    bindBinDrop();
    bindOsFileDrop();
    bindBus();
    renderAll();
  }

  // 暴露少量给 shortcuts / 调试（不作为权威接口；权威经 App.* 与 bus）
  App.timeline = {
    renderAll: renderAll,
    setZoom: setZoom,
    zoomIn: function () { zoomStep(+1); },
    zoomOut: function () { zoomStep(-1); },
    getPxPerSec: function () { return pxPerSec; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
