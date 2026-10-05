/* ============================================================================
   AiChat —— 外壳层（shell.html）的 AI 助手：可拖动悬浮球 + 右侧抽屉
   ---------------------------------------------------------------------------
   一份实例挂在外壳，切页面只换 #appFrame 的内容，抽屉、对话记录、正在流式写出的
   那条回答都不重建。内容页里那行 <script src="ai-chat.js"> 仍然保留：页面被直接
   打开（没套外壳）时它自己挂载；套着外壳时检测到 window.top.__SB_SHELL 就直接退出。
   外壳为了这一层额外引了 assetlib.js / workbench.js / drama.js（注册表、能力声明、
   短剧与素材库都在那三份里），所以查询不再取决于脚下开的是哪一页。

   读：这一页自己的状态从 iframe 现取（frameWin() / __acPageCtx / 扫 DOM 的下拉当前值）。
   写：两个动作，都要用户在卡片上点「执行」才真做（见 ACTS）——一次生成任务或一次改设置。
       校验在卡片画出来之前做完；卡片上写明「哪一家、哪个型号、什么参数、素材从哪来」。
   附件：抽屉里拖入/选择的文件，身份（名字 / 类型 / 本机资产地址 / 文本快照）存 ai_chat_files，
       换页和刷新都还在；字节要么在本机资产（/asset/la_xxx）里，要么是加入时存的文本快照，
       两边都没有时 read_file 照实说「不在了」，让人重新拖。

   用法：AiChat.open() / .toggle() / .ask('问题') / .attach([File]) / .pageCtx(fn)。
   ========================================================================== */
