/* 素材库 —— 由 chars.html 迁到 Vue 3 的页面。
   数据与副作用全部走已有的公共层（Chars / Wb / AssetLocal / AssetPicker / AssetTransfer /
   AiFind / AiChip / Chips / Dropdowns / Confirm / Toast），组件只负责「这一屏长什么样」。
   `chars.js` 仍是全站唯一的数据层（Chars.Pipe / Chars.Lib / Chars.Cast / Chars.SET），
   这一页一个字都不重写它。

   布局（2026-10-25 重排）是三栏：
     · 左「目录轨」：类型 / 还缺什么 / 分组 —— 取代筛选芯片行 + 三行工具条 + 体检面板；
       「出齐」用哪个型号只有一处出处：设置页「素材库」那张卡的默认生图型号
      （目录轨上那行「出齐用」的下拉已经撤掉）。
     · 中「素材台」：一行工具 + 卡片网格 + 底部翻页行；
     · 右「检查器」：点一张卡才占位 —— 取代卡内就地展开的编辑区。
   「新建 / 编辑一条素材」挪到**整屏层**（`./chars/detail.js`）：那一层有自己的骨架
   （左边画面吸顶、右边一条连续文档）与「每个生成位自带型号与数量」的生成条。

   与旧页的两点结构差异（行为不变）：
   ① 卡片不再逐个 `bindCard`：网格上用事件委托接 `data-a` / `data-act` / `data-f`，
      重画只换那一张卡的 html 字符串（焦点由 paintCard 还回去，与旧实现同一套判据）；
   ② `document.getElementById` 只出现在公共模块要求的那几处 id（分页按钮交给 Wb.pager 的
      `pgPrevId` 一档、AiChip 的清除键给唯一 id），页面自己的元素全走 ref。 */
