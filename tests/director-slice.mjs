#!/usr/bin/env node
/* 切片几何：定宽磁贴 / 每格张数 / 采样时刻（纯函数）。 */
import assert from 'node:assert/strict';
import { SLICE_TILE_PX, SLICE_N_MAX, sliceGeom, sliceTimes, sliceBoxHTML, snapSliceStep } from '../web/director/slice.js';
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
/* P2 绝对时间栅格：step 吸到最近档案，采样点落在 q 的整数倍上 —— 缩放前后同一段共享采样点。 */
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
console.log('✓ 导演台切片几何：定宽磁贴 / 张数 / 采样 / 标记');
