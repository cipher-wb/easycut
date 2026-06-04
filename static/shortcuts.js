/* =========================================================================
 * shortcuts.js — v2 全局快捷键（剪映 / CapCut 风格）
 *
 * 权威依据：_build/contract_v2.md §7（键位表）+ §3.2（App API）+ §3.1（bus）。
 *           设计参考：_build/timeline_v2.md §11。
 *
 * 规则（contract §7）：全局 keydown 监听；**焦点在输入控件
 *   （input[type=text/number]/textarea/select/contenteditable）时**，
 *   仅放行 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Esc，其余（空格、Delete、方向键等）
 *   交给输入框默认行为，不拦截。所有改状态动作经 App.*（其内部自动入撤销栈）。
 *
 * 缩放与 timeline 解耦：emit('tl:zoom', ±1)（timeline.js 监听 setZoom）。
 * ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  if (!App) { return; }
  var bus = App.bus;

  /* ---------- 读 playhead / fps / 选中（容错 contract 代理与 engine 真值） ---------- */
  function playhead() {
    if (typeof App.getPlayhead === 'function') return App.getPlayhead() || 0;
    if (App.engine && typeof App.engine.playhead === 'number') return App.engine.playhead;
    return 0;
  }
  function fps() { var p = App.getProject ? App.getProject() : App.project; return (p && p.output && p.output.fps) || 30; }
  function frame() { return 1 / fps(); }
  function totalDuration() {
    if (typeof App.totalDuration === 'function') return App.totalDuration();
    if (typeof App.getTimeline === 'function') { var t = App.getTimeline(); if (t) return t.totalDuration || 0; }
    return 0;
  }
  // 当前选中片段 -> {trackId, clipId} 或 null（容错 contract getSelection 与 v1 selectedClipId）
  function selection() {
    if (typeof App.getSelection === 'function') {
      var s = App.getSelection();
      if (s && (s.kind === 'clip' || s.kind === 'text')) return { trackId: s.trackId, clipId: s.clipId };
      return null;
    }
    if (App.selectedClipId) return { trackId: null, clipId: App.selectedClipId };
    return null;
  }

  /* ---------- 动作封装：自动适配 contract（trackId,clipId）与旧（clipId）签名 ---------- */
  function withSel(fn) {
    var s = selection();
    if (!s || !s.clipId) { return; }
    fn(s);
  }

  function doSplit() {
    withSel(function (s) {
      if (typeof App.splitClip === 'function') {
        if (App.splitClip.length >= 3 || s.trackId != null) App.splitClip(s.trackId, s.clipId, playhead());
        else App.splitClip(s.clipId, playhead());
      } else if (typeof App.splitClipAt === 'function') App.splitClipAt(s.clipId, playhead());
      else if (typeof App.splitAt === 'function') App.splitAt(playhead(), s.clipId);
    });
  }
  function doDelete() {
    withSel(function (s) {
      if (typeof App.removeClip === 'function') {
        if (App.removeClip.length >= 2 || s.trackId != null) App.removeClip(s.trackId, s.clipId);
        else App.removeClip(s.clipId);
      }
    });
  }
  function doRipple() {
    withSel(function (s) {
      if (typeof App.rippleRemoveClip === 'function') {
        if (App.rippleRemoveClip.length >= 2 || s.trackId != null) App.rippleRemoveClip(s.trackId, s.clipId);
        else App.rippleRemoveClip(s.clipId);
      } else { doDelete(); }
    });
  }
  function doDuplicate() {
    withSel(function (s) {
      if (typeof App.duplicateClip === 'function') {
        if (App.duplicateClip.length >= 2 || s.trackId != null) App.duplicateClip(s.trackId, s.clipId);
        else App.duplicateClip(s.clipId);
      }
    });
  }
  function doCopy() {
    var s = selection(); if (!s) return;
    if (typeof App.copyClip === 'function') { (App.copyClip.length >= 2 || s.trackId != null) ? App.copyClip(s.trackId, s.clipId) : App.copyClip(s.clipId); }
  }
  function doPaste() {
    if (typeof App.pasteClip === 'function') App.pasteClip(playhead());
  }
  function doFreeze() {   // 定格：在播放头把选中（或播放头下）视频片段冻结成静止帧（就地插入）
    if (typeof App.freezeAtPlayhead === 'function') App.freezeAtPlayhead('inplace');
  }

  function togglePlay() {
    if (typeof App.togglePlay === 'function') App.togglePlay();
    else if (App.engine && typeof App.engine.toggle === 'function') App.engine.toggle();
    else bus.emit('play', {});
  }
  function seek(t) {
    t = Math.max(0, t);
    if (typeof App.seek === 'function') App.seek(t);
    else bus.emit('seek', t);
  }
  function stepFrame(dir) {
    if (typeof App.stepFrame === 'function') App.stepFrame(dir);
    else seek(playhead() + dir * frame());
  }
  function selectAdjacentTrack(dir) {
    if (typeof App.selectAdjacentTrack === 'function') App.selectAdjacentTrack(dir);
  }
  function clearSelection() {
    if (typeof App.clearSelection === 'function') App.clearSelection();
    else if (typeof App.selectClip === 'function') { try { App.selectClip(null); } catch (x) {} }
  }
  function undo() { if (typeof App.undo === 'function') App.undo(); }
  function redo() { if (typeof App.redo === 'function') App.redo(); }
  function openExport() {
    bus.emit('export:open', {});
    var b = document.getElementById('btnExport'); if (b && !b.disabled) { /* export.js 也监听 export:open */ }
  }
  // 工程系统：保存 / 另存为经 bus 解耦（projects.js 监听 project:save / project:saveAs）。
  function saveProject() { bus.emit('project:save', {}); }
  function saveAsProject() { bus.emit('project:saveAs', {}); }
  function zoomIn() { bus.emit('tl:zoom', +1); }
  function zoomOut() { bus.emit('tl:zoom', -1); }

  /* =======================================================================
   * 快捷键说明面板（与下方 TABLE 同源维护）
   * ===================================================================== */
  var HELP_GROUPS = [
    { title: '播放 / 定位', items: [
      ['空格', '播放 / 暂停'],
      ['← / →', '后退 / 前进一帧'],
      ['Shift + ← / →', '后退 / 前进 1 秒'],
      ['Home / End', '跳到开头 / 结尾'],
    ] },
    { title: '剪辑片段', items: [
      ['Ctrl + B', '在播放头处分割选中片段'],
      ['Delete', '删除选中片段（留空隙）'],
      ['Backspace', '波纹删除（删除并使后续片段前移补缝）'],
      ['Ctrl + C / Ctrl + V', '复制 / 粘贴片段到播放头'],
      ['Ctrl + D', '原地复制一份片段'],
      ['Shift + F', '定格：把播放头处那一帧冻结成静止画面（就地插入）'],
      ['按住 Shift 拖片段右边缘', '变速（拉长变慢 / 拉短变快，0.25×–4×）'],
    ] },
    { title: '选择 / 撤销', items: [
      ['↑ / ↓', '选择上层 / 下层轨道的片段'],
      ['Esc', '取消选中'],
      ['Ctrl + Z', '撤销'],
      ['Ctrl + Shift + Z / Ctrl + Y', '重做'],
    ] },
    { title: '工程', items: [
      ['Ctrl + S', '保存工程'],
      ['Ctrl + Shift + S', '另存为'],
      ['Ctrl + E', '导出'],
    ] },
    { title: '视图 / 其它', items: [
      ['+ / -', '放大 / 缩小时间轴'],
      ['F1 / ?', '显示本快捷键说明'],
    ] },
  ];

  var helpDlg = null;
  function buildHelp() {
    var dlg = document.createElement('dialog');
    dlg.id = 'shortcutsDialog';
    var h = '<div class="sc-head"><span class="sc-title">⌨ 快捷键</span>' +
            '<button type="button" class="sc-close" id="scClose">关闭</button></div><div class="sc-body">';
    HELP_GROUPS.forEach(function (g) {
      h += '<div class="sc-group"><div class="sc-gtitle">' + g.title + '</div><table class="sc-table">';
      g.items.forEach(function (it) {
        var keys = '<kbd>' + it[0].replace(/ \/ /g, '</kbd> / <kbd>') + '</kbd>';
        h += '<tr><td class="sc-keys">' + keys + '</td><td class="sc-desc">' + it[1] + '</td></tr>';
      });
      h += '</table></div>';
    });
    h += '</div><div class="sc-foot">提示：在输入框里打字时，仅 Ctrl+Z / 重做 / Esc 生效，其余按键用于正常输入。</div>';
    dlg.innerHTML = h;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) closeHelp(); });
    var cb = dlg.querySelector('#scClose'); if (cb) cb.addEventListener('click', closeHelp);
    return dlg;
  }
  function showHelp() {
    if (!helpDlg) helpDlg = buildHelp();
    if (typeof helpDlg.showModal === 'function') { if (!helpDlg.open) helpDlg.showModal(); }
    else helpDlg.setAttribute('open', '');
  }
  function closeHelp() {
    if (!helpDlg) return;
    if (typeof helpDlg.close === 'function') { if (helpDlg.open) helpDlg.close(); }
    else helpDlg.removeAttribute('open');
  }
  if (App) App.showShortcuts = showHelp;

  /* =======================================================================
   * 键位表（contract §7）—— key 规范化字符串
   * ===================================================================== */
  var TABLE = {
    'space'           : function (e) { e.preventDefault(); togglePlay(); },
    'ctrl+b'          : function (e) { e.preventDefault(); doSplit(); },
    'delete'          : function (e) { e.preventDefault(); doDelete(); },
    'backspace'       : function (e) { e.preventDefault(); doRipple(); },

    'arrowleft'       : function () { seek(playhead() - frame()); },        // 后退一帧
    'arrowright'      : function () { seek(playhead() + frame()); },        // 前进一帧
    'shift+arrowleft' : function () { seek(playhead() - 1); },              // 后退 1s
    'shift+arrowright': function () { seek(playhead() + 1); },              // 前进 1s
    'arrowup'         : function (e) { e.preventDefault(); selectAdjacentTrack(+1); }, // 向上层
    'arrowdown'       : function (e) { e.preventDefault(); selectAdjacentTrack(-1); }, // 向下层

    'ctrl+z'          : function (e) { e.preventDefault(); undo(); },
    'ctrl+shift+z'    : function (e) { e.preventDefault(); redo(); },
    'ctrl+y'          : function (e) { e.preventDefault(); redo(); },

    'ctrl+c'          : function () { doCopy(); },
    'ctrl+v'          : function () { doPaste(); },
    'ctrl+d'          : function (e) { e.preventDefault(); doDuplicate(); },
    'shift+f'         : function (e) { e.preventDefault(); doFreeze(); },        // 定格（就地）

    '+'               : function (e) { e.preventDefault(); zoomIn(); },
    '='               : function (e) { e.preventDefault(); zoomIn(); },
    '-'               : function (e) { e.preventDefault(); zoomOut(); },
    '_'               : function (e) { e.preventDefault(); zoomOut(); },

    'home'            : function (e) { e.preventDefault(); seek(0); },
    'end'             : function (e) { e.preventDefault(); seek(totalDuration()); },

    'ctrl+s'          : function (e) { e.preventDefault(); saveProject(); },     // 保存工程（原导出已改 Ctrl+E）
    'ctrl+shift+s'    : function (e) { e.preventDefault(); saveAsProject(); },    // 另存为（与 redo 的 ctrl+shift+z 按 key 区分，不冲突）
    'ctrl+e'          : function (e) { e.preventDefault(); openExport(); },       // 导出（原 Ctrl+S 的功能迁移至此）
    'escape'          : function () { clearSelection(); },
    'ctrl+a'          : function (e) { /* 全选当前轨片段（可选，未实现）*/ },

    'f1'              : function (e) { e.preventDefault(); showHelp(); },
    '?'               : function (e) { e.preventDefault(); showHelp(); },
    'shift+?'         : function (e) { e.preventDefault(); showHelp(); }
  };

  /* ---------- 规范化组合键 ---------- */
  function normalize(e) {
    var k = (e.key || '').toLowerCase();
    if (k === ' ' || k === 'spacebar') k = 'space';
    var parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');   // Mac 兼容（项目仅 Win，无害）
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    parts.push(k);
    return parts.join('+');
  }

  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var type = (t.type || 'text').toLowerCase();
      // 这些 input 类型按“正在输入”处理，放行其默认按键
      return ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].indexOf(type) >= 0;
    }
    return false;
  }

  // 输入框聚焦时仍放行的全局键（contract §7：仅撤销/重做/Esc）
  var ALLOW_WHILE_TYPING = { 'ctrl+z': 1, 'ctrl+shift+z': 1, 'ctrl+y': 1, 'escape': 1, 'ctrl+s': 1, 'ctrl+shift+s': 1 };
  // AI 执行期间仅放行"查看/导航类"键，编辑类一律拦下（避免与 AI 改动冲突）
  var ALLOW_WHILE_BUSY = {
    'space': 1, 'arrowleft': 1, 'arrowright': 1, 'shift+arrowleft': 1, 'shift+arrowright': 1,
    'arrowup': 1, 'arrowdown': 1, '+': 1, '=': 1, '-': 1, '_': 1, 'home': 1, 'end': 1,
    'escape': 1, 'f1': 1, '?': 1, 'shift+?': 1
  };

  document.addEventListener('keydown', function (e) {
    var combo = normalize(e);

    // AI 执行期间禁止手动编辑：拦下编辑类快捷键
    if (App.isBusy && App.isBusy() && !ALLOW_WHILE_BUSY[combo]) {
      if (TABLE[combo] && !isTyping(e)) e.preventDefault();
      return;
    }

    if (isTyping(e)) {
      if (combo === 'escape') { if (e.target && e.target.blur) e.target.blur(); return; }
      if (!ALLOW_WHILE_TYPING[combo]) return;   // 其余交给输入框默认行为
      // 撤销/重做：阻止输入框原生 undo，改走应用撤销栈
      var fn0 = TABLE[combo];
      if (fn0) { e.preventDefault(); fn0(e); }
      return;
    }

    var fn = TABLE[combo];
    if (fn) fn(e);
  });

  /* 工具栏「⌨ 快捷键」按钮 → 打开说明面板 */
  function bindHelpBtn() {
    var b = document.getElementById('btnShortcuts');
    if (b) b.addEventListener('click', showHelp);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindHelpBtn);
  else bindHelpBtn();

})();