(function () {
  'use strict';
  /* 公共层没齐不装（宁可没球，也别留一个点了什么都查不到的半个球） */
  if (!window.Api || !window.TextAI || !window.Store || !window.toast || !window.esc) return;
  const AS_SHELL = !!window.__SB_SHELL;
  if (!AS_SHELL) {
    /* 内容页：套在外壳里时让外壳那一份独一份，两个实例会各存一份记录、各画一个球 */
    try { if (window.top && window.top !== window.self && window.top.__SB_SHELL) return; } catch (e) {}
  }
  /* 设置页把 AI 助手关掉了就不装：球不画、抽屉不挂、Ctrl+/ 也不注册，对话记录一条都不碰。
     和「执行前不用我点确认」同一套「默认开 = 不存键」的写法 —— 只有明确存了 '1' 才算关，
     所以老用户升级后不用做任何事，助手照旧在。
     这一项是本机窗口的事，不跟着云同步（见 ui.js 的 NOT_SYNC）：
     在一台机器上关掉它，不该顺手把另一台也关了。 */
  const K_OFF = 'ai_chat_off';
  if (localStorage.getItem(K_OFF) === '1') return;

  const KEY = 'ai_chat';                 // 对话记录（Store 信封，跟着云同步走）
  const K_PICK = 'ai_chat_pick';         // 这里选的「供应方 + 型号」，**不写 sk_text_prov**（那是设置页的保存动作）
  const K_XY = 'ai_chat_xy';             // 悬浮球位置（{x,y}，拖动结束才落盘）
  const K_FILES = 'ai_chat_files';       // 附件的「身份」：名字 / 类型 / 本机资产地址（字节要么在本机资产里，要么是文本快照）
  const K_AUTO = 'ai_chat_auto';         // 「执行前不用我点确认」：只跳过那一下点击，校验与卡片照旧
  const K_SNAP = 'ai_chat_snap';         // 「拖到边上就吸住」（默认开；设置页那一项关掉 = 存 '0'）
  const K_WATCH = 'ai_chat_watch';       // 助手提交、还在等结果的任务 + 球上没看的条数（本机的事，不出网）
  const K_NOTICE = 'ai_chat_notice';     // 「出结果弹系统通知」：要浏览器授权，授权按钮在设置页那一卡
  const autoRun = () => localStorage.getItem(K_AUTO) === '1';
  const CAP = 60;                        // 单个会话的记录条数上限
  const SESS_CAP = 40;                   // 会话数上限（超了丢最久没用的那个，当前这条永远不丢）
  const TOOL_OUT = 7000;                 // 单条查询结果喂回模型的字数上限
  const CTX_ROOM = 60000;                // 一轮回答里查询结果最多占多少字（次数不设上限，兜底的是上下文，见 addCtx）
  const STALE_MAX = 2;                   // 同一个查询连着问几遍还没换内容就算它卡住了 —— 唯一的兜底，不写进提示词
  const HIST = 14, HIST_EACH = 900;      // 带进上下文的最近条数 / 每条截断
  const READ_DEF = 6000, READ_MAX = 20000;
  const STEP_CN = { 1: '讲故事', 2: '认角色', 3: '看预演', 4: '拍成片' };
  /* 生成工作台合并成一个页面之后，首屏缓存也只有一份（studio.html 写的），别再按类型分三个键 */
  const CACHES = { studio_tasks_cache_v1: '生成工作台历史' };
  /* scope → 条目上的 type 字段（AssetLib.normalize 写的是中文媒体类型） */
  const SCOPE_TYPE = { image: ['图片'], video: ['视频'], audio: ['音频', '音乐'] };
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|conf|ya?ml|toml|js|ts|tsx|jsx|css|scss|html|xml|srt|vtt|ass|py|sh|bat)$/i;
  /* Api.createBody 认的标准字段名（其余参数走 params 透传，但必须由型号声明过） */
  const STD = { count: 'max_outputs', duration: 'durations', res: 'resolutions', ar: 'aspect_ratios',
    quality: 'qualities', tier: 'tiers', format: 'output_formats' };
  const VAL_ZH = { count: '张数/条数', duration: '时长（秒）', res: '分辨率', ar: '画幅', quality: '质量档', tier: '档位', format: '输出格式' };
  const KIND_ZH = { image: '图片', video: '视频', audio: '语音', text: '文字' };
  /* 提示词里指代当前页：正文页文件名 → 界面上的名字。
     三个工作台合并成 studio.html 之后只有一条；`?t=` 只是落在同一页的不同类型上。 */
  const ACT_PAGE = { 'index.html': '导演台', 'drama.html': '拍短剧', 'chars.html': '素材库',
    'studio.html': '生成工作台（视频 / 图像 / 音频）', 'assets.html': '资产库', 'favorites.html': '收藏',
    'settings.html': '设置', 'usage.html': '用量与余额' };
  /* 左栏只有一个「生成工作台」入口，跳过去时按类型带上 ?t=（video / image / audio） */
  const STUDIO_T = { video: 'video', image: 'image', audio: 'audio' };

  let REG = null;
  let msgs = [];
  let live = null;                       // 正在流式写出的那条（换页要把已写的字落盘）
  let liveEl = null;                     // 那条气泡的 DOM 节点：paint() 全量重画后要把它原样挂回去
  let aborter = null;
  let files = [];                        // 输入框上**还没发出去**的附件（内存 File + 本机资产地址）
  /* 这一轮真正发出去的那一份。发完就把 files 清空，但这一轮还得继续用它 ——
     compose() 的 fileBlock() 与 attachImages() 读的是这个，不是 files。
     分成两个是因为它们是两件事：files 是「草稿」，这个是「这条消息带了什么」。
     这里带的是活的 File / blob: 引用（只在 send() 期间存在，绝不落盘）。 */
  let roundFiles = null;
  /* 助手这一头能看到的附件 = **这一轮真正发出去的那份**，没有就退回输入框上的草稿。
     所有读附件的地方（files 查询 / read_file / 生成卡片的 inputs 解析 / overview / doctor）
     一律走它 —— 直接读 files 的话，发完清空草稿就会让下一轮的 read_file 和
     「拿附件 0 当参考图提交」当场找不到东西，而那正是「文件发出去之后就不好使了」的另一半。 */
  const ctxFiles = () => (roundFiles && roundFiles.length) ? roundFiles : files;
  /* 会话表：{ v:2, cur:会话号, list:[{id,title,at,msgs,acts}] }。
     msgs / acts 仍然是模块级变量，切换会话时整体重新指向当前那一份 ——
     这样「提交任务的结果」也跟着会话走，刷新后还在（以前 acts 是纯内存的 const，
     一刷新就没了，用户追问「刚才那个任务怎么样了」助手必然答不上来）。 */
  let SESS = { v: 2, cur: '', list: [] };
  let acts = [];                         // 当前会话里发生过的动作（接回下一轮上下文，随会话落盘）
  const el = {};

  /* ---------- 小工具 ---------- */
  const esc = s => window.esc(s);
  const cap = (v, n) => { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) + '…（共 ' + s.length + ' 字，截断了）' : s; };
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const when = t => { const ms = Number(t) || 0; return ms ? new Date(ms).toLocaleString() : ''; };
  function jdump(o) { return cap(typeof o === 'string' ? o : JSON.stringify(o, null, 1), TOOL_OUT); }
  function $(id) { return document.getElementById(id); }

  /* ---------- 这一页 / 脚下那一页 ---------- */
  /* 外壳里的「页面」= iframe 里那份文档；内容页自挂载时就是自己。
     跨文档只在这两处开口：读 iframe 的 location/DOM，以及跳转时写外壳的 hash。 */
  function frameWin() {
    if (!AS_SHELL) return window;
    try { const f = $('appFrame'); return (f && f.contentWindow) || window; } catch (e) { return window; }
  }
  function hostDoc() {
    try { const w = frameWin(); return (w !== window && w.document) ? w.document : document; } catch (e) { return document; }
  }
  function navDoc() {
    if (AS_SHELL) return document;
    try { return (window.top && window.top.document) || document; } catch (e) { return document; }
  }
  function page() {
    try {
      const w = frameWin();
      if (w !== window) { const n = String(w.location.pathname || '').replace(/^.*\//, ''); if (n) return n; }
    } catch (e) {}
    const h = String(location.hash || '').replace(/^#\/?/, '').split('?')[0];
    if (h) return /\.[a-z]+$/i.test(h) ? h : h + '.html';
    return String(location.pathname || '').replace(/^.*\//, '') || 'index.html';
  }
  const pageZh = () => ACT_PAGE[page()] || page();
  /* 页面注册在这份 window 上的只读快照（拍短剧那种「闭包里的状态」） */
  function hostCtx() {
    try {
      const fn = frameWin().__acPageCtx;
      if (typeof fn !== 'function') return null;
      return fn();
    } catch (e) { return '页面快照失败：' + cap((e && e.message) || e, 160); }
  }
  /* 左栏导航项只从 DOM 现取，不在这里抄一份页面清单 */
  function navItems() {
    try {
      return [...navDoc().querySelectorAll('.sidebar nav a[data-page]')].map(a => ({
        page: a.getAttribute('data-page'),
        label: ((a.querySelector('.lb') || {}).textContent || a.textContent || '').trim(),
        active: a.classList.contains('active'),
      }));
    } catch (e) { return []; }
  }

  async function reg() {
    if (REG && REG.providers && REG.providers.length) return REG;
    try { REG = await Api.registry(); }
    catch (e) { throw new Error('本地代理没响应（' + ((e && e.message) || e) + '）—— 先确认 node proxy.js 在跑'); }
    return REG;
  }
  async function caps(r) {
    if (window.Capabilities) { try { await Capabilities.load(r); } catch (e) { /* 拉不到就用 registry 兜底声明 */ } }
  }
  /* 「这家能不能用」= 本机填了密钥，或服务端 .env 配了（envHas 内部 60 秒缓存） */
  async function usableMap(r) {
    const out = {};
    for (const p of (r.providers || [])) out[Api.keyId(p)] = !!(Api.key(p) || (await TextAI.envHas(p)));
    return out;
  }
  /* 一家平台在界面上是什么处境，三件事都不在注册表里，只能现问：
     ① 内置还是你在设置页自己加的（`prov.custom`，代理合并时打的标）；
     ② 你有没有把它「停用」（sk_off_<kid>，存在本机、只在本机生效，页面的下拉都按它过滤）；
     ③ 添加失败被丢掉的那些（/registry 的 custom.dropped —— 否则「我明明加了，助手却说没有这家」没法解释）。
     不报 ②：助手会说「这家可用」而页面下拉里根本没有它，两边各讲一套。 */
  function provFlags(r) {
    return {
      off: p => !!(window.Api && Api.isOff && Api.isOff(p)),
      src: p => (p.custom ? '自定义（照 ' + (p.customShapeName || p.customShape || '?') + ' 的接口形状）' : '内置'),
      /* 被丢掉的条目按 id 查（一家最多一条） */
      dropped: id => ((r.custom && r.custom.dropped) || []).filter(x => x && x.id === id)[0],
      notice: (r.custom && r.custom.reason) || '',
    };
  }
  const dramaRows = () => (window.Drama ? Drama.list() : Store.read('dramas', []) || []);
  const charRows = () => (window.Drama ? Drama.Lib.list() : Store.read('drama_chars', []) || []);

  function usageStat(days) {
    const arr = (window.TextAI && TextAI.readUsageLog()) || [];
    const span = num(days, 7);
    const cut = Date.now() - span * 864e5;
    const win = arr.filter(x => x && Number(x.at) >= cut);
    const sum = k => win.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const by = {};
    win.forEach(x => {
      const k = (x.prov || '?') + '/' + (x.model || '?');
      const b = by[k] || (by[k] = { 次数: 0, 输入tokens: 0, 输出tokens: 0 });
      b.次数++; b.输入tokens += Number(x.pt) || 0; b.输出tokens += Number(x.ct) || 0;
    });
    return { 总记录: arr.length, 窗口天: span, 窗口内次数: win.length, 输入tokens: sum('pt'), 输出tokens: sum('ct'), 按型号: by };
  }

  /* 界面上当前选中的下拉：扫脚下那页的 DOM，不用页面配合。
     抽屉自己的两个下拉要排掉（acProv / acModel），否则它会把自己的控件当成用户的。 */
  function domPicks() {
    const out = [];
    let list = [];
    try { list = [...hostDoc().querySelectorAll('select[id]')]; } catch (e) { return out; }
    list.forEach(s => {
      if (/^ac[A-Z]/.test(s.id)) return;
      /* 判可见要看包着它的那一层：Dropdowns 把原生 select 藏进 .dd 里当数据源（它自己永远不可见） */
      const probe = s.closest('.dd') || s;
      if (probe.offsetParent === null || s.closest('[hidden]')) return;
      const opts = [...(s.selectedOptions || [])];
      if (!opts.length) return;
      const lb = (s.labels && s.labels.length) ? s.labels[0]
        : (s.closest('label') || (s.parentElement && s.parentElement.querySelector('label')) || null);
      const name = String((lb && lb.textContent) || s.id).replace(/\s+/g, ' ').trim().slice(0, 18);
      const val = opts.map(o => String(o.textContent || o.value).trim()).join('、');
      out.push(name + ' = ' + val.slice(0, 46));
    });
    return out.slice(0, 16);
  }

  /* ============================================================================
     只读查询表：arg / doc / run 三份只写一次，系统提示词里的清单由这张表现拼。
     这一张表里全是 GET 与本机读，没有任何写入 —— 写入一律走下面的 ACTS（要确认）。
     ========================================================================== */
  const TOOLS = {
    overview: {
      arg: '无参数',
      doc: '本机现状一页：代理与平台、文字 AI 当前用哪家哪个型号、短剧/素材库/收藏/缓存/归档各有多少条、此刻在哪个页面、这次带了哪几个附件',
      async run() {
        const r = await reg();
        await caps(r);
        const ok = await usableMap(r);
        const pf = provFlags(r);
        const tp = TextAI.prov(r);
        const data = {};
        data.短剧 = dramaRows().length;
        data.素材库 = charRows().length;
        if (window.Fav) data.收藏 = Fav.list().length;
        if (window.AssetLib) Object.keys(CACHES).forEach(k => { data[CACHES[k]] = AssetLib.listCache(k).read().length; });
        try {
          const pl = window.PromptLog ? await PromptLog.list() : null;
          data.提示词归档 = pl ? pl.count : '没加载归档模块';
          data.归档目录 = pl && pl.dir;
        } catch (e) { data.提示词归档 = '取不到：' + cap((e && e.message) || e, 120); }
        const out = {
          此刻: { 页面: page() + '（' + pageZh() + '）', 时间: new Date().toLocaleString() },
          界面上选中的: domPicks(),
          代理: { 注册表版本: r.version || 0, 平台数: (r.providers || []).length },
          文字AI: tp ? { 供应方: tp.id, 名称: tp.name || tp.id, 型号: modelNow() || TextAI.model(tp), 本机密钥: !!TextAI.key(tp), 服务端密钥: await TextAI.envHas(tp) } : '注册表里没有 kind=text 的供应方（文字 AI 用不了）',
          平台: (r.providers || []).map(p => ({ id: p.id, 名称: p.name || p.displayName || p.id, 类型: p.kind,
            型号数: (p.models || []).length, 可用: !!ok[Api.keyId(p)],
            来源: pf.src(p), 停用: pf.off(p) ? '已停用（各页下拉里没有它，要问用户去设置页重新启用）' : '' })),
          本机数据: data,
          用量: usageStat(7),
          附件: ctxFiles().map((f, i) => i + ' = ' + f.name + '（' + f.kind + '，' + window.fmtBytes(f.size) + '）'),
        };
        /* 添加失败被丢掉的那些必须说出来，否则「我明明加了自定义平台，助手说没有这家」没法解释 */
        const dropped = ((r.custom && r.custom.dropped) || []).map(x => x.id + '：' + x.why);
        if (dropped.length) out.添加未生效的平台 = dropped;
        if (r.custom && r.custom.reason) out.自定义清单读不了 = r.custom.reason;
        const ctx = hostCtx();
        /* 「当前界面」这一项不是坏了，是**只有拍短剧那一页注册了快照**（它的关键状态在页面闭包里，外面读不到）。
           不写清这一句，模型会以为查询缺了一块、反复去找那个不存在的开关。 */
        if (ctx) out.当前界面 = ctx;
        else out.当前界面 = '这一页没有额外注册只读快照（它看得见的下拉值已经在「界面上选中的」里了）；只有拍短剧那一页有这一项';
        return out;
      },
    },
    tasks: {
      arg: '无参数',
      doc: '助手替你提交、还在等平台结果的那几条任务（这一条会真去平台问一次状态）；用户问「我刚那条怎么样了」就用它，别猜',
      async run() {
        const st = wread();
        if (!st.items.length) return '助手手上没有替你提交过还在等的任务。（你自己在图片台/视频台点的任务不归这里记，去那一页的列表看）';
        const { rows } = await probeWatch(st.items);
        return rows.map(o => ({
          任务号: o.rec.id, 平台: o.rec.prov, 型号: o.rec.model || '',
          提示词: cap(o.rec.prompt || '', 80), 提交于: when(o.rec.at), 现在: o.状态,
          产物: o.产物 || '', 错误: o.错误 || '',
        })).concat([{ 说明: '结掉的任务会当场在这一层说一声，并写进【这台机器上刚发生过的动作】；这里只留还在等的与这一轮刚问到的' }]);
      },
    },
    /* ---------- 本机历史任务：既给模型一份事实，也直接在下面画出卡片 ----------
       两条路，分工写清楚：
         · 默认（本地）读三个工作台那一份列表缓存 —— 立刻返回，但**只反映「这个浏览器上次拉到过什么」**。
         · remote:true 走 remoteHistory()，真去平台列表接口查账号里的全部任务。
       查到的条目一律画在回答下面：图片能看、视频能就地播、语音能听。 */
    history: {
      arg: '{ "remote": true, "kind": "image|video|audio|all", "provider": "平台 id", "status": "done|failed|…", "q": "关键词", "limit": 6, "pages": 2, "show": true }',
      doc: '本机历史任务与产物。默认查本机列表缓存（快、离线）；加 "remote": true 就真去平台的列表接口查这个账号下的全部任务（慢十几秒，只给声明了列表接口的平台）—— 用户说「平台上还有别的吗」「我换台机器做的」「删掉浏览器之后那些呢」就用 remote',
      async run(a) {
        return a && (a.remote || a.live || a.source === 'api') ? remoteHistory(a) : localHistory(a);
      },
    },
    models: {
      arg: '{ "kind": "image|video|audio|text" }（省略 = 全部）',
      doc: '平台与型号清单：每家的型号、参数取值、接受哪些输入槽位（上限与文件类型）',
      async run(a) {
        const r = await reg();
        await caps(r);
        const ok = await usableMap(r);
        const kind = String(a.kind || a.type || '').toLowerCase();
        const pf = provFlags(r);
        const list = (r.providers || []).filter(p => !kind || p.kind === kind);
        if (!list.length) return '没有 kind=' + kind + ' 的平台。不带 kind 再查一次可以看全部。';
        return list.map(p => ({
          平台: p.id, 名称: p.name || p.displayName, 类型: KIND_ZH[p.kind] || p.kind, 可用: !!ok[Api.keyId(p)],
          来源: pf.src(p), 停用: pf.off(p) ? '已停用（各页下拉里没有它，别替它提交任务）' : '',
          型号: (p.models || []).map(m => ({
            id: m.id, 名称: m.name || m.id,
            参数: cap(Object.entries(m.options || {}).filter(([k]) => k !== 'inputSpecs')
              .map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' · '), 700),
            输入: window.Capabilities ? Capabilities.specs(m).map(s => s.role + '×' + (s.max || '?') + (Capabilities.ruleText(m, s.role) ? '（' + Capabilities.ruleText(m, s.role) + '）' : '')).join('；') : '',
          })),
        }));
      },
    },
    model: {
      arg: '{ "id": "型号 id" }',
      doc: '单个型号的能力详情（参数取值、默认值、输入槽位与上限、能力来自平台接口还是本项目兜底声明）',
      async run(a) {
        const r = await reg();
        await caps(r);
        const want = String(a.id || a.model || '').trim();
        if (!want) return '要给型号 id，例如 {"id":"seedream-4"}。先用 models 查有哪些。';
        for (const p of (r.providers || [])) {
          const m = (p.models || []).find(x => x && (x.id === want || x.name === want));
          if (!m) continue;
          return {
            平台: p.id, 名称: p.name || p.displayName, 类型: p.kind, 型号: m.id, 显示名: m.name || m.id,
            能力来源: (window.Capabilities && Capabilities.sourceOf(p)) || '本项目兜底声明（还没从这家平台的 /models 取过）',
            参数: m.options || {},
            输入槽位: window.Capabilities ? Capabilities.specs(m) : (m.inputRoles || m.modes || '没有能力模块'),
            模型级声明: { modes: m.modes, maxRefImages: m.maxRefImages, output: m.output },
          };
        }
        return { 错误: '注册表里没有型号「' + want + '」', 提示: '先用 models 查出清单，id 要照抄' };
      },
    },
    dramas: {
      arg: '{ "id": "短剧 id" }（省略 = 全部）',
      doc: '短剧清单与进度：走到第几步、几段、几段已有画面、还差什么前置条件、能不能导成片',
      async run(a) {
        const rows = dramaRows();
        if (!rows.length) return '本机一部短剧都没有。去「拍短剧」新建一部（go {"page":"drama.html"}）。';
        const want = String(a.id || '').trim();
        const pick = want ? rows.filter(d => d && (d.id === want || d.title === want)) : rows;
        if (!pick.length) return '没有 id 或名称为「' + want + '」的短剧。不带 id 再查一次可以看全部。';
        let r = null;
        if (window.Drama && Drama.Pipe) { try { r = await reg(); } catch (e) { r = null; } }
        return pick.map(d => {
          const shots = d.shots || [];
          const o = {
            id: d.id, 名称: d.title, 第几步: d.step + '（' + (STEP_CN[d.step] || '?') + '）',
            段数: shots.length, 已有画面: shots.filter(s => (s.takes || []).some(t => t && t.state === 'done')).length,
            角色: (d.characters || []).length, 场景: (d.scenes || []).length,
            选中的视频模型: (d.opts || {}).videoModel || '（还没选）', 最后改动: when(d.updatedAt),
          };
          /* 前置条件与导出检查要读能力声明，代理没响应时不能把整条查询带崩 */
          if (window.Drama && Drama.Pipe && r) {
            try {
              const vm = Drama.Pipe.voiceMode(r, d.opts || {});
              const pre = Drama.Pipe.prereqs(d, null, vm);
              if (pre.length) o.还差 = pre.map(x => x.label + '：' + x.who);
              const edl = Drama.Pipe.edlCheck(d);
              o.能导成片 = !edl.missing.length;
              if (edl.missing.length) o.导不出 = edl.missing.slice(0, 10).map(x => '第 ' + x.no + ' 段：' + x.why);
            } catch (e) { o.检查 = '这一部算不下去：' + cap((e && e.message) || e, 140); }
          }
          if (want && d.story) o.故事 = cap(d.story, 1200);
          return o;
        });
      },
    },
    chars: {
      arg: '{ "q": "名字里含", "group": "分组名" }（都省略 = 全部）',
      doc: '素材库（跨剧复用的角色与场景）：类型（角色 / 场景）、分组、预览图 / 三视图或多角度图、音色（预设、描述、参考音频三种）、人设与描述',
      async run(a) {
        const rows = charRows();
        if (!rows.length) return '素材库还是空的。（拍短剧页的「认角色」那一步可以把角色与场景存进库；素材库页也能直接新建。）';
        const q = String(a.q || a.name || '').toLowerCase();
        const g = String(a.group || '').trim();
        let hit = q ? rows.filter(c => String(c.name || '').toLowerCase().includes(q)) : rows;
        if (g) hit = hit.filter(c => String(c.group || '').trim() === g);
        const n = num(a.limit, 40);
        /* 素材库的类型 / 预览图 / 描述这三条读法只在 drama.js 有一份；
           这一份查询在没有它的极端情况下（模块没加载上）退回裸字段，不能拿裸标识去猜。 */
        const D = window.Drama || null;
        const kindOf = c => D ? D.LIB_KINDS[D.libKindOf(c)] : (c.kind === 'scene' ? '场景' : '角色');
        const onlyVoice = c => !!D && D.voiceOnlyOf(c);
        const descOf = c => D ? D.descOf(c) : (c.look || c.desc || c.bio || '');
        const picOf = c => (D ? D.picOf(c) : (c.face || c.img)) || '';
        return { 共: rows.length, 匹配: hit.length, 条目: hit.slice(0, n).map(c => ({
          名称: c.name,
          类型: kindOf(c) + (onlyVoice(c) ? '（只出声）' : ''),
          分组: c.group || '',
          人设: cap(c.bio, 160), 描述: cap(descOf(c), 240),
          预览图: !!picOf(c), 候选图: (c.faces || []).length,
          /* 资产是**一个扁平列表**了（任意种类、不限张数、每张自己一个名字）。
             这里原来按字典的 `Object.keys(c.assets)` 遍历，在列表形状下恒为空 ——
             助手会说「这个角色没有资产」而界面上明明摆了四张；
             后来改成读 `a.kind`（类别），资产有了自己的名字之后又会与界面对不上。
             走 `Cast.assetsOf` 一份（老字典它会现算），报的是**用户自己起的名字**。 */
          资产: (window.Drama && Drama.Cast && Drama.Cast.assetsOf(c) || []).map(a => (Drama.Cast.assetName(a) || '?') + '=' + cap(a.src, 40)),
          音色: c.voice || '', 音色描述: cap(c.voiceNote, 120), 参考音频: !!c.refAudio,
        })) };
      },
    },
    fav: {
      arg: '{ "q": "关键词", "limit": 20 }',
      doc: '我的收藏：类型 / 平台 / 型号 / 提示词，q 会同时搜名称、提示词、平台与备注',
      async run(a) {
        if (!window.Fav) return '没加载收藏模块';
        const all = Fav.list();
        const q = String(a.q || '').toLowerCase();
        const hit = q ? all.filter(x => ((x.name || '') + ' ' + (x.prompt || '') + ' ' + (x.providerName || '') + ' ' + (x.provider || '') + ' ' + (x.type || '') + ' ' + (x.note || '')).toLowerCase().includes(q)) : all;
        const n = Math.min(num(a.limit, 20), 60);
        return { 共: all.length, 匹配: hit.length, 条目: hit.slice(0, n).map(x => ({
          类型: x.type, 名称: x.name || '', 平台: x.providerName || x.provider, 型号: x.model || '',
          时长: x.duration || null, 有产物: !!(x.src || x.dl || x.url), 收藏于: when(x.ts),
          备注: cap(x.note, 120), 提示词: cap(x.prompt, 240),
        })) };
      },
    },
    assets: {
      arg: '{ "scope": "image|video|audio|all", "status": "done|failed|…", "limit": 25 }',
      doc: '本机列表缓存里的产物与任务（不是平台实时状态，只反映「这个浏览器上次拉到过什么」）',
      async run(a) {
        if (!window.AssetLib) return '没加载资产库模块';
        const scope = String(a.scope || a.kind || 'all').toLowerCase();
        if (scope !== 'all' && !SCOPE_TYPE[scope]) return 'scope 只认 image / video / audio / all';
        const want = String(a.status || '').toLowerCase();
        const n = Math.min(num(a.limit, 25), 80);
        const out = [];
        Object.keys(CACHES).forEach(k => {
          const rows = AssetLib.listCache(k).read();
          /* scope 按条目自己的 type 筛（不是按缓存键分家 —— 现在只有一份缓存了） */
          const scoped = scope === 'all' ? rows
            : rows.filter(e => SCOPE_TYPE[scope].indexOf(String(e.type || '')) >= 0);
          const pick = want ? scoped.filter(e => String(e.status || '').toLowerCase() === want) : scoped;
          out.push({ 来源: CACHES[k], 条数: scoped.length, 列出: pick.slice(0, n).map(e => ({
            类型: e.type, 平台: e.providerName || e.provider, 型号: e.model || '', 状态: e.status || '',
            有产物: !!e.src, 时长: e.duration || null, 时间: when(e.created), 任务号: e.genId || e.id || '',
            提示词: cap(e.prompt, 200),
          })) });
        });
        return out;
      },
    },
    prompts: {
      arg: '{ "q": "关键词", "limit": 20 }',
      doc: '提示词归档（本机文件夹里的记录）：条数、目录、以及匹配到的归档（平台 / 型号 / 任务号 / 前 300 字）',
      async run(a) {
        if (!window.PromptLog) return '没加载归档模块';
        let d = null;
        try { d = await PromptLog.list(); }
        catch (e) { return '取不到归档索引：' + cap((e && e.message) || e, 160) + '（代理没在跑，或归档目录被移走了）'; }
        const q = String(a.q || '').toLowerCase();
        const rows = (d.recent || []).filter(r => !q || ((r.pr || '') + ' ' + (r.t || '') + ' ' + (r.m || '') + ' ' + (r.p || '')).toLowerCase().includes(q));
        const n = Math.min(num(a.limit, 20), 60);
        return { 总数: d.count, 目录: d.dir, 索引里扫到: (d.recent || []).length, 匹配: rows.length,
          条目: rows.slice(0, n).map(r => ({ 平台: r.p, 型号: r.m, 任务号: r.i, 类型: r.k, 标题: r.t, 时间: when(r.ts), 提示词: cap(r.pr, 320) })) };
      },
    },
    usage: {
      arg: '{ "days": 7 }',
      doc: '文字 AI 用量：次数与 tokens，按型号分组（只有 tokens，本平台不按元计费）',
      async run(a) { return usageStat(num(a.days || a.day, 7)); },
    },
    settings: {
      arg: '无参数',
      doc: '设置概况：文字 AI 选了哪家、各家的密钥/自定义地址/型号、识图与反问开关、主题、各页列表分页、归档目录（不回显任何密钥内容）',
      async run() {
        const r = await reg();
        const out = {
          文字AI: { 已保存的供应方: localStorage.getItem('sk_text_prov') || '（没选过，按默认可用逻辑挑）',
            识图开关: TextAI.visionMode(), 润色前反问: TextAI.askMode() },
          各家: [],
          界面: { 主题: localStorage.getItem('dir_theme') || 'light', 侧栏展开: localStorage.getItem('sb_open') || '', 侧栏余额: localStorage.getItem('sb_bal_show') || '' },
          /* 助手自己这一层的开关也报出来：用户问「为什么它刚才自己就提交了」要能答得上。
             这几项故意不在 writableKeys 白名单里 —— 「不用确认」能被 AI 自己打开是不安全的，
             系统通知的授权还在浏览器那一层，AI 改了开关也弹不出来。 */
          助手: { 执行前不用确认: autoRun() ? '已开启（卡片照画，校验做完就自动提交）' : '关闭（要点「执行」）',
            球吸附边缘: snapOn() ? '开' : '关',
            系统通知: (localStorage.getItem(K_NOTICE) === '1' ? '设置里勾了' : '没勾') + '；浏览器授权：'
              + (window.Notification ? Notification.permission : '这个浏览器不支持'),
            在等的任务: wread().items.length },
          列表分页: pageRows().map(x => ({ 页面: x.name, 模式: localStorage.getItem('page_mode_' + x.key) || x.defMode, 每页: localStorage.getItem('page_size_' + x.key) || x.defSize })),
          能改的: Object.keys(await writableKeys()),
          改不了的: 'sk_key_*（密钥）与 sk_base_*（自定义地址）只能你自己在设置页填 —— 助手碰它们会把密钥写进对话记录、或把 A 家的密钥发到 B 家的地址',
        };
        for (const p of TextAI.all(r)) {
          const kid = TextAI.keyId(p);
          out.各家.push({ 供应方: p.id, 本机密钥: !!localStorage.getItem('sk_key_' + kid), 服务端密钥: await TextAI.envHas(p),
            自定义地址: localStorage.getItem('sk_base_' + kid) || '（用官方地址 ' + (p.base || '?') + '）',
            保存的型号: localStorage.getItem('sk_model_' + kid) || '', 自己添的型号: TextAI.custom(p) });
        }
        try { const pl = window.PromptLog ? await PromptLog.list() : null; out.归档目录 = pl && pl.dir; } catch (e) { out.归档目录 = '取不到'; }
        return out;
      },
    },
    doctor: {
      arg: '{ "verify": true }（可选：真去问一次文字 AI 的密钥。只打余额 / 账户接口，不建任务）',
      doc: '一键体检：代理在不在线、版本新不新；四类平台各有几家**真能用**（密钥在本机还是服务端 .env）、哪几家被停用、设置页添加失败被丢掉的那几家；'
        + '数据目录 / 提示词归档 / 本机资产库读不读得动；**本机能不能出成片**（ffmpeg / ffprobe 装没装、三个落盘目录可不可写）；云同步配没配；助手自己的三个开关与浏览器通知授权。'
        + '用户说「怎么什么都没出来」「为什么提交不了」「导不出成片」「哪里配错了」先跑这一条，再按它说的那一项去修',
      async run(a) {
        let r = null;
        try { r = await Api.registry(); }
        catch (e) { return { 代理: '不在线：' + cap((e && e.message) || e, 160) + '（别的都查不了 —— 先跑「启动.bat」选 1，或 node proxy.js）' }; }
        await caps(r);
        const ok = await usableMap(r), pf = provFlags(r);
        const off = (r.providers || []).filter(p => pf.off(p)).map(p => p.id);
        const out = {
          代理: { 在线: true, 注册表版本: r.version || 0, 版本太旧: (Api.oldProxyNotice ? Api.oldProxyNotice(r.version) : '') || '不旧' },
          平台: ['image', 'video', 'audio', 'text'].map(k => {
            const all = (r.providers || []).filter(p => p.kind === k);
            const on = all.filter(p => !pf.off(p));
            const usable = on.filter(p => ok[Api.keyId(p)]);
            return { 类型: KIND_ZH[k] || k, 注册了几家: all.length, 停用几家: all.length - on.length,
              能用: usable.map(p => p.id + '（' + (Api.key(p) ? '本机密钥' : '服务端 .env') + '，' + (p.models || []).length + ' 个型号）').join(' / ')
                || (all.length ? '一家都不能用：' + on.map(p => p.id).join(' / ') + ' 都没配密钥' : '注册表里这一类根本没有平台') };
          }),
          停用: off.length ? off.join(' / ') + '（各页下拉里没有它们；这一项存在本机、只在这台机器生效）' : '没有',
          助手: { 执行前不用确认: autoRun() ? '开着（卡片照画，校验做完就自动提交）' : '关（要点「执行」）',
            球吸附边缘: snapOn() ? '开' : '关',
            系统通知: (localStorage.getItem(K_NOTICE) === '1' ? '设置里勾了' : '没勾') + '；浏览器授权：'
              + (window.Notification ? Notification.permission : '这个浏览器不支持'),
            在等的任务: wread().items.length, 没看的: wread().unread },
          本轮附件: ctxFiles().length ? ctxFiles().map((f, i) => i + ' = ' + f.name + '（' + f.kind + '）').join(' / ') : '没带附件',
        };
        const dropped = ((r.custom && r.custom.dropped) || []).map(x => x.id + '：' + x.why);
        if (dropped.length) out.添加未生效 = dropped;
        if (r.custom && r.custom.reason) out.自定义清单读不了 = r.custom.reason;
        /* 下面这几项各打一个本机接口，任何一项取不到都只写「取不到 + 原因」，
           不让一个慢接口把整份体检拖没（用户要的是「哪里坏了」，不是一个转圈的界面）。 */
        try { const d = await Net.json('/data', { timeout: 8000, retry: 0 }); out.数据目录 = { 路径: d.dir, 文件数: (d.files || []).length }; }
        catch (e) { out.数据目录 = '读不到：' + cap((e && e.message) || e, 120); }
        /* 导出成片用的是本机的 ffmpeg：没装 / 不在 PATH / 装的是商店那个占位壳，界面以前只在点「导出」时回一句「无法启动」。
           这里是代理真的起子进程探过一次，三种原因分开写；旧代理没有这个接口，就照实说「要重启」。
           「能不能用 / 为什么」那两档的说法用 Api.sysTool / Api.sysDir —— 与设置页「本机环境」那一栏同一个口径，
           免得出现「设置页说能用、助手说不能用」。版本那串太长，助手这边只截一次。 */
        try {
          const sy = await Api.sysStatus();
          const tl = k => { const t = Api.sysTool(sy[k]); return t.chip + (t.why ? (t.cls === 'ok' ? '（' + cap(t.why, 60) + '）' : '：' + cap(t.why, 130)) : ''); };
          const dd = sy.目录 || {};
          out.成片环境 = {
            ffmpeg: tl('ffmpeg') + ' —— ' + Api.SYS_WHY.ffmpeg,
            ffprobe: tl('ffprobe') + ' —— ' + Api.SYS_WHY.ffprobe,
            目录: ['数据', '资产', '渲染'].map(n => n + '=' + Api.sysDir(dd[n]).chip).join(' · '),
            代理: '端口 ' + ((sy.代理 || {}).端口 || '?') + ' · 注册表 v' + ((sy.代理 || {}).版本 || '?'),
          };
        } catch (e) {
          out.成片环境 = e && e.status === 404
            ? '这个代理是加体检接口之前启动的旧进程（重启 proxy.js 后才有 ffmpeg 与目录那几项）'
            : '读不到：' + cap((e && e.message) || e, 120);
        }
        try { const la = await Net.json('/local-assets', { timeout: 8000, retry: 0 }); out.本机资产 = (la.data || []).length + ' 条'; }
        catch (e) { out.本机资产 = '读不到：' + cap((e && e.message) || e, 120); }
        try { const pl = window.PromptLog ? await PromptLog.list() : null; out.提示词归档 = pl ? { 条数: pl.count, 目录: pl.dir } : '没加载归档模块'; }
        catch (e) { out.提示词归档 = '读不到：' + cap((e && e.message) || e, 120); }
        try { const c = await Net.json('/cloud/status', { timeout: 8000, retry: 0 });
          /* 「配没配」有两处：本机这份（sk_cloud_*，只在设置页填过才有）与服务端 .env。
             只看一处就会出现「助手说没配云，其实另一台机器一直在同步」。 */
          const local = !!localStorage.getItem('sk_cloud_url');
          out.云同步 = { 本机填过地址: local ? (localStorage.getItem('sk_cloud_url') || '') : '没有（只在本机用也行）',
            服务端env: c.envConfigured ? '配了' : '没配',
            上次: (c.lastAt ? when(c.lastAt) + ' · ' + (c.lastResult || '') : '还没同步过'),
            待处理冲突: (c.conflicts || []).length + ' 条（有冲突要在设置页「数据与备份」二选一，助手不替你选）' }; }
        catch (e) { out.云同步 = '读不到状态：' + cap((e && e.message) || e, 120); }
        if (a && (a.verify === true || a.verify === 'true' || a.deep)) {
          const tp = TextAI.prov(r);
          out.文字AI密钥 = tp ? (await TextAI.verifyKey(r, tp)).text : '没有文字 AI 供应方可验';
        } else out.文字AI密钥 = '没验（带 {"verify":true} 再问一次：只打余额接口、不建任务）';
        return out;
      },
    },
    credits: {
      arg: '{ "provider": "平台 id" }（省略 = 全部有余额接口的平台）',
      doc: '平台余额（要联网，慢一点；计价单位按各家声明）',
      async run(a) {
        const r = await reg();
        const pf = provFlags(r);
        const list = a.provider ? [Api.prov(a.provider)] : Api.providers();
        if (a.provider && !list[0]) {
          /* 找不到的两种原因分开说：这一家被删掉了 / 只是这一家不在注册表里。
             自定义平台是「本机 sk_custom + 代理合并」那条路，说清去哪看。 */
          const all = (r.providers || []).map(p => p.id);
          return '没有这个平台 id：' + a.provider + '（现在有的：' + cap(all.join(' / '), 300) + '。'
            + '在设置页加过却不在这里 = 添加没通过校验，去「供应商与密钥」那一卡看原因）';
        }
        const out = [];
        for (const p of list.filter(Boolean)) {
          if (!p.endpoints || !p.endpoints.credits) { if (a.provider) out.push({ 平台: p.id, 余额: '这个平台没声明余额接口' }); continue; }
          try {
            const raw = await Api.request(p, 'credits');
            out.push(Object.assign({ 平台: p.id, 名称: p.name || p.displayName, 停用: pf.off(p) ? '这一家在界面上是停用状态（余额照实问）' : '' }, Api.balance(p, raw)));
          } catch (e) { out.push({ 平台: p.id, 错误: cap((e && e.message) || e, 200) }); }
        }
        return out.length ? out : '这些平台都没声明余额接口';
      },
    },
    go: {
      arg: '{ "page": "drama.html" }（生成工作台可带类型：studio.html?t=video|image|audio）',
      doc: '带你跳到左栏里的某个页面（只是跳转，不改任何数据）。「生成工作台」是图片/视频/语音合并的一页，用 ?t= 指定落在哪一栏',
      async run(a) {
        const kids = navItems();
        if (!kids.length) return '这一页没套外壳（左栏不在），跳不了。直接用浏览器地址栏打开。';
        const raw = String(a.page || a.to || '').trim();
        /* 别名与 ?t= 都认：模型多半会写 studio.html?t=video，也可能写旧的 video-gen.html */
        const [page0, query0] = raw.split('?');
        const alias = { 'image-gen': 'studio', 'video-gen': 'studio', 'audio-gen': 'studio',
          image: 'studio', video: 'studio', audio: 'studio', 图片台: 'studio', 视频台: 'studio', 语音台: 'studio' }[page0.replace(/\.html$/i, '')];
        const want = (alias || page0).replace(/\.html$/i, '');
        const tRaw = (query0 || '').replace(/^t=/, '').trim();
        const t = STUDIO_T[String(a.kind || '').toLowerCase()] || STUDIO_T[tRaw] || '';
        if (!want) return { 可选: kids.map(x => x.page + ' = ' + x.label) };
        const hit = kids.find(x => String(x.page || '').replace(/\.html$/i, '') === want);
        if (!hit) return { 错误: '左栏里没有「' + a.page + '」', 可选: kids.map(x => x.page + ' = ' + x.label) };
        const target = hit.page + (t && hit.page === 'studio.html' ? '?t=' + t : '');
        try {
          if (AS_SHELL) location.hash = '#' + target;
          else window.top.location.hash = '#' + target;
        } catch (e) { return { 错误: '跳转失败：' + cap((e && e.message) || e, 160) }; }
        return { 已跳转: target + '（' + hit.label + (t ? ' · ' + (t === 'image' ? '图像' : t === 'audio' ? '音频' : '视频') : '') + '）',
          注意: '助手挂在外壳，切页面不会打断正在写的回答' };
      },
    },
    files: {
      arg: '无参数',
      doc: '这次带进来的附件清单（序号、名字、类型、大小、本机地址）—— 要看内容用 read_file，要拿去生成用 RUN generate 的 inputs。发出去之后草稿就清空了，问的始终是**上一条消息真正带的那几份**',
      async run() {
        const list = ctxFiles();
        if (!list.length) return '没有附件。让用户把文件拖到抽屉里，或点输入框下面的「＋文件」。';
        return list.map((f, i) => ({
          序号: i, 名称: f.name, 类型: f.kind, 大小: window.fmtBytes(f.size),
          mime: f.mime || '（没声明）', 本机地址: f.src || '（没落盘）', 本机资产: f.la || '',
          还在: f.file ? '在（这一次拖进来的那个 File）'
            : LOCAL_SRC.test(f.src || '') ? '在（本机资产里有这一份，按地址回源）'
            : f.txt ? '在（加入时存的文本快照）' : '不在了（字节读不到，要让人重新拖进来）',
          说明: f.note || '',
        }));
      },
    },
    read_file: {
      arg: '{ "index": 0, "chars": 6000, "ask": "想让图里看出什么" }',
      doc: '读一个附件的内容：文本给原文；图片在当前文字型号支持识图时真的去看；视频/音频读不出内容（本机没有听/看视频的模型）',
      async run(a) {
        const i = Number(a.index);
        const list = ctxFiles();
        const rec = Number.isFinite(i) ? list[i] : null;
        if (!rec) return '没有序号 ' + i + ' 的附件（当前 ' + list.length + ' 个，从 0 数）。先用 files 查清单。';
        if (!rec.file && !rec.txt && !LOCAL_SRC.test(rec.src || '')) {
          return '「' + rec.name + '」的字节已经不在了（本机资产里也没有这一份）：让用户重新拖进来。';
        }
        if (rec.kind === '文本') {
          let txt = '', from = '原文';
          const src = await fileBytes(rec);
          if (src && src.text) { try { txt = await src.text(); } catch (e) { txt = ''; } }
          if (!txt && rec.txt) { txt = rec.txt; from = '加入时存的快照（最长 ' + READ_MAX + ' 字）'; }
          if (!txt) return '「' + rec.name + '」这份文本读不出内容：让用户重新拖进来一次。';
          const n = Math.min(num(a.chars, READ_DEF), READ_MAX);
          return { 名称: rec.name, 字数: txt.length, 来源: from, 内容: cap(txt, n) };
        }
        if (rec.kind === '图片') {
          const r = await reg();
          const prov = await provNow();
          const model = modelNow();
          if (!prov || !model) return '没法看图：文字 AI 还没选到型号（在抽屉里选一家，或到设置页「文字 AI」那一档填）。';
          const vis = await TextAI.visionAsync(r, prov, model);
          if (!vis.ok) return '型号「' + vis.model + '」不能识图（' + vis.why + '）。要真看图就在抽屉里换成支持图片的型号，或到设置页把「识图能力」设为支持。';
          const imgs = await TextAI.prepImages([{ label: rec.name, src: rec.file || rec.src }], { max: 1 });
          if (!imgs.length) return '这张图读不出像素（可能损坏或不是图片）。';
          const ask = String(a.ask || '说清画面里真实可见的内容：主体、场景、光线、色调、构图，以及能用于生图的描述要点。');
          try {
            const txt = await TextAI.chat(r, '你是看图助手。只说这张图里真实可见的内容，不要编造、不要替它补没画出来的东西。用中文，短句。',
              ask, { images: imgs, model }, prov);
            return { 名称: rec.name, 型号: model, 看到的: cap(txt, TOOL_OUT) };
          } catch (e) { return '看图这一步失败了：' + cap((e && e.message) || e, 220); }
        }
        return { 名称: rec.name, 类型: rec.kind, 大小: window.fmtBytes(rec.size),
          结论: '本机没有听视频/音频内容的模型，读不出里面的内容。需要它参与生成就直接当素材提交（RUN generate 的 inputs），不要替它编内容。' };
      },
    },
  };

  /* ============================================================================
     写入动作表：check 只读、纯校验；卡片画出来之前必须校验完，
     所以不可能出现「点执行才撞错」。run 才是真发请求的那一步，只在用户点「执行」时调。
     ========================================================================== */
  /* 素材来源只有三种写法，都在本机解释成「要不要先取字节」：
     { file: 序号 } → 抽屉里的附件；{ url: '/asset/la_x' 或 '/getv?url=…' } → 本机读得到的地址；
     { asset: 'la_x' } 走本机文件，{ asset: '平台资产号' } 直接引用（那种号上游自己认得，
     拼成 /asset/<id> 反而 404 —— 那条路由只服务本工作台落盘的产物）。 */
  function inputSrc(en) {
    if (!en || typeof en !== 'object') return null;
    if (Number.isFinite(Number(en.file))) {
      const rec = ctxFiles()[Number(en.file)];
      if (!rec) return null;
      /* File 优先；换页之后只剩本机资产地址（blob: 那一层早就失效了，递过去等于必败） */
      const v = rec.file || (LOCAL_SRC.test(rec.src || '') ? rec.src : '');
      return v ? { kind: 'bytes', val: v } : null;
    }
    if (en.asset) {
      const s = String(en.asset).trim();
      if (!s) return null;
      return s.startsWith('la_') ? { kind: 'bytes', val: '/asset/' + s } : { kind: 'assetId', val: s };
    }
    if (en.url) {
      const u = String(en.url).trim();
      /* 只接本机地址：外网直链要么先收藏进资产库，要么走 files，别让助手把素材寄到别处 */
      if (!/^(\/asset\/|\/getv\/|\/local-assets\/)/.test(u)) return null;
      return { kind: 'bytes', val: u };
    }
    return null;
  }
  /* 「输入项」那行只描述来源，具体形状由 registry 的 inputTemplates 决定 */
  function inputNote(en, idx) {
    if (Number.isFinite(Number(en.file))) {
      const rec = ctxFiles()[Number(en.file)];
      return rec ? '第 ' + Number(en.file) + ' 个附件「' + rec.name + '」（' + rec.kind + '，' + window.fmtBytes(rec.size) + '）'
        : '第 ' + Number(en.file) + ' 个附件（已经不在了）';
    }
    if (en.asset) return (/^la_/.test(String(en.asset)) ? '本机资产 ' : '平台资产 ') + cap(String(en.asset), 40);
    if (en.url) return '本机地址 ' + cap(String(en.url), 60);
    return '第 ' + idx + ' 项（没写来源）';
  }
  function optList(o, key) {
    const v = o[key];
    return Array.isArray(v) ? v : (v == null ? null : [v]);
  }
  /* 单个参数按型号声明校验：返回 { 值 } 或 { 错 } */
  function checkParam(model, key, val) {
    const o = (model && model.options) || {};
    if (!Object.prototype.hasOwnProperty.call(STD, key)) {
      return { 错: '参数「' + key + '」不是通用字段，型号声明里能带什么参数请用 model 查询看 options' };
    }
    if (val === undefined || val === null || val === '') return { 错: key + ' 没给值' };
    /* 声明来源没有这一项 = 这个型号压根没有这个参数（不要放行让上游去拒） */
    const decl = optList(o, STD[key]);
    if (!decl) return { 错: '型号「' + model.id + '」没声明 ' + STD[key] + '，不能发 ' + key };
    if (key === 'count') {
      const n = Number(val), max = Number(decl[0]);
      if (!Number.isFinite(n) || n < 1) return { 错: 'count 要 ≥1 的整数' };
      if (Number.isFinite(max) && n > max) return { 错: 'count 最多 ' + max + '（型号声明的 max_outputs）' };
      return { 值: Math.round(n) };
    }
    if (key === 'duration') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) return { 错: 'duration 要秒数' };
      const nums = decl.map(Number).filter(Number.isFinite);
      /* durations 给两个升序数字 = 区间（video-gen.html 同一套约定），否则是离散档位 */
      if (nums.length === 2 && nums[1] >= nums[0]) {
        if (n < nums[0] || n > nums[1]) return { 错: 'duration 要在 ' + nums[0] + '–' + nums[1] + ' 秒之间（型号声明）' };
        return { 值: n };
      }
      if (!nums.includes(n)) return { 错: 'duration 只能取 ' + nums.join(' / ') + '（型号声明的档位）' };
      return { 值: n };
    }
    const want = String(val);
    const hit = decl.find(x => String(x) === want);
    if (hit === undefined) {
      /* 分辨率这类写成 '768p'，数值相同也算（用户和模型都会写 768） */
      const asNum = v => Number(String(v).replace(/[^0-9.]/g, ''));
      const eq = decl.find(x => asNum(x) && asNum(x) === asNum(want));
      if (eq !== undefined) return { 值: String(eq) };
      return { 错: key + '「' + want + '」不在型号声明的取值里：' + decl.join(' / ') };
    }
    return { 值: want };
  }
  async function genCheck(a, pin) {
    if (!a || typeof a !== 'object') return { err: 'generate 的参数要是一个 JSON 对象' };
    const r = await reg();
    await caps(r);
    const p = Api.prov(String(a.provider || a.prov || '').trim());
    if (!p) {
      const can = (r.providers || []).filter(x => x.kind !== 'text');
      return { err: '没有平台 id「' + (a.provider || '') + '」。能提交的是：' + can.map(x => x.id + '（' + (KIND_ZH[x.kind] || x.kind) + '）').join(' / ') };
    }
    if (p.kind === 'text') return { err: '文字 AI 是助手自己对话用的，不是提交生成任务的地方' };
    if (p.kind === 'audio') return { err: '语音是同步合成、上游没有任务号可跟，合成与落盘那套管子在生成工作台的音频那一栏里（含音色复刻的参考音频处理），助手不另写一份。要合成请去生成工作台（go {"page":"studio.html?t=audio"}）' };
    const ok = await usableMap(r);
    if (!ok[Api.keyId(p)]) return { err: '「' + (p.name || p.id) + '」还没配密钥，提交一定失败（设置页配好再来）' };
    /* 停用是**本机**的开关（sk_off_<kid>，各页下拉按它过滤），不在注册表里也不在白名单里：
       助手能替你提交、却不能替你把它重新启用 —— 那就照实拦下来并说清去哪开。 */
    if (Api.isOff(p)) return { err: '「' + (p.name || p.id) + '」你在设置页里停用了（各页的下拉都没有它）。要去设置页「供应商与密钥」重新启用再提交，这个开关助手不替你动' };
    const m = (p.models || []).find(x => x && (x.id === a.model || x.name === a.model));
    if (!m) return { err: '「' + p.id + '」没有型号「' + (a.model || '') + '」。这一家的型号：' + (p.models || []).map(x => x.id).join(' / ') };
    const prompt = String(a.prompt == null ? '' : a.prompt).trim();
    if (!prompt) return { err: 'generate 要写 prompt（提示词）' };

    const params = {};
    for (const [k, v] of Object.entries(a.params || a.options || {})) {
      const c = checkParam(m, k, v);
      if (c.错) return { err: c.错 };
      params[k] = c.值;
    }

    const ins = Array.isArray(a.inputs) ? a.inputs : [];
    const roles = ins.map(x => String((x && x.role) || '').trim());
    const spec = window.Capabilities ? Capabilities.specs(m) : [];
    const have = new Set(spec.map(s => s.role));
    if (spec.length) {
      const bad = roles.filter(x => x && !have.has(x));
      if (bad.length) return { err: '型号「' + m.id + '」不接受输入槽位：' + [...new Set(bad)].join(' / ') + '。它接受的是：' + spec.map(s => s.role).join(' / ') };
      if (window.Capabilities) {
        const pairs = Capabilities.illegalPairs(m, roles);
        if (pairs.length) return { err: '这些槽位不能同时用（不同组互斥）：' + pairs.map(x => x.join(' + ')).join('；') };
      }
    }
    const perRole = {};
    for (let i = 0; i < ins.length; i++) {
      const en = ins[i], role = roles[i];
      const src = inputSrc(en);
      if (!src) return { err: 'inputs 第 ' + i + ' 项取不到来源（file 序号要指向 files 查询里存在的附件，或用本机 asset 号）' };
      if (!Api.inputTemplate(p, role)) return { err: '注册表没声明 ' + (role || '（没写 role）') + ' 的提交形状，这个槽位发不出去' };
      perRole[role] = (perRole[role] || 0) + 1;
      if (window.Capabilities) {
        const rule = Capabilities.rule(m, role);
        if (rule.max && perRole[role] > rule.max) return { err: role + ' 最多 ' + rule.max + ' 个（型号声明），这次给了 ' + perRole[role] + ' 个' };
        if (rule.maxBytes) {
          const rec = Number.isFinite(Number(en.file)) ? ctxFiles()[Number(en.file)] : null;
          if (rec && rec.size > rule.maxBytes) return { err: '「' + rec.name + '」' + window.fmtBytes(rec.size) + ' 超过 ' + role + ' 的单文件上限 ' + window.fmtBytes(rule.maxBytes) };
        }
        if (rule.accept) {
          const rec = Number.isFinite(Number(en.file)) ? ctxFiles()[Number(en.file)] : null;
          if (rec && rec.mime) {
            const allow = String(rule.accept).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
            if (allow.length && !allow.some(x => x === rec.mime || (x.endsWith('/*') && rec.mime.startsWith(x.slice(0, -2))))) {
              return { err: '「' + rec.name + '」是 ' + rec.mime + '，' + role + ' 只收 ' + rule.accept };
            }
          }
        }
      }
    }
    /* 只收文字就能跑的型号，inputs 空着也合法；有 min 的槽位要拦住 */
    if (window.Capabilities) {
      for (const s of spec) {
        const mn = s.min || 0;
        if (mn && (perRole[s.role] || 0) < mn) return { err: '这个型号必须给 ' + s.role + '（至少 ' + mn + ' 个），这次给了 ' + (perRole[s.role] || 0) + ' 个' };
      }
    }
    const 参数行 = Object.entries(params).map(([k, v]) => (VAL_ZH[k] || k) + '：' + v);
    /* 卡片上写的是「素材 ← 附件第 0 个（猫.png）」，靠的是**画卡片那一刻**的序号。
       卡片挂着的时候用户又加/删/换了一个附件，序号就会漂到别的文件上 ——
       执行前按（序号 + 名字 + 本机地址）复核一次，对不上就退回重问，绝不拿另一份素材替用户提交。 */
    const 钉 = ins.map((en, i) => {
      const idx = Number(en && en.file);
      const rec = Number.isFinite(idx) ? ctxFiles()[idx] : null;
      return rec ? { slot: i, idx, name: String(rec.name || ''), src: String(rec.src || '') } : null;
    }).filter(Boolean);
    const drift = (Array.isArray(pin) ? pin : []).filter(x => {
      const rec = ctxFiles()[x.idx];
      return !rec || String(rec.name || '') !== x.name || String(rec.src || '') !== x.src;
    });
    if (drift.length) {
      const w = drift.map(x => '第 ' + x.idx + ' 个（卡片上原本是「' + cap(x.name, 40) + '」）').join('、');
      return { err: '附件已经变了：' + w + ' —— 现在那个位置不是它了（被移走、被换掉，或者你新加了附件把顺序挪了）。'
        + '这份素材不能凭序号猜，请重新问一次，让卡片按现在这份附件重画' };
    }
    const 素材行 = ins.map((en, i) => en.role + ' ← ' + inputNote(en, i));
    const 页 = '生成工作台';
    return {
      说明: '提交到「' + (p.name || p.id) + '」（' + p.id + '）· 型号 ' + m.id + ' · ' + 参数行.length + ' 个参数 · ' + 素材行.length + ' 个素材',
      人话: ['平台：' + (p.name || p.id) + '（' + p.id + '，' + (KIND_ZH[p.kind] || p.kind) + '）',
        '型号：' + m.id + (m.name && m.name !== m.id ? '（' + m.name + '）' : ''),
        '提示词：' + cap(prompt, 400),
        '参数：' + (参数行.length ? 参数行.join(' · ') : '（不额外指定，按型号默认）'),
        '素材：' + (素材行.length ? 素材行.join('；') : '（纯文字生成，不带素材）'),
        '之后：这一条会出现在「' + 页 + '」的任务列表里，本机不认领进度以外的东西'],
      prov: p, model: m, params, prompt, inputs: ins, 钉,
    };
  }
  async function runGenerate(a, pin) {
    const chk = await genCheck(a, pin);
    if (chk.err) throw new Error(chk.err);
    const entries = [];
    for (let i = 0; i < (chk.inputs || []).length; i++) {
      const en = chk.inputs[i];
      const src = inputSrc(en);
      if (!src) throw new Error('素材少了（第 ' + i + ' 项）：附件在点执行之前被移出或页面刷新过，重新带一次');
      if (src.kind === 'assetId') { entries.push({ role: en.role, assetId: src.val }); continue; }
      const e = await AssetTransfer.entryFor(chk.prov, en.role, src.val, { reg: REG, name: 'AI助手-' + en.role });
      if (!e) throw new Error('注册表没声明 ' + en.role + ' 的提交形状，这个槽位发不出去');
      entries.push(e);
    }
    /* Api.createBody 认的是**顶层字段名**（count/duration/res/ar/quality/tier/format），
       不是 params —— params 会被嵌进平台的 parameters 对象，那种位置只有声明过的泛型参数才该去。 */
    const raw = await Api.create(chk.prov, Object.assign({ model: chk.model.id, prompt: chk.prompt }, chk.params,
      { inputEntries: entries, note: 'AI 助手提交' }));
    const p = Api.parseItem(chk.prov, raw) || {};
    const 页 = chk.prov.kind === 'video' ? '视频' : '图像';
    const t = chk.prov.kind === 'video' ? 'video' : 'image';
    const 状态 = p.status ? String(p.status) : (raw && raw.id ? '已受理' : '已提交');
    const lines = ['已提交到 ' + (chk.prov.name || chk.prov.id) + ' · ' + chk.model.id,
      '任务号：' + (p.genId || (raw && raw.id) || '（接口没回任务号）'),
      '状态：' + 状态 + '（后面由生成工作台的统一轮询接着刷）',
      '去看：生成工作台 · ' + 页 + '（go {"page":"studio.html?t=' + t + '"}）'];
    if (p.error) lines.push('接口同时报了：' + cap(String(p.error), 200));
    /* 有任务号才挂等待：接口没回号（或直接判失败）就没有可跟的东西，别挂一条永远问不出结果的等待 */
    const taskId = p.genId || (raw && raw.id) || '';
    if (taskId && !p.failed) {
      addWatch({ id: String(taskId), prov: chk.prov.id, kind: chk.prov.kind, model: chk.model.id, prompt: cap(chk.prompt, 80) });
      lines.push('提醒：出结果（或一等超时没结果）我会在这层说一声，抽屉关着时球上也会点个数字'
        + (localStorage.getItem(K_NOTICE) === '1' && window.Notification && Notification.permission === 'granted'
          ? '，并按你在设置页勾的那样弹一次系统通知' : ''));
    }
    return { ok: !!p.genId || !p.failed, text: lines.join('\n'), id: taskId };
  }

  /* 能改的设置项白名单。密钥与自定义地址**故意不在里面**：
     sk_key_* 会把密钥写进对话记录（.data/ai_chat.json 跟着云同步出网），
     sk_base_* 容易造成「A 家密钥打到 B 家地址」那种必然失败的组合。 */
  const ADJUST = {
    dir_theme: { 名: '界面主题', 取值: ['light', 'dark'], 说: '改完外壳和当前页立刻跟着换色' },
    sk_polish_ask: { 名: 'AI 润色前是否反问', 取值: ['ai', 'on', 'off'], 说: 'ai = 由文字 AI 自己判断要不要先问要点' },
    sk_text_vision: { 名: '文字 AI 识图', 取值: ['auto', 'on', 'off'], 说: 'auto = 先看接口字段再看平台声明；按模型名猜是禁止的' },
  };
  function pageRows() {
    const t = window.PAGE_TARGETS;
    return (t && t.rows) || [];
  }
  /* 拍短剧那张设置表在 drama.js 里。外壳层引了它；单页被直接打开时这一页多半没引，
     就现取一次 —— 否则同一个助手「从外壳进」和「直接开页面」两种情况下能改的清单不一样，
     用户在设置页看得见的开关，助手却回一句「不让改这一项」。 */
  let dramaLib = null;
  async function dramaSET() {
    if (window.Drama && window.Drama.SET) return window.Drama.SET;
    if (!dramaLib) dramaLib = new Promise(res => {
      const s = document.createElement('script');
      s.src = 'drama.js';
      s.onload = s.onerror = () => setTimeout(() => res((window.Drama && window.Drama.SET) || null), 0);
      document.head.appendChild(s);
    });
    return dramaLib;
  }
  async function writableKeys() {
    const out = Object.assign({}, ADJUST);
    const t = window.PAGE_TARGETS || { rows: [], modes: ['page', 'more'], size: { min: 1, max: 100 } };
    (t.rows || []).forEach(x => {
      out['page_mode_' + x.key] = { 名: x.name + ' · 列表模式', 取值: t.modes || ['page', 'more'], 说: 'page = 翻页，more = 加载更多' };
      out['page_size_' + x.key] = { 名: x.name + ' · 每页条数', 范围: t.size || { min: 1, max: 100 }, 说: '整数' };
    });
    /* 界面偏好（主题 / 侧栏开合 / 两个列表页的视图档位）整张表来自 ui.js 的 UI_PREFS ——
       设置页那一栏的控件也是它渲染的。两边读同一张表才不会出现「设置页有这一项、助手说改不了」，
       取值也只能是那一页真认的那几个（资产库 card/compact、收藏 list/compact 本来就不一样）。 */
    const up = window.UI_PREFS || { rows: [] };
    (up.rows || []).forEach(r => {
      out[r.key] = r.kind === 'bool'
        ? { 名: '界面 · ' + r.name, 取值: ['1', '0'], 说: '1 = 开启，0 = 关掉。' + (r.hint || '') }
        : { 名: '界面 · ' + r.name, 取值: (r.opts || []).map(o => o[0]),
          说: (r.opts || []).map(o => o[0] + ' = ' + o[1]).join('；') + '。' + (r.hint || '') };
    });
    /* 键名、默认值、取值全来自 drama.js 的 Drama.SET，这里照同一张表列出来。
       再抄一份键名就会出现「助手能改的」和「设置页有的」对不上。 */
    const DS = await dramaSET();
    if (DS) Object.keys(DS).forEach(id => {
      const it = DS[id];
      if (it.kind === 'bool') out[it.key] = { 名: '拍短剧 · ' + it.label, 取值: ['1', '0'], 说: '1 = 开启，0 = 关掉' };
      else if (it.kind === 'num') out[it.key] = { 名: '拍短剧 · ' + it.label, 数值: true,
        /* 单位与「它管不了什么」都照声明走：SET 里 durMin 把单位写在名称里、没给 unit，
           maxTakes 单给 unit。写成固定的一句「单位是分钟」就会对着 maxTakes 说错话。 */
        说: (it.unit ? '单位是' + it.unit + '，' : '') + '要大于 0。' + (it.hint || '') };
      else out[it.key] = { 名: '拍短剧 · ' + it.label, 取值: (it.options || []).map(x => x.id),
        说: (it.options || []).map(x => x.id + ' = ' + x.label).join('；') };
    });
    /* 文字 AI 的默认型号按供应方各存一份，可以改；要先知道有哪些供应方，所以是异步 */
    try {
      const r = await reg();
      for (const p of TextAI.all(r)) {
        const kid = TextAI.keyId(p);
        out['sk_model_' + kid] = { 名: (p.name || p.id) + ' · 默认型号', 文本: true,
          说: '这一家的默认型号（设置页保存的那一项）；不确定它在这家清单里就先 models 查' };
      }
    } catch (e) { /* 代理没响应时至少有静态那几项 */ }
    return out;
  }
  async function adjustCheck(a) {
    if (!a || typeof a !== 'object') return { err: 'set_setting 的参数要是一个 JSON 对象：{"key":"dir_theme","value":"dark"}' };
    const key = String(a.key || a.键 || '').trim();
    if (!key) return { err: '要给 key（设置项的键名）' };
    if (/^sk_(key|base)_/i.test(key)) return { err: key + ' 不让助手改：密钥与自定义地址只能在设置页由你填（前者会跟着对话记录出网，后者容易造成跨家的密钥错配）' };
    const table = await writableKeys();
    const spec = table[key];
    if (!spec) return { err: '不让改这一项：' + key + '。能改的是：' + Object.keys(table).join(' / ') };
    const val = a.value === undefined || a.value === null ? '' : String(a.value).trim();
    if (!val && !spec.文本) return { err: key + ' 没给 value' };
    if (spec.取值 && !spec.取值.includes(val)) return { err: key + ' 只能取 ' + spec.取值.join(' / ') + '，给的是「' + val + '」' };
    if (spec.数值) {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) return { err: key + ' 要一个大于 0 的数字，给的是「' + val + '」' };
      return { 键: key, 名: spec.名, 值: String(n), 旧: localStorage.getItem(key) || '', 说: spec.说 };
    }
    if (spec.范围) {
      const n = Number(val);
      if (!Number.isFinite(n)) return { err: key + ' 要整数，给的是「' + val + '」' };
      if (n < spec.范围.min || n > spec.范围.max) return { err: key + ' 要在 ' + spec.范围.min + '–' + spec.范围.max + ' 之间' };
      return { 键: key, 名: spec.名, 值: String(Math.round(n)), 旧: localStorage.getItem(key) || '', 说: spec.说 };
    }
    return { 键: key, 名: spec.名, 值: val, 旧: localStorage.getItem(key) || '', 说: spec.说 };
  }
  async function runAdjust(a) {
    const chk = await adjustCheck(a);
    if (chk.err) throw new Error(chk.err);
    localStorage.setItem(chk.键, chk.值);
    /* 这两项改的是**当前窗口**的样子，只写键要等下次进页面才看不出来：
       换色与左栏重排各只有一份实现（sidebar.js 挂出来的这两个钩子），别在这里自己算。 */
    if (chk.键 === 'dir_theme') { try { window.__sbApplyTheme && window.__sbApplyTheme(chk.值); } catch (e) {} }
    if (chk.键 === 'sb_open') { try { window.__sbApplyOpen && window.__sbApplyOpen(); } catch (e) {} }
    return { ok: true, text: '已改「' + chk.名 + '」：' + (chk.旧 || '（原来没设过）') + ' → ' + chk.值 + '\n' + chk.说
      + '\n这一项和设置页「点保存才生效」是同一份存储，别的页面切回去会读到新值。' };
  }
  const ACTS = {
    generate: {
      arg: '{ "provider": "平台 id", "model": "型号 id", "prompt": "提示词", "params": { "count|duration|res|ar|quality|tier|format": 值 }, "inputs": [ { "role": "reference_image", "file": 0 } ] }',
      doc: '向图片/视频平台提交一次生成任务（花钱的动作）。inputs 只能引用 files 里的附件序号或本机 asset 号；型号、取值、槽位上限都要先查过',
      check: genCheck, run: runGenerate,
    },
    set_setting: {
      arg: '{ "key": "dir_theme", "value": "dark" }',
      doc: '改一项设置。能改哪些**以 settings 查询里「能改的」那一份清单为准**（别凭印象报键名）；'
        + '密钥 sk_key_* 与自定义地址 sk_base_* 明确不让改',
      check: adjustCheck, run: runAdjust,
    },
  };

  /* ---------- 系统提示词：身份 → 任务 → 硬性要求 → 禁止 → 输出格式（全站同一条骨架） ---------- */
  const SYS = [
    '身份：你是「本地优先 AI 创作工作台」的内置助手。这项目是纯前端页面 + 一个本机 Node 代理（proxy.js，默认 http://localhost:5175），',
    '页面有：导演台、拍短剧、素材库、图片台、视频台、语音台、资产库、收藏、用量与余额、设置。所有平台接口都经代理转发。',
    '你挂在外壳那一层，切页面不会打断你；脚下那一页的当前下拉值与它自己的状态，都在 overview 里。',
    '',
    '任务：回答关于这台机器与这个项目的问题 —— 哪家平台能用、某型号支持哪些参数取值、',
    '本机有几部短剧各到哪一步、有哪些角色/收藏/产物/提示词归档、这次该选哪个模型、某一步卡住了该怎么补；',
    '并且按用户明确要求，替他提交一次生成任务或改一项设置。',
    '',
    '硬性要求：',
    '1. 平台 id、型号名、参数取值、数量上限、余额、条目数**只能来自查询结果**。没查过就不要报数字或型号 —— 编出来的型号根本不存在，用户照抄一定撞报错。',
    '2. 需要本机或平台的数据就先查，要查几次查几次、查到够用为止；**同一件事不要重复查**（结果已经接回上下文里了），查完照着结果说，不要把同一份数据再复述一遍。',
    '3. 用中文、短句、先结论后理由。要动手的事说清「哪个页面、哪个按钮」，让用户点得到。',
    '4. 查不到就照实说「本机没有这条记录」「代理没响应」，不要补一段看起来像答案的猜测。',
    '5. 涉及附带的文件：先用 files 看有哪些、是什么类型；要看内容就 read_file 真去看（图片要当前型号支持识图才看得见；视频和音频读不出内容，就明说不知道，别替它编）。',
    '6. 要提交生成任务就把型号、参数、素材来源写全 —— 本机会在卡片上按能力声明校验并显示「哪一家/哪个型号/什么参数/哪些素材从哪来」，用户点「执行」才真发请求。',
    '7. 你提交出去的任务，本机跟到出结果为止：一到终态就在这一层说一声（抽屉收着时球上会点个数字），并写进【这台机器上刚发生过的动作】。'
      + '所以用户问「那条怎么样了」就查 tasks 拿当场状态，别照「提交过了」猜一个结果，也别承诺「我继续盯着」——盯不盯着不由你决定。',
    '8. 「配了密钥」和「界面上用得到」是两件事：一家平台标了「停用」，各页的下拉里根本就没有它（这一项存在本机、不在注册表里），'
      + '要提交就得先去设置页「供应商与密钥」重新启用 —— 这个开关你不替用户动，也不要绕过它去提交。'
      + '标了「自定义」的是用户自己在设置页加的接口（照某内置家的接口形状），出问题时去那一卡看，别当成官方平台。',
    '9. **「本机没有」和「平台上没有」是两回事**：history 默认查的是本机列表缓存，只反映「这个浏览器上次拉到什么」。',
    '   用户问的其实是账号里还有没有别的（换过浏览器、清过缓存、在别的机器或别处生成的），',
    '   就查 history {"remote": true} 去问平台接口 —— 那才是平台上的真实清单。',
    '   返回里带「查不了的平台」就照实说那几家上游没有列表接口，**别把它们算成「那边没有任务」**。',
    '10. **拿不准就把选项摆出来**（ASK），别替用户拍板、也别自己猜一个默认值往下走：想提交却不确定挑哪个型号、',
    '   要不要先清掉旧任务、两个选择差别很大的时候。问就一次问完（把所有不肯定的地方都摆出来），用户答完你再继续。',
    '',
    '禁止：',
    '· 用户没点「执行」之前，绝不说「已经建好任务了 / 已经改好了」。卡片只是提案，点了才算做了。',
    '· 一条回答里本机只执行你写出来的**第一行** CALL/RUN/ASK：查询立刻跑并把结果接回来，选择框画出来就停下等用户答，动作则画卡片并结束这一轮（等你点「执行」）。',
    '  多写的几行会被忽略，所以要办几件事就一件一件提，后面的在下一轮继续。',
    '· 不碰密钥、自定义地址、任何删除类操作，也不碰别人的数据（收藏、工作区、归档只读）。',
    '',
    '输出格式：',
    '· 要查询时单独占一行写：CALL: 工具名 {"参数":...}；要提动作时单独占一行写：RUN: 动作名 {"参数":...}；',
    '  要让用户从几个选项里挑时单独占一行写：ASK: [{"q":"问题","options":["候选1","候选2"]}] —— 后面直接跟数组、没有工具名。',
    '  这几行都只能有它自己（放第几行都行），JSON 必须合法且在一行内、紧贴前缀。查询与动作以外的人话照写。',
    '· 不查询不提交也不反问时直接写答案，**不要在正文里出现 CALL / RUN / ASK 这三个词**。',
    '· ASK 就是「问」：选择框画出来本轮到此为止，等用户答完再说；不要在同一个 ASK 旁边再写 CALL 或 RUN。',
    '· 调用 history 时，那几条任务的卡片会**直接出现在这段回答下面**（图能看、视频能播、语音能听）。',
    '  照着卡片说就行 —— 不要再把清单复述一遍，也别让用户去某一页自己找。',
    '· 查询结果会以「> 查询 工具名(...) 的结果：」接回你接下来的输入；看到结果再给最终回答。',
    '· RUN 被采纳后本机画出确认卡片并结束本轮；用户点不点你都能看到（在【这台机器上刚发生过的动作】里）。',
    '· 本轮不再让你查的时候，就照已经拿到的结果回答，缺什么就明说没查到 —— 不要拿记忆里的旧数字当现查到的。',
    '',
    '可用查询（全部只读）：',
    ...Object.keys(TOOLS).map(k => '· ' + k + ' ' + TOOLS[k].arg + ' —— ' + TOOLS[k].doc),
    '',
    '可用动作（要点是「用户点执行才真做」，卡片上会写清做什么）：',
    ...Object.keys(ACTS).map(k => '· ' + k + ' ' + ACTS[k].arg + ' —— ' + ACTS[k].doc),
  ].join('\n');

  /* ---------- 记录：多会话 ---------- */
  const sid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sess = () => SESS.list.find(s => s.id === SESS.cur) || SESS.list[0];
  /* 会话名 = 用户说的第一句话（截断）。没有用户消息就叫「空会话」，
     别拿助手的第一句当标题 —— 那是一段回答的开头，当标题没人认得出来。 */
  const titleOf = s => {
    const list = (s && s.msgs) || [];
    const isMe = x => x && x.r === 'me';
    /* 「只带了文件」那一条不当标题用（标题会变成一句占位话）：
       先找一句用户真打过的话；一句都没有，就拿那一条带的文件名。 */
    const real = list.find(x => isMe(x) && String(x.t || '').trim() && !/^（只带了文件/.test(String(x.t)));
    const cut = t => (t.length > 26 ? t.slice(0, 26) + '…' : t);
    if (real) return cut(String(real.t).replace(/\s+/g, ' ').trim());
    const withFile = list.find(x => isMe(x) && (x.fs || []).length);
    const names = withFile ? withFile.fs.map(x => String(x.name || '')).filter(Boolean) : [];
    return names.length ? cut(names.join('、')) : '';
  };
  function bind() { const s = sess(); msgs = s.msgs; acts = s.acts; }
  function newSession() {
    const s = { id: sid(), title: '', at: Date.now(), msgs: [], acts: [] };
    SESS.list.push(s); SESS.cur = s.id;
    bind(); save();
    return s;
  }
  /* 切会话要拦的两种状态和「清空」那一条一样：正在写（字会丢）、
     还有一张没确认的卡片（那是用户本来打算执行的提案）。 */
  function canLeave() {
    if (live) { toast('上一条还在写，先按「停止」', 'warn'); return false; }
    if (pendingRun()) { toast('还有一张没确认的卡片，先点「执行」或「取消」', 'warn'); return false; }
    return true;
  }
  /* 返回**有没有真的切过去** —— 点一条之后要不要收起浮层看的就是这个：
     正在写 / 有未确认卡片时是被拦下的，这时候把列表也收掉就成了
     「点了、列表关了、什么都没换」，比不收更让人以为是自己点歪了。
     切成功**不弹提示**：浮层收起 + 对话区换成那一段本身就是反馈，
     再叠一条 toast 只会挡一下刚看到的字。拦下时才弹（说明为什么没换）。 */
  function gotoSession(id) {
    const s = SESS.list.find(x => x.id === id);
    if (!s || s.id === SESS.cur) return false;
    if (!canLeave()) return false;
    SESS.cur = id; bind(); save();
    paint(); paintHist();
    return true;
  }
  async function delSession(id) {
    const s = SESS.list.find(x => x.id === id);
    if (!s) return;
    if (SESS.list.length <= 1) { toast('至少留一个会话（要重来就点「新建」）', 'warn'); return; }
    /* 有内容的那一段要二次确认：删掉就找不回来了（对话记录跟着云同步出网，
       但同步的那一份也不会因为你在这里删了就跟着删）。 */
    if ((s.msgs || []).length && window.Confirm) {
      const yes = await Confirm.ask({
        title: '删除这段会话？', danger: true, okLabel: '删除',
        body: '「' + (s.title || '（还没说话）') + '」这一段有 ' + s.msgs.length + ' 条记录，删掉就找不回来了。',
      });
      if (!yes) return;
    }
    SESS.list = SESS.list.filter(x => x.id !== id);
    if (SESS.cur === id) { SESS.cur = SESS.list[0].id; bind(); }
    save(); paint(); paintHist();
    toast('已删除那段会话', 'ok');
  }
  function load() {
    let o = null;
    try { o = Store.read(KEY, null); } catch (e) { o = null; }
    /* v2 是多会话。老数据是**一条扁平数组**（v1），自动包成第一个会话 —— 原对话一条不丢，
       不做这个迁移的用户打开就是一片空白，看起来像「记录被清空了」。 */
    if (o && Array.isArray(o.list)) {
      SESS = { v: 2, cur: String(o.cur || ''), list: o.list.filter(s => s && Array.isArray(s.msgs)) };
      SESS.list.forEach(s => { if (!Array.isArray(s.acts)) s.acts = []; });
    } else if (Array.isArray(o)) {
      SESS = { v: 2, cur: '', list: [{ id: sid(), title: '', at: Date.now(), msgs: o, acts: [] }] };
    } else {
      SESS = { v: 2, cur: '', list: [] };
    }
    if (!SESS.list.length) SESS.list.push({ id: sid(), title: '', at: Date.now(), msgs: [], acts: [] });
    if (!SESS.list.some(s => s.id === SESS.cur)) SESS.cur = SESS.list[0].id;
    bind();
    loadFiles();
  }
  function save() {
    const s = sess();
    if (!s) return;
    s.msgs = msgs; s.acts = acts; s.at = Date.now();
    if (!s.title) s.title = titleOf(s);
    if (SESS.list.length > SESS_CAP) {         // 丢最久没用的几条，当前这条永远留着
      const cut = SESS.list.length - SESS_CAP;
      const drop = SESS.list.filter(x => x.id !== s.id)
        .sort((a, b) => (a.at || 0) - (b.at || 0)).slice(0, cut).map(x => x.id);
      SESS.list = SESS.list.filter(x => drop.indexOf(x.id) < 0);
    }
    Store.write(KEY, SESS, { label: 'AI 助手对话' });
  }
  function push(kind, text, extra) {
    const m = Object.assign({ r: kind, t: String(text == null ? '' : text), at: Date.now() }, extra || {});
    msgs.push(m);
    msgs = msgs.slice(-CAP);
    save();
    paint();
    return m;
  }
  const pendingRun = () => msgs.filter(m => m.r === 'run' && !m.st).length;

  /* ---------- 附件 ---------- */
  function kindOf(f) {
    const t = String(f.type || '').toLowerCase();
    if (t.startsWith('image/')) return '图片';
    if (t.startsWith('video/')) return '视频';
    if (t.startsWith('audio/')) return '音频';
    if (t.startsWith('text/')) return '文本';
    if (TEXT_EXT.test(String(f.name || ''))) return '文本';
    return '其他';
  }
  function extOf(f) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(String(f.name || ''));
    if (m) return m[1].toLowerCase();
    const s = String(f.type || '').split('/')[1] || 'bin';
    return s.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
  }
  async function addFiles(list) {
    const arr = Array.from(list || []).filter(Boolean);
    if (!arr.length) return;
    for (const f of arr) {
      if (window.AssetTransfer && f.size > AssetTransfer.MAX_BYTES) {
        push('step', '没收「' + (f.name || '未命名') + '」：' + window.fmtBytes(f.size) + ' 超过本机素材上限 ' + window.fmtBytes(AssetTransfer.MAX_BYTES));
        continue;
      }
      const rec = { name: f.name || '未命名', size: f.size || 0, mime: f.type || '', kind: kindOf(f), file: f, src: '', la: '', txt: '', note: '' };
      try { rec.src = URL.createObjectURL(f); } catch (e) {}
      /* 图片/视频/音频落一份本机资产（/asset/la_xxx）：别的页面从资产库也挑得到它，
         提交时它就是个读得到的地址。文本落一份有上限的快照（内容就是它要的字节，不必占资产库）。 */
      if (rec.kind === '图片' || rec.kind === '视频' || rec.kind === '音频') {
        try {
          const b64 = window.AiGen ? AiGen.b64FromBuf(await f.arrayBuffer()) : '';
          if (b64) {
            const saved = await Api.saveLocalAsset({ name: rec.name, mime: rec.mime || 'application/octet-stream',
              format: extOf(f), data: b64, media_type: rec.kind, meta: { provider: 'local', prompt: 'AI 助手附件' } });
            if (saved && saved.id) { rec.la = saved.id; rec.src = saved.url || rec.src; }
          } else rec.note = '读不出字节，没存进本机资产';
        } catch (e) { rec.note = '没存进本机资产：' + cap((e && e.message) || e, 90); }
      } else if (rec.kind === '文本') {
        try { rec.txt = cap(await f.text(), READ_MAX); }
        catch (e) { rec.note = '读不出文本：' + cap((e && e.message) || e, 90); }
      }
      files.push(rec);
    }
    saveFiles();
    paintFiles();
  }
  /* 附件的「身份」落盘：File 句柄过不了 JSON，所以媒体记本机资产地址、文本记快照。
     换页 / 刷新之后序号仍和气泡里对得上，read_file 也还能读 —— 不必让人重拖一次。 */
  function saveFiles() {
    try {
      localStorage.setItem(K_FILES, JSON.stringify(files.map(f => ({ name: f.name, size: f.size, mime: f.mime,
        kind: f.kind, src: f.src || '', la: f.la || '', txt: f.kind === '文本' ? cap(f.txt || '', READ_MAX) : '', note: f.note || '' }))));
    } catch (e) {}
  }
  function loadFiles() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(K_FILES) || '[]') || []; } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    files = arr.filter(x => x && typeof x === 'object' && x.name).slice(-20).map(x => ({
      name: String(x.name), size: Number(x.size) || 0, mime: String(x.mime || ''), kind: String(x.kind || '其他'),
      src: String(x.src || ''), la: String(x.la || ''), txt: String(x.txt || ''), note: String(x.note || ''), file: null }));
  }
  const LOCAL_SRC = /^\/asset\//;
  /* 字节来源：内存里的 File 优先，否则按本机资产地址回源（换页之后走的就是这一条） */
  async function fileBytes(rec) {
    if (rec.file) return rec.file;
    if (!LOCAL_SRC.test(rec.src || '') || !window.Net) return null;
    try { return await Net.blob(rec.src); } catch (e) { return null; }
  }
  /* 发出去的那一刻拍一份快照，并顺手拼出能落盘的那份摘要（File 句柄与 blob: 地址过不了 JSON，
     气泡上画的就是这份摘要 —— 它也是清空输入框之后「这一条带了什么」的唯一凭据）。 */
  function shotFiles() {
    roundFiles = files.map(f => Object.assign({}, f));
    return roundFiles.map(f => ({
      kind: f.kind, name: f.name, size: f.size,
      ok: !!f.file || LOCAL_SRC.test(f.src || '') || (f.kind === '文本' && !!f.txt),
      note: f.note || '',
    }));
  }
  /* 清空输入框上的那排芯片。**只断引用，不删 .assets 里的文件** ——
     那是本机资产库，删东西要用户自己在资产库/收藏页里来。
     **也不 revokeObjectURL**：roundFiles 里是浅拷贝，同一个 blob: 地址这一轮还在用
     （图片没存进本机资产时，字节就只剩它）。blob 跟着对象 URL 注册表活到页面关闭，
     这里省下的那点内存不值得拿「这轮发出去的图突然读不到了」去换。 */
  function clearFiles() {
    if (!files.length) return;
    files = [];
    saveFiles();
    paintFiles();
  }
  /* 移出只断掉这一轮的引用，不删 .assets 里的文件（那是用户的资产库，删东西要他自己来） */
  function dropFile(i) {
    const rec = files[i];
    if (!rec) return;
    if (rec.src && rec.src.startsWith('blob:')) { try { URL.revokeObjectURL(rec.src); } catch (e) {} }
    files.splice(i, 1);
    saveFiles();
    paintFiles();
  }
  function fileBlock() {
    const list = roundFiles || [];
    if (!list.length) return '';
    return '【这次附带的文件】\n' + list.map((f, i) =>
      i + ' = ' + f.name + '｜' + f.kind + '｜' + window.fmtBytes(f.size) + '｜'
      + (f.file ? '本次拖进来的 File' : LOCAL_SRC.test(f.src || '') ? f.src : f.txt ? '本机存的文本快照' : '字节已不在，要让人重新拖')).join('\n') + '\n\n';
  }
  /* 附带的图片只在「当前型号支持识图」时真发给文字 AI（按识图判定，不按名字猜） */
  async function attachImages(prov, model) {
    const list = roundFiles || [];
    const imgs = list.filter(f => f.kind === '图片' && (f.file || f.src));
    if (!imgs.length || !window.TextAI) return { images: [], note: '' };
    try { return await TextAI.polishImages(REG, imgs.map((f, i) => ({ label: f.name || ('附件' + i), src: f.file || f.src })), { prov, model, max: 6 }); }
    catch (e) { return { images: [], note: '附图这一步没成：' + cap((e && e.message) || e, 120) }; }
  }
  function paintFiles() {
    if (!el.files) return;
    const readable = f => !!f.file || LOCAL_SRC.test(f.src || '') || (f.kind === '文本' && !!f.txt);
    el.files.innerHTML = files.map((f, i) =>
      '<span class="ac-fi' + (f.note || !readable(f) ? ' warn' : '') + '" title="' + esc((f.mime || '') + (f.note ? ' · ' + f.note : '') + (readable(f) ? '' : ' · 字节已不在')) + '">'
      + esc(f.kind) + '·' + esc(cap(f.name, 18))
      + '<button data-i="' + i + '" title="从这一轮移开（不删本机资产库里的文件）">×</button></span>').join('');
    el.files.querySelectorAll('button').forEach(b => { b.onclick = () => dropFile(Number(b.dataset.i)); });
    el.files.hidden = !files.length;
  }

  /* ---------- 画 ---------- */
  const QUICK = [
    '我现在哪些平台能用？', '本机短剧都到哪一步了？', '拍短剧还差什么才能导成片？',
    '生图有哪些型号，分别支持什么参数？', '最近 7 天文字 AI 用了多少？', '把这张图看看，照它的样子出一张',
  ];
  function runNode(m) {
    const d = document.createElement('div');
    d.className = 'ac-m ac-run';
    const c = document.createElement('div');
    c.className = 'ac-bd ac-run-card';
    const hd = document.createElement('div');
    hd.className = 'ac-run-hd';
    hd.textContent = (m.act === 'set_setting' ? '改设置' : '提交生成任务')
      + (m.auto ? ' · 按设置自动执行' : ' · 等你确认');
    c.appendChild(hd);
    (m.人话 || [m.t]).forEach(L => {
      const row = document.createElement('div');
      row.className = 'ac-run-row';
      row.textContent = L;                       // 提示词与型号名都是外部文本：只走 textContent
      c.appendChild(row);
    });
    if (m.out) {
      const st = document.createElement('div');
      st.className = 'ac-run-st ' + (m.st === 'err' ? 'err' : m.st === 'run' ? 'run' : 'ok');
      st.textContent = m.out;
      c.appendChild(st);
    }
    d.appendChild(c);
    if (!m.st) {
      const ft = document.createElement('div');
      ft.className = 'ac-run-bd';
      const go = document.createElement('button');
      go.className = 'tool acc';
      go.textContent = '执行';
      const no = document.createElement('button');
      no.className = 'ghost';
      no.textContent = '取消';
      go.onclick = () => execRun(m);
      no.onclick = () => {
        m.st = 'cancel';
        m.out = '用户没执行，这一条作废（数据与任务都没动）';
        acts.push({ 动作: m.act, 结果: '被取消', 说明: cap(m.t, 200), at: Date.now() });
        save(); paint();
      };
      ft.appendChild(go); ft.appendChild(no);
      d.appendChild(ft);
    }
    return d;
  }
  /* 真的执行这一张卡片。校验在画卡片之前就全做完了（见 send 里 RUN 那一支），
     所以「不用确认」只是省掉那一下点击 —— 一张卡片只认一次执行这条不能省：
     重复提交 = 平台那边多一条任务（没有幂等键的家尤其如此）。 */
  async function execRun(m) {
    if (m.st) return;                          // 已经执行 / 取消过：再点什么都不做
    if (live) return toast('正在写回答，先按「停止」再执行', 'warn');
    m.st = 'run';
    m.out = '正在提交…';
    save(); paint();
    try {
      const fn = ACTS[m.act] && ACTS[m.act].run;
      if (!fn) throw new Error('没有这个动作：' + m.act);
      const r = await fn(m.arg, m.钉);
      m.st = r && r.ok === false ? 'err' : 'ok';
      m.out = (r && r.text) || '做完了';
      acts.push({ 动作: m.act, 结果: m.st === 'err' ? '失败' : '成功', 说明: cap(m.out, 300), at: Date.now() });
    } catch (e) {
      m.st = 'err';
      m.out = '失败了：' + cap((e && e.message) || e, 400);
      acts.push({ 动作: m.act, 结果: '失败', 说明: cap(m.out, 300), at: Date.now() });
    }
    save(); paint();
  }
  /* ---------- 助手提交的任务：等它出结果，然后主动提醒 ----------
     为什么要在外壳自己等：提交之后页面可能立刻被切走（甚至关掉这一层），
     页面那份轮询就没了 —— 用户的原始诉求就是「他提交的任务完成后提醒我」。
     所以这里只跟**助手自己提交的那几条**，按平台分组走 Api.pollMany（声明了 pollVia:'list'
     的一家一次列表请求解出整批），不认领别人建的任务，也不重新提交（重提交就是重复扣费）。
     进度落在 ai_chat_watch：本机的事，不出网（见 ui.js 的 NOT_SYNC）。 */
  const WATCH_EVERY = 12000;              // 12 秒一轮：图片/视频动辄几分钟，问太密只是在抢列表接口
  const WATCH_TTL = 60 * 60 * 1000;       // 最多等 1 小时，到点照实说「还没等到」，不假装失败也不无限挂着
  const WATCH_CAP = 12;
  let watchTimer = null;

  /* { items:[{id,prov,kind,model,prompt,at}], unread:N } —— unread 是「球上还没看的那几条结果」 */
  function wread() {
    let o = null;
    try { o = JSON.parse(localStorage.getItem(K_WATCH) || 'null'); } catch (e) { return { items: [], unread: 0 }; }
    const items = Array.isArray(o && o.items) ? o.items.filter(x => x && x.id && x.prov) : [];
    return { items: items.slice(0, WATCH_CAP), unread: Math.max(0, Number(o && o.unread) || 0) };
  }
  function wwrite(st) {
    try { localStorage.setItem(K_WATCH, JSON.stringify({ items: st.items.slice(0, WATCH_CAP), unread: st.unread })); } catch (e) {}
    tickBadge(st);
    if (st.items.length) startWatch(); else stopWatch();
  }
  function addWatch(rec) {
    const st = wread();
    st.items = [Object.assign({ at: Date.now() }, rec)].concat(st.items);
    wwrite(st);
  }
  function stopWatch() {
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  }
  function startWatch() {
    stopWatch();
    watchTimer = setTimeout(() => { watchTimer = null; watchTick(); }, WATCH_EVERY);
  }
  /* 一句人话的状态：球上的点 + 抽屉里那条通知都从这儿来 */
  function tickBadge(st) {
    const d = el.dot;
    if (!d) return;
    const s = st || wread();
    const wait = s.items.length, fresh = s.unread;
    d.hidden = !(wait || fresh);
    d.textContent = String(fresh || wait);
    d.className = 'ac-dot' + (fresh ? ' new' : '');
    d.title = fresh ? fresh + ' 条结果等你看' : (wait ? '在等 ' + wait + ' 条任务的结果' : '');
  }
  /* 到终态（或到期）：写进对话、球上记一条没看过、系统通知（授权过才发） */
  function finishTask(rec, verdict, q) {
    const st = wread();
    st.items = st.items.filter(x => x.id !== rec.id);
    const 页 = '生成工作台';
    const 时 = Math.max(1, Math.round((Date.now() - (Number(rec.at) || Date.now())) / 60000));
    const lines = ['你 ' + 时 + ' 分钟前让我提交的那条任务：' + verdict,
      '平台：' + rec.prov + (rec.model ? ' · 型号 ' + rec.model : ''),
      '任务号：' + rec.id];
    if (q) {
      if (q.status) lines.push('接口回的状态：' + String(q.status));
      if (q.error) lines.push('它同时报了：' + cap(String(q.error), 220));
      const 产物 = q.url ? cap(String(q.url), 120) : (q.assetId ? String(q.assetId) : '');
      if (产物) lines.push('产物：' + 产物);
    }
    lines.push('去看：' + 页 + '（任务列表里就是这一条，本机不替你认领产物）');
    if (!isOpen()) st.unread += 1;
    wwrite(st);
    push('note', lines.join('\n'));
    acts.push({ 动作: 'generate', 结果: verdict, 说明: cap(rec.prov + ' · ' + (rec.model || '') + ' · ' + rec.id, 200), at: Date.now() });
    sysNotify('AI 助手：任务' + verdict, (rec.model ? rec.prov + ' · ' + rec.model + ' · ' : '') + rec.id);
  }
  /* 一轮状态查询：轮询器与 tasks 查询共用这一份。
     各写一遍就会出现「球上的点说完了、助手回答里还在等」——同一批任务必须同一个判据。
     verdict 非空 = 可以结掉这一条（终态，或等到超时）；空 = 还在跑或这一轮问不通。 */
  async function probeWatch(items) {
    const rows = new Map();
    const setRow = (rec, o) => rows.set(rec.id, Object.assign({ rec }, o));
    let r = null;
    try { r = await reg(); } catch (e) { r = null; }
    if (!r || !Array.isArray(r.providers)) {
      items.forEach(rec => setRow(rec, { 状态: '问不到（代理没响应；这不算任务失败，下一轮还会问）' }));
      return { 代理: false, rows: [...rows.values()] };
    }
    const groups = new Map();
    items.forEach(rec => {
      const p = (r.providers || []).find(y => y && y.id === rec.prov);
      if (!p) { setRow(rec, { 状态: '注册表里已经没有这一家了', verdict: '等不到（注册表里已经没有这一家了）', q: null }); return; }
      if (!groups.has(p.id)) groups.set(p.id, { p, ids: [] });
      groups.get(p.id).ids.push(rec.id);
    });
    for (const { p, ids } of groups.values()) {
      let got = null;
      try { got = await Api.pollMany(p, ids); } catch (e) {
        // 这一家这一轮问不通：留着下一轮，别把它当成任务失败
        ids.forEach(id => { const rec = items.find(x => x.id === id); if (rec) setRow(rec, { 状态: '这一家问不通：' + cap((e && e.message) || e, 90) }); });
        continue;
      }
      ids.forEach(id => {
        const rec = items.find(x => x.id === id);
        if (!rec) return;
        const hit = got && typeof got.get === 'function' ? got.get(id) : null;
        const q = hit && hit.p;
        const expired = Date.now() - (Number(rec.at) || 0) > WATCH_TTL;
        if (!q) {   // 列表里查不到 / 详情没回：可能还没排上，也可能产物字段没写全 —— 不据此判失败
          setRow(rec, { 状态: expired ? '等到超时，这一家的接口里查不到这条' : '接口里暂时查不到这条（可能还没排上）',
            verdict: expired ? '还没等到结果（这一家在接口里查不到这条，或它一直没写终态）' : '', q: null });
          return;
        }
        if (q.running) {
          /* 「还在queued」这种半中半英的话，模型会当成状态名原样转述给用户。 */
          setRow(rec, { 状态: '还在平台那边跑（接口回 ' + (q.status || 'running') + (q.progress ? '，进度 ' + q.progress : '') + '）',
            verdict: expired ? '超时还没出（平台那边可能仍在排）' : '', q });
          return;
        }
        setRow(rec, { 状态: q.done ? '好了' : '失败了', verdict: q.done ? '好了' : '失败了', q,
          产物: q.url || q.assetId || '', 错误: q.error || '' });
      });
    }
    return { 代理: true, rows: [...rows.values()] };
  }
  let watchFails = 0;
  async function watchTick() {
    const st = wread();
    if (!st.items.length) { tickBadge(st); watchFails = 0; return; }
    /* 整轮包 try/catch，而且**无论成败都要再排下一轮**。
       以前 startWatch() 是最后一行：读清单、探状态、写结果里任何一处抛错，
       轮询链就静默断掉 —— 球上一直显示「在等 N 条」直到刷新，而任务其实早就好了。
       这是用户那句「任务完成后应该在会话中显示」最容易被忽略的一个成因。 */
    let bad = '';
    try {
      const { rows } = await probeWatch(st.items);
      /* 逐条 finishTask 会各读各写 localStorage，所以只结掉此刻还在清单里的那几条 */
      const alive = new Set(wread().items.map(x => x.id));
      rows.forEach(o => { if (o.verdict && alive.has(o.rec.id)) finishTask(o.rec, o.verdict, o.q); });
    } catch (e) {
      bad = (e && e.message) || String(e);
    } finally {
      watchFails = bad ? watchFails + 1 : 0;
      /* 连续三轮（约 36 秒）问不通才说一次，别每 12 秒往对话里塞一条。 */
      if (watchFails === 3) {
        push('note', '连续 ' + watchFails + ' 轮没问到任务状态（' + cap(bad, 160) + '）。'
          + '任务还在等待清单里，我会继续问。「这不代表任务失败」，也可能只是代理或平台这一会儿问不通。');
      }
      startWatch();
    }
  }
  function sysNotify(title, body) {
    /* 桌面弹窗要两件事都成立：设置页勾了那一项 + 浏览器已经授权（授权只能由用户点一下换来，
       所以设置页给了一个「现在授权」的按钮，不在这儿偷偷 requestPermission）。 */
    try {
      if (localStorage.getItem(K_NOTICE) !== '1') return;
      if (!window.Notification || Notification.permission !== 'granted') return;
      const n = new Notification(title, { body: String(body || '').slice(0, 200), tag: 'ai-chat-task' });
      n.onclick = () => { try { openPanel(); n.close(); } catch (e) {} };
    } catch (e) {}
  }

  /* ---------- 历史任务卡片：把本机缓存里的产物直接画进对话 ----------
     用户问「我之前做过什么」时，光念一份列表没用 —— 他要的是看见。
     图片直接显示、视频就地播、语音给播放器；媒体一律走 Api.mediaSrc
     （见 AGENTS.md「统一路由」，绝不把上游签名外链直接塞进 src）。
     缩略图/抽帧/占位层/接线全交给 Wb.thumbs：标记、data-thumb-key、.tph 都是它生成的，
     接线放在**所有渲染路径的汇合处**（node() 每次重画都从这里走），所以不会再出现
     「新建的那几张永远不抽帧」那类只在某一条路径上接线的问题。 */
  const AUDIO_T = ['音频', '音乐'];
  const STUDIO_TAB = { 图片: 'image', 视频: 'video', 音频: 'audio', 音乐: 'audio' };
  /* ---------- history 的两条路：本地缓存 / 真去平台接口 ---------- */
  const HIST_NOTE = '这几张卡片和上面那份列表是同一批条目，用户已经能直接看图、播视频、听语音了 —— 照着说，别再让他去某一页自己找。';
  const histWhen = v => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;                 // 毫秒时间戳
    const t = Date.parse(String(v == null ? '' : v));
    return Number.isFinite(t) ? t : 0;                          // ISO 字符串
  };
  const histMatch = (e, a, scope) => {
    if (scope !== 'all' && SCOPE_TYPE[scope].indexOf(String(e.type || '')) < 0) return false;
    const want = String(a.status || '').toLowerCase();
    if (want && String(e.status || '').toLowerCase() !== want) return false;
    const q = String(a.q || '').toLowerCase();
    if (!q) return true;
    return [e.prompt, e.providerName, e.provider, e.model, e.type, e.genId, e.id, e.status]
      .map(x => String(x == null ? '' : x)).join(' ').toLowerCase().indexOf(q) >= 0;
  };
  /* 两条路共用的收尾。**卡片与列表必须是同一批** —— 画一套、念另一套，
     用户盯着眼前的东西却听你报别的数字，那比查不到更坏。
     排序按时间倒序：limit 越小越该给「最近的」，而平台列表的顺序不保证（有的按创建、有的按更新）。 */
  function histOut(rows, a, extra) {
    const n = Math.min(num(a.limit, 6), 24);
    const draw = a.show !== false;
    const sorted = rows.slice().sort((x, y) => histWhen(y.created || y.ts) - histWhen(x.created || x.ts));
    const pick = sorted.slice(0, n);
    const out = Object.assign({}, extra || {});
    delete out.tag; delete out.卡片标题;      // 只给界面用的字段，不进模型看到的返回值
    if (draw && pick.length) {
      const tag = (extra && extra.tag) || '';
      showCards(pick, (tag ? tag + ' · ' : '') + ((extra && extra.卡片标题) || '本机历史任务'));
    }
    out.命中 = rows.length;
    out.画在下面 = draw ? pick.length + ' 条' : '0 条（show=false）';
    out.条目 = pick.map(e => ({
      类型: e.type || '', 平台: e.providerName || e.provider || '', 型号: e.model || '',
      状态: e.status || '', 有产物: !!e.src, 时长: e.duration || null,
      时间: when(e.created || e.ts), 任务号: e.genId || e.id || '', 提示词: cap(e.prompt, 200),
    }));
    out.说明 = pick.length ? HIST_NOTE
      : (rows.length ? '命中 ' + rows.length + ' 条，一次只画 ' + n + ' 条；要看更多就带上更明确的 status 或 q。'
        : ((extra && extra.没命中) || '没有命中的条目。'));
    return out;
  }
  /* ① 本机缓存：立刻返回，但**只反映「这个浏览器上次拉到过什么」**。 */
  function localHistory(a) {
    if (!window.AssetLib) return '没加载资产库模块';
    const scope = String(a.kind || a.scope || 'all').toLowerCase();
    if (scope !== 'all' && !SCOPE_TYPE[scope]) return 'kind 只认 image / video / audio / all';
    const all = [];
    Object.keys(CACHES).forEach(k => AssetLib.listCache(k).read().forEach(e => { if (e) all.push(e); }));
    const rows = all.filter(e => histMatch(e, a, scope));
    return histOut(rows, a, {
      来源: '本机列表缓存（这个浏览器上次拉到过什么）',
      卡片标题: '本机历史任务',
      本机共: all.length,
      tag: scope === 'all' ? '' : (KIND_ZH[scope] || ''),
      没命中: '本机缓存里没有命中的条目。这**只反映这个浏览器上次拉到过什么**，不代表平台上真的没有 —— '
        + '别把空结果说成「你没做过」。要平台账号里的全部任务，改用 history {"remote": true} 去问接口。',
    });
  }
  /* ② 真去平台列表接口查。走 **AssetLib.load** —— 它按 Api.listSources() 把所有声明了
     endpoints.list 的平台挨个拉一遍，并归一成与本机缓存同构的条目。
     刻意不自己拼 URL、不写第二份归一化：接口形状各家不同，registry 的 list.map 就是那份映射。
     三件必须照实说的：
       · 没声明 endpoints.list 的平台**查不了**（上游只给单任务查询，比如 MiniMax 视频）——
         那不是「那边没有任务」，是那个平台根本没有列表接口。
       · 列表接口动辄 6~14 秒，所以先在对话里说一声「去问平台了」，别让人对着「正在写…」干等。
       · 这条路会顺手把这批产物存进本机资产库（AssetLocal.scan，默认开，可在设置页关）。 */
  async function remoteHistory(a) {
    if (!window.AssetLib) return '没加载资产库模块';
    const scope = String(a.kind || a.scope || 'all').toLowerCase();
    if (scope !== 'all' && !SCOPE_TYPE[scope]) return 'kind 只认 image / video / audio / all';
    const r = await reg();
    const only = String(a.provider || '').trim();
    const ids = only ? [only] : null;
    const srcs = Api.listSources({ kinds: scope === 'all' ? null : [scope], ids: ids });
    push('step', '去平台问一次（' + (only ? (Api.prov(only) || {}).name || only : '所有有列表接口的平台')
      + '：' + (srcs.length ? srcs.map(s => (s.prov && s.prov.name) || s.key).join('、') : '一家都没有')
      + '）—— 列表接口可能要十几秒…');
    const res = await AssetLib.load({
      reg: r,
      kinds: scope === 'all' ? null : [scope],
      ids: ids,
      pages: Math.min(num(a.pages, 2), 5),
      accept: scope === 'all' ? null : e => SCOPE_TYPE[scope].indexOf(String(e.type || '')) >= 0,
    });
    const all = res.entries || [];
    const rows = all.filter(e => histMatch(e, a, scope));
    /* 查不了的那几家要说清是「没有列表接口」，不是「没查到任务」。
       也跟本次的 kind / provider 过滤对齐 —— 用户只问图片时，别拿一堆视频平台来烦他。 */
    const noList = (r.providers || [])
      .filter(p => p.kind && p.kind !== 'text' && (scope === 'all' || p.kind === scope))
      .filter(p => !only || p.id === only)
      .filter(p => !(p.list && p.endpoints && p.endpoints.list))
      .map(p => p.name || p.id);
    const failed = Object.keys(res.failed || {}).map(k => {
      const p = Api.prov(k);
      return ((p && (p.name || p.id)) || k) + '：' + cap((res.errors || {})[k] || '读不到');
    });
    const out = histOut(rows, a, {
      来源: '平台列表接口（刚拉的实时数据）',
      卡片标题: '平台历史任务（刚拉的）',
      问了哪些平台: srcs.length ? srcs.map(s => (s.prov && s.prov.name) || s.key) : ['（一家都没有）'],
      拉到: all.length,
      tag: scope === 'all' ? '' : (KIND_ZH[scope] || ''),
      没命中: all.length
        ? '这次拉到 ' + all.length + ' 条，但按条件没命中。要看全部就去掉 q / status。'
        : '这次一家都没拉到条目。注意：**没有列表接口的平台根本查不了**（见下面「查不了的平台」），'
          + '别把「查不了」说成「那边没有」。',
    });
    if (res.hasMore) out.还有更多 = '还有没翻到的页；要数全部就调大 pages（每页一次请求，别开太大）';
    if (noList.length) out.查不了的平台 = noList.concat(' —— 这几家上游只给单任务查询，没有列表接口，问了也查不到');
    if (failed.length) out.这次没拉通 = failed;
    return out;
  }
  /* 卡片标题要说清这批条目是从哪来的：remote 那批是刚拉的实时数据。
     两条路都写成「本机历史任务」的话，用户会以为眼前看到的还是老缓存。 */
  function showCards(items, title) {
    push('cards', (title || '本机历史任务') + ' ' + items.length + ' 条', { items: items });
  }
  function cardsNode(m) {
    const wrap = document.createElement('div');
    wrap.className = 'ac-cards';
    const hd = document.createElement('div');
    hd.className = 'ac-cards-hd';
    hd.textContent = m.t || '本机历史任务';
    wrap.appendChild(hd);
    (m.items || []).forEach(e => wrap.appendChild(cardEl(e)));
    return wrap;
  }
  function cardEl(e) {
    const d = document.createElement('div');
    d.className = 'ac-card';
    const type = String(e.type || '');
    const th = (window.Wb && Wb.thumbs) ? Wb.thumbs : null;
    let src = '';
    try { src = e.src ? Api.mediaSrc(e.src) : ''; } catch (err) { src = ''; }
    if (src) {
      const box = document.createElement('div');
      box.className = 'ac-card-media';
      if (AUDIO_T.indexOf(type) >= 0) {
        box.innerHTML = '<audio class="ac-aud" controls preload="none" src="' + esc(src) + '"></audio>';
      } else if (th) {
        /* inline：即使抽帧缓存里已有首帧也仍然出 <video>，把那一帧当 poster ——
           对话里要看的就是「能播」，不是一张点不动的静帧海报。 */
        box.innerHTML = type === '视频'
          ? th.mediaHTML(src, { inline: true, mediaAttrs: 'class="ac-vid" controls preload="metadata" playsinline' })
          : th.mediaHTML(src, { type: 'image', mediaAttrs: 'class="ac-img" loading="lazy" alt=""' });
      } else {
        box.innerHTML = type === '视频'
          ? '<video class="ac-vid" controls preload="metadata" playsinline src="' + esc(src) + '"></video>'
          : '<img class="ac-img" loading="lazy" alt="" src="' + esc(src) + '">';
      }
      d.appendChild(box);
      const m0 = box.querySelector('video, img');
      if (m0 && th) { try { th.bind(box, m0, src); } catch (err) {} }
    }
    const bd = document.createElement('div');
    bd.className = 'ac-card-bd';
    const meta = [type, e.providerName || e.provider, e.model, e.status,
      e.duration ? (e.duration + ' 秒') : '', when(e.created || e.ts)].filter(x => x != null && x !== '').join(' · ');
    const metaEl = document.createElement('div');
    metaEl.className = 'ac-card-meta';
    metaEl.textContent = meta;
    bd.appendChild(metaEl);
    if (e.prompt) {
      const p = document.createElement('div');
      p.className = 'ac-card-prompt';
      p.textContent = cap(e.prompt, 220);
      bd.appendChild(p);
    }
    const ft = document.createElement('div');
    ft.className = 'ac-card-ft';
    const id = e.genId || e.id || '';
    if (id) { const s = document.createElement('span'); s.className = 'ac-card-id'; s.textContent = '任务号 ' + id; ft.appendChild(s); }
    const tab = STUDIO_TAB[type];
    if (tab) {
      const go = document.createElement('button');
      go.className = 'ac-card-go';
      go.textContent = '去工作台看';
      go.onclick = () => { try { location.hash = '#studio.html?t=' + tab; openPanel(); } catch (err) { toast('跳转失败', 'warn'); } };
      ft.appendChild(go);
    }
    if (src) {
      const dl = document.createElement('button');
      dl.className = 'ac-card-go';
      dl.textContent = '下载';
      /* 扩展名按条目的 format 推 —— 平台列表拉回来的条目都带这个字段；
         推不出才退回按类型猜（本机缓存那批没有 format）。 */
      const ext = (e.format && String(e.format).replace(/^\./, ''))
        || (AUDIO_T.indexOf(type) >= 0 ? 'mp3' : type === '视频' ? 'mp4' : 'png');
      /* 优先用条目自带的下载路由（/asset/…?dl=1 或 /fetch?url=…&dl=1）：
         那条路由已经把「取哪个字节」准备好了，直接拿显示用的 src 去取有时会命中签名地址的缩略档。 */
      const url = e.dl || src;
      /* Wb.save 是 async：try/catch 接不住它的 reject，得 await（和 workbench.js 里那处一样）。
         先禁用再点，否则连点两下就是两个下载。 */
      dl.onclick = async () => {
        const old = dl.textContent;
        dl.disabled = true; dl.textContent = '下载中…';
        try { await Wb.save(url, (id || type || 'media') + '.' + ext); }
        catch (err) { toast('下载失败：' + cap((err && err.message) || err, 90), 'warn'); }
        finally { dl.disabled = false; dl.textContent = old; }
      };
      ft.appendChild(dl);
    }
    bd.appendChild(ft);
    d.appendChild(bd);
    return d;
  }

  /* ---------- 选择框：助手拿不准时把选项摆出来，复用工作台那套面板 ---------- */
  /* 上限只为界面装得下（八题十候选就够一屏了），不是「不许问这么多」——
     真的超了就在面板里写明裁掉多少，用户自己在自由输入框里补。 */
  const ASK_Q_MAX = 8, ASK_O_MAX = 10;
  function askOf(arg) {
    const arr = Array.isArray(arg) ? arg : (arg && Array.isArray(arg.questions) ? arg.questions : []);
    const out = [];
    arr.forEach(x => {
      const q = String((x && (x.q || x.question || x.title)) || '').trim();
      if (!q) return;
      const raw = (Array.isArray(x.options) ? x.options : (Array.isArray(x.choices) ? x.choices : []))
        .map(o => String((o && (o.label || o.text)) || o || '').trim()).filter(Boolean);
      out.push({ q: q, options: raw.slice(0, ASK_O_MAX), cut: raw.length > ASK_O_MAX });
    });
    return out.slice(0, ASK_Q_MAX);
  }
  function askNode(m) {
    const d = document.createElement('div');
    d.className = 'ac-ask';
    if (m.st) {                                   // 已经答过：收成一行，别再摆一遍没答完的面板
      d.className += ' done';
      d.textContent = '（这组问题你已经答过）' + m.st;
      return d;
    }
    const host = document.createElement('div');
    d.appendChild(host);
    const cut = (m.qs || []).filter(q => q.cut).length;
    InlinePolish.ask(host, {
      title: '助手想先问你几件事',
      intro: '点候选就行；候选里没有的写法，点最后一个「其他」自己写。'
        + (cut ? '（有 ' + cut + ' 题候选太多，只画了前 ' + ASK_O_MAX + ' 个，可以自己写剩下的。）' : ''),
      questions: m.qs,
      submitLabel: '按这些回答继续',
      skipLabel: '先不用了，你按默认理解走',
      state: m.pick || [],
      /* 选/写任何一处都存回这条消息：paint() 是全量重画（任务出结果、系统通知都会触发），
         不存的话用户点了一半的候选会被重画抹掉。 */
      onChange(st) { m.pick = st; },
      onSubmit(t) {
        m.st = cap(t, 300);
        save();
        send('（按你在上面给的选项回答了）\n' + t);
      },
      onSkip() {
        m.st = '（跳过了）';
        save();
        send('（那几个问题我跳过了，你按默认理解往下走；拿不准就明说缺什么，别猜。）');
      },
    });
    return d;
  }

  function node(m) {
    if (m.r === 'run') return runNode(m);
    if (m.r === 'cards') return cardsNode(m);
    if (m.r === 'ask') return askNode(m);
    const d = document.createElement('div');
    if (m.r === 'step') { d.className = 'ac-step'; d.textContent = m.t; return d; }
    d.className = 'ac-m ac-' + (m.r === 'me' ? 'me' : m.r);
    const b = document.createElement('div');
    b.className = 'ac-bd';
    /* 助手的回答与「任务出结果了」那条通知按 markdown 画（模型本来就爱用 ** 和列表）；
       用户自己那条保持原样 —— 他要确认的是「我打出去的就是这句」，渲染一遍反而对不上。
       灰色小条与报错是界面文案，本来就不带 markdown。存的是原文（m.t），
       所以「复制」按钮复制的仍是原始 markdown，刷新后重画也还是它。 */
    if (m.r === 'ai' || m.r === 'note') {
      b.className += ' md';
      if (window.Md) Md.mount(b, m.t); else b.textContent = m.t;
    } else b.textContent = m.t;
    /* 用户那条下面挂一排附件芯片：输入框上那排**发完就清掉了**（不清就是「东西还挂在
       输入框里」，看着像没发出去）。这里是这一条消息唯一留下的凭据，
       摘要随消息落盘 —— 刷新之后仍然看得见这条带了什么。 */
    if (m.r === 'me' && (m.fs || []).length) {
      const fw = document.createElement('div');
      fw.className = 'ac-mfs';
      fw.textContent = '随这条发出：';
      m.fs.forEach(f => {
        const s = document.createElement('span');
        s.className = 'ac-fi' + (f.ok ? '' : ' warn');
        s.title = (f.ok ? '' : '字节已不在 ') + (f.note || '') + '｜' + (f.name || '');
        s.textContent = (f.kind || '文件') + '·' + cap(f.name || '', 18);
        fw.appendChild(s);
      });
      d.appendChild(fw);
    }
    d.appendChild(b);
    if (m.r === 'ai' || m.r === 'note') {
      const ft = document.createElement('div');
      ft.className = 'ac-ft';
      const span = document.createElement('span');
      span.textContent = when(m.at);
      const cp = document.createElement('button');
      cp.textContent = '复制';
      cp.onclick = () => {
        const t = m.t;
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
          () => toast('已复制到剪贴板', 'ok'),
          () => toast('浏览器不让直接复制，选中正文手动复制吧', 'warn'));
      };
      ft.appendChild(span); ft.appendChild(cp);
      d.appendChild(ft);
    }
    return d;
  }
  function paint() {
    const box = el.body;
    if (!box) return;
    /* 正在流式写出的那条气泡要在重画之后**原样挂回去**：
       paint() 是全量重画（box.innerHTML=''），而 push() 无条件调它 ——
       finishTask 由 12 秒定时器驱动，正好落在流式期间时，那条气泡会被摘出 DOM 当场消失
       （请求还在跑、还在扣 tokens，字却不见了）。挂的是**同一个节点**，
       所以 addStream 闭包里那几个 bd/th/cur 引用照样有效，已经写出来的字也还在。 */
    const keep = live ? liveEl : null;
    box.innerHTML = '';
    if (!msgs.length) {
      const w = document.createElement('div');
      w.className = 'ac-wel';
      const who = document.createElement('div');
      who.className = 'ac-who';
      /* 开场白里那句「你点执行才真做」是这一层的承诺，勾了自动执行就不能再说这句话 */
      who.textContent = '查询都现查，数字都照结果说。要提交生成任务或改设置，我会先画一张卡片写清「哪一家、哪个型号、什么参数、素材从哪来」，'
        + (autoRun() ? '设置里勾了「执行前不用确认」，所以卡片会自己提交（校验一项都不省）。'
          : '你点「执行」才真做 —— 我不点、不替你点，也不重复点。')
        + '密钥和自定义地址我不碰。';
      w.appendChild(who);
      const q = document.createElement('div');
      q.className = 'ac-q';
      QUICK.forEach(s => {
        const b = document.createElement('button');
        b.className = 'ac-qi';
        b.textContent = s;
        b.onclick = () => send(b.textContent);
        q.appendChild(b);
      });
      w.appendChild(q);
      box.appendChild(w);
    } else msgs.forEach(m => box.appendChild(node(m)));
    if (keep && keep.parentNode !== box) box.appendChild(keep);
    box.scrollTop = box.scrollHeight;
  }
  /* 流式那一条：先只画已经收到的字，收尾时整块换成正式气泡 */
  function addStream() {
    const d = document.createElement('div');
    d.className = 'ac-m ac-ai ac-live';
    d.innerHTML = '<div class="ac-think" hidden></div><div class="ac-bd md"></div><div class="ac-ft"><span data-cur>正在写…</span></div>';
    const box = el.body;
    box.appendChild(d);
    const bd = d.querySelector('.ac-bd'), th = d.querySelector('.ac-think'), cur = d.querySelector('[data-cur]');
    let t = '', tt = '', raf = 0;
    const follow = () => { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 40) box.scrollTop = box.scrollHeight; };
    /* 流式也按 markdown 画：一次回答里最常见的形态就是「**型号**：`x`」这种带标记的行，
       边收边渲染才看得出结构在成形。rAF 合并重画 —— 逐块重渲一段长回答会掉帧。 */
    const repaint = () => {
      raf = 0;
      if (window.Md) Md.mount(bd, t); else bd.textContent = t;
      follow();
    };
    d.scrollIntoView({ block: 'nearest' });
    liveEl = d;                       // paint() 靠它把这条保住（见 paint 里的说明）
    return {
      push(p, kind) {
        if (kind === 'reasoning') { tt += p; th.hidden = false; th.textContent = '思考：' + tt; }
        else { t += p; if (!raf) raf = requestAnimationFrame(repaint); }
        follow();
      },
      note(s) { cur.textContent = s; },
      /* text() 是「按停止」与出错收尾时读全文的地方，那里必须看到最后一屏：
         所以先把还挂着的那一帧立刻画掉（只等 rAF 的话，按下停止会少一截字）。 */
      text: () => { if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} repaint(); } return t; },
      drop() { d.remove(); if (liveEl === d) liveEl = null; },
    };
  }

  /* ---------- 供应方 / 型号下拉：以「下拉里选中的」为唯一真相，发请求时显式带上 ---------- */
  function pickGet() {
    try { return JSON.parse(localStorage.getItem(K_PICK) || '{}') || {}; } catch (e) { return {}; }
  }
  async function provNow() {
    const r = await reg();
    const p = pickGet();
    return (p.prov && Api.prov(p.prov)) || TextAI.prov(r);
  }
  function modelNow() {
    return (el.model && el.model.value) || '';
  }
  async function paintPicks() {
    const r = await reg();
    const all = TextAI.all(r);
    const p = pickGet();
    const cur = (p.prov && Api.prov(p.prov)) || TextAI.prov(r);
    el.prov.innerHTML = all.length
      ? all.map(x => '<option value="' + esc(x.id) + '"' + (cur && x.id === cur.id ? ' selected' : '') + '>'
        + esc(x.name || x.id) + '（' + esc(TextAI.keyId(x)) + '）</option>').join('')
      : '<option value="">注册表里没有文字 AI</option>';
    const mg = cur ? TextAI.modelGroups(cur) : { groups: [] };
    const wantModel = p.model || (cur && TextAI.model(cur)) || '';
    el.model.innerHTML = mg.groups.length
      ? mg.groups.map(g => '<optgroup label="' + esc(g.label) + '">'
        + g.ids.map(id => '<option value="' + esc(id) + '"' + (id === wantModel ? ' selected' : '') + '>' + esc(id) + '</option>').join('')
        + '</optgroup>').join('')
      : '<option value="">这家还没有型号</option>';
    if (window.Dropdowns) Dropdowns.sync(el.picks);
    /* 「这家能不能问」= 本机填了密钥 或 服务端 .env 配了。用 envHas 而不是 TextAI.usable：
       usable 读的那份 _envIds 在 /env-status 命中缓存时不会重建，会把「服务端配了」说成「没配」。 */
    const can = !!cur && (!!TextAI.key(cur) || await TextAI.envHas(cur));
    /* 型号那一列空着的时候要说清下一步去哪儿 —— 只写「这家还没有型号」，
       人就会以为组件坏了（其实是没有 /models 接口，或清单里没你要的那个）。
       抽屉里**不再有「取型号 / ＋型号」**（2026-10 删：管文字 AI 的型号是设置页那一档的事，
       助手只是个问答抽屉），所以这里只指路。 */
    el.hint.textContent = !cur ? '注册表里没有文字 AI 供应方，去设置页配一家'
      : (!mg.groups.length ? '这家还没有型号：去设置页「文字 AI」那一档填一个调用名'
        : (can ? '查询只读；' + (autoRun() ? '设置里勾了「执行前不用确认」，动作卡片会自己提交' : '提交任务与改设置都要你在卡片上点执行')
          : '这家还没配密钥，问了会直接报错'));
  }

  /* ---------- 一次回答：可能要查几次，每查一次在本机跑一条查询再问回去 ---------- */
  function compose(text, ctx, mayCall) {
    const hist = msgs.slice(0, -1).slice(-HIST).filter(m => m.r === 'me' || m.r === 'ai');
    let out = hist.length ? '【之前的对话】\n' + hist.map(m => (m.r === 'me' ? '用户：' : '助手：') + cap(m.t, HIST_EACH)).join('\n') + '\n\n' : '';
    /* 「任务出了什么结果」也要进上下文：note 那几条就是这件事的正文，
       以前只留在气泡里、下一轮模型完全看不到 —— 用户追问「刚才那个任务怎么样了」，
       助手只能说不记得。会话落盘后这里连刷新都还在（acts 也随会话存）。 */
    const notes = msgs.slice(0, -1).filter(m => m.r === 'note').slice(-3);
    if (notes.length) out += '【已经出了结果的任务（照这几条说，别猜）】\n'
      + notes.map(m => cap(m.t, 700)).join('\n---\n') + '\n\n';
    const fb = acts.slice(-6);
    if (fb.length) out += '【这台机器上刚发生过的动作】\n' + fb.map(x => x.动作 + '：' + x.结果 + ' · ' + x.说明).join('\n') + '\n\n';
    /* 画出来的那几张卡片也要说一句：用户看到的正是它们，
       下一句「第二张挺好」里的「第二张」指的就是这个顺序。不写这一句，
       模型只能看到自己复述过的那份文字，用户眼前的东西就变成了不存在的东西。 */
    const cards = msgs.slice(0, -1).filter(m => m.r === 'cards').slice(-2);
    if (cards.length) out += '【对话里画出来的卡片（用户眼前就是这些）】\n'
      + cards.map(m => m.t).join('\n') + '\n\n';
    const f = fileBlock();
    if (f) out += f + '\n';
    if (ctx && ctx.list.length) out += '【已完成的查询】\n' + ctx.list.map(e => e.t).join('\n') + '\n';
    out += '【这次的问题】\n' + text;
    if (!mayCall) out += '\n\n（这一轮先不要再查了：要么查询结果已经把上下文占满，再查只会挤掉更早的结果；要么同一个查询已经问了两遍还没换内容。'
      + '就按上面已有的结果回答，缺什么明说没查到。）';
    return out;
  }
  /* 查询结果往上下文里加，并记账。**次数不设上限**（要查够为止）——
     真正兜住「一直查下去」的是上下文本身：超预算就从最早的开始挤掉，
     并且明写一句「那几条已经不在上下文里」。不写这一句，模型会拿记忆里的旧数字当现查到的报出来，
     而「数字只能来自查询结果」是这套东西最不能破的一条。
     被挤掉的那条连同它的去重键 k 一起没了，所以之后再 CALL 同一件事是允许的（也确实该允许）。 */
  function addCtx(ctx, s, k) {
    ctx.list.push({ k: k || '', t: s });
    ctx.keep += s.length;
    let n = 0;
    while (ctx.keep > CTX_ROOM && ctx.list.length > 1) { ctx.keep -= ctx.list.shift().t.length; n++; }
    if (n) ctx.list.unshift({ k: '', t: '（最早 ' + n + ' 条查询结果已经放不进上下文，被挤掉了；那部分的数据不要再凭记忆回答，缺什么就重新 CALL 一次。）' });
  }
  /* CALL / RUN 后面是「工具名 + JSON」，ASK 后面**直接跟一个 JSON 数组**（没有工具名）——
     所以工具名这一段做成可选的，三种前缀共用一条正则，靠「有没有名字」区分。
     名字那一组不会误吃 ASK 的载荷：载荷必是 [ 或 { 开头的 JSON，两个都不在 [a-zA-Z] 里。 */
  const INSTRUCTION = /^\s*(CALL|RUN|ASK)\s*[：:]\s*([a-zA-Z][\w-]*)?\s*([\s\S]*)$/;
  /* CALL / RUN 都不要求在第一行：模型常常先写两句人话再补一行。只认第一行的话，
     那种回答会被当成「它没打算查」，用户看到的就是一个没查数据的空泛答案。 */
  function parseInstr(out) {
    const lines = String(out || '').split('\n');
    const at = lines.findIndex(L => /^\s*(CALL|RUN|ASK)\s*[：:]/.test(L));
    if (at < 0) return null;
    const m = INSTRUCTION.exec(lines[at]);
    if (!m) return null;
    const tag = m[1].toUpperCase();
    const name = String(m[2] || '').toLowerCase();
    const raw = (m[3] || '').trim();
    const rest = lines.filter((L, i) => i !== at).join('\n').trim();
    if (!raw) return { tag, name, arg: {}, rest };
    try {
      const arg = JSON.parse(raw);
      return { tag, name, arg: (arg && typeof arg === 'object') ? arg : {}, rest };
    } catch (e) { return { tag, name, bad: true, raw: cap(raw, 300), rest }; }
  }
  /* 本轮不让再查时它还可能惯性写一行 CALL/RUN —— 那是给本机的指令，不是给用户看的正文 */
  const stripInstr = s => String(s || '').split('\n').filter(L => !/^\s*(CALL|RUN|ASK)\s*[：:]/.test(L)).join('\n').trim();

  /* 上游的安全过滤**不一定报错**：它 200 正常回来，把
     「User Safety: unsafe / Safety Categories: Harassment, Fraud/Deception」这样一整段
     直接写进 message.content（实测 OpenRouter 免费档就是这样）。
     照旧当成助手的回答显示出去，等于**把「这一次没答成」说成「它就是这么答的」** ——
     用户只会以为助手答完了，而模型没机会解释、也没机会换个说法重试。
     认出这种「整段正文其实就是一条拦截通知」就照实说，别替它包装成答案。 */
  function safetyBlockText(body) {
    const b = String(body == null ? '' : body).trim();
    if (!b || b.length > 400) return '';                       // 真的长回答里提到「安全」不算被拦
    /* 「一条通知」的样子：整行是 `键: 值` / `键=值`，不像句子。键限 ASCII 词字符与空格 ——
       所以「我查了一下：content_filter 那条设置没勾」这种**正常中文回答不会**被当成通知，
       而 `User Safety: unsafe` / `finish_reason=content_filter` 会。 */
    const lines = b.split('\n').map(x => x.trim()).filter(Boolean);
    const MARK = /user\s*safety|content[_ ]policy|safety\s*categor|content_filter|finish_reason|finishreason|prohibited[_ ]content|blocked\s+by/i;
    const NOTICE = /^[A-Za-z][A-Za-z0-9 ._-]{1,38}\s*[:=]\s*[^。！？]{1,160}$/;
    if (!lines.length || lines.length > 6) return '';
    if (!lines.some(L => MARK.test(L))) return '';              // 一个安全关键词都没有
    if (!lines.every(L => NOTICE.test(L))) return '';           // 只要有一行不是「通知」，就当它是正文
    const cats = (/safety\s*categor(?:y|ies)\s*[:=]\s*([^\n]+)/i.exec(b) || [])[1] || '';
    return '这一轮**上游的安全过滤把请求挡住了，它没有作答**'
      + (cats ? '（它自己标的类别：' + cap(cats.trim(), 80) + '）' : '')
      + '。这不是本机出问题，也不是你的操作有错 —— 换个说法、把那张图撤掉再试，'
      + '或者到设置页换一个型号（不同模型的尺度不一样，你现在是「每次随机换一个免费模型」）。';
  }

  async function runTool(name, arg) {
    const t = TOOLS[name];
    if (!t) return { 错误: '没有这个查询：' + name, 可用: Object.keys(TOOLS) };
    try { return await t.run(arg || {}); }
    catch (e) { return { 错误: cap((e && e.message) || e, 300) }; }
  }

  async function send(text) {
    const q = String(text == null ? '' : text).trim();
    /* 只带文件、一个字没打也是一次完整的发送（「把这张图看看」根本不用打字）。
       以前这里直接 return，于是「拖了图 → 按 Enter」毫无反应，
       看起来就是「文件发不出去」。占位文字要写明是用户没打字，
       别让助手以为用户真的只说了这一句。 */
    const onlyFiles = !q && files.length > 0;
    if (!q && !onlyFiles) return;
    if (live) { toast('上一条还在写，先按「停止」', 'warn'); return; }
    let r;
    try { r = await reg(); } catch (e) { push('err', (e && e.message) || e); return; }
    const prov = await provNow();
    const model = modelNow();
    if (!prov) { push('err', '注册表里没有文字 AI 供应方，先去设置页配一家'); return; }
    if (!model) { push('err', '这一家还没有可选型号：到设置页「文字 AI」那一档里填一个调用名'); return; }
    openPanel();
    el.ta.value = '';
    const shot = shotFiles();
    /* 气泡上挂上这一条带了什么，**然后立刻把输入框上那排芯片清掉**：
       「发出去的东西还挂在输入框里」会被当成没发出去，于是再发一次（等于白花一轮 tokens）。
       摘要跟着消息落盘，刷新后也还在。 */
    push('me', q || '（只带了文件，没打字）', shot.length ? { fs: shot } : null);
    clearFiles();
    aborter = new AbortController();
    busy(true);
    const ctx = { list: [], keep: 0 };
    let stale = 0;                         // 连续几轮只查了重复的东西
    try {
      /* 查询次数不设上限：模型要查几次就查几次。退出只看三件事 —— 它自己交出了正文（不再写 CALL/RUN）、
         查询结果把上下文占满了、或者同一个查询连着问 STALE_MAX 遍还没换内容（唯一的兜底）。 */
      for (let round = 0; ; round++) {
        const mayCall = ctx.keep < CTX_ROOM && stale < STALE_MAX;
        const st = addStream();
        live = st;
        let out = '';
        /* 附图只在第一轮带（查询那一轮不需要看图的就不带，省 tokens 也省一次压缩） */
        const att = round === 0 ? await attachImages(prov, model) : { images: [], note: '' };
        try {
          out = await TextAI.chatStream(r, SYS, compose(q, ctx, mayCall),
            { signal: aborter.signal, model, images: att.images }, (p, k) => st.push(p, k), prov);
        } catch (e) {
          const m = (e && e.message) || String(e);
          const got = st.text();
          live = null; st.drop();
          push(got ? 'ai' : 'err', got ? got + '\n\n（这次写到这儿断了：' + m + '）' : m);
          return;
        }
        live = null; st.drop();
        const ins = mayCall ? parseInstr(out) : null;
        if (!ins) {
          const body = stripInstr(out);
          /* 整段正文只是上游的一条拦截通知时，**别当助手的回答显示**（见 safetyBlockText）。 */
          const blocked = safetyBlockText(body);
          if (blocked) { push('err', blocked); return; }
          /* 空正文要分开说：一句「只写了查询」是给错的原因 —— 它可能一个字都没回（型号不对 / 上游抽风），
             也可能被指令行占满。原因不一样，用户下一步该做的事也不一样。 */
          if (body) push('ai', body + (att.note ? '\n\n（' + att.note + '）' : ''));
          else push('err', /^\s*(CALL|RUN|ASK)/i.test(out)
            ? '它这次只写了' + (/^\s*RUN/i.test(out) ? '提交' : /^\s*ASK/i.test(out) ? '反问' : '查询') + '、没给正文。把要求说具体一点，或换个型号再问。'
            : '这一家一个字也没回（型号或接口不对时就是这样）。换个型号再问一次。');
          return;
        }
        /* ASK：模型拿不准的时候（该用哪一家、要不要先清掉旧任务）把选项摆出来让用户点。
           它是**问**，不是动作 —— 所以不走确认卡片、也不动任何本机数据；
           画完就结束这一轮（`return`），因为下面每一步都该由用户的回答来决定。 */
        if (ins.tag === 'ASK') {
          const qs = askOf(ins.arg);
          if (!qs.length) {
            addCtx(ctx, '> ASK 没解析出题目。写成 [{"q":"问题","options":["候选1","候选2"]}]：q 是问题，options 是可点选的候选（每题至少两个；用户也可以在每题的自由输入框里自己写）。\n');
            push('step', '选择框没画出来（题目格式不对），退回去重写');
            continue;
          }
          push('ask', '', { qs: qs });
          return;
        }
        const isAct = ins.tag === 'RUN';
        const table = isAct ? ACTS : TOOLS;
        const what = isAct ? '动作' : '查询';
        if (!table[ins.name]) {
          addCtx(ctx, '> ' + what + ' ' + ins.name + ' 不存在。可用：' + Object.keys(table).join(' / ') + '。\n');
          push('step', '它想' + (isAct ? '做' : '查') + '「' + ins.name + '」，没有这一项');
          continue;
        }
        if (ins.bad) {
          /* 不吞掉、也不自己动手补全：把原话退回让它重写（猜参数=查错东西 / 提交错东西，比查不到更坏） */
          addCtx(ctx, '> ' + what + ' ' + ins.name + ' 的参数不是合法 JSON：' + ins.raw + '。重写这一行，JSON 放在一行里。\n');
          push('step', '「' + ins.name + '」的参数没写对，退回去重写');
          continue;
        }
        if (isAct) {
          let chk = null;
          try { chk = await table[ins.name].check(ins.arg); }
          catch (e) { chk = { err: cap((e && e.message) || e, 300) }; }
          if (chk && chk.err) {
            addCtx(ctx, '> 动作 ' + ins.name + ' 没过校验：' + chk.err + '。改对再提，或者直接告诉用户缺什么。\n');
            push('step', '「' + ins.name + '」没过校验：' + cap(chk.err, 160) + ' —— 退回去改');
            continue;
          }
          const m = push('run', chk.说明, { act: ins.name, arg: ins.arg, 人话: chk.人话, st: '', 钉: chk.钉 });
          if (ins.rest) push('step', cap(ins.rest, 120));
          /* 设置里勾了「执行前不用我点确认」时，卡片照画（写了什么、成没成都要看得见），
             只是不等人那一下点击。校验在上面已经全做完了，所以这里没有任何东西被跳过。 */
          if (autoRun()) {
            m.auto = true;
            push('step', '按设置里「执行前不用确认」直接提交');
            execRun(m);
          }
          return;                       // 本轮到此为止（等点击，或上面那一句已经提交）
        }
        /* 同一轮里完全相同的一次查询不重复跑：结果已经在这条上下文里，重跑只是白花 tokens。
           去重键跟着结果一起被挤掉，所以它真的不在上下文里时，重新 CALL 是对的。
           （这一支也必须往上下文里写一句 —— 什么都不写的话，模型问一遍、我们不答、它再问，
             没有次数上限就永远转下去。） */
        const k = ins.name + ' ' + JSON.stringify(ins.arg || {});
        if (ctx.list.some(e => e.k === k)) {
          stale++;
          addCtx(ctx, '> 查询 ' + ins.name + '：这一轮里已经查过同一份，没有重查 —— 结果就在上面那几条里，别再问同一件事。\n');
          push('step', ins.name + ' 刚才查过同一份，没重查（结果还在上下文里）');
          continue;
        }
        const res = await runTool(ins.name, ins.arg);
        const txt = jdump(res);
        /* 一行说清「查了什么 + 拿到多大一份」：查询名与结果大小是同一条事实的两半，不分成两条 */
        push('step', '查了 ' + ins.name + '(' + cap(JSON.stringify(ins.arg || {}), 120) + ') → ' + txt.length + ' 字'
          + (ins.rest ? ' · ' + cap(ins.rest, 90) : ''));
        stale = 0;
        addCtx(ctx, '> 查询 ' + ins.name + '(' + cap(JSON.stringify(ins.arg || {}), 200) + ') 的结果：\n' + txt + '\n', k);
      }
    } finally {
      busy(false);
      aborter = null;
      live = null;
      /* roundFiles **故意不清**：它就是「助手这一头现在能看到的附件」。
         清了的话下一轮追问「第二张里是什么」就没得答、生成卡片上的附件序号也会指空。
         下一轮 send() 会用新的快照顶掉它。 */
    }
  }
  function busy(on) {
    el.send.disabled = !!on;
    el.stop.hidden = !on;
    if (el.attach) el.attach.disabled = !!on;
  }

  /* ---------- 展开 / 收起 ----------
     展开状态**不跨刷新保存**：记住「上次是开着的」等于每一次刷新都先把抽屉糊在页面上，
     而这一层是悬浮球 —— 想要的时候点一下就有。 */
  function setOpen(v) {
    document.documentElement.classList.toggle('ac-open', !!v);
    if (v) {
      if (el.ta) el.ta.focus();
      if (el.body) el.body.scrollTop = el.body.scrollHeight;
      /* 抽屉一开就算「看过了」：球上的点清掉，但等待清单不动 ——
         它记的是「有没有提醒过你」，不是「任务还没完」。 */
      const st = wread();
      if (st.unread) { st.unread = 0; try { localStorage.setItem(K_WATCH, JSON.stringify(st)); } catch (e) {} }
      tickBadge(st);
    }
  }
  const isOpen = () => document.documentElement.classList.contains('ac-open');
  /* 不叫 open/close：模块里 shadow 掉全局 open 以后，谁再想 window.open 一下就被无声改道 */
  function openPanel() {
    if (!isOpen()) setOpen(true);
    if (el.histBox && !el.histBox.hidden) paintHist();
  }
  function closePanel() { if (isOpen()) setOpen(false); }

  /* ---------- 悬浮球：位置可拖，落在 ai_chat_xy ---------- */
  const BALL = 46;
  function xyGet() {
    try {
      const o = JSON.parse(localStorage.getItem(K_XY) || 'null');
      if (o && Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y))) return { x: Number(o.x), y: Number(o.y) };
    } catch (e) {}
    return null;
  }
  /* 左栏那一块是 z=90，悬浮球只有 z=56：球停在它覆盖的那一条里就点不到了（等于把助手弄丢）。
     所以左边界让开 --sbw（展开时 sidebar.js 把它改成 200px），存过的旧位置也在下一次摆放时挪回来。 */
  const sbW = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sbw'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const clampXY = (x, y) => ({
    x: Math.max(8 + sbW(), Math.min(window.innerWidth - BALL - 6, x)),
    y: Math.max(6, Math.min(window.innerHeight - BALL - 6, y)),
  });
  /* 拖到边上就「吸」住（设置页 AI 助手那一卡可关，键 ai_chat_snap，默认开）：
     球是 46px 的小目标，停在离边 20px 的位置上既难点中也容易和窗口边缘的滚动条打架，
     贴边摆反而一眼能看到、也腾出了中间的位置。
     **左右两边任意高度都吸**（不是只有贴着边的那 26px 才吸）：判据是「球心落在可用区哪一半」，
     松手时在左半边就去最左、右半边就去最右。以前的「离边 ≤26px」在窗口宽时等于大部分地方都不吸，
     往边上甩一把却没吸住，手感是「有时候吸有时候不吸」。
     **上下不吸**：球留在松手时的高度，贴边只管左右 —— 一条竖排的边才看得出「贴住了」，
     上下都贴就成了贴满四边的一个角，反而不知道它算哪一边。
     左边那条界让开 sbW()：吸附不能把球塞进侧栏（z=90）盖住的那一带，否则等于把助手弄丢。
     分界线用**可用区**（扣掉侧栏之后）的中点，不是窗口中点 —— 侧栏展开时可用区整体偏右，
     拿窗口中点判会把明显偏右的位置也吸到左边。 */
  const snapOn = () => localStorage.getItem(K_SNAP) !== '0';
  function snapXY(x, y) {
    if (!snapOn()) return { x, y };
    const minX = 8 + sbW(), maxX = window.innerWidth - BALL - 6;
    x = x <= (minX + maxX) / 2 ? minX : maxX;
    return { x, y };
  }
  function placeBall() {
    if (!el.ball) return;
    const saved = xyGet();
    const p = clampXY(...Object.values(saved || { x: window.innerWidth - BALL - 16, y: window.innerHeight - BALL - 18 }));
    el.ball.style.left = p.x + 'px';
    el.ball.style.top = p.y + 'px';
    /* 摆正之后把坐标也写回去（只在真的挪过的时候写）：不写的话「保存值」和「看见的位置」是两回事，
       而下一次 pointerdown 用的是保存值 —— 侧栏一展开球就到 208，手一抓却从 70 起算，
       球会先往左跳 138px 再跟着手走。收起侧栏时同理会被拽回旧位置。 */
    if (saved && (saved.x !== p.x || saved.y !== p.y)) {
      try { localStorage.setItem(K_XY, JSON.stringify({ x: p.x, y: p.y })); } catch (e) {}
    }
  }
  function bindBallDrag() {
    const b = el.ball;
    let start = null, moved = false;
    b.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const p = xyGet() || { x: b.offsetLeft, y: b.offsetTop };
      start = { x: p.x, y: p.y, px: e.clientX, py: e.clientY };
      moved = false;
      try { b.setPointerCapture(e.pointerId); } catch (err) {}
    });
    b.addEventListener('pointermove', e => {
      if (!start) return;
      const dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      b.classList.add('drag');
      const c = clampXY(start.x + dx, start.y + dy);
      b.style.left = c.x + 'px';
      b.style.top = c.y + 'px';
    });
    const end = e => {
      if (!start) return;
      try { b.releasePointerCapture(e.pointerId); } catch (err) {}
      b.classList.remove('drag');
      if (moved) {
        const s = snapXY(b.offsetLeft, b.offsetTop);
        const c = clampXY(s.x, s.y);
        try { localStorage.setItem(K_XY, JSON.stringify({ x: c.x, y: c.y })); } catch (err) {}
        b.style.left = c.x + 'px'; b.style.top = c.y + 'px';
      }
      start = null;
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    /* click 在 pointerup 之后还会发一次：拖动过就把它吃掉，不要拖完顺手把抽屉开合一遍 */
    b.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      if (isOpen()) closePanel(); else openPanel();
    });
    window.addEventListener('resize', placeBall);
    /* 侧栏收起 ↔ 展开改的是 --sbw（66 / 200），而球不会自己动：球原先贴在左边 74px 处，
       一展开就被侧栏（z=90）盖住，点不到 = 助手看着像没了。sidebar.js 每次 apply() 末尾发这一条。 */
    window.addEventListener('sb:toggle', placeBall);
  }

  /* ---------- 装到页面上 ---------- */
  /* 助手这一层挂在外壳上，而外壳没有内容页那条全局 border-box：
     `width:100%` 再叠上自己的 padding(10)+border(1)，确认卡片就比抽屉宽 22px，
     右边整条戳到窗口外（实测卡片右边缘 1510 > 视口 1500）。 */
  const CSS = `
#acPanel *,#acPanel *::before,#acPanel *::after,#acBall{box-sizing:border-box}
#acBall{position:fixed;right:auto;bottom:auto;left:auto;top:auto;z-index:56;width:${BALL}px;height:${BALL}px;border-radius:50%;padding:0;
  border:1px solid var(--line,#e4e6f0);background:var(--panel,#fff);color:var(--acc,#6957e8);
  display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;
  box-shadow:0 6px 18px rgba(20,22,40,.16);transition:filter .12s ease}
#acBall:hover{filter:brightness(1.08)}
#acBall.drag{cursor:grabbing;transition:none}
#acBall:focus-visible{outline:2px solid var(--acc,#6957e8);outline-offset:2px}
html.ac-open #acBall{display:none}
#acPanel{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);z-index:56;background:var(--panel,#fff);
  border-left:1px solid var(--line,#e4e6f0);display:flex;flex-direction:column;
  transform:translateX(101%);transition:transform .18s ease;pointer-events:none}
html.ac-open #acPanel{transform:none;pointer-events:auto;box-shadow:-10px 0 26px rgba(20,22,40,.14)}
.ac-hd{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid var(--line,#e4e6f0);
  background:linear-gradient(180deg,rgba(124,92,255,.09),rgba(124,92,255,0))}
.ac-hd .ac-tt{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:700;color:var(--acc,#6957e8)}
.ac-hd .ac-here{font-size:10.5px;color:var(--sub,#8a8fa3);flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.ac-x{flex:0 0 auto;border:0;background:transparent;color:var(--sub,#8a8fa3);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px}
.ac-x:hover{color:var(--txt,#23262f)}
.ac-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:9px;overscroll-behavior:contain}
.ac-wel{display:flex;flex-direction:column;gap:9px}
.ac-who{font-size:11.5px;line-height:1.6;color:var(--sub,#8a8fa3);background:var(--panel2,#f3f4f9);
  border:1px solid var(--line,#e4e6f0);border-radius:8px;padding:8px 10px}
.ac-q{display:flex;flex-wrap:wrap;gap:6px}
.ac-qi{border:1px solid var(--line,#e4e6f0);background:var(--panel,#fff);color:var(--txt,#23262f);
  border-radius:14px;padding:5px 10px;font-size:11.5px;cursor:pointer;white-space:normal;text-align:left}
.ac-qi:hover{border-color:var(--acc,#6957e8);color:var(--acc,#6957e8)}
.ac-m{display:flex;flex-direction:column;gap:3px}
.ac-ai{align-items:flex-start}.ac-me{align-items:flex-end}.ac-err{align-items:flex-start}.ac-note{align-items:flex-start}
.ac-bd{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.62;padding:8px 10px;border-radius:8px;max-width:100%}
/* markdown 那几条气泡改回 normal：pre-wrap 是给纯文本准备的，而 Md 产出的是块级元素 ——
   块与块之间本来就有结构，再让容器把换行也当一次换行，段落之间就多出一截空行。
   行内的换行由 Md 自己转成 <br>（约定③），所以版式不丢。
   写 .ac-bd.md 而不是靠加载顺序压过 .ac-bd：这份样式是运行时注入的，与 ui.css 同权重。 */
.ac-bd.md{white-space:normal}
.ac-me .ac-bd{background:rgba(124,92,255,.14);color:var(--txt,#23262f)}
.ac-ai .ac-bd{background:var(--panel2,#f3f4f9);border:1px solid var(--line,#e4e6f0);color:var(--txt,#23262f)}
.ac-err .ac-bd{background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.24);color:var(--err,#dc2626)}
/* 助手自己那条「任务出结果了」的通知气泡：不是用户问出来的，所以要和问答区分开（虚线边 + 强调色） */
.ac-note .ac-bd{background:var(--panel2,#f3f4f9);border:1px dashed var(--acc,#6957e8);color:var(--txt,#23262f)}
/* ---------- 历史任务卡片（history 查询画在回答下面的那些） ----------
   图片直接显示、视频就地播、语音给播放器；src 一律是 Api.mediaSrc 换过的本机地址。
   .ac-card-media 上要有 .ready（Wb.thumbs 出画后加的），占位层 .tph 由 ui.css 排版。 */
.ac-cards{display:flex;flex-direction:column;gap:7px;width:100%}
.ac-cards-hd{font-size:10.5px;line-height:1.5;color:var(--sub,#8a8fa3)}
.ac-card{background:var(--panel,#fff);border:1px solid var(--line,#e4e6f0);border-radius:8px;overflow:hidden}
.ac-card-media{position:relative;background:var(--panel2,#f3f4f9)}
.ac-card-media .ac-img,.ac-card-media .ac-vid{display:block;width:100%;max-height:220px;object-fit:contain;background:#000}
.ac-aud{display:block;width:100%;padding:6px 8px}
.ac-card-bd{padding:7px 9px;display:flex;flex-direction:column;gap:4px}
.ac-card-meta{font-size:10.5px;line-height:1.5;color:var(--sub,#8a8fa3);overflow-wrap:anywhere}
.ac-card-prompt{font-size:12px;line-height:1.55;color:var(--txt,#23262f);overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ac-card-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ac-card-id{font-size:10px;line-height:1.5;color:var(--sub,#8a8fa3);overflow-wrap:anywhere;min-width:0}
.ac-card-go{border:1px solid var(--line,#e4e6f0);background:var(--panel,#fff);color:var(--txt,#23262f);
  border-radius:6px;padding:2px 8px;font-size:10.5px;line-height:1.5;cursor:pointer;white-space:nowrap}
.ac-card-go:hover{border-color:var(--acc,#6957e8);color:var(--acc,#6957e8)}
/* ---------- 选择框（ASK 画的） ----------
   面板本体是 InlinePolish.ask 画的，样式在 ui.css 的 .pinl 那一套 —— 这里只管它在这条消息里的位置。 */
.ac-ask{width:100%}
.ac-ask.done{font-size:11px;line-height:1.55;color:var(--sub,#8a8fa3);padding:5px 8px;
  background:var(--panel2,#f3f4f9);border:1px dashed var(--line,#e4e6f0);border-radius:7px;
  white-space:pre-wrap;overflow-wrap:anywhere}
/* 球上的计数点：pointer-events:none —— 它盖在球的右上角，不能吃掉球的点击（否则点不动助手就等于弄丢） */
.ac-dot{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;
  background:var(--sub,#8a8fa3);color:#fff;font-size:10.5px;font-weight:700;line-height:17px;text-align:center;
  border:1.5px solid var(--panel,#fff);pointer-events:none}
.ac-dot.new{background:var(--acc,#6957e8);animation:acPulse 1.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.ac-dot.new{animation:none}}
.ac-ft{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--sub,#8a8fa3)}
.ac-ft button{border:0;background:transparent;color:var(--sub,#8a8fa3);font-size:10.5px;padding:0;cursor:pointer}
.ac-ft button:hover{color:var(--acc,#6957e8)}
.ac-step{align-self:flex-start;font-size:10.5px;line-height:1.5;color:var(--sub,#8a8fa3);
  background:var(--panel2,#f3f4f9);border:1px dashed var(--line,#e4e6f0);border-radius:6px;padding:3px 8px;max-width:100%;overflow-wrap:anywhere}
.ac-think{font-size:10.5px;line-height:1.5;color:var(--sub,#8a8fa3);max-height:64px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.ac-live .ac-bd:empty::before{content:'…';color:var(--sub,#8a8fa3)}
.ac-run{align-items:flex-start}
.ac-run-card{background:var(--panel,#fff);border:1px solid var(--acc,#6957e8);border-radius:8px;width:100%}
.ac-run-hd{font-size:11.5px;font-weight:700;color:var(--acc,#6957e8);margin-bottom:4px}
.ac-run-row{font-size:11.5px;line-height:1.6;color:var(--txt,#23262f);white-space:pre-wrap;overflow-wrap:anywhere}
.ac-run-bd{display:flex;align-items:center;gap:7px}
.ac-run-st{font-size:11px;line-height:1.55;margin-top:5px;padding:5px 8px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;width:100%}
.ac-run-st.ok{background:rgba(22,163,74,.10);border:1px solid rgba(22,163,74,.26);color:var(--ok,#16a34a)}
.ac-run-st.err{background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.24);color:var(--err,#dc2626)}
/* 正在执行的那一会儿不能是绿色：绿色 = 「已经做完了」，而这一行写的是「正在提交…」，
   看着就像提交已经成功（其实接口还没回）。 */
.ac-run-st.run{background:var(--panel2,#f3f4f9);border:1px solid var(--line,#e4e6f0);color:var(--sub,#8a8fa3)}
.ac-files{display:flex;flex-wrap:wrap;gap:5px}
.ac-fi{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;line-height:1.4;color:var(--txt,#23262f);
  background:var(--panel2,#f3f4f9);border:1px solid var(--line,#e4e6f0);border-radius:12px;padding:2px 4px 2px 8px;max-width:100%;overflow-wrap:anywhere}
.ac-fi.warn{border-color:var(--warn,#d97706);color:var(--warn,#d97706)}
.ac-fi button{border:0;background:transparent;color:var(--sub,#8a8fa3);font-size:13px;line-height:1;cursor:pointer;padding:0 4px}
.ac-fi button:hover{color:var(--err,#dc2626)}
/* 用户那条消息下面的附件芯片：与输入框上那排同一套 .ac-fi，只是不可删
   （那是「这一条已经发出去了」的记录，不是草稿）。 */
.ac-mfs{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-bottom:4px;
  max-width:92%;font-size:10.5px;color:var(--sub,#8a8fa3)}
.ac-mfs .ac-fi{padding:2px 8px}
.ac-in{flex:0 0 auto;border-top:1px solid var(--line,#e4e6f0);padding:9px 10px;display:flex;flex-direction:column;gap:7px}
.ac-ta{width:100%;min-height:56px;max-height:34vh;resize:vertical;padding:8px 9px;font-family:inherit;
  font-size:12.5px;line-height:1.5;color:var(--txt,#23262f);background:var(--input,#f6f7fb);
  border:1px solid var(--line,#e4e6f0);border-radius:7px}
.ac-ta:focus{border-color:var(--acc,#6957e8);outline:none}
.ac-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.ac-row .sp{flex:1 1 auto}
.ac-picks{display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
.ac-picks i{font-style:normal;font-size:10.5px;color:var(--sub,#8a8fa3);letter-spacing:.02em}
/* 这一排在抽屉最底下。以前要在这里手写「改成往上开」（下面那三条 top:auto/bottom:…）：
   公共下拉原来原地展开、只会往下开，伸到视口外就只看得见一半。
   现在浮层挂 body、坐标由 ui.js 的 place() 现算（下方不够就往上开、按可用高度封顶），
   容器不再决定方向 —— 这条特例因此删掉，**别再加回来**（通用机制已经覆盖了它）。 */
.ac-picks .dd{flex:0 1 auto;min-width:0}
.ac-picks .dd-btn{padding:6px 9px;font-size:12px;border-radius:7px;max-width:186px;background:var(--panel,#fff)}
.ac-hint{font-size:10.5px;line-height:1.5;color:var(--sub,#8a8fa3)}
/* 历史会话：盖在对话区**上面**的一块浮层，不把对话区换掉（换掉的话点错一下，写的字就没了） */
.ac-hist{position:absolute;left:8px;right:8px;top:42px;z-index:3;background:var(--panel,#fff);
  border:1px solid var(--line,#e4e6f0);border-radius:9px;box-shadow:0 10px 26px rgba(20,22,40,.18);
  max-height:min(430px,62vh);display:flex;flex-direction:column;overflow:hidden}
.ac-hist[hidden]{display:none}
.ac-hist-h{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--line,#e4e6f0);
  font-size:10.5px;color:var(--sub,#8a8fa3)}
.ac-hist-h b{flex:1 1 auto;font-size:12px;font-weight:600;color:var(--txt,#23262f)}
.ac-hist-l{overflow-y:auto;padding:5px}
.ac-hs{position:relative;display:block;width:100%;text-align:left;border:0;background:transparent;
  border-radius:7px;padding:6px 26px 6px 9px;cursor:pointer;color:inherit;font:inherit}
.ac-hs:hover{background:var(--input,#f6f7fb)}
.ac-hs.on{background:var(--input,#f6f7fb);box-shadow:inset 2px 0 0 var(--acc,#6957e8)}
.ac-hs-t{font-size:12.5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ac-hs-m{font-size:10.5px;color:var(--sub,#8a8fa3);margin-top:2px}
.ac-hs-x{position:absolute;right:4px;top:6px;border:0;background:transparent;color:var(--sub,#8a8fa3);
  font-size:14px;line-height:1;cursor:pointer;padding:2px 5px;border-radius:5px}
.ac-hs-x:hover{color:var(--err,#dc2626);background:var(--panel,#fff)}
.ac-x.ic{display:inline-flex;align-items:center;justify-content:center;padding:3px}
.ac-x.ic:hover{background:var(--input,#f6f7fb)}
.ac-x.on{color:var(--acc,#6957e8);background:var(--input,#f6f7fb)}
#acPanel.ac-drop{outline:2px dashed var(--acc,#6957e8);outline-offset:-6px}
`;

  function mount() {
    if (document.getElementById('acPanel')) return;
    const st = document.createElement('style');
    st.id = 'acStyle';
    st.textContent = CSS;
    document.head.appendChild(st);

    const ball = document.createElement('button');
    ball.id = 'acBall';
    ball.title = 'AI 助手（可以拖动' + (snapOn() ? '；拖到边上会吸住，设置页「AI 助手」那一卡可关' : '') + '）';
    ball.setAttribute('aria-label', '打开 AI 助手');
    ball.innerHTML = window.icon('sparkles', 20);
    /* 球上的小圆点：在等几条任务 / 有几条结果还没看。抽屉收起时它是唯一的提醒入口，
       所以它画在球里而不是另起一个浮层（再叠一层就会和拖动、和侧栏的遮挡抢位置）。 */
    const dot = document.createElement('span');
    dot.className = 'ac-dot';
    dot.id = 'acDot';
    dot.hidden = true;
    ball.appendChild(dot);
    el.dot = dot;
    document.body.appendChild(ball);
    el.ball = ball;
    placeBall();
    bindBallDrag();
    /* 刷新/换页之后接着等：等待清单在 localStorage 里，任务号是平台给的，
       所以「关掉这一层再回来」不会重新提交一次（那是会重复扣费的）。 */
    tickBadge();
    if (wread().items.length) startWatch();

    const p = document.createElement('div');
    p.id = 'acPanel';
    p.setAttribute('role', 'complementary');
    p.setAttribute('aria-label', 'AI 助手');
    p.innerHTML = `
      <div class="ac-hd">
        <span class="ac-tt">${window.icon('sparkles', 15)}AI 助手</span>
        <span class="ac-here" id="acHere"></span>
        <button class="ac-x ic" id="acNew" title="新建会话（另开一段对话，这一段留在历史里）" aria-label="新建会话"><span data-icon="plus" data-size="15"></span></button>
        <button class="ac-x ic" id="acHist" title="历史会话" aria-label="历史会话"><span data-icon="clock" data-size="15"></span></button>
        <button class="ac-x" id="acClose" title="收起" aria-label="收起">×</button>
      </div>
      <div class="ac-hist" id="acHistBox" hidden>
        <div class="ac-hist-h"><b>历史会话</b><span id="acHistSum"></span><button class="ac-x" id="acHistClose" title="关掉">×</button></div>
        <div class="ac-hist-l" id="acHistList"></div>
      </div>
      <div class="ac-body" id="acBody"></div>
      <div class="ac-in">
        <div class="ac-files" id="acFiles" hidden></div>
        <textarea class="ac-ta" id="acTa" placeholder="问点什么，或把文件拖进来（Enter 发送 · Shift+Enter 换行）"></textarea>
        <div class="ac-row">
          <span class="ac-picks" id="acPicks"><i>接口</i><select id="acProv"></select><i>型号</i><select id="acModel"></select></span>
          <button class="ghost" id="acFile" title="添加文件（图片会被当前型号真去看；也能直接当生成素材）">＋文件</button>
          <input type="file" id="acFileIn" multiple hidden>
          <span class="sp"></span>
          <button class="ghost" id="acWipe" title="清空对话记录">清空</button>
          <button class="ghost" id="acStop" hidden>停止</button>
          <button class="tool acc" id="acSend">发送</button>
        </div>
        <div class="ac-hint" id="acHint"></div>
      </div>`;
    document.body.appendChild(p);

    el.panel = p;
    el.body = $('acBody'); el.ta = $('acTa'); el.send = $('acSend'); el.stop = $('acStop');
    el.prov = $('acProv'); el.model = $('acModel'); el.picks = $('acPicks');
    el.wipe = $('acWipe'); el.here = $('acHere'); el.hint = $('acHint');
    el.close = $('acClose'); el.attach = $('acFile'); el.fileIn = $('acFileIn'); el.files = $('acFiles');
    el.newS = $('acNew'); el.hist = $('acHist'); el.histBox = $('acHistBox'); el.histList = $('acHistList');
    /* 图标只有 ICONS 一份几何：这里写 data-icon，由 ui.js 的 fillIcons 填成 SVG */
    try { window.fillIcons(p); } catch (e) {}

    syncHere();
    el.close.onclick = closePanel;
    el.send.onclick = () => send(el.ta.value);
    /* 新建会话：这一段留在历史里，随时能切回去；不是「清空」 */
    el.newS.onclick = () => {
      if (live) return toast('上一条还在写，先按「停止」', 'warn');
      if (pendingRun()) return toast('还有一张没确认的卡片，先点「执行」或「取消」', 'warn');
      newSession(); paint(); paintHist();
      closeHist();
      try { el.ta.focus(); } catch (e) {}
      toast('新会话已开（上一段在「历史会话」里）', 'ok');
    };
    el.hist.onclick = () => {
      if (!el.histBox) return;
      const show = el.histBox.hidden;
      el.histBox.hidden = !show;
      el.hist.classList.toggle('on', show);
      if (show) paintHist();
    };
    /* closeHist 是模块级那一处（paintHist 选中一条后也要用它） */
    const histClose = $('acHistClose');
    if (histClose) histClose.onclick = closeHist;

    el.wipe.onclick = () => {
      /* 正在写 / 还有一张没确认的卡片时不清：paint() 会把它们一起画掉，
         前者丢字而请求还在跑，后者是用户本来打算执行的提案 */
      if (live) return toast('上一条还在写，先按「停止」', 'warn');
      if (pendingRun()) return toast('还有一张没确认的卡片，先点「执行」或「取消」', 'warn');
      if (!msgs.length) return toast('已经是空的了', 'info');
      msgs = []; acts = []; save(); paint(); paintHist(); toast('这一段对话清空了（历史会话里还留着别的段）', 'ok');
    };
    el.stop.onclick = () => {
      if (!aborter) return;
      try { aborter.abort(); } catch (e) {}
      if (live) live.note('已停止（前面写出来的留着）');
    };
    el.attach.onclick = () => el.fileIn.click();
    el.fileIn.onchange = async () => {
      const list = el.fileIn.files;
      if (list && list.length) { await addFiles(list); toast('带进来 ' + list.length + ' 个文件', 'ok'); }
      el.fileIn.value = '';
    };
    ['dragenter', 'dragover'].forEach(t => p.addEventListener(t, e => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); p.classList.add('ac-drop'); }
    }));
    ['dragleave', 'dragend'].forEach(t => p.addEventListener(t, () => p.classList.remove('ac-drop')));
    p.addEventListener('drop', async e => {
      p.classList.remove('ac-drop');
      const list = e.dataTransfer && e.dataTransfer.files;
      if (!list || !list.length) return;
      e.preventDefault();
      await addFiles(list);
      toast('带进来 ' + list.length + ' 个文件', 'ok');
    });
    /* 外壳这一层（侧栏、抽屉外的边距）也接住：抽屉收起时用户会往窗口上丢文件。
       页面内部的下落发生在 iframe 自己的文档里，到不了这一层 —— 那种情况先把抽屉打开再拖。 */
    document.addEventListener('dragover', e => { if (Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', async e => {
      if (el.panel.contains(e.target)) return;
      const list = e.dataTransfer && e.dataTransfer.files;
      if (!list || !list.length) return;
      e.preventDefault();
      await addFiles(list);
      openPanel();
      toast('带进来 ' + list.length + ' 个文件', 'ok');
    });
    el.prov.onchange = () => {
      const v = el.prov.value;
      try { localStorage.setItem(K_PICK, JSON.stringify(Object.assign({}, pickGet(), { prov: v, model: '' }))); } catch (e) {}
      paintPicks().catch(e => { el.hint.textContent = '换家之后型号没刷出来：' + ((e && e.message) || e); });
    };
    el.model.onchange = () => {
      try { localStorage.setItem(K_PICK, JSON.stringify(Object.assign({}, pickGet(), { model: el.model.value }))); } catch (e) {}
    };
    /* Enter 发送、Shift+Enter 换行。
       **中文选词上屏那一下必须放行**：合成中的 Enter 还会再触发一次 keydown
       （isComposing 为 true，老浏览器上 keyCode 是 229），挡不住就是「刚选完字直接发出去」——
       在中文下几乎人人第一次都会踩到，所以这两个判据都要。
       Ctrl/⌘+Enter 也照旧能发（同一分支，没写 shiftKey 就走发送）。 */
    el.ta.onkeydown = e => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      send(el.ta.value);
    };
    if (window.Dropdowns) Dropdowns.build(el.picks);
    load();
    paint();
    paintFiles();
    paintPicks().catch(e => { el.hint.textContent = '型号取不到：' + ((e && e.message) || e); });

    /* 换页之后：左栏高亮、当前页名与「这一页的状态」都跟着刷新 */
    window.addEventListener('hashchange', syncHere);
    try {
      const f = AS_SHELL ? $('appFrame') : null;
      if (f) f.addEventListener('load', syncHere);
    } catch (e) {}

    /* 断开时（关窗口 / 刷新外壳）把已经流出来的字落盘：否则「写了一半」凭空消失，
       用户只能重问一次 —— 而重问一次是白花一轮 tokens 的。 */
    window.addEventListener('pagehide', () => {
      if (!live) return;
      const t = live.text();
      if (!t.trim()) return;
      msgs.push({ r: 'ai', t: t + '\n\n（关掉/刷新这一层时这次回答断了，后面没写完）', at: Date.now() });
      save();                       // 现在是会话表，走 save() 才会写成 v2（直接 Store.write 会退回老格式）
    });
  }
  /* 收起历史浮层（模块级，不放在 mount() 里 —— paintHist 也要用，
     放在 mount() 的话那条点击处理够不着）。只改显隐与时钟按钮的高亮，不动对话区。 */
  function closeHist() {
    if (el.histBox) el.histBox.hidden = true;
    if (el.hist) el.hist.classList.remove('on');
  }
  /* 历史会话列表：按最近用过排（存的是创建顺序，这里排一次） */
  function paintHist() {
    const box = el.histList;
    if (!box) return;
    const items = SESS.list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const sum = $('acHistSum');
    if (sum) sum.textContent = SESS.list.length + ' 段 · 共 ' + msgs.length + ' 条（当前这段）';
    box.innerHTML = items.map(s => '<button class="ac-hs' + (s.id === SESS.cur ? ' on' : '') + '" data-sid="' + esc(s.id) + '">'
      + '<div class="ac-hs-t">' + esc(s.title || '（还没说话）') + '</div>'
      + '<div class="ac-hs-m">' + esc(when(s.at)) + ' · ' + (s.msgs || []).length + ' 条</div>'
      + '<span class="ac-hs-x" data-del="' + esc(s.id) + '" title="删除这段会话" role="button">✕</span></button>').join('');
    box.querySelectorAll('.ac-hs').forEach(b => b.onclick = ev => {
      if (ev.target.closest('[data-del]')) return;      // 删是另一件事，别顺手切过去
      /* 选中就收起：浮层是盖在对话区上面的，不收的话盖住刚切过去的这段话，
         还得再点一次 × 或点别处才知道切成功了。
         但**只在真切过去时收** —— 被 canLeave() 拦下时那是没换成的，
         列表跟着消失就成了「点了、关了、什么都没发生」，比不收更让人怀疑自己点歪了。 */
      if (gotoSession(b.dataset.sid)) closeHist();
    });
    box.querySelectorAll('[data-del]').forEach(x => x.onclick = ev => {
      ev.stopPropagation(); delSession(x.dataset.del);
    });
  }
  function syncHere() {
    if (el.here) el.here.textContent = '在 ' + pageZh();
    if (el.body) paint();
  }

  /* ---------- 快捷键：Ctrl/⌘ + / 开合（在输入框里不抢按键） ---------- */
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== '/') return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
    e.preventDefault();
    if (isOpen()) closePanel(); else openPanel();
  });

  function boot() { if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true }); }
  boot();

  window.AiChat = {
    open() { mount(); openPanel(); },
    close() { closePanel(); },
    toggle() { mount(); if (isOpen()) closePanel(); else openPanel(); },
    ask(q) { mount(); openPanel(); return send(q); },
    /* 页面注册一份**只读**快照（overview 查询里的「当前界面」）；内容页更直接的做法是
       把自己的 window.__acPageCtx 设成这个函数 —— 外壳那份就是读它。 */
    pageCtx(fn) { try { frameWin().__acPageCtx = typeof fn === 'function' ? fn : undefined; } catch (e) {} },
    /* 把已经拿到的文件递给助手（页面里选完素材想让它照图说话时用） */
    attach(list) { mount(); return addFiles(list); },
    clear() { msgs = []; acts = []; save(); paint(); paintHist(); },
  };
})();