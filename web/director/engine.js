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
import { createScript } from './engine/script.js';
import { createSplit } from './engine/split.js';
import { createRender } from './engine/render.js';
import { createApi } from './engine/api.js';
import { createImport } from './engine/import.js';
import { createRef } from './engine/ref.js';
import { createEstimate } from './engine/estimate.js';
import { createShell } from './engine/shell.js';
import { createProjectFile } from './engine/projectfile.js';
import { createModelHandoff } from './engine/modelhandoff.js';
import { createSanitize } from './engine/sanitize.js';
import { createMedia } from './engine/media.js';
import { createToolbar } from './engine/toolbar.js';
import { createExportWire } from './engine/exportwire.js';
import { createBoot } from './engine/boot.js';
import { createShots } from './engine/shots.js';
import { parseJsonLoose, round1, pct, num, BOARD_CTX_PROMPT, BOARD_CTX_SHORT } from './util.js';

import { scriptTextOf, parseScript, applyScript } from './script.js';

import { createBoardTools } from './board.js';

import { chainDeps, splitLongShots, chainModelRepick, hasTailFrame, isRunning } from './chain.js';

import { createSplitAssets } from './split-assets.js';

import { createGroups } from './groups.js';

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

/* 拆分镜的「新素材」落盘：建档 + 占位符 —— 判据全在 web/director/board-assets.js，engine 只调用。
   ① 建档：写进素材库，组名 = 当前短片所在的项目组名（组名即素材组名，见 groups.js）。
      判据复用 `Chars.Lib.save`（同类型 + 同名 = 同一条），不另写一份写库。
   ② 占位符：素材刚建档时**还没有图**，所以提示词里先写 `@待建:小雅`（占位），
      出图之后再换成 `@小雅`（真名）并把图挂成参考图。
      这样「这一镜该引用谁」在出图前就是看得见的，出图后自动补上。
   返回 { saved, failed, group, why }：saved 是建成的那些（带库里的那条），
   failed 是没建成的与原因（照实报，不静默丢）。 */
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

/* 镜头与候选工厂域（engine/shots.js）：候选占位字段 / 新镜头 / 本镜时长 / 选用入口
   搬进模块，这里只留接线。proj 走访问器；resolvedModel 是 Panel 的解构结果，
   建包时还没值，包成箭头避开 TDZ。 */
const Shots = createShots({
  projOf: () => proj, resolvedOf: (...a) => resolvedModel(...a), uid,
}, document, window);
const {
  allShots, curScene, curShot, ensureFilm, filmClipName, fmtDur, mkCandidateBase,
  mkDraftCandidate, mkImportedCandidate, newShot, setSelectedCandidate, shotDur, shotDurText, shotReady,
} = Shots;

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
  /* 工具条上那枚「撤销 N/30」就地跟着换：编辑落账不必等下一次整块重画。
     开机早期 Timeline 还没装配（板还没建出来）就跳过，下一次重画自然补上。 */
  try { Timeline.paintTimelineTools(); } catch (e) { /* 同上，不挡历史本身 */ }
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
  /* 工具条那枚撤销读数的真值：可撤销几步 / 上限几步 / 为什么存不下（单份太大或顶到上限）。 */
  undoStateOf: () => ({ n: undoStack.length, max: UNDO_MAX_COUNT, why: undoSkipWhy }),
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


/* Script域（engine/script.js）：AI 分镜的时长口径（型号声明区间 / 给 AI 的约束 / 逐镜夹回）
   搬进模块，这里只留接线。E 里两位都包成箭头：shotModels / videoPlanOf 是 Panel 的解构结果，
   建包时还没初始化，直接引用会撞 TDZ。 */
const Script = createScript({
  shotModels: (...a) => shotModels(...a),
  videoPlanOf: (...a) => videoPlanOf(...a),
}, document, window);
const {
  boardDurNote,
  boardDurSub,
  clampNote,
  clampShotDurations,
  durWritable,
  setShotDur,
  softShotsNote,
} = Script;
/* Split域（engine/split.js）：接续生成（尾帧当首帧）与拆分镜前「这次带哪些素材进来」那一整段
   搬进模块，这里只留接线。E 里那四位是 Panel 的解构结果（右栏建包之后才有值），包成箭头避开 TDZ；
   其余几位在建包这一刻都已就绪，直接递。 */
const Split = createSplit({
  PENDING_PREFIX, allShots, assetToDataURL: (...a) => assetToDataURL(...a), clampShotDurations, durWritable,
  feedScenePics: (...a) => feedScenePics(...a), freshUrl: (...a) => freshUrl(...a),
  newShot, removeShot: (...a) => removeShot(...a), setShotDur, uid,
  addLibPicToShot: (...a) => addLibPicToShot(...a), libPicChoices: (...a) => libPicChoices(...a),
  resolvedModel: (...a) => resolvedModel(...a), shotModels: (...a) => shotModels(...a),
}, document, window);
const {
  SplitAssets, applyBoardPlan, boardListText, boardPlanOf,
  chainModelList, chainModelWhy, chainWaitWhy, ensureChainModel, resolveChainFrame, snapBoard,
} = Split;

