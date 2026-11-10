/* 导演台Estimate域：费用预估（统一按 REGISTRY 的 pricing 声明估价）与画面生成（时间切片）——
   六档高参 / 三排声明驱动控件 / 拆分选项、关键帧的规划与出图、参考图补挂。
   区间内的代码由 engine.js 逐字搬出；REG 走访问器（engine 继续持有这一枚可变状态），
   这批「这一轮用什么参数」的选择值归模块自己，Panel 经 extraCode 里那几对读写。
   其余 E 名单在建包这一刻都已就绪；document / window 用参数名遮蔽全局。 */


export function createEstimate(E, document, window) {
  'use strict';
  const {
    $,
    regOf,
    addRefImage,
    allShots,
    curShot,
    ensureChainModel,
    loadCredits,
    newShot,
    provOf,
    renderEditor,
    renderSoft,
    resolvedModel,
    scheduleSave,
    setShotDur,
    setStatus,
    shotAdvCtx,
    shotAdvExtras,
    shotInputCaps,
    shotKeyframes,
  } = E;

/* ---------- 费用预估：统一按 REGISTRY 的 pricing 声明估价（新 API 只需在 proxy.js 声明 pricing）---------- */
const QUALITY_ZH = AiGen.QUALITY_ZH;   // 画质档位中文名只有 gen-forms.js 的 AiGen 那一份
let kfQ = 'standard';   // 时间切片画质选择（编辑器会反复重渲染，存在变量里不丢）
/* 画面生成（时间切片）的高参：画质 / 画幅 / 尺寸 / 格式。
   值存模块变量（右栏每次重渲染都重建这一块），并整份存进 localStorage ——
    reload 之后又回默认档，用户每次都得重挑一遍。
   `kfAr = ''` 是「跟随这一镜的画幅」（原来的行为：关键帧直接用 sh.ar），
   所以这一档默认不变，只是**给了一个出口**：生图型号声明的画幅与视频那一条对得上时自己挑。 */
let kfAr = '', kfSize = '', kfFormat = '';
/* 「AdvParams 那四档之外」的三排（型号布尔 / 提交体顶层开关 / 提交体顶层非布尔字段）：
   判据、画法、读回都在 gen-forms.js 的 AdvExtras，与视频那一面、与工作台都是同一份。
   这里只记账：`topBools` / `shape` 与四档一起落盘（切镜头、刷新都不该重挑一遍）。 */
let kfTopBools = {}, kfShape = {};
/* 型号布尔那一排的「用户动过没有」账（`bool_<k>` = '1'/'0'）：公共层的 `html.bools` 靠它区分
   「按声明默认」与「保住用户挑的那个」。不落盘 —— 它记的是这一轮的界面状态，
   而声明默认值本身可能随型号变，跨刷新留着反而会把旧型号的意图压到新型号上。 */
let kfBoolAv = {};
/* 「拆成几张 / 按什么维度拆」那一排选项（公共层 SplitPlan 的 dir 那一族）：
   值必须存模块变量 —— 右栏每 3 秒整片重画一次，DOM 里的那一次选择活不过下一次重画。
   `kfSplitOpen` 是纯界面状态（面板开没开），只当会话变量：刷新后回到收起，
   落盘的话下一次开机那一排会自己张开，而用户没理由期待它张开。 */
let kfSplitCount = '', kfSplitDim = '', kfSplitCustom = '', kfSplitOpen = false;
/* 补全交给公共层（「自定义…」那一档取框里的字这条规则只有一份）；DOM 不在这条路上，
   所以重画与规划读到的是同一份选择。 */
function kfSplitSel() {
  return window.SplitPlan.selOf('dir', { count: kfSplitCount, dimKey: kfSplitDim, custom: kfSplitCustom });
}
function kfSplitSet(v) {
  const s = v || {};
  kfSplitCount = String(s.count || '');
  kfSplitDim = String(s.dimKey || '');
  kfSplitCustom = String(s.custom || '');
  kfParamsSave();
}
/* 两块面板的折叠状态不在这里各存一份模块变量：模板与 AdvParams.fold 都直接读那一个键
   （AdvParams.closed），存成变量的那份迟早和点出来的那一份对不上。 */
/* 读坏 / 没有都当没有：LS.json 把抛错与坏 JSON 统一变成默认值，装配期因此不会被一枚脏键掀掉。 */
const kfSaved = window.LS.json('sk_kf_params', null);
if (kfSaved && typeof kfSaved === 'object') {
  if (kfSaved.q !== undefined) kfQ = String(kfSaved.q || '');
  if (kfSaved.ar !== undefined) kfAr = String(kfSaved.ar || '');
  if (kfSaved.size !== undefined) kfSize = String(kfSaved.size || '');
  if (kfSaved.fmt !== undefined) kfFormat = String(kfSaved.fmt || '');
  if (kfSaved.tb && typeof kfSaved.tb === 'object') kfTopBools = kfSaved.tb;
  if (kfSaved.sf && typeof kfSaved.sf === 'object') kfShape = kfSaved.sf;
  if (kfSaved.sc !== undefined) kfSplitCount = String(kfSaved.sc || '');
  if (kfSaved.sd !== undefined) kfSplitDim = String(kfSaved.sd || '');
  if (kfSaved.sx !== undefined) kfSplitCustom = String(kfSaved.sx || '');
}
/* 高级参数与拆分选项一次落盘（一个键）：分四个键就是四次「这算设置项还是算界面状态」的争论，
   而且换一台机器只带走一半。 */
function kfParamsSave() {
  window.LS.setJson('sk_kf_params', {
    q: kfQ, ar: kfAr, size: kfSize, fmt: kfFormat, tb: kfTopBools, sf: kfShape,
    sc: kfSplitCount, sd: kfSplitDim, sx: kfSplitCustom,
  });
}
let kfModelId = window.LS.get('sk_kf_model') || '';   // 生成画面用的图片模型（可切换；禁存模式下退回空，再用第一个可用模型）
let kfRun = false;      // 关键帧批量生成是否进行中（期间删除占位只做标记）
/* 当前选中的图片模型（找不到就回退到第一个可用模型） */
function kfModelOf() {
  const groups = imgTextModels();
  for (const g of groups) {
    const m = (g.models || []).find(x => x.id === kfModelId);
    if (m) return { prov: g, model: m };
  }
  const g0 = groups[0];
  return g0 ? { prov: g0, model: g0.models[0] } : { prov: null, model: null };
}
/* ---------- 画面生成的「三排声明驱动控件」（与视频那一面、与工作台共用 AdvExtras） ----------
   注意型号是**生图型号**：这一路的 caps 按「这一批要带几张参考图」现算，
   不能借视频型号那一份（两家在同一平台上常常给不同的行）。 */
function kfAdvCtx(sh) {
  const m = kfModelOf().model || {};
  const caps = (window.Capabilities && Capabilities.shapeState && m.id)
    ? Capabilities.shapeState(m, null,
      ((sh && sh.refImages && sh.refImages.length) || shotKeyframes(sh).length) ? ['reference_image'] : [], undefined)
    : null;
  return { mode: '', intent: '', caps: caps };
}
/* 画那三排：整块随编辑器重绘，所以不需要工作台那套指纹守卫。
   `forceDef` = 换了生图型号那一次，型号布尔按**新声明**的默认值重画。 */
function paintKfAdv(sh, forceDef) {
  const pick = kfModelOf();
  const ctx = kfAdvCtx(sh);
  const boolBox = $('kfBoolRows');
  if (boolBox) {
    const b = window.AdvExtras.html.bools(pick.model || {}, { av: kfBoolAv, forceDef: !!forceDef });
    boolBox.innerHTML = b.html;
    boolBox.hidden = !b.count;
  }
  const tbBox = $('kfTopBools');
  if (tbBox) {
    const decl = window.AdvExtras.topBoolDecls(pick.prov);
    window.AdvExtras.prune(kfTopBools, decl);
    const h = window.AdvExtras.html.topBools(pick.prov, pick.model, ctx, kfTopBools);
    tbBox.innerHTML = h.html;
    tbBox.hidden = !decl.length;
    if (window.fillIcons) fillIcons(tbBox);
  }
  const sfBox = $('kfShapeFields');
  if (sfBox) {
    const decl = window.AdvExtras.shapeFieldDecls(pick.prov);
    window.AdvExtras.prune(kfShape, decl);
    const h = window.AdvExtras.html.shapeFields(pick.prov, ctx.caps, ctx, kfShape);
    sfBox.innerHTML = h.html;
    sfBox.hidden = !decl.length;
    if (window.Dropdowns && sfBox.querySelector('select')) Dropdowns.build(sfBox);
  }
  bindKfAdv(sh);
}
/* 三块的接线：编辑器整块重建，旧节点上的监听跟着没了，不会越攒越多。
   磁贴那一路重画整块编辑器（摘要、估价都跟着它，重画整块最不容易漏更新）；
   自由输入那一路（随机种子）逐字只落值，不重算报价 —— 打一半就发一次询价没意义。 */
function bindKfAdv(sh) {
  const tbBox = $('kfTopBools');
  if (tbBox) {
    tbBox.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('[data-tb]');
      if (!btn) return;
      const f = btn.dataset.tb;
      const decl = window.AdvExtras.topBoolDecls(kfModelOf().prov).find(x => x[0] === f);
      /* 没点过的起点是**这一档的默认值**（`def` 可以是随形状变的 {when,then,else}），不是「非真即为开」。 */
      const s = window.AdvExtras.topBoolStateOf(decl && decl[1], kfAdvCtx(sh));
      kfTopBools[f] = kfTopBools[f] === undefined ? !s.def : !kfTopBools[f];
      renderEditor(); kfParamsSave();
    });
  }
  ['kfBoolRows', 'kfShapeFields'].forEach(id => {
    const box = $(id);
    if (!box) return;
    box.addEventListener('change', e => {
      const ds = e.target && e.target.dataset;
      if (ds && ds.sf) kfShape[ds.sf] = e.target.value;
      /* 型号布尔那一排不往模块变量里另存一份值：`boolsFromDom` 读控件的同时把
         「用户动过这一项」记进 `kfBoolAv`，重画时公共画法照这本账保住他挑的那一个。 */
      else if (ds && ds.bool) window.AdvExtras.boolsFromDom(box, kfBoolAv);
      else return;
      const sum = $('kfAdvSum');
      if (sum) sum.textContent = kfAdvSumText(sh);   // 折叠行要跟着这一排变，否则看不出勾了什么
      refreshKfEst(); kfParamsSave();
    });
    box.addEventListener('input', e => {
      const sf = e.target && e.target.dataset ? e.target.dataset.sf : '';
      if (!sf) return;
      kfShape[sf] = e.target.value;
      kfParamsSave();
    });
  });
}
/* 读回提交体与报价体要用的那一批（root 就是画面高级设置那一格，控件是活的） */
function kfAdvExtras(sh) {
  const ctx = kfAdvCtx(sh);
  return window.AdvExtras.read({
    root: $('kfAdvBody'), prov: kfModelOf().prov, ctx: ctx, caps: ctx.caps,
    topBoolState: kfTopBools, shapeState: kfShape,
    bools: window.AdvExtras.boolsFromDom($('kfBoolRows'), kfBoolAv),
  });
}
/* 这三排在这一路里到底有没有东西（决定「画面高级设置」整块出不出现）：
   四档一个都没声明、又不收参考图、也没有这三排时，摆一个空盒子写着「高级设置」比没有更让人以为有东西可调。
   计数只用公共层的 `AdvExtras.visibleCount`（被形状藏掉的那一项不占数）—— 页面自己数一遍
   「声明了几项」会把「这一档这一型压根不画」的那几颗也算成有东西，空盒子就是这么来的。 */
