/* 导演台引擎：原 fragment.html 的内联脚本整体搬进模块，document / window 是页面作用域岛的两份代理。
   这样它可以被 node --check 静态检查；模板在开发期预编译（tools/precompile-vue.cjs），
   运行时没有 new Function，严格 CSP 不需要 unsafe-eval。 */
import { createExport } from './engine/export.js';
import { createGen } from './engine/gen.js';
import { createVoiceLane} from './engine/voice-lane.js';
import { createApply} from './engine/apply.js';
import { createMid} from './engine/mid.js';
import { createFrames} from './engine/frames.js';
import { createVoice} from './engine/voice.js';
import { createBridge} from './engine/bridge.js';
import { createLanes} from './engine/lanes.js';
import { createSubLane } from './engine/sub-lane.js';
import { createPanel} from './engine/panel.js';
import { createTrack} from './engine/track.js';
import { parseFCPXML } from './fcpxml-import.js';
import { parseJsonLoose, round1, round2, pct, spdTxt, ctxClip, reEscape, BOARD_CTX_PROMPT, BOARD_CTX_SHORT } from './util.js';

import { speakerOf, lineTimeOf, lineRowHTML } from './lines.js';

import { scriptTextOf, parseScript, applyScript } from './script.js';

import { createBoardTools } from './board.js';

import { shotPlacement, chainDeps, splitLongShots, pickChainModel, quoteKeyOf, sumQuotes, runWithDeps, hasTailFrame, isRunning } from './chain.js';

import { createSplitAssets } from './split-assets.js';

import { createBoardPreview } from './board-preview.js';

import { createGroups } from './groups.js';

import { createBoardAssets } from './board-assets.js';

import { createBoardVars } from './board-vars.js';

import { candidateBase, voiceBase, shotCtxOf, candidateIndex, voiceIndex } from './naming.js';

import { SLICE_TILE_PX, SLICE_N_MAX, sliceGeom, sliceBoxHTML, sliceTimes, snapSliceStep } from './slice.js';

import { createTimeline } from './timeline.js';

import { createPlayback } from './playback.js';

import { SEG_MIN, segLen, segVol, segSpd, segFilmLen, segCarry, segsOf, segsFilmLen, segsCopy, segsWrite, TRACK_LANES_MAX, laneClamp, picLnOf, tlClipDur } from './segments.js';

import { isImageSeg, isVirtualSeg } from './image-seg.js';

import { voiceRateOf, voiceFrameOf, roundVoice, voiceRuns, rowSelIn, rowSelOut, makeVoiceAxBox, createVoiceFilm, lineEstSec, lineSpanAt, VOICE_SPD_MIN, VOICE_SPD_MAX } from './voice-layout.js';

import { chosenCandOf, currentOf, entriesFromShot, sourceHashOf, styleOf, setStyle, srtParse, srtSerialize,
  resegment, filmOf, mapToFilm, mapToShot, mapFromFilm, entryAt, overlayHTML, filmEntriesOf } from './subtitles.js';

import { createPlayPlan } from './plan.js';

import { createWaveform } from './waveform.js';

import { createProjection } from './projection.js';

import { voiceBlockLabel, voiceBlockText, createVoiceBlockRenderer } from './voice-block.js';

/* 生成工作台「加到时间线」→ 导演台：两页是同一份文档，载荷经本机存储递**一次**。
   写入在 `web/pages/studio.js`（图片产物卡），取走由页面壳在挂载完成与每次激活时调
   `consumeAddedImage()`；真正的落点还是 `addImageToTrack`（拖进画面轨走同一枚）。
   本机存储也没有别的跨页通道：导演台模块是动态 import 的，页面壳拿不到它的闭包。 */
const ADDED_IMAGE_KEY = 'dir_add_img';
let takeAddedImage = null;
export function consumeAddedImage() {
  if (!takeAddedImage || !window.LS) return false;
  const spec = window.LS.json(ADDED_IMAGE_KEY);
  if (!spec || !spec.src) return false;
  window.LS.del(ADDED_IMAGE_KEY);
  takeAddedImage(spec);
  return true;
}

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

/* 剪辑态播放层（两个甲板接力 + 配音按成片绝对时间起播）。
   媒体地址照样只走 Api.mediaSrc，播放这一层不另判平台。 */
const { playSafe, TlPlay } = createPlayback({ mediaSrc: s => Api.mediaSrc(s) });

/* ---------- 常量 ---------- */
/* 档位 / 比例 / 格式的中文名表不在这里抄第二份：在 `gen-forms.js` 的 `AdvParams`（工作台与导演台同一份）。 */
const ST_ZH = Wb.ST;   // 状态文案只有 workbench.js 那一份（含各家平台的同义词）
/* 这一页自己的候选状态词只有 draft / creating / queued / running / succeeded / failed / cancelled，
   而轮询拿回来的是平台原话（success / completed / done / processing…）。写回之前先归一化：
   否则「已完成」在这一页会被当成还在跑 —— shotReady、候选排序、缩略图、「用这条」按钮全按
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
   IndexedDB 与 .data/workspace.json 一起盖掉（AGENTS §6.2「读不出来绝不等于本来就没有」的同一类）。
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
       不进配音轨、也不是 `proj.voices` 的字段，与 `line` 一样是「还没合成的那句话」的附属信息。 */
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
const curScene = () => (proj ? proj.scenes[proj.curScene] || proj.scenes[0] : null);
const curShot = () => curScene()?.shots[proj.curShot];
const fmtDur = s => (Math.round(s * 10) / 10) + ' 秒';
const shotDur = sh => {
  const c = sh.candidates.find(c => c.vid === sh.selId) || sh.candidates.find(c => c.status === 'succeeded');
  if (!c) return 0;
  /* 多段：按段求和（切开之后这一镜在成片里就是这几段之和，不是「首段入点到末段出点」）。
     问的是**成片秒**那一份（选区 ÷ 倍速）：这一项进的是左栏镜头时长与顶上那句「全片 X 秒」，
     倍速把时间改了，这两处读数就得跟着变 —— 否则「轨道缩了一半而那句还说 12 秒」。 */
  if (Array.isArray(c.segs)) return round1(segsFilmLen(c, candDur(c, sh)));
  if (c.trimE != null) return Math.max(0, c.trimE - (c.trimS || 0));
  if (c.duration) return c.duration;
  if (c.url) return sh.duration || 5;
  return 0;   // 还没出画面：不显示假时长
};
/* 本镜时长文案：没生成就写「未生成」 */
const shotDurText = sh => { const d = shotDur(sh); return d ? fmtDur(d) : '未生成'; };
/* 裁剪落地之后那一句（两个入口共用）—— **必须说清这一条在不在成片里**。
   剪辑这段改的是「我现在正在看的那条候选」（curCand），
   而左栏镜头时长、工具条「全片 X 秒」算的是「已选用的那条」（selId）。
   两者不是同一条时，一句光秃秃的「✓ 已保留 3 秒」会让人以为成片短了 2 秒 ——
   去看成片却发现一点没变（还是第 1 条那 5 秒），于是以为这个功能坏了。 */
function trimStatus(sh, c, extra) {
  /* 秒数按「剪辑界面正指着的那一段」算，不按 trimS/trimE 的并集算：
     切开之后一镜可能有几段，说「已保留 8 秒」而格子里明明是两段各 3 秒，等于说一句对不上画面的话。 */
  const segN = curSegOf(sh, c);
  const sec = segN ? fmtDur(segLen(segN)) : '0 秒';
  const nSeg = (c && Array.isArray(c.segs)) ? c.segs.length : 1;
  const inFilm = !!(c && c.vid === sh.selId);
  const at = (sh.candidates || []).findIndex(x => x.vid === sh.selId);
  const tail = inFilm ? '（这一条正被选用，成片跟着变）'
    : '，但这一条还没被选用 —— 成片现在用的是' + (at >= 0 ? '第 ' + (at + 1) + ' 条' : '别的候选')
      + '，左栏时长与「全片」的秒数都按它算；要让这次裁剪进成片，先在这一条上点「用这条」';
  /* 「截断」是真出了事（我们改了你输了的值），照旧走横幅；其余走工具栏那行小字 ——
     这里**不能用 warn 类**：那会把顶部横幅点亮，而拖动裁剪是每拖一下都会发生的高频动作，
     一个常驻横幅会变成噪音（用户上次特意说过「除非出 bug 不要弹东西」）。 */
  const many = nSeg > 1 ? '（这一条现在有 ' + nSeg + ' 段）' : '';
  if (extra) return '<span class="err">' + extra + '；已保留 ' + sec + many + (inFilm ? tail : '') + '</span>';
  return inFilm ? '<span class="ok">✓ 已保留 ' + sec + many + tail + '</span>' : '已保留 ' + sec + many + tail;
}
const shotReady = sh => sh.selId && sh.candidates.some(c => c.vid === sh.selId && c.status === 'succeeded');
const totalDur = () => allShots().filter(shotReady).reduce((a, sh) => a + shotDur(sh), 0);

/* ---------- 持久化（IndexedDB）----------
   开库、缺仓库补建、连接复用全在 web/ui/ui.js 的 Kv 里（本页以前自己写过一份最完整的，
   现在设置页 / 资产库页 / 保存落点用的是同一份）。库/表名也不在这里抄：
   Kv.at('ws') = 导演台工作区与本地视频。 */
const wsKv = Kv.at('ws');
/* ---------- 撤销 / 重做（快照式，Ctrl+Z / Ctrl+Y）---------- */
const undoStack = [], redoStack = [];
let lastSavedJson = '';
/* 快照是整份工作区 JSON（含内联图片），必须限总量：以前无上限保留 50 份，大工程会吃掉上百 MB 内存。
   **两档上限都不在界面上**（README 与项目介绍曾写「最多 50 步」，实际是 30 步 / 24 MB），
   所以按 Ctrl+Z 突然「没有可撤销的操作」时用户不会知道是触了步数还是触了内存 ——
   那一瞬看起来就像坏了。工具条上常驻一句「撤销 N/30」，耗尽时说清是哪一档顶到了。 */
const UNDO_MAX_BYTES = 24 * 1024 * 1024, UNDO_MAX_COUNT = 30;
let undoBytes = 0;
/* 「为什么存不下」—— pushUndo 的两处早退各有一个原因，耗尽时照实报出去。
   判据与 pushUndo 同一处，不在这里重算。 */
let undoSkipWhy = '';
function pushUndo(json) {
  if (!json) return false;
  if (json.length > UNDO_MAX_BYTES / 2) {
    /* 单份就超预算一半：不存（避免一份快照把预算吃光） */
    undoSkipWhy = '这一份工作区太大（' + window.fmtBytes(json.length) + '，超过单份上限 '
      + window.fmtBytes(UNDO_MAX_BYTES / 2) + '）';
    return false;
  }
  undoStack.push(json);
  undoBytes += json.length;
  /* 早退的两档各报各的：以前只要栈短了就写「步数用满」，
     单份大快照把内存预算顶爆时用户看到的却是一句「30 步用完了」——
     原因写错，下一次按 Ctrl+Z 也还是不明白为什么只剩这几步。 */
  let evictWhy = '';
  while (undoStack.length > UNDO_MAX_COUNT || undoBytes > UNDO_MAX_BYTES) {
    evictWhy = undoStack.length > UNDO_MAX_COUNT
      ? '撤销已用满上限（' + UNDO_MAX_COUNT + ' 步）'
      : '撤销内存已用满（' + window.fmtBytes(UNDO_MAX_BYTES) + '）';
    undoBytes -= undoStack.shift().length;
  }
  if (evictWhy) undoSkipWhy = evictWhy;
  return true;
}
/* 助手那几条时间线动作在改数据之前调它：**当场**把改动前的快照压进撤销栈。
   正常编辑靠 `scheduleSave` 的 500ms 合并窗口落一次快照 —— 助手动作之后用户可能立刻说
   「撤销」，那时窗口还没到，栈里是空的，`undo()` 会回一句「可撤销的已经用完了」（假话）。
   压过之后同一轮 `scheduleSave` 不再重复压同一份（`undoPushed` 只跳过那一次）；
   这一步不改 `lastSavedJson`，落盘照旧。 */
let undoPushed = false;
/* 栈顶那一份快照是「哪一次编辑」的标签：只给人看（助手 `history()` 回执），
   不参与判据。调 beginEdit 的入口可以不传（默认「编辑」）；传了就写在这里。 */
let lastUndoLabel = '';
function beginEdit(label) {
  const snap = snapOf();
  if (pushUndo(snap)) { redoStack.length = 0; undoPushed = true; lastUndoLabel = label || '编辑'; }
}
/* 工具条上那一句（判据只有这两处：栈长与字节数）。 */
function undoMeterText() {
  return '撤销 ' + undoStack.length + '/' + UNDO_MAX_COUNT
    + (undoBytes > UNDO_MAX_BYTES * 0.6 ? '（内存 ' + window.fmtBytes(undoBytes) + ' / ' + window.fmtBytes(UNDO_MAX_BYTES) + '）' : '');
}
function pushRedo(json) {
  if (!json || json.length > UNDO_MAX_BYTES / 2) return;
  redoStack.push(json);
  if (redoStack.length > UNDO_MAX_COUNT) redoStack.shift();
}
// 快照剔除轮询的瞬态字段（进度/排队位置），避免自动轮询污染撤销栈
function snapOf() {
  /* 游标不进快照。`curScene` / `curShot` / `curCand` 是「我现在在看哪一个」，
     不是「作品是什么」—— 以前它们被一起序列化，于是点6 次候选缩略图比较效果，
     再按 Ctrl+Z，第一下退回去的是「我刚才在看第 2 条候选」，真正的编辑还排在后面。
     而撤销上限只有 30 步，翻看几次就能把真正的改动挤出栈。
     剔掉它们之后，「翻看」不再消耗撤销次数，而撤销回去时视口停在当前这一镜
     （restoreSnap 之后 renderAll 会照 proj.curCand 重画，指向的那一条仍然是它，
     因为那一镜的候选列表没变）。
     **只序列化当前项目**：多项目工程里整个工作区可能有几十 MB，
     每 500ms / 每一刀都 stringify 全部项目是主线程卡顿的主要来源；
     撤销只需要恢复正在改的那一个项目（切项目会换 curId，恢复时跟着切回去）。 */
  if (!proj) return '';
  /* `groups` 一起进快照：项目组是一次编辑（建组 / 归组 / 删组），
     不进快照的话 Ctrl+Z 撤不回去 —— 那条组关系就再也回不来了。 */
  return JSON.stringify({ curId: WS.curId, project: proj, roles: WS.roles, groups: WS.groups },
    (k, v) => (k === 'progress' || k === 'queue_position'
      || k === 'curScene' || k === 'curShot' || k === 'curCand') ? undefined : v);
}
function restoreSnap(json) {
  try {
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
    sanitize(); renderAll();
    /* renderMid 末尾会 scheduleSave；撤销/重做本身就是「回到已存状态」，
       不能让这次重画顺手把 redoStack 清掉（那会让「撤销一步再重做」直接没有反应）。 */
    clearTimeout(saveTimer); saveTimer = null;
    try { $('saveState').textContent = '已保存到本地'; } catch (e) { /* 取不到那个节点也只丢一句提示，保存本身已经成了 */ }
    /* 撤销/重做也是一次真实改动：revision 只增不减（bumpRevision 里有 floor），
       否则退回旧快照时 rev 倒退，同一份工作区会先后拿到同一个号，助手 CAS 就认不出中间改过。 */
    bumpRevision();
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
function undo() {
  if (!undoStack.length) {
    setStatus('<span class="err">可撤销的已经用完了'
      + (undoSkipWhy ? '（' + undoSkipWhy + '）' : '') + ' —— 不是「没有可撤销的操作」</span>');
    return;
  }
  undoSkipWhy = '';
  const back = undoStack.pop();
  const cur = snapOf();
  if (!restoreSnap(back)) {
    undoStack.push(back);
    setStatus('<span class="err">撤销失败：这份快照没能恢复，工作区保持原样</span>');
    return;
  }
  pushRedo(cur);
  setStatus('<span class="ok">✓ 已撤销（Ctrl+Y 重做）</span>');
}
function redo() {
  if (!redoStack.length) { setStatus('没有可重做的操作'); return; }
  const fwd = redoStack.pop();
  const cur = snapOf();
  if (!restoreSnap(fwd)) {
    redoStack.push(fwd);
    setStatus('<span class="err">重做失败：这份快照没能恢复，工作区保持原样</span>');
    return;
  }
  pushUndo(cur);
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

/* Track域（engine/track.js）：这一段（393-1928）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Track = createTrack({
  projOf: () => proj,
  uid: (...a) => uid(...a),
  allShots: (...a) => allShots(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  shotReady: (...a) => shotReady(...a),
  beginEdit: (...a) => beginEdit(...a),
  filmEdited: (...a) => filmEdited(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  isFilmMode: (...a) => isFilmMode(...a),
  segLabel: (...a) => segLabel(...a),
  paintTrimRow: (...a) => paintTrimRow(...a),
  voiceElOf: () => voiceEl,
  playVoicePreview: (...a) => playVoicePreview(...a),
  paintVoiceVol: (...a) => paintVoiceVol(...a),
  voiceLn: (...a) => voiceLn(...a),
  voiceMin: () => VOICE_MIN,
  selectVoice: (...a) => selectVoice(...a),
  filmPinT: (...a) => filmPinT(...a),
  vcTabOf: () => vcTab,
  renderAll: (...a) => renderAll(...a),
  setStatus: (...a) => setStatus(...a),
}, document, window);
const {
  tlDuration,
  tlCandidateOf,
  candDur,
  filmFrames,
  axisGray,
  filmLayGray,
  frameToSrc,
  srcToFrame,
  shotFrames,
  shotRowAt,
  shotPinT,
  shotAxTotal,
  voiceAxBox,
  voiceFilmSpan,
  voiceFilmWhy,
  voiceAdoptable,
  fillWaveforms,
  videoPeaks,
  drawSegWave,
  fillSegWaveforms,
  voiceBlockHTML,
  cutSegIdx,
  curSegOf,
  candSelected,
  voicesEnsure,
  shotVoices,
  clipVoices,
  dragBusy,
  dragOnWindow,
  reanchorVoices,
  cutSegs,
  cutPin,
  tlCutTarget,
  tlVoiceHit,
  voiceSelId,
  picSelOn,
  picSelAt,
  tlFocusPos,
  laneLocked,
  laneHidden,
  rowHidden,
  rowLocked,
  laneNm,
  rowNm,
  rowLockWhy,
  rowUnlockHow,
  rowFlagToggle,
  laneVol,
  laneRowsOf,
  laneRowsFor,
  LANE_ROW_SEL,
  addLaneRow,
  addImageToTrack,
  voiceLanePlan,
  dropLaneRow,
  voiceSplitByMaterial,
  voiceMergeAll,
  setCellLane,
  laneMute,
  trackOwnVol,
  laneMuteToggle,
  picVolOf,
  moveShotInFilmOrder,
  tlSyncFromShots,
  voiceVolOf,
  setLaneVol,
  laneToggle,
  focusVoiceShot,
  runCut,
  setCutVol,
  setCutLane,
  cutSpdSeg,
  setCutSpd,
  segLenText,
  voiceLenText,
  setVoiceSpd,
  trackOne,
  setTrackSpd,
  setTrackVoiceSpd,
  setTrackVol,
  paintTlGroups,
  syncTlTools,
} = Track;
/* 生成工作台「加到时间线」的落点：与拖进画面轨同一枚 addImageToTrack，不另写一份放图逻辑。 */
takeAddedImage = spec => addImageToTrack(spec);

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
}, document, window);
const {
  sliceForgetFail,
  sliceUserTouch,
  fillSlices,
  tlClipSrc,
} = Frames;



/* 读 JSON：接口不存在（如服务未重启）时给出可操作提示，而不是 “not valid JSON” */
async function readJsonSafe(r, what) {
  const x = await Net.readRes(r);
  if (x.d == null) {
    const plain = (x.txt || '').trim();
    if (x.status === 404 || /not found/i.test(plain)) {
      throw new Error(`${what}：本地服务没有这个接口，请重启一次服务（启动.bat → [3] 重启项目）后再试`);
    }
    throw new Error(`${what}：返回了非 JSON 内容（HTTP ${x.status}）${plain ? '：' + plain.slice(0, 80) : ''}`);
  }
  if (!x.ok) throw new Error(`${what}：${x.d.error || x.d.err || ('HTTP ' + x.status)}`);
  return x.d;
}
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

/* 时间线 → 给 LLM 的上下文摘要（连同 tlContextForLLM 一起已移除：从未被调用） */


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
  const list = chainModelList();
  const cur = sh.model && sh.model !== 'auto' ? list.find(m => m.id === sh.model) : null;
  /* 当前型号能接首帧就留着 —— 用户挑过的那一型不因为接续被换掉。 */
  if (cur && cur.first) return resolvedModel(sh);
  /* 型号不认识（下架 / 换平台）或本来就是程序为接续挑的：按接续能力重挑一个。 */
  /* 手选的具体型号明确不支持首帧：不偷偷换回去，由 `chainModelWhy` 把那句话说出来。 */
  if (cur && !cur.first && sh.modelAuto !== 'chain') return resolvedModel(sh);
  const pick = pickChainModel(list, '', 0, null);
  if (!pick) return resolvedModel(sh);
  if (pick.id !== sh.model) { sh.model = pick.id; sh.modelAuto = 'chain'; }
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
  lineLandedNote: (...a) => lineLandedNote(...a),
  boardEstimate: (...a) => boardEstimate(...a),
  renderAll: (...a) => renderAll(...a),
  switchProject: (...a) => switchProject(...a),
  setStatus: (...a) => setStatus(...a),
}, document, window);
const {
  aiStoryboard,
} = Apply;


