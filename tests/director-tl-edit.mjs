#!/usr/bin/env node
/* 时间线编辑纯件（新剪辑核的交互数学）：切刀 / 融合 / 裁剪 / 滑移滑动编辑点 / 波纹 /
   拖动重排与跨行 / 吸附 / 波形 peaks / 比例尺刻度。全部纯函数，不开浏览器。 */
import assert from 'node:assert/strict';
import {
  splitClipAt, splitVoiceAt, splitCaptionAt,
  canMergeClips, mergeClipsAt, removeClipAt, duplicateClipAt,
} from '../web/director/tl-cut.js';
import { PEAKS_PER_SECOND, peaksBars, slicePeaks, resamplePeaks, normalizePeaks, peaksFromSamples } from '../web/director/tl-peaks.js';
import {
  trimClipLeft, trimClipRight, trimClipLeftAnchored,
  trimVoiceLeft, trimVoiceRight, trimCaptionLeft, trimCaptionRight,
  filmSlipBounds, slipClip, filmBoundaryBounds, rollClipsBoundary, filmSlideBounds, slideClip, followCaptions,
} from '../web/director/tl-resize.js';
import { applyTimelineRipple, rippleCounts, rippleDeltaOf } from '../web/director/tl-ripple.js';
import {
  reorderClips, dropIndexAt, moveClipToLane, moveTimedToLane, compactLanes, newLaneBelow, shiftGroupStart,
  placeClipGroupStill,
} from '../web/director/tl-reorder.js';
import { deriveTimeline } from '../web/director/film.js';
import {
  TL_SNAP_PX, collectTimelineSnapPoints, findClosestTimelineSnap, snapTimelineValue, snapTimelineRange, createTimelineSnapGuide,
} from '../web/director/tl-snap.js';
import {
  TL_ZOOM_MIN, TL_ZOOM_MAX, TL_VISIBLE_DEFAULT, TL_VISIBLE_MIN,
  tlClampZoom, tlVisible, tlZoomForVisible, tlFitZoom, tlInitialZoom, tlTail, tlNavTotal, tlWidthPct,
  tlRulerScale, tlTicks, tlTickLabel, tlZoomLabel, tlZoomByWheel, tlZoomFloor,
  tlPxPerSec, tlTimelineWidth, tlTimeAtX, tlXOfTime, tlAnchoredScroll, tlFollowScroll, tlTimeInView,
} from '../web/director/tl-scale.js';

/* ================= 波形 peaks ================= */
assert.equal(PEAKS_PER_SECOND, 48);
assert.equal(peaksBars(2), 96);
assert.equal(peaksBars(0), 1);                     // 下限一根
assert.deepEqual(normalizePeaks([2, -1, 0.5, 'x']), [1, 0, 0.5, 0]);
assert.deepEqual(slicePeaks([0.1, 0.2, 0.3, 0.4], 0, 0.5), [0.1, 0.2]);
assert.deepEqual(slicePeaks([0.1, 0.2, 0.3, 0.4], 0.5, 1), [0.3, 0.4]);
assert.deepEqual(slicePeaks([], 0, 1), []);
assert.deepEqual(slicePeaks([0.1, 0.2, 0.3, 0.4], -1, 2), [0.1, 0.2, 0.3, 0.4]);   // 比例夹回 0–1
assert.deepEqual(resamplePeaks([1, 0, 0, 0], 2), [1, 0]);            // 每格取最大
assert.deepEqual(resamplePeaks([], 3), [0, 0, 0]);
assert.equal(peaksFromSamples([], 48000).length, 0);
const flat = peaksFromSamples(new Array(4800).fill(0.5), 48000, 48);
assert.equal(flat.length, 5);                                        // 4800 样本 ÷ 每格 1000
assert.ok(flat.every(v => Math.abs(v - 1) < 1e-9), '全段等幅 → 归一化后全是 1');

