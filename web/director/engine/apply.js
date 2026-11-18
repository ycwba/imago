/* 导演台Apply域：由 engine.js 按域机械搬出（内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createApply(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { parseJsonLoose, reEscape } from '../util.js';
import { splitLongShots } from '../chain.js';
import { picsIdxOf } from '../board.js';
import { splitScriptGate } from '../split-form.js';
import { defaultTakeOf, setShotPrompt } from '../takes.js';

export function createApply(E, document, window) {
  const {
  cfg,
    $,
    WSOf,
    projOf,
    REGOf,
    uid,
    Groups,
    PENDING_PREFIX,
    BoardAssets,
    BoardVars,
    fillSkillVars,
    newShot,
    allShots,
    TL_SYS_COMMON,
    splitSysOf,
    boardEditSysOf,
    durWritable,
    setShotDur,
    boardDurNote,
    boardDurSub,
    softShotsNote,
    clampShotDurations,
    clampNote,
    chainModelList,
    ensureChainModel,
    snapBoard,
    boardListText,
    boardPlanOf,
    applyBoardPlan,
    SplitAssets,
    scheduleSave,
    feedScenePics,
    placeScenesInto,
    reportScenePics,
    boardEstimate,
    compressImg,
    renderAll,
    switchProject,
    setStatus,
    toDataURL,
  } = E;

/* AI 拆分镜 / 改分镜带回台词时那句「出路」只有一份：两处报数共用同一个串。
   台词一落地，右栏就能按这句台词和说话人素材直接生成语音；不再自动往轨道上放占位块，
   所以这里指路指向那两处入口；话里不写「已合成」—— 那一次一个计费请求都没发，
   合成只在「合成并加到这一轨」那一下。 */
function lineLandedNote(n) {
  return '、' + n + ' 镜带上了台词';
}
/* 「发给 AI 的备注」只有这一句拼法（拆新 / 往下拆 / 改稿三条链共用）：
   它只进这一次请求的正文，不落到任何镜头的提示词上。 */
function userNoteLine(v) {
  return v.note ? '\n\n用户备注：' + v.note : '';
}
/* 拆分镜随附图 → 喂给文字 AI 的多模态输入（三档共用一份准备）。
   能力闸按「图片」整档放行或整档挡下（prepareMedia 逐条记原因进 note），所以「能不能用」
   按张数对账：非 mask 的张数 ≠ 输入张数 = 这次一张都没带上（型号不识图 / 图读不出来，
   两者由 caps.image.ok 分开报）—— media 与 pics 都交空：
   media 空 = AI 看不到也没号可引，pics 空 = 它若仍写 图N 会照实进「图号没对上」的报数，
   一张都不挂比挂一半诚实。图N 的编号数的是非 mask 的素材图，与输入顺序一一对应
   （这一路不带掩码，所以就是 list 的下标）。 */
async function prepareRefPics(pics) {
  const list = (pics || []).filter(p => p && p.src);
  if (!list.length) return { pics: [], media: [], usable: true, canSee: true, note: '', n: 0 };
  const m = await TextAI.prepareMedia(REGOf(), list.map(p => ({ kind: 'image', label: p.label || '参考图', src: p.src })));
  const seen = m.media.filter(x => !x.isMask).length;
  const usable = seen === list.length;
  /* 「一张都没带上」有两种原因，报数时要分开：型号不识图（能力闸挡的）与图读不出来
     （链接 / dataURL 坏了）。混成一句会把「型号设置得好好的」说成「型号不识图」——
     用户去把 图 / 音 / 视 重新点一遍也修不好，因为问题根本不在那里。 */
  const canSee = !!(m.caps && m.caps.image && m.caps.image.ok);
  return { pics: usable ? list : [], media: usable ? m.media : [], usable, canSee, note: m.note || '', n: list.length };
}
/* 审查弹窗 sub 里「这次附图是什么状态」那一句（拆新 / 改稿两条链共用）：
   usable 说「由 AI 决定挂到哪几镜」，不识图照实说没给 AI 看、这次不挂；unknown 是
   AI 写了但没对上的图号数；unused 是 AI 一张都没挂上的输入图 —— 哪些图当了参考、
   哪些这次没用上，行上缩略图之外整表还要有这么一句总览。chainDrop 是挂在「接上一镜」
   （首尾帧模式）镜头上的图数：首尾帧与参考图互斥，这些图不会挂，照实报数。 */
function picsInfoOf(mediaPrep, unknown, unused, chainDrop) {
  if (mediaPrep.usable && mediaPrep.pics.length) {
    let s = '随附参考图 ' + mediaPrep.pics.length + ' 张，由 AI 决定挂到哪几镜';
    if (unused && unused.length) s += '；图' + unused.map(i => i + 1).join('、图') + ' 没挂到任何镜头';
    if (unknown) s += '；有 ' + unknown + ' 个图号没对上，没挂';
    if (chainDrop) s += '；' + chainDrop + ' 张图挂在接上一镜的镜头上没挂（首尾帧不收参考图）';
    return s;
  }
  if (!mediaPrep.usable && mediaPrep.n) {
    const tail = (mediaPrep.note ? '（' + mediaPrep.note + '）' : '');
    return (mediaPrep.canSee === false
      ? '当前文字型号不识图，附的 ' + mediaPrep.n + ' 张图没能给 AI 看，这次不自动挂参考图'
      : '附的 ' + mediaPrep.n + ' 张图没能读出来，这次不自动挂参考图')
      + tail;
  }
  return '';
}
/* 这一次随附的图里，AI 一张都没挂到任何镜头的是哪几张（下标表）。
   lists 是各行认领的图号下标（拆新行在 row.pics，改稿行在 row.patch.pics —— 两者形状不同，
   调用方各自取好列进来）。 */
function unusedPicsOf(pics, lists) {
  const used = new Set();
  lists.forEach(l => (l || []).forEach(i => used.add(i)));
  return (pics || []).map((p, i) => used.has(i) ? null : i).filter(x => x != null);
}

/* ---------- 拆分镜 / 改分镜的「AI 反问」那一轮（与润色同一套两段式）----------
   过程状态存 splitUI；转圈 / 反问 / 流式都画在**一张居中弹窗**里（PromptReview.openProcess），
   拆完原地换成审阅（openList 传 shell，mount 只换标题接着用）—— 从头到尾只看见一张卡，
   屏幕中间不关不闪。弹窗不在任何整片重画的栏里，编辑器 3 秒一次的重画冲不到它；
   renderSplitPanel 仍跟着重画被叫，但只负责状态过渡（loading → ask）：
     · phase 'loading'：转圈占位（挑素材 / 判断要不要反问 / 新素材判定那些段）；
     · phase 'ask'：问答面板（每题候选 + 自由输入框，InlinePolish.ask）；
     · phase 'stream'：流式那段宿主直接交给 AiStream —— 它每次 push 前自己确认面板
       还在宿主里、不在就重画一块并把已收到的字补回去（见 gen-forms.js 的 panel()）。
   取消只有一处：弹窗 foot 那颗「取消」（Esc 同一路）→ onAbort 把这趟标死、收掉等着的
   问答 Promise、关弹窗；此后每个 await 回来都先问 splitAlive，死掉的这趟一个字都不再画。
   busy 只在「真在跑」的段为真：问答摆出来等人回答时不算忙 —— 用户这时再点一次「拆分镜」
   是正当操作（上一趟他可能已经不想管了），新一轮照常开，旧的那份等答 Promise 由
   splitUI 换人作废（闭包里多等一个引用，不占资源）。 */
