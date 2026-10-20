#!/usr/bin/env node
/* 时间线几何：两条轨的框 / 轴秒 / 灰场 / 成片秒两把尺子。 */
import assert from 'node:assert/strict';
import { createTimeline } from '../web/director/timeline.js';

const shots = [{
  id: 's1', candidates: [
    { vid: 'c1', duration: 10, segs: [{ in: 1, out: 5, a: 0, b: 6 }] },
  ],
}];
const T = createTimeline({
  allShots: () => shots,
  tlCandidateOf: (sh, id) => sh.candidates.find(c => c.vid === id) || sh.candidates.find(c => c.vid === sh.selId) || null,
  candDur: (c, sh) => c.duration || sh.duration || 5,
});

/* 本镜轨：格宽 = 框 ÷ 倍速，起点依次累加 */
let G = T.shotFrames([{ a: 0, b: 6, in: 1, out: 5, spd: 1 }, { a: 6, b: 8, in: 6, out: 8, spd: 2 }]);
assert.equal(G.rows.length, 2);
assert.equal(G.rows[0].w, 6);
assert.equal(G.rows[1].w, 1);
assert.equal(G.rows[1].start, 6);
assert.equal(G.total, 7);
assert.equal(T.shotAxTotal(G, 10), 7);
assert.equal(T.shotAxTotal({ rows: [], total: 0 }, 10), 10);

/* 轴秒 ↔ 源秒互逆；针按源秒落在轴上的位置 */
const r = G.rows[1];
assert.equal(T.frameToSrc(r, 6), 6);
assert.equal(T.frameToSrc(r, 6.5), 7);
assert.equal(T.srcToFrame(r, 7), 6.5);
assert.equal(T.shotPinT(G, 7), 6.5);
assert.equal(T.shotRowOf(G, 7), r);
assert.equal(T.shotRowAt(G, 70), r, '越界夹到末格');
assert.equal(T.shotRowAt({ rows: [] }, 1), null);

/* 灰场：整格黑场是真洞；框内被剪掉的头尾不算 */
assert.deepEqual(T.graySpans(0, 4, 1, 3, false), [[0, 1, 0], [3, 4, 0]]);
assert.deepEqual(T.graySpans(0, 4, 1, 3, true), [[0, 4, 1]]);
assert.deepEqual(T.graySpans(0, 0.01, 0, 0.01, true), []);
const G2 = T.shotFrames([{ a: 0, b: 6, in: 1, out: 5 }, { a: 6, b: 8, in: 6, out: 8, off: 1 }]);
assert.deepEqual(T.axisGray(G2), [[0, 1, 0], [5, 6, 0], [6, 8, 1]]);

/* 全片轨：轴秒与成片秒两本账分开；黑场照占轴 */
const tl = { clips: [
  { kind: 'shot', shotId: 's1', candId: 'c1', seg: 0, in: 1, out: 5, speed: 2 },
  { kind: 'shot', shotId: 's1', candId: 'c1', seg: 0, in: 5, out: 6, speed: 1, gray: 1 },
] };
const F = T.filmFrames(tl);
assert.equal(F.rows.length, 2);
/* 第一格框 [0,6] ÷ 2 = 3 轴秒；第二格框 [0,6]（seg 0 的框）÷1 = 6 轴秒 */
assert.equal(F.rows[0].w, 3);
assert.equal(F.rows[1].w, 6);
assert.equal(F.total, 9);
assert.equal(F.filmTotal, 2 + 1);
assert.equal(F.rows[0].f0, 0);
assert.equal(F.rows[1].f0, 2);
assert.deepEqual(T.filmLayGray(F), [[2, 3]]);
assert.equal(T.filmFrames(tl), F, '同一份 tl 对象命中缓存');
assert.notEqual(T.filmFrames({ clips: [] }), F, '换对象即重算');

console.log('✓ 时间线几何：框 / 轴秒 / 互逆折算 / 灰场 / 成片秒两本账');
