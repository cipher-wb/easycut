/* ===========================================================================
 * ai.js —— AI 剪辑助手（自然语言驱动剪辑）
 * ---------------------------------------------------------------------------
 * 设计（见 CLAUDE.md / README「AI 助手」）：
 *  1) 指令层：把"对剪辑工程的每一种操作"抽象成一条 JSON 指令 {op, ...}；OPS 注册表
 *     里每个 op = { check(读校验), run(经 window.App.* 落地) }。以后加功能 = 注册新 op。
 *  2) 解析器：把"名字为X""前缀X""第一条视频轨""选中片段""中间1/3"等自然语言引用，
 *     解析成具体的 mediaId / trackId / clipId / 秒数。
 *  3) 解释器：先整体校验 → 需要时确认（导出/删除）→ 一次性作为单步撤销执行 → 刷新。
 *  4) AI 桥：把"指令表说明 + 当前工程快照"作为系统提示发给后端 /api/ai 代理；模型只输出
 *     一个 JSON 对象 { "say": 给用户的话, "commands": [ ... ] }；本地校验，不合法就把错误
 *     回传让模型自动修复（最多 2 次），只有校验通过才执行（仿 Mermaid 的"校验+修复"）。
 *  全部编辑都走 App.* mutator —— 撤销 / 预览 / 时间轴刷新 / 脏标记自动正确。
 * =========================================================================== */
