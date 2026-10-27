/* 时间线吸附（纯件，无 DOM）—— 参考 lib/timelineSnap.js：
   吸附点 = 时间线 0 与末尾、播放头、各轨所有块边缘、各标记的边缘；
   阈值是**像素**（TL_SNAP_PX），换算成秒只有调用方一处（10 / pxPerSec）。
   Alt 旁路由手势层做：按住 Alt 就不问这里（判据在 engine/edit.js）。 */

import { num } from './util.js';

export const TL_SNAP_PX = 10;

/* 点集形状：`{ time, kind, id }`。kind 只给引导线的标签用（'start' / 'end' / 'playhead' / 'marker' / 'boundary'）。
   `exclude` 收 `{ clipId, itemId, skipPlayhead }` —— 正在拖的那一条自己不吸附自己。 */
export function collectTimelineSnapPoints(o = {}) {
  const out = [];
  const excludeId = o.exclude && (o.exclude.clipId || o.exclude.itemId) || '';
  const total = Math.max(0, num(o.total));
  out.push({ time: 0, kind: 'boundary', id: 'start' });
  if (total > 0) out.push({ time: total, kind: 'boundary', id: 'end' });
  if (!(o.exclude && o.exclude.skipPlayhead) && Number.isFinite(Number(o.playhead)) && Number(o.playhead) >= 0) {
    out.push({ time: num(o.playhead), kind: 'playhead', id: 'playhead' });
  }
  (Array.isArray(o.rows) ? o.rows : []).forEach(row => {
    if (!row || !row.clip || row.clip.id === excludeId) return;
    out.push({ time: num(row.start), kind: 'start', id: row.clip.id });
    out.push({ time: num(row.end), kind: 'end', id: row.clip.id });
  });
  const timed = [].concat(Array.isArray(o.voices) ? o.voices : [], Array.isArray(o.pending) ? o.pending : []);
  timed.forEach(it => {
    if (!it || it.id === excludeId) return;
    out.push({ time: num(it.start), kind: 'start', id: it.id });
    out.push({ time: num(it.start) + num(it.duration), kind: 'end', id: it.id });
  });
  (Array.isArray(o.captions) ? o.captions : []).forEach(c => {
    if (!c || c.id === excludeId) return;
    out.push({ time: num(c.start), kind: 'start', id: c.id });
    out.push({ time: num(c.end), kind: 'end', id: c.id });
  });
  (Array.isArray(o.markers) ? o.markers : []).forEach(m => {
    if (!m) return;
    out.push({ time: num(m.time), kind: 'marker', id: m.id });
    if (m.type === 'range') out.push({ time: num(m.endTime, num(m.time)), kind: 'marker', id: m.id });
  });
  return out;
}

/* 最近的一个吸附点：`{ time, point, distance }`，超过阈值给 null。 */
export function findClosestTimelineSnap(proposed, points, threshold) {
  const t = num(proposed);
  const th = Math.max(0, num(threshold));
  let best = null;
  (Array.isArray(points) ? points : []).forEach(p => {
    if (!p) return;
    const d = Math.abs(num(p.time) - t);
    if (d <= th && (!best || d < best.distance)) best = { time: num(p.time), point: p, distance: d };
  });
  return best;
}

/* 单值吸附（搓擦播放头 / 拖边缘 / 拖标记都用它）：返回 `{ time, snapped, point }`。 */
export function snapTimelineValue(proposed, points, threshold) {
  const hit = findClosestTimelineSnap(proposed, points, threshold);
  return hit ? { time: hit.time, snapped: true, point: hit.point } : { time: num(proposed), snapped: false, point: null };
}

/* 范围吸附：两个边缘都试、近者胜（参考 snapTimelineRange 的判据）。
   返回 `{ start, end, edge }`；edge = 'start' | 'end' | ''（没吸上）。 */
export function snapTimelineRange(start, duration, points, threshold) {
  const s = num(start);
  const d = Math.max(0, num(duration));
  const e = s + d;
  const hs = findClosestTimelineSnap(s, points, threshold);
  const he = findClosestTimelineSnap(e, points, threshold);
  if (hs && (!he || hs.distance <= he.distance)) return { start: hs.time, end: hs.time + d, edge: 'start', point: hs.point };
  if (he) return { start: he.time - d, end: he.time, edge: 'end', point: he.point };
  return { start: s, end: e, edge: '', point: null };
}

/* 引导线那一份读数：划线用 time（秒），标签用 `label`。kind 决定颜色（CSS 分档）。 */
export function createTimelineSnapGuide(snap, label) {
  if (!snap || !snap.point) return null;
  return {
    time: Math.max(0, num(snap.time)),
    kind: snap.point.kind || 'start',
    label: String(label || ''),
  };
}
