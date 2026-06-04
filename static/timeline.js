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
  var CMT_TAG_H = 16;           // 评论标签行高
  var CMT_GAP = 3;              // 同层标签间最小水平间距(px)
  var CMT_MIN_W = 78;           // 点评论/极短区间的最小可读宽度
  var GCL_MIN_H = 26;           // 整轨批注带最小高度

  /* ---------- DOM 句柄（解析时容错 contract 权威 id 与 timeline_v2 草案 id） ---------- */
  var elPanel, elScroll, elRuler, elHeads, elArea, elLanes, elPlayhead, elSnap, elTotalDur, elDrop, elGlobalCmt;
  var elRulerPlayhead;   // 刻度尺上的播放头标记（手柄+延伸线），与 #playhead 联动
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
    elGlobalCmt = pick('globalCommentLane');
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
    if (clip.freeze) return clip.duration || 0;            // 定格片段：时间轴长度 = duration
    if (track && track.kind === 'text') return clip.duration || 0;
    if (clip.duration != null && clip.out == null) return clip.duration; // 文字片段
    // 公式 A（speed_design.md §0）：视频时间轴长度 = (out - in) / speed
    return ((clip.out || 0) - (clip.in || 0)) / (clip.speed || 1);
  }

  // doSpeedTrim 需后段左缘作上界（app.js 有 nextClipStart，本模块无，新增本地 helper）
  function nextClipStart(track, clip) {
    var myEnd = clip.start + clipDur(clip, track), best = null;
    track.clips.forEach(function (c) {
      if (c === clip) return;
      if (c.start >= myEnd - 1e-6) { if (best == null || c.start < best) best = c.start; }
    });
    return best;
  }
  // 左缘变速需前段右缘作 start 下界（同轨、位于当前片段左侧的片段中，最大的 end）。
  function prevClipEnd(track, clip) {
    var myStart = clip.start, best = null;
    track.clips.forEach(function (c) {
      if (c === clip) return;
      var e = c.start + clipDur(c, track);
      if (e <= myStart + 1e-6) { if (best == null || e > best) best = e; }
    });
    return best;
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
    renderGlobalComments();
    updatePlayhead(playhead());
    refreshToolbar();
  }

  /* 4.1 轨道头（左列）——顶层在第一行（数组末尾先画） */
  function renderHeads() {
    var tr = tracks(), frag = document.createDocumentFragment();
    // 整轨批注带的左列占位（与右侧 #globalCommentLane 等高对齐；高度在 renderGlobalComments 里同步）
    var gch = el('div', 'gcl-head'); gch.id = 'globalCommentHead'; gch.style.height = GCL_MIN_H + 'px';
    gch.appendChild(el('span', 'gcl-head-label', '整轨批注'));
    frag.appendChild(gch);
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
        // 该轨片段评论（scope=clip 且 clipId 属于本轨）→ 标签贴在片段顶部，自动错开
        var ids = {}; track.clips.forEach(function (c) { ids[c.id] = 1; });
        var tcs = comments().filter(function (c) { return c.scope === 'clip' && c.clipId && ids[c.clipId]; });
        if (tcs.length) renderCmtTags(lane, tcs);
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

  /* ---------- 评论 / 批注标签（导演批注，给 AI 的剪辑指令）---------- */
  function comments() { return (App.getComments ? App.getComments() : (project().comments || [])); }
  // 评论 → 像素矩形 {left,width}（区间=跨度，点=最小可读宽）
  function cmtRect(c) {
    if (c.kind === 'range') {
      var L = timeToX(c.start || 0);
      var W = Math.max(CMT_MIN_W, timeToX(Math.max(0, (c.end || c.start || 0) - (c.start || 0))));
      return { left: L, width: W };
    }
    return { left: timeToX(c.at || 0), width: CMT_MIN_W };
  }
  // 贪心分层：items=[{left,width,...}] 按 left 升序分配"最低且不与该层已占区间重叠"的 lane；返回层数。
  function packLanes(items) {
    var laneEnd = [];
    items.slice().sort(function (a, b) { return a.left - b.left; }).forEach(function (it) {
      var placed = -1;
      for (var l = 0; l < laneEnd.length; l++) { if (it.left >= laneEnd[l] - 1e-3) { placed = l; break; } }
      if (placed < 0) { placed = laneEnd.length; laneEnd.push(0); }
      it.lane = placed; laneEnd[placed] = it.left + it.width + CMT_GAP;
    });
    return laneEnd.length;
  }
  function cmtTagEl(c, it) {
    var t = el('div', 'cmt-tag ' + c.kind + ' ' + (c.status || 'pending') + (c.scope === 'global' ? ' global' : ''));
    t.dataset.commentId = c.id;
    t.style.left = it.left + 'px';
    t.style.width = it.width + 'px';
    t.style.top = (2 + it.lane * (CMT_TAG_H + 2)) + 'px';
    var mark = c.status === 'done' ? '✓ ' : (c.status === 'stale' ? '⚠ ' : (c.kind === 'point' ? '📍' : '⟷ '));
    t.appendChild(el('span', 'cmt-text', mark + (c.text || '（空）')));
    t.title = (c.status === 'done' ? '[已执行] ' : (c.status === 'stale' ? '[锚点失效] ' : '')) + (c.text || '');
    if (c.kind === 'range') {   // 区间评论：左右边缘手柄，可拖拽精调 A–B
      t.appendChild(el('div', 'cmt-handle left'));
      t.appendChild(el('div', 'cmt-handle right'));
    }
    return t;
  }
  // 把一批评论渲进容器（自动错开不重叠），返回所占层数
  function renderCmtTags(container, list) {
    var items = list.map(function (c) { var r = cmtRect(c); return { c: c, left: r.left, width: r.width }; });
    var lanes = packLanes(items);
    items.forEach(function (it) { container.appendChild(cmtTagEl(it.c, it)); });
    return lanes;
  }
  // 整轨/全局批注带（scope=global）+ 左列等高对齐
  function renderGlobalComments() {
    if (!elGlobalCmt) return;
    elGlobalCmt.style.width = contentWidth() + 'px';
    elGlobalCmt.replaceChildren();
    var lanes = renderCmtTags(elGlobalCmt, comments().filter(function (c) { return c.scope === 'global'; }));
    var h = Math.max(GCL_MIN_H, lanes * (CMT_TAG_H + 2) + 4);
    elGlobalCmt.style.height = h + 'px';
    var head = $('globalCommentHead'); if (head) head.style.height = h + 'px';
  }

  /* 4.3 单个片段块 */
  function renderClip(clip, track) {
    var dur = clipDur(clip, track);
    var isText = (track.kind === 'text');
    var c = el('div', (isText ? 'text-clip' : 'clip') + ' ' + track.kind);
    if (clip.freeze) c.classList.add('freeze-clip');
    c.dataset.clipId = clip.id;
    c.dataset.trackId = track.id;
    c.style.left = timeToX(clip.start) + 'px';
    c.style.width = Math.max(MIN_PX, timeToX(dur)) + 'px';
    if (clip.id === selectedClipId()) c.classList.add('selected');

    if (isText) {
      c.appendChild(el('span', 'tc-label clip-label', (clip.content || '文字').replace(/\n/g, ' ').slice(0, 24)));
    } else {
      var m = App.getMedia ? App.getMedia(clip.mediaId) : null;
      // 离线素材（工程系统）：原文件丢失 → 加 .offline 样式，标“素材离线”，
      // 不设 backgroundImage（缩略图已失效，避免请求 404）；其余把手/角标保留，
      // 离线片段仍可选中 / 移动 / 删除（保留全部属性）。
      if (m && m.offline) {
        c.classList.add('offline');
        c.appendChild(el('span', 'clip-label', '⚠ 素材离线 · ' + (m.name || '片段')));
      } else {
        if (m && m.thumbUrl) c.style.backgroundImage = 'url("' + m.thumbUrl + '")';
        c.appendChild(el('span', 'clip-label', m ? m.name : '片段'));
        var thumb = el('div', 'clip-thumb');
        c.appendChild(thumb);
      }
    }
    c.appendChild(el('div', 'clip-trim left'));
    c.appendChild(el('div', 'clip-trim right'));
    c.appendChild(el('div', 'clip-label-dur', fmt(dur)));
    if (clip.freeze) c.appendChild(el('div', 'clip-freeze-badge', '❄ 定格'));
    // 倍率角标（B）：视频片段 speed≠1 时在块中间显示倍数（pointer-events:none，不挡把手/拖拽）。
    if (!isText) {
      var sp = clip.speed || 1;
      var badge = el('div', 'clip-speed-badge', sp.toFixed(2) + '×');
      if (Math.abs(sp - 1) < 1e-6) badge.hidden = true;
      c.appendChild(badge);
    }
    return c;
  }

  // 实时更新拖拽中的片段倍率角标（B）：speed≠1 显示，=1 隐藏
  function updateSpeedBadge(clipEl, speed) {
    if (!clipEl) return;
    var badge = clipEl.querySelector('.clip-speed-badge');
    if (!badge) return;
    if (Math.abs(speed - 1) < 1e-6) { badge.hidden = true; }
    else { badge.hidden = false; badge.textContent = speed.toFixed(2) + '×'; }
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
    // replaceChildren 会清掉播放头标记，重建后补回并对齐
    ensureRulerPlayhead();
    if (elRulerPlayhead) elRulerPlayhead.style.left = timeToX(playhead()) + 'px';
    renderMarkers();   // 特殊标记的旗子（被 replaceChildren 清掉，这里重建）
  }

  /* ---------- 时间轴特殊标记（@标记，给 AI 引用） ---------- */
  function markers() { return (App.getMarkers && App.getMarkers()) || []; }
  function renderMarkers() {
    if (!elRuler) return;
    // 旧旗子先清（renderRuler 的 replaceChildren 已清，这里兜底重复调用时也安全）
    Array.prototype.slice.call(elRuler.querySelectorAll('.tl-marker')).forEach(function (n) { n.remove(); });
    markers().forEach(function (mk) {
      var flag = el('div', 'tl-marker');
      flag.style.left = timeToX(mk.at || 0) + 'px';
      flag.dataset.markerId = mk.id;
      flag.title = mk.label + ' · ' + fmt(mk.at || 0) + '（点击定位；点旗子改名/删除）';
      flag.appendChild(el('span', 'tl-marker-label', mk.label));
      elRuler.appendChild(flag);
    });
  }

  /* 刻度尺上的播放头标记：一个好抓的手柄 + 向下延伸的竖线（跨刻度尺与批注带，
   * 与轨道区 #playhead 连成一条线）。让"点刻度尺定位某一帧"既可见又好点。 */
  function ensureRulerPlayhead() {
    if (!elRuler) return;
    if (!elRulerPlayhead) {
      elRulerPlayhead = el('div', 'ruler-playhead');
      var knob = el('div', 'rph-knob');
      knob.title = '拖动定位到某一帧（也可直接点刻度尺任意位置）';
      knob.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;   // 仅左键
        e.stopPropagation(); e.preventDefault();
        startScrub(e);
      });
      elRulerPlayhead.appendChild(knob);
    }
    if (elRulerPlayhead.parentNode !== elRuler) elRuler.appendChild(elRulerPlayhead);
  }

  /* ---------- 播放头 ---------- */
  function updatePlayhead(t) {
    if (!elPlayhead) return;
    var x = timeToX(t);
    elPlayhead.style.left = x + 'px';
    if (elRulerPlayhead) elRulerPlayhead.style.left = x + 'px';   // 刻度尺标记同步
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

    // 空白处点击：取消选中 + 定位播放头（评论标签不触发）
    elArea.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.clip') || e.target.closest('.text-clip') || e.target.closest('.cmt-tag')) return;
      if (e.button != null && e.button !== 0) return;   // 右键留给评论菜单
      doClearSelection();
      startScrub(e);
    });
    // 双击两段之间的空白：删除该空隙（仅当前轨，后续片段左移补缝）
    elArea.addEventListener('dblclick', function (e) {
      if (e.target.closest('.clip') || e.target.closest('.text-clip') || e.target.closest('.cmt-tag')) return;
      var lane = laneAt(e); if (!lane || !lane.dataset.trackId) return;
      if (App.closeGap) App.closeGap(lane.dataset.trackId, clientXToTime(e.clientX));
    });
  }

  function onLanePointerDown(e) {
    if (e.button != null && e.button !== 0) return;     // 右键不拖动片段（留给评论右键菜单）
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
      orig: { start: clip.start, in: clip.in, out: clip.out, duration: clip.duration, speed: clip.speed },
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
    // Shift + 拖【任一端边缘】且片段为视频 → 变速（speed_design.md §2.1，A：左右缘均可）。
    // 一旦判为变速，后续 move 持续走 speedTrim（不因中途松开 Shift 切回裁剪，避免抖动）；
    // drag.speedEdge 记住是哪一端（'left'/'right'），左缘锚右、右缘锚左。
    if (drag.mode === 'speed' ||
        ((drag.mode === 'trim-right' || drag.mode === 'trim-left') && e.shiftKey && drag.track && drag.track.kind === 'video' && !(drag.clip && drag.clip.freeze))) {
      if (drag.mode !== 'speed') { drag.speedEdge = (drag.mode === 'trim-left') ? 'left' : 'right'; drag.mode = 'speed'; }
      doSpeedTrim(e, dxSec, snapOff);
      return;
    }
    if (drag.mode === 'move') doMove(e, dxSec, snapOff);
    else doTrim(e, dxSec, snapOff, drag.mode === 'trim-left');
  }

  /* 变速拖拽（Shift + 任一端边缘，in/out 固定，只改 speed）—— 仅视觉更新，松手才落数据。
   * 公式 A：tlLen = (out-in)/speed；speed∈[0.25,4] ⇒ tlLen∈[(out-in)/4,(out-in)/0.25]。
   *
   * 右缘变速（speedEdge='right'）：左缘 start 锚定不动，右缘随指针 → tlLen 变 → speed 变。
   * 左缘变速（speedEdge='left'）：右缘 end=start+tlLen 锚定不动，左缘随指针 → tlLen 变 → speed 变。
   *   左缘左移=拉长(tlLen↑)=变慢(speed↓)；右移=缩短=变快。落地时 start 改变 → commit 需 moveClip。
   * 钳制：speed∈[0.25,4]，tlLen≥MIN，且不越邻段（右缘不越后段、左缘不越前段 prevClipEnd），start≥0。 */
  function doSpeedTrim(e, dxSec, snapOff) {
    var o = drag.orig, track = drag.track;
    var srcLen = (o.out || 0) - (o.in || 0);            // 源长度恒定
    var MIN = minClipLen();
    var curTlLen = srcLen / (o.speed || 1);             // 拖前的时间轴长度
    var origEnd = o.start + curTlLen;                   // 拖前的右缘
    var isLeft = (drag.speedEdge === 'left');

    var tlMin = Math.max(MIN, srcLen / 4);              // speed=4 → 最短
    var tlMax = srcLen / 0.25;                          // speed=0.25 → 最长
    var newStart, tlLen;

    if (isLeft) {
      // 右缘锚定 origEnd 不变；左缘 = start + dxSec（随指针），tlLen = origEnd - 左缘。
      var desiredStart = o.start + dxSec;
      // 磁吸左缘（只吸被拖的那条边缘）
      if (!snapOff) { var sl = snapEdge(desiredStart, drag.clip.id); if (sl.hit) desiredStart = sl.value; }
      else hideSnapGuide();
      // 不越前段右缘：start 下界 = max(0, prevClipEnd)
      var prevEnd = prevClipEnd(track, drag.clip);
      var startLo = Math.max(0, (prevEnd != null) ? prevEnd : 0);
      // tlLen 约束 ⇒ start 约束：start∈[origEnd-tlMax, origEnd-tlMin]，再交 [startLo, +∞)
      var startMin = Math.max(startLo, origEnd - tlMax);
      var startMax = origEnd - tlMin;
      if (startMax < startMin) startMin = startMax;     // 前段太近时退化，防反转
      newStart = clamp(desiredStart, startMin, startMax);
      tlLen = origEnd - newStart;
    } else {
      // 左缘锚定 start 不变；右缘 = origEnd + dxSec（随指针），tlLen = 右缘 - start。
      var desiredEnd = origEnd + dxSec;
      if (!snapOff) { var sr = snapEdge(desiredEnd, drag.clip.id); if (sr.hit && sr.value > o.start + MIN) desiredEnd = sr.value; }
      else hideSnapGuide();
      // 不越后段左缘：tlLen 上界 = nextStart - start（无后段则 Infinity）
      var nextStart = nextClipStart(track, drag.clip);
      var maxByNeighbor = (nextStart != null) ? (nextStart - o.start) : Infinity;
      var tlMaxR = Math.min(tlMax, maxByNeighbor);
      if (tlMaxR < tlMin) tlMaxR = tlMin;
      tlLen = clamp(desiredEnd - o.start, tlMin, tlMaxR);
      newStart = o.start;
    }

    var speed = clamp(srcLen / tlLen, 0.25, 4);
    var finalTlLen = srcLen / speed;
    drag.pending = { speed: speed, tlLen: finalTlLen, start: newStart };
    // 视觉：左缘变速时 left 随 newStart 移动，宽度按变速后 tlLen
    drag.el.style.left = timeToX(newStart) + 'px';
    drag.el.style.width = Math.max(MIN_PX, timeToX(finalTlLen)) + 'px';
    // 实时更新中间倍率角标（B）+ 时长角标
    updateSpeedBadge(drag.el, speed);
    var durEl = drag.el.querySelector('.clip-label-dur');
    if (durEl) durEl.textContent = fmt(finalTlLen);
    drag.el.title = '变速 ' + speed.toFixed(2) + '×';
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
    // 定格片段：拖边缘改 start/duration（与文字同构），不裁源 in/out
    var textLike = isText || (drag.clip && drag.clip.freeze);
    var media = (!textLike && App.getMedia) ? App.getMedia(drag.clip.mediaId) : null;
    var MIN = minClipLen();

    if (textLike) {
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
      // 左缘随鼠标(时间轴增量 dTl)：start' = start + dTl；源 in' = in + dTl*sp（保持右缘 out 不变）
      // 时间轴长 = (out-in)/sp；边界：in'>=0、start'>=0、时间轴长'>=MIN
      var sp = (o.speed || 1);
      var oldTl = (o.out - o.in) / sp;
      var dTl = dxSec;
      var lo = Math.max(-o.in / sp, -o.start), hi = oldTl - MIN;
      dTl = clamp(dTl, lo, hi);
      var newStart = o.start + dTl;
      if (!snapOff) { var sl = snapEdge(newStart, drag.clip.id); if (sl.hit) { dTl = clamp(sl.value - o.start, lo, hi); newStart = o.start + dTl; } }
      drag.pending = { start: Math.max(0, newStart), in: o.in + dTl * sp, out: o.out };
    } else {
      // 右缘(时间轴增量 dxSec)：源 out' = out + dxSec*sp；时间轴长 = (out'-in)/sp
      var spR = (o.speed || 1);
      var d2 = dxSec * spR;
      var maxDur = media ? media.duration : Infinity;
      var hiR = maxDur - o.out;                       // out 不超素材时长
      var loR = MIN * spR - (o.out - o.in);           // 时间轴长 >= MIN
      d2 = clamp(d2, loR, hiR);
      var endTime = o.start + (o.out - o.in + d2) / spR;
      if (!snapOff) { var sr = snapEdge(endTime, drag.clip.id); if (sr.hit) { d2 = clamp((sr.value - o.start) * spR - (o.out - o.in), loR, hiR); } }
      drag.pending = { start: o.start, in: o.in, out: o.out + d2 };
    }
    applyTrimVisual(track);
  }

  function applyTrimVisual(track) {
    var p = drag.pending;
    var sp = (drag.orig && drag.orig.speed) || 1;   // 变速：时间轴长 = 源长/sp
    var dur = (track.kind === 'text' || (drag.clip && drag.clip.freeze)) ? p.duration : ((p.out - p.in) / sp);
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
    } else if (d.mode === 'speed') {
      // 变速：in/out 不变，只改 speed。一次手势一次撤销步（mutator 传 noHistory）。
      // 左缘变速会使 start 改变（右缘锚定）：先 setClipSpeed 改 tlLen，再 moveClip 落新 start。
      var newStart = (d.pending.start != null) ? d.pending.start : d.orig.start;
      var movesStart = Math.abs(newStart - d.orig.start) > 1e-6;
      // 左缘变速：落地前预检新时长能放在 newStart（不与他段重叠），否则整体取消，
      // 避免“speed 改了但 start 没落地”的半提交（静态审查 low）。
      if (movesStart) {
        var newTlLen = (d.orig.out - d.orig.in) / (d.pending.speed || 1);
        if (resolveOverlap(d.track, d.clip.id, newStart, newTlLen, d.track) == null) {
          App.toast && App.toast('变速后位置与其他片段重叠，已取消', 'error');
          return renderAll();
        }
      }
      App.pushHistory();
      App.setClipSpeed(d.track.id, d.clip.id, d.pending.speed, { noHistory: true });
      if (movesStart) {
        App.moveClip(d.track.id, d.clip.id, newStart, undefined, { noHistory: true });
      }
      // mutator emit clips:changed -> renderAll，恢复角标/宽度为真实值
    } else if (d.mode === 'trim-left') {
      App.pushHistory();
      // contract §3.2: App.trimClip(trackId, clipId, edge, deltaSec, opts)；in 边
      // 文字片段与定格片段：左缘平移量（trimClip 内部按 start/duration 处理）；视频：源 in 增量
      if (d.track.kind === 'text' || d.clip.freeze) {
        var deltaT = d.pending.start - d.orig.start;
        App.trimClip(d.track.id, d.clip.id, 'in', deltaT, { noHistory: true });
      } else {
        var deltaIn = d.pending.in - d.orig.in;
        App.trimClip(d.track.id, d.clip.id, 'in', deltaIn, { noHistory: true });
      }
    } else { // trim-right
      App.pushHistory();
      if (d.track.kind === 'text' || d.clip.freeze) {
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
      var lane = laneAt(e);
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
      var lane = laneAt(e);
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
  // 定位拖放目标轨道行：优先用事件目标的 .track-row 祖先；若被刻度线/播放头等覆盖层拦截，
  // 则兜底按 clientY 在 #tracksArea 的各 .track-row 中按几何命中（不依赖 z 序/命中元素）。
  function laneAt(e) {
    var lane = (e.target && e.target.closest) ? e.target.closest('.track-row') : null;
    if (lane) return lane;
    var rows = elArea ? elArea.querySelectorAll('.track-row') : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom) return rows[i];
    }
    return null;
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

  /* OS 文件拖入窗口（分区到素材库 / 轨道）统一由 app.js 的 bindOsFileDrop 负责，
   * 此处不再实现，避免双重 window 监听导致一次拖放上传两次。 */

  /* =======================================================================
   * 刻度尺 / 播放头拖动 seek
   * ===================================================================== */
  function startScrub(e) {
    if (e.button != null && e.button !== 0) return;     // 仅左键 scrub（右键留给评论菜单）
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
    if (elRuler) elRuler.addEventListener('pointerdown', function (e) {
      // 点标记旗子（左键）→ 精确定位到该标记；右键留给改名/删除菜单
      var mflag = e.target.closest('.tl-marker');
      if (mflag) {
        if (e.button != null && e.button !== 0) return;
        var mk = App.getMarker && App.getMarker(mflag.dataset.markerId);
        if (mk) { e.preventDefault(); e.stopPropagation(); doSeek(mk.at || 0); }
        return;
      }
      e.preventDefault(); startScrub(e);
    });
    // 「整轨批注」带：空白处点击 = 跟刻度尺一样定位播放头；
    // 但点在已有批注标签/手柄上时不抢——留给原有的“打开/编辑批注”交互。
    if (elGlobalCmt) elGlobalCmt.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;                              // 右键留给“加整轨评论”菜单
      if (e.target.closest('.cmt-tag') || e.target.closest('.cmt-handle')) return; // 点批注本身 → 打开批注，不定位
      e.preventDefault(); startScrub(e);
    });
  }

  /* =======================================================================
   * 评论 / 批注交互：右键加评论、点标签编辑/删除
   * ===================================================================== */
  var cmtMenuEl = null, cmtPopEl = null;
  function closeCmtMenu() { if (cmtMenuEl) { cmtMenuEl.remove(); cmtMenuEl = null; } }
  function closeCmtPop() { if (cmtPopEl) { cmtPopEl.remove(); cmtPopEl = null; } }
  function showCmtMenu(x, y, items) {
    closeCmtMenu(); closeCmtPop();
    var m = el('div', 'cmt-ctxmenu menu');
    items.forEach(function (it) {
      var b = el('button', 'menu-item', it.label); b.type = 'button';
      b.addEventListener('click', function (ev) { ev.stopPropagation(); closeCmtMenu(); it.fn(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    // 防溢出屏幕
    var w = m.offsetWidth || 200, h = m.offsetHeight || 80;
    m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    cmtMenuEl = m;
  }
  // 文本气泡：opts.onSave(text) / opts.onDelete?()
  function showCmtPopover(x, y, initial, opts) {
    closeCmtMenu(); closeCmtPop();
    var pop = el('div', 'cmt-popover');
    var ta = el('textarea', 'cmt-pop-input'); ta.value = initial || '';
    ta.placeholder = '给 AI 的剪辑指令，如：删除后续视频 / 加速50% / 加字幕“你好”';
    pop.appendChild(ta);
    var row = el('div', 'cmt-pop-row');
    var ok = el('button', 'primary', '保存'); ok.type = 'button';
    var cancel = el('button', null, '取消'); cancel.type = 'button';
    ok.addEventListener('click', function () { var v = ta.value.trim(); if (v) opts.onSave(v); closeCmtPop(); });
    cancel.addEventListener('click', closeCmtPop);
    row.appendChild(ok); row.appendChild(cancel);
    if (opts.onDelete) { var del = el('button', 'danger', '删除'); del.type = 'button'; del.addEventListener('click', function () { opts.onDelete(); closeCmtPop(); }); row.appendChild(del); }
    pop.appendChild(row);
    document.body.appendChild(pop);
    var w = pop.offsetWidth || 280, h = pop.offsetHeight || 120;
    pop.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    cmtPopEl = pop;
    ta.focus(); ta.select();
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ok.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeCmtPop(); }
    });
  }
  function openTagEditor(tagEl, x, y) {
    var id = tagEl.dataset.commentId, c = App.getComment ? App.getComment(id) : null; if (!c) return;
    showCmtPopover(x, y, c.text || '', {
      onSave: function (text) { App.updateComment(id, { text: text }); },
      onDelete: function () { App.removeComment(id); }
    });
  }
  function addClipComment(kind, clipId, anchor, x, y) {
    showCmtPopover(x, y, '', { onSave: function (text) {
      var o = { scope: 'clip', kind: kind, clipId: clipId, text: text };
      if (kind === 'point') o.at = anchor.at; else { o.start = anchor.start; o.end = anchor.end; }
      App.addComment(o);
    } });
  }
  function addGlobalComment(kind, anchor, x, y) {
    showCmtPopover(x, y, '', { onSave: function (text) {
      var o = { scope: 'global', kind: kind, text: text };
      if (kind === 'point') o.at = anchor.at; else { o.start = anchor.start; o.end = anchor.end; }
      App.addComment(o);
    } });
  }
  function bindCommentInteractions() {
    function onCtx(e) {
      // 特殊标记旗子：右键 → 改名 / 删除
      var mflag = e.target.closest('.tl-marker');
      if (mflag) {
        e.preventDefault();
        var mid = mflag.dataset.markerId, mk = App.getMarker && App.getMarker(mid);
        showCmtMenu(e.clientX, e.clientY, [
          { label: '✎ 重命名标记', fn: function () {
              showCmtPopover(e.clientX, e.clientY, (mk && mk.label) || '', { onSave: function (txt) {
                if (txt != null && ('' + txt).trim() !== '') App.updateMarker(mid, { label: ('' + txt).trim() }); } });
            } },
          { label: '🗑 删除标记', fn: function () { App.removeMarker(mid); } }
        ]);
        return;
      }
      var tag = e.target.closest('.cmt-tag');
      if (tag) { e.preventDefault(); openTagEditor(tag, e.clientX, e.clientY); return; }
      var clipEl = e.target.closest('.clip');
      if (clipEl) {
        e.preventDefault();
        var cid = clipEl.dataset.clipId;
        var loc = App.locateClip ? App.locateClip(cid) : null;
        var atT = clientXToTime(e.clientX);
        var cs = loc && loc.clip ? loc.clip.start : atT;
        var ce = loc && loc.clip ? (loc.clip.start + clipDur(loc.clip, loc.track)) : atT + 3;
        showCmtMenu(e.clientX, e.clientY, [
          { label: '📍 在此点加评论', fn: function () { addClipComment('point', cid, { at: atT }, e.clientX, e.clientY); } },
          { label: '⟷ 给本片段加区间评论', fn: function () { addClipComment('range', cid, { start: cs, end: ce }, e.clientX, e.clientY); } }
        ]);
        return;
      }
      if (e.target.closest('#globalCommentLane') || e.target.closest('#timelineRuler')) {
        e.preventDefault();
        var atG = clientXToTime(e.clientX);
        showCmtMenu(e.clientX, e.clientY, [
          { label: '🚩 在此新建标记 (' + (App.nextMarkerNo ? App.nextMarkerNo() + '号' : '') + ')', fn: function () { if (App.addMarker) { App.addMarker(atG); App.toast && App.toast('已加标记，可在 AI 聊天框用 @ 引用', 'info', 1800); } } },
          { label: '📍 在此点加整轨评论', fn: function () { addGlobalComment('point', { at: atG }, e.clientX, e.clientY); } },
          { label: '⟷ 加整轨区间评论', fn: function () { addGlobalComment('range', { start: atG, end: atG + 3 }, e.clientX, e.clientY); } }
        ]);
        return;
      }
    }
    function onClick(e) {
      if (e.target.closest('.cmt-handle')) return;        // 拖手柄不当作点击
      var tag = e.target.closest('.cmt-tag'); if (tag) { e.stopPropagation(); openTagEditor(tag, e.clientX, e.clientY); }
    }
    // 区间评论标签的边缘手柄：拖拽改 start/end（预览改样式，松手提交）
    function onHandleDown(e) {
      var h = e.target.closest('.cmt-handle'); if (!h) return;
      if (e.button != null && e.button !== 0) return;
      var tag = h.closest('.cmt-tag'); if (!tag) return;
      var id = tag.dataset.commentId, c = App.getComment ? App.getComment(id) : null; if (!c || c.kind !== 'range') return;
      e.preventDefault(); e.stopPropagation();
      var isLeft = h.classList.contains('left'), start = c.start || 0, end = c.end || (start + 1), ns = start, ne = end;
      function mv(ev) {
        var t = clientXToTime(ev.clientX);
        if (isLeft) { ns = Math.min(Math.max(0, t), end - 0.05); tag.style.left = timeToX(ns) + 'px'; tag.style.width = Math.max(CMT_MIN_W, timeToX(end - ns)) + 'px'; }
        else { ne = Math.max(t, start + 0.05); tag.style.width = Math.max(CMT_MIN_W, timeToX(ne - start)) + 'px'; }
      }
      function up() {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
        App.updateComment(id, isLeft ? { start: ns } : { end: ne });
      }
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    }
    [elArea, elGlobalCmt, elRuler].forEach(function (n) { if (n) { n.addEventListener('contextmenu', onCtx); n.addEventListener('click', onClick); n.addEventListener('pointerdown', onHandleDown); } });
    document.addEventListener('click', closeCmtMenu);     // 点别处关菜单（气泡不自动关，避免丢输入）
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
   * Shift 指针提示（A）：按住 Shift 时给 body 加 .shift-edge，
   * 让悬停在 .clip-trim 把手上的指针变为变速样式（style.css 负责定义，与裁剪 ew-resize 区分）。
   * 仅响应 Shift 键；窗口失焦时清除，防卡死高亮。
   * ===================================================================== */
  function bindShiftCursor() {
    function setShift(on) {
      if (document.body) document.body.classList.toggle('shift-edge', !!on);
    }
    window.addEventListener('keydown', function (e) { if (e.key === 'Shift' || e.shiftKey) setShift(true); });
    window.addEventListener('keyup', function (e) { if (e.key === 'Shift' || !e.shiftKey) setShift(false); });
    window.addEventListener('blur', function () { setShift(false); });
  }

  /* =======================================================================
   * 接口①（供 app.js OS 文件拖放分区调用）
   *   trackDropInfo(clientX, clientY) -> {trackId, timeSec} | null
   *   setDropTargetTrack(trackId | null) -> 给匹配的 .track-row 加/清 .drop-active
   * ===================================================================== */
  // 几何命中 #tracksArea 内某条【视频且未锁】轨道行；命中返回 {trackId, timeSec}（timeSec>=0），否则 null。
  function trackDropInfo(clientX, clientY) {
    if (!elArea) return null;
    var rows = elArea.querySelectorAll('.track-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) {
        var track = findTrack(rows[i].dataset.trackId);
        if (track && track.kind === 'video' && !track.locked) {
          return { trackId: track.id, timeSec: clientXToTime(clientX) };
        }
        return null; // 命中了某行但非合法视频轨 → 不作为轨道目标
      }
    }
    return null;
  }
  // 给匹配 trackId 的 .track-row 加 class "drop-active"，其余清除；传 null 清除全部。
  function setDropTargetTrack(trackId) {
    if (!elArea) return;
    var rows = elArea.querySelectorAll('.track-row');
    for (var i = 0; i < rows.length; i++) {
      var on = (trackId != null && rows[i].dataset.trackId === ('' + trackId));
      rows[i].classList.toggle('drop-active', on);
    }
  }

  /* =======================================================================
   * bus 接线 + 初始化
   * ===================================================================== */
  function bindBus() {
    bus.on('project:changed', renderAll);
    bus.on('tracks:changed', function () { renderHeads(); renderTracks(); refreshToolbar(); });
    bus.on('clips:changed', renderAll);   // 兼容草案事件名
    bus.on('comments:changed', renderAll);   // 评论新增/改/删 → 重渲标签层
    bus.on('markers:changed', renderRuler);   // 特殊标记新增/改/删 → 重渲旗子
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
    bindCommentInteractions();
    bindShiftCursor();
    // 注意：OS 文件拖入窗口的导入由 app.js 的 bindOsFileDrop 统一处理。
    // 此处不再重复绑定，否则同一次拖放会被两个 window 监听各上传一次 → 素材库出现两条。
    bindBus();
    renderAll();
  }

  // 暴露少量给 shortcuts / 调试（不作为权威接口；权威经 App.* 与 bus）
  App.timeline = {
    renderAll: renderAll,
    setZoom: setZoom,
    zoomIn: function () { zoomStep(+1); },
    zoomOut: function () { zoomStep(-1); },
    getPxPerSec: function () { return pxPerSec; },
    // 接口①：供 app.js OS 文件拖放分区调用
    trackDropInfo: trackDropInfo,
    setDropTargetTrack: setDropTargetTrack
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
