/* 导演台Apply域：AI 拆分镜的统一链（输入是新剧情 / 续写 / 修改要求都走同一条）——
   一次文字 AI 调用回一份完整方案（带 ref 改现有镜、不带 ref 加新镜），审查弹窗确认后
   `applyBoardFull` 落盘；附自动命名（短片 / 首场 / 占位首镜覆盖）、新素材建档与挂图。
   engine.js 按域机械搬出（内部保持命令式、按域拆模块），区间内的代码逐字保留，
   只有点名的几处引擎可变状态改经访问器读，区间外的名字一律由 createApply(E) 递进来。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { parseJsonLoose, reEscape } from '../util.js';
import { splitLongShots } from '../chain.js';
import { isUntouchedShot, isDefaultSceneName, isDefaultProjName } from '../board.js';
import { splitScriptGate } from '../split-form.js';
import { defaultTakeOf } from '../takes.js';

export function createApply(E, document, window) {
  const {
  cfg,
    WSOf,
    projOf,
    REGOf,
    Groups,
    PENDING_PREFIX,
    BoardAssets,
    BoardVars,
    fillSkillVars,
    TL_SYS_COMMON,
    splitSysOf,
    durWritable,
    boardDurNote,
    clampNote,
    chainModelList,
    ensureChainModel,
    snapBoard,
    boardListText,
    boardFullItemsOf,
    applyBoardFull,
    SplitAssets,
    scheduleSave,
    reportScenePics,
    boardEstimate,
    compressImg,
    renderAll,
    setStatus,
    toDataURL,
  } = E;

/* 「发给 AI 的备注」只有这一句拼法（拆分镜与批量润色共用同一句式，各自拼在自己的正文里）：
   它只进这一次请求的正文，不落到任何镜头的提示词上。 */
function userNoteLine(v) {
  return v.note ? '\n\n用户备注：' + v.note : '';
}
/* 随附素材（图片 / 视频 / 音频）→ 喂给文字 AI 的多模态输入。
   能力闸按**逐件**放行（prepareMedia 逐条记原因进 note）：型号不识图 / 不收视频音频、
   或某一条读不出来，那一件事先说清（note），没带上的不进「可挂镜的随附图」表；
   可挂镜的只有**图片**，按 mediaLegend 的图 N 序号单列（视频 / 音频只是 AI 的上下文）。 */
async function prepareAttachments(list) {
  const items = (list || []).filter(p => p && p.src);
  if (!items.length) return { pics: [], media: [], note: '', n: 0 };
  const m = await TextAI.prepareMedia(REGOf(), items.map(p => ({ kind: p.kind || 'image', label: p.label || '素材', src: p.src })));
  const sent = new Set(m.media.filter(x => !x.isMask).map(x => x.kind + '|' + x.label));
  const pics = items.filter(p => (p.kind || 'image') === 'image' && sent.has('image|' + (p.label || '素材')));
  return { pics, media: m.media, note: m.note || '', n: items.length };
}
/* 审查弹窗 sub 里「这次随附素材是什么状态」那几句的总拼：
   挂镜账（图N 没对上 / 没挂 / 接续互斥）之外，prepareMedia 的 note 原样带上 ——
   「已附带：…；没带：视频「X」没带（型号不收）」这类逐件报数全在那一句里。 */
function mediaInfoOf(mediaPrep, unknown, unused, chainDrop) {
  const bits = [];
  if (mediaPrep.pics.length) {
    let s = '随附参考图 ' + mediaPrep.pics.length + ' 张';
    if (unused && unused.length) s += '；图' + unused.map(i => i + 1).join('、图') + ' 没挂到任何镜头';
    if (unknown) s += '；有 ' + unknown + ' 个图号没对上，没挂';
    if (chainDrop) s += '；' + chainDrop + ' 张图挂在接上一镜的镜头上没挂（首尾帧不收参考图）';
    bits.push(s);
  }
  if (mediaPrep.n && mediaPrep.note) bits.push(mediaPrep.note);
  return bits.join('；');
}
/* 这一次随附的图里，AI 一张都没挂到任何镜头的是哪几张（下标表）。
   lists 是各行认领的图号下标。 */