let splitUI = null;
let splitDlg = null;        // 这一趟的过程弹窗：审阅接手时它作为 openList 的 shell 继续用
let splitDlgRun = null;     // 这张弹窗属于哪一趟（新一轮要开时旧弹窗先收掉）
let splitDlgReview = false; // 已经交给审阅：过程性的加载态不再往它的清单上盖
let splitRun = null;        // 最近一趟的身份（对象比较）：被顶掉或取消后，旧的这趟不再往下跑
function splitHost(run) {
  if (splitDlg && (!splitDlg.isConnected || splitDlgRun !== run)) {
    const old = splitDlg;
    splitDlg = null; splitDlgRun = null; splitDlgReview = false;
    PromptReview.closeProcess(old);
  }
  if (splitDlg) return splitDlg.querySelector('#prBody');
  splitDlgRun = run;
  /* 拆分常从空项目发起：弹窗挂在 body 上，谁重画都摘不掉它。 */
  splitDlg = PromptReview.openProcess({
    title: 'AI 正在' + (run && run.kind === 'edit' ? '修改分镜' : '拆分镜') + '…',
    onAbort() {
      if (run) run.dead = true;
      splitDlg = null; splitDlgRun = null; splitDlgReview = false;
      const u = splitUI;
      splitUI = null;
      setStatus('已取消');
      if (u && typeof u.resolve === 'function') u.resolve('');
    },
  });
  return splitDlg.querySelector('#prBody');
}
function splitAlive(run) { return !!run && splitRun === run && !run.dead; }
function splitEnd(run) {
  if (run) run.dead = true;
  splitUI = null;
  const d = splitDlg;
  splitDlg = null; splitDlgRun = null; splitDlgReview = false;
  if (d) PromptReview.closeProcess(d);
}
function renderSplitPanel() {
  if (!splitUI) return;
  if (splitUI.phase === 'stream') return;    // 面板本体归 AiStream 管（宿主已交给它），这里不插手
  if (splitDlgReview) return;                // 审阅已经接手这张弹窗：加载态不再盖它的清单
  const host = splitHost(splitRun);
  if (splitUI.phase === 'loading') { InlinePolish.loading(host, splitUI.note || '正在准备…'); return; }
  if (!splitUI.questions || !splitUI.questions.length) { splitEnd(splitRun); return; }
  /* 问答题已在屏上就不重画：这枚钩子跟着编辑器整列重画一起被叫（3 秒一次），
     重画会把用户正在输入的自由框清掉。 */
  if (splitUI.painted && host.firstElementChild) return;
  splitUI.painted = true;
  const mine = splitUI;
  InlinePolish.ask(host, {
    title: mine.title || '拆分镜前，AI 想先问几个问题',
    intro: '点一个候选，或在输入框里自己写；没答的题按 AI 的默认理解走。'
      + '回答会当作硬约束带进这一次' + (mine.kind === 'edit' ? '修改' : '拆分') + '。',
    questions: mine.questions,
    state: mine.state || [],
    onChange: st => { if (splitUI === mine) mine.state = st; },
    submitLabel: mine.submitLabel || '按这些回答开始',
    skipLabel: mine.skipLabel || '跳过，直接开始',
    onSubmit: t => { if (splitUI === mine) { splitUI = null; mine.resolve(t); } },
    onSkip: () => { if (splitUI === mine) { splitUI = null; mine.resolve(''); } },
  });
}
/* 反问那一轮：AI 自己判断这段料值不值得先问（need=false 直接往下走）；问了就把面板摆出来
   等人回答，返回回答正文（跳过 / 没问出来 / 设置选「从不问」都返回 ''）。
   sys / user 与生成那一轮同源（同一份 Skill 变量、同一份上下文）—— 问出来的问题才贴着
   这一次的料（时长区间、已有角色都看得见，不会问「每镜几秒」这种系统提示里已经写明的事）。
   一趟只调一次（调用方把返回值记住），审查弹窗里点「重新规划」按同一份回答重跑。 */
async function askRound(o) {
  const kind = o.kind || 'split';
  const run = splitRun;
  if (!TextAI.shouldAsk()) { splitUI = null; return ''; }   // 设置选「从不问」：整轮不发
  const mine = { phase: 'loading', busy: true, kind,
    note: '正在读' + (kind === 'edit' ? '这份修改要求' : '剧本') + '，判断要不要先问你几个问题…' };
  splitUI = mine;
  renderSplitPanel();
  let r = { need: false, questions: [] };
  try { r = await TextAI.askPolish(REGOf(), o.sys, o.user, { focus: o.focus, media: o.media }); }
  catch (e) { /* 问不成不拦这一趟：照旧直接拆，与润色「跳过问答直接润色」同一个立场 */ }
  /* 这一趟被取消 / 被新一轮顶掉：这一格已经不是我们的了，一个字都不往上写 */
  if (!splitAlive(run) || splitUI !== mine) {
    if (splitUI === mine) splitUI = null;
    return '';
  }
  const qs = (r && r.need && Array.isArray(r.questions)) ? r.questions : [];
  if (!qs.length) {
    splitUI = null;
    return '';
  }
  setStatus('AI 有几个问题想先问清楚（也可以跳过）');
  mine.phase = 'ask'; mine.busy = false;
  mine.questions = qs; mine.state = [];
  mine.title = kind === 'edit' ? '改分镜前，AI 想先问几个问题' : '拆分镜前，AI 想先问几个问题';
  mine.submitLabel = kind === 'edit' ? '按这些回答开始改' : '按这些回答开始拆分';
  mine.skipLabel = kind === 'edit' ? '跳过，直接改' : '跳过，直接拆分';
  renderSplitPanel();
  const t = await new Promise(resolve => { mine.resolve = resolve; });
  return t || '';
}
/* 这一类活儿最值得先问的缺口（TextAI.askPolish 的 focus；两档各一句，都点名「已写明的别再问」）。 */
const SPLIT_ASK_FOCUS = '整片的题材与风格基调、叙事节奏（每镜几秒、快剪还是多留白）、要不要旁白与台词、'
  + '景别与镜头运动的取向';
const EDIT_ASK_FOCUS = '要改哪几镜、往哪个方向改（画面写得更具体 / 节奏更快 / 光线与时间 / 换构图…）、'
  + '台词与时长动不动';

/* 「顺便给新素材出图」（拆分镜确认后的可选第二步）：出图要花钱，**勾了才排队** ——
   确认框是唯一入口，不勾就维持「只建档不出图」。出图管道只有 `Chars.Pipe.drawPreview`
   一条（素材库「批量补预览图」走的同一条），出完由 `wb:char-pic` 事件回填占位符并补参考图。 */
async function maybeFillNewAssetPics(saved) {
  const D = window.Chars;
  if (!D || !D.Pipe || !D.Pipe.drawPreview || !saved || !saved.length) return;
  const n = saved.length;
  let ok = false;
  try {
    ok = await window.Confirm.ask({
      title: '顺便给 ' + n + ' 条新素材出预览图？',
      body: '每条发一次生图请求（共 ' + n + ' 张，按平台价计费、会花钱）。出完自动把占位符换成真名并补进参考图。'
        + '不发就先留在素材库里，随时在素材库页手点「生成素材图」。',
      okLabel: '出图（' + n + ' 张）',
      cancelLabel: '先不出',
    });
  } catch (e) { return; }
  if (!ok) return;
  const reg = REGOf();
  /* drawPreview 只读 drama.opts 的 imgModel / ratio 两个字段：型号留空 = 按注册表挑当前能用的。 */
  const drama = { opts: { imgModel: '', ratio: '9:16' }, characters: [], scenes: [], shots: [] };
  let done = 0;
  const failed = [];
  for (const item of saved) {
    try { await D.Pipe.drawPreview(reg, drama, item, { count: 1 }); done++; }
    catch (e) { failed.push((item && item.name) || '?'); }
  }
  Toast[(failed.length ? 'warn' : 'ok')](
    '新素材出图：' + done + ' 条已发（出完自动补进参考图）'
    + (failed.length ? '；没成：' + failed.join('、') : ''), 7000);
}

function landNewAssets(list, groupName) {
  const D = window.Chars;
  const out = { saved: [], failed: [], group: String(groupName || '').trim(), why: '' };
  if (!list || !list.length) return out;
  if (!D || !D.Lib || !D.Lib.save) { out.why = '素材库没有加载，新素材没有建档'; return out; }
  (list || []).forEach(a => {
    const name = String((a && a.name) || '').trim();
    if (!name) { out.failed.push({ name: '', why: '没有名字' }); return; }
    const spec = BoardAssets.libSpec({ name, kind: a.kind, look: a.look, voice: a.voice, why: a.why }, out.group);
    let item = null;
    try {
      if (spec.kind === 'scene') item = D.newScene(spec);
      else if (spec.kind === 'prop') item = D.newProp(spec);
      else item = D.newChar(spec);
    } catch (e) {
      out.failed.push({ name, why: errText(e) });
      return;
    }
    try {
      const saved = D.Lib.save(item, { exact: true });
      const e = D.Lib.writeError && D.Lib.writeError();
      if (e) { out.failed.push({ name, why: e }); return; }
      out.saved.push(saved || item);
    } catch (e) {
      out.failed.push({ name, why: errText(e) });
    }
  });
  return out;
}
/* 把提示词里「待建素材」的名字换成占位符 `@待建:名字`。
   判据只认**这一批真要建的** —— 别处出现的同名字（本来就有的素材）不动。 */