/* ================= 切刀 / 融合 ================= */
const vclip = {
  id: 'c1', kind: 'video', src: '/a', playbackRate: 2,
  sourceStart: 4, sourceDuration: 8, duration: 4, mediaDuration: 20, ln: 0, volume: 1, muted: false,
  trackFrames: [{ t: 4 }, { t: 5 }, { t: 8 }, { t: 9 }], peaks: [0.1, 0.2, 0.3, 0.4],
  transition: { id: 'fade', duration: 0.5 },
};
const cut = splitClipAt([vclip], 0, 2);
assert.equal(cut.ok, true);
assert.equal(cut.left.duration, 2);
assert.equal(cut.left.sourceDuration, 4);             // 2 秒 × 倍速 2
assert.equal(cut.left.sourceStart, 4);
assert.deepEqual(cut.left.trackFrames.map(f => f.t), [4, 5]);      // 按**源秒**切
assert.deepEqual(cut.left.peaks, [0.1, 0.2]);
assert.ok(!cut.left.transition);                       // 新出现的连接点是硬切
assert.equal(cut.right.duration, 2);
assert.equal(cut.right.sourceStart, 8);                // 4 + 2×2
assert.equal(cut.right.sourceDuration, 4);
assert.notEqual(cut.right.id, vclip.id);               // 右半是新 id
assert.deepEqual(cut.right.trackFrames.map(f => f.t), [8, 9]);
assert.deepEqual(cut.right.peaks, [0.3, 0.4]);
assert.deepEqual(cut.right.transition, { id: 'fade', duration: 0.5 });  // 转场归右边
assert.equal(cut.clips.length, 2);

const edge = splitClipAt([vclip], 0, 0.01);
assert.equal(edge.ok, false);
assert.match(edge.reason, /太靠边/);
assert.equal(splitClipAt([vclip], 5, 1).ok, false);
assert.equal(splitClipAt([vclip], 0, 3.99).ok, false);
/* 第 2 段：atTime 是**成片秒**，行内定位要减掉前面几段 */
const cut2 = splitClipAt([{ ...vclip, id: 'a', duration: 1 }, { ...vclip, id: 'b', duration: 4 }], 1, 2.5);
assert.equal(cut2.ok, true);
assert.equal(cut2.left.duration, 1.5);
assert.equal(cut2.right.duration, 2.5);

/* 带空隙的段：切出来右半紧接左半（gap 0），左半保留自己前面那段空 */
const gcut = splitClipAt([{ ...vclip, gap: 1, id: 'cg' }], 0, 2);
assert.equal(gcut.ok, true);
assert.equal(gcut.left.gap, 1);
assert.equal(gcut.right.gap, 0);
assert.equal(gcut.left.duration, 1, '切点在成片 2 秒 = 段内 1 秒（前面 1 秒是空）');

const vcut = splitVoiceAt([{ id: 'v1', start: 1, duration: 4, playbackRate: 1, sourceStart: 2, sourceDuration: 4, peaks: [0.1, 0.2, 0.3, 0.4] }], 'v1', 3);
assert.equal(vcut.ok, true);
assert.equal(vcut.left.id, 'v1');                      // 左半保留原 id（挂在它身上的字幕不动）
assert.equal(vcut.left.duration, 2);
assert.equal(vcut.left.sourceDuration, 2);
assert.equal(vcut.right.start, 3);
assert.equal(vcut.right.sourceStart, 4);
assert.equal(splitVoiceAt([{ id: 'v1', start: 0, duration: 0.05 }], 'v1', 0.02).ok, false);
assert.equal(splitVoiceAt([], 'nope', 1).ok, false);

const kcut = splitCaptionAt([{ id: 'k1', start: 0, end: 4, text: 'x', voiceId: 'v1' }], 'k1', 1.5);
assert.equal(kcut.ok, true);
assert.equal(kcut.left.end, 1.5);
assert.equal(kcut.right.start, 1.5);
assert.equal(kcut.right.voiceId, 'v1');                // 右半继承同一条链接
assert.notEqual(kcut.right.id, 'k1');
assert.equal(splitCaptionAt([{ id: 'k1', start: 0, end: 1 }], 'k1', 0.05).ok, false);

const L = { kind: 'video', src: '/a', playbackRate: 1, sourceStart: 0, sourceDuration: 2 };
const R = { kind: 'video', src: '/a', playbackRate: 1, sourceStart: 2, sourceDuration: 3 };
assert.equal(canMergeClips(L, R), true);               // 同素材、源窗口首尾相接
assert.equal(canMergeClips(L, { ...R, src: '/b' }), false);
assert.equal(canMergeClips(L, { ...R, sourceStart: 2.5 }), false);
assert.equal(canMergeClips(L, { ...R, playbackRate: 2 }), false);
assert.equal(canMergeClips({ kind: 'image', src: '/p' }, { kind: 'image', src: '/p' }), true);
assert.equal(canMergeClips(null, R), false);

