/* =========================================================================
 * projects.js — 工程（项目）系统 UI（轻剪 EasyCut v3）
 *
 * 权威依据：_build/project_design.md §3（App API）/ §5.3（本文件职责）/
 *           §5.4（DOM id）/ §6（dirty / beforeunload / 启动流程）。
 *
 * 职责：工程选择面板 + 顶部「工程」入口与当前工程名/未保存指示 +
 *       保存 / 另存为命名对话框 + 离线横幅 + beforeunload + 启动弹窗。
 *
 * 与 app.js 协作（只调用契约方法，不重复其逻辑）：
 *   App.api.projects.{list,save,load,del,rename} / App.api.relink
 *   App.serializeProject() / App.loadProjectData(loaded) / App.newProject()
 *   App.getProjectMeta() / App.setProjectMeta({id,name})
 *   App.isDirty() / App.markSaved() / App.relinkMedia(mediaId)
 *   App.hasOfflineMedia() / App.offlineCount() / App.getMedia / App.getProject
 * 监听 bus：project:save / project:saveAs（shortcuts.js emit）、
 *           projectmeta:changed / dirty:changed / media:changed / project:loaded。
 * ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  if (!App) { return; }
  var bus = App.bus;

  /* ---------- 安全工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function toast(msg, kind, ms) {
    if (typeof App.toast === 'function') App.toast(msg, kind, ms);
    else console.log('[toast]', msg);
  }
  function esc(s) {
    return ('' + (s == null ? '' : s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDateTime(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '—';
    var d = new Date(n);
    function p2(x) { return x < 10 ? '0' + x : '' + x; }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
           ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  // dialog 兼容打开/关闭（与 shortcuts.js / export.js 同风格）
  function openDlg(dlg) {
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }
  function closeDlg(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === 'function') { if (dlg.open) dlg.close(); }
    else dlg.removeAttribute('open');
  }

  /* ---------- App 契约方法的安全代理（容错 app.js 尚未就绪的极端情况）---------- */
  function meta() {
    if (typeof App.getProjectMeta === 'function') return App.getProjectMeta() || { id: null, name: null };
    return { id: null, name: null };
  }
  function isDirty() { return typeof App.isDirty === 'function' ? !!App.isDirty() : false; }
  function offlineCount() {
    if (typeof App.offlineCount === 'function') return App.offlineCount() || 0;
    return 0;
  }
  function serialize() {
    if (typeof App.serializeProject === 'function') return App.serializeProject();
    // 极端回退：直接深拷贝当前 project（理论上不会走到）
    var p = (typeof App.getProject === 'function') ? App.getProject() : App.project;
    return p ? JSON.parse(JSON.stringify({ output: p.output, media: p.media, tracks: p.tracks })) : null;
  }

  /* =======================================================================
   * A. 当前工程名 + 未保存 ● 指示（#lblProjectName）
   * ===================================================================== */
  function updateProjectNameLabel() {
    var el = $('lblProjectName');
    if (!el) return;
    var m = meta();
    var name = (m && m.name) ? m.name : '未命名工程';
    var unsaved = isDirty();
    el.innerHTML = (unsaved ? '<span class="unsaved-dot" title="有未保存改动">●</span>' : '') +
                   '<span class="pn-text">' + esc(name) + '</span>';
    el.title = name + (unsaved ? '（有未保存改动）' : '');
    el.classList.toggle('is-unnamed', !(m && m.name));
  }

  /* =======================================================================
   * B. 离线横幅（#offlineBanner）
   * ===================================================================== */
  var _bannerDismissed = false; // 用户手动关闭后本次会话不再自动弹（load/relink 会重置）
  function refreshOfflineBanner() {
    var banner = $('offlineBanner');
    if (!banner) return;
    var n = offlineCount();
    var txt = $('offlineBannerText');
    if (n > 0 && !_bannerDismissed) {
      if (txt) txt.textContent = n + ' 个素材离线，相关片段在时间轴中以占位显示，可点「重新链接」恢复。';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function relinkAll() {
    if (typeof App.relinkMedia !== 'function' || typeof App.getProject !== 'function') return;
    var p = App.getProject();
    if (!p || !p.media) return;
    var offline = p.media.filter(function (m) { return m && m.offline; });
    if (!offline.length) { refreshOfflineBanner(); return; }
    // 依次（串行）重新链接，每次都会弹系统选文件框
    var i = 0;
    (function next() {
      if (i >= offline.length) { refreshOfflineBanner(); return; }
      var m = offline[i++];
      var pr = App.relinkMedia(m.id);
      if (pr && typeof pr.then === 'function') pr.then(next, next);
      else next();
    })();
  }

  /* =======================================================================
   * C. 工程选择面板（#projectDialog）
   * ===================================================================== */
  function openProjectPanel() {
    var dlg = $('projectDialog');
    if (!dlg) return;
    openDlg(dlg);
    loadProjectList();
  }
  function closeProjectPanel() { closeDlg($('projectDialog')); }

  function loadProjectList() {
    var listEl = $('projectList');
    var emptyEl = $('projectEmptyHint');
    if (!listEl) return;
    listEl.setAttribute('aria-busy', 'true');
    App.api.projects.list().then(function (res) {
      var projects = (res && res.projects) || [];
      renderProjectList(projects);
      if (emptyEl) emptyEl.hidden = projects.length > 0;
    }).catch(function (err) {
      renderProjectList([]);
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = '读取工程列表失败：' + (err && err.message || err); }
    }).then(function () { listEl.removeAttribute('aria-busy'); });
  }

  function renderProjectList(projects) {
    var listEl = $('projectList');
    if (!listEl) return;
    listEl.innerHTML = '';
    projects.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'project-item';
      row.setAttribute('data-project-id', p.id);
      row.innerHTML =
        '<div class="pi-main">' +
          '<div class="pi-name">' + esc(p.name || '未命名工程') + '</div>' +
          '<div class="pi-time">修改于 ' + esc(fmtDateTime(p.modifiedAt)) + '</div>' +
        '</div>' +
        '<div class="pi-actions">' +
          '<button type="button" class="pi-open primary mini">打开</button>' +
          '<button type="button" class="pi-rename mini">重命名</button>' +
          '<button type="button" class="pi-delete mini danger">删除</button>' +
        '</div>';
      // 打开：双击行或点「打开」
      row.querySelector('.pi-open').addEventListener('click', function (e) { e.stopPropagation(); doOpenProject(p.id); });
      row.querySelector('.pi-main').addEventListener('dblclick', function () { doOpenProject(p.id); });
      row.querySelector('.pi-rename').addEventListener('click', function (e) { e.stopPropagation(); doRenameProject(p.id, p.name); });
      row.querySelector('.pi-delete').addEventListener('click', function (e) { e.stopPropagation(); doDeleteProject(p.id, p.name); });
      listEl.appendChild(row);
    });
  }

  function confirmDiscardIfDirty() {
    if (!isDirty()) return true;
    return window.confirm('当前工程有未保存的改动，是否放弃这些改动？');
  }

  function doOpenProject(id) {
    if (!id) return;
    if (!confirmDiscardIfDirty()) return;
    App.api.projects.load(id).then(function (loaded) {
      if (typeof App.loadProjectData === 'function') App.loadProjectData(loaded);
      _bannerDismissed = false;
      closeProjectPanel();
      refreshOfflineBanner();
      updateProjectNameLabel();
      toast('已打开工程：' + ((loaded && loaded.name) || ''), 'ok');
    }).catch(function (err) {
      toast('打开工程失败：' + (err && err.message || err), 'error');
    });
  }

  function doNewProject() {
    if (!confirmDiscardIfDirty()) return;
    if (typeof App.newProject === 'function') App.newProject();
    _bannerDismissed = false;
    closeProjectPanel();
    refreshOfflineBanner();
    updateProjectNameLabel();
  }

  function doRenameProject(id, oldName) {
    var name = window.prompt('重命名工程：', oldName || '');
    if (name == null) return;
    name = name.trim();
    if (!name) { toast('工程名不能为空', 'error'); return; }
    App.api.projects.rename(id, name).then(function () {
      // 若重命名的是当前打开的工程，同步元信息
      var m = meta();
      if (m && m.id === id && typeof App.setProjectMeta === 'function') App.setProjectMeta({ id: id, name: name });
      loadProjectList();
      toast('已重命名为：' + name, 'ok');
    }).catch(function (err) {
      toast('重命名失败：' + (err && err.message || err), 'error');
    });
  }

  function doDeleteProject(id, name) {
    if (!window.confirm('确定删除工程「' + (name || '未命名工程') + '」？此操作不可撤销（素材文件不会被删除）。')) return;
    App.api.projects.del(id).then(function () {
      // 若删除的是当前打开的工程，清空元信息（内容保留在内存，可另存为）
      var m = meta();
      if (m && m.id === id && typeof App.setProjectMeta === 'function') App.setProjectMeta({ id: null, name: m.name || null });
      loadProjectList();
      toast('已删除工程', 'ok');
    }).catch(function (err) {
      toast('删除失败：' + (err && err.message || err), 'error');
    });
  }

  /* =======================================================================
   * D. 保存 / 另存为（含命名对话框 #saveNameDialog）
   * ===================================================================== */
  function saveProject() {
    var m = meta();
    if (m && m.id) {
      var proj = serialize();
      if (!proj) { toast('无法序列化工程', 'error'); return; }
      App.api.projects.save({ id: m.id, name: m.name, project: proj }).then(function (res) {
        if (typeof App.setProjectMeta === 'function') App.setProjectMeta({ id: res.id, name: res.name });
        if (typeof App.markSaved === 'function') App.markSaved();
        updateProjectNameLabel();
        toast('已保存：' + (res.name || ''), 'ok');
      }).catch(function (err) {
        toast('保存失败：' + (err && err.message || err), 'error');
      });
    } else {
      saveAsProject();
    }
  }

  var _saveNameCb = null;
  function promptSaveName(defName, cb) {
    var dlg = $('saveNameDialog');
    var inp = $('inpSaveName');
    if (!dlg || !inp) {
      // 回退到原生 prompt
      var n = window.prompt('请输入工程名称：', defName || '未命名工程');
      if (n != null && n.trim()) cb(n.trim());
      return;
    }
    inp.value = defName || '';
    _saveNameCb = cb;
    openDlg(dlg);
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
  }
  function confirmSaveName() {
    var inp = $('inpSaveName');
    var name = inp ? inp.value.trim() : '';
    if (!name) { toast('请输入工程名称', 'error'); if (inp) inp.focus(); return; }
    closeDlg($('saveNameDialog'));
    var cb = _saveNameCb; _saveNameCb = null;
    if (cb) cb(name);
  }
  function cancelSaveName() { closeDlg($('saveNameDialog')); _saveNameCb = null; }

  function saveAsProject() {
    var m = meta();
    promptSaveName((m && m.name) || '未命名工程', function (name) {
      var proj = serialize();
      if (!proj) { toast('无法序列化工程', 'error'); return; }
      // 无 id → 后端新建（另存为）
      App.api.projects.save({ name: name, project: proj }).then(function (res) {
        if (typeof App.setProjectMeta === 'function') App.setProjectMeta({ id: res.id, name: res.name });
        if (typeof App.markSaved === 'function') App.markSaved();
        updateProjectNameLabel();
        toast('已保存为：' + (res.name || ''), 'ok');
      }).catch(function (err) {
        toast('另存为失败：' + (err && err.message || err), 'error');
      });
    });
  }

  /* =======================================================================
   * E. beforeunload 脏提示
   * ===================================================================== */
  function bindBeforeUnload() {
    window.addEventListener('beforeunload', function (e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
  }

  /* =======================================================================
   * F. bus / 快捷键桥接
   * ===================================================================== */
  function bindShortcutBridge() {
    bus.on('project:save', function () { saveProject(); });
    bus.on('project:saveAs', function () { saveAsProject(); });
    bus.on('projectmeta:changed', updateProjectNameLabel);
    bus.on('dirty:changed', updateProjectNameLabel);
    bus.on('media:changed', refreshOfflineBanner);
    bus.on('project:loaded', function () { _bannerDismissed = false; refreshOfflineBanner(); updateProjectNameLabel(); });
  }

  /* =======================================================================
   * G. DOM 绑定 + 启动流程
   * ===================================================================== */
  function bindStaticDom() {
    var btnProjects = $('btnProjects');
    if (btnProjects) btnProjects.addEventListener('click', function () {
      // 仅打开面板查看/管理工程，不丢弃当前编辑——脏确认下沉到真正切换工程的 doOpenProject/doNewProject。
      openProjectPanel();
    });

    var btnSave = $('btnSaveProject');
    if (btnSave) btnSave.addEventListener('click', function () { saveProject(); });

    var btnNew = $('btnNewProject');
    if (btnNew) btnNew.addEventListener('click', doNewProject);

    var dlgClose = $('projectDialogClose');
    if (dlgClose) dlgClose.addEventListener('click', function () {
      // 仅在已有当前工程（或非脏）时允许直接关；否则提示先选择
      closeProjectPanel();
    });

    // 命名对话框
    var ok = $('btnSaveNameOk');
    if (ok) ok.addEventListener('click', confirmSaveName);
    var cancel = $('btnSaveNameCancel');
    if (cancel) cancel.addEventListener('click', cancelSaveName);
    var inp = $('inpSaveName');
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmSaveName(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelSaveName(); }
    });

    // 离线横幅
    var relinkAllBtn = $('btnRelinkAll');
    if (relinkAllBtn) relinkAllBtn.addEventListener('click', relinkAll);
    var bannerClose = $('offlineBannerClose');
    if (bannerClose) bannerClose.addEventListener('click', function () {
      _bannerDismissed = true;
      var b = $('offlineBanner'); if (b) b.hidden = true;
    });

    // 工程对话框点击 backdrop 不关闭（避免误关；用「关闭」按钮）
    var pdlg = $('projectDialog');
    if (pdlg) pdlg.addEventListener('cancel', function (e) { e.preventDefault(); }); // 屏蔽 Esc 直接关
    var sdlg = $('saveNameDialog');
    if (sdlg) sdlg.addEventListener('cancel', function (e) { e.preventDefault(); cancelSaveName(); });
  }

  function init() {
    bindStaticDom();
    bindShortcutBridge();
    bindBeforeUnload();
    updateProjectNameLabel();
    refreshOfflineBanner();
    // 启动弹工程选择面板（project_design.md §6.3）
    openProjectPanel();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 暴露给调试 / 其它模块 */
  App.projectsUI = {
    openProjectPanel: openProjectPanel,
    closeProjectPanel: closeProjectPanel,
    saveProject: saveProject,
    saveAsProject: saveAsProject,
    newProject: doNewProject,
    refreshOfflineBanner: refreshOfflineBanner,
    updateProjectNameLabel: updateProjectNameLabel
  };

})();
