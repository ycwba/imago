/* 导演台Apply域：由 engine.js 按域机械搬出（内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createApply(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { parseJsonLoose, reEscape } from '../util.js';
import { splitLongShots } from '../chain.js';

export function createApply(E, document, window) {
  const {
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
    renderAll,
    switchProject,
    setStatus,
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

/* ---------- 拆分镜 / 改分镜的「AI 反问」那一轮（与润色同一套两段式）----------
   过程状态存 splitUI：编辑器整列会被反复重画（任务轮询 3 秒一次），面板内容由重画钩子
   renderSplitPanel 按这份状态拼回来 —— 与 engine 的 polishUI 同一个理由、同一套机制。
     · phase 'loading'：转圈占位（挑素材 / 判断要不要反问 / 新素材判定那些段）；
     · phase 'ask'：问答面板（每题候选 + 自由输入框，InlinePolish.ask）；
     · phase 'stream'：流式那段**不插手** —— AiStream 每次 push 前自己确认面板还在宿主里、
       不在就重画一块并把已收到的字补回去（见 gen-forms.js 的 panel()）。
   busy 只在「真在跑」的段为真：问答摆出来等人回答时不算忙 —— 用户这时再点一次「拆分镜」
   是正当操作（上一趟他可能已经不想管了），新一轮照常开，旧的那份等答 Promise 由
   splitUI 换人作废（闭包里多等一个引用，不占资源）。 */
let splitUI = null;
function renderSplitPanel() {
  if (!splitUI) return;        // 没在跑：宿主归润色面板管（renderPolishPanel 已 clear 过），也不必补宿主
  let host = $('polishInline');
  if (!host) {
    /* 空项目（还没有任何镜头）时镜头编辑器整栏是空的、连宿主都没有 —— 而「拆一份新的」
       恰恰常从空项目发起。这里补一块空档当宿主；有镜头时宿主由编辑器自己画，这里不插手
       （剪辑态的右栏是另一套，也不该塞）。 */
    const col = $('edCol');
    if (!col || allShots().length) return;
    col.innerHTML = '<div id="polishInline" hidden></div>';
    host = $('polishInline');
  }
  if (splitUI.phase === 'loading') { InlinePolish.loading(host, splitUI.note || '正在准备…'); return; }
  if (splitUI.phase !== 'ask' || !splitUI.questions || !splitUI.questions.length) return;
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
    onSubmit: t => { if (splitUI === mine) { splitUI = null; InlinePolish.clear(host); mine.resolve(t); } },
    onSkip: () => { if (splitUI === mine) { splitUI = null; InlinePolish.clear(host); mine.resolve(''); } },
  });
}
/* 反问那一轮：AI 自己判断这段料值不值得先问（need=false 直接往下走）；问了就把面板摆出来
   等人回答，返回回答正文（跳过 / 没问出来 / 设置选「从不问」都返回 ''）。
   sys / user 与生成那一轮同源（同一份 Skill 变量、同一份上下文）—— 问出来的问题才贴着
   这一次的料（时长区间、已有角色都看得见，不会问「每镜几秒」这种系统提示里已经写明的事）。
   一趟只调一次（调用方把返回值记住），审查弹窗里点「重新规划」按同一份回答重跑。 */
