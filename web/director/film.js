/* 成片模型（`proj.film`）—— 新剪辑核的唯一数据层。
   与参考项目同构：主画面是一列**顺序存储**的 clip（没有 start，成片总长 = Σ duration），
   配音 / 字幕是定时条目（成片秒直存），标记钉在成片秒。
   纯函数，不碰 DOM、不问当前镜头；时间线几何在 engine/timeline.js，交互在 engine/edit.js。

   时间口径只有两把：**成片秒**（clip 顺序派生的 start、配音 start、字幕 start/end、标记 time）
   与**源秒**（clip.sourceStart / sourceDuration 指向素材里的那一段）。
   旧模型那套「源秒 ↔ 本镜轴秒 ↔ 成片秒」的折算层已整族删除。 */
import { round1, round2, num } from './util.js';
import { normalizeMarkers, markerSpanEnd } from './tl-markers.js';

export const TL_FPS = 30;
export const MIN_CLIP_SECONDS = 0.05;
export const IMAGE_SEGMENT_SECONDS = 2;
export const LANE_MAX = 12;
export const DEFAULT_TRANSITION_SECONDS = 0.5;
export const TRANSITION_MAX_SECONDS = 2;
export const TRANSITION_MIN_SECONDS = 0.1;
export const MIN_CAPTION_SECONDS = 0.2;
/* 画面轨的总长上限（加一段 / 加长到顶那一句回执按它判）。 */
export const MAX_FILM_SECONDS = 30 * 60;
/* 按字数估一句念完要多久：AI 写台词时用它校验「这句能不能在镜头时长里念完」。 */
export const LINE_EST_CPS = 4.5;
export const estimateSpeechSeconds = text => Math.max(1.2, String(text || '').length / LINE_EST_CPS);

let seq = 1;
/* 身份前缀区分种类：桥与历史按 id 找条目，前缀让「这是哪一种」一眼可读。 */
export function filmId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const pos = v => Math.max(0, num(v));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------- 转场（参考 config/editor.js#TRANSITIONS） ----------------
   每段身上挂 `transition = { id, duration }`：**本段进入下一段**的连接点。
   none / 缺省 = 硬切（不占键）。时长缺省 0.5s，上限 min(2, 本段一半, 下段一半)。 */
export const TRANSITIONS = [
  { id: 'none', name: '无转场' },
  { id: 'fade', name: '淡入淡出' },
  { id: 'zoom', name: '轻推拉' },
  { id: 'flash', name: '闪白切换' },
  { id: 'wipe-left', name: '左推入' },
  { id: 'wipe-up', name: '上推入' },
  { id: 'blur', name: '模糊切' },
  { id: 'split', name: '双开门' },
  { id: 'glitch', name: '故障闪' },
];
const TRANSITION_IDS = new Set(TRANSITIONS.map(t => t.id));
export const transitionNameOf = id => (TRANSITIONS.find(t => t.id === id) || TRANSITIONS[0]).name;

/* 这一段 / 下一段各自能给多少秒：转场最多吃掉较短那一段的一半，且不超过 2 秒。 */
export function transitionMax(left, right) {
  const a = left ? pos(left.duration) : 0;
  const b = right ? pos(right.duration) : 0;
  const shorter = Math.min(a || TRANSITION_MAX_SECONDS * 2, b || TRANSITION_MAX_SECONDS * 2);
  return Math.max(TRANSITION_MIN_SECONDS, Math.min(TRANSITION_MAX_SECONDS, shorter / 2));
}

/* 规整一条转场：未知 id 当 none、时长夹进 [0.1, min(2, 两段各半)]。
   缺省时长写 0.5 —— 但真正用到时按两段的实际长度再夹一次（`transitionOf`）。 */
export function normalizeTransition(value, left, right) {
  if (!value || typeof value !== 'object') return null;
  const id = TRANSITION_IDS.has(String(value.id)) ? String(value.id) : 'none';
  if (id === 'none') return null;
  const dur = clamp(round2(value.duration ?? DEFAULT_TRANSITION_SECONDS), TRANSITION_MIN_SECONDS, transitionMax(left, right));
  return { id, duration: dur };
}

/* 读一段的转场（夹过、none → null）。传 `right` 才能按两段长度夹。 */
export const transitionOf = (clip, right) => (clip ? normalizeTransition(clip.transition, clip, right) : null);

