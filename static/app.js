/* =========================================================================
 * app.js — v2 多轨非线性编辑器：唯一状态源 + 撤销重做 + 事件总线 +
 *           后端 API 封装 + 素材库 + 导入(拖拽上传/picker) + 派生时间轴 +
 *           属性面板双向绑定 + 导出前规范化。
 *
 * 必须最先加载。其余模块(player/timeline/overlay/shortcuts/export)通过
 * window.App 访问状态、通过 App.bus 通信。严格遵循 _build/contract_v2.md。
 *
 * 核心约定(contract_v2 §3)：
 *   - 修改 project 的唯一途径是调用 App.* mutator。
 *   - 结构性 mutator 内部在“改动前” pushHistory() 一次，改完 emit('project:changed')。
 *   - project 对象引用恒定不变(undo/redo 就地重填，不替换引用)。
 * ========================================================================= */
(function () {
  'use strict';

  /* ===================================================================== *
   * 0. 常量 / 默认值（contract_v2 §1 / §6.1 / §8）
   * ===================================================================== */
  var DEFAULT_FONT = 'C:/Windows/Fonts/msyh.ttc';
  var FONT_CANDIDATES = [
    { name: '微软雅黑', path: 'C:/Windows/Fonts/msyh.ttc' },
    { name: '微软雅黑 Bold', path: 'C:/Windows/Fonts/msyhbd.ttc' },
    { name: '黑体 SimHei', path: 'C:/Windows/Fonts/simhei.ttf' },
    { name: '宋体 SimSun', path: 'C:/Windows/Fonts/simsun.ttc' },
    { name: '楷体 SimKai', path: 'C:/Windows/Fonts/simkai.ttf' },
    { name: '仿宋 SimFang', path: 'C:/Windows/Fonts/simfang.ttf' },
    { name: '等线 DengXian', path: 'C:/Windows/Fonts/Deng.ttf' }
  ];
  var SNAP_PX = 8;            // 磁吸命中阈值（屏幕像素）—— timeline 用
  var HISTORY_MAX = 100;     // 撤销栈上限（contract_v2 §6.1）

  function MIN_CLIP() { return Math.max(1 / (project.output.fps || 30), 0.04); }

  /* ===================================================================== *
   * 1. 全局状态对象 project（== 导出请求体 body.project，contract_v2 §1）
   *    引用恒定：undo/redo 时就地重填，绝不整体替换。
   * ===================================================================== */
  var project = {
    output: { width: 1920, height: 1080, fps: 30, crf: 18, keepAudio: true },
    media: [],
    tracks: []
  };

  // 默认两条视频轨（contract_v2 §1.3）。
  function initDefaultTracks() {
    project.tracks.push(makeTrack('video', '视频 1'));
    project.tracks.push(makeTrack('video', '视频 2'));
  }

  /* ===================================================================== *
   * 2. id 生成器（前端生成 trk_/clip_/txt_；med_/src_ 由后端生成）
   * ===================================================================== */
  var _ids = { trk: 0, clip: 0, txt: 0, med: 0, src: 0 };
  function nextId(kind) { _ids[kind] = (_ids[kind] || 0) + 1; return kind + '_' + _ids[kind]; }
  // 导入后端 id 时同步本地计数器，避免前端再生成与后端冲突。
  function bumpIdCounter(kind, id) {
    if (!id) return;
    var m = /_(\d+)$/.exec('' + id);
    if (m) { var n = parseInt(m[1], 10); if (n > (_ids[kind] || 0)) _ids[kind] = n; }
  }

  /* ===================================================================== *
   * 3. 事件总线（contract_v2 §3.1）
   * ===================================================================== */
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

  /* ===================================================================== *
   * 4. 工具函数（复用 v1 已实测可靠逻辑）
   * ===================================================================== */
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function toEven(n) { n = Math.floor(n); n -= n % 2; return Math.max(2, n); }
  function num(v, dflt) { var x = parseFloat(v); return isFinite(x) ? x : dflt; }

  // 时间码 MM:SS.cc（百分秒，contract_v2 §8）
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var rest = s - m * 60;
    var sec = Math.floor(rest);
    var cc = Math.floor((rest - sec) * 100);
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    return p2(m) + ':' + p2(sec) + '.' + p2(cc);
  }
  function normHex(c) {
    if (!c) return '#000000';
    c = ('' + c).trim();
    if (c[0] !== '#') c = '#' + c;
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : '#000000';
  }

  /* ===================================================================== *
   * 5. 后端 API 封装（contract_v2 §2 / §3.2 App.api.*）
   * ===================================================================== */
  function jsonFetch(url, opts) {
    opts = opts || {};
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : ('请求失败 (HTTP ' + res.status + ')');
          var err = new Error(msg); err.status = res.status; throw err;
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
    pick: function (multiple) { return postJson('/api/pick', { multiple: !!multiple }); },
    pickSave: function (suggestName) { return postJson('/api/pick-save', { suggestName: suggestName }); },
    upload: function (file) {
      var fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('name', file.name);
      return jsonFetch('/api/upload', { method: 'POST', body: fd });
    },
    fonts: function () { return jsonFetch('/api/fonts'); },
    export: function (proj, outputPath) { return postJson('/api/export', { project: proj, outputPath: outputPath }); },
    exportStatus: function (jobId) { return jsonFetch('/api/export/status?id=' + encodeURIComponent(jobId)); },
    streamUrl: function (streamId) { return '/api/stream?id=' + encodeURIComponent(streamId); },
    thumbUrl: function (mediaId) { return '/api/thumb?id=' + encodeURIComponent(mediaId); }
  };

  /* ===================================================================== *
   * 6. toast 轻提示（emit 'toast' 也可触达；这里直接渲染）
   * ===================================================================== */
  function toast(msg, kind, ms) {
    // 归一 kind：contract 用 info/error；v1 用 ok/warn/error。
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
  bus.on('toast', function (p) { if (p && p.msg) toast(p.msg, p.type || 'info'); });

  /* ===================================================================== *
   * 7. 工厂：track / video-clip / text-clip（默认值 contract_v2 §1.3~§1.5）
   * ===================================================================== */
  function makeTrack(kind, name) {
    return {
      id: nextId('trk'),
      kind: kind,
      name: name || (kind === 'video' ? '视频' : '文字'),
      muted: false,
      volume: 1.0,
      hidden: false,
      locked: false,
      clips: []
    };
  }

  // contain 默认变换（contract_v2 §5.2）
  function defaultTransform(srcW, srcH, OW, OH) {
    var canvasAR = OW / OH, srcAR = srcW / srcH;
    var scale = (srcAR >= canvasAR) ? 1.0 : srcAR * (OH / OW);
    return { scale: scale, cx: 0.5, cy: 0.5, opacity: 1.0 };
  }

  /* ===================================================================== *
   * 8. 派生时间轴索引（contract_v2 §1.6 + engine_v2 §1）
   *    getTimeline() 返回超集，兼容 contract(§3.2) 与 engine 两套形状：
   *      { totalDuration, tracks:[{trackId,kind,dur}], segmentsByTrack,
   *        videoTracks:[{track,clips:[{clip,media,tStart,tEnd}]}],
   *        textClips:[{clip,track}], mediaById }
   * ===================================================================== */
  var timeline = {
    totalDuration: 0, tracks: [], segmentsByTrack: {},
    videoTracks: [], textClips: [], mediaById: new Map()
  };

  function clipDur(clip, track) {
    if (track.kind === 'text') return clip.duration || 0;
    // 公式 A（speed_design.md §0.2）：视频片段时间轴长度 = (out - in) / speed。
    return (clip.out - clip.in) / (clip.speed || 1);
  }

  function rebuildTimeline() {
    var mediaById = new Map();
    for (var i = 0; i < project.media.length; i++) mediaById.set(project.media[i].id, project.media[i]);

    var videoTracks = [], textClips = [], total = 0;
    var tracksDerived = [], segmentsByTrack = {};

    for (var ti = 0; ti < project.tracks.length; ti++) {
      var track = project.tracks[ti];
      var trackDur = 0;
      var segList = [];
      if (track.kind === 'video') {
        var segs = [];
        for (var ci = 0; ci < track.clips.length; ci++) {
          var clip = track.clips[ci];
          var media = mediaById.get(clip.mediaId);
          if (!media) continue;
          // 公式 A：视频段时间轴长度 = (out-in)/speed（tEnd/total/trackDur 随之正确，总时长贯穿点）。
          var dur = (clip.out - clip.in) / (clip.speed || 1);
          if (!(dur > 0)) continue;
          var tStart = clip.start, tEnd = clip.start + dur;
          var seg = { clip: clip, media: media, tStart: tStart, tEnd: tEnd, dur: dur };
          segs.push(seg);
          segList.push(seg);
          if (tEnd > total) total = tEnd;
          if (tEnd > trackDur) trackDur = tEnd;
        }
        segs.sort(function (a, b) { return a.tStart - b.tStart; });
        videoTracks.push({ track: track, clips: segs });
      } else if (track.kind === 'text') {
        for (var k = 0; k < track.clips.length; k++) {
          var tc = track.clips[k];
          var d = tc.duration || 0;
          if (!(d > 0)) continue;
          var teS = tc.start, teE = tc.start + d;
          var tseg = { clip: tc, media: null, track: track, tStart: teS, tEnd: teE, dur: d };
          textClips.push({ clip: tc, track: track });
          segList.push(tseg);
          if (teE > total) total = teE;
          if (teE > trackDur) trackDur = teE;
        }
      }
      tracksDerived.push({ trackId: track.id, kind: track.kind, dur: trackDur });
      segmentsByTrack[track.id] = segList;
    }
    timeline = {
      totalDuration: total,
      tracks: tracksDerived,
      segmentsByTrack: segmentsByTrack,
      videoTracks: videoTracks,
      textClips: textClips,
      mediaById: mediaById
    };
    return timeline;
  }
  function getTimeline() { return timeline; }
  function totalDuration() { return timeline.totalDuration; }

  /* ===================================================================== *
   * 9. 定位辅助（按 clipId 查所在轨与片段；按 trackId 查轨）
   * ===================================================================== */
  function getTrack(trackId) {
    for (var i = 0; i < project.tracks.length; i++) if (project.tracks[i].id === trackId) return project.tracks[i];
    return null;
  }
  function trackIndex(trackId) {
    for (var i = 0; i < project.tracks.length; i++) if (project.tracks[i].id === trackId) return i;
    return -1;
  }
  function getClipIn(trackId, clipId) {
    var t = getTrack(trackId); if (!t) return null;
    for (var i = 0; i < t.clips.length; i++) if (t.clips[i].id === clipId) return t.clips[i];
    return null;
  }
  // 只给 clipId 时全局定位（timeline_v2 风格）
  function locateClip(clipId) {
    for (var i = 0; i < project.tracks.length; i++) {
      var t = project.tracks[i];
      for (var j = 0; j < t.clips.length; j++) if (t.clips[j].id === clipId) return { track: t, clip: t.clips[j], index: j };
    }
    return null;
  }
  function getMedia(mediaId) {
    for (var i = 0; i < project.media.length; i++) if (project.media[i].id === mediaId) return project.media[i];
    return null;
  }

  /* ===================================================================== *
   * 10. 撤销 / 重做（contract_v2 §6.8）
   *     - 快照 = project 深拷贝；undoStack/redoStack；HISTORY_MAX=100。
   *     - mutator 改动前 pushHistory()（压入改动前状态）。
   *     - undo：当前压 redo，弹 undo 顶覆盖当前（就地重填，引用不变）。
   * ===================================================================== */
  var undoStack = [], redoStack = [];

  // 撤销快照只含“项目编辑内容”= output + tracks（contract_v2 §6.8）。
  // media（素材库）独立管理、不参与 undo/redo（addMedia/removeMedia 不入栈），
  // 故快照不含 media——否则撤销一次片段编辑会把之后导入的素材一并回退。
  function snapshot() { return JSON.parse(JSON.stringify({ output: project.output, tracks: project.tracks })); }

  // 就地把 project 内容替换为 snap（保持 project 引用与 output/tracks 数组引用）。
  // 不触碰 project.media（媒体库不在快照内）。
  function restoreInPlace(snap) {
    // output：逐字段写回（保留对象引用）
    var o = project.output, so = snap.output;
    for (var ko in so) if (so.hasOwnProperty(ko)) o[ko] = so[ko];
    // tracks：清空重填（保持数组引用）
    project.tracks.length = 0;
    for (var j = 0; j < snap.tracks.length; j++) project.tracks.push(snap.tracks[j]);
  }

  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
    refreshUndoRedoButtons();
  }
  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(snapshot());
    var snap = undoStack.pop();
    restoreInPlace(snap);
    afterHistory('undo');
    return true;
  }
  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(snapshot());
    var snap = redoStack.pop();
    restoreInPlace(snap);
    afterHistory('redo');
    return true;
  }
  function afterHistory(reason) {
    rebuildTimeline();
    // 选中对象按 id 全局重新定位（contract_v2 §6.8）：
    //   - track：trackId 仍存在则保留，否则清空。
    //   - clip/text：跨轨 move 撤销后片段可能回到另一条轨，selection.trackId 不再匹配，
    //     故按 clipId 全局 locate 找回所在轨并更新 selection.trackId；全局找不到才清空。
    if (selection) {
      if (selection.kind === 'track') {
        if (!getTrack(selection.trackId)) selection = null;
      } else if (selection.kind === 'clip' || selection.kind === 'text') {
        var loc = locateClip(selection.clipId);
        if (loc) {
          selection.trackId = loc.track.id;
          selection.kind = (loc.track.kind === 'text') ? 'text' : 'clip';
        } else {
          selection = null;
        }
      }
    }
    // playhead 越界修正交由 player（监听 project:changed）处理；此处不直接动 engine。
    refreshUndoRedoButtons();
    bus.emit('project:changed', { reason: reason });
    bus.emit('tracks:changed', {});
    bus.emit('selection:changed', selection || { kind: null });
  }

  // 改状态后的统一收尾：重建派生 + emit。reason 仅供调试。
  function changed(reason) {
    rebuildTimeline();
    bus.emit('project:changed', { reason: reason });
  }

  /* ===================================================================== *
   * 11. 素材库 / 导入（contract_v2 §3.2 素材库 / 导入；不入撤销栈）
   * ===================================================================== */
  function addMedia(mediaObj) {
    if (!mediaObj || !mediaObj.id) return null;
    bumpIdCounter('med', mediaObj.id);
    bumpIdCounter('src', mediaObj.streamId);
    // 路径统一正斜杠（契约约定）
    if (mediaObj.path) mediaObj.path = ('' + mediaObj.path).replace(/\\/g, '/');
    if (!mediaObj.name) mediaObj.name = (mediaObj.path || '').split('/').pop() || '素材';
    if (!mediaObj.thumbUrl) mediaObj.thumbUrl = api.thumbUrl(mediaObj.id);
    // 去重（同 id 不重复加）
    if (getMedia(mediaObj.id)) return mediaObj.id;
    project.media.push(mediaObj);
    rebuildTimeline();
    bus.emit('media:changed', { added: [mediaObj.id] });
    return mediaObj.id;
  }
  function removeMedia(mediaId) {
    // 若被任何 clip 引用则拒绝（contract_v2 §3.2）
    for (var i = 0; i < project.tracks.length; i++) {
      var t = project.tracks[i];
      if (t.kind !== 'video') continue;
      for (var j = 0; j < t.clips.length; j++) {
        if (t.clips[j].mediaId === mediaId) { toast('该素材已被时间轴片段引用，无法移除', 'error'); return; }
      }
    }
    var idx = -1;
    for (var k = 0; k < project.media.length; k++) if (project.media[k].id === mediaId) { idx = k; break; }
    if (idx < 0) return;
    project.media.splice(idx, 1);
    rebuildTimeline();
    bus.emit('media:changed', {});
  }

  function importViaPicker(multiple) {
    if (multiple == null) multiple = true;
    return api.pick(multiple).then(function (res) {
      var arr = (res && res.media) || [];
      var ids = [];
      arr.forEach(function (m) { var id = addMedia(m); if (id) ids.push(id); });
      if (res && res.error) toast('部分文件导入失败：' + res.error, 'error');
      return ids;
    });
  }
  function importViaUpload(file) {
    return api.upload(file).then(function (res) {
      // 后端单文件返回对象，多文件返回数组（契约 §2.7 兼容处理）
      var m = res && res.media;
      if (Array.isArray(m)) { var ids = []; m.forEach(function (x) { var id = addMedia(x); if (id) ids.push(id); }); return ids[0] || null; }
      return m ? addMedia(m) : null;
    });
  }
  function importFiles(fileList) {
    var files = [].slice.call(fileList || []).filter(function (f) { return /\.mp4$/i.test(f.name); });
    if (!files.length) { toast('请拖入 mp4 文件', 'error'); return Promise.resolve([]); }
    var ids = [];
    return files.reduce(function (chain, f, i) {
      return chain.then(function () {
        setDropOverlayText('上传中 ' + (i + 1) + '/' + files.length + ' …');
        return importViaUpload(f).then(function (id) { if (id) ids.push(id); })
          .catch(function (e) { toast('上传失败（' + f.name + '）：' + e.message, 'error'); });
      });
    }, Promise.resolve()).then(function () {
      hideDropOverlay();
      if (ids.length) toast('已导入 ' + ids.length + ' 个视频到素材库', 'info', 1800);
      return ids;
    });
  }

  /* ===================================================================== *
   * 12. 轨道 mutator（contract_v2 §3.2 轨道）
   * ===================================================================== */
  // 轨道 mutator 统一约定：默认自动 pushHistory；调用方若已自压一次历史
  // （如 timeline 一次手势在 pointerdown 已 push），传 opts.noHistory=true 避免双压。
  function addTrack(kind, atIndex, opts) {
    opts = opts || {};
    if (kind !== 'video' && kind !== 'text') kind = 'video';
    if (!opts.noHistory) pushHistory();
    var n = 1;
    project.tracks.forEach(function (t) { if (t.kind === kind) n++; });
    var t = makeTrack(kind, (kind === 'video' ? '视频 ' : '文字 ') + n);
    if (atIndex == null || atIndex < 0 || atIndex > project.tracks.length) project.tracks.push(t);
    else project.tracks.splice(atIndex, 0, t);
    changed('addTrack');
    bus.emit('tracks:changed', {});
    return t.id;
  }
  function removeTrack(trackId, opts) {
    opts = opts || {};
    var idx = trackIndex(trackId);
    if (idx < 0) return;
    // 至少保留 1 条视频轨（timeline_v2 §13）
    var vcount = project.tracks.filter(function (t) { return t.kind === 'video'; }).length;
    if (project.tracks[idx].kind === 'video' && vcount <= 1) { toast('至少保留一条视频轨', 'error'); return; }
    if (!opts.noHistory) pushHistory();
    project.tracks.splice(idx, 1);
    if (selection && selection.trackId === trackId) selection = null;
    changed('removeTrack');
    bus.emit('tracks:changed', {});
    bus.emit('selection:changed', selection || { kind: null });
  }
  function setTrackProp(trackId, key, value, opts) {
    opts = opts || {};
    var t = getTrack(trackId); if (!t) return;
    if (['name', 'muted', 'volume', 'hidden', 'locked'].indexOf(key) < 0) return;
    if (key === 'volume') value = clamp01(num(value, 1));
    if (key === 'muted' || key === 'hidden' || key === 'locked') value = !!value;
    if (!opts.noHistory) pushHistory();
    t[key] = value;
    changed('setTrackProp');
    // muted/volume/hidden 影响预览与导出 → 额外 emit tracks:changed（contract_v2 §3.2）。
    // 另 emit 轻量 audio:changed（contract_v2 §3.1 已登记）：player 对 muted/volume
    // 只需重新 applyAudio，无须整轨 rebuild（换源/重置时钟），减少过度反应。
    bus.emit('tracks:changed', {});
    if (key === 'muted' || key === 'volume' || key === 'hidden') bus.emit('audio:changed', { trackId: trackId, key: key, value: value });
  }
  function moveTrack(trackId, toIndex, opts) {
    opts = opts || {};
    var idx = trackIndex(trackId); if (idx < 0) return;
    if (!opts.noHistory) pushHistory();
    var t = project.tracks.splice(idx, 1)[0];
    toIndex = clamp(toIndex, 0, project.tracks.length);
    project.tracks.splice(toIndex, 0, t);
    changed('moveTrack');
    bus.emit('tracks:changed', {});
  }

  /* ===================================================================== *
   * 13. 防重叠 / 磁吸辅助（contract_v2 §6.2 / §6.3）
   *     磁吸的“像素阈值”由 timeline 提供 pxPerSec；这里只做数据落位。
   * ===================================================================== */
  // 同轨其它片段（排除 excludeId）的占用区间 [s,e)
  function occupiedRanges(track, excludeId) {
    var r = [];
    track.clips.forEach(function (c) {
      if (c.id === excludeId) return;
      r.push([c.start, c.start + clipDur(c, track)]);
    });
    r.sort(function (a, b) { return a[0] - b[0]; });
    return r;
  }
  // 把 [start, start+dur) 调整到 track 上最近的无重叠合法位置；找不到返回 null。
  function resolveOverlap(track, excludeId, start, dur) {
    start = Math.max(0, start);
    var ranges = occupiedRanges(track, excludeId);
    var end = start + dur;
    var overlap = ranges.some(function (rg) { return start < rg[1] - 1e-6 && end > rg[0] + 1e-6; });
    if (!overlap) return start;
    // 尝试贴到每个邻接片段的左缘或右缘
    var candidates = [0];
    ranges.forEach(function (rg) { candidates.push(rg[1]); candidates.push(rg[0] - dur); });
    candidates = candidates.filter(function (c) { return c >= 0; }).sort(function (a, b) { return Math.abs(a - start) - Math.abs(b - start); });
    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i], e = s + dur;
      var bad = ranges.some(function (rg) { return s < rg[1] - 1e-6 && e > rg[0] + 1e-6; });
      if (!bad) return s;
    }
    return null;
  }

  /* ===================================================================== *
   * 14. 视频片段 mutator（contract_v2 §3.2 视频片段）
   * ===================================================================== */
  // 从素材库拖入生成 video-clip。opts: {in,out,scale,cx,cy,opacity,noSnap,noHistory}
  function addClipFromMedia(mediaId, trackId, startSec, opts) {
    opts = opts || {};
    var media = getMedia(mediaId); if (!media) { toast('素材不存在', 'error'); return null; }
    var track = getTrack(trackId);
    if (!track || track.kind !== 'video') { toast('请拖到视频轨', 'error'); return null; }
    if (track.locked) { toast('该轨道已锁定', 'error'); return null; }

    var inS = clamp(num(opts.in, 0), 0, media.duration);
    var outS = clamp(num(opts.out, media.duration), inS + MIN_CLIP(), media.duration);
    if (!(outS > inS)) { toast('片段时长过短', 'error'); return null; }
    var dur = outS - inS;

    var start = Math.max(0, num(startSec, 0));
    var placed = resolveOverlap(track, null, start, dur);
    if (placed == null) { toast('该轨道没有足够空位放置片段', 'error'); return null; }

    var tf = defaultTransform(media.width, media.height, project.output.width, project.output.height);
    var clip = {
      id: nextId('clip'),
      mediaId: mediaId,
      in: inS, out: outS, start: placed,
      scale: num(opts.scale, tf.scale),
      cx: num(opts.cx, tf.cx),
      cy: num(opts.cy, tf.cy),
      opacity: clamp01(num(opts.opacity, tf.opacity)),
      speed: clamp(num(opts.speed, 1), 0.25, 4)   // 变速倍率（speed_design.md §0.1），默认 1.0
    };
    if (!opts.noHistory) pushHistory();
    track.clips.push(clip);
    changed('addClip');
    bus.emit('clips:changed', { trackId: trackId });
    return clip.id;
  }

  /* 复制 / 粘贴 / 副本（剪映 Ctrl+C / Ctrl+V / Ctrl+D 与时间轴工具条「复制」）。 */
  var clipboard = null; // { kind:'video'|'text', clip:<深拷贝> }
  function _newClipId(track) { return (track.kind === 'video') ? nextId('clip') : nextId('txt'); }
  function _insertClipInto(track, clipObj, startSec) {
    var dur = clipDur(clipObj, track);
    var placed = resolveOverlap(track, null, Math.max(0, startSec), dur);
    if (placed == null) {
      var endT = 0;
      track.clips.forEach(function (c) { endT = Math.max(endT, c.start + clipDur(c, track)); });
      placed = resolveOverlap(track, null, endT, dur);
    }
    if (placed == null) return null;
    clipObj.start = placed;
    track.clips.push(clipObj);
    return clipObj.id;
  }
  function duplicateClip(trackId, clipId) {
    var track = getTrack(trackId); if (!track) return null;
    if (track.locked) { toast('该轨道已锁定', 'error'); return null; }
    var clip = getClipIn(trackId, clipId); if (!clip) return null;
    pushHistory();
    var copy = JSON.parse(JSON.stringify(clip)); copy.id = _newClipId(track);
    var id = _insertClipInto(track, copy, clip.start + clipDur(clip, track));
    if (id == null) { toast('该轨道没有足够空位放置副本', 'error'); return null; }
    changed('duplicateClip'); bus.emit('clips:changed', { trackId: track.id });
    selectClip(track.id, id); return id;
  }
  function copyClip(trackId, clipId) {
    var track = getTrack(trackId); var clip = getClipIn(trackId, clipId);
    if (!track || !clip) return;
    clipboard = { kind: track.kind, clip: JSON.parse(JSON.stringify(clip)) };
    toast('已复制片段', null, 1100);
  }
  function pasteClip(atSec) {
    if (!clipboard) { toast('剪贴板为空', null, 1200); return null; }
    var target = null, i, tk;
    if (selection && selection.trackId) { var t = getTrack(selection.trackId); if (t && t.kind === clipboard.kind && !t.locked) target = t; }
    if (!target) { for (i = 0; i < project.tracks.length; i++) { tk = project.tracks[i]; if (tk.kind === clipboard.kind && !tk.locked) { target = tk; break; } } }
    if (!target) { toast('没有可粘贴的' + (clipboard.kind === 'text' ? '文字' : '视频') + '轨', 'error'); return null; }
    pushHistory();
    var copy = JSON.parse(JSON.stringify(clipboard.clip)); copy.id = _newClipId(target);
    var id = _insertClipInto(target, copy, Math.max(0, num(atSec, getPlayhead())));
    if (id == null) { toast('该轨道没有足够空位粘贴', 'error'); return null; }
    changed('pasteClip'); bus.emit('clips:changed', { trackId: target.id });
    selectClip(target.id, id); return id;
  }

  // 在时间轴绝对秒 atSec 切分（video 或 text）。返回 [leftId, rightId] 或 null。
  function splitClip(trackId, clipId, atSec) {
    var track = getTrack(trackId); if (!track) return null;
    if (track.locked) { toast('该轨道已锁定', 'error'); return null; }
    var clip = getClipIn(trackId, clipId); if (!clip) return null;
    var dur = clipDur(clip, track);
    var leftLen = atSec - clip.start;
    var rightLen = (clip.start + dur) - atSec;
    var MIN = MIN_CLIP();
    if (leftLen < MIN || rightLen < MIN) { toast('切分位置过于靠近端点（两侧需 ≥ ' + MIN.toFixed(2) + ' 秒）', 'error'); return null; }

    pushHistory();
    var idx = track.clips.indexOf(clip);
    var rightId = (track.kind === 'video') ? nextId('clip') : nextId('txt');
    var right;
    if (track.kind === 'video') {
      // 公式 4（speed_design.md §0.4）：leftLen 已是时间轴长度（clipDur 含 speed），
      // 源切点 srcCut = in + leftLen*speed；左右两段沿用同一 speed，时间轴长度自然相加 = 原长。
      var srcCut = clip.in + leftLen * (clip.speed || 1);
      right = {
        id: rightId, mediaId: clip.mediaId, in: srcCut, out: clip.out, start: atSec,
        scale: clip.scale, cx: clip.cx, cy: clip.cy, opacity: clip.opacity,
        speed: (clip.speed == null ? 1 : clip.speed)
      };
      clip.out = srcCut; // 左段保留原 id 与原 speed
    } else {
      right = JSON.parse(JSON.stringify(clip));
      right.id = rightId;
      right.start = atSec;
      right.duration = rightLen;
      clip.duration = leftLen;
    }
    track.clips.splice(idx + 1, 0, right);
    changed('split');
    bus.emit('clips:changed', { trackId: trackId });
    return [clip.id, rightId];
  }

  function removeClip(trackId, clipId) {
    var track = getTrack(trackId); if (!track) return;
    if (track.locked) { toast('该轨道已锁定', 'error'); return; }
    var idx = -1;
    for (var i = 0; i < track.clips.length; i++) if (track.clips[i].id === clipId) { idx = i; break; }
    if (idx < 0) return;
    pushHistory();
    track.clips.splice(idx, 1);
    if (selection && selection.clipId === clipId) selection = null;
    changed('removeClip');
    bus.emit('clips:changed', { trackId: trackId });
    bus.emit('selection:changed', selection || { kind: null });
  }

  // 波纹删除：删除并把同轨 start > 被删start 的片段整体前移其时长（contract_v2 §6.6）
  function rippleRemoveClip(trackId, clipId) {
    var track = getTrack(trackId); if (!track) return;
    if (track.locked) { toast('该轨道已锁定', 'error'); return; }
    var clip = getClipIn(trackId, clipId); if (!clip) return;
    pushHistory();
    var gap = clipDur(clip, track);
    var removeStart = clip.start;
    var idx = track.clips.indexOf(clip);
    track.clips.splice(idx, 1);
    track.clips.forEach(function (c) { if (c.start > removeStart - 1e-6) c.start = Math.max(0, c.start - gap); });
    if (selection && selection.clipId === clipId) selection = null;
    changed('rippleRemove');
    bus.emit('clips:changed', { trackId: trackId });
    bus.emit('selection:changed', selection || { kind: null });
  }

  // 移动片段（同轨改 start，或跨轨到 newTrackId）。opts.noHistory 拖拽合并用。
  function moveClip(trackId, clipId, newStartSec, newTrackId, opts) {
    opts = opts || {};
    var srcTrack = getTrack(trackId); if (!srcTrack) return null;
    var clip = getClipIn(trackId, clipId); if (!clip) return null;
    if (srcTrack.locked) { toast('该轨道已锁定', 'error'); return null; }
    var dstTrack = newTrackId ? getTrack(newTrackId) : srcTrack;
    if (!dstTrack) dstTrack = srcTrack;
    // 跨轨须类型匹配（contract_v2 §6.7）
    if (dstTrack !== srcTrack) {
      if (dstTrack.kind !== srcTrack.kind) { toast('该轨道类型不匹配', 'error'); return null; }
      if (dstTrack.locked) { toast('目标轨道已锁定', 'error'); return null; }
    }
    var dur = clipDur(clip, srcTrack);
    var placed = resolveOverlap(dstTrack, dstTrack === srcTrack ? clipId : null, Math.max(0, newStartSec), dur);
    if (placed == null) { toast('该位置与其他片段重叠', 'error'); return null; }

    if (!opts.noHistory) pushHistory();
    if (dstTrack !== srcTrack) {
      var i = srcTrack.clips.indexOf(clip);
      srcTrack.clips.splice(i, 1);
      dstTrack.clips.push(clip);
    }
    clip.start = placed;
    changed('moveClip');
    bus.emit('clips:changed', {});
    return { trackId: dstTrack.id, start: placed };
  }

  // edge-trim 修剪（contract_v2 §6.4）。edge:"in"|"out"，deltaSec 为该边位移。
  function trimClip(trackId, clipId, edge, deltaSec, opts) {
    opts = opts || {};
    var track = getTrack(trackId); if (!track) return;
    if (track.locked) { toast('该轨道已锁定', 'error'); return; }
    var clip = getClipIn(trackId, clipId); if (!clip) return;
    var MIN = MIN_CLIP();
    var media = (track.kind === 'video') ? getMedia(clip.mediaId) : null;

    if (!opts.noHistory) pushHistory();

    if (track.kind === 'video') {
      var sp = (clip.speed || 1);   // 变速：deltaSec 为“源秒”增量；时间轴长 = 源长/sp
      if (edge === 'in') {
        // 改源 in 与时间轴 start：in_new=in+Δ(源)，start_new=start+Δ/sp(时间轴)
        var lo = -clip.in;                            // in 不可 < 0
        var hi = (clip.out - clip.in) - MIN * sp;     // 时间轴长 >= MIN
        lo = Math.max(lo, -clip.start * sp);          // start 不可 < 0
        // 不得越过上一片段右缘（prevEnd 为时间轴秒，换算成源增量需 *sp）
        var prevEnd = prevClipEnd(track, clip);
        if (prevEnd != null) lo = Math.max(lo, (prevEnd - clip.start) * sp);
        var d = clamp(deltaSec, lo, hi);
        clip.in += d; clip.start += d / sp;
      } else { // out
        var hiR = (media ? media.duration : Infinity) - clip.out;
        var loR = MIN * sp - (clip.out - clip.in);    // 时间轴长 >= MIN
        var nextStart = nextClipStart(track, clip);
        if (nextStart != null) hiR = Math.min(hiR, (nextStart - clip.start) * sp - (clip.out - clip.in));
        var d2 = clamp(deltaSec, loR, hiR);
        clip.out += d2;
      }
    } else { // text
      if (edge === 'in') {
        var loT = -clip.start;
        var hiT = clip.duration - MIN;
        var prevEndT = prevClipEnd(track, clip);
        if (prevEndT != null) loT = Math.max(loT, prevEndT - clip.start);
        var dt = clamp(deltaSec, loT, hiT);
        clip.start += dt; clip.duration -= dt;
      } else {
        var loR2 = MIN - clip.duration;
        var hiR2 = Infinity;
        var nextStartT = nextClipStart(track, clip);
        if (nextStartT != null) hiR2 = nextStartT - (clip.start + clip.duration);
        var dr = clamp(deltaSec, loR2, hiR2);
        clip.duration += dr;
      }
    }
    changed('trimClip');
    bus.emit('clips:changed', { trackId: trackId });
  }
  function prevClipEnd(track, clip) {
    var best = null;
    track.clips.forEach(function (c) {
      if (c === clip) return;
      var e = c.start + clipDur(c, track);
      if (e <= clip.start + 1e-6) { if (best == null || e > best) best = e; }
    });
    return best;
  }
  function nextClipStart(track, clip) {
    var best = null;
    var myEnd = clip.start + clipDur(clip, track);
    track.clips.forEach(function (c) {
      if (c === clip) return;
      if (c.start >= myEnd - 1e-6) { if (best == null || c.start < best) best = c.start; }
    });
    return best;
  }

  // PiP 变换（overlay 手柄/属性面板）。patch {scale,cx,cy,opacity}。opts.noHistory 拖拽合并。
  function setClipTransform(trackId, clipId, patch, opts) {
    opts = opts || {};
    var clip = getClipIn(trackId, clipId); if (!clip) return;
    if (!opts.noHistory) pushHistory();
    if (patch.scale != null) clip.scale = clamp(num(patch.scale, clip.scale), 0.02, 4);
    if (patch.cx != null) clip.cx = num(patch.cx, clip.cx);
    if (patch.cy != null) clip.cy = num(patch.cy, clip.cy);
    if (patch.opacity != null) clip.opacity = clamp01(num(patch.opacity, clip.opacity));
    changed('setClipTransform');
    bus.emit('transform:changed', { trackId: trackId, clipId: clipId });
  }
  function getClip(trackId, clipId) { return getClipIn(trackId, clipId); }

  // 变速倍率 mutator（speed_design.md §0.1）。仅对 video 轨片段生效；text 轨忽略。
  // speed 钳制到 [0.25,4]，缺省 1；opts.noHistory:true 时不压栈（连续手势合并，由调用方负责 pushHistory）。
  // 改 speed 改变时间轴长度/总时长 → 必须 emit 'clips:changed'（而非 transform:changed），
  // 让 player 重建派生 + 重对齐源时间。
  function setClipSpeed(trackId, clipId, speed, opts) {
    opts = opts || {};
    var track = getTrack(trackId); if (!track || track.kind !== 'video') return;
    var clip = getClipIn(trackId, clipId); if (!clip) return;
    var v = clamp(num(speed, 1), 0.25, 4);
    if (!opts.noHistory) pushHistory();
    clip.speed = v;
    changed('setClipSpeed');
    bus.emit('clips:changed', { trackId: trackId });
  }

  /* ===================================================================== *
   * 15. 文字片段 mutator（contract_v2 §3.2 文字片段）
   * ===================================================================== */
  function makeTextClip(startSec) {
    var total = totalDuration();
    var start = Math.max(0, num(startSec, getPlayhead()));
    var dur = 3.0;
    if (total > start + 0.1) dur = Math.min(3.0, Math.max(0.5, total - start));
    return {
      id: nextId('txt'),
      content: '双击编辑文字',
      start: start, duration: dur,
      xPct: 0.1, yPct: 0.1, wPct: 0.5,
      fontFile: DEFAULT_FONT, fontSizePct: 0.06,
      color: '#FFFFFF', opacity: 1.0, align: 'left',
      border: false, borderColor: '#000000', borderWPct: 0.004,
      box: false, boxColor: '#000000', boxOpacity: 0.5
    };
  }
  // 在指定 text 轨（缺省：当前选中 text 轨；无则新建）新建文字片段。
  // 先确定目标轨（含必要的新建），全部确定无误后再 pushHistory 一次并改状态，
  // 避免“先改/新建轨再 pop 快照却回滚不掉”的脆弱逻辑（contract_v2 §6.8）。
  function addTextClip(trackId, startSec) {
    var track = trackId ? getTrack(trackId) : null;
    if (!track || track.kind !== 'text') {
      track = null;
      // 当前选中 text 轨？
      if (selection && selection.trackId) { var st = getTrack(selection.trackId); if (st && st.kind === 'text') track = st; }
    }
    var needNewTrack = false;
    if (!track) {
      // 寻找任意 text 轨；找不到则标记需新建（暂不改 project）
      for (var i = project.tracks.length - 1; i >= 0; i--) if (project.tracks[i].kind === 'text') { track = project.tracks[i]; break; }
      if (!track) needNewTrack = true;
    }
    // locked 检查提前到任何 push / 新建之前（现有 text 轨可能被锁定；新建轨 locked=false）
    if (track && track.locked) { toast('该文字轨已锁定', 'error'); return null; }

    // 此处起开始改状态：先压一次历史，再做（可能的）新建轨 + 追加文字片段，
    // 一次手势=一个撤销步；undo 一次可同时回退“新建轨+加文字”。
    pushHistory();
    if (needNewTrack) {
      var n = 1; project.tracks.forEach(function (t) { if (t.kind === 'text') n++; });
      track = makeTrack('text', '文字 ' + n);
      project.tracks.push(track);
      bus.emit('tracks:changed', {});
    }
    var clip = makeTextClip(startSec);
    // 防重叠：文字轨同样不允许重叠，落位到最近空位
    var placed = resolveOverlap(track, null, clip.start, clip.duration);
    if (placed == null) placed = clip.start; // 极端情况仍放（不阻塞文字添加）
    clip.start = placed;
    track.clips.push(clip);
    changed('addText');
    bus.emit('clips:changed', { trackId: track.id });
    bus.emit('texts:changed', { id: clip.id });
    return clip.id;
  }

  function setTextProp(trackId, clipId, key, value, opts) {
    opts = opts || {};
    var track = getTrack(trackId); if (!track || track.kind !== 'text') return;
    var clip = getClipIn(trackId, clipId); if (!clip) return;
    // clamp 规则（contract_v2 §1.5 / §5.3）
    switch (key) {
      case 'xPct': value = clamp01(num(value, clip.xPct)); break;
      case 'yPct': value = clamp01(num(value, clip.yPct)); break;
      case 'wPct': value = clamp(num(value, clip.wPct), 0.02, 1); break;
      case 'fontSizePct': value = clamp(num(value, clip.fontSizePct), 0.01, 0.5); break;
      case 'opacity': value = clamp01(num(value, clip.opacity)); break;
      case 'boxOpacity': value = clamp01(num(value, clip.boxOpacity)); break;
      case 'borderWPct': value = clamp(num(value, clip.borderWPct), 0, 0.02); break;
      case 'start': value = Math.max(0, num(value, clip.start)); break;
      case 'duration': value = Math.max(MIN_CLIP(), num(value, clip.duration)); break;
      case 'color': case 'borderColor': case 'boxColor': value = normHex(value); break;
      case 'border': case 'box': value = !!value; break;
      case 'align': if (['left', 'center', 'right'].indexOf(value) < 0) return; break;
      case 'content': value = '' + value; break;
      case 'fontFile': value = '' + value; break;
      default: return;
    }
    if (!opts.noHistory) pushHistory();
    clip[key] = value;
    changed('setTextProp');
    bus.emit('texts:changed', { id: clipId });
  }

  /* ===================================================================== *
   * 16. 输出设置（contract_v2 §3.2 输出）
   * ===================================================================== */
  var _outputUserTouched = false;
  function setOutputProp(key, value) {
    if (['width', 'height', 'fps', 'crf', 'keepAudio'].indexOf(key) < 0) return;
    if (key === 'width' || key === 'height') value = toEven(num(value, 2));
    else if (key === 'fps') value = clamp(Math.round(num(value, 30)), 1, 120);
    else if (key === 'crf') value = clamp(Math.round(num(value, 18)), 0, 51);
    else if (key === 'keepAudio') value = !!value;
    pushHistory();
    project.output[key] = value;
    if (key !== 'keepAudio') _outputUserTouched = true;
    changed('setOutputProp');
    bus.emit('output:changed', {});
  }
  function maybeInitOutputFromFirstMedia(force) {
    if (_outputUserTouched && !force) return;
    if (!project.media.length) return;
    var m = project.media[0];
    project.output.width = toEven(m.width || 1920);
    project.output.height = toEven(m.height || 1080);
    project.output.fps = clamp(Math.round(m.fps || 30), 1, 120);
    bus.emit('output:changed', {});
  }

  /* ===================================================================== *
   * 17. 选择（contract_v2 §3.2 选择）
   * ===================================================================== */
  var selection = null; // { kind:'clip'|'text'|'track', trackId?, clipId? }

  function selectClip(trackId, clipId) {
    var track = getTrack(trackId); if (!track) return;
    var clip = getClipIn(trackId, clipId); if (!clip) return;
    selection = { kind: track.kind === 'text' ? 'text' : 'clip', trackId: trackId, clipId: clipId };
    bus.emit('selection:changed', selection);
  }
  function selectTrack(trackId) {
    if (!getTrack(trackId)) return;
    selection = { kind: 'track', trackId: trackId };
    bus.emit('selection:changed', selection);
  }
  function clearSelection() {
    selection = null;
    bus.emit('selection:changed', { kind: null });
  }
  function getSelection() { return selection; }

  // ↑/↓ 跨轨移动选择（contract_v2 §7）。dir:+1 上层，-1 下层。
  function selectAdjacentTrack(dir) {
    var curIdx;
    if (selection && selection.trackId) curIdx = trackIndex(selection.trackId);
    else curIdx = project.tracks.length - 1;
    var ni = clamp(curIdx + dir, 0, project.tracks.length - 1);
    var t = project.tracks[ni]; if (!t) return;
    // 在该轨找与播放头最接近的片段；无则只选轨
    var ph = getPlayhead();
    var best = null, bestD = Infinity;
    t.clips.forEach(function (c) {
      var s = c.start, e = c.start + clipDur(c, t);
      var d = (ph >= s && ph < e) ? 0 : Math.min(Math.abs(ph - s), Math.abs(ph - e));
      if (d < bestD) { bestD = d; best = c; }
    });
    if (best) selectClip(t.id, best.id);
    else selectTrack(t.id);
  }

  /* ===================================================================== *
   * 18. 播放代理（实际由 player.js 的 engine 实现）
   * ===================================================================== */
  function getPlayhead() { return (App.engine && typeof App.engine.playhead === 'number') ? App.engine.playhead : 0; }
  function play() { if (App.engine) App.engine.play(); else bus.emit('play', {}); }
  function pause() { if (App.engine) App.engine.pause(); else bus.emit('pause', {}); }
  function togglePlay() { if (App.engine) App.engine.toggle(); }
  function seek(t) { bus.emit('seek', t); }
  function stepFrame(dir) {
    var fps = project.output.fps || 30;
    seek(Math.max(0, getPlayhead() + dir / fps));
  }

  /* ===================================================================== *
   * 19. 导出前规范化 project（深拷贝 + clamp + 取偶，contract_v2 §6.9 / §5）
   * ===================================================================== */
  function buildExportProject() {
    rebuildTimeline();
    var p = JSON.parse(JSON.stringify({ output: project.output, media: project.media, tracks: project.tracks }));
    // output 取偶/clamp（B15）
    p.output.width = toEven(p.output.width);
    p.output.height = toEven(p.output.height);
    p.output.fps = clamp(Math.round(p.output.fps), 1, 120);
    p.output.crf = clamp(Math.round(p.output.crf), 0, 51);
    p.output.keepAudio = !!p.output.keepAudio;

    var mediaById = {};
    p.media.forEach(function (m) { mediaById[m.id] = m; });

    p.tracks.forEach(function (t) {
      if (t.kind === 'video') {
        t.muted = !!t.muted; t.volume = clamp01(t.volume); t.hidden = !!t.hidden; t.locked = !!t.locked;
        t.clips = t.clips.filter(function (c) {
          var m = mediaById[c.mediaId];
          if (!m) return false;
          c.in = Math.max(0, num(c.in, 0));               // B4
          c.out = Math.min(num(c.out, m.duration), m.duration);
          c.start = Math.max(0, num(c.start, 0));
          c.scale = clamp(num(c.scale, 1), 0.02, 4);
          c.cx = num(c.cx, 0.5); c.cy = num(c.cy, 0.5);
          c.opacity = clamp01(num(c.opacity, 1));
          c.speed = clamp(num(c.speed, 1), 0.25, 4);      // 变速倍率（缺省 1，深拷贝已带，仅 clamp）
          return c.out > c.in;                            // B2
        });
      } else { // text
        t.hidden = !!t.hidden; t.locked = !!t.locked;
        t.clips = t.clips.filter(function (c) {
          c.start = Math.max(0, num(c.start, 0));
          c.duration = Math.max(0, num(c.duration, 0));
          c.xPct = clamp01(num(c.xPct, 0.1));             // B6
          c.yPct = clamp01(num(c.yPct, 0.1));
          c.wPct = clamp(num(c.wPct, 0.5), 0.02, 1);
          c.fontSizePct = clamp(num(c.fontSizePct, 0.06), 0.01, 0.5);
          c.opacity = clamp01(num(c.opacity, 1));
          c.boxOpacity = clamp01(num(c.boxOpacity, 0.5));
          c.borderWPct = clamp(num(c.borderWPct, 0.004), 0, 0.02);
          c.color = normHex(c.color); c.borderColor = normHex(c.borderColor); c.boxColor = normHex(c.boxColor);
          c.border = !!c.border; c.box = !!c.box;
          if (['left', 'center', 'right'].indexOf(c.align) < 0) c.align = 'left';
          c.content = '' + (c.content == null ? '' : c.content);
          return c.duration > 0;
        });
      }
    });
    return p;
  }
  function getProject() { return project; }

  /* ===================================================================== *
   * 20. 拖拽遮罩（OS 文件拖入窗口，contract_v2 §4.7 #dropOverlay）
   * ===================================================================== */
  function setDropOverlayText(txt) {
    var ov = document.getElementById('dropOverlay'); if (!ov) return;
    ov.hidden = false; ov.style.display = '';
    var inner = ov.querySelector('.do-inner') || ov;
    if (inner !== ov) inner.textContent = txt || '松开导入素材';
  }
  function hideDropOverlay() {
    var ov = document.getElementById('dropOverlay'); if (!ov) return;
    ov.hidden = true; ov.style.display = 'none';
  }
  function hasFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }

  function bindOsFileDrop() {
    var depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return; depth++; e.preventDefault(); setDropOverlayText('松开导入素材到素材库');
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return; e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; hideDropOverlay(); } });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0;
      importFiles(e.dataTransfer.files);
    });
  }

  /* ===================================================================== *
   * 21. 素材库渲染（contract_v2 §4.2；缩略图/时长/分辨率，可拖拽源）
   * ===================================================================== */
  function renderMediaList() {
    var list = document.getElementById('mediaList');
    var hint = document.getElementById('mediaEmptyHint');
    if (!list) return;
    // 只清除已有素材卡片，绝不用 innerHTML='' —— 那会连带删除 #mediaEmptyHint
    // 这个静态空状态节点（index.html 中它是 #mediaList 的子节点）。
    var olds = list.querySelectorAll('.media-item');
    for (var oi = 0; oi < olds.length; oi++) list.removeChild(olds[oi]);
    if (!project.media.length) { if (hint) hint.style.display = ''; return; }
    if (hint) hint.style.display = 'none';
    project.media.forEach(function (m) {
      var item = document.createElement('div');
      item.className = 'media-item';
      item.dataset.mediaId = m.id;
      item.draggable = true;

      var img = document.createElement('img');
      img.className = 'mi-thumb';
      img.src = m.thumbUrl || api.thumbUrl(m.id);
      img.alt = m.name || '';
      img.draggable = false;
      item.appendChild(img);

      var info = document.createElement('div');
      info.className = 'mi-info';
      var nameEl = document.createElement('div');
      nameEl.className = 'mi-name'; nameEl.textContent = m.name || '素材'; nameEl.title = m.path || '';
      info.appendChild(nameEl);
      var meta = document.createElement('div');
      meta.className = 'mi-meta';
      meta.textContent = fmtShort(m.duration) + ' · ' + (m.width || '?') + '×' + (m.height || '?') + ' · ' + Math.round(m.fps || 0) + 'fps';
      info.appendChild(meta);
      var badge = document.createElement('span');
      badge.className = 'mi-badge-audio';
      badge.textContent = m.hasAudio ? '有声' : '无声';
      info.appendChild(badge);
      item.appendChild(info);

      var rm = document.createElement('button');
      rm.className = 'mi-remove'; rm.title = '从库移除'; rm.textContent = '×';
      rm.addEventListener('click', function (ev) { ev.stopPropagation(); removeMedia(m.id); });
      item.appendChild(rm);

      // 拖到时间轴（timeline_v2 §7 约定的 dataTransfer key）
      item.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.setData('application/x-mediaid', m.id);
        ev.dataTransfer.setData('text/plain', m.id);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      list.appendChild(item);
    });
  }
  function fmtShort(s) {
    s = Math.max(0, Math.round(s || 0));
    var m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? '0' + m : m) + ':' + (ss < 10 ? '0' + ss : ss);
  }
  bus.on('media:changed', renderMediaList);

  /* ===================================================================== *
   * 22. 属性面板（contract_v2 §4.4）：随选中切换分区 + 双向绑定
   *     - video-clip：scale/cx/cy/opacity/in/out/start + 所属轨 muted/volume
   *     - text-clip：content/字号/颜色/对齐/字体/描边/底框/start/duration
   *     - track：name/muted/volume/hidden/locked
   * ===================================================================== */
  function $(id) { return document.getElementById(id); }
  var P = {}; // 属性面板控件缓存

  function bindPropPanel() {
    P = {
      empty: $('propEmpty'),
      clipSec: $('propClipSection'), textSec: $('propTextSection'),
      trackSec: $('propTrackSection'), outSec: $('propOutputSection'),
      // clip
      rngScale: $('rngClipScale'), numScale: $('numClipScale'),
      numCx: $('numClipCx'), numCy: $('numClipCy'), rngOpacity: $('rngClipOpacity'),
      rngSpeed: $('rngSpeed'), numSpeed: $('propSpeed'),
      btnContain: $('btnClipContain'), btnCover: $('btnClipCover'), btnFull: $('btnClipFull'),
      numIn: $('numClipIn'), numOut: $('numClipOut'), numStart: $('numClipStart'),
      chkTrackMuted: $('chkTrackMuted'), rngTrackVolume: $('rngTrackVolume'),
      // text
      content: $('inpTextContent'),
      rngFont: $('rngFontSize'), numFont: $('numFontSize'),
      color: $('colTextColor'), opacityT: $('rngTextOpacity'),
      align: $('selTextAlign'), font: $('selFontFile'),
      border: $('chkBorder'), borderColor: $('colBorderColor'), borderW: $('rngBorderW'),
      box: $('chkBox'), boxColor: $('colBoxColor'), boxOpacity: $('rngBoxOpacity'),
      tStart: $('numTextStart'), tDur: $('numTextDuration'),
      setStart: $('btnSetStartNow'), setEnd: $('btnSetEndNow'), delText: $('btnDeleteText'),
      // track
      trackName: $('inpTrackName'), trackHidden: $('chkTrackHidden2'), trackLocked: $('chkTrackLocked'),
      trackMuted2: $('chkTrackMuted2'), trackVolume2: $('rngTrackVolume2')
    };

    bindClipControls();
    bindTextControls();
    bindTrackControls();

    bus.on('selection:changed', function () { renderPropPanel(); });
    bus.on('project:changed', function () { renderPropPanel(); });
    bus.on('transform:changed', function () { renderPropPanel(); });
    bus.on('texts:changed', function () { renderPropPanel(); });
  }

  // —— video-clip 分区 ——
  var _clipDragHist = false; // 滑块拖动期内只压一次历史
  function curClip() {
    if (selection && (selection.kind === 'clip')) return getClipIn(selection.trackId, selection.clipId);
    return null;
  }
  function curTextClip() {
    if (selection && selection.kind === 'text') return getClipIn(selection.trackId, selection.clipId);
    return null;
  }
  function curTrack() {
    if (selection && selection.kind === 'track') return getTrack(selection.trackId);
    return null;
  }

  function bindClipControls() {
    function tp(patch, first) { var c = curClip(); if (!c) return; setClipTransform(selection.trackId, selection.clipId, patch, { noHistory: !first }); }
    function sliderStart() { if (!_clipDragHist) { pushHistory(); _clipDragHist = true; } }
    function sliderEnd() { _clipDragHist = false; }

    if (P.rngScale) {
      P.rngScale.addEventListener('pointerdown', sliderStart);
      P.rngScale.addEventListener('input', function () { sliderStart(); var v = num(P.rngScale.value, 1); tp({ scale: v }, false); if (P.numScale) P.numScale.value = Math.round(v * 100); });
      P.rngScale.addEventListener('change', sliderEnd);
    }
    if (P.numScale) P.numScale.addEventListener('change', function () { var v = clamp(num(P.numScale.value, 100) / 100, 0.02, 4); pushHistory(); setClipTransform(selection.trackId, selection.clipId, { scale: v }, { noHistory: true }); });
    if (P.numCx) P.numCx.addEventListener('change', function () { var c = curClip(); if (!c) return; pushHistory(); setClipTransform(selection.trackId, selection.clipId, { cx: num(P.numCx.value, c.cx) }, { noHistory: true }); });
    if (P.numCy) P.numCy.addEventListener('change', function () { var c = curClip(); if (!c) return; pushHistory(); setClipTransform(selection.trackId, selection.clipId, { cy: num(P.numCy.value, c.cy) }, { noHistory: true }); });
    if (P.rngOpacity) {
      P.rngOpacity.addEventListener('pointerdown', sliderStart);
      P.rngOpacity.addEventListener('input', function () { sliderStart(); tp({ opacity: num(P.rngOpacity.value, 1) }, false); });
      P.rngOpacity.addEventListener('change', sliderEnd);
    }
    // 变速倍率（speed_design.md §1.1）：滑块拖动一次手势压一次历史（复用 _clipDragHist），
    // number 输入单压一次；两控件互相同步，显示 1.50× 形式（number 保留两位小数）。
    if (P.rngSpeed) {
      P.rngSpeed.addEventListener('pointerdown', sliderStart);
      P.rngSpeed.addEventListener('input', function () {
        var c = curClip(); if (!c) return;
        sliderStart();
        var v = clamp(num(P.rngSpeed.value, 1), 0.25, 4);
        setClipSpeed(selection.trackId, selection.clipId, v, { noHistory: true });
        if (P.numSpeed) P.numSpeed.value = v.toFixed(2);
      });
      P.rngSpeed.addEventListener('change', sliderEnd);
    }
    if (P.numSpeed) P.numSpeed.addEventListener('change', function () {
      var c = curClip(); if (!c) return;
      var v = clamp(num(P.numSpeed.value, 1), 0.25, 4);
      pushHistory();
      setClipSpeed(selection.trackId, selection.clipId, v, { noHistory: true });
      if (P.rngSpeed) P.rngSpeed.value = v;
      P.numSpeed.value = v.toFixed(2);
    });

    if (P.btnContain) P.btnContain.addEventListener('click', function () { applyFit('contain'); });
    if (P.btnCover) P.btnCover.addEventListener('click', function () { applyFit('cover'); });
    if (P.btnFull) P.btnFull.addEventListener('click', function () { applyFit('full'); });

    if (P.numIn) P.numIn.addEventListener('change', function () { trimToInOut(); });
    if (P.numOut) P.numOut.addEventListener('change', function () { trimToInOut(); });
    if (P.numStart) P.numStart.addEventListener('change', function () {
      var c = curClip(); if (!c) return;
      moveClip(selection.trackId, selection.clipId, num(P.numStart.value, c.start), null);
    });
    if (P.chkTrackMuted) P.chkTrackMuted.addEventListener('change', function () { var c = curClip(); if (!c) return; setTrackProp(selection.trackId, 'muted', P.chkTrackMuted.checked); });
    if (P.rngTrackVolume) {
      // 经 mutator 落地（contract_v2 §3.2）：首次 input 由 sliderStart 压一次历史，
      // 后续 input 传 noHistory:true 合并为一次撤销步；不再绕过 mutator 直写 t.volume。
      P.rngTrackVolume.addEventListener('pointerdown', sliderStart);
      P.rngTrackVolume.addEventListener('input', function () {
        var c = curClip(); if (!c) return;
        sliderStart();
        setTrackProp(selection.trackId, 'volume', num(P.rngTrackVolume.value, 1), { noHistory: true });
      });
      P.rngTrackVolume.addEventListener('change', sliderEnd);
    }
  }
  function applyFit(mode) {
    var c = curClip(); if (!c) return;
    var m = getMedia(c.mediaId); if (!m) return;
    var OW = project.output.width, OH = project.output.height;
    var srcAR = m.width / m.height, canvasAR = OW / OH;
    var patch = { cx: 0.5, cy: 0.5 };
    if (mode === 'contain') patch.scale = (srcAR >= canvasAR) ? 1.0 : srcAR * (OH / OW);
    else if (mode === 'cover') patch.scale = (srcAR >= canvasAR) ? srcAR * (OH / OW) : 1.0;
    else patch.scale = 1.0; // full：宽铺满
    pushHistory();
    setClipTransform(selection.trackId, selection.clipId, patch, { noHistory: true });
  }
  // 用属性面板的 in/out 值反推 trim（保持 start 不变改 in 较复杂，这里直接设值并 clamp）
  function trimToInOut() {
    var c = curClip(); if (!c) return;
    var m = getMedia(c.mediaId); if (!m) return;
    var MIN = MIN_CLIP();
    var ni = clamp(num(P.numIn.value, c.in), 0, m.duration - MIN);
    var no = clamp(num(P.numOut.value, c.out), ni + MIN, m.duration);
    pushHistory();
    c.in = ni; c.out = no;
    changed('setInOut');
    bus.emit('clips:changed', { trackId: selection.trackId });
  }

  // —— text-clip 分区 ——
  var _textDragHist = false;
  function bindTextControls() {
    function sp(key, value, first) { if (!curTextClip()) return; setTextProp(selection.trackId, selection.clipId, key, value, { noHistory: !first }); }
    function slStart() { if (!_textDragHist) { pushHistory(); _textDragHist = true; } }
    function slEnd() { _textDragHist = false; }

    if (P.content) P.content.addEventListener('input', function () { var c = curTextClip(); if (!c) return; pushHistory(); c.content = P.content.value; changed('textContent'); bus.emit('texts:changed', { id: c.id }); });
    if (P.rngFont) {
      P.rngFont.addEventListener('pointerdown', slStart);
      P.rngFont.addEventListener('input', function () { slStart(); var v = num(P.rngFont.value, 0.06); sp('fontSizePct', v, false); if (P.numFont) P.numFont.value = (v * 100).toFixed(1); });
      P.rngFont.addEventListener('change', slEnd);
    }
    if (P.numFont) P.numFont.addEventListener('change', function () { var v = clamp(num(P.numFont.value, 6) / 100, 0.01, 0.5); pushHistory(); sp('fontSizePct', v, false); if (P.rngFont) P.rngFont.value = v; });
    if (P.color) P.color.addEventListener('input', function () { pushHistory(); sp('color', P.color.value, false); });
    if (P.opacityT) {
      P.opacityT.addEventListener('pointerdown', slStart);
      P.opacityT.addEventListener('input', function () { slStart(); sp('opacity', num(P.opacityT.value, 1), false); });
      P.opacityT.addEventListener('change', slEnd);
    }
    if (P.align) P.align.addEventListener('change', function () { pushHistory(); sp('align', P.align.value, false); });
    if (P.font) P.font.addEventListener('change', function () { pushHistory(); sp('fontFile', P.font.value, false); });
    if (P.border) P.border.addEventListener('change', function () { pushHistory(); sp('border', P.border.checked, false); });
    if (P.borderColor) P.borderColor.addEventListener('input', function () { pushHistory(); sp('borderColor', P.borderColor.value, false); });
    if (P.borderW) {
      P.borderW.addEventListener('pointerdown', slStart);
      P.borderW.addEventListener('input', function () { slStart(); sp('borderWPct', num(P.borderW.value, 0.004), false); });
      P.borderW.addEventListener('change', slEnd);
    }
    if (P.box) P.box.addEventListener('change', function () { pushHistory(); sp('box', P.box.checked, false); });
    if (P.boxColor) P.boxColor.addEventListener('input', function () { pushHistory(); sp('boxColor', P.boxColor.value, false); });
    if (P.boxOpacity) {
      P.boxOpacity.addEventListener('pointerdown', slStart);
      P.boxOpacity.addEventListener('input', function () { slStart(); sp('boxOpacity', num(P.boxOpacity.value, 0.5), false); });
      P.boxOpacity.addEventListener('change', slEnd);
    }
    if (P.tStart) P.tStart.addEventListener('change', function () { pushHistory(); sp('start', num(P.tStart.value, 0), false); });
    if (P.tDur) P.tDur.addEventListener('change', function () { pushHistory(); sp('duration', num(P.tDur.value, 3), false); });
    if (P.setStart) P.setStart.addEventListener('click', function () { pushHistory(); sp('start', getPlayhead(), false); });
    if (P.setEnd) P.setEnd.addEventListener('click', function () { var c = curTextClip(); if (!c) return; pushHistory(); sp('duration', Math.max(MIN_CLIP(), getPlayhead() - c.start), false); });
    if (P.delText) P.delText.addEventListener('click', function () { if (selection && selection.kind === 'text') removeClip(selection.trackId, selection.clipId); });
  }

  // —— track 分区 ——
  function bindTrackControls() {
    if (P.trackName) P.trackName.addEventListener('change', function () { var t = curTrack(); if (t) setTrackProp(t.id, 'name', P.trackName.value); });
    if (P.trackHidden) P.trackHidden.addEventListener('change', function () { var t = curTrack(); if (t) setTrackProp(t.id, 'hidden', P.trackHidden.checked); });
    if (P.trackLocked) P.trackLocked.addEventListener('change', function () { var t = curTrack(); if (t) setTrackProp(t.id, 'locked', P.trackLocked.checked); });
    if (P.trackMuted2) P.trackMuted2.addEventListener('change', function () { var t = curTrack(); if (t) setTrackProp(t.id, 'muted', P.trackMuted2.checked); });
    if (P.trackVolume2) P.trackVolume2.addEventListener('change', function () { var t = curTrack(); if (t) setTrackProp(t.id, 'volume', num(P.trackVolume2.value, 1)); });
  }

  function showSec(el, on) { if (el) { el.hidden = !on; el.style.display = on ? '' : 'none'; } }
  function renderPropPanel() {
    var c = curClip(), tc = curTextClip(), tk = curTrack();
    showSec(P.empty, !(c || tc || tk));
    showSec(P.clipSec, !!c);
    showSec(P.textSec, !!tc);
    showSec(P.trackSec, !!tk);
    if (c) fillClipPanel(c);
    if (tc) fillTextPanel(tc);
    if (tk) fillTrackPanel(tk);
  }
  function fillClipPanel(c) {
    if (P.rngScale) P.rngScale.value = c.scale;
    if (P.numScale) P.numScale.value = Math.round(c.scale * 100);
    if (P.numCx) P.numCx.value = (+c.cx).toFixed(3);
    if (P.numCy) P.numCy.value = (+c.cy).toFixed(3);
    if (P.rngOpacity) P.rngOpacity.value = c.opacity;
    var sp = (c.speed == null ? 1 : c.speed);
    if (P.rngSpeed) P.rngSpeed.value = sp;
    if (P.numSpeed) P.numSpeed.value = (+sp).toFixed(2);
    if (P.numIn) P.numIn.value = (+c.in).toFixed(2);
    if (P.numOut) P.numOut.value = (+c.out).toFixed(2);
    if (P.numStart) P.numStart.value = (+c.start).toFixed(2);
    var t = getTrack(selection.trackId);
    if (t) { if (P.chkTrackMuted) P.chkTrackMuted.checked = !!t.muted; if (P.rngTrackVolume) P.rngTrackVolume.value = t.volume == null ? 1 : t.volume; }
  }
  function fillTextPanel(c) {
    if (P.content) P.content.value = c.content || '';
    if (P.rngFont) P.rngFont.value = c.fontSizePct;
    if (P.numFont) P.numFont.value = (c.fontSizePct * 100).toFixed(1);
    if (P.color) P.color.value = normHex(c.color);
    if (P.opacityT) P.opacityT.value = c.opacity;
    if (P.align) P.align.value = c.align || 'left';
    if (P.font) P.font.value = c.fontFile || DEFAULT_FONT;
    if (P.border) P.border.checked = !!c.border;
    if (P.borderColor) P.borderColor.value = normHex(c.borderColor);
    if (P.borderW) P.borderW.value = c.borderWPct;
    if (P.box) P.box.checked = !!c.box;
    if (P.boxColor) P.boxColor.value = normHex(c.boxColor);
    if (P.boxOpacity) P.boxOpacity.value = c.boxOpacity;
    if (P.tStart) P.tStart.value = (+c.start).toFixed(2);
    if (P.tDur) P.tDur.value = (+c.duration).toFixed(2);
  }
  function fillTrackPanel(t) {
    if (P.trackName) P.trackName.value = t.name || '';
    if (P.trackHidden) P.trackHidden.checked = !!t.hidden;
    if (P.trackLocked) P.trackLocked.checked = !!t.locked;
    var isVideo = t.kind === 'video';
    if (P.trackMuted2) { P.trackMuted2.checked = !!t.muted; P.trackMuted2.parentElement && (P.trackMuted2.parentElement.style.display = isVideo ? '' : 'none'); }
    if (P.trackVolume2) { P.trackVolume2.value = t.volume == null ? 1 : t.volume; P.trackVolume2.parentElement && (P.trackVolume2.parentElement.style.display = isVideo ? '' : 'none'); }
  }

  /* ===================================================================== *
   * 23. 输出设置面板（contract_v2 §4.4 #propOutputSection）
   * ===================================================================== */
  function bindOutputPanel() {
    var w = $('numOutWidth'), h = $('numOutHeight'), fps = $('numOutFps'), crf = $('numCrf'),
        audio = $('chkKeepAudio'), preset = $('selResPreset');
    if (w) w.addEventListener('change', function () { if (preset) preset.value = 'custom'; setOutputProp('width', w.value); });
    if (h) h.addEventListener('change', function () { if (preset) preset.value = 'custom'; setOutputProp('height', h.value); });
    if (fps) fps.addEventListener('change', function () { setOutputProp('fps', fps.value); });
    if (crf) crf.addEventListener('change', function () { setOutputProp('crf', crf.value); });
    if (audio) audio.addEventListener('change', function () { setOutputProp('keepAudio', audio.checked); });
    if (preset) preset.addEventListener('change', function () {
      var v = preset.value;
      if (v === '1920x1080') { setOutputProp('width', 1920); setOutputProp('height', 1080); }
      else if (v === '1280x720') { setOutputProp('width', 1280); setOutputProp('height', 720); }
      else if (v === '1080x1920') { setOutputProp('width', 1080); setOutputProp('height', 1920); }
      else if (v === 'source') { _outputUserTouched = false; maybeInitOutputFromFirstMedia(true); _outputUserTouched = true; }
      syncOutputPanel();
    });
    syncOutputPanel();
  }
  function syncOutputPanel() {
    var w = $('numOutWidth'), h = $('numOutHeight'), fps = $('numOutFps'), crf = $('numCrf'), audio = $('chkKeepAudio');
    if (w) w.value = project.output.width;
    if (h) h.value = project.output.height;
    if (fps) fps.value = project.output.fps;
    if (crf) crf.value = project.output.crf;
    if (audio) audio.checked = !!project.output.keepAudio;
  }
  bus.on('output:changed', syncOutputPanel);

  /* ===================================================================== *
   * 24. 字体下拉（沿用 v1：先占位，再用 /api/fonts 覆盖，只列存在者）
   * ===================================================================== */
  function bindFontSelect() {
    var sel = $('selFontFile'); if (!sel) return;
    populateFontSelect(sel, FONT_CANDIDATES);
    api.fonts().then(function (res) {
      var fonts = res && res.fonts;
      if (fonts && fonts.length) {
        populateFontSelect(sel, fonts);
        var c = curTextClip(); if (c) sel.value = c.fontFile;
      }
    }).catch(function () {});
  }
  function populateFontSelect(sel, fonts) {
    sel.innerHTML = '';
    fonts.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.path; o.textContent = f.name; sel.appendChild(o);
    });
  }

  /* ===================================================================== *
   * 25. 顶部工具栏（contract_v2 §4.1）
   * ===================================================================== */
  function bindToolbar() {
    var bi = $('btnImport');
    if (bi) bi.addEventListener('click', function () {
      bi.disabled = true;
      importViaPicker(true).then(function (ids) {
        if (ids.length) toast('已导入 ' + ids.length + ' 个视频到素材库', 'info', 1800);
        else toast('未选择文件', null, 1500);
      }).catch(function (e) { toast('导入失败：' + e.message, 'error'); })
        .then(function () { bi.disabled = false; });
    });

    var bat = $('btnAddText');
    if (bat) bat.addEventListener('click', function () {
      var id = addTextClip(null, getPlayhead());
      if (id && selection) selectClip(selection.trackId, id);
      else if (id) { var loc = locateClip(id); if (loc) selectClip(loc.track.id, id); }
    });

    var bsplit = $('btnSplit');
    if (bsplit) bsplit.addEventListener('click', function () {
      if (!selection || selection.kind === 'track' || !selection.clipId) { toast('请先选中一个片段', null, 1600); return; }
      splitClip(selection.trackId, selection.clipId, getPlayhead());
    });

    var bdel = $('btnDeleteClip');
    if (bdel) bdel.addEventListener('click', function () {
      if (!selection || !selection.clipId) { toast('请先选中一个片段', null, 1600); return; }
      removeClip(selection.trackId, selection.clipId);
    });
    var brip = $('btnRippleDelete');
    if (brip) brip.addEventListener('click', function () {
      if (!selection || !selection.clipId) { toast('请先选中一个片段', null, 1600); return; }
      rippleRemoveClip(selection.trackId, selection.clipId);
    });

    var bu = $('btnUndo'); if (bu) bu.addEventListener('click', function () { undo(); });
    var br = $('btnRedo'); if (br) br.addEventListener('click', function () { redo(); });
    var bp = $('btnPlayPause'); if (bp) bp.addEventListener('click', function () { togglePlay(); });
    var bx = $('btnExport'); if (bx) bx.addEventListener('click', function () { bus.emit('export:open', {}); });

    // 时间轴工具条（btnTl*）：与顶部按钮并存，复用同一套动作。
    function needSel() { if (!selection || !selection.clipId) { toast('请先选中一个片段', null, 1600); return false; } return true; }
    function bindClickById(id, fn) { var e = $(id); if (e) e.addEventListener('click', fn); }
    bindClickById('btnTlSplit', function () { if (!selection || selection.kind === 'track' || !selection.clipId) { toast('请先选中一个片段', null, 1600); return; } splitClip(selection.trackId, selection.clipId, getPlayhead()); });
    bindClickById('btnTlDelete', function () { if (!needSel()) return; removeClip(selection.trackId, selection.clipId); });
    bindClickById('btnTlRipple', function () { if (!needSel()) return; rippleRemoveClip(selection.trackId, selection.clipId); });
    bindClickById('btnTlDup', function () { if (!needSel()) return; duplicateClip(selection.trackId, selection.clipId); });
    bindClickById('btnTlUndo', function () { undo(); });
    bindClickById('btnTlRedo', function () { redo(); });

    // +轨道 菜单（contract_v2 §4.1 #addTrackMenu）：
    // 由 timeline.js 的 bindAddTrack() 唯一拥有按钮 #btnAddTrack 与菜单 #addTrackMenu
    // 的点击/开合逻辑。此处不再重复绑定，否则两个 click 监听会双切换（菜单永远打不开）
    // 且菜单项点击会双触发（多加一条轨道）。timeline 经 App.addTrack 完成增轨。
    // 仅保留解耦事件通道，供其他模块按需触发增轨。
    bus.on('addTrack:request', function (p) { addTrack(p && p.kind ? p.kind : 'video'); });
  }

  function refreshUndoRedoButtons() {
    var bu = $('btnUndo'), br = $('btnRedo'), tu = $('btnTlUndo'), tr = $('btnTlRedo');
    if (bu) bu.disabled = !canUndo();
    if (br) br.disabled = !canRedo();
    if (tu) tu.disabled = !canUndo();
    if (tr) tr.disabled = !canRedo();
  }

  // 空时间轴：禁用导出/播放/分割（contract_v2 §6.9 B1）
  function refreshButtonStates() {
    var has = totalDuration() > 0;
    var noSel = !(selection && selection.clipId);
    [['btnExport', !has], ['btnPlayPause', !has],
     ['btnSplit', !has], ['btnTlSplit', noSel],
     ['btnDeleteClip', noSel], ['btnTlDelete', noSel],
     ['btnRippleDelete', noSel], ['btnTlRipple', noSel],
     ['btnTlDup', noSel]
    ].forEach(function (pair) { var el = $(pair[0]); if (el) el.disabled = pair[1]; });
    var hint = $('emptyHint'); if (hint) hint.style.display = has ? 'none' : '';
  }
  bus.on('project:changed', refreshButtonStates);
  bus.on('selection:changed', refreshButtonStates);

  /* ===================================================================== *
   * 26. 文字编辑态标记（player.renderTexts 用，避免编辑时被重渲覆盖）
   * ===================================================================== */
  var _editingText = false;
  function isEditingText() { return _editingText; }
  function setEditingText(on) { _editingText = !!on; }

  // box 尺寸：engine_v2 用 #canvasBox；v1 用 #videoWrap。两者兼容。
  function getBoxSize() {
    var box = document.getElementById('canvasBox') || document.getElementById('videoWrap');
    return { boxW: (box && box.clientWidth) || 0, boxH: (box && box.clientHeight) || 0 };
  }

  /* ===================================================================== *
   * 27. 暴露 window.App（contract_v2 §3.2 全部方法）
   * ===================================================================== */
  var App = {
    // 状态访问
    project: project,
    bus: bus,
    api: api,
    getProject: getProject,
    getTimeline: getTimeline,
    rebuildTimeline: rebuildTimeline,
    totalDuration: totalDuration,

    // 历史
    pushHistory: pushHistory,
    undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo,

    // 素材库 / 导入
    addMedia: addMedia, removeMedia: removeMedia, getMedia: getMedia,
    importViaPicker: importViaPicker, importViaUpload: importViaUpload, importFiles: importFiles,

    // 轨道
    addTrack: addTrack, removeTrack: removeTrack, setTrackProp: setTrackProp,
    moveTrack: moveTrack, getTrack: getTrack,

    // 视频片段
    addClipFromMedia: addClipFromMedia, splitClip: splitClip, removeClip: removeClip,
    rippleRemoveClip: rippleRemoveClip, moveClip: moveClip, trimClip: trimClip,
    setClipTransform: setClipTransform, setClipSpeed: setClipSpeed, getClip: getClip,
    duplicateClip: duplicateClip, copyClip: copyClip, pasteClip: pasteClip,

    // 文字片段
    addTextClip: addTextClip, setTextProp: setTextProp,

    // 输出
    setOutputProp: setOutputProp,

    // 选择
    selectClip: selectClip, selectTrack: selectTrack, clearSelection: clearSelection,
    getSelection: getSelection, selectAdjacentTrack: selectAdjacentTrack,

    // 播放代理
    play: play, pause: pause, togglePlay: togglePlay, seek: seek, stepFrame: stepFrame,
    getPlayhead: getPlayhead,

    // 导出
    buildExportProject: buildExportProject,

    // 引擎 / 文字层 / 工具
    engine: null,
    locateClip: locateClip,
    getBoxSize: getBoxSize,
    isEditingText: isEditingText, setEditingText: setEditingText,
    clamp: clamp, clamp01: clamp01, toEven: toEven, fmtTime: fmtTime, toast: toast,
    DEFAULT_FONT: DEFAULT_FONT, FONT_CANDIDATES: FONT_CANDIDATES,
    SNAP_PX: SNAP_PX, MIN_CLIP: MIN_CLIP,
    nextId: nextId, defaultTransform: defaultTransform,

    /* ---- timeline_v2.md 风格别名（按 clipId 全局定位，兼容该模块写法）---- */
    splitClipAt: function (clipId, atSec) { var l = locateClip(clipId); return l ? splitClip(l.track.id, clipId, atSec) : null; },
    trimClipStart: function (clipId, newStartSec) {
      var l = locateClip(clipId); if (!l) return;
      var delta = newStartSec - l.clip.start;
      trimClip(l.track.id, clipId, 'in', delta, { noHistory: true });
    },
    trimClipEnd: function (clipId, newEndSec) {
      var l = locateClip(clipId); if (!l) return;
      var curEnd = l.clip.start + clipDur(l.clip, l.track);
      trimClip(l.track.id, clipId, 'out', newEndSec - curEnd, { noHistory: true });
    },
    // timeline_v2 的 moveClip(clipId, toTrackId, newStart) / removeClip(clipId) /
    // rippleRemoveClip(clipId) / selectClip(clipId) 用 clipId 单参；这里做兼容包装：
    moveClipById: function (clipId, toTrackId, newStart) { var l = locateClip(clipId); return l ? moveClip(l.track.id, clipId, newStart, toTrackId, { noHistory: true }) : null; },
    removeClipById: function (clipId) { var l = locateClip(clipId); if (l) removeClip(l.track.id, clipId); },
    rippleRemoveClipById: function (clipId) { var l = locateClip(clipId); if (l) rippleRemoveClip(l.track.id, clipId); },
    selectClipById: function (clipId) { if (clipId == null) { clearSelection(); return; } var l = locateClip(clipId); if (l) selectClip(l.track.id, clipId); }
  };
  // selectedClipId/selectedTextId 兼容只读（部分旧模块/overlay 可能读取）
  Object.defineProperty(App, 'selectedClipId', { get: function () { return selection && (selection.kind === 'clip' || selection.kind === 'text') ? selection.clipId : null; } });
  Object.defineProperty(App, 'selectedTextId', { get: function () { return selection && selection.kind === 'text' ? selection.clipId : null; } });

  window.App = App;

  /* ===================================================================== *
   * 28. 初始化
   * ===================================================================== */
  initDefaultTracks();
  rebuildTimeline();

  document.addEventListener('DOMContentLoaded', function () {
    bindFontSelect();
    bindToolbar();
    bindPropPanel();
    bindOutputPanel();
    bindOsFileDrop();
    renderMediaList();
    renderPropPanel();
    refreshButtonStates();
    refreshUndoRedoButtons();
    // 首次素材导入后按首素材初始化输出尺寸（用户未手动改过时）
    bus.on('media:changed', function () { maybeInitOutputFromFirstMedia(false); });
  });

})();