async function askRound(o) {
  const kind = o.kind || 'split';
  if (!TextAI.shouldAsk()) return '';                    // 设置选「从不问」：整轮不发
  splitUI = { phase: 'loading', busy: true, kind,
    note: '正在读' + (kind === 'edit' ? '这份修改要求' : '剧本') + '，判断要不要先问你几个问题…' };
  renderSplitPanel();
  let r = { need: false, questions: [] };
  try { r = await TextAI.askPolish(REGOf(), o.sys, o.user, { focus: o.focus }); }
  catch (e) { /* 问不成不拦这一趟：照旧直接拆，与润色「跳过问答直接润色」同一个立场 */ }
  const qs = (r && r.need && Array.isArray(r.questions)) ? r.questions : [];
  if (!qs.length || !splitUI) {
    splitUI = null; InlinePolish.clear($('polishInline'));
    return '';
  }
  setStatus('AI 有几个问题想先问清楚（也可以跳过）');
  const mine = splitUI;
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
    const p = String((sh && sh.prompt) || '');
    if (!p) return;
    sh.prompt = p.replace(re, m => {
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
    { key: 'task', type: 'select', label: '要做什么', value: 'new', options: [
      { v: 'new', t: '拆一份新的（贴剧本 → 新建短片）' },
      { v: 'edit', t: '修改现有分镜（改提示词 / 名字 / 时长、加镜头）' },
      { v: 'append', t: '接着往下拆（在现有分镜后面继续加）' },
    ] },
    { key: 'script', type: 'textarea', label: '剧本 / 文案', placeholder: '把故事、旁白或分镜草稿粘进来…', hint: '' },
    { key: 'instruct', type: 'textarea', label: '修改要求（说给 AI 的一句话）', placeholder: '例：把河岸那两镜的提示词写得更具体、光偏黄昏；第 3 镜后面加一个特写', hint: '不填就是整体优化一遍现有提示词', hidden: true },
  ];
  if (scopes.length) fields.push({ key: 'assetSrc', type: 'select', label: '素材范围',
    value: SplitAssets.last(), options: scopes,
    hint: '写进提示词的 @名字 在确认写入时挂成参考图（选「不导入素材」就一个字也不喂）' });
  fields.push({ key: 'note', type: 'text', label: '发给 AI 的备注（可选）',
    placeholder: '例：整体偏冷色 · 节奏快一点', hint: '只给 AI 看，不进提示词' });
  const v = await PromptForm.open({
    title: 'AI 分镜（拆新 / 改现有 / 加镜头）',
    sub: '贴一段剧本拆一份新的；或者对着现有分镜说一句话让它改 / 接着往下拆',
    okLabel: '开始',
    fields: fields,
    onChange: (key, api) => {
      const cur = api.values();
      /* 「这一档要哪几行、各行怎么说」现读，不在 fields 里写死两份（初值那份会被这一次调用盖掉）。
         时长与镜数**不再是输入框**：区间来自可用型号声明的交集，镜数只给一句软上限预估，
         它既不截断也不禁用「开始」。 */
      const t = cur.task;
      api.set('script', {
        label: t === 'append' ? '接着往下拆的文案' : '剧本 / 文案',
        hint: (t === 'append'
          ? '会连着上面已有分镜往下拆：沿用合适的场景名与画风、不重复已有的镜头。'
          : '越长越好用；会优先保持你的原意，只补足画面细节。') + softShotsNote(cur.script),
        hidden: t === 'edit',
      });
      /* 「改现有分镜」这一档同样能带素材（改提示词时把库里的角色名认回来），所以整块不收；
         但用来挑素材的那句话换成上面那一格填了什么 —— 这一档没有剧本，只有那句要求。 */
      if (key !== 'task') return;
      api.set('instruct', { hidden: t !== 'edit' });
    },
    validate: o => {
      if (o.task !== 'new' && !hasBoard) return '当前短片还没有分镜，这一档用不了；先选「拆一份新的」';
      if (o.task === 'edit') return '';
      if ((o.script || '').length < 20) return o.task === 'append' ? '要接着拆的文案太短了（至少 20 个字）' : '剧本太短了（至少 20 个字）';
      return '';
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
        chain: t.chain === 'tail' ? 'tail' : '' })) });
  });
  return boardListText(scenes);
}

/* 「拆新 / 往下拆」这一档（老路 + 给 AI 附一份现有分镜）：
   往下拆时把现有分镜的清单一起喂过去 —— 它才能沿用场景名与画风、也不重复已有的镜头，
   这正是「拿原有分镜上的提示词来加新镜头」那条要求的落点。 */
