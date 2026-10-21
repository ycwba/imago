/* 自由画布：项目库 + 工程页在同一路由组件内切换（#canvas.html[?id=]）。
   文档与操作全在 web/domain/canvas/（纯模块，不挂 window）；这一页只做接线：
   存储、撤销栈、生成任务、检查器与助手桥。表面的拖动/缩放/连线在 view.js。 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount, inject, watch } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/canvas.js';
import { newDoc, newNode, indexRecord, docSummary, findNode, exportDoc, importDoc, LIMITS, uid } from '../domain/canvas/doc.js';
import { applyOperations } from '../domain/canvas/ops.js';
import { createHistory } from '../domain/canvas/history.js';
import { createMenu, labelOf, NODE_TYPES, MEDIA_KINDS } from '../domain/canvas/registry.js';
import { fitViewport } from '../domain/canvas/spatial.js';
import { createSurface } from '../domain/canvas/view.js';
import * as gen from '../domain/canvas/gen.js';
import { ensureCss } from '../core/page-css.js';

ensureCss('web/styles/spa-canvas.css', 'spa-canvas');

const INDEX = 'canvas_index';
const SAVE_MS = 900;
const DROP_MAX = 40 * 1024 * 1024;
const ic = (n, s) => (typeof window !== 'undefined' && window.icon ? window.icon(n, s || 16) : '');
const E = s => (typeof window !== 'undefined' && window.esc ? window.esc(s) : String(s == null ? '' : s));

export default {
  name: 'CanvasView',
  setup() {
    const route = inject('spaRoute', null);
    /* 前台判据只有公共层那一份：core/activity.js（外壳挂在 window.__spaActivity）。
       这里原来自己读 `spaActiveFile`：那只说明「路由选中的是这一页」，整个标签页切到后台时
       它照样为真，于是隐藏着的画布还在轮询任务、还在处理快捷键。 */
    const PAGE_FILE = 'canvas.html';
    const isActive = window.__spaActivity.forPage(PAGE_FILE);

    const stage = ref(null), layer = ref(null), edges = ref(null), mini = ref(null);
    const libBox = ref(null), libFilterEl = ref(null), inspBody = ref(null), pageEl = ref(null);

    const ready = ref(false), failed = ref('');
    const docId = ref(''), title = ref(''), revision = ref(0);
    const saveText = ref(''), saveKind = ref('');
    const q = ref(''), sort = ref('up'), libCount = ref('');
    const tool = ref('select'), grid = ref(true), showEdges = ref(true), inspOpen = ref(false);
    const selCount = ref(0), canUndo = ref(false), canRedo = ref(false);
    const zoomText = ref('100%'), undoTitle = ref('撤销（Ctrl+Z）'), redoTitle = ref('重做（Ctrl+Y）');

    /* 页面私有的非响应式状态：文档与 DOM 缓存每分钟被摸很多次，
       放进 ref 只会让 Vue 跟着建一堆代理，界面上一个字段都不显示它们。 */
    const S = { doc: null, surface: null, hist: createHistory({ max: 50 }), cards: null,
      docs: new Map(), index: new Map(), pending: [], poller: null, saveTimer: 0,
      dirty: false, inspNext: '', busy: new Set(), loaded: false, seq: 0 };

    const notify = (t, k) => { if (window.Toast) Toast.receipt(t, k || 'info'); else if (k === 'err') console.warn(t); };
    const kv = () => window.Kv.at('canvasDocs');
    /* 一个节点「能被搜到」的文字只在这里列一次：页面 Ctrl+F、项目库检索与助手的画布搜索读同一份。
       产物号也进去 —— 用户和模型都会拿着 `la_xxx` 直接搜。 */
    const hay = n => {
      const m = (n && n.metadata) || {};
      return [n.title, m.content, m.prompt, m.assetId, m.sourceAssetId, labelOf(n.type)].filter(Boolean).join(' ');
    };

    /* ---------- 提交：所有写动作的唯一出口 ---------- */
    function commit(ops, meta = {}) {
      const res = applyOperations(S.doc, ops, { expectedRevision: meta.expectedRevision });
      if (!res.ok) {
        if (!meta.quiet) notify(res.reason + (res.code === 'revision_mismatch' ? '' : ''), 'err');
        return res;
      }
      const prev = S.doc;
      S.doc = res.doc;
      if (!res.viewOnly) {
        S.hist.push(prev, res.doc, res.changed, { label: meta.label || '', source: meta.source, operationId: meta.operationId });
        if (S.surface) S.surface.sync(res.changed);
        markDirty();
      } else {
        /* 平移与缩放不涨修订、不进撤销栈，但照样要落盘：否则一刷新就弹回原地。
           这里单独排一个更长的防抖，不跟滚轮抢写入。 */
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(() => saveNow(), 2500);
      }
      if (meta.after) meta.after(res);
      refresh();
      return res;
    }
    function refresh() {
      title.value = S.doc ? S.doc.title : '';
      revision.value = S.doc ? S.doc.revision : 0;
      const s = S.hist.depth();
      canUndo.value = S.hist.canUndo(); canRedo.value = S.hist.canRedo();
      undoTitle.value = '撤销：' + (S.hist.undoLabel() || '上一步') + '（Ctrl+Z · 还有 ' + (s.cursor - s.baseline) + ' 层）';
      redoTitle.value = '重做：' + (S.hist.redoLabel() || '下一步') + '（Ctrl+Y）';
      selCount.value = S.doc && S.doc.selection ? S.doc.selection.length : 0;
      if (S.surface) zoomText.value = Math.round(S.surface.viewport.scale * 100) + '%';
    }
    function markDirty() {
      S.dirty = true;
      saveText.value = '有改动没落盘'; saveKind.value = 'wait';
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(() => saveNow(), SAVE_MS);
    }
    function savedAt(at) { saveText.value = '已存本机 · ' + window.fmtWhen(at); saveKind.value = 'ok'; }
    async function saveNow() {
      clearTimeout(S.saveTimer);
      /* 开头就把要存的那一份抓住：这条是 await 一路走到 IndexedDB 的，期间用户完全可以
         切走（back → openDoc 另一份）。不抓住的话，后半段读到的 S.doc 是**新**那一份，
         于是「存旧的那一份」这一步实际写进了新文档，而 S.dirty 已经被清成 false ——
         旧文档那些还没落盘的改动就此丢掉。 */
      const doc = S.doc;
      if (!doc) return true;
      const at = Date.now();
      try {
        await kv().put(doc.id, doc);
        S.docs.set(doc.id, doc);
        const rec = indexRecord(doc, S.index.get(doc.id));
        S.index.set(rec.id, rec);
        const okw = window.Store.write(INDEX, [...S.index.values()], { cap: 400, label: '画布项目' });
        if (okw && okw.ok === false) throw new Error(okw.error || '本机存不下了');
        /* 挤出上限要照实说：不报的话，第 401 份画布刷新后就再也找不到，而界面上一切正常。 */
        if (okw && okw.dropped) notify('项目索引只留最近 400 份，挤掉了 ' + okw.dropped + ' 条列表记录（画布本身还在，导入/新建会重新出现）', 'warn');
        /* 只在「还在存的那一份面前」时才报存好了：这一趟 await 期间用户已经切到别的画布，
           就把别人的 S.dirty 清了、状态行写成别人的时间 —— 表现是「刚改的东西它说没改」。 */
        if (S.doc === doc) { S.dirty = false; savedAt(at); }
        if (!docId.value) paintLib();
        return true;
      } catch (e) {
        saveText.value = '没存上：' + errText(e); saveKind.value = 'bad';
        notify('这份画布没存上：' + errText(e), 'err');
        return false;
      }
    }

    /* ---------- 项目库 ---------- */
    async function loadLib() {
      const idx = window.Store.read(INDEX, []) || [];
      S.index = new Map((Array.isArray(idx) ? idx : []).map(r => [r.id, r]));
      let all = [];
      try { all = await kv().all(); } catch (e) { all = []; failed.value = '本机的画布读不出来：' + errText(e); if (window.PageReport) PageReport.pageFail('画布', failed.value, e); }
      S.docs = new Map((all || []).map(d => [d.id, d]));
      for (const d of S.docs.values()) if (!S.index.has(d.id)) S.index.set(d.id, indexRecord(d));
      S.loaded = true;
      refresh();
      paintLib();
    }
    function libItems() {
      const text = q.value.trim().toLowerCase();
      const list = [...S.index.values()].filter(r => S.docs.has(r.id) || !S.loaded);
      const hit = r => {
        if (!text) return true;
        if ((r.title || '').toLowerCase().includes(text)) return true;
        const d = S.docs.get(r.id);
        if (!d) return false;
        return (d.nodes || []).some(n => hay(n).toLowerCase().includes(text));
      };
      const out = list.filter(hit);
      const k = sort.value;
      out.sort((a, b) => (k === 'new' ? (b.createdAt || 0) - (a.createdAt || 0)
        : k === 'title' ? String(a.title || '').localeCompare(String(b.title || ''), 'zh' /* 按标题排 */)
          : (b.updatedAt || 0) - (a.updatedAt || 0)));
      return out;
    }
    function cardHTML(r) {
      const d = S.docs.get(r.id);
      const types = d ? Object.entries((d.nodes || []).reduce((a, n) => (a[n.type] = (a[n.type] || 0) + 1, a), {}))
        .map(([t, n]) => labelOf(t) + ' ' + n).slice(0, 3).join(' · ') : '';
      return '<div class="cv-card-t">' + E(r.title || '未命名画布') + '</div>'
        + '<div class="cv-card-m">' + (r.nodeCount || 0) + ' 个节点' + (types ? ' · ' + E(types) : '') + '</div>'
        + '<div class="cv-card-m">改了 ' + E(window.fmtWhen(r.updatedAt || Date.now())) + '</div>'
        + '<div class="acts">' + window.Wb.actsHTML(r, {
          attr: 'data-x',
          items: [
            { act: 'open', label: '打开', mini: true }, { act: 'ren', label: '改名', mini: true },
            { act: 'exp', label: '导出', mini: true }, { act: 'del', label: '删除', mini: true, danger: true },
          ],
        }) + '</div>';
    }
    /* 库头的搜索 / 排序 / 计数由公共 Wb.filterBar 生成（只此一份）。
       它挂在 `v-if="!docId"` 里：从工程页返回时宿主是新建的另一只节点，得重接一份。
       搜索要同步回调（searchDelay: 0）：库是本地索引，输入一个字符就该立刻变，没有等待的理由。 */
    let libFb = null;
    function ensureLibFilter() {
      const host = libFilterEl.value;
      if (!host) return;
      if (libFb && libFb.el === host && host.firstChild) return;
      if (libFb) libFb.destroy();
      libFb = window.Wb.filterBar.bind(host, {
        cls: '', chips: null,
        inputClass: 'cv-q', placeholder: '搜索画布标题或正文', ariaLabel: '搜索画布',
        q: q.value, searchDelay: 0,
        onSearch: v => { q.value = v; paintLib(); },
        extraHTML: '<select class="cv-sort" aria-label="排序方式">'
          + '<option value="up">最近修改</option><option value="new">最近创建</option><option value="title">按标题</option></select>',
        cntClass: 'cv-count', cntText: libCount.value,
      });
      const sel = libFb.el.querySelector('.cv-sort');
      if (sel) {
        sel.value = sort.value;
        sel.addEventListener('change', () => { sort.value = sel.value; paintLib(); });
      }
      try { if (window.Dropdowns) Dropdowns.build(host); } catch (e) { /* 包装失败只少一层下拉外观，搜索与排序本身不依赖它 */ }
    }
    function paintLib() {
      if (!libBox.value) return;
      const items = libItems();
      libCount.value = items.length + ' 份' + (q.value.trim() ? '（搜「' + q.value.trim() + '」）' : '（本机）');
      ensureLibFilter();
      if (libFb) libFb.setCount(libCount.value);
      /* 库这一片挂在 v-if 上：从工程页回来时 `.cv-grid` 是重新建出来的另一只节点，而 Wb.cards
         认的还是它第一次拿到的那只（此时已从文档里摘走）。继续往旧盒子里画，屏幕上的库就永远是空的
         —— 盒子换了要重接一份，别把旧的那份留着。 */
      if (S.cards && S.cards.box !== libBox.value) S.cards = null;
      if (!S.cards) {
        S.cards = window.Wb.cards.create({
          box: libBox.value,
          keyOf: r => r.id,
          sigOf: r => (r.title || '') + '|' + (r.nodeCount || 0) + '|' + (r.updatedAt || 0),
          htmlOf: cardHTML,
          emptyHTML: () => window.Wb.emptyHTML(q.value.trim() ? '没有对得上的画布' : '还没有画布 —— 右上「新建画布」，或「导入」一份别人给的 JSON'),
        });
        libBox.value.addEventListener('click', async ev => {
          const btn = ev.target.closest('[data-x]'); const el = ev.target.closest('.task');
          if (!el) return;
          const id = el.dataset.tkey, r = S.index.get(id);
          if (!r) return;
          const x = btn ? btn.dataset.x : 'open';
          if (x === 'open') await openDoc(id);
          else if (x === 'ren') await renameRec(r);
          else if (x === 'exp') await exportOne(r);
          else if (x === 'del') await delOne(r);
        });
      }
      S.cards.paint(items);
    }
    async function renameRec(r) {
      const v = await window.PromptForm.open({ title: '改画布名', okLabel: '存下来', fields: [{ key: 't', label: '标题', value: r.title, required: true }] });
      if (!v || !String(v.t || '').trim()) return;
      const d = S.docs.get(r.id);
      if (!d) { paintLib(); return; }
      const before = { title: d.title, updatedAt: d.updatedAt };
      d.title = String(v.t).slice(0, LIMITS.title); d.updatedAt = Date.now();
      /* 改不落盘就得改回来：内存里那份是列表与画布头共用的同一个对象，
         留着新标题就等于「界面上已经是新名字，磁盘上还是旧的」。 */
      if (!await saveOne(d)) Object.assign(d, before);
      paintLib();
    }
    async function saveOne(d) {
      /* 写不进去必须当场说，并且让调用方知道（返回布尔）：新建/导入这两条路接下来就把 S.doc
         换成这一份，配额满时 IndexedDB 的 put 是 reject 而不是返回坏值 —— 以前这里没有 catch，
         Promise 一路冒到全局，界面上照常切进了那份画布，用户以为存好了，关掉标签就什么都没剩下。 */
      try {
        await kv().put(d.id, d);
      } catch (e) {
        notify('这份画布没存进本机：' + errText(e), 'err');
        return false;
      }
      S.docs.set(d.id, d);
      const rec = indexRecord(d, S.index.get(d.id));
      S.index.set(rec.id, rec);
      const okw = window.Store.write(INDEX, [...S.index.values()], { cap: 400, label: '画布项目' });
      if (okw && okw.ok === false) { notify('列表索引没存上：' + (okw.error || '本机存不下了'), 'err'); return false; }
      if (okw && okw.dropped) notify('项目索引只留最近 400 份，挤掉了 ' + okw.dropped + ' 条列表记录（画布本身还在，导入/新建会重新出现）', 'warn');
      return true;
    }
    async function exportOne(r) {
      const d = S.docs.get(r.id) || await kv().get(r.id);
      if (!d) return notify('这份画布读不出来', 'err');
      const x = exportDoc(d);
      if (!x.ok) return notify(x.why, 'err');
      download((d.title || '画布') + '.wbcanvas.json', x.text, 'application/json');
    }
    async function delOne(r) {
      const c = await window.Confirm.ask({ title: '删掉这份画布', body: '「' + (r.title || '未命名') + '」的节点与连线会一起删。字节仍在资产库，不跟着走。', danger: true, okLabel: '删除' });
      if (!c) return;
      try { await kv().del(r.id); } catch (e) { return notify('删不掉：' + errText(e), 'err'); }
      S.docs.delete(r.id); S.index.delete(r.id);
      window.Store.write(INDEX, [...S.index.values()], { cap: 400, label: '画布项目' });
      notify('已删除「' + (r.title || '未命名') + '」', 'ok');
      paintLib();
    }
    function download(name, text, mime) {
      const b = new Blob([text], { type: mime || 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }

    /* ---------- 开文档 ---------- */
    /* 地址栏要跟着这份画布走：appShow 第二参不传就只换视图不写 hash，
       刷新会掉回项目库，用户刚建/刚打开的那份得重新点一次。 */
    function syncHash(id) {
      const want = 'canvas.html' + (id ? '?id=' + encodeURIComponent(id) : '');
      const cur = window.__spaRoute && window.__spaRoute();
      if (!window.appShow || (cur && cur.src === want)) return;
      window.appShow(want, true);
    }
    /* 开一份画布要等 IndexedDB 回话，而用户会连点（「返回项目库」之后再点进来也算连点），
       这些回话**到达的顺序不保证**：慢的那一份后到，就把用户当前正在看的画布覆盖成旧的，
       顺手把地址栏也改回那一份的 id —— 表现是「画布自己跳回去了」。
       序号只认最后按下的那一个，迟到的回话整份丢弃（连 DOM 都不重画）。 */
    let openSeq = 0;
    async function openDoc(id) {
      const seq = ++openSeq;
      if (!id) {
        docId.value = ''; S.doc = null; teardownSurface(); refresh(); syncHash('');
        /* 库那一块挂在 v-if="!docId" 上：docId 刚清空时 DOM 还没换过来，libBox 这个 ref 仍指着一块空位，
           这时 paintLib 只会原地退出 —— 于是「返回项目库」看见一片空白，卡片其实早就在数据里。 */
        await nextTick();
        if (seq !== openSeq) return;
        paintLib();
        /* 库与工程页共用同一份模板、各挂一半在 v-if 上：刚换回来的库头图标还没填，
           排序下拉也是新建的节点 —— 这两件事都在这一趟补。 */
        if (pageEl.value) window.fillIcons(pageEl.value);
        try { if (window.Dropdowns && pageEl.value) Dropdowns.build(pageEl.value); } catch (e) {}
        return;
      }
      let d = S.docs.get(id) || await kv().get(id);
      if (seq !== openSeq) return;                     // 用户已经去看别的画布了：这一份迟到结果不许再动状态
      if (!d) { notify('没有这份画布（可能刚被删掉）', 'err'); goLib(); return; }
      d.selection = [];
      S.doc = d; docId.value = id; S.hist.clear();
      savedAt(d.updatedAt || Date.now());
      await nextTick();
      if (seq !== openSeq) return;
      /* 工程页那一半 DOM 是这一刻才建的：页头返回键与工具栏上的图标只在这趟填。 */
      if (pageEl.value) window.fillIcons(pageEl.value);
      buildSurface();
      refresh();
      syncHash(id);
    }
    function goLib() { syncHash(''); }
    function routeId() {
      const r = window.__spaRoute && window.__spaRoute();
      const m = /[?&]id=([^&]+)/.exec((r && r.query) || '');
      return m ? decodeURIComponent(m[1]) : '';
    }
    async function newDocNow() {
      const v = await window.PromptForm.open({ title: '新建画布', okLabel: '建好并打开',
        fields: [{ key: 't', label: '标题', value: '未命名画布', placeholder: '给这份画布起个名', required: true }] });
      if (!v) return;
      const d = newDoc({ title: String(v.t || '').trim() || '未命名画布', id: uid('cv_') });
      d.nodes = [newNode({ type: 'text', x: 120, y: 120, metadata: { content: '' } })];
      /* 先存后切：存不进去就停在原地 —— 切过去的那一份只活在内存里，
         用户在这份上做的每一步都会随着关标签消失，而状态行一直显示「已存本机」。 */
      if (!await saveOne(d)) return;
      S.doc = d; docId.value = d.id; S.hist.clear(); S.dirty = false;
      /* 建好就落了一次盘，状态行要说「已存本机」—— 不报的话，用户以为新建那份还在内存里，
         会习惯性再按一次 Ctrl+S（saveOne 走的不是 saveNow，这一句只能在这里补）。 */
      savedAt(d.updatedAt || Date.now());
      await nextTick(); buildSurface(); refresh();
      /* 新建后整半页 DOM 刚建出来（与 openDoc 同一条路）。 */
      if (pageEl.value) window.fillIcons(pageEl.value);
      syncHash(d.id);
    }
    async function doImport() {
      const text = await pickFile();
      if (!text) return;
      const r = importDoc(text);
      if (!r.ok) return notify('这份文件读不进去：' + r.why, 'err');
      const d = r.doc;
      d.id = uid('cv_'); d.revision = 0; d.updatedAt = Date.now();
      /* 顺序：先把手上那份落盘（「离开就先存」的旧例），再写导入的这份，最后才切过去。
         原来先写导入、后存手上 —— 手上那份存不上时会停在原地，可磁盘里已经多出一份用户
         没打算留下的画布；而导入那份写失败时照样弹「导入好了」，切过去的是内存里的一份，
         关标签就没了。两处都反过来了：任何一步没成，界面就停在原地并说明哪一步没成。 */
      if (docId.value && S.dirty && !(await saveNow())) return;
      if (!await saveOne(d)) return;
      notify('导入好了：' + d.title + '（' + d.nodes.length + ' 个节点）', 'ok');
      /* 导入完要把用户带到他刚导进来的那一份面前。ok 档的提示默认被安静档压住，若还停在原来那份
         画布上，点「导入」之后屏幕一个字都不变 —— 看着就像这颗按钮没生效。 */
      await openDoc(d.id);
    }
    /* 这颗入口要挂在页面根下（挪到屏幕外，不 display:none，否则有些内核连对话框都不给弹）：
       脱离 DOM 的 input 在文件选到一半时可能被回收，页面上也留不下一个可寻址的导入落点。
       一次只留一颗：上一次没选成的先摘掉。 */
    function pickFile() {
      return new Promise(res => {
        const host = pageEl.value || document.body;
        host.querySelectorAll('.cv-file').forEach(x => x.remove());
        const i = document.createElement('input');
        i.type = 'file'; i.accept = '.json,application/json'; i.className = 'cv-file';
        host.appendChild(i);
        const done = v => { i.remove(); res(v); };
        i.onchange = () => {
          const f = i.files && i.files[0];
          if (!f) return done('');
          const fr = new FileReader();
          fr.onload = () => done(String(fr.result || ''));
          fr.onerror = () => done('');
          fr.readAsText(f);
        };
        i.click();
      });
    }
    async function doExport() {
      if (!S.doc) return;
      const x = exportDoc(S.doc);
      if (!x.ok) return notify(x.why, 'err');
      download((S.doc.title || '画布') + '.wbcanvas.json', x.text, 'application/json');
      notify('已导出这份画布（不含密钥与媒体字节）', 'ok');
    }

    /* ---------- 表面接线 ---------- */
    function buildSurface() {
      if (!stage.value || !layer.value) return;
      teardownSurface();
      S.surface = createSurface({
        stage: stage.value, layer: layer.value, edges: edges.value, mini: mini.value,
        getDoc: () => S.doc, commit, isActive,
        notify,
        onSelect: ids => { if (S.doc) S.doc.selection = ids; selCount.value = ids.length; if (ids.length === 1) showInspector(findNode(S.doc, ids[0])); else if (!ids.length) inspOpen.value = false; },
        onInspect: n => showInspector(n),
        onRun: n => runNode(n),
        onNodeMenu: (n, x, y) => nodeMenu(n, x, y),
        onAddAt: (kind, pt) => addAt(kind, pt),
        onDropFiles: (files, pt) => dropFiles(files, pt),
      });
      S.surface.mount(S.doc);
      S.surface.setTool(tool.value);
      S.surface.setGrid(grid.value);
      refresh();
    }
    function teardownSurface() { if (S.surface) { S.surface.destroy(); S.surface = null; } }

    /* ---------- 加节点：两种入口（注册表类型 / 资产库里的一条素材） ---------- */
    function assetOpOf(kind, id, pt, title) {
      const t = MEDIA_KINDS.includes(kind) ? kind : 'asset-ref';
      return { op: 'add_node', node: { type: t, x: Math.round(pt.x), y: Math.round(pt.y),
        title: String(title || '').slice(0, LIMITS.title),
        metadata: { assetId: String(id || ''), sourceAssetId: String(id || ''), assetKind: kind || 'image', status: 'success' } } };
    }
    async function addAt(type, pt) {
      if (!NODE_TYPES[type]) return { ok: false, reason: '没有这种节点类型' };
      const r = commit([{ op: 'add_node', node: { type, x: Math.round(pt.x), y: Math.round(pt.y), metadata: {} } }],
        { label: '加一个' + labelOf(type) + '节点' });
      if (r.ok && r.node) { showInspector(r.node); inspOpen.value = true; }
      return r;
    }
    function addAsset(kind, id, pt, title) {
      if (!id) return notify('这一条没有资产号，放不进画布', 'err');
      const r = commit([assetOpOf(kind, id, pt, title)], { label: '放一个素材进来' });
      if (r.ok && r.node) { showInspector(r.node); inspOpen.value = true; }
      return r;
    }
    async function dropFiles(files, pt) {
      const big = files.find(f => f.size > DROP_MAX);
      if (big) return notify('「' + big.name + '」' + window.fmtBytes(big.size) + ' 太大了：先用「放素材」进资产库再拖进来', 'warn');
      for (const f of files) {
        try {
          const b64 = await readB64(f);
          const saved = await window.Api.saveLocalAsset({ name: f.name, mime: f.type || 'application/octet-stream',
            data: b64, meta: { source: 'canvas-drop' } });
          const id = String(saved.assetId || saved.id || '');
          if (!id) { notify('「' + f.name + '」没拿到资产号', 'warn'); continue; }
          addAsset(kindOfMedia(f.type), id, pt, f.name);
        } catch (e) {
          notify('「' + f.name + '」没能存进本机：' + errText(e), 'err');
        }
      }
    }
    function kindOfMedia(mime) {
      /* 判据走公共层；认不出（不是媒体）按图片放，与拖进来的默认档一致。
         以前这里拿 isAudioType 去比 MIME，永远为假 —— 音频附件会被当图片插进画布。 */
      return window.mediaKindFrom(mime) || 'image';
    }
    function readB64(f) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => { const s = String(fr.result || ''); res(s.slice(s.indexOf(',') + 1)); };
        fr.onerror = () => rej(new Error('读文件失败'));
        fr.readAsDataURL(f);
      });
    }

    /* ---------- 节点菜单 / 检查器 ---------- */
    async function nodeMenu(n, x, y) {
      void x; void y;
      if (!n) return;
      const acts = [
        { label: '改名', value: 'ren' },
        { label: '复制一份', value: 'dup' },
        { label: '断开所有连线', value: 'unlink' },
        n.metadata && n.metadata.assetId ? { label: '打开这条资产', value: 'asset' } : null,
        MEDIA_KINDS.includes(n.type) ? { label: '按当前配置生成', value: 'run' } : null,
        { label: '删除这个节点', value: 'del', danger: true },
        { label: '关掉', value: null },
      ].filter(Boolean);
      const v = await window.UiDialog.open({ title: labelOf(n.type) + '：' + (n.title || '（没名字）'),
        sub: '位置 ' + Math.round(n.x) + ', ' + Math.round(n.y) + ' · 修订 ' + S.doc.revision,
        body: el => { el.innerHTML = '<div class="cv-menu">' + acts.map(a => '<button class="ghost" data-v="' + E(a.value || '') + '">' + E(a.label) + '</button>').join('') + '</div>'; },
        onOpen: (el, close) => { el.querySelectorAll('[data-v]').forEach(b => { b.onclick = () => close(b.dataset.v || null); }); },
        actions: [] });
      if (!v) return;
      if (v === 'ren') { showInspector(n); inspOpen.value = true; nextTick(() => { const t = stage.value && stage.value.querySelector('.cv-node[data-id="' + n.id + '"] [data-edit="title"]'); if (t) t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); return; }
      if (v === 'dup') { const c = newNode({ ...n, id: uid('nd_'), x: n.x + 28, y: n.y + 28, metadata: { ...(n.metadata || {}), assetId: (n.metadata || {}).assetId || '', taskId: '', status: 'idle' } });
        return commit([{ op: 'add_node', node: c }], { label: '复制节点' }); }
      if (v === 'unlink') { const ids = (S.doc.connections || []).filter(c => c.fromNodeId === n.id || c.toNodeId === n.id).map(c => c.id);
        if (!ids.length) return notify('这个节点没有连线', 'info');
        return commit([{ op: 'delete_connections', ids }], { label: '断开 ' + ids.length + ' 条连线' }); }
      if (v === 'asset') return openAsset((n.metadata || {}).assetId);
      if (v === 'run') return runNode(n);
      if (v === 'del') return delNodes([n.id]);
    }
    function openAsset(id) {
      if (!id) return;
      if (window.GoPage && GoPage.go) GoPage.go('assets.html?q=' + encodeURIComponent(id));
      else if (window.appShow) window.appShow('assets.html');
    }
    async function delNodes(ids) {
      const c = await window.Confirm.ask({ title: '删掉 ' + ids.length + ' 个节点',
        body: '连线会跟着断（这一刀删几条线在回执里说）。资产库里的字节不动。', danger: true, okLabel: '删除' });
      if (!c) return;
      const r = commit([{ op: 'delete_nodes', ids }], { label: '删 ' + ids.length + ' 个节点' });
      if (r.ok && r.连带连线数) notify('删掉了，另外断开 ' + r.连带连线数 + ' 条连线', 'ok');
      inspOpen.value = false;
    }
    function deleteSel() { const ids = (S.doc && S.doc.selection) || []; if (ids.length) delNodes(ids); }
    function alignSel() {
      const ids = (S.doc && S.doc.selection) || [];
      if (ids.length < 2) return notify('至少选两个才排', 'info');
      const list = ids.map(id => findNode(S.doc, id)).filter(Boolean);
      const x0 = Math.min(...list.map(n => n.x));
      const gap = 24;
      let x = x0;
      const ops = list.map(n => { const op = { op: 'update_node', id: n.id, patch: { x: Math.round(x), y: Math.round(n.y) } }; x += n.width + gap; return op; });
      commit(ops, { label: '排开 ' + ops.length + ' 个节点' });
    }
    function showInspector(n) {
      if (!n) { inspOpen.value = false; return; }
      S.inspNext = n.id;
      inspOpen.value = true;
      nextTick(() => paintInspector(n));
    }
    function paintInspector(n) {
      const el = inspBody.value;
      if (!el) return;
      const m = n.metadata || {};
      const kind = ['image', 'video', 'audio'].includes(n.type) ? n.type : '';
      const provs = kind ? gen.provsFor(kind) : [];
      const prov = gen.provOf(m.prov);
      const models = prov ? gen.modelsOf(prov) : [];
      /* 型号下拉与平台下拉共用同一个 `opts`（它收的是 {v,t}）：这里只换形状，不再拼一份 HTML。
         漏这层映射时选项是空的 value 与空文字 —— 表面看「型号出来了」，选中却什么也填不进去。 */
      const modelOpts = models.map(m => ({ v: m.id, t: m.name }));
      const opts = (list, cur, name, ph) => '<select data-f="' + name + '"' + (list.length ? '' : ' disabled') + '>'
        + '<option value="">' + E(ph || '（没有可选项）') + '</option>'
        + list.map(x => '<option value="' + E(x.v) + '"' + (String(x.v) === String(cur) ? ' selected' : '') + '>' + E(x.t) + '</option>').join('') + '</select>';
      /* 参数档不在这页写死：档名清单与取值都从 AdvParams 的表和能力声明里取（AGENTS §5.1）。
         `cur` 按 kinds 的键读，画布存的是提交体字段名（ar / count…），所以过一次 SPEC.field 做映射。 */
      const kinds = kind === 'video' ? ((window.AdvParams || {}).VIDEO_KINDS || [])
        : kind === 'image' ? ((window.AdvParams || {}).IMAGE_KINDS || []) : [];
      const model = prov && (prov.models || []).find(x => x.id === m.model);
      const specOf = k => (window.AdvParams && AdvParams.SPEC) ? AdvParams.SPEC[k] : null;
      const curOf = {};
      kinds.forEach(k => { const s = specOf(k); if (s && (m.params || {})[s.field] != null) curOf[k] = (m.params || {})[s.field]; });
      const plan = (model && window.AdvParams) ? AdvParams.plan(model, { kinds, cur: curOf }) : null;
      const fieldOf = key => {
        const s = specOf(key), x = plan && plan.kinds[key];
        if (!s || !x || !x.on) return '';        // 没声明、或只有一个取值：不摆假控件（显示名与取值仍过公共件）
        return '<div class="cv-irow"><label>' + E(x.label) + '</label><select data-f="p:' + E(s.field) + '">'
          + AdvParams.optionsHTML(x) + '</select></div>';
      };
      el.innerHTML = '<div class="cv-irow"><label>标题</label><input data-f="title" value="' + E(n.title) + '"></div>'
        + '<div class="cv-irow cv-geo"><label>位置</label><input type="number" data-f="x" value="' + Math.round(n.x) + '">'
        + '<input type="number" data-f="y" value="' + Math.round(n.y) + '"></div>'
        + '<div class="cv-irow cv-geo"><label>尺寸</label><input type="number" data-f="w" value="' + Math.round(n.width) + '">'
        + '<input type="number" data-f="h" value="' + Math.round(n.height) + '"></div>'
        + (n.type === 'text' || n.type === 'config' ? '<div class="cv-irow col"><label>' + (n.type === 'text' ? '正文' : '提示词') + '</label>'
          + '<textarea data-f="' + (n.type === 'text' ? 'content' : 'prompt') + '" rows="6">' + E(n.type === 'text' ? (m.content || '') : (m.prompt || '')) + '</textarea></div>'
          : '<div class="cv-irow col"><label>提示词</label><textarea data-f="prompt" rows="4">' + E(m.prompt || '') + '</textarea></div>')
        + (kind ? '<div class="cv-irow"><label>平台</label>' + opts(provs.map(p => ({ v: p.id, t: p.displayName || p.name || p.id })), m.prov, 'prov', '选一家' + (kind === 'audio' ? '语音' : kind === 'video' ? '视频' : '图像') + '平台') + '</div>'
          + '<div class="cv-irow"><label>型号</label>' + opts(modelOpts, m.model, 'model', provs.length ? '先选平台' : '本机还没添加这一档平台') + '</div>'
          + kinds.map(fieldOf).filter(Boolean).join('')
          + '<div class="cv-irow"><label>输入素材</label><span class="cv-i-t">' + (countIn(n) + ' 路（连线带进来的）') + '</span></div>'
          + '<div class="cv-iact">' + (MEDIA_KINDS.includes(n.type) ? '<button class="pri" data-a="run"' + (S.busy.has(n.id) ? ' disabled' : '') + '>' + (S.busy.has(n.id) ? '正在跑…' : '生成') + '</button>' : '')
          + '<button class="ghost" data-a="fit">看到它</button></div>'
          : '<div class="cv-iact"><button class="ghost" data-a="fit">看到它</button></div>')
        + '<div class="cv-ist">' + statusLine(n) + '</div>'
        + (kind && window.RawRequest ? '<div class="cv-ist-raw">' + RawRequest.liveHTML('canvas:' + n.id) + '</div>' : '')
        + '<div class="cv-iact"><button class="ghost danger" data-a="del">删除节点</button></div>';
      if (window.RawRequest) RawRequest.bind(el);
      /* 「将要发出的请求」：用户还没点生成就能看到实际会发什么（dry-run，不发网络请求）。
         参数一改 `paintInspector` 就重跑一遍，所以这里跟着走。 */
      if (kind && window.RawRequest && RawRequest.schedule) {
        const node2 = n;
        RawRequest.schedule('canvas:' + n.id, () => {
          const pv = gen.preview(S.doc, node2);
          if (!pv) return null;
          const mm = (node2.metadata || {});
          const pr = (window.Api && Api.providers ? Api.providers() : []).find(x => x.id === mm.prov);
          return { label: node2.title || '',
            provider: mm.prov || '', providerName: (pr && (pr.displayName || pr.name)) || '',
            endpoint: 'create', method: pv.method, path: pv.path, body: pv.body };
        });
      }
      if (window.Dropdowns) Dropdowns.build(el);
      el.querySelectorAll('[data-f]').forEach(ctl => {
        const f = ctl.dataset.f;
        const w = () => (f === 'title' ? { title: ctl.value }
          : f === 'x' ? { x: Number(ctl.value) } : f === 'y' ? { y: Number(ctl.value) }
            : f === 'w' ? { width: Math.max(40, Number(ctl.value)) } : f === 'h' ? { height: Math.max(30, Number(ctl.value)) }
              : f === 'content' ? { metadata: { content: ctl.value } }
                : f === 'prompt' ? { metadata: { prompt: ctl.value } }
                  : f === 'prov' ? { metadata: { prov: ctl.value, model: '' } }
                    : f === 'model' ? { metadata: { model: ctl.value } }
                      : { metadata: { params: { ...((n.metadata || {}).params || {}), [f.slice(2)]: ctl.value } } });
        ctl.onchange = () => { const r = commit([{ op: 'update_node', id: n.id, patch: w() }], { label: '改属性' }); if (r.ok) paintInspector(findNode(S.doc, n.id) || n); };
        ctl.onkeydown = ev => { if (ev.key === 'Enter' && ctl.tagName === 'INPUT' && f === 'title') ctl.blur(); };
      });
      el.querySelectorAll('[data-a]').forEach(b => {
        b.onclick = () => {
          const a = b.dataset.a;
          if (a === 'run') runNode(findNode(S.doc, n.id) || n);
          else if (a === 'del') delNodes([n.id]);
          else if (a === 'asset') openAsset((n.metadata || {}).assetId);
          else if (a === 'fit') scrollToNode(n.id);
        };
      });
    }
    function countIn(n) { return (S.doc.connections || []).filter(c => c.toNodeId === n.id).length; }
    function statusLine(n) {
      const m = n.metadata || {};
      if (!m.status || m.status === 'idle') return '<span class="sub">还没生成过</span>';
      if (m.status === 'loading') return '<span class="run">正在生成' + (m.taskId ? ' · 任务号 ' + E(String(m.taskId).slice(0, 18)) : '') + '</span>';
      if (m.status === 'error') return '<span class="bad">上次失败：' + E(m.error || '原因没带回来') + '</span>';
      if (m.status === 'uncertain') return '<span class="warn">提交结果未知：' + E(m.error || '没等到平台响应')
        + '（可能已经建好任务并扣费，先刷新核对）</span>';
      return '<span class="ok">' + (m.assetId ? '已有产物（在资产库）' : '已有产物（外链，已交给自动镜像存本机）') + '</span>'
        + (m.assetId ? '<button class="ghost mini" data-a="asset">去看看</button>' : '');
    }
    function scrollToNode(id) {
      const n = findNode(S.doc, id); if (!n || !S.surface) return;
      const s = S.surface;
      s.setViewport(fitViewport(S.doc.nodes, [id], s.viewport, stage.value.clientWidth, stage.value.clientHeight, 120, 1), true);
    }

    /* ---------- 生成 ---------- */
    /* 每次运行都回一份凭据（跑没跑、什么档、任务号/产物号、当前修订）：
       界面上回执是 Toast，助手那边要把同一句写进回执里，不能让它猜。 */
    async function runNode(n) {
      if (!n) return { ok: false, reason: '没有这个节点' };
      if (!MEDIA_KINDS.includes(n.type)) { notify('这种节点不生成东西', 'info'); return { ok: false, reason: '这种节点不生成东西' }; }
      if (S.busy.has(n.id)) { notify('这个节点正在跑，等它这一轮', 'info'); return { ok: false, reason: '这个节点正在跑，等它这一轮' }; }
      /* 结果未知的那一条不许当成普通失败直接重跑：上一次提交可能已经被平台受理（已经扣费）。 */
      if ((n.metadata || {}).status === 'uncertain') {
        const go = await window.Confirm.ask({
          title: '这一条的结果还没核对清楚', danger: true, okLabel: '仍然重发', cancelLabel: '先去核对',
          body: '上一次提交可能已经被平台受理（可能已经扣费）。先刷新资产库、或让助手问一次这条的状态，确认没有产物再重发。',
        });
        if (!go) { notify('已拦住：先核对再重发', 'warn'); return { ok: false, reason: '结果未知，先核对（已拦住，没有发出新请求）' }; }
      }
      const why = gen.whyReady(S.doc, n);
      if (why) { showInspector(n); notify(why, 'warn'); return { ok: false, reason: why }; }
      S.busy.add(n.id); paintInspector(n);
      const done = extra => Object.assign({ ok: true, nodeId: n.id, 修订: S.doc.revision }, extra || {});
      try {
        commit([{ op: 'run_generation', id: n.id, patch: { status: 'loading', error: '' } }], { label: '开始生成' });
        const r = await gen.submit(S.doc, n, {
          onTask: id => commit([{ op: 'run_generation', id: n.id, patch: { taskId: id } }], { label: '记任务号', quiet: true }),
        });
        /* 挤掉的参考路数要照实说：型号只收 N 路而线头有 N+1 个时，画面上那些线还挂着，
           真正发出去的却没有 —— 不报就是「接了参考图，出图跟没接一样」这种查不出的错。 */
        if (r.droppedInputs) notify('连进来的素材有 ' + r.droppedInputs + ' 路这一型号收不下，这一次没发出去', 'warn');
        if (r.kind === 'audio') {
          /* 语音是同步合成：synthTts 里已经把字节存成本机资产（la_xxx），所以这里**不再**发
             wb:asset-done —— 再发一次等于让自动镜像去拉自己刚写下的地址。 */
          commit([{ op: 'run_generation', id: n.id, patch: { status: 'success', assetId: r.assetId || '', assetKind: 'audio' } }], { label: '合成完成' });
          notify('这一段合成好了，产物已进资产库', 'ok');
          return done({ kind: 'audio', assetId: r.assetId || '', text: '这一段合成好了，产物已进资产库' });
        }
        if (r.kind === 'image') {
          const e = await gen.waitImage(r.t);
          commit([{ op: 'run_generation', id: n.id, patch: { status: 'success', assetId: e.assetId || '', assetKind: 'image', storageKey: e.assetId ? '' : (e.src || '') } }], { label: '出图完成' });
          notify('这张图好了' + (e.assetId ? '，产物在资产库' : '，已交给自动镜像存本机'), 'ok');
          return done({ kind: 'image', assetId: e.assetId || '',
            text: '这张图好了' + (e.assetId ? '，产物在资产库' : '，已交给自动镜像存本机') });
        }
        S.pending.push({ nodeId: n.id, prov: r.prov.id, id: r.taskId, at: Date.now() });
        commit([{ op: 'run_generation', id: n.id, patch: { status: 'loading', taskId: r.taskId } }], { label: '已提交，等平台做', quiet: true });
        notify('已提交，任务号 ' + r.taskId + '（这一条在跑，切页也照样问）', 'ok');
        if (S.poller) S.poller.tick();
        return done({ kind: 'video', taskId: r.taskId, text: '已提交，任务号 ' + r.taskId + '（在跑，每 5 秒自动问一次）' });
      } catch (e) {
        const msg = String(errText(e)).slice(0, 200);
        /* 「不知道平台收没收到」不能写成失败：写成失败，用户点生成就是第二次扣费。
           判据全站只有 Api.maybeSubmitted 一份，画布这一处以前漏了。 */
        const unc = !!(window.Api && Api.maybeSubmitted && Api.maybeSubmitted(e));
        if (unc) {
          commit([{ op: 'run_generation', id: n.id, patch: { status: 'uncertain', error: msg } }], { label: '提交结果未知' });
          notify('提交结果未知（' + msg + '）：平台可能已经建好任务并扣费，先刷新核对，别急着再生成', 'warn');
          return { ok: false, uncertain: true, nodeId: n.id, reason: msg, 修订: S.doc.revision };
        }
        commit([{ op: 'run_generation', id: n.id, patch: { status: 'error', error: msg } }], { label: '生成失败' });
        notify('这一条失败了：' + msg, 'err');
        return { ok: false, nodeId: n.id, reason: msg, 修订: S.doc.revision };
      } finally {
        S.busy.delete(n.id);
        const cur = findNode(S.doc, n.id);
        if (cur && S.inspNext === cur.id) paintInspector(cur);
      }
    }
    function startPoller() {
      if (!window.Wb || !Wb.poller || S.poller) return;
      S.poller = Wb.poller({
        page: 'canvas.html', label: '画布生成', interval: 5000,
        tasks: () => S.pending, isRunning: t => !!t && !t.done,
        sig: t => (t.done ? 'done' : 'run') + '|' + (t.status || ''),
        pollOne: async t => {
          const r = await gen.pollOnce(t.prov, t.id);
          t.status = r.status || '';
          if (r.done) {
            t.done = true;
            gen.announce({ kind: 'asset', id: r.assetId, assetId: r.assetId, genId: r.genId, type: '视频', src: r.src, provider: t.prov, status: 'done', dl: r.dl });
            commit([{ op: 'run_generation', id: t.nodeId, patch: { status: 'success', assetId: r.assetId || '', assetKind: 'video', storageKey: r.assetId ? '' : (r.src || '') } }], { label: '出片完成', quiet: true });
            notify('那条视频好了' + (r.assetId ? '，产物在资产库' : '，已交给自动镜像存本机'), 'ok');
          } else if (r.failed) { t.done = true; commit([{ op: 'run_generation', id: t.nodeId, patch: { status: 'error', error: r.why || '生成失败' } }], { label: '生成失败', quiet: true }); }
        },
        onChange: () => { S.pending = S.pending.filter(t => !t.done); },
      });
    }

    /* ---------- 视图与快捷键 ---------- */
    function setTool(t) { tool.value = t; if (S.surface) S.surface.setTool(t); }
    function zoomIn() { if (S.surface) S.surface.zoomBy(1.2); }
    function zoomOut() { if (S.surface) S.surface.zoomBy(1 / 1.2); }
    function zoom100() { if (S.surface) S.surface.zoomTo(1); }
    function fit() { if (S.surface) S.surface.fitAll(); }
    function toggleGrid() {
      grid.value = !grid.value;
      if (S.surface) S.surface.setGrid(grid.value);
      notify(grid.value ? '移动会贴网格（8px）' : '已经不贴网格了', 'info');
    }
    function toggleEdges() {
      showEdges.value = !showEdges.value;
      if (edges.value) edges.value.classList.toggle('cv-hid', !showEdges.value);
    }
    function undoStep() {
      const r = S.hist.undo(S.doc);
      if (!r.ok) return notify(r.reason || '没有可撤销的一步（助手写的那几步不算人工改动，撤销只退你自己做的）', 'info');
      S.doc = r.doc; if (S.surface) S.surface.sync({ all: true });
      markDirty(); refresh();
      notify('已撤销：' + (r.label || '上一步'), 'ok');
    }
    function redoStep() {
      const r = S.hist.redo(S.doc);
      if (!r.ok) return notify(r.reason || '没有可重做的一步', 'info');
      S.doc = r.doc; if (S.surface) S.surface.sync({ all: true });
      markDirty(); refresh();
    }
    async function openAdd() {
      const items = createMenu();
      const v = await window.UiDialog.open({ title: '加一个节点', sub: '放在当前屏幕正中',
        body: el => { el.innerHTML = '<div class="cv-menu">' + items.map(d => '<button class="ghost" data-v="' + E(d.type) + '">'
          + ic(d.icon, 14) + ' ' + E(d.label) + '<span class="sub">　' + E(d.type === 'config' ? '存平台/型号/提示词，连着别的节点用' : d.type === 'asset-ref' ? '指向资产库里的一条' : d.type === 'text' ? '标题与正文' : '可生成，也可放已有产物') + '</span></button>').join('') + '</div>'; },
        onOpen: (el, close) => { el.querySelectorAll('[data-v]').forEach(b => { b.onclick = () => close(b.dataset.v); }); },
        actions: [{ label: '取消', value: null }] });
      if (v) addAt(v, center());
    }
    function center() {
      const s = S.surface ? S.surface.viewport : { x: 0, y: 0, scale: 1 };
      const w = stage.value ? stage.value.clientWidth : 800, h = stage.value ? stage.value.clientHeight : 600;
      return { x: (w / 2 - s.x) / s.scale, y: (h / 2 - s.y) / s.scale };
    }
    async function pickAsset() {
      if (!window.AssetPicker) return notify('素材选择器还没装好', 'warn');
      const got = await window.AssetPicker.open({ title: '放进画布的素材', types: ['图片', '视频', '音频'], multiple: true, limit: 8 });
      if (!got || !got.length) return;
      const c = center();
      const ops = got.map((e, i) => assetOpOf(kindOfEntry(e), String(e.assetId || e.genId || e.id || ''),
        { x: c.x + i * 40, y: c.y + i * 30 }, e.name || e.prompt || ''));
      const r = commit(ops, { label: '放 ' + ops.length + ' 个素材进来' });
      if (r.ok && r.changed.nodes.length) { showInspector(findNode(S.doc, r.changed.nodes[0])); inspOpen.value = true; }
    }
    /* 资产库条目的类型档：中文档名是资产库的口径，画布只认 image / video / audio / asset-ref。 */
    function kindOfEntry(e) {
      return window.mediaKindFrom((e && e.type) || '');
    }
    function keysHelp() {
      window.UiDialog.open({ title: '画布快捷键',
        html: '<div class="cv-keys">' + [
          ['滚轮', '以指针为中心缩放'], ['空格 / 中键 / 抓手', '平移'], ['V / H', '选择 / 抓手'],
          ['拖动框', '框选（Shift 追加，Alt 反选）'], ['双击', '就地改标题或正文'],
          ['拖右侧圆点', '连一条线'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做（撤到助手写的那一步为止）'],
          ['Delete', '删掉选中的'], ['Ctrl+A', '全选'], ['Ctrl+S', '立刻落盘'],
          ['Ctrl+F', '搜索节点'], ['Ctrl+J', '打开助手'], ['Ctrl+0 / 1 / 2', '50% / 100% / 200%'], ['N', '加节点'], ['?', '这一份清单'],
        ].map(r => '<div><kbd>' + E(r[0]) + '</kbd><span>' + E(r[1]) + '</span></div>').join('') + '</div>',
        actions: [{ label: '知道了', value: true, primary: true }] });
    }
    /* 画布内检索的排序只有一份：页面 Ctrl+F 与助手的 canvas.search 都走这里
       （判据复用全站那一份 SemanticSearch，不在这一页另写中文分词）。 */
    function rankNodes(text, limit) {
      const t = String(text || '').trim();
      if (!t || !S.doc) return [];
      const n = Math.max(1, Math.min(50, Number(limit) || 20));
      const docs = (S.doc.nodes || []).map(node => ({
        node, title: node.title || '', text: hay(node), type: labelOf(node.type), kind: node.type,
      }));
      const pick = r => {
        /* S.rank 回的是 { item, score, why } 那一层壳，item 才是上面 docs 里那条 { node, title, text… }：
           直接当节点读会撞「metadata of undefined」，检索整条链路当场死。 */
        const node = r.item.node;
        const m = (node.metadata || {});
        return { id: node.id, type: node.type, 名称: labelOf(node.type), 标题: node.title,
          x: node.x, y: node.y, 状态: m.status || 'idle', 有产物: !!m.assetId,
          摘要: String(m.content || m.prompt || '').slice(0, 90), 匹配度: r.score, 命中: r.why };
      };
      const S2 = window.SemanticSearch;
      if (!S2 || !S2.rank) {
        const low = t.toLowerCase();
        return docs.filter(d => d.text.toLowerCase().includes(low)).slice(0, n)
          .map(d => pick({ item: d, score: 1, why: '字面命中' }));
      }
      /* 一次最多 200 条：720 个节点的画布要分块排完再并，静默截断等于「明明有却说没有」。 */
      const out = [];
      for (let i = 0; i < docs.length; i += 200) out.push(...S2.rank(docs.slice(i, i + 200), t, { limit: 200 }));
      return out.sort((a, b) => b.score - a.score).slice(0, n).map(pick);
    }
    async function searchNodes() {
      const v = await window.PromptForm.open({ title: '在画布里找', okLabel: '定位', fields: [{ key: 't', label: '标题或正文里含', value: q.value }] });
      const text = String((v && v.t) || '').trim();
      if (!text) return;
      const best = rankNodes(text, 1)[0];
      if (!best) return notify('这一份画布里没有「' + text + '」', 'info');
      const hit = findNode(S.doc, best.id);
      if (!hit) return notify('这一份画布里没有「' + text + '」', 'info');
      commit([{ op: 'select_nodes', ids: [hit.id] }], { view: true });
      if (S.surface) S.surface.setViewport(Object.assign({}, S.surface.viewport), false);
      scrollToNode(hit.id); showInspector(hit);
    }
    function onKey(ev) {
      if (!isActive() || !S.doc) return;
      const t = ev.target;
      if (t && (t.isContentEditable || /input|textarea|select/i.test(t.tagName || ''))) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      if (mod && k === 's') { ev.preventDefault(); saveNow(); return; }
      if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? redoStep() : undoStep(); return; }
      if (mod && k === 'y') { ev.preventDefault(); redoStep(); return; }
      if (mod && k === 'f') { ev.preventDefault(); searchNodes(); return; }
      if (mod && k === 'j') { ev.preventDefault(); openAssistant(); return; }
      if (mod && k === '0') { ev.preventDefault(); zoom100(); return; }
      if (mod && (k === '1' || k === '2' || k === '3')) {
        ev.preventDefault();
        if (!S.surface) return;
        S.surface.zoomTo(k === '1' ? 0.5 : k === '2' ? 1 : 2);
        refresh();
        return;
      }
      if (mod) return;
      if (k === 'delete' || k === 'backspace') { ev.preventDefault(); deleteSel(); return; }
      if (k === 'n') { ev.preventDefault(); openAdd(); return; }
      if (k === 'v') { setTool('select'); return; }
      if (k === 'h') { setTool('hand'); return; }
      if (k === 'escape') { inspOpen.value = false; return; }
      if (k === '?') { ev.preventDefault(); keysHelp(); }
    }
    function openAssistant() {
      if (window.AiChat && AiChat.open) AiChat.open();
      else notify('助手还在后台加载，稍等一下再按 Ctrl+J', 'info');
    }
    function renameDoc(ev) {
      const t = String(ev.target.value || '').trim() || '未命名画布';
      S.doc = { ...S.doc, title: t.slice(0, LIMITS.title), updatedAt: Date.now() };
      markDirty(); refresh();
    }
    /* 返回前先等这一次保存落定。原来是发一个不 await 的 saveNow 就切页：
       存失败（配额满 / 索引写坏）时人已经离开这一份，界面上没有一处还说得出「没存上」，
       而下一次 openDoc 读的是磁盘上那份旧的 —— 用户的改动就在这一下没了。 */
    async function back() {
      if (S.dirty && !(await saveNow())) return;
      goLib();
    }
    function miniJump(ev) {
      if (!S.surface || !mini.value) return;
      const r = mini.value.getBoundingClientRect();
      const k = Number(mini.value.dataset.k) || 1;
      const bx = Number(mini.value.dataset.bx) || 0, by = Number(mini.value.dataset.by) || 0;
      const dx = bx + (ev.clientX - r.left) / k, dy = by + (ev.clientY - r.top) / k;
      const s = { w: stage.value.clientWidth, h: stage.value.clientHeight };
      S.surface.setViewport({ x: s.w / 2 - dx * S.surface.viewport.scale, y: s.h / 2 - dy * S.surface.viewport.scale, scale: S.surface.viewport.scale });
    }

    /* ---------- 助手桥 ---------- */
    /* 画布与图形的真相只在这一份桥里出：助手（web/features/chat.js）不读 DOM、不碰 S.doc，
       所有写入都归结到 applyOperations 那一个口子。型号/参数/花费那些「平台声明」的事实在助手那一侧，
       这里不复制一份。 */
    const READ_BUDGET = 8 * 1024;
    const APPLY_MAX = 20;
    /* 一个节点的正文最长 20 万字符：原样回给模型等于把整个上下文吃掉。
       超预算就逐档裁正文与提示词，并照实说裁过 —— 不报的话模型以为读到的是全文。 */
    function clipNodeMeta(m) {
      const out = Object.assign({}, m);
      let cut = false;
      for (let cap = 4000; cap >= 64 && JSON.stringify(out).length > READ_BUDGET; cap = Math.floor(cap / 2)) {
        ['content', 'prompt'].forEach(k => {
          const v = out[k];
          if (typeof v === 'string' && v.length > cap) { out[k] = v.slice(0, cap) + '…'; cut = true; }
        });
      }
      return { meta: out, 正文有裁切: cut };
    }
    function nodeRow(n) {
      const m = n.metadata || {};
      return { id: n.id, type: n.type, 名称: labelOf(n.type), 标题: n.title, x: n.x, y: n.y,
        width: n.width, height: n.height, 状态: m.status || 'idle', 有产物: !!m.assetId,
        摘要: String(m.content || m.prompt || '').slice(0, 120) };
    }
    function bridgeApi() {
      return {
        version: 2,
        ready: () => isActive() && !!S.doc && ready.value,
        /* 画布目前没有「打开但不能改」的档；真来了只读快照（别人给的分享件）改这一处，
           助手那一侧的写闸只认这一个口子。 */
        readOnly: () => false,
        types: () => Object.values(NODE_TYPES).map(d => ({ 类型: d.type, 名称: d.label,
          能生成: d.generationMode === 'asset', 收哪些输入: d.acceptsInputKind,
          输入上限: d.maxInputCount || 0, 默认尺寸: d.defaultSize })),
        center: () => center(),
        /* 一条资产怎么变成节点只有 assetOpOf 这一份：它同时决定 assetKind / sourceAssetId / status。
           助手要建「已有产物」那种节点时只能问这里，自己拼一份的话导出件先撞坏
           （少 sourceAssetId 的节点在 FCPXML 里是一条离线素材）。id 为空照样回一条非法 op，
           由桥的 check 拒掉 —— 不静默改成文本节点，那是把错藏到画面里。 */
        assetNode: (kind, assetId, pt, title) => assetOpOf(String(kind || ''), String(assetId || ''),
          { x: Number(pt && pt.x) || 0, y: Number(pt && pt.y) || 0 }, String(title || '')),
        /* 视图：助手要的是「让用户看到这一片」，不是三个坐标数 —— 能缩到多小、画面框多大
           只有表面那一份算法知道，所以在这一处算完，再走 setViewport → commit 那唯一写出口。
           fit 是看全（或只看给的这几枚），center 是把某枚挪到正中并保住当前倍率，set 是照给的三个数摆。
           视图类操作不涨修订、不进撤销栈，所以助手写完不需要退这一步。 */
        view: a => {
          if (!S.doc || !S.surface) return { ok: false, reason: '画布还没打开' };
          const mode = String((a && a.mode) || 'fit');
          const vw = stage.value ? stage.value.clientWidth : 800;
          const vh = stage.value ? stage.value.clientHeight : 600;
          const ids = (Array.isArray(a && a.ids) ? a.ids : (a && a.nodeId ? [a.nodeId] : []))
            .map(String).filter(id => findNode(S.doc, id));
          const now = S.surface.viewport;
          let vp;
          if (mode === 'set') {
            const v = (a && a.viewport) || a || {};
            const x = Number(v.x), y = Number(v.y), k = Number(v.scale);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(k)) {
              return { ok: false, reason: 'set 要把 x / y / scale 三个数都给全' };
            }
            vp = { x, y, scale: k };
          } else if (mode === 'center') {
            if (!ids.length) return { ok: false, reason: 'center 要给一个画布上真有的节点（nodeId）' };
            const n = findNode(S.doc, ids[0]);
            vp = { x: vw / 2 - (n.x + (n.width || 0) / 2) * now.scale,
              y: vh / 2 - (n.y + (n.height || 0) / 2) * now.scale, scale: now.scale };
          } else if (mode === 'fit') {
            vp = fitViewport(S.doc.nodes, ids, now, vw, vh, ids.length ? 120 : 64, 1);
          } else {
            return { ok: false, reason: '视图只有三档：fit（看全）/ center（看这一枚）/ set（照给的数摆）' };
          }
          if (!S.doc.nodes.length && mode === 'fit') return { ok: false, reason: '画布上一个节点也没有，没有可看的东西' };
          S.surface.setViewport(vp);
          const v = S.surface.viewport;
          return { ok: true, 视口: { x: Math.round(v.x), y: Math.round(v.y), scale: Number(v.scale.toFixed(3)) },
            缩放: Math.round(v.scale * 100) + '%', 修订: S.doc.revision,
            说明: '只动了视图：没改节点，也没涨修订，这一步不需要撤销' };
        },
        /* 结果定位：显式点「定位」才选中并滚到那一枚；执行完那一下只闪、不切视图。
           连线没有独立可滚动实体，就跟着亮；只动了一条线时没有节点可滚，只闪那一根。 */
        locate: (ids, opts) => {
          if (!S.doc) return { ok: false, reason: '画布没打开' };
          if (!isActive()) return { ok: false, reason: '画布现在不在前台：切回画布再点「定位」' };
          const o = opts || {};
          const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
          const nodes = list.map(id => findNode(S.doc, id)).filter(Boolean);
          const edges = (S.doc.connections || []).filter(c => list.includes(String(c.id)));
          if (!nodes.length && !edges.length) return { ok: false, reason: '这份画布上已经没有这几处了（可能刚被删掉）' };
          const flashEl = el => {
            if (!el) return;
            el.classList.remove('flash');
            void el.offsetWidth;
            el.classList.add('flash');
            setTimeout(() => el.classList.remove('flash'), 2400);
          };
          const flash = () => {
            nodes.forEach(n => flashEl(S.surface && S.surface.nodeEl(n.id)));
            edges.forEach(c => flashEl(stage.value && stage.value.querySelector('.cv-edge[data-id="' + c.id + '"]')));
          };
          if (nodes.length) {
            if (o.focus !== false) {
              commit([{ op: 'select_nodes', ids: [nodes[0].id] }], { view: true, quiet: true });
              /* 选中是视图操作，commit 只刷新检查器、不碰表面；这里要补一次同步，否则框上了却没亮。 */
              if (S.surface) S.surface.sync({ nodes: [nodes[0].id], connections: [] });
              scrollToNode(nodes[0].id);
              requestAnimationFrame(() => requestAnimationFrame(flash));
            } else flash();
            return { ok: true, found: nodes.length + edges.length,
              label: nodes.length === 1 ? (nodes[0].title || labelOf(nodes[0].type)) : nodes.length + ' 个节点' };
          }
          flash();
          return { ok: true, found: edges.length, label: edges.length + ' 条连线' };
        },
        context: a => {
          if (!S.doc) return { 画布: '没打开' };
          const lim = Math.max(1, Math.min(200, Number(a && a.limit != null ? a.limit : a) || 120));
          const d = S.doc, dep = S.hist.depth(), list = S.hist.list();
          const busy = (d.nodes || []).filter(n => (n.metadata || {}).status === 'loading').map(n => n.id);
          return Object.assign({ 画布: d.id, 标题: d.title }, docSummary(d, lim), {
            选中: (d.selection || []).map(id => { const n = findNode(d, id); return n ? nodeRow(n) : null; }).filter(Boolean),
            生成中: busy,
            /* 撤销栈也放进快照：助手写完要在回执里给出这一步的 operationId，
               单独再开一个 history() 口子等于同一份历史有两处说法。 */
            历史: { 可撤销: dep.cursor - dep.baseline, 可重做: dep.levels - dep.cursor, 上限: dep.max,
              最近: list.slice(-8) },
          });
        },
        search: a => rankNodes(a && typeof a === 'object' ? a.q : a, a && typeof a === 'object' ? a.limit : 20),
        nodeRead: id => {
          const n = findNode(S.doc, id);
          if (!n) return null;
          const c = clipNodeMeta(n.metadata || {});
          return Object.assign(nodeRow(n), { metadata: c.meta, 正文有裁切: c.正文有裁切,
            连线: (S.doc.connections || []).filter(x => x.fromNodeId === n.id || x.toNodeId === n.id)
              .map(x => ({ id: x.id, from: x.fromNodeId, to: x.toNodeId,
                方向: x.fromNodeId === n.id ? '出' : '入' })),
            入度: countIn(n) });
        },
        check: ops => (S.doc ? applyOperations(S.doc, Array.isArray(ops) ? ops : [ops])
          : { ok: false, reason: '画布没打开' }),
        apply: (ops, a = {}) => {
          if (!S.doc) return { ok: false, reason: '画布没打开' };
          const list = Array.isArray(ops) ? ops : [ops];
          if (!list.length) return { ok: false, reason: '至少要有一条操作' };
          /* 一批的条数在这一处夹住：模型分批写等于中间那几批失败时画布只剩半截。 */
          if (list.length > APPLY_MAX) return { ok: false, reason: '一次最多 ' + APPLY_MAX + ' 条操作（先精简，别拆成几批）' };
          const r = commit(list, { source: 'external', operationId: a.operationId || '',
            label: a.label || '助手改画布', expectedRevision: a.expectedRevision, quiet: true });
          if (!r.ok) return r;
          if (r.viewOnly) return { ok: true, 只动视图: true, 改动节点: [], 改动连线: [], 修订: r.revision };
          const d = S.doc;
          return { ok: true, 只动视图: false, 修订: r.revision, 改动节点: r.changed.nodes,
            改动连线: r.changed.connections, 连带连线数: r.连带连线数,
            节点: r.changed.nodes.map(id => { const n = findNode(d, id); return n ? nodeRow(n) : null; }).filter(Boolean),
            operationId: String(a.operationId || ''), 撤销: a.operationId ? 'canvas_undo 传这个 operationId 可退这一步' : '' };
        },
        undo: operationId => {
          if (!S.doc) return { ok: false, reason: '画布没打开' };
          const r = S.hist.undoOperation(S.doc, operationId);
          if (!r.ok) return r;
          S.doc = r.doc; if (S.surface) S.surface.sync({ all: true });
          markDirty(); refresh();
          return { ok: true, 修订: r.doc.revision, 撤掉了: r.label,
            改动节点: r.changed.nodes, 改动连线: r.changed.connections };
        },
        run: async nodeId => {
          const n = findNode(S.doc, nodeId);
          if (!n) return { ok: false, reason: '没有这个节点' };
          return runNode(n);
        },
        /* 状态只报事实，不写盘：节点状态由页面上那一台轮询器落（每 5 秒一轮），
           这里只是替助手现问一次，免得它照旧状态回「还在跑」而其实已经出片。 */
        genStatus: async a => {
          if (!S.doc) return { ok: false, reason: '画布没打开' };
          const want = String((a && a.nodeId) || '');
          const nodes = S.doc.nodes || [];
          const pick = want ? nodes.filter(n => n.id === want)
            : nodes.filter(n => ['loading', 'error', 'uncertain'].includes((n.metadata || {}).status));
          if (want && !pick.length) return { ok: false, reason: '没有这个节点：' + want.slice(0, 64) };
          const rows = [];
          for (const n of pick.slice(0, 40)) {
            const m = n.metadata || {}, t = S.pending.find(p => p.nodeId === n.id);
            const r = { nodeId: n.id, 标题: n.title, 类型: labelOf(n.type), 状态: m.status || 'idle',
              任务号: m.taskId || (t && t.id) || '', 有产物: !!m.assetId, 在跑: !!t && !t.done };
            if (m.error) r.上次失败 = m.error;
            if (t && !t.done && r.任务号) {
              try {
                const p = await gen.pollOnce(t.prov, t.id);
                r.平台此刻 = p.done ? '已经出片，页面下一轮就落到节点上'
                  : p.failed ? ('失败：' + String(p.why || '')) : ('仍在跑：' + (p.status || '进行中'));
              } catch (e) { r.平台此刻 = '问不动：' + String(errText(e)).slice(0, 80); }
            }
            rows.push(r);
          }
          return { ok: true, 在跑: S.pending.filter(t => !t.done).length, 轮询: '每 5 秒一轮，切页也照样问', 节点: rows };
        },
        /* 提案：把「打算这么改」先在一份临时副本上算一遍，回「能不能跑、缺什么、会动到谁」。
           不建任务、不扣费、不动当前画布 —— 那三件事仍然只有 apply 与 run 会做。 */
        propose: a => {
          if (!S.doc) return { ok: false, reason: '画布没打开' };
          const ops = Array.isArray(a && a.ops) ? a.ops : [];
          const want = String((a && a.nodeId) || '');
          if (ops.length > APPLY_MAX) return { ok: false, reason: '一次最多 ' + APPLY_MAX + ' 条操作' };
          /* 只给 nodeId、这一笔什么都不改的那种提案是最常用的一条（「这一枚打算用什么生成、还缺什么」）：
             这里不能拿「至少一条操作」当场拒掉，否则助手永远问不出提案，只能先写节点再提案。
             没有要写的东西就用当前文档算 —— 仍然是纯读，不建任务、不扣费、不动画布。 */
          const r = ops.length ? applyOperations(S.doc, ops)
            : (findNode(S.doc, want) ? { ok: true, doc: S.doc, changed: { nodes: [want], connections: [] } }
              : { ok: false, reason: '提案要么带上一条要写进画布的操作，要么给一个画布上真有的 nodeId' });
          if (!r.ok) return r;
          const target = String((a && a.nodeId) || '') || (r.changed.nodes || []).slice(-1)[0] || '';
          const n = findNode(r.doc, target);
          if (!n) return { ok: false, reason: '这一份提案改不到任何节点' };
          const res = gen.resolve(r.doc, n);
          const prov = gen.provOf(res.prov);
          const model = prov ? (prov.models || []).find(m => m.id === res.model) : null;
          const why = gen.whyReady(r.doc, n);
          const spec = model ? gen.inputSpec(model, n.type) : null;
          return { ok: true, 提案节点: { nodeId: n.id, 类型: n.type, 名称: labelOf(n.type), 标题: n.title },
            会改动节点: r.changed.nodes, 会改动连线: r.changed.connections,
            平台: prov ? (prov.displayName || prov.name || prov.id) : '', 型号: res.model,
            /* 助手算花费要用**号**而不是显示名（estimateCost 收的是 provider/model 对象），
               能力来源与参考素材也给出去：卡片上「这几路喂料从哪几枚节点来」是用户判断提案对不对的依据。 */
            平台id: res.prov, 型号id: res.model, 能力来源: res.from.slice(),
            参考素材: res.inputs.map(i => i.assetId),
            提示词字数: String(res.prompt || '').length, 参数: res.params,
            输入: res.inputs.length + ' 路' + (spec ? '（这一型号声明最多 ' + (Number(spec.max) || '不限') + ' 路）' : '（这一型号不收输入）'),
            缺料: res.missing, 就绪: !why, 缺什么: why,
            能生成: gen.nodeKindOf(n.type) !== '', 说明: '这是提案：没有建任务也没扣费，画布一个字节都没动' };
        },
      };
    }
    let uninstall = null;

    /* ---------- 生命周期 ---------- */
    onMounted(async () => {
      try {
        if (!window.Kv) throw new Error('存储层没装载');
        /* Api / gen-forms 这些还在 shell.html 常驻；Capabilities / AssetPicker / DataSync 改由路由表的
           `needs` 在这一页挂载前并发补载（routes.js），这里只剩工作台（Wb.poller、Wb.cards）要现补。 */
        await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
        /* 原始请求面板（不常驻在 shell.html）。 */
        await window.__spaLoadScript('web/ui/raw-request.js', () => window.RawRequest);
        const REG = (window.Api && Api.registry) ? await Api.registry().catch(() => ({ providers: [] })) : null;
        /* 画布的平台/型号读的是注册表里的 `prov.models`；vgenv / sparkcine 这类家的型号清单
           只从能力接口来，不在注册表里写死。不在这里拉一次，选完平台型号下拉就永远是空的。 */
        if (REG && window.Capabilities && Capabilities.load) {
          Capabilities.load(REG).then(() => {
            if (!inspOpen.value) return;
            const n = findNode(S.doc, S.inspNext);
            if (n) paintInspector(n);
          }).catch(() => {});
        }
      } catch (e) { failed.value = '画布装不起来：' + errText(e); ready.value = true;
        /* 这一支原来是 return，所以「进账」写在 return 之前：写在后面那一句永远跑不到。 */
        if (window.PageReport) PageReport.pageFail('画布', failed.value, e); return; }
      await loadLib();
      startPoller();
      const id = routeId();
      if (id) await openDoc(id); else refresh();
      ready.value = true;
      if (pageEl.value) window.fillIcons(pageEl.value);
      /* 这一页是切页时才挂上来的（不在 DOMContentLoaded 那趟自动包装里）：库头的排序下拉现包一次。 */
      try { if (window.Dropdowns && pageEl.value) Dropdowns.build(pageEl.value); } catch (e) {}
      window.addEventListener('keydown', onKey);
      if (window.WBBridge) uninstall = WBBridge.install('canvas', bridgeApi());
      try { if (window.__spaRegister) window.__spaRegister(() => { if (S.dirty) saveNow(); }, () => S.dirty); } catch (e) {}
    });
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey);
      if (uninstall) uninstall();
      if (S.poller) S.poller.stop();
      teardownSurface();
      if (S.dirty) saveNow();
    });

    /* 外壳 provide 的是整个 state（studio 页读的也是 `route.route.src`）：写成 route.state.route 取到的一直是
       undefined，于是地址换了、视图还停在原来那份画布上 —— 「返回项目库」点下去什么都不发生。 */
    watch(() => route && route.route && route.route.src, async () => {
      if (!isActive()) return;
      const id = routeId();
      if (id !== docId.value) await openDoc(id);
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      stage, layer, edges, mini, libBox, libFilterEl, inspBody, pageEl,
      iconMinus: window.icon('minus', 13), iconPlus: window.icon('plus', 13),
      ready, failed, docId, title, revision, saveText, saveKind,
      q, sort, libCount, tool, grid, showEdges, inspOpen, selCount, canUndo, canRedo, zoomText, undoTitle, redoTitle,
      back, renameDoc, doExport, doImport, openAssistant, newDoc: newDocNow,
      setTool, zoomIn, zoomOut, zoom100, fit, toggleGrid, toggleEdges, undoStep, redoStep,
      openAdd, pickAsset, keysHelp, deleteSel, alignSel, closeInsp: () => { inspOpen.value = false; }, miniJump,
    };
  },
  render,
};
