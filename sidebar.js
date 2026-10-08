/* 全局侧边栏：只在外壳页（shell.html）里渲染。
   内容页（导演台 / 生成工作台 / 拍短剧 / 素材库 / 收藏 / 资产库 / 用量 / 设置）跑在外壳的 iframe 里，
   自己不再画侧栏；万一被直接打开（顶层窗口），就转到外壳，避免出现两套左栏。 */
(function () {
  // ① 在 iframe 里的内容页：什么都不做（侧栏由外层提供，也不注入给页面留左边距的样式）
  //    只打个标记：外壳已经占掉左侧栏的宽度，页面里的全屏遮罩（灯箱等）要铺满自己这块内容区，别再避让
  if (window.self !== window.top) { document.documentElement.dataset.embedded = '1'; return; }
  // ② 内容页被直接打开：replace 到共用外壳（带上原查询串，如 image.html?reuse=1）
  if (!window.__SB_SHELL) {
    const file = (location.pathname.replace(/^.*\//, '') || 'director.html');
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
    { file: 'director.html', ic: 'film', label: '导演台' },
    { file: 'drama.html', ic: 'video', label: '拍短剧' },
    { file: 'chars.html', ic: 'users', label: '素材库' },
    /* 图片 / 视频 / 语音三个工作台合并成这一页：类型在页面左上角切，
       侧栏只留一个入口（加三条就是三份入口指向同一页，反而让人以为功能丢了） */
    { file: 'studio.html', ic: 'sparkles', label: '生成工作台' },
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
    /* 收起 ↔ 展开改的是左边那一条带的宽度，而悬浮球只有 z=56、侧栏 90 —— 球停在被让出/占掉的那一条里
       就点不到了（等于把助手弄丢）。发一个通知，ai-chat.js 监听后按新的 --sbw 重新摆一次。
       放在 apply() 末尾：点 logo、启动、窗口 resize 三条路径都走这里，不用在每处各发一遍。 */
    window.dispatchEvent(new CustomEvent('sb:toggle'));
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
  /* 外壳里别处改了主题（AI 助手的 set_setting）也走这一条：换 data-theme + 同步 iframe + 补图标。
     图标只有这里知道怎么画，别处再拼一份 svg 就是第二份实现。 */
  window.__sbApplyTheme = t => {
    document.documentElement.dataset.theme = t;
    try { if (themeBtn) themeBtn.querySelector('.ic').innerHTML = themeIcon(t === 'dark'); } catch (e) {}
    const f = document.getElementById('appFrame');
    try { if (f && f.contentDocument) f.contentDocument.documentElement.dataset.theme = t; } catch (e) {}
  };
  if (themeBtn) themeBtn.onclick = () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('dir_theme', cur); } catch {}
    window.__sbApplyTheme(cur);
  };
  /* 设置页改完「侧栏默认展开」要当场重排一次，不能等下次进页面：
     栏宽、收起态、悬浮球避让全在 apply() 里算，所以把这个钩子递出去（和 __sbApplyTheme 同一类）。 */
  window.__sbApplyOpen = apply;
  if (document.documentElement.dataset.theme === 'dark' && themeBtn) themeBtn.querySelector('.ic').innerHTML = themeIcon(true);
  window.addEventListener('resize', apply);
  apply();
  /* 窄窗口里展开 = 浮层盖在内容上。点内容区要能把它收回去，但 iframe 里的点击不冒泡到外壳，
     所以由 app.js 在 iframe 文档上挂监听、postMessage 过来（见 app.js 的 CLOSE_OVERLAY）。
     这里只负责「收到就收」这一半，顺带保证宽窗口下点了内容区**不会**误关（宽窗口是真让位，不是浮层）。 */
  window.__sbCloseOverlay = () => { if (narrow() && wantOpen()) close(); };

  /* ---------- 账户余额（按 API 分类显示，路由驱动；显示哪几个接口由设置页勾选） ---------- */
  const BAL_KEY = 'sb_bal_cache';
  const readBalCache = () => { try { const c = JSON.parse(localStorage.getItem(BAL_KEY) || '{}'); return Array.isArray(c.rows) ? c.rows : []; } catch { return []; } };
  let balRows = [];                 // 最近一次拿到的**全量**余额行：勾选只影响渲染，不影响取数与缓存
  /* 余额行的 name/available 来自上游接口，进 innerHTML 与 title 属性前必须转义
     （这一页是外壳顶层文档，注入等于拿到 localStorage 里的密钥配置）。 */
  const escA = v => window.esc(v);
  const balCardHTML = r => {
    const avail = escA(r.avail), frozen = escA(r.frozen), unit = escA(r.unit);
    return `<div class="sb-bal-card" data-short="${escA(r.short)}" title="${escA(r.name)}：可用 ${avail}${unit} · 冻结 ${frozen}${unit}">
       <div class="l1"><span class="ic">${svgIc('coin', 13)}</span><span class="nm">${escA(r.name)}</span></div>
       <div class="l2">${r.failed ? escA(r.avail) : '可用 <b>' + avail + '</b>' + unit + ' · 冻结 <b>' + frozen + '</b>' + unit}</div>
     </div>`;
  };
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
    // 按 keyId 合并（如 sparkcine-video 并入 sparkcine）；带出**平台对象**，请求头与余额解析都走 Api 那一份实现
    const map = new Map();
    (reg.providers || []).forEach(p => {
      if (!p.endpoints?.credits) return;
      const kid = p.keyId || p.id;
      if (!map.has(kid)) map.set(kid, { kid, name: (p.name || kid).split(' ')[0], p });
    });
    if (!map.size) {
      /* 一个有余额接口的平台都没有了，**照样要 prune 一次**：
         以前那句 prune 排在下面「map 非空」的分支里，于是「平台全下架 / keyId 全改了」这一种
         情况下隐藏名单永远清不掉 —— 那份名单只增不减地攒着，几年下来就是一串死数据。 */
      if (window.SbBal) SbBal.prune([]);
      paintBal(box, [], '这些平台没有余额接口');
      return;
    }
    /* 顺手清一次勾选名单里的陈旧 kid：只有「有余额接口」的平台才可能出现在侧栏，
       不在 map 里的（平台下架 / 改名 / keyId 变了 / 被删掉了）留着就是死数据。
       这里用**注册表**那份名单而不是下面过滤后的 —— 隐藏与否是显示偏好，
       不能因为一把钥匙暂时没配就把它从名单里抹掉（配回来时又冒出来才叫添乱）。 */
    if (window.SbBal) SbBal.prune([...map.keys()]);
    /* **本机压根没在用的那几家不画**：注册表里声明了 credits 端点的平台全都会被上面收进来，
       以前不区分「用不用」，于是月之暗面这种没添加、没密钥的一家也占着一张卡，
       内容永远是「获取失败」—— 一张永远失败的卡不是信息，是噪音。
       判据用 `Api.provUsable`（与设置页那张卡列哪几家是同一份，见 assetlib.js）。
       真的配了却读不通的那几家仍然会出现、并且照样显示「获取失败」—— 那是真错误，不能藏。 */
    let env = {};
    try { env = (window.Api && Api.envStatus) ? await Api.envStatus() : {}; } catch (e) {}
    const usable = [...map.values()].filter(m => !window.Api || !Api.provUsable || Api.provUsable(m.p, env));
    if (!usable.length) {
      /* 缓存也要一起清掉：这一支直接 return，不清的话 `BAL_KEY` 里那几行会一直留着，
         下次开页面先画缓存、又把它们画回来 —— 「已经不用了」的东西永远消不掉。 */
      try { localStorage.setItem(BAL_KEY, JSON.stringify({ ts: Date.now(), rows: [] })); } catch {}
      balRows = [];
      paintBal(box, [], '还没有在用的平台 —— 填了密钥或添加进来的那几家会出现在这里');
      return;
    }
    const rows = await Promise.all(usable.map(async m => {
      try {
        /* 请求头与余额解析都不在这份里写第二遍：Api.headers 带密钥**和自定义中转地址**
           （少了 x-up-base，设置页换了中转地址就只有侧栏还在打官方地址，读出来的余额对不上），
           Api.balance 按 registry 的 balance.style 解析（wallet-credits / micros）。 */
        const c = await Api.request(m.p, 'credits');
        const b = Api.balance(m.p, c);
        const fmt = v => b.unit ? String(v) : '¥' + Number(v || 0).toFixed(2);
        const avail = fmt(b.available), frozen = fmt(b.frozen), unit = b.unit ? ' ' + b.unit : '';
        return { kid: m.kid, name: m.name, avail, frozen, unit,
          short: String(avail).slice(0, 7) };
      } catch { return { kid: m.kid, name: m.name, avail: '获取失败', failed: true, frozen: '-', unit: '', short: '—' }; }
    }));
    try { localStorage.setItem(BAL_KEY, JSON.stringify({ ts: Date.now(), rows })); } catch {}
    balRows = rows;
    paintBal(box, rows);
  }
  /* 设置页删掉一家自定义平台 → **这一家的余额卡要当场消失**，不等这一轮 60 秒。
     为什么要单独给一个口：refreshBalance 的第一件事是拿 localStorage 里的缓存先画一遍
     （为了切页/刷新时余额立刻可见），被删掉的那家在缓存里还留着，不先剔掉的话，
     删完看着还是「没删掉」，要等下一次真取数才消失。
     顺带把这一家从隐藏名单里也摘掉（清掉一个再也不存在的 kid），
     并让外壳立刻重画 —— 设置页在 iframe 里，靠外壳暴露的这个口（与 __sbApplyTheme 同一套路）。 */
  window.__sbBalanceDrop = (kid) => {
    if (!kid) return;
    try {
      const c = JSON.parse(localStorage.getItem(BAL_KEY) || '{}');
      if (Array.isArray(c.rows)) {
        const rows = c.rows.filter(r => r && r.kid !== kid);
        if (rows.length !== c.rows.length) {
          localStorage.setItem(BAL_KEY, JSON.stringify({ ts: c.ts, rows }));
          balRows = rows;
        }
      }
    } catch (e) {}
    if (window.SbBal) {
      const off = SbBal.off().map(String).filter(k => k !== String(kid));
      if (off.length !== SbBal.off().length) SbBal.setList(off);
    }
    const box = sb.querySelector('#sbBalance');
    if (box && balRows.length) paintBal(box, balRows);
    else refreshBalance();
  };
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
