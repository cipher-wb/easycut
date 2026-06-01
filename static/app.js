/* =========================================================================
 * app.js — 唯一状态源 + 事件总线 + 后端 API 封装 + 派生时间轴
 * 必须最先加载。其余模块通过 window.App 访问状态、通过 App.bus 通信。
 * 数据模型严格遵循 _build/contract.md §1。
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------- 默认值（contract.md §1 / §7） ---------- */
  var DEFAULT_FONT = 'C:/Windows/Fonts/msyh.ttc';
  var FONT_CANDIDATES = [
    { name: '微软雅黑', path: 'C:/Windows/Fonts/msyh.ttc' },
    { name: '黑体 SimHei', path: 'C:/Windows/Fonts/simhei.ttf' },
    { name: '宋体 SimSun', path: 'C:/Windows/Fonts/simsun.ttc' },
    { name: '楷体 SimKai', path: 'C:/Windows/Fonts/simkai.ttf' },
    { name: '等线 DengXian', path: 'C:/Windows/Fonts/Deng.ttf' }
  ];

  /* ---------- 全局状态（== 导出请求体 body.project） ---------- */
  var project = {
    sources: [],
    clips: [],
    texts: [],
    output: { width: 1920, height: 1080, fps: 30, keepAudio: true, crf: 18 }
  };

  /* ---------- 派生时间轴索引（engine.md §1） ---------- */
  var timeline = { segments: [], totalDuration: 0 };
  var sourceById = new Map();

  function rebuildTimeline() {
    sourceById.clear();
    for (var i = 0; i < project.sources.length; i++) {
      sourceById.set(project.sources[i].id, project.sources[i]);
    }
    var segments = [];
    var acc = 0;
    for (var j = 0; j < project.clips.length; j++) {
      var clip = project.clips[j];
      var src = sourceById.get(clip.sourceId);
      if (!src) continue;
      var dur = clip.out - clip.in;
      if (!(dur > 0)) continue;
      segments.push({ clip: clip, source: src, timelineStart: acc, timelineEnd: acc + dur, dur: dur });
      acc += dur;
    }
    timeline = { segments: segments, totalDuration: acc };
    return timeline;
  }

  function totalDuration() { return timeline.totalDuration; }

  /* ---------- id 生成器 ---------- */
  var _ids = { clip: 0, text: 0 };
  function nextId(kind) { _ids[kind] = (_ids[kind] || 0) + 1; return kind + '_' + _ids[kind]; }

  /* ---------- 极简事件总线 ---------- */
  var listeners = {};
  var bus = {
    on: function (evt, fn) {
      (listeners[evt] || (listeners[evt] = [])).push(fn);
      return function () { bus.off(evt, fn); };
    },
    off: function (evt, fn) {
      var arr = listeners[evt]; if (!arr) return;
      var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
    },
    emit: function (evt, payload) {
      var arr = listeners[evt]; if (!arr) return;
      arr.slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[bus] ' + evt, e); }
      });
    }
  };

  /* ---------- 工具函数 ---------- */
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function toEven(n) { n = Math.round(n); n -= n % 2; return Math.max(2, n); }

  // 时间码 MM:SS.c
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var rest = s - m * 60;
    var sec = Math.floor(rest);
    var deci = Math.floor((rest - sec) * 10);
    return (m < 10 ? '0' + m : m) + ':' + (sec < 10 ? '0' + sec : sec) + '.' + deci;
  }

  /* ---------- 后端 API 封装 ---------- */
  function jsonFetch(url, opts) {
    opts = opts || {};
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : ('请求失败 (HTTP ' + res.status + ')');
          throw new Error(msg);
        }
        return data;
      });
    });
  }
  function postJson(url, body) {
    return jsonFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  var api = {
    fonts: function () { return jsonFetch('/api/fonts'); },
    pick: function (multiple) { return postJson('/api/pick', { multiple: !!multiple }); },
    pickSave: function (suggestName) { return postJson('/api/pick-save', { suggestName: suggestName }); },
    streamUrl: function (sourceId) { return '/api/stream?id=' + encodeURIComponent(sourceId); },
    exportProject: function (proj, outputPath) { return postJson('/api/export', { project: proj, outputPath: outputPath }); },
    exportStatus: function (jobId) { return jsonFetch('/api/export/status?id=' + encodeURIComponent(jobId)); }
  };

  /* ---------- toast 轻提示 ---------- */
  function toast(msg, kind, ms) {
    var box = document.getElementById('toast');
    if (!box) { console.log('[toast]', msg); return; }
    var el = document.createElement('div');
    el.className = 'toast-item' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s'; el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, ms || 3000);
  }

  /* ---------- 状态变更：sources / clips / texts ---------- */
  // 导入：把 ffprobe 返回的 sources 加入，并为每个新建一个整段 clip 追加到时间轴
  function addSources(sources) {
    if (!sources || !sources.length) return [];
    var addedSrcIds = [];
    var firstClipBefore = project.clips.length;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      // 后端生成 id；若重复则跳过登记但仍可再次建 clip（约定后端 id 唯一）
      if (!sourceById.has(s.id) && !project.sources.some(function (x) { return x.id === s.id; })) {
        project.sources.push(s);
      }
      addedSrcIds.push(s.id);
      var clip = { id: nextId('clip'), sourceId: s.id, in: 0, out: s.duration };
      project.clips.push(clip);
    }
    // 若导出分辨率尚未由用户改过且这是第一次有内容，按第一个 clip 源初始化 output
    maybeInitOutputFromFirstClip(firstClipBefore === 0);
    rebuildTimeline();
    bus.emit('sources:changed', { added: addedSrcIds });
    bus.emit('clips:changed', {});
    bus.emit('output:changed', {});
    return addedSrcIds;
  }

  var _outputUserTouched = false;
  function markOutputTouched() { _outputUserTouched = true; }
  function maybeInitOutputFromFirstClip(force) {
    if (_outputUserTouched && !force) return;
    if (!project.clips.length) return;
    var firstClip = project.clips[0];
    var src = project.sources.find(function (s) { return s.id === firstClip.sourceId; });
    if (!src) return;
    project.output.width = toEven(src.width || 1920);
    project.output.height = toEven(src.height || 1080);
    project.output.fps = Math.max(1, Math.round(src.fps || 30));
  }

  // 删除片段
  function removeClip(clipId) {
    var idx = project.clips.findIndex(function (c) { return c.id === clipId; });
    if (idx < 0) return false;
    project.clips.splice(idx, 1);
    rebuildTimeline();
    bus.emit('clips:changed', {});
    return true;
  }

  // 重排片段：把 fromIndex 移到 toIndex 前
  function reorderClip(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= project.clips.length) return;
    var moved = project.clips.splice(fromIndex, 1)[0];
    if (toIndex > fromIndex) toIndex--;
    toIndex = clamp(toIndex, 0, project.clips.length);
    project.clips.splice(toIndex, 0, moved);
    rebuildTimeline();
    bus.emit('clips:changed', {});
  }

  // 在时间轴时间 tOut 处分割对应 clip 为两段。返回 true 成功。
  function splitAt(tOut, preferClipId) {
    rebuildTimeline();
    var segs = timeline.segments;
    if (!segs.length) { toast('时间轴为空，无法分割', 'error'); return false; }
    // 找出 tOut 落在哪个 segment（半开区间）
    var target = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (tOut > s.timelineStart + 1e-6 && tOut < s.timelineEnd - 1e-6) { target = s; break; }
    }
    if (!target) {
      toast('请把播放头停在某个片段内部（不能在端点）再分割', 'error');
      return false;
    }
    var clip = target.clip;
    var srcCut = clip.in + (tOut - target.timelineStart); // 源内切点
    var minLen = Math.max(0.04, 1 / (project.output.fps || 30));
    if (srcCut - clip.in < minLen || clip.out - srcCut < minLen) {
      toast('切分位置过于靠近端点，两侧片段都需 ≥ ' + minLen.toFixed(2) + ' 秒', 'error');
      return false;
    }
    var idx = project.clips.indexOf(clip);
    var left = { id: nextId('clip'), sourceId: clip.sourceId, in: clip.in, out: srcCut };
    var right = { id: nextId('clip'), sourceId: clip.sourceId, in: srcCut, out: clip.out };
    project.clips.splice(idx, 1, left, right);
    rebuildTimeline();
    bus.emit('clips:changed', {});
    toast('已在 ' + fmtTime(tOut) + ' 处分割片段', 'ok', 1800);
    return true;
  }

  /* ---------- texts ---------- */
  function addText(opts) {
    opts = opts || {};
    var total = totalDuration();
    var start = opts.start != null ? opts.start : 0;
    var end = opts.end != null ? opts.end : Math.min(total, start + 3);
    if (end <= start) end = total > start ? total : start + 3;
    var tx = {
      id: nextId('text'),
      content: opts.content != null ? opts.content : '双击编辑文字',
      xPct: opts.xPct != null ? opts.xPct : 0.1,
      yPct: opts.yPct != null ? opts.yPct : 0.1,
      wPct: opts.wPct != null ? opts.wPct : 0.3,
      fontFile: opts.fontFile || DEFAULT_FONT,
      fontSizePct: opts.fontSizePct != null ? opts.fontSizePct : 0.05,
      color: opts.color || '#FFFFFF',
      opacity: opts.opacity != null ? opts.opacity : 1,
      align: opts.align || 'left',
      border: opts.border != null ? opts.border : false,
      borderColor: opts.borderColor || '#000000',
      borderWPct: opts.borderWPct != null ? opts.borderWPct : 0.004,
      box: opts.box != null ? opts.box : false,
      boxColor: opts.boxColor || '#000000',
      boxOpacity: opts.boxOpacity != null ? opts.boxOpacity : 0.5,
      start: start,
      end: end
    };
    project.texts.push(tx);
    bus.emit('texts:changed', { id: tx.id });
    return tx;
  }
  function getText(id) { return project.texts.find(function (t) { return t.id === id; }); }
  function removeText(id) {
    var i = project.texts.findIndex(function (t) { return t.id === id; });
    if (i < 0) return false;
    project.texts.splice(i, 1);
    bus.emit('texts:changed', {});
    return true;
  }

  /* ---------- output ---------- */
  function setOutput(patch) {
    Object.assign(project.output, patch);
    markOutputTouched();
    rebuildTimeline();
    bus.emit('output:changed', {});
  }

  /* ---------- B7: clips 改动后把 text.end clamp 到新 total ---------- */
  bus.on('clips:changed', function () {
    var total = totalDuration();
    project.texts.forEach(function (t) {
      if (t.end > total) t.end = total;
      if (t.start > total) t.start = Math.max(0, total - 0.1);
      if (t.end <= t.start) t.end = Math.min(total, t.start + 0.5);
    });
  });

  /* ---------- 导出前规范化 project（深拷贝 + clamp，contract.md §6） ---------- */
  function buildExportProject() {
    rebuildTimeline();
    var total = totalDuration();
    var p = JSON.parse(JSON.stringify(project));
    // 取偶（B15）
    p.output.width = toEven(p.output.width);
    p.output.height = toEven(p.output.height);
    p.output.fps = clamp(Math.round(p.output.fps), 1, 120);
    p.output.crf = clamp(Math.round(p.output.crf), 0, 51);
    // clip clamp（B4）
    p.clips.forEach(function (c) {
      var src = p.sources.find(function (s) { return s.id === c.sourceId; });
      if (src) { c.in = Math.max(0, c.in); c.out = Math.min(c.out, src.duration); }
    });
    p.clips = p.clips.filter(function (c) { return c.out > c.in; });
    // text clamp（B5/B6），过滤无效
    p.texts = p.texts.filter(function (t) {
      t.xPct = clamp01(t.xPct); t.yPct = clamp01(t.yPct);
      t.wPct = clamp(t.wPct, 0.02, 1);
      t.fontSizePct = clamp(t.fontSizePct, 0.01, 0.5);
      t.opacity = clamp01(t.opacity); t.boxOpacity = clamp01(t.boxOpacity);
      t.borderWPct = clamp(t.borderWPct, 0, 0.02);
      t.start = Math.max(0, t.start);
      t.end = Math.min(t.end, total);
      return t.end > t.start;
    });
    return p;
  }

  /* ---------- 空状态：启用/禁用顶栏按钮 ---------- */
  function refreshButtonStates() {
    var hasClips = timeline.segments.length > 0;
    var byId = function (id) { return document.getElementById(id); };
    [['btnAddText', !hasClips], ['btnExport', !hasClips], ['btnPlayPause', !hasClips],
     ['btnSplit', !hasClips], ['timelineScrubber', !hasClips]
    ].forEach(function (pair) {
      var el = byId(pair[0]); if (el) el.disabled = pair[1];
    });
    var sel = byId('btnDeleteClip');
    if (sel) sel.disabled = !(hasClips && App.selectedClipId);
    var hint = byId('emptyHint');
    if (hint) hint.style.display = hasClips ? 'none' : 'flex';
  }
  bus.on('clips:changed', refreshButtonStates);
  bus.on('sources:changed', refreshButtonStates);

  /* ---------- 导出公共 App ---------- */
  var App = {
    project: project,
    bus: bus,
    api: api,
    // 派生
    rebuildTimeline: rebuildTimeline,
    getTimeline: function () { return timeline; },
    totalDuration: totalDuration,
    sourceById: sourceById,
    // mutators
    addSources: addSources,
    removeClip: removeClip,
    reorderClip: reorderClip,
    splitAt: splitAt,
    addText: addText,
    getText: getText,
    removeText: removeText,
    setOutput: setOutput,
    markOutputTouched: markOutputTouched,
    buildExportProject: buildExportProject,
    nextId: nextId,
    // 选中态（跨模块共享）
    selectedClipId: null,
    selectedTextId: null,
    // 引擎引用（player.js 设置）
    engine: null,
    // box 尺寸（player.js 维护，overlay 用）
    getBoxSize: function () {
      var w = document.getElementById('videoWrap');
      return { boxW: (w && w.clientWidth) || 0, boxH: (w && w.clientHeight) || 0 };
    },
    // 工具
    clamp: clamp, clamp01: clamp01, toEven: toEven, fmtTime: fmtTime,
    toast: toast,
    DEFAULT_FONT: DEFAULT_FONT,
    FONT_CANDIDATES: FONT_CANDIDATES,
    refreshButtonStates: refreshButtonStates
  };
  window.App = App;

  /* =======================================================================
   * 顶栏交互 + 属性面板双向绑定（选中 text 时编辑各样式字段）
   * ===================================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    bindFontSelect();
    bindToolbar();
    bindPropPanel();
    bindOutputPanel();
    refreshButtonStates();
    syncOutputPanel();
  });

  function $(id) { return document.getElementById(id); }

  function bindFontSelect() {
    var sel = $('selFontFile');
    if (!sel) return;
    // 先用硬编码列表占位，保证下拉立即可用；随后用后端 /api/fonts 覆盖。
    populateFontSelect(sel, FONT_CANDIDATES);
    api.fonts().then(function (res) {
      var fonts = res && res.fonts;
      if (fonts && fonts.length) {
        // 后端只列“实际存在”的字体，与导出时的字体校验（ffmpeg_build B13）一致。
        populateFontSelect(sel, fonts);
        // 异步覆盖后，若当前选中的 text 仍有效，回填其字体值。
        if (App.selectedTextId) {
          var t = getText(App.selectedTextId);
          if (t) sel.value = t.fontFile;
        }
      }
    }).catch(function () {
      // 请求失败（如离线/后端异常）回退到硬编码列表，下拉已是该列表，无需重建。
    });
  }

  // 用 [{name,path}...] 填充字体下拉。
  function populateFontSelect(sel, fonts) {
    sel.innerHTML = '';
    fonts.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.path; o.textContent = f.name;
      sel.appendChild(o);
    });
  }

  function bindToolbar() {
    $('btnImport').addEventListener('click', function () {
      $('btnImport').disabled = true;
      api.pick(true).then(function (res) {
        var added = addSources((res && res.sources) || []);
        if (added.length) toast('已导入 ' + added.length + ' 个视频', 'ok', 1800);
        else toast('未选择文件', null, 1500);
      }).catch(function (e) {
        toast('导入失败：' + e.message, 'error');
      }).then(function () { $('btnImport').disabled = false; });
    });

    $('btnAddText').addEventListener('click', function () {
      if (!timeline.segments.length) return;
      var ph = App.engine ? App.engine.playhead : 0;
      var total = totalDuration();
      var tx = addText({
        content: '双击编辑文字',
        xPct: 0.25, yPct: 0.42, wPct: 0.5,
        start: clamp(ph, 0, total),
        end: clamp(ph + 3, 0.5, total)
      });
      // 选中并刷新预览/面板（overlay 监听 texts:changed 渲染，下面主动选中）
      bus.emit('text:selected', { id: tx.id });
      if (App.engine) { App.engine.seekTimeline(tx.start); }
      toast('已添加文字，可在画面中拖动、在右侧编辑', 'ok', 2200);
    });

    $('btnPlayPause').addEventListener('click', function () {
      if (App.engine) App.engine.toggle();
    });

    $('btnSplit').addEventListener('click', function () {
      var ph = App.engine ? App.engine.playhead : 0;
      splitAt(ph, App.selectedClipId);
    });

    $('btnDeleteClip').addEventListener('click', function () {
      if (!App.selectedClipId) { toast('请先在时间轴选中一个片段', null, 1600); return; }
      removeClip(App.selectedClipId);
      App.selectedClipId = null;
      refreshButtonStates();
    });

    $('btnExport').addEventListener('click', function () {
      bus.emit('export:open', {});
    });
  }

  /* ---------- 属性面板：选中 text -> 填充控件；控件改 -> 改 text ---------- */
  var propEls = {};
  function bindPropPanel() {
    propEls = {
      content: $('inpTextContent'),
      rngFont: $('rngFontSize'), numFont: $('numFontSize'),
      color: $('colTextColor'), opacity: $('rngTextOpacity'),
      align: $('selTextAlign'), font: $('selFontFile'),
      border: $('chkBorder'), borderColor: $('colBorderColor'), borderW: $('rngBorderW'),
      box: $('chkBox'), boxColor: $('colBoxColor'), boxOpacity: $('rngBoxOpacity'),
      start: $('numTextStart'), end: $('numTextEnd'),
      setStart: $('btnSetStartNow'), setEnd: $('btnSetEndNow'),
      del: $('btnDeleteText')
    };

    function cur() { return App.selectedTextId ? getText(App.selectedTextId) : null; }
    function changed() {
      bus.emit('texts:changed', { id: App.selectedTextId });
    }

    // content
    propEls.content.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.content = propEls.content.value; changed();
    });
    // fontSize（range 与 number 同步，number 以百分比显示）
    propEls.rngFont.addEventListener('input', function () {
      var t = cur(); if (!t) return;
      t.fontSizePct = parseFloat(propEls.rngFont.value);
      propEls.numFont.value = (t.fontSizePct * 100).toFixed(1);
      changed();
    });
    propEls.numFont.addEventListener('input', function () {
      var t = cur(); if (!t) return;
      var v = clamp((parseFloat(propEls.numFont.value) || 0) / 100, 0.01, 0.5);
      t.fontSizePct = v; propEls.rngFont.value = v; changed();
    });
    propEls.color.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.color = propEls.color.value.toUpperCase(); changed();
    });
    propEls.opacity.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.opacity = parseFloat(propEls.opacity.value); changed();
    });
    propEls.align.addEventListener('change', function () {
      var t = cur(); if (!t) return; t.align = propEls.align.value; changed();
    });
    propEls.font.addEventListener('change', function () {
      var t = cur(); if (!t) return; t.fontFile = propEls.font.value; changed();
    });
    propEls.border.addEventListener('change', function () {
      var t = cur(); if (!t) return; t.border = propEls.border.checked; changed();
    });
    propEls.borderColor.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.borderColor = propEls.borderColor.value.toUpperCase(); changed();
    });
    propEls.borderW.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.borderWPct = parseFloat(propEls.borderW.value); changed();
    });
    propEls.box.addEventListener('change', function () {
      var t = cur(); if (!t) return; t.box = propEls.box.checked; changed();
    });
    propEls.boxColor.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.boxColor = propEls.boxColor.value.toUpperCase(); changed();
    });
    propEls.boxOpacity.addEventListener('input', function () {
      var t = cur(); if (!t) return; t.boxOpacity = parseFloat(propEls.boxOpacity.value); changed();
    });
    propEls.start.addEventListener('change', function () {
      var t = cur(); if (!t) return;
      var v = Math.max(0, parseFloat(propEls.start.value) || 0);
      if (v >= t.end) v = Math.max(0, t.end - 0.1);
      t.start = v; propEls.start.value = v.toFixed(2); changed();
    });
    propEls.end.addEventListener('change', function () {
      var t = cur(); if (!t) return;
      var total = totalDuration();
      var v = clamp(parseFloat(propEls.end.value) || 0, t.start + 0.1, total || (t.start + 0.1));
      t.end = v; propEls.end.value = v.toFixed(2); changed();
    });
    propEls.setStart.addEventListener('click', function () {
      var t = cur(); if (!t || !App.engine) return;
      t.start = clamp(App.engine.playhead, 0, t.end - 0.1);
      fillPropPanel(t); changed();
    });
    propEls.setEnd.addEventListener('click', function () {
      var t = cur(); if (!t || !App.engine) return;
      t.end = clamp(App.engine.playhead, t.start + 0.1, totalDuration());
      fillPropPanel(t); changed();
    });
    propEls.del.addEventListener('click', function () {
      var t = cur(); if (!t) return;
      removeText(t.id);
      App.selectedTextId = null;
      bus.emit('text:selected', { id: null });
    });

    // 监听选中切换 -> 切面板
    bus.on('text:selected', function (p) {
      App.selectedTextId = p && p.id ? p.id : null;
      showPropPanel(App.selectedTextId);
    });
    // 文字属性被别处（拖拽/缩放）改动 -> 若是当前选中则回填面板
    bus.on('texts:changed', function (p) {
      if (App.selectedTextId && (!p || !p.id || p.id === App.selectedTextId)) {
        var t = getText(App.selectedTextId);
        if (t) fillPropPanel(t); else { App.selectedTextId = null; showPropPanel(null); }
      }
    });
  }

  function showPropPanel(textId) {
    var sec = $('propTextSection'), empty = $('propEmpty');
    if (textId) {
      var t = getText(textId);
      if (t) { sec.hidden = false; empty.style.display = 'none'; fillPropPanel(t); return; }
    }
    sec.hidden = true; empty.style.display = '';
  }

  function fillPropPanel(t) {
    propEls.content.value = t.content;
    propEls.rngFont.value = t.fontSizePct;
    propEls.numFont.value = (t.fontSizePct * 100).toFixed(1);
    propEls.color.value = normHex(t.color);
    propEls.opacity.value = t.opacity;
    propEls.align.value = t.align;
    propEls.font.value = t.fontFile;
    propEls.border.checked = !!t.border;
    propEls.borderColor.value = normHex(t.borderColor);
    propEls.borderW.value = t.borderWPct;
    propEls.box.checked = !!t.box;
    propEls.boxColor.value = normHex(t.boxColor);
    propEls.boxOpacity.value = t.boxOpacity;
    propEls.start.value = t.start.toFixed(2);
    propEls.end.value = t.end.toFixed(2);
  }
  function normHex(c) {
    if (!c) return '#000000';
    c = ('' + c).trim();
    if (c[0] !== '#') c = '#' + c;
    return c.length === 7 ? c.toLowerCase() : '#000000';
  }

  /* ---------- 输出面板绑定 ---------- */
  function bindOutputPanel() {
    var preset = $('selResPreset');
    var w = $('numOutWidth'), h = $('numOutHeight'), fps = $('numOutFps'),
        crf = $('numCrf'), audio = $('chkKeepAudio');

    function applyW() { setOutput({ width: toEven(parseInt(w.value, 10) || 2) }); }
    function applyH() { setOutput({ height: toEven(parseInt(h.value, 10) || 2) }); }
    w.addEventListener('change', function () { preset.value = 'custom'; applyW(); syncOutputPanel(); });
    h.addEventListener('change', function () { preset.value = 'custom'; applyH(); syncOutputPanel(); });
    fps.addEventListener('change', function () { setOutput({ fps: clamp(parseInt(fps.value, 10) || 30, 1, 120) }); syncOutputPanel(); });
    crf.addEventListener('change', function () { setOutput({ crf: clamp(parseInt(crf.value, 10) || 18, 0, 51) }); syncOutputPanel(); });
    audio.addEventListener('change', function () { setOutput({ keepAudio: audio.checked }); });

    preset.addEventListener('change', function () {
      var v = preset.value;
      if (v === '1920x1080') setOutput({ width: 1920, height: 1080 });
      else if (v === '1280x720') setOutput({ width: 1280, height: 720 });
      else if (v === 'source') {
        _outputUserTouched = false;
        maybeInitOutputFromFirstClip(true);
        markOutputTouched();
        rebuildTimeline();
        bus.emit('output:changed', {});
      }
      syncOutputPanel();
    });
  }

  function syncOutputPanel() {
    var w = $('numOutWidth'), h = $('numOutHeight'), fps = $('numOutFps'),
        crf = $('numCrf'), audio = $('chkKeepAudio');
    if (!w) return;
    w.value = project.output.width;
    h.value = project.output.height;
    fps.value = project.output.fps;
    crf.value = project.output.crf;
    audio.checked = !!project.output.keepAudio;
  }
  bus.on('output:changed', syncOutputPanel);

})();