/* Apply域（engine/apply.js）：AI 拆分镜与改稿的落盘（新素材建档 + `@待建:` 占位符 + 分镜写入）
   搬进模块，这里只留访问器包与一条解构。
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
  setRenderPending(false); renderScenes(); renderMid();
  if (typingIn('#edCol')) setRenderPending(true); else renderEditor();
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

/* Api域（engine/api.js）：平台调用的小件搬进模块，这里只留接线。
   E 里 resolvedModel 是 Panel 的解构结果，建包时还没值，包成箭头避开 TDZ；
   REG / proj 走访问器，engine 继续持有这两枚可变状态。 */
const ApiDomain = createApi({
  ST_ZH, setStatus,
  regOf: () => REG, projOf: () => proj,
  resolvedModel: (...a) => resolvedModel(...a),
}, document, window);
const {
  assetProvFor, assetStoreId, compressImg, dlStage, loadCredits,
  playerTaskDetails, sameAssetSpace, thumbKey,
} = ApiDomain;
/* Render域（engine/render.js）：候选卡片、渲染左栏与中栏搬进模块，这里只留接线。
   E 里带箭头的每一位都是建包之后才有值的（Panel / Mid / Voice 的解构结果），直接引用会撞 TDZ；
   proj / REG / WS / voiceDraft / vcTab 那几枚可变状态走访问器，engine 继续持有它们。 */
const Render = createRender({
  $, NO_PROMPT_WHY: (...a) => NO_PROMPT_WHY(...a), ST_ZH,
  addLibPicToShot: (...a) => addLibPicToShot(...a), addShotToScene,
  beginEdit, candDur, compressImg, curShot, ensureFilm, filmClipName, filmEdited, fmtDur,
  historyCursorOf: () => historyCursor, historyGoTo, historyLog,
  mkDraftCandidate, newShot,
  paintPromptBox: (...a) => paintPromptBox(...a), playerEmptyText: (...a) => playerEmptyText(...a),
  playerTaskDetails, redo,
  releaseCandUrl: (...a) => releaseCandUrl(...a),
  releaseSceneUrls: (...a) => releaseSceneUrls(...a),
  releaseShotUrls: (...a) => releaseShotUrls(...a),
  renderAll: (...a) => renderAll(...a), renderEditor: (...a) => renderEditor(...a), renderMid: (...a) => renderMid(...a),
  scheduleSave, scheduleSaveQuiet, setSelectedCandidate, setStatus,
  shotDur, shotReady, thumbKey, toDataURL: (...a) => toDataURL(...a), uid, undo,
  updateArBadge: (...a) => updateArBadge(...a), updateProjUI: (...a) => updateProjUI(...a),
  voiceReg: (...a) => voiceReg(...a), voiceWayOf: (...a) => voiceWayOf(...a),
  projOf: () => proj, regOf: () => REG, wsOf: () => WS, MidOf: () => Mid, GenOf: () => Gen,
  voiceDraftOf: () => voiceDraft, vcTabOf: () => vcTab, setVcTab: v => { vcTab = v; },
  Edit, Play, Timeline,
}, document, window);
const {
  addMarkerAt, bindCandActs, bindCandidateStrip, bindPbFull, candActsHTML, candAddTile,
  candPlaceholder,
  candThumbInner, curDraftCand, debounce, feedScenePics, fullscreenHold, generateCandidate,
  healStaleUrls, hydrateThumbFrames, lineVoicedOf, lineVoicesOf, midCandExpandOf, midEditTrimOf,
  openLineVoice, pbBarHTML, placeScenesInto, playerAreaHTML, playerMediaOf, provById, removeShot,
  renderEditLeft, renderScenes, renderScenesSoon, reportScenePics, saveScheduleSoft,
  scrollCurThumbIntoView, selectCandidate, setTrimMode, shotStatusOf, sortCandidates, toolAction,
  transitionSet, updateMidLive,
} = Render;
/* Mid域（engine/mid.js）：中间栏整列（预览甲板 + 候选条 + 动作行 + 总长）与剪辑 / 生成两态的切换
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
  midCandExpandOf,
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
  midEditTrimOf,
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
  midEditTrimOf,
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

/* 成片媒体域（engine/media.js）：签名地址刷新 / 成片尺寸 / 素材编号计划 / 下载转发
   搬进模块，这里只留接线。proj 走访问器；面板与拆分镜装配时拿到的是一枚枚箭头。 */
