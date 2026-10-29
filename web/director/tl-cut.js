/* 切刀与融合（纯件，无 DOM）—— 参考 lib/timelineCutActions.js 的 splitVisualSegmentState：
   从切点把一段拆成两段，源窗口 / 胶片格 / 波形按比例分家；
   转场归**右边**那一段（它指向的下一段没变），左边那一段的连接点变成硬切。
   融合只对「同一素材、源窗口首尾相接、没再动过」的两段有效（本项目原有语义）。 */

import { MIN_CLIP_SECONDS, clipDurationOf } from './film.js';
import { num, round2 } from './util.js';
import { slicePeaks } from './tl-peaks.js';

/* `atTime` 是**成片秒**（时间线那一把尺子）；行内定位与源秒折算都从这里出发。 */
const newId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* 胶片格按源秒切开：左半留 t < 切点，右半留 t ≥ 切点（格子本身不重采）。 */
const splitFrames = (frames, cutSource) => {
  const left = [], right = [];
  (Array.isArray(frames) ? frames : []).forEach(f => {
    if (!f) return;
    (num(f.t) < cutSource ? left : right).push(f);
  });
  return { left, right };
};

/* 画面切一刀。`atTime` 是成片秒（相对整条时间线）；`index` 是要切的那一段。
   切点离两端不足最短段 → 不动，返回 `{ ok:false, clips }`（调用方照实回执）。 */
export function splitClipAt(clips, index, atTime) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  const clip = list[index];
  if (!clip) return { ok: false, clips: list, index: -1, reason: '没有这一段' };
  /* 行首 = 前面几段的时长**加上它们各自的空隙**，再加这一段自己前面那段空。 */
  let rowStart = 0;
  for (let i = 0; i < index; i++) rowStart += Math.max(0, num(list[i].gap)) + clipDurationOf(list[i]);
  rowStart += Math.max(0, num(clip.gap));
  const dur = clipDurationOf(clip);
  const local = round2(num(atTime) - rowStart);
  if (!(local >= MIN_CLIP_SECONDS) || !(dur - local >= MIN_CLIP_SECONDS)) {
    return { ok: false, clips: list, index: -1, reason: '切点太靠边，两段都不足最短时长' };
  }
  const rate = Math.max(0.25, num(clip.playbackRate, 1) || 1);
  const srcCut = round2(num(clip.sourceStart) + local * rate);
  const leftFrames = splitFrames(clip.trackFrames, srcCut);
  const leftPeaks = slicePeaks(clip.peaks, 0, local / dur);
  const rightPeaks = slicePeaks(clip.peaks, local / dur, 1);
  const left = {
    ...clip,
    duration: local,
    sourceDuration: round2(local * rate),
    trackFrames: leftFrames.left,
    peaks: leftPeaks,
  };
  delete left.transition;                       // 新出现的连接点是硬切
  const right = {
    ...clip,
    id: newId('clip'),
    gap: 0,                       // 切出来的右半紧接左半；空只归左半身上那一段
    duration: round2(dur - local),
    sourceStart: srcCut,
    sourceDuration: round2((dur - local) * rate),
    trackFrames: leftFrames.right,
    peaks: rightPeaks,
  };
  if (clip.transition) right.transition = { ...clip.transition };
  list.splice(index, 1, left, right);
  return { ok: true, clips: list, index, left, right };
}