/* 这一段进入下一段的转场窗口（成片秒）：`[本段末 - dur, 本段末)`。
   ⚠ 预览（engine/play.js）与导出（engine/export.js → MediaExport）**必须算同一道夹算**：
   两处各夹一次的话，屏幕上看到的那一刀和导出来的那条片子不是同一刀。
   `dur` 除了模型夹过的那一道（≤2s 且不超过两段各半），再按两段的**实际行长**兜一次底 ——
   行比转场短时不留半个窗口。 */
export function transitionWindow(row, next) {
  if (!row || !next) return null;
  const tr = row.clip && row.clip.transition;
  if (!tr || !tr.id || tr.id === 'none') return null;
  const dur = Math.max(TRANSITION_MIN_SECONDS, Math.min(
    num(tr.duration, DEFAULT_TRANSITION_SECONDS), row.end - row.start, next.end - next.start));
  const start = row.end - dur;
  return { id: tr.id, duration: dur, start, end: row.end, row, next };
}

/* 某一秒正落在哪个转场窗口里（预览每帧问一次）：带 `progress`（0→1）。窗口外返回 null。 */
export function transitionAtTime(rows, t) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const at = Math.max(0, num(t));
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (at >= list[i].start && at < list[i].end) { idx = i; break; }
  }
  if (idx < 0) return null;
  const w = transitionWindow(list[idx], list[idx + 1]);
  if (!w || at < w.start || at >= w.end) return null;
  return { ...w, progress: clamp((at - w.start) / w.duration, 0, 1) };
}

/* ---------------- 模型工厂 ---------------- */
/* Clip：主画面一段。sourceStart/sourceDuration 是素材里的窗口（源秒），
   duration 是成片里占的秒数（video：sourceDuration ÷ playbackRate；image：显式时长）。
   `mediaDuration` 是素材原长（源秒）—— 只给右缘加长的上限用，不参与任何折算。
   `transition` 是进入下一段的连接点；`trackFrames`（胶片格）与 `peaks`（原声波形）是采样缓存，
   素材或窗口一变就清空重采。`ln` 只决定画在第几行，不影响顺序。 */
export function createClip(o = {}) {
  const kind = o.kind === 'image' ? 'image' : 'video';
  const playbackRate = kind === 'image' ? 1 : clamp(num(o.playbackRate, 1) || 1, 0.25, 4);
  const sourceDuration = pos(o.sourceDuration);
  const duration = Math.max(MIN_CLIP_SECONDS, round2(o.duration != null ? num(o.duration)
    : (kind === 'image' ? (o.duration || IMAGE_SEGMENT_SECONDS) : sourceDuration / playbackRate)));
  const clip = {
    id: o.id || filmId('clip'),
    kind,
    shotId: o.shotId || '',
    candId: o.candId || '',
    assetId: o.assetId || '',
    name: o.name || '',
    src: o.src || '',
    sourceStart: pos(o.sourceStart),
    sourceDuration: round2(sourceDuration),
    mediaDuration: kind === 'image' ? 0 : round2(Math.max(sourceDuration, pos(o.mediaDuration))),
    duration,
    /* 这一段**前面**留出的空（成片秒，0 = 紧接上一段）。主画面顺序存储，但允许片段之间留空 ——
       空出来的那几秒是黑画面（导出同样按黑帧 + 静音），时间线总长跟着算进去。
       空只挂在**后面那一段**身上：挪走 / 删掉这一段，空也跟着它走，别处不用记账。 */
    gap: pos(o.gap),
    playbackRate,
    volume: clamp(num(o.volume, 1), 0, 4),
    muted: !!o.muted,
    ln: clamp(Math.round(num(o.ln, 0)), 0, LANE_MAX - 1),
    transition: null,
    trackFrames: Array.isArray(o.trackFrames) ? o.trackFrames : [],
    peaks: Array.isArray(o.peaks) ? o.peaks : [],
  };
  if (kind === 'image') clip.sourceDuration = 0;
  const t = normalizeTransition(o.transition, clip, null);
  if (t) clip.transition = t;
  return clip;
}

/* 成片里占的秒数：**存下来的 duration 是权威**（顺序派生的 start 全按它累加）。
   video 的 duration 与 sourceDuration ÷ playbackRate 由 `createClip` / `withPlaybackRate` /
   裁剪那几处保持同步；这里不再现算一份 —— 两处各算一次，改倍速之后必然有一处对不上。 */
export const clipDurationOf = clip => (clip
  ? Math.max(MIN_CLIP_SECONDS, round2(pos(clip.duration)))
  : 0);

/* 成片秒 ↔ 源秒之间只有这一把尺子：图片段没有源窗口，恒 1。
   裁剪、切开、滑移、播放取帧都问同一个口，免得某一处忘了图片那一档。 */
