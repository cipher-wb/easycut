/* =========================================================================
 * timeline.js — 底部时间轴（clip 色块渲染 + 交互）
 * 块宽按时长比例；选中 / 删除 / 拖动重排 / 在播放头分割；刻度尺 + 播放头 + 滑块定位。
 * DOM id 按 contract.md §4.4。
 * ========================================================================= */
(function () {
  'use strict';
  var App = window.App;
  var bus = App.bus;

  var trackEl, rulerEl, playheadEl, scrubberEl;
  var dragFromIndex = -1;

  document.addEventListener('DOMContentLoaded', function () {
    trackEl = document.getElementById('timelineTrack');
    rulerEl = document.getElementById('timelineRuler');
    playheadEl = document.getElementById('playhead');
    scrubberEl = document.getElementById('timelineScrubber');

    // 点击轨道空白处定位播放头
    trackEl.addEventListener('click', function (e) {
      if (e.target.closest('.clip')) return; // 点中片段由片段处理选中
      seekByClientX(e.clientX);
    });

    // 滑块定位
    scrubberEl.addEventListener('input', function () {
      bus.emit('seek', parseFloat(scrubberEl.value) || 0);
    });

    bus.on('clips:changed', render);
    bus.on('sources:changed', render);
    bus.on('time:update', updatePlayhead);
    bus.on('output:changed', function () { /* fps 影响刻度无关紧要 */ });

    render();
  });

  /* ---------- 渲染 clip 色块 ---------- */
  function render() {
    if (!trackEl) return;
    App.rebuildTimeline();
    var tl = App.getTimeline();
    var total = tl.totalDuration;

    // 清空（保留 playhead 节点）
    var nodes = trackEl.querySelectorAll('.clip');
    nodes.forEach(function (n) { n.remove(); });

    var trackWidth = trackEl.clientWidth || 600;
    // 用 flex-basis 百分比，让块宽随容器自适应、按时长比例
    tl.segments.forEach(function (seg, idx) {
      var clip = seg.clip;
      var src = seg.source;
      var el = document.createElement('div');
      el.className = 'clip';
      el.dataset.clipId = clip.id;
      el.dataset.index = idx;
      el.draggable = true;
      if (App.selectedClipId === clip.id) el.classList.add('selected');
      var pct = total > 0 ? (seg.dur / total) * 100 : 100 / tl.segments.length;
      el.style.flex = '0 0 ' + pct + '%';

      var name = document.createElement('div');
      name.className = 'clip-name';
      name.textContent = baseName(src.path);
      name.title = baseName(src.path) + '  [' + App.fmtTime(clip.in) + ' → ' + App.fmtTime(clip.out) + ']';

      var dur = document.createElement('div');
      dur.className = 'clip-dur';
      dur.textContent = App.fmtTime(seg.dur);

      el.appendChild(name);
      el.appendChild(dur);
      bindClipEvents(el, clip.id, idx);
      // 插到 playhead 之前
      trackEl.insertBefore(el, playheadEl);
    });

    // 刻度尺
    renderRuler(total);

    // 滑块范围
    scrubberEl.min = 0;
    scrubberEl.max = total > 0 ? total : 0;
    scrubberEl.step = 0.01;
    scrubberEl.disabled = !(total > 0);
    if (parseFloat(scrubberEl.value) > total) scrubberEl.value = total;

    // 校正选中态
    if (App.selectedClipId && !tl.segments.some(function (s) { return s.clip.id === App.selectedClipId; })) {
      App.selectedClipId = null;
    }
    App.refreshButtonStates();
    updatePlayhead(App.engine ? App.engine.playhead : 0);
  }

  function renderRuler(total) {
    rulerEl.innerHTML = '';
    if (total <= 0) return;
    // 选择合适刻度间隔（秒）
    var targetTicks = 8;
    var raw = total / targetTicks;
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (steps[i] >= raw) { step = steps[i]; break; } }
    for (var t = 0; t <= total + 1e-6; t += step) {
      var tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = (t / total * 100) + '%';
      tick.textContent = App.fmtTime(t);
      rulerEl.appendChild(tick);
    }
  }

  /* ---------- 单个 clip 交互：选中 / 拖动重排 ---------- */
  function bindClipEvents(el, clipId, idx) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      selectClip(clipId);
    });

    el.addEventListener('dragstart', function (e) {
      dragFromIndex = idx;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idx)); } catch (x) {}
    });
    el.addEventListener('dragend', function () {
      el.classList.remove('dragging');
      clearDropMarks();
      dragFromIndex = -1;
    });
    el.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      var before = isBeforeHalf(e, el);
      el.classList.add(before ? 'drop-before' : 'drop-after');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-before', 'drop-after'); });
    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks();
      if (dragFromIndex < 0) return;
      var before = isBeforeHalf(e, el);
      var toIndex = idx + (before ? 0 : 1);
      App.reorderClip(dragFromIndex, toIndex);
      App.selectedClipId = clipId; // 保持选中被移动者不易，简单保留点中者
    });
  }

  function isBeforeHalf(e, el) {
    var r = el.getBoundingClientRect();
    return (e.clientX - r.left) < r.width / 2;
  }
  function clearDropMarks() {
    trackEl.querySelectorAll('.clip').forEach(function (c) { c.classList.remove('drop-before', 'drop-after'); });
  }

  function selectClip(clipId) {
    App.selectedClipId = clipId;
    trackEl.querySelectorAll('.clip').forEach(function (c) {
      c.classList.toggle('selected', c.dataset.clipId === clipId);
    });
    App.refreshButtonStates();
  }

  /* ---------- 播放头位置 ---------- */
  function updatePlayhead(ph) {
    if (!playheadEl) return;
    var total = App.getTimeline().totalDuration;
    var trackW = trackEl.clientWidth || 1;
    // playhead 在 track 内（track 含 padding 6px；用百分比近似铺满轨道宽）
    var pct = total > 0 ? App.clamp(ph / total, 0, 1) : 0;
    playheadEl.style.left = (pct * trackW) + 'px';
    if (scrubberEl && document.activeElement !== scrubberEl) {
      scrubberEl.value = App.clamp(ph, 0, total);
    }
  }

  function seekByClientX(clientX) {
    var total = App.getTimeline().totalDuration;
    if (total <= 0) return;
    var r = trackEl.getBoundingClientRect();
    var x = App.clamp((clientX - r.left) / r.width, 0, 1);
    bus.emit('seek', x * total);
  }

  function baseName(p) {
    if (!p) return '片段';
    var s = ('' + p).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.substring(i + 1) : s;
  }

})();
