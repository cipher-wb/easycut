/* =========================================================================
 * overlay.js — 文字框 WYSIWYG 交互（拖动 / 缩放 / 编辑 / 选中）
 * 文字节点由 player.js buildTextNode 构建；本模块用事件委托接管交互。
 * 拖动改 xPct/yPct；角手柄改 wPct（并等比改 fontSizePct）；字号手柄单独改 fontSizePct。
 * 双击进入文本编辑；与右侧属性面板通过 App.selectedTextId + bus 联动。
 * 坐标基于 #videoWrap 的内容矩形（letterbox 后即视频显示矩形）。
 * ========================================================================= */
(function () {
  'use strict';
  var App = window.App;
  var bus = App.bus;

  var overlay, wrap;
  var drag = null;     // {mode, tx, startX, startY, orig}
  var editing = null;  // 正在编辑文本的 text id
  App.isEditingText = function () { return editing != null; };

  document.addEventListener('DOMContentLoaded', function () {
    overlay = document.getElementById('overlayLayer');
    wrap = document.getElementById('videoWrap');

    // 编辑文字时需要 overlay 接收事件；播放/未编辑时单条 .textbox 自身 pointer-events:auto 即可
    // overlay 容器默认 pointer-events:none（见 css），文字框本身 auto。

    // —— 选中 / 拖动开始 ——
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerUp);

    // —— 双击编辑文本 ——
    overlay.addEventListener('dblclick', function (e) {
      var node = e.target.closest('.textbox');
      if (!node) return;
      startEditing(node);
    });

    // 点击预览空白处取消选中（点到 stage 但不在 textbox 上）
    document.getElementById('stage').addEventListener('pointerdown', function (e) {
      if (e.target.closest('.textbox')) return;
      if (editing) finishEditing();
      if (App.selectedTextId) {
        App.selectedTextId = null;
        bus.emit('text:selected', { id: null });
      }
    }, true);
  });

  function boxSize() { return App.getBoxSize(); }
  function getText(id) { return App.getText(id); }

  /* ---------- 选中 + 拖动/缩放开始 ---------- */
  function onPointerDown(e) {
    var node = e.target.closest('.textbox');
    if (!node) return;
    var id = node.dataset.textId;
    var tx = getText(id);
    if (!tx) return;

    // 正在编辑同一条 -> 不拦截（让用户点光标）
    if (editing === id) return;

    // 选中
    if (App.selectedTextId !== id) {
      App.selectedTextId = id;
      bus.emit('text:selected', { id: id });
      // 重画会替换节点；重新获取当前节点
      node = overlay.querySelector('.textbox[data-text-id="' + cssEsc(id) + '"]') || node;
    }

    var handle = e.target.dataset ? e.target.dataset.handle : null;
    var mode = 'move';
    if (handle === 'font') mode = 'font';
    else if (handle) mode = 'resize-' + handle; // nw/ne/sw/se

    drag = {
      mode: mode,
      id: id,
      startX: e.clientX,
      startY: e.clientY,
      orig: { xPct: tx.xPct, yPct: tx.yPct, wPct: tx.wPct, fontSizePct: tx.fontSizePct }
    };
    try { node.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (!drag) return;
    var tx = getText(drag.id);
    if (!tx) { drag = null; return; }
    var bs = boxSize();
    if (!bs.boxW || !bs.boxH) return;
    var dxPct = (e.clientX - drag.startX) / bs.boxW;
    var dyPct = (e.clientY - drag.startY) / bs.boxH;

    if (drag.mode === 'move') {
      tx.xPct = App.clamp(drag.orig.xPct + dxPct, -0.2, 1); // 允许临时轻微越界（B5）
      tx.yPct = App.clamp(drag.orig.yPct + dyPct, -0.2, 1);
    } else if (drag.mode === 'font') {
      // 竖直拖动改字号（相对画面高度）
      var nf = App.clamp(drag.orig.fontSizePct + dyPct, 0.01, 0.5);
      tx.fontSizePct = nf;
    } else if (drag.mode.indexOf('resize') === 0) {
      var corner = drag.mode.split('-')[1]; // nw/ne/sw/se
      var signX = (corner === 'ne' || corner === 'se') ? 1 : -1; // 右侧角向右拉变宽
      var deltaW = signX * dxPct;
      var newW = App.clamp(drag.orig.wPct + deltaW, 0.05, 1.2);
      var ratio = drag.orig.wPct > 0 ? newW / drag.orig.wPct : 1;
      tx.wPct = newW;
      tx.fontSizePct = App.clamp(drag.orig.fontSizePct * ratio, 0.01, 0.5);
      // 左侧角拉伸时，左缘应跟随移动以保持右缘不动
      if (signX < 0) {
        var widthDeltaPct = (newW - drag.orig.wPct);
        tx.xPct = App.clamp(drag.orig.xPct - widthDeltaPct, -0.2, 1);
      }
    }
    // 强制刷新当前帧文字
    if (App.engine) { App.engine._forceTextRefresh = true; App.engine.renderTextsNow(); }
    // 通知属性面板回填（不重画 overlay 自身以外）
    bus.emit('texts:changed', { id: drag.id });
  }

  function onPointerUp() {
    if (drag) { drag = null; }
  }

  /* ---------- 双击编辑文本内容 ---------- */
  function startEditing(node) {
    var id = node.dataset.textId;
    var tx = getText(id);
    if (!tx) return;
    editing = id;
    var content = node.querySelector('.tb-content') || node;
    content.setAttribute('contenteditable', 'true');
    content.style.outline = 'none';
    content.style.cursor = 'text';
    content.focus();
    // 选中全部，便于直接覆盖默认占位文字
    var range = document.createRange();
    range.selectNodeContents(content);
    var selObj = window.getSelection();
    selObj.removeAllRanges();
    selObj.addRange(range);

    content.addEventListener('blur', onEditBlur);
    content.addEventListener('keydown', onEditKey);
  }
  function onEditKey(e) {
    // Esc 结束；Enter（不带 Shift）也结束；Shift+Enter 换行
    if (e.key === 'Escape') { e.preventDefault(); finishEditing(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEditing(); }
    e.stopPropagation();
  }
  function onEditBlur() { finishEditing(); }

  function finishEditing() {
    if (!editing) return;
    var id = editing;
    var node = overlay.querySelector('.textbox[data-text-id="' + cssEsc(id) + '"]');
    var tx = getText(id);
    if (node && tx) {
      var content = node.querySelector('.tb-content') || node;
      // 用 innerText 保留换行（\n），去掉多余尾部空白
      var val = content.innerText.replace(/ /g, ' ').replace(/\r/g, '');
      tx.content = val;
      content.removeEventListener('blur', onEditBlur);
      content.removeEventListener('keydown', onEditKey);
      content.removeAttribute('contenteditable');
    }
    editing = null;
    bus.emit('texts:changed', { id: id });
  }

  // 当 overlay 被 player.js 重画后，若正在编辑则需要重新进入编辑（避免节点被替换丢焦点）
  bus.on('overlay:rendered', function () {
    if (!editing) return;
    var node = overlay.querySelector('.textbox[data-text-id="' + cssEsc(editing) + '"]');
    if (!node) { editing = null; return; }
    var content = node.querySelector('.tb-content');
    if (content && content.getAttribute('contenteditable') !== 'true') {
      // 节点被重建，重新挂可编辑（不抢焦点以免打断输入；仅在用户再次双击时进入）
      // 这里保守处理：退出编辑态，避免与 rAF 重画冲突
      editing = null;
    }
  });

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return ('' + s).replace(/["\\]/g, '\\$&');
  }

})();