function markPendingTokens(shots, list) {
  const names = (list || []).map(a => String((a && a.name) || '').trim()).filter(Boolean);
  if (!names.length) return 0;
  /* 一次扫描、长名优先：以前逐名 replace，短名先把长名的前缀换掉
     （小雅 先跑，「小雅妈妈」就成了「@待建:小雅妈妈」—— 指向了另一条素材），
     而且换出来的占位符还会被下一条名字重新扫到。
     整 token 化的正则同时认「@待建:名字」「@名字」与裸名字三种：
     前两种原样留着（已经是引用 / 已经是占位符），只有裸名字补成占位符。
     ⚠ 裸名字那一个分支必须带边界：名字前后紧着的那个字不能还是「可成名字」的字
     （汉字 / 字母数字 —— CH 取反的那一组之外都是），否则「门」会把正文里的「门把手」
     改成「@待建:门把手」—— 占位符套进普通词里，bind 精确查库查不到，引用静默丢。
     边界的代价是句子中间的裸名字不再自动成占位符（中文没有词边界，分不出来）：
     只有挨着标点 / 空白 / @ / 句首句尾的才算一个完整的「提到」，这正是要的。 */
  const CH = '[^\\s@，,。.、；;：:！!？?()（）\\[\\]【】"\'“”《》]';
  const EDGE = '\\s@，,。.、；;：:！!？?()（）\\[\\]【】"\'“”《》';
  const alt = names.slice().sort((a, b) => b.length - a.length).map(reEscape).join('|');
  const re = new RegExp('@' + PENDING_PREFIX + ':' + CH + '+|@' + CH + '+'
    + '|(?<![^' + EDGE + '])(?:' + alt + ')(?![^' + EDGE + '])', 'g');
  let n = 0;
  (shots || []).forEach(sh => {
    const p = String((sh && cfg(sh).prompt) || '');
    if (!p) return;
    cfg(sh).prompt = p.replace(re, m => {
      if (m.charAt(0) === '@') return m;
      n++;
      return '@' + PENDING_PREFIX + ':' + m;
    });
  });
  return n;
}

/* 页头「拆分镜」那一颗的入口：三档任务共用一个表单（选哪一档，下面几行的称呼跟着换）。
   写入是两段式：先给用户看一遍（可逐条改 / 删），确认才落盘 —— 三档一致。 */
async function aiStoryboard() {
  /* 上一趟还在真跑（挑素材 / 反问判断 / 流式拆分）就不重开：两趟并发会抢同一个流式面板，
     写出来的字两趟叠在一起分不清是谁的。问答摆出来等人回答时不算忙 —— 那一趟用户可能已经
     不想要了，重开一趟由 splitUI 换人作废旧的（见 renderSplitPanel 那段说明）。 */
  if (splitUI && splitUI.busy) { Toast.warn('上一趟拆分还在跑，等它出结果再来'); return; }
  const hasBoard = snapBoard(projOf().scenes).length > 0;
  /* 「项目引用规则」：已启用的 Skill 声明了哪些素材组 / 引用写成什么样子（设置页可改）。
     读不到就当没有声明（默认写法、全部组都在下拉里）—— 读不到不是错，按默认走。 */
  const refRule = (window.WbSkills && WbSkills.refRule) ? await WbSkills.refRule() : { assetGroups: [] };
  /* 「素材范围」那一排的名单这一刻现数（新加了素材不必重开页面）；
     库还是空的就整项不画 —— 只有一项可选的下拉等于一颗点下去什么都不会变的按钮。
     Skill 声明的组**排在前面**（不排除其它组）。 */
  const scopes = SplitAssets.scopes(refRule.assetGroups);
  const fields = [
    { key: 'task', type: 'select', label: '要做什么', value: 'append', options: [
      { v: 'append', t: '接着往下拆（在现有分镜后面继续加）' },
      { v: 'edit', t: '修改现有分镜（改提示词 / 名字 / 时长、加镜头）' },
    ] },
    { key: 'script', type: 'textarea', label: '剧本 / 文案', placeholder: '把故事、旁白或分镜草稿粘进来…', hint: '' },
    { key: 'instruct', type: 'textarea', label: '修改要求（说给 AI 的一句话）', placeholder: '例：把河岸那两镜的提示词写得更具体、光偏黄昏；第 3 镜后面加一个特写', hint: '不填就是整体优化一遍现有提示词', hidden: true },
    /* 随附参考图：三档共用一格。挑图时就地转 dataURL（blob: 地址必须当场定型，对齐 ref.js
       那条 applyFrameEntry 的做法）；读不出来的照实报数，不带残条。
       粘贴 / 拖进来的图片走同一道压缩（onFile）：公共层不认识 compressImg，字节口径由这一格给。 */
    { key: 'pics', type: 'pics', label: '参考图（给 AI 看）', value: [],
      hint: '挑图、把图片粘贴进剧本框、或直接拖进这一格（光标处会留下［图N］占位）；AI 判断哪些贴题，挂进对应镜头的参考图槽（文字型号需支持识图）',
      onFile: async f => AssetTransfer.toDataURL(await compressImg(f)),
      pick: async api => {
        const got = await AssetPicker.open({ types: ['图片'], multiple: true, title: '挑拆分镜要用的参考图' });
        if (!got || !got.length) return;
        const cur = (api.values().pics || []).slice();
        let fail = 0;
        for (const e of got) {
          try {
            const src = e.file ? await AssetTransfer.toDataURL(await compressImg(e.file)) : await toDataURL(e.src);
            cur.push({ label: e.name || (e.file && e.file.name) || '', src });
          } catch (err) { fail++; }
        }
        if (fail) Toast.warn(fail + ' 张图读不出来，没带上');
        if (cur.length) api.set('pics', cur);
      } },
  ];
  if (scopes.length) fields.push({ key: 'assetSrc', type: 'select', label: '素材范围',
    value: SplitAssets.last(), options: scopes,
    hint: '写进提示词的 @名字 在确认写入时挂成参考图（选「不导入素材」就一个字也不喂）' });
  fields.push({ key: 'note', type: 'text', label: '发给 AI 的备注（可选）',
    placeholder: '例：整体偏冷色 · 节奏快一点', hint: '只给 AI 看，不进提示词' });
  const v = await PromptForm.open({
    title: 'AI 分镜（改现有 / 接着往下拆）',
    sub: '对着现有分镜说一句话让它改；或贴一段文案连着上面往下拆',
    okLabel: '开始',
    fields: fields,
    onChange: (key, api) => {
      const cur = api.values();
      /* 「这一档要哪几行、各行怎么说」现读，不在 fields 里写死两份（初值那份会被这一次调用盖掉）。
         时长与镜数**不再是输入框**：区间来自可用型号声明的交集，镜数只给一句软上限预估，
         它既不截断也不禁用「开始」。 */
      const t = cur.task;
      api.set('script', {
        label: t === 'append' ? '接着往下拆的文案' : '修改要求',
        hint: (t === 'append'
          ? '会连着上面已有分镜往下拆：沿用清单里已有的场景名与画风、不重复已有的镜头。'
          : '对着现有分镜说一句话；只改你要改的那几处。') + softShotsNote(cur.script),
        hidden: t === 'edit',
      });
      /* 「改现有分镜」这一档同样能带素材（改提示词时把库里的角色名认回来），所以整块不收；
         但用来挑素材的那句话换成上面那一格填了什么 —— 这一档没有剧本，只有那句要求。 */
      if (key !== 'task') return;
      api.set('instruct', { hidden: t !== 'edit' });
    },
    validate: o => {
      if (!hasBoard) return '当前短片还没有分镜，两档都用不了；先在生成态造几个镜头（或导入素材）';
      /* 两档都只挡空：短要求（例：再加一个特写）也是有效要求，
         以前两档共用一条 20 字下限，短要求根本发不出去。判据在公共层 split-form.js。 */
      return splitScriptGate(o.task, o.script);
    },
  });
  if (!v) return;
  if (v.assetSrc) SplitAssets.remember(v.assetSrc);
  /* 「素材范围优先」跟着这一趟走（Skill 声明了哪些组排在前面）。 */
  v.refRule = refRule;
  if (v.task === 'edit') { await aiBoardEdit(v); return; }
  await aiBoardSplit(v);
}
/* 第 4 段喂给 AI 的那份清单：`items` 是**扁平**的镜头数组（场名在每一项上），
   而 `boardListText` 认的是 `snapBoard` 那一份按场分组的样子。
   这里把扁平的按场名并成组 —— 判据是「在几个镜头里反复出现」，
   AI 要看得见「第几镜、第几镜」才知道那是反复出现。 */
