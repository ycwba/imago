/* 候选镜头的语义：一镜 = 一组候选镜头。
   每条候选自带**一整套拍摄配置**（型号 / 档位 / 画幅 / 时长 / 参考文件 / 关键帧 / 接续标记）
   与**一句自己的提示词** —— 镜头本身只留这一镜的公共信息（名字 / 台词 / 说明 / 张数）。
   「画面」这一层已经退役：以前 sh.prompt 是画面基准、候选可写 null 表示沿用它，
   现在每条候选都只管自己那份描述，谁也不回落到谁。
   写入一律拿候选对象定位，不按下标 —— 排序或并发之后下标会指到别人身上。 */

export const TAKE_ORIGINS = ['auto', 'manual', 'imported'];

/* 一条候选身上的「拍摄配置」字段：新建、克隆、形状转换都照这一份清单走。
   dur 是**请求**的时长；duration 是产物的实际时长（两件事，不共用一个字段）。 */
export const TAKE_CFG_KEYS = ['model', 'modelAuto', 'tier', 'res', 'ar', 'size', 'dur',
  'refImages', 'refMeta', 'refVideo', 'refAudio', 'keyframes', 'combo',
  'firstFrame', 'lastFrame', 'linkPrev'];

/* 形状转换时，候选字段从镜头级的哪个旧字段取：`dur` 的旧名是 `duration`
   （请求时长与产物时长从此不再共用一个字段）。 */
const CFG_FROM_SHOT = { dur: 'duration' };

/* 缺 origin 的候选（旧数据或半路建出来的）按状态补一个：
   草稿当成用户自己加的，其余当成导入的成品。 */
export function originOf(c) {
  if (c && TAKE_ORIGINS.includes(c.origin)) return c.origin;
  return c && c.status === 'draft' ? 'manual' : 'imported';
}

/* 候选按创建时间先后（接续取尾帧、克隆取源都要一个**稳定**的顺序 ——
   候选数组的排序会随生成结果重排，按数组顺序取会跟着漂）。 */
export function byCreated(a, b) {
  return (Number(a && a.created) || 0) - (Number(b && b.created) || 0);
}

/* 配置持有者：**候选本身**。
   给到镜头时按「当前查看的那条候选」算 —— 一镜下面是一排候选镜头，每条自带描述与配置，
   右栏那一栏编辑的就是当前这条；给到候选时就是它自己（批量那条路直接递候选）。
   这一条是「读配置」与「读镜头身份」的分界：配置一律问它，身份（id / 名字 / 台词 / 候选表）问镜头。 */
export function cfgOf(x, curIdx) {
  if (!x) return null;
  if (Array.isArray(x.candidates)) {
    const list = x.candidates;
    const c = list[curIdx || 0];
    return c || list[0] || null;
  }
  return x;
}

/* 这一镜的默认候选（origin 'auto' 的那一条）：它承担当年「画面基准」的角色 ——
   这一镜的主描述落在它身上；其余候选各持自己那一份。 */
export function defaultTakeOf(sh) {
  const list = (sh && sh.candidates) || [];
  const hit = list.find(c => c && originOf(c) === 'auto');
  return hit || list.find(c => c && typeof c === 'object') || null;
}

/* 一条候选的提示词：c 为空 = 问这一镜的主描述（默认候选那一句）。 */
export function takePromptOf(sh, c) {
  if (c) return String(c.prompt == null ? '' : c.prompt);
  const d = defaultTakeOf(sh);
  return d ? String(d.prompt == null ? '' : d.prompt) : '';
}

/* 写回只动那一条候选 —— 取消画面层之后没有「auto 改基准、其余改自己」的分流了。
   c 为空 = 写这一镜的主描述（默认候选那一句）。
   `alt`：双稿那一路（润色 / 平台改写采用过的）把对照稿与语言标签一起写进候选，
   提交生成时随任务归档；没传就清掉候选上已有的那一套（写单稿 = 不再带双语）。 */
