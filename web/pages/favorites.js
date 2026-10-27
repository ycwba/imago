/* 我的收藏 —— 第一个迁到 Vue 的页面。
   数据与副作用全部走已有的公共层（Fav / Wb / AssetLocal / AiFind / Chips / AiChip），
   组件只负责「这一屏长什么样」；分页、灯箱、详情、缩略图缓存仍是全站那一份实现。 */
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, inject, watch } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/favorites.js';
import { ensureCss } from '../core/page-css.js';

/* 页面样式跟着页面组件走：第一次打开这一页才挂，切页不重复插。 */
ensureCss('web/styles/spa-pages.css');

const PAGE_MODE = window.pageModeOf('favorites');
const PAGE_SIZE = window.pageSizeOf('favorites');
/* 类型档：**没有「文件」这一档**。
   收藏页原来有第五档「其它」（内部值 `文件`），但它装的**只有本地上传的文件** ——
   资产库的条目类型只有图片 / 视频 / 音频（平台 kind + 本机资产账的 MEDIA_KIND_ZH），
   `Fav.fromEntry` 沿用条目自己的 type，所以从资产库收藏过来的东西**永远不会**落进那一档。
   页面里那一档的芯片写「其它」、卡面 meta 行写「文件」，同一个屏幕上两种叫法 ——
   去掉的是**那一颗筛选芯片**，不是本地上传这个入口：**上传本地文件仍然在**
   （工具行那颗按钮 + 拖文件进窗口），用户机器上已有的那批本地上传收藏也照样显示得出来。
   上传进来的图片 / 视频 / 音频按扩展名分到对应那一档；其余（真的没有扩展名 / 认不出的）
   归到「其它」那一档内部值 `文件`，只是不再给它单独一颗芯片。 */
const TYPES = [['all', '全部'], ['图片', '图片'], ['视频', '视频'], ['音频', '音频']];

