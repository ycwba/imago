/* 导演台引擎：原 fragment.html 的内联脚本整体搬进模块，document / window 是页面作用域岛的两份代理。
   这样它可以被 node --check 静态检查；模板在开发期预编译（tools/precompile-vue.cjs），
   运行时没有 new Function，严格 CSP 不需要 unsafe-eval。 */
import { createExport } from './engine/export.js';
import { createGen } from './engine/gen.js';
import { createApply} from './engine/apply.js';
import { createMid} from './engine/mid.js';
import { createFrames} from './engine/frames.js';
import { createStrip } from './engine/strip.js';
import { createTimeline } from './engine/timeline.js';
import { createPlay, playSafe } from './engine/play.js';
import { createEdit } from './engine/edit.js';
import { tlClampZoom } from './tl-scale.js';
import { createMarker } from './tl-markers.js';
import { createVoice} from './engine/voice.js';
import { createBridge} from './engine/bridge.js';
import { createCaptionDomain } from './engine/caption.js';
import { createPanel} from './engine/panel.js';
import { parseJsonLoose, round1, pct, num, BOARD_CTX_PROMPT, BOARD_CTX_SHORT } from './util.js';

import { scriptTextOf, parseScript, applyScript } from './script.js';

import { createBoardTools } from './board.js';

import { chainDeps, splitLongShots, chainModelRepick, hasTailFrame, isRunning } from './chain.js';

import { createSplitAssets } from './split-assets.js';

import { createGroups } from './groups.js';

/* 项目文件（导出 / 导入完整工程）：格式闸门、校验和、清洗与导入归一化全在这一份纯件里，
   本文件只负责取文件、下载文件与把结果放回工作区。 */
import { buildProjectPack, assertProjectPack, describeProjectPack, prepareProjectPackImport,
  scanProjectPackConflicts } from './project-pack.js';

import { createBoardAssets } from './board-assets.js';

import { createBoardVars } from './board-vars.js';
import { shotRefPlanOf, tokenizeRefPrompt, applyProviderRefSyntax } from './ref-plan.js';

import { normalizeFilm, promoteCandidate, demoteShot, normalizeTransition, transitionNameOf, chosenCandOf, deriveTimeline, createClip, clipDurationOf, pos, IMAGE_SEGMENT_SECONDS, MAX_FILM_SECONDS } from './film.js';

export function mount(document, window) {

'use strict';
/* ================================================================
   导演台 · vgenv API（minimax/h3）
   经本地代理 /vgenv/* 转发；密钥由代理注入，页面不接触明文。
================================================================ */
const $ = id => document.getElementById(id);
/* 导出格式表（web/domain/export-formats.js）：页头按钮、export_start 的校验 / 分派 / 文案、
   助手那边 export_start 的枚举都只读这一份。没加载就当场炸 —— 悄悄少画一排导出入口更坏。 */
const ExportFormats = window.ExportFormats;
if (!ExportFormats) throw new Error('导出格式表没加载：web/domain/export-formats.js');

/* ---------- 常量 ---------- */
/* 档位 / 比例 / 格式的中文名表不在这里抄第二份：在 `gen-forms.js` 的 `AdvParams`（工作台与导演台同一份）。 */
const ST_ZH = Wb.ST;   // 状态文案只有 workbench.js 那一份（含各家平台的同义词）
/* 这一页自己的候选状态词只有 draft / creating / queued / running / succeeded / failed / cancelled，
   而轮询拿回来的是平台原话（success / completed / done / processing…）。写回之前先归一化：
   否则「已完成」在这一页会被当成还在跑 —— shotReady、候选排序、缩略图、「选用」按钮全按
   'succeeded' 比，表现就是任务明明做完了，界面还写着生成中（要刷新重拉才对上）。
   判据只有 Api.classifyStatus 一份（它认 registry 的 statusMap）。 */
const canStatus = s => {
  const c = (window.Api && Api.classifyStatus) ? Api.classifyStatus(null, s) : '';
  if (c === 'done') return 'succeeded';
  if (c === 'failed') return /cancel/i.test(String(s || '')) ? 'cancelled' : 'failed';
  if (c === 'queued') return 'queued';
  if (c === 'running') return 'running';
  return String(s || '');      // 判据不在（assetlib 没加载）时原样留着，别把状态改没
};

/* ---------- 工作区（多个短片 + 项目组）---------- */
/* `groups` 是项目组：[{ id, name }]。组名**就是素材组名**（用户已定）——
   同一个组名下的短片，拆分镜建出来的新素材自动落进素材库的那个同名组里。
   老工程读回来时 `groups` 缺失 → 补 `[]`、项目没有 `groupId` → 未分组，
   **零迁移**：现有工程全部落在未分组，行为与今天完全一样。 */
let WS = { projects: [], curId: null, groups: [] };
let proj = null;        // 当前短片
/* 工作区装配完成旗标：boot() 里 `await wsKv.get` → `await DataSync.workspaceFromServer` 之间
   有一整个网络往返的窗口，此时 WS 还是上面那份**空默认值**。关标签/刷新的 flush 与任何顺手
   排上的 scheduleSave 都可能在窗口里跑，写下去的就是「一个工程都没有」——把用户真工作区从
   IndexedDB 与 .data/workspace.json 一起盖掉（「读不出来绝不等于本来就没有」的同一类）。
   所以两份落盘都必须先问这一枚：没装配完就一个字节都不写。 */
let wsLoaded = false;
let REG = null;         // /registry：API 注册路由（提供商/模型/能力）
let saveTimer = null;
const uid = () => crypto.randomUUID().slice(0, 8);

/* 项目组（分组 / 改名 / 删组 / 归组 / 树）—— 判据全在 web/director/groups.js，
   engine 只调用。组名即素材组名（见那个模块开头的说明）。 */
const Groups = createGroups({ nameKey: window.nameKey, uid });

/* 拆分镜的「新素材」（判哪些角色/场景/物品要建档出图、占位符怎么写）——
   判据全在 web/director/board-assets.js，engine 只调用。 */
const PENDING_PREFIX = '待建';
const BoardAssets = createBoardAssets({
  nameKey: window.nameKey, MIN_REPEAT: 2, PREFIX: PENDING_PREFIX,
});

/* 「项目引用规则」：**Skill 正文里的变量占位符**该填什么（`{what}` `{cast}` `{board}` …）。
   判据全在 web/director/board-vars.js；engine 只调用。
   变量填料用公共层 `window.TplVars.fill`（那一份填法只有一处）。 */
const BoardVars = createBoardVars({
  nameKey: window.nameKey,
  kindZhOf: x => (window.Chars && Chars.LIB_KINDS) ? (Chars.LIB_KINDS[Chars.libKindOf(x)] || '') : '',
});
/* 把一份 Skill 正文里的变量按这一次的料填上。
   **填不上的原样留着**（`TplVars.fill` 的规矩）—— AI 看到 `{cast}` 三个字也知道那是要它自己补的位子，
   比留一段空强。 */
function fillSkillVars(tpl, vals) {
  return (window.TplVars && TplVars.fill) ? TplVars.fill(tpl, vals) : String(tpl || '');
}

/* 「一条候选占位有哪些字段」全站只在这一个函数里点一次名。
   以前命名了三份：mkDraftCandidate 一份、addCandidateDraft 抄了一份逐字相同的十行、
   pushPlaceholders 又抄了第三份（只差 vid 前缀与状态）—— 给占位加一个字段就要三处同步，
   漏一处的表现是「从某个入口建出来的候选少带一个字段」（界面正常、提交时才取到 undefined）。
   provider 在这里只是「这一条将来要发给谁」的一个记号：draft 阶段既不会提交也不会被轮询
   （pollLive 按 tmp_ 号跳过）。以前这里写的是 `provOf(...).id` —— 页面刚打开、/registry 还没回来的
   那一瞬间 provOf 给的是 null，于是「建第一个镜头」当场抛 TypeError，
   干净 profile 一进去就是「未处理错误」横幅 + 右栏一直空着（加载期竞态，与「能力声明回来之前不许说你没配 X 接口」是同一类）。
   现在直接取型号自己记着的那一家，认不出就留空 —— 真要点「生成这条」时那一路有 needProv，
   会给一句能照做的话，而不是在建立占位的时候崩掉整页。 */
function mkCandidateBase(sh, vid) {
  const rm = resolvedModel(sh) || {};
  return {
    vid, provider: rm.provider || '', status: 'draft', progress: 0,
    url: null, error: null, selected: false, locked: false, trimS: null, trimE: null,
    shotId: sh.id, created: Date.now(), prompt: (sh.prompt || '').trim(),
  };
}
/* 一个空的候选占位：新增镜头 / 点 ＋ 都先建它，描述在右栏写、写完点「生成这条」 */
function mkDraftCandidate(sh) { return mkCandidateBase(sh, 'tmp_draft_' + uid()); }
/* 「把一份外部视频塞进候选条」也是一份候选，只是它已经成了：状态/进度/裁剪/价格这几项
   三个导入入口（素材库批量投递、收藏转存、中栏单条导入）以前各写一遍同样的八个字段，
   加一项就得三处同步。现在页面只递「哪一条、从哪来、地址是什么」。 */
function mkImportedCandidate(o) {
  return {
    vid: o.vid, provider: o.provider, status: 'succeeded', progress: 100,
    url: o.url, local: !!o.local, locked: false, trimS: null, trimE: null,
    priceMicros: null, duration: o.duration || null, error: null,
    ...(o.fromAsset ? { fromAsset: true } : {}),
    /* 导入去重的凭据（`operationId`）：文件按「名字+字节数+修改时间」、资产按资产号。
       同一份素材再导一次时不追加第二条候选；失败重试用的也是同一个号。 */
    ...(o.importOp ? { importOp: o.importOp } : {}),
  };
}
function newShot(prompt = '') {
  const sh = {
    id: uid(), name: '新镜头', prompt,
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    firstFrame: null, lastFrame: null,       // dataURL
    refImages: [],                            // dataURL[]
    refVideo: null, refAudio: null,           // { asset_id, name }
    keyframes: [],                            // { t, desc, status, assetId } 时间切片参考图
    candidates: [],                           // { vid, status, progress, url, priceMicros, error, selected, locked, trimS, trimE, duration }
    selId: null,                              // 选中的候选 vid
    /* 「输入模式」= 这一镜这一次请求的形状（`Capabilities.combos` 里选中的那一条 id）。
       平台不给形状声明时一直是空串，那一排芯片整块不画，行为与加它之前逐字相同。
       挂在镜头上而不是模块变量：导演台一次编辑的是镜头，切镜头要跟着换。 */
    combo: '',
    /* 拆分镜落进工程数据的两个结构化字段，都只挂在镜头上：
       `line` = 这一镜要念的话（只有文字，**不进配音轨**）。配音轨只放已经有音频的条目：
       `addVoiceEntry` 第一件事是问 `voiceTarget`，draft 占位候选不算落点；往里塞一条「有字没声音」的
       会被 `clipVoices` 数进 skip，状态行于是把「还没合成」说成「N 句配音没进成片」。
       `note` = AI 给的那一句画面说明原样。以前它被 slice(0,12) 压成镜头名，长描述直接丢失 ——
       名字那一格另有短名来源（AI 给的 `name`，没有就退回「镜头 N」）。
       旧工程没有这两个键：读的地方一律现算成空串，不做迁移。 */
    line: '',
    /* 说这句台词的是谁（素材库里的角色名）。有台词才可能有它，且只决定把这一句填进合成框时
       预填哪一位的音色（设计档填 `voiceNote`、克隆档挂 `refAudio`）—— 它不进提示词、
       不进配音轨、也不是 `proj.film.voices` 里的字段，
       与 `line` 一样是「还没合成的那句话」的附属信息。 */
    lineWho: '',
    note: '',
    /* 接续：`linkPrev === 'tail'` 表示这一镜生成时自动取上一镜的尾帧当首帧。
       用户显式选过首帧时以那一张为准（`firstFrame` 优先），这里的标记只是「还挂着接续」；
       占位、能力判定与提交时解析尾帧都读它。
       `modelAuto === 'chain'` = 当前型号是程序为了接续自动挑的，不是用户手选 ——
       用户改型号时清掉，界面据此显示「已自动切到 X」。 */
    linkPrev: '',
    modelAuto: '',
  };
  sh.candidates.push(mkDraftCandidate(sh));   // 默认带一个候选占位（默认选中它）
  return sh;
}
/* 工作区/项目是异步加载的，轮询定时器可能在 proj 还是 null 时先跑起来 —— 这里统一兜住，
   否则抛 TypeError，页面顶部出现「脚本错误」横幅且右栏一直空着。 */
const allShots = () => (proj ? proj.scenes.flatMap(sc => sc.shots) : []);
/* 成片模型（`proj.film`，web/director/film.js）：新剪辑核的唯一数据层。
   读回来时由 sanitize 整份规整；这里只负责「缺了就补一张空片」。 */
function ensureFilm() {
  if (!proj) return normalizeFilm(null);
  if (!proj.film || typeof proj.film !== 'object') proj.film = normalizeFilm(null);
  return proj.film;
}
/* 一段画面上写的是「哪一镜」：历史与回执都按镜头名点名（片段自带的 name 是素材名，用户读不出是谁）。 */
const filmClipName = c => {
  const s = c && allShots().find(x => x && x.id === c.shotId);
  return (s && s.name) || (c && c.name) || '画面段';
};
/* 选用 / 取消选用候选的**唯一入口**：selId 与成片片段一起变（两处各改一次迟早对不上）。
   选用 = 提升（已有片段原位替换、没有按镜头顺序插入）；取消 = 把这一镜的片段整组撤掉。 */
function setSelectedCandidate(sh, cand) {
  if (!sh) return false;
  const had = sh.selId || null;
  sh.selId = cand ? cand.vid : null;
  const film = ensureFilm();
  if (cand) {
    const r = promoteCandidate(film.clips, sh, cand, allShots().map(s => s.id));
    if (r.index >= 0) film.clips = r.clips;
  } else if (had) {
    film.clips = demoteShot(film.clips, sh.id).clips;
  }
  return had !== sh.selId;
}
const curScene = () => (proj ? proj.scenes[proj.curScene] || proj.scenes[0] : null);
const curShot = () => curScene()?.shots[proj.curShot];
const fmtDur = s => (Math.round(s * 10) / 10) + ' 秒';
const shotDur = sh => {
  if (!sh) return 0;
  /* 成片那一份说了算：这一镜的片段已在成片里（可能被剪过几刀），时长 = 那几段 duration 之和。 */
  const mine = (ensureFilm().clips || []).filter(c => c && c.shotId === sh.id);
  if (mine.length) return round1(mine.reduce((a, c) => a + clipDurationOf(c), 0));
  const c = sh.candidates.find(c => c.vid === sh.selId) || sh.candidates.find(c => c.status === 'succeeded');
  if (!c) return 0;
  if (c.trimE != null) return round1(Math.max(0, c.trimE - (c.trimS || 0)));
  if (c.duration) return c.duration;
  if (c.url) return sh.duration || 5;
  return 0;   // 还没出画面：不显示假时长
};
/* 本镜时长文案：没生成就写「未生成」 */
const shotDurText = sh => { const d = shotDur(sh); return d ? fmtDur(d) : '未生成'; };
const shotReady = sh => sh.selId && sh.candidates.some(c => c.vid === sh.selId && c.status === 'succeeded');

/* ---------- 持久化（IndexedDB）----------
   开库、缺仓库补建、连接复用全在 web/ui/ui.js 的 Kv 里（本页以前自己写过一份最完整的，
   现在设置页 / 资产库页 / 保存落点用的是同一份）。库/表名也不在这里抄：
   Kv.at('ws') = 导演台工作区与本地视频。 */
const wsKv = Kv.at('ws');
/* ---------- 撤销 / 重做（**只追加的操作日志 + 当前状态指针**，Ctrl+Z / Ctrl+Y）----------
   历史是一条**只追加**的日志：每做一次编辑就往末尾记一条（带那一刻的完整快照）。
   「现在是哪一版」由一个**指针**说 —— 回退**不删任何记录**，只在日志末尾追一条
   「回退到「xxx」」并把指针指回那条记录的状态。于是：
     · 所有记录**始终可见**（干过什么全在日志里，审计可查，不会因为回退而消失）；
     · 回退几次就多几条「回退到 …」的记录 —— 日志就是一本流水账，不是一条被剪短的线；
     · 从旧状态再改一版也不抹掉后面的记录（新记录追加在末尾，指针跟到末尾）。
   上限仍是 30 条 / 24 MB：超了从**最旧**的一头丢（丢的是最老的那几条编辑记录）。 */
let historySeq = 1;
let historyBytes = 0;
/* 起点：还没编辑过之前的那一版状态（指针 = -1 时生效）。 */
let historyBase = '';
/* 日志本体：`{ id, at, label, json, kind: 'edit'|'rollback'|'redo', target }` —— 只 push，不 splice 中间。 */
const historyLog = [];
/* 当前生效状态在日志里的下标；-1 = 起点（historyBase）。 */
let historyCursor = -1;
/* 这一次编辑叫什么：beginEdit 先记下名字，落盘时再定稿（见 historyCommit）。 */
let pendingEdit = null;
/* 给桥与面板读的**视图**：undoStack = 指针之前那几条记录的状态，redoStack = 指针之后那几条。
   「这一步叫什么」不从这里读 —— 日志条目自己带 label，面板与桥直接看 historyLog。 */
const undoStack = [], redoStack = [];
let lastSavedJson = '';
/* 快照是整份工作区 JSON（含内联图片），必须限总量：以前无上限保留 50 份，大工程会吃掉上百 MB 内存。
   **两档上限都不在界面上**（README 与项目介绍曾写「最多 50 步」，实际是 30 步 / 24 MB），
   所以按 Ctrl+Z 突然「没有可撤销的操作」时用户不会知道是触了步数还是触了内存 ——
   那一瞬看起来就像坏了。工具条上常驻一句「撤销 N/30」，耗尽时说清是哪一档顶到了。 */
const UNDO_MAX_BYTES = 24 * 1024 * 1024, UNDO_MAX_COUNT = 30;
/* 「为什么存不下」—— 记一步的两处早退各有一个原因，耗尽时照实报出去。
   判据与 historyCommit 同一处，不在这里重算。 */
let undoSkipWhy = '';
/* 指针此刻对应的那份状态（面板、撤销、重做、助手读的都是它）。 */
function historyStateAt(i) {
  if (i == null || i < 0) return historyBase;
  const e = historyLog[i];
  return e ? e.json : historyBase;
}
/* 把「日志 + 指针」同步成外面那几份账（桥与面板读的就是它们），并立刻重画面板。 */
function historySync() {
  undoStack.length = 0; redoStack.length = 0;
  for (let i = 0; i < historyLog.length; i++) {
    const e = historyLog[i];
    if (i < historyCursor) undoStack.push(e.json);
    /* 重做只数**编辑记录**（回退 / 重做是流水记录，不是一版状态；redo() 自己也是这么跳的）——
       数进来会让「可重做 N 步」比真的能重做的多。 */
    else if (i > historyCursor && e.kind === 'edit') redoStack.push(e.json);
  }
  /* 起点（还没编辑过的那一版）也是一步可撤销的状态：指针落在某条记录上时，Ctrl+Z 退到 -1
     退的就是它。以前视图只数「指针之前那几条记录」，于是**一次编辑之后撤销栈读数是 0** ——
     助手照这个数回「没有可撤销的操作」，Ctrl+Z 却真的会退；一次真编辑被记成「没发生」。 */
  if (historyCursor >= 0) undoStack.unshift(historyBase);
  /* 面板跟着历史走：记一步 / 回退 / 重做都立刻重画左栏那块「历史编辑记录」——
     否则剪完一刀要等下一次轮询（几秒）才看见新的一步，用户会以为「没记上」。 */
  try {
    const box = document.getElementById('editLeft');
    if (box && !box.hidden) renderEditLeft(box);
  } catch (e) { /* 面板画不出来不挡历史本身 */ }
}
/* 追一条记录（**只追加**，永不插队、永不删中间） */
function historyAppend(label, json, kind, target) {
  const when = Date.now();
  const e = { id: historySeq++, at: when, label: label || '编辑', json: json || '',
    kind: kind || 'edit', target: target == null ? null : target };
  historyLog.push(e);
  historyBytes += (json || '').length;
  historyEvict();
  historyCursor = historyLog.length - 1;      // 指针跟到这条（它就是刚做出来的那一版）
  return e;
}
/* 记一步编辑：把「刚开始那一步」定稿；走的是纯保存那一路就追加一条新的。 */
function historyCommit(label, at) {
  const json = snapOf();
  if (!json) return false;
  if (json.length > UNDO_MAX_BYTES / 2) {
    /* 单份就超预算一半：不存（避免一份快照把预算吃光） */
    undoSkipWhy = '这一份工作区太大（' + window.fmtBytes(json.length) + '，超过单份上限 '
      + window.fmtBytes(UNDO_MAX_BYTES / 2) + '）';
    return false;
  }
  const cur = historyLog[historyCursor];
  if (cur && cur.pending) {
    /* 刚开始那一条：状态换成改完之后的那一版，名字与时间也补上（日志条目本身不换位置）。 */
    historyBytes += json.length - (cur.json || '').length;
    cur.json = json;
    cur.pending = false;
    if (at) cur.at = at;
    if (label) cur.label = label;
    historyEvict();
    historySync();
    return true;
  }
  /* 指针这一条记的就是这个状态 = 这一次保存没有产生新的一版（定稿之后又走了一趟保存）：
     不再追加一条一模一样的记录 —— 追加了会让「退一步」退到同一条状态上（看起来没反应）。 */
  if (cur && cur.json === json) { historySync(); return true; }
  historyAppend(label || '编辑', json, 'edit', null);
  historySync();
  return true;
}
/* 上限两档各报各的：超了从**最旧**的一头丢（丢最老的那几条），
   指针跟着往前挪同样的条数 —— 不挪的话指针会指到一条已经不存在的记录上。 */
function historyEvict() {
  let evictWhy = '';
  let dropped = 0;
  while (historyLog.length > UNDO_MAX_COUNT || historyBytes > UNDO_MAX_BYTES) {
    const old = historyLog[0];
    if (!old) break;
    /* 只剩一条时不再丢（否则连撤销都没了） */
    if (historyLog.length <= 1) break;
    evictWhy = historyLog.length > UNDO_MAX_COUNT
      ? '撤销已用满上限（' + UNDO_MAX_COUNT + ' 步）'
      : '撤销内存已用满（' + window.fmtBytes(UNDO_MAX_BYTES) + '）';
    historyBytes -= (old.json || '').length;
    /* 丢掉最旧那一条之前，把它之前的状态留给起点：丢完之后指针 -1 仍然退得回「那之前」。 */
    if (historyLog.length >= 1) historyBase = old.json || historyBase;
    historyLog.shift();
    dropped++;
  }
  if (dropped) historyCursor = Math.max(-1, historyCursor - dropped);
  if (evictWhy) undoSkipWhy = evictWhy;
}
/* 把「还没定稿」的那一步按**此刻**的状态定下来（落盘时 / 下一次 beginEdit 之前都要走一次）。 */
function historyFinalizePending() {
  const cur = historyLog[historyCursor];
  if (!cur || !cur.pending) return false;
  const json = snapOf();
  if (!json) return false;
  historyBytes += json.length - (cur.json || '').length;
  cur.json = json;
  cur.pending = false;
  return true;
}
/* 日志末尾那一条的标签 = 「最近做过的那件事叫什么」（助手回执与面板读的都是它）。
   指针之前的那一条叫「下一次 Ctrl+Z 要退掉的」，两者不是一个东西 —— 以前这里读的是后者，
   于是刚切完一刀，回执上还在念上一步。 */
function historyNewestLabel() { const e = historyLog[historyLog.length - 1]; return e ? e.label : ''; }
/* 助手那几条时间线动作在改数据之前调它：**当场**记一条（用户点完执行马上说「撤销」也退得回去）。 */
function beginEdit(label) {
  /* 名字先记下（**这一步做了什么**：调用方给一句精确描述）。
     记录**当场追加**（状态先记「改动前」那一版，落盘时再换成改完之后的那一版）——
     否则「可撤销 N 步」会晚 500 ms 才加一，用户看着像没记上（也是那两条假话的来源）。 */
  historyFinalizePending();          // 上一步先按此刻的状态定稿
  const before = snapOf();
  if (!before) return;
  if (before.length > UNDO_MAX_BYTES / 2) {
    undoSkipWhy = '这一份工作区太大（' + window.fmtBytes(before.length) + '，超过单份上限 '
      + window.fmtBytes(UNDO_MAX_BYTES / 2) + '）';
    return;
  }
  if (!historyBase) historyBase = before;      // 起点那一版
  pendingEdit = { label: label || '编辑', at: Date.now(), before: before };
  const e = historyAppend(label || '编辑', before, 'edit', null);
  e.pending = true;
  historySync();
}
/* 指针挪到日志里的第 i 条，并**追加一条「回退到 xxx」**（不删任何记录）。
   这就是用户要的语义：回退也是一次「发生过的事」，日志里要留痕、所有记录始终可见；
   而「当前生效」的指针指向 **xxx 那一条**（不是刚追的这条流水记录）。 */
function historyGoTo(i, kind, verb) {
  /* 先把手里那一步结算掉（与 undo / redo 进门那一句同一个出口，面板直接点一行也必须走）：
     上一步还在 500ms 合并窗口里就让它带着**自己的**状态与名字定稿，
     否则 `pendingEdit` 会一直挂在这儿，恢复之后那一次保存把旧名字盖在一个新状态上
     （表现为：回退之后日志末尾冒出一条念着上一步名字的记录，指针还跟着它跑了）。 */
  historyFinalizePending();
  settlePendingEdit();
  const targetIdx = Math.max(-1, Math.min(historyLog.length - 1, i));
  const target = targetIdx >= 0 ? historyLog[targetIdx] : null;
  const want = historyStateAt(targetIdx);
  if (!restoreSnap(want)) return false;
  const label = (verb || '回退到') + '「' + (target ? target.label : '起点')
    + '」' + (target ? '（' + window.fmtHM(target.at) + '）' : '');
  /* 追一条流水记录（它自己不做状态变化）。historyAppend 会把指针带到末尾 ——
     所以这里紧接着把它按语义摆回去：指针指向**目标那一条**（回退到的是它那一版）。 */
  historyAppend(label, want, kind || 'rollback', target ? target.id : null);
  historyCursor = targetIdx;
  historySync();
  return true;
}
// 快照剔除轮询的瞬态字段（进度/排队位置），避免自动轮询污染撤销栈
function snapOf() {
  /* 游标不进快照。`curScene` / `curShot` / `curCand` 是「我现在在看哪一个」，
     不是「作品是什么」—— 以前它们被一起序列化，于是点6 次候选缩略图比较效果，
     再按 Ctrl+Z，第一下退回去的是「我刚才在看第 2 条候选」，真正的编辑还排在后面。
     而撤销上限只有 30 步，翻看几次就能把真正的改动挤出栈。
     剔掉它们之后，「翻看」不再消耗撤销次数；撤销回去时视口停在当前这一镜
     （restoreSnap 进门先把三个游标按**身份**记一份、恢复完再放回去 —— 快照里没有
     这三个键，靠 sanitize 兜底会把视口甩回第一场第一镜）。
     **只序列化当前项目**：多项目工程里整个工作区可能有几十 MB，
     每 500ms / 每一刀都 stringify 全部项目是主线程卡顿的主要来源；
     撤销只需要恢复正在改的那一个项目（切项目会换 curId，恢复时跟着切回去）。 */
  /* 编辑视图状态（剪辑针、播放头）不进快照：剪辑态自己的视图状态由 Timeline 持有，
     撤销恢复的是作品内容，不恢复「你刚才看到哪一秒」。 */
  if (!proj) return '';
  /* `groups` 一起进快照：项目组是一次编辑（建组 / 归组 / 删组），
     不进快照的话 Ctrl+Z 撤不回去 —— 那条组关系就再也回不来了。 */
  return JSON.stringify({ curId: WS.curId, project: proj, roles: WS.roles, groups: WS.groups },
    (k, v) => (k === 'progress' || k === 'queue_position'
      /* `_mirrorAnnounced` 是「这一条已经投过自动镜像」的纯内存标记（现在改放 WeakSet，
         这里再挡一次旧工程里残留的那一枚）：它进了快照就会随撤销恢复来回翻转，
         而且多一份与作品无关的字段。 */
      || k === '_mirrorAnnounced'
      || k === 'curScene' || k === 'curShot' || k === 'curCand') ? undefined : v);
}
function restoreSnap(json) {
  try {
    /* 视口先按**身份**记一份（场景 id / 镜头 id / 候选 vid，不是下标）：快照剔掉了
       curScene / curShot / curCand 三个游标，sanitize 只能把缺失的游标兜到 0 ——
       那会把撤销 / 重做变成「整页跳回第一场第一镜」。恢复完按身份找回当前看着的那一镜；
       快照里已经没有它（撤销的正是「新建镜头」这一步）就退到合法范围的第一格。 */
    const vp = (() => {
      try {
        const sc0 = (proj.scenes || [])[proj.curScene] || null;
        const sh0 = sc0 ? (sc0.shots || [])[proj.curShot] || null : null;
        const c0 = sh0 ? (sh0.candidates || [])[proj.curCand] || null : null;
        return { sc: sc0 ? sc0.id : null, sh: sh0 ? sh0.id : null, cd: c0 ? c0.vid : null };
      } catch (e) { return { sc: null, sh: null, cd: null }; }
    })();
    const ws = JSON.parse(json);
    if (ws && ws.project && ws.project.id) {
      const at = WS.projects.findIndex(p => p && p.id === ws.project.id);
      if (at >= 0) WS.projects[at] = ws.project; else WS.projects.unshift(ws.project);
      WS.curId = ws.curId || ws.project.id;
      if (Array.isArray(ws.roles)) WS.roles = ws.roles;
      if (Array.isArray(ws.groups)) WS.groups = ws.groups;
    } else if (ws && Array.isArray(ws.projects)) {
      /* 老快照（只在内存里，不会持久化；保留这条兼容分支不至于让升级瞬间的 undo 抛错） */
      WS.projects = ws.projects; WS.curId = ws.curId;
    }
    proj = WS.projects.find(p => p.id === WS.curId) || WS.projects[0];
    sanitize();
    /* 视口放回用户刚才看着的那一镜（见函数开头 vp 那一段）；必须在 renderAll 之前，
       不然 sanitize 兜到 0 的那一份先画出来，页面闪一下第一镜。 */
    proj.curScene = Math.max(0, (proj.scenes || []).findIndex(s => s && s.id === vp.sc));
    const scNow = (proj.scenes || [])[proj.curScene];
    if (scNow) proj.curShot = Math.max(0, (scNow.shots || []).findIndex(x => x && x.id === vp.sh));
    const shNow = scNow ? (scNow.shots || [])[proj.curShot] : null;
    if (shNow && Array.isArray(shNow.candidates) && shNow.candidates.length) {
      proj.curCand = Math.max(0, shNow.candidates.findIndex(x => x && x.vid === vp.cd));
    }
    renderAll();
    /* renderMid 末尾会 scheduleSave；撤销/重做本身就是「回到已存状态」，
       不能让这次重画顺手把 redoStack 清掉（那会让「撤销一步再重做」直接没有反应）。 */
    clearTimeout(saveTimer); saveTimer = null;
    /* 恢复就是一个**结算点**：手里那一步（名字 + 「改动前」的那一份）到这儿已经没有意义了 ——
       留着的话，恢复之后飘出来的那一次保存会把**上一步**的名字盖在一个新状态上
       （日志末尾冒出一条念着旧名字的记录，指针还跟着它跑了）。 */
    pendingEdit = null; saveLabelNext = ''; saveQuietRound = true;
    try { $('saveState').textContent = '已保存到本地'; } catch (e) { /* 取不到那个节点也只丢一句提示，保存本身已经成了 */ }
    const snap = snapOf();
    wsKv.put('workspace', { projects: WS.projects, curId: WS.curId, roles: WS.roles, ts: Date.now() });
    lastSavedJson = snap;
    return true;
  } catch (e) {
    /* 恢复失败必须让调用方知道：快照已经弹出来了，若不压回去再报一句「已撤销」，
       用户看到的是「撤销成功」但画面没变，而且那一步再也退不回去。 */
    return false;
  }
}
/* 手里这一步「叫什么」：beginEdit 记过名的用它的名，只走 scheduleSave('<名字>') 的那一句算。
   空串 = 没有任何人报过「这一步做了什么」—— 那多半是重画顺手补的字段（画幅组合、
   时长按型号收正、参数默认值、镜像旗标），不是用户的一次编辑。
   日志里每一条都要说清做了什么，所以没名字的那一份**不进日志**（字节照旧落盘）。 */
function editLabelInFlight() { return pendingEdit ? pendingEdit.label : (saveLabelNext || ''); }
/* 500ms 合并窗口还没到期的那份改动，先结算成一步可撤销的编辑。
   scheduleSave 的定时器到期才把「改动前」压进撤销栈 —— 窗口没到就按 Ctrl+Z，
   栈顶要么是空的（回一句「可撤销的已经用完了」的假话），要么是**更早那一步**
   （一次 Ctrl+Z 把刚输入的内容整段丢掉、还额外退掉一步更早的编辑）。
   轮询那一轮的静默保存（saveQuietRound）不算用户编辑，不结算。 */
function settlePendingEdit() {
  try {
    if (!lastSavedJson || saveQuietRound) return;
    const curSnap = snapOf();
    if (curSnap === lastSavedJson) { pendingEdit = null; saveLabelNext = ''; return; }
    const label = editLabelInFlight();
    /* 叫不出名字的变化不进日志（见 editLabelInFlight）：但也不能就当没发生 ——
       重新排一次静默保存，把这几行字节落下去。 */
    if (!label) { scheduleSaveQuiet(); return; }
    if (historyCommit(label, pendingEdit ? pendingEdit.at : Date.now())) { pendingEdit = null; saveLabelNext = ''; }
  } catch (e) { /* 结算失败不拦撤销本身，按普通路径走 */ }
}
/* 撤销一步 = **指针往前挪一条**，并在日志末尾追一条「回退到 xxx」。
   不删任何记录：回退本身也是一次「发生过的事」，日志里留痕（用户点名）。
   指针前面什么都没了（指针 = -1，生效的是起点那版）就是「没有可撤销的操作」。 */
function undo() {
  /* 还没定稿的那一步先按此刻的状态定下来（否则退一步会退过头：那一格记的还是「改动前」）。 */
  historyFinalizePending();
  settlePendingEdit();
  if (historyCursor < 0) {
    /* 真·空栈只报一句临时状态（不挂常驻错误横幅）：以前那句带 class="err" 的长文案
       会走 ErrBanner 常驻横幅，「撤销按快了」这一下的分量被放大成一次故障。 */
    setStatus('没有可撤销的操作' + (undoSkipWhy ? '（' + undoSkipWhy + '）' : ''));
    return;
  }
  undoSkipWhy = '';
  const from = historyCursor;
  /* 往回挪一条；挪到 -1 = 起点那一版。回退记录追加在末尾，指针停在**它**上。 */
  if (!historyGoTo(from - 1, 'rollback', '回退到')) {
    setStatus('<span class="err">撤销失败：这份快照没能恢复，工作区保持原样</span>');
    return;
  }
  setStatus('<span class="ok">✓ 已撤销（Ctrl+Y 重做）</span>');
}
/* 重做一步 = 指针往后挪一条（挪向「刚才回退掉的那一条」），同样追加一条「重做到 xxx」。 */
function redo() {
  historyFinalizePending();
  /* 窗口内还有没结算的编辑 = 一次新编辑：先结算（它会挡住重做），
     否则重做会把一份旧状态盖在刚输入、还没落盘的内容上 —— 与 undo 那一侧同一个坑。 */
  settlePendingEdit();
  /* 指针后面最近的那一条**编辑记录**（跳过回退 / 重做这类流水记录，它们不是一版状态）。 */
  let next = -1;
  for (let i = historyCursor + 1; i < historyLog.length; i++) {
    if (historyLog[i].kind === 'edit') { next = i; break; }
  }
  if (next < 0) { setStatus('没有可重做的操作'); return; }
  if (!historyGoTo(next, 'redo', '重做到')) {
    setStatus('<span class="err">重做失败：这份快照没能恢复，工作区保持原样</span>');
    return;
  }
  setStatus('<span class="ok">✓ 已重做</span>');
}
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;   // 输入框内保留浏览器原生撤销
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

/* 候选时长（镜头行 / 总时长 / 各域共用的退路）：候选自带时长优先，退镜头声明，再退 5 秒。 */
const candDur = (c, sh) => Math.max(0.1, Number(c && c.duration) || Number(sh && sh.duration) || 5);
/* 按镜头 + 候选 id 找候选（切片流水线解地址用）：先按 vid，退回选用那条。 */
const tlCandidateOf = (sh, candId) =>
  ((sh && sh.candidates) || []).find(c => c.vid === candId) || ((sh && sh.candidates) || []).find(c => c.vid === sh.selId) || null;

/* Frames域（engine/frames.js）：这一段（501-1109）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Frames = createFrames({
  REGOf: () => REG,
  allShots: (...a) => allShots(...a),
  tlCandidateOf: (...a) => tlCandidateOf(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  assetStoreId: (...a) => assetStoreId(...a),
  sameAssetSpace: (...a) => sameAssetSpace(...a),
  freshUrl: (...a) => freshUrl(...a),
  healStaleUrls: (...a) => healStaleUrls(...a),
  mediaSrc: (...a) => Api.mediaSrc(...a),
  /* 退避到点那一次只把胶片格重新问一遍帧（不重画整板）：箭头递进，建包时 Timeline 还没初始化。 */
  stripRepaint: () => Timeline.stripRefresh(),
}, document, window);
const {
  sliceForgetFail,
  tlClipSrc,
} = Frames;