export const rateOf = item => (item && item.kind === 'image' ? 1 : clamp(num(item && item.playbackRate, 1) || 1, 0.25, 4));
/* 源窗口三件：从素材的第几秒开始吃、吃了多少秒、素材一共多长。
   不知道原长就按「已用到的那一尾」当下限 —— 外扩的上限于是 0，宁可不许拉，也不假装知道更长。 */
export const srcHeadOf = item => Math.max(0, num(item && item.sourceStart));
export const srcUsedOf = item => Math.max(0, num(item && item.sourceDuration, num(item && item.duration) * rateOf(item)));
export const srcLenOf = item => Math.max(srcHeadOf(item) + srcUsedOf(item), num(item && item.mediaDuration));

/* 改倍速：保持源窗口不动，duration = sourceDuration ÷ rate（参考 audioClipActions 的联动）。 */
export function withPlaybackRate(clip, rate) {
  const r = clamp(num(rate, 1) || 1, 0.25, 4);
  if (clip.kind === 'image') return clip;
  return {
    ...clip,
    playbackRate: r,
    duration: Math.max(MIN_CLIP_SECONDS, round2(pos(clip.sourceDuration) / r)),
  };
}

/* VoiceClip：定时的配音块（成片秒 start/duration；sourceStart/sourceDuration 是音频里的窗口）。 */
export function createVoiceClip(o = {}) {
  const playbackRate = clamp(num(o.playbackRate, 1) || 1, 0.25, 4);
  const sourceDuration = pos(o.sourceDuration);
  return {
    id: o.id || filmId('voice'),
    text: o.text || '',
    who: o.who || '',
    start: Math.max(0, round2(num(o.start))),
    duration: Math.max(MIN_CLIP_SECONDS, round2(o.duration != null ? num(o.duration) : sourceDuration / playbackRate)),
    sourceStart: pos(o.sourceStart),
    sourceDuration: round2(sourceDuration),
    mediaDuration: round2(Math.max(pos(o.sourceStart) + sourceDuration, pos(o.mediaDuration))),
    playbackRate,
    volume: clamp(num(o.volume, 1), 0, 4),
    fadeIn: Math.max(0, round2(num(o.fadeIn))),
    fadeOut: Math.max(0, round2(num(o.fadeOut))),
    lane: clamp(Math.round(num(o.lane, 0)), 0, LANE_MAX - 1),
    status: 'done',
    src: o.src || '',
    provider: o.provider || '',
    model: o.model || '',
    voice: o.voice || '',
    peaks: Array.isArray(o.peaks) ? o.peaks : [],
    shotId: o.shotId || '',
  };
}

/* Caption：字幕直接存成片秒（start/end）。voiceId = 来源配音块的 id；
   detachedVoiceId = 解除关联时的记忆位（「全部关联」优先认回它）。 */
export function createCaption(o = {}) {
  const start = Math.max(0, round2(num(o.start)));
  const end = Math.max(start + MIN_CAPTION_SECONDS, round2(num(o.end, start + 2)));
  return {
    id: o.id || filmId('cap'),
    text: o.text || '',
    start,
    end,
    position: o.position || 'bottom',
    style: o.style || 'default',
    voiceId: o.voiceId || '',
    detachedVoiceId: o.detachedVoiceId || '',
  };
}

/* 「按配音出字幕」那一步的唯一换算：一条配音块 → 一条挂在它身上的字幕，
   窗与文字照抄，`voiceId` 记上来源块（之后改块的位置与长度，字幕跟着走 —— `tl-resize.followCaptions`）。 */
export function captionForTimed(item) {
  const start = num(item && item.start);
  return createCaption({
    text: String((item && item.text) || '').trim(),
    start, end: start + pos(item && item.duration),
    voiceId: (item && item.id) || '',
  });
}

/* 标记模型在 tl-markers.js（四类五色、钟面格式、吸附点都归它）；这里只借它规整数组。 */

/* ---------------- 整份 film 的规整 ---------------- */
/* 读回来的每一份 film 都过这一道：数组齐全、字段夹紧、引用关系自洽。
   **无版本号、无迁移**：旧工程没有 `film` 就是一张空片（旧键不被任何一行读取）。 */