/* 配音块切一刀：源窗口与波形按比例分家；左半保留原 id（挂在它身上的字幕不动）。 */
export function splitVoiceAt(voices, id, atTime) {
  const list = Array.isArray(voices) ? voices.slice() : [];
  const at = list.findIndex(v => v && v.id === id);
  if (at < 0) return { ok: false, voices: list, index: -1, reason: '没有这一条配音' };
  const it = list[at];
  const local = round2(num(atTime) - num(it.start));
  const dur = round2(num(it.duration));
  if (!(local >= MIN_CLIP_SECONDS) || !(dur - local >= MIN_CLIP_SECONDS)) {
    return { ok: false, voices: list, index: -1, reason: '切点太靠边，两段都不足最短时长' };
  }
  const rate = Math.max(0.25, num(it.playbackRate, 1) || 1);
  const left = {
    ...it,
    duration: local,
    sourceDuration: round2(local * rate),
    peaks: slicePeaks(it.peaks, 0, local / dur),
  };
  const right = {
    ...it,
    id: newId('voice'),
    start: round2(num(it.start) + local),
    duration: round2(dur - local),
    sourceStart: round2(num(it.sourceStart) + local * rate),
    sourceDuration: round2((dur - local) * rate),
    peaks: slicePeaks(it.peaks, local / dur, 1),
  };
  list.splice(at, 1, left, right);
  return { ok: true, voices: list, index: at, left, right };
}

/* 字幕切一刀：左侧保留原 id（链接不动），右半是新条目、继承同一条链接。 */
export function splitCaptionAt(captions, id, atTime) {
  const list = Array.isArray(captions) ? captions.slice() : [];
  const at = list.findIndex(c => c && c.id === id);
  if (at < 0) return { ok: false, captions: list, index: -1, reason: '没有这一条字幕' };
  const cap = list[at];
  const cut = round2(num(atTime));
  if (!(cut - num(cap.start) >= 0.1) || !(num(cap.end) - cut >= 0.1)) {
    return { ok: false, captions: list, index: -1, reason: '切点太靠边，两段都不足 0.1 秒' };
  }
  const left = { ...cap, end: cut };
  const right = { ...cap, id: newId('cap'), start: cut };
  list.splice(at, 1, left, right);
  return { ok: true, captions: list, index: at, left, right };
}

/* 两段能不能融合：同一素材、同一倍速、源窗口首尾相接。 */
export function canMergeClips(left, right) {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (String(left.src || '') !== String(right.src || '')) return false;
  if (Math.abs(num(left.playbackRate, 1) - num(right.playbackRate, 1)) > 0.001) return false;
  if (left.kind === 'image') return true;
  const lEnd = num(left.sourceStart) + num(left.sourceDuration);
  return Math.abs(lEnd - num(right.sourceStart)) < 0.02;
}

/* 融合第 index 段与下一段：保留左段的 id / 位置 / 行，右段的转场接过来（它指向的那一段没变）。 */
export function mergeClipsAt(clips, index) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  const left = list[index], right = list[index + 1];
  if (!canMergeClips(left, right)) return { ok: false, clips: list, index: -1, reason: '这两段接不上（不同素材，或中间动过）' };
  const merged = {
    ...left,
    duration: round2(clipDurationOf(left) + clipDurationOf(right)),
    sourceDuration: round2(num(left.sourceDuration) + num(right.sourceDuration)),
    trackFrames: [...(Array.isArray(left.trackFrames) ? left.trackFrames : []), ...(Array.isArray(right.trackFrames) ? right.trackFrames : [])],
    peaks: [...(Array.isArray(left.peaks) ? left.peaks : []), ...(Array.isArray(right.peaks) ? right.peaks : [])],
  };
  if (right.transition) merged.transition = { ...right.transition }; else delete merged.transition;
  list.splice(index, 2, merged);
  return { ok: true, clips: list, index, clip: merged };
}

/* 删除一段（画面轨 splice 前移，没有空洞）。返回被删的那一段给回执念名字用。 */
export function removeClipAt(clips, index) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  const [gone] = list.splice(index, 1);
  return { clips: list, removed: gone || null };
}

/* 复制一段到它后面（参考 handleDuplicateTrack）：副本拿新 id，转场不带（两份之间的连接点是硬切）。 */
export function duplicateClipAt(clips, index) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  const clip = list[index];
  if (!clip) return { clips: list, index: -1, clip: null };
  const copy = { ...clip, id: newId('clip'), gap: 0 };   // 副本紧接原段，不重复它前面那段空
  delete copy.transition;
  list.splice(index + 1, 0, copy);
  return { clips: list, index: index + 1, clip: copy };
}