/* 成片那一轨的缩放：一个标量（tl-scale.js 的 0.25–16 倍），落本机 —— 换镜头、剪一刀都不重置。
   `tl-scale.js` 是唯一换算口，这里只存「现在是几倍」。 */
let tlZoom = (() => {
  const v = Number(window.LS && window.LS.get('dir_tl_zoom'));
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

/* Strip域（engine/strip.js）：块里面画什么 —— 画面段的胶片格、配音段的波形与文字。
   帧解码不在这边：`Frames` 那条流水线出图，这里只算采样点再把回来的图贴进格子。 */
const Strip = createStrip({
  getZoom: () => tlZoom,
  ensureFrames: (...a) => Frames.ensureFrames(...a),
  framePeek: (...a) => Frames.framePeek(...a),
  mediaSrc: (...a) => Api.mediaSrc(...a),
  icon: (n, s) => window.icon(n, s),
  esc: s => window.esc(s),
}, document, window);

/* Timeline域（engine/timeline.js）：时间线板整块 —— 工具栏 / 刻度尺 / 标记条 / 轨道与块 /
   连接点与转场浮层 / 播放头与吸附线 / 缩放与滚动。它只管画与视口操作；
   块上的手势在 engine/edit.js，播放推进在 engine/play.js，帧与波形在 engine/strip.js。 */
const Timeline = createTimeline({
  filmOf: () => ensureFilm(),
  icon: (n, s) => window.icon(n, s),
  esc: s => window.esc(s),
  fmtClock: (...a) => Wb.fmtClock(...a),
  getZoom: () => tlZoom,
  setZoom: v => { tlZoom = tlClampZoom(Number(v) || 1); if (window.LS) window.LS.set('dir_tl_zoom', String(tlZoom)); },
  setStatus: (...a) => setStatus(...a),
  scheduleSaveQuiet: () => scheduleSaveQuiet(),
  transitionSet: (...a) => transitionSet(...a),
  toolAction: (...a) => toolAction(...a),
  strip: Strip,
  /* 工具条播放/暂停那颗的换面真值（Play 在这之后才建，必须是箭头） */
  playStateOf: () => Play.playing,
  seekRequest: (...a) => Play.seek(...a),
  /* 板上的手势在 Edit 域：重画之后把选中态与浮层接回去；工具条那排的状态也从 Edit 现读。 */
  onBoardRender: () => Edit.onBoardRender(),
  toolState: () => Edit.toolState(),
  dblClickEmpty: t => Edit.addSegmentAt(t),
  /* 缩放落定 = 用户明确的重试信号：取帧退避放行一次（frames.js 的表）。 */
  sliceForgetFail: () => Frames.sliceForgetFail(),
  /* 插针落位 → 右栏「落在哪」那一行跟着换。Voice 在 Timeline 之后才建，
     这一位必须是箭头（建包时直接引用会撞 TDZ）。 */
  onPlayhead: () => Voice.paintVoicePos(),
}, document, window);

/* Play域（engine/play.js）：单调主时钟 + 单一预览面 + 配音对齐 + 转场层。
   它只读 film；播放头位置经 `Timeline.playbackStart / playbackSync / playbackStop`
   三条出口回到板上（那些名字在这里还只是箭头，第一次真正调用时早已初始化）。 */
const Play = createPlay({
  filmNow: () => ensureFilm(),
  icon: (n, s) => window.icon(n, s),
  esc: s => window.esc(s),
  fmtClock: (...a) => Wb.fmtClock(...a),
  mediaSrc: (...a) => Api.mediaSrc(...a),
  Timeline,
  bindPbFull: (...a) => bindPbFull(...a),
  pbBarHTML: (...a) => pbBarHTML(...a),
  updateArBadge: (...a) => updateArBadge(...a),
  setStatus: (...a) => setStatus(...a),
}, document, window);
/* Edit域（engine/edit.js）：块上的手势与工具条动作 —— 只改 `proj.film`，几何一律问 Timeline。
   它在 Play 之后建：`Play` 与 `Timeline` 都要按对象引用递进去（拖完一下要不要暂停、
   切开之后针落在哪一秒），而它自己只提供函数，不在初始化时读那两份的状态。 */
const Edit = createEdit({
  filmOf: () => ensureFilm(),
  icon: (n, s) => window.icon(n, s),
  esc: s => window.esc(s),
  setStatus: (...a) => setStatus(...a),
  beginEdit: (...a) => beginEdit(...a),
  filmEdited: (...a) => filmEdited(...a),
  scheduleSaveQuiet: () => scheduleSaveQuiet(),
  Timeline,
  Play,
  addMarkerAt: (...a) => addMarkerAt(...a),
  shotLines: () => allShots().map(sh => ({ id: sh.id, name: sh.name, line: sh.line, who: sh.lineWho })),
  /* 焦点变了 → 右栏那张卡（哪一档亮、卡上那几个数）跟着换。Voice 在 Edit 之后才建，
     所以这一位必须是箭头：建包时直接引用会撞 TDZ。 */
  onFocus: () => Voice.paintVcCard(),
  sliceForgetFail: () => Frames.sliceForgetFail(),
}, document, window);
/* 「手上正拖着一块」的判据只有一处该问：拖的那一层自己（Edit 域的手势）。
   中栏每 3 秒那一次重建要问的是「现在能不能重画」。 */
const dragBusy = () => Edit.dragBusy();

/* ============================================================================
   LLM 辅助：「一键分镜」那一路要的两个助手（宽松 JSON 解析 + 共用约束）。
   约定不变：LLM 只输出 JSON → 本地校验夹取 → 人确认（PromptReview）→ 应用。
   ========================================================================== */

/* 两条共用约束：只回 JSON、别解释 —— 混在多条提示词里最容易丢，所以抽出来放在最前面 */
const TL_SYS_COMMON = '你是专业视频剪辑师。只返回 JSON，不要任何解释或代码块标记。时间单位为秒，数值保留一位小数。';
/* 「贴剧本，一键拆分镜」的指令：取法只有一份（TextAI.prompt('split') = 用户改过的，没有就用 TextAI.DEF.split）。
   以前这里写的是 `localStorage.getItem('sk_polish_split') || TextAI.DEF.split` —— 绕过了 prompt()，
   于是「这条指令不许反问」（NO_ASK 里有 split）这一条保护对它不生效。 */
const splitSysOf = () => TextAI.prompt('split');
/* 「修改现有分镜」（board_edit）的指令取法同理：用户改过的优先，没有就用内置默认。
   它也在 NO_ASK 名单里（要的是 JSON —— 先反问一句，parseJsonLoose 解出来就是空）。 */
const boardEditSysOf = () => TextAI.prompt('board_edit');


/* ---------------- ④ AI 分镜：拆新 / 改现有 / 加镜头（2026-10 扩成三件事） ----------------
   页头「拆分镜」那一个入口下现在挂三档任务，判据与落点都在这一节：
     · 拆一份新的（new）   —— 贴剧本拆一个新短片（老路，口径一个字节没动）
     · 修改现有分镜（edit）—— 对着现有分镜说一句话（不说就是整体优化提示词），AI 回一份 changes
     · 接着往下拆（append）—— 把现有分镜的清单连同新文案一起喂给 AI，顺着往下加镜头
   后两档都不重拆已有镜头 —— 以前想改一句话只能「拆一份新的」，而那是另起一个短片：
   用户已经生成好的画面与剪辑记录全留在旧那个里。
   改 / 加走 board_edit 那条链，四个纯函数管全链：
     snapBoard       把当前分镜编成带序号的清单（给 AI 看、给用户对）
     boardListText   把清单拼成给 AI 的那段正文（长提示词截断，一条只留认得出身份的信息）
     boardPlanOf     把 AI 回的 changes 翻成「对哪一条镜头做什么」的账（**序号在这里就翻成镜头 id**）
     applyBoardPlan  唯一的落盘点：按 id 找到那一条就地改 / 按位置插进去
   序号只对 AI 那一句有效：审查弹窗里用户删掉几条之后序号就漂了，所以账上必须已经是 id。 */
/* 镜头时长的口径**只有「型号自己声明的区间」这一份**。
   以前这里是一份写死的 2–15 秒加一个默认 5 秒：全站根本没有统一值，各家各自声明自己的 min/max
   （注册表里实测过的是「4 到 15」与「5 到 10」两种），而界面把 AI 回的 duration clamp 到那份 2–15
   就当「合法」—— 用户不逐镜点开右栏、直接点「生成全部分镜」时，提交体发的是 AI 那个越界原值
   （按型号回写那一句只在打开这一镜时执行），平台一句 4xx 才算完。
   现在这几件事各归一处，页面不认任何一家供应商：
     videoDurSpan()       可用型号声明区间的**交集**（批量时不同镜头会落到不同平台，
                          取并集会产出「至少有一家收不了」的时长）
     boardDurNote()       把上面那个区间写成给 AI 的那句约束；区间算不出时**整句不加**
     boardDurSub()        同一件事在审查弹窗里那句「区间从哪来」，与 hint 共用算式
     clampShotDurations() 落盘之后**逐镜**按「这一镜真由谁发出去」夹回它自己那一档，并报了改了哪几镜
     suggestShots()       镜数的**软上限**：按剧本字数现算，只提示，不截断、不拦截
   ⚠ 交集不许拿 `resolvedModel(null)` 当基准：它取的是 `Api.pickable` 清单的第一项，而那份清单
     随「这台机器配了哪几家密钥」而变 —— 同一份剧本在 A 机器算 14 秒合法、在只配了上限 10 秒那家的
     B 机器就不合法。约束要跟着**路由**走，不是跟着账号的第一项走。 */
function videoDurSpan() {
  const spans = [];
  (shotModels(null) || []).forEach(g => (g.models || []).forEach(m => {
    const d = (((m && m.options) || g.options) || {}).durations;
    if (Array.isArray(d) && d.length === 2 && Number(d[0]) > 0 && Number(d[1]) >= Number(d[0]))
      spans.push([Number(d[0]), Number(d[1])]);
  }));
  const lo = spans.length ? Math.max(...spans.map(s => s[0])) : 0;
  const hi = spans.length ? Math.min(...spans.map(s => s[1])) : 0;
  const ok = spans.length > 0 && hi >= lo;
  /* `n` = 共同区间成立时参与交集的型号数（那句说明要报这个数）；
     `any` = **声明了区间**的型号数（哪怕它们彼此没有交集）。两个数不能合并：
     「一家都没声明」与「声明了但互相没有交集」是两件事，界面上要说的话不一样，
     而落盘那一 gate 只认 `any`（有声明就有得校验，逐镜夹自己那一档总做得成）。 */
  return { min: ok ? lo : 0, max: ok ? hi : 0, n: ok ? spans.length : 0, any: spans.length };
}
/* 这份 AI 给的秒数到底有没有「能判合法」的依据：没有任何一家声明区间时一个字都不写进镜头
   （镜头上没有 duration = 交给平台默认，比替平台编一个秒数诚实）。 */
const durWritable = () => videoDurSpan().any > 0;
/* 两条落盘路径唯一的 duration 写点：判据 + 取整 + 「不写」这一档都只在这里一次。 */
function setShotDur(sh, v) {
  const d = Math.round(Number(v));
  if (durWritable() && Number.isFinite(d) && d > 0) sh.duration = d;
}
/* 给 AI 的那句时长约束。可用型号为零（或它们的区间压根没有交集）时**整句不加**，
   落盘时也一律不替它写 duration —— 沿用「没声明就不碰」的立场。 */
function boardDurNote() {
  const s = videoDurSpan();
  if (!s.n) return '';
  return '每一镜的 duration 必须是 ' + s.min + ' 到 ' + s.max + ' 秒之间的整数；'
    + '按信息量分配（建立环境的镜头可以长，纯反应镜头要短），不要所有镜头一样长。'
    + '真正需要更长时间的长镜头照常给足秒数：超过所有可用型号上限时，程序会按接续型号把它拆成几段，'
    + '第二段起自动接上一段的尾帧，你不用自己拆成多条。';
}
/* 区间从哪来，那句说明就得写从哪来 —— 表单 hint 与审查弹窗 sub 共用这一句，
   否则「5–10 秒」在两处各拼一遍，其中一处迟早漏掉「按什么算的」。
   「一家都没声明」与「声明了但互相没有交集」分两句话说：后者的镜头照样按自己那一档夹得住。 */
function boardDurSub() {
  const s = videoDurSpan();
  /* 超出所有型号上限的长镜头会被程序拆成接续段（`splitLongShots`）：这是落盘前就会发生的事，
     弹窗里只看得到「5–10 秒」会让人以为长镜头被截短了。 */
  const splitNote = '；超过所有可用型号上限的长镜头会自动拆成接续段（第二段起接上一镜尾帧）';
  if (s.n) return '时长 ' + s.min + '–' + s.max + ' 秒（按本机当前可用的 ' + s.n + ' 个视频型号共同支持范围）' + splitNote;
  if (s.any) return '这 ' + s.any + ' 个可用型号的时长区间彼此没有交集，AI 不给区间、落盘时逐镜按各自型号夹回' + splitNote;
  return '本机现在没有声明时长区间的可用视频型号，镜头的 duration 交给平台默认';
}
/* 镜数的软上限：按剧本字数现算。写死一个数会跟「上限只从声明来算」的口径打架。
   它只是提醒用的档，不参与任何截断与拦截。 */
const suggestShots = text => Math.max(4, Math.round(String(text || '').length / 200 * 9));
/* 「这一段大概拆几镜」那一句话只写一次：`got` 为空 = 表单里还没 AI 结果，给了 = 审查弹窗那句。 */
function softShotsNote(text, got) {
  const n = suggestShots(text), L = String(text || '').length;
  if (got == null) return '按这段长度（' + L + ' 字），预计拆 ' + n + ' 镜左右'
    + (L > 2000 ? '；剧本较长，建议先用「拆一份新的」出骨架，再用「接着往下拆」分批补' : '');
  if (got <= n) return '共 ' + got + ' 个镜头（这一段按字数预计 ' + n + ' 镜左右）';
  return '这一段按字数预计 ' + n + ' 镜左右，这次给了 ' + got + ' 个：镜头多可以分批生成，'
    + '也可以取消重拆（本次照常写入，一个都没截掉）';
}
/* 落盘之后的兜底：逐镜按「这一镜最终由谁发出去」判（同一份 AI 结果里不同镜头落到不同平台是常态），
   夹完必须报数，不悄悄改。尺子复用 `videoPlanOf` → `AdvParams.plan` 那一档「数字档夹到最近那一秒」，
   不在这页再写一份 min/max —— 那是同一件事的第二把尺子。
   吃的是**扁平的镜头清单**：两条落盘路径各知道自己「这一次动过哪几镜」，
   拿全片所有镜头去夹会把没参与这次写入的也改一遍，那两句报数就成了假话。 */
function clampShotDurations(shots) {
  const bits = []; let n = 0;
  (shots || []).forEach(sh => {
    const cur = Number(sh && sh.duration);
    if (!Number.isFinite(cur) || cur <= 0) return;          // 没填时长的镜头不替它编一个
    const vp = videoPlanOf(sh);
    const d = (vp.kinds || {}).duration;
    if (!d || !d.list.length) return;                        // 这一家没声明区间 → 一个字不动
    const to = Number(d.value);
    if (!Number.isFinite(to) || to === cur) return;
    const mm = vp.model || {};
    bits.push((sh.name || '未命名镜头') + ' · ' + cur + ' 秒 → ' + to + ' 秒（'
      + (mm.name || mm.id || '这一型') + ' 支持 ' + d.min + '–' + d.max + ' 秒）');
    sh.duration = to; n++;
  });
  return { fixed: n, detail: bits.slice(0, 5).join('；'), more: Math.max(0, n - 5) };
}
/* 结果行里那半句「顺手夹了哪几镜」：没夹就一个字不加。 */
const clampNote = c => (!c || !c.fixed ? '' : '（其中 ' + c.fixed
  + ' 镜的时长超出各自型号支持范围，已收进区间：' + c.detail
  + (c.more ? '；另有 ' + c.more + ' 镜' : '') + '）');

/* ---------------- 接续生成：上一镜尾帧当首帧 ----------------
   两个判据各只有一处：
     chainModelList()  把可用视频型号摊平成「能不能接首帧 / 能不能接尾帧 / 时长区间」，
                       拆分镜（chain.js 的 pickChainModel）与 ensureChainModel 都读这一份；
     ensureChainModel()  接续挂着、又没显式首帧时，确保这一镜落在一个支持首帧的型号上。
   `modelAuto` 只为界面那句「已自动切到 X」服务，不是第二种模型来源。 */
function chainModelList() {
  const out = [];
  (shotModels(null) || []).forEach(g => (g.models || []).forEach(m => {
    const op = (m && m.options) || g.options || {};
    const roles = new Set((window.Capabilities ? Capabilities.specs(m) : (op.inputSpecs || [])).map(x => x.role));
    const d = op.durations;
    const span = Array.isArray(d) && d.length === 2 && Number(d[0]) > 0 && Number(d[1]) >= Number(d[0])
      ? [Number(d[0]), Number(d[1])] : null;
    out.push({ id: m.id, provider: g.id, name: m.name || m.id,
      min: span ? span[0] : 0, max: span ? span[1] : 0,
      first: roles.has('first_frame'), last: roles.has('last_frame') });
  }));
  return out;
}
function ensureChainModel(sh) {
  if (!sh) return null;
  if (sh.linkPrev !== 'tail' || sh.firstFrame) return resolvedModel(sh);
  /* 动不动、换成谁都在 chain.js 的 chainModelRepick（纯判定，判据 tests/director-chain.mjs）；
     这里只照判定落盘。Capabilities 缺位时清单只剩 registry 声明那一份静态的，
     没有「还没到货」可言，按落定算。 */
  const settled = !window.Capabilities || window.Capabilities.settled !== false;
  const pick = chainModelRepick(sh, chainModelList(), settled);
  if (pick && pick.id !== sh.model) { sh.model = pick.id; sh.modelAuto = 'chain'; }
  return resolvedModel(sh);
}
/* 手选型号接不了首帧时那一句（空串 = 没有这回事）。
   与 `ensureChainModel` 配对：程序只替「没得选」的镜头挑型号，用户明确挑过的那一型只拦不改。 */
function chainModelWhy(sh) {
  if (!sh || sh.linkPrev !== 'tail' || sh.firstFrame) return '';
  if (!sh.model || sh.model === 'auto' || sh.modelAuto === 'chain') return '';
  const m = chainModelList().find(x => x.id === sh.model);
  return m && !m.first
    ? '「' + (m.name || m.id) + '」不支持首帧，接不了上一镜的尾帧；换一个支持首帧的型号，或取消「接上一镜」'
    : '';
}
/* 这一镜为什么还不能生成里「等上一镜」那一句。能接就是空串。
   与 chain.js 的 chainDeps 返回同一套原因码，只是这里说给人听。 */
function chainWaitWhy(sh) {
  if (!sh || sh.linkPrev !== 'tail' || sh.firstFrame) return '';
  const all = allShots();
  const i = all.indexOf(sh);
  if (i <= 0) return '这是第一个镜头，没有上一镜可接';
  const prev = all[i - 1];
  if (hasTailFrame(prev)) return '';
  return isRunning(prev) ? '等上一镜出画面后才能接它的尾帧' : '上一镜还没有可用画面，先单独生成它';
}
/* 上一镜的尾帧（dataURL）+ 它从哪来。顺序固定：
   静态尾帧 → 最后一个画面切片 → 选用的候选（没有就第一条成功候选）的视频末帧。
   缓存只在内存里、键跟着候选与裁剪点走：候选换了 / 重新生成过，缓存自然命不中。
   ⚠ 不把 dataURL 写进工程、不落盘 —— 它可能是一张几 MB 的图，而完整提示词已有 PromptLog 归档。 */
const chainFrameCache = new Map();
const CHAIN_FRAME_CACHE_MAX = 8;
async function resolveChainFrame(sh) {
  const all = allShots();
  const i = all.indexOf(sh);
  if (i <= 0) throw new Error('这是第一个镜头，没有上一镜可接');
  const prev = all[i - 1];
  if (prev.lastFrame) return { src: prev.lastFrame, from: '上一镜的结尾画面' };
  const kf = (prev.keyframes || []).filter(k => k && k.assetId).pop();
  if (kf) return { src: await assetToDataURL(kf.assetId), from: '上一镜的画面切片' };
  const cand = (prev.candidates || []).find(c => c && c.vid === prev.selId && c.status === 'succeeded' && c.url)
    || (prev.candidates || []).find(c => c && c.status === 'succeeded' && c.url);
  if (!cand) {
    throw new Error(isRunning(prev) ? '上一镜还在生成，等它出画面后才能接它的尾帧'
      : '上一镜还没有可用画面，先单独生成它');
  }
  const key = prev.id + '|' + (cand.vid || cand.url) + '|' + (cand.trimE != null ? cand.trimE : '');
  if (!chainFrameCache.has(key)) {
    const p = (async () => {
      const u = await freshUrl(cand);
      return await Wb.vframe.dataURL(u, 'end', cand.trimE != null ? cand.trimE : null);
    })();
    chainFrameCache.set(key, p);
    if (chainFrameCache.size > CHAIN_FRAME_CACHE_MAX) {
      chainFrameCache.delete(chainFrameCache.keys().next().value);
    }
  }
  try { return { src: await chainFrameCache.get(key), from: '上一镜视频的尾帧' }; }
  catch (e) { chainFrameCache.delete(key); throw e; }
}
/* 当前分镜的清单快照：场景与镜头都按**从 1 开始**的序号编，时长没填就是 0。
   单独留 `sh` / `sc` 两个引用 —— 账（boardPlanOf）要靠它把序号当场翻成 id；
   只编数字的话，等用户对着弹窗删了几条，序号就指错人了。 */
const BoardTools = createBoardTools({
  durWritable: () => durWritable(), nameKey: window.nameKey,
  newShot, setShotDur, removeShot, uid, Wb, feedScenePics, clampShotDurations,
});
const { snapBoard, boardListText, boardPlanOf, applyBoardPlan } = BoardTools;

/* ============================ 拆分镜之前：这一次带哪些素材进来 ============================
   三件事各只有一处落点，页面不另写第二份：
   ① 范围（`scopes` / `resolve` / `scopeText`）—— 表单「素材范围」那一项的名单。
      选项上的条数与 `resolve` 用同一个过滤器现算，否则下拉写「角色（12 条）」而实际喂过去 11 条。
      「算不算这一组」的判据在 web/domain/chars.js 的 `Lib.groupMatch`（按 `window.nameKey` 合并近名），这里不重写。
   ② 两段式（`catalog` → `pick` → `fullText`）—— 第一段只给「谁是谁」的目录（每条 30 字），
      第二段只喂被挑中那几条的完整描述（每条截到 300 字）。整库直接倒过去会把上下文撑爆，
      一条都不喂又让 AI 认不出用户库里的角色名 —— 拆出来的镜头与素材对不上号正是这一条要治的。
   ③ 落盘（`bind`）—— 按提示词里的 `@名字` 把素材库那一张挂进 `sh.refImages`，
      判据全走 `addLibPicToShot`（能力声明 / 互斥 / 上限 / 去重 全站只那一份），这里不重写。
      **不改写提示词**：`@名字` 原样留着 —— 归档、`refTokenize`、芯片读的都是这一份原始写法，
      在这里换成 `@参考图1` 等于把同一件事拆成两份账，还会把「第几张」数错。
   选中的范围记在 `dir_asset_scope`（只存本机、不进项目文件）：分组下一次可能就被删掉，
   所以读回来先验一遍它还在不在名单里，认不出落回「不导入」。 */
const PICK_SOFT_MAX = 12;     // 只写在给 AI 的那句话里当软引导，不是硬闸：超了由参考图上限按型号夹并报数
/* 喂给 AI 的「引用写法」那句话（兜底那一份）。
   引用写法**不**由 Skill 声明 —— 那是程序的事：`@名字` 是给**生成模型**的引用
   （挂参考图，提交前换成 `@参考图N`），而 Skill 正文里的 `{变量}` 是给**写稿的 AI** 的
   项目资料（这一份角色名单长什么样）。两件事各走各的，别混成一件。
   Skill 想自己决定这些料摆哪儿 —— 写 `{assets}` 变量就行（见 board-vars.js）。 */
const RULE_WITH = '\n\n可以把下面这些素材用进镜头：在某一条的 prompt 里**原样写 @名字**'
  + '（例如「@小雅 撑伞走过河岸」），程序按名字把它的图挂成参考图。只引用下面这份清单里的名字，'
  + '不要自己编名字，也不要写成 @参考图1。\n';
const RULE_WITHOUT = '\n\n这次没有可用的素材（没选范围，或清单里挑不出相关的）：'
  + 'prompt 里**不要**写 @名字 这类引用，主体长什么样直接用文字写清楚。';
/* 「归一名字 → 库条目」那张表：挑素材（`pick`）与挂图（`bind`）问的是同一件事
   （AI 回的那个名字对得上清单里的哪一条）。
   同名多条各存各的（数组）：AI 报名字时取第一条（解析兜底），用户从挑选浮层选的按 id 精确落 refMeta。 */
function libIdx(list) {
  const m = new Map();
  (list || []).forEach(x => {
    const k = nameKey(x && x.name);
    if (!k) return;
    const arr = m.get(k) || [];
    arr.push(x);
    m.set(k, arr);
  });
  return m;
}
/* `@名字` 后面紧跟的标点不是名字的一部分（「@小雅，走进雨中」）；名字与资产名两头各洗一次，用同一份。
   没有 g flag 的非全局正则用在 replace 上不带状态，可以共享。 */
const AT_TAIL = /[，,。.、；;：:！!？?()（）\[\]【】"'“””《》]+$/;
const SplitAssets = createSplitAssets({
  BOARD_CTX_SHORT, BOARD_CTX_PROMPT, PICK_SOFT_MAX, RULE_WITHOUT, RULE_WITH, AT_TAIL,
  libIdx, nameKey: window.nameKey, TextAI: window.TextAI,
  /* 这两位搬进了 panel.js，本层要到 6504 行才把名字接回来；这里直接引用会在建包那一下撞 TDZ
     （导演台整页挂不起来），所以照别处一样包成箭头，等真被调用时再读。 */
  libPicChoices: (...a) => libPicChoices(...a),
  addLibPicToShot: (...a) => addLibPicToShot(...a),
  PLACEHOLDER_PREFIX: PENDING_PREFIX,
});
window.SplitAssets = SplitAssets;

/* ---- 拆分镜的「新素材」落盘：建档 + 占位符 ----
   ① 建档：写进素材库，组名 = 当前短片所在的项目组名（组名即素材组名，见 groups.js）。
      判据复用 `Chars.Lib.save`（同类型 + 同名 = 同一条），不另写一份写库。
   ② 占位符：素材刚建档时**还没有图**，所以提示词里先写 `@待建:小雅`（占位），
      出图之后再换成 `@小雅`（真名）并把图挂成参考图。
      这样「这一镜该引用谁」在出图前就是看得见的，出图后自动补上。
   返回 { saved, failed, group, why }：saved 是建成的那些（带库里的那条），
   failed 是没建成的与原因（照实报，不静默丢）。 */
/* Apply域（engine/apply.js）：这一段（867-1342）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Apply = createApply({
  $: $,
  WSOf: () => WS,
  projOf: () => proj,
  REGOf: () => REG,
  uid: uid,
  Groups: Groups,
  PENDING_PREFIX: PENDING_PREFIX,
  BoardAssets: BoardAssets,
  BoardVars: BoardVars,
  fillSkillVars: fillSkillVars,
  newShot: newShot,
  allShots: allShots,
  TL_SYS_COMMON: TL_SYS_COMMON,
  splitSysOf: splitSysOf,
  boardEditSysOf: boardEditSysOf,
  durWritable: durWritable,
  setShotDur: setShotDur,
  boardDurNote: boardDurNote,
  boardDurSub: boardDurSub,
  softShotsNote: softShotsNote,
  clampShotDurations: clampShotDurations,
  clampNote: clampNote,
  chainModelList: chainModelList,
  ensureChainModel: ensureChainModel,
  snapBoard: snapBoard,
  boardListText: boardListText,
  boardPlanOf: boardPlanOf,
  applyBoardPlan: applyBoardPlan,
  SplitAssets: SplitAssets,
  scheduleSave: (...a) => scheduleSave(...a),
  feedScenePics: (...a) => feedScenePics(...a),
  placeScenesInto: (...a) => placeScenesInto(...a),
  reportScenePics: (...a) => reportScenePics(...a),
  boardEstimate: (...a) => boardEstimate(...a),
  renderAll: (...a) => renderAll(...a),
  switchProject: (...a) => switchProject(...a),
  setStatus: (...a) => setStatus(...a),
}, document, window);
const {
  aiStoryboard,
  renderSplitPanel,
} = Apply;


/* 一次会改动成片内容的编辑做完后调它：重画 + 存档。
   **这里不再自动合成**（2026-10 用户要求：合成只该发生在「导出成片」那一下）。
   以前这里是 `renderAll(); scheduleSave(); maybeAutoMerge();` —— 只要用户**曾经**合并过一次，
   之后每改一个入点、每切一刀，都会在 1.2 秒后自动整片合成一遍（几十秒、占满 CPU），
   而剪辑本来就是连续微调的动作（改一处看一眼再改），于是整段时间都在重复合成。
   现在：编辑只改数据与画面，成片要等你点「导出成片」时才重做
   （那时快捷闸 `filmIsCurrent` 自己判旧的那份已过期，照常真跑一遍合成）。 */
function filmEdited() {
  /* 切段 / 改倍速之后那几格的采样点已经换了，原来记的「这块取不到帧」不再作数：
     放行一次，让下一次重画真的去取。 */
  sliceForgetFail();
  /* 右栏正在**打字**（textarea / 文本输入框）时不重建那一栏 —— renderSoft 同一条规矩：
     重建会把输入框换掉，输入法正在拼的字被丢掉。这一下常由助手动作 / 后台事件触发，
     撞在用户打字的当口；滑块 / 下拉那些离散控件不在此列，照旧立刻重画。 */
  renderPending = false; renderScenes(); renderMid();
  if (typingIn('#edCol')) renderPending = true; else renderEditor();
  updateBanner(); updateProjUI();
  scheduleSave();
}

/* 关标签/刷新前的同步兜底：IndexedDB 的写入是异步的，beforeunload 里不能等它。
   这里把同一份工作区写进 localStorage 的**一次性**键（只有出现未落盘改动时才写），
   下次启动读完就删；它不是第二份工作区，只是「最后 500ms」的救生包。 */
const K_WS_UNLOAD = 'dir_ws_unload';
let wsFlushOk = false;
window.__spaFlush = () => {
  wsFlushOk = false;
  /* 还没装配完（见 wsLoaded）：这一趟要写的会是「空的」工作区，一个字节都不许落。
     直接当「没有未落盘改动」交出去 —— 装配完成后首屏那一次 renderAll 会自己排上一次真保存。 */
  if (!wsLoaded) { wsFlushOk = true; return; }
  let dirty = false;
  try { dirty = !!saveTimer || !lastSavedJson || snapOf() !== lastSavedJson; } catch (e) { dirty = true; }
  if (!dirty) { wsFlushOk = true; return; }
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    if (!WS || !Array.isArray(WS.projects)) return;
    const rec = { projects: WS.projects, curId: WS.curId, roles: WS.roles, groups: WS.groups, ts: Date.now() };
    /* 救生包：同步写 localStorage（beforeunload 等不到 IndexedDB）。隐私 / 禁存模式写不进去，
       那份就只剩 IndexedDB —— 写成的这一份才算「都落了」，所以直接拿 LS 的返回值当旗标。 */
    wsFlushOk = window.LS.setJson(K_WS_UNLOAD, { ts: rec.ts, data: rec });
    /* 正常路径：IndexedDB + 代理那份镜像也推一次（浏览器不一定会等它，所以上面那份才是兜底）。 */
    try { wsKv.put('workspace', rec).catch(() => {}); } catch (e) { /* IndexedDB 不可用（无痕 / 被禁）：上面那份救生包已经写了 */ }
    try { if (window.DataSync) DataSync.mirrorWs(JSON.stringify({ v: 1, data: rec, ts: rec.ts })); } catch (e) { /* 镜像推不动不影响本机那一份已经落下去 */ }
  } catch (e) { /* 兜底这一段任何一步抛错都不能拦住关标签 */ }
};
window.__spaDirty = () => {
  if (wsFlushOk) return false;
  try { return !!saveTimer || !!(lastSavedJson && snapOf() !== lastSavedJson); } catch (e) { return false; }
};
try { if (window.__spaRegister) window.__spaRegister(window.__spaFlush, window.__spaDirty); } catch (e) { /* 不在 SPA 外壳里（裸页面 / 探针）就没有这两个钩子 */ }
/* 快照正文（不含开头的 curId）：切短片只动 curId、不动任何内容，
   不该当成一次可撤销的编辑。snapOf 的键序固定（curId 在最前），
   切在第一个 ,'project" 上即可，不用再序列化一遍。 */
function snapBodyOf(s) { const i = s.indexOf(',"project"'); return i < 0 ? s : s.slice(i); }
let saveQuietRound = true, saveLabelNext = '';
function scheduleSave(label) {
  /* 装配窗口里的重排/重画（换页、resize、下拉重建）也会叫到这里：那时 WS 还是空的默认值，
     排下去的就是「把工作区存成没有工程」——和 __spaFlush 同一道闸，没装配完直接不排。 */
  if (!wsLoaded) return;
  if (label) saveLabelNext = label;
  saveQuietRound = false;          // 这一轮里有过「用户编辑」的保存请求 → 到期照旧压撤销
  wsFlushOk = false;
  $('saveState').textContent = '保存中…';
  armSaveTimer();
}
/* 轮询回填那一族的保存：候选状态 / 顺序 / 过期地址变了也要落盘，但**不压撤销** ——
   它们不是用户的编辑，30 步的栈不该被轮询一趟一趟吃光。
   同一轮里只要混进过一次普通 scheduleSave（用户真的改了东西），到期还是照旧压。 */
function scheduleSaveQuiet() {
  if (!wsLoaded) return;
  wsFlushOk = false;
  $('saveState').textContent = '保存中…';
  armSaveTimer();
}
function armSaveTimer() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout
  (async () => {
    saveTimer = null;
    const snap = snapOf();
    const quiet = saveQuietRound;
    /* 这一步叫什么要在这里取：紧接着 saveLabelNext 就被清空了。 */
    const label = editLabelInFlight();
    saveQuietRound = true; saveLabelNext = '';
    /* 一个字节都没变（轮询到「还是生成中」、或者重画顺手调了一次）：不写 IndexedDB、
       不做镜像、也不往撤销栈里再压一份。以前这里无条件 stringify + put + mirrorWs，
       一次 3 秒的轮询就是一次整份工作区的序列化与落盘。 */
    if (lastSavedJson && snap === lastSavedJson) {
      $('saveState').textContent = '已保存到本地';
      return;
    }
    /* 压撤销的门槛有三道：这一轮不是静默的（有过用户编辑），变的不是只有 curId
       （切短片不消耗撤销次数），而且**这一步叫得出名字**（见 editLabelInFlight）。 */
    if (lastSavedJson && !quiet && snapBodyOf(snap) !== snapBodyOf(lastSavedJson)) {
      /* 记一步 = 往**只追加**的日志末尾追一条（老的记录一条都不动）。
         没名字的那一份只落盘不进日志：重画顺手补的字段（画幅组合 / 时长收正 / 参数默认值）
         不是用户的一次编辑，记进日志就是那句没说清做了什么的话。 */
      if (label && historyCommit(label, pendingEdit ? pendingEdit.at : Date.now())) pendingEdit = null;
    }
    try {
      const wsRec = { projects: WS.projects, curId: WS.curId, roles: WS.roles, groups: WS.groups, ts: Date.now() };
      await wsKv.put('workspace', wsRec);
      lastSavedJson = snap;
      $('saveState').textContent = '已保存到本地';
      /* 同时写一份到代理的数据目录（.data/workspace.json）：浏览器存储被清掉时还能从磁盘恢复。
         这里只有**引用**（每条素材指向本机资产库里的一个资产号），视频字节不在 JSON 里 ——
         所以这一份备份认得工程与时间线，字节能不能取回，看那一根还在不在库根里
         （库根默认在系统下载下的 成像\，见设置页「本机资产库」那一格）。
         （原来这句写的是「Blob 在 IndexedDB 里按 blobKey 存」—— 那个键全项目没有一处赋值，
          见下面 exportProject 那一段的注释。） */
      if (window.DataSync) {
        try { window.DataSync.mirrorWs(JSON.stringify({ v: 1, data: wsRec, ts: wsRec.ts })); } catch { /* 镜像是尽力而为，本机 IndexedDB 那一份才算数 */ }
      }
    } catch (e) {
      // 配额不足 / 事务失败：明确报错，别一直停在「保存中…」
      $('saveState').textContent = '保存失败';
      setStatus('<span class="err">本地保存失败：' + errText(e) + '（工作区可能过大，可先导出项目备份）</span>');
    }
  }, 500);
}

/* ---------- API ---------- */
/* 上传图片前压缩：最长边 1600、JPEG 0.88，显著降低 IndexedDB 体积 */
function compressImg(file) {
  return new Promise(res => {
    if (file.size < 600 * 1024) return res(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      if (scale >= 1) return res(file);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => res(b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.88);
    };
    img.onerror = () => res(file);
    img.src = URL.createObjectURL(file);
  });
}
/* 上传阶段文案（web/ui/ui.js 的 uploadStageText，导演台没加载 workbench.js 也能用）：
   取回素材 / 申请上传地址 / 上传字节（带真实进度）三态由它统一成一句话 */
const dlStage = label => (stage, info) => {
  const t = uploadStageText(stage, info, label);
  if (t) setStatus(t);
};
/* 素材转存有**两个不同落点**，不要混成一个：
   · assetStoreId()：给「时间线 / 预览 / 长期可取回地址」用。代理的 /asset/<id> 只按注册表顶层
     `assetStore` 声明点名的那一家换签名地址（server/registry-config.js 的 resolveAssetStore），
     所以这一类素材只能传它 —— 换平台时改声明即可，这里不再写死名字。
   · assetProvFor(sh)：这一镜的**参考素材**要传到它真正所属的平台 —— VGENV 只认自家 asset_id
     （registry 里 needsUpload 的 role），以前这里一律传 SparkCine，VGENV 镜头挂参考视频/音频必被上游拒。 */
function assetStoreId() {
  const d = (REG && REG.assetStore) || null;
  return (d && d.provider) || 'sparkcine';   // 与 resolveAssetStore 同一条口径：没声明才退回内置那家
}
/* 两个平台的资产是否互通：同一 relay = 同一套账号下的资产库（SparkCine 的图/视频台共用） */
function sameAssetSpace(provIdA, provIdB) {
  const list = (REG && REG.providers) || [];
  const hit = id => list.find(p => p.id === id || (p.keyId || p.id) === id);
  const a = hit(provIdA), b = hit(provIdB);
  if (!a || !b) return false;
  return (a.relay || a.id) === (b.relay || b.id);
}
/* 这一镜的参考素材该传给谁（没选到模型时退回资产库平台） */
function assetProvFor(sh) {
  const rm = resolvedModel(sh) || {};
  return rm.provider || assetStoreId();
}
/* 余额格式化与卡片都在 web/ui/sidebar.js（侧边栏底部）；这里只负责触发它刷新 */
async function loadCredits() { window.dispatchEvent(new Event('sb-balance-refresh')); }

/* 生成中：空态下方显示这一镜的任务详情（模型 / 参数 / 提交时间 / 已耗时 / 队列位置 / 进度） */
function playerTaskDetails(sh) {
  const list = sh.candidates || [];
  if (!list.length) return '';                                  // 没有候选（占位状态）：不显示任务详情
  const c = list[proj.curCand] || list[0];                       // 只显示当前查看的这一条
  if (!c || !['creating', 'queued', 'running'].includes(c.status)) return '';
  const rm = resolvedModel(sh) || {};
  const now = Date.now();
  const rows = [c].map((c2, i) => {
    const waited = c2.created ? Math.max(0, Math.round((now - c2.created) / 1000)) : null;
    const bits = [
      ['候选', '第 ' + (proj.curCand + 1) + ' / ' + list.length + ' 条'],
      ['型号', (rm.name || rm.id || '') + (sh.res ? ' · ' + sh.res : '') + (sh.ar ? ' · ' + sh.ar : '') + (sh.duration ? ' · ' + sh.duration + '秒' : '')],
      ['状态', ST_ZH[c2.status] || c2.status],
      c2.queue_position ? ['队列位置', '第 ' + c2.queue_position + ' 位'] : null,
      c2.status === 'running' && c2.progress ? ['进度', c2.progress + '%'] : null,
      c2.created ? ['提交时间', window.fmtHMS(c2.created)] : null,
      waited != null ? ['已耗时', Wb.fmtSec(waited)] : null,
      c2.priceText ? ['费用', c2.priceText] : null,
    ].filter(Boolean);
    return `<div class="pe-row">${bits.map(([k2, v2]) => `<span class="k">${k2}</span><span class="v">${esc(String(v2))}</span>`).join('')}</div>`;
  }).join('');
  return `<div class="pe-task">${rows}</div>`;
}

/* 本地导入的候选（以及重启后按 blobKey 重建的 blob: 地址）每次地址都不一样 —— 拿它当缩略图缓存键
   等于「首帧白抽一次，下次又重新加载」。这类素材改用**候选号**当稳定键，地址只用于取字节。 */
function thumbKey(c) {
  const s = String((c && c.url) || '');
  if (/^blob:/i.test(s)) return c.vid ? 'local:' + c.vid : s;
  /* 其余地址一律交给公共层归一化（签名参数剥掉才算得出同一个身份）：
     自己拼原始签名地址当键，每轮刷新就换一个键，缓存永远命不中。 */
  return Wb.thumbs.keyOf(s);
}
/* ---------- 候选卡片（媒体标记与首帧缓存全部走 Wb.thumbs.mediaHTML，页面不再自己拼） ---------- */
/* 没有画面时那一格写什么：整块重画与轮询增量补丁共用这一份措辞
   （两处各写一份时，增量那份漏了 draft 分支，待写描述的候选会被改成「生成中」）。 */
function candStatusText(c) {
  return c.status === 'draft' ? '待写描述'
    : c.status === 'failed' ? '生成失败' : c.status === 'cancelled' ? '已取消'
    : c.status === 'queued' ? '排队中' : (c.status === 'creating' ? '创建中' : '生成中');
}
/* 这一镜「还没结束的那一条」（排队 / 创建中 / 正在跑都算）—— 进度条按它的 progress 走。 */
const shotRunCand = sh => (sh.candidates || []).find(c => c.status === 'running' || c.status === 'queued' || c.status === 'creating') || null;
/* 镜头状态只有一份措辞（右栏镜头清单与中栏「顺序」那条缩略图带共用）：
   「生成中」只给**真在跑的那一条**（`candStatusText` 那一份），排队中就写排队中、创建中就写创建中；
   而「有候选但没有任何在跑的」不再是生成中 —— 全部失败、全部取消、出片了却还没被选用，
   这三种都是「停下来等人处理」，挂着生成中会让人一直等一个不会再动的任务。
   （「顺序」带以前只按 `candidates.length` 判，于是全失败的那一镜永远显示生成中。） */
function shotStatusOf(sh) {
  const runC = shotRunCand(sh);
  const cands = sh.candidates || [];
  const allBad = cands.length > 0 && cands.every(c => c.status === 'failed' || c.status === 'cancelled');
  const text = shotReady(sh) ? '已选用'
    : runC ? candStatusText(runC)
    : allBad ? '生成失败'
    : cands.length ? '待选用'
    : (String(sh.prompt || '').trim() ? '未生成' : '待写描述');
  const cls = shotReady(sh) ? 'okc' : runC ? 'runc' : allBad ? 'errc' : '';
  return { runC, text, html: cls ? '<span class="' + cls + '">● ' + text + '</span>' : text };
}
function candMediaHTML(c) {
  if (c.url) return Wb.thumbs.mediaHTML(c.url, { key: thumbKey(c) });
  const cls = (c.status === 'draft' ? ' draft' : '') + (c.status === 'failed' || c.status === 'cancelled' ? ' fail' : '');
  return `<div class="pending${cls}">${candStatusText(c)}</div>`;
}
function candTitle(c) {
  const bits = [c.status === 'draft' ? '待写描述' : (ST_ZH[c.status] || c.status)];
  if (c.prompt) bits.push('描述：' + String(c.prompt).slice(0, 60));
  if (c.status === 'running' && c.progress) bits.push(c.progress + '%');
  if (c.queue_position) bits.push('队列#' + c.queue_position);
  if (c.created) bits.push('提交 ' + window.fmtHM(c.created));
  if (c.priceText) bits.push(c.priceText);
  if (c.error) bits.push(c.error);
  return bits.join(' · ');
}
function candBadgeHTML(c) {
  try {
    if (!window.AssetLocal || !AssetLocal.showBadge || !AssetLocal.showBadge() || !AssetLocal.stateOf) return '';
    const EM = window.EditorMedia;
    /* 徽标本身（文案 / class / title）只有 ui/badge-state.js 那一份 */
    return window.badgeHTML(AssetLocal.stateOf(EM ? EM.entryOf(c) : c));
  } catch (e) { return ''; }
}
function candThumbInner(c, isCur, i) {
  const list = (curShot() || { candidates: [] }).candidates || [];
  if (i === undefined) i = list.indexOf(c);
  return `<div class="cand-thumb${isCur ? ' cur' : ''}${c.vid === (curShot() || {}).selId ? ' sel' : ''}${c.locked ? ' lock' : ''}${c.status === 'succeeded' && c.url ? ' has' : ''}" data-vid="${esc(String(c.vid))}" data-i="${i}" title="${esc(candTitle(c))}">
    <span class="candno">${i + 1}</span>${c.locked ? `<span class="lockbadge">${icon('lock', 11)}</span>` : ''}${candMediaHTML(c)}${candBadgeHTML(c)}</div>`;
}
/* 没有候选时的占位卡：点了就按这一镜的配置生成一条 */
function candPlaceholder() {
  return `<div class="cand-thumb addcand big" data-add="1">
      <span class="plusic">${icon('plus', 18)}</span><span class="pt">还没有候选</span><span class="pd">点这里新增</span>
    </div>`;
}
/* 有候选时行尾的小加号：再抽一条 */
function candAddTile() {
  return `<div class="cand-thumb addcand" data-add="1" title="先写这条候选的描述，再点「生成这条」">${icon('plus', 16)}</div>`;
}
let midCandExpand = window.LS.get('dir_cand_expand') === '1';
/* 播放器下方那一排控件**只有一份标记**：剪辑态那个预览面与候选播放器以前各抄一遍
   （三行一模一样的按钮 + 一份「按 localStorage 决定喇叭图标」的判断），改一颗就得记着改两处。
   左下 = 播放/暂停 + 时长读数；右下 = 声音 + 全屏，两颗挨着、全屏在最右下角（用户点名）。
   静音态的图标与 title 都按 dir_muted 现读，不写死「声音开关」。 */
function pbBarHTML() {
  const muted = window.LS.get('dir_muted') === '1';
  return `<div class="pb-bar">
        <button class="pb-btn" id="pbBtn" title="播放 / 暂停">${icon('play', 15)}</button>
        <span class="pb-time" id="pbTime">00:00 / 00:00</span>
        <span class="sp"></span>
        <button class="pb-btn" id="pbMute" title="${muted ? '已静音' : '声音已开启'}">${icon(muted ? 'speakerOff' : 'speaker', 14)}</button>
        <button class="pb-btn" id="pbFull" title="全屏观看">${icon('expand', 14)}</button>
      </div>`;
}
/* 全屏：整块 `.player-box` 进去，控件跟着一起（只让 <video> 进全屏的话，
   全屏里就没有退出那颗了）。两个播放器共用这一份接线。
   被浏览器挡下来时（reject）不能只「点了没反应」—— 那是一颗看着能点、其实什么都不做的按钮。 */
function bindPbFull(box) {
  const fb = box && box.querySelector('#pbFull');
  if (!fb) return;
  fb.onclick = e => {
    e.stopPropagation();
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => 0); return; }
    box.requestFullscreen().catch(() => setStatus('<span class="err">全屏没成：浏览器不让这一层画面进全屏</span>'));
  };
}
/* 全屏正开着 → 中间栏这一轮不重建（`renderMid` 开头那一句问的就是它）。
   浏览器此刻显示的只有 `.player-box` 这一层，别处重画用户看不见；而 `renderMid` 是整列
   `col.innerHTML =`（连 `keepBox` 那一路也先 `old2.remove()` 一次）—— **全屏元素脱离文档 = 当场退出全屏**。
   轮询每 3 秒走一次 `renderSoft` → `renderMid`，所以「全屏进去几秒就被弹回工作台」是这一条，
   不是浏览器不让进。欠下的那一轮在退出那一刻补画：`fullscreenchange` 只在**离开**时做事。 */
