/* 外壳启动前的最小引导：主题（避免闪一下浅色）与「我在外壳里」旗标。
   单独成文件是为了严格 CSP（script-src 'self' 不允许内联脚本）。 */
(function () {
  'use strict';
  try { document.documentElement.dataset.theme = localStorage.getItem('dir_theme') || 'light'; } catch (e) {}
  window.__SB_SHELL = true;
})();