function kfExtrasVisible(sh) {
  const pick = kfModelOf();
  return window.AdvExtras ? AdvExtras.visibleCount(pick.prov, pick.model, kfAdvCtx(sh)) : 0;
}
/* 折叠行摘要 = 四档那一句 + 三排里真进提交体的那几项（与视频那一面的 advSumText 同一个形状）。
   ⚠ 只能在 paintKfAdv 之后调：`kfAdvExtras` 读的是活控件。 */
function kfAdvSumText(sh) {
  return [kfImgParams(sh).summary, window.AdvExtras ? kfAdvExtras(sh).summary : ''].filter(Boolean).join(' · ');
}
function imgProviders() { return Api.pickable((regOf()?.providers || []).filter(p => p.kind === 'image')); }
/* 只列出能做文生图的图片模型（生成分镜画面必须支持 text_to_image） */
function imgTextModels() {
  return imgProviders()
    .map(g => Object.assign({}, g, { models: (g.models || []).filter(m => (m.modes || []).includes('text_to_image')) }))
    .filter(g => g.models.length);
}
/* 通用估价：返回 { ok:true, text, detail } 或 { ok:false, reason }
   p: { quality?, count?, duration?, res?, tier?, ar? } */
/* 费用预估统一走公共实现（assetlib.js 的 AssetLib.estimateCost）：
   以前导演台和视频台各写一份近乎逐行的重复代码，改一处容易漏另一处。
   定价表的实时取价也在公共层（60 秒 TTL）；页面**不要**再自己传一份进程内缓存 ——
   以前那份 priceCache 没有 TTL，页面开着多久就是多久的旧价，平台调价要刷新页面才看得到。 */