(function () {
  'use strict';

  if (!window.App) { console.error('[ai] App 未就绪，ai.js 必须在 app.js 之后加载'); return; }
  var App = window.App;

  var STORAGE = { OPEN: 'qj-ai-open', WIDTH: 'qj-ai-width', CHAT: 'qj-ai-chat' };
  var MIN_W = 280, MAX_W = 720, DEFAULT_W = 340, MAX_REPAIR = 2;

  var lastClipId = null;     // 最近一次由 AI 添加的片段（供 "last" 引用）
  var pending = false;       // 正在等模型返回
  var cfgCache = null;       // /api/ai/config 的脱敏视图

  /* ===================== 小工具 ===================== */
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\.[^.]+$/, '').trim(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function n1(x) { return (Math.round(x * 10) / 10); }
  function refStr(r) { return typeof r === 'object' ? JSON.stringify(r) : String(r); }
  function mediaNames() { return (App.getProject().media || []).map(function (m) { return '"' + m.name + '"'; }).join('、') || '(空)'; }
  function mediaDur(m) { return Math.max(0.04, +m.duration || 0); }
  function clipLen(clip) { return Math.max(0.04, (clip.out - clip['in']) / (clip.speed || 1)); }

  function postAI(path, body) {
    return fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!res.ok) { throw new Error((data && data.error) || ('请求失败 HTTP ' + res.status)); }
        return data;
      });
    });
  }
  function getAI(path) { return fetch(path).then(function (r) { return r.json(); }); }

  /* ===================== 解析器（自然语言引用 → id / 秒） ===================== */
  function findMedia(ref) {
    var list = App.getProject().media || [];
    if (ref && typeof ref === 'object') {
      if (ref.all) return list.slice();
      if (ref.prefix != null) { var p = norm(ref.prefix); return list.filter(function (m) { return norm(m.name).indexOf(p) === 0; }); }
      if (ref.contains != null) { var c = norm(ref.contains); return list.filter(function (m) { return norm(m.name).indexOf(c) >= 0; }); }
      ref = ref.name || '';
    }
    var q = norm(ref);
    if (!q) return [];
    var exact = list.filter(function (m) { return norm(m.name) === q; });
    if (exact.length) return exact;
    var starts = list.filter(function (m) { return norm(m.name).indexOf(q) === 0; });
    if (starts.length) return starts;
    return list.filter(function (m) { return norm(m.name).indexOf(q) >= 0; });
  }
  // 是否"批量"引用（{all}/{prefix}/{contains}）；否则按单个取最佳匹配
  function isMultiRef(ref) { return !!(ref && typeof ref === 'object' && (ref.all || ref.prefix != null || ref.contains != null)); }
  function resolveMediaList(ref) { var arr = findMedia(ref); return isMultiRef(ref) ? arr : arr.slice(0, 1); }

  function resolveTrackId(ref, kind) {
    var tracks = App.getProject().tracks || [];
    var of = tracks.filter(function (t) { return t.kind === kind; });
    if (ref == null || ref === '' || ref === 'first_video' || ref === 'first') return of.length ? of[0].id : null;
    if (ref === 'selected') { var s = App.getSelection(); return s ? s.trackId : null; }
    if (ref === 'last_video' || ref === 'last' || ref === 'top') return of.length ? of[of.length - 1].id : null;
    if (ref === 'new') return null; // 创建延迟到 run 阶段
    if (typeof ref === 'number') return of[ref] ? of[ref].id : null;
    var byName = of.filter(function (t) { return norm(t.name) === norm(ref); });
    if (byName.length) return byName[0].id;
    var loose = of.filter(function (t) { return norm(t.name).indexOf(norm(ref)) >= 0; });
    return loose.length ? loose[0].id : null;
  }

  function resolveClipRef(ref) {
    if (ref == null) ref = 'selected';
    if (ref === 'selected') { var s = App.getSelection(); return (s && s.clipId) ? { trackId: s.trackId, clipId: s.clipId } : null; }
    if (ref === 'last' && lastClipId) { var l = App.locateClip(lastClipId); return l ? { trackId: l.track.id, clipId: lastClipId } : null; }
    if (typeof ref === 'object' && ref.id) { var l2 = App.locateClip(ref.id); return l2 ? { trackId: l2.track.id, clipId: ref.id } : null; }
    var medias = findMedia(typeof ref === 'string' ? ref : (ref && (ref.media || ref.name)) || '');
    if (medias.length) {
      var ids = medias.map(function (m) { return m.id; }), hit = null;
      (App.getProject().tracks || []).forEach(function (t) {
        (t.clips || []).forEach(function (cc) { if (!hit && cc.mediaId && ids.indexOf(cc.mediaId) >= 0) hit = { trackId: t.id, clipId: cc.id }; });
      });
      if (hit) return hit;
    }
    return null;
  }

  function trackEndSec(trackId) {
    var tl = App.getTimeline(), end = 0;
    (tl.videoTracks || []).forEach(function (vt) {
      if (vt.track.id === trackId) vt.clips.forEach(function (seg) { if (seg.tEnd > end) end = seg.tEnd; });
    });
    return end;
  }
  function clipSpan(clipId) {
    var tl = App.getTimeline(), found = null;
    (tl.videoTracks || []).forEach(function (vt) { vt.clips.forEach(function (seg) { if (seg.clip.id === clipId) found = { tStart: seg.tStart, tEnd: seg.tEnd }; }); });
    if (!found) { var l = App.locateClip(clipId); if (l && l.clip && l.clip.start != null) { var c = l.clip; found = { tStart: c.start, tEnd: c.start + (c.duration != null ? c.duration : clipLen(c)) }; } }
    return found;
  }

  // 片段引用「在校验时」是否可解析：已在时间轴上，或同一批里前面的 add_clip 会创建它。
  // （校验整批指令时，后面的指令可能引用前面 add_clip 刚加入的片段——此时它还没真正落地，
  //   不能按当前状态判定"找不到"。ctx.added 记录前序 add_clip 将创建的 mediaId。）
  function clipResolvable(ref, ctx) {
    if (resolveClipRef(ref)) return true;
    if (ref === 'last' && ctx && ctx.added && ctx.added.length) return true;
    var ms = findMedia(typeof ref === 'string' ? ref : (ref && (ref.media || ref.name)) || '');
    if (ms.length && ctx && ctx.added) { for (var i = 0; i < ms.length; i++) if (ctx.added.indexOf(ms[i].id) >= 0) return true; }
    return false;
  }

  // 文字位置预设 → {xPct,yPct,align}
  var TEXT_POS = {
    'top-left': { x: 0.05, y: 0.05, a: 'left' }, 'top-center': { x: 0.25, y: 0.05, a: 'center' }, 'top-right': { x: 0.55, y: 0.05, a: 'right' },
    'center': { x: 0.25, y: 0.45, a: 'center' }, 'middle': { x: 0.25, y: 0.45, a: 'center' },
    'bottom-left': { x: 0.05, y: 0.86, a: 'left' }, 'bottom-center': { x: 0.25, y: 0.86, a: 'center' }, 'bottom-right': { x: 0.55, y: 0.86, a: 'right' },
    'left': { x: 0.05, y: 0.45, a: 'left' }, 'right': { x: 0.55, y: 0.45, a: 'right' }
  };

  /* ===================== 指令注册表 OPS ===================== */
  function clipOpts(c, m, opts) {
    var o = { noHistory: !!(opts && opts.noHistory) }, dur = mediaDur(m);
    if (c.inFrac != null) o['in'] = clamp(+c.inFrac, 0, 1) * dur; else if (c['in'] != null) o['in'] = +c['in'];
    if (c.outFrac != null) o.out = clamp(+c.outFrac, 0, 1) * dur; else if (c.out != null) o.out = +c.out;
    if (c.speed != null) o.speed = +c.speed;
    if (c.scale != null) o.scale = +c.scale;
    if (c.cx != null) o.cx = +c.cx;
    if (c.cy != null) o.cy = +c.cy;
    if (c.opacity != null) o.opacity = +c.opacity;
    return o;
  }

  var OPS = {
    add_clip: {
      confirm: false,
      check: function (c, ctx) {
        var arr = resolveMediaList(c.media);
        if (!arr.length) return { ok: false, error: '找不到素材 ' + refStr(c.media) + '；素材库现有：' + mediaNames() };
        if (c.speed != null && (+c.speed < 0.25 || +c.speed > 4)) return { ok: false, error: 'speed 必须在 0.25–4 之间' };
        if (ctx && ctx.added) arr.forEach(function (m) { ctx.added.push(m.id); }); // 记录：本条会让这些素材出现在时间轴上
        var label = '把 ' + arr.map(function (m) { return '"' + m.name + '"'; }).join('、') + ' 放入时间轴';
        if (c.speed != null) label += '（' + c.speed + '×）';
        if (c.inFrac != null || c.outFrac != null || c['in'] != null || c.out != null) label += '（裁剪）';
        if (arr.length > 1) label += '，' + (c.mode === 'stack' ? '各占一轨同时播放' : '依次顺序排列');
        return { ok: true, summary: label };
      },
      run: function (c, opts) {
        var arr = resolveMediaList(c.media), done = [];
        var stack = (arr.length > 1 && c.mode === 'stack');
        if (stack) {
          var startS = (c.at === 'end' || c.at == null) ? 0 : (+c.at || 0);
          arr.forEach(function (m, i) {
            var tid = (i === 0) ? (resolveTrackId(c.track || 'first_video', 'video') || App.addTrack('video', undefined, { noHistory: true })) : App.addTrack('video', undefined, { noHistory: true });
            var id = App.addClipFromMedia(m.id, tid, startS, clipOpts(c, m, opts));
            if (id) { done.push(m.name); lastClipId = id; }
          });
        } else {
          var tid0 = resolveTrackId(c.track || 'first_video', 'video') || App.addTrack('video', undefined, { noHistory: true });
          var s = (c.at === 'end' || c.at == null) ? trackEndSec(tid0) : (+c.at || 0);
          arr.forEach(function (m) {
            var id = App.addClipFromMedia(m.id, tid0, s, clipOpts(c, m, opts));
            if (id) { done.push(m.name); lastClipId = id; var l = App.locateClip(id); if (l) s = l.clip.start + clipLen(l.clip); }
          });
        }
        return done.length ? ('✓ 已放入 ' + done.length + ' 个片段：' + done.join('、')) : '✗ 未能放入（轨道可能已满或被锁定）';
      }
    },

    set_speed: {
      confirm: false,
      check: function (c, ctx) {
        if (c.speed == null || +c.speed < 0.25 || +c.speed > 4) return { ok: false, error: 'speed 必须在 0.25–4 之间' };
        if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要变速的片段：' + refStr(c.clip) };
        return { ok: true, summary: '把片段变速为 ' + c.speed + '×' };
      },
      run: function (c, opts) {
        var l = resolveClipRef(c.clip); App.setClipSpeed(l.trackId, l.clipId, +c.speed, { noHistory: !!(opts && opts.noHistory) });
        return '✓ 变速 ' + c.speed + '×';
      }
    },

    trim_clip: {
      confirm: false,
      check: function (c, ctx) {
        if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要裁剪的片段：' + refStr(c.clip) };
        if (c['in'] == null && c.out == null && c.inFrac == null && c.outFrac == null) return { ok: false, error: 'trim_clip 需要 in/out 或 inFrac/outFrac' };
        return { ok: true, summary: '裁剪片段源区间' };
      },
      run: function (c) {
        var loc = resolveClipRef(c.clip), l = App.locateClip(loc.clipId), clip = l.clip, m = App.getMedia(clip.mediaId), dur = m ? mediaDur(m) : (clip.out || 1);
        var ni = clip['in'], no = clip.out;
        if (c.inFrac != null) ni = clamp(+c.inFrac, 0, 1) * dur; else if (c['in'] != null) ni = clamp(+c['in'], 0, dur);
        if (c.outFrac != null) no = clamp(+c.outFrac, 0, 1) * dur; else if (c.out != null) no = clamp(+c.out, 0, dur);
        var MIN = App.MIN_CLIP || 0.04;
        if (no < ni + MIN) no = Math.min(dur, ni + MIN);
        clip['in'] = ni; clip.out = no;
        App.rebuildTimeline(); App.bus.emit('clips:changed', { trackId: loc.trackId }); App.bus.emit('project:changed', { reason: 'ai-trim' }); App.markDirty();
        return '✓ 裁剪为源 ' + n1(ni) + 's–' + n1(no) + 's';
      }
    },

    move_clip: {
      confirm: false,
      check: function (c, ctx) {
        if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要移动的片段：' + refStr(c.clip) };
        if (c.start == null) return { ok: false, error: 'move_clip 需要 start（时间轴秒）' };
        return { ok: true, summary: '移动片段到 ' + n1(+c.start) + 's' };
      },
      run: function (c, opts) {
        var loc = resolveClipRef(c.clip), toTrack = c.track ? resolveTrackId(c.track, 'video') : undefined;
        App.moveClip(loc.trackId, loc.clipId, +c.start, toTrack || undefined, { noHistory: !!(opts && opts.noHistory) });
        return '✓ 已移动到 ' + n1(+c.start) + 's';
      }
    },

    split_clip: {
      confirm: false,
      check: function (c, ctx) {
        if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要分割的片段：' + refStr(c.clip) };
        if (c.at == null) return { ok: false, error: 'split_clip 需要 at（时间轴秒）' };
        return { ok: true, summary: '在 ' + n1(+c.at) + 's 处分割片段' };
      },
      run: function (c, opts) { var loc = resolveClipRef(c.clip); var r = App.splitClip(loc.trackId, loc.clipId, +c.at, { noHistory: !!(opts && opts.noHistory) }); return r ? '✓ 已在 ' + n1(+c.at) + 's 分割' : '✗ 该位置无法分割'; }
    },

    close_gap: {
      confirm: false,
      check: function (c, ctx) {
        if (c.clip != null) { if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到片段：' + refStr(c.clip) }; return { ok: true, summary: '删除该片段前的空隙' }; }
        if (c.track != null && c.at != null) return { ok: true, summary: '删除空隙' };
        return { ok: false, error: 'close_gap 需要 clip，或 track + at' };
      },
      run: function (c, opts) {
        var o = { noHistory: !!(opts && opts.noHistory) };
        if (c.clip != null) {
          var loc = resolveClipRef(c.clip); if (!loc) return '✗ 找不到片段';
          var l = App.locateClip(loc.clipId); if (!l) return '✗ 找不到片段';
          return App.closeGap(loc.trackId, l.clip.start - 0.001, o) ? '✓ 已删除空隙' : '（该片段前没有空隙）';
        }
        var tid = resolveTrackId(c.track, 'video');
        return (tid && App.closeGap(tid, +c.at, o)) ? '✓ 已删除空隙' : '✗ 未找到可删的空隙';
      }
    },

    set_transform: {
      confirm: false,
      check: function (c, ctx) {
        if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要变换的片段：' + refStr(c.clip) };
        return { ok: true, summary: '调整画中画（缩放/位置/不透明度）' };
      },
      run: function (c, opts) {
        var loc = resolveClipRef(c.clip), patch = {};
        if (c.scale != null) patch.scale = +c.scale; if (c.cx != null) patch.cx = +c.cx; if (c.cy != null) patch.cy = +c.cy; if (c.opacity != null) patch.opacity = +c.opacity;
        App.setClipTransform(loc.trackId, loc.clipId, patch, { noHistory: !!(opts && opts.noHistory) });
        return '✓ 已调整画中画';
      }
    },

    delete_clip: {
      confirm: true,
      check: function (c, ctx) { if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要删除的片段：' + refStr(c.clip) }; return { ok: true, summary: (c.ripple ? '波纹删除' : '删除') + '片段 ' + refStr(c.clip) }; },
      run: function (c, opts) { var loc = resolveClipRef(c.clip), o = { noHistory: !!(opts && opts.noHistory) }; if (c.ripple) App.rippleRemoveClip(loc.trackId, loc.clipId, o); else App.removeClip(loc.trackId, loc.clipId, o); return '✓ 已删除片段'; }
    },

    add_text: {
      confirm: false,
      check: function (c, ctx) {
        if (!c.content && c.content !== 0) return { ok: false, error: 'add_text 需要 content（文字内容）' };
        if (c.during != null && !clipResolvable(c.during, ctx)) return { ok: false, error: '找不到 during 指向的片段：' + refStr(c.during) + '（请确认它已在时间轴上，或本批前面有把它放进时间轴的 add_clip）' };
        return { ok: true, summary: '添加文字"' + String(c.content).slice(0, 12) + '"' + (c.position ? '（' + c.position + '）' : '') };
      },
      run: function (c, opts) {
        var nh = !!(opts && opts.noHistory);
        var start = 0, dur = c.duration != null ? +c.duration : 3;
        if (c.during != null) { var loc = resolveClipRef(c.during), sp = loc && clipSpan(loc.clipId); if (sp) { start = sp.tStart; dur = Math.max(0.5, sp.tEnd - sp.tStart); } }
        else if (c.start != null) start = +c.start;
        else start = App.getPlayhead ? App.getPlayhead() : 0;
        var trackId = c.track ? resolveTrackId(c.track, 'text') : null;
        var id = App.addTextClip(trackId, start, { noHistory: nh });
        if (!id) return '✗ 无法添加文字';
        lastClipId = id; var l = App.locateClip(id), tid = l.track.id;
        var set = function (k, v) { App.setTextProp(tid, id, k, v, { noHistory: true }); };
        set('content', String(c.content));
        set('start', start); set('duration', dur);
        var pos = c.position && TEXT_POS[String(c.position).toLowerCase()];
        if (pos) { set('xPct', pos.x); set('yPct', pos.y); set('align', pos.a); }
        if (c.xPct != null) set('xPct', clamp(+c.xPct, 0, 1));
        if (c.yPct != null) set('yPct', clamp(+c.yPct, 0, 1));
        if (c.align) set('align', c.align);
        if (c.color) set('color', c.color);
        if (c.fontSizePct != null) set('fontSizePct', +c.fontSizePct);
        return '✓ 已添加文字"' + String(c.content).slice(0, 16) + '"';
      }
    },

    set_text: {
      confirm: false,
      check: function (c, ctx) { if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要修改的文字片段：' + refStr(c.clip) }; return { ok: true, summary: '修改文字属性' }; },
      run: function (c, opts) {
        var loc = resolveClipRef(c.clip), keys = ['content', 'color', 'align', 'xPct', 'yPct', 'wPct', 'fontSizePct', 'opacity', 'start', 'duration', 'border', 'box', 'fontFile', 'borderColor', 'boxColor'];
        var n = 0; keys.forEach(function (k) { if (c[k] != null) { App.setTextProp(loc.trackId, loc.clipId, k, c[k], { noHistory: !!(opts && opts.noHistory) }); n++; } });
        return n ? '✓ 已修改文字' : '（无可改属性）';
      }
    },

    add_track: {
      confirm: false,
      check: function (c) { var k = c.kind === 'text' ? 'text' : 'video'; return { ok: true, summary: '新建' + (k === 'text' ? '文字' : '视频') + '轨' }; },
      run: function (c, opts) { App.addTrack(c.kind === 'text' ? 'text' : 'video', undefined, { noHistory: !!(opts && opts.noHistory) }); return '✓ 已新建轨道'; }
    },

    remove_track: {
      confirm: true,
      check: function (c) { var id = resolveTrackId(c.track, c.kind === 'text' ? 'text' : 'video'); if (!id) return { ok: false, error: '找不到要删除的轨道：' + refStr(c.track) }; return { ok: true, summary: '删除轨道 ' + refStr(c.track) }; },
      run: function (c, opts) { var id = resolveTrackId(c.track, c.kind === 'text' ? 'text' : 'video'); App.removeTrack(id, { noHistory: !!(opts && opts.noHistory) }); return '✓ 已删除轨道'; }
    },

    set_track: {
      confirm: false,
      check: function (c) { var k = c.kind === 'text' ? 'text' : 'video'; if (!resolveTrackId(c.track, k)) return { ok: false, error: '找不到轨道：' + refStr(c.track) }; return { ok: true, summary: '设置轨道属性' }; },
      run: function (c, opts) {
        var k = c.kind === 'text' ? 'text' : 'video', id = resolveTrackId(c.track, k), n = 0;
        ['name', 'muted', 'volume', 'hidden', 'locked'].forEach(function (key) { if (c[key] != null) { App.setTrackProp(id, key, c[key], { noHistory: !!(opts && opts.noHistory) }); n++; } });
        return n ? '✓ 已设置轨道' : '（无可改属性）';
      }
    },

    set_output: {
      confirm: false,
      check: function () { return { ok: true, summary: '修改输出设置' }; },
      run: function (c, opts) { var o = { noHistory: !!(opts && opts.noHistory) }, n = 0; ['width', 'height', 'fps', 'crf', 'keepAudio'].forEach(function (k) { if (c[k] != null) { App.setOutputProp(k, c[k], o); n++; } }); return n ? '✓ 已修改输出设置' : '（无可改项）'; }
    },

    freeze: {
      confirm: false,
      check: function (c, ctx) {
        if (!clipResolvable(c.clip, ctx)) return { ok: false, error: '找不到要定格的片段：' + refStr(c.clip) };
        return { ok: true, summary: '定格' + (c.duration != null ? ' ' + c.duration + 's' : ' 3s') + (c.mode === 'standalone' ? '（独立静止段）' : '（就地插入）') };
      },
      run: function (c) {
        var loc = resolveClipRef(c.clip); if (!loc) return '✗ 找不到片段';
        var l = App.locateClip(loc.clipId); if (!l) return '✗ 找不到片段';
        var clip = l.clip, cdur = clip.freeze ? (clip.duration || 0) : ((clip.out - clip.in) / (clip.speed || 1));
        var at = (c.at != null) ? +c.at : (clip.start + cdur / 2);
        at = Math.max(clip.start + 0.05, Math.min(clip.start + cdur - 0.05, at));
        App.selectClip(loc.trackId, loc.clipId);
        if (App.seek) App.seek(at);
        var D = (c.duration != null) ? +c.duration : 3;
        var id = App.freezeAtPlayhead(c.mode === 'standalone' ? 'standalone' : 'inplace', D);
        return id ? ('✓ 已在 ' + n1(at) + 's 定格 ' + n1(D) + 's') : '✗ 定格失败（位置不合法？）';
      }
    },

    export: {
      kind: 'action', confirm: false,
      check: function () { var dur = App.totalDuration ? App.totalDuration() : 0; if (!dur) return { ok: false, error: '时间轴为空，没有可导出的内容' }; return { ok: true, summary: '导出视频（将打开导出窗口确认保存位置）' }; },
      run: function () { if (App.openExport) App.openExport(); else App.bus.emit('export:open', {}); return '✓ 已打开导出窗口，请选择保存位置并点「开始导出」'; }
    }
  };

  /* ===================== 解释器 ===================== */
  function validateAll(cmds) {
    var errors = [], summaries = [], ctx = { added: [] }; // ctx 累积"前序 add_clip 将创建的 mediaId"，供前向引用校验
    if (!Array.isArray(cmds)) return { ok: false, errors: ['commands 必须是数组'], summaries: [] };
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i]; if (!c || !c.op) { errors.push('第 ' + (i + 1) + ' 条缺少 op'); continue; }
      var op = OPS[c.op];
      if (!op) { errors.push('第 ' + (i + 1) + ' 条 op "' + c.op + '" 未知。可用：' + Object.keys(OPS).join(', ')); continue; }
      var r = op.check(c, ctx);
      if (!r.ok) errors.push('第 ' + (i + 1) + ' 条（' + c.op + '）：' + r.error); else summaries.push(r.summary);
    }
    return { ok: errors.length === 0, errors: errors, summaries: summaries };
  }

  function executePlan(cmds, check) {
    var edits = cmds.filter(function (c) { return OPS[c.op] && OPS[c.op].kind !== 'action'; });
    var actions = cmds.filter(function (c) { return OPS[c.op] && OPS[c.op].kind === 'action'; });
    var needConfirm = cmds.some(function (c) { return OPS[c.op] && OPS[c.op].confirm; });
    var go = function () {
      var results = [];
      if (edits.length) {
        App.pushHistory();
        edits.forEach(function (c) { try { results.push(OPS[c.op].run(c, { noHistory: true })); } catch (e) { results.push('✗ ' + c.op + '：' + (e && e.message || e)); } });
      }
      actions.forEach(function (c) { try { results.push(OPS[c.op].run(c, {})); } catch (e) { results.push('✗ ' + (e && e.message || e)); } });
      if (results.length) addMsg('note', results.join('\n'));
    };
    if (needConfirm) {
      confirmPlan(check.summaries).then(function (ok) { if (ok) go(); else addMsg('note', '已取消。'); });
    } else { go(); }
  }

  /* ===================== AI 桥 ===================== */
  function stateSnapshot() {
    var p = App.getProject(), sel = App.getSelection && App.getSelection();
    var media = (p.media || []).map(function (m) { return '  - "' + m.name + '"  时长' + n1(m.duration || 0) + 's  ' + (m.width || '?') + '×' + (m.height || '?') + (m.hasAudio ? ' 有声' : ' 无声'); }).join('\n') || '  (素材库为空)';
    var tracks = (p.tracks || []).map(function (t, i) { return '  - [' + i + '] ' + (t.kind === 'video' ? '视频轨' : '文字轨') + ' "' + t.name + '" 含' + (t.clips || []).length + '个片段' + (t.muted ? ' 静音' : '') + (t.locked ? ' 锁定' : '') + (t.hidden ? ' 隐藏' : ''); }).join('\n') || '  (无轨道)';
    var o = p.output || {};
    var lines = ['【当前工程状态】',
      '输出：' + (o.width || '?') + '×' + (o.height || '?') + ' @' + (o.fps || '?') + 'fps  CRF' + (o.crf != null ? o.crf : '?') + (o.keepAudio ? '  保留音轨' : '  无音轨'),
      '总时长：' + n1(App.totalDuration ? App.totalDuration() : 0) + 's；播放头：' + n1(App.getPlayhead ? App.getPlayhead() : 0) + 's',
      '素材库（轨道数组顺序即图层 z 序，[0]在最底层）：', media,
      '轨道：', tracks];
    if (sel && sel.clipId) lines.push('当前选中片段 id=' + sel.clipId + '（可用 clip:"selected" 引用）');
    return lines.join('\n');
  }

  function buildSystemPrompt() {
    return [
'你是「轻剪 EasyCut」视频剪辑软件内置的 AI 剪辑助手。用户用中文说想怎么剪，你把它翻译成软件能执行的结构化指令。',
'',
'【输出格式】只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块。形如：',
'{ "say": "给用户看的一句中文说明", "commands": [ {"op":"...", ...}, ... ] }',
'- say：对用户友好的简短回应。',
'- commands：要执行的指令数组；若只是闲聊/解释/需要澄清，就让 commands 为空数组 []，把话写在 say 里。',
'- 当你不确定用户指哪个素材/片段（比如名字对不上、有多个都像），不要瞎猜：commands 留空，在 say 里反问用户确认。',
'',
'【可用指令 op 及参数】',
'1. add_clip 把素材放入时间轴。media(必填) | track(默认"first_video"，也可"new"/"last_video"/轨道名/序号) | at("end"接到末尾[默认] 或 数字秒) | in/out(源裁剪秒) 或 inFrac/outFrac(0~1比例) | speed(0.25~4) | scale/cx/cy/opacity(0~1) | mode("sequential"顺序[默认] / "stack"各占一轨同时播放)。',
'   media 可以是：素材名字符串(智能匹配，忽略大小写和扩展名) | {"all":true}所有素材 | {"prefix":"前缀"} | {"contains":"包含"}。',
'2. set_speed 变速。clip(必填) | speed(0.25~4，减速一半=0.5)。',
'3. trim_clip 裁剪已有片段的源区间。clip(必填) | in/out(秒) 或 inFrac/outFrac(0~1)。"中间1/3到2/3"=> inFrac:0.333,outFrac:0.667。',
'4. move_clip 移动片段到某时间。clip | start(秒) | track(可选，跨轨)。',
'5. split_clip 分割片段。clip | at(时间轴秒)。',
'5.1 close_gap 删除空隙（把后续片段左移补缝，仅本轨）。clip(删除该片段前的空隙) 或 track + at(秒)。例：「删掉 风景 前面的空白」=> [{"op":"close_gap","clip":"风景"}]。',
'6. set_transform 画中画缩放/位置。clip | scale | cx | cy | opacity(均0~1，cx/cy为中心点比例)。',
'7. delete_clip 删除片段。clip | ripple(true=波纹删除并补缝)。【需用户确认】',
'8. add_text 加文字/字幕。content(必填) | during(片段引用，则文字覆盖该片段时间段) 或 start+duration(秒) | position("top-left"/"top-center"/"top-right"/"center"/"bottom-left"/"bottom-center"/"bottom-right") 或 xPct/yPct(0~1) | align | color(#RRGGBB) | fontSizePct(0~0.5) | track(可选)。',
'9. set_text 改文字属性。clip | content/color/align/xPct/yPct/fontSizePct/start/duration 等。',
'10. add_track 新建轨道。kind("video"/"text")。',
'11. remove_track 删除轨道。track | kind。【需用户确认】',
'12. set_track 轨道属性。track | kind | muted/volume(0~1)/hidden/locked/name。',
'13. set_output 输出设置。width/height/fps/crf/keepAudio。',
'14. export 导出视频（会打开导出窗口让用户确认保存位置）。无参数。',
'15. freeze 定格：把某视频片段在某时刻的画面冻结成静止段。clip(必填) | at(时间轴秒，默认片段中点) | duration(秒，默认3) | mode("inplace"就地分割插入[默认] / "standalone"独立静止段)。例：「把 开场 在第10秒定格5秒」=> [{"op":"freeze","clip":"开场","at":10,"duration":5}]。',
'',
'【引用方式】',
'- 片段 clip：可填 "selected"(当前选中) | "last"(你最近添加的) | 素材名(找用了该素材的片段) | {"id":"clip_x"}。',
'- 轨道 track：可填 "first_video"/"last_video" | "new"(新建) | 轨道名 | 数组序号(0在最底层)。',
'',
'【规则】',
'- 只能引用上面【当前工程状态】里真实存在的素材名/轨道；几何与比例一律用 0~1；时间用秒。',
'- 一句话要做多步就放多条 commands，按顺序执行，整体算一次撤销。',
'- 例：「把素材库所有素材按顺序放进时间轴」=> [{"op":"add_clip","media":{"all":true},"track":"first_video","at":"end","mode":"sequential"}]。',
'- 例：「把名为开场的视频放进去并减速50%」=> [{"op":"add_clip","media":"开场","speed":0.5}]。',
'- 例：「截取风景中间1/3到2/3放进时间轴」=> [{"op":"add_clip","media":"风景","inFrac":0.333,"outFrac":0.667}]。',
'- 例：「在 开场 这个视频期间左上角加字幕：你好」=> [{"op":"add_text","content":"你好","during":"开场","position":"top-left"}]。',
'- 「每个视频取前10秒」=> 对每个视频写一条 add_clip 并带 in:0,out:10。',
'- 给"每个片段分别加不同文字"时：为每个视频先写一条 add_clip，紧跟一条 add_text 用 during 指向同一个视频名（可在同一批指令里前后引用，系统会按顺序执行）。例：',
'  [{"op":"add_clip","media":"A","in":0,"out":10},{"op":"add_text","content":"文字1","during":"A","position":"top-left","color":"#FF5555"},{"op":"add_clip","media":"B","in":0,"out":10},{"op":"add_text","content":"文字2","during":"B","position":"top-left","color":"#55AAFF"}]。',
'',
stateSnapshot()
    ].join('\n');
  }

  function extractJSON(text) {
    if (!text) return null;
    var t = String(text).trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim();
    try { return coerce(JSON.parse(t)); } catch (e) {}
    var i = t.indexOf('{'); if (i < 0) return null;
    var depth = 0, inStr = false, escc = false;
    for (var j = i; j < t.length; j++) {
      var ch = t[j];
      if (inStr) { if (escc) escc = false; else if (ch === '\\') escc = true; else if (ch === '"') inStr = false; }
      else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { try { return coerce(JSON.parse(t.slice(i, j + 1))); } catch (e) { return null; } } } }
    }
    return null;
  }
  function coerce(o) { if (o && typeof o === 'object') { if (!('commands' in o) || !Array.isArray(o.commands)) o.commands = []; if (!('say' in o)) o.say = ''; } return o; }

  function askAI(userText) {
    if (pending) return;
    pending = true; setBusy(true);
    addMsg('user', userText); persistChat();
    var apiMsgs = msgs.filter(function (m) { return m.role === 'user' || m.role === 'assistant'; }).map(function (m) { return { role: m.role, content: m.text }; });
    var system = buildSystemPrompt();
    var thinking = addMsg('think', '思考中…');
    var attempt = 0, rawLast = '', lastErr = null;

    function step() {
      var sendMsgs = apiMsgs.slice();
      if (lastErr) { sendMsgs.push({ role: 'assistant', content: rawLast }); sendMsgs.push({ role: 'user', content: '刚才的指令有问题：' + lastErr + '\n请只重新输出修正后的 JSON 对象（{"say":...,"commands":[...]}）。' }); }
      postAI('/api/ai', { system: system, messages: sendMsgs }).then(function (r) {
        rawLast = r.content || '';
        var parsed = extractJSON(rawLast);
        if (!parsed) { return retryOrFail('返回的不是合法 JSON 对象'); }
        var check = validateAll(parsed.commands || []);
        if (!check.ok) { return retryOrFail(check.errors.join('；')); }
        removeMsg(thinking);
        addMsg('assistant', parsed.say || (check.summaries.length ? check.summaries.join('；') : '好的。'));
        persistChat();
        if ((parsed.commands || []).length) executePlan(parsed.commands, check);
        finish();
      }).catch(function (e) {
        removeMsg(thinking);
        addMsg('assistant', '⚠ ' + (e && e.message || e));
        finish();
      });
    }
    function retryOrFail(err) {
      lastErr = err; attempt++;
      if (attempt <= MAX_REPAIR) { step(); }
      else { removeMsg(thinking); addMsg('assistant', '抱歉，我没能把这条指令转成可执行的操作。\n（' + err + '）\n可以换种说法，或先确认素材库里素材的名字。'); persistChat(); finish(); }
    }
    function finish() { pending = false; setBusy(false); }
    step();
  }

  /* ===================== 执行时间轴批注（评论 → AI 剪辑） ===================== */
  // 汇总待执行评论为结构化上下文（每条带锚点：片段 clipId+时间 / 整轨时间）
  function buildCommentsContext() {
    var pend = (App.getComments ? App.getComments() : []).filter(function (c) { return c.status === 'pending'; });
    if (!pend.length) return null;
    var lines = pend.map(function (c) {
      var loc;
      if (c.scope === 'global') {
        loc = (c.kind === 'point') ? ('整轨/全局 第' + n1(c.at) + 's') : ('整轨/全局 区间[' + n1(c.start) + 's~' + n1(c.end) + 's]');
      } else {
        var l = App.locateClip ? App.locateClip(c.clipId) : null;
        var m = l ? App.getMedia(l.clip.mediaId) : null;
        var nm = m ? ('"' + m.name + '"') : '片段';
        loc = '片段 ' + nm + '(clipId=' + c.clipId + ') ' + (c.kind === 'point' ? ('第' + n1(c.at) + 's') : ('区间[' + n1(c.start) + 's~' + n1(c.end) + 's]'));
      }
      return '  - [' + c.id + '] ' + loc + '：' + c.text;
    }).join('\n');
    return { pending: pend, text: lines };
  }

  var COMMENT_EXEC = [
    '',
    '【任务：执行时间轴批注】上面每条是用户在时间轴上贴的"批注"（导演式剪辑指令），带锚点：',
    '某片段(clipId + 时间点/区间) 或 整轨/全局(时间点/区间)。请把每条转成命中其锚点的剪辑 op：',
    '- 片段引用一律用 {"id":"<clipId>"}（用上面给的 clipId），at/start/end 用批注给的时间轴秒。',
    '- 例：点"删除后续视频" => split_clip{clip,at} + delete_clip{clip:右段,ripple:true}；',
    '  区间"加速50%" => 用 split_clip 在区间两端切出中段，再 set_speed{clip:中段,speed:1.5}；',
    '  整轨区间"放一行字X" => add_text{content:X,start,duration=区间时长,position}。',
    '仍只输出一个 JSON 对象，但多加 done 字段（已成功转成操作的批注 id 数组）：',
    '{ "say":"先用一句话说明你将怎么做", "commands":[...], "done":["cmt_x", ...] }。',
    '看不懂/做不了的批注不要硬来：不放进 done，并在 say 里说明。'
  ].join('\n');

  function executeComments() {
    if (pending) return;
    var ctx = buildCommentsContext();
    if (!ctx) { App.toast && App.toast('没有待执行的批注', null, 1600); return; }
    if (elPanel && elPanel.hidden) setOpen(true);
    pending = true; setBusy(true);
    addMsg('user', '【执行时间轴批注】\n' + ctx.text); persistChat();
    var system = buildSystemPrompt();
    var thinking = addMsg('think', '正在理解批注…');
    var attempt = 0, rawLast = '', lastErr = null;

    function step() {
      var out = [{ role: 'user', content: ctx.text + '\n' + COMMENT_EXEC }];
      if (lastErr) { out.push({ role: 'assistant', content: rawLast }); out.push({ role: 'user', content: '刚才的输出有问题：' + lastErr + '\n请只重新输出修正后的 JSON（{"say":...,"commands":[...],"done":[...]}）。' }); }
      postAI('/api/ai', { system: system, messages: out }).then(function (r) {
        rawLast = r.content || '';
        var parsed = extractJSON(rawLast);
        if (!parsed) return retryOrFail('返回的不是合法 JSON 对象');
        var cmds = parsed.commands || [];
        var check = validateAll(cmds);
        if (!check.ok) return retryOrFail(check.errors.join('；'));
        removeMsg(thinking);
        addMsg('assistant', parsed.say || '我将按批注执行以下操作：'); persistChat();
        var doneIds = (Array.isArray(parsed.done) && parsed.done.length) ? parsed.done : ctx.pending.map(function (c) { return c.id; });
        if (!cmds.length) { addMsg('note', '（没有可执行的操作）'); return finish(); }
        confirmPlan(check.summaries).then(function (ok) {   // 总是先列计划再确认
          if (!ok) { addMsg('note', '已取消执行批注。'); return finish(); }
          var edits = cmds.filter(function (c) { return OPS[c.op] && OPS[c.op].kind !== 'action'; });
          var actions = cmds.filter(function (c) { return OPS[c.op] && OPS[c.op].kind === 'action'; });
          var results = [];
          App.pushHistory();   // 整批（编辑 + 标 done）= 一个撤销步
          edits.forEach(function (c) { try { results.push(OPS[c.op].run(c, { noHistory: true })); } catch (e) { results.push('✗ ' + c.op + '：' + (e && e.message || e)); } });
          actions.forEach(function (c) { try { results.push(OPS[c.op].run(c, {})); } catch (e) { results.push('✗ ' + (e && e.message || e)); } });
          doneIds.forEach(function (idc) { App.setCommentStatus(idc, 'done', { noHistory: true }); });
          addMsg('note', results.join('\n') + '\n（' + doneIds.length + ' 条批注已标记 ✓已执行）');
          finish();
        });
      }).catch(function (e) { removeMsg(thinking); addMsg('assistant', '⚠ ' + (e && e.message || e)); finish(); });
    }
    function retryOrFail(err) {
      lastErr = err; attempt++;
      if (attempt <= MAX_REPAIR) step();
      else { removeMsg(thinking); addMsg('assistant', '抱歉，没能把这些批注转成可执行操作。\n（' + err + '）'); persistChat(); finish(); }
    }
    function finish() { pending = false; setBusy(false); updateCommentBar(); }
    step();
  }

  function updateCommentBar() {
    var lbl = document.getElementById('aiCommentCount'), btn = document.getElementById('btnRunComments');
    var n = (App.getComments ? App.getComments() : []).filter(function (c) { return c.status === 'pending'; }).length;
    if (lbl) lbl.textContent = '待执行批注 ' + n + ' 条';
    if (btn) btn.disabled = (n === 0 || pending);
  }

  /* ===================== UI ===================== */
  var msgs = [];   // {role:'user'|'assistant'|'note'|'think', text}
  var elPanel, elMsgs, elInput, elSend, elResizer, btnAi;

  function loadChat() { try { msgs = JSON.parse(localStorage.getItem(STORAGE.CHAT) || '[]') || []; } catch (e) { msgs = []; } if (!Array.isArray(msgs)) msgs = []; }
  function persistChat() { try { localStorage.setItem(STORAGE.CHAT, JSON.stringify(msgs.filter(function (m) { return m.role === 'user' || m.role === 'assistant' || m.role === 'note'; }).slice(-60))); } catch (e) {} }

  function addMsg(role, text) { var m = { role: role, text: text }; msgs.push(m); render(); return m; }
  function removeMsg(m) { var i = msgs.indexOf(m); if (i >= 0) { msgs.splice(i, 1); render(); } }

  function render() {
    if (!elMsgs) return;
    if (!msgs.length) { elMsgs.innerHTML = '<div class="ai-hello">✦ 你好，我是剪辑助手。<br>试试：「把素材库所有素材按顺序放进时间轴」「把名为XX的视频放进来减速一半」「截取XX中间三分之一」「在XX期间左上角加字幕：你好」「导出」。</div>'; return; }
    elMsgs.innerHTML = msgs.map(function (m, i) {
      if (m.role === 'think') return '<div class="ai-msg think"><span class="ai-dots">' + esc(m.text) + '</span></div>';
      var cls = m.role === 'user' ? 'user' : (m.role === 'note' ? 'note' : 'assistant');
      return '<div class="ai-msg ' + cls + '" data-idx="' + i + '">' +
        '<button class="ai-copy" data-idx="' + i + '" type="button" title="复制这条">⎘</button>' +
        '<span class="ai-msg-body">' + esc(m.text).replace(/\n/g, '<br>') + '</span></div>';
    }).join('');
    elMsgs.scrollTop = elMsgs.scrollHeight;
  }

  // 复制文本（http://127.0.0.1 是安全上下文，clipboard API 可用；带 execCommand 兜底）
  function copyText(t) {
    var ok = function () { App.toast && App.toast('已复制', 'ok'); };
    var bad = function () { App.toast && App.toast('复制失败，请手动选中', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(ok, function () { legacyCopy(t) ? ok() : bad(); });
    } else { legacyCopy(t) ? ok() : bad(); }
  }
  function legacyCopy(t) {
    try {
      var ta = document.createElement('textarea'); ta.value = t;
      ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta);
      ta.select(); var r = document.execCommand('copy'); document.body.removeChild(ta); return r;
    } catch (e) { return false; }
  }

  function setBusy(b) { if (elSend) { elSend.disabled = b; elSend.textContent = b ? '…' : '发送'; } if (elInput) elInput.disabled = b; }

  function confirmPlan(summaries) {
    return new Promise(function (resolve) {
      var box = document.createElement('div'); box.className = 'ai-msg confirm';
      box.innerHTML = '<div class="ai-cfm-title">将执行以下操作，确认？</div><ul class="ai-cfm-list">' + summaries.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul><div class="ai-cfm-btns"><button class="primary ai-cfm-yes">执行</button><button class="ai-cfm-no">取消</button></div>';
      elMsgs.appendChild(box); elMsgs.scrollTop = elMsgs.scrollHeight;
      box.querySelector('.ai-cfm-yes').addEventListener('click', function () { box.remove(); resolve(true); });
      box.querySelector('.ai-cfm-no').addEventListener('click', function () { box.remove(); resolve(false); });
    });
  }

  /* ---- 面板开合 / 拖宽 ---- */
  function setOpen(open) {
    elPanel.hidden = !open; elResizer.hidden = !open;
    if (btnAi) btnAi.classList.toggle('active', open);
    try { localStorage.setItem(STORAGE.OPEN, open ? '1' : '0'); } catch (e) {}
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 30);
    if (open && elInput) elInput.focus();
    if (open && cfgCache && !cfgCache.hasKey) openConfig();
  }
  function applyWidth(w) { w = clamp(w, MIN_W, Math.min(MAX_W, Math.round(window.innerWidth * 0.7))); elPanel.style.flex = '0 0 ' + w + 'px'; elPanel.style.width = w + 'px'; try { localStorage.setItem(STORAGE.WIDTH, String(w)); } catch (e) {} }
  function initResizer() {
    var dragging = false, startX = 0, startW = 0;
    elResizer.addEventListener('mousedown', function (e) { dragging = true; startX = e.clientX; startW = elPanel.getBoundingClientRect().width; document.body.style.cursor = 'col-resize'; e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (!dragging) return; applyWidth(startW + (startX - e.clientX)); });
    window.addEventListener('mouseup', function () { if (dragging) { dragging = false; document.body.style.cursor = ''; window.dispatchEvent(new Event('resize')); } });
  }

  /* ---- 设置弹窗 ---- */
  var dlg;
  function openConfig() {
    if (!dlg) return;
    getAI('/api/ai/config').then(function (c) {
      cfgCache = c;
      dlg.querySelector('#aiCfgProto').value = c.protocol || 'openai';
      dlg.querySelector('#aiCfgBase').value = c.baseURL || '';
      dlg.querySelector('#aiCfgModel').value = c.model || '';
      var keyEl = dlg.querySelector('#aiCfgKey'); keyEl.value = ''; keyEl.placeholder = c.hasKey ? ('已配置（末4位 ' + (c.keyTail || '') + '），留空＝不变') : '填入 API Key';
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
  }
  function saveConfig() {
    var body = {
      protocol: dlg.querySelector('#aiCfgProto').value,
      baseURL: dlg.querySelector('#aiCfgBase').value.trim(),
      model: dlg.querySelector('#aiCfgModel').value.trim(),
      apiKey: dlg.querySelector('#aiCfgKey').value.trim()
    };
    postAI('/api/ai/config', body).then(function (c) { cfgCache = c; closeConfig(); App.toast && App.toast('AI 设置已保存', 'ok'); }).catch(function (e) { App.toast && App.toast('保存失败：' + e.message, 'error'); });
  }
  function closeConfig() { if (dlg && dlg.open) dlg.close(); }

  /* ---- 初始化 ---- */
  function init() {
    elPanel = document.getElementById('aiPanel');
    elMsgs = document.getElementById('aiMessages');
    elInput = document.getElementById('aiInput');
    elSend = document.getElementById('aiSend');
    elResizer = document.getElementById('aiResizer');
    btnAi = document.getElementById('btnAi');
    dlg = document.getElementById('aiConfigDialog');
    if (!elPanel || !elMsgs) { console.error('[ai] 缺少面板 DOM'); return; }

    loadChat(); render();

    var w = parseInt(localStorage.getItem(STORAGE.WIDTH) || DEFAULT_W, 10); applyWidth(isFinite(w) ? w : DEFAULT_W);
    initResizer();

    if (btnAi) btnAi.addEventListener('click', function () { setOpen(elPanel.hidden); });
    var bc = document.getElementById('btnAiClose'); if (bc) bc.addEventListener('click', function () { setOpen(false); });
    var bcfg = document.getElementById('btnAiConfig'); if (bcfg) bcfg.addEventListener('click', openConfig);
    var bclr = document.getElementById('btnAiClear'); if (bclr) bclr.addEventListener('click', function () { msgs = []; persistChat(); render(); });

    // 点每条消息的 ⎘ 复制（事件委托，render 重建子节点也不失效）
    elMsgs.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('.ai-copy'); if (!btn) return;
      var m = msgs[+btn.getAttribute('data-idx')]; if (m) copyText(m.text);
    });

    function send() { var v = (elInput.value || '').trim(); if (!v || pending) return; elInput.value = ''; askAI(v); }
    if (elSend) elSend.addEventListener('click', send);
    if (elInput) elInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    if (dlg) {
      var sv = dlg.querySelector('#aiCfgSave'); if (sv) sv.addEventListener('click', saveConfig);
      var cc = dlg.querySelector('#aiCfgCancel'); if (cc) cc.addEventListener('click', closeConfig);
    }

    // 「▶ 执行批注」按钮 + 待执行计数（随评论变化更新）
    var brun = document.getElementById('btnRunComments'); if (brun) brun.addEventListener('click', executeComments);
    if (App.bus) App.bus.on('comments:changed', updateCommentBar);
    updateCommentBar();

    getAI('/api/ai/config').then(function (c) { cfgCache = c; }).catch(function () {});
    if (localStorage.getItem(STORAGE.OPEN) === '1') setOpen(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // 暴露少量调试入口
  window.QJAi = { open: function () { setOpen(true); }, OPS: OPS, runComments: executeComments, run: function (cmds) { var ck = validateAll(cmds); if (ck.ok) executePlan(cmds, ck); return ck; } };
})();