let fsRedraw = false;
function fullscreenHold(col) {
  /* 必须先确有播放器再比：首屏中栏还是空的，`querySelector` 与 `document.fullscreenElement`
     会同时是 null —— `null !== null` 为 false，这一句会把「还没画」误判成「正在全屏」，
     于是 renderMid 每次都早退、中栏永远画不出来（自锁）。 */
  const box = col && col.querySelector('.player-box');
  if (!box || document.fullscreenElement !== box) return false;
  fsRedraw = true;
  return true;
}
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement || !fsRedraw) return;
  fsRedraw = false;
  renderMid();
});
/* 中间栏那只播放器**此刻该放哪一条素材**——判据只有一份：
   `playerAreaHTML` 用它出 src 与首帧，`renderMid` 用它决定「这一轮要不要保住旧节点」。
   两处各算一份就会出现「保住的是上一条候选」，那比闪一下更难查。
   剪辑态交回 null —— 那一档没有单一素材，两个甲板按时间线轮流放。 */
function playerMediaOf(sh) {
  if (midEditTrim) return null;
  const cur = ((sh && sh.candidates) || [])[proj.curCand];
  return cur && cur.url ? { cur, src: Api.mediaSrc(cur.url) } : null;
}
/* 播放区文案（本镜候选 / 剪辑态实时预览 / 空态） */
function playerAreaHTML(sh) {
  /* 剪辑态：播放交给 Play（单一预览面，按当前 clip 换元素）。
     这是「剪完马上看到效果」的落点 —— 改一个入点不用再整片合成一次。 */
  if (midEditTrim) {
    /* 一段都没有（这一镜没候选 / 还没有任何已选用的镜头）就别摆一个黑框骗人 ——
       那正是「看着能播、其实什么都没有」的空控件，按全站约定要照实说一句。 */
    if (!Play.clipCount()) {
      return `<div class="player-empty">
        <div class="pe-t">还没有已选用的镜头</div>
        <div class="pe-d">先在候选上点「选用」，这里的剪辑预览就会按剪完的样子播</div>
      </div>`;
    }
    return Play.stageHTML();
  }
  /* 走到这里就是生成态：剪辑态在上面已经 return（两个甲板 + 实时播），
     不再有别的一种播放器。 */
  const pm = playerMediaOf(sh);
  if (pm) {
    const frame = Wb.thumbs.get(pm.cur.url, thumbKey(pm.cur)) || '';
    return `<div class="player-box">
      <video id="player" src="${esc(pm.src)}" playsinline${frame ? ` poster="${frame}"` : ''}></video>
      ${pbBarHTML()}
      <span class="arbadge" id="arBadge"></span></div>`;
  }
  return `<div class="player-empty">
    <div class="pe-t">${playerEmptyText(sh)[0]}</div>
    <div class="pe-d">${playerEmptyText(sh)[1]}</div>
    ${playerTaskDetails(sh)}
  </div>`;
}
/* 操作行（导入 | 弹性空 | 取消选用/选用 | 锁定 / 删除）：取消选用与选用是同一格的两面 —— .faces
   把两面叠放在同一格里并各自右对齐，露出来的那面永远贴着锁定，不在用的那面挂 .off
   （visibility 隐身、宽度照常撑着这一格）—— 这一排随轮询重画，按钮一挪，点下去就落在别的键上。
   锁定那颗的文案只许等宽短词（锁定 / 解锁）：再长的字串会把右边的删除键横推出去；锁没锁看缩略图右上的角标。 */
function candActsHTML(sh) {
  const cands = sh.candidates || [];
  const cur = cands[proj.curCand];
  const picked = !!(cur && cur.vid === sh.selId);
  const usable = !!(cur && !picked && cur.status === 'succeeded' && cur.url);
  return `<span class="faces"><button class="ghost${picked ? '' : ' off'}" id="unsel" ${picked && !cur.locked ? '' : 'disabled'}>× 取消选用</button><button class="ghost${picked ? ' off' : ''}" id="usec" ${usable ? '' : 'disabled'}>✓ 选用</button></span>
    <button class="ghost" id="lockc" ${cur ? '' : 'disabled'}>${icon('lock', 12)} ${cur && cur.locked ? '解锁' : '锁定'}</button>
    <button class="ghost danger" id="delc" ${cur && !cur.locked ? '' : 'disabled'}>${icon('trash', 12)} 删除</button>`;
}
/* 操作行的按钮绑定（renderMid 与「切换候选」共用） */
function bindCandActs(col) {
  col = col || $('midCol');
  if (!col) return;
  const sh = curShot();
  if (!sh) return;
  const cur = (sh.candidates || [])[proj.curCand];
  const uc = col.querySelector('#usec');
  if (uc) uc.onclick = () => {
    const candNo = (sh.candidates || []).indexOf(cur) + 1;
    const prevNo = (sh.candidates || []).findIndex(x => x.vid === sh.selId) + 1;
    beginEdit(prevNo
      ? `把「${sh.name || '这一镜'}」选用的候选从第 ${prevNo} 条换成第 ${candNo} 条（${fmtDur(candDur(cur, sh))}）`
      : `把「${sh.name || '这一镜'}」第 ${candNo} 条候选（${fmtDur(candDur(cur, sh))}）接进成片`);
    setSelectedCandidate(sh, cur);
    filmEdited();
  };   // 选用后不自动锁定，可手动加锁（换候选 = 成片内容变了）
  const un = col.querySelector('#unsel');
  if (un) un.onclick = () => {
    /* 不设二次确认：撤选用一步可逆（重新点「选用」或 Ctrl/⌘+Z 都回得来），
       这排里带「确认…」的只有删除那颗 —— 它真的删字节。 */
    beginEdit(`把「${sh.name || '这一镜'}」从成片里撤掉（取消选用第 ${Math.max(1, (sh.candidates || []).findIndex(x => x.vid === sh.selId) + 1)} 条候选）`);
    setSelectedCandidate(sh, null);
    filmEdited();
  };
  const lk = col.querySelector('#lockc');
  if (lk) lk.onclick = () => { if (cur) { cur.locked = !cur.locked; renderAll(); scheduleSave(); } };
  const dl = col.querySelector('#delc');
  if (dl) dl.onclick = e => {
    const b = e.currentTarget;
    /* 就地确认走默认画法（与取消选用同一副）：整颗变红换字「确认删除？」，再点一下才真删；
       不带红环 / 角标 / toast。还在跑的这条撤不撤得了单，由注册表的 cancel 声明决定
       （判据只有 Api.canCancel 一份）：没有取消接口的那几家删了本机记录，平台上那条照样跑完。 */
    const live = !!cur && (cur.status === 'queued' || cur.status === 'running');
    const cxProv = live ? provById(cur.provider) : null;
    Confirm.arm(b, '确认删除？')
      || (() => {
        if (!cur || cur.locked) return;
        if (live && cxProv && Api.canCancel(cxProv)) {   // 还在跑的先取消上游任务
          // 取消走统一路由：POST 还是 DELETE 由 registry 的 cancelMethod 声明决定
          // 撤单失败不能静默吞 —— 那样用户以为平台上也没了，而那条还在计费
          Api.cancel(cxProv, cur.vid).catch(e => Toast.warn('没能让平台停掉这条任务：' + errText(e) + '（平台上可能还在跑）'));
        }
        sh.candidates = (sh.candidates || []).filter(c => c !== cur);
        if (sh.selId === cur.vid) setSelectedCandidate(sh, null);
        releaseCandUrl(cur);                                          // 本地视频的 blob: URL 用完了要回收
        proj.curCand = Math.max(0, Math.min(proj.curCand, sh.candidates.length - 1));
        filmEdited();
      })();
  };
}
/* 切换查看的候选：只改瓦片高亮 + 换播放器地址（<video> 元素原地保留，不动缩略图） */
function selectCandidate(at) {
  const col = $('midCol'), sh = curShot();
  if (!col || !sh) return;
  const cands = sh.candidates || [];
  if (at < 0 || at >= cands.length || at === proj.curCand) return;
  proj.curCand = at;
  /* 提示词框跟着换到**当前查看的候选**当年那句（promptTextOf 读的就是它），
    但**不回写 sh.prompt**：翻看是纯预览，这一镜的描述（左栏卡片 / 批量生成读的那份）
    只能由用户输入或 AI 拆分镜改 —— 以前顺手 `sh.prompt = picked.prompt`，
    用户刚写的新描述会被一条旧候选的旧描述顶掉，而且这一下还被当成一次编辑压进撤销栈。
    「生成这一镜」按屏幕上这句发（drawShot 收 promptTextOf(sh)），不会出现
    「屏幕上写着 B、生成出来的却是 A」。 */
  paintPromptBox(sh);
  col.querySelectorAll('.cand-thumb[data-vid]').forEach(t => {
    const c = cands.find(x => String(x.vid) === t.dataset.vid);
    t.classList.toggle('cur', c === cands[at]);
  });
  const target = cands[at];
  const pw = col.querySelector('#playerWrap');
  const pl = col.querySelector('#player');
  if (pw && target && target.url && pl) {
    // 已经有播放器：只换地址（再拿缓存首帧当封面，尽量不黑一下）
    const frame = Wb.thumbs.get(target.url, thumbKey(target)) || '';
    if (frame) pl.setAttribute('poster', frame); else pl.removeAttribute('poster');
    if (pl.getAttribute('src') !== Api.mediaSrc(target.url)) { pl.setAttribute('src', Api.mediaSrc(target.url)); try { pl.load(); } catch (e) { /* 换源后 load 被拒（正在播）不影响下一次起播 */ } }
    const badge = col.querySelector('#arBadge');
    if (badge) { badge.textContent = ''; badge.title = ''; }
    if (pl.readyState >= 1) updateArBadge(pl);
  } else if (pw) {
    // 当前这条还没有画面（排队/失败）或本来就没有播放器：重画播放区（这里没有视频缩略图，重建不会闪）
    pw.innerHTML = playerAreaHTML(sh);
    // 接线与整栏重画是同一份（Mid.wireMidPlayer）：这里以前那份缩水接线少了播放态换面
    Mid.wireMidPlayer(col, { sh, cur: target, keepPlay: null, keepBox: null });
  }
  /* 只换尾段（#candActsRest）：#candActs 里前面的导入与弹性空是常驻的，
     整行换会把导入抹掉、三颗按钮失了弹性空挤到左边去 */
  const ca = col.querySelector('#candActsRest');
  if (ca) { ca.innerHTML = candActsHTML(sh); bindCandActs(col); }
  scheduleSave();
}

/* 中栏「就地更新」：轮询到新状态时只改需要改的节点，不重建整块 —— 候选缩略图不会一次次重画/重载 */
function updateMidLive() {
  const col = $('midCol');
  const sh = curShot();
  if (!col || !sh || !col.querySelector('.mid-head')) return;
  const cands = sh.candidates || [];
  const curC = cands[proj.curCand] || null;
  // ① 每个候选瓦片：只改 class / title，必要时才换「占位 ↔ 媒体」这一小块
  col.querySelectorAll('.cand-thumb[data-vid]').forEach(t => {
    const c = cands.find(x => String(x.vid) === t.dataset.vid);
    if (!c) return;
    const want = 'cand-thumb' + (curC === c ? ' cur' : '') + (c.vid === sh.selId ? ' sel' : '')
      + (c.locked ? ' lock' : '') + (c.status === 'succeeded' && c.url ? ' has' : '');
    if (t.className !== want) t.className = want;
    const title = candTitle(c);
    if (t.title !== title) t.title = title;
    const media = t.querySelector('video, img');
    if (c.url && !media) {                                  // 刚出片：占位换成媒体（只动这一块）
      const tmp = document.createElement('div');
      tmp.innerHTML = candMediaHTML(c);
      while (tmp.firstChild) t.appendChild(tmp.firstChild);
      const m2 = t.querySelector('video, img');
      if (m2) Wb.thumbs.bind(t, m2, c.url);
    } else if (!c.url && media) {                           // 又变回没有画面（重试等）：媒体换回占位
      const tmp = document.createElement('div');
      tmp.innerHTML = candMediaHTML(c);
      media.replaceWith(...tmp.childNodes);
    } else if (!c.url) {                                    // 一直是占位：只改文案
      const p = t.querySelector('.pending');
      if (p) {
        const txt = candStatusText(c);
        if (p.textContent !== txt) p.textContent = txt;
        p.classList.toggle('fail', c.status === 'failed' || c.status === 'cancelled');
        p.classList.toggle('draft', c.status === 'draft');
      }
    }
  });
  // ② 播放器：当前候选刚拿到地址 → 需要结构变化，交给完整重画（一次性）
  if (curC && curC.url && !col.querySelector('#player')) { renderMid(); return; }
  const pl = col.querySelector('#player');
  if (pl && curC && curC.url && pl.getAttribute('src') !== Api.mediaSrc(curC.url)) { pl.setAttribute('src', Api.mediaSrc(curC.url)); }
  // ③ 空态里的任务详情：只更新文字
  const host = col.querySelector('.player-empty');
  if (host) {
    const html = playerTaskDetails(sh);
    const old = host.querySelector('.pe-task');
    if (old && !html) old.remove();
    else if (old) old.outerHTML = html;
    else if (html) host.insertAdjacentHTML('beforeend', html);
  }
}

/* 把当前选中那条候选滚进候选条视野：只在用户主动翻条（‹ / ›）时调用；
   新增候选、轮询刷新等自动重画一律保持原滚动位置，不抢视线。 */
function scrollCurThumbIntoView() {
  const box = document.getElementById('candThumbs');
  if (!box) return;
  const el = box.querySelector('.cand-thumb.cur') || box.querySelectorAll('.cand-thumb')[proj.curCand];
  if (!el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.left < b.left) box.scrollLeft = Math.max(0, box.scrollLeft + (r.left - b.left) - 8);
  else if (r.right > b.right) box.scrollLeft = box.scrollLeft + (r.right - b.right) + 8;
}

/* 候选条的交互绑定：候选瓦片（切换查看）、占位卡/加号（加一条）、「加一条候选」按钮 */
function bindCandidateStrip(col) {
  col.querySelectorAll('.cand-thumb').forEach(t => {
    if (t.dataset.add) {                                // 占位卡 或 行尾加号
      if (!t.dataset.bound) { t.dataset.bound = '1'; t.onclick = () => addCandidateDraft(); }
      return;
    }
    if (!t.dataset.bound) {                             // 复用来的节点已经绑过，别重复绑
      t.dataset.bound = '1';
      t.onclick = () => {
        const vid = t.dataset.vid;
        const at = (curShot().candidates || []).findIndex(c => String(c.vid) === vid);
        selectCandidate(at);                            // 只换播放器与操作行，不碰候选缩略图
      };
    }
    const media = t.querySelector('video, img');
    /* 接线走公共层，地址用候选自己那条（bind 会自己归一化出缓存键）：
       别用 media.getAttribute('src') —— 占位 <video> 只有 data-src，取到的是 null。 */
    if (media) Wb.thumbs.bind(t, media, media.getAttribute('data-src') || media.getAttribute('src') || '');
  });
  /* 候选条绑定已在上方处理 */
  const exp = col.querySelector('#candExpand');
  if (exp) exp.onclick = () => {
    midCandExpand = !midCandExpand;
    window.LS.set('dir_cand_expand', midCandExpand ? '1' : '0');
    renderMid();
  };
}
/* 新增候选 = 建一个空的候选占位：给它写一条自己的描述，再点「生成这条」
   （占位字段归 mkDraftCandidate 那一份，这里只管「加进去并选中它」） */
function addCandidateDraft() {
  const sh = curShot();
  if (!sh) return;
  const ph = mkDraftCandidate(sh);
  sh.candidates.push(ph);
  proj.curCand = sh.candidates.length - 1;         // 新占位直接选中，马上就能写描述
  renderAll(); scheduleSave();
  setTimeout(() => { const ta = $('edPrompt'); if (ta) { ta.scrollIntoView({ block: 'nearest' }); window.focusQuiet(ta); ta.select(); } }, 80);   // 描述在右栏写
}
/* 生成某一条候选（按它自己那条描述；草稿会原地变成任务） */
async function generateCandidate(ph) {
  const sh = curShot();
  if (!sh || !ph) return;
  const txt = String(ph.prompt == null ? sh.prompt : ph.prompt).trim();
  if (!txt) {
    setStatus('<span class="err">' + NO_PROMPT_WHY + '（可以先复制当前镜头的描述再改）</span>');
    const ta = $('edPrompt');
    if (ta) { ta.scrollIntoView({ block: 'nearest' }); window.focusQuiet(ta); }
    return;
  }
  ph.prompt = txt;
  ph.status = 'creating';
  renderAll();
  try {
    await Gen.submitCandidate(sh, ph);
    setStatus('<span class="ok">✓ 已按这条候选的描述提交生成</span>');
  } catch (e) {
    setStatus('<span class="err">提交失败：' + e.message + '</span>');
  }
  renderAll(); scheduleSave();
}

/* 候选排序：已出片的在前，排队/生成中的在后，失败的最后；稳定排序，当前查看的那条跟着走 */
function candRank(c) {
  if (c.status === 'succeeded' && c.url) return 0;
  if (c.status === 'failed' || c.status === 'cancelled') return 2;
  return 1;                                     // draft / creating / queued / running（都还没有画面）
}
function sortCandidates(sh) {
  const arr = sh.candidates || [];
  const curCand = sh.candidates === (curShot() || {}).candidates ? proj.curCand : -1;
  const keep = (curCand >= 0 && arr[curCand]) ? arr[curCand] : null;
  const ranked = arr.map((c, i) => ({ c, i, r: candRank(c) }));
  ranked.sort((a, b) => (a.r - b.r) || (a.i - b.i));
  const changed = ranked.some((x, i) => x.i !== i);
  if (!changed) return false;
  sh.candidates = ranked.map(x => x.c);
  if (keep) { const at = sh.candidates.indexOf(keep); if (at >= 0) proj.curCand = at; }
  return true;
}

/* ---------- 生成轮询引擎 ---------- */
/* 平台对象一律来自注册表。**认不出就返回 null**，不兜底到别家 ——
   `Api.prov('video')` 那个兜底是同一个病的另一个实例：它会把「这一条候选属于 A 家」
   悄悄改成「按 B 家的接口去问」，于是轮询拿 B 的字段名读 A 的任务 —— 永远读不到状态。
   调用方本来都写了 `if (!prov) ...`（engine/gen.js 的 pollOne 那处会标 failed 并说清原因），
   去掉兜底反而让它们走到本来准备好的那条路上。 */
function provById(id) {
  if (window.Api && Api.prov) return Api.prov(id);
  const list = (REG?.providers || []);
  return list.find(p => p.id === id || (p.keyId || p.id) === id) || null;
}
let softTimer = null;
function saveScheduleSoft() { clearTimeout(softTimer); softTimer = setTimeout(scheduleSaveQuiet, 300); }

/* ---------- 渲染：左栏 ---------- */
/* 缩略图与首帧缓存：统一走 workbench.js 的 Wb.thumbs（全站一份实现）
   —— 以前这四个页面各写一份，连缓存用的 IndexedDB 库都不一样。
   页面这里不再自己攒「媒体元素复用表」：占位 <video> 从不加载（抽帧用的是公共层
   自己的离屏 video），重画时命中缓存就直接出 <img>，复用旧节点反而会把已经画好的
   那一帧换回空白节点。 */
function hydrateThumbFrames() {
  return Wb.thumbs.hydrate().then(n => { if (n) { try { renderScenes(); } catch { /* 缩略图补齐后的重画失败就留着旧画面 */ } } });
}
/* 工作区里存着的镜头地址是平台产物的**签名外链**（VGENV 的 OSS 地址只管一天）。
   放着不管，第二天这些镜头就是「缩略图永远加载不出来、点开只回一句 Format error」，
   而界面上完全看不出原因。开机照旧先画旧地址（不阻塞首屏），这一趟放后台按任务号换新：
   换到就写回工作区并重画那一块 —— 下次打开直接是新鲜的，不用再吃一轮 403。
   过期判定、按平台整批回源（声明了 pollVia:'list' 的平台一次列表请求解出一批）都在
   api.js 的 Api.healMedia 里，页面不重复实现。 */
