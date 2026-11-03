/* 素材库 —— 由 chars.html 迁到 Vue 3 的页面。
   数据与副作用全部走已有的公共层（Chars / Wb / AssetLocal / AssetPicker / AssetTransfer /
   AiFind / AiChip / Chips / Dropdowns / Confirm / Toast），组件只负责「这一屏长什么样」。
   `chars.js` 仍是全站唯一的数据层（Chars.Pipe / Chars.Lib / Chars.Cast / Chars.SET），
   这一页一个字都不重写它。

   布局是两栏 + 一层覆盖检查器：
     · 左「目录轨」：类型 / 分组；
     · 中「素材台」：一行工具 + 紧凑卡片网格 + 底部翻页行；
     · 覆盖「检查器」：点一张卡才出现，浮在内容之上 —— 不占网格列、不挤压卡片。
   「新建 / 编辑一条素材」挪到**整屏层**（`./chars/detail.js`）：那一层有自己的骨架
   （左边画面吸顶、右边一条连续文档）与「每个生成位自带型号与数量」的生成条。

   与旧页的两点结构差异（行为不变）：
   ① 卡片不再逐个 `bindCard`：网格上用事件委托接 `data-a` / `data-act` / `data-f`，
      重画只换那一张卡的 html 字符串（焦点由 paintCard 还回去，与旧实现同一套判据）；
   ② `document.getElementById` 只出现在公共模块要求的那几处 id（分页按钮交给 Wb.pager 的
      `pgPrevId` 一档、AiChip 的清除键给唯一 id），页面自己的元素全走 ref。 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/chars.js';
import { createDetail, detailDots, detailStat } from './chars/detail.js';

const PAGE_MODE = window.pageModeOf('chars');
const PAGE_SIZE = window.pageSizeOf('chars');
/* 三种类型各一档（与库里那三种平级，道具是 2026-10 加的）—— 目录轨「类型」那一节。 */