async function aiBoardSplit(v) {
  const append = v.task === 'append';
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
    splitUI = { phase: 'loading', busy: true, kind: 'split', note: '正在按素材范围挑这一次要用的素材…' };
    renderSplitPanel();
    try { staged = await SplitAssets.stage(REGOf(), v.script, v.assetSrc, v.refRule); }
    finally { splitUI = null; InlinePolish.clear($('polishInline')); }
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
    splitUI = { phase: 'loading', busy: true, kind: 'split', note: '正在看这份方案里有哪些要新建的素材…' };
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
    /* 收尾把宿主让出来：接下来是审查弹窗（开着时面板就在它底下，弹窗关了不能留一块旧的转圈）。 */
    splitUI = null; InlinePolish.clear($('polishInline'));
  };
  /* 用户在审查弹窗里**最终认下的**那几条（可逐条改 / 可删）—— 落盘按这一份建档。 */
  let chosenAssets = null;
  /* 长镜头拆分的报数（note / impossible）：弹窗 sub 与落盘报告都读这一份，重跑时跟着换。 */
  let splitInfo = null;
  /* 系统提示词与正文这一趟只有一份拼法：反问轮与生成轮各取一次 —— 同源，
     问出来的问题才贴着这一次的料（时长区间、已有分镜、角色名单都看得见），不会问系统提示里已经写明的事。 */
  const sysOfRun = () => `${TL_SYS_COMMON}
${fillSkillVars(splitSysOf(), varsOf(append ? boardListText(snapBoard(projOf().scenes)) : ''))}
约束：由你决定拆几个镜头、每一镜多长。${boardDurNote()}${staged.rule}`;
  const userOfRun = () => `剧本/文案：\n${v.script}` + userNoteLine(v)
    + (append ? ('\n\n当前已有分镜（接着往下拆：沿用合适的场景名与画风、别重复已有的镜头）:\n'
      + boardListText(snapBoard(projOf().scenes))) : '');
  /* AI 回的那份 JSON → 审阅条目（生成轮与「按这句再改」两路共用同一份解析）：
     平的 {"shots":[…]} 折成一层无名场景、场名缺省、秒数原样带、长说明不砍。 */
  const itemsOfDraft = j => {
    if (j && Array.isArray(j.shots) && !Array.isArray(j.scenes)) {
      j.scenes = [{ shots: j.shots }];
    }
    const items = [];
    ((j && j.scenes) || []).forEach((sc, si) => {
      const scName = String(sc.name || '').trim() || ('场景 ' + (si + 1));
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
          /* AI 只在「必须紧接着上一镜落幅」时标 tail（见 split 的指令）；长镜头的第 2 段起
             由下面的 splitLongShots 自动补上。落盘写 `sh.linkPrev`，生成时取上一镜尾帧当首帧。 */
          chain: String(s.chain || '').trim() === 'tail' ? 'tail' : '',
          label: scName + ' · 镜头 ' + no + (dur ? '（' + dur + 's）' : '')
            + (String(s.line || '').trim() ? ' · 有台词' : ''),
        });
      });
    });
    return items;
  };
  const ask = async () => {
    await ensureStaged();
    const sys = sysOfRun();
    /* 反问那一轮用户答过的东西随正文一起交上去（TextAI.answersNote 是唯一一份拼法）：
       每条答案都是硬约束 —— Skill 正文的要求清单里也写了这一条。 */
    const an = TextAI.answersNote(answers || '');
    /* 长剧本动辄十几二十秒：这里同样边收边显（面板挂在右栏提示词块下面，
       与「AI 润色」共用那一块地方；两边都是用户手点的，不会同时开着）。 */
    splitUI = { phase: 'stream', busy: true, kind: 'split' };   // busy 档住「拆分镜」重入；面板本体归 AiStream 管
    const txt = await AiStream.text(REGOf(), sys, userOfRun() + (an ? '\n\n' + an : ''),
      { host: $('polishInline'), title: append ? 'AI 正在往下拆分镜…' : 'AI 正在拆解分镜…' });
    splitUI = null;
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
    /* 全新短片的第一镜没有上一镜可接：AI 标了也接不上，抹掉，不留一条永远在等的标记。 */
    if (!append && out.length && out[0].chain === 'tail') {
      out[0] = Object.assign({}, out[0], { chain: '', chainModel: '' });
    }
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
    return out;
  };
  let items;
  try {
    setStatus(append ? 'AI 正在往下拆分镜…' : 'AI 正在拆解分镜…（长剧本可能需要十几秒）');
    /* 反问那一轮（与「AI 润色」同一套两段式）：AI 自己判断这段剧本值不值得先问；
       问答面板摆在 #polishInline（splitUI 托管，整列重画不丢），回答当硬约束带进生成轮。
       问与拆共用同一份 sys（sysOfRun），所以素材挑选先做。 */
    await ensureStaged();
    answers = await askRound({ kind: 'split', sys: sysOfRun(), user: userOfRun(), focus: SPLIT_ASK_FOCUS });
    items = await ask();
  }
  catch (e) { splitUI = null; setStatus('<span class="err">' + e.message + '</span>'); return; }
  const reviewed = await PromptReview.openList({
    title: 'AI 分镜方案（确认后写入项目）',
    /* 三句都写在这里：短片名、镜数与软上限那一档（和表单 hint 同一算式同一句）、
       时长区间以及它「按本机当前可用的几个型号共同支持范围」是怎么来的。
       区间来源不写明，「时长 5–10 秒」看着就像替某一家编的。 */
    sub: ((draft && draft.title ? ['短片名：' + draft.title] : [])
      .concat([softShotsNote(v.script, items.length), boardDurSub(),
        splitInfo && splitInfo.note ? splitInfo.note : '',
        splitInfo && splitInfo.impossible.length
          ? '其中 ' + splitInfo.impossible.length + ' 个长镜头没有能拆成合法接续片段的型号，已原样保留（写入后按各自型号上限夹回）'
          : '',
        staged.sub, '按场景分组，可逐条改名字、秒数、提示词与台词'])).filter(Boolean).join(' · '),
    items, applyLabel: append ? '追加到当前短片' : '新建短片',
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
        { signal: ctl.signal }, ctl.push);
      draft = parseJsonLoose(txt);
      let next = itemsOfDraft(draft);
      if (!next.length) throw new Error('AI 的调整结果里没有镜头');
      /* 长镜头拆分与「第一镜不接」的抹平走与生成轮同一条路：splitInfo 换新，落盘口径不变。 */
      splitInfo = splitLongShots(next, { models: chainModelList(), canDur: durWritable(), maxName: 12 });
      next = splitInfo.items;
      if (!append && next.length && next[0].chain === 'tail') {
        next[0] = Object.assign({}, next[0], { chain: '', chainModel: '' });
      }
      lastOut = next;
      newAssets = null;
      await stageAssetsOf(next);
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
  /* 空数组也要当「没采纳」接住：openList 的确认会把正文为空的条目滤掉，
     全部被滤掉时它给的是一份空表而不是 null（只看 !reviewed 会带着空表往下走）。 */
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  /* 按交回来的**场名**归组重建。条目在这一场里的先后就是用户在弹窗里拖出来的先后 ——
     `shotNo` 只给报告与标签用，这里一律按数组顺序落盘（更早是拿标签正则回查序号）。 */
  const newScenes = [];
  reviewed.forEach(row => {
    const scName = String(row.scene || '').trim() || ('场景 ' + (newScenes.length + 1));
    let sc = newScenes.find(s => s.name === scName);
    if (!sc) { sc = { id: uid(), name: scName, shots: [] }; newScenes.push(sc); }
    const sh3 = newShot();
    sh3.name = String(row.name || '').trim().slice(0, 12) || ('镜头 ' + (sc.shots.length + 1));
    sh3.prompt = String(row.text || '');
    /* 时长原样接 AI 那一个（或用户在弹窗里改的那一个）：现在已经没有「用户填的目标时长」可兜底，
       也没有一份全站通用的秒数能洗。AI 没给、或本机没有能判合法的声明时**不写这一项** ——
       镜头上没有 duration 等于「交给平台默认」，与右栏那句「这一家没声明区间就不碰」同一个立场；
       给了但越界的由下面那一夹按型号收进区间并报数。 */
    setShotDur(sh3, row.dur);
    /* 台词与画面说明两个字段各归各位：台词只写在 `sh.line`（不进 `sh.prompt`、不进配音轨），
       画面说明整条留在 `sh.note`（不再被压成名字）。两者都按用户可能在弹窗里改过的那一份落。 */
    sh3.line = String(row.line || '').trim();
    sh3.lineWho = String(row.who || '').trim();
    sh3.note = String(row.note || '').trim();
    /* 接上一镜（拆分长镜头的第 2 段起 / AI 明确标了的镜头）：拆的时候挑好的接续型号一起落下，
       没带型号的（AI 手写 `chain`）由 `ensureChainModel` 现挑一个能接首帧的。
       显式首帧永远优先 —— 这一路还没有首帧，等生成时解析上一镜尾帧。 */
    sh3.linkPrev = row.chain === 'tail' ? 'tail' : '';
    /* 拆分长镜头的每一段（包括第 1 段）都按拆的时候挑的型号落：那几段的秒数就是照它的区间分的，
       第 1 段若退回别的型号，落盘后的夹取会把「总秒数守恒」拆掉。 */
    if (row.chainModel) { sh3.model = String(row.chainModel); sh3.modelAuto = 'chain'; }
    if (sh3.linkPrev) ensureChainModel(sh3);
    sc.shots.push(sh3);
  });
  /* 写入期兜底：批量生成走 genAll → submitCandidate，提交体发的是
     `sh.duration` 原值，而「按型号回写」那一句只在**打开这一镜右栏**时执行 —— 这条链一次都不跑。
     用户不逐镜点开、直接点「生成全部分镜」，平台收到的就是越界时长。
     镜头对象是活引用（追加那一支里 placeScenesInto 也只是把它们挪进已有场景），夹在这里就等于夹在账上。 */
  const clamped = clampShotDurations(newScenes.flatMap(sc => sc.shots || []));
  /* 带台词那一档的报数与出路写在同一句里：只说「N 镜有台词」而不指着落点，
     等于让用户以为台词已经进配音轨了（它没有，也永远不该由拆分镜自己发请求）。 */
  const linedN = newScenes.reduce((n, sc) => n + (sc.shots || []).filter(x => (x.line || '').trim()).length, 0);
  const lineNote = linedN ? lineLandedNote(linedN) : '';
  /* 接续镜的报数与「首帧从哪来」写在同一句里：用户看见「接上一镜」这四个字，
     但真正要告诉他的下一句是「你不用手动填首帧，生成时自动取」。 */
  const chainN = newScenes.reduce((n, sc) => n + (sc.shots || []).filter(x => x.linkPrev === 'tail').length, 0);
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
  if (append) {
    /* 追加要保住场景划分（判据在 placeScenesInto 那一份，探针问的就是它）：
       以前是 `newScenes.forEach(sc => cur.shots.push(...sc.shots))` —— AI 拆出来的几个场景
       全被压进「当前那一场」，左栏既看不出分过场，场景图也失去了归属。 */
    const r0 = placeScenesInto(projOf().scenes, newScenes);
    projOf().curScene = r0.at; projOf().curShot = 0;
    reportScenePics(r0.pics,
      `已追加 ${reviewed.length} 个镜头：并进 ${r0.merged} 个同名场景` + (r0.created ? '、新建 ' + r0.created + ' 个场景' : '')
      + chainNote + lineNote + assetNote + clampNote(clamped),
      SplitAssets.bind(allShots, staged.picked));
  } else {
    let added = 0, why = '';
    newScenes.forEach(sc => {                        // 新短片：场景本身还没有图，于是认素材库里同名那条
      const r = feedScenePics(sc, sc.shots);
      added += r.added; if (r.why && !why) why = r.why;
    });
    const np = { id: uid(), name: (draft && draft.title) || ('AI 短片 ' + window.dayKey(Date.now())), scenes: newScenes };
    WSOf().projects.push(np);
    switchProject(np.id);
    reportScenePics({ added: added, why: why },
      `已新建短片「${np.name}」：${newScenes.length} 个场景 / ${reviewed.length} 个镜头` + chainNote + lineNote + assetNote + clampNote(clamped),
      SplitAssets.bind(allShots, staged.picked));
  }
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
  let staged = null;
  /* 反问那一轮的回答：与拆新那一路同一套（askRound），一趟只问一次。 */
  let answers = null;
  /* 素材挑选收进过程面板（同 aiBoardSplit 的 ensureStaged）。这一档没有剧本，
     用来挑素材的那句话就是上面那一格填的「修改要求」；没填时 stage 会说
     「没给出用来挑素材的话，这一次没问」，而不是假装挑了 0 条。 */
  const ensureStaged = async () => {
    if (staged) return staged;
    splitUI = { phase: 'loading', busy: true, kind: 'edit', note: '正在按素材范围挑这一次要用的素材…' };
    renderSplitPanel();
    try { staged = await SplitAssets.stage(REGOf(), want, v.assetSrc, v.refRule); }
    finally { splitUI = null; InlinePolish.clear($('polishInline')); }
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
    const wt = wantAll(extraAsk);
    const sys = sysOfRun(wt);
    /* 反问那一轮用户答过的东西随正文一起交上去：每条答案都是硬约束。 */
    const an = TextAI.answersNote(answers || '');
    const body = userOfRun(wt) + (an ? '\n\n' + an : '');
    splitUI = { phase: 'stream', busy: true, kind: 'edit' };
    /* 带 ctl = 审查弹窗里「按这句再改」那一轮：流式画进弹窗（ctl.push，可中止）；
       不带 = 首轮与「重新规划」：还是右栏那块流式面板。 */
    const txt = await (ctl
      ? TextAI.chatStream(REGOf(), sys, body, { signal: ctl.signal }, ctl.push)
      : AiStream.text(REGOf(), sys, body, { host: $('polishInline'), title: 'AI 正在修改分镜…' }));
    splitUI = null;
    const j = parseJsonLoose(txt);
    const changes = (j && (j.changes || j.edits)) || null;
    if (!changes || !changes.length) throw new Error('AI 没有给出可用的修改');
    const plan = boardPlanOf(changes, snap);
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
    const wt0 = wantAll();
    answers = await askRound({ kind: 'edit', sys: sysOfRun(wt0), user: userOfRun(wt0), focus: EDIT_ASK_FOCUS });
    plan = await ask();
  }
  catch (e) { splitUI = null; setStatus('<span class="err">' + e.message + '</span>'); return; }
  const bits = ['共 ' + plan.items.length + ' 处改动'];
  if (plan.noop) bits.push(plan.noop + ' 条与现状相同已忽略');
  if (plan.skipped) bits.push(plan.skipped + ' 条对不上已丢掉');
  if (staged.sub) bits.push(staged.sub);
  const reviewed = await PromptReview.openList({
    title: 'AI 分镜修改（确认后写入项目）',
    sub: bits.join(' · ') + '；' + boardDurSub() + '；可逐条改提示词或删掉不想要的',
    items: plan.items, applyLabel: '写入这些改动',
    hint: '写入后每个镜头都能单独生成、多条生成、剪辑',
    retry: async () => (await ask()).items,
    empty: 'AI 没有给出能对得上的修改，请点「重新规划」或取消',
    /* 「按这句再改」：对着当前改动清单补一句要求 → 整轮重跑（board_edit 契约认序号清单，
       清单没变、要求多了这一句），成功才把这句记进 followAsks（之后的重新规划也带着）。 */
    onFollow: async (askText, ctl) => {
      const plan2 = await ask(ctl, askText);
      followAsks.push(askText);
      return plan2.items;
    },
    followPlaceholder: '还要怎么改？例：第 3 镜那条改短一点 / 只改画面别动台词',
  });
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  const r = applyBoardPlan(reviewed, projOf().scenes);
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
    + clampNote(r.clamped), SplitAssets.bind(r.touched, staged.picked));
}

  return {
    aiStoryboard,
    renderSplitPanel,
  };
}
