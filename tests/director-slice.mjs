#!/usr/bin/env node
/* 数据层的稠密帧索引（frameIndexPlan / frameIndexTimes）——「解多少帧」的唯一口径。
   显示层（摆几格、格多宽）在 tl-filmstrip.js，由 tests/director-strip.mjs 盯。 */
import assert from 'node:assert/strict';
import { FRAME_INDEX_MAX, frameIndexPlan, frameIndexTimes } from '../web/director/slice.js';

assert.equal(FRAME_INDEX_MAX, 480);
/* 解多少张由时长分档，画多少格是显示层的事，两把尺子不混。 */
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
/* 一小时的素材也封在 480：到顶就不再变密，磁贴再放大只从索引里挑已有的帧。 */
const tsLong = frameIndexTimes(3600);
assert.equal(tsLong.length, FRAME_INDEX_MAX);
assert.ok(tsLong.every((t, i) => (i === 0 || t > tsLong[i - 1]) && t >= 0 && t < 3600));
console.log('✓ 导演台数据层帧索引：分档步长 / 封顶 480 / 时刻表升序去重');