const merged = mergeClipsAt([
  { ...L, id: 'm1', duration: 2, trackFrames: [{ t: 0 }], peaks: [1] },
  { ...R, id: 'm2', duration: 3, trackFrames: [{ t: 2 }], peaks: [2], transition: { id: 'zoom', duration: 0.4 } },
], 0);
assert.equal(merged.ok, true);
assert.equal(merged.clip.id, 'm1');
assert.equal(merged.clip.duration, 5);
assert.equal(merged.clip.sourceDuration, 5);
assert.deepEqual(merged.clip.trackFrames.map(f => f.t), [0, 2]);
assert.deepEqual(merged.clip.peaks, [1, 2]);
assert.deepEqual(merged.clip.transition, { id: 'zoom', duration: 0.4 });   // 右段的转场接过来
assert.equal(mergeClipsAt([L, { ...R, src: '/b' }], 0).ok, false);

const removed = removeClipAt([L, R], 0);
assert.equal(removed.removed, L);
assert.equal(removed.clips.length, 1);
const dup = duplicateClipAt([{ ...L, id: 'd1', transition: { id: 'fade', duration: 0.5 } }], 0);
assert.equal(dup.index, 1);
assert.notEqual(dup.clip.id, 'd1');
assert.ok(!dup.clip.transition);                       // 两份之间的连接点是硬切

/* ================= 裁剪 / 滑移 / 编辑点 / 滑动 ================= */
const rc = { kind: 'video', playbackRate: 1, sourceStart: 2, sourceDuration: 4, duration: 4, mediaDuration: 10 };
assert.equal(trimClipLeft(rc, 1).sourceStart, 3);      // 往里裁 → 源头前移
assert.equal(trimClipLeft(rc, 1).sourceDuration, 3);
assert.equal(trimClipLeft(rc, 1).duration, 3);
assert.equal(trimClipLeft(rc, -1).sourceStart, 1);     // 往外拉 → 退回源的头
assert.equal(trimClipLeft({ ...rc, sourceStart: 0 }, -1), null);   // 已经贴到源的头
assert.equal(trimClipLeft(rc, 4.1), null);             // 裁到不足最短时长
assert.equal(trimClipRight(rc, 10).duration, 8);       // 最多拉到素材的尾（10-2-4=4）
assert.equal(trimClipRight(rc, 10).sourceDuration, 8);
assert.equal(trimClipRight({ ...rc, mediaDuration: 6 }, 10), null);
assert.equal(trimClipRight(rc, -1).sourceDuration, 3);
assert.equal(trimClipRight(rc, -3.96), null);
const rimg = { kind: 'image', duration: 2 };
assert.equal(trimClipLeft(rimg, 1).duration, 1);
assert.equal(trimClipRight(rimg, 3).duration, 5);
assert.equal(trimClipLeft(rimg, 1.96), null);

/* 锚定裁（第一段的左缘，没有左邻可 roll）：左缘动、右缘钉死，变化折进段前 gap。 */
{
  const g0 = { kind: 'video', playbackRate: 1, sourceStart: 2, sourceDuration: 4, duration: 4, gap: 1 };
  const inward = trimClipLeftAnchored(g0, 1);           // 左缘往右 1 秒
  assert.equal(inward.duration, 3, '块从左边缩短');
  assert.equal(inward.gap, 2, '变化折进段前 gap');
  assert.equal(inward.sourceStart, 3, '源窗口跟着右移');
  const tl = deriveTimeline([inward]).rows[0];           // 右缘锚定的账交给 deriveTimeline 对
  assert.ok(Math.abs(tl.end - 5) < 1e-9, '右缘钉死：start+gap+duration 不变');
  const outward = trimClipLeftAnchored(g0, -0.5);        // 往左拉长，吃 gap
  assert.equal(outward.duration, 4.5);
  assert.equal(outward.gap, 0.5);
  const clamp0 = trimClipLeftAnchored(g0, -3);           // gap 用尽就贴住前一段
  assert.equal(clamp0.duration, 5);
  assert.equal(clamp0.gap, 0);
}

const rv = { start: 2, duration: 3, playbackRate: 2, sourceStart: 4, sourceDuration: 6, mediaDuration: 14 };
assert.deepEqual(
  { start: trimVoiceLeft(rv, 1).start, dur: trimVoiceLeft(rv, 1).duration, ss: trimVoiceLeft(rv, 1).sourceStart, sd: trimVoiceLeft(rv, 1).sourceDuration },
  { start: 3, dur: 2, ss: 6, sd: 4 });