const KIND_ROWS = [['all', '全部', 'layers'], ['actor', '角色', 'users'], ['scene', '场景', 'image'], ['prop', '道具', 'box']];

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
    const btnNewEl = ref(null);
    const libraryCount = ref(0);
    const btnMultiEl = ref(null);
    const railToggleEl = ref(null);
    const bkImgPickEl = ref(null);
    const bkTtsPickEl = ref(null);
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
    const newBtnHtml = (window.icon ? icon('plus', 13) : '') + ' 新建素材';

    /* ---------- 数据层与本地记账 ---------- */
    let D = window.Chars || null;
    let REG = null;
    let alive = true;
    /* 顶部主工具条（搜索 / AI 按钮 / AI 条件芯片 / 计数）由 Wb.filterBar 生成，
       这一页只留点完之后做什么；aiFindBtn / aiChipEl 在 bind 之后指回那一份里的节点。 */
    let toolbarFb = null;
    /* 目录轨上的一档筛选：类型（全部/角色/场景/道具）与分组各自独立。 */
    const kindFilter = ref('all');
    const group = ref('');            // '' = 全部组；'__none' = 未分组
    let groupDraft = false;           // 左栏正在建组：草稿行与输入框已出现，还没落盘
    let groupDraftName = '';
    let groupFocusPending = false;
    const scopeTitle = computed(() => [
      group.value === '__none' ? '未分组' : group.value,
      KIND_ROWS.find(r => r[0] === kindFilter.value)[1] + '素材',
    ].filter(Boolean).join(' · '));
    let aiPick = null, aiWhy = '', aiRank = null;
    let aiAsked = false;   // 正在问 AI：回包落定时要把「这句话已经消化过」登记给公共搜索条
    let busyMsg = '';
    let renderSeq = 0;
    const viewItems = [];             // 当前视图的素材（灯箱翻页范围）
    const media = [];                 // 当前视图能点开看的图（预览图 + 各资产）
    let refUse = new Map(), refUseAt = 0;
    let pager = null;
    let offStorage = null;
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
      const kindIcon = KIND_ROWS.find(r => r[0] === D.libKindOf(c))[2];
      const thumb = vo
        ? `<div class="mthumb mph-empty card-shell-media"><div class="none">${icon('mic', 32)}<b>只出声</b></div></div>`
        : `<div class="mthumb${isScene(c) ? ' mph-scene' : ''} card-shell-media"${faceBusy ? '' : ` data-a="${pic ? 'zoomface' : 'edit'}"`} title="${faceBusy
          ? '正在出' + esc(pw) + '：出来会自动换上'
          : pic ? pw + '：点一下看大图'
            : '还没有' + pw + '：点这里打开详情，挑一张或让 AI 出一张'}">
          ${faceBusy ? `<div class="none">${D.Cast.waitHTML('正在出' + pw)}</div>`
            : pic ? thumbImg(pic) + (c.anchor && c.anchor === pic ? '<span class="anchorbadge" title="出图优先用它">锚点</span>' : '')
              : `<div class="none">${icon(kindIcon, 32)}<b>暂无${esc(pw)}</b></div>`}
          ${errHTML ? '<div class="thumb-why">' + errHTML + '</div>' : ''}</div>`;
      const pickedNow = sel.value.has(c.id);
      const uses = (refUse.get(String(c.name || '')) || []).length;
      const kindLab = D.LIB_KINDS[D.libKindOf(c)] || '';
      const acts = window.Wb.actsHTML(c, {
        items: [
          { act: 'edit', icon: 'pencil', label: '编辑', title: '打开这一条的详情：改描述、出图、配声音' },
          pic ? { act: 'reuse', icon: 'reuse', label: '拿去生成', title: '带着这张' + esc(pw) + '去工作台，放进参考图那一栏', data: { src: pic, name: c.name || '' } } : null,
          pic ? { act: 'similar', icon: 'search', label: '找相似', title: '在本机素材库里按画面指纹找相似的图（不上传、不调模型）' } : null,
          { act: 'del', icon: 'trash', label: '删除', danger: true },
        ].filter(Boolean),
      });
      return `${multi.value ? `<div class="pick${pickedNow ? ' on' : ''}" title="勾选后批量补缺 / 分组 / 删除">${pickedNow ? '✓' : ''}</div>` : ''}${thumb}
        <div class="mbody card-shell-body">
          <div class="mmeta"><span class="mkind">${icon(kindIcon, 12)}${esc(kindLab)}</span>
            <span class="mgroup">${esc(c.group || '未分组')}</span></div>
          <div class="mrow"><span class="mname" id="chars-name-${esc(c.id)}">${esc(c.name || '（无名）')}</span>
            ${uses ? '<span class="mrefs">' + uses + ' 镜引用</span>' : ''}</div>
          <p class="mbio">${esc(D.descOf(c) || c.bio || '暂无描述')}</p>
          <div class="mfoot"><span class="mstat-pill">${detailDots(D, c)}${detailStat(D, c)}</span></div>
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
      if (bio) bio.textContent = D.descOf(c) || c.bio || '暂无描述';
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

    /* ---------- 筛选：目录轨上两档各自独立（类型 / 分组） ---------- */
    function match(c, f) {
      if (!f || f === 'all') return true;
      return D.libKindOf(c) === f;
    }
    function paintAiChip() {
      if (!aiChipEl.value) return;
      window.AiChip.show(aiChipEl.value, {
        on: !!aiPick, picked: aiPick && aiPick.size, why: aiWhy,
        clearId: 'charsAiClear', onClear: clearAiPick,
      });
    }
    /* 收掉 AI 结果 = 回到完整列表：框里那句原话一起清掉（否则它立刻变成普通搜索词，结果还是被筛着）。 */
    function clearAiPick() {
      q.value = '';
      if (toolbarFb) { toolbarFb.setQuery(''); toolbarFb.markApplied(''); }
      window.AiFind.clear(AI);
    }
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
      /* 整块重画罩在公共件里：`.insp-scroll` 是这一次字符串里的子节点，换新节点等于从 0 起 ——
         表现是「检查器滚到描述中段点一颗按钮，那一列弹回顶」。锚点按身份找不到就用下标链，
         两种都在这一趟里还。 */
      window.Wb.viewport.keep(el, () => {
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
          + '<button class="pri" type="button" data-insp="open"><span class="ic">' + icon('expand', 15) + '</span><span class="tx">打开详情</span></button>'
          + (pic ? '<button class="ghost" type="button" data-insp="reuse"><span class="ic">' + icon('reuse', 15) + '</span><span class="tx">拿去生成</span></button>' : '')
          + (pic ? '<button class="ghost" type="button" data-insp="similar"><span class="ic">' + icon('search', 15) + '</span><span class="tx">找相似</span></button>' : '')
          + '<button class="ghost danger" type="button" data-insp="del"><span class="ic">' + icon('trash', 15) + '</span><span class="tx">从库里删掉</span></button>'
          + '</div>';
      });
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
        libSave, errSet, genRun, genHas, genSet, genClear, genMsg, onTaskHook,
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

    /* ---------- 多选批量生成 ---------- */
    const FILL_CONC = 6;
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
    /* ---------- 目录轨：类型 / 分组 ----------
       这一族都读 D.Lib.list() 与 refUse，不另存一份账：
       计数 = 现算覆盖度（每一行的数字只算「别的档不挡着」的那些），
       批量 = 对选中的那几条调同一批单条入口，
       锚点 = chars.js 的 refPicOf（生成与导演台参考图共用），
       视觉相似 = dHash 在本机画布上算（不上传、不调模型）。 */
    function matchGroup(c) { return !group.value || D.Lib.groupMatch(c, group.value); }
    function matchKind(c) { return kindFilter.value === 'all' || match(c, kindFilter.value); }

    function railRow(act, v, label, n, on, glyph) {
      return '<button class="rail-row' + (on ? ' on' : '') + '" type="button" aria-pressed="' + on + '" data-rail="' + act + '" data-v="' + esc(v) + '">'
        + icon(glyph || 'folder', 16)
        + '<span title="' + esc(label) + '">' + esc(label) + '</span><span class="n">' + n + '</span></button>';
    }
    function beginNewGroup() {
      if (!D) return;
      if (groupDraft) {
        const inp = railScrollEl.value && railScrollEl.value.querySelector('.rail-new-inp');
        if (inp) window.focusQuiet ? window.focusQuiet(inp) : inp.focus();
        return;
      }
      groupDraft = true;
      groupDraftName = '';
      groupFocusPending = true;
      paintCharsRail();
    }
    function cancelNewGroup() {
      groupDraft = false;
      groupDraftName = '';
      groupFocusPending = false;
      paintCharsRail();
    }
    /* 建组这一下只写组名（char_groups）；素材还是一条都没有。建完直接把当前筛选切到新组，
       接着点「新建素材」时 newChar 会把 group.value 带进详情表单。 */
    async function commitNewGroup() {
      if (!D || !groupDraft) return true;
      const name = String(groupDraftName || '').trim().slice(0, 20);
      if (!name) {
        groupFocusPending = true;
        paintCharsRail();
        Toast.warn('先给这个组起个名字');
        return false;
      }
      const r = D.Lib.addGroup(name);
      if (!r || !r.ok) {
        Toast.err((r && r.why) || '建组没成功');
        groupFocusPending = true;
        paintCharsRail();
        return false;
      }
      groupDraft = false;
      groupDraftName = '';
      groupFocusPending = false;
      group.value = r.name;
      resetPaging();
      await render();
      Toast.receipt(r.existing ? '已切到分组「' + r.name + '」' : '已新建分组「' + r.name + '」');
      return true;
    }
    function paintCharsRail() {
      const el = railScrollEl.value;
      if (!el || !D) return;
      const all = D.Lib.list();
      const countItems = fn => all.filter(c => c && fn(c)).length;
      /* 类型那一行的数字：按「除了类型以外的档」算（点了它就换这一档，看的是这一档里剩多少） */
      const kindRows = KIND_ROWS.map(r => railRow('kind', r[0], r[1],
        countItems(c => match(c, r[0]) && matchGroup(c)), kindFilter.value === r[0], r[2])).join('');
      const gs = D.Lib.groups();
      /* 分组那几行的数字：按「除了分组以外的档」算（点了它就换这一组，看的是这一组里剩多少）——
         两段的数字必须是同一个口径，否则会出现「角色 1 条 / 校园篇 2 条」这种对不上的读数。 */
      const inScope = all.filter(c => c && matchKind(c));
      const grpCount = name => inScope.filter(c => D.Lib.groupMatch(c, name)).length;
      const none = grpCount('__none');
      const grpRows = gs.map(g => railRow('group', g.name, g.name, grpCount(g.name), group.value === g.name)).join('')
        + (none ? railRow('group', '__none', '未分组', none, group.value === '__none') : '');
      const draftHTML = groupDraft
        ? '<div class="rail-new"><input class="rail-new-inp" maxlength="20" placeholder="新组名称" autocomplete="off">'
          + '<button class="ghost mini" type="button" data-rail="newgroup-ok">建组</button>'
          + '<button class="ghost mini" type="button" data-rail="newgroup-cancel">取消</button></div>'
        : '';
      window.Wb.viewport.keep(el, () => {
        el.innerHTML = '<div class="rail-sec">' + kindRows + '</div>'
          + '<div class="rail-sec"><div class="rail-st"><span>素材分组</span>'
          + '<button class="ui-linkbtn rail-new-btn" type="button" data-rail="newgroup">' + icon('plus', 12) + ' 新建组</button></div>'
          + draftHTML
          + (grpRows || (groupDraft ? '' : '<div class="ui-hint">暂无分组</div>')) + '</div>';
      });
      const inp = el.querySelector('.rail-new-inp');
      if (inp) {
        inp.value = groupDraftName;
        inp.addEventListener('input', () => { groupDraftName = inp.value; });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitNewGroup(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelNewGroup(); }
        });
        if (groupFocusPending) {
          groupFocusPending = false;
          window.focusQuiet ? window.focusQuiet(inp) : inp.focus();
        }
      }
      if (window.Dropdowns) window.Dropdowns.build(el);
      libraryCount.value = all.length;
      if (railSubEl.value) {
        const used = all.filter(c => (refUse.get(String(c.name || '')) || []).length).length;
        railSubEl.value.innerHTML = '<b>' + used + '</b> 项已用于导演台'
          + (busyText.value ? '<span class="rail-busy">' + esc(busyText.value) + '</span>' : '');
      }
    }
    /* 目录轨上的点击：换一档筛选。 */
    function onRailClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-rail]') : null;
      if (!t || !railScrollEl.value || !railScrollEl.value.contains(t)) return;
      const act = t.getAttribute('data-rail');
      if (act === 'newgroup') beginNewGroup();
      else if (act === 'newgroup-ok') commitNewGroup();
      else if (act === 'newgroup-cancel') cancelNewGroup();
      else if (act === 'kind' || act === 'group') railPick(act, t.getAttribute('data-v'));
    }
    /* 目录轨上点一行 = 换一档筛选（再点同一行 = 回到不限） */
    function railPick(act, v) {
      if (act === 'kind') kindFilter.value = kindFilter.value === v && v !== 'all' ? 'all' : v;
      else if (act === 'group') group.value = group.value === v ? '' : v;
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
      genSet('fill', null, label + '：0 / ' + jobs.length);
      let done = 0, fails = 0;
      try {
        await D.Pipe.runPool(jobs, FILL_CONC, async j => {
          try { await worker(j); } catch (e) { fails++; }
          done++;
          batchText.value = label + '：' + done + ' / ' + jobs.length;
          if (genHas('fill', null)) genSet('fill', null, batchText.value);
        });
      } finally {
        genClear('fill', null);
        batchBusy.value = false;
        batchText.value = '';
        await render();
      }
      return { done, fails };
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
        body: '逐条生图，会花钱；已发出的收不回。'
          + '用的型号：' + (modelLabel('image', 'text_to_image', batchModel()) || '（没有可用平台）') + '。',
        okLabel: '开始补图',
      })) return;
      const r = await batchRun('补预览图', items, async c => {
        const ok = await genRun('face', c.id, c, '', hook => D.Pipe.drawPreview(REG, fakeDrama(batchModel()), c, { count: ONE, onTask: hook }), true);
        if (!ok) throw new Error('这一条没出成');
      });
      Toast[(r.fails ? 'warn' : 'ok')]('补预览图：' + r.done + ' 条处理完' + (r.fails ? '，' + r.fails + ' 条没成（原因留在各自卡片上）' : ''), 7000);
    }
    async function batchFillAssets() {
      const items = selectedItems().filter(c => !isProp(c) && !isScene(c) && !D.voiceOnlyOf(c) && D.Cast.assetTplsOf(c).length && !D.Cast.assetsOf(c).length);
      if (!items.length) return Toast.warn('选中的角色都不缺角色资产：没有要补的');
      if (!REG || !D.Pipe.pickProvModel(REG, 'image', batchModel(), 'text_to_image')) return Toast.err('现在没有可用的生图平台：去设置页配一把密钥，或在批量条上挑一个型号');
      if (!await window.Confirm.ask({
        title: '给选中的 ' + items.length + ' 位补角色资产',
        body: '每位发一次生图请求，出一张三视图（会拿身份锚点 / 预览图当参考）；会花钱。没有预览图的会跳过并写清原因。'
          + '用的型号：' + (modelLabel('image', 'text_to_image', batchModel()) || '（没有可用平台）') + '。',
        okLabel: '开始补资产',
      })) return;
      const r = await batchRun('补角色资产', items, async c => {
        if (!D.picOf(c)) { errSet('asset#three', c.id, '预览图还没出：三视图要照着它画，这一步跳过了'); paintCard(c); throw new Error('没有预览图'); }
        const ok = await genRun('asset#three', c.id, c, '', hook => D.Pipe.drawCharAsset(REG, fakeDrama(batchModel()), c, 'three', { count: ONE, onTask: hook }), true);
        if (!ok) throw new Error('这一位没出成');
      });
      Toast[(r.fails ? 'warn' : 'ok')]('补角色资产：' + r.done + ' 位处理完' + (r.fails ? '，' + r.fails + ' 位没成（原因留在各自卡片上）' : ''), 7000);
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
      Toast[(r.fails ? 'warn' : 'ok')]('AI 定声音：' + (r.done - r.fails) + ' 位定好' + (r.fails ? '，' + r.fails + ' 位没成（原因留在各自卡片上）' : ''), 7000);
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
      if (busy.length) return Toast.err('有 ' + busy.length + ' 条正在生成（' + busy.map(c => c.name).slice(0, 3).join('、') + '），等它们跑完再删', 7000);
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
      kindFilter.value = 'all'; group.value = ''; q.value = ''; aiPick = null; aiWhy = ''; aiRank = null;
      /* 程序性清空也要把框里的字与「跑过的词」一起收回：否则失焦时旧词会被当成普通搜索再跑一遍。 */
      if (toolbarFb) { toolbarFb.setQuery(''); toolbarFb.markApplied(''); }
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

    /* ---------- 自动补存：把这一屏还没落到本机的图排进镜像队列 ---------- */
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
    /* 检查器：点一张卡就开（再点同一张 = 收）。 */
    async function toggleInsp(id, force) {
      const on = force == null ? inspId.value !== id : !!force;
      if (on) railOpen.value = false;
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
      /* 「拿去生成」：带着这张去工作台，放进参考图那一栏。 */
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
        if (busy) return Toast.err('这一条正有一项在生成（' + errLabel(busy, c) + '），等它跑完再删 —— 现在删掉，那一轮收尾会把它写回库里');
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

    function activateCard(id) {
      const c = itemOf(id);
      if (!c) return;
      if (multi.value) toggleSel(c);
      else toggleInsp(id);
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
        const name = t.dataset.a || t.dataset.act || '';
        if (!name) return;
        e.stopPropagation();
        /* 空态那颗「新建」不在卡片里 —— 直接开新建，不走卡片取数。 */
        if (name === 'newchar') { newChar(); return; }
        const card = t.closest('.card');
        const c = card && itemOf(card.dataset.id);
        if (!c) return;
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
        /* 改名回填：按 id 找全片 refMeta 条目 → 刷 label；正文 @旧名 刷成 @新名。
           refMeta.id 一个字不动 —— 身份与名字分开。 */
        if (nameBefore && saved.name !== nameBefore) {
          try { await backfillRename(c, nameBefore, saved.name); } catch (e) { /* 回填失败不影响改名本身 */ }
        }
        nameBefore = saved.name;
      }
      return k;
    }
    /* 改名回填：把全片对这一条的引用刷成新名（改写规则只有 `Chars.renameShotRefs` 一份）。
       落盘分两条路 —— 导演台在场就写它活内存里那份（直写 Kv 会被它下一次整包保存静默冲掉），
       不在场才自己落 Kv + 镜像。回执报「N 处引用已改名」（N = 实际改动的镜数）。
       老工程 refMeta 没 id 的按 label 兜底匹配一次（只改 label，不写 id）。 */
    async function backfillRename(c, oldName, newName) {
      const id = c && c.id;
      oldName = String(oldName || '').trim();
      newName = String(newName || '').trim();
      if (!id || !oldName || !newName || oldName === newName) return 0;
      const rewrite = (projects) => {
        try { return (D && D.renameShotRefs) ? (D.renameShotRefs(projects, { id, oldName, newName }) || 0) : 0; }
        catch (e) { return 0; }
      };
      let n = 0;
      /* ① 导演台桥（活内存）：改完它自己排静默落盘。 */
      const br = window.WBBridge && window.WBBridge.get ? window.WBBridge.get('director') : null;
      if (br && typeof br.libRenameBackfill === 'function') {
        try { n = Number(br.libRenameBackfill({ id, oldName, newName })) || 0; } catch (e) { n = 0; }
      }
      /* ② 兜底：本会话没装导演台桥 —— 读工作区那份，改完写回去（IndexedDB + 代理镜像）。 */
      if (!n) {
        try {
          const ws = await window.Kv.at('ws').get('workspace');
          const projects = (ws && ws.projects) || [];
          n = rewrite(projects);
          if (n) {
            const rec = { projects, curId: ws.curId, roles: ws.roles, groups: ws.groups, ts: Date.now() };
            await window.Kv.at('ws').put('workspace', rec);
            try { if (window.DataSync) DataSync.mirrorWs(JSON.stringify({ v: 1, data: rec, ts: rec.ts })); } catch (e) { /* 镜像推不动不影响本机那一份已经落下去 */ }
          }
        } catch (e) { /* 工程数据不可达时回填跳过 */ }
      }
      if (n) Toast.receipt('改名完成：' + n + ' 处引用已跟着改');
      return n;
    }
    /* ---------- AI 搜索 ---------- */
    /* 素材 id 是 20 位随机串：让模型原样抄，错一个字符就整批对不上（看起来就是「搜了没反应」）。
       所以给模型看的是名单里的**编号**（1..N），收回时再换算成 id；也兼容它回原 id 或名字。 */
    const aiCharOf = x => {
      const xs = String(x == null ? '' : x).trim();
      const list = D.Lib.list();
      const n = Number(xs);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
      return D.Lib.get(xs) || list.find(c => c && c.name === xs) || null;
    };
    const aiCharId = x => { const c = aiCharOf(x); return c ? c.id : ''; };
    const AI = {
      btn: () => aiFindBtn.value,
      /* 问 AI 的那句话从**输入框**现读：现在只有回车 / 失焦 / 清空才同步 q，打字过程中 q 还是旧值。 */
      ask: () => (toolbarFb ? toolbarFb.value() : q.value),
      focus: () => { if (toolbarFb) toolbarFb.focus(); },
      emptyMsg: '还没有素材',
      noneMsg: 'AI 没挑到合适的（换个说法再试）',
      roster: () => D.Lib.list(),
      field: 'ids',
      known: x => !!aiCharOf(x),
      payload: (query, all) => ({
        需求: query,
        素材库: all.map((c, i) => ({
          编号: i + 1, 名字: c.name, 类型: D.LIB_KINDS[D.libKindOf(c)], 分组: c.group || '', 人设: c.bio || '', 描述: c.look || '',
        })),
      }),
      sys: '你是选角导演：用户会用一句话描述需求，你要从他收藏的素材里挑最合适的几条。\n'
        + '规则：\n1. 只输出 JSON，不要解释、不要 markdown：{"ids":["编号"],"summary":"一句话说明按什么挑的"}\n'
        + '2. ids 写名单里那一行开头的「编号」（数字），不要返回名字或其它字段。\n'
        + '3. 优先级：外貌/描述 > 一句话人设/用途 > 类型（角色出镜、场景是地方不是人、道具是物件）。\n'
        + '4. 宁缺毋滥：没有合适的就返回空数组。\n5. summary 说清你的理解，界面会显示给用户。',
      apply: s => {
        /* 把 AI 回的编号 / id / 名字统一换成素材 id（认不到的直接丢）。 */
        const ids = s.pick ? [...s.pick].map(aiCharId).filter(Boolean) : [];
        aiPick = ids.length ? new Set(ids) : null;
        aiRank = (s.rank && ids.length)
          ? new Map([...s.rank].map(([x, n]) => [aiCharId(x), n]).filter(([k]) => k))
          : null;
        aiWhy = s.why;
        /* 这句话已经交给 AI 了：登记成「跑过的词」，失焦时不再当普通搜索重跑一遍。 */
        if (aiAsked && toolbarFb) toolbarFb.markApplied(toolbarFb.value());
      },
      /* AI 挑的是跨类型的一批：类型档放回「全部」才看得全；框里那句话留着（用户还要改）。 */
      onPick: () => { kindFilter.value = 'all'; },
      done: () => { resetPaging(); return render(); },
      /* 回执同时进计数行与 toast：失败 / 没挑到在素材库这种大网格里很容易被当成「点了没反应」。 */
      say: t => { setCnt(t); if (t) window.Toast.warn(t); },
    };
    const runAiFind = async () => {
      aiAsked = true;
      try { await window.AiFind.run(AI); } finally { aiAsked = false; }
    };

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
            while ((m = re.exec(txt))) {
              names.add(m[2]);
              /* 资产 token（`@小雅·三视图`）也是对「小雅」的引用 —— 名字段再记一份，
                 否则卡上「N 镜引用」与改名确认框都漏掉它（改名回填会换它，口径要一致）。 */
              const dot = m[2].indexOf('·');
              if (dot > 0) names.add(m[2].slice(0, dot));
            }
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
      if (groupDraft && !await commitNewGroup()) return;
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
      /* AI 挑着的时候，框里那句话已经变成挑选集合，不再参与字面 / 语义过滤。 */
      const qv = aiPick ? '' : q.value.trim();
      const all = D.Lib.list();
      let items = all.filter(c => c && matchKind(c) && matchGroup(c)
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
      setCnt(items.length + ' 项');
      pagerVisible.value = items.length > 0;
      if (!items.length) {
        cards.value = [];
        const gname = group.value === '__none' ? '' : group.value;
        const emptyText = qv ? '暂无匹配素材'
          : gname ? '「' + gname + '」还没有素材'
            : group.value === '__none' ? '未分组里还没有素材'
              : all.length ? '暂无匹配素材' : '还没有素材';
        /* 库真为空且没有筛选时，给一颗「新建」主按钮（按钮是动作，不是说明）。 */
        const emptyNew = !all.length && !qv && !gname && group.value !== '__none';
        emptyHtml.value = '<span class="empty-ic">' + icon('layers', 24) + '</span><span>' + esc(emptyText) + '</span>'
          + (emptyNew ? '<button type="button" class="pri" data-a="newchar">新建素材</button>' : '');
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
      registerAdapters();
    }

    /* 顶部主工具条只在这里建一次：结构与接线归 Wb.filterBar（搜索防抖、芯片渲染、计数都在那一份），
       这一页只把「AI 搜索」按钮（画法与文案在公共层 AiFind.btnHTML）与它的条件芯片作为
       extraHTML 传进去，再捎回节点接自己的行为。 */
    function bindToolbar() {
      if (!toolbarEl.value) return;
      toolbarFb = window.Wb.filterBar.bind(toolbarEl.value, {
        chips: null,
        cnt: false,
        q: q.value,
        placeholder: searchPh.value,
        ariaLabel: '搜索素材',
        /* 普通搜索 = 一次新的搜索：AI 挑过的那批先收回（换词就按词筛，不再叠 AI 的名次与集合）。 */
        onSearch: v => {
          q.value = v;
          if (aiPick) { aiPick = null; aiRank = null; aiWhy = ''; }
          resetPaging(); render();
        },
        /* Esc 清掉搜索框与 AI 条件（清完由 AI 的 done 重画一次）。 */
        onEscape: () => clearAiPick(),
        extraHTML: window.AiFind.btnHTML() + '<span data-fb="aiChip"></span>',
      });
      if (!toolbarFb) return;
      aiFindBtn.value = toolbarFb.el.querySelector('.fb-ai');
      aiChipEl.value = toolbarFb.el.querySelector('[data-fb="aiChip"]');
      if (aiFindBtn.value) aiFindBtn.value.onclick = runAiFind;
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
        /* 两份互不依赖（chars.js 求值时不读 Wb），一起取 */
        await Promise.all([
          window.__spaLoadScript('web/ui/workbench.js', () => window.Wb),
          window.__spaLoadScript('web/domain/chars.js', () => window.Chars),
        ]);
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
      /* 模板里那些静态 `<span data-icon>`（页头铭牌那几层）：ui.js 的 fillIcons 只在外壳
         DOMContentLoaded 跑过一次，那时本页还没挂载 —— 不在这里补一遍，页头图标是空的。 */
      if (rootEl.value) window.fillIcons(rootEl.value);
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
      offStorage = window.StorageBus.on(['char_lib', 'char_groups'], onStorage);
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
      rootEl, matEl, toolbarEl, railScrollEl, railSubEl, grpListEl, inspEl,
      btnNewEl, btnMultiEl, railToggleEl, bkImgPickEl, bkTtsPickEl,
      gridEl, gridEndEl, pagerRowEl,
      ready, failed, cards, inspId, railOpen,
      libraryCount, scopeTitle, cntText, activateCard,
      pagerVisible, emptyHtml,
      newBtnHtml,
      multi, batchCount, batchBusy, batchText, batchGroup, isPicked,
      newChar,
      beginNewGroup,
      onGridClick, onGridDragStart, onGridDragEnd,
      toggleMulti,
      batchFillPics, batchFillAssets, batchFillVoices, batchSetGroup, batchRemove,
    };
  },
  render,
};