function healStaleUrls() {
  if (!window.Api || !Api.healMedia) return Promise.resolve(0);
  const recs = [];
  for (const p of WS.projects || []) for (const s of p.scenes || []) for (const sh of s.shots || [])
    for (const c of sh.candidates || []) {
      if (c.url && Api.mediaExpired(c.url)) recs.push({ provider: c.provider, id: c.vid, url: c.url, _c: c });
    }
  if (!recs.length) return Promise.resolve(0);
  setStatus('有 ' + recs.length + ' 个镜头的外链签名过期，正在后台换新…');
  return Api.healMedia(recs, {
    limit: 60,
    onFresh(rec, next) {
      rec._c.url = next;
      renderMidSoon();
      scheduleSave();                       // 新地址落盘
    },
  }).then(n => {
    setStatus(n ? '<span class="ok">✓ 已换新 ' + n + ' 个镜头的外链地址</span>'
      : '这些镜头的外链换不到新地址——画面可能已被平台清理');
    return n;
  }).catch(() => 0);
}

/* 输入框逐字触发的重渲染走防抖：避免每敲一个字就整列重建（左栏/中栏互刷时更明显） */
function debounce(fn, ms) { let t = null; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const renderScenesSoon = debounce(() => renderScenes(), 350);
const renderMidSoon = debounce(() => renderMid(), 350);
/* 删场景 / 删掉最后一个镜头时兜底：项目至少保留一个场景，否则左栏会空、存档也会坏 */
function ensureSceneLeft() {
  if (!proj || proj.scenes.length) return;
  proj.scenes.push({ id: uid(), name: '场景 1', shots: [newShot()] });
  proj.curScene = 0; proj.curShot = 0;
}
/* 删掉一个镜头（连带空场景、光标修正、blob 回收）—— 左栏那颗「×」与 AI 分镜审查弹窗里的
   `delete` 条目走的是同一份，页面里不许再抄第二遍（「提交出去收不回来的动作，删之前要有硬拦」
   这一条纪律在两个入口上也得是同一个判据：调用方**自己**先问 `Wb.stLive`，这里不替它问，
   因为左栏删的是用户点名的一镜、弹窗删的是一批，报数的口径不一样）。
   返回 false = 这一镜（或它所属那一场）此刻已经不在账上了，调用方照实计 `skipped`。 */
function removeShot(sc, sh) {
  if (!proj || !sc) return false;
  const si = proj.scenes.indexOf(sc);
  if (si < 0) return false;
  const xi = (sc.shots || []).indexOf(sh);
  if (xi < 0) return false;
  const wasCurScene = si === proj.curScene;
  releaseShotUrls(sh);                                     // 回收本地视频的 blob 地址
  sc.shots.splice(xi, 1);
  if (!sc.shots.length) {
    proj.scenes.splice(si, 1);                             // 空场景一并清掉
    if (si < proj.curScene) proj.curScene--;               // 它后面的场景整体前移了一格，当前指针对着不动就选错场景
  }
  ensureSceneLeft();                                       // 但至少留一个场景，别把项目删空
  proj.curScene = Math.max(0, Math.min(proj.curScene, proj.scenes.length - 1));
  /* 只有删掉的正是「当前选中的那一镜」时才需要挪选中位（往前挪到它上面那条）。
     以前无条件写成 0：在别的场景里删一个镜头，会把用户正在敲的镜头跳到第一条。 */
  if (wasCurScene && xi <= proj.curShot) proj.curShot = Math.max(0, proj.curShot - 1);
  const curSc = proj.scenes[proj.curScene];
  proj.curShot = Math.max(0, Math.min(proj.curShot, (curSc && curSc.shots.length ? curSc.shots.length : 1) - 1));
  return true;
}
/* ============================================================================
   场景图 —— 左栏每个场景一张图，这个场景里新建的镜头自动把它带进参考图
   ----------------------------------------------------------------------------
   「这一镜能不能收参考图 / 收到第几张 / 这张是不是已经有了」不在这里重写一遍：
   全部走 `addLibPicToShot`（能力声明 + 素材互斥 + 上限 + 按图去重那份判据），
   这里只回答两件事：**图从哪来**、**这句要不要跟用户说**。
   ========================================================================== */
/* 场景名的归一化只有一份，在 `web/ui/ui.js` 的 `window.nameKey`（2026-10-17 从这一页收成公共层）：
   判「同一个场景」、判「素材库里同名那一条」、素材库判「同一个分组」用的是同一把尺子。
   它以前是本页私有函数，于是素材库那份组名判据各按字面 trim，两组各算各的。 */
/* 素材库里那一族「场景」条目，按名字认领一张图。**只兜底**：用户在左栏亲手挑的那张永远优先，
   库里换了图也不必把工作区里那份覆盖掉。 */
function libScenePic(scName) {
  const D = window.Chars;
  if (!D || !D.Lib || !D.libKindOf || !D.picOf) return '';
  const k = nameKey(scName);
  if (!k) return '';
  const hit = (D.Lib.list() || []).find(x => x && D.libKindOf(x) === 'scene' && nameKey(x.name) === k);
  return (hit && (D.refPicOf ? D.refPicOf(hit) : D.picOf(hit))) || '';
}
/* 按 id 认库里那条（14.2-4：拆分镜建档时把 sceneLibId 绑上，喂图按 id）。
   改名 / 同名两条都分得开 —— 名字那条只是老工程的兜底（只读不写）。 */
function libEntryById(id) {
  const D = window.Chars;
  if (!D || !D.Lib || !id) return null;
  return (D.Lib.list() || []).find(x => x && x.id === id) || null;
}
/* 这个场景**现在**对得上的那张图：左栏挑的 → 素材库按 id 绑的那条 → 同名兜底 → 没有。
   `sc.noPic` = 用户在左栏按过「这个场景不带图」，连素材库那张也不认领。
   这一项不是多余的状态：缩略图上显示的就是库里那张，只把 `sc.img` 清掉的话
   点完「×」画面一个字没变 —— 看着像按钮坏了，而用户确实想让它不带。 */
function scenePicOf(sc) {
  if (!sc || sc.noPic) return '';
  if (sc.img) return sc.img;
  const byId = sc.sceneLibId ? libEntryById(sc.sceneLibId) : null;
  if (byId) return (window.Chars && (Chars.refPicOf ? Chars.refPicOf(byId) : Chars.picOf(byId))) || '';
  return libScenePic(sc.name) || '';   // 老工程没绑 id 的兜底：按名字找一次，不写回
}
/* 一批新镜头落进某个场景之后统一认领它的场景图，结果收成 {added, why}。
   `skipped`（这个场景本来就没有图）不进统计、也不吭声 —— 界面上不该为「本来就没有的东西」报一句；
   但「型号不收参考图」「已经选了首尾帧」「超出上限」这些**带不上的**必须说，
   否则用户以为新镜头带着场景图，实际提交的是干净的提示词。 */
function feedScenePics(sc, shots) {
  let added = 0, why = '';
  (shots || []).forEach(sh => {
    const r = applyScenePic(sh, sc);
    if (r.skipped) return;
    if (r.ok) { if (!r.dup) added++; return; }
    if (!why) why = r.why || '';
  });
  return { added: added, why: why };
}
function applyScenePic(sh, sc) {
  const pic = scenePicOf(sc);
  if (!pic) return { ok: false, skipped: true };
  /* 优先递库里那条真实条目（带 id）——refMeta 记 id 后改名不断引用；
     老工程没绑 sceneLibId 时递名字对象，只按名字对（兜底只读不写）。 */
  const hit = sc && sc.sceneLibId ? libEntryById(sc.sceneLibId) : null;
  return addLibPicToShot(sh, hit || { id: sc && sc.sceneLibId, name: (sc && sc.name) || '场景' }, { src: pic });
}
/* 把 AI 拆出来的一批场景落进一个**已有项目**：同名（归一之后）的并进那一场，对不上号的才新建一场。
   单独成一个函数的两个理由：
   ① 这一条判据要能被探针问一遍 —— `aiStoryboard` 那一整段要等文字 AI 与两个确认弹窗，探针跑不动它；
   ② 「并进已有场景时场景图归谁」必须以**那一场**为准（它可能自己挑过一张、也可能按过 ×），
      把这段就地写在页面里最容易漏掉这一半。
   `at` = 最后落笔的那一场在哪，调用方据此放光标：全部并进球场时 `scenes.length-1` 指的是
   一个与本次毫无关系的老场景，光标跳过去会让人以为追加错了地方。 */
function placeScenesInto(scenes, newScenes) {
  const list = scenes || [];
  let merged = 0, created = 0, added = 0, why = '', at = Math.max(0, list.length - 1);
  (newScenes || []).forEach(sc => {
    const k = nameKey(sc.name);
    const dst = k ? list.find(x => nameKey(x.name) === k) : null;
    const host = dst || sc;
    if (dst) { dst.shots.push(...sc.shots); merged++; }
    else { list.push(sc); created++; }
    at = Math.max(0, list.indexOf(host));
    const r = feedScenePics(host, sc.shots);        // 只喂这一次新建的镜头，那一场里原有的不动
    added += r.added; if (r.why && !why) why = r.why;
  });
  return { merged: merged, created: created, at: at, pics: { added: added, why: why } };
}
/* 结果怎么说：成功走顶部那行小字（不弹浮层，不打扰正在打字的人），
   带不上走 Toast.warn —— 它是「用户该知道、但此刻不在他眼前」的那一半。
   `tail` 给调用方把自己那句结果（「已追加 N 个镜头」）拼进来：顶部那一行只有一个位置，
   分两次 setStatus 等于后一句把前一句顶掉，界面上就只剩一半。
   `assets` 是同一批镜头上的**素材图**账（`SplitAssets.bind` 那份）：它和场景图抢同一批参考图名额，
   所以两笔一起报才有意义 —— 只报场景图那一句，用户会以为新镜头都带上图了。
   两句的「为什么带不上」合成一条 Toast：两条浮层叠着弹，读的人只会当成同一件事。 */
function reportScenePics(res, tail, assets) {
  const bits = [];
  if (tail) bits.push(tail);
  if (res && res.added) bits.push('场景图已自动带进 ' + res.added + ' 个新镜头的参考图');
  if (assets && assets.n) bits.push('素材图带进 ' + assets.n + ' 张（' + assets.shots + ' 个镜头）');
  if (assets && assets.dup) bits.push(assets.dup + ' 张原本就在参考图里');
  if (bits.length) setStatus('<span class="ok">✓ ' + esc(bits.join(' · ')) + '</span>');
  const why = [];
  if (res && res.why) why.push('场景图：' + res.why);
  if (assets && assets.why) why.push('素材图：' + assets.why);
  if (why.length) Toast.warn('没能带进参考图 —— ' + why.join('；'));
}
/* 上一次这一格画的究竟是哪一份图。场景图存的是 dataURL（要长期挂在左栏、还要整份拷进新镜头的
   参考图），而 `Wb.thumbs._kattr` 嫌键太长不落 DOM 属性，所以「是不是同一张」只能问这份记录 ——
   库里同名那一条继承来的图是普通地址，重画一次就等于重新发一次请求，闪的正是它。 */
const scenePicStamp = new WeakMap();
/* 这一格长什么样只有一份画法：整片重画（renderScenes）与「改完名就地重画」走同一个函数 ——
   两处各拼一遍迟早变成「改了场景名，那一格还挂着按旧名字认领的图」。 */
function paintSceneThumb(btn, sc) {
  if (!btn) return;
  const pic = scenePicOf(sc);
  btn.classList.toggle('none', !pic);
  btn.title = sc.img ? '这个场景自己挑的场景图'
    : pic ? '场景图认的是素材库里同名那条（「' + (sc.name || '') + '」）'
      : '还没有场景图；挑一张后，新建的镜头会自动带它当参考图';
  /* 还是同一张图 → 节点一个都不动。class 与 title 上面已经就地改过（改名那句要说的是新名字），
     所以「图没换、说法变了」这一种也能当场跟上，不必为了它把图重新加载一遍。 */
  if (scenePicStamp.get(btn) === pic && btn.firstElementChild) return;
  scenePicStamp.set(btn, pic);
  btn.innerHTML = pic
    ? Wb.thumbs.mediaHTML(Api.mediaSrc(pic), { type: 'image', mediaAttrs: 'class="sp" loading="lazy"' })
    + '<span class="sp-x" data-act="scpicclear" title="这个场景不再自动带图">' + icon('close', 9) + '</span>'
    : icon('image', 13);
  if (pic) Wb.thumbs.bind(btn, btn.querySelector('img'), Api.mediaSrc(pic));
}
/* 挑一张场景图：右栏那几个槽位用的同一份选择器（资产库 / 收藏 / 本地上传 / AI 搜索都在里面）。 */
function pickScenePic(sc) {
  AssetPicker.open({
    types: ['图片'], multiple: false, limit: 1, aiSearch: true,
    title: '给场景「' + (sc.name || '未命名') + '」挑一张图',
    note: '只对之后新建的镜头生效，已建好的不动。',
    onPick: e => setScenePic(sc, e),
  });
}
async function setScenePic(sc, e) {
  try {
    /* 存成 dataURL，不存选择器递回来的那个地址：/getv 那条包的是平台签名外链，一天就过期，
       而这一张要长期挂在左栏，还要整份拷进每个新镜头的 refImages（那里面存的本来就是 dataURL）。 */
    sc.img = e.file ? await AssetTransfer.toDataURL(await compressImg(e.file)) : await toDataURL(e.src);
    sc.noPic = false;                         // 重新挑一张 = 「这一场要带图」，之前按过 × 那句话作废
    renderScenes(); scheduleSave();
    /* 这句要说清「生效范围是以后的新镜头」：已经建好的那些一张都没动，
       界面却在下一次新建镜头时才带上图 —— 不说清会让人以为整场都换好了。 */
    setStatus('<span class="ok">✓ 已给「' + esc(sc.name || '这个场景') + '」设好场景图：这个场景里新建的镜头会自动带上它，已有的镜头不动</span>');
  } catch (err) {
    setStatus('<span class="err">场景图取回来失败：' + esc(errText(err)) + '</span>');
  }
}
/* 清掉 = 「这个场景不自动带图」，不只是抹掉自己挑的那一张：
   素材库里恰好有同名那条时，只清 `sc.img` 的话这一格画出来还是原来那张，按下去就是「没反应」。 */
function clearScenePic(sc) {
  sc.img = ''; sc.noPic = true;
  renderScenes(); scheduleSave();
  setStatus('已让「' + esc(sc.name || '这个场景') + '」不再自动带场景图');
}
/* 图标：垃圾桶（内联 SVG，颜色跟着按钮走，深浅主题都干净） */
const TRASH_SVG = icon('trash', 14);
function renderScenes() {
  const box = $('scenesBox');
  /* 剪辑态左栏换面（轨道坞在页面底栏，左栏让给「历史编辑记录 + 素材」）：
     只翻类与 hidden，常驻结构不销毁 —— 退出剪辑左栏原样回来。 */
  const leftCol = document.querySelector('.col-left');
  if (leftCol) leftCol.classList.toggle('editing', !!midEditTrim);
  const elBox = document.getElementById('editLeft');
  if (elBox) {
    elBox.hidden = !midEditTrim;
    if (midEditTrim) renderEditLeft(elBox);
  }
  /* 重画之前先把「此刻已经有画面的那一枚」按镜头收起来，建完再收养（见下面那一段的条件）。
     以前这里 `box.innerHTML = ''` 把每一张卡片连着那个**正在抽帧**的 `<video>` 一起销毁：
     于是剪一刀、点一次轨道、切一次候选，左栏每一张还没进缓存的缩略图都退回「…」重来一遍 ——
     用户报的「各个地方的视频预览都在闪」，左栏这一份就是它（中间栏那一份在 renderMid）。 */
  const keepWrap = new Map();
  box.querySelectorAll('.shot-item').forEach(x => {
    const w = x.querySelector('.sthumb-wrap');
    const m = w && w.querySelector('.sthumb');
    if (x.dataset.sid && w && m && m.getAttribute('data-thumb-key')) keepWrap.set(x.dataset.sid, w);
  });
  /* 场景图那一格同理：它挂在 `.scene-head` 上、不参与 `.shot-item`，所以单独收一份。
     这里只按场景收「候选」，「到底是不是同一张图」由下面拿 scenePicStamp 现比 ——
     按名字认领的那一张会随改名换掉，收养错了就等于让界面停在上一张图上。 */
  const keepPic = new Map();
  box.querySelectorAll('.scene-head').forEach(h => {
    const b = h.querySelector('[data-act=scpic]');
    if (h.dataset.scid && b) keepPic.set(h.dataset.scid, b);
  });
  /* 建列那一整段罩在公共件里（`Wb.viewport.keep`）：`box.innerHTML = ''` 之后从零重建，左栏那一列的滚动位
     在清空那一刻被夹回 0 —— 而这一列每轮任务轮询都要重画一次，表现是「正看着第 20 镜，一次刷新弹回栏顶」。
     锚点认镜头行与场景头那两枚身份（`data-sid` / `data-scid`）：删一镜、增一场之后还的是「同一行还在原来
     那个位置」，不是「同一堆像素」。缩略图与场景图的收养（keepWrap / keepPic）管的是「不重新抽帧」，
     与滚动位是两件事，照旧留在这里。 */
  let n = 0;                       // 列出的镜头数（重建那一趟只往上加，画完写给表头）
  Wb.viewport.keep(box, () => {
    box.innerHTML = '';
    proj.scenes.forEach((sc, si) => {
      /* 剪辑态左栏这一列只列**已选用的候选**镜头（`shotReady` = 这一镜选的那条已经出画面，
         也就是它进了成片的那一份账）；生成态那一列照旧列全部镜头，一个都不少。
         「列出哪几镜」与「点它会去哪」是一件事：剪辑态点一行 = 剪辑针跳到那一镜在成片里的位置
         （见 `leftShotPick`）。
         场景分组留着，一个可用的都没有的空场景在剪辑态整个不画（别占一行空壳）。 */
      const listed = [];
      sc.shots.forEach((sh, xi) => { if (!midEditTrim || shotReady(sh)) listed.push([sh, xi]); });
      if (midEditTrim && !listed.length) return;
      const blk = document.createElement('div');
      blk.className = 'scene-block';
      const head = document.createElement('div');
      head.className = 'scene-head';
      /* 收养要有身份可认：按场景号收（不是按第几场 —— 删一场之后下面的场全体上移一格）。
         老项目里可能没有 id，退到序号，两侧用同一个表达式就仍然对得上。 */
      head.dataset.scid = sc.id == null ? 'i' + si : String(sc.id);
      /* 场景图那一格：有图就显示图，没图显示一个虚线空位。
         右上角那颗 ×「这个场景不再自动带图」，与「换一张」放在同一个格子里 ——
         分开放要多占一个 flex 子项，而左栏最窄只有 198px，四个按钮加改名框就顶不下了。
         剪辑态整块不画：场景图管的是「以后新建的镜头带哪张参考图」，
         属于生成态那一族（用户点名：剪辑态左栏不该带新建删除那些生成态的东西）。
         留着的是场景名与镜头数 —— 那是这一组的标签，剪的时候还要靠它认场景。 */
      head.innerHTML = (midEditTrim ? '' : `<button class="sc-thumb" data-act="scpic"></button>`)
        + `<input value="${esc(sc.name)}" title="点一下可以改场景名">
        <span class="sc-cnt">${listed.length} 镜</span>`
        + (midEditTrim ? '' : `<button class="icon-btn add" data-act="addshot" title="在这个场景末尾新建一个镜头">${icon('plus', 14)}</button>
        <button class="icon-btn del" data-act="delscene" title="删除整个场景（连带里面的镜头）">${TRASH_SVG}</button>`);
      /* 收养只认「画的是同一张图」这一件事：这一格的媒体可能是从素材库现取的外链，
         整颗按钮推倒重来就是让它重新走一遍加载（任务轮询每一轮都走 renderSoft 重画左栏，
         闪的正是这一下）。收养的是整颗按钮 —— 绑定的键是它，不是里面的 <img>。 */
      const picBtn = head.querySelector('[data-act=scpic]');
      if (picBtn) {
        const keptPic = keepPic.get(head.dataset.scid);
        if (keptPic && scenePicStamp.get(keptPic) === scenePicOf(sc)) picBtn.replaceWith(keptPic);
        paintSceneThumb(head.querySelector('[data-act=scpic]'), sc);
      }
      /* 改名要当场重画这一格（素材库里同名那条的图是**按名字**认领的），但不能整片 renderScenes：
         那会把这个正在打字 input 一起换掉、光标跳走。只换那一颗按钮的内容。 */
      head.querySelector('input').oninput = e => {
        sc.name = e.target.value; scheduleSave(); renderMidSoon();
        if (picBtn) paintSceneThumb(head.querySelector('[data-act=scpic]'), sc);
      };
      /* 一格两个动作：点图本身 = 换一张，点右上角 × = 这一场不带图。
         × 不做二次确认 —— 它随时可以反悔（再点一次图挑回来就是原样），
         而 Confirm.arm 会把按钮文字换成「确认…」，连带抹掉里面那张缩略图。 */
      if (picBtn) picBtn.onclick = e => {
        e.stopPropagation();
        if (e.target.closest('[data-act=scpicclear]')) { clearScenePic(sc); return; }
        pickScenePic(sc);
      };
      if (!midEditTrim) {
        head.querySelector('[data-act=addshot]').onclick = e => { e.stopPropagation(); addShotToScene(sc); };
        head.querySelector('[data-act=delscene]').onclick = e => {
          const b = e.currentTarget;
          const n = (sc.shots || []).length;
          Confirm.arm(b, '确认删除？', { note: n ? '这个场景里还有 ' + n + ' 个镜头，会一起删掉' : null })
            || (releaseSceneUrls(sc),                          // 回收本地视频的 blob 地址，否则一直占内存
                proj.scenes.splice(si, 1),
                ensureSceneLeft(),                            // 删到最后一个场景时自动补一个空的，避免项目变成 0 场景
                proj.curScene = Math.min(proj.curScene, proj.scenes.length - 1),
                renderAll(), scheduleSave());
        };
      }
      blk.appendChild(head);
      listed.forEach(([sh, xi]) => {
        n++;
        const it = document.createElement('div');
        it.className = 'shot-item' + (si === proj.curScene && xi === proj.curShot ? ' sel' : '');
        it.dataset.sid = sh.id;
        it.draggable = false;   // 默认不可拖，按住 ⠿ 抓手才开启拖动
        const cur = sh.candidates.find(c => c.vid === sh.selId);
        const rawSrc = cur?.url || sh.firstFrame || '';
        const sKey = cur?.url ? thumbKey(cur) : Wb.thumbs.keyOf(rawSrc);
        const thumb = cur?.url ? Wb.thumbs.mediaHTML(cur.url, { key: sKey, mediaAttrs: 'class="sthumb"' })
          : sh.firstFrame ? Wb.thumbs.mediaHTML(sh.firstFrame, { type: 'image', key: sKey, mediaAttrs: 'class="sthumb" loading="lazy"' })
          : `<div class="sthumb empty"></div>`;
        // 状态：已选用 / 生成中（带进度）/ 排队中 / 创建中 / 待选用 / 生成失败 / 未生成 / 待写描述
        const st = shotStatusOf(sh);
        const runC = st.runC;
        const statusTxt = st.html;
        const prog = runC ? Math.max(0, Math.min(100, Number(runC.progress) || 0)) : 0;
        const pbarHTML = runC ? `<span class="pbar"><i style="width:${prog}%"></i></span>` : '';
        const durTxt = shotDur(sh) ? ' · ' + fmtDur(shotDur(sh)) : '';   // 还没出片就不写「未生成」，避免「生成中 · 未生成」
        it.innerHTML = `<span class="num">${String(n).padStart(2, '0')}</span>
          <div class="sthumb-wrap">${thumb}${pbarHTML}</div>
          <div class="sinfo"><div class="sname">${esc(sh.name)}</div>
          <div class="smeta">${statusTxt}${durTxt}</div></div>`
          /* 抓手 / 复制 / 删除是生成态那三件（改的是分镜表，不是成片）。剪辑态这一列是**看**成片
             的镜头清单，点一行只做「切镜 / 跳针」，这三颗整个不画 ——
             以前它们悬停才浮出来，剪的时候一不留神就复制了一镜或删掉了一段。 */
          + (midEditTrim ? '' : `<div class="ops">
            <button class="op-btn grip" title="按住拖动排序">${icon('grip', 12)}</button>
            <button class="op-btn dup" title="复制镜头">${icon('copy', 12)}</button>
            <button class="op-btn del danger" title="删除镜头">${TRASH_SVG}</button>
          </div>`);
        /* 收养旧的那一格缩略图，条件只有「它显示的就是这一镜此刻选用的那一份素材」——
           按**缩略图身份**认，不按镜头认：换了选用的候选，旧格子里是另一条视频的首帧，
           留着它界面就在替用户说一件假话（卡片上播着的画面 ≠ 这一镜现在选的那一条）。
           整块 `.sthumb-wrap` 一起换（不能只换里面的媒体）：`Wb.thumbs._bindings` 是以 wrap 为键的，
           只换媒体节点会让绑定指向一个已经不在文档里的旧节点。
           进度条挂在 wrap 里面，所以收养之后要按这一轮的账重贴一次。 */
        const kept = keepWrap.get(String(sh.id));
        const keptMedia = kept && kept.querySelector('.sthumb');
        if (kept && keptMedia && keptMedia.getAttribute('data-thumb-key') === sKey) {
          it.querySelector('.sthumb-wrap').replaceWith(kept);
          const oldBar = kept.querySelector('.pbar');
          if (oldBar) oldBar.remove();
          if (pbarHTML) kept.insertAdjacentHTML('beforeend', pbarHTML);
          Wb.thumbs.bind(kept, keptMedia, rawSrc);
        } else Wb.thumbs.bind(it.querySelector('.sthumb-wrap'), it.querySelector('.sthumb'), rawSrc);
        /* 点一行：生成态 = 换看哪一镜（老样子，一字不改）；
           剪辑态 = 剪辑针跳到那一镜在成片里的位置（`leftShotPick`）。 */
        it.onclick = () => {
          if (!midEditTrim) { proj.curScene = si; proj.curShot = xi; renderAll(); return; }
          leftShotPick(sc, sh, xi);
        };
        /* 抓手 / 复制 / 删除这一族只挂在生成态上：剪辑态那一列是看成片的清单，
           改的是分镜表（排序 / 复制 / 删除），与「剪」不是一件事 —— 上一段已经把这三颗
           整个不画了，这里的处理器也跟着不绑（画出来但点不动是最坏的一种）。 */
        if (!midEditTrim) {
          const grip = it.querySelector('.grip');
          grip.addEventListener('mousedown', () => { it.draggable = true; });
          it.addEventListener('dragend', () => {
            it.draggable = false;
            it.classList.remove('dragging');
            document.querySelectorAll('.shot-item.drag-over').forEach(x => x.classList.remove('drag-over'));
          });
          it.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', `shot:${si}:${xi}`);
            e.dataTransfer.effectAllowed = 'move';
            document.querySelectorAll('.shot-item.dragging').forEach(x => x.classList.remove('dragging'));
            it.classList.add('dragging');
          });
          it.addEventListener('dragover', e => {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            if (!it.classList.contains('dragging')) it.classList.add('drag-over');
          });
          it.addEventListener('dragleave', () => it.classList.remove('drag-over'));
          it.addEventListener('drop', e => {
            e.preventDefault(); e.stopPropagation();
            const d2 = e.dataTransfer.getData('text/plain');
            if (!d2.startsWith('shot:')) return;
            const [ , fsi, fxi ] = d2.split(':').map(Number);
            if (fsi === si && fxi === xi) return;
            const moved = proj.scenes[fsi].shots.splice(fxi, 1)[0];
            /* 目标下标要按「源已被移走之后的数组」来算：同一个场景里往后拖时，splice(fxi,1) 已经把
               后面那些整体前移了一格，再拿原来的下标插入，落点就比用户放的位置多走一格
               （表现为「拖到第 3 个位置却落到第 4 个」）。 */
            const at = (fsi === si && fxi < xi) ? xi - 1 : xi;
            sc.shots.splice(at, 0, moved);
            proj.curScene = si; proj.curShot = at;
            renderAll(); scheduleSave();
          });
          it.querySelector('.dup').onclick = e => {
            e.stopPropagation();
            const copy = JSON.parse(JSON.stringify(sh));
            copy.id = uid(); copy.name = sh.name + ' 副本'; copy.candidates = []; copy.selId = null;
            copy.candidates.push(mkDraftCandidate(copy));
            sc.shots.splice(xi + 1, 0, copy);
            renderAll(); scheduleSave();
          };
          it.querySelector('.del').onclick = e => {
            e.stopPropagation();
            /* 后果只说与这一次删除直接相关的三条：这一镜已被选用 → 成片会少一段；
               这一镜里还有别的生成结果 → 那些会一起没；删的是最后一个镜头 → 场景也没了。 */
            const notes = [];
            if (sh.selId) notes.push('这一镜已经被选用：删掉之后成片会少这一段');
            const nc = (sh.candidates || []).filter(c => c.status !== 'draft').length;
            if (nc > 1) notes.push('这一镜里还有 ' + (nc - 1) + ' 条生成结果，会一起删掉');
            if (sc.shots.length === 1) notes.push('这是最后一个镜头：删掉之后这个场景也会一起没');
            Confirm.arm(e.currentTarget, '确认删除？', notes.length ? { note: notes.join(' · ') } : null)
              || (() => {
            removeShot(sc, sh);
            renderAll(); scheduleSave();
            })();
          };
        }
        blk.appendChild(it);
      });
      box.appendChild(blk);
    });
  });
  $('scCount').textContent = n;
  updateProjUI();
}

/* 剪辑态左栏点一镜：**播放头跳到那一镜在成片里的对应位置**（用户点名）。
   成片秒是派生几何（`deriveTimeline` 一处），这里只问它，不自己折算 ——
   折算是第二本账，播放头与格子迟早对不上。
   剪辑态只有成片那一排：点一行 = 把播放头放到那一镜在成片里的起点，没有第二种落点。 */
function leftShotPick(sc, sh, xi) {
  proj.curScene = proj.scenes.indexOf(sc);
  proj.curShot = xi;
  /* 切过去之后右栏与候选条指着的是这一镜**选用**的那一条（不是上一镜的那条）。 */
  const c = chosenCandOf(sh);
  if (c) {
    const ci = (sh.candidates || []).findIndex(x => x.vid === c.vid);
    if (ci >= 0) proj.curCand = ci;
  }
  if (inCutMode()) {
    const row = deriveTimeline(ensureFilm().clips || []).rows.find(r => (r.clip || {}).shotId === sh.id);
    if (!row) { setStatus('这一镜还没进成片：先在生成态给它点「选用」'); renderAll(); return; }
    Timeline.seekTo(num(row.start), { follow: true });
    return;
  }
  /* 不在剪辑态（顺序 / 生成）：点左栏就是**换看哪一镜**，没有轨道也就没有针要放 ——
     进剪辑态时那一排的针由几何现算（`filmPinInfo`），落在当前那一镜上。 */
  renderAll();
}

/* 剪辑态左栏底部那一块：**历史编辑记录**。
   历史是一条**只追加的操作日志**：最新的一条在最上，**一条都不删**（回退也留痕）。
   「当前生效」的那一条用一枚标记点亮（指针）；点任意一行 = 回退到那一行那一版的状态，
   回退会在末尾追一条「回退到「xxx」」—— 于是所有记录始终可见、干过什么全查得到。
   被上限挤掉的最老那几条照实不显示（空态那句话把两档上限说清）。
   这一块做成**折叠区**（原生 details，默认收起）：它平时只是「有没有可退的步骤」这一句，
   展开才是一列记录 —— 以前它占掉左栏整列，剪的时候连分镜列表都看不见了。
   「导入视频 / 素材」已经挪到左栏表头（项目级动作），这里不再重复一个入口。 */
/* 折叠区的开合存在模块里：这一栏每轮轮询整片重画，`<details>` 是每次新造的节点 ——
   不留这一份账，用户正展开看历史时一次刷新就把它弹回收起。 */
let elHistOpen = false;
function renderEditLeft(box) {
  const rows = [];
  /* 倒序画（最新在最上）：日志本身是正的、只追加。 */
  for (let i = historyLog.length - 1; i >= 0; i--) {
    const e = historyLog[i];
    const isNow = i === historyCursor;
    const kindTxt = e.kind === 'rollback' ? '回退' : e.kind === 'redo' ? '重做' : '编辑';
    rows.push('<button type="button" class="hist-row' + (isNow ? ' now' : '') + (e.kind !== 'edit' ? ' mark' : '') + '"'
      + ' data-hist-i="' + i + '"'
      + ' title="' + esc(kindTxt + ' · ' + window.fmtHM(e.at) + '：' + e.label)
      + (isNow ? '（现在生效的就是这一版）' : '（点一下回退到这一版）') + '">'
      + '<span class="hk">' + esc(kindTxt) + '</span>'
      + '<span class="hn">' + esc(e.label) + '</span>'
      + '<span class="ht">' + window.fmtHM(e.at) + '</span></button>');
  }
  /* 重画罩在公共件里：这一栏自己滚（`#editLeft{overflow-y:auto}`），`innerHTML =` 把里面整片换掉
     就把滚动位清零 —— 而每一轮任务轮询都会重画它。折叠区的开合 `keep` 不管（那是节点上的属性，
     不是滚动位），所以它自己收进模块状态：`elHistOpen`。 */
  Wb.viewport.keep(box, () => {
    box.innerHTML = `
      <details class="el-hist"${elHistOpen ? ' open' : ''}>
        <summary><span class="hn">历史编辑记录</span><span class="n">${historyLog.length ? historyLog.length + ' 条 · ' + Math.max(0, historyCursor + 1) + ' 步可退' : '还没有记录'}</span></summary>
        <div class="el-body">
          ${rows.length ? '<div class="hist-list">' + rows.join('') + '</div>'
            : '<div class="hist-empty">还没有记录</div>'}
        </div>
      </details>`;
    const det = box.querySelector('.el-hist');
    if (det) det.ontoggle = () => { elHistOpen = det.open; };
    box.querySelectorAll('[data-hist-i]').forEach(b => {
      b.onclick = () => {
        const i = Number(b.dataset.histI);
        if (!Number.isFinite(i) || i === historyCursor) return;
        if (!historyGoTo(i, 'rollback', '回退到')) {
          setStatus('<span class="err">退不回去：这份快照没能恢复，工作区保持原样</span>');
          return;
        }
        setStatus('<span class="ok">✓ 已回退到「' + esc((historyLog[i] || {}).label || '那一步')
          + '」那一版</span>');
      };
    });
  });
}

/* ---------- 渲染：中栏 ---------- */
let midEditTrim = false;   // 剪辑模式（只有一条轨：成片那一排）
/* 剪辑态**只有一条轨**（用户点名：不再有「本镜 / 全片」两个页签），所以「是不是按成片那一套逻辑走」
   = 「剪辑模式开着没有」。这一枚判据只分**剪辑态 / 生成态**两档：生成态的播放器、左栏点一行、
   字幕叠层各有一套秒尺子，切了剪辑模式它们才换那一套。 */
const inCutMode = () => midEditTrim;
/* 打开 / 关掉剪辑模式只有一个出口：旗标 + 收甲板 + 中栏 + 右栏四件事必须一起做，漏一件就是
   「中栏已经换成轨道、右栏还停在镜头编辑器」或「甲板收掉了但后台还在解码发声」。
   页面里裸写 `midEditTrim = …` 的地方从此只有这一处。 */
function setTrimMode(on) {
  midEditTrim = !!on;
  /* 退出剪辑就收掉播放核：留着会在后台接着解码（声音也跟着响），
     而界面上已经没有它们的位置了。 */
  if (!midEditTrim) Play.dispose();
  /* 进剪辑态：播放头落到当前那一镜在成片里的起点（成片秒是派生几何，只问一处）。 */
  if (midEditTrim) {
    const sh0 = curShot();
    if (sh0) {
      const row = deriveTimeline(ensureFilm().clips || []).rows.find(r => (r.clip || {}).shotId === sh0.id);
      if (row) Timeline.seekTo(num(row.start), { follow: true });
    }
  }
  renderMid();
  /* 右栏同一次点完就要跟着换（用户点名的形状）：只调 renderMid 只换中栏，
     右栏还停在镜头编辑器上，看起来像「剪辑模式没打开」。
     左栏也要跟着换面（剪辑态 = 历史编辑记录 + 素材，renderScenes 里那一档）。 */
  renderEditor();
  renderScenes();
}
/* 连接点那一颗 ◇ 的唯一写口：转场挂在**左段**身上（进入下一段）。
   `live` 是拖动时长滑块那一刻（只刷新、不压撤销快照），松手那一下才定稿。 */