async function estimateCost(prov, model, p) {
  return AssetLib.estimateCost(prov, model, p || {}, { qualityLabel: QUALITY_ZH });
}
/* 视频生成估价：显示在「生成这一镜」按钮旁，失败只提示、不影响生成 */
/* 一次估价要发出去的参数**只在这里拼一份**（档位、输入模式、顶层开关、形状字段）。
   右栏那一格与审查弹窗的整批估价都问 `shotQuote` —— 两处各拼一遍，弹窗报的价
   和这一镜真生成时的价迟早对不上（那正是「界面说三块五、扣的是五块」这一类）。 */
function shotQuoteArgs(sh, over) {
  /* 报价前先把接续型号落到这一镜上：按「不收首帧的旧型号」问出来的价，
     与提交时真用的型号对不上（差价要到扣费那一刻才暴露）。 */
  ensureChainModel(sh);
  const rm = resolvedModel(sh) || {};
  const prov = provOf(rm.provider);
  /* 时长就按这一镜现在记的值估：模型没声明时长时上面那段归一化不会去填它，
     这里再 `|| 5` 等于凭空造一个平台没给过的秒数（报价跟着错）。 */
  /* 顶层那两排也进报价：注册表在 `pricing.body` 里写了映射才带得过去，
     而「这一档给不给」与提交体问的是同一个判据（AdvExtras.read → Capabilities）。
     不递就等于「界面上勾了 Turbo、报价还是那一档的钱」—— 差价要到生成那一刻才暴露。 */
  const ex = shotAdvExtras(sh);
  const ctx = shotAdvCtx(sh);
  const body = Object.assign({
    count: sh.draw || 1, duration: sh.duration, res: sh.res, tier: sh.tier, ar: sh.ar, size: sh.size,
    /* 这一镜选的输入模式进报价：`creation_intent` 走 `pricing.body` 的映射（换人档的价与时长算法
       都不一样），`mode` 只当声明里 hide / def 的上下文。不递就等于「界面上切了换人档，报价还是
       普通生成那一档的钱」—— 差价要到生成那一刻才暴露。 */
    creation_intent: ctx.intent, mode: ctx.mode,
    topBools: ex.topBools, caps: ctx.caps,
    /* `over` 只给整批估价用（`count` 那一档）：这一屏没有「这一镜」，问的是「这几条同样的规格」。 */
  }, over || {}, ex.shapeFields);
  return { rm, prov, body };
}
async function shotQuote(sh, over) {
  const { rm, prov, body } = shotQuoteArgs(sh, over);
  const r = await estimateCost(prov, rm, body);
  return { r, rm, prov };
}
async function getPriceEstimate(sh) {
  if (!sh) return '';
  const { rm, prov, body } = shotQuoteArgs(sh);
  /* 参数指纹：右栏一帧里 `renderAll` 会问三次估价，切镜头/改字也会重画 ——
     参数没动就交回上一句，不再打一趟平台。指纹取「真的发出去的那一份体」，
     与 `shotQuote` 共用 `shotQuoteArgs`，不在这里另拼一遍。 */
  const key = String((prov && prov.id) || rm.provider || '') + '|' + JSON.stringify([rm.id || rm.name || '', body]);
  if (estCache.key === key) return estCache.txt;
  const r = await estimateCost(prov, rm, body);
  const name = prov?.name || rm.provider || '未知API';
  /* `skip` 与「报价失败了」是两件事（与工作台同一句区分）：这一档根本没有询价这条路
     （注册表声明的 `pricing.noQuote` —— VGENV 的动作换人在报价时要求带那段参考视频的字节，
     而报价是纯参数查询，拿不到）。写成「报价不可用（…INVALID）」会让人以为接口坏了，
     而切到「视频换人」之后这一条**每次都会**出现。 */
  const txt = r.skip ? name + ' · ' + (r.reason || '这一档平台不提供询价') + '，以平台结算为准'
    : r.ok ? name + ' · ' + r.text : name + ' · 报价不可用（' + r.reason + '）';
  estCache = { key, txt };
  return txt;
}
let estSeq = 0;
let estShown = '';          // 屏上此刻摆着的那句完整文案
let estCache = { key: '', txt: '' };
async function refreshEst() {
  const sh = curShot();
  const el = $('estTxt');
  if (!el || !sh) return;
  const my = ++estSeq;
  /* 屏上已经摆着同一个答案，就**不要先写「估价中…」**。
     refreshEst 挂在「每次重渲染」上（输入、选中、切镜头都会重渲染），不动参数也会被调用 ——
     先写加载态再写回同一个数，等于让那一行闪一下（值其实没变，用户看着像「报价老在跳」）。
     拿不到答案（第一次、或者参数变了）才显示加载态。 */
  if (!estShown || el.textContent !== estShown) el.textContent = '估价中…';
  const txt = await getPriceEstimate(sh);
  if (my !== estSeq) return;              // 连点镜头时旧报价别把新的盖回去
  estShown = txt;
  if (el.textContent !== txt) el.textContent = txt;
}
/* 审查弹窗（mode:'board'）顶部那句「估价」：整批问一次，算价仍然只有公共层那一份。
   三条口径：
   ① 按**秒数分档**合并（一份方案里几十镜常常只有三五档），每档只问一次 `estimateCost`、
      把「这一档有几条」当 `count` 递过去 —— 逐镜问就是几十趟平台接口；
   ② 规格取「这一台机器不挑型号时会落到哪一型」那一份默认（`newShot()` + `shotQuote`，
      与右栏那一格同一套装配）。整批里不同镜头真生成时会分到不同平台，所以这句说的是量级、
      不是账单，界面上那句「约」与平台结算那一句话一样都不能省；
   ③ 问不到、档数超过 `EST_BAND_MAX`（那要几十趟接口）、或这一型只报「最低消费」而不给可相加的
      金额（`amount` 缺失）—— 一律交回空串，由公共层显示「报价不可用」。
      **绝不用其中一档的单价乘条数**冒充整批，也绝不因为估不到就不让拆。 */
