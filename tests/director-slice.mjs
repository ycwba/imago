#!/usr/bin/env node
/* 切片几何：定宽磁贴 / 每格张数 / 采样时刻（纯函数）。 */
import assert from 'node:assert/strict';
import { SLICE_TILE_PX, SLICE_N_MAX, sliceGeom, sliceTimes, sliceBoxHTML } from '../web/director/slice.js';
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
const html = sliceBoxHTML('/asset/x', 1, 3, 128, 2);
assert.match(html, /data-n="2"/);
assert.match(html, /data-in="1"/);
assert.match(html, /--frs-w:64px/);
console.log('✓ 导演台切片几何：定宽磁贴 / 张数 / 采样 / 标记');
