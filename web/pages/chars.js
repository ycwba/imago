/* 素材库 —— 由 chars.html 迁到 Vue 3 的页面。
   数据与副作用全部走已有的公共层（Chars / Wb / AssetLocal / AssetPicker / AssetTransfer /
   AiFind / AiChip / Chips / Dropdowns / Confirm / Toast），组件只负责「这一屏长什么样」。
   `chars.js` 仍是全站唯一的数据层（Chars.Pipe / Chars.Lib / Chars.Cast / Chars.SET），
   这一页一个字都不重写它；卡片内部那几块（声音 / 角色资产 / 候选排）仍是 Cast 产出的标记。

   与旧页的两点结构差异（行为不变）：
   ① 卡片不再逐个 `bindCard`：网格上用事件委托接 `data-a` / `data-act` / `data-f`，
      重画只换那一张卡的 html 字符串（焦点由 paintCard 还回去，与旧实现同一套判据）；
   ② `document.getElementById` 只出现在公共模块要求的那几处 id（分页按钮交给 Wb.pager 的
      `pgPrevId` 一档、AiChip 的清除键给唯一 id），页面自己的元素全走 ref。 */
import { ref, nextTick, onMounted, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/chars.js';

const PAGE_MODE = window.pageModeOf('chars');
const PAGE_SIZE = window.pageSizeOf('chars');
/* 三种类型各一档（与库里那三种平级，道具是 2026-10 加的），后面三个是「还缺什么」的缺口档。 */
import { ensureCss } from '../core/page-css.js';

const FILTERS = [['all', '全部'], ['actor', '角色'], ['scene', '场景'], ['prop', '道具'],
  ['nopic', '还没有预览图'], ['noasset', '还没有角色资产'], ['novoice', '还没有声音'], ['nodesc', '还没有描述']];

/* 这一份样式单独放在 spa-chars.css，打开这一页时由 `ensureCss` 按需挂上
   （外壳只引 tokens / ui / sidebar / spa-director，不引任何页面样式）。 */
ensureCss('web/styles/spa-chars.css', 'spa-chars');

export default {
  name: 'CharsView',
  setup() {
    const PAGE_FILE = 'chars.html';
    /* 前台判据只有公共层那一份：core/activity.js（外壳挂在 window.__spaActivity）。
       这里原来自己读 `spaActiveFile`：那只说明「路由选中的是这一页」，整个标签页切到后台时
       它照样为真，于是隐藏着的素材库还在收指针、还在处理快捷键。 */
    const isActive = window.__spaActivity.forPage(PAGE_FILE);
    let offActivity = null;
    /* 页面常驻（v-show）：切回来时重数一次「被 N 镜引用」。订阅在 setup 里登记，卸载时退掉。
       灯箱与详情的配置不再跟着切页换 —— 公共层按前台页装回各自那一份（见 registerAdapters）。 */
    if (window.__spaActivity) offActivity = window.__spaActivity.subscribe(() => { if (isActive()) onVisibleChange(); });

    /* ---------- DOM 宿主（页面自己的元素一律走 ref） ---------- */
    const rootEl = ref(null);
    const toolbarEl = ref(null);
    const aiFindBtn = ref(null);
    const aiChipEl = ref(null);
    const grpPickEl = ref(null);
    const grpListEl = ref(null);
    const viewEl = ref(null);
    const btnFillEl = ref(null);
    const btnLocalEl = ref(null);
    const btnStopEl = ref(null);
    const btnNewEl = ref(null);
    const imgPickEl = ref(null);
    const ttsPickEl = ref(null);
    const candPickEl = ref(null);
    const aiLiveEl = ref(null);
    const gridEl = ref(null);
    const gridEndEl = ref(null);
    const pagerRowEl = ref(null);

    /* ---------- 界面状态 ---------- */
    const ready = ref(false);
    const failed = ref('');
    const cards = ref([]);            // [{ id, html }]：一张卡一条，重画只换这一条
    const openId = ref('');           // 哪一张卡展开了编辑区
    const q = ref('');
    const searchPh = ref('搜索素材');
    const cntText = ref('');
    const busyText = ref('');
    const stopVisible = ref(false);
    const stopDisabled = ref(false);
    const pagerVisible = ref(false);
    const emptyHtml = ref('');
    const fillText = ref('一次出齐这一档');
    const fillDisabled = ref(true);
    const fillTitle = ref('');
    /* 多选与批量补缺：素材一多，「一条一条点开补」就是最耗时的那段。
       选中集合用新 Set 整体替换（ref 只有换引用才会触发模板重画）。 */
    const multi = ref(false);
    const sel = ref(new Set());
    const batchCount = ref(0);
    const batchBusy = ref(false);
    const batchText = ref('');
    const batchGroup = ref('');
    const health = ref({ total: 0, groups: 0, used: 0, rows: [], note: '' });
    const ticHtml = window.icon ? icon('layers', 20) : '';
    const newBtnHtml = (window.icon ? icon('plus', 13) : '') + ' 新建素材';
    const aiBtnHtml = (window.icon ? icon('sparkles', 14) : '') + ' AI 找素材';

    /* ---------- 数据层与本地记账 ---------- */
    let D = window.Chars || null;
    let REG = null;
    let alive = true;
    /* 顶部主工具条（芯片 / 搜索 / AI 按钮 / AI 条件芯片 / 计数）由 Wb.filterBar 生成，
       这一页只留点完之后做什么；aiFindBtn / aiChipEl 在 bind 之后指回那一份里的节点。 */
    let toolbarFb = null;
    const filter = ref('all');
    const group = ref('');            // '' = 全部组；'__none' = 未分组
    let aiPick = null, aiWhy = '', aiRank = null;
    let busyMsg = '';
    /* 「一次出齐」这一轮的两位状态：按过停下（不再开新的任务）、这一轮有没有停下可言。 */
    let stopFlag = false, fillStoppable = false;
    let renderSeq = 0;
    const viewItems = [];             // 当前视图的素材（灯箱翻页范围）
    const media = [];                 // 当前视图能点开看的图（预览图 + 各资产）
    let refUse = new Map(), refUseAt = 0;
    let pager = null;
    let offStorage = null;
    let viewToggle = null;
    let sentinelIO = null;
    let candSelBuilt = false;
    let nameBefore = '';
    let fieldTimer = null;
    let headPend = null, headTimer = 0;
    let libWarnedAt = 0;

    /* 这一页没有「某一集」，所以出图 / 出声音用的型号在本页选一下（存 char_opts）。
       传进 Chars.Pipe 时套成 drama 的样子（那些函数只读 opts.imgModel / opts.ttsModel / opts.ratio）。 */
    let opts = { imgModel: '', ttsModel: '', ratio: '9:16', style: '' };
    /* 读写走 Store（信封 + 写不进去当场说一句）。旧格式是裸 JSON、没有信封，
       这里先摸一次裸值：认出来就并进 opts，下一次保存自然变成信封 ——
       不摸这一把，这次改动会把用户早就选好的型号当成「没选过」清掉。 */
    (() => {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem('char_opts') || 'null'); } catch (e) { raw = null; }
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('data' in raw)) opts = Object.assign(opts, raw);
      else opts = Object.assign(opts, Store.read('char_opts', null) || {});
    })();
    const fakeDrama = () => ({ opts: opts, characters: [], scenes: [], shots: [] });
    function saveOpts() { Store.write('char_opts', opts, { label: '素材库这一页的型号与比例' }); }

    const src = s => window.Api.mediaSrc(s);
    /* 图片一律由 Wb.thumbs 画（地址映射、尺寸缓存、失败占位、解码属性都在那一份里），
       页面不再自己拼 `<img>`；一屏几十张，所以带 loading=lazy 让浏览器管着取字节。
       渲染完之后由 bindCardDom 统一 bindAll 接线（重复 bind 是安全的）。 */
    const thumbImg = (s, attrs) => window.Wb.thumbs.mediaHTML(s,
      { type: 'image', mediaAttrs: 'loading="lazy" draggable="false"' + (attrs ? ' ' + attrs : '') });
    const isScene = x => D.isSceneItem(x);
    const isProp = x => D.isPropItem(x);
    const voiced = x => D.Cast.isVoiced(x);
    const assetTpls = c => D.Cast.assetTplsOf(c);
    const kindF = k => D.Lib.kindF(k);
    const ONE = 1;
    const candCount = () => Math.max(ONE, Number(D.candCount(REG, opts)) || ONE);
    const nSuffix = () => { const n = candCount(); return n > 1 ? ' ' + n + ' 张' : ''; };
    const picWord = c => isProp(c) ? '道具图' : '预览图';
    const mainKind = c => isScene(c) ? 'img' : isProp(c) ? 'prop' : 'face';
    const aiRankOf = c => (aiRank && aiRank.has(c.id) ? aiRank.get(c.id) : Number.MAX_SAFE_INTEGER);

    function orderItems(items) {
      if (aiRank) return items.slice().sort((a, b) => aiRankOf(a) - aiRankOf(b));
      /* 'zh' 要显式写：不带 locale 时按浏览器默认排，同一份库在两台机器上顺序不一样。 */
      return items.slice().sort((a, b) => String(a.name || '').trim().localeCompare(String(b.name || '').trim(), 'zh'));
    }

    /* ---------- 谁在生成：一张表记「这一条的哪一项正在出」 ---------- */
    const GEN = new Map();
    const gKey = (kind, id) => kind + '#' + id;
    const DRAFT = new Map();
    const draftOf = id => DRAFT.get(id) || { name: '', tpl: '', what: '' };
    function genSet(kind, id, msg) { GEN.set(gKey(kind, id), msg); paintBusy(); }
    function genClear(kind, id) { GEN.delete(gKey(kind, id)); paintBusy(); }
    function genHas(kind, id) { return GEN.has(gKey(kind, id)); }
    function genMsg(kind, id) { return GEN.get(gKey(kind, id)) || ''; }
    function genLine() { return Array.from(GEN.values()).filter(Boolean).join('　｜　'); }
    /* 「这一项上一次没出来，为什么」也按「哪一条的哪一项」记，与 GEN 同一套键。 */
    const ERR = new Map();
    function errSet(kind, id, msg) { const k = gKey(kind, id); if (msg) ERR.set(k, msg); else ERR.delete(k); }

    function errLabel(kind, c) {
      if (kind === 'face') return '这张' + picWord(c);
      if (kind === 'voice') return '试听';
      if (kind === 'voicecands') return '声音候选';
      if (kind.indexOf('asset#new:') === 0) {
        const rest = kind.slice('asset#new:'.length), i = rest.indexOf(':');
        return (i < 0 ? '' : rest.slice(i + 1)) || D.Cast.assetLabel(c, i < 0 ? rest : rest.slice(0, i)) || '这张角色资产';
      }
      if (kind.indexOf('asset#') === 0) {
        const id = kind.slice('asset#'.length);
        const a = D.Cast.assetById(c, id);
        return (a && D.Cast.assetName(a)) || D.Cast.assetLabel(c, id) || '这张角色资产';
      }
      return '这一项';
    }
    function errsHTML(c) {
      const tail = '#' + c.id, out = [];
      for (const [k, msg] of ERR) {
        if (!k.endsWith(tail) || !msg) continue;
        out.push('<div class="why">' + esc(errLabel(k.slice(0, k.length - tail.length), c)) + '：' + esc(msg) + '</div>');
      }
      return out.join('');
    }
    function genOn(c) {
      const tail = '#' + c.id;
      for (const k of GEN.keys()) if (k.endsWith(tail)) return k.slice(0, k.length - tail.length);
      return '';
    }

    /* ---------- 写库的唯一出口 ---------- */
    function libSave(c) {
      const saved = D.Lib.save(c, { exact: true });
      const e = D.Lib.writeError();
      if (e) {
        const now = Date.now();
        if (now - libWarnedAt > 8000) { libWarnedAt = now; Toast.err(e, 9000); }
        return null;
      }
      return saved;
    }
    function setBusy(m) { busyMsg = m; paintBusy(); }

    const aiPanel = () => window.AiStream.panel(aiLiveEl.value, { title: 'AI 正在写…' });

    function paintBusy() {
      busyText.value = genLine() || busyMsg;
      stopVisible.value = !!(genHas('fill', null) && fillStoppable);
      paintFillBtn();
      paintLocalBtn();
    }

    /* ---------- 「切页不丢」：把正在跑的出图任务号落盘 ----------
       读写只走 `Store`（信封 + 上限 + 配额提示）。这一处以前是裸 `localStorage` 加一句
       `catch (e) {}`：存储写满时任务号静默消失，刷新后那一串还在跑的任务谁也说不清去哪了。 */
    const PEND = (() => {
      const KEY = 'char_pending';
      const adoptLegacy = () => {
        /* 旧格式（裸 JSON）只在这一处兼容一次：读到就当场补写成信封，下次直接走 Store.read */
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) Store.write(KEY, raw, { label: '素材库在跑的任务' });
        else raw = null;
        return raw || {};
      };
      const m = Store.read(KEY, null) || adoptLegacy();
      const save = () => { Store.write(KEY, m, { label: '素材库在跑的任务' }); };
      return {
        get(k) { return m[k]; },
        set(k, rec) { m[k] = rec; save(); },
        del(k) { if (m[k]) { delete m[k]; save(); } },
        all() { return Object.keys(m).map(k => ({ key: k, rec: m[k] })); },
      };
    })();
    let curPend = null;
    const pendHook = rec => info => {
      if (!rec || !info || !info.id) return;
      const cur = PEND.get(rec.key) || { kind: rec.kind, id: rec.id, at: 0, label: '', tasks: [] };
      cur.at = Date.now();
      cur.label = rec.label || cur.label;
      if (!cur.tasks.some(t => String(t.id) === String(info.id))) {
        cur.tasks.push({ prov: (info.prov && info.prov.id) || '', id: info.id });
      }
      PEND.set(rec.key, cur);
    };
    const onTaskHook = info => pendHook(curPend)(info);

    async function resumePending() {
      const stale = 30 * 60 * 1000;
      let done = 0, lost = 0;
      const jobs = [];
      for (const { key, rec } of PEND.all()) {
        if (!rec || !Array.isArray(rec.tasks) || !rec.tasks.length) { PEND.del(key); continue; }
        if (Number(rec.at) < Date.now() - stale) { PEND.del(key); continue; }
        const c = D.Lib.list().find(x => x && x.id === rec.id);
        if (!c) { PEND.del(key); continue; }
        jobs.push({ key, rec, c });
      }
      await D.Pipe.runPool(jobs, FILL_CONC, async job => {
        const { key, rec, c } = job;
        genSet(rec.kind, rec.id, '正在取回上次没等完的出图…');
        paintCard(c);
        const got = [];
        for (const t of rec.tasks) {
          try {
            const e = await window.AiGen.adopt(t.prov, t.id, { want: 1 });
            (e.entries || [e]).filter(x => x && x.src).forEach(x => got.push(x.src));
          } catch (e2) { /* 取不回来的那条不打断其余的 */ }
        }
        genClear(rec.kind, rec.id);
        PEND.del(key);
        if (!got.length) { lost++; paintCard(c); return; }
        const bus = String(rec.kind || '');
        if (bus === 'face') {
          const old = (c.faces || []).slice();
          c.faces = got.map((s2, i) => ({ src: s2, name: '第 ' + (old.length + i + 1) + ' 张' })).concat(old).slice(0, D.FACE_CAP);
          if (!D.picOf(c)) D.setPic(c, got[0]);
        } else if (bus.indexOf('asset#new:') === 0) {
          D.Cast.addAsset(c, { name: rec.label || '', tpl: bus.slice('asset#new:'.length), src: got[0] });
        } else if (bus.indexOf('asset#') === 0) {
          const a = D.Cast.assetById(c, bus.slice('asset#'.length));
          if (a) { a.src = got[0]; D.Cast.assetsSave(c, D.Cast.assetsOf(c)); }
        }
        libSave(c);
        done++;
        paintCard(c);
      });
      if (done) Toast.receipt('取回了 ' + done + ' 条上次没等完的出图（切页之前发出去的，任务一直在平台上跑）', 'ok', 6000);
      if (lost) Toast.warn('有 ' + lost + ' 条上次的出图没取回来（平台可能已经清了那条任务），在编辑区里重出一次即可', 8000);
    }

    function queueFieldSave(c) {
      clearTimeout(fieldTimer);
      fieldTimer = setTimeout(() => { libSave(c); }, 700);
    }

    /* 三种类型的主图同一条路、同一份读写。名字（lab）才是三档真正不同的东西。 */
    const candK = lab => ({ bus: 'face', lab: lab,
      gen: x => D.Pipe.drawPreview(REG, fakeDrama(), x, { onTask: onTaskHook }),
      got: x => D.picOf(x), set: (x, v) => D.setPic(x, v) });
    const CANDK = { face: candK('预览图'), img: candK('场景图'), prop: candK('道具图') };

    function moreCandsBtn(kind, dis) {
      const n = candCount();
      return `<button class="ui-linkbtn" data-a="morecand" data-k="${esc(kind)}"${dis ? ' disabled' : ''}>`
        + (n > 1 ? '再画 ' + n + ' 张候选' : '再画 1 张') + '</button>';
    }
    async function moreCands(c, kind) {
      const k = CANDK[kind]; if (!k) return;
      await genRun(k.bus, c.id, c, '正在给「' + c.name + '」出 ' + candCount() + ' 张' + k.lab + '候选…', () => k.gen(c));
    }
    function useCand(c, kind, s2) {
      const k = CANDK[kind]; if (!k || !s2) return;
      k.set(c, s2);
      const ok = !!libSave(c);
      paintCard(c);
      if (!ok) return;
      Toast.receipt('这条现在用这张。已经拍过的段还是旧参考图，要生效得重拍那一段', 'ok', 4200);
    }
    async function genRun(kind, id, c, msg, fn, quiet, label) {
      if (genHas(kind, id)) { if (!quiet) Toast.err('这一项正在生成中，好了会自动出现，不用再点一次'); return false; }
      genSet(kind, id, msg); errSet(kind, id, ''); paintCard(c);
      const prevPend = curPend;
      curPend = { key: kind + '#' + id, kind: kind, id: id, label: label || '' };
      const hook = pendHook(curPend);
      let err = '', out = null;
      try { out = await fn(hook); } catch (e) { err = errText(e); }
      curPend = prevPend;
      genClear(kind, id);
      PEND.del(kind + '#' + id);
      libSave(c);
      const warn = (!err && out && Array.isArray(out.notes)) ? out.notes.filter(Boolean).join('；') : '';
      errSet(kind, id, err || warn);
      paintCard(c);
      if (err && !quiet) Toast.err(err);
      return !err;
    }

    /* ---------- 卡片标记 ---------- */
    function nmInner(c) {
      return `${esc(c.name)}<span class="ui-tag">${D.LIB_KINDS[D.libKindOf(c)]}</span>`
        + (isScene(c) && c.time ? `<span class="ui-tag">${esc(c.time)}</span>` : '')
        + (!isScene(c) && !isProp(c) && D.voiceOnlyOf(c) ? '<span class="ui-tag">只出声</span>' : '')
        + (c.group ? `<span class="ui-tag">${esc(c.group)}</span>` : '');
    }
    function bioInner(c) {
      return esc(c.bio || '') + (c.bio && c.look ? '<br>' : '') + esc((c.look || '').slice(0, 80));
    }
    function refTag(c) {
      const list = refUse.get(String((c && c.name) || '')) || [];
      const n = list.length;
      if (!n) return '';
      const where = list.slice(0, 4).map(u => [u.pname, u.sname, u.shname].filter(Boolean).join(' / ')).join('；');
      return '<span class="ui-tag" title="导演台的这些镜头写了 @' + esc(c.name) + '：' + esc(where)
        + (n > 4 ? ' 等 ' + n + ' 处' : '') + '">被 ' + n + ' 镜引用</span>';
    }
    function mainCandsHTML(c, pw, busy, editOpen) {
      const kind = mainKind(c);
      const n = candCount();
      const list = (c.faces || []).filter(x => x && x.src);
      const tail = editOpen ? moreCandsBtn(kind, false) : '';
      return busy
        ? `<div class="ui-cands"><span class="lab">${esc(pw)}候选</span>${D.Cast.waitHTML('正在出 ' + n + ' 张')}${editOpen ? moreCandsBtn(kind, true) : ''}</div>`
        : D.Cast.picCandsHTML(list, D.picOf(c), { act: 'usecand', del: 'canddel', label: pw + '候选', name: c.name,
            extra: ' data-k="' + kind + '"', tail: tail });
    }

    /* 原始请求折叠块：生成按钮旁边一处（画面）与声音那一处各一枚，内容由 RawRequest 自己更新。 */
    const rawHostHTML = tag => (window.RawRequest ? '<div class="chars-raw">' + RawRequest.html(tag) + '</div>' : '');
    function cardHTML(c) {
      const sc = isScene(c), pr = isProp(c);
      const pw = picWord(c);
      const pic = D.picOf(c);
      const editOpen = openId.value === c.id;
      const faceBusy = genHas('face', c.id);
      const vo = voiced(c) && D.voiceOnlyOf(c);
      /* 报错盖在图上（与「正在出」同一个位置）：卡面只剩图 + 名字 + 徽标 + 组名，
         错误原因不另开一栏 —— 它就是这张图为什么没出来，看图的地方就要看得到。 */
      const errHTML = errsHTML(c);
      const thumb = vo
        ? `<div class="thumb" title="只出声：这一位不出画面，所以不必有${esc(pw)}（要让它出镜就在编辑区把勾去掉）"><div class="none">只出声<br>不出镜</div></div>`
        : `<div class="thumb"${faceBusy ? '' : ` data-a="${pic ? 'zoomface' : 'pickface'}"`} title="${faceBusy
          ? '正在出' + esc(pw) + '：出来会自动换上'
          : pic ? pw + '：点一下看大图'
            : '还没有' + pw + '：点这里从资产库 / 我的收藏 / 本机文件挑一张，或点「编辑」后按「AI 出' + nSuffix() + pw + '」'}">
          ${faceBusy ? `<div class="none">${D.Cast.waitHTML('正在出' + pw)}</div>`
            : pic ? thumbImg(pic) + (c.anchor && c.anchor === pic ? '<span class="anchorbadge" title="身份锚点：出图、出资产与导演台参考图优先用它">锚点</span>' : '')
              : `<div class="none">还没有${esc(pw)}<br>点这里自己挑一张</div>`}
          ${errHTML ? '<div class="thumb-why">' + errHTML + '</div>' : ''}</div>`;
      const pickedNow = sel.value.has(c.id);
      return `${multi.value ? `<div class="pickbox${pickedNow ? ' on' : ''}" title="勾选后批量补缺 / 分组 / 删除">${pickedNow ? '✓' : ''}</div>` : ''}${thumb}
        <div class="main"><div class="body">
          <div class="nm">${nmInner(c)}</div>
          <div class="acts">${window.Wb.actsHTML(c, {
            items: [
              { act: 'edit', label: editOpen ? '收起' : '编辑' },
              { act: 'rename', label: '改名', title: '给这一条换名字：全片按 id 自动回填引用，改名不断' },
              pic ? { act: 'reuse', label: '拿去生成', title: '带着这张' + esc(pw) + '去生成工作台，放进参考图那一栏', data: { src: pic, name: c.name || '' } } : null,
              pic ? { act: 'similar', label: '找相似', title: '在本机素材库里按画面指纹找相似的图（不上传、不调模型）' } : null,
              { act: 'del', label: '从库里删掉', danger: true },
            ].filter(Boolean),
          })}</div>
        </div>
        ${editOpen ? editHTML(c) : ''}
        </div>`;
    }

    function anchorHTML(c) {
      if (D.voiceOnlyOf(c)) return '';
      const shown = D.picOf(c);
      const cur = c.anchor || '';
      const list = [];
      if (shown) list.push({ src: shown, label: picWord(c) });
      (c.faces || []).forEach((f, i) => { if (f && f.src && !list.some(x => x.src === f.src)) list.push({ src: f.src, label: '候选图 ' + (i + 1) }); });
      D.Cast.assetsOf(c).forEach(a => { if (a && a.src && !list.some(x => x.src === a.src)) list.push({ src: a.src, label: D.Cast.assetName(a) || '资产' }); });
      return `<div class="ed-sec">身份锚点 · 参考图质量</div>
        <div class="ui-hint">锚点是「认人最准的那一张」：出图、出角色资产与导演台取参考图时优先用它。不设 = 跟随预览图。</div>
        ${list.length ? `<div class="anchor-list">${list.map(x => `<button class="anch${x.src === cur ? ' on' : ''}" data-a="setanchor" data-src="${esc(x.src)}" title="把这一张设为身份锚点">
          ${thumbImg(x.src)}<span>${esc(x.label)}</span></button>`).join('')}</div>` : '<div class="ui-hint">先出 / 挑一张预览图，才能设身份锚点。</div>'}
        <div class="anchor-acts"><button class="ui-linkbtn" data-a="clearanchor"${cur ? '' : ' disabled'}>跟随预览图</button>
          <button class="ui-linkbtn" data-a="similar" data-src="${esc(cur || shown || '')}">找相似素材</button></div>
        <div class="anchorq" data-q="${esc(c.id)}">正在量参考图…</div>`;
    }
    function usageHTML(c) {
      const list = refUse.get(String(c.name || '')) || [];
      if (!list.length) return '<div class="ed-sec">使用关系</div><div class="ui-hint">导演台里还没有镜头写 @' + esc(c.name || '这一条') + '。</div>';
      return '<div class="ed-sec">使用关系 · ' + list.length + ' 个镜头</div>'
        + '<div class="usage-list">' + list.slice(0, 12).map(u => '<div class="usage"><span>' + esc(u.pname) + '</span><span>' + esc(u.sname) + '</span><span>' + esc(u.shname) + '</span></div>').join('') + '</div>'
        + (list.length > 12 ? '<div class="ui-hint">还有 ' + (list.length - 12) + ' 处没列出来。</div>' : '');
    }

    function editHTML(c) {
      const sc = isScene(c), pr = isProp(c);
      const kf = kindF(D.libKindOf(c));
      const pw = picWord(c);
      const vo = !sc && !pr && D.voiceOnlyOf(c);
      const tpls = assetTpls(c);
      const list = D.Cast.assetsOf(c);
      const libProps = D.Lib.list().filter(x => x && isProp(x));
      const dr = draftOf(c.id);
      const drTpl = tpls.includes(dr.tpl) ? dr.tpl : (tpls[0] || 'custom');
      const anTxt = '这一张';
      const assetListHTML = list.length ? '<div class="ui-cands"><span class="lab">角色资产 ' + list.length + ' 张</span>'
        + '<div class="ui-assets">' + list.map(a => {
          const lab = D.Cast.assetName(a);
          const opts2 = libProps.map(p => `<label class="ck sm" title="这一张图上带着「${esc(p.name)}」"><input type="checkbox" data-a="assetprop" data-id="${esc(a.id)}" data-pid="${esc(p.id)}"${(a.propIds || []).includes(p.id) ? ' checked' : ''}>${esc(p.name)}</label>`).join('');
          return `<div class="ui-asset" data-aid="${esc(a.id)}">`
            + `<span class="ui-cand" data-a="zoom" data-src="${esc(a.src)}" data-label="${esc(c.name + ' · ' + lab)}">${thumbImg(a.src)}</span>`
            + `<input class="ui-inp" data-a="assetrename" data-id="${esc(a.id)}" maxlength="24" value="${esc(lab)}" title="这一张叫什么（改了立刻存）">`
            + `<button class="ui-linkbtn" data-a="assetregen" data-id="${esc(a.id)}" title="照着同一个提示词再出一张，换掉这一张">重出${anTxt}</button>`
            + `<button class="ui-linkbtn" data-a="reuse" data-src="${esc(a.src || '')}" data-name="${esc(lab)}" title="带着这一张去生成工作台，放进参考图那一栏">拿去生成</button>`
            + `<button class="ui-linkbtn" data-a="assetclear" data-id="${esc(a.id)}" data-label="${esc(lab)}">去掉这一张</button>`
            + (libProps.length ? '<span class="ui-props">' + opts2 + '</span>' : '<span class="ui-hint sm">素材库里还没有道具，点右上「新建素材」加一条（类型选「道具」）</span>')
            + '</div>';
        }).join('') + '</div>'
        + '<div class="ui-hint sm">这些图拍摄时都会作为参考图发给视频 AI（按平台声明的上限截，超出的会点名哪几张没发）。</div>'
        + '</div>' : '';
      const assetGenHTML = (tpls.length && !vo) ? '<div class="ui-cands"><span class="lab">加一张角色资产</span>'
        + `<input class="ui-inp" data-a="assetname" maxlength="24" value="${esc(dr.name)}" placeholder="这一张叫什么（填了就按它画，留空用模板名）">`
        + `<select data-a="assettpl">${tpls.map(k => `<option value="${esc(k)}"${k === drTpl ? ' selected' : ''}>${esc(D.Cast.assetLabel(c, k) || k)}</option>`).join('')}</select>`
        + `<input class="ui-inp" data-a="assetwhat" maxlength="60" value="${esc(dr.what)}" placeholder="选「自定义」时写清楚要画什么，例：雨天造型、侧脸特写">`
        + `<button class="ghost mini" data-a="assetgen">AI 出${anTxt}</button>`
        + `<button class="ui-linkbtn" data-a="assetpick2">＋ 自己传一张</button>`
        + '</div>' : '';
      const waitRows = (() => {
        const tail = '#' + c.id, out = [];
        for (const [k, msg] of GEN) {
          if (k.indexOf('asset#') !== 0 || !k.endsWith(tail)) continue;
          out.push('<div class="ui-asset sm">' + D.Cast.waitHTML((msg || '正在出') + '…') + '</div>');
        }
        return out.join('');
      })();
      const picBtns = vo ? '' : `<button class="ghost" data-a="face"${genHas('face', c.id) ? ' disabled' : ''}>${genHas('face', c.id) ? '正在出' + pw : (D.picOf(c) ? 'AI 重出' : 'AI 出') + nSuffix() + pw}</button>`
        + `<button class="ghost" data-a="pickface" title="从资产库 / 我的收藏 / 本机文件里挑一张当${esc(pw)}（不靠生成，直接拿现成的）">${D.picOf(c) ? '换一张' + pw : '自己传' + pw}</button>`;
      return `<div class="edit" data-edit="${esc(c.id)}">
        <div class="eh"><span class="t">编辑「${esc(c.name || '这条素材')}」· 改完就地存</span>
          ${D.Cast.voiceTag(c)}
          ${refTag(c)}
          <button class="ui-linkbtn" data-a="closeedit" title="收起这一块的编辑区（按 Esc 也一样）">收起</button></div>

        <div class="ed-sec">基本信息</div>
        <label>名字<input data-f="name" value="${esc(c.name || '')}" maxlength="20"></label>
        <label>类型<select data-f="kind">${Object.keys(D.LIB_KINDS).map(k =>
          `<option value="${k}"${D.libKindOf(c) === k ? ' selected' : ''}>${D.LIB_KINDS[k]}</option>`).join('')}</select></label>
        <label>分组（可留空；素材库页能按整组筛与查找）<input data-f="group" list="grpList" value="${esc(c.group || '')}" maxlength="20" placeholder="例：校园篇主要角色"></label>

        <div class="ed-sec">描述</div>
        <label>${kf.look.lab}<textarea data-f="look" rows="3">${esc(c.look || '')}</textarea></label>
        ${sc ? `<label>${kf.time.lab}<select data-f="time" title="${esc(kf.time.hint)}">${D.Cast.timeOptsHTML(c)}</select></label>` : ''}
        <label>${kf.bio.lab}<input data-f="bio" value="${esc(c.bio || '')}"></label>
        ${voiced(c) ? `<label class="ck"><input type="checkbox" data-f="voiceOnly"${D.voiceOnlyOf(c) ? ' checked' : ''}> 只出声（不出镜）</label>` : ''}
        ${vo ? '<div class="ui-hint">这一位是「只出声」：不出画面，所以' + pw + '与角色资产的入口都不给它摆（想让它出镜就取消上面那个勾）。库里已经存着的图还在下面，能看也能去掉。</div>' : ''}
        ${pr ? '<div class="ui-hint">道具只有这一张图：没有角色资产，也不出声。生成某一镜时它的图会作为参考图发给视频 AI，名字与描述进这一段的提示词。</div>' : ''}

        ${vo ? '' : `<div class="ed-sec">画面</div><div class="ed-acts">${picBtns}</div>${rawHostHTML('chars:' + (sc ? 'scene' : pr ? 'prop' : 'char') + ':' + c.id)}`}
        ${vo ? '' : mainCandsHTML(c, pw, genHas('face', c.id), true)}
        ${assetListHTML}${waitRows}${assetGenHTML}

        ${anchorHTML(c)}
        ${usageHTML(c)}

        ${voiced(c) ? `<div class="ed-sec">声音</div>${D.Cast.voiceRowHTML(REG, opts, c, { waiting: genMsg('voicecands', c.id) })}${rawHostHTML('chars:voice:' + c.id)}` : ''}
      </div>`;
    }

    function safeCardHTML(c) {
      try { return cardHTML(c); } catch (e) {
        console.error('[chars] 这一条画不出来：', e, c);
        return '<div class="edit"><div class="eh"><span class="t">这一条画不出来</span></div>'
          + '<div class="ui-hint">' + esc((c && c.name) || '（这一条没有名字）') + '：'
          + esc(errText(e))
          + '<br>其余条目不受影响；这一条的数据还在库里，刷新一下再看看。</div></div>';
      }
    }

    /* ---------- 卡片 DOM：重画一张 / 找一张 / 复原焦点 ---------- */
    function cardEl(id) {
      if (!gridEl.value) return null;
      return [...gridEl.value.querySelectorAll('.card')].find(x => x.dataset.id === id) || null;
    }
    function itemOf(id) {
      const hit = viewItems.find(x => x && x.id === id);
      if (hit) return hit;
      return D ? D.Lib.get(id) : null;
    }
    async function paintCard(c) {
      paintFillBtn();
      paintLocalBtn();
      if (!c || !D) return;
      const i = cards.value.findIndex(x => x.id === c.id);
      if (i < 0) return;
      /* 焦点与光标位交给公共卡片列表那一份锚（Wb.cards.anchorFocus）：这一页是自己 v-for
         渲染的，重画走 Vue 的异步更新，所以「记住」在改数据之前、「放回去」在 nextTick 之后。 */
      const back = window.Wb.cards.anchorFocus(gridEl.value);
      cards.value[i] = { id: c.id, html: safeCardHTML(c) };
      await nextTick();
      if (!alive) return;
      const nx = cardEl(c.id);
      bindCardDom();
      if (openId.value === c.id) paintQuality(c);
      back();
    }
    function bindCardDom() {
      if (!gridEl.value) return;
      if (window.Dropdowns) window.Dropdowns.build(gridEl.value);
      /* 卡片里的图片由 Wb.thumbs 接线（缓存命中直接用小图、失败换占位）：整块重画之后一次 bindAll，
         页面不必每张卡各调一次 bind（重复 bind 同一元素是安全的）。 */
      if (window.Wb) window.Wb.thumbs.bindAll(gridEl.value);
      if (window.RawRequest) window.RawRequest.bind(gridEl.value);
      /* 自动补存：开关开着时把这一屏「本机还没有」的素材排进镜像队列。 */
      try {
        if (window.AssetLocal && AssetLocal.offerAll) {
          const jobs = [];
          viewItems.forEach(c => { if (c) localSlots(c).forEach(s => jobs.push(s)); });
          AssetLocal.offerAll(jobs);
        }
      } catch (e) { /* 补存失败不影响列表 */ }
      if (openId.value) { const el = cardEl(openId.value); if (el) syncWhat(el); }
    }
    function syncDraft(card, c) {
      const nm = card && card.querySelector('[data-a="assetname"]');
      const tpl = card && card.querySelector('[data-a="assettpl"]');
      const what = card && card.querySelector('[data-a="assetwhat"]');
      DRAFT.set(c.id, { name: (nm || {}).value || '', tpl: (tpl || {}).value || '', what: (what || {}).value || '' });
    }
    function syncWhat(card) {
      const tpl = card && card.querySelector('[data-a="assettpl"]');
      const what = card && card.querySelector('[data-a="assetwhat"]');
      if (!tpl || !what) return;
      const custom = tpl.value === 'custom';
      what.disabled = !custom;
      what.placeholder = custom ? '写清楚要画什么，例：雨天造型、侧脸特写' : '（只有选「自定义」时才用这一格）';
    }

    /* 就地更新标题 / 简介那两行（只换内容，不碰按钮与输入框）。 */
    function paintHeads(c) {
      const el = cardEl(c.id); if (!el) return;
      const nm = el.querySelector('.nm'), bio = el.querySelector('.bio'), eh = el.querySelector('.edit .eh > .t');
      if (nm) nm.innerHTML = nmInner(c);
      if (bio) bio.innerHTML = bioInner(c);
      if (eh) eh.textContent = '编辑「' + (c.name || '这条素材') + '」· 改完就地存';
    }
    function flushHeads() {
      clearTimeout(headTimer); headTimer = 0;
      const c = headPend; headPend = null;
      if (c) paintHeads(c);
    }
    function queueHeads(c) {
      headPend = c;
      clearTimeout(headTimer);
      headTimer = setTimeout(flushHeads, 400);
    }

    /* ---------- 顶部筛选 ---------- */
    function match(c, f) {
      if (f === 'all') return true;
      if (f === 'actor' || f === 'scene' || f === 'prop') return D.libKindOf(c) === f;
      if (f === 'nopic') return !D.voiceOnlyOf(c) && !D.picOf(c);
      if (f === 'noasset' || f === 'nothree') return !isProp(c) && !isScene(c) && !D.voiceOnlyOf(c) && D.Cast.assetTplsOf(c).length && !D.Cast.assetsOf(c).length;
      if (f === 'nodesc') return !String(D.descOf(c) || '').trim();
      return voiced(c) && !c.refAudio && !c.voice && !String(c.voiceNote || '').trim();
    }
    function paintChips() {
      if (!toolbarFb || !D) return;
      const all = D.Lib.list();
      toolbarFb.setChips(FILTERS, filter.value,
        v => { filter.value = v; resetPaging(); render(); },
        { count: v => all.filter(c => c && match(c, v)).length });
    }
    function paintAiChip() {
      if (!aiChipEl.value) return;
      window.AiChip.show(aiChipEl.value, {
        on: !!aiPick, picked: aiPick && aiPick.size, why: aiWhy,
        clearId: 'charsAiClear', onClear: clearAiPick,
      });
    }
    function clearAiPick() { window.AiFind.clear(AI); }
    function setCnt(text) {
      cntText.value = text;
      if (toolbarFb) toolbarFb.setCount(text);
    }

    function paintGroups() {
      const gs = D.Lib.groups();
      const none = D.Lib.list().filter(c => c && D.Lib.groupMatch(c, '__none')).length;
      group.value = D.Lib.reconcileGroup(group.value, gs, !!none);
      const el = grpPickEl.value; if (!el) return;
      el.innerHTML = '<select><option value=""' + (group.value ? '' : ' selected') + '>全部组</option>'
        + gs.map(g => `<option value="${esc(g.name)}"${group.value === g.name ? ' selected' : ''}>${esc(g.name)}（${g.n}）</option>`).join('')
        + (none ? `<option value="__none"${group.value === '__none' ? ' selected' : ''}>未分组（${none}）</option>` : '')
        + '</select>';
      const sel = el.querySelector('select');
      if (sel) sel.onchange = () => { group.value = sel.value; resetPaging(); render(); };
      if (window.Dropdowns) window.Dropdowns.build(el);
      if (grpListEl.value) grpListEl.value.innerHTML = gs.map(g => `<option value="${esc(g.name)}">`).join('');
    }

    /* ---------- 展示样式与分页 ----------
       「显示到第几条 / 第 i 条要跳到哪一页」都归 `Wb.pager`（本地全量的续拉那一档由它数
       `morePages`），这一页只留「拿到该显示的条目」与「筛选变了回第一屏」。 */
    function pageItems() { return pager ? pager.slice(viewItems) : viewItems; }
    function resetPaging() { if (pager) pager.reset(); }

    /* ---------- 一次出齐这一档 ---------- */
    const FILL_CONC = 6;
    function fillPlan() {
      const jobs = [];
      let face = 0, three = 0, usable = 0;
      viewItems.forEach(x => {
        if (!x || D.voiceOnlyOf(x)) return;
        usable++;
        const f = !D.picOf(x);
        const t = !!assetTpls(x).length && !D.Cast.assetsOfTpl(x, 'three').length;
        if (!f && !t) return;
        if (f) face++;
        if (t) three++;
        jobs.push({ c: x, face: f, three: t });
      });
      return { jobs, face, three, tasks: face + three, usable };
    }
    function paintFillBtn() {
      if (!btnFillEl.value || !D) return;
      if (!REG) {
        fillDisabled.value = true; fillText.value = '一次出齐这一档';
        fillTitle.value = '正在读平台能力声明…';
        return;
      }
      if (genHas('fill', null)) { fillDisabled.value = true; fillText.value = '正在出齐这一档…'; return; }
      if (!D.Pipe.pickProvModel(REG, 'image', opts.imgModel, 'text_to_image')) {
        fillDisabled.value = true; fillText.value = '一次出齐这一档';
        fillTitle.value = '现在没有可用的生图平台：到设置页填一把密钥，或在右边「出图型号」里挑一个';
        return;
      }
      const p = fillPlan();
      fillDisabled.value = !p.tasks;
      fillText.value = p.tasks ? '一次出齐这一档（' + p.tasks + ' 次）' : '一次出齐这一档';
      fillTitle.value = p.tasks
        ? '这一档里 ' + p.face + ' 条还缺预览图／道具图、' + p.three + ' 位角色还缺三视图：每一条发一次生图请求，'
          + '一次出一张。中途可以按「停下」'
        : (p.usable ? '这一档里的预览图与三视图都齐了，没有要补的'
          : (p.usable === 0 && viewItems.length ? '这一档里只有「只出声」的素材，它们不出画面' : '这一档里没有素材'));
    }
    async function fillRest() {
      if (!D || genHas('fill', null)) return;
      const p = fillPlan();
      if (!p.tasks) { Toast.warn(viewItems.length ? '这一档没有要补的图：每条都已经有预览图了' : '这一档里还没有素材'); return; }
      if (p.tasks > 1 && !await window.Confirm.ask({
        title: '一次出齐这一档',
        body: '这一档里有 ' + p.face + ' 条还缺预览图／道具图、' + p.three + ' 位角色还缺三视图，'
          + '一共发 ' + p.tasks + ' 次生图请求（每次出一张）。'
          + '中途可以按「停下」，但已经发出去的那些收不回来，平台那边会照样跑完。',
        okLabel: '开始出',
      })) return;
      stopFlag = false;
      fillStoppable = p.jobs.length > 1;
      stopDisabled.value = false;
      let done = 0;
      genSet('fill', null, '一次出齐：0 / ' + p.jobs.length + ' 条…');
      try {
        await D.Pipe.runPool(p.jobs, FILL_CONC, async (j) => {
          if (stopFlag) return;
          const c = j.c;
          if (j.face) await genRun('face', c.id, c, '', hook => D.Pipe.drawPreview(REG, fakeDrama(), c, { count: ONE, onTask: hook }), true);
          if (stopFlag) return;
          if (j.three) {
            if (!D.picOf(c)) {
              errSet('asset#three', c.id, '预览图这次没出来；三视图要照着它画，所以这一步跳过了');
              paintCard(c);
            } else {
              await genRun('asset#three', c.id, c, '', hook => D.Pipe.drawCharAsset(REG, fakeDrama(), c, 'three', { count: ONE, onTask: hook }), true);
            }
          }
          done++;
          if (genHas('fill', null)) genSet('fill', null, '一次出齐：' + done + ' / ' + p.jobs.length + ' 条…');
        });
      } finally {
        fillStoppable = false;
        genClear('fill', null);
        render();
      }
    }

    /* ---------- 体检 / 多选 / 身份锚点 / 视觉相似 ----------
       这一族都读 D.Lib.list() 与 refUse，不另存一份账：
       体检 = 现算覆盖度，批量 = 对选中的那几条调同一批单条入口，
       锚点 = chars.js 的 refPicOf（生成与导演台参考图共用），
       视觉相似 = dHash 在本机画布上算（不上传、不调模型）。 */
    function updateHealth() {
      if (!D) return;
      const all = D.Lib.list();
      const groups = D.Lib.groups().length;
      const needPic = all.filter(c => !D.voiceOnlyOf(c));
      const picOk = needPic.filter(c => !!D.picOf(c)).length;
      const needAsset = all.filter(c => !isProp(c) && !isScene(c) && !D.voiceOnlyOf(c) && D.Cast.assetTplsOf(c).length);
      const assetOk = needAsset.filter(c => D.Cast.assetsOf(c).length).length;
      const needVoice = all.filter(c => voiced(c));
      let voiceOk = 0;
      if (REG) needVoice.forEach(c => { try { if (D.Cast.voiceReady(REG, opts, c).ok) voiceOk++; } catch (e) { /* 这一位的声音就绪状态问不动就不计进「已有声音」 */ } });
      const descOk = all.filter(c => String(D.descOf(c) || '').trim()).length;
      const used = all.filter(c => (refUse.get(String(c.name || '')) || []).length).length;
      let ttsNote = '';
      if (!REG) ttsNote = '平台能力声明还没读回来，声音那一行暂时按「未配置」算。';
      else {
        try {
          const ways = D.Pipe.ttsWays(REG, opts);
          if (!ways.ok) ttsNote = '还没配可用的语音平台，声音那一行会显示全缺（到设置页「语音」那一档配一个）。';
        } catch (e) { /* 语音平台判据抛错就不写那句提示，体检照旧出 */ }
      }
      const rows = [
        { key: 'pic', label: '预览图', ok: picOk, need: needPic.length, filter: 'nopic', why: '没有预览图就不会出现在导演台的参考图候选里' },
        { key: 'asset', label: '角色资产', ok: assetOk, need: needAsset.length, filter: 'noasset', why: '角色资产是三视图 / 表情 / 服装，拍摄时作为参考图发出去' },
        { key: 'voice', label: '声音', ok: voiceOk, need: needVoice.length, filter: 'novoice', why: '还没有可用的音色配置（预设 / 描述 / 参考音频）' },
        { key: 'desc', label: '描述', ok: descOk, need: all.length, filter: 'nodesc', why: '描述是文字 AI 与生图提示词的底稿' },
      ].map(r => Object.assign(r, { pct: r.need ? Math.round(r.ok / r.need * 100) : 100 }));
      health.value = {
        total: all.length, groups, used, rows,
        note: ttsNote,
      };
    }
    function jumpFilter(f) {
      filter.value = f || 'all';
      resetPaging();
      render();
    }

    function selectedItems() {
      const ids = sel.value;
      return D ? D.Lib.list().filter(c => c && ids.has(c.id)) : [];
    }
    const isPicked = id => sel.value.has(id);
    function syncSel() {
      if (!D) return;
      const live = new Set(D.Lib.list().map(c => c && c.id));
      let ch = false;
      const next = new Set();
      sel.value.forEach(id => { if (live.has(id)) next.add(id); else ch = true; });
      if (ch) sel.value = next;
      batchCount.value = sel.value.size;
    }
    async function toggleMulti(force) {
      multi.value = force == null ? !multi.value : !!force;
      sel.value = new Set();
      batchCount.value = 0;
      batchText.value = '';
      await render();
    }
    async function toggleSel(c) {
      if (!c) return;
      const s = new Set(sel.value);
      if (s.has(c.id)) s.delete(c.id); else s.add(c.id);
      sel.value = s;
      batchCount.value = s.size;
      await paintCard(c);
    }
    async function batchRun(label, jobs, worker) {
      if (!jobs.length) return { done: 0, fails: 0 };
      batchBusy.value = true;
      batchText.value = label + '：0 / ' + jobs.length;
      stopFlag = false;
      fillStoppable = jobs.length > 1;
      stopDisabled.value = false;
      genSet('fill', null, label + '：0 / ' + jobs.length);
      let done = 0, fails = 0;
      try {
        await D.Pipe.runPool(jobs, FILL_CONC, async j => {
          if (stopFlag) return;
          try { await worker(j); } catch (e) { fails++; }
          done++;
          batchText.value = label + '：' + done + ' / ' + jobs.length;
          if (genHas('fill', null)) genSet('fill', null, batchText.value);
        });
      } finally {
        fillStoppable = false;
        genClear('fill', null);
        batchBusy.value = false;
        batchText.value = '';
        await render();
      }
      return { done, fails, stopped: stopFlag };
    }
    async function batchFillPics() {
      const items = selectedItems().filter(c => !D.voiceOnlyOf(c) && !D.picOf(c));
      if (!items.length) return Toast.warn('选中的素材都不缺预览图：没有要补的');
      if (!REG || !D.Pipe.pickProvModel(REG, 'image', opts.imgModel, 'text_to_image')) return Toast.err('现在没有可用的生图平台：去设置页配一把密钥，或在「出图型号」里挑一个');
      if (!await window.Confirm.ask({
        title: '给选中的 ' + items.length + ' 条补预览图',
        body: '每一条发一次生图请求（一次出一张），会花钱；中途可以按「停下」，但已经发出去的那些收不回来。',
        okLabel: '开始补图',
      })) return;
      const r = await batchRun('补预览图', items, async c => {
        const ok = await genRun('face', c.id, c, '', hook => D.Pipe.drawPreview(REG, fakeDrama(), c, { count: ONE, onTask: hook }), true);
        if (!ok) throw new Error('这一条没出成');
      });
      Toast[(r.fails ? 'warn' : 'ok')]('补预览图：' + r.done + ' 条处理完' + (r.fails ? '，' + r.fails + ' 条没成（原因留在各自卡片上）' : '') + (r.stopped ? '；已按「停下」' : ''), 7000);
    }
    async function batchFillAssets() {
      const items = selectedItems().filter(c => !isProp(c) && !isScene(c) && !D.voiceOnlyOf(c) && D.Cast.assetTplsOf(c).length && !D.Cast.assetsOf(c).length);
      if (!items.length) return Toast.warn('选中的角色都不缺角色资产：没有要补的');
      if (!REG || !D.Pipe.pickProvModel(REG, 'image', opts.imgModel, 'text_to_image')) return Toast.err('现在没有可用的生图平台：去设置页配一把密钥，或在「出图型号」里挑一个');
      if (!await window.Confirm.ask({
        title: '给选中的 ' + items.length + ' 位补角色资产',
        body: '每位发一次生图请求，出一张三视图（会拿身份锚点 / 预览图当参考）；会花钱，中途可以按「停下」。没有预览图的会跳过并写清原因。',
        okLabel: '开始补资产',
      })) return;
      const r = await batchRun('补角色资产', items, async c => {
        if (!D.picOf(c)) { errSet('asset#three', c.id, '预览图还没出：三视图要照着它画，这一步跳过了'); paintCard(c); throw new Error('没有预览图'); }
        const ok = await genRun('asset#three', c.id, c, '', hook => D.Pipe.drawCharAsset(REG, fakeDrama(), c, 'three', { count: ONE, onTask: hook }), true);
        if (!ok) throw new Error('这一位没出成');
      });
      Toast[(r.fails ? 'warn' : 'ok')]('补角色资产：' + r.done + ' 位处理完' + (r.fails ? '，' + r.fails + ' 位没成（原因留在各自卡片上）' : '') + (r.stopped ? '；已按「停下」' : ''), 7000);
    }
    async function batchFillVoices() {
      if (!REG) return Toast.err('平台能力声明还没读回来，等这一页加载完再试');
      const items = selectedItems().filter(c => voiced(c) && !D.Cast.voiceReady(REG, opts, c).ok);
      if (!items.length) return Toast.warn('选中的角色都不缺声音配置：没有要补的');
      if (!window.TextAI) return Toast.err('文字 AI 模块还没加载');
      if (!await window.Confirm.ask({
        title: '让 AI 给选中的 ' + items.length + ' 位定声音',
        body: '逐位按人设写一段音色描述 / 选一个音色（调用文字 AI，会消耗 tokens；不会合成音频，也不会上传素材）。'
          + '定好之后自动落盘，之后在编辑区随时能改或试听。',
        okLabel: '开始定声音',
      })) return;
      const r = await batchRun('AI 定声音', items, async c => {
        const got = await D.Pipe.autoVoice(REG, fakeDrama(), c, {});
        if (!got.ok) { errSet('voice', c.id, got.why || 'AI 没给出可用的音色'); paintCard(c); throw new Error(got.why || '没定成'); }
        c.voiceBy = 'ai';
        libSave(c);
        paintCard(c);
      });
      Toast[(r.fails ? 'warn' : 'ok')]('AI 定声音：' + (r.done - r.fails) + ' 位定好' + (r.fails ? '，' + r.fails + ' 位没成（原因留在各自卡片上）' : '') + (r.stopped ? '；已按「停下」' : ''), 7000);
    }
    async function batchSetGroup() {
      const items = selectedItems();
      if (!items.length) return Toast.warn('先勾几条素材再点这一颗');
      const g = String(batchGroup.value || '').trim().slice(0, 20);
      /* 留空是「清空分组」而不是「不修改」：一屏几十条的分组归属一次全没，
         而界面看起来只是用户点了一下按钮 —— 这一种必须先用一句话确认。 */
      if (!g && !await window.Confirm.ask({
        title: '清掉选中的 ' + items.length + ' 条的分组',
        body: '这几条会变成「未分组」（素材本身不删，分组之外的一切不受影响）。要只是改某一条的分组，取消后在它的卡片里改。',
        okLabel: '清空分组', danger: true,
      })) return;
      for (const c of items) { c.group = g; libSave(c); }
      await render();
      Toast.receipt('已把 ' + items.length + ' 条设为' + (g ? '分组「' + g + '」' : '未分组'));
    }
    async function batchRemove() {
      const items = selectedItems();
      if (!items.length) return Toast.warn('先勾几条素材再点这一颗');
      const busy = items.filter(c => genOn(c));
      if (busy.length) return Toast.err('有 ' + busy.length + ' 条正在生成（' + busy.map(c => c.name).slice(0, 3).join('、') + '），等它们出来或按「停下」再删', 7000);
      if (!await window.Confirm.ask({
        title: '删掉选中的 ' + items.length + ' 条素材',
        body: '会从素材库里删掉这几条（本机存的参考音频一起删）；导演台里已经写下的 @名字 不会自动清理，改好的镜头不受影响。',
        okLabel: '删掉', danger: true,
      })) return;
      let ok = 0;
      for (const c of items) {
        try { if (c.refAudio) await D.Pipe.clearRefAudio(c); } catch (e) { /* 参考音频清不掉不拦这一条素材的其余删除动作 */ }
        if (D.Lib.remove(c.id)) ok++;
      }
      const e = D.Lib.writeError();
      sel.value = new Set();
      multi.value = false;
      batchCount.value = 0;
      openId.value = '';
      await render();
      if (e) Toast.err(e, 9000); else Toast.receipt('已删掉 ' + ok + ' 条素材');
    }

    /* 参考图质量：只量「浏览器真的解码出来的尺寸」，不猜主体、不打分 ——
       短边 / 长宽比是能直接看见的两件事，而「这张像不像本人」机器判不了。 */
    const IMGQ = new Map();
    function measureImg(src) {
      if (!src) return Promise.resolve(null);
      if (IMGQ.has(src)) return Promise.resolve(IMGQ.get(src));
      return new Promise(res => {
        const img = new Image();
        let done = false;
        const fin = v => { if (!done) { done = true; if (v && v.ok) { if (IMGQ.size > 800) IMGQ.clear(); IMGQ.set(src, v); } res(v); } };
        const t = setTimeout(() => fin({ ok: false, why: '这张图 8 秒没读出来' }), 8000);
        img.onload = () => {
          clearTimeout(t);
          const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
          if (!w || !h) return fin({ ok: false, why: '这张图量不出尺寸' });
          const min = Math.min(w, h), ratio = w / h;
          let level = 'good', why = '短边 ' + min + 'px，做身份参考够用';
          if (min < 512) { level = 'low'; why = '短边只有 ' + min + 'px：脸会糊，建议换一张更大的正脸'; }
          else if (min < 768) { level = 'ok'; why = '短边 ' + min + 'px，能用；再大一点更像本人'; }
          if (ratio > 2.2 || ratio < 0.45) {
            if (level === 'good') level = 'ok';
            why += '；长宽比 ' + ratio.toFixed(2) + '，人物可能被裁得很小';
          }
          fin({ ok: true, w, h, ratio, level, why });
        };
        img.onerror = () => { clearTimeout(t); fin({ ok: false, why: '这张图现在取不到（地址可能过期了）' }); };
        img.src = window.Api.mediaSrc(src);
      });
    }
    async function paintQuality(c) {
      if (!c) return;
      const el = cardEl(c.id) && cardEl(c.id).querySelector('[data-q]');
      if (!el) return;
      const src = c.anchor || D.picOf(c);
      if (!src) { el.textContent = '还没有图：先出 / 挑一张预览图，再设身份锚点。'; el.className = 'anchorq low'; return; }
      el.textContent = '正在量参考图…';
      const q = await measureImg(src);
      if (!el.isConnected) return;
      const where = c.anchor ? '身份锚点' : '预览图';
      el.textContent = where + '：' + (q && q.ok ? (q.w + '×' + q.h + ' · ' + q.why) : ((q && q.why) || '量不出来'));
      el.className = 'anchorq ' + (q && q.ok ? q.level : 'low');
    }

    /* 视觉相似（离线）：dHash 64 位 + 汉明距离。不上传、不调模型、不花钱；
       只比主图与角色资产，返回同一份素材里的「像」的那几张。 */
    const DHASH = new Map();
    const popcnt = x => { let n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
    function imgHash(src) {
      if (!src) return Promise.resolve(null);
      if (DHASH.has(src)) return Promise.resolve(DHASH.get(src));
      return new Promise(res => {
        const img = new Image();
        let done = false;
        const fin = v => { if (!done) { done = true; if (v != null) { if (DHASH.size > 800) DHASH.clear(); DHASH.set(src, v); } res(v); } };
        const t = setTimeout(() => fin(null), 8000);
        img.onload = () => {
          clearTimeout(t);
          try {
            const cv = document.createElement('canvas');
            cv.width = 9; cv.height = 8;
            const g = cv.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0, 9, 8);
            const d = g.getImageData(0, 0, 9, 8).data;
            let bits = 0n;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
              const i = (y * 9 + x) * 4, j = i + 4;
              const a = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
              const b = d[j] * .299 + d[j + 1] * .587 + d[j + 2] * .114;
              bits = (bits << 1n) | (a > b ? 1n : 0n);
            }
            fin(bits);
          } catch (e) { fin(null); }
        };
        img.onerror = () => { clearTimeout(t); fin(null); };
        img.src = window.Api.mediaSrc(src);
      });
    }
    function libraryImages() {
      const out = [], seen = new Set();
      if (!D) return out;
      const add = x => { if (!x || !x.src || seen.has(x.src)) return; seen.add(x.src); out.push(x); };
      D.Lib.list().forEach(c => {
        const pic = D.picOf(c);
        if (pic) add({ id: c.id, name: c.name || '', src: pic, label: picWord(c) });
        D.Cast.assetsOf(c).forEach(a => {
          if (a && a.src) add({ id: c.id, name: c.name || '', src: a.src, label: D.Cast.assetName(a) || '资产' });
        });
      });
      return out;
    }
    async function locateItem(id) {
      const c = D.Lib.get(id);
      if (!c) return Toast.warn('这一条已经不在了');
      filter.value = 'all'; group.value = ''; q.value = ''; aiPick = null; aiWhy = ''; aiRank = null;
      openId.value = id;
      resetPaging();
      await render();
      await nextTick();
      const el = cardEl(id);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    async function findSimilar(c, src) {
      const target = src || (c && (c.anchor || D.picOf(c))) || '';
      if (!target) return Toast.err('这一条还没有图：先出 / 挑一张预览图再找相似');
      if (D.Lib.list().length <= 1) return Toast.warn('素材库里只有这一条，没有可比的对象');
      setBusy('正在按画面指纹找相似（本机比对，不上传）…');
      try {
        const th = await imgHash(target);
        if (!th) { Toast.err('这一张取不到画面，没法比对（地址可能过期了）'); return; }
        const pool = libraryImages().filter(x => x.src !== target);
        const hits = [];
        await D.Pipe.runPool(pool, 4, async x => {
          const h = await imgHash(x.src);
          if (!h) return;
          hits.push(Object.assign({}, x, { d: popcnt(th ^ h) }));
        });
        hits.sort((a, b) => a.d - b.d);
        const top = hits.filter(x => x.d <= 18).slice(0, 24);
        if (!top.length) { Toast.warn('没有找到明显相似的画面（只比主图与角色资产，纯画面指纹）'); return; }
        window.UiDialog.open({
          title: '和这一张相似的素材',
          sub: '本机离线比对（dHash）· 距离越小越像 · 点一条定位到它',
          body(el, close) {
            el.innerHTML = '<div class="sim-src">' + thumbImg(target) + '<span>这一张</span></div>'
              + '<div class="sim-grid">' + top.map(x => '<button class="sim" data-sim="' + esc(x.id) + '" title="' + esc(x.name + ' · ' + x.label + ' · 距离 ' + x.d) + '">'
                + thumbImg(x.src)
                + '<span>' + esc(x.name || '（无名）') + '<i>' + esc(x.label) + ' · ' + x.d + '</i></span></button>').join('') + '</div>';
            window.Wb.thumbs.bindAll(el);
            el.querySelectorAll('[data-sim]').forEach(b => { b.onclick = () => { close(null); locateItem(b.dataset.sim); }; });
          },
          actions: [{ label: '关闭', value: null }],
        });
      } finally { setBusy(''); }
    }

    /* ---------- 「存回本机」 ---------- */
    function localSlots(c) {
      const out = [];
      const k = CANDK[mainKind(c)];
      if (k) { const v = k.got(c); if (v) out.push({ lab: k.lab, src: v, set: x => k.set(c, x) }); }
      if (c.refAudio) out.push({ lab: '参考音频', src: c.refAudio, set: x => { c.refAudio = x; } });
      const list = D.Cast.assetsOf(c);
      list.forEach((a, i) => out.push({
        lab: a.name || '资产', src: a.src,
        set: x => { list[i] = Object.assign({}, list[i], { src: x }); D.Cast.assetsSave(c, list); },
      }));
      return out.filter(s => s.src && !window.AssetLocal.hasLocalAddr(s.src));
    }
    function localPlan() {
      const jobs = [];
      viewItems.forEach(c => { if (c) localSlots(c).forEach(s => jobs.push({ c, lab: s.lab, src: s.src, set: s.set })); });
      return jobs;
    }
    function paintLocalBtn() {
      if (!btnLocalEl.value || !D) return;
      window.AssetLocal.pullBtn(btnLocalEl.value, localPlan().length, {
        icon: false, disableEmpty: true, busyText: '正在存回本机…',
        zone: '这一档', what: '素材', unit: '个',
        empty: viewItems.length ? '这一档筛出来的素材，本机都已经有了，不用再存' : '这一档里还没有素材',
      });
    }
    async function pullLocal() {
      const btn = btnLocalEl.value;
      if (!D || !btn || window.AssetLocal.pullBusy(btn)) return;
      const jobs = localPlan();
      if (!jobs.length) { Toast.warn(viewItems.length ? '这一档要存的本机都已经有了' : '这一档里还没有素材'); return; }
      window.AssetLocal.pullStart(btn);
      paintLocalBtn();
      const dirty = new Set();
      const st2 = await window.AssetLocal.pullMany(jobs.map(j => ({
        entry: { url: j.src, rawSrc: j.src, prompt: (j.c.name || '素材') + '-' + j.lab },
        name: (j.c.name || '这条素材') + ' 的' + j.lab,
        apply: u => { j.set(u); dirty.add(j.c); },
      })), { onProgress: (done, total) => setBusy('存回本机：' + done + ' / ' + total + ' 个…') });
      let lost = 0;
      dirty.forEach(c => { if (!libSave(c)) lost++; });
      window.AssetLocal.pullEnd(btn);
      setBusy('');
      render();
      window.AssetLocal.pullReceipt(st2, {
        extra: [lost ? '有 ' + lost + ' 条没写进库，那几格刷新会退回外链（保存为什么失败见上面那条提示）' : ''],
        failed: lost,
        none: '一个都没存进本机',
        nothing: '这一档没有需要存的',
      });
    }

    /* 挑来的图先落成本机资产再记进库。 */
    async function durablePic(it, name) {
      if (!it) return '';
      setBusy('正在把这一张存进本机资产…');
      try {
        const r = await window.AssetTransfer.toLocalAsset(it.file || it.dl || it.src || it.url, { name, from: it.provider || 'picker' });
        return r.src;
      } catch (e) {
        setBusy('');
        Toast.err('这一张存不进素材库：' + errText(e));
        return '';
      }
    }
    function keep(c, keepOpen) {
      libSave(c);
      if (!keepOpen) openId.value = '';
      setBusy('');
      if (openId.value === c.id) { paintCard(c); paintChips(); }
      else render();
    }
    async function toggleEdit(id, force) {
      const on = force == null ? openId.value !== id : !!force;
      openId.value = on ? id : '';
      await render();
      if (!on) return;
      await nextTick();
      const el = cardEl(id);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function openZoom(c, label, s2) {
      if (!s2) { Toast.err('这一条还没有这张图'); return; }
      const i = media.findIndex(x => x.s === s2);
      if (i >= 0) window.Wb.lightbox.open(media[i]);
      else window.Wb.lightbox.open({ key: 'char:' + c.id + ':' + s2, s: s2, name: c.name + ' · ' + (label || '图'), item: c });
    }

    async function pickRefAudio(c) {
      const rr = D.Cast.refAudioRule(REG, opts);
      const got = await window.AssetPicker.open({ types: rr.types, multiple: false, limit: 1,
        title: '给「' + c.name + '」选一段参考音频', rule: rr.rule, upload: rr.upload });
      if (!got || !got.length) return;
      setBusy('正在读这段参考音频…');
      const it = got[0];
      const b = it.file || await window.Net.blob(it.dl || it.src, { timeout: 120000 });
      if (rr.rule.maxBytes && b.size > rr.rule.maxBytes) { setBusy(''); return Toast.err('参考音频太大：上限 ' + window.fmtBytes(rr.rule.maxBytes) + '，这段 ' + window.fmtBytes(b.size)); }
      await D.Pipe.saveRefAudio(c, b, (it.prompt || it.name || '参考音频').slice(0, 20));
      keep(c, true);
      Toast.receipt('参考音频挂上了，可以试听；视频型号有「参考音频」槽位时也会一起发过去');
    }

    /* ---------- 卡片上的动作（事件委托按名字派到这里） ---------- */
    const ACTS = {
      edit: async (c) => { toggleEdit(c.id); },
      closeedit: async (c) => { toggleEdit(c.id, false); },
      /* 卡上直接改名：打开编辑区并把光标放进名字那一格（改名确认与全片回填走
         onFieldSave 的 name 分支 —— 那条链已有「将回填 N 处」提示，不另写一套）。 */
      rename: async (c) => {
        await toggleEdit(c.id, true);
        const el = cardEl(c.id);
        const inp = el && el.querySelector('[data-f="name"]');
        if (inp) { inp.focus(); inp.select(); }
      },
      face: async (c) => {
        const pw = picWord(c);
        await genRun('face', c.id, c, '正在出「' + c.name + '」的' + pw + '（' + candCount() + ' 张）…',
          () => D.Pipe.drawPreview(REG, fakeDrama(), c, { count: candCount(), replace: true, onTask: onTaskHook }));
      },
      morecand: async (c, el) => { await moreCands(c, el.dataset.k || mainKind(c)); },
      usecand: async (c, el) => { useCand(c, el.dataset.k || mainKind(c), el.dataset.src); },
      canddel: async (c, el) => {
        const k = CANDK[el.dataset.k || mainKind(c)]; if (!k) return;
        const r2 = D.Cast.dropFaceCand(c, el.dataset.src, { got: k.got, set: k.set });
        if (!r2.ok) return Toast.err(r2.why);
        const ok = !!libSave(c);
        paintCard(c);
        if (ok) Toast.receipt('删掉了这一张候选' + (r2.left ? '，还剩 ' + r2.left + ' 张' : '（这一类清空了）'));
      },
      del: async (c, el) => {
        const busy = genOn(c);
        if (busy) return Toast.err('这一条正有一项在生成（' + errLabel(busy, c) + '），等它出来或按「停下」再删 —— 现在删掉，那一轮收尾会把它写回库里');
        if (window.Confirm.arm(el, '确认删掉', { note: '本机存的参考音频一起删；导演台里已经写下的 @名字 不会自动清理，改好的镜头不受影响' })) return;
        if (c.refAudio) await D.Pipe.clearRefAudio(c);
        const gone = D.Lib.remove(c.id);
        const e = D.Lib.writeError();
        if (e) Toast.err(e, 9000);
        if (gone) {
          ERR.forEach((v, k) => { if (k.endsWith('#' + c.id)) ERR.delete(k); });
          openId.value = '';
          render();
        }
      },
      reuse: (c, el) => {
        const s2 = el.dataset.src || '';
        if (!s2) return Toast.err('这一条还没有图，先在编辑区挑一张或让 AI 出一张');
        window.Wb.reuse.go({ from: 'chars', mtype: '图片', src: s2, name: el.dataset.name || c.name || '' });
      },
      setanchor: (c, el) => {
        const s2 = el.dataset.src || '';
        if (!s2) return Toast.err('这一张没有地址');
        c.anchor = s2;
        libSave(c);
        paintCard(c);
        Toast.receipt('身份锚点已设为这一张：之后出图 / 出资产 / 导演台取参考图都优先用它');
      },
      clearanchor: (c) => {
        if (!c.anchor) return;
        delete c.anchor;
        libSave(c);
        paintCard(c);
        Toast.receipt('已取消身份锚点，改回跟随预览图');
      },
      similar: (c, el) => findSimilar(c, el.dataset.src || ''),
      pickface: async (c) => {
        const pw = picWord(c);
        const got = await window.AssetPicker.open({ types: ['图片'], multiple: false, limit: 1,
          title: '给「' + c.name + '」选一张' + pw,
          note: isProp(c) ? '道具图就是道具自己：挑一张最像的，拍每一段时它都会作为参考图发出去'
            : pw + '是三视图与拍摄时认脸的凭据，挑一张最像的' });
        if (got && got[0]) { const s2 = await durablePic(got[0], c.name + '-' + pw); if (s2) { D.setPic(c, s2); keep(c, true); } }
      },
      assetpick2: async (c, el, card) => {
        const box = el.closest('.ui-cands') || card;
        const nm = (box.querySelector('[data-a="assetname"]') || {}).value || '';
        const tpl = (box.querySelector('[data-a="assettpl"]') || {}).value || 'custom';
        const got = await window.AssetPicker.open({ types: ['图片'], multiple: false, limit: 1,
          title: '给「' + c.name + '」加一张角色资产', note: '不靠生成，直接用现成的这一张' });
        if (got && got[0]) { const s2 = await durablePic(got[0], c.name + '-' + (nm.trim() || got[0].name || '资产')); if (s2) { D.Cast.addAsset(c, { name: nm.trim(), tpl: tpl, src: s2 }); keep(c, true); } }
      },
      assetgen: async (c, el, card) => {
        const box = el.closest('.ui-cands') || card;
        const nm = (box.querySelector('[data-a="assetname"]') || {}).value || '';
        const tpl = (box.querySelector('[data-a="assettpl"]') || {}).value || 'three';
        const what = (box.querySelector('[data-a="assetwhat"]') || {}).value || '';
        if (tpl === 'custom' && !what.trim()) { Toast.err('选「自定义」要写清楚要画什么，例：雨天造型、侧脸特写'); return; }
        const lab = nm.trim() || D.Cast.assetLabel(c, tpl) || '资产';
        const n = ONE;
        const ok = await genRun('asset#new:' + tpl, c.id, c,
          '正在出「' + c.name + '」的' + lab + '…',
          () => D.Pipe.drawCharAsset(REG, fakeDrama(), c, tpl, { count: n, name: nm.trim(), what: what.trim(), onTask: onTaskHook }),
          false, lab);
        if (ok) DRAFT.set(c.id, { name: '', tpl: tpl, what: '' });
      },
      assetregen: async (c, el) => {
        const a = D.Cast.assetById(c, el.dataset.id);
        if (!a) return Toast.err('这一张已经不在了');
        const lab = D.Cast.assetName(a);
        await genRun('asset#' + a.id, c.id, c, '正在重出「' + c.name + '」的' + lab + '…',
          () => D.Pipe.drawCharAsset(REG, fakeDrama(), c, a.tpl, { count: ONE, name: lab, replaceId: a.id, onTask: onTaskHook }));
      },
      assetclear: async (c, el) => {
        const id = el.dataset.id; if (!id) return;
        const lab = el.dataset.label || '这一张';
        if (window.Confirm.arm(el, '确认去掉' + lab, { note: '素材库里这一张会空出来；已经拉进某一集的那条不受影响' })) return;
        D.Cast.removeAsset(c, id);
        keep(c, true);
        Toast.receipt('去掉了「' + c.name + '」的' + lab);
      },
      assetprop: async (c, el) => {
        const a = D.Cast.assetById(c, el.dataset.id);
        if (!a) return Toast.err('这一张已经不在了');
        const pid = el.dataset.pid;
        const now = (a.propIds || []).slice();
        const i = now.indexOf(pid);
        if (el.checked) { if (i < 0) now.push(pid); } else if (i >= 0) now.splice(i, 1);
        D.Cast.setAssetProps(c, a.id, now);
        keep(c, true);
      },
      refclear: async (c) => { await D.Pipe.clearRefAudio(c); keep(c, true); },
      play: async (c) => {
        await genRun('voice', c.id, c, '正在合成「' + c.name + '」的试听…', async () => {
          const r = await D.Cast.preview(REG, opts, c, { onStage: m => genSet('voice', c.id, m) });
          if (r.why) Toast.err(r.why);
          else if (r.label) Toast.ok('试听：' + r.label);          // 只复述当前状态，归安静档
        });
      },
      voice: async (c, el) => { c.voice = el.dataset.vid; c.voiceName = D.Cast.voiceName(REG, opts, c.voice, c.voiceMode); keep(c, true); },
      voiceway: async (c, el) => {
        const w = D.Pipe.setVoiceWay(REG, opts, c, el.dataset.way);
        c.voiceBy = ''; c.voiceName = D.Cast.voiceName(REG, opts, c.voice, w.mode);
        keep(c, true);
        if (w.fellback) Toast.err('这个平台没有「' + D.Cast.wayLabel(el.dataset.way) + '」的型号，这一位现在按「' + D.Cast.wayLabel(w.mode) + '」出声');
      },
      refaudio: async (c) => { await pickRefAudio(c); },
      /* 「用素材库里的另一位」那两条（用户要求：「使用素材进行描述或克隆」）：
         · vnotepick —— 拿别人写好的**音色描述**填进这一格（描述档）；
         · vaudiopick —— 拿别人挂着的**参考音频**当这一位的嗓子（复刻档）。
         两条都走公共层 `window.VoiceNote`（导演台与生成工作台那两格走的是同一条链）——
         这里再写一份选择器与措辞，迟早有一种说法在骗人。 */
      vnotepick: async (c) => {
        await window.VoiceNote.run({
          value: () => c.voiceNote || '',
          write: t => { c.voiceNote = t; c.voiceMode = 'design'; keep(c, true); render(); },
          say: () => {},
        });
      },
      vaudiopick: async (c) => {
        await window.VoiceNote.runClone({
          apply: (entry) => {
            const r = D.Pipe.cloneFromLibEntry(REG, opts, c, entry);
            if (!r.ok) { Toast.err(r.why); return; }
            keep(c, true);
            Toast.receipt('这一位以后按「' + r.name + '」这个声音念（复刻），拉进下一集也是它', 'ok', 6000);
            render();
          },
          say: () => {},
        });
      },
      revoice: async (c) => {
        await genRun('voicecands', c.id, c, '正在按人设定「' + c.name + '」的声音…', async () => {
          const live = aiPanel();
          const r = await D.Pipe.autoVoice(REG, fakeDrama(), c, {
            cands: true, onDelta: live.push,
            onStage: m => genSet('voicecands', c.id, m),
            onCands: (i, tot) => genSet('voicecands', c.id, '正在给「' + c.name + '」合成第 ' + i + ' / ' + tot + ' 条试听…'),
          }).finally(() => live.done());
          if (!r.ok) { c.voiceErr = r.why || '没定成'; c.voiceAuto = ''; }
        });
      },
      vgen: async (c, el) => {
        const n = Math.max(1, Number(el.dataset.n) || 2);
        await genRun('voicecands', c.id, c, '正在给「' + c.name + '」出 ' + n + ' 条试听…',
          () => D.Pipe.voiceCands(REG, opts, c, {
            onStep: (i, tot, nm) => genSet('voicecands', c.id,
              '正在出「' + c.name + '」第 ' + i + ' / ' + tot + ' 条' + (nm ? '（' + nm + '）' : '') + '…')
          }));
      },
      vplay: async (c, el) => {
        const r = await D.Cast.playAsset(el.dataset.src);
        if (r.why) Toast.err(r.why);
      },
      vclone: async (c, el) => {
        const r = D.Pipe.cloneFromCands(REG, opts, c, el.dataset.src, el.dataset.name);
        if (!r.ok) { Toast.err(r.why); return; }
        keep(c, true);
        Toast.receipt('这一位以后按「' + r.name + '」这个声音念（复刻），拉进下一集也是它', 'ok', 6000);
        render();
      },
      vuse: async (c, el) => {
        c.voice = el.dataset.vid;
        c.voiceName = el.dataset.vname || D.Cast.voiceName(REG, opts, c.voice, c.voiceMode);
        keep(c, true);
        Toast.receipt('这一位以后按「' + (c.voiceName || c.voice) + '」念');
      },
      /* 候选排里的缩略图（picCandsHTML 用的是 data-act="zoom"）：两页共用那份标记，
         点开看大图这一件事也得在这边接上 —— 不接就是一张点不开的小图。 */
      zoom: async (c, el) => { openZoom(c, el.dataset.label || el.dataset.name || '图', el.dataset.src); },
    };

    function invoke(fn, c, el, card) {
      if (!fn) return;
      Promise.resolve().then(() => fn(c, el, card)).catch(err => {
        Toast.err(errText(err));
        setBusy('');
      });
    }

    /* ---------- 网格上的事件委托 ---------- */
    function onGridClick(e) {
      const root = gridEl.value;
      if (!root || !e.target || !e.target.closest) return;
      /* 多选态：点卡片正文 = 勾选；按钮区（.acts）与编辑区照旧可用 ——
         否则想一边多选一边改一条就得退出多选。 */
      const card0 = e.target.closest('.card');
      const c0 = card0 && itemOf(card0.dataset.id);
      if (multi.value && c0 && !e.target.closest('.acts') && !e.target.closest('.edit')) {
        e.preventDefault();
        toggleSel(c0);
        return;
      }
      const t = e.target.closest('[data-a],[data-act]');
      if (!t || !root.contains(t)) return;
      if (t.hasAttribute('data-f')) return;
      const card = t.closest('.card');
      const c = card && itemOf(card.dataset.id);
      if (!c) return;
      const a = t.dataset.a || '';
      if (a === 'zoom' || a === 'zoomface') {
        e.stopPropagation();
        openZoom(c, a === 'zoomface' ? picWord(c) : (t.dataset.label || '图'), t.dataset.src || D.picOf(c));
        return;
      }
      if (a) {
        if (a === 'assetname' || a === 'assetwhat' || a === 'assettpl' || a === 'assetrename') return;
        invoke(ACTS[a], c, t, card);
        return;
      }
      const act = t.dataset.act || '';
      if (!act || act === 'voicenote') return;
      invoke(ACTS[act], c, t, card);
    }
    /* 拖动一张卡 = 引用这一条（载荷唯一出口在 web/domain/asset-ref.cjs）。
       卡片整块可拖，卡里的图因此要显式 draggable="false"：否则浏览器先按「拖一张图」起势，
       拿到的是一份图片地址，而不是这一条的引用。 */
    function onGridDragStart(e) {
      const card = e.target && e.target.closest ? e.target.closest('.card') : null;
      if (!card || !gridEl.value || !gridEl.value.contains(card)) return;
      if (e.target.closest('input,textarea,select,button,a,[contenteditable]')) { e.preventDefault(); return; }
      const c = itemOf(card.dataset.id);
      if (!c || !window.AssetRef) { e.preventDefault(); return; }
      const p = window.AssetRef.set(e.dataTransfer, {
        kind: 'char', id: c.id, name: c.name, type: '图片', mtype: '图片',
        src: D.picOf(c), prompt: c.look || c.bio || '', from: 'chars',
      });
      if (!p) { e.preventDefault(); return; }
      card.classList.add('dragging');
    }
    function onGridDragEnd(e) {
      const card = e.target && e.target.closest ? e.target.closest('.card') : null;
      if (card) card.classList.remove('dragging');
    }
    function onGridInput(e) {
      const t = e.target;
      if (!t || !gridEl.value) return;
      const card = t.closest && t.closest('.card');
      const c = card && itemOf(card.dataset.id);
      if (!c) return;
      if (t.dataset && t.dataset.f) {
        if (t.tagName === 'SELECT' || t.type === 'checkbox') return;
        const k = t.dataset.f;
        c[k] = t.value;
        if (k !== 'name') queueFieldSave(c);
        return;
      }
      const a = t.dataset && t.dataset.a;
      if (a === 'assetname' || a === 'assetwhat') { syncDraft(card, c); return; }
      if (t.dataset && t.dataset.act === 'voicenote') c.voiceNote = t.value;
    }
    function onGridChange(e) {
      const t = e.target;
      if (!t || !gridEl.value) return;
      const card = t.closest && t.closest('.card');
      const c = card && itemOf(card.dataset.id);
      if (!c) return;
      if (t.dataset && t.dataset.f) {
        const k = t.dataset.f;
        if (t.type === 'checkbox') { saveField(c, t, k); paintCard(c); paintChips(); }
        else if (t.tagName === 'SELECT') { saveField(c, t, k); render(); }
        return;
      }
      if (t.dataset && t.dataset.a === 'assettpl') { syncDraft(card, c); syncWhat(card); return; }
      if (t.dataset && (t.dataset.a === 'assetname' || t.dataset.a === 'assetwhat')) { syncDraft(card, c); return; }
      if (t.dataset && t.dataset.a === 'assetrename') { renameAsset(c, t); return; }
    }
    function onGridFocusIn(e) {
      const t = e.target;
      if (!t || !t.dataset || t.dataset.f !== 'name') return;
      const card = t.closest && t.closest('.card');
      const c = card && itemOf(card.dataset.id);
      if (c) nameBefore = String(c.name || '').trim();
    }
    function onGridFocusOut(e) {
      const t = e.target;
      if (!t || !gridEl.value) return;
      const card = t.closest && t.closest('.card');
      const c = card && itemOf(card.dataset.id);
      if (!c) return;
      if (t.dataset && t.dataset.f) {
        if (t.type === 'checkbox' || t.tagName === 'SELECT') return;
        clearTimeout(fieldTimer);
        saveField(c, t, t.dataset.f);
        queueHeads(c);
        return;
      }
      if (t.dataset && t.dataset.act === 'voicenote') libSave(c);
    }
    async function saveField(c, el, k) {
      const wasKind = D.libKindOf(c);
      c[k] = el.type === 'checkbox' ? el.checked : (el.value.trim ? el.value.trim() : el.value);
      if (k === 'kind' && D.libKindOf(c) !== wasKind) {
        const to = c.kind;
        if (D.Lib.list().some(x => x && x.id !== c.id && x.name === c.name && D.libKindOf(x) === to)) {
          c.kind = wasKind; el.value = wasKind;
          Toast.err('素材库里已经有「' + c.name + '」这条' + (D.LIB_KINDS[to] || '同类') + '了：换成这一类就是两条一样的素材。先把名字改掉再换类型', 7000);
          return k;
        }
      }
      if (k === 'name' && nameBefore && String(c.name || '').trim() !== nameBefore) {
        const n = (refUse.get(nameBefore) || []).length;
        if (n) {
          const ok = await window.Confirm.ask({
            title: '这个名字有 ' + n + ' 处引用',
            body: '导演台里有 ' + n + ' 个镜头的提示词写着 @' + nameBefore + '。改名后会按 id 自动把那 ' + n + ' 处刷成 @' + String(c.name || '').trim() + '（refMeta.id 不动，引用不断）。仍然改吗？',
            okLabel: '改名并回填',
          });
          if (!ok) { c.name = nameBefore; el.value = nameBefore; queueHeads(c); return k; }
        }
      }
      const saved = libSave(c);
      if (k === 'name' && saved) {
        c.name = saved.name; el.value = saved.name;
        /* 改名回填（14.1-3）：按 id 找全片 refMeta 条目 → 刷 label；正文 @旧名 刷成 @新名。
           refMeta.id 一个字不动 —— 身份与名字分开。 */
        if (nameBefore && saved.name !== nameBefore) {
          try { backfillRename(c, nameBefore, saved.name); } catch (e) { /* 回填失败不影响改名本身 */ }
        }
        nameBefore = saved.name;
      }
      return k;
    }
    /* 改名回填：扫全片，把 refMeta.id === c.id 的 label 刷成新名、正文 @旧名 刷成 @新名。
       回执报「N 处引用已改名」。老工程 refMeta 没 id 的按 label 兜底匹配一次（只读不写 id）。 */
    function backfillRename(c, oldName, newName) {
      let n = 0;
      try {
        const ws = window.Kv && Kv.at ? null : null;   // 同步路径走 D.* 的工程数据
        const D2 = window.D;
        if (!D2 || !D2.Lib) return 0;
        const projects = (window.projAll && window.projAll()) || [];
        projects.forEach(p => ((p && p.scenes) || []).forEach(sc => ((sc && sc.shots) || []).forEach(sh => {
          if (!sh) return;
          /* ① refMeta 按 id 找到这条 → 刷 label */
          (Array.isArray(sh.refMeta) ? sh.refMeta : []).forEach(rm => {
            if (rm && rm.id === c.id) { rm.label = (rm.label || '').replace(oldName, newName); n++; }
            else if (!rm && rm.label && rm.label.indexOf(oldName) >= 0) { rm.label = rm.label.replace(oldName, newName); n++; }
          });
          /* ② 正文 @旧名 刷成 @新名 */
          const txt = String(sh.prompt || '');
          if (txt.indexOf('@' + oldName) >= 0) {
            sh.prompt = txt.split('@' + oldName).join('@' + newName);
            n++;
          }
        })));
      } catch (e) { /* 工程数据不可达时回填跳过 */ }
      if (n) Toast.receipt('改名完成：' + n + ' 处引用已跟着改');
      return n;
    }
    function renameAsset(c, inp) {
      const nm = String(inp.value || '').trim();
      const a = D.Cast.assetById(c, inp.dataset.id);
      if (!a) return;
      if (!nm) { inp.value = D.Cast.assetName(a); Toast.err('名字不能是空的：这是角色资产，没名字就分不清是哪一张'); return; }
      if (nm === D.Cast.assetName(a)) return;
      D.Cast.setAssetName(c, a.id, nm); keep(c, true);
      Toast.receipt('这一张改叫「' + nm + '」');
    }

    /* ---------- AI 找素材 ---------- */
    const AI = {
      label: 'AI 找素材',
      btn: () => aiFindBtn.value,
      ask: () => q.value,
      focus: () => { if (toolbarFb) toolbarFb.focus(); },
      emptyMsg: '还没有素材 —— 点「新建素材」，或去导演台用「拆分镜」自动建档',
      noneMsg: 'AI 没挑到合适的（换个说法再试）',
      roster: () => D.Lib.list(),
      field: 'ids',
      known: x => !!D.Lib.get(x),
      payload: (query, all) => ({
        需求: query,
        素材库: all.map(c => ({
          id: c.id, 名字: c.name, 类型: D.LIB_KINDS[D.libKindOf(c)], 分组: c.group || '', 人设: c.bio || '', 描述: c.look || '',
        })),
      }),
      sys: '你是选角导演：用户会用一句话描述需求，你要从他收藏的素材里挑最合适的几条。\n'
        + '规则：\n1. 只输出 JSON，不要解释、不要 markdown：{"ids":["素材ID"],"summary":"一句话说明按什么挑的"}\n'
        + '2. 优先级：外貌/描述 > 一句话人设/用途 > 类型（角色出镜、场景是地方不是人、道具是物件）。\n'
        + '3. 宁缺毋滥：没有合适的就返回空数组。\n4. summary 说清你的理解，界面会显示给用户。',
      apply: s => { aiPick = s.pick; aiRank = s.rank; aiWhy = s.why; },
      onPick: () => {
        q.value = '';
        filter.value = 'all';
        if (toolbarFb) toolbarFb.setQuery('');
      },
      done: () => { resetPaging(); render(); },
      say: t => { setCnt(t); },
    };
    const runAiFind = () => window.AiFind.run(AI);

    async function loadRefUse() {
      if (Date.now() - refUseAt < 5000) return refUse;
      const map = new Map();
      try {
        const ws = await window.Kv.at('ws').get('workspace');
        const re = /(^|[^A-Za-z0-9._%+-])@([^\s\u3000@，。；、,.!?！？：:（）()【\[\]「」『』"']{1,24})/g;
        ((ws && ws.projects) || []).forEach(p => ((p && p.scenes) || []).forEach(sc =>
          ((sc && sc.shots) || []).forEach(sh => {
            const txt = String((sh && sh.prompt) || '');
            if (!sh || txt.indexOf('@') < 0) return;
            const names = new Set();
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(txt))) names.add(m[2]);
            names.forEach(n => {
              const list = map.get(n) || [];
              list.push({ pid: p.id || '', pname: p.name || '未命名短片', sid: sc.id || '', sname: sc.name || '', shid: sh.id || '', shname: sh.name || '' });
              map.set(n, list);
            });
          })));
      } catch (e) { /* 读不到就当没有引用 */ }
      refUse = map; refUseAt = Date.now();
      return map;
    }

    /* ---------- 新建一条素材（先出后选再创建） ---------- */
    function draftPlaceholder(name, kind, want) {
      const one = (lab) => '<div class="ui-cand"><div class="ui-wait fill" style="width:76px;height:76px">'
        + '<i></i><span>' + lab + '…</span></div></div>';
      return '<div class="ui-pick"><div class="ui-hint" style="margin-bottom:8px">'
        + '正在给「' + D.esc(name) + '」准备 ' + (want.voice ? '图与声音' : '图')
        + ' —— 出好了会让你挑；这一步还没存进素材库</div>'
        + '<div class="ui-cands">' + (want.pic ? one('图') : '') + (want.voice ? one('声音') : '') + '</div></div>';
    }
    const canPlayNow = st => !!(st && st.voice && (st.voice.refAudio || st.voice.voice));

    async function pickDraft(f, kind, state, why) {
      const body = document.createElement('div');
      body.className = 'ui-pick';
      const own = state.pic ? [{ src: state.pic, own: true }] : [];
      const cands = () => own.concat(state.faces);
      let chosen = cands().length ? 0 : -1;

      const draw = () => {
        const pw = picWord(f);
        const cs = cands();
        const secPic = cs.length
          ? '<div class="ui-sec">挑一张' + D.esc(pw) + '（第 ' + (chosen + 1) + ' / ' + cs.length + ' 张）</div>'
            + '<div class="ui-cands">' + cs.map((x, i) =>
              '<div class="ui-cand' + (i === chosen ? ' on' : '') + '" data-pi="' + i + '" title="点一下就选它">'
              + '<img src="' + D.esc(x.src) + '" alt="' + (x.own ? '自己传的' : '第 ' + (i + 1) + ' 张') + '">'
              + '<span class="t">' + (x.own ? '自己传的' : '第 ' + (i + 1) + ' 张') + '</span></div>').join('') + '</div>'
            + '<div class="btn-row"><button class="ghost" data-pd="open">放大看这一张</button>'
            + '<button class="ghost" data-pd="again">再出几张</button></div>'
          : '<div class="ui-sec">' + D.esc(pw) + '</div><div class="ui-hint">'
            + (why.length && why[0].indexOf('图') >= 0 ? D.esc(why[0]) + '。' : '这次没出图（描述还没写）。')
            + '可以只用文字创建，之后在编辑区点「AI 出' + nSuffix() + D.esc(pw) + '」。</div>';
        const secVoice = kind === 'actor'
          ? '<div class="ui-sec">声音</div>' + (state.voice
            ? '<div class="ui-box" data-pd="voice"><div class="ui-hint">'
            + (state.voice.voiceMode === 'clone' ? '复刻这一位的参考音频'
              : (state.voice.voiceNote ? '音色描述：' + D.esc(state.voice.voiceNote)
                : '预设音色：' + D.esc(state.voice.voiceName || state.voice.voice || '')))
            + '</div><div class="btn-row"><button class="ghost" data-pd="play">试听</button>'
            + '<button class="ghost" data-pd="voiceagain">让 AI 换一个</button></div>'
            + (canPlayNow(state) ? '' : '<div class="ui-hint">音色描述与预设音色要等素材建好、拿到预览音频之后才能试听</div>')
            + '</div>'
            : '<div class="ui-hint">'
            + (why.length && why.some(x => x.indexOf('声音') >= 0) ? D.esc(why.find(x => x.indexOf('声音') >= 0)) + '。' : '这次没定音色（设置里那个开关没开）。')
            + '仍然可以只用文字创建，之后在编辑区「声音」那一块选一种方式定音色（预设音色 / 写声音描述 / 复刻参考音频）。</div>')
          : '';
        body.innerHTML = secPic + secVoice
          + '<div class="ui-hint" style="margin-top:10px">挑完点下面的「创建素材」才写进素材库；'
          + '直接关掉这一窗则什么都不会保存。</div>';
        body.querySelectorAll('[data-pi]').forEach(el => {
          el.onclick = () => { chosen = Number(el.dataset.pi); draw(); };
        });
        const ag = body.querySelector('[data-pd="again"]');
        if (ag) ag.onclick = async () => { await againPic(); };
        const op = body.querySelector('[data-pd="open"]');
        if (op) op.onclick = () => {
          const cs2 = cands();
          const x = cs2[chosen];
          if (!x) return;
          const items = cs2.map(f2 => ({ src: f2.src, label: f.name }));
          window.Wb.lightbox.open(Object.assign({ key: 'draft:' + f.name + ':' + chosen }, items[chosen]), items);
        };
        const pb = body.querySelector('[data-pd="play"]');
        if (pb && !canPlayNow(state)) pb.disabled = true;
        if (pb) pb.onclick = async () => {
          try { await D.Cast.playAsset(state.voice.refAudio || state.voice.voice); }
          catch (e) { Toast.err('试听没出声：' + errText(e)); }
        };
        const va = body.querySelector('[data-pd="voiceagain"]');
        if (va) va.onclick = async () => { await againVoice(); };
      };
      const againPic = async () => {
        const look2 = String(f.look || '').trim();
        if (!look2) return Toast.warn('出图要靠上面那段描述 —— 先补一句');
        if (!D.Pipe.pickProvModel(REG, 'image', opts.imgModel, 'text_to_image')) {
          return Toast.warn('现在没有可用的生图平台：到设置页填一把密钥，或在右边「出图型号」里挑一个');
        }
        const tmp2 = { id: 'draft_pic', kind, name: f.name, look: f.look, desc: kind === 'scene' ? f.look : '',
          time: kind === 'scene' ? f.time : '', faces: [] };
        await genRun('face', 'draft_pic', tmp2, '正在再出几张…',
          () => D.Pipe.drawPreview(REG, fakeDrama(), tmp2, { count: candCount(), onTask: onTaskHook }));
        const got = (tmp2.faces || []).slice();
        if (got.length) { state.faces = state.faces.concat(got); chosen = cands().length - got.length; draw(); }
        else { Toast.warn('这次没出成（生成失败或被拒绝了）—— 可以再试一次，或直接只用文字创建', 8000); draw(); }
      };
      const againVoice = async () => {
        if (!D.aiVoiceOn()) return Toast.warn('设置里「让 AI 给角色定音色」没开');
        const shell2 = Object.assign(fakeDrama(), { characters: [D.toEpisodeChar({ id: 'd', kind: 'actor', name: f.name, look: f.look, bio: f.bio })] });
        await genRun('voice', 'draft_voice', { id: 'draft_voice' }, '正在换一个音色…',
          () => { const live = aiPanel(); return D.Pipe.assignVoices(REG, shell2, { only: [f.name], onDelta: live.push }).finally(() => live.done()); });
        const one2 = shell2.characters[0] || {};
        if (one2.voice || one2.refAudio || String(one2.voiceNote || '').trim()) {
          state.voice = { voice: one2.voice, voiceName: one2.voiceName, voiceNote: one2.voiceNote,
            voiceMode: one2.voiceMode, refAudio: one2.refAudio, refAudioName: one2.refAudioName, voiceBy: 'ai' };
          draw();
        } else Toast.warn('这次没定成 —— 可以再试一次，或直接只用文字创建', 8000);
      };
      draw();

      const cs3 = cands();
      const onOwn = cs3[chosen] && cs3[chosen].own;
      const pick = await window.Confirm.choose({
        title: '挑一下，再创建「' + f.name + '」',
        bodyNode: body,
        options: [{ value: 'ok', label: '创建素材', hint: (chosen >= 0 && cs3[chosen]
            ? (onOwn ? '带上你自己挑的那张图' : '用第 ' + (chosen + 1) + ' 张图') : '不带主图')
            + (state.voice ? ' · 带刚定的那把嗓子' : '') },
        { value: 'text', label: '只用文字创建', hint: '不带主图也不带嗓子（已经出好的那几张留在候选里，之后在编辑区点「用这一张」就能换上）' }],
        cancelLabel: '取消（什么也不保存）',
      });
      if (pick === 'text') return { pic: '', faces: state.faces, voice: null };
      if (!pick) return null;
      return { pic: chosen >= 0 && cs3[chosen] ? cs3[chosen].src : '', faces: state.faces, voice: state.voice };
    }

    async function commitNew(f, kind, picked) {
      const c = D.Lib.commitForm(Object.assign({}, f, {
        pic: (picked && picked.pic) || '',
        faces: (picked && picked.faces) || [],
        voice: (picked && picked.voice) || null,
      }));
      if (c && c.error) return Toast.err(c.error);
      const saved = c.item;
      const hid = [];
      if (!match(saved, filter.value)) {
        filter.value = D.libKindOf(saved);
        hid.push('类型档切到「' + (D.LIB_KINDS[filter.value] || filter.value) + '」');
      }
      if (group.value && !D.Lib.groupMatch(saved, group.value)) { group.value = D.Lib.groupNameOf(saved) || '__none'; hid.push('分组跟着切过去'); }
      const qq = q.value.trim();
      if (qq && !D.Lib.hayOf(saved).includes(qq.toLowerCase())) { q.value = ''; hid.push('清空了搜索框'); }
      if (aiPick && !aiPick.has(saved.id)) { aiPick = null; aiWhy = ''; hid.push('退出「AI 挑的那批」'); }
      const bits = ['编辑区已经打开——' + c.tip];
      if (picked && picked.faces && picked.faces.length > 1) bits.push('刚才挑的是第几张可以随时换');
      Toast.receipt('建好了：' + saved.name + '。' + bits.join('；') + (hid.length ? '（' + hid.join('、') + '，不然这一张不在当前这一档里）' : ''));
      openId.value = saved.id; resetPaging(); await render();
      if (revealItem(saved.id)) await render();
      const mine = cardEl(saved.id);
      if (mine && mine.scrollIntoView) mine.scrollIntoView({ block: 'center' });
    }
    /* 把某一条跳出来（刚建好、或从别处指回来）：「放开到覆盖它的范围」这套算法只有
       `Wb.pager.reveal` 一份，这一页只负责把条目号换成它在下拉后的视图里的位置。 */
    function revealItem(id) {
      if (!pager) return false;
      const i = viewItems.findIndex(x => x && x.id === id);
      return i >= 0 && pager.reveal(i);
    }

    async function newChar() {
      if (!D) return;
      const r = await D.Lib.newForm({ group: group.value === '__none' ? '' : group.value, onlyFields: true });
      if (!r) return;
      if (r.error) return Toast.err(r.error);
      const f = r.fields;
      const kind = r.kind;
      const look = String(f.look || '').trim();
      const canPic = !!look && !f.pic && !!D.Pipe.pickProvModel(REG, 'image', opts.imgModel, 'text_to_image');
      const canVoice = kind === 'actor' && D.aiVoiceOn();
      if (!f.pic && !canPic && !canVoice) {
        const yes = !window.Confirm || await window.Confirm.ask({
          title: '这一条只能存文字',
          body: (look ? '现在没有可用的生图平台（设置页填一把密钥，或在上面「出图型号」里挑一个）' : '还没写描述（出图靠它）')
            + (kind === 'actor' ? '；「让 AI 给角色定音色」那个开关也没开' : '')
            + '，所以这次出不了图。仍然要把它存进素材库吗？',
          okLabel: '只用文字创建', cancelLabel: '回去补',
        });
        if (!yes) return;
        return commitNew(f, kind, { pic: f.pic || '' });
      }
      const tmp = {
        id: 'draft_' + Date.now().toString(36), kind: kind,
        name: f.name, group: f.group, look: f.look, bio: f.bio,
        desc: kind === 'scene' ? f.look : '', time: kind === 'scene' ? f.time : '',
        faces: [], voice: '', voiceName: '', voiceNote: '', voiceMode: '',
      };
      const host = document.createElement('div');
      host.className = 'ui-draft';
      if (canPic || canVoice) {
        host.innerHTML = draftPlaceholder(f.name, kind, { pic: !!canPic, voice: canVoice });
        /* 外壳文档的 body 是 overflow:hidden（旧页 body 自己滚）：挂 body 上会看不见。
           挂进这一页的滚动区，占位符照旧在流程里、出完那一句能看见。 */
        (rootEl.value || document.body).appendChild(host);
      }
      const state = { pic: f.pic || '', faces: [], voice: null, busy: { pic: !!canPic, voice: canVoice } };
      const jobs = [];
      if (canPic) {
        jobs.push((async () => {
          await genRun('face', tmp.id, tmp, '正在出「' + f.name + '」的预览图…',
            () => D.Pipe.drawPreview(REG, fakeDrama(), tmp, { count: candCount(), onTask: onTaskHook }));
          state.faces = (tmp.faces || []).slice();
        })());
      }
      if (canVoice) {
        jobs.push((async () => {
          const shell = Object.assign(fakeDrama(), { characters: [D.toEpisodeChar(Object.assign({}, tmp, { kind: 'actor' }))] });
          await genRun('voice', tmp.id, tmp, '正在按人设定「' + f.name + '」的声音…',
            () => { const live = aiPanel(); return D.Pipe.assignVoices(REG, shell, { only: [f.name], onDelta: live.push }).finally(() => live.done()); });
          const one = shell.characters[0] || {};
          if (one.voice || one.refAudio || String(one.voiceNote || '').trim()) {
            state.voice = { voice: one.voice, voiceName: one.voiceName, voiceNote: one.voiceNote,
              voiceMode: one.voiceMode, refAudio: one.refAudio, refAudioName: one.refAudioName, voiceBy: 'ai' };
          }
        })());
      }
      await Promise.allSettled(jobs);
      const why = [];
      if (canPic && !state.faces.length) why.push('图没出来' + (look ? '' : '（没写描述）'));
      if (canVoice && !state.voice) why.push('声音没定出来');
      host.remove();
      const picked = await pickDraft(f, kind, state, why);
      if (!picked) return;
      return commitNew(f, kind, picked);
    }

    /* ---------- 型号下拉 / 出图张数 ---------- */
    function paintModelPicks() {
      const mk = (host, kind, mode, val, onpick, hint) => {
        const el = host.value; if (!el) return;
        el.innerHTML = D.Pipe.modelSelectHTML(REG, { id: 'chars_' + kind + '_sel', kind: kind, mode: mode, value: val, emptyText: hint });
        const s = el.querySelector('select');
        if (s) s.onchange = () => { onpick(s.value); };
        if (window.Dropdowns) window.Dropdowns.build(el);
      };
      mk(imgPickEl, 'image', 'text_to_image', opts.imgModel,
        v => { opts.imgModel = v; saveOpts(); render(); }, '没配生图平台');
      mk(ttsPickEl, 'audio', 'text_to_speech', opts.ttsModel,
        v => { opts.ttsModel = v; saveOpts(); render(); }, '没配语音平台');
      paintCandPick();
    }
    function paintCandPick() {
      const host = candPickEl.value; if (!host || !D) return;
      const it = D.SET.candN;
      const lo = Number(it.min) || 1, hi = Number(it.max) || 8;
      if (!candSelBuilt) {
        candSelBuilt = true;
        host.innerHTML = '<select>'
          + Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
            .map(n => '<option value="' + n + '">' + n + ' 张</option>').join('')
          + '</select>';
        const s = host.querySelector('select');
        if (s) s.onchange = () => {
          window.LS.set(it.key, String(Number(s.value) || Number(it.def)));   // 存不下（隐私模式）就只生效这一次
          render();
        };
        if (window.Dropdowns) window.Dropdowns.build(host);
      }
      const sel = host.querySelector('select'); if (!sel) return;
      const raw = String(Number(D.setting('candN')) || Number(it.def));
      if (sel.value !== raw) { sel.value = raw; if (window.Dropdowns) window.Dropdowns.sync(sel); }
      const real = candCount();
      sel.title = '一次出几张预览图候选（角色 / 场景 / 道具的主图）。'
        + (real < Number(raw) ? '当前生图型号最多一次出 ' + real + ' 张，所以实际是 ' + real + ' 张。' : '')
        + '与设置页「角色 / 场景 / 道具 一次出几张候选」是同一个设置。'
        + '「加一张角色资产」与「一次出齐这一档」不受它影响，都固定出 1 张。';
      host.title = sel.title;
    }

    /* ---------- 主渲染 ---------- */
    async function render() {
      if (!ready.value || !D) return;
      await loadRefUse();
      syncSel();
      updateHealth();
      const seq = ++renderSeq;
      paintChips(); paintAiChip(); paintGroups(); paintModelPicks();
      if (viewToggle) viewToggle.apply();
      const qv = q.value.trim();
      const all = D.Lib.list();
      let items = all.filter(c => c && match(c, filter.value)
        && (!group.value || D.Lib.groupMatch(c, group.value))
        && (!aiPick || aiPick.has(c.id)));
      /* 搜索走本地语义排序（SemanticSearch 全站一份）：中文 bigram + 字段加权 +
         原文整句命中加分。以前这里是 `hayOf(c).includes(q)`，只认字面，
         「找那个总是发火的男配」这种描述在素材库里一个都搜不到。 */
      if (qv) {
        const S = window.SemanticSearch;
        if (S && S.rank) {
          const docs = items.map(c => ({
            c, name: c.name || '', look: c.look || c.desc || '', bio: c.bio || '',
            group: c.group || '', kind: D.LIB_KINDS[D.libKindOf(c)] || '',
            text: [D.Cast.assetNames(c), c.voiceName, c.voiceNote, c.time].filter(Boolean).join(' '),
          }));
          /* SemanticSearch 单次上限 200 条；素材库可能比这多，分块排完再并（不要静默截断）。 */
          const ranked = [];
          for (let i = 0; i < docs.length; i += 200) ranked.push(...S.rank(docs.slice(i, i + 200), qv, { limit: 200 }));
          items = ranked.sort((a, b) => b.score - a.score).map(r => r.item.c);
        } else {
          items = items.filter(c => D.Lib.hayOf(c).includes(qv.toLowerCase()));
        }
      }
      /* 有搜索词时保留语义排序；`orderItems` 只是在没有搜索时按名字 / AI 名次排。 */
      if (!qv) items = orderItems(items);
      if (seq !== renderSeq) return;
      viewItems.length = 0; media.length = 0;
      items.forEach(c => {
        viewItems.push(c);
        const pic = D.picOf(c);
        if (pic) media.push({ key: 'char:' + c.id + ':face', s: pic, name: c.name + ' · ' + picWord(c), label: picWord(c), item: c });
        D.Cast.assetsOf(c).forEach(a => {
          const lab = D.Cast.assetLabel(c, a.kind) || '图';
          media.push({ key: 'char:' + c.id + ':a:' + a.id, s: a.src, name: c.name + ' · ' + lab, label: lab, item: c });
        });
      });
      setCnt(items.length ? '共 ' + items.length + ' 条' : '');
      paintFillBtn();
      paintLocalBtn();
      pagerVisible.value = items.length > 0;
      if (!items.length) {
        cards.value = [];
      emptyHtml.value = all.length ? '这一档下没有东西。换个筛选条件、换个组，或清空搜索框。'
        : '还没有素材 —— 点「新建素材」自己建一条，或去导演台用「拆分镜」自动建档（拆出来的角色 / 场景 / 道具会自动进这里）。';
        return;
      }
      emptyHtml.value = '';
      if (pager) pager.update();
      const list = pageItems();
      const out = [];
      for (const c of list) {
        if (seq !== renderSeq) return;
        out.push({ id: c.id, html: safeCardHTML(c) });
      }
      cards.value = out;
      await nextTick();
      if (seq !== renderSeq) return;
      bindCardDom();
      if (openId.value) paintQuality(itemOf(openId.value));
    }

    /* 过期签名图的后台回源（与收藏页同一份 Api.healMedia） */
    async function healLibFaces() {
      if (!window.Api || !window.Api.healMedia || !window.Api.mediaExpired) return;
      const recs = [];
      D.Lib.list().forEach(c => {
        (c.faces || []).forEach(f => {
          if (!f || !f.src || !f.provider) return;
          const id = f.genId || f.assetId;
          if (!id || !window.Api.mediaExpired(f.src)) return;
          recs.push({ provider: f.provider, id: id, url: f.src, _cid: c.id, _old: f.src });
        });
      });
      if (!recs.length) return;
      try {
        await window.Api.healMedia(recs, { limit: 12, onFresh: (rec, next) => {
          const hit = D.Lib.get(rec._cid);
          const f = hit && (hit.faces || []).find(x => x && x.src === rec._old);
          if (!f) return;
          f.src = next;
          D.Lib.save(hit, { exact: true });
          if (D.picOf(hit) === rec._old) D.setPic(hit, next);
          paintCard(hit);
        } });
      } catch (e) { console.warn('[素材库] 过期图的回源失败：', e.message); }
    }

    /* ---------- 灯箱 / 详情适配器 ---------- */
    function detailCfg() {
      return {
        prompt: it => it.item ? D.descOf(it.item) : '',
        status: () => '素材库',
        rows: it => [
          ['名字', it.item ? it.item.name : ''],
          ['类型', it.item ? D.LIB_KINDS[D.libKindOf(it.item)] : ''],
          ['分组', (it.item && it.item.group) || '未分组'],
          ['这一张', it.label || ''],
          ['人设 / 用途', (it.item && it.item.bio) || ''],
          [D.isPropItem(it.item) ? '道具描述' : D.isSceneItem(it.item) ? '场景描述' : '外貌', D.descOf(it.item) || ''],
          ['资产', it.item ? D.Cast.assetNames(it.item) : ''],
        ],
      };
    }
    function lbCfg() {
      return {
        list: () => media,
        keyOf: it => it.key,
        srcOf: it => src(it.s),
        nameOf: it => window.fileSafe(it.name || '素材图', 60),
        kindOf: () => 'image',
        info: it => [it.name, it.item ? D.Cast.assetNames(it.item) : ''],
      };
    }
    /* 灯箱与详情全站只有**一份**（收藏 / 资产库 / 素材库共用）。init 只做一次：它会挂全局
       键盘监听，多挂一份就一次翻两页。配置不再由这一页「抢占 / 归还」——那是四页各写一套、
       漏还一页就把别人的 list 留在前台的协议；现在只向公共层登记「素材库这一页要这两份」，
       换前台由 spa:page 把各自那一份装回去（见 workbench.js 的 Wb.lightbox.use）。 */
    function registerAdapters() {
      if (!window.Wb || !D) return;
      const W = window.Wb;
      if (!W.lightbox.cfg) W.lightbox.init(lbCfg());
      W.lightbox.use(PAGE_FILE, { lb: lbCfg(), detail: detailCfg() });
    }
    function unregisterAdapters() {
      if (window.Wb && window.Wb.lightbox) window.Wb.lightbox.use(PAGE_FILE, null);
    }

    /* ---------- 模块初始化 ---------- */
    function initModules() {
      if (pagerRowEl.value) pagerRowEl.value.innerHTML = window.Wb.pager.rowHTML('chars');
      pager = window.Wb.pager.create({
        mode: PAGE_MODE, pageSize: PAGE_SIZE, localMore: true,
        items: () => viewItems,
        render: () => { render(); },
        pgPrevId: 'charsPgPrev', pgInfoId: 'charsPgInfo', pgNextId: 'charsPgNext',
      });
      pager.bindButtons();
      if (viewEl.value) viewToggle = window.Wb.viewToggle.create({ el: viewEl.value, key: 'dir_char_view', target: gridEl.value });
      registerAdapters();
    }

    /* 顶部主工具条只在这里建一次：结构与接线归 Wb.filterBar（搜索防抖、芯片渲染、计数都在那一份），
       这一页只把「AI 找素材」按钮与它的条件芯片作为 extraHTML 传进去，再捎回节点接自己的行为。 */
    function bindToolbar() {
      if (!toolbarEl.value) return;
      toolbarFb = window.Wb.filterBar.bind(toolbarEl.value, {
        chips: FILTERS,
        value: filter.value,
        q: q.value,
        placeholder: searchPh.value,
        onFilter: v => { filter.value = v; resetPaging(); render(); },
        onSearch: v => { q.value = v; resetPaging(); render(); },
        /* Esc 清掉搜索框与 AI 条件（与旧页同一个出口：清完由 AI 的 done 重画一次）。 */
        onEscape: () => {
          q.value = '';
          resetPaging();
          clearAiPick();
        },
        extraHTML: '<button class="tool acc" title="' + esc('把搜索框那句话交给文字 AI，由它从整个库里挑最合适的几条') + '">'
          + aiBtnHtml + '</button><span data-fb="aiChip"></span>'
          + '<button class="tool" data-fb="libExport" title="把整个素材库导出成 JSON（备份 / 换机器带走）">'
          + (window.icon ? icon('download', 13) : '') + ' 导出</button>'
          + '<button class="tool" data-fb="libImport" title="从 JSON 导入素材（先报数，确认后才写）">'
          + (window.icon ? icon('upload', 13) : '') + ' 导入</button>'
          + '<input type="file" accept=".json,application/json" hidden data-fb="libImportFile">',
      });
      if (!toolbarFb) return;
      aiFindBtn.value = toolbarFb.el.querySelector('.tool.acc');
      aiChipEl.value = toolbarFb.el.querySelector('[data-fb="aiChip"]');
      if (aiFindBtn.value) aiFindBtn.value.onclick = runAiFind;
      /* 导出 / 导入 JSON（14.3-2②）：库本体的备份两颗按钮。导入**先报数再写** ——
         这是用户数据，「将新增 X 条 / 覆盖 Y 条」看过、点了确认才落盘。 */
      const expBtn = toolbarFb.el.querySelector('[data-fb="libExport"]');
      const impBtn = toolbarFb.el.querySelector('[data-fb="libImport"]');
      const impFile = toolbarFb.el.querySelector('[data-fb="libImportFile"]');
      if (expBtn) expBtn.onclick = exportLibJson;
      if (impBtn && impFile) {
        impBtn.onclick = () => impFile.click();
        impFile.onchange = () => { const f = impFile.files && impFile.files[0]; impFile.value = ''; if (f) importLibJson(f); };
      }
    }

    function exportLibJson() {
      const list = (D && D.Lib && D.Lib.list()) || [];
      if (!list.length) return Toast.warn('库里还没有素材，没什么可导出');
      const payload = { kind: '拾帧素材库', version: 1, at: new Date().toISOString(), items: list };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '素材库-' + (window.dayKey ? dayKey(Date.now()) : new Date().toISOString().slice(0, 10)) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) { /* 浏览器自己会回收 */ } }, 5000);
      Toast.receipt('已导出 ' + list.length + ' 条素材（JSON）');
    }
    async function importLibJson(file) {
      let data = null;
      try { data = JSON.parse(await file.text()); }
      catch (e) { return Toast.err('这不是一份素材库 JSON：' + errText(e)); }
      const items = (data && Array.isArray(data.items)) ? data.items : (Array.isArray(data) ? data : null);
      if (!items || !items.length) return Toast.err('这份 JSON 里没有素材条目');
      /* 先报数不写（14.3-2②）：同类型 + 同名 = 覆盖合并进已有那条（保留原 id，与 Lib.save 同尺）；
         对不上 = 新增。看过这句、点确认才落盘。 */
      const cur = (D.Lib.list() || []);
      let willNew = 0, willOver = 0;
      items.forEach(x => {
        const nm = String((x && x.name) || '').trim();
        if (!nm) return;
        const kind = D.libKindOf(x);
        const hit = cur.find(y => y && y.name === nm && D.libKindOf(y) === kind);
        if (hit) willOver++; else willNew++;
      });
      const ok = await window.Confirm.ask({
        title: '从 JSON 导入 ' + items.length + ' 条素材？',
        body: '将新增 ' + willNew + ' 条、覆盖合并 ' + willOver + ' 条（同类型同名的并进已有那条，保留原 id）。'
          + '导入会写进素材库 —— 覆盖的那几条按导入文件里的字段刷新。',
        okLabel: '确认导入', cancelLabel: '取消',
      });
      if (!ok) return;
      let done = 0;
      const failed = [];
      for (const x of items) {
        try {
          const nm = String((x && x.name) || '').trim();
          if (!nm) continue;
          D.Lib.save(x, { exact: true });
          const e = D.Lib.writeError && D.Lib.writeError();
          if (e) failed.push(nm + '（' + e + '）');
          else done++;
        } catch (e) { failed.push(String((x && x.name) || '?') + '（' + errText(e) + '）'); }
      }
      render();
      Toast[(failed.length ? 'warn' : 'ok')](
        '导入完成：' + done + ' 条已写（新增 ' + willNew + ' / 覆盖 ' + willOver + '）'
        + (failed.length ? '；没成：' + failed.slice(0, 3).join('、') : ''), 7000);
    }

    async function boot() {
      if (opts.style) { delete opts.style; try { saveOpts(); } catch (e) { /* 退回默认档时存不下（隐私模式）就只生效这一次 */ } }
      searchPh.value = '搜' + D.Lib.SEARCH_FIELDS.map(f => f[0]).join(' / ');
      bindToolbar();
      try { REG = await window.Api.registry(); } catch (e) { REG = { providers: [] }; Toast.err('读注册表失败：' + e.message); }
      ready.value = true;
      await render();
      resumePending();
      healLibFaces();
      sentinelIO = window.Wb.pager.sentinel(gridEndEl.value, () => {
        if (pager.morePage()) render();     // 已经全放开了返回 false，什么都不用做
      });
    }

    function onStop() {
      if (!genHas('fill', null)) return;
      stopFlag = true;
      genSet('fill', null, '正在停下：已经发出去的那 ' + Math.max(0, GEN.size - 1) + ' 条收不回来，等它们跑完这一批就不再发新的');
      stopDisabled.value = true;
    }
    function onStorage() { if (ready.value) render(); }
    function onPointerUp() { if (!isActive()) return; setTimeout(flushHeads, 0); }
    function onDocKey(e) {
      if (!isActive()) return;
      if (e.key !== 'Escape' || !openId.value) return;
      if (e.target && toolbarFb && e.target === toolbarFb.input) return;
      if (document.querySelector('dialog[open]')) return;
      if (window.Wb && window.Wb.lightbox && window.Wb.lightbox.isOpen && window.Wb.lightbox.isOpen()) return;
      toggleEdit(openId.value, false);
    }
    function onVisibleChange() {
      /* 切回这一页时把「被 N 镜引用」重新数一遍（旧页每次打开都会读一次盘）；
         编辑区开着就不整页重画，免得把正在敲的字换掉。
         灯箱与详情的配置不用这一页管：公共层按前台页装回各自那一份（见 registerAdapters）。 */
      if (ready.value && !openId.value) { refUseAt = 0; render(); }
    }

    onMounted(async () => {
      try {
        await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
        await window.__spaLoadScript('web/domain/chars.js', () => window.Chars);
      } catch (e) {
        failed.value = '公共模块没有加载起来：' + errText(e);
        if (window.PageReport) PageReport.pageFail('素材库', failed.value, e);
        return;
      }
      D = window.Chars;
      if (!window.Wb || !D || !window.Api || !window.Chips || !window.AssetLocal || !window.AssetPicker) {
        failed.value = '素材库依赖的公共模块没有就绪（workbench.js / chars.js / assetlib.js）';
        if (window.PageReport) PageReport.pageFail('素材库', failed.value);
        return;
      }
      await nextTick();
      try {
        initModules();
      } catch (e) {
        failed.value = '素材库初始化失败：' + errText(e);
        if (window.PageReport) PageReport.pageFail('素材库', failed.value, e);
        console.error('[chars] 初始化失败：', e);
        return;
      }
      offStorage = window.StorageBus.on(['char_lib'], onStorage);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('keydown', onDocKey);
      window.__charsChanged = () => { try { render(); } catch (e) { /* 重画抛错不能把喊它的别的页面带崩 */ } };
      try { await boot(); } catch (e) {
        console.warn('[chars] 启动失败：', e);
        if (!failed.value) failed.value = '素材库启动失败：' + errText(e);
        if (window.PageReport) PageReport.pageFail('素材库', failed.value, e);
      }
    });

    onBeforeUnmount(() => {
      alive = false;
      if (toolbarFb) { toolbarFb.destroy(); toolbarFb = null; }
      if (offStorage) { offStorage(); offStorage = null; }
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('keydown', onDocKey);
      clearTimeout(fieldTimer);
      clearTimeout(headTimer);
      if (sentinelIO && sentinelIO.disconnect) { try { sentinelIO.disconnect(); } catch (e) { /* 观察器已经断开就没有可断开的 */ } }
      if (offActivity) offActivity();
      unregisterAdapters();
      /* 助手那一侧按 `window.__charsChanged` 喊这一页重画：页面已经不在了，钩子不能继续指着它。 */
      window.__charsChanged = null;
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      rootEl, toolbarEl, grpPickEl, grpListEl, viewEl,
      btnFillEl, btnLocalEl, btnStopEl, btnNewEl, imgPickEl, ttsPickEl, candPickEl, aiLiveEl,
      gridEl, gridEndEl, pagerRowEl,
      ready, failed, cards, openId, q, cntText, busyText, stopVisible, stopDisabled,
      pagerVisible, emptyHtml, fillText, fillDisabled, fillTitle,
      ticHtml, newBtnHtml, aiBtnHtml,
      multi, batchCount, batchText, batchGroup, health, isPicked,
      runAiFind, fillRest, pullLocal, onStop, newChar,
      onGridClick, onGridInput, onGridChange, onGridFocusIn, onGridFocusOut,
      onGridDragStart, onGridDragEnd,
      toggleMulti, jumpFilter,
      batchFillPics, batchFillAssets, batchFillVoices, batchSetGroup, batchRemove,
    };
  },
  render,
};
