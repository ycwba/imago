/* ============================================================================
   左栏重设计稿 —— 交互
   ---------------------------------------------------------------------------
   三档宽度（轨 / 列 / 架）、刻度拉片、悬停预告卡。
   这一稿是**纯静态稿**：不碰产品代码，不连任何外部数据。
   ========================================================================== */
(function () {
  const D = window.SB_DATA;
  const $ = s => document.querySelector(s);

  const shellEl = $('#shell');
  const sbEl = $('#sb');
  const modesEl = $('#modes');
  const notesEl = $('#notes');

  /* ---------- 图标 ---------- */
  const icon = (name, size) => {
    const b = D.ICONS[name];
    if (!b) return '';
    const s = size || 16;
    return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
      + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      + ' style="flex:0 0 auto">' + b + '</svg>';
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- 侧栏骨架 ---------- */
  const itemHTML = it => {
    const active = it.active ? ' on' : '';
    const cnt = it.count ? '<span class="sb-ct">' + esc(it.count) + '</span>' : '';
    return '<a class="sb-item' + active + '" href="#" data-id="' + esc(it.id) + '"'
      + ' data-sub="' + esc(it.sub || '') + '" data-meta="' + esc(it.meta || '') + '"'
      + ' data-ic="' + esc(it.ic) + '" aria-label="' + esc(it.label) + '">'
      + '<span class="sb-ic">' + icon(it.ic, 17) + '</span>'
      + '<span class="sb-lb">' + esc(it.label) + '</span>' + cnt + '</a>';
  };

  const balRowHTML = r => '<div class="sb-bal-row' + (r.failed ? ' bad' : '') + '"'
    + (r.failed ? ' title="' + esc(r.why) + '"' : '') + '>'
    + '<div class="sb-bal-l"><div class="sb-bal-nm">' + esc(r.name) + '</div>'
    + '<div class="sb-bal-sub">' + (r.failed ? esc(r.why) : '冻结 ' + esc(r.frozen) + (r.unit ? ' ' + esc(r.unit) : '')) + '</div></div>'
    + '<div class="sb-bal-av">' + esc(r.avail) + (r.unit && !r.failed ? ' ' + esc(r.unit) : '') + '</div></div>';

  sbEl.innerHTML =
    '<div class="sb-brand">'
    + '<button class="sb-logo" id="sbLogo" title="在「全开」与「图标轨」之间翻">AI</button>'
    + '<div class="sb-brand-txt"><div class="sb-brand-name">' + esc(D.brand.name) + '</div>'
    + '<div class="sb-brand-sub">' + esc(D.brand.sub) + '</div></div>'
    + '</div>'
    /* 刻度拉片：三根长短不一的横档，长度就是那一档的宽度 */
    + '<div class="sb-gauge" id="gauge" role="radiogroup" aria-label="侧栏宽度">'
    + D.modes.map(m => '<button type="button" data-mode="' + m.id + '" title="'
      + esc(m.name + ' · ' + m.w + 'px · ' + m.hint) + '" role="radio" aria-checked="false"></button>').join('')
    + '</div>'
    + '<nav class="sb-nav" id="sbNav">'
    + '<div class="sb-sec"><span class="sb-sec-t">工作空间</span></div>'
    + D.nav.map(itemHTML).join('')
    + '</nav>'
    + '<div class="sb-bal">'
    + '<div class="sb-sec"><span class="sb-sec-t">账户余额</span>'
    + '<span class="sb-sec-v">' + D.balance.count + ' 家在用</span></div>'
    + '<div class="sb-bal-sum" id="balSum"></div>'
    + '<div class="sb-bal-list">' + D.balance.rows.map(balRowHTML).join('') + '</div>'
    + '<div class="sb-bal-note">' + (D.balance.real
      ? '余额取自这台机器（隔离探针目录）'
      : '金额是示例值 —— 真机上由侧栏自己向平台取') + '</div>'
    + '</div>'
    + '<div class="sb-mirror">'
    + '<div class="sb-mirror-t">' + esc(D.mirror.title) + '</div>'
    + '<div class="sb-mirror-n">本次会话已存 ' + D.mirror.done + ' / ' + D.mirror.total + ' 份</div>'
    + '<div class="sb-mirror-b"><i style="width:'
    + Math.round(D.mirror.done / D.mirror.total * 100) + '%"></i></div>'
    + '</div>'
    + '<div class="sb-foot">'
    + D.foot.map(itemHTML).join('')
    + '</div>'
    /* 轨态下才画的「正在存本机」进度条（贴在侧栏最底边） */
    + '<div class="sb-progress" title="产物正在存进本机 · 本次会话已存 '
    + D.mirror.done + ' / ' + D.mirror.total + ' 份"><i style="width:'
    + Math.round(D.mirror.done / D.mirror.total * 100) + '%"></i></div>';

  /* 列态 / 轨态用的余额摘要 */
  const balSum = $('#balSum');
  balSum.innerHTML =
    '<span class="p"><span class="ic">' + icon('coin', 12) + '</span><b>' + D.balance.count + '</b>'
    + '<span class="u">家余额</span></span>'
    + '<span class="sep">·</span>'
    + '<span class="p sto"><span class="ic">' + icon('download', 12) + '</span><b>' + D.mirror.done + '</b>'
    + '<span class="u">存本机</span></span>';

  /* ---------- 顶栏的三颗切换按钮 ---------- */
  modesEl.innerHTML = D.modes.map(m =>
    '<button type="button" role="tab" data-mode="' + m.id + '" aria-selected="false">'
    + '<b>' + esc(m.name) + ' ' + m.w + '</b><span>' + esc(m.hint) + '</span></button>').join('');

  /* ---------- 三档说明 ---------- */
  notesEl.innerHTML = [
    ['轨 · 60px', '只剩图标',
      '认出每一项靠<b>悬停出的预告卡</b>：名字、这一页是干什么的、现在什么状况都在卡上。'
      + '当前项除了底色，还多一道<b>贴着内边缘的强调条</b> —— 收起时它是唯一能指出「你在哪」的东西。'
      + '「正在存本机」退成侧栏最底边那一道 3px 进度条，不占地方。'],
    ['列 · 196px', '有名字',
      '给「想看清自己在哪、但不想给内容让太多位」的人。余额整块收成<b>一行摘要</b>，'
      + '每一行导航右边多一个<b>当前值的速记</b>（几场、几个角色、几份产物）。'],
    ['架 · 256px', '全开',
      '分组标题、余额明细、落盘进度全在。余额卡收成<b>两行</b>（名字一行 + 冻结一行），'
      + '比现在的三行卡矮一截 —— 同样高度里能多摆一家。'],
  ].map(x => '<div class="dg-note"><h3>' + x[0] + '<em>' + x[1] + '</em></h3><p>' + x[2] + '</p></div>').join('');

  /* ============================================================================
     切档
     ========================================================================== */
  let mode = 'shelf';
  const gaugeBtns = [...document.querySelectorAll('#gauge button')];

  function setMode(next) {
    if (!D.modes.some(m => m.id === next)) return;
    mode = next;
    sbEl.dataset.mode = next;
    document.querySelectorAll('#modes button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.mode === next)));
    gaugeBtns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === next)));
    hidePeek();
  }
  function toggle() { setMode(mode === 'shelf' ? 'rail' : 'shelf'); }

  modesEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  gaugeBtns.forEach(b => b.addEventListener('click', () => {
    /* 点当前那一档 = 在「全开」与「图标轨」之间翻；点别的档 = 直接跳过去 */
    if (b.dataset.mode === mode) toggle(); else setMode(b.dataset.mode);
  }));
  $('#sbLogo').addEventListener('click', toggle);

  /* 导航项：点一下换高亮（稿子里不跳页） */
  sbEl.querySelectorAll('.sb-item').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      sbEl.querySelectorAll('.sb-item').forEach(x => x.classList.remove('on'));
      a.classList.add('on');
    });
  });

  /* 键盘：← → 切档 */
  document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = D.modes.findIndex(m => m.id === mode);
    const j = e.key === 'ArrowRight' ? Math.min(D.modes.length - 1, i + 1) : Math.max(0, i - 1);
    if (j !== i) { setMode(D.modes[j].id); e.preventDefault(); }
  });

  /* ============================================================================
     预告卡（只在轨态）
     ========================================================================== */
  const peek = document.createElement('div');
  peek.className = 'sb-peek';
  peek.setAttribute('aria-hidden', 'true');
  shellEl.appendChild(peek);

  function hidePeek() { peek.classList.remove('on'); }

  function showPeek(a) {
    if (mode !== 'rail') return hidePeek();
    const sub = a.dataset.sub || '', meta = a.dataset.meta || '';
    peek.innerHTML = '<div class="sb-peek-ic">' + icon(a.dataset.ic, 19) + '</div>'
      + '<div class="sb-peek-t">' + esc(a.querySelector('.sb-lb').textContent) + '</div>'
      + (sub ? '<div class="sb-peek-s">' + esc(sub) + '</div>' : '')
      + (meta ? '<div class="sb-peek-m">' + esc(meta) + '</div>' : '');
    peek.style.left = (sbEl.offsetWidth + 10) + 'px';
    peek.style.top = '0px';
    const row = a.getBoundingClientRect();
    const shell = shellEl.getBoundingClientRect();
    const h = peek.offsetHeight;
    let top = row.top - shell.top + row.height / 2 - h / 2;
    top = Math.max(10, Math.min(top, shell.height - h - 10));
    peek.style.top = Math.round(top) + 'px';
    peek.classList.add('on');
  }

  sbEl.querySelectorAll('.sb-item').forEach(a => {
    a.addEventListener('mouseenter', () => showPeek(a));
    a.addEventListener('mouseleave', hidePeek);
    a.addEventListener('focus', () => showPeek(a));
    a.addEventListener('blur', hidePeek);
  });
  window.addEventListener('resize', hidePeek);

  /* 初始：架态 */
  setMode('shelf');

  /* ============================================================================
     换主题（深浅）
     ---------------------------------------------------------------------------
     这一稿的夜间版**不是另设计的一版**：它就是同一个稿子把 `data-theme` 换成 `dark`，
     深色档照抄产品 `web/styles/tokens.css` 里那一段。所以这里只切一个属性。
     ========================================================================== */
  const themeBtn = $('#dgTheme');
  const THEME_KEY = 'dir_theme';
  const setTheme = t => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    if (themeBtn) themeBtn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon', 17);
  };
  if (themeBtn) {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    setTheme(saved === 'dark' ? 'dark' : 'light');
    themeBtn.addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }

  /* 给截图脚本留一个钩子：window.__sbSetMode('rail') / window.__sbSetTheme('dark') */
  window.__sbSetMode = setMode;
  window.__sbSetTheme = setTheme;
})();
