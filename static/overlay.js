/* =========================================================================
 * overlay.js — 预览之上的选中变换手柄层 (#overlayLayer)
 *
 * 两类对象, 同一层渲染 (contract_v2 §4.3: #overlayLayer = 文字 WYSIWYG + 选中手柄):
 *   1) 文字片段 (text-clip): 复用 v1 文字框交互 —— 拖动改 xPct/yPct,
 *      四角手柄改 wPct(并等比改 fontSizePct), 字号手柄单独改 fontSizePct,
 *      双击编辑 content。文字框 DOM 由 player.js buildTextNode 构建。
 *   2) 视频片段 (video-clip): 选中时画 PiP 变换框 .pip-frame, 拖动框体改 cx/cy,
 *      四角手柄等比改 scale。
 *
 * 坐标基于 #canvasBox 内容矩形 (= 预览显示矩形, letterbox 后), 与导出像素同比 —
 * 通过 App.engine.getCanvasRect()/clipScreenRect() 与 §5 换算公式互逆。
 *
 * 写状态一律走 App mutator (contract §3.2):
 *   - 视频: App.setClipTransform(trackId, clipId, {scale?,cx?,cy?,opacity?})
 *   - 文字: App.setTextProp(trackId, clipId, key, value)
 * 连续拖拽合并为一个撤销步: pointerdown 调一次 App.pushHistory(), pointermove
 * 期间直传 patch (mutator 内部不重复入栈; 详见 contract §6.8 — 调用方在手势开始
 * 压一次)。本模块对 pushHistory 的存在与否做容错。
 *
 * 与属性面板/选中态联动: 通过 App.getSelection()/App.selectClip() 与
 * bus 'selection:changed'/'transform:changed'/'texts:changed' 协作。
 * ========================================================================= */