export default {
  name: 'FavoritesView',
  setup() {
    const activeFile = inject('spaActiveFile', null);
    /* 前台判据只有公共层那一份：core/activity.js（外壳挂在 window.__spaActivity）。
       这里原来自己读 `spaActiveFile`：那只说明「路由选中的是这一页」，整个标签页切到后台时
       它照样为真，于是看不见的收藏页还在接拖拽、还在处理快捷键。 */
    const isActive = window.__spaActivity.forPage('favorites.html');
    /* 下面这一支不是「前台判据」的第二份：它只在**路由切到本页**那一刻再画一遍
       （从设置页改了「卡片标识」再切回来时，卡片 HTML 要按新开关重画）。 */
    if (activeFile && typeof activeFile === 'object') {
      watch(activeFile, f => { if (f === 'favorites.html' && ready.value) render(); });
    }
    const ready = ref(false);
    const failed = ref('');
    /* 空态要说清「为什么是空的」：搜索无果、筛选为空、AI 挑完没有、真的还没有收藏，
       是四种完全不同的下一步 —— 一律写成「还没有收藏」时，用户会以为自己把收藏弄丢了。 */
    const emptyWhy = ref('');
    const q = ref('');
    const filter = ref('all');
    const viewItems = ref([]);
    const urls = ref({});
    const cntText = ref('');
    const rootEl = ref(null);
    /* 收藏总数（页头上下文槽用）：**总数**，不是筛选后的条数 —— 筛选条数在下面那行工具条上。 */
    const favTotal = ref(0);
    const pagerTick = ref(0);
    const pagerVisible = ref(false);
    const aiText = ref('');
    const uploadHtml = ref((window.icon ? icon('upload', 13) : '') + ' 上传本地文件');
    const uploading = ref(false);
    const pullBtn = ref(null);
    const grids = ref(null);
    const toolbarEl = ref(null);
    const kindEl = ref(null);
    const viewEl = ref(null);
    const favProvEl = ref(null);
    const favTimeEl = ref(null);
    const fileEl = ref(null);
    const gridEnd = ref(null);
    const pagerRow = ref(null);
    const dlBusy = reactive({});
    const dlMsg = reactive({});
    const noteTimers = new Map();
    /* 多选：状态与操作在公共件 `Wb.multi`（资产库与生成工作台同一份）。
       这一页只提供三件事：条目身份（keyOf）、当前这一屏看得见的条目、改完之后怎么重画。 */
    const multiMode = ref(false);
    const selected = new Set();
    const bulkCountText = ref('');
    const bulkTipText = ref('点卡片即可勾选');
    const bulkDownDisabled = ref(true);
    const bulkAllText = ref('全选当前列表');
    const bulkAllDisabled = ref(false);
    /* 「取消收藏」那颗：能不能点由公共件算（这一页每一条都已经在收藏里，
       所以它只在一勾选了东西时才亮）。 */
    const bulkFavRemoveDisabled = ref(true);
    /* 详情就地展开：开着的只有一条（key）。展开的内容由 Wb.detail 渲染进那一格自己的展开区。 */
    const openKey = ref('');

    const urlMap = new Map();
    let pager = null;
    let offStorage = null;
    let viewToggle = null;
    let renderSeq = 0;
    let aiPick = null;
    let aiRank = null;
    let aiWhy = '';
    /* 工具条结构（chips / 搜索框 / AI 按钮 / AI 条件芯片 / 计数）全部由 Wb.filterBar 生成，
       这一页只留「点完之后做什么」。以下是在 bind 之后取回的几颗节点，页面自己接线。 */
    let toolbarFb = null;
    let aiBtnEl = null;
    let aiChipHost = null;
    let healEl = null;

    const byType = (it, t) => t === 'all' || (t === '音频' ? window.isAudioType(it.type) : it.type === t);
    const fmtSize = b => window.fmtBytes(b);
    const favKind = it => window.mediaKindOf(it.type);
    const favFileName = it => {
      if (it.kind === 'local' && it.name) return it.name;
      return window.fileStamp(it.ts) + ' ' + window.fileSafe(it.prompt || it.name || '素材', 24) + '.' + window.fileExtOf(it);
    };
    const reuseTabZh = t => ({ video: '视频', image: '图像', audio: '音频' })[window.mediaKindOf(t)];
    const canReuse = it => it.kind === 'asset' || !!it.fileKey;

    const aiRankOf = it => (aiRank && aiRank.has(it.key) ? aiRank.get(it.key) : Number.MAX_SAFE_INTEGER);
    const orderItems = items => (aiRank ? items.slice().sort((a, b) => aiRankOf(a) - aiRankOf(b)) : items);

    /* 「显示到第几条 / 滚到底再多放一页」归 `Wb.pager`（本地全量的续拉那一档由它数页数）；
       这里是 Vue 的 computed，pager 的计数器不是响应式的，所以每次列表重画点一下 pagerTick。 */
    const pageItems = computed(() => {
      pagerTick.value;
      return pager ? pager.slice(viewItems.value) : viewItems.value;
    });

    function resetPaging() {
      if (pager) pager.reset();
      pagerTick.value++;
    }

    /* 类型筛选（图片/视频/音频）：公共件 Wb.kindFilter —— 与生成工作台、资产库同一副
       （以前这一页走 filterBar 的芯片行，三页三副样子；用户点名：统一成工作台那副）。
       计数口径照原来那一份：这一屏里这一档有多少条。 */
    let kindFb = null;
    function paintKinds() {
      if (!kindFb) return;
      const items = Fav.list();
      kindFb.setCounts(v => items.filter(x => byType(x, v)).length);
      kindFb.setValue(filter.value);
    }
    function bindKindFilter() {
      if (!kindEl.value) return;
      kindFb = Wb.kindFilter.bind(kindEl.value, {
        kinds: TYPES,
        value: filter.value,
        count: () => 0,
        onPick: v => { filter.value = v; resetPaging(); render(); },
      });
    }

    function paintAiChip() {
      if (!aiChipHost) return;
      window.AiChip.show(aiChipHost, {
        on: !!aiPick, picked: aiPick && aiPick.size, why: aiWhy,
        clearId: 'favAiClear', onClear: clearAiPick,
      });
    }

    function setFavCnt(text) {
      cntText.value = text;
      if (toolbarFb) toolbarFb.setCount(text);
    }

    function setHeal(text) {
      if (!healEl) return;
      healEl.textContent = text || '';
    }

    /* 整条工具条只在这里建一次：芯片行、搜索框、计数由公共件画；AI 按钮与 AI 条件芯片是
       这一页的额外件，以 extraHTML 传入，bind 之后再捎回节点接自己的行为。 */
    function bindFavToolbar() {
      if (!toolbarEl.value) return;
      toolbarFb = Wb.filterBar.bind(toolbarEl.value, {
        chips: null,
        value: filter.value,
        q: q.value,
        placeholder: '搜索名称 / 提示词 / 备注',
        onFilter: v => { filter.value = v; resetPaging(); render(); },
        onSearch: v => { q.value = v; resetPaging(); render(); },
        extraHTML: '<button class="tool acc" title="AI 挑收藏">'
          + ((window.icon ? icon('sparkles', 14) : '') + ' AI 找素材') + '</button>'
          + '<span data-fb="aiChip"></span>',
        /* 过期图回源那一句是提醒，不是计数：留在计数右边，别混进 setCount 里。 */
        tailHTML: '<span class="cnt" data-fb="heal" style="color:var(--warn)"></span>',
      });
      if (!toolbarFb) return;
      aiBtnEl = toolbarFb.el.querySelector('.tool.acc');
      if (aiBtnEl) aiBtnEl.onclick = runAiFind;
      aiChipHost = toolbarFb.el.querySelector('[data-fb="aiChip"]');
      healEl = toolbarFb.el.querySelector('[data-fb="heal"]');
    }

    function clearAiPick() { window.AiFind.clear(AI); }

    function thumbHtml(it) {
      const kind = favKind(it);
      /* 没有画面的那一格 = 一块**状态牌**（公共件 .plate）：与资产库的「生成失败」那一块
         同一副骨架 —— 一张卡就一张卡，状态只换里面的内容。 */
      if (kind === 'audio') {
        return '<span class="plate plate--audio"><span class="plate-st">音频</span>'
          + '<span class="plate-t">' + window.esc(window.fileExtOf(it).toUpperCase())
          + (it.duration ? ' · ' + it.duration + 's' : '') + '</span></span>';
      }
      if (it.type === '文件') {
        return '<span class="plate plate--file"><span class="plate-st">文件</span>'
          + '<span class="plate-t">' + window.esc(String(it.format || '').toUpperCase()) + '</span></span>';
      }
      const url = urls.value[it.key] || '';
      if (!url) {
        /* 有条目但拿不到地址（外链还没回源 / 本机没有那份字节）：这一格也用状态牌，
           不是留一块白（白块看着像加载不出来）。 */
        return '<span class="plate plate--plain"><span class="plate-st">' + window.esc(it.type || '素材') + '</span>'
          + '<span class="plate-t">地址还没拿到</span></span>';
      }
      const tkey = it.kind === 'local' && it.fileKey ? 'fav-file:' + it.fileKey : url;
      return kind === 'video'
        ? Wb.thumbs.mediaHTML(url, { key: tkey, mediaAttrs: 'draggable="false"' })
        : Wb.thumbs.mediaHTML(url, { key: tkey, type: 'image', mediaAttrs: 'loading="lazy" draggable="false"' });
    }

    function bindThumbs() {
      if (!grids.value) return;
      grids.value.querySelectorAll('.card[data-key]').forEach(card => {
        const it = viewItems.value.find(x => x.key === card.dataset.key);
        const tw = card.querySelector('.thumb');
        if (!it || !tw) return;
        const tm = tw.querySelector('video[data-src], video[src], img');
        const url = urlMap.get(it.key) || '';
        const tkey = it.kind === 'local' && it.fileKey ? 'fav-file:' + it.fileKey : url;
        if (tm && url) Wb.thumbs.bind(tw, tm, url, null, tkey);
      });
    }

    const titleOf = it => it.prompt || it.name || '(无描述)';
    /* 这一页**不显示本机 / 云端 / 只剩外链**：字节在哪是资产库的事，
       收藏页只说「这一条是从哪儿来的、是什么、多大」。 */
    const metaOf = it => [
      it.kind === 'local' ? '本地文件' : (it.providerName || '资产库'),
      it.type,
      it.format ? String(it.format).toUpperCase() : '',
      it.size ? fmtSize(it.size) : '',
      it.duration ? it.duration + 's' : '',
    ].filter(Boolean).join(' · ');

    function paintPullBtn() {
      if (!pullBtn.value) return;
      AssetLocal.pullBar(pullBtn.value, pullScope(), { what: '收藏', more: '本地上传的那一批不算。' });
    }

    function pullScope() {
      return AssetLocal.pullPlan(viewItems.value.filter(it => it.key), { keyOf: it => it.key });
    }

    async function pullLocal() {
      const todo = pullScope();
      const btn = pullBtn.value;
      if (!todo.length) {
        /* 守卫型的这一句要用 warn 档：安静档吞掉 ok/info 之后，按钮看起来就是「坏了」——
           「你点了，但事实没发生」正是必须看见的那一类。 */
        Toast.warn(viewItems.value.some(x => x.kind !== 'local')
          ? '本机已有'
          : '本地文件不用存');
        return;
      }
      AssetLocal.pullStart(btn);
      const s = await AssetLocal.pullMany(todo.map(it => ({
        entry: it, name: String(it.prompt || it.name || '这一条').slice(0, 12),
        apply: u => { Fav.localize(it, u); urls.value = { ...urls.value, [it.key]: u }; urlMap.set(it.key, u); },
      })), { onProgress: (done, total) => window.btnText(btn, '存回本机 ' + done + ' / ' + total) });
      AssetLocal.pullEnd(btn);
      paintPullBtn();
      await nextTick();
      bindThumbs();
      AssetLocal.pullReceipt(s, { nothing: '这一屏没有需要存的收藏' });
    }

    /* 平台下拉：从收藏里现取（平台涨到十几家时，一行十几颗芯片会把整行撑开）。 */
    function renderProvSelect() {
      const el = favProvEl.value;
      if (!el) return;
      const ps = [...new Set(Fav.list().map(provOf))].filter(Boolean);
      if (fProv.value !== '全部' && !ps.includes(fProv.value)) fProv.value = '全部';
      el.innerHTML = ['全部', ...ps]
        .map(p => '<option value="' + window.esc(p) + '">' + window.esc(p) + '</option>').join('');
      el.value = fProv.value;
      /* 换过 options 必须通知公共下拉：浮层那份列表是 build 那一刻的快照。 */
      if (window.Dropdowns) window.Dropdowns.sync(el);
    }

    function onFavProvChange() {
      fProv.value = favProvEl.value ? favProvEl.value.value : '全部';
      render();
    }
    function onFavTimeChange() {
      fTime.value = favTimeEl.value ? favTimeEl.value.value : '0';
      render();
    }

    async function render() {
      if (!ready.value) return;
      const seq = ++renderSeq;
      paintKinds();
      paintAiChip();
      viewToggle && viewToggle.apply();
      renderProvSelect();
      const query = q.value.trim();
      const all = Fav.list();
      favTotal.value = all.length;
      const items = orderItems((query ? Fav.search(query) : all)
        .filter(x => byType(x, filter.value) && (!aiPick || aiPick.has(x.key))
          && (fProv.value === '全部' || provOf(x) === fProv.value)
          && inTimeWindow(x)));
      viewItems.value = items;
      if (items.length) emptyWhy.value = '';
      else if (query) emptyWhy.value = '没有匹配「' + query + '」';
      else if (aiPick) emptyWhy.value = 'AI 没挑到收藏';
      else if (filter.value !== 'all') emptyWhy.value = '没有收藏';
      else emptyWhy.value = '还没有收藏';
      paintPullBtn();
      setFavCnt(items.length ? '共 ' + items.length + ' 项' : '');
      pagerVisible.value = items.length > 0;
      if (items.length) pager.update();

      const shown = pageItems.value;
      const next = {};
      let nextIdx = 0;
      await Promise.all(Array.from({ length: Math.min(6, shown.length) }, async () => {
        while (nextIdx < shown.length) {
          const i = nextIdx++;
          if (seq !== renderSeq) return;
          next[shown[i].key] = await Fav.urlOf(shown[i]).catch(() => '');
        }
      }));
      if (seq !== renderSeq) return;
      urls.value = next;
      urlMap.clear();
      for (const k of Object.keys(next)) urlMap.set(k, next[k]);
      await nextTick();
      if (seq !== renderSeq) return;
      bindThumbs();
      /* 紧凑档的显式分行：一行几格是按容器宽度算出来的（窗口变了要重算）。 */
      measureCols();
      /* 开着的那条详情：重画换了卡里的内容，展开区要重新填一次。 */
      paintOpenDetail();
      /* 自动补存：开关开着时把这一屏「本机还没有」的条目排进镜像队列。
         判据用 wantSave 那一份；「存回本机」按钮仍是「立刻取回」用的。 */
      try { AssetLocal.offerAll(shown, { keyOf: it => it.key }); } catch (e) { /* 补存失败不影响列表 */ }
      resignSome(shown, seq).catch(e => console.warn('[fav] 过期回源失败', e));
    }

    async function resignSome(items, seq) {
      const staleN = items.filter(it => Fav.expired(it.src || it.dl || '')).length;
      if (!staleN) { setHeal(''); return; }
      const done = await Fav.resignSome(items, (it, nextUrl) => {
        if (seq !== renderSeq) return;
        urls.value = { ...urls.value, [it.key]: nextUrl };
        urlMap.set(it.key, nextUrl);
        nextTick(bindThumbs);
      });
      if (seq !== renderSeq) return;
      const left = Math.max(0, staleN - (Number(done) || 0));
      setHeal(left ? '还有 ' + left + ' 条没换回来' : '');
    }

    function openLb(it) { Wb.lightbox.open(it); }

    function onNote(it, e) {
      it.note = e.target.value;
      clearTimeout(noteTimers.get(it.key));
      noteTimers.set(it.key, setTimeout(() => {
        noteTimers.delete(it.key);
        Fav.setNote(it.key, it.note, { silent: true });
      }, 600));
    }
    function flushNote(it) {
      clearTimeout(noteTimers.get(it.key));
      noteTimers.delete(it.key);
      Fav.setNote(it.key, it.note, { silent: true });
    }

    async function dropItem(it) {
      const isLocal = it.kind === 'local';
      const ok = await Confirm.ask({
        title: '取消收藏？', danger: true, okLabel: '取消收藏',
        body: isLocal ? '本地文件会一起删除。' : '资产库素材不受影响。',
      });
      if (!ok) return;
      Fav.remove(it.key);
      render();
    }

    async function download(it) {
      if (dlBusy[it.key]) return;
      dlBusy[it.key] = true;
      dlMsg[it.key] = '下载中…';
      try {
        const b = await Fav.blobOf(it);
        if (!b) throw new Error('取不到文件');
        Net.save(b, favFileName(it));
        dlMsg[it.key] = '已开始下载';
      } catch (err) {
        dlMsg[it.key] = '下载失败';
      }
      setTimeout(() => { dlBusy[it.key] = false; delete dlMsg[it.key]; }, 1800);
    }

    function reuse(it) {
      Wb.reuse.go(it.kind === 'local'
        ? { from: 'favorites', type: it.type, fileKey: it.fileKey, name: it.name, prompt: it.prompt || '' }
        : { from: 'favorites', type: it.type, assetId: it.assetId, src: urls.value[it.key] || '', prompt: it.prompt || '' });
    }

    /* ---------- 多选：状态与操作在公共件 `Wb.multi`（资产库与生成工作台同一份） ----------
       这一页只提供三件事：条目身份（keyOf）、当前这一屏看得见的条目、改完之后怎么重画。 */
    let multiInst = null;
    const favMulti = () => multiInst || (multiInst = window.Wb.multi({
      sel: selected,
      keyOf: it => it.key,
      visible: () => pageItems.value,
      onChange: () => paintFavBulkBar(),
      /* 批量条那颗「批量下载」能不能点：看选中的那几条有没有地址。
         判据与文案都在公共件 Wb.multi 里（paintBar 那一个出口）。 */
      canDownload: it => !!(urls.value[it.key] || it.src || it.dl),
      /* 收藏这一族：这一页的每一条**都已经在收藏里** —— 所以只有「取消收藏」这一颗有动作
         （批量移出收藏）。「收藏」那颗在这里没有可收的（公共件会按成不可点），
         不摆一颗永远按不动的按钮。批量那一圈在公共件 Wb.multi 里（与资产库同一份）。 */
      fav: {
        can: () => true,
        isOn: () => true,
        add: () => {},
        remove: it => { window.Fav.remove(it.key); },
      },
      mode: {
        isOn: () => multiMode.value,
        set: v => {
          multiMode.value = v;
          /* 容器上的 `.multi` 是**公共**那个开关类：多选进行中，卡上的勾选框才露出来。 */
          if (grids.value) grids.value.classList.toggle('multi', v);
          paintFavBulkBar();
        },
      },
    }));
    /* 「这一条勾上了吗」：判据是公共件那一份（Wb.multi.has），这里只起个名字给模板用。 */
    const favPicked = it => favMulti().has(it);
    function togglePick(it) { favMulti().toggle(it); }
    function onPickKey(e, it) {
      /* 勾选框是可聚焦的：Space / Enter 与点击走同一个出口。 */
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      favMulti().toggle(it);
    }
    function paintFavBulkBar() {
      if (!multiMode.value) return;
      /* 批量条那三处读数（已选几项 / 全选那颗的文案 / 下载键能不能点）由公共件算：
         资产库与生成工作台写的是同一句，这里不另写一份。 */
      favMulti().paintRefs({
        count: bulkCountText, all: bulkAllText, canDown: bulkDownDisabled, allDisabled: bulkAllDisabled,
        favRemoveDisabled: bulkFavRemoveDisabled,
      });
      const tip = favMulti().favTip();
      bulkTipText.value = tip ? ('点卡片即可勾选 · ' + tip) : '点卡片即可勾选';
    }
    async function bulkDownload() {
      const sel = favMulti().selected();
      /* 批量下载是公共件（Wb.downloadList）：资产库与工作台同一份实现，
         进度条与成功 / 失败计数也只在那里一份。 */
      await window.Wb.downloadList(sel.map(it => ({
        url: urls.value[it.key] || it.src || it.dl || '', name: favFileName(it),
      })));
    }
    async function bulkDrop() {
      const sel = favMulti().selected();
      if (!sel.length) { window.Toast.warn('先勾选'); return; }
      const ok = await window.Confirm.ask({
        title: '取消 ' + sel.length + ' 条收藏？', danger: true, okLabel: '取消收藏',
        body: '资产库素材不受影响。',
      });
      if (!ok) return;
      /* 移出收藏走公共件那一份收藏动作（Wb.multi 的 fav 那一族）：
         「取消收藏」与卡面上那颗「移出收藏」是同一件事的两个入口。 */
      const n = favMulti().favRemove();
      favMulti().clear();
      render();
      if (n) window.Toast.receipt('已取消 ' + n + ' 条收藏');
    }

    /* ---------- 筛选：平台 + 时间（与资产库一样的两种） ---------- */
    const fProv = ref('全部');
    const fTime = ref('0');
    /* 收藏时间的窗口：今天 = 今天的 0 点起（不是「最近 24 小时」）。 */
    function inTimeWindow(it) {
      const days = Number(fTime.value) || 0;
      if (!days) return true;
      const ts = Number(it.ts) || 0;
      if (!ts) return false;
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (days - 1));
      return ts >= start.getTime();
    }
    const provOf = it => (it.kind === 'local' ? '本地文件' : (it.providerName || '资产库'));

    /* ---------- 网格档的显式分行 ----------
       紧凑档（网格）里展开的内容要插在**它那一行的下面**，所以这一档必须**先分好组**：
       一行几格是**算出来的**（格子宽 --sz-card-sm、缝 --sp-10），
       算出来的与 CSS 里那几列必须一致 —— 所以列数写进 CSS 变量，两边共用一个数。 */
    const cols = ref(1);
    function measureCols() {
      const box = grids.value;
      if (!box) return;
      if (view.value !== 'compact') { cols.value = 1; box.style.setProperty('--fav-cols', '1'); return; }
      const w = box.clientWidth || 1;
      const c = Math.max(1, Math.floor((w + 10) / (200 + 10)));
      cols.value = c;
      box.style.setProperty('--fav-cols', String(c));
    }
    const rows = computed(() => {
      const list = pageItems.value;
      const c = Math.max(1, cols.value);
      const out = [];
      for (let i = 0; i < list.length; i += c) out.push(list.slice(i, i + c));
      return out;
    });

    /* ---------- 详情：就地展开（不另起一层） ----------
       展开的东西还在那张卡原来的位置上（下面几行顺移），不新开一层浮层。
       清单档 = 那张卡自己长高；紧凑档（网格）= 行下面那条带子（格子长高会在同一行
       别的格子底下留出空洞，网格最怕这种）。一次只开一条；内容由公共件 Wb.detail 渲染。 */
    const view = ref('list');
    function toggleFavDetail(it) {
      openKey.value = openKey.value === it.key ? '' : it.key;
      nextTick(paintOpenDetail);
    }
    function closeDetail() {
      openKey.value = '';
      nextTick(paintOpenDetail);
    }
    /* 这一行里开着的那一条（紧凑档的带子就挂在它下面） */
    const bandItem = row => (row || []).find(x => x.key === openKey.value) || null;

    function paintOpenDetail() {
      if (!openKey.value || !grids.value) return;
      const it = viewItems.value.find(x => x.key === openKey.value);
      if (!it) return;
      let host = null;
      let card = null;
      if (view.value === 'compact') {
        const band = grids.value.querySelector('.band');
        if (band) host = band.querySelector('.cdet');
        card = [...grids.value.querySelectorAll('.fav-card')].find(c => c.dataset.key === openKey.value);
      } else {
        card = [...grids.value.querySelectorAll('.fav-card')].find(c => c.dataset.key === openKey.value);
        if (card) host = card.querySelector('.cdet');
      }
      if (!host) return;
      window.Wb.detail.render(it, host);
      /* 连线落在哪儿是**量出来的**（公共件 Wb.expand.anchor）：换成第 2 列、第 3 列，线也跟着挪。 */
      const band = grids.value.querySelector('.band');
      if (band && card) window.Wb.expand.anchor(band, card);
    }

    /* 拖动一张收藏卡 = 引用这一条（载荷形状在 web/domain/asset-ref.cjs）。备注框与按钮上的
       拖动不归卡片管：那里起势的是选字 / 点按，不是「把这条带给助手」。 */
    function onCardDragStart(e, it) {
      if (!window.AssetRef || e.target.closest('input,textarea,select,button,a,[contenteditable]')) { e.preventDefault(); return; }
      const p = window.AssetRef.set(e.dataTransfer, {
        kind: 'fav', id: it.key, name: it.name || it.prompt || '',
        type: it.type, mtype: it.type, format: it.format,
        src: urls.value[it.key] || '', dl: it.dl || '',
        assetId: it.assetId || '', fileKey: it.fileKey || '', prompt: it.prompt || '', from: 'favorites',
        taskId: it.genId || it.taskId || '', provider: it.provider, providerName: it.providerName,
        ts: it.ts, localAsset: it.kind === 'local', size: it.size, dur: it.duration,
      });
      if (!p) { e.preventDefault(); return; }
      const card = e.currentTarget || e.target.closest('.card');
      if (card) card.classList.add('dragging');
    }
    function onCardDragEnd(e) {
      const card = e.currentTarget || (e.target && e.target.closest ? e.target.closest('.card') : null);
      if (card) card.classList.remove('dragging');
    }

    /* ── 本地上传：入口 + 拖文件进窗口 ──
       去掉的是**「文件」那一颗筛选芯片**（芯片写「其它」、卡面写「文件」，同屏两种叫法），
       不是这个入口：用户手里的本机素材要能直接进收藏，就得有地方丢进来。
       入口两个：工具行那颗「上传本地文件」按钮，以及把文件拖进窗口。 */
    function pickFiles() { if (!uploading.value && fileEl.value) fileEl.value.click(); }

    async function addFiles(files) {
      const list = [...(files || [])];
      if (!list.length) return;
      uploading.value = true;
      uploadHtml.value = '正在保存…';
      let ok = 0; const fail = [];
      for (const f of list) {
        try { await Fav.addLocalFile(f); ok++; }
        catch (err) { fail.push((f && f.name ? f.name : '文件') + '：' + (err && err.message ? err.message : '未知错误')); }
      }
      if (fail.length) Toast.err(`有 ${fail.length} 个文件没收藏上：` + fail.slice(0, 3).join('；') + (fail.length > 3 ? ' 等' : ''));
      else if (ok) Toast.receipt('已加入 ' + ok + ' 个文件');
      uploading.value = false;
      uploadHtml.value = (window.icon ? icon('upload', 13) : '') + ' 上传本地文件';
      render();
    }

    function onFiles(e) {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      addFiles(files);
    }

    /* 拖卡片本体（缩略图 / 视频）时浏览器也会把那张图当文件塞进 dataTransfer：
       那不是上传，判据只认「从窗口外拖进来的文件」（公共层 isExternalFileDrag）。 */
    function onDragOver(e) {
      if (!isActive() || !window.isExternalFileDrag(e)) return;
      e.preventDefault();
      document.body.classList.add('drop');
    }
    function onDragLeave(e) { if (!isActive()) return; if (e.target === document.documentElement) document.body.classList.remove('drop'); }
    function onDrop(e) {
      if (!isActive() || !window.isExternalFileDrag(e)) return;
      e.preventDefault();
      document.body.classList.remove('drop');
      addFiles(e.dataTransfer.files);
    }

    const aiScope = () => Fav.list().slice(0, 100);
    const AI = {
      label: 'AI 找素材',
      btn: () => aiBtnEl,
      ask: () => q.value,
      focus: () => { if (toolbarFb) toolbarFb.focus(); },
      emptyMsg: '还没有收藏',
      get noneMsg() {
        const n = Fav.list().length;
        return 'AI 没找到合适的收藏（换个说法再试）' + (n > 100 ? '；我这次只看了最近 100 条' : '');
      },
      roster: aiScope,
      field: 'keys',
      known: k => aiScope().some(x => x.key === k),
      payload: query => ({ 需求: query, 我的收藏: Fav.text(100) }),
      sys: '你是素材管家：用户会用一句话描述需求，你要从他「我的收藏」清单里挑出最合适的若干条。\n'
        + '规则：\n'
        + '1. 只输出 JSON，不要任何解释、不要 markdown 代码块。格式：{"keys":["收藏ID"],"summary":"一句话说明挑了什么"}\n'
        + '2. 优先级：备注（备注写的是用途）> 名称/描述 > 类型。\n'
        + '3. 宁缺毋滥：确实没有合适的就返回空数组，不要硬凑。\n'
        + '4. summary 说清你按什么理解的需求，界面会显示给用户看。',
      apply: s => { aiPick = s.pick; aiRank = s.rank; aiWhy = s.why; },
      onPick: () => {
        q.value = '';
        filter.value = 'all';
        if (toolbarFb) toolbarFb.setQuery('');
      },
      done: () => { resetPaging(); render(); },
      say: t => { setFavCnt(t); },
    };

    function runAiFind() { window.AiFind.run(AI); }

    function onFavChange() { render(); }
    function onStorage() { render(); }
    /* 窗口变宽变窄：紧凑档的行分组要重算（一行几格变了，带子的落点也跟着变）。
       监听与计时器都在 setup 作用域上，卸载时摘得掉（写在 onMounted 里就摘不掉了）。 */
    let rsTimer = null;
    function onFavResize() {
      clearTimeout(rsTimer);
      rsTimer = setTimeout(() => { measureCols(); paintOpenDetail(); }, 120);
    }
    /* Esc：先收掉开着的那条详情，再退多选 —— 一次只退一层，跟抽屉的规矩一样。 */
    function onFavKey(e) {
      if (!isActive()) return;
      if (e.key !== 'Escape') return;
      if (openKey.value) { openKey.value = ''; render(); return; }
      if (multiMode.value) favMulti().setMode(false);
    }

    function initWb() {
      /* 分页行结构只从 Wb.pager 取：模板里只留一个空的 `.pager-row` 宿主，
         id 带页面前缀 —— 七页同在 KeepAlive 里，写死 pgNext 会在同一份文档里撞号。 */
      if (pagerRow.value) pagerRow.value.innerHTML = Wb.pager.rowHTML('fav', { info: '第 1 页' });
      pager = Wb.pager.create({
        mode: PAGE_MODE, pageSize: PAGE_SIZE, localMore: true,
        pgPrevId: 'favPgPrev', pgInfoId: 'favPgInfo', pgNextId: 'favPgNext',
        items: () => viewItems.value,
        /* 翻页要重新取那一页的缩略图地址：只推 pagerTick 会换掉列表条目，
           而 urls 还是上一页的键 → 第 2 页每格都空。render() 自己按当前页重取。 */
        render: () => { render(); },
      });
      pager.bindButtons();
      viewToggle = Wb.viewToggle.create({
        el: viewEl.value, key: 'dir_fav_view', target: grids.value,
        /* 换档时把开着的那些收起来：清单档是「卡自己长高」，紧凑档是「行下面那条带子」，
           两者的展开形状不同，不能带着一条带子切档。 */
        onPick: v => { view.value = v; openKey.value = ''; measureCols(); },
      });
      view.value = viewToggle.value || 'list';
      /* 平台 / 时间两个下拉 */
      if (favProvEl.value) favProvEl.value.addEventListener('change', onFavProvChange);
      if (favTimeEl.value) favTimeEl.value.addEventListener('change', onFavTimeChange);
      /* 原生 select 的浮层：这一页是后挂上来的，公共下拉要在这里建一次 */
      if (window.Dropdowns) window.Dropdowns.build(grids.value ? grids.value.closest('.fav-page') : document);
      /* 灯箱与详情全站只有**一份**：init 只做一次（它会挂全局键盘监听，多挂一份方向键就一次翻
         两页），配置向公共层登记「收藏这一页要这两份」，切回本页时由 spa:page 装回自己那一份。
         以前这里只在挂载时 init 一遍、走了不归还 —— 先去资产库再回收藏，翻页用的还是资产库那份 list。 */
      const detailCfg = {
        prompt: it => it.prompt || it.name || '',
        status: it => (it.kind === 'local' ? '本地文件' : '已收藏'),
        /* 只补公共层那一份账条里**没有**的两行：备注与收藏时间。
           平台 / 类型 / 格式 / 大小 / 时长 公共层已经列了（同名行只留第一条），
           这里再列一遍就是同一件事说两遍。 */
        rows: it => [
          ['备注', it.note || ''],
          ['收藏时间', window.fmtWhen(it.ts)],
        ],
      };
      const lbCfg = {
        list: () => viewItems.value,
        keyOf: it => it.key,
        srcOf: it => Fav.urlOf(it),
        nameOf: favFileName,
        kindOf: favKind,
        info: (it, el) => {
          const w = (el && (el.videoWidth || el.naturalWidth)) || 0;
          const h = (el && (el.videoHeight || el.naturalHeight)) || 0;
          return [w ? w + '×' + h + 'px' : '', fmtSize(it.size), it.duration ? it.duration + 's' : '',
            it.kind === 'local' ? '本地文件' : (it.providerName || '资产库'), it.type,
            it.format ? String(it.format).toUpperCase() : '', it.note ? '备注：' + it.note : ''];
        },
      };
      if (!Wb.lightbox.cfg) Wb.lightbox.init(lbCfg);
      Wb.lightbox.use('favorites.html', { lb: lbCfg, detail: detailCfg });
      Wb.pager.sentinel(gridEnd.value, () => {
        if (!pager.morePage()) return;        // 已经全放开了：别再重画一次
        pagerTick.value++;
        render();
      });
    }

    onMounted(async () => {
      try {
        await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
      } catch (e) {
        failed.value = '公共模块没有加载起来：' + errText(e);
        if (window.PageReport) PageReport.pageFail('收藏', failed.value, e);
        return;
      }
      if (!window.Wb || !window.Fav || !window.AssetLocal) {
        failed.value = '收藏依赖的公共模块没有就绪（workbench.js / assetlib.js）';
        if (window.PageReport) PageReport.pageFail('收藏', failed.value);
        return;
      }
      ready.value = true;
      /* 模板里那些静态 `<span data-icon>`（页头铭牌那颗星）：ui.js 的 fillIcons 只在外壳
         DOMContentLoaded 跑过一次，那时本页还没挂载 —— 不在这里补一遍，页头图标是空的。 */
      await nextTick();
      if (rootEl.value) window.fillIcons(rootEl.value);
      /* 网格 / 分页行是 v-else 分支，要等这一帧渲染完才存在；
         在这里 initWb 拿到的是 null，视图开关会静默不创建。 */
      await nextTick();
      bindKindFilter();
      bindFavToolbar();
      initWb();
      window.addEventListener('fav-change', onFavChange);
      offStorage = window.StorageBus.on(['fav_items'], onStorage);
      /* 拖文件进窗口 = 上传：登记在 document 上，页面切走时摘掉。 */
      document.addEventListener('dragover', onDragOver);
      document.addEventListener('dragleave', onDragLeave);
      document.addEventListener('drop', onDrop);
      /* 窗口变宽变窄：紧凑档的行分组要重算（一行几格变了，带子的落点也跟着变）。 */
      window.addEventListener('resize', onFavResize);
      document.addEventListener('keydown', onFavKey);
      await render();
      Wb.thumbs.hydrate().then(n => { if (n) render(); }).catch(() => {});
      Fav.refillPrompts(() => {
        /* 提示词补全只换卡片上那一行标题，不整表重画（正在敲的备注框不能被打断）。 */
        const map = new Map(Fav.list().map(x => [x.key, x]));
        if (!grids.value) return;
        grids.value.querySelectorAll('.card[data-key]').forEach(card => {
          const it = map.get(card.dataset.key);
          const t = it && card.querySelector('.t');
          if (t) t.textContent = it.prompt || it.name || '(无描述)';
        });
      });
    });

    onBeforeUnmount(() => {
      window.removeEventListener('fav-change', onFavChange);
      if (offStorage) { offStorage(); offStorage = null; }
      window.removeEventListener('resize', onFavResize);
      document.removeEventListener('keydown', onFavKey);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      if (toolbarFb) { toolbarFb.destroy(); toolbarFb = null; }
      for (const t of noteTimers.values()) clearTimeout(t);
      noteTimers.clear();
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      ready, failed, q, filter, viewItems, cntText, favTotal, pagerVisible, aiText, emptyWhy,
      uploadHtml, uploading, fileEl, rootEl,
      pullBtn, grids, toolbarEl, kindEl, viewEl, favProvEl, favTimeEl, gridEnd, pagerRow,
      dlBusy, dlMsg, pageItems, titleOf, metaOf, thumbHtml, openLb, onNote, flushNote,
      dropItem, download, reuse, canReuse, reuseTabZh, pullLocal, pickFiles, onFiles,
      /* 多选 */
      multiMode, openKey, favPicked, togglePick, onPickKey,
      bulkCountText, bulkAllText, bulkAllDisabled, bulkDownDisabled, bulkTipText, bulkFavRemoveDisabled,
      toggleMulti: () => favMulti().setMode(!multiMode.value),
      exitMulti: () => favMulti().setMode(false),
      bulkAll: () => { favMulti().setAll(); paintFavBulkBar(); },
      bulkClear: () => { favMulti().clear(); paintFavBulkBar(); },
      bulkDownload, bulkDrop,
      /* 详情（就地展开） */
      toggleFavDetail, closeDetail, bandItem, rows, view,
      onCardDragStart, onCardDragEnd,
      runAiFind, clearAiPick,
      aiBtnHtml: (window.icon ? icon('sparkles', 14) : '') + ' AI 找素材',
    };
  },
  render,
};