import { ref, nextTick, onMounted, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/chars.js';
import { createDetail, detailDots, detailStat } from './chars/detail.js';

const PAGE_MODE = window.pageModeOf('chars');
const PAGE_SIZE = window.pageSizeOf('chars');
/* 三种类型各一档（与库里那三种平级，道具是 2026-10 加的）—— 目录轨「类型」那一节。 */
import { ensureCss } from '../core/page-css.js';

const KIND_ROWS = [['all', '全部'], ['actor', '角色'], ['scene', '场景'], ['prop', '道具']];
/* 「还缺什么」那四档：与卡面上的完备度点阵同一套语义（预览图 · 角色资产 · 声音 · 描述）。 */
const GAP_ROWS = [['nopic', '缺预览图'], ['noasset', '缺角色资产'], ['novoice', '缺声音'], ['nodesc', '缺描述']];

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
    const matEl = ref(null);
    const toolbarEl = ref(null);
    const aiFindBtn = ref(null);
    const aiChipEl = ref(null);
    const railScrollEl = ref(null);
    const railSubEl = ref(null);
    const grpListEl = ref(null);
    const viewEl = ref(null);
    const btnNewEl = ref(null);
    const btnMultiEl = ref(null);
    const railToggleEl = ref(null);
    const bkImgPickEl = ref(null);
    const bkTtsPickEl = ref(null);
    const aiLiveEl = ref(null);
    const gridEl = ref(null);
    const gridEndEl = ref(null);
    const pagerRowEl = ref(null);
    const inspEl = ref(null);

    /* ---------- 界面状态 ---------- */
    const ready = ref(false);
    const failed = ref('');
    const cards = ref([]);            // [{ id, html }]：一张卡一条，重画只换这一条
    const inspId = ref('');            // 哪一张卡在右侧检查器里（点一下才开）
    const railOpen = ref(false);       // 窄窗下目录轨是覆盖抽屉
    const q = ref('');
    const searchPh = ref('搜索素材');
    const cntText = ref('');
    const busyText = ref('');
    const pagerVisible = ref(false);
    const emptyHtml = ref('');
    /* 多选与批量补缺：素材一多，「一条一条点开补」就是最耗时的那段。
       选中集合用新 Set 整体替换（ref 只有换引用才会触发模板重画）。 */
    const multi = ref(false);
    const sel = ref(new Set());
    const batchCount = ref(0);
    const batchBusy = ref(false);
    const batchText = ref('');
    const batchGroup = ref('');
    const ticHtml = window.icon ? icon('layers', 20) : '';
    const newBtnHtml = (window.icon ? icon('plus', 13) : '') + ' 新建素材';
    const aiBtnHtml = (window.icon ? icon('sparkles', 14) : '') + ' AI 找素材';

    /* ---------- 数据层与本地记账 ---------- */
    let D = window.Chars || null;
    let REG = null;
    let alive = true;
    /* 顶部主工具条（搜索 / AI 按钮 / AI 条件芯片 / 计数）由 Wb.filterBar 生成，
       这一页只留点完之后做什么；aiFindBtn / aiChipEl 在 bind 之后指回那一份里的节点。 */
    let toolbarFb = null;
    /* 目录轨上两档筛选各自独立：类型（全部/角色/场景/道具）与缺口（缺预览图/…）。 */
    const kindFilter = ref('all');
    const gapFilter = ref('');
    const group = ref('');            // '' = 全部组；'__none' = 未分组
    let aiPick = null, aiWhy = '', aiRank = null;
    let busyMsg = '';
    /* 「一次出齐」这一轮的两位状态：按过停下（不再开新的任务）、这一轮有没有停下可言。 */
    let stopFlag = false, fillStoppable = false, stopDisabled = false;
    let renderSeq = 0;
    const viewItems = [];             // 当前视图的素材（灯箱翻页范围）
    const media = [];                 // 当前视图能点开看的图（预览图 + 各资产）
    let refUse = new Map(), refUseAt = 0;
    let pager = null;
    let offStorage = null;
    let viewToggle = null;
    let sentinelIO = null;
    let nameBefore = '';
    let fieldTimer = null;
    let headPend = null, headTimer = 0;
    let libWarnedAt = 0;

    /* 这一页没有「某一集」，所以传进 Chars.Pipe 的 drama 只是个壳：它那一份 opts 只带
       **这一次挑的型号**与固定画幅（9:16）。
       ⚠ 这里**不再有「本页默认」**：默认值在设置页「素材库」那张卡里
       （默认生图型号 / 默认语音型号 / 默认出几张），页面上每一处生成位自己挑、自己改，
       改的只管那一处，**不写回设置页也不写进本机** ——
       「按上次那个跑」不是这一页该有的行为（旧的本机键 `char_opts` 已停用，见 boot）。 */
    const opts = { ratio: '9:16' };
    /* 设置页那一份默认（每次现读：那边改了，这边立刻跟着变）。 */
    const defImgModel = () => String(D.setting('imgModel') || '');
    const defTtsModel = () => String(D.setting('ttsModel') || '');
    /* 批量出图各自挑的型号（作用域不同，各挑各的）：只活在这一页，不落盘。 */
    const BATCH = { imgModel: '', ttsModel: '' };
    const fakeDrama = (imgModel, ttsModel) => ({
      opts: Object.assign({}, opts, { imgModel: imgModel || '', ttsModel: ttsModel || '' }),
      characters: [], scenes: [], shots: [],
    });
    /* 某一处生成位单独挑了型号 → 给它一份自己的 drama / opts（那一处出图出声音只认自己那份）。 */
    const dramaWith = model => fakeDrama(model);
    const optsWith = (model, count) => Object.assign({}, opts,
      { ttsModel: model || '' }, count ? { candN: count } : {});
    /* 「现在生效的那一个型号」：这一处挑的 → 设置页的默认 → 注册表里第一个。
       下拉里要显示的就是它（空串不是给用户看的答案）。 */
    const effKey = (kind, mode, key) => {
      try {
        const v = D.Pipe.pickProvModel(REG, kind, key || '', mode);
        return v ? v.key : '';
      } catch (e) { return ''; }
    };
    let detail = null;

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
    /* 「这一次出几张」：设置页那个「默认出几张」照旧管用（它是全局设置），
       再夹到**这个型号**声明的上限（上游只让出一张时，摆 3 个格子也没用）。 */
    const candCount = (modelKey) => {
      const hit = D.Pipe.pickProvModel(REG, 'image', modelKey || '', 'text_to_image');
      return Math.max(ONE, Number(D.candCount(REG, opts, null, hit && hit.model)) || ONE);
    };
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
      paintCharsRail();
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
    const candK = lab => ({ lab: lab, got: x => D.picOf(x), set: (x, v) => D.setPic(x, v) });
    const CANDK = { face: candK('预览图'), img: candK('场景图'), prop: candK('道具图') };

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

    /* 卡面：图 + 名字 + 类型 + 被引用数 + 描述 + 完备度点阵。
       描述与「被 N 镜引用」原来只有展开编辑区才看得到 —— 现在摆在卡面上，扫一眼就知道这个人是谁。 */
    function cardHTML(c) {
      const pw = picWord(c);
      const pic = D.picOf(c);
      const faceBusy = genHas('face', c.id);
      const vo = voiced(c) && D.voiceOnlyOf(c);
      /* 报错盖在图上（与「正在出」同一个位置）：卡面只剩图 + 名字 + 徽标 + 组名，
         错误原因不另开一栏 —— 它就是这张图为什么没出来，看图的地方就要看得到。 */
      const errHTML = errsHTML(c);
      const thumb = vo
        ? `<div class="mthumb mph-empty card-shell-media" title="只出声：这一位不出画面，所以不必有${esc(pw)}"><div class="none"><b>只出声</b><i>不出镜</i></div></div>`
        : `<div class="mthumb${isScene(c) ? ' mph-scene' : ''} card-shell-media"${faceBusy ? '' : ` data-a="${pic ? 'zoomface' : 'edit'}"`} title="${faceBusy
          ? '正在出' + esc(pw) + '：出来会自动换上'
          : pic ? pw + '：点一下看大图'
            : '还没有' + pw + '：点这里打开详情，挑一张或让 AI 出一张'}">
          ${faceBusy ? `<div class="none">${D.Cast.waitHTML('正在出' + pw)}</div>`
            : pic ? thumbImg(pic) + (c.anchor && c.anchor === pic ? '<span class="anchorbadge" title="身份锚点：出图、出资产与导演台参考图优先用它">锚点</span>' : '')
              : `<div class="none"><b>还没有${esc(pw)}</b><i>点这里自己挑一张</i></div>`}
          ${errHTML ? '<div class="thumb-why">' + errHTML + '</div>' : ''}</div>`;
      const pickedNow = sel.value.has(c.id);
      const uses = (refUse.get(String(c.name || '')) || []).length;
      const kindLab = D.LIB_KINDS[D.libKindOf(c)] || '';
      const acts = window.Wb.actsHTML(c, {
        items: [
          { act: 'edit', label: '编辑', title: '打开这一条的详情：改描述、出图、配声音' },
          pic ? { act: 'reuse', label: '拿去生成', title: '带着这张' + esc(pw) + '去生成工作台，放进参考图那一栏', data: { src: pic, name: c.name || '' } } : null,
          pic ? { act: 'similar', label: '找相似', title: '在本机素材库里按画面指纹找相似的图（不上传、不调模型）' } : null,
          { act: 'del', label: '从库里删掉', danger: true },
        ].filter(Boolean),
      });
      return `${multi.value ? `<div class="pick${pickedNow ? ' on' : ''}" title="勾选后批量补缺 / 分组 / 删除">${pickedNow ? '✓' : ''}</div>` : ''}${thumb}
        <div class="mbody card-shell-body">
          <div class="mrow"><span class="mname">${esc(c.name || '（无名）')}</span>
            <span class="mkind">${esc(kindLab)}</span>
            ${uses ? '<span class="mrefs">被 ' + uses + ' 镜引用</span>' : ''}</div>
          <p class="mbio">${esc(D.descOf(c) || c.bio || '还没写描述')}</p>
          <div class="mfoot">${detailDots(D, c)}${detailStat(D, c)}</div>
        </div>
        <div class="macts card-shell-actions">${acts}</div>`;
    }

    function safeCardHTML(c) {
      try { return cardHTML(c); } catch (e) {
        console.error('[chars] 这一条画不出来：', e, c);
        return '<div class="mbody card-shell-body"><div class="mrow"><span class="mname">这一条画不出来</span></div>'
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
      paintCharsRail();
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
      back();
    }
    function bindCardDom() {
      if (!gridEl.value) return;
      if (window.Dropdowns) window.Dropdowns.build(gridEl.value);
      /* 卡片里的图片由 Wb.thumbs 接线（缓存命中直接用小图、失败换占位）：整块重画之后一次 bindAll，
         页面不必每张卡各调一次 bind（重复 bind 同一元素是安全的）。 */
      if (window.Wb) window.Wb.thumbs.bindAll(gridEl.value);
      /* 自动补存：开关开着时把这一屏「本机还没有」的素材排进镜像队列。 */
      try {
        if (window.AssetLocal && AssetLocal.offerAll) {
          const jobs = [];
          viewItems.forEach(c => { if (c) localSlots(c).forEach(s => jobs.push(s)); });
          AssetLocal.offerAll(jobs);
        }
      } catch (e) { /* 补存失败不影响列表 */ }
    }
    /* 「加一张角色资产」那三格（名字 / 模板 / 自定义描述）的草稿值 —— 出图时按它写提示词。
       那一格在生成条里（`.gen-bar`），在真品的编辑区里是 `.ui-cands` —— 两处都找。 */
    function syncDraft(c, el) {
      const box = (el && el.closest && el.closest('.ui-cands, .gen-bar')) || el || null;
      const nm = box && box.querySelector('[data-a="assetname"]');
      const tpl = box && box.querySelector('[data-a="assettpl"]');
      const what = box && box.querySelector('[data-a="assetwhat"]');
      DRAFT.set(c.id, { name: (nm || {}).value || '', tpl: (tpl || {}).value || '', what: (what || {}).value || '' });
    }

    /* 就地更新卡面上的名字 / 描述（只换内容，不碰按钮与输入框）。 */
    function paintHeads(c) {
      const el = cardEl(c.id); if (!el) return;
      const nm = el.querySelector('.mname'), bio = el.querySelector('.mbio');
      if (nm) nm.textContent = c.name || '（无名）';
      if (bio) bio.textContent = D.descOf(c) || c.bio || '还没写描述';
      paintInsp();
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

    /* ---------- 筛选：目录轨上两档各自独立（类型 / 缺口） ---------- */
    function match(c, f) {
      if (!f || f === 'all') return true;
      if (f === 'actor' || f === 'scene' || f === 'prop') return D.libKindOf(c) === f;
      if (f === 'nopic') return !D.voiceOnlyOf(c) && !D.picOf(c);
      if (f === 'noasset' || f === 'nothree') return !isProp(c) && !isScene(c) && !D.voiceOnlyOf(c) && D.Cast.assetTplsOf(c).length && !D.Cast.assetsOf(c).length;
      if (f === 'nodesc') return !String(D.descOf(c) || '').trim();
      return voiced(c) && !c.refAudio && !c.voice && !String(c.voiceNote || '').trim();
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

    /* 分组名单：目录轨「分组」那一节与详情层里那个分组输入框共用这一份。 */
    function paintGroups() {
      const gs = D.Lib.groups();
      const none = D.Lib.list().filter(c => c && D.Lib.groupMatch(c, '__none')).length;
      group.value = D.Lib.reconcileGroup(group.value, gs, !!none);
      if (grpListEl.value) grpListEl.value.innerHTML = gs.map(g => `<option value="${esc(g.name)}">`).join('');
    }

    /* ---------- ③ 检查器：点一张卡才占位 ---------- */
    function paintInsp() {
      const el = inspEl.value;
      if (!el || !D) return;
      const c = inspId.value ? itemOf(inspId.value) : null;
      if (!c) { el.innerHTML = ''; return; }
      const pic = D.picOf(c);
      const uses = refUse.get(String(c.name || '')) || [];
      const kf = kindF(D.libKindOf(c));
      el.innerHTML = '<div class="insp-head"><div class="insp-title">'
        + '<span class="mname">' + esc(c.name || '（无名）') + '</span>'
        + '<span class="ui-tag">' + esc(D.LIB_KINDS[D.libKindOf(c)] || '') + '</span>'
        + (c.group ? '<span class="ui-tag">' + esc(c.group) + '</span>' : '')
        + '</div><button class="ghost insp-close" type="button" data-insp="close">收起</button></div>'
        + '<div class="insp-scroll">'
        + (pic ? '<div class="insp-hero">' + thumbImg(pic) + '</div>' : '')
        + '<div class="insp-status">' + detailDots(D, c) + detailStat(D, c)
        + '<span class="insp-refs">' + (uses.length ? '被 ' + uses.length + ' 镜引用' : '还没被用过') + '</span></div>'
        + '<div class="insp-sec"><div class="insp-st">基本信息</div>'
        + '<div class="insp-row"><span class="insp-rk">类型</span><span class="insp-rv">' + esc(D.LIB_KINDS[D.libKindOf(c)] || '') + '</span></div>'
        + '<div class="insp-row"><span class="insp-rk">分组</span><span class="insp-rv">' + esc(c.group || '未分组') + '</span></div>'
        + (D.isSceneItem(c) ? '<div class="insp-row"><span class="insp-rk">时段</span><span class="insp-rv">' + esc(c.time || '') + '</span></div>' : '')
        + '</div>'
        + '<div class="insp-sec"><div class="insp-st">描述</div>'
        + '<div class="insp-row"><span class="insp-rk">' + esc(kf.look.lab.split('（')[0]) + '</span></div>'
        + '<div class="ui-hint">' + esc(D.descOf(c) || '还没写描述') + '</div>'
        + '<div class="insp-row" style="margin-top:var(--sp-8)"><span class="insp-rk">' + esc(kf.bio.lab.split('（')[0]) + '</span></div>'
        + '<div class="ui-hint">' + esc(c.bio || '还没写') + '</div>'
        + '</div>'
        + (uses.length ? '<div class="insp-sec"><div class="insp-st">使用关系 · ' + uses.length + ' 个镜头</div>'
          + uses.slice(0, 6).map(u => '<div class="insp-use"><span>' + esc(u.pname) + '</span><span>' + esc(u.shname) + '</span><span>' + esc(u.sname) + '</span></div>').join('')
          + '</div>' : '')
        + '</div>'
        + '<div class="insp-foot">'
        + '<button class="pri" type="button" data-insp="open">打开详情</button>'
        + (pic ? '<button class="ghost" type="button" data-insp="reuse">拿去生成</button>' : '')
        + (pic ? '<button class="ghost" type="button" data-insp="similar">找相似</button>' : '')
        + '<button class="ghost danger" type="button" data-insp="del">从库里删掉</button>'
        + '</div>';
      /* 检查器里的图也走公共缩略图那一份（缓存命中直接用小图、失败换占位） */
      if (window.Wb && window.Wb.thumbs) window.Wb.thumbs.bindAll(el);
    }
    /* 检查器上的点击：几颗按钮各自干什么 */
    function onInspClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-insp]') : null;
      if (!t || !inspEl.value || !inspEl.value.contains(t)) return;
      const c = inspId.value ? itemOf(inspId.value) : null;
      if (!c) return;
      const act = t.getAttribute('data-insp');
      if (act === 'close') { toggleInsp(c.id, false); return; }
      if (act === 'open') { openDetail(c.id); return; }
      if (act === 'reuse') { const s2 = D.picOf(c); if (s2) window.Wb.reuse.go({ from: 'chars', mtype: '图片', src: s2, name: c.name || '' }); return; }
      if (act === 'similar') { findSimilar(c, ''); return; }
      if (act === 'del') { invoke(ACTS.del, c, t, null); return; }
    }

    /* 「素材详情」整屏层：新建 / 编辑一条素材都在那里（画面 + 文档两栏）。 */
    function makeDetail() {
      detail = createDetail({
        D,
        get REG() { return REG; },
        refUse, DRAFT,
        libSave, errSet, genRun, genHas, genSet, genClear, genMsg, onTaskHook, aiPanel,
        dramaWith, optsWith, defImgModel, defTtsModel, effKey,
        picWord, mainKind, candCount, durablePic, thumbImg, errText,
        saveField, queueFieldSave, syncDraft, draftOf,
        kindFields: c => kindF(D.libKindOf(c)),
        measureQuality,
        errsHTML,
        render: () => { render(); },
        findSimilar, openZoom,
        hostEl: rootEl.value,
        onClose: () => { inspId.value = ''; render(); },
        onCreated: (saved) => { openDetail(saved.id); },
      });
    }

    /* ---------- 展示样式与分页 ----------
       「显示到第几条 / 第 i 条要跳到哪一页」都归 `Wb.pager`（本地全量的续拉那一档由它数
       `morePages`），这一页只留「拿到该显示的条目」与「筛选变了回第一屏」。 */
    function pageItems() { return pager ? pager.slice(viewItems) : viewItems; }
    function resetPaging() { if (pager) pager.reset(); }

    /* ---------- 一次出齐这一档 ---------- */
    const FILL_CONC = 6;
    /* 这一档用的型号：**设置页那个默认**（素材库那张卡里管）。
       目录轨上原来有一行「出齐用」的下拉（这一轮现挑的，不落盘），那一行已经撤掉 ——
       型号只有一个出处：设置页「素材库」那张卡。当场换型号的需求走那一档自己的生成位。 */
    const fillModel = () => defImgModel();
    /* 型号的名字（给提示文案用）：跨平台同名是常事，所以带上平台名。 */
    const modelLabel = (kind, mode, key) => {
      try {
        const v = D.Pipe.pickProvModel(REG, kind, key || '', mode);
        if (!v) return '';
        const p = String(v.prov.displayName || v.prov.name || v.prov.id || '');
        const m = String(v.model.name || v.model.id || '');
        return p ? (p + ' · ' + m) : m;
      } catch (e) { return ''; }
    };
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
    async function fillRest() {
      if (!D || genHas('fill', null)) return;
      const p = fillPlan();
      if (!p.tasks) { Toast.warn(viewItems.length ? '这一档没有要补的图：每条都已经有预览图了' : '这一档里还没有素材'); return; }
      if (p.tasks > 1 && !await window.Confirm.ask({
        title: '一次出齐这一档',
        body: '这一档里有 ' + p.face + ' 条还缺预览图／道具图、' + p.three + ' 位角色还缺三视图，'
          + '一共发 ' + p.tasks + ' 次生图请求（每次出一张）。'
          + '用的型号：' + (modelLabel('image', 'text_to_image', fillModel()) || '（没有可用平台）') + '。'
          + '中途可以按「停下」，但已经发出去的那些收不回来，平台那边会照样跑完。',
        okLabel: '开始出',
      })) return;
      stopFlag = false;
      fillStoppable = p.jobs.length > 1;
      stopDisabled = false;
      let done = 0;
      genSet('fill', null, '一次出齐：0 / ' + p.jobs.length + ' 条…');
      try {
        await D.Pipe.runPool(p.jobs, FILL_CONC, async (j) => {
          if (stopFlag) return;
          const c = j.c;
          if (j.face) await genRun('face', c.id, c, '', hook => D.Pipe.drawPreview(REG, fakeDrama(fillModel()), c, { count: ONE, onTask: hook }), true);
          if (stopFlag) return;
          if (j.three) {
            if (!D.picOf(c)) {
              errSet('asset#three', c.id, '预览图这次没出来；三视图要照着它画，所以这一步跳过了');
              paintCard(c);
            } else {
              await genRun('asset#three', c.id, c, '', hook => D.Pipe.drawCharAsset(REG, fakeDrama(fillModel()), c, 'three', { count: ONE, onTask: hook }), true);
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

    /* ---------- 目录轨：类型 / 还缺什么 / 分组 ----------
       这一族都读 D.Lib.list() 与 refUse，不另存一份账：
       计数 = 现算覆盖度（每一行的数字只算「别的档不挡着」的那些），
       批量 = 对选中的那几条调同一批单条入口，
       锚点 = chars.js 的 refPicOf（生成与导演台参考图共用），
       视觉相似 = dHash 在本机画布上算（不上传、不调模型）。 */
    function matchGap(c) { return !gapFilter.value || match(c, gapFilter.value); }
    function matchGroup(c) { return !group.value || D.Lib.groupMatch(c, group.value); }
    function matchKind(c) { return kindFilter.value === 'all' || match(c, kindFilter.value); }

    function railRow(act, v, label, n, on, dot) {
      return '<button class="rail-row' + (on ? ' on' : '') + '" type="button" data-rail="' + act + '" data-v="' + esc(v) + '">'
        + (dot ? '<span class="missdot ' + esc(dot) + '"></span>' : '')
        + '<span>' + esc(label) + '</span><span class="n">' + n + '</span></button>';
    }
    function paintCharsRail() {
      const el = railScrollEl.value;
      if (!el || !D) return;
      const all = D.Lib.list();
      const countItems = fn => all.filter(c => c && fn(c)).length;
      /* 类型那一行的数字：按「除了类型以外的档」算（点了它就换这一档，看的是这一档里剩多少） */
      const kindRows = KIND_ROWS.map(r => railRow('kind', r[0], r[1],
        countItems(c => match(c, r[0]) && matchGap(c) && matchGroup(c)), kindFilter.value === r[0])).join('');
      /* 缺口那几行：同理，按「除了缺口以外的档」算 */
      const gapRows = GAP_ROWS.map(r => railRow('gap', r[0], r[1],
        countItems(c => match(c, r[0]) && matchKind(c) && matchGroup(c)), gapFilter.value === r[0], 'gap')).join('');
      const gs = D.Lib.groups();
      /* 分组那几行的数字：按「除了分组以外的档」算（点了它就换这一组，看的是这一组里剩多少）——
         三段的数字必须是同一个口径，否则会出现「角色 1 条 / 校园篇 2 条」这种对不上的读数。 */
      const inScope = all.filter(c => c && matchKind(c) && matchGap(c));
      const grpCount = name => inScope.filter(c => D.Lib.groupMatch(c, name)).length;
      const none = grpCount('__none');
      const grpRows = gs.map(g => railRow('group', g.name, g.name, grpCount(g.name), group.value === g.name)).join('')
        + (none ? railRow('group', '__none', '未分组', none, group.value === '__none') : '');
      const fill = fillPlan();
      const filling = genHas('fill', null);
      const fillWhy = !REG ? '正在读平台能力声明…'
        : (!D.Pipe.pickProvModel(REG, 'image', fillModel(), 'text_to_image')
          ? '现在没有可用的生图平台：到设置页「供应商与密钥」填一把密钥，或在设置页「素材库」那张卡里选一个默认型号'
          : (fill.tasks
            ? '这一档里 ' + fill.face + ' 条还缺预览图／道具图、' + fill.three + ' 位角色还缺三视图：每一条发一次生图请求，一次出一张'
            : (fill.usable ? '这一档里的预览图与三视图都齐了，没有要补的' : '这一档里没有素材')));
      el.innerHTML = '<div class="rail-sec"><div class="rail-st">类型</div>' + kindRows + '</div>'
        + '<div class="rail-sec"><div class="rail-st">还缺什么<span class="rail-acts">'
        + '<button class="rail-fix" type="button" data-rail="fill" title="' + esc(fillWhy) + '"' + (filling || !fill.tasks ? ' disabled' : '') + '>'
        + (filling ? '正在出齐…' : '出齐') + '</button>'
        + '<button class="rail-fix" type="button" data-rail="local" title="把这一档里「本机还没有那份字节」的图与参考音频存回本机">存本机</button>'
        + (filling ? '<button class="rail-fix" type="button" data-rail="stop" title="不再开新的任务（已经发出去的那些收不回来）">停下</button>' : '')
        + '</span></div>' + gapRows
        + '</div>'
        + '<div class="rail-sec"><div class="rail-st">分组</div>'
        + (grpRows || '<div class="ui-hint">还没有分组</div>') + '</div>';
      if (window.Dropdowns) window.Dropdowns.build(el);
      if (railSubEl.value) {
        const used = all.filter(c => (refUse.get(String(c.name || '')) || []).length).length;
        railSubEl.value.innerHTML = esc(all.length + ' 条 · ' + used + ' 条被导演台用到')
          + (busyText.value ? '<span class="rail-busy">' + esc(busyText.value) + '</span>' : '');
      }
    }
    /* 目录轨上的点击：换一档筛选，或触发那两个批量动作。 */
    function onRailClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-rail]') : null;
      if (!t || !railScrollEl.value || !railScrollEl.value.contains(t)) return;
      const act = t.getAttribute('data-rail');
      if (act === 'kind' || act === 'gap' || act === 'group') railPick(act, t.getAttribute('data-v'));
      else if (act === 'fill') fillRest();
      else if (act === 'local') pullLocal();
      else if (act === 'stop') onStop();
    }
    /* 目录轨上点一行 = 换一档筛选（再点同一行 = 回到不限） */
    function railPick(act, v) {
      if (act === 'kind') kindFilter.value = kindFilter.value === v && v !== 'all' ? 'all' : v;
      else if (act === 'gap') gapFilter.value = gapFilter.value === v ? '' : v;
      else if (act === 'group') group.value = group.value === v ? '' : v;
      resetPaging();
      render();
    }
    function jumpFilter(f) {
      kindFilter.value = 'all';
      gapFilter.value = f || '';
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
      stopDisabled = false;
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
    /* 多选态那一批用的型号：批量条上现挑的 → 设置页那个默认（不落盘）。 */
    const batchModel = () => BATCH.imgModel || defImgModel();
    const batchTts = () => BATCH.ttsModel || defTtsModel();
    async function batchFillPics() {
      const items = selectedItems().filter(c => !D.voiceOnlyOf(c) && !D.picOf(c));
      if (!items.length) return Toast.warn('选中的素材都不缺预览图：没有要补的');
      if (!REG || !D.Pipe.pickProvModel(REG, 'image', batchModel(), 'text_to_image')) return Toast.err('现在没有可用的生图平台：去设置页配一把密钥，或在批量条上挑一个型号');
      if (!await window.Confirm.ask({
        title: '给选中的 ' + items.length + ' 条补预览图',
        body: '每一条发一次生图请求（一次出一张），会花钱；中途可以按「停下」，但已经发出去的那些收不回来。'
          + '用的型号：' + (modelLabel('image', 'text_to_image', batchModel()) || '（没有可用平台）') + '。',
        okLabel: '开始补图',
      })) return;
      const r = await batchRun('补预览图', items, async c => {
        const ok = await genRun('face', c.id, c, '', hook => D.Pipe.drawPreview(REG, fakeDrama(batchModel()), c, { count: ONE, onTask: hook }), true);
        if (!ok) throw new Error('这一条没出成');
      });
      Toast[(r.fails ? 'warn' : 'ok')]('补预览图：' + r.done + ' 条处理完' + (r.fails ? '，' + r.fails + ' 条没成（原因留在各自卡片上）' : '') + (r.stopped ? '；已按「停下」' : ''), 7000);
    }
    async function batchFillAssets() {
      const items = selectedItems().filter(c => !isProp(c) && !isScene(c) && !D.voiceOnlyOf(c) && D.Cast.assetTplsOf(c).length && !D.Cast.assetsOf(c).length);
      if (!items.length) return Toast.warn('选中的角色都不缺角色资产：没有要补的');
      if (!REG || !D.Pipe.pickProvModel(REG, 'image', batchModel(), 'text_to_image')) return Toast.err('现在没有可用的生图平台：去设置页配一把密钥，或在批量条上挑一个型号');
      if (!await window.Confirm.ask({
        title: '给选中的 ' + items.length + ' 位补角色资产',
        body: '每位发一次生图请求，出一张三视图（会拿身份锚点 / 预览图当参考）；会花钱，中途可以按「停下」。没有预览图的会跳过并写清原因。'
          + '用的型号：' + (modelLabel('image', 'text_to_image', batchModel()) || '（没有可用平台）') + '。',
        okLabel: '开始补资产',
      })) return;
      const r = await batchRun('补角色资产', items, async c => {
        if (!D.picOf(c)) { errSet('asset#three', c.id, '预览图还没出：三视图要照着它画，这一步跳过了'); paintCard(c); throw new Error('没有预览图'); }
        const ok = await genRun('asset#three', c.id, c, '', hook => D.Pipe.drawCharAsset(REG, fakeDrama(batchModel()), c, 'three', { count: ONE, onTask: hook }), true);
        if (!ok) throw new Error('这一位没出成');
      });
      Toast[(r.fails ? 'warn' : 'ok')]('补角色资产：' + r.done + ' 位处理完' + (r.fails ? '，' + r.fails + ' 位没成（原因留在各自卡片上）' : '') + (r.stopped ? '；已按「停下」' : ''), 7000);
    }
    async function batchFillVoices() {
      if (!REG) return Toast.err('平台能力声明还没读回来，等这一页加载完再试');
      const vo = optsWith(batchTts());
      const items = selectedItems().filter(c => voiced(c) && !D.Cast.voiceReady(REG, vo, c).ok);
      if (!items.length) return Toast.warn('选中的角色都不缺声音配置：没有要补的');
      if (!window.TextAI) return Toast.err('文字 AI 模块还没加载');
      if (!await window.Confirm.ask({
        title: '让 AI 给选中的 ' + items.length + ' 位定声音',
        body: '逐位按人设写一段音色描述 / 选一个音色（调用文字 AI，会消耗 tokens；不会合成音频，也不会上传素材）。'
          + '定好之后自动落盘，之后在编辑区随时能改或试听。'
          + '用的语音平台：' + (modelLabel('audio', 'text_to_speech', batchTts()) || '（没有可用平台）') + '。',
        okLabel: '开始定声音',
      })) return;
      const r = await batchRun('AI 定声音', items, async c => {
        const got = await D.Pipe.autoVoice(REG, fakeDrama('', batchTts()), c, {});
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
      inspId.value = '';
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
    async function measureQuality(c, host) {
      if (!c) return;
      const el = host && host.querySelector('[data-q]');
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
      kindFilter.value = 'all'; gapFilter.value = ''; group.value = ''; q.value = ''; aiPick = null; aiWhy = ''; aiRank = null;
      inspId.value = id;
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
    /* 「存回本机」那颗按钮在目录轨上（画轨时一起画出来）：状态与忙闲仍归公共件
       `AssetLocal.pullBtn` —— 那一件管的是「还剩几个没存 / 正在存 / 存完了」的读数。 */
    function localBtnEl() {
      const el = railScrollEl.value;
      return el ? el.querySelector('[data-rail="local"]') : null;
    }
    function paintLocalBtn() {
      const btn = localBtnEl();
      if (!btn || !D) return;
      window.AssetLocal.pullBtn(btn, localPlan().length, {
        icon: false, disableEmpty: true, busyText: '正在存回本机…',
        zone: '这一档', what: '素材', unit: '个',
        empty: viewItems.length ? '这一档筛出来的素材，本机都已经有了，不用再存' : '这一档里还没有素材',
      });
    }
    async function pullLocal() {
      const btn = localBtnEl();
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
    /* 改完一条之后的收尾：写库 → 重画卡面与检查器（详情层开着就让它自己重画）。 */
    function keep(c, keepOpen) {
      libSave(c);
      setBusy('');
      if (inspId.value === c.id) { paintCard(c); paintInsp(); }
      else render();
    }
    /* 检查器：点一张卡就开（再点同一张 = 收）。 */
    async function toggleInsp(id, force) {
      const on = force == null ? inspId.value !== id : !!force;
      inspId.value = on ? id : '';
      await render();
    }
    /* 详情层：编辑一条（整屏层那一套） */
    async function openDetail(id) {
      if (!detail) return;
      inspId.value = id;
      await render();
      detail.open(id);
    }
    function openZoom(c, label, s2) {
      if (!s2) { Toast.err('这一条还没有这张图'); return; }
      const i = media.findIndex(x => x.s === s2);
      if (i >= 0) window.Wb.lightbox.open(media[i]);
      else window.Wb.lightbox.open({ key: 'char:' + c.id + ':' + s2, s: s2, name: c.name + ' · ' + (label || '图'), item: c });
    }


    /* ---------- 卡片上的动作（事件委托按名字派到这里） ----------
    /* 这一层只留**卡面上**那几个动作；编辑 / 出图 / 声音 / 角色资产那一族搬进
    /* 「素材详情」整屏层了（./chars/detail.js）—— 同一件事只有一份实现。 */
    const ACTS = {
      /* 点「编辑」= 打开这一条的详情（整屏层）。检查器里那颗「打开详情」是同一个去处。 */
      edit: async (c) => { await openDetail(c.id); },
      /* 点缩略图看大图（灯箱）：预览图与角色资产共用那一份。 */
      zoom: async (c, el) => { openZoom(c, el.dataset.label || el.dataset.name || picWord(c), el.dataset.src); },
      zoomface: async (c, el) => { openZoom(c, picWord(c), el.dataset.src || D.picOf(c)); },
      /* 「拿去生成」：带着这张去生成工作台，放进参考图那一栏。 */
      reuse: (c, el) => {
        const s2 = el.dataset.src || D.picOf(c);
        if (!s2) return Toast.err('这一条还没有图，先在详情里挑一张或让 AI 出一张');
        window.Wb.reuse.go({ from: 'chars', mtype: '图片', src: s2, name: el.dataset.name || c.name || '' });
      },
      /* 「找相似」：在本机按画面指纹找相似的图（不上传、不调模型）。 */
      similar: (c, el) => findSimilar(c, el.dataset.src || ''),
      /* 「从库里删掉」：这一条从素材库消失（本机存的参考音频一起删）。 */
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
          if (inspId.value === c.id) inspId.value = '';
          render();
        }
      },
    };

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
      const card0 = e.target.closest('.card');
      const c0 = card0 && itemOf(card0.dataset.id);
      /* 多选态：点卡片正文 = 勾选；那一排动作照旧可用 ——
         否则想一边多选一边改一条就得退出多选。 */
      if (multi.value && c0 && !e.target.closest('.macts')) {
        e.preventDefault();
        toggleSel(c0);
        return;
      }
      const t = e.target.closest('[data-a],[data-act]');
      if (t && root.contains(t)) {
        const card = t.closest('.card');
        const c = card && itemOf(card.dataset.id);
        if (!c) return;
        const name = t.dataset.a || t.dataset.act || '';
        if (!name) return;
        e.stopPropagation();
        invoke(ACTS[name], c, t, card);
        return;
      }
      /* 点卡片正文 = 右侧检查器开这一条（再点同一张 = 收）。 */
      if (c0) toggleInsp(c0.id);
    }
    /* 改完一个字段就地存（详情层与检查器共用这一份）：类型换了要拦重名，
       名字换了要问一句「导演台里有 N 处引用，回填吗」。 */
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
        kindFilter.value = 'all';
        gapFilter.value = '';
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

    /* ---------- 新建一条素材 ---------- */
    /* 新建就走「素材详情」那一层的空骨架：名字、类型、分组、描述都在那一页里填，
       填完直接出第一张图、挑好再存 —— 不再经过那个弹窗。 */
    async function newChar() {
      if (!D || !detail) return;
      detail.openNew({
        name: '', kind: 'actor', group: group.value === '__none' ? '' : group.value,
        look: '', bio: '', time: '深夜', pic: '',
      });
    }

    /* ---------- 多选态批量条上的两个型号下拉（出图 / 声音） ----------
       各自挑各自的：默认取设置页那一份，当场换的只管这一轮（不写回设置页）。 */
    function paintBatchPicks() {
      const mk = (host, kind, mode, val, onpick, empty) => {
        const el = host.value; if (!el) return;
        let h = '';
        try { h = D.Pipe.modelSelectHTML(REG, { kind: kind, mode: mode, value: effKey(kind, mode, val), emptyText: empty }); }
        catch (e) { h = '<span class="ui-hint">' + empty + '</span>'; }
        el.innerHTML = h.replace('<select ', '<select class="bk-model" ');
        const s = el.querySelector('select');
        if (s) s.onchange = () => { onpick(s.value); };
        if (window.Dropdowns) window.Dropdowns.build(el);
      };
      mk(bkImgPickEl, 'image', 'text_to_image', batchModel(), v => { BATCH.imgModel = v; }, '没配生图平台');
      mk(bkTtsPickEl, 'audio', 'text_to_speech', batchTts(), v => { BATCH.ttsModel = v; }, '没配语音平台');
    }

    /* ---------- 型号清单是**后到**的 ----------
       注册表里平台先在，型号清单是**能力接口一家一家回来才长出来的**
       （`Capabilities.load` 把它们并进 `prov.models`，每家落定广播一次 `wb:cap-ready`）。
       首屏那一刻多半还没有 —— 型号下拉会画成「没配生图平台」，那是句假话（平台明明配好了）。
       所以这一页自己拉一次能力，并按家补画（同一套做法见导演台右栏的 `installCapRepaint`）。 */
    let capTimer = 0;
    function onCapReady() {
      clearTimeout(capTimer);
      capTimer = setTimeout(() => {
        if (!alive) return;
        paintCharsRail();      // 目录轨「出齐用」那一行
        paintBatchPicks();     // 多选批量条上的出图 / 声音两行
        if (detail && detail.isOpen()) detail.paint();   // 详情层里那三处生成条
      }, 300);
    }
    function loadCaps() {
      if (!window.Capabilities || !REG) return;
      /* 不 await：拉能力可能要几秒（各家并发），首屏不等它 —— 用注册表兜底先把界面画出来，
         能力到了再按家补画。拉不到就用注册表那份声明，页面照常用。 */
      try { Promise.resolve(window.Capabilities.load(REG)).catch(() => {}); }
      catch (e) { /* 拉不到就用注册表兜底声明 */ }
    }

    /* ---------- 主渲染 ---------- */
    async function render() {
      if (!ready.value || !D) return;
      await loadRefUse();
      syncSel();
      const seq = ++renderSeq;
      paintCharsRail(); paintAiChip(); paintGroups(); paintBatchPicks();
      if (viewToggle) viewToggle.apply();
      const qv = q.value.trim();
      const all = D.Lib.list();
      let items = all.filter(c => c && matchKind(c) && matchGap(c) && matchGroup(c)
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
      paintInsp();
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
        chips: null,
        q: q.value,
        placeholder: searchPh.value,
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
      /* 旧的「本页默认」没有了 —— 它存过的那个本机键（char_opts）**清掉**：
         留着是一份没人再读的死数据（还占着本机存储配额）。
         只清这一个键，别的设置一个不碰。 */
      try { if (window.LS && LS.del) LS.del('char_opts'); } catch (e) { /* 删不掉也不拦这一页 */ }
      searchPh.value = '搜' + D.Lib.SEARCH_FIELDS.map(f => f[0]).join(' / ');
      bindToolbar();
      try { REG = await window.Api.registry(); } catch (e) { REG = { providers: [] }; Toast.err('读注册表失败：' + e.message); }
      ready.value = true;
      await render();
      loadCaps();
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
      stopDisabled = true;
      paintCharsRail();
    }
    function onStorage() { if (ready.value) render(); }
    function onPointerUp() { if (!isActive()) return; setTimeout(flushHeads, 0); }
    function onDocKey(e) {
      if (!isActive()) return;
      if (e.key !== 'Escape') return;
      if (e.target && toolbarFb && e.target === toolbarFb.input) return;
      if (document.querySelector('dialog[open]')) return;
      if (window.Wb && window.Wb.lightbox && window.Wb.lightbox.isOpen && window.Wb.lightbox.isOpen()) return;
      if (detail && detail.isOpen()) { detail.close(); return; }
      if (inspId.value) toggleInsp(inspId.value, false);
    }
    function onVisibleChange() {
      /* 切回这一页时把「被 N 镜引用」重新数一遍（旧页每次打开都会读一次盘）；
         编辑区开着就不整页重画，免得把正在敲的字换掉。
         灯箱与详情的配置不用这一页管：公共层按前台页装回各自那一份（见 registerAdapters）。 */
      if (ready.value && !inspId.value) { refUseAt = 0; render(); }
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
        makeDetail();
        if (railScrollEl.value) {
          railScrollEl.value.addEventListener('click', onRailClick);
        }
        /* 能力一家一家落定 → 型号清单长出来 → 型号下拉补画（见 loadCaps 那段注释） */
        window.addEventListener('wb:cap-ready', onCapReady);
        if (inspEl.value) inspEl.value.addEventListener('click', onInspClick);
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
      if (railScrollEl.value) {
        railScrollEl.value.removeEventListener('click', onRailClick);
      }
      window.removeEventListener('wb:cap-ready', onCapReady);
      clearTimeout(capTimer);
      if (sentinelIO && sentinelIO.disconnect) { try { sentinelIO.disconnect(); } catch (e) { /* 观察器已经断开就没有可断开的 */ } }
      if (offActivity) offActivity();
      unregisterAdapters();
      /* 助手那一侧按 `window.__charsChanged` 喊这一页重画：页面已经不在了，钩子不能继续指着它。 */
      window.__charsChanged = null;
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      rootEl, matEl, toolbarEl, railScrollEl, railSubEl, grpListEl, viewEl, inspEl,
      btnNewEl, btnMultiEl, railToggleEl, bkImgPickEl, bkTtsPickEl, aiLiveEl,
      gridEl, gridEndEl, pagerRowEl,
      ready, failed, cards, inspId, railOpen, q, cntText, busyText,
      pagerVisible, emptyHtml,
      ticHtml, newBtnHtml, aiBtnHtml,
      multi, batchCount, batchText, batchGroup, isPicked,
      runAiFind, newChar,
      onGridClick, onGridDragStart, onGridDragEnd,
      toggleMulti, toggleInsp,
      batchFillPics, batchFillAssets, batchFillVoices, batchSetGroup, batchRemove,
    };
  },
  render,
};