const EST_BAND_MAX = 8;
async function boardEstimate(list) {
  const rows = (list || []).filter(x => Number(x.dur) > 0);
  if (!rows.length) return '';
  const bands = new Map();
  rows.forEach(x => { const k = Math.round(Number(x.dur)); bands.set(k, (bands.get(k) || 0) + 1); });
  if (bands.size > EST_BAND_MAX) return '';
  const tpl = newShot();
  let sum = 0, nm = '', cur = null;
  for (const [sec, n] of bands) {
    setShotDur(tpl, sec);
    const q = await shotQuote(tpl, { count: n });
    if (!q.r || !q.r.ok || typeof q.r.amount !== 'number') return '';
    sum += q.r.amount;
    nm = nm || (q.prov && q.prov.name) || (q.rm && q.rm.provider) || '';
    if (cur == null) cur = (q.prov && q.prov.pricing && q.prov.pricing.currency) || '';
  }
  /* 金额取整到分：与公共层 `per_second_table` 那一档 `Math.round(x*100)/100` 同一个尺子，
     这里不另发明一种小数位。
     ⚠ 这一行问价用的是「默认型号 + 默认档」（审查弹窗里的镜头还没落型号）：
       与真正落盘时各自解析到的型号未必是同一家 —— 所以文案里要写明「按默认档估算」，
       不冒充精确报价。 */
  return nm + ' · 约 ' + (Math.round(sum * 100) / 100) + (cur ? ' ' + cur : '')
    + '（按默认型号档估算；各镜落盘时的型号可能不同）';
}

/* ---------- 时间切片参考图（画面素材）---------- */
function assetToDataURL(assetId) {
  /* 取字节统一走 Net.blob（带超时、先判 HTTP 状态），不再裸 fetch */
  return Net.blob(Api.assetDl(assetId), { timeout: 60000 }).then(b => AssetTransfer.toDataURL(b));
}
/* 画面生成（时间切片）那几档参数的**判据在 `gen-forms.js` 的 `AdvParams.plan`**（与工作台图像栏同一份）：
   选项来自图片模型自己的声明、回落顺序、显示名、摘要、提交体要带哪几项，全在那一处。
   这里只留三件导演台自己的事：① 值存在模块变量里（整块随编辑器重绘，控件不是常驻 DOM），
   ② 「跟随这一镜」这个借用值从 `sh.ar` 来，③ 归档日志的写法。 */