function unusedPicsOf(pics, lists) {
  const used = new Set();
  lists.forEach(l => (l || []).forEach(i => used.add(i)));
  return (pics || []).map((p, i) => used.has(i) ? null : i).filter(x => x != null);
}

/* ---------- 拆分镜的「AI 反问」那一轮（与润色同一套两段式）----------
   过程状态存 splitUI；转圈 / 反问 / 流式都画在**一张居中弹窗**里（PromptReview.openProcess），
   拆完原地换成审阅（openList 传 shell，mount 只换标题接着用）—— 从头到尾只看见一张卡，
   屏幕中间不关不闪。弹窗不在任何整片重画的栏里，编辑器 3 秒一次的重画冲不到它；
   renderSplitPanel 仍跟着重画被叫，但只负责状态过渡（loading → ask）：
     · phase 'loading'：转圈占位（挑素材 / 判断要不要反问那些段）；
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
    size: 'workflow',
    title: 'AI 正在拆分镜…',
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
function splitAlive(run) {
  if (!run || splitRun !== run || run.dead) return false;
  if (projOf() !== run.project) { splitEnd(run); return false; }
  return true;
}
function splitEnd(run) {
  if (run) run.dead = true;
  if (splitRun !== run) return;
  const ui = splitUI, d = splitDlg, review = splitDlgReview;
  splitUI = null;
  splitDlg = null; splitDlgRun = null; splitDlgReview = false;
  if (ui && typeof ui.resolve === 'function') ui.resolve('');
  if (d) {
    if (review) d.dispatchEvent(new Event('cancel', { cancelable: true }));
    PromptReview.closeProcess(d);
  }
}
function renderSplitPanel() {
  if (!splitAlive(splitRun) || !splitUI) return;
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
    title: mine.title || '补充要求',
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
  const run = splitRun;
  if (!TextAI.shouldAsk()) { splitUI = null; return ''; }   // 设置选「从不问」：整轮不发
  const mine = { phase: 'loading', busy: true,
    note: '正在读这一次的正文，判断要不要先问你几个问题…' };
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
  mine.title = '补充要求';
  mine.submitLabel = '开始拆分';
  mine.skipLabel = '跳过';
  renderSplitPanel();
  const t = await new Promise(resolve => { mine.resolve = resolve; });
  return t || '';
}
/* 这一类活儿最值得先问的缺口（TextAI.askPolish 的 focus）：整片的画风与节奏、镜头语言取向 ——
   已写明的（时长区间、已有角色）别再问。 */
const BOARD_ASK_FOCUS = '整片的题材与风格基调、叙事节奏（每镜几秒、快剪还是多留白）、'
  + '要不要旁白、景别与镜头运动的取向';

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
    try {
      const result = await D.Pipe.drawPreview(reg, drama, item, { count: 1 });
      const desc = D.descOf(item);
      if (result.prompt && !desc.includes(result.prompt)) {
        item.look = [desc, result.prompt].filter(Boolean).join('\n\n');
      }
      D.Lib.save(item, { exact: true });
      const err = D.Lib.writeError();
      if (err) throw new Error(err);
      done++;
    } catch (e) { failed.push((item && item.name) || '?'); }
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
    /* 占位符落在**默认候选**身上（主描述的那一份）：cfg(sh) 会跟着「当前查看的候选」走，
       批量写入不能看用户此刻开着哪一格。 */
    const def = defaultTakeOf(sh);
    if (!def) return;
    const p = String(def.prompt || '');
    if (!p) return;
    def.prompt = p.replace(re, m => {
      if (m.charAt(0) === '@') return m;
      n++;
      return '@' + PENDING_PREFIX + ':' + m;
    });
  });
  return n;
}

/* 页头「拆分镜」那一颗的入口：一个输入格走全部（新剧情 / 续写 / 修改要求），
   AI 按输入与现有清单自己决定改哪几镜、加哪几镜（统一格式，见 split 契约）。
   写入是两段式：先给用户看一遍（可逐条改 / 删），确认才落盘。 */