/* 一次会改动成片内容的编辑做完后调它：重画 + 存档。
   **这里不再自动合成**（2026-10 用户要求：合成只该发生在「导出成片」那一下）。
   以前这里是 `renderAll(); scheduleSave(); maybeAutoMerge();` —— 只要用户**曾经**合并过一次，
   之后每改一个入点、每切一刀，都会在 1.2 秒后自动整片合成一遍（几十秒、占满 CPU），
   而剪辑本来就是连续微调的动作（改一处看一眼再改），于是整段时间都在重复合成。
   现在：编辑只改数据与画面，成片要等你点「导出成片」时才重做
   （那时快捷闸 `filmIsCurrent` 自己判旧的那份已过期，照常真跑一遍合成）。 */
/* 修订号的**唯一**写入点：只增不减。撤销/重做会退回旧快照里的 proj（旧 rev），
   所以这里用 revFloor 兜住 —— 同一份工作区的 revision 永远向前走，助手 CAS 才认得出
   「读取之后又改过」。 */
let revFloor = 0;
function bumpRevision() {
  if (!proj) return 0;
  revFloor = Math.max(revFloor, Number(proj.rev) || 0) + 1;
  proj.rev = revFloor;
  return proj.rev;
}
function filmEdited() {
  /* 修订号只给「助手写入」的 CAS 用：每次会改成片内容（含字幕）的编辑都 +1，
     助手拿旧 revision 提交时当场拒掉，而不是把用户刚做的编辑盖掉。 */
  bumpRevision();
  /* 切段 / 改倍速之后那几格的采样点已经换了，原来记的「这块取不到帧」不再作数：
     放行一次，让下一次重画真的去取。 */
  sliceForgetFail();
  renderAll(); scheduleSave();
}

/* ============================================================================
   字幕：右栏「字幕」、轨道字幕行、预览叠层、SRT / 烧录 / FCPXML
   ----------------------------------------------------------------------------
   数据层只有一份：`sh.subtitle.entries` 是**候选源秒**（AGENTS §9.2），
   显示与导出全部经 `currentOf → mapToFilm`；导入 SRT 用 `mapFromFilm` 折回源秒。
   老工程没有 `sh.subtitle` 时 `currentOf` 现派生、不写盘（不因为打开一次就写胖）。
   ========================================================================== */
let subAsrBusy = '';
let subAsrCtl = null;   // 在途识别的中止信号（浏览器 worker 与等待循环都听它）
let subAsrJob = '';     // 已经建出的代理任务号：取消时补一次 cancel，别让它在后台跑完
/* 这一镜在成片里的绝对起点（= 这一镜第一格在 tl.clips 里的累计秒）。
   没进成片（没有选用候选 / 一段画面都没留）返回 null —— 字幕换算不拿 0 冒充。 */
function shotFilmAt(sh) {
  if (!sh) return null;
  const tl = tlSyncFromShots();
  let at = 0;
  for (const c of tl.clips) {
    if (c.kind === 'shot' && c.shotId === sh.id) return at;
    at += tlClipDur(c);
  }
  return null;
}
/* 成片行（FCPXML / SRT / 烧录共用的一份形状）：`{c, at, dur}`，at 是这一格在成片里的起点。 */
function filmRowsForSubtitles() {
  const tl = tlSyncFromShots();
  const rows = [];
  let at = 0;
  tl.clips.forEach(c => {
    const dur = tlClipDur(c);
    rows.push({ c, at, dur });
    at += dur;
  });
  return { rows, total: at };
}
function subCurrent(sh) { return currentOf(sh, voicesEnsure()); }
/* 写字幕数据的唯一落点：不压快照、不重画（由调用方决定这次编辑的边界）。
   `source` 只能是 line+voice / manual / asr（与 subtitles.js 的判据同一套）。 */
function subWriteData(sh, entries, source) {
  if (!sh) return null;
  const st = styleOf(sh);
  const cand = chosenCandOf(sh);
  sh.subtitle = {
    candId: cand ? cand.vid : '',
    entries: (Array.isArray(entries) ? entries : []).map((e, i) => Object.assign({}, e, { index: i + 1 })),
    style: st,
    source: source === 'asr' || source === 'manual' ? source : 'line+voice',
    sourceHash: sourceHashOf(sh, voicesEnsure()),
  };
  return sh.subtitle;
}
function subWrite(sh, entries, source, label) {
  if (!sh) return;
  beginEdit(label || '编辑字幕');
  subWriteData(sh, entries, source);
  filmEdited();
}
function subStyleWrite(sh, patch, label) {
  if (!sh) return;
  beginEdit(label || '改字幕样式');
  if (!sh.subtitle || typeof sh.subtitle !== 'object') sh.subtitle = {};
  setStyle(sh, patch);
  filmEdited();
}
function subGenerate(sh) {
  if (!sh) return;
  const cur = subCurrent(sh);
  if (cur.stale) {
    /* 台词/配音变过，而现在的字幕是手改 / 识别出来的：生成会覆盖它们 —— 先问一句。 */
    if (!Confirm.arm($('subGen'), '覆盖现在的字幕？', { note: '这一镜的台词或配音已经变过；重新生成会按新台词/配音派生的 ' + cur.entries.length + ' 条字幕替换现在这一份（可以按 Ctrl+Z 退回）' })) return;
  }
  const entries = entriesFromShot(sh, voicesEnsure(), chosenCandOf(sh));
  if (!entries.length) {
    setStatus('<span class="err">这一镜没有可生成字幕的台词或配音：先在分镜里写台词，或在配音轨上合成一句</span>');
    return;
  }
  subWrite(sh, entries, 'line+voice', '从台词生成字幕');
  setStatus('<span class="ok">✓ 已按台词/配音生成 ' + entries.length + ' 条字幕（之后台词或配音再变，会自动跟着重派生）</span>');
}
function subResegment(sh) {
  if (!sh) return;
  const cur = subCurrent(sh);
  if (!cur.entries.length) { setStatus('<span class="err">这一镜还没有字幕</span>'); return; }
  const st = styleOf(sh);
  const next = resegment(cur.entries, st.maxCharsPerEntry);
  if (next.length === cur.entries.length) {
    setStatus('<span class="meta">已经是每行不超过 ' + st.maxCharsPerEntry + ' 个字，没有可再切的字幕</span>');
    return;
  }
  subWrite(sh, next, 'manual', '按每行字数重切字幕');
  setStatus('<span class="ok">✓ 已按每行 ' + st.maxCharsPerEntry + ' 字重切成 ' + next.length + ' 条（内容不变，时间按字数比例分）</span>');
}
function pickTextFile(accept) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept || '';
    inp.style.display = 'none';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      try { inp.remove(); } catch (e) { /* 临时输入框已经不在 DOM 里就没有可移除的 */ }
      resolve(f || null);
    };
    document.body.appendChild(inp);
    inp.click();
  });
}
function subExportSrt() {
  const { rows } = filmRowsForSubtitles();
  const got = filmEntriesOf(rows, allShots(), voicesEnsure());
  if (!got.entries.length) {
    setStatus('<span class="err">现在一条字幕都没有：先在「字幕」里生成、导入或自动识别</span>');
    return;
  }
  const text = srtSerialize(got.entries, { bom: true, crlf: true });
  const name = window.fileSafe((proj && proj.name) || '成片', 60) + '-字幕-' + window.fileStamp() + '.srt';
  const saved = saveBlob(name, new Blob([text], { type: 'application/x-subrip;charset=utf-8' }));
  setStatus('<span class="ok">' + saved.msg + '（' + got.entries.length + ' 条字幕，时间是成片秒）</span>'
    + (got.missing.length ? '<span class="warn"> · 有 ' + got.missing.length + ' 个镜头的字幕没进成片（没有选用候选），没有导出</span>' : ''));
}
async function subImportSrt(sh) {
  if (!sh) return;
  const c = chosenCandOf(sh);
  if (!c) { setStatus('<span class="err">这一镜还没有选用候选：SRT 的时间是成片秒，没有候选就折不回源秒</span>'); return; }
  const shotAt = shotFilmAt(sh);
  if (shotAt == null) { setStatus('<span class="err">这一镜还没进成片（没有选用候选 / 画面全被剪掉）：先在候选上点「用这条」</span>'); return; }
  const file = await pickTextFile('.srt,.txt,text/plain,application/x-subrip');
  if (!file) return;
  let text = '';
  try { text = await file.text(); } catch (e) { setStatus('<span class="err">读这个文件失败：' + esc(String(errText(e))) + '</span>'); return; }
  const parsed = srtParse(text);
  if (!parsed.length) { setStatus('<span class="err">这个 SRT 里没有解析出字幕（检查一下时间行是不是 00:00:00,000 --> 00:00:02,000）</span>'); return; }
  const segs = segsOf(c, candDur(c, sh));
  const span = segs.reduce((a, s) => a + segFilmLen(s), 0);
  const inSpan = parsed.filter(e => {
    const a = (Number(e.startMs) || 0) / 1000;
    return a >= shotAt - 0.001 && a < shotAt + span + 0.001;
  });
  if (!inSpan.length) {
    setStatus('<span class="err">这段 SRT 里没有落在本镜的字幕（本镜在成片里是 ' + fmtDur(shotAt) + '–'
      + fmtDur(shotAt + span) + '）</span>');
    return;
  }
  const mapped = mapFromFilm(sh, shotAt, inSpan, { cand: c });
  if (!mapped.length) { setStatus('<span class="err">SRT 落在本镜的那几条折回源秒后是空的</span>'); return; }
  subWrite(sh, mapped, 'manual', '导入 SRT');
  setStatus('<span class="ok">✓ 已导入 ' + mapped.length + ' 条字幕（SRT 的成片秒已折回这一镜的源秒；'
    + (parsed.skipped ? parsed.skipped + ' 块格式不对已跳过；' : '')
    + (parsed.length - inSpan.length ? (parsed.length - inSpan.length) + ' 条不在本镜；' : '')
    + '这是外来的手改数据，台词变化不会覆盖它）</span>');
}
async function subAsr(sh) {
  if (!sh) return;
  /* 第二下就是「不等了」：浏览器内那一路线首次要先经代理下几百 MB 模型，
     没有出口的话用户只能刷新页面。 */
  if (subAsrBusy) { await subAsrAbort(); return; }
  const c = chosenCandOf(sh);
  const src = c ? candTrackSrc(c) : '';
  if (!src) { setStatus('<span class="err">这一镜还没有可识别的素材：先生成或导入一条视频</span>'); return; }
  subAsrBusy = sh.id;
  const ctl = new AbortController();
  subAsrCtl = ctl;
  try {
    if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
    setStatus('<span class="meta">正在提交语音识别…</span>');
    const r = await window.Asr.transcribe({
      src,
      signal: ctl.signal,
      onStage: s => { if (curShot() === sh && !ctl.signal.aborted) setStatus('<span class="meta">' + esc(window.Asr.stageText(s)) + '</span>'); },
    });
    subAsrJob = r.jobId || '';
    if (curShot() === sh) renderEditor();
    const job = await window.Asr.wait(r.jobId, j => {
      if (curShot() === sh && !ctl.signal.aborted) setStatus('<span class="meta">正在识别这一镜的语音… ' + Math.round((j.progress || 0) * 100) + '%</span>');
    }, { signal: ctl.signal });
    if (job.state !== 'done') throw new Error(job.error || ('识别任务 ' + job.state));
    const segs = job.segments || [];
    const candSegs = segsOf(c, candDur(c, sh));
    const entries = [];
    segs.forEach(s0 => {
      const a = Number(s0.start) || 0;
      const b = Number(s0.end) || 0;
      const mid = (a + b) / 2;
      const seg = candSegs.find(x => mid >= x.in && mid <= x.out);
      if (!seg) return;
      const st = Math.max(a, seg.in);
      const en = Math.min(b, seg.out);
      const tx = String(s0.text == null ? '' : s0.text).trim();
      if (!tx || en - st < 0.08) return;
      entries.push({ startMs: Math.round(st * 1000), endMs: Math.round(en * 1000), text: tx, src: 'asr' });
    });
    if (!entries.length) throw new Error('识别完成，但结果一条都不在保留的片段里（看看是不是把有说话的片段剪掉了）');
    subWrite(sh, entries, 'asr', '自动识别字幕');
    setStatus('<span class="ok">✓ 识别完成：' + entries.length + ' 条字幕已写入「字幕」（识别结果不会反改台词与配音）</span>');
  } catch (e) {
    if (ctl.signal.aborted) {
      setStatus('<span class="err">已取消识别：这一镜的字幕没有改动</span>');
    } else {
      setStatus('<span class="err">自动识别失败：' + esc(String(errText(e))) + '</span>');
    }
  } finally {
    subAsrBusy = '';
    subAsrCtl = null;
    subAsrJob = '';
    if (curShot() === sh) renderEditor();
  }
}
/* 「不等了」：掐掉在途的浏览器 worker（signal 一路传到 terminate），
   代理那一路已经建出任务号的再补一次 cancel，别让它在后台跑完。 */
async function subAsrAbort() {
  const id = subAsrJob;
  subAsrJob = '';
  try { if (subAsrCtl) subAsrCtl.abort(); } catch (e) { /* 已经断了 */ }
  if (id) {
    try { await window.Asr.cancel(id); } catch (e) { /* 已经跑完或取消不掉：状态由那一单自己报 */ }
  }
}
function subAddAtPin(sh) {
  if (!sh) return;
  const c = chosenCandOf(sh);
  const cur = subCurrent(sh);
  const total = c ? candDur(c, sh) : 0;
  const at = Math.max(0, Math.min(total, Number(proj.cutAt) || 0));
  const end = total ? Math.min(total, at + 2) : at + 2;
  const entries = cur.entries.concat([{
    startMs: Math.round(at * 1000), endMs: Math.round(Math.max(at + 0.2, end) * 1000),
    text: '新字幕', src: 'manual',
  }]);
  subWrite(sh, entries, cur.source === 'asr' ? 'asr' : 'manual', '加一条字幕');
}
function subDelete(sh, i) {
  if (!sh) return;
  const cur = subCurrent(sh);
  const e = cur.entries[i];
  if (!e) return;
  const entries = cur.entries.filter((x, k) => k !== i);
  subWrite(sh, entries, cur.source === 'asr' ? 'asr' : 'manual', '删一条字幕');
  setStatus('<span class="ok">✓ 已删掉字幕「' + esc(String(e.text).slice(0, 20)) + '」（台词与配音没动）</span>');
}
function subSetText(sh, i, text) {
  if (!sh) return;
  const cur = subCurrent(sh);
  if (!cur.entries[i]) return;
  const v = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (v === cur.entries[i].text) return;
  const entries = cur.entries.map((e, k) => (k === i ? Object.assign({}, e, { text: v, src: e.src === 'voice' || e.src === 'line' ? e.src : 'manual' }) : e));
  subWrite(sh, entries, cur.source === 'asr' ? 'asr' : 'manual', '改字幕文字');
}
/* 右栏字幕清单 / 本镜与全片两排字幕块 / 它们的拖动与起止输入：
   整域搬进 web/director/engine/sub-lane.js（createSubLane），这里只留包与解构（见 Lanes / Voice 两处）。 */