function transitionSet(index, patch, opts) {
  const film = ensureFilm();
  const left = film.clips[index], right = film.clips[index + 1];
  if (!left || !right) return false;
  const live = !!(opts && opts.live);
  const cur = left.transition || { id: 'none' };
  const next = normalizeTransition(Object.assign({}, cur, patch || {}), left, right);
  /* 历史里只说「第 N 段 → 第 M 段」读不出是谁：段序一变，那两个数就指向别的镜头了。
     同一句话既是留痕也是回执 —— 浮层里点一颗预设，页面上要说「改了哪两段之间」。 */
  const label = '把「' + filmClipName(left) + '」→「' + filmClipName(right) + '」之间的转场'
    + (next ? '设为 ' + transitionNameOf(next.id) + ' ' + next.duration + ' 秒' : '去掉');
  if (!live) beginEdit(label);
  if (next) left.transition = next; else delete left.transition;
  /* 拖动时长滑块时不重建那块板：浮层就在板里面，重建会把手指底下的 range 换掉。
     松手那一下走 filmEdited()，整块跟着重画。 */
  if (live) scheduleSaveQuiet();
  else { filmEdited(); setStatus(label); }
  return true;
}
/* 工具条上除缩放 / 吸附 / 波纹 / 标记条 / 选择工具之外那几颗的出口（Timeline 只报动作名）：
   撤销与重做动的是工程快照，播放动的是播放层，所以留在这边；
   删 / 复制 / 切开 / 合并 / 增删段 / 长短微调 / 关联族 / 标记面板全部交 Edit 域（它改 `proj.film`）。 */
function toolAction(act) {
  if (act === 'undo') return undo();
  if (act === 'redo') return redo();
  if (act === 'play') return Play.toggle();
  /* 回到播放头 = 把视口滚到播放头那一秒（播放头本身不动）。 */
  if (act === 'to-playhead') return Timeline.scrollToTime(Timeline.playhead(), 0.3);
  return Edit.toolAction(act);
}
/* 在某一秒加一枚标记（工具条那颗 flag 与快捷键 M 同一个出口）。 */
function addMarkerAt(time, type) {
  const film = ensureFilm();
  const t = Math.max(0, Number(time) || 0);
  const m = createMarker({ type: type || 'marker', time: t });
  beginEdit('在 ' + Wb.fmtClock(t) + ' 加了一枚标记');
  film.markers.push(m);
  film.markers.sort((a, b) => a.time - b.time);
  filmEdited();
  setStatus('<span class="ok">✓ 已在 ' + Wb.fmtClock(m.time) + ' 加一枚标记</span>');
  return m;
}
/* ---------------- 「这一镜的台词配过音没有」 ---------------- */
const lineTrim = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
/* 「同一句话」按去空白后比：台词末尾多一个空格不该让这一句重新变成未配音。 */
const lineSame = (a, b) => String(a == null ? '' : a).replace(/\s+/g, '').trim().toLowerCase()
  === String(b == null ? '' : b).replace(/\s+/g, '').trim().toLowerCase();
function lineVoicesOf(sh) {
  const text = lineTrim(sh && sh.line);
  if (!text) return [];
  return (ensureFilm().voices || []).filter(v => v && v.shotId === sh.id && lineSame(v.text, text));
}
const lineVoicedOf = sh => lineVoicesOf(sh).length > 0;
/* 把焦点切到那一镜、播放头落到这一句自己的块上、台词填进合成框、翻到「生成配音」。
   先画一版（字已经在了），素材库那边取字节回来再补画一次那两格 —— 一条人声可能几 MB，
   为了等它把整个点击拖住不动，用户会以为没点中。 */
function openLineVoice(sh) {
  if (!sh) return;
  const sc = proj.scenes.find(s2 => s2.shots.includes(sh));
  if (sc) { proj.curScene = proj.scenes.indexOf(sc); proj.curShot = sc.shots.indexOf(sh); }
  /* 落到这一镜的画面段起点：合成出来的那一句也该落在这儿。这一镜还没进成片时不动针。 */
  const row = deriveTimeline(ensureFilm().clips || []).rows.find(r => r && r.clip && r.clip.shotId === sh.id);
  if (row) Timeline.seekTo(Math.max(0, Number(row.start) || 0), { follow: true });
  const p = { text: lineTrim(sh.line), who: lineTrim(sh.lineWho) };
  /* 草稿先认主（shotId），再填内容 —— 右栏配音那一栏只清「别人的」草稿。 */
  voiceDraft.shotId = sh.id;
  /* 换了一句台词就把上一句的音色草稿清掉（同一句重复点则留着用户手改过的那一份）：
     上一句的参考音频要是留在这一格里，合成出来会是另一个人的声音，而且真扣费。 */
  const sameText = voiceDraft.text === p.text;
  if (!sameText) { voiceDraft.design = ''; voiceDraft.ref = null; }
  voiceDraft.text = p.text;
  voiceDraft.who = p.who;
  vcTab = 'voice';
  renderAll();
  /* 焦点 / 播放头 / 草稿都是视图状态（不进工程快照）：静默落盘即可，
     别在历史里压一步「点了一下台词行」。 */
  scheduleSaveQuiet();
  prefillVoiceWho(p.who, { keep: sameText, shot: sh }).then(note => {
    if (curShot() !== sh) return;
    renderEditor();
    if (note) setStatus('<span class="meta">' + esc(note) + '</span>');
  }).catch(() => {});
}
/* 按说话人去素材库找料：音色设计取那位的 `voiceNote`，音色复刻取那段参考音频的字节。
   找不到人 / 那一位没写描述 / 没挂音频时**一个字都不写**（仍可手挑），但要把原因说出来 ——
   「点了占位符，参考那一格却还空着」必须有一句话解释，否则看着像页面没接上。
   返回的是给人看的那句话（调用方决定往哪儿放），不在这里弹提示。 */
async function prefillVoiceWho(who, opt) {
  const way = voiceWayOf(voiceReg(), proj.voiceModel || '');
  /* 同一句台词重复点占位符：那一格已经有用户手挑的音色（描述 / 参考音频）就不再用素材库那份盖掉。
     只有「换了一句」才重新按说话人预填。 */
  if (opt && opt.keep) {
    if (way.mode === 'design' && String(voiceDraft.design || '').trim()) return '';
    if (way.mode === 'clone' && voiceDraft.ref) return '';
  }
  /* 找谁、读音色描述还是取参考音频字节，全在 `Chars.Pipe.voicePrefillOf` 那一份里：
     库里那一列叫什么不出 web/domain/chars.js，这里只认它交回来的 note / blob / why。 */
  const pick = await Chars.Pipe.voicePrefillOf(who, way.mode);
  /* await 回来时用户可能已经切到另一镜：草稿只属于当前那一镜（shotId），
     慢回来的音色料写进别人的草稿 = B 镜合成出来是 A 镜说话人的声音，而且真扣费。 */
  if (opt && opt.shot && voiceDraft.shotId !== opt.shot.id) return '';
  if (!pick.found) return pick.why;
  if (pick.why) return pick.why;
  if (way.mode === 'design') {
    voiceDraft.design = pick.note;
    return '已按素材库「' + pick.name + '」的音色描述填进「声音描述」';
  }
  if (way.mode === 'clone') {
    voiceDraft.ref = { assetId: '', src: '', name: pick.refName || pick.name, file: pick.blob };
    return '已把素材库「' + pick.name + '」的参考音频填进「音色素材」';
  }
  return '这一档是预设音色：台词里的说话人「' + pick.name + '」不参与选音色，音色请在下拉里手挑';
}
/* 中栏空态：按这一镜的实际情况给出文案（不再写死「点右侧生成这一镜」） */
/* 当前查看的是不是「空占位」候选（已新增、还没生成） */
function curDraftCand() {
  const sh = curShot();
  const c = sh && (sh.candidates || [])[proj.curCand];
  return (c && c.status === 'draft') ? c : null;
}
/* 「这一条候选是用哪句话生成的」—— 当前查看的那条候选自己的描述优先，没有才回落到这一镜的描述。
   为什么必须按**候选**取：每条候选都记着生成它时用的那句（`c.prompt`，submitCandidate 里写的），
   而提示词框原来写死读 `sh.prompt`，于是：
     · 用 A 生成第一条、改成 B 生成第二条，回头点第一条 —— 框里还是 B（那一条的描述再也看不见）；
     · 换一条候选看，框里的字**一个字都不动**（selectCandidate 只换播放器与操作行）。
   用户的说法是「应该保留生成候选镜头时的提示词在输入框」，就是这么一件事。 */
/* Mid域（engine/mid.js）：这一段（2779-3412）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Mid = createMid({
  $: (...a) => $(...a),
  playSafe: (...a) => playSafe(...a),
  Play: Play,
  projOf: () => proj,
  allShots: (...a) => allShots(...a),
  curScene: (...a) => curScene(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  shotDurText: (...a) => shotDurText(...a),
  shotReady: (...a) => shotReady(...a),
  undoStack: undoStack,
  redoStack: redoStack,
  UNDO_MAX_BYTES: UNDO_MAX_BYTES,
  UNDO_MAX_COUNT: UNDO_MAX_COUNT,
  undo: (...a) => undo(...a),  redo: (...a) => redo(...a),
  dragBusy: (...a) => dragBusy(...a),
  filmEdited: (...a) => filmEdited(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  scheduleSaveQuiet: (...a) => scheduleSaveQuiet(...a),
  thumbKey: (...a) => thumbKey(...a),
  shotStatusOf: (...a) => shotStatusOf(...a),
  candThumbInner: (...a) => candThumbInner(...a),
  candPlaceholder: (...a) => candPlaceholder(...a),
  candAddTile: (...a) => candAddTile(...a),
  midCandExpandOf: () => midCandExpand,
  bindPbFull: (...a) => bindPbFull(...a),
  fullscreenHold: (...a) => fullscreenHold(...a),
  playerMediaOf: (...a) => playerMediaOf(...a),
  playerAreaHTML: (...a) => playerAreaHTML(...a),
  candActsHTML: (...a) => candActsHTML(...a),
  bindCandActs: (...a) => bindCandActs(...a),
  selectCandidate: (...a) => selectCandidate(...a),
  scrollCurThumbIntoView: (...a) => scrollCurThumbIntoView(...a),
  bindCandidateStrip: (...a) => bindCandidateStrip(...a),
  sortCandidates: (...a) => sortCandidates(...a),
  renderScenesSoon: renderScenesSoon,
  midEditTrimOf: () => midEditTrim,
  setTrimMode: (...a) => setTrimMode(...a),
  importMedia: () => openLibDlg(curShot()),
  curDraftCand: (...a) => curDraftCand(...a),
  Timeline: Timeline,
  Edit: Edit,
  syncGenGate: (...a) => syncGenGate(...a),
  syncAtBack: (...a) => syncAtBack(...a),
  renderEditor: (...a) => renderEditor(...a),
  renderAll: (...a) => renderAll(...a),
  setStatus: (...a) => setStatus(...a),
}, document, window);
const {
  promptTextOf,
  paintPromptBox,
  playerEmptyText,
  updateArBadge,
  renderMid,
} = Mid;
/* Caption域（engine/caption.js）：全片字幕的数据动作（补字幕 / 重切 / SRT 出 / 入 / 语音识别 /
   单条编辑）与右栏「字幕」那一格。字幕只有一份 —— `proj.film.captions`，时间就是成片秒，
   所以这一域没有秒制折算；写入走 Edit.patch、点名走 Edit.describeItem，都不留第二出口。
   E 里每一位都包成箭头：建包时 `renderEditor` 那一类还没初始化，直接引用会撞 TDZ。 */
const Caption = createCaptionDomain({
  filmOf: () => ensureFilm(),
  projOf: () => proj,
  Edit,
  Timeline,
  Play,
  setStatus: (...a) => setStatus(...a),
  esc: s => window.esc(s),
  icon: (n, s) => window.icon(n, s),
  mediaSrc: (...a) => Api.mediaSrc(...a),
  saveBlob: (...a) => saveBlob(...a),
  renderEditor: (...a) => renderEditor(...a),
}, document, window);

/* 这几枚是 engine 的状态，只是声明恰好落在被搬走的那一段里：
   整条提到接线之前（模块只读访问器），engine.js 继续持有它们 —— 状态不外迁。 */
let voiceDraft = { shotId: '', text: '', voice: '', format: '', design: '', ref: null, bools: {}, tb: {}, who: '' };
let vcTab = 'voice';
/* Voice域（engine/voice.js）：这一段（5297-6269）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Voice = createVoice({
  projOf: () => proj,
  REGOf: () => REG,
  /* 成片那一本账与「改一步」的唯一出口：配音的增删改读写 `proj.film.voices`，
     提交走 Edit 的 commit（beginEdit + 规整 + 清选择 + 标脏），针的位置读 Timeline。 */
  filmOf: () => ensureFilm(),
  Edit: Edit,
  Timeline: Timeline,
  allShots: (...a) => allShots(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  candDur: (...a) => candDur(...a),
  capPanelHTML: (...a) => Caption.capPanelHTML(...a),
  bindCapPanel: (...a) => Caption.bindCapPanel(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  filmEdited: (...a) => filmEdited(...a),
  lineVoicesOf: (...a) => lineVoicesOf(...a),
  midEditTrimOf: () => midEditTrim,
  voiceDraftOf: () => voiceDraft,
  vcTabOf: () => vcTab,
  polishVoiceText: (...a) => polishVoiceText(...a),
  linePanelRows: (...a) => linePanelRows(...a),
  lineWhoDatalistHTML: (...a) => lineWhoDatalistHTML(...a),
  lineRowsHTML: (...a) => lineRowsHTML(...a),
  bindLineEditors: (...a) => bindLineEditors(...a),
  lineCntTexts: (...a) => lineCntTexts(...a),
  renderEditor: (...a) => renderEditor(...a),
  needsLocal: (...a) => needsLocal(...a),
  autoLocalize: (...a) => autoLocalize(...a),
  setStatus: (...a) => setStatus(...a),
  GenOf: () => Gen,
  setVcTab: v => { vcTab = v; },
}, document, window);
const {
  audioDurOf,
  voiceWayOf,
  paintVoicePos,
  voiceReg,
  renderVoiceCol,
} = Voice;

/* 润色「要念的话」：走公共 InlinePolish 面板 + 全站同一套朗读稿提示词（TextAI.prompt('audio')）。
   与工作台语音栏那颗「AI 润色」是同一个面板、同一句系统提示词 ——
   这里只多交代一句「这是配画面的一句配音」（要口语、要短、不要解释），
   因为工作台润的是一整段文本，而这一处润的是一句台词。
   润色只改字：不合成、不计费，所以不需要二次确认。 */
async function polishVoiceText(col) {
  const ta = col.querySelector('#voiceText');
  const host = col.querySelector('#voicePolish');
  const btn = col.querySelector('#voicePolishBtn');
  if (!ta || !host) return;
  const original = String(ta.value || '').trim();
  if (original.length < 2) { setStatus('<span class="err">先写几个字再润色</span>'); return; }
  if (!window.TextAI || !TextAI.prov(REG)) { setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(REG))) { setStatus('<span class="err">请先在「设置」填文字 AI 密钥</span>'); return; }
  host.hidden = false;
  const sysBase = TextAI.prompt('audio');
  /* 这一处特有的一句（工作台润的是一整段文本，这里润的是画面上一句台词：要短、要一口气念完）。
     其余那几句对模型的交代走公共实现 `TextAI.polishExtra` / `answersNote`，与工作台同一份。 */
  const hint = '这是要给画面配的一句配音：要口语、要短（一口气能念完），不要写解释、不要写旁白提示、'
    + '不要带引号或表情符号，只返回这一句本身。';
  const taskWord = '配音稿（画面上一句台词）';
  /* 与镜头提示词润色同一套：有 ctl 就把片段灌进 InlinePolish 的面板（流式），
     没有 ctl 就用 AiStream 自己摆一块；只有反问那一轮仍是短 JSON 一次性调用。 */
  const call = (sys, user, ctl) => ctl
    ? TextAI.chatStream(REG, sys, user, { signal: ctl.signal }, ctl.push)
    : AiStream.text(REG, sys, user, { host: host, title: 'AI 正在润色这一句配音…' });
  const run = async (answers, ctl) => ({
    after: await call(
      TextAI.polishSys(sysBase + ' ' + hint, TextAI.polishExtra({ answers })),
      TextAI.polishUser(taskWord, original), ctl),
    note: '',
  });
  const ask = () => TextAI.askPolish(REG,
    TextAI.polishSys(sysBase + ' ' + hint, TextAI.polishExtra({ stage: 'ask' })),
    TextAI.askUser(taskWord, original, { count: '2–3', tail: '这一句没有随消息附图，别问画面之外的' }), {});
  /* 出结果之后接着说：拿屏幕上这一版（用户可能刚改过）按那一句再改，仍然只改字、不合成。 */
  const follow = async (askText, current, ctl, ctx) => {
    const p = TextAI.followPrompt({
      what: taskWord, ask: askText, current,
      extra: [hint, TextAI.answersNote(ctx && ctx.answers)],
    });
    return { after: await call(p.sys, p.user, ctl), note: '' };
  };
  /* 忙与闲只切状态：那一行字与图标各归哪一格都由公共层管（`aiBtnState` 只换 `.tx`，
     不重写整副 innerHTML —— 那样图标一会儿包在 .ic 里、一会儿裸着，颜色跟着漂）。 */
  window.aiBtnState(btn, true);
  try {
    await InlinePolish.interactive(host, {
      ask: TextAI.shouldAsk() ? ask : null, run: run, before: original,
      askTitle: 'AI 想先问几个问题',
      askIntro: '没答的按默认理解走',
      onFollow: follow,
      followPlaceholder: '还要怎么改？例：再短一点 / 语气急一点 / 数字写成中文读法',
      onApply: v => {
        ta.value = v;
        voiceDraft.text = v;
        /* 字数闸门跟着重判一次：润完可能变短到这一家的最少字数以下，按钮要当场禁掉
           （与手写时那一条是同一个判据，所以直接调输入框上那个 handler，不另写一份）。 */
        if (typeof ta.oninput === 'function') ta.oninput();
        setStatus('<span class="ok">✓ 已替换这一句</span>');
      },
      onStatus: t => setStatus(t),
    });
  } catch (e) {
    InlinePolish.clear(host);
    setStatus('<span class="err">润色失败：' + esc(String(errText(e))) + '</span>');
  } finally { window.aiBtnState(btn, false); }
}

/* 「上一镜 / 下一镜」两颗按钮已删（2026-10 用户点名）：切镜走左栏的分镜列表。 */

/* ---------- 成片播放 ---------- */
/* 签名 URL 过期刷新：播放/导出前取最新下载地址。
   「过没过期」问 `Api.mediaExpired`、「怎么换新」走 `Api.healMedia` —— 与开机那一趟
   （`healStaleUrls`）同一套，全站只有这一份判据。
   以前这里自己按 `c.expires` 判一次、再自己 `pollTask` 问一次，是同一件事的第二份实现：
   那个字段来自平台列表里的 `output.expires_at`，与地址里那位签名参数**不是同一个口径**，
   两处对不上时就变成「开机那一趟说没过期、播放这一句说过期了」，来回各打一条路；
   而逐条 pollTask 在 `pollVia:'list'` 那一族每次都是一整页 100 条的列表。
   healMedia 换到的新地址还会进那张内存表，`Api.mediaSrc` 认它 ——
   于是缩略图、灯箱、下载链接在同一次会话里一起跟着新鲜，不只这一个调用点。 */
async function freshUrl(c) {
  // 只刷新「任务号来自平台」的候选：local_/tmp_/asset_ 是本机造的号，上游没有这条任务可问
  if (!c || !c.vid || /^(local_|tmp_|asset_)/.test(String(c.vid))) return c && c.url;
  if (!c.url || !Api.mediaExpired(c.url)) return c.url;
  const got = await Api.healMedia([{ provider: c.provider, id: c.vid, url: c.url }], {
    onFresh: (rec, next) => { c.url = next; saveScheduleSoft(); },
  }).catch(() => 0);
  if (!got) {
    /* 平台换不到新地址而本机存过这份产物 → 直接用本机那份（不改 c.url：
       存储里那条平台外链留着，以后仍能再回源）。以前这里只报一句失败，
       播放/导出拿着过期地址去打，表现是「云端失效后直接不能显示」。 */
    const la = (window.AssetLocal && AssetLocal.localAssetIdOf) ? AssetLocal.localAssetIdOf(c.url) : '';
    if (la) {
      Toast.warn('平台地址换不到了，已退回本机副本：' + (c.name || c.vid));
      return Api.assetSrc(la);
    }
    Toast.warn('拿不到这条任务的新下载地址（平台上可能已被清理），播放/导出可能失败：' + (c.name || c.vid));
  }
  return c.url;
}

/* ---------- 成片下载：一律走浏览器默认方式 ---------- */
/* 项目已经没有「下载位置 / 另存为」这一层：无 File System Access 句柄、无 showSaveFilePicker、
   也不许页面自己写一份落点实现 —— 全站只有 Net.save 这一份，存哪由浏览器/系统决定。 */
function saveBlob(name, blob) {
  Net.save(blob, name);
  return { msg: '✓ 已交给浏览器下载：' + name, saved: false };
}
/* 成片尺寸：`proj.composition` 优先（FCPXML 导入写的就是它），没有就按第一个已选用镜头的比例
   计算（长边 1280），保证所有镜头比例一致地居中填充。
   画幅是**一部片子一份**：切片、实时预览、导出成片、FCPXML 都读这里，不在别处再推一次。
   页头那颗比例下拉已按 2026-10 用户要求删掉：新项目跟第一个镜头的比例走，
   FCPXML 导入的工程带上文件里声明的画幅。 */
function compositionOf() {
  const c = proj && proj.composition;
  if (!c) return null;
  const w = Math.round(Number(c.width)), h = Math.round(Number(c.height));
  /* 编码器要偶数宽高；范围按 64–4096 收（导出合成读的就是这一份画幅）。不合法的旧值当作没有。 */
  if (!(w >= 64 && h >= 64 && w <= 4096 && h <= 4096) || w % 2 || h % 2) return null;
  return { w, h };
}
function filmSize() {
  const c = compositionOf();
  if (c) return { w: c.w, h: c.h };
  const first = allShots().filter(shotReady)[0];
  const ar = (first && first.ar) || '16:9';
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar);
  const w = m ? Number(m[1]) : 16, h = m ? Number(m[2]) : 9;
  const long = 1280;
  if (w >= h) return { w: long, h: Math.round(long * h / w / 2) * 2 };
  return { w: Math.round(long * w / h / 2) * 2, h: long };
}
/* 播放区是**固定的标准横屏 16:9**（2026-10 用户点名），不跟成片画幅走 ——
   成片的真实尺寸只由 filmSize() 那一处算（导出与 FCPXML 读它），界面上没有第二个去处。 */

/* ---------- 视频模型与参数：按这一镜的输入推导可用模型 ---------- */
/* 素材编号与发送顺序的唯一计划表：首帧 → 尾帧 → 画面切片 → 手动参考图 → 参考视频 → 参考音频。
   芯片、润色附图、提交前的 @ 替换、真正发出去的 inputEntries 都读这一份（见 ref-plan.js）。 */
function chainSlotOf(sh) {
  return !!(sh && sh.linkPrev === 'tail' && !sh.firstFrame && allShots().indexOf(sh) > 0);
}
/* 规范标记 → 平台声明的引用语法（H3 就是 <Picture N> / <Video N> / <Audio N>）。
   未声明语法的平台原样提交。 */
function applyRefSyntax(prompt, prov) {
  return applyProviderRefSyntax(prompt, prov && prov.refSyntax);
}
/* 提示词里的 `@名字` / `@首帧` → 计划里的 `@参考图N`；编号与真正发出去的顺序同源。
   一次正则替换（名字按长度从长到短排），不做逐名 split：后者会在名字互为前缀时连锁改写。 */
function refTokenize(sh, prompt, ic, o) {
  /* 接续镜的首帧在提交那一刻才解析，但编号现在就得定下来：先按「会接上」占住第 1 张图，
     真正解析失败时整次提交会中止，不会发出一份编号错位的正文。 */
  const opt = o || { chainPending: chainSlotOf(sh) };
  return tokenizeRefPrompt(prompt, shotRefPlanOf(sh, ic, opt, id => Api.assetSrc(id)));
}

/* Panel域（engine/panel.js）：这一段（7206-9191）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Panel = createPanel({
  $: (...a) => $(...a),
  projOf: () => proj,
  REGOf: () => REG,
  BoardAssetsOf: () => BoardAssets,
  allShots: (...a) => allShots(...a),
  curShot: (...a) => curShot(...a),
  beginEdit: (...a) => beginEdit(...a),
  renderSoft: (...a) => renderSoft(...a),
  filmOf: () => ensureFilm(),
  chainModelList: (...a) => chainModelList(...a),
  ensureChainModel: (...a) => ensureChainModel(...a),
  chainModelWhy: (...a) => chainModelWhy(...a),
  chainWaitWhy: (...a) => chainWaitWhy(...a),
  resolveChainFrame: (...a) => resolveChainFrame(...a),
  filmEdited: (...a) => filmEdited(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  scheduleSaveQuiet: (...a) => scheduleSaveQuiet(...a),
  assetStoreId: (...a) => assetStoreId(...a),
  sameAssetSpace: (...a) => sameAssetSpace(...a),
  loadCredits: (...a) => loadCredits(...a),
  generateCandidate: (...a) => generateCandidate(...a),
  debounce: (...a) => debounce(...a),
  renderScenes: (...a) => renderScenes(...a),
  midEditTrimOf: () => midEditTrim,
  curDraftCand: (...a) => curDraftCand(...a),
  promptTextOf: (...a) => promptTextOf(...a),
  renderMid: (...a) => renderMid(...a),
  lineVoicedOf: (...a) => lineVoicedOf(...a),
  lineVoicesOf: (...a) => lineVoicesOf(...a),
  openLineVoice: (...a) => openLineVoice(...a),
  renderVoiceCol: (...a) => renderVoiceCol(...a),
  applyRefSyntax: (...a) => applyRefSyntax(...a),
  refTokenize: (...a) => refTokenize(...a),
  pickRefMedia: (...a) => pickRefMedia(...a),
  setPolishUI: v => { polishUI = v; },
  renderPolishPanel: (...a) => renderPolishPanel(...a),
  /* 拆分镜 / 改分镜的问答与过程面板（apply 域的状态）：编辑器整列重画后也要按 splitUI 拼回来，
     与上面那颗润色面板同一个重画钩子位（panel.js 的 renderEditor 尾部先后各调一次）。 */
  renderSplitPanel: (...a) => renderSplitPanel(...a),
  polishPrompt: (...a) => polishPrompt(...a),
  toDataURL: (...a) => toDataURL(...a),
  uploadImageDataUrl: (...a) => uploadImageDataUrl(...a),
  openPickDlg: (...a) => openPickDlg(...a),
  setKfQ: v => { kfQ = v; },
  kfArOf: () => kfAr,
  setKfAr: v => { kfAr = v; },
  kfSizeOf: () => kfSize,
  setKfSize: v => { kfSize = v; },
  kfFormatOf: () => kfFormat,
  setKfFormat: v => { kfFormat = v; },
  kfParamsSave: (...a) => kfParamsSave(...a),
  kfModelIdOf: () => kfModelId,
  setKfModelId: v => { kfModelId = v; },
  kfRunOf: () => kfRun,
  /* 「拆成几张 / 按什么维度拆」：值与展开态都在这一层（右栏每 3 秒整片重画，DOM 存不住） */
  kfSplitSel: (...a) => kfSplitSel(...a),
  kfSplitSet: (...a) => kfSplitSet(...a),
  kfSplitOpenOf: () => kfSplitOpen,
  setKfSplitOpen: v => { kfSplitOpen = !!v; },
  kfModelOf: (...a) => kfModelOf(...a),
  paintKfAdv: (...a) => paintKfAdv(...a),
  kfExtrasVisible: (...a) => kfExtrasVisible(...a),
  kfAdvSumText: (...a) => kfAdvSumText(...a),
  refreshEst: (...a) => refreshEst(...a),
  kfImgParams: (...a) => kfImgParams(...a),
  kfRefMax: (...a) => kfRefMax(...a),
  kfGenOpts: (...a) => kfGenOpts(...a),
  kfModelOptions: (...a) => kfModelOptions(...a),
  refreshKfEst: (...a) => refreshKfEst(...a),
  genOneImage: (...a) => genOneImage(...a),
  kfRefEntries: (...a) => kfRefEntries(...a),
  addKeyframeToRefs: (...a) => addKeyframeToRefs(...a),
  generateKeyframes: (...a) => generateKeyframes(...a),
  renderAll: (...a) => renderAll(...a),
  updateBanner: (...a) => updateBanner(...a),
  setStatus: (...a) => setStatus(...a),
  GenOf: () => Gen,
  wsLoadedOf: () => wsLoaded,
}, document, window);
const {
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
  syncAtBack,
  libPicChoices,
  addLibPicToShot,
  linePanelRows,
  lineWhoDatalistHTML,
  lineRowsHTML,
  bindLineEditors,
  lineCntTexts,
  renderEditor,
} = Panel;

/* ---------- 导入本机视频 → 本机资产 → 本镜候选 ----------
   落点和语音台的「本机音频」同一条：`Api.saveLocalAsset` 写进本机资产库并登记索引。
   候选只记 `/asset/<id>`，不记 `blob:`（刷新即失效）也不记文件路径（页面拿不到）。
   去重凭据 `importOp` 由「名字 + 字节数 + 修改时间」算成，服务端不需要认识它：
   同一份文件再导一次只把视口移到已有那条，不再追加第二条候选。 */
const IMPORT_MAX_BYTES = 200 * 1024 * 1024;
function importHitOf(op) {
  if (!op || !proj) return null;
  for (const sc of proj.scenes) {
    for (const sh of (sc.shots || [])) {
      const i = (sh.candidates || []).findIndex(c => c && c.importOp === op);
      if (i >= 0) return { sc, sh, i, c: sh.candidates[i] };
    }
  }
  return null;
}
function focusImported(hit, why) {
  proj.curScene = Math.max(0, proj.scenes.indexOf(hit.sc));
  proj.curShot = Math.max(0, (hit.sc.shots || []).indexOf(hit.sh));
  proj.curCand = hit.i;
  renderAll();
  setStatus('<span class="ok">' + why + '：在「' + esc(hit.sh.name || '未命名镜头') + '」第 '
    + (hit.i + 1) + ' 条候选里' + (hit.sh.selId === hit.c.vid ? '（已选用）' : '') + '</span>');
}
/* 真实时长 / 尺寸 / 音轨：走 MediaBackend.info（浏览器内 mediabunny 元数据 + <video> 兜底），
   服务端不提供媒体探测。
   失败不要挡住导入本身：拿不到时长就交回 null，播放器会自己量。 */
/* 候选 → 同源媒体地址：候选的 url 常是上游签名外链，必须先过 Api.mediaSrc 换成同源回环；
   本机已镜像的走 EditorMedia（本机优先）。轨道取帧与助手的媒体检查共用这一份。 */
