/* 资产库 —— 由 assets.html 迁到 Vue 的页面。
   数据与副作用全部走已有的公共层（AssetLib / AssetLocal / Wb / Fav / AiFind / AiChip / Chips），
   组件只负责「这一屏长什么样」；卡片复用、缩略图、灯箱、详情、分页、多选、存回本机仍是全站那一份实现。 */
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, inject, watch } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/assets.js';

const PAGE_MODE = window.pageModeOf('assets');
const PAGE_SIZE = window.pageSizeOf('assets');
const DATE_PRESETS = [['全部', 0], ['今天', 1], ['近 7 天', 7], ['近 30 天', 30]];
import { ensureCss } from '../core/page-css.js';

const ST_MAP = { '已完成': 'done', '生成中': 'running', '排队中': 'queued', '失败': 'failed', '结果未知': 'uncertain' };

/* 这一份样式单独放在 spa-assets.css，打开这一页时由 `ensureCss` 按需挂上
   （外壳只引 tokens / ui / sidebar / spa-director，不引任何页面样式）。 */
ensureCss('web/styles/spa-assets.css', 'spa-assets');

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
    /* 旧页面把翻页那一排写成 display:none，第一次 renderGrid 才露出来：
       数据没回来之前先不摆一排空按钮（它们一出一隐会把右边那排挤动）。 */
    const pagerReady = ref(false);

    const F = reactive({ type: '全部', provider: '全部', status: '全部', q: '', from: '', to: '', presetDays: 0 });
    const faceFrom = computed(() => (F.from ? F.from.slice(5).replace('-', '/') : '起始'));
    const faceTo = computed(() => (F.to ? F.to.slice(5).replace('-', '/') : '结束'));

    const pageEl = ref(null);
    const gridEl = ref(null);
    const gridEndEl = ref(null);
    const loadErrEl = ref(null);
    const typeRowEl = ref(null);
    const fDateEl = ref(null);
    const fProvEl = ref(null);
    const fStatusEl = ref(null);
    const viewEl = ref(null);
    const aiSearchBtn = ref(null);
    const aiChipEl = ref(null);
    const dFromEl = ref(null);
    const dToEl = ref(null);
    const pullLocalBtn = ref(null);
    const cancelAllBtn = ref(null);
    const gotoPageEl = ref(null);
    const pagerBtnsEl = ref(null);

    let started = false;
    let offStorage = null;
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
       所以给 pager 传 onState，让它把「能不能点 / 第几页 / 共几页」算好递回来。 */
    let pager = null;
    /* 大类型 + 搜索这一行的唯一生成者（搜索框、芯片、按钮、计数都出自 Wb.filterBar）。
       AI 检索按钮与 AI 芯片是这一页私有内容，作为 extraHTML 插进同一条行里。 */
    let searchFb = null;
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

    function paintLoadErrors(listEmpty) {
      const box = loadErrEl.value;
      if (!box) return;
      const bits = Object.keys(loadErrors).map(k => window.esc(String(k)) + ' 加载失败：' + window.esc(String(loadErrors[k])));
      const err = bits.length ? '<div class="hint" style="color: var(--warn);margin: var(--sp-6) 0">' + bits.join('；') + '</div>' : '';
      const hide = (!listEmpty && hiddenCloud > 0)
        ? '<div class="hint sm">已按「不显示云端任务」藏起 ' + hiddenCloud + ' 条本机还没有那份字节的产物。</div>' : '';
      box.innerHTML = err + hide;
    }

    /* ---------- 多选 ---------- */
    /* 「哪几个字段算同一条」只在 `AssetLib.entryKey` 点一次名（domain/assetlib.js）。
       这一把比卡片多一维供应商：同一个号在两家平台是两份不同的东西，勾掉一个不该把另一个也取消。 */
    const selKeyOf = a => (a.provider || '') + '|' + window.AssetLib.entryKey(a);

    /* 多选：状态与操作在公共件 `Wb.multi` 里（生成工作台同一份，不许各写一套）。
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
      mode: {
        isOn: () => multiMode.value,
        set: v => {
          multiMode.value = v;
          if (gridEl.value) gridEl.value.classList.toggle('assetsMulti', v);
        },
      },
    }));

    /* ---------- 存回本机：范围不跟「不显示云端任务」走 ----------
       本机 / 去重 / 去空地址的判据在 AssetLocal.pullPlan 那一份（三页共用）。 */
    function pullScope() {
      return window.AssetLocal.pullPlan(
        applyFilters({ includeHidden: true }).filter(a => a.kind === 'asset'), { keyOf: selKeyOf });
    }
    function paintPullBtn() {
      if (!pullLocalBtn.value) return;
      window.AssetLocal.pullBar(pullLocalBtn.value, pullScope(), { what: '产物' });
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
      const todo = pullScope();
      if (!todo.length) {
        /* 「你点了，但什么都没发生」必须看得见：这一类用 warn 档（ok/info 默认静音） */
        window.Toast.warn(assets.some(a => a.kind === 'asset')
          ? '这一屏要存的本机都已经有了'
          : '这一屏还没有可存的产物（排队 / 生成中的任务没有字节可下）');
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
         同一句话不许两页各写一遍。 */
      assetsMulti().paintBar({
        count: t => { bulkCountText.value = t; },
        all: t => { bulkAllText.value = t; },
        canDown: ok => { bulkDownDisabled.value = !ok; },
        allDisabled: none => { bulkAllDisabled.value = none; },
      });
      bulkTipText.value = '点卡片即可勾选';
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
    const stBucket = a => a.kind !== 'task' ? 'done' : window.Api.classifyStatus(null, a.status);

    function applyFilters(opts) {
      const keepHidden = !!(opts && opts.includeHidden);
      if (!keepHidden) hiddenCloud = 0;
      let all = assets.filter(a => {
        if (window.AssetLocal.hideAsCloud(a)) { if (!keepHidden) { hiddenCloud++; return false; } }
        if (!(F.type === '全部' || typeKey(a.type) === typeKey(F.type))) return false;
        if (F.provider !== '全部' && a.providerName !== F.provider) return false;
        if (F.status !== '全部' && stBucket(a) !== ST_MAP[F.status]) return false;
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
    const noFilter = () => F.type === '全部' && F.provider === '全部' && F.status === '全部' && !F.q && !F.from && !F.to && !FAI;

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
        multiMode.value ? 'M' : '-', multiMode.value && selected.has(selKeyOf(a)) ? 'S' : '-',
        (window.AssetLocal && AssetLocal.showBadge && AssetLocal.showBadge()) ? 'B' : '-',
        st ? st.state : '-',
        fk && window.Fav.has(fk) ? 'F' : '-', fk ? (window.Fav.note(fk) || '') : '',
        (a.type === '视频' && a.src && window.Wb.thumbs.get(a.src)) ? 'i' : 'v'].join('|');
    };

    function favNote(a) {
      return window.Fav ? (window.Fav.note(window.Fav.assetKey(a)) || '') : '';
    }
    function favLabel(a) {
      const on = window.Fav && window.Fav.has(window.Fav.assetKey(a));
      return (window.icon ? window.icon(on ? 'starFill' : 'star', 12) : '') + (on ? ' 已收藏' : ' 收藏');
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

    /* 卡片底部那一排：任务那一族（详情 / 下载 / 取消 / 重试）整排交给公共件 Wb.actsHTML，
       这一页只有三颗私有动作（收藏 / 删本机那一份 / 复用）作为 extra 接在后面。
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
        extraHTML: a.kind === 'asset' ? [
          `<button class="ghost favbtn${window.Fav && window.Fav.has(window.Fav.assetKey(a)) ? ' on' : ''}" title="加入 / 移出我的收藏">${favLabel(a)}</button>`,
          a.localAsset ? `<button class="ghost danger delbtn" title="${a.mirror
            ? '本机这份是副本（.assets 目录）：删掉只腾磁盘，平台那份仍在，以后能回源'
            : '它存在本机 .assets 目录：删掉释放磁盘，平台侧素材不受影响'}">${a.mirror ? '删除本机副本' : '删除本机文件'}</button>` : '',
          '<button class="ghost cureuse" title="在生成工作台的图像 / 视频那一栏里带着这条提示词与素材继续创作">复用</button>',
        ].join('') : '',
      };
    }

    function assetCardHTML(a) {
      const run = a.kind === 'task' && window.Wb.stLive(a.status);
      const bad = a.kind === 'task' && window.Wb.stBad(a.status);
      /* 「结果未知」既不是失败也不是已完成：那次提交很可能已被平台受理（钱已经扣）。
         它以前掉进 lateDone 那一档，卡片直接写「已完成（正在同步列表…）」——
         用户照着这句去等产物，而产物可能根本没有，还顺手把「重试」当成了免费的操作。 */
      const unc = a.kind === 'task' && window.Wb.isUncertain(a.status);
      const lateDone = a.kind === 'task' && !bad && !run && !unc;
      let media;
      if (a.kind === 'task') {
        media = lateDone
          ? '<div class="timg"><span style="color: var(--ok)">已完成（正在同步列表…）</span></div>'
          : unc
            ? '<div class="timg"><span style="color: var(--warn)">结果未知</span></div>'
            : '<div class="timg"><span class="spin-dot" style="' + (bad ? 'display:none' : '') + '"></span>' + (bad ? '<span style="color:var(--err)">' + window.Wb.stText(a.status) + '</span>' : window.Wb.stText(a.status) + '…') + '</div>';
      } else if (a.type === '视频') {
        media = '<div class="timg">' + window.Wb.thumbs.mediaHTML(a.src, { mediaAttrs: 'draggable="false"' }) + '</div>';
      } else if (window.isAudioType(a.type)) {
        media = '<div class="timg audio"><span class="note-ic">' + window.icon('mic', 14) + '</span><span class="dur">' + window.fileExtOf(a).toUpperCase() + (a.duration ? ' · ' + a.duration + 's' : '') + '</span></div>';
      } else {
        media = '<div class="timg">' + window.Wb.thumbs.mediaHTML(window.Api.mediaSrc(a.src), {
          type: 'image',
          mediaAttrs: 'loading="lazy" decoding="async" draggable="false"',
        }) + '</div>';
      }
      const date = window.fmtWhen(a.ts);
      return media + `
      <div class="tmain">
        <div class="meta1"><span class="dot${run ? ' run' : bad ? ' fail' : ''}"></span><span>${a.kind === 'task' ? (lateDone ? '已完成' : window.Wb.stText(a.status)) : '已完成'}</span>${assetBadge(a)}<span class="date">${date}</span></div>
        <div class="tprompt" title="${window.esc(a.prompt || '')}">${window.esc(a.prompt || noPromptText(a))}</div>
        ${favNote(a) ? `<div class="favnote" title="收藏备注">★ ${window.esc(favNote(a))}</div>` : ''}
        <div class="meta2">${[a.providerName, a.type, a.kind === 'asset' ? (a.format || '').toUpperCase() : '', a.duration ? a.duration + 's' : ''].filter(Boolean).join(' · ')}</div>
        <div class="acts">${window.Wb.actsHTML(a, actsOpts(a))}</div>
        <div class="cdet"></div>
      </div>`;
    }

    function bindCardThumb(d, a) {
      const wrap = d.querySelector('.timg');
      if (!wrap) return;
      const media = wrap.querySelector('video[data-src], video[src], img');
      if (media) window.Wb.thumbs.bind(wrap, media, a.src || '');
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
        if (!multiMode.value) return;
        if (e.target.closest('.acts') || e.target.closest('.cdet')) return;
        e.preventDefault();
        assetsMulti().toggle(a);
      };
      const thumb = d.querySelector('.timg');
      if (thumb) thumb.onclick = e => {
        if (multiMode.value) { e.stopPropagation(); assetsMulti().toggle(a); return; }
        window.Wb.lightbox.open(a);
      };
      /* 标准那一排（详情 / 下载 / 取消 / 重试）整排交给公共件接线：确认框、忙碌态、报错、
         「这一家没有撤单接口」那道闸，还有「结果未知不许当普通重试」的核对与扣费提醒，
         都在 Wb.bindActs 一份（以前这里自己写了一套，那两道闸都没跟上）。
         这一页只剩三颗私有按钮：收藏 / 删本机那一份 / 复用。 */
      window.Wb.bindActs(d, a, Object.assign(actsOpts(a), {
        onDetail: () => {
          const btn = d.querySelector('.dt'), detBox = d.querySelector('.cdet');
          if (!detBox) return;
          const open = detBox.style.display === 'block';
          detBox.style.display = open ? 'none' : 'block';
          /* 这颗按钮带图标：改字只能改 `.tx` 那一截，textContent 会把图标一起抹掉。 */
          if (btn) window.btnText(btn, open ? '详情' : '收起');
          if (!open) window.Wb.detail.render(a, detBox);
        },
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
          const fb = el.querySelector('.favbtn');
          if (fb) fb.onclick = e => {
            e.stopPropagation();
            if (!window.Fav) return;
            const it = window.Fav.fromEntry(a);
            const before = window.Fav.has(it.key);
            const on = window.Fav.toggle(it);
            fb.classList.toggle('on', on);
            fb.innerHTML = favLabel(a);
            if (on === before) return;
            window.Toast.ok(on ? '已加入我的收藏' : '已移出我的收藏');   // 星标自己会亮，归安静档
          };
          const ru = el.querySelector('.cureuse');
          if (ru) ru.onclick = e => { e.stopPropagation(); reuseAsset(a); };
          const delb = el.querySelector('.delbtn');
          if (delb) delb.onclick = e => {
            e.stopPropagation();
            const hideAfter = !!(window.AssetLocal && AssetLocal.localOnly && AssetLocal.localOnly());
            const tail = hideAfter
              ? '；按当前「不显示云端任务」，这张卡随后会从列表里藏起来（平台那份仍在，重新存回或关掉那一项就能再看到）'
              : '；卡片会留着';
            const note = (a.mirror ? '只删本机这一份副本（平台那边的素材不动）' : '本机这一份会删掉（平台那边的素材不动）') + tail;
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
      return bindAssetCard(d, a);
    }

    /* ---------- 空态：说清为什么是空的、下一步点哪里 ----------
       以前不管筛没筛过都写「没有匹配的资产」：第一次进来的用户看到的是一句
       像在自己身上找原因的话，而且这一页一个出路都不给。 */
    function filterWhy() {
      const bits = [];
      if (F.type !== '全部') bits.push('类型「' + F.type + '」');
      if (F.provider !== '全部') bits.push('平台「' + F.provider + '」');
      if (F.status !== '全部') bits.push('状态「' + F.status + '」');
      if (F.q) bits.push('关键词「' + F.q + '」');
      if (F.from || F.to) bits.push('日期 ' + (F.from || '不限') + ' → ' + (F.to || '不限'));
      if (FAI) bits.push('AI 条件「' + String(FAI.desc).slice(0, 20) + '」');
      return bits;
    }
    function clearFilters() {
      F.type = '全部'; F.provider = '全部'; F.status = '全部'; F.q = '';
      F.from = ''; F.to = ''; F.presetDays = 0;
      FAI = null; aiAsc = 0;
      if (searchFb) searchFb.setQuery('');
      if (dFromEl.value) dFromEl.value.value = '';
      if (dToEl.value) dToEl.value.value = '';
      paintDateChips(); paintAiChip(); renderFilters(); renderGrid();
    }
    function emptyStateHTML() {
      const err = loadErrorsText();
      if (err) return err;
      if (hiddenCloud) {
        return window.Wb.emptyHTML('这一屏的 ' + hiddenCloud + ' 条本机还没有那份字节，'
          + '按「不显示云端任务」藏起来了。要看它们就在设置页关掉这一项（它们还在平台那边）。',
        window.GoPage.btn('settings.html', '去设置页'));
      }
      const why = filterWhy();
      if (why.length) {
        return window.Wb.emptyHTML(['按现在这些条件（' + why.join('、') + '）一条都没有。'],
          '<button class="tool mini" data-clearf="1">清掉这些条件</button>');
      }
      if (!assets.length) {
        return window.Wb.emptyHTML(['还没有取回任何产物：这一页只列各平台已经给出来的任务与产物，它自己不生成东西。',
          '点工具条上的「刷新」重新取一次列表，或先生成一条。'],
        window.GoPage.btn('studio.html?t=video', '去生成工作台')
          + window.GoPage.btn('chars.html', '去素材库'));
      }
      return window.Wb.emptyHTML(['这一屏里还没有已完成的产物（排队与生成中的那些还没有字节）。',
        '要看进行中的，把状态那一档切到「生成中」或「排队中」。']);
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
      viewToggle && viewToggle.apply();
      updatePager();
      const sel = [...selected].length;
      /* 页头这个数和分页条那个数必须同一个口径。以前写的是「共 list.length 项」，而 list 只是
         **当前这一页**（一页 24 条），分页条上却是筛选后的总数（几百条）—— 同屏两个「共」互相打脸。 */
      cntText.value = '共 ' + filteredAll().length + ' 项 · 本页 ' + list.length + ' 项'
        + (sel ? ' · 已选 ' + sel + ' 项' : '');
      reloadDisabled.value = loadingNow > 0;
      reloadTitle.value = loadingNow > 0 ? '正在加载…' : '刷新（跳过服务端短缓存）';
      paintBulkBar();
      paintPullBtn();
      if (!list.length) {
        paintLoadErrors(true);
        cardList.paint([]);
        bindEmptyBox();
        return;
      }
      paintLoadErrors(false);
      cardList.paint(list);
      /* 自动补存：开关开着时把这一屏「本机还没有」的条目排进镜像队列。 */
      try { window.AssetLocal && AssetLocal.offerAll(list); } catch (e) { /* 补存失败不影响列表 */ }
    }

    /* ---------- 删除本机素材 ---------- */
    async function removeEntry(a) {
      const key = assetKeyOf(a);
      const r = await window.AssetLib.remove(a);
      if (r && r.mirrorGone) {
        window.AssetLib.forgetMirror && window.AssetLib.forgetMirror(a);
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
        const hideNow = !!(window.AssetLocal && AssetLocal.localOnly && AssetLocal.localOnly());
        window.Toast.receipt(r && r.kept
          ? (hideNow
            ? '已删掉本机副本；当前「不显示云端任务」会把它从列表藏起来（平台仍在，可重新存回）'
            : '已删掉本机这一份副本（平台那边的素材没动，这张卡片还会留着）')
          : '已删除这条本地素材');
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

    function reuseAsset(a) {
      if (a.kind !== 'asset') { window.Toast.warn('只有已完成的素材可以复用（进行中/失败的任务没有可用的文件）'); return; }
      window.Wb.reuse.go({ from: 'assets', type: a.type,
        assetId: a.assetId || a.id, src: a.src, dl: a.dl, prompt: a.prompt || '' });
    }

    /* ---------- 筛选芯片 / 日期 ---------- */
    function renderFilters() {
      if (searchFb) {
        searchFb.setChips(['全部', '图片', '视频', '音频'], F.type, v => {
          F.type = v;
          renderFilters(); renderGrid();
        });
      }
      if (fProvEl.value) {
        window.Chips.render(fProvEl.value, uniq('providerName'), F.provider, v => { F.provider = v; renderFilters(); renderGrid(); });
      }
      if (fStatusEl.value) {
        window.Chips.render(fStatusEl.value, ['全部', '已完成', '生成中', '排队中', '失败', '结果未知'], F.status, v => { F.status = v; renderFilters(); renderGrid(); });
      }
    }

    function paintDateChips() {
      if (!fDateEl.value) return;
      window.Chips.render(fDateEl.value, DATE_PRESETS.map(([label, days]) => [days, label]), F.presetDays, v => {
        const days = Number(v);
        if (!days) {
          F.from = ''; F.to = ''; F.presetDays = 0;
          if (dFromEl.value) dFromEl.value.value = '';
          if (dToEl.value) dToEl.value.value = '';
        } else {
          const now = new Date();
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
          F.from = window.dayKey(start); F.to = window.dayKey(now); F.presetDays = days;
          if (dFromEl.value) dFromEl.value.value = F.from;
          if (dToEl.value) dToEl.value.value = F.to;
        }
        paintDateChips();
        renderGrid();
      }, { isOn: v => (Number(v) === 0 ? (!F.from && !F.to) : F.presetDays === Number(v)) });
    }

    function onDateChange(which) {
      if (which === 'from') F.from = dFromEl.value ? dFromEl.value.value : '';
      else F.to = dToEl.value ? dToEl.value.value : '';
      F.presetDays = 0;
      paintDateChips();
      renderGrid();
    }
    function clearDates() {
      F.from = ''; F.to = ''; F.presetDays = 0;
      if (dFromEl.value) dFromEl.value.value = '';
      if (dToEl.value) dToEl.value.value = '';
      paintDateChips();
      renderGrid();
    }
    function openDatePicker(which, e) {
      if (e.target.closest('.dp-pop')) return;
      const holder = e.currentTarget;
      const inp = which === 'from' ? (dFromEl.value || null) : (dToEl.value || null);
      if (!inp || !window.DatePicker) return;
      e.preventDefault();
      window.DatePicker.open(holder, inp, { onPick: () => { paintDateChips(); renderGrid(); } });
    }

    /* ---------- 搜索 ---------- */
    /* 输入与「搜索」按钮都交给 searchFb：按钮按的也是同一个回调，防抖在公共件里。 */
    function onSearchClick() {
      if (!searchFb) return;
      searchFb.setQuery(searchFb.value(), true);
    }

    /* ---------- AI 检索 ---------- */
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
        clearTitle: '清除 AI 条件',
        clearId: 'assetsAiClear',
        onClear: () => {
          FAI = null; aiAsc = 0;
          paintAiChip(); renderFilters(); renderGrid();
        },
      });
    }

    async function runAiSearch() {
      if (!started) return;
      const box = searchInput();
      const q = ((box && box.value) || '').trim();
      const gateWhy = window.AiFind.shortWhy(q, 'AI 检索');
      if (gateWhy) { cntText.value = gateWhy; if (box) box.focus(); return; }
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
      const old = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '检索中…'; }
      try {
        const reg = await window.Api.registry();
        const out = await window.TextAI.chat(reg, sys, JSON.stringify({ 需求: v.q, 可用素材样例: idx, 我的收藏: favs }));
        const j = window.TextAI.parseJson(out);
        if (!j) throw new Error('AI 没有给出可用的检索条件');
        FAI = { desc: v.q, cond: j, seen };
        aiAsc = j.order === 'asc' ? 1 : (j.order === 'desc' ? -1 : 0);
        if (searchFb) searchFb.setQuery(''); else if (box) box.value = '';
        F.q = '';
        window.Toast.receipt('AI 检索条件已生效（原话：' + v.q.slice(0, 24) + '），清空条件点下面的 ✕');
      } catch (e) {
        window.Toast.err('AI 检索失败：' + window.errText(e));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = old; }
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
      /* 「大类型 + 搜索」这一行：公共件生成芯片 / 输入框 / 计数，这一页只把自己的
         AI 检索按钮与 AI 芯片作为额外内容塞进去（顺序与原模板一致）。 */
      searchFb = window.Wb.filterBar.bind(typeRowEl.value, {
        cls: '', chips: ['全部', '图片', '视频', '音频'], value: F.type,
        headHTML: '<span class="flabel">大类型</span>',
        betweenHTML: '<span class="flabel" style="margin-left: var(--sp-14)">搜索</span>',
        inputId: 'search', placeholder: '提示词 / 资产ID / 任务ID…', q: F.q,
        onFilter: v => { F.type = v; renderFilters(); renderGrid(); },
        onSearch: v => { F.q = String(v == null ? '' : v).trim().toLowerCase(); renderGrid(); },
        extraHTML: '<button class="ghost" id="searchBtn" title="立即按当前关键词筛选（输入时也会自动筛）" style="flex:0 0 auto">搜索</button>'
          + '<button class="ghost" id="aiSearchBtn" title="按左边搜索框里写的描述做 AI 检索（翻译成筛选条件就地过滤）" style="flex:0 0 auto">AI 检索</button>'
          + '<span data-fb="aiChip"></span>',
        cnt: false,
      });
      const searchBtn = searchFb.el.querySelector('#searchBtn');
      if (searchBtn) searchBtn.onclick = onSearchClick;
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
        render: () => renderGrid(),
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
      /* 批量下载是公共件（Wb.downloadList）：资产库与生成工作台同一份实现，
         进度条与成功/失败计数也只在那里一份。 */
      await window.Wb.downloadList(
        assetsMulti().selected().filter(a => a.dl || a.src).map(a => ({ url: a.dl || a.src, name: fileNameOf(a) })));
    }

    async function cancelAll() {
      if (!started) return;
      const btn = cancelAllBtn.value;
      const live = assets.filter(a => a.kind === 'task' && window.Wb.stLive(a.status));
      if (!live.length) { window.Toast.warn('没有进行中的任务：这一屏里没有正在排队或正在跑的任务'); return; }
      const rs = live.filter(a => { const p = window.Api.provOf(a.provider); return p && window.Api.canCancel(p); });
      const dim = live.length - rs.length;
      if (!rs.length) { window.Toast.warn('这些任务所在的平台没有提供撤单接口，只能等平台那边自己结束'); return; }
      if (window.Confirm.arm(btn, '确认取消 ' + rs.length + ' 个？' + (dim ? '（另有 ' + dim + ' 个的平台没有撤单接口）' : ''))) return;
      const rr = await Promise.allSettled(rs.map(a => window.Wb.cancelTask(window.Api.provOf(a.provider), a.genId || a.id)));
      const nf = rr.filter(r => r.status === 'rejected').length;
      /* 撤单只有一份实现（Wb.cancelTask：认平台、认这一家到底有没有取消接口），
         而且结果要按条数报：一条都没撤掉时说「已取消」，用户就会以为那些任务停了、不再计费。 */
      if (!nf) window.Toast.receipt('已取消 ' + rs.length + ' 条：平台上这些任务已撤单');
      else if (nf === rs.length) window.Toast.warn('这 ' + rs.length + ' 条一条都没撤掉：它们可能还在跑、继续计费。刷新后仍在的请再试一次');
      else window.Toast.warn('已取消 ' + (rs.length - nf) + ' 条，另有 ' + nf + ' 条没撤掉（可能还在跑并计费）');
      await refreshKeepPage();
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
      paintDateChips();
      paintPullInitial();
      if (window.fillIcons) window.fillIcons(pageEl.value);
      try { await load(); } catch (e) { console.warn('[assets] 加载失败：', e); }
      await followRouteQuery();
      window.Wb.thumbs.hydrate().then(n => { if (n && started) renderGrid(); }).catch(() => {});
    });

    onBeforeUnmount(() => {
      started = false;
      if (offActivity) offActivity();
      unregisterAdapters();
      window.removeEventListener('fav-change', onFavChange);
      if (offStorage) { offStorage(); offStorage = null; }
      document.removeEventListener('keydown', onKeydown);
      if (searchFb) { searchFb.destroy(); searchFb = null; }
      if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
      if (poller && poller.stop) poller.stop();
      if (busOff) busOff();
      if (gridEl.value) gridEl.value.classList.remove('assetsMulti');
      const sentinel = gridEndEl.value && gridEndEl.value._sentinelBound;
      if (sentinel && sentinel.disconnect) sentinel.disconnect();
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      failed, cntText, gotoBtnText, gotoBusy,
      reloadDisabled, reloadTitle, multiMode, bulkCountText, bulkTipText, bulkDownDisabled,
      bulkAllText, bulkAllDisabled,
      isPageMode: PAGE_MODE === 'page', pagerReady,
      F, faceFrom, faceTo,
      pageEl, gridEl, gridEndEl, loadErrEl, typeRowEl, fDateEl, fProvEl, fStatusEl, viewEl,
      aiSearchBtn, aiChipEl, dFromEl, dToEl, pullLocalBtn, cancelAllBtn, gotoPageEl, pagerBtnsEl,
      onSearchClick, runAiSearch, openDatePicker, onDateChange, clearDates,
      toggleMulti: () => assetsMulti().setMode(!multiMode.value),
      exitMulti: () => assetsMulti().setMode(false),
      bulkAll: () => {
        const list = applyFilters();
        if (!list.length) return;
        assetsMulti().setAll();
        renderGrid();
      },
      bulkClear: () => assetsMulti().clear(),
      bulkDownload,
      pullLocalPage, reload, cancelAll, gotoPageInput,
    };
  },
  render,
};
