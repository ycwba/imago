/* 导演台Panel域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createPanel(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { speakerOf, lineTimeOf, lineRowHTML } from '../film.js';
import { num } from '../util.js';
import { createBoardPreview } from '../board-preview.js';

export function createPanel(E, document, window) {
  const {
    $,
    projOf,
    REGOf,
    BoardAssetsOf,
    allShots,
    curShot,
    beginEdit,
    filmOf,
    chainModelList,
    ensureChainModel,
    chainModelWhy,
    chainWaitWhy,
    resolveChainFrame,
    filmEdited,
    renderSoft,
    scheduleSave,
    scheduleSaveQuiet,
    assetStoreId,
    sameAssetSpace,
    loadCredits,
    generateCandidate,
    debounce,
    renderScenes,
    midEditTrimOf,
    curDraftCand,
    promptTextOf,
    renderMid,
    pendingLineOf,
    openPendingVoice,
    renderVoiceCol,
    applyRefSyntax,
    pickRefMedia,
    setPolishUI,
    renderPolishPanel,
    renderSplitPanel,
    polishPrompt,
    toDataURL,
    uploadImageDataUrl,
    openPickDlg,
    setKfQ,
    kfArOf,
    setKfAr,
    kfSizeOf,
    setKfSize,
    kfFormatOf,
    setKfFormat,
    kfParamsSave,
    kfModelIdOf,
    setKfModelId,
    kfRunOf,
    kfModelOf,
    paintKfAdv,
    kfExtrasVisible,
    kfAdvSumText,
    refreshEst,
    kfImgParams,
    kfRefMax,
    kfGenOpts,
    kfModelOptions,
    refreshKfEst,
    genOneImage,
    kfRefEntries,
    addKeyframeToRefs,
    generateKeyframes,
    renderAll,
    updateBanner,
    setStatus,
    GenOf,
    wsLoadedOf,
  } = E;

function shotModels(sh) {
  /* 按这一镜**已经用上的输入 role** 筛模型（不再按 mode 名匹配）：
     上游 /models 的 mode 名字各平台不一样（SparkCine 是 image_to_video / multimodal_reference，
     页面自己用的是 first_last_frame / reference_images），按名字过滤会让加了首尾帧之后
     支持它的模型反而从下拉里消失。role 是提交模板的通用语言，按它筛才是对的。 */
  const need = shotUsedRoles(sh);
  /* Api.pickable：设置页勾掉「暂时不用」的那一家不出现在这一段可选的视频平台里 */
  const provs = Api.pickable((REGOf()?.providers || []).filter(p => p.kind === 'video'));
  const groups = (window.Capabilities && Capabilities.modelsFor)
    ? Capabilities.modelsFor(provs, need)
    : provs.map(p => ({ p, models: (p.models || []).filter(m => (m.modes || []).length) }));
  return groups.map(g => ({
    id: g.p.id, name: g.p.name, displayName: g.p.displayName || g.p.name, keyId: g.p.keyId || g.p.id,
    models: g.models, options: g.models[0]?.options || {},
  }));
}

function resolvedModel(sh) {
  const groups = shotModels(sh);
  if (!sh) return groups[0] ? { ...groups[0].models[0], provider: groups[0].id, keyId: groups[0].keyId, options: groups[0].models[0].options || groups[0].options } : null;
  if (sh.model && sh.model !== 'auto') {
    for (const g of groups) { const m = g.models.find(m => m.id === sh.model); if (m) return { ...m, provider: g.id, keyId: g.keyId, options: m.options || g.options }; }
  }
  const g0 = groups[0]; if (!g0) return null;
  const m0 = g0.models[0];
  return { ...m0, provider: g0.id, keyId: g0.keyId, options: m0.options || g0.options };
}

/* 编辑器槽位名 → 模型声明的输入 role（互斥 / 提交都按 role 判断） */
const SLOT_ROLE = { first: 'first_frame', last: 'last_frame', ref: 'reference_image', refVideo: 'reference_video', refAudio: 'reference_audio' };
/* 输入素材的中文名只在公共层点一次名（`Capabilities.ROLE_ZH`），与生成工作台同一份：
   这一页原来抄的是一份短名表（首帧 / 尾帧），而模式名那句现拼读的是长名（首帧图 / 尾帧图），
   同一个 role 在两个页面上叫两个名字；清单和数值都是数据，抄一遍就会各自漂。 */
const ROLE_ZH = (window.Capabilities && Capabilities.ROLE_ZH) || {};
/* 模式名（「智能参考」「视频换人」）也只有一份（`Capabilities.comboLabel`）：
   归一化那边给的是整档语义名，页面按 role 现拼根本读不到它。 */
const comboLabel = cb => (window.Capabilities && Capabilities.comboLabel) ? Capabilities.comboLabel(cb) : '';
/* 「这一档收哪些」（说明行）与那一排芯片的画法同样只有一份（`comboScopeNote` / `comboChipsHTML`）：
   这一页与生成工作台画的是同一排，措辞与 min/max 的写法抄两遍迟早和声明漂开。
   指针名字故意避开公共层那两个（dup-guard 判据把页面里同名的 `function` 定义当第二份实现）。 */
const comboNote = cb => (window.Capabilities && Capabilities.comboScopeNote) ? Capabilities.comboScopeNote(cb) : '';
const comboChips = (list, id) => (window.Capabilities && Capabilities.comboChipsHTML) ? Capabilities.comboChipsHTML(list, id) : '';
/* 参考视频槽的缩略图地址：
   · 资产在 SparkCine 资产库里 → 走 /asset/<id>?v=2（代理每次都重新解析签名地址，长期有效）
   · 否则用条目里存的 src（资产库 / 收藏导入时留下的地址）—— 签名过期的地址取不回来时占位层会一直盖着，
     但名称仍然显示，不影响识别这道素材；本地直传（没有 src）就没缩略图，只显示文件名。 */
function refVideoThumbSrc(ref) {
  if (!ref) return '';
  /* 本地上传的视频传进别家平台之后，本机再也没有可用地址：
     那种条目在选完时就顺手存了一帧小图（ref.thumb，见 pickRefMedia 的视频分支），优先用它。 */
  if (ref.thumb) return ref.thumb;
  const id = ref.asset_id || (String(ref.src || '').match(/\/asset\/([A-Za-z0-9_-]+)/) || [])[1];
  if (id && sameAssetSpace(ref.provider, assetStoreId())) return Api.assetSrc(id);
  return ref.src ? Api.mediaSrc(ref.src) : '';
}
/* 这一镜已经用到的输入 role（keyframes 与参考图同属 reference_image：提交时二选一）。
   接上一镜尾帧（`linkPrev === 'tail'`）且用户没显式放首帧时，提交一定会带一张隐式首帧 ——
   这里要算进去：型号筛选按同一份 role 走，漏了就会挑出「不收首帧」的型号，
   提交时才在 `shotInputEntries` 里报错，而界面上从头到尾看不出为什么。 */
function shotUsedRoles(sh) {
  if (!sh) return [];
  const used = [];
  if (sh.firstFrame || sh.linkPrev === 'tail') used.push('first_frame');
  if (sh.lastFrame) used.push('last_frame');
  if ((sh.refImages || []).length || (sh.keyframes || []).some(k => k.assetId)) used.push('reference_image');
  if (sh.refVideo) used.push('reference_video');
  if (sh.refAudio) used.push('reference_audio');
  return used;
}

/* ---- 「输入模式」= 这一镜这一次请求的形状 ----
   判据全在公共层（`Capabilities.combos` / `comboRoles` / `comboGaps` / `fallbackCombo`），
   与生成工作台同一套 —— 导演台原来整套模式判据都没接：同一个平台在工作台能选「视频换人」，
   在这一镜上连入口都没有，而手上放了 9 张参考图去提交换人档时页面一片绿灯、平台回一句 422。
   没有这种声明的家 `combos()` 是空数组：那一排芯片一个都不画，槽位回到原来的「互斥就置灰」，
   行为与加它之前逐字相同。 */
function shotCombos(sh) {
  const rm = resolvedModel(sh) || {};
  return (window.Capabilities && Capabilities.combos) ? Capabilities.combos(rm) : [];
}
function shotCombo(sh) {
  if (!sh) return null;
  return shotCombos(sh).find(c => c.id === sh.combo) || null;
}
/* 选中的那一档还成立吗（换型号、能力刷新之后 id 会变）：回落判据只在公共层那一份。
   先退到**收得下当前这批素材**的那一档，再退到排在最前的那一档；退档不删素材。 */
function ensureShotCombo(sh) {
  if (!sh) return '';
  if (!window.Capabilities || !Capabilities.fallbackCombo) { if (!shotCombos(sh).length) sh.combo = ''; return sh.combo; }
  const want = Capabilities.fallbackCombo(resolvedModel(sh) || {}, sh.combo, shotUsedRoles(sh));
  if (sh.combo !== want) sh.combo = want;
  return sh.combo;
}
function setShotCombo(sh, id) {
  if (!sh || !id || sh.combo === id) return;
  if (!shotCombos(sh).some(c => c.id === id)) return;
  sh.combo = id;
  /* 换档要重画整块编辑器：槽位（哪些出现、各收几张）、高级设置那三排（Turbo / 超分在这一档给不给）、
     摘要与报价都跟着这一档的声明变，只重画那一排芯片会留下半旧的状态。 */
  renderEditor(); updateBanner(); scheduleSave();
}
/* 这一镜手上各 role 有几条 —— 双向判据 `comboGaps` 的输入。
   ⚠ 画面切片（keyframes）与手动参考图同属 `reference_image`：提交时两者合并成一批，
   计数也必须合起来数，只数 `refImages` 会让「切片 3 张 + 参考图 3 张」在限 1 张的那一档全绿。 */
function shotRoleCounts(sh) {
  if (!sh) return {};
  return {
    /* 隐式首帧（接上一镜尾帧）计 1：模式判据与提交体必须读同一份数，
       否则「视频换人」这类要求首帧的档会被判成缺料，按钮怎么点都不亮。 */
    first_frame: (sh.firstFrame || sh.linkPrev === 'tail') ? 1 : 0,
    last_frame: sh.lastFrame ? 1 : 0,
    reference_image: (sh.refImages || []).filter(Boolean).length + shotKeyframes(sh).length,
    reference_video: sh.refVideo ? 1 : 0,
    reference_audio: sh.refAudio ? 1 : 0,
  };
}
/* 「手上的这批素材，在当前这一档下哪里说不通」：缺料 / 超料 / 这一档不收 / 互斥两组同时用上，
   四种一次判全，判据与那句人话都在公共层那一份（两个页面读同一个 `lines`）。
   没有模式声明时 `missing`/`over` 一律空、`rejected` 退回型号总表 —— 与加这一档之前逐字相同。 */
function shotGaps(sh) {
  const rm = resolvedModel(sh) || {};
  const empty = { missing: [], over: [], rejected: [], conflicts: [], lines: [], ok: true };
  if (!sh || !rm.id || !window.Capabilities || !Capabilities.comboGaps) return empty;
  return Capabilities.comboGaps(rm, sh.combo, shotRoleCounts(sh));
}

/* 这一镜所选模型支持哪些输入 role 与上限。
   唯一依据是 Capabilities.specs（registry 的 inputRoles 为准，能力接口补上限），
   所以 registry 写全了 role，就不存在「上游 /models 少写一个 role 于是槽位消失」的问题。
   选了「输入模式」时再按那一档收窄一次（`Capabilities.comboRoles`），数量也读那一档的
   （`Capabilities.rule(..., combo)`：同一张人物图在「智能参考」里能到 9 张，在「视频换人」里必须恰好 1 张）。 */
function shotInputCaps(sh) {
  const rm = resolvedModel(sh) || {};
  ensureShotCombo(sh);                      // 选中的档还可能来自上一个型号：先回落到这一型号成立的档
  const inCombo = (window.Capabilities && Capabilities.comboRoles) ? Capabilities.comboRoles(rm, sh.combo) : null;
  const specs = (window.Capabilities && Capabilities.specs) ? Capabilities.specs(rm)
    : (rm.options && rm.options.inputSpecs) || [];
  const roles = new Map(specs.map(sp => [sp.role, sp]));
  const has = r => roles.has(r) && (!inCombo || inCombo.has(r));
  const caps = { image: false, ref: false, first: false, last: false, refVideo: false, refAudio: false, none: false };
  caps.ref = has('reference_image');
  caps.image = caps.ref || has('first_frame') || has('last_frame');
  caps.first = has('first_frame');
  caps.last = has('last_frame');
  caps.refVideo = has('reference_video');
  caps.refAudio = has('reference_audio');
  /* 上限按**当前这一档**的声明现取（没有模式声明时 `rule` 自己退回型号总表）。 */
  caps.maxRef = caps.ref && window.Capabilities && Capabilities.rule
    ? (Capabilities.rule(rm, 'reference_image', sh.combo).max || 0)
    : (caps.ref ? Math.max(1, (roles.get('reference_image') || {}).max) : 0);
  /* 「这个槽位收什么样的文件」这句话也现算（inputRoles 的 accept / maxBytes + 提交模板的 requiresAudio），
     以前是写在模板里的死文案「MP4 ≤ 200MB 含音频」——平台改了限制它不会跟着变。 */
  caps.slotNote = role => {
    const rm2 = resolvedModel(sh) || {};
    const bits = [];
    if (window.Capabilities && Capabilities.ruleText) { const t = Capabilities.ruleText(rm2, role); if (t) bits.push(t); }
    const tpl = (window.Api && Api.inputTemplate) ? Api.inputTemplate(provOf(rm2.provider), role) : null;
    if (tpl && tpl.requiresAudio) bits.push('需含音频轨');
    return bits.join(' · ');
  };
  caps.none = !(caps.ref || caps.first || caps.last || caps.refVideo || caps.refAudio);
  /* 素材互斥（能力声明里的 group 驱动）：首尾帧一组、参考素材（图/视频/音频）一组，
     两组不能同时用 —— 界面据此把另一组槽位置灰，提交前再兜一次（见 submitCandidate）。 */
  caps.usedRoles = shotUsedRoles(sh);
  caps.specs = specs;
  if (window.Capabilities) {
    caps.blockedRoles = Capabilities.blockedRoles(rm, caps.usedRoles);
    /* 「已经同时用上互斥的两组」与「这一档 / 这个型号不收已选的素材」不在这里各算一遍 ——
       那两条连同缺料、超料都在下面 `gaps` 那一份双向判据里（`Capabilities.comboGaps`），
       页面再算一次就是第二份实现，两句措辞迟早各说各的。 */
  } else {
    caps.blockedRoles = new Set();
  }
  /* 双向形状判据（缺料 / 超料 / 这一档不收 / 互斥）也挂在这份 caps 上：
     界面那句说明、按钮禁用、提交前的拦截读的都是同一个对象，不会出现三处各算一遍。 */
  caps.gaps = shotGaps(sh);
  return caps;
}

/* ==================== 发送前的请求预览（dry-run） ====================
   「这一镜按生成会发出什么」—— 用户要的是**发送前**就能看到实际发出的提示词与配置。
   拼体完全交给 `Api.preview`（与 `Api.create` 同一段 `buildBody`，不会走岔）；
   素材槽位用**占位符**（真发时才把图传到平台，预览不能触发那次上传），
   那一段判据在 `board-preview.js`。
   刷新时机：右栏重画（改了提示词 / 型号 / 参数 / 素材）与输入框改动都走这里。 */
const BoardPreview = createBoardPreview({
  nameKey: window.nameKey, shotKeyframes, Api, ROLE_ZH,
});
/* 这一镜将要发出的请求体（压成可展示形状）。算不出来就抛 —— 原因照实说，
   不返回空 JSON（空 JSON 会被读成「这次没有请求体」）。 */
function shotPreviewBody(sh) {
  const rm = resolvedModel(sh);
  if (!rm) throw new Error('这一镜还没有能用的型号');
  const prov = needProv(rm.provider, (rm.name || rm.id));
  const p = String((sh && sh.prompt) || '').trim();
  const ctxAdv = shotAdvCtx(sh);
  const ex = shotAdvExtras(sh);
  const cbAdv = shotCombo(sh);
  const ic = shotInputCaps(sh);
  /* 参考语法转换（`@小雅` → 平台认的写法）与真发那条链**同一份**：
     预览里显示的必须是转换之后的样子，否则用户看到的是一份平台压根不认的正文。 */
  const pApi = applyRefSyntax(p, prov);
  return BoardPreview.shotPreview(sh, prov, {
    model: rm.id, prompt: pApi, tier: sh.tier, duration: sh.duration || undefined,
    res: sh.res, ar: sh.ar, size: sh.size,
    note: sh.name || '',
    creation_intent: ctxAdv.intent,
    shape: { mode: ctxAdv.mode, intent: ctxAdv.intent, caps: ctxAdv.caps }, params: ex.params,
  }, ic);
}
/* 刷新这一镜的预览（去抖 + 防乱序由 RawRequest.schedule 管）。
   `catch` 里什么都不做：预览算不出来时**保持上一份**，
   面板上那句「算不出来」由 RawRequest 那边显示（空 JSON 会骗人）。 */
function refreshShotPreview(sh) {
  if (!sh || !window.RawRequest || !RawRequest.schedule) return;
  const tag = 'dir:shot:' + sh.id;
  RawRequest.schedule(tag, () => {
    const rm = resolvedModel(sh);
    if (!rm) return null;
    const prov = needProv(rm.provider, (rm.name || rm.id));
    const body = shotPreviewBody(sh);
    return { label: sh.name || '', provider: rm.provider || '', providerName: rm.name || '',
      endpoint: 'create', method: 'POST',
      path: (prov.relay || '') + ((prov.endpoints && prov.endpoints.create) || '/create'),
      body };
  });
}

/* ==================== 三排「AdvParams 那几档之外」的声明驱动参数 ====================
   判据与画法都在 `gen-forms.js` 的 `AdvExtras`，与生成工作台共用同一份：
     · 型号能力里的布尔参数（`options.bools`，进嵌套 parameters）
     · 提交体**顶层**的布尔开关（`create.topBools`，如 SparkCine 的「平台自动润色」、VGENV 的「Turbo 加速档」）
     · 提交体**顶层**的非布尔字段（`create.shapeFields`，如成片超分档、随机种子）
   导演台以前整块没有这三排 —— 同一个平台在工作台上能勾的那些开关，在这一镜上连控件都不画、
   提交体里一个字都不发，用户以为两个页面走的是同一套参数。
   状态挂在**这一镜**上（`sh.adv`）而不是模块变量：导演台一次编辑的是镜头，切镜头就要跟着换。 */