export function normalizeFilm(raw) {
  const f = (raw && typeof raw === 'object') ? raw : {};
  const clips = (Array.isArray(f.clips) ? f.clips : []).filter(c => c && typeof c === 'object').map(c => createClip(c));
  /* 转场要按相邻两段重新夹：切一刀之后原来那条转场可能已经超过新两段的一半。 */
  clips.forEach((c, i) => {
    const t = normalizeTransition(c.transition, c, clips[i + 1] || null);
    if (t) c.transition = t; else delete c.transition;
  });
  const voices = (Array.isArray(f.voices) ? f.voices : []).filter(v => v && typeof v === 'object').map(v => createVoiceClip(v));
  const captions = (Array.isArray(f.captions) ? f.captions : []).filter(c => c && typeof c === 'object').map(c => createCaption(c));
  const markers = normalizeMarkers(f.markers);
  /* 引用自洽：字幕指向一条已经不存在的定时块 → 记进记忆位（detachedVoiceId），链接本身断开。
     不假装还连着（连线画到空气里比断开更糟），也不把这条字幕删掉（用户没让删）。 */
  const live = new Set(voices.map(v => v.id));
  captions.forEach(c => {
    if (c.voiceId && !live.has(c.voiceId)) {
      c.detachedVoiceId = c.detachedVoiceId || c.voiceId;
      c.voiceId = '';
    }
  });
  const tracks = (f.tracks && typeof f.tracks === 'object') ? f.tracks : {};
  return {
    clips, voices, captions, markers,
    tracks: {
      visibility: (tracks.visibility && typeof tracks.visibility === 'object') ? { ...tracks.visibility } : {},
      locks: (tracks.locks && typeof tracks.locks === 'object') ? { ...tracks.locks } : {},
    },
  };
}

export function filmOf(project) {
  return (project && project.film) || normalizeFilm(null);
}

/* ---------------- 派生表（顺序 → start） ---------------- */
/* 主画面是一列顺序 clip：start 是派生的，不落盘。`rows[i] = { clip, index, start, end }`。
   `at` 越界时夹到首尾（参考 getVisualSegmentIndexAtTime）。 */
export function deriveTimeline(clips) {
  const list = Array.isArray(clips) ? clips : [];
  const rows = [];
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    const gap = Math.max(0, num(list[i].gap));
    at += gap;
    const dur = clipDurationOf(list[i]);
    rows.push({ clip: list[i], index: i, start: at, end: at + dur, gap });
    at += dur;
  }
  const total = at;
  return {
    rows,
    total,
    /* 「这一刻属于哪一段」。落在空隙里的秒没有段 —— 调用方按**后面那一段**当邻居用
       （拖动落点、点击拾取都靠它），末尾之后仍夹到最后一段（与以前一致）。 */
    indexAtTime(time) {
      if (!rows.length) return -1;
      const t = Math.max(0, num(time));
      for (let i = rows.length - 1; i >= 0; i--) {
        if (t >= rows[i].start && t < rows[i].end) return i;
      }
      for (let i = 0; i < rows.length; i++) {
        if (t < rows[i].start) return i;      // 空隙里 → 后面那一段
      }
      return rows.length - 1;
    },
    /* 「这一刻真的有画面」。空隙里返回 null（预览要放**黑**，不是停着上一帧）。 */
    rowAtTime(time) {
      const t = Math.max(0, num(time));
      for (let i = 0; i < rows.length; i++) {
        if (t >= rows[i].start && t < rows[i].end) return rows[i];
      }
      return null;
    },
  };
}

export const filmTotal = clips => deriveTimeline(clips).total;

/* 钉在成片秒的东西最右到几秒（配音 / 字幕 / 标记；都不随剪辑搬移）。
   把成片剪短之后它们可以留在末尾之外 —— 轨道的水平跨度不盖住那一截，
   尺、网格与行底色就画不到它：右边多出一条还能滚进去的空道，针也跳不到那一秒。 */
export function pinnedEndOf(film) {
  const f = film || {};
  let end = 0;
  (Array.isArray(f.voices) ? f.voices : []).forEach(v => {
    end = Math.max(end, num(v && v.start) + Math.max(0, num(v && v.duration)));
  });
  (Array.isArray(f.captions) ? f.captions : []).forEach(c => {
    end = Math.max(end, num(c && c.end));
  });
  return Math.max(end, markerSpanEnd(f.markers));
}

/* 一段的边界（成片秒）：主画面找第 index 段；找不到返回 null（不拿 0 冒充）。 */
export function clipBoundary(clips, index) {
  const tl = deriveTimeline(clips);
  const row = tl.rows[index];
  return row ? { start: row.start, end: row.end } : null;
}

/* ---------------- 提升（候选 → 片段） ---------------- */
/* 「这一镜选用的那一条候选」：判据只有这一处（`sh.selId` 认 vid）。
   成片提升、镜头那一行的时长、候选卡的选中态都问它，不各自 `find` 一遍。 */
