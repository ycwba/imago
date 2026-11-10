/* 导演台镜头与候选工厂域：候选占位字段（草稿 / 导入）、新镜头的默认形状、本镜时长、
   选用 / 取消选用的唯一入口与「这一镜能不能算已经有画面」。区间内的代码由 engine.js 逐字搬出；
   proj 是 engine 继续持有的可变状态，走访问器；resolvedModel 在 engine 里要到 Panel 建包
   之后才有值，建包时只递一枚箭头。document / window 用参数名遮蔽全局。 */

import { promoteCandidate, demoteShot, normalizeFilm, clipDurationOf } from '../film.js';
import { round1 } from '../util.js';

export function createShots(E, document, window) {
  'use strict';
  const {
    projOf,
    resolvedOf,
    uid,
  } = E;

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
  const rm = resolvedOf(sh) || {};
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
const allShots = () => (projOf() ? projOf().scenes.flatMap(sc => sc.shots) : []);
/* 成片模型（`proj.film`，web/director/film.js）：新剪辑核的唯一数据层。
   读回来时由 sanitize 整份规整；这里只负责「缺了就补一张空片」。 */
function ensureFilm() {
  if (!projOf()) return normalizeFilm(null);
  if (!projOf().film || typeof projOf().film !== 'object') projOf().film = normalizeFilm(null);
  return projOf().film;
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
const curScene = () => (projOf() ? projOf().scenes[projOf().curScene] || projOf().scenes[0] : null);
const curShot = () => curScene()?.shots[projOf().curShot];
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

  return {
    allShots,
    curScene,
    curShot,
    ensureFilm,
    filmClipName,
    fmtDur,
    mkCandidateBase,
    mkDraftCandidate,
    mkImportedCandidate,
    newShot,
    setSelectedCandidate,
    shotDur,
    shotDurText,
    shotReady,
  };
}
