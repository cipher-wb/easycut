/* =========================================================================
 * export.js — 导出流程（v2 多轨合成式 NLE）
 *
 * 职责（contract_v2.md §3 表 / §3.3）：
 *   收集 App.getProject() → /api/pick-save 取 outputPath → POST /api/export 拿 jobId
 *   → 轮询 /api/export/status 更新 #progressBar / #progressText / #exportLog；
 *   done 弹成功（“打开所在文件夹”），error 弹日志。
 *   不构建 ffmpeg 参数（后端做）。
 *
 * 权威依据：
 *   - DOM id：contract_v2 §4.6（#exportDialog / #exportSummary / #progressBar /
 *     #progressText / #exportLog / #btnExportStart / #btnOpenFolder / #btnExportCancel）
 *     + §4.1 工具栏 #btnExport 打开弹窗。
 *   - App API：§3.2  App.getProject() / App.getTimeline() / App.api.pickSave(suggestName)
 *     / App.api.export(project, outputPath) / App.api.exportStatus(jobId) /
 *     App.toast / App.fmtTime / App.clamp / App.bus。
 *   - 状态结构：§2.10  { state:"running"|"done"|"error", progress:0..1,
 *     outputPath, error, log:[...] }。
 *   - 快捷键：§7 / timeline_v2 §11  Ctrl+S → export.open()（暴露 window.export.open）。
 *   - 校验：导出前时间轴非空（§6 B1）；后端二次校验（§2.9）。
 *
 * 复用 v1 export.js 已实测可靠逻辑：弹窗时序（showModal/close 兜底）、
 *   轮询连续失败熔断（pollFailCount）、单次轮询失败容忍、suggestName 推导、
 *   “打开所在文件夹”降级为复制路径到剪贴板。
 *
 * 纯原生 JS，无框架/CDN。UTF-8 无 BOM。
 * ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  var bus = App && App.bus;

  /* DOM 引用（DOMContentLoaded 后填充） */
  var dlg = null, summaryEl = null, barEl = null, textEl = null, logEl = null;
  var btnStart = null, btnCancel = null, btnOpenFolder = null, btnExportTop = null;

  /* 轮询状态机 */
  var pollTimer = null;
  var POLL_INTERVAL_MS = 400;            // §2.10 建议 300–500ms
  var POLL_FAIL_MAX = 8;                 // 连续失败熔断阈值（沿用 v1 改进）
  var pollFailCount = 0;

  var curJobId = null;
  var curOutputPath = null;
  var exporting = false;                 // 正在导出（轮询中）：禁止重复开始 / 关闭即停轮询

  /* ----------------------------------------------------------------------
   * 初始化与接线
   * -------------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    dlg           = byId('exportDialog');
    summaryEl     = byId('exportSummary');
    barEl         = byId('progressBar');
    textEl        = byId('progressText');
    logEl         = byId('exportLog');
    btnStart      = byId('btnExportStart');
    btnCancel     = byId('btnExportCancel');
    btnOpenFolder = byId('btnOpenFolder');
    btnExportTop  = byId('btnExport');

    if (btnExportTop) btnExportTop.addEventListener('click', openDialog);
    if (btnStart)     btnStart.addEventListener('click', startExport);
    if (btnCancel)    btnCancel.addEventListener('click', closeDialog);
    if (btnOpenFolder) btnOpenFolder.addEventListener('click', onOpenFolder);

    // 快捷键 Ctrl+S（shortcuts.js）/ 其它模块 经事件总线打开导出弹窗。
    if (bus && bus.on) bus.on('export:open', openDialog);

    // <dialog> 取消（Esc）时停止轮询，避免后台继续。
    if (dlg) {
      dlg.addEventListener('cancel', function () { stopPolling(); });
      dlg.addEventListener('close', function () { stopPolling(); });
    }

    // 启动时根据时间轴是否为空，启停顶部导出按钮（B1）。
    refreshExportButton();
    if (bus && bus.on) {
      bus.on('project:changed', refreshExportButton);
      bus.on('clips:changed', refreshExportButton);
      bus.on('tracks:changed', refreshExportButton);
    }
  });

  /* 对外暴露：contract §7 / timeline_v2 §11 的 Ctrl+S → export.open() */
  window.export = window.export || {};
  window.export.open = openDialog;
  // 兼容：部分模块可能用 App.openExport()
  if (App) App.openExport = openDialog;

  /* ----------------------------------------------------------------------
   * 打开 / 关闭弹窗
   * -------------------------------------------------------------------- */
  function openDialog() {
    if (!dlg) return;
    if (totalDuration() <= 0) {
      App.toast('时间轴为空，无法导出', 'error');
      return;
    }
    resetDialogUI();
    renderSummary();
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
  }

  function closeDialog() {
    stopPolling();
    if (!dlg) return;
    if (typeof dlg.close === 'function') {
      if (dlg.open) dlg.close();
    } else {
      dlg.removeAttribute('open');
    }
  }

  function resetDialogUI() {
    if (barEl)  { barEl.value = 0; }
    if (textEl) { textEl.textContent = '准备就绪'; }
    if (logEl)  { logEl.hidden = true; logEl.textContent = ''; }
    if (btnStart)      { btnStart.disabled = false; btnStart.hidden = false; btnStart.textContent = '开始导出'; }
    if (btnOpenFolder) { btnOpenFolder.hidden = true; }
    if (btnCancel)     { btnCancel.textContent = '取消'; }
    curJobId = null;
    curOutputPath = null;
    exporting = false;
  }

  /* 概要：分辨率 / 时长 / 轨道数 / 片段统计 / 输出参数（§3.3 表 export.js 行） */
  function renderSummary() {
    if (!summaryEl) return;
    var proj = getProject();
    var o = (proj && proj.output) || {};
    var stat = countSegments(proj);
    var total = totalDuration();

    var vTracks = 0, tTracks = 0;
    if (proj && proj.tracks) {
      for (var i = 0; i < proj.tracks.length; i++) {
        if (proj.tracks[i].kind === 'text') tTracks++; else vTracks++;
      }
    }

    summaryEl.innerHTML =
      '视频片段：' + stat.clips + ' &nbsp;|&nbsp; 文字条数：' + stat.texts +
      ' &nbsp;|&nbsp; 轨道：视频 ' + vTracks + ' / 文字 ' + tTracks + '<br>' +
      '总时长：' + App.fmtTime(total) + '<br>' +
      '输出：' + (o.width || '?') + '×' + (o.height || '?') + ' @' + (o.fps || '?') + 'fps' +
      ' &nbsp; CRF ' + (o.crf != null ? o.crf : '?') +
      ' &nbsp; ' + (o.keepAudio ? '含音轨' : '无音轨');
  }

  /* ----------------------------------------------------------------------
   * 开始导出：pickSave → export → 轮询
   * -------------------------------------------------------------------- */
  function startExport() {
    if (exporting) return;

    // 1) 导出前校验：时间轴非空（B1）。
    if (totalDuration() <= 0) {
      App.toast('时间轴为空，无法导出', 'error');
      if (textEl) textEl.textContent = '时间轴为空';
      return;
    }

    var proj = getProject();
    if (!proj || !hasAnyClip(proj)) {
      App.toast('时间轴为空，无法导出', 'error');
      if (textEl) textEl.textContent = '时间轴为空';
      return;
    }

    if (btnStart) btnStart.disabled = true;
    if (textEl)   textEl.textContent = '选择保存位置…';

    var suggest = suggestName(proj);

    App.api.pickSave(suggest).then(function (res) {
      // 用户取消保存对话框。
      if (!res || !res.path) {
        if (textEl)   textEl.textContent = '已取消';
        if (btnStart) btnStart.disabled = false;
        return null;
      }
      curOutputPath = res.path;
      if (textEl) textEl.textContent = '正在启动导出…';

      // 2) 启动导出（后端二次校验 + 异步渲染），拿 jobId。
      return App.api.export(proj, res.path).then(function (r) {
        curJobId = r && r.jobId;
        if (!curJobId) throw new Error('后端未返回 jobId');
        exporting = true;
        if (textEl) textEl.textContent = '导出中 0%';
        if (barEl)  barEl.value = 0;
        if (logEl)  { logEl.hidden = false; logEl.textContent = ''; }
        if (btnCancel) btnCancel.textContent = '取消';
        startPolling();
      });
    }).catch(function (e) {
      // 同步校验失败（§2.9 400）或网络错误。App.api.* 内部已弹 toast，这里补充弹窗状态。
      exporting = false;
      if (textEl)   textEl.textContent = '失败';
      if (btnStart) { btnStart.disabled = false; btnStart.hidden = false; }
      App.toast('导出启动失败：' + (e && e.message ? e.message : e), 'error', 5000);
    });
  }

  /* ----------------------------------------------------------------------
   * 轮询状态（300–500ms；连续失败熔断）
   * -------------------------------------------------------------------- */
  function startPolling() {
    stopPolling();
    pollFailCount = 0;
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    poll(); // 立即拉一次，缩短首帧延迟
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function poll() {
    if (!curJobId) return;
    App.api.exportStatus(curJobId).then(function (st) {
      if (!st) return;
      pollFailCount = 0; // 成功一次即清零熔断计数

      var p = App.clamp(typeof st.progress === 'number' ? st.progress : 0, 0, 1);
      if (barEl) barEl.value = p;

      if (st.log && st.log.length && logEl) {
        logEl.textContent = st.log.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (st.outputPath) curOutputPath = st.outputPath;

      if (st.state === 'running') {
        if (textEl) textEl.textContent = '导出中 ' + Math.round(p * 100) + '%';
      } else if (st.state === 'done') {
        onDone();
      } else if (st.state === 'error') {
        onError(st);
      } else {
        // 未知 state：保守当作仍在进行，等下一次轮询。
        if (textEl) textEl.textContent = '导出中 ' + Math.round(p * 100) + '%';
      }
    }).catch(function (e) {
      // 单次轮询失败容忍；连续多次（服务已停 / 任务丢失）则熔断，避免无限轮询。
      console.warn('导出状态轮询失败', e);
      pollFailCount++;
      if (pollFailCount >= POLL_FAIL_MAX) {
        stopPolling();
        exporting = false;
        if (textEl)   textEl.textContent = '无法获取导出状态';
        if (btnStart) { btnStart.hidden = false; btnStart.disabled = false; }
        App.toast('无法获取导出状态，请确认后台服务仍在运行（命令行窗口未关闭）。', 'error', 6000);
      }
    });
  }

  function onDone() {
    stopPolling();
    exporting = false;
    if (barEl)  barEl.value = 1;
    if (textEl) textEl.textContent = '完成 100%';
    if (btnStart)      btnStart.hidden = true;
    if (btnOpenFolder) btnOpenFolder.hidden = false;
    if (btnCancel)     btnCancel.textContent = '关闭';
    App.toast('导出完成：' + (curOutputPath || ''), 'ok', 5000);
  }

  function onError(st) {
    stopPolling();
    exporting = false;
    if (textEl) textEl.textContent = '导出失败';
    if (btnStart) { btnStart.hidden = false; btnStart.disabled = false; }
    if (logEl) {
      logEl.hidden = false;
      var msg = '';
      if (st && st.error) msg += '错误：' + st.error + '\n\n';
      if (st && st.log && st.log.length) msg += st.log.join('\n');
      if (msg) logEl.textContent = msg;
    }
    App.toast('导出失败：' + ((st && st.error) || '未知错误'), 'error', 6000);
  }

  /* ----------------------------------------------------------------------
   * “打开所在文件夹”：调后端在资源管理器里打开并选中文件（本机服务，各模式可用）；
   * 失败再降级为复制路径到剪贴板。
   * -------------------------------------------------------------------- */
  function onOpenFolder() {
    if (!curOutputPath) return;
    var p = curOutputPath;
    if (App.api && App.api.reveal) {
      App.api.reveal(p).then(function (r) {
        if (r && r.ok) return;
        copyText(p); App.toast('无法打开文件夹（' + ((r && r.error) || '未知') + '），已复制路径：' + p, 'ok', 3500);
      }).catch(function () {
        copyText(p); App.toast('已复制输出路径到剪贴板：' + p, 'ok', 3500);
      });
      return;
    }
    copyText(p);
    App.toast('已复制输出路径到剪贴板：' + p, 'ok', 3500);
  }

  /* ----------------------------------------------------------------------
   * 工具
   * -------------------------------------------------------------------- */
  function byId(id) { return document.getElementById(id); }

  function getProject() {
    // 权威入口（§3.2）。兼容：若实现额外提供导出前规范化 buildExportProject 则优先用之。
    if (App && typeof App.buildExportProject === 'function') {
      try { return App.buildExportProject(); } catch (e) { /* 回退 */ }
    }
    if (App && typeof App.getProject === 'function') return App.getProject();
    return App ? App.project : null;
  }

  // 总时长：优先 App.getTimeline().totalDuration（§3.2 派生量 §1.6），回退自算。
  function totalDuration() {
    try {
      if (App && typeof App.getTimeline === 'function') {
        var tl = App.getTimeline();
        if (tl && typeof tl.totalDuration === 'number') return tl.totalDuration;
      }
    } catch (e) { /* 回退 */ }
    return computeTotal(getProject());
  }

  function computeTotal(proj) {
    if (!proj || !proj.tracks) return 0;
    var total = 0;
    for (var i = 0; i < proj.tracks.length; i++) {
      var t = proj.tracks[i];
      var clips = t.clips || [];
      for (var j = 0; j < clips.length; j++) {
        var c = clips[j];
        var dur = (t.kind === 'text')
          ? (c.duration || 0)
          : (((c.out || 0) - (c.in || 0)) / (c.speed || 1));
        var end = (c.start || 0) + dur;
        if (dur > 0 && end > total) total = end;
      }
    }
    return total;
  }

  function hasAnyClip(proj) {
    if (!proj || !proj.tracks) return false;
    for (var i = 0; i < proj.tracks.length; i++) {
      var clips = proj.tracks[i].clips;
      if (clips && clips.length) {
        for (var j = 0; j < clips.length; j++) {
          var c = clips[j], t = proj.tracks[i];
          var dur = (t.kind === 'text') ? (c.duration || 0) : ((c.out || 0) - (c.in || 0));
          if (dur > 0) return true;
        }
      }
    }
    return false;
  }

  function countSegments(proj) {
    var clips = 0, texts = 0;
    if (proj && proj.tracks) {
      for (var i = 0; i < proj.tracks.length; i++) {
        var t = proj.tracks[i];
        var arr = t.clips || [];
        for (var j = 0; j < arr.length; j++) {
          var c = arr[j];
          if (t.kind === 'text') {
            if ((c.duration || 0) > 0) texts++;
          } else {
            if (((c.out || 0) - (c.in || 0)) > 0) clips++;
          }
        }
      }
    }
    return { clips: clips, texts: texts };
  }

  /* 建议输出名：取第一个被引用片段所属 media 名，否则第一个素材名，否则默认。 */
  function suggestName(proj) {
    var base = '我的视频';
    var name = firstReferencedMediaName(proj) || firstMediaName(proj);
    if (name) {
      var s = ('' + name).replace(/\\/g, '/');
      var i = s.lastIndexOf('/');
      var bn = i >= 0 ? s.substring(i + 1) : s;
      bn = bn.replace(/\.[^.]+$/, ''); // 去扩展名
      if (bn) base = bn;
    }
    return base + '_剪辑.mp4';
  }

  function firstReferencedMediaName(proj) {
    if (!proj || !proj.tracks) return null;
    // 找时间轴上最早出现的视频片段所引用的 media。
    var best = null;
    for (var i = 0; i < proj.tracks.length; i++) {
      var t = proj.tracks[i];
      if (t.kind === 'text') continue;
      var clips = t.clips || [];
      for (var j = 0; j < clips.length; j++) {
        var c = clips[j];
        if (((c.out || 0) - (c.in || 0)) <= 0) continue;
        if (best == null || (c.start || 0) < best.start) {
          best = { start: (c.start || 0), mediaId: c.mediaId };
        }
      }
    }
    if (!best) return null;
    var m = findMedia(proj, best.mediaId);
    return m ? (m.name || m.path) : null;
  }

  function firstMediaName(proj) {
    if (proj && proj.media && proj.media.length) {
      var m = proj.media[0];
      return m.name || m.path || null;
    }
    return null;
  }

  function findMedia(proj, mediaId) {
    if (!proj || !proj.media) return null;
    for (var i = 0; i < proj.media.length; i++) {
      if (proj.media[i].id === mediaId) return proj.media[i];
    }
    return null;
  }

  function refreshExportButton() {
    if (!btnExportTop) return;
    btnExportTop.disabled = totalDuration() <= 0;
  }

  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t);
        return;
      }
    } catch (e) { /* 回退到 execCommand */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* 静默 */ }
  }

})();