function kfImgPlan(sh) {
  const m = kfModelOf().model || {};
  const ar = sh && sh.ar ? String(sh.ar) : '';
  return AdvParams.plan(m, {
    kinds: ['quality', 'aspect_ratio', 'size', 'output_format'],
    ids: { quality: 'kfQuality', aspect_ratio: 'kfAr', size: 'kfSize', output_format: 'kfFormat' },
    cur: { quality: kfQ, aspect_ratio: kfAr, size: kfSize, output_format: kfFormat },
    /* 「跟随这一镜」只在**这个生图型号也收这一比例**时才成立：sh.ar 是视频那条的取值，
       生图那一家没声明过它就是「发一个平台不认的字段值」（借 sh.ar 正是本轮修掉的那件事）。 */
    follow: ar ? { aspect_ratio: { value: ar, note: '随这一镜' } } : null,
    units: { count: '张' },
  });
}
/* 算一遍并把回落后的值写回模块变量（下一次重绘与提交都读这一份） */
function kfImgParams(sh) {
  const pl = kfImgPlan(sh);
  kfQ = pl.kinds.quality.value; kfAr = pl.kinds.aspect_ratio.value;
  kfSize = pl.kinds.size.value; kfFormat = pl.kinds.output_format.value;
  return pl;
}
/* 折叠状态下摘要那一行就是 plan 拼好的那一句（`kp.summary`），与下拉、提交体同源
   （以前这里自己按四档各判一次「要不要写进摘要」，改一处就和面板各说各的）。 */
/* 「参考图」槽位在这个**生图型号**上的上限（视频型号那份 maxRef 是另一码事，两家数字不同） */
function kfRefMax(model) {
  try {
    const r = (window.Capabilities && Capabilities.rule) ? Capabilities.rule(model, 'reference_image') : null;
    return r && Number(r.max) > 0 ? Number(r.max) : 0;
  } catch (e) { return 0; }
}
/* 画面生成发出去的那一份参数：`payload` 就是 plan 算好的「声明了才带」那几项
   （与工作台图像栏 `createImageOnce` 同一个来源，不再是两处各判一遍）。
   两处入口（整批 / 单张重试）共用这一份，否则改了批量那一路、重试那一条发的还是旧的，
   而界面上看着完全一样。归档日志（meta）也照同一份写 —— 说的和提交的是同一件事。 */
function kfGenOpts(sh, extra) {
  extra = extra || {};
  const pl = kfImgPlan(sh);
  const p = Object.assign({}, pl.payload, { inputEntries: extra.inputEntries || null });
  const k = pl.kinds;
  /* 三排「四档之外」的读回：params 交给 Api.createBody 按声明分顶层 / 嵌套，
     shape 只当判据上下文（mode 永不进提交体）。越界的值当场拦 —— 让平台回一句 400
     等于把已经排好的那一轮任务白费一次。 */
  const ex = kfAdvExtras(sh);
  if (ex.bad.length) throw new Error(ex.bad.join('、'));
  p.params = ex.params;
  /* 任务号当场落到关键帧上（关机 / 刷新后由 Gen.resumeKeyframes 认回来，不重发、不重复扣费） */
  if (extra.kf) p.onTask = t => { extra.kf.taskId = t.id; extra.kf.provider = (t.prov && t.prov.id) || ''; scheduleSave(); };
  p.shape = { mode: '', caps: kfAdvCtx(sh).caps };
  const meta = { 镜头: sh.name || '' };
  if (p.quality) meta.画质 = AdvParams.label('quality', p.quality, pl.model);
  meta.画幅 = p.ar || '平台默认';
  if (p.size) meta.尺寸 = p.size;
  if (p.format) meta.格式 = AdvParams.label('output_format', p.format, pl.model);
  if (ex.summary) meta.顶层参数 = ex.summary;
  if (p.inputEntries) meta.参考图 = p.inputEntries.length + ' 张';
  if (extra.at != null) meta.秒点 = extra.at + 's';
  p.log = { type: '导演台-关键帧', meta: meta };
  /* 摘要与提交体同口径：这一句里的画幅就是 payload.ar（跟随不上时 payload 里没有它） */
  p.summary = pl.summary;
  p.kinds = k;
  return p;
}
/* 图片模型下拉：跨平台列出所有支持文生图的模型 */
function kfModelOptions() {
  const cur = kfModelOf().model;
  return imgTextModels().map(g =>
    `<optgroup label="${g.displayName || g.name}">` + (g.models || []).map(m =>
      `<option value="${esc(m.id)}" title="${esc(m.name || '')}" ${cur && m.id === cur.id ? 'selected' : ''}>${esc(m.id)}</option>`).join('') + '</optgroup>').join('');
}
/* 画面这一路的总价句（面板那一行与审阅弹窗共用）；没型号 / 报不出价返回空串 */
async function kfEstText(sh, n) {
  try {
    const ex = kfAdvExtras(sh), ctx = kfAdvCtx(sh);
    const r = await estimateCost(kfModelOf().prov, kfModelOf().model, Object.assign(
      { quality: kfQ, count: n, ar: kfAr || undefined, size: kfSize || undefined, format: kfFormat || undefined, topBools: ex.topBools, caps: ctx.caps }, ex.shapeFields));
    return (r && r.ok && r.text) ? String(r.text) : '';
  } catch { return ''; }
}
/* 时间切片估价：张数按「挑了哪一档」走，价格走统一 estimateCost */
async function refreshKfEst() {
  const el = $('kfEst');
  const sh = curShot();
  if (!el || !sh) return;
  const sel = kfSplitSel();
  const n = +(sel.count || 0) || (sh.keyframes || []).length || 4;
  const est = await kfEstText(sh, n);
  el.textContent = (!sel.count && !(sh.keyframes || []).length ? '张数交给 AI · 按 ' : '按 ')
    + (est ? `${n} 张 ${est}` : `${n} 张（报价不可用）`);
}
/* ============ 按描述生成这一镜的画面 ============
   ① 文字 AI 规划张数与时间点 / 提示词 ② 右栏立刻建占位图 ③ 逐张生成、完成原位替换并加入参考图 */
