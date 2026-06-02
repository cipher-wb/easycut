/* =========================================================================
 * theme.js — 白天 / 夜间主题切换
 *
 * 机制：在 <html> 上加/去 data-theme="dark"（style.css 的 :root[data-theme="dark"]
 *       提供整套暗色变量）。偏好持久化到 localStorage['qj-theme']。
 *       首屏闪烁由 index.html <head> 里的预置脚本规避（渲染前已应用）。
 *
 * 纯原生 JS，无依赖。
 * ========================================================================= */
(function () {
  'use strict';

  var KEY = 'qj-theme';
  var root = document.documentElement;

  function isDark() { return root.getAttribute('data-theme') === 'dark'; }

  function apply(theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    updateBtn();
  }

  function updateBtn() {
    var btn = document.getElementById('btnTheme');
    if (!btn) return;
    if (isDark()) { btn.textContent = '☀ 白天'; btn.title = '切换到白天模式'; }
    else { btn.textContent = '🌙 夜间'; btn.title = '切换到夜间模式'; }
  }

  function toggle() {
    var next = isDark() ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  }

  function init() {
    // <head> 预置脚本已按 localStorage 应用过 data-theme；此处只读偏好兜底 + 接线按钮。
    var saved = 'light';
    try { saved = localStorage.getItem(KEY) || 'light'; } catch (e) {}
    apply(saved);
    var btn = document.getElementById('btnTheme');
    if (btn) btn.addEventListener('click', toggle);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 供其它模块/调试使用
  window.QJTheme = { toggle: toggle, apply: apply, isDark: isDark };
})();