assert.equal(trimVoiceLeft(rv, -1).start, 1);
assert.equal(trimVoiceRight(rv, 2).duration, 5);
assert.equal(trimVoiceRight(rv, 2).sourceDuration, 10);
assert.equal(trimVoiceRight(rv, 99).duration, 5);    // 余量只有 2 秒 → 封顶
assert.equal(trimVoiceRight({ ...rv, mediaDuration: 10 }, 2), null);   // 10-4-6=0 → 无余量
assert.equal(trimCaptionLeft({ start: 1, end: 3 }, -0.5).start, 0.5);
assert.equal(trimCaptionLeft({ start: 1, end: 3 }, 2.9), null);
assert.equal(trimCaptionRight({ start: 1, end: 3 }, 1).end, 4);
assert.equal(trimCaptionRight({ start: 1, end: 3 }, -1.9), null);

const sc = { kind: 'video', playbackRate: 1, sourceStart: 3, sourceDuration: 4, duration: 4, mediaDuration: 10 };
assert.deepEqual(filmSlipBounds(sc), { minimum: -3, maximum: 3 });
const slip = slipClip(sc, 2);
assert.equal(slip.delta, 2);
assert.equal(slip.clip.sourceStart, 5);
assert.equal(slipClip(sc, 99).delta, 3);
assert.equal(slipClip(sc, -99).clip.sourceStart, 0);
assert.equal(slipClip({ kind: 'image' }, 2).delta, 0);
assert.deepEqual(filmSlipBounds({ kind: 'image' }), { minimum: 0, maximum: 0 });

const A = { kind: 'video', playbackRate: 1, sourceStart: 0, sourceDuration: 4, duration: 4, mediaDuration: 6 };
const B = { kind: 'video', playbackRate: 1, sourceStart: 2, sourceDuration: 3, duration: 3, mediaDuration: 8 };
assert.deepEqual(filmBoundaryBounds([A, B], 1), { minimum: -2, maximum: 2 });
const roll = rollClipsBoundary([A, B], 1, 1);
assert.equal(roll.delta, 1);
assert.equal(roll.clips[0].duration, 5);
assert.equal(roll.clips[0].sourceDuration, 5);
assert.equal(roll.clips[1].duration, 2);
assert.equal(roll.clips[1].sourceStart, 3);
assert.equal(roll.clips[1].sourceDuration, 2);
const rollClamp = rollClipsBoundary([A, B], 1, 99);
assert.equal(rollClamp.delta, 2);
assert.equal(rollClamp.clips[0].duration + rollClamp.clips[1].duration, 7);   // 总长守恒
assert.equal(rollClipsBoundary([A, B], 0, 1).delta, 0);                        // 没有左右两段
assert.equal(rollClipsBoundary([A, B], 2, 1).delta, 0);

const A2 = { kind: 'video', playbackRate: 1, sourceStart: 1, sourceDuration: 2, duration: 2, mediaDuration: 6 };
const Bm = { kind: 'video', playbackRate: 1, sourceStart: 0, sourceDuration: 3, duration: 3, mediaDuration: 6 };
const C2 = { kind: 'video', playbackRate: 1, sourceStart: 2, sourceDuration: 2, duration: 2, mediaDuration: 8 };
assert.deepEqual(filmSlideBounds([A2, Bm, C2], 1), { minimum: -1.95, maximum: 1.95 });
const slide = slideClip([A2, Bm, C2], 1, 1);
assert.equal(slide.clips[0].duration, 3);
assert.equal(slide.clips[1], Bm);                       // 被滑的那一段本身不动（位置由邻居伸缩挪出来）
assert.equal(slide.clips[2].duration, 1);
assert.equal(slide.clips[2].sourceStart, 3);
assert.equal(slide.clips[0].duration + slide.clips[1].duration + slide.clips[2].duration, 7);
assert.equal(slideClip([A2, Bm, C2], 0, 1).delta, 0);    // 首段滑不动
assert.equal(slideClip([A2, Bm, C2], 2, 1).delta, 0);

const fcaps = followCaptions(
  [{ id: 'k1', voiceId: 'v1', start: 1, end: 3 }, { id: 'k2', voiceId: '', start: 1, end: 2 }],
  'v1', { start: 1, duration: 2 }, { start: 2, duration: 1 });
