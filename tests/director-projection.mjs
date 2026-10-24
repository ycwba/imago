#!/usr/bin/env node
/* 工程 → 时间线：镜头顺序覆盖、拖动换序、从选用候选派生 clips（段 / 倍速 / 灰块）。 */
import assert from 'node:assert/strict';
import { createProjection } from '../web/director/projection.js';

const proj = { filmOrder: [] };
let n = 0;
const shots = [
  { id: 'a', name: '甲', selId: 'c1', candidates: [{ vid: 'c1', duration: 6, segs: [{ in: 1, out: 4 }, { in: 4, out: 6, off: 1, spd: 2 }] }] },
  { id: 'b', name: '乙', selId: 'c2', candidates: [{ vid: 'c2', duration: 5, segs: [{ in: 0, out: 5, spd: 0.5 }] }] },
  { id: 'c', name: '丙', selId: '', candidates: [] },
];
const P = createProjection({
  getProj: () => proj,
  allShots: () => shots,
  shotReady: sh => !!sh.selId,
  tlCandidateOf: (sh, id) => sh.candidates.find(c => c.vid === id) || null,
  candDur: (c, sh) => c.duration || sh.duration || 5,
  segSpd: s => (s.spd == null ? 1 : s.spd),
  picVolOf: () => 1,
  uid: () => 'id' + (++n),
});

assert.deepEqual(P.filmShotsOrdered(shots).map(x => x.id), ['a', 'b', 'c'], '没覆盖时照原顺序');
proj.filmOrder = ['b', 'a'];
assert.deepEqual(P.filmShotsOrdered(shots).map(x => x.id), ['b', 'c', 'a'],
  '覆盖优先，清单外的新镜头按分镜表位置插到邻近镜头旁边（c 排在 b 后面 → 插到 b 后面）');
/* 在两镜之间新建的那一镜，剪辑顺序也落在两镜之间（不是追加到片尾）。 */
{
  const list2 = [
    { id: 'A', name: '甲', selId: 'c1', candidates: [{ vid: 'c1', duration: 6, segs: [{ in: 0, out: 6 }] }] },
    { id: 'C', name: '新', selId: '', candidates: [] },
    { id: 'B', name: '乙', selId: 'c2', candidates: [{ vid: 'c2', duration: 5, segs: [{ in: 0, out: 5 }] }] },
  ];
  proj.filmOrder = ['A', 'B'];
  assert.deepEqual(P.filmShotsOrdered(list2).map(x => x.id), ['A', 'C', 'B'], '两镜之间新建的镜头插在两镜之间');
  /* 排在所有已排镜头之前的新镜头插到最前（它后面最近的那一镜是 A）。 */
  const list3 = [{ id: 'Z', name: '新前', selId: '', candidates: [] }].concat(list2);
  assert.deepEqual(P.filmShotsOrdered(list3).map(x => x.id), ['Z', 'A', 'C', 'B'], '排在最前的新镜头插到最前');
  proj.filmOrder = ['b', 'a'];   // 还原主线那一档的覆盖清单
}
assert.equal(P.moveShotInFilmOrder('a', 'b', false), true);
assert.deepEqual(proj.filmOrder, ['a', 'b']);
assert.equal(P.moveShotInFilmOrder('a', 'b', false), false, '顺序没变就说没变');
assert.equal(P.moveShotInFilmOrder('nope', 'b', false), false);

proj.filmOrder = [];
const tl = P.tlSyncFromShots();
assert.equal(tl.clips.length, 3, '未选用的镜头不进成片');
assert.deepEqual(tl.clips[0], {
  id: 'id1', kind: 'shot', shotId: 'a', candId: 'c1', seg: 0,
  name: '甲', in: 1, out: 4, speed: 1, volume: 1, gray: 0,
});
assert.equal(tl.clips[1].seg, 1);
assert.equal(tl.clips[1].speed, 2);
assert.equal(tl.clips[1].gray, 1);
assert.equal(proj.timeline, tl, '同步会写回工程');

console.log('✓ 工程→时间线：顺序覆盖 / 换序 / 派生 clips');