async function aiStoryboard() {
  /* 上一趟还在真跑（挑素材 / 反问判断 / 流式拆分）就不重开：两趟并发会抢同一个流式面板，
     写出来的字两趟叠在一起分不清是谁的。问答摆出来等人回答时不算忙 —— 那一趟用户可能已经
     不想要了，重开一趟由 splitUI 换人作废旧的（见 renderSplitPanel 那段说明）。 */
  if (splitUI && splitUI.busy) { Toast.warn('上一趟拆分还在跑，等它出结果再来'); return; }
  /* 「项目引用规则」：已启用的 Skill 声明了哪些素材组 / 引用写成什么样子（设置页可改）。
     读不到就当没有声明（默认写法、全部组都在下拉里）—— 读不到不是错，按默认走。 */
  const project = projOf();
  const refRule = (window.WbSkills && WbSkills.refRule) ? await WbSkills.refRule() : { assetGroups: [] };
  if (projOf() !== project) return;
  /* 「素材范围」那一排的名单这一刻现数（新加了素材不必重开页面）；
     库还是空的就整项不画 —— 只有一项可选的下拉等于一颗点下去什么都不会变的按钮。
     Skill 声明的组**排在前面**（不排除其它组）。 */
  const scopes = SplitAssets.scopes(refRule.assetGroups);
  /* 文件 → 随附素材条目（{label, src, kind}）：图片就地压缩定型，音视频原样转 dataURL
     （体积上限由 prepareMedia 的能力声明管，超了照实报「没带」）。 */
  const kindOfFile = f => /^video\//.test(f && f.type) ? 'video'
    : /^audio\//.test(f && f.type) ? 'audio' : 'image';
  const KIND_ZH = { image: '图片', video: '视频', audio: '音频' };
  const toMediaEntry = async (f, kind) => {
    const blob = kind === 'image' ? await compressImg(f) : f;
    return { kind, label: (f && f.name) || '素材', src: await AssetTransfer.toDataURL(blob) };
  };
  const fields = [
    { key: 'script', type: 'textarea', label: '剧本 / 修改要求', placeholder: '故事、旁白或分镜草稿' },
    /* 随附素材：图片 / 视频 / 音频一起收。挑图时就地定型 dataURL（blob: 地址必须当场定型，
       对齐 ref.js 那条 applyFrameEntry 的做法）；读不出来的照实报数，不带残条。
       缩略点开走公共灯箱（view 交给页面）；文字型号不支持的种类由能力闸逐件说清「没带」。 */
    { key: 'media', type: 'pics', label: '随附素材', value: [], pickLabel: '添加素材',
      kinds: ['image', 'video', 'audio'],
      view: (it, all) => { try { window.Wb.lightbox.open(it, all || [it]); } catch (e) { /* 灯箱没就绪就当没点 */ } },
      onFile: async f => toMediaEntry(f, kindOfFile(f)),
      pick: async api => {
        const got = await AssetPicker.open({ types: ['图片', '视频', '音频'], multiple: true, title: '挑随附素材' });
        if (!got || !got.length) return;
        const cur = (api.values().media || []).slice();
        let fail = 0;
        for (const e of got) {
          try {
            const zh = String(e.type || '图片');
            const kind = zh === '视频' ? 'video' : zh === '音频' ? 'audio' : 'image';
            let entry;
            if (e.file) entry = await toMediaEntry(e.file, kind);
            else {
              const src = await toDataURL(e.src);
              entry = { kind, label: e.name || '', src };
            }
            cur.push(entry);
          } catch (err) { fail++; }
        }
        if (fail) Toast.warn(fail + ' 份素材读不出来，没带上');
        if (cur.length) api.set('media', cur);
      } },
  ];
  if (scopes.length) fields.push({ key: 'assetSrc', type: 'select', label: '素材范围',
    value: SplitAssets.last(), options: scopes });
  fields.push({ key: 'note', type: 'text', label: '备注（可选）',
    placeholder: '风格、节奏等要求', hint: '不写入提示词' });
  const v = await PromptForm.open({
    size: 'workflow',
    title: '拆分镜',
    okLabel: '开始',
    fields,
    validate: o => splitScriptGate(o.script),
  });
  if (!v || projOf() !== project) return;
  if (v.assetSrc) SplitAssets.remember(v.assetSrc);
  /* 「素材范围优先」跟着这一趟走（Skill 声明了哪些组排在前面）。 */
  v.refRule = refRule;
  await aiBoardRun(v);
}
/* 第 4 段喂给 AI 的那份清单：`items` 是**扁平**的镜头数组（场名在每一项上），
   而 `boardListText` 认的是 `snapBoard` 那一份按场分组的样子。
   这里把扁平的按场名并成组 —— 判据是「在几个镜头里反复出现」，
   AI 要看得见「第几镜、第几镜」才知道那是反复出现。ref 原样带上（follow 轮要照抄）。 */
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
      shots: list.map((t, i) => ({ n: i + 1, ref: String(t.ref || ''),
        sh: { id: t.key || (name + '·' + (i + 1)) },
        name: t.name || '', prompt: String(t.text || '').trim(),
        dur: Number(t.dur) > 0 ? Number(t.dur) : 0,
        chain: t.chain === 'tail' ? 'tail' : '',
        /* 挂图跟着行走（「按这句再改」的快照把图号原样带回来）：AI 要看得见「这一镜挂了哪几张」
           才能在改这一镜时说清图是留是换（图N 对照消息末尾的【随附素材】清单）。 */
        pics: Array.isArray(t.pics) ? t.pics : [] })) });
  });
  return boardListText(scenes);
}