const candTrackSrc = c => {
  const src = c && (c.src || c.url);
  if (!src) return '';
  const EM = window.EditorMedia;
  return EM ? EM.previewSrc(c) : Api.mediaSrc(src);
};
async function mediaInfo(body) {
  const src = (body && (body.src || body.url))
    || (body && body.assetId ? Api.assetSrc(body.assetId) : '');
  if (!src) return null;
  const mb = (window.MediaBackend) || (window.Wb && Wb.vframe && await Wb.vframe._mbReady());
  if (!mb) return null;
  const info = await mb.info(src);
  return info ? {
    duration: info.duration, width: info.width, height: info.height,
    hasAudio: info.hasAudio,
  } : null;
}
function readFileB64(file) {
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => res(String(rd.result).split(',')[1] || '');
    rd.onerror = () => rej(new Error('读这个文件失败（可能被占用或被移动）'));
    rd.readAsDataURL(file);
  });
}
async function importMediaFile(file) {
  if (!file) return;
  const name = String(file.name || '导入视频.mp4');
  const ext = (name.split('.').pop() || 'mp4').toLowerCase();
  const mime = file.type || ({ mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' }[ext] || 'video/mp4');
  if (!/^video\//.test(mime) && !['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) {
    setStatus('<span class="err">「' + esc(name) + '」不是视频文件：这里只收 mp4 / mov / webm / mkv 的画面</span>');
    return;
  }
  if (file.size > IMPORT_MAX_BYTES) {
    setStatus('<span class="err">「' + esc(name) + '」' + window.fmtBytes(file.size)
      + '，超过单文件导入上限 ' + window.fmtBytes(IMPORT_MAX_BYTES) + '</span>');
    return;
  }
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先在左侧选一个镜头，再把视频导进来</span>'); return; }
  const op = 'file:' + name + ':' + file.size + ':' + (Number(file.lastModified) || 0);
  const dup = importHitOf(op);
  if (dup) { focusImported(dup, '这份文件已经导入过，没有重复追加'); return; }
  setStatus('正在导入「' + esc(name) + '」…');
  try {
    const b64 = await readFileB64(file);
    const saved = await Api.saveLocalAsset({
      name, mime, format: ext || 'mp4', data: b64, media_type: 'video',
      meta: { provider: '本机', prompt: '', importedFrom: 'director' },
    });
    const aid = saved.assetId || saved.id;
    const url = saved.url || Api.assetSrc(aid);
    let info = null;
    try { info = await mediaInfo({ assetId: aid }); } catch (e) {
      console.warn('[director] 媒体检查失败（导入照常）：', e.message);
    }
    const cand = mkImportedCandidate({
      vid: 'local_' + uid(), provider: 'local', url, local: true,
      duration: info && Number(info.duration) > 0 ? Math.round(Number(info.duration) * 10) / 10 : null,
      importOp: op,
    });
    sh.candidates.push(cand);
    const autoSel = !sh.selId;
    if (autoSel) setSelectedCandidate(sh, cand);
    filmEdited();
    setStatus('<span class="ok">✓ 已导入「' + esc(name) + '」为本镜候选'
      + (autoSel ? '，并已选用为这一镜的画面' : '')
      + (info ? '（' + (Number(info.duration) > 0 ? Math.round(Number(info.duration) * 10) / 10 + ' 秒' : '时长未知')
        + (info.width && info.height ? ' · ' + info.width + '×' + info.height : '') + '）' : '')
      + '；文件已存进本机资产库</span>');
  } catch (e) {
    setStatus('<span class="err">导入失败：' + esc(errText(e)) + '</span>');
  }
}

/* ---------- 导入的第三方素材 → 本机 ----------
   用户点名的行为：资产进导演台就自动存一份到本机 —— 剪辑切片取帧与导出都读得到字节，
   不靠一天就过期的签名外链。落点就是 `AssetLocal.pullMany`（与四页的「存回本机」同一条队列、
   同一份去重与回执；它的 force 由内部自带 —— 用户这一次导入就是「当下点下去的」）。
   排队与失败都不挡导入：外链过期前照旧能预览，没能存的只在 Toast 里照实说一句。
   jobs: [{ entry（pull 认的那一份：provider/assetId/genId/src）, name, apply(url) }] */
const needsLocal = s => /^https?:\/\//i.test(String(s || '')) || /^\/(?:getv|fetch)\?/i.test(String(s || ''));
function autoLocalize(jobs) {
  const list = (jobs || []).filter(j => j && j.entry && needsLocal(j.entry.src || j.entry.rawSrc));
  if (!list.length || !window.AssetLocal || !AssetLocal.pullMany) return;
  AssetLocal.pullMany(list, {}).then(s => {
    const txt = AssetLocal.pullSummaryText ? AssetLocal.pullSummaryText(s) : '';
    if (!txt) return;
    if (s.ok && !(s.fails || []).length && !s.cant && !s.skip) Toast.receipt('第三方素材已自动存一份到本机：' + txt);
    else Toast.warn('第三方素材自动存本机：' + txt);
  }).catch(e => console.warn('[director] 自动存本机失败：', errText(e)));
}

/* ---------- 从资产库 / 收藏导入（统一走 AssetPicker） ----------
   中栏「导入」= 只挑视频，作为这一镜的候选画面。
   界面和工作台选参考素材是同一份选择器，本地文件也在那同一个弹窗里选（顶部「本地上传」档位）。
   槽位规则只取 reference_video 那一条：右栏那个「图片/视频一起塞」的入口已经去掉，
   参考图从各槽位进（openPickDlg），这里不再需要「取两个槽位里更严的一条」。 */
function openLibDlg(sh) {
  if (!sh) { setStatus('<span class="err">先在左侧选一个镜头，再从资产库导入</span>'); return; }
  const rm = resolvedModel(sh) || {};
  const rVid = (window.Capabilities && Capabilities.rule) ? Capabilities.rule(rm, 'reference_video') : null;
  AssetPicker.open({
    types: ['视频'],
    multiple: false, limit: 1,
    rule: rVid,
    title: '导入视频作为本镜画面',
    aiSearch: true,
    onPick: e => useLibEntry(sh, e),
  });
}
/* 选中的资产落到这一镜：视频→本镜候选画面（本地收藏先转存成资产，地址才长期有效） */
async function useLibEntry(sh, it) {
  if (!sh) return;
  if (it.type === '视频') {
    // 本地收藏（上传的文件）：先转存成资产，地址才长期有效
    if (it.localFav || it.fromLocal || /^blob:/.test(it.src || '')) {
      try {
        setStatus('正在把本地收藏的视频转存为资产…');
        const aid2 = await libEntryToAssetId(it, (it.prompt || it.name || '收藏视频').replace(/\s+/g, ' ').slice(0, 20) + '.mp4', 'video/mp4');
        /* 转存之后才拿得到资产号；同一条收藏再导一次不该多一条候选。 */
        const opA = 'asset:' + aid2;
        const dupA = importHitOf(opA);
        if (dupA) { focusImported(dupA, '这条视频已经导入过，没有重复追加'); return; }
        const cand2 = mkImportedCandidate({ vid: 'local_' + uid(), provider: assetStoreId(),
          url: Api.assetSrc(aid2), duration: it.duration, importOp: opA });
        sh.candidates.push(cand2);
        if (!sh.selId) setSelectedCandidate(sh, cand2);
        filmEdited();
        setStatus('<span class="ok">✓ 已把收藏的视频导入为这一镜的候选</span>');
        return;
      } catch (e) { setStatus('<span class="err">导入失败：' + e.message + '</span>'); return; }
    }
    // 中栏导入：作为本镜候选画面（来自平台视频接口的保留 vid/provider，签名 URL 过期后可用 freshUrl 重新拉取；
    //            判断依据是注册表里有没有这一家视频平台，而不是写死某个平台名）
    const isPlat = ((REG && REG.providers) || []).some(p => p.kind === 'video' && p.id === it.provider) && it.id
      && !/^(local_|tmp_|asset_)/.test(String(it.id));
    /* 稳定身份优先资产号，其次 `/asset/<id>`，再次平台任务号；签名外链不当身份（天天变）。 */
    const akey = it.assetId
      || (String(it.src || '').match(/\/asset\/([A-Za-z0-9_-]+)/) || [])[1]
      || (isPlat ? it.id : '');
    const op = akey ? 'asset:' + akey : '';
    const dup = importHitOf(op);
    if (dup) { focusImported(dup, '这条资产已经导入过，没有重复追加'); return; }
    const cand = mkImportedCandidate({ vid: isPlat ? it.id : 'local_' + uid(),
      provider: isPlat ? it.provider : 'local', url: it.src, local: !isPlat, duration: it.duration,
      importOp: op || undefined });
    sh.candidates.push(cand);
    if (!sh.selId) setSelectedCandidate(sh, cand);
    /* 第三方供应商的文件：导入这一下就排进本机镜像（剪辑取帧与导出都读得到字节）。 */
    if (needsLocal(cand.url)) {
      autoLocalize([{
        entry: { kind: 'asset', provider: cand.provider, assetId: it.assetId, genId: it.id, src: cand.url, name: it.name || it.prompt },
        name: it.name || it.prompt || '素材',
        apply: url => { cand.url = url; cand.local = true; scheduleSave(); },
      }]);
    }
  }
  filmEdited();
  setStatus('<span class="ok">✓ 已从资产库导入到当前镜头</span>');
}

/* ---------- 参考视频 / 参考音频：从资产库选（也可本地上传） ----------
   参考图那一排槽位点开就是一个选择弹窗，参考视频/音频以前只能本地上传，现在对齐成一样的体验。 */
async function libEntryToAssetId(it, name, contentType, provId, role) {
  const to = provId || assetStoreId();
  const aid = it.assetId || (String(it.src || '').match(/\/asset\/([A-Za-z0-9_-]+)/) || [])[1];
  const template = Api.inputTemplate(provOf(to), role);
  if (aid && sameAssetSpace(it.provider, to) && !(template && template.requiresAudio)) return aid;
  return await AssetTransfer.toAsset(to, it.dl || it.src, { reg: REG, name, contentType, role, onStage: dlStage('素材') });
}
/* `preset`：从别处（建模台回传）已经定好的那一条，有了就不弹选择器、直接走下面的上传 / 登记。 */
async function pickRefMedia(sh, kind, preset) {
  const isAudio = kind === 'refaudio';
  const role = isAudio ? 'reference_audio' : 'reference_video';
  const label = isAudio ? '参考音频' : '参考视频';
  const rm = resolvedModel(sh) || {};
  /* 选择器收哪几类、能选几个、本地上传的 accept 全部现读这个槽位的能力声明；
     体积上限在上传那一步统一校验（AssetTransfer → Capabilities.providerLimit）。 */
  const cap = shotInputCaps(sh);
  const rule = (window.Capabilities && Capabilities.rule)
    ? Capabilities.rule(rm, role, sh.combo) : { max: 1, accept: '' };
  const types = (window.Capabilities && Capabilities.slotTypes) ? Capabilities.slotTypes(rm, role) : (isAudio ? ['音乐', '音频'] : ['视频']);
  const note = cap.slotNote(role);
  const list = preset ? [preset] : await AssetPicker.open({
    types, multiple: false, limit: 1,
    /* 这一镜的参考视频 / 参考音频**各只有一格**（提交体是 body.reference_video = { asset_id }），
       所以规则里的数量按 1 显示 —— 平台声明的 max 再大也没地方放，照抄会出现
       「弹窗写『还能加 1 个』、却又只能点一张」。类型与体积上限仍照平台声明走。 */
    rule: Object.assign({}, rule, { max: 1 }),
    title: '选择' + label + (note ? '（' + note + '）' : ''),
    upload: rule.accept ? { accept: rule.accept } : undefined,
  });
  if (!list || !list.length) return;
  const it = list[0];
  try {
    setStatus('处理' + label + '…');
    const ext = isAudio ? ((it.format || 'wav') === 'wav' ? '.wav' : '.mp3') : '.mp4';
    const name = ((it.prompt || label).replace(/\s+/g, ' ').trim().slice(0, 20) || 'ref') + ext;
    const aid = await libEntryToAssetId(it, name, isAudio ? ((it.format || 'wav') === 'wav' ? 'audio/wav' : 'audio/mpeg') : 'video/mp4', assetProvFor(sh), isAudio ? 'reference_audio' : 'reference_video');
    if (isAudio) sh.refAudio = { asset_id: aid, name, src: it.src };
    else {
      const ref = { asset_id: aid, name, src: it.src, duration: it.duration || null, provider: assetProvFor(sh), preparedFor: assetProvFor(sh) };
      /* 本地上传的文件没有长期地址（blob: 刷新即失效）：顺手在本机取一帧小图存进镜头，
         否则刷新后这个槽位只剩一个文件名。 */
      if (it.file) { try { ref.thumb = await Wb.vframe.dataURLFromFile(it.file, 'first', 320); } catch { /* 抽帧失败就没有缩略图，素材照样挂得上 */ } }
      sh.refVideo = ref;
    }
    renderEditor(); scheduleSave();
    setStatus('<span class="ok">✓ 已设为这一镜的' + label + '</span>');
  } catch (e) {
    setStatus('<span class="err">加入' + label + '失败：' + e.message + '</span>');
  }
}

/* ---------- 润色指令（文字AI）---------- */
/* 润色要附带的素材图：编号、顺序与真正发出去的 content[] 完全同源（见 shotRefPlanOf）。
   合成一张「参考图N」的标签，是为了让文字 AI 在正文里写的 @参考图N 与平台收到的第 N 项对得上。 */
function polishImageList(sh) {
  const plan = shotRefPlanOf(sh, shotInputCaps(sh), { chainPending: chainSlotOf(sh) }, id => Api.assetSrc(id));
  return plan.pictures
    .filter(p => p.src || p.assetId)
    .map(p => ({
      label: '参考图' + p.n + (p.label ? ' · ' + p.label : ''),
      src: p.src || Api.assetSrc(p.assetId),
      token: p.token,
      role: p.role,
    }));
}
/* 润色结果的就地状态：编辑器会被反复重渲染，面板内容存这里才不会丢
   { shotId, text, note, loading, run, follow, answersText, talk }
   `answersText` = 这一版是按哪些回答润的（「重新润色」要照同一份回答重跑，不能重跑成没回答）；
   `talk` = 结果出来之后用户接着说过的那几句（数组存在这里，整栏重画后还能画回来）。 */
let polishUI = null;
/* 这一处润的是「镜头提示词」：那句话的名字只在这一处点一次名，
   发给模型的正文、反问那句、以及输入框的提示语都从它派生（见 TextAI.polishUser / askUser / followPrompt）。 */
const POLISH_SHOT_WORD = '镜头提示词';
/* 按当前状态在 #polishInline 里画润色面板（renderEditor 每次重渲染后都会调）
   两个阶段都从这里画，状态全在 polishUI 里：切镜头再切回来不能丢内容。 */
function renderPolishPanel(sh) {
  const host = $('polishInline');
  if (!host) return;
  if (!polishUI || !sh || polishUI.shotId !== sh.id) { InlinePolish.clear(host); return; }
  if (polishUI.loading) { InlinePolish.loading(host, polishUI.loadingText || '正在润色这一镜的提示词…'); return; }
  /* 阶段一：AI 反问要点（选项 + 每题最后一个自由输入框）。就地展开，不开新弹窗。 */
  if (polishUI.phase === 'ask' && polishUI.questions && polishUI.questions.length) {
    InlinePolish.ask(host, {
      title: 'AI 想先问几个问题',
      intro: '没答的按默认理解走',
      questions: polishUI.questions,
      state: polishUI.answers || [],
      onChange: st => { if (polishUI) polishUI.answers = st; },
      onSubmit: t => polishRun(t),
      onSkip: () => polishRun(''),
    });
    return;
  }
  const ta = $('edPrompt');
  InlinePolish.show(host, {
    after: polishUI.text, note: polishUI.note, before: ta ? ta.value : '',
    onEdit: v => { polishUI.text = v; },                       // 用户改过的版本也存住，重渲染不丢
    onApply: v => {
      const d4 = curDraftCand();
      if (d4) d4.prompt = v; else sh.prompt = v;
      polishUI = null;
      renderEditor(); renderScenes(); scheduleSave();
      setStatus('<span class="ok">✓ 已替换这一镜的提示词</span>');
    },
    /* ctl 一路传给 polishUI.run：有了它，重跑的那一轮是**边写边灌进上面这个结果框**，
       而不是往宿主里再摆一块流式面板 —— 宿主就是这一块面板，摆下去等于把「替换 / 放弃 /
       按这句再改」那一排连按钮一起销毁（旧代码正是这样，重跑一次按钮就没了）。 */
    onRetry: async ctl => {
      if (!polishUI) return { after: '', note: '' };
      const r = await polishUI.run(polishUI.answersText || '', ctl);
      /* 那一句note 重拼一遍，不能只留 `picked.note`：重跑用的还是同一份回答，
         而 picked.note 只有「有没有带上图」那一句 —— 直接盖掉就把「已按你的回答润色」说丢了。 */
      const note = [polishUI.note0, r.note, polishUI.answersText ? '已按你的回答润色' : ''].filter(Boolean).join(' · ');
      polishUI.text = r.after; polishUI.note = note;
      return { after: r.after, note: note };
    },
    /* 「按这句再改」：结果出来之后接着和 AI 说，改的是屏幕上这一版（用户可能刚手改过）。
       第 4 个参数里的 answers 是先前那几题的回答 —— 这一处问答是页面自己画的（不是
       InlinePolish.interactive），所以由 polishUI.answersText 交回公共层，再随 ctx 递回来。 */
    onFollow: polishUI.follow ? (askText, current, ctl) =>
      polishUI.follow(askText, current, ctl, { answers: polishUI.answersText || '' }) : null,
    talk: polishUI.talk,
    followPlaceholder: '还要怎么改？例：运镜写成具体动作 / 光线改成正午 / 只留一句',
    onReask: polishUI.questions && polishUI.questions.length
      ? () => { polishUI.phase = 'ask'; renderPolishPanel(sh); }   // 回到问答改答案
      : null,
    onClose: () => { polishUI = null; },
  });
}
/* 第二段：按回答润色 → 出结果面板（loading → 结果都走 polishUI，重渲染不丢） */
async function polishRun(answers) {
  const sh = curShot();
  if (!polishUI || !sh || polishUI.shotId !== sh.id) return;
  polishUI.loading = true;
  polishUI.loadingText = answers ? '正在按你的回答润色…' : '正在润色这一镜的提示词…';
  renderPolishPanel(sh);
  const btn = $('polishBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await polishUI.run(answers);
    polishUI.loading = false;
    polishUI.phase = 'result';
    polishUI.answersText = answers || '';
    polishUI.text = r.after; polishUI.note = [polishUI.note0, r.note, answers ? '已按你的回答润色' : ''].filter(Boolean).join(' · ');
  } catch (e) {
    polishUI = null;
    InlinePolish.clear($('polishInline'));
    setStatus('<span class="err">润色失败：' + e.message + '</span>');
  } finally {
    window.aiBtnState(btn, false);
    renderPolishPanel(curShot());
  }
}
async function polishPrompt() {
  const ta = $('edPrompt');
  if (!ta) { setStatus('<span class="err">先在左侧选一个镜头</span>'); return; }
  const sh = curShot();
  const original = (ta.value || '').trim();
  if (!original) { setStatus('<span class="err">先写要润色的提示词</span>'); return; }
  if (!TextAI.prov(REG)) { setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(REG))) { setStatus('<span class="err">请先在「设置」填文字 AI 密钥</span>'); return; }
  let images = [];
  /* 流式有两个落点，取决于这一轮是谁发起的：
     · 带着 ctl（「重新润色」与「按这句再改」—— 结果面板此刻就在屏幕上）→ 片段灌进 ctl.push，
       边写边显示在结果框里。这时**不能**再往 `#polishInline` 摆流式面板：那块宿主就是结果面板本身。
     · 不带 ctl（第一次点「AI 润色」，宿主里只有一句转圈）→ 用 AiStream 的面板，这一轮动辄十几秒，
       看得见它写到哪里比只挂一句「正在润色…」有用得多。 */
  const call = (sys, user, ctl) => ctl
    ? TextAI.chatStream(REG, sys, user, { images, signal: ctl.signal }, ctl.push)
    : AiStream.text(REG, sys, user, {
        images: images, host: $('polishInline'), title: 'AI 正在润色这一镜的提示词…',
      });
  /* 素材清单：参考图 / 首帧 / 尾帧 / 时间切片会随消息附上；**参考视频与参考音频附不了**，
     但必须写清「有几条、拿来干什么」—— 只说一句「还挂了参考视频」的话，模型既不知道数量
     也不知道内容，只能靠猜（`TextAI.materialNote` 是公共实现，三个工作台共用一份措辞）。 */
  const materials = () => {
    /* 只有真的随消息发出去的那几张才写 sent：识图没开或某张读不出来时，
       文字 AI 看不到那一张，不能让它以为看见了。 */
    const sentLabels = new Set(images.map(x => x.label));
    const items = polishImageList(sh).map(x => ({
      label: x.label, token: x.token, role: x.role, kind: '图片', sent: sentLabels.has(x.label),
    }));
    /* 接续镜的首帧提交时才取得到，润色这一轮附不上；把它的编号与来源说给文字 AI，
       它才知道这一镜的第 1 张图是上一镜的落幅、正文该从哪里起笔。 */
    const ic = shotInputCaps(sh);
    if (chainSlotOf(sh)) items.unshift({ label: '接上一镜尾帧', token: '@参考图1', role: 'first_frame', kind: '图片', sent: false, hint: '提交时自动取上一镜结尾当首帧' });
    if (ic.refVideo && sh.refVideo) items.push({ label: '参考视频', token: '@视频1', role: 'reference_video', kind: '视频', sent: false, hint: '这一镜沿用它的运镜和节奏' });
    if (ic.refAudio && sh.refAudio) items.push({ label: '参考音频', token: '@音频1', role: 'reference_audio', kind: '音频', sent: false, hint: '这一镜沿用它的节奏' });
    return items;
  };
  /* Skill 正文里的 {duration} / {mode} / {model} / {ar} / {assets}：
     这些是**这一次请求的条件**，由程序按当前镜头填好；Skill 只决定把它们摆在哪一段。 */
  const shotVarsNow = () => {
    const rm = resolvedModel(sh) || {};
    const cb = shotCombo(sh);
    const items = materials();
    const mode = (cb && comboLabel(cb)) || (shotUsedRoles(sh).length ? '参考素材' : '纯文字');
    return {
      duration: sh.duration ? sh.duration + ' 秒' : '按型号声明的默认时长',
      mode: mode,
      model: rm.id ? String(rm.id) + (rm.name && rm.name !== rm.id ? '（' + rm.name + '）' : '') : '未选型号',
      ar: sh.ar || '按型号声明的默认画幅',
      assets: items.length ? TextAI.materialNote(items) : '这一镜没有参考素材',
    };
  };
  /* 变量里的「附上了几张」取决于 prep 的结果（识图开没开、有没有读不出来的），
     所以系统提示词在 prep 之后现拼。 */
  const shotSysNow = () => TextAI.prompt('video', undefined, shotVarsNow());
  const prep = async () => {
    // 「随附图片」编号与 @参考图N 一致：参考图 → 首帧 / 尾帧 → 时间切片画面
    const picked = await TextAI.polishImages(REG, polishImageList(sh));
    images = picked.images;
    return picked;
  };
  /* 一次润色 = 准备素材图（识图模型才带）→ 组装提示词 → 调用文字 AI；返回 { after, note }。
     answers 是用户对「AI 先前的追问」的回答（没有追问时是空串）。
     素材清单与时长已经由 `shotVarsNow` 填进 Skill 正文的 `{}` 变量；`TextAI.polishExtra` 只补
     随附图怎么用、@标记要保留、用户的回答 —— 这几句与工作台同一套。 */
  const run = async (answers, ctl) => {
    const picked = await prep();
    const sys = TextAI.polishSys(shotSysNow(), TextAI.polishExtra({
      images: images, text: original, answers: answers,
    }));
    return { after: await call(sys, TextAI.polishUser(POLISH_SHOT_WORD, original), ctl), note: picked.note };
  };
  /* 结果出来之后接着对话：改的是**屏幕上这一版**（用户可能刚在面板里手改过），
     素材图与素材清单照旧重算 —— 换的只是用户那一句要求。
     `text: current` 让「@参考图1 这类标记要原样保留」那一句跟着新版走（第一版里可能没有、改完又有了）。 */
  const follow = async (askText, current, ctl, ctx) => {
    const picked = await prep();
    const p = TextAI.followPrompt({
      what: POLISH_SHOT_WORD, ask: askText, current: current,
      extra: TextAI.polishExtra({
        images: images, text: current, materials: materials(), answers: (ctx && ctx.answers) || '',
      }),
    });
    return { after: await call(p.sys, p.user, ctl), note: picked.note };
  };
  const btn = $('polishBtn');
  const wantAsk = TextAI.shouldAsk();        // 设置选「从不问」时不发起这一轮
  polishUI = { shotId: sh.id, phase: 'ask', loading: true, loadingText: '正在读这一镜，想想到底要先问什么…',
    run: run, follow: follow, answersText: '', talk: [], note0: '', questions: [], answers: [] };
  window.aiBtnState(btn, true);
  /* 先反问：**由 AI 自己判断**值不值得问（need=false 就直接润色）。这一轮同样带素材图与清单 ——
     看过画面再问，问出来的才是画面相关的问题。 */
  let questions = [];
  if (wantAsk) {
    InlinePolish.loading($('polishInline'), '正在读这一镜，判断还缺什么…');
    let r = { need: false, questions: [] };
    try {
      const picked = await prep();
      const askSys = TextAI.polishSys(shotSysNow(), TextAI.polishExtra({
        images: picked.images, stage: 'ask',
      }));
      r = await TextAI.askPolish(REG, askSys,
        TextAI.askUser(POLISH_SHOT_WORD, original, { count: '2–4', tail: '这一镜挂了哪些素材见系统提示' }), { images });
    }
    catch (e) { r = { need: false, questions: [] }; }
    questions = (r && r.need) ? (r.questions || []) : [];
  } else {
    InlinePolish.loading($('polishInline'), '正在润色这一镜的提示词…');
  }
  if (!polishUI || polishUI.shotId !== sh.id) return;        // 期间切了镜头：这次润色作废
  if (questions.length) {
    polishUI.phase = 'ask';
    polishUI.loading = false;
    polishUI.questions = questions;
    polishUI.answers = [];
    window.aiBtnState(btn, false);
    renderPolishPanel(curShot());
    return;
  }
  polishUI.note0 = wantAsk ? '这次没能反问，直接润色' : '';
  await polishRun('');
}

/* 回收候选的 blob: URL（只针对本地导入的视频；/asset、blob: 之外的链接不动） */
function releaseCandUrl(c) {
  if (!c || !c._objUrl || !c.url) return;
  try { URL.revokeObjectURL(c.url); } catch { /* blob 忘了释放也会被浏览器回收，不影响功能 */ }
  c._objUrl = false;
}
/* 删镜头 / 删场景时也要回收它们下面所有候选的 blob 地址
   （以前只有「删候选」和「删项目」回收，删整镜/整场景会让 blob 一直留在内存里） */
function releaseShotUrls(sh) {
  if (!sh) return;
  (sh.candidates || []).forEach(releaseCandUrl);
}
function releaseSceneUrls(sc) {
  if (!sc) return;
  (sc.shots || []).forEach(releaseShotUrls);
}

/* 启动时恢复本地导入的视频：用 IndexedDB 里的 Blob 重建 objectURL */
async function restoreLocalBlobs() {
  const jobs = [];
  (WS.projects || []).forEach(p => (p.scenes || []).forEach(sc => (sc.shots || []).forEach(sh => (sh.candidates || []).forEach(c => {
    if (c.provider === 'local' && c.blobKey) {
      jobs.push(wsKv.get(c.blobKey).then(b => { if (b) { c.url = URL.createObjectURL(b); c._objUrl = true; } }).catch(() => {}));
    }
  }))));
  await Promise.allSettled(jobs);
}

/* 素材 → dataURL：支持 dataURL 原样返回、/asset/xx 与相对路径先取回再转 */
async function toDataURL(src) {
  if (!src) return src;
  if (String(src).startsWith('data:')) return src;
  const url = Api.assetDlSrc(src);                          // ?dl=1 的写法只有 Api 那一份
  const b = await Net.blob(url, { timeout: 60000 });      // 统一取字节（带超时 + 先判状态）
  return await AssetTransfer.toDataURL(b);
}
async function uploadImageDataUrl(src, name, provId) {
  // 通用跨平台转存：dataURL / /asset/xx / 外部 https → 目标平台的资产
  return await AssetTransfer.toAsset(provId || assetStoreId(), src, { reg: REG, name });
}

/* ---------- 选一张画面 / 参考图（统一走 AssetPicker） ----------
   和三个工作台选参考素材是同一份选择器：资产库 / 我的收藏 / 本地上传三个档位，
   生成入口不在这里（要出图去图片台，出完之后这里现成能选）。 */
function openPickDlg(sh, kind) {
  const isFirst = kind === 'first';
  const isRef = kind === 'ref';
  const prev = isFirst ? prevShotTail(sh) : null;
  const role = isFirst ? 'first_frame' : kind === 'last' ? 'last_frame' : 'reference_image';
  const rm = resolvedModel(sh) || {};
  /* 参考图是**能放好几张**的槽位（sh.refImages 是数组，右栏就写着「已有 N / maxRef 张」），
     选择器必须按「本槽位还剩几个位置」开成多选。以前三个槽位一律 multiple:false, limit:1，
     表现就是「槽位写着还能加 9 张，弹窗却说『还能加 1 个』，选一张以后就选不了第二张」。
     首帧 / 尾帧各只有一格，固定单选；参考图只剩一格时也自动退回单选。 */
  const ic = shotInputCaps(sh);
  const room = isRef ? Math.max(0, ic.maxRef - (sh.refImages || []).length) : 1;
  if (isRef && room <= 0) { setStatus('<span class="err">参考图最多 ' + ic.maxRef + ' 张（首帧/尾帧不计入）</span>'); return; }
  AssetPicker.open({
    types: isFirst ? ['图片', '视频'] : ['图片'],
    multiple: room > 1,
    limit: room,
    /* 这个槽位收什么类型、单文件多大、**这一档收几张**：都现读能力声明（首帧槽也收视频，声明里写了就照它显示）。
       combo 必须递进去 —— 「视频换人」里人物图必须恰好 1 张，递型号总表那份 ≤9 就会画出
       「标题说还能加 1 张、弹窗里写着上限 9」的两张口（limit 与 rule 得同一个口径）。 */
    rule: (window.Capabilities && Capabilities.rule) ? Capabilities.rule(rm, role, sh.combo) : null,
    title: isFirst ? '选一张开头画面' : kind === 'last' ? '选一张结尾画面' : '选参考图（还能加 ' + room + ' 张）',
    note: isFirst ? '图片直接用；选视频则取它的<b>最后一帧</b>当开头画面' : '',
    aiSearch: true,
    extraLabel: prev ? prev.label : '',
    extraAction: prev ? () => usePrevTail(sh, prev) : null,
    onPick: e => applyFrameEntry(sh, kind, e),
  });
}
/* 「接上一镜结尾」：上一镜有静态尾帧 / 关键帧就用它，否则从它已选用的视频里截尾帧 */
function prevShotTail(sh) {
  const all = allShots();
  const i = all.indexOf(sh);
  const prev = i > 0 ? all[i - 1] : null;
  if (!prev) return null;
  const lastKf = prev.lastFrame || ((prev.keyframes || []).filter(k => k.assetId).pop() || {}).assetId;
  if (lastKf) return { prev, lastKf, label: '接上一镜结尾（「' + prev.name + '」）' };
  /* 选用的那条不在 / 没成时退到第一条成功候选：与 `hasTailFrame` 同一判据，
     否则「接上一镜」的入口时有时无，用户只能自己去找视频截帧。 */
  const cand = prev.candidates.find(c => c.vid === prev.selId && c.status === 'succeeded' && c.url)
    || prev.candidates.find(c => c.status === 'succeeded' && c.url);
  if (!cand) return null;
  return { prev, cand, label: '截取上一镜视频尾帧（「' + prev.name + '」）' };
}
async function usePrevTail(sh) {
  try {
    setStatus('正在截取上一镜尾帧…');
    /* 与自动接续走同一个解析（静态尾帧 → 画面切片 → 视频末帧），不在这里再写一份顺序。 */
    const f = await resolveChainFrame(sh);
    sh.firstFrame = f.src;
    renderEditor(); scheduleSave();
    setStatus('<span class="ok">✓ 已把' + f.from + '作为开头画面</span>');
  } catch (e) { setStatus('<span class="err">' + e.message + '</span>'); }
}
/* 选中的条目落到槽位：图片转成 dataURL 存着；开头画面这档选中视频时，在本机取它的最后一帧 */
async function applyFrameEntry(sh, kind, e) {
  try {
    if (e.type === '视频') {
      setStatus('正在从视频取最后一帧…');
      sh.firstFrame = await (e.file ? Wb.vframe.dataURLFromFile(e.file, 'last') : Wb.vframe.dataURL(e.dl || e.src, 'last'));
      setStatus('<span class="ok">✓ 已取该视频的最后一帧作为开头画面</span>');
    } else {
      /* 单文件多大由模型对这个槽位的声明决定（rule.maxBytes），不再写死 5 MiB：
         平台允许 20 MiB 时本地多拦一道就是不让用户用好，平台只收 1 MiB 时写死的 5 MiB 又拦不住。
         没声明就不在本地猜，交给平台判。 */
      const role = SLOT_ROLE[kind] || 'first_frame';
      const rule = (window.Capabilities && Capabilities.rule)
        ? Capabilities.rule(resolvedModel(sh), role) : null;
      const mb = Number((rule && rule.maxBytes) || 0);
      if (e.file && mb > 0 && e.file.size > mb) {
        setStatus('<span class="err">' + (ROLE_ZH[role] || '图片') + '超过平台声明的 ' + window.fmtBytes(mb) + ' 上限</span>');
        return;
      }
      const src = e.file ? await AssetTransfer.toDataURL(await compressImg(e.file)) : await toDataURL(e.src);
      if (kind === 'first') sh.firstFrame = src;
      else if (kind === 'last') sh.lastFrame = src;
      else {
        if (!canAddSlot(sh, 'ref')) { setStatus('<span class="err">已选开头/结尾画面，本镜不能再加参考图（清空后才能换）</span>'); return; }
        const lim = shotInputCaps(sh).maxRef;   // 模型声明几张就是几张，不猜 9
        if (sh.refImages.length >= lim) { setStatus('<span class="err">参考图最多 ' + lim + ' 张（首帧/尾帧不计入）</span>'); return; }
        addRefImage(sh, src, (e.fromLocal || e.localFav) ? '收藏' : null);
      }
      setStatus('<span class="ok">✓ 已加入</span>');
    }
    renderEditor(); scheduleSave();
  } catch (err) { setStatus('<span class="err">取用失败：' + errText(err) + '</span>'); }
}

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
function imgProviders() { return Api.pickable((REG?.providers || []).filter(p => p.kind === 'image')); }
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
  return await AiStream.text(REG, sys, user, {
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
      const en = await AssetTransfer.entryFor(pick.prov, 'reference_image', src, { reg: REG, name: '导演台-画面参考图' });
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
  if (!TextAI.prov(REG)) { kfRun = false; setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(REG))) { kfRun = false; setStatus('<span class="err">请先在「设置」填文字 AI 密钥</span>'); return; }
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

/* ---------- 全局渲染 ---------- */
/* 轮询 / 长任务的后台刷新走 renderSoft：正在编辑的栏先跳过（重建会把输入框换掉，焦点和光标全丢），
   焦点离开后再补一次渲染，避免内容长期不更新。用户主动操作仍用 renderAll，立刻生效。 */
let renderPending = false;
function editingIn(sel) {
  const ae = document.activeElement;
  return !!(ae && ae !== document.body && ae.closest && ae.closest(sel));
}
/* 「正在打字」比「焦点在这一栏」窄一档：textarea 与文本类输入（输入法可能正在拼字）。
   滑块 / 复选 / 下拉那些离散控件不算 —— 它们要的是立刻重画，等失焦反而像没生效。 */
function typingIn(sel) {
  const ae = document.activeElement;
  if (!ae || !ae.closest || !ae.closest(sel)) return false;
  if (ae.tagName === 'TEXTAREA' || ae.isContentEditable) return true;
  if (ae.tagName !== 'INPUT') return false;
  const t = String(ae.type || 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t);
}
let forceMid = false;
function renderSoft(what) {
  const cols = what || ['scenes', 'mid', 'edit'];
  if (cols.includes('scenes')) { if (editingIn('.col-left')) renderPending = true; else renderScenes(); }
  if (cols.includes('mid')) {
    if (forceMid) { forceMid = false; renderMid(); }          // 刚有候选出结果：立刻显示，不等失焦
    else if (editingIn('#midCol')) renderPending = true;
    else renderMid();
  }
  if (cols.includes('edit')) { if (editingIn('#edCol')) renderPending = true; else renderEditor(); }
  updateBanner(); updateProjUI();
}
document.addEventListener('focusout', () => {
  if (!renderPending) return;
  setTimeout(() => {
    if (!renderPending) return;
    if (!editingIn('.col-left') && !editingIn('#midCol') && !editingIn('#edCol')) { renderPending = false; renderAll(); }
  }, 150);
});
function renderAll() { renderPending = false; renderScenes(); renderMid(); renderEditor(); updateBanner(); updateProjUI(); }
function updateProjUI() {
  /* 页头那一格只报「现在是哪一部」；改名走这颗按钮点开的那份菜单里的就地编辑。 */
  $('projLabel').textContent = proj.name || '未命名短片';
  $('projSwitch').title = (proj.name || '未命名短片') + ' · 切换短片 / 分组与改名';
  refreshEst();
  /* 「生成全部分镜」的文案与可用状态跟镜头增删、型号、条数一起变：去抖在它自己那一份里，
     重复调用只是排一次定时器。 */
  Gen.refreshGenAllBtn();
}
/* 项目菜单：按**项目组**分树（组 → 组内的短片 → 未分组）。
   组名即素材组名（见 web/director/groups.js）。组的判据全在那个模块里，这里只画。
   这一份菜单里每一步都在原地做完：改名把名称那一格换成输入框、移组在那一行下面摊开一个下拉、
   删除走公共的 `Confirm.arm` 就地二次确认 —— 不弹表单窗，也不弹确认框。 */
/* 就地编辑态（界面状态，不写进工程数据，菜单一收就清）：
   pmEdit  'p:<id>' | 'g:<id>' —— 哪一格正在改名
   pmMove  短片 id —— 哪一行摊开了移组下拉
   pmNew   新建项目组的草稿开没开
   pmSync  { key, oldName, newName, n } —— 改组名之后对素材库那一组的追问挂在哪个组下面
   pmIOOpen —— 底部「项目文件」那一组是不是摊开了。
   pmIOSplitOpen —— 导出拆分按钮的尾钮摊开没（当前项目组短片 / 全部短片）。
   跟着菜单一起复位：每次重新打开短片菜单都是**默认折叠**的那一屏。 */
let pmEdit = '', pmMove = '', pmNew = false, pmSync = null;
let pmIOOpen = false, pmIOSplitOpen = false;
function clearProjMenuStates() {
  pmEdit = ''; pmMove = ''; pmNew = false; pmSync = null;
  pmIOOpen = false; pmIOSplitOpen = false;
}
function findProj(id) { return WS.projects.find(x => x && x.id === id); }
/* 改组名之后素材库那一组要不要一起改？
   **不自动改**：素材库是用户数据，那一组可能还有别的来源（同名的组在别的短片里也在用）。
   原位问一次，点了才动；改素材组的落点只有 `Chars.Lib.renameGroup` 一处。 */
function assetGroupCountOf(oldName) {
  const D = window.Chars;
  if (!D || !D.Lib || !D.Lib.renameGroup || !D.Lib.groupMatch) return 0;
  return (D.Lib.list() || []).filter(c => c && D.Lib.groupMatch(c, oldName)).length;
}
function resolveAssetGroupSync(apply) {
  const s = pmSync; pmSync = null;
  if (!s) return;
  if (!apply) {
    setStatus('<span class="ok">✓ 项目组已改名为「' + esc(s.newName) + '」；素材库那一组还叫「' + esc(s.oldName) + '」</span>');
    renderProjMenu(); return;
  }
  const D = window.Chars;
  const r = D && D.Lib ? D.Lib.renameGroup(s.oldName, s.newName) : null;
  renderProjMenu();
  if (r && r.why) { Toast.warn(r.why); return; }
  setStatus('<span class="ok">✓ 项目组已改名为「' + esc(s.newName) + '」，素材库那一组 ' + ((r && r.n) || 0) + ' 条也改了</span>');
}
/* 项目组的展开 / 收起是界面状态，不写进工程数据：按组 id 记在本机，
   组名改掉、短片移走都不影响它。未分组用 __none 这个键。 */
const K_PROJ_FOLD = 'dir_proj_fold';
let foldedProjGroups = new Set();
try {
  const saved = window.LS.json(K_PROJ_FOLD, []);
  if (Array.isArray(saved)) foldedProjGroups = new Set(saved.map(String));
} catch (e) { /* 读不到就全部展开 */ }
function saveProjFold() {
  try { window.LS.setJson(K_PROJ_FOLD, [...foldedProjGroups]); } catch (e) { /* 写不进去，本次会话仍然有效 */ }
}
function toggleProjFold(key) {
  if (foldedProjGroups.has(key)) foldedProjGroups.delete(key); else foldedProjGroups.add(key);
  saveProjFold();
  renderProjMenu();
}
function renderProjMenu() {
  const menu = $('projMenu');
  const tree = Groups.tree(WS);
  const gCount = Groups.list(WS).length;
  /* 重画前先把开着的下拉收掉：浮层挂在 body 上、不跟着这次 innerHTML 一起消失，
     留着就会对着一个已经不在的按钮浮在半空（折叠、换一行、删掉那一行都会走到这里）。 */
  if (window.Dropdowns) window.Dropdowns.closeAll();
  /* 整栏重建罩在公共件里：`#projMenu` 自己就是那只 `max-height:60vh` 的滚动容器，`innerHTML =`
     之后一路 appendChild 把行重新造一遍，滚动位在清空那一刻夹回 0 —— 表现是「滚到列表底下挑短片，
     一次改名 / 移组 / 删除之后弹回栏顶」。 */
  Wb.viewport.keep(menu, () => {
    menu.innerHTML = '<div class="pm-head">共 ' + WS.projects.length + ' 个短片'
      + (gCount ? ' · ' + gCount + ' 个项目组' : '') + '</div>';
    /* 就地改名的一格：输入框 + 保存 / 取消，画在名称那一格原来的位置上（行本身不换）。
       Enter 保存、Esc 收回；焦点给公共件（focusQuiet 不抢视口），选中整名方便直接改。 */
    const editCells = (cur, commit) => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'pm-edit'; inp.value = cur; inp.autocomplete = 'off';
      inp.title = '改完按回车保存 · Esc 取消';
      const back = () => { pmEdit = ''; renderProjMenu(); };
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'ghost mini'; ok.textContent = '保存';
      ok.onclick = e => { e.stopPropagation(); pmEdit = ''; commit(inp.value); };
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ghost mini'; no.textContent = '取消';
      no.onclick = e => { e.stopPropagation(); back(); };
      inp.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pmEdit = ''; commit(inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); }
      };
      /* 点击不许冒到行上：那一行点下去是「切到这部短片」，编辑时点它等于顺手切走。 */
      inp.onclick = e => e.stopPropagation();
      requestAnimationFrame(() => { window.focusQuiet(inp); inp.select(); });
      return [inp, ok, no];
    };
    /* 摊在短片那一行下面的移组下拉：选一处就归位（当前那一组是预选值），不另写标签行。
       原生 <select> 只当数据源，外观与浮层交给公共件 Dropdowns —— 这一排不另画一串去处按钮。
       这一格的稳定键另起一个前缀：与它上面那一行共用 `data-id` 会让还位认不清该还哪一格。 */
    const moveBox = p => {
      const box = document.createElement('div');
      box.className = 'pm-move';
      box.setAttribute('data-key', 'mv:' + p.id);
      const sel = document.createElement('select');
      sel.className = 'pm-gsel';
      sel.title = '选一个项目组，这部短片就移过去';
      const add = (id, name) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = name;
        sel.appendChild(o);
      };
      add('', '未分组');
      Groups.list(WS).forEach(g => add(g.id, g.name));
      sel.value = p.groupId || '';
      sel.onchange = () => {
        const id = sel.value;
        const hit = id ? Groups.list(WS).find(g => g.id === id) : null;
        const name = id ? ((hit && hit.name) || '') : '未分组';
        pmMove = '';
        if ((p.groupId || '') === id) { renderProjMenu(); return; }
        Groups.assign(WS, p.id, id);
        renderProjMenu(); renderAll(); scheduleSave();
        setStatus('<span class="ok">✓ 已把「' + esc(p.name) + '」移到「' + esc(name) + '」</span>');
      };
      box.appendChild(sel);
      if (window.Dropdowns) { window.Dropdowns.build(box); window.Dropdowns.sync(sel); }
      /* 原生 select 是 display:none，那句话挂在它上面永远露不出来；没有可见标签之后，
         说明挂到真正被点的 `.dd-btn` 上。 */
      const btn = box.querySelector('.dd-btn');
      if (btn) btn.title = sel.title;
      return box;
    };
    /* 改组名之后挂在组头下面的追问：素材库那一组要不要一起改名。 */
    const syncBox = () => {
      const box = document.createElement('div');
      box.className = 'pm-note';
      const t = document.createElement('span');
      t.textContent = '素材库里 ' + pmSync.n + ' 条还挂在旧组名「' + pmSync.oldName + '」，要一起改吗？';
      box.appendChild(t);
      const yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'ghost mini'; yes.textContent = '一起改';
      yes.onclick = e => { e.stopPropagation(); resolveAssetGroupSync(true); };
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ghost mini'; no.textContent = '不用';
      no.onclick = e => { e.stopPropagation(); resolveAssetGroupSync(false); };
      box.appendChild(yes); box.appendChild(no);
      return box;
    };
    const projRow = (p, inGroup) => {
      const row = document.createElement('div');
      row.className = 'pm-row' + (p.id === WS.curId ? ' sel' : '') + (inGroup ? ' pm-in-group' : '');
      /* 行身份给公共件：折叠 / 移组 / 删除会让「第 i 格」换人，只按下标还位会把视野还到别的短片上。 */
      row.setAttribute('data-id', p.id);
      if (pmEdit === 'p:' + p.id) {
        editCells(p.name, v => commitProjName(p, v)).forEach(el => row.appendChild(el));
        return row;
      }
      const n = (p.scenes || []).reduce((a, s) => a + (s.shots || []).length, 0);
      row.innerHTML = `<span class="pm-name">${esc(p.name)} <span class="pm-cnt">· ${n} 镜</span></span>
        <span class="pm-ops">
          <button type="button" class="pm-btn" data-move="${p.id}" title="移到别的项目组">${icon('folder', 13)}</button>
          <button type="button" class="pm-btn" data-rename="${p.id}" title="重命名这个短片">${icon('pencil', 13)}</button>
          <button type="button" class="pm-btn danger" data-del="${p.id}" title="删除这个短片">${icon('trash', 13)}</button>
        </span>`;
      row.onclick = e => { if (e.target.closest('.pm-btn')) return; switchProject(p.id); menu.hidden = true; };
      return row;
    };
    tree.forEach(g => {
      /* 组头：折叠 + 组名 + 几部短片 + 改名 / 删组。
         删组只把组内的短片退回未分组，**不删短片** —— 删组是整理，不是删作品。 */
      const key = g.kind === 'none' ? '__none' : g.id;
      const folded = foldedProjGroups.has(key);
      const editing = g.kind !== 'none' && pmEdit === 'g:' + g.id;
      const head = document.createElement('div');
      head.className = 'pm-group' + (g.kind === 'none' ? ' none' : '') + (folded ? ' folded' : '');
      head.setAttribute('data-gid', key);
      head.innerHTML = (g.items.length
        ? `<button class="pm-gfold" type="button" data-gfold="${esc(key)}" aria-expanded="${!folded}" title="${folded ? '展开这个项目组' : '收起这个项目组'}">${icon(folded ? 'chevronDown' : 'chevronUp', 12)}</button>`
        : '<span class="pm-gfold" aria-hidden="true"></span>')
        + (editing ? '' : `<span class="pm-gname">${esc(g.name)}</span>
        <span class="pm-cnt">· ${g.items.length} 部</span>
        <span class="pm-ops">
          ${g.kind === 'none' ? '' : `<button type="button" class="pm-btn" data-grename="${g.id}" title="重命名这个项目组">${icon('pencil', 13)}</button>
          <button type="button" class="pm-btn danger" data-gdel="${g.id}" title="删掉这个项目组（组里的短片退回未分组，不会被删）">${icon('trash', 13)}</button>`}
        </span>`);
      if (editing) editCells(g.name, v => commitGroupName(g, v)).forEach(el => head.appendChild(el));
      head.onclick = e => {
        if (!g.items.length || e.target.closest('.pm-btn') || e.target.closest('[data-gfold]')) return;
        toggleProjFold(key);
      };
      const fold = head.querySelector('[data-gfold]');
      if (fold) fold.onclick = e => { e.stopPropagation(); toggleProjFold(key); };
      menu.appendChild(head);
      if (pmSync && pmSync.key === key) menu.appendChild(syncBox());
      if (!folded) g.items.forEach(it => {
        menu.appendChild(projRow(it.p, g.kind !== 'none'));
        if (pmMove === it.p.id) menu.appendChild(moveBox(it.p));
      });
    });
    /* 底部两行（新建组 / 新建短片）也在这趟里长出来：keep 还位发生在回调返回那一刻，
       拖到外面 append 的话还位量到的是「还没有这两行」的高度，夹算就矮了一截。 */
    const gAdd = document.createElement('div');
    if (pmNew) {
      /* 新建项目组 = 菜单里的一行草稿，不弹表单窗。 */
      gAdd.className = 'pm-newg';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'pm-edit'; inp.autocomplete = 'off'; inp.placeholder = '新项目组名称';
      inp.title = '组名同时是素材库里的分组名，拆分镜的新素材会落进同名组\n改完按回车建组 · Esc 取消';
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'ghost mini'; ok.textContent = '建组';
      ok.onclick = e => { e.stopPropagation(); createProjGroup(inp.value); };
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ghost mini'; no.textContent = '取消';
      no.onclick = e => { e.stopPropagation(); pmNew = false; renderProjMenu(); };
      inp.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); createProjGroup(inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pmNew = false; renderProjMenu(); }
      };
      gAdd.appendChild(inp); gAdd.appendChild(ok); gAdd.appendChild(no);
      requestAnimationFrame(() => window.focusQuiet(inp));
    } else {
      gAdd.className = 'pm-add';
      gAdd.textContent = '＋ 新建项目组';
      gAdd.onclick = () => { pmNew = true; renderProjMenu(); };
    }
    menu.appendChild(gAdd);
    const addRow = document.createElement('div');
    addRow.className = 'pm-add';
    addRow.textContent = '＋ 新建短片';
    addRow.onclick = () => {
      /* 名字按**同组**里的序号往下排：一组里连点几次「新建短片」不会得到一排同名的
         「未命名短片」，菜单里分得出谁是谁。序号判据在 groups.js（纯件）。 */
      const gid = (proj && proj.groupId) || '';
      const p = { id: uid(), name: Groups.nextProjectName(WS, gid, Groups.DEFAULT_PROJECT_NAME),
        scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] };
      /* 新短片默认落在**当前短片所在的组**里 —— 同一组的短片才共享素材。 */
      if (gid) p.groupId = gid;
      WS.projects.push(p);
      switchProject(p.id);
      menu.hidden = true;
    };
    menu.appendChild(addRow);
    /* 项目文件那一组也长在这一趟重画里：放到 keep 回调外面 append 的话，
       视口还位量到的是「还没有这几行」的高度，菜单滚到底时会被夹回去。
       **默认折叠**：底部只留一行开关，摊开是两颗**同级**入口 ——
       导出（拆分按钮）与导入项目文件，同一套 .pm-io 行、同样的图标位与右对齐 hint。
       拆分按钮：左半就是「导出当前短片」，行尾那枚 chevron 是**独立一格热区**，摊开范围更大的
       「导出当前项目组短片 / 导出全部短片」—— 它们才是导出的次级，所以缩进在左侧细线里，
       窄范围在前、全量在后；导入不是导出的子项，留在同一级，别让它看起来低一级。
       用自家的 .pm-io* 一类而不是 .pm-add —— 那边「＋ 新建项目组」是按 pm-add 数出来点的。 */
    const ioBox = document.createElement('div');
    ioBox.className = 'pm-io-box';
    const ioToggle = document.createElement('div');
    ioToggle.className = 'pm-io-toggle';
    ioToggle.setAttribute('role', 'button');
    ioToggle.tabIndex = 0;
    ioToggle.setAttribute('aria-expanded', pmIOOpen ? 'true' : 'false');
    ioToggle.title = '项目文件：展开 / 收起导入导出';
    ioToggle.innerHTML = icon('box', 13) + '<span class="pm-io-name">项目文件 · 导入 / 导出</span>'
      + icon(pmIOOpen ? 'chevronUp' : 'chevronDown', 12);
    const toggleIO = e => {
      if (e) e.stopPropagation();
      pmIOOpen = !pmIOOpen;
      pmIOSplitOpen = false;          // 收起这一组，尾钮也跟着收回到默认那一屏
      renderProjMenu();
    };
    ioToggle.onclick = toggleIO;
    ioToggle.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleIO(e); } };
    ioBox.appendChild(ioToggle);
    if (pmIOOpen) {
      /* 摊开的内容整组缩进一条竖线里（`.pm-io-body`）：这几行长在「项目文件 · 导入 / 导出」
         下面，不是与上面那串短片行同级 —— 光靠缩进还不够，竖线才是层级的那条边。 */
      const ioBody = document.createElement('div');
      ioBody.className = 'pm-io-body';
      /* 两套行：`.pm-io` 是同级入口（导出主钮 / 导入），`.pm-io-sub .pm-io` 是拆分按钮摊开的次级。
         两者字型、行高、内边距一致；次级只多一条缩进细线，因此导入与导出看起来仍是一级。 */
      const ioRow = (label, hint, glyph, act, off) => {
        const row = document.createElement('div');
        row.className = 'pm-io' + (off ? ' pm-io-off' : '');
        row.innerHTML = icon(glyph, 13) + '<span class="pm-io-name">' + esc(label) + '</span>'
          + '<span class="pm-io-hint">' + esc(hint) + '</span>';
        row.title = label + '（' + hint + '）';
        if (off) {
          /* 当前短片没归组时「按项目组导出」没有范围：留着这一格（位置稳定、人也知道少了什么），
             但标成不可用，点一下把原因说清楚。 */
          row.setAttribute('aria-disabled', 'true');
          row.title = label + '：当前短片还没归入项目组';
          row.onclick = e => {
            e.stopPropagation();
            $('projMenu').hidden = true;
            setStatus('<span class="err">当前短片还没归入项目组：先把它归到一个组，才能按组导出</span>');
          };
          return row;
        }
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.onclick = e => { e.stopPropagation(); act(); };
        row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } };
        return row;
      };
      /* 当前短片所在的项目组 —— 范围就是同组的那些短片（组名即素材组名，见 groups.js）。 */
      const grp = Groups.groupOf(WS, proj);
      const grpN = grp ? WS.projects.filter(p => p && p.groupId === grp.id).length : 0;
      const split = document.createElement('div');
      split.className = 'pm-io pm-io-split';
      const main = document.createElement('div');
      main.className = 'pm-io-main';
      main.setAttribute('role', 'button');
      main.tabIndex = 0;
      main.title = '导出当前短片的完整工程（.json）';
      main.innerHTML = icon('download', 13) + '<span class="pm-io-name">导出当前短片</span>'
        + '<span class="pm-io-hint">.json</span>';
      const doCurrent = e => { if (e) e.stopPropagation(); exportProjectPack('current'); };
      main.onclick = doCurrent;
      main.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCurrent(e); } };
      const more = document.createElement('div');
      more.className = 'pm-io-more';
      more.setAttribute('role', 'button');
      more.tabIndex = 0;
      more.setAttribute('aria-expanded', pmIOSplitOpen ? 'true' : 'false');
      more.setAttribute('aria-label', '更多导出范围');
      more.title = '更多导出范围：当前项目组短片 / 全部短片';
      more.innerHTML = icon('chevronDown', 12);
      const toggleMore = e => {
        if (e) e.stopPropagation();
        pmIOSplitOpen = !pmIOSplitOpen;
        renderProjMenu();
      };
      more.onclick = toggleMore;
      more.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMore(e); } };
      split.appendChild(main); split.appendChild(more);
      ioBody.appendChild(split);
      if (pmIOSplitOpen) {
        const sub = document.createElement('div');
        sub.className = 'pm-io-sub';
        sub.appendChild(ioRow('导出当前项目组短片', grp ? grp.name + ' · ' + grpN + ' 部' : '当前短片未归组', 'folder',
          () => exportProjectPack('group'), !grp));
        sub.appendChild(ioRow('导出全部短片', WS.projects.length + ' 部', 'box',
          () => exportProjectPack('all')));
        ioBody.appendChild(sub);
      }
      ioBody.appendChild(ioRow('导入项目文件', '追加为新短片', 'upload', () => pickProjectPack()));
      ioBox.appendChild(ioBody);
    }
    menu.appendChild(ioBox);
  });
  /* 摊开的移组下拉在视口还位之后再打开：浮层按按钮的视口坐标定点，
     重画中途就打开会摆到「还没还位」的那一版位置上。点「文件夹」就是来看去哪一组的，
     所以这里替用户多点一下，不必再点开下拉本身。 */
  if (pmMove) {
    const gsel = menu.querySelector('.pm-move select');
    if (gsel && window.Dropdowns) window.Dropdowns.open(gsel);
  }
  /* 就地移组：点「文件夹」在那一行下面摊开下拉，再点一次收回。 */
  menu.querySelectorAll('[data-move]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (!findProj(b.dataset.move)) return;
    pmMove = pmMove === b.dataset.move ? '' : b.dataset.move;
    renderProjMenu();
  });
  /* 就地改名：把名称那一格换成输入框，焦点直接进去。 */
  menu.querySelectorAll('[data-rename]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (!findProj(b.dataset.rename)) return;
    pmEdit = 'p:' + b.dataset.rename;
    renderProjMenu();
  });
  menu.querySelectorAll('[data-grename]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    pmEdit = 'g:' + b.dataset.grename;
    renderProjMenu();
  });
  /* 删组：就地二次确认（公共 `Confirm.arm`）—— 第一下把按钮变成「确认删除？」，第二下才真删。
     删组只把组内短片退回未分组，一条作品都不动。 */
  menu.querySelectorAll('[data-gdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const g = Groups.list(WS).find(x => x.id === b.dataset.gdel);
    if (!g) return;
    const n = (WS.projects || []).filter(p => p && p.groupId === g.id).length;
    if (Confirm.arm(b, '确认删除？', { note: n ? `组里的 ${n} 部短片退回未分组，不会被删掉` : '这个组里没有短片' })) return;
    Groups.remove(WS, g.id);
    if (pmSync && pmSync.key === g.id) pmSync = null;
    renderProjMenu(); renderAll(); scheduleSave();
    setStatus('<span class="ok">✓ 已删掉项目组「' + esc(g.name) + '」（' + n + ' 部短片退回未分组）</span>');
  });
  /* 删短片：同样是就地二次确认，第二下才走 deleteProject。 */
  menu.querySelectorAll('[data-del]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const pp = findProj(b.dataset.del);
    if (!pp) return;
    const shots = (pp.scenes || []).reduce((a, s) => a + (s.shots || []).length, 0);
    if (Confirm.arm(b, '确认删除？', { note: `这部短片的 ${shots} 个镜头一起删掉，无法恢复`, key: 'p:' + pp.id })) return;
    deleteProject(pp.id);
  });
}
/* 改短片名：空名不改（保持原样），改完把页头那一格与右栏一起刷过去。 */
function commitProjName(p, v) {
  const nm = String(v || '').trim();
  if (nm) p.name = nm;
  renderProjMenu(); renderAll(); scheduleSave('改短片名');
}
/* 改组名：组名就是素材组名，所以素材库那边同名的一组会被牵动。
   改完当场在原位问一次（`pmSync`），问了才动 —— 素材库是用户数据。 */