export function setTakePrompt(sh, c, text, alt) {
  const v = String(text == null ? '' : text);
  const a = (alt && String(alt.alt || '').trim()) ? { promptAlt: String(alt.alt), promptLang: String(alt.lang || ''), promptAltLang: String(alt.altLang || '') } : null;
  const applyTo = x => {
    x.origin = originOf(x);
    x.prompt = v;
    if (a) { x.promptAlt = a.promptAlt; x.promptLang = a.promptLang; x.promptAltLang = a.promptAltLang; }
    else { delete x.promptAlt; delete x.promptLang; delete x.promptAltLang; }
  };
  if (!c) {
    const d = defaultTakeOf(sh);
    if (d) applyTo(d);
    return v;
  }
  applyTo(c);
  return v;
}

/* 这一镜的主描述（默认候选那一句）与其写入口。 */
export function shotPromptOf(sh) { return takePromptOf(sh, null); }
export function setShotPrompt(sh, text) { return setTakePrompt(sh, null, text); }

/* 各候选自己的描述（空的不算）：拆分镜的 @待建 扫描与「这一镜有没有文字」都问这一份。 */
export function promptTextsOf(sh) {
  const out = [];
  ((sh && sh.candidates) || []).forEach(c => {
    if (c && c.prompt != null && String(c.prompt).trim()) out.push(String(c.prompt));
  });
  return out;
}

export function anyPromptOf(sh) {
  return ((sh && sh.candidates) || []).some(c => c && c.prompt != null && String(c.prompt).trim());
}

export function draftTakesOf(sh) {
  return ((sh && sh.candidates) || []).filter(c => c && c.status === 'draft');
}

/* 已有非草稿 / 非失败 / 非取消的候选：这一镜已经出过东西了。 */
export function shotHasVideo(sh) {
  return ((sh && sh.candidates) || []).some(c => c && !['draft', 'failed', 'cancelled'].includes(c.status));
}

export function shotVideoDone(sh) {
  return ((sh && sh.candidates) || []).some(c => c && c.status === 'succeeded');
}

/* 「生成全部分镜」这一镜要提交哪几个单元（纯口径，页面与判据共用）：
   pending = 还没提交过的候选（每条都是一条独立的候选镜头）；
   usable  = 其中提示词非空的（空着的提交出去就是一句 400）；
   need    = 还差多少条才够这一镜设的张数（不足才补建克隆）；
   total   = 这一镜这次一共要提交几条。 */
export function takeBatchOf(sh) {
  const list = (sh && sh.candidates) || [];
  const pending = list.filter(c => c && c.status === 'draft');
  const usable = pending.filter(c => String(c.prompt == null ? '' : c.prompt).trim());
  const draw = Math.max(1, Number(sh && sh.draw) || 1);
  const need = Math.max(0, draw - pending.length);
  return { pending, usable, need, total: usable.length + need };
}

/* 克隆一条候选：提示词 + 全部拍摄配置一起复制（新 vid、origin 'manual'）。
   关键帧逐条复制一份（对象也复制），免得改一条候选的切片计划把另一条也改了；
   已经出好的切片仍按资产号复用，不重新花钱。 */
export function cloneTakeOf(sh, src, uid) {
  const base = src || defaultTakeOf(sh);
  const c = {
    vid: 'tk_' + (uid ? uid() : String(Math.random().toString(36).slice(2, 10))),
    shotId: (sh && sh.id) || (base && base.shotId) || '',
    created: Date.now(),
    prompt: base && base.prompt != null ? String(base.prompt) : '',
    origin: 'manual',
    status: 'draft',
    progress: 0,
    url: null,
    error: null,
    selected: false,
    locked: false,
    trimS: null,
    trimE: null,
    provider: (base && base.provider) || '',
    priceText: '',
    priceMicros: null,
    duration: undefined,
  };
  TAKE_CFG_KEYS.forEach(k => {
    const v = base ? base[k] : undefined;
    if (k === 'keyframes') c[k] = Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? { ...x } : x)) : [];
    else if (k === 'refImages' || k === 'refMeta') c[k] = Array.isArray(v) ? v.slice() : [];
    else c[k] = v === undefined ? '' : v;
  });
  c.prompt = base && base.prompt != null ? String(base.prompt) : '';
  return c;
}