function shotAdvState(sh) {
  if (!sh.adv) sh.adv = { bools: {}, topBools: {}, shape: {} };
  return sh.adv;
}
/* 「这一次的那一行能力」：按这一镜选中的**输入模式 + 已放的素材 + 档位**问公共层那一份逐行判据
   （ Turbo 给不给、超分有哪些档）。以前这里 combo 传 null、mode / intent 是空串 ——
   于是换人档明明没有 2x 超分、带参考视频那一行明明不给 Turbo，界面照样把开关画出来、提交照样发出去。 */
function shotShapeCaps(sh) {
  const rm = resolvedModel(sh) || {};
  if (!rm.id || !window.Capabilities || !Capabilities.shapeState) return null;
  return Capabilities.shapeState(rm, sh.combo, shotUsedRoles(sh), sh.tier);
}
function shotAdvCtx(sh) {
  const cb = shotCombo(sh);
  /* `mode` 不是提交字段（平台按素材自己推断），它只用来判声明里的 when / hide；
     `intent`（creation_intent）才是真字段。两个都只当上下文递进去，页面不许自己比字符串。 */
  return { mode: (cb && cb.mode) || '', intent: (cb && cb.intent) || '', caps: shotShapeCaps(sh) };
}
/* 画那三排（整块随编辑器重绘，所以不需要工作台那套指纹守卫）。
   `forceDef` = 换型号的那一次：型号布尔那一排按**新声明**的默认值重画，用户点过的照样保住。 */
function paintShotAdv(sh, forceDef) {
  const rm = resolvedModel(sh) || {};
  const prov = provOf(rm.provider);
  const st = shotAdvState(sh);
  const ctx = shotAdvCtx(sh);
  const boolBox = $('edBoolRows');
  if (boolBox) {
    const b = window.AdvExtras.html.bools(rm, { av: st.bools, forceDef: !!forceDef });
    boolBox.innerHTML = b.html;
    boolBox.hidden = !b.count;
  }
  const tbBox = $('edTopBools');
  if (tbBox) {
    const decl = window.AdvExtras.topBoolDecls(prov);
    /* 换型号/换平台后把声明里没有的旧值清掉：留着会被带进提交体（公共层那份清理与工作台同一处）。 */
    window.AdvExtras.prune(st.topBools, decl);
    const h = window.AdvExtras.html.topBools(prov, rm, ctx, st.topBools);
    tbBox.innerHTML = h.html;
    tbBox.hidden = !decl.length;
    if (window.fillIcons) fillIcons(tbBox);
  }
  const sfBox = $('edShapeFields');
  if (sfBox) {
    const decl = window.AdvExtras.shapeFieldDecls(prov);
    window.AdvExtras.prune(st.shape, decl);
    const h = window.AdvExtras.html.shapeFields(prov, ctx.caps, ctx, st.shape);
    sfBox.innerHTML = h.html;
    sfBox.hidden = !decl.length;
    /* build 而不是 sync：这一格的 select 是刚 innerHTML 出来的，还没被公共下拉包过。 */
    if (window.Dropdowns && sfBox.querySelector('select[data-sf]')) Dropdowns.build(sfBox);
  }
  bindShotAdv(sh);
  return true;
}
/* 接线：每一块重绘后绑一次（编辑器整块重建，旧节点上的监听跟着没了，不会越攒越多）。
   磁贴那一路要 `renderEditor(true)` 之外的最小重画 —— 这里直接重画整块编辑器：
   值落在 `sh.adv` 上，摘要与估价都跟着它，重画整块才是最不容易漏更新的画法。 */
function bindShotAdv(sh) {
  const tbBox = $('edTopBools');
  if (tbBox) {
    tbBox.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('[data-tb]');
      if (!btn) return;
      const f = btn.dataset.tb;
      const st = shotAdvState(sh);
      const decl = window.AdvExtras.topBoolDecls(provOf((resolvedModel(sh) || {}).provider)).find(x => x[0] === f);
      /* 「还没被点过」时的起点是**这一档的默认值**（声明里 def 可以是 {when,then,else} 这种随形状变的东西），
         不是「非真即为开」—— 遇到对象默认值时 `!decl[1].def` 会永远翻成 true。 */
      const s = window.AdvExtras.topBoolStateOf(decl && decl[1], shotAdvCtx(sh));
      st.topBools[f] = st.topBools[f] === undefined ? !s.def : !st.topBools[f];
      renderEditor(); updateBanner(); scheduleSave();
    });
  }
  ['edBoolRows', 'edShapeFields'].forEach(id => {
    const box = $(id);
    if (!box) return;
    box.addEventListener('change', e => {
      const sf = e.target && e.target.dataset ? e.target.dataset.sf : '';
      if (sf) shotAdvState(sh).shape[sf] = e.target.value;   // 布尔那一排由 shotAdvExtras 现读 DOM，不必另存
      const sum = $('advSum');
      if (sum) sum.textContent = advSumText(sh);   // 摘要跟着这一排走，否则折叠行看不出勾了什么
      refreshEst(); updateBanner(); scheduleSave();
    });
    box.addEventListener('input', e => {
      const sf = e.target && e.target.dataset ? e.target.dataset.sf : '';
      if (!sf) return;
      shotAdvState(sh).shape[sf] = e.target.value;
      scheduleSave();          // 逐字只落值，不重算报价（随机种子那种长数字，打一半就发一次询价没意义）
    });
  });
}
/* 读回提交体与报价体要用的那一批（与 Api.createBody 里那道 hide / need 过滤同一个判据）。 */
function shotAdvExtras(sh) {
  const rm = resolvedModel(sh) || {};
  const ctx = shotAdvCtx(sh);
  const st = shotAdvState(sh);
  /* ⚠ 只有「正在编辑的这一镜」才从 DOM 读：批量生成时 `submitCandidate` 会在屏幕上还是另一镜的情况下提交
     （连拍、按段排队都是这样），那时 #edAdvBody 里挂着的是**别人那一镜**的控件 ——
     读 DOM 就等于把 A 的参数发到 B 的任务上。非当前镜头一律 root:null，退回 `sh.adv` 那份状态。 */
  const live = sh === curShot() && !!$('edAdvBody');
  return window.AdvExtras.read({
    root: live ? $('edAdvBody') : null, prov: provOf(rm.provider), ctx: ctx, caps: ctx.caps,
    topBoolState: st.topBools, shapeState: st.shape, bools: shotAdvBools(sh),
  });
}
/* 型号布尔那一排：正在编辑的这一镜读控件，别的镜头读 `sh.adv.bools` 那本账（没记过的按声明默认）。 */
function shotAdvBools(sh) {
  const st = shotAdvState(sh);
  if (sh === curShot() && $('edBoolRows')) return window.AdvExtras.boolsFromDom($('edBoolRows'), st.bools);
  const decls = window.AdvExtras.boolDecls(resolvedModel(sh) || {});
  const out = {};
  Object.keys(decls).forEach(k => {
    const prev = st.bools['bool_' + k];
    out[k] = prev === undefined ? (decls[k].def !== false) : prev === '1';
  });
  return out;
}
/* 时长范围 / 一次生成的条数上限 / 分辨率 / 档位 / 比例：**判据在 `gen-forms.js` 的 `AdvParams.plan`**
   （与生成工作台视频栏同一份），这里只写导演台自己的 DOM 与「把回落后的值记回这一镜」。
   以前模板串里是 `t === sh.tier ? 'selected' : ''`，**完全没有回落** —— 存的档位被平台下架之后
   浏览器默默显示第一项，而发出去的还是那个下架的值（界面写着 A、提交体是 B）。
   取值范围与上限仍然**只**来自模型声明（durations / max_outputs），以前各留了一个兜底数
   （[4, 15] 和 4）：平台没声明时界面照样能滑到 15 秒、照样列 4 条，提交才发现平台不吃。
   没有声明就当作「这一项不给选」：时长控件不渲染，条数按平台默认一次一条、下拉也不摆
   （只有一个可选项的下拉是假控件，这条与工作台同判据）。
   ⚠ 现取 `resolvedModel(sh)`：改完 edModel 之后摘要要跟着新型号，不能拿渲染时那一份。 */
function videoPlanOf(sh) {
  const mm = resolvedModel(sh) || {};
  ensureShotCombo(sh);              // 档位清单要按**当前这一档**收窄，先保证 sh.combo 是这一型号成立的 id
  return AdvParams.plan(mm, {
    kinds: ['tier', 'resolution', 'aspect_ratio', 'size', 'duration', 'count'],
    ids: { tier: 'edTier', resolution: 'edRes', aspect_ratio: 'edAr', size: 'edSize', duration: 'durRange', count: 'edDraw' },
    cur: { tier: sh.tier, resolution: sh.res, aspect_ratio: sh.ar, size: sh.size, duration: sh.duration, count: sh.draw },
    /* 取值范围与默认值跟着选中的输入模式（平台在「视频换人」那一档只给到 768p、没有 2x）：
       不递 combo 就等于在页面里替平台编一份「换了模式少哪几个档」，那是第二份判据。 */
    scoped: true, combo: sh.combo,
    prefix: mm.name || '',
    units: { count: '条' },
  });
}
/* 折叠行那一句摘要 = AdvParams 四档的摘要 + 三排里**真进提交体**的那几项（同一个 `AdvExtras.read` 的产物）。
   两句必须同源：以前摘要只写四档，于是勾了「平台自动润色」之后折叠行一个字不提，
   而提交体里带着它 —— 用户只能猜自己勾的东西到底发没发。
   ⚠ 只在三排**画完之后**调（`shotAdvExtras` 读的是活控件，DOM 还没重建时读到的是上一镜的）。 */
function advSumText(sh) {
  return [videoPlanOf(sh).summary, shotAdvExtras(sh).summary].filter(Boolean).join(' · ');
}
/* 这一镜能交出去的画面切片：只数「有资产号（= 出图真的成了）而且没被删掉」的那几张。
   判据在这里只有一份，提交体与归档文案都读它 —— 否则界面写「已带上 3 张关键帧」而请求里只有 1 张。 */
function shotKeyframes(sh) {
  return (sh.keyframes || []).filter(k => k && k.assetId && !k.deleted);
}
/* 素材 → 能交给平台的地址。签名外链本来就是公网 https，原样给它；
   而 `data:`、`/asset/xx`、`/getv?url=` 是本机回环或浏览器内地址，平台根本访问不到
   （表现为「素材被静默丢掉」），要先读成字节转成 DataURL。
   只服务 `needsUpload` 没声明的那一族 —— 声明了要上传的平台走资产编号，不经过这里。 */