export const chosenCandOf = sh => ((sh && sh.candidates) || []).find(c => c && c.vid === sh.selId) || null;
/* 候选的源窗口：老字段 `trimS/trimE` 仍在（候选卡与归档摘要读它们），
   提升只用这两个 + 平台回的时长，不读 `c.segs`。 */
export function candidateWindow(cand) {
  const dur = pos(cand && cand.duration);
  const s = Math.max(0, Math.min(num(cand && cand.trimS, 0), dur || Infinity));
  const e = Math.max(s, Math.min(num(cand && cand.trimE, dur || s + 1) || dur, dur || s + 1));
  const out = e > s ? e : (dur > 0 ? dur : s + IMAGE_SEGMENT_SECONDS);
  return { sourceStart: round2(s), sourceDuration: round2(Math.max(MIN_CLIP_SECONDS, out - s)) };
}

/* 提升：这一镜选了哪一条，成片里那一段就换成哪一条。
   · 这一镜已经有片段 → **原位替换**（id / 位置 / 行 / 转场都保留，素材字段换新，采样缓存清空重采）；
   · 还没有 → 按**镜头在项目里的顺序**插入（不是按候选顺序、也不是追加到末尾）。
   `shotOrder` = 项目里所有镜头 id 的顺序（跨场景连续）；缺省时按「已有片段里第一个更晚的镜头」排。
   返回 `{ clips, index, replaced }`；clips 是新数组（模型不可变替换，重画出口看身份）。 */
export function promoteCandidate(clips, shot, cand, shotOrder) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  if (!shot || !cand) return { clips: list, index: -1, replaced: false };
  const win = candidateWindow(cand);
  const src = cand.url || (cand.assetId ? `/asset/${cand.assetId}` : '');
  const kind = cand.kind === 'image' ? 'image' : 'video';
  const at = list.findIndex(clip => clip && clip.shotId === shot.id);
  if (at >= 0) {
    /* 原位替换时**种类也跟着换**：先前的图片段换成视频候选（或反过来）时，
       只换素材字段会留下旧的 kind —— 视频段按图片画（一条没有胶片的底色条），
       切片 / 预览 / 导出都取不到画面。 */
    const old = list[at];
    list[at] = createClip({
      ...old,
      kind,
      candId: cand.vid || old.candId,
      assetId: cand.assetId || '',
      name: shot.name || old.name,
      src: src || old.src,
      sourceStart: kind === 'image' ? 0 : win.sourceStart,
      sourceDuration: kind === 'image' ? 0 : win.sourceDuration,
      mediaDuration: pos(cand.duration) || old.mediaDuration,
      duration: kind === 'image' ? (clipDurationOf(old) || IMAGE_SEGMENT_SECONDS) : undefined,
      playbackRate: old.playbackRate,
      trackFrames: [],
      peaks: [],
    });
    return { clips: list, index: at, replaced: true };
  }
  const clip = createClip({
    kind: cand.kind === 'image' ? 'image' : 'video',
    shotId: shot.id,
    candId: cand.vid || '',
    assetId: cand.assetId || '',
    name: shot.name || '',
    src,
    sourceStart: win.sourceStart,
    sourceDuration: win.sourceDuration,
    mediaDuration: pos(cand.duration),
    duration: cand.kind === 'image' ? Math.max(IMAGE_SEGMENT_SECONDS, pos(cand.duration)) : undefined,
  });
  /* 插入位置：所有「镜头顺序比它早」的片段之前插不进去，之后又晚 —— 找到第一个更晚镜头的位置。
     同一镜的多段（切刀切出来的）都留在原位。没有顺序表时退回「追加到末尾」。 */
  let insertAt = list.length;
  if (Array.isArray(shotOrder) && shotOrder.length) {
    const mine = shotOrder.indexOf(shot.id);
    if (mine >= 0) {
      insertAt = list.length;
      for (let i = 0; i < list.length; i++) {
        const other = shotOrder.indexOf(list[i] && list[i].shotId);
        if (other > mine) { insertAt = i; break; }
      }
    }
  }
  list.splice(insertAt, 0, clip);
  return { clips: list, index: insertAt, replaced: false };
}

/* 取消选用：把这一镜的片段从成片里撤掉（按 shotId）。
   返回 `{ clips, removed }`；removed = 撤掉了几段（切刀切出来的可能是多段）。 */
export function demoteShot(clips, shotId) {
  const list = Array.isArray(clips) ? clips : [];
  const next = list.filter(c => !(c && c.shotId === shotId));
  return { clips: next, removed: list.length - next.length };
}

