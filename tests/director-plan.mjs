#!/usr/bin/env node
/* 播放计划：本镜 / 全片两路把 segs 摊成成片时间轴上的段与配音。 */
import assert from 'node:assert/strict';
import { createPlayPlan } from '../web/director/plan.js';

const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, why + '：' + a + ' ≠ ' + b);

function ctxOf(over) {
  return Object.assign({
    getProj: () => ({ tlTab: 'shot', curCand: 0 }),
    curShot: () => null,
    allShots: () => [],
    tlCandidateOf: () => null,
    candDur: () => 10,
    picVolOf: () => 1,
    tlSyncFromShots: () => ({ clips: [] }),
    filmFrames: () => ({ rows: [], total: 0, filmTotal: 0 }),
    filmLayGray: () => [],
    candTrackSrc: () => 'clip.mp4',
    clipVoices: () => ({ list: [] }),
    shotVoices: () => [],
    voiceVolOf: () => 1,
  }, over);
}

/* 本镜：一段真画面 + 一句配音；黑场走 src:'' 且不带宽 */
const shot = {
  id: 's1', selId: 'c1',
  candidates: [{ vid: 'c1', duration: 10, segs: [{ in: 0, out: 4 }, { in: 6, out: 8, off: 1 }] }],
};
const planShot = createPlayPlan(ctxOf({
  curShot: () => shot,
  shotVoices: () => [{ id: 'v1', seg: 0, at: 1, dur: 2, src: 'v.mp3', vol: 0.5 }],
}));
let p = planShot();
assert.equal(p.film, false);
assert.equal(p.clips.length, 2);
assert.deepEqual(p.clips[0], { src: 'clip.mp4', in: 0, out: 4, vol: 1, spd: 1 });
assert.equal(p.clips[1].src, '');
assert.equal(p.voices.length, 1);
near(p.voices[0].at, 1);
near(p.voices[0].dur, 2);
assert.equal(p.voices[0].off, 0);
/* 没有候选源 → 空计划，不是抛错 */
assert.deepEqual(createPlayPlan(ctxOf({ curShot: () => shot, candTrackSrc: () => '' }))().clips, []);

/* 全片：格子倍速折半，配音 at 只除画面倍速；黑场不带 track */
const tl = { clips: [
  { kind: 'shot', shotId: 's2', candId: 'c2', seg: 0, in: 2, out: 6, speed: 2, volume: 0.7 },
  { kind: 'shot', shotId: 's2', candId: 'c2', seg: 0, in: 6, out: 7, speed: 1, gray: 1 },
] };
const cand = { vid: 'c2' };
const planFilm = createPlayPlan(ctxOf({
  getProj: () => ({ tlTab: 'film', curCand: 0 }),
  tlSyncFromShots: () => tl,
  allShots: () => [{ id: 's2', candidates: [cand] }],
  tlCandidateOf: () => cand,
  candTrackSrc: () => 'f.mp4',
  filmFrames: () => ({ rows: [
    { start: 0, a: 0, f0: 0, fd: 2 }, { start: 3, a: 2, f0: 2, fd: 1 },
  ], total: 9, filmTotal: 3 }),
  filmLayGray: () => [[2, 3]],
  clipVoices: () => ({ list: [{ src: 'v.mp3', start: 1, dur: 2, vol: 0.8, off: 0.5, spd: 1 }] }),
}));
p = planFilm();
assert.equal(p.film, true);
assert.equal(p.clips.length, 2);
assert.deepEqual(p.clips[0], { src: 'f.mp4', in: 2, out: 6, fs: 0, fa: 0, vol: 0.7, spd: 2 });
assert.deepEqual(p.clips[1], { src: '', in: 6, out: 7, fs: 3, fa: 2, vol: 1, spd: 1 });
near(p.voices[0].at, 0.5, '配音起点只除画面倍速');
near(p.voices[0].dur, 1, '文件秒 ÷（画面倍速 × 自己）');
assert.equal(p.voices[0].off, 0.5);
assert.equal(p.voices[0].spd, 2);

console.log('✓ 播放计划：本镜 / 全片 / 黑场 / 倍速折算');