/* 统一链：素材挑选 → 反问 → 一次 AI 调用（split 契约）→ 审查 → 落盘。 */
async function aiBoardRun(v) {
  /* 这一趟的身份：用户点取消 / 新一轮顶掉它之后，每个 await 回来都靠它认出「这趟已经不作数」 */
  const run = { dead: false, project: projOf() };
  splitRun = run;
  /* 随附素材 → 多模态输入（挑的时候已定型 dataURL，这里只过能力闸）。 */
  const mediaPrep = await prepareAttachments(v.media);
  if (!splitAlive(run)) return;
  /* AI 写了但对不上的 ref / 图号（每轮重算）：弹窗 sub 照实报数。 */
  let draftPicUnknown = 0;
  /* AI 点给「接上一镜」镜头的图号：首尾帧与参考图互斥，这些图不会挂；弹窗 sub 与落盘报告照实报数。 */
  let draftPicChain = [];
  /* AI 回的 title（短片命名用；审查弹窗 sub 也报）。 */
  let lastParsed = null;
  /* 素材只问一次：审查弹窗里点「重新规划」重跑这一趟时复用同一份挑中名单，
     不然每次重试都多问一遍文字 AI（多扣一次 tokens，而挑出来的还是那几条）。 */
  let staged = null;
  /* 反问那一轮的回答（'' = 没问出来 / 用户跳过；非空 = 逐题答的正文）。一趟只问一次：
     生成轮与「重新规划」都按这一份跑 —— 答案在生成轮是硬约束，重新问一遍等于替用户改主意。 */
  let answers = null;
  /* 新素材（要建档的那些角色/场景/物品）也只问一次：同样在「重新规划」时复用。 */
  let newAssets = null;
  /* ask() 最近一次拆出的镜头清单：审查弹窗里「重新规划（新素材）」只重问第 4 段。 */
  let lastOut = null;
  /* 用户在审查弹窗里**最终认下的**那几条（可逐条改 / 可删）—— 落盘按这一份建档。 */
  let chosenAssets = null;
  /* 长镜头拆分的报数（note / impossible）：弹窗 sub 与落盘报告都读这一份，重跑时跟着换。 */
  let splitInfo = null;
  /* 素材挑选也收进过程面板：范围内有条目时它是**真的一次文字 AI 调用**，
     干等没有下文看起来就像卡死了。同一趟只挑一次（staged 记住）。 */
  const ensureStaged = async () => {
    if (staged) return staged;
    const mine = { phase: 'loading', busy: true, note: '正在按素材范围挑这一次要用的素材…' };
    splitUI = mine;
    renderSplitPanel();
    staged = await SplitAssets.stage(REGOf(), v.script, v.assetSrc, v.refRule);
    if (splitUI === mine) splitUI = null;
    if (splitAlive(run) && staged.warn) Toast.warn(staged.warn);
    return staged;
  };
  /* 现有清单是不是只有空占位：每一场都还是默认名、每一镜都还没动过 ——
     这时清单不喂给 AI（它会把空占位当「已有分镜」而缩手），正文改说「从零拆一份」。 */
  const boardFresh = (projOf().scenes || []).every(sc =>
    isDefaultSceneName(sc && sc.name) && ((sc && sc.shots) || []).every(isUntouchedShot));
  const boardText = boardFresh ? '' : boardListText(snapBoard(projOf().scenes));
  /* Skill 正文里的变量这一趟怎么填（反问轮 / 生成轮 / 新素材判定三处同一份，board 由各处给）：
     · `{what}`   —— 这一次的正文 / 修改要求
     · `{cast}`   —— 本项目素材库里的角色 / 场景 / 物品名单（含外貌与音色）
     · `{assets}` —— 这一次选中的那批素材（完整描述）
     · `{board}`  —— 现有分镜清单（带 ref 编号）
     · `{dur}`    —— 时长区间那句 */
  const varsOf = (boardText2, what) => BoardVars.vars({
    what: what === undefined ? (v.script || '') : String(what || ''),
    cast: BoardVars.castOf(SplitAssets.named()),
    assets: BoardVars.assetsOf(staged ? staged.picked : [], x => (window.Chars && Chars.descOf) ? Chars.descOf(x) : ''),
    board: boardText2 == null ? boardText : boardText2,
    dur: boardDurNote(),
  });
  /* 第 4 段：问「这份方案里有哪些主体要新建素材」。ask() 首趟与
     「重新规划（新素材）」那颗共用 —— 后者只调它，不重跑拆分那一段。 */
  const stageAssetsOf = async (out) => {
    const mine = { phase: 'loading', busy: true, note: '正在看这份方案里有哪些要新建的素材…' };
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
  /* 系统提示词与正文这一趟只有一份拼法：反问轮与生成轮各取一次 —— 同源。 */
  const sysOfRun = () => `${TL_SYS_COMMON}
${fillSkillVars(splitSysOf(), varsOf())}
约束：由你决定拆几个镜头、每一镜多长。${boardDurNote()}${staged.rule}`;
  const userOfRun = () => `剧本/修改要求：\n${v.script}` + userNoteLine(v)
    + (boardText
      ? ('\n\n当前已有分镜（清单里的 ref 就是镜头编号：要改哪一镜就带它的 ref，原样保留的也带 ref 原样输出；'
        + '新镜头不带 ref。场景名照抄已有场景名才能归并，确要新开剧情段落才另起新名。别重复已有的镜头）:\n'
        + boardText)
      : '\n\n当前还没有实际分镜（只有空占位）：直接按正文从零拆一份完整方案。');
  const ask = async () => {
    await ensureStaged();
    if (!splitAlive(run)) return null;
    const sys = sysOfRun();
    /* 反问那一轮用户答过的东西随正文一起交上去（TextAI.answersNote 是唯一一份拼法）：
       每条答案都是硬约束。 */
    const an = TextAI.answersNote(answers || '');
    /* 长剧本动辄十几二十秒：边收边显 —— 宿主就是那张过程弹窗的正文格。 */
    const mineUI = { phase: 'stream', busy: true };
    splitUI = mineUI;
    let txt;
    try {
      txt = await AiStream.text(REGOf(), sys, userOfRun() + (an ? '\n\n' + an : ''),
        { host: splitHost(run), title: 'AI 正在拆分镜…', media: mediaPrep.media });
    } finally {
      /* 流断了 / 用户停了也让 busy 归零：留着它下一次点「拆分镜」会被自己挡在门外 */
      if (splitUI === mineUI) splitUI = null;
    }
    if (!splitAlive(run)) return null;   // 取消：这一趟的结果不再用（弹窗已收，面板不在屏幕上）
    const j = parseJsonLoose(txt);
    const parsed = boardFullItemsOf(j, snapBoard(projOf().scenes), mediaPrep.pics);
    if (!parsed.items.length) throw new Error(j ? 'AI 输出里没有镜头' : 'AI 没有给出可用的分镜结构');
    draftPicUnknown = parsed.unknownRefs;
    draftPicChain = parsed.picChain;
    lastParsed = parsed;
    /* 长镜头在**打开审查弹窗之前**按接续型号拆成几段：整段没有任何型号吃得下时才拆，
       总秒数守恒、第 2 段起标 `chain:'tail'`，拆完的每一段都进同一个弹窗。
       带 ref 的现有镜头**原样放行**（keep）：它们的时长落盘时已按各自型号夹过，
       再拆等于把已经生成过内容的镜头换成空壳。 */
    splitInfo = splitLongShots(parsed.items, {
      models: chainModelList(), canDur: durWritable(), maxName: 12, keep: it => !!it.upd,
    });
    const out = splitInfo.items;
    lastOut = out;
    /* ---- 第 4 段：这份方案里有没有「该新建一条素材」的主体 ----
       问失败**不拦**这一趟拆分：照实报一句，按「不建新素材」继续。 */
    if (!newAssets) await stageAssetsOf(out);
    if (!splitAlive(run)) return null;
    return out;
  };
  let items;
  try {
    setStatus('AI 正在拆分镜…（长剧本可能需要十几秒）');
    /* 反问那一轮（与「AI 润色」同一套两段式）：AI 自己判断这段正文值不值得先问；
       问答面板摆在过程弹窗上（splitUI 托管，整列重画冲不到它），回答当硬约束带进生成轮。
       问与拆共用同一份 sys（sysOfRun），所以素材挑选先做。 */
    await ensureStaged();
    if (!splitAlive(run)) return;
    answers = await askRound({ sys: sysOfRun(), user: userOfRun(), focus: BOARD_ASK_FOCUS,
      media: mediaPrep.media });
    if (!splitAlive(run)) return;
    items = await ask();
    if (!splitAlive(run)) return;
  }
  /* 按停止（面板上那颗「停止」）与真失败分开收尾：停止是主动收尾，不摆红条 */
  catch (e) {
    if (!splitAlive(run)) return;
    splitEnd(run);
    setStatus(e && e.name === 'AbortError' ? '<span class="meta">已停止</span>'
      : '<span class="err">' + e.message + '</span>');
    return;
  }
  const boardReviewSummary = rows => [
    '改 ' + rows.filter(it => it.upd).length + ' 镜 · 新增 ' + rows.filter(it => !it.upd).length + ' 镜',
    lastParsed.unknownRefs ? lastParsed.unknownRefs + ' 个 ref 对不上，按新镜头写入' : '',
    splitInfo && splitInfo.split ? '长镜头拆分 ' + splitInfo.split + ' 镜' : '',
    mediaInfoOf(mediaPrep, draftPicUnknown, unusedPicsOf(mediaPrep.pics, rows.map(it => it.pics)),
      draftPicChain.length + ((splitInfo && splitInfo.picDropped) || []).length),
    staged.sub].filter(Boolean).join(' · ');
  /* 审阅就地接手这张弹窗（shell）：不关不重开，屏幕中间只换一层内容。 */
  splitDlgReview = true;
  const reviewed = await PromptReview.openList({
    size: 'workflow',
    title: '分镜方案',
    shell: splitDlg,
    sub: boardReviewSummary(items),
    describe: boardReviewSummary,
    validate: () => splitAlive(run) ? '' : '项目已切换，请重新拆分',
    items, applyLabel: '写入这份分镜',
    /* 行上挂图缩略图要从这张表里取（src）—— AI 点的图按这一格渲染、可就地摘。 */
    pics: mediaPrep.pics,
    retry: ask,
    mode: 'board', durEditable: durWritable(), estimate: boardEstimate,
    /* 「待建素材」那块（可逐条改 / 可删）：确认后建档到项目组同名素材组 + 出图 + 绑音色描述。 */
    assetEditable: true,
    assets: (newAssets && newAssets.plan) || [],
    onAssets: (list) => { chosenAssets = list || []; },
    /* 「按这句再改」（审查弹窗里那一行）：弹窗把**此刻这份**（含用户手改）递回来当底稿，
       AI 按 split_follow 契约在它上面改一轮（输出改后的**完整方案**），流式画在弹窗里。 */
    onFollow: async (askText, ctl, current) => {
      const sys = `${TL_SYS_COMMON}
${fillSkillVars(TextAI.prompt('split_follow'), varsOf(boardListOfItems(current), askText))}`;
      const msg = '当前这份分镜方案（就在屏幕上，你要在**这一份**上改）:\n' + boardListOfItems(current)
        + '\n\n调整要求：' + askText
        + userNoteLine(v)
        + (answers ? '\n\n' + TextAI.answersNote(answers) : '');
      const txt = await TextAI.chatStream(REGOf(), sys, msg,
        { signal: ctl.signal, media: mediaPrep.media }, ctl.push);
      if (!splitAlive(run)) throw new Error('项目已切换或拆分已取消');
      const j = parseJsonLoose(txt);
      const parsed2 = boardFullItemsOf(j, snapBoard(run.project.scenes), mediaPrep.pics);
      if (!parsed2.items.length) throw new Error('AI 的调整结果里没有镜头');
      draftPicUnknown = parsed2.unknownRefs;
      draftPicChain = parsed2.picChain;
      lastParsed = parsed2;
      splitInfo = splitLongShots(parsed2.items, {
        models: chainModelList(), canDur: durWritable(), maxName: 12, keep: it => !!it.upd,
      });
      const next = splitInfo.items;
      lastOut = next;
      newAssets = null;
      if (typeof ctl.note === 'function') ctl.note('正在看这份方案里有哪些要新建的素材…');
      await stageAssetsOf(next);
      if (!splitAlive(run)) throw new Error('项目已切换或拆分已取消');
      /* 这一轮 AI 又把图点给接续镜时，弹窗底行照实说一句（清单里那些图已经摘掉）。 */
      const chainDropN = draftPicChain.length + ((splitInfo && splitInfo.picDropped) || []).length;
      if (chainDropN && typeof ctl.note === 'function') {
        ctl.note(chainDropN + ' 张图挂在接上一镜的镜头上没挂（首尾帧不收参考图）');
      }
      return { items: next, assets: (newAssets && newAssets.plan) || [] };
    },
    followPlaceholder: '调整要求',
    retryAssets: async () => {
      /* 「重新规划」只重问**第 4 段**（新素材判定，stageAssetsOf）：
         以前整体重跑 ask()，把拆分镜那次文字 AI 也再花一遍钱。 */
      newAssets = null;
      await stageAssetsOf(lastOut || items);
      return (newAssets && newAssets.plan) || [];
    },
  });
  if (!splitAlive(run)) return;
  run.dead = true;
  /* 弹窗在确认 / 取消那一下已经自己关了：这一趟的句柄一起清掉（留着的只是过期节点） */
  splitDlg = null; splitDlgRun = null; splitDlgReview = false; splitUI = null;
  /* 空数组也要当「没采纳」接住：openList 的确认会把正文为空的条目滤掉。 */
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  /* ---- 自动命名（三件，都只对「还是默认值」的对象动手）----
     · 短片名：还是「未命名短片」这一族 → 取 AI 回的 title；
     · 首场名：第一场还叫「场景 1」→ 取方案第一行的场名（随后按名归并，场景图与 sceneLibId 跟着走）；
     · 占位首镜：全局第一镜还是没动过的「新镜头」→ 摘掉（方案的第一镜顶上，等效覆盖）。 */
  const proj = projOf();
  const nameBits = [];
  if (lastParsed && lastParsed.title && isDefaultProjName(proj.name)) {
    proj.name = String(lastParsed.title);
    nameBits.push('短片已命名为「' + proj.name + '」');
  }
  const firstScene = (proj.scenes || [])[0];
  const firstRowScene = String((reviewed[0] && reviewed[0].scene) || '').trim();
  if (firstScene && isDefaultSceneName(firstScene.name) && firstRowScene && !isDefaultSceneName(firstRowScene)) {
    firstScene.name = firstRowScene;
    nameBits.push('首场已命名为「' + firstRowScene + '」');
  }
  let overwrote = false;
  const sc0 = (proj.scenes || [])[0];
  if (sc0 && (sc0.shots || []).length && isUntouchedShot(sc0.shots[0])) {
    sc0.shots.shift();
    if (!sc0.shots.length) proj.scenes.splice(proj.scenes.indexOf(sc0), 1);
    proj.curScene = Math.max(0, Math.min(proj.curScene, proj.scenes.length - 1));
    proj.curShot = 0;
    overwrote = true;
  }
  /* ---- 落盘（唯一写点 applyBoardFull）：ref 行就地改、新行按场景归并追加 ---- */
  const r0 = applyBoardFull(reviewed, proj.scenes, mediaPrep.pics);
  /* 新挂接续的镜头落到支持首帧的型号上：长镜拆段那一路已带型号，AI 手写 chain 的由它现挑。 */
  r0.touched.forEach(sh => {
    const def = defaultTakeOf(sh);
    if (def && def.linkPrev === 'tail') ensureChainModel(sh, def);
  });
  if (r0.at) { proj.curScene = r0.at.scene; proj.curShot = r0.at.shot; }
  /* ---- 新素材（用户认下的那几条）：建档 + 占位符 ----
     建档落在**当前短片所在的项目组**同名素材组里（组名即素材组名）。
     出图**不在这里自动发**：出图要花钱，留给用户确认或去素材库点「生成素材图」。 */
  const assetGroup = Groups.assetGroupName(WSOf(), projOf());
  const landed = landNewAssets(chosenAssets || [], assetGroup);
  /* 场景 ↔ 库里那条场景素材互记 id：拆出来的新场景按名字对上就绑，改名不断引用。 */
  (landed.saved || []).filter(x => x && x.kind === 'scene' && x.id).forEach(e => {
    const nm = String(e.name || '').trim();
    (proj.scenes || []).forEach(sc => {
      if (!sc.sceneLibId && String(sc.name || '').trim() === nm) sc.sceneLibId = e.id;
    });
  });
  markPendingTokens(r0.touched, landed.saved);
  const assetNote = landed.saved.length
    ? '，新建素材 ' + landed.saved.length + ' 条（'
      + (landed.group ? '组「' + landed.group + '」' : '未分组') + '，出图后自动补进参考图）'
    : (landed.failed.length ? '，有 ' + landed.failed.length + ' 条素材没建出来' : '');
  if (landed.failed.length) {
    Toast.warn('有素材没建出来：' + landed.failed.map(f => f.name + '（' + f.why + '）').join('、'));
  }
  if (landed.why) Toast.warn(landed.why);
  const chainN = r0.touched.filter(sh => {
    const def = defaultTakeOf(sh);
    return def && def.linkPrev === 'tail';
  }).length;
  const chainNote = chainN ? '，其中 ' + chainN + ' 镜接上一镜尾帧（生成时自动取首帧）' : '';
  const chainRefusedNote = r0.chainRefused
    ? '；' + r0.chainRefused + ' 镜已有参考素材，没改成接上一镜' : '';
  const overwriteNote = overwrote ? '；占位首镜已由拆分结果覆盖' : '';
  reportScenePics(r0.pics,
    '已写入 ' + r0.upd + ' 镜改动、' + r0.add + ' 个新镜头'
    + (r0.newScenes ? '、新开 ' + r0.newScenes + ' 个场景' : '')
    + (r0.kept ? '；现有 ' + r0.kept + ' 镜未提及，原样保留' : '')
    + (r0.unknownRefs ? '；' + r0.unknownRefs + ' 个 ref 对不上，按新镜头写入' : '')
    + chainNote + chainRefusedNote + overwriteNote
    + (nameBits.length ? '；' + nameBits.join('；') : '')
    + assetNote + clampNote(r0.clamped),
    SplitAssets.bind(r0.touched.map(sh => ({ ...sh, candidates: [defaultTakeOf(sh)] })), staged.picked),
    { n: r0.picN, shots: r0.picShots, dup: r0.picDup, why: r0.picWhy, unknown: r0.picUnknown });
  renderAll(); scheduleSave();
  /* 新素材可以顺便出预览图（确认框勾了才排队 —— 花钱任务不自动发）。
     不等出图结果：拆分镜本身已经落盘，出图是后面几步，用户可以先去干别的。 */
  if (landed.saved.length) maybeFillNewAssetPics(landed.saved).catch(() => {});
}

  return {
    aiStoryboard,
    renderSplitPanel,
  };
}