/* 预览叠层：本镜读本镜甲板轴，全片读成片秒；两条都从 currentOf 派生。 */
let subOverlayCache = { key: '', list: [] };
function filmSubtitleList() {
  const key = String(proj.rev || 0) + ':' + voicesEnsure().length;
  if (subOverlayCache.key === key) return subOverlayCache.list;
  const { rows } = filmRowsForSubtitles();
  subOverlayCache = { key, list: filmEntriesOf(rows, allShots(), voicesEnsure()).entries };
  return subOverlayCache.list;
}
function subOverlayState(sec) {
  if ((proj.tlTab || 'shot') === 'film') {
    const t = Math.max(0, Number(sec) || 0) * 1000;
    const e = filmSubtitleList().find(x => t >= x.filmStartMs - 1 && t < x.filmEndMs - 1);
    if (!e) return null;
    const sh = allShots().find(x => x.id === e.shotId);
    return { entry: e, style: styleOf(sh) };
  }
  const sh = curShot();
  if (!sh) return null;
  const e = entryAt(sh, sec, { axis: 'shot', voices: voicesEnsure(), cand: chosenCandOf(sh) });
  return e ? { entry: e, style: styleOf(sh) } : null;
}
function paintSubOverlayAt(sec) {
  const wrap = $('subWrap');
  if (!wrap) return;
  const got = subOverlayState(Math.max(0, Number(sec) || 0));
  const key = got ? JSON.stringify([got.entry.index, got.entry.text, got.style]) : '';
  if (wrap.dataset.key === key) return;
  wrap.dataset.key = key;
  wrap.innerHTML = got ? overlayHTML(got.entry, got.style) : '';
}
/* 剪辑 → 全片 那一格状态说明整块已删（2026-10 用户点名：镜头统计那一行 + 成片陈旧那句长提示）。
   成片新旧这件事现在只在**点导出那一刻**由 `exportFilm` 的快捷闸（`filmIsCurrent`）自己判，
   界面上不再有第二处陈述。 */

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
function scheduleSave() {
  /* 装配窗口里的重排/重画（换页、resize、下拉重建）也会叫到这里：那时 WS 还是空的默认值，
     排下去的就是「把工作区存成没有工程」——和 __spaFlush 同一道闸，没装配完直接不排。 */
  if (!wsLoaded) return;
  wsFlushOk = false;
  $('saveState').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout
  (async () => {
    saveTimer = null;
    const snap = snapOf();
    /* 一个字节都没变（轮询到「还是生成中」、或者重画顺手调了一次）：不写 IndexedDB、
       不做镜像、也不往撤销栈里再压一份。以前这里无条件 stringify + put + mirrorWs，
       一次 3 秒的轮询就是一次整份工作区的序列化与落盘。 */
    if (lastSavedJson && snap === lastSavedJson) {
      undoPushed = false;
      $('saveState').textContent = '已保存到本地';
      return;
    }
    if (lastSavedJson && snap !== lastSavedJson && !undoPushed) {
      pushUndo(lastSavedJson);          // 限总量，避免大工程把内存吃满
      redoStack.length = 0;
    }
    undoPushed = false;
    try {
      const wsRec = { projects: WS.projects, curId: WS.curId, roles: WS.roles, groups: WS.groups, ts: Date.now() };
      await wsKv.put('workspace', wsRec);
      lastSavedJson = snap;
      $('saveState').textContent = '已保存到本地';
      /* 同时写一份到代理的数据目录（.data/workspace.json）：浏览器存储被清掉时还能从磁盘恢复。
         这里只有**引用**（每条素材指向本机资产库里的一个资产号），视频字节不在 JSON 里 ——
         所以这一份备份认得工程与时间线，字节能不能取回，看那一根还在不在库根里
         （库根默认在系统下载下的 拾帧\，见设置页「本机资产库」那一格）。
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
  return `<div class="cand-thumb addcand big" data-add="1" title="新增一个空候选：先写描述，再点「生成这条」">
      <span class="plusic">${icon('plus', 18)}</span><span class="pt">还没有候选</span><span class="pd">点这里新增一个候选</span>
    </div>`;
}
/* 有候选时行尾的小加号：再抽一条 */
function candAddTile() {
  return `<div class="cand-thumb addcand" data-add="1" title="新增一个空候选：先写这条候选的描述，再点「生成这条」">${icon('plus', 16)}</div>`;
}
let midCandExpand = window.LS.get('dir_cand_expand') === '1';
/* ============================================================================
   剪辑态的「无感播放」：不渲染也能播剪完之后的样子
   ----------------------------------------------------------------------------
   以前剪完要看效果只有一条路：合并成片（整片合成一遍，几十秒），改一个入点就得再合一次。
   参考项目的分工是「预览走原生媒体路径保证流畅，导出才走独立的确定性离线渲染路径」——
   这里同义：**播放不渲染**。按时间线调度现成的素材：成片第 T 秒落在哪一段，
   就把播放器指到那一段的 `in + (T - 段起点)`；这一段放完自动接下一段。
   段与段之间用两个 <video> 甲板接力（后面那个提前把下一段加载并定到入点），
   所以接缝上看不出换了一条素材。配音由这一层按成片绝对时间起播（Audio 元素，同一根时间基）。
   ========================================================================== */
/* 剪辑态播放计划：本镜 / 全片两路，算法在 plan.js；这里只把工程状态与函数接进去。 */
let tlPlayPlanOf = null;
function tlPlayPlan() {
  if (!tlPlayPlanOf) {
    tlPlayPlanOf = createPlayPlan({
      getProj: () => proj, curShot, allShots, tlCandidateOf, candDur,
      picVolOf: s => picVolOf(s), tlSyncFromShots, filmFrames, filmLayGray,
      candTrackSrc: c => candTrackSrc(c), clipVoices: (c, o) => clipVoices(c, o),
      shotVoices: (a, b) => shotVoices(a, b), voiceVolOf: v => voiceVolOf(v),
    });
  }
  return tlPlayPlanOf();
}

/* 剪辑态「播放进度 → 插针」那一下：renderMid 里注册，TlPlay 每帧回调它。
   不直接把 syncPlayhead 塞给 TlPlay 是因为它每次重画都是一个新的闭包（绑着新的 col），
   而 TlPlay 是模块级单例 —— 中间那层变量就是为了让两者不必同生同死。 */
let tlPlayhead = null;
/* 剪辑态的播放器接线：播放 / 暂停、声音、时间、以及「进度跟着插针走」都从 TlPlay 走。
   与下面那一整段普通播放器接线是互斥的两条路（同一个 #player，两种含义），
   所以调用处按 midEditTrim 二选一，绝不两条都接上。 */
function bindTlPlay(col, keepPlay, fmtClock, keepBox) {
  const a = col.querySelector('#player'), b = col.querySelector('#playerB');
  const still = col.querySelector('#playerStill');
  const pb = col.querySelector('#pbBtn'), tb = col.querySelector('#pbTime'), mb = col.querySelector('#pbMute');
  const ab = col.querySelector('#arBadge');
  const before = TlPlay.fp;
  TlPlay.mount(a, b, { muted: window.LS.get('dir_muted') === '1', still: still });
  const plan = tlPlayPlan();
  TlPlay.setPlan(plan.clips, plan.voices, { film: plan.film });
  if (ab) ab.textContent = '剪后预览 · ' + plan.clips.length + ' 段 · ' + fmtClock(TlPlay.total).replace(/^00:/, '') + 's';
  const sync = () => { if (pb) pb.innerHTML = icon(TlPlay.playing ? 'pause' : 'play', 15); };
  const showT = () => { if (tb) tb.textContent = fmtClock(TlPlay.t) + ' / ' + fmtClock(TlPlay.total); };
  TlPlay.onTime = () => { sync(); showT(); paintSubOverlayAt(TlPlay.t); if (tlPlayhead) tlPlayhead(); };
  if (pb) pb.onclick = e => { e.stopPropagation(); if (TlPlay.playing) TlPlay.pause(); else TlPlay.play(); };
  const toggle = () => { if (TlPlay.playing) TlPlay.pause(); else TlPlay.play(); };
  if (a) a.onclick = toggle;
  if (b) b.onclick = toggle;
  /* 图片段盖在甲板上时点击落在它身上：同一颗播放 / 暂停，否则走到图片就点不动了。 */
  if (still) still.onclick = toggle;
  if (mb) {
    mb.innerHTML = icon(TlPlay.muted ? 'speakerOff' : 'speaker', 14);
    mb.onclick = e => {
      e.stopPropagation();
      const on = !TlPlay.muted;
      TlPlay.setMuted(on);
      mb.innerHTML = icon(on ? 'speakerOff' : 'speaker', 14);
      mb.title = on ? '已静音（点击开启声音）' : '声音已开启（点击静音）';
      window.LS.set('dir_muted', on ? '1' : '0');
    };
  }
  bindPbFull(col.querySelector('.player-box'));
  sync(); showT();
  paintSubOverlayAt(TlPlay.t);
  /* 只有**计划真的变了**（剪了一刀、换了候选、加了配音）才重新定位：
     那时画面必须立刻反映新的段落，哪怕正在播也要从头接上。
     计划没变而只是整列重画（轮询那 3 秒一次，且甲板节点被保住了）就一个字都不动 ——
     去 seek 一次会把正在播的画面卡一下、把这一句的配音掐断重头再放。 */
  if (!keepBox || TlPlay.fp !== before) TlPlay.seek(keepPlay ? keepPlay.t : 0, !!(keepPlay && !keepPlay.paused));
}

/* 播放器下方那一排控件**只有一份标记**：剪辑态那两个甲板与候选播放器以前各抄一遍
   （三行一模一样的按钮 + 一份「按 localStorage 决定喇叭图标」的判断），改一颗就得记着改两处。
   左下 = 播放/暂停 + 时长读数；右下 = 声音 + 全屏，两颗挨着、全屏在最右下角（用户点名）。
   静音态的图标与 title 都按 dir_muted 现读，不写死「声音开关」。 */
function pbBarHTML() {
  const muted = window.LS.get('dir_muted') === '1';
  return `<div class="pb-bar">
        <button class="pb-btn" id="pbBtn" title="播放 / 暂停">${icon('play', 15)}</button>
        <span class="pb-time" id="pbTime">00:00 / 00:00</span>
        <span class="sp"></span>
        <button class="pb-btn" id="pbMute" title="${muted ? '已静音（点击开启声音）' : '声音已开启（点击静音）'}">${icon(muted ? 'speakerOff' : 'speaker', 14)}</button>
        <button class="pb-btn" id="pbFull" title="全屏观看（再点一次退出）">${icon('expand', 14)}</button>
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
  /* 剪辑态：播放交给 TlPlay（两个甲板，不渲染就能播剪完的样子）。
     这是「剪完马上看到效果」的落点 —— 改一个入点不用再整片合成一次。 */
  if (midEditTrim) {
    /* 一段都没有（这一镜没候选 / 全片没选用镜头）就别摆一个黑框骗人 ——
       那正是「看着能播、其实什么都没有」的空控件，按全站约定要照实说一句。 */
    if (!tlPlayPlan().clips.length) {
      return `<div class="player-empty">
        <div class="pe-t">${(proj.tlTab || 'shot') === 'film' ? '还没有已选用的镜头' : '这一镜还没有候选'}</div>
        <div class="pe-d">${(proj.tlTab || 'shot') === 'film'
          ? '先在候选上点「用这条」，这里的剪辑预览就会按剪完的样子播'
          : '先生成或导入一条视频：剪辑预览直接按剪完的段落播，不用先合并成片'}</div>
      </div>`;
    }
    return `<div class="player-box">
      <video id="player" playsinline></video>
      <video id="playerB" playsinline class="back"></video>
      <!-- 图片段那一层：走到静止画面上时盖住两个甲板（见 TlPlay.enterHold） -->
      <img id="playerStill" class="player-still" alt="">
      <!-- 字幕叠层：与烧录同一份样式（overlayHTML）；播放头在本镜轴上就读 mapToShot，全片就读成片秒 -->
      <div class="sub-wrap" id="subWrap" aria-hidden="true"></div>
      ${pbBarHTML()}
      <!-- 右上角那一格与不剪辑时同一套：只写画面尺寸（由 updateArBadge 现读真实宽高），
           以前这里写着「剪后预览 · 不用先合并」，而 bindTlPlay 又把它顶成「剪后预览 · 5 段 · 8.0s」——
           用户点名要看的是尺寸，不是这两句。 -->
      <span class="arbadge" id="arBadge"></span></div>`;
  }
  /* 「全片模式下的播放器」那一整块已经删掉了：`isFilmMode()` 要求 `midEditTrim`，
     而剪辑态在上面就 return 了（两个甲板 + TlPlay 实时播），所以这里永远走不到 ——
     留着是一份没人执行的分支，还带着一句「点播放成片会先合并」的假承诺。 */
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
/* 操作行文案（加一条候选 / 用这条 / 取消选用 / 锁定 / 删除） */
function candActsHTML(sh) {
  const cands = sh.candidates || [];
  const cur = cands[proj.curCand];
  return `${cur && cur.vid !== sh.selId && cur.status === 'succeeded' ? '<button class="ghost" id="usec">✓ 用这条</button>' : ''}
    ${cur && cur.vid === sh.selId && !cur.locked ? '<button class="ghost" id="unsel">× 取消选用</button>' : ''}
    <button class="ghost" id="lockc" ${cur ? '' : 'disabled'}>${cur && cur.locked ? icon('lock', 12) + ' 已锁定（点击解锁）' : icon('lock', 12) + ' 锁定'}</button>
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
  if (uc) uc.onclick = () => { sh.selId = cur.vid; filmEdited(); };   // 选用后不自动锁定，可手动加锁（换候选 = 成片内容变了）
  const un = col.querySelector('#unsel');
  if (un) un.onclick = e => { const b = e.currentTarget;
    /* note 写清后果：取消选用之后这一镜的成片位置就空出来了，全片会少这一段 */
    Confirm.arm(b, '确认取消？', { note: '取消选用后，这一镜不再进成片（全片会少这一段）' })
      || (sh.selId = null, filmEdited()); };
  const lk = col.querySelector('#lockc');
  if (lk) lk.onclick = () => { if (cur) { cur.locked = !cur.locked; renderAll(); scheduleSave(); } };
  const dl = col.querySelector('#delc');
  if (dl) dl.onclick = e => {
    const b = e.currentTarget;
    /* 后果说明只写与这次删除直接相关的两条：
       ① 这一条正被选用 → 删了全片会少一段（以前完全静默，用户看到的是成片莫名少一镜）；
       ② 还在平台跑着 → 会顺带撤掉那个任务。
       「还会连带 N 条」这种与本次无关的一句都不写。 */
    const notes = [];
    if (cur && sh.selId === cur.vid) notes.push('这一条正被选用：删掉之后全片会少这一段');
    /* 还在跑的这一条要不要说「顺带撤单」，由注册表声明决定（判据只有 Api.canCancel 一份）。
       没有取消接口的那几家（MiniMax / 硅基流动 / 智谱视频）删了本机记录，平台上那条照样跑完 ——
       原来那句「删掉会顺带撤掉这个任务」在那几家是句假话（AGENTS.md「界面上的承诺要么实现、要么改文案」）。 */
    const live = !!cur && (cur.status === 'queued' || cur.status === 'running');
    const cxProv = live ? provById(cur.provider) : null;
    if (live && cxProv && Api.canCancel(cxProv)) notes.push('这一条还在平台上跑：删掉会顺带向平台撤掉这个任务');
    else if (live && cxProv) notes.push(cxProv.displayName + ' 没有取消任务的接口：本机删掉之后，平台上那一条还是会跑完');
    Confirm.arm(b, '确认删除？', notes.length ? { note: notes.join(' · ') } : null)
      || (() => {
        if (!cur || cur.locked) return;
        if (live && cxProv && Api.canCancel(cxProv)) {   // 还在跑的先取消上游任务
          // 取消走统一路由：POST 还是 DELETE 由 registry 的 cancelMethod 声明决定
          // 撤单失败不能静默吞 —— 那样用户以为平台上也没了，而那条还在计费
          Api.cancel(cxProv, cur.vid).catch(e => Toast.warn('没能让平台停掉这条任务：' + errText(e) + '（平台上可能还在跑）'));
        }
        sh.candidates = (sh.candidates || []).filter(c => c !== cur);
        if (sh.selId === cur.vid) sh.selId = null;
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
  /* 换了看的那一条 → 提示词框跟着它走，**并且把这一镜的描述也切成它**。
     为什么要连 sh.prompt 一起改：框里那句话就是「接下来点生成会用哪句」，
     而 drawShot / 批量生成 / 左栏卡片读的都是 sh.prompt —— 只改框不改它，
     就会出现「屏幕上写着 B、生成出来的却是 A」。 */
  const picked = cands[at];
  if (picked && picked.prompt) sh.prompt = picked.prompt;
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
    const pl2 = col.querySelector('#player');
    if (pl2) {
      const pb = col.querySelector('#pbBtn'), mb = col.querySelector('#pbMute'), tb = col.querySelector('#pbTime');
      if (pb) { pb.innerHTML = icon('play', 15); pb.onclick = () => { if (pl2.paused) playSafe(pl2); else pl2.pause(); }; }
      if (mb) { pl2.muted = window.LS.get('dir_muted') === '1'; mb.innerHTML = icon(pl2.muted ? 'speakerOff' : 'speaker', 14); }
      if (tb) { const syncTime = () => { tb.textContent = Wb.fmtClock(pl2.currentTime) + ' / ' + Wb.fmtClock(pl2.duration); }; pl2.addEventListener('timeupdate', syncTime); pl2.addEventListener('loadedmetadata', syncTime); syncTime(); }
      pl2.addEventListener('loadedmetadata', () => updateArBadge(pl2));
      if (pl2.readyState >= 1) updateArBadge(pl2);
      bindPbFull(pw.querySelector('.player-box'));
    }
  }
  const ca = col.querySelector('#candActs');
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
  setTimeout(() => { const ta = $('edPrompt'); if (ta) { ta.focus(); ta.select(); } }, 80);   // 描述在右栏写
}
/* 生成某一条候选（用这条自己的描述；草稿会原地变成任务） */
async function generateCandidate(ph) {
  const sh = curShot();
  if (!sh || !ph) return;
  const txt = String(ph.prompt == null ? sh.prompt : ph.prompt).trim();
  if (!txt) {
    setStatus('<span class="err">' + NO_PROMPT_WHY + '（可以先复制当前镜头的描述再改）</span>');
    const ta = $('edPrompt');
    if (ta) ta.focus();
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
function saveScheduleSoft() { clearTimeout(softTimer); softTimer = setTimeout(scheduleSave, 300); }

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
      : '这些镜头的外链换不到新地址（平台列表里没有它，或接口失败）——画面可能已被平台清理');
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
  btn.title = sc.img ? '这个场景自己挑的场景图 · 点击换一张'
    : pic ? '场景图认的是素材库里同名那条（「' + (sc.name || '') + '」）· 点击换成自己挑的'
      : '还没有场景图：点一下挑一张，这个场景里新建的镜头会自动带上它当参考图';
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
/* 挑一张场景图：右栏那几个槽位用的同一份选择器（资产库 / 收藏 / 本地上传 / AI 检索都在里面）。 */
function pickScenePic(sc) {
  AssetPicker.open({
    types: ['图片'], multiple: false, limit: 1, aiSearch: true,
    title: '给场景「' + (sc.name || '未命名') + '」挑一张图',
    note: '挑中之后，这个场景里新建的每个镜头都会自动把它带进参考图（已经建好的镜头不动）。',
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
  setStatus('已让「' + esc(sc.name || '这个场景') + '」不再自动带场景图（点那一格可以重新挑）');
}
/* 图标：垃圾桶（内联 SVG，颜色跟着按钮走，深浅主题都干净） */
const TRASH_SVG = icon('trash', 14);
function renderScenes() {
  const box = $('scenesBox');
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
  box.innerHTML = '';
  let n = 0;
  proj.scenes.forEach((sc, si) => {
    const blk = document.createElement('div');
    blk.className = 'scene-block';
    const head = document.createElement('div');
    head.className = 'scene-head';
    /* 收养要有身份可认：按场景号收（不是按第几场 —— 删一场之后下面的场全体上移一格）。
       老项目里可能没有 id，退到序号，两侧用同一个表达式就仍然对得上。 */
    head.dataset.scid = sc.id == null ? 'i' + si : String(sc.id);
    /* 场景图那一格：有图就显示图，没图显示一个虚线空位。
       右上角那颗 ×「这个场景不再自动带图」，与「换一张」放在同一个格子里 ——
       分开放要多占一个 flex 子项，而左栏最窄只有 198px，四个按钮加改名框就顶不下了。 */
    head.innerHTML = `<button class="sc-thumb" data-act="scpic"></button>
      <input value="${esc(sc.name)}" title="点一下可以改场景名">
      <span class="sc-cnt">${sc.shots.length} 镜</span>
      <button class="icon-btn add" data-act="addshot" title="在这个场景末尾新建一个镜头">${icon('plus', 14)}</button>
      <button class="icon-btn del" data-act="delscene" title="删除整个场景（连带里面的镜头）">${TRASH_SVG}</button>`;
    /* 收养只认「画的是同一张图」这一件事：这一格的媒体可能是从素材库现取的外链，
       整颗按钮推倒重来就是让它重新走一遍加载（任务轮询每一轮都走 renderSoft 重画左栏，
       闪的正是这一下）。收养的是整颗按钮 —— 绑定的键是它，不是里面的 <img>。 */
    const keptPic = keepPic.get(head.dataset.scid);
    if (keptPic && scenePicStamp.get(keptPic) === scenePicOf(sc))
      head.querySelector('[data-act=scpic]').replaceWith(keptPic);
    paintSceneThumb(head.querySelector('[data-act=scpic]'), sc);
    /* 改名要当场重画这一格（素材库里同名那条的图是**按名字**认领的），但不能整片 renderScenes：
       那会把这个正在打字 input 一起换掉、光标跳走。只换那一颗按钮的内容。 */
    head.querySelector('input').oninput = e => {
      sc.name = e.target.value; scheduleSave(); renderMidSoon();
      paintSceneThumb(head.querySelector('[data-act=scpic]'), sc);
    };
    /* 一格两个动作：点图本身 = 换一张，点右上角 × = 这一场不带图。
       × 不做二次确认 —— 它随时可以反悔（再点一次图挑回来就是原样），
       而 Confirm.arm 会把按钮文字换成「确认…」，连带抹掉里面那张缩略图。 */
    head.querySelector('[data-act=scpic]').onclick = e => {
      e.stopPropagation();
      if (e.target.closest('[data-act=scpicclear]')) { clearScenePic(sc); return; }
      pickScenePic(sc);
    };
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
    blk.appendChild(head);
    sc.shots.forEach((sh, xi) => {
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
        <div class="smeta">${statusTxt}${durTxt}</div></div>
        <div class="ops">
          <button class="op-btn grip" title="按住拖动排序">${icon('grip', 12)}</button>
          <button class="op-btn dup" title="复制镜头">${icon('copy', 12)}</button>
          <button class="op-btn del danger" title="删除镜头">${TRASH_SVG}</button>
        </div>`;
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
      it.onclick = () => { proj.curScene = si; proj.curShot = xi; renderAll(); };
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
      blk.appendChild(it);
    });
    box.appendChild(blk);
  });
  $('scCount').textContent = n;
  updateProjUI();
}

/* ---------- 渲染：中栏 ---------- */
let midEditTrim = false;   // 剪辑模式（本镜 / 全片 是它的子菜单）
/* 「全片」这一档只有在剪辑模式打开时才算成立：本镜/全片那两个标签就在剪辑面板里，
   关掉剪辑后 proj.tlTab 还留着 'film' —— 只看它的地方会把界面停在「全片」那套逻辑上
   （以前两处各写一种判断，一处带 midEditTrim、一处不带，表现就是关掉剪辑还在按全片走）。 */
const isFilmMode = () => midEditTrim && proj.tlTab === 'film';
let midOrder = true;       // 顺序模式：下方显示镜头缩略图，可拖动排序（默认打开）
/* 打开 / 关掉剪辑模式只有一个出口：旗标 + 收甲板 + 中栏 + 右栏四件事必须一起做，漏一件就是
   「中栏已经换成轨道、右栏还停在镜头编辑器」或「甲板收掉了但后台还在解码发声」。
   页面里裸写 `midEditTrim = …` 的地方从此只有这一处。 */
function setTrimMode(on) {
  midEditTrim = !!on;
  if (midEditTrim) midOrder = false;
  /* 退出剪辑就收掉那两个甲板：留着会在后台接着解码（声音也跟着响），
     而界面上已经没有它们的位置了。 */
  else TlPlay.destroy();
  renderMid();
  /* 右栏同一次点完就要跟着换（用户点名的形状）：只调 renderMid 只换中栏，
     右栏还停在镜头编辑器上，看起来像「剪辑模式没打开」。 */
  renderEditor();
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
  TlPlay: TlPlay,
  projOf: () => proj,
  allShots: (...a) => allShots(...a),
  curScene: (...a) => curScene(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  shotDurText: (...a) => shotDurText(...a),
  trimStatus: (...a) => trimStatus(...a),
  shotReady: (...a) => shotReady(...a),
  totalDur: (...a) => totalDur(...a),
  undoStack: undoStack,
  redoStack: redoStack,
  UNDO_MAX_BYTES: UNDO_MAX_BYTES,
  UNDO_MAX_COUNT: UNDO_MAX_COUNT,
  undoMeterText: (...a) => undoMeterText(...a),
  undo: (...a) => undo(...a),
  redo: (...a) => redo(...a),
  candDur: (...a) => candDur(...a),
  filmFrames: (...a) => filmFrames(...a),
  shotFrames: (...a) => shotFrames(...a),
  shotPinT: (...a) => shotPinT(...a),
  shotAxTotal: (...a) => shotAxTotal(...a),
  cutSegIdx: (...a) => cutSegIdx(...a),
  dragBusy: (...a) => dragBusy(...a),
  reanchorVoices: (...a) => reanchorVoices(...a),
  tlCutTarget: (...a) => tlCutTarget(...a),
  tlVoiceHit: (...a) => tlVoiceHit(...a),
  voiceMin: () => VOICE_MIN,
  laneHidden: (...a) => laneHidden(...a),
  rowFlagToggle: (...a) => rowFlagToggle(...a),
  addLaneRow: (...a) => addLaneRow(...a),
  dropLaneRow: (...a) => dropLaneRow(...a),
  laneMuteToggle: (...a) => laneMuteToggle(...a),
  tlSyncFromShots: (...a) => tlSyncFromShots(...a),
  setLaneVol: (...a) => setLaneVol(...a),
  laneToggle: (...a) => laneToggle(...a),
  runCut: (...a) => runCut(...a),
  setTrackVol: (...a) => setTrackVol(...a),
  syncTlTools: (...a) => syncTlTools(...a),
  filmEdited: (...a) => filmEdited(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  thumbKey: (...a) => thumbKey(...a),
  shotStatusOf: (...a) => shotStatusOf(...a),
  candThumbInner: (...a) => candThumbInner(...a),
  candPlaceholder: (...a) => candPlaceholder(...a),
  candAddTile: (...a) => candAddTile(...a),
  midCandExpandOf: () => midCandExpand,
  tlPlayheadOf: () => tlPlayhead,
  bindTlPlay: (...a) => bindTlPlay(...a),
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
  isFilmMode: (...a) => isFilmMode(...a),
  midOrderOf: () => midOrder,
  setTrimMode: (...a) => setTrimMode(...a),
  curDraftCand: (...a) => curDraftCand(...a),
  paintPin: (...a) => paintPin(...a),
  setPin: (...a) => setPin(...a),
  paintTrimRow: (...a) => paintTrimRow(...a),
  laneRowCtlHTML: (...a) => laneRowCtlHTML(...a),
  laneRowBtnsHTML: (...a) => laneRowBtnsHTML(...a),
  tlScrollWantOf: () => tlScrollWant,
  tlZoomBy: (...a) => tlZoomBy(...a),
  tlZoomWheel: (...a) => tlZoomWheel(...a),
  tlZoomAuto: (...a) => tlZoomAuto(...a),
  tlZoomSetPos: (...a) => tlZoomSetPos(...a),
  tlZoomCommit: (...a) => tlZoomCommit(...a),
  renderTimeline: (...a) => renderTimeline(...a),
  shotAxText: (...a) => shotAxText(...a),
  filmApplyAt: (...a) => filmApplyAt(...a),
  stepShot: (...a) => stepShot(...a),
  syncGenGate: (...a) => syncGenGate(...a),
  syncAtBack: (...a) => syncAtBack(...a),
  renderEditor: (...a) => renderEditor(...a),
  openLibDlg: (...a) => openLibDlg(...a),
  renderAll: (...a) => renderAll(...a),
  setStatus: (...a) => setStatus(...a),
  setTlPlayhead: v => { tlPlayhead = v; },
  setMidOrder: v => { midOrder = v; },
  setTlScrollWant: v => { tlScrollWant = v; },
}, document, window);
const {
  promptTextOf,
  paintPromptBox,
  playerEmptyText,
  updateArBadge,
  renderMid,
} = Mid;
/* 在轨道上拖完一下（上下拖 = 换行，左右拖 = 换顺序）之后，紧跟的那一次 click 不许再被当成
   「在这里放插针」。判据只有一个时刻：拖完 350ms 内的点击一律让路（与配音那一路的 voiceWasDragged
   同一立场，但那边是「选中 + 试听」在块自己的 handler 里，这边要挡的是 `.tl-bar` 上那个整排共用的放针点击）。 */
let trackDragT = 0;
const trackDragged = () => (Date.now() - trackDragT) < 350;
/* 画面那一排的「一行有多高」（上下拖换行的换算）：不能写死 52 ——
   轨道收起时那一行是 18px，写死的话在收起的状态下拖一下会跳好几行。
   量的是**这一行自己的高度 + 父容器的行间距**；本镜（`.tl-vrow`）与全片（`.tl-film`）是同一种行，
   两条轨共用这一个函数（各写一份的话，其中一条轨的行距迟早和另一条不一样）。 */
function picLaneStep(row) {
  const h = row.getBoundingClientRect().height || 52;
  const cs = row.parentElement ? getComputedStyle(row.parentElement) : null;
  return Math.max(14, h + (Number.parseFloat((cs && cs.rowGap) || '20') || 20));
}
/* 拖动某一格时跟着指针走的那张小卡（用户点名的第 ⑧ 条：拖片段要有**片段缩略图**示意）。
   挂在 `document.body` 上、`position:fixed`：轨道 `.tl-bar` 是横向滚动容器，画在它里面的卡片会被
   overflow 裁掉，而这一张要跟着鼠标出得去轨道。
   图只从**被点那一格已经解出来的切片**里拿（`.frs > .fr` 的那张 background-image），配音块则拿它自己那份
   波形（`.wv-box > svg`）—— 拖动中途不重新解码：
   取不到就只写名字与秒数（宁可少一张图，也不让一次拖动等一趟解码），名字用的是格子上那行小字本身，
   不另拼一句（否则拖起来看到的名秒与松手后格子上的对不上）。
   松手一定要 `dragGhostHide()`：漏一次就等于屏幕上留一张跟在手上的孤儿卡。 */
let dragGhostEl = null, dragGhostCell = null;
/* 跟手卡上的那张图：只用**被拖这一块自己**已经解出来的切片（画面格），配音块用它自己那份波形。
   字幕块与待生成占位没有图 —— 它们长出自己的那一张卡（`.tl-ghost.sub` / `.tl-ghost.pend`）：
   借一格画面来显示「一句话」，等于把手里拿的东西说成别的。
   拖动中途一律不发起解码：取不到就留虚线占位（宁可少一张图，也不让一次手势等一趟解码），
   名字用的是块上那行字本身，不另拼一句（否则拖起来看到的与松手后格子上的对不上）。
   同一块拖动中只量一次（缓存挂在节点上）：待生成占位的秒数每帧都在变，图不必每帧重找。 */
function ghostSliceOf(cell) {
  if (cell && cell.__ghostBg !== undefined) return cell.__ghostBg;
  const own = cell && cell.querySelector ? cell.querySelector('.frs > .fr') : null;
  const bg = (own && !own.classList.contains('none') && own.style && own.style.backgroundImage) || '';
  if (cell) cell.__ghostBg = bg;
  return bg;
}
/* 这一块是哪一类：只有「自己带图」的画面格与配音块之外才需要换一张卡的样子。 */
function ghostKindOf(cell) {
  const c = cell && cell.classList;
  if (!c) return '';
  if (c.contains('tl-sub')) return 'sub';
  if (c.contains('tl-vp')) return 'pend';
  return '';
}
function dragGhostShow(ev, cell, label) {
  if (!dragGhostEl) {
    dragGhostEl = document.createElement('div');
    dragGhostEl.className = 'tl-ghost';
    dragGhostEl.appendChild(document.createElement('i'));
    dragGhostEl.appendChild(document.createElement('span'));
    document.body.appendChild(dragGhostEl);
  }
  const im = dragGhostEl.firstChild;
  /* 图与卡的样子只在这一趟拖动第一次进来时定（`dragGhostCell` 记住它是哪一块）：
     待生成块拖动中每帧都调这里更新秒数，重新找图会把一次手势拖成上百次布局查询。 */
  if (dragGhostCell !== cell) {
    dragGhostCell = cell;
    const kind = ghostKindOf(cell);
    dragGhostEl.className = 'tl-ghost' + (kind ? ' ' + kind : '');
    im.style.backgroundImage = '';
    im.textContent = '';
    im.classList.remove('no');
    if (!kind) {
      /* 拖的是一句配音：放它自己那份波形（克隆节点，不重解码也不重算包络 ——
         波形还没后台填出来时 `.wv-box` 是空的，跟着下面那一支走虚线占位）。 */
      const wv = cell && cell.querySelector ? cell.querySelector('.wv-box > svg') : null;
      if (wv) im.appendChild(wv.cloneNode(true));
      else {
        const bg = ghostSliceOf(cell);
        im.style.backgroundImage = bg;
        im.classList.toggle('no', !/^url\(/.test(bg));
      }
    }
  }
  dragGhostEl.lastChild.textContent = String(label || '');
  dragGhostMove(ev);
}
function dragGhostMove(ev) {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = Math.round((Number(ev.clientX) || 0) + 16) + 'px';
  dragGhostEl.style.top = Math.round((Number(ev.clientY) || 0) + 18) + 'px';
}
function dragGhostHide() {
  if (!dragGhostEl) return;
  dragGhostEl.remove();
  dragGhostEl = null;
  dragGhostCell = null;
}
/* 时间线两端的把手：拖的是**这一段自己**的入点 / 出点（不再是整条候选的并集）。
   拖动过程中只改样式，松手才写数据 —— 整块重画会把正在拖的那个节点销毁（原来就是这样，保持）。
   ⚠ 拖动全程**不碰剪针、也不碰播放器**：针是「上一次点在哪」的落点，把手改的是这一段的入出点，
   两件事没有因果关系。以前每一次 pointermove 都 `pl.currentTime = …; pl.pause()`，于是
   「拖一次把手 = 把正在看的那一镜换掉 + 中断播放 + 针跟着手走」，而预览跟着 seek 闪一下。 */
function bindSegDrag(row, sh, c, total, G) {  /* 拖动中就地重画：这一格的 `left`/`width` 跟着选区当场变窄变宽，
     它后面每一格在轴上整体前移 —— 与参考项目一样「块跟着手指缩扩」，剪掉的头尾根本不画。
     只动 inline style：切片不重新解码、节点不销毁，松手整栏重画时才补那几帧。
     分母用**拖动前**的轴长 `ax0`：中途刻度尺不动，格子在右端溢出一点，比整排跟着尺子抖要好。 */
  const ax0 = shotAxTotal(G, total);
  const segsPaint = () => {
    const bar = row.parentElement;
    if (!bar) return;
    shotFrames(segsOf(c, total)).rows.forEach(rr => {
      const cell = bar.querySelector('.tl-seg[data-seg="' + rr.i + '"]');
      if (!cell) return;
      cell.style.left = pct(rr.start, ax0) + '%';
      cell.style.width = pct(rr.w, ax0) + '%';
      /* 名称行是三段结构（名字 / 时长 / 静音钮）：拖动中只换时长那一格 ——
         整行 textContent 会把静音钮一起写掉。 */
      const durEl = cell.querySelector('.lab-dur');
      if (durEl) durEl.textContent = (window.Wb && window.Wb.fmtClock) ? window.Wb.fmtClock(segFilmLen(rr.s)) : (round1(segFilmLen(rr.s)) + 's');
      else { const lab = cell.querySelector('.lab'); if (lab) lab.textContent = segLabel(rr.i, rr.s); }
    });
  };
  const commit = (before) => {
    /* `before` 必须是**拖动之前**那一份段列表：reanchorVoices 要把「旧的相对秒」还原成源里的绝对秒，
       传拖动之后的那一份（那就是 segsOf 现在的返回值）等于新旧同一份 —— 配音看着挪了、账其实没动。 */
    const now = segsOf(c, total);
    const moved = reanchorVoices(sh, c, before, now);   // 端点还在自己段内，绝对时刻不变 → 只是重新落位
    setStatus(trimStatus(sh, c, moved ? '有 ' + moved + ' 句配音被切到段外，已挪到下一段开头' : ''));
    filmEdited();
  };
  row.querySelectorAll('.cut').forEach(el => {
    const i = Number(el.dataset.seg);
    const edge = el.dataset.edge;
    el.title = isImageSeg(segsOf(c, total)[i])
      ? (edge === 'l' ? '拖左把手改这张图从哪儿开始（时长跟着变）' : '拖右把手改这张图占多久')
      : (edge === 'l'
        ? '拖这里改这一段的开头：向右把片头剪掉，向左放回来（最多回到源视频 ' + round1((segsOf(c, total)[i] || {}).a) + ' 秒）'
        : '拖这里改这一段的结尾：向左把片尾剪掉，向右放回来（最多回到源视频 ' + round1((segsOf(c, total)[i] || {}).b) + ' 秒）');
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      /* `.act` = 参考项目里 `has-selected-edit-point` 那一档：手里握着哪一根，那一根就加粗发光。
         以前是绑定那一刻 `add('drag')` —— 于是每一根把手**永久**是加粗那档，界面上看不出「在拖谁」。 */
      el.classList.add('act');
      const before = segsCopy(segsOf(c, total));   // 拖动之前的那一份
      /* 尺子取**整条内容层**（这一排的 100% 宽 = 轴总长 `ax0`），锚在拖动前那一格的
         「轴起点 + 选区起点」上按倍速摊开：格子现在画的就是选区，把手在格子边缘之外还能往回走，
         那正是「把剪掉的头尾放回来」—— 所以这里不许夹 0–1，也不许用格子自己的矩形。
         （从前拿格子矩形当尺子是成立的，因为那一格画的是框 [a,b]；改成画选区之后那把尺子就短了一截。） */
      const seg0 = segsOf(c, total)[i] || {};
      const a0 = Number(seg0.a) || 0, b0 = Number(seg0.b) || 0;
      const r0 = (G.rows || [])[i] || {};
      const in0 = r0.in == null ? (Number(seg0.in) || a0) : r0.in;
      const spd0 = Number(r0.spd) || 1;
      const start0 = Number(r0.start) || 0;
      const rect = (row.parentElement || row).getBoundingClientRect();
      const move = ev => {
        const tAx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * ax0;
        const raw = round1(in0 + (tAx - start0) * spd0);
        const list = segsCopy(segsOf(c, total));
        const s = list[i]; if (!s) return;
        if (isImageSeg(s)) {
          /* 图片段没有「框内选区」：左把手改起点、右把手改终点，两头一起决定它在成片里占多久。
             下限夹在视频总长之外（`segsOf` 认虚拟坐标的判据是 `a ≥ total + 0.05`），
             并与前后虚拟段留 0.02 秒的缝 —— 两张图的坐标不许叠在一起，插针才有唯一答案。 */
          const T = Math.max(0.1, Number(total) || 0);
          if (edge === 'l') {
            let lo = round1(T + 0.1);
            for (let j = 0; j < i; j++) {
              if (isVirtualSeg(list[j])) lo = Math.max(lo, round1((Number(list[j].b) || 0) + 0.02));
            }
            const a2 = round1(Math.max(lo, Math.min(raw, s.b - SEG_MIN)));
            s.a = a2; s.in = a2;
          } else {
            let hi = Infinity;
            for (let j = i + 1; j < list.length; j++) {
              if (isVirtualSeg(list[j])) { hi = round1((Number(list[j].a) || 0) - 0.02); break; }
            }
            const lo = round1(s.a + SEG_MIN);
            const b2 = round1(Math.max(lo, Math.min(isFinite(hi) ? hi : lo + 600, raw)));
            s.b = b2; s.out = b2;
          }
          c.segs = list;                       // 拖动期间只动 segs（trimS/trimE 在松手时统一回写）
          segsPaint();
          return;
        }
        /* 选区夹在**框**里：拖左手柄拖不出框的左沿（a0），右手柄拖不出右沿（b0）。
           没有这一道的话，把把手拖到框外会让这一格和相邻格叠在一起 —— 而框存在的意义
           就是「这一格只在自己那一块里动」（放回来最多放到这儿，不再多了）。 */
        const t = Math.max(0, Math.min(total, Math.max(a0, Math.min(b0, raw))));
        if (edge === 'l') {
          s.in = Math.max(s.a, Math.min(t, s.out - SEG_MIN));
        } else {
          s.out = Math.min(s.b, Math.max(t, s.in + SEG_MIN));
        }
        c.segs = list;                       // 拖动期间只动 segs（trimS/trimE 在松手时统一回写）
        segsPaint();
      };
      const up = () => {
        el.classList.remove('act');
        segsWrite(c, total, segsOf(c, total));
        commit(before);
      };
      dragOnWindow(move, up);
    });
  });
  /* 上下拖画面格 = 换行（`s.ln`，与配音那一路同一个手势、同一套记账）。
     拖动中只 translateY，松手才写数据 + 整栏重画 —— 把手指底下的节点在拖动中途销毁不得。
     ⚠ 换行**不改时间**：格子从不重叠，多出来的行只是排版（进成片看的是时间线，不是第几行），
     所以这里一个字都不碰 in/out/a/b，也不动 reanchorVoices 那笔账。
     松手之后紧跟而来的那一次 click 不算「放插针」（见 trackDragged）—— 用户拖的是行。 */
  row.querySelectorAll('.tl-seg').forEach(el => {
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('.cut')) return;               // 把手那一路自己管它的拖动
      if (rowLocked('pic', Number(row.dataset.ln) || 0)) return;  // 这一行锁着就一个手势都不接（别的行与另一轨照旧）
      const i = Number(el.dataset.seg);
      const ln0 = picLnOf(segsOf(c, total)[i]);
      const y0 = e.clientY, x0 = e.clientX;
      /* 行距不能写死 52：轨道收起时那一行是 18px，写死的话在收起的状态下拖一下会跳好几行
         （`picLaneStep` —— 与全片那一排同一个换算，两条画面轨不许各自量一份）。 */
      const step = picLaneStep(row);
      let lnWant = ln0, moved = 0;
      const move = ev => {
        const dy = ev.clientY - y0, dx = ev.clientX - x0;
        /* 只在**竖直位移更大**时算换行：横向拖动时难免上下偏一点，那时按横向为准 */
        if (Math.abs(dy) < 6 || Math.abs(dy) < Math.abs(dx)) return;
        if (!moved) dragGhostShow(ev, el, (el.querySelector('.lab') || {}).textContent);
        else dragGhostMove(ev);
        moved = 1;
        lnWant = laneClamp(ln0 + Math.round(dy / step));
        el.style.transform = 'translateY(' + round1((lnWant - ln0) * step) + 'px)';
      };
      const up = () => {
        el.style.transform = '';
        dragGhostHide();
        if (!moved) return;
        trackDragT = Date.now();
        if (lnWant === ln0) {
          /* 绕回原来那一行：一个数都没改，不许打「✓ 挪到了」（与配音那一路同一句纪律） */
          setStatus('<span class="info">这一段拖回了画面轨第 ' + (ln0 + 1) + ' 行，位置没变</span>');
          return;
        }
        if (!setCellLane(sh, c, i, lnWant)) return;
        setStatus('<span class="ok">✓ 第 ' + (i + 1) + ' 段挪到了画面轨第 ' + (lnWant + 1) + ' 行'
          + '（只是排版：进成片的顺序、时长与切片一个字没动；这一行的音量在右栏那张卡上调）</span>');
        filmEdited();
      };
      e.preventDefault(); e.stopPropagation();
      dragOnWindow(move, up);
    });
  });
}
/* 轨道取帧用的地址：候选的 url 常是上游签名外链，必须先过 Api.mediaSrc 换成同源回环（AGENTS §4.1） */
const candTrackSrc = c => {
  const src = c && (c.src || c.url);
  if (!src) return '';
  const EM = window.EditorMedia;
  return EM ? EM.previewSrc(c) : Api.mediaSrc(src);
};
/* 段格上那行小字：没被剪过就写「第 N 段 · 3s」（与从前一字不差）；
   剪过（框比选区大）就把两个数都写出来 —— 「保留 3s（共 5s）」= 这一格里
   真正进成片的 3 秒，以及这一格在源里分到的 5 秒（剩下 2 秒剪掉了、把手最多往外拖回到这儿）。
   渲染那一遍与拖动中那一遍共用这一个函数：两处各拼一句，拖起来文字就会跟静下来时不一样。 */
const segLabel = (i, s) => {
  const keep = round1(segLen(s)), box = round1(Math.max(0.01, s.b - s.a));
  /* 黑场与空段照样占时间，所以小字先说清这一格是哪一种「没有画面」—— 只靠格子的底色分不出来（暗画面本来就长那样）。
     两种分开写：`gap` 是「插进来的一段空」（可以整段摘掉），`off && !gap` 是「删掉画面」的黑场
     （再点一次「删掉」就把画面放回来）。混成一个词，用户就分不出「空一段」与「删掉画面」了。
     最后那个 ×倍速：小字前面那两个数（保留 / 共）都是**源秒**，而格子摆的是**这一排的尺子（轴秒）**
     —— 一段升到 2 倍速时格子和「3s」那两个字对不上（它占的轴长只剩一半）。不写这一枚，
     界面上就找不到「源里 3 秒、成片里 1.5 秒」这件事是谁说的。 */
  const gray = s && s.gap ? '空段 · ' : (s && s.off ? '黑场 · ' : '');
  return gray + '第 ' + (i + 1) + ' 段 · '
    + (box - keep > 0.05 ? '保留 ' + keep + 's（共 ' + box + 's）' : keep + 's')
    + (segSpd(s) !== 1 ? ' ' + spdTxt(segSpd(s)) : '');
};

/* 插针跟着落点走（针挂在行上，不在段格子里：段被切开/拖短时针不该跟着段一起挪）。
   顺手维护时间尺左半边（#tlT0 = 插针此刻的秒数）—— 两处读的都是同一份落点。 */
function paintPin(col, t, total) {
  const pin = col.querySelector('#tlBar .tl-pin');
  if (pin) pin.style.left = pct(t, total) + '%';
  const t0 = col.querySelector('#tlT0');
  if (t0) t0.textContent = fmtDur(Math.max(0, Number(t) || 0));
}
/* 本镜轨点到的那一秒（**源秒**）→ 播放计划里的那一秒（`TlPlay.t`）。
   两者不是同一根轴：轨道与针按**这一排的尺子（轴秒 = 各格的选区 ÷ 自己的倍速）**摆，
   传进来的 `src` 是源秒（`bindPinZone` 先折回源秒才交过来，见那里），而计划量的是
   「剪剩的那几秒接起来」（被切掉的头尾不进计划）—— 剪过一刀之后拿源秒去 seek 会落到别的段上。
   折算：保留段按段内偏移 1:1 走（本镜这一档计划不缩倍速，见 `tlPlayPlan` 的 `film:false` 支），
   还在框里但已被剪掉的那一截夹到最近保留的那一头，黑场整格按同一段内偏移走（它本来就占住这几秒）。
   与全片档 `filmSeek` 把焦点夹回选区的立场一致：计划里只有保留区与黑场，
   没有「停在剪掉的那一帧」这回事。 */
function pinFilmTShot(c, sh, src) {
  const total = candDur(c, sh);
  let acc = 0;
  for (const s of segsOf(c, total)) {
    const d = segLen(s);
    if (d <= 0.02) continue;
    const a = Math.max(0, Math.min(total, Number(s.a) || 0));
    const b = Math.min(total, Math.max(a, Number(s.b) || (s.in + d)));
    if (src < a) return acc;                       // 段与段之间的缝（脏数据）：停在这一段的头
    if (src < b) return acc + Math.max(0, Math.min(d, src - s.in));
    acc += d;
  }
  return acc;
}
/* 放插针的点击区 = **整张网格**（轨道名那一列也算），不只是格子：缝里、行上下的空白、
   声音行以外的区域、轨名旁边那块什么都没有的地方，点下去都是「把针挪到这儿」
   （用户点名「轨道上下留一定空余方便在空白地方也点击位置」+「点击没有轨道的地方也应该出现剪辑线」）。
   时刻按**内容层 `.tl-inner`** 的矩形折算 —— 画面行、声音行、刻度尺都是它的 100% 宽，
   所以同一个比例就是同一个秒；从前取的是「第一行」的矩形，于是画面轨收起 / 一行都没画出来时
   整块区域根本点不动，界面看起来是轨道坏了。
   只有把手与轨名栏那几颗按钮不算（红把手与配音那两条边各有自己的拖动；眼睛 / 锁 / ＋ / − 改的是轨道本身）。
   **点在哪一行都放针**（用户点名「点击哪个轨道（无论音频视频）都要能出现」）：
   从前声音整行被当成「不归我管」直接 bail，于是点声音轨的空白什么反应都没有；
   点在一句配音上也放针，但**不把剪辑目标交回画面轨**（那一句的 selectVoice 已经把目标交给配音了，
   针只是走过去给剪刀指位置 —— 与「目标只跟着手走」不冲突，手点的就是这一句）。 */
function bindPinZone(grid, col, sh, pin) {
  /* 先摘掉上一份再绑。整列重建时 `#tlGrid` 是新节点，这一句什么都不做；
     而**缩放只重排 `#tlBar`**（见 tlRescale），这张网格是一直活着的那个节点 ——
     不摘就是每缩一次多叠一层，点一下轨道放 N 次针（与「保住播放器节点要先摘EventListener」同一条规矩）。 */
  if (grid.__pinOff) grid.__pinOff();
  const on = e => {
    /* 显 / 锁 / 加行 / 收行 / 行音量：改轨道，不放针。行音量排上「滑块 + 右边那枚百分数读数」是一件事的两半
       （点数字不等于想把剪针搬过去），所以两个都在排除名单里 —— 只排滑块会留下一个「点上去会跳针」的读数。 */
    if (e.target.closest('.tl-hbtn') || e.target.closest('.tl-hvol-sl, .tl-hvol')) return;
    if (e.target.closest('.cut') || e.target.closest('.vo-cut')) return;    // 把手：拖拽，不挪针
    if (e.target.closest('.sub-cut')) return;                               // 字幕两端的把手：同上
    if (trackDragged()) return;      // 刚把某一格拖去换行 / 换顺序：那不是「在这里放插针」
    /* 别的镜上溢出进来的那一截：它自己的 handler 会把焦点跳到它那一镜（整栏重画），
       这里再按旧几何放一次针就是在跟那次跳转抢方向。 */
    if (e.target.closest('.tl-v.spill')) return;
    /* 待生成占位有自己的点击（写落点 + 换到「生成配音」那一格），
       这里再按旧几何放一次针就是在跟它抢方向。 */
    if (e.target.closest('.tl-vp')) return;
    const onVoice = !!e.target.closest('.tl-v');
    const onPic = !!e.target.closest('.tl-seg');
    /* 点字幕块 = 把针放到点击处，但右栏留在「字幕」那一档（它自己的 click 先一步翻好了）——
       这里再翻回「生成配音」就是「点字幕、右栏却换成写台词」。 */
    const onSub = !!e.target.closest('.tl-sub');
    /* 落点三档，各开各的右栏（用户点名的第 ②③④ 条）：
         · 点中一句配音 → 目标交给声音轨（右栏 = 那一句的音量 / 试听 / 删掉）；
         · 点中一格画面 → 目标交给画面轨（右栏 = 这一段的倍速 / 入出点 / 原声音量）；
         · 点在没有块的地方（空行、轨名、刻度尺）→ 目标也交给声音轨，右栏就是「生成配音」那一张卡。
       第三档是本轮新加的：以前「不在配音块上」一律算点画面，于是在空白处点一下放针，
       右栏却换成画面那几排 —— 想加一句配音的人刚点完落点，那个入口就收了。
       点空白不等于「指着某一格画面」，`onVoice` 那一支仍不写目标（它自己那一路 `selectVoice` 已经写过，
       这里再写一次就是第二份落点）。 */
    const lane = onPic ? 'pic' : (onVoice ? null : 'voice');
    /* 点在没有块的地方 = 「我要加一句」（用户点名的第 ②③④ 条那一档）：
       右栏不仅交给声音轨，还直接翻到「生成配音」那一格 —— 刚放完落点，入口就该在眼前。
       **顺手取消选中那一句**（用户点名的第 ④ 条）：配音文字那一行只在选中某一句时才出现，
       而 `tlVoiceHit` 还认着 `proj.curVoice` —— 不清的话点完空白它仍挂在上一句上。
       目标轨仍是声音（`tlPanel` 只看 `proj.tlLane`），所以那张「加一句配音」的卡照旧打开。 */
    if (lane === 'voice' && !onSub) { vcTab = 'gen'; proj.curVoice = ''; }
    /* 量尺子、折轴秒 / 源秒、写针只有一份（lanes 的 `pinAtX`）：点空白、点画面格、点字幕块、
       点声音行都从这里过。自己在这里再折一遍，必然与待生成占位那一套漂开。 */
    pin(grid, col, sh, e.clientX, { lane: lane });
  };
  grid.addEventListener('click', on);
  grid.__pinOff = () => { grid.removeEventListener('click', on); grid.__pinOff = null; };
}
/* 「剪辑界面正指着哪一段」换了之后的五处联动：格子高亮、入出点那一行、工具条那句提示、右栏落点说明。
   这五处在同一份数据上（proj.cutSeg / proj.cutAt），所以只需要一个出口，不存在「改了 A 忘了 B」。 */
function paintSegFocus(col, sh, c, total) {
  const segs = segsOf(c, total);
  /* 亮环只画「目标那一轨的那一格」：目标是配音时 `picSelAt` 给 -1 → 这里一格都不亮
     （从前它只看 `cutSegIdx()`，于是点一句配音，上面那一格还带着白环 = 上下两排同时亮）。 */
  const i = picSelAt(segs.length);
  col.querySelectorAll('#tlBar .tl-vrow .tl-seg').forEach(el => el.classList.toggle('sel', Number(el.dataset.seg) === i));
  /* 目标交回画面轨那一下（点一格画面 / 点在画面上）也要把配音那一排的亮环收掉 ——
     就地重画只动格子的话，上一句配音会一直亮着，而剪子已经指着这一段了。 */
  paintVoiceSel();
  paintTlHint(col, sh, c);
  paintVoicePos();
  /* 换了指着哪一段，芯片、那一排按钮的句子、入出点那一行和右栏那张卡（音量 / 倍速 / 曲线）一起跟上：
     「切了一格，格子与入出点都变了、滑块还停在上一段的音量」就是少这一行的样子。 */
  syncTlTools();
}
/* 把插针放到指定秒：先记数据（proj.cutAt / proj.cutSeg），再把上面那四处一次跟上。
   点轨道、拖动播放进度、从「全片」跳回来都走这里 —— 剪子读的就是这一份落点。
   `lane` 只在**用户自己的手势**时给：'pic' = 点了一格画面，'voice' = 点在空白处（要生成配音），
   不给 = 不是手点的（播放头跟随、整栏重画、`syncPlayhead`）—— 目标只跟着手走，不跟着播放头走。
   少了这一个参数就是「点了一句配音 → 播放跟随或整栏重画把针推着走 → 目标悄悄交回画面轨」，
   用户接着推滑块调的是画面段而芯片还写着配音（探针 ⑰c2 抓到的正是这一条）。 */
function setPin(col, sh, c, total, t, lane) {
  if (lane) proj.tlLane = lane;      // 点画面 = 交回画面轨，点空白 = 交给声音轨（与 selectVoice 对称，两处各自只改自己那一轨）
  proj.cutAt = round1(Math.max(0, Math.min(total, Number(t) || 0)));
  const segs = segsOf(c, total);
  /* 先按**框**认段，再按选区认：针可以停在灰区里（用户点名的第 ⑥ 条），
     而灰区不属于任何 [in,out) —— 只按选区找会落到「最后一段」，
     于是针在第一段的片头灰区、剪子却指着最后一段，这正是「点灰区看起来没反应」的另一半。 */
  let i = segs.findIndex(s => proj.cutAt >= s.a && proj.cutAt < s.b);
  if (i < 0) i = segs.findIndex(s => proj.cutAt >= s.in && proj.cutAt < s.out);
  if (i < 0 && segs.length) i = segs.length - 1;
  proj.cutSeg = Math.max(0, i);
  /* 交进来的 `t` 与写进去的 `proj.cutAt` 都是**源秒**（剪刀、入出点那两框、配音锚点全按它算），
     画针时折算成这一排的轴秒 —— 一处口径（`shotPinT`），别让针与格子各走一根轴。 */
  const G = shotFrames(segs);
  paintPin(col, shotPinT(G, proj.cutAt), shotAxTotal(G, total));
  paintSegFocus(col, sh, c, total);
}
/* 工具条右边那行小字：插针在哪、这一条留了几秒、配音几句、剪完进不进成片 ——
   全片那一排格子与左栏时长读的都是同一份 c.segs，所以这里不需要再说第二遍。
   全片页签多一句「成片第几秒」：那一栏的插针按成片秒走，与剪刀指着的源秒是两件事，
   混成一句话就会读出「针在 12 秒、剪的是 3 秒」这种对不上的感觉。 */
function paintTlHint(col, sh, c) {
  const el = col && col.querySelector('#tlHint');
  if (!el) return;
  if (!sh) { el.textContent = '先挑一个镜头'; return; }
  if (!c) { el.textContent = '这一镜还没有候选，剪不了'; return; }
  /* 这一行只报三个数：落在哪一秒、第几格 / 第几段、这条候选留了多少。
     以前它把同一件事说两遍（「插针 0 秒」与「全片轨 0 秒」是两个轴却都叫秒、
     「这一段 15 秒」就是「源里 0–15 秒」那一段的长度），末尾还挂一句解释性的长话 ——
     整行九十多字，用户点名的第 7 条。「为什么这个页签报格、那个报段」写在 `tlFocusPos` 那里，只有一份。
     这一格在源里的头尾**不在这里报**：下面那一行「保留片段 __ – __」给的就是同两个数（`paintTrimRow`），
     一处改了两处就得跟着同步，少同步一次界面自己打架。 */
  const p = tlFocusPos();
  const total = candDur(c, sh);
  /* 这一行说的两个秒数都是**这一排的尺子**（轴秒）：针那一个要和画出来的位置对上，
     「留 / 总」那一对要和对右边刻度的格子对上。倍速 ≠ 1 时它们与源秒不是一回事，
     而源秒那两个数下面那一行「保留片段 __ – __」已经报了（它写明是源视频里的秒数）。 */
  const G = shotFrames(segsOf(c, total));
  const ax = shotAxTotal(G, total);
  const vs = shotVoices(sh.id, c.vid);
  const parts = [];
  /* 针那一秒只在它有意义的时候说：全片那一排里找不到这一格时（这一条候选没进成片），
     「全片几秒」本来就是这一格的位置 —— 少说这一句，芯片那句「不在全片那一排」就是全部。 */
  /* 读数读的是**数据里那一秒**（`proj.cutAt`），不是播放器此刻的 `currentTime`：两者本该是同一个数，
     但播放器还没加载 / 这条素材取不到字节时 `currentTime` 恒为 0，于是「针画在灰区里、读数写着 0 秒」——
     点灰区看起来像没动。播放中 `proj.cutAt` 由 `setPin` 每一帧跟着写，读数照样跟着播放头走。 */
  const pinSrc = round1(Math.max(0, Math.min(total, Number(proj.cutAt) || 0)));
  if (!p.film) parts.push('插针 ' + round1(shotPinT(G, pinSrc)) + ' 秒');
  else if (p.row) parts.push('全片 ' + round1(filmPinT(p.tl, p.G)) + ' 秒');
  parts.push(p.chip + p.sub);
  parts.push('这条留 ' + round1(segsFilmLen(c, total)) + '/' + round1(ax) + ' 秒');
  if (vs.length) parts.push('配音 ' + vs.length + ' 句');
  parts.push(candSelected(sh, c) ? '已选用' : '还没选用：成片仍按选用的那条算');
  el.textContent = parts.join(' · ');
}
/* 入出点 / 这一句起止那一行：画的是「剪辑界面指着的那一个」（配音句优先，其次插针那一段画面），
   不是整条候选的并集。重画挂在 syncTlTools（目标一变它就跟着）：selectVoice / setPin /
   filmApplyAt 三条换目标的路都从那里过 —— 只挂在其中一条路上，就会出现「切了目标、输入框还写着旧的」。
   `col` 可空（selectVoice 手里没有栏）：这一行全页只有一份，退回整页查。
   两个秒数都是**源视频里的秒数**；指着配音时与配音把手的同一套口径
   （`at` 在源秒上量，`dur` 是音频文件秒 ÷ 自己那一档才是源长）。 */
function paintTrimRow(col) {
  const scope = col || document;
  const lab = scope.querySelector('#trimSegLab');
  if (!lab) return;
  const note = scope.querySelector('#trimNote');
  const v = tlVoiceHit();
  if (v) {
    const own = voiceRateOf(v);
    const a = round1(Math.max(0, Number(v.at) || 0));
    const b = round1(a + (Number(v.dur) || 0) / own);
    lab.innerHTML = '正在调<b>这一句配音</b>（念 ' + round1((Number(v.dur) || 0) / own) + ' 秒）：保留片段';
    const is = scope.querySelector('#trimS'), ie = scope.querySelector('#trimE');
    if (is) is.value = a;
    if (ie) ie.value = b;
    if (note) note.textContent = '这是源视频里的秒数；音频自己那一份从第 ' + round1(Math.max(0, Number(v.off) || 0)) + ' 秒起'
      + (own !== 1 ? '（×' + own + ' 倍速）' : '') + '。也可以直接拖块两端的把手';
    return;
  }
  const sh = curShot();
  const cur = chosenCandOf(sh);
  if (!cur) { lab.textContent = '这一镜还没有候选'; if (note) note.textContent = ''; return; }
  const total = candDur(cur, sh);
  const segs = segsOf(cur, total);
  const i = Math.min(segs.length - 1, cutSegIdx());
  const s = segs[i];
  lab.innerHTML = s
    ? `这一条候选剪成 <b>${segs.length}</b> 段，正在调第 <b>${i + 1}</b> 段（这条结果 ${round1(total)} 秒）：保留片段`
    : `这一条候选一段画面都没留（整条 ${round1(total)} 秒）：按 Ctrl+Z 退回剪切之前`;
  const is = scope.querySelector('#trimS'), ie = scope.querySelector('#trimE');
  if (is) is.value = s ? s.in : 0;
  if (ie) ie.value = s ? s.out : 0;
  if (note) note.textContent = '这是源视频里的秒数；也可以直接拖动格子两端的把手';
}

/* 「开始播放，并吞掉自动播放被浏览器拦下的那个拒绝」只有播放层那一份（playback.js），
   这里不再留第二份：同一段实现在两处，改一处另一处就会漂。 */
/* 这几枚是 engine 的状态，只是声明恰好落在被搬走的那一段里：
   整条提到接线之前（模块只读访问器），engine.js 继续持有它们 —— 状态不外迁。 */
let voiceEl = null;
/* VoiceLane域（engine/voice-lane.js）：这一段（2863-3615）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const VoiceLane = createVoiceLane({
  playSafe: playSafe,
  projOf: () => proj,
  allShots: allShots,
  candDur: candDur,
  paintTrimRow: (...a) => paintTrimRow(...a),
  filmFrames: filmFrames,
  axisGray: axisGray,
  frameToSrc: frameToSrc,
  shotFrames: shotFrames,
  shotPinT: shotPinT,
  shotAxTotal: shotAxTotal,
  voiceAxBox: voiceAxBox,
  voiceFilmSpan: voiceFilmSpan,
  voiceAdoptable: voiceAdoptable,
  voiceBlockHTML: voiceBlockHTML,
  voicesEnsure: voicesEnsure,
  shotVoices: shotVoices,
  dragOnWindow: dragOnWindow,
  voiceSelId: voiceSelId,
  picSelOn: picSelOn,
  laneLocked: laneLocked,
  laneHidden: laneHidden,
  rowHidden: rowHidden,
  rowLocked: rowLocked,
  laneNm: laneNm,
  rowNm: rowNm,
  rowLockWhy: rowLockWhy,
  rowUnlockHow: rowUnlockHow,
  laneVol: laneVol,
  laneRowsFor: laneRowsFor,
  LANE_ROW_SEL: LANE_ROW_SEL,
  laneMute: laneMute,
  trackOwnVol: trackOwnVol,
  tlSyncFromShots: tlSyncFromShots,
  voiceVolOf: voiceVolOf,
  focusVoiceShot: focusVoiceShot,
  trackOne: trackOne,
  syncTlTools: syncTlTools,
  filmEdited: filmEdited,
  scheduleSave: scheduleSave,
  dragGhostShow: dragGhostShow,
  dragGhostMove: dragGhostMove,
  dragGhostHide: dragGhostHide,
  voiceElOf: () => voiceEl,
  vcTabOf: () => vcTab,
  audioDurOf: (...a) => audioDurOf(...a),
  setStatus: setStatus,
  setVcTab: v => { vcTab = v; },
  setVoiceEl: v => { voiceEl = v; },
}, document, window);
const {
  playVoicePreview,
  paintVoiceVol,
  orphanVoices,
  orphanVoicesOf,
  adoptWhy,
  adoptOrphanVoices,
  voiceLn,
  lanePut,
  voiceLanesHTML,
  laneRowCtlHTML,
  laneRowBtnsHTML,
  syncLaneSide,
  voiceLaneHTML,
  VOICE_MIN,
  bindVoiceLane,
  paintVoiceSel,
  dropPicSel,
  selectVoice,
} = VoiceLane;

/* SubLane域（engine/sub-lane.js）：右栏字幕清单、两排字幕块与它们的拖动 / 起止输入。
   建在 Lanes 之前（Lanes 的渲染要调它的三个画点）；E 里每一位都包成箭头 ——
   `filmApplyAt` 那几位在 Lanes 解构里才落定，跑起来（拖动 / 点击）时早已初始化。 */
const SubLane = createSubLane({
  projOf: () => proj,
  allShots: (...a) => allShots(...a),
  curShot: (...a) => curShot(...a),
  candDur: (...a) => candDur(...a),
  chosenCandOf: (...a) => chosenCandOf(...a),
  fmtDur: (...a) => fmtDur(...a),
  subCurrent: (...a) => subCurrent(...a),
  subWrite: (...a) => subWrite(...a),
  voicesEnsure: (...a) => voicesEnsure(...a),
  shotFrames: (...a) => shotFrames(...a),
  shotPinT: (...a) => shotPinT(...a),
  shotAxTotal: (...a) => shotAxTotal(...a),
  shotRowAt: (...a) => shotRowAt(...a),
  frameToSrc: (...a) => frameToSrc(...a),
  srcToFrame: (...a) => srcToFrame(...a),
  filmFrames: (...a) => filmFrames(...a),
  tlSyncFromShots: (...a) => tlSyncFromShots(...a),
  shotFilmAt: (...a) => shotFilmAt(...a),
  setPin: (...a) => setPin(...a),
  TlPlayOf: () => TlPlay,
  filmApplyAt: (...a) => filmApplyAt(...a),
  renderEditor: (...a) => renderEditor(...a),
  setStatus: (...a) => setStatus(...a),
  dragOnWindow: (...a) => dragOnWindow(...a),
  dragGhostShow: (...a) => dragGhostShow(...a),
  dragGhostMove: (...a) => dragGhostMove(...a),
  dragGhostHide: (...a) => dragGhostHide(...a),
  setVcTab: v => { vcTab = v; },
}, document, window);

/* ============================================================================
   时间轴的比例尺（与剪映/参考项目同一条路子）
   ---------------------------------------------------------------------------
   以前这里所有东西都按「总时长 = 100% 宽度」摆，于是片子一长格子就被压成一团、
   而且**没法左右滚**（没有可滚的余量）。现在改成工具箱里那两个概念：
     · `pxPerSec`（像素/秒）—— 唯一的比例尺；
     · 内容层 `.tl-inner` 的宽度 = `总时长 × pxPerSec` —— 超出容器就横向滚动。
   行内那些绝对定位的元素**继续用百分比**：它们的父级（行）宽度如今由 pxPerSec 决定，
   所以百分比自动跟着比例尺走，一行代码都不用改。
   ========================================================================== */
/* 缩放的上下限。下限**不是一个写死的像素/秒**：整条内容最短还得点得动（`TL_MIN_W` 像素），
   再缩就没有一格能按了。所以真实下限跟着这一排的总长走 —— 3 秒的候选最多缩到 8px/秒，
   20 分钟的长片能缩到 0.04。这样「读数 / 内容层宽度 / 围绕视野中心那一秒的滚动换算」三处
   永远互相对得上：从前 `tlInnerWidth` 里那句 `Math.max(60, …)` 会让「写着 4 像素/秒、
   实际摊成 60 像素宽」同时成立，而 60 像素是拍脑袋的数，不是算出来的。 */
const TL_MIN_W = 24, TL_MIN_ZOOM = 0.02, TL_MAX_ZOOM = 600;
const tlMinPps = total => Math.max(TL_MIN_ZOOM, TL_MIN_W / Math.max(0.1, Number(total) || 0.1));
/* 「自适应」那档的下限：一部长片在 900px 的栏里铺满等于 3px/秒，格子和刻度会糊成一片，
   所以自适应铺到这一档就停、再长让它左右滚。**手动缩小不受这一档限制**（用户点名：
   不必限制最小，可以缩到不占据整个轨道）。 */
const TL_MIN_PPS = 12;
/* 用户手动缩放过就记住（`dir_tl_pps`）；0 = 自适应：短片子铺满、长片子缩到下限再左右滚。 */
let tlPps = (() => {
  /* 走公共的 window.LS：这一行在页面装配期执行，而隐私模式下裸读会抛 ——
     抛出去整页就白屏了（探针 ① 就是这么抓到 readLS 未定义的）；LS.get 把「读不到」统一变成 null。 */
  const v = Number(window.LS.get('dir_tl_pps') || '');
  return v > 0 ? v : 0;
})();
/* 现在生效的像素/秒：手动缩过就按那一档（夹在 `tlMinPps(总长)`～`TL_MAX_ZOOM`），
   没缩过就是「自适应」= 容器多宽铺多满，但不低于 `TL_MIN_PPS`。 */
/* 这几枚是 engine 的状态，只是声明恰好落在被搬走的那一段里：
   整条提到接线之前（模块只读访问器），engine.js 继续持有它们 —— 状态不外迁。 */
let tlScrollWant = -1;
/* Lanes域（engine/lanes.js）：这一段（5187-6069）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Lanes = createLanes({
  $: (...a) => $(...a),
  TlPlayOf: () => TlPlay,
  projOf: () => proj,
  allShots: (...a) => allShots(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  shotDurText: (...a) => shotDurText(...a),
  trimStatus: (...a) => trimStatus(...a),
  tlCandidateOf: (...a) => tlCandidateOf(...a),
  candDur: (...a) => candDur(...a),
  filmFrames: (...a) => filmFrames(...a),
  axisGray: (...a) => axisGray(...a),
  frameToSrc: (...a) => frameToSrc(...a),
  srcToFrame: (...a) => srcToFrame(...a),
  shotFrames: (...a) => shotFrames(...a),
  shotPinT: (...a) => shotPinT(...a),
  shotAxTotal: (...a) => shotAxTotal(...a),
  shotRowAt: (...a) => shotRowAt(...a),
  voiceAxBox: (...a) => voiceAxBox(...a),
  fillWaveforms: (...a) => fillWaveforms(...a),
  videoPeaks: (...a) => videoPeaks(...a),
  drawSegWave: (...a) => drawSegWave(...a),
  fillSegWaveforms: (...a) => fillSegWaveforms(...a),
  voiceBlockHTML: (...a) => voiceBlockHTML(...a),
  cutSegIdx: (...a) => cutSegIdx(...a),
  shotVoices: (...a) => shotVoices(...a),
  dragOnWindow: (...a) => dragOnWindow(...a),
  reanchorVoices: (...a) => reanchorVoices(...a),
  cutPin: (...a) => cutPin(...a),
  beginEdit: (...a) => beginEdit(...a),
  picSelOn: (...a) => picSelOn(...a),
  picSelAt: (...a) => picSelAt(...a),
  laneHidden: (...a) => laneHidden(...a),
  rowHidden: (...a) => rowHidden(...a),
  rowLocked: (...a) => rowLocked(...a),
  laneNm: (...a) => laneNm(...a),
  rowLockWhy: (...a) => rowLockWhy(...a),
  rowUnlockHow: (...a) => rowUnlockHow(...a),
  laneRowsOf: (...a) => laneRowsOf(...a),
  laneRowsFor: (...a) => laneRowsFor(...a),
  setCellLane: (...a) => setCellLane(...a),
  addImageToTrack: (...a) => addImageToTrack(...a),
  moveShotInFilmOrder: (...a) => moveShotInFilmOrder(...a),
  tlSyncFromShots: (...a) => tlSyncFromShots(...a),
  paintTlGroups: (...a) => paintTlGroups(...a),
  syncTlTools: (...a) => syncTlTools(...a),
  sliceForgetFail: (...a) => sliceForgetFail(...a),
  fillSlices: (...a) => fillSlices(...a),
  filmEdited: (...a) => filmEdited(...a),
  subLaneHTML: (...a) => SubLane.subLaneHTML(...a),
  filmSubLaneHTML: (...a) => SubLane.filmSubLaneHTML(...a),
  bindSubLanes: (...a) => SubLane.bindSubLanes(...a),
  chosenCandOf: (...a) => chosenCandOf(...a),
  setPin: (...a) => setPin(...a),
  pinFilmTShot: (...a) => pinFilmTShot(...a),
  sliceUserTouch: (...a) => sliceUserTouch(...a),
  paintTrimRow: (...a) => paintTrimRow(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  renderScenes: (...a) => renderScenes(...a),
  midEditTrimOf: () => midEditTrim,
  trackDragTOf: () => trackDragT,
  picLaneStep: (...a) => picLaneStep(...a),
  dragGhostShow: (...a) => dragGhostShow(...a),
  dragGhostMove: (...a) => dragGhostMove(...a),
  dragGhostHide: (...a) => dragGhostHide(...a),
  bindSegDrag: (...a) => bindSegDrag(...a),
  candTrackSrc: (...a) => candTrackSrc(...a),
  segLabel: (...a) => segLabel(...a),
  paintPin: (...a) => paintPin(...a),
  bindPinZone: (...a) => bindPinZone(...a),
  paintTlHint: (...a) => paintTlHint(...a),
  orphanVoices: (...a) => orphanVoices(...a),
  lanePut: (...a) => lanePut(...a),
  voiceLanesHTML: (...a) => voiceLanesHTML(...a),
  syncLaneSide: (...a) => syncLaneSide(...a),
  voiceLaneHTML: (...a) => voiceLaneHTML(...a),
  bindVoiceLane: (...a) => bindVoiceLane(...a),
  paintVoiceSel: (...a) => paintVoiceSel(...a),
  dropPicSel: (...a) => dropPicSel(...a),
  TL_MAX_ZOOMOf: () => TL_MAX_ZOOM,
  tlMinPps: (...a) => tlMinPps(...a),
  TL_MIN_PPSOf: () => TL_MIN_PPS,
  tlPpsOf: () => tlPps,
  tlScrollWantOf: () => tlScrollWant,
  voiceDraftOf: () => voiceDraft,
  setVcTab: v => { vcTab = v; },
  voiceWayOf: (...a) => voiceWayOf(...a),
  paintVoicePos: (...a) => paintVoicePos(...a),
  voiceReg: (...a) => voiceReg(...a),
  renderEditor: (...a) => renderEditor(...a),
  renderAll: (...a) => renderAll(...a),
  setStatus: (...a) => setStatus(...a),
  setTlPps: v => { tlPps = v; },
  setTrackDragT: v => { trackDragT = v; },
  setTlScrollWant: v => { tlScrollWant = v; },
}, document, window);
const {
  tlZoomBy,
  tlZoomWheel,
  tlZoomAuto,
  tlZoomSetPos,
  tlZoomCommit,
  renderTimeline,
  shotAxText,
  lineLandedNote,
  pendingLineOf,
  openPendingVoice,
  filmPinT,
  filmApplyAt,
} = Lanes;
/* 这几枚是 engine 的状态，只是声明恰好落在被搬走的那一段里：
   整条提到接线之前（模块只读访问器），engine.js 继续持有它们 —— 状态不外迁。 */
let voiceDraft = { text: '', voice: '', format: '', design: '', ref: null, bools: {}, tb: {}, who: '' };
let vcTab = 'list';
/* Voice域（engine/voice.js）：这一段（5297-6269）搬进模块，这里只留访问器包与一条解构。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
const Voice = createVoice({
  projOf: () => proj,
  REGOf: () => REG,
  uid: (...a) => uid(...a),
  allShots: (...a) => allShots(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  candDur: (...a) => candDur(...a),
  voiceFilmWhy: (...a) => voiceFilmWhy(...a),
  cutSegIdx: (...a) => cutSegIdx(...a),
  candSelected: (...a) => candSelected(...a),
  voicesEnsure: (...a) => voicesEnsure(...a),
  shotVoices: (...a) => shotVoices(...a),
  voiceLn: (...a) => voiceLn(...a),
  voiceLanePlan: (...a) => voiceLanePlan(...a),
  addLaneRow: (...a) => addLaneRow(...a),
  tlVoiceHit: (...a) => tlVoiceHit(...a),
  voiceVolOf: (...a) => voiceVolOf(...a),
  setLaneVol: (...a) => setLaneVol(...a),
  setCutVol: (...a) => setCutVol(...a),
  setCutLane: (...a) => setCutLane(...a),
  voiceSplitByMaterial: (...a) => voiceSplitByMaterial(...a),
  voiceMergeAll: (...a) => voiceMergeAll(...a),
  cutSpdSeg: (...a) => cutSpdSeg(...a),
  setCutSpd: (...a) => setCutSpd(...a),
  segLenText: (...a) => segLenText(...a),
  voiceLenText: (...a) => voiceLenText(...a),
  setVoiceSpd: (...a) => setVoiceSpd(...a),
  setTrackSpd: (...a) => setTrackSpd(...a),
  setTrackVoiceSpd: (...a) => setTrackVoiceSpd(...a),
  setTrackVol: (...a) => setTrackVol(...a),
  paintTlGroups: (...a) => paintTlGroups(...a),
  syncTlTools: (...a) => syncTlTools(...a),
  filmEdited: (...a) => filmEdited(...a),
  subAsrBusyOf: () => subAsrBusy,
  shotFilmAt: (...a) => shotFilmAt(...a),
  subCurrent: (...a) => subCurrent(...a),
  subStyleWrite: (...a) => subStyleWrite(...a),
  subGenerate: (...a) => subGenerate(...a),
  subResegment: (...a) => subResegment(...a),
  subExportSrt: (...a) => subExportSrt(...a),
  subImportSrt: (...a) => subImportSrt(...a),
  subAsr: (...a) => subAsr(...a),
  subAddAtPin: (...a) => subAddAtPin(...a),
  subDelete: (...a) => subDelete(...a),
  subSetText: (...a) => subSetText(...a),
  subRowsHTML: (...a) => SubLane.subRowsHTML(...a),
  subSetTime: (...a) => SubLane.subSetTime(...a),
  scheduleSave: (...a) => scheduleSave(...a),
  midEditTrimOf: () => midEditTrim,
  voiceElOf: () => voiceEl,
  playVoicePreview: (...a) => playVoicePreview(...a),
  orphanVoicesOf: (...a) => orphanVoicesOf(...a),
  adoptWhy: (...a) => adoptWhy(...a),
  adoptOrphanVoices: (...a) => adoptOrphanVoices(...a),
  selectVoice: (...a) => selectVoice(...a),
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
   与生成工作台语音栏那颗「AI 润色」是同一个面板、同一句系统提示词 ——
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
  if (!(await TextAI.canRun(REG))) { setStatus('<span class="err">请先到「设置」填写文字 AI 密钥（或在 .env / 系统环境变量里配置）</span>'); return; }
  host.hidden = false;
  const sysBase = TextAI.prompt('audio');
  /* 这一处特有的一句（工作台润的是一整段文本，这里润的是画面上一句台词：要短、要一口气念完）。
     其余那几句对模型的交代走公共实现 `TextAI.polishExtra` / `answersNote`，与生成工作台同一份。 */
  const hint = '这是要给画面配的一句配音：要口语、要短（一口气能念完），不要写解释、不要写旁白提示、'
    + '不要带引号或表情符号，只返回这一句本身。';
  const taskWord = '配音稿（画面上一句台词）';
  const run = async answers => ({
    after: await TextAI.chat(REG,
      TextAI.polishSys(sysBase + ' ' + hint, TextAI.polishExtra({ answers })),
      TextAI.polishUser(taskWord, original)),
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
    return { after: await TextAI.chat(REG, p.sys, p.user), note: '' };
  };
  const old = btn.innerHTML;
  /* 这颗按钮带着图标：`textContent` 会把图标一起抹掉（跑完再恢复就是一次「图标闪一下没了又回来」），
     所以 busy 文案也走 innerHTML，图标尺寸与静态标记那一颗一致。 */
  btn.disabled = true; btn.innerHTML = icon('sparkles', 14) + ' 润色中…';
  try {
    await InlinePolish.interactive(host, {
      ask: TextAI.shouldAsk() ? ask : null, run: run, before: original,
      askTitle: 'AI 想先问几个问题',
      askIntro: '点一个候选；都不合适就点最后一个「其他」自己写（会原样发给 AI）；没答的按默认理解走',
      onFollow: follow,
      followPlaceholder: '还要怎么改？例：再短一点 / 语气急一点 / 数字写成中文读法（写完按回车）',
      onApply: v => {
        ta.value = v;
        voiceDraft.text = v;
        /* 字数闸门跟着重判一次：润完可能变短到这一家的最少字数以下，按钮要当场禁掉
           （与手写时那一条是同一个判据，所以直接调输入框上那个 handler，不另写一份）。 */
        if (typeof ta.oninput === 'function') ta.oninput();
        setStatus('<span class="ok">✓ 已替换这一句（还没合成 —— 改到满意再点「合成并加到这一轨」）</span>');
      },
      onStatus: t => setStatus(t),
    });
  } catch (e) {
    InlinePolish.clear(host);
    setStatus('<span class="err">润色失败：' + esc(String(errText(e))) + '</span>');
  } finally { btn.disabled = false; btn.innerHTML = old; }
}

function stepShot(d) {
  const all = allShots();
  if (!all.length) return;
  const i = all.indexOf(curShot());
  const ni = Math.min(all.length - 1, Math.max(0, i + d));
  const target = all[ni];
  const sc = proj.scenes.find(s2 => s2.shots.includes(target));
  proj.curScene = proj.scenes.indexOf(sc); proj.curShot = sc.shots.indexOf(target);
  renderAll();
}

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
  if (!got) Toast.warn('拿不到这条任务的新下载地址（平台上可能已被清理），播放/导出可能失败：' + (c.name || c.vid));
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
   画幅是**全片一份**：切片、实时预览、导出成片、FCPXML 都读这里，不在别处再推一次。
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
/* 把当前画幅同步到播放器（CSS 变量）。 */
function applyComposition() {
  const size = filmSize();
  try {
    const root = document.querySelector('.page-main');
    if (root) root.style.setProperty('--film-ar', size.w + ' / ' + size.h);
  } catch (e) { /* 拿不到页面根节点就照默认画幅，不改那一个变量 */ }
}

/* ---------- 视频模型与参数：按这一镜的输入推导可用模型 ---------- */
/* 提示词里的 @参考图N = 引用第 N 张素材图；提交前按平台声明的语法转换（未声明就原样提交） */
function applyRefSyntax(prompt, prov) {
  const tpl = prov && prov.refSyntax;
  if (!tpl) return prompt;
  return String(prompt).replace(/@参考图\s*(\d+)/g, (_, n) => tpl.replace('{n}', n));
}
/* 提示词里的 `@名字` → `@参考图N`：名字是给人看的，**平台只认「第几张」**。
   映射来自这一镜的 refMeta（@ 引用时写下的素材名）与 refImages 的下标 —— 与参考图角标、
   「提到素材」那排芯片读的是同一份数据，所以提示词里写的和第几张图永远对得上。
   一次正则替换（名字按长度从长到短排），不做逐名 split：后者会在名字互为前缀时连锁改写。 */
function refTokenize(sh, prompt) {
  const out = String(prompt == null ? '' : prompt);
  if (out.indexOf('@') < 0) return out;
  const meta = Array.isArray(sh.refMeta) ? sh.refMeta : [];
  const map = new Map();
  (sh.refImages || []).forEach((src, i) => {
    const lb = String((meta[i] && meta[i].label) || '').trim();
    if (lb && !map.has(lb)) map.set(lb, i + 1);      // 同名只认第一张（同一条素材本来也只会加一次）
  });
  if (!map.size) return out;
  const names = [...map.keys()].sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return out.replace(new RegExp('@(' + names.join('|') + ')', 'g'), (m, n) => '@参考图' + map.get(n));
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
  candDur: (...a) => candDur(...a),
  filmFrames: (...a) => filmFrames(...a),
  shotFrames: (...a) => shotFrames(...a),
  tlSyncFromShots: (...a) => tlSyncFromShots(...a),
  chainModelList: (...a) => chainModelList(...a),
  ensureChainModel: (...a) => ensureChainModel(...a),
  chainModelWhy: (...a) => chainModelWhy(...a),
  chainWaitWhy: (...a) => chainWaitWhy(...a),
  resolveChainFrame: (...a) => resolveChainFrame(...a),
  filmEdited: (...a) => filmEdited(...a),
  scheduleSave: (...a) => scheduleSave(...a),
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
  pendingLineOf: (...a) => pendingLineOf(...a),
  openPendingVoice: (...a) => openPendingVoice(...a),
  renderVoiceCol: (...a) => renderVoiceCol(...a),
  applyRefSyntax: (...a) => applyRefSyntax(...a),
  pickRefMedia: (...a) => pickRefMedia(...a),
  polishUIOf: () => polishUI,
  setPolishUI: v => { polishUI = v; },
  renderPolishPanel: (...a) => renderPolishPanel(...a),
  polishPrompt: (...a) => polishPrompt(...a),
  toDataURL: (...a) => toDataURL(...a),
  uploadImageDataUrl: (...a) => uploadImageDataUrl(...a),
  openPickDlg: (...a) => openPickDlg(...a),
  kfQOf: () => kfQ,
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
    if (!sh.selId) sh.selId = cand.vid;
    filmEdited();
    setStatus('<span class="ok">✓ 已导入「' + esc(name) + '」为本镜候选'
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
    if (s.ok && !(s.fails || []).length && !s.cant && !s.skip) Toast.receipt('第三方素材已自动存一份到本机（剪辑与导出直接用本机文件）：' + txt);
    else Toast.warn('第三方素材自动存本机：' + txt);
  }).catch(e => console.warn('[director] 自动存本机失败：', errText(e)));
}

/* ---------- 导入 FCPXML（Final Cut Pro / 达芬奇） ----------
   解析全在 `fcpxml-import.js`（纯数据、不碰 DOM）；这里只做「并进工作区、报数、
   把第三方外链存一份到本机」。导入出来的是一份**新短片**，不动当前工程 ——
   用户想回去就在项目菜单里切。找不到文件的段不丢：时间点、入出点都保留，照实报几段。 */
const FCP_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
async function importFcpProject(file) {
  if (!file) return;
  const fname = String(file.name || 'FCPXML 项目');
  if (file.size > FCP_IMPORT_MAX_BYTES) {
    setStatus('<span class="err">「' + esc(fname) + '」' + window.fmtBytes(file.size)
      + '，超过 FCPXML 单文件上限 ' + window.fmtBytes(FCP_IMPORT_MAX_BYTES) + '</span>');
    return;
  }
  setStatus('正在读「' + esc(fname) + '」…');
  let text = '';
  try { text = await file.text(); }
  catch (e) { setStatus('<span class="err">读不了这份文件：' + esc(errText(e)) + '</span>'); return; }
  const r = parseFCPXML(text, { uid, name: fname });
  if (!r.ok) { setStatus('<span class="err">导入失败：' + esc(r.why || '读不出时间线') + '</span>'); return; }
  const p = r.project;
  p.voices = r.voices || [];
  const st = r.stats || {};
  const shots = (p.scenes[0] && p.scenes[0].shots) || [];
  if (!shots.length && !p.voices.length) {
    setStatus('<span class="err">这份 FCPXML 的时间线上没有任何画面或配音，没有可导入的内容</span>');
    return;
  }
  WS.projects.push(p);
  switchProject(p.id);
  sanitize();
  renderAll(); scheduleSave();
  const bits = [st.clips + ' 段画面'];
  if (st.stills) bits.push(st.stills + ' 段图片');
  if (st.gaps) bits.push(st.gaps + ' 段黑场');
  if (st.voices) bits.push(st.voices + ' 句配音');
  if (st.titles) bits.push(st.titles + ' 条字幕');
  const warn = r.warnings || [];
  setStatus('<span class="ok">✓ 已导入「' + esc(p.name) + '」：' + bits.join(' / ') + '</span>'
    + (st.local || st.remote
      ? '<span class="meta">（' + (st.local ? st.local + ' 段素材本机已有' : '')
        + (st.local && st.remote ? '；' : '') + (st.remote ? st.remote + ' 段是第三方外链，正在存一份到本机' : '') + '）</span>'
      : '')
    + (warn.length
      ? '<span class="err">；有 ' + warn.length + ' 段素材找不到文件（时间点都保留了）：'
        + esc(warn.slice(0, 3).join('；')) + (warn.length > 3 ? ' 等' : '') + '</span>'
      : ''));
  const jobs = [];
  shots.forEach(sh => (sh.candidates || []).forEach(c => {
    if (!needsLocal(c.url)) return;
    jobs.push({
      entry: { kind: 'asset', provider: c.provider || 'remote', src: c.url, name: c.name || sh.name },
      name: sh.name || c.name || '素材',
      /* 图片段的画面地址在段上（`segs[].img`），不在候选的 `url`：只改后者的话
         「存一份到本机」之后那一格仍在读原外链，链接一过期就成了空图。 */
      apply: url => {
        const before = c.url;
        c.url = url; c.local = true;
        (c.segs || []).forEach(s => { if (s && typeof s.img === 'string' && s.img === before) s.img = url; });
        scheduleSave();
      },
    });
  }));
  (p.voices || []).forEach(v => {
    if (!needsLocal(v.src)) return;
    jobs.push({
      entry: { kind: 'asset', provider: 'remote', src: v.src, name: v.name },
      name: v.name || '配音',
      apply: url => { v.src = url; scheduleSave(); },
    });
  });
  autoLocalize(jobs);
}

/* ---------- 最近导出（本次页面会话的账本） ----------
   一次导出就是一份文件（成片或分开的素材段）。这里给两条出口：下载到本机、
   复制一份进本机资产库（字节取自本次会话缓存里的那一份）。
   `filmIsCurrent()` 仍是导出前的判据；这条弹窗只处理「已经导出的那份」。 */
async function openRecentExports() {
  /* 最近导出 = 本次页面会话的账本（Export.sessionExports）。浏览器内合成没有代理账本，
     服务端渲染目录已经删了 —— 刷新之后这里就是空的，再导一次又会有。 */
  const jobs = Export.sessionExports();
  await UiDialog.open({
    title: '最近导出',
    sub: '本次页面会话里导出过的文件。带下载按钮的是这一轮刚合成的成片；素材在导出时已经交给浏览器下载（到下载目录找）。',
    body(el) {
      if (!jobs.length) {
        el.innerHTML = '<div class="rx-empty">本次会话还没有导出记录。点页头「导出成片」或「导出素材」后，这里会出现那一份。</div>';
        return;
      }
      el.innerHTML = '<div class="rx-list">' + jobs.map((j, i) => {
        const can = Export.filmBlobOf(j.name);
        const parts = [
          { s: window.fmtWhen(j.at) },
          { s: j.bytes ? window.fmtBytes(j.bytes) : '' },
          { s: j.kind },
        ].filter(x => x.s);
        const meta = parts.map(x => esc(x.s)).join(' · ');
        return '<div class="rx-row" data-i="' + i + '">'
          + '<div class="rx-main"><div class="rx-name">' + esc(j.name || '未命名') + '</div>'
          + '<div class="rx-meta">' + meta + '</div></div>'
          + '<div class="rx-ops">'
          + (can ? '<button class="op-btn" data-dl="' + i + '" title="再下载一次这一份">' + icon('download', 13) + '</button>' : '')
          + (can ? '<button class="op-btn" data-save="' + i + '" title="复制一份进本机资产库，之后在素材库/资产库都能找到">' + icon('box', 13) + ' 存资产库</button>' : '')
          + '</div></div>';
      }).join('') + '</div>';
      el.querySelectorAll('[data-dl]').forEach(b => {
        b.onclick = async () => {
          const j = jobs[Number(b.dataset.dl)];
          if (!j) return;
          const blob = Export.filmBlobOf(j.name);
          if (!blob) return Toast.err('这一份字节不在本次会话里了（刷新过就没了）：再导一次即可');
          saveBlob(j.name || 'export.mp4', blob);
          Toast.receipt('已开始下载 ' + (j.name || ''));
        };
      });
      el.querySelectorAll('[data-save]').forEach(b => {
        b.onclick = async () => {
          const j = jobs[Number(b.dataset.save)];
          if (!j) return;
          const blob = Export.filmBlobOf(j.name);
          if (!blob) return Toast.err('这一份字节不在本次会话里了：再导一次即可');
          b.disabled = true; b.textContent = '保存中…';
          try {
            const b64 = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result).split(',')[1] || '');
              fr.onerror = () => rej(new Error('读不出字节'));
              fr.readAsDataURL(blob);
            });
            /* 类型跟文件名 / 字节走：成片没有 H.264 时导出来的是 .webm（选容器在 MediaExport.pickCodec）。 */
            const fmt = (String(j.name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4';
            await Api.saveLocalAsset({
              name: j.name, mime: blob.type || (fmt === 'webm' ? 'video/webm' : 'video/mp4'), format: fmt, data: b64,
              meta: { provider: 'local', prompt: String(j.name || '').replace(/\.[^.]+$/, '') },
            });
            b.textContent = '已存资产库';
            Toast.receipt('已存进本机资产库：' + (j.name || ''));
          } catch (e) { b.disabled = false; b.textContent = '存资产库'; Toast.err(errText(e)); }
        };
      });
    },
    actions: [{ label: '关闭', value: null }],
  });
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
    title: '导入视频作为本镜画面（资产库 / 收藏 / 本地文件）',
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
        if (!sh.selId) sh.selId = cand2.vid;
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
    if (!sh.selId) sh.selId = cand.vid;
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
async function pickRefMedia(sh, kind) {
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
  const list = await AssetPicker.open({
    types, multiple: false, limit: 1,
    /* 这一镜的参考视频 / 参考音频**各只有一格**（提交体是 body.reference_video = { asset_id }），
       所以规则里的数量按 1 显示 —— 平台声明的 max 再大也没地方放，照抄会出现
       「弹窗写『还能加 1 个』、却又只能点一张」。类型与体积上限仍照平台声明走。 */
    rule: Object.assign({}, rule, { max: 1 }),
    title: '选择' + label + '（来自资产库，也可上传本地文件' + (note ? '，' + note : '') + '）',
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
/* 润色要附带的素材图：编号与提示词里的 @参考图N 对齐（参考图 → 首帧 / 尾帧 → 时间切片画面） */
function polishImageList(sh) {
  const out = [];
  (sh.refImages || []).forEach((src, i) => out.push({ label: '参考图 ' + (i + 1), src }));
  if (sh.firstFrame) out.push({ label: '首帧（开头画面）', src: sh.firstFrame });
  if (sh.lastFrame) out.push({ label: '尾帧（结尾画面）', src: sh.lastFrame });
  (sh.keyframes || []).filter(k => k.assetId).forEach(k => {
    const src = Api.assetSrc(k.assetId);
    if (out.some(x => x.src === src)) return;          // 已经作为参考图列过就不重复
    out.push({ label: '时间切片画面（第 ' + k.t + ' 秒）', src });
  });
  return out;
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
      intro: '点一个候选，或者在最后那个输入框里自己写；没答的按默认理解走',
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
    followPlaceholder: '还要怎么改？例：运镜写成具体动作 / 光线改成正午 / 只留一句（写完按回车）',
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
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="ic">' + icon('sparkles', 14) + '</span>AI 润色'; }
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
  if (!(await TextAI.canRun(REG))) { setStatus('<span class="err">请先到「设置」填写文字 AI 密钥（或在 .env / 系统环境变量里配置）</span>'); return; }
  const sysBase = TextAI.prompt('video');   // 内置默认只有一份（TextAI.DEF，见设置页）
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
    const items = polishImageList(sh).map(x => ({ label: x.label, kind: '图片', sent: true }));
    if (sh.refVideo) items.push({ label: '参考视频', kind: '视频', sent: false, hint: '这一镜沿用它的运镜和节奏' });
    if (sh.refAudio) items.push({ label: '参考音频', kind: '音频', sent: false, hint: '这一镜沿用它的节奏' });
    return items;
  };
  const prep = async () => {
    // 「随附图片」编号与 @参考图N 一致：参考图 → 首帧 / 尾帧 → 时间切片画面
    const picked = await TextAI.polishImages(REG, polishImageList(sh), { max: 6 });
    images = picked.images;
    return picked;
  };
  /* 一次润色 = 准备素材图（识图模型才带）→ 交代素材清单 → 组装提示词 → 调用文字 AI；返回 { after, note }。
     answers 是用户对「AI 先前的追问」的回答（没有追问时是空串）。
     那几句「对模型的交代」全部出自 `TextAI.polishExtra`（随附图怎么用 / @标记要保留 / 素材清单 /
     用户的回答，顺序也在那一份里定），与生成工作台、导演台配音那一处同一套 ——
     以前三处各抄一遍，改契约的人只改自己刚碰的那一处，于是同一段回答在不同页面发给模型的意思不一样。 */
  const run = async (answers, ctl) => {
    const picked = await prep();
    const sys = TextAI.polishSys(sysBase, TextAI.polishExtra({
      images: images, text: original, materials: materials(), answers: answers,
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
  if (btn) { btn.disabled = true; btn.innerHTML = icon('sparkles', 14) + ' 润色中…'; }
  /* 先反问：**由 AI 自己判断**值不值得问（need=false 就直接润色）。这一轮同样带素材图与清单 ——
     看过画面再问，问出来的才是画面相关的问题。 */
  let questions = [];
  if (wantAsk) {
    InlinePolish.loading($('polishInline'), '正在读这一镜，判断还缺什么…');
    let r = { need: false, questions: [] };
    try {
      const picked = await prep();
      const askSys = TextAI.polishSys(sysBase, TextAI.polishExtra({
        images: picked.images, materials: materials(), stage: 'ask',
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
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="ic">' + icon('sparkles', 14) + '</span>AI 润色'; }
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

/* ---------- 主题切换 ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  /* 隐私 / 禁存模式下存不下：主题就只生效这一次（LS 把那类抛错统一变成返回值，不再各写一层 try）。 */
  window.LS.set('dir_theme', t);
}
applyTheme(window.LS.get('dir_theme') || 'light');

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
    note: isFirst ? '图片直接用；选视频则取它的<b>最后一帧</b>当开头画面（全在本机取帧）' : '',
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
   判据、画法、读回都在 gen-forms.js 的 AdvExtras，与视频那一面、与生成工作台都是同一份。
   这里只记账：`topBools` / `shape` 与四档一起落盘（切镜头、刷新都不该重挑一遍）。 */
let kfTopBools = {}, kfShape = {};
/* 型号布尔那一排的「用户动过没有」账（`bool_<k>` = '1'/'0'）：公共层的 `html.bools` 靠它区分
   「按声明默认」与「保住用户挑的那个」。不落盘 —— 它记的是这一轮的界面状态，
   而声明默认值本身可能随型号变，跨刷新留着反而会把旧型号的意图压到新型号上。 */
let kfBoolAv = {};
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
}
/* 四个值一次落盘（一个键）：分四个键就是四次「这算设置项还是算界面状态」的争论，
   而且换一台机器只带走一半。 */
function kfParamsSave() {
  window.LS.setJson('sk_kf_params', {
    q: kfQ, ar: kfAr, size: kfSize, fmt: kfFormat, tb: kfTopBools, sf: kfShape,
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
/* ---------- 画面生成的「三排声明驱动控件」（与视频那一面、与生成工作台共用 AdvExtras） ----------
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
  /* `skip` 与「报价失败了」是两件事（与生成工作台同一句区分）：这一档根本没有询价这条路
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
     这里不另发明一种小数位。 */
  return nm + ' · 约 ' + (Math.round(sum * 100) / 100) + (cur ? ' ' + cur : '')
    + (bands.size > 1 ? '（按 ' + bands.size + ' 档时长各问一次）' : '');
}

/* ---------- 时间切片参考图（画面素材）---------- */
function assetToDataURL(assetId) {
  /* 取字节统一走 Net.blob（带超时、先判 HTTP 状态），不再裸 fetch */
  return Net.blob(Api.assetDl(assetId), { timeout: 60000 }).then(b => AssetTransfer.toDataURL(b));
}
/* 画面生成（时间切片）那几档参数的**判据在 `gen-forms.js` 的 `AdvParams.plan`**（与生成工作台图像栏同一份）：
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
/* 时间切片估价：张数随时长变化，价格走统一 estimateCost */
async function refreshKfEst() {
  const el = $('kfEst');
  const sh = curShot();
  if (!el || !sh) return;
  const dur = sh.duration || 5;
  const n = (sh.keyframes || []).length || 4;   // 张数由文字 AI 决定，未生成前按 4 张估算
  const pick = kfModelOf();
  if (!pick.prov || !pick.model) { el.textContent = n + ' 张'; return; }
  try {
    /* 顶层那几项也进报价（与视频那一面的 getPriceEstimate 同一个口径）：
       注册表在 `pricing.body` 里写了映射才带得过去，不递就是「界面勾了档、报价还是原来那个价」。 */
    const ex = kfAdvExtras(sh);
    const ctx = kfAdvCtx(sh);
    const r = await estimateCost(pick.prov, pick.model, Object.assign(
      { quality: kfQ, count: n, ar: kfAr || undefined, size: kfSize || undefined, format: kfFormat || undefined, topBools: ex.topBools, caps: ctx.caps },
      ex.shapeFields));
    el.textContent = (sh.keyframes?.length ? '' : '约 3–8 张 · 按 ') + (r.ok ? `${n} 张 ${r.text}` : `${n} 张（报价不可用）`);
  } catch { el.textContent = n + ' 张'; }
}
/* ============ 按描述生成这一镜的画面 ============
   流程：① 文字 AI 一次性规划「要几张 + 每张时间点与提示词」（返回 JSON）
        ② 立刻在右栏建立对应数量的占位图（先出现，再慢慢生成）
        ③ 逐张调用图片 AI 生成，完成即替换占位
        ④ 生成好的画面同时加入「参考图」，供视频生成时引用                          */
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

/* ① 规划：先让文字 AI 决定几张、每张什么时间点与提示词 */
async function planKeyframes(sh, dur) {
  const sys = storySysOf();
  const user = `镜头描述：${sh.prompt}
镜头时长：${dur} 秒
请决定需要几张关键画面（3–8 张，按内容复杂度），并按时间顺序给出每张的时间点与文生图提示词。只返回 JSON。`;
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
  const e = await AiGen.image(Object.assign({ prov: imgProv, model: m, prompt: prompt }, o));
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
  /* 入口锁：这一段前面有两处 await，置锁要等到规划完才会发生；期间 renderSoft 会把按钮
     重建回可点态，连点两次就是两轮并行提交、双倍生图扣费。锁必须在任何 await 之前。 */
  if (kfRun) return;
  kfRun = true;
  if (!TextAI.prov(REG)) { kfRun = false; setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(REG))) { kfRun = false; setStatus('<span class="err">请先到「设置」填写文字 AI 密钥（或在 .env / 系统环境变量里配置）</span>'); return; }
  const pickImg = kfModelOf();
  const imgProv = pickImg.prov, imgModel = pickImg.model;
  if (!imgProv || !imgModel) { kfRun = false; setStatus('<span class="err">注册表里没有可用的图片型号</span>'); return; }
  /* 时长没有就现取声明：模型默认的 duration → 声明里最短那一档；都不给才用最旧的那个数（只用于画面切片，不进提交体） */
  const rmv = resolvedModel(sh);
  const kfDur = (Array.isArray(rmv?.options?.durations) ? rmv.options.durations : []).map(Number).filter(Number.isFinite);
  const dur = Number(sh.duration) || Number(rmv?.options?.defaults?.duration) || (kfDur.length ? Math.min(...kfDur) : 5);
  const btn = $('kfGenBtn');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    // ① 文字 AI 规划：决定几张 + 每张的切片提示词
    setStatus('文字 AI 正在规划画面切片…');
    const plan = await planKeyframes(sh, dur);
    if (!plan.length) throw new Error('文字 AI 没有给出可用的画面规划');

    // ①.5 先把规划结果给用户过一遍（可改文案 / 删掉不想生成的），确认后再出占位图并开始生成
    const reviewed = await PromptReview.openList({
      title: '画面切片规划（文字 AI 出的提示词）',
      sub: `第 ${allShots().indexOf(sh) + 1} 镜 · 时长 ${dur} 秒 · 共 ${plan.length} 张 · 画质 ${QUALITY_ZH[kfQ] || kfQ || '平台默认'}`,
      items: plan.map((f, i) => ({ label: `画面 ${i + 1} · ${f.t}s`, text: f.prompt })),
      applyLabel: '采用并开始生成',
      hint: '可以逐条修改或删掉；确认后立即出占位图并开始生成',
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
        const assetId = await genOneImage(imgProv, imgModel, prompt, kfGenOpts(sh, { inputEntries: kfRefs, at: kf.t }));
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
    if (btn) { btn.disabled = false; btn.innerHTML = icon('sparkles', 13) + ' 按描述生成这一镜的画面'; }
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
  $('projCount').textContent = WS.projects.length;
  $('projName').value = proj.name;
  applyComposition();
  refreshEst();
  /* 按钮下那行「可生成 N 镜 / 预计 X」跟镜头增删、型号、条数一起变：去抖与缓存都在它自己那一份里，
     重复调用只是排一次定时器。 */
  Gen.refreshGenAllEst();
}
/* 项目菜单：按**项目组**分树（组 → 组内的短片 → 未分组）。
   组名即素材组名（见 web/director/groups.js）。组的判据全在那个模块里，这里只画。 */
/* 项目组改名 → 素材库那一组要不要一起改？
   **不自动改**：素材库是用户数据，那一组可能还有别的来源（同名的组在别的短片里也在用）。
   界面上问一次，点了才动。改组名的落点只有 `Chars.Lib.renameGroup` 一处。 */
async function renameAssetGroup(oldName, newName) {
  const D = window.Chars;
  if (!D || !D.Lib || !D.Lib.renameGroup) return;
  const n = (D.Lib.list() || []).filter(c => c && D.Lib.groupMatch(c, oldName)).length;
  if (!n) return;
  if (!window.Confirm) { setStatus('<span class="err">确认组件未加载，素材库那一组没有改（还叫「' + esc(oldName) + '」）</span>'); return; }
  const ok = await Confirm.ask({ title: '素材库那一组要一起改名吗',
    body: `素材库里有 ${n} 条素材在「${oldName}」这一组里。\n要把它们一起改成「${newName}」吗？\n（不选则它们还留在「${oldName}」下 —— 导演台的项目组与素材库的分组名就不一样了）`,
    okLabel: '一起改成新名字', cancelLabel: '素材库不动' });
  if (!ok) { setStatus('<span class="ok">✓ 项目组已改名为「' + esc(newName) + '」；素材库那一组还叫「' + esc(oldName) + '」</span>'); return; }
  const r = D.Lib.renameGroup(oldName, newName);
  if (r && r.why) { Toast.warn(r.why); return; }
  if (r && r.n) setStatus('<span class="ok">✓ 项目组已改名为「' + esc(newName) + '」，素材库那一组 ' + r.n + ' 条也改了</span>');
}
function renderProjMenu() {
  const menu = $('projMenu');
  const tree = Groups.tree(WS);
  const gCount = Groups.list(WS).length;
  menu.innerHTML = '<div class="pm-head">共 ' + WS.projects.length + ' 个短片'
    + (gCount ? ' · ' + gCount + ' 个项目组' : '') + '</div>';
  const projRow = (p, inGroup) => {
    const row = document.createElement('div');
    row.className = 'pm-row' + (p.id === WS.curId ? ' sel' : '') + (inGroup ? ' pm-in-group' : '');
    const n = (p.scenes || []).reduce((a, s) => a + (s.shots || []).length, 0);
    row.innerHTML = `<span class="pm-name">${esc(p.name)} <span class="pm-cnt">· ${n} 镜</span></span>
      <span class="pm-ops">
        <button class="pm-btn" data-move="${p.id}" title="移到别的项目组">${icon('folder', 13)}</button>
        <button class="pm-btn" data-rename="${p.id}" title="重命名这个短片">${icon('pencil', 13)}</button>
        <button class="pm-btn danger" data-del="${p.id}" title="删除这个短片">${icon('trash', 13)}</button>
      </span>`;
    row.onclick = e => { if (e.target.closest('.pm-btn')) return; switchProject(p.id); menu.hidden = true; };
    return row;
  };
  tree.forEach(g => {
    /* 组头：组名 + 几部短片 + 改名 / 删组。
       删组只把组内的短片退回未分组，**不删短片** —— 删组是整理，不是删作品。 */
    const head = document.createElement('div');
    head.className = 'pm-group' + (g.kind === 'none' ? ' none' : '');
    head.innerHTML = `<span class="pm-gname">${esc(g.name)}</span>
      <span class="pm-cnt">· ${g.items.length} 部</span>
      <span class="pm-ops">
        ${g.kind === 'none' ? '' : `<button class="pm-btn" data-grename="${g.id}" title="重命名这个项目组">${icon('pencil', 13)}</button>
        <button class="pm-btn danger" data-gdel="${g.id}" title="删掉这个项目组（组里的短片退回未分组，不会被删）">${icon('trash', 13)}</button>`}
      </span>`;
    menu.appendChild(head);
    g.items.forEach(it => menu.appendChild(projRow(it.p, g.kind !== 'none')));
  });
  /* 移到组：短片那一行的「文件夹」按钮。 */
  menu.querySelectorAll('[data-move]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const p = WS.projects.find(x => x.id === b.dataset.move);
    if (!p) return;
    const groups = Groups.list(WS);
    if (!window.PromptForm) { setStatus('<span class="err">表单组件未加载，已取消移动</span>'); return; }
    const opts = [{ v: '', t: '未分组' }].concat(groups.map(g => ({ v: g.id, t: g.name })));
    const v = await PromptForm.open({
      title: '移到项目组', okLabel: '移动',
      fields: [{ key: 'gid', label: '这个短片放进哪个组', type: 'select', value: p.groupId || '', options: opts }],
    });
    if (!v || v.gid == null) return;
    Groups.assign(WS, p.id, v.gid);
    renderProjMenu(); renderAll(); scheduleSave();
    setStatus('<span class="ok">✓ 已把「' + esc(p.name) + '」移到「' + (v.gid ? esc((Groups.find(WS, v.gid) || {}).name || '') : '未分组') + '」</span>');
  });
  // 重命名
  menu.querySelectorAll('[data-rename]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const pp = WS.projects.find(x => x.id === b.dataset.rename);
    if (!pp) return;
    if (!window.PromptForm) { setStatus('<span class="err">表单组件未加载，已取消重命名</span>'); return; }
    const v = await PromptForm.open({ title: '重命名短片', okLabel: '保存', fields: [{ key: 'name', label: '短片名称', type: 'text', value: pp.name }] });
    if (!v || v.name == null) return;
    pp.name = String(v.name).trim() || pp.name;
    if (pp.id === WS.curId) $('projName').value = pp.name;
    renderProjMenu(); renderAll(); scheduleSave();
  });
  /* 改组名：组名就是素材组名，所以改组名会牵动素材库里的那些素材。
     **不自动改**素材库（那是用户数据，可能还有别的来源）—— 只提示，问了才动。 */
  menu.querySelectorAll('[data-grename]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const g = Groups.list(WS).find(x => x.id === b.dataset.grename);
    if (!g) return;
    if (!window.PromptForm) { setStatus('<span class="err">表单组件未加载，已取消重命名</span>'); return; }
    const v = await PromptForm.open({ title: '重命名项目组', okLabel: '保存', fields: [{ key: 'name', label: '项目组名称（也是素材库里的分组名）', type: 'text', value: g.name }] });
    if (!v || v.name == null) return;
    const nm = String(v.name).trim();
    if (!nm) return;
    const r = Groups.rename(WS, g.id, nm);
    if (!r) { renderProjMenu(); return; }
    /* 素材库那边同名的一组：问一次要不要一起改。 */
    await renameAssetGroup(r.old, r.name);
    renderProjMenu(); renderAll(); scheduleSave();
  });
  /* 删组：组内的短片退回未分组，一条都不删。 */
  menu.querySelectorAll('[data-gdel]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const g = Groups.list(WS).find(x => x.id === b.dataset.gdel);
    if (!g) return;
    const n = (WS.projects || []).filter(p => p && p.groupId === g.id).length;
    if (!window.Confirm) { setStatus('<span class="err">确认组件未加载，已取消删除</span>'); return; }
    const ok = await Confirm.ask({ title: '删掉项目组',
      body: `确定删掉项目组「${g.name}」？\n组里的 ${n} 部短片会退回「未分组」，**不会被删掉**。\n素材库里那一组素材也不受影响。`,
      okLabel: '删掉这个组', danger: true });
    if (!ok) return;
    Groups.remove(WS, g.id);
    renderProjMenu(); renderAll(); scheduleSave();
    setStatus('<span class="ok">✓ 已删掉项目组「' + esc(g.name) + '」（' + n + ' 部短片退回未分组）</span>');
  });
  /* 删除（二次确认；删掉当前短片会自动切到另一个，最后一个则新建空白短片） */
  menu.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const id = b.dataset.del;
    const pp = WS.projects.find(x => x.id === id);
    if (!pp) return;
    const shots = pp.scenes.reduce((a, s2) => a + s2.shots.length, 0);
    if (!window.Confirm) { setStatus('<span class="err">确认组件未加载，已取消删除</span>'); return; }
    const okDel = await Confirm.ask({ title: '删除短片', body: `确定删除短片「${pp.name}」？
共 ${shots} 个镜头，删除后无法恢复。`, okLabel: '删除', danger: true });
    if (!okDel) return;
    // 连带清理它引用的本地视频 blob，避免占空间
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
    switchProject(WS.curId);
    renderProjMenu();
    setStatus('<span class="ok">✓ 已删除短片「' + pp.name + '」</span>');
  });
  /* 底部两行：新建组 / 新建短片。 */
  const gAdd = document.createElement('div');
  gAdd.className = 'pm-add';
  gAdd.textContent = '＋ 新建项目组';
  gAdd.onclick = async () => {
    if (!window.PromptForm) { setStatus('<span class="err">表单组件未加载，已取消新建</span>'); return; }
    const v = await PromptForm.open({
      title: '新建项目组', okLabel: '建这个组',
      sub: '组名同时是素材库里的分组名：在这个组下的短片里拆分镜，新建的素材会落进同名的那一组。',
      fields: [{ key: 'name', label: '项目组名称', type: 'text', placeholder: '例：校园篇' }],
    });
    if (!v || !v.name) return;
    const nm = String(v.name).trim();
    if (!nm) return;
    const g = Groups.ensure(WS, nm);
    if (!g) return;
    /* 新组默认把当前短片放进去 —— 用户「建一个组」多半就是为了归这一部。 */
    if (proj && proj.id) Groups.assign(WS, proj.id, g.id);
    renderProjMenu(); renderAll(); scheduleSave();
    setStatus('<span class="ok">✓ 已建项目组「' + esc(g.name) + '」' + (proj ? '，当前短片已放进去' : '') + '</span>');
  };
  menu.appendChild(gAdd);
  const addRow = document.createElement('div');
  addRow.className = 'pm-add';
  addRow.textContent = '＋ 新建短片';
  addRow.onclick = () => {
    const p = { id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] };
    /* 新短片默认落在**当前短片所在的组**里 —— 同一组的短片才共享素材。 */
    if (proj && proj.groupId) p.groupId = proj.groupId;
    WS.projects.push(p);
    switchProject(p.id);
    menu.hidden = true;
  };
  menu.appendChild(addRow);
}
function switchProject(id) {
  /* 切走短片 = 这一批不该再往下投：还没开始的镜头直接停，正在提交的那一条按它自己的回包落定。
     `runGenAll` 里还会比对 `proj` 与 `WS.curId` 兜一次（双保险，不靠调用顺序）。 */
  if (Gen.genAllRunning()) Gen.abortGenAll('切换了短片');
  WS.curId = id;
  proj = WS.projects.find(p => p.id === id) || WS.projects[0];   // id 失效（导入/删除后）时回落到第一个，别直接抛错
  if (!proj) { WS.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] }); proj = WS.projects[0]; WS.curId = proj.id; }
  proj.curScene = 0; proj.curShot = 0; proj.curCand = 0;
  $('projName').value = proj.name;
  renderAll(); scheduleSave();
}
$('projSwitch').onclick = e => { e.stopPropagation(); renderProjMenu(); $('projMenu').hidden = !$('projMenu').hidden; };
document.addEventListener('click', e => { if (!$('projMenu').contains(e.target) && e.target !== $('projSwitch')) $('projMenu').hidden = true; });
/* 进度信息挪到左栏「生成全部分镜」按钮下方的小字（顶部横幅平常不出现） */
let genAllMsg = null;        // 批量生成的结果/提示：横幅只报错，成功信息在这里留 12 秒
function setGenAllMsg(html) { genAllMsg = { html, ts: Date.now() }; updateBanner(); }
function updateBanner() {
  const all = allShots();
  const ready = all.filter(shotReady).length;
  const note = $('genAllNote');
  if (!note) return;
  /* 「生成中」与批量调度同一份判据（`chainStateOf` 把 `creating` 也算在跑）：
     只认 queued / running 会让「刚提交、平台还没回任务号」的那一段横幅显示成空闲。 */
  const running = all.some(sh => Gen.chainStateOf(sh) === 'running');
  const prog = running ? '⏳ 生成中…（' + ready + '/' + all.length + ' 已完成）' : '';
  // 刚提交完的结果优先显示 12 秒（和进度并排），之后再回到普通进度文案
  if (genAllMsg && Date.now() - genAllMsg.ts < 12000) { note.innerHTML = genAllMsg.html + (prog ? '<span style="display:block;margin-top: var(--sp-2)">' + prog + '</span>' : ''); return; }
  if (running) { note.textContent = prog; return; }
  note.textContent = ready === all.length && all.length
    ? `✓ ${ready} 个分镜已完成，可以剪辑与导出了`
    : `已完成 ${ready}/${all.length} 个分镜`;
}
/* 「就地二次确认」全站**只有 web/ui/ui.js 的 Confirm.arm 一份**（AGENTS §7）。
   这一页以前自建了一个 armConfirm：没有后果说明、Esc 不取消、点别处不取消、窗口只有 2.5 秒，
   而且没有「整页同时只有一个确认中」—— 可以同时点亮两颗删除按钮，
   用户点下第一颗之后才点第二颗，**两颗一起执行**。
   四个调用点已全部改调 Confirm.arm，这个函数不再需要。 */

/* 在指定场景末尾新建镜头并立刻进入编辑状态 */
function addShotToScene(sc, idx) {
  const sh = newShot();
  setTimeout(() => { const ta = $('edPrompt'); if (ta) { ta.focus(); ta.select(); } }, 120);
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
  if (ta) ta.focus();
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
$('projName').oninput = e => { proj.name = e.target.value; scheduleSave(); };
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
    sub: '当前分镜写成的一份稿子。逐镜一段「画面」；台词不在这里，在剪辑右栏「台词」那一档改。',
    body(el) {
      el.innerHTML = '<textarea class="ui-ta" spellcheck="false" aria-label="剧本正文"'
        + ' style="height:min(58vh,560px);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size: var(--fs-12-5);line-height:1.65"></textarea>'
        + '<div role="alert" style="display:none;color:var(--err);font-size: var(--fs-12);line-height:1.6;margin-top: var(--sp-6)"></div>';
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
  $, canStatus, uid, mkCandidateBase, allShots, curScene, ensureChainModel, chainWaitWhy,
  resolveChainFrame, scheduleSave, dlStage, assetStoreId, sameAssetSpace, loadCredits,
  updateMidLive, sortCandidates, provById, saveScheduleSoft, renderScenesSoon, curDraftCand,
  applyRefSyntax, refTokenize, resolvedModel, ROLE_ZH, comboLabel, shotUsedRoles, shotCombo,
  shotInputCaps, shotAdvCtx, shotAdvExtras, shotKeyframes, shotInputEntries, NO_PROMPT_WHY,
  shotBlockReason, provOf, needProv, shotQuote, renderAll, updateProjUI, setGenAllMsg,
  updateBanner, setStatus, hasRealCandidate, projOf: () => proj, wsOf: () => WS, regOf: () => REG,
  setForceMid: v => { forceMid = v; },
});

$('genAll').onclick = async () => {
  const runProj = proj;
  const plan = Gen.genAllPlan();
  if (!plan.ok.length && !plan.wait.length) {
    if (!plan.todo.length) {
      setStatus('<span class="err">所有镜头都已有生成结果，无需重复生成（想重跑先删掉那一镜的候选）</span>');
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
    Gen.refreshGenAllEst();
  }
};
/* 导出域（engine/export.js）：合并成片 / 导出素材 / FCPXML / 送到 NLE。
   这里只把引擎的读写口递进去；导出状态（渲染中 / 任务号 / 取消）由那一份自己持有。 */
const Export = createExport({
  $, setStatus, projOf: () => proj, allShots, tlSyncFromShots, tlClipDur, tlClipSrc, tlDuration, fmtDur,
  clipVoices, voicesEnsure, voiceVolOf, tlCandidateOf, candDur, healStaleUrls,
  filmFrames, filmLayGray, filmSize, saveBlob, scheduleSave, renderAll, filmRowsForSubtitles,
  readJsonSafe,
  BoardAssetsOf: () => BoardAssets,
});
/* 页头那一排导出按钮由格式表现画现绑（web/domain/export-formats.js）：加一种导出不再动模板与这一排。
   绑定也只有这一处：剪辑栏每 3 秒随整列重建，把出口绑在那里等于每次重建都要重绑，
   导出中写在按钮上的那句「取消渲染 45%」会被下一次重画冲掉。
   **「播放成片」那一颗已删**：看效果走「剪辑 → 全片」那一排的实时预览（`#pbBtn` → TlPlay），
   它从不为播放合成；要一个文件才点这里的「导出成片」。 */
/* 每个 kind 给一个「返回点击处理器」的工厂：film / files 直接交现成函数，
   xml 才按这一行是裸 FCPXML 还是媒体包现包一个。 */
const EXPORT_RUN = {
  film: () => Export.filmClick,
  files: () => Export.assetsClick,
  xml: f => f.id === 'resolve' ? () => Export.resolve()
    : f.id === 'jianying' ? () => Export.jianying()
    : () => Export.fcp({ bundle: !!f.bundle }),
};
$('exportBtns').innerHTML = ExportFormats.list().map(f =>
  '<button class="ghost" id="' + f.button + '" title="' + esc(f.title) + '">'
  + icon(f.icon, 13) + ' ' + esc(f.label) + '</button>').join('');
ExportFormats.list().forEach(f => {
  const b = $(f.button);
  if (b) b.onclick = EXPORT_RUN[f.kind](f);
});
/* 导入侧两块：FCPXML 项目 / 最近导出。本机视频仍可从中栏「导入视频 / 素材」进
   （AssetPicker 顶部就是本地上传）；这个隐藏 input 留给剪辑导入的自动化探针。 */
$('importFcpBtn').onclick = () => { const f = $('importFcpFile'); if (!f) return; f.value = ''; f.click(); };
$('importFcpFile').onchange = e => {
  const f = e.target && e.target.files && e.target.files[0];
  if (e.target) e.target.value = '';
  if (f) importFcpProject(f);
};
$('importMediaFile').onchange = e => {
  const f = e.target && e.target.files && e.target.files[0];
  if (e.target) e.target.value = '';       // 同一份文件再选一次也要能触发 change
  if (f) importMediaFile(f);
};
$('recentExportsBtn').onclick = openRecentExports;

/* ---------- 灯箱：DOM 与翻页/键盘/关闭/信息条全在 Wb.lightbox（见 AGENTS.md §3），页面只声明怎么取地址 ---------- */
Wb.lightbox.init({
  list: () => [],                                  // 本页没有列表视图，翻页范围由 openLightbox 的第二个参数给
  keyOf: it => (it && it.src) || '',
  srcOf: it => (it && it.src) || '',
  kindOf: it => (it && it.video ? 'video' : 'image'),
  nameOf: it => window.fileSafe((it && it.label) || 'merged', 60) + '.mp4',
  info: it => [(it && it.label) || ''],
});
function openLightbox(pages, idx) { Wb.lightbox.open(pages[idx], pages); }

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
          if (c && c.status === 'creating' && (!c.vid || String(c.vid).startsWith('tmp_'))) {
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
   两条拖拽条分别改左栏和右栏，中栏永远吃掉剩下的空间。 */
Wb.split.enable({
  box: '.layout', key: 'dir_split',
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
  revFloor = Math.max(revFloor, Number(proj.rev) || 0);
  lastSavedJson = snapOf();    // 撤销栈基线
  wsLoaded = true;             // 从现在起才允许落盘（见 wsLoaded 那段）
  $('projName').value = proj.name;
  renderAll();                 // 首屏：不等能力接口、不等本地视频、不等余额
  /* 14.1-6：老工程 refMeta 没 id 的条目按 label 反查库里补 id（幂等，已有 id 的不动）。 */
  try { Panel.backfillRefMetaIds && Panel.backfillRefMetaIds(allShots()); } catch (e) { /* 补不上不影响启动 */ }
  setTimeout(() => Gen.announceDoneCandidates(), 0);   // 已经出画面但还没镜像的候选：投一次事件（不阻塞首屏）
  Gen.pollKick();             // 首屏立刻问一次在途候选，不等第一轮间隔
  loadCredits();
  // 后台补齐（都不阻塞首屏）
  Panel.installCapRepaint();   // 一家能力落定就补画一次右栏（实现在 engine/panel.js）
  restoreLocalBlobs().then(() => { try { renderAll(); } catch { /* 首屏重画抛错不打断后面的恢复流程 */ } }).catch(() => {});
  hydrateThumbFrames();        // 上次抽好的缩略图首帧：读出来直接当图片用，不再等视频出画
  healStaleUrls();             // 存过期的签名外链：后台按任务号换新地址并写回工作区
})();

/* ============================================================================
   给外壳 / AI 助手的**时间线写入桥**（全项目只有这一份）
   ----------------------------------------------------------------------------
   助手不该靠 DOM 去点轨道上的按钮：那要「先 page_state 找按钮 → 再点」两步，
   而按钮本身还依赖「现在指着哪一段」这种界面态。这里把同一批编辑器函数暴露成
   一条带校验、可撤销的接口；校验与执行都走**编辑器自己的**函数，不另写第二套：
     · select_take   选一条候选进成片（= 候选上那颗「用这条」）→ sh.selId
     · cut_timeline  切开 / 左切 / 右切 / 删成黑场 / 融合 → cutSegs + segsWrite + reanchorVoices
     · set_clip      这一段的倍速 / 音量 / 黑场 → 同一份 segs 数据
     · undo_edit     撤销 / 重做（Ctrl+Z / Ctrl+Y 的同一份栈）
   规矩：① 只在导演台**前台**可用；② 先 check（纯读）再 run；③ 任何写入前 `beginEdit()`
   压一份撤销快照（用户点完执行马上说「撤销」也退得回去）；④ 行锁着的段一律拒绝。
   页面那三条 UI 路径不经过这里 —— 这是给「外壳那一层」的唯一入口，不是第二套剪辑实现。
   ========================================================================== */
/* Bridge域（engine/bridge.js）：这一段（8472-9397）搬进模块，这里只留一个访问器包（这一域不交名字回来）。
   接线放回区间原位，是让这一层其余代码读到的名字顺序不变；E 里每一位都包成箭头，
   因为建包时后面的 const 还没初始化，直接引用会撞 TDZ（临时死区）。 */
createBridge({
  ExportFormats: ExportFormats,
  TlPlay: TlPlay,
  projOf: () => proj,
  allShots: (...a) => allShots(...a),
  curScene: (...a) => curScene(...a),
  curShot: (...a) => curShot(...a),
  fmtDur: (...a) => fmtDur(...a),
  undoStack: undoStack,
  redoStack: redoStack,
  UNDO_MAX_BYTES: UNDO_MAX_BYTES,
  UNDO_MAX_COUNT: UNDO_MAX_COUNT,
  undoBytesOf: () => undoBytes,
  undoSkipWhyOf: () => undoSkipWhy,
  lastUndoLabelOf: () => lastUndoLabel,
  beginEdit: (...a) => beginEdit(...a),
  undo: (...a) => undo(...a),
  redo: (...a) => redo(...a),
  candDur: (...a) => candDur(...a),
  voicesEnsure: (...a) => voicesEnsure(...a),
  reanchorVoices: (...a) => reanchorVoices(...a),
  cutSegs: (...a) => cutSegs(...a),
  rowLockWhy: (...a) => rowLockWhy(...a),
  tlSyncFromShots: (...a) => tlSyncFromShots(...a),
  readJsonSafe: (...a) => readJsonSafe(...a),
  filmEdited: (...a) => filmEdited(...a),
  shotFilmAt: (...a) => shotFilmAt(...a),
  filmRowsForSubtitles: (...a) => filmRowsForSubtitles(...a),
  subWriteData: (...a) => subWriteData(...a),
  candTrackSrc: (...a) => candTrackSrc(...a),
  mediaInfo: (...a) => mediaInfo(...a),
  renderAll: (...a) => renderAll(...a),
  setStatus: (...a) => setStatus(...a),
  Export: Export,
}, document, window);

}