assert.deepEqual({ start: fcaps[0].start, end: fcaps[0].end }, { start: 2, end: 3 });   // 按新窗夹住
assert.deepEqual(fcaps[1], { id: 'k2', voiceId: '', start: 1, end: 2 });                // 没挂链接的不动
assert.deepEqual(followCaptions(null, 'v1', { start: 1 }, { start: 2 }), []);

/* ================= 波纹 ================= */
const rippleFilm = {
  clips: [],
  voices: [{ id: 'v1', start: 1, duration: 1, lane: 0 }, { id: 'v2', start: 5, duration: 1, lane: 0 }, { id: 'p1', start: 6, duration: 1, lane: 0 }],
  captions: [
    { id: 'k1', voiceId: 'v2', start: 6, end: 7 },
    { id: 'k2', voiceId: '', start: 6.5, end: 7.5 },
    { id: 'k3', voiceId: '', start: 1, end: 2 },
  ],
  markers: [{ id: 'm1', time: 6 }],
  tracks: { visibility: {}, locks: {} },
};
const rip = applyTimelineRipple(rippleFilm, 3, 2);
assert.deepEqual(rip.film.voices.map(v => v.start), [1, 7, 8]);    // 边界之后的整体后移
assert.deepEqual(rip.film.captions.map(c => c.start), [8, 8.5, 1]); // 挂链接的跟着块走
assert.deepEqual(rip.film.markers, rippleFilm.markers);            // 标记不动
assert.equal(rip.moved, 3);                              // 两条配音 + 一条没挂链接的字幕；挂链接的字幕跟着块走，不单独计数
assert.equal(rip.skipped, 0);
const ripLocked = applyTimelineRipple({ ...rippleFilm, tracks: { visibility: {}, locks: { voice: true } } }, 3, 2);
assert.deepEqual(ripLocked.film.voices.map(v => v.start), [1, 5, 6]); // 锁住的块不动
assert.equal(ripLocked.skipped, 2);
assert.equal(ripLocked.moved, 1);                                   // 只有那条没挂链接的字幕走
const ripCapLock = applyTimelineRipple({ ...rippleFilm, tracks: { visibility: {}, locks: { caption: true } } }, 3, 2);
assert.deepEqual(ripCapLock.film.captions.map(c => c.start), [8, 6.5, 1]);  // 挂链接的跟块，其余锁住不走
assert.equal(applyTimelineRipple(rippleFilm, 3, 0).moved, 0);
assert.deepEqual(rippleCounts(rippleFilm, 3, 2), { moved: 3, skipped: 0 });
assert.equal(rippleDeltaOf(4, 5.5), 1.5);

/* ================= 拖动重排与跨行 ================= */
const abc = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
assert.deepEqual(reorderClips(abc, 0, 2).clips.map(x => x.id), ['b', 'c', 'a']);
assert.equal(reorderClips(abc, 0, 2).index, 2);
assert.equal(reorderClips(abc, 1, 1).index, 1);
assert.equal(reorderClips(abc, -1, 0).index, -1);
const rows2 = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
assert.equal(dropIndexAt(rows2, 1.1), 1);              // 越过第 1 段中点
assert.equal(dropIndexAt(rows2, 3.1), 2);
assert.equal(dropIndexAt(rows2, 1.1, 0), 0);           // 拖动中的那一段不数自己
const laneClips = [{ id: 'a', ln: 0 }, { id: 'b', ln: 1 }];
assert.equal(moveClipToLane(laneClips, 'b', 3).clips[1].ln, 3);
assert.equal(moveClipToLane(laneClips, 'b', 99).clips[1].ln, 11);   // 夹到 LANE_MAX-1
assert.equal(moveClipToLane(laneClips, 'nope', 1).moved, false);
const timed = [{ id: 'a', lane: 0 }, { id: 'b', lane: 1 }, { id: 'c', lane: 2 }];
const down = moveTimedToLane(timed, 'a', 2);
assert.deepEqual(down.items.map(x => x.lane), [2, 0, 1]);           // 中间行 ±1 收缩
assert.equal(down.moved, true);
const up = moveTimedToLane(down.items, 'a', 0);
assert.deepEqual(up.items.map(x => x.lane), [0, 1, 2]);
assert.deepEqual(compactLanes([{ id: 'a', lane: 0 }, { id: 'b', lane: 3 }, { id: 'c', lane: 5 }]).items.map(x => x.lane), [0, 1, 2]);