async function shotPlatformUrl(src) {
  const s = String(src || '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s)) return s;
  return await toDataURL(s);
}
/* 这一镜的素材 → `Api.createBody` 的 inputEntries（每项 { role, url? | assetId? }）。
   每一项交 url 还是交资产号，完全按 registry 的 `create.inputTemplates[role].needsUpload` 决定，
   与生成工作台 `buildInputEntries` 是同一个口径。以前这里在页面里把两家的**请求体形状**各抄了一遍
   （inputs 数组 vs reference_images / frame_images 顶层字段，字段名、嵌套、数组与否全写死），
   于是接第三家（MiniMax 的 content[]）时拼出去的是上游不认的字段名，
   而且「界面按能力把素材画出来了、提交体却把它发错地方」这种问题只在扣费之后才暴露。
   形状交给声明，这一页只负责回答「这个槽位手上有什么」：
     · 首尾帧 = `sh.firstFrame` / `sh.lastFrame`（选素材时就已经是 DataURL）
     · 参考图 = 画面切片 + 手动参考图**合并**后按型号声明的 maxRef 截断
     · 参考视频 / 参考音频 = 槽位上的那份素材（上面那段 `requiresAudio` 的重传逻辑已经把资产号备好）
   以前切片与手动参考图是 `else if` 二选一：有切片时用户手动加的参考图被整体丢弃、一个字都不说。
   首尾帧与参考素材互斥由 `illegalPairs` 在提交前拦住，所以这里不再用「有帧就不发参考图」代替它。 */
async function shotInputEntries(sh, prov, ic, chainFrame) {
  const out = [];
  const tplOf = r => (window.Api && Api.inputTemplate) ? Api.inputTemplate(prov, r) : null;
  /* 「这一家收不收这个槽位」的判据只有注册表那一份。界面早就按能力声明把素材画出来了，
     走到这里却没有模板 = 注册表漏写，要说清补哪里，而不是发一个猜出来的形状。 */
  const needSlot = (role, name, n) => {
    if (n && !tplOf(role)) throw new Error('「' + name + '」这一家在注册表里没有声明怎么接收'
      + '（registry 的 create.inputTemplates.' + role + '），补上声明才能提交');
  };
  /* `asset` = { id, fromPlatform? }：这份素材手上的资产编号，以及它**本来就是目标平台那一族的编号**吗。
     `fromPlatform` 为假（或压根没给）时不能直接引用 —— 导演台的画面切片、本机上传、素材库里的东西
     存的都是本项目自己的 `/asset/<id>` 编号，上游看见它会当成一个不存在的资产。 */
  const add = async (role, src, name, asset) => {
    const t = tplOf(role);
    const id = asset && asset.id ? asset.id : '';
    const localSrc = id && !asset.fromPlatform ? Api.assetSrc(id) : src;
    if (t.needsUpload) {
      const got = (asset && asset.fromPlatform) ? id : (localSrc ? await uploadImageDataUrl(localSrc, name, prov.id) : '');
      if (!got) throw new Error('这份「' + name + '」转不成 ' + ((prov.displayName || prov.name) || '目标平台') + ' 的资产，请重新选一次素材');
      out.push({ role, assetId: got });
    } else {
      const url = await shotPlatformUrl(localSrc);
      if (!url) throw new Error('这份「' + name + '」取不到能交给平台的地址，请重新选一次素材');
      out.push({ role, url });
    }
  };
  const kfs = shotKeyframes(sh);
  const refs = sh.refImages || [];
  /* 显式首帧优先；没有时用接续帧（上一镜尾帧，由 submitCandidate 在提交那一刻解析好递进来）。 */
  const firstSrc = sh.firstFrame || (chainFrame && chainFrame.src) || '';
  const frames = [['first_frame', firstSrc, '首帧'], ['last_frame', sh.lastFrame, '尾帧']].filter(x => x[1]);
  needSlot('first_frame', '首帧', firstSrc ? 1 : 0);
  needSlot('last_frame', '尾帧', sh.lastFrame ? 1 : 0);
  needSlot('reference_image', '参考图', (kfs.length + refs.length) ? 1 : 0);
  for (const [role, src, name] of frames) await add(role, src, name, null);
  /* 读不出字节 / 超上限的那几张不能闷着不发：提交前状态条会被「已提交」覆盖，所以要用 Toast 说。 */
  const maxRef = Math.max(1, ic.maxRef);
  let got = 0, failed = 0, over = 0;
  const pushRef = async (src, name, asset) => {
    if (got >= maxRef) { over++; return; }
    try { await add('reference_image', src, name, asset); got++; }
    catch (e) { failed++; console.warn('[director] ' + name + '没交出去：', e); }
  };
  /* 画面切片 = 导演台自己的生图产物，存的是 `/asset/<id>` 那一份本机资产 */
  for (const k of kfs) await pushRef('', '画面切片', { id: k.assetId });
  for (const img of refs) await pushRef(img, '参考图', null);
  if (failed || over) {
    const why = [failed ? failed + ' 个读不出来（可能已过期）' : '', over ? over + ' 个超出这个型号的上限 ' + maxRef : '']
      .filter(Boolean).join('，');
    setStatus('<span class="warn">有参考素材本次没带上：' + why + '</span>');
    Toast.warn('少了参考素材：' + why);
  }
  const medias = [];
  if (ic.refVideo && sh.refVideo) medias.push(['reference_video', sh.refVideo, '参考视频']);
  if (ic.refAudio && sh.refAudio) medias.push(['reference_audio', sh.refAudio, '参考音频']);
  for (const [role, ref, name] of medias) {
    needSlot(role, name, 1);
    /* 以前这一条写的是「没有 asset_id 就整个跳过」—— 素材明明选了，提交体里一个字没有，
       界面上却写着「已带上参考视频」。现在交不出能用的地址就直接报错，让用户看得见。
       资产号属于哪一家由 `ref.provider` 现问（与上面 `requiresAudio` 那段重传同一份判据）：
       本机资产对任何平台都要先转存，别把本机的编号当平台编号发给上游。 */
    const local = sameAssetSpace(ref.provider, assetStoreId());
    const src = ref.src || (local && ref.asset_id ? Api.assetSrc(ref.asset_id) : '');
    try {
      await add(role, src, name, ref.asset_id ? { id: ref.asset_id, fromPlatform: !local } : null);
    }
    catch (e) { throw new Error('这份「' + name + '」没能交给平台：' + errText(e)); }
  }
  return out;
}

/* 素材与模式说不通的那一句：人话由公共层拼好（`comboGaps().lines`，缺料 / 超料 / 这一档不收 / 互斥
   四种一次列全），这一页与生成工作台读的是同一份 —— 两页各写一遍措辞就会各说各的。
   这里只补「另一组还空着、但被已选的那一组挡住」那一句：它讲的是「这一格现在点不动」，
   与「已经放好的素材有错」是两件事，合成一句反而把出路说没了。 */
function conflictNote(ic) {
  const zh = r => ROLE_ZH[r] || r;
  const lines = ((ic && ic.gaps && ic.gaps.lines) || []).slice();
  const used = [...new Set((ic && ic.usedRoles) || [])].map(zh);
  const blocked = [...new Set((ic && ic.blockedRoles) || [])];
  if (used.length && blocked.length) lines.push(`「${used.join(' / ')}」已选 →「${blocked.map(zh).join(' / ')}」不可同时使用（型号声明互斥），清空已选即可切换`);
  return lines.join('；');
}
/* 这一镜能不能生成：返回原因文案（空字符串 = 可以）。按钮禁用、批量生成筛选、提交校验共用一份判定。
   提示词只要求「非空」+ **这一家声明了的长度区间**（registry 的 `create.promptLimits`）。
   现在注册表里一家都没声明（VGENV 那条约曾被按实测删掉）—— 没声明就一个字不显示、也不拦，
   页面不替平台编「至少 5 个字」这种数字。机制留着：谁家哪天声明了，区间照样画在提示词框旁边，
   不够长时按钮当场禁用并写明原因，而不是等点完生成才拿到一句平台的 422。 */
const NO_PROMPT_WHY = '先写这一镜的提示词';
/* 「这一家的提示词长度闸」—— 声明只有一处（registry 的 create.promptLimits），
   上下限的读法与那句措辞也只有一处（`gen-forms.js` 的 `CharLimits`，与 `Api.createBody`
   提交前那一问同一个来源 —— 两边各写一个数才会对不上，各写一句则界面上没有的话会在提交时冒出来）。
   `byIntent` 那一档（动作换人允许省略 / 上限另算）只有提交那一路判：这一栏上没有「换人」这一格，
   界面按总档判就够了。 */
function promptLimitOf(sh) {
  const rm = resolvedModel(sh);
  const prov = rm && rm.provider ? provOf(rm.provider) : null;
  const PL = prov && prov.create && prov.create.promptLimits;
  if (!PL) return null;
  const b = window.CharLimits.prompt(PL, '');
  return { min: b.min, max: b.max, who: (prov && (prov.displayName || prov.name)) || '这一家' };
}
function promptLimitWhy(sh) {
  const PL = promptLimitOf(sh);
  if (!PL) return '';
  return window.CharLimits.why((sh && sh.prompt) || '', PL, { who: PL.who, noun: '提示词' });
}
/* 提示词框旁边那截小字：只有声明了长度的一家才画（写出它的区间），没声明的家整块不出现 */
function promptLimitNote(sh) {
  const PL = promptLimitOf(sh);
  if (!PL) return '';
  return `<span class="cnt" id="pLim" title="提交前按 ${esc(PL.who)} 的声明拦长度；不够长时生成按钮会禁用">${esc(window.CharLimits.range(PL))} 字</span>`;
}
let edPromptTouched = false;      // 用户在这个镜的提示词框里动过手没有（决定底部那行要不要刷屏）
/* 换型号那一次要「按新声明的默认值」重画型号布尔那一排（用户点过的保住，没点过的跟声明走）。
   与生成工作台那个 `modelChanged` 参数同一语义，只是导演台的重绘入口在这里。 */
let edModelChanged = false;
/* 画面生成（生图型号）那一路的同一个旗标：换生图型号那一次，型号布尔按新声明的默认值重画。 */
let kfModelChanged = false;
/* 「生成」提交窗口期（上传素材可能要好几秒）：按钮的禁用**按它现算**（模板与 syncGenGate 两处都读）。
   光在 onclick 里 disable 那颗旧元素没用 —— pushPlaceholders 里那次 renderAll 会把按钮换掉，
   新元素又是可点的；上传中再点一次就是第二条提交、第二笔钱（双击即重复扣费）。 */
let genOneBusy = false;
function shotBlockReason(sh, ic) {
  const p = String((sh && sh.prompt) || '').trim();
  if (!p) return NO_PROMPT_WHY;
  /* 长度闸在这一句之后：空提示词是初始态（标题栏那句就够），写过字才按这一家的区间判 */
  const limWhy = promptLimitWhy(sh);
  if (limWhy) return limWhy;
  /* 接续型号接不了首帧：比「素材说不通」更靠前，因为这一条是明确的手选冲突。 */
  const chainModel = chainModelWhy(sh);
  if (chainModel) return chainModel;
  const caps = ic || shotInputCaps(sh);
  /* 「这一档要求带却没带够 / 带超了 / 这一档不收 / 互斥两组都用了」四种说不通一次判全，
     判据与文案都在公共层那一份（与生成工作台同一个读数）。
     以前这里只查互斥与「型号不支持」两头，于是选了「视频换人」而手上只有 9 张参考图、
     一条参考视频都没放，按钮是亮的，点下去才拿到平台那句 422。 */
  const g = caps.gaps || shotGaps(sh);
  if (g.lines && g.lines.length) return g.lines.join('；');
  if (!resolvedModel(sh)) return '没有支持这组素材的型号';
  /* 高级设置里越界或非数的那一项（种子、超分档那种）：与生成工作台同一个判据、同一处拦。
     不拦的话按钮是亮的、点下去才在提交时报错，而那句报错来自上游，看着像「平台坏了」。 */
  const bad = shotAdvExtras(sh).bad;
  if (bad.length) return bad.join('、');
  /* 接续的最后一道闸：上一镜还没出画面时这一镜不是「不能生成」，只是「还没轮到」。
     genAll 靠这句话单独归类成等待，不把它算成永久不可生成。 */
  const chainWhy = chainWaitWhy(sh);
  if (chainWhy) return chainWhy;
  return '';
}
/* 底部那行「为什么还不能生成」跟三个工作台同一套规矩（见 workbench.js 的 Wb.ready）：
   空提示词是初始态、不是用户做错了，没动过手之前不拿它刷屏（按钮照样禁用，title 里写着原因）；
   一旦在提示词框里敲过字，卡住的原因就实时显示，改对了自行消失。 */
function footerCanText(canGen, why) {
  if (canGen) return '✓ 可以生成';
  if (why === NO_PROMPT_WHY && !edPromptTouched) return '';
  return esc(why);
}
/* 「这一镜能不能生成」在界面上有三个落点：整栏重画那一次（模板里的 `${canGen}`）、
   切换候选刷提示词框那一次、逐字敲描述那一次。三处必须问同一个 `shotBlockReason`：
   后两处以前自己写成 `!!ta.value.trim()`，于是在「视频换人」这一档只写了描述、
   参考视频一张没放，按钮就亮了、底部还打勾 —— 点下去才拿到平台那句 422，
   而这一档的要求明明就写在同一页刚画出来的那行说明里。 */
function syncGenGate(sh) {
  const why = shotBlockReason(sh);
  /* busy 也要算进去：提交窗口期里敲字触发这一处时，不许把按钮重新点亮（同一判据见 genOneBusy）。 */
  const g1 = $('genOne'); if (g1) g1.disabled = !!why || genOneBusy;
  const fc = $('edFooterCan');
  if (fc) {
    fc.className = 'can ' + (why ? 'no' : '');
    fc.innerHTML = footerCanText(!why, why);
    fc.title = why;
  }
  return why;
}

/* 新增素材前的守卫：互斥的槽位直接拦下并提示（就地闪烁说明，不用顶部横幅） */
function canAddSlot(sh, slotKey) {
  const ic = shotInputCaps(sh);
  const role = SLOT_ROLE[slotKey];
  if (role && ic.blockedRoles.has(role)) {
    flashConflict(conflictNote(ic) || '该素材与已选素材互斥，不能同时使用');
    return false;
  }
  return true;
}
/* 互斥说明就地反馈：闪一下编辑器里那行红色说明（编辑器没渲染这一镜时才退回横幅） */
let conflictFlashTimer = null;
function flashConflict(msg) {
  const el = document.getElementById('conflictHint');
  if (!el) {
    if (msg) setStatus('<span class="err">' + msg + '</span>');
    return;
  }
  if (msg) el.textContent = msg;
  el.classList.remove('flash');
  void el.offsetWidth;                 // 重排一次，让动画能重复触发
  el.classList.add('flash');
  el.scrollIntoView({ block: 'nearest' });
  clearTimeout(conflictFlashTimer);
  conflictFlashTimer = setTimeout(() => {
    el.classList.remove('flash');
    const sh = curShot();
    if (sh && el.isConnected) el.textContent = conflictNote(shotInputCaps(sh));
  }, 2400);
}

function modelOptionsFor(sh) {
  // 必须选具体模型（不再提供「自动」），未选时默认第一个可用模型
  const groups = shotModels(sh);
  let opts = '';
  groups.forEach(g => {
    opts += `<optgroup label="${g.displayName || g.name}">`;
    // 选项文字用平台的原始调用名（model id），友好名放 title；分组标签就是 API 来源
    g.models.forEach(m => opts += `<option value="${esc(m.id)}" title="${esc(m.name || '')}" ${sh.model === m.id ? 'selected' : ''}>${esc(m.id)}</option>`);
    opts += '</optgroup>';
  });
  return opts;
}



/* 选了模型就问一次本地能力接口（/capabilities），按上游返回的能力重画参数与素材槽位。
   和图片台 / 视频台同一套：端点、密钥、兜底都在代理里，页面只管「问一句、照着画」。
   返回代理的答复（含 source/note），失败返回 null —— 界面继续用 registry 的兜底声明。 */
async function refreshCapsForModel(provId) {
  const prov = provOf(provId);
  if (!prov || !window.Capabilities || !(prov.models || []).length) return null;
  try { return await Capabilities.refreshProvider(REGOf(), prov, {}); }
  catch (e) { console.warn('[导演台] 能力接口读取失败（按平台声明展示）：', e.message); return null; }
}

/* 平台对象一律来自注册路由（/registry），别写死某个平台 —— 接新供应方时页面不用改 */
/* 「这个模型属于哪一家平台」。
   ⚠ 以前这里有一个**兜底**：找不到就默默取第一家视频平台。那是错的，而且错法极其隐蔽：
     项目里两家视频平台的型号 id 形状不同（SparkCine 是 `h3-video`，VGENV 是 `minimax/h3`），
     而上游校验是 `model must match /^[a-z0-9][a-z0-9._-]*\/...$/` ——
     于是「模型属于 A、请求发给了 B」表现为**一个看不懂的 model 格式错误**，
     而界面上「型号」那一栏明明选的是 A（用户什么都没做错）。
   常见触发：换了端口 / 清过缓存 / 恢复过设置，REGOf() 里的 id 与工作区里存着的 providerId 对不上。
   所以现在**绝不兜底到另一家**：认不出就返回 null，由调用方报一句说清原因的话
   （「这个型号属于「xxx」，但当前注册表里没有这一家 —— 到设置页重新勾一下」）。 */
function provOf(providerId) {
  const list = (REGOf()?.providers || []);
  return list.find(p => p.id === providerId || (p.keyId || p.id) === providerId) || null;
}
/** 同上，但**认不出时给一句能照做的话**，而不是把请求发给别家。 */
function needProv(providerId, where) {
  const p = provOf(providerId);
  if (p) return p;
  throw new Error('「' + (where || '这个型号') + '」属于「' + (providerId || '?') + '」，'
    + '但当前的平台清单里没有这一家 —— 到「设置 → 供应商与密钥」重新勾一下它，再回来重试');
}

/* ---------- 渲染：右栏编辑器 ---------- */
/* 素材图统一入口：图片与来源标签一一对应。
   `label` 是**这一张的显示名**，同时也是提示词里的那个 token —— 两处必须是同一个字符串：
     · 预览图        → `小雅`
     · 角色资产      → `小雅·三视图`
   提交前 `refTokenize` 就是拿它把 `@小雅·三视图` 换成 `@参考图N` 的。
   把「是哪一张」并进 label（而不是另存一个 note 字段）还有一个好处：
   同一位的两张资产拿到的是**两个不同的 token**，各指各的那一张，
   不会像以前那样「两张都叫 @小雅，只认第一张」。 */
function addRefImage(sh, src, label, refId) {
  sh.refImages.push(src);
  sh.refMeta = Array.isArray(sh.refMeta) ? sh.refMeta : [];
  /* refMeta 扩成 { id, label }：id 是库条目主键（改名不断引用），label 是芯片上显示的 token。
     老数据没有 id 的条目按 label → nameKey 反查库里补 id（14.1-6）。 */
  sh.refMeta.push({ id: refId || null, label: label || null });
}
/* 14.1-6：老工程 refMeta 没 id 的条目，按 label → nameKey 反查库里补 id。
   查不到的照实标「这条引用对不上库」，不静默丢。幂等：已有 id 的不动。 */
function backfillRefMetaIds(shots) {
  if (!window.Chars || !Chars.Lib) return 0;
  let n = 0;
  try {
    const lib = Chars.Lib.list() || [];
    (shots || []).forEach(sh => {
      (Array.isArray(sh.refMeta) ? sh.refMeta : []).forEach(rm => {
        if (!rm || rm.id) return;
        const lb = String(rm.label || '').replace(/^@/, '').split('·')[0].trim();
        if (!lb) return;
        const hit = lib.find(x => x && nameKey(x.name) === nameKey(lb));
        if (hit) { rm.id = hit.id; n++; }
      });
    });
  } catch (e) { /* 库读不到就跳过，下次再补 */ }
  return n;
}
function removeRefImage(sh, i) {
  sh.refImages.splice(i, 1);
  if (Array.isArray(sh.refMeta)) sh.refMeta.splice(i, 1);
}

/* ============================ 提示词里的 @ 引用（素材库 → 参考图） ============================
   在提示词里打一个 `@`，就能引用**素材库**里的角色 / 场景 / 道具：选中之后除了把 `@名字`
   写进提示词，还会把这一条的**预览图自动加进这一镜的参考图** —— 这就是「导演台引用素材库」。
   顺带把这一镜**已有的参考图**也列进候选：`@参考图N` 本来就是提交时会被转换的语法
   （见 applyRefSyntax），这样「第几张是哪条素材」在提示词里能写清楚。

   候选浮层挂在 body 上、position:fixed：右栏编辑器每次重画都换节点，挂在编辑器里会跟着丢；
   位置按光标现算（textarea 自己给不出光标坐标，用一个同款镜像层量）。
   -------------------------------------------------------------------------- */
const MENTION_MAX = 30;
let mentionBox = null, mentionState = null;

function mentionEl() {
  if (mentionBox && mentionBox.isConnected) return mentionBox;
  mentionBox = document.createElement('div');
  mentionBox.id = 'mentionBox';
  mentionBox.hidden = true;
  document.body.appendChild(mentionBox);
  return mentionBox;
}
function hideMention() { mentionState = null; if (mentionBox) mentionBox.hidden = true; hideMentionSub(); }

/* 光标前面那一段是不是「正在打一个 @」：是就返回 {start, end, q}，不是返回 null。
   判据只有一条：`@` 前面**不能是字母 / 数字**（那是邮箱 a@b.com 那种），中间不能有空白。
   ⚠ 别把「前面必须是空白或标点」写进来 —— 中文句子本来就不打空格，
   「一个女孩站在@小雅旁边」里 @ 前面是「在」，那样写会让中文环境下**永远弹不出来**。 */
function mentionAt(ta) {
  if (!ta || ta.selectionStart !== ta.selectionEnd) return null;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const q = before.slice(at + 1);
  if (q.length > 24 || /[\s\u3000]/.test(q)) return null;
  const prev = at > 0 ? before[at - 1] : '';
  if (prev && /[A-Za-z0-9._%+-]/.test(prev)) return null;
  return { start: at, end: pos, q: q };
}
/* 候选 = 这一镜已有的参考图（本镜素材）+ 素材库（角色 / 场景 / 道具）。按 `@` 后面那串过滤。
   每一行与挑选浮层一致：缩略图 · `@名字` · 右边一列「类型 · 来源」；
   没有预览图的素材压暗并写明原因（引用不了 —— 加不进参考图）。 */
function mentionCands(sh, q) {
  const D = window.Chars;
  const kw = String(q || '').toLowerCase();
  const out = [];
  (sh.refImages || []).forEach((src, i) => {
    const nm = '参考图' + (i + 1);
    if (kw && nm.toLowerCase().indexOf(kw) < 0) return;
    const lb = (Array.isArray(sh.refMeta) && sh.refMeta[i] && sh.refMeta[i].label) || '';
    out.push({ kind: 'ref', name: nm, idx: i, pic: src, meta: '本镜素材' + (lb ? ' · ' + lb : '') });
  });
  const lib = (D && D.Lib) ? (D.Lib.list() || []) : [];
  lib.forEach(c => {
    const nm = String((c && c.name) || '');
    if (!nm) return;
    if (kw && nm.toLowerCase().indexOf(kw) < 0) return;
    const pic = (D.refPicOf ? D.refPicOf(c) : D.picOf(c)) || '';
    const kindZh = (D.LIB_KINDS && D.LIB_KINDS[D.libKindOf(c)]) || '素材';
    /* 有角色资产的那几条悬停时会滑出二级菜单（见 showMentionSub）。这里把「有几张可选」
       写进右边那一列，并在行尾加一个 › 作提示 —— 没有它，用户不会知道还能挑别的图。 */
    const na = Math.max(0, (D.Cast.assetsOf(c) || []).length);
    out.push({ kind: 'lib', name: nm, entry: c, pic: pic, sub: libPicChoices(c).length > 1,
      meta: [kindZh, String(c.group || '').trim()].filter(Boolean).join(' · ')
        + (pic ? '' : ' · 还没有预览图') + (na ? ' · ' + na + ' 张资产' : ''),
      off: !pic && !na });
  });
  return out.slice(0, MENTION_MAX);
}
/* 这一镜「提到」的素材 = 它的参考图（每张一枚芯片）。
   芯片上写的就是提示词里那个 token（`@小雅` / `@小雅·三视图`）—— refMeta.label 一份数据，
   输入栏、芯片、提交前的 refTokenize 三处共用，所以永远对得上。
   不限于「用 @ 引来的那些」：手动传的、切片生成的参考图也是这一镜的素材。 */
function mentionedMats(sh) {
  const meta = Array.isArray(sh.refMeta) ? sh.refMeta : [];
  return (sh.refImages || []).map((src, i) => ({
    n: i + 1,
    src: src,
    label: String((meta[i] && meta[i].label) || '').trim(),
  }));
}
/* ============================ 提示词里的 @素材：高亮 + 悬停信息 ============================
   textarea 自己没法给某几个字上色，所以下面铺一层**镜像层**（同字号同内边距的副本），
   只给 @片段 画一块底；镜像层的文字一律透明，看得见的还是 textarea 里那行字 ——
   这样中文输入法正在拼的那几个字照旧看得见，不会被镜像层盖住（把 textarea 的文字改成透明
   那种写法在中文环境下是致命的：拼字过程会整段看不见）。
   悬停命中用镜像层里那几个 span 的**实际位置**判（它们是真元素），不去算字符宽度。
   -------------------------------------------------------------------------- */
/* 提示词里 @ 到的那几条素材的名字集合：高亮与悬停都用它。
   与 mentionCands / refTokenize 读同一份数据，但**三种写法都要在里面**：
     · 素材名（`小雅`）—— 点整行 / 点预览图时插的就是它；
     · `素材名·资产名`（`小雅·三视图`）—— 二级菜单里挑角色资产时插的是它，
       库里每一条的每一张资产都要预先收进来：不预收的话，手打出来的 `@小雅·三视图`
       在「还没加进参考图」之前是不会有灰底的，而它明明就是一个合法的引用写法；
     · `参考图N` —— 手动传的、切片生成的参考图只有这个写法。
   另外把**已经加进这一镜的** refMeta.label 也收进来（老数据里可能有对不上库的名字）。 */
function atNames(sh) {
  const D = window.Chars;
  const s = new Set();
  const lib = (D && D.Lib) ? (D.Lib.list() || []) : [];
  lib.forEach(c => {
    const nm = String((c && c.name) || '').trim();
    if (!nm) return;
    s.add(nm);
    if (!D.Cast || !D.Cast.assetsOf) return;
    (D.Cast.assetsOf(c) || []).forEach(a => {
      if (!a || !a.src) return;
      const an = String((D.Cast.assetName && D.Cast.assetName(a)) || '').trim();
      if (an) s.add(nm + '·' + an);
    });
  });
  (sh.refImages || []).forEach((src, i) => {
    s.add('参考图' + (i + 1));
    const lb = String((Array.isArray(sh.refMeta) && sh.refMeta[i] && sh.refMeta[i].label) || '').trim();
    if (lb) s.add(lb);
  });
  return s;
}
/* 提示词 → 「只给 @片段 画底」的镜像 HTML。不是素材名的 @（邮箱、@某人）不画。 */
function atBackHTML(sh, text) {
  const names = atNames(sh);
  const src = String(text == null ? '' : text);
  const re = /(^|[^A-Za-z0-9._%+-])@([^\s\u3000@，。；、,.!?！？：:（）()【\[\]「」『』"']{1,24})/g;
  let out = '', last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    const at = m.index + m[1].length, nm = m[2];
    if (!names.has(nm)) continue;
    out += esc(src.slice(last, at)) + '<span class="ta-at" data-nm="' + esc(nm) + '">@' + esc(nm) + '</span>';
    last = at + 1 + nm.length;
    re.lastIndex = last;
  }
  /* 末尾补一个换行：textarea 最后一行是空行时镜像层的高度才对得上（经典做法）。 */
  return out + esc(src.slice(last)) + '\n';
}
function syncAtBack(sh) {
  const ta = $('edPrompt'), back = $('edPromptBack');
  if (!ta || !back) return;
  back.innerHTML = atBackHTML(sh, ta.value);
  back.scrollTop = ta.scrollTop;
}
/* 鼠标滑过提示词框：落在哪个 @片段 上就弹一张小卡（名字 + 类型 + 图） */
let atPeek = null;
function atPeekEl() {
  if (atPeek && atPeek.isConnected) return atPeek;
  atPeek = document.createElement('div');
  atPeek.id = 'atPeek';
  atPeek.hidden = true;
  document.body.appendChild(atPeek);
  return atPeek;
}
function hideAtPeek() { if (atPeek) atPeek.hidden = true; }
function hoverAt(sh, e) {
  const back = $('edPromptBack');
  if (!back) return hideAtPeek();
  const hit = [...back.querySelectorAll('.ta-at')].find(el => {
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  });
  if (!hit) return hideAtPeek();
  const nm = hit.dataset.nm || '';
  const D = window.Chars;
  const lib = ((D && D.Lib) ? (D.Lib.list() || []) : []);
  const kindZhOf = x => (D.LIB_KINDS && D.LIB_KINDS[D.libKindOf(x)]) || '素材';
  let pic = '', meta = '';
  /* 四种写法都要认（与 atNames 收进来的那三种一一对应）：
       ① `名字·资产名` —— 二级菜单里挑的角色资产，图就是那一张；
       ② 素材名          —— 预览图；
       ③ 本镜已有的来源标签（老数据里可能有对不上库的名字）；
       ④ `参考图N`       —— 手动传的、切片生成的。
     顺序有讲究：`名字·资产名` 必须先试，否则会先被「素材名」那一支拦下（`小雅·三视图`
     既不等于 `小雅`，所以其实不会撞；但把最具体的放前面，以后加新写法时不容易踩到）。 */
  const sepAt = nm.indexOf('·');
  const host = sepAt > 0 ? lib.find(x => x && x.name === nm.slice(0, sepAt)) : null;
  const assetHit = host ? (D.Cast.assetsOf(host) || []).find(a => a && a.src
    && ((String((D.Cast.assetName && D.Cast.assetName(a)) || '').trim()) === nm.slice(sepAt + 1))) : null;
  const ri = (sh.refImages || []).findIndex((src, i) => {
    const lb = String((Array.isArray(sh.refMeta) && sh.refMeta[i] && sh.refMeta[i].label) || '').trim();
    return lb && lb === nm;
  });
  if (assetHit) {
    pic = assetHit.src;
    meta = kindZhOf(host) + ' · ' + nm.slice(sepAt + 1) + '（' + (host.name || '') + ' 的角色资产）';
  } else if (ri >= 0) {
    pic = sh.refImages[ri];
    meta = '本镜素材 · 参考图 ' + (ri + 1);
  } else {
    const c = lib.find(x => x && x.name === nm);
    if (c) {
      pic = (D.refPicOf ? D.refPicOf(c) : D.picOf(c)) || '';
      meta = kindZhOf(c);
      if (String(c.group || '').trim()) meta += ' · ' + String(c.group).trim();
      if (!pic) meta += ' · 还没有预览图';
    } else {
      const m = /^参考图(\d+)$/.exec(nm);
      const i = m ? Number(m[1]) - 1 : -1;
      if (i >= 0 && sh.refImages && sh.refImages[i]) {
        pic = sh.refImages[i];
        const lb = (Array.isArray(sh.refMeta) && sh.refMeta[i] && sh.refMeta[i].label) || '';
        meta = '本镜素材' + (lb ? ' · ' + lb : '');
      }
    }
  }
  const box = atPeekEl();
  box.hidden = false;
  box.innerHTML = '<span class="pk-t">' + (pic ? '<img src="' + esc(Api.mediaSrc(pic)) + '" alt="">' : icon('image', 15)) + '</span>'
    + '<span><span class="pk-n">@' + esc(nm) + '</span><br><span class="pk-k">' + esc(meta) + '</span></span>';
  const r = hit.getBoundingClientRect();
  const w = box.offsetWidth || 200, h = box.offsetHeight || 52;
  box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
  box.style.top = Math.max(8, (r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6)) + 'px';
}
/* 光标在 textarea 里的像素位置：用一个同款镜像层量（字体 / 内边距 / 行高 / 宽度必须与它一致）。 */
function caretXY(ta) {
  const cs = getComputedStyle(ta);
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;'
    + 'border:0;font:' + cs.font + ';padding:' + cs.padding + ';line-height:' + cs.lineHeight
    + ';letter-spacing:' + cs.letterSpacing + ';width:' + ta.clientWidth + 'px;';
  d.textContent = ta.value.slice(0, ta.selectionStart);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  d.appendChild(mark);
  document.body.appendChild(d);
  const r = ta.getBoundingClientRect();
  const out = { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop, h: mark.offsetHeight || 18 };
  d.remove();
  return out;
}
/* rect = 浮层贴着谁的下边缘放（光标那一格，或 `@素材` 那颗按钮） */
function mentionPlace(rect) {
  const box = mentionEl();
  const w = box.offsetWidth || 320;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 10));
  let top = rect.bottom + 4;
  const h = box.offsetHeight || 240;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);   // 底下放不下就翻到上面
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}
/* range = 要替换掉的那一段（打字触发时是 `@` 到光标；点 `@素材` 打开时是 null = 插到光标处）。
   cands 为空时**照样画**（画一句空状态），不像以前那样静默收起来 —— 点了按钮什么都不出现最像坏了。 */