/* ---------------- 行打包（参考 packTimedSegmentsIntoLanes） ---------------- */
/* 定时条目按 `lane` 偏好放进第一个不重叠的行；行数 = 实际用到的行数（不预分配）。
   `lane` 只在真的放得下时被尊重 —— 放不下就往下找空行（参考行为）。
   返回 `{ lanes: [{ lane, items }], overflow }`：超过 `maxLanes` 的那部分报数，不静默丢。 */
export function packVoiceLanes(items, { preferredLaneKey = 'lane', maxLanes = LANE_MAX } = {}) {
  const src = (Array.isArray(items) ? items : []).filter(x => x && typeof x === 'object');
  const ordered = [...src].sort((a, b) => (num(a.start) - num(b.start)));
  const lanes = [];
  const laneFree = (lane, item) => lane.every(other => {
    const a0 = num(other.start), a1 = a0 + num(other.duration);
    const b0 = num(item.start), b1 = b0 + num(item.duration);
    return a1 <= b0 + 0.001 || b1 <= a0 + 0.001;
  });
  ordered.forEach(item => {
    const prefer = Number.isInteger(item[preferredLaneKey]) ? Math.max(0, item[preferredLaneKey]) : -1;
    let lane = -1;
    if (prefer >= 0 && (prefer >= lanes.length || laneFree(lanes[prefer], item))) {
      while (prefer >= lanes.length) lanes.push([]);
      lane = prefer;
    } else {
      lane = lanes.findIndex(l => laneFree(l, item));
      if (lane < 0) { lanes.push([]); lane = lanes.length - 1; }
    }
    lanes[lane].push(item);
    lanes[lane].sort((a, b) => num(a.start) - num(b.start));
  });
  const overflow = Math.max(0, lanes.length - maxLanes);
  return {
    lanes: lanes.slice(0, maxLanes).map((list, lane) => ({ lane, items: list })),
    overflow,
  };
}

/* 字幕按起止打包成字幕行（参考 packCaptionSegmentsIntoLanes）：后一段在前一段结束后才起才换行。 */
export function packCaptionLanes(captions, maxLanes = LANE_MAX) {
  const src = (Array.isArray(captions) ? captions : []).filter(c => c && typeof c === 'object')
    .slice().sort((a, b) => num(a.start) - num(b.start));
  const lanes = [];
  src.forEach(cap => {
    let lane = lanes.findIndex(l => {
      const last = l[l.length - 1];
      return !last || num(last.end) <= num(cap.start) + 0.001;
    });
    if (lane < 0) { lanes.push([]); lane = lanes.length - 1; }
    lanes[lane].push(cap);
  });
  const overflow = Math.max(0, lanes.length - maxLanes);
  return {
    lanes: lanes.slice(0, maxLanes).map((items, lane) => ({ lane, items })),
    overflow,
  };
}

/* 「这一条定时块画在第几行」的 id → 行号表（预览与导出共用的一张）。
   两处各 pack 一遍就会各漂一次：眼睛关掉的到底是屏幕上那一行还是片子里那一行，
   只有同一张表才答得准。 */
export function voiceLaneMap(film) {
  const pack = packVoiceLanes((film && film.voices) || []);
  const map = new Map();
  pack.lanes.forEach(l => l.items.forEach(x => map.set(x.id, l.lane)));
  return map;
}
export function captionLaneMap(film) {
  const pack = packCaptionLanes((film && film.captions) || []);
  const map = new Map();
  pack.lanes.forEach(l => l.items.forEach(c => map.set(c.id, l.lane)));
  return map;
}

/* 「这一块画在第几行」（打包口径）：画面看 `clip.ln`，配音与字幕看打包后的行号。
   锁判据、助手写入桥与「板上没画出来时」的选中都读这一处 —— 存下来的 `item.lane` 只是偏好，
   真正画在第几行是打包算出来的，两把尺混用就会锁错行。找不到条目返回 -1。 */
export function filmLaneOf(film, kind, id) {
  if (!film || !id) return -1;
  if (kind === 'clip') {
    const clip = (film.clips || []).find(c => c && c.id === id);
    return clip ? Math.max(0, Math.round(num(clip.ln))) : -1;
  }
  const map = kind === 'cap' ? captionLaneMap(film) : voiceLaneMap(film);
  return map.has(id) ? map.get(id) : -1;
}

/* ---------------- 行级眼睛 / 锁（参考 projectTrackState） ---------------- */
/* 行键：画面 `image` / 配音 `voice` / 配音行 `voice-0` … /
   字幕 `caption` / 字幕行 `caption-0` …。整轨隐藏 = 该轨所有行都藏。 */
