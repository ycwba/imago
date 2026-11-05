/* 拖动重排与跨行（纯件，无 DOM）—— 参考 lib/timelineReorderControls.js 与 visualOverlayTimeline.js：
   · 画面段的顺序是数组顺序，拖到哪一格就 splice 到哪一格；
   · 定时块的「在哪一行」是 `lane` 字段，落到已有行之间时**中间行 ±1 收缩**（参考 moveOverlaySegmentLane），
     拖到所有行之下 = 新开一行（行数由内容现算，不预分配）。
   指针命中哪一行/哪一格由 engine/edit.js 用 elementFromPoint 读 `data-drop-layer`，这里只算账。 */

import { LANE_MAX, clamp, deriveTimeline } from './film.js';
import { num, round2 } from './util.js';

/* 画面段换序：从 from 挪到 to（to 是**挪走之后**的目标下标）。 */
export function reorderClips(clips, from, to) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  if (!(from >= 0 && from < list.length)) return { clips: list, index: from };
  const dest = clamp(Math.round(num(to, from)), 0, list.length - 1);
  if (dest === from) return { clips: list, index: from };
  const [item] = list.splice(from, 1);
  list.splice(dest, 0, item);
  return { clips: list, index: dest };
}

/* 画面段拖到某一时刻时的落点下标：数有多少段的**中点**在那之前。`exclude` 是正在拖的那一段。 */
export function dropIndexAt(rows, time, excludeIndex = -1) {
  const t = num(time);
  let index = 0;
  (Array.isArray(rows) ? rows : []).forEach((row, i) => {
    if (!row || i === excludeIndex) return;
    if (t > (num(row.start) + num(row.end)) / 2) index++;
  });
  return index;
}

/* 画面段换行（只改 `ln`，不影响顺序）。 */
export function moveClipToLane(clips, id, lane) {
  const list = Array.isArray(clips) ? clips : [];
  const next = list.map(c => (c && c.id === id
    ? { ...c, ln: clamp(Math.round(num(lane)), 0, LANE_MAX - 1) }
    : c));
  return { clips: next, moved: next.some((c, i) => c !== list[i]) };
}

/* 定时块跨行移动：从当前 lane 挪到 targetLane，中间行 ±1 收缩（参考 moveOverlaySegmentLane）。
   目标比现在大 = 插到下面（经过的行往上补一格）；目标比现在小 = 插到上面（经过的行往下让一格）。 */
export function moveTimedToLane(items, id, targetLane) {
  const list = (Array.isArray(items) ? items : []).filter(x => x && typeof x === 'object');
  const item = list.find(x => x.id === id);
  if (!item) return { items: list, moved: false };
  const from = clamp(Math.round(num(item.lane)), 0, LANE_MAX - 1);
  const to = clamp(Math.round(num(targetLane)), 0, LANE_MAX - 1);
  if (from === to) return { items: list, moved: false };
  const next = list.map(x => {
    if (x.id === id) return { ...x, lane: to };
    const lane = clamp(Math.round(num(x.lane)), 0, LANE_MAX - 1);
    let nl = lane;
    if (to > from && lane > from && lane <= to) nl = lane - 1;
    else if (to < from && lane >= to && lane < from) nl = lane + 1;
    return nl === lane ? x : { ...x, lane: nl };
  });
  return { items: next, moved: true };
}

/* 删掉几条之后把中间的空行收掉（行数 = 最高占用 + 1，中间不许留洞）。 */
export function compactLanes(items) {
  const list = (Array.isArray(items) ? items : []).filter(x => x && typeof x === 'object');
  const used = [...new Set(list.map(x => Math.max(0, Math.round(num(x.lane)))))].sort((a, b) => a - b);
  const map = new Map(used.map((lane, i) => [lane, i]));
  let changed = false;
  const next = list.map(x => {
    const lane = Math.max(0, Math.round(num(x.lane)));
    const nl = map.get(lane);
    if (nl == null || nl === lane) return x;
    changed = true;
    return { ...x, lane: nl };
  });
  return { items: next, changed };
}

/* 拖到「所有行之下」= 新开一行：返回目标行号（现有最高行 + 1），夹进上限。 */
export function newLaneBelow(items) {
  let max = -1;
  (Array.isArray(items) ? items : []).forEach(x => { if (x) max = Math.max(max, Math.round(num(x.lane))); });
  return clamp(max + 1, 0, LANE_MAX - 1);
}

/* 组拖（多选 ≥2 按住拖）：整组按 delta 平移，越界的部分整体夹回来（不各自夹，否则组会散开）。 */
export function shiftGroupStart(starts, delta, min = 0) {
  const list = (Array.isArray(starts) ? starts : []).map(v => num(v));
  const d = num(delta);
  if (!list.length) return { delta: 0, starts: list };
  const lowest = Math.min(...list);
  const applied = Math.max(d, min - lowest);
  return { delta: applied, starts: list.map(v => v + applied) };
}

/* ---------------- 波纹关的画面段整组平移 ----------------
   画面轨是顺序模型（start 按数组顺序 + gap 累加），「拖一段只挪这一段」在这里有定义：
   被拖组的第一段改自己的 gap（组跟着走），组后第一段的 gap 反向补回来（后邻的绝对位置钉死）。
   落点被前后邻居顶住就夹在洞里 —— 不换序、不推后面的段；磁性联动（换序 + 整体平移）开波纹才有。 */
export function placeClipGroupStill(clips, ids, desired) {
  const list = (Array.isArray(clips) ? clips : []).map(c => ({ ...(c || {}) }));
  const idx = (Array.isArray(ids) ? ids : [])
    .map(id => list.findIndex(c => c && c.id === id))
    .filter(i => i >= 0)
    .sort((a, b) => a - b);
  if (!idx.length) return { clips: list, moved: false };
  /* 非连续多选（中间隔着没选中的段）：「只挪组、不换序」没有定义 —— 不动，由调用方说明原因。 */
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] !== idx[k - 1] + 1) return { clips: list, moved: false, why: 'non-contiguous' };
  }
  const rows = deriveTimeline(list).rows;
  const first = idx[0], last = idx[idx.length - 1];
  const prevEnd = first > 0 ? num(rows[first - 1].end) : 0;
  const groupDur = Math.max(0, num(rows[last].end) - num(rows[first].start));   // 组内 gap 随组整体走
  const hasAfter = last + 1 < rows.length;
  const nextStart = hasAfter ? num(rows[last + 1].start) : Infinity;
  const want = num(desired);
  const lo = prevEnd;
  const hi = Math.max(lo, nextStart - groupDur);
  const start = Math.min(Math.max(want, lo), hi);
  let clamped = '';
  if (Math.abs(start - want) > 0.001) clamped = start > want ? 'prev' : 'next';
  list[first].gap = round2(Math.max(0, start - prevEnd));
  if (hasAfter) list[last + 1].gap = round2(Math.max(0, nextStart - (start + groupDur)));
  return {
    clips: list,
    start: round2(start),
    gapBefore: round2(num(list[first].gap)),
    gapAfter: hasAfter ? round2(num(list[last + 1].gap)) : null,
    clamped,
    moved: Math.abs(start - num(rows[first].start)) > 0.001,
  };
}