/* 这一条素材身上**有哪几张图**：预览图在前，然后是每一张角色资产。
   二级菜单与「选中之后加哪一张」都读它这一份 —— 两处各列一遍迟早对不上。 */
function libPicChoices(entry) {
  const D = window.Chars;
  if (!D || !entry) return [];
  const out = [];
  const pic = (D.refPicOf ? D.refPicOf(entry) : D.picOf(entry)) || '';
  const shown = D.picOf(entry) || '';
  if (pic) out.push({ src: pic, note: '', kind: 'preview', tag: entry.anchor ? '身份锚点' : '预览图' });
  if (shown && shown !== pic) out.push({ src: shown, note: '', kind: 'preview', tag: '预览图' });
  (D.Cast.assetsOf(entry) || []).forEach(a => {
    if (!a || !a.src) return;
    if (out.some(x => x.src === a.src)) return;      // 锚点就是这张资产时不重复列
    const nm = (D.Cast.assetName(a) || '资产');
    out.push({ src: a.src, note: nm, kind: 'asset', tag: '资产' });
  });
  return out;
}
/* 二级菜单（悬停某个角色时从右边滑出的那一列）。挂在 body 上、position:fixed：
   浮层自己是 overflow-y:auto，放里面会被裁掉。 */
let mentionSub = null, mentionSubTimer = null, mentionSubRow = null;
function mentionSubEl() {
  if (mentionSub && mentionSub.isConnected) return mentionSub;
  mentionSub = document.createElement('div');
  mentionSub.id = 'mentionSub';
  mentionSub.hidden = true;
  document.body.appendChild(mentionSub);
  return mentionSub;
}
function hideMentionSub() {
  clearTimeout(mentionSubTimer); mentionSubTimer = null;
  mentionSubRow = null;
  if (mentionSub) mentionSub.hidden = true;
}
/* 什么时候真的收掉二级菜单：**到点了再看一眼鼠标在哪儿**。
   只写「进入时 clearTimeout」是不够的 —— 鼠标从那一行挪到右边那一列，途中必然先离开那一行，
   那个 mouseleave 一定先于 mouseenter 触发；只要两者之间有任何一次顺序意外（或者鼠标
   在 180ms 里没走到），定时器就没人清，菜单当场收掉（用户看到的就是「一进去就自动关了」）。
   现在把判据落在「鼠标还在不在这一行 / 这一列里」，与事件顺序无关。 */
function scheduleHideSub(ms) {
  clearTimeout(mentionSubTimer);
  mentionSubTimer = setTimeout(() => {
    mentionSubTimer = null;
    if (mentionSub && !mentionSub.hidden && mentionSub.matches(':hover')) return;
    if (mentionSubRow && mentionSubRow.matches(':hover')) return;
    hideMentionSub();
  }, ms || 260);
}
/* 悬停在某一行的角色上 → 右边滑出「挑一张当参考图」。
   **只有真的有的挑（预览图之外还有资产）才弹** —— 只有一张图时弹一个只有一项的菜单是噪音。 */