export const rowVisible = (tracks, key) => !(tracks && tracks.visibility && tracks.visibility[key] === false);
export const rowLocked = (tracks, key) => !!(tracks && tracks.locks && tracks.locks[key] === true);
export function rowSet(tracks, kind, key, value) {
  const t = tracks || (tracks = { visibility: {}, locks: {} });
  const bag = kind === 'lock' ? t.locks : t.visibility;
  if (value == null) delete bag[key]; else bag[key] = value;
}

/* 条目的可见 / 锁定：整轨（voice / caption / image）与行级（`voice-2`）两道。 */
export function itemVisible(tracks, track, lane) {
  if (!rowVisible(tracks, track)) return false;
  return lane == null || rowVisible(tracks, `${track}-${lane}`);
}
export function itemLocked(tracks, track, lane) {
  if (rowLocked(tracks, track)) return true;
  return lane != null && rowLocked(tracks, `${track}-${lane}`);
}

/* 一条字幕在画面上长什么样（预览叠层与导出合成共用的两个读数）：位置只有三档
   （认不出来按底部走），高亮 = `style` 有值且不是 `plain`。
   两处各判一次的话，屏幕上那一行字与片子里那一行字会成两副样子。 */
const CAPTION_POSITIONS = ['top', 'middle', 'bottom'];
export const captionPosition = cap => (CAPTION_POSITIONS.includes(cap && cap.position) ? cap.position : 'bottom');
export const captionPositions = () => CAPTION_POSITIONS.slice();
export const captionHighlighted = cap => !!(cap && cap.style && cap.style !== 'plain');
/* 「要不要高亮」这一个开关存进 `style` 的那个值：右栏的勾与助手写的字段都从这一枚来，
   两处各写各的字面量，早晚会有一边写出认不出来的样式。 */
export const captionStyleOf = highlighted => (highlighted ? 'default' : 'plain');

/* ---------------- 进成片的那几项（预览与导出共用的两道闸） ----------------
   「眼睛关掉的那一行不出声 / 不露字」这一条判据只有这一处：导出问它，回执才知道要报几句没进片。
   返回 `{ list, skipped }`，`skipped` 分项计数 —— 被闸掉的每一条都要能被点名，不许静默丢。
   没有字节的配音块（`src` 空）不进片：它只是「这一句要念」的记录，混音那侧拿不到东西。
   画面轨的眼睛**不在这里**：预览里压暗某一格只是编辑视图的事，那一格照样在片子里。 */
export function audibleVoices(film) {
  const f = film || { voices: [], tracks: {} };
  const all = f.voices || [];
  const withSrc = all.filter(v => v && v.src);
  const laneOf = voiceLaneMap(f);
  const list = [];
  let hidden = 0;
  withSrc.forEach(v => {
    if (itemVisible(f.tracks, 'voice', laneOf.get(v.id))) list.push(v); else hidden++;
  });
  return { list, skipped: { hidden, noSrc: all.length - withSrc.length } };
}

/* 字幕要真的印得出字才算数：空文与零长的窗都不进片（也不进指纹，否则「删掉一句空字幕」
   会让快捷闸白跑一遍合成）。 */
export function visibleCaptions(film) {
  const f = film || { captions: [], tracks: {} };
  const all = f.captions || [];
  const timed = all.filter(c => c && String(c.text || '').trim() && num(c.end) > num(c.start));
  const laneOf = captionLaneMap(f);
  const list = [];
  let hidden = 0;
  timed.forEach(c => {
    if (itemVisible(f.tracks, 'caption', laneOf.get(c.id))) list.push(c); else hidden++;
  });
  return { list, skipped: { hidden, empty: all.length - timed.length } };
}

/* ---------------- 台词行（speakerOf / lineRowHTML） ----------------
   剪辑右栏「台词」那一档与「生成配音」档共用这一份：一行 = 一句台词（挂在一条定时块上）。
   `row = { id, sh, no, who, text, speaker, time, mine, voiced }` —— 调用方给数据，这里只画。 */
const secTxt = v => String(Math.round((Number(v) || 0) * 10) / 10);

/* 说话人 → 素材库那一位（按名字认，与音色描述 / 参考音频同一个判据）。
   素材库里没有也把名字原样带回来 —— 界面写「不在素材库」，不吞掉用户写的名字。 */
export function speakerOf(who, lib) {
  const name = String(who || '').replace(/\s+/g, ' ').trim();
  if (!name) return { name: '', img: '', inLib: false, empty: true };
  const item = (lib || []).find(x => String((x && x.name) || '').trim() === name);
  return {
    name,
    img: item ? String(item.anchor || item.face || item.img || '') : '',
    inLib: !!item,
    empty: false,
  };
}

