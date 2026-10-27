/* 风格提案 v2 —— 稿子上的小动作（只为看稿子方便，不是产品的一部分）。
   · 深浅档切换：同一套令牌换值，不是另设计的一版；
   · 色卡点一下复制色值；
   · 分段开关、开关按钮可以点（示意）。 */
'use strict';

(function () {
  const root = document.documentElement;

  /* ---------- 深浅档 ---------- */
  const saved = (function () {
    try { return localStorage.getItem('style-v2-theme') || ''; } catch (e) { return ''; }
  })();
  if (saved) root.setAttribute('data-theme', saved);
  syncThemeButtons();

  function syncThemeButtons() {
    const now = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-set]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-theme-set') === now);
    });
  }

  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-theme-set]');
    if (!t) return;
    const theme = t.getAttribute('data-theme-set');
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('style-v2-theme', theme); } catch (err) { /* 无痕模式就算了 */ }
    syncThemeButtons();
  });

  /* ---------- 色卡复制 ---------- */
  let tip = null;
  function say(msg) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'copytip';
      tip.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
        'padding:8px 14px', 'border-radius:4px', 'background:#10161A', 'color:#fff',
        'font:500 12px/1.4 ui-monospace,Consolas,monospace', 'letter-spacing:.04em',
        'pointer-events:none', 'opacity:0', 'transition:opacity 160ms ease', 'z-index:50',
      ].join(';');
      document.body.appendChild(tip);
    }
    tip.textContent = msg;
    tip.style.opacity = '1';
    clearTimeout(tip._t);
    tip._t = setTimeout(function () { tip.style.opacity = '0'; }, 1200);
  }

  document.addEventListener('click', function (e) {
    const sw = e.target.closest('.sw');
    if (!sw) return;
    const hex = sw.querySelector('.sw__h');
    if (!hex) return;
    const val = hex.textContent.trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(
        function () { say('已复制 ' + val); },
        function () { say(val); }
      );
    } else {
      say(val);
    }
  });

  /* ---------- 分段 / 开关（示意） ---------- */
  document.addEventListener('click', function (e) {
    const seg = e.target.closest('.seg__i');
    if (seg && seg.parentElement && seg.parentElement.classList.contains('seg')) {
      seg.parentElement.querySelectorAll('.seg__i').forEach(function (b) { b.classList.remove('is-on'); });
      seg.classList.add('is-on');
      return;
    }
    const sw = e.target.closest('.switch');
    if (sw) {
      sw.classList.toggle('is-on');
      sw.classList.toggle('is-off');
    }
  });
})();