function boardListOfItems(items) {
  const byScene = new Map();
  (items || []).forEach(it => {
    const k = String((it && it.scene) || '');
    if (!byScene.has(k)) byScene.set(k, []);
    byScene.get(k).push(it);
  });
  const scenes = [];
  byScene.forEach((list, name) => {
    scenes.push({ n: scenes.length + 1, sc: { id: name, name: name }, name: name,
      shots: list.map((t, i) => ({ n: i + 1, sh: { id: t.key || (name + '·' + (i + 1)) },
        name: t.name || '', prompt: String(t.text || '').trim(),
        line: String(t.line || '').trim(), who: String(t.who || '').trim(),
        dur: Number(t.dur) > 0 ? Number(t.dur) : 0,
        chain: t.chain === 'tail' ? 'tail' : '',
        /* 挂图跟着行走（「按这句再改」的快照把图号原样带回来）：AI 要看得见「这一镜挂了哪几张」
           才能在改这一镜时说清图是留是换（图N 对照消息末尾的【随附素材】清单）。 */
        pics: Array.isArray(t.pics) ? t.pics : [] })) });
  });
  return boardListText(scenes);
}

/* 「接着往下拆」这一档：现有分镜的清单一起喂过去 —— 它才能沿用场景名与画风、
   也不重复已有的镜头，这正是「拿原有分镜上的提示词来加新镜头」那条要求的落点。 */
