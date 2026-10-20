/* 我的收藏 —— 第一个迁到 Vue 的页面。
   数据与副作用全部走已有的公共层（Fav / Wb / AssetLocal / AiFind / Chips / AiChip），
   组件只负责「这一屏长什么样」；分页、灯箱、详情、缩略图缓存仍是全站那一份实现。 */
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, inject, watch } from '../../vue.runtime.esm-browser.prod.js';
import { LocalBadge } from '../ui/index.js';
import { render } from '../render/favorites.js';

/* 页面样式跟着页面组件走：第一次打开这一页才挂，切页不重复插。 */
(function ensureCss() {
  if (document.querySelector('link[href$="spa-pages.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'web/styles/spa-pages.css';
  document.head.appendChild(l);
})();

const PAGE_MODE = window.pageModeOf('favorites');
const PAGE_SIZE = window.pageSizeOf('favorites');
const TYPES = [['all', '全部'], ['图片', '图片'], ['视频', '视频'], ['音频', '音频'], ['文件', '其它']];

export default {
  name: 'FavoritesView',
  components: { LocalBadge },
  setup() {
    const activeFile = inject('spaActiveFile', null);
    /* 前台判据只有公共层那一份：core/activity.js（外壳挂在 window.__spaActivity）。
       这里原来自己读 `spaActiveFile`：那只说明「路由选中的是这一页」，整个标签页切到后台时
       它照样为真，于是看不见的收藏页还在接拖拽、还在处理快捷键。 */
    const isActive = () => window.__spaActivity.visible('favorites.html');
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
    const healNote = ref('');
    const pagerTick = ref(0);
    const pagerVisible = ref(false);
    const aiText = ref('');
    const uploadHtml = ref((window.icon ? icon('upload', 13) : '') + ' 上传本地文件');
    const uploading = ref(false);
    const pullBtn = ref(null);
    const grids = ref(null);
    const chipsEl = ref(null);
    const aiBtn = ref(null);
    const aiChipEl = ref(null);
    const viewEl = ref(null);
    const fileEl = ref(null);
    const gridEnd = ref(null);
    const pagerRow = ref(null);
    const qEl = ref(null);
    const dlBusy = reactive({});
    const dlMsg = reactive({});
    const noteTimers = new Map();

    const urlMap = new Map();
    let pager = null;
    let viewToggle = null;
    let renderSeq = 0;
    let aiPick = null;
    let aiRank = null;
    let aiWhy = '';

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

    function paintChips() {
      if (!chipsEl.value) return;
      const items = Fav.list();
      window.Chips.render(chipsEl.value, TYPES, filter.value, v => {
        filter.value = v;
        resetPaging();
        render();
      }, { count: v => items.filter(x => byType(x, v)).length });
    }

    function paintAiChip() {
      if (!aiChipEl.value) return;
      window.AiChip.paint(aiChipEl.value, {
        text: aiPick ? window.AiChip.picked(aiPick.size, aiWhy) : '',
        clearId: 'favAiClear',
        onClear: clearAiPick,
      });
    }

    function clearAiPick() { window.AiFind.clear(AI); }

    function thumbHtml(it) {
      const kind = favKind(it);
      if (kind === 'audio') {
        return '<div class="audio">' + (window.icon ? icon('mic', 26) : '') + '<span>'
          + window.esc(window.fileExtOf(it).toUpperCase()) + (it.duration ? ' · ' + it.duration + 's' : '') + '</span></div>';
      }
      const url = urls.value[it.key] || '';
      if (!url) return '';
      const tkey = it.kind === 'local' && it.fileKey ? 'fav-file:' + it.fileKey : url;
      return kind === 'video'
        ? Wb.thumbs.mediaHTML(url, { key: tkey })
        : Wb.thumbs.mediaHTML(url, { key: tkey, type: 'image', mediaAttrs: 'loading="lazy"' });
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
    const metaOf = it => [
      it.kind === 'local' ? '本地文件' : (it.providerName || '资产库'),
      it.type,
      it.format ? String(it.format).toUpperCase() : '',
      it.size ? fmtSize(it.size) : '',
      it.duration ? it.duration + 's' : '',
    ].filter(Boolean).join(' · ');
    /* 与资产库同一颗开关、同一套说法：本机 / 云端 / 两者都有。徽标本身只有 ui/LocalBadge 一份。 */
    const badgeShow = () => {
      const AL = window.AssetLocal;
      return !!(AL && AL.showBadge && AL.showBadge());
    };
    const badgeState = it => {
      const AL = window.AssetLocal;
      if (!AL || !AL.stateOf) return {};
      try { return AL.stateOf(it); } catch (e) { return {}; }
    };

    function paintPullBtn() {
      if (!pullBtn.value) return;
      AssetLocal.pullBtn(pullBtn.value, pullScope().length, { what: '收藏', more: '本地上传的那一批不算。' });
    }

    function pullScope() {
      const seen = new Set();
      const AL = window.AssetLocal;
      return viewItems.value.filter(it => {
        if (it.kind === 'local') return false;
        if (!it.key || seen.has(it.key)) return false;
        seen.add(it.key);
        return !(AL && AL.hasLocal ? AL.hasLocal(it) : AL.hasLocalAddr(it.src || it.dl || ''));
      });
    }

    async function pullLocal() {
      const todo = pullScope();
      const btn = pullBtn.value;
      if (!todo.length) {
        /* 守卫型的这一句要用 warn 档：安静档吞掉 ok/info 之后，按钮看起来就是「坏了」——
           「你点了，但事实没发生」正是必须看见的那一类。 */
        Toast.warn(viewItems.value.some(x => x.kind !== 'local')
          ? '这一屏要存的本机都已经有了（本地上传的那一批不算，它的字节本来就在浏览器里）'
          : '这一屏只有本地上传的文件，字节本来就在浏览器里，不用存');
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

    async function render() {
      if (!ready.value) return;
      const seq = ++renderSeq;
      paintChips();
      paintAiChip();
      viewToggle && viewToggle.apply();
      const query = q.value.trim();
      const items = orderItems((query ? Fav.search(query) : Fav.list())
        .filter(x => byType(x, filter.value) && (!aiPick || aiPick.has(x.key))));
      viewItems.value = items;
      if (items.length) emptyWhy.value = '';
      else if (query) emptyWhy.value = '没有匹配「' + query + '」的收藏：换个词，或清空搜索框看全部。';
      else if (aiPick) emptyWhy.value = 'AI 挑的这一批里没有收藏：点掉上面那枚条件芯片，或重新挑一次。';
      else if (filter.value !== 'all') emptyWhy.value = '这个筛选条件下没有收藏：把芯片切回「全部」就能看到。';
      else emptyWhy.value = '还没有收藏。去「资产库」点卡片上的 ☆，或点右上角「上传本地文件」。';
      paintPullBtn();
      cntText.value = items.length ? '共 ' + items.length + ' 项' : '';
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
      resignSome(shown, seq).catch(e => console.warn('[fav] 过期回源失败', e));
    }

    async function resignSome(items, seq) {
      const staleN = items.filter(it => Fav.expired(it.src || it.dl || '')).length;
      if (!staleN) { healNote.value = ''; return; }
      const done = await Fav.resignSome(items, (it, nextUrl) => {
        if (seq !== renderSeq) return;
        urls.value = { ...urls.value, [it.key]: nextUrl };
        urlMap.set(it.key, nextUrl);
        nextTick(bindThumbs);
      });
      if (seq !== renderSeq) return;
      const left = Math.max(0, staleN - (Number(done) || 0));
      healNote.value = left ? '还有 ' + left + ' 条过期的图这次没换回来（下次打开会再试）' : '';
    }

    function openLb(it) { Wb.lightbox.open(it); }

    function onSearch() {
      clearTimeout(onSearch.t);
      onSearch.t = setTimeout(() => { resetPaging(); render(); }, 250);
    }
    onSearch.t = 0;

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
        title: '移出收藏？', danger: true, okLabel: '移出',
        body: isLocal ? '这是本地上传的文件，移出后文件本体也会从浏览器里删除，不可恢复。' : '只从「我的收藏」移出，资产库里的素材不受影响。',
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

    function pickFiles() { if (!uploading.value) fileEl.value && fileEl.value.click(); }

    async function addFiles(files) {
      const list = [...(files || [])];
      if (!list.length) return;
      uploading.value = true;
      uploadHtml.value = '正在保存…';
      let ok = 0; const fail = [];
      for (const f of list) {
        try { await Fav.addLocalFile(f); ok++; }
        catch (err) { fail.push((f && f.name ? f.name : '文件') + '：' + err.message); }
      }
      if (fail.length) Toast.err(`有 ${fail.length} 个文件没能加入收藏：` + fail.slice(0, 3).join('；') + (fail.length > 3 ? ' 等' : ''));
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
      btn: () => aiBtn.value,
      ask: () => q.value,
      focus: () => qEl.value && qEl.value.focus(),
      emptyMsg: '还没有收藏：在各工作台产物上点 ☆，或用右边的「上传本地文件」',
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
      onPick: () => { q.value = ''; filter.value = 'all'; },
      done: () => { resetPaging(); render(); },
      say: t => { cntText.value = t; },
    };

    function runAiFind() { window.AiFind.run(AI); }

    function onFavChange() { render(); }
    function onStorage(e) { if (!e.key || e.key === 'fav_items') render(); }

    function initWb() {
      pager = Wb.pager.create({
        mode: PAGE_MODE, pageSize: PAGE_SIZE, localMore: true,
        items: () => viewItems.value,
        render: () => { pagerTick.value++; },
      });
      pager.bindButtons();
      viewToggle = Wb.viewToggle.create({ el: viewEl.value, key: 'dir_fav_view', target: grids.value });
      /* 灯箱与详情全站只有**一份**：init 只做一次（它会挂全局键盘监听，多挂一份方向键就一次翻
         两页），配置向公共层登记「收藏这一页要这两份」，切回本页时由 spa:page 装回自己那一份。
         以前这里只在挂载时 init 一遍、走了不归还 —— 先去资产库再回收藏，翻页用的还是资产库那份 list。 */
      const detailCfg = {
        prompt: it => it.prompt || it.name || '',
        status: it => (it.kind === 'local' ? '本地文件' : '已收藏'),
        rows: it => [
          ['来源', it.kind === 'local' ? '本地上传' : (it.providerName || '资产库')],
          ['类型', it.type],
          ['格式', it.format ? String(it.format).toUpperCase() : ''],
          ['大小', it.size ? fmtSize(it.size) : ''],
          ['时长', it.duration ? it.duration + 's' : ''],
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
      /* 网格 / 分页行是 v-else 分支，要等这一帧渲染完才存在；
         在这里 initWb 拿到的是 null，视图开关会静默不创建。 */
      await nextTick();
      initWb();
      window.addEventListener('fav-change', onFavChange);
      window.addEventListener('storage', onStorage);
      document.addEventListener('dragover', onDragOver);
      document.addEventListener('dragleave', onDragLeave);
      document.addEventListener('drop', onDrop);
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
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      for (const t of noteTimers.values()) clearTimeout(t);
      noteTimers.clear();
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      ready, failed, q, filter, viewItems, cntText, healNote, pagerVisible, aiText, emptyWhy,
      uploadHtml, uploading, pullBtn, grids, chipsEl, aiBtn, aiChipEl, viewEl, fileEl, gridEnd, pagerRow, qEl,
      dlBusy, dlMsg, pageItems, titleOf, metaOf, badgeState, badgeShow, thumbHtml, openLb, onSearch, onNote, flushNote,
      dropItem, download, reuse, canReuse, reuseTabZh, pickFiles, onFiles, pullLocal,
      runAiFind, clearAiPick, starIcon: window.icon ? icon('star', 20) : '',
      aiBtnHtml: (window.icon ? icon('sparkles', 14) : '') + ' AI 找素材',
    };
  },
  render,
};
