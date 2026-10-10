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
  /* 正在取数的那张卡：图标位换成一颗小转点（公共 .spin-dot 是 18px，塞进 12px 的图标位会溢出卡面） */
  .sb-bal-card .l1 .ic .spin-dot { display: inline-block; width: 11px; height: 11px; vertical-align: -1px; }
  .sb-bal-card .l2 { margin-top: 3px; font-size: 11px; color: var(--sub); white-space: normal; line-height: 1.5; word-break: break-all; }
  /* 「产物正在存进本机」那一行：侧栏唯一的本机落盘实况。
     为什么必须在这儿而不是只在设置页：自动存本机是**后台**发生的（用户早就不在设置页了），
     而从「点生成」到「字节落盘」要几秒到几十秒 —— 这段时间界面上一个字都没有时，
     用户看到的就是「开了没反应」。侧栏是唯一全程都在的界面（九页都有）。 */
  .sb-mirror { margin-top: 6px; border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; background: var(--panel2); }
  .sb-mirror .l1 { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--txt); font-weight: 600; }
  .sb-mirror .l1 .spin-dot { width: 9px; height: 9px; }
  .sb-mirror .l2 { margin-top: 3px; font-size: 11px; color: var(--sub); line-height: 1.5; }
  .sb-mirror .l2 b { color: var(--txt); }
  /* 下载进度条：一条细轨，跟「正在存 N 份」那行连着读 —— 一眼看出「在下第几个、下到多少」。 */
  .sb-mirror .dlbar{height:3px;border-radius:2px;background:var(--line,#e4e6f0);overflow:hidden;margin-top:5px}
  .sb-mirror .dlbar i{display:block;height:100%;background:var(--acc,#6957e8);border-radius:2px;transition:width .2s}
  .sb-mirror.bad { border-color: var(--warn); }
  .sb-mirror.bad .l2 { color: var(--warn); }
  /* 侧栏折叠时只留一颗小圆点，别把整段文字挤成竖条 */
  html:not(.sb-open) .sb-mirror .l1 .nm, html:not(.sb-open) .sb-mirror .l2 { display: none; }
  html:not(.sb-open) .sb-mirror { padding: 5px 0; text-align: center; }
  .sb-bal-card .l2 b { color: var(--txt); font-weight: 600; }
  /* 余额取不到时那一行（L42）：要说得出「这是失败」，不能和正常的数字长一个样 */
  .sb-bal-card .l2 .balerr { color: var(--err, #dc2626); }
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
    '<div class="sb-group" id="sbBalGroup">账户余额</div>' +
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
  /* 「账户余额」那个分组标题：余额关掉时要跟着藏（那一格里只剩产物进度那一行，
     挂着一句说「账户余额」的标题就是在说错话）。标题本身仍由这段 HTML 出，不另写一份。 */
  const balGroup = sb.querySelector('#sbBalGroup');


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
  /* 缓存里除了余额行，还存着**上一轮要问哪几家**（kids）。
     为什么连这份名单也要留：第一次勾上「左栏显示余额」时本机没有任何缓存，
     而「要问哪几家」得等 /registry + /env-status 回来才知道 —— 那之前整块是空的。
     有了 kids，刚勾上就能按名单先画出一排占位卡（名字对、钱还没到），
     而不是让用户对着空白等到最后「突然冒出来」。老缓存没有 kids，退回单张「正在读取…」也一样不空。 */
  const readBalCache = () => {
    try {
      const c = JSON.parse(localStorage.getItem(BAL_KEY) || '{}');
      return { ts: Number(c.ts) || 0,
        rows: Array.isArray(c.rows) ? c.rows.filter(r => r && r.kid) : [],
        kids: Array.isArray(c.kids) ? c.kids.filter(k => k && k.kid) : [] };
    } catch { return { ts: 0, rows: [], kids: [] }; }
  };
  let balRows = [];      // 最近一次拿到的**全量**余额行：勾选只影响渲染，不影响取数与缓存
  let balKids = [];      // 上一轮**要问哪几家**（[{kid,name}]）：只问出名字时也能先画占位卡
  let balPending = null; // 这一轮正在取的那几家（[{kid,name}]）。null = 还没算到要问谁
  /* 余额行的 name/available 来自上游接口，进 innerHTML 与 title 属性前必须转义
     （这一页是外壳顶层文档，注入等于拿到 localStorage 里的密钥配置）。 */
  const escA = v => window.esc(v);
  const balCardHTML = r => {
    /* 正在取的那几家：先画一张占位卡。名字已经知道了，钱还没到。
       以前这里是「等 N 个请求全回来才一起画」，于是慢的那一家把快的那一家一起拖住，
       界面上从头到尾一张卡都没有，最后「突然冒出来」N 张 ——
       与「一直显示着、一家一家填上」是两回事（后者还顺便说明了到底在问哪几家）。 */
    if (r.pending) {
      return `<div class="sb-bal-card" data-kid="${escA(r.kid)}" data-short="…" title="${escA(r.name)}：正在查询…">
        <div class="l1"><span class="ic"><span class="spin-dot"></span></span><span class="nm">${escA(r.name)}</span></div>
        <div class="l2">正在读取…</div></div>`;
    }
    const avail = escA(r.avail), frozen = escA(r.frozen), unit = escA(r.unit);
    /* 失败那一行把原因放进 title（L42）：卡面上一行放不下「HTTP 401：密钥无效或过期」，
       但「为什么失败」正是这张卡唯一有用的信息 —— 藏掉它就等于只报结果不报因。
       正常行照旧：可用 / 冻结。 */
    const tip = r.failed
      ? `${escA(r.name)}：${escA(r.why || r.avail)}`
      : `${escA(r.name)}：可用 ${avail}${unit} · 冻结 ${frozen}${unit}`;
    return `<div class="sb-bal-card" data-kid="${escA(r.kid)}" data-short="${escA(r.short)}" title="${tip}">
       <div class="l1"><span class="ic">${svgIc('coin', 13)}</span><span class="nm">${escA(r.name)}</span></div>
       <div class="l2">${r.failed
        ? '<span class="balerr">获取失败（鼠标停一下看原因）</span>'
        : '可用 <b>' + avail + '</b>' + unit + ' · 冻结 <b>' + frozen + '</b>' + unit}</div>
     </div>`;
  };
  /* 这一轮要显示的那几张卡：**已有数的用旧值，还在路上的一律给占位卡**。
     顺序按「要问哪几家」来（balKids / balPending），所以某一家先回来时它就地变成数字，
     不会把后面的卡挤来挤去；缓存里有、这一轮没问的（刚被取消勾选之类）按原顺序补在后面。
     过滤仍走 SbBal.filter —— 勾选名单只有那一份实现（§J），这里不自己判。 */
  function balList() {
    const byKid = new Map(balRows.map(r => [String(r.kid), r]));
    const names = new Map();
    for (const m of (balKids || [])) names.set(String(m.kid), m.name);
    for (const m of (balPending || [])) names.set(String(m.kid), m.name);
    const keys = [];
    for (const k of names.keys()) keys.push(k);
    for (const r of balRows) if (keys.indexOf(String(r.kid)) < 0) keys.push(String(r.kid));
    const list = keys.map(k => byKid.get(k)
      || { kid: k, name: names.get(k) || k, pending: true });
    return window.SbBal ? SbBal.filter(list) : list;
  }
  /* 一家回来就换掉它那一张卡（不整块重画）：整块重画会把用户正在看的其他卡也抖一遍，
     而这一轮可能还有几家在路上。找不到那张卡（还没画 / 已经被整块重画掉了）才退回整块。 */
  function upsertBal(row) {
    const i = balRows.findIndex(r => r && String(r.kid) === String(row.kid));
    if (i >= 0) balRows[i] = row; else balRows.push(row);
    const box = sb.querySelector('#sbBalance');
    if (!box) return;
    const old = [...box.querySelectorAll('.sb-bal-card')].find(c => String(c.dataset.kid) === String(row.kid));
    if (!old) { paintBal(box); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = balCardHTML(row);
    old.replaceWith(tmp.firstElementChild);
  }
  /* 「余额那一块显示不显示」只有这一份判据（设置页勾的那颗，写在别的键上）：
     paintBal 画不画卡片、`__sbApplyBalance` 要不要去取数，两处都问它 ——
     各写一遍 `AssetLocal.sbBalOn && !AssetLocal.sbBalOn()` 就是两条会走岔的判据。 */
  const balOn = () => !(window.AssetLocal && AssetLocal.sbBalOn && !AssetLocal.sbBalOn());
  function paintBal(box, note) {
    const mirror = mirrorBarHTML();   // 产物进度那一行**与余额开关无关**（见下面那两段）
    /* 整个余额区关掉（设置页勾）：**余额卡片不画**。
       以前只有「按平台勾选」，没有「一块都不要」这一档 ——
       于是用户只能把每一家都取消勾，而「刷新余额」那颗按钮还留在那儿点不动。
       ⚠ 这里早退的是**余额卡片**，不是整个盒子：「左栏显示本机产物」是另一个独立的开关，
       而那一行以前就塞在余额区里，于是「关掉余额」会顺手把「显示本机产物」也一起关掉
       （两个开关共用一个容器，这一句 return 之后 mirrorBarHTML 根本没机会跑）。
       它自带标题（产物存本机），所以余额关掉时连分组标题也一起藏掉，不留一句说错的「账户余额」。 */
    if (!balOn()) {
      box.innerHTML = mirror ? '<div class="sb-bal">' + mirror + '</div>' : '';
      if (balGroup) balGroup.hidden = true;
      mountMirrorBar(box);
      return;
    }
    if (balGroup) balGroup.hidden = false;
    const shown = balList();
    /* 一张卡都画不出来时的三种说法：正在读 / 接口读不到 / 平台压根没有余额接口 / 全被勾掉了。
       「正在读取…」这一档是这次加的：没取到数的那一小段时间里，
       界面上必须有一行字说明「它在动」，不能是一整块空白。 */
    const body = shown.length ? shown.map(balCardHTML).join('')
      : '<div class="sb-bal-card"><div class="l1"><span class="ic">' + svgIc('coin', 13) + '</span><span class="nm">余额</span></div>'
        + '<div class="l2">' + escA(note || (balRows.length ? '要显示哪些接口在「设置 → 平台密钥与余额」里勾' : '正在读取…')) + '</div></div>';
    box.innerHTML = '<div class="sb-bal">' + body
      + '<div class="sb-bal-refresh" title="刷新余额"><span class="ic">' + svgIc('refresh', 13) + '</span><span>刷新余额</span></div></div>'
      + mirror;
    box.querySelector('.sb-bal-refresh').onclick = () => refreshBalance();
    mountMirrorBar(box);
  }
  /* ---------- 「产物正在存进本机」这一行 ----------
     读数一律来自 AssetLocal.info（assetlib.js 那一份判据），侧栏不自己数。
     关闭时**不画** —— 开关关着就没有在途，挂着一条「已存 N 个」只是占地方；
     有在途 / 失败过 / 开着开关时才画，用户随时看得到「它到底在不在干活」。 */
  function mirrorBarHTML(st) {
    /* 这一块要能单独关掉（设置页勾）：侧栏是**全局**的，一个不需要看它的人
       （比如只用生成工作台、从不进资产库）不该被它占掉三行。 */
    if (window.AssetLocal && AssetLocal.sbMirrorOn && !AssetLocal.sbMirrorOn()) return '';
    const s2 = st || (window.AssetLocal && AssetLocal.info ? AssetLocal.info() : null);
    if (!s2 || !s2.on) return '';
    const busy = s2.inFlight > 0;
    const bad = !busy && s2.lastErr;
    const sizeOf = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB'
      : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
    /* 在途时把「正在下这一份」摆出来：只有「正在存 N 份」的话，
       一个 200MB 的视频从 0% 到 100% 在界面上长得一模一样，人只能干等
       （「自动存本机看起来没反应」剩下的那一半 —— 另一半是根本不知道它在跑）。
       百分比来自 AssetLocal.info（它读的是响应头里的总量与已发送字节）。
       **拿不到总量就不摆条**（只显示「正在下这一份…」）：拿 0 当分母算出来的进度是假的。 */
    let dl = '';
    if (busy && s2.dlTotal > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((s2.dlSent || 0) * 100 / s2.dlTotal)));
      dl = '<div class="dlbar" title="' + escA(String(s2.dlName || '')) + '"><i style="width:' + pct + '%"></i></div>'
        + '<div class="l2" style="margin-top:3px">正在下这一份 <b>' + pct + '%</b>'
        + (s2.dlName ? '（' + escA(String(s2.dlName).slice(0, 18)) + '）' : '')
        + ' · 已 ' + sizeOf(s2.dlSent || 0) + ' / ' + sizeOf(s2.dlTotal) + '</div>';
    } else if (busy && s2.dlName) {
      dl = '<div class="l2" style="margin-top:3px">正在下这一份…（' + escA(String(s2.dlName).slice(0, 18)) + '）</div>';
    }
    const l2 = busy
      ? '正在存 <b>' + s2.inFlight + '</b> 份（产物完成后自动开始）'
      : (bad ? escA(s2.lastErr)
        : '本机已存 <b>' + s2.count + '</b> 份 · ' + sizeOf(s2.bytes)
          + (s2.fail ? ' · 累计没存成 ' + s2.fail + ' 份' : ''));
    return '<div class="sb-mirror' + (bad ? ' bad' : '') + '"'
      + (busy ? ' title="产物自动存本机正在跑，字节落盘之后这里会变成本机已存 N 份"' : '')
      + (bad ? ' title="最后一次没存成：' + escA(s2.lastErr) + '（下一轮列表刷新时会再试一次）"' : '')
      + '><div class="l1"><span class="ic">'
      + (busy ? '<span class="spin-dot"></span>' : svgIc('download', 13))
      + '</span><span class="nm">产物存本机</span></div>'
      + '<div class="l2">' + l2 + '</div>' + dl + '</div>';
  }
  /* 订阅一次就够：AssetLocal.onInfo 每次落盘事件都推一遍，这里只改那一行。
     没有这一层的话「正在存 N 份」永远停在 0 —— 而那正是用户判断开关有没有生效的那句话。
     注意 paintBal 会整块换掉 innerHTML（余额刷新时会发生），换掉的新块**已经带了这一行**
     （paintBal 里拼了 mirrorBarHTML()），所以订阅回调里找不到旧节点就insert 一个；
     回调本身不用管「节点被换掉了」—— 那是 paintBal 的事。
     ⚠ 回调**不要用 onInfo 递过来的那个参数**：那是 assetlib.js 内部的 INFOS，
     它没有 `on` 字段（`on: saveOn()` 只在 info() 的返回值里补），
     而 mirrorBarHTML 第一句就是 `if (!s2.on) return ''` ——
     以前这里传的是 `st`，于是**每一条落盘事件都算成「没有这一行」把它删掉**：
     界面上表现为「开了显示本机产物，一有东西要存那一行就没了」，
     下载中更是全程不显示（paintBal 画出来的那一份被第一个事件抹掉）。
     要读数就现问 AssetLocal.info()（同一份判据，且带 on）。 */
  let mirrorUnsub = null;
  function mountMirrorBar(box) {
    const A = window.AssetLocal;
    if (!A || !A.onInfo || mirrorUnsub) return;
    mirrorUnsub = A.onInfo(() => {
      const b2 = sb.querySelector('#sbBalance');
      if (!b2) return;
      const old = b2.querySelector('.sb-mirror');
      const want = mirrorBarHTML();
      if (!want) { if (old) old.remove(); return; }
      if (old) { const tmp = document.createElement('div'); tmp.innerHTML = want; old.replaceWith(tmp.firstElementChild); }
      /* 「往哪儿插」要找 `.sb-bal`；两块都关着时盒子里是空的（那种情况 want 必然也是空，
         上面已经 return 了）—— 但仍判一下，别让一个 null 抛在订阅回调里被静默吞掉。 */
      else { const host = b2.querySelector('.sb-bal'); if (host) host.insertAdjacentHTML('beforeend', want); }
    });
  }
  /* 单取一家：请求头与余额解析都不在这份里写第二遍 ——
     Api.headers 带密钥**和自定义中转地址**（少了 x-up-base，设置页换了中转地址就只有侧栏还在打官方地址，
     读出来的余额对不上），Api.balance 按 registry 的 balance.style 解析（wallet-credits / micros）。 */
  async function balRowOf(m) {
    try {
      const c = await Api.request(m.p, 'credits');
      const b = Api.balance(m.p, c);
      const fmt = v => b.unit ? String(v) : '¥' + Number(v || 0).toFixed(2);
      const avail = fmt(b.available), frozen = fmt(b.frozen), unit = b.unit ? ' ' + b.unit : '';
      return { kid: m.kid, name: m.name, avail, frozen, unit,
        short: String(avail).slice(0, 7) };
    } catch (e) {
      /* 失败原因要跟着行一起走（L42）。以前整个 throw 被吞掉，只剩「获取失败」四个字 ——
         密钥过期 / 代理没起来 / 平台限流在这张卡上长得一模一样，而同一个错在用量页
         能读到「查询失败：HTTP 401：密钥无效或过期」。侧栏把原因挂到 title 上，
         卡面只留一句短的（不然一行小字塞不下）。 */
      return { kid: m.kid, name: m.name, avail: '获取失败', failed: true,
        why: '查询失败：' + ((e && e.message) || e || '未知原因'), frozen: '-', unit: '', short: '—' };
    }
  }
  async function refreshBalance() {
    const box = sb.querySelector('#sbBalance');
    if (!box) return;
    /* **先画一次再发请求**：切页/刷新时余额立刻可见（缓存），第一次勾上开关时也不会空着
       （缓存里没有就画「正在读取…」，有 kids 就按名单画一排占位卡）。
       以前这一支是「有缓存才画」，于是刚勾上开关的那一次：盒子空着 → 等 N 个请求全回来 →
       N 张卡一起冒出来。用户看到的就是「开了没反应，然后突然全出来了」。 */
    const cached = readBalCache();
    if (cached.rows.length) balRows = cached.rows;
    if (cached.kids.length) balKids = cached.kids;
    balPending = null;
    paintBal(box, balRows.length ? '' : '正在读取…');
    let reg;
    // 注册表统一走 Api.registry（带 60 秒缓存，和其它页面共用一份）；只有 assetlib 没加载时才现取
    try { reg = (window.Api && Api.registry) ? await Api.registry() : await (await fetch('/registry')).json(); }
    catch { if (!cached.rows.length) paintBal(box, '余额读取失败'); return; }
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
      balKids = [];
      paintBal(box, '这些平台没有余额接口');
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
      try { localStorage.setItem(BAL_KEY, JSON.stringify({ ts: Date.now(), rows: [], kids: [] })); } catch {}
      balRows = []; balKids = [];
      paintBal(box, '还没有在用的平台 —— 填了密钥或添加进来的那几家会出现在这里');
      return;
    }
    /* 用户把这几家**全取消勾选**了 → 取数阶段就短路（U2）：以前 `SbBal.filter` 只在
       paintBal 里过滤**渲染**，取数照跑，于是「设置里全不勾」照样每分钟去取它们的钱。
       这里复用同一份 filter（§J「同一功能只有一份实现」），不新写一份判据。
       全被藏起来时**保留缓存**（勾回来立刻有数），只画一张占位、一个请求都不发。 */
    const wanted = window.SbBal ? SbBal.filter(usable) : usable;
    if (!wanted.length) {
      paintBal(box, '这几家都被你在「设置 → 平台密钥与余额」里藏起来了');
      return;
    }
    /* 算出要问哪几家之后**先画占位卡**，再发请求；哪一家先回来就换掉它那一张。
       以前是 `await Promise.all(全部)` 之后才 paintBal 一次：慢的那一家能把快的那一家一起拖住，
       界面上从头到尾一张卡都没有，直到最后一起冒出来。 */
    balKids = wanted.map(m => ({ kid: m.kid, name: m.name }));
    balPending = balKids.slice();
    paintBal(box);
    const rows = await Promise.all(wanted.map(async m => {
      const row = await balRowOf(m);
      balPending = (balPending || []).filter(p => String(p.kid) !== String(m.kid));
      upsertBal(row);      // 就地填这一张：别的卡不动，用户正在看的那几家不抖
      return row;
    }));
    balPending = null;
    try { localStorage.setItem(BAL_KEY, JSON.stringify({ ts: Date.now(), rows, kids: balKids })); } catch {}
    balRows = rows;
    paintBal(box);
  }
  /* 设置页删掉一家自定义平台 → **这一家的余额卡要当场消失**，不等这一轮 60 秒。
     为什么要单独给一个口：refreshBalance 的第一件事是拿 localStorage 里的缓存先画一遍
     （为了切页/刷新时余额立刻可见），被删掉的那家在缓存里还留着，不先剔掉的话，
     删完看着还是「没删掉」，要等下一次真取数才消失。
     顺带把这一家从隐藏名单里也摘掉（清掉一个再也不存在的 kid），
     并让外壳立刻重画 —— 设置页在 iframe 里，靠外壳暴露的这个口（与 __sbApplyTheme 同一套路）。 */
  /* 「这两块显示不显示」被设置页改了之后，外壳立刻重画。
     设置页在 iframe 里，它写的是别人的键（sb_bal_on / sb_mirror_on）——
     所以要么它自己拼一遍余额卡与产物行（那就是第二份实现），
     要么由这里挂一个口出来（与 __sbApplyTheme / __sbApplyOpen 同一套路）。挂口。
     `paintBal` 开头会自己判「余额区关没关」，本机产物那块在 `mirrorBarHTML` 里判 ——
     所以这个口只是「重新读一次键、画一次」，不含任何规则。 */
  window.__sbApplyBalance = () => {
    try {
      const box = sb.querySelector('#sbBalance');
      if (box) paintBal(box, balRows.length ? '' : '正在读取…');
      /* 本机产物那块的订阅已经挂过一次（mountMirrorBar 会记住），
         这里主动补画一次：开关从关到开时那一块原本不在文档里，得重新插入。 */
      const b2 = sb.querySelector('#sbBalance');
      if (b2) {
        const cur = mirrorBarHTML(), host = b2.querySelector('.sb-bal');
        if (cur && host && !b2.querySelector('.sb-mirror')) host.insertAdjacentHTML('beforeend', cur);
      }
      /* 刚在设置页勾上「左栏显示余额」而本机一份数都没有 → 现在去取，别让那块地方
         一直停在占位上（那正是用户说的「等它刷出来」，勾开关本来就是为了现在就要看见）。
         缓存还热（60 秒内刚取过）就不白跑一遍 —— 改勾选、改「存哪一档」走的是重画，不是重新取数。 */
      const ts = readBalCache().ts;
      if (balOn() && Date.now() - ts > 60000) refreshBalance();
    } catch (e) {}
  };

  window.__sbBalanceDrop = (kid) => {
    if (!kid) return;
    try {
      const c = JSON.parse(localStorage.getItem(BAL_KEY) || '{}');
      if (Array.isArray(c.rows)) {
        const rows = c.rows.filter(r => r && r.kid !== kid);
        if (rows.length !== c.rows.length) {
          /* kids（占位卡名单）也要一起写回：整份换掉时漏了它，
             下一次打开左栏就退回「一张泛泛的正在读取…」，而这一家明明在名单里。 */
          localStorage.setItem(BAL_KEY, JSON.stringify({ ts: c.ts,
            rows, kids: (c.kids || []).filter(k => k && String(k.kid) !== String(kid)) }));
          balRows = rows;
        }
      }
    } catch (e) {}
    balKids = balKids.filter(k => String(k.kid) !== String(kid));
    if (balPending) balPending = balPending.filter(k => String(k.kid) !== String(kid));
    if (window.SbBal) {
      const off = SbBal.off().map(String).filter(k => k !== String(kid));
      if (off.length !== SbBal.off().length) SbBal.setList(off);
    }
    const box = sb.querySelector('#sbBalance');
    if (box && balRows.length) paintBal(box);
    else refreshBalance();
  };
  /* 设置页在 iframe 里改勾选 → 同源的 storage 事件送到外壳：直接按缓存重画，不用重取余额 */
  window.addEventListener('storage', e => {
    if (!window.SbBal || e.key !== SbBal.KEY) return;
    const box = sb.querySelector('#sbBalance');
    if (box && balRows.length) paintBal(box);
  });
  window.addEventListener('sb-balance-refresh', refreshBalance);
  refreshBalance();
  /* 定时器跑在外壳顶层文档，是全会话里活得最久的一个（app.js 切页只换 frame.src、外壳不重建），
     所以它必须自己会「停」：
       · 后台标签页里一轮都不发（U2）—— 不看 document.hidden 的话，切走一小时就是 60 轮 × (1+N) 个请求；
       · 间隔从 60 s 提到 120 s（= REG_TTL 的两倍）：以前两者都正好是 60,000 ms，而判据用的是
         **严格大于**（`now - _regTs > REG_TTL`），上一轮取数到下一轮 tick 之间必然多出一点抖动，
         于是注册表缓存的命中率恒为 0 —— 每分钟稳定发一次 /registry + /env-status + N × credits。
         留出一倍余量，缓存才真的被用上（见性能优化文档「轮询间隔与缓存 TTL 撞车」）。 */
  const balanceTick = () => { if (!document.hidden) refreshBalance(); };
  setInterval(balanceTick, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBalance(); });
  // 挂载放最后：head 里加载时 body 还不存在，而且上面的状态常量要先生效完
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
