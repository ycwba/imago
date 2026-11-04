/* 全局侧边栏：只在外壳页（shell.html）里渲染。
   内容页（导演台 / 工作台 / 拍短剧 / 素材库 / 收藏 / 资产库 / 用量 / 设置）跑在外壳的 iframe 里，
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
  /* 设置这一行读路由表的 label（以前「设置」两个字在这里手抄了一份）。
     窄形态只留那颗齿轮：这一行是横排的（图标 + 全名），没有导航项那种「图标在上、短标签在下」的位子。 */
  const setPg = (window.WB_ROUTES && window.WB_ROUTES.byFile && window.WB_ROUTES.byFile['settings.html']) || {};
  sb.innerHTML =
    '<div class="sb-brand"><span class="sb-logo" title="点击收起 / 展开侧边栏">AI</span>'
    + '<span class="sb-brand-txt"><span class="sb-name">AI 创作工作台</span>'
    + '<span class="sb-sub">本地优先 · 数据留在本机</span></span></div>'
    + '<nav>' + items.map(i =>
      /* `.lb` 是全名（满形态显示它、悬停名牌念它），`.sh` 是两字短标签（窄形态显示它）。
         两者都从路由表那一行来（label / short）—— 侧栏不许另抄一份。 */
      `<a href="${hrefOf(i.file)}" data-page="${i.file}" class=""><span class="ic">${svgIc(i.ic)}</span>`
      + `<span class="lb">${i.label}</span><span class="sh">${i.short || ''}</span></a>`
    ).join('') + '</nav>'
    + '<div class="sb-bottom" id="sbBalance"></div>'
    + '<div class="sb-bottom"><a href="' + hrefOf('settings.html') + '" data-page="settings.html" class="sb-set" aria-label="' + window.esc(setPg.label) + '"><span class="ic">' + svgIc('gear') + '</span><span class="lb">' + window.esc(setPg.label) + '</span></a>'
    + '<button class="sb-set" id="sbTheme" title="切换亮色 / 暗色背景"><span class="ic">' + svgIc('moon') + '</span><span class="lb">换背景</span></button></div>';

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
    /* 悬停 / 键盘聚焦就把这一页的加载链提前发出去（app.js 的 __spaPrefetch）：
       从「想点」到「点下去」通常有一两百毫秒，够入口模块与样式跑到一半；
       空闲预取没走到这一页时，这一下就是它最先被想起来的机会。 */
    const pre = () => { try { if (window.__spaPrefetch) window.__spaPrefetch(a.dataset.page); } catch (e) {} };
    a.addEventListener('mouseenter', pre);
    a.addEventListener('focus', pre);
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
  sbTip.on(setLink, setPg.label);
  if (setLink) {
    setLink.dataset.page = 'settings.html';
    const preSet = () => { try { if (window.__spaPrefetch) window.__spaPrefetch('settings.html'); } catch (e) {} };
    setLink.addEventListener('mouseenter', preSet);
    setLink.addEventListener('focus', preSet);
  }
  /* 「账户余额」那一行是满形态那张卡里的抬头（paintBal 画）；窄形态与矮窗里那一块是
     压缩版（家数 + 状态点 + 落盘进度），点它开气泡。两处都从 balShown 现算，不另写一份。 */

  // head 里加载时 body 尚不存在，等 DOM 就绪再挂载
  function mount() {
    document.body.prepend(sb);
    /* 挂上之后补量一次卡列表的高度：首次 paintBal 可能在挂载之前就跑过（量到 0）。 */
    requestAnimationFrame(() => fitBalCards(sb.querySelector('#sbBalance')));
  }

  /* 自适应：宽度 ≤1100px 算窄窗口 —— 用户想展开仍然可以展开，但那是浮层（不改 --sbw，
     内容区不被压缩）；宽窗口才是 56 ↔ 232 的真让位。以前窄窗口直接把展开吞掉
     （isOpen() 里 and 上宽度），点 AI 方块毫无反应，像坏了。 */
  const NARROW_W = 1100;
  const OPEN_W = 232;   /* 满形态 */
  const SLIM_W = 56;    /* 窄形态 */
  const narrow = () => window.innerWidth <= NARROW_W;
  const wantOpen = () => window.LS.get('sb_open') === '1';
  /* 收起态点开的那只气泡（余额 + 本机产物）：全站只有这一份，开 / 关都走下面那一族函数。
     它在 apply() 之前先声明：apply() 在余额区那一段之前就会跑一次。 */
  let balBubble = null;
  /* sbOpenLast 只记「上一次画的是哪一态」：同一态里反复 resize 不重做收尾。
     收起 / 展开时那张卡从藏到显（或反过来），换场之后要重新量一次卡列表的高度；
     气泡是贴着压缩块摆的，压缩块没了（展开）它就该收掉 —— 不然会停在一条已经变宽的侧栏旁边。 */
  let sbOpenLast = null;
  function apply() {
    const o = wantOpen();
    const n = narrow();
    const r = document.documentElement.classList;
    r.toggle('sb-narrow', n);
    r.toggle('sb-open', o);
    const prev = sbOpenLast;
    sbOpenLast = o;
    if (prev !== o && prev !== null) {
      closeBalBubble();
      setTimeout(() => fitBalCards(sb.querySelector('#sbBalance')), 0);
    }
    sbTip.hide();          // 展开 ↔ 收起的瞬间把浮标收掉：留着会停在刚变过宽度的位置上
    document.documentElement.style.setProperty('--sbw', (o && !n) ? OPEN_W + 'px' : SLIM_W + 'px');
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
  // 折叠 / 展开：左上角那块 AI 头像方块（点它切换）
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
  /* 图标只有这里知道怎么画，别处再拼一份 svg 就是第二份实现。
     解析主题（含「跟随系统」）只有 web/shell-boot.js 的 __themeApply 那一处；
     这里只负责把当前**解析后**的那一档画成日 / 月图标，每次解析完成后由它回调。 */
  window.__sbThemeIcon = () => {
    try { if (themeBtn) themeBtn.querySelector('.ic').innerHTML = themeIcon(document.documentElement.dataset.theme === 'dark'); } catch (e) {
      /* 图标画不出来不影响切换本身，下一次解析会再试。 */
    }
  };
  if (themeBtn) themeBtn.onclick = () => {
    /* 「跟随系统」时按**解析后**的那一档取反，并把它钉成明确的一档 ——
       点一下就是「我要另一档」，不再继续跟系统。 */
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    window.LS.set('dir_theme', next);
    window.__themeApply();
  };
  /* 设置页改完「侧栏默认展开」要当场重排一次，不能等下次进页面：
     栏宽、收起态、悬浮球避让全在 apply() 里算，所以把这个钩子递出去（和 __themeApply 同一类）。 */
  window.__sbApplyOpen = apply;
  if (themeBtn) window.__sbThemeIcon();
  window.addEventListener('resize', apply);
  apply();
  /* 窄窗口里展开 = 浮层盖在内容上。点内容区要能把它收回去，但内容页的点击不冒泡到外壳，
     所以由外壳在文档上挂监听（见 web/app.js 的 CLOSE_OVERLAY）。
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
     （这一页是外壳顶层文档，注入等于拿到 localStorage 里的密钥配置）。
     一张卡固定三行 —— 名字一行、金额一行、状态一行，每行单行不换行、超长省略号、全文在 title。
     以前「可用 X · 冻结 Y」挤在一行还写 `word-break: break-all`，长数字把同一排的卡撑成三种高度。 */
  const balCardHTML = r => {
    /* 正在取的那几家：先画一张占位卡。名字已经知道了，钱还没到。
       以前这里是「等 N 个请求全回来才一起画」，于是慢的那一家把快的那一家一起拖住，
       界面上从头到尾一张卡都没有，最后「突然冒出来」N 张 ——
       与「一直显示着、一家一家填上」是两回事（后者还顺便说明了到底在问哪几家）。 */
    if (r.pending) {
      return `<div class="sb-bal-card" data-kid="${window.esc(r.kid)}" title="${window.esc(r.name)}：正在查询…">
        <div class="l1"><span class="nm">${window.esc(r.name)}</span><span class="am">—</span></div>
        <div class="l2"><span class="spin-dot"></span> 正在读取…</div></div>`;
    }
    const avail = window.esc(r.avail), frozen = window.esc(r.frozen), unit = window.esc(r.unit);
    /* 失败那一行把原因摆到行面上：以前只留「获取失败」四个字、原因藏进 title，
       而「为什么失败」正是这一行唯一有用的信息 —— 现在第二行直接写原因（放不下才省略，
       title 里仍是全文）。正常行：名字 + 金额一行，冻结 + 单位一行。 */
    const tip = r.failed
      ? `${window.esc(r.name)}：${window.esc(r.why || r.avail)}`
      : `${window.esc(r.name)}：可用 ${avail}${unit} · 冻结 ${frozen}${unit}`;
    return `<div class="sb-bal-card" data-kid="${window.esc(r.kid)}" title="${tip}">
       <div class="l1"><span class="nm">${window.esc(r.name)}</span><span class="am">${avail}${unit}</span></div>
       <div class="l2">${r.failed
        ? '<span class="balerr">' + window.esc(String(r.why || '获取失败')) + '</span>'
        : ('冻结 ' + frozen + unit)}</div></div>`;
  };
  /* 这一轮要显示的那几张卡：**已有数的用旧值，还在路上的一律给占位卡**。
     顺序按「要问哪几家」来（balKids / balPending），所以某一家先回来时它就地变成数字，
     不会把后面的卡挤来挤去；缓存里有、这一轮没问的（刚被取消勾选之类）按原顺序补在后面。
     过滤仍走 SbBal.filter —— 勾选名单只有那一份实现，这里不自己判。 */
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
  /* ---------- 卡列表定高「三家」 ----------
     这一块的高度只按**三张余额行**算：窗口再高也只摆三张，第四家起在卡列表里自己滚；
     滚动条藏掉（CSS 的 `scrollbar-width:none` + 一条 webkit 规则），不占那一列的宽度。
     高度不写死在 CSS 里，而是量第一张卡再乘三 —— 矮窗（≤780）那一档内边距会变小，
     写死一个像素值迟早切掉半行。量不到（侧栏收着 / 还没挂上）就不限高，
     真正可见的那一态由 apply() 或下一次重画补量。 */
  function fitBalCards(host) {
    if (!host) return;
    const wrap = host.querySelector('.sb-bal-cards');
    if (!wrap) return;
    const card = wrap.querySelector('.sb-bal-card');
    const h = card ? card.getBoundingClientRect().height : 0;
    if (h > 0) wrap.style.maxHeight = (h * 3) + 'px';
    else wrap.style.removeProperty('max-height');
  }
  /* 摘要行要的两个数：余额几家 / 还有几家没摆出来。由 paintBal 现填，
     落盘事件重画摘要时不必再问一次 balList（数据没变，只有本机的数在变）。
     balShown = null 表示「余额那一整块被设置页关掉了」，摘要只报本机那一段、也不可点开。 */
  let balShown = null, mirrorInfo = null;
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
  /* 一行摘要 ——「余额 3 家 · 存 2/5」。收起态（56px）与矮窗（≤660px）看它，
     点它开气泡看全量卡；满形态里它由 CSS 藏掉。 */
  function balSumHTML() {
    const sto = balSto();
    if (balShown === null && !sto) return '';
    /* 窄形态这一块是「同一份内容的压缩版」：家数 + 每家一个状态点 + 落盘进度。
       56px 里放不下三个平台名，但放得下三个「各家怎么样了」——
       实心点 = 这一家取到了，空心红点 = 这一家取不到（悬停念完整名单）。
       顺序与满形态那张卡一致（余额在上、落盘在下），两个形态读起来是同一件事。 */
    const list = balList();
    const okN = list.filter(r => !r.failed).length;
    const badRows = list.filter(r => r.failed);
    const dots = list.length
      ? '<div class="sb-bal-dots" title="' + window.esc(list.length + ' 家余额 · '
          + (okN ? okN + ' 家取到' : '')
          + (badRows.length ? ' · ' + badRows.length + ' 家取不到（'
            + badRows.map(r => r.name).join('、') + '）' : '')) + '">'
        + list.map(r => '<i class="' + (r.failed ? 'bad' : 'ok') + '"></i>').join('') + '</div>'
      : '';
    /* 落盘那一段：在途就报「存 在途/已存」，空闲只报份数。
       字节是代理取的，浏览器这一侧没有进度，所以没有百分比这一说。 */
    const s2 = mirrorInfo || {};
    const mirror = sto ? '<div class="sb-bal-sum-mirror" title="' + window.esc(sto.tip) + '">'
      + '<span class="sb-mirror-n">' + (sto.busy ? '存 ' + sto.txt : (s2.count || 0) + ' 份') + '</span></div>' : '';
    const t = [];
    if (balShown !== null) t.push('账户余额 ' + balShown + ' 家');
    if (sto) t.push(sto.tip);
    if (balShown !== null) t.push('点击看详情');
    return '<div class="sb-bal-sum" title="' + window.esc(t.join(' · ')) + '">'
      + (balShown !== null
        ? '<div class="p"><b>' + balShown + '</b><span class="u">家余额</span></div>'
        : '')
      + dots
      + (dots || mirror ? '<div class="sb-bal-sum-sep"></div>' : '')
      + mirror + '</div>';
  }
  /* ---------- 点开 / 收起：抬头刷新、压缩块开气泡 ----------
     这一区不再有按钮行：刷新由**抬头**接管（点「账户余额」重取一次），
     收起态与矮窗里由压缩块开一只气泡（每开一次自动重取一遍）。
     气泡贴在压缩块右边、点页面别处或按 Esc 就关 —— 它只在「卡摆不下」的那两档出现。 */
  function bindBalTitle(box) {
    const t = box.querySelector('.sb-now-t');
    if (t) asButton(t, () => refreshBalance({ force: true }));
  }
  /* 摘要行的点击与键盘：余额块关着时它只是一行状态，不扮成按钮。 */
  function bindBalSum(box) {
    const el = box && box.querySelector('.sb-bal-sum');
    if (!el) return;
    el.removeAttribute('role'); el.removeAttribute('tabindex'); el.onclick = null; el.onkeydown = null;
    if (balShown === null) return;
    asButton(el, toggleBalBubble);
  }
  /* 余额卡的骨架（侧栏那张卡与气泡共用）：抬头 + 卡列表。
     侧栏里的抬头是刷新入口；气泡里的抬头只是标题 —— 气泡每开一次已经取过一轮，
     里面不再放第二颗「刷新」。卡列表都包在 `.sb-bal-cards` 里：定高、自己滚、滚动条藏掉。 */
  function balBodyHTML(note, pop) {
    const shown = balList();
    const cards = balCardsHTML(shown, shown.length ? ''
      : (note || (balRows.length ? '要显示哪几家在设置页「供应商与密钥」那张卡上勾「侧栏余额」' : '正在读取…')));
    const head = '<div class="sb-now-t"' + (pop ? '' : ' title="点击刷新"')
      + '>账户余额 <span class="n">' + shown.length + ' 家</span></div>';
    return '<div class="sb-bal">' + head
      + (cards ? '<div class="sb-bal-cards">' + cards + '</div>' : '') + '</div>';
  }
  /* 区域 = 摘要行 + 详情块（两块都画出来，哪一块可见**只由 CSS 判**：收起态与 ≤660px 矮窗看摘要，
     其余看详情 —— 窗口尺寸只有一套判据，JS 不重复判一遍）。
     本机产物行在卡**底**：压缩块也是「余额在上、落盘在下」，两处读起来是同一件事。
     它不跟着卡列表滚（滚的是 .sb-bal-cards 那一格）。 */
  function balWrap(body, mirror) { return '<div class="sb-bal-body">' + body + mirror + '</div>'; }
  function balRegionHTML(mirror, body) { return balSumHTML() + balWrap(body, mirror); }
  /* ---------- 气泡（收起态 / 矮窗里那一块压缩块的详情）----------
     位置贴着压缩块右边、底边对齐；窗口里放不下就往里夹回来。
     开 = 重取一次余额（用户点它就是为了看新数）；关 = 点别处 / Esc / 侧栏换形态 / 窗口尺寸变。 */
  function paintBubble(note) {
    if (!balBubble) return;
    /* 卡列表那一格（`.sb-bal-cards`）自己滚：整块重画把它连节点一起换掉，滚到第二屏的人一次余额
       回执就被弹回第一屏。公共件按锚点还位；量高写高那句（`fitBalCards`）排在还原**之前**，
       不然定完三张的高度还要再夹一次上限。 */
    keepPaint(balBubble, () => {
      balBubble.innerHTML = '<div class="sb-bal-body">'
        + (balOn() ? balBodyHTML(note, true) : '') + mirrorBarHTML() + '</div>';
      fitBalCards(balBubble);
    });
    placeBalBubble();
  }
  function placeBalBubble() {
    if (!balBubble) return;
    const trig = sb.querySelector('#sbBalance .sb-bal-sum');
    const r = (trig || sb).getBoundingClientRect();
    const w = balBubble.offsetWidth, h = balBubble.offsetHeight;
    const left = Math.max(8, Math.min(r.right + 10, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(r.bottom - h, window.innerHeight - h - 8));
    balBubble.style.left = Math.round(left) + 'px';
    balBubble.style.top = Math.round(top) + 'px';
    /* 小箭头对着压缩块的中线（气泡是贴着它长出来的一块，不是随便浮在屏幕上的卡） */
    balBubble.style.setProperty('--pop-arrow',
      Math.round(Math.max(12, Math.min(h - 12, r.top + r.height / 2 - top))) + 'px');
  }
  function onBalDocDown(e) {
    if (!balBubble) return;
    const t = e.target;
    if (balBubble.contains(t)) return;
    const trig = sb.querySelector('#sbBalance .sb-bal-sum');
    if (trig && trig.contains(t)) return;   // 点回压缩块 = 收起，由它自己 toggle
    closeBalBubble();
  }
  function onBalKey(e) { if (e.key === 'Escape') closeBalBubble(); }
  function closeBalBubble() {
    if (!balBubble) return;
    balBubble.remove();
    balBubble = null;
    document.removeEventListener('pointerdown', onBalDocDown, true);
    document.removeEventListener('keydown', onBalKey, true);
    window.removeEventListener('resize', closeBalBubble);
  }
  function openBalBubble() {
    closeBalBubble();
    const el = document.createElement('div');
    el.className = 'sb-bal-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '账户余额与本机产物');
    document.body.appendChild(el);
    balBubble = el;
    paintBubble();
    document.addEventListener('pointerdown', onBalDocDown, true);
    document.addEventListener('keydown', onBalKey, true);
    window.addEventListener('resize', closeBalBubble);
    refreshBalance({ force: true });
  }
  function toggleBalBubble() { if (balBubble) closeBalBubble(); else openBalBubble(); }
  /* 卡片族与「一张都没有」时那一行说明：侧栏区域与气泡共用。 */
  function balCardsHTML(list, whyEmpty) {
    if (list.length) return list.map(balCardHTML).join('');
    return whyEmpty ? '<div class="sb-bal-note">' + window.esc(whyEmpty) + '</div>' : '';
  }
  /* 一家回来就换掉它那一张卡（不整块重画）：整块重画会把用户正在看的其他卡也抖一遍，
     而这一轮可能还有几家在路上。找不到那张卡（还没画 / 已经被整块重画掉了）才退回整块。
     气泡开着时那一张也换掉（不重画整只气泡，卡列表的滚动位不跳）。 */
  function upsertBal(row) {
    const i = balRows.findIndex(r => r && String(r.kid) === String(row.kid));
    if (i >= 0) balRows[i] = row; else balRows.push(row);
    const box = sb.querySelector('#sbBalance');
    if (!box) return;
    const swap = host => {
      if (!host) return false;
      const old = [...host.querySelectorAll('.sb-bal-card')].find(c => String(c.dataset.kid) === String(row.kid));
      if (!old) return false;
      const tmp = document.createElement('div');
      tmp.innerHTML = balCardHTML(row);
      old.replaceWith(tmp.firstElementChild);
      return true;
    };
    const done = swap(box);
    if (balBubble) {
      if (swap(balBubble)) placeBalBubble(); else paintBubble();
    }
    if (!done) paintBal(box);
  }
  /* 「余额那一块显示不显示」只有这一份判据（设置页勾的那颗，写在别的键上）：
     paintBal 画不画卡片、`__sbApplyBalance` 要不要去取数，两处都问它 ——
     各写一遍 `AssetLocal.sbBalOn && !AssetLocal.sbBalOn()` 就是两条会走岔的判据。 */
  const balOn = () => !(window.AssetLocal && AssetLocal.sbBalOn && !AssetLocal.sbBalOn());
  /* 侧栏是外壳里的常驻经典脚本，`Wb.viewport` 住在那份**按页补载**的 workbench.js 里。
     公共件还没就位时（开机第一帧、从不进那几页的会话）直接画：那一次卡列表本来就是空的，
     没有滚动位可丢 —— 这一句判的是加载顺序，不是第二份实现。 */
  const keepPaint = (el, fn) => (window.Wb && window.Wb.viewport ? window.Wb.viewport.keep(el, fn) : fn());
  /* 侧栏那张卡与气泡共用这一份画法：摘要行照旧画（收起态 / 矮窗看它），详情块照旧画
     （满形态看它，两块哪块可见只由 CSS 判）。 */
  function paintBal(box, note) {
    const mirror = mirrorBarHTML();   // 产物进度那一行**与余额开关无关**（见下面那两段）
    /* 整个余额区关掉（设置页勾）：**余额卡片不画**。
       ⚠ 这里早退的是**余额卡片**，不是整个盒子：「左栏显示本机产物」是另一个独立的开关，
       而那一行以前就塞在余额区里，于是「关掉余额」会顺手把「显示本机产物」也一起关掉
       （两个开关共用一个容器）。它自带标题（产物存本机），所以余额关掉时连分组标题也一起藏掉，
       不留一句说错的「账户余额」。这一行固定在**卡底**（详情块的最后一块），不跟卡列表一起滚。 */
    const on = balOn();
    balShown = on ? balList().length : null;
    const body = on ? balBodyHTML(note) : '';
    /* 两块都关着时什么都不画：留一个空卡面（描边 + 淡底，二十来像素高）是一块没人认领的方块。 */
    keepPaint(box, () => {
      box.innerHTML = (body || mirror) ? balRegionHTML(mirror, body) : '';
      bindBalSum(box);
      bindBalTitle(box);
      mountMirrorBar();
      fitBalCards(box);
    });
    paintBubble(note);
  }
  /* ---------- 「产物正在存进本机 / 本机已存多少」这一行 ----------
     读数一律来自 AssetLocal.info（local.js 那一份判据），侧栏不自己数。
     显隐只看设置页那颗「左栏显示本机产物」（sbMirrorOn）——**不许连坐「产物自动存本机」**：
     以前自动存一关这一行整个消失，而勾着「显示本机产物」的人想看的恰恰是「存了多少、它在不在干活」；
     关掉只是不再新增，已存的本机文件一个没少，把整行藏掉等于把唯一的实况入口也关了。
     所以关着时照常报存量，并在 l2 里明说「自动存已关」（界面说的话要等于事实）。 */
  /* 「产物存本机」的明细常驻（本次会话存成几份、最后一次落盘在什么时候）：
     `info()` 里本来就有这两个读数，这一区不再有开关 —— 一行小字比一个要点才知道的状态更省事，
     文案只留最短的形态。 */
  function mirrorBarHTML() {
    /* 这一块要能单独关掉（设置页勾）：侧栏是**全局**的，一个不需要看它的人
       （比如只用工作台、从不进资产库）不该被它占掉三行。这是**唯一**的显隐闸。 */
    mirrorInfo = null;
    if (window.AssetLocal && AssetLocal.sbMirrorOn && !AssetLocal.sbMirrorOn()) return '';
    const s2 = window.AssetLocal && AssetLocal.info ? AssetLocal.info() : null;
    if (!s2) return '';
    /* 摘要行（「存 2/5」）读的就是这同一份读数：侧栏不再为它多问一次 AssetLocal。 */
    mirrorInfo = s2;
    const busy = s2.inFlight > 0;
    /* 什么样的状态才轮到「坏消息」那几句（存不下几条 / 最近一次失败的原因）。
       只换文案与 title，不染颜色：这一行常驻在侧栏底部、每一屏都看得见，红色等于把整页
       都挂成告警；成因与下一步放在 title 里，看的人才展开。
       `dead`（本机存不下的那几条，跨会话不再重试）比 `lastErr`（最近一次失败的成因，多半还会再试）
       更该被看见：它是「开了却没反应」唯一看得见的解释。 */
    const bad = !busy && s2.on && (s2.dead > 0 || !!s2.lastErr);
    const sizeOf = b => window.fmtBytes(b) || '0 KB';
    /* 第三行始终只有一行字：在途写「正在下这一份 + 名字」，空闲写「本次 N 份」。
       名字是 prompt / 标题的前 24 字（`AssetLocal.info` 递出来的那一枚），全文在 title 里；
       这一块长在侧栏底部那张卡里，换行会把这一块撑出卡底，所以单行省略。 */
    const line = busy
      ? (s2.dlName
        ? '正在下这一份 <b title="' + window.esc(String(s2.dlName)) + '">' + window.esc(String(s2.dlName)) + '</b>'
        : '正在下这一份…')
      : '本次 <b>' + (s2.ok || 0) + '</b> 份';
    const l2 = busy
      ? '正在存 <b>' + s2.inFlight + '</b> 份'
      : (!s2.on
        ? '自动存已关 · 已存 <b>' + s2.count + '</b> 份 · ' + sizeOf(s2.bytes)
        : (s2.dead
          ? '已存 <b>' + s2.count + '</b> 份 · ' + sizeOf(s2.bytes) + ' · <b>' + s2.dead + '</b> 份存不下'
          : (bad ? window.esc(s2.lastErr)
            : '已存 <b>' + s2.count + '</b> 份 · ' + sizeOf(s2.bytes)
              + (s2.fail ? ' · 失败 ' + s2.fail + ' 份' : ''))));
    const head = '<div class="l1"><span class="ic">' + (busy ? '<span class="spin-dot"></span>' : svgIc('download', 13))
      + '</span><span class="nm">产物存本机</span></div>';
    const tip = bad
      ? (s2.dead
        ? '有 ' + s2.dead + ' 份存不进本机，已不再重试：' + (String(s2.deadWhy || '') || '原因未知')
          + '（选中它们按「存回本机」可再试一次）'
        : '最后一次没存成：' + window.esc(s2.lastErr))
      : (busy || s2.on ? '' : '自动存本机关着，新产物只留平台地址。');
    return '<div class="sb-mirror"'
      + (tip ? ' title="' + window.esc(tip) + '"' : '')
      + '>' + head
      + '<div class="l2">' + l2 + '</div><div class="l3">' + line + '</div></div>';
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
  /* 只换「本机产物」那一块本身：它固定在卡底（`.sb-bal-body` 的最后一块），不跟卡列表一起滚。
     气泡里那一份同样换（两块是同一份读数，只画一处就是两处界面说两种话）。 */
  function patchMirror(host) {
    if (!host) return;
    const body = host.querySelector('.sb-bal-body');
    if (!body) return;
    const old = body.querySelector('.sb-mirror');
    const want = mirrorBarHTML();
    if (!want) { if (old) old.remove(); return; }
    if (old) { const tmp = document.createElement('div'); tmp.innerHTML = want; old.replaceWith(tmp.firstElementChild); }
    else body.insertAdjacentHTML('beforeend', want);
  }
  function mountMirrorBar() {
    const A = window.AssetLocal;
    if (!A || !A.onInfo || mirrorUnsub) return;
    const repaint = () => {
      const b2 = sb.querySelector('#sbBalance');
      patchMirror(b2);
      if (balBubble) { patchMirror(balBubble); placeBalBubble(); }
      if (!b2) return;
      /* 摘要行的「存 N/M」也吃这一份读数：落盘一次就要跟着变，不然收起态念的是旧数。 */
      const sum = b2.querySelector('.sb-bal-sum');
      const next = balSumHTML();
      if (sum && next) { const t2 = document.createElement('div'); t2.innerHTML = next; sum.replaceWith(t2.firstElementChild); }
      else if (sum && !next) sum.remove();
      bindBalSum(b2);
    };
    mirrorUnsub = A.onInfo(repaint);
    /* 浏览器那份别名表只是当前会话的缓存，盘上那份账才是本体 —— 挂上之后异步认一遍再重画这一行。
       没这一步，换端口 / 清过浏览器数据 / 无痕窗口里这一行会写「本机已存 0 份」，
       而 .assets 里明明躺着一摞（设置页那一行同款理由、走的也是同一份 syncStats，
       侧栏不许自己再数一种）。认回来顺带把别名表补全，别处的「优先用本机文件」也跟着受益。 */
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
      /* 失败原因要跟着行一起走。以前整个 throw 被吞掉，只剩「获取失败」四个字 ——
         密钥过期 / 代理没起来 / 平台限流在这张卡上长得一模一样，而同一个错在用量页
         能读到「查询失败：HTTP 401：密钥无效或过期」。侧栏把原因挂到 title 上，
         卡面只留一句短的（不然一行小字塞不下）。 */
      return { kid: m.kid, name: m.name, avail: '获取失败', failed: true,
        why: '查询失败：' + (errText(e)|| '未知原因'), frozen: '-', unit: '' };
    }
  }
  /* 余额变了就广播一声：侧栏自己重画，设置页那几张账号卡上的余额也跟着换新 ——
     两边读的是同一份缓存，不各存一份。 */
  function notifyBal() {
    try { window.dispatchEvent(new Event('sb-balance-updated')); } catch (e) {}
  }
  /* 把新取回的行并进缓存（按 kid 覆盖），不整份替换：设置页为了画账号卡上的余额，
     会补问「侧栏没勾选、这一轮不在想取名单里」的那几家 —— 整份换掉会把它们抹掉。 */
  function mergeBalRows(rows) {
    const cur = readBalCache();
    const byKid = new Map(cur.rows.map(r => [String(r.kid), r]));
    (rows || []).forEach(r => { if (r && r.kid) byKid.set(String(r.kid), r); });
    const next = [...byKid.values()];
    try { localStorage.setItem(BAL_KEY, JSON.stringify({ ts: Date.now(), rows: next, kids: cur.kids })); } catch {}
    balRows = next;
    notifyBal();
    return next;
  }
  /* 设置页的账号卡也显示余额：单取（请求头 / 解析 / 失败原因）只有 balRowOf 一份，
     缓存只有 BAL_KEY 一份。设置页只补「缓存里还没有的那几家」——
     默认全勾时侧栏每一轮都问过，那边一个请求都不多发。 */
  window.SbBalance = {
    rowOf(kid) {
      const k = String(kid);
      return balRows.find(r => String(r.kid) === k) || null;
    },
    async fetchRows(list) {
      const rows = await Promise.all((Array.isArray(list) ? list : [])
        .filter(m => m && m.kid && m.p)
        .map(m => balRowOf(m)));
      if (rows.length) mergeBalRows(rows);
      return rows;
    },
  };
  /* 开机一两秒里这段会被连着叫（外壳求值一轮、导演台 loadCredits 广播一轮、定时器与
     visibilitychange 各一轮）：「先画缓存」每次照做（切页 / 刷新时余额立刻可见），
     取数体在途时并船 —— 四路触发方拿同一个 Promise，N 家余额只发一轮；
     每完成一轮照发一次 sb-balance-updated，监听方语义不变。
     并船只合**被动触发**。「点抬头」与「开气泡」是真人当下的意思（`{force:true}`），不许被吞掉：
     在途时仍不发第二条并发请求（上限照旧 1），而是记下「这一轮落定还要再跑一轮」。
     必须重跑而不能只等这一轮 —— `fetchBalRows` 在轮次开始时就快照了 `Api.provUsable` 与
     `SbBal.filter`，刚加的密钥、刚改的勾选只有出现在**下一轮**的名单里才可能画出来；
     跟着这一轮的快照走，用户看到的就是「点了抬头没反应，气泡里还是旧数」。 */
  let balInflight = null;
  let balRerun = false;
  function refreshBalance(opts) {
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
    if (balInflight) {
      if (opts && opts.force) balRerun = true;
      return balInflight;
    }
    balInflight = fetchBalRows(box).finally(() => {
      balInflight = null;
      if (balRerun) { balRerun = false; refreshBalance(); }
    });
    return balInflight;
  }
  async function fetchBalRows(box) {
    let reg;
    // 注册表统一走 Api.registry（带 60 秒缓存，和其它页面共用一份）；api.js 是外壳静态加载的，这一层不再判它在不在
    try { reg = await Api.registry(); }
    catch { if (!balRows.length) paintBal(box, '余额读取失败'); return; }
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
      notifyBal();
      return;
    }
    /* 用户把这几家**全取消勾选**了 → 取数阶段就短路：以前 `SbBal.filter` 只在
       paintBal 里过滤**渲染**，取数照跑，于是「设置里全不勾」照样每分钟去取它们的钱。
       这里复用同一份 filter（「同一个功能只应有一份实现」），不新写一份判据。
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
    /* 与缓存里已有的行合（按 kid 覆盖）：这一轮只问「勾选的这几家」，
       设置页补问过的没勾那几家不能因此从缓存里消失。 */
    mergeBalRows(rows);
    paintBal(box);
  }
  /* 设置页删掉一家自定义平台 → **这一家的余额卡要当场消失**，不等这一轮 60 秒。
     为什么要单独给一个口：refreshBalance 的第一件事是拿 localStorage 里的缓存先画一遍
     （为了切页/刷新时余额立刻可见），被删掉的那家在缓存里还留着，不先剔掉的话，
     删完看着还是「没删掉」，要等下一次真取数才消失。
     顺带把这一家从隐藏名单里也摘掉（清掉一个再也不存在的 kid），
     并让外壳立刻重画 —— 设置页在 iframe 里，靠外壳暴露的这个口（与 __themeApply 同一套路）。 */
  /* 「这两块显示不显示」被设置页改了之后，外壳立刻重画。
     设置页在 iframe 里，它写的是别人的键（sb_bal_on / sb_mirror_on）——
     所以要么它自己拼一遍余额卡与产物行（那就是第二份实现），
     要么由这里挂一个口出来（与 __themeApply / __sbApplyOpen 同一套路）。挂口。
     `paintBal` 开头会自己判「余额区关没关」，本机产物那块在 `mirrorBarHTML` 里判 ——
     所以这个口只是「重新读一次键、画一次」，不含任何规则。 */
  window.__sbApplyBalance = () => {
    try {
      /* 现在不用「再补插一次本机那一行」：paintBal 每画一次都现算 mirrorBarHTML()，
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
  /* 跨过 780 那条线时矮窗那一档会改卡片内边距，三张卡的高度跟着变：
     重新量一次（只量不改内容，不动别的节点）。 */
  let balFitTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(balFitTimer);
    balFitTimer = setTimeout(() => {
      fitBalCards(sb.querySelector('#sbBalance'));
      fitBalCards(balBubble);
    }, 150);
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
    notifyBal();
  };
  /* 设置页在 iframe 里改勾选 → 同源的 storage 事件送到外壳：直接按缓存重画，不用重取余额 */
  window.addEventListener('storage', e => {
    if (!window.SbBal || e.key !== SbBal.KEY) return;
    const box = sb.querySelector('#sbBalance');
    if (box && balRows.length) paintBal(box);
  });
  /* 别的页面广播「余额重取」是被动触发：走合船，不占「点抬头」那一档的补轮名额
     （写成箭头而不直接递函数，免得事件对象被当成 opts 读进去）。 */
  window.addEventListener('sb-balance-refresh', () => refreshBalance());
  refreshBalance();
  /* 定时器跑在外壳顶层文档，是全会话里活得最久的一个（web/app.js 切页只切 display、外壳不重建），
     所以它必须自己会「停」：
       · 后台标签页里一轮都不发 —— 不看 document.hidden 的话，切走一小时就是 60 轮 × (1+N) 个请求；
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