function showMentionSub(sh, cand, rowEl) {
  const choices = libPicChoices(cand.entry);
  if (choices.length < 2) return hideMentionSub();
  const box = mentionSubEl();
  mentionSubRow = rowEl;
  box.hidden = false;
  box.innerHTML = '<div class="ms-h">@' + esc(cand.name) + ' · 挑一张当参考图</div>'
    + choices.map((ch, i) => '<div class="ms-i" data-msi="' + i + '">'
      + '<span class="ms-t">' + (ch.src ? '<img src="' + esc(Api.mediaSrc(ch.src)) + '" alt="" loading="lazy">' : icon('image', 15)) + '</span>'
      + '<span class="ms-n">' + esc(ch.note || ch.tag) + '</span>'
      + '<span class="ms-k">' + esc(ch.tag) + '</span></div>').join('');
  box.querySelectorAll('[data-msi]').forEach(el => {
    el.onmousedown = e => {
      e.preventDefault();
      const st = mentionState;
      if (st) pickMention(st.sh, cand, choices[Number(el.dataset.msi)]);
    };
  });
  /* 贴着那一行的右边放，**与行重叠 6px**：中间留缝的话鼠标要跨过去，跨的那一瞬
     既不在行里也不在列里，定时器就有机会先烧掉。重叠一点，鼠标一动就已经在列里了。
     右边放不下就翻到左边（同样重叠 6px）。 */
  const r = rowEl.getBoundingClientRect();
  const w = box.offsetWidth || 272, h = box.offsetHeight || 200;
  let left = r.right - 6;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w + 6);
  box.style.left = left + 'px';
  box.style.top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8)) + 'px';
  box.onmouseenter = () => clearTimeout(mentionSubTimer);
  box.onmouseleave = () => scheduleHideSub();
}
function showMention(sh, cands, range, rect) {
  const box = mentionEl();
  mentionState = { sh: sh, cands: cands, i: 0, range: range || null };
  box.hidden = false;
  box.innerHTML = cands.length
    ? cands.map((c, i) => {
      const pic = c.pic ? Api.mediaSrc(c.pic) : '';
      const t = pic ? '<img src="' + esc(pic) + '" alt="" loading="lazy">' : icon('image', 15);
      return '<div class="mt-i' + (i === 0 ? ' on' : '') + (c.off ? ' off' : '') + (c.sub ? ' has-sub' : '') + '" data-mi="' + i + '">'
        + '<span class="mt-t">' + t + '</span>'
        + '<span class="mt-n">@' + esc(c.name) + '</span>'
        + '<span class="mt-k">' + esc(c.meta || '') + '</span></div>';
    }).join('')
    : '<div class="mt-empty">' + (window.Chars && Chars.Lib
      ? '素材库还是空的。到「素材库」页建几条角色 / 场景 / 道具，它们就会出现在这里；已经有预览图的那几条，选中时会自动加进这一镜的参考图。'
      /* 读不到模块和「库里没东西」是两件事，不能都说成「空的」—— 前者要说清是哪儿断了 */
      : '读不到素材库模块（这一页没把 web/domain/chars.js 引进来）。刷新一次这一页；还不行就到「素材库」页确认一下它自己能不能打开。')
      + '</div>';
  /* 用 mousedown + preventDefault 而不是 click：click 之前 textarea 会先 blur，
     浮层一收这一下就落空了（经典坑）。 */
  box.querySelectorAll('[data-mi]').forEach(el => {
    const cand = cands[Number(el.dataset.mi)];
    el.onmousedown = e => {
      e.preventDefault();
      const st = mentionState;
      if (st) pickMention(st.sh, cand);
    };
    /* 二级菜单：鼠标停在这一行上就滑出来。**收的判据不靠「离开就定时收」**
       （那样会被事件顺序坑，见 scheduleHideSub），而是到点后再看一眼鼠标在哪儿。
       没有第二项可选（这一条只有一张预览图）时不弹，免得出现一个只有一项的菜单。 */
    if (cand && cand.kind === 'lib' && libPicChoices(cand.entry).length > 1) {
      el.onmouseenter = () => { clearTimeout(mentionSubTimer); showMentionSub(sh, cand, el); };
      el.onmouseleave = () => scheduleHideSub();
    } else {
      el.onmouseenter = hideMentionSub;
    }
  });
  /* 鼠标还在浮层里就别收二级菜单 */
  box.onmouseenter = () => clearTimeout(mentionSubTimer);
  box.onmouseleave = () => scheduleHideSub();
  mentionPlace(rect);
}
function mentionMove(d) {
  const st = mentionState;
  if (!st || !mentionBox || !st.cands.length) return;
  st.i = (st.i + d + st.cands.length) % st.cands.length;
  mentionBox.querySelectorAll('[data-mi]').forEach((el, i) => el.classList.toggle('on', i === st.i));
  const on = mentionBox.querySelector('.mt-i.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}
function mentionKey(sh, e) {
  if (!mentionState || !mentionBox || mentionBox.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionMove(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); mentionMove(-1); return; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(sh, mentionState.cands[mentionState.i]); return; }
  if (e.key === 'Escape') { e.preventDefault(); hideMention(); }
}
/* 每次输入 / 点一下 / 左右移动光标都重算一次：该弹就弹、不该弹就收。 */
function syncMention(sh) {
  const ta = $('edPrompt');
  if (!ta || document.activeElement !== ta) return hideMention();
  const m = mentionAt(ta);
  if (!m) return hideMention();
  const c = caretXY(ta);
  showMention(sh, mentionCands(sh, m.q), { start: m.start, end: m.end },
    { left: c.x, top: c.y, bottom: c.y + c.h });
}
/* 输入框右上角那颗 `@素材`：不打字也能打开同一份候选。
   插到光标处（框里还留着上次的光标位置）；框从来没聚焦过就追加到末尾。 */
function openMentionMenu(sh, anchor) {
  if (!sh) return;
  const ta = $('edPrompt');
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect()
    : (ta ? ta.getBoundingClientRect() : null);
  if (!rect) return;
  const m = ta ? mentionAt(ta) : null;
  showMention(sh, mentionCands(sh, ''), m ? { start: m.start, end: m.end } : null, rect);
  if (mentionState) mentionState.anchor = anchor || null;   // 再点一次那颗按钮就收起来（见绑定处）
}
/* 把 `@名字` 写进提示词：range 给了就替换掉那一段（打字触发时是 `@` 到光标），
   没给就插在当前光标处；前面挨着非空白字符时补一个空格，免得粘成一坨。
   返回插入后的光标位置（重画编辑器之后要还回去）。 */
function insertToken(ta, token, range) {
  const v = ta.value;
  let s, e;
  if (range) { s = range.start; e = range.end; }
  else if (ta.selectionStart === 0 && ta.selectionEnd === 0 && v && document.activeElement !== ta) {
    /* 框**从来没聚焦过**（一进页面就点了 `@ 素材`）：浏览器给的是 0/0，插到开头很怪，
       这种情况接在末尾。已经聚焦过再失焦时 selectionStart 是**上一次的光标位置**，照用。 */
    s = e = v.length;
  } else { s = ta.selectionStart; e = ta.selectionEnd; }
  const before = v.slice(0, s);
  const sep = (before && !/[\s\u3000]$/.test(before)) ? ' ' : '';
  const head = before + sep + token + ' ';
  ta.value = head + v.slice(e);
  return head.length;
}
/* 素材库那一条的预览图 → 这一镜的参考图。
   判据与「点参考图格子选一张」那条链**同一套**（能力声明 + 互斥 + 上限 + 去重），
   只是这里不弹选择器 —— 图片就是素材库里那一条的主图。 */
/* 这一张图在提示词里的写法 —— 它同时也是 refMeta.label、芯片上显示的那串。
   只有一份实现：`addLibPicToShot` 存的是它、`pickMention` 插进输入栏的也是它，
   两处各拼一遍迟早写成两种（那就成了「插进去的 token 与 refTokenize 认的对不上」）。 */
const libTokenOf = (name, note) => {
  const n = String(name == null ? '' : name);
  const t = String(note == null ? '' : note).trim();
  return t ? (n + '·' + t) : n;
};
/* 素材库那一条的一张图 → 这一镜的参考图。
   `pick` 不给就用它的**预览图**（token 就是素材名）；给了 `{note}` 就用二级菜单里挑中的那一张
   （token 是 `素材名·资产名`，与输入栏里写出来的、芯片上显示的完全一致）。
   判据与「点参考图格子选一张」那条链**同一套**（能力声明 + 互斥 + 上限 + 去重），
   只是这里不弹选择器 —— 图片就是素材库里那一张。 */
function addLibPicToShot(sh, entry, pick) {
  const nm = (entry && entry.name) || '这一条';
  const note = String((pick && pick.note) || '').trim();
  const label = libTokenOf(nm, note);
  const pic = (pick && pick.src) || (window.Chars ? ((Chars.refPicOf ? Chars.refPicOf(entry) : Chars.picOf(entry))) : '');
  if (!pic) {
    return { ok: false, why: note
      ? '《' + nm + '》的' + note + '还没有图'
      : '《' + nm + '》还没有预览图，先到素材库给它出一张（或自己传一张）' };
  }
  const ic = shotInputCaps(sh);
  if (!ic.ref) return { ok: false, why: '当前型号没有「参考图」这个入口' };
  if (ic.blockedRoles.has('reference_image')) return { ok: false, why: '这一镜已经选了开头 / 结尾画面，不能再加参考图（清空后才能换）' };
  sh.refImages = Array.isArray(sh.refImages) ? sh.refImages : [];
  if (sh.refImages.indexOf(pic) >= 0) return { ok: true, dup: true, label: label };
  if (sh.refImages.length >= ic.maxRef) return { ok: false, why: '参考图最多 ' + ic.maxRef + ' 张，先删掉一张再加' };
  addRefImage(sh, pic, label, entry && entry.id);
  return { ok: true, label: label };
}

/* ---- 「素材出图了 → 自动补进引用它的镜头」 ----
   拆分镜建出来的新素材在出图前，提示词里写的是占位符 `@待建:小雅`（那时还没有图可挂）。
   素材库那边把图出出来（`Chars.setPic` 投 `wb:char-pic`）之后，这里做两件事：
     ① 占位符换成真名 `@小雅` —— 于是它与库里已有的那一条**写法一致**，
        芯片、归档、`refTokenize` 那一族都认得；
     ② 把那张图挂成引用它的镜头的参考图（判据全走 `addLibPicToShot`：
        能力声明 / 互斥 / 上限 / 去重 一处都不重写）。
   挂不上就**照实说**（型号没有参考图入口、这一镜已选首尾帧、超上限…），
   不静默丢 —— 占位符**留在提示词里**，下一次还能补上。 */
window.addEventListener('wb:char-pic', e => {
  const d = e && e.detail;
  const item = d && d.item;
  if (!item || !item.name) return;
  const name = String(item.name);
  let touched = 0, pics = 0, why = '';
  /* 找出引用了这条待建素材的镜头（占位符还在的那些）。 */
  const shots = BoardAssetsOf().shotsPending(allShots(), name);
  shots.forEach(sh => {
    const resolved = BoardAssetsOf().resolve(String(sh.prompt || ''), name, name);
    sh.prompt = resolved;
    /* 提示词框显示的是「当前查看那条候选的 prompt 优先」（promptTextOf），
       与手打同一份口径（ta.oninput 同时写两处）：只写 sh.prompt 的话，框里还是
       旧的 @待建:写法，用户在框里动一下键盘就把替换结果覆盖回去了。
       只动**当前镜头**正在看的那条候选 —— 别的镜头的 curCand 下标不是它们的。 */
    if (sh === curShot()) {
      const c0 = (sh.candidates || [])[projOf().curCand];
      if (c0 && c0.prompt) c0.prompt = resolved;
    }
    touched++;
    const one = addLibPicToShot(sh, item, null);
    if (one.ok) { if (!one.dup) pics++; }
    else if (!why) why = one.why || '';
  });
  if (!touched) return;
  renderAll(); scheduleSave();
  setStatus('<span class="ok">✓ 素材「' + esc(name) + '」出图了：'
    + (pics ? '已补进 ' + pics + ' 个镜头的参考图' : '占位符已换成真名')
    + '（' + touched + ' 镜引用了它）</span>');
  if (why) Toast.warn('那张图没挂进参考图：' + why);
});
/* 选中一条候选：① 把 token 写进提示词 ② 素材库那一条顺手把图加进参考图
   （`pick` 给了就是二级菜单里挑中的那一张，没给就是预览图）。
   **token 就是 `refMeta.label`、也就是芯片上显示的那串**：挑角色资产时写 `@小雅·三视图`，
   不是光写 `@小雅` —— 光有角色名的话，输入栏里看不出引的是哪一张。
   ① 走 `dispatchEvent(new Event('input'))` —— 与手打完全同一条链（数据层 / 字数 / 按钮状态），
   不在这里另写一遍赋值。② 之后重画一次编辑器（参考图格子要出现），并把光标放回原处。 */
async function pickMention(sh, c, pick) {
  const ta = $('edPrompt');
  const st = mentionState;
  if (!c || !sh || !ta) return hideMention();
  const note = String((pick && pick.note) || '').trim();
  const token = '@' + libTokenOf(c.name, note);
  const caret = insertToken(ta, token, st && st.range);
  hideMention();
  ta.dispatchEvent(new Event('input'));
  if (c.kind !== 'lib') { window.focusQuiet(ta); try { ta.setSelectionRange(caret, caret); } catch (e) { /* 光标位置恢复不了（不是可选文本域）不影响这次输入 */ } return; }
  const r = addLibPicToShot(sh, c.entry, pick);
  renderEditor(); scheduleSave();
  const ta2 = $('edPrompt');
  if (ta2) { window.focusQuiet(ta2); try { ta2.setSelectionRange(caret, caret); } catch (e) { /* 光标位置恢复不了（不是可选文本域）不影响这次输入 */ } }
  if (r.ok && !r.dup) setStatus('<span class="ok">✓ 已把《' + esc(token) + '》加进参考图</span>');
  else if (r.dup) setStatus('《' + esc(token) + '》已经在参考图里了');
  else setStatus('<span class="warn">提示词里的 ' + esc(token) + ' 已经写上；' + esc(r.why) + '</span>');
}
/* 浮层跟着编辑器走：任何一层滚动 / 窗口变化 / 重画都先收起来，免得停在一个对不上的位置上。
   例外：**浮层与二级菜单自己内部的滚动不算** —— 它们都是 overflow-y:auto，内容长一点就会滚；
   把它一起收掉的话，鼠标在二级菜单里滚一下（或它重画时滚动位置归零）整个浮层就没了。 */
window.addEventListener('scroll', e => {
  const t = e.target;
  if (t && t.nodeType === 1
    && ((mentionBox && mentionBox.contains(t)) || (mentionSub && mentionSub.contains(t)))) return;
  hideMention();
}, true);
window.addEventListener('resize', hideMention);
document.addEventListener('mousedown', e => {
  if (!mentionBox || mentionBox.hidden) return;
  /* `@ 素材` 那颗按钮不算「外面」：它自己就是开合开关，交给它的 onclick 处理。
     二级菜单那一列也算「里面」—— 它就是浮层的一部分，点它等于点浮层。 */
  if (mentionBox.contains(e.target) || (mentionSub && mentionSub.contains(e.target)) || e.target === $('edPrompt')
    || (e.target && e.target.closest && e.target.closest('#atBtn'))) return;
  hideMention();
}, true);

/* 画「输入模式」那一排（与生成工作台同一份判据、同一套画法，样式在 ui.css 的 .mode-row / .ui-pill）：
   · 没有模式声明的家整块不出现 —— 与「这一排存在但一个芯片都没有」是两件事，后者让人以为功能坏了；
   · 只有一档时**不画芯片**（点下去什么都不变的按钮就是「看着能点、其实什么都不做」的死控件），
     但说明行照旧留着：它讲得清这一档收哪几类素材，用户知道自己被限定成了什么形状。 */
function modeChipsHTML(sh) {
  const list = shotCombos(sh);
  if (!list.length) return '';
  const cb = shotCombo(sh);
  /* 说明行与芯片一排的内容都在公共层（`comboScopeNote` / `comboChipsHTML`，与生成工作台同一份）；
     这一页只负责把它们包进自己的容器（整块编辑器每次重绘都重建这一段）。 */
  const chips = comboChips(list, sh.combo);
  return '<div class="ed-label" style="margin-top: var(--sp-12)"><span>输入模式</span><span class="cnt">'
    + esc(comboNote(cb)) + '</span></div>' + (chips ? '<div class="mode-row" id="modeRow">' + chips + '</div>' : '');
}
/* 芯片的接线：整块编辑器每次重绘都重建这一段，所以每次重画后绑一次就够了。 */
function bindModeChips(sh) {
  const row = $('modeRow');
  if (!row) return;
  row.querySelectorAll('.ui-pill').forEach(b => { b.onclick = () => setShotCombo(sh, b.dataset.cid); });
}
/* 每一镜的台词块窗口（成片秒）现算一次就留在这张表里：台词行本身不改变几何 ——
   打字时只照着它把那个读数补一遍（`paintLineWhen`），不必为一次击键把整片账重算。
   清单每次重画都重建这张表。 */
let lineGeoCache = new Map();
function lineTimeFor(geo) {
  /* geo = 这一句在成片上的那一块（待生成占位 / 配音）的 [start, duration]；
     没有块（这一镜还没进成片）传 null，读数照实写「成片 —」。 */
  return lineTimeOf(geo || null);
}
/* 台词那一档的每一行：一行 = 一镜的一句台词，读的是 sh.line / sh.lineWho 这一份数据，
   与轨道上那个待生成占位同一份账（`proj.film.pending` / `proj.film.voices` 里的定时块，
   块由 Edit 域的 syncPending 按台词现写）。时间读数 = 那一块的 [start, start+duration]，
   「行上写的秒」与「块占的那一截」永远是同一个数。
   `includeEmptyMine`：当前这一镜即使还没台词也留一行，否则「给这一镜写第一句台词」指向一片空气。 */
function linePanelRows(curSh, opts) {
  const includeEmptyMine = !!(opts && opts.includeEmptyMine);
  const lib = (window.Chars && window.Chars.Lib && window.Chars.Lib.list()) || [];
  const film = filmOf();
  /* 一镜一句台词一个块：待生成占位先占（它就是这一句台词本身），还没有占位的镜头
     退到这一镜已有的配音块 —— 一句已经合成过的台词读数跟着配音走。 */
  const blockOf = new Map();
  (film.pending || []).forEach(p => {
    if (p && p.shotId && !blockOf.has(p.shotId)) blockOf.set(p.shotId, { start: num(p.start), duration: num(p.duration) });
  });
  (film.voices || []).forEach(v => {
    if (v && v.shotId && !blockOf.has(v.shotId)) blockOf.set(v.shotId, { start: num(v.start), duration: num(v.duration) });
  });
  lineGeoCache = new Map();
  const rows = allShots().map((x, i) => ({ x: x, no: i + 1 }))
    .filter(o => (includeEmptyMine && o.x === curSh) || String((o.x && o.x.line) || '').trim())
    .map(o => {
      const geo = blockOf.get(o.x.id) || null;
      lineGeoCache.set(o.x.id, geo);
      const text = String(o.x.line || '');
      return {
        id: o.x.id, sh: o.x, no: o.no,
        text,
        who: String(o.x.lineWho || ''),
        speaker: speakerOf(o.x.lineWho, lib),
        time: lineTimeFor(geo),
        pending: !!pendingLineOf(o.x),
        empty: !text.trim(),
        mine: o.x === curSh,
      };
    });
  return rows.filter(r => r.mine).concat(rows.filter(r => !r.mine));
}
/* 说话人选项只有一份：这一档里两段可编辑的台词清单共用同一份 datalist。 */
function lineWhoDatalistHTML() {
  return '<datalist id="lineWhoList">' + ((window.Chars && Chars.Lib && Chars.Lib.list()) || [])
    .map(x => String((x && x.name) || '').trim()).filter((v, i, a) => v && a.indexOf(v) === i)
    .map(n => '<option value="' + esc(n) + '"></option>').join('') + '</datalist>';
}
/* 两段共用的行渲染：一行 = 一镜一句台词（说话人缩略图 / 名字 + 镜号 + 这一句在轨道上的时间读数）。 */
function lineRowsHTML(rows) {
  return rows.map(r => lineRowHTML(r, {
    esc: esc, icon: icon, mediaSrc: Api.mediaSrc,
    clickHint: '名字与台词直接改；点缩略图或标题切到这一镜，并把这一句填进「生成配音」',
  })).join('');
}
/* 只换一行的说话人头像：名字对上素材库就换成那一位，对不上画占位图。
   名字输入框本身就在用户手里，不重建、不回写 value（会打断输入法）。 */
function paintLineWho(row, x) {
  if (!row) return;
  const lib = (window.Chars && window.Chars.Lib && window.Chars.Lib.list()) || [];
  const sp = speakerOf(x.lineWho, lib);
  const tw = row.querySelector('.lr-thumb');
  if (tw) {
    tw.classList.toggle('ph', !sp.img);
    tw.title = sp.empty ? '未写说话人' : (sp.name + (sp.inLib ? '' : ' · 不在素材库'));
    tw.innerHTML = sp.img
      ? `<img src="${esc(Api.mediaSrc(sp.img))}" alt="" loading="lazy">`
      : `<span class="lr-ph">${icon('user', 14)}</span>`;
  }
  const inp = row.querySelector('.lr-name');
  if (inp) inp.title = '填素材库里同名的素材，音色会自动取过来' + (sp.empty ? '' : (sp.inLib ? '' : '（素材库里没有「' + sp.name + '」）'));
}
/* 只补一行右边那个时间：字数变了，待生成块要等多下一次重画才按新字数重写（syncPending），
   这里照着清单上次渲染时那份块窗口（`lineGeoCache`）就地换读数 —— 台词自己不动时间线。 */
function paintLineWhen(row, x) {
  const geo = row && lineGeoCache.get(x.id);
  if (!geo) return;
  const t = lineTimeFor(geo);
  const sp = row.querySelectorAll('.lr-when span');
  if (sp.length < 2) return;
  sp[1].textContent = t.whenText;
}
/* 台词就地编辑（这一档两段共用这一份 binder）。
   **不重画整栏**：重画会把正在敲的那一格换掉、光标跳走 —— 所以 `input` 只改数据 + 这一行的状态徽章
   与右边那个时间 + 两段表头读数，`change`（松手 / 失焦）才 `filmEdited()`：台词**自己就上待生成那一轨**
   （占位由 renderAll 现算），而字幕按台词派生、会烧进成片，所以这一改必须标脏成片并推进修订号。
   撤销快照在第一个字落下之前压（`beginEdit` 拍的是改**之前**那一份）。
   改台词一个字节都不动 `sh.prompt`：提示词改了台词不动，台词改了提示词也不动。 */
function bindLineEditors(root, curSh) {
  if (!root) return;
  /* 一行两件控件（台词在 textarea 的 data-line-text，说话人在 input 的 data-line-who），
     认镜头靠的是行上的 data-lineid（film.js 的 lineRowHTML 写的那一枚）——
     只读一件的 dataset 会让另一件写不进数据。 */
  const of = el => {
    const row = el.closest('.line-row');
    const id = (row && row.dataset.lineid) || el.dataset.lineText || el.dataset.lineWho || '';
    return allShots().find(s2 => s2.id === id);
  };
  root.querySelectorAll('[data-line-text]').forEach(ta => {
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(96, ta.scrollHeight) + 'px'; };
    grow();
    let armed = false;
    ta.oninput = () => {
      const x = of(ta);
      if (!x) return;
      if (!armed) { armed = true; beginEdit('改台词'); }
      x.line = ta.value;
      grow();
      const lrow = ta.closest('.line-row');
      if (lrow) {
        const em = lrow.querySelector('.lr-top em');
        if (em) {
          const empty = !String(x.line || '').trim();
          const pend = !empty && !!pendingLineOf(x);
          em.className = empty ? 'none' : (pend ? 'pend' : 'done');
          em.textContent = empty ? '未写' : (pend ? '待生成' : '已生成');
        }
        paintLineWhen(lrow, x);
      }
      paintLineCnts(curSh);
      scheduleSave();
    };
    ta.onchange = () => { armed = false; if (of(ta)) filmEdited(); };
  });
  /* 说话人就地写：与台词同一份理由（重画整栏会把正在敲的那一格换掉），只写数据。
     名字对上素材库时这一行的缩略图跟着换成那一位（对不上画占位图，名字照留）。
     它不改「要念的话」，所以不上成片账 —— 音色是合成那一下才进成片的。 */
  root.querySelectorAll('[data-line-who]').forEach(inEl => {
    inEl.oninput = () => {
      const x = of(inEl);
      if (!x) return;
      x.lineWho = inEl.value;
      paintLineWho(inEl.closest('.line-row'), x);
      scheduleSave();
    };
  });
  /* 点缩略图 / 标题 = 切到那一镜并把这一句填进合成框（与点轨道上那个待生成占位同一个出口，
     一个计费请求都不发：合成只在「合成并加到这一轨」那一下）。 */
  root.querySelectorAll('.line-row.edit').forEach(row => {
    const jump = e => {
      if (e.target.closest('textarea, input, button, a, .lr-ta')) return;
      const x = allShots().find(s2 => s2.id === row.dataset.lineid);
      if (x) openPendingVoice(x);
    };
    const head = row.querySelector('.lr-top');
    const th = row.querySelector('.lr-thumb');
    if (head) head.onclick = jump;
    if (th) th.onclick = jump;
  });
}
/* 两段表头读数现算（不重画清单）：只数**有字**的行，判据仍是 `pendingLineOf` ——
   与轨道上那些斜纹占位同一个口径，两处不会一个说「待生成」一个说「已生成」。
   本镜那一句还没写时直说「还没写」：拿「0 句」读数去报一个写作入口，读起来像控件坏了。 */
function lineCntTexts(sh) {
  const rows = allShots().filter(x => String((x && x.line) || '').trim());
  const mine = String((sh && sh.line) || '').trim();
  return {
    mine: mine ? mine.length + ' 字 · ' + (pendingLineOf(sh) ? '待生成' : '已生成') : '还没写',
    all: rows.length + ' 句 · 待生成 ' + rows.filter(x => !!pendingLineOf(x)).length,
  };
}
function paintLineCnts(sh) {
  const t = lineCntTexts(sh);
  const a = $('lineCntMine'); if (a) a.textContent = t.mine;
  const b = $('lineCntAll'); if (b) b.textContent = t.all;
}

function renderEditor() {
  const col = $('edCol');
  hideMention();                                  // 这一块要整片重画，@ 浮层先收掉（它挂在 body 上，不跟着换）
  hideAtPeek();                                   // 悬停小卡同理
  const sh = curShot();
  if (!sh) {
    Wb.viewport.keep(col, () => { col.innerHTML = ''; });
    /* 空项目（还没有任何镜头）时这一栏整个是空的：拆分镜恰恰常从这里发起（拆一份新的），
       问答 / 过程面板的宿主由 renderSplitPanel 自己补一块（splitUI 在跑才有），重画后也在这里拼回来。 */
    renderSplitPanel();
    return;                                         // 没有镜头先退出，别去解析模型
  }
  /* 接续镜头先确保型号能收首帧：能力槽位、素材判据与报价都读 `resolvedModel`，
     晚一步换型号就会画出「没有首帧槽、按钮却要带首帧」的一屏。 */
  const modelBefore = sh.model;
  ensureChainModel(sh);
  /* 与下面的参数回写同一把尺子：原来没存过型号 = 程序第一次挑一个能收首帧的填上，静默落盘；
     原来是用户选的那一型号被换掉 = 真的动了他的数据，进撤销栈、推进修订号，标签写明为什么换。
     以前两种都走无标签的普通 scheduleSave：接续镜一打开就先欠一枚「编辑」，Ctrl+Z 退回去
     只是把型号变回从来没选过。 */
  if (modelBefore !== sh.model) {
    if (modelBefore === undefined || modelBefore === null || modelBefore === '') scheduleSaveQuiet();
    else scheduleSave('接续型号按能力收正');
  }
  const idx = allShots().indexOf(sh) + 1;
  const chainOn = sh.linkPrev === 'tail';
  const chainSlot = chainOn && !sh.firstFrame;
  const hasPrevShot = allShots().indexOf(sh) > 0;
  const ic = shotInputCaps(sh);                      // 该模型支持的输入（决定素材/参考入口显不显示）
  const mats = mentionedMats(sh);                    // 「提到素材」那排芯片（= 带来源标签的参考图）
  const vp = videoPlanOf(sh);
  const vk = vp.kinds;
  /* 只回写**这一家声明了**的那些档（没声明时 value 是空串，写回去等于把用户存的值抹掉）。
     duration 写成数字：`sh.duration` 进提交体、进关键帧秒点、进时间线，字符串会到处要比数。
     「存的值不在声明里、被 plan 的回落收正」与「这一档从来没存过值」是两件事，分开结算：
     · 收正（原来有值）——真的动了用户存过的数据：照旧落盘、进撤销栈、推进修订号，并报清收正了什么；
     · 补齐（原来是空）——程序第一次把型号声明的默认填进来，用户一个字节都没改过：
       静默落盘（scheduleSaveQuiet），不占撤销步数、不推进助手的修订号。
       以前它走普通 scheduleSave：打开一页谁都没碰，撤销栈里就多了一枚「编辑」，
       Ctrl+Z 退回去只是把字段变回空白，助手的 CAS 也凭空看见一次「工程又改过」。 */
  const drift = [];
  const fill = [];
  const empty = v => v === undefined || v === null || v === '';
  const put = (key, next, name, asNumber) => {
    const cur = sh[key];
    if (cur === (asNumber ? Number(next) : next)) return;
    (empty(cur) ? fill : drift).push(name + ' ' + (cur === undefined ? '（没存过）' : cur) + ' → ' + next);
    sh[key] = asNumber ? Number(next) : next;
  };
  if (vk.tier.list.length) put('tier', vk.tier.value, '档位');
  if (vk.resolution.list.length) put('res', vk.resolution.value, '分辨率');
  if (vk.aspect_ratio.list.length) put('ar', vk.aspect_ratio.value, '画幅');
  /* size 是「宽x高」那一族平台用的画幅写法（SiliconFlow 的 image_size / OpenAI 兼容的 size），
     与 ar（比例）是两种字段 —— 声明了才回写、才发，没声明的这一档一个字都不带。 */
  if (vk.size.list.length) put('size', vk.size.value, '尺寸');
  if (vk.duration.list.length) put('duration', vk.duration.value, '时长', true);
  put('draw', vk.count.list.length ? vk.count.value : 1, '条数', true);
  if (drift.length) {
    scheduleSave('参数按型号声明收正');
    setStatus('「' + (sh.name || '这一镜') + '」的部分参数不在当前型号的声明里，已收正：' + drift.join('；') + '（可 Ctrl+Z 退回）');
  } else if (fill.length) scheduleSaveQuiet();
  /* 剪辑模式打开时右栏整片换成「声音栏」（用户点名的形状：像生成工作台那样合成一句配音，
     加的是剪辑那一轨）。镜头编辑器不画：两套控件同屏只会互相抢同一颗按钮。
     放在**参数回写之后**：那一串回写读的是中栏参数条的活控件，跳过它会让「改时长」在剪辑模式下静默失效。 */
  if (midEditTrimOf()) { renderVoiceCol(col, sh); return; }
  const hasDur = vk.duration.list.length > 0;
  const durMin = vk.duration.min, durMax = vk.duration.max;
  /* 能不能生成：提示词够长 + 有支持这些素材的模型 + 素材没有同时用互斥的两组 + 没有当前模型不支持的素材。
     以前只看提示词长度，非法状态也能点，点了才在后台报错。 */
  const blockWhy = shotBlockReason(sh, ic);
  const canGen = !blockWhy;
  // 素材互斥（模型声明驱动）：被挡住的槽位不能再加；两组都放了就是非法状态，生成前必须清一组
  const cNote = conflictNote(ic);
  const bFirst = ic.first && ic.blockedRoles.has('first_frame');
  const bLast = ic.last && ic.blockedRoles.has('last_frame');
  const bRef = ic.ref && ic.blockedRoles.has('reference_image');
  const bRefVideo = ic.refVideo && ic.blockedRoles.has('reference_video');
  const bRefAudio = ic.refAudio && ic.blockedRoles.has('reference_audio');
  /* 「按描述生成画面」那一档的高参：选项与上限现读**图片模型**的声明（不是这一镜视频模型的）。
     放在模板外面算，是因为摘要那一行与下面的说明句要用同一份数（抄两遍就会各说各的）。 */
  const kp = kfImgParams(sh);
  const kfRefN = (sh.refImages || []).filter(Boolean).length;
  const kfRefCap = kfRefMax(kp.model);
  const kfRefLine = kfRefCap
    ? (kfRefN
      ? '生成画面会带上这 ' + Math.min(kfRefN, kfRefCap) + ' 张参考图'
      + (kfRefN > kfRefCap ? ' · 这个生图型号一次最多收 ' + kfRefCap + ' 张，多出的 ' + (kfRefN - kfRefCap) + ' 张不带' : '')
      : '这一镜还没有参考图 · 在上面的「参考图」槽位挑几张，画面会更贴同一个形象（这个型号一次最多收 ' + kfRefCap + ' 张）')
    : (kfRefN ? '这个生图型号没有「参考图」槽位，画面只按文字生成（这一镜那 ' + kfRefN + ' 张参考图不会带上）'
      : '这个生图型号没有「参考图」槽位，画面只按文字生成');
  /* 「四档之外」那三排在这一路上到底画得出几颗（决定整块出不出现）：
     计数判据在公共层（AdvExtras.visibleCount：被形状藏掉的那一项不占数），页面不再自己数一遍。 */
  const kfExtras = kfExtrasVisible(sh);
  /* 把 plan 算好的一档画进下拉：清单、当前值、显示名、这一档出不出现，全部读 AdvParams 那一份，
     这里只写导演台自己的 DOM（整块随编辑器重绘，与工作台「控件常驻 DOM」是两种画法、同一份数）。 */
  const advSel = (k, o) => (!k || !k.on) ? ''
    : `<div><label>${esc(k.label)}</label><select id="${esc(k.id)}">${AdvParams.optionsHTML(k, o)}</select></div>`;
  /* 素材磁贴的两件属性：能不能「点击添素材」（data-slot）与那句 title。
     `ok=false` 而手上**有**素材 = 这一档不收这一类（选了「视频换人」而这一镜留着首帧图那种）：
     格子照样画出来（`.stray` 那圈警示色），只是不给添素材的入口 ——
     藏掉它等于黄条指着一条看不见、也删不掉的素材，唯一的出路变成重开工作区。 */
  const strayNote = zh => zh + '：当前这一档不收这一类素材，点 × 删掉，或换回收它的档';
  const slotAttrs = (key, ok, blocked, stray, zh) =>
    (ok ? ` data-slot="${key}"` : '')
    + (stray ? ` title="${esc(strayNote(zh))}"` : blocked ? ' title="与已选素材互斥，不能同时使用"' : '');
  /* 这一栏是整片重画的：里面 .ed-body 是一只滚动容器，重画会把它连同位置一起换掉
     （以前靠外壳那份全局猴补兜着，现已撤掉）→ 走公共件 Wb.viewport.keep，按锚点还视口。 */
  const edHtml = `
    <div class="ed-head"><b>编辑这一镜</b><span class="no">第 ${idx} 镜</span></div>
    <div class="ed-body">
      <div class="ed-label"><span>提示词</span><span><button class="at-btn" id="atBtn" type="button" title="从素材库 / 这一镜已有的参考图里挑一条写进提示词（也可以直接在框里打 @）">@ 素材</button><span class="cnt" id="pCnt">${sh.prompt.trim().length} 字</span>${promptLimitNote(sh)}<button class="ghost mini" id="pClear">清空</button></span></div>
      <div class="ta-wrap">
        <!-- 镜像层：textarea 没法给某几个字上色，所以在它下面铺一层同字号同内边距的副本，
             只给 @片段 画底（文字本身透明，看得见的还是 textarea 里那行字 ——
             中文输入法正在拼的那几个字照旧看得见）。见 atBackHTML / syncAtBack。 -->
        <div class="ta-back" id="edPromptBack" aria-hidden="true"></div>
        <textarea id="edPrompt" placeholder="描述这一镜的画面、镜头运动、氛围…（打 @ 可以引用素材库）">${esc(promptTextOf(sh))}</textarea>
      </div>
      ${/* 「提到素材」：这一镜的参考图，每张一枚芯片，写的是提交时会被平台认的 `@参考图N`
           （与参考图角标、refTokenize 同一份编号）。点一下写进提示词；鼠标移上去弹预览
           （素材名 + 图片）。⚠ 这段注释在模板串里，一个反引号都不能有。 */
        mats.length ? `
        <div class="ed-label" style="margin-top: var(--sp-10)"><span>提到素材</span><span class="cnt">点一下写进提示词</span></div>
        <div class="mchips">${mats.map(m => {
          /* 芯片上写**提示词里那个 token**：`@小雅` / `@小雅·三视图`。
             没有来源标签的（自己传的、切片生成的）才退回 `@参考图N`。
             点一下写进提示词的也是**芯片上这同一个写法**（显示与动作一致）。 */
          const tok = m.label || ('参考图' + m.n);
          const full = '@' + tok + '（第 ' + m.n + ' 张参考图）';
          return `<button class="mchip" type="button" data-mat="${esc(tok)}" title="${esc(full)}"><img src="${esc(Api.mediaSrc(m.src))}" alt="" loading="lazy"><span class="mn">@${esc(tok)}</span><span class="peek"><img src="${esc(Api.mediaSrc(m.src))}" alt=""><b>${esc(m.label || ('参考图 ' + m.n))}</b><i>@参考图${m.n}</i></span></button>`;
        }).join('')}</div>` : ''}
      <!-- 用法提示已经并进「@ 素材」那颗按钮的 title 与输入框 placeholder，这里不再重复一句 -->
      <!-- 润色按钮固定在提示词输入框左下方；结果就地展开在这行下面（不弹窗） -->
      <div class="btn-row">
        <!-- AI 润色：与三个工作台同一套动作按钮（ui.css 的 .btn-row / .tool），结果就地展开在这行下面（不弹窗） -->
        <button class="tool acc" id="polishBtn" title="调用文字 AI 改写提示词（密钥在「设置」配置）"><span class="ic">${icon('sparkles', 14)}</span>AI 润色</button>
      </div>
      <div id="polishInline" hidden></div>
      ${/* 「输入模式」：平台把「一次请求能同时用哪些素材」写在能力声明里（Capabilities.combos），
           这一排就按那份声明出现或消失。只有把素材分成互斥几档的平台才画它；没有这种声明的家
           整块不出现，槽位沿用原来的互斥置灰（与生成工作台同一套判据、同一份画法）。
           排在「画面素材」那一格标签**之前**：它管的是下面这些槽位一次收哪几类，
           放在标签后面就读成了「画面素材的一种设置」（生成工作台也是这个顺序）。 */
        modeChipsHTML(sh)}
      <div class="ed-label" style="margin-top: var(--sp-16)"><span>画面素材</span><span class="cnt">顺序即参考顺序</span></div>
      ${(sh.keyframes || []).some(k => k.status === 'failed') ? `<button class="ghost mini" id="kfClearFailed" style="margin: 0 0 var(--sp-6)">清除失败的画面（${sh.keyframes.filter(k => k.status === 'failed').length}）</button>` : ''}
      <button class="polish" id="kfGenBtn"${kfRunOf() ? ' disabled' : ''}>${icon('sparkles', 13)} ${kfRunOf() ? '生成中…' : '按描述生成这一镜的画面'}</button>
      <!-- 规划那一轮的流式面板（公共 InlinePolish.live）。它必须留在 DOM 里：
           整列每 3 秒重画一次，面板会被重新拼出来的这一块带走 —— AiStream 每次 push 前
           会确认面板还在宿主里、不在就重画一块并补回已收到的字（见那一块说明）。
           注意：这一段在模板串里，注释里不许出现星号或反引号。 -->
      <div id="kfPlanInline" hidden></div>
      <div style="display:flex;align-items:center;gap: var(--sp-8);margin: calc(-1 * var(--sp-4)) 0 var(--sp-4)">
        <select id="kfModel" style="flex:1;min-width:120px;padding: var(--sp-5) var(--sp-8);background:var(--input);border: var(--hair) solid var(--line);border-radius: var(--radius-3);color:var(--txt);font-size: var(--fs-12)">${kfModelOptions()}</select>
        <span class="hint" id="kfEst" style="margin-top:0"></span>
      </div>
      ${/* 画面生成的高级设置：与图片工作台同一套形状（折叠 + 摘要 + 按声明显隐的档位）。
           四档一个都没声明、这个型号压根不收参考图、而且「四档之外」那三排也画不出任何一项时，
           整块不出现 —— 摆一个空盒子写着「高级设置」比没有更让人以为有东西可调。
           反过来只声明了顶层开关（如 VGENV 的「平台提示词优化」）的四档全空型号，这块**必须**出现，
           否则同一个平台在视频那一面能勾、在画面生成里连入口都没有。 */
        (['quality', 'aspect_ratio', 'size', 'output_format'].some(x => kp.kinds[x].on) || kfRefCap || kfExtras)
          ? `<div class="adv${AdvParams.closed('sk_kf_adv_closed') ? ' closed' : ''}" id="kfAdvBox" style="margin: 0 0 var(--sp-10)">
        <div class="adv-head" id="kfAdvHead">
          <h2>${icon('gear', 14)} 画面高级设置</h2>
          <span class="sum"><span id="kfAdvSum">${esc(kp.summary)}</span><span class="chev">▼</span></span>
        </div>
        <div class="adv-body" id="kfAdvBody">
          <div class="adv-grid">
            ${advSel(kp.kinds.quality)}
            ${advSel(kp.kinds.aspect_ratio, { first: sh.ar ? '跟随这一镜（' + sh.ar + '）' : '' })}
            ${advSel(kp.kinds.size)}
            ${advSel(kp.kinds.output_format)}
          </div>
          ${/* 三排「AdvParams 四档之外」的声明驱动控件：画法与判据都在 gen-forms.js 的 AdvExtras，
               与上面视频那一面、与生成工作台图像栏都是同一一份。容器常驻，内容由 paintKfAdv 现画。 */ ''}
          <div class="adv-grid" id="kfBoolRows" style="margin-top: var(--sp-10)" hidden></div>
          <div class="adv-grid" id="kfTopBools" style="margin-top: var(--sp-10)" hidden></div>
          <div class="adv-grid" id="kfShapeFields" style="margin-top: var(--sp-10)" hidden></div>
          <div class="hint" id="kfRefHint" style="margin-top: var(--sp-8)">${esc(kfRefLine)}</div>
        </div>
      </div>` : ''}
      ${/* 接上一镜：开着且没有显式首帧时，提交那一刻自动取上一镜的结尾当首帧。
           这颗勾不但是入口，也是「为什么这一镜在等上一镜」的唯一解释。 */ ''}
      <label class="chain-row${chainOn ? ' on' : ''}"${hasPrevShot ? '' : ' title="这是第一个镜头，没有上一镜可接"'}>
        <input type="checkbox" id="chainPrev" ${chainOn ? 'checked' : ''} ${hasPrevShot ? '' : 'disabled'}>
        <span>接上一镜尾帧当首帧</span>
        <em>${chainOn ? (sh.firstFrame ? '已手动放了首帧，显式首帧优先' : (hasPrevShot ? '生成时自动截取上一镜结尾' : '没有上一镜可接')) : '让相邻两镜的画面连起来'}</em>
      </label>
      <div class="assets-grid">
        ${(ic.first || sh.firstFrame || chainSlot) ? `<div class="asset-slot${ic.first ? '' : ' stray'}${chainSlot ? ' chain' : ''}${bFirst ? (sh.firstFrame ? ' conflict' : ' blocked') : ''}"${chainSlot ? ' title="生成时自动截取上一镜的结尾当首帧"' : slotAttrs('first', ic.first, bFirst, !ic.first && !!sh.firstFrame, ROLE_ZH.first_frame)}>${sh.firstFrame ? `${Wb.thumbs.mediaHTML(Api.mediaSrc(sh.firstFrame), { type: 'image' })}<button class="x iconbtn on-dark" data-k="firstFrame">${icon('close', 11)}</button>` : chainSlot ? `<span class="ic">${icon('link', 16)}</span>接上一镜尾帧<span class="sub">生成时自动截取上一镜结尾</span><span class="chain-ops"><button class="ghost mini" type="button" data-chain="now">现在取帧</button><button class="ghost mini" type="button" data-chain="off">取消接续</button></span>` : `<span class="ic">${icon('image', 16)}</span>开头画面<span class="sub">首帧 · 点击选择（也可选视频取尾帧）</span>`}</div>` : ''}
        ${(ic.last || sh.lastFrame) ? `<div class="asset-slot${ic.last ? '' : ' stray'}${bLast ? (sh.lastFrame ? ' conflict' : ' blocked') : ''}"${slotAttrs('last', ic.last, bLast, !ic.last && !!sh.lastFrame, ROLE_ZH.last_frame)}>${sh.lastFrame ? `${Wb.thumbs.mediaHTML(Api.mediaSrc(sh.lastFrame), { type: 'image' })}<button class="x iconbtn on-dark" data-k="lastFrame">${icon('close', 11)}</button>` : `<span class="ic">${icon('image', 16)}</span>结尾画面<span class="sub">尾帧</span>`}</div>` : ''}
        ${(sh.keyframes || []).map((kf, i) => `
          <div class="asset-slot kf">
            ${kf.status === 'done' ? `${Wb.thumbs.mediaHTML(Api.assetSrc(kf.assetId), { type: 'image' })}<button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}">${icon('close', 11)}</button>`
              : kf.status === 'generating' ? `<span class="spin-dot"></span><span class="sub">生成中</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="停止并删掉这一张">${icon('close', 11)}</button>`
              : kf.status === 'polishing' ? `<span class="spin-dot"></span><span class="sub">润色中</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="删掉这一张">${icon('close', 11)}</button>`
              : kf.status === 'queued' ? `<span class="spin-dot" style="opacity:.45"></span><span class="sub">排队中</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="删掉这一张">${icon('close', 11)}</button>`
              : kf.status === 'failed' ? `<span class="sub err" title="${esc(kf.err || '')}">失败</span>`
                + `<button class="x iconbtn on-dark" data-retry="${i}" title="重试这一张" style="right: var(--sp-20)">${icon('refresh', 12)}</button>`
                + `<button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="删掉这一张">${icon('close', 11)}</button>`
              : `<span class="ic">${icon('image', 16)}</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="删掉这一张">${icon('close', 11)}</button>`}
            <span class="cap">画面 ${i + 1} · 第 ${kf.t} 秒</span>
          </div>`).join('')}
        ${(ic.ref || sh.refImages.length) ? sh.refImages.map((d2, i) => {
          /* 标签带上「这条参考图是哪来的」：用 @ 从素材库引来的会写 token（refMeta.label，
             挑角色资产时是 `小雅·三视图`），与提示词里那串一一对上；没有来源的（自己传的、
             切片生成的）只写序号。 */
          const lb = (Array.isArray(sh.refMeta) && sh.refMeta[i] && sh.refMeta[i].label) || '';
          const cap = '参考图 ' + (i + 1) + (lb ? ' · ' + lb : '');
          return `<div class="asset-slot" title="${esc(cap)}">${Wb.thumbs.mediaHTML(Api.mediaSrc(d2), { type: 'image' })}<button class="x iconbtn on-dark" data-k="refImages" data-i="${i}">${icon('close', 11)}</button><span class="cap">${esc(cap)}</span></div>`;
        }).join('') : ''}
        ${ic.ref && sh.refImages.length < ic.maxRef ? `<div class="asset-slot${bRef ? (sh.refImages.length ? ' conflict' : ' blocked') : ''}" data-slot="ref"${bRef ? ' title="与已选素材互斥，不能同时使用"' : ''}><span class="ic">${icon('image', 16)}</span>参考图<span class="sub">已有 ${sh.refImages.length} / ${ic.maxRef} 张</span></div>` : ''}
      </div>
      ${cNote ? `<div class="hint conflict-hint" id="conflictHint">${cNote}</div>` : ''}
      ${/* 「没有素材槽」有两种原因，得说清是哪一个：这个型号压根不收参考素材，
           还是这一镜选的这一档本来就不用素材（选了「视频换人」以外不带素材的那一档）。
           把后者说成「模型不支持」是替型号编了一句它没说过的话。 */
        ic.none ? (shotCombo(sh)
          ? `<div class="hint">输入模式「${esc(comboLabel(shotCombo(sh)))}」不用参考素材</div>`
          : '<div class="hint">当前型号不支持参考素材</div>') : ''}
      ${(ic.refVideo || sh.refVideo) ? `<div class="slot-wide asset-slot${sh.refVideo ? ' has-media' : ''}${ic.refVideo ? '' : ' stray'}${bRefVideo ? (sh.refVideo ? ' conflict' : ' blocked') : ''}"${slotAttrs('refvideo', ic.refVideo, bRefVideo, !ic.refVideo && !!sh.refVideo, ROLE_ZH.reference_video)}>
        ${sh.refVideo ? `${refVideoThumbSrc(sh.refVideo) ? `<span class="rvthumb">${Wb.thumbs.mediaHTML(refVideoThumbSrc(sh.refVideo))}</span>` : `<span class="ic">${icon('film', 16)}</span>`}<span class="rvmeta"><b>${esc(sh.refVideo.name || '参考视频')}</b><span>参考视频 · 已上传${sh.refVideo.duration ? ' · ' + sh.refVideo.duration + 's' : ''}</span></span><button class="x iconbtn on-dark" data-k="refVideo">${icon('close', 11)}</button>` : `<span class="ic">${icon('film', 16)}</span>参考视频（可选）<span class="sub">沿用这段视频的运镜和节奏${ic.slotNote('reference_video') ? ' · ' + esc(ic.slotNote('reference_video')) : ''}</span>`}
      </div>` : ''}
      ${(ic.refAudio || sh.refAudio) ? `<div class="slot-wide asset-slot${ic.refAudio ? '' : ' stray'}${bRefAudio ? (sh.refAudio ? ' conflict' : ' blocked') : ''}"${slotAttrs('refaudio', ic.refAudio, bRefAudio, !ic.refAudio && !!sh.refAudio, ROLE_ZH.reference_audio)}>
        ${sh.refAudio ? `<span>${esc(sh.refAudio.name)}（已上传）</span><button class="x iconbtn on-dark" data-k="refAudio">${icon('close', 11)}</button>` : `<span class="ic">${icon('mic', 16)}</span>参考音频（可选）<span class="sub">沿用节奏${ic.slotNote('reference_audio') ? ' · ' + esc(ic.slotNote('reference_audio')) : ''}</span>`}
      </div>` : ''}
      <div class="adv${AdvParams.closed('sk_dir_adv_closed') ? ' closed' : ''}" id="advBox" style="margin-top: var(--sp-16)">
        <div class="adv-head" id="advHead">
          <h2>${icon('gear', 14)} 高级设置</h2>
          <span class="sum"><span id="advSum">${esc(vp.summary)}</span><span class="chev">▼</span></span>
        </div>
        <div class="adv-body" id="edAdvBody">
          <div class="adv-grid">
            <div><label>型号</label><select id="edModel">${modelOptionsFor(sh)}</select></div>
            ${advSel(vk.tier)}
            ${advSel(vk.aspect_ratio)}
            ${advSel(vk.resolution)}
            ${advSel(vk.size)}
            ${advSel(vk.count)}
          </div>
          ${/* 程序为接续换的那一型要写明「不是用户挑的」：不写的话，换镜头回来看到型号变了会以为是页面乱跳。 */ ''}
          ${sh.modelAuto === 'chain' && !chainModelWhy(sh) ? `<div class="hint">已自动切到 ${esc((resolvedModel(sh) || {}).name || sh.model)}（${sh.linkPrev === 'tail' ? '接上一镜尾帧' : '按接续型号拆分长镜头'}）</div>` : ''}
          ${hasDur ? `<label>${esc(vk.duration.label)}（${durMin}–${durMax} 秒，按型号支持范围限制）</label>
          <div class="row">
            <input type="range" class="dur-range" id="durRange" min="${durMin}" max="${durMax}" step="1" value="${sh.duration}">
            <div class="dur-num">
              <input type="number" id="durNum" min="${durMin}" max="${durMax}" step="1" value="${sh.duration}">
              <span>秒</span>
            </div>
          </div>` : ''}
          ${/* 三排「AdvParams 那几档之外」的声明驱动控件（型号布尔参数 / 提交体顶层开关 / 提交体顶层非布尔字段）。
               画法与判据都在 gen-forms.js 的 AdvExtras，与生成工作台是同一一份 ——
               导演台以前整块没有它们，于是同一个平台在工作台能勾「Turbo 加速档」「平台自动润色」，
               在这一镜上连控件都不画、提交体里一个字都不发。容器常驻，内容由 paintShotAdv 现画。 */ ''}
          <div class="adv-grid" id="edBoolRows" style="margin-top: var(--sp-10)" hidden></div>
          <div class="adv-grid" id="edTopBools" style="margin-top: var(--sp-10)" hidden></div>
          <div class="adv-grid" id="edShapeFields" style="margin-top: var(--sp-10)" hidden></div>
        </div>
      </div>
      ${window.RawRequest ? RawRequest.liveHTML('dir:shot:' + sh.id) : ''}
    </div>
    <!-- 动作行在 .ed-body 之外（#edCol 钉底的那一块）：表单再长，「生成这一镜」也悬在右栏底部 -->
    <div class="ed-footer">
      <span class="can ${canGen ? '' : 'no'}" id="edFooterCan"${blockWhy ? ` title="${esc(blockWhy)}"` : ''}>${footerCanText(canGen, blockWhy)}</span>
      <span class="est" id="estTxt">估价中…</span>
      <button class="pri" id="genOne" ${canGen && !genOneBusy ? '' : 'disabled'}>${genOneBusy ? '创建中…' : GenOf().genBtnLabel(sh)}</button>
    </div>`;
  Wb.viewport.keep(col, () => { col.innerHTML = edHtml; });
  /* 面板里的素材缩略图（首帧 / 尾帧 / 关键帧 / 参考图）也接公共缓存：图片按原图渐进显示，
     加载完顺手缩一份进缓存，之后任何页面渲染同一份素材都直接命中（见 workbench.js 的 Wb.thumbs） */
  Wb.thumbs.bindAll(col);
  if (window.RawRequest) RawRequest.bind(col);
  /* 右栏画完立刻算一次「将要发出的请求体」：用户还没点生成就能看到实际会发什么。
     算不出来时 RawRequest 那边保持上一份（不显示空 JSON）。 */
  refreshShotPreview(sh);
  /* 「输入模式」那一排芯片接线（整块编辑器每次重绘都重建这一段，所以每次绑一次，不会越攒越多）。 */
  bindModeChips(sh);
  /* 三排声明驱动的额外参数（型号布尔 / 顶层开关 / 顶层非布尔字段）在这里现画：
     整块编辑器每次重绘都重建 DOM，所以不需要工作台那套指纹守卫，但**画法与判据是同一份**（AdvExtras）。 */
  paintShotAdv(sh, edModelChanged);
  edModelChanged = false;
  /* 摘要里那句「顶层参数」必须在三排**画完之后**再读：模板串拼的时候 #edAdvBody 还是上一镜的那一份，
     在拼串时读 DOM 等于把 A 镜的开关状态写成 B 镜的摘要。 */
  const advSumEl = $('advSum');
  if (advSumEl) advSumEl.textContent = advSumText(sh);
  paintKfAdv(sh, kfModelChanged);
  kfModelChanged = false;
  const kfSumEl = $('kfAdvSum');
  if (kfSumEl) kfSumEl.textContent = kfAdvSumText(sh);
  /* 右栏原来这里有一个「从资产库导入」按钮（把素材一次性塞进参考图 / 参考视频），已按要求去掉：
     素材入口在上面的参考图 / 首帧 / 尾帧 / 参考视频 / 参考音频各槽位上（点开就是同一个选择器），
     不再有一个「全塞进去」的第二入口。 */
  refreshEst();   // 每次重渲染刷新费用预估
  // 事件
  const edArEl = $('edAr'); if (edArEl) edArEl.onchange = e => { sh.ar = e.target.value; renderMid(); scheduleSave('改画幅'); refreshShotPreview(sh); };
  const edResEl = $('edRes'); if (edResEl) edResEl.onchange = e => { sh.res = e.target.value; scheduleSave('改分辨率'); refreshShotPreview(sh); };
  /* 尺寸档只有这一家声明了才画出来（advSel 判 `k.on`），所以这里同样是「有节点才接线」。 */
  const edSizeEl = $('edSize'); if (edSizeEl) edSizeEl.onchange = e => { sh.size = e.target.value; scheduleSave('改尺寸'); refreshShotPreview(sh); };
  /* 条数下拉在「这个型号一次只能出一条」时根本不画（与工作台同一判据，见 AdvParams.plan 的 many），
     所以这里不能像以前那样裸用 `$('edDraw').onchange` —— 那是 TypeError。 */
  const edDrawEl = $('edDraw'); if (edDrawEl) edDrawEl.onchange = e => {
    sh.draw = Math.max(1, parseInt(e.target.value, 10) || 1);
    scheduleSave('改条数');
    refreshShotPreview(sh);   // 「将要发出的请求」跟着条数走（面板的意义就是核对）
    renderEditor();      // 让右下角「生成这一镜（N 条）」按钮同步条数
    updateBanner();      // 横幅提示同步
  };
  const edTierEl = $('edTier'); if (edTierEl) edTierEl.onchange = e => { sh.tier = e.target.value; scheduleSave('改档位'); refreshShotPreview(sh); };
  /* 分辨率 / 比例 / 尺寸改动后要重算报价（edTier、edDraw 上面各自已有 onchange，这里只管这几个） */
  ['edRes', 'edAr', 'edSize'].forEach(id2 => {
    const el2 = col.querySelector('#' + id2);
    if (el2) el2.addEventListener('change', () => { refreshEst(); updateBanner(); });
  });
  // 生成参数卡片：折叠 / 展开 + 摘要跟随参数（外壳在公共层，摘要文本见上面的 advSumText —— 四档 + 三排同源）
  const updateAdvSum = () => {
    const sum = $('advSum');
    if (sum) sum.textContent = advSumText(sh);
  };
  const advHeadEl = $('advHead'), advBoxEl = $('advBox');
  if (advHeadEl && advBoxEl) {
    AdvParams.fold(advHeadEl, advBoxEl, 'sk_dir_adv_closed');
    ['edAr', 'edRes', 'edSize', 'edDraw', 'edTier', 'edModel'].forEach(id2 => {
      const el2 = $('' + id2);
      if (el2) el2.addEventListener('change', updateAdvSum);
    });
    const dr = $('durRange'), dn = $('durNum');
    if (dr) dr.addEventListener('change', updateAdvSum);
    if (dn) dn.addEventListener('change', updateAdvSum);
  }
  $('edModel').onchange = async e => {
    sh.model = e.target.value;
    /* 用户手选 = 这一型从今往后由用户负责：接续的自动切换不再覆盖它；
       它不支持首帧时由 `chainModelWhy` 明确拦住，不偷偷换回去。 */
    sh.modelAuto = '';
    edModelChanged = true;                // 换型号那一次，型号布尔那一排按**新声明**的默认值重画
    /* 每次换模型都回源一次能力接口，再按拿到的最新能力纠正参数 —— 上层把模型
       的分辨率 / 时长 / 张数改了、或加了新的输入槽位，界面跟着变，不用改代码。 */
    setStatus('正在读取型号能力…');
    const caps = await refreshCapsForModel((resolvedModel(sh) || {}).provider);
    if (caps) setStatus(caps.source === 'api' ? '✓ 已按上游接口更新型号能力' : '按平台声明展示型号能力');
    /* 换模型后「这一档在新模型上不存在」的纠正不在这里做：renderEditor 里的 AdvParams.plan
       就是那份回落（这里以前自己写了一遍 resolutions/tiers/aspect_ratios/durations/max_outputs
       的逐项纠正，写法与下拉画出来那一份、发出去那一份是三套 —— 现在同一判据只走 plan 一次）。 */
    renderEditor(); renderMid(); scheduleSave('换型号'); refreshShotPreview(sh);
  };
  const ta = $('edPrompt');
  ta.oninput = () => {
    const d0 = curDraftCand();
    const hadText = !!(d0 ? d0.prompt : sh.prompt).trim();
    /* 三处一起写，各管各的事，**不是三份实现**：
         · 当前查看的这条候选 —— 「这条是用哪句话生成的」，回头点它还能看见（本轮用户要的）；
         · `sh.prompt` —— 这一镜的描述：左栏卡片、底部「为什么还不能生成」、批量生成都读它；
         · 界面（字数 / 按钮 / 左栏卡片）—— 见下面那几行。
       以前只写「草稿 or sh.prompt」其中之一：草稿分支不写 sh.prompt，
       于是新建一镜写完描述、直接点「生成全部分镜」会报「这一镜还没有画面描述」；
       真实候选分支不写候选，于是那条候选的描述一旦被改就再也回不去。 */
    const c0 = (sh.candidates || [])[projOf().curCand];
    if (c0) c0.prompt = ta.value;
    sh.prompt = ta.value;
    $('pCnt').textContent = ta.value.trim().length + ' 字';
    edPromptTouched = true;                     // 用户开始动手，之后卡住的原因才实时显示在底部
    /* 按钮与底部那一行走公共判据（`syncGenGate` → `shotBlockReason`），不在这里只问「描述非空」：
       以前这里写成 `!!ta.value.trim()`，于是「视频换人」那一档只要敲完描述，
       「生成这一镜」就自己点亮、底部打勾，点下去才拿到平台那句 422。 */
    syncGenGate(sh);
    // 左栏卡片只在「有/无描述」翻转时才需要重画，不必每敲一个字重建整列
    if (!d0 && hadText !== !!ta.value.trim()) renderScenes();
    scheduleSave('改描述');
    syncMention(sh);                            // @ 引用素材库的候选浮层（见上面那一段）
    syncAtBack(sh);                             // @片段 的高亮镜像层（见 atBackHTML）
    /* 「将要发出的请求」跟着改：提示词是请求体里最重要的一项，
       用户改一个字就该看见要发出去的正文也变了（去抖在 RawRequest.schedule 里）。 */
    refreshShotPreview(sh);
  };
  /* @ 候选浮层：方向键 / 回车 / Esc 都在它里面消化；左右移动光标也要重算一次（可能刚好走进/走出 @ 片段） */
  ta.onkeydown = e => mentionKey(sh, e);
  ta.onkeyup = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncMention(sh); };
  ta.onclick = () => syncMention(sh);
  /* 镜像层与悬停小卡：框内滚动时要跟着走，否则高亮会停在错位的行上 */
  ta.onscroll = () => { const b = $('edPromptBack'); if (b) b.scrollTop = ta.scrollTop; };
  ta.onmousemove = e => hoverAt(sh, e);
  ta.onmouseleave = hideAtPeek;
  syncAtBack(sh);
  $('pClear').onclick = () => {
    /* 显示读的是「当前候选的 prompt 优先」（promptTextOf），只清草稿或只清 sh.prompt
       都清不掉一条已提交候选的描述 —— 三处同口径一起清。 */
    const c = (sh.candidates || [])[projOf().curCand];
    if (c) c.prompt = '';
    sh.prompt = '';
    setPolishUI(null);                                   // 清空提示词同时也收起润色面板
    renderEditor(); renderScenes(); scheduleSave();
  };
  /* 输入框右上角的 `@ 素材`：打开同一份候选浮层（不打字也能挑）；再点一次收起来 */
  const atBtn = $('atBtn');
  if (atBtn) atBtn.onclick = () => {
    if (mentionState && mentionState.anchor === atBtn) hideMention();
    else openMentionMenu(sh, atBtn);
  };
  /* 「提到素材」那排芯片：点一下把 @名字 写进提示词（插在光标处），走与手打同一条 input 链 */
  col.querySelectorAll('[data-mat]').forEach(b => b.onclick = e => {
    e.preventDefault();
    const ta0 = $('edPrompt');
    if (!ta0) return;
    const caret = insertToken(ta0, '@' + b.dataset.mat, null);
    window.focusQuiet(ta0);
    try { ta0.setSelectionRange(caret, caret); } catch (e2) { /* 光标位置恢复不了（不是可选文本域）不影响这次输入 */ }
    ta0.dispatchEvent(new Event('input'));
  });
  const clampDur = v => Math.max(durMin, Math.min(durMax, Math.round(parseFloat(v) || durMin)));
  /* 拖时长滑块：每变一个档位就发一次报价请求（注册表里有 4 家声明 pricing.type==='quote'，
     请求超时 15 秒），而 `estimateCost` 的 quote 分支只用 QUOTE_INFLIGHT 做**并发**去重、
     finally 里就 delete —— **没有结果缓存**，同一个取值再拖回来照样重新发包。
     型号典型区间 4~12 秒 → 一次完整拖拽最多 9 个不同取值 = 最多 9 次报价。
     这里只把「报价 + 关键帧估价」加防抖；`scheduleSave()` 自己的 500ms 防抖**有语义**
     （撤销栈基线在里面比），绝不能一起防抖掉，所以它照旧逐档调用。 */
  const estSlide = debounce(() => { refreshEst(); refreshKfEst(); }, 200);
  const durRangeEl = $('durRange'), durNumEl = $('durNum');
  if (durRangeEl) durRangeEl.oninput = e => {
    sh.duration = clampDur(e.target.value);
    if (durNumEl) durNumEl.value = sh.duration;
    scheduleSave('改时长'); refreshShotPreview(sh); estSlide(); updateBanner();
  };
  if (durRangeEl) durRangeEl.onchange = () => { renderMid(); };   // 松手后同步时间线（重建播放器）
  /* 模型没声明时长范围（hasDur=false）时这两行控件根本不在 DOM 里：
     以前这里裸用 $('durNum').oninput，$('durNum') 是 null → TypeError →
     renderEditor() 从这里中断，后面的「生成这一镜」、素材槽位、润色按钮全都没绑定，右栏瘫痪。 */
  if (durNumEl) durNumEl.oninput = e => {
    sh.duration = clampDur(e.target.value);
    if (durRangeEl) durRangeEl.value = sh.duration;
    scheduleSave('改时长'); refreshShotPreview(sh); estSlide(); updateBanner();
  };
  if (durNumEl) durNumEl.onchange = () => { durNumEl.value = sh.duration; renderMid(); };
  $('polishBtn').onclick = polishPrompt;
  renderPolishPanel(sh);        // 润色面板（若这一镜有未处理的润色结果，重渲染后重新画出来）
  /* 拆分镜 / 改分镜的问答与过程面板（splitUI 在 apply 域）：它在跑时宿主归它 ——
     上面那颗润色面板一看 polishUI 为空就把宿主 clear 掉了，这里紧跟着按 splitUI 拼回来；
     两边都没在跑时它什么都不画，宿主保持清空。 */
  renderSplitPanel();
  $('kfGenBtn').onclick = () => generateKeyframes(sh);
  const clrFailed = $('kfClearFailed');
  if (clrFailed) clrFailed.onclick = () => {
    const keep = [];
    (sh.keyframes || []).forEach(kf => {
      if (kf.status !== 'failed') { keep.push(kf); return; }
      if (kf.assetId) {
        const src = Api.assetSrc(kf.assetId);
        const ri = (sh.refImages || []).indexOf(src);
        if (ri >= 0) removeRefImage(sh, ri);
      }
    });
    sh.keyframes = keep;
    renderEditor(); scheduleSave();
    setStatus('<span class="ok">✓ 已清除失败的画面</span>');
  };
  /* 画面高参的四档：控件按型号声明渲染，**可能整块不在 DOM 里**（这个型号什么都没声明）。
     以前这里裸用 `$('kfQuality').onchange` —— 与上面 durNum 踩过的那个坑同一个：
     控件不在就是 null，TypeError 让 renderEditor 从这一行中断，
     「生成这一镜」、素材槽位、润色按钮一个都绑不上。 */
  [['kfQuality', 'q'], ['kfArOf()', 'ar'], ['kfSizeOf()', 'size'], ['kfFormatOf()', 'fmt']].forEach(pair => {
    const el = $(pair[0]);
    if (!el) return;
    el.onchange = () => {
      if (pair[1] === 'q') setKfQ(el.value);
      else if (pair[1] === 'ar') setKfAr(el.value);
      else if (pair[1] === 'size') setKfSize(el.value);
      else setKfFormat(el.value);
      kfParamsSave();
      refreshKfEst();
      const sum = $('kfAdvSum'); if (sum) sum.textContent = kfAdvSumText(sh);
    };
  });
  /* 折叠状态记住（外壳与键的读写都在公共层，与图片台 `studio_adv_closed` 同一份实现）：
     右栏每次切镜头都重建这一块，不记住的话每次都得重新点开一遍才能看到摘要以外的那几档。 */
  const kfAdvHeadEl = $('kfAdvHead'), kfAdvBoxEl = $('kfAdvBox');
  if (kfAdvHeadEl && kfAdvBoxEl) AdvParams.fold(kfAdvHeadEl, kfAdvBoxEl, 'sk_kf_adv_closed');
  $('kfModel').onchange = async () => {
    setKfModelId($('kfModel').value);
    kfModelChanged = true;                              // 型号布尔那一排按**新声明**的默认值重画
    window.LS.set('sk_kf_model', kfModelIdOf());          // 记住选择，换镜头也保持
    setStatus('正在读取型号能力…');
    await refreshCapsForModel((kfModelOf().prov || {}).id);   // 画面模型同样回源一次能力接口
    /* 四档的取值与默认值不在这里再判一次：renderEditor 重建这些下拉时 kfImgParams 会按新模型的
       声明把每个值校正到有效档位（以前这里又抄了一份兜底表，两处各写 'standard'，改一处漏一处）。 */
    renderEditor();                                   // 重建高参（跟随新模型能力）
    setStatus('画面型号已切换：' + (kfModelOf().model?.name || kfModelIdOf()));
  };
  refreshKfEst();

  $('genOne').onclick = async () => {
    if (genOneBusy) return;                              // 提交窗口期再点直接忽略（见 genOneBusy 的注释）
    genOneBusy = true;
    const draft0 = curDraftCand();
    try {
      $('genOne').disabled = true; $('genOne').textContent = '创建中…';
      /* 这一镜已经有视频（在跑 / 已成）时再点生成 = 「再来一版」：在当前场景这一镜之后
         自动开一条新镜头，占位与任务都落在它上面（判据只有 shotHasVideo 一份，
         按钮文案 genBtnLabel 读的也是它）。全新镜头两条路不变：草稿就地生成、没候选的直接画。 */
      if (GenOf().shotHasVideo(sh)) {
        const ns = GenOf().spawnCandidateShot(sh);
        await GenOf().drawShot(ns, ns.draw || 1);
        setStatus('<span class="ok">✓ 这一镜已有视频：已在当前场景新建「' + esc(ns.name) + '」，这次生成挂在它上面（占位看它的候选条）</span>');
      } else if (draft0) {
        await generateCandidate(draft0);                 // 空草稿：按右栏写的描述生成这一条
      } else {
        /* 传提示词框**正显示**的那一句（翻看候选时是那条候选的描述）：框、预览、请求体同一句。 */
        await GenOf().drawShot(sh, sh.draw || 1, promptTextOf(sh));
      }
      renderAll(); loadCredits();
    } catch (e) {
      setStatus('<span class="err">创建失败：' + e.message + '</span>');
    } finally {
      genOneBusy = false;
      renderEditor();
    }
  };
  /* 接上一镜：勾上时若当前型号接不了首帧，这一下就替用户换成能接的（用户要的就是「自动切过去」）；
     关掉时只清接续，不动型号与已放的显式首帧。 */
  const chainEl = $('chainPrev');
  if (chainEl) chainEl.onchange = () => {
    sh.linkPrev = chainEl.checked ? 'tail' : '';
    if (sh.linkPrev) {
      const cur = chainModelList().find(m => m.id === sh.model);
      if (cur && !cur.first) sh.model = '';      // 明确接不了 → 允许 ensureChainModel 重挑
      ensureChainModel(sh);
    } else {
      sh.modelAuto = '';
    }
    renderEditor(); scheduleSave(); updateBanner();
  };
  // 只给「当前模型支持且已渲染」的槽位绑事件
  col.querySelectorAll('.asset-slot').forEach(slot => {
    /* 接续占位上的两颗按钮（只有 chainSlot 时才会画出来）：
       「现在取帧」把上一镜结尾当场取成显式首帧；「取消接续」只关接续，不碰别的。 */
    slot.querySelectorAll('[data-chain]').forEach(btn => btn.onclick = async e => {
      e.stopPropagation();
      if (btn.dataset.chain === 'off') {
        sh.linkPrev = '';
        sh.modelAuto = '';
        renderEditor(); scheduleSave(); updateBanner();
        return;
      }
      btn.disabled = true;
      try {
        setStatus('正在截取上一镜尾帧…');
        const f = await resolveChainFrame(sh);
        sh.firstFrame = f.src;
        renderEditor(); scheduleSave();
        setStatus('<span class="ok">✓ 已把' + f.from + '作为开头画面</span>');
      } catch (err) {
        btn.disabled = false;
        setStatus('<span class="err">' + err.message + '</span>');
      }
    });
    const k = slot.dataset.slot;
    // 单张画面重试（失败的画面直接再生成一次）
    slot.querySelectorAll('[data-retry]').forEach(btn => btn.onclick = async e => {
      e.stopPropagation();
      const i = +btn.dataset.retry;
      const kf = (sh.keyframes || [])[i];
      if (!kf) return;
      const pick = kfModelOf();
      if (!pick.prov || !pick.model) { setStatus('<span class="err">没有可用的图片型号</span>'); return; }
      btn.textContent = '…'; btn.disabled = true;
      kf.status = 'generating'; kf.err = null; renderEditor();
      try {
        const prompt = (kf.imgPrompt || (sh.prompt + '，第 ' + kf.t + ' 秒的关键画面'));
        const notes = [];
        const refs = await kfRefEntries(sh, t => notes.push(t));
        if (notes.length) setStatus('<span class="err">' + esc(notes.join('；')) + '</span>');
        const aid = await genOneImage(pick.prov, pick.model, prompt, kfGenOpts(sh, { inputEntries: refs, at: kf.t }));
        kf.assetId = aid; kf.status = aid ? 'done' : 'failed';
        if (aid) addKeyframeToRefs(sh, aid, kf, i);
        setStatus('<span class="ok">✓ 画面 ' + (i + 1) + ' 重新生成成功' + (notes.length ? '（' + esc(notes.join('；')) + '）' : '') + '</span>');
      } catch (e2) { kf.status = 'failed'; kf.err = e2.message; setStatus('<span class="err">重试失败：' + e2.message + '</span>'); }
      renderEditor(); scheduleSave();
    });
    slot.querySelectorAll('.x').forEach(x => {
      if (x.hasAttribute('data-retry')) return;   // 重试按钮不参与删除
      x.onclick = e => {
        e.stopPropagation();
        const kk = x.dataset.k, i = x.dataset.i;
        if (kk === 'refImages') removeRefImage(sh, +i);
        else if (kk === 'refVideo') sh.refVideo = null;
        else if (kk === 'refAudio') sh.refAudio = null;
        else if (kk === 'keyframes') {
          const kf = (sh.keyframes || [])[+i];
          if (!kf) return;
          if (kf.assetId) {
            const src = Api.assetSrc(kf.assetId);
            const ri = (sh.refImages || []).indexOf(src);
            if (ri >= 0) removeRefImage(sh, ri);
          }
          if (kfRunOf() && (kf.status === 'generating' || kf.status === 'queued')) {
            kf.deleted = true;   // 生成进行中：先标记，生成循环会跳过并在结束后移除
            setStatus('这一张已标记删除（正在生成，结束后自动移除）');
          } else {
            (sh.keyframes || []).splice(+i, 1);
          }
          renderEditor(); scheduleSave();
        }
        else sh[kk] = null;
        renderEditor(); scheduleSave();
      };
    });
    if (!k) return;
    // 与已选素材互斥的槽位：点不开选择器（先清空另一组才能加），小 × 仍可删除已放的素材
    // data-slot 是 HTML 属性（全小写），SLOT_ROLE 的键跟 canAddSlot 调用方一致（驼峰）；
    // 以前这里直接拿 dataset 的原值查表，参考视频/参考音频永远查不到 role → 互斥根本拦不住。
    const slotKey = { refvideo: 'refVideo', refaudio: 'refAudio' }[k] || k;
    if (ic.blockedRoles.has(SLOT_ROLE[slotKey])) {
      slot.onclick = () => flashConflict(cNote || '该素材与已选素材互斥，不能同时使用');
      return;
    }
    // 所有槽位都只走同一份选择器（本地文件在它顶部的「本地上传」档位里）
    if (k === 'first' || k === 'last' || k === 'ref') slot.onclick = () => openPickDlg(sh, k);
    else slot.onclick = () => pickRefMedia(sh, k);
  });
  // 高参设置里的下拉：交给 web/ui/ui.js 的自定义组件渲染（与图片工作台同一套外观）
  if (window.Dropdowns) { Dropdowns.build(col); Dropdowns.sync(col); }
}