/* ---- 波纹关的画面段整组平移（placeClipGroupStill）----
   顺序模型里「拖一段只挪这一段」= 改被拖组第一段的 gap、组后第一段的 gap 反向补回（后邻钉死）。 */
const stillClips = [
  { id: 'a', kind: 'video', duration: 2, gap: 0 },
  { id: 'b', kind: 'video', duration: 2, gap: 1 },   // b 在成片 3–5s
  { id: 'c', kind: 'video', duration: 2, gap: 0 },   // c 在成片 5–7s
];
const rowsOfStill = clips => deriveTimeline(clips).rows;
// 洞内自由放：b 挪到 2.5 → gap_b 0.5，c 的 gap 补 0.5，c 起点钉在 5
{
  const r = placeClipGroupStill(stillClips, ['b'], 2.5);
  assert.equal(r.moved, true);
  assert.equal(r.clamped, '');
  assert.equal(r.start, 2.5);
  assert.equal(r.gapBefore, 0.5);
  assert.equal(r.gapAfter, 0.5);
  const rows = rowsOfStill(r.clips);
  assert.deepEqual(rows.map(x => Math.round(Number(x.start) * 10) / 10), [0, 2.5, 5], 'a、c 起点都不动，只有 b 走');
}
// 右顶住：b 想去 4，但 c 钉在 5 放不下 → 夹回 3，没挪成
{
  const r = placeClipGroupStill(stillClips, ['b'], 4);
  assert.equal(r.start, 3);
  assert.equal(r.clamped, 'next');
  assert.equal(r.moved, false, '夹回原位 = 没动，不该记历史');
}
// 左顶住：b 想去 1 → 贴住 a 的末尾（2），gap_b 归零，c 钉在 5（gap_c 补 1）
{
  const r = placeClipGroupStill(stillClips, ['b'], 1);
  assert.equal(r.start, 2);
  assert.equal(r.clamped, 'prev');
  const rows = rowsOfStill(r.clips);
  assert.deepEqual(rows.map(x => x.start), [0, 2, 5]);
}
// 首段无前邻：a 挪到 0.5 → gap_a 0.5，b 钉在 3
{
  const r = placeClipGroupStill(stillClips, ['a'], 0.5);
  assert.equal(r.start, 0.5);
  assert.equal(r.gapBefore, 0.5);
  assert.equal(r.gapAfter, 0.5);
  assert.deepEqual(rowsOfStill(r.clips).map(x => x.start), [0.5, 3, 5]);
}
// 末段无后邻：c 挪到 10 → 后面没有邻居，随便走
{
  const r = placeClipGroupStill(stillClips, ['c'], 10);
  assert.equal(r.start, 10);
  assert.equal(r.gapAfter, null);
  assert.deepEqual(rowsOfStill(r.clips).map(x => x.start), [0, 3, 10]);
}
// 两段组拖：[b, c] 想去 1 → 整组贴住 a 的末尾（2），组内相对距离不动
{
  const r = placeClipGroupStill(stillClips, ['b', 'c'], 1);
  assert.equal(r.moved, true);
  assert.deepEqual(rowsOfStill(r.clips).map(x => x.start), [0, 2, 4]);
}
// 非连续多选（a、c，中间隔着没选的 b）：没有定义 → 不动
{
  const r = placeClipGroupStill(stillClips, ['a', 'c'], 1);
  assert.equal(r.moved, false);
  assert.equal(r.why, 'non-contiguous');
  assert.deepEqual(rowsOfStill(r.clips).map(x => x.start), [0, 3, 5], '原样带回');
}
// 没选中的段引用原值不带别的改动：gap 语义（段前空隙）只落在被拖组与它的后邻身上
{
  const r = placeClipGroupStill(stillClips, ['b'], 2.5);
  assert.deepEqual(r.clips.map(x => x.id), ['a', 'b', 'c'], '顺序不动');
  assert.equal(r.clips[0].duration, 2, '未选中段的字段不碰');
}
assert.equal(compactLanes([{ lane: 0 }, { lane: 1 }]).changed, false);
assert.equal(newLaneBelow([{ lane: 2 }]), 3);
assert.equal(newLaneBelow([]), 0);
assert.equal(newLaneBelow([{ lane: 11 }]), 11);
assert.deepEqual(shiftGroupStart([1, 3], -5), { delta: -1, starts: [0, 2] });   // 整组夹回来，不各自夹
assert.deepEqual(shiftGroupStart([1, 3], 2), { delta: 2, starts: [3, 5] });
assert.deepEqual(shiftGroupStart([], 2), { delta: 0, starts: [] });

