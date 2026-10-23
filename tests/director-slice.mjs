#!/usr/bin/env node
/* 切片几何：定宽磁贴 / 每格张数 / 采样时刻（纯函数）；
   数据层的稠密帧索引（frameIndexPlan / frameIndexTimes / frameAtOrBefore）。 */
import assert from 'node:assert/strict';
import {
  SLICE_TILE_PX, SLICE_N_MAX, FRAME_INDEX_MAX,
  sliceGeom, sliceTimes, sliceBoxHTML, snapSliceStep,
  frameIndexPlan, frameIndexTimes, frameAtOrBefore,
} from '../web/director/slice.js';
globalThis.window = { esc: s => String(s == null ? '' : s) };

assert.equal(SLICE_TILE_PX, 64);
assert.equal(SLICE_N_MAX, 512);
let g = sliceGeom(100, 10);
assert.equal(g.n, 2);
assert.equal(g.tile, 64);
assert.ok(Math.abs(g.step - 6.4) < 1e-9);
g = sliceGeom(0, 10);
assert.equal(g.n, 1);
assert.equal(g.step, 10);
g = sliceGeom(700, 10);
assert.equal(g.n, Math.ceil(700 / 64));
assert.equal(sliceTimes(0, 10, 2, 5).join(','), '0,5');
assert.deepEqual(sliceTimes(0, 0.01, 1, 0.01), [0]);
/* 绝对时间栅格：step 吸到最近档案，采样点落在 q 的整数倍上 —— 缩放前后同一段共享采样点。 */
assert.equal(snapSliceStep(0.13), 0.1);
assert.equal(snapSliceStep(0.3), 0.25);
assert.equal(snapSliceStep(3), 2);
assert.equal(snapSliceStep(0.01), 0.05);
assert.deepEqual(sliceTimes(10, 12, 4, 0.37), [10, 10.25, 10.75, 11]);
const a1 = new Set(sliceTimes(10, 20, 10, 1));
const a2 = sliceTimes(10.3, 20.3, 10, 1).filter(t => a1.has(t));
assert.ok(a2.length >= 9, '同一档 step 下两段应共享绝对栅格采样点，实际只共享 ' + a2.length);
const html = sliceBoxHTML('/asset/x', 1, 3, 128, 2);
assert.match(html, /data-n="2"/);
assert.match(html, /data-in="1"/);
assert.match(html, /--frs-w:64px/);

/* 稠密帧索引（数据层）：解多少张由时长分档，画多少格是显示层的事，两把尺子不混。 */
const p30 = frameIndexPlan(30);
assert.equal(p30.step, 1 / 20, '30s 档步长 1/20s');
const p8 = frameIndexPlan(8);
assert.equal(p8.step, 1 / 30, '8s 档步长 1/30s');
const p200 = frameIndexPlan(200);
assert.equal(p200.step, 0.5, '200s 档步长 0.5s');
const pLong = frameIndexPlan(3600);
assert.equal(pLong.step, 1.5, '1 小时档步长 1.5s');
assert.equal(pLong.count, FRAME_INDEX_MAX, '再长也封在 480 张');
assert.equal(frameIndexPlan(0).count, frameIndexPlan(0.1).count, '没有时长按 0.1s 的下限处理，也至少给得出一列');
/* 时刻表：升序、不重复、都落在时长之内；短素材不给越界点。 */
const ts30 = frameIndexTimes(30);
assert.ok(ts30.length >= 1 && ts30.length <= FRAME_INDEX_MAX);
assert.ok(ts30.every((t, i) => (i === 0 || t > ts30[i - 1]) && t >= 0 && t < 30));
assert.ok(new Set(ts30).size === ts30.length, '时刻不重复');
const tsQ = frameIndexTimes(30, p30);
assert.deepEqual(tsQ, ts30, '计划与时刻表同源：给同一份计划要出同一组点');
/* 就近取帧（at-or-before）：放的是「≤ 该时刻的最近一张」的下标，找不到回 -1。 */
const sorted = [0, 0.5, 2, 9];
assert.equal(frameAtOrBefore(sorted, 0.2), 0);
assert.equal(frameAtOrBefore(sorted, 0.5), 1);
assert.equal(frameAtOrBefore(sorted, 1), 1, '1s 之前最近的是 0.5s 那张');
assert.equal(frameAtOrBefore(sorted, 100), 3);
assert.equal(frameAtOrBefore(sorted, -1), -1, '早于第一张没有帧可放');
assert.equal(frameAtOrBefore([], 1), -1);
assert.equal(frameAtOrBefore(null, 1), -1);
console.log('✓ 导演台切片几何：定宽磁贴 / 张数 / 采样 / 标记 / 稠密帧索引');
