/* =========================================================================
 * export.js — 导出流程
 * 收集 project -> /api/pick-save 选输出路径 -> POST /api/export -> 轮询状态。
 * DOM id 按 contract.md §4.5。
 * ========================================================================= */
(function () {
  'use strict';
  var App = window.App;
  var bus = App.bus;

  var dlg, summaryEl, barEl, textEl, logEl, btnStart, btnCancel, btnOpenFolder;
  var pollTimer = null;
  var pollFailCount = 0;
  var curJobId = null;
  var curOutputPath = null;

  document.addEventListener('DOMContentLoaded', function () {
    dlg = document.getElementById('exportDialog');
    summaryEl = document.getElementById('exportSummary');
    barEl = document.getElementById('progressBar');
    textEl = document.getElementById('progressText');
    logEl = document.getElementById('exportLog');
    btnStart = document.getElementById('btnExportStart');
    btnCancel = document.getElementById('btnExportCancel');
    btnOpenFolder = document.getElementById('btnOpenFolder');

    bus.on('export:open', openDialog);

    btnStart.addEventListener('click', startExport);
    btnCancel.addEventListener('click', closeDialog);
    btnOpenFolder.addEventListener('click', function () {
      // v1：仅提示路径（后端未提供打开文件夹接口）。复制到剪贴板方便用户粘贴。
      if (!curOutputPath) return;
      copyText(curOutputPath);
      App.toast('已复制输出路径到剪贴板：' + curOutputPath, 'ok', 3500);
    });
  });

  function openDialog() {
    var tl = App.getTimeline();
    if (tl.totalDuration <= 0) { App.toast('时间轴为空，无法导出', 'error'); return; }
    resetDialogUI();
    renderSummary();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeDialog() {
    stopPolling();
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function resetDialogUI() {
    barEl.value = 0;
    textEl.textContent = '准备就绪';
    logEl.hidden = true;
    logEl.textContent = '';
    btnStart.disabled = false;
    btnStart.hidden = false;
    btnOpenFolder.hidden = true;
    btnCancel.textContent = '取消';
    curJobId = null;
    curOutputPath = null;
  }

  function renderSummary() {
    var o = App.project.output;
    var tl = App.getTimeline();
    var nClips = tl.segments.length;
    var nTexts = App.project.texts.filter(function (t) { return t.end > t.start; }).length;
    summaryEl.innerHTML =
      '片段数：' + nClips + ' &nbsp;|&nbsp; 文字条数：' + nTexts + '<br>' +
      '总时长：' + App.fmtTime(tl.totalDuration) + '<br>' +
      '输出：' + o.width + '×' + o.height + ' @' + o.fps + 'fps &nbsp; CRF ' + o.crf +
      ' &nbsp; ' + (o.keepAudio ? '含音轨' : '无音轨');
  }

  function startExport() {
    var proj = App.buildExportProject();
    if (!proj.clips.length) { App.toast('时间轴为空，无法导出', 'error'); return; }

    btnStart.disabled = true;
    textEl.textContent = '选择保存位置…';

    var firstSrc = proj.sources.find(function (s) { return s.id === proj.clips[0].sourceId; });
    var suggest = suggestName(firstSrc ? firstSrc.path : null);

    App.api.pickSave(suggest).then(function (res) {
      if (!res || !res.path) {
        textEl.textContent = '已取消';
        btnStart.disabled = false;
        return;
      }
      curOutputPath = res.path;
      textEl.textContent = '正在启动导出…';
      return App.api.exportProject(proj, res.path).then(function (r) {
        curJobId = r && r.jobId;
        if (!curJobId) throw new Error('后端未返回 jobId');
        textEl.textContent = '导出中 0%';
        barEl.value = 0;
        logEl.hidden = false;
        startPolling();
      });
    }).catch(function (e) {
      textEl.textContent = '失败';
      btnStart.disabled = false;
      App.toast('导出启动失败：' + e.message, 'error', 5000);
    });
  }

  /* ---------- 轮询状态 ---------- */
  function startPolling() {
    stopPolling();
    pollFailCount = 0;
    pollTimer = setInterval(poll, 400);
    poll();
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function poll() {
    if (!curJobId) return;
    App.api.exportStatus(curJobId).then(function (st) {
      if (!st) return;
      pollFailCount = 0;
      var p = App.clamp(st.progress || 0, 0, 1);
      barEl.value = p;
      if (st.log && st.log.length) {
        logEl.textContent = st.log.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (st.outputPath) curOutputPath = st.outputPath;

      if (st.state === 'running') {
        textEl.textContent = '导出中 ' + Math.round(p * 100) + '%';
      } else if (st.state === 'done') {
        stopPolling();
        barEl.value = 1;
        textEl.textContent = '完成 100%';
        btnStart.hidden = true;
        btnOpenFolder.hidden = false;
        btnCancel.textContent = '关闭';
        App.toast('导出完成：' + (curOutputPath || ''), 'ok', 5000);
      } else if (st.state === 'error') {
        stopPolling();
        textEl.textContent = '导出失败';
        btnStart.hidden = false;
        btnStart.disabled = false;
        logEl.hidden = false;
        if (st.error) {
          logEl.textContent = '错误：' + st.error + '\n\n' + (st.log ? st.log.join('\n') : '');
        }
        App.toast('导出失败：' + (st.error || '未知错误'), 'error', 6000);
      }
    }).catch(function (e) {
      // 单次轮询失败容忍；连续多次（如服务已停止或任务丢失）则停止并提示，避免无限轮询。
      console.warn('轮询失败', e);
      pollFailCount++;
      if (pollFailCount >= 8) {
        stopPolling();
        textEl.textContent = '无法获取导出状态';
        btnStart.hidden = false;
        btnStart.disabled = false;
        App.toast('无法获取导出状态，请确认后台服务仍在运行（命令行窗口未关闭）。', 'error', 6000);
      }
    });
  }

  /* ---------- 工具 ---------- */
  function suggestName(srcPath) {
    var base = '我的视频';
    if (srcPath) {
      var s = ('' + srcPath).replace(/\\/g, '/');
      var i = s.lastIndexOf('/');
      var name = i >= 0 ? s.substring(i + 1) : s;
      name = name.replace(/\.[^.]+$/, '');
      if (name) base = name;
    }
    return base + '_剪辑.mp4';
  }

  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; }
    } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }

})();