const Media = createMedia({
  allShots, projOf: () => proj, saveScheduleSoft, shotReady,
}, document, window);
const { applyRefSyntax, chainSlotOf, compositionOf, filmSize, freshUrl, refTokenize, saveBlob } = Media;

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
  midEditTrimOf,
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
  setPolishUI: v => setPolishUI(v),
  renderPolishPanel: (...a) => renderPolishPanel(...a),
  /* 拆分镜 / 改分镜的问答与过程面板（apply 域的状态）：编辑器整列重画后也要按 splitUI 拼回来，
     与上面那颗润色面板同一个重画钩子位（panel.js 的 renderEditor 尾部先后各调一次）。 */
  renderSplitPanel: (...a) => renderSplitPanel(...a),
  polishPrompt: (...a) => polishPrompt(...a),
  toDataURL: (...a) => toDataURL(...a),
  uploadImageDataUrl: (...a) => uploadImageDataUrl(...a),
  openPickDlg: (...a) => openPickDlg(...a),
  setKfQ: v => setKfQ(v),
  kfArOf: () => kfArOf(),
  setKfAr: v => setKfAr(v),
  kfSizeOf: () => kfSizeOf(),
  setKfSize: v => setKfSize(v),
  kfFormatOf: () => kfFormatOf(),
  setKfFormat: v => setKfFormat(v),
  kfParamsSave: (...a) => kfParamsSave(...a),
  kfModelIdOf: () => kfModelIdOf(),
  setKfModelId: v => setKfModelId(v),
  kfRunOf: () => kfRunOf(),
  /* 「拆成几张 / 按什么维度拆」：值与展开态都在这一层（右栏每 3 秒整片重画，DOM 存不住） */
  kfSplitSel: (...a) => kfSplitSel(...a),
  kfSplitSet: (...a) => kfSplitSet(...a),
  kfSplitOpenOf: () => kfSplitOpenOf(),
  setKfSplitOpen: v => setKfSplitOpen(v),
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

/* Import域（engine/import.js）：素材进来的四条路（本机视频 → 本镜候选、第三方素材存本机、
   资产库 / 收藏导入、参考视频 / 参考音频槽位）搬进模块，这里只留接线。
   REG / proj 走访问器；其余几位在建包这一刻都已就绪，直接递。 */
const Import = createImport({
  assetProvFor, assetStoreId, curShot, dlStage, filmEdited, mkImportedCandidate, provOf,
  renderAll: (...a) => renderAll(...a), renderEditor, resolvedModel, sameAssetSpace, scheduleSave, setSelectedCandidate,
  setStatus, shotInputCaps, uid,
  regOf: () => REG, projOf: () => proj,
}, document, window);
const {
  autoLocalize, candTrackSrc, importMediaFile, mediaInfo, needsLocal, openLibDlg, pickRefMedia,
} = Import;

/* Ref域（engine/ref.js）：提示词的 AI 润色、候选 blob 回收 / 重启恢复、选画面 / 参考图槽位
   搬进模块，这里只留接线。REG / WS 走访问器；polishUI 归模块，对外只给 setPolishUI。
   其余几位在建包这一刻都已就绪，直接递。 */
const Ref = createRef({
  $, ROLE_ZH, SLOT_ROLE, addRefImage, allShots, assetStoreId, canAddSlot, chainSlotOf, comboLabel,
  compressImg, curDraftCand, curShot, renderEditor, renderScenes, resolveChainFrame, resolvedModel,
  scheduleSave, setStatus, shotCombo, shotInputCaps, shotRefPlanOf, shotUsedRoles, wsKv,
  regOf: () => REG, wsOf: () => WS,
}, document, window);
const {
  openPickDlg, polishPrompt, releaseCandUrl, releaseSceneUrls, releaseShotUrls,
  renderPolishPanel, restoreLocalBlobs, setPolishUI, toDataURL, uploadImageDataUrl,
} = Ref;

/* Estimate域（engine/estimate.js）：费用预估与画面生成（时间切片）那一整段搬进模块，
   这里只留接线。REG 走访问器；kf* 那批选择值归模块，Panel 经下面那几对读写。
   其余几位在建包这一刻都已就绪，直接递。 */