function commitGroupName(g, v) {
  const nm = String(v || '').trim();
  const r = nm && nm !== g.name ? Groups.rename(WS, g.id, nm) : null;
  if (r) {
    const n = assetGroupCountOf(r.old);
    if (n) pmSync = { key: r.id, oldName: r.old, newName: r.name, n };
    renderAll(); scheduleSave();
  }
  renderProjMenu();
}
/* 新建项目组：建完把当前短片归进去 —— 用户「建一个组」多半就是为了归这一部。 */
function createProjGroup(v) {
  const nm = String(v || '').trim();
  if (!nm) { renderProjMenu(); Toast.warn('先给这个组起个名字'); return; }
  pmNew = false;
  const g = Groups.ensure(WS, nm);
  if (!g) { renderProjMenu(); return; }
  if (proj && proj.id) Groups.assign(WS, proj.id, g.id);
  renderProjMenu(); renderAll(); scheduleSave();
  setStatus('<span class="ok">✓ 已建项目组「' + esc(g.name) + '」' + (proj ? '，当前短片已放进去' : '') + '</span>');
}
/* 删掉一部短片：连带清掉它引用的本地视频 blob，最后一部删完补一条空白短片。 */
function deleteProject(id) {
  const pp = findProj(id);
  if (!pp) return;
  try {
    (pp.scenes || []).forEach(sc2 => (sc2.shots || []).forEach(sh2 => (sh2.candidates || []).forEach(c => {
      if (c && c.provider === 'local' && c.blobKey) { releaseCandUrl(c); wsKv.del(c.blobKey).catch(() => {}); }
    })));
  } catch { /* 清不动 blob 不拦删短片：键留在 IndexedDB 里由 sweep 收 */ }
  WS.projects = WS.projects.filter(x => x.id !== id);
  if (!WS.projects.length) {
    WS.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  if (WS.curId === id) WS.curId = WS.projects[0].id;
  if (pmMove === id) pmMove = '';
  if (pmEdit === 'p:' + id) pmEdit = '';
  switchProject(WS.curId);
  renderProjMenu();
  setStatus('<span class="ok">✓ 已删除短片「' + esc(pp.name) + '」</span>');
}
function switchProject(id) {
  /* 切走短片 = 这一批不该再往下投：还没开始的镜头直接停，正在提交的那一条按它自己的回包落定。
     `runGenAll` 里还会比对 `proj` 与 `WS.curId` 兜一次（双保险，不靠调用顺序）。 */
  if (Gen.genAllRunning()) Gen.abortGenAll('切换了短片');
  WS.curId = id;
  proj = WS.projects.find(p => p.id === id) || WS.projects[0];   // id 失效（导入/删除后）时回落到第一个，别直接抛错
  if (!proj) { WS.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] }); proj = WS.projects[0]; WS.curId = proj.id; }
  proj.curScene = 0; proj.curShot = 0; proj.curCand = 0;
  renderAll(); scheduleSave();
}
/* ---------- 项目文件：导出 / 导入完整工程 ----------
   页头那四种导出只带「选中的画面」，是成片或给剪辑软件的交换文件；这里带的是作品本身：
   每一镜的全部候选、提示词与台词、参考图、选用 / 裁剪 / 锁定、成片轨、画幅、项目组名。
   格式闸门与清洗在 web/director/project-pack.js（纯件），下面三个函数只管取文件与放回工作区。 */
/* scope：'current' 当前短片 / 'all' 工作区全部 / 'group' 当前短片所在的项目组。
   早先这里是布尔（true = 全部），留着兼容老调用点。 */
function exportProjectPack(scope) {
  const mode = scope === true ? 'all' : (scope || 'current');
  try {
    const grp = Groups.groupOf(WS, proj);
    if (mode === 'group' && !grp) throw new Error('当前短片还没归入项目组，按组导出没有范围可用');
    const list = mode === 'all' ? WS.projects
      : mode === 'group' ? WS.projects.filter(p => p && p.groupId === grp.id)
        : [proj];
    if (!list.length) throw new Error('这个范围里没有短片可导出');
    const pack = buildProjectPack({
      projects: list,
      groupNameOf: p => Groups.assetGroupName(WS, p),
      /* 每一枚 `/asset/la_xxx` 随包带上落点 / 体积 / 平台身份：新机器只拷视频文件、
         不搬索引时，导入端按它把旧号认回盘上那一份（项目文件纯件只收不管网络）。 */
      hintOf: u => (window.AssetLocal && AssetLocal.exportHintOf ? AssetLocal.exportHintOf(u) : null),
    });
    /* buildProjectPack 已经按形状校验过、并算好了 checksum —— 这里不再对着刚造出来的
       包重跑一遍 assert（那等于把几 MB 的 projects 再 stringify + 散列一次，纯白费）。 */
    const s = pack.stats;
    const base = mode === 'all' ? '全部短片'
      : mode === 'group' ? grp.name
        : (proj.name || '未命名短片');
    const name = window.fileSafe(base, 60) + '-项目-' + window.fileStamp() + '.json';
    Net.save(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }), name);
    const media = s.localAssets + s.remoteUrls;
    const carried = media
      ? '；视频字节不在包里（' + (s.localAssets ? s.localAssets + ' 条本机素材' : '')
        + (s.localAssets && s.remoteUrls ? ' / ' : '') + (s.remoteUrls ? s.remoteUrls + ' 条平台地址' : '')
        + '，本机素材把视频文件放进新机器的资产库即可认回）'
      : '';
    const hinted = pack.media.length
      ? '；随包带了 ' + pack.media.length + ' 条本机素材线索，只拷视频文件也能认回旧本机号' : '';
    setStatus('<span class="ok">✓ 已交给浏览器下载：' + esc(name) + '（' + s.projects + ' 部短片'
      + (s.groups ? ' / ' + s.groups + ' 个项目组' : '') + ' / '
      + s.shots + ' 镜 / ' + s.candidates + ' 条候选 / '
      + (s.promptShots + s.promptCandidates + s.lines + s.notes) + ' 段提示词 / '
      + (s.clips + s.voices + s.captions + s.markers) + ' 段剪辑）' + carried + hinted + '</span>');
  } catch (e) {
    setStatus('<span class="err">导出项目文件没能完成：' + esc(errText(e)) + '</span>');
  } finally {
    $('projMenu').hidden = true;
  }
}
function pickProjectPack() {
  const input = $('projPackFile');
  $('projMenu').hidden = true;
  if (!input) { setStatus('<span class="err">项目文件选择器不在页面上</span>'); return; }
  input.value = '';                 // 同一份文件连选两次也要触发 change
  input.click();
}
$('projPackFile').onchange = async e => {
  const input = e.target;
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  if (!wsLoaded) {
    setStatus('<span class="err">工作区还没装载完，稍等一下再导入项目文件</span>');
    return;
  }
  let pack, desc;
  try {
    pack = JSON.parse(await file.text());
    assertProjectPack(pack);        // 零写入闸门：任何一项不过，工作区一个字节都不动
    desc = describeProjectPack(pack);
  } catch (err) {
    setStatus('<span class="err">项目文件没能导入：' + esc(errText(err)) + '</span>');
    return;
  }
  /* ---- 两处冲突先问清楚，再走「追加为新短片」那一道确认 ----
     先问「重复的要不要再来一份」：全跳过的话就没有「落在哪个组」的问题了，
     组名那一问要按**真正会导进来**的那几部重新扫一遍。
     两件事都不能不问就替用户定：前者决定工作区里多不多一份，
     后者决定短片落在哪个组 —— 尤其「同一个包导了两遍」是最常见的那一种。 */
  const scanOpts = {
    nameKey: window.nameKey,
    localProjects: WS.projects,
    groupTaken: n => !!Groups.find(WS, n),
  };
  let conflict;
  try {
    conflict = scanProjectPackConflicts(pack, scanOpts);
  } catch (err) {
    setStatus('<span class="err">项目文件没能导入：' + esc(errText(err)) + '</span>');
    return;
  }
  let skipIndexes = [];
  if (conflict.duplicates.length) {
    const n = conflict.duplicates.length;
    const sample = conflict.duplicates.slice(0, 3)
      .map(d => '《' + d.name + '》= 本机《' + d.sameAs + '》').join('；') + (n > 3 ? ' 等' : '');
    const pick = await Confirm.choose({
      title: '有内容完全一致的短片',
      sub: '按作品内容比对（不看名字与 id），包里这 ' + n + ' 部本机已经有了：' + sample,
      options: [
        { label: '跳过这 ' + n + ' 部', hint: '本机已经有一份，不再重复导入', value: 'skip' },
        { label: '仍然导入并重命名', hint: '包里这份照收，名字加「（导入）」后缀和本机那部分开', value: 'rename' },
      ],
    });
    if (pick == null) return;
    if (pick === 'skip') skipIndexes = conflict.duplicates.map(d => d.index);
  }
  if (skipIndexes.length && skipIndexes.length === pack.projects.length) {
    setStatus('<span class="ok">✓ 包里 ' + skipIndexes.length
      + ' 部短片与本机已有作品内容一致，按你的选择一部都没重复导入</span>');
    return;
  }
  let groupPolicy = 'merge';
  let groupHits = [];
  try {
    groupHits = scanProjectPackConflicts(pack, { ...scanOpts, skipIndexes }).groups;
  } catch (err) {
    setStatus('<span class="err">项目文件没能导入：' + esc(errText(err)) + '</span>');
    return;
  }
  if (groupHits.length) {
    const names = groupHits.map(g => '「' + g.name + '」（' + g.count + ' 部）').join('、');
    const pick = await Confirm.choose({
      title: '项目组重名：怎么落位？',
      sub: '包里这些组名本机已经有了：' + names,
      options: [
        { label: '并入现有同名组', hint: '短片直接放进本机那个组，不会新建组', value: 'merge' },
        { label: '给导入的组改名', hint: '导入的组加「（导入）」后缀，本机原有的组一个字节都不动', value: 'rename' },
      ],
    });
    if (pick == null) return;
    groupPolicy = pick === 'rename' ? 'rename' : 'merge';
  }
  const go = await Confirm.ask({
    title: '导入项目文件？', okLabel: '追加为新短片', cancelLabel: '取消',
    body: desc.text + (skipIndexes.length
      ? ' 其中 ' + skipIndexes.length + ' 部内容与本机一致，按你的选择跳过。' : ''),
  });
  if (!go) return;
  /* 追加，不覆盖：与本机已有短片撞 id 就换一枚、撞名字就加后缀，
     导入的每一部都是新的那一条，现有作品一部都不动。 */
  const prep = prepareProjectPackImport(pack, {
    uid,
    existingIds: WS.projects.map(p => p.id),
    nameTaken: n => WS.projects.some(p => p.name === n),
    nameKey: window.nameKey,
    groupTaken: n => !!Groups.find(WS, n),
    groupPolicy,
    skipIndexes,
  });
  /* ---- 换机器只拷视频文件、不搬索引时：按包里的旧 la_ 号把盘上那一份认回来 ----
     代理这一跳只写账（一个字节都不下载）：按可移植尾标 / 相对落点 / 文件名+体积找文件，
     找到就把旧号与平台身份补进账。重绑失败不拦导入 —— 素材可能还没拷过来，
     之后开机磁盘对账与 `/asset/<旧号>` 那一问也会把它认回来。 */
  let rebound = 0, rebindOmitted = 0, rebindErr = '';
  if (prep.media.length) {
    try {
      const d = await Net.json('/local-assets/rebind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: prep.media }),
      });
      const got = (d && Array.isArray(d.rows)) ? d.rows.filter(Boolean) : [];
      /* learn 只把一行收进当前会话的别名表（行形状不对时自己返回 null），不必再吞一层异常。 */
      got.forEach(r => { if (window.AssetLocal && AssetLocal.learn) AssetLocal.learn(r); });
      rebound = got.length;
      /* 代理一次只处理有限条（见 local-assets-store 的 rebindBodies）：超出的照实报出来，
         不能让用户以为「全都认回了」。 */
      rebindOmitted = Math.max(0, Number(d && d.omitted) || 0);
      if (d && d.error) rebindErr = '索引没写成：' + d.error;
    } catch (e) { rebindErr = errText(e); }
  }
  /* 项目组跟着包一起回来，而且**只按组名认**（见 groups.js）：本机已有同名组就并进去，
     没有才新建 —— 同一份包导入两次不会得到两个「默认组」。组名同时是素材组名，
     并进现有组正是「同名就在那个组下添加」。
     分类用的「导入前有哪些组」要在 push 之前拍下来：循环里 ensure 会现建新组，
     事后再查就分不出哪个是本机原有的、哪个是这一趟建的。 */
  const hadGroups = new Set(Groups.list(WS).map(g => window.nameKey(g.name)));
  const newGroups = new Set(), joinGroups = new Set();
  for (const it of prep.items) {
    WS.projects.push(it.project);
    if (!it.groupName) continue;
    const g = Groups.ensure(WS, it.groupName);
    if (!g) continue;
    Groups.assign(WS, it.project.id, g.id);
    (hadGroups.has(window.nameKey(g.name)) ? joinGroups : newGroups).add(g.name);
  }
  WS.curId = prep.items[0].project.id;
  /* 走页面自己的数据消毒（成片轨、游标、参考图地址都在那儿统一规整），不另写一份。 */
  sanitize();
  renderProjMenu();
  switchProject(WS.curId);
  scheduleSave('导入项目文件');
  /* 导入的短片里的候选此刻才进工作区：投一次自动镜像。开关关着时这一趟是空转
     （历史补扫不带 mustSave），开着才补齐 —— 与开机那一趟同一条路。 */
  try { Gen.announceDoneCandidates(); } catch (e) { /* 补齐失败不拦导入回执 */ }
  const n = prep.notes;
  const tail = (newGroups.size ? '；新建 ' + newGroups.size + ' 个项目组（'
    + Array.from(newGroups).map(g => esc(g)).join('、') + '）' : '')
    + (joinGroups.size ? '；' + joinGroups.size + ' 个项目组并入了现有同名组' : '')
    + (n.renamedGroups ? '；' + n.renamedGroups + ' 个重名组改了名（'
      + n.groupRenames.map(r => esc(r.from) + ' → ' + esc(r.to)).join('、') + '）' : '')
    + (n.inFlight ? '；' + n.inFlight + ' 条在途生成已标为可重试' : '')
    + (n.deadUrls ? '；' + n.deadUrls + ' 条临时视频地址已清空' : '')
    + (rebound ? '；' + rebound + ' 份本机素材已按旧号认回，不用重新导入' : '')
    + (rebindOmitted ? '；另有 ' + rebindOmitted + ' 条素材线索超出单次重绑上限，再导入一次或刷新后可继续认回' : '')
    + (rebindErr ? '；本机素材重绑没成（' + esc(rebindErr) + '），视频拷进资产库后刷新一次' : '')
    + (n.mediaDropped ? '；' + esc(n.mediaDropped) : '')
    + (n.skipped ? '；' + n.skipped + ' 部内容与本机一致已跳过（'
      + esc(n.skippedNames.join('、')) + '）' : '')
    + (n.renamed ? '；' + n.renamed + ' 部短片因重名加了「（导入）」后缀' : '');
  setStatus('<span class="ok">✓ 已导入 ' + prep.items.length + ' 部短片（' + desc.shots + ' 镜 / '
    + desc.candidates + ' 条候选 / ' + desc.prompts + ' 段提示词），现有项目一部都没动' + tail + '</span>');
};
$('projSwitch').onclick = e => {
  e.stopPropagation();
  const menu = $('projMenu');
  const willHide = !menu.hidden;
  /* 收与开都从干净的一屏开始：编辑中的那一格、摊开的移组与追问都跟着菜单一起消失。 */
  clearProjMenuStates();
  if (window.Dropdowns) window.Dropdowns.closeAll();
  if (!willHide) renderProjMenu();
  menu.hidden = willHide;
};
document.addEventListener('click', e => {
  /* 判内外不能看 `e.target`：菜单里的每一步都会整栏重画，事件派发到 document 时那个目标
     多半已经从文档上摘下来了，`menu.contains(target)` 于是答「在外面」—— 点「新建项目组」
     会连菜单一起收掉（草稿行画了、人却看不见，更没法输入）。
     用派发时算好的整条路径判：它不随节点被摘而变，点在哪就是哪。
     开着的下拉浮层算它自己那一格（它挂在 body 上，只是借个位置画）。 */
  const path = e.composedPath ? e.composedPath() : [];
  const inMenu = path.includes($('projMenu')) || path.includes($('projSwitch'))
    || path.some(n => n && n.classList && n.classList.contains('dd-list') && n.classList.contains('on'));
  if (inMenu) return;
  $('projMenu').hidden = true;
  clearProjMenuStates();
});
/* 左栏「生成全部分镜」下面那条进度条：填充 = 已完成 / 全部。
   状态区唯一的读数就是它，不配文字 —— 不能生成的原因写在按钮的 title 上。 */
