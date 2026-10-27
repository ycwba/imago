#!/usr/bin/env node
/* 胶片条计划（显示层，纯件）：格宽档位 / 采样时刻 / 图片平铺 / 就近顶上 / 合并与覆盖。
   数据层「解多密」在 slice.js（frameIndexPlan），这里只算「摆几格、摆哪几秒」。 */
import assert from 'node:assert/strict';
import {
  FRAME_CELL_PX, FRAME_MERGE_TOL, FRAME_MIN_COUNT, FRAME_MAX_COUNT,
  frameCountFor, planFrameTimes, missingFrameTimes, frameAtTime, mergeFrames, frameCoverage,
} from '../web/director/tl-filmstrip.js';

assert.equal(FRAME_CELL_PX, 84);
assert.equal(FRAME_MERGE_TOL, 0.06);
assert.equal(FRAME_MIN_COUNT, 1);
assert.equal(FRAME_MAX_COUNT, 480);

/* 格数：按像素宽向上取整（最后半格也要有画面），夹在 [1, 480] */
assert.equal(frameCountFor(0), 1);
assert.equal(frameCountFor(1), 1);
assert.equal(frameCountFor(FRAME_CELL_PX), 1);
assert.equal(frameCountFor(FRAME_CELL_PX + 1), 2);
assert.equal(frameCountFor(840), 10);
assert.equal(frameCountFor(840, 42), 20);                     // 自定义格宽
assert.equal(frameCountFor(840, 10), 35);                     // 格宽被抬到最小 24
assert.equal(frameCountFor(48000), 480);                      // 上限夹住
assert.equal(frameCountFor(-5), 1);

/* 采样时刻：均匀铺在**源窗口**里，落在格子中心（两头各让半格） */
const clip = { kind: 'video', sourceStart: 4, sourceDuration: 8 };
let times = planFrameTimes(clip, 2);
assert.deepEqual(times, [6, 10]);                             // 4 + 8×(0.25 / 0.75)
assert.deepEqual(planFrameTimes({ kind: 'image', sourceStart: 0, sourceDuration: 5 }, 4), []);
assert.deepEqual(planFrameTimes({ kind: 'video', sourceDuration: 0 }, 4), []);
assert.deepEqual(planFrameTimes(null, 4), []);
times = planFrameTimes({ sourceStart: 1.234, sourceDuration: 3.2 }, 100);
assert.equal(times.length, 100);
assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), '采样点升序');
assert.ok(times[0] >= 1.234 && times[times.length - 1] < 1.234 + 3.2, '落在窗口之内');
assert.equal(planFrameTimes(clip, 0).length, 1);              // 张数夹下限
assert.equal(planFrameTimes(clip, 999).length, 480);          // 张数夹上限

/* 还缺哪几帧：已有格子按 ±容差合并，不再重取 */
const plan2 = planFrameTimes({ sourceStart: 0, sourceDuration: 4 }, 2);   // [1, 3]
assert.deepEqual(plan2, [1, 3]);
assert.deepEqual(missingFrameTimes({ sourceStart: 0, sourceDuration: 4, trackFrames: [{ t: 1 }] }, 2), [3]);
assert.deepEqual(missingFrameTimes({ sourceStart: 0, sourceDuration: 4, trackFrames: [{ t: 1.02 }] }, 2), [3]);
assert.deepEqual(missingFrameTimes({ sourceStart: 0, sourceDuration: 4, trackFrames: [{ t: 1 }, { t: 3 }] }, 2), []);
assert.deepEqual(missingFrameTimes({ sourceStart: 0, sourceDuration: 4 }, 2), [1, 3]);

/* 按时间找一帧：容差内最近，容差外没有 */
assert.equal(frameAtTime([{ t: 1 }, { t: 3 }], 1.02).t, 1);
assert.equal(frameAtTime([{ t: 1 }, { t: 3 }], 2), null);
assert.equal(frameAtTime([{ t: 1 }, { t: 3 }], 2.98).t, 3);
assert.equal(frameAtTime([], 1), null);
assert.equal(frameAtTime(null, 1), null);
assert.equal(frameAtTime([{ t: 1 }, { t: 1.05 }], 1.04).t, 1.05);   // 更近者胜

/* 合并：新到的按 t 排序插入，±容差内取新（新解码的更干净），非法项丢弃 */
let merged = mergeFrames([{ t: 3, url: 'old' }, { t: 1, url: 'a' }], [{ t: 2, url: 'b' }, { t: 2.98, url: 'c' }, null, { t: NaN }]);
assert.deepEqual(merged.map(f => f.t), [1, 2, 2.98]);          // ±容差内取新：2.98 顶掉 3
merged = mergeFrames([{ t: 1, url: 'a' }], [{ t: 1.02, url: 'fresh' }]);
assert.equal(merged.length, 1);
assert.equal(merged[0].url, 'fresh');
assert.deepEqual(mergeFrames(null, null), []);

/* 覆盖：0 = 齐了（缺口按相邻帧最大空隙算），图片段 / 没有源窗的段落恒齐 */
assert.equal(frameCoverage({ kind: 'image' }), 1);
assert.equal(frameCoverage({ kind: 'video', sourceStart: 0, sourceDuration: 0 }), 1);
assert.equal(frameCoverage({ kind: 'video', sourceStart: 0, sourceDuration: 10, trackFrames: [] }), 0);
const cov = start => frameCoverage({ kind: 'video', sourceStart: 0, sourceDuration: 10,
  trackFrames: [0, 2.5, 5, 7.5, 10].map(t => ({ t: t + start })) });
assert.ok(Math.abs(cov(0) - 0.75) < 1e-9);                    // 最大空隙 2.5 → 1 − 0.25
assert.ok(Math.abs(cov(-0.03) - 0.75) < 1e-9);                // 容差内的边缘帧照算
assert.equal(frameCoverage({ kind: 'video', sourceStart: 0, sourceDuration: 10,
  trackFrames: [{ t: 0 }, { t: 10 }] }), 0);                  // 两头有帧、中间一片空 → 不算齐
assert.equal(frameCoverage({ kind: 'video', sourceStart: 0, sourceDuration: 10,
  trackFrames: [{ t: -1 }, { t: 20 }] }), 0);                 // 窗外帧不参与

console.log('✓ 导演台胶片条计划：格宽档位 / 采样时刻 / 图片平铺 / 缺帧合并 / 覆盖缺口');