const storySysOf = () => TextAI.prompt('story');

/* 从文字 AI 的回复里抠出 frames（兼容代码块 / 纯数组 / 单个对象） */
function parseFrames(txt, dur) {
  if (!txt) return [];
  let raw = String(txt).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) raw = fence[1].trim();
  let obj = null;
  try { obj = JSON.parse(raw); } catch {
    const arr = /\[\s*\{[\s\S]*\}\s*\]/.exec(raw);
    const ob = /\{[\s\S]*\}/.exec(raw);
    try { obj = arr ? JSON.parse(arr[0]) : (ob ? JSON.parse(ob[0]) : null); } catch { obj = null; }
  }
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : (obj.frames || obj.shots || obj.list || []);
  if (!Array.isArray(list)) return [];
  const out = [];
  list.slice(0, 8).forEach((f, i) => {
    const pr = (f && (f.prompt || f.desc || f.text)) ? String(f.prompt || f.desc || f.text).trim() : '';
    if (!pr) return;
    let t = Number(f.t ?? f.time ?? f.second ?? i * (dur / Math.max(1, list.length - 1)));
    if (!isFinite(t)) t = i;
    t = Math.max(0, Math.min(dur, Math.round(t * 10) / 10));
    out.push({ t, prompt: pr, desc: f.desc ? String(f.desc) : '' });
  });
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* 「按描述生成这一镜的画面」里**所有**问文字 AI 的地方都从这里走。
   以前是 `TextAI.chat`（一次性）：规划这一步动辄十几秒，界面只有一行「文字 AI 正在规划画面切片…」，
   看不出它在想、卡住、还是连接早就断了 —— 三种状态长得一模一样。
   现在走公共 `AiStream.text`：边收边显示，最后一块字到了才收起面板；返回值与 chat 完全一致，
   所以 `parseFrames` 那一段一个字都不用改。 */
async function callTextAI(sys, user) {
  // 供应方与型号都用「设置 → 文字 AI 接口与模型」里当前选中的那一家（AiStream 内部也走 TextAI）
  return await AiStream.text(regOf(), sys, user, {
    host: document.getElementById('kfPlanInline'),
    title: '文字 AI 正在规划画面切片…',
  });
}

