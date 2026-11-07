/* 全局命令面板：Ctrl/Cmd+K 唤起，↑↓ 选择，Enter 跳页，Esc 关闭。
   页面清单只从路由表现取，跳页只走 GoPage.go；这里不登记任何动作，
   写动作仍只经动作注册表，面板不复制第二份动作目录。
   全局只占一个唤起键，其余按键都在面板自己的输入框里消化并截断，
   不会与导演台那个键盘作用域岛抢同一个键。 */
(function () {
  let root = null, input = null, list = null, items = [], sel = 0, shown = false, lastFocus = null;

  const cmdEsc = s => window.esc ? window.esc(s) : String(s == null ? '' : s);
  /* 路由表是页面清单的唯一一份：这里现取，不抄一遍名字，也不缓存（换页不会变少）。 */
  const pages = () => {
    const R = window.WB_ROUTES;
    return R && Array.isArray(R.pages) ? R.pages : [];
  };
  const typing = el => {
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
  };
  const candidates = q => {
    const s = String(q || '').trim().toLowerCase();
    return pages().filter(p => !s || [p.label, p.id, p.short, p.title, p.file]
      .filter(Boolean).join(' ').toLowerCase().includes(s))
      .map(p => ({ label: p.label || p.title || p.id, hint: p.file || '', target: p.file }));
  };

  function cmdPaint() {
    items = candidates(input.value);
    if (sel >= items.length) sel = 0;
    list.innerHTML = items.length
      ? items.map((it, i) => '<div class="cmd-item' + (i === sel ? ' is-sel' : '') + '" role="option"'
        + ' aria-selected="' + (i === sel ? 'true' : 'false') + '" data-i="' + i + '">'
        + '<span>' + cmdEsc(it.label) + '</span><span class="cmd-hint">' + cmdEsc(it.hint) + '</span></div>').join('')
      : '<div class="cmd-none">没有这个页面</div>';
  }
  function choose(i) {
    const it = items[i];
    if (!it || !it.target) return;
    cmdClose();
    window.GoPage.go(it.target);
  }
  function cmdOpen() {
    if (!root) cmdBuild();
    lastFocus = document.activeElement;
    root.hidden = false; shown = true;
    input.value = ''; sel = 0; cmdPaint();
    if (window.focusQuiet) window.focusQuiet(input);
    else input.focus({ preventScroll: true });
  }
  function cmdClose() {
    if (!root || !shown) return;
    root.hidden = true; shown = false;
    if (lastFocus && window.focusQuiet) window.focusQuiet(lastFocus);
    lastFocus = null;
  }
  function cmdBuild() {
    root = document.createElement('div');
    root.className = 'cmd-palette';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '跳到哪一页');
    root.innerHTML = '<div class="cmd-box">'
      + '<input class="cmd-input" type="text" autocomplete="off" placeholder="输入页面名…" aria-label="页面名">'
      + '<div class="cmd-list" role="listbox" aria-label="页面"></div>'
      + '<div class="cmd-foot">↑↓ 选择 · Enter 跳页 · Esc 关闭</div>'
      + '</div>';
    document.body.appendChild(root);
    input = root.querySelector('.cmd-input');
    list = root.querySelector('.cmd-list');
    input.addEventListener('input', cmdPaint);
    input.addEventListener('keydown', onPanelKey);
    list.addEventListener('click', e => {
      const row = e.target.closest ? e.target.closest('.cmd-item') : null;
      if (row) choose(Number(row.getAttribute('data-i')));
    });
    root.addEventListener('mousedown', e => { if (e.target === root) cmdClose(); });
  }
  function onPanelKey(e) {
    if (e.isComposing) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (!items.length) return;
      sel = (sel + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      cmdPaint();
    } else if (k === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      choose(sel);
    } else if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cmdClose();
    }
  }
  function onGlobalKey(e) {
    if (e.isComposing) return;
    const k = e.key;
    const hot = (e.ctrlKey || e.metaKey) && (k === 'k' || k === 'K');
    if (hot) {
      /* 输入框里的 Ctrl+K 归那一格自己；面板已经开着时它归面板（用来收起）。 */
      if (!shown && typing(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      shown ? cmdClose() : cmdOpen();
    } else if (k === 'Escape' && shown) {
      e.preventDefault(); e.stopPropagation();
      cmdClose();
    }
  }
  document.addEventListener('keydown', onGlobalKey, true);
  window.CommandPalette = { show: cmdOpen, close: cmdClose, isOpen: () => shown,
    candidates, keys: { open: 'Ctrl/Cmd+K' } };
})();