/* ================= 吸附 ================= */
assert.equal(TL_SNAP_PX, 10);
assert.deepEqual(collectTimelineSnapPoints({ total: 0 }), [{ time: 0, kind: 'boundary', id: 'start' }]);
const snapPts = collectTimelineSnapPoints({
  total: 10, playhead: 3,
  rows: [{ clip: { id: 'c1' }, start: 0, end: 4 }],
  voices: [{ id: 'v1', start: 1, duration: 2 }],
  captions: [{ id: 'k1', start: 2, end: 3 }],
  markers: [{ id: 'm1', time: 5 }, { id: 'm2', type: 'range', time: 6, endTime: 8 }],
  exclude: { clipId: 'c1' },
});
assert.equal(snapPts.some(p => p.id === 'c1'), false);  // 正在拖的那一段不吸附自己
assert.deepEqual(snapPts.map(p => p.time).sort((a, b) => a - b), [0, 1, 2, 3, 3, 3, 5, 6, 8, 10]);   // 播放头 / 配音尾 / 字幕尾 都是 3
assert.equal(collectTimelineSnapPoints({ total: 10, playhead: 3, exclude: { skipPlayhead: true } }).some(p => p.kind === 'playhead'), false);
assert.equal(findClosestTimelineSnap(2.4, [{ time: 2 }, { time: 3 }], 0.5).time, 2);
assert.equal(findClosestTimelineSnap(2.4, [{ time: 2 }, { time: 3 }], 0.3), null);
assert.deepEqual(snapTimelineValue(2.4, [{ time: 2 }], 0.5), { time: 2, snapped: true, point: { time: 2 } });
assert.deepEqual(snapTimelineValue(9, [{ time: 2 }], 0.5), { time: 9, snapped: false, point: null });
const rsnap = snapTimelineRange(2.2, 1, [{ time: 2 }, { time: 3 }], 0.3);
assert.deepEqual([rsnap.start, rsnap.end, rsnap.edge], [2, 3, 'start']);   // 两边一样近 → 起边胜
const rsnapE = snapTimelineRange(2.9, 2, [{ time: 2 }, { time: 5 }], 0.3);
assert.deepEqual([rsnapE.start, rsnapE.end, rsnapE.edge], [3, 5, 'end']);
assert.deepEqual(snapTimelineRange(2.9, 2, [], 0.3), { start: 2.9, end: 4.9, edge: '', point: null });
assert.equal(createTimelineSnapGuide(null), null);
assert.deepEqual(createTimelineSnapGuide({ time: 2, point: { kind: 'start' } }, '起点'), { time: 2, kind: 'start', label: '起点' });

