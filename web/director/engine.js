/* 导演台引擎：原 fragment.html 的内联脚本整体搬进模块，document / window 是页面作用域岛的两份代理。
   这样它可以被 node --check 静态检查；模板在开发期预编译（tools/precompile-vue.cjs），
   运行时没有 new Function，严格 CSP 不需要 unsafe-eval。 */
import { exportFCPXML as runFcpExport } from './fcpxml.js';
import { parseFCPXML } from './fcpxml-import.js';
import { parseJsonLoose, round1, round2, pct, spdTxt, ctxClip, BOARD_CTX_PROMPT, BOARD_CTX_SHORT } from './util.js';

import { speakerOf, lineTimeOf, lineRowHTML } from './lines.js';

import { scriptTextOf, parseScript, applyScript } from './script.js';

import { createBoardTools } from './board.js';

import { createSplitAssets } from './split-assets.js';

import { SLICE_TILE_PX, SLICE_N_MAX, sliceGeom, sliceBoxHTML, sliceTimes } from './slice.js';

import { createPlayback } from './playback.js';

import { SEG_MIN, segLen, segVol, segSpd, segFilmLen, segCarry, segsOf, segsFilmLen, segsCopy, segsWrite, TRACK_LANES_MAX, laneClamp, picLnOf, tlClipDur } from './segments.js';

import { createTimeline } from './timeline.js';

import { voiceRateOf, voiceFrameOf, roundVoice, voiceRuns, rowSelIn, rowSelOut, makeVoiceAxBox, createVoiceFilm, lineEstSec, lineSpanAt } from './voice-layout.js';

import { chosenCandOf, currentOf, entriesFromShot, sourceHashOf, styleOf, setStyle, srtParse, srtSerialize,
  resegment, filmOf, mapToFilm, mapToShot, mapFromFilm, entryAt, overlayHTML, filmEntriesOf } from './subtitles.js';

import { createPlayPlan } from './plan.js';

import { createWaveform } from './waveform.js';

import { createProjection } from './projection.js';

import { voiceBlockLabel, voiceBlockText, createVoiceBlockRenderer } from './voice-block.js';

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

/* ---------- 工作区（多个短片）---------- */
let WS = { projects: [], curId: null };
let proj = null;        // 当前短片
let REG = null;         // /registry：API 注册路由（提供商/模型/能力）
let saveTimer = null;
const uid = () => crypto.randomUUID().slice(0, 8);

/* 「一条候选占位有哪些字段」全站只在这一个函数里点一次名。
   以前命名了三份：mkDraftCandidate 一份、addCandidateDraft 抄了一份逐字相同的十行、
   pushPlaceholders 又抄了第三份（只差 vid 前缀与状态）—— 给占位加一个字段就要三处同步，
   漏一处的表现是「从某个入口建出来的候选少带一个字段」（界面正常、提交时才取到 undefined）。
   provider 在这里只是「这一条将来要发给谁」的一个记号：draft 阶段既不会提交也不会被轮询
   （pollLive 按 tmp_ 号跳过）。以前这里写的是 `provOf(...).id` —— 页面刚打开、/registry 还没回来的
   那一瞬间 provOf 给的是 null，于是「建第一个镜头」当场抛 TypeError，
   干净 profile 一进去就是「未处理错误」横幅 + 右栏一直空着（加载期竞态，与 §7
   「能力声明回来之前不许说你没配 X 接口」是同一类）。
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
    /* 批次④（方案 §4.1 / §4.3）两个结构化字段，都只挂在镜头上：
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
/* 裁剪落地之后那一句（两个入口共用）—— **必须说清这一条在不在成片里**（L57）。
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
  const was = undoStack.length;
  while (undoStack.length > UNDO_MAX_COUNT || undoBytes > UNDO_MAX_BYTES) undoBytes -= undoStack.shift().length;
  if (was <= UNDO_MAX_COUNT && undoStack.length < was) undoSkipWhy = '撤销已用满上限（' + UNDO_MAX_COUNT + ' 步）';
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
     而撤销上限只有 30 步（L10），翻看几次就能把真正的改动挤出栈。
     剔掉它们之后，「翻看」不再消耗撤销次数，而撤销回去时视口停在当前这一镜
     （restoreSnap 之后 renderAll 会照 proj.curCand 重画，指向的那一条仍然是它，
     因为那一镜的候选列表没变）。
     **只序列化当前项目**：多项目工程里整个工作区可能有几十 MB，
     每 500ms / 每一刀都 stringify 全部项目是主线程卡顿的主要来源；
     撤销只需要恢复正在改的那一个项目（切项目会换 curId，恢复时跟着切回去）。 */
  if (!proj) return '';
  return JSON.stringify({ curId: WS.curId, project: proj, roles: WS.roles },
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
    } else if (ws && Array.isArray(ws.projects)) {
      /* 老快照（只在内存里，不会持久化；保留这条兼容分支不至于让升级瞬间的 undo 抛错） */
      WS.projects = ws.projects; WS.curId = ws.curId;
    }
    proj = WS.projects.find(p => p.id === WS.curId) || WS.projects[0];
    sanitize(); renderAll();
    /* renderMid 末尾会 scheduleSave；撤销/重做本身就是「回到已存状态」，
       不能让这次重画顺手把 redoStack 清掉（那会让「撤销一步再重做」直接没有反应）。 */
    clearTimeout(saveTimer); saveTimer = null;
    try { $('saveState').textContent = '已保存到本地'; } catch (e) {}
    /* 撤销/重做也是一次真实改动：revision 只增不减（bumpRevision 里有 floor），
       否则退回旧快照时 rev 倒退，同一份工作区会先后拿到同一个号，助手 CAS 就认不出中间改过。 */
    bumpRevision();
    const snap = snapOf();
    wsKv.put('workspace', { projects: WS.projects, curId: WS.curId, roles: WS.roles, ts: Date.now() });
    lastSavedJson = snap;
  } catch {}
}
function undo() {
  if (!undoStack.length) {
    setStatus('<span class="err">可撤销的已经用完了'
      + (undoSkipWhy ? '（' + undoSkipWhy + '）' : '') + ' —— 不是「没有可撤销的操作」</span>');
    return;
  }
  undoSkipWhy = '';
  pushRedo(snapOf());
  restoreSnap(undoStack.pop());
  setStatus('<span class="ok">✓ 已撤销（Ctrl+Y 重做）</span>');
}
function redo() {
  if (!redoStack.length) { setStatus('没有可重做的操作'); return; }
  pushUndo(snapOf());
  restoreSnap(redoStack.pop());
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

/* ============================================================================
   成片时间线（timeline）—— LLM 剪辑与 ffmpeg 离线导出的数据基础
   clip = { id, kind:'shot'|'asset', shotId?, candId?, assetId?, src?, name, in, out, speed, volume, gray? }
     · kind 'shot'  引用某个镜头的候选（可重排、可重复使用、可单独裁剪）
     · kind 'asset' 直接引用资产库素材（按 src 或资产号取用）
     · gray 1 = 这一段画面被删成黑场（kind 还是 shot，仍占这一段的时间）
   ========================================================================== */
function tlEnsure() {
  if (!proj.timeline || !Array.isArray(proj.timeline.clips)) proj.timeline = { clips: [] };
  return proj.timeline;
}
const tlDuration = () => tlEnsure().clips.reduce((a, c) => a + tlClipDur(c), 0);
const tlCandidateOf = (sh, candId) =>
  (sh.candidates || []).find(c => c.vid === candId) || (sh.candidates || []).find(c => c.vid === sh.selId) || null;

/* ============================================================================
   多段剪辑（切开 / 向左切 / 向右切 / 删掉这一段）—— 段存在**候选自己身上**
   ----------------------------------------------------------------------------
   `c.segs = [{ in, out }, …]`：源视频里的秒，按播放顺序。
   为什么不存时间线的 clip 上：clip 是每次 `tlFromShots()` 现派出来的（换候选、拖顺序都会重建），
   段存在 clip 上就等于「本镜」与「全片」各存一份 —— 用户点名的正是这件事：在一处剪完，另一处照旧。
   存在候选上，两处都只是它的读数：本镜切一刀，全片的段数、秒数、切片图和配音位置一起跟着变。
   老数据只有 `trimS/trimE`（单段）：`segsOf` 认它；每次落地又把 `trimS/trimE` 回写成
   「首段入点 / 末段出点」—— 候选卡与归档摘要还在读那两个字段，不能各说各话。 */
const candDur = (c, sh) => Math.max(0.1, Number(c && c.duration) || Number(sh && sh.duration) || 5);
/* 时间线几何：两条轨共用的框 / 轴秒 / 灰场 / 折算。纯算法在 timeline.js，这里只把
   「当前工程有哪些镜头、怎么找候选」交给它。 */
const Timeline = createTimeline({ allShots, tlCandidateOf, candDur });
const {
  clipFrame, filmFrames, graySpans, axisGray, filmLayGray, frameToSrc, srcToFrame,
  shotFrames, shotRowAt, shotRowOf, shotPinT, shotAxTotal,
} = Timeline;
const voiceAxBox = makeVoiceAxBox(srcToFrame);
const {
  voiceFilmSpan, voiceFilmGap, VOICE_GAP_TXT, voiceFilmWhy, voiceInFilm, VOICE_GAP_FIX, voiceAdoptable,
} = createVoiceFilm({ filmFrames, tlSyncFromShots: () => tlSyncFromShots(), allShots, voiceAxBox });
const { voicePeaks, waveformSVG, fillWaveforms } = createWaveform({
  mediaSrc: s => Api.mediaSrc(s),
  voiceOf: id => voicesEnsure().find(x => x.id === id),
});
/* 配音块标记（本镜 / 全片共用的那一份）在 voice-block.js；这里只把页面状态接进去。 */
const voiceBlockHTML = createVoiceBlockRenderer({
  esc: s => esc(s), icon: (n, s) => icon(n, s),
  voiceSelId: () => voiceSelId(), voiceLn: v => voiceLn(v),
  rowLocked: (k, ln) => rowLocked(k, ln),
  rowLockWhy: (k, ln) => rowLockWhy(k, ln),
  rowUnlockHow: (k, ln) => rowUnlockHow(k, ln),
});
/* 剪辑界面正指着哪一段（切完之后指针要留在看得见的地方；老工程没这个字段 = 第 0 段） */
const cutSegIdx = () => Math.max(0, Number(proj && proj.cutSeg) || 0);
const curSegOf = (sh, c) => { const ss = segsOf(c, candDur(c, sh)); return ss.length ? ss[Math.min(ss.length - 1, cutSegIdx())] : null; };
const candSelected = (sh, c) => !!(c && sh && sh.selId === c.vid);

/* ---------------- 声音轨（剪辑模式新增）----------------
   `proj.voices = [{ id, shotId, candId, seg, at, dur, vol, src, name, text, provider, model, voice, fa, fb }]`
   （`fa`/`fb` = 这一句在轨道上的**框**，与画面轨同一个概念：块摆哪儿、多宽只看它，拖把手不改；
   `[at, at+dur]` 是框内的**选区** = 真进成片的那一截。老数据没有这两个键时按「框 = 选区」现算）。
   `at` 相对**这一段自己**的起点（不是整条候选，也不是整片）：段会被切开、会被裁短，
   锚在段上才能在剪完之后仍然落在原来那句话的位置 —— 这是「本镜剪了、全片跟着变」在声音上的落点。
   交给 `/render` 时按 `clips[].voices = [{ src, start, dur, vol }]`（start 相对该段起点，
   代理那侧同一套约定：绝对偏移由那一段的 span 决定，客户端自己加会漂）。 */
function voicesEnsure() { if (!Array.isArray(proj.voices)) proj.voices = []; return proj.voices; }
const shotVoices = (shotId, candId) => voicesEnsure().filter(v => v.shotId === shotId && (!candId || v.candId === candId));
const clipVoiceKey = (shotId, candId, seg) => [shotId, candId, seg == null ? 0 : seg].join('|');
/* 这一段该带上哪几句配音，以及有几句被这一剪挤到了段外面（**不静默丢**：计数交给状态行说）。
   「放不放得下」用的是**源秒**（这一格选区的长度），不是这一段在成片里占的秒数：
   配音是跟着画面一起变速的（代理那句 `at = offset + start/speed` + `atrim duration = span - start`，
   span 就是源秒），拿成片秒当上界会让 2 倍速的那一段把后半句误判成「挤不出去」。
   以前这一句要靠调用方把 `tlClipDur(c)` 递进来（倍速恒为 1 时两个数相等，所以没人发现），
   现在上界只有这一处现算 —— 五个调用点都只递那一个 clip。
   这里的 `vol` 是**合成后**的那一个（这一句 × 它所在那一行的基数），六个调用点拿到的都是「进成片的音量」：
   指纹、预览、逐句导出、`/render` 因此不会再各说一件事（乘算只有 `voiceVolOf` 一份）。
   `spd` 同一立场：这一句自己的那一档（`voiceRateOf` 一份），代理与预览都从这一处拿，不在调用点各拼一遍。 */
/* 这一句压在的那一格**画面段**现在的倍速（回执与右栏那句读数要说这一句在成片里占多久时用）。
   找法与 `voicePinLocal` 的本镜那一支、右栏「这一条上的配音」那一行完全一样：shotId → candId → 段下标。
   ⚠ 它与 `bindVoiceLane` 里那枚局部 `voiceSpdOf` 是两条路：那一枚从**正在画的那一排的行表**里取
   `r.spd`（几何尺子，找不到行就是 1，比如别的镜压进来的那一截），这一枚从**数据**里取那一段真正的速度。
   倍速全为 1 时两者相等；行表换了（换页签、换候选）而数据没换时，只有前者跟着界面走。
   候选没了 / 段被删了就按 1 —— 那时这一句本来就进不了成片，由 `voiceFilmGap` 去说原因。 */
function voicePicSpd(v) {
  const sh = allShots().find(x => x.id === (v && v.shotId));
  const c = sh ? (sh.candidates || []).find(x => x.vid === v.candId) : null;
  if (!c) return 1;
  const segs = segsOf(c, candDur(c, sh));
  if (!segs.length) return 1;
  const s = segs[Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0))];
  return Math.max(0.25, Math.min(4, Number(s && s.spd) || 1));
}
/* 这一段带哪几句配音（`at` 相对本段起点，代理那侧按 start 延迟后与原声 amix）。
   `ctx` = `{ start, gray }`（**成片秒**）：`start` 是这一段的成片起点（= 前面每一格的 tlClipDur 之和），
   `gray` 是**全片**灰场区间表 `[[F0, F0+tlClipDur), …]` —— 一句配音压在灰场上时，音频在那里跳过
   （`voiceRuns`），逐段推一条：代理与预览都按「一段一条」放，跳过的那几秒自然空着。
   不给 `ctx` 时（逐句导出那条路）逐字节与从前相同：一段、start=v.at、off=off0。 */
function clipVoices(c, ctx) {
  const list = []; let skip = 0, placed = 0;
  const seg = c.seg == null ? 0 : c.seg;
  const span = Math.max(0.1, (Number(c.out) || 0) - (Number(c.in) || 0));
  const sp = Math.max(0.25, Math.min(4, Number(c.speed) || 1));
  const F0 = ctx ? Math.max(0, Number(ctx.start) || 0) : 0;
  const gray = ctx && ctx.gray && ctx.gray.length ? ctx.gray : null;
  voicesEnsure().forEach(v => {
    if (v.shotId !== c.shotId || v.candId !== c.candId || (v.seg == null ? 0 : v.seg) !== seg) return;
    const start = Math.max(0, Number(v.at) || 0);
    if (!v.src || start >= span) { skip++; return; }
    /* `off` = 这一句在**音频文件内部**的起点（拖左把手切掉开头时写的，默认 0）。
       它与 `start` 是两件事：start 是「在画面里从第几秒开始响」，off 是「从音频的第几秒开始取」。
       合成（-ss off）、播放（currentTime = off）都读它，两边口径必须一致。 */
    const dur = Math.max(0.1, Number(v.dur) || 0);
    const off0 = Math.max(0, Number(v.off) || 0);
    const base = { src: (window.EditorMedia ? window.EditorMedia.exportSrc({ src: v.src }) : v.src), vol: voiceVolOf(v), spd: voiceRateOf(v) };
    const vr = sp * (Number(v.spd) || 1);       // 这一句在成片里一秒吃掉多少音频文件秒（代理 atempo 同一把尺子）
    const lay = gray ? voiceRuns(F0 + start / sp, dur / vr, gray) : null;
    /* `placed` 数的是**句数**（不是拼出来的截数）：拆成两截的一句仍然只算「进画面了一句」——
       外面那句 `anchored - placed - skip` 是「锚在已不存在的段上」的会计，拿截数去比
       会把「拆了两截的一句」当成两句，真正的孤儿反而被盖过去。 */
    if (!lay || !lay.skips.length) {
      /* 没有跳过（或这一条根本没有灰场）→ 与从前一字不差：一段、原样三个数。
         也正因为这里逐字节相同，指纹（voiceFp）只在真的跳过时才变。 */
      list.push(Object.assign({ start: start, dur: dur, off: off0 }, base));
      placed++;
      return;
    }
    /* 有跳过：逐段推一条。换算回**源秒**口径（代理 `at = offset + start/speed`、`dur` 是音频文件秒）
       —— 单个 run 时 `(r0-F0)·sp` 恰好等于 start、`(r1-r0)·vr` 恰好等于 dur，两条路同源。 */
    let consumed = 0;
    lay.runs.forEach(r => {
      list.push(Object.assign({
        start: (r[0] - F0) * sp, dur: Math.max(0.1, (r[1] - r[0]) * vr), off: off0 + consumed,
      }, base));
      consumed += (r[1] - r[0]) * vr;
    });
    placed++;
  });
  return { list, skip, placed };
}
let voiceSkip = 0;      // 最近一次组装成片时「没进画面」的配音句数（合并 / 导出那句状态读它）
/* 一句配音在指纹里的样子：落在哪一秒、念多长、从音频第几秒取、**多大声**、**多快**。
   以前少了最后那一位 —— 于是「拖底边那条调音量」（或剪辑条上的音量 ±）改完，
   `filmFingerprint` 一个字不变 → `filmIsCurrent` 说盘上那份还是新的 → 连「导出成片」都走
   快捷路径直接把旧的那份递出去（downloadMergedFilm），
   界面上没有任何一句「成片是旧的」，用户听到的还是上一版的音量
   （用户点名的「音轨现在好像不能正确调整音量」：数据存对了、`/render` 也照那份混音，只是没人去重合成）。
   `off` 那一位以前同样没有，只是它总与 `at` 一起变（拖左把手两头同时走），所以没露过馅 —— 
   留着：任何一个数改了而指纹不变，都是同一类错。
   每一句一行、写成表达式而不是拼串：变异对照的锚点只能取单行（这份源码是 CRLF）。 */
const voiceFpOne = v => [Math.round(v.start * 10) / 10, v.dur, Math.round((v.off || 0) * 10) / 10, Math.round(Number(v.vol == null ? 1 : v.vol) * 100) / 100, Math.round(Number(v.spd || 1) * 100) / 100].join('~');
const voiceFp = (c, ctx) => clipVoices(c, ctx).list.map(voiceFpOne).join(',');

/* 一次拖动的手势骨架：在 window 上收 pointermove / pointerup / **pointercancel**，
   三处（画面轨把手、全片轨把手、语音块三个手势）共用这一份 —— 各写一遍就会各漏一个。
   为什么必须收 pointercancel：拖动是横向的，而轨道现在是个**横向滚动容器**，
   触屏/触控板上的横向手势会被浏览器抢去当滚动 —— 那时只来一个 pointercancel、**pointerup 永远不来**，
   表现就是「按下去拖不动 / 拖到一半卡住」。jsdom 里没有「浏览器抢手势」这回事，
   所以探针对此一直是绿的，只有真机上才看得见。 */
/* 手里正有一次拖动（下面那三处手势都从这里过）—— 唯一判据。
   轮询每 3 秒把中栏整列重建一次，撞在拖动中途就是把手指底下那个节点换掉：
   `paintVoice` / `segsPaint` 找不到节点只能干等，表现是「拖到一半画面不动，松手才跳到位」。
   `renderMid` 问这一处，一处落地（别在各个手势里各加一句「拖完再重画」）。 */
let dragDepth = 0;
const dragBusy = () => dragDepth > 0;
function dragOnWindow(move, up) {
  dragDepth++;
  let ended = false;
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    /* 计数先减、再收尾：松手那一下的 `up()` 里就有 `filmEdited()` → `renderAll()` → `renderMid()`，
       那时若还判成「正在拖」，整栏就不重画了 —— 用户看到的是「拖完/剪完界面停在旧的那一份」。 */
    if (!ended) { ended = true; dragDepth = Math.max(0, dragDepth - 1); }
    up();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  return stop;
}

/* 一次段编辑之后把配音重新落到段上：先把旧的相对秒还原成**源视频里的绝对秒**，
   再看这个绝对时刻新落在哪一段。正好被切掉那一句不删 —— 挪到紧随其后的那段开头，
   并把「挪了几句」照实说（这与「选了却没发」是同一类偏差）。 */
function reanchorVoices(sh, c, oldSegs, newSegs) {
  let moved = 0;
  shotVoices(sh.id, c.vid).forEach(v => {
    const os = oldSegs[Math.min(oldSegs.length - 1, Math.max(0, Number(v.seg) || 0))];
    if (!os) return;
    const fr = voiceFrameOf(v), at0 = Math.max(0, Number(v.at) || 0);
    const abs = os.in + at0;
    if (!newSegs.length) { v.seg = 0; v.at = 0; moved++; }
    else {
      let ni = newSegs.findIndex(s => abs >= s.in && abs < s.out);
      if (ni < 0) {
        ni = newSegs.findIndex(s => s.in > abs);
        if (ni < 0) ni = newSegs.length - 1;
        v.at = 0; moved++;
      } else v.at = round1(Math.max(0, abs - newSegs[ni].in));
      v.seg = ni;
    }
    /* 框与选区**一起**平移：画面剪一刀改的是「这一段从源里第几秒开始算」，
       不是「用户把音频的哪一截盖掉了」—— 框内那两块灰必须原样跟着走。
       （只挪 at 不挪 fa 的话，画面剪一下就把配音的剪辑痕迹抹平了。） */
    const d = (Number(v.at) || 0) - at0;
    v.fa = round1(fr.fa + d); v.fb = round1(fr.fb + d);
  });
  return moved;
}
/* 四把剪子都只改「这一条候选的段列表」，不碰别的东西 —— 本镜与全片读的是同一份。
   返回 `{ segs, at }`（at = 剪完之后指针该落在第几段）或 `{ err }`（当场把原因说清，不剪）。 */
function cutSegs(c, total, at, way) {
  const segs = segsOf(c, total);
  if (!segs.length) return { err: '这一条候选现在一段画面都没有：先在「全片」里换一条候选，或按 Ctrl+Z 退回剪切之前' };
  let i = segs.findIndex(s => at >= s.in && at < s.out);
  if (i < 0) i = segs.reduce((b, s, k) => (Math.abs(s.in - at) < Math.abs(segs[b].in - at) ? k : b), 0);
  const s = segs[i];
  /* 剪一刀要把这一段**自己身上**的四件事一起带走（音量 / 倍速 / 第几行 / 黑场旗标）——
     搬法只有 `segCarry` 一处，见它上面那段「以前每处各漏一两件」。 */
  const keep = o => segCarry(s, o);
  if (way === 'split') {
    if (at - s.in < SEG_MIN || s.out - at < SEG_MIN) return { err: '插针离这一段的边界不到 0.2 秒，切不开（往中间挪一点再切）' };
    /* 切开 = 把这一段的**框**按切点分成两个框，两段的选区各占一半 ——
       于是切开之后拖任一段的把手都不影响另一段（它们各在自己的框里）。 */
    segs.splice(i, 1, keep({ in: s.in, out: at, a: s.a, b: at }), keep({ in: at, out: s.out, a: at, b: s.b }));
    return { segs, at: Math.min(segs.length - 1, i + 1) };
  }
  if (way === 'left') {
    if (s.out - at < SEG_MIN) return { err: '插针后面剩不到 0.2 秒 —— 整段不要就点「删掉这一段」' };
    /* 向左切 = 把这一段的头切掉：选区左沿挪到插针处（夹在框里），**框一个字都不动** ——
       所以轨道上这一格的左边界、宽度，以及别的段的切片，全都不变，只是框内左边多一块灰。 */
    segs[i] = keep({ in: Math.max(s.a, round1(at)), out: s.out, a: s.a, b: s.b });
    return { segs, at: i };
  }
  if (way === 'right') {
    if (at - s.in < SEG_MIN) return { err: '插针前面不到 0.2 秒 —— 整段不要就点「删掉这一段」' };
    segs[i] = keep({ in: s.in, out: Math.min(s.b, round1(at)), a: s.a, b: s.b });
    return { segs, at: i };
  }
  if (way === 'drop') {
    /* 删掉一段画面 = **留在原位变灰**（成片里出黑场），不是从段列表里摘掉：
       这一段的框、选区、时长一格都不动，后面那些段不前移，锚在它们上面的配音也就不会被无声挪走
       —— 用户点名的「视频片段不消失而是变灰…以确保时间统一」就落在这里。
       对着已经灰掉的那一段再点一次就是把它放回来（同一颗按钮，按状态改口，见 syncTlTools）。 */
    if (s.off) { const o = Object.assign({}, s); delete o.off; segs[i] = o; return { segs, at: i, back: true }; }
    segs[i] = Object.assign({}, s, { off: 1 });
    return { segs, at: i, gray: 1 };
  }
  /* 融合：把插针这一段与它**右边**挨着的那一段合回一段（右边不行再试左边）。
     判据是「本来就是一刀切开、之后没再动过」—— 两段的**框**挨着（x.b === y.a）、
     且**选区**也接得上（x.out === y.in）。合成一段后框与选区都是并集，
     于是留下的东西与切开之前一模一样（这正是用户要的「再融合」）。
     ⚠ 中间被剪掉过一截的两段不许融：一段只有一个框、一个选区，接不上的话
       并集会把用户故意切掉的那一截**悄悄加回来**（静默改动画面 = 最坏的一种）。 */
  if (way === 'merge') {
    if (segs.length === 1) return { err: '这一条只有一段，没有可融合的相邻段' };
    const near = (a, b) => Math.abs(a - b) < 0.011;      // round1 过后同一秒可能差 1 个末位
    for (const p of [[i, i + 1], [i - 1, i]]) {
      const x = segs[p[0]], y = segs[p[1]];
      if (!x || !y) continue;
      if (!near(x.b, y.a) || !near(x.out, y.in)) continue;
      /* 音量不一样就不许融：一段只有一个音量，硬合就得替用户挑一个（或取平均），
         而那是**悄悄改声音** —— 与「把切掉的那一截加回来」同一类。当场说清、让人先调成一样。 */
      if (segVol(x) !== segVol(y)) {
        return { err: '这两段的音量不一样（' + Math.round(segVol(x) * 100) + '% / ' + Math.round(segVol(y) * 100)
          + '%），先调成一样再融合' };
      }
      /* 黑场与有画面的两段不许融：融合后一段只有一个画面旗标，硬合就等于替用户决定
         「这一整块要么全黑、要么全有画面」—— 与「把切掉的那一截悄悄加回来」同一类静默改动。 */
      if (!!x.off !== !!y.off) return { err: '这两段一个有画面、一个是黑场，先点「恢复这一段画面」把黑场变回来再融合' };
      /* 倍速不一样不许融：一段只有一个倍速，硬合就得替用户挑一个 —— 那是**悄悄改这一格在成片里占几秒**，
         与音量同一类。合成后那一段的秒数会变，而界面上没有任何一处说过「融合还会改时长」。 */
      if (segSpd(x) !== segSpd(y)) {
        return { err: '这两段的倍速不一样（' + spdTxt(segSpd(x)) + ' / ' + spdTxt(segSpd(y)) + '），先调成一样再融合' };
      }
      /* 不在同一行不许融：合完只有一行装得下，另一行上那一格等于被无声搬走了（行级音量也跟着换了一份基数）。 */
      if (picLnOf(x) !== picLnOf(y)) {
        return { err: '这两段不在同一行（第 ' + (picLnOf(x) + 1) + ' 行 / 第 ' + (picLnOf(y) + 1) + ' 行），把其中一段拖到同一行再融合' };
      }
      segs.splice(p[0], 2, keep({ in: x.in, out: y.out, a: x.a, b: y.b }));
      return { segs, at: p[0], fused: 2 };
    }
    return { err: '这两段中间被剪掉过一截（不是单纯切开的两半），融不回一段：按 Ctrl+Z 退回到剪那一刀之前，或直接用把手把入出点拖回去' };
  }
  return { err: '不认识这种剪法' };
}
/* 插针在哪个秒：播放器一直在放**焦点那条候选**，所以本镜与全片两个页签指的是同一个位置
   （不存在「全片里另有一根针」这第二份口径）。重画之后播放器还没就位时读上次记下的那一个。 */
function cutPin(c, total) {
  const pl = document.getElementById('player');
  const t = (pl && isFinite(Number(pl.currentTime))) ? Number(pl.currentTime) : (Number(proj.cutAt) || 0);
  return round1(Math.max(0, Math.min(total, t)));
}
/* 一次剪切的唯一出口：算新段 → 写候选 → 配音重新锚定 → 重画 → 一句话说清进不进成片。
   两颗入口（本镜页签、全片页签）都调它，所以「在 A 处剪了 B 处也要变」不是同步逻辑，是根本没有第二份数据。 */
function applyCut(way) {
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先挑一个镜头</span>'); return; }
  const cands = sh.candidates || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
  if (!c) { setStatus('<span class="err">这一镜还没有候选，先生成或导入一条视频再剪</span>'); return; }
  const total = candDur(c, sh);
  const oldSegs = segsOf(c, total);
  const at = cutPin(c, total);
  const r = cutSegs(c, total, at, way);
  if (r.err) { setStatus('<span class="err">' + r.err + '</span>'); return; }
  const newSegs = segsWrite(c, total, r.segs);
  proj.cutSeg = Math.max(0, Math.min(newSegs.length - 1, Number(r.at) || 0));
  proj.cutAt = at;
  const moved = reanchorVoices(sh, c, oldSegs, newSegs);
  const left = round1(segsFilmLen(c, total));
  /* 「删掉」现在不删段：段还留在原位，只是打上黑场旗标（时长与后面的段一个都不动 ——
     这正是用户要的「时间统一」）。所以这句回执不能说「删掉了」，得说清「成片里出黑、后面的段不前移」，
     并报出压在这一格上的配音句数（它们会跟着变色，但不会被人以为被删了）。 */
  const grayIdx = Number(r.at) || 0;
  const underGray = r.gray ? shotVoices(sh.id, c.vid).filter(v => (Number(v.seg) || 0) === grayIdx).length : 0;
  const what = way === 'split' ? '已在 ' + fmtDur(at) + ' 处切开'
    : way === 'left' ? '已把插针左边切掉'
    : way === 'right' ? '已把插针右边切掉'
    : way === 'drop' ? (r.back ? '已把这一段画面放回来'
      : '这一段画面删掉了（格子还在原位，成片里出 ' + fmtDur(round1((newSegs[grayIdx] || {}).out || 0) - round1((newSegs[grayIdx] || {}).in || 0)) + ' 黑场，后面的段一个都不前移'
        + (underGray ? '；压在这上面的 ' + underGray + ' 句配音照放，音轨上那几截已变色' : '') + '）')
    : way === 'merge' ? '已把这两段融合回一段'
    : '已取消裁剪';
  const inFilm = candSelected(sh, c);
  setStatus((inFilm ? '<span class="ok">✓ ' : '')
    + what + '：这一条现在 ' + newSegs.length + ' 段、共 ' + fmtDur(left)
    + (inFilm ? '，左栏时长与全片跟着变' : '，但这一条还没被选用，成片仍按选用的那条算')
    + (inFilm ? '' : '')
    + (moved ? '；有 ' + moved + ' 句配音正好被切掉，已挪到紧随其后的那段开头' : '')
    + (inFilm ? '</span>' : ''));
  filmEdited();
}
/* ============================================================================
   统一剪辑条 —— 画面段与配音句共用这一排按钮
   ----------------------------------------------------------------------------
   以前声音那一份是另一根条（挂在音轨行下面、点中一句才出现，按钮叫 `data-vop`），于是
   同一件事在两处两种做法：那一排剪子只对画面齐、音量有三个出口（±10% 两颗、块底拖动一条、
   条上读数一个）。用户点名的「两者功能一致使用统一的剪辑按钮」就收在这里。

   这一排只有**一个目标**（`tlCutTarget()`）：点过配音块就指那一句，点过画面格（含放插针）就指画面那一段。
   那五把「动某一段」的剪子（切开 / 向左 / 向右 / 删掉 / 融合）语义两边逐条对齐，差别只由数据形状本身决定：
     · 画面切「一段候选里的某一段」，声音切「一句配音」，切开都是新建一份；
     · 时间基不同：两排都按**轴秒**摊，只是尺子各量各的（本镜 = 这一条候选的框 ÷ 各段倍速，
       全片 = 成片秒）—— 从插针回到 `v.at` 那把尺子的换算只在 `voicePinLocal` 一处。
   音量也只有这一个出口（0–200%、步进 0.1 的滑块，挂在右栏那张「这一段 / 这一句」的卡上，
   与倍速并排）：块底那条可拖的横条已删，
   它把鼠标扫过音轨就变成 `ns-resize` 的「调整」光标，而那块地方本来是「挪位置 / 试听」。
   ========================================================================== */
const tlVoiceSel = () => voicesEnsure().find(x => x.id === proj.curVoice) || null;
/* 目标由**最后点的是哪一轨**决定（`proj.tlLane`），不是「只要还选中着一句配音就一直指配音」。
   以前那一版让「点了一格画面、把滑块推下去」调的是上一句配音，「删掉」删的也是配音 ——
   用户点名的两条（视频音量调不动、优先删语音）都出自这一行。
   配音那一侧还要多问一句「它真的还在」（删掉的、换镜丢下的都算没有），否则芯片指着空气。 */
const tlCutTarget = () => (proj.tlLane === 'voice' && tlVoiceSel() ? 'voice' : 'pic');
/* 按目标读回来的那一句配音（目标不是配音时一律 null —— 所有「改东西」的入口只问它，别问 tlVoiceSel） */
const tlVoiceHit = () => (tlCutTarget() === 'voice' ? tlVoiceSel() : null);
/* 「这一句此刻算不算被点中」也只有一份：目标轨是配音、而且就是当前那一句。
   从前画高亮只看 `proj.curVoice` —— 点一格画面之后目标已经交回画面轨（剪子与滑块改的是那一段），
   配音那一排却还留着一圈亮环，界面说的还是「指着这一句」（用户点名的「不被选中时不应该高亮」）。
   `proj.curVoice` 仍然留着：那是「回来接着改哪一句」的记号，不是「现在亮着哪一句」。 */
const voiceSelId = () => (tlCutTarget() === 'voice' ? proj.curVoice : '');
/* 画面那一侧的同一件事：`proj.cutSeg` 是「剪子指着第几段」（音量 / 倍速 / 入出点都写它），
   而「哪一格画着亮环」是另一件事 —— 目标换成配音那一下，上面那一格的白环必须当场掉，
   否则两条轨同时亮，用户看不出剪子究竟在哪一轨（与上面配音那一侧是同一个缺陷的另一半）。
   所以这里也只读目标，不读 `proj.cutSeg` 本身。判据仍然只有一份 `tlCutTarget`。 */
const picSelOn = () => tlCutTarget() === 'pic';
const picSelAt = (n) => (picSelOn() && n > 0) ? Math.min(n - 1, cutSegIdx()) : -1;
/* 右栏那一张卡此刻该显示**哪一轨**的功能（用户点名的第 ②③④ 条：点画面格开倍速那一族、点配音块开
   声音那一族、点空白轨道开「生成配音」）。它与 `tlCutTarget` 只差一件事：什么也没点过时照旧开配音那一侧
   （这一栏本来就是「剪辑 = 调这一条 + 加一句配音」，没点过画面轨就不要一上来把那块藏掉）。
   这里只读目标与用户的手指点在哪一轨，不写第二份「指着谁」（剪子仍只认 tlVoiceHit）。 */
function tlPanel() {
  if (tlCutTarget() === 'voice') return 'voice';
  /* 用户**点过一格画面**就是画面那一侧 —— 这一条得排在「这条候选一句配音都没有」之前（第 ② 条）：
     一个数都没有时照样有倍速、入出点、行音量可调，把它们藏掉等于点了画面格却只见「生成配音」。
     旧口径在这里多一道 `shotVoices()` 闸（没有配音就永远开配音那一侧），第 ② 条在最常见的那一镜上
     必然落空；「加上第一句配音」的出路改由落点给 —— 点空白轨道（`bindPinZone` 第三档）就是配音那一侧。 */
  if (proj.tlLane === 'pic') return 'pic';
  return 'voice';
}
/* 焦点候选：先看页签上当前那一条，再退回被选用的那一条（与 applyCut 同一取法） */
function cutCand() {
  const sh = curShot();
  if (!sh) return null;
  const cands = sh.candidates || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
  return c ? { sh: sh, c: c, total: candDur(c, sh) } : null;
}
/* 「剪刀此刻指着第几格 / 第几段」的唯一口径：条上那颗芯片与下面那句读数都问它（以前两处各数一遍，
   全片那一排明明有 4 格却同时能写出「第 1/1 段」—— 用户点名的第 6 条）。
   两个页签数的东西本来就不是同一族：
     · 本镜 = 这一条候选自己剪成的**段**（第 i/n 段）；
     · 全片 = 焦点那一格在**整排**里的位置（第 k/K 格），段号只作为副语（这一镜的第 i/n 段）。
   返回 { film, f, segs, i, seg, row, k, rows, tl, G, chip, sub }：算不出来的一律给保守值（不给假数）。 */
function tlFocusPos() {
  const f = cutCand();
  const segs = f ? segsOf(f.c, f.total) : [];
  const i = segs.length ? Math.min(segs.length - 1, cutSegIdx()) : -1;
  const o = { film: isFilmMode(), f: f, segs: segs, i: i, seg: i >= 0 ? segs[i] : null,
    row: null, k: -1, rows: 0, tl: null, G: null };
  if (!o.film) {
    o.chip = i >= 0 ? '第 ' + (i + 1) + '/' + segs.length + ' 段' : '没有画面段';
    o.sub = '';
    return o;
  }
  o.tl = tlSyncFromShots();
  o.G = filmFrames(o.tl);
  o.rows = o.G.rows.length;
  if (f && i >= 0) {
    o.row = o.G.rows.find(x => x.cl.kind === 'shot' && x.cl.shotId === f.sh.id
      && x.cl.candId === f.c.vid && Number(x.cl.seg || 0) === i) || null;
    if (o.row) o.k = o.row.k;
  }
  o.chip = o.k >= 0 ? '第 ' + (o.k + 1) + '/' + o.rows + ' 格' : '不在全片那一排';
  /* 副语只在这一镜真的被剪成几段时才说 —— 每一镜一段是最常见的形状，那句「第 1/1 段」是噪声 */
  o.sub = i >= 0 && segs.length > 1 ? '（这一镜第 ' + (i + 1) + '/' + segs.length + ' 段）' : '';
  return o;
}
/* 两条轨各自的「显 / 锁」（两颗小图标在轨道名旁边；音量不在这里 —— 它是**按行**的，见下面的 laneVol）：
     · 锁 = 这一轨不许拖、不许剪、不许调音量 —— 把手不画、手势当场拒并说明原因；
     · 显 = 关掉就把这一轨收成一条窄条（内容不画），长片子上腾出看另一轨的地方。
   两个都是**真拦 / 真收**，不是装饰：判据只有这里的 `laneState` 一份，
   渲染与手势都问它（自己拼 `proj.lane.x.lock` 的地方迟早有一处忘了问，锁就成了假锁）。
   存进工程（`proj.lane`）：它是「这一条片子怎么摆」的一部分，换镜头要跟着走。 */
function laneState(k) {
  const o = (proj && proj.lane && proj.lane[k]) || {};
  return { hide: !!o.hide, lock: !!o.lock };
}
const laneLocked = k => laneState(k).lock;
const laneHidden = k => laneState(k).hide;
/* ============================================================================
   上面那两颗管的是**整条轨**；这一组管的是**其中一行**
   ----------------------------------------------------------------------------
   用户点名的「添加出来的画面 / 配音轨道也要有收起、锁定、添加、音量」—— 四件事里
   添加与音量本来就有落点（`addLaneRow` / `laneVol`），缺的是单行的显与锁。
   **第 1 行不另设一套**：它就是这条轨的锚行，它的显 / 锁 = 轨名旁那两颗（`laneState`），
   所以 `ln<=0` 一律回退到轨级 —— 否则「锁了整条轨」与「锁了第 1 行」会算成两个数，
   左列两把锁各说各话，而 ⑰f/⑰g 那几档量的正是「按轨名那颗下去管的是整条轨」。
   存法与 `vols` / `rows` 同一记账：**只有非默认才占键**（`proj.lane[k].hides[ln]` / `.locks[ln]`），
   没收过、没锁过的行在数据里根本不存在，旧工程读回来一个字节都不用迁。
   整条轨那一档永远压得住单行（锁了轨 = 每一行都锁），反过来不成立：锁第 3 行不牵连
   第 1、2 行，也不牵连另一轨 —— 与「锁不牵连」那几条判据同一立场。
   ========================================================================== */
const rowFlag = (k, ln, what) => {
  if (ln <= 0) return false;
  const o = proj && proj.lane && proj.lane[k];
  const m = o && o[what];
  return !!(m && m[laneClamp(ln)]);
};
const rowHidden = (k, ln) => (ln <= 0 ? laneHidden(k) : (laneHidden(k) || rowFlag(k, ln, 'hides')));
const rowLocked = (k, ln) => (ln <= 0 ? laneLocked(k) : (laneLocked(k) || rowFlag(k, ln, 'locks')));
/* 两条轨的名字只在这里点一次名。以前「声音轨 / 配音轨」两种写法在同一个文件里各漂一半
   （左栏轨名、右栏标签、回执、title 四处各写各的），而「音轨」这个词在本页留给视频自己带的那条声音。 */
const laneNm = k => (k === 'voice' ? '配音轨' : '画面轨');
const rowNm = (k, ln) => laneNm(k) + '第 ' + (laneClamp(ln) + 1) + ' 行';
/* 「这一行现在为什么动不了」的一句话原因（空串 = 能）。锁的三处落地（把手不画 / 按钮压暗 /
   函数入口硬拒）与右栏那两枚滑块都问它，别在调用点各拼一句 —— 拼出来的措辞一漂，
   界面就在说一件数据层没做的事（整条轨锁着时说「第 N 行的锁」就是那种假话）。 */
function rowLockWhy(k, ln) {
  if (!rowLocked(k, ln)) return '';
  /* 整条轨那一句**逐字保持原样**（`配音轨已锁定` / `画面轨已锁定`）：调用点在它后面拼的
     「：这一刀不接。」+ `tlUnlockHow()` 与 ⑯b/⑰f 那几档判据读的都是这一串；
     行级才补上行号与「只这一行」，否则锁第 3 行会说成整条轨都锁了。 */
  if (laneLocked(k)) return laneNm(k) + '已锁定';
  return rowNm(k, ln) + '已锁定（只这一行，别的行照旧能拖能剪）';
}
/* 「去哪儿解锁」跟着上面那句的原因一起换：整条轨锁着指着轨名旁那颗，只锁了这一行就指着
   这一行标签上那颗。两处各写一遍「点轨名栏上那颗锁」就会出现「按钮亮着、点下去被拒，
   而拒的那句话指着一颗根本改不了这件事的按钮」。 */
function rowUnlockHow(k, ln) {
  return laneLocked(k) ? '点轨名栏上那颗锁解锁' : '点' + rowNm(k, ln) + '标签上那颗锁解锁';
}
/* 「这一行的基数音量为什么调不了」只在这一处拼。函数入口那道硬拒与右栏那枚滑块的 title 以前
   各写一遍 `rowNm + '已锁定：这一行的基数音量不调。'`，于是**整条轨锁着时界面说的是「画面轨第 1 行已锁定」**，
   而行标签上那颗锁明明亮着 —— 点它只管这一行，解不开整条轨的锁；指出去的出路是错的。
   措辞跟着 `laneLocked` 分两岔，`rowUnlockHow` 已经分过，这里只是把「不调」那一句接到同一份判据上。 */
function laneVolWhy(k, ln) {
  if (!rowLocked(k, ln)) return '';
  return (laneLocked(k)
    ? '整条' + laneNm(k) + '已锁定：这一行的基数音量不调（锁的是这条轨，不是单独这一行）。'
    : rowNm(k, ln) + '已锁定：这一行的基数音量不调。')
    + rowUnlockHow(k, ln) + '。';
}
/* 现在指着的那一轨（哪一行）为什么动不了 + 去哪儿解锁。闸与出口仍只有 `tlLockWhy` 一份，
   这里只是把「指着一行」那一句交出去，调用点不要自己拼行号。 */
function tlUnlockHow() {
  const t = cutLaneOf();
  const k = t ? t.k : (tlCutTarget() === 'voice' ? 'voice' : 'pic');
  return rowUnlockHow(k, t ? t.ln : 0);
}
function rowFlagToggle(k, ln, what, col) {
  const ln2 = laneClamp(ln);
  if (ln2 <= 0) { toolRefuse(rowNm(k, 0) + '是这条轨的锚行：它的收起与锁定就是轨名旁那两颗按钮，按它们就行。'); return; }
  proj.lane = proj.lane || {};
  const o = proj.lane[k] = proj.lane[k] || {};
  const m = o[what] = o[what] || {};
  const on = !m[ln2];
  if (on) m[ln2] = true; else delete m[ln2];
  if (!Object.keys(m).length) delete o[what];
  setStatus('<span class="ok">✓ ' + rowNm(k, ln2) + (what === 'locks'
    ? (on ? '已锁定：这一行上的块拖不动、剪不了，这一行的音量也不调（别的行与另一轨不受影响；解锁就点这一行标签上那颗锁）' : '已解锁')
    : (on ? '已收起（只剩这一行标签自己，块与把手都不画，再点一下眼睛展开）' : '已展开')) + '</span>');
  renderAll();
  scheduleSave();
}
/* 一条轨上第 ln 行的基数（默认 1，**只有 ≠1 才占一个键**，与段上的 vol/spd 同一记账）。
   它与片段音量是**乘算**不是覆盖 —— 「这一行压到 60%」之后某一格单独调到 100%，进成片仍是 60%，
   而那一格被调到 50% 时是 30%。两级各有出口，乘算只有下面 `picVolOf` / `voiceVolOf` 两处。
   夹回 0–200% 也只做这一处：`TlPlay.setPlan`、`filmFingerprint`、`/render` 拿到的必须是同一个数，
   夹在下游就会出现「指纹说变了、听着没变」与反过来的那种。
   ⚠ 行数可以有很多行（用户点名的「配音 / 视频都要无限多条轨道」），所以基数是**按行**记的，
   不是按整轨记的：只有一行时两者本来就是同一件事，多行时「整轨调音量」会把人刚调好的那一行盖掉。 */
const laneVol = (k, ln) => {
  const o = proj && proj.lane && proj.lane[k];
  const v = o && o.vols ? o.vols[Math.max(0, Math.round(Number(ln) || 0))] : undefined;
  return v == null || !isFinite(Number(v)) ? 1 : Math.max(0, Math.min(2, Number(v)));
};
const clampVol = x => Math.max(0, Math.min(2, Number(x) || 0));
/* 这一排要画几行 = **画得出来的东西里最高那一行 + 1**，至少一行（两条轨共用这一个判据）。
   空着的中间行照样画：抽掉空行会把它上面那一行整体往下塌一格，而那一格正是插针与刻度尺对齐的地方。 */
const laneRowsOf = items => (Array.isArray(items) ? items : [])
  .reduce((a, x) => Math.max(a, laneClamp(x && x.ln) + 1), 1);
/* 一条轨**至少**画几行（用户点名的「现在怎么添加新轨道」）。
   从前行数只由内容推出来（最高那一行 + 1），于是空行根本造不出来：想把下一句配音放到第 3 行，
   就得先把它拖过去，而第 3 行在界面上还不存在 —— 没有落点。
   存在工程里（`proj.lane[k].rows`，**只有 >1 才占一个键**，与 `vols` 同一记账，老数据不用迁移）。
   行数读法只有一份 `laneRowsFor`：渲染那一排的四条路（本镜画面 / 本镜声音 / 全片画面 / 全片声音）
   与左栏标签都问它，不许各自再拼一遍 `Math.max`。 */
const laneMinRows = k => {
  const o = proj && proj.lane && proj.lane[k];
  return Math.max(1, Math.min(TRACK_LANES_MAX, Number(o && o.rows) || 0));
};
const laneRowsFor = (k, n) => Math.max(laneMinRows(k), Math.max(1, Number(n) || 0));
/* 现在画了几行：数**已经画出来的行**（与 `syncLaneSide` 同一口径），不重算一遍数据 ——
   收起的那一轨仍然占着一行窄条，行数照旧。 */
const LANE_ROW_SEL = { pic: '.tl-vrow, .tl-film', voice: '.tl-lane' };
function drawnRows(k, col) {
  const bar = col && col.querySelector('#tlBar');
  if (!bar) return laneMinRows(k);
  return Math.max(1, bar.querySelectorAll(LANE_ROW_SEL[k]).length);
}
/* 加一行 / 删一行的判据与落地只有这一处（轨名旁那颗「＋」与每一行标签上那颗「×」只是它的两个出口）。
   两条要说清的拒绝：这一轨收着（加了也看不见）、到上限（再多左栏自己就要滚）。
   拒绝走工具栏那行小字（`class="info"`），不占顶部横幅 —— 横幅是「出错才常驻」那一档，
   「只剩一行」不是错误，用户按不动的原因写在按钮 title 里（见 syncLaneSide），这一句只是补一句。
   「＋」现在挂在**每一行**的标签上（用户点名的第 19 条），所以加行有两种走法：
   轨名那一颗挂在最下面（沿用从前的形状），第 N 行那一颗插在**这一行下面**、下面那些整体往下挪一格。 */
function toolRefuse(t) { setStatus('<span class="info">' + t + '</span>'); }
function addLaneRow(k, col, atLn) {
  if (atLn != null && atLn > 0) return insertLaneRow(k, atLn, col);
  const nm = laneNm(k);
  if (laneHidden(k)) { toolRefuse(nm + '此刻是收起的（行高只有 18px，加了也看不见）：先点轨名旁那颗眼睛展开。'); return; }
  const n = drawnRows(k, col);
  if (n >= TRACK_LANES_MAX) { toolRefuse(nm + '已经到 ' + n + ' 行，这是上限（再多左边那一列标签自己就要滚起来了）。'); return; }
  setLaneRows(k, n + 1);
  setStatus('<span class="ok">✓ ' + nm + '加到第 ' + (n + 1) + ' 行：把块上下拖就能挪到新行（行距、锁与音量都按行算；'
    + '每一行的标签上都有一颗「×」，能单独把它删掉）</span>');
  filmEdited();
}
/* 在**第 at 行下面**插一行（第 2 行往上那些标签上的「＋」）。新行是空的，但它占一个行号 ——
   原来挂在 at 以下的那些行整体往下挪一格，块上的 `ln` 与按行的三张表（基数音量 / 收起 / 锁定）
   必须一起挪：只挪块的话，「第 3 行的 60%」还挂在 3 上，于是压到补上来的那一行；
   只挪表的话，收起与锁定会跟着一个已经换了块的空行。 */
function insertLaneRow(k, at, col) {
  const nm = laneNm(k);
  const want = laneClamp(at);
  if (rowHidden(k, want)) {
    toolRefuse((want <= 0 ? nm : rowNm(k, want)) + '此刻是收起的（行高只有 18px，在它下面加了也看不见）：'
      + (want <= 0 ? '先点轨名旁那颗眼睛展开。' : '先点这一行上那颗眼睛展开。'));
    return;
  }
  const n = drawnRows(k, col);
  if (n >= TRACK_LANES_MAX) { toolRefuse(nm + '已经到 ' + n + ' 行，这是上限（再多左边那一列标签自己就要滚起来了）。'); return; }
  if (want >= n) { toolRefuse(nm + '第 ' + (want + 1) + ' 行此刻并不存在（现在 ' + n + ' 行）：整栏重画之后行号跟着变，重新点一次。'); return; }
  mapLaneBlockRows(k, cur => rowAfterInsert(cur, want));
  moveRowFlags(k, cur => rowAfterInsert(cur, want));
  const nextRows = n + 1;
  setLaneRows(k, nextRows);
  setStatus('<span class="ok">✓ 在' + rowNm(k, want) + '下面插了一行（现在 ' + nextRows + ' 行）：'
    + '原来第 ' + (want + 2) + ' 行往下的块整体往下挪一格，每一段的入出点、时长、倍速与配音一个字没动</span>');
  filmEdited();
}
/* 行号在「删一行 / 插一行」之后的走法，两张表（块上的 ln + 按行的三张表）共用同一个映射：
   · 删：被删那一行上的块并到**上面一行**（ln-1），再往上的每一行往下补一格；
   · 插：新行落在 at+1，at 以下（含 at 自己）不动，比 at 大的每一行往下挪一格。 */
const rowAfterDrop = (cur, ln) => (cur === ln ? ln - 1 : cur > ln ? cur - 1 : cur);
const rowAfterInsert = (cur, at) => (cur > at ? cur + 1 : cur);
/* 块上的行号过一遍（画面轨要遍历**所有候选**，不只当前那条：全片那一排把每一镜的段摊在同一批行里，
   只改当前这条的话，插/删的行号在别的镜上还留着，行自己长回来）。 */
function mapLaneBlockRows(k, fn) {
  let moved = 0;
  if (k === 'voice') {
    voicesEnsure().forEach(v => { const to = fn(voiceLn(v)); if (to !== voiceLn(v)) { v.ln = to; moved++; } });
  } else {
    allShots().forEach(sh => (sh.candidates || []).forEach(c => {
      if (!Array.isArray(c.segs)) return;
      const total = candDur(c, sh);
      const list = segsOf(c, total);
      let ch = 0;
      list.forEach(s => { const to = fn(picLnOf(s)); if (to !== picLnOf(s)) { s.ln = to; ch = 1; moved++; } });
      /* 写回走 `segsWrite`：它顺手把 `ln=0` 那个键摘掉（第一行是缺省，与 vol/spd 同一记账） */
      if (ch) segsWrite(c, total, list);
    }));
  }
  return moved;
}
/* 按行记的那三张表（基数音量 `vols` / 收起 `hides` / 锁定 `locks`）一起过同一个映射。
   只有非默认才占键（与 `laneVol` / `rowFlag` 同一记账），所以搬完之后：并进第 0 行的那一份
   没有地方记就随它消失（第 0 行 = 默认，不留一份「看不见的加压」），塌空的表整个删掉。 */
const ROW_FLAG_COLS = ['vols', 'hides', 'locks'];
function moveRowFlags(k, fn) {
  const o = proj && proj.lane && proj.lane[k];
  if (!o) return;
  ROW_FLAG_COLS.forEach(what => {
    const src = o[what];
    if (!src) return;
    const out = {};
    Object.keys(src).forEach(key => {
      const cur = Number(key);
      if (!isFinite(cur)) { out[key] = src[key]; return; }
      const to = laneClamp(fn(cur));
      if (to > 0) out[to] = src[key];
    });
    if (Object.keys(out).length) o[what] = out; else delete o[what];
  });
}
function shiftLaneRows(k, ln) {
  let on = 0, below = 0;
  const hit = cur => {
    const to = rowAfterDrop(cur, ln);
    if (to !== cur) { if (cur === ln) on++; else below++; }
    return to;
  };
  mapLaneBlockRows(k, hit);
  moveRowFlags(k, cur => rowAfterDrop(cur, ln));
  return { on: on, below: below };
}
/* 删掉**指定的那一行**（用户点名的第 ⑤ 条：多添加出来的轨道要能够独立删除）。
   从前只有「最后一行并且它是空的」收得掉（− 只挂在最后一行的标签上），于是加出来的第 2、3 行
   只要摆上过东西就永远删不掉。这一行上的块不许凭空消失：它们并到上面那一行，
   再往上的行整体往下补一格 —— 画面段在同一条候选里时间上前后不相接，并上去不会叠；
   配音句本来就允许同一行有好几句。这与「上下拖块体换行」是同一件事的反方向，不是新出口。
   第 1 行是锚行：整条轨至少留一行，要收起来用轨名旁那颗眼睛。 */
function dropLaneRow(k, ln, col) {
  const nm = laneNm(k);
  if (laneHidden(k)) { toolRefuse(nm + '此刻是收起的（行高只有 18px，删了也看不见）：先点轨名旁那颗眼睛展开。'); return; }
  const n = drawnRows(k, col);
  if (n <= 1) { toolRefuse(nm + '只剩一行，没有可删的：整条轨要收起来点轨名旁那颗眼睛。'); return; }
  const want = Math.max(0, Math.round(Number(ln) || 0));
  if (want <= 0) { toolRefuse(nm + '第 1 行是这条轨的锚行：整条轨至少留一行，删掉它等于整条轨没了。'); return; }
  if (want >= n) { toolRefuse(nm + '第 ' + (want + 1) + ' 行此刻并不存在（现在 ' + n + ' 行）：整栏重画之后行号跟着变，重新点一次。'); return; }
  /* 只收起**这一行**时那颗「×」本来就被 CSS 藏掉、`syncLaneSide` 又把它压暗，函数入口照样硬拒 ——
     删掉一条看不见的行等于让用户不知道自己删了什么（与「承诺要么实现、要么改文案」同一立场）。 */
  if (rowHidden(k, want)) { toolRefuse(rowNm(k, want) + '此刻是收起的（行高只有 18px，删了也看不见）：先点这一行上那颗眼睛展开。'); return; }
  const mv = shiftLaneRows(k, want);
  setLaneRows(k, n - 1);
  setStatus('<span class="ok">✓ 删掉了' + nm + '第 ' + (want + 1) + ' 行'
    + (mv.on ? '：这一行上的 ' + mv.on + ' 个块并到第 ' + want + ' 行' : '')
    + (mv.below ? (mv.on ? '，' : '：') + '再往下的 ' + mv.below + ' 个块往上补一格' : '')
    + '（每一段的入出点、时长、倍速、配音与它们各自的音量一个字没动；'
    + '按行记的那三张表 —— 基数音量 / 收起 / 锁定 —— 跟着块一起挪了行号）</span>');
  filmEdited();
}
function setLaneRows(k, n) {
  proj.lane = proj.lane || {};
  const o = proj.lane[k] = proj.lane[k] || {};
  const v = Math.max(1, Math.min(TRACK_LANES_MAX, Math.round(Number(n) || 1)));
  if (v <= 1) delete o.rows; else o.rows = v;
}
/* 把「某一格画面」挪到画面轨第几行的落地只有一份：本镜那一排（`bindSegDrag` 上下拖）与
   全片那一排（`bindFilmReorder` 上下拖）两只手都只是它的出口。行号写在候选那一段的 `s.ln` 上，
   两条轨读的是同一个数 —— 所以「在本镜挪到第 3 行、切到全片还在第 3 行」不是同步逻辑，是没有第二份账。
   只改排版：入出点、框、倍速、配音一律不动（进成片看的是时间线，不是第几行）。 */
function setCellLane(sh, cand, segIdx, ln) {
  if (!sh || !cand) return null;
  const total = candDur(cand, sh);
  const list = segsCopy(segsOf(cand, total));
  const s = list[Math.max(0, Math.min(list.length - 1, Number(segIdx) || 0))];
  if (!s) return null;
  s.ln = laneClamp(ln);
  segsWrite(cand, total, list);   // 走 segsWrite：它顺手把 `ln=0` 那个键摘掉（第一行是缺省）
  return s;
}
/* 整条轨的静音（用户点名的第 ② 条：点轨道左边那枚音量图标切静音）。
   与音量是**两件事**：静音不动任何一级音量（段 / 句自己的 vol 与行基数原样留着），
   取消静音就回到原样；乘算只在 `picVolOf` / `voiceVolOf` 两处，所以预览、指纹、
   `/render` 三处读到的是同一个数。只有 true 才占键（与 vols / hides / locks 同一记账）。 */
const laneMute = k => {
  const o = proj && proj.lane && proj.lane[k];
  return !!(o && o.mute);
};
/* 整轨音量那个数的清单（**不按「此刻选中谁」筛**）：左列那枚滑块与右栏那枚「整轨音量」
   改的是同一批东西（段 / 句自己的 vol），但左列不看选中，右栏跟着手走。 */
function trackVoiceScope() {
  if ((proj.tlTab || 'shot') === 'film') return voicesEnsure().filter(x => !!voiceFilmSpan(x));
  const sh = curShot();
  if (!sh) return [];
  const c = cutCand();
  return shotVoices(sh.id, c && c.vid);
}
const trackOwnVol = k => (k === 'voice'
  ? trackVoiceScope().map(v => (v && v.vol != null && isFinite(Number(v.vol)) ? Number(v.vol) : 1))
  : trackSegsNow().map(s => segVol(s)));
function laneMuteToggle(k) {
  k = k === 'voice' ? 'voice' : 'pic';
  if (laneLocked(k)) {
    toolRefuse('整条' + laneNm(k) + '已锁定：静音也不切。' + rowUnlockHow(k, 0) + '。');
    return;
  }
  proj.lane = proj.lane || {};
  const o = proj.lane[k] = proj.lane[k] || {};
  const on = !o.mute;
  if (on) o.mute = true; else delete o.mute;
  setStatus('<span class="' + (on ? 'warn' : 'ok') + '">' + icon(on ? 'speakerOff' : 'speaker', 12) + ' '
    + laneNm(k) + (on
      ? '已静音：预览与成片这一轨都不出声（每一段 / 每一句的音量原样留着，再点一下恢复）'
      : '已取消静音') + '</span>');
  renderAll();
  scheduleSave();
}
const picVolOf = s => clampVol(segVol(s) * laneVol('pic', picLnOf(s)) * (laneMute('pic') ? 0 : 1));
/* 工程 → 时间线的投影（镜头顺序与 clips 派生）在 projection.js；播放计划 / 导出 / FCPXML 读同一份。 */
const { filmShotsOrdered, filmOrderNow, moveShotInFilmOrder, tlFromShots, tlSyncFromShots } = createProjection({
  getProj: () => proj, allShots, shotReady, tlCandidateOf, candDur, segSpd, picVolOf, uid,
});
const voiceVolOf = v => clampVol((v && v.vol != null && isFinite(Number(v.vol)) ? Number(v.vol) : 1)
  * laneVol('voice', voiceLn(v)) * (laneMute('voice') ? 0 : 1));
function setLaneVol(k, vol, ln) {
  const ln2 = laneClamp(ln);
  const nm = rowNm(k, ln2);
  /* 与片段那枚滑块同一把锁的判据，但问的是**这一行**：锁着第 3 行时第 1、2 行照样要能调（不牵连），
     锁着另一轨也管不着这一轨 —— 判据只有 `rowLocked` 一份（整条轨锁着时它压得住每一行）。 */
  if (rowLocked(k, ln2)) { setStatus('<span class="err">' + laneVolWhy(k, ln2) + '</span>'); return; }
  proj.lane = proj.lane || {};
  const o = proj.lane[k] = proj.lane[k] || {};
  if (o.vol != null) delete o.vol;          // 上一版的「整轨」那一个键：换成按行记之后不留双份
  o.vols = o.vols || {};
  const v = clampVol(vol);
  if (v === 1) delete o.vols[ln2]; else o.vols[ln2] = v;
  const other = k === 'voice' ? '画面上的原声不受影响' : '配音那一句不受影响';
  /* 正在试听的那一句要当场跟着变（画面那一路不用管：下面的 filmEdited → 整栏重画
     → `TlPlay.setPlan` 末尾的 applyVol 会把新音量按到正在播的甲板上，而甲板音量不进播放指纹，
     不会把正在听的那一句掐断重放）。 */
  if (k === 'voice' && voiceEl && !voiceEl.paused) {
    const cur = voicesEnsure().find(x => x.id === voiceEl.__vid);
    if (cur) { try { voiceEl.volume = Math.max(0, Math.min(1, voiceVolOf(cur))); } catch (e) {} }
  }
  setStatus('<span class="ok">✓ ' + nm + '音量 ' + Math.round(v * 100) + '%（这一行上每一段都跟着'
    + (v < 1 ? '变轻' : v > 1 ? '变响（超过 100% 的部分只在合并成片时生效）' : '回到原样') + '，别的行与' + other + '）</span>');
  filmEdited();
}
function laneToggle(k, what) {
  proj.lane = proj.lane || {};
  const o = proj.lane[k] = proj.lane[k] || {};
  o[what] = !o[what];
  const nm = laneNm(k);
  setStatus('<span class="ok">✓ ' + nm + (what === 'lock' ? (o.lock ? '已锁定：拖、剪、调音量都不接了' : '已解锁')
    : (o.hide ? '已收起（再点一下眼睛展开）' : '已展开')) + '</span>');
  renderAll();
  scheduleSave();
}
/* 把焦点切到「这一句自己那一镜 + 它那一条候选 + 它那一段」，然后整栏重画。
   本镜那一排上「溢出进来的那一截」是只读的（时间基不是它的），而用户点它就等于说
   「我要改这一句」—— 所以给的是跳过去，不是留一句「这里改不了」。 */
function focusVoiceShot(v) {
  const sh = allShots().find(x => x.id === v.shotId);
  if (!sh) { setStatus('<span class="err">这一句挂的那个镜头已经不在了：它只是留在时间线上的一条配音</span>'); return false; }
  const sc = proj.scenes.find(s2 => s2.shots.includes(sh));
  if (sc) { proj.curScene = proj.scenes.indexOf(sc); proj.curShot = sc.shots.indexOf(sh); }
  const ci = (sh.candidates || []).findIndex(x => x.vid === v.candId);
  if (ci >= 0) proj.curCand = ci;
  proj.cutSeg = Math.max(0, Number(v.seg) || 0);
  selectVoice(v.id);              // 连目标一起交回配音（只写 curVoice 的话芯片还指着画面，剪子却该剪这一句）
  setStatus('<span class="ok">✓ 已跳到「' + (sh.name || '镜头') + '」：这一句现在可以拖、可以剪了</span>');
  renderAll();
  return true;
}
/* 插针落在「这一句」的时间轴上的第几秒（口径 = `v.at` 用的那个：相对它锚定那一段的选区起点）。
   取不到就带 `{ err }` 回来，由调用方把原因说清 —— 猜一个 0 会把人话剪成静音。 */
function voicePinLocal(v) {
  const sh = allShots().find(x => x.id === v.shotId);
  const c = sh ? (sh.candidates || []).find(x => x.vid === v.candId) : null;
  if ((proj.tlTab || 'shot') === 'film') {
    const tl = tlSyncFromShots(), G = filmFrames(tl);
    const r = G.rows.find(x => x.cl.kind === 'shot' && x.cl.shotId === v.shotId && x.cl.candId === v.candId
      && (Number(x.cl.seg) || 0) === (Number(v.seg) || 0));
    if (!r) return { err: '这一句在「全片」那一排上找不到它那一格（它那一镜可能还没被选用）：切回「本镜」再剪' };
    /* `base` 与 `filmPinT` 都是**轴秒**（轨道那一排的尺子），相减之后还要 × 倍速才回到
       `v.at` 的那一把尺子（段内源 / 音频秒）—— 忘了这一步，2 倍速的那一格上「在针处剪一刀」会剪在句子中间。 */
    const base = srcToFrame(r, Math.max(0, Number(r.cl.in) || 0));
    return { at: round1((filmPinT(tl, G) - base) * r.spd) };
  }
  if (!c) return { err: '这一句挂的那条候选已经不在了：到它自己那一镜的剪辑里再看一眼' };
  const total = candDur(c, sh), segs = segsOf(c, total);
  const s = segs.length ? segs[Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0))] : null;
  if (!s) return { err: '这一句锚着的那一段画面已经被删掉了：按 Ctrl+Z 退回到删段之前，或直接删掉这一句' };
  return { at: round1(cutPin(c, total) - s.in) };
}
/* 声音那一侧的五把剪子。与 `cutSegs` 逐条同义：框不动、只收选区、切开新建一份、
   融合只接「一刀切开且之后没再动过」的两半、音量不等就拒绝融合。 */
function applyVoiceCut(way) {
  const v = tlVoiceHit();
  if (!v) { setStatus('<span class="err">先点轨道上的一句配音，这一排按钮才指着它</span>'); return; }
  const fr = voiceFrameOf(v);
  const at0 = Math.max(0, Number(v.at) || 0), dur0 = Math.max(VOICE_MIN, Number(v.dur) || 0);
  const off0 = Math.max(0, Number(v.off) || 0);
  /* 一句自己的倍速（第 ⑤ 条那一档；merge 那一路另按每对 x/y 各取各的）：
     `at / fa / fb` 在**源秒**上量，`dur / off` 在**音频文件秒**上量 ——
     剪一刀或切一头时「消耗了多少文件秒」= 源秒差 × own，三把剪子都要这一道。 */
  const own = voiceRateOf(v);
  const near = (a, b) => Math.abs(a - b) < 0.011;         // round1 之后同一秒可能差 1 个末位
  const name = String(v.name || v.text || '配音').slice(0, 12);
  const say = (ok, t) => { setStatus((ok ? '<span class="ok">✓ ' : '<span class="err">') + t + '</span>'); };
  if (way === 'drop') {
    proj.voices = voicesEnsure().filter(x => x.id !== v.id);
    proj.curVoice = '';
    say(1, '已删掉那一句配音（画面没动）'); filmEdited(); return;
  }
  if (way === 'merge') {
    /* 同一段里的配音按框左沿排队，先试右边那一颗再试左边（与画面同一顺序）。
       三条都接上才算「本来是一刀切开的两半」：框挨着、选区挨着、**音频文件里的位置**也挨着 ——
       最后那一条是音频独有的（两句可能都从音频第 0 秒起，时间上接着、内容上却是重复的一段）。 */
    const list = voicesEnsure().filter(x => x.shotId === v.shotId && x.candId === v.candId
      && (Number(x.seg) || 0) === (Number(v.seg) || 0))
      .sort((a, b) => (voiceFrameOf(a).fa - voiceFrameOf(b).fa));
    const k = list.findIndex(x => x.id === v.id);
    for (const p of [[k, k + 1], [k - 1, k]]) {
      const x = list[p[0]], y = list[p[1]];
      if (!x || !y) continue;
      const fx = voiceFrameOf(x), fy = voiceFrameOf(y);
      /* 相邻判据里的「x 的结尾在哪」必须换回**源秒**再和 `y.at` 比：`x.dur` 是音频文件秒，
         直接加在 `x.at`（源秒）上等于把念多快当成占多长 —— ×1.5 的两半之间会算出
         「相隔 0.25 秒」，看着永远融不回去。`off + dur` 那一头是文件秒比文件秒，不用动。 */
      const sx = voiceRateOf(x), sy = voiceRateOf(y);
      const ex = Math.max(0, Number(x.at) || 0) + Math.max(0, Number(x.dur) || 0) / sx;
      if (!(near(fx.fb, fy.fa) && near(ex, Number(y.at) || 0) && near(Math.max(0, Number(x.off) || 0) + Number(x.dur || 0), Number(y.off) || 0))) continue;
      const vx = Number(x.vol == null ? 1 : x.vol), vy = Number(y.vol == null ? 1 : y.vol);
      if (vx !== vy) {
        say(0, '这两句的音量不一样（' + Math.round(vx * 100) + '% / ' + Math.round(vy * 100) + '%），先调成一样再融合');
        return;
      }
      /* 倍速同一立场（第 ③ 条之后它是切得开的两半了）：一刀切开的两半本来同一个数，
         切完之后单独调过其中一半就说明它们已经不是「原来那一句」，并回去等于悄悄丢掉一档变速。 */
      if (sx !== sy) {
        say(0, '这两句的倍速不一样（' + spdTxt(sx) + ' / ' + spdTxt(sy) + '），先调成一样再融合');
        return;
      }
      x.fb = round1(fy.fb);
      x.dur = round1((ex - (Number(x.at) || 0)) * sx + (Number(y.dur) || 0));
      proj.voices = voicesEnsure().filter(z => z.id !== y.id);
      proj.curVoice = x.id;
      say(1, '已把这两句融合回一句（' + round1(x.dur) + ' 秒，画面没动）'); filmEdited(); return;
    }
    say(0, '这一句与旁边的不是「一刀切开、之后没再动过」的两半，融不回一句：按 Ctrl+Z 退回到切开之前，或直接删掉这一句');
    return;
  }
  const loc = voicePinLocal(v);
  if (loc.err) { say(0, loc.err); return; }
  if (way === 'split') {
    /* `loc.at` 与 `at0` 都是**源秒**，而 `dur0 / off0` 是**音频文件秒**：切下去消耗的文件秒
       = 源秒差 × `own`。直接拿源秒差去减 `dur0`，×1.5 的那一句切出来两半的时长加起来
       不等于原来的（回执与轨道都会跟着错）。
       三个写点（切开 / 向左切 / 向右切）一律**不 round1**：两半是「一份账拆开」，独立取整会把
       守恒断掉（0.75 / 0.25 各自进成 0.8 / 0.3，两半加起来比原来长 0.1 秒），而且后半的
       `at` 与前半的右沿对不上（0.9333 vs 0.9），融合那道相邻判据先于倍速判据把它拦掉 ——
       表现是「一刀切开之后这两半永远融不回去」。量化只发生在**手势入点**：插针按 `voicePinLocal`
       取整、拖动松手按 `roundVoice` 取整，所以这里拿到的 `loc.at` 本来就是整齐的。 */
    const d = loc.at - at0, df = d * own;
    if (df < VOICE_MIN || dur0 - df < VOICE_MIN) {
      say(0, '插针离这一句的两头太近（切完会有一段不足 ' + round1(VOICE_MIN) + ' 秒），切不开：把针挪到这一句中间再切'); return;
    }
    const fb0 = fr.fb;
    const v2 = Object.assign({}, v, {
      id: uid(), at: loc.at, dur: dur0 - df, off: off0 + df,
      fa: loc.at, fb: fb0,
    });
    v.fb = loc.at; v.dur = df;
    voicesEnsure().push(v2);
    proj.curVoice = v.id;
    say(1, '在 ' + fmtDur(loc.at) + ' 秒处把这一句切成两句（前半 ' + round1(d) + ' 秒 / 后半 ' + round1(dur0 / own - d) + ' 秒）');
    filmEdited(); return;
  }
  if (way === 'left') {
    if (loc.at <= at0 + VOICE_MIN / own) {
      say(0, '插针在这一句的开头之前（这一句从 ' + round1(at0) + ' 秒起）——向左切没东西可切。把针挪进这一句里，或改用「向右切」');
      return;
    }
    if (loc.at >= at0 + (dur0 - VOICE_MIN) / own) {
      say(0, '插针在这一句的结尾之后 —— 向左切等于整句都不要了，那样请直接点「删掉这一句」'); return;
    }
    const na = Math.max(Math.max(fr.fa, at0 - off0 / own), loc.at);
    const d = (na - at0) * own;
    v.at = na; v.dur = dur0 - d; v.off = off0 + d;
    say(1, '已把这一句的开头切掉到插针处（现在从音频第 ' + round1(v.off) + ' 秒起、长 ' + round1(v.dur) + ' 秒）');
    filmEdited(); return;
  }
  if (way === 'right') {
    if (loc.at >= at0 + (dur0 - VOICE_MIN) / own) {
      say(0, '插针在这一句的结尾之后（或正好压在结尾）——向右切没东西可切'); return;
    }
    if (loc.at <= at0 + VOICE_MIN / own) {
      say(0, '插针在这一句的开头之前 —— 向右切等于整句都不要了，那样请直接点「删掉这一句」'); return;
    }
    v.dur = Math.max(VOICE_MIN, (loc.at - at0) * own);
    say(1, '已把这一句的结尾切到插针处（现在长 ' + round1(v.dur) + ' 秒，右边那一截灰掉的不进成片）');
    filmEdited(); return;
  }
  say(0, '不认识这种剪法');
}
/* 这一排按钮的唯一入口：先问目标，再走对应那把剪子。
   两颗入口（本镜 / 全片页签）都绑它 —— 「在一处剪了另一处跟着变」不是同步逻辑，是没有第二份数据。 */
function runCut(way) {
  /* 「试听」只听按目标读回来的那一句：指着画面时它是隐藏的，但快捷键之类别的路径照样得拒 ——
     拿 proj.curVoice 去试听会出现「芯片写着画面、嘴里放的是上一句配音」。 */
  if (way === 'play') {
    const vv = tlVoiceHit();
    if (!vv) { setStatus('<span class="err">现在指着的是画面段，没有可试听的配音：先点轨道上的一句配音</span>'); return; }
    playVoicePreview(vv.id); return;
  }
  /* 锁轨是「改不动」的判据，剪辑条与轨上手势问同一个 tlLockWhy()：
     按钮压暗、点下去也照实说原因 —— 只在手势里拒，就会出现「按钮亮着、点了没反应」。 */
  const why = tlLockWhy();
  if (why) { setStatus('<span class="err">' + why + '：这一刀不接。' + tlUnlockHow() + '。</span>'); return; }
  if (tlCutTarget() === 'voice') applyVoiceCut(way);
  else applyCut(way);
}
/* 现在指着的那一轨锁没锁，锁了就说人话（没锁回空串）。
   「试听」不走这里 —— 锁的是「改」，不是「听」。
   问的是**那一行**（`rowLocked`）：整条轨锁着时每一行都锁（它压得住行级），
   只锁了第 3 行时第 1、2 行照旧能剪 —— 指到第 3 行那一格才拒。
   没有可指的目标（还没有段 / 还没选过）时按锚行那一档问，也就是问整条轨。 */
function tlLockWhy() {
  const k = tlCutTarget() === 'voice' ? 'voice' : 'pic';
  const t = cutLaneOf();
  return rowLockWhy(k, t && t.k === k ? t.ln : 0);
}
/* 音量的唯一出口：滑块 0–200%（步进 0.1 = 无级）。画面写进段自己的 `vol`，
   配音写 `v.vol`；两边都只有一份账，块上的颜色与读数由这次写入之后现画。 */
function setCutVol(vol) {
  /* 与那一排剪子同一把锁的判据：滑块虽然已经被 syncTlTools 压暗，这里还是要真拒 ——
     「按钮 disabled 了但函数还能被别的路径调到」正是承诺与实现分家的地方。 */
  const whyLock = tlLockWhy();
  if (whyLock) { setStatus('<span class="err">' + whyLock + '：音量不调。' + tlUnlockHow() + '。</span>'); return; }
  const v = tlVoiceHit();
  if (v) {
    v.vol = vol;
    document.querySelectorAll('#tlBar .tl-lane').forEach(l => paintVoiceVol(l, v));
    const rd = document.getElementById('tlVolVal');
    if (rd) rd.textContent = Math.round(vol * 100) + '%';
    /* 正在响的就是这一句 → 就地改（拖到哪儿听到哪儿；浏览器给 <audio> 封顶 1，超出只在合并时生效）
       —— 按**合成后**的数改（这一句 × 它所在那一行的基数），不然那一行压到 60% 时拖这一句会当场听到 100%。 */
    if (voiceEl && !voiceEl.paused) { try { voiceEl.volume = Math.max(0, Math.min(1, voiceVolOf(v))); } catch (e) {} }
    filmEdited();
    return;
  }
  const f = cutCand();
  if (!f) { setStatus('<span class="err">这一镜还没有候选，没有可调音量的画面段</span>'); return; }
  const segs = segsOf(f.c, f.total);
  if (!segs.length) { setStatus('<span class="err">这一条一段画面都没留：按 Ctrl+Z 退回剪切之前，再调音量</span>'); return; }
  const i = Math.min(segs.length - 1, cutSegIdx());
  segs[i].vol = vol;
  segsWrite(f.c, f.total, segs);
  const rd2 = document.getElementById('tlVolVal');
  if (rd2) rd2.textContent = Math.round(vol * 100) + '%';
  const pl = document.getElementById('player');
  if (pl) { try { pl.volume = Math.min(1, picVolOf(segs[i])); } catch (e) {} }
  /* 格子分在好几行里之后，DOM 顺序不再等于段号 —— 只能按 `data-seg` 找回那一格的读数。 */
  const lab = document.querySelector('#tlBar .tl-vrow .tl-seg[data-seg="' + i + '"] .lab');
  if (lab) lab.textContent = segLabel(i, segs[i]);
  setStatus('<span class="ok">✓ 第 ' + (i + 1) + ' 段的原声现在是 ' + Math.round(vol * 100) + '%（'
    + (vol > 1 ? '超过 100% 的部分只在合并成片时生效' : '预览里当场就能听到') + '）</span>');
  filmEdited();
}
/* ---------------- 第几行（画面轨与声音轨的「多行」）----------------
   行数 `ln` 是**显式数据**（段上的 `s.ln` / 配音上的 `v.ln`，缺省 0 = 第一行，与从前一模一样）。
   不自动挤行：自动排的话同一句在「本镜」那一排与「全片」那一排的重叠集合不是同一个
   （本镜只看这条候选的段，全片看所有镜），切一次页就跳一次行，而用户刚刚亲手拖到第二行等于白拖。
   两个出口：轨道上**上下拖块体**（见 bindVoiceLane ②）与这里这颗「移一行」（拖不动的时候用它）。 */
const cutLaneOf = () => {
  const v = tlVoiceHit();
  if (v) return { k: 'voice', ln: voiceLn(v), obj: v };
  const w = cutSpdSeg();
  if (!w) return null;
  return { k: 'pic', ln: picLnOf(w.segs[w.i]), w: w };
};
function laneWhy() {
  const why = tlLockWhy();
  if (why) return why + '：不换行。' + tlUnlockHow() + '。';
  if (!cutLaneOf()) return '还没有指着可以换行的东西：点轨道上的一格画面或一句配音。';
  return '';
}
function setCutLane(delta) {
  const why = laneWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const t = cutLaneOf();
  const to = laneClamp(t.ln + (delta > 0 ? 1 : -1));
  if (to === t.ln) {
    setStatus('<span class="err">' + laneNm(t.k) + '一共 ' + TRACK_LANES_MAX
      + ' 行，这一' + (t.k === 'voice' ? '句' : '段') + '已经在' + (delta > 0 ? '最下面' : '最上面') + '那一行了</span>');
    return;
  }
  if (t.k === 'voice') {
    t.obj.ln = to;
    setStatus('<span class="ok">✓ 这一句配音移到了' + laneNm('voice') + '第 ' + (to + 1) + ' 行（时间、时长与音量一个字不动；这一行的音量在右栏那枚滑块上调）</span>');
  } else {
    t.w.segs[t.w.i].ln = to;
    segsWrite(t.w.f.c, t.w.f.total, t.w.segs);
    setStatus('<span class="ok">✓ 第 ' + (t.w.i + 1) + ' 段画面移到了画面轨第 ' + (to + 1) + ' 行（只是排版：进成片的顺序与时长看的是时间线，不是第几行）</span>');
  }
  filmEdited();
}
/* 画面那一枚倍速**只改画面段**（配音那一侧有它自己的一枚：`voiceSpdWhy` / `setVoiceSpd`，
   乘在画面倍速之上）。
   所以「指着配音」时这一枚一律不接，并把原因写成「这一句念多快用『这一句倍速』那一排」，
   不是干脆压暗不吭声。（说「上面那一排」曾经就是错的：画面那一排此刻整块收起，
   用户看得见的那一枚在它**下面**，指路要指着看得见的那一排。）
   目标不是配音时把「指着的那一段」连同候选一起递回来 —— 三个写点都用它，判据只这一份。 */
function cutSpdSeg() {
  if (tlCutTarget() === 'voice') return null;
  const f = cutCand();
  if (!f) return null;
  const segs = segsOf(f.c, f.total);
  if (!segs.length) return null;
  return { f: f, segs: segs, i: Math.min(segs.length - 1, cutSegIdx()) };
}
/* 「这一段现在能不能改倍速」的一句话原因（空串 = 能）。锁、目标、有没有段三种情形同一条路，
   syncTlTools 的压暗与 setCutSpd 入口的硬拒问的都是它 —— 分开写就会出现
   「按钮亮着、点下去说什么都不发生」。 */
function spdWhy() {
  const why = tlLockWhy();
  if (why) return why + '：倍速不改。' + tlUnlockHow() + '。';
  if (tlCutTarget() === 'voice') return '这一枚调的是画面那一段在成片里占多久：现在指着的是配音那一句，画面那一排整个收起 —— 要改这一句念多快，用「这一句倍速」那一排';
  if (!cutSpdSeg()) return '这一镜还没有画面段：先生成或导入一条候选，或按 Ctrl+Z 退回剪切之前。';
  return '';
}
/* 倍速的唯一写点（形状与 setCutVol 一致：先问闸 → 写段 → segsWrite → 读数现画 → filmEdited）。
   改的是这一段的 `spd`，也就是「这一段占多久」。**两条轨的格子都跟着缩 / 放**（`shotFrames` 与
   `filmFrames` 都按 框 ÷ 倍速 摆），数据层一个字节不添 —— 从前这里只改全片那一排，本镜那一排按
   源秒摆所以一格不动，用户拖到底看不出这一镜有什么变化（点名的第 11 条）。 */
function setCutSpd(spd) {
  const why = spdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const w = cutSpdSeg();
  const v = Math.max(0.25, Math.min(4, Number(spd) || 1));
  w.segs[w.i].spd = v;
  const list = segsWrite(w.f.c, w.f.total, w.segs);
  const s = list[Math.min(list.length - 1, w.i)];
  syncTlTools();
  const word = v > 1 ? '变窄' : v < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 第 ' + (w.i + 1) + ' 段现在是 ' + spdTxt(v) + '：源 ' + round1(segLen(s))
    + ' 秒 → 成片 ' + round1(segFilmLen(s)) + ' 秒（两条轨的这一段与压在它上面的配音块一起' + word + '）</span>');
  filmEdited();
}
/* 右栏最下面那行的画面分支。倍速按**传进来的那一个**算，不回头读数据：拖动中途数据还没写，
   读 `segSpd(seg)` 就等于「手已经拖到 ×2，那行字还写着上一秒的 ×1」，非要人松手才看到对的数。 */
function segLenText(seg, spd) {
  if (!seg) return '';
  const r = Math.max(0.25, Math.min(4, Number(spd) || 1));
  const ln = picLnOf(seg), base = laneVol('pic', ln);
  const mix = base !== 1 ? ' · 原声进成片 ' + Math.round(picVolOf(seg) * 100) + '%（段 '
    + Math.round(segVol(seg) * 100) + '% × 第 ' + (ln + 1) + ' 行 ' + Math.round(base * 100) + '%）' : '';
  return '这一段：源 ' + round1(segLen(seg)) + ' 秒 → 成片 '
    + Math.max(0.05, round1(segLen(seg) / r)) + ' 秒（' + spdTxt(r) + '）' + mix;
}
/* 这一句在**成片里**念几秒：块上那行小字、右栏那句读数、`setVoiceSpd` 的回执读的都是这一个除法。
   三处各写一遍就会出现「回执念 0.7 秒而旁边读数还挂着 1 秒」。 */
const voiceSecs = (v, spd) => v ? round1(Math.max(0.1,
  (Number(v.dur) || 0) / (Math.max(0.01, Number(spd) || 1) * voicePicSpd(v)))) : '0';
/* 右栏最下面那行的配音分支（与 `segLenText` 同一立场：倍速按传进来的那一个算）。 */
function voiceLenText(v, spd) {
  if (!v) return '';
  const ln = voiceLn(v), base = laneVol('voice', ln), pic = voicePicSpd(v);
  const r = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, Number(spd) || 1));
  const mix = base !== 1 ? ' · 这一句进成片 ' + Math.round(voiceVolOf(v) * 100)
    + '%（句 ' + Math.round(Number(v.vol == null ? 1 : v.vol) * 100) + '% × 第 ' + (ln + 1) + ' 行 '
    + Math.round(base * 100) + '%）' : '';
  return '这一句：从画面第 ' + round1(Math.max(0, Number(v.at) || 0)) + ' 秒起 · 念 '
    + voiceSecs(v, r) + ' 秒（画面 ' + spdTxt(pic) + ' × 自己 ' + spdTxt(r) + '）' + mix;
}
/* 「这一句现在能不能改倍速」的一句话原因（空串 = 能）：锁 + 有没有指着配音两档走同一条路。
   右栏那枚滑块压暗与 `setVoiceSpd` 入口的硬拒问的都是它 —— 与 `spdWhy` 同一立场：
   「按钮亮着、点下去说什么都不发生」与「按不动却没说为什么」都算承诺与实现分家。 */
function voiceSpdWhy() {
  const why = tlLockWhy();
  if (why) return why + '：倍速不改。' + tlUnlockHow() + '。';
  if (!tlVoiceHit()) return '这一枚改的是配音那一句：先点轨道上的一句声音块（现在指着的是画面那一段）。';
  return '';
}
/* 把「这一句念多快」写进数据，**并把它在轨道上那个框跟着缩放**（用户点名的第 11 条）。
   框（`fa/fb`，源秒、相对所在那一格选区起点）就是这一句「占地方」的那一段 —— 念得快该占得更少。
   从前这里只写 `spd`、框一个字不动，而 `voiceFrameOf` 的兜底只会长框（`fb = max(fb, at + dur/own)`），
   于是 ×2 之后块上那行小字写着「念 0.7 秒」而那块还占着 1.4 秒的地方（界面上「听着快了、看着没变」）。
   缩放只能锚在**选区起点 `at`** 上：整框乘倍数会把这一句的起点一起搬走（×2 之后从画面第 2 秒起
   变成从第 1 秒起 = 改个倍速顺手把时间也改了）。锚在 `at` 上，左、右两块灰按同一个倍数一起缩，
   起点一秒不挪，`at / dur / off` 三个合成字段照旧不动（倍速不改变「从音频第几秒起、念几秒内容」）。
   ⚠ **只有本来就有框的句才缩放，且缩完之后一律留着**（以前「恰好等于选区就把两个键摘掉」）：
     · 本来没有框 = 老数据，它的框按定义就是「跟着选区走的整条音频」（`voiceFrameOf` 现算 `at + dur/own`），
       倍速一变那个现算值自己就跟着变 —— 写一份等于它的数进数据里纯属占位；
     · 本来有框的句要是被摘掉，下一次拖左把手切头就没了「框」这个参照：块会**整体缩小**而不是
       「左沿不动、左边那块灰变宽」（把手的下界正是 `fr.fa`）—— 加进来时定下的那块地方被一次改倍速无声抹平，
       与「拖把手不改框」这条几何纪律直接打架。`fa/fb` 既不进播放计划指纹也不进提交体，留着没有陈旧代价。
   ⚠ 缩放后的两个数**按 0.01 秒收**，不用拖动收尾那把 0.1 秒的尺子（`roundVoice`）：倍速是乘在一个
     已经量化过的数上再乘回去的，0.1 的格子每走一趟最多漏 0.05 再乘上 4 倍 —— 本机实测
     ×1→×2→×4→×1 一圈下来框从 1.2 秒变成 1.4 秒（块比听着的一句长一截）。0.1 那一档只属于手拖的落点。 */
const frame1 = x => Math.round((Number(x) || 0) * 100) / 100;
function voiceSetRate(v, r) {
  const own = voiceRateOf(v);
  const at = Math.max(0, Number(v.at) || 0);
  const fa = Number(v.fa), fb = Number(v.fb);
  if (r !== own && fa >= 0 && fb > fa) {
    const k = own / r;
    /* 左沿只能缩到「这一格选区的起点」（`fa` 的基准就是它，负数=框跑到这一格之前，
       那块灰会画出格子外面）；右沿不设上界 —— 尾巴越过这一格就是跨到后面那一段 / 那一镜。 */
    v.fa = Math.max(0, frame1(at + (fa - at) * k));
    v.fb = Math.max(at + 0.05, frame1(at + (fb - at) * k));
  }
  if (r === 1) delete v.spd; else v.spd = r;
  return own;
}
/* 配音倍速的唯一写点（形状与 setCutSpd / setCutVol 一致：先问闸 → 写数据 → 读数现画 → filmEdited）。
   1 是缺省，所以**删键不写**：旧数据、新数据在指纹里是同一个数，导出过一次的那份成片不会因为
   「多了一个 spd:1」而被判成旧的。 */
function setVoiceSpd(spd) {
  const why = voiceSpdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const v = tlVoiceHit();
  const r = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, Number(spd) || 1));
  voiceSetRate(v, r);
  /* 正在试听的就是这一句 → 当场跟着变（与音量同一立场：拖到哪儿听到哪儿）。 */
  if (voiceEl && !voiceEl.paused && voiceEl.__vid === v.id) { try { voiceEl.playbackRate = r; } catch (e) {} }
  /* 三处读数（主读数 / 轨道块上那行小字 / 最下面那句秒数）一起跟着数据走 ——
     从前这里只改主读数，于是「×1.5」配着一句没改口的「念 1 秒」，而 `setCutSpd` 早就调了
     `syncTlTools()`：同一排两枚滑块一个改三处、一个改一处，就是两份口径各漂一处。 */
  syncTlTools();
  const word = r > 1 ? '变窄' : r < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 这一句现在是 ' + spdTxt(r) + '：念 ' + voiceSecs(v, r)
    + ' 秒（画面那一段 ' + spdTxt(voicePicSpd(v)) + '），轨道上这一块' + word + '、起点不动）</span>');
  filmEdited();
}
/* ---------------- 「整轨」那一族：把这一排画出来的每一格 / 每一句都设成**这一枚滑块自己**那一档 ----------------
   用户点名的第 11 条的后半（「调整整轨则整个轨的都进行相应拉长或者收缩」），与 2026-10-16 点名的
   「整轨的倍速与音量应该和段 / 句的分开，可以分别调整」：从前这里是一颗按钮，读的是**旁边那枚滑块的当前档**，
   于是「整排 ×2、这一句仍 ×1」做不到 —— 非先把拇指拖到 ×2 才按得动那颗按钮，而那一步本身已经把指着的那一句
   改成 ×2 了（改一个顺手改了另一个，两件事被拴在同一枚滑块上）。现在整轨自己有枚滑块，各读各的、各写各的。
   范围**跟着页签走**，因为「整条轨」在界面上就是这一排：本镜 = 这一条候选的所有段 / 锚在它上面的所有句，
   全片 = 每一镜选用那一条候选的所有段 / 此刻进得了成片的所有句。
   三条硬纪律：**① 写点只有 `segsWrite` 那一条数据路、`voiceSetRate` 那一份与句上的 `vol`** ——
   这一族只是对着清单把它们各调一遍，不另开一份批量写数据的口径（自己拼 segs 就是「整轨改了、
   音量与行号被抹了」那一类）；**② 闸与段 / 句那一枚同一个**（`spdWhy` / `voiceSpdWhy` / `tlLockWhy`），
   压暗与硬拒分家 = 滑块亮着、拖下去屏幕上一个字都不动；**③「这一排此刻没东西可改」那句话只拼一份**
   （`trackEmptyWhy`）：压暗时写进 title、拖下去时打进回执，两处各写一遍迟早对不上。 */
function trackSegTargets() {
  const out = [];
  if ((proj.tlTab || 'shot') === 'film') {
    const seen = new Set();
    tlSyncFromShots().clips.forEach(cl => {
      if (!cl || cl.kind !== 'shot') return;
      const sh = allShots().find(x => x.id === cl.shotId);
      const c = sh ? tlCandidateOf(sh, cl.candId) : null;
      if (!c) return;
      const key = sh.id + '::' + c.vid;
      if (seen.has(key)) return;
      seen.add(key);
      const total = candDur(c, sh);
      const segs = segsOf(c, total);
      if (segs.length) out.push({ c: c, total: total, segs: segs });
    });
    return out;
  }
  const w = cutSpdSeg();
  if (w && w.segs.length) out.push({ c: w.f.c, total: w.f.total, segs: w.segs });
  return out;
}
/* 「这一排此刻没有可改的东西」那句原因只拼一份（画卡时压暗的 title 与函数入口的硬拒读的是它）。
   闸（锁 / 指着别的轨）与「没东西」是两类话，合成一句就会在解锁之后仍然说不通。 */
function trackEmptyWhy(k) {
  const film = (proj.tlTab || 'shot') === 'film';
  return k === 'voice'
    ? '这一排此刻没有可改的配音：' + (film ? '先在候选上点「用这条」，或到「插入语音」合成一句。'
      : '先点轨道上的一句声音块。')
    : (film ? '全片那一排此刻没有格子：先在候选上点「用这条」，这一排才会出现画面段。'
      : '这一镜还没有画面段：先生成或导入一条候选，轨道上才有格子可设。');
}
/* 这一排此刻画出来的所有段（「整轨倍速」与「整轨音量」共用同一份清单，不按要改哪个字段分两份）。 */
const trackSegsNow = () => trackSegTargets().reduce((a, t) => a.concat(t.segs), []);
/* 「这一排是不是都同一档」只在这一处问：一致返回那一个数，不一致返回 null（读数不能替其中一档代言）。 */
function trackOne(vals) {
  const u = [];
  vals.forEach(x => { if (u.indexOf(x) < 0) u.push(x); });
  return { one: u.length === 1 ? u[0] : null, kinds: u.length, first: u.length ? u[0] : null };
}
function setTrackSpd(spd) {
  const why = spdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const list = trackSegTargets();
  /* 「这一排此刻没有格子可改」与「闸没通过」是两句话：`spdWhy()` 走到这里已经必然是空串，
     拿它当回执等于滑块拖到底屏幕上一个字都不动。 */
  if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('pic') + '</span>'); return; }
  const v = Math.max(0.25, Math.min(4, Number(spd) || 1));
  let n = 0;
  list.forEach(t => {
    t.segs.forEach(s => { s.spd = v; n++; });
    segsWrite(t.c, t.total, t.segs);
  });
  syncTlTools();
  const word = v > 1 ? '变窄' : v < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 整条画面轨 ' + n + ' 段（' + list.length
    + ((proj.tlTab || 'shot') === 'film' ? ' 镜' : ' 条候选')
    + '）都设成 ' + spdTxt(v) + '：这一排的每一格一起' + word + '，源秒与入出点不动）</span>');
  filmEdited();
}
/* 配音那一侧的「整轨」：范围与画出来的块同一份判据（本镜 = `shotVoices`，全片 = 能算出 `voiceFilmSpan`
   的那几句 —— 挂在没被选用的候选上的孤句这一排根本不画，改它等于背着一句没说出口的话动手）。 */
function trackVoiceTargets() {
  if ((proj.tlTab || 'shot') !== 'film') {
    const v = tlVoiceHit();
    if (!v) return [];
    return shotVoices(v.shotId, v.candId);
  }
  return voicesEnsure().filter(x => !!voiceFilmSpan(x));
}
function setTrackVoiceSpd(spd) {
  const why = voiceSpdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const list = trackVoiceTargets();
  if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('voice') + '</span>'); return; }
  const v = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, Number(spd) || 1));
  list.forEach(x => voiceSetRate(x, v));
  if (voiceEl && !voiceEl.paused && list.some(x => x.id === voiceEl.__vid)) { try { voiceEl.playbackRate = v; } catch (e) {} }
  syncTlTools();
  const word = v > 1 ? '变窄' : v < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 整条配音轨 ' + list.length + ' 句都设成 ' + spdTxt(v)
    + '：每一块一起' + word + '，各句起点与时长一个字不动）</span>');
  filmEdited();
}
/* 「整轨音量」：把这一排此刻画出来的每一段 / 每一句**自己的**音量都设成这一档（用户点名的
   「整轨与段 / 句分开、可以分别调整」的音量那一半 —— 倍速那一半在上面那两个 `setTrack*Spd`）。
   改谁跟着手走：指着配音就改句、指着画面就改段，与上面那枚「这一段 / 这一句音量」共用同一份
   `tlVoiceHit()` 判据，不在这里留第二份「现在改谁」。
   它与「那一行的基数」是两件事：基数是乘在每一份之上的那一个数（`laneVol`），这一枚改的是那一些数本身。
   写点仍只有那两条：段走 `segsWrite`、句走 `paintVoiceVol` 现画块上那一层颜色，
   乘算只在 `picVolOf` / `voiceVolOf` 一处 —— 这里不碰那两份。 */
function setTrackVol(vol, lane) {
  /* 左列那枚滑块**自己点名**改哪一轨（用户点名的第 ② 条：轨道左边的音量 = 整轨音量）。
     右栏那枚不传 lane，仍跟着「此刻指着谁」走。两处写的是同一批字段，闸却要各问各的轨：
     指着配音时去调画面轨那枚，拿 tlLockWhy 会把配音轨的锁算到画面头上。 */
  const k = lane === 'voice' || lane === 'pic' ? lane : (tlVoiceHit() ? 'voice' : 'pic');
  const why = lane ? (laneLocked(k) ? '整条' + laneNm(k) + '已锁定：整轨音量不调。' : '') : tlLockWhy();
  if (why) { setStatus('<span class="err">' + why + (lane ? rowUnlockHow(k, 0) + '。' : '：音量不调。' + tlUnlockHow() + '。') + '</span>'); return; }
  const n = Number(vol);
  const r = Math.max(0, Math.min(2, isFinite(n) ? n : 1));
  const pct = Math.round(r * 100) + '%';
  if (k === 'voice') {
    const list = trackVoiceScope();
    if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('voice') + '</span>'); return; }
    list.forEach(x => { x.vol = r; });
    document.querySelectorAll('#tlBar .tl-lane').forEach(l => list.forEach(x => paintVoiceVol(l, x)));
    /* 正在响的那一句就在这一排里 → 按**合成后**的数当场改口（拖到哪儿听到哪儿；浏览器给 <audio> 封顶 1，
       超出 100% 的部分只在合并时生效）。 */
    if (voiceEl && !voiceEl.paused) {
      const cur = list.filter(x => x.id === voiceEl.__vid)[0];
      if (cur) { try { voiceEl.volume = Math.max(0, Math.min(1, voiceVolOf(cur))); } catch (e) {} }
    }
    syncTlTools();
    if (!lane) { setStatus('<span class="ok">✓ 整条配音轨 ' + list.length + ' 句自己的音量都设成 ' + pct
      + '（与上面那枚各调各的；进成片还要乘所在那一行的基数）</span>'); }
    else { setStatus('<span class="ok">✓ 整条配音轨 ' + list.length + ' 句自己的音量都设成 ' + pct
      + '（每一句现在指着谁都不影响这一枚；进成片还要乘所在那一行的基数）</span>'); }
    filmEdited();
    return;
  }
  const list = trackSegTargets();
  if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('pic') + '</span>'); return; }
  let cnt = 0;
  list.forEach(t => {
    t.segs.forEach(s => { s.vol = r; cnt++; });
    segsWrite(t.c, t.total, t.segs);
  });
  syncTlTools();
  const w = cutSpdSeg();
  const pl = document.getElementById('player');
  if (pl && w) { try { pl.volume = Math.min(1, picVolOf(w.segs[w.i])); } catch (e) {} }
  setStatus('<span class="ok">✓ 整条画面轨 ' + cnt + ' 段（' + list.length
    + ((proj.tlTab || 'shot') === 'film' ? ' 镜' : ' 条候选') + '）原声都设成 ' + pct
    + '（与上面那枚各调各的；'
    + (r > 1 ? '超过 100% 的部分只在合并成片时生效' : '进成片还要乘所在那一行的基数') + '）</span>');
  filmEdited();
}
/* 右栏那张「这一段 / 这一句」卡的就地重画：只由 syncTlTools 调（它已经算好了目标），
   这里不自己再判一遍「指着谁」—— 两处各判一次就可能出现芯片与滑块各说一件事。
   `v` = 现在指着的那一句配音（不是配音就 null），`seg` = 现在指着的那一段画面（没有就 null）。
   最下面那两枚「行音量」问的是**目标所在那一行**的锁（`rowLocked`：整条轨锁着时每一行都锁），
   不是芯片指着谁就锁谁：锁住画面轨不会把配音轨那枚一起按死（锁不牵连），
   只锁了第 3 行也不会挡住第 1、2 行的基数。
   ── 这一张卡（含它旁边轨道上的措辞）只有五个名词，新增一排控件时照这张表取名，
      别再为同一个东西起第六个别名（用户点名的第 26 条：「段 / 格 / 条」三种叫法混在一排里，
      看着像三个不同的东西各有自己的一枚滑块）：
        段 = 画面轨上被切出来的一段（`c.segs` 的一条）→「这一段」
        句 = 配音轨上的一句配音（`proj.voices` 的一条）→「这一句」
        行 = 一条轨里的一条横带（`ln`，只决定画在哪，不决定时间）→「第 N 行」
        轨 = 画面轨 / 配音轨整一条（锁、收起、基数音量都有「轨级」与「行级」两档）
        镜 = 一条候选镜头（`candidates` 的一条）→「这一镜」，不用「这一条」
      「格 / 格子」只留给**轨道上那个看得见的方块**这一层（「删掉之后格子还在原位、原地变黑场」说的就是它），
      不再拿来当「段」的别名；「颗 / 枚」的分工是按钮用颗、滑块用枚。 */
function paintTlAdjust(v, seg) {
  const card = document.getElementById('tlAdj');
  if (!card) return;
  /* 三种口径先各就各位（用户点名的第 20 条：以前「音量」那一排与「画面轨 / 配音轨」那一排
     标签都只写「音量」，看着像同一件事的两个入口，而它们一个是**这一段 / 这一句自己**、
     一个是**它所在那一行的基数**，两者相乘才进成片）。标签与 title 都按此刻指着谁现写：
     点画面格说「段」，点配音块说「句」；两个乘起来是多少写在最下面那行读数里。 */
  const labOf = (id, t) => { const el = document.getElementById(id); if (!el) return; el.textContent = t;
    // 标签叫什么，旁边那枚控件在读屏里就叫什么（以前静态 aria-label 一直停在「音量」，
    // 界面上已经写「这一段音量 / 这一句音量」了，读出来还是那个分不清归属的老词）。
    const nx = el.nextElementSibling;
    const sl = nx && nx.querySelector ? nx.querySelector('input') : null;
    if (sl) sl.setAttribute('aria-label', t); };
  const volBox = document.getElementById('tlVolBox');
  if (seg) {
    labOf('tlVolLab', '这一段音量');
    if (volBox) volBox.title = '这一段画面的音量（0–200%，无级）：进成片还要乘所在那一行的基数';
  } else if (v) {
    labOf('tlVolLab', '这一句音量');
    if (volBox) volBox.title = '这一句配音的音量（0–200%，无级）：进成片还要乘所在那一行的基数';
  } else {
    labOf('tlVolLab', '音量');
    if (volBox) volBox.title = '先在轨道上点一段画面或一句配音：这一枚调的是那一个自己的音量，不是整条轨';
  }
  const whySpd = spdWhy();
  const box = document.getElementById('tlSpdBox');
  const spdSl = document.getElementById('tlSpd');
  const spdRd = document.getElementById('tlSpdVal');
  const curSpd = seg ? segSpd(seg) : 1;
  if (box) box.classList.toggle('off', !!whySpd);
  if (spdSl) { spdSl.disabled = !!whySpd; spdSl.value = String(Math.round(curSpd * 20) / 20); }
  if (spdRd) spdRd.textContent = spdTxt(curSpd);
  /* 配音那一侧的倍速（第 ③ 条）：读数与压暗都在这一处现算，
     与 `setVoiceSpd` 的闸、回执读同一份 `voiceRateOf` / `voicePicSpd` —— 不留第二份口径。
     指着画面段时这一枚压暗并写明它管的是配音（两块本来互斥，这里只是把「按不动」说清楚）。 */
  const vBox = document.getElementById('tlVoiceSpdBox');
  const vSpdSl = document.getElementById('tlVoiceSpd');
  const vSpdRd = document.getElementById('tlVoiceSpdVal');
  const whyVSpd = voiceSpdWhy();
  const curVSpd = v ? voiceRateOf(v) : 1;
  if (vBox) vBox.classList.toggle('off', !!whyVSpd);
  if (vSpdSl) vSpdSl.disabled = !!whyVSpd;
  if (vSpdSl) vSpdSl.value = String(Math.round(curVSpd * 20) / 20);
  if (vSpdRd) vSpdRd.textContent = spdTxt(curVSpd);
  /* 三枚「整轨」滑块与段 / 句那几枚**各读各的、各写各的**（用户点名要分开的正是这一对）：
     闸仍是那一份（`spdWhy` / `voiceSpdWhy` / `tlLockWhy`）—— 闸分写两处就会出现
     「那一枚拖不动、这一枚照样能拖，一拖批改了整排」。
     读数问的是「这一排此刻是不是都同一档」（`trackOne`）：不一致就写「不一 · N 档」，
     不替其中一档代言（把第 1 段的 ×1 写成整排的档，等于界面在说一件这一排并不满足的话）；
     不一致时滑块停在**第一个数**上，拖下去以它为起点是可预期的。
     title 里那句范围跟着页签现写 —— 「整条轨」在界面上就是**此刻这一排**，
     本镜与全片装的段数不是一回事，写死一句就是假话。 */
  const filmTab = (proj.tlTab || 'shot') === 'film';
  const scopePic = filmTab ? '每一镜选用那一条候选的所有段' : '这一条候选的所有段';
  const scopeVoice = filmTab ? '此刻进得了成片的所有句' : '这一条候选上的所有句';
  const SPD_OPTS = { def: 1, defRd: '×1', toSl: x => Math.round(x * 20) / 20, fmt: spdTxt };
  const VOL_OPTS = { def: 1, defRd: '100%', toSl: x => Math.round(x * 1000) / 10, fmt: x => Math.round(x * 100) + '%' };
  const ownVol = x => (v ? Number(x.vol == null ? 1 : x.vol) : segVol(x));
  const trackPaint = (kind, boxId, slId, rdId, vals, why, scope, o) => {
    const bx = document.getElementById(boxId), sl = document.getElementById(slId), rd = document.getElementById(rdId);
    if (!sl || !rd) return;
    const t = trackOne(vals);
    const gap = vals.length ? '' : trackEmptyWhy(kind);
    const off = !!why || !!gap;
    if (bx) {
      if (!bx.dataset.base) bx.dataset.base = bx.title;
      bx.classList.toggle('off', off);
      bx.title = why || gap || (bx.dataset.base + '（' + scope + '）');
    }
    sl.disabled = off;
    sl.value = String(o.toSl(vals.length ? (t.one === null ? vals[0] : t.one) : o.def));
    rd.textContent = !vals.length ? o.defRd
      : (t.one === null ? '不一 · ' + t.kinds + ' 档' : o.fmt(t.one));
  };
  const trSegs = trackSegsNow(), trVoices = trackVoiceTargets();
  trackPaint('pic', 'tlSpdTrackBox', 'tlSpdTrack', 'tlSpdTrackVal',
    trSegs.map(segSpd), whySpd, scopePic, SPD_OPTS);
  trackPaint('voice', 'tlVoiceSpdTrackBox', 'tlVoiceSpdTrack', 'tlVoiceSpdTrackVal',
    trVoices.map(voiceRateOf), whyVSpd, scopeVoice, SPD_OPTS);
  trackPaint(v ? 'voice' : 'pic', 'tlVolTrackBox', 'tlVolTrack', 'tlVolTrackVal',
    (v ? trVoices : trSegs).map(ownVol), tlLockWhy(), v ? scopeVoice : scopePic, VOL_OPTS);
  const lenEl = document.getElementById('tlAdjLen');
  /* 那一行上的音量：压暗与硬拒问的都是**自己那一轨**的锁（画面轨锁着时配音轨照样能调 —— 锁不牵连）。
     读数问的是「目标所在那一行」的基数，不在这里留第二份：芯片指着第 2 行的时候把滑块拖到 60%，
     调的就该是第 2 行 —— 调整轨会把第 1 行刚调好的那一个数盖掉。 */
  const lanePct = x => Math.round(x * 100) + '%';
  const laneRow = (k, slId, rdId, boxId, rwId) => {
    const ln = k === 'voice' ? (v ? voiceLn(v) : 0) : (seg ? picLnOf(seg) : 0);
    const why = laneVolWhy(k, ln);
    const sl = document.getElementById(slId), rd = document.getElementById(rdId), bx = document.getElementById(boxId);
    const rw = document.getElementById(rwId);
    const val = laneVol(k, ln);
    if (bx) bx.classList.toggle('off', !!why);
    if (bx) {
      /* 原文案只在标记里写一份：第一次把这句存到节点上，之后锁着就换成原因、解锁就换回来。
         直接 `bx.title = why || bx.title` 会把原因永久盖成新的「原文案」，解锁后界面还在说锁着。 */
      if (!bx.dataset.base) bx.dataset.base = bx.title;
      bx.title = why || bx.dataset.base;
    }
    if (sl) { sl.disabled = !!why; sl.value = String(Math.round(val * 1000) / 10); sl.dataset.ln = String(ln); }
    if (rd) rd.textContent = lanePct(val);
    if (rw) rw.textContent = '第 ' + (ln + 1) + ' 行';
    return { ln: ln, vol: val };
  };
  laneRow('pic', 'laneVolPic', 'laneVolPicVal', 'lanePicBox', 'lanePicRow');
  laneRow('voice', 'laneVolVoice', 'laneVolVoiceVal', 'laneVoiceBox', 'laneVoiceRow');
  /* 换行那两颗管的是**芯片指着的这一个东西**（与上面两枚「按行的音量」读同一个 `ln`）：
     在轨道上直接上下拖也能换行，这两颗是拖不准时的出口。压暗判据只有 `laneWhy()` 一份。 */
  const cl = cutLaneOf();
  const whyLn = laneWhy();
  const clRow = document.getElementById('cutLaneRow');
  if (clRow) clRow.textContent = cl ? '第 ' + (cl.ln + 1) + ' 行 · ' + (cl.k === 'voice' ? '配音' : '画面')
    : '还没有指着可以换行的东西';
  [[document.getElementById('laneUp'), -1], [document.getElementById('laneDown'), 1]].forEach(pair => {
    const b = pair[0];
    if (!b) return;
    if (!b.dataset.base) b.dataset.base = b.title;
    b.disabled = !!whyLn;
    b.title = whyLn || b.dataset.base;
  });
  /* 最下面那行读数：画面那句与配音那句各收在一份函数里（`segLenText` / `voiceLenText`），
     拖动中的 `input` 调的是同一份 —— 从前这两句写在模板里，拖动时只有主读数改口，
     于是「×1.5」配着一句还写着「念 1 秒」，同一个组件里两个数互相打架。
     那半句「进成片 = 段 / 句 × 行」只在行基数不是 100% 时才说，平时那一句读数已经够长。 */
  if (lenEl) lenEl.textContent = seg ? segLenText(seg, curSpd)
    : (v ? voiceLenText(v, curVSpd)
      : '这一镜还没有画面段：按 Ctrl+Z 退回到剪切之前，或按「切开」重新分一段，再来调音量与倍速。');
}
/* 右栏那张卡按**目标轨**分档（用户点名的第 5 条）：点着画面只留倍速与画面轨那一行，
   点着配音只留配音轨那一行（音量 + 它自己的倍速）与「加一句配音」那一整块。判据只有 `tlPanel()` 一份，落点只有这一处
   （syncTlTools 每次换目标、每次重画都走到，右栏初次渲染末尾也调它）。
   只翻 `hidden`、节点不销毁：那些滑块的绑定在整栏渲染时一次做完，重建会把正在拖的那只手底下的
   节点换掉，也会把刚敲了一半的台词清空。 */
function paintTlGroups() {
  const voice = tlPanel() === 'voice';
  const hide = (id, yes) => { const el = document.getElementById(id); if (el) el.hidden = !!yes; };
  /* 配音那一侧再分四格（用户点名的第 ③ 条）：不点过 = 这一镜上的配音，点中一句 = 音量与倍速，
     点台词 = 台词那一档，点空白 / 待生成占位 = 生成配音。`vcTab` 只有这四个取值，别的地方不写第五种。 */
  const tab = voice ? (vcTab === 'adj' || vcTab === 'gen' || vcTab === 'sub' || vcTab === 'lines' ? vcTab : 'list') : '';
  hide('vcTabs', !voice);
  hide('tlAdj', voice && tab !== 'adj');
  hide('grpPic', voice);
  hide('grpVoice', !voice || tab !== 'adj');
  hide('grpLines', !voice || tab !== 'lines');
  hide('grpVoiceAdd', !voice || tab !== 'gen');
  hide('grpVoiceList', !voice || tab !== 'list');
  hide('grpSub', !voice || tab !== 'sub');
  const titles = { list: '这一镜上的配音', adj: '音量与倍速', lines: '台词', gen: '加一句配音', sub: '字幕' };
  const t = document.getElementById('edTitle');
  if (t) t.textContent = voice ? titles[tab] : '这一段画面';
  document.querySelectorAll('#vcTabs [data-vctab]').forEach(b => {
    const on = b.dataset.vctab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const l = document.getElementById('edLane');
  if (l) l.textContent = laneNm(voice ? 'voice' : 'pic');
}
/* 「试听 / 切开」那一排的下一行：**只读**选中的那一句配音（用户点名的第 ① 条）。
   判据与右边那张卡同一个 `v`（syncTlTools 里的 tlVoiceHit），所以「卡片说在调这一句」与
   「这一行写的是这一句」永远是同一条。指着画面段 / 什么都没选中时整行收起。
   文字取整句、不截断 —— 这一行存在的意义就是看全这一句要念什么。 */
function paintVoiceLine(v) {
  const row = document.getElementById('tlVoiceLine');
  if (!row) return;
  if (!v) { row.hidden = true; return; }
  const who = document.getElementById('tlVoiceWho');
  const tx = document.getElementById('tlVoiceText');
  const tm = document.getElementById('tlVoiceTime');
  const name = String(v.who || v.name || '').replace(/\s+/g, ' ').trim();
  const text = String(v.text || '').replace(/\s+/g, ' ').trim();
  /* 说话人与正文是同一句时**只印一遍**（用户点名的第 ③ 条）：
     `who` / `name` 常常就是这句台词本身，两格各印一次会读成「21212121 21212121」。
     正文框在没台词时本来就会退回名字，所以「名字那一格」只在两者确实不同时才画。 */
  const dup = !!name && (!text || name === text);
  if (who) { who.textContent = dup ? '' : name; who.hidden = dup || !name; }
  if (tx) tx.textContent = text || name || '（这一句没有文字）';
  if (tm) {
    const segNo = (Number(v.seg) || 0) + 1;
    const at = Number(v.at) || 0;
    const dur = Number(v.dur) || 0;
    tm.textContent = '第 ' + segNo + ' 段 · ' + at.toFixed(1) + ' 秒起 · 念 ' + dur.toFixed(1) + ' 秒';
  }
  row.hidden = false;
}
/* 把「此刻指着谁」写到条上：目标芯片、试听按钮的显隐、每一颗的 title、滑块读数，
   再加右栏那张卡（音量 / 倍速两档）。几件事同一出口 —— 分开写就会出现
   「芯片写着配音、按钮切的是画面」，也会写出「芯片指着一格画面、卡上还是上一句配音的音量」。 */
function syncTlTools() {
  const listen = document.getElementById('tlListen');
  const box = document.getElementById('tlVolBox');
  const sl = document.getElementById('tlVol');
  const rd = document.getElementById('tlVolVal');
  const v = tlVoiceHit();
  let vol = 1, picGray = false, seg = null;
  if (v) {
    vol = Number(v.vol == null ? 1 : v.vol);
  } else {
    const p = tlFocusPos();
    seg = p.seg;
    vol = seg ? segVol(seg) : 1;
    picGray = !!seg && !!seg.off;
  }
  if (listen) listen.hidden = !v;
  if (box) box.classList.toggle('off', !!tlLockWhy());
  if (sl) sl.disabled = !!tlLockWhy();
  if (sl) sl.value = String(Math.round(vol * 100 * 10) / 10);
  if (rd) rd.textContent = Math.round(vol * 100) + '%';
  /* 右栏那张卡：两枚滑块跟着闸走（锁 / 指着配音 / 没有画面段三种都写得出原因），
     读数一律从目标上现算 —— 不留第二份口径。 */
  paintTlAdjust(v, seg);
  paintVoiceLine(v);
  paintTlGroups();
  const who = v ? '这一句配音' : '插针那一段画面';
  const tips = {
    split: '在插针处把' + who + '切成两段（' + (v ? '画面不动' : '两段的音量都跟着带走') + '）',
    left: '丢掉插针左边的' + (v ? '声音' : '画面') + '（' + who + '从插针开始）',
    right: '丢掉插针右边的' + (v ? '声音' : '画面') + '（' + who + '到插针为止）',
    drop: v ? '删掉这一句配音（画面不动）'
      : picGray ? '把这一段的画面放回来：它现在出黑，格子还留在原位，恢复后按选区出画面'
        : '删掉插针所在的那一段（格子不消失，原地变成黑场占位，后面的段一个都不前移 —— 这一段上的配音照放并在音轨上变色）',
    merge: '把' + who + '与旁边挨着的那一段合回一段（只对「一刀切开、没再动过」的两段有效）',
  };
  document.querySelectorAll('#tlTools [data-cut]').forEach(b => {
    const k = b.dataset.cut;
    if (tips[k]) b.title = tips[k];
    if (k === 'play') b.title = '试听' + who + '（听的就是留在成片里的那一段）';
    /* 指着黑场那一段时「删掉」这颗改口成「恢复画面」：段并没有被删（还在原位、只是出黑），
       再写「删掉」就是界面在撒谎，而它同时是用户把画面找回来的唯一出口。
       带图标的按钮**不能用 textContent 改字**（那会把里面那枚 svg 一起抹掉），整段重画。 */
    if (k === 'drop' && !v) {
      b.innerHTML = icon(picGray ? 'refresh' : 'trash', 13) + (picGray ? ' 恢复画面' : ' 删掉');
      b.classList.toggle('danger', !picGray);
    }
    /* 锁上的那一轨：除试听外每一颗当场压暗并把原因写进 title（试听不压 —— 锁拦的是「改」，不是「听」）。
       判据就是 runCut 里那一份 tlLockWhy，不在这里再拼一遍 proj.lane。 */
    if (k !== 'play') {
      const lk = !!tlLockWhy();
      b.disabled = lk;
      if (lk) b.title = tlLockWhy() + '：' + b.title;
    }
  });
}

/* ---------------- 轨道上的切片图 ----------------
   一段里按秒铺几帧（每帧取这一段的等分中点），用的还是公共层 `Wb.vframe` 的 meta/seek 原语。
   采到的帧按「素材地址 → {时刻: 图片}」缓存在这一页的内存里：剪辑每拖一下都重画整条轨道，
   命中就不再解码。取不到帧不算错（格子里留占位，画面照样能剪）。

   「取多帧」这一层按参考项目 `canvasesAtTimestamps` 的思路改成**并发**：
   以前是同一个 <video> 顺序 seek，N 个时刻就是 N 次串行等待（每次 seek 都要等解码器
   把这一段从头解一遍），一条二十格的轨道要等好几秒才填满 —— 而这只是缩略图。
   现在把要取的时刻切成几段、每段一个 <video>，块内仍按时间递增顺序 seek（顺序解码比来回跳快得多）。
   但「每条素材各开几块、素材之间再 Promise.all 全开」是错的：全片那一排有十几条候选时，
   只会把中栏正在播的那条一起拖慢。 */
const frameCache = new Map();
const EMPTY_HITS = new Map();         // 这一条素材还没建缓存表时给读数用的空表（免得每处各 new 一份）
const slicePending = new Map();       // 稳定键 → 已排进队列、还没出图的格子
const sliceFailed = new Map();        // 稳定键 → Map(时刻 → { 失败时间, 连着失败几次 })：退避一阵后要自己再试
const sliceJobs = [];                 // 全页共用的一条解码流水线上的活：{ key, src, times, hit, res, prio }
let sliceBusy = 0;
const SLICE_W = 160;                  // 切片只要几十像素宽，按原分辨率出图纯属浪费
const SLICE_GLOBAL = 4;               // 全页同时在解码的块数（跨素材一起算，不是每条素材四块）
const FRAME_SRC_MAX = 48;             // 缓存里最多留几条素材的帧：满了逐条淘汰最久没摸到的那一条
const SLICE_FAIL_TTL = 5 * 60e3;      // 取不到的时刻最久 5 分钟后允许再试（签名换新 / 本机文件补回来）
const SLICE_FAIL_FIRST = 8e3;         // 第一次失败只压 8 秒：解码超时多半是「这会儿忙」，不是「取不到」
const SLICE_FRAME_MAX = 1200;         // 单条素材最多留多少张切片（长时间来回缩放也不无限涨）
let slicePaused = false;              // 导演台切走时暂停解码队列，别和正在看的下一页抢解码器
/* 迁移岛在 onActivated / onDeactivated 里直接调这个（spa:page 那条监听在组件未激活时会被事件门控挡住）。 */
window.__directorSlicePause = v => { slicePaused = !!v; if (!slicePaused) sliceResume(); };
window.__directorSlicePaused = () => slicePaused;
/* 同一份素材在页面里可能有三张地址：/asset/<本机号>、/getv?url=<签名外链>、原始落地地址。
   用原始地址当缓存的键，签名一换就整排切片重新解码 —— 这正是「每次都重新加载」的另一半。
   Wb.thumbs.keyOf 已经把这三类归成同一个身份（视频首帧缓存用的也是它），切片直接复用。 */
function sliceKey(src) {
  const s = String(src || '');
  try { if (window.Wb && Wb.thumbs && Wb.thumbs.keyOf) return Wb.thumbs.keyOf(s); } catch (e) {}
  return s;
}
function sliceBackoff(n) {
  return Math.min(SLICE_FAIL_TTL, SLICE_FAIL_FIRST * Math.pow(2, Math.max(0, Number(n) || 0)));
}
function sliceBadFresh(key, t) {
  const m = sliceFailed.get(key);
  const r = m && m.get(t);
  return !!r && Date.now() - r.at < sliceBackoff(r.n);
}
/* 退避到点自己再排一遍活：格子只有等下一次重画（切镜头、剪一刀）才会被再问一遍，
   页面静静摊着时一次解码超时（元数据 20 秒 / 定位 15 秒）就把整排钉成斜纹五分钟。
   只重跑还挂在页面上的那几栏 —— 缓存里已有的帧一格都不重解，`fillSlices` 那一遍就是纯排活。 */
const sliceRoots = new Set();
let sliceRetryTick = 0, sliceRetryAt = 0;
function sliceRetryIn(ms) {
  const at = Date.now() + Math.max(0, Math.round(Number(ms) || 0));
  if (sliceRetryAt && at >= sliceRetryAt) return;             // 已经有更早的一次在等，不另开定时器
  sliceRetryAt = at;
  if (sliceRetryTick) clearTimeout(sliceRetryTick);
  sliceRetryTick = setTimeout(() => { sliceRetryTick = 0; if (!slicePaused) sliceRetryRun(); }, at - Date.now());
}
function sliceResume() { slicePump(); if (sliceRetryAt) sliceRetryRun(); }
function sliceRetryRun() {
  if (sliceRetryTick) { clearTimeout(sliceRetryTick); sliceRetryTick = 0; }
  sliceRetryAt = 0;
  Array.from(sliceRoots).forEach(r => {
    if (!r.isConnected) sliceRoots.delete(r);
    else fillSlices(r);
  });
}
function noteSliceFail(key, times) {
  let wait = SLICE_FAIL_TTL;
  times.forEach(t => { const w = sliceFail(key, t); if (w < wait) wait = w; });
  sliceRetryIn(wait);
}
/* seeked 之后画面未必已经换（解码器还没把这一帧画出来），以前直接 drawImage 抓到的
   常常还是上一格的画面 —— 轨道上看着就是「相邻两格一模一样」。
   有 requestVideoFrameCallback 就等一帧真画面；没有（老浏览器）或超时就照旧抓，
   宁可偶尔旧一帧，也不能把整排格子卡死。 */
function sliceNextFrame(v) {
  if (typeof v.requestVideoFrameCallback !== 'function') return Promise.resolve();
  return new Promise(res => {
    let done = false;
    const fin = () => { if (done) return; done = true; res(); };
    try { v.requestVideoFrameCallback(fin); } catch (e) { fin(); return; }
    setTimeout(fin, 400);
  });
}
/* 一块时刻：一个 <video> 从头到尾顺序取完。返回值是**没能出图**的那些时刻 —— 调用方把它们记进
   sliceFailed，别让下一次重画再把同一批取不到的帧重解一遍（外链过期时原本是每 3 秒白跑一趟解码器）。 */
async function grabChunk(src, times, hit) {
  const miss = new Set();
  const markMiss = from => { for (const t of times) if (t >= from && !hit.has(t)) miss.add(t); };
  const v = Wb.vframe.el(src);
  try {
    await Wb.vframe.meta(v);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    for (const t of times) {
      if (hit.has(t)) continue;                        // 别的那一块已经取到了
      try { await Wb.vframe.seek(v, t); } catch (e) { markMiss(t); break; }
      await sliceNextFrame(v);
      const w = v.videoWidth || 160, h = v.videoHeight || 90;
      /* 缩到 160 宽再出图：1920×1080 的 JPEG 一格几百 KB，二十格就把内存吃掉一大块，
         而缩过之后一张只有几 KB —— 出图更快，缓存也放得下更多条素材。 */
      const cw = Math.min(SLICE_W, w), ch = Math.max(1, Math.round(h * (cw / w)));
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      ctx.drawImage(v, 0, 0, cw, ch);
      /* 存 **blob URL** 而不是 dataURL：一张 160px 的 JPEG 变 base64 之后有三四百字符，
         而每次重画轨道都要把这一串重新塞进 background-image —— 浏览器得再解析一遍、
         再解码一遍（dataURL 不带缓存身份）。blob URL 是一个稳定的地址，
         同一个地址浏览器会复用已解码的图，重画时基本是「贴上去」。
         它是本页资源，页面关掉自然回收；缓存被清时我们主动 revoke（见 frameCache 清理）。 */
      const url = await new Promise(r => c.toBlob(b => r(b ? URL.createObjectURL(b) : ''), 'image/jpeg', 0.6));
      if (url) {
        hit.set(t, url);
        /* 单条素材的帧表也要有界：来回缩放会把每个采样时刻都留一份。
           淘汰最久没写入的那几张；1200 张远高于一屏（最多 512 格），不会动到当前这排。 */
        while (hit.size > SLICE_FRAME_MAX) {
          const first = hit.keys().next().value;
          const oldUrl = hit.get(first);
          hit.delete(first);
          try { URL.revokeObjectURL(oldUrl); } catch (e) {}
        }
      } else miss.add(t);
    }
  } catch (e) { markMiss(0); /* 元数据都拿不到（外链过期 / 格式不支持）：这一排留占位 */ }
  finally { Wb.vframe.release(v); }
  return miss;
}
const chunkAsc = (list, n) => {
  const k = Math.max(1, Math.min(n, list.length));
  const size = Math.ceil(list.length / k);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
/* 丢一条素材的帧表时要**主动释放**那些 blob URL：只丢 Map 的话对象 URL 还挂着图（一排就是几十 MB）。
   「超过 48 条就整表清空」是错的 —— 五十几条候选的工程里每剪十几刀就把全部切片作废一次，
   界面表现正是用户点名的「画面轨每次都重新加载」。现在按最久没被摸到的那一条逐条淘汰。 */
function dropFrameSrc(key) {
  const m = frameCache.get(key);
  if (m) m.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  frameCache.delete(key);
  sliceFailed.delete(key);
}
function evictFrameSrc() {
  for (const src of frameCache.keys()) {
    if (slicePending.has(src)) continue;               // 正在取的这一条不能清（帧还在往那张表里写）
    dropFrameSrc(src);
    return true;
  }
  return false;
}
function frameCacheOf(src) {
  const old = frameCache.get(src);
  if (old) { frameCache.delete(src); frameCache.set(src, old); return old; }   // 摸到过就排到最后
  while (frameCache.size >= FRAME_SRC_MAX) { if (!evictFrameSrc()) break; }
  const m = new Map();
  frameCache.set(src, m);
  return m;
}
function sliceFail(key, t) {
  let m = sliceFailed.get(key);
  if (!m) { m = new Map(); sliceFailed.set(key, m); }
  const prev = m.get(t);
  const n = prev ? (prev.n || 0) + 1 : 0;
  const ttl = sliceBackoff(n);
  m.set(t, { at: Date.now(), n });
  return ttl;
}
/* 全页共用的那一条解码流水线：排队、认领、松手只在这一处。
   以前是「每条素材各自开 4 个解码器，素材之间再 Promise.all 全开」—— 十几条候选就是五六十个
   <video> 同时抢那几个硬件解码器，切片没变快、中栏正在播的那一条先卡。 */
/* 下一块活：**看得见 / 针附近**的优先，不按入队先后。
   同一条素材内部已经由 `chunkHot` 排过块序；跨素材时如果仍 FIFO，
   屏幕外先入队的几条素材会把用户正盯着的那一条挤到后面。 */
function sliceNextJob() {
  if (!sliceJobs.length) return null;
  let best = 0;
  for (let i = 1; i < sliceJobs.length; i++) if ((sliceJobs[i].prio || 0) < (sliceJobs[best].prio || 0)) best = i;
  return sliceJobs.splice(best, 1)[0];
}
function slicePump() {
  if (slicePaused) return;
  while (sliceBusy < SLICE_GLOBAL && sliceJobs.length) {
    const job = sliceNextJob();
    if (!job) return;
    sliceBusy++;
    grabChunk(job.src, job.times, job.hit).then(
      miss => noteSliceFail(job.key, miss),
      () => noteSliceFail(job.key, job.times)
    ).then(() => {
      sliceBusy--;
      const p = slicePending.get(job.key);
      if (p) { job.times.forEach(t => p.delete(t)); if (!p.size) slicePending.delete(job.key); }
      slicePump();
      job.res();
    });
  }
}
/* 把「缓存没有、也没人在取」的这些时刻排进流水线，返回每块的 Promise（一块 = 一个 <video>）。
   每块至少装三格再拆下一块：一格一块会把池子填满同一素材的零碎活，别的素材反而排不上。
   `hot`（可省）= 这一条素材上插针指着的那一**源秒**：离它近的那一块先解，见 `chunkHot`。 */
function sliceAsk(key, src, times, hit, hot, vis) {
  const pend = slicePending.get(key);                     // 这一条素材上已经有人在取的格子，不再排第二遍
  const run = times.filter(t => !pend || !pend.has(t));
  if (!run.length) return [];
  const set = pend || new Set();
  slicePending.set(key, set);
  const basePrio = vis ? 0 : 1000;
  const push = (ts, i) => new Promise(res => {
    ts.forEach(t => set.add(t));
    sliceJobs.push({ key, src, times: ts, hit, res, prio: basePrio + i });
    slicePump();
  });
  return chunkHot(chunkAsc(run, Math.max(1, Math.min(SLICE_GLOBAL, Math.ceil(run.length / 3)))), hot).map(push);
}
/* 把「这一格要画的 n 个时刻」和缓存里已有的帧配一次对，返回与 `ts` 等长的地址表（缺的留空）。
   正好那个时刻命中最好；命不中退到**同一张磁贴里离它最近**的那一张（tol = 一张磁贴跨的源秒）——
   这是「缩放不重新加载」的另一半：磁贴定宽之后每次缩放采样点都会挪，旧帧还在缓存里，
   与其先留一排斜纹等解码，不如当场把最近的那张贴上（画面立刻是新的那套排法），缺的再补。
   跨度问的是 `step`（渲染那一遍与采样同一份），不是 `(b-a)/张数`：定宽磁贴摊不满整格时
   `n×step > b-a`（右边那一截是被裁掉的），按后者落格会把每一张都算歪一点、就近顶上那条也就失效了。
   按 `k = round((t-a)/step)` 直接落格，整条素材的帧表只扫一遍（O(缓存大小)，不是 O(帧数×格子数)）。
   ⚠ 但「同一格内」这一条只够应付**缩下去**（格子变少、旧帧更密）。**放大**时正相反：
   一格跨的源秒变短，旧帧的采样点比新格子稀，多数新格子里一张旧帧都落不进 —— 只有 1/4 有画面、
   其余全是斜纹，而解码排在队上要一两秒，界面上看到的仍是「放大一下画面轨又转一遍」。
   所以还空着的格子再退**一档**：拿整段里离它最近的那一张，容差放宽到两格（`tol2`）。
   这一档宁可贴一张「差半秒」的画面，也不留一排斜纹骗眼睛；真帧回来时逐张换掉，不改张数与宽度。 */
function tileFrames(got, ts, a, b, step) {
  const out = ts.map(() => '');
  if (!got || !got.size || !ts.length) return out;
  const span = Math.max(0.01, Number(step) > 0 ? Number(step)
    : (Math.max(0, Number(b) || 0) - Math.max(0, Number(a) || 0)) / ts.length);
  const tol = Math.max(0.04, span * 1.05);
  const tol2 = Math.max(tol, span * 2.05);
  const dist = ts.map(() => Infinity);
  got.forEach((u, t) => {
    const k = Math.round((t - a) / span);
    if (k < 0 || k >= ts.length) return;
    const d = Math.abs(ts[k] - t);
    if (d > tol || d >= dist[k]) return;
    dist[k] = d; out[k] = u;
  });
  /* ② 只处理还空着的那些格：把缓存的时刻排好序，对每格二分取最近的一张 */
  if (out.some(u => !u)) {
    const ks = Array.from(got.keys()).filter(t => Number.isFinite(t)).sort((x, y) => x - y);
    for (let k = 0; k < ts.length; k++) {
      if (out[k]) continue;
      let lo = 0, hi = ks.length;            // 第一个 >= ts[k] 的下标
      while (lo < hi) { const m = (lo + hi) >> 1; if (ks[m] < ts[k]) lo = m + 1; else hi = m; }
      const cands = [ks[lo - 1], ks[lo]];    // 左右两个邻居里挑近的
      let best = '', bd = Infinity;
      for (const t of cands) {
        if (!Number.isFinite(t)) continue;
        const d = Math.abs(t - ts[k]);
        if (d < bd) { bd = d; best = got.get(t); }
      }
      if (best && bd <= tol2) out[k] = best;
    }
  }
  return out;
}
/* 哪一块先解：离**插针**近的那一块先（用户盯的就是那一秒附近的画面），其余按块序补。
   块内仍然时间递增 —— 顺序 seek 比来回跳快得多，这一条不为了优先级破坏。 */
function chunkHot(chunks, hot) {
  if (!(hot >= 0) || chunks.length < 2) return chunks;
  const near = ts => (hot < ts[0] ? ts[0] - hot : hot > ts[ts.length - 1] ? hot - ts[ts.length - 1] : 0);
  return chunks.slice().sort((x, y) => near(x) - near(y));
}
/* 铺好格子 → 后台把帧填进去（重画时先画占位，绝不为了缩略图把整栏卡住） */
async function fillSlices(root) {
  /* 记下「这一栏还要出图」：退避到点那一次就照着它再排一遍活（见 sliceRetryIn）。
     整栏重画会把旧行节点换掉，攒多了就顺手把已经不在树上的清掉。 */
  sliceRoots.add(root);
  if (sliceRoots.size > 32) Array.from(sliceRoots).forEach(r => { if (!r.isConnected) sliceRoots.delete(r); });
  /* 一次收集：读**此刻**挂在栏上的那些格子，连带它们要的几个时刻。
     抽成函数是因为填完帧还要再走一遍 —— 期间整栏可能又重画过一次，
     把帧填进第一次那批已经孤立的节点里，等于取到了却上不了屏。 */
  const collect = () => {
    const bySrc = new Map();
    Array.prototype.slice.call(root.querySelectorAll('[data-frs]')).forEach(t => {
      const src = t.getAttribute('data-frs') || '';
      if (!src) { t.innerHTML = '<i class="fr none whole"></i>'; return; }
      const a = Number(t.getAttribute('data-in')) || 0;
      const b = Number(t.getAttribute('data-out')) || Math.max(a + 0.5, a);
      const n = Math.max(1, Math.min(SLICE_N_MAX, Number(t.getAttribute('data-n')) || 1));
      /* 一张磁贴跨几秒源与「几张」出自同一处（`sliceGeom`），所以它由渲染那一遍一起写在格子上：
         这里要是再按 `(b-a)/n` 自己算一遍，放大时 `n×step` 是大于框的（那正是「裁掉半张」的来处），
         两种算法会差出几十秒 —— 采样点跑到框外面，界面上就是一整排斜纹。 */
      const step = Number(t.getAttribute('data-step')) || 0;
      const pin = Number(t.getAttribute('data-pin'));
      const key = sliceKey(src);
      /* 同一个稳定键可能同时有「本机 /asset/」与「签名 /getv」两张地址：
         解码用本机那条（不会过期、也不用回源）；已有记录不是本机时才让位。 */
      const rankSrc = u => /^\/asset\//.test(u) || /^blob:/.test(u) ? 2 : /^\/getv\?/.test(u) ? 1 : 0;
      if (!bySrc.has(key)) bySrc.set(key, { key, src, plans: [] });
      else if (rankSrc(src) > rankSrc(bySrc.get(key).src)) bySrc.get(key).src = src;
      bySrc.get(key).plans.push({ t, ts: sliceTimes(a, b, n, step), a, b, step, pin: Number.isFinite(pin) ? pin : -1 });
    });
    return bySrc;
  };
  /* 画一格：`got` 是「时刻 → 图片地址」的表，缺哪个就留一道占位斜纹。
     同步那一遍与异步那一遍共用它 —— 两处各拼一次 innerHTML，迟早一处改了另一处没改。 */
  const paintTiles = (plans, got) => plans.forEach(({ t, ts, a, b, step }) => {
    if (!t.isConnected) return;                      // 期间又重画过一次：别把帧填进孤立的格子
    const urls = tileFrames(got, ts, a, b, step);
    /* 同一批地址就一个字节都不动：整条轨道每 3 秒重画一次，没有这一行时
       innerHTML 会把几十张已经解码好的图全部拆掉重建 —— 观感就是「切片一直在重载」。
       签名里带上张数，换比例尺后张数变了仍会重画。 */
    const sig = ts.length + '|' + urls.join('|');
    if (t.__frsSig === sig) return;
    t.__frsSig = sig;
    t.innerHTML = ts.map((x, i) => urls[i]
      ? '<i class="fr" style="background-image:url(' + urls[i] + ')"></i>'
      : '<i class="fr gap"></i>').join('');
  });
  const draw = byKey => byKey.forEach(rec => paintTiles(rec.plans, frameCache.get(rec.key) || EMPTY_HITS));
  /* ① **同步**先把已经取到过的那批贴上去（纯读缓存，一次解码都不做）。
     以前不管命中与否，都先画一排占位、再等异步回来填 —— 每次重画（每 3 秒轮询、
     每剪一刀、每次切镜头）都完整重演一遍「先空后填」，看着就是「每次都重新加载」。
     命中率高的场景下（同一个镜头来回剪）这一遍就等于当场画好了。 */
  const first = collect();
  draw(first);
  /* ② 只剩「缓存没有、这一条素材上也没人在取、而且不是已经确认取不到」的那些格子去解码。
     不同素材之间不再各开一份并发：活全排进 sliceAsk 那条流水线，全页同时在解码的就是 SLICE_GLOBAL 块。 */
  const jobs = [];
  /* 排活之前先按**看得见的**排一下：放大之后一屏只装得下一两条候选，而文档顺序解码时
     屏幕外那几条会把看得见的这条挤到队尾 —— 用户盯着的那一块要等好几秒才出图。
     只是把「有格子在视野附近」的素材提到前面，其余的照旧排队跟着补，不丢一格。 */
  const barEl = document.getElementById('tlBar');
  const barRect = barEl ? barEl.getBoundingClientRect() : null;
  const items = Array.from(first.values()).map(rec => ({
    key: rec.key, src: rec.src, plans: rec.plans,
    vis: barRect ? rec.plans.some(p => {
      const r = p.t.getBoundingClientRect();
      return r.right > barRect.left - 320 && r.left < barRect.right + 320;
    }) : true
  }));
  items.sort((a, b) => (b.vis ? 1 : 0) - (a.vis ? 1 : 0));
  /* 每块解码回来就补画一次，但同一拍里几块一起回来只画一次：
     一次重排几十格，每格都触发一遍整条轨道的重排会把主线程按住。
     用 setTimeout 不用 requestAnimationFrame —— 后台标签页里 rAF 根本不跑，
     探针（jsdom）里也没有，那一遍补画就永远不落。 */
  let tick = 0;
  const redrawSoon = () => {
    if (tick) return;
    tick = setTimeout(() => {
      tick = 0;
      if (root.isConnected) draw(collect());
    }, 80);
  };
  items.forEach(({ key, src, plans, vis }) => {
    const marks = new Set();
    let hot = -1;
    plans.forEach(p => {
      p.ts.forEach(x => marks.add(x));
      /* 热区只认「这一条素材上看得见的、而且针真指着的」那一格：
         针在别的镜上时不该决定这一条先解哪一块。 */
      if (hot < 0 && p.pin >= 0 && (vis || !barRect)) hot = p.pin;
    });
    const warm = frameCache.get(key) || EMPTY_HITS;
    const need = Array.from(marks)
      .filter(t => !warm.has(t) && !sliceBadFresh(key, t))
      .sort((x, y) => x - y);
    if (need.length) sliceAsk(key, src, need, frameCacheOf(key), hot, vis).forEach(p => { jobs.push(p); p.then(redrawSoon); });
  });
  if (jobs.length) {
    await Promise.all(jobs);
    if (tick) { clearTimeout(tick); tick = 0; }
    if (root.isConnected) draw(collect());      // 按**此刻**栏上的格子再画一遍，不回填孤立节点
  }
}

/* 导演台切走时停掉切片解码；切回来再从原队列继续（已经取到的帧都在 frameCache 里）。 */
window.addEventListener('spa:page', e => {
  const d = e && e.detail;
  if (!d || (d.file && d.file !== 'director.html')) return;
  const paused = d.visible === false;
  if (paused === slicePaused) return;
  slicePaused = paused;
  if (!paused) sliceResume();
});

/* 片段 → ffmpeg 可用的素材地址（本地导入 / 链接已过期的候选会先转存成一条长期有效的资产） */
async function tlClipSrc(c) {
  /* 灰掉那一段的素材就是黑场本身：不再去取候选的地址、也不做转存（那一段画面用户已经说了不要）。
     代理那边 `src === 'black'` 走 lavfi 生成，段长由 in/out 决定 —— 所以时长还是那几秒。 */
  if (c.gray) return 'black';
  const EM = window.EditorMedia;
  if (c.kind === 'asset') {
    const s = EM ? EM.exportSrc(c) : (c.src || (c.assetId ? Api.assetSrc(c.assetId) : ''));
    return s || null;
  }
  const sh = allShots().find(s => s.id === c.shotId);
  const cand = sh && tlCandidateOf(sh, c.candId);
  if (!cand) return null;
  /* 导出永远本机优先：有镜像就用 /asset/<la>，不受「优先用本机」显示开关影响。 */
  if (EM && EM.localIdOf(cand)) return EM.exportSrc(cand);
  const isRemote = cand.url && /^https?:\/\//.test(cand.url);
  if (isRemote) return EM ? EM.exportSrc(cand) : null;   // 没有本机副本时仍回平台
  if (cand.url && cand.url.startsWith('/asset/')) return EM ? EM.exportSrc(cand) : cand.url;
  // 没带地址、但任务号本身就是本家资产：直接引用（不区分图/视频台，按 relay 判同一套资产库）
  if (!cand.url && cand.vid && sameAssetSpace(cand.provider, assetStoreId())) return Api.assetSrc(cand.vid);
  // 本地导入 / 过期链接：转存成资产（走通用跨平台转存通道；/asset/ 只认资产库那一家的资产号，见 assetStoreId 注释）
  if (c.assetId) return Api.assetSrc(c.assetId);
  /* 原来这里还先取`cand.blobKey` 指向的 IndexedDB 字节 —— 而 blobKey 从没有一处赋值，
     那一支恒为null，等于多一次查库却从不生效（IndexedDB 里没有 blobKey 的索引）。删掉。
     真正在用的是下面这条：本地导入/ 过期链接当场转存成 `.assets` 资产（toAsset）。 */
  const fresh = await freshUrl(cand).catch(() => null);
  const source = fresh;
  if (!source) return null;
  if (EM && EM.localIdOf({ src: source })) return EM.exportSrc({ src: source });
  const aid = await AssetTransfer.toAsset(assetStoreId(), source, { reg: REG, name: (cand.name || 'clip') + '.mp4', contentType: 'video/mp4' });
  c.assetId = aid; scheduleSave();
  return Api.assetSrc(aid);
}

/* 时间线 → 送给 /render 的 clips。导出与「合并全片」以前各抄了一份逐字相同的循环
   （连「第 N 段没有可用素材」那句一起），收成这一份。
   `tl` 由调用方递进来（就是它刚 `tlSyncFromShots()` 出来的那一份），
   因为这一页没有一个全局的「当前时间线」可变对象 —— 每次都是现同步。
   循环前先把过期外链**一次批量**换新一轮（healStaleUrls → Api.healMedia 按平台分组，
   声明了 pollVia:'list' 的那一族一次列表请求解出整批）：
   逐段 tlClipSrc → freshUrl 各问一次的话，三十段就是三十次「100 条的列表」，
   而它们问的是同一家平台的同一份数据。 */
async function buildRenderClips(tl) {
  await healStaleUrls().catch(() => 0);      // 换不到新地址不是错：下面照旧拿旧地址试一次
  const clips = [];
  voiceSkip = 0;
  /* 全片灰场表（**成片秒**）算一次给所有段用：一句配音压在灰场上时按它劈成几截
     （见 clipVoices 的 ctx）。逐段各拼一份就会各漂一次（倍速一掺进来更对不上）。 */
  const G = filmFrames(tl);
  const gray = filmLayGray(G);
  let placed = 0;
  for (let i = 0; i < tl.clips.length; i++) {
    const c = tl.clips[i];
    const src = await tlClipSrc(c);
    if (!src) throw new Error(`第 ${i + 1} 段「${c.name || ''}」没有可用素材（本地文件可能已被清理）`);
    /* 这一段带上它的配音（`at` 相对本段起点，代理那侧按 start 延迟后与原声 amix）。
       放不进来的那些（这一剪把画面切短了、或整段被删）只计数不静默吞 —— 见 voiceSkip 的两句状态。 */
    const vv = clipVoices(c, { start: G.rows[i].f0, gray: gray });
    voiceSkip += vv.skip;
    placed += vv.placed;
    const one = { src, in: c.in, out: c.out, speed: c.speed || 1, volume: c.volume == null ? 1 : c.volume };
    if (vv.list.length) one.voices = vv.list;
    clips.push(one);
  }
  const anchored = voicesEnsure().length;
  voiceSkip += Math.max(0, anchored - placed - voiceSkip);   // 锚在已不存在的段上的那些也算没进画面
  return clips;
}


/* ---------------- ffmpeg 离线导出 ---------------- */
let rendering = false;
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
/* 渲染是本地长任务：走统一网络层但关掉超时（timeout:0），POST 不自动重试 */
const renderPost = body => Net.fetch('/render', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 0, retry: 0,
}).then(r => readJsonSafe(r, '提交渲染任务'));
const renderStatus = id => Net.fetch('/render/status?id=' + encodeURIComponent(id), { timeout: 15000 }).then(r => readJsonSafe(r, '查询渲染进度'));
/* 等一轮渲染跑完：一次「查进度」失败不该把整次导出判成失败。
   代理那边的 ffmpeg 仍在跑，网络抖动 / 15 秒超时只会让界面报「导出失败」，
   用户重头再来又要多等几分钟。连续失败到上限（默认 10 次 ≈ 10 秒）才认输。
   stopped() 由调用方给（导出与合并各有自己的取消标志），取消检查每轮都做。 */
async function pollRenderJob(id, stopped, onTick, maxTicks = 900, maxFails = 10) {
  let job = null, fails = 0;
  for (let i = 0; i < maxTicks; i++) {
    if (stopped()) throw new Error('已取消');
    await new Promise(res => setTimeout(res, 1000));
    try { job = await renderStatus(id); fails = 0; }
    catch (e) {
      if (++fails >= maxFails) {
        throw new Error('查不到渲染进度（连续失败 ' + maxFails + ' 次）：' + errText(e));
      }
      continue;
    }
    if (job.state === 'done' || job.state === 'failed' || job.error) return job;
    if (onTick) onTick(job);
  }
  return job;
}
/* 取消要真的取消：以前只把本地标志位翻一下，页面的轮询停了、代理里的 ffmpeg 却照样跑完（白占 CPU、
   还在 .renders 里留下一条没人要的成片）。代理本来就有 /render/cancel（杀子进程 + 摘队列），接上它。 */
const renderCancel = id => id ? Net.fetch('/render/cancel?id=' + encodeURIComponent(id),
  { method: 'POST', timeout: 8000, retry: 0 }).catch(() => {}) : Promise.resolve();
async function renderBlob(name, what) {
  const r = await Net.fetch('/render/dl?name=' + encodeURIComponent(name), { timeout: 300000 });
  if (!r.ok) {
    /* 404 = 「记着的那一份在盘上找不到了」。成片现在**不按数量清理**（代理只清渲染崩溃留下的临时目录），
       所以坏法是这三样之一：用户自己删过 `.renders`、设置页换过渲染目录、上一次合成没写完。
       挂一个 `gone` 旗标给调用方：它要据此把记着的成片作废，否则下一次点导出照走快捷路径、
       照拿同一个 404。文案里别再指「重新合并」—— 那三颗按钮早就从页面上删了。 */
    const err = new Error((what || '下载成片') + '：'
      + (r.status === 404 ? '盘上找不到那一份成片文件（可能被手动删过，或渲染目录换过地方）' : 'HTTP ' + r.status));
    err.gone = r.status === 404;
    throw err;
  }
  return await r.blob();
}
let renderCancelled = false;
let renderJobId = null;      // 当前这一轮渲染的任务号（取消时交给代理去杀进程）
/* 按钮统一走这个入口：渲染中再点一次 = 取消（长任务不再只能干等 15 分钟） */
function exportFilmClick() { if (rendering) { renderCancelled = true; renderCancel(renderJobId); return; } exportFilmFFmpeg(); }

/* ============================================================================
   导出素材：把选定成片里的**视频片段**与**音频片段**分别导出
   ---------------------------------------------------------------------------
   「导出成片」给的是一条接好的片子；这个入口给的是**零件**：每一段画面一个文件、
   每一句配音一个文件。用途是把这批素材搬到别的工具里继续用（做字幕、换配音、
   二次剪辑），也方便只重新做其中一段而不用重跑整片。

   走**同一套** `/render`（不新开一条导出通道）：
     · 视频片段 = N 个单段任务，每段一个 mp4。分辨率/帧率沿用成片那一档（`filmSize`），
       所以导出来的片段直接接回去也是同一个规格。
     · 音频片段 = 每句配音一个任务：一条 `voices` 的 clip（没有画面）+ 只放这一句。
       代理那侧这会渲染成一条 mp4（画面是黑的、只有声音）—— 要真正的音频文件，
       走 `spec.audioOnly`：代理只搭 amix → `-vn` 出 m4a（见 proxy.js 的 renderJob）。
   两类都**逐个**跑而不是一次全交：一次全交的话，一个片段失败整批都没了，
   而用户要的就是「单独再导某一段」。
   ========================================================================== */
let exportingAssets = false;
function clickExportAssets() {
  if (rendering) { setStatus('已有导出任务在进行中…'); return; }
  if (exportingAssets) { renderCancelled = true; return; }
  exportFilmAssets();
}
/* 一句配音 / 一段画面在成片里的位置（第几段、那一镜叫什么）—— 用在导出后的文件名上，
   免得落盘是一堆 `成片-3f2a.mp4`，过两天谁也认不出是哪一段。 */
/* 00m12.3s：文件名里只用「分 + 秒」，不出现冒号（Windows 文件名不能带冒号）。 */
function clipTimeLabel(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const m = Math.floor(t / 60);
  return String(m).padStart(2, '0') + 'm' + (t - m * 60).toFixed(1).padStart(4, '0') + 's';
}
function clipLabelOf(tl, k, cl, row, extra) {
  if (!cl) return '镜头';
  const sh = allShots().find(x => x.id === cl.shotId);
  const segNo = (Number(cl.seg) || 0) + 1;
  const multi = ((tl && tl.clips) || []).filter(x => x.shotId === cl.shotId && x.candId === cl.candId).length > 1;
  const range = row && Number.isFinite(Number(row.f0))
    ? '-' + clipTimeLabel(row.f0) + '-' + clipTimeLabel(Number(row.f0) + Number(row.fd || 0))
    : '';
  return String(k + 1).padStart(2, '0') + '-' + ((sh && sh.name) || '镜头')
    + (multi ? '-第' + segNo + '段' : '') + range + (extra || '');
}
/* 一句配音在成片秒上的区间：start 是这一句在段内源秒上的起点，spd 是画面倍速，
   句自己的 spd 再乘在音频长度上（与 clipVoices / 代理 atempo 同一把尺子）。 */
function voiceFilmRange(cl, row, v) {
  const sp = Math.max(0.25, Math.min(4, Number(cl.speed) || 1));
  const vs = Math.max(0.25, Math.min(4, Number(v.spd) || 1));
  const st = (Number(row && row.f0) || 0) + (Number(v.start) || 0) / sp;
  const du = Math.max(0.05, (Number(v.dur) || 0) / (sp * vs));
  return [st, st + du];
}
async function exportFilmAssets(opts) {
  const o = opts || {};
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    setStatus('<span class="err">现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面</span>');
    return { ok: false, err: '现在一个可用镜头都没有' };
  }
  /* 先把地址备齐（批量换一轮过期外链，别逐段各问一次 —— 见 buildRenderClips 那段说明） */
  await healStaleUrls().catch(() => 0);
  const jobs = [];                       // { name, clips, kind }
  let skipVoice = 0;
  /* 灰场表（成片秒）与 buildRenderClips 同一份取法：一句压在灰场上的配音要劈成几截导出，
     口径与「导出成片」那一趟必须一致（否则导出的素材与成片里听到的不是同一种切法）。 */
  const G = filmFrames(tl);
  const gray = filmLayGray(G);
  tl.clips.forEach((cl, k) => {
    const dur = tlClipDur(cl);
    const sh = allShots().find(x => x.id === cl.shotId);
    const cand = sh && tlCandidateOf(sh, cl.candId);
    const realSrc = cand ? candTrackSrc(cand) : null;
    if (realSrc && dur > 0.05) {
      jobs.push({ kind: 'video', name: clipLabelOf(tl, k, cl, G.rows[k]),
        clips: [{ src: realSrc, in: Math.max(0, Number(cl.in) || 0), out: Math.max(0, Number(cl.out) || 0), speed: cl.speed || 1 }] });
    }
    /* 声音：这一段上的每一句各出一个文件（clipVoices 已经按「放不进这一段的不静默丢」算过）。
       这一条黑场是**这一句自己的文件**，所以 `start` 传 0 —— `v.start` 是「它在原来那一格里第几秒起」，
       跟这个文件没有半点关系；照原样递过去会被代理按 `room = 段长 - start` 再截一刀，
       于是「第 2 秒起、念 3 秒」的那一句导出来只剩 1 秒。
       `speed` 跟着那一段走：素材导出的目的是「拿到的就是成片里的那一份」，
       而上过倍速之后，成片里这一句本来就被同一条 atempo 变过速。 */
    const vv = clipVoices(cl, { start: G.rows[k].f0, gray: gray });
    skipVoice += vv.skip;
    vv.list.forEach((v, i) => {
      const [v0, v1] = voiceFilmRange(cl, G.rows[k], v);
      jobs.push({ kind: 'audio', name: clipLabelOf(tl, k, cl, G.rows[k], '-配音' + (i + 1))
        + '-' + clipTimeLabel(v0) + '-' + clipTimeLabel(v1),
        clips: [{ src: 'black', in: 0, out: Math.max(0.2, v.dur), speed: cl.speed || 1, voices: [Object.assign({}, v, { start: 0 })] }] });
    });
  });
  if (!jobs.length) {
    setStatus('<span class="err">这一版成片里没有可导出的素材：画面段都取不到可用地址，配音一句都没有</span>');
    return { ok: false, err: '这一版成片里没有可导出的素材' };
  }
  const nV = jobs.filter(j => j.kind === 'video').length;
  const nA = jobs.length - nV;
  const go = o.skipConfirm ? true : await Confirm.ask({
    title: '导出全片素材',
    sub: '画面与配音分开出文件，一段一个、一句一个。',
    body: '要导出的素材：\n· 视频片段 ' + nV + ' 个（每段一个 mp4）\n· 音频片段 ' + nA + ' 个（每句一个音频）'
      + (skipVoice ? '\n（另有 ' + skipVoice + ' 句配音落在剪不到画面的位置上，这次不带）' : '')
      + '\n\n逐个渲染，段数多时可能要等一会儿。',
    okLabel: '开始导出', cancelLabel: '先不导',
  });
  if (!go) return { ok: false, cancelled: true, err: '用户没有确认导出' };
  rendering = true; renderCancelled = false;
  const btn = $('exportAssets');
  const ff = ExportFormats.of('assets');
  if (btn) btn.textContent = ff.cancelLabel;
  const size = filmSize();
  let done = 0, okN = 0, failed = [];
  try {
    for (const j of jobs) {
      if (renderCancelled) break;
      done++;
      if (btn) btn.textContent = ff.cancelLabel + ' ' + done + '/' + jobs.length;
      setStatus('正在导出第 ' + done + '/' + jobs.length + ' 个：' + j.name + (j.kind === 'audio' ? '（音频）' : '（画面）'));
      try {
        if (o.onProgress) o.onProgress({ done, total: jobs.length, name: j.name, kind: j.kind });
        const r = await renderPost({
          name: (proj.name || '短片') + '-' + j.name,
          width: size.w, height: size.h, fps: 30, crf: 20,
          audioOnly: j.kind === 'audio',
          clips: j.clips,
        });
        renderJobId = r.id;
        const job = await pollRenderJob(r.id, () => renderCancelled);
        if (!job || job.state !== 'done') throw new Error((job && (job.err || job.error)) || '未完成');
        const ext = j.kind === 'audio' ? 'm4a' : 'mp4';
        const blob = await renderBlob(job.out, '导出素材 ' + j.name);
        const saved = await saveBlob(window.fileSafe(j.name, 120) + '.' + ext, blob);
        okN++;
        /* 一段一存，别攒到最后一次性写 —— 中途失败时已经落盘的那几个还在，
           而攒着的话失败就全丢了（用户会以为「一个都没导出来」）。 */
        setStatus('<span class="ok">✓ ' + saved.msg + '（' + done + '/' + jobs.length + '）</span>');
      } catch (e) {
        if (String(e && e.message) === '已取消') break;
        failed.push(j.name + '：' + errText(e));
      }
    }
  } finally {
    rendering = false; renderCancelled = false; renderJobId = null;
    if (btn) { btn.disabled = false; btn.innerHTML = icon(ff.icon, 13) + ' ' + ff.label; }
  }
  if (renderCancelled) {
    setStatus('已取消：已导出的 ' + okN + ' 个都留在盘上');
    return { ok: false, cancelled: true, okN, nV, nA, failed, jobs: jobs.length };
  }
  setStatus(failed.length
    ? '<span class="err">导出完了，但有 ' + failed.length + ' 个没成功：' + esc(failed.slice(0, 3).join('；'))
      + (failed.length > 3 ? ' …' : '') + '。成功的 ' + okN + ' 个已存好。</span>'
    : '<span class="ok">✓ 素材导完了：' + okN + ' 个文件已存到本机（画面 ' + nV + ' · 配音 ' + nA + '）</span>');
  return { ok: true, okN, nV, nA, failed, jobs: jobs.length };
}
/* 导出素材的文件名只洗一次字符：`web/ui/ui.js` 的 `fileSafe`（§J ⑲ 守着）。
   片段名来自镜头名，用户什么都可能打 —— 这一页以前自己写了第二份非法字符正则与截断长度，
   与资产库 / 生成工作台那两处的口径各不相同（同一部片子的素材从不同页导出，名字规则就不一样）。 */
async function exportFilmFFmpeg(opts) {
  const o = opts || {};
  if (rendering) { setStatus('已有导出任务在进行中…'); return { ok: false, busy: true, err: '已有导出任务在进行中' }; }
  /* 时间线**先建**，再判空。
     以前这里是 `tlEnsure()`：它只在 `proj.timeline` 缺失时补一个空壳，不从镜头建内容 ——
     而 `tlSyncFromShots`（能从镜头建出时间线的那一份）只在合并那一条路里被调。
     于是「剪辑 → 全片」那一排的实时预览把时间线建好了（它经过 tlSyncFromShots），
     而「导出成片」不会：生成了 5 个镜头但没打开过「剪辑 → 全片」时点导出被拦，
     报的是「先在候选卡上点『用这条』选用镜头」—— **而镜头全都已选用**。
     判据与理由都换成同一句：先把时间线同步出来，真的空了才是「没有可用镜头」。 */
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    setStatus('<span class="err">现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面</span>');
    return { ok: false, err: '现在一个可用镜头都没有' };
  }
  /* 已经有一份**当前**的成片（导出过、内容没变）：直接存它，不再跑一遍 ffmpeg。
     以前「导出成片」无条件重渲染 —— 刚导出过一次、中间什么都没改，点第二次又等一遍同样的几十秒，
     而盘上那一份就是他要的东西。（下载成片按钮已删，这条路就是它的归宿。） */
  if (proj.merged && filmIsCurrent(proj.merged)) {
    const out = proj.merged.name;
    await downloadMergedFilm();
    return { ok: true, shortcut: true, out, clips: tl.clips.length };
  }
  const size = filmSize();
  const btn = $('exportFilm');   // 主栏那个「导出成片（ffmpeg）」
  const ff = ExportFormats.of('film');
  rendering = true; renderCancelled = false;
  if (btn) { btn.disabled = false; btn.textContent = ff.cancelLabel; }
  try {
    setStatus('正在准备素材地址…');
    const clips = await buildRenderClips(tl);
    /* 字幕烧录跟着这一条导出一起做：每条栅格化成与成片同宽高的 PNG，再交给 /render 叠上去。
       栅格化失败就**当场停**（不导出一份没有字幕的成片假装成功）；没有字幕时一个字段都不发。 */
    let subs = null;
    try {
      subs = await subtitleBurnItems(size);
    } catch (e) {
      throw new Error('字幕烧录准备失败：' + errText(e));
    }
    const r = await renderPost({
      name: stampName('mp4').replace(/\.mp4$/, ''), width: size.w, height: size.h, fps: 30, crf: 20, clips,
      ...(subs && subs.items.length ? { subtitles: subs.items } : {}),
    });
    renderJobId = r.id;
    if (o.onStarted) { try { o.onStarted({ renderId: r.id, clips: tl.clips.length, subtitles: subs ? subs.items.length : 0 }); } catch (e) {} }
    const job = await pollRenderJob(r.id, () => renderCancelled,
      j => {
        if (btn) btn.textContent = ff.cancelLabel + ' ' + (j.progress || 0) + '%';
        if (o.onProgress) { try { o.onProgress(j); } catch (e) {} }
      });   // 进度显示在按钮上（顶部横幅不再播报进度）
    if (!job || job.state !== 'done') throw new Error((job && (job.err || job.error)) || '渲染未完成');
    const blob = await renderBlob(job.out, '下载成片');
    const saved = await saveBlob(job.out, blob);
    /* 导出也是一份成片：记进 proj.merged（带内容指纹，判据就是 filmIsCurrent 那一句）。
       以前不记，于是导出之后再点导出会把刚导出那一份**再合成一遍** ——
       用户刚导出的东西没被认下来，白等一次几十秒的合成。
       指纹的字段名就叫 `fp`：`filmIsCurrent` 认不出别的名字，
       少了它会被当成「没有指纹的老成片」而退回只比段数（换候选、改入出点就判不出来了）。 */
    proj.merged = { name: job.out, duration: round1(tlDuration()), ts: Date.now(),
      clips: tl.clips.length, fp: filmFingerprint(tl.clips), size: job.size || blob.size || 0 };
    scheduleSave();
    const subN = subs ? subs.items.length : 0;
    setStatus('<span class="ok">' + saved.msg + `（${tl.clips.length} 段 · ${fmtDur(tlDuration())} · ${window.fmtBytes(blob.size)}`
      + (subN ? ' · 烧录字幕 ' + subN + ' 条' : ' · 没有字幕') + '）</span>'
      + (subs && subs.missing.length ? '<span class="warn"> · 有 ' + subs.missing.length + ' 个镜头的字幕没进成片（没有选用候选）</span>' : ''));
    return { ok: true, out: job.out, bytes: blob.size, clips: tl.clips.length,
      duration: round1(tlDuration()), subtitles: subN, missingSubtitles: subs ? subs.missing.length : 0 };
  } catch (e) {
    setStatus(e.message === '已取消'
      ? '已取消：本地停止等待，这一轮渲染也已通知代理中止'
      : '<span class="err">导出失败：' + e.message + '</span>');
    return { ok: false, err: e.message, cancelled: e.message === '已取消' };
  } finally {
    rendering = false; renderCancelled = false; renderJobId = null;
    if (btn) { btn.disabled = false; btn.innerHTML = icon(ff.icon, 13) + ' ' + ff.label; }
  }
}

/* ============================================================================
   FCPXML 导出（Final Cut Pro / 达芬奇可导入的交换格式）
   ----------------------------------------------------------------------------
   导的是**当前时间线**：镜头顺序、每段的入出点、倍速、配音位置都保留。
   素材引用优先用本机资产库里的真实文件（`/sys-status` 的资产目录 + la_ 号 + 格式）；
   本机没有落盘的那几条仍然建一个离线 asset（名字 + 原地址写进文件开头的注释），
   FCP 导入后会显示离线，用户按名单补文件 / 重新链接即可 —— 不静默丢段。
   **不改变任何工程数据**：只读 tlSyncFromShots() 的结果与 proj.voices。 */
async function exportFCPXML(opts) {
  return runFcpExport({
    proj,
    tlSyncFromShots, healStaleUrls, filmSize, setStatus,
    el: id => $(id),
    tlClipDur, tlClipSrc, allShots, tlCandidateOf, candDur, voicesEnsure, voiceVolOf, styleOf,
    AssetLocal: window.AssetLocal, Api: window.Api, Net: window.Net,
  }, opts || {});
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
/* 镜头时长的口径**只有「型号自己声明的区间」这一份**（批次①）。
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
    + '按信息量分配（建立环境的镜头可以长，纯反应镜头要短），不要所有镜头一样长。';
}
/* 区间从哪来，那句说明就得写从哪来 —— 表单 hint 与审查弹窗 sub 共用这一句，
   否则「5–10 秒」在两处各拼一遍，其中一处迟早漏掉「按什么算的」。
   「一家都没声明」与「声明了但互相没有交集」分两句话说：后者的镜头照样按自己那一档夹得住。 */
function boardDurSub() {
  const s = videoDurSpan();
  if (s.n) return '时长 ' + s.min + '–' + s.max + ' 秒（按本机当前可用的 ' + s.n + ' 个视频型号共同支持范围）';
  if (s.any) return '这 ' + s.any + ' 个可用型号的时长区间彼此没有交集，AI 不给区间、落盘时逐镜按各自型号夹回';
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
/* 当前分镜的清单快照：场景与镜头都按**从 1 开始**的序号编，时长没填就是 0。
   单独留 `sh` / `sc` 两个引用 —— 账（boardPlanOf）要靠它把序号当场翻成 id；
   只编数字的话，等用户对着弹窗删了几条，序号就指错人了。 */
const BoardTools = createBoardTools({
  durWritable: () => durWritable(), nameKey: window.nameKey,
  newShot, setShotDur, removeShot, uid, Wb, feedScenePics, clampShotDurations,
});
const { snapBoard, boardListText, boardPlanOf, applyBoardPlan } = BoardTools;

/* ============================ 拆分镜之前：这一次带哪些素材进来 ============================
   批次②（方案文档 §2.3–§2.5）三件事各只有一处落点，页面不另写第二份：
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
const RULE_WITH = '\n\n可以把下面这些素材用进镜头：在某一条的 prompt 里**原样写 @名字**'
  + '（例如「@小雅 撑伞走过河岸」），程序按名字把它的图挂成参考图。只引用下面这份清单里的名字，'
  + '不要自己编名字，也不要写成 @参考图1。\n';
const RULE_WITHOUT = '\n\n这次没有可用的素材（没选范围，或清单里挑不出相关的）：'
  + 'prompt 里**不要**写 @名字 这类引用，主体长什么样直接用文字写清楚。';
/* 「归一名字 → 库条目」那张表：挑素材（`pick`）与挂图（`bind`）问的是同一件事
   （AI 回的那个名字对得上清单里的哪一条），所以建法只这一份，同名留第一条。 */
function libIdx(list) {
  const m = new Map();
  (list || []).forEach(x => { const k = nameKey(x && x.name); if (k && !m.has(k)) m.set(k, x); });
  return m;
}
/* `@名字` 后面紧跟的标点不是名字的一部分（「@小雅，走进雨中」）；名字与资产名两头各洗一次，用同一份。
   没有 g flag 的非全局正则用在 replace 上不带状态，可以共享。 */
const AT_TAIL = /[，,。.、；;：:！!？?()（）\[\]【】"'“””《》]+$/;
const SplitAssets = createSplitAssets({
  BOARD_CTX_SHORT, BOARD_CTX_PROMPT, PICK_SOFT_MAX, RULE_WITHOUT, RULE_WITH, AT_TAIL,
  libIdx, libPicChoices, addLibPicToShot, nameKey: window.nameKey, TextAI: window.TextAI,
});
window.SplitAssets = SplitAssets;

/* 页头「拆分镜」那一颗的入口：三档任务共用一个表单（选哪一档，下面几行的称呼跟着换）。
   写入是两段式：先给用户看一遍（可逐条改 / 删），确认才落盘 —— 三档一致。 */
async function aiStoryboard() {
  const hasBoard = snapBoard(proj.scenes).length > 0;
  /* 「素材范围」那一排的名单这一刻现数（新加了素材不必重开页面）；
     库还是空的就整项不画 —— 只有一项可选的下拉等于一颗点下去什么都不会变的按钮。 */
  const scopes = SplitAssets.scopes();
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
    hint: '先让 AI 从这份清单里挑相关的那几条，再把挑中那几条的完整描述喂给分镜；'
      + '写进提示词的 @名字 在确认写入时挂成参考图（选「不导入素材」就一个字也不喂）' });
  fields.push({ key: 'style', type: 'text', label: '风格提示词后缀（可选）', placeholder: '例：电影感，35mm，柔和自然光' });
  const v = await PromptForm.open({
    title: 'AI 分镜（拆新 / 改现有 / 加镜头）',
    sub: '贴一段剧本拆一份新的；或者对着现有分镜说一句话让它改 / 接着往下拆',
    okLabel: '开始',
    fields: fields,
    onChange: (key, api) => {
      const cur = api.values();
      /* 「这一档要哪几行、各行怎么说」现读，不在 fields 里写死两份（初值那份会被这一次调用盖掉）。
         时长与镜数**不再是输入框**（批次①）：区间来自可用型号声明的交集，镜数只给一句软上限预估，
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
  if (v.task === 'edit') { await aiBoardEdit(v); return; }
  await aiBoardSplit(v);
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
  const ask = async () => {
    if (!staged) {
      staged = await SplitAssets.stage(REG, v.script, v.assetSrc);
      if (staged.warn) Toast.warn(staged.warn);
    }
    /* 指令可在「设置 → 润色指令 → 剧本拆分镜」里改；末尾的约束与素材那一段由程序按本次输入追加 */
    const sys = `${TL_SYS_COMMON}
${splitSysOf()}
约束：由你决定拆几个镜头、每一镜多长。${boardDurNote()}${staged.rule}`;
    const ctx = append ? ('\n\n当前已有分镜（接着往下拆：沿用合适的场景名与画风、别重复已有的镜头）:\n' + boardListText(snapBoard(proj.scenes))) : '';
    /* 长剧本动辄十几二十秒：这里同样边收边显（面板挂在右栏提示词块下面，
       与「AI 润色」共用那一块地方；两边都是用户手点的，不会同时开着）。 */
    const txt = await AiStream.text(REG, sys, `剧本/文案：\n${v.script}` + (v.style ? `\n风格要求：${v.style}` : '') + ctx,
      { host: $('polishInline'), title: append ? 'AI 正在往下拆分镜…' : 'AI 正在拆解分镜…' });
    const j = parseJsonLoose(txt);
    const scenes = (j && (j.scenes || j.shots)) || null;
    if (!scenes) throw new Error('AI 没有给出可用的分镜结构');
    draft = j;
    const items = [];
    (j.scenes || []).forEach((sc, si) => {
      const scName = String(sc.name || '').trim() || ('场景 ' + (si + 1));
      (sc.shots || []).forEach((s, shi) => {
        /* AI 给多少镜就列多少镜（批次①删掉了这里的 slice）：以前超上限的那几条**默默不列出来**，
           用户以为拆了 12 镜、剧本后面那半段就这样没了。秒数原样带着，越界由落盘后那一夹处理。
           标签里那个秒数与真正写进镜头的是同一判据（`durWritable`）—— 没有依据可校验时标签也不许显示，
           否则弹窗说「这一镜 7s」而镜头上压根没有 duration。
           批次③把这一条变成**结构化的一份**（场名 / 镜头名 / 秒数 / 正文各一格，`mode:'board'`）：
           以前落盘要拿标签正则回查「场景名 + 镜头号」，用户改一个字就对不上号，而弹窗里拖过、删过几条
           之后序号本身就会漂。`key` = 「场名·该场第几镜」，点「重新规划」后靠它认出哪几条是用户改过的。 */
        const ds = Math.round(Number(s.duration));
        const dur = durWritable() && Number.isFinite(ds) && ds > 0 ? ds : null;
        const no = shi + 1;
        /* 批次④（方案 §4.3）：镜头名与画面说明**分家**。以前这里写 `s.note.slice(0, 12)` ——
           长的那一句说明被砍成 12 字当标题，原文两头都没留（既不在名字里也不在别处）。
           现在 `name` 只取 AI 给的短名（没有就空着，落盘时退回「镜头 N」），`note` 整条原样存进 `sh.note`。
           `line` 是这一镜要念的话（§4.1）：只有文字，不进配音轨，右栏那一格直接看得见。 */
        items.push({
          key: scName + '·' + no,
          scene: scName,
          name: String(s.name || '').trim().slice(0, 12),
          dur,
          line: String(s.line || '').trim(),
          who: String(s.speaker != null ? s.speaker : (s.who == null ? '' : s.who)).trim(),
          note: String(s.note || '').trim(),
          text: s.prompt || s.note || '',
          label: scName + ' · 镜头 ' + no + (dur ? '（' + dur + 's）' : '')
            + (String(s.line || '').trim() ? ' · 有台词' : ''),
        });
      });
    });
    if (!items.length) throw new Error('AI 输出里没有镜头');
    return items;
  };
  let items;
  try { setStatus(append ? 'AI 正在往下拆分镜…（先读一遍现有分镜）' : 'AI 正在拆解分镜…（长剧本可能需要十几秒）'); items = await ask(); }
  catch (e) { setStatus('<span class="err">' + e.message + '</span>'); return; }
  const reviewed = await PromptReview.openList({
    title: 'AI 分镜方案（确认后写入项目）',
    /* 三句都写在这里：短片名、镜数与软上限那一档（和表单 hint 同一算式同一句）、
       时长区间以及它「按本机当前可用的几个型号共同支持范围」是怎么来的。
       区间来源不写明，「时长 5–10 秒」看着就像替某一家编的。 */
    sub: ((draft && draft.title ? ['短片名：' + draft.title] : [])
      .concat([softShotsNote(v.script, items.length), boardDurSub(),
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
  });
  /* 空数组也要当「没采纳」接住：openList 的确认会把正文为空的条目滤掉，
     全部被滤掉时它给的是一份空表而不是 null（只看 !reviewed 会带着空表往下走）。 */
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  /* 按交回来的**场名**归组重建。条目在这一场里的先后就是用户在弹窗里拖出来的先后 ——
     `shotNo` 只给报告与标签用，这里一律按数组顺序落盘（批次③之前是拿标签正则回查序号）。 */
  const newScenes = [];
  reviewed.forEach(row => {
    const scName = String(row.scene || '').trim() || ('场景 ' + (newScenes.length + 1));
    let sc = newScenes.find(s => s.name === scName);
    if (!sc) { sc = { id: uid(), name: scName, shots: [] }; newScenes.push(sc); }
    const sh3 = newShot();
    sh3.name = String(row.name || '').trim().slice(0, 12) || ('镜头 ' + (sc.shots.length + 1));
    sh3.prompt = String(row.text || '');
    /* 时长原样接 AI 那一个（或用户在弹窗里改的那一个）：批次①之后已经没有「用户填的目标时长」可兜底，
       也没有一份全站通用的秒数能洗。AI 没给、或本机没有能判合法的声明时**不写这一项** ——
       镜头上没有 duration 等于「交给平台默认」，与右栏那句「这一家没声明区间就不碰」同一个立场；
       给了但越界的由下面那一夹按型号收进区间并报数。 */
    setShotDur(sh3, row.dur);
    /* 批次④两个字段各归各位：台词只写在 `sh.line`（不进 `sh.prompt`、不进配音轨），
       画面说明整条留在 `sh.note`（不再被压成名字）。两者都按用户可能在弹窗里改过的那一份落。 */
    sh3.line = String(row.line || '').trim();
    sh3.lineWho = String(row.who || '').trim();
    sh3.note = String(row.note || '').trim();
    if (v.style) sh3.prompt = (sh3.prompt + '，' + v.style).trim();
    sc.shots.push(sh3);
  });
  /* 写入期兜底（批次①里最关键的一条）：批量生成走 genAll → submitCandidate，提交体发的是
     `sh.duration` 原值，而「按型号回写」那一句只在**打开这一镜右栏**时执行 —— 这条链一次都不跑。
     用户不逐镜点开、直接点「生成全部分镜」，平台收到的就是越界时长。
     镜头对象是活引用（追加那一支里 placeScenesInto 也只是把它们挪进已有场景），夹在这里就等于夹在账上。 */
  const clamped = clampShotDurations(newScenes.flatMap(sc => sc.shots || []));
  /* 带台词那一档的报数与出路写在同一句里：只说「N 镜有台词」而不指着落点，
     等于让用户以为台词已经进配音轨了（它没有，也永远不该由拆分镜自己发请求）。 */
  const linedN = newScenes.reduce((n, sc) => n + (sc.shots || []).filter(x => (x.line || '').trim()).length, 0);
  const lineNote = linedN ? lineLandedNote(linedN) : '';
  /* 素材图挂在场景图**之后**：两者抢的是同一批参考图名额，先让「这一场的图」占位，
     素材那几张带不上时会照实报「参考图最多 N 张」，而不是静默少带几张。 */
  if (append) {
    /* 追加要保住场景划分（判据在 placeScenesInto 那一份，探针问的就是它）：
       以前是 `newScenes.forEach(sc => cur.shots.push(...sc.shots))` —— AI 拆出来的几个场景
       全被压进「当前那一场」，左栏既看不出分过场，场景图也失去了归属。 */
    const r0 = placeScenesInto(proj.scenes, newScenes);
    proj.curScene = r0.at; proj.curShot = 0;
    reportScenePics(r0.pics,
      `已追加 ${reviewed.length} 个镜头：并进 ${r0.merged} 个同名场景` + (r0.created ? '、新建 ' + r0.created + ' 个场景' : '')
      + lineNote + clampNote(clamped),
      SplitAssets.bind(newScenes.flatMap(sc => sc.shots || []), staged.picked));
  } else {
    let added = 0, why = '';
    newScenes.forEach(sc => {                        // 新短片：场景本身还没有图，于是认素材库里同名那条
      const r = feedScenePics(sc, sc.shots);
      added += r.added; if (r.why && !why) why = r.why;
    });
    const np = { id: uid(), name: (draft && draft.title) || ('AI 短片 ' + window.dayKey(Date.now())), scenes: newScenes };
    WS.projects.push(np);
    switchProject(np.id);
    reportScenePics({ added: added, why: why },
      `已新建短片「${np.name}」：${newScenes.length} 个场景 / ${reviewed.length} 个镜头` + lineNote + clampNote(clamped),
      SplitAssets.bind(newScenes.flatMap(sc => sc.shots || []), staged.picked));
  }
  renderAll(); scheduleSave();
}
/* 「修改现有分镜」这一档：现有清单 + 用户那一句话 → changes → 账 → 审查弹窗 → 落盘。
   没有任何「AI 看一眼就自动写入」：改的是用户已经生成过的分镜，确认那一下是唯一入口。 */
async function aiBoardEdit(v) {
  const snap = snapBoard(proj.scenes);
  let staged = null;
  const ask = async () => {
    const want = String(v.instruct || '').trim();
    /* 这一档没有剧本，用来挑素材的那句话就是上面那一格填的「修改要求」；
       没填时 stage 会说「没给出用来挑素材的话，这一次没问」，而不是假装挑了 0 条。 */
    if (!staged) {
      staged = await SplitAssets.stage(REG, want, v.assetSrc);
      if (staged.warn) Toast.warn(staged.warn);
    }
    const sys = `${TL_SYS_COMMON}
${boardEditSysOf()}
约束：改几处、加几镜由你决定，不必凑数。${boardDurNote()}${staged.rule}`;
    const msg = '当前分镜清单（下面的序号就是改动要用的序号）:\n' + boardListText(snap)
      + '\n\n修改要求：' + (want || '（没有具体说改哪里）把写得不够好的提示词整体优化一遍');
    const txt = await AiStream.text(REG, sys, msg, { host: $('polishInline'), title: 'AI 正在修改分镜…' });
    const j = parseJsonLoose(txt);
    const changes = (j && (j.changes || j.edits)) || null;
    if (!changes || !changes.length) throw new Error('AI 没有给出可用的修改');
    const plan = boardPlanOf(changes, snap, { style: v.style });
    if (!plan.items.length) throw new Error(plan.skipped
      ? 'AI 给的修改对不上现有镜头（对不上的有 ' + plan.skipped + ' 条）'
      : 'AI 给的修改和现状一样，没有可改的');
    return plan;
  };
  let plan;
  try { setStatus('AI 正在读现有分镜并改…（改好先给你看一遍）'); plan = await ask(); }
  catch (e) { setStatus('<span class="err">' + e.message + '</span>'); return; }
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
  });
  if (!reviewed || !reviewed.length) { setStatus('已取消'); return; }
  const r = applyBoardPlan(reviewed, proj.scenes);
  if (r.at) { proj.curScene = r.at.scene; proj.curShot = r.at.shot; }
  renderAll(); scheduleSave();
  reportScenePics(r.pics, '已改 ' + r.upd + ' 个镜头'
    + (r.add ? '、新增 ' + r.add + ' 个镜头' : '')
    + (r.del ? '、删掉 ' + r.del + ' 个镜头' : '')
    + (r.mov ? '、挪动 ' + r.mov + ' 个镜头' : '')
    + (r.newScenes ? '、新开 ' + r.newScenes + ' 个场景' : '')
    /* 「带上了台词」这句必须跟着指出落点：用户不知道点哪儿就等于没给。
       话里不写「已合成」—— 这一次一个字都没合成（计费只在用户点「合成并加到这一轨」那一下）。 */
    + (r.lined ? lineLandedNote(r.lined) : '')
    + (r.busy ? '；' + r.busy + ' 镜还在生成，没删（等它跑完再删）' : '')
    + (r.skipped ? '（' + r.skipped + ' 条在写入时没找到目标，已跳过）' : '')
    + clampNote(r.clamped), SplitAssets.bind(r.touched, staged.picked));
}

/* ============================================================================
   剪辑 → 全片：成片的出口只有**导出**这一条
   合并结果记在 proj.merged = { name, duration, ts, clips, size, fp }。
   顶部那颗「播放成片」已删（2026-10 用户点名）：看整片走「剪辑 → 全片」那一排的实时预览
   （播放器那一排的 `#pbBtn` → `TlPlay.play()`），它按时间线直接播，**绝不为播放跑 ffmpeg**。
   合成只发生在「导出成片」那一下（exportFilmFFmpeg 自己 renderPost，把结果记进 proj.merged）。
   `filmIsCurrent(proj.merged)` 是「导出」这一条路自己用的快捷闸：盘上那份还能不能直接用。
   ========================================================================== */
/* 这一份成片对应的是**哪一串内容**：每段的 [镜头 id, 选用的候选, 第几段, 入点, 出点, 速度, 音量,
   这一段带哪几句配音]，按顺序。
   取址与合成一致（顺序取 tlSyncFromShots 的结果 —— 拖动顺序就体现在这里），
   所以「换候选 / 改入出点 / 切开或删段 / 拖顺序 / 加删配音」任何一件都会让指纹变。
   切口必须是「逐段一项」，不能塌成「候选的首末入出点」：切开**不改**首段的入点、
   也不改末段的出点（只是中间多了一个接缝），塌成那一对数的话「切成两段」会被读成没变，
   于是播的/导出还是上一版画面（旧模型只有 trimS/trimE，那一版就是用这两个数当指纹的）。 */
function filmFingerprint(clips) {
  const list = clips || [];
  /* 配音的跳过判定（voiceFp 的 ctx）要两样东西：这一段的**成片起点**与**全片灰场表**，
     两个都按「Σ 前面每一格的 tlClipDur」现累一遍 —— 与 buildRenderClips 收到的 ctx 同一本账，
     所以「剪辑改了、指纹没变」这类事不会在多出来的这一遍换算里重生。
     灰场那几秒本身也进指纹（`c.gray` 那一位）：删一段画面 → 灰场表变 → 压在上面的那几句跟着劈。 */
  const f0s = []; const gray = []; let film = 0;
  list.forEach(c => {
    const fd = tlClipDur(c);
    f0s.push(film);
    if (c.gray) gray.push([film, film + fd]);
    film += fd;
  });
  return list.map((c, i) => [c.shotId || '', c.candId || c.vid || c.cand || '',
    c.seg == null ? 0 : c.seg, c.in || 0, c.out || 0,
    c.speed || 1, c.volume == null ? 1 : c.volume, c.gray ? 'g' : '',
    voiceFp(c, { start: f0s[i], gray: gray })].join('~')).join('|')
    + '||sub:' + subtitleFingerprint();
}
/* 字幕也进成片指纹：改一句字幕、换字号颜色，盘上那份成片就旧了。
   不把 `proj.rev` 直接塞进指纹 —— 撤销 / 改一个不入片的字段也会让 rev 变，
   那会把「内容没变」误判成旧片而白跑一遍 ffmpeg。这里只认真正印在画面上的东西：
   每一镜的条目（起止、文字、来源）与样式，按镜头顺序。 */
function subtitleFingerprint() {
  const parts = [];
  allShots().forEach(sh => {
    const cur = currentOf(sh, voicesEnsure());
    if (!cur.entries.length) return;
    parts.push(sh.id + '~' + cur.source + '~' + JSON.stringify(cur.entries) + '~' + JSON.stringify(styleOf(sh)));
  });
  return parts.join('|');
}
/* 「盘上那一份成片是不是当前的」—— 「导出能不能走快捷路径」只问这一句。
   旧数据（合并时还没存指纹的）没有 fp：那时候只按段数判，与原行为一致，不把它当陈旧。 */
function filmIsCurrent(m) {
  if (!m) return false;
  const tl = tlSyncFromShots();
  if (m.fp == null) return m.clips === tl.clips.length;      // 老成片：退回段数（与从前一致）
  return m.fp === filmFingerprint(tl.clips);
}

/* 一次会改动成片内容的编辑做完后调它：重画 + 存档。
   **这里不再自动合成**（2026-10 用户要求：合成只该发生在「导出成片」那一下）。
   以前这里是 `renderAll(); scheduleSave(); maybeAutoMerge();` —— 只要用户**曾经**合并过一次，
   之后每改一个入点、每切一刀，都会在 1.2 秒后自动跑一遍 ffmpeg（几十秒、占满 CPU），
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
  renderAll(); scheduleSave();
}

/* ============================================================================
   字幕（W5）：右栏「字幕」、轨道字幕行、预览叠层、SRT / 烧录 / FCPXML
   ----------------------------------------------------------------------------
   数据层只有一份：`sh.subtitle.entries` 是**候选源秒**（AGENTS §9.2），
   显示与导出全部经 `currentOf → mapToFilm`；导入 SRT 用 `mapFromFilm` 折回源秒。
   老工程没有 `sh.subtitle` 时 `currentOf` 现派生、不写盘（不因为打开一次就写胖）。
   ========================================================================== */
let subAsrBusy = '';
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
      try { inp.remove(); } catch (e) {}
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
  if (!sh || subAsrBusy) return;
  const c = chosenCandOf(sh);
  const src = c ? candTrackSrc(c) : '';
  if (!src) { setStatus('<span class="err">这一镜还没有可识别的素材：先生成或导入一条视频</span>'); return; }
  subAsrBusy = sh.id;
  try {
    if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
    setStatus('<span class="meta">正在提交语音识别…</span>');
    const r = await window.Asr.transcribe({ src });
    if (curShot() === sh) renderEditor();
    const job = await window.Asr.wait(r.jobId, j => {
      if (curShot() === sh) setStatus('<span class="meta">正在识别这一镜的语音… ' + Math.round((j.progress || 0) * 100) + '%</span>');
    });
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
    setStatus('<span class="err">自动识别失败：' + esc(String(errText(e))) + '</span>');
  } finally {
    subAsrBusy = '';
    if (curShot() === sh) renderEditor();
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
/* 右栏那一列：每条的来源、成片时间、可改的字。 */
function subRowsHTML(sh, cur, c) {
  const shotAt = shotFilmAt(sh);
  if (!cur.entries.length) return '';
  return '<div class="sub-list">' + cur.entries.map((e, i) => {
    const m = shotAt != null ? filmOf(sh, shotAt, e, { cand: c }) : null;
    const a = m ? m.filmStart : (Number(e.startMs) || 0) / 1000;
    const b = m ? m.filmEnd : (Number(e.endMs) || 0) / 1000;
    const tag = e.src === 'voice' ? '配音' : e.src === 'line' ? '台词' : e.src === 'asr' ? '识别' : '手改';
    return `<div class="sub-row" data-subi="${i}">
      <div class="sub-meta">
        <span class="sub-tag">${tag}</span>
        <span class="sub-time" title="${m ? '成片秒（导出与播放器同一把尺子）' : '源秒（这一镜还没进成片）'}">${fmtDur(a)} – ${fmtDur(b)}</span>
        <button class="ghost mini" data-subdel="${i}" title="删掉这条字幕（只删字幕，台词与配音不动）">${icon('trash', 11)}</button>
      </div>
      <textarea class="ui-ta sub-ta" rows="1" data-subtext="${i}" title="改这一条字幕的字：不会反写台词；改完这一份算手改，台词再变也不会被悄悄覆盖">${esc(e.text)}</textarea>
    </div>`;
  }).join('') + '</div>';
}
/* 本镜那一排的字幕块：按**本镜轴**摆（与画面格、插针同一把尺子）。 */
function subLaneHTML(sh, c, g, ax) {
  const cur = subCurrent(sh);
  const list = mapToShot(sh, cur.entries, { cand: c });
  if (!list.length) return '';
  return '<div class="tl-sub-lane">' + list.map((e, i) => {
    const left = Math.max(0, Math.min(ax, e.shotStart));
    const w = Math.max(0.03, Math.min(ax - left, e.shotEnd - e.shotStart));
    const src = (Number(e.startMs) || 0) / 1000;
    return `<span class="tl-sub" data-src="${src}" data-axis="${e.shotStart}" data-subi="${i}"
      style="left:${pct(left, ax)}%;width:${pct(w, ax)}%"
      title="${esc(e.text + ' · ' + fmtDur(e.shotStart) + '–' + fmtDur(e.shotEnd) + '（本镜轴）。点一下跳到这里；改字在右栏「字幕」')}">${esc(e.text)}</span>`;
  }).join('') + '</div>';
}
/* 全片那一排的字幕块：按**成片秒**摆（filmEntriesOf 与 SRT / FCPXML 同一份映射）。 */
function filmSubLaneHTML(tl, g) {
  const rows = [];
  let at = 0;
  tl.clips.forEach(c => { const dur = tlClipDur(c); rows.push({ c, at, dur }); at += dur; });
  const got = filmEntriesOf(rows, allShots(), voicesEnsure());
  if (!got.entries.length) return '';
  const ax = Math.max(0.05, Number(g && g.total) || at);
  return '<div class="tl-sub-lane">' + got.entries.map(e => {
    const left = Math.max(0, Math.min(ax, e.filmStart));
    const w = Math.max(0.03, Math.min(ax - left, e.filmEnd - e.filmStart));
    return `<span class="tl-sub" data-start="${e.filmStart}" data-subi="${e.index}"
      style="left:${pct(left, ax)}%;width:${pct(w, ax)}%"
      title="${esc(e.text + ' · 成片 ' + fmtDur(e.filmStart) + '–' + fmtDur(e.filmEnd) + '。点一下跳到这里；改字在右栏「字幕」')}">${esc(e.text)}</span>`;
  }).join('') + '</div>';
}
function bindSubLanes(bar, col, filmMode) {
  bar.querySelectorAll('.tl-sub-lane .tl-sub').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      proj.tlLane = 'voice';
      vcTab = 'sub';
      if (filmMode) {
        filmApplyAt(col, tlSyncFromShots(), Number(el.dataset.start) || 0, {});
      } else {
        const sh = curShot();
        if (!sh) return;
        const c = chosenCandOf(sh);
        const total = c ? candDur(c, sh) : 0;
        setPin(col, sh, c, total, Number(el.dataset.src) || 0, null);
        TlPlay.pause();
        TlPlay.seek(Number(el.dataset.axis) || 0, false);
        renderEditor();
      }
    };
  });
}
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
/* 烧录：每条字幕栅格化成与成片同宽高的透明 PNG（预览与 SRT 之外的第二条保底），
   存进本机资产后交给 /render 的 subtitles[]；服务端用 overlay + enable='between(t,a,b)' 叠上去。 */
function subCanvasB64(entry, style, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('这台机器的浏览器给不出 2D 画布，烧录字幕做不了（导出 SRT 或 FCPXML 不受影响）');
  const scale = h / 1080;
  const fs = Math.max(12, Math.round(style.fontSize * scale));
  ctx.font = '600 ' + fs + 'px "' + String(style.fontFamily || 'PingFang SC').replace(/"/g, '') + '", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = String(entry.text || '').replace(/\r\n?/g, '\n').split('\n');
  const lh = fs * 1.25;
  const y0 = style.position === 'top' ? h * 0.14 : style.position === 'middle' ? h / 2 : h * 0.86;
  if (style.highlight) {
    let mw = 0;
    lines.forEach(ln => { mw = Math.max(mw, ctx.measureText(ln).width); });
    const pad = fs * 0.45;
    const bh = lh * lines.length + pad * 2;
    const bw = mw + pad * 2;
    const x = w / 2 - bw / 2;
    const y = y0 - (lh * (lines.length - 1)) / 2 - lh / 2 - pad;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const r0 = Math.min(12, bh / 2);
    ctx.beginPath();
    ctx.moveTo(x + r0, y);
    ctx.lineTo(x + bw - r0, y); ctx.quadraticCurveTo(x + bw, y, x + bw, y + r0);
    ctx.lineTo(x + bw, y + bh - r0); ctx.quadraticCurveTo(x + bw, y + bh, x + bw - r0, y + bh);
    ctx.lineTo(x + r0, y + bh); ctx.quadraticCurveTo(x, y + bh, x, y + bh - r0);
    ctx.lineTo(x, y + r0); ctx.quadraticCurveTo(x, y, x + r0, y);
    ctx.closePath(); ctx.fill();
  }
  ctx.shadowColor = 'rgba(0,0,0,.9)';
  ctx.shadowBlur = Math.max(2, fs * 0.12);
  ctx.fillStyle = style.color;
  lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + (i - (lines.length - 1) / 2) * lh));
  return cv.toDataURL('image/png').split(',')[1] || '';
}
async function subtitleBurnItems(size) {
  const { rows } = filmRowsForSubtitles();
  const got = filmEntriesOf(rows, allShots(), voicesEnsure());
  if (!got.entries.length) return { items: [], count: 0, missing: got.missing };
  const items = [];
  for (let i = 0; i < got.entries.length; i++) {
    const e = got.entries[i];
    const sh = allShots().find(x => x.id === e.shotId);
    const b64 = subCanvasB64(e, styleOf(sh), size.w, size.h);
    const saved = await Api.saveLocalAsset({
      name: 'subtitle-' + (i + 1) + '.png', mime: 'image/png', format: 'png', data: b64,
      meta: { provider: '字幕', prompt: String(e.text || '').slice(0, 80) },
    });
    const src = saved.url || Api.assetSrc(saved.assetId || saved.id);
    items.push({ src, start: round2(e.filmStart), end: round2(e.filmEnd) });
    if (i % 5 === 4) setStatus('<span class="meta">正在栅格化字幕 ' + (i + 1) + '/' + got.entries.length + '…</span>');
  }
  return { items, count: items.length, missing: got.missing };
}

/* 成片已经在盘上且是最新的：直接下载，不再跑一遍 ffmpeg（「导出成片」的快捷路径）。 */
async function downloadMergedFilm() {
  const m = proj.merged;          // 调用那条路的 exportFilmFFmpeg 先判过 filmIsCurrent
  /* 盘上那一份取不到（手动删过 `.renders`、渲染目录换过地方、上一次没写完）或是空的：把记着的成片作废，
     下一次点「导出成片」才会真跑一遍 ffmpeg 重新合成。
     以前这里只回一句「请重新合并」—— 那颗按钮早删了，等于指着一颗不存在的按钮；
     而且再点「导出成片」，`filmIsCurrent` 照旧说「这一份是当前的」，又走回同一条快捷路径、
     拿到同一个 404 —— 死循环，界面一条出路都不给。 */
  const lost = t => {
    proj.merged = null;
    renderAll(); scheduleSave();
    setStatus('<span class="err">' + t + '；已记下「盘上那一份没了」，素材都还在 —— 再点一次右上角「导出成片」会重新合成一份</span>');
  };
  try {
    const blob = await renderBlob(m.name, '下载成片');
    if (!blob.size) { lost('下载成片：文件是空的'); return; }
    const saved = await saveBlob(m.name, blob);
    setStatus('<span class="ok">' + saved.msg + '（' + window.fmtBytes(blob.size) + '）</span>');
  } catch (e) {
    if (e && e.gone) { lost(e.message); return; }
    setStatus('<span class="err">下载失败：' + e.message + '</span>');
  }
}
/* 剪辑 → 全片 那一格状态说明整块已删（2026-10 用户点名：镜头统计那一行 + 成片陈旧那句长提示）。
   成片新旧这件事现在只在**点导出那一刻**由 `exportFilmFFmpeg` 的快捷闸（`filmIsCurrent`）自己判，
   界面上不再有第二处陈述。 */

/* 关标签/刷新前的同步兜底：IndexedDB 的写入是异步的，beforeunload 里不能等它。
   这里把同一份工作区写进 localStorage 的**一次性**键（只有出现未落盘改动时才写），
   下次启动读完就删；它不是第二份工作区，只是「最后 500ms」的救生包。 */
const K_WS_UNLOAD = 'dir_ws_unload';
let wsFlushOk = false;
window.__spaFlush = () => {
  wsFlushOk = false;
  let dirty = false;
  try { dirty = !!saveTimer || !lastSavedJson || snapOf() !== lastSavedJson; } catch (e) { dirty = true; }
  if (!dirty) { wsFlushOk = true; return; }
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    if (!WS || !Array.isArray(WS.projects)) return;
    const rec = { projects: WS.projects, curId: WS.curId, roles: WS.roles, ts: Date.now() };
    try {
      localStorage.setItem(K_WS_UNLOAD, JSON.stringify({ ts: rec.ts, data: rec }));
      wsFlushOk = true;
    } catch (e) {}
    /* 正常路径：IndexedDB + 代理那份镜像也推一次（浏览器不一定会等它，所以上面那份才是兜底）。 */
    try { wsKv.put('workspace', rec).catch(() => {}); } catch (e) {}
    try { if (window.DataSync) DataSync.mirrorWs(JSON.stringify({ v: 1, data: rec, ts: rec.ts })); } catch (e) {}
  } catch (e) {}
};
window.__spaDirty = () => {
  if (wsFlushOk) return false;
  try { return !!saveTimer || !!(lastSavedJson && snapOf() !== lastSavedJson); } catch (e) { return false; }
};
try { if (window.__spaRegister) window.__spaRegister(window.__spaFlush, window.__spaDirty); } catch (e) {}
function scheduleSave() {
  wsFlushOk = false;
  $('saveState').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout
  (async () => {
    const snap = snapOf();
    if (lastSavedJson && snap !== lastSavedJson && !undoPushed) {
      pushUndo(lastSavedJson);          // 限总量，避免大工程把内存吃满
      redoStack.length = 0;
    }
    undoPushed = false;
    try {
      const wsRec = { projects: WS.projects, curId: WS.curId, roles: WS.roles, ts: Date.now() };
      await wsKv.put('workspace', wsRec);
      lastSavedJson = snap;
      $('saveState').textContent = '已保存到本地';
      /* 同时写一份到代理的数据目录（.data/workspace.json）：浏览器存储被清掉时还能从磁盘恢复。
         这里只有**引用**（每条素材指向 `.assets` 里的一个资产号），视频字节不在 JSON 里 ——
         那份镜像之所以还能当备份用，是因为 `.assets` 与它一起在项目目录下。
         （原来这句写的是「Blob 在 IndexedDB 里按 blobKey 存」—— 那个键全项目没有一处赋值，
          见下面 exportProject 那一段的注释。） */
      if (window.DataSync) {
        try { window.DataSync.mirrorWs(JSON.stringify({ v: 1, data: wsRec, ts: wsRec.ts })); } catch {}
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
let midCandExpand = (function () { try { return localStorage.getItem('dir_cand_expand') === '1'; } catch (e) { return false; } })();
/* ============================================================================
   剪辑态的「无感播放」：不渲染也能播剪完之后的样子
   ----------------------------------------------------------------------------
   以前剪完要看效果只有一条路：合并成片（跑一遍 ffmpeg，几十秒），改一个入点就得再合一次。
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
  const pb = col.querySelector('#pbBtn'), tb = col.querySelector('#pbTime'), mb = col.querySelector('#pbMute');
  const ab = col.querySelector('#arBadge');
  const before = TlPlay.fp;
  TlPlay.mount(a, b, { muted: localStorage.getItem('dir_muted') === '1' });
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
  if (mb) {
    mb.innerHTML = icon(TlPlay.muted ? 'speakerOff' : 'speaker', 14);
    mb.onclick = e => {
      e.stopPropagation();
      const on = !TlPlay.muted;
      TlPlay.setMuted(on);
      mb.innerHTML = icon(on ? 'speakerOff' : 'speaker', 14);
      mb.title = on ? '已静音（点击开启声音）' : '声音已开启（点击静音）';
      localStorage.setItem('dir_muted', on ? '1' : '0');
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
  const muted = localStorage.getItem('dir_muted') === '1';
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
     这是「剪完马上看到效果」的落点 —— 改一个入点不用再跑一遍 ffmpeg 合并。 */
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
    if (pl.getAttribute('src') !== Api.mediaSrc(target.url)) { pl.setAttribute('src', Api.mediaSrc(target.url)); try { pl.load(); } catch (e) {} }
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
      if (mb) { pl2.muted = localStorage.getItem('dir_muted') === '1'; mb.innerHTML = icon(pl2.muted ? 'speakerOff' : 'speaker', 14); }
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
    try { localStorage.setItem('dir_cand_expand', midCandExpand ? '1' : '0'); } catch (e) {}
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
    await submitCandidate(sh, ph);
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
   调用方本来都写了 `if (!prov) ...`（下面 pollOne 那处会标 failed 并说清原因），
   去掉兜底反而让它们走到本来准备好的那条路上。 */
function provById(id) {
  if (window.Api && Api.prov) return Api.prov(id);
  const list = (REG?.providers || []);
  return list.find(p => p.id === id || (p.keyId || p.id) === id) || null;
}
let scenesDirty = false;         // 这一轮轮询里「左栏关心的东西」到底变没变（S1）
/* 活儿清单：**所有短片**里带平台任务号、又没到终态的候选（不只是当前这一部，L55）。
   以前只看 allShots()（= 当前短片）：在短片 A 上点了「生成全部分镜」，随手切到 B ——
   A 的镜头就永远停在「● 生成中」加一条不动的进度条，再也不会更新；
   批量收尾的消息还会写进 B 的左栏，看着像是在说 B。
   `mine` = 「这一条属于我现在正看着的那部短片」：只有在途候选属于当前短片时才允许
   触发左栏 / 中栏重画（在别的短片上重画当前短片 = 串台）。落盘是全局的，照旧。
   每条候选配一个 `{ c, sh, mine }` 的壳，是因为轮询器只认「一个任务对象」，
   而这里写回状态之外还要知道它属于哪个镜头、要不要重画。
   **壳要跨轮复用同一个对象**（下面 shells 那张缓存）：公共轮询器按任务对象记「这一条连续失败几次」，
   每轮新建一个壳等于那份计数永远从零开始 —— 坏掉的详情端点就又变成「一直转圈、一声不吭」。 */
let pollShells = new Map();      // 候选对象 → 它的壳（身份稳定；每轮整张换掉，留下的只有这一轮还认得的）
function pollTasks() {
  const next = new Map();
  const out = [];
  for (const p0 of (WS.projects || [])) {
    if (!p0 || !Array.isArray(p0.scenes)) continue;
    const mine = p0 === proj;
    p0.scenes.forEach(sc => (sc.shots || []).forEach(sh => (sh.candidates || []).forEach(c => {
      if (!c || !c.vid) return;
      const t = pollShells.get(c) || {};
      t.c = c; t.sh = sh; t.mine = mine;              // 归属每轮现跟，只有身份是攒下来的
      next.set(c, t);
      out.push(t);
    })));
  }
  pollShells = next;
  return out;
}
/* 「这一条还要不要问」：本机占位号（tmp_）与终局不问。
   'creating' **不在**排除名单里 —— 以前把它也排除了，于是「create 已经回了任务号、
   状态还停在 creating」的候选永远不被问一次。 */
function pollLive(t) {
  const c = t.c;
  return !String(c.vid).startsWith('tmp_') && !['succeeded', 'failed', 'cancelled'].includes(c.status);
}
/* 一个候选出画面后推一次「已生成」：自动镜像不再等某个列表页加载 AssetLib。
   这一处只管两件事：同一个候选不投第二遍、把候选形状翻成公共字段。
   地址有没有、是不是本地导入的候选（la_ 号 / /asset/la_）由 `AssetLocal.announce` 判
   —— 那一道闸四个生产点共用一份（见 local.js 的 announce 说明）。 */
function announceAssetDone(c) {
  if (!c || c._mirrorAnnounced) return;
  const src = String(c.url || (c.assetId ? Api.assetSrc(c.assetId) : ''));
  if (!src) return;
  c._mirrorAnnounced = true;
  window.AssetLocal.announce([{
    kind: 'asset', provider: c.provider || '', assetId: c.assetId || '', genId: c.vid || '',
    type: '视频', format: c.format || 'mp4', status: 'done', src,
    prompt: c.prompt || '', model: c.model || '', tier: c.tier || '', res: c.res || '', ar: c.ar || '',
    duration: c.duration ?? null, credits: c.credits ?? null, priceMicros: c.priceMicros ?? null,
    currency: c.currency || '', priceText: c.priceText || '', gstatus: c.gstatus || c.status || '',
    created: c.created || '', completed: c.completed || '',
  }]);
}
function announceDoneCandidates() {
  try { allShots().forEach(sh => (sh.candidates || []).forEach(c => { if (c && c.status === 'succeeded' && c.url) announceAssetDone(c); })); } catch (e) {}
}
function pollOne(t) {
  const { c, sh, mine } = t;
  const prov = provById(c.provider);
  /* 认不出平台（换过端口 / 清过缓存 / 那一家被停用）：**当场把话说清**，
     而不是继续轮询一条永远问不到的 URL（`pollTask(null,…)` 每次都失败，
     用户看到的是任务永远停在「生成中」）。
     说清之后仍然标 failed —— 用户能点重试，而重试会重新提交一条新任务。 */
  if (!prov) {
    c.status = 'failed';
    c.error = '这一条属于「' + (c.provider || '?') + '」，但当前平台清单里没有这一家 —— '
      + '到「设置 → 供应商与密钥」重新勾一下它，再点重试';
    c.progress = '';
    return Promise.resolve();
  }
  /* 轮询返回「状态没变、进度没动」是最常见的情况（占比压倒性），以前那种情况照样在
     .finally 里付一整轮 renderScenes()：整块重建左栏、逐镜头重挂十几个监听器。
     左栏实际只看这几样：选中候选的 url、有没有在跑的候选、跑着的那个的进度、状态文案。
     所以进请求前先把这几个值记下来，回来一比，没变就不重画。 */
  const dStatus = c.status, dProgress = c.progress, dUrl = c.url, dSel = sh.selId;
  let p2done = false;
  /* 统一走 Api.pollTask：它认 registry 的 pollVia:'list'。以前这里自己按 endpoints.detail 拼请求，
     而 VGENV 的 /v2/videos/{id} 是 404 空壳 —— 在跑的任务会被判成「平台上找不到这条任务」，
     界面裂成假失败卡 + 列表里真实的完成卡，用户重试就是重复扣费（AGENTS.md：只走 Api.pollTask 这类统一入口）。 */
  return Api.pollTask(prov, c.vid).then(r => {
    const v = (r && r.raw) || null;
    const p = r && r.p;
    // 状态/进度/产出/费用全部按 registry 的 list.map 解析（平台差异不再写在这里）
    if (p) {
      c.status = p.status ? canStatus(p.status) : c.status;
      c.miss = 0;                                     // 这一轮在平台上找到了它
      c.progress = p.progress ?? 0;
      if (p.duration != null) c.duration = p.duration;
      c.error = p.error || null;
      if (v && v.queue_position != null) c.queue_position = v.queue_position;
      if (p.priceMicros != null) c.priceMicros = p.priceMicros;
      const pt = Api.priceText(prov, p);
      if (pt) c.priceText = pt;
      if (p.done && p.assetId) {              // 产出是资产 id → 本地直链，不受签名有效期影响
        c.assetId = p.assetId;
        c.url = Api.assetSrc(p.assetId);
      } else if (p.done && p.url) {           // 产出是可播放 URL
        c.url = p.url;
      }
      if (p.done || p.failed) {
        if (!sh.selId && p.done) { sh.selId = c.vid; }   // 第一条成功的自动选用
        if (p.done) announceAssetDone(c);                // 自动镜像的入口（见 announceAssetDone）
        p2done = true;                                   // 这一条刚出结果 → 立刻重画中栏
      }
    } else if (r) {
      /* 列表接口通了、但里面已经没有这条任务：多半被清理或过期了，结掉卡片（旧 M21 的成因）。
         但要**连续几轮**都没有才认 —— 刚提交的任务可能还没同步进列表，游标翻页也可能这一轮没翻到，
         单次落空就把卡片结掉，正是「任务明明在做完的那一刻变成失败」的成因之一。 */
      c.miss = (c.miss || 0) + 1;
      if (c.miss >= 3) {
        c.status = 'failed';
        c.error = '平台上找不到这条任务（可能已被清理或过期），可重新生成';
        p2done = true;
      }
    }
  }).catch(e => {
    /* 平台上查不到这条任务（404：已被清理 / 任务号失效）：结掉这张卡并写明原因，
       以前 .catch(()=>{}) 一律吞掉 —— 卡片永远停在「生成中」，还每 3 秒空打一次接口。
       判定只认 404 与明确的「不存在」措辞：403 多半是限流或鉴权抖一下，任务号还有效，
       当场结掉就是把还能跑的任务说成失败（三个工作台都是这个口径）；
       /40[34]/ 在整条消息里找子串更不行 —— 任务号或金额里带 403/404 的普通错误会被误判。 */
    const gone = e && (e.status === 404 || /不存在|未找到|not\s*found/i.test(String(e.message || '')));
    if (gone && (c.miss = (c.miss || 0) + 1) >= 3) {
      c.status = 'failed';
      c.error = '平台上找不到这条任务（可能已被清理或过期），可重新生成';
      p2done = true;
      return;                       // 这条已经结掉，不必再算成「刷新失败」
    }
    /* 其它错误（超时 / 5xx / 断连）交给公共轮询器：它按「整轮全失败」退避并提示，
       按「同一条连续三次」单独说一句 —— 以前这里只 console.warn，一条坏掉的详情端点
       会让卡片永远转圈、界面一声不吭，而且每 3 秒照打不误。 */
    throw e;
  }).finally(() => {
    sortCandidates(sh);                                  // 生成的往前排、排队的往后排
    saveScheduleSoft();
    /* 左栏只在真的变了时才重画（见上面 dStatus 那段）：一次 tick 里 K 条候选最多合并成
       一次渲染（renderScenesSoon 的 350 ms 防抖），而「什么都没变」时一次都不画。 */
    if (mine && (c.status !== dStatus || c.progress !== dProgress || c.url !== dUrl || sh.selId !== dSel)) scenesDirty = true;
    if (mine) {
      if (scenesDirty) { scenesDirty = false; renderScenesSoon(); }
      updateMidLive();                                   // 中栏就地更新（不重建 → 候选缩略图不刷新）
      if (p2done) forceMid = true;                       // 结构需要变（占位→播放器）时，下一次走完整重画
    }
  });
}
/* 「什么时候问、问多密、连续失败怎么办」交回公共轮询器 Wb.poller（与生成工作台、资产库同一台）：
   ① 间隔听设置页那一项「任务刷新间隔」（以前这里写死 3 秒 setInterval，那项设置对导演台形同虚设）；
   ② 整轮失败会指数退避、同一条连续三次会单独说一句（以前只 console.warn）；
   ③ 切走标签页自动暂停、回到前台立刻补一次（以前是本页自己抄的一份 visibilitychange）；
   ④ 一轮没跑完不会再起一轮 —— 所以原来那个「这一条正在请求中」的 polling Set 是多余的，删掉。
   切回某一部短片时补一次状态行：靠 onChange（这一轮有任何一条变过就重画横幅）。 */
const poller = Wb.poller({
  label: '分镜', interval: 3000, page: 'director.html',
  tasks: pollTasks,
  isRunning: pollLive,
  sig: t => [t.c.status, t.c.progress, t.c.url, t.c.miss].join('|'),
  pollOne,
  onChange: () => { updateBanner(); updateProjUI(); },
});
let softTimer = null;
function saveScheduleSoft() { clearTimeout(softTimer); softTimer = setTimeout(scheduleSave, 300); }

/* ---------- 创建视频（可一次生成多条，按注册路由选择提供商）---------- */
/* 一条任务一个提交单元：先建占位候选（界面立刻有反馈），创建失败只标记这一条 */
function pushPlaceholders(sh, count) {
  const phs = [];
  for (let k = 0; k < count; k++) {
    /* 字段清单归 mkCandidateBase 那一份；这里只补「已经提交出去了」才有的三项：
       占位状态、平台回的价格文案、这一镜的时长。 */
    const ph = Object.assign(mkCandidateBase(sh, 'tmp_' + uid()),
      { status: 'creating', priceText: '', duration: sh.duration || undefined });
    phs.push(ph);
    sh.candidates.push(ph);
  }
  renderAll(); scheduleSave();
  return phs;
}
async function submitCandidate(sh, ph) {
  const p = String((ph && ph.prompt != null && String(ph.prompt).trim()) ? ph.prompt : sh.prompt).trim();
  ph.prompt = p;                                 // 记下这条用的描述（方便回看/复用）
  const rm = resolvedModel(sh);
  if (!rm) throw new Error('没有支持这一镜素材的型号（当前输入：' +
    (shotUsedRoles(sh).map(r => ROLE_ZH[r] || r).join(' / ') || '纯文字') + '）：换一个支持它的型号，或清空这组素材');
  const modelId = rm.id;
  /* 提交这一下必须用 needProv：认不出平台就**停下并说清**，绝不默默发给另一家
     （见 provOf 那段注释 —— 那个兜底正是「model must match …/…」这个看不懂的报错的来源）。 */
  const prov = needProv(rm.provider, (rm.name || modelId));
  const icSub = shotInputCaps(sh);
  /* 这一镜手上的素材与当前输入模式说不通的地方（缺料 / 超料 / 不收 / 互斥），提交前照界面同一份
     判据兜一次：走到这里说明是导入 / 历史数据留下的状态，界面已经拦过一遍了。
     ⚠ 绝不静默丢掉素材 —— 用户传进去的东西要么发出去，要么把原因说出来。 */
  const gapLines = (icSub.gaps && icSub.gaps.lines) || [];
  /* 这一镜手上的素材（提交与归档文案都按同一份数）：画面切片只数真的有资产号的，
     生成失败或被删掉的不能算「已带上」。 */
  const kfs = shotKeyframes(sh);
  const nFrame = (sh.firstFrame ? 1 : 0) + (sh.lastFrame ? 1 : 0);
  /* @名字 → @参考图N → 平台声明的引用语法。归档那一份存的是**原始**描述（还是 @名字，
     人看得懂、复用也方便），只有真正发出去的 body 用转换后的。 */
  const pApi = applyRefSyntax(refTokenize(sh, p), prov);
  /* 高级设置那一读要**在归档之前**做完：摘要里写的是「这一次真的发出去了哪些顶层开关」，
     先拼好文案才不会出现「归档写着平台润色、提交体里根本没有」这种自相矛盾的存档。 */
  const ex = shotAdvExtras(sh);
  const ctxAdv = shotAdvCtx(sh);
  const cbAdv = shotCombo(sh);
  /* 归档到提示词文件夹时要写在文件头里的信息：存**原始**描述（含 @参考图N 的写法，
     比平台语法更好复用），镜头名 + 时长/画幅等参数一并记下。见 PromptLog
     「输入模式」也要记：同一句提示词在「智能参考」与「视频换人」下发出去的是两种请求、
     两种价，隔一个月回看这个文件的人（往往就是用户自己）得知道当时按哪一种出的。 */
  const log2 = { type: '导演台-分镜', prompt: p, meta: {
    镜头: sh.name || '', 模型档位: sh.tier, 分辨率: sh.res, 画幅: sh.ar, 尺寸: sh.size || '',
    时长: sh.duration ? sh.duration + 's' : '',
    输入模式: cbAdv ? comboLabel(cbAdv) : '',
    顶层参数: ex.summary,
    参考素材: [nFrame ? nFrame + ' 帧' : '', kfs.length ? kfs.length + ' 关键帧' : '',
      (sh.refImages || []).length ? sh.refImages.length + ' 参考图' : '',
      sh.refVideo ? '参考视频' : '', sh.refAudio ? '参考音频' : ''].filter(Boolean).join(' / ') } };
  try {
      // 放在 try 里：抛错时占位候选会被标成「失败」，不会留下一堆排队中的僵尸占位
      if (gapLines.length) throw new Error(gapLines.join('；') + '（' + (rm.name || modelId) + '）');
      /* 越界的形状字段（种子、超分档那种）当场拒掉，不发一个必然被上游驳回的请求：
         界面已经压暗并写了原因，走到这里说明是导入 / 历史数据留下的值。 */
      if (ex.bad.length) throw new Error(ex.bad.join('、'));
      const videoTemplate = Api.inputTemplate(prov, 'reference_video');
      if (icSub.refVideo && sh.refVideo && videoTemplate?.requiresAudio && sh.refVideo.preparedFor !== prov.id) {
        const ref = sh.refVideo;
        const source = ref.src || (sameAssetSpace(ref.provider, assetStoreId()) && ref.asset_id ? Api.assetSrc(ref.asset_id) : '');
        if (!source) throw new Error('这份旧参考视频未检查音轨，请重新选择原视频；上传时会自动补静音音轨');
        ref.asset_id = await AssetTransfer.toAsset(prov.id, source, { reg: REG, name: ref.name, role: 'reference_video', onStage: dlStage('参考视频') });
        ref.provider = prov.id;
        ref.preparedFor = prov.id;
        scheduleSave();
      }
      /* 提交体完全交给 `Api.createBody` + registry 声明（与生成工作台同一条路）：
         标准字段往哪个上游字段名映射、哪些要嵌进 parameters、顶层开关与形状字段怎么过滤、
         素材按什么形状进请求体，全是声明里的事，页面不抄第二份。 */
      const v = await Api.request(prov, 'create', { method: 'POST', log: log2,
        body: Api.createBody(prov, {
          model: modelId, prompt: pApi, tier: sh.tier, duration: sh.duration || undefined,
          res: sh.res, ar: sh.ar, size: sh.size,
          note: sh.name || '',                       // 只有声明了 acceptsNote 的那一族会真的带上（见 Api.createBody）
          inputEntries: await shotInputEntries(sh, prov, icSub),
          /* `creation_intent` 是**上游真字段**（省略 = 普通生成，person_replacement = 动作换人）；
             `mode` 不是字段 —— 平台按送上来的素材自己推断，多发一个 mode 必被拒（实测），
             它只当声明里 when / hide 的上下文走 `shape` 递进 createBody，永远不进请求体。
             以前这一路根本不带 intent：换了「视频换人」档，提交体发出的还是普通生成。 */
          creation_intent: ctxAdv.intent,
          shape: { mode: ctxAdv.mode, intent: ctxAdv.intent, caps: ctxAdv.caps }, params: ex.params,
        }) });
      /* 三种「上游说没成」的形状都要认（`Api.request` 返回的是上游原始响应体）：
         `{error:{message}}`（SparkCine 那一族与照它克隆的中转）、
         顶层 `statusCode >= 400`（VGENV 那一族）、
         以及只回一个业务 `code` 而没有任务号（ MiniMax / 智谱那一族）。
         少认一种就是把一个真失败当成「任务已建」，卡片会一直转圈等一条不存在的任务。 */
      if (v.error) throw new Error(v.error.message || '创建失败');
      if (Number(v.statusCode) >= 400) throw new Error(v.message || v.code || '创建失败');
      if (v.code && !v.id) throw new Error(v.message || v.code || '创建失败');
    Object.assign(ph, {
      vid: v.id, provider: prov.id, status: v.status || 'queued', progress: 0,
      priceText: Api.priceText(prov, Api.parseItem(prov, v)) || '',
      duration: v.duration || ph.duration, error: null, created: ph.created || Date.now(), prompt: p,
    });
    renderAll(); scheduleSave();
  } catch (e) {
    /* 「结果未知」不能写成「失败」：超时 / 断连 / 5xx 时请求多半已经被平台受理，
       显示成失败就会诱导用户重拍 —— 重复建任务、重复扣费。
       （哪一类错误算「可能已受理」由统一层标记：api.js 的 Api.request、web/ui/ui.js 的 Net.fetch） */
    ph.status = 'failed';
    ph.error = (e && e.maybeSubmitted ? '提交结果未知（平台可能已受理，重拍会再扣一次费）：' : '') + errText(e);
    if (e && e.maybeSubmitted) Toast.warn('这条提交结果未知：平台可能已经建好任务，先刷新候选，别急着重拍');
    renderAll(); scheduleSave();
    throw e;
  }
}
/* 单镜生成：一条条提交（「生成这一镜」按钮用） */
async function drawShot(sh, count) {
  const p = sh.prompt.trim();
  if (!p) throw new Error(NO_PROMPT_WHY);
  const phs = pushPlaceholders(sh, count);
  for (let k = 0; k < count; k++) {
    try { await submitCandidate(sh, phs[k]); }
    catch (e) {
      /* 这一条失败就停手（不接着花后面的钱），但**把剩下的占位也结掉**：
         它们从没提交出去，留成「创建中」永远不会动（轮询按 tmp_ 号跳过），卡片会一直挂着。 */
      for (let j = k + 1; j < count; j++) {
        phs[j].status = 'failed';
        phs[j].error = '这一批在前一条失败后没有提交（删掉即可重试）';
      }
      renderAll(); scheduleSave();
      throw e;
    }
  }
}
/* 「这一镜已经有视频（在跑或已成）」：再点一次生成 = 要又一版，不是在原镜里越攒越多候选。
   失败 / 取消不算 —— 那种情况在原镜上再点一次就是「重试」，不该开新镜头。
   （与 `hasRealCandidate` 不是一回事：那个连 failed 也算「真候选」，判的是批量生成要跳过谁。） */
const shotHasVideo = sh => (sh.candidates || []).some(c => c && !['draft', 'failed', 'cancelled'].includes(c.status));
/* 「生成」那颗按钮这一刻会做什么，文案与 #genOne 的分支同一判据（shotHasVideo）：
   已经有视频时点它是「开一条新镜头再来一版」，不再说「生成这一镜」。 */
const genBtnLabel = sh => shotHasVideo(sh)
  ? '生成新候选镜头（' + (sh.draw || 1) + ' 条）'
  : curDraftCand() ? '生成这条（1 条）' : '生成这一镜（' + (sh.draw || 1) + ' 条）';
/* 在当前场景这一镜之后原地开一条新镜头（「选中了有视频的镜头再点生成」用它）：
   整套配置照「复制镜头」那套深拷贝跟着走（提示词 / 画幅 / 模型 / 素材 / 画面切片，
   日后新加的字段也不会漏），候选与选用清空 —— 它是一条全新的提交，
   出来的片子就是这一镜的又一条候选。 */
function spawnCandidateShot(sh) {
  const sc = curScene();
  const ns = JSON.parse(JSON.stringify(sh));
  ns.id = uid();
  ns.name = sh.name + ' · 新候选';
  ns.candidates = [];
  ns.selId = null;
  const at = sc.shots.indexOf(sh);
  sc.shots.splice(at < 0 ? sc.shots.length : at + 1, 0, ns);
  proj.curShot = at < 0 ? sc.shots.length - 1 : at + 1;
  proj.curCand = 0;
  return ns;
}
/* 简易并发池：同时最多 limit 个在跑；单个任务失败只记录，不影响其它任务 */
async function runPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = { ok: true, value: await worker(items[i]) }; }
      catch (e) { out[i] = { ok: false, error: e }; }
    }
  }));
  return out;
}

/* ---------- 渲染：左栏 ---------- */
/* 缩略图与首帧缓存：统一走 workbench.js 的 Wb.thumbs（全站一份实现）
   —— 以前这四个页面各写一份，连缓存用的 IndexedDB 库都不一样。
   页面这里不再自己攒「媒体元素复用表」：占位 <video> 从不加载（抽帧用的是公共层
   自己的离屏 video），重画时命中缓存就直接出 <img>，复用旧节点反而会把已经画好的
   那一帧换回空白节点。 */
function hydrateThumbFrames() {
  return Wb.thumbs.hydrate().then(n => { if (n) { try { renderScenes(); } catch {} } });
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
/* 这个场景**现在**对得上的那张图：左栏挑的 → 素材库同名那条 → 没有。
   `sc.noPic` = 用户在左栏按过「这个场景不带图」，连素材库那张也不认领。
   这一项不是多余的状态：缩略图上显示的就是库里那张，只把 `sc.img` 清掉的话
   点完「×」画面一个字没变 —— 看着像按钮坏了，而用户确实想让它不带。 */
function scenePicOf(sc) {
  if (!sc || sc.noPic) return '';
  return sc.img || libScenePic(sc.name) || '';
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
  return addLibPicToShot(sh, { name: (sc && sc.name) || '场景' }, { src: pic });
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
function promptTextOf(sh) {
  const c = sh && (sh.candidates || [])[proj.curCand];
  if (c && c.prompt != null && c.prompt !== '') return c.prompt;
  return (sh && sh.prompt) || '';
}
/* 把提示词框按**当前查看的候选**刷一遍（字数、@ 高亮镜像、按钮状态一起）。
   selectCandidate 走的就是它 —— 那一条路刻意不重画整栏（重画会重建候选缩略图）。 */
function paintPromptBox(sh) {
  const ta = $('edPrompt');
  if (!ta || !sh) return;
  const txt = promptTextOf(sh);
  if (ta.value !== txt) ta.value = txt;
  const pc = $('pCnt'); if (pc) pc.textContent = ta.value.trim().length + ' 字';
  syncGenGate(sh);
  syncAtBack(sh);
}
function playerEmptyText(sh) {
  if (curDraftCand()) return ['这条候选还没有描述', '在右侧「提示词」里写一句，再点「生成这条」'];
  /* 还没写提示词时**不要**推荐「AI 润色提示词」：那道润色入口的守卫是
     「提示词不能为空」（见 polish 那一支的 if (!sh.prompt.trim())），
     而新工作区默认只有一个空镜头 —— 于是这句话推荐的那个按钮，
     对第一次打开的人**必定失败**。
     也不能说「直接点生成，平台会自己编」：空提示词会被 shotBlockReason 拦下（NO_PROMPT_WHY），
     生成按钮压根不发起请求 —— 那是另一句兑现不了的承诺。
     只说一件照做就能成的事：先写一句。（引号里给出可照抄的句式，省掉「该写什么」的猜测。） */
  if (!sh.prompt.trim()) return ['这一镜还没有画面描述',
    '先在右边写一句就能生成 —— 例：「她站在天台栏杆边，风把头发吹起来，背影」'];
  if (!sh.candidates.length) return ['画面还没生成', '点右侧「生成这一镜（' + (sh.draw || 1) + ' 条）」开始生成'];
  if (sh.candidates.some(c => Wb.stLive(c.status))) return ['正在生成这一镜…', '排队位置与进度见下方候选卡片'];
  if (sh.candidates.every(c => ['failed', 'cancelled'].includes(c.status))) return ['这一镜生成失败', '候选卡上有失败原因，改改提示词或换个型号再来一次'];
  return ['候选还没有画面', '稍等片刻，或点右侧再生成一条'];
}
/* 画面比例：按真实画面尺寸算（导入的本地视频 / 资产库选的视频 / 生成的视频都用它），
   标准比例给「16:9」这种写法，非标准给近似整数比或小数比；tooltip 里带实际像素 */
function ratioLabel(w, h) {
  if (!w || !h) return '';
  const STD = [[16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 3, '4:3'], [3 / 4, '3:4'], [1, '1:1'],
               [21 / 9, '21:9'], [9 / 21, '9:21'], [3 / 2, '3:2'], [2 / 3, '2:3'], [5 / 4, '5:4'], [4 / 5, '4:5']];
  const r = w / h;
  for (const [v, l] of STD) if (Math.abs(r - v) / v < 0.02) return l;      // 2% 以内算标准比例
  const g = (a, b) => (b ? g(b, a % b) : a);
  const k = g(w, h) || 1;
  const a = Math.round(w / k), b = Math.round(h / k);
  return (a <= 40 && b <= 40) ? a + ':' + b : r.toFixed(2) + ':1';
}
function updateArBadge(media) {
  const el = document.getElementById('arBadge');
  if (!el || !media) return;
  const w = media.videoWidth || media.naturalWidth || 0, h = media.videoHeight || media.naturalHeight || 0;
  if (!w || !h) return;
  el.textContent = ratioLabel(w, h);
  el.title = w + '×' + h;
}
/* 撤销 / 重做那两颗按钮（E28）：原来只有快捷键，不知道有这功能的人一直找不到，
   而笔记本 / 外接键盘没有 Ctrl 的场景**完全无法撤销**。
   disabled 按栈长现算 —— 判据就是 undoStack / redoStack 那两处，与按键走同一份，
   所以按钮与快捷键永远不会出现「一个能点一个不能」。 */
/* 拖动中途被推迟的那一次中栏重建（见 renderMid 开头那一条）：只留一个待补的定时器 */
let midDeferT = 0;
function renderMid() {
  /* 手里正有一次拖动 → 这一轮不重建整列（`dragBusy()` 一份判据，三处手势都算）。
     撞在拖动中途重建会把手指底下那个节点换掉：拖动中的就地重画找不到节点，
     表现是「拖到一半画面不动，松手才跳到位」，而轮询每 3 秒就会撞一次。
     松手那一下本来就走了 `filmEdited()` → 整栏重画，所以这一支只是兜底：
     手势的 `up` 里有提前 return（没改动任何东西）时，这一栏仍然会在拖动结束后补画一次。 */
  if (dragBusy()) {
    if (!midDeferT) midDeferT = setTimeout(() => { midDeferT = 0; if (!dragBusy()) renderMid(); }, 600);
    return;
  }
  const col = $('midCol');
  /* 全屏正开着 → 这一轮欠着，退出那一刻补画（判据与理由在 `fullscreenHold`）。
     必须排在 `dragBusy()` 后面、`col.innerHTML =` 那一族任何写操作之前 —— 早退得越靠前，
     少做的副作用越多（下面那几行会改 `proj.curCand`、`tlScrollWant`、`keepBox` 的记账）。 */
  if (fullscreenHold(col)) return;
  const sc = curScene(), sh = curShot();
  if (!sh) { col.innerHTML = '<div class="empty">左侧添加场景和镜头开始创作</div>'; return; }
  /* 记住播放器状态：整列会被重建（轮询每 3 秒一次），同一 src 时接着播，不再打断预览。
     剪辑态记的是「成片第几秒」而不是甲板的 currentTime —— 后者是**段内**秒，
     剪成几段之后拿它当进度接回去，会跳到另一段上去。 */
  const oldPl = col.querySelector('#player');
  const keepPlay = midEditTrim
    ? (TlPlay.plan.length ? { t: TlPlay.t, paused: !TlPlay.playing } : null)
    : (oldPl ? { src: oldPl.getAttribute('src'), t: oldPl.currentTime, paused: oldPl.paused } : null);
  const idx = allShots().indexOf(sh) + 1;
  sortCandidates(sh);                              // 有片的排前面、排队/生成中的排后面（顺序变了当前条会跟着走）
  const cands = sh.candidates;
  if (cands.length) proj.curCand = Math.max(0, Math.min(Number(proj.curCand) || 0, cands.length - 1));
  const filmMode = isFilmMode();
  const cur = cands[proj.curCand] || cands[0];
  const sel = sh.candidates.find(c => c.vid === sh.selId);
  // 候选条的横向滚动位置也要保留：新增候选 / 轮询刷新后不再自动跳回第一条
  const oldThumbBox = col.querySelector('#candThumbs');
  const keepThumbScroll = oldThumbBox ? oldThumbBox.scrollLeft : 0;
  /* 时间轴滚到哪儿了也要记住：整列每 3 秒重建一次，不还原的话每 3 秒被弹回最左边 ——
     片子一长（轨道比屏幕宽）这件事就变成「根本没法看后面那几段」。 */
  const oldTlBar = col.querySelector('#tlBar');
  if (oldTlBar && oldTlBar.scrollLeft > 0) tlScrollWant = oldTlBar.scrollLeft;
  /* 纵向也一样要记：`col.innerHTML =` 是「先把子节点清空、再插新的」，那一栏的滚动位置在清空
     那一刻被夹回 0 —— 与上面两处（候选条 scrollLeft / 轨道 scrollLeft）是同一族，只是从前只补了横的。
     表现是「正看着时间轴那一排调剪辑，一次重建就弹回栏顶」。窄窗（≤900px）时滚动的是整页而不是
     这一栏（`body{overflow:auto}` 那一条媒体查询），所以两处都记、两处都还。 */
  const keepY = col.scrollTop, keepWinY = window.scrollY || 0;
  /* 整列重建会把播放区那一只 `.player-box` 一起换掉（新节点要重新加载素材、重新 seek，
     画面黑一下 —— 每 3 秒一次）。能保住就摘下来、画完塞回原处：节点不动就没有「闪」。
     什么时候保（两种「不保」都比闪更糟）：
     · **剪辑态**：这一轮画的还是一只播放器、旧的那只**确实是剪辑态那对甲板**（有 `#playerB`），
       且 `TlPlay` 手里有计划。以前只在「正在播」时保 —— 暂停状态照样每 3 秒销毁重建，
       而「我只是看着暂停的画面改剪辑」正是最常走的那一条。
     · **不剪辑**：新画的这只放的**还是同一条素材**才保。换了候选 / 换了镜头，src 不是一个，
       保着旧节点等于显示另一条视频。
     ⚠ 保住之后下面那段「一次性接线」要跟着跳过：`addEventListener` 挂在一只长期活着的节点上
       会一层层叠，几十格之后同一个 `timeupdate` 上有几十个 `syncTime`，每个闭包抓着它那一轮的候选。 */
  let keepBox = null;
  {
    const old2 = col.querySelector('.player-box');
    const pm = playerMediaOf(sh);
    if (!old2) { /* 这一轮本来就没有播放器可保（空态 / 还没候选） */ }
    else if (pm && oldPl && oldPl.getAttribute('src') === pm.src) { keepBox = old2; old2.remove(); }
    else if (midEditTrim && old2.querySelector('#playerB') && TlPlay.plan.length) { keepBox = old2; old2.remove(); }
  }
  col.innerHTML = `
    <div class="mid-head">
      <span class="no">${String(idx).padStart(2, '0')}</span>
      <input class="sname" value="${esc(sh.name)}">
      <span class="meta">${esc(sc.name)} · ${shotDurText(sh)} · ${sel ? '已选用' : '未选用'}</span>
      <span class="sp"></span>
      <button class="ghost" id="prevShot">‹</button>
      <button class="ghost" id="nextShot">›</button>
      <!-- 撤销 / 重做：见renderMid 开头那段说明；disabled 按栈长现算 -->
      <button class="ghost" id="btnUndo" title="撤销上一步（Ctrl+Z）。上限 ${UNDO_MAX_COUNT} 步 / ${window.fmtBytes(UNDO_MAX_BYTES)}，右边写着现在用到第几步"${undoStack.length ? '' : ' disabled'}>撤销</button>
      <button class="ghost" id="btnRedo" title="重做（Ctrl+Y）"${redoStack.length ? '' : ' disabled'}>重做</button>
      <span class="meta" id="undoMeter" title="能撤销的步数 / 上限；内存快用满时会补一句字节数">${esc(undoMeterText())}</span>
      <!-- 这一排不再有合片出口：「导出成片 / 导出素材」搬到页头导入导出那一排，
           「播放成片」那一颗整颗删掉（2026-10 用户点名）—— 看效果走下面播放器那一排的播放，
           它按时间线实时播，从不为播放跑 ffmpeg。 -->
    </div>
    <div class="player-wrap" id="playerWrap">${playerAreaHTML(sh)}</div>
    <div class="cand-strip${midCandExpand ? ' expanded' : ''}">
      <div class="thumbs" id="candThumbs">${cands.length ? cands.map((c, i) => candThumbInner(c, i === proj.curCand)).join('') + candAddTile() : candPlaceholder()}</div>
      ${cands.length ? `<span class="cand-pager">
        <button class="ghost" id="candExpand" title="${midCandExpand ? '收成一排左右滚动' : '展开成多行，一屏看完所有候选'}">${window.icon(midCandExpand ? 'chevronUp' : 'chevronDown', 13)}<span class="tx">${midCandExpand ? '收起' : '展开'}</span></button>
        <button class="ghost" id="cPrev" title="上一条候选">${window.icon('stepBack', 14)}</button>
        <span style="font-size:12px;color:var(--sub)">第 ${proj.curCand + 1} / ${cands.length} 条</span>
        <button class="ghost" id="cNext" title="下一条候选">${window.icon('stepNext', 14)}</button>
      </span>` : ''}
    </div>
    <div class="cand-acts" id="candActs" style="padding:0 16px 6px;justify-content:flex-end">
      ${candActsHTML(sh)}
    </div>
    <div class="mid-tools">
      <button class="ghost ${midOrder ? 'active' : ''}" id="ordBtn">${icon('list', 13)} 顺序</button>
      <button class="ghost ${midEditTrim ? 'active' : ''}" id="trimBtn">${icon('scissors', 13)} 剪辑</button>
      <button class="ghost" id="libImportMid">${icon('box', 13)} 导入视频 / 素材</button>
      <span class="total">全片 ${fmtDur(totalDur())}</span>
    </div>
    ${midEditTrim ? `
    <div class="timeline-wrap">
      <div class="tl-tabs">
        <span class="ui-seg" role="tablist" aria-label="时间线范围">
          <button type="button" class="${(proj.tlTab || 'shot') === 'shot' ? 'on' : ''}" data-tab="shot" role="tab" aria-selected="${(proj.tlTab || 'shot') === 'shot' ? 'true' : 'false'}">本镜</button>
          <button type="button" class="${proj.tlTab === 'film' ? 'on' : ''}" data-tab="film" role="tab" aria-selected="${proj.tlTab === 'film' ? 'true' : 'false'}">全片</button>
        </span>
        <span style="flex:1"></span>
        <span style="font-size:11.5px;color:var(--sub)">${(proj.tlTab || 'shot') === 'shot' ? '把这一条候选切成几段、逐段调入出点' : '点一格把焦点切到那一镜，四把剪子剪的都是焦点那一条；左右拖一格 = 把那一镜挪到别一镜前面'}</span>
        <!-- 时间轴缩放（与剪映一致：时间长了整条比屏幕宽，左右拖；Ctrl+滚轮也行）。
             「自适应」= 短片子正好铺满、长片子铺到 12px/秒 就停并开始左右滚动（见 tlCurrentPps）。
             手动缩小**没有那条下限**：可以一直缩到比这条轨道还短，右边留出空白（见 tlMinPps）。 -->
        <span class="tl-zoom" title="时间轴缩放：放大看细节，缩小看全局（Ctrl + 滚轮也行；缩小可以缩到比整条轨道还短）">
          <button type="button" id="tlZoomOut" title="缩小（看全局，能缩到比这条轨道还短）">${icon('minus', 13)}</button>
          <span class="tl-zval" id="tlZoomVal">自适应</span>
          <button type="button" id="tlZoomIn" title="放大（看细节）">${icon('plus', 13)}</button>
        </span>
      </div>
      <div class="tl-tools" id="tlTools">
        <button class="tool mini" data-cut="play" id="tlListen" hidden>${icon('play', 12)} 试听</button>
        <button class="tool mini" data-cut="split" title="在插针处把这一段切成两段">${icon('scissors', 13)} 切开</button>
        <button class="tool mini" data-cut="left" title="丢掉插针左边的画面（这一段从插针开始）">${icon('arrowLeft', 13)} 向左切</button>
        <button class="tool mini" data-cut="right" title="丢掉插针右边的画面（这一段到插针为止）">${icon('scissors', 13)} 向右切</button>
        <button class="tool mini danger" data-cut="drop" title="删掉插针所在的那一段（格子不消失，原地变黑场，后面的段不前移）">${icon('trash', 13)} 删掉</button>
        <button class="tool mini" data-cut="merge" title="把插针这一段与它旁边挨着的那一段合回一段（只对「一刀切开、没再动过」的两段有效）">${icon('link', 13)} 融合</button>
        <!-- 「空隙」那颗已删（2026-10 用户点名）：它造的是一段没有画面也没有锚点的格子，
             要「这一段不要画面」有「删掉」（原地变黑场、时长不变），要「这一段不进成片」有「向右切」，
             两颗都各有一句真话可说，而空隙是第三种口径 —— 全套判据（把手 / 针的落点 / 指纹 / 播放计划）都要为它多写一支。 -->
        <!-- 「不剪了」那颗已删（用户点名的第 8 条）：它把「一键抹掉这一条上所有剪切」放在最顺手的位置，
             而 undo（Ctrl+Z / 页头那颗「撤销」）本来就是干这件事的，且还能退回去。
             各处文案里指着它的地方一起换成那条真出路 —— 见 cutSegs 的拒绝语与 paintTrimRow。 -->
      </div>
      <!-- 试听 / 切开那一排的**下一行**（用户点名的第 ① 条）：只读这一句配音的文字。
           内容由 paintVoiceLine 一处写（从 syncTlTools 调）：**选中配音块**时露出来；点画面格、
           点声音轨的空白处都整行收起（空白处那一下会把 curVoice 清掉）。文字取整句、不截断。 -->
      <div class="tl-vline" id="tlVoiceLine" hidden>
        <span class="vl-chip">配音</span>
        <b class="vl-who" id="tlVoiceWho"></b>
        <span class="vl-text" id="tlVoiceText"></span>
        <span class="vl-time" id="tlVoiceTime"></span>
      </div>
      <!-- 读数那一行（用户点名：配音行要在「全片 1 秒 · 第 1/2 格 · …」**上方**）。
           它单独占一行，不再挤在剪子那条 flex-wrap 里 —— 否则按钮排满之前它一直吊在右端，
           配音行一出现就跑到读数下面去了。 -->
      <div class="tl-hint" id="tlHint"></div>
      <!-- 两条轨 + 左边那一列轨名 = 一张两列网格（照参考图的形状）：
           左列不跟着横向滚（轨名一直在手边），右列才是滚动容器。
           每一行的显 / 锁两颗按钮：锁是真的把手势拒掉（判据见 rowLocked —— 轨名那一格管整条轨，
           第 2 行往上的那一格只管自己那一行），显是真的把行高收掉（见 .tl-grid 的 hid-pic / hid-voice
           与每一行的 .hid）—— 两颗都不许只是换个颜色。
           ⚠ 这段注释在模板串里面，不许写反引号：那会把模板串提前关掉。 -->
      <div class="tl-grid${(laneHidden('pic') ? ' hid-pic' : '') + (laneHidden('voice') ? ' hid-voice' : '')}" id="tlGrid">
        <div class="tl-side">
          <div class="tl-hrow ruler"></div>
          <div class="tl-hrow pic">${laneRowBtnsHTML('pic')}${laneRowCtlHTML('pic', 0)}</div>
          <div class="tl-hrow voice">${laneRowBtnsHTML('voice')}${laneRowCtlHTML('voice', 0)}</div>
        </div>
        <div class="tl-bar" id="tlBar"></div>
      </div>
      <div class="tl-time"><span id="tlT0">0:00.0</span><span id="tlT1" title="${(proj.tlTab || 'shot') === 'shot' ? '这一排按每段的框 ÷ 它自己的倍速摊开，右边就是它的总长（被剪掉的那两块灰也占着地方）' : '全片轨按各段自己的长度排（灰掉的部分不进成片），右边括号里才是成片真实时长'}">${(proj.tlTab || 'shot') === 'shot' ? shotAxText(cur, sh) : (fmtDur(filmFrames(tlSyncFromShots()).total) + '（成片 ' + fmtDur(totalDur()) + '）')}</span></div>
      ${(proj.tlTab || 'shot') === 'shot' && cur ? `
      <div class="trim-editor">
        <span id="trimSegLab"></span>
        从 <input type="number" id="trimS" step="0.1" min="0" max="${cur.duration || 15}">
        到 <input type="number" id="trimE" step="0.1" min="0" max="${cur.duration || 15}">
        秒 <button class="ghost" id="trimApply">应用</button>
        <span>这是源视频里的秒数；也可以直接拖动格子两端的把手</span>
      </div>` : ''}
    </div>` : ''}
    ${midOrder ? '<div class="shot-strip" id="shotStrip"></div>' : ''}`;
  if (keepBox) {
    const nb = col.querySelector('.player-box');
    if (nb) nb.replaceWith(keepBox);
  }
  /* 还原纵向滚动位置 —— 与上面那两处（候选条 scrollLeft / 轨道 scrollLeft）同一族、同一立场：
     重建不许改「用户正看到哪儿」。这一栏在宽窗时自己是滚动容器（`.col{overflow-y:auto}`），
     窄窗（≤900px）时那一档被媒体查询放开成整页滚，所以两处都记、两处都还。
     少了这一句的表现就是「点一下切页签 / 一次后台轮询，画面弹回栏顶」。 */
  if (col.scrollTop !== keepY) col.scrollTop = keepY;
  if (Math.abs(window.scrollY - keepWinY) > 1) window.scrollTo(0, keepWinY);
  // 事件
  col.querySelector('.sname').oninput = e => { sh.name = e.target.value; renderScenesSoon(); scheduleSave(); };
  col.querySelector('#prevShot').onclick = () => stepShot(-1);
  col.querySelector('#nextShot').onclick = () => stepShot(1);
  /* 「导出成片 / 导出素材」两颗搬到页头，接线也跟着搬到那里一次绑好（2026-10）：
     这一排每 3 秒随整列重建，把出口绑在这里等于每次重建都要重绑，
     而导出中的按钮文案（「取消渲染 45%」）会被下一次重画冲掉。 */
  /* 撤销 / 重做两颗按钮（E28）：与 Ctrl+Z / Ctrl+Y 走**同一个函数**，
     所以两处的判据与上限永远一致（自己写一份接线就会出现「按钮能点但没反应」）。 */
  const bu = col.querySelector('#btnUndo'); if (bu) bu.onclick = undo;
  const br = col.querySelector('#btnRedo'); if (br) br.onclick = redo;
  bindCandidateStrip(col);       // 候选瓦片 / 占位卡 / 「加一条候选」都要绑上（没有候选时也要能点）
  if (cands.length) {
    col.querySelector('#cPrev').onclick = () => { selectCandidate(Math.max(0, proj.curCand - 1)); scrollCurThumbIntoView(); };
    col.querySelector('#cNext').onclick = () => { selectCandidate(Math.min(cands.length - 1, proj.curCand + 1)); scrollCurThumbIntoView(); };
    // 缩略图不再靠「换回旧节点」防闪：命中的首帧缓存由 Wb.thumbs.mediaHTML 直接出 <img>
    bindCandActs(col);
  }
  // 还原候选条滚动位置（新增候选 / 后台刷新重画后不再跳回第一条；只有 ‹ › 翻条才滚动到当前那条）
  {
    const box = col.querySelector('#candThumbs');
    if (box && keepThumbScroll) box.scrollLeft = keepThumbScroll;
  }
  // 顺序 / 剪辑：互斥——点开一个会自动关掉另一个，再点自己则关闭
  const ord = col.querySelector('#ordBtn');
  ord.onclick = () => {
    const on = !midOrder;
    midOrder = on;
    /* 打开顺序模式要顺带关掉剪辑（两排互斥）：还是走 setTrimMode 那一个出口，
       不在这里裸写 `midEditTrim = false; TlPlay.destroy();` —— 那是第二份「关剪辑」的账。 */
    if (on) setTrimMode(false);
    else { renderMid(); renderEditor(); }
    setStatus(on ? '拖动下面的镜头缩略图可调整顺序，点一下切到该镜头' : '已退出顺序模式');
  };
  col.querySelector('#trimBtn').onclick = () => {
    const on = !midEditTrim;
    setTrimMode(on);
    setStatus(on ? '剪辑模式：调本镜入出点，或切到「全片」合并整片' : '已退出剪辑模式');
  };
  const libMid = col.querySelector('#libImportMid');
  if (libMid) libMid.onclick = () => openLibDlg(sh);   // 中栏：只导入视频作为本镜候选
  /* 五把剪子 + 试听：这一排**只有一个目标**（画面段或配音句，见 syncTlTools），
     本镜与全片两个页签、两种目标都走 runCut 这一个入口 —— 「在一处剪了另一处跟着变」不是同步
     逻辑，是没有第二份数据；「切画面还是切配音」也不是两套按钮，是同一颗问一次目标。 */
  col.querySelectorAll('#tlTools [data-cut]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.cut === 'drop') {
        /* 删的是用户看得见的一段画面 / 一句配音：走就地二次确认（全站那一份 Confirm.arm）。
           两种落点要做的是两件不同的事，那句 note 就得说两句 —— 指着配音写「这一段画面会去掉」
           是一句页面上不会发生的话。 */
        if (Confirm.arm(b, '确认删掉？', {
          note: tlCutTarget() === 'voice' ? '只删这一句配音，画面不动'
            : '插针那一段原地变成黑场：格子还在原位、时长不变，后面的段一个都不前移（这一段上的配音照放）' })) return;
      }
      runCut(b.dataset.cut);
    };
  });
  syncTlTools();
  /* 轨名栏那几颗按钮：整条轨的显 / 锁走 laneToggle，**其中一行**的显 / 锁走 rowFlagToggle，
     加行走 addLaneRow（锚行那一颗挂在最下面，第 N 行那一颗插在第 N 行下面），删行走 dropLaneRow
     （四颗都只是出口，判据不在按钮上 —— 渲染与手势问的是同一份 laneState() / rowLocked() / laneMinRows()）。
     用**委托**绑在 #tlGrid 上而不是逐颗 forEach：第 2 行往上的标签行由 `syncLaneSide` 在轨道画完之后
     才插进 DOM，逐颗绑的那一刻它们还不存在，那颗「删掉这一行」就会是一颗点了没反应的按钮。 */
  const gridEl = col.querySelector('#tlGrid');
  if (gridEl) gridEl.addEventListener('click', e => {
    /* 音量图标那颗是**静音开关**（用户点名的第 ② 条）—— 它自己一节，不落进 data-lane-act 那几颗里：
       那几颗管的是行 / 轨的显隐锁定，静音是另一种状态（不改任何一级音量）。 */
    const mut = e.target.closest ? e.target.closest('[data-lane-mute]') : null;
    if (mut) { laneMuteToggle(mut.dataset.laneMute); return; }
    const b = e.target.closest('[data-lane-act]');
    if (!b) return;
    const act = b.dataset.laneAct;
    const k = b.dataset.lane, ln = laneClamp(b.dataset.ln);
    if (act === 'row+') addLaneRow(k, col, ln > 0 ? ln : null);
    else if (act === 'row-') dropLaneRow(k, ln, col);
    else if (act === 'rhide') rowFlagToggle(k, ln, 'hides', col);
    else if (act === 'rlock') rowFlagToggle(k, ln, 'locks', col);
    else laneToggle(k, act);
  });
  /* 每一行标签上那枚基数音量：与右栏那两枚同一套规矩 —— `input` 只改这一格上的百分数读数，
     `change`（松手）才写数据 + `filmEdited()`。中途整栏重画会把手指底下的滑块换掉，所以绝不在这一步动数据。
     锁着的那一行：`setLaneVol` 在函数入口硬拒并把原因写回读数旁边（滑块被压暗，这里只是把「为什么」说出口）。 */
  if (gridEl) {
    const rowSl = e => (e.target && e.target.closest ? e.target.closest('.tl-hvol-sl') : null);
    gridEl.addEventListener('input', e => {
      const s = rowSl(e);
      if (!s) return;
      const box = s.parentNode && s.parentNode.querySelector ? s.parentNode.querySelector('.tl-hvol') : null;
      const rd = box ? box.querySelector('.tl-hvol-n') : null;
      if (rd) rd.textContent = Math.round(Number(s.value) || 0) + '%';
      if (box) box.title = box.title.replace(/现在 [^）]*）/, '现在 ' + Math.round(Number(s.value) || 0) + '%）');
    });
    gridEl.addEventListener('change', e => {
      const s = rowSl(e);
      if (!s) return;
      /* 锚行那枚 = 整轨音量（setTrackVol 自己点名改哪一轨，不看此刻指着谁）；
         第 2 行往上仍是这一行的基数（setLaneVol）。 */
      if (laneClamp(s.dataset.ln) > 0) setLaneVol(s.dataset.lane, Number(s.value) / 100, laneClamp(s.dataset.ln));
      else setTrackVol(Number(s.value) / 100, s.dataset.lane);
    });
  }
  const ta = col.querySelector('#trimApply');
  /* 两个输入框调的是「剪辑界面指着的那一段」，不是整条候选的并集：
     切开之后一格就是一段，写并集等于界面画四格、数据改一整条。 */
  paintTrimRow(col, sh, cur);
  const applyTrimFromInputs = () => {
    if (!cur) return;
    const total = candDur(cur, sh);
    const segs = segsOf(cur, total);
    if (!segs.length) { setStatus('<span class="err">这一段已经没有了：按 Ctrl+Z 退回剪切之前，再调入出点</span>'); return; }
    const i = Math.min(segs.length - 1, cutSegIdx());
    const s0 = segs[i];
    /* 能写的范围 = 这一格左右**没有邻居**的那一块（第一格到 0、最后一格到片尾）。
       不是「整条候选」：写超出就把隔壁那一格的画面抢过来了，两格会叠在一起。 */
    const lo = i > 0 ? segs[i - 1].b : 0;
    const hi = i < segs.length - 1 ? segs[i + 1].a : total;
    let s2 = parseFloat(col.querySelector('#trimS').value);
    let e2 = parseFloat(col.querySelector('#trimE').value);
    if (!isFinite(s2)) s2 = s0.in;
    if (!isFinite(e2)) e2 = s0.out;
    const clamped = !!(s2 > hi || e2 > hi || s2 < lo || e2 < lo);
    s2 = Math.max(lo, Math.min(s2, hi));
    e2 = Math.max(lo, Math.min(e2, hi));
    if (e2 - s2 < SEG_MIN) {
      e2 = Math.min(hi, s2 + SEG_MIN);
      if (e2 - s2 < SEG_MIN) s2 = Math.max(lo, e2 - SEG_MIN);
    }
    /* 整段替换而不是只写 in/out：框（a/b）与这一段**自己身上**的四件事都得跟着走。
       以前这里写的是 `{ in, out }` 两个字面字段 —— 一格调完入出点，框塌回收区（把手再也拖不回
       原来那一块）、音量被抹回 100%，正是「同一个东西两份账」里更坏的那种（改 A 悄悄清了 B）。
       框只向外扩（用户明确要的画面范围），永不越过邻居。 */
    segs[i] = segCarry(s0, { in: round1(s2), out: round1(e2),
      a: round1(Math.max(lo, Math.min(s0.a, s2))), b: round1(Math.min(hi, Math.max(s0.b, e2))) });
    const moved = reanchorVoices(sh, cur, segsOf(cur, total), segs);
    segsWrite(cur, total, segs);
    setStatus(trimStatus(sh, cur, (clamped ? `已按这一格能用的范围 ${fmtDur(lo)}–${fmtDur(hi)} 截断` : '')
      + (moved ? '；有 ' + moved + ' 句配音被切到段外，已挪到下一段开头' : '')));
    filmEdited();
  };
  if (ta) ta.onclick = applyTrimFromInputs;
  ['trimS', 'trimE'].forEach(id2 => {
    const el2 = col.querySelector('#' + id2);
    if (el2) el2.addEventListener('change', applyTrimFromInputs);
  });
  {
    /* 缩放：按钮一步 1.6 倍，Ctrl/⌘ + 滚轮按 deltaY 连续折算（一次捏合几十条，一条只 1.5% 上下），
       普通滚轮交给浏览器做左右滚动 */
    const zin = col.querySelector('#tlZoomIn'), zout = col.querySelector('#tlZoomOut');
    if (zin) zin.onclick = e => { e.stopPropagation(); tlZoomBy(1); };
    if (zout) zout.onclick = e => { e.stopPropagation(); tlZoomBy(-1); };
    /* 那个读数在手动档时是「回到自适应」那颗出口（`tlApplyScale` 现量现写 `.man` 与 title，
       写着「自适应」时它不亮、点了也不做事 —— 不是一条假承诺）。 */
    const zval = col.querySelector('#tlZoomVal');
    if (zval) zval.onclick = e => { e.stopPropagation(); tlZoomAuto(); };
    const tbar = col.querySelector('#tlBar');
    if (tbar) tbar.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      /* 触摸板的捏合就是带 ctrlKey 的 wheel：不拦下浏览器会同时做整页缩放（画面跟着一起糊）。 */
      e.preventDefault();
      tlZoomWheel(e);
    }, { passive: false });
  }
  /* 只认带 data-tab 的那两颗（本镜 / 全片）：`.tl-tabs` 里还住着缩放那两颗，
     不筛就把它们的 onclick 整个换成切页签 —— 表现是点「＋」什么都没发生（缩放从此死掉）。 */
  col.querySelectorAll('.tl-tabs button[data-tab]').forEach(b => b.onclick = () => {
    const was = proj.tlTab || 'shot';
    proj.tlTab = b.dataset.tab;
    renderMid();
    /* 切到「全片」**不合成**（同上）：全片页签的预览现在由 `TlPlay` 按时间线直接播，
       不需要先有一份成片文件。合成只剩页头「导出成片」这一颗（「导出素材」走的是同一条 /render，
       但出的是零件不是一条整片）。 */
  });
  renderTimeline(col, sh, cur);
  if (midOrder) renderShotStrip(col);
  // 自制播放控件：只有播放 / 暂停（原生控件已移除，时间跳转只在剪辑里插针）
  const pl = col.querySelector('#player'), pb = col.querySelector('#pbBtn');
  /* mm:ss 读数只有 workbench.js 的 Wb.fmtClock 一份（这一处、候选播放器那一处、插针跳转那一处以前各写一份） */
  if (pl && pb && midEditTrim) {
    bindTlPlay(col, keepPlay, Wb.fmtClock, keepBox);
  } else if (pl && pb) {
    bindPbFull(col.querySelector('.player-box'));
    if (pl.readyState >= 1) updateArBadge(pl);
    /* 整列重建保住旧节点之后，`addEventListener` 那一族不能每 3 秒再叠一层：
       同一只 `<video>` 上会挂几十个 `syncTime`，每个闭包抓着**它那一轮**的那一条候选 ——
       越滚越慢，而那行读数写的可能是旧一条的时长。
       所以每次接线前先把上一份摘掉（`AbortController` 的 signal 传给 addEventListener）。
       这也顺带修了「切换候选时节点不换、只换 src」那一路：`selectCandidate` 就地改地址之后，
       旧的 `loadedmetadata` 监听还指着上一条候选，尺寸那一格会一直空着。
       属性类接线（`onclick` / `onplay` / `onloadedmetadata`）本来就是「后者覆盖前者」，不用摘。 */
    if (pl.__pbCtl) { try { pl.__pbCtl.abort(); } catch (e) {} }
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    pl.__pbCtl = ctl;
    const onPl = (ev, fn, opt) => {
      const o = Object.assign({}, opt || {}, ctl ? { signal: ctl.signal } : {});
      pl.addEventListener(ev, fn, o);
    };
    onPl('loadedmetadata', () => updateArBadge(pl), { once: true });
    const sync = () => { pb.innerHTML = icon(pl.paused ? 'play' : 'pause', 15); };
    // 声音开关（与播放/暂停同一类按钮），偏好记在本地
    const mb = col.querySelector('#pbMute');
    pl.muted = localStorage.getItem('dir_muted') === '1';
    if (mb) {
      mb.innerHTML = icon(pl.muted ? 'speakerOff' : 'speaker', 14);
      mb.onclick = e => {
        e.stopPropagation();
        pl.muted = !pl.muted;
        mb.innerHTML = icon(pl.muted ? 'speakerOff' : 'speaker', 14);
        mb.title = pl.muted ? '已静音（点击开启声音）' : '声音已开启（点击静音）';
        localStorage.setItem('dir_muted', pl.muted ? '1' : '0');
      };
    }
    // 时长信息：当前时间 / 总时长（总时长优先用视频真实时长）
    const tb = col.querySelector('#pbTime');
    const syncTime = () => {
      if (!tb) return;
      const total = (isFinite(pl.duration) && pl.duration > 0) ? pl.duration : ((cur && cur.duration) || 0);
      tb.textContent = Wb.fmtClock(pl.currentTime) + ' / ' + Wb.fmtClock(total);
      tb.title = '视频时长 ' + Wb.fmtClock(total) + (pl.muted ? '（已静音）' : '');
    };
    syncTime();
    onPl('timeupdate', syncTime);
    onPl('loadedmetadata', syncTime);
    onPl('durationchange', syncTime);
    pb.onclick = e => { e.stopPropagation(); if (pl.paused) playSafe(pl); else pl.pause(); sync(); };
    pl.onclick = () => { if (pl.paused) playSafe(pl); else pl.pause(); sync(); };
    pl.onplay = sync; pl.onpause = sync; pl.onended = sync;
    // 视频元数据到手后回填真实时长（有些数据源不带 duration 字段）——全片模式不适用
    pl.onloadedmetadata = () => {
      if (filmMode) return;
      const d = pl.duration;
      if (isFinite(d) && d > 0 && cur && (!cur.duration || Math.abs(cur.duration - d) > 0.3)) {
        cur.duration = Math.round(d * 10) / 10;
        if (cur.trimE == null) cur.trimE = cur.duration;
        scheduleSave();
        renderMid();
      }
    };
    sync();
    /* 整列重建后接回原来的播放进度（src 未变时）。
       ⚠ 上面把节点整块保住时**这一支整个跳过**：节点没换，进度与播放态本来就还在原地，
       再 `currentTime =` 一次等于自己造一次 seek —— 画面黑一下，正是这一次要修的那件事。 */
    if (!keepBox && keepPlay && keepPlay.src && pl.getAttribute('src') === keepPlay.src) {
      const resume = () => {
        if (keepPlay.t > 0.2) { try { pl.currentTime = keepPlay.t; } catch {} }
        if (!keepPlay.paused) playSafe(pl);
      };
      if (pl.readyState >= 1) resume();
      else onPl('loadedmetadata', resume, { once: true });
    }
  }
  // 播放裁剪约束 + 插针跟随播放进度
  if (pl && cur) {
    const lo = cur.trimS || 0, hi = cur.trimE;
    const isFilm = (proj.tlTab || 'shot') === 'film';
    /* 播放进度就是插针位置：所以「剪哪一段」= 「正在放哪一段」，
       跟着播放自动挪 proj.cutSeg，四把剪子与入出点那一行、工具条那行小字一起跟上（都走 setPin）。
       正在输入框里打秒数时只挪针、不改写那两个框，否则打着字数字就跳。
       全片页签走另一条：播放器放的是**合成后的整片**，currentTime 就是成片秒 ——
       针按成片秒挪，同时把焦点与剪刀带到那一格（filmApplyAt 的 quiet 分支，不重画整栏）。
       入出点的钳制**只在本镜档**做：全片档放的是已经剪好的成片，拿焦点候选的 trimE
       去夹它会把整片拦腰截断（那一档以前就是这样跳的，本轮一并收掉）。 */
    /* 「现在播到哪」：剪辑态由 TlPlay 给（它按剪完的时间轴走，甲板的 currentTime 是段内秒，
       不是成片秒；本镜档再折算回**源秒**（TlPlay.srcT），全片档折算回**框基秒**（TlPlay.frameT）
       —— 后者正是全片那一排插针所在的轴，播放头因此只走真正进成片的画面，灰块会被跳过）。 */
    const nowT = () => (!midEditTrim ? pl.currentTime : isFilm ? TlPlay.frameT() : TlPlay.srcT());
    const syncPlayhead = () => {
      if (!midEditTrim) return;
      if (isFilm) {
        const tl = tlSyncFromShots();
        if (!tl.clips.length) return;
        /* 不再自己算 total：`filmApplyAt` 内部按**框基**现算（两条轨的时间基只有一处口径） */
        filmApplyAt(col, tl, nowT(), { quiet: true });
        return;
      }
      const total = candDur(cur, sh);
      /* 针与尺子读的是**轴秒**，而 `nowT()` / `proj.cutAt` 是数据层的**源秒** —— 画之前折一次，
         只走 `shotPinT` 这一处口径（漏折就是「倍速一上，针比格子偏左一截」）。
         `setPin` 那一路自己也会折（它收的还是源秒），所以焦点、入出点那两框一个字节不改。 */
      const sg = shotFrames(segsOf(cur, total));
      const ax = shotAxTotal(sg, total);
      const ae = document.activeElement;
      if (ae && (ae.id === 'trimS' || ae.id === 'trimE')) paintPin(col, shotPinT(sg, nowT()), ax);
      /* **没在播就不重算焦点**：整栏重画会重建播放器，而 `TlPlay.seek()` 开头无条件 emit 一次
         （新建那一只时递来的是 0 秒），于是「我刚切一刀，剪刀又指回第一段」——
         焦点只该跟着用户的手与播放头走。与全片档 `filmApplyAt` 的 quiet 分支同一立场，
         针仍画回数据里那一秒（`proj.cutAt`），只是不拿它去改写 `cutSeg`。 */
      else if (!TlPlay.playing) paintPin(col, shotPinT(sg, round1(Math.max(0, Math.min(total, Number(proj.cutAt) || 0)))), ax);
      else setPin(col, sh, cur, total, nowT());
    };
    /* 剪辑态的进度不再挂在甲板的 timeupdate 上（那段会被换掉、也会重复触发），
       由 TlPlay 的 onTime 一处回调 —— 与「插针跟着播放走」是同一件事的两条路，别各走一条。 */
    tlPlayhead = syncPlayhead;
    if (!midEditTrim) {
      pl.addEventListener('timeupdate', () => {
        if (!isFilm) {
          /* 按**段**播，不是按「[第一段的头, 最后一段的尾]」播：
             把一条剪成三段、中间那段删掉时，[lo,hi] 这个区间会把被删掉的那一段**照样放过去**
             —— 用户报的「被剪掉的还是会播放」就是它（进剪辑模式走的是另一条播放器，
             那里按时间线调度，不受影响）。落在任何一段之外就跳到紧随其后的那一段开头；
             后面没有段了就停在最后一段末尾、暂停。 */
          const segs = segsOf(cur, candDur(cur, sh));
          if (segs.length) {
            const t = pl.currentTime;
            const inside = segs.some(s => t >= s.in - 0.05 && t <= s.out + 0.02);
            if (!inside) {
              const next = segs.find(s => s.in > t);
              const last = segs[segs.length - 1];
              if (next) { try { pl.currentTime = next.in + 0.01; } catch (e) {} }
              else if (t > last.out) {
                try { pl.currentTime = last.out; } catch (e) {}
                pl.pause(); if (pb) pb.innerHTML = icon('play', 15);
              } else { try { pl.currentTime = segs[0].in; } catch (e) {} }
            }
          } else if (hi != null && pl.currentTime > hi) { pl.pause(); if (pb) pb.innerHTML = icon('play', 15); }
        }
        syncPlayhead();
      });
      ['seeking', 'seeked', 'play', 'pause', 'loadedmetadata'].forEach(ev => pl.addEventListener(ev, syncPlayhead));
    }
  }
  if (window.Dropdowns) Dropdowns.build(col);   // 中栏参数条重建后重新包装下拉
}
/* 顺序模式：一行镜头缩略图（每个镜头一张），可点击切换、可拖动排序 */
function renderShotStrip(col) {
  const wrap = col.querySelector('#shotStrip');
  if (!wrap) return;
  /* 重画之前先把「此刻已经出画的那一枚媒体」按镜头收起来，建完再照身份收养（与 renderScenes 那一族同一条路）。
     顺序模式那一排跟着中间栏每 3 秒重建一次，而 `<video>` 一销毁就得重新抽帧、缓存没命中时整排退回占位 ——
     用户报的「各个地方的视频预览都在闪」，这一排就是第三份（左栏在 renderScenes、中间栏在 renderMid）。
     只收「已经画上且带得上缩略键」的那些：`data-thumb-key` 在键过长（dataURL）时公共层故意不落到属性上，
     读不到就照旧重画，不拿「大概是同一份」当判据。 */
  const keepThumb = new Map();
  wrap.querySelectorAll('.strip-item').forEach(x => {
    const m = x.querySelector('video, img');
    if (x.dataset.sid && m && m.getAttribute('data-thumb-key')) keepThumb.set(x.dataset.sid, { m, ready: x.classList.contains('mready') });
  });
  wrap.innerHTML = '';
  const all = allShots();
  all.forEach((sh, k) => {
    const c = sh.candidates.find(x => x.vid === sh.selId);
    const it = document.createElement('div');
    it.className = 'strip-item' + (sh === curShot() ? ' sel' : '') + (shotReady(sh) ? ' ready' : '');
    it.dataset.sid = sh.id;
    it.draggable = true;
    const stripRaw = c?.url || sh.firstFrame || '';
    const stripKey = c?.url ? thumbKey(c) : Wb.thumbs.keyOf(stripRaw);
    const thumb = c?.url ? Wb.thumbs.mediaHTML(c.url, { key: stripKey })
      : sh.firstFrame ? Wb.thumbs.mediaHTML(sh.firstFrame, { type: 'image', key: stripKey, mediaAttrs: 'loading="lazy"' })
      : `<div class="ph"></div>`;
    it.innerHTML = `${thumb}<span class="sn">${String(k + 1).padStart(2, '0')}</span>
      <span class="st">${shotReady(sh) ? shotDurText(sh) : shotStatusOf(sh).text}</span>`;
    it.title = sh.name + '（点击切换，拖动排序）';
    /* 收养的条件只有一个：这一格此刻显示的还是**同一份素材**的首帧（键对得上）。
       换了选用的候选就不收 —— 留着旧节点等于界面在替用户说假话（卡片上播的是另一条视频的封面），
       而序号与状态那两行是重建的，收养动不到它们。 */
    const media = it.querySelector('video, img');
    const kept = keepThumb.get(String(sh.id));
    if (kept && media && kept.m.getAttribute('data-thumb-key') === media.getAttribute('data-thumb-key')) {
      media.replaceWith(kept.m);
      /* 占位层那一片只在「旧的那一枚真的已经画上」时撤：`.mready` 是公共层出画之后加在 wrap 上的，
         搬进新 wrap 时它不会自己跟过来，所以要照旧那一格的账补上，否则收养来的画面被 .tph 盖住 = 白闪一次。 */
      if (kept.ready) {
        it.classList.add('mready');
        const tph = it.querySelector('.tph');
        if (tph) tph.remove();
      }
      Wb.thumbs.bind(it, kept.m, stripRaw, 'mready');
    } else Wb.thumbs.bind(it, media, stripRaw, 'mready');
    it.onclick = () => {
      const sc = proj.scenes.find(s2 => s2.shots.includes(sh));
      proj.curScene = proj.scenes.indexOf(sc); proj.curShot = sc.shots.indexOf(sh);
      renderAll();
    };
    const idxOf = s => { const sc = proj.scenes.find(x => x.shots.includes(s)); return { si: proj.scenes.indexOf(sc), xi: sc.shots.indexOf(s) }; };
    it.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'shotstrip:' + k); e.dataTransfer.effectAllowed = 'move'; });
    it.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    it.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      const d2 = e.dataTransfer.getData('text/plain');
      if (!d2.startsWith('shotstrip:')) return;
      const from = +d2.split(':')[1];
      if (from === k) return;
      const f = idxOf(all[from]), t2 = idxOf(all[k]);
      const moved = proj.scenes[f.si].shots.splice(f.xi, 1)[0];
      /* 同上：同一场景里往后拖，插入下标要减一格，否则落点比手指位置远一个 */
      const at = (f.si === t2.si && f.xi < t2.xi) ? t2.xi - 1 : t2.xi;
      proj.scenes[t2.si].shots.splice(at, 0, moved);
      const sc = proj.scenes.find(x => x.shots.includes(moved));
      proj.curScene = proj.scenes.indexOf(sc); proj.curShot = sc.shots.indexOf(moved);
      filmEdited();                      // 顺序也是成片内容：改完按需自动重合并
    });
    wrap.appendChild(it);
  });
}
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
let dragGhostEl = null;
function dragGhostShow(ev, cell, label) {
  if (!dragGhostEl) {
    dragGhostEl = document.createElement('div');
    dragGhostEl.className = 'tl-ghost';
    dragGhostEl.appendChild(document.createElement('i'));
    dragGhostEl.appendChild(document.createElement('span'));
    document.body.appendChild(dragGhostEl);
  }
  const im = dragGhostEl.firstChild;
  /* 拖的是一句配音：卡片上放它自己那份波形（克隆节点，不重解码也不重算包络 ——
     波形还没后台填出来时 `.wv-box` 是空的，跟着下面那一支走虚线占位）。 */
  const wv = cell && cell.querySelector ? cell.querySelector('.wv-box > svg') : null;
  if (wv) {
    im.textContent = '';
    im.appendChild(wv.cloneNode(true));
    im.classList.remove('no');
  } else {
    im.textContent = '';
    const fr = cell ? cell.querySelector('.frs > .fr') : null;
    const bg = (fr && fr.style && fr.style.backgroundImage) || '';
    im.style.backgroundImage = bg;
    im.classList.toggle('no', !/^url\(/.test(bg));
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
}
/* 时间线两端的把手：拖的是**这一段自己**的入点 / 出点（不再是整条候选的并集）。
   拖动过程中只改样式，松手才写数据 —— 整块重画会把正在拖的那个节点销毁（原来就是这样，保持）。
   ⚠ 拖动全程**不碰剪针、也不碰播放器**：针是「上一次点在哪」的落点，把手改的是这一段的入出点，
   两件事没有因果关系。以前每一次 pointermove 都 `pl.currentTime = …; pl.pause()`，于是
   「拖一次把手 = 把正在看的那一镜换掉 + 中断播放 + 针跟着手走」，而预览跟着 seek 闪一下。 */
function bindSegDrag(row, sh, c, total, G) {  /* 拖动中只重画**框内的灰遮罩**与那行小字：格子的 left/width（它由框 a/b 定）一个字都不改，
     切片图也不重取 —— 这正是「左边/右边消失，而不是整体缩小」和
     「剪一段不影响别的段的切片」两条落到代码上的地方。
     以前这里是 `el.style.left/width = pct(in/out…)`，所以拖把手时整格一边缩一边挪，
     看起来像把整段压扁了。 */
  const segsPaint = () => {
    const list = segsOf(c, total);
    row.querySelectorAll('.tl-seg').forEach(el => {
      const i = Number(el.dataset.seg);
      const s = list[i];
      if (!s) return;
      const bw = Math.max(0.01, s.b - s.a);
      const ml = el.querySelector('.mask.l'), mr = el.querySelector('.mask.r');
      if (ml) ml.style.width = pct(s.in - s.a, bw) + '%';
      if (mr) mr.style.width = pct(s.b - s.out, bw) + '%';
      const lab = el.querySelector('.lab');
      if (lab) lab.textContent = segLabel(i, s);
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
    el.title = edge === 'l' ? '拖动设置这一段的开头' : '拖动设置这一段的结尾';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      /* `.act` = 参考项目里 `has-selected-edit-point` 那一档：手里握着哪一根，那一根就加粗发光。
         以前是绑定那一刻 `add('drag')` —— 于是每一根把手**永久**是加粗那档，界面上看不出「在拖谁」。 */
      el.classList.add('act');
      /* 尺子取**格子自己**那一段矩形：它在轴上占的就是这一格的框 [a,b]。
         轴 ↔ 源在这一格里只差一个倍速，而分子分母同除 —— 格子里的比例就是框里的比例，
         所以拖把手不用管这一格是几倍速（拿整行的矩形才要折算，那才是「2 倍速时把手拖不动到框右沿」的来源）。 */
      const crect = el.parentElement.getBoundingClientRect();
      const before = segsCopy(segsOf(c, total));   // 拖动之前的那一份
      const move = ev => {
        const k = Math.max(0, Math.min(1, (ev.clientX - crect.left) / Math.max(1, crect.width)));
        const list = segsCopy(segsOf(c, total));
        const s = list[i]; if (!s) return;
        const t = round1(Math.max(0, Math.min(total, s.a + k * Math.max(0.01, s.b - s.a))));
        /* 选区夹在**框**里：拖左手柄拖不出框的左沿（a），右手柄拖不出右沿（b）。
           没有这一道的话，把把手拖到框外会让这一格和相邻格叠在一起 —— 而框存在的意义
           就是「这一格只在自己那一块里动」。 */
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
/* 轨道取帧用的地址：候选的 url 常是上游签名外链，必须先过 Api.mediaSrc 换成同源回环（§1 硬性） */
const candTrackSrc = c => {
  const src = c && (c.src || c.url);
  if (!src) return '';
  const EM = window.EditorMedia;
  return EM ? EM.previewSrc(c) : Api.mediaSrc(src);
};
/* 段格上那行小字：没被剪过就写「第 N 段 · 3s」（与从前一字不差）；
   剪过（框比选区大）就把两个数都写出来 —— 「保留 3s（共 5s）」= 这一格里
   真正进成片的 3 秒，以及这一格在源里分到的 5 秒（剩下 2 秒是灰掉的那块）。
   渲染那一遍与拖动中那一遍共用这一个函数：两处各拼一句，拖起来文字就会跟静下来时不一样。 */
const segLabel = (i, s) => {
  const keep = round1(segLen(s)), box = round1(Math.max(0.01, s.b - s.a));
  /* 灰掉的那一段照样占时间，所以小字先说它是黑场 —— 只靠格子的底色分不出来（暗画面本来就长那样）。
     最后那个 ×倍速：小字前面那两个数（保留 / 共）都是**源秒**，而格子摆的是**这一排的尺子（轴秒）**
     —— 一段升到 2 倍速时格子和「3s」那两个字对不上（它占的轴长只剩一半）。不写这一枚，
     界面上就找不到「源里 3 秒、成片里 1.5 秒」这件事是谁说的。 */
  return (s && s.off ? '黑场 · ' : '') + '第 ' + (i + 1) + ' 段 · '
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
   三者不是同一根轴：轨道与针按**这一排的尺子（轴秒 = 各格的框 ÷ 自己的倍速）**摆，
   传进来的 `src` 是源秒（`bindPinZone` 先折回源秒才交过来，见那里），而计划量的是
   「剪剩的那几秒接起来」（被切掉的头尾不进计划）—— 剪过一刀之后拿源秒去 seek 会落到别的段上。
   折算：保留段按段内偏移 1:1 走（本镜这一档计划不缩倍速，见 `tlPlayPlan` 的 `film:false` 支），
   灰块（被剪掉的头尾）夹到最近保留的那一头，黑场整格按同一段内偏移走（它本来就占住这几秒）。
   与全片档 `filmSeek` 把焦点夹回选区的立场一致：计划里只有保留区与黑场，
   没有「停在灰块某一帧」这回事。 */
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
function bindPinZone(grid, col, sh) {
  /* 先摘掉上一份再绑。整列重建时 `#tlGrid` 是新节点，这一句什么都不做；
     而**缩放只重排 `#tlBar`**（见 tlRescale），这张网格是一直活着的那个节点 ——
     不摘就是每缩一次多叠一层，点一下轨道放 N 次针（与「保住播放器节点要先摘EventListener」同一条规矩）。 */
  if (grid.__pinOff) grid.__pinOff();
  const on = e => {
    /* 显 / 锁 / 加行 / 收行 / 行音量：改轨道，不放针。行音量排上「滑块 + 右边那枚百分数读数」是一件事的两半
       （点数字不等于想把剪针搬过去），所以两个都在排除名单里 —— 只排滑块会留下一个「点上去会跳针」的读数。 */
    if (e.target.closest('.tl-hbtn') || e.target.closest('.tl-hvol-sl, .tl-hvol')) return;
    if (e.target.closest('.cut') || e.target.closest('.vo-cut')) return;    // 把手：拖拽，不挪针
    if (trackDragged()) return;      // 刚把某一格拖去换行 / 换顺序：那不是「在这里放插针」
    /* 别的镜上溢出进来的那一截：它自己的 handler 会把焦点跳到它那一镜（整栏重画），
       这里再按旧几何放一次针就是在跟那次跳转抢方向。 */
    if (e.target.closest('.tl-v.spill')) return;
    /* 待生成占位有自己的点击（选中那一句台词 + 换到「生成配音」那一格），
       这里再按旧几何放一次针就是在跟它抢方向。 */
    if (e.target.closest('.tl-vp')) return;
    const onVoice = !!e.target.closest('.tl-v');
    const onPic = !!e.target.closest('.tl-seg');
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
    if (lane === 'voice') { vcTab = 'gen'; proj.curVoice = ''; }
    /* 尺子只有一把：内容层 `.tl-inner`（画面行 / 声音行 / 刻度尺都是它的 100% 宽）。
       兜底给的是 `bar` 本身时，传进来的就已经是 `.tl-inner`。 */
    const inner = grid.querySelector('#tlInner') || grid.querySelector('#tlBar') || grid;
    const r = inner.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    if ((proj.tlTab || 'shot') === 'shot') {
      const cands = (sh && sh.candidates) || [];
      const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId) || cands[0];
      /* 没有候选时这条时间轴压根还没有长度，针无处可放 —— 但**别说都不说**（用户点了、屏幕上一个字都没动，
         看着像轨道坏了）。这一镜有没有候选是页面上看得见的，所以只说一句、不改顶部那行结果。 */
      if (!c) { Toast.warn('这一镜还没有候选：先出一条或导入一条，轨道上才有「第几秒」可指。'); return; }
      const total = candDur(c, sh);
      /* 鼠标点的是**这一排的尺子**（轴秒）：先落回它指着的那一格、折算成源秒，
         再交给 seek 与剪子（它们要的都是源秒）；`setPin` 画针时会再折回轴秒。 */
      const G = shotFrames(segsOf(c, total));
      const tAx = ratio * shotAxTotal(G, total);
      const row = shotRowAt(G, tAx);
      const t = row ? frameToSrc(row, tAx) : 0;
      /* 放针 = 「停下来看这一帧」：暂停与定位都交给 `TlPlay`（甲板 A/B 谁在前它自己认，
         落定之后按钮图标 / 配音 / 播放状态才是同一份账）。
         以前这里是 `seekPlayerTo(t, {pause:true})` —— 只碰甲板 A、也只停甲板：
         真在播时前甲板可能是 B（打在后甲板上等于没动），而 `TlPlay.playing` 没被改，
         于是「按钮写着暂停、画面其实已冻住，再点按钮什么都不发生」。
         `t` 是源秒，而计划量的是剪剩的那几秒 —— 折算只有 `pinFilmTShot` 一份口径。 */
      TlPlay.pause();
      TlPlay.seek(pinFilmTShot(c, sh, t), false);
      setPin(col, sh, c, total, t, lane);
      return;
    }
    /* 全片：点击处换算成轨道那一排的轴秒 → 焦点切到那一镜那一段 + 插针放到那儿 */
    const tl = tlSyncFromShots();
    if (!tl.clips.length) { Toast.warn('全片轨还是空的：先在候选上点「用这条」，这里才会出现格子。'); return; }
    const G = filmFrames(tl);
    filmApplyAt(col, tl, ratio * G.total, { lane: lane });
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
  paintTrimRow(col, sh, c);
  paintTlHint(col, sh, c);
  paintVoicePos();
  /* 换了指着哪一段，芯片、那一排按钮的句子和右栏那张卡（音量 / 倍速 / 曲线）一起跟上：
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
/* 入出点那一行：画的是「剪辑界面指着的那一段」，不是整条候选的并集。
   提到模块层（以前是 renderMid 闭包里的一份），因为插针移动、段拖动、切换焦点都要重画它 ——
   闭包里的那一份外面调不到，就会出现「切了一刀，格子变了、入出点还写着旧秒数」。 */
function paintTrimRow(col, sh, cur) {
  const lab = col.querySelector('#trimSegLab');
  if (!lab) return;
  if (!cur) { lab.textContent = '这一镜还没有候选'; return; }
  const total = candDur(cur, sh);
  const segs = segsOf(cur, total);
  const i = Math.min(segs.length - 1, cutSegIdx());
  const s = segs[i];
  lab.innerHTML = s
    ? `这一条候选剪成 <b>${segs.length}</b> 段，正在调第 <b>${i + 1}</b> 段（这条结果 ${round1(total)} 秒）：保留片段`
    : `这一条候选一段画面都没留（整条 ${round1(total)} 秒）：按 Ctrl+Z 退回剪切之前`;
  const is = col.querySelector('#trimS'), ie = col.querySelector('#trimE');
  if (is) is.value = s ? s.in : 0;
  if (ie) ie.value = s ? s.out : 0;
}

/* 「开始播放，并吞掉自动播放被浏览器拦下的那个拒绝」只有播放层那一份（playback.js），
   这里不再留第二份：同一段实现在两处，改一处另一处就会漂。 */
/* 声音轨上的一句：块左沿 = 它锚定那一段的入点 + 段内偏移（与画面行同一根时间基）。
   段被切掉时这句不会跟着消失 —— reanchorVoices 把它挪到后面那段的开头，所以这里永远画得出来。 */
let voiceEl = null;
function playVoicePreview(id) {
  const v = voicesEnsure().find(x => x.id === id);
  if (!v) return;
  if (!v.src) { setStatus('<span class="err">这一句没有可用的音频地址（当时没落成本机文件），回语音台重新合成一句</span>'); return; }
  if (!voiceEl) voiceEl = new Audio();
  try { voiceEl.pause(); } catch (e) {}
  /* 记住正在试听的是哪一句：改「这一行的基数」时要当场把这一句的新音量按上去（见 setLaneVol），
     靠 src 反查会把两条同源的不同句子混成一句。 */
  voiceEl.__vid = id;
  voiceEl.src = Api.mediaSrc(v.src);
  /* 试听也按 off 起播：听到的就是「留在成片里的那一段」，与合成出来的成片一致 */
  try { voiceEl.currentTime = Math.max(0, Number(v.off) || 0); } catch (e) {}
  /* 试听按**这一句合成后的音量**播（这一句 × 它所在那一行的基数；Audio 的音量上限是 1，所以 >100% 的那一段只在成片里生效）——
     以前试听永远用 100%，用户拖了音量条听不出区别，看起来就是「音量调不了」。 */
  try { voiceEl.volume = Math.max(0, Math.min(1, voiceVolOf(v))); } catch (e) {}
  /* 试听也按这一句自己那一档倍速放（与 `TlPlay.startVoices`、代理的 atempo 同一份 `voiceRateOf`）——
     只有成片变声而试听还是原速，用户拖完那枚滑块听不出区别，就又变成「调了没反应」那一类。 */
  try { voiceEl.playbackRate = voiceRateOf(v); } catch (e) {}
  /* 正在响的那一句高亮：一句话在本镜轨与全片轨各有一个块，两处一起亮 ——
     不然一片绿色块里分不出到底在放哪一句（尤其在编排配音的时候）。 */
  const mark = on => document.querySelectorAll('.tl-v[data-vid="' + id + '"]').forEach(x => x.classList.toggle('playing', on));
  document.querySelectorAll('.tl-v.playing').forEach(x => x.classList.remove('playing'));
  mark(true);
  voiceEl.onended = () => mark(false);
  playSafe(voiceEl, () => { mark(false); setStatus('<span class="err">这句音频放不出来：' + (v.name || v.id) + '</span>'); });
}
/* 声音轨波形：解码 / 包络 / SVG 都在 waveform.js，这里只在画完之后后台填。 */
/* 一个声音块里那几样东西（波形盒 / 把手 / 音量数字）都靠它找 ——
   `CSS.escape` 不是标准 API（见全站约定），按 data 属性逐个比，别把 id 拼进选择器。 */
function voiceBlockOf(root, id) {
  if (!root || !root.querySelectorAll) return null;
  for (const el of root.querySelectorAll('.tl-v[data-vid]')) if (el.getAttribute('data-vid') === id) return el;
  return null;
}
/* 音量改了之后块上的那一层颜色与读数（判据不在这里：写数据只有 setCutVol 一个出口）。
   块上不再挂任何可调的东西 —— 以前这里还同步一条 `cursor: ns-resize` 的音量横条的 title，
   鼠标扫过音轨就变成「调整」箭头，而那块地方本来是「挪位置 / 试听」。 */
function paintVoiceVol(root, v) {
  const el = voiceBlockOf(root, v.id);
  if (!el) return;
  const vol = Number(v.vol == null ? 1 : v.vol);
  el.classList.toggle('quiet', vol < 1);
  el.classList.toggle('loud', vol > 1);
  const n = el.querySelector('.vn');
  if (n) { n.textContent = vol === 1 ? '' : Math.round(vol * 100) + '%'; n.hidden = vol === 1; }
}
/* 整个工程里「该进成片却进不了」的那几句（两条轨与右栏都问这一处，不各数各的）。 */
const orphanVoices = () => voicesEnsure().filter(voiceAdoptable);
const orphanVoicesOf = shotId => orphanVoices().filter(v => v.shotId === shotId);
/* 「搬回选用的这一镜」这道闸：返回空串 = 现在点得动，否则就是缺的那一样。
   按钮的 title 与 handler 问同一份（画一颗点了什么也不发生的按钮 = 界面承诺了一件做不到的事）。 */
function adoptWhy(sh) {
  if (!sh) return '这一镜已经不在了';
  if (laneLocked('voice')) return laneNm('voice') + '锁着，先解开「配音」那一行的锁';
  const c = (sh.candidates || []).find(x => x.vid === sh.selId);
  if (!c) return '这一镜还没有「用这条」选中的候选，搬过去没有落点';
  if (!segsOf(c, candDur(c, sh)).length) return '选中的那一条还没有画面段，搬过去没有落点';
  const list = orphanVoicesOf(sh.id);
  if (!list.length) return '这一镜没有被落下的配音';
  /* 行级那道闸（用户点名的第 19 条：加出来的那一行也能锁）：搬一句要改它的锚点与位置，
     锁着的那一行不许被改 —— 与轨道上拖块、剪子、滑块问的是同一份 `rowLocked`。 */
  const badLn = list.map(v => voiceLn(v)).find(ln => rowLocked('voice', ln));
  if (badLn != null && rowLocked('voice', badLn)) {
    return rowNm('voice', badLn) + '锁着，先解开这一行的锁（搬一句要改它挂在第几段、第几秒）';
  }
  return '';
}
/* 把这一镜的孤句搬回**选用的那一条候选**上：只换锚点（`candId` / `seg`），不动音频。
   `at` 按段内偏移原样带过去，超出新段选区的那一截夹回来；`fa/fb`（框）跟着**同量平移** ——
   与画面剪一刀时 `reanchorVoices` 同一个口径，否则搬完一句，框内那两块灰指着的是旧位置。 */
function adoptOrphanVoices(sh) {
  const why = adoptWhy(sh);
  if (why) return { ok: false, why };
  const c = (sh.candidates || []).find(x => x.vid === sh.selId);
  const segs = segsOf(c, candDur(c, sh));
  const list = orphanVoicesOf(sh.id);
  list.forEach(v => {
    const si = Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0));
    const at0 = Math.max(0, Number(v.at) || 0);
    const at = round1(Math.min(at0, Math.max(0, segLen(segs[si]) - VOICE_MIN)));
    const d = at - at0;
    const fr = voiceFrameOf(v);
    v.candId = c.vid; v.seg = si; v.at = at;
    v.fa = round1(fr.fa + d); v.fb = round1(fr.fb + d);
  });
  return { ok: true, n: list.length };
}
/* ---------------- 配音的「无限多行」（用户点名「配音应该能有无限多条轨道」）----------------
   `v.ln` = 这一句在第几行（默认 0 —— 老数据一个键都没有，与从前一模一样，不用迁移）。
   **不自动挤开**：块落在哪一行只由这个数说。自动排行的话，同一句在「本镜」那一排与「全片」
   那一排的重叠集合不是同一个（本镜只看这条候选的段，全片看所有镜），切一次页就跳一次行，
   而用户刚刚亲手把它拖到第二行等于白拖。换行的手势 = 上下拖块体（见 bindVoiceLane ②）。
   行数只数「画出来的块」：轨道行**按数据长**，不是按时间挤 —— 空着的中间行照样画，
   抽掉空行会把它上面那一行往下一格，而那一格正好是插针与刻度尺对齐的地方。 */
const voiceLn = v => laneClamp(Number(v && v.ln) || 0);
/* 按轨号把 HTML 分桶（`per` 是稀疏数组：只有真画了块的行占位，长度 = 最高那一行 + 1）。 */
function lanePut(per, v, html) {
  if (!html) return;
  const ln = voiceLn(v);
  per[ln] = (per[ln] || '') + html;
}
function voiceLanesHTML(per, rows, hint) {
  let out = '';
  const any = per.some(x => !!x);
  for (let i = 0; i < rows; i++) {
    const body = per[i] || '';
    /* 那句说明只在**整条轨都空着**时出现在第一行（用户自己加了轨道、一句还没摆，
       那一行正该告诉他去哪儿加）；一旦有块，空行就是空行，不要每条都喊一遍。
       `hid` = 只收起**这一行**（左列那一格与这一条必须同高，见 CSS 那两条 `--tlh-min`）。 */
    out += `<div class="tl-lane${rowHidden('voice', i) ? ' hid' : ''}" data-ln="${i}">` + (body
      || (i === 0 && !any ? '<span class="lane-hint">' + hint + '</span>' : '')) + '</div>';
  }
  return out;
}
/* 左边那一列的轨名行要跟着右边几行一起长（两列一张网格，行高由同一批变量决定）。
   数的是**已经画出来的行**，所以这里读 DOM 而不是重算一遍数据 —— 重算就是第二份口径，
   两排（本镜 / 全片）各自的分桶规则一旦漂开，标签就会指着错的那一行。
   多出来的标签行是 `.tl-side` 的**直接子节点**（不是把一行 div 撑高）：
   网格的行距只由 `.tl-side` 的 gap 决定，撑高那一个 div 会让下面的行整体错位。 */
/* 一行标签上的四件套（用户点名的第 19 条：加出来的那一行也要有收起 / 锁定 / 添加 / 音量）：
   眼睛（收起**这一行**）· 锁（只锁**这一行**）· ＋（在**这一行**下面插一行）· 音量滑块 + 读数。
   第 1 行是锚行，它那两颗走的是轨级 act（`hide` / `lock`）—— 不是给它单开一套判据：
   `rowHidden` / `rowLocked` 在 `ln<=0` 本来回退到轨级，锁与收起都管整条轨（与 ⑰f/⑰g 量的那颗是同一个东西）。
   `disabled` 与 title 里「为什么按不动」不在这里定：拼模板那一刻量到的是上一次渲染留下的行数，
   刚把一块拖到第 2 行、按钮却还按第 1 行点亮 —— 交给画完之后的 `syncLaneSide` 现量现写。 */
function laneRowCtlHTML(k, ln) {
  const nm = k === 'voice' ? '配音' : '画面';
  const hid = rowHidden(k, ln), lock = rowLocked(k, ln);
  const vol = laneVol(k, ln);
  const who = ln > 0 ? nm + '轨第 ' + (ln + 1) + ' 行' : nm + '轨第 1 行（整条轨）';
  const one = k === 'voice' ? '句' : '段';
  /* 第 1 行那枚滑块 = **整轨音量**（用户点名的第 ② 条）：与右栏「整轨音量」同一批字段
     （段 / 句自己的 vol），不是行基数 —— 初值取这一排此刻都同一档时的那一个数，
     不一致时由 syncLaneSide 写「不一」并把拇指停在第一个数上。 */
  const tv = ln > 0 ? null : trackOne(trackOwnVol(k));
  const shown = ln > 0 ? vol : (tv.one != null ? tv.one : (tv.first != null ? tv.first : 1));
  const rdTxt = ln > 0 ? Math.round(vol * 100) + '%' : (tv.one != null ? Math.round(tv.one * 100) + '%' : '不一');
  return `<button type="button" class="tl-hbtn" data-lane="${k}" data-ln="${ln}" data-lane-act="${ln > 0 ? 'rhide' : 'hide'}"`
    + ` title="${hid ? '展开' : '收起'}${who}（${hid ? '这一行重新长出来，块还挂在原来的行号上' : '只收这一行：块与把手都不画，别的行与另一轨不受影响'}）">${icon(hid ? 'eyeOff' : 'eye', 12)}</button>`
    + `<button type="button" class="tl-hbtn${lock ? ' on' : ''}" data-lane="${k}" data-ln="${ln}" data-lane-act="${ln > 0 ? 'rlock' : 'lock'}"`
    + ` title="${lock ? who + '已锁定：这一行上的块拖不动、剪不了，音量也不调（点一下解锁）' : '锁定' + who + '：锁上之后拖不动、剪不了，免得调隔壁时误改这一行'}">${icon('lock', 12)}</button>`
    + `<button type="button" class="tl-hbtn" data-lane="${k}" data-ln="${ln}" data-lane-act="row+"`
    + ` title="在${who}下面加一行：下面那些行整体往下挪一格，块上的时间与倍速一个字不动">${icon('plus', 11)}</button>`
    + `<input type="range" class="tl-hvol-sl" data-lane="${k}" data-ln="${ln}" min="0" max="200" step="0.1"`
    + ` value="${Math.round(shown * 1000) / 10}" aria-label="${ln > 0 ? nm + '轨第 ' + (ln + 1) + ' 行的音量' : '整条' + nm + '轨的音量'}">`
    + (ln > 0
      ? `<i class="tl-hvol" title="${who}的基数 ${Math.round(vol * 100)}%：这一行上每一${one}都跟着一起${vol < 1 ? '变轻' : vol > 1 ? '变响' : '不变'}，段 / 句自己那枚音量在它之上再乘">${icon('speaker', 10)}<b class="tl-hvol-n">${rdTxt}</b></i>`
      : `<button type="button" class="tl-hvol${laneMute(k) ? ' mut' : ''}" data-lane-mute="${k}"`
        + ` title="点一下把整条${nm}轨${laneMute(k) ? '取消静音' : '静音'}：${laneMute(k) ? '恢复之后每一段 / 每一句回到原来的音量' : '预览与成片这一轨都不出声，每一段 / 每一句的音量原样留着'}；旁边的滑块调整轨音量（现在 ${rdTxt}）">`
        + `${icon(laneMute(k) ? 'speakerOff' : 'speaker', 10)}<b class="tl-hvol-n">${rdTxt}</b></button>`);
}
function laneSideRowHTML(k, ln, blocks) {
  const nm = k === 'voice' ? '配音' : '画面';
  const hid = rowHidden(k, ln);
  const tip = laneNm(k) + '第 ' + (ln + 1) + ' 行：这一行上的块上下拖就能换行；'
    + '眼睛收这一行、锁只锁这一行、＋ 在这一行下面插一行、滑块调这一行的基数音量（与右栏那两枚滑块同一个数）。';
  /* 收起的那一行照样要有这一格（左边窄条 + 右边窄条同高，行号才不会与刻度尺错开）：
     `.hid` 只把滑块、读数、＋、× 藏掉（见 CSS 那一条），名与眼睛、锁留着 —— 否则收起的行再也展不开。 */
  return `<div class="tl-hrow ${k} extra${hid ? ' hid' : ''}" data-ln="${ln}" title="${esc(tip)}">`
    + `<span class="tl-hname">${nm} ${ln + 1}</span>` + laneRowCtlHTML(k, ln)
    /* 每一行（第 2 行往上）各有一颗自己的「×」（用户点名的第 ⑤ 条：多添加出来的轨道要能独立删除）。
       从前这一颗只挂在**空的最后一行**上，于是摆过东西的第 2、3 行永远删不掉。
       删一行不吞内容：这一行的块并到上面那一行，再往下的行补位（判据与回执都在 `dropLaneRow`）。
       第 1 行不画 —— 它是锚行，整条轨至少留一行，收整条轨用轨名旁那颗眼睛。 */
    + `<button type="button" class="tl-hbtn" data-lane="${k}" data-ln="${ln}" data-lane-act="row-"`
    + ` title="删掉${nm}轨第 ${ln + 1} 行${blocks ? '（这一行上有 ' + blocks + ' 个块：它们并到第 ' + ln + ' 行，'
      + '再往下的行往上补一格；入出点、时长、倍速与配音都不动）' : '（这一行是空的，入出点、音量与配音都不动）'}">${icon('minus', 11)}</button>`
    + '</div>';
}
/* 轨名那一格的名字（第 1 行）：四件套由 `laneRowCtlHTML` 出，这里只给名字。
   收行不在锚行这一格 —— 它画在**要收掉的那一行**的标签上（见 laneSideRowHTML 的 `row-`）：
   「−」挂在锚行上指的是最后那一行，而最后那一行离按钮隔着好几行，点的人得先在脑子里换算一次。 */
function laneRowBtnsHTML(k) {
  return `<span class="tl-hname">${k === 'voice' ? '配音' : '画面'}</span>`;
}
function syncLaneSide(col, bar) {
  const side = col && col.querySelector('.tl-side');
  if (!side || !bar) return;
  /* 待生成配音那一行标签是**画完轨道之后**才补的（与 extra 行同一个时机）：
     先摘掉上一趟那一枚，否则每 3 秒整栏重画一次就叠一层。 */
  side.querySelectorAll('.tl-hrow.pend').forEach(x => x.remove());
  ['pic', 'voice'].forEach(k => {
    const anchor = side.querySelector('.tl-hrow.' + k);
    if (!anchor) return;
    const rows = [...bar.querySelectorAll(LANE_ROW_SEL[k])];
    const n = Math.max(1, rows.length);
    /* 每一行上摆了几个块要**现在量**（右栏那一排的节点，不是重算一遍数据 —— 与标签行同一口径）：
       它只进那颗「×」的 title，删行的动作本身不读它（`dropLaneRow` 把块并到上面那一行）。 */
    side.querySelectorAll('.tl-hrow.' + k + '.extra').forEach(x => x.remove());
    let extra = '';
    for (let i = 1; i < n; i++) {
      const el = rows[i];
      extra += laneSideRowHTML(k, i, el ? el.querySelectorAll('.tl-seg, .tl-v').length : 0);
    }
    anchor.insertAdjacentHTML('afterend', extra);
    /* 每一格的「＋/×/眼睛/锁/滑块/读数」在这里**逐行**现量现写（用户点名的第 19 条：
       加出来的那一行也要有这四件事）。标记里那份是画出来那一刻按同一份数据填的初值，
       这里只补两件事：① 按**这一行**的收起/锁定/上限算 disabled 与「为什么按不动」，
       ② 把滑块与读数对齐 `laneVol(k, 这一行)` —— 刚拖完一块到新行、整栏还没重画时，
       那一格的读数要指着它自己那一行的基数，不能还挂着上一次渲染留下的数。
       `addLaneRow` / `dropLaneRow` / `rowFlagToggle` / `setLaneVol` 是同一份判据的落地方，
       按钮只是把它们的拒绝提前显示出来，这里不另判一份。 */
    const nm = laneNm(k);
    side.querySelectorAll('.tl-hrow.' + k).forEach(cell => {
      const ln = cell === anchor ? 0 : laneClamp(cell.dataset.ln);
      const full = n >= TRACK_LANES_MAX, hid = rowHidden(k, ln), lock = rowLocked(k, ln);
      const plus = cell.querySelector('[data-lane-act="row+"]');
      if (plus) {
        plus.disabled = full || hid;
        plus.title = hid ? (ln > 0 ? rowNm(k, ln) + '此刻是收起的，加了也看不见：先点这一行上那颗眼睛展开'
            : nm + '此刻是收起的，加了也看不见：先点旁边那颗眼睛展开')
          : full ? nm + '已经到 ' + n + ' 行，这是上限（再多左边那一列标签自己就要滚起来了）'
            : (ln > 0 ? '在' + rowNm(k, ln) + '下面插一行：下面那些行整体往下挪一格，块上的入出点、倍速、配音与三张按行的表（音量 / 收起 / 锁定）跟着一起挪'
              : '给' + nm + '加一行（挂在最下面）：现在 ' + n + ' 行，块上下拖就能挪过去');
      }
      /* 「×」只有第 1 行不画，其余都能点；只剩一行时（n<=1）压根没有 extra 行。
         收起的那一行删不了（行高 18px，删了看不见）—— 问的是**这一行**收没收，不是整条轨。 */
      const minus = cell.querySelector('[data-lane-act="row-"]');
      if (minus) {
        minus.disabled = hid;
        if (hid) minus.title = rowNm(k, ln) + '是收起的，删了看不见：先点这一行上那颗眼睛展开';
      }
      /* 眼睛与锁**永不 disabled** —— 它们正是「让这一行重新能动、能看见」的那颗出口。 */
      const eye = cell.querySelector('[data-lane-act="rhide"], [data-lane-act="hide"]');
      if (eye) eye.disabled = false;
      const lk = cell.querySelector('[data-lane-act="rlock"], [data-lane-act="lock"]');
      if (lk) {
        lk.disabled = false;
        lk.classList.toggle('on', lock);
        lk.title = lock ? rowLockWhy(k, ln) + '：' + rowUnlockHow(k, ln) + '（点一下解锁）'
          : '锁定' + rowNm(k, ln) + '：锁上之后这一行上的块拖不动、剪不了，这一行的基数音量也不调，'
            + (ln > 0 ? '免得调隔壁时误改这一行（别的行与另一轨不受影响）' : '整条轨每一行都跟着锁');
      }
      const sl = cell.querySelector('.tl-hvol-sl');
      const rd = cell.querySelector('.tl-hvol-n');
      const box = cell.querySelector('.tl-hvol');
      /* 锚行（第 1 行）= **整轨音量**：读数取这一排此刻都同一档时的那一个数，不一致写「不一」；
         extra 行仍是这一行的基数（用户点名的第 19 条，四件套那一半保持原样）。 */
      const tv = ln > 0 ? null : trackOne(trackOwnVol(k));
      const val = ln > 0 ? laneVol(k, ln) : (tv.one != null ? tv.one : (tv.first != null ? tv.first : 1));
      const rdTxt = ln > 0 ? Math.round(val * 100) + '%'
        : (tv.one != null ? Math.round(tv.one * 100) + '%' : '不一');
      if (sl) {
        sl.disabled = lock;
        sl.value = String(Math.round(val * 1000) / 10);
        sl.title = (lock ? rowLockWhy(k, ln) + '：' + rowUnlockHow(k, ln) + '之后才能调。' : '')
          + (ln > 0
            ? rowNm(k, ln) + '的基数音量：与右栏那一枚是同一个数，这一行上每一' + (k === 'voice' ? '句' : '段') + '都跟着一起变'
            : '整条' + nm + '轨的音量：把这一排每一' + (k === 'voice' ? '句' : '段') + '自己的音量都设成这一档'
              + (tv.one == null && tv.kinds > 0 ? '（此刻有 ' + tv.kinds + ' 档，拇指停在第一档上）' : '')
              + '；与右栏那枚「整轨音量」同一个数，段 / 句自己那枚在下面各调各的');
      }
      if (rd) rd.textContent = rdTxt;
      if (box) {
        if (ln > 0) {
          box.title = rowNm(k, ln) + '的基数 ' + Math.round(val * 100) + '%：这一行上每一'
            + (k === 'voice' ? '句' : '段') + '都跟着一起' + (val < 1 ? '变轻' : val > 1 ? '变响' : '不变')
            + '，段 / 句自己那枚音量在它之上再乘';
        } else {
          const mut = laneMute(k);
          box.classList.toggle('mut', mut);
          box.innerHTML = icon(mut ? 'speakerOff' : 'speaker', 10) + '<b class="tl-hvol-n">' + rdTxt + '</b>';
          box.title = '点一下把整条' + nm + '轨' + (mut ? '取消静音' : '静音') + '：'
            + (mut ? '恢复之后每一段 / 每一句回到原来的音量' : '预览与成片这一轨都不出声，每一段 / 每一句的音量原样留着')
            + '；旁边的滑块调整轨音量（现在 ' + rdTxt + '）';
        }
      }
    });
  });
  /* 待生成配音那一行标签排在**配音轨所有行之后**（用户点名：它应该在默认配音轨下方）：
     右边那一排斜纹占位（`.tl-vp-lane`）画了几条，这里就补一行同高的标签，
     两列的插针与刻度尺才不会错开一格。配音轨收起时两边一起不画。 */
  if (!laneHidden('voice')) {
    const pend = bar.querySelectorAll('.tl-vp-lane .tl-vp');
    const last = [].slice.call(side.querySelectorAll('.tl-hrow.voice')).pop();
    if (pend.length && last) last.insertAdjacentHTML('afterend',
      '<div class="tl-hrow pend" title="' + esc(pend.length + ' 句台词还没有合成：轨道上那些斜纹占位就是它们 —— 点一下把那一句填进右栏「生成配音」，并按说话人去素材库取音色描述 / 参考音频') + '">'
      + icon('mic', 10) + '<span class="tl-hname">待生成 ' + pend.length + '</span></div>');
  }
  /* 字幕行标签排在所有行之后（右列画了几条 `.tl-sub-lane`，这里就补一行同高的标签）。 */
  side.querySelectorAll('.tl-hrow.sub').forEach(x => x.remove());
  const subLane = bar.querySelector('.tl-sub-lane');
  if (subLane) {
    const last = [].slice.call(side.querySelectorAll('.tl-hrow')).pop();
    if (last) last.insertAdjacentHTML('afterend',
      '<div class="tl-hrow sub" title="字幕行：块按成片 / 本镜的时间摆，点一下跳到这里；改字在右栏「字幕」">'
      + icon('docTab', 10) + '<span class="tl-hname">字幕</span></div>');
  }
}
function voiceLaneHTML(sh, c, total, g) {
  const segs = c ? segsOf(c, total) : [];
  const G = g || shotFrames(segs);
  const ax = shotAxTotal(G, total);
  const mine = c ? shotVoices(sh.id, c.vid) : [];
  /* 这一排时间基（**轴秒**）上的灰场区间：一句配音压在灰场上时，那几秒**跳过**
     （音频在灰场起点停住、越过整段之后接着放，内容一秒不丢），块顺延拉长、重合处画灰带。
     `voiceRuns` 是唯一的算法；取法收在 `axisGray` 一份（两条轨共用）——
     首屏（这里）与拖动中的重画（bindVoiceLane 的 paintVoice）读同一个数。 */
  const gray = axisGray(G);
  const per = [];
  mine.forEach(v => {
    const si = Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0));
    const s = segs[si], r = G.rows[si];
    if (!s || !r) return;
    /* 与 `filmVoiceHTML` 走同一份折算（`voiceAxBox`）：这一排的格子来自这条候选自己的段。 */
    const bx = voiceAxBox(r, v);
    lanePut(per, v, voiceBlockHTML(v, bx.box, bx.sel, ax,
      '第 ' + (si + 1) + ' 段 +' + round1(bx.fr.fa / bx.spd) + ' 秒起，长 ' + round1(bx.dur) + ' 秒'
        + (bx.fr.fb - bx.fr.fa > bx.dur * bx.spd + 0.02 ? '（这一句共 ' + round1((bx.fr.fb - bx.fr.fa) / bx.spd) + ' 秒，灰掉的不进成片）' : ''),
      { gray }));
  });
  /* 别的镜上锚的、但压进本镜这一段时间里的那些：换算成本镜**轴秒**后画成半透明的只读块。
     取不取得到取决于这一镜在不在成片里（不在成片里的镜头没有框基位置，也就画不出来 ——
     那种情况下界面上不该凭空多一块，画不出来是对的）。
     判据只有两问：**有没有重叠**、**它自己有没有已经在上面画过**（本镜自己的那一句
     在这里会整段落在本镜里，重复画就变成两块叠着）。不再绕第三问。 */
  if (c) {
    const FG = filmFrames(tlSyncFromShots());
    const hereRows = FG.rows.filter(r => r.cl.kind === 'shot' && r.cl.shotId === sh.id);
    if (hereRows.length) {
      const hereFrom = Math.min(...hereRows.map(r => r.start));
      const hereTo = Math.max(...hereRows.map(r => r.start + r.w));
      const drawn = new Set(mine.map(v => v.id));
      voicesEnsure().forEach(v => {
        if (v.shotId === sh.id && v.candId === c.vid) return;        // 本镜自己的，上面画过了
        if (drawn.has(v.id)) return;
        const span = voiceFilmSpan(v);
        if (!span || span.to <= hereFrom + 0.03 || span.from >= hereTo - 0.03) return;
        drawn.add(v.id);
        /* 与本镜那一段重叠的那部分：成片轴秒 → 本镜源秒（frameToSrc），
           再由本镜那一排的 `shotPinT` 换成**本镜轴秒**（两个口径的倍速各折算一次）。 */
        let srcLo = null, srcHi = null;
        for (const r of hereRows) {
          const a = Math.max(span.from, r.start), b = Math.min(span.to, r.start + r.w);
          if (b - a <= 0.03) continue;
          const s1 = frameToSrc(r, a), s2 = frameToSrc(r, b);
          srcLo = srcLo == null ? s1 : Math.min(srcLo, s1);
          srcHi = srcHi == null ? s2 : Math.max(srcHi, s2);
        }
        if (srcLo == null) return;
        const axLo = shotPinT(G, srcLo), axHi = shotPinT(G, srcHi);
        if (axHi - axLo <= 0.03) return;
        const other = allShots().find(x => x.id === v.shotId);
        /* 只读的那一截：框与选区都取「压进本镜的这一片」—— 它在自己那一镜才有真正的框，
           在这里凭空画出一个更宽的框会让人以为能拖。 */
        const w = round1(axHi - axLo);
        lanePut(per, v, voiceBlockHTML(v, { l: round1(axLo), w: w }, { l: round1(axLo), w: w }, ax,
          '这一句锚在「' + ((other && other.name) || '别的镜头') + '」，压到本镜这一排的第 '
          + round1(axLo) + '–' + round1(axHi) + ' 秒 —— 在这里只能试听，要改它请切到它自己那一镜', { spill: true, gray }));
      });
    }
  }
  /* 行数按数据长（最高那一行 + 1），这一轨收起来时只留一行。
     这一镜被落下的孤句在这一排**不画块**（它们锚的是没选用的那条候选，在成片里没有位置 ——
     凭空画一块会让人以为剪完能进成片），但空着的那一行要说清为什么空。 */
  const orph = orphanVoicesOf(sh.id).length;
  return voiceLanesHTML(per, laneHidden('voice') ? 1 : laneRowsFor('voice', per.length),
    orph ? laneNm('voice') + '：这一镜有 ' + orph + ' 句配音挂在没被选用的候选上，进不了成片 —— 右栏点「搬回选用的这一镜」'
      : laneNm('voice') + '：在右栏合成一句配音，它会落在插针指着的那一段');
}
/* 这一条声音行上的交互。`o = { total, film, G }`：
     · total —— 这一排的**时间基总长（轴秒）**。像素↔秒全靠它，
       而它跟画面上那一排是同一个数，所以声音块永远与它所属的那一格对齐；
     · film —— 这一排是全片那一排（按成片秒、格子来自时间线）；不给 = 本镜那一排（格子来自
       这一条候选自己的 `segs`，来自 `G`）；
     · G —— 本镜那一排的轴行表（`shotFrames` 现算的那一份，画格子用的就是它，必须与块同源）。
   两排**只剩「格子从哪来」这一个差别**：倍速折算、灰场、拖动落点、就地重画全走同一份
   （`voiceAxBox` / `axisGray` / `moveVoiceTo`）。以前本镜那一排按候选**源秒**摆、系数恒 1，
   于是拖倍速滑块时画面格缩了而配音块一动不动 —— 用户点名的正是这一件。
   ⚠ 落点那一步只管「**起点**落在哪一格」，**不管尾巴**：配音的尾巴从来不必留在起点那一格内，
     它可以越过格子右沿进后面那一段、下一镜（合成与预览两边都按整句放）。
   三个手势各占一个位置，互不打架：块体 = 移动、左右两条边 = 剪切；
   **单击**（没位移）= 选中 + 试听。删掉这一句不在块上 —— 它在点中之后出现的那根剪辑条上，
   与画面轨一样（块里塞按钮会被 34px 高的行挤成一团，也是「找不到删除按钮」的由来）。 */
const VOICE_MIN = 0.2;                       // 一句配音最短留 0.2 秒
/* 这一次指针动作是「拖动」还是「单击」：**按下时清零、拖过记下是哪一块**，click 读一次就清掉。
   ⚠ 原来是「拖动置位、click 里复位」，那个写法有一个必然卡死的洞：拖**把手**时手指会离开块体，
     松手落在块外，浏览器**不派发 click**（drag 之后 click 只在起落同一个元素上才有），
     于是标志位永远停在 true，接下来真正的单击被当成「刚拖完」吞掉：点块不选中、不试听，
     看着像「点不动了」。
   为什么还要记**是哪一块 + 什么时候**：一个不分归属的布尔值会把「拖了 A 块之后去点 B 块」
   也一起吞掉（那时 B 根本没被拖过）。所以记 vid 与时刻，click 时两样都要对得上才算「刚拖完」。 */
let voiceDragged = false, voiceDragId = '', voiceDragT = 0;
const VOICE_DRAG_MS = 600;                    // 超过这么久还不算「同一次动作的余波」
/* 记下「刚拖过的是哪一块、什么时候」——判据只此一处，块体拖动与两个把手剪切都走它。 */
function markVoiceDrag(id) { voiceDragged = true; voiceDragId = id || ''; voiceDragT = Date.now(); }
/* 「这一下 click 是不是刚才那次拖动的余波」：同一块 + 时限内才算。 */
function voiceWasDragged(id) {
  if (!voiceDragged) return false;
  const same = voiceDragId === id;
  const fresh = (Date.now() - voiceDragT) <= VOICE_DRAG_MS;
  voiceDragged = false; voiceDragId = '';
  return same && fresh;
}
function bindVoiceLane(row, o) {
  const opt = o || {};
  const total = Math.max(0.1, Number(opt.total) || 0);
  /* 这一排的轴行表：全片来自时间线（现算，格子可能刚被别的镜改过），本镜来自画格子那一份 `G`。
     两者必须与首屏渲染用的是同一套行 —— 否则「首屏按轴、拖动中按源」，倍速那一格上拖一下块会跳。 */
  const shotG = opt.film ? null : (opt.G || { rows: [], total: Math.max(0.05, total) });
  const frames = () => (opt.film ? filmFrames(tlSyncFromShots()) : shotG);
  /* 拖动中的重画只改这一个块：框的 left/width（只有挪位置才变）+ 框内那两块灰的宽度
     （剪切变的是它们，块的左右沿一个字都不动）。
     不重画整栏 —— 那会把手指底下的节点销毁，也会连带把整排切片重贴一遍。 */
  /* 这一句所属的那一格：本镜按段号取行，全片按「镜头 + 候选 + 段」三样取行。
     ⚠ 首屏渲染与拖动中的重画必须同源：本镜这一支以前直接返回 `v.at`，而渲染用的是 `s.in + v.at`，
     段被向左切过（s.in > 0）之后两个算式差一个 `s.in`，拖把手时的重画位置与首屏对不上 ——
     看着就成了「左边也在动、长度也在变」（用户报的「不是覆盖左右而是整体缩放」）。
     现在两排都只走 `voiceAxBox` 那一份算式（它的 base 就是「那一格的轴起点 + 画面选区左沿」），
     所以这里只负责**找对那一行**，不再各拼一份位置。 */
  const voiceRowOf = v => {
    const si = Math.max(0, Number(v.seg) || 0);
    const rows = frames().rows || [];
    return (opt.film
      ? rows.find(x => x.cl && x.cl.kind === 'shot' && x.cl.shotId === v.shotId && x.cl.candId === v.candId
        && (Number(x.cl.seg) || 0) === si)
      : rows.find(x => Number(x.i) === si)) || null;
  };
  /* 块上量的那几样（`fa/fb/at/dur`）都是**音频 / 源秒**，摆到轴上要按所属那一格的倍速折算；
     两个方向都要：摆上去除（`voiceAxBox`），从像素位移回到数据要乘（把手那边用 `voiceSpdOf`）。 */
  const voiceSpdOf = v => { const r = voiceRowOf(v); return r ? r.spd : 1; };
  /* 全片那一排：位移到别的格子上时连镜头/候选/段一起换掉 ——
     于是可以把一句话从这一镜挪到那一镜（数据里 voice 本来就带 shotId/candId/seg，
     与剪映在同一条时间线上拖音频是一回事）。落在黑场格（或插入的素材格）上就原地不动、返回 false。
     本镜那一排同一份代码：那里换不到别的镜，只是换段（同一条候选切出来的几段）。
     `tAx` = 拖动手势的落点，按**框左沿**在这一排的轴上量（块体按住的正是框左沿那一带）。 */
  const moveVoiceTo = (v, tAx) => {
    const rows = frames().rows || [];
    if (!rows.length) return false;
    let hit = rows[rows.length - 1];
    for (const r of rows) { if (tAx < r.start + r.w) { hit = r; break; } }
    if (opt.film && (!hit.cl || hit.cl.kind !== 'shot')) return false;
    const fr = voiceFrameOf(v), selOff = Math.max(0, Number(v.at) || 0) - fr.fa;   // 选区相对框左沿，拖动中不变
    /* 落点 → 源秒走 frameToSrc（轴秒 × 这一格的倍速）：以前本镜那一排没有这一道（源秒当轴秒用），
       全片那一排写的是 `hit.a + (tFrame - hit.start)`，都只在「一格 1 倍速」时对得上 ——
       2 倍速时块会停在指针左边一截。 */
    const tSrc = frameToSrc(hit, tAx);
    const segIn = rowSelIn(hit), keep = Math.max(0.05, rowSelOut(hit) - segIn);
    if (opt.film) { v.shotId = hit.cl.shotId; v.candId = hit.cl.candId; v.seg = Number(hit.cl.seg) || 0; }
    else v.seg = Number(hit.i) || 0;
    /* 只夹**选区起点**（它必须留在这一格里 —— `seg` 的归属凭据就是这一个数，`clipVoices` 按
       「起点还在不在这一段」判孤儿），**尾巴放开**：可以越到后面那一格、下一镜（用户点名的
       「音频不能跨越不同视频片段」）。以前上界是 `keep - selOff - dur`，于是「3 秒的格子配一句
       6 秒的台词」被硬按在段首附近，往右一拖就停 —— 而合成那一边现在也按这个口径放开了
       （代理 `room` = 本句时长并夹到片尾），预览与成片听的是同一句。
       拖动中途不量化，见 `roundVoice`。 */
    v.fa = Math.max(0, Math.min(tSrc - segIn, Math.max(0, keep - selOff)));
    v.fb = v.fa + (fr.fb - fr.fa);
    v.at = v.fa + selOff;
    return true;
  };
  /* 就地重画一块：框的 left/width + 框内两块灰的宽度 + 灰带 + 顺延后的标签。
     `put` 只在「这一截有宽度」时才补节点，没有就把已有的压成 0%（摘掉节点会让下一次
     又要插入，而插入位置靠 afterbegin —— 两块灰的先后顺序会翻）。 */
  const paintVoice = v => {
    const el = row.querySelector('.tl-v[data-vid="' + v.id + '"]');
    const r = voiceRowOf(v);
    if (!el || !r) return;
    /* 与首屏（`voiceLaneHTML` / `filmVoiceHTML`）同一个 `voiceAxBox`：块、选区、灰场
       全在这一排的轴秒上量 —— 拖动中若退回源秒，倍速那一格里松手会跳位。 */
    const bx = voiceAxBox(r, v);
    /* 灰场按**这一排自己的尺子**取（与首屏 voiceBlockHTML 的 `opt.gray` 同源）：
       拖块 / 拖把手改的正是「它压不压在灰场上」，拉长与灰带要跟着手指当场重画 ——
       少了这一段，拖动中块不加长、不画带，松手一整栏重画才跳到位。 */
    const gray = axisGray(frames());
    const lay = voiceRuns(bx.sel.l, bx.sel.w, gray);
    const boxL = bx.box.l;
    const right = Math.max(boxL + bx.box.w, lay.end);
    const w = Math.max(0.05, right - boxL);
    el.style.left = pct(boxL, total) + '%';
    /* 左沿与宽度都摆到这一排的尺子上（`bx` 已经除过倍速），而框内两块灰 / 灰带算的是**块内比例**
       （分子分母同为这一排的秒，倍速约掉了）—— 两处不同尺子，漏一处就是
       「首屏按轴、拖动中按源」，2 倍速那一格上拖一下块会跳。 */
    el.style.width = pct(w, total) + '%';
    /* 两块灰与灰带共用这一个 `put`，分母是**拉长后**的块宽 `w`（与 voiceBlockHTML 同一算式）——
       用拉长前的框宽当分母会把它们画错宽度（块越长错得越多）。 */
    const put = (sel, sec, cls) => {
      const wp = pct(sec, w) + '%';
      const n = el.querySelector(sel);
      if (n) n.style.width = wp;
      else if (sec > 0.02) el.insertAdjacentHTML('afterbegin', '<span class="' + cls + '" style="width:' + wp + '"></span>');
    };
    put('.vo-off:not(.r)', bx.sel.l - boxL, 'vo-off');
    put('.vo-off.r', Math.max(0, right - Math.max(bx.sel.l + bx.sel.w, lay.end)), 'vo-off r');
    /* 灰带整批重建：拖动中压上的灰场条数会变（挪一下可能就压上了、再挪又不压），
       逐条对号入座不如推倒重来；`pointer-events:none`，不碍下面那两颗把手。 */
    el.querySelectorAll('.vo-skip').forEach(n => n.remove());
    (lay.skips || []).forEach(b => {
      if (b[1] - b[0] <= 0.02) return;
      el.insertAdjacentHTML('afterbegin', '<span class="vo-skip" style="left:' + pct(b[0] - boxL, w)
        + '%;width:' + pct(b[1] - b[0], w) + '%"></span>');
    });
    el.classList.toggle('over', (lay.skips || []).length > 0);
    /* 块上那行小字的秒数也跟着走：以前拖动中只改位置与两块灰，那句「· 3.2s」还是加进来时的数 ——
       剪完长度那行字不认，看着像「改了个样子，其实什么都没改」。
       数的是「这一句在**成片里**念几秒」（`voiceRuns` 的 `filmSec`，与 voiceBlockHTML 的 `shownSec` 同源）：
       块在轨道上拉长的是占位，压到剪掉的头 / 尾那几秒并不进成片，读数不能跟着涨。 */
    const lab = el.querySelector('.vt');
    if (lab) lab.textContent = voiceBlockText(v, lay.filmSec);
  };
  /* 拖动的统一骨架：按下 → 记起点与「拖动前的那一份数据」→ 移动按位移改数据并只重画这一块 →
     松手才落盘。三个手势（移动 / 左剪切 / 右剪切）共用它，区别只在 move 里怎么改。
     `skipHandles` 只有「拖块体」那一路才传 true：落在把手 / 音量条上的按下不算拖块体。
     以前这一层判定写在别处（一个空的 pointerdown 监听 + 回调里再判一次），而把手那边虽然
     `stopPropagation` 过，判定位置与事件传播并不一致 —— 于是拖把手时块体那一路也跟着跑。
     现在**只有一个判据、一个位置**（就在这里），与事件怎么冒泡无关。 */
  const bindDrag = (el, start, skipHandles) => {
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      /* `.spill` = 别的镜上溢出进来、只读的那一截：不给它拖/剪/调音量（它锚在别的镜的候选上，
         本镜这一排的行表里没有它那一行，拖了会拿错段长与上界）。只留试听。 */
      if (el.classList.contains('spill')) return;
      /* 锁问的是**这一块自己那一行**（整条轨锁着时每一行都锁）：锁了第 2 行，第 1 行的句子照样能拖。 */
      const dLn = laneClamp(Number((el.closest('.tl-lane') || row).dataset.ln) || 0);
      if (rowLocked('voice', dLn)) {
        /* 锁住这一行：手势一个都不接，但要说清为什么接不上（否则看着像「拖不动」的 bug） */
        e.preventDefault(); e.stopPropagation();
        setStatus('<span class="err">' + rowLockWhy('voice', dLn) + '：' + rowUnlockHow('voice', dLn)
          + '后才能拖、能剪（点一下仍可选中，不会自动播放）</span>');
        return;
      }
      if (skipHandles && e.target && e.target.closest && e.target.closest('.vo-cut')) return;
      /* 每一次按下都是「一次新动作」：先把「拖过」清掉（见上面 voiceDragged 那段的理由 ——
         复位挂在 click 上会漏掉「拖把手后在块外松手」那一种，那时浏览器不派发 click）。 */
      voiceDragged = false; voiceDragId = '';
      e.preventDefault(); e.stopPropagation();
      const lane = el.closest('.tl-lane') || row;
      const laneW = Math.max(1, lane.getBoundingClientRect().width);
      const secPerPx = total / laneW;
      start(e, secPerPx);
    });
  };

  /* ① 单击 = 选中。**拖过的那一下不算单击**（余波判据见 voiceWasDragged）——
     选中这一下是**三件事同一入口**：块高亮（`.sel`）、上面那排剪辑条换到这一句、
     条上的音量读数跟着变。三件事各做各的就会出现「按钮出现了但删的是另一句」
     —— 所以统一走 selectVoice。**不自动试听**（用户点名的第 ⑤ 条）：点一下块只是选中，
     要听走剪辑条那颗「试听」—— 否则每次点中一句都从它自己的 off 起播，用户还以为在播画面。 */
  row.querySelectorAll('.tl-v').forEach(el => {
    el.addEventListener('click', e => {
      if (voiceWasDragged(el.dataset.vid)) return;
      if (e.target.closest('.vo-cut')) return;
      /* 只读的那一截（别的镜溢出进来的）：不抢选中 —— 它在自己那一镜里才是可编辑的，
         这里选中会出现「剪辑条明明在、点删掉却删了别的镜上那一句」。
         但点它**不是死路**：把焦点跳到它自己那一镜，跳过去之后这一句就能拖能剪了
         （用户点名的「音轨无法跨越不同镜头」，缺的就是这一条出路）。 */
      if (el.classList.contains('spill')) {
        const vv = voicesEnsure().find(x => x.id === el.dataset.vid);
        if (vv) focusVoiceShot(vv);
        return;
      }
      selectVoice(el.dataset.vid);
    });
  });
  /* ② 拖块体 = 挪位置（**整框**平移，框与选区的相对关系不变）。
     两排同一份 `moveVoiceTo`：本镜那一排按落点换段（同一条候选切出来的），
     全片那一排按落点换镜/换候选/换段。两边都只夹「起点」，
     尾巴越到后面那一格不算挪动失败 —— 见上面 `o = { total, film, G }` 那一段。 */
  row.querySelectorAll('.tl-v').forEach(el => {
    /* 第三参 true = 落在把手 / 音量条上的按下不启动「拖块体」（判据只此一处，见 bindDrag） */
    bindDrag(el, (e, secPerPx) => {
      const v = voicesEnsure().find(x => x.id === el.dataset.vid);
      const r0 = v && voiceRowOf(v);
      if (!v || !r0) return;
      const x0 = e.clientX;
      /* 框左沿在**这一排的轴**上的位置（拖动前）：位移按像素×秒/px 直接加在它上面，
         落点再由 `moveVoiceTo` 折回源秒 —— 倍速在两处各折算一次，中途不碰数据以外的尺子。 */
      const tAx0 = voiceAxBox(r0, v).box.l;
      let moved = 0;
      /* 上下拖 = 换行（`v.ln`）。行距不能写死 38：轨道收起时那一行是 18px，
         写死的话在收起的状态下拖一下会跳两行。量的是**这一行自己的高度 + 行间距**。 */
      const y0 = e.clientY;
      const laneStep = (() => {
        const h = row.getBoundingClientRect().height || 38;
        const cs = row.parentElement ? getComputedStyle(row.parentElement) : null;
        const gap = Number.parseFloat((cs && cs.rowGap) || '20') || 20;
        return Math.max(12, h + gap);
      })();
      const ln0 = voiceLn(v);
      let lnWant = ln0;
      /* 松手那句回执要说真话：按下前把「这一趟可能改的那几个数」抄一份，并记下落点有没有被挡回去。
         两种「一个数都没改」：① 落点那一格压根不是镜头的一段（片头黑场 / 插入的素材 —— 配音的锚点是
         shotId/candId/seg 三样，那一格没有这三样，`moveVoiceTo` 只能返回 false）；② 绕了一圈回到原位。
         原来 `up` 两种都照样打一句「✓ 这一句挪到了「甲镜」第 1 段的 +0.4 秒」—— 那句 ✓ 指着的是**原地**，
         于是界面承诺了一件没发生的事（本项目反复拦的那一类：要么实现、要么改文案）。
         ⚠ 「画面被删掉的那一格」（段上的 `off:1` → clip `gray:1`）**不在被拒之列**：它的 kind 仍是 shot、
         in/out 与时长一个字没动，所以配音照样挂得住 —— 那正是「黑屏配旁白」，也是 `underGray` 那句
         「这一段画面删掉了…成片里出 X 秒黑场」默认的组合。 */
      const snapVoice = () => JSON.stringify([v.shotId, v.candId, v.seg == null ? 0 : v.seg, v.at, v.fa, v.dur, voiceLn(v)]);
      const snap0 = snapVoice();
      let blocked = '';
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        /* 第一位移出阈值就出那张跟手的小卡（与画面格那一路同一个手势语言，第 ⑧ 条）：
           配音块上放的是它自己的波形，横拖挪位置与竖拖换行都算「正在拖这一句」。 */
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          if (!moved) dragGhostShow(ev, el, (el.querySelector('.vt') || {}).textContent);
          else dragGhostMove(ev);
          moved = 1; markVoiceDrag(el.dataset.vid);
        }
        /* 换行的意图只在**竖直位移更大**时成立：横向拖动时手指难免上下偏一点，
           那时按横向为准（否则挪一下位置就串到别的行上去了）。 */
        if (Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx)) {
          lnWant = laneClamp(ln0 + Math.round(dy / laneStep));
          el.style.transform = 'translateY(' + round1((lnWant - ln0) * laneStep) + 'px)';
        }
        if (dy && Math.abs(dy) >= Math.abs(dx)) { paintVoice(v); return; }
        /* 位移与落点都在**这一排的轴秒**上量，源秒、段归属、夹取全在 `moveVoiceTo` 一份里 */
        blocked = moveVoiceTo(v, tAx0 + dx * secPerPx) ? '' : 'black';
        if (blocked) return;
        paintVoice(v);
      };
      const up = () => {
        dragGhostHide();
        if (!moved) { el.style.transform = ''; return; }
        const lnChanged = lnWant !== ln0;
        if (lnChanged) v.ln = lnWant;
        el.style.transform = '';
        roundVoice(v);
        /* 一个数都没改 → 不许打「✓ 挪到了」：要么落点是黑场格（那里挂不住配音），要么绕回原位。
           两种都照实说一句，并把重画存档那一步跳过去（一个数都没变，凭什么惊动界面与存盘）。 */
        if (snapVoice() === snap0) {
          setStatus(blocked
            ? '<span class="warn">那一格不是镜头画面（黑场或插入的素材），一句配音只能挂在镜头的某一段上 —— 拖到有画面的那一格再松手</span>'
            : '<span class="info">这一句拖回了原位，位置和归属都没变</span>');
          return;
        }
        const sh2 = allShots().find(x => x.id === v.shotId);
        setStatus('<span class="ok">✓ 这一句挪到了「' + esc((sh2 && sh2.name) || '镜头') + '」第 '
          + ((Number(v.seg) || 0) + 1) + ' 段的 +' + round1(v.at) + ' 秒'
          + (lnChanged ? '（' + laneNm('voice') + '第 ' + (lnWant + 1) + ' 行）' : '') + '</span>');
        filmEdited();
      };
      dragOnWindow(move, up);
    }, true);
  });
  /* ③ 拖左边缘 = 把这一句的**开头**盖掉，④ 拖右边缘 = 盖掉**结尾**。
     与画面轨同一套几何：**框 [fa,fb] 不动**（块在轨道上不缩不挪），拖的是框内那两块灰 ——
     左边那块变宽就是「这一段音频不进成片」，右边那块同理。
     以前这两个把手直接把块缩窄/平移（`v.at` 与 `v.dur` 一起改、框不存在），
     于是看起来是「整块被压扁」而不是「左边/右边被盖掉」（用户点名的那一条）。
     ⚠ `off`（音频文件内部的起点）跟着选区起点走：合成时它是配音输入的 -ss，
       播放时它是 Audio.currentTime 的起点 —— 三处口径必须一致，见 clipVoices / renderJob / TlPlay。 */
  row.querySelectorAll('[data-vcut]').forEach(g => {
    bindDrag(g, (e, secPerPx) => {
      const v = voicesEnsure().find(x => x.id === g.getAttribute('data-vcut'));
      const r0 = v && voiceRowOf(v);
      if (!v || !r0) return;
      /* 音频本身有多长：右把手不能拖到音频没有内容的地方。没量过就先量一次（异步，
         量到就存在这一句上，下次直接用） */
      if (!(Number(v.srcDur) > 0) && v.src && !v._measuring) {
        v._measuring = 1;
        audioDurOf(v.src).then(d => { if (d > 0) v.srcDur = d; }).catch(() => {});
      }
      const x0 = e.clientX;
      const edge = g.getAttribute('data-edge');
      const fr = voiceFrameOf(v);
      /* `v.at / fr` 在源秒上量，`v.dur / v.off` 在音频文件秒上量 —— 把手上每一处
         夹取与换算都要先统一：内容秒差 Δ 源秒 ↔ 音频秒差 Δ×own（自己那一档）。
         忘了这一道，×1.5 的那一句左把手拖到料头就顶住、右把手拖着的量与写下的数差一半。 */
      const own = voiceRateOf(v);
      const at0 = Math.max(0, Number(v.at) || 0);
      const dur0 = Math.max(VOICE_MIN, Number(v.dur) || 0);
      const off0 = Math.max(0, Number(v.off) || 0);
      let moved = 0;
      /* 手里握着哪一根，那一根就加粗发光（与画面轨那两根同一个 `.act`）。
         排在 `if (!v || !r0) return` 之后：认不出这一句时 `dragOnWindow` 根本不会跑，
         起手就加粗会留下一根永远亮着的把手。 */
      g.classList.add('act');
      const move = ev => {
        const dx = ev.clientX - x0;
        if (Math.abs(dx) > 3) { moved = 1; markVoiceDrag(v.id); }
        const raw = dx * secPerPx * voiceSpdOf(v);
        if (edge === 'l') {
          /* 选区起点 = 框左沿 + 已切掉的秒数，两头夹住：
             · 往左退不出框（`fa`），也退不到音频第 0 秒之前（`off` 不能变负）；
             · 往右不能把选区压到 VOICE_MIN 以下。
             框、块的左右沿、别的块 —— 一个字节都不动。 */
          const na = Math.max(Math.max(fr.fa, at0 - off0 / own), Math.min(at0 + raw, at0 + (dur0 - VOICE_MIN) / own));
          const d = (na - at0) * own;
          v.at = na;
          v.dur = dur0 - d;
          v.off = off0 + d;
        } else {
          /* 选区终点：往左拖 = 把结尾盖掉（框不动，右边那块灰变宽）；往右拖 = 放回来。
             上界取「框右沿」与「音频尽头」里更宽的那一头 —— 正常一句配音在加进来时
             框就等于整条音频，两者相同；只有老数据 / 导入时按更短的长度截过，
             才允许把框向右推一推（音频块不像画面格，它没有邻居要避让）。
             ⚠ 这一头**不受所在那一段的长度限制**：尾巴越过格子右沿就是「跨到后面那一段/那一镜」，
               合成侧（代理 `room`）与预览（`TlPlay.startVoices`）现在都按整句放。 */
          const content = Number(v.srcDur) > 0 ? Math.max(VOICE_MIN, Number(v.srcDur) - off0) : dur0;
          const lim = Math.max(fr.fb, at0 + content / own);
          const ne = Math.max(at0 + VOICE_MIN / own, Math.min(at0 + dur0 / own + raw, lim));
          v.dur = (ne - at0) * own;
          if (ne > fr.fb) v.fb = ne;
        }
        paintVoice(v);
      };
      const up = () => {
        g.classList.remove('act');
        if (!moved) return;
        roundVoice(v);
        const cut = Math.max(0, (Number(v.at) || 0) - fr.fa) + Math.max(0, fr.fb - ((Number(v.at) || 0) + Number(v.dur || 0) / own));
        setStatus('<span class="ok">✓ 这一句现在从音频第 ' + round1(v.off || 0) + ' 秒起、长 ' + round1(v.dur || 0) + ' 秒'
          + (cut > 0.05 ? '（这一段里有 ' + round1(cut) + ' 秒被盖掉，不进成片）' : '') + '</span>');
        filmEdited();
      };
      dragOnWindow(move, up);
    });
  });
  /* 音量不在块上、删除也不在块上：那一排剪子共用轨道**上面**一根，音量共用右栏那张卡（见 setCutVol / runCut）。
     块底那条可拖的横条已删 —— 它是音量的第二个出口，还把鼠标扫过音轨变成「调整」光标，
     而那块地方本来是「挪位置 / 试听」。 */
}

/* 选中一句配音：块高亮 + 上面那排剪辑条换到这一句（本镜与全片两排的块一起高亮，
   否则同一句话在两处都看得到、却只有一处亮着）。
   这里同时把**目标**换成配音 —— 目标是「最后点的那一轨」，不是「有没有还留着选中的配音」，
   否则点了画面格之后剪刀与滑块仍会落到上一句配音上（用户报的「优先删除语音」）。 */
/* 把「现在哪一句该亮」就地写回两排的所有块上 —— 判据只有 `voiceSelId()` 一份。
   换目标的三条路（点一格画面 / 点轨道空白 / 删掉这一句）都要走它：整栏重画只是其中一条，
   就地那一下不重画，于是留着上一句的亮环对着一个已经指向画面的剪子。 */
function paintVoiceSel() {
  const id = voiceSelId();
  document.querySelectorAll('.tl-v[data-vid]').forEach(x => x.classList.toggle('sel',
    x.dataset.vid === id && !x.classList.contains('spill')));
}
/* 画面那一排的亮环就地收掉 —— 只在「目标已经不是画面轨」时起作用，所以它是**只收不画**：
   该亮哪一格要问段清单（本镜那一排）或行号（全片那一排），那是 `paintSegFocus` / 两处 cellHTML /
   `filmApplyAt` 各自的路；而「点了一句配音」这一一下只需要一件事 —— 上面那一格也别亮。
   两排同时高亮 = 看不出剪子究竟在哪一轨（用户点名的「上下的画面片段和配音片段都高光」）。 */
function dropPicSel() {
  if (picSelOn()) return;
  document.querySelectorAll('#tlBar .tl-seg.sel').forEach(x => x.classList.remove('sel'));
}
function selectVoice(id) {
  proj.curVoice = id || '';
  proj.tlLane = id ? 'voice' : 'pic';
  /* 点中轨上一句 = 用户要看/调这一句（用户点名的第 ③ 条那三格里最直接的一格）；
     显隐仍由 paintTlGroups 一处翻，这里只落一个状态。 */
  if (id) vcTab = 'adj';
  paintVoiceSel();
  dropPicSel();
  syncTlTools();
  scheduleSave();
}

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
  /* 直读 localStorage（导演台没有别处那个 readLS 助手，那是生成工作台/设置页自己的）。
     这一处**必须**在 try 里：隐私模式下 getItem 会抛，而这一行在页面装配期执行 ——
     抛出去整页就白屏了（探针 ① 就是这么抓到 readLS 未定义的）。 */
  try { const v = Number(localStorage.getItem('dir_tl_pps') || ''); return v > 0 ? v : 0; } catch (e) { return 0; }
})();
/* 现在生效的像素/秒：手动缩过就按那一档（夹在 `tlMinPps(总长)`～`TL_MAX_ZOOM`），
   没缩过就是「自适应」= 容器多宽铺多满，但不低于 `TL_MIN_PPS`。 */
function tlCurrentPps(total, barEl) {
  const T = Math.max(0.1, Number(total) || 0);
  if (tlPps) return Math.max(tlMinPps(T), Math.min(TL_MAX_ZOOM, tlPps));
  const avail = (barEl && barEl.clientWidth) ? barEl.clientWidth : 0;
  const fit = avail > 0 ? avail / T : 0;
  return Math.max(TL_MIN_PPS, fit || TL_MIN_PPS);
}
/* 内容层的宽度 = 总时长 × 像素/秒，**一个都不再多撑**：
   缩到比轨道短就是比轨道短（右边那段空白是这一档存在的理由）。 */
const tlInnerWidth = (total, pps) => Math.max(1, Math.round(Math.max(0.1, Number(total) || 0) * (Number(pps) || 0)));
/* 读数别用 `Math.round`：不到 1px/秒时它会说「0 px/秒」，而那一排明明还在画。按数量级给小数。 */
const tlPpsText = p => (p >= 10 ? String(Math.round(p)) : p >= 1 ? (Math.round(p * 10) / 10).toFixed(1) : (Math.round(p * 100) / 100).toFixed(2));
/* 缩放时想保持在视野中心的那一秒（重画之后用它把滚动位置放回去）—— -1 = 不还原 */
let tlAnchorT = -1;
/* 这一轮重画要还原的滚动偏移（整列每 3 秒重建一次，不还原的话每 3 秒都会被弹回最左边） */
let tlScrollWant = -1;

/* 刻度尺：给一条时间基（本镜 = 这一排的轴秒，全片 = 成片秒）画若干道线 + 秒数。
   两排都是「框 ÷ 倍速」之后的那把尺子，不是源秒 —— 递进来的 `total` 由调用方按页签现算
   （`shotAxTotal` / `filmFrames().total`），所以倍速一变刻度跟着变密或变疏，一格都不用改这里。
   档位要吃两头的约束，别只顾一头：
     · 像素那一头 —— 每档至少 ~56px，否则标签会叠在一起；
     · 档数那一头 —— 至少 4 档（3 秒的短镜头也得看得见刻度）、最多 12 档。
   以前只按「≤10 档」挑，缩放到很宽时每档会拉开到几百像素（一条刻度孤零零挂在中间）。 */
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 2.5, 5, 10, 15, 30, 60, 120, 300];
function rulerStep(total, pps) {
  const T = Math.max(0.1, Number(total) || 0);
  const byPx = RULER_STEPS.find(x => x * pps >= 56) || RULER_STEPS[RULER_STEPS.length - 1];
  const byCount = RULER_STEPS.slice().reverse().find(x => T / x >= 4) || RULER_STEPS[0];
  return Math.max(Math.min(byPx, byCount), T / 12);       // 再夹一道「不超过 12 档」
}
/* 主档之外再算一次次档（照参考项目：minorStep = majorStep / 4）。
   但**只有画得开才画** —— 一格 15px 时四道次档会把主档那根通高线淹了，
   所以按「次档间距 ≥ 14px」现判，画不开就回 0（这一档整条不画，不是画了再藏）。 */
function rulerScale(total, pps) {
  const major = rulerStep(Math.max(0.1, Number(total) || 0), pps);
  const minor = major / 4;
  return { major, minor: (minor * (Number(pps) || 0) >= 14) ? minor : 0 };
}
/* 秒数的写法：整秒不带小数点，其余保留一位（0.5 / 1.5 / 12） */
const rulerText = t => (Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : String(Math.round(t * 10) / 10)) + 's';
function rulerHTML(total, pps) {
  const T = Math.max(0.1, Number(total) || 0);
  const sc = rulerScale(T, pps);
  const step = sc.minor || sc.major;                 // 有次档就按次档走一遍（主档在其中挑出来打标）
  /* 缩到比整条轨道还短是现在允许的（用户点名取消下限），于是「主档只值两三个像素」这种档位真会出现。
     那时标签必然叠成一坨 —— **只画线、不写字**，最左那一档照样写 0（不写就看不出这条从哪儿起）。 */
  const labelOk = sc.major * (Number(pps) || 0) >= 34;
  const n = Math.max(1, Math.floor(T / step + 1e-6));
  /* 尺也照下面那两行轨道补到**看得见的那一段**（用户点名「时间轴下没有画面或配音的地方照样应该有时间段」）：
     轨道比整条短时，右边那一大片从前只有尺底下的空白 —— 线只画到 100% 那一头。
     延长那几道**只画线、不写秒数**：越过总长之后的每一个数都是编的（这一段压根不在成片里），
     而画暗一点是那句「这里没有内容」的一部分，与轨道里那两块被剪掉的灰同一个立场。
     `dx` 按**像素**递出去而不是百分比 —— `pct()` 钳在 0–100，拿它算超过总长的落点会全挤在最右那一根上。 */
  const barEl = document.getElementById('tlBar');
  const avail = barEl ? (barEl.clientWidth || 0) : 0;
  const extPx = Math.max(0, avail - tlInnerWidth(T, pps));
  let h = '<div class="tl-ruler">';
  for (let k = 0; k <= n; k++) {
    const t = Math.round(Math.min(T, k * step) * 100) / 100;
    /* 「是不是主档」按**除法取整**判，不拿浮点数比相等：0.1×3 = 0.30000000000000004，
       比 `t % major === 0` 会让整除的那些档全变成次档（一条线都没有标签）。 */
    const mj = Math.abs(t / sc.major - Math.round(t / sc.major)) < 1e-6;
    /* 恰好落在最右那一档（总时长是档位的整数倍时会有）：标签改挂线左边，
       否则它伸出内容层，多出来一条几像素的横向滚动。 */
    const end = mj && t >= T - 1e-6;
    h += '<span class="tk' + (mj ? ' mj' : '') + (end && labelOk ? ' te' : '') + '" style="left:' + pct(t, T) + '%">'
      + (mj && (labelOk || k === 0) ? '<span class="tkl">' + rulerText(t) + '</span>' : '') + '</span>';
  }
  const p = Number(pps) || 0;
  for (let t = T + step; p > 0 && (t - T) * p <= extPx; t += step) {
    h += '<span class="tk' + (Math.abs(t / sc.major - Math.round(t / sc.major)) < 1e-6 ? ' mj' : '') + ' xt" style="left:calc(100% + '
      + Math.round((t - T) * p) + 'px)"></span>';
  }
  return h + '</div>';
}
/* 把这一页签的比例尺落到内容层上，并放回该在的滚动位置（顺序：先宽、后滚） */
function tlApplyScale(bar, total) {
  const inner = bar.querySelector('#tlInner');
  if (!inner) return;
  const pps = tlCurrentPps(total, bar);
  inner.style.width = tlInnerWidth(total, pps) + 'px';
  /* 把主档那一档有多宽交给淡尺（刻度尺算出来的同一个主档）：`.tl-bar` 打底那一层与
     画面行 `::before` 那一份读的都是**同一个 `--tl-step-px`**，所以「尺上的线」「轨道里的淡竖线」
     「空白处那几条」是同一个落点 —— 写成百分比时行内那一份量的其实是父级宽度，
     换成像素之后两处共用一个数，行宽与内容层宽不一致（缩到比整条短）也不再各漂一处。
     缩到极小（一道淡尺不到 8 像素）时**整条不画**：那时竖线挤成一团脏灰，
     比没有更难看，而且这一档本来也读不出「占几秒」。用一个不可能撞上的大数表达「不画」。 */
  const Tsc = Math.max(0.1, Number(total) || 0.1);
  const mj = Number(rulerScale(Tsc, pps).major) || 0;
  bar.style.setProperty('--tl-step-px', (mj * pps >= 8 ? Math.round(mj * pps * 100) / 100 : 100000) + 'px');
  const val = document.getElementById('tlZoomVal');
  if (val) {
    val.textContent = tlPps ? (tlPpsText(pps) + ' px/秒') : '自适应';
    /* 手动档时这一点读数就是「回到自适应」那颗出口（见 tlZoomAuto）；
       已经在自适应时不划虚线也不给手型 —— 点它什么都不会发生，那就不能看着像能点。
       title 留空串 = 让浏览器退回外面那一层 `.tl-zoom` 的说明。 */
    val.classList.toggle('man', !!tlPps);
    /* 「比轨道宽、要左右滚」与「只占轨道一段」是这一档最直观的两件事，写给用户看之前先确认量得出：
       容器还没排好时 `clientWidth` 是 0，那时两种都不说。 */
    const avail = bar.clientWidth || 0;
    val.title = tlPps ? ('点一下回到「自适应」（现在按 ' + tlPpsText(pps) + ' 像素/秒'
      + (avail ? (tlInnerWidth(total, pps) > avail ? '，整条比轨道宽、要左右滚' : '，整条只占轨道的一段') : '') + '）') : '';
  }
  if (tlAnchorT >= 0) {
    bar.scrollLeft = Math.max(0, tlAnchorT * pps - bar.clientWidth / 2);
    tlAnchorT = -1;
  } else if (tlScrollWant >= 0) {
    bar.scrollLeft = tlScrollWant;
    tlScrollWant = -1;
  }
}
/* 缩放要改的只有两样：`#tlBar` 里那一排的排版，和外面那枚读数（`tlApplyScale` 顺手写的）。
   以前这两处调的是 `renderMid()` —— 那是 `col.innerHTML = …` 整列替换，于是顺手做坏三件事：
   · 候选缩略图换成全新节点，首帧重新取一遍 → 用户看到的「缩放轨道时中间栏那排图闪一下」；
   · 刚点下的那颗「＋」自己也被摘掉 → 这一栏的滚动位置被抹平，页面弹回最上方；
   · 播放器那一只 `.player-box` 即便有 `keepBox` 也先被 `remove()` 了一次（全屏正开着时等于当场退出全屏）。
   这三件都与「这一排摊开几像素/秒」无关，所以缩放只重排时间轴。 */
function tlRescale() {
  const col = $('midCol'), sh = curShot();
  if (!col || !sh || !col.querySelector('#tlBar')) return;   // 不在剪辑态就没有这一排可重排
  const cands = sh.candidates || [];
  renderTimeline(col, sh, cands[proj.curCand] || cands[0]);
}
/* 改比例尺要做的三件事（新值、锚点、落盘）只有这一处，按钮与滚轮都走它 ——
   「按钮一步 1.6 倍」与「滚轮按 deltaY 连续折算」是同一份换算的两个入口，不是两套账。 */
function tlZoomTo(mult) {
  const bar = document.getElementById('tlBar');
  if (!bar) return;
  const total = tlTotalNow(bar);
  const cur = tlCurrentPps(total, bar);
  const next = Math.max(tlMinPps(total), Math.min(TL_MAX_ZOOM, cur * mult));
  if (Math.abs(next - cur) < 1e-9) return;                 // 贴到上下限：一次无谓的重排都不做
  tlAnchorT = (bar.scrollLeft + bar.clientWidth / 2) / Math.max(0.01, cur);
  /* 三位小数而不是两位：滚轮那一档一步只有 1.5%，而两位量化在 1 px/秒 那一档的格宽正好是 1%，
     会把半步吃掉 —— 捏一下读数一动不动，看着像滚轮坏了。 */
  tlPps = Math.round(next * 1000) / 1000;
  try { localStorage.setItem('dir_tl_pps', String(tlPps)); } catch (e) {}
  if (midEditTrim) tlRescale();
}
/* 按钮那两颗：一步 1.6 倍 */
function tlZoomBy(dir) { tlZoomTo(dir > 0 ? 1.6 : 1 / 1.6); }
/* 触摸板的一次捏合连发几十条 wheel（每条 deltaY 只有一二十像素，一秒能出 60 条以上），
   以前每条都乘按钮那一步的 1.6 —— 一次捏合翻几十倍，就是用户报的「幅度太大、没法用」。
   滚轮因此不当「一步」用，按 deltaY 的像素数**连续折算**：鼠标一格（Chrome 回 100）≈ 1.16 倍，
   和旁边那两颗按钮同一档手感；按行回的那家（deltaMode 1）先换成像素再算。
   攒到下一帧只重排一次顺带修掉第二件事：以前每条都拿**还没重排完的** scrollLeft 算视野中心那一秒，
   而一次重排赶不上事件流速时队列必排 —— 锚点跟着漂，松手后画面还在继续跳。 */
const TL_WHEEL_K = 0.0015, TL_WHEEL_CLAMP = 120, TL_WHEEL_LINE = 33;
let tlWheelMult = 1, tlWheelRaf = 0;
function tlZoomWheel(e) {
  /* 单条夹一道上限：惯性甩动一条能回几百像素，不夹就等于一条事件走完整程。 */
  const px = (e.deltaY || 0) * (e.deltaMode === 1 ? TL_WHEEL_LINE : 1);
  tlWheelMult *= Math.exp(-Math.max(-TL_WHEEL_CLAMP, Math.min(TL_WHEEL_CLAMP, px)) * TL_WHEEL_K);
  if (tlWheelRaf) return;
  tlWheelRaf = requestAnimationFrame(() => {
    const m = tlWheelMult; tlWheelMult = 1; tlWheelRaf = 0;
    tlZoomTo(m);
  });
}
/* 回到「自适应」那一档（点读数那一下）。这一档**以前没有出口**：手动缩过一次之后
   `tlPps` 就永远是手动值，读数再也不会写「自适应」。旧下限 4px/秒 时缩到底看着还是铺满一整条，
   「回不去」是含糊的；现在能缩到比这条轨道还短，回不去就成了看得见的一件事 —— 所以给它一颗真出口。 */
function tlZoomAuto() {
  if (!tlPps) return false;
  tlPps = 0;
  try { localStorage.removeItem('dir_tl_pps'); } catch (e) {}
  if (midEditTrim) tlRescale();
  return true;
}
/* 当前页签那把尺子的总长（本镜 = 这一排的轴秒，全片 = 各格框摊开的总长）—— 缩放与比例尺都问它一处。
   ⚠ 本镜那一支**不能再返回 `candDur`**（候选的源秒）：内容层的宽度 = 这一个数 × 像素/秒，
   而格子、刻度尺、插针全按 `shotAxTotal` 的百分比铺 —— 两者不等时「像素/秒」就成了一个假数
   （切片密度、缩放到视野中心那一秒、`tlAnchorT` 全都偏，且倍速越偏越明显）。 */
function tlTotalNow(bar) {
  const sh = curShot();
  if (!sh) return 0;
  if ((proj.tlTab || 'shot') === 'film') {
    return Math.max(0.05, filmFrames(tlSyncFromShots()).total);
  }
  const cands = sh.candidates || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
  if (!c) return 0;
  const total = candDur(c, sh);
  return shotAxTotal(shotFrames(segsOf(c, total)), total);
}

/* 时间线：剪辑模式打开时才画。两个页签是**同一份 c.segs 的两种读数** ——
   「本镜」按源视频秒摆这一段剪出来的几格，「全片」按成片秒比例摆所有已选用镜头的格。
   两个页签**形状一致**（一排绝对定位的段格 + 左右红把手 + 一根插针 + 一条声音行），
   放插针的点击区是整条 .tl-bar（bindPinZone）：格子之间的缝、行上下的空白都算。 */
function renderTimeline(col, sh, cur) {
  const bar = col.querySelector('#tlBar');
  if (!bar) return;
  /* 一切内容都装在 `.tl-inner` 里，它的宽度 = 总时长 × 像素/秒（见 tlApplyScale）——
     行内元素继续按百分比定位，于是「比例尺」只有这一个落点。 */
  bar.innerHTML = '<div class="tl-inner" id="tlInner"></div>';
  const inner = bar.querySelector('#tlInner');
  /* 比例尺**先**落地再画行：行的宽度是父级的 100%，先有宽度才不至按旧宽度排一帧 */
  tlApplyScale(bar, tlTotalNow(bar));
  const tab = proj.tlTab || 'shot';
  if (tab === 'shot') renderShotTrack(inner, col, sh, cur);
  else renderFilmTrack(inner, col, sh);
  paintTlHint(col, sh, cur);
}
/* 这一页签的像素/秒（要问**滚动容器**的宽度，不能问内容层 —— 内容层已经是 pxPerSec 撑出来的） */
const tlPpsNow = total => tlCurrentPps(total, document.getElementById('tlBar'));
function renderShotTrack(bar, col, sh, cur) {
  const c = cur || (sh.candidates || []).find(x => x.vid === sh.selId) || (sh.candidates || []).find(x => x.status === 'succeeded');
  if (!c) {
    bar.innerHTML = '<div class="tl-empty">这一镜还没有候选：先生成一条，或点「导入视频 / 素材」挑一条，才谈得上剪。</div>';
    return;
  }
  const total = candDur(c, sh);
  const segs = segsOf(c, total);
  /* 这一排的时间基 = **轴秒**（各段的框 ÷ 自己那一段的倍速累加，见 `shotFrames`）：
     倍速一改，这一格真的变宽 / 变窄，而数据层一个字节没动（`c.segs` 仍是源秒）。
     段数为零时退回候选时长，免得刻度尺塌成一格（「一段画面都不留」是有效状态）。 */
  const G = shotFrames(segs);
  const ax = shotAxTotal(G, total);
  /* 没在播时针画的是**数据里那一秒**（`proj.cutAt`），不是播放器的 `currentTime`：
     播放器刚建出来（还没 seek、或者这条素材取不到字节）时它恒为 0，
     于是一个存着 1.8 秒的工作区一进剪辑，针停在 0%、读数和剪刀却在 1.8 秒。
     播放中仍读 `cutPin`（跟着播放头走）—— 与 `syncPlayhead` 那两个分支同一份口径。 */
  const pinSrc = TlPlay.playing ? cutPin(c, total)
    : round1(Math.max(0, Math.min(total, Number(proj.cutAt) || 0)));
  const pinAx = shotPinT(G, pinSrc);
  /* 这一页签此刻的像素/秒（与 tlApplyScale 给内容层设宽时问的是同一个）——
     它只决定「这一格摊得下几张定宽磁贴」：放大 → 格子变宽 → 多几张，缩小 → 少几张，
     每张在屏上始终 SLICE_TILE_PX 那么宽（放不下整张就裁掉右边那一截）。 */
  const pps = tlPpsNow(ax);
  const src = candTrackSrc(c);
  const iSel = picSelAt(segs.length);
  /* 格子按**框** [a,b] 摊在轴上（`start` / `w`，不是按选区）：拖把手时框不动，所以这一格的
     左右边界与切片画面都不变 —— 变的是框内那两层灰遮罩的宽度（左边那块 = 被切掉的片头，
     右边那块 = 被切掉的片尾）。选段之间也互不影响：改一段的倍速只挪它后面那些格。
     切片图也按框取（`data-in/out` = 源秒 a/b）：拖把手改的是选区，帧不需要重新解码。 */
  /* 锁上画面轨 = 把手一颗都不画（不是画出来再禁用）：留一颗拖不动的把手等于
     「看着能点、其实什么都不做」。问的是**这一格自己那一行**（`rowLocked`：整条轨锁着时每一格都锁，
     只锁第 2 行时第 1 行的把手照画），与声音轨那一句走同一份判据。 */
  const cellHTML = r => {
    const s = r.s, i = r.i;
    const picLocked = rowLocked('pic', r.ln);
    const bw = Math.max(0.01, r.dur);          // 框在**源**里有多长（灰遮罩比的都是它）
    const gone = !!s.off;
    /* 黑场那一格**不解码切片**（画面已经不进了，取帧只是白烧 CPU），但格子本身照原样占着位置 ——
       「点哪个轨道操作哪个轨道」要求它仍然可点、可选、可被「删掉」那颗按钮再点回来。 */
    return `
    <div class="tl-seg${i === iSel ? ' sel' : ''}${gone ? ' gone' : ''}" data-seg="${i}"
         style="left:${pct(r.start, ax)}%;width:${pct(r.w, ax)}%"
         title="${gone ? '第 ' + (i + 1) + ' 段：画面已删掉，成片里这一段出黑场（时长还是 ' + round1(segFilmLen(s)) + ' 秒，后面那段不前移）。想放回来就点上面那颗「恢复这一段画面」'
           : '第 ' + (i + 1) + ' 段：这一段框住源视频 ' + round1(s.a) + '–' + round1(s.b) + ' 秒；保留 ' + round1(s.in) + '–' + round1(s.out) + ' 秒（' + round1(segFilmLen(s)) + ' 秒）。点空白处放插针'
           + (picLocked ? '（' + rowLockWhy('pic', r.ln) + '，把手不画也拖不动；' + rowUnlockHow('pic', r.ln) + '）'
             : '，拖格子两端的把手把这一段的头/尾切掉（灰掉的那块就是被切掉的）；上下拖 = 挪到另一行')}">
      ${gone ? '' : sliceBoxHTML(src, s.a, s.b, r.w * pps, frameToSrc(r, pinAx))}
      <span class="mask l" style="width:${pct(s.in - s.a, bw)}%"></span>
      <span class="mask r" style="width:${pct(s.b - s.out, bw)}%"></span>
      <span class="lab">${esc(segLabel(i, s))}</span>
      ${picLocked ? '' : `<span class="cut l" data-seg="${i}" data-edge="l"></span><span class="cut r" data-seg="${i}" data-edge="r"></span>`}
    </div>`;
  };
  /* 画面轨也可以有几行（`s.ln`，用户点名「视频也改成可以无限多轨道，方便剪辑」）。
     格子从不重叠（一段接着一段），所以多行**纯粹是排版** —— 把一段拖到第二行只改它画在哪一行，
     进成片的顺序、时长、切片与音量账一个字节都不改（那一行的基数另说）。
     行数按数据长（最高那一行 + 1），空着的中间行照样画：抽掉空行会把它上面那一行往下塌一格，
     而那一格正好是插针与刻度尺对齐的地方。 */
  const lanes = laneRowsFor('pic', laneRowsOf(segs));
  let picHTML = '';
  for (let ln = 0; ln < lanes; ln++) {
    const body = G.rows.filter(r => r.ln === ln).map(r => cellHTML(r)).join('');
    /* 那句「一段都没留」只说一次（挂在第一行）：行数可以是用户自己加的，
       每一行都重复一句等于把三行空白变成三条警告。 */
    picHTML += `<div class="tl-vrow${rowHidden('pic', ln) ? ' hid' : ''}" data-ln="${ln}">` + (body
      || (segs.length || ln ? '' : '<div class="tl-empty">这一条候选一段画面都没留：按 Ctrl+Z 退回去，或在上面「切开」重新分一段。</div>')) + '</div>';
  }
  bar.insertAdjacentHTML('beforeend', rulerHTML(ax, tlPpsNow(ax)));
  bar.insertAdjacentHTML('beforeend', picHTML);
  bar.insertAdjacentHTML('beforeend', voiceLaneHTML(sh, c, total, G));
  /* 待生成配音那一轨排在**真配音轨下方**（用户点名）：它说的是「这一镜还有话没配」，
     合成之后占位符自己消失（判据是 `pendingLineOf`，不是另存一份状态）。 */
  bar.insertAdjacentHTML('beforeend', shotPendingHTML(sh, G, ax));
  /* 字幕行排在最下面（首期只读：点块跳转、改字在右栏；不做拖动 / 裁切，避免与 c.segs 两本账）。 */
  bar.insertAdjacentHTML('beforeend', subLaneHTML(sh, c, G, ax));
  bindSubLanes(bar, col, false);
  /* 插针最后挂（挂在内容层上，穿过刻度尺 + 画面行 + 声音行）：
     它不属于任何一行，所以行的显隐、锁定都不影响它 —— 收起画面轨时针还得在。 */
  bar.insertAdjacentHTML('beforeend', `<span class="tl-pin" style="left:${pct(pinAx, ax)}%"></span>`);
  bar.querySelectorAll('.tl-vrow').forEach(r => { bindSegDrag(r, sh, c, total, G); fillSlices(r); });
  bar.querySelectorAll('.tl-lane').forEach(l => bindVoiceLane(l, { total: ax, G: G }));
  bindPendingLanes(bar, sh);
  syncLaneSide(col, bar);        // 左边那一列的轨名跟着行数长（画面几行、配音几行各有各的）
  syncTlTools();            // 统一剪辑条跟着这一排重画（选中着就把那一句写回条上）
  fillWaveforms(bar);          // 后台填声音轨的波形（不挡轨道出来）
  /* 点轨道空白 / 格子里不带把手的地方 = 放插针（也就是定了四把剪子下一刀剪在哪）。
     绑在**整张网格**上（轨名那一列也算），不绑在滚动容器里：画面轨一行都没画出来时，
     从前那个「取第一行的矩形」直接 bail，于是整块区域点了没有任何反应。
     不依赖 duration 是否已知：钳在 0–total 之间，播放器能跳就跳。 */
  bindPinZone(col.querySelector('#tlGrid') || bar, col, sh);
  paintPin(col, pinAx, ax);
}
/* 刻度尺右端那枚读数（#tlT1）= 上面那把尺子的终点，与格子的 `left/width` 同一份账。
   还没出画面时照旧说「未生成」，不摆一个假 0 秒。 */
const shotAxText = (c, sh) => {
  const t = c ? candDur(c, sh) : 0;
  if (!t) return shotDurText(sh);
  return fmtDur(shotAxTotal(shotFrames(segsOf(c, t)), t));
};

/* ============================================================================
   「这一镜的台词还没配音」那一族（2026-10 用户点名的第 ④ 条）
   ---------------------------------------------------------------------------
   AI 拆分镜时会带回 `speaker`（落成 `sh.lineWho`）与 `line`。台词本身**不进配音轨**
   （它就是一行字，没有音频），所以界面上另开一条「待生成配音」轨：每个有台词、且这一镜上
   还没有同文配音的镜头摆一个虚线占位符。点它 = 把这一句填进右栏「生成配音」，
   并**按说话人去素材库取音色描述 / 参考音频**（音色设计取 `voiceNote`、音色复刻取那段字节）。
   三条不能各写一份的口径：
     ① 判据只有 `pendingLineOf`（台词有字 + 这一镜没有任何一句配音的文字与它相同）；
     ② 位置只有 `shotPendingHTML` / `filmPendingHTML` 两处，都按各自那一排的轴秒摆
        （本镜读 `shotFrames` 的行、全片读 `filmFrames` 的行，与格子和插针同一把尺子）；
     ③ 点击只有一个出口 `openPendingVoice`，且它一个计费请求都不发（合成仍只在
        `addVoiceAtPin` 那一下）。 */
function lineDraftOf(sh) {
  return {
    text: String((sh && sh.line) || '').replace(/\s+/g, ' ').trim(),
    who: String((sh && sh.lineWho) || '').replace(/\s+/g, ' ').trim()
  };
}
/* AI 拆分镜 / 改分镜带回台词时那句「出路」只有一份：两处报数共用同一个串，指的都是新落点
   （剪辑右栏「台词」那一档，或轨道上那个待生成占位）。话里不写「已合成」—— 那一次一个计费
   请求都没发，合成只在「合成并加到这一轨」那一下。 */
function lineLandedNote(n) {
  return '、' + n + ' 镜带上了台词（到剪辑右栏「台词」点那一句，或点轨道上的待生成占位，才填进合成框）';
}
/* 「这一镜还有话没配」：台词有字，且这一镜上没有任何一句配音的文字与它相同。
   按**文字**认而不是按「有没有配音」：台词改过之后旧配音还在，那一句仍然算待生成
   （否则改完台词，轨道上那个占位符永远不会再出现）。 */
function pendingLineOf(sh) {
  const p = lineDraftOf(sh);
  if (!p.text) return null;
  const hit = shotVoices(sh.id, '').some(v => String(v.text || '').replace(/\s+/g, ' ').trim() === p.text);
  return hit ? null : p;
}
function pendingBlockHTML(p, l, w, ax, where, shotId) {
  const who = p.who ? p.who + '：' : '';
  const est = lineEstSec(p.text);
  const tip = '待生成配音：' + who + p.text + ' · 约 ' + round1(est) + ' 秒（按' + where + '的位置摆，合成后时长以真实音频为准）'
    + '。点一下把这一句填进右栏「生成配音」，并按说话人去素材库取音色描述 / 参考音频';
  return `<span class="tl-vp" data-shot="${esc(shotId || '')}" style="left:${pct(l, ax)}%;width:${pct(Math.max(0.2, Math.min(ax - l, Math.max(0.6, w))), ax)}%"
    title="${esc(tip)}"><b>待生成</b><span>${esc(who + p.text)}</span><i class="vpm">${p.text.length} 字</i></span>`;
}
/* 本镜那一排：一行台词摆在这一镜**第一段保留区的起点**（台词属于这一镜，不属于某一段）。
   宽度按语速估，再除以这一格的倍速 —— 倍速把这一格压窄时，占位符跟着窄，
   否则「2 倍速的一格里摆着 8 倍速宽度的一句话」本身就是假的。 */
function shotPendingHTML(sh, G, ax) {
  const p = pendingLineOf(sh);
  if (!p) return '';
  const r0 = (G && G.rows || [])[0];
  /* 一条画面段都没有（还没出候选 / 全被剪成黑场）：照样把这一句摆出来，从左沿铺到整条，
     不让「这一镜有台词」在剪辑界面里彻底看不见（点它仍然进得了「生成配音」，
     只是合成那一步会在 `voiceTarget` 那里说清「还没有可放的位置」）。 */
  if (!r0) return '<div class="tl-vp-lane">' + pendingBlockHTML(p, 0, ax, ax, '整条（这一镜还没有画面段）', sh.id) + '</div>';
  const s = r0.s || {};
  const sp = lineSpanAt(r0, s.in, lineEstSec(p.text), false);
  const l = Math.min(Math.max(0, ax - 0.05), sp.at);
  const w = Math.min(Math.max(0, ax - l), sp.len);
  return '<div class="tl-vp-lane">' + pendingBlockHTML(p, l, w, ax, '第 1 段', sh.id) + '</div>';
}
/* 全片那一排：每一镜只摆一次（它可能被剪成好几格；台词跟着**第一格**走）。
   同一条台词在这一镜已经配过音时 `pendingLineOf` 给 null，占位不画。 */
function filmPendingHTML(tl, G) {
  const ax = Math.max(0.05, G.total);
  const seen = new Set();
  let out = '';
  G.rows.forEach(r => {
    const cl = r.cl;
    if (!cl || cl.kind !== 'shot' || seen.has(cl.shotId)) return;
    seen.add(cl.shotId);
    const sh = allShots().find(x => x.id === cl.shotId);
    const p = sh ? pendingLineOf(sh) : null;
    if (!p) return;
    const sp = lineSpanAt(r, r.cl.in, lineEstSec(p.text), false);
    const l = Math.min(Math.max(0, ax - 0.05), sp.at);
    const w = Math.min(Math.max(0, ax - l), sp.len);
    out += pendingBlockHTML(p, l, w, ax, '第 ' + (r.k + 1) + ' 格', sh.id);
  });
  return out ? '<div class="tl-vp-lane">' + out + '</div>' : '';
}
/* 占位符的点击（两排各绑一次，节点每次重画都是新的）。
   `bindPinZone` 已经把它排除在「放插针」之外（见那一条），这里 stopPropagation 是第二道：
   两道都在，将来谁改了其中一处也不会变成「点一下又挪针又翻页」。 */
function bindPendingLanes(bar, fallen) {
  bar.querySelectorAll('.tl-vp').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const id = el.dataset.shot || '';
      const target = allShots().find(x => x.id === id) || fallen;
      if (target) openPendingVoice(target);
    };
  });
}
/* 点「待生成」占位 / 台词清单里的一行：把焦点切到那一镜，台词填进合成框，翻到「生成配音」。
   先画一版（字已经在了），素材库那边取字节回来再补画一次那两格 —— 一条人声可能几 MB，
   为了等它把整个点击拖住不动，用户会以为没点中。 */
function openPendingVoice(sh) {
  if (!sh) return;
  const sc = proj.scenes.find(s2 => s2.shots.includes(sh));
  if (sc) { proj.curScene = proj.scenes.indexOf(sc); proj.curShot = sc.shots.indexOf(sh); }
  const cands = sh.candidates || [];
  let c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId)
    || cands.find(x => x.status === 'succeeded') || cands[0];
  const ci = c ? cands.indexOf(c) : -1;
  if (ci >= 0) proj.curCand = ci;
  /* **不动 `proj.curVoice` 之外的目标写法**：这里没有一句配音可选中，所以直接把目标交给声音轨；
     占位符不是块，不能走 `selectVoice('')`（那一条会把目标交回画面）。 */
  proj.curVoice = '';
  proj.tlLane = 'voice';
  proj.tlTab = 'shot';
  const total = c ? candDur(c, sh) : 0;
  const segs = c ? segsOf(c, total) : [];
  if (segs.length) { proj.cutSeg = 0; proj.cutAt = Number(segs[0].in) || 0; }
  vcTab = 'gen';
  const p = lineDraftOf(sh);
  /* 换了一句台词就把上一句的音色草稿清掉（同一句重复点则留着用户手改过的那一份）：
     上一句的参考音频要是留在这一格里，合成出来会是另一个人的声音，而且真扣费。 */
  if (voiceDraft.text !== p.text) { voiceDraft.design = ''; voiceDraft.ref = null; }
  voiceDraft.text = p.text;
  renderAll();
  prefillVoiceWho(p.who).then(note => {
    if (curShot() !== sh) return;
    paintTlGroups();
    renderEditor();
    if (note) setStatus('<span class="meta">' + esc(note) + '</span>');
  }).catch(() => {});
}
/* 按说话人去素材库找料：音色设计取那位的 `voiceNote`，音色复刻取那段参考音频的字节。
   找不到人 / 那一位没写描述 / 没挂音频时**一个字都不写**（仍可手挑），但要把原因说出来 ——
   「点了占位符，参考那一格却还空着」必须有一句话解释，否则看着像页面没接上。
   返回的是给人看的那句话（调用方决定往哪儿放），不在这里弹提示。 */
async function prefillVoiceWho(who) {
  const way = voiceWayOf(voiceReg(), proj.voiceModel || '');
  /* 找谁、读音色描述还是取参考音频字节，全在 `Chars.Pipe.voicePrefillOf` 那一份里：
     库里那一列叫什么不出 web/domain/chars.js，这里只认它交回来的 note / blob / why。 */
  const pick = await Chars.Pipe.voicePrefillOf(who, way.mode);
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

/* 全片那一排下面的声音行：块的左沿按**成片秒**算（它所在那一格在成片里的起点 + 段内偏移）。
   于是在本镜切一刀之后，这一排的格子数与配音块位置一起跟着变 —— 两处仍是同一份数据的两种读数，
   不是「同步」出来的（配音锚在段上，段在候选上，全片只是把它摊开画一遍）。 */
function filmVoiceHTML(tl, g) {
  const G = g || filmFrames(tl);
  const ax = Math.max(0.05, G.total);
  const per = [];
  /* 这一排时间基（轴秒）上的灰场区间：一句配音压在灰场上时，那几秒跳过（音频停住、
     越过整段接着放），块顺延拉长、重合处画灰带 —— 取法收在 `axisGray` 一份（两条轨共用）。 */
  const gray = axisGray(G);
  G.rows.forEach(r => {
    const cl = r.cl;
    if (cl.kind !== 'shot') return;
    shotVoices(cl.shotId, cl.candId).forEach(v => {
      if ((Number(v.seg) || 0) !== (Number(cl.seg) || 0)) return;
      /* 与「本镜」那一排走同一份折算（`voiceAxBox`）：块在框里的位置 = 选区起点相对框左沿的偏移
         + 段内偏移（`v.at` 一直是「相对选区起点」的，这个口径从它诞生起就没变过 ——
         变的是框基之后「格子的起点」怎么算）。
         这一排的框左沿 = 那一格的轴起点 +（画面选区起点 - 画面框左沿）÷ 倍速 + 配音框的偏移。
         ⚠ 块宽要过两道折算：`v.dur` 是**音频文件秒**（合成侧 atempo 之前那一段），
         ÷ 自己那一档（`own`）才是源秒，再 ÷ `r.spd` 才是轴秒 —— 合成侧正是
         `atempo = speed × spd`（`v.start` 只按画面倍速折算；句自己的倍速只改念多快、不挪位置）。
         少除 `own` 就是「右栏写着 ×1.5、这一排还按 1× 画长一截」。 */
      const bx = voiceAxBox(r, v);
      lanePut(per, v, voiceBlockHTML(v, bx.box, bx.sel, ax,
        '这一段第 ' + round1(bx.box.l - r.start) + ' 秒起，长 ' + round1(bx.dur) + ' 秒', { gray }));
    });
  });
  const orph = orphanVoices().length;
  return voiceLanesHTML(per, laneHidden('voice') ? 1 : laneRowsFor('voice', per.length),
    orph ? laneNm('voice') + '：全片有 ' + orph + ' 句配音挂在没被选用的候选上，进不了成片 —— 切到「本镜」在右栏点「搬回选用的这一镜」'
      : laneNm('voice') + '：切到「本镜」在右栏合成一句配音，它会出现在这里对应的那一格下面');
}
/* 全片那一排：一格 = 一段画面（一条候选剪出几段就是几格），按成片秒定位。
   与本镜同一套形状：格子两端的把手拖这一格的**源视频**头尾（折算回那一条候选的 segs），
   插针跟着成片秒走，点任意位置把焦点切到那一镜那一段（四把剪子剪的就是它）。 */
function renderFilmTrack(bar, col, sh) {
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    bar.insertAdjacentHTML('beforeend',
      '<div class="tl-film" data-ln="0"><div class="tl-empty">还没有已选用的镜头：先在候选上点「用这条」，这里才会出现格子。</div></div>');
    return;
  }
  /* 排版依据 = 各段的**框**（不是成片秒）：剪一段只改它自己框内的灰块，
     别的格、别的格的切片、刻度尺，一个字节都不动（见 filmFrames 的说明）。 */
  const G = filmFrames(tl);
  const total = G.total;
  /* 与「本镜」那一排同一份像素/秒：一格的屏上宽度 = r.w（轴秒）× pps，
     切片密度按**轴秒**现算 —— 用 r.dur 会在 spd ≠ 1 时把格子算宽/算窄，密度跟着偏。 */
  const pps = tlPpsNow(total);
  /* 插针在**这一排的轴秒**上落在哪一格的框里（切片排解码顺序用的热区，见 fillSlices 的 chunkHot）：
     与下面画格子用的是同一个 filmPinT，不在这里另算一份针的位置。 */
  const pinAx = filmPinT(tl, G);
  const curShotNow = curShot();
  const cellHTML = r => {
    /* 与「本镜」那一排同一份判据：**这一格所在那一行**锁着才不画把手（整条轨锁着时每一行都锁）。
       行号读 `r.ln`，而它来自段上的 `s.ln` —— 两排同一个数，不存在「本镜能拖而全片不能」。 */
    const picLocked = rowLocked('pic', r.ln);
    const cl = r.cl, k = r.k;
    const isShot = cl.kind === 'shot';
    const target = isShot ? allShots().find(x => x.id === cl.shotId) : null;
    const cand = target ? tlCandidateOf(target, cl.candId) : null;
    const focus = picSelOn() && !!target && target === curShotNow && Number(cl.seg || 0) === cutSegIdx();
    const nSeg = segsOf(cand, candDur(cand, target)).length;
    const name = target ? (target.name || '镜头') : (cl.name || '素材');
    const keep = round1(Math.max(0.05, tlClipDur(cl)));
    const gone = !!cl.gray;
    const tip = (gone ? `第 ${k + 1} 格：${name} 的第 ${(Number(cl.seg || 0) + 1)}${nSeg > 1 ? '/' + nSeg : ''} 段 · 画面已删掉，成片里出 ${keep} 秒黑场（后面那格不前移）`
      : `第 ${k + 1} 格：${name} 的第 ${(Number(cl.seg || 0) + 1)}${nSeg > 1 ? '/' + nSeg : ''} 段`
        + ` · 保留 ${keep} 秒（这一段在源里分到 ${round1(r.dur)} 秒，灰掉的部分不进成片）`)
        + (picLocked ? '（点一下把焦点切到这里；' + rowLockWhy('pic', r.ln) + '，把手不画、拖不动，顺序也拖不了；'
          + rowUnlockHow('pic', r.ln) + '）'
          : '（点一下把焦点切到这里，四把剪子剪的就是这一条；拖格子两端的把手把这一段的头尾切掉；左右拖这一格 = 把那一镜在成片里挪个先后）');
    /* 格子背景：**每一镜**都铺它自己剪出来的切片图（用户点名「全片剪辑所有镜的切片都应该显示」）。
       取帧区间 = 这一格的**框**（拖把手不改它）→ 剪一刀不会让整排重新解码。
       取不到帧的（外链过期 / 没有候选地址）才退回镜头首帧；黑场没有画面。 */
    const pic = (!isShot || !cand || !cand.url) ? ((target && target.firstFrame) ? Api.mediaSrc(target.firstFrame) : '') : '';
    const slices = gone ? ''
      : (isShot && cand && cand.url)
      ? sliceBoxHTML(candTrackSrc(cand), r.a, r.b, r.w * pps, frameToSrc(r, pinAx))
      : pic ? `<span class="frs"><i class="fr whole" style="background-image:url(&quot;${esc(pic)}&quot;)"></i></span>` : '';
    /* 框内两块灰：左边 = 被切掉的片头（选区起点相对框左沿），右边 = 被切掉的片尾 */
    const masks = isShot
      ? `<span class="mask l" style="width:${pct(Math.max(0, Number(cl.in) || 0) - r.a, r.dur)}%"></span>`
        + `<span class="mask r" style="width:${pct(r.b - Math.max(0, Number(cl.out) || 0), r.dur)}%"></span>`
      : '';
    /* 把手只画给「有源可拖」的画面格（拖的是框内选区，左右两颗）；外来素材一格都不画。
       **画面轨锁上时一颗都不画**（与声音轨同一套：锁 = 不画 + 手势拒，不是画出来再禁用） */
    const cuts = (picLocked || !isShot) ? ''
      : `<span class="cut l" data-k="${k}" data-edge="l"></span><span class="cut r" data-k="${k}" data-edge="r"></span>`;
    return `<div class="tl-seg${focus ? ' sel' : ''}${gone ? ' gone' : ''}" data-k="${k}"
         style="left:${pct(r.start, total)}%;width:${pct(r.w, total)}%"
         title="${esc(tip)}">
      ${slices}${masks}<span class="lab" data-lab="${esc(name + (nSeg > 1 ? ' ' + (Number(cl.seg || 0) + 1) : ''))}">${esc(name)}${nSeg > 1 ? ' ' + (Number(cl.seg || 0) + 1) : ''} · ${gone ? '黑场 ' : ''}${keep}s${r.spd !== 1 ? ' ' + spdTxt(r.spd) : ''}</span>${cuts}</div>`;
  };
  /* 画面轨有几行就摊几行（`r.ln` 读的是那一段上的 `s.ln` —— 与「本镜」那一排同一份数据，
     所以在本镜把某一格挪到第 3 行，切到全片它还在第 3 行）。外来素材没有段可挂，一律第一行。
     空着的中间行照样画：抽掉空行会把上面的行往下塌一格，而那一格正是插针与刻度尺对齐的地方。 */
  const lanes = laneRowsFor('pic', laneRowsOf(G.rows));
  let filmHTML = '';
  for (let ln = 0; ln < lanes; ln++) {
    filmHTML += `<div class="tl-film${rowHidden('pic', ln) ? ' hid' : ''}" data-ln="${ln}">`
      + G.rows.filter(r => r.ln === ln).map(cellHTML).join('') + '</div>';
  }
  bar.insertAdjacentHTML('beforeend', rulerHTML(total, tlPpsNow(total)));
  bar.insertAdjacentHTML('beforeend', filmHTML);
  /* 声音行**无条件画**（用户点名的第 ① 条）：从前这里先看 `voices`，于是「这一片一句配音都没有」
     那一排在界面上根本没有声音轨 —— 针没有可穿的第二行，空白处也无处可点（第 ④ 条要的「点空白 → 生成配音」
     连落点都没有）。本镜那一排本来就是无条件画（见 renderShotTrack），两条轨同一套形状。
     三种情况都仍然要有这一行：一句块都没有（把原因说出来）、有孤句（该进成片却进不了）、
     用户自己加过声音行（行数在两个页签都得落出来）。
     待生成那一轨排在它**下面**（用户点名），每一镜只摆一个占位，跟在它第一格后面。 */
  bar.insertAdjacentHTML('beforeend', filmVoiceHTML(tl, G));
  bar.insertAdjacentHTML('beforeend', filmPendingHTML(tl, G));
  /* 全片字幕行：按成片秒摆，与 SRT / FCPXML 用同一份 filmEntriesOf。 */
  bar.insertAdjacentHTML('beforeend', filmSubLaneHTML(tl, G));
  bar.querySelectorAll('.tl-lane').forEach(l => bindVoiceLane(l, { total: total, film: true }));
  bindPendingLanes(bar, curShotNow);
  bindSubLanes(bar, col, true);
  fillWaveforms(bar);          // 后台填声音轨的波形（不挡轨道出来）
  /* 插针挂在内容层最外面，穿过刻度尺 + 全片行 +（有配音时）声音行 —— 与本镜那一排同一根针的画法。
     放在所有行之后：它不属于任何一行，行的显隐与锁定都不该把它一起收掉。 */
  bar.insertAdjacentHTML('beforeend', `<span class="tl-pin" style="left:${pct(filmPinT(tl, G), total)}%"></span>`);
  syncTlTools();                 // 统一剪辑条跟着这一排重画（本镜 / 全片都走这一份）
  syncLaneSide(col, bar);        // 左边那一列的轨名跟着行数长（画面几行、配音几行各有各的）
  fillSlices(bar);
  bindFilmDrag(bar, tl, total, G);
  bindFilmReorder(bar, col, tl, total, G);
  bindPinZone(col.querySelector('#tlGrid') || bar, col, sh);
  paintPin(col, filmPinT(tl, G), total);
}
/* 全片轨的插针落在哪（成片秒）：焦点那一格的起点 + 插针在源里的偏移（按这一格的速度折算）。
   焦点 = 当前镜头 + cutSeg 指着的那一段；当前镜头没进成片时针停在 0。 */
function filmPinT(tl, g) {
  const G = g || filmFrames(tl);
  const sh = curShot();
  const cands = (sh && sh.candidates) || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId) || null;
  if (!sh || !c) return 0;
  const r = G.rows.find(x => x.cl.kind === 'shot' && x.cl.shotId === sh.id && x.cl.candId === c.vid
    && Number(x.cl.seg || 0) === cutSegIdx());
  if (!r) return 0;
  /* 焦点那一段的插针 = 这一格的轴起点 + 插针在**源**里的秒数相对框左沿的偏移（÷ 倍速换算到轴上）。
     灰区里不放针（它在成片里不存在），所以夹在框内。 */
  const t = srcToFrame(r, Number(proj.cutAt) || 0);
  return round1(Math.max(r.start, Math.min(r.start + r.w, t)));
}
/* 轨道上那一排的秒（轴秒）→ 这一格里的源秒：点轨道、拖把手、播放跟随共用 frameToSrc / srcToFrame
   这两行（定义在 filmFrames 那一段）。
   写成具名函数是因为三处各写一遍 `in + (t - start) * speed` 迟早有一处忘了乘速度；
   倍速之后又多一根轴，两条方向各一份，任何一处自己拼算式都是下一次「针与格子对不上」。 */
/* 轴秒 t 落在哪一格：返回那一格的镜头 / 候选 / 段下标 / 段内源秒。
   点轨道与「播成片时针跟着走」都走它 —— 两条路必须落在同一个判据上。 */
function filmSeek(tl, tFrame, g) {
  const G = g || filmFrames(tl);
  if (!G.rows.length) return null;
  let r = G.rows[G.rows.length - 1];
  for (const x of G.rows) { if (tFrame < x.start + x.w) { r = x; break; } }
  const cl = r.cl;
  if (cl.kind !== 'shot') return { clip: cl, row: r, start: r.start, target: null, at: 0 };
  const target = allShots().find(x => x.id === cl.shotId);
  const cands = (target && target.candidates) || [];
  const ci = cands.findIndex(x => x.vid === cl.candId);
  const cand = ci >= 0 ? cands[ci] : (target ? tlCandidateOf(target, cl.candId) : null);
  const segs = cand ? segsOf(cand, candDur(cand, target)) : [];
  const si = Math.min(segs.length - 1, Math.max(0, Number(cl.seg) || 0));
  const s = segs[si];
  /* 框里任何位置都换算得出源秒，**包括被剪掉的头尾（灰区）**——
     用户点灰区就是要把针放到那儿（用户点名的第 ⑥ 条）。以前这里把它夹回选区，
     点下去针会自己弹回白区的边上，看着像「灰区点不动」。
     注意这里放开的只是**针**：真正剪的那一刀仍由 `cutSegs` 管（灰区里切头尾照样会夹/拒并说明原因）。 */
  const tSrc = frameToSrc(r, tFrame);
  return { clip: cl, row: r, start: r.start, target: target, cand: cand, ci: ci, segs: segs, si: si, s: s,
    at: round1(tSrc) };
}
/* 点全片轨某一处：焦点切到那一镜那一段 + 插针放到那儿 + 播放器跟着跳。
   opts.quiet = 播放中跟着走的那条路（只挪针与数据，不重画整栏 —— 重画会把正在放的视频换掉）。
   opts.lane  = 用户手势把目标交给哪一轨（'pic' / 'voice'），与 setPin 那一个参数同一份含义。 */
function filmApplyAt(col, tl, tFrame, opts) {
  const G = filmFrames(tl);
  /* 播放跟随（quiet）在**没在播**时既不换焦点也不挪针：拖一下全片的顺序、剪一刀、切页签都会整栏重画
     → 播放器重建 → `TlPlay.seek()` 开头无条件 emit 一次 → 走到这一支，递来的是上一次那一秒（新建时是 0 秒）。
     而那一秒在**新顺序**下落的是别的镜，于是「我只是改了个顺序，本镜就变成了另一条」。
     针的位置本来就由焦点算出来（`filmPinT`），所以焦点不动、针也不动才是自洽的。
     真在播的时候仍跟着播放头走（右栏与剪刀指着正在放的那一格是有用的）。 */
  if (opts && opts.quiet && !TlPlay.playing) {
    paintPin(col, filmPinT(tl, G), G.total);
    paintTlHint(col, curShot(), (curShot().candidates || [])[proj.curCand]);
    paintVoicePos(); syncTlTools();
    return;
  }
  const hit = filmSeek(tl, tFrame, G);
  if (!hit) return;
  if (opts && opts.lane) proj.tlLane = opts.lane;   // 与 setPin 同一件事：**用户**点全片那一排（画面格 / 空白）才把目标交过去（播放跟随不算）
  let msg = '已跳到全片轨第 ' + round1(tFrame) + ' 秒';
  if (hit.target) {
    const sc2 = proj.scenes.find(s2 => s2.shots.includes(hit.target));
    if (sc2) { proj.curScene = proj.scenes.indexOf(sc2); proj.curShot = sc2.shots.indexOf(hit.target); }
    if (hit.ci >= 0) proj.curCand = hit.ci;
    if (hit.s) { proj.cutSeg = hit.si; proj.cutAt = hit.at; }
    msg += '，焦点切到「' + (hit.target.name || '镜头') + '」第 ' + (hit.si + 1) + '/' + hit.segs.length + ' 段';
  }
  paintPin(col, tFrame, G.total);
  const bar = col.querySelector('#tlBar');
  /* 这一排的亮环同样只给「目标那一轨」：点在空白处（目标交给配音）时 `kk` 取 -1，一格都不亮。 */
  if (bar) { const kk = picSelOn() ? hit.row.k : -1;
    bar.querySelectorAll('.tl-film .tl-seg').forEach(x => x.classList.toggle('sel', Number(x.dataset.k) === kk)); }
  paintVoiceSel();          // 与「本镜」那一排同一件事：目标换了，配音那一排的亮环要跟着收
  dropPicSel();             // 反过来那一下：目标交给配音时，本镜那一排残留的白环也要当场掉
  if (opts && opts.quiet) { paintTlHint(col, curShot(), (curShot().candidates || [])[proj.curCand]); paintVoicePos(); syncTlTools(); return; }
  /* 跳到这一格这一秒：全片那一档放的是**整片**（`TlPlay` 按时间线调度），
     所以「这一格的源秒」要先折成**成片秒** = 计划里那一笔的起点 + 段内偏移 ÷ 这一格的倍速。
     按 `fs`（框基起点）认计划里那一笔，不按下标对：没有可用地址的格子不进计划，
     下标会错位（`hit.row.f0` 是几何表的数，那种时候与计划的轴对不上）。
     暂停与定位一起交给 TlPlay —— 与「本镜」那一档同一个立场（见 `bindPinZone`）：
     以前这里递的是 `hit.at`（那一格的**源**秒）而且只打甲板 A —— 真在播时前甲板可能是 B，
     整个动作打在后甲板上；`TlPlay.playing` 也没落定，下一帧播放跟随又把针推回去。 */
  const planI = TlPlay.plan.findIndex(p => Number(p.fs) === hit.row.start);
  const segOff = Math.max(0, Math.min(Number(hit.row.fd) || 0,
    (Number(hit.at) - Math.max(0, Number(hit.clip.in) || 0)) / (Number(hit.row.spd) || 1)));
  TlPlay.pause();
  TlPlay.seek((planI >= 0 ? TlPlay.starts[planI] : (Number(hit.row.f0) || 0)) + segOff, false);
  setStatus(msg);
  renderScenes(); renderEditor();
  paintTlHint(col, curShot(), (curShot().candidates || [])[proj.curCand]);
  scheduleSave();
}
/* 全片轨的把手：拖的是**这一格的源视频头尾**（折算回那一条候选的 segs）。
   拖动期间只改框内那两块灰与那行小字 —— 格子的位置与宽度由**框**定，把手不改框，
   所以别的格一格都不挪位（松手才写数据、才整栏重画）。
   ⚠ 与「本镜」那一排同一条纪律：拖动全程不碰剪针（`dragBusy()` 期间针本来就该站着）。 */
function bindFilmDrag(scope, tl, total, g) {
  const G0 = g || filmFrames(tl);
  /* 拖动中只重画**框内的两块灰**与那行小字 —— 格子的 left/width（由框定）、别的格、
     整排切片，一个字节都不动。这正是「剪一段不影响别的段」在全片轨上的落点。
     ⚠ 格子按行分在好几个 `.tl-film` 里，DOM 顺序不再等于格号，所以只能按 `data-k` 找回节点。 */
  const repaint = () => {
    const G2 = filmFrames(tlSyncFromShots());
    const cells = {};
    scope.querySelectorAll('.tl-seg').forEach(x => { cells[Number(x.dataset.k)] = x; });
    G2.rows.forEach(r => {
      const cell = cells[r.k];
      if (!cell) return;
      /* 画面格的把手**不改框**（拖的是框内选区），所以这一支一格的位置与宽度都不重摆 ——
         只跟着改框内那两块灰与那行小字。 */
      const bw = Math.max(0.01, r.dur);
      const ml = cell.querySelector('.mask.l'), mr = cell.querySelector('.mask.r');
      if (ml) ml.style.width = pct(Math.max(0, Number(r.cl.in) || 0) - r.a, bw) + '%';
      if (mr) mr.style.width = pct(r.b - Math.max(0, Number(r.cl.out) || 0), bw) + '%';
      const lab = cell.querySelector('.lab');
      if (lab && lab.dataset.lab) lab.textContent = lab.dataset.lab + ' · ' + round1(Math.max(0.05, tlClipDur(r.cl))) + 's';
    });
  };
  scope.querySelectorAll('.cut').forEach(el => {
    const edge = el.dataset.edge;
    el.title = edge === 'l' ? '拖动设置这一段的开头（灰掉的那块就是被切掉的）' : '拖动设置这一段的结尾（灰掉的那块就是被切掉的）';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      const r = G0.rows[Number(el.dataset.k)];
      if (!r || !r.cl) return;
      if (r.cl.kind !== 'shot') return;
      const target = allShots().find(x => x.id === r.cl.shotId);
      const cand = target ? tlCandidateOf(target, r.cl.candId) : null;
      if (!cand) return;
      const cTotal = candDur(cand, target);
      const segIdx = Math.min(segsOf(cand, cTotal).length - 1, Math.max(0, Number(r.cl.seg) || 0));
      const before = segsCopy(segsOf(cand, cTotal));   // 拖动之前的那一份（配音要按它还原绝对秒）
      const rect = scope.getBoundingClientRect();
      const move = ev => {
        /* 指针 → 框基秒 → 这一格里的**源秒**（框的左沿 + 框内偏移），再夹在框里：
           拖不出这一格分到的那一块，所以相邻格永远不会叠在一起。 */
        const tFrame = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))) * total;
        const tSrc = frameToSrc(r, tFrame);
        const list = segsCopy(segsOf(cand, cTotal));
        const seg = list[segIdx]; if (!seg) return;
        if (edge === 'l') seg.in = Math.max(seg.a, Math.min(tSrc, seg.out - SEG_MIN));
        else seg.out = Math.min(seg.b, Math.max(tSrc, seg.in + SEG_MIN));
        cand.segs = list;                     // 拖动期间只动 segs（trimS/trimE 在松手时统一回写）
        repaint();
      };
      const up = () => {
        el.classList.remove('act');
        const now = segsOf(cand, cTotal);
        segsWrite(cand, cTotal, now);
        const moved = reanchorVoices(target, cand, before, now);
        /* 焦点跟着被拖的那一镜走：四把剪子与入出点那一行接着就指着它 */
        const sc2 = proj.scenes.find(s2 => s2.shots.includes(target));
        if (sc2) { proj.curScene = proj.scenes.indexOf(sc2); proj.curShot = sc2.shots.indexOf(target); }
        const ci = (target.candidates || []).findIndex(x => x.vid === cand.vid);
        if (ci >= 0) proj.curCand = ci;
        proj.cutSeg = Math.min(now.length - 1, segIdx);
        setStatus(trimStatus(target, cand, moved ? '有 ' + moved + ' 句配音被切到段外，已挪到下一段开头' : ''));
        filmEdited();
      };
      /* `.act` 排在三道守卫之后：认不出这一格 / 不是镜头格 / 找不到那条候选时 `up` 根本不会跑，
         起手就加粗会留下一根永远亮着的把手。 */
      el.classList.add('act');
      dragOnWindow(move, up);
    });
  });
}
/* 全片那一排：左右拖某一格 = 把**那一镜**在成片里挪个先后（用户点名的「成片剪辑应该可以任意拖动
   不同镜头的顺序」）。改的只有 `proj.filmOrder` 这一份覆盖清单 —— 分镜表里镜头的先后不动，
   所以左栏的场景与镜头列表、AI 分镜的落点都不会被一次剪辑拖乱。
   拖动中途只画一根「插到这儿」的竖线，不重排格子：整栏重画会把手指底下的节点销毁（这是旧病）。
   松手才写数据并走 `filmEdited()`（整栏重画 + 说一句「盘上那份是旧的」，不自动跑 ffmpeg）。
   一镜有几段就一起走（格子按段摊开，但顺序是**按镜**记的）；贴在某一镜后面的黑场跟着那一镜走
   （它在 clips 里就锚在那一镜之后）；**那一格所在的那一行**锁着时这个手势一个字都不接
   （与把手、换行、本镜那一排同一份判据 `rowLocked`）。
   **上下拖同一格 = 换到画面轨的另一行**（用户点名的第 ⑥ 条「视频要能跨轨道拖到别的轨道上去」）：
   走的是 `setCellLane` 那一份落地，行号与「本镜」那一排同一个数；中途跟着指针的是那张缩略图小卡
   （第 ⑧ 条），不是把格子真搬过去 —— 整栏在拖动中途重画会把手指底下的节点销毁。 */
function bindFilmReorder(scope, col, tl, total, g) {
  const G0 = g || filmFrames(tl);
  /* 每一镜在这一排上占的那一段区间（[轴起点, 轴终点)）：判断落在谁身上要以镜为单位，
     否则一镜的第 2 段会把自己的第 1 段当成「别一镜」。 */
  const spans = [];
  G0.rows.forEach(r => {
    if (!r.cl || r.cl.kind !== 'shot') return;
    let s = spans.find(x => x.id === r.cl.shotId);
    if (!s) spans.push(s = { id: r.cl.shotId, name: r.cl.name || '', a: r.start, b: r.start + r.w });
    s.a = Math.min(s.a, r.start); s.b = Math.max(s.b, r.start + r.w);
  });
  scope.querySelectorAll('.tl-film .tl-seg').forEach(el => {
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('.cut')) return;                 // 把手那一路（剪头尾）自己管
      const r0 = G0.rows[Number(el.dataset.k)];
      if (!r0 || !r0.cl || r0.cl.kind !== 'shot') return;   // 黑场与外来素材不参与重排
      const mine = r0.cl.shotId;
      const rect = scope.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY;
      const step = picLaneStep(el.closest('.tl-film') || el);
      const ln0 = r0.ln;
      /* 锁问的是**这一格所在那一行**（整条轨锁着时每一格都锁）：锁了第 2 行，第 1 行的格子照样能挪顺序、能换行。 */
      if (rowLocked('pic', ln0)) return;
      let moved = 0, mark = null, want = null, mode = '', lnWant = ln0;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        /* 起手时那一下位移更大的方向**一次定死**这一趟是「挪顺序」还是「换行」，中途不改判：
           一边拖一边换判据会把一次手势劈成两半（先换了行又去插顺序），而松手只落得下一件事。
           与配音块那一路（`bindVoiceLane` 的「竖直位移更大才算换行」）同一立场。 */
        if (!mode) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          mode = Math.abs(dy) > Math.abs(dx) ? 'lane' : 'order';
          moved = 1; el.style.opacity = '.72';       // 单击不闪暗，真拖起来才淡下去
          dragGhostShow(ev, el, (el.querySelector('.lab') || {}).textContent);
        } else dragGhostMove(ev);
        if (mode === 'lane') {
          lnWant = laneClamp(ln0 + Math.round(dy / step));
          el.style.transform = 'translateY(' + round1((lnWant - ln0) * step) + 'px)';
          return;
        }
        const tFrame = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))) * total;
        /* 目标 = 指针所在那一镜（跳过自己）；落在它右半边就插到它后面，左半边插到它前面。
           指针还在自己那一镜的范围里（或落在两镜之间的缝上）时按**拖动方向**取紧邻的那一镜：
           往右就是右边那一镜，往左就是左边那一镜 —— 不判方向的话，往左拖会挑到右边那一镜，
           于是「把它往前挪」点松手却把它甩到了整排末尾。 */
        const others = spans.filter(x => x.id !== mine);
        let t = others.find(x => tFrame >= x.a && tFrame < x.b);
        if (!t) {
          t = dx > 0 ? (others.find(x => tFrame < x.a) || others[others.length - 1])
            : (others.slice().reverse().find(x => tFrame >= x.b) || others[0]);
        }
        if (!t) { if (mark) { mark.remove(); mark = null; } want = null; return; }
        const after = tFrame > (t.a + t.b) / 2;
        want = { id: t.id, after: after };
        /* 指示线挂内容层 `.tl-inner`（与插针同一个宿主、同样穿满整排），不挂在被点那一格里：
           挂在行里就只有那一行高，而「插到第几秒」是整块轨道共用的一件事。 */
        if (!mark) { mark = document.createElement('span'); mark.className = 'tl-drop'; scope.appendChild(mark); }
        mark.style.left = pct(after ? t.b : t.a, total) + '%';
      };
      const up = () => {
        dragGhostHide();
        if (mark) mark.remove();
        el.style.opacity = '';
        el.style.transform = '';
        if (!moved) return;
        trackDragT = Date.now();          // 松手那一下的 click 不算放针（用户拖的是顺序 / 行）
        if (mode === 'lane') {
          if (lnWant === ln0) {
            /* 绕回原来那一行：一个数都没改，不许打「✓ 挪到了」（与本镜那一路同一句纪律） */
            setStatus('<span class="info">这一段拖回了画面轨第 ' + (ln0 + 1) + ' 行，位置没变</span>');
            return;
          }
          const target = allShots().find(x => x.id === r0.cl.shotId);
          const cand = target ? tlCandidateOf(target, r0.cl.candId) : null;
          if (!setCellLane(target, cand, Number(r0.cl.seg) || 0, lnWant)) return;
          setStatus('<span class="ok">✓ 「' + esc(r0.cl.name || '镜头') + '」第 ' + ((Number(r0.cl.seg) || 0) + 1)
            + ' 段挪到了画面轨第 ' + (lnWant + 1) + ' 行（切到「本镜」看还是这一行：两条轨存的是同一个行号；'
            + '进成片的顺序、时长与切片一个字没动，这一行的基数音量在右栏那张卡上调）</span>');
          filmEdited();
          return;
        }
        if (!want || want.id === mine) return;
        if (!moveShotInFilmOrder(mine, want.id, want.after)) return;
        const tn = spans.find(x => x.id === want.id) || {};
        setStatus('<span class="ok">✓ 已把「' + (r0.cl.name || '镜头') + '」挪到「' + (tn.name || '那一镜') + '」'
          + (want.after ? '后面' : '前面') + '（每一段的入出点、音量、倍速与配音都没动；分镜表里的先后也没动，'
          + '要退回拖之前那一份顺序按上面那排「撤销」（或 Ctrl+Z））</span>');
        filmEdited();
      };
      e.preventDefault(); e.stopPropagation();
      dragOnWindow(move, up);
    });
  });
}

/* ============================================================================
   剪辑模式的右栏 = 声音栏（形状照着生成工作台的语音那一栏）
   ----------------------------------------------------------------------------
   用户点名的是「打开剪辑功能后右栏变成工作台的声音栏那样，并添加剪辑相应功能」：
   平台与型号、音色、格式、高级设置全部**现读能力声明**（判据在 Chars.Pipe 那一份，不在这里抄第二遍），
   合成走公共层 `AiGen.synthTts`（与语音台同一条链：同步合成 → 字节落本机 → 记归档），
   「剪辑相应功能」= 这一句锚在**插针指着的那一段**上，位置由轨道决定，不额外要用户填秒数。
   草稿只活在内存（voiceDraft）：整栏重画不该丢掉正在打的字，换出剪辑模式自然清。
   与语音工作台对齐的两件事：① 平台与型号下拉列**全部**配了密钥的语音供应商（Chars.Pipe.modelSelectHTML）；
   ② 「合成设置」那一块 = 输出格式 + 平台在 create.topBools 里声明的顶层开关 + 字数区间
   （tts.minChars/maxChars，不够长时按钮当场禁用并写明，不等着平台回一句拒）。 */
/* `ref` = 复刻（clone）用的那条参考音频（资产库 / 收藏 / 本机文件挑来的那一条）。
   它和 `voiceFile`（「放一条本机音频」）不是一回事：那一个把**成品音频**铺到轨上当配音，
   这一个把音色**素材**发给平台，让平台按它现造一把嗓子。 */
let voiceDraft = { text: '', voice: '', format: '', design: '', ref: null, bools: {}, tb: {} };
/* 右栏配音区那四个小选项（用户点名的第 ③ 条）：一次只露一格内容，节点不销毁。
   默认「这一镜上的配音」；点中轨上一句换成「音量与倍速」，点台词那一档换成「台词」，
   点空白 / 待生成占位换成「生成配音」（三个落点各写一次，见 selectVoice / bindPinZone / bindPendingLane）。 */
let vcTab = 'list';
/* 「这一家刚刚报过余额/额度不够」：合成失败那一次记下来，十分钟内再点不再白等一整轮 ——
   但**不禁用按钮**：用户可能已经充好了，所以给一句说明加一颗「仍然再试」。
   判据与那笔账都在 Api.balOut / Api.isBalanceErr（api.js），这里只记「这一栏要不要挂那张牌」。 */
let voiceBalOut = '';
/* 量一句音频的真实时长（块宽与 /render 的 dur 都靠它）。量不出来不按 0 记 ——
   0 会让这一句在轨上塌成一条线，等于「加了但看不见」。 */
function audioDurOf(src) {
  return new Promise(res => {
    let done = false;
    const a = new Audio();
    const fin = () => { if (done) return; done = true; try { a.pause(); a.removeAttribute('src'); } catch (e) {} res(0.5); };
    a.preload = 'metadata';
    a.src = Api.mediaSrc(src);
    a.addEventListener('loadedmetadata', () => {
      if (done) return;
      done = true;
      const d = isFinite(a.duration) && a.duration > 0 ? a.duration : 0.5;
      try { a.pause(); a.removeAttribute('src'); } catch (e) {}
      res(Math.max(0.1, round1(d)));
    });
    a.addEventListener('error', fin);
    setTimeout(fin, 8000);
  });
}
/* 这一句落在哪：段号 + 段内偏移（都从插针现算，界面上那句「落在哪」读的是同一个函数，不各写一遍） */
function voiceTarget(sh, c) {
  if (!c) return null;
  const total = candDur(c, sh);
  const segs = segsOf(c, total);
  if (!segs.length) return null;
  const si = Math.min(segs.length - 1, cutSegIdx());
  const s = segs[si];
  const at = round1(Math.max(0, Math.min(Math.max(0, segLen(s) - SEG_MIN), (Number(proj.cutAt) || 0) - s.in)));
  return { si, s, at, segs, total };
}
function voiceWayOf(REG, key) {
  /* 「这一句按哪种方式定音色」的判据在公共层（`Chars.Pipe.ttsWayOfChosen`），和工作台语音栏同一份：
     **跟着下拉里选中的那一个型号走**。以前这里按「这一家有没有预设音色」排优先级
     （preset > design > clone），于是用户选了「音色设计」型号而画的还是预设音色下拉、
     选了「音色复刻」型号时连「选参考音频」那张卡都不出现 —— 而那三个型号挂在同一家平台上，
     下拉里全都列得出来（用户原话：应该像工作台一样按选中的模型动态加载）。 */
  const w = Chars.Pipe.ttsWayOfChosen(REG, { ttsModel: key });
  if (!w.chosen) return { chosen: null, target: null, mode: 'none', why: w.why };
  const ways = Chars.Pipe.ttsWays(REG, { ttsModel: w.chosen.key });
  return { chosen: w.chosen, ways: ways, target: w.target, mode: w.mode,
    why: w.why || ways.why || '这个语音平台没有能直接合成的型号' };
}
/* 「这一句现在能不能合成」的两条闸，全站只在这一处算（右栏初次渲染、就地重画那一颗按钮、
   提交前最后一道，三个入口问的是下面这三个函数）：
     ① voiceWayWhy —— 这一档定音色**必填的那样东西**缺了没有（设计缺一段声音描述、复刻缺一条参考音频、
        这一家没有能用的型号）；判据与工作台 `submitBlockReason` 的语音分支同一套。
        以前设计档什么都不查，描述空着也照样发：`{{style}}` 空值在模板里被整项省略，
        等于发一个不带描述的请求，而界面上写着「按描述定音色」。
     ② voiceLenWhy —— 要念的话在不在这一家声明的字数区间里（tts.minChars / maxChars，页面不自己编数）。
   合成这一句要计费，所以拦住的那一句必须说清缺的是哪一格，不能只把按钮压暗。 */
function voiceWayWhy(way, draft) {
  /* 措辞与工作台同一份（`TtsAdv.wayWhy`）：以前两页各写一句「音色设计缺描述」，
     一边说「要先写一段声音描述」、一边说「必须填写风格 / 音色描述」，同一个缺陷两种说法。
     `ref` 在这里折算成「有没有一条真拿得到字节的参考音频」—— 导演台存的是一句对象，
     工作台存的是槽位数组，两边形状不同但「缺不缺」是同一件事。 */
  const ref = draft.ref && (draft.ref.src || draft.ref.file || draft.ref.assetId);
  return window.TtsAdv.wayWhy(way, { design: draft.design, ref: ref });
}
function voiceLenWhy(way, draft, tts) {
  /* 字数只按预设 / 设计这两档判（与上游那两档的请求同一份），复刻档本来就不看这一段字。
     上下限与那句措辞都在 `CharLimits` 一份（工作台就绪判定、提示行、提交前那一路问的是同一个）。 */
  if (!way || (way.mode !== 'preset' && way.mode !== 'design')) return '';
  return window.CharLimits.why(draft.text, window.CharLimits.tts(tts));
}
function voiceSynthWhy(way, draft, tts) { return voiceWayWhy(way, draft) || voiceLenWhy(way, draft, tts); }
/* 右栏那句「这一句会落在哪」：**只此一份**（整栏渲染与插针挪动后的就地刷新都读它）。
   各写一遍就会出现「右栏写着 +1.5 秒，真发出去落在插针现在的 0 秒」——
   而按钮上写着的就是「合成并加到这一轨」，落点说明是它唯一的依据。 */
function voicePosLine(sh, c) {
  const t = voiceTarget(sh, c);
  if (t) return '插针指着的位置：第 ' + (t.si + 1) + '/' + t.segs.length + ' 段的 +' + t.at + ' 秒（源里 ' + round1(t.s.in + t.at) + ' 秒）'
    + '。要换地方就点轨道把插针挪过去 —— 合成完这一句就铺在那里。';
  return '插针指着的位置：' + (c ? '这一镜一段画面都没留：按 Ctrl+Z 退回剪切之前'
    : '这一镜还没有候选：先生成或导入一条视频');
}
/* 插针一动就只换这一行，不重画整栏 —— 整栏重画会把正在敲的配音文本换掉、焦点也跟着跳。
   挂在 paintSegFocus 那一串联动里（点轨道 / 拖播放进度都走 setPin）。 */
/* 这一镜有没有「该进成片却进不了」的配音，说出来的一句话（空串 = 没有，那块整个不画）。
   原因只问 `voiceFilmWhy` 那一份判据，不在这里复述是哪一种（换候选 / 候选没了 / 段被剪了）。 */
function voiceOrphanNote(sh) {
  const list = sh ? orphanVoicesOf(sh.id) : [];
  if (!list.length) return '';
  return '这一镜有 ' + list.length + ' 句配音没进成片：' + voiceFilmWhy(list[0])
    + (list.length > 1 ? '（其余 ' + (list.length - 1) + ' 句同理）' : '') + '。';
}
/* 与 `voicePos` 同一批就地重画：插针一动、拖完一块、锁一轨，都只换这一格的文案与按钮的暗，
   不重画整栏（整栏重画会把正在敲的「要念的话」换掉）。 */
function paintVoiceOrphan() {
  const box = document.getElementById('voiceOrphan');
  if (!box) return;
  const sh = curShot();
  const txt = voiceOrphanNote(sh);
  box.hidden = !txt;
  const t = document.getElementById('voiceOrphanTxt');
  if (t) t.textContent = txt;
  const btn = document.getElementById('voiceAdopt');
  if (btn) {
    const why = adoptWhy(sh);
    btn.disabled = !!why;
    btn.title = why ? '搬不了：' + why
      : '把这些句子的锚点换到「用这条」选中的那一镜候选上（只换锚点，音频与时长都不动，改完成片跟着变）';
  }
}
function paintVoicePos() {
  const el = document.getElementById('voicePos');
  if (!el) return;
  const sh = curShot();
  if (!sh) return;
  const cands = sh.candidates || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
  el.textContent = voicePosLine(sh, c);
  paintVoiceOrphan();
}
/* 语音平台与型号：与语音工作台**同一份判据** —— 注册声明兜底，各家的 /models 现拉
   （MiMo 声明的 modelsFilter:'-tts' 也照它走），拉到的按 id 与声明合并能力。
   为什么要现拉：v13 起 `p.models` 只装「用户自己在设置页填过的 id」，而用户常用的就是
   官方那一两个型号 —— 不拉一次的话，没手填过的家在下拉里**一个型号都没有**，
   「全部供应商选择」也就无从谈起。拉回来的并进本页这一份 REG 副本再交给 Chars.Pipe
   （那一份 REG 是素材库共用的，不在这儿改它的语义）。一家失败只用声明兜底，不连坐别家。 */
let voiceLive = {};        // { 平台id: [型号id] }
let voiceLiveKey = '';
async function loadVoiceModels() {
  const withEp = Api.pickable((REG.providers || []).filter(p => p.kind === 'audio'))
    .filter(p => p.endpoints && p.endpoints.models);
  const key = withEp.map(p => p.id).join(',');
  if (key === voiceLiveKey) return;                 // 同一批平台只取一次（设置页补了密钥会换 key）
  voiceLiveKey = key;
  if (!withEp.length) return;
  const got = await Promise.all(withEp.map(async p => {
    try {
      const d = await Api.request(p, 'models');
      const list = Api.modelRows(d).map(m => (m && (m.id || m.name)) || '').filter(Boolean);
      const re = p.modelsFilter ? new RegExp(p.modelsFilter) : null;
      const hidden = id => !!(window.ModelPrefs && window.ModelPrefs.isOff(p, id));   // 设置页藏掉的照样藏
      return [p.id, list.filter(id => (!re || re.test(id)) && !hidden(id))];
    } catch (e) { console.warn('[director] ' + (p.name || p.id) + ' 的型号接口不可用，用注册声明：', e.message); return null; }
  }));
  const ok2 = got.filter(Boolean);
  if (!ok2.length) { voiceLiveKey = ''; return; }   // 一家都没取到：不记死签名，下次还能再试
  voiceLive = {};
  ok2.forEach(pair => { voiceLive[pair[0]] = pair[1]; });
  /* 取回来了：还在剪辑模式就重画一次右栏（下拉这才有东西可选） */
  if (midEditTrim && curShot()) renderEditor();
}
/* 本页语音栏用的 REG：把「现拉的型号清单」与「声明的能力」并成一份再交给 Chars.Pipe。
   合并口径逐字照工作台（`studio.html` 的 `audioModels()`）：**声明兜底、现拉/手填那一份优先，
   options 深合一次**。为什么必须查 `modelDocs`：v13 起注册表不再下发型号清单，
   MiMo 那三个 id 的 `modes` / `ttsMode` / `inputRoles`（音色设计、音色复刻、参考音频槽）全在
   `modelDocs` 那张表里，而能力刷新后 `p.models` 里可能只剩一个带 id 的空壳 ——
   只读 `p.models` 的话「这一句怎么定音色」整块掉回预设那一档，
   界面上「声音描述」输入框与「音色素材（参考音频）」那张卡一起消失
   （用户报的两条「模仿音色没有卡片了 / 生成音色没有描述框了」，工作台早就这么修过）。
   清单本身仍然只用「现拉的 ∪ 手填的」，`modelDocs` 不冒充清单（它只是「文档写过这个 id 支持什么」）。 */
function voiceReg() {
  return { providers: (REG.providers || []).map(p => {
    if (p.kind !== 'audio') return p;
    const live = voiceLive[p.id] || [];
    const typed = (p.models || []).filter(Boolean);
    if (!live.length && !typed.length) return p;                    // 清单还没有：照原样，别自己造型号
    const declared = new Map((typed.concat(p.modelDocs || [])).map(m => [m.id || m.name, m]));
    const byId = new Map(typed.map(m => [m.id || m.name, m]));
    const ids = [];
    live.forEach(id => { if (id && !ids.includes(id)) ids.push(id); });
    typed.forEach(m => { const id = m.id || m.name; if (id && !ids.includes(id)) ids.push(id); });   // 手填的别丢
    const models = ids.map(id => {
      const d2 = declared.get(id) || p.newModelDefaults || {};       // 声明（含 modelDocs）兜底
      const cur2 = byId.get(id) || {};                              // 现拉/手填那一份优先
      const out = Object.assign({}, d2, cur2, { id: id, name: cur2.name || d2.name || id });
      out.options = Object.assign({}, d2.options || {}, cur2.options || {});
      return out;
    });
    return Object.assign({}, p, { models: models });
  }) };
}
function renderVoiceCol(col, sh) {
  const idx = allShots().indexOf(sh) + 1;
  const cands = sh.candidates || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
  const t = voiceTarget(sh, c);
  /* 平台与型号走「注册声明 + 各家 /models 现拉」这一份（voiceReg），与语音工作台同一判据；
     取回后它会自己重画一次这一栏（见 loadVoiceModels 末尾） */
  const VREG = voiceReg();
  loadVoiceModels();
  const way = voiceWayOf(VREG, proj.voiceModel || '');
  const preset = way.mode === 'preset' ? Chars.Pipe.voices(VREG, { ttsModel: way.chosen.key }, 'preset') : [];
  if (way.mode === 'preset' && !preset.some(v => v.id === voiceDraft.voice)) voiceDraft.voice = preset.length ? preset[0].id : '';
  const tts = (way.chosen && way.chosen.prov && way.chosen.prov.tts) || {};
  const n = shotVoices(sh.id, c && c.vid).length;
  /* 字幕那一格：数据从 currentOf 来（唯一出口），显示时间经 mapToFilm；
     这一镜没进成片时退回源秒并把原因写在时间旁边（不拿 0 冒充成片起点）。 */
  const subCur = subCurrent(sh);
  const subSt = styleOf(sh);
  const subAt = shotFilmAt(sh);
  const subSpan = c ? segsOf(c, candDur(c, sh)).reduce((a, s) => a + segFilmLen(s), 0) : 0;
  const subWhere = subAt == null
    ? '这一镜还没进成片：显示的是源秒（选用候选并留在成片里之后，时间会折成成片秒）'
    : '这一镜在成片里从 ' + fmtDur(subAt) + ' 开始，长 ' + fmtDur(subSpan) + '；下面显示的是成片秒';
  const subStaleTxt = subCur.stale
    ? (subCur.staleWhy === 'cand' ? '字幕是按旧候选的源时间做的，换成现在这条候选后没有重映射'
      : subCur.staleWhy === 'nocand' ? '这一镜现在没有选用候选，字幕没有可映射的成片时间'
        : '台词 / 配音已经变过，字幕是按上一版生成的（手改 / 识别结果不会被覆盖）')
    : '';
  const subRows = subRowsHTML(sh, subCur, c);
  /* 「台词」那一档两段的数据：本镜那一句（还没写也留一行，那是写作入口）与其余每一句。
     一行只出现一次 —— 本镜那一行不在「全片」里重复一遍，否则同一个字段两格输入框，
     敲其中一格另一格还是旧字（本项目反复要拦的那一类）。 */
  const lRows = linePanelRows(sh, { includeEmptyMine: true });
  const lMine = lRows.filter(r => r.mine);
  const lAll = lRows.filter(r => !r.mine);
  const lCnt = lineCntTexts(sh);
  /* 合成设置：**与语音工作台同一份**（公共层 `TtsAdv`）—— 格式清单按「型号声明优先、平台声明兜底」，
     顶层开关就是工作台高级设置里那一排磁贴（AdvExtras.html.topBools），连点法都是同一个函数。
     以前这一栏自己拼了一套 `<select data-vbool>`，同一家平台在工作台上能勾的开关在这里是另一套控件，
     改一处漏一处（本项目反复要拦的那一类）。 */
  const boolProv = (way.target && way.target.prov) || (way.chosen && way.chosen.prov) || null;
  const boolModel = (way.target && way.target.model) || (way.chosen && way.chosen.model) || null;
  const fmts = window.TtsAdv.formats(boolProv, boolModel);
  if (fmts.length && !fmts.includes(voiceDraft.format)) voiceDraft.format = String(tts.defFormat || fmts[0] || '');
  /* 顶层开关的上下文：语音这种「一次请求只发一句话」的用法没有输入模式与画质档，
     所以 mode / intent 是空串、caps 为 null —— 与工作台语音栏同一份（那里 shapeCaps 在 audio 下也返回 null）。 */
  const tbCtx = { mode: '', intent: '', caps: null };
  const tb = boolProv ? window.TtsAdv.topBoolsHTML(boolProv, boolModel, tbCtx, voiceDraft.tb) : { html: '', count: 0 };
  /* 两道闸（这一档缺什么 / 字数在不在区间里）与提交前问的是同三个函数，见 `voiceWayWhy` 那一段。
     上下限的数仍然只从声明读（tts.minChars / maxChars），页面不自己编 —— 读法与措辞在 `CharLimits` 一份。 */
  const vB = window.CharLimits.tts(tts);
  const wayWhy = voiceWayWhy(way, voiceDraft);
  const vLenWhy = voiceLenWhy(way, voiceDraft, tts);
  const voiceCanSynth = !wayWhy;
  const advBits = [];
  if (fmts.length) advBits.push('<div><label>输出格式</label><select id="voiceFmt">'
    + window.TtsAdv.formatOptionsHTML(fmts, voiceDraft.format) + '</select></div>');
  if (tb.count) advBits.push(tb.html);
  col.innerHTML = `
    <div class="ed-head"><b id="edTitle">加一句配音</b><span class="no">第 ${idx} 镜 · <span id="edLane">配音轨</span></span></div>
    <div class="ed-body">
      <!-- 「这一镜上的配音 / 音量与倍速 / 台词 / 生成配音 / 字幕」五档：一排分段按钮，
           一次只露一格。点中轨上一句 → 音量与倍速；点台词 / 待生成占位 → 生成配音；
           点字幕块 → 字幕；谁都没点过 → 这一镜上的配音。显隐由 paintTlGroups 一处翻 hidden。 -->
      <div class="ui-seg vc-tabs" id="vcTabs" role="tablist">
        <button type="button" data-vctab="list" role="tab">这一镜上的配音${n ? ' ' + n : ''}</button>
        <button type="button" data-vctab="adj" role="tab">音量与倍速</button>
        <button type="button" data-vctab="lines" role="tab">台词</button>
        <button type="button" data-vctab="gen" role="tab">生成配音</button>
        <button type="button" data-vctab="sub" role="tab">字幕</button>
      </div>
      <!-- 「指着哪一段 / 哪一句，就改它的参数」这一张卡：音量与倍速两枚无级滑块，
           再加画面轨 / 配音轨两枚「行」音量（与段上那枚是乘算：那一行压到 60% 时，那一段调到 100% 进成片仍是 60%）
           与一颗把芯片指着的那一段（或那一句）挪上/挪下一行的出口（行只决定画在哪一条横带里，时间与顺序一个字不动）。
           判据不在这里 —— 目标、取值、锁定与读数全部由 syncTlTools() 一处写（与轨道上面那排剪子同一个出口），
           写点的唯一性见 setCutVol / setCutSpd / setLaneVol / setVoiceSpd。 -->
      <div class="tl-adj" id="tlAdj">
        <div class="adj-row">
          <span class="lab" id="tlVolLab">这一段音量</span>
          <span class="tl-vol" id="tlVolBox" title="这一段 / 这一句自己的音量（0–200%，无级）：进成片还要乘所在那一行的基数">
            ${icon('speaker', 12)}
            <input type="range" id="tlVol" min="0" max="200" step="0.1" value="100" aria-label="音量">
            <span class="vv" id="tlVolVal">100%</span>
          </span>
        </div>
        <!-- 「整轨音量」与上面那枚各调各的（用户点名要分开的两件事之一）：上面那枚只管芯片指着的那一个，
             这一枚一次把这一排此刻画出来的每一段 / 每一句自己的音量都设成这一档。
             它不是「那一行的基数」（基数是乘在每一份之上的那一个数，这一枚改的是那一些数本身），
             跟着目标走：指着配音就改句，指着画面就改段。 -->
        <div class="adj-row">
          <span class="lab">整轨音量</span>
          <span class="tl-vol" id="tlVolTrackBox" title="把这一排每一段 / 每一句自己的音量都设成这一档（0–200%，无级）：与上面那枚各调各的，进成片照样乘所在那一行的基数">
            ${icon('layers', 12)}
            <input type="range" id="tlVolTrack" min="0" max="200" step="0.1" value="100" aria-label="整轨音量">
            <span class="vv" id="tlVolTrackVal">100%</span>
          </span>
        </div>
        <!-- 下面这几块按「此刻指着哪一轨」分组显隐（syncTlTools → paintTlGroups 一处翻 hidden）：
             点画面轨只看见倍速 / 画面轨行，点配音轨只看见配音轨行与加一句配音。
             grpVoiceAdd 那一块在「这一镜还没有配音」时不收 —— 音轨上没有一个块可点，收掉就等于第一句永远加不上。 -->
        <div class="grp" id="grpPic">
        <div class="adj-row">
          <span class="lab" id="tlSpdLab">这一段倍速</span>
          <span class="tl-vol" id="tlSpdBox" title="这一段画面的倍速（0.25–4，无级）：改的是它在轨道上占多宽，源秒与入出点不动">
            ${icon('chart', 12)}
            <input type="range" id="tlSpd" min="0.25" max="4" step="0.05" value="1" aria-label="这一段倍速">
            <span class="vv" id="tlSpdVal">×1</span>
          </span>
        </div>
        <!-- 「整轨倍速」是一枚自己独立的滑块（以前它只是「把上面那枚此刻的档对着清单各调一遍」的一颗按钮，
             于是想「整排 ×2、这一句仍 ×1」就做不到：先把拇指拖到 ×2 那一步已经把指着的那一句改成 ×2 了）。
             两枚各读各的、各写各的；这一枚写完之后上面那枚跟着现算（syncTlTools），不会各说一件事。
             ⚠ 这段注释里的函数名一律不加反引号：它在一个模板字符串里面，加反引号就是把字符串当场截断。 -->
        <div class="adj-row">
          <span class="lab">整轨倍速</span>
          <span class="tl-vol" id="tlSpdTrackBox" title="把这一排每一段的倍速都设成这一档：整排一起缩 / 放，源秒与入出点不动（与上面那枚各调各的）">
            ${icon('layers', 12)}
            <input type="range" id="tlSpdTrack" min="0.25" max="4" step="0.05" value="1" aria-label="整轨倍速">
            <span class="vv" id="tlSpdTrackVal">×1</span>
          </span>
        </div>
        <div class="adj-row">
          <span class="lab">画面轨这一行</span>
          <span class="tl-vol" id="lanePicBox" title="画面轨这一行的基数音量（0–200%，无级）：这一行每一段的原声跟着变，段上那一枚在它之上再乘">
            ${icon('film', 12)}
            <input type="range" id="laneVolPic" min="0" max="200" step="0.1" value="100" aria-label="画面轨这一行的音量">
            <span class="vv" id="laneVolPicVal">100%</span>
          </span>
          <span class="cnt" id="lanePicRow">第 1 行</span>
        </div>
        </div>
        <div class="grp" id="grpVoice">
        <div class="adj-row">
          <span class="lab">配音轨这一行</span>
          <span class="tl-vol" id="laneVoiceBox" title="配音轨这一行的基数音量（0–200%，无级）：这一行每一句配音跟着变，句上那一枚在它之上再乘">
            ${icon('speaker', 12)}
            <input type="range" id="laneVolVoice" min="0" max="200" step="0.1" value="100" aria-label="配音轨这一行的音量">
            <span class="vv" id="laneVolVoiceVal">100%</span>
          </span>
          <span class="cnt" id="laneVoiceRow">第 1 行</span>
        </div>
        <div class="adj-row">
          <span class="lab" id="tlVoiceSpdLab">这一句倍速</span>
          <!-- 这一枚是「配音自己」的倍速：它乘在「那一段画面的倍速」之上，
               1 = 就跟画面一起变。放在 grpVoice 里而不是 grpPic，是因为 grpPic/grpVoice 互斥 ——
               指着配音时画面那枚整块收起，这里不留第二枚「看着都在调速度」的滑块。 -->
          <span class="tl-vol" id="tlVoiceSpdBox" title="这一句配音的倍速（0.25–4，无级）：只改这一句念多快，起点与时长不动">
            ${icon('chart', 12)}
            <input type="range" id="tlVoiceSpd" min="0.25" max="4" step="0.05" value="1" aria-label="这一句配音倍速">
            <span class="vv" id="tlVoiceSpdVal">×1</span>
          </span>
        </div>
        <div class="adj-row">
          <span class="lab">整轨倍速</span>
          <span class="tl-vol" id="tlVoiceSpdTrackBox" title="把这一排每一句的倍速都设成这一档：每一块一起缩 / 放，各句起点与时长不动（与上面那枚各调各的）">
            ${icon('layers', 12)}
            <input type="range" id="tlVoiceSpdTrack" min="0.25" max="4" step="0.05" value="1" aria-label="整轨倍速">
            <span class="vv" id="tlVoiceSpdTrackVal">×1</span>
          </span>
        </div>
        <!-- 换行：管的还是芯片指着的那一个东西（配音句 / 画面段），与上面两枚滑块「按行」是同一份行号。
             轨道上直接上下拖也能换行（手势在 bindSegDrag / bindVoiceLane 里），这两颗是给拖不准的人的出口。 -->
        <div class="adj-row">
          <span class="lab">所在行</span>
          <span class="cnt" id="cutLaneRow">第 1 行</span>
          <button class="tool mini" id="laneUp" title="把芯片指着的这一段 / 这一句挪到上一行（只改画在哪一行，进成片的时间与顺序一个字不变）">${icon('arrowUp', 12)} 上一行</button>
          <button class="tool mini" id="laneDown" title="把芯片指着的这一段 / 这一句挪到下一行（只改画在哪一行，进成片的时间与顺序一个字不变）">${icon('arrowDown', 12)} 下一行</button>
        </div>
        <div class="hint" id="tlAdjLen"></div>
      </div>
      </div>
      <div class="grp" id="grpLines">
      <!-- 台词：全站唯一的台词面板（镜头编辑右栏那一份已删）。写的仍是 sh.line / sh.lineWho 那一份数据，
           AI 拆分镜时按画面带回来的那一句也落在同一字段上；它与提示词各改各的，互不带动。
           写完它自己就上本镜 / 全片那两条「待生成配音」轨（判据只有 pendingLineOf 一份）：
           点这一行左边的头像或轨道上的斜纹占位，都把这一句填进「生成配音」，一个计费请求都不发。 -->
      <div class="ed-label" style="margin-top:14px"><span>本镜台词</span><span class="cnt" id="lineCntMine">${esc(lCnt.mine)}</span></div>
      <div class="line-list one" id="lineListMine">${lineRowsHTML(lMine)}</div>
      <div class="ed-label" style="margin-top:14px"><span>全片台词</span><span class="cnt" id="lineCntAll">${esc(lCnt.all)}</span></div>
      <div class="hint">每一行左边是说话人在素材库里的样子（对不上画占位图，名字照留），右边那两个数是这一句在本镜轨与全片轨上的位置。</div>
      <div class="line-list" id="lineListAll">${lAll.length ? lineRowsHTML(lAll) : '<div class="hint">除本镜以外还没有别的台词。</div>'}</div>
      ${lineWhoDatalistHTML()}
      </div>
      <div class="grp" id="grpVoiceAdd">
      <div class="ed-label" style="margin-top:14px"><span>落在哪</span><span class="cnt">${n ? '这一镜已有 ' + n + ' 句' : '这一镜还没有配音'}</span></div>
      <div class="hint" id="voicePos">${esc(voicePosLine(sh, c))}</div>
      <!-- 本镜有配音而全片那一轨空着时，原因说在这一格（两条轨问的是同一份 voiceFilmGap）。
           节点固定在这一处、由 paintVoiceOrphan 就地换文案与暗，不随整栏重画销毁。 -->
      <div class="ui-note" id="voiceOrphan"${voiceOrphanNote(sh) ? '' : ' hidden'} style="margin-top:8px">
        <span id="voiceOrphanTxt">${esc(voiceOrphanNote(sh))}</span>
        <button class="tool mini" id="voiceAdopt" style="margin-left:6px">搬回选用的这一镜</button>
      </div>
      <div class="ed-label" style="margin-top:14px"><span>语音平台与型号</span><span class="cnt">${way.chosen ? esc(String((way.chosen.prov.displayName || way.chosen.prov.id || ''))) : ''}</span></div>
      ${Chars.Pipe.modelSelectHTML(VREG, { kind: 'audio', mode: 'text_to_speech', id: 'voiceModel', value: way.chosen ? way.chosen.key : '',
        emptyText: '注册表里没有配好密钥的语音平台 —— 到设置页「语音」那一档填一家' })}
      ${way.mode === 'preset' ? `
        <div class="ed-label" style="margin-top:14px"><span>音色</span><span class="cnt">${preset.length} 个可选（现读这一家的声明）</span></div>
        <select id="voicePick">${window.TtsAdv.voiceOptionsHTML(preset, voiceDraft.voice)}</select>` : ''}
      ${way.mode === 'design' ? `
        <div class="ed-label" style="margin-top:14px"><span>声音描述</span><span class="cnt">这一家按描述定音色</span></div>
        <!-- 与下面「要念的话」同一只公共类（ui.css 的 .ui-ta）：裸 textarea 吃的是本页那条
             dialog.script textarea 的边框，四个页面四种边框就是这么来的（§3 复用公共模块）。 -->
        <textarea id="voiceDesign" class="ui-ta" rows="2" placeholder="例：年轻女声，语速偏慢，带一点沙哑">${esc(voiceDraft.design)}</textarea>
        <!-- 素材库里那些位写过音色描述，这里是「取过来」而不是「再抄一遍」：
             同一个人的声音在两页各写一句，迟早两种说法。 -->
        <div class="btn-row" style="margin-top:4px">
          <button class="ghost" id="voiceDesignPick" title="从素材库挑一位，把它身上写的那段音色描述填到这里">${icon('users', 14)} 取一位素材的音色描述</button>
        </div>` : ''}
      ${way.mode === 'clone' ? `
        <div class="ed-label" style="margin-top:14px"><span>音色素材（参考音频）</span><span class="cnt">这一家按参考音频复刻音色</span></div>
        <div class="btn-row">
          <button class="tool" id="voiceRefPick">${icon('mic', 14)} ${voiceDraft.ref ? '换一条参考音频' : '选参考音频'}</button>
          ${voiceDraft.ref ? `<button class="ghost" id="voiceRefDel">去掉这一条</button>` : ''}
        </div>
        <div class="hint" id="voiceRefName" style="margin-top:4px">${voiceDraft.ref
          ? '已选：' + esc(voiceDraft.ref.name || voiceDraft.ref.assetId || '这一条')
          : '还没选：从素材库 / 资产库 / 我的收藏 / 本机文件里挑一条（要几秒到几十秒的干净人声）'}</div>` : ''}
      <div class="hint err" id="voiceWayWhy" style="margin-top:10px"${wayWhy ? '' : ' hidden'}>${esc(wayWhy)}</div>
      ${advBits.length ? `
        <div class="ed-label" style="margin-top:14px"><span>合成设置</span><span class="cnt">${tb.count ? '格式与平台开关现读声明（与工作台同一份）' : '现读这一家的声明'}</span></div>
        <div class="adv-grid" id="voiceAdv">${advBits.join('')}</div>` : ''}
      <div class="ed-label" style="margin-top:14px"><span>要念的话</span><span class="cnt" id="voiceCnt">${esc(window.CharLimits.cntLine(voiceDraft.text, vB))}</span></div>
      <!-- 输入框用公共 ui.css 的 .ui-ta（与工作台、素材库那些多行输入同一套边框与圆角），
           不再在这一页另写一条 textarea 规则 —— 四个页面四种边框就是这么来的。 -->
      <textarea id="voiceText" class="ui-ta" rows="3" placeholder="这一句配音要念出来的内容">${esc(voiceDraft.text)}</textarea>
      <div class="hint err" id="voiceLenWhy" style="margin-top:4px"${vLenWhy ? '' : ' hidden'}>${esc(vLenWhy)}</div>
      <div class="btn-row">
        <button class="tool acc" id="voiceAdd" ${voiceCanSynth && !vLenWhy ? '' : 'disabled'} title="${esc(wayWhy || vLenWhy || '合成这一句并加到轨道上（会真发一次请求并计费，点第二下确认）')}">${icon('sparkles', 14)} 合成并加到这一轨</button>
        <button class="tool" id="voiceFile" title="打开统一资源选择器：从资产库 / 我的收藏里挑一条现成的音频，或在这里上传本机文件（不发请求、不计费）">${icon('upload', 14)} 放一条音频（库里 / 本机）</button>
      </div>
      <!-- AI 润色「要念的话」：与工作台语音栏是同一个公共面板（InlinePolish），
           文案走 TextAI.prompt('audio') 那一套（朗读稿，全站同一份提示词）。
           润色只是改这一句的字，不合成、不计费，所以不用二次确认。 -->
      <div class="btn-row">
        <button class="tool" id="voicePolishBtn" title="调用文字 AI 改写这一句配音（密钥在「设置」配置；只改字，不合成）">${icon('sparkles', 14)} AI 润色这一句</button>
      </div>
      <div id="voicePolish" hidden></div>
      ${voiceBalOut && boolProv && voiceBalOut === boolProv.id ? `
      <div class="ui-note err" style="margin-top:8px">上一次合成这一家回了「余额 / 额度不够」（这只是上一轮的回执，<b>不会拦你</b> —— 再点一次照样真发请求）
        <button class="tool mini" id="voiceBalGo" style="margin-left:6px">去「用量与余额」</button></div>` : ''}
      <div class="hint">合成会真的发一次请求（按这一家的计费走），所以点第二下才确认。合成后它是轨道上的块：点它选中，切头尾与删掉都在那根剪辑条上，音量在那张卡的滑块上。</div>
      </div>
      <div class="grp" id="grpSub">
      <!-- 「字幕」：entries 是候选源秒，显示与导出都走 mapToFilm。
           台词仍是唯一来源（sh.line）；手改 / 导入 / 识别出来的字幕是快照，不会反写台词。 -->
      <div class="ed-label" style="margin-top:14px"><span>字幕</span><span class="cnt">${subCur.entries.length} 条 · ${subCur.derived ? '按台词/配音现派生' : subCur.source === 'asr' ? '自动识别' : subCur.source === 'manual' ? '手改/导入' : '按台词/配音'}</span></div>
      <div class="hint">${esc(subWhere)}</div>
      ${subStaleTxt ? `<div class="ui-note warn" style="margin-top:6px">${esc(subStaleTxt)}</div>` : ''}
      ${subCur.lineMismatch ? '<div class="ui-note warn" style="margin-top:6px">配音文本与台词不是同一句：字幕目前按配音来（要按台词重新生成，点下面「从台词生成字幕」）</div>' : ''}
      ${subRows.length ? subRows : '<div class="hint">这一镜还没有字幕。可以从台词 / 配音生成，导入一段 SRT，或对这条素材自动识别。</div>'}
      <div class="btn-row" style="margin-top:8px">
        <button class="tool acc" id="subGen" title="按这一镜的台词与已合成配音重新派生字幕（会替换现在这一份，可 Ctrl+Z 退回）">${icon('sparkles', 14)} 从台词生成字幕</button>
        <button class="tool" id="subAdd" title="在插针指着的那一秒加一条手写字幕（2 秒，右栏里改字）">${icon('plus', 14)} 在插针处加一条</button>
      </div>
      <div class="btn-row">
        <button class="tool" id="subImport" title="导入 .srt：文件里的时间按成片秒解释，落在本镜的那几条会折回源秒">${icon('upload', 14)} 导入 SRT</button>
        <button class="tool" id="subExport" title="把全片字幕导出成 .srt（时间是成片秒；这一步不依赖渲染）">${icon('download', 14)} 导出 SRT</button>
        <button class="tool" id="subAsr" ${subAsrBusy ? 'disabled' : ''} title="用语音识别把这条素材里的话变成字幕（会真跑一次识别；结果不会反改台词与配音）">${icon('mic', 14)} ${subAsrBusy ? '识别中…' : '自动识别'}</button>
      </div>
      <div class="ed-label" style="margin-top:14px"><span>样式</span><span class="cnt">预览 / 烧录 / FCPXML 共用这一份</span></div>
      <div class="adv-grid" id="subStyle">
        <div><label>字号（1080p 设计）</label><input type="number" id="subFontSize" min="12" max="300" step="1" value="${subSt.fontSize}"></div>
        <div><label>颜色</label><input type="color" id="subColor" value="${subSt.color}"></div>
        <div><label>位置</label><select id="subPos">
          <option value="bottom"${subSt.position === 'bottom' ? ' selected' : ''}>底部</option>
          <option value="middle"${subSt.position === 'middle' ? ' selected' : ''}>居中</option>
          <option value="top"${subSt.position === 'top' ? ' selected' : ''}>顶部</option>
        </select></div>
        <div><label>每行字数</label><input type="number" id="subMaxChars" min="8" max="120" step="1" value="${subSt.maxCharsPerEntry}"></div>
      </div>
      <label class="hint" style="display:flex;align-items:center;gap:6px;margin-top:6px">
        <input type="checkbox" id="subHl"${subSt.highlight ? ' checked' : ''}> 高亮背景（只在预览与烧录里生效；FCPXML 标题不写这个样式）
      </label>
      <div class="btn-row" style="margin-top:8px">
        <button class="tool" id="subReseg" title="按「每行字数」把长字幕切成几条：内容不变，时间按字数比例分">${icon('rows', 14)} 按每行字数重切</button>
      </div>
      <div class="hint">导出成片时会自动烧录字幕（每条栅格化成与成片同宽高的 PNG）；FCPXML 里写成标题，媒体包另带 subtitles.srt。这些样式在 FCP 标题里只能表达字号 / 颜色 / 位置，背景与高亮只在预览和烧录里生效。</div>
      </div>
      <div class="grp" id="grpVoiceList">
      ${n ? `
      <div class="ed-label" style="margin-top:14px"><span>这一镜上的配音</span><span class="cnt">${n} 句</span></div>
      <div class="vc-list">${shotVoices(sh.id, c && c.vid).map(v => {
        const s = t ? t.segs[Math.min(t.segs.length - 1, Math.max(0, Number(v.seg) || 0))] : null;
        return `<div class="vc-row" data-vid="${esc(v.id)}" title="点这一行选中它（右栏换到音量与倍速那一格）">
          <b>${esc(String(v.name || v.text || '配音').slice(0, 14))}</b>
          <span>${s ? '第 ' + (t.segs.indexOf(s) + 1) + ' 段 +' + round1(v.at) + 's' : '段不在了'} · ${round1(Number(v.dur) || 0)}s${Number(v.vol == null ? 1 : v.vol) !== 1 ? ' · 音量 ' + Math.round(Number(v.vol) * 100) + '%' : ''}${Number(v.spd) === 1 ? '' : Number(v.spd) ? ' · 倍速 ' + spdTxt(Number(v.spd)) : ''}</span>
          <button class="ghost mini" data-vplay="${esc(v.id)}" title="试听这一句">${icon('play', 11)}</button>
          <button class="ghost mini" data-vdel="${esc(v.id)}" title="删掉这一句配音">${icon('trash', 11)}</button>
        </div>`;
      }).join('')}</div>` : `
      <div class="ed-label" style="margin-top:14px"><span>这一镜上的配音</span><span class="cnt">还没有</span></div>
      <div class="hint">这一镜还没有配音。切到「生成配音」自己写一句（或从台词那一轨点一个待生成的占位），合成后它会作为块出现在这一条配音轨上。</div>`}
      </div>
    </div>`;
  /* 这一段音量 / 画面倍速 / 配音倍速 / 两条轨按行的音量这几枚滑块：每一枚都是它那个值的唯一出口
     （0–200% / 0.25–4，步进 0.1 与 0.05 = 无级）。`input` 里只改读数与正在响的声音，松手（`change`）
     才写数据 + 落盘 —— 逐像素写盘会把 filmEdited 的那一串重渲染打成一片，而正在拖的那只手底下的节点会被换掉。 */
  const sv = col.querySelector('#tlVol');
  if (sv) {
    sv.addEventListener('input', () => {
      const rd = col.querySelector('#tlVolVal');
      if (rd) rd.textContent = Math.round(Number(sv.value) || 0) + '%';
      const vv = tlVoiceHit();
      if (vv && voiceEl && !voiceEl.paused) { try { voiceEl.volume = Math.max(0, Math.min(1, Number(sv.value) / 100)); } catch (e) {} }
    });
    sv.addEventListener('change', () => setCutVol(Math.max(0, Math.min(2, Number(sv.value) / 100))));
  }
  const spSl = col.querySelector('#tlSpd');
  if (spSl) {
    spSl.addEventListener('input', () => {
      /* 主读数与最下面那句「源 X 秒 → 成片 Y 秒」跟着手一起走（问的是同一份 `segLenText`）：
         只改主读数就是「拇指已经拖过去，那一格在成片里占多久还在说旧数」。 */
      const r = Number(spSl.value) || 1;
      const rd2 = col.querySelector('#tlSpdVal');
      if (rd2) rd2.textContent = spdTxt(r);
      const w = cutSpdSeg();
      const ln2 = col.querySelector('#tlAdjLen');
      if (w && ln2) ln2.textContent = segLenText(w.segs[w.i], r);
    });
    spSl.addEventListener('change', () => setCutSpd(Number(spSl.value)));
  }
  /* 配音那一枚倍速：与画面那枚同一套两拍（`input` 只改读数与正在响的那一句，`change` 才写数据 + 落盘）。
     正在试听的那一句当场跟着变 —— 拖完听不出区别就又回到「调了没反应」那一类。 */
  const vspSl = col.querySelector('#tlVoiceSpd');
  if (vspSl) {
    vspSl.addEventListener('input', () => {
      const r = Number(vspSl.value) || 1;
      const vv = tlVoiceHit();
      /* 两处读数一起跟着手走：主读数、最下面那句「这一句念几秒」。
         从前 `input` 只改主读数，界面上就是「×1.5」配一句还写着 ×1 / 念 1 秒的旧账（用户点名的
         配音倍速显示错误），非要松手、整栏重画才改口 —— 同一个组件里两个数互相打架。 */
      const rd3 = col.querySelector('#tlVoiceSpdVal');
      if (rd3) rd3.textContent = spdTxt(r);
      const ln3 = col.querySelector('#tlAdjLen');
      if (vv && ln3) ln3.textContent = voiceLenText(vv, r);
      if (vv && voiceEl && !voiceEl.paused && voiceEl.__vid === vv.id) {
        try { voiceEl.playbackRate = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, r)); } catch (e) {}
      }
    });
    vspSl.addEventListener('change', () => setVoiceSpd(Number(vspSl.value)));
  }
  /* 三枚「整轨」滑块：与段 / 句那几枚各调各的，同一套两拍（`input` 只改**自己这一格**的读数、
     `change` 才对着清单批量写数据 + 落盘）。拖动中途不改指着那一段的读数 —— 它管的是整排，
     把手底下的那一枚数值算进某一段就是「一句读数同时说两件事」。 */
  const trackSlOn = (id, rdId, fmt, write) => {
    const el = col.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => {
      const rd = col.querySelector('#' + rdId);
      if (rd) rd.textContent = fmt(el.value);
    });
    el.addEventListener('change', () => write(el.value));
  };
  trackSlOn('tlSpdTrack', 'tlSpdTrackVal', x => spdTxt(Number(x) || 1), val => setTrackSpd(Number(val)));
  trackSlOn('tlVoiceSpdTrack', 'tlVoiceSpdTrackVal', x => spdTxt(Number(x) || 1), val => setTrackVoiceSpd(Number(val)));
  trackSlOn('tlVolTrack', 'tlVolTrackVal', x => Math.round(Number(x) || 0) + '%', val => setTrackVol(Number(val) / 100));
  /* 那两枚「按行的音量」（画面轨 / 配音轨）：同一套 `input` 只改读数、`change` 才写数据。
     调的是**芯片所指那一段/那一句所在那一行**的基数（`paintTlAdjust` 每次重画都把行号写进 `data-ln`），
     不是整条轨 —— 多行之后「整轨」那一个数会把用户刚在第二行调好的音量盖掉。 */
  const laneSl = (id, rdId, k) => {
    const el = col.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => {
      const rd = col.querySelector('#' + rdId);
      if (rd) rd.textContent = Math.round(Number(el.value) || 0) + '%';
    });
    el.addEventListener('change', () => setLaneVol(k, Number(el.value) / 100, Number(el.dataset.ln) || 0));
  };
  laneSl('laneVolPic', 'laneVolPicVal', 'pic');
  laneSl('laneVolVoice', 'laneVolVoiceVal', 'voice');
  const lUp = col.querySelector('#laneUp'); if (lUp) lUp.onclick = () => setCutLane(-1);
  const lDn = col.querySelector('#laneDown'); if (lDn) lDn.onclick = () => setCutLane(1);
  /* 卡片建好之后立刻跟着现算一次：中栏那一排在**这一栏之前**就调过 syncTlTools，
     那时这张卡还不存在（那里全部是 getElementById 的守卫，所以它什么都不写也不报错）。
     不补这一句就是「滑块画在 100%，而芯片指着的那一段其实调到了 30%」。 */
  syncTlTools();
  const sync = el => { if (window.Dropdowns) Dropdowns.sync(el); };
  const vm = col.querySelector('#voiceModel');
  if (vm) vm.onchange = () => {
    proj.voiceModel = vm.value;
    /* 顶层开关那一排也跟着清：换到别家之后，上一家那些开关的名字多半根本不存在，
       留着会被带进提交体（那一族的判据是「没声明的字段照发」）。 */
    voiceDraft.voice = ''; voiceDraft.format = ''; voiceDraft.tb = {};
    renderEditor(); scheduleSave();
  };
  const vp = col.querySelector('#voicePick');
  if (vp) { vp.onchange = () => { voiceDraft.voice = vp.value; }; sync(vp); }
  const vf = col.querySelector('#voiceFmt');
  if (vf) { vf.onchange = () => { voiceDraft.format = vf.value; }; sync(vf); }
  /* 顶层开关（create.topBools）：与工作台同一颗磁贴、同一个点法（TtsAdv.bindTopBools）。
     状态存在 voiceDraft.tb 上，换平台/型号时跟着 voice/format 一起清（见 voiceModel 的 onchange）。 */
  const advBox = col.querySelector('#voiceAdv');
  if (advBox) {
    if (window.fillIcons) fillIcons(advBox);
    window.TtsAdv.bindTopBools(advBox, voiceDraft.tb, () => scheduleSave());
  }
  /* 就地重画那一颗按钮与两行红字（不重画整栏：整栏重画会把正在敲的描述框换掉、光标跳走）。
     以前这里只在预设 / 设计两档按字数点亮按钮 —— 复刻档选完参考音频按钮还是灰的，
     而「描述空着」这一条压根没人判（判据在 `voiceWayWhy` 那一份，这里只是把它写回 DOM）。 */
  const paintVoiceGate = () => {
    const ww = voiceWayWhy(way, voiceDraft), lw = voiceLenWhy(way, voiceDraft, tts);
    const w1 = col.querySelector('#voiceWayWhy');
    if (w1) { w1.textContent = ww; w1.hidden = !ww; }
    const w2 = col.querySelector('#voiceLenWhy');
    if (w2) { w2.textContent = lw; w2.hidden = !lw; }
    const btn = col.querySelector('#voiceAdd');
    if (btn) {
      btn.disabled = !!(ww || lw);
      btn.title = ww || lw || '合成这一句并加到轨道上（会真发一次请求并计费，点第二下确认）';
    }
  };
  const vt = col.querySelector('#voiceText');
  if (vt) vt.oninput = () => {
    voiceDraft.text = vt.value;
    const cnt = col.querySelector('#voiceCnt');
    /* 就地那一下写的必须还是整句（`N 字 · 这一家 5–5000 字`）：以前这里只写 `N 字`，
       于是敲第一个字就把声明的区间从界面上抹掉了 —— 初像里有、打一个字就没有的读数等于没说。 */
    if (cnt) cnt.textContent = window.CharLimits.cntLine(vt.value, vB);
    paintVoiceGate();
  };
  const vd = col.querySelector('#voiceDesign');
  if (vd) vd.oninput = () => { voiceDraft.design = vd.value; paintVoiceGate(); };
  /* 取一位素材身上写好的音色描述填进这一格。整链（开哪一档、空描述怎么说、覆盖前先问一句）
     在公共层 `VoiceNote.run` —— 生成工作台那一格走的是同一条链，两处各拼一份迟早有一种说法在骗人。 */
  const vdp = col.querySelector('#voiceDesignPick');
  if (vdp) vdp.onclick = () => window.VoiceNote.run({
    value: () => vd.value,
    write: t => { vd.value = t; voiceDraft.design = t; paintVoiceGate(); },
    say: setStatus,
  });
  const vpb = col.querySelector('#voicePolishBtn');
  if (vpb) vpb.onclick = () => polishVoiceText(col);
  const vrp = col.querySelector('#voiceRefPick');
  if (vrp) vrp.onclick = async () => {
    const rule = (boolProv && window.Capabilities && Capabilities.rule)
      ? Capabilities.rule(boolModel, 'reference_audio', '') : {};
    const got = await AssetPicker.open({
      types: ['音频', '音乐'], multiple: false, limit: 1, title: '选择音色素材（参考音频）',
      /* 第四个来源「素材库」：那位身上挂着的参考音频就是它的音色复刻材料，
         字节由选择器在点「确定」那一刻现取（开弹窗时不读几十 MB）。 */
      chars: 'audio',
      rule: rule, note: '这一条只用来让平台复刻音色，不会被铺到轨道上；要铺一句成品请用下面的「放一条音频」。',
    });
    if (!got || !got.length) return;
    const it = got[0];
    /* 素材库那一段在本机取不到字节（换过机器、IndexedDB 被清）：当场说清、槽位原地不动。
       递一条没有字节的进去等于「已选：小雅 · 参考音频」配一句「合成时要有参考音频」的自相矛盾。 */
    if (it.dead) { setStatus('<span class="err">' + esc(it.dead) + '</span>'); return; }
    /* 体积先按这一家声明的上限拦一次：发到平台再被拒，用户白等一轮还看不懂原因。 */
    const cap = Number((rule && rule.maxBytes) || 0);
    if (cap) {
      const b = it.file || null;
      const size = b ? b.size : Number(it.byteLength || it.bytes || 0);
      if (size && size > cap) { setStatus('<span class="err">这条参考音频 ' + window.fmtBytes(size) + '，超过这一家的上限 ' + window.fmtBytes(cap) + '（换短一点的片段）</span>'); return; }
    }
    voiceDraft.ref = { assetId: it.assetId || '', src: it.src || it.url || '', name: it.name || it.prompt || '', file: it.file || null };
    setStatus('<span class="ok">✓ 已选音色素材：' + esc(voiceDraft.ref.name || '这一条') + '（点「合成并加到这一轨」才会真发请求）</span>');
    renderEditor(); scheduleSave();
  };
  const vrd = col.querySelector('#voiceRefDel');
  if (vrd) vrd.onclick = () => { voiceDraft.ref = null; renderEditor(); };
  const vbg = col.querySelector('#voiceBalGo');
  if (vbg) vbg.onclick = () => (window.GoPage ? GoPage.go('usage.html') : (location.href = 'usage.html'));
  /* 孤句搬回选用的那一条：只换锚点，不动音频文件本身，所以不重复计费、也不新建任务。
     拒绝的那几条（锁着 / 没有选用候选 / 没有画面段）由 `adoptWhy` 说清，按钮一开始就压暗。 */
  const vop = col.querySelector('#voiceAdopt');
  if (vop) vop.onclick = () => {
    const r = adoptOrphanVoices(curShot());
    if (!r.ok) { setStatus('<span class="err">搬不了：' + esc(r.why) + '</span>'); paintVoiceOrphan(); return; }
    setStatus('<span class="ok">已把 ' + r.n + ' 句配音搬到「用这条」选中的那一条上，全片那一轨跟着有了</span>');
    filmEdited();
  };
  paintVoiceOrphan();
  /* 那张牌上原来的「仍然再试一次」撤了：拦截本身已经取消，再摆一颗「再试」只会让人以为默认不给试。 */
  const add = col.querySelector('#voiceAdd');
  if (add) add.onclick = () => {
    if (Confirm.arm(add, '确认合成？', { note: '这一句会发一次真请求并计费' })) return;
    addVoiceAtPin();
  };
  const fin = col.querySelector('#voiceFile');
  if (fin) fin.onclick = async () => {
    /* 统一资源选择器（与上面「选参考音频」同一个组件、同一套来源）：资产库 / 我的收藏 / 本机文件，
       上传也在弹窗里做。原来这里只挂一个系统文件框，库里那条现成的音频反而选不到 ——
       而「先攒几条别的配音 / 音效，再挑一条铺上来」才是这条路的常用形状。 */
    const got = await AssetPicker.open({
      types: ['音频', '音乐'], multiple: false, limit: 1,
      title: '挑一条音频铺到这一轨上',
      note: '这一条会作为配音铺在插针指着的那一秒（不发请求、不计费）；本机文件也可以，选择器里会先把它存成本机素材。',
    });
    if (!got || !got.length) return;
    const it = got[0];
    let src = String(it.src || it.url || '');
    if (it.fromLocal && it.file) {
      /* blob: 不是「记得住的」地址（刷新即没，而这一条 src 要活到下一次导出成片）→ 先转存本机资产。
         与语音台那条同一立场：写进 proj.voices 的地址必须下次还能取到字节。 */
      try { src = await localAudioAsset(it.file); }
      catch (e) { setStatus('<span class="err">这条本机音频没能存进本机：' + esc(e.message) + '（轨道上不留它）</span>'); return; }
    }
    if (!src || /^blob:/.test(src)) { setStatus('<span class="err">这一条没有能长期记住的地址：换一条，或先把它「存回本机」</span>'); return; }
    await addVoiceEntry(src, sh, c, { name: it.name || it.prompt || '', text: '', provider: '本机', model: '', voice: '' });
  };
  col.querySelectorAll('[data-vplay]').forEach(b => b.onclick = () => playVoicePreview(b.dataset.vplay));
  /* 三档小选项：只翻 hidden（paintTlGroups 一处），不重建这一栏 —— 重建会把正在敲的那格换掉、光标跳走。 */
  col.querySelectorAll('#vcTabs [data-vctab]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.vctab;
      if (!k || k === vcTab) return;
      vcTab = k;
      paintTlGroups();
    };
  });
  /* 「台词」那一档两段：改字直接写 sh.line / sh.lineWho（松手后成片标脏、待生成轨跟着重画）；
     点缩略图 / 标题 = 切到那一镜、把这一句填进合成框（与轨道占位同一个出口）。 */
  bindLineEditors(col, sh);
  /* 清单里点一行 = 选中这一句（与轨道上点这一块同一个出口 `selectVoice`，右栏跟着换到音量与倍速）。 */
  col.querySelectorAll('.vc-row').forEach(r => {
    r.onclick = e => {
      if (e.target.closest('[data-vplay]') || e.target.closest('[data-vdel]')) return;
      selectVoice(r.dataset.vid);
    };
  });
  col.querySelectorAll('.vc-row [data-vdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (Confirm.arm(b, '确认删掉？', { note: '只删这一句配音，画面不动' })) return;
    proj.voices = voicesEnsure().filter(v => v.id !== b.dataset.vdel);
    if (proj.curVoice === b.dataset.vdel) proj.curVoice = '';
    setStatus('<span class="ok">✓ 已删掉那一句配音（画面没动，成片时长不变）</span>');
    filmEdited();
  });
  /* 字幕那一格：每个入口都先 beginEdit（可撤销）再写，写完全走 filmEdited。 */
  const sg = col.querySelector('#subGen');
  if (sg) sg.onclick = () => subGenerate(sh);
  const sAdd = col.querySelector('#subAdd');
  if (sAdd) sAdd.onclick = () => subAddAtPin(sh);
  const sImp = col.querySelector('#subImport');
  if (sImp) sImp.onclick = () => subImportSrt(sh);
  const sExp = col.querySelector('#subExport');
  if (sExp) sExp.onclick = () => subExportSrt();
  const sAsr = col.querySelector('#subAsr');
  if (sAsr) sAsr.onclick = () => subAsr(sh);
  const sRes = col.querySelector('#subReseg');
  if (sRes) sRes.onclick = () => subResegment(sh);
  col.querySelectorAll('[data-subtext]').forEach(ta => {
    ta.onchange = () => subSetText(sh, Number(ta.dataset.subtext), ta.value);
  });
  col.querySelectorAll('[data-subdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    subDelete(sh, Number(b.dataset.subdel));
  });
  const sfs = col.querySelector('#subFontSize');
  if (sfs) sfs.onchange = () => subStyleWrite(sh, { fontSize: Number(sfs.value) || 54 }, '改字幕字号');
  const sCol = col.querySelector('#subColor');
  if (sCol) sCol.onchange = () => subStyleWrite(sh, { color: sCol.value }, '改字幕颜色');
  const sPos = col.querySelector('#subPos');
  if (sPos) sPos.onchange = () => subStyleWrite(sh, { position: sPos.value }, '改字幕位置');
  const sMc = col.querySelector('#subMaxChars');
  if (sMc) sMc.onchange = () => subStyleWrite(sh, { maxCharsPerEntry: Number(sMc.value) || 24 }, '改字幕每行字数');
  const sHl = col.querySelector('#subHl');
  if (sHl) sHl.onchange = () => subStyleWrite(sh, { highlight: !!sHl.checked }, '改字幕高亮');
  if (window.Dropdowns) Dropdowns.build(col);
}
/* 复刻用的参考音频 → base64 data URL（接口收的就是它，不是地址）。
   取字节只有一条通道：`AssetTransfer.blobOf` 认得本机资产 / 本机文件 / 平台资产 / 外链，
   与语音台 `audioRefBase64` 是同一套判据 —— 各写一份就会出现「工作台能复刻、导演台同一张图取不到」。 */
async function refAudioBase64(ref) {
  if (!ref) throw new Error('没有选参考音频');
  const blob = ref.file || await AssetTransfer.blobOf(ref.src || ref.assetId);
  if (!blob) throw new Error('这条音频取不到字节（外链可能已经过期）');
  return await AssetTransfer.toDataURL(blob);
}

/* 本机音频 → 一条长期可用的本机资产（与语音台产物同一个落点，/render 才取得到）。 */
async function localAudioAsset(file) {
  const b64 = await new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => res(String(rd.result).split(',')[1] || '');
    rd.onerror = () => rej(new Error('读这个文件失败'));
    rd.readAsDataURL(file);
  });
  const fmt = String((String(file.name).split('.').pop() || 'mp3')).toLowerCase();
  const saved = await Api.saveLocalAsset({ name: file.name, mime: file.type || ('audio/' + fmt), format: fmt, data: b64,
    meta: { provider: '本机', prompt: '' } });
  return saved.url || Api.assetSrc(saved.assetId || saved.id);
}
/* 合成一句 → 量时长 → 存进 proj.voices（锚在插针那一段）→ 重画。
   三个入口（ preset 合成 / design 合成 / 本机音频）都从这里进，所以「加了但没进轨」不可能出现。 */
async function addVoiceEntry(src, sh, c, extra) {
  const t = voiceTarget(curShot(), c);
  if (!t) { setStatus('<span class="err">现在没有可放的位置：这一镜还没有候选（或这一条一段画面都没留）</span>'); return; }
  const dur = await audioDurOf(src);
  const v = Object.assign({ id: uid(), shotId: sh.id, candId: c.vid, seg: t.si, at: t.at, dur, vol: 1, src }, extra || {});
  v.name = v.name || String(v.text || '配音').replace(/\s+/g, ' ').trim().slice(0, 12);
  voicesEnsure().push(v);
  /* 这一条音频若还是第三方外链（导入的 FCPXML / 平台返回的临时地址），顺手存一份到本机：
     配音导出与 waveform 解码都读得到字节，不靠会过期的链接。 */
  if (needsLocal(v.src)) {
    autoLocalize([{
      entry: { kind: 'asset', provider: v.provider || 'remote', src: v.src, name: v.name },
      name: v.name || '配音',
      apply: url => { v.src = url; scheduleSave(); },
    }]);
  }
  /* 走 selectVoice 而不是裸写 `proj.curVoice`：加完这一句，上面那一排剪子与滑块就该指着它
     （目标是「最后点的那一轨」，而「刚加了一句」正是最后碰的是声音轨）。 */
  selectVoice(v.id);
  setStatus('<span class="ok">✓ 已加到第 ' + (t.si + 1) + '/' + t.segs.length + ' 段的 +' + t.at + ' 秒处，长 ' + dur + ' 秒'
    + (candSelected(sh, c) ? '；这一条已选用，合并成片会带上' : '；这一条还没被选用，换成它或点「用这条」才进成片') + '</span>');
  filmEdited();
}
async function addVoiceAtPin() {
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先挑一个镜头</span>'); return; }
  const cands = sh.candidates || [];
  const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
  if (!voiceTarget(sh, c)) { setStatus('<span class="err">没有可放的位置：这一镜还没有候选（或这一条一段画面都没留，按 Ctrl+Z 退回剪切之前）</span>'); return; }
  const text = String(voiceDraft.text || '').trim();
  if (!text) { setStatus('<span class="err">先写上要念的话</span>'); return; }
  const way = voiceWayOf(voiceReg(), proj.voiceModel || '');
  const tts2 = (way.target && way.target.prov && way.target.prov.tts) || {};
  /* 花钱前的最后一道闸：与右栏那颗按钮同三个函数（`voiceSynthWhy` = 这一档缺必填 + 字数区间）。
     按钮禁用管的是「点不下去」，这里管的是「导入的旧草稿 / 别处改了的字」—— 两道同一份数。
     以前这里只查字数，于是「音色设计型号没写描述」也照样发出去（`{{style}}` 空值被模板整项省略），
     而界面上写着「这一家按描述定音色」。 */
  const why0 = voiceSynthWhy(way, voiceDraft, tts2);
  if (why0) { setStatus('<span class="err">' + esc(why0) + ' —— 补好再合成</span>'); return; }
  if (way.mode === 'preset' || way.mode === 'design' || way.mode === 'clone') {
    const target = way.target;
    const pid = (target && target.prov && target.prov.id) || '';
    /* **不再拦**（2026-10 用户要求）：以前这里会查「这一家十分钟内报过余额不足吗」，
       报过就先不发、只在声音栏挂一句提示 —— 可用户充完值时它照样拦着，看起来就是
       「充值后还一直报余额不足」。现在的规矩是：**用户点一次就真发一次请求**，
       平台说不够就不够（照实报出来，并把出口给到），我们不再替他省这一轮。 */
    setStatus('<span class="meta">正在合成这一句…</span>');
    let r;
    try {
      /* 「音色怎么给」三档各有各的给法（与语音台同一套约定，收口在 AiGen.synthTts 的 voice 参数）：
         预设递音色 id、设计递空串（描述另走 style）、**复刻递参考音频的 base64**。
         以前这里只有前两种，复刻档压根没入口 —— 现在补齐（取字节走公共通道 AssetTransfer）。 */
      let voiceValue = '';
      if (way.mode === 'preset') voiceValue = voiceDraft.voice;
      else if (way.mode === 'clone') {
        setStatus('<span class="meta">正在把参考音频交给平台…</span>');
        try { voiceValue = await refAudioBase64(voiceDraft.ref); }
        catch (e) { setStatus('<span class="err">这条参考音频取不到字节：' + esc(String(errText(e))) + '（换一条或先在资产库里把它存回本机）</span>'); return; }
      }
      r = await AiGen.synthTts(target.prov, {
        model: target.model.id || target.model.name, text,
        style: way.mode === 'design' ? String(voiceDraft.design || '').trim() : '',
        voice: voiceValue, format: voiceDraft.format,
        /* 合成设置里的顶层开关（create.topBools）：与工作台语音栏同一个读法（TtsAdv.read），
           只取这一家声明里「这一次没被藏掉」的那几项 —— 界面上没画的自然不该出现在请求体里。 */
        bools: window.TtsAdv.read(target.prov, { mode: '', intent: '', caps: null }, voiceDraft.tb).topBools,
      });
    } catch (e) {
      /* 余额 / 额度不够：除了那句人话（Api 的 ERROR_HINT 已经补了），
         再把「去用量与余额」那个出口挂到声音栏上 —— 状态行过 sanitizeHTML，
         button 会被抹成纯文本，所以能点的东西只能画在这一栏里。 */
      const bal = !!(window.Api && Api.isBalanceErr(e));
      if (bal && pid) { Api.balOut.mark(pid); voiceBalOut = pid; }
      /* 报错里补上「这一次真正发给谁 · 哪个型号」：余额不足这句话是平台自己的原话，
         但它不说是哪一家的余额（用户可能同时配了三家语音），而没有型号时也看不出
         「是不是发错了型号」—— 上一轮「模仿音色用不了」就是因为能力刷新把型号声明抹掉之后
         选中的型号与真正发出去的那一个对不上。这两条都在这一句里给出来，下次一眼能断。 */
      setStatus('<span class="err">合成失败：' + esc(String(errText(e))) + '</span>'
        + '<span class="meta">（发给 ' + esc((target.prov.displayName || target.prov.id || '?'))
        + ' · ' + esc(target.model.id || target.model.name || '?') + '）</span>'
        + (bal ? ' —— 声音栏里有「去用量与余额」的入口' : ''));
      if (bal) renderEditor();
      return;
    }
    /* 合成成了：把「这一家刚报过余额不足」那笔账清掉，声音栏那张牌也收起来 */
    if (pid && window.Api) Api.balOut.clear(pid);
    if (voiceBalOut) { voiceBalOut = ''; }
    await addVoiceEntry(r.url, sh, c, {
      text, provider: target.prov.id, model: target.model.id || target.model.name,
      voice: way.mode === 'preset' ? voiceDraft.voice
        : (way.mode === 'clone' ? '按参考音频复刻' : '按描述定音色'),
    });
    return;
  }
  setStatus('<span class="err">' + esc(way.why) + '</span>');
}


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
function stampName(ext) {
  /* 时间戳与非法字符各归公共一份（`web/ui/ui.js` 的 `fileStamp` / `fileSafe`，§J ⑲ 守着）；
     这一页只管形状：「项目名-成片-年月日-时分秒.扩展名」。
     项目名以前不截断，而 Windows 的整条路径有上限 —— 现在跟着 fileSafe 收到 60 个字。 */
  return window.fileSafe((proj && proj.name) || '成片', 60) + '-成片-' + window.fileStamp() + '.' + ext;
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
  /* 编码器要偶数宽高；范围与 /render 的夹取同一档（64–4096）。不合法的旧值当作没有。 */
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
  } catch (e) {}
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

function shotModels(sh) {
  /* 按这一镜**已经用上的输入 role** 筛模型（不再按 mode 名匹配）：
     上游 /models 的 mode 名字各平台不一样（SparkCine 是 image_to_video / multimodal_reference，
     页面自己用的是 first_last_frame / reference_images），按名字过滤会让加了首尾帧之后
     支持它的模型反而从下拉里消失。role 是提交模板的通用语言，按它筛才是对的。 */
  const need = shotUsedRoles(sh);
  /* Api.pickable：设置页勾掉「暂时不用」的那一家不出现在这一段可选的视频平台里 */
  const provs = Api.pickable((REG?.providers || []).filter(p => p.kind === 'video'));
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
   指针名字故意避开公共层那两个（§J 把页面里同名的 `function` 定义当第二份实现）。 */
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
/* 这一镜已经用到的输入 role（keyframes 与参考图同属 reference_image：提交时二选一） */
function shotUsedRoles(sh) {
  if (!sh) return [];
  const used = [];
  if (sh.firstFrame) used.push('first_frame');
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
    first_frame: sh.firstFrame ? 1 : 0,
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
async function shotInputEntries(sh, prov, ic) {
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
  const frames = [['first_frame', sh.firstFrame, '首帧'], ['last_frame', sh.lastFrame, '尾帧']].filter(x => x[1]);
  needSlot('first_frame', '首帧', sh.firstFrame ? 1 : 0);
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
  try { return await Capabilities.refreshProvider(REG, prov, {}); }
  catch (e) { console.warn('[导演台] 能力接口读取失败（按平台声明展示）：', e.message); return null; }
}

/* 平台对象一律来自注册路由（/registry），别写死某个平台 —— 接新供应方时页面不用改 */
/* 「这个模型属于哪一家平台」。
   ⚠ 以前这里有一个**兜底**：找不到就默默取第一家视频平台。那是错的，而且错法极其隐蔽：
     项目里两家视频平台的型号 id 形状不同（SparkCine 是 `h3-video`，VGENV 是 `minimax/h3`），
     而上游校验是 `model must match /^[a-z0-9][a-z0-9._-]*\/...$/` ——
     于是「模型属于 A、请求发给了 B」表现为**一个看不懂的 model 格式错误**，
     而界面上「型号」那一栏明明选的是 A（用户什么都没做错）。
   常见触发：换了端口 / 清过缓存 / 恢复过设置，REG 里的 id 与工作区里存着的 providerId 对不上。
   所以现在**绝不兜底到另一家**：认不出就返回 null，由调用方报一句说清原因的话
   （「这个型号属于「xxx」，但当前注册表里没有这一家 —— 到设置页重新勾一下」）。 */
function provOf(providerId) {
  const list = (REG?.providers || []);
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
function addRefImage(sh, src, label) {
  sh.refImages.push(src);
  sh.refMeta = Array.isArray(sh.refMeta) ? sh.refMeta : [];
  sh.refMeta.push({ label: label || null });
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
  addRefImage(sh, pic, label);
  return { ok: true, label: label };
}
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
  if (c.kind !== 'lib') { ta.focus(); try { ta.setSelectionRange(caret, caret); } catch (e) {} return; }
  const r = addLibPicToShot(sh, c.entry, pick);
  renderEditor(); scheduleSave();
  const ta2 = $('edPrompt');
  if (ta2) { ta2.focus(); try { ta2.setSelectionRange(caret, caret); } catch (e) {} }
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
  return '<div class="ed-label" style="margin-top:12px"><span>输入模式</span><span class="cnt">'
    + esc(comboNote(cb)) + '</span></div>' + (chips ? '<div class="mode-row" id="modeRow">' + chips + '</div>' : '');
}
/* 芯片的接线：整块编辑器每次重绘都重建这一段，所以每次重画后绑一次就够了。 */
function bindModeChips(sh) {
  const row = $('modeRow');
  if (!row) return;
  row.querySelectorAll('.ui-pill').forEach(b => { b.onclick = () => setShotCombo(sh, b.dataset.cid); });
}
/* 每一镜的两把尺子（本镜第一段保留区 / 全片第一格）现算一次就留在这张表里：
   台词行本身不改变几何 —— 打字时只照着它把那两个读数补一遍（`paintLineWhen`），
   不必为一次击键把整片时间线重算。清单每次重画都重建这张表。 */
let lineGeoCache = new Map();
function lineTimeFor(geo, line) {
  const est = lineEstSec(line);
  return lineTimeOf({
    shot: geo.r0 ? lineSpanAt(geo.r0, (geo.r0.s || {}).in, est, false) : null,
    film: geo.fr ? lineSpanAt(geo.fr, geo.fr.cl.in, est, true) : null,
  });
}
/* 台词那一档的每一行：一行 = 一镜的一句台词，读的是 sh.line / sh.lineWho 这一份数据，
   与轨道上那两个待生成占位同一个判据 `pendingLineOf`（界面里不存在第二份「有没有配过音」的账）。
   两个时间读数各走自己那一排的尺子（`lineSpanAt`，与占位符同一把）：
     · 本镜 —— 这一镜第一段保留区的起点起的**轴秒**；
     · 全片 —— 这一镜第一格在**成片**里的起点起的成片秒。
   全片那一排先按镜头归一次：`filmFrames` 的缓存认的是 tl 的对象引用，而 `tlSyncFromShots`
   每次都造新对象，逐行现算就是每一行把全片几何重算一遍。
   `includeEmptyMine`：当前这一镜即使还没台词也留一行，否则「在本镜台词里写第一句」指向一片空气。 */
function linePanelRows(curSh, opts) {
  const includeEmptyMine = !!(opts && opts.includeEmptyMine);
  const lib = (window.Chars && window.Chars.Lib && window.Chars.Lib.list()) || [];
  const filmRow = new Map();
  filmFrames(tlSyncFromShots()).rows.forEach(r => {
    const cl = r.cl;
    if (cl && cl.kind === 'shot' && !filmRow.has(cl.shotId)) filmRow.set(cl.shotId, r);
  });
  lineGeoCache = new Map();
  const rows = allShots().map((x, i) => ({ x: x, no: i + 1 }))
    .filter(o => (includeEmptyMine && o.x === curSh) || String((o.x && o.x.line) || '').trim())
    .map(o => {
      const cands = o.x.candidates || [];
      const c = cands.find(y => y.vid === o.x.selId) || cands[0] || null;
      const segs = c ? segsOf(c, candDur(c, o.x)) : [];
      const r0 = segs.length ? shotFrames(segs).rows[0] : null;
      const geo = { r0, fr: filmRow.get(o.x.id) || null };
      lineGeoCache.set(o.x.id, geo);
      const text = String(o.x.line || '');
      return {
        sh: o.x, no: o.no,
        text,
        who: String(o.x.lineWho || ''),
        speaker: speakerOf(o.x.lineWho, lib),
        time: lineTimeFor(geo, text),
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
/* 两段共用的行渲染：一行 = 一镜一句台词（说话人缩略图 / 名字 + 镜号 + 本镜与全片两个时间读数）。 */
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
/* 只补一行右边那两个时间：字数变了，这一句在本镜轨与全片轨上占多宽就变了。
   几何照清单上次渲染时那份（`lineGeoCache`）—— 台词自己不动时间线。 */
function paintLineWhen(row, x) {
  const geo = row && lineGeoCache.get(x.id);
  if (!geo) return;
  const t = lineTimeFor(geo, x.line);
  const sp = row.querySelectorAll('.lr-when span');
  if (sp.length < 3) return;
  sp[1].textContent = t.shotText;
  sp[2].textContent = t.filmText;
}
/* 台词就地编辑（这一档两段共用这一份 binder）。
   **不重画整栏**：重画会把正在敲的那一格换掉、光标跳走 —— 所以 `input` 只改数据 + 这一行的状态徽章
   与右边那两个时间 + 两段表头读数，`change`（松手 / 失焦）才 `filmEdited()`：台词**自己就上待生成那一轨**
   （占位由 renderAll 现算），而字幕按台词派生、会烧进成片，所以这一改必须标脏成片并推进修订号。
   撤销快照在第一个字落下之前压（`beginEdit` 拍的是改**之前**那一份）。
   改台词一个字节都不动 `sh.prompt`：提示词改了台词不动，台词改了提示词也不动。 */
function bindLineEditors(root, curSh) {
  if (!root) return;
  /* 一行两件控件（台词在 textarea 的 data-line-text，说话人在 input 的 data-line-who），
     认镜头靠的是行上的 data-lineshot —— 只读一件的 dataset 会让另一件写不进数据。 */
  const of = el => {
    const row = el.closest('.line-row');
    const id = (row && row.dataset.lineshot) || el.dataset.lineText || el.dataset.lineWho || '';
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
      const x = allShots().find(s2 => s2.id === row.dataset.lineshot);
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
  if (!sh) { col.innerHTML = ''; return; }        // 没有镜头先退出，别去解析模型
  const idx = allShots().indexOf(sh) + 1;
  const ic = shotInputCaps(sh);                      // 该模型支持的输入（决定素材/参考入口显不显示）
  const mats = mentionedMats(sh);                    // 「提到素材」那排芯片（= 带来源标签的参考图）
  const vp = videoPlanOf(sh);
  const vk = vp.kinds;
  /* 只回写**这一家声明了**的那些档（没声明时 value 是空串，写回去等于把用户存的值抹掉）。
     duration 写成数字：`sh.duration` 进提交体、进关键帧秒点、进时间线，字符串会到处要比数。 */
  if (vk.tier.list.length) sh.tier = vk.tier.value;
  if (vk.resolution.list.length) sh.res = vk.resolution.value;
  if (vk.aspect_ratio.list.length) sh.ar = vk.aspect_ratio.value;
  /* size 是「宽x高」那一族平台用的画幅写法（SiliconFlow 的 image_size / OpenAI 兼容的 size），
     与 ar（比例）是两种字段 —— 声明了才回写、才发，没声明的这一档一个字都不带。 */
  if (vk.size.list.length) sh.size = vk.size.value;
  if (vk.duration.list.length) sh.duration = Number(vk.duration.value);
  sh.draw = vk.count.list.length ? Number(vk.count.value) : 1;
  /* 剪辑模式打开时右栏整片换成「声音栏」（用户点名的形状：像生成工作台那样合成一句配音，
     加的是剪辑那一轨）。镜头编辑器不画：两套控件同屏只会互相抢同一颗按钮。
     放在**参数回写之后**：那一串回写读的是中栏参数条的活控件，跳过它会让「改时长」在剪辑模式下静默失效。 */
  if (midEditTrim) { renderVoiceCol(col, sh); return; }
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
  col.innerHTML = `
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
        <div class="ed-label" style="margin-top:10px"><span>提到素材</span><span class="cnt">点一下写进提示词</span></div>
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
      <div class="ed-label" style="margin-top:16px"><span>画面素材</span><span class="cnt">顺序即参考顺序</span></div>
      ${(sh.keyframes || []).some(k => k.status === 'failed') ? `<button class="ghost mini" id="kfClearFailed" style="margin:0 0 6px">清除失败的画面（${sh.keyframes.filter(k => k.status === 'failed').length}）</button>` : ''}
      <button class="polish" id="kfGenBtn">${icon('sparkles', 13)} 按描述生成这一镜的画面</button>
      <!-- 规划那一轮的流式面板（公共 InlinePolish.live）。它必须留在 DOM 里：
           整列每 3 秒重画一次，面板会被重新拼出来的这一块带走 —— AiStream 每次 push 前
           会确认面板还在宿主里、不在就重画一块并补回已收到的字（见那一块说明）。
           注意：这一段在模板串里，注释里不许出现星号或反引号（§H / §B 都会当场拦下）。 -->
      <div id="kfPlanInline" hidden></div>
      <div style="display:flex;align-items:center;gap:8px;margin:-4px 0 4px">
        <select id="kfModel" style="flex:1;min-width:120px;padding:5px 8px;background:var(--input);border:1px solid var(--line);border-radius:3px;color:var(--txt);font-size:12px">${kfModelOptions()}</select>
        <span class="hint" id="kfEst" style="margin-top:0"></span>
      </div>
      ${/* 画面生成的高级设置：与图片工作台同一套形状（折叠 + 摘要 + 按声明显隐的档位）。
           四档一个都没声明、这个型号压根不收参考图、而且「四档之外」那三排也画不出任何一项时，
           整块不出现 —— 摆一个空盒子写着「高级设置」比没有更让人以为有东西可调。
           反过来只声明了顶层开关（如 VGENV 的「平台提示词优化」）的四档全空型号，这块**必须**出现，
           否则同一个平台在视频那一面能勾、在画面生成里连入口都没有。 */
        (['quality', 'aspect_ratio', 'size', 'output_format'].some(x => kp.kinds[x].on) || kfRefCap || kfExtras)
          ? `<div class="adv${AdvParams.closed('sk_kf_adv_closed') ? ' closed' : ''}" id="kfAdvBox" style="margin:0 0 10px">
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
          <div class="adv-grid" id="kfBoolRows" style="margin-top:10px" hidden></div>
          <div class="adv-grid" id="kfTopBools" style="margin-top:10px" hidden></div>
          <div class="adv-grid" id="kfShapeFields" style="margin-top:10px" hidden></div>
          <div class="hint" id="kfRefHint" style="margin-top:8px">${esc(kfRefLine)}</div>
        </div>
      </div>` : ''}
      <div class="assets-grid">
        ${(ic.first || sh.firstFrame) ? `<div class="asset-slot${ic.first ? '' : ' stray'}${bFirst ? (sh.firstFrame ? ' conflict' : ' blocked') : ''}"${slotAttrs('first', ic.first, bFirst, !ic.first && !!sh.firstFrame, ROLE_ZH.first_frame)}>${sh.firstFrame ? `${Wb.thumbs.mediaHTML(Api.mediaSrc(sh.firstFrame), { type: 'image' })}<button class="x iconbtn on-dark" data-k="firstFrame">${icon('close', 11)}</button>` : `<span class="ic">${icon('image', 16)}</span>开头画面<span class="sub">首帧 · 点击选择（也可选视频取尾帧）</span>`}</div>` : ''}
        ${(ic.last || sh.lastFrame) ? `<div class="asset-slot${ic.last ? '' : ' stray'}${bLast ? (sh.lastFrame ? ' conflict' : ' blocked') : ''}"${slotAttrs('last', ic.last, bLast, !ic.last && !!sh.lastFrame, ROLE_ZH.last_frame)}>${sh.lastFrame ? `${Wb.thumbs.mediaHTML(Api.mediaSrc(sh.lastFrame), { type: 'image' })}<button class="x iconbtn on-dark" data-k="lastFrame">${icon('close', 11)}</button>` : `<span class="ic">${icon('image', 16)}</span>结尾画面<span class="sub">尾帧</span>`}</div>` : ''}
        ${(sh.keyframes || []).map((kf, i) => `
          <div class="asset-slot kf">
            ${kf.status === 'done' ? `${Wb.thumbs.mediaHTML(Api.assetSrc(kf.assetId), { type: 'image' })}<button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}">${icon('close', 11)}</button>`
              : kf.status === 'generating' ? `<span class="spin-dot"></span><span class="sub">生成中</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="停止并删掉这一张">${icon('close', 11)}</button>`
              : kf.status === 'polishing' ? `<span class="spin-dot"></span><span class="sub">润色中</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="删掉这一张">${icon('close', 11)}</button>`
              : kf.status === 'queued' ? `<span class="spin-dot" style="opacity:.45"></span><span class="sub">排队中</span><button class="x iconbtn on-dark" data-k="keyframes" data-i="${i}" title="删掉这一张">${icon('close', 11)}</button>`
              : kf.status === 'failed' ? `<span class="sub err" title="${esc(kf.err || '')}">失败</span>`
                + `<button class="x iconbtn on-dark" data-retry="${i}" title="重试这一张" style="right:20px">${icon('refresh', 12)}</button>`
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
      <div class="adv${AdvParams.closed('sk_dir_adv_closed') ? ' closed' : ''}" id="advBox" style="margin-top:16px">
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
          <div class="adv-grid" id="edBoolRows" style="margin-top:10px" hidden></div>
          <div class="adv-grid" id="edTopBools" style="margin-top:10px" hidden></div>
          <div class="adv-grid" id="edShapeFields" style="margin-top:10px" hidden></div>
        </div>
      </div>
      <div class="ed-footer">
        <span class="can ${canGen ? '' : 'no'}" id="edFooterCan"${blockWhy ? ` title="${esc(blockWhy)}"` : ''}>${footerCanText(canGen, blockWhy)}</span>
        <span class="est" id="estTxt">估价中…</span>
        <button class="pri" id="genOne" ${canGen && !genOneBusy ? '' : 'disabled'}>${genOneBusy ? '创建中…' : genBtnLabel(sh)}</button>
      </div>
    </div>`;
  /* 面板里的素材缩略图（首帧 / 尾帧 / 关键帧 / 参考图）也接公共缓存：图片按原图渐进显示，
     加载完顺手缩一份进缓存，之后任何页面渲染同一份素材都直接命中（见 workbench.js 的 Wb.thumbs） */
  Wb.thumbs.bindAll(col);
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
  const edArEl = $('edAr'); if (edArEl) edArEl.onchange = e => { sh.ar = e.target.value; renderMid(); scheduleSave(); };
  const edResEl = $('edRes'); if (edResEl) edResEl.onchange = e => { sh.res = e.target.value; scheduleSave(); };
  /* 尺寸档只有这一家声明了才画出来（advSel 判 `k.on`），所以这里同样是「有节点才接线」。 */
  const edSizeEl = $('edSize'); if (edSizeEl) edSizeEl.onchange = e => { sh.size = e.target.value; scheduleSave(); };
  /* 条数下拉在「这个型号一次只能出一条」时根本不画（与工作台同一判据，见 AdvParams.plan 的 many），
     所以这里不能像以前那样裸用 `$('edDraw').onchange` —— 那是 TypeError。 */
  const edDrawEl = $('edDraw'); if (edDrawEl) edDrawEl.onchange = e => {
    sh.draw = Math.max(1, parseInt(e.target.value, 10) || 1);
    scheduleSave();
    renderEditor();      // 让右下角「生成这一镜（N 条）」按钮同步条数
    updateBanner();      // 横幅提示同步
  };
  const edTierEl = $('edTier'); if (edTierEl) edTierEl.onchange = e => { sh.tier = e.target.value; scheduleSave(); };
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
    edModelChanged = true;                // 换型号那一次，型号布尔那一排按**新声明**的默认值重画
    /* 每次换模型都回源一次能力接口，再按拿到的最新能力纠正参数 —— 上层把模型
       的分辨率 / 时长 / 张数改了、或加了新的输入槽位，界面跟着变，不用改代码。 */
    setStatus('正在读取型号能力…');
    const caps = await refreshCapsForModel((resolvedModel(sh) || {}).provider);
    if (caps) setStatus(caps.source === 'api' ? '✓ 已按上游接口更新型号能力' : '按平台声明展示型号能力');
    /* 换模型后「这一档在新模型上不存在」的纠正不在这里做：renderEditor 里的 AdvParams.plan
       就是那份回落（这里以前自己写了一遍 resolutions/tiers/aspect_ratios/durations/max_outputs
       的逐项纠正，写法与下拉画出来那一份、发出去那一份是三套 —— 现在同一判据只走 plan 一次）。 */
    renderEditor(); renderMid(); scheduleSave();
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
    const c0 = (sh.candidates || [])[proj.curCand];
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
    scheduleSave();
    syncMention(sh);                            // @ 引用素材库的候选浮层（见上面那一段）
    syncAtBack(sh);                             // @片段 的高亮镜像层（见 atBackHTML）
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
    const d3 = curDraftCand(); if (d3) d3.prompt = ''; else sh.prompt = '';
    polishUI = null;                                   // 清空提示词同时也收起润色面板
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
    ta0.focus();
    try { ta0.setSelectionRange(caret, caret); } catch (e2) {}
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
    scheduleSave(); estSlide(); updateBanner();
  };
  if (durRangeEl) durRangeEl.onchange = () => { renderMid(); };   // 松手后同步时间线（重建播放器）
  /* 模型没声明时长范围（hasDur=false）时这两行控件根本不在 DOM 里：
     以前这里裸用 $('durNum').oninput，$('durNum') 是 null → TypeError →
     renderEditor() 从这里中断，后面的「生成这一镜」、素材槽位、润色按钮全都没绑定，右栏瘫痪。 */
  if (durNumEl) durNumEl.oninput = e => {
    sh.duration = clampDur(e.target.value);
    if (durRangeEl) durRangeEl.value = sh.duration;
    scheduleSave(); estSlide(); updateBanner();
  };
  if (durNumEl) durNumEl.onchange = () => { durNumEl.value = sh.duration; renderMid(); };
  $('polishBtn').onclick = polishPrompt;
  renderPolishPanel(sh);        // 润色面板（若这一镜有未处理的润色结果，重渲染后重新画出来）
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
  [['kfQuality', 'q'], ['kfAr', 'ar'], ['kfSize', 'size'], ['kfFormat', 'fmt']].forEach(pair => {
    const el = $(pair[0]);
    if (!el) return;
    el.onchange = () => {
      if (pair[1] === 'q') kfQ = el.value;
      else if (pair[1] === 'ar') kfAr = el.value;
      else if (pair[1] === 'size') kfSize = el.value;
      else kfFormat = el.value;
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
    kfModelId = $('kfModel').value;
    kfModelChanged = true;                              // 型号布尔那一排按**新声明**的默认值重画
    localStorage.setItem('sk_kf_model', kfModelId);   // 记住选择，换镜头也保持
    setStatus('正在读取型号能力…');
    await refreshCapsForModel((kfModelOf().prov || {}).id);   // 画面模型同样回源一次能力接口
    /* 四档的取值与默认值不在这里再判一次：renderEditor 重建这些下拉时 kfImgParams 会按新模型的
       声明把每个值校正到有效档位（以前这里又抄了一份兜底表，两处各写 'standard'，改一处漏一处）。 */
    renderEditor();                                   // 重建高参（跟随新模型能力）
    setStatus('画面型号已切换：' + (kfModelOf().model?.name || kfModelId));
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
      if (shotHasVideo(sh)) {
        const ns = spawnCandidateShot(sh);
        await drawShot(ns, ns.draw || 1);
        setStatus('<span class="ok">✓ 这一镜已有视频：已在当前场景新建「' + esc(ns.name) + '」，这次生成挂在它上面（占位看它的候选条）</span>');
      } else if (draft0) {
        await generateCandidate(draft0);                 // 空草稿：按右栏写的描述生成这一条
      } else {
        await drawShot(sh, sh.draw || 1);
      }
      renderAll(); loadCredits();
    } catch (e) {
      setStatus('<span class="err">创建失败：' + e.message + '</span>');
    } finally {
      genOneBusy = false;
      renderEditor();
    }
  };
  // 只给「当前模型支持且已渲染」的槽位绑事件
  col.querySelectorAll('.asset-slot').forEach(slot => {
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
          if (kfRun && (kf.status === 'generating' || kf.status === 'queued')) {
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

/* ---------- 导入本机视频 → 本机资产 → 本镜候选 ----------
   落点和语音台的「本机音频」同一条：`Api.saveLocalAsset` 写进 `.assets` 并登记索引。
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
/* 真实时长 / 尺寸 / 音轨：只问 `/media/info` 这一条（ffprobe 在服务端）。
   失败不要挡住导入本身：拿不到时长就交回 null，播放器会自己量。 */
async function mediaInfo(body) {
  const r = await Net.fetch('/media/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), timeout: 120000, retry: 0,
  });
  return await readJsonSafe(r, '媒体检查');
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
      apply: url => { c.url = url; c.local = true; scheduleSave(); },
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

/* ---------- 最近导出（.data/render-jobs.json 的最近 50 单） ----------
   一次导出就是一份文件（成片或分开的素材段）。这里给两条出口：下载到本机、
   复制一份进本机资产库（服务端直接拷文件，不走浏览器 base64）。
   `filmIsCurrent()` 仍是导出前的判据；这条弹窗只处理「已经导出的那份」。 */
function jobStateText(j) {
  const st = String(j.state || '');
  if (st === 'done') return j.exists ? { t: '已完成', err: false } : { t: '记录在，但盘上找不到文件', err: true };
  if (st === 'failed') return { t: '失败' + (j.err ? '：' + j.err : ''), err: true };
  if (st === 'interrupted') return { t: j.err || '代理重启时这一单还没跑完', err: true };
  if (st === 'running') return { t: '导出中' + (j.progress != null ? ' ' + Math.round(Number(j.progress) || 0) + '%' : ''), err: false };
  if (st === 'queued') return { t: '排队中', err: false };
  return { t: st || '状态未知', err: false };
}
async function openRecentExports() {
  let data = null;
  try {
    data = await readJsonSafe(await Net.fetch('/render/jobs', { timeout: 15000 }), '读取最近导出');
  } catch (e) {
    setStatus('<span class="err">' + esc(errText(e)) + '</span>');
    return;
  }
  const jobs = (data && data.jobs) || [];
  await UiDialog.open({
    title: '最近导出',
    sub: '最近 ' + (data.limit || 50) + ' 次合片 / 导出素材的记录。文件只在本机渲染目录里；「存资产库」会复制一份进本机资产库。',
    body(el) {
      if (!jobs.length) {
        el.innerHTML = '<div class="rx-empty">还没有导出记录。点页头「导出成片」或「导出素材」后，这里会出现那一份。</div>';
        return;
      }
      el.innerHTML = '<div class="rx-list">' + jobs.map((j, i) => {
        const st = jobStateText(j);
        const parts = [
          { s: window.fmtWhen(j.createdAt || j.updatedAt) },
          { s: j.bytes ? window.fmtBytes(j.bytes) : '' },
          { s: (j.width && j.height ? j.width + '×' + j.height : '') },
          { s: st.t, err: st.err },
        ].filter(x => x.s);
        const meta = parts.map(x => (x.err ? '<span class="err">' + esc(x.s) + '</span>' : esc(x.s))).join(' · ');
        const can = j.state === 'done' && j.exists;
        return '<div class="rx-row" data-i="' + i + '">'
          + '<div class="rx-main"><div class="rx-name">' + esc(j.name || j.out || '未命名') + '</div>'
          + '<div class="rx-meta">' + meta + '</div></div>'
          + '<div class="rx-ops">'
          + (can ? '<button class="op-btn" data-dl="' + i + '" title="下载这一份到本机">' + icon('download', 13) + '</button>' : '')
          + (can ? '<button class="op-btn" data-save="' + i + '" title="复制一份进本机资产库，之后在素材库/资产库都能找到">' + icon('box', 13) + ' 存资产库</button>' : '')
          + '</div></div>';
      }).join('') + '</div>';
      el.querySelectorAll('[data-dl]').forEach(b => {
        b.onclick = async () => {
          const j = jobs[Number(b.dataset.dl)];
          if (!j) return;
          b.disabled = true;
          try {
            const blob = await renderBlob(j.name || j.out, '下载导出文件');
            saveBlob(j.name || j.out || 'export.mp4', blob);
            Toast.receipt('已开始下载 ' + (j.name || j.out || ''));
          } catch (e) {
            Toast.err(errText(e));
          }
          b.disabled = false;
        };
      });
      el.querySelectorAll('[data-save]').forEach(b => {
        b.onclick = async () => {
          const j = jobs[Number(b.dataset.save)];
          if (!j) return;
          const old = b.innerHTML;
          b.disabled = true;
          b.textContent = '保存中…';
          try {
            const r = await Net.fetch('/render/save-to-assets', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: j.name, title: String(j.name || '').replace(/\.[^.]+$/, '') }),
              timeout: 0, retry: 0,
            });
            const d = await readJsonSafe(r, '存进本机资产库');
            b.textContent = d.reused ? '已在资产库' : '已存资产库';
            b.disabled = true;
            Toast.receipt((d.reused ? '资产库里已经有这一份：' : '已存进本机资产库：') + (d.name || j.name || ''));
          } catch (e) {
            b.disabled = false;
            b.innerHTML = old;
            Toast.err(errText(e));
          }
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
      if (it.file) { try { ref.thumb = await Wb.vframe.dataURLFromFile(it.file, 'first', 320); } catch {} }
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
    if (btn) { btn.disabled = false; btn.innerHTML = icon('sparkles', 14) + ' AI 润色提示词'; }
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
    if (btn) { btn.disabled = false; btn.innerHTML = icon('sparkles', 14) + ' AI 润色提示词'; }
    renderPolishPanel(curShot());
    return;
  }
  polishUI.note0 = wantAsk ? '这次没能反问，直接润色' : '';
  await polishRun('');
}

/* 回收候选的 blob: URL（只针对本地导入的视频；/asset、blob: 之外的链接不动） */
function releaseCandUrl(c) {
  if (!c || !c._objUrl || !c.url) return;
  try { URL.revokeObjectURL(c.url); } catch {}
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
  localStorage.setItem('dir_theme', t);
}
applyTheme(localStorage.getItem('dir_theme') || 'light');

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
  const cand = prev.candidates.find(c => c.vid === prev.selId && c.status === 'succeeded' && c.url);
  if (!cand) return null;
  return { prev, cand, label: '截取上一镜视频尾帧（「' + prev.name + '」）' };
}
async function usePrevTail(sh, ref) {
  try {
    if (ref.lastKf) {
      sh.firstFrame = ref.prev.lastFrame || await assetToDataURL(ref.lastKf);
    } else {
      setStatus('正在截取视频尾帧…');
      const u = await freshUrl(ref.cand);
      // 上一镜应用过剪辑就按剪辑后的结束点取帧，否则取视频最后一帧
      sh.firstFrame = await Wb.vframe.dataURL(u, 'end', ref.cand.trimE != null ? ref.cand.trimE : null);
    }
    renderEditor(); scheduleSave();
    setStatus('<span class="ok">✓ 已接上一镜结尾作为开头画面</span>');
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
try {
  const kp = JSON.parse(localStorage.getItem('sk_kf_params') || '{}');
  if (kp && typeof kp === 'object') {
    if (kp.q !== undefined) kfQ = String(kp.q || '');
    if (kp.ar !== undefined) kfAr = String(kp.ar || '');
    if (kp.size !== undefined) kfSize = String(kp.size || '');
    if (kp.fmt !== undefined) kfFormat = String(kp.fmt || '');
    if (kp.tb && typeof kp.tb === 'object') kfTopBools = kp.tb;
    if (kp.sf && typeof kp.sf === 'object') kfShape = kp.sf;
  }
} catch (e) { }
/* 四个值一次落盘（一个键）：分四个键就是四次「这算设置项还是算界面状态」的争论，
   而且换一台机器只带走一半。 */
function kfParamsSave() {
  try {
    localStorage.setItem('sk_kf_params', JSON.stringify({
      q: kfQ, ar: kfAr, size: kfSize, fmt: kfFormat, tb: kfTopBools, sf: kfShape,
    }));
  } catch (e) { }
}
let kfModelId = localStorage.getItem('sk_kf_model') || '';   // 生成画面用的图片模型（可切换）
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
async function shotQuote(sh, over) {
  const rm = resolvedModel(sh) || {};
  const prov = provOf(rm.provider);
  /* 时长就按这一镜现在记的值估：模型没声明时长时上面那段归一化不会去填它，
     这里再 `|| 5` 等于凭空造一个平台没给过的秒数（报价跟着错）。 */
  /* 顶层那两排也进报价：注册表在 `pricing.body` 里写了映射才带得过去，
     而「这一档给不给」与提交体问的是同一个判据（AdvExtras.read → Capabilities）。
     不递就等于「界面上勾了 Turbo、报价还是那一档的钱」—— 差价要到生成那一刻才暴露。 */
  const ex = shotAdvExtras(sh);
  const ctx = shotAdvCtx(sh);
  const r = await estimateCost(prov, rm, Object.assign({
    count: sh.draw || 1, duration: sh.duration, res: sh.res, tier: sh.tier, ar: sh.ar, size: sh.size,
    /* 这一镜选的输入模式进报价：`creation_intent` 走 `pricing.body` 的映射（换人档的价与时长算法
       都不一样），`mode` 只当声明里 hide / def 的上下文。不递就等于「界面上切了换人档，报价还是
       普通生成那一档的钱」—— 差价要到生成那一刻才暴露。 */
    creation_intent: ctx.intent, mode: ctx.mode,
    topBools: ex.topBools, caps: ctx.caps,
    /* `over` 只给整批估价用（`count` 那一档）：这一屏没有「这一镜」，问的是「这几条同样的规格」。 */
  }, over || {}, ex.shapeFields));
  return { r, rm, prov };
}
async function getPriceEstimate(sh) {
  if (!sh) return '';
  const { r, rm, prov } = await shotQuote(sh);
  const name = prov?.name || rm.provider || '未知API';
  /* `skip` 与「报价失败了」是两件事（与生成工作台同一句区分）：这一档根本没有询价这条路
     （注册表声明的 `pricing.noQuote` —— VGENV 的动作换人在报价时要求带那段参考视频的字节，
     而报价是纯参数查询，拿不到）。写成「报价不可用（…INVALID）」会让人以为接口坏了，
     而切到「视频换人」之后这一条**每次都会**出现。 */
  if (r.skip) return name + ' · ' + (r.reason || '这一档平台不提供询价') + '，以平台结算为准';
  return r.ok ? name + ' · ' + r.text : name + ' · 报价不可用（' + r.reason + '）';
}
let estSeq = 0;
let estShown = '';          // 屏上此刻摆着的那句完整文案
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
  if (!TextAI.prov(REG)) { setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(REG))) { setStatus('<span class="err">请先到「设置」填写文字 AI 密钥（或在 .env / 系统环境变量里配置）</span>'); return; }
  const pickImg = kfModelOf();
  const imgProv = pickImg.prov, imgModel = pickImg.model;
  if (!imgProv || !imgModel) { setStatus('<span class="err">注册表里没有可用的图片型号</span>'); return; }
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
    renderEditor(); scheduleSave();
    setStatus(`已确认 ${finalPlan.length} 张画面（${finalPlan.map(f => f.t + 's').join(' / ')}），开始生成…`);

    // ②.5 参考图先转存一次，整批复用同一份条目（循环里各转一遍 = 同一张图传 N 趟）
    const refNotes = [];
    const kfRefs = await kfRefEntries(sh, t => refNotes.push(t));
    if (refNotes.length) setStatus('<span class="err">' + esc(refNotes.join('；')) + '</span>');

    // ③ 逐张生成 → 替换占位 → 同时加入参考图（后台刷新走 renderSoft：正在右栏编辑时不打断输入）
    kfRun = true;
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
    kfRun = false;
    sh.keyframes = (sh.keyframes || []).filter(k => !k.deleted);   // 移除生成中被删掉的
    renderSoft(['edit']); scheduleSave();
    loadCredits();
    setStatus(okN
      ? `<span class="ok">✓ 已生成 ${okN}/${sh.keyframes.length} 张画面${refN ? '，并加入参考图' : (shotInputCaps(sh).blockedRoles.has('reference_image') ? '（已选首尾帧，画面未加入参考图）' : '')}</span>`
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
}
function renderProjMenu() {
  const menu = $('projMenu');
  menu.innerHTML = '<div class="pm-head">共 ' + WS.projects.length + ' 个短片</div>';
  WS.projects.forEach(p => {
    const row = document.createElement('div');
    row.className = 'pm-row' + (p.id === WS.curId ? ' sel' : '');
    const n = p.scenes.reduce((a, s) => a + s.shots.length, 0);
    row.innerHTML = `<span class="pm-name">${esc(p.name)} <span class="pm-cnt">· ${n} 镜</span></span>
      <span class="pm-ops">
        <button class="pm-btn" data-rename="${p.id}" title="重命名这个短片">${icon('pencil', 13)}</button>
        <button class="pm-btn danger" data-del="${p.id}" title="删除这个短片">${icon('trash', 13)}</button>
      </span>`;
    row.onclick = e => { if (e.target.closest('.pm-btn')) return; switchProject(p.id); menu.hidden = true; };
    menu.appendChild(row);
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
  // 删除（二次确认；删掉当前短片会自动切到另一个，最后一个则新建空白短片）
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
    } catch {}
    WS.projects = WS.projects.filter(x => x.id !== id);
    if (!WS.projects.length) {
      WS.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
    }
    if (WS.curId === id) WS.curId = WS.projects[0].id;
    switchProject(WS.curId);
    renderProjMenu();
    setStatus('<span class="ok">✓ 已删除短片「' + pp.name + '」</span>');
  });
  const addRow = document.createElement('div');
  addRow.className = 'pm-add';
  addRow.textContent = '＋ 新建短片';
  addRow.onclick = () => {
    const p = { id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] };
    WS.projects.push(p);
    switchProject(p.id);
    menu.hidden = true;
  };
  menu.appendChild(addRow);
}
function switchProject(id) {
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
  const running = all.some(sh => sh.candidates.some(c => c.status === 'queued' || c.status === 'running'));
  const prog = running ? '⏳ 生成中…（' + ready + '/' + all.length + ' 已完成）' : '';
  // 刚提交完的结果优先显示 12 秒（和进度并排），之后再回到普通进度文案
  if (genAllMsg && Date.now() - genAllMsg.ts < 12000) { note.innerHTML = genAllMsg.html + (prog ? '<span style="display:block;margin-top:2px">' + prog + '</span>' : ''); return; }
  if (running) { note.textContent = prog; return; }
  note.textContent = ready === all.length && all.length
    ? `✓ ${ready} 个分镜已完成，可以剪辑与导出了`
    : `已完成 ${ready}/${all.length} 个分镜`;
}
/* 「就地二次确认」全站**只有web/ui/ui.js 的 Confirm.arm 一份**（AGENTS.md §J）。
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
        + ' style="height:min(58vh,560px);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.65"></textarea>'
        + '<div role="alert" style="display:none;color:var(--err);font-size:12px;line-height:1.6;margin-top:6px"></div>';
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
  } catch {}
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
/* 「这一镜试过、但一条都没成」—— failed / cancelled 也算「没出画面」（L54）。
   为什么必须单独判一次：批量提交失败（余额不足、上游 5xx、提示词被安全策略拦下）之后，
   那一镜留下的是一条 failed 候选；只按「有没有非草稿候选」筛的话，这些镜头**永远**进不了 todo ——
   补好额度再点「生成全部分镜」，得到的还是「所有镜头都已有生成结果，无需重复生成」，
   而失败提示明明写着「可单独重试这些镜头」。想重来只剩一条路：逐个进镜头、手动删掉那批失败候选。
   （有 succeeded 的镜头**不**算「试过没成」—— 想重跑是另一回事，那是「再生成一条」，不是补失败。） */
const shotAllFailed = sh => (sh.candidates || []).length > 0
  && (sh.candidates || []).every(c => c && ['failed', 'cancelled'].includes(c.status));
const GEN_CONCUR = 3;            // 同时在飞的创建请求数（想更激进/更保守改这里）
$('genAll').onclick = async () => {
  const todo = allShots().filter(sh => !hasRealCandidate(sh) || shotAllFailed(sh));
  if (!todo.length) {
    setStatus('<span class="err">所有镜头都已有生成结果，无需重复生成（想重跑先删掉那一镜的候选）</span>');
    return;
  }
  // 先挑出不能生成的镜头（提示词不合格 / 素材互斥 / 有当前模型不支持的素材）：不阻塞其他镜头，也不白建占位
  const blockWhy = new Map();
  const bad = todo.filter(sh => { const w = shotBlockReason(sh); if (w) { blockWhy.set(sh, w); return true; } return false; });
  const ok = todo.filter(sh => bad.indexOf(sh) < 0);
  if (!ok.length) {
    const first = bad[0] ? (bad[0].name || '未命名镜头') + '：' + blockWhy.get(bad[0]) : '';
    setStatus('<span class="err">这些镜头还不能生成（' + first + '）</span>');
    return;
  }
  $('genAll').disabled = true;
  const jobs = [];
  for (const sh of ok) pushPlaceholders(sh, sh.draw || 1).forEach(ph => jobs.push({ sh, ph }));
  setGenAllMsg('提交中… 0/' + jobs.length + ' 条');
  let done = 0;
  const res = await runPool(jobs, GEN_CONCUR, async j => {
    await submitCandidate(j.sh, j.ph);
    done++;
    setGenAllMsg('提交中… ' + done + '/' + jobs.length + ' 条');
  });
  const failed = [];
  res.forEach((r, i) => { if (!r || !r.ok) failed.push({ j: jobs[i], e: (r && r.error) || null }); });
  $('genAll').disabled = false;
  loadCredits();
  const parts = [];
  if (jobs.length - failed.length) parts.push('✓ 已提交 ' + (jobs.length - failed.length) + '/' + jobs.length + ' 条 · ' + ok.length + ' 镜 · 并发 ' + Math.min(GEN_CONCUR, jobs.length) + ' 路');
  if (bad.length) parts.push('跳过 ' + bad.length + ' 个：' + bad.map(sh => (sh.name || '未命名') + '（' + blockWhy.get(sh) + '）').join('、'));
  if (failed.length) parts.push('失败 ' + failed.length + ' 条（' + failed[0].j.sh.name + '：' + ((failed[0].e && failed[0].e.message) || '未知错误') + '，其余看候选上的红字）');
  // 成功/部分成功走按钮下方小字（横幅只留给出错），失败另外弹横幅提醒
  setGenAllMsg(parts.join('；'));
  if (failed.length) {
    setStatus('<span class="err">有 ' + failed.length + ' 条提交失败：这些镜头现在算「一条都没成」，'
      + '点「生成全部分镜」会只补它们（已成功的那几镜不会再重投）</span>');
  }
};
/* 页头那一排导出按钮由格式表现画现绑（web/domain/export-formats.js）：加一种导出不再动模板与这一排。
   绑定也只有这一处：剪辑栏每 3 秒随整列重建，把出口绑在那里等于每次重建都要重绑，
   导出中写在按钮上的那句「取消渲染 45%」会被下一次重画冲掉。
   **「播放成片」那一颗已删**：看效果走「剪辑 → 全片」那一排的实时预览（`#pbBtn` → TlPlay），
   它从不为播放跑 ffmpeg；要一个文件才点这里的「导出成片」。 */
/* 每个 kind 给一个「返回点击处理器」的工厂：film / files 直接交现成函数，
   xml 才按这一行是裸 FCPXML 还是媒体包现包一个。 */
const EXPORT_RUN = {
  film: () => exportFilmClick,
  files: () => clickExportAssets,
  xml: f => () => exportFCPXML({ bundle: !!f.bundle }),
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
  WS.projects.forEach(p => {
    p.id = p.id || uid();
    p.name = p.name || '未命名短片';
    /* 画面比例是**一个项目一份**：只认偶数、64–4096 的宽高（编码器要偶数）；
       坏值直接删掉，回落到「按第一条成片的画幅」的旧行为，而不是让 ffmpeg 到导出时才报错。 */
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
    const u = JSON.parse(localStorage.getItem(K_WS_UNLOAD) || 'null');
    if (u && u.data && Array.isArray(u.data.projects) && u.data.projects.length
      && (!ws || (Number(u.ts) || 0) > (Number(ws.ts) || 0))) {
      ws = u.data;
      await wsKv.put('workspace', ws);
    }
    localStorage.removeItem(K_WS_UNLOAD);
  } catch (e) {}
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
  if (!ws || !Array.isArray(ws.projects)) ws = { projects: [], curId: null, roles: [] };
  if (!ws.projects.length) {
    ws.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  WS = { projects: ws.projects, curId: ws.curId && ws.projects.some(p => p.id === ws.curId) ? ws.curId : ws.projects[0].id, roles: ws.roles || [] };
  proj = WS.projects.find(p => p.id === WS.curId);
  sanitize();
  revFloor = Math.max(revFloor, Number(proj.rev) || 0);
  lastSavedJson = snapOf();    // 撤销栈基线
  $('projName').value = proj.name;
  renderAll();                 // 首屏：不等能力接口、不等本地视频、不等余额
  setTimeout(announceDoneCandidates, 0);   // 已经出画面但还没镜像的候选：投一次事件（不阻塞首屏）
  poller.kick();             // 首屏立刻问一次在途候选，不等第一轮间隔
  loadCredits();
  // 后台补齐（都不阻塞首屏）
  Capabilities.load(REG).then(() => { try { renderEditor(); } catch {} }).catch(() => {});
  restoreLocalBlobs().then(() => { try { renderAll(); } catch {} }).catch(() => {});
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
(function () {
  const READY = () => { try { return !!(proj && proj.scenes && allShots().length); } catch (e) { return false; } };
  /* 前台判据只有公共层那一份（core/activity.js，外壳挂在 window.__spaActivity）。
     这里原来只看路由：整个标签页切到后台时照样为真，助手就能在用户看不见的时候动时间线。 */
  const ACTIVE = () => {
    try { return window.__spaActivity.visible('director.html'); }
    catch (e) { return true; }
  };
  const capTxt = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const loose = msg => ({ ok: false, err: msg });
  const dirLockOf = seg => {
    try {
      const why = rowLockWhy('pic', picLnOf(seg));
      return why ? (why + '：这一段所在的行锁着，助手不改。先在导演台解锁再试。') : '';
    } catch (e) { return ''; }
  };
  function shotOf(a) {
    a = a || {};
    if (a.shotId != null && a.shotId !== '') {
      for (const sc of proj.scenes) {
        const hit = (sc.shots || []).find(x => String(x.id) === String(a.shotId));
        if (hit) return { sc, sh: hit };
      }
      return loose('找不到镜头 id「' + a.shotId + '」——先用 page_state / 当前界面快照看这一镜的 id');
    }
    if (a.shot != null) {
      const sc = (a.scene != null) ? proj.scenes[Number(a.scene) - 1] : (proj.scenes[proj.curScene] || proj.scenes[0]);
      if (!sc) return loose('找不到第 ' + a.scene + ' 个场景');
      const n = Number(a.shot);
      if (!Number.isInteger(n) || n < 1 || n > (sc.shots || []).length) {
        return loose('「' + sc.name + '」里没有第 ' + a.shot + ' 镜（一共 ' + (sc.shots || []).length + ' 镜）');
      }
      return { sc, sh: sc.shots[n - 1] };
    }
    const sc = curScene(), sh = curShot();
    return sh ? { sc, sh } : loose('当前没有镜头');
  }
  function candOf(sh, a, mode) {
    a = a || {};
    const list = sh.candidates || [];
    if (!list.length) return loose('「' + sh.name + '」还没有候选：先生成或导入一条视频');
    let i = -1;
    if (a.take != null) {
      const n = Number(a.take);
      if (!Number.isInteger(n) || n < 1 || n > list.length) {
        return loose('take 是第几条候选（1–' + list.length + '），给的是「' + a.take + '」');
      }
      i = n - 1;
    } else if (a.candId != null && a.candId !== '') {
      i = list.findIndex(c => String(c.vid) === String(a.candId));
      if (i < 0) {
        return loose('这一镜没有候选 id「' + a.candId + '」。现有：'
          + list.map((c, k) => '第' + (k + 1) + '条 ' + c.vid).join(' / '));
      }
    } else if (mode === 'selected') {
      i = list.findIndex(c => c.vid === sh.selId);
    }
    if (i < 0) i = Math.max(0, Math.min(list.length - 1, Number(proj.curCand) || 0));
    return { i, c: list[i], list };
  }
  const hasPic = c => !!(c && c.status === 'succeeded' && c.url);
  function focus(sc, sh, ci) {
    const si = proj.scenes.indexOf(sc), xi = (sc.shots || []).indexOf(sh);
    if (si >= 0) proj.curScene = si;
    if (xi >= 0) proj.curShot = xi;
    if (ci != null) proj.curCand = Math.max(0, Math.min(ci, (sh.candidates || []).length - 1));
  }
  function selectPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) {
      return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条现在还不能选用（状态：'
        + (q.c.status || '未知') + '，没有可播放地址）。等它出了画面再选');
    }
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, already: s.sh.selId === q.c.vid };
  }
  const WAY_ZH = { split: '切开', left: '切掉插针左边', right: '切掉插针右边', drop: '删成黑场', merge: '融合相邻两段' };
  function cutPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条还没出画面（状态：' + (q.c.status || '未知') + '），剪不了');
    const total = candDur(q.c, s.sh);
    const segs = segsOf(q.c, total);
    if (!segs.length) return loose('这一条现在一段画面都没有：先在导演台按 Ctrl+Z 退回剪切之前，或换一条候选');
    const way = String(a.way || '').trim();
    if (!WAY_ZH[way]) return loose('way 只能是 split / left / right / drop / merge');
    let at = null, segNo = null;
    if (a.seg != null) {
      const n = Number(a.seg);
      if (!Number.isInteger(n) || n < 1 || n > segs.length) return loose('seg 是第几段（1–' + segs.length + '），给的是「' + a.seg + '」');
      segNo = n; at = (Number(segs[n - 1].in) + Number(segs[n - 1].out)) / 2;
    } else if (a.at != null) {
      at = Number(a.at);
      if (!Number.isFinite(at)) return loose('at 要是秒数（源视频的第几秒）');
    } else if (way === 'drop' || way === 'merge') {
      const n = Math.min(segs.length, Math.max(1, (Number(proj.cutSeg) || 0) + 1));
      segNo = n; at = (Number(segs[n - 1].in) + Number(segs[n - 1].out)) / 2;
    } else {
      return loose('切哪一秒要说清：给 at（源视频的第几秒）或 seg（第几段）');
    }
    if (at < 0 || at > total) return loose('at 要在 0–' + round1(total) + ' 秒之间（这一条 ' + round1(total) + ' 秒）');
    at = round1(Math.max(0, Math.min(total, at)));
    let i = segs.findIndex(x => at >= x.in && at < x.out);
    if (i < 0) i = segs.reduce((b, x, k) => (Math.abs(x.in - at) < Math.abs(segs[b].in - at) ? k : b), 0);
    const lock = dirLockOf(segs[i]);
    if (lock) return loose(lock);
    const r = cutSegs(q.c, total, at, way);
    if (r.err) return loose(r.err);
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, segNo, seg: segs[i], segs, at, way, total, out: r };
  }
  function cutResultText(p, newSegs, moved) {
    const after = newSegs.reduce((a, s) => a + segFilmLen(s), 0);
    const inFilm = p.sh.selId === p.c.vid;
    const what = p.way === 'split' ? '在 ' + p.at + ' 秒处切开'
      : p.way === 'left' ? '把插针左边切掉'
      : p.way === 'right' ? '把插针右边切掉'
      : p.way === 'drop' ? (p.out.back ? '把这一段画面放回来' : '把这一段画面删成黑场（格子留在原位）')
      : '把相邻两段融合回一段';
    return '已在「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选上' + what
      + '：现在 ' + newSegs.length + ' 段、这一条共 ' + round1(after) + ' 秒'
      + (inFilm ? '（这一条正被选用，成片跟着变）' : '（这一条还没被选用，成片仍按选用的那条算）')
      + (moved ? '；有 ' + moved + ' 句配音正好被切掉，已挪到紧随其后的那段开头' : '')
      + '。要退回就说「撤销最近一步」。';
  }
  function setPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条还没出画面，改不了');
    const total = candDur(q.c, s.sh);
    const segs = segsOf(q.c, total);
    if (!segs.length) return loose('这一条现在一段画面都没有，改不了');
    let i;
    if (a.seg != null) {
      const n = Number(a.seg);
      if (!Number.isInteger(n) || n < 1 || n > segs.length) return loose('seg 是第几段（1–' + segs.length + '）');
      i = n - 1;
    } else if (a.at != null) {
      const at = Number(a.at);
      i = segs.findIndex(x => at >= x.in && at < x.out);
      if (i < 0) return loose('at 不在任何一段里（这一条 0–' + round1(total) + ' 秒）');
    } else {
      i = Math.max(0, Math.min(segs.length - 1, Number(proj.cutSeg) || 0));
    }
    const lock = dirLockOf(segs[i]);
    if (lock) return loose(lock);
    const next = {};
    if (a.speed != null) {
      const v = Number(a.speed);
      if (!Number.isFinite(v) || v < 0.25 || v > 4) return loose('speed 要在 0.25–4 之间（1 = 原速）');
      next.speed = Math.round(v * 100) / 100;
    }
    if (a.volume != null) {
      const v = Number(a.volume);
      if (!Number.isFinite(v) || v < 0 || v > 2) return loose('volume 要在 0–2 之间（1 = 原声，百分比请除以 100）');
      next.volume = Math.round(v * 100) / 100;
    }
    if (a.gray != null) next.gray = !!a.gray;
    if (!Object.keys(next).length) return loose('要改什么没说：speed（0.25–4）/ volume（0–2）/ gray（true=黑场）至少给一项');
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, segs, seg: segs[i], total, next };
  }
  function setResultText(p, segNo, seg) {
    const bits = [];
    if (p.next.speed != null) bits.push('倍速 ' + spdTxt(segSpd(seg)));
    if (p.next.volume != null) bits.push('原声 ' + Math.round(segVol(seg) * 100) + '%');
    if (p.next.gray != null) bits.push(seg.off ? '这一段是黑场' : '这一段有画面');
    return '已改「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选的第 ' + segNo
      + ' 段：' + bits.join(' · ') + '（这一条现在 ' + p.segs.length + ' 段）。要退回就说「撤销最近一步」。';
  }
  function undoPlan(a) {
    a = a || {};
    const mode = String(a.mode || 'undo') === 'redo' ? 'redo' : 'undo';
    const steps = Math.max(1, Math.min(5, Number(a.steps) || 1));
    const n = mode === 'redo' ? redoStack.length : undoStack.length;
    if (!n) {
      return loose(mode === 'redo' ? '没有可重做的操作' : ('可撤销的已经用完了' + (undoSkipWhy ? '（' + undoSkipWhy + '）' : '')));
    }
    return { mode, steps: Math.min(steps, n), n };
  }

  /* ---------- 字幕：桥这一侧的 check / run（数据层仍是 sh.subtitle 那一份源秒） ----------
     `set {kind:'subtitle'}` 三个内容档互斥：entries（源秒条目）/ text（SRT 成片秒）/
     maxChars（按字数重切）；style 可以与其中任意一档同时给。所有入口都落回
     `subWriteData` → `filmEdited`，不另写一份字幕账。 */
  const SUB_STYLE_KEYS = ['fontFamily', 'fontSize', 'color', 'position', 'maxCharsPerEntry', 'highlight'];
  const SUB_POS = ['bottom', 'middle', 'top'];
  const HEX6 = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  function stylePatchOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: 'style 要是一个对象：{fontSize, color, position, maxCharsPerEntry, highlight, fontFamily}' };
    }
    const patch = {};
    for (const k of Object.keys(raw)) {
      if (!SUB_STYLE_KEYS.includes(k)) return { err: 'style 里不认识「' + k + '」；能改的只有 ' + SUB_STYLE_KEYS.join(' / ') };
    }
    if (raw.fontSize != null) {
      const v = Number(raw.fontSize);
      if (!Number.isFinite(v) || v < 12 || v > 300) return { err: 'fontSize 要在 12–300 之间（1080p 下的像素）' };
      patch.fontSize = Math.round(v);
    }
    if (raw.color != null) {
      if (!HEX6.test(String(raw.color).trim())) return { err: 'color 要是 #RRGGBB 或 #RGB' };
      patch.color = String(raw.color).trim().toUpperCase();
    }
    if (raw.position != null) {
      if (!SUB_POS.includes(raw.position)) return { err: 'position 只能是 bottom / middle / top' };
      patch.position = raw.position;
    }
    if (raw.maxCharsPerEntry != null) {
      const v = Number(raw.maxCharsPerEntry);
      if (!Number.isInteger(v) || v < 8 || v > 120) return { err: 'maxCharsPerEntry 要在 8–120 之间（整数）' };
      patch.maxCharsPerEntry = v;
    }
    if (raw.highlight != null) patch.highlight = !!raw.highlight;
    if (raw.fontFamily != null) {
      const v = String(raw.fontFamily).replace(/\s+/g, ' ').trim();
      if (!v) return { err: 'fontFamily 不能是空串' };
      patch.fontFamily = v.slice(0, 60);
    }
    return { patch };
  }
  /* 助手给的 entries 一律是**候选源秒**（startMs/endMs）；也接受 start/end 秒数写法，
     但只在这两个字段缺省时兜底 —— 不拿「看起来像秒」去猜毫秒。 */
  function subEntriesIn(list, total) {
    if (!Array.isArray(list)) return { err: 'entries 要是数组：[{startMs,endMs,text}]，时间是候选源秒' };
    if (list.length > 5000) return { err: '字幕一次最多 5000 条' };
    const out = [];
    let last = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { err: '第 ' + (i + 1) + ' 条字幕不是对象' };
      const text = String(e.text == null ? '' : e.text).replace(/\r\n?/g, '\n').trim();
      if (!text) return { err: '第 ' + (i + 1) + ' 条字幕没有文字' };
      if (text.length > 2000) return { err: '第 ' + (i + 1) + ' 条字幕超过 2000 字（这么长的一行在画面上放不下）' };
      let a = e.startMs, b = e.endMs;
      if (a == null && e.start != null) a = Number(e.start) * 1000;
      if (b == null && e.end != null) b = Number(e.end) * 1000;
      a = Number(a); b = Number(b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { err: '第 ' + (i + 1) + ' 条字幕的 startMs/endMs 不是数字' };
      if (b <= a) return { err: '第 ' + (i + 1) + ' 条字幕的 endMs 必须大于 startMs' };
      if (a < 0 || b > total * 1000 + 1) {
        return { err: '第 ' + (i + 1) + ' 条字幕落在候选源时间轴之外（这一条 0–' + round1(total) + ' 秒，源秒不是成片秒）' };
      }
      if (a < last) return { err: '字幕要按 startMs 从小到大排（第 ' + (i + 1) + ' 条比上一条更早）' };
      last = a;
      const rec = { startMs: Math.round(a), endMs: Math.round(b), text, src: e.src === 'asr' ? 'asr' : 'manual' };
      if (e.seg != null) {
        const sg = Number(e.seg);
        if (Number.isInteger(sg) && sg >= 1) rec.seg = sg - 1;
      }
      if (e.voiceKey != null) rec.voiceKey = String(e.voiceKey).slice(0, 120);
      out.push(rec);
    }
    return { entries: out };
  }
  function subClampWarn(sh, c, total, entries) {
    const segs = segsOf(c, total);
    const inSeg = sec => segs.some(s => sec >= (Number(s.in) || 0) - 0.001 && sec <= (Number(s.out) || 0) + 0.001);
    let n = 0;
    entries.forEach(e => {
      if (!inSeg((Number(e.startMs) || 0) / 1000) || !inSeg((Number(e.endMs) || 0) / 1000)) n++;
    });
    return n ? ['有 ' + n + ' 条字幕落在已经剪掉的源区间上，预览/导出时会夹到最近的画面边界'] : [];
  }
  function subPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const sh = s.sh;
    if (a.take != null) {
      const q = candOf(sh, a, 'selected'); if (q.err) return q;
      if (q.c.vid !== sh.selId) {
        return loose('字幕跟着「选用」的那条候选走：先把「' + capTxt(sh.name, 30) + '」第 ' + (q.i + 1) + ' 条设为选用，再改字幕');
      }
    }
    const c = chosenCandOf(sh);
    if (!c) return loose('「' + capTxt(sh.name, 30) + '」还没有选用候选：字幕的源秒/成片秒都要按选用那条换算，先在导演台选一条');
    const total = candDur(c, sh);
    const cur = currentOf(sh, voicesEnsure());
    const wantEntries = a.entries !== undefined;
    const wantText = typeof a.text === 'string' && !!a.text.trim();
    const wantReseg = a.maxChars !== undefined;
    if ((wantEntries ? 1 : 0) + (wantText ? 1 : 0) + (wantReseg ? 1 : 0) > 1) {
      return loose('一次只做一件内容改动：entries / text（SRT）/ maxChars 三选一（style 可以同时给）');
    }
    let stylePatch = null;
    if (a.style !== undefined) {
      const r = stylePatchOf(a.style);
      if (r.err) return loose(r.err);
      stylePatch = r.patch;
    }
    let entries = null, source = '', mode = '', warnings = [], maxChars = null;
    if (wantText) {
      const parsed = srtParse(a.text);
      if (!parsed.length) return loose('这段 SRT 没解析出字幕（检查时间行是不是 00:00:00,000 --> 00:00:02,000）');
      if (parsed.length > 5000) return loose('这段 SRT 有 ' + parsed.length + ' 条，超过 5000 条上限');
      const shotAt = shotFilmAt(sh);
      if (shotAt == null) return loose('「' + capTxt(sh.name, 30) + '」还没进成片（没有选用候选 / 画面全被剪掉），SRT 的成片秒折不回源秒');
      const segs = segsOf(c, total);
      const span = segs.reduce((x, g) => x + segFilmLen(g), 0);
      const inSpan = parsed.filter(e => {
        const at = (Number(e.startMs) || 0) / 1000;
        return at >= shotAt - 0.001 && at < shotAt + span + 0.001;
      });
      if (!inSpan.length) {
        return loose('这段 SRT 里没有落在本镜的字幕（本镜在成片里是 ' + fmtDur(shotAt) + '–' + fmtDur(shotAt + span) + '）');
      }
      const mapped = mapFromFilm(sh, shotAt, inSpan, { cand: c });
      if (!mapped.length) return loose('落在本镜的那 ' + inSpan.length + ' 条折回源秒后是空的');
      entries = mapped; source = 'manual'; mode = 'import_srt';
      if (inSpan.length < parsed.length) warnings.push((parsed.length - inSpan.length) + ' 条不在本镜，没有导入');
      if (parsed.skipped) warnings.push(parsed.skipped + ' 块格式不对，已跳过');
    } else if (wantEntries) {
      const r = subEntriesIn(a.entries, total);
      if (r.err) return loose(r.err);
      entries = r.entries;
      if (a.source === 'asr') source = 'asr';
      else if (a.source != null && a.source !== 'manual') return loose('source 只能是 manual / asr（line+voice 用 source:"line+voice" 且不要给 entries，让编辑器按台词重新派生）');
      else source = 'manual';
      mode = 'update';
    } else if (wantReseg) {
      const lim = Number(a.maxChars);
      if (!Number.isInteger(lim) || lim < 1 || lim > 500) return loose('maxChars 是每行最多几个字（1–500 的整数）');
      const base = a.source === 'line+voice' ? entriesFromShot(sh, voicesEnsure(), c) : cur.entries;
      if (!base.length) return loose('「' + capTxt(sh.name, 30) + '」现在没有字幕可重切：先用 entries 更新或导入 SRT');
      entries = resegment(base, lim);
      source = 'manual'; mode = 'resegment'; maxChars = lim;
    } else if (a.source === 'line+voice') {
      entries = entriesFromShot(sh, voicesEnsure(), c);
      if (!entries.length) return loose('这一镜没有可派生字幕的台词或配音：先写台词，或在配音轨上合成一句');
      source = 'line+voice'; mode = 'generate';
    } else if (!stylePatch) {
      return loose('要改字幕的什么没说：entries（源秒条目）/ style（样式）/ maxChars（按字数重切）/ text（SRT），或 source:"line+voice" 重新生成');
    } else {
      mode = 'style';
    }
    if (entries) warnings = warnings.concat(subClampWarn(sh, c, total, entries));
    if (cur.stale && (mode === 'update' || mode === 'import_srt')) {
      warnings.push('这一镜的台词/配音或选用候选已经变过（旧字幕标着 stale），这次写入会以你给的这一份为准');
    }
    return { sc: s.sc, sh, c, total, cur, entries, stylePatch, source, mode, warnings, maxChars };
  }
  function subResultText(p, sub) {
    const n = p.entries ? p.entries.length : p.cur.entries.length;
    let text = '';
    if (p.mode === 'import_srt') text = '已把 SRT 导入「' + capTxt(p.sh.name, 30) + '」：' + n + ' 条（成片秒已折回候选源秒）';
    else if (p.mode === 'resegment') text = '已把「' + capTxt(p.sh.name, 30) + '」的字幕按每行 ' + p.maxChars + ' 字重切成 ' + n + ' 条';
    else if (p.mode === 'generate') text = '已按台词/配音在「' + capTxt(p.sh.name, 30) + '」重新生成 ' + n + ' 条字幕';
    else if (p.mode === 'update') text = '已更新「' + capTxt(p.sh.name, 30) + '」的字幕：现在 ' + n + ' 条';
    else text = '已改「' + capTxt(p.sh.name, 30) + '」的字幕样式';
    if (p.stylePatch) text += '（样式：' + Object.keys(p.stylePatch).join(' / ') + '）';
    text += '，数据层是候选源秒';
    if (sub && sub.source === 'line+voice') text += '；这一份跟台词/配音走，之后它们变了会自动跟着重派生';
    text += '。要退回就说「撤销最近一步」。';
    return text;
  }

  /* 修订号 CAS：写动作必须带 expectedRevision（助手在计划生成时冻结的那一份），
     run 时再验一次 —— 用户在两颗按钮之间改了工程就当场拒掉，不拿旧计划去盖。
     同一次批量里后续 op 不验（revision 由引擎自己推进），只验第一条。 */
  function subBatch(a) {
    const b = a && a._batch;
    return b && typeof b === 'object' ? b : null;
  }
  function batchOf(a) {
    const b = subBatch(a);
    return { inBatch: !!b, first: !!(b && b.first), last: !!(b && b.last) };
  }
  /* 批量只在第一条前压一次撤销快照、最后一条后重画一次；中间每一步照常改内存，
     后一条的 `*Plan` 读得到前一条的结果。任一条失败由助手侧调 undo（带 `_rollback`）回滚整批。 */
  function editBegin(a, label) {
    const b = batchOf(a);
    if (!b.inBatch || b.first) beginEdit(label);
    return b;
  }
  function editEnd(a, b) {
    if (!b.inBatch || b.last) filmEdited();
  }
  function revNow() { return Number(proj && proj.rev) || 0; }
  function revGate(a) {
    if (a && a._rollback) return null;          // 整批失败时的内部回滚：此时 revision 已被这批写入推进
    const b = subBatch(a);
    if (b && !b.first) return null;
    const exp = a && a.expectedRevision;
    if (exp == null || exp === '') {
      return loose('写动作缺少 expectedRevision：先用 timeline_get 读一次当前 revision，再原样带上');
    }
    if (Number(exp) !== revNow()) {
      return { ok: false, code: 'revision_mismatch',
        err: '工程在你读取之后又改过（你拿的是 revision ' + Number(exp) + '，现在是 ' + revNow()
          + '）。为避免盖掉你刚做的编辑，这次没有执行：先重新读 timeline_get，再按新状态来一次' };
    }
    return null;
  }
  /* 只读：某一镜的字幕账（源秒 + 成片秒 + 样式 + stale）。`subtitle.list` 与
     `context().字幕` 都读它，不在助手侧另算一套。 */
  function subtitleInfo(a) {
    const s = shotOf(a || {}); if (s.err) return s;
    const sh = s.sh, c = chosenCandOf(sh);
    const cur = currentOf(sh, voicesEnsure());
    const shotAt = shotFilmAt(sh);
    const list = (sh.candidates || []);
    const ci = c ? list.findIndex(x => x.vid === c.vid) : -1;
    const rows = cur.entries.map(e => {
      const m = shotAt != null ? filmOf(sh, shotAt, e) : null;
      return {
        index: e.index, startMs: e.startMs, endMs: e.endMs, text: e.text, src: e.src,
        段: (Number(e.seg) || 0) + 1,
        成片起: m ? Math.round(m.filmStart * 1000) / 1000 : null,
        成片止: m ? Math.round(m.filmEnd * 1000) / 1000 : null,
        夹过: m ? !!(m.clampedStart || m.clampedEnd) : false,
      };
    });
    const out = {
      镜头: capTxt(sh.name, 30), 镜头id: sh.id,
      候选: ci >= 0 ? ('第 ' + (ci + 1) + ' / ' + list.length + ' 条') : '未选用',
      时间基准: 'source',  // startMs/endMs 是候选源秒；成片起/成片止 是成片秒
      来源: cur.source, 条数: rows.length, 过时: cur.stale, 过时原因: cur.staleWhy || '',
      样式: cur.style, 源指纹: cur.sourceHash,
      在成片里: shotAt != null,
      成片起点: shotAt != null ? round1(shotAt) : null,
      条目: rows.slice(0, 200),
      revision: revNow(),
    };
    if (rows.length > 200) out.说明 = '只列出前 200 条（共 ' + rows.length + ' 条）';
    return out;
  }
  /* 只读：字幕 → SRT 文本。不给 shotId 就是全片（成片秒）；给了就只出那一镜
     （进了成片用成片秒，没进成片用本镜甲板秒，`时间基准` 里写明）。下载仍由页面/助手 UI 完成。 */
  function subtitleSrt(a) {
    const sid = a && a.shotId;
    if (sid != null && sid !== '') {
      const sh = allShots().find(x => String(x.id) === String(sid));
      if (!sh) return loose('没有这个镜头：' + sid);
      const cur = currentOf(sh, voicesEnsure());
      const shotAt = shotFilmAt(sh);
      const mapped = shotAt != null ? mapToFilm(sh, shotAt, cur.entries) : mapToShot(sh, cur.entries);
      const entries = mapped.map(e => {
        const a0 = e.filmStart != null ? e.filmStart : e.shotStart;
        const b0 = e.filmEnd != null ? e.filmEnd : e.shotEnd;
        return Object.assign({}, e, { startMs: Math.round(a0 * 1000), endMs: Math.round(b0 * 1000) });
      });
      return { ok: true, 镜头: capTxt(sh.name, 30), 条数: entries.length,
        时间基准: shotAt != null ? 'film' : 'shot', 在成片里: shotAt != null,
        text: srtSerialize(entries, { bom: false, crlf: false }), revision: revNow() };
    }
    const { rows } = filmRowsForSubtitles();
    const got = filmEntriesOf(rows, allShots(), voicesEnsure());
    return {
      ok: true,
      条数: got.entries.length,
      未进成片的镜头: got.missing.map(x => ({ 镜头: capTxt(x.shot.name, 30), 条数: x.count, 原因: x.why === 'nocand' ? '没有选用候选' : '没进成片' })),
      时间基准: 'film', text: srtSerialize(got.entries, { bom: false, crlf: false }), revision: revNow(),
    };
  }

  /* ---------- 媒体 / 转写 / 导出：助手入口（都复用页面已有的那一条实现） ---------- */
  function candSrcOf(a) {
    a = a || {};
    const assetId = String(a.assetId || '').trim();
    if (assetId && !a.take && a.shotId == null && a.shot == null && !a.src) {
      return { src: Api.assetSrc(assetId), sh: null, c: null };
    }
    let sh = null, c = null;
    if (a.take != null || a.shotId != null || a.shot != null || a.shotIndex != null) {
      const s = shotOf(a); if (s.err) return s;
      sh = s.sh;
      const q = candOf(sh, a, 'selected'); if (q.err) return q;
      c = q.c;
    }
    const src = String(a.src || '').trim()
      || (a.assetId ? Api.assetSrc(a.assetId) : '')
      || (c ? candTrackSrc(c) : '');
    if (!src) return loose('要检查哪一条没说：给 take（第几条候选）/ shotId，或 src / assetId');
    return { sh, c, src };
  }
  async function mediaCheck(a) {
    a = a || {};
    const assetId = String(a.assetId || '').trim();
    const q = candSrcOf(a); if (q.err) return q;
    try {
      const info = await mediaInfo(assetId && !a.take && a.shotId == null && a.shot == null && !a.src
        ? { assetId } : { src: q.src });
      return Object.assign({ ok: true, 源: q.src.slice(0, 160),
        镜头: q.sh ? capTxt(q.sh.name, 30) : '', 候选: q.c ? String(q.c.vid).slice(0, 60) : '' }, info);
    } catch (e) { return loose('媒体检查失败：' + errText(e)); }
  }
  /* 帧是给用户看的（助手 UI 画成卡片）；返回值里带 dataURL，工具层负责剥掉再给模型。 */
  async function mediaFrames(a) {
    a = a || {};
    const q = candSrcOf(a); if (q.err) return q;
    let times = Array.isArray(a.times) ? a.times.map(Number).filter(Number.isFinite) : [];
    if (!times.length) {
      const total = q.c ? candDur(q.c, q.sh) : 0;
      if (!(total > 0)) return loose('这一条读不到时长：给 times（秒数组，1–8 个）再取帧');
      const n = Math.max(1, Math.min(8, Number(a.count) || 3));
      times = Array.from({ length: n }, (_, i) => Math.round((total * (i + 0.5) / n) * 100) / 100);
    }
    times = times.map(t => Math.max(0, Math.round(Number(t) * 1000) / 1000));
    if (times.length > 8) return loose('一次最多取 8 帧');
    const out = [];
    for (const sec of times) {
      try {
        out.push({ 秒: sec, dataURL: await Wb.vframe.dataURL(q.src, null, sec, 1280) });
      } catch (e) { out.push({ 秒: sec, 错误: errText(e)}); }
    }
    return { ok: out.some(x => x.dataURL), 镜头: q.sh ? capTxt(q.sh.name, 30) : '',
      候选: q.c ? String(q.c.vid).slice(0, 60) : '', 帧: out };
  }
  async function asrStart(a) {
    a = a || {};
    const q = candSrcOf(a); if (q.err) return q;
    /* dryRun：助手在画确认卡片之前要先把「查哪一份、走哪条路、扣不扣费」说清楚，
       但那一步**不许提交任务**（提交了就是一次真实转写，远程还按次计费）。
       路线判据读 `/asr/settings`（与设置页同一份：本地是否可用 + 在线有没有密钥），
       不在这里抄第二套规则。 */
    if (a.dryRun) {
      let st = null;
      try { st = await readJsonSafe(await Net.fetch('/asr/settings', { timeout: 15000 }), '读取转写设置'); } catch (e) {}
      const s = (st && st.settings) || {};
      const svc = s.service || {};
      const local = !!(st && st.local && st.local.available);
      const want = String(a.route || s.route || 'auto');
      const route = want === 'local' ? 'local' : (want === 'service' ? 'service' : (local ? 'local' : 'service'));
      const why = route === 'local'
        ? (local ? '本机 whisper 可用：在本机跑，不产生平台费用'
          : '路线定在本地，但本地模型不可用：' + ((st && st.local && st.local.why) || '缺少运行包') + '（提交会当场被拒）')
        : '在线服务转写：供应商 ' + (svc.providerId || '没选') + ' · 模型 ' + (svc.model || 'whisper-1')
          + '，按次计费' + (svc.hasKey ? '' : '（这一家还没配密钥时提交会被拒）');
      return { ok: true, 镜头: q.sh ? capTxt(q.sh.name, 30) : '', 源: q.src.slice(0, 160),
        route, language: String(a.language || s.language || ''), 会扣费: route === 'service', 说明: why };
    }
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      const r = await window.Asr.transcribe({ src: q.src, language: String(a.language || ''), route: String(a.route || '') });
      return Object.assign({ ok: true, 镜头: q.sh ? capTxt(q.sh.name, 30) : '',
        源: q.src.slice(0, 160), 说明: '转写在代理里跑；用 media_transcription 读结果，不会自动改写台词或字幕' }, r);
    } catch (e) { return loose('提交转写失败：' + errText(e)); }
  }
  async function asrJob(a) {
    const id = String((a && a.jobId) || '').trim();
    if (!id) return loose('要给 jobId');
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      const j = await window.Asr.job(id);
      return Object.assign({ ok: true }, j);
    } catch (e) { return loose('读不到转写任务：' + errText(e)); }
  }

  /* 助手发起的导出：仍调用页面同一套导出函数（不另写渲染管线），这里只做记录与状态查询。 */
  const expJobs = new Map();
  let expSeq = 0;
  function expNew(format) {
    const id = 'ex_' + Date.now().toString(36) + '_' + (++expSeq);
    const rec = { id, format, state: 'running', at: Date.now(), endedAt: 0,
      progress: 0, renderId: '', out: '', err: '', text: '', counts: null };
    expJobs.set(id, rec);
    while (expJobs.size > 20) expJobs.delete(expJobs.keys().next().value);
    return rec;
  }
  function expView(r) {
    return { id: r.id, format: r.format, state: r.state, progress: Math.round(Number(r.progress) || 0),
      开始: r.at, 结束: r.endedAt || null, 渲染任务: r.renderId || '',
      文件: r.out || '', 说明: r.text || '', 错误: r.err || '',
      ...(r.counts ? { 条数: r.counts } : {}),
      可取消: r.state === 'running' && !!(ExportFormats.of(r.format) || {}).cancelable && !!r.renderId };
  }
  function expSettle(rec, ok, extra) {
    rec.state = ok ? 'done' : (extra && extra.cancelled ? 'canceled' : 'error');
    rec.endedAt = Date.now();
    if (extra) {
      if (extra.err) rec.err = String(extra.err);
      if (extra.text) rec.text = String(extra.text);
      if (extra.out) rec.out = String(extra.out);
      if (extra.renderId) rec.renderId = String(extra.renderId);
    }
    if (!rec.text) rec.text = ok ? '导出完成' : (rec.err || '导出失败');
  }
  function expOf(id) {
    if (!id) return [...expJobs.values()].sort((a, b) => b.at - a.at)[0] || null;
    return expJobs.get(String(id)) || null;
  }
  function exportStart(a) {
    a = a || {};
    const fmt = String(a.format || ExportFormats.ids()[0]);
    const f = ExportFormats.of(fmt);
    if (!f) return loose('format 只能是 ' + ExportFormats.hint());
    const tl = tlSyncFromShots();
    if (!tl.clips.length) return loose('现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面');
    if (f.renders && rendering) return loose('已有导出任务在进行中，等这一轮结束或先取消');
    const rec = expNew(fmt);
    const settle = r => expSettle(rec, !!(r && r.ok), r);
    if (f.kind === 'film') {
      exportFilmFFmpeg({
        onStarted: x => {
          rec.renderId = x.renderId;
          rec.progress = 1;
          rec.text = '正在合成成片（' + x.clips + ' 段' + (x.subtitles ? ' · 字幕 ' + x.subtitles + ' 条' : '') + '）';
        },
        onProgress: j => { rec.progress = Number(j && j.progress) || rec.progress; },
      }).then(r => {
        settle(r);
        if (r && r.ok) rec.counts = { 段: r.clips, 秒: r.duration, 字幕: r.subtitles };
      }).catch(e => settle({ ok: false, err: errText(e)}));
      return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
    }
    if (f.kind === 'files') {
      exportFilmAssets({ skipConfirm: true, onProgress: p => {
        rec.progress = Math.round((p.done / Math.max(1, p.total)) * 100);
        rec.text = '正在导出第 ' + p.done + '/' + p.total + ' 个：' + p.name;
      } }).then(r => {
        settle(r);
        if (r && r.ok) rec.counts = { 画面: r.nV, 配音: r.nA, 已存: r.okN };
      }).catch(e => settle({ ok: false, err: errText(e)}));
      return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
    }
    exportFCPXML({ bundle: !!f.bundle }).then(r => {
      settle(r);
      if (r && r.ok) rec.counts = { 画面段: r.rows, 配音句: r.voices, 字幕条: r.subtitles };
    }).catch(e => settle({ ok: false, err: errText(e)}));
    return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
  }
  async function exportStatus(a) {
    const rec = expOf(a && a.jobId);
    if (!rec) return loose('没有这次导出记录（助手发起的导出只在本次页面会话里记账；最近的导出用 export_list 读 /render/jobs）');
    if (rec.renderId && rec.state === 'running') {
      try {
        const d = await renderStatus(rec.renderId);
        if (d && d.progress != null) rec.progress = d.progress;
        if (d && d.state && d.state !== 'running' && d.state !== 'queued') rec.renderState = d.state;
      } catch (e) {}
    }
    return Object.assign({ ok: true }, expView(rec));
  }
  function exportList() {
    return { ok: true, jobs: [...expJobs.values()].sort((a, b) => b.at - a.at).map(expView) };
  }
  /* 助手侧「最近导出」：会话内自己发起的那几笔 + 代理落盘的最近导出记录。
     读的是页面自己那一条 `/render/jobs`（openRecentExports 同一份），不在助手层另拼 URL。 */
  async function exportRecent(a) {
    const mine = exportList().jobs;
    let server = [];
    try {
      const d = await readJsonSafe(await Net.fetch('/render/jobs', { timeout: 15000 }), '读取最近导出');
      server = ((d && d.jobs) || []).slice(0, Number(a && a.limit) || 10).map(j => ({
        id: j.id || '', 来源: '代理', 格式: j.name || j.out || '未命名',
        状态: String(j.state || ''), 进度: Math.round(Number(j.progress) || 0),
        文件: j.out || '', 存在: !!j.exists, 字节: j.bytes || 0,
        时间: window.fmtWhen ? window.fmtWhen(j.createdAt || j.updatedAt) : '',
      }));
    } catch (e) { return { ok: false, err: '读不到最近导出：' + errText(e), 助手发起的: mine }; }
    return { ok: true, 助手发起的: mine, 代理记录: server };
  }
  async function exportCancel(a) {
    const rec = expOf(a && a.jobId);
    if (!rec || !rec.renderId) return loose('这次导出还没有渲染任务号，停不下来');
    if (rec.renderId !== renderJobId) return loose('这次导出的渲染任务已经不在当前这一轮里（可能已经结束）');
    renderCancelled = true;
    try { await renderCancel(rec.renderId); } catch (e) {}
    expSettle(rec, false, { cancelled: true, err: '已取消' });
    return { ok: true, text: '已取消这次导出（已经落盘的部分不受影响）' };
  }
  async function exportSaveToAssets(a) {
    a = a || {};
    const name = String(a.name || (proj.merged && proj.merged.name) || '').trim();
    if (!name) return loose('没说要存哪一份：给 name（最近导出里的文件名），或先导出一份成片');
    try {
      const d = await Net.json('/render/save-to-assets', {
        method: 'POST', retry: 0, timeout: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, title: String(a.title || proj.name || '').slice(0, 200) }),
      });
      return Object.assign({ ok: true, text: (d.reused ? '资产库里已经有这一份：' : '已存进本机资产库：') + (d.name || name) }, d);
    } catch (e) { return loose('存进资产库失败：' + errText(e)); }
  }

  function dirCheck(op, a) {
    if (!ACTIVE()) return loose('当前不在导演台：切到导演台再让我动时间线（别切走之后让我盲改）');
    if (!READY()) return loose('导演台还没加载完，等这一页画出来再说');
    try {
      if (op === 'select' || op === 'cut' || op === 'set' || op === 'undo') {
        const gate = revGate(a);
        if (gate) return gate;
      }
      if (op === 'select') {
        const p = selectPlan(a); if (p.err) return p;
        return { ok: true, text: '把「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选设为选用' + (p.already ? '（现在已经是）' : ''),
          lines: ['镜头：' + capTxt(p.sh.name, 40) + (p.sc ? '（' + capTxt(p.sc.name, 20) + '）' : ''),
            '候选：第 ' + (p.i + 1) + ' / ' + (p.sh.candidates || []).length + ' 条 · ' + capTxt(p.c.vid, 40),
            '状态：' + (p.c.status || '未知') + ' · ' + round1(candDur(p.c, p.sh)) + ' 秒',
            '动作：设为选用 —— 成片这一镜按这一条算' + (p.already ? '（已经是，执行不会改任何东西）' : '')] };
      }
      if (op === 'cut') {
        const p = cutPlan(a); if (p.err) return p;
        const after = p.out.segs.reduce((x, s) => x + segFilmLen(s), 0);
        return { ok: true, text: WAY_ZH[p.way] + '：' + capTxt(p.sh.name, 30) + ' 第 ' + (p.i + 1) + ' 条',
          lines: ['镜头：' + capTxt(p.sh.name, 40),
            '候选：第 ' + (p.i + 1) + ' 条 · ' + round1(p.total) + ' 秒',
            '剪法：' + WAY_ZH[p.way] + (p.way === 'split' || p.way === 'left' || p.way === 'right' ? '（插针 ' + p.at + ' 秒）' : ''),
            '剪完：' + p.out.segs.length + ' 段 · 这一条共 ' + round1(after) + ' 秒',
            '这一条' + (p.sh.selId === p.c.vid ? '正被选用，成片跟着变' : '还没被选用，成片仍按选用的那条算')] };
      }
      if (op === 'set') {
        if (a && a.kind === 'subtitle') {
          const p = subPlan(a); if (p.err) return p;
          const n = p.entries ? p.entries.length : p.cur.entries.length;
          const what = p.mode === 'import_srt' ? '把 SRT 里的 ' + n + ' 条导入「' + capTxt(p.sh.name, 30) + '」（成片秒折回候选源秒）'
            : p.mode === 'resegment' ? '把「' + capTxt(p.sh.name, 30) + '」的字幕按每行 ' + p.maxChars + ' 字重切成 ' + n + ' 条'
            : p.mode === 'generate' ? '按台词/配音给「' + capTxt(p.sh.name, 30) + '」重新生成 ' + n + ' 条字幕'
            : p.mode === 'update' ? '把「' + capTxt(p.sh.name, 30) + '」的字幕改成 ' + n + ' 条（源秒）'
            : '改「' + capTxt(p.sh.name, 30) + '」的字幕样式（条目不动）';
          const lines = ['镜头：' + capTxt(p.sh.name, 40),
            '候选：第 ' + ((p.sh.candidates || []).findIndex(x => x.vid === p.c.vid) + 1) + ' 条 · ' + round1(p.total) + ' 秒',
            '时间基准：候选源秒（' + (p.mode === 'import_srt' ? '导入的 SRT 按成片秒解释' : '预览/导出再折成成片秒') + '）',
            '字幕：' + n + ' 条' + (p.mode === 'style' ? '（只改样式）' : '')]
            .concat(p.stylePatch ? ['样式：' + Object.keys(p.stylePatch).join(' / ')] : [])
            .concat(p.warnings.map(w => '注意：' + w));
          return { ok: true, text: what, lines, subtitleCount: n, stale: p.cur.stale };
        }
        const p = setPlan(a); if (p.err) return p;
        const bits = [];
        if (p.next.speed != null) bits.push('倍速 → ' + spdTxt(p.next.speed));
        if (p.next.volume != null) bits.push('原声 → ' + Math.round(p.next.volume * 100) + '%');
        if (p.next.gray != null) bits.push(p.next.gray ? '删成黑场' : '恢复画面');
        return { ok: true, text: '改第 ' + (p.i + 1) + ' 条候选的第 ' + (p.segs.indexOf(p.seg) + 1) + ' 段：' + bits.join(' · '),
          lines: ['镜头：' + capTxt(p.sh.name, 40),
            '候选：第 ' + (p.i + 1) + ' 条（共 ' + p.segs.length + ' 段）',
            '这一段的现在：' + round1(segLen(p.seg)) + ' 秒源 · 倍速 ' + spdTxt(segSpd(p.seg)) + ' · 原声 ' + Math.round(segVol(p.seg) * 100) + '%',
            '改成：' + bits.join(' · ')] };
      }
      if (op === 'undo') {
        if (subBatch(a)) return loose('撤销不能放进批量：它是整批失败时的回滚方式');
        const p = undoPlan(a); if (p.err) return p;
        return { ok: true, text: (p.mode === 'redo' ? '重做 ' : '撤销 ') + p.steps + ' 步',
          lines: [(p.mode === 'redo' ? '可重做：' : '可撤销：') + p.n + ' 步', '这次做 ' + p.steps + ' 步'] };
      }
      return loose('不认识的时间线动作：' + op);
    } catch (e) { return loose(errText(e)); }
  }
  function dirRun(op, a) {
    const chk = dirCheck(op, a);
    if (!chk.ok) return chk;
    /* check 与 run 是两次独立的纯读：中间状态没变时结果一致；万一变了（用户在等确认时
       自己又点了一下轨道），run 照**当下**这份重算，不拿卡片上那份旧计划去写。 */
    if (op === 'select') {
      const p = selectPlan(a); if (p.err) return p;
      if (p.already && !batchOf(a).inBatch) {
        renderAll();
        setStatus('这一条<b>已经是</b>选用的那条了；没有改任何数据');
        return { ok: true, text: chk.text + '。它本来就是选用的那条，数据没动',
          revision: revNow(), changedIds: [], warnings: [] };
      }
      const b = editBegin(a, 'AI 选片');
      focus(p.sc, p.sh, p.i);
      if (!p.already) p.sh.selId = p.c.vid;
      editEnd(a, b);
      setStatus('<span class="ok">✓ ' + esc(chk.text) + '（成片按这一条算）</span>');
      return { ok: true, text: chk.text + (p.already ? '。它本来就是选用的那条，数据没动' : '。已保存到本地工作区'),
        revision: revNow(), changedIds: p.already ? [] : [p.sh.id], warnings: [] };
    }
    if (op === 'cut') {
      const p = cutPlan(a); if (p.err) return p;
      const b = editBegin(a, 'AI 切段');
      const newSegs = segsWrite(p.c, p.total, p.out.segs);
      proj.cutSeg = Math.max(0, Math.min(newSegs.length - 1, Number(p.out.at) || 0));
      proj.cutAt = p.at;
      focus(p.sc, p.sh, p.i);
      const moved = reanchorVoices(p.sh, p.c, p.segs, newSegs);
      editEnd(a, b);
      const text = cutResultText(p, newSegs, moved);
      setStatus('<span class="ok">✓ ' + esc(text) + '</span>');
      return { ok: true, text, revision: revNow(), changedIds: [p.sh.id], warnings: [] };
    }
    if (op === 'set') {
      if (a && a.kind === 'subtitle') {
        const p = subPlan(a); if (p.err) return p;
        const b = editBegin(a, 'AI 改字幕');
        if (p.stylePatch) {
          if (!p.sh.subtitle || typeof p.sh.subtitle !== 'object') p.sh.subtitle = {};
          setStyle(p.sh, p.stylePatch);
        }
        /* 只改样式时不动条目：`sh.subtitle` 里只有 style，currentOf 仍按台词/配音现派生。 */
        if (p.entries) subWriteData(p.sh, p.entries, p.source);
        const ci = (p.sh.candidates || []).findIndex(x => x.vid === p.c.vid);
        focus(p.sc, p.sh, Math.max(0, ci));
        editEnd(a, b);
        const cur = currentOf(p.sh, voicesEnsure());
        const text = subResultText(p, cur);
        setStatus('<span class="ok">✓ ' + esc(text) + '</span>');
        return { ok: true, text, revision: revNow(), changedIds: [p.sh.id], warnings: p.warnings,
          subtitleCount: cur.entries.length, stale: cur.stale,
          unexported: !proj.merged || !filmIsCurrent(proj.merged) };
      }
      const p = setPlan(a); if (p.err) return p;
      const segNo = p.segs.indexOf(p.seg) + 1;
      const seg = p.segs[segNo - 1];
      const b = editBegin(a, 'AI 改片段');
      if (p.next.speed != null) { if (p.next.speed === 1) delete seg.spd; else seg.spd = p.next.speed; }
      if (p.next.volume != null) { if (p.next.volume === 1) delete seg.vol; else seg.vol = p.next.volume; }
      if (p.next.gray != null) { if (p.next.gray) seg.off = 1; else delete seg.off; }
      const newSegs = segsWrite(p.c, p.total, p.segs);
      proj.cutSeg = Math.max(0, Math.min(newSegs.length - 1, segNo - 1));
      focus(p.sc, p.sh, p.i);
      editEnd(a, b);
      const text = setResultText(p, segNo, newSegs[segNo - 1] || seg);
      setStatus('<span class="ok">✓ ' + esc(text) + '</span>');
      return { ok: true, text, revision: revNow(), changedIds: [p.sh.id], warnings: [] };
    }
    if (op === 'undo') {
      const p = undoPlan(a); if (p.err) return p;
      let done = 0;
      for (let k = 0; k < p.steps; k++) {
        if (p.mode === 'redo') { if (!redoStack.length) break; redo(); }
        else { if (!undoStack.length) break; undo(); }
        done++;
      }
      return { ok: true, text: (p.mode === 'redo' ? '已重做 ' : '已撤销 ') + done + ' 步（还能撤销 '
        + undoStack.length + ' 步 · 可重做 ' + redoStack.length + ' 步）',
        revision: revNow(), changedIds: [], warnings: [] };
    }
    return loose('不认识的时间线动作：' + op);
  }
  /* 结果定位（助手回执里的 changedIds 都是镜头 id）：显式点「定位」才切镜头并滚到那一格；
     执行完那一下只闪、不切视图。页不在前台就拒绝 —— 不做自动跳页，免得抢走用户当前的视图。 */
  function locateShots(ids, opts) {
    if (!READY()) return { ok: false, reason: '导演台还没加载完' };
    if (!ACTIVE()) return { ok: false, reason: '导演台现在不在前台：切回导演台再点「定位」' };
    const o = opts || {};
    const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
    const hits = [];
    proj.scenes.forEach(sc => (sc.shots || []).forEach(sh => {
      if (list.includes(String(sh.id))) hits.push({ sc, sh });
    }));
    if (!hits.length) return { ok: false, reason: '这份工程里已经没有这几镜了（可能刚被删掉）' };
    const flash = () => hits.forEach(h => {
      const el = document.querySelector('.shot-item[data-sid="' + h.sh.id + '"]');
      if (!el) return;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2400);
    });
    if (o.focus !== false) {
      focus(hits[0].sc, hits[0].sh);
      renderAll();
      const el = document.querySelector('.shot-item[data-sid="' + hits[0].sh.id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      requestAnimationFrame(() => requestAnimationFrame(flash));
    } else flash();
    return { ok: true, found: hits.length,
      label: hits.length === 1 ? (hits[0].sh.name || '这一镜') : hits.length + ' 个镜头' };
  }
  /* 唯一写入桥：只读快照 + check + run，装进 `WBBridge`（web/core/bridges.js）。
     助手侧只认这一个名字，不再往 window 上挂页面专用全局。 */
  if (window.WBBridge && typeof window.WBBridge.install === 'function') window.WBBridge.install('director', {
    version: 2,
    ready: () => ACTIVE() && READY(),
    /* 只读历史摘要（方案 §6.5 首期）：条数 + 最近一次编辑的标签。
       不给「撤销到第 N 步」这类入口 —— 快照栈没有条目 id，按位置回退会在中间插入新编辑后错位。 */
    history: () => ({
      可撤销: undoStack.length,
      可重做: redoStack.length,
      上限: UNDO_MAX_COUNT,
      最近: undoStack.length ? (lastUndoLabel || '编辑') : '',
      占内存: window.fmtBytes(undoBytes) + ' / ' + window.fmtBytes(UNDO_MAX_BYTES),
    }),
    locate: (ids, opts) => locateShots(ids, opts),
    context: () => {
      if (!READY()) return { 导演台: '还没加载完' };
      const sc = curScene(), sh = curShot();
      if (!sh) return {};
      const list = sh.candidates || [];
      const ci = Math.max(0, Math.min(list.length - 1, Number(proj.curCand) || 0));
      const c = list[ci] || null;
      const total = c ? candDur(c, sh) : 0;
      const segs = c ? segsOf(c, total) : [];
      return {
        项目: capTxt(proj.name, 40),
        场景: sc ? capTxt(sc.name, 30) : '',
        镜头: capTxt(sh.name, 30),
        镜头id: sh.id,
        选用: (() => { const k = list.findIndex(x => x.vid === sh.selId); return k >= 0 ? ('第 ' + (k + 1) + ' 条') : '未选用'; })(),
        当前候选: list.length ? ('第 ' + (ci + 1) + ' / ' + list.length + ' 条') : '还没有候选',
        候选: list.slice(0, 12).map((x, k) => ({ 序号: k + 1, id: x.vid, 状态: x.status || '', 秒: round1(candDur(x, sh)), 选用: x.vid === sh.selId, 当前: k === ci })),
        这一条: c ? { 总秒: round1(total), 段数: segs.length,
          成片秒: round1(segs.reduce((a, s) => a + segFilmLen(s), 0)),
          段: segs.slice(0, 12).map((s, k) => ({ 第: k + 1, in: s.in, out: s.out, 倍速: segSpd(s), 音量: Math.round(segVol(s) * 100) + '%', 黑场: !!s.off })) } : null,
        插针: round1(Number(proj.cutAt) || 0),
        选中段: segs.length ? Math.min(segs.length, Math.max(1, (Number(proj.cutSeg) || 0) + 1)) : 0,
        播放头: TlPlay.plan.length ? round1(TlPlay.t) : null,
        字幕: (() => {
          const cur = currentOf(sh, voicesEnsure());
          return { 条数: cur.entries.length, 来源: cur.source, 过时: cur.stale,
            过时原因: cur.staleWhy || '', 在成片里: shotFilmAt(sh) != null };
        })(),
        成片: proj.merged ? (filmIsCurrent(proj.merged) ? '已导出（当前）' : '已导出（旧）') : '未导出',
        revision: revNow(),
        可撤销: undoStack.length,
        可重做: redoStack.length,
      };
    },
    subtitle: a => subtitleInfo(a),
    srt: a => subtitleSrt(a),
    mediaInfo: a => mediaCheck(a),
    mediaFrames: a => mediaFrames(a),
    asrStart: a => asrStart(a),
    asrJob: a => asrJob(a),
    exportNow: a => exportStart(a),
    exportStatus: a => exportStatus(a),
    exportList: a => exportRecent(a),
    exportCancel: a => exportCancel(a),
    saveToAssets: a => exportSaveToAssets(a),
    check: (op, a) => dirCheck(op, a),
    run: (op, a) => dirRun(op, a),
  });
})();

}