/* ① 规划：张数与拆分维度由那一排选项给出（没选就交给文字 AI），每张的时间点与提示词由它定 */
async function planKeyframes(sh, dur) {
  const sys = storySysOf();
  const user = `镜头描述：${sh.prompt}
镜头时长：${dur} 秒` + window.SplitPlan.userLines(kfSplitSel()) + '\n只返回 JSON。';
  const txt = await callTextAI(sys, user);
  const frames = parseFrames(txt, dur);
  if (frames.length) return frames;
  // 兜底：文字 AI 没给出结构化结果时，按 2.5 秒切片逐帧润色（保持旧行为可用）
  const times = [];
  for (let t = 0; t < dur; t += 2.5) times.push(Math.round(t * 10) / 10);
  if (times[times.length - 1] !== dur) times.push(dur);
  const out = [];
  for (const t of times) {
    const p = await callTextAI(sys, `镜头描述：${sh.prompt}\n这一帧位于第 ${t} 秒，请写出这一帧的文生图提示词，直接返回提示词本身。`);
    if (p) out.push({ t, prompt: p.replace(/^["'`]|["'`]$/g, '').slice(0, 600) });
  }
  return out;
}

/* ③ 单张图片生成：创建与轮询都收敛到 gen-forms.js 的 AiGen.image ——
   它按 Api.pollTask 走（声明了 pollVia:'list' 的平台不会被轮到一个 404 的详情端点），
   也不会把认不出的中间状态当成「生成失败」。这里只取产物号。 */
async function genOneImage(imgProv, imgModel, prompt, o) {
  const m = (imgModel && imgModel.id) ? imgModel : (imgProv.models || [])[0];
  if (!m) throw new Error('该平台没有可用的图片型号');
  /* 参数整包交下去（画质 / 画幅 / 尺寸 / 格式 / 参考图条目）：一个函数六个位置参数，
     调用点想漏哪个都看不出来 —— 高参加进来之后更容易漏的是这一类。 */
  /* mustSave：导演台生成的关键帧与候选同一档 —— 无论「产物自动存本机」开关怎么设都要落盘
     （那一枚开关只管历史补齐）。见 web/domain/local.js 的 wantSave / offer。 */
  const e = await AiGen.image(Object.assign({}, o, { prov: imgProv, model: m, prompt: prompt, mustSave: true }));
  if (!e.assetId) throw new Error('这个平台产出的是外链而不是资产号，关键帧流程用不了');
  return e.assetId;
}

/* 画面生成要带的参考图：把这一镜挑好的 sh.refImages 转成**生图平台**认的输入条目。
   上限现读图片模型的 reference_image 声明 —— 视频模型那份 maxRef 是另一码事，
   两家数字不一样时多出来的几张不能发，也不能假装发了（「选好了」配一个空结果）。
   整批只转存一次（在生成循环外面调用）：循环里各转一遍，同一张图会往同一家平台传 N 遍。
   转不动的那一张照数据层的口径退回「只按文字画」，并把原因通过 note 说给用户听。 */
async function kfRefEntries(sh, note) {
  const pick = kfModelOf();
  if (!pick.prov) return null;
  const list = (sh.refImages || []).filter(Boolean);
  const max = kfRefMax(pick.model);
  if (!max) { if (list.length) note('这个生图型号没有「参考图」槽位，画面只按文字生成（这一镜那 ' + list.length + ' 张参考图没带上）'); return null; }
  const use = list.slice(0, max);
  if (list.length > max) note('参考图只带前 ' + max + ' 张（这个生图型号一次最多收 ' + max + ' 张，另有 ' + (list.length - max) + ' 张没带）');
  const out = [], bad = [];
  for (const src of use) {
    try {
      const en = await AssetTransfer.entryFor(pick.prov, 'reference_image', src, { reg: regOf(), name: '导演台-画面参考图' });
      if (en) out.push(en); else bad.push('平台没有返回可用的条目');
    } catch (e) { bad.push(errText(e)); }
  }
  if (bad.length) note(bad.length + ' 张参考图没能转给生图平台（' + bad[0] + '），那几张不带了');
  return out.length ? out : null;
}

/* ④ 生成好的画面同时进入「参考图」（受模型能力与上限约束；与首尾帧互斥时不进） */
function addKeyframeToRefs(sh, assetId, kf, i) {
  const ic = shotInputCaps(sh);
  if (!ic.ref) return false;
  if (ic.blockedRoles.has('reference_image')) return false;   // 已选首尾帧 → 画面不能同时当参考图
  const src = Api.assetSrc(assetId);
  if ((sh.refImages || []).includes(src)) return false;
  if (sh.refImages.length >= ic.maxRef) return false;   // 上限就是模型声明的那个数，不猜一个 9
  // label 留空 → 素材 chips 显示 @参考图N（可被 refSyntax 正确转换）
  addRefImage(sh, src, null);
  return true;
}

async function generateKeyframes(sh) {
  /* 入口锁必须在任何 await 之前：置锁晚一步，renderSoft 先把按钮重建回可点态，连点就是两轮并行扣费。 */
  if (kfRun) return;
  kfRun = true;
  if (!TextAI.prov(regOf())) { kfRun = false; setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(regOf()))) { kfRun = false; setStatus('<span class="err">请先在「设置」填文字 AI 密钥</span>'); return; }
  const pickImg = kfModelOf();
  const imgProv = pickImg.prov, imgModel = pickImg.model;
  if (!imgProv || !imgModel) { kfRun = false; setStatus('<span class="err">注册表里没有可用的图片型号</span>'); return; }
  /* 时长没有就现取声明：模型默认的 duration → 声明里最短那一档；都不给才用最旧的那个数（只用于画面切片，不进提交体） */
  const rmv = resolvedModel(sh);
  const kfDur = (Array.isArray(rmv?.options?.durations) ? rmv.options.durations : []).map(Number).filter(Number.isFinite);
  const dur = Number(sh.duration) || Number(rmv?.options?.defaults?.duration) || (kfDur.length ? Math.min(...kfDur) : 5);
  /* 选项面板在这一轮开始的那一刻收起：接下来露出来的应该是流式规划面板与占位图，
     「开始规划」那颗按钮压在它们上面只会挡视线。重画出来的两颗动作按钮都按 kfRun 现画忙态。 */
  kfSplitOpen = false;
  renderEditor();
  try {
    // ① 文字 AI 规划：决定几张 + 每张的切片提示词
    setStatus('文字 AI 正在规划画面切片…');
    const plan = await planKeyframes(sh, dur);
    if (!plan.length) throw new Error('文字 AI 没有给出可用的画面规划');

    // ①.5 先把规划结果给用户过一遍（可改文案 / 删掉不想生成的），确认后再出占位图并开始生成
    const kfEst = await kfEstText(sh, plan.length);
    const reviewed = await PromptReview.openList({
      title: '画面切片规划',
      sub: `第 ${allShots().indexOf(sh) + 1} 镜 · 时长 ${dur} 秒 · 共 ${plan.length} 张 · 画质 ${QUALITY_ZH[kfQ] || kfQ || '平台默认'}`
        + (kfEst ? ' · 预计 ' + kfEst : ''),
      items: plan.map((f, i) => ({ label: `画面 ${i + 1} · ${f.t}s`, text: f.prompt })),
      applyLabel: '采用并开始生成',
      hint: '可以逐条修改或删掉',
      retry: async () => (await planKeyframes(sh, dur)).map((f, i) => ({ label: `画面 ${i + 1} · ${f.t}s`, text: f.prompt })),
    });
    if (reviewed == null) { setStatus('已取消，未生成任何画面'); return; }
    const finalPlan = reviewed.map((it, i) => {
      const mt = /(\d+(?:\.\d+)?)s/.exec(it.label || '');
      const t = mt ? Number(mt[1]) : (plan[i]?.t ?? 0);
      return { t: Math.max(0, Math.min(dur, t)), prompt: it.text };
    });

    // ② 立刻建立占位图（先出现占位，再慢慢替换成真图）
    sh.keyframes = finalPlan.map((f, i) => ({
      t: f.t, desc: sh.keyframes?.[i]?.desc || f.desc || '', imgPrompt: f.prompt,
      status: 'queued', assetId: null, err: null, deleted: false,
    }));
    /* 报数的分母取**这一批计划了几张**：生成中途被删掉的那些会在收尾从 `sh.keyframes` 里过滤掉，
       用过滤后的长度当分母，会把「已经生成、随后被删」的那几张从总数里抹掉（分子还在）。 */
    const totalN = sh.keyframes.length;
    renderEditor(); scheduleSave();
    setStatus(`已确认 ${finalPlan.length} 张画面（${finalPlan.map(f => f.t + 's').join(' / ')}），开始生成…`);

    // ②.5 参考图先转存一次，整批复用同一份条目（循环里各转一遍 = 同一张图传 N 趟）
    const refNotes = [];
    const kfRefs = await kfRefEntries(sh, t => refNotes.push(t));
    if (refNotes.length) setStatus('<span class="err">' + esc(refNotes.join('；')) + '</span>');

    // ③ 逐张生成 → 替换占位 → 同时加入参考图（后台刷新走 renderSoft：正在右栏编辑时不打断输入）
    let okN = 0, refN = 0;
    for (let i = 0; i < sh.keyframes.length; i++) {
      const kf = sh.keyframes[i];
      if (!kf || kf.deleted) continue;   // 用户在生成过程中删掉的：跳过
      kf.status = 'generating'; renderSoft(['edit']);
      try {
        const prompt = kf.imgPrompt || (sh.prompt + '，第 ' + kf.t + ' 秒的关键画面');
        const assetId = await genOneImage(imgProv, imgModel, prompt, kfGenOpts(sh, { inputEntries: kfRefs, at: kf.t, kf }));
        kf.assetId = assetId;
        kf.status = assetId ? 'done' : 'failed';
        if (assetId) { okN++; if (addKeyframeToRefs(sh, assetId, kf, i)) refN++; }
      } catch (e2) { kf.status = 'failed'; kf.err = e2.message; }
      renderSoft(['edit']); scheduleSave();
    }
    sh.keyframes = (sh.keyframes || []).filter(k => !k.deleted);   // 移除生成中被删掉的
    renderSoft(['edit']); scheduleSave();
    loadCredits();
    setStatus(okN
      ? `<span class="ok">✓ 已生成 ${okN}/${totalN} 张画面${refN ? '，并加入参考图' : (shotInputCaps(sh).blockedRoles.has('reference_image') ? '（已选首尾帧，画面未加入参考图）' : '')}</span>`
        /* 参考图那一句要说到底：中途说过一次，收尾又被「已生成 N 张」盖掉的话，
           「有几张其实没带上」这件事就只在屏上一闪而过（失败原因要留在卡片上，不弹一次就算）。 */
        + (refNotes.length ? '<span class="err"> · ' + esc(refNotes.join('；')) + '</span>' : '')
      : '<span class="err">画面生成失败，请检查图片AI密钥或稍后重试</span>');
  } catch (e) {
    setStatus('<span class="err">生成失败：' + e.message + '</span>');
  } finally {
    kfRun = false;
    sh.keyframes = (sh.keyframes || []).filter(k => !k.deleted);
    renderEditor();
  }
}

  /* 右栏每 3 秒整片重画，这一批「这一轮用什么参数」的值归模块自己；
     Panel 只经下面这几对读写（与原先 engine 里那几枚访问器同一副形状）。 */
  function setKfQ(v) { kfQ = v; }
  function kfArOf() { return kfAr; }
  function setKfAr(v) { kfAr = v; }
  function kfSizeOf() { return kfSize; }
  function setKfSize(v) { kfSize = v; }
  function kfFormatOf() { return kfFormat; }
  function setKfFormat(v) { kfFormat = v; }
  function kfModelIdOf() { return kfModelId; }
  function setKfModelId(v) { kfModelId = v; }
  function kfRunOf() { return kfRun; }
  function kfSplitOpenOf() { return kfSplitOpen; }
  function setKfSplitOpen(v) { kfSplitOpen = !!v; }

  return {
    addKeyframeToRefs,
    assetToDataURL,
    boardEstimate,
    genOneImage,
    generateKeyframes,
    kfAdvSumText,
    kfArOf,
    setKfAr,
    kfExtrasVisible,
    kfFormatOf,
    setKfFormat,
    kfGenOpts,
    kfImgParams,
    kfModelIdOf,
    setKfModelId,
    kfModelOf,
    kfModelOptions,
    kfParamsSave,
    kfRefEntries,
    kfRefMax,
    kfRunOf,
    kfSizeOf,
    setKfSize,
    kfSplitOpenOf,
    kfSplitSel,
    kfSplitSet,
    setKfSplitOpen,
    paintKfAdv,
    refreshEst,
    refreshKfEst,
    setKfQ,
    shotQuote,
  };
}
