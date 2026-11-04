/* 资产库 —— 由 assets.html 迁到 Vue 的页面。
   数据与副作用全部走已有的公共层（AssetLib / AssetLocal / Wb / Fav / AiFind / AiChip / Chips），
   组件只负责「这一屏长什么样」；卡片复用、缩略图、灯箱、详情、分页、多选、存回本机仍是全站那一份实现。 */
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, inject, watch } from '../../vue.runtime.esm-browser.prod.js';
import { createBand } from '../ui/index.js';
import { render } from '../render/assets.js';

const PAGE_MODE = window.pageModeOf('assets');
const PAGE_SIZE = window.pageSizeOf('assets');

export default {
  name: 'AssetsView',
  setup() {
    const spaRoute = inject('spaRoute', null);
    /* 这一页在路由表里的那个文件名：前台判据、轮询登记、灯箱配置登记都用它当键，
       写成一处，别在三行里各抄一遍字符串。 */
    const PAGE_FILE = 'assets.html';
    /* 前台判据只有公共层那一份：core/activity.js（外壳挂在 window.__spaActivity）。
       这里原来自己拼 `activeFile === 'assets.html'`，那只说明「路由选中的是这一页」——
       整个标签页切到后台时它照样为真，于是隐藏着的资产库继续轮询、继续把灯箱与详情的
       cfg 贴到前台那一页头上。路由 + document.hidden 两样都看才是真的可见。 */
    const isActive = window.__spaActivity.forPage(PAGE_FILE);
    const failed = ref('');
    const cntText = ref('');
    const gotoBtnText = ref('跳转');
    const gotoBusy = ref(false);
    const reloadDisabled = ref(false);
    const reloadTitle = ref('重新从各平台取回列表');
    const multiMode = ref(false);
    const bulkCountText = ref('已选 0 项');
    const bulkTipText = ref('点卡片即可勾选');
    const bulkDownDisabled = ref(true);
    const bulkAllText = ref('全选当前列表');
    const bulkAllDisabled = ref(false);
    /* 收藏那两颗（批量收藏 / 取消收藏）：能不能点由公共件算（选中的里还有没有能收 / 能拿的）。 */
    const bulkFavAddDisabled = ref(true);
    const bulkFavRemoveDisabled = ref(true);
    /* 旧页面把翻页那一排写成 display:none，第一次 renderGrid 才露出来：
       数据没回来之前先不摆一排空按钮（它们一出一隐会把右边那排挤动）。 */
    const pagerReady = ref(false);

    /* 筛选状态：类型 / 平台 / 时间 / 关键词 / 状态三档。
       状态从「第五颗芯片」提成**页头三档**（在制 / 失败 / 结果未知）——
       它不是又一颗筛选项，是「这批东西现在怎么样」的第一眼事实。 */
    const F = reactive({ type: '全部', provider: '全部', bucket: '', q: '', from: '', to: '', time: '0' });
    const faceFrom = computed(() => (F.from ? F.from.slice(5).replace('-', '/') : '起始'));
    const faceTo = computed(() => (F.to ? F.to.slice(5).replace('-', '/') : '结束'));
    const timeMode = computed(() => F.time);

    const pageEl = ref(null);
    const gridEl = ref(null);
    const gridEndEl = ref(null);
    const loadErrEl = ref(null);
    const headToolsEl = ref(null);
    const asTypeEl = ref(null);
    const asProvEl = ref(null);
    const asTimeEl = ref(null);
    const asSumEl = ref(null);
    const viewEl = ref(null);
    const aiSearchBtn = ref(null);
    const aiChipEl = ref(null);
    const dFromEl = ref(null);
    const dToEl = ref(null);
    const pullLocalBtn = ref(null);
    const gotoPageEl = ref(null);
    const pagerBtnsEl = ref(null);

    let started = false;
    let offStorage = null;
    let offHead = null;
    let assets = [];
    let cursors = {};
    /* 每个来源「到底了没有」：fetchMore 每轮从 res.more 拿，只给后台数总数接着往后翻用（见 tallyFrom） */
    let moreState = {};
    let hasMoreFlag = true;
    let noCacheOnce = false;
    let seenIds = new Set();
    let loadedPages = 0;
    let loadGen = 0;
    /* 这一屏数据是什么时候拉的：切回本页时靠它决定「要不要静默补一页」。 */
    let lastLoadAt = 0;
    const STALE_MS = 25000;
    let loadChain = Promise.resolve();
    let loadingNow = 0;
    let loadErrors = {};
    let hiddenCloud = 0;
    let provSig = '';
    let FAI = null;
    let aiHit = { total: 0, shown: 0 };
    let aiAsc = 0;
    /* 页码这一份状态归 `Wb.pager`（下面 initWb 里建的那一份）：这一页的按钮是 Vue 绑的，
       所以给 pager 传 onState，让它把「能不能点 / 第几页 / 共几页」算好递回来。
       「条件变了回第 1 页」走公共件的 `Wb.pager.reset(pager)`；「页码真变了才滚回列表顶」
       由 pager 重画时递进来的 changed 判（续拉与筛选重画都不该动视口）。 */
    let pager = null;
    /* 大类型 + 搜索这一行的唯一生成者（搜索框、芯片、按钮、计数都出自 Wb.filterBar）。
       AI 搜索按钮与 AI 芯片是这一页私有内容（按钮的画法与文案取自公共层 AiFind.btnHTML），
       作为 extraHTML 插进同一条行里。 */
    let searchFb = null;
    /* 类型筛选走公共件 Wb.kindFilter（与工作台、收藏页同一副）；
       计数放在这一份 Map 里 —— 公共件的 count 回调读它。 */
    let kindFb = null;
    const kindCounts = new Map();
    const searchInput = () => (searchFb ? searchFb.input : null);
    let doneTimer = null;
    let REG = { providers: [] };
    let LIST_CACHE = null;
    let cardList = null;
    let viewToggle = null;
    let tally = null;
    let poller = null;
    let busOff = null;
    let lbInited = false;
    const selected = new Set();
    const deletingIds = new Set();

    const fmtSize = b => window.fmtBytes(b);
    function ratioText(w, h) {
      if (!w || !h) return '';
      const g2 = (a, b) => (b ? g2(b, a % b) : a);
      const g = g2(w, h) || 1, r1 = w / g, r2 = h / g;
      return (r1 <= 40 && r2 <= 40) ? r1 + ':' + r2 : (w / h).toFixed(2) + ':1';
    }

    /* ---------- 数据拉取与归一化 ---------- */
    const hasMore = () => hasMoreFlag;
    const uniq = k => ['全部', ...[...new Set(assets.map(a => a[k]))]];

    function refreshProviderChips() {
      const sig = uniq('providerName').join('|');
      if (sig === provSig) return;
      provSig = sig;
      renderFilters();
    }

    function loadErrorsText() {
      const ks = Object.keys(loadErrors || {});
      const bits = ks.map(k => window.esc(String(k)) + '：' + window.esc(String(loadErrors[k])));
      if (!bits.length) return '';
      return '<div class="empty" style="color: var(--warn)">部分内容加载失败：<br>'
        + bits.join('<br>')
        + '<br><br>（检查网络与密钥，或点工具条上的「刷新」重试）</div>';
    }
    const loadFailed = () => Object.keys(loadErrors || {}).length > 0;

    function paintLoadErrors() {
      const box = loadErrEl.value;
      if (!box) return;
      const bits = Object.keys(loadErrors).map(k => window.esc(String(k)) + ' 加载失败：' + window.esc(String(loadErrors[k])));
      box.innerHTML = bits.length ? '<div class="hint" style="color: var(--warn);margin: var(--sp-8) 0">' + bits.join('；') + '</div>' : '';
    }

    /* ---------- 多选 ---------- */
    /* 「哪几个字段算同一条」只在 `AssetLib.entryKey` 点一次名（domain/assetlib.js）。
       这一把比卡片多一维供应商：同一个号在两家平台是两份不同的东西，勾掉一个不该把另一个也取消。 */
    const selKeyOf = a => (a.provider || '') + '|' + window.AssetLib.entryKey(a);

    /* 多选：状态与操作在公共件 `Wb.multi` 里（工作台同一份，不许各写一套）。
       这一页只提供三件事：哪几个字段算同一条、当前这一屏看得见哪些、改完之后怎么重画。
       ⚠ workbench.js 是这一页**异步补载**的（onMounted 里 await），所以实例要等它到了再拿 ——
       在 setup 里就建它会拿到 undefined（页面一开就白屏）。 */
    let multiInst = null;
    const assetsMulti = () => multiInst || (multiInst = window.Wb.multi({
      sel: selected,
      keyOf: selKeyOf,
      visible: applyFilters,
      onChange: renderGrid,
      canDownload: a => !!(a.dl || a.src),
      /* 收藏这一族：语义由这一页给（**产物**才收得进去，任务卡还没有字节），
         计数与批量那一圈在公共件 Wb.multi 里（三页同一份）。 */
      fav: {
        can: a => a.kind === 'asset',
        isOn: a => !!(window.Fav && window.Fav.isEntry(a)),
        add: a => { window.Fav.addEntry(a); },
        remove: a => { window.Fav.removeEntry(a); },
      },
      mode: {
        isOn: () => multiMode.value,
        set: v => {
          multiMode.value = v;
          /* 容器上挂的是**公共**那个开关类 `.multi`（ui.css 里 `.multi .task .pick` 才把
             勾选框露出来）：以前这一页挂的是自造的 `assetsMulti`，于是多选时勾选框一直是
             隐形的 —— 选没选、选了哪几条全都看不见，「存选中的」就成了盲存。 */
          if (gridEl.value) gridEl.value.classList.toggle('multi', v);
        },
      },
    }));

    /* ---------- 存回本机：范围 = 多选里勾选的那几条 ---------- */
    /* 这颗按钮是**多选条里**的一颗（不在筛选行那一排）：它存的就是勾选的那些，
       不多选就点它等于「把这一屏都存一遍」—— 那不是用户的意思。
       本机 / 去重 / 去空地址的判据在 AssetLocal.pullPlan 那一份（与卡片徽标同一份）。 */
    function pullScope() {
      return window.AssetLocal.pullPlan(
        assetsMulti().selected().filter(a => a.kind === 'asset'), { keyOf: selKeyOf });
    }
    function paintPullBtn() {
      const btn = pullLocalBtn.value;
      if (!btn) return;
      const picked = assetsMulti().selected();
      window.AssetLocal.pullBar(btn, pullScope(), {
        what: '产物', zone: '选中的',
        empty: picked.length ? '选中的这些本机都已经有了' : '先勾选要存回本机的产物',
      });
    }
    /* 首屏数据回来之前按钮上写的是静态那一版（与旧页面标记逐字相同）：
       不先按 0 条画一次 —— 那会在「还在加载」时就说「这一屏的产物本机都已经有了」。 */
    function paintPullInitial() {
      const b = pullLocalBtn.value;
      if (!b) return;
      b.innerHTML = '<span class="ic">' + (window.icon ? window.icon('box', 13) : '')
        + '</span> <span class="tx">存回本机</span>';
    }
    async function pullLocalPage() {
      if (!started) return;
      const btn = pullLocalBtn.value;
      const picked = assetsMulti().selected();
      const todo = pullScope();
      if (!picked.length) {
        /* 「你点了，但什么都没发生」必须看得见：这一类用 warn 档（ok/info 默认静音） */
        window.Toast.warn('先勾选要存回本机的产物');
        return;
      }
      if (!todo.length) {
        window.Toast.warn('选中的这些本机都已经有了');
        return;
      }
      window.AssetLocal.pullStart(btn);
      const s2 = await window.AssetLocal.pullMany(todo.map(a => ({
        entry: a,
        name: String(a.prompt || a.name || '这一条').slice(0, 12),
        apply: u => { a.src = u; },
      })), { onProgress: (done, total) => window.btnText(btn, '存回本机 ' + done + ' / ' + total) });
      window.AssetLocal.pullEnd(btn);
      paintPullBtn();
      window.AssetLocal.pullReceipt(s2);
      if (s2.ok) { try { LIST_CACHE.write(assets); } catch (e) {} renderGrid(); }
    }

    function paintBulkBar() {
      if (!multiMode.value) return;
      /* 三处读数（已选几项 / 全选那颗的文案 / 下载键能不能点）由公共件算：
         同一句话不许两页各写一遍。收藏那两颗的能不能点也是公共件算。 */
      assetsMulti().paintBar({
        count: t => { bulkCountText.value = t; },
        all: t => { bulkAllText.value = t; },
        canDown: ok => { bulkDownDisabled.value = !ok; },
        allDisabled: none => { bulkAllDisabled.value = none; },
        favAdd: ok => { bulkFavAddDisabled.value = !ok; },
        favRemove: ok => { bulkFavRemoveDisabled.value = !ok; },
      });
      const tip = assetsMulti().favTip();
      bulkTipText.value = tip ? ('点卡片即可勾选 · ' + tip) : '点卡片即可勾选';
    }

    /* 批量收藏 / 取消收藏：勾选的那些一起收进「我的收藏」或一起拿出来。
       动作与计数都在公共件 Wb.multi（Wb.fav 是那颗星标的实现）。 */
    function assetsBulkFavAdd() {
      if (!started) return;
      const n = assetsMulti().favAdd();
      if (!n) { window.Toast.warn('选中的这些都已经在收藏里了'); return; }
      window.Toast.receipt('已收藏 ' + n + ' 条');
      renderGrid();
    }
    function assetsBulkFavRemove() {
      if (!started) return;
      const n = assetsMulti().favRemove();
      if (!n) { window.Toast.warn('都不在收藏里'); return; }
      window.Toast.receipt('已取消 ' + n + ' 条收藏');
      renderGrid();
    }

    /* ---------- 进行中的任务自动刷新 ---------- */
    const TASK_FINISHED = s => !!s && !window.Wb.stLive(s) && !window.Wb.stBad(s);

    function queueDoneRefresh() {
      if (!started || doneTimer) return;
      /* 人不在这一页时不拉：只把「上次加载时间」抹掉，等切回来那一趟再补。 */
      if (!isActive()) { lastLoadAt = 0; return; }
      doneTimer = setTimeout(() => {
        doneTimer = null;
        if (loadingNow) { queueDoneRefresh(); return; }
        refreshKeepPage().catch(e => console.warn('[assets] 完成任务后刷新列表失败：', e));
      }, 1200);
    }

    function startWatch() {
      if (!window.Wb.poller) return;    // 旧 workbench 没有轮询器：照旧手动「刷新」
      poller = window.Wb.poller({
        label: '资产状态', interval: 5000, page: PAGE_FILE,
        tasks: () => assets.filter(a => a.kind === 'task'),
        isRunning: a => window.Wb.stLive(a.status),
        sig: a => String(a.status),
        pollOne: async a => {
          const p = await window.AssetLib.generationDetail(a.genId, a.provider);
          if (!p) {
            throw new Error('平台上查不到这条任务（可能已被清理或过期）');
          }
          a.status = p.status || a.status;
          if (p.error) a.failMsg = p.error;
        },
        onChange: () => {
          if (!started) return;
          assets = window.AssetLib.mergeEntries(assets, []);
          try { LIST_CACHE.write(assets); } catch (e) {}
          renderGrid();
          if (assets.some(a => a.kind === 'task' && TASK_FINISHED(a.status))) queueDoneRefresh();
        },
      });
      if (window.Wb.busOn) busOff = window.Wb.busOn(window.Wb.busRefresh(queueDoneRefresh, 8000));
    }

    /* ---------- 加载 ---------- */
    function fetchMore(pages) {
      const gen = loadGen;
      const run = async () => {
        loadingNow++;
        try {
          const res = await window.AssetLib.load({
            pages, reg: REG, cursors, noCache: noCacheOnce,
            seen: seenIds, out: assets,
            onBatch: list => {
              if (gen !== loadGen) return;
              assets = window.AssetLib.mergeEntries(assets, list);
              refreshProviderChips();
              renderGrid();
            },
          });
          if (gen !== loadGen) return;
          assets = window.AssetLib.mergeEntries(assets, res.entries);
          for (const src of window.Api.listSources()) {
            if (!src.spec || !src.spec.selfAsset) continue;
            try {
              const keys = await window.AssetLib.liveKeys(src.prov);
              if (keys) assets = assets.filter(x => x.provider !== src.key || keys.has(String(x.assetId || x.id)));
            } catch (e2) { /* 读不到就不清 */ }
          }
          cursors = res.cursors;
          moreState = res.more || {};
          hasMoreFlag = res.hasMore;
          noCacheOnce = false;
          loadedPages += pages;
          lastLoadAt = Date.now();
          try { LIST_CACHE.write(assets); } catch (e) {}
          refreshProviderChips();
          loadErrors = res.errors || {};
          paintLoadErrors();
        } finally {
          loadingNow = Math.max(0, loadingNow - 1);
          if (gen === loadGen) renderGrid();
        }
      };
      loadChain = loadChain.then(run, run).catch(e => {
        loadErrors = { '加载': window.Api.errText(e) };
        paintLoadErrors();
        console.warn('[assets] 加载失败：', e);
      });
      return loadChain;
    }

    /* ---------- 筛选 ---------- */
    const typeKey = t => (window.isAudioType(t) ? '音频' : t);
    const sortByTime = (arr, asc) => arr.slice()
      .map(a => [window.AssetLib.tsMs(a.ts) || 0, a])
      .sort((p, q) => (asc ? p[0] - q[0] : q[0] - p[0]))
      .map(p => p[1]);
    function assetIdsOf(a) {
      return [a.assetId, a.genId, a.id, a.vid, a.taskId].filter(Boolean).join(' ').toLowerCase();
    }
    /* 「这一条属于哪一档」：页头三档的判据。
       在制 = 生成中 + 排队中；失败 = 真失败（已取消 / 已过期不算，那只是结束了）；
       结果未知 = 提交可能被受理（钱可能已经扣了）。 */
    function bucketOf(a) {
      if (a.kind !== 'task') return '';
      const st = String(a.status || '').toLowerCase();
      if (window.Wb.isUncertain(a.status)) return 'uncertain';
      if (CALMED_ST.includes(st)) return '';
      if (window.Wb.stBad(a.status)) return 'failed';
      if (window.Wb.stLive(a.status)) return 'live';
      return '';
    }
    const BUCKETS = [
      { key: 'live', label: '在制', dot: 'live' },
      { key: 'failed', label: '失败', dot: 'fail' },
      { key: 'uncertain', label: '结果未知', dot: 'unc' },
    ];

    function applyFilters(opts) {
      const keepHidden = !!(opts && opts.includeHidden);
      /* 某一档的条数只看「除这一档以外」的所有条件 —— 点一下就得到这个数，数字不会对不上。
         noBucket 给页头三档用；noType 给类型那一排用：带着类型条件算，选中一档之后
         别的档条数全变 0，公共件会按「计数为 0 且不是当前档」把它们一起藏掉。 */
      const noBucket = !!(opts && opts.noBucket);
      const noType = !!(opts && opts.noType);
      if (!keepHidden) hiddenCloud = 0;
      let all = assets.filter(a => {
        if (window.AssetLocal.hideAsCloud(a)) { if (!keepHidden) { hiddenCloud++; return false; } }
        if (!noType && !(F.type === '全部' || typeKey(a.type) === typeKey(F.type))) return false;
        if (F.provider !== '全部' && a.providerName !== F.provider) return false;
        if (!noBucket && F.bucket && bucketOf(a) !== F.bucket) return false;
        if (!F.q) return true;
        return (a.prompt || '').toLowerCase().includes(F.q) || assetIdsOf(a).includes(F.q);
      });
      if (F.from || F.to) {
        const rg = window.AssetLib.dayRange(F.from, F.to);
        all = all.filter(a => {
          const ms = window.AssetLib.tsMs(a.ts);
          if (!ms) return false;
          if (rg.from != null && ms < rg.from) return false;
          if (rg.to != null && ms > rg.to) return false;
          return true;
        });
      }
      if (FAI && FAI.cond) {
        const c = FAI.cond;
        const kw = (c.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
        const rg = window.AssetLib.dayRange(c.after, c.before);
        const after = rg.from, before = rg.to;
        const minD = Number(c.minDuration) || 0;
        const maxD = c.maxDuration ? Number(c.maxDuration) : null;
        all = all.filter(a => {
          const hay = ((a.prompt || '') + ' ' + (a.providerName || '') + ' ' + (a.model || '')).toLowerCase();
          if (kw.length && !kw.some(k => hay.includes(k))) return false;
          if (c.type && c.type !== '任意' && typeKey(a.type) !== typeKey(c.type)) return false;
          const ms = window.AssetLib.tsMs(a.ts);
          if (after && (!ms || ms < after)) return false;
          if (before && (!ms || ms > before)) return false;
          const d = Number(a.duration) || 0;
          if ((minD || maxD) && !d) return false;
          if (minD && d < minD) return false;
          if (maxD && d > maxD) return false;
          return true;
        });
        all = sortByTime(all, aiAsc === 1);
        const matched = all.length;
        if (c.limit) all = all.slice(0, Math.max(1, Math.min(200, Number(c.limit) || 50)));
        aiHit = { total: matched, shown: all.length };
      } else {
        aiHit = { total: 0, shown: 0 };
      }
      return sortByTime(all, aiAsc === 1);
    }
    function filtered() {
      const all = applyFilters();
      return pager ? pager.slice(all) : all;
    }
    const filteredAll = () => applyFilters();
    const noFilter = () => F.type === '全部' && F.provider === '全部' && !F.bucket && !F.q && !F.from && !F.to && !FAI;

    function updatePager() {
      if (!started) return;
      pagerReady.value = true;
      if (pager) pager.update();
    }

    /* ---------- 卡片 ---------- */
    /* 卡片身份直接就是 entryKey（kind + 主号 + 产物号）：字段优先级那一段不再在这里抄第二份，
       与合并去重那条路认「同一条」的口径必须一致，否则缓存里合成的一张卡和页面上的一张卡会错位。 */
    const assetKeyOf = a => window.AssetLib.entryKey(a);
    const assetSig = a => {
      const fk = window.Fav ? window.Fav.assetKey(a) : '';
      const st = window.AssetLocal && AssetLocal.stateOf ? AssetLocal.stateOf(a) : null;
      return [a.kind, a.status, a.src, a.prompt, a.providerName, a.type, a.format, a.duration, a.ts,
        a.failMsg || '',
        multiMode.value ? 'M' : '-', multiMode.value && selected.has(selKeyOf(a)) ? 'S' : '-',
        (window.AssetLocal && AssetLocal.showBadge && AssetLocal.showBadge()) ? 'B' : '-',
        st ? st.state : '-',
        fk && window.Fav.has(fk) ? 'F' : '-', fk ? (window.Fav.note(fk) || '') : '',
        (a.type === '视频' && a.src && window.Wb.thumbs.get(a.src)) ? 'i' : 'v'].join('|');
    };

    function favNote(a) {
      return window.Fav ? (window.Fav.note(window.Fav.assetKey(a)) || '') : '';
    }
    /* 卡面上那颗星（★ 收藏 / ★ 已收藏）：与「详情」同一排，不用展开就能收 / 拿。
       **收 / 拿的动作**在 domain/fav.js（Fav.toggleEntry —— 身份与落盘都在那一层），
       这里只画那颗按钮、切完把字与亮灭改回来。 */
    function favBtnHTML(a) {
      const on = !!(window.Fav && window.Fav.isEntry(a));
      return window.Wb.actsHTML(null, { items: [{ act: 'favorite', cls: 'favbtn',
        icon: on ? 'starFill' : 'star', label: on ? '已收藏' : '收藏', pressed: on }] });
    }
    function bindFavBtn(el, a) {
      const fb = el.querySelector('.favbtn');
      if (!fb || !window.Fav) return;
      fb.onclick = e => {
        e.stopPropagation();
        const before = window.Fav.isEntry(a);
        const on = window.Fav.toggleEntry(a);
        fb.setAttribute('aria-pressed', String(on));
        window.iconSet(fb, on ? 'starFill' : 'star', 15);
        window.btnText(fb, on ? '已收藏' : '收藏');
        if (on !== before) window.Toast.ok(on ? '已收藏' : '已取消收藏');   // 星标自己会亮，归安静档
      };
    }
    function noPromptText(a) {
      const prov = ((typeof REG !== 'undefined' && REG && REG.providers) || []).find(p2 => p2.id === a.provider || p2.keyId === a.provider);
      if (!prov || !prov.noPromptField) return '(无提示词)';
      const id = a.genId || a.id || '';
      if (window.PromptLog && id && window.PromptLog.missedFor(a.provider, id)) {
        return '（该平台接口不返回提示词，本机归档里也没有这条）';
      }
      return '（该平台接口不返回提示词）';
    }

    /* 本机 / 云端标识：只在设置页开关打开时画；不参与筛选，也不改变取哪一份字节。
       「哪边有」只问 AssetLocal.stateOf（与「存回本机」的范围、hideAsCloud 同一份判据），
       徽标本身（文案 / class / title）只有 ui/badge-state.js 那一份。 */
    function assetBadge(a) {
      const AL = window.AssetLocal;
      if (!AL || !AL.showBadge || !AL.showBadge() || !AL.stateOf) return '';
      return window.badgeHTML(AL.stateOf(a));
    }

    /* 卡片底部那一排：任务那一族（详情 / 取消 / 重试）整排交给公共件 Wb.actsHTML，
       这一页只给**重试**补一句「会再扣多少」。
       以前整排是这里手写的，公共件那两道闸一道都没跟上：平台没声明 cancel 端点时照样画一颗
       能点的「取消任务」（点了吞异常还把状态改成失败 = 假终局，那条在平台上还在跑、还在计费），
       「结果未知」那一档也没走公共件的重发确认；文案与顺序另与工作台各写一套。 */
    function actsOpts(a) {
      const isTask = a.kind === 'task';
      const prov = window.Api.provOf(a.provider);
      const canCx = !!prov && window.Api.canCancel(prov);
      return {
        /* 只有真产物才有可下载的字节（进行中 / 失败的格子还没出活）；点缩略图就是灯箱，所以不画预览那颗 */
        hasMedia: a.kind === 'asset',
        dlUrl: a.dl || a.src,
        fileName: fileNameOf(a),
        cancel: isTask && !!a.genId && canCx,
        cancelWhy: isTask && !canCx ? window.Wb.cancelWhyNot(prov) : '',
        retry: isTask && !!a.prompt,
        /* 按钮上只留两个字 —— 长文案（「重试（会再扣 ¥0.1000）」）会把这一排撑成两行，
           卡片高度就参差了（紧凑档一格 200px，一行放不下）。 */
        retryLabel: retryLabelOf(a),
        /* 收藏那颗（★ 收藏 / ★ 已收藏）插在「详情」之后 —— 公共件只管它插在哪一档，
           按钮本身是这一页的（收 / 拿的动作在 domain/fav.js 一份）。 */
        afterDetailHTML: a.kind === 'asset' ? favBtnHTML(a) : '',
        extraHTML: '',
      };
    }

    /* 展开区里**多出来的**动作：卡面上已经有「详情 / 收藏 / 下载」（任务卡多留 取消 / 重试）。
       只留删除本机这一份 —— 破坏性动作收在展开区里，不该是每张卡上最显眼的那颗按钮。 */
    function expActsHTML(a) {
      if (a.kind !== 'asset') return '';
      const items = [];
      if (a.localAsset) items.push({ act: 'delete', cls: 'delbtn', icon: 'trash', danger: true,
        label: a.mirror ? '删除本机副本' : '删除本机这一份' });
      return items.length ? window.Wb.actsHTML(null, { items }) : '';
    }

    /* ---------- 卡片 ----------
       **五种状态共用同一副骨骸**：左边一格 132×96 的槽，右边一列字。
       状态只换**槽里的内容**（状态牌）与**字里的几行**（平台原话 / 代价）——
       宽度、结构、左边缘全都一样。状态牌是公共件（ui.css 的 .plate）。 */

    /* 「已取消 / 已过期」不是错误：它只是**结束了**（用户自己撤的或平台过期了），
       染成红色会让人以为出了问题。 */
    const CALMED_ST = ['cancelled', 'canceled', 'expired', 'invalid', 'aborted', 'rejected'];

    /* 这一条的费用口径（AssetLib.costOf 一份）：积分优先，其次金额。 */
    function costOf(a) {
      try { return (window.AssetLib && window.AssetLib.costOf) ? window.AssetLib.costOf(a) : { cost: null, unit: '' }; }
      catch (e) { return { cost: null, unit: '' }; }
    }
    function costText(a) {
      const c = costOf(a);
      if (c.cost == null || c.cost === '') return '';
      return c.unit === '元' ? ('¥' + Number(c.cost).toFixed(4)) : (c.cost + ' ' + c.unit);
    }
    /* 按钮只留两个字（长文案会把这一排撑成两行）。 */
    function retryLabelOf(a) {
      return window.Wb.isUncertain(a.status) ? '重发' : '重试';
    }

    /* 状态牌：这一格没有画面、但有话要说。牌子本身在公共层 `Wb.plateHTML` ——
       工作台的任务卡与本页共用同一份底色、结构与短因（以前两页各画一套）。 */
    function plateHTML(a) {
      return window.Wb.plateHTML({ kind: a.kind, status: a.status, failMsg: a.failMsg, progress: a.progress });
    }

    function assetCardHTML(a) {
      const run = a.kind === 'task' && window.Wb.stLive(a.status);
      const bad = a.kind === 'task' && window.Wb.stBad(a.status);
      /* 「结果未知」既不是失败也不是已完成：那次提交很可能已被平台受理（钱已经扣）。
         它以前掉进 lateDone 那一档，卡片直接写「已完成（正在同步列表…）」——
         用户照着这句去等产物，而产物可能根本没有，还顺手把「重试」当成了免费的操作。 */
      const unc = a.kind === 'task' && window.Wb.isUncertain(a.status);
      const lateDone = a.kind === 'task' && !bad && !run && !unc;
      const plate = plateHTML(a);
      let media;
      if (plate) media = plate;
      else if (a.kind === 'task') {
        media = '<div class="timg"><span class="plate plate--plain"><span class="plate-st">已完成</span>'
          + '<span class="plate-t">正在同步列表…</span></span></div>';
      } else if (a.type === '视频') {
        /* 与工作台同一份（Wb.playableMediaHTML）：视频在卡上就地播放，左下角播放 / 暂停，
           右下角才是全屏入口 —— 点封面本身不再开灯箱。 */
        media = window.Wb.playableMediaHTML(a.src, { mediaAttrs: 'draggable="false"' });
      } else if (window.isAudioType(a.type)) {
        media = '<div class="timg"><span class="plate plate--audio"><span class="plate-st">'
          + window.esc(window.fileExtOf(a).toUpperCase() || '音频') + '</span>'
          + (a.duration ? '<span class="plate-t">' + window.esc(a.duration) + 's</span>' : '') + '</span></div>';
      } else {
        media = '<div class="timg">' + window.Wb.thumbs.mediaHTML(window.Api.mediaSrc(a.src), {
          type: 'image',
          mediaAttrs: 'loading="lazy" decoding="async" draggable="false"',
        }) + '</div>';
      }
      const date = window.fmtWhen(a.ts);
      /* 卡面**只有四行**：状态 / 提示词 / 那一行信息 / 动作 —— 每一行的高度都是固定的，
         所以一屏卡一样高。
         「平台原话」以前在卡面单占一行（只有失败 / 结果未知才有），
         「★ 收藏备注」也各占一行（有才有）—— 这两行一有就没，卡片高度就参差了。
         现在：平台原话在**状态牌那一格**（短因，满两行）与展开的详情里（全文），
         收藏备注在 ★ 那颗的悬停与展开的详情里。 */
      const cost = (bad || unc) ? costText(a) : '';
      const meta = [a.providerName, a.type, a.kind === 'asset' ? (a.format || '').toUpperCase() : '',
        a.duration ? a.duration + 's' : '', cost].filter(Boolean).join(' · ');
      const extra = expActsHTML(a);
      return window.Wb.taskHTML({
        mediaHTML: media, type: a.type,
        status: a.kind === 'task' ? (lateDone ? '已完成' : window.Wb.stText(a.status)) : '已完成',
        tone: run ? 'run' : unc ? 'warn' : bad ? (CALMED_ST.includes(String(a.status).toLowerCase()) ? '' : 'err') : 'ok',
        badgeHTML: assetBadge(a), date, prompt: a.prompt || noPromptText(a), meta,
        actionsHTML: window.Wb.actsHTML(a, actsOpts(a)),
        detailHTML: '<div class="exp"><div class="exp-in"><div class="exp-body"><div class="cdet"></div>'
          + (extra ? '<div class="exp-acts">' + extra + '</div>' : '') + '</div></div></div>',
      });
    }

    function bindCardThumb(d, a) {
      const wrap = d.querySelector('.timg');
      if (!wrap) return;
      const media = wrap.querySelector('video[data-src], video[src], img');
      if (media) window.Wb.thumbs.bind(wrap, media, a.src || '');
      /* 左下角那颗就地播放；点封面本体进灯箱（thumb.onclick 接）。 */
      window.Wb.bindCardPlay(wrap);
    }

    /* ---------- 详情：就地展开，不另起一层 ----------
       清单档：那张卡自己长高（字列从摘要换成详情），下面几行顺移，别的卡不动。
       紧凑档（网格）：格子长高会把同一行别的格子底下留出空洞 —— 网格最怕这种。
       所以那一行保持原样，展开的内容接在**它那一行的下面**，成一条整行宽的带子，
       一根量出来的连线从带子上沿指回那个格子。
       接线（一次只开一条、按钮的字跟着变）是公共件 Wb.expand 一份。 */
    function isGridView() {
      return !!(viewToggle && viewToggle.value === 'compact');
    }

    /* 网格档的展开带子：一次只有一条，行为与长相都在公共件 createBand 里
       （工作台右栏用的是同一份）；这里只交节点取手与那条带子的标题。 */
    const band = createBand({
      keyOf: assetKeyOf,
      cardOf: k => (cardList ? cardList.el(k) : null),
      hostOf: () => gridEl.value,
      renderDetail: (a, host) => window.Wb.detail.render(a, host),
      labelOf: a => (a.kind === 'task' ? window.Wb.stText(a.status) : (a.prompt || '这一条')),
    });

    function toggleDetail(d, a) {
      const detBox = d.querySelector('.cdet');
      if (!detBox) return;
      if (isGridView()) { band.toggle(d, a); return; }
      /* 先把内容放进去再打开：`.exp` 的 0fr → 1fr 过渡要有内容才看得出「长出来」。 */
      const open = window.Wb.expand.open(d, { scope: gridEl.value });
      if (open) window.Wb.detail.render(a, detBox);
    }

    function bindAssetCard(d, a) {
      bindCardThumb(d, a);
      /* 整张卡可拖 = 引用这一条（载荷形状在 web/domain/asset-ref.cjs）。卡里的图与视频显式
         draggable="false"：不然浏览器先按「拖一份文件」起势，拿到的是地址而不是引用。 */
      d.draggable = true;
      d.ondragstart = e => {
        if (!window.AssetRef || e.target.closest('input,textarea,select,button,a,[contenteditable]')) { e.preventDefault(); return; }
        const p = window.AssetRef.set(e.dataTransfer, {
          kind: a.kind || 'asset', id: a.assetId || a.id || '',
          name: (a.prompt || a.type || '').slice(0, 40),
          type: a.type, mtype: a.type, assetId: a.assetId || '', src: a.src, dl: a.dl,
          prompt: a.prompt || '', from: 'assets',
          taskId: a.genId || '', status: a.status, model: a.model,
          provider: a.provider, providerName: a.providerName, ts: a.ts, localAsset: a.localAsset,
          size: a.byteLength, error: a.failMsg, credits: a.credits,
          tier: a.tier, res: a.res, ar: a.ar, dur: a.duration, quality: a.quality,
        });
        if (!p) { e.preventDefault(); return; }
        d.classList.add('dragging');
      };
      d.ondragend = () => d.classList.remove('dragging');
      d.dataset.akey = assetKeyOf(a);
      const picked = multiMode.value && selected.has(selKeyOf(a));
      d.classList.toggle('picked', picked);
      if (multiMode.value) {
        const box = document.createElement('div');
        box.className = 'pick' + (picked ? ' on' : '');
        box.textContent = picked ? '✓' : '';
        box.title = '勾选后批量下载';
        /* 勾选块以前是裸 div + onclick：键盘走不进这一格，读屏也念不出勾选状态。
           现在它是可聚焦的 checkbox，Space / Enter 与点击走同一个出口。 */
        box.tabIndex = 0;
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', picked ? 'true' : 'false');
        box.setAttribute('aria-label', '勾选这条（批量下载）');
        box.onclick = e => { e.stopPropagation(); assetsMulti().toggle(a); };
        box.onkeydown = e => {
          if (e.key !== ' ' && e.key !== 'Enter') return;
          e.preventDefault(); e.stopPropagation();
          assetsMulti().toggle(a);
        };
        d.appendChild(box);
      }
      d.onclick = e => {
        if (multiMode.value) {
          if (e.target.closest('.acts') || e.target.closest('.exp')) return;
          e.preventDefault();
          assetsMulti().toggle(a);
          return;
        }
        /* 紧凑档：卡身上点一下 = 打开这一条的详情（缩略图自己管自己 —— 点封面开灯箱、
           左下角就地播放，动作那一排不动）。清单档有「详情」那颗按钮，不靠点卡身 ——
           免得拖完卡片手一松就开了一页详情。 */
        if (isGridView() && !e.target.closest('.timg') && !e.target.closest('.acts')) {
          toggleDetail(d, a);
        }
      };
      const thumb = d.querySelector('.timg');
      if (thumb) thumb.onclick = e => {
        if (multiMode.value) { e.stopPropagation(); assetsMulti().toggle(a); return; }
        /* 点封面进灯箱（视频也是）：先停掉卡里那份，别跟灯箱双声道；左下角那颗才是就地播放。 */
        const v = thumb.querySelector('video');
        if (v && !v.paused) v.pause();
        window.Wb.lightbox.open(a);
      };
      /* 标准那一排（详情 / 下载 / 取消 / 重试）整排交给公共件接线：确认框、忙碌态、报错、
         「这一家没有撤单接口」那道闸，还有「结果未知不许当普通重试」的核对与扣费提醒，
         都在 Wb.bindActs 一份（以前这里自己写了一套，那两道闸都没跟上）。
         这一页只剩两颗私有按钮：收藏 / 删本机那一份（都在展开区里）。 */
      window.Wb.bindActs(d, a, Object.assign(actsOpts(a), {
        onDetail: () => toggleDetail(d, a),
        onCancel: async () => {
          const it = assets.find(x => x.id === a.id || x.genId === a.genId) || a;
          /* 平台必须由条目自己那一家现取：任务号在别家平台上可能是另一条（还扣着钱）的任务。 */
          /* 撤单成功才改状态。以前是 `cancel().catch(()=>{})` 之后无条件写 failed ——
             取消失败时界面报的是「已取消」，而这条从此离开轮询集合（stBad 不再跟踪），
             平台上它还在跑、还在计费：用户看得见的是一个假终局。
             现在失败交给公共件报错并恢复按钮，状态一个字不改：这一条还是 running。 */
          await window.Wb.cancelTask(window.Api.provOf(it.provider), it.genId || it.id);
          it.status = 'cancelled';
          window.Toast.receipt('已取消：平台上这一条已撤单');
          renderGrid();
        },
        onRetry: async () => { await retryEntry(a); await refreshKeepPage(); },
        extraBind: el => {
          /* 收藏那颗（★/☆）的接线：收 / 拿在 domain/fav.js 一份，这里只把字与亮灭改回来。 */
          bindFavBtn(el, a);
          const delb = el.querySelector('.delbtn');
          if (delb) delb.onclick = e => {
            e.stopPropagation();
            const hideAfter = !!(window.AssetLocal && AssetLocal.localOnly && AssetLocal.localOnly());
            const tail = hideAfter ? '；卡会隐藏（平台仍在）' : '；卡片会留着';
            const note = (a.mirror ? '只删本机副本' : '删本机文件') + tail;
            if (window.Confirm.arm(delb, '确认删掉', { note })) return;
            deleteLocalAsset(a, delb);
          };
        },
      }));
      return d;
    }

    function paintAssetCard(d, a) {
      const oldMedia = d.querySelector('.timg img, .timg video');
      const mediaId = el => !el || el.tagName !== 'IMG' ? ''
        : (el.getAttribute('data-thumb-key') || window.Wb.thumbs.keyOf(el.getAttribute('src') || ''));
      const oldId = mediaId(oldMedia);
      const oldDet = d.querySelector('.cdet');
      d.innerHTML = assetCardHTML(a);
      if (oldId) {
        const nm = [...d.querySelectorAll('.timg img')].find(x => mediaId(x) === oldId);
        if (nm) nm.replaceWith(oldMedia);
      }
      if (oldDet) { const nd = d.querySelector('.cdet'); if (nd) nd.replaceWith(oldDet); }
      /* 重画换了卡里的按钮：「详情 / 收起」那两个字要跟着这张卡现在的状态走
         （轮询每 5 秒重画一次，展开着的那张卡不能每 5 秒把按钮变回「详情」）。 */
      window.Wb.expand.sync(d);
      return bindAssetCard(d, a);
    }

    /* ---------- 空态：说清为什么是空的、下一步点哪里 ----------
       以前不管筛没筛过都写「没有匹配的资产」：第一次进来的用户看到的是一句
       像在自己身上找原因的话，而且这一页一个出路都不给。 */
    function filterWhy() {
      const bits = [];
      if (F.type !== '全部') bits.push('类型「' + F.type + '」');
      if (F.provider !== '全部') bits.push('平台「' + F.provider + '」');
      if (F.bucket) { const b = BUCKETS.find(x => x.key === F.bucket); bits.push('状态「' + (b ? b.label : F.bucket) + '」'); }
      if (F.q) bits.push('关键词「' + F.q + '」');
      if (F.from || F.to) bits.push('日期 ' + (F.from || '不限') + ' → ' + (F.to || '不限'));
      if (FAI) bits.push('AI 条件「' + String(FAI.desc).slice(0, 20) + '」');
      return bits;
    }
    function clearFilters() {
      F.type = '全部'; F.provider = '全部'; F.bucket = ''; F.q = '';
      F.from = ''; F.to = ''; F.time = '0';
      FAI = null; aiAsc = 0;
      if (searchFb) { searchFb.setQuery(''); searchFb.markApplied(''); }
      if (dFromEl.value) dFromEl.value.value = '';
      if (dToEl.value) dToEl.value.value = '';
      window.Wb.pager.reset(pager);
      renderFilters(); paintAiChip(); renderGrid();
    }
    function emptyStateHTML() {
      const err = loadErrorsText();
      if (err) return err;
      if (hiddenCloud) {
        return window.Wb.emptyHTML(hiddenCloud + ' 条已按设置隐藏',
        window.GoPage.btn('settings.html', '去设置页'));
      }
      const why = filterWhy();
      if (why.length) {
        return window.Wb.emptyHTML(['按现在这些条件（' + why.join('、') + '）一条都没有。'],
          '<button class="tool mini" data-clearf="1">清掉这些条件</button>');
      }
      if (!assets.length) {
        return window.Wb.emptyHTML(['还没有产物'],
        window.GoPage.btn('studio.html?t=video', '去工作台')
          + window.GoPage.btn('chars.html', '去素材库'));
      }
      return window.Wb.emptyHTML(['还没有已完成的产物']);
    }
    /* 空态里那两枚按钮是每次重画现写的 DOM：委托绑不住（GoPage.bind 只认当场存在的节点），
       所以每次画完空态补绑一次。 */
    function bindEmptyBox() {
      const box = gridEl.value;
      if (!box) return;
      window.GoPage.bind(box);
      const c = box.querySelector('[data-clearf]');
      if (c && !c._cfBound) { c._cfBound = 1; c.onclick = () => clearFilters(); }
    }

    function renderGrid() {
      if (!started || !cardList || !gridEl.value) return;
      const list = filtered();
      /* 整页滚的是 `.page-shell` 自己（不是卡片列表），而这一趟要换的 DOM 散在它里面三处：
         卡片列表、页头那三档计数、顶部那条失败提示带 —— 所以点名页根，不按列表那一只罩。
         翻页后「滚回这一屏开头」写在调用点、这一句之前：keep 的快照是在那次滚动之后取的，
         还原还原的就是那个位置，不会把它抹掉。 */
      Wb.viewport.keep(pageEl.value, () => {
        viewToggle && viewToggle.apply();
        updatePager();
        /* 页头那三档的条数跟着数据走（轮询每 5 秒重画一次，状态变了那三档也要跟着变）。 */
        renderSum();
        const sel = [...selected].length;
        /* 页头这个数和分页条那个数必须同一个口径。以前写的是「共 list.length 项」，而 list 只是
           **当前这一页**（一页 24 条），分页条上却是筛选后的总数（几百条）—— 同屏两个「共」互相打脸。 */
        cntText.value = '共 ' + filteredAll().length + ' 项 · 本页 ' + list.length + ' 项'
          + (sel ? ' · 已选 ' + sel + ' 项' : '');
        reloadDisabled.value = loadingNow > 0;
        reloadTitle.value = loadingNow > 0 ? '正在加载…' : '刷新（跳过服务端短缓存）';
        paintBulkBar();
        paintPullBtn();
        paintLoadErrors();
        if (!list.length) {
          cardList.paint([]);
          bindEmptyBox();
          return;
        }
        cardList.paint(list);
        /* 网格档那条展开带子：重画会把卡片挪一遍，带子要跟着回到它那一行的下面
           （Wb.cards 只认卡片，带子是插在容器里的另一个孩子）。 */
        band.afterPaint();
      });
      /* 自动补存：开关开着时把这一屏「本机还没有」的条目排进镜像队列。 */
      if (list.length) try { window.AssetLocal && AssetLocal.offerAll(list); } catch (e) { /* 补存失败不影响列表 */ }
    }

    /* ---------- 删除本机素材 ---------- */
    async function removeEntry(a) {
      const key = assetKeyOf(a);
      const r = await window.AssetLib.remove(a);
      if (r && r.mirrorGone) {
        assets = assets.map(x => {
          if (assetKeyOf(x) !== key) return x;
          const c = Object.assign({}, x);
          delete c.mirror; delete c.mirrorKey; delete c.localAsset;
          /* 换回平台那一份地址。`platSrc` 是 decorate 换成本机地址之前记下的；
             老条件只看 upstreamSrc，于是「平台给产物号、外链为空」那一族删完还指着
             已经删掉的 /asset/la_xxx（卡片当场变成裂图，刷新才好）。 */
          const back = x.platSrc || x.upstreamSrc || '';
          if (back) c.src = back;
          delete c.platSrc;
          return c;
        });
        try { LIST_CACHE.write(assets); } catch (e) {}
        if (cardList) cardList.els.delete(key);
        return { kept: true };
      }
      assets = assets.filter(x => assetKeyOf(x) !== key);
      if (cardList) cardList.els.delete(key);
      selected.delete(selKeyOf(a));
      try { LIST_CACHE.write(assets); } catch (e) {}
      if (tally) tally.run(true);
      return { kept: false };
    }

    async function deleteLocalAsset(a, btn) {
      const key = assetKeyOf(a);
      if (deletingIds.has(key)) return;
      if (!assets.some(x => assetKeyOf(x) === key)) { window.Toast.warn('这条素材已经不在列表里了'); return; }
      deletingIds.add(key);
      const label = btn.dataset.old || btn.textContent;
      btn.disabled = true; btn.textContent = '删除中…';
      try {
        const r = await removeEntry(a);
        refreshProviderChips(); renderGrid();
        window.Toast.receipt(r && r.kept ? '已删掉本机副本' : '已删除');
      } catch (e2) {
        btn.disabled = false; btn.textContent = label;
        window.Toast.err('删除失败：' + window.errText(e2));
      } finally { deletingIds.delete(key); }
    }

    /* ---------- 详情 / 灯箱 ---------- */
    async function loadReg() {
      try { REG = await window.Api.registry(); } catch { REG = { providers: [] }; }
    }

    function openRefLb(id, genId, a, ref) {
      const src = (ref && ref.url) ? window.Api.mediaSrc(ref.url) : (id ? window.Api.assetSrc(id) : '');
      const item = { kind: 'asset', type: '图片', src, dl: (ref && ref.url) ? window.Api.mediaSrc(ref.url) : window.Api.assetDl(id),
        provider: (a && a.provider) || '', providerName: '参考图', genId: genId || '', assetId: (ref && ref.assetId) || id || '', prompt: '(参考图)', ts: '' };
      window.Wb.lightbox.open(item, [item]);
    }

    function detailCfg() {
      return {
        prompt: a => a.prompt,
        status: a => a.status,
        provider: a => (REG.providers || []).find(p => p.id === a.provider) || null,
        taskId: a => a.genId || a.id || '',
        openRef: (ids, i, a, g, refs) => openRefLb(ids[i], a.genId || a.id, a, (refs || [])[i]),
        /* 卡面上撤掉的那两行，在这里说全 —— 展开区就是「这一条的账」：
           平台原话（失败 / 结果未知）、这次的费用、收藏备注。 */
        rows: a => [
          ['平台原话', a.failMsg || ''],
          ['费用', costText(a)],
          ['收藏备注', favNote(a)],
        ].filter(r => r[1]),
      };
    }
    function lightboxCfg() {
      return {
        list: () => filtered(),
        keyOf: a => assetKeyOf(a),
        srcOf: a => a.src || '',
        nameOf: a => fileNameOf(a),
        kindOf: a => (a.kind === 'task' ? 'task' : window.mediaKindOf(a.type)),
        info: (a, el) => {
          const w = (el && (el.videoWidth || el.naturalWidth)) || 0;
          const h = (el && (el.videoHeight || el.naturalHeight)) || 0;
          return [w ? w + '×' + h + 'px · ' + ratioText(w, h) : '', a.size ? fmtSize(a.size) : '',
            a.duration ? a.duration + 's' : '', a.providerName, a.type, a.format ? String(a.format).toUpperCase() : ''];
        },
      };
    }
    /* 灯箱 / 详情是外壳里唯一一份（Wb.lightbox / Wb.detail），而 Vue 页面与外壳同文档：
       谁最后 init，切回另一页时用的还是它的 list 与 srcOf。这一页不再自己「抢占 / 归还」
       （那套协议漏归还一页就会翻错列表），只向公共层登记「资产库这一页要这两份」，
       换前台由 spa:page 把各自那一份装回去 —— 见 workbench.js 的 Wb.lightbox.use。 */
    function registerAdapters() {
      const W = window.Wb;
      if (!lbInited) { W.lightbox.init(lightboxCfg()); lbInited = true; }
      W.lightbox.use(PAGE_FILE, { lb: lightboxCfg(), detail: detailCfg() });
    }
    function unregisterAdapters() {
      if (window.Wb && window.Wb.lightbox) window.Wb.lightbox.use(PAGE_FILE, null);
    }

    /* ---------- 失败重试 / 批量取消 ---------- */
    async function retryEntry(a) {
      return window.AssetLib.retry({ ...a, prompt: a.prompt, count: a.count || 1 });
    }

    /* ---------- 文件名（下载走公共件 Wb.save，这一页只决定叫什么名） ---------- */
    function fileNameOf(a) {
      return window.fileStamp(a.ts) + ' ' + window.fileSafe(a.prompt || '素材', 24) + '.' + window.fileExtOf(a);
    }

    /* ---------- 筛选行：类型（带条数）+ 平台 + 时间；状态三档在页头 ---------- */
    function renderFilters() {
      /* 类型：每一档带条数。条数跟着**其它**筛选条件走 ——
         点一下就得到这个数，数字不会对不上。 */
      if (asTypeEl.value) {
        /* 类型（带条数）：公共件 Wb.kindFilter —— 与工作台、收藏页同一副分段控件。
           计数池必须摘掉类型条件本身（noType）：带着类型条件算的话，选中一档之后别的档
           全是 0，数字就成了「按当前筛选算的」，点一下才发现对不上。
           页头那三档仍按 noBucket 摘掉（切换状态档不重画这一排，带上它数字会停在旧的一档）。 */
        const pool = applyFilters({ noBucket: true, noType: true });
        const tabs = window.mediaKindTabs('全部');
        kindCounts.clear();
        kindCounts.set('全部', pool.length);
        tabs.slice(1).forEach(([t]) => kindCounts.set(t, pool.filter(a => typeKey(a.type) === typeKey(t)).length));
        if (!kindFb) {
          kindFb = Wb.kindFilter.bind(asTypeEl.value, {
            kinds: tabs,
            value: F.type,
            count: v => Number(kindCounts.get(v) || 0),
            onPick: v => { F.type = v; window.Wb.pager.reset(pager); renderFilters(); renderGrid(); },
          });
        }
        kindFb.setCounts(v => Number(kindCounts.get(v) || 0));
        kindFb.setValue(F.type);
      }
      /* 平台：从一个下拉走。平台涨到十几家时，一行十几颗芯片会把整行撑开。 */
      if (asProvEl.value) {
        const ps = uniq('providerName');
        if (F.provider !== '全部' && !ps.includes(F.provider)) F.provider = '全部';
        asProvEl.value.innerHTML = ['全部', ...ps]
          .map(p => '<option value="' + window.esc(p) + '">' + window.esc(p) + '</option>').join('');
        asProvEl.value.value = F.provider;
        /* 换过 options 必须通知公共下拉：浮层那份列表是 build 那一刻的快照。 */
        if (window.Dropdowns) window.Dropdowns.sync(asProvEl.value);
      }
      if (asTimeEl.value) asTimeEl.value.value = F.time;
      renderSum();
    }

    /* 平台下拉：options 每次由 renderFilters 重建，监听挂在 select 上即可跨重建存活。 */
    function onProvChange() {
      F.provider = (asProvEl.value && asProvEl.value.value) || '全部';
      window.Wb.pager.reset(pager);
      renderFilters();
      renderGrid();
    }

    /* 页头上下文三档：在制 / 失败 / 结果未知。
       每一档带条数、点一下把列表筛到那一档；**计数为 0 的那一档不画**
       （库里没有失败的时候，页头不该挂着一颗「失败 0」）。
       用公共的 .phead-chip（页头唯一一份实现），状态点带信息：实心琥珀=在跑 /
       空心琥珀=结果未知 / 实心红=失败。 */
    function renderSum() {
      const box = asSumEl.value;
      if (!box) return;
      const pool = applyFilters({ noBucket: true });
      const n = { live: 0, failed: 0, uncertain: 0 };
      pool.forEach(a => { const b = bucketOf(a); if (b) n[b]++; });
      /* 计数为 0 的那一档不画 → 这一排矮一行，页头下面整页都往上挪。这一页滚的是 `.page-shell`
         自己，所以点名页根，让公共件按锚点把视口放回原来那一条。 */
      Wb.viewport.keep(pageEl.value, () => {
        box.innerHTML = BUCKETS.map(b => {
          if (!n[b.key]) return '';
          return '<button class="phead-chip' + (F.bucket === b.key ? ' on' : '') + '" data-bucket="' + b.key + '"'
            + ' title="只看这一档（再点一下取消）"><i class="dot ' + b.dot + '"></i>'
            + '<span>' + b.label + '</span><b>' + n[b.key] + '</b></button>';
        }).join('');
      });
    }

    function onSumClick(e) {
      const b = e.target.closest('[data-bucket]');
      if (!b) return;
      F.bucket = F.bucket === b.dataset.bucket ? '' : b.dataset.bucket;
      window.Wb.pager.reset(pager);
      renderSum(); renderGrid();
    }

    /* 时间：一个下拉（全部 / 今天 / 近 7 天 / 近 30 天 / 自定义区间）。
       预设直接换算成起止日期（区间那一套判据只有一份）。 */
    function onTimeChange() {
      const v = asTimeEl.value ? asTimeEl.value.value : '0';
      F.time = v;
      if (v === '0' || v === 'custom') {
        F.from = ''; F.to = '';
      } else {
        const days = Number(v) || 0;
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
        F.from = window.dayKey(start); F.to = window.dayKey(now);
      }
      if (dFromEl.value) dFromEl.value.value = F.from;
      if (dToEl.value) dToEl.value.value = F.to;
      window.Wb.pager.reset(pager);
      renderFilters(); renderGrid();
    }

    function onDateChange(which) {
      if (which === 'from') F.from = dFromEl.value ? dFromEl.value.value : '';
      else F.to = dToEl.value ? dToEl.value.value : '';
      F.time = 'custom';
      window.Wb.pager.reset(pager);
      renderFilters(); renderGrid();
    }
    function clearDates() {
      F.from = ''; F.to = ''; F.time = '0';
      if (dFromEl.value) dFromEl.value.value = '';
      if (dToEl.value) dToEl.value.value = '';
      window.Wb.pager.reset(pager);
      renderFilters(); renderGrid();
    }
    function openDatePicker(which, e) {
      if (e.target.closest('.dp-pop')) return;
      const holder = e.currentTarget;
      const inp = which === 'from' ? (dFromEl.value || null) : (dToEl.value || null);
      if (!inp || !window.DatePicker) return;
      e.preventDefault();
      window.DatePicker.open(holder, inp, { onPick: () => { window.Wb.pager.reset(pager); renderFilters(); renderGrid(); } });
    }

    /* ---------- AI 搜索（这一页产出的是筛选条件） ---------- */
    function paintAiChip() {
      if (!aiChipEl.value) return;
      const seen = FAI && FAI.seen;
      const scope = [
        aiHit.total > aiHit.shown ? '共 ' + aiHit.total + ' 条，按 AI 说的只看前 ' + aiHit.shown + ' 条' : '',
        seen && seen.assets < seen.assetsTotal ? 'AI 只看了最近 ' + seen.assets + ' 条素材' : '',
        seen && seen.favs < seen.favsTotal ? '收藏只看了最近 ' + seen.favs + ' 条' : '',
      ];
      window.AiChip.show(aiChipEl.value, {
        text: FAI ? window.AiChip.text([String(FAI.desc).slice(0, 22), FAI.cond.summary,
          aiAsc === 1 ? '最早的在前' : ''].concat(scope.filter(Boolean))) : '',
        clearId: 'assetsAiClear',
        onClear: () => {
          /* 收掉 AI 条件 = 退回不筛：框里那句原话一并清掉（留着会被当成普通词再筛一遍）。 */
          FAI = null; aiAsc = 0; F.q = '';
          if (searchFb) { searchFb.setQuery(''); searchFb.markApplied(''); }
          window.Wb.pager.reset(pager); paintAiChip(); renderFilters(); renderGrid();
        },
      });
    }

    async function runAiSearch() {
      if (!started) return;
      const box = searchInput();
      const q = ((box && box.value) || '').trim();
      const gateWhy = window.AiFind.shortWhy(q);
      if (gateWhy) { cntText.value = gateWhy; if (box) window.focusQuiet(box); return; }
      const v = { q };
      if (!window.TextAI) { window.Toast.err('文字 AI 没加载出来：刷新页面再试'); return; }
      const favAllN = window.Fav ? window.Fav.list().length : 0;
      const seen = {
        assets: Math.min(assets.length, 300), assetsTotal: assets.length,
        favs: Math.min(favAllN, 60), favsTotal: favAllN,
      };
      const idx = assets.slice(0, seen.assets).map(a => ({
        类型: a.type, 提示词: (a.prompt || '').slice(0, 90), 时长: a.duration || null, 平台: a.providerName,
        模型: a.model || '', 资产ID: a.assetId || '', 任务ID: a.genId || '',
        备注: favNote(a),
        日期: window.AssetLib.tsMs(a.ts) ? new Date(window.AssetLib.tsMs(a.ts)).toISOString().slice(0, 10) : null,
      }));
      const favs = window.Fav ? window.Fav.text(seen.favs) : [];
      const sys = '你是素材检索助手：把用户的一句自然语言需求，翻译成本工作台能直接执行的筛选条件。\n'
        + '规则：\n'
        + '1. 只输出 JSON，不要任何解释、不要 markdown 代码块。格式：'
        + '{"keywords":["关键词"],"type":"图片|视频|音频|任意","after":"YYYY-MM-DD 或 null","before":"YYYY-MM-DD 或 null","minDuration":0,"maxDuration":null,"order":"asc|desc","limit":60,"summary":"一句话"}\n'
        + '2. keywords 写**素材里真实会出现的词**（提示词里的主体、风格、场景）；不要把整句需求塞进去。\n'
        + '3. 用户没提时间/时长/排序时就给 null，不要自己编。\n'
        + '4. 可用素材里带了「资产ID / 任务ID」：用户给的是 ID 时，把该 ID 原样放进 keywords。\n'
        + '5. summary 用一句话说明你把需求理解成了什么（界面会显示给用户看）。';
      const btn = aiSearchBtn.value;
      window.aiBtnState(btn, true);
      try {
        const reg = await window.Api.registry();
        const out = await window.TextAI.chat(reg, sys, JSON.stringify({ 需求: v.q, 可用素材样例: idx, 我的收藏: favs }));
        const j = window.TextAI.parseJson(out);
        if (!j) throw new Error('AI 没有给出可用的条件');
        FAI = { desc: v.q, cond: j, seen };
        aiAsc = j.order === 'asc' ? 1 : (j.order === 'desc' ? -1 : 0);
        /* 原话留在框里（用户还要改），但不再当普通词过滤：F.q 清空；这句话登记成「已跑过」，
           点到别处时不会又被当成普通搜索跑一遍、把 AI 的条件冲掉。 */
        F.q = '';
        if (searchFb) searchFb.markApplied(v.q);
        window.Wb.pager.reset(pager);
        window.Toast.receipt('已按 AI 给的条件筛好（原话：' + v.q.slice(0, 24) + '）；清空搜索框或点条件上的 ✕ 取消');
      } catch (e) {
        window.Toast.err(window.AiFind.failText(e));
      } finally {
        window.aiBtnState(btn, false);
      }
      renderFilters();
      renderGrid();
      paintAiChip();
    }

    /* ---------- 刷新 / 翻页 ---------- */
    /* 从头再取：清掉游标与去重集，但不清 assets —— mergeEntries 负责把旧的并回来。 */
    function rewindFetch() {
      loadGen++;
      seenIds = new Set();
      cursors = {}; hasMoreFlag = true; moreState = {};
      loadedPages = 0;
      noCacheOnce = true;
    }
    async function reload() {
      if (!started) return;
      rewindFetch();
      pager.setPage(0);
      reloadDisabled.value = true; reloadTitle.value = '正在加载…';
      try { await load(); } finally { reloadDisabled.value = false; reloadTitle.value = '刷新（跳过服务端短缓存）'; }
    }
    /* 任务完成 / 撤单之后要拉一次新数据，但用户可能正翻在第 5 页找东西：
       以前这几处直接调 reload()，页码归 1、首屏重画，人就被弹回开头。
       这一版记住「原来第几页」和「这一屏第一条是谁」，取完按那一条重新落位
       （列表按时间倒序，新增的产物会把后面的整条往后挤，所以页码要按身份重算）。 */
    async function refreshKeepPage() {
      if (!started) return;
      const keepPage = pager.page;
      const shown = filtered();
      const keepKey = shown.length ? assetKeyOf(shown[0]) : '';
      rewindFetch();
      pager.setPage(0);
      reloadDisabled.value = true; reloadTitle.value = '正在加载…';
      try {
        await load();
        let want = keepPage;
        if (keepKey && PAGE_MODE === 'page') {
          const idx = filteredAll().findIndex(x => assetKeyOf(x) === keepKey);
          if (idx >= 0) want = Math.floor(idx / PAGE_SIZE);
        }
        await ensureLoaded(want);
        pager.setPage(want);
      } finally {
        reloadDisabled.value = false; reloadTitle.value = '刷新（跳过服务端短缓存）';
        renderGrid();
      }
    }
    /* 把第 pageIdx 那一屏需要的条目取到手（翻页 / 跳页 / 刷新后落位共用这一份闸）。 */
    async function ensureLoaded(pageIdx) {
      const need = (pageIdx + 1) * PAGE_SIZE;
      while (filteredAll().length < need && hasMore() && !loadFailed() && loadedPages < 40) await fetchMore(2);
    }
    /* 别处（工作台 / 导演台）刚生成的产物要看得见：切回这一页时如果手上这份是
       25 秒以前拉的，就静默补一次 —— 不清筛选条件，页码与首条按 refreshKeepPage 落回原位。 */
    function refreshIfStale() {
      if (loadingNow) return;
      if (!lastLoadAt || Date.now() - lastLoadAt < STALE_MS) return;
      lastLoadAt = Date.now();
      refreshKeepPage().catch(e => console.warn('[assets] 切回来后补拉失败：', e));
    }

    async function gotoPageInput() {
      if (!started) return;
      const n = Math.max(1, Math.floor(Number(gotoPageEl.value && gotoPageEl.value.value) || 1)) - 1;
      gotoBusy.value = true; gotoBtnText.value = '跳转中…';
      try {
        if (PAGE_MODE === 'page') {
          await ensureLoaded(n);
          pager.setPage(Math.min(n, pager.lastPage));
        } else {
          const want = Math.ceil(((n + 1) * PAGE_SIZE) / window.AssetLib.LIST_LIMIT_DEF);
          while (loadedPages < want && hasMore() && !loadFailed() && loadedPages < 40) await fetchMore(2);
        }
      } catch (e) {}
      gotoBusy.value = false; gotoBtnText.value = '跳转';
      renderGrid();
    }
    function autoLoadMore() {
      if (!started || PAGE_MODE === 'page' || !hasMore() || loadFailed()) return;
      return fetchMore(1);
    }

    /* ---------- 启动 ---------- */
    function initWb() {
      LIST_CACHE = window.AssetLib.listCache('assets_cache_v1');
      /* 「搜索」这一格在**页头**（公共件 Wb.filterBar：搜索框 + 回车 / 失焦即搜 + 清空即取消
         + AI 搜索按钮与芯片宿主），类型芯片在下面那一行筛选里（公共件 Chips.render，带条数）。
         普通搜索是一次新的搜索：如果列表正被 AI 条件筛着，先把那组条件收回（换词 = 重新找）。 */
      searchFb = window.Wb.filterBar.bind(headToolsEl.value, {
        cls: '', chips: null, value: F.q,
        headHTML: '<span class="flabel">搜索</span>',
        inputId: 'search', inputClass: 'search', placeholder: '提示词 / 资产ID / 任务ID…', q: F.q,
        onSearch: v => {
          if (FAI) { FAI = null; aiAsc = 0; paintAiChip(); }
          F.q = String(v == null ? '' : v).trim().toLowerCase();
          window.Wb.pager.reset(pager);
          /* 每档条数 / 平台 options / 页头状态计数都在 renderFilters 里算，搜完必须一起重画。 */
          renderFilters();
          renderGrid();
        },
        extraHTML: window.AiFind.btnHTML('aiSearchBtn') + '<span data-fb="aiChip"></span>',
        cnt: false,
      });
      /* 页头三档（状态）：点一下把列表筛到那一档 */
      if (asSumEl.value) asSumEl.value.addEventListener('click', onSumClick);
      /* 平台下拉 */
      if (asProvEl.value) asProvEl.value.addEventListener('change', onProvChange);
      /* 时间下拉 */
      if (asTimeEl.value) asTimeEl.value.addEventListener('change', onTimeChange);
      /* 平台下拉的浮层由 load() 里那一次 Dropdowns.build 建（这一页是后挂上来的），
         options 换过之后由 renderFilters 里的 sync 通知。 */
      aiSearchBtn.value = searchFb.el.querySelector('#aiSearchBtn');
      if (aiSearchBtn.value) aiSearchBtn.value.onclick = runAiSearch;
      aiChipEl.value = searchFb.el.querySelector('[data-fb="aiChip"]');
      paintAiChip();
      /* 分页只算一份：这一页的按钮也由 Wb.pager 生成（结构只此一份），
         页面只给 host 与 id 前缀；条目是服务端一批批取的，'more' 档交给哨兵续拉（不是本地全量）。 */
      if (pagerBtnsEl.value) pagerBtnsEl.value.innerHTML = window.Wb.pager.rowHTML('as', { info: '第 1 页' });
      pager = window.Wb.pager.create({
        mode: PAGE_MODE, pageSize: PAGE_SIZE,
        pgPrevId: 'asPgPrev', pgInfoId: 'asPgInfo', pgNextId: 'asPgNext',
        items: () => filteredAll(),
        hasMore: () => hasMore(),
        total: () => (noFilter() && tally ? tally.value() : 0),
        fill: pages => ensureLoaded(pages - 1),
        render: changed => {
          if (changed) window.Wb.pageHead.scrollToList(pageEl.value, gridEl.value);
          renderGrid();
        },
      });
      pager.bindButtons();
      cardList = window.Wb.cards.create({
        box: gridEl.value,
        keyOf: a => assetKeyOf(a),
        sigOf: a => assetSig(a),
        htmlOf: a => assetCardHTML(a),
        paint: (el, a) => paintAssetCard(el, a),
        emptyHTML: emptyStateHTML,
      });
      viewToggle = window.Wb.viewToggle.create({
        el: viewEl.value, key: 'dir_asset_view', target: gridEl.value,
        /* 换档时把开着的那些收起来：清单档是「卡自己长高」，紧凑档是「行下面那条带子」，
           两者的展开形状不同，不能带着一条带子切档。 */
        onPick: () => { band.close(); window.Wb.expand.closeAll(gridEl.value); },
      });
      /* 登记这一页那两份配置：公共件只在「登记的这一页正是前台」时才装上，
         所以初始化跑在「用户已经切走」之后（workbench 脚本异步加载）也不会把
         资产库的灯箱 / 详情贴到前台那一页头上。 */
      registerAdapters();
      window.Wb.pager.sentinel(gridEndEl.value, autoLoadMore);
      tally = window.Wb.tally(() => window.AssetLib.countAll({ reg: REG, from: tallyFrom() }));
      tally.onDone.push(() => {
        if (!started) return;
        try { updatePager(); } catch (e) { console.warn('[assets] 数完总数后刷新分页文案失败：', e); }
      });
      startWatch();
    }

    /* 数总数**接着页面已经翻到的游标往后走**，不重回第 1 页。
       为什么要这一处：countAll 原来自己起一趟 `load({pages:10})`，游标从空开始 ——
       首屏 fetchMore 已经拿回来的那几页等于每个来源又取了一遍（分镜列表缓存的同一类问题，
       「tally 最多每来源翻 10 页」那笔重复，真实环境 9 个来源 = 首屏白多 9 笔）。
       entries 传一份**浅拷贝**：load 会就地塌表（把镜像并成一条），不能改到页面正在画的那一份。
       loadedPages 已超过上限时仍至少再翻一页（`pages:1`），数不完就照实 exact:false。 */
    function tallyFrom() {
      return { pages: loadedPages, cursors, more: moreState, entries: assets };
    }

    /* 数总数要按来源一路翻到底（每来源最多 10 页），是首屏最贵的一笔；
       分页文案先按「共 M+ 页」显示，浏览器空闲了再数，数完由 onDone 换成精确值。
       空闲回调本身有 3 秒兜底：被长任务占满时也不会一直不数。 */
    let tallyTimer = 0;
    function scheduleTally() {
      if (tallyTimer) return;
      const fire = () => { tallyTimer = 0; if (started) tally.run(true); };
      tallyTimer = typeof window.requestIdleCallback === 'function'
        ? (window.requestIdleCallback(fire, { timeout: 3000 }) || 1)
        : setTimeout(fire, 600);
    }

    async function load() {
      if (window.Dropdowns) window.Dropdowns.build(pageEl.value || document);
      renderFilters();
      if (!REG.providers.length) await loadReg();
      /* 别名表先就位再读首屏缓存：缓存里那几条带着上次的镜像字段，
         表没回来就 decorate 不出本机地址，先画出来再跳一下反而更晃眼。 */
      try { if (window.AssetLocal && AssetLocal.ready) await AssetLocal.ready(); } catch (e) { /* 表取不回来就按「本机没有」先画，回头 locate 再补 */ }
      if (!assets.length) {
        const cached = LIST_CACHE.read();
        if (cached.length) { assets = cached; refreshProviderChips(); renderGrid(); }
      }
      /* 首屏要的两页一次取回：以前连发两次 `fetchMore(1)`，等于让每个来源
         分两轮各走一遍列表 + liveKeys，首屏请求数因此翻倍。 */
      await fetchMore(2);
      scheduleTally();
    }

    function onFavChange() { if (started) renderGrid(); }
    function onStorage() { if (started) renderGrid(); }
    function onKeydown(e) {
      if (!isActive()) return;
      if (e.key === 'Escape' && multiMode.value) assetsMulti().setMode(false);
    }

    async function bulkDownload() {
      if (!started) return;
      /* 批量下载是公共件（Wb.downloadList）：资产库与工作台同一份实现，
         进度条与成功/失败计数也只在那里一份。 */
      await window.Wb.downloadList(
        assetsMulti().selected().filter(a => a.dl || a.src).map(a => ({ url: a.dl || a.src, name: fileNameOf(a) })));
    }

    /* ---------- 带进来的「就是这一条」 ----------
       画布节点上的「打开这条资产」跳 `assets.html?q=<资产号>`，而这一页原来完全不读查询串：
       用户到了资产库还得自己再粘一次。读到就把它填进搜索框当关键词，已取回的那几页里没有
       就继续往后取（沿用翻页那 40 页的闸）。 */
    function routeQuery() {
      const src = String((spaRoute && spaRoute.route && spaRoute.route.src) || '');
      const i = src.indexOf('?');
      if (i < 0) return '';
      try { return (new URLSearchParams(src.slice(i + 1)).get('q') || '').trim().toLowerCase(); }
      catch (e) { return ''; }
    }
    let askedQ = '';
    async function followRouteQuery() {
      const q = routeQuery();
      if (!q || q === askedQ) return;
      askedQ = q;
      F.q = q;
      if (searchFb) searchFb.setQuery(q);
      window.Wb.pager.reset(pager);
      renderFilters();
      renderGrid();
      while (!filteredAll().length && hasMore() && !loadFailed() && loadedPages < 40) await fetchMore(2);
      renderGrid();
    }

    /* 切回本页 / 标签页重新可见 / 切走 —— 三种变化只从公共件那一处出口进来（core/activity.js）。
       原来 watch 的是 `activeFile`：那只管路由，整个标签页进后台再回来不会走这一趟，
       于是「在导演台刚生成完、切回资产库看不到」和「后台标签页继续贴灯箱 cfg」两件事同时存在。 */
    let front = false;
    function syncForeground() {
      if (!started) return;
      const on = isActive();
      if (on === front) return;
      front = on;
      if (!on) return;
      renderGrid();
      followRouteQuery();
      refreshIfStale();
    }
    const offActivity = window.__spaActivity.subscribe(syncForeground);
    /* 同一页内地址变了（资产库自己带 ?q= 再跳一次）：只跟着重新定位，不做别的。 */
    if (spaRoute) watch(() => spaRoute.route && spaRoute.route.src, () => { if (front) followRouteQuery(); });

    onMounted(async () => {
      try {
        if (typeof window.__spaLoadScript === 'function') await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
        else if (!window.Wb) throw new Error('workbench.js 没有加载');
      } catch (e) {
        failed.value = '公共模块没有加载起来：' + window.errText(e);
        if (window.PageReport) PageReport.pageFail('资产库', failed.value, e);
        return;
      }
      if (!window.Wb || !window.Api || !window.AssetLib || !window.AssetLocal || !window.Fav || !window.Chips) {
        failed.value = '资产库依赖的公共模块没有就绪（workbench.js / assetlib.js）';
        if (window.PageReport) PageReport.pageFail('资产库', failed.value);
        return;
      }
      await nextTick();
      try {
        initWb();
        /* 页头高度是「多选条粘顶时要让开多少」的唯一来路（见 ui.css 的 --phead-h）。 */
        offHead = window.Wb.pageHead.track(pageEl.value);
      } catch (e) {
        failed.value = '资产库初始化失败：' + window.errText(e);
        if (window.PageReport) PageReport.pageFail('资产库', failed.value, e);
        console.error('[assets] 初始化失败：', e);
        return;
      }
      started = true;
      syncForeground();
      window.addEventListener('fav-change', onFavChange);
      offStorage = window.StorageBus.on(['fav_items', 'sk_media_badge'], onStorage);
      document.addEventListener('keydown', onKeydown);
      paintPullInitial();
      if (window.fillIcons) window.fillIcons(pageEl.value);
      try { await load(); } catch (e) { console.warn('[assets] 加载失败：', e); }
      await followRouteQuery();
      window.Wb.thumbs.hydrate().then(n => { if (n && started) renderGrid(); }).catch(() => {});
    });

    onBeforeUnmount(() => {
      started = false;
      if (offActivity) offActivity();
      if (offHead) { offHead(); offHead = null; }
      unregisterAdapters();
      window.removeEventListener('fav-change', onFavChange);
      if (offStorage) { offStorage(); offStorage = null; }
      document.removeEventListener('keydown', onKeydown);
      if (searchFb) { searchFb.destroy(); searchFb = null; }
      if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
      if (poller && poller.stop) poller.stop();
      if (busOff) busOff();
      if (gridEl.value) gridEl.value.classList.remove('multi');
      const sentinel = gridEndEl.value && gridEndEl.value._sentinelBound;
      if (sentinel && sentinel.disconnect) sentinel.disconnect();
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      failed, cntText, gotoBtnText, gotoBusy,
      reloadDisabled, reloadTitle, multiMode, bulkCountText, bulkTipText, bulkDownDisabled,
      bulkAllText, bulkAllDisabled, bulkFavAddDisabled, bulkFavRemoveDisabled,
      isPageMode: PAGE_MODE === 'page', pagerReady,
      F, faceFrom, faceTo,
      pageEl, gridEl, gridEndEl, loadErrEl, headToolsEl, asTypeEl, asProvEl, asTimeEl, asSumEl, viewEl,
      dFromEl, dToEl, pullLocalBtn, gotoPageEl, pagerBtnsEl,
      openDatePicker, onDateChange, clearDates, timeMode,
      toggleMulti: () => assetsMulti().setMode(!multiMode.value),
      exitMulti: () => assetsMulti().setMode(false),
      bulkAll: () => {
        const list = applyFilters();
        if (!list.length) return;
        assetsMulti().setAll();
        renderGrid();
      },
      bulkClear: () => assetsMulti().clear(),
      bulkDownload, assetsBulkFavAdd, assetsBulkFavRemove,
      pullLocalPage, reload, gotoPageInput,
    };
  },
  render,
};
