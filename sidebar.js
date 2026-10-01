/* 全局侧边栏：只在外壳页（shell.html）里渲染。
   内容页（index / 图片 / 视频 / 语音 / 收藏 / 资产库 / 用量 / 设置）跑在外壳的 iframe 里，
   自己不再画侧栏；万一被直接打开（顶层窗口），就转到外壳，避免出现两套左栏。 */
(function () {
  // ① 在 iframe 里的内容页：什么都不做（侧栏由外层提供，也不注入给页面留左边距的样式）
  //    只打个标记：外壳已经占掉左侧栏的宽度，页面里的全屏遮罩（灯箱等）要铺满自己这块内容区，别再避让
  if (window.self !== window.top) { document.documentElement.dataset.embedded = '1'; return; }
  // ② 内容页被直接打开：replace 到共用外壳（带上原查询串，如 image.html?reuse=1）
  if (!window.__SB_SHELL) {
    const file = (location.pathname.replace(/^.*\//, '') || 'index.html');
    if (!/^(shell|app)\.html$/.test(file)) {
      location.replace('shell.html#' + file + location.search);
      return;
    }
  }

  const css = `
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: var(--sbw, 66px); z-index: 90;
    background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column;
    overflow: hidden; transition: width .18s ease; }
  html.sb-open .sidebar { width: 200px; }
  /* 窄窗口（≤1100px）里展开 = 浮层盖在内容上，内容区不让位（--sbw 仍是 66px），
     所以加个投影，一眼看出这一档是临时浮出来的。 */
  html.sb-narrow.sb-open .sidebar { box-shadow: 4px 0 18px rgba(0,0,0,.18); }
  .sidebar .sb-brand { display: flex; align-items: center; gap: 10px; padding: 14px 12px; white-space: nowrap; position: relative; width: 100%; cursor: pointer; }
  .sidebar .sb-logo { width: 36px; height: 36px; border-radius: 5px; background: var(--pri, #7c5cff); color: #fff;
    display: flex; align-items: center; justify-content: center; font-weight: 700; flex: 0 0 36px;
    cursor: pointer; border: 0; user-select: none; transition: filter .15s, transform .12s; }
  .sidebar .sb-logo:hover { filter: brightness(1.12); transform: scale(1.05); }
  .sidebar .sb-logo:active { transform: scale(.96); }
  .sidebar .sb-name { font-weight: 700; font-size: 14px; color: var(--txt); }
  .sidebar .sb-group { font-size: 10.5px; color: var(--sub); padding: 10px 20px 4px; white-space: nowrap; }
  /* 收起态一律 display:none（以前是 opacity:0）：opacity 藏得住文字却藏不住它占的宽度，
     66px 里图标被 gap + 隐形文字顶得偏左，分组标题也白占两行高度。 */
  html:not(.sb-open) .sidebar .sb-name, html:not(.sb-open) .sidebar .sb-group,
  html:not(.sb-open) .sidebar nav a .lb, html:not(.sb-open) .sidebar .sb-set .lb { display: none; }
  html:not(.sb-open) .sidebar .sb-brand, html:not(.sb-open) .sidebar nav a,
  html:not(.sb-open) .sidebar .sb-set { justify-content: center; gap: 0; padding-left: 0; padding-right: 0; }
  html:not(.sb-open) .sidebar .sb-brand { padding-top: 14px; padding-bottom: 14px; }
  .sidebar nav { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; flex: 1 1 auto;
    min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
  .sidebar nav a { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 4px;
    color: var(--txt); text-decoration: none; font-size: 13px; white-space: nowrap; transition: background .12s; }
  .sidebar nav a:hover { background: var(--panel2); }
  .sidebar nav a.active { background: rgba(124,92,255,.12); color: var(--acc); font-weight: 600; }
  .sidebar nav a .ic { width: 20px; text-align: center; font-size: 15px; flex: 0 0 20px; }
  /* 底部两块（账户余额 / 设置·换背景）不参与滚动、也不许被无声裁掉（flex:0 0 auto）。
     真正会超长的只有余额列表，给它自己的高度上限内滚动：overflow-x 显式写 hidden，
     否则一轴 auto 会把另一轴也算成 auto，收起态（66px）里冒出横向条。
     上限用 vh：窗口越矮让得越多，导航区始终留得住。 */
  .sidebar .sb-bottom { padding: 10px 8px; border-top: 1px solid var(--line); flex: 0 0 auto; }
  .sidebar .sb-bottom#sbBalance { max-height: min(34vh, 260px); overflow-y: auto; overflow-x: hidden; }
  .sb-bal { display: flex; flex-direction: column; gap: 6px; }
  .sb-bal-card { border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; background: var(--panel2); cursor: default; }
  .sb-bal-card .l1 { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--txt); font-weight: 600; white-space: nowrap; }
  .sb-bal-card .l1 .ic { font-size: 12px; }
  .sb-bal-card .l2 { margin-top: 3px; font-size: 11px; color: var(--sub); white-space: normal; line-height: 1.5; word-break: break-all; }
  .sb-bal-card .l2 b { color: var(--txt); font-weight: 600; }
  .sb-bal-refresh { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px;
    font-size: 11px; color: var(--sub); cursor: pointer; }
  .sb-bal-refresh:hover { color: var(--acc); background: var(--panel2); }
  /* 收起态：刷新余额只留图标（四个字太占地方，会把按钮撑成两行） */
  html:not(.sb-open) .sb-bal-refresh { justify-content: center; padding: 6px 0; gap: 0; }
  html:not(.sb-open) .sb-bal-refresh span:last-child { display: none; }
  /* 设置入口固定在左下角 */
  .sidebar .sb-set { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 4px;
    color: var(--txt); text-decoration: none; font-size: 13px; white-space: nowrap; transition: background .12s; }
  .sidebar .sb-set:hover { background: var(--panel2); color: var(--acc); }
  .sidebar .sb-set.active { background: rgba(124,92,255,.12); color: var(--acc); font-weight: 600; }
  .sidebar button.sb-set { width: 100%; border: 0; background: none; font-family: inherit; text-align: left;
    cursor: pointer; display: flex; align-items: center; }
  .sidebar .sb-set .ic { width: 20px; text-align: center; font-size: 15px; flex: 0 0 20px; }
  /* 收起态：余额卡片压成一张小卡，只留图标与可用数值缩写，悬停看完整信息。
     缩写这条以前挂在 min-width:1101px 上 —— 窄窗收起时整张卡只剩一个图标，数字反而没了。 */
  html:not(.sb-open) .sb-bal-card { padding: 5px 4px; text-align: center; }
  html:not(.sb-open) .sb-bal-card .l1 { justify-content: center; }
  html:not(.sb-open) .sb-bal-card .l1 .nm { display: none; }
  html:not(.sb-open) .sb-bal-card .l2 { display: none; }
  html:not(.sb-open) .sb-bal-card::after { content: attr(data-short); display: block; font-size: 10px; color: var(--sub); margin-top: 2px; }
  /* 矮窗口再压一档行高，让导航至少露出三四条 */
  @media (max-height: 780px) {
    .sidebar .sb-brand { padding-top: 10px; padding-bottom: 10px; }
    .sidebar .sb-group { padding: 7px 20px 3px; }
    .sidebar nav { padding: 4px 8px; }
    .sidebar nav a { padding: 7px 10px; }
    .sidebar .sb-bottom { padding: 6px 8px; }
    .sidebar .sb-bal { gap: 4px; }
    .sb-bal-card { padding: 4px 6px; }
  }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const items = [
    { file: 'index.html', ic: 'film', label: '导演台' },
    { file: 'image.html', ic: 'image', label: '图片工作台' },
    { file: 'video.html', ic: 'video', label: '视频工作台' },
    { file: 'audio.html', ic: 'mic', label: '语音工作台' },
    { file: 'favorites.html', ic: 'star', label: '我的收藏' },
    { file: 'assets.html', ic: 'box', label: '资产库' },
    { file: 'usage.html', ic: 'chart', label: '用量与余额' },
  ];
  const svgIc = (n, s) => (window.icon ? window.icon(n, s || 18) : '');
  /* 只在外壳里渲染：链接就是外壳的 hash，点击交给 app.js 换 iframe（侧栏不重建）；
     当前高亮不在这里判断，由 app.js 在切页后统一回填 __sbSetActive。 */
  const hrefOf = f => '#' + f;

  const sb = document.createElement('div');
  sb.className = 'sidebar';
  sb.innerHTML =
    '<div class="sb-brand"><span class="sb-logo" title="点击收起 / 展开侧边栏">AI</span><span class="sb-name">AI创作工作台</span></div>' +
    '<div class="sb-group">工作空间</div>' +
    '<nav>' + items.map(i =>
      `<a href="${hrefOf(i.file)}" data-page="${i.file}" class=""><span class="ic">${svgIc(i.ic)}</span><span class="lb">${i.label}</span></a>`
    ).join('') + '</nav>' +
    '<div class="sb-group">账户余额</div>' +
    '<div class="sb-bottom" id="sbBalance"></div>' +
    '<div class="sb-bottom"><a href="' + hrefOf('settings.html') + '" data-page="settings.html" class="sb-set"><span class="ic">' + svgIc('gear') + '</span><span class="lb">设置</span></a>' +
    '<button class="sb-set" id="sbTheme" title="切换亮色 / 暗色背景"><span class="ic">' + svgIc('moon') + '</span><span class="lb">换背景</span></button></div>';

  /* 点导航：不跳转整页，只让 app.js 换 iframe 内容（侧栏保持不动）；
     窄窗口里侧栏是浮层，选完就自动收回，否则内容一直被盖着一块。 */
  sb.querySelectorAll('a[data-page]').forEach(a => {
    a.onclick = e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // 允许新标签打开
      e.preventDefault();
      if (typeof window.appShow === 'function') window.appShow(a.dataset.page, true);
      if (narrow() && wantOpen()) close();
    };
  });
  /* app.js 切页后回填高亮（侧栏不重建，只改 class） */
  window.__sbSetActive = file => {
    sb.querySelectorAll('a[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === file));
    if (setLink) setLink.classList.toggle('active', file === 'settings.html');
  };
  const setLink = sb.querySelector('a.sb-set[data-page="settings.html"]');
  if (setLink) setLink.dataset.page = 'settings.html';


  // head 里加载时 body 尚不存在，等 DOM 就绪再挂载
  function mount() {
    document.body.prepend(sb);
  }

  /* 自适应：宽度 ≤1100px 算窄窗口 —— 用户想展开仍然可以展开，但那是浮层（不改 --sbw，
     内容区不被压缩）；宽窗口才是 66 ↔ 200 的真让位。以前窄窗口直接把展开吞掉
     （isOpen() 里 and 上宽度），点 AI 方块毫无反应，像坏了。 */
  const NARROW_W = 1100;
  const OPEN_W = 200;
  const narrow = () => window.innerWidth <= NARROW_W;
  const wantOpen = () => localStorage.getItem('sb_open') === '1';
  function apply() {
    const o = wantOpen();
    const n = narrow();
    const r = document.documentElement.classList;
    r.toggle('sb-narrow', n);
    r.toggle('sb-open', o);
    document.documentElement.style.setProperty('--sbw', (o && !n) ? OPEN_W + 'px' : '66px');
  }
  const setWant = v => { localStorage.setItem('sb_open', v ? '1' : '0'); apply(); };
  const close = () => setWant(false);
  // 折叠 / 展开：只保留左上角 AI 头像方块（点它切换），原来的箭头按钮已移除
  const toggle = () => setWant(!wantOpen());
  const logo = sb.querySelector('.sb-logo');
  if (logo) {
    logo.title = '点击收起 / 展开侧边栏';
    logo.onclick = e => { e.stopPropagation(); toggle(); };
  }
  const brand = sb.querySelector('.sb-brand');
  if (brand) {
    brand.title = '点击收起 / 展开侧边栏';
    brand.onclick = toggle;
  }
  // 换背景（亮 / 暗主题）：全站统一放在左下角
  const themeBtn = sb.querySelector('#sbTheme');
  const themeIcon = dark => svgIc(dark ? 'sun' : 'moon');
  if (themeBtn) themeBtn.onclick = () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cur;
    try { localStorage.setItem('dir_theme', cur); } catch {}
    themeBtn.querySelector('.ic').innerHTML = themeIcon(cur === 'dark');
    // 内容页在 iframe 里，同步换主题（页面已在 head 里读过一次 localStorage）
    const f = document.getElementById('appFrame');
    try { if (f && f.contentDocument) f.contentDocument.documentElement.dataset.theme = cur; } catch (e) {}
  };
  if (document.documentElement.dataset.theme === 'dark' && themeBtn) themeBtn.querySelector('.ic').innerHTML = themeIcon(true);
  window.addEventListener('resize', apply);
  apply();

  /* ---------- 账户余额（按 API 分类显示，路由驱动；显示哪几个接口由设置页勾选） ---------- */
  const BAL_KEY = 'sb_bal_cache';
  const readBalCache = () => { try { const c = JSON.parse(localStorage.getItem(BAL_KEY) || '{}'); return Array.isArray(c.rows) ? c.rows : []; } catch { return []; } };
  const sbKeyFor = id => localStorage.getItem('sk_key_' + id) || '';
  let balRows = [];                 // 最近一次拿到的**全量**余额行：勾选只影响渲染，不影响取数与缓存
  const balCardHTML = r =>
    `<div class="sb-bal-card" data-short="${r.short}" title="${r.name}：可用 ${r.avail}${r.unit} · 冻结 ${r.frozen}${r.unit}">
       <div class="l1"><span class="ic">${svgIc('coin', 13)}</span><span class="nm">${r.name}</span></div>
       <div class="l2">${r.availHtml} · 冻结 <b>${r.frozen}</b>${r.unit}</div>
     </div>`;
  function paintBal(box, rows, note) {
    const shown = (window.SbBal ? SbBal.filter(rows) : rows) || [];
    /* 一张卡都画不出来时的三种说法：接口读不到 / 平台压根没有余额接口 / 全被勾掉了。
       以前这里和下面各有两段手写的 innerHTML，收成一个提示卡。 */
    const body = shown.length ? shown.map(balCardHTML).join('')
      : '<div class="sb-bal-card"><div class="l1"><span class="ic">' + svgIc('coin', 13) + '</span><span class="nm">余额</span></div>'
        + '<div class="l2">' + (note || (rows.length ? '要显示哪些接口在「设置 → 平台密钥与余额」里勾' : '无余额接口')) + '</div></div>';
    box.innerHTML = '<div class="sb-bal">' + body
      + '<div class="sb-bal-refresh" title="刷新余额"><span class="ic">' + svgIc('refresh', 13) + '</span><span>刷新余额</span></div></div>';
    box.querySelector('.sb-bal-refresh').onclick = () => refreshBalance();
  }
  async function refreshBalance() {
    const box = sb.querySelector('#sbBalance');
    if (!box) return;
    // 先画缓存：切页/刷新时余额立刻可见，不会先空一下再跳出来
    const cached = readBalCache();
    if (cached.length) { balRows = cached; paintBal(box, cached); }
    let reg;
    // 注册表统一走 Api.registry（带 60 秒缓存，和其它页面共用一份）；只有 assetlib 没加载时才现取
    try { reg = (window.Api && Api.registry) ? await Api.registry() : await (await fetch('/registry')).json(); }
    catch { if (!cached.length) paintBal(box, [], '余额读取失败'); return; }
    // 按 keyId 合并（如 sparkcine-video 并入 sparkcine）；余额怎么读也按声明（balance.style）带出来
    const map = new Map();
    (reg.providers || []).forEach(p => {
      if (!p.endpoints?.credits) return;
      const kid = p.keyId || p.id;
      if (!map.has(kid)) map.set(kid, { kid, name: (p.name || kid).split(' ')[0], relay: p.relay, ep: p.endpoints.credits,
        style: (p.balance || {}).style || 'micros' });
    });
    if (!map.size) { paintBal(box, [], '这些平台没有余额接口'); return; }
    const rows = await Promise.all([...map.values()].map(async m => {
      try {
        const c = await fetch(m.relay + m.ep, { headers: { 'Authorization': 'Bearer ' + sbKeyFor(m.kid) } }).then(r => r.json());
        const entry = Array.isArray(c) ? c[0] : (c.data?.[0] || c);
        let avail, frozen, unit;
        /* wallet-credits = 积分账户（available/reserved 原样显示），micros = 金额账户（折 ¥）。
           按 registry 的 balance.style 判，不按平台名 —— 第二家积分制平台接进来不用再改这里。 */
        if (m.style === 'wallet-credits') { avail = entry.available ?? '?'; frozen = entry.reserved ?? 0; unit = ' 积分'; }
        else {
          const pick = v => typeof v === 'object' && v ? (v.amount_micros ?? 0) : (v ?? 0);
          avail = '¥' + (Number(pick(entry.availableMicros ?? entry.available)) / 1e6).toFixed(2);
          frozen = '¥' + (Number(pick(entry.reservedMicros ?? entry.frozen ?? 0)) / 1e6).toFixed(2);
          unit = '';
        }
        return { kid: m.kid, name: m.name, avail, frozen, unit, availHtml: '可用 <b>' + avail + '</b>' + unit,
          short: String(avail).slice(0, 7) };
      } catch { return { kid: m.kid, name: m.name, avail: '获取失败', frozen: '-', unit: '', availHtml: '获取失败', short: '—' }; }
    }));
    try { localStorage.setItem(BAL_KEY, JSON.stringify({ ts: Date.now(), rows })); } catch {}
    balRows = rows;
    paintBal(box, rows);
  }
  /* 设置页在 iframe 里改勾选 → 同源的 storage 事件送到外壳：直接按缓存重画，不用重取余额 */
  window.addEventListener('storage', e => {
    if (!window.SbBal || e.key !== SbBal.KEY) return;
    const box = sb.querySelector('#sbBalance');
    if (box && balRows.length) paintBal(box, balRows);
  });
  window.addEventListener('sb-balance-refresh', refreshBalance);
  refreshBalance();
  setInterval(refreshBalance, 60000);
  // 挂载放最后：head 里加载时 body 还不存在，而且上面的状态常量要先生效完
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