async function aiBoardSplit(v) {
  /* 这一趟的身份：用户点取消 / 新一轮顶掉它之后，每个 await 回来都靠它认出「这趟已经不作数」 */
  const run = { dead: false, kind: 'split' };
  splitRun = run;
  /* 随附参考图 → 多模态输入（挑图时已定型 dataURL，这里只过能力闸）。 */
  const mediaPrep = await prepareRefPics(v.pics);
  if (!splitAlive(run)) return;
  /* AI 写了但没对上的图号数（itemsOfDraft 每轮重算）：弹窗 sub 照实报数。 */
  let draftPicUnknown = 0;
  /* AI 点给「接上一镜」镜头的图号（itemsOfDraft 每轮重算）：首尾帧与参考图互斥，
     这些图不会挂；弹窗 sub 与落盘报告照实报数。 */
  let draftPicChain = [];
  let draft = null;
  /* 素材只问一次：审查弹窗里点「重新规划」重跑这一趟时复用同一份挑中名单，
     不然每次重试都多问一遍文字 AI（多扣一次 tokens，而挑出来的还是那几条）。 */
  let staged = null;
  /* 反问那一轮的回答（'' = 没问出来 / 用户跳过；非空 = 逐题答的正文）。一趟只问一次：
     生成轮与「重新规划」都按这一份跑 —— 答案在生成轮是硬约束，重新问一遍等于替用户改主意。 */
  let answers = null;
  /* 新素材（要建档的那些角色/场景/物品）也只问一次：同样在「重新规划」时复用。
     问的是「哪些主体该新建」，判据在 board-assets.js，指令正文来自 Skill。 */
  let newAssets = null;
  /* ask() 最近一次拆出的镜头清单：审查弹窗里「重新规划（新素材）」只重问第 4 段，
     要拿同一份镜头当料，不把整趟拆分 AI 再花一遍钱。 */
  let lastOut = null;
  /* 素材挑选也收进过程面板：范围内有条目时它是**真的一次文字 AI 调用**，
     干等没有下文看起来就像卡死了。同一趟只挑一次（staged 记住）。 */
  const ensureStaged = async () => {
    if (staged) return staged;
    const mine = { phase: 'loading', busy: true, kind: 'split', note: '正在按素材范围挑这一次要用的素材…' };
    splitUI = mine;
    renderSplitPanel();
    staged = await SplitAssets.stage(REGOf(), v.script, v.assetSrc, v.refRule);
    if (splitUI === mine) splitUI = null;
    if (staged.warn) Toast.warn(staged.warn);
    return staged;
  };
  /* Skill 正文里的变量这一趟怎么填（反问轮 / 生成轮 / 新素材判定三处同一份，board 由各处给）：
     · `{what}`   —— 这一次要拆的正文
     · `{cast}`   —— 本项目素材库里的角色 / 场景 / 物品名单（含外貌与音色）
     · `{assets}` —— 这一次选中的那批素材（完整描述）
     · `{board}`  —— 现有分镜清单（往下拆 / 改分镜那一路才有）
     · `{dur}`    —— 时长区间那句
     末尾那两句（约束 + 素材规则）**保留**：Skill 没写变量时（内置那份就没写）行为与从前一样；
     写了变量的 Skill 则由 Skill 自己决定这些料摆在哪儿 —— 程序不再替它硬塞。 */
  const varsOf = (boardText, what) => BoardVars.vars({
    what: what === undefined ? (v.script || '') : String(what || ''),
    cast: BoardVars.castOf(SplitAssets.named()),
    assets: BoardVars.assetsOf(staged ? staged.picked : [], x => (window.Chars && Chars.descOf) ? Chars.descOf(x) : ''),
    board: boardText,
    dur: boardDurNote(),
  });
  /* 第 4 段：问「这份方案里有哪些主体要新建素材」。ask() 首趟与
     「重新规划（新素材）」那颗共用 —— 后者只调它，不重跑拆分那一段。 */
  const stageAssetsOf = async (out) => {
    const mine = { phase: 'loading', busy: true, kind: 'split', note: '正在看这份方案里有哪些要新建的素材…' };
    splitUI = mine;
    renderSplitPanel();
    try {
      setStatus('<span class="meta">正在看这份方案里有哪些要新建的素材…</span>');
      const av = varsOf(boardListOfItems(out));
      newAssets = await BoardAssets.stage({
        reg: REGOf(), shots: out, existing: SplitAssets.named(),
        sys: fillSkillVars(TextAI.prompt('board_assets'), av),
        text: boardListOfItems(out),
        TextAI: window.TextAI, parseJsonLoose,
      });
    } catch (e) {
      newAssets = { raw: [], plan: [], skipped: [], warn: '没问成新素材（' + errText(e) + '），这一次不建新素材' };
      Toast.warn(newAssets.warn);
    }
    if (splitUI === mine) splitUI = null;
  };
  /* 用户在审查弹窗里**最终认下的**那几条（可逐条改 / 可删）—— 落盘按这一份建档。 */
  let chosenAssets = null;
  /* 长镜头拆分的报数（note / impossible）：弹窗 sub 与落盘报告都读这一份，重跑时跟着换。 */
  let splitInfo = null;
  /* 系统提示词与正文这一趟只有一份拼法：反问轮与生成轮各取一次 —— 同源，
     问出来的问题才贴着这一次的料（时长区间、已有分镜、角色名单都看得见），不会问系统提示里已经写明的事。 */
  const sysOfRun = () => `${TL_SYS_COMMON}
${fillSkillVars(splitSysOf(), varsOf(boardListText(snapBoard(projOf().scenes))))}
约束：由你决定拆几个镜头、每一镜多长。${boardDurNote()}${staged.rule}`;
  const userOfRun = () => `剧本/文案：\n${v.script}` + userNoteLine(v)
    + ('\n\n当前已有分镜（接着往下拆：新镜头的 scene **照抄**下面清单里已有的场景名，'
      + '不要加编号、不要改写；确要新开剧情段落才另起新名。别重复已有的镜头）:\n'
      + boardListText(snapBoard(projOf().scenes)));
  /* AI 回的那份 JSON → 审阅条目（生成轮与「按这句再改」两路共用同一份解析）：
     平的 {"shots":[…]} 折成一层无名场景、场名缺省、秒数原样带、长说明不砍。
     场名缺省 = **现有最后一个场景的名字**（接着往下拆就是继续讲当前故事的结尾；
     AI 没给场名时落盘按同名归并进末场，而不是造一个「场景 1」另起一场）。 */
  const itemsOfDraft = j => {
    if (j && Array.isArray(j.shots) && !Array.isArray(j.scenes)) {
      j.scenes = [{ shots: j.shots }];
    }
    /* 每轮重算：AI 这一次写了多少个没对上的图号（弹窗 sub 照实报数）。 */
    draftPicUnknown = 0;
    const chainSet = new Set();
    const scenesNow = projOf().scenes || [];
    const lastSceneName = scenesNow.length ? String(scenesNow[scenesNow.length - 1].name || '').trim() : '';
    const items = [];
    ((j && j.scenes) || []).forEach((sc, si) => {
      const scName = String(sc.name || '').trim() || lastSceneName || ('场景 ' + (si + 1));
      (sc.shots || []).forEach((s, shi) => {
        /* AI 给多少镜就列多少镜（这里的 slice 已删）：以前超上限的那几条**默默不列出来**，
           用户以为拆了 12 镜、剧本后面那半段就这样没了。秒数原样带着，越界由落盘后那一夹处理。
           标签里那个秒数与真正写进镜头的是同一判据（`durWritable`）—— 没有依据可校验时标签也不许显示，
           否则弹窗说「这一镜 7s」而镜头上压根没有 duration。
           后来把这一条变成**结构化的一份**（场名 / 镜头名 / 秒数 / 正文各一格，`mode:'board'`）：
           以前落盘要拿标签正则回查「场景名 + 镜头号」，用户改一个字就对不上号，而弹窗里拖过、删过几条
           之后序号本身就会漂。`key` = 「场名·该场第几镜」，点「重新规划」后靠它认出哪几条是用户改过的。 */
        const ds = Math.round(Number(s.duration));
        const dur = durWritable() && Number.isFinite(ds) && ds > 0 ? ds : null;
        const no = shi + 1;
        /* AI 点的随附图在这里解析成下标（board.js 的 picsIdxOf 全站唯一一份）：
           对不上号的照实计数，下标带进弹窗后由用户就地增删。 */
        const pp = picsIdxOf(s.pics, mediaPrep.pics);
        draftPicUnknown += pp.unknown.length;
        /* 这一镜接了上一镜（首尾帧模式）就不能再挂参考图：这次点的图摘掉，
           图号进冲突账（弹窗 sub 照实说），不静默吞掉。 */
        const chain = String(s.chain || '').trim() === 'tail' ? 'tail' : '';
        if (chain === 'tail' && pp.idxs.length) pp.idxs.forEach(i => chainSet.add(i));
        /* 镜头名与画面说明**分家**。以前这里写 `s.note.slice(0, 12)` ——
           长的那一句说明被砍成 12 字当标题，原文两头都没留（既不在名字里也不在别处）。
           现在 `name` 只取 AI 给的短名（没有就空着，落盘时退回「镜头 N」），`note` 整条原样存进 `sh.note`。
           `line` 是这一镜要念的话：只有文字，不进配音轨，右栏那一格直接看得见。 */
        items.push({
          key: scName + '·' + no,
          scene: scName,
          name: String(s.name || '').trim().slice(0, 12),
          dur,
          line: String(s.line || '').trim(),
          who: String(s.speaker != null ? s.speaker : (s.who == null ? '' : s.who)).trim(),
          note: String(s.note || '').trim(),
          text: s.prompt || s.note || '',
          /* AI 给这一镜点的随附图（下标；弹窗行上可就地摘）。接上一镜的镜头不带图：
             首尾帧与参考图互斥。 */
          pics: chain === 'tail' ? [] : pp.idxs.slice(),
          /* AI 只在「必须紧接着上一镜落幅」时标 tail（见 split 的指令）；长镜头的第 2 段起
             由下面的 splitLongShots 自动补上。落盘写默认候选的 `linkPrev`，生成时取上一镜尾帧当首帧。 */
          chain,
          label: scName + ' · 镜头 ' + no + (dur ? '（' + dur + 's）' : '')
            + (String(s.line || '').trim() ? ' · 有台词' : ''),
        });
      });
    });
    draftPicChain = [...chainSet];
    return items;
  };
  const ask = async () => {
    await ensureStaged();
    if (!splitAlive(run)) return null;
    const sys = sysOfRun();
    /* 反问那一轮用户答过的东西随正文一起交上去（TextAI.answersNote 是唯一一份拼法）：
       每条答案都是硬约束 —— Skill 正文的要求清单里也写了这一条。 */
    const an = TextAI.answersNote(answers || '');
    /* 长剧本动辄十几二十秒：这里同样边收边显 —— 宿主就是那张过程弹窗的正文格，
       流式面板由 AiStream 自管，拆分过程从头到尾不碰右栏编辑器。 */
    /* busy 档住「拆分镜」重入；面板本体归 AiStream 管。这一份状态对象带回执：
       流回来时若 splitUI 已经换人（重开 / 取消），旧的这一趟不碰新的。 */
    const mineUI = { phase: 'stream', busy: true, kind: 'split' };
    splitUI = mineUI;
    let txt;
    try {
      txt = await AiStream.text(REGOf(), sys, userOfRun() + (an ? '\n\n' + an : ''),
        { host: splitHost(run), title: 'AI 正在往下拆分镜…',
          media: mediaPrep.media });
    } finally {
      /* 流断了 / 用户停了也让 busy 归零：留着它下一次点「拆分镜」会被自己挡在门外 */
      if (splitUI === mineUI) splitUI = null;
    }
    if (!splitAlive(run)) return null;   // 取消：这一趟的结果不再用（弹窗已收，面板不在屏幕上）
    draft = parseJsonLoose(txt);
    const items = itemsOfDraft(draft);
    if (!items.length) throw new Error(draft ? 'AI 输出里没有镜头' : 'AI 没有给出可用的分镜结构');
    /* 长镜头在**打开审查弹窗之前**按接续型号拆成几段：整段没有任何型号吃得下时才拆，
       总秒数守恒、第 2 段起标 `chain:'tail'`，台词只在第 1 段。拆完的每一段都进同一个弹窗，
       用户能看到「2/3」与「接上一镜」，也能在写入前删掉不想生成的段。 */
    splitInfo = splitLongShots(items, {
      models: chainModelList(), canDur: durWritable(), maxName: 12,
    });
    const out = splitInfo.items;
    lastOut = out;
    /* ---- 第 4 段：这份方案里有没有「该新建一条素材」的主体 ----
       问的是**这一份方案本身**（不是原剧本）—— 判据是「在几个镜头里反复出现」，
       那要看拆出来的镜头才知道。指令正文来自 Skill（contract `board_assets.json`），
       判据（重复出现才算、名字要对得上、库里已有的不建）在 board-assets.js。
       同样支持 Skill 正文里的变量（项目引用规则）：
         · `{board}` —— 这一份分镜方案（要判「谁反复出现」就看它）
         · `{cast}` —— 素材库里已经有的那些（已有的不建，要告诉 AI）
         · `{assets}` —— 这一次选中的素材
       问失败**不拦**这一趟拆分：照实报一句，按「不建新素材」继续 ——
       与 SplitAssets.stage 现有的语义一致（没问成 ≠ AI 说不要）。 */
    if (!newAssets) await stageAssetsOf(out);
    if (!splitAlive(run)) return null;
    return out;
  };
  let items;
  try {
    setStatus('AI 正在往下拆分镜…（长剧本可能需要十几秒）');
    /* 反问那一轮（与「AI 润色」同一套两段式）：AI 自己判断这段剧本值不值得先问；
       问答面板摆在过程弹窗上（splitUI 托管，整列重画冲不到它），回答当硬约束带进生成轮。
       问与拆共用同一份 sys（sysOfRun），所以素材挑选先做。 */
    await ensureStaged();
    if (!splitAlive(run)) return;
    answers = await askRound({ kind: 'split', sys: sysOfRun(), user: userOfRun(), focus: SPLIT_ASK_FOCUS,
      media: mediaPrep.media });
    if (!splitAlive(run)) return;
    items = await ask();
    if (!splitAlive(run)) return;
  }
  /* 按停止（面板上那颗「停止」）与真失败分开收尾：停止是主动收尾，不摆红条 */
  catch (e) {
    splitEnd(run);
    setStatus(e && e.name === 'AbortError' ? '<span class="meta">已停止</span>'
      : '<span class="err">' + e.message + '</span>');
    return;
  }
  /* 审阅就地接手这张弹窗（shell）：不关不重开，屏幕中间只换一层内容。 */
  splitDlgReview = true;
  const reviewed = await PromptReview.openList({
    title: 'AI 分镜方案（确认后写入项目）',
    shell: splitDlg,
    /* 三句都写在这里：短片名、镜数与软上限那一档（和表单 hint 同一算式同一句）、
       时长区间以及它「按本机当前可用的几个型号共同支持范围」是怎么来的。
       区间来源不写明，「时长 5–10 秒」看着就像替某一家编的。 */
    sub: ((draft && draft.title ? ['短片名：' + draft.title] : [])
      .concat([softShotsNote(v.script, items.length), boardDurSub(),
        splitInfo && splitInfo.note ? splitInfo.note : '',
        splitInfo && splitInfo.impossible.length
          ? '其中 ' + splitInfo.impossible.length + ' 个长镜头没有能拆成合法接续片段的型号，已原样保留（写入后按各自型号上限夹回）'
          : '',
        picsInfoOf(mediaPrep, draftPicUnknown,
          unusedPicsOf(mediaPrep.pics, items.map(it => it.pics)
            .concat([draftPicChain, (splitInfo && splitInfo.picDropped) || []])),
          draftPicChain.length + ((splitInfo && splitInfo.picDropped) || []).length),
        staged.sub, '按场景分组，可逐条改名字、秒数、提示词与台词',
        '行上的场景名与现有清单对不上会另起一场；要并进已有场景，就把那一格改成它的原名'])).filter(Boolean).join(' · '),
    items, applyLabel: '追加到当前短片',
    /* 行上挂图缩略图要从这张表里取（src）—— AI 点的图按这一格渲染、可就地摘。 */
    pics: mediaPrep.pics,
    /* 这句不是把 sub 里那句「可逐条改」再说一遍：sub 说的是**这个弹窗里**能做什么，
       hint 说的是**写入之后**能做什么。删掉它会退回 web/ui/ui.js 里那句通用兜底
       （「可以逐条修改或删掉不想生成的画面」）—— 那才是和 sub 重复的一句。 */
    hint: '写入后每个镜头都能单独生成、多条生成、剪辑', retry: ask,
    /* 分镜这一族才走分组审阅；秒数那一格、总时长与估价三处一起听 `durWritable()` ——
       本机写不进秒数时，界面上不该求一个发不出去的数的和，更不该按它问价。 */
    mode: 'board', durEditable: durWritable(), estimate: boardEstimate,
    /* 台词与说话人一起列出来：AI 已经按剧本填了 `line` / `speaker`，
       先看得见、能改，再点「新建短片」；点写入后才落到 `sh.line` / `sh.lineWho`。 */
    lineEditable: true,
    /* 「待建素材」那块（可逐条改 / 可删）：确认后建档到项目组同名素材组 + 出图 + 绑音色描述。
       这一块的内容是**第 4 段**问出来的（哪些角色/场景/物品会重复出现）。 */
    assetEditable: true,
    assets: (newAssets && newAssets.plan) || [],
    onAssets: (list) => { chosenAssets = list || []; },
    /* 「按这句再改」（审查弹窗里那一行）：弹窗把**此刻这份**（含用户手改）递回来当底稿，
       AI 按 split_follow 契约在它上面改一轮（输出改后的**完整方案**），流式画在弹窗里。
       方案变了 → 待建素材判定跟着重问一轮，assets 一起交回去换（改过的素材条目弹窗会保住）。 */
    onFollow: async (askText, ctl, current) => {
      const sys = `${TL_SYS_COMMON}
${fillSkillVars(TextAI.prompt('split_follow'), varsOf(boardListOfItems(current), askText))}`;
      const msg = '当前这份分镜方案（就在屏幕上，你要在**这一份**上改）:\n' + boardListOfItems(current)
        + '\n\n调整要求：' + askText
        + userNoteLine(v)
        + (answers ? '\n\n' + TextAI.answersNote(answers) : '');
      const txt = await TextAI.chatStream(REGOf(), sys, msg,
        { signal: ctl.signal, media: mediaPrep.media }, ctl.push);
      draft = parseJsonLoose(txt);
      let next = itemsOfDraft(draft);
      if (!next.length) throw new Error('AI 的调整结果里没有镜头');
      /* 长镜头拆分与「第一镜不接」的抹平走与生成轮同一条路：splitInfo 换新，落盘口径不变。 */
      splitInfo = splitLongShots(next, { models: chainModelList(), canDur: durWritable(), maxName: 12 });
      next = splitInfo.items;
      lastOut = next;
      newAssets = null;
      /* follow 轮里还要再问一轮「哪些主体要新建」——慢的那一步在弹窗里说一声（ctl.note），
         不让用户盯着一动不动的清单猜它在干嘛。 */
      if (typeof ctl.note === 'function') ctl.note('正在看这份方案里有哪些要新建的素材…');
      await stageAssetsOf(next);
      /* 这一轮 AI 又把图点给接续镜时，弹窗底行照实说一句（清单里那些图已经摘掉）。 */
      const chainDropN = draftPicChain.length + ((splitInfo && splitInfo.picDropped) || []).length;
      if (chainDropN && typeof ctl.note === 'function') {
        ctl.note(chainDropN + ' 张图挂在接上一镜的镜头上没挂（首尾帧不收参考图）');
      }
      return { items: next, assets: (newAssets && newAssets.plan) || [] };
    },
    followPlaceholder: '还要怎么改？例：第 3 镜短一点 / 结尾加一个雨夜空镜 / 台词都删掉',
    retryAssets: async () => {
      /* 「重新规划」只重问**第 4 段**（新素材判定，stageAssetsOf）：
       以前整体重跑 ask()，把拆分镜那次文字 AI 也再花一遍钱，而它的产物（新 items）
       被丢掉、draft.title 却换成了新那一次的 —— 确认后就成了「新一次的片名配旧一次的镜头」。 */
      newAssets = null;
      await stageAssetsOf(lastOut || items);
      return (newAssets && newAssets.plan) || [];
    },
  });
  /* 弹窗在确认 / 取消那一下已经自己关了：这一趟的句柄一起清掉（留着的只是过期节点） */
  splitDlg = null; splitDlgRun = null; splitDlgReview = false; splitUI = null;
  /* 空数组也要当「没采纳」接住：openList 的确认会把正文为空的条目滤掉，
     全部被滤掉时它给的是一份空表而不是 null（只看 !reviewed 会带着空表往下走）。 */
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  /* 按交回来的**场名**归组重建。条目在这一场里的先后就是用户在弹窗里拖出来的先后 ——
     `shotNo` 只给报告与标签用，这里一律按数组顺序落盘（更早是拿标签正则回查序号）。 */
  const newScenes = [];
  /* AI 点的随附图先收对儿、最后统一挂（bindPics 走 panel.js 那套有闸的挂图）：
     报数也聚成一份，不混进素材图那笔账。 */
  const picPairs = [];
  /* 落盘前再兜一次：接上一镜的镜头一律不挂随附图（首尾帧与参考图互斥）。
     审查弹窗里图已经被摘掉，这一份是防手改 / 旧数据漏过来的。 */
  let writePicChain = 0;
  reviewed.forEach(row => {
    const scName = String(row.scene || '').trim() || ('场景 ' + (newScenes.length + 1));
    let sc = newScenes.find(s => s.name === scName);
    if (!sc) { sc = { id: uid(), name: scName, shots: [] }; newScenes.push(sc); }
    const sh3 = newShot();
    /* 描述与配置都落在**默认候选**上（这一镜的第一条候选镜头）。 */
    const def3 = defaultTakeOf(sh3);
    sh3.name = String(row.name || '').trim().slice(0, 12) || ('镜头 ' + (sc.shots.length + 1));
    setShotPrompt(sh3, String(row.text || ''));
    /* 时长原样接 AI 那一个（或用户在弹窗里改的那一个）：现在已经没有「用户填的目标时长」可兜底，
       也没有一份全站通用的秒数能洗。AI 没给、或本机没有能判合法的声明时**不写这一项** ——
       镜头上没有 duration 等于「交给平台默认」，与右栏那句「这一家没声明区间就不碰」同一个立场；
       给了但越界的由下面那一夹按型号收进区间并报数。 */
    setShotDur(sh3, row.dur);
    /* 台词与画面说明两个字段各归各位：台词只写在 `sh.line`（不进候选的描述、不进配音轨），
       画面说明整条留在 `sh.note`（不再被压成名字）。两者都按用户可能在弹窗里改过的那一份落。 */
    sh3.line = String(row.line || '').trim();
    sh3.lineWho = String(row.who || '').trim();
    sh3.note = String(row.note || '').trim();
    /* 接上一镜（拆分长镜头的第 2 段起 / AI 明确标了的镜头）：拆的时候挑好的接续型号一起落下，
       没带型号的（AI 手写 `chain`）由 `ensureChainModel` 现挑一个能接首帧的。
       显式首帧永远优先 —— 这一路还没有首帧，等生成时解析上一镜尾帧。 */
    if (def3) def3.linkPrev = row.chain === 'tail' ? 'tail' : '';
    /* 拆分长镜头的每一段（包括第 1 段）都按拆的时候挑的型号落：那几段的秒数就是照它的区间分的，
       第 1 段若退回别的型号，落盘后的夹取会把「总秒数守恒」拆掉。 */
    if (row.chainModel && def3) { def3.model = String(row.chainModel); def3.modelAuto = 'chain'; }
    if (def3 && def3.linkPrev) ensureChainModel(sh3, def3);
    sc.shots.push(sh3);
    if (row.chain === 'tail' && Array.isArray(row.pics) && row.pics.length) writePicChain += row.pics.length;
    if (mediaPrep.usable && row.chain !== 'tail' && Array.isArray(row.pics) && row.pics.length) {
      picPairs.push({ sh: sh3, idxs: row.pics });
    }
  });
  /* 写入期兜底：批量生成走 genAll → submitCandidate，提交体发的是候选的请求时长
     （`c.dur`）原值，而「按型号回写」那一句只在**打开这一镜右栏**时执行 —— 这条链一次都不跑。
     用户不逐镜点开、直接点「生成全部分镜」，平台收到的就是越界时长。
     镜头对象是活引用（追加那一支里 placeScenesInto 也只是把它们挪进已有场景），夹在这里就等于夹在账上。 */
  const clamped = clampShotDurations(newScenes.flatMap(sc => sc.shots || []));
  /* 带台词那一档的报数与出路写在同一句里：只说「N 镜有台词」而不指着落点，
     等于让用户以为台词已经进配音轨了（它没有，也永远不该由拆分镜自己发请求）。 */
  const linedN = newScenes.reduce((n, sc) => n + (sc.shots || []).filter(x => (x.line || '').trim()).length, 0);
  const lineNote = linedN ? lineLandedNote(linedN) : '';
  /* 接续镜的报数与「首帧从哪来」写在同一句里：用户看见「接上一镜」这四个字，
     但真正要告诉他的下一句是「你不用手动填首帧，生成时自动取」。 */
  const chainN = newScenes.reduce((n, sc) => n + (sc.shots || []).filter(x => cfg(x).linkPrev === 'tail').length, 0);
  const chainNote = chainN ? '，其中 ' + chainN + ' 镜接上一镜尾帧（生成时自动取首帧）' : '';
  /* 素材图挂在场景图**之后**：两者抢的是同一批参考图名额，先让「这一场的图」占位，
     素材那几张带不上时会照实报「参考图最多 N 张」，而不是静默少带几张。 */
  /* ---- 新素材（用户认下的那几条）：建档 + 占位符 ----
     建档落在**当前短片所在的项目组**同名素材组里（组名即素材组名）。
     出图**不在这里自动发**：出图要花钱，按「任务号一落盘就等于一次已付的钱」，
     留给用户在素材库里点「生成素材图」—— 这里只把档建好、把提示词里的占位符写上。 */
  const allShots = newScenes.flatMap(sc => sc.shots || []);
  const assetGroup = Groups.assetGroupName(WSOf(), projOf());
  const landed = landNewAssets(chosenAssets || [], assetGroup);
  /* 场景 ↔ 库里那条场景素材互记 id（14.2-4）：`sc.sceneLibId` 记下后喂图按 id（改名不断、
     同名两条各绑各的）；老工程没绑的仍按名字兜底一次（只读不写，见 scenePicOf）。
     名字比较是**严格比较**（与存盘合并同尺）—— 归一比较只留给 AI 报名解析那条兜底。 */
  (landed.saved || []).filter(x => x && x.kind === 'scene' && x.id).forEach(e => {
    const nm = String(e.name || '').trim();
    newScenes.forEach(sc => {
      if (!sc.sceneLibId && String(sc.name || '').trim() === nm) sc.sceneLibId = e.id;
    });
  });
  markPendingTokens(allShots, landed.saved);
  const assetNote = landed.saved.length
    ? '，新建素材 ' + landed.saved.length + ' 条（'
      + (landed.group ? '组「' + landed.group + '」' : '未分组') + '，出图后自动补进参考图）'
    : (landed.failed.length ? '，有 ' + landed.failed.length + ' 条素材没建出来' : '');
  if (landed.failed.length) {
    Toast.warn('有素材没建出来：' + landed.failed.map(f => f.name + '（' + f.why + '）').join('、'));
  }
  if (landed.why) Toast.warn(landed.why);
  /* 追加要保住场景划分（判据在 placeScenesInto 那一份，探针问的就是它）：
     以前是 `newScenes.forEach(sc => cur.shots.push(...sc.shots))` —— AI 拆出来的几个场景
     全被压进「当前那一场」，左栏既看不出分过场，场景图也失去了归属。 */
  const r0 = placeScenesInto(projOf().scenes, newScenes, { append: true });
  projOf().curScene = r0.at; projOf().curShot = 0;
  /* 挂图顺序：场景图（placeScenesInto）→ AI 随附图 → 素材图（bind 在 reportScenePics 里跑）。
     三路抢同一批参考图名额，AI 点的图是用户亲手挑的，排在素材图前面。 */
  const picRes = SplitAssets.bindPics(picPairs, mediaPrep.pics);
  const chainDropN = draftPicChain.length + writePicChain;
  const chainPicNote = chainDropN
    ? '；' + chainDropN + ' 张随附图挂在接上一镜的镜头上没挂（首尾帧不收参考图）' : '';
  reportScenePics(r0.pics,
    `已追加 ${reviewed.length} 个镜头：并进 ${r0.merged} 个同名场景` + (r0.created ? '、新建 ' + r0.created + ' 个场景' : '')
    + chainNote + chainPicNote + lineNote + assetNote + clampNote(clamped),
    SplitAssets.bind(allShots, staged.picked), picRes);
  renderAll(); scheduleSave();
  /* 14.2-1：新素材可以顺便出预览图（确认框勾了才排队 —— 花钱任务不自动发）。
     不等出图结果：拆分镜本身已经落盘，出图是后面几步，用户可以先去干别的。 */
  if (landed.saved.length) maybeFillNewAssetPics(landed.saved).catch(() => {});
}
/* 「修改现有分镜」这一档：现有清单 + 用户那一句话 → changes → 账 → 审查弹窗 → 落盘。
   没有任何「AI 看一眼就自动写入」：改的是用户已经生成过的分镜，确认那一下是唯一入口。 */