/* 候选状态的中文说法：与候选卡 title 同一套状态词。 */
const TAKE_ZH = {
  draft: '草稿',
  creating: '创建中',
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
};
export function takeStatusZh(c) {
  return TAKE_ZH[(c && c.status) || ''] || '草稿';
}

/* 旧工程进内存时的**一次性形状转换**（不是兼容分支，改完就不再有旧形状）：
   ① 镜头级那份描述与拍摄配置下沉到每一条候选；
   ② 旧的「沿用画面」（c.prompt == null）冻结成当时那一句，不再回落到别人身上；
   ③ 默认候选（origin 'auto'）承担当年画面基准的角色：第一条草稿是它，没有草稿就取第一条；
   ④ 一条候选都没有的镜头补一条默认候选（带基准句与配置）。
   已生成的画面、状态、选用、裁剪一个字节都不动。 */
export function sanitizeTakes(sh, opts) {
  if (!sh || typeof sh !== 'object') return sh;
  const list = Array.isArray(sh.candidates) ? sh.candidates : (sh.candidates = []);
  const base = String(sh.prompt == null ? '' : sh.prompt);
  const o = opts || {};
  /* 镜头级的旧配置 → 每条候选一份（数组复制，元素是只读资产引用，可共用）。
     `force` 只给「刚补出来的那条默认候选」用：它自带一套默认配置（linkPrev:'' 之类），
     不覆盖的话镜头级那份（比如接续标记 'tail'）就被默认值挡在外面了。 */
  const copyCfg = (c, force) => {
    TAKE_CFG_KEYS.forEach(k => {
      if (!force && c[k] !== undefined) return;
      const v = sh[CFG_FROM_SHOT[k] || k];
      if (v === undefined) return;
      c[k] = (k === 'keyframes' || k === 'refImages' || k === 'refMeta') && Array.isArray(v) ? v.slice() : v;
    });
    if (c.prompt == null) c.prompt = base;
    else c.prompt = String(c.prompt);
    if (!Array.isArray(c.refImages)) c.refImages = [];
    if (!Array.isArray(c.refMeta)) c.refMeta = [];
    while (c.refMeta.length < c.refImages.length) c.refMeta.push({ label: null });
    c.refMeta.length = c.refImages.length;
    if (!Array.isArray(c.keyframes)) c.keyframes = [];
  };
  list.forEach(c => { if (c && typeof c === 'object') copyCfg(c); });
  /* 一条候选都没有的镜头：补一条默认候选（带基准句与镜头级那份配置）。 */
  if (!list.length && typeof o.makeDefault === 'function') {
    const c = o.makeDefault(sh);
    if (c && typeof c === 'object') { copyCfg(c, true); c.prompt = base; list.push(c); }
  }
  /* 默认候选：第一条草稿（它承接基准句）；没有草稿就取第一条候选。 */
  const firstDraft = list.find(c => c && c.status === 'draft') || null;
  const def = firstDraft || list.find(c => c && typeof c === 'object') || null;
  list.forEach(c => {
    if (!c || typeof c !== 'object') return;
    if (c === def) { c.origin = 'auto'; return; }
    if (c.origin === 'auto') c.origin = 'manual';       // 多余的默认候选：它本来就是一条独立出片条目
    else if (!TAKE_ORIGINS.includes(c.origin)) c.origin = c.status === 'draft' ? 'manual' : 'imported';
  });
  /* 镜头级那一份配置不再留在镜头上（读配置一律收候选）。 */
  delete sh.prompt;
  delete sh.model;
  delete sh.modelAuto;
  delete sh.tier;
  delete sh.res;
  delete sh.ar;
  delete sh.size;
  delete sh.duration;
  delete sh.refImages;
  delete sh.refMeta;
  delete sh.refVideo;
  delete sh.refAudio;
  delete sh.keyframes;
  delete sh.combo;
  delete sh.firstFrame;
  delete sh.lastFrame;
  delete sh.linkPrev;
  return sh;
}
