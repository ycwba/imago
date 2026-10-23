#!/usr/bin/env node
/* 时间线几何：两条轨的框 / 选区 / 轴秒 / 黑场 / 成片秒。
   画出来的宽 = 选区 ÷ 倍速 = 这一格在成片里占的秒数（剪掉的头尾不占轨道上的秒，也不画）。 */
import assert from 'node:assert/strict';
import { createTimeline } from '../web/director/timeline.js';

const shots = [{
  id: 's1', candidates: [
    { vid: 'c1', duration: 10, segs: [{ in: 1, out: 5, a: 0, b: 6, spd: 2 }, { in: 6, out: 8, a: 6, b: 8, off: 1 }] },
  ],
}];
const T = createTimeline({
  allShots: () => shots,
  tlCandidateOf: (sh, id) => sh.candidates.find(c => c.vid === id) || sh.candidates.find(c => c.vid === sh.selId) || null,
  candDur: (c, sh) => c.duration || sh.duration || 5,
});

/* 本镜轨：格宽 = **选区** ÷ 倍速，起点依次累加（框 [0,6] 剪成选区 [1,5] → 只占 4 轴秒） */
let G = T.shotFrames([{ a: 0, b: 6, in: 1, out: 5, spd: 1 }, { a: 6, b: 8, in: 6, out: 8, spd: 2 }]);
assert.equal(G.rows.length, 2);
assert.equal(G.rows[0].w, 4);
assert.equal(G.rows[0].start, 0);
assert.equal(G.rows[1].w, 1);
assert.equal(G.rows[1].start, 4);
assert.equal(G.total, 5);
assert.equal(T.shotAxTotal(G, 10), 5);
assert.equal(T.shotAxTotal({ rows: [], total: 0 }, 10), 10);
/* 框还在，只是不再参与排版：它是「把手往外拖最多恢复到这儿」的那一圈 */
assert.equal(G.rows[0].a, 0);
assert.equal(G.rows[0].b, 6);

/* 轴秒 ↔ 源秒互逆；针按源秒落在轴上的位置 */
const r = G.rows[1];
assert.equal(T.frameToSrc(r, 4), 6);
assert.equal(T.frameToSrc(r, 4.5), 7);
assert.equal(T.srcToFrame(r, 7), 4.5);
assert.equal(T.shotPinT(G, 7), 4.5);
assert.equal(T.shotRowOf(G, 7), r);
/* 落在被剪掉的那截源秒上 → 夹到这一格的边上，不再摆到「格子外面那块灰」上 */
assert.equal(T.srcToFrame(r, 4), 4);
assert.equal(T.shotRowAt(G, 70), r, '越界夹到末格');
assert.equal(T.shotRowAt({ rows: [] }, 1), null);

/* 黑场：整格黑场（`off` / `cl.gray`）才算真洞；框内剪掉的头尾一条都不报 */
const G2 = T.shotFrames([{ a: 0, b: 6, in: 1, out: 5 }, { a: 6, b: 8, in: 6, out: 8, off: 1 }]);
assert.deepEqual(T.axisGray(G2), [[4, 6, 1]]);
assert.deepEqual(T.axisGray(T.shotFrames([{ a: 0, b: 6, in: 1, out: 5 }])), [], '剪掉的头尾不占轴、也不进灰场清单');

/* 全片轨：排版宽与成片秒是同一个数；黑场那一格照样占轴 */
const tl = { clips: [
  { kind: 'shot', shotId: 's1', candId: 'c1', seg: 0, in: 1, out: 5, speed: 2 },
  { kind: 'shot', shotId: 's1', candId: 'c1', seg: 1, in: 6, out: 8, speed: 1, gray: 1 },
] };
const F = T.filmFrames(tl);
assert.equal(F.rows.length, 2);
/* 第一格选区 [1,5]（4 源秒）÷ 2 = 2 轴秒 = 2 成片秒；第二格 2 源秒 ÷ 1 = 2 */
assert.equal(F.rows[0].w, 2);
assert.equal(F.rows[1].w, 2);
assert.equal(F.rows[0].fd, 2);
assert.equal(F.rows[1].fd, 2);
assert.equal(F.total, 4);
assert.equal(F.filmTotal, 4);
assert.equal(F.rows[0].f0, 0);
assert.equal(F.rows[1].f0, 2);
assert.deepEqual(T.filmLayGray(F), [[2, 4]]);
assert.deepEqual(T.axisGray(F), [[2, 4, 1]]);
assert.equal(T.filmFrames(tl), F, '同一份 tl 对象命中缓存');
assert.notEqual(T.filmFrames({ clips: [] }), F, '换对象即重算');

/* 一格的两把尺子同源：clipFrame 读的是那一段自己的选区，不是 clip 上那两个数 */
const cf = T.clipFrame({ kind: 'shot', shotId: 's1', candId: 'c1', seg: 0, in: 0, out: 9 });
assert.deepEqual({ a: cf.a, b: cf.b, in: cf.in, out: cf.out }, { a: 0, b: 6, in: 1, out: 5 });

console.log('✓ 时间线几何：框 / 选区排版 / 互逆折算 / 整格黑场 / 轴秒=成片秒');
