/* 渐进胶片格（纯件，无 DOM）—— 参考 lib/videoTrackFrames.js 的取样与合并口径：
   · 每一格的**宽度**决定要几格（格宽 = FRAME_CELL_PX，随缩放变的是总宽）；
   · 取样点按源秒均匀铺在 clip 的**源窗口**里，已有格子（±FRAME_MERGE_TOL）不重取；
   · 存进 `clip.trackFrames = [{ t, url, w, h }]`，t 是**绝对源秒** —— 窗口一变，位置由源秒现算，
     不用重排数组。
   取帧本身（解码 / 盘上缓存 / 退避）在 engine/frames.js，这里只算要哪几帧、怎么并。 */

import { num } from './util.js';

export const FRAME_CELL_PX = 84;
export const FRAME_MERGE_TOL = 0.06;
export const FRAME_MIN_COUNT = 1;
export const FRAME_MAX_COUNT = 480;

/* 这一段该出几格：按像素宽算，向上取整（最后半格也要有画面，不然条带右边空一条），
   夹在两档之间。 */
export function frameCountFor(widthPx, cellWidth = FRAME_CELL_PX) {
  const w = Math.max(0, num(widthPx));
  const c = Math.max(24, num(cellWidth, FRAME_CELL_PX));
  return Math.max(FRAME_MIN_COUNT, Math.min(FRAME_MAX_COUNT, Math.ceil(w / c)));
}

/* 要取的源秒（均匀铺满源窗口；图片段没有可取的帧，返回空数组）。 */
export function planFrameTimes(clip, count) {
  if (!clip || clip.kind === 'image') return [];
  const start = Math.max(0, num(clip.sourceStart));
  const dur = Math.max(0, num(clip.sourceDuration));
  if (!(dur > 0)) return [];
  const n = Math.max(FRAME_MIN_COUNT, Math.min(FRAME_MAX_COUNT, Math.round(num(count, 1))));
  const out = [];
  for (let i = 0; i < n; i++) {
    /* 取样点在格子**中心**：两头各让半格，避免首尾帧正好压在段落边界上。 */
    const at = start + dur * ((i + 0.5) / n);
    out.push(Math.round(at * 1000) / 1000);
  }
  return out;
}

/* 还缺哪几帧：已有格子按 ±FRAME_MERGE_TOL 合并（参考 mergeExact）。 */
export function missingFrameTimes(clip, count) {
  const have = Array.isArray(clip && clip.trackFrames) ? clip.trackFrames : [];
  return planFrameTimes(clip, count).filter(t => !frameAtTime(have, t, FRAME_MERGE_TOL));
}

/* 按时间找一帧（容差内最近）。 */
export function frameAtTime(frames, sourceTime, tol = FRAME_MERGE_TOL) {
  const t = num(sourceTime);
  let best = null;
  (Array.isArray(frames) ? frames : []).forEach(f => {
    if (!f) return;
    const d = Math.abs(num(f.t) - t);
    if (d <= tol && (!best || d < Math.abs(num(best.t) - t))) best = f;
  });
  return best;
}

/* 这一排格子的「就近顶上」容差：相邻两格跨多远的一半多 —— 解码回来的帧落在**真实包时刻**
   上，与计划的采样点对不齐（差零点几秒是常态），按它容差取最近的一张。
   渐进上屏（strip.js 的步骤①）与解码回执（frames.js 的 ensureFrames）**必须同一份**：
   各写一份的话，一边顶得上、一边顶不上，表现就是「后半段的格子要拖一下轨道才出现」。
   单格（或一格）时退 0.5：磁贴跨不到一整格，固定半秒已经盖住常见的帧距。 */
export function spanTolOf(times) {
  const list = Array.isArray(times) ? times : [];
  const n = list.length;
  if (n < 2) return 0.5;
  const span = (num(list[n - 1]) - num(list[0])) / (n - 1);
  return Math.max(0.041, Number.isFinite(span) ? span * 0.55 : 0.5);
}

/* 合并进已有格子：新到的按 t 排序插入，±容差内取新（新解码的更干净）。 */
export function mergeFrames(existing, incoming, tol = FRAME_MERGE_TOL) {
  const out = (Array.isArray(existing) ? existing : []).filter(f => f && Number.isFinite(Number(f.t)));
  (Array.isArray(incoming) ? incoming : []).forEach(f => {
    if (!f || !Number.isFinite(Number(f.t))) return;
    const at = out.findIndex(x => Math.abs(num(x.t) - num(f.t)) <= tol);
    if (at >= 0) out[at] = f; else out.push(f);
  });
  return out.sort((a, b) => num(a.t) - num(b.t));
}

/* 覆盖检查：源窗口里还差多少比例没帧（0 = 齐了）。给「先可见区分相精化」排期用。 */
export function frameCoverage(clip) {
  const frames = Array.isArray(clip && clip.trackFrames) ? clip.trackFrames : [];
  if (!clip || clip.kind === 'image' || !(num(clip.sourceDuration) > 0)) return 1;
  const start = num(clip.sourceStart);
  const end = start + num(clip.sourceDuration);
  const inside = frames.filter(f => f && num(f.t) >= start - FRAME_MERGE_TOL && num(f.t) <= end + FRAME_MERGE_TOL);
  if (!inside.length) return 0;
  /* 用「相邻帧最大空隙 ÷ 源窗口长」当缺口：空隙超过一格宽就算没覆盖全。 */
  const sorted = inside.slice().sort((a, b) => num(a.t) - num(b.t));
  let gap = Math.max(num(sorted[0].t) - start, end - num(sorted[sorted.length - 1].t));
  for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, num(sorted[i].t) - num(sorted[i - 1].t));
  return Math.max(0, Math.min(1, 1 - gap / (end - start)));
}
