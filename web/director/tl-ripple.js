/* 波纹剪辑（纯件，无 DOM）—— 参考 lib/timelineRipple.js：
   画面轨的边界一变（删除 / 切开改长 / 裁剪 / 复制 / 加一段），边界之后**开跑的定时块**整体平移 delta。
   · 配音块：按行锁跳过（整轨 `voice` 或行 `voice-N` 锁了就不动，报进 skipped）；
   · 字幕：挂在被移动的配音块上的跟着走（成组），没挂链接的按自己的 start 判、按字幕行锁跳过；
   · 标记**不动**：它钉在成片秒，不随剪辑搬移（参考 markersAbsoluteHint 的原则）。
   主画面轨自己不参与平移 —— 它是顺序存储，删一段后面的自然前移，没有「边界之后」这回事。 */

import { rowLocked } from './film.js';
import { num, round2 } from './util.js';

const EPS = 0.001;

/* `film` 整份进、整份出（其余键原样带走）；`delta > 0` = 往后推，`< 0` = 往前收。 */
export function applyTimelineRipple(film, boundary, delta) {
  const f = film || {};
  const b = num(boundary);
  const d = round2(delta);
  const skippedIds = [];
  const movedIds = [];
  if (!d) return { film: f, moved: 0, skipped: 0, movedIds, skippedIds };

  const rowsOf = new Map();
  const shiftList = (list, kind) => (Array.isArray(list) ? list : []).map(it => {
    if (!it || !(num(it.start) >= b - EPS)) return it;
    const lane = Math.max(0, Math.round(num(it.lane)));
    const locked = rowLocked(f.tracks, kind) || rowLocked(f.tracks, `${kind}-${lane}`);
    if (locked) { skippedIds.push(it.id); return it; }
    movedIds.push(it.id);
    rowsOf.set(it.id, true);
    return { ...it, start: round2(Math.max(0, num(it.start) + d)) };
  });

  const voices = shiftList(f.voices, 'voice');

  const captions = (Array.isArray(f.captions) ? f.captions : []).map(c => {
    if (!c) return c;
    if (c.voiceId) {
      /* 挂在定时块上：那块走了它就跟着走，那块被锁住它也留在原地。 */
      if (!rowsOf.has(c.voiceId)) return c;
      return { ...c, start: round2(num(c.start) + d), end: round2(num(c.end) + d) };
    }
    if (!(num(c.start) >= b - EPS)) return c;
    if (rowLocked(f.tracks, 'caption')) { skippedIds.push(c.id); return c; }
    movedIds.push(c.id);
    return { ...c, start: round2(num(c.start) + d), end: round2(num(c.end) + d) };
  });

  return {
    film: { ...f, voices, captions },
    moved: movedIds.length,
    skipped: skippedIds.length,
    movedIds,
    skippedIds,
  };
}

/* 边界这一刻有没有东西会被推：「移动 N · 跳过锁定 M」要说得准，先算一遍不落盘。 */
export function rippleCounts(film, boundary, delta) {
  const r = applyTimelineRipple(film, boundary, delta);
  return { moved: r.moved, skipped: r.skipped };
}

/* 一段的时长变化量（切开改长 / 裁剪之后拿它对边界做波纹）：`newEnd - oldEnd`。 */
export const rippleDeltaOf = (oldEnd, newEnd) => round2(num(newEnd) - num(oldEnd));