function updateBanner() {
  const all = allShots();
  const ready = all.filter(shotReady).length;
  const progBox = $('genAllProg');
  if (!progBox) return;
  progBox.hidden = !all.length;
  const fill = progBox.querySelector('b');
  if (fill) fill.style.width = (all.length ? Math.round(ready / all.length * 100) : 0) + '%';
}
/* 「就地二次确认」全站**只有 web/ui/ui.js 的 Confirm.arm 一份**。
   这一页以前自建了一个 armConfirm：没有后果说明、Esc 不取消、点别处不取消、窗口只有 2.5 秒，
   而且没有「整页同时只有一个确认中」—— 可以同时点亮两颗删除按钮，
   用户点下第一颗之后才点第二颗，**两颗一起执行**。
   四个调用点已全部改调 Confirm.arm，这个函数不再需要。 */

/* 在指定场景末尾新建镜头并立刻进入编辑状态 */
function addShotToScene(sc, idx) {
  const sh = newShot();
  setTimeout(() => { const ta = $('edPrompt'); if (ta) { ta.scrollIntoView({ block: 'nearest' }); window.focusQuiet(ta); ta.select(); } }, 120);
  const at = idx == null ? sc.shots.length : idx;
  sc.shots.splice(at, 0, sh);
  proj.curScene = proj.scenes.indexOf(sc);
  proj.curShot = at;
  /* 场景图在 renderAll 之前就带上：右栏那排参考图格子画的就是「已经带上了」的那一份。
     带不上（型号不收参考图 / 已选首尾帧 / 超上限）也要说 —— 界面写着「新镜头自带场景图」而提交是干净的，
     是本项目反复拦的那一类。 */
  reportScenePics(feedScenePics(sc, [sh]));
  renderAll(); scheduleSave();
  const ta = $('edPrompt');
  if (ta) { ta.scrollIntoView({ block: 'nearest' }); window.focusQuiet(ta); }
}
/* 顶部横幅只在出错 / 异常时出现（常驻、不会被错过）；普通提示走右下角 Toast。
   以前这里把「非错误」的消息直接丢掉，于是「已定位到 8.2 秒」「✓ 已按镜头重建时间线」
   这类中性反馈永远不会出现在界面上（调用方传了，用户看不到）。现在它们至少会弹一下。 */
let opStateTimer = null;
/* 顶部横幅**只报错**：出现后一直留着，直到点「×」关掉或被新的错误替换 ——
   不自动消失，免得正在看别处时错过。
   普通提示（「已定位到 8.2 秒」「✓ 已采用这条」这种）走工具栏那行小字，不弹任何浮层：
   以前它们既被丢掉、后来又改成弹 Toast，都会打扰操作。 */
function setStatus(t) {
  const html = window.sanitizeHTML(String(t == null ? '' : t)).trim();
  if (!html) return;                       // 空调用不再顺手收起错误横幅（错误要留在屏幕上）
  const errRe = /class="err"|失败|错误|异常|无法|超时|中断|出错/;
  if (errRe.test(html) || /class="warn"/.test(html)) {
    /* 横幅本身（元素、.msg/.bx 结构、关闭按钮、样式）归 web/ui/ui.js 的 ErrBanner + ui.css 那一份，
       本页只留「什么算错误」这条页面私有的路由判据。 */
    ErrBanner.show(html, errRe.test(html) ? 'err' : 'warn');
    return;
  }
  const el = $('opState');
  if (!el) return;
  el.textContent = html.replace(/<[^>]*>/g, '').trim();
  el.classList.toggle('ok', /^[✓✔]/.test(el.textContent) || /class="ok"/.test(html));
  el.classList.add('show');
  clearTimeout(opStateTimer);
  opStateTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* ---------- 工具栏事件 ---------- */
$('addScene').onclick = () => {
  const sc = { id: uid(), name: `场景 ${proj.scenes.length + 1}`, shots: [newShot()] };
  proj.scenes.push(sc); proj.curScene = proj.scenes.length - 1; proj.curShot = 0;
  reportScenePics(feedScenePics(sc, sc.shots));   // 场景名恰好对得上素材库那条场景时，第一个镜头就带上它的图
  renderAll(); scheduleSave();
};
/* 「剧本」这一档不是第二份数据：打开时按当前分镜现算（scriptTextOf），保存时只把解析结果写回
   `sh.prompt`（applyScript）。稿子里只有画面那一项 —— 台词另有自己的面板（剪辑右栏「台词」那一档），
   一份稿子同时握着画面与台词，改画面就会连着改台词，那是两件事。 */
function editScript() {
  if (!allShots().length) {
    setStatus('<span class="err">还没有镜头：先在左侧加一场，或用「拆分镜」写一份分镜</span>');
    return;
  }
  let ta = null, errEl = null;
  UiDialog.open({
    id: 'scriptEditDlg',
    title: '剧本',
    sub: '逐镜一段「画面」；台词在剪辑右栏「台词」那一档改。',
    body(el) {
      el.innerHTML = '<textarea class="ui-ta" spellcheck="false" aria-label="剧本正文"'
        + ' style="height:min(58vh,560px);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size: var(--fs-13);line-height:1.65"></textarea>'
        + '<div role="alert" style="display:none;color:var(--err);font-size: var(--fs-12);line-height:1.6;margin-top: var(--sp-8)"></div>';
      ta = el.querySelector('textarea');
      errEl = el.querySelector('[role="alert"]');
      ta.value = scriptTextOf(proj.scenes);
    },
    actions: [
      { label: '取消', value: null },
      { label: '保存', primary: true, onClick() {
        const parsed = parseScript(ta.value);
        if (!parsed.blocks.length) {
          errEl.style.display = '';
          errEl.textContent = '没认出任何「## 镜头 N」：请保留每段的镜头标题，只改它下面那段「画面：」。';
          return false;
        }
        /* 先在镜头副本上试跑一次：一个字都没变时不该压一份撤销快照、也不该让撤销键凭空多一步。 */
        const probe = applyScript(proj.scenes.map(sc => ({ ...sc, shots: (sc.shots || []).map(sh => ({ ...sh })) })), parsed);
        if (!probe.upd) {
          setStatus(probe.skipped ? '剧本里没有可写入的改动（' + probe.skipped + ' 个镜头号对不上）' : '剧本没有改动');
          return;
        }
        beginEdit('改剧本');
        const r = applyScript(proj.scenes, parsed);
        filmEdited();
        setStatus('<span class="ok">✓ 剧本已写回分镜：画面 ' + r.promptUpd + ' 处'
          + (r.skipped ? '；' + r.skipped + ' 个镜头号对不上，已跳过' : '') + '</span>');
        if (r.skipped) Toast.warn(r.skipped + ' 个镜头号在分镜里不存在，那几段没有写入');
      } },
    ],
  });
}
$('scriptEditBtn').onclick = editScript;
/* 「导入视频 / 素材」的唯一入口在中栏动作行（`#importMid`，由 engine/mid.js 每轮重建时绑回来）；
   同一个函数只有这一个入口 —— 以前左栏表头一颗、中栏一颗，用户点名过位置乱。 */
$('scriptBtn').onclick = async () => {
  // 升级：优先走 AI 拆分场景与镜头；没配文字 AI 时回退到原来的手动拆分
  try {
    if (await TextAI.canRun(REG)) { aiStoryboard(); return; }
  } catch { /* 问不动文字 AI 就当没配，回退到手动拆分 */ }
  setStatus('未配置文字 AI 密钥，改用「手动拆分」：每行一个镜头，# 开头为场景名');
  $('scriptDlg').showModal();
};
$('scriptCancel').onclick = () => $('scriptDlg').close();
$('scriptOk').onclick = () => {
  const text = $('scriptText').value.trim();
  if (!text) return $('scriptDlg').close();
  /* 一行 `#` 就是**换场**：以前每个 `#` 都只是给同一个场景改名（后面的盖掉前面的），
     粘三段场景进去出来还是一整场，而界面那句话写的是「# 开头为场景名」——
     说的话与做的事不是同一件。 */
  const out = [];
  let sc = { id: uid(), name: '剧本分镜', shots: [] };
  out.push(sc);
  text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    if (line.startsWith('#')) {
      const nm = line.slice(1).trim();
      /* 这一场还一个镜头都没有 → 给它改名，不再另起一场（粘贴内容第一行就是 `#` 时，
         否则会留一个空的「剧本分镜」排在最前面）。 */
      if (!sc.shots.length) { sc.name = nm || sc.name; return; }
      sc = { id: uid(), name: nm || '剧本分镜', shots: [] }; out.push(sc); return;
    }
    sc.shots.push(newShot(line));
  });
  const filled = out.filter(x => x.shots.length);
  /* 落点与「AI 分镜 → 追加」同一份判据（placeScenesInto）：同名（归一之后）的并进已有那一场，
     对不上号的才新建 —— 手动粘两遍同一个场景名不该出现两个「河岸」。 */
  const nShots = filled.reduce((a, x) => a + x.shots.length, 0);
  const r0 = placeScenesInto(proj.scenes, filled);
  if (filled.length) { proj.curScene = r0.at; proj.curShot = 0; }
  renderAll(); scheduleSave(); $('scriptDlg').close();
  reportScenePics(r0.pics, '已写入 ' + filled.length + ' 个场景 / ' + nShots + ' 个镜头'
    + (r0.merged ? '（其中 ' + r0.merged + ' 个并进了同名场景）' : ''));
};
/* 批量生成：所有「还没真正生成过」的镜头一起提交（并发，不再一镜一镜排队等）
   注意筛选条件是「没有非草稿候选」而不是「没有候选」——新建镜头默认带一条 draft 占位，
   按后者判断的话每个新镜头都算「已有候选」，这个按钮就永远点不动了。 */
const hasRealCandidate = sh => (sh.candidates || []).some(c => c && c.status !== 'draft');
/* 生成域（engine/gen.js）：分镜提交、平台轮询、自动镜像与「生成全部分镜」的批量调度。
   这里只把引擎的读写口递进去；轮询器、壳缓存、批次与等待表都由那一份自己持有。
   放在这一段（而不是原来 4359 那个位置）是因为访问器要读的 const 到这里才全部初始化完，
   早一步建包就撞上 TDZ（临时死区）—— 建包时读到的 const 还没值。 */
const Gen = createGen({
  videoPlanOf: (...a) => videoPlanOf(...a),
  $, canStatus, uid, mkCandidateBase, allShots, curScene, ensureChainModel, chainWaitWhy,
  resolveChainFrame, scheduleSave, dlStage, assetStoreId, sameAssetSpace, loadCredits,
  updateMidLive, sortCandidates, provById, saveScheduleSoft, renderScenesSoon, curDraftCand,
  applyRefSyntax, refTokenize, resolvedModel, ROLE_ZH, comboLabel, shotUsedRoles, shotCombo,
  shotInputCaps, shotAdvCtx, shotAdvExtras, shotKeyframes, shotInputEntries, NO_PROMPT_WHY,
  shotBlockReason, provOf, needProv, shotQuote, renderAll, updateProjUI,
  updateBanner, setStatus, hasRealCandidate, projOf: () => proj, wsOf: () => WS, regOf: () => REG,
  setForceMid: v => { forceMid = v; }, setSelectedCandidate,
  renderSoft, addKeyframeToRefs, kfModelOf, Panel, BoardAssetsOf: () => BoardAssets,
});

$('genAll').onclick = async () => {
  const runProj = proj;
  const plan = Gen.genAllPlan();
  if (!plan.ok.length && !plan.wait.length) {
    if (!plan.todo.length) {
      setStatus('<span class="err">所有镜头已有结果</span>');
    } else {
      const first = plan.bad[0] ? (plan.bad[0].name || '未命名镜头') + '：' + plan.badWhy.get(plan.bad[0]) : '';
      setStatus('<span class="err">这些镜头还不能生成' + (first ? '（' + first + '）' : '') + '</span>');
    }
    return;
  }
  $('genAll').disabled = true;
  try {
    const q = await Gen.genAllQuote(plan, { fresh: true });
    if (proj !== runProj || WS.curId !== runProj.id) return;
    if (!(await Gen.genAllConfirm(plan, q))) return;
    if (proj !== runProj || WS.curId !== runProj.id) { Toast.warn('短片切走了，这一批没有开始'); return; }
    await Gen.runGenAll(plan);
  } catch (e) {
    setStatus('<span class="err">批量生成没能开始：' + esc(errText(e)) + '</span>');
  } finally {
    $('genAll').disabled = false;
    Gen.refreshGenAllBtn();
  }
};
/* 导出域（engine/export.js）：成片指纹与导出 / FCPXML / 工程目录。
   这里只把引擎的读写口递进去；导出状态（渲染中 / 取消）由那一份自己持有。
   时间线不再从这里递：`filmOf` 给出唯一的那份成片模型，段表由导出域自己按 `deriveTimeline` 现算，
   FCPXML 读同一份 `buildRenderPlan()` —— 递一堆折算口进去迟早和成片各说各话。 */
const Export = createExport({
  $, setStatus, projOf: () => proj, allShots, filmOf: () => ensureFilm(), clipNameOf: filmClipName,
  fmtDur, filmSize, saveBlob, scheduleSave, healStaleUrls, BoardAssetsOf: () => BoardAssets,
});
/* 页头那一排导出按钮由格式表现画现绑（web/domain/export-formats.js）：加一种导出不再动模板与这一排。
   绑定也只有这一处：剪辑栏每 3 秒随整列重建，把出口绑在那里等于每次重建都要重绑，
   导出中写在按钮上的那句「取消渲染 45%」会被下一次重画冲掉。
   **「播放成片」那一颗已删**：看效果走剪辑态那条轨的实时预览（`#pbBtn` → Play），
   它从不为播放合成；要一个文件才点这里的「导出成片」。 */
/* 每个 kind 给一个「返回点击处理器」的工厂：film 直接交现成函数，
   xml 按这一行是裸 FCPXML、媒体包 zip 还是持久工程目录现包一个（三档同一份拼装器）。 */
const EXPORT_RUN = {
  film: () => Export.filmClick,
  xml: f => f.project ? () => Export.project()
    : () => Export.fcp({ bundle: !!f.bundle }),
};
/* 页头导出区只有一颗**拆分按钮**：主钮「导出成片」（表里第一行），尾部 chevron 的浮层里
   收其余去向（FCPXML / 媒体包 / 工程目录）—— 同一份时间线不用平铺四颗按钮。 */
const expFirst = ExportFormats.list()[0];
$('exportBtns').innerHTML = '<span class="exp-split">'
  + '<button type="button" class="pri" id="' + expFirst.button + '" title="' + esc(expFirst.title) + '">'
  + icon(expFirst.icon, 13) + ' ' + esc(expFirst.label) + '</button>'
  + '<button type="button" class="pri exp-more" id="exportMore" title="其它导出方式">'
  + icon('chevronDown', 12) + '</button>'
  + '<span class="exp-menu" id="exportMenu" hidden></span></span>';
$('exportMenu').innerHTML = ExportFormats.list().slice(1).map(f =>
  '<button type="button" id="' + f.button + '" title="' + esc(f.title) + '">'
  + esc(f.label) + '</button>').join('');
ExportFormats.list().forEach(f => {
  const b = $(f.button);
  if (b) b.onclick = EXPORT_RUN[f.kind](f);
});
{
  const menu = $('exportMenu');
  const more = $('exportMore');
  const dismissMenu = () => { menu.hidden = true; };
  more.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('button')) dismissMenu();
  });
  document.addEventListener('click', dismissMenu);
}
$('importMediaFile').onchange = e => {
  const f = e.target && e.target.files && e.target.files[0];
  if (e.target) e.target.value = '';       // 同一份文件再选一次也要能触发 change
  if (f) importMediaFile(f);
};
/* 轨道坞的高度：走**公共件 Wb.split 的上下轴**（与左右栏同一套把手 —— 同样的外观、
   悬停光标、双击复位、落盘口径），不再手写第二套指针拖动。
   拖动改的是 --dock-h（落在 .page-main 上）：坞高**就是那个数**（flex-basis），
   上面三栏被顶矮 —— 这就是「像左右栏一样能移并且影响布局」的那一条。
   ⚠ 变量名必须是 'dock-h'：Wb.split 写的是 '--' + varName，写成 dock_h 会落到 --dock_h 上，
   而 CSS 读的是 --dock-h —— 两边对不上号时把手看着能拖、坞却纹丝不动（存的值还越拖越偏）。
   旧键 dir_dock_h 是那套手写把手留下的（一个裸数字），那份是真生效过的，迁移期读出来按同样意思用一次就清掉；
   同一份记录里的 dock_h 一并作废：那是写错变量名那版存下来的死值，从来没生效过 ——
   用户没见过的尺寸不算偏好，留着会在修好之后突然把坞顶高一截。 */
{
  const old = Number(window.LS.get('dir_dock_h')) || 0;
  const rec = (function () { const r = window.LS.json('dir_dock', null); return (r && typeof r === 'object') ? r : {}; })();
  delete rec.dock_h;                       // 写错变量名那版留下的死值：作废
  if (old >= 120) rec['dock-h'] = old;     // 手写把手那版是真生效过的，搬过来
  try { window.LS.set('dir_dock', JSON.stringify(rec)); } catch (e) { /* 写不进去就用默认值 */ }
  window.LS.del('dir_dock_h');
  Wb.split.enable({
    box: '.page-main', axis: 'y', key: 'dir_dock',
    cols: [{ el: '#tlBoard' }],
    /* 下限放到 48：允许一路拖到底、把轨道整块「盖住」（只剩一条抓手），
       想看回来再往上拖 —— 用户点名的「轨道栏应该能拖到最底下」。 */
    handles: [{ left: 0, right: 0, resize: 0, varName: 'dock-h', min: 48, max: 720 }],
  });
}

/* ---------- 灯箱：DOM 与翻页/键盘/关闭/信息条全在 Wb.lightbox，页面只声明怎么取地址 ---------- */
Wb.lightbox.init({
  /* 本页没有列表视图：翻页范围由打开灯箱那一次自己带（`Wb.lightbox.open(item, pages)`）。 */
  list: () => [],
  keyOf: it => (it && it.src) || '',
  srcOf: it => (it && it.src) || '',
  kindOf: it => (it && it.video ? 'video' : 'image'),
  nameOf: it => window.fileSafe((it && it.label) || 'merged', 60) + '.mp4',
  info: it => [(it && it.label) || ''],
});

/* ---------- 数据消毒：修复中途写入的不完整工作区 ---------- */
function sanitize() {
  WS.projects = (WS.projects || []).filter(p => p && typeof p === 'object');
  if (!WS.projects.length) {
    WS.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  /* 项目组：老工作区没有这一项 → 空表；组 id 重复 / 项目指向不存在的组 → 归未分组。
     归未分组而不是删项目：组没了不该连作品一起没。 */
  if (!Array.isArray(WS.groups)) WS.groups = [];
  WS.groups = WS.groups.filter(g => g && g.id && String(g.name || '').trim());
  const gids = new Set(WS.groups.map(g => g.id));
  WS.projects.forEach(p => { if (p.groupId && !gids.has(p.groupId)) p.groupId = ''; });
  WS.projects.forEach(p => {
    p.id = p.id || uid();
    p.name = p.name || '未命名短片';
    /* 成片模型（新剪辑核）：旧工程没有这一项就是一张空片 —— 没有迁移、没有版本号，
       旧键（c.segs / proj.timeline / proj.voices…）任何一个字节都不读。 */
    p.film = normalizeFilm(p.film);
    /* `tlTab` 是「本镜 / 全片」两个页签留下的字段：剪辑态只剩成片那一轨，再没有任何一处读它。
       留着的话下一次编辑的快照里还带着这一枚死值（`sanitize` 之后没人清它），所以在这里抹掉 ——
       与上面 `composition` 坏值「直接删掉」同一族处理。 */
    delete p.tlTab;
    /* 画面比例是**一个项目一份**：只认偶数、64–4096 的宽高（编码器要偶数）；
       坏值直接删掉，回落到「按第一条成片的画幅」的旧行为，而不是让编码器到导出时才报错。 */
    if (p.composition) {
      const w = Math.round(Number(p.composition.width)), h = Math.round(Number(p.composition.height));
      if (w >= 64 && h >= 64 && w <= 4096 && h <= 4096 && !(w % 2) && !(h % 2)) p.composition = { width: w, height: h };
      else delete p.composition;
    }
    p.scenes = Array.isArray(p.scenes) ? p.scenes : [];
    if (!p.scenes.length) p.scenes.push({ id: uid(), name: '场景 1', shots: [newShot()] });
    p.scenes.forEach(sc => {
      sc.id = sc.id || uid(); sc.name = sc.name || '场景';
      /* 场景图只认「记得住的」两种写法：本机 dataURL 与 `/asset/<id>`。
         blob:（刷新即失效）与 /getv?url=<签名外链>（一天就 403）都算坏值，直接抹掉 ——
         留着的话这一格画得出来，第二天变一张破图，而新镜头带进参考图的也是那条永远取不回的字串。 */
      const im = typeof sc.img === 'string' ? sc.img : '';
      sc.img = /^(data:|\/asset\/)/.test(im) ? im : '';
      sc.noPic = !!sc.noPic;
      sc.shots = Array.isArray(sc.shots) ? sc.shots : [];
      if (!sc.shots.length) sc.shots.push(newShot());
      sc.shots.forEach(sh => {
        sh.id = sh.id || uid();
        sh.name = sh.name || '新镜头';
        sh.prompt = sh.prompt || '';
        sh.ar = sh.ar || '16:9'; sh.res = sh.res || '768p'; sh.tier = sh.tier || 'fast'; sh.draw = sh.draw || 1;
        sh.refImages = Array.isArray(sh.refImages) ? sh.refImages : [];
        sh.refMeta = Array.isArray(sh.refMeta) ? sh.refMeta : [];
        while (sh.refMeta.length < sh.refImages.length) sh.refMeta.push({ label: null });
        sh.refMeta.length = sh.refImages.length;   // 素材标签与素材图一一对应
        sh.candidates = Array.isArray(sh.candidates) ? sh.candidates : [];
        /* 提交中途刷新页面：占位候选（tmp_*）拿不到任务号、轮询也明确跳过它，
           以前会永远显示「创建中」（video-gen 有对应自愈，导演台没有）。这里按中断结掉，卡上写明可重试。 */
        sh.candidates.forEach(c => {
          if (!c) return;
          /* 旧工程把「这条投过自动镜像」写在候选上（现在改成内存里的 WeakSet）：
             载入时抹掉，别让它继续随工作区与项目文件漂到别的机器上。 */
          delete c._mirrorAnnounced;
          if (c.status === 'creating' && (!c.vid || String(c.vid).startsWith('tmp_'))) {
            c.status = 'failed';
            c.error = c.error || '页面刷新导致创建中断（未拿到任务号），可重新生成这一镜';
          }
        });
        if (sh.model === 'auto') delete sh.model;   // 「自动」模型已下线，回落到默认模型
        /* 接续两个字段只认这两种值：旧工程没有就现算成空串，不迁移、也不留第三种状态。
           `modelAuto` 只在接续还挂着时才有意义（用户取消接续后那一枚自动选的型号照旧留着，
           只是不再需要标「这是程序挑的」）。 */
        sh.linkPrev = sh.linkPrev === 'tail' ? 'tail' : '';
        sh.modelAuto = sh.linkPrev === 'tail' && sh.modelAuto === 'chain' ? 'chain' : '';
      });
    });
  });
  if (!WS.projects.some(p => p.id === WS.curId)) WS.curId = WS.projects[0].id;
  proj = WS.projects.find(p => p.id === WS.curId);
  // 索引兜底到合法范围（老存档里可能是 -1 / 越界：以前删空场景会写坏，这里自愈而不是崩）
  proj.curScene = Math.max(0, Math.min(proj.curScene || 0, proj.scenes.length - 1));
  proj.curShot = Math.max(0, Math.min(proj.curShot || 0, proj.scenes[proj.curScene].shots.length - 1));
  proj.curCand = 0;
}

/* ---------- 启动 ----------
   首屏只等「注册路由 + 本地工作区」（都很快），其余全部后台补齐：
     · 模型能力接口（/models 实测 ~1.2s）→ 到了再刷新右栏参数可选值
     · 本地导入视频的 blob 地址重建      → 完了再重画一次
     · 余额查询、任务轮询                → 各自异步
   以前这些 await 串在首屏之前，导致打开页面有 1~2 秒空白。 */
/* 三栏占比可拖（拖拽条 DOM 与 localStorage 读写都在 workbench.js 的 Wb.split 里）：
   两条拖拽条分别改左栏和右栏，中栏永远吃掉剩下的空间。
   box 传**元素**而不是选择器串：Wb.split 在公共件里用的是真 document，
   文档级 '.layout' 在 KeepAlive 页面池里会命中别的页（工作台也有 .layout）。
   这里 document 是导演台自己的代理 → querySelector 只会落在本页这一块。 */
const dirLayout = document.querySelector('.layout');
if (dirLayout) Wb.split.enable({
  box: dirLayout, key: 'dir_split',
  cols: [{ el: '.col-left' }, { el: '.col-mid' }, { el: '.col-right' }],
  handles: [
    { left: 0, right: 1, resize: 0, varName: 'sp0', min: 198, max: 520 },
    { left: 1, right: 2, resize: 2, varName: 'sp1', min: 298, max: 700 },
  ],
});
(async () => {
  // 注册路由：提供商与模型能力
  try { REG = await Api.registry(); } catch { REG = { providers: [] }; }
  if (window.Api) Api.setRegistry(REG);   // 统一接口层复用同一份注册表
  if (window.Dropdowns) Dropdowns.build(document);   // 弹窗里的静态下拉一次性包装
  // 工作区：多短片
  let ws = await wsKv.get('workspace');
  /* 上一次关标签/刷新时留下的「最后 500ms」同步兜底（见 __spaFlush）：比 IDB 新就用它。 */
  try {
    const u = window.LS.json(K_WS_UNLOAD, null);   // 读坏 / 没有都当没有
    if (u && u.data && Array.isArray(u.data.projects) && u.data.projects.length
      && (!ws || (Number(u.ts) || 0) > (Number(ws.ts) || 0))) {
      ws = u.data;
      await wsKv.put('workspace', ws);
    }
    window.LS.del(K_WS_UNLOAD);
  } catch (e) { /* 写回 IndexedDB 抛错就用内存里那一份继续装配 */ }
  /* 和数据文件（.data/workspace.json）对账：服务器上的更新就用它（换机器 / 清过浏览器缓存时靠这条恢复）*/
  if (window.DataSync) {
    try {
      const srvWs = await DataSync.workspaceFromServer(ws && ws.ts);
      if (srvWs && Array.isArray(srvWs.projects) && srvWs.projects.length) {
        ws = srvWs;
        await wsKv.put('workspace', srvWs);
        setStatus('<span class="ok">✓ 已从本机数据文件恢复工作区</span>');
      }
    } catch (e) { console.warn('[workspace] 数据文件对账失败：', e.message); }
  }
  if (!ws || !Array.isArray(ws.projects)) ws = { projects: [], curId: null, roles: [], groups: [] };
  if (!ws.projects.length) {
    ws.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  /* 项目组：老工作区没有这一项 → 补空表（**零迁移**：现有工程全落未分组）。 */
  if (!Array.isArray(ws.groups)) ws.groups = [];
  WS = { projects: ws.projects, curId: ws.curId && ws.projects.some(p => p.id === ws.curId) ? ws.curId : ws.projects[0].id,
    roles: ws.roles || [], groups: ws.groups };
  proj = WS.projects.find(p => p.id === WS.curId);
  sanitize();
  lastSavedJson = snapOf();    // 撤销栈基线
  wsLoaded = true;             // 从现在起才允许落盘（见 wsLoaded 那段）
  renderAll();                 // 首屏：不等能力接口、不等本地视频、不等余额（页头那一格也跟着刷）
  /* 14.1-6：老工程 refMeta 没 id 的条目按 label 反查库里补 id（幂等，已有 id 的不动）。 */
  try { Panel.backfillRefMetaIds && Panel.backfillRefMetaIds(allShots()); } catch (e) { /* 补不上不影响启动 */ }
  setTimeout(() => Gen.announceDoneCandidates(), 0);   // 已经出画面但还没镜像的候选：投一次事件（不阻塞首屏）
  Gen.pollKick();             // 首屏立刻问一次在途候选，不等第一轮间隔
  Gen.resumeKeyframes().catch(() => {});   // 上次没跑完的画面切片：认回任务或如实标失败
  try { Gen.reconcilePendingPics(); } catch (e) { /* 待建占位补不上不影响启动 */ }
  loadCredits();
  // 后台补齐（都不阻塞首屏）
  Panel.installCapRepaint();   // 一家能力落定就补画一次右栏（实现在 engine/panel.js）
  restoreLocalBlobs().then(() => { try { renderAll(); } catch { /* 首屏重画抛错不打断后面的恢复流程 */ } }).catch(() => {});
  hydrateThumbFrames();        // 上次抽好的缩略图首帧：读出来直接当图片用，不再等视频出画
  healStaleUrls();             // 存过期的签名外链：后台按任务号换新地址并写回工作区
  setTimeout(() => { consumeModelHandoff().catch(() => {}); }, 0);   // 建模台送回来的白膜
})();

/* ---------- 建模台送回来的白膜 ----------
   一次性口袋由 `window.Model3D` 写、这里消费一次。图走「参考图」那一条（addRefImage），
   视频走 pickRefMedia 的 preset 形参（同一段上传 / 登记，只是不弹选择器）——
   两条都是这一页原有的唯一写入口，不新造第三条。 */
async function consumeModelHandoff() {
  const M = window.Model3D;
  if (!M || !M.consume) return;
  let box = null;
  try { box = M.consume('director'); } catch (e) { return; }
  if (!box || !Array.isArray(box.assets) || !box.assets.length) return;
  const sh = (box.shot && (proj.shots || []).find(x => x.id === box.shot)) || curShot();
  if (!sh) { setStatus('<span class="err">白膜送到了，但这一部还没有镜头可挂</span>'); return; }
  let images = 0;
  let videos = 0;
  for (const a of box.assets) {
    const label = String(a.name || '白膜').replace(/\.[^.]+$/, '');
    const src = a.url || a.src;
    if (a.type === 'video') {
      await pickRefMedia(sh, 'refvideo', {
        assetId: a.assetId, src, dl: src, name: a.name, prompt: label,
        type: '视频', duration: null,
      });
      videos += 1;
    } else {
      addRefImage(sh, Api.mediaSrc(src), label, a.assetId || null);
      images += 1;
    }
  }
  renderEditor();
  scheduleSave();
  setStatus('<span class="ok">✓ 白膜已加入这一镜：' + images + ' 张参考图' + (videos ? '、' + videos + ' 段参考视频' : '') + '</span>');
}

/* 外壳的 onActivated 从这里接口袋（这一页在页面池里常驻：引擎只启动一次，
   第二次从建模台回来时不能再指望启动那一段里的 setTimeout）。 */
if (typeof window !== 'undefined') window.__directorModelHandoff = consumeModelHandoff;

/* ============================================================================
   给外壳 / AI 助手的**时间线写入桥**（全项目只有这一份）
   ----------------------------------------------------------------------------
   助手不该靠 DOM 去点轨道上的按钮：那要「先 page_state 找按钮 → 再点」两步，
   而按钮本身还依赖「现在指着哪一块」这种界面态。桥只认**成片秒**（proj.film 的
   start/end 都是它），写只有两条出口 —— Edit.patch（画面段 / 配音）、
   Edit.toolAction（切开 / 删 / 复制 / 融合，与工具条同一批函数）、Caption.*（字幕一族）：
     · select   选一条候选进成片（= 候选上那颗「选用」）→ setSelectedCandidate
     · cut      切开 / 剪头 / 剪尾 / 删段 / 复制 / 融合 → Edit.toolAction
     · set      倍速 / 音量 / 静音 / 行 / 起止 / 滑移 / 滚切点 / 滑动 / 挪位 / 转场 / 字幕
     · undo     撤销 / 重做（Ctrl+Z / Ctrl+Y 的同一份栈）
   规矩：① 只在导演台**前台**可用；② 先 check（纯读）再 run，check 把这次动作的
   **身份**记下来（工程 id + 块 id），run 前按同样的参数重算一遍，身份对不上就拒 ——
   「你读的时候是这一段，动手时已经不是了」；③ 任何写入都在撤销窗口里（用户点完
   执行马上说「撤销」也退得回去）；④ 行锁着的块一律拒绝。
   页面那三条 UI 路径不经过这里 —— 这是给「外壳那一层」的唯一入口，不是第二套剪辑实现。
   ========================================================================== */
/* Bridge域（engine/bridge.js）：这一段搬进模块，这里只留一个访问器包（这一域不交名字回来）。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
createBridge({
  ExportFormats,
  Timeline,
  Edit,
  Caption,
  projOf: () => proj,
  filmOf: () => ensureFilm(),
  allShots: (...a) => allShots(...a),
  /* 改名回填要扫的是**全部短片**的镜头（loadRefUse 数引用也数全片），不是当前这一部。 */
  allProjects: () => (WS && WS.projects) || [],
  scheduleSaveQuiet: () => scheduleSaveQuiet(),
  curScene: (...a) => curScene(...a),
  curShot: (...a) => curShot(...a),
  undoStack: undoStack,
  redoStack: redoStack,
  UNDO_MAX_BYTES: UNDO_MAX_BYTES,
  UNDO_MAX_COUNT: UNDO_MAX_COUNT,
  undoBytesOf: () => historyBytes,
  undoSkipWhyOf: () => undoSkipWhy,
  newestHistoryLabelOf: () => historyNewestLabel(),
  undo: (...a) => undo(...a),
  redo: (...a) => redo(...a),
  candDur: (...a) => candDur(...a),
  setSelectedCandidate,
  candTrackSrc: (...a) => candTrackSrc(...a),
  mediaInfo: (...a) => mediaInfo(...a),
  renderAll: (...a) => renderAll(...a),
  setStatus: (...a) => setStatus(...a),
  Export: Export,
}, document, window);

}