/* ================= 比例尺 / 刻度 / 像素换算 ================= */
assert.equal(TL_ZOOM_MIN, 0.25);
assert.equal(TL_ZOOM_MAX, 16);
assert.equal(TL_VISIBLE_DEFAULT, 10);
assert.equal(tlClampZoom(0), TL_ZOOM_MIN);
assert.equal(tlClampZoom(99), TL_ZOOM_MAX);
assert.ok(Math.abs(tlVisible(1) - 10) < 1e-9);           // 1 = 默认视野 10 秒
assert.ok(Math.abs(tlVisible(TL_ZOOM_MAX) - TL_VISIBLE_MIN) < 1e-9);   // 推到底 = 最小视野
for (const want of [0.5, 5, 10, 30, 120]) {
  assert.ok(Math.abs(tlVisible(tlZoomForVisible(want)) - want) < 0.01, 'visible ↔ zoom 往返：' + want);
}
assert.ok(Math.abs(tlVisible(tlInitialZoom(0)) - 10) < 0.01);                 // 空片 10 秒
assert.ok(Math.abs(tlVisible(tlInitialZoom(120)) - 30) < 0.01);               // 超过一分钟先给 30 秒
assert.ok(Math.abs(tlVisible(tlInitialZoom(30)) - Math.max(5, 30 / 0.82)) < 0.05);   // 其余铺满
assert.ok(Math.abs(tlVisible(tlZoomFloor(20)) - Math.max(5, 20 / 0.82)) < 0.05);     // 自适应与铺满同一把尺
assert.equal(tlTail(0), 0);
assert.equal(tlTail(5), 2);
assert.equal(tlTail(10), 5);
assert.equal(tlTail(100), 5);
assert.equal(tlTail(1000), 30);
assert.equal(tlNavTotal(0), 10);
assert.equal(tlNavTotal(12), 17);                        // 12 + 5 → 17
assert.equal(tlNavTotal(3), 10);                         // 下限 10 秒
assert.equal(tlNavTotal(12, 5), 17);                     // reach 落在成片之内，不改变跨度
assert.equal(tlNavTotal(8, 11.5), 16.5);                 // 末尾之外还有标记 → 按那一秒起尾垫
assert.equal(tlNavTotal(0, 30), 35);                     // 空片只剩钉在外面的条目
const z10 = tlZoomForVisible(10);
assert.ok(Math.abs(tlWidthPct(20, z10) - 200) < 1e-3);   // 内容比一屏长 → 按比例
assert.equal(tlWidthPct(5, z10), 100);                   // 不足一屏按一屏铺满
assert.equal(tlWidthPct(0, 1), 100);
assert.equal(tlRulerScale(0.5).labelMode, 'frames');
assert.equal(tlRulerScale(1.5).labelMode, 'subseconds');
assert.equal(tlRulerScale(10).labelMode, 'seconds');
assert.equal(tlRulerScale(100).labelMode, 'seconds');
assert.equal(tlRulerScale(300).labelMode, 'minutes');
assert.equal(tlRulerScale(1000).majorStep, 600);
const ticks = tlTicks(60, z10, 0, 10);
assert.ok(ticks.length > 0);
assert.ok(ticks.every((x, i) => i === 0 || x.time > ticks[i - 1].time), '刻度升序');
assert.ok(ticks.every(x => x.time >= 0 && x.time <= 60));
assert.equal(ticks[0].time, 0);
assert.equal(ticks[0].label, '00:00');
assert.ok(ticks.filter(x => x.isMajor).every(x => /^\d\d:\d\d/.test(x.label)), '主档都带秒数');
assert.deepEqual(tlTicks(0, z10), []);
assert.equal(tlTickLabel(1.5, 'frames'), '00:01:15f');
assert.equal(tlTickLabel(1.25, 'subseconds'), '00:01.25');
assert.equal(tlTickLabel(90), '01:30');
assert.equal(tlTickLabel(-1), '00:00');
assert.equal(tlZoomLabel(tlZoomForVisible(0.5)), '15f');
assert.equal(tlZoomLabel(z10), '10s');
assert.equal(tlZoomLabel(tlZoomForVisible(120)), '2m');
assert.ok(tlZoomByWheel(1, 100) < 1);                    // 往下滚 = 缩小
assert.ok(tlZoomByWheel(1, -100) > 1);
assert.equal(tlZoomByWheel(1, 1e9), Math.max(TL_ZOOM_MIN, 1 * Math.exp(-640 * 0.00056)));
assert.ok(tlZoomByWheel(16, 1e9) >= TL_ZOOM_MIN);
assert.ok(Math.abs(tlPxPerSec(1000, z10) - 100) < 1e-6);
assert.ok(Math.abs(tlTimelineWidth(20, 1000, z10) - 2000) < 1e-3);
assert.equal(tlTimelineWidth(5, 1000, z10), 1000);
assert.equal(tlTimeAtX(300, 100), 3);
assert.equal(tlXOfTime(3, 100), 300);
assert.equal(tlTimeAtX(-5, 100), 0);
const anchor = tlAnchoredScroll(0, 300, 1000, z10, tlZoomForVisible(5));
assert.ok(Math.abs(anchor - 300) < 0.01, '光标底下那一秒缩放前后还在同一个像素，实际 ' + anchor);
assert.equal(tlFollowScroll(2, 0, 1000, z10), null);     // 视口 85% 之内不跟
assert.ok(Math.abs(tlFollowScroll(9, 0, 1000, z10) - 750) < 1e-3);   // 越过 85% → 滚到让针落在 15%
assert.equal(tlTimeInView(2, 0, 1000, z10), true);
assert.equal(tlTimeInView(11, 0, 1000, z10), false);
assert.equal(tlTimeInView(11, 500, 1000, z10), true);

console.log('✓ 导演台时间线编辑纯件：切刀融合 / 裁剪滑移滑动 / 波纹 / 重排跨行 / 吸附 / 波形 / 刻度与像素换算');