(function () {
  'use strict';
  var App = window.App;
  var bus = App.bus;

  var layer;          // #overlayLayer
  var canvasBox;      // #canvasBox
  var drag = null;    // 拖拽会话
  var editing = null; // 正在编辑文本的 clipId
  var _pipFrame = null;

  App.isEditingText = function () { return editing != null; };

  /* ---------- 兼容工具 ---------- */
  function box() { return App.getBoxSize ? App.getBoxSize() : { boxW: 0, boxH: 0 }; }
  function clamp(v, a, b) { return App.clamp ? App.clamp(v, a, b) : Math.min(b, Math.max(a, v)); }
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return ('' + s).replace(/["\\]/g, '\\$&');
  }
  function pushHistory() { if (App.pushHistory) try { App.pushHistory(); } catch (e) {} }

  // 当前选中 (契约): { kind:"clip"|"text"|"track"|null, trackId?, clipId? }
  function selection() {
    if (App.getSelection) return App.getSelection();
    // 回退: v1 风格选中字段
    if (App.selectedTextId) return { kind: 'text', clipId: App.selectedTextId };
    if (App.selectedClipId) return { kind: 'clip', clipId: App.selectedClipId };
    return null;
  }
  function selectTextClip(trackId, clipId) {
    if (App.selectClip) App.selectClip(trackId, clipId);
    else { App.selectedTextId = clipId; bus.emit('text:selected', { id: clipId }); }
  }
  function selectVideoClip(trackId, clipId) {
    if (App.selectClip) App.selectClip(trackId, clipId);
    else { App.selectedClipId = clipId; bus.emit('selection:changed', { kind: 'clip', trackId: trackId, clipId: clipId }); }
  }
  function clearSelection() {
    if (App.clearSelection) App.clearSelection();
    else { App.selectedTextId = null; App.selectedClipId = null; bus.emit('selection:changed', { kind: null }); }
  }

  // 查文字片段对象 + 所属轨 id。优先用引擎 timeline; 回退遍历 project。
  function findTextClip(clipId) {
    var proj = App.getProject ? App.getProject() : App.project;
    var tracks = (proj && proj.tracks) || [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].kind !== 'text') continue;
      var clips = tracks[i].clips || [];
      for (var j = 0; j < clips.length; j++) {
        if (clips[j].id === clipId) return { clip: clips[j], trackId: tracks[i].id };
      }
    }
    return null;
  }
  function findVideoClip(clipId) {
    if (App.engine && App.engine.findVideoClip) {
      var r = App.engine.findVideoClip(clipId);
      if (r) return r;
    }
    var proj = App.getProject ? App.getProject() : App.project;
    var tracks = (proj && proj.tracks) || [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].kind !== 'video') continue;
      var clips = tracks[i].clips || [];
      for (var j = 0; j < clips.length; j++) {
        if (clips[j].id === clipId) {
          var media = App.getMedia ? App.getMedia(clips[j].mediaId) : null;
          return { clip: clips[j], media: media, trackId: tracks[i].id };
        }
      }
    }
    return null;
  }

  /* ---------- 状态写回 ---------- */
  function setTransform(trackId, clipId, patch) {
    if (App.setClipTransform) App.setClipTransform(trackId, clipId, patch);
    else {
      var r = findVideoClip(clipId);
      if (r) { for (var k in patch) if (patch.hasOwnProperty(k)) r.clip[k] = patch[k]; }
    }
    bus.emit('transform:changed', { clipId: clipId });
  }
  function setTextProp(trackId, clipId, key, value) {
    if (App.setTextProp) App.setTextProp(trackId, clipId, key, value);
    else {
      var r = findTextClip(clipId);
      if (r) r.clip[key] = value;
    }
  }
  // 文字连续拖拽: 直接改对象 + 即时刷新, 松手时再走一次 mutator 落地(若可用)
  function liveSetText(clipId, patch) {
    var r = findTextClip(clipId);
    if (!r) return;
    for (var k in patch) if (patch.hasOwnProperty(k)) r.clip[k] = patch[k];
    if (App.engine) { App.engine._forceTextRefresh = true; App.engine.renderTextsNow(); }
  }
  function commitTextPatch(trackId, clipId, patch) {
    // 落地: 逐字段经 mutator(触发面板回填); mutator 不存在则已在 liveSetText 改好
    if (App.setTextProp) {
      for (var k in patch) if (patch.hasOwnProperty(k)) App.setTextProp(trackId, clipId, k, patch[k]);
    } else {
      bus.emit('texts:changed', { id: clipId });
    }
  }

  /* =====================================================================
   * 初始化
   * ===================================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    layer = document.getElementById('overlayLayer');
    canvasBox = document.getElementById('canvasBox');
    if (!layer) return;

    // overlay 容器默认 pointer-events:none (见 css); 文字框/手柄/pip 框自身 auto。
    layer.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);

    // 双击编辑文本
    layer.addEventListener('dblclick', function (e) {
      var node = e.target.closest('.textbox');
      if (node) { startEditing(node); return; }
    });

    // 点击预览空白处取消选中
    var stage = document.getElementById('stage');
    if (stage) stage.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.textbox')) return;
      if (e.target.closest('.pip-frame')) return;
      if (editing) finishEditing();
      if (selection()) clearSelection();
    }, true);

    // 选中态变化 → 重画 pip 手柄 (文字框由 player.js renderTexts 重画)
    bus.on('selection:changed', function () { renderPipFrame(); });
    bus.on('text:selected', function () { renderPipFrame(); });
    bus.on('transform:changed', function () { layoutPipFrame(); });
    bus.on('time:update', function () { layoutPipFrame(); });   // 播放/seek 时跟随片段矩形
    bus.on('output:changed', function () { renderPipFrame(); });
    window.addEventListener('resize', function () { renderPipFrame(); });
    // overlay 文字层被 player 重画后, 退出可能失焦的编辑态 (与 rAF 重画解耦)
    bus.on('overlay:rendered', function () {
      if (!editing) return;
      var node = layer.querySelector('.textbox[data-clip-id="' + cssEsc(editing) + '"]');
      if (!node) { editing = null; return; }
      var content = node.querySelector('.tb-content');
      if (content && content.getAttribute('contenteditable') !== 'true') editing = null;
    });

    renderPipFrame();
  });

  /* =====================================================================
   * 指针入口: 区分文字框 / pip 框 / pip 手柄
   * ===================================================================== */
  function onPointerDown(e) {
    // ---- 文字框 ----
    var tnode = e.target.closest('.textbox');
    if (tnode) { startTextDrag(e, tnode); return; }
    // ---- PiP 框 / 手柄 ----
    var pframe = e.target.closest('.pip-frame');
    if (pframe) { startPipDrag(e, pframe); return; }
  }

  /* ---------- 文字框: 选中 + 拖动/缩放 ---------- */
  function startTextDrag(e, node) {
    var clipId = node.dataset.clipId;
    var loc = findTextClip(clipId);
    if (!loc) return;
    if (editing === clipId) return;   // 正在编辑: 放行让用户点光标

    var sel = selection();
    if (!sel || sel.clipId !== clipId) {
      selectTextClip(loc.trackId, clipId);
      node = layer.querySelector('.textbox[data-clip-id="' + cssEsc(clipId) + '"]') || node;
    }

    var handle = e.target.dataset ? e.target.dataset.handle : null;
    var mode = 'move';
    if (handle === 'font') mode = 'font';
    else if (handle) mode = 'resize-' + handle;   // nw/ne/sw/se

    var tx = loc.clip;
    pushHistory();
    drag = {
      kind: 'text', mode: mode, clipId: clipId, trackId: loc.trackId,
      startX: e.clientX, startY: e.clientY,
      orig: { xPct: tx.xPct, yPct: tx.yPct, wPct: tx.wPct, fontSizePct: tx.fontSizePct }
    };
    try { node.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault(); e.stopPropagation();
  }

  function moveText(e) {
    var loc = findTextClip(drag.clipId);
    if (!loc) { drag = null; return; }
    var bs = box();
    if (!bs.boxW || !bs.boxH) return;
    var dxPct = (e.clientX - drag.startX) / bs.boxW;
    var dyPct = (e.clientY - drag.startY) / bs.boxH;
    var patch = {};

    if (drag.mode === 'move') {
      patch.xPct = clamp(drag.orig.xPct + dxPct, -0.2, 1);   // 临时可越界(B6), 导出 clamp
      patch.yPct = clamp(drag.orig.yPct + dyPct, -0.2, 1);
    } else if (drag.mode === 'font') {
      patch.fontSizePct = clamp(drag.orig.fontSizePct + dyPct, 0.01, 0.5);
    } else if (drag.mode.indexOf('resize') === 0) {
      var corner = drag.mode.split('-')[1];                  // nw/ne/sw/se
      var signX = (corner === 'ne' || corner === 'se') ? 1 : -1;  // 右侧角向右拉变宽
      var newW = clamp(drag.orig.wPct + signX * dxPct, 0.05, 1.2);
      var ratio = drag.orig.wPct > 0 ? newW / drag.orig.wPct : 1;
      patch.wPct = newW;
      patch.fontSizePct = clamp(drag.orig.fontSizePct * ratio, 0.01, 0.5);
      if (signX < 0) {   // 左侧角: 左缘跟随移动以保持右缘不动
        patch.xPct = clamp(drag.orig.xPct - (newW - drag.orig.wPct), -0.2, 1);
      }
    }
    drag.lastPatch = patch;
    liveSetText(drag.clipId, patch);          // 即时可视化(不入栈, 不走 mutator)
    bus.emit('texts:changed', { id: drag.clipId });   // 触发属性面板回填
  }

  /* ---------- PiP 框: 选中视频片段时画 ---------- */
  function renderPipFrame() {
    if (!layer) return;
    if (_pipFrame && _pipFrame.parentNode) _pipFrame.parentNode.removeChild(_pipFrame);
    _pipFrame = null;
    var sel = selection();
    if (!sel || sel.kind !== 'clip' || !sel.clipId) return;
    var loc = findVideoClip(sel.clipId);
    if (!loc || !loc.media) return;

    var f = document.createElement('div');
    f.className = 'pip-frame';
    f.dataset.clipId = sel.clipId;
    if (sel.trackId != null) f.dataset.trackId = sel.trackId;
    ['nw', 'ne', 'sw', 'se'].forEach(function (pos) {
      var hd = document.createElement('div');
      hd.className = 'pip-handle ' + pos;
      hd.dataset.handle = pos;
      f.appendChild(hd);
    });
    layer.appendChild(f);
    _pipFrame = f;
    layoutPipFrame();
  }

  function layoutPipFrame() {
    if (!_pipFrame) return;
    var clipId = _pipFrame.dataset.clipId;
    var rect = (App.engine && App.engine.clipScreenRect) ? App.engine.clipScreenRect(clipId) : null;
    if (!rect) { _pipFrame.style.display = 'none'; return; }
    _pipFrame.style.display = '';
    _pipFrame.style.left = rect.x + 'px';
    _pipFrame.style.top = rect.y + 'px';
    _pipFrame.style.width = rect.w + 'px';
    _pipFrame.style.height = rect.h + 'px';
  }

  function startPipDrag(e, frame) {
    var clipId = frame.dataset.clipId;
    var loc = findVideoClip(clipId);
    if (!loc || !loc.media) return;
    var handle = e.target.dataset ? e.target.dataset.handle : null;
    var bs = box();
    var rect = App.engine.clipScreenRect(clipId);
    if (!rect) return;

    pushHistory();
    drag = {
      kind: 'video', clipId: clipId, trackId: loc.trackId,
      mode: handle ? ('scale-' + handle) : 'move',
      startX: e.clientX, startY: e.clientY,
      orig: {
        scale: loc.clip.scale != null ? loc.clip.scale : 1,
        cx: loc.clip.cx != null ? loc.clip.cx : 0.5,
        cy: loc.clip.cy != null ? loc.clip.cy : 0.5
      },
      srcW: loc.media.width, srcH: loc.media.height,
      origRect: rect, boxW: bs.boxW, boxH: bs.boxH
    };
    try { frame.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault(); e.stopPropagation();
  }

  function movePip(e) {
    var bs = drag.boxW ? { boxW: drag.boxW, boxH: drag.boxH } : box();
    if (!bs.boxW || !bs.boxH) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;

    if (drag.mode === 'move') {
      // 中心像素位移 → cx/cy (§5: cx = 新中心x / boxW)
      var origCenterX = drag.orig.cx * bs.boxW;
      var origCenterY = drag.orig.cy * bs.boxH;
      var cx = clamp((origCenterX + dx) / bs.boxW, -0.5, 1.5);  // 允许移出(导出裁剪 B5)
      var cy = clamp((origCenterY + dy) / bs.boxH, -0.5, 1.5);
      setTransform(drag.trackId, drag.clipId, { cx: cx, cy: cy });
    } else {
      // 角手柄等比缩放: 以片段中心为锚, 用拖拽对角线投影改宽度。
      // 新宽 = 原宽 + 角的水平位移 * 方向(向外为正), 中心不动。
      var corner = drag.mode.split('-')[1];        // nw/ne/sw/se
      var signX = (corner === 'ne' || corner === 'se') ? 1 : -1;
      // 中心锚定缩放: 角向外移宽度增加 2*|dx| 的水平分量。取水平位移为主驱动。
      var newWpx = drag.origRect.w + signX * dx * 2;
      if (newWpx < 8) newWpx = 8;
      var scale = clamp(newWpx / bs.boxW, 0.05, 4);  // §5: scale = 片段宽px / boxW
      setTransform(drag.trackId, drag.clipId, { scale: scale });
    }
    layoutPipFrame();
  }

  /* ---------- 指针移动/抬起 ---------- */
  function onPointerMove(e) {
    if (!drag) return;
    if (drag.kind === 'text') moveText(e);
    else if (drag.kind === 'video') movePip(e);
  }
  function onPointerUp() {
    if (!drag) return;
    if (drag.kind === 'text' && drag.lastPatch && App.setTextProp) {
      // 已 liveSetText 改了对象; 再走 mutator 落地一次(若它会再 pushHistory, 则与
      // pointerdown 的 pushHistory 合并为相邻两步, 可接受; 多数 mutator 用合并策略不重复压栈)
      commitTextPatch(drag.trackId, drag.clipId, drag.lastPatch);
    }
    drag = null;
  }

  /* =====================================================================
   * 双击编辑文本内容 (复用 v1)
   * ===================================================================== */
  function startEditing(node) {
    var clipId = node.dataset.clipId;
    var loc = findTextClip(clipId);
    if (!loc) return;
    // 进编辑前先选中
    var sel = selection();
    if (!sel || sel.clipId !== clipId) selectTextClip(loc.trackId, clipId);

    editing = clipId;
    pushHistory();   // 编辑内容算一个撤销步
    var content = node.querySelector('.tb-content') || node;
    content.setAttribute('contenteditable', 'true');
    content.style.outline = 'none';
    content.style.cursor = 'text';
    content.focus();
    var range = document.createRange();
    range.selectNodeContents(content);
    var selObj = window.getSelection();
    selObj.removeAllRanges();
    selObj.addRange(range);
    content.addEventListener('blur', onEditBlur);
    content.addEventListener('keydown', onEditKey);
  }
  function onEditKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finishEditing(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEditing(); }
    e.stopPropagation();   // 不让 shortcuts 拦截
  }
  function onEditBlur() { finishEditing(); }
  function finishEditing() {
    if (!editing) return;
    var clipId = editing;
    var loc = findTextClip(clipId);
    var node = layer.querySelector('.textbox[data-clip-id="' + cssEsc(clipId) + '"]');
    if (node && loc) {
      var content = node.querySelector('.tb-content') || node;
      var val = content.innerText.replace(/ /g, ' ').replace(/\r/g, '');
      content.removeEventListener('blur', onEditBlur);
      content.removeEventListener('keydown', onEditKey);
      content.removeAttribute('contenteditable');
      editing = null;
      setTextProp(loc.trackId, clipId, 'content', val);
      bus.emit('texts:changed', { id: clipId });
    } else {
      editing = null;
    }
  }

})();