/* 一家能力落定就补画一次右栏（300ms 去抖，把同时落定的几家合成一遍）：
   「将要发出」那一栏不再等所有在用的平台都回来 —— 上游慢的那一家只拖自己那栏。
   兜底的 `.then` 照留：能力全落定后再补最后一遍。
   挂在作用域岛的 winProxy 上（经 index.js 的 add() 转发到真 window）：
   切走后 active 闸不响，离屏的导演台不为后台事件重画。 */
function installCapRepaint() {
  let capReadyT = 0;
  window.addEventListener('wb:cap-ready', () => {
    if (!wsLoadedOf()) return;
    clearTimeout(capReadyT);
    /* 走 renderSoft（['edit']）：正在右栏打字时先不重建（重建会把输入框换掉、
       焦点与光标全丢 —— renderSoft 那道闸就是为这一条立的），失焦再补。
       以前直接调 renderEditor，绕过了那道闸。 */
    capReadyT = setTimeout(() => { try { renderSoft(['edit']); } catch { /* 补画抛错不打断别的 */ } }, 300);
  });
  Capabilities.load(REGOf()).then(() => { try { renderSoft(['edit']); } catch { /* 首屏重画抛错不打断后面的恢复流程 */ } }).catch(() => {});
}

  return {
    installCapRepaint,
    shotModels,
    resolvedModel,
    SLOT_ROLE,
    ROLE_ZH,
    comboLabel,
    shotUsedRoles,
    shotCombo,
    shotInputCaps,
    shotAdvCtx,
    shotAdvExtras,
    videoPlanOf,
    shotKeyframes,
    shotInputEntries,
    NO_PROMPT_WHY,
    shotBlockReason,
    syncGenGate,
    canAddSlot,
    provOf,
    needProv,
    addRefImage,
    backfillRefMetaIds,
    syncAtBack,
    libPicChoices,
    addLibPicToShot,
    linePanelRows,
    lineWhoDatalistHTML,
    lineRowsHTML,
    bindLineEditors,
    lineCntTexts,
    renderEditor,
  };
}
