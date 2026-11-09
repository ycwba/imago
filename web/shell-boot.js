/* 外壳启动前的最小引导：解析主题（深浅 + 配色）与「我在外壳里」旗标。
   单独成文件是为了严格 CSP（script-src 'self' 不允许内联脚本）。

   主题是两根轴：
     · data-theme   只放**解析后**的 light / dark（永远不写 system）—— 样式按它取色；
     · data-palette 放配色名（ocean 缺省）。
   偏好（dir_theme / dir_palette）只在这里读；「跟随系统」= 听 matchMedia 的档位变化。
   这段必须先于样式表执行（shell.html 里它排在 <link> 之前），否则会先闪一帧浅色。 */
(function () {
  'use strict';
  var MODES = ['light', 'dark', 'system'];
  var PALETTES = ['violet', 'ocean', 'teal', 'berry', 'amber'];
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  /* 存储不可用（隐私模式）就当没设过 —— 偏好坏了退回缺省，不抛。 */
  function readPref(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }

  /* 偏好里的档位：没设过 / 坏值都按缺省档算 —— 缺省是「跟随系统」（三档早已存在，只改默认值），
     所以空串也要跟着系统档走；matchMedia 变化那一处用的是同一份判定。 */
  function prefMode() {
    var mode = readPref('dir_theme');
    return MODES.indexOf(mode) < 0 ? 'system' : mode;
  }

  /* 把两根轴的偏好解析成 DOM 上的两个属性 —— 全站唯一一处。
     别处（侧栏那颗日 / 夜按钮、设置页改动、助手改设置）都只调 window.__themeApply，
     不再自己写 dataset.theme：那会绕过「system 要先解析」这一步。 */
  function resolveTheme() {
    var root = document.documentElement;
    var mode = prefMode();
    root.dataset.theme = mode === 'system' ? (mq && mq.matches ? 'dark' : 'light') : mode;
    var pal = readPref('dir_palette');
    root.dataset.palette = PALETTES.indexOf(pal) >= 0 ? pal : 'ocean';
    try { if (window.__sbThemeIcon) window.__sbThemeIcon(); } catch (e) {
      /* 侧栏还没装上（或图标画失败）：图标停在旧档不影响配色，下一次解析会再画。 */
    }
    try { document.dispatchEvent(new CustomEvent('sb:theme-applied')); } catch (e) {
      /* 极老的浏览器没有 CustomEvent：设置页那两格高亮退化成下次进页时正确。 */
    }
  }
  window.__themeApply = resolveTheme;

  /* 跟随系统：只有偏好是 system 时才跟；系统档变了立刻重解析。
     偏好已经钉成 light / dark 的不受系统影响。 */
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', function () {
      if (prefMode() === 'system') resolveTheme();
    });
  }

  resolveTheme();
  window.__SB_SHELL = true;
})();