async function aiBoardEdit(v) {
  const snap = snapBoard(projOf().scenes);
  const want = String(v.instruct || '').trim();
  /* 这一趟的身份（与拆新那一路同一套）：取消 / 被新一轮顶掉后不再往下画 */
  const run = { dead: false, kind: 'edit' };
  splitRun = run;
  let staged = null;
  /* 随附参考图 → 多模态输入（与拆新那一路同一套准备与能力闸）。 */
  const mediaPrep = await prepareRefPics(v.pics);
  if (!splitAlive(run)) return;
  /* 反问那一轮的回答：与拆新那一路同一套（askRound），一趟只问一次。 */
  let answers = null;
  /* 素材挑选收进过程面板（同 aiBoardSplit 的 ensureStaged）。这一档没有剧本，
     用来挑素材的那句话就是上面那一格填的「修改要求」；没填时 stage 会说
     「没给出用来挑素材的话，这一次没问」，而不是假装挑了 0 条。 */
  const ensureStaged = async () => {
    if (staged) return staged;
    const mine = { phase: 'loading', busy: true, kind: 'edit', note: '正在按素材范围挑这一次要用的素材…' };
    splitUI = mine;
    renderSplitPanel();
    staged = await SplitAssets.stage(REGOf(), want, v.assetSrc, v.refRule);
    if (splitUI === mine) splitUI = null;
    if (staged.warn) Toast.warn(staged.warn);
    return staged;
  };
  /* 「按这句再改」成功过的那几句：之后的重新规划也带着它们 ——
     它们已经是修改要求的一部分，重跑时丢掉等于替用户改主意。 */
  let followAsks = [];
  const wantAll = extra => [want].concat(followAsks, extra ? [extra] : []).filter(Boolean).join('\n');
  /* 同样支持 Skill 正文里的变量（项目引用规则）：
     `{what}` = 这一次的修改要求、`{board}` = 现有分镜清单、
     `{cast}` = 本项目素材库里的角色 / 场景 / 物品、`{assets}` = 这次选中的素材、
     `{dur}` = 时长区间那句。 */
  const varsOf = whatText => BoardVars.vars({
    what: whatText === undefined ? want : whatText,
    cast: BoardVars.castOf(SplitAssets.named()),
    assets: BoardVars.assetsOf(staged ? staged.picked : [], x => (window.Chars && Chars.descOf) ? Chars.descOf(x) : ''),
    board: boardListText(snap),
    dur: boardDurNote(),
  });
  /* 反问轮与生成轮同一份拼法（同 aiBoardSplit 的 sysOfRun / userOfRun）。 */
  const sysOfRun = whatText => `${TL_SYS_COMMON}
${fillSkillVars(boardEditSysOf(), varsOf(whatText))}
约束：改几处、加几镜由你决定，不必凑数。${boardDurNote()}${staged.rule}`;
  const userOfRun = whatText => '当前分镜清单（下面的序号就是改动要用的序号）:\n' + boardListText(snap)
    + '\n\n修改要求：' + (whatText || '（没有具体说改哪里）把写得不够好的提示词整体优化一遍')
    + userNoteLine(v);
  const ask = async (ctl, extraAsk) => {
    await ensureStaged();
    if (!splitAlive(run)) return null;
    const wt = wantAll(extraAsk);
    const sys = sysOfRun(wt);
    /* 反问那一轮用户答过的东西随正文一起交上去：每条答案都是硬约束。 */
    const an = TextAI.answersNote(answers || '');
    const body = userOfRun(wt) + (an ? '\n\n' + an : '');
    /* 带 ctl = 审查弹窗里「按这句再改」那一轮：流式画进弹窗（ctl.push，可中止）；
       不带 = 首轮与「重新规划」：流式画在过程弹窗的正文格里（与拆新同一张）。 */
    const mineUI = { phase: 'stream', busy: true, kind: 'edit' };
    splitUI = mineUI;
    let txt;
    try {
      txt = await (ctl
        ? TextAI.chatStream(REGOf(), sys, body, { signal: ctl.signal, media: mediaPrep.media }, ctl.push)
        : AiStream.text(REGOf(), sys, body, { host: splitHost(run), title: 'AI 正在修改分镜…', media: mediaPrep.media }));
    } finally {
      if (splitUI === mineUI) splitUI = null;
    }
    if (!splitAlive(run)) return null;   // 取消：这一趟的结果不再用（弹窗已收）
    const j = parseJsonLoose(txt);
    const changes = (j && (j.changes || j.edits)) || null;
    if (!changes || !changes.length) throw new Error('AI 没有给出可用的修改');
    /* pics 传的是下标表本体：型号不识图时 prepareRefPics 给空表，AI 写来的任何图号都会落进
       unknown、一张也挂不上 —— 与「没给 AI 看」的口径一致。 */
    const plan = boardPlanOf(changes, snap, mediaPrep.pics);
    if (!plan.items.length) throw new Error(plan.skipped
      ? 'AI 给的修改对不上现有镜头（对不上的有 ' + plan.skipped + ' 条）'
      : 'AI 给的修改和现状一样，没有可改的');
    return plan;
  };
  let plan;
  try {
    setStatus('AI 正在读现有分镜并改…');
    /* 反问那一轮（与拆新同源）：AI 看着这份修改要求判断要不要先问几句再动刀。 */
    await ensureStaged();
    if (!splitAlive(run)) return;
    const wt0 = wantAll();
    answers = await askRound({ kind: 'edit', sys: sysOfRun(wt0), user: userOfRun(wt0), focus: EDIT_ASK_FOCUS,
      media: mediaPrep.media });
    if (!splitAlive(run)) return;
    plan = await ask();
    if (!splitAlive(run)) return;
  }
  /* 与拆新那一路同一副收尾：停止不摆红条 */
  catch (e) {
    splitEnd(run);
    setStatus(e && e.name === 'AbortError' ? '<span class="meta">已停止</span>'
      : '<span class="err">' + e.message + '</span>');
    return;
  }
  const bits = ['共 ' + plan.items.length + ' 处改动'];
  if (plan.noop) bits.push(plan.noop + ' 条与现状相同已忽略');
  if (plan.skipped) bits.push(plan.skipped + ' 条对不上已丢掉');
  if (plan.chainRefused) bits.push(plan.chainRefused + ' 镜已有参考素材，没改成接上一镜');
  bits.push(picsInfoOf(mediaPrep, plan.picUnknown,
    unusedPicsOf(mediaPrep.pics, plan.items.map(it => (it.patch && it.patch.pics) || [])
      .concat([plan.picChain])),
    plan.picChain.length));
  if (staged.sub) bits.push(staged.sub);
  /* 审阅就地接手这张弹窗（shell）：与拆新那一路同一条交接。 */
  splitDlgReview = true;
  const reviewed = await PromptReview.openList({
    title: 'AI 分镜修改（确认后写入项目）',
    shell: splitDlg,
    sub: bits.join(' · ') + '；' + boardDurSub() + '；可逐条改提示词或删掉不想要的',
    items: plan.items, applyLabel: '写入这些改动',
    /* 行上挂图缩略图要从这张表里取（src）。 */
    pics: mediaPrep.pics,
    hint: '写入后每个镜头都能单独生成、多条生成、剪辑',
    retry: async () => (await ask()).items,
    empty: 'AI 没有给出能对得上的修改，请点「重新规划」或取消',
    /* 「按这句再改」：对着当前改动清单补一句要求 → 整轮重跑（board_edit 契约认序号清单，
       清单没变、要求多了这一句），成功才把这句记进 followAsks（之后的重新规划也带着）。 */
    onFollow: async (askText, ctl) => {
      const plan2 = await ask(ctl, askText);
      followAsks.push(askText);
      /* 这一轮 AI 又把图点给接续镜 / 想把有图的镜头改成接续时，弹窗底行照实说一句
         （清单里已经按互斥收敛）。 */
      if (ctl && typeof ctl.note === 'function') {
        const notes = [];
        if (plan2.picChain.length) {
          notes.push(plan2.picChain.length + ' 张图挂在接上一镜的镜头上没挂（首尾帧不收参考图）');
        }
        if (plan2.chainRefused) notes.push(plan2.chainRefused + ' 镜已有参考素材，没改成接上一镜');
        if (notes.length) ctl.note(notes.join('；'));
      }
      return plan2.items;
    },
    followPlaceholder: '还要怎么改？例：第 3 镜那条改短一点 / 只改画面别动台词',
  });
  splitDlg = null; splitDlgRun = null; splitDlgReview = false; splitUI = null;
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  const r = applyBoardPlan(reviewed, projOf().scenes, mediaPrep.pics);
  /* 「接上一镜」写入后落到一个支持首帧的型号上：`applyBoardPlan` 只管数据，
     型号是对着能力声明挑的（`chainModelList`），属于页面这一层。 */
  r.touched.forEach(sh => ensureChainModel(sh));
  if (r.at) { projOf().curScene = r.at.scene; projOf().curShot = r.at.shot; }
  renderAll(); scheduleSave();
  reportScenePics(r.pics, '已改 ' + r.upd + ' 个镜头'
    + (r.add ? '、新增 ' + r.add + ' 个镜头' : '')
    + (r.del ? '、删掉 ' + r.del + ' 个镜头' : '')
    + (r.mov ? '、挪动 ' + r.mov + ' 个镜头' : '')
    + (r.newScenes ? '、新开 ' + r.newScenes + ' 个场景' : '')
    + (r.chained ? '、' + r.chained + ' 镜改为接上一镜尾帧' : '')
    + (r.unchained ? '、' + r.unchained + ' 镜取消接续' : '')
    /* 「带上了台词」这句必须跟着指出落点：用户不知道点哪儿就等于没给。
       话里不写「已合成」—— 这一次一个字都没合成（计费只在用户点「合成并加到这一轨」那一下）。 */
    + (r.lined ? lineLandedNote(r.lined) : '')
    + (r.busy ? '；' + r.busy + ' 镜还在生成，没删（等它跑完再删）' : '')
    + (r.skipped ? '（' + r.skipped + ' 条在写入时没找到目标，已跳过）' : '')
    + clampNote(r.clamped), SplitAssets.bind(r.touched, staged.picked),
    /* AI 随附图那笔账单列一项（不混进素材图）：unknown 在弹窗 sub 里已报过，这里不重复。 */
    { n: r.picN, shots: r.picShots, dup: r.picDup, why: r.picWhy });
}

  return {
    aiStoryboard,
    renderSplitPanel,
  };
}