/* 一个读数：这一句在成片那一轨上占哪几秒（调用方把块的 start/duration 交进来）。 */
export function lineTimeOf(o) {
  const at = o && Number.isFinite(Number(o.start)) ? Number(o.start) : null;
  const len = o && Number.isFinite(Number(o.duration)) ? Number(o.duration) : 0;
  return {
    whenText: at == null ? '成片 —' : '成片 ' + secTxt(at) + '–' + secTxt(at + len) + ' 秒',
    title: at == null ? '这一句还没上轨：轨道上没有可摆的位置' : '时间线读数（拖动块可改）',
  };
}

/* 一行台词：头像 + 说话人 + 状态徽章 + 镜号 / 那一秒区间 + 台词输入框。
   两格输入都直接写调用方交给它的那一份（binder 在 engine/voice.js，这里只画不改）。 */
export function lineRowHTML(row, o) {
  const esc = o.esc;
  const sp = row.speaker;
  const thumb = sp.img
    ? `<img src="${esc(o.mediaSrc(sp.img))}" alt="" loading="lazy">`
    : `<span class="lr-ph">${o.icon('user', 14)}</span>`;
  const name = sp.empty ? '未写说话人' : sp.name;
  const note = sp.empty ? '' : (sp.inLib ? '' : ' · 不在素材库');
  const empty = !String(row.text || '').trim();
  const state = empty ? 'none' : (row.voiced ? 'done' : 'none');
  const stateTxt = empty ? '未写' : (row.voiced ? '已生成' : '未生成');
  return `<div class="line-row edit${row.mine ? ' on' : ''}" data-lineid="${esc(row.id)}"
    title="${esc((row.no ? '第 ' + row.no + ' 镜' : '') + (row.time.title ? ' · ' + row.time.title : '') + (o.clickHint ? '。' + o.clickHint : ''))}">
    <div class="lr-thumb${sp.img ? '' : ' ph'}" title="${esc(name + note)}">${thumb}</div>
    <div class="lr-body">
      <div class="lr-top">
        <input class="ui-inp lr-name" data-line-who="${esc(row.id)}" list="lineWhoList" value="${esc(row.who)}"
          placeholder="说话的人" title="填素材库里同名的素材，音色会自动取过来">
        <em class="${state}">${stateTxt}</em>
      </div>
      <div class="lr-when"><span>${row.no ? '第 ' + row.no + ' 镜' : '全片'}</span><span>${esc(row.time.whenText)}</span></div>
      <textarea class="ui-ta lr-ta" rows="1" data-line-text="${esc(row.id)}" placeholder="这一句要念出来的台词">${esc(row.text)}</textarea>
    </div>
  </div>`;
}

/* ---------------- 小工具（各域共用） ---------------- */
/* 定时条目整体平移（波纹 / 拖动提交）：start 夹在 0 上，字幕带 end。 */
export function shiftTimed(item, delta) {
  const start = Math.max(0, round2(num(item.start) + delta));
  const out = { ...item, start };
  if (Number.isFinite(Number(item.end))) out.end = Math.max(start + MIN_CAPTION_SECONDS, round2(num(item.end) + delta));
  return out;
}

/* 预览 / 导出用的绝对窗口：`{ start, end }`（成片秒）。 */
export const windowOf = item => ({ start: num(item && item.start), end: num(item && item.start) + num(item && item.duration) });

/* 条目在成片秒某处是否正在播（配音 / 字幕共用）。 */
export const coversTime = (item, t) => t >= num(item.start) - 0.0005 && t < num(item.start) + num(item.duration) - 0.0005;

/* 音量增益（导出 / 预览共用）：静音 = 0（`muted` 不动存下来的音量，取消静音就恢复原值）；
   >1 交给 WebAudio 增益，元素音量封顶 1。 */
export const gainOf = item => (item && item.muted ? 0 : clamp(num(item && item.volume, 1), 0, 4));

/* fade 包络：块内相对秒 → 增益系数（参考 audio clip 的 fadeIn / fadeOut，各夹到有效时长一半）。 */
export function fadeGain(item, relSec) {
  const dur = pos(item && item.duration);
  const fi = Math.min(pos(item && item.fadeIn), dur / 2);
  const fo = Math.min(pos(item && item.fadeOut), dur / 2);
  let g = 1;
  if (fi > 0 && relSec < fi) g = Math.min(g, Math.max(0, relSec / fi));
  if (fo > 0 && relSec > dur - fo) g = Math.min(g, Math.max(0, (dur - relSec) / fo));
  return g;
}
