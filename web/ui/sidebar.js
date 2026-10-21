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

  /* 侧栏样式已抽到 web/styles/sidebar.css（由 shell.html 以 <link> 引入），这里不再运行时注入 CSS。 */
  /* 页面清单只有一份，在 web/core/routes.js（SPA 路由与侧栏读同一张表）。 */
  const allPages = (window.WB_ROUTES && window.WB_ROUTES.pages) || [];
  const items = allPages.filter(p => p.nav !== false);
  const svgIc = (n, s) => (window.icon ? window.icon(n, s || 18) : '');
  /* 只在外壳里渲染：链接就是外壳的 hash，点击交给 web/app.js 换页面（侧栏不重建）；
     当前高亮不在这里判断，由外壳在切页后统一回填 __sbSetActive。 */
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

  /* 点导航：不跳转整页，只让 web/app.js 切内容页（侧栏保持不动）；
     窄窗口里侧栏是浮层，选完就自动收回，否则内容一直被盖着一块。 */
  /* ---------- 收起态：鼠标停上去把名字弹出来 ----------
     66px 的带子里 .lb 是 display:none，六个页面只剩图标（影片 / 人物 / 星芒 / 星标 / 方块 / 图表），
     光看形状分不出哪个是哪个 —— 用户只能挨个点一遍试。「左栏收起后好多功能用不了」说的就是这个：
     功能还在，但**认不出来**。
     所以这里补一块浮标：只在收起态出现（展开态文字本来就在旁边），跟鼠标进出显示 / 隐藏，
     位置在目标右边、出屏就翻到左边并按视口夹一次（窄窗口里侧栏是浮层，弹到屏幕外等于没有）。
     用 **fixed 挂 body** 而不是写进侧栏：`.sidebar nav` 是 overflow-x:hidden，写在里面的提示会被裁掉
     —— 与下拉浮层（Dropdowns 挂 body + fixed）同一条理由。
     同时给每个目标写上 aria-label：浮标是给眼睛的，读屏那条路得另有名字。 */
  const sbTip = (() => {
    let el = null;
    const box = () => {
      if (el && el.isConnected) return el;
      el = document.createElement('div');
      el.className = 'sb-tip';
      el.hidden = true;
      document.body.appendChild(el);
      return el;
    };
    return {
      show(target, text) {
        if (wantOpen() || !text) return;
        const t = box();
        t.textContent = text;
        t.hidden = false;
        const r = target.getBoundingClientRect();
        const w = t.offsetWidth || 0, h = t.offsetHeight || 0;
        let x = r.right + 8;
        if (x + w > window.innerWidth - 6) x = Math.max(6, r.left - w - 8);
        const y = Math.max(6, Math.min(r.top + (r.height - h) / 2, window.innerHeight - h - 6));
        t.style.left = x + 'px';
        t.style.top = y + 'px';
      },
      hide() { if (el) el.hidden = true; },
      on(target, text) {
        if (!target) return;
        target.setAttribute('aria-label', text);
        target.addEventListener('mouseenter', () => this.show(target, text));
        target.addEventListener('mouseleave', () => this.hide());
        target.addEventListener('focus', () => this.show(target, text));       // 键盘 Tab 也认得出
        target.addEventListener('blur', () => this.hide());
        target.addEventListener('click', () => this.hide());
      },
    };
  })();
  /* 侧栏里滚一下、窗口尺寸一变，浮标的位置就不对了：宁可收掉，也别让它飘在错的格子上 */
  window.addEventListener('scroll', () => sbTip.hide(), true);
  window.addEventListener('resize', () => sbTip.hide());

  sb.querySelectorAll('a[data-page]').forEach(a => {
    /* 名字从**可见的那个 span** 里取，不另存一份文案：那份 `.lb` 就是展开态显示的那一句，
       两处各写一个字符串迟早一处改了另一处没改（浮标写着「资产库」、侧栏里写着「素材库」）。 */
    const lb = a.querySelector('.lb');
    sbTip.on(a, (lb && lb.textContent) || a.dataset.page || '');
    a.onclick = e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // 允许新标签打开
      e.preventDefault();
      if (typeof window.appShow === 'function') window.appShow(a.dataset.page, true);
      if (narrow() && wantOpen()) close();
    };
  });
  /* web/app.js 切页后回填高亮（侧栏不重建，只改 class） */
  window.__sbSetActive = file => {
    sb.querySelectorAll('a[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === file));
    if (setLink) setLink.classList.toggle('active', file === 'settings.html');
  };
  sbTip.on(sb.querySelector('#sbTheme'), '换背景（亮 / 暗）');
  const setLink = sb.querySelector('a.sb-set[data-page="settings.html"]');
  sbTip.on(setLink, '设置');
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
  const wantOpen = () => window.LS.get('sb_open') === '1';
  /* 收起 ↔ 展开这一刻要重画余额区：摘要行写不写「存 N/M」、它排在区域头还是区域尾，
     取决于 balCap0 那一档（见下面 paintBal）—— 而 balCap0 只在展开态成立。
     sbOpenLast 只记「上一次画的是哪一态」，同一态里反复 resize 不重画。
     首画由 refreshBalance 负责，所以 prev === null（第一次 apply）时不补这一刀；
     顺带也避开「在 let 声明之前就读余额那几个变量」。 */
  let sbOpenLast = null;
  function repaintBal() {
    const box = sb.querySelector('#sbBalance');
    if (box && balShown !== null) paintBal(box, balRows.length ? '' : '正在读取…');
  }
  function apply() {
    const o = wantOpen();
    const n = narrow();
    const r = document.documentElement.classList;
    r.toggle('sb-narrow', n);
    r.toggle('sb-open', o);
    const prev = sbOpenLast;
    sbOpenLast = o;
    if (prev !== o && prev !== null) setTimeout(repaintBal, 0);
    sbTip.hide();          // 展开 ↔ 收起的瞬间把浮标收掉：留着会停在刚变过宽度的位置上
    document.documentElement.style.setProperty('--sbw', (o && !n) ? OPEN_W + 'px' : '66px');
    /* 收起 ↔ 展开改的是左边那一条带的宽度，而悬浮球只有 z=56、侧栏 90 —— 球停在被让出/占掉的那一条里
       就点不到了（等于把助手弄丢）。发一个通知，ai-chat.js 监听后按新的 --sbw 重新摆一次。
       放在 apply() 末尾：点 logo、启动、窗口 resize 三条路径都走这里，不用在每处各发一遍。 */
    window.dispatchEvent(new CustomEvent('sb:toggle'));
  }
  /* 侧栏里有几处「看着是按钮、其实是 span/div」：鼠标能点，键盘 Tab 不到、Enter 也不动。
     与其把它们换成 <button>（会带进 UA 样式、把侧栏那一排对齐重排一遍），
     就地补 role/tabIndex 与 Enter/Space —— 焦点样式走 ui.css 末尾那份全站兜底。 */
  const asButton = (el, fn) => {
    if (!el) return;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.onclick = fn;
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } };
  };
  const setWant = v => { window.LS.set('sb_open', v ? '1' : '0'); apply(); };
  const close = () => setWant(false);
  // 折叠 / 展开：只保留左上角 AI 头像方块（点它切换），原来的箭头按钮已移除
  const toggle = () => setWant(!wantOpen());
  const logo = sb.querySelector('.sb-logo');
  asButton(logo, e => { e.stopPropagation(); toggle(); });
  if (logo) logo.title = '点击收起 / 展开侧边栏';
  const brand = sb.querySelector('.sb-brand');
  asButton(brand, toggle);
  if (brand) brand.title = '点击收起 / 展开侧边栏';
  // 换背景（亮 / 暗主题）：全站统一放在左下角
  const themeBtn = sb.querySelector('#sbTheme');
  const themeIcon = dark => svgIc(dark ? 'sun' : 'moon');
  /* 外壳里别处改了主题（AI 助手的 set_setting）也走这一条：换 data-theme + 同步 iframe + 补图标。
     图标只有这里知道怎么画，别处再拼一份 svg 就是第二份实现。 */
  window.__sbApplyTheme = t => {
    document.documentElement.dataset.theme = t;
    try { if (themeBtn) themeBtn.querySelector('.ic').innerHTML = themeIcon(t === 'dark'); } catch (e) {}
    /* 常驻页面池里每一份都是独立文档，主题要一起换 —— 只换当前那一份，
       切回别的页就是另一个配色。迁移到 Vue 的页面在同一文档里，CSS 变量自动生效。 */
    document.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument) f.contentDocument.documentElement.dataset.theme = t; } catch (e) {}
    });
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
  /* 窄窗口里展开 = 浮层盖在内容上。点内容区要能把它收回去，但内容页的点击不冒泡到外壳，
     所以由外壳在文档上挂监听（见 web/app.js 的 CLOSE_OVERLAY）。
     这里只负责「收到就收」这一半，顺带保证宽窗口下点了内容区**不会**误关（宽窗口是真让位，不是浮层）。 */
  window.__sbCloseOverlay = () => { if (narrow() && wantOpen()) close(); };

  /* ---------- 账户余额（按 API 分类显示，路由驱动；显示哪几个接口由设置页勾选） ---------- */
  const BAL_KEY = 'sb_bal_cache';
  /* 「这一档摆不下」的出路是**就地展开**，不是把人往用量页送（展开态只有卡列表那一格会滚，
     导航与本机产物行都不跟着滚）。展开是显示偏好，与 sb_open 同一类，落 localStorage。 */
  const EXP_KEY = 'sb_bal_exp';
  const balExpOn = () => window.LS.get(EXP_KEY) === '1';
  const setBalExp = v => { window.LS.set(EXP_KEY, v ? '1' : '0'); };
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
     （这一页是外壳顶层文档，注入等于拿到 localStorage 里的密钥配置）。
     A3：一张卡固定三行 —— 名字一行、金额一行、状态一行，每行单行不换行、超长省略号、全文在 title。
     以前「可用 X · 冻结 Y」挤在一行还写 `word-break: break-all`，长数字把同一排的卡撑成三种高度。 */
  const balCardHTML = r => {
    /* 正在取的那几家：先画一张占位卡。名字已经知道了，钱还没到。
       以前这里是「等 N 个请求全回来才一起画」，于是慢的那一家把快的那一家一起拖住，
       界面上从头到尾一张卡都没有，最后「突然冒出来」N 张 ——
       与「一直显示着、一家一家填上」是两回事（后者还顺便说明了到底在问哪几家）。 */
    if (r.pending) {
      return `<div class="sb-bal-card" data-kid="${window.esc(r.kid)}" title="${window.esc(r.name)}：正在查询…">
        <div class="l1"><span class="ic"><span class="spin-dot"></span></span><span class="nm">${window.esc(r.name)}</span></div>
        <div class="l2">—</div>
        <div class="l3">正在读取…</div></div>`;
    }
    const avail = window.esc(r.avail), frozen = window.esc(r.frozen), unit = window.esc(r.unit);
    /* 失败那一行把原因摆到卡面上（L42）：以前只留「获取失败」四个字、原因藏进 title，
       而「为什么失败」正是这张卡唯一有用的信息 —— 现在状态那一行直接写原因（放不下才省略，
       title 里仍是全文）。正常行：金额一行、冻结一行。 */
    const tip = r.failed
      ? `${window.esc(r.name)}：${window.esc(r.why || r.avail)}`
      : `${window.esc(r.name)}：可用 ${avail}${unit} · 冻结 ${frozen}${unit}`;
    return `<div class="sb-bal-card" data-kid="${window.esc(r.kid)}" title="${tip}">
       <div class="l1"><span class="ic">${svgIc('coin', 13)}</span><span class="nm">${window.esc(r.name)}</span></div>
       <div class="l2">${r.failed ? '—' : '可用 <b>' + avail + '</b>' + unit}</div>
       <div class="l3">${r.failed
        ? '<span class="balerr">' + window.esc(String(r.why || '获取失败')) + '</span>'
        : ('冻结 <b>' + frozen + '</b>' + unit)}</div></div>`;
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
  /* ---------- 区域摆几张卡（A1② + A2「导航优先，余额区定高」）----------
     默认态容器不再有 max-height 与内滚动，所以「定高」只能靠**内容条数**：本机产物一行
     + 最多 3 张卡 + 一行按钮（展开/收起与刷新同一行）。档位的分界线全按 .tmp 探针实测出来的
     高度算的（不是拍的数）：
     六家全开 + 传输中时，区域自己占 437（三张）/ 365（两张）/ 293（一张）/ 221（不摆卡），
     而同一列里固定的那一坨（brand 56 + 两条分组标题 54 + 底部两块 94 = 204）和导航的自然高 298
     都得先留着 —— 437 + 204 + 298 = 939，所以三张卡要 966 的高才不挤导航（第一档）。
     ≤780 那一档 CSS 把行高整列压过一轮（固定块 188、导航 270、一张卡 74、不摆卡 190），
     所以 720..780 之间还能摆一张；再往下 661..719 一张都塞不进 —— 不摆卡，
     只留「本机行 + 一行按钮」，传输状态照旧摆最上面（A1①）。
     ≤660（文档点名的 640 那一档，实测要到 660 才真放得下摘要行）：整区退成一行摘要（A1③），
     点开弹层看全量，不堆卡。
     ⚠ 这一批数是**两排按钮**那时代测的；按钮收成一行后每档多出约一行的高度，
       所以这几条线由 `tests/e2e/sidebar-balance.cjs` 的高度扫描现管（摆出来的卡数与导航是否
       被裁都当场判），改表之前先跑它。
     ⚠ 尺寸判据只有两处：CSS 的 media query 与下面这张表，读的是同一批数。
     ⚠ 显示哪几张按「有金额 → 还在取 → 取失败」排（失败的卡不是信息，是噪音），
       但**渲染顺序仍按 balList 那一份**：一家回来就地换掉它自己那张，不重排别的卡。 */
  const BAL_CAPS = [
    ['(min-height: 966px)', 3],
    ['(min-height: 894px)', 2],
    ['(min-height: 822px)', 1],
    /* ≤780 那一档 CSS 把行高整列压过一轮（导航 270、固定块 188、卡 68），
       所以 720..780 之间一张卡又塞得下了 —— 这一条是同一个实测结论的另一半。 */
    ['(min-height: 720px) and (max-height: 780px)', 1],
  ];
  const balCap = () => {
    if (!window.matchMedia) return 3;
    for (const [q, n] of BAL_CAPS) if (matchMedia(q).matches) return n;
    return 0;   // 661..719：不摆卡；≤660 由 CSS 收成摘要行
  };
  const balCapNote = n => (n > 0 ? '左栏只摆前 ' + n + ' 家' : '左栏这一档放不下余额卡');
  const balRankOf = r => (r.pending ? 1 : (r.failed ? 2 : 0));
  function balSplit(shown) {
    /* 展开态：整份名单都摆出来（这一格自己滚，见 sidebar.css 的 `.bal-exp` 那一段）。 */
    if (balExpOn()) return { head: shown, extra: 0 };
    const keys = shown.slice().sort((a, b) => balRankOf(a) - balRankOf(b)).slice(0, balCap())
      .map(r => String(r.kid));
    const head = shown.filter(r => keys.indexOf(String(r.kid)) >= 0);
    return { head, extra: shown.length - head.length };
  }
  /* 摘要行要的两个数：余额几家 / 还有几家没摆出来。由 paintBal 现填，
     落盘事件重画摘要时不必再问一次 balList（数据没变，只有本机的数在变）。
     balShown = null 表示「余额那一整块被设置页关掉了」，摘要只报本机那一段、也不可点开。 */
  let balShown = null, balExtra = 0, mirrorInfo = null;
  /* balCap0：展开态里一张卡都摆不下（BAL_CAPS 落到 0 的那一带，661..821px）。
     这一带摘要行也得露出来 —— 它是「点开看全量」唯一的入口；但它只报余额家数，
     「存本机」那一段藏掉：区域没收，本机那一行就在它底下摆着，同一件事不写两遍。 */
  let balCap0 = false;
  /* 本机那一段的读数：**只读 mirrorBarHTML() 刚问过的那一份**（AssetLocal.info 的调用点不加，
     判据仍只有 local.js 一处），所以 paintBal 里必须先算 mirror 再算摘要。 */
  function balSto() {
    const s = mirrorInfo;
    if (!s) return null;
    const busy = s.inFlight > 0;
    return {
      busy,
      txt: busy ? (s.inFlight + '/' + s.count) : String(s.count),
      tip: busy ? ('正在存 ' + s.inFlight + ' 份 / 本机已存 ' + s.count + ' 份')
        : ('本机已存 ' + s.count + ' 份 · ' + (window.fmtBytes(s.bytes) || '0 KB')),
    };
  }
  /* A1③：一行摘要 ——「余额 3 家 · 存 2/5」。展开但窗口矮时还能带单位与「点开」，
     收起态（66px）只留「图标 + 数字」，单位与说明文字由 CSS 藏掉。 */
  function balSumHTML() {
    const sto = balCap0 ? null : balSto();
    const segs = [];
    if (balShown !== null) {
      segs.push('<span class="p' + (balShown ? '' : ' dim') + '"><span class="ic">' + svgIc('coin', 11)
        + '</span><b>' + balShown + '</b><span class="u">家余额</span></span>');
    }
    if (sto) {
      segs.push('<span class="p sto' + (sto.busy ? ' busy' : '') + '"><span class="ic">'
        + (sto.busy ? '<span class="spin-dot"></span>' : svgIc('download', 11))
        + '</span><b>' + sto.txt + '</b><span class="u">存本机</span></span>');
    }
    if (!segs.length) return '';
    const t = [];
    if (balShown !== null) t.push('账户余额 ' + balShown + ' 家' + (balExtra ? '（' + balCapNote(balCap()) + '）' : ''));
    if (sto) t.push(sto.tip);
    if (balShown !== null) t.push('点击看全部');
    return '<div class="sb-bal-sum" title="' + window.esc(t.join(' · ')) + '">' + segs.join('') + '</div>';
  }
  /* ---------- 按钮族（A4）：公共件 .ghost mini + icon() ----------
     以前「刷新余额」是一行自拼的 div（`asButton` 补 role 才能点），「去设置」是 `.l2` 里一个
     自拼的 `<a>` —— 两处都不是 §3.4 组件表里的东西。现在 `data-bal` 是这一族按钮的唯一出口：
     区域里、详情弹层里都靠它接点击（重画一次就重绑一次）。
     ⚠ 这一族里**不再有跳转钮**：「还有 N 家，去用量页」换成就地展开（`expand`），
       「去设置」撤掉（左下角那颗「设置」入口本来就在，同一件事不另给一条捷径）。 */
  const balBtnHTML = (act, ic, label, title) => '<button type="button" class="ghost mini" data-bal="' + act
    + '" title="' + window.esc(title) + '"><span class="ic">' + svgIc(ic, 12) + '</span>' + label + '</button>';
  /* 展开 / 收起与刷新排在**同一行**：这一行是这一区唯一的动作行，省下来的高度留给卡。
     弹层（full）本来就是全量，那两枚对它没有意义 —— 弹层里只留「刷新余额」。 */
  const balActsHTML = (total, extra, full) => {
    let t = '';
    if (!full) {
      t = balExpOn()
        ? balBtnHTML('collapse', 'chevronUp', '收起', '只摆这一档放得下的前几张')
        : (extra > 0 ? balBtnHTML('expand', 'chevronDown', '展开全部 ' + total + ' 家',
          balCapNote(balCap()) + '：就地摆出全部 ' + total + ' 家（只有卡这一格滚，导航与本机产物行不动）') : '');
    }
    return '<div class="sb-bal-acts">' + t
      + balBtnHTML('refresh', 'refresh', '刷新余额', '重新取一次余额') + '</div>';
  };
  /* 一处绑定管两族就地开关：`[data-bal]`（展开 / 收起 / 刷新）与 `[data-mirror]`（本机产物明细）。
     传 onRefreshed 的是详情弹层（点完要重画弹层那一份），不传的就是侧栏区域自己。
     本机那个开关两边都要重画 —— `mirrorExp` 是一份全局状态，只画一处就是两份界面说两种话。 */
  function bindBal(root, onRefreshed) {
    if (!root || !root.querySelectorAll) return;
    const repaintSidebar = () => {
      const b2 = sb.querySelector('#sbBalance');
      if (b2) paintBal(b2, balRows.length ? '' : '正在读取…');
    };
    root.querySelectorAll('[data-bal], [data-mirror]').forEach(b => {
      const actOn = () => {
        const exp = b.getAttribute('data-mirror');
        if (exp !== null) {
          mirrorExp = exp === '1';
          if (onRefreshed) onRefreshed();
          repaintSidebar();
          return;
        }
        const act = b.getAttribute('data-bal');
        if (act === 'refresh') {
          const p = refreshBalance();
          /* 弹层里点刷新：侧栏区域自己会重画，弹层那一份要另画一次（否则停在旧数上） */
          if (onRefreshed && p && typeof p.then === 'function') p.then(() => { if (root.isConnected) onRefreshed(); });
          return;
        }
        if (act === 'expand' || act === 'collapse') { setBalExp(act === 'expand'); repaintSidebar(); }
      };
      b.onclick = e => { e.stopPropagation(); actOn(); };
      b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actOn(); } };
    });
  }
  /* 摘要行点开：全量卡 + 本机那一行 + 同一族按钮，走公共弹窗（UiDialog），不在侧栏里堆卡。 */
  function openBalDetail() {
    if (!window.UiDialog) return;
    UiDialog.open({
      title: '账户余额与本机产物',
      sub: balCapNote(balCap()) + '，这里是全量（' + balList().length + ' 家）',
      body: box => {
        /* 每次现问 balList()：弹窗里点「刷新余额」要看到新数，不能念着打开那一刻的旧名单。
           画法与侧栏那一块共用 paintBal（full 档：全量、不碰侧栏自己的读数状态）。 */
        const full = () => paintBal(box, '还没有取到余额 —— 先在设置页把平台加上、密钥填好', true);
        full();
      },
      actions: [{ label: '关闭', value: true }],
    });
  }
  /* 摘要行的点击与键盘：余额块关着时它只是一行状态，不扮成按钮。 */
  function bindBalSum(box) {
    const el = box && box.querySelector('.sb-bal-sum');
    if (!el) return;
    if (balShown === null) { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.onclick = null; el.onkeydown = null; return; }
    asButton(el, openBalDetail);
  }
  /* 区域 = 摘要行 + 详情块（两块都画出来，哪一块可见**只由 CSS 判**：收起态与 ≤660px 矮窗看摘要，
     其余看详情 —— 窗口尺寸只有一套判据，JS 不重复判一遍）。
     balCap0 那一带是例外：详情块照旧在，摘要行只是补一个「点开看全量」的把手，
     所以这一档把它排到**区域末尾**，A1①「传输状态摆最上面」才不被它顶下去。 */
  function balWrap(mirror, body) { return '<div class="sb-bal-body">' + mirror + body + '</div>'; }
  function balRegionHTML(mirror, body) {
    const sum = balSumHTML();
    const detail = balWrap(mirror, body);
    return balCap0 ? detail + sum : sum + detail;
  }
  /* 卡片族与「一张都没有」时那一行说明：侧栏区域与弹层详情共用（whyEmpty 为空串就是「有 N 家但摆不下」
     那一档，不补废话）。 */
  function balCardsHTML(list, whyEmpty) {
    if (list.length) return list.map(balCardHTML).join('');
    return whyEmpty ? '<div class="sb-bal-note">' + window.esc(whyEmpty) + '</div>' : '';
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
  /* 侧栏那一块与「点开看全量」的弹层共用这一份画法。`full` 只改三件事：卡片不截断（看全量）、
     不写 balShown/balExtra/balCap0 那三份**侧栏自己的**读数（导航角标与摘要行靠它们），
     以及不挂摘要行/本机行的实时订阅。其余外壳、说明行、按钮族都从同一处拼。 */
  function paintBal(box, note, full) {
    const mirror = mirrorBarHTML();   // 产物进度那一行**与余额开关无关**（见下面那两段）
    /* 整个余额区关掉（设置页勾）：**余额卡片不画**。
       以前只有「按平台勾选」，没有「一块都不要」这一档 ——
       于是用户只能把每一家都取消勾，而「刷新余额」那颗按钮还留在那儿点不动。
       ⚠ 这里早退的是**余额卡片**，不是整个盒子：「左栏显示本机产物」是另一个独立的开关，
       而那一行以前就塞在余额区里，于是「关掉余额」会顺手把「显示本机产物」也一起关掉
       （两个开关共用一个容器，这一句 return 之后 mirrorBarHTML 根本没机会跑）。
       它自带标题（产物存本机），所以余额关掉时连分组标题也一起藏掉，不留一句说错的「账户余额」。
       A1①：这一行现在固定在**区域顶部**（详情块的第一块），不再跟余额卡挤在同一个内滚动容器里。 */
    const on = balOn();
    if (balGroup && !full) balGroup.hidden = !on;
    if (!on) {
      /* 关掉余额时摘要行点不开（bindBalSum 摘掉把手），弹层根本到不了这里；真到了也不画半截。 */
      if (full) return;
      balShown = null; balExtra = 0; balCap0 = false;
      box.classList.remove('cap0');
      box.innerHTML = balRegionHTML(mirror, '');
      bindBalSum(box);
      mountMirrorBar(box);
      return;
    }
    const shown = balList();
    const sel = full ? { head: shown, extra: 0 } : balSplit(shown);
    if (!full) {
      balShown = shown.length; balExtra = sel.extra;
      balCap0 = balCap() === 0 && shown.length > 0;
      /* `.bal-exp` 只在「真的还有没摆出来的」时挂：展开态要换的是这一列的高度分配
         （导航退回自然高、余额区可缩、卡列表自己滚），全都摆得着时不该动它。 */
      sb.classList.toggle('bal-exp', balExpOn() && shown.length > balCap());
    }
    /* 一张卡都画不出来时的两种情况：
       ① 一家都没有（正在读 / 接口读不到 / 平台压根没有余额接口 / 全被勾掉了）→ 一句说明，
          「正在读取…」这一档必须有：没取到数的那一小段时间里，界面上要有一行字说明它在动，
          不能是一整块空白。指路那一句写成一行话（勾在哪一栏），不再放跳转钮。
       ② 有 N 家但**一张都摆不下**（窗口矮到余额区只剩「本机行 + 一行按钮」的余地）→
          不摆卡也不补一句废话，靠下面那行「展开全部 N 家」与摘要行说话。 */
    const cards = balCardsHTML(sel.head, shown.length ? ''
      : (note || (balRows.length ? '要显示哪几家在设置页「供应商与密钥」那张卡上勾「侧栏余额」' : '正在读取…')));
    /* 卡包进 `.sb-bal-cards` 这一格：展开态滚的是它，本机产物行与按钮行都不跟着滚。
       弹层（full）里不包 —— 那一份是两列网格，多一层容器就把网格拆了。 */
    const list = (full || !cards) ? cards : '<div class="sb-bal-cards">' + cards + '</div>';
    const inner = '<div class="sb-bal' + (full ? ' pop' : '') + '">'
      + list + balActsHTML(shown.length, sel.extra, full) + '</div>';
    box.innerHTML = full ? balWrap(mirror, inner) : balRegionHTML(mirror, inner);
    if (full) { bindBal(box, () => paintBal(box, note, true)); return; }   // 弹层里点刷新要看到新数
    bindBalSum(box);
    bindBal(box);
    mountMirrorBar(box);
  }
  /* ---------- 「产物正在存进本机 / 本机已存多少」这一行 ----------
     读数一律来自 AssetLocal.info（local.js 那一份判据），侧栏不自己数。
     显隐只看设置页那颗「左栏显示本机产物」（sbMirrorOn）——**不许连坐「产物自动存本机」**：
     以前自动存一关这一行整个消失，而勾着「显示本机产物」的人想看的恰恰是「存了多少、它在不在干活」；
     关掉只是不再新增，已存的本机文件一个没少，把整行藏掉等于把唯一的实况入口也关了。
     所以关着时照常报存量，并在 l2 里明说「自动存已关」（界面说的话要等于事实）。 */
  /* 「产物存本机」那一行的明细：`info()` 里一直白放着两个读数（本次会话存成几份、最后一次
     落盘是什么时候）。点开标题行就地展开 —— 与余额那一样式子：要看更多就展开，不跳转。
     展开状态是会话内的（跟卡数一样不写盘：它说的是「这一会儿我想看细节」，不是偏好）。 */
  let mirrorExp = false;
  const mirrorMoreHTML = s2 => {
    if (!mirrorExp) return '';
    return '<div class="l3">本次会话存成 <b>' + (s2.ok || 0) + '</b> 份 · '
      + (s2.lastAt && window.fmtWhen ? '上次存成 ' + window.esc(window.fmtWhen(s2.lastAt)) : '这次还没有存成过东西')
      + '</div>';
  };
  function mirrorBarHTML() {
    /* 这一块要能单独关掉（设置页勾）：侧栏是**全局**的，一个不需要看它的人
       （比如只用生成工作台、从不进资产库）不该被它占掉三行。这是**唯一**的显隐闸。 */
    mirrorInfo = null;
    if (window.AssetLocal && AssetLocal.sbMirrorOn && !AssetLocal.sbMirrorOn()) return '';
    const s2 = window.AssetLocal && AssetLocal.info ? AssetLocal.info() : null;
    if (!s2) return '';
    /* 摘要行（「存 2/5」）读的就是这同一份读数：侧栏不再为它多问一次 AssetLocal。 */
    mirrorInfo = s2;
    const busy = s2.inFlight > 0;
    /* 报红只属于「开着自动存却失败了」——关着的时候那条老错误不会再重试，摆红只会误导 */
    const bad = !busy && s2.on && s2.lastErr;
    const sizeOf = b => window.fmtBytes(b) || '0 KB';
    /* 在途时把「正在下这一份」摆出来：只有「正在存 N 份」的话，
       一个 200MB 的视频从 0% 到 100% 在界面上长得一模一样，人只能干等
       （「自动存本机看起来没反应」剩下的那一半 —— 另一半是根本不知道它在跑）。
       百分比来自 AssetLocal.info（它读的是响应头里的总量与已发送字节）。
       **拿不到总量就不摆条**（只显示「正在下这一份…」）：拿 0 当分母算出来的进度是假的。 */
    let dl = '';
    if (busy && s2.dlTotal > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((s2.dlSent || 0) * 100 / s2.dlTotal)));
      /* 行距不在这里写 inline style：`.sb-mirror .l2` 一条规则统着（sidebar.css），
         行内 `style="margin-top:3px"` 那种写法是一份没人管的裸值。 */
      dl = '<div class="dlbar" title="' + window.esc(String(s2.dlName || '')) + '"><i style="width:' + pct + '%"></i></div>'
        + '<div class="l2">正在下这一份 <b>' + pct + '%</b>'
        + (s2.dlName ? '（' + window.esc(String(s2.dlName).slice(0, 18)) + '）' : '')
        + ' · 已 ' + sizeOf(s2.dlSent || 0) + ' / ' + sizeOf(s2.dlTotal) + '</div>';
    } else if (busy && s2.dlName) {
      dl = '<div class="l2">正在下这一份…（' + window.esc(String(s2.dlName).slice(0, 18)) + '）</div>';
    }
    const l2 = busy
      ? '正在存 <b>' + s2.inFlight + '</b> 份' + (s2.on ? '（产物完成后自动开始）' : '')
      : (!s2.on
        ? '产物自动存本机已关；本机已存 <b>' + s2.count + '</b> 份 · ' + sizeOf(s2.bytes)
        : (bad ? window.esc(s2.lastErr)
          : '本机已存 <b>' + s2.count + '</b> 份 · ' + sizeOf(s2.bytes)
            + (s2.fail ? ' · 累计没存成 ' + s2.fail + ' 份' : '')));
    const head = '<div class="l1" role="button" tabindex="0" data-mirror="' + (mirrorExp ? '0' : '1')
      + '" title="' + (mirrorExp ? '收起明细' : '展开：本次会话存成几份、最后一次落盘在什么时候') + '">'
      + '<span class="ic">' + (busy ? '<span class="spin-dot"></span>' : svgIc('download', 13))
      + '</span><span class="nm">产物存本机</span>'
      + '<span class="ic chev">' + svgIc(mirrorExp ? 'chevronUp' : 'chevronDown', 12) + '</span></div>';
    return '<div class="sb-mirror' + (bad ? ' bad' : '') + '"'
      + (busy ? ' title="产物自动存本机正在跑，字节落盘之后这里会变成本机已存 N 份"' : '')
      + (bad ? ' title="最后一次没存成：' + window.esc(s2.lastErr) + '（下一轮列表刷新时会再试一次）"' : '')
      + (busy || s2.on ? '' : ' title="「产物自动存本机」关着：新生成的产物只留平台地址，地址过期后卡片会变成裂图（已存的本机文件不会被删，只是不再新增）"')
      + '>' + head
      + '<div class="l2">' + l2 + '</div>' + mirrorMoreHTML(s2) + dl + '</div>';
  }
  /* 订阅一次就够：AssetLocal.onInfo 每次落盘事件都推一遍，这里只改那一行。
     没有这一层的话「正在存 N 份」永远停在 0 —— 而那正是用户判断开关有没有生效的那句话。
     注意 paintBal 会整块换掉 innerHTML（余额刷新时会发生），换掉的新块**已经带了这一行**
     （paintBal 里拼了 mirrorBarHTML()），所以订阅回调里找不到旧节点就insert 一个；
     回调本身不用管「节点被换掉了」—— 那是 paintBal 的事。
     ⚠ 回调**不要用 onInfo 递过来的那个参数**：那是 local.js 内部的 INFOS，
     它没有 `on` 字段（`on: saveOn()` 只在 info() 的返回值里补）——
     早年 mirrorBarHTML 的 `st` 形参收过它，于是每一条落盘事件都算成「没有这一行」把它删掉
     （开了显示本机产物、一有东西要存那一行就没了，下载中更是全程不显示）；
     如今形参整个收掉（连误传的入口都不留），读数一律现问 AssetLocal.info()（同一份判据，且带 on）。 */
  let mirrorUnsub = null;
  function mountMirrorBar(box) {
    const A = window.AssetLocal;
    if (!A || !A.onInfo || mirrorUnsub) return;
    const repaint = () => {
      const b2 = sb.querySelector('#sbBalance');
      if (!b2) return;
      const old = b2.querySelector('.sb-bal-body > .sb-mirror');
      const want = mirrorBarHTML();
      /* A1①：这一行固定在**区域顶部**（`.sb-bal-body` 的第一块），不再是塞在 `.sb-bal` 末尾。
         两块都关着时 want 必然是空（上面已经 return），但仍判一下 host，
         别让一个 null 抛在订阅回调里被静默吞掉。 */
      const host = b2.querySelector('.sb-bal-body');
      if (!want) { if (old) old.remove(); }
      else if (old) { const tmp = document.createElement('div'); tmp.innerHTML = want; old.replaceWith(tmp.firstElementChild); }
      else if (host) host.insertAdjacentHTML('afterbegin', want);
      /* 换掉的那一块里有「产物存本机」这一行的开关（[data-mirror]），旧节点上的处理跟着没了 ——
         重画一次就重绑一次，否则落盘之后这一行只是长得对，点了没反应。 */
      bindBal(b2);
      /* 摘要行的「存 N/M」也吃这一份读数：落盘一次就要跟着变，不然收起态念的是旧数。 */
      const sum = b2.querySelector('.sb-bal-sum');
      const next = balSumHTML();
      if (sum && next) { const t2 = document.createElement('div'); t2.innerHTML = next; sum.replaceWith(t2.firstElementChild); }
      else if (sum && !next) sum.remove();
      bindBalSum(b2);
    };
    mirrorUnsub = A.onInfo(repaint);
    /* 本地那张指针表只是缓存，盘上那份索引才是本体 —— 挂上之后异步认一遍再重画这一行。
       没这一步，换端口 / 清过浏览器数据 / 无痕窗口里这一行会写「本机已存 0 份」，
       而 .assets 里明明躺着一摞（设置页那一行同款理由、走的也是同一份 syncStats，
       侧栏不许自己再数一种）。认回来顺带把索引补全，别处的「优先用本机文件」也跟着受益。 */
    if (A.syncStats) A.syncStats().then(repaint).catch(() => {});
  }
  /* 单取一家：请求头与余额解析都不在这份里写第二遍 ——
     Api.headers 带密钥**和自定义中转地址**（少了 x-up-base，设置页换了中转地址就只有侧栏还在打官方地址，
     读出来的余额对不上），Api.balance 按 registry 的 balance.style 解析（wallet-credits / micros）。 */
  async function balRowOf(m) {
    try {
      const c = await Api.request(m.p, 'credits');
      const b = Api.balance(m.p, c);
      const fmt = v => Api.balNum(v, b.unit);
      const avail = fmt(b.available), frozen = fmt(b.frozen), unit = b.unit ? ' ' + b.unit : '';
      return { kid: m.kid, name: m.name, avail, frozen, unit };
    } catch (e) {
      /* 失败原因要跟着行一起走（L42）。以前整个 throw 被吞掉，只剩「获取失败」四个字 ——
         密钥过期 / 代理没起来 / 平台限流在这张卡上长得一模一样，而同一个错在用量页
         能读到「查询失败：HTTP 401：密钥无效或过期」。侧栏把原因挂到 title 上，
         卡面只留一句短的（不然一行小字塞不下）。 */
      return { kid: m.kid, name: m.name, avail: '获取失败', failed: true,
        why: '查询失败：' + (errText(e)|| '未知原因'), frozen: '-', unit: '' };
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
    // 注册表统一走 Api.registry（带 60 秒缓存，和其它页面共用一份）；api.js 是外壳静态加载的，这一层不再判它在不在
    try { reg = await Api.registry(); }
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
       判据用 `Api.provUsable`（与设置页那张卡列哪几家是同一份，见 api.js）。
       真的配了却读不通的那几家仍然会出现、并且照样显示「获取失败」—— 那是真错误，不能藏。 */
    let env = {};
    try { env = await Api.envStatus(); } catch (e) {}
    const usable = [...map.values()].filter(m => Api.provUsable(m.p, env));
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
      paintBal(box, '这几家都被你在设置页「供应商与密钥」那张卡上取消了「侧栏余额」');
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
      /* A1 之后不用「再补插一次本机那一行」：paintBal 每画一次都现算 mirrorBarHTML()，
         开关从关到开时那一块本来就跟着回来了。 */
      const box = sb.querySelector('#sbBalance');
      if (box) paintBal(box, balRows.length ? '' : '正在读取…');
      /* 刚在设置页勾上「左栏显示余额」而本机一份数都没有 → 现在去取，别让那块地方
         一直停在占位上（那正是用户说的「等它刷出来」，勾开关本来就是为了现在就要看见）。
         缓存还热（60 秒内刚取过）就不白跑一遍 —— 改勾选、改「存哪一档」走的是重画，不是重新取数。 */
      const ts = readBalCache().ts;
      if (balOn() && Date.now() - ts > 60000) refreshBalance();
    } catch (e) {}
  };
  /* 跨过 balCap() 那几条线时区域能摆的卡数变了，照实重画一次：
     「还有 N 家」那句必须等于真的没摆出来的家数，差一家就是假话。
     尺寸判据只有 CSS 与这一处，读的是同一批 media query。 */
  let balCapLast = -1, balCapTimer = 0;
  const balCheckCap = () => {
    const c = balCap();
    if (c === balCapLast) return;
    balCapLast = c;
    const box = sb.querySelector('#sbBalance');
    if (box && balShown !== null) paintBal(box, balRows.length ? '' : '正在读取…');
  };
  window.addEventListener('resize', () => {
    clearTimeout(balCapTimer);
    balCapTimer = setTimeout(balCheckCap, 150);
  });

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
  /* 定时器跑在外壳顶层文档，是全会话里活得最久的一个（web/app.js 切页只切 display、外壳不重建），
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