const Estimate = createEstimate({
  $, addRefImage, allShots, curShot, ensureChainModel, loadCredits, newShot, provOf,
  renderEditor, renderSoft: (...a) => renderSoft(...a), resolvedModel, scheduleSave, setShotDur, setStatus,
  shotAdvCtx, shotAdvExtras, shotInputCaps, shotKeyframes,
  regOf: () => REG,
}, document, window);
const {
  addKeyframeToRefs, assetToDataURL, boardEstimate, genOneImage, generateKeyframes,
  kfAdvSumText, kfArOf, setKfAr, kfExtrasVisible, kfFormatOf, setKfFormat, kfGenOpts,
  kfImgParams, kfModelIdOf, setKfModelId, kfModelOf, kfModelOptions, kfParamsSave,
  kfRefEntries, kfRefMax, kfRunOf, kfSizeOf, setKfSize, kfSplitOpenOf, kfSplitSel,
  kfSplitSet, setKfSplitOpen, paintKfAdv, refreshEst, refreshKfEst, setKfQ, shotQuote,
} = Estimate;

/* Shell域（engine/shell.js）：整屏重画与页头项目菜单搬进模块，这里只留接线。
   proj / WS / Gen 走访问器；renderPending / forceMid 归模块，engine 只经 setter 改。 */
const Shell = createShell({
  $, Groups, exportProjectPack: (...a) => exportProjectPack(...a), newShot,
  pickProjectPack: (...a) => pickProjectPack(...a), refreshEst, releaseCandUrl,
  renderEditor, renderMid, renderScenes, scheduleSave, setStatus, uid, updateBanner, wsKv,
  GenOf: () => Gen, projOf: () => proj, setProj: v => { proj = v; }, wsOf: () => WS,
}, document, window);
const {
  clearProjMenuStates, renderAll, renderProjMenu, renderSoft, setForceMid, setRenderPending,
  switchProject, typingIn, updateProjUI,
} = Shell;
/* 项目文件域（engine/projectfile.js）：导出 / 导入完整工程搬进模块，这里只留接线。
   proj / WS / Gen / wsLoaded 走访问器。 */
const ProjectFile = createProjectFile({
  $, Groups, sanitize: (...a) => sanitize(...a), scheduleSave, setStatus, uid,
  clearProjMenuStates, renderProjMenu, switchProject,
  GenOf: () => Gen, projOf: () => proj, wsOf: () => WS, wsLoadedOf: () => wsLoaded,
}, document, window);
const { exportProjectPack, pickProjectPack } = ProjectFile;
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

/* 工具栏事件域（engine/toolbar.js）：加场景 / 剧本查看与粘贴 / 拆分入口搬进模块，
   这里只留接线（这一域不交名字回来）。proj / REG 走访问器。 */
createToolbar({
  $, REGOf: () => REG, aiStoryboard, allShots, beginEdit, feedScenePics, filmEdited, newShot,
  placeScenesInto, projOf: () => proj, renderAll, reportScenePics, scheduleSave, setStatus, uid,
}, document, window);
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
  setForceMid: v => setForceMid(v), setSelectedCandidate,
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
/* 导出接线域（engine/exportwire.js）：导出拆分按钮 / 导入选择器 / 轨道坞把手 / 灯箱声明
   搬进模块，这里只留接线（这一域不交名字回来）。 */
createExportWire({ $, Export, ExportFormats, importMediaFile }, document, window);

/* 数据消毒域（engine/sanitize.js）：整份工作区进内存前的修复搬进模块，这里只留接线。
   WS / proj 走访问器；上面 ProjectFile 装配时拿到的 sanitize 是一枚箭头，运行到这里才求值。 */
const Sanitize = createSanitize({
  newShot, projOf: () => proj, setProj: v => { proj = v; }, uid, wsOf: () => WS,
}, document, window);
const { sanitize } = Sanitize;

/* 启动域（engine/boot.js）：注册表 / 工作区读回与首屏后的后台补齐搬进模块，这里只留接线。
   REG / WS / proj / lastSavedJson / wsLoaded 走 getter / setter；consumeModelHandoff 的装配
   在本段之后，启动那一趟的 setTimeout 经箭头迟取。 */
createBoot({
  Gen, K_WS_UNLOAD, Panel, allShots, consumeModelHandoff: (...a) => consumeModelHandoff(...a),
  healStaleUrls, hydrateThumbFrames, loadCredits, newShot, projOf: () => proj, regOf: () => REG,
  renderAll, restoreLocalBlobs, sanitize, setLastSavedJson: v => { lastSavedJson = v; },
  setProj: v => { proj = v; }, setReg: v => { REG = v; }, setStatus,
  setWs: v => { WS = v; }, setWsLoaded: v => { wsLoaded = v; }, snapOf, uid, wsKv,
  wsOf: () => WS,
}, document, window);

/* 白膜回传域（engine/modelhandoff.js）：建模台送回来的白膜挂进这一镜。
   启动那一段的 setTimeout 经下面这枚 const 调用，外壳钩子同理。 */
const ModelHandoff = createModelHandoff({
  addRefImage, curShot, pickRefMedia, renderEditor, scheduleSave, setStatus, projOf: () => proj,
}, document, window);
const { consumeModelHandoff } = ModelHandoff;

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
