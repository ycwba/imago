#!/usr/bin/env node
/* 黄金输出：同一份镜头 fixture，派生 clips / 段表 / 框表 / 播放计划必须与基线逐字一致。
   PARITY_WRITE=1 node tests/e2e/parity.cjs 重新生成基线。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'tests/fixtures/parity-golden.json');
const WRITE = process.env.PARITY_WRITE === '1';

(async () => {
  const seg = await import(pathToFileURL(path.join(ROOT, 'web/director/segments.js')).href);
  const { createTimeline } = await import(pathToFileURL(path.join(ROOT, 'web/director/timeline.js')).href);
  const { createProjection } = await import(pathToFileURL(path.join(ROOT, 'web/director/projection.js')).href);
  const { createPlayPlan } = await import(pathToFileURL(path.join(ROOT, 'web/director/plan.js')).href);

  const shots = [
    { id: 's1', name: '镜头一', selId: 'c1', candidates: [{ vid: 'c1', duration: 8, segs: [
      { in: 0, out: 3, a: 0, b: 4, spd: 2 },
      { in: 5, out: 8, a: 4, b: 8, vol: 0.5, ln: 1 },
    ] }] },
    { id: 's2', name: '镜头二', selId: 'c2', candidates: [{ vid: 'c2', duration: 4, segs: [
      { in: 0, out: 4, off: 1 },
    ] }] },
  ];
  let proj = { filmOrder: [], tlTab: 'shot', curCand: 0 };
  let n = 0;
  const P = createProjection({
    getProj: () => proj,
    allShots: () => shots,
    shotReady: sh => !!sh.selId,
    tlCandidateOf: (sh, id) => (sh.candidates || []).find(c => c.vid === id) || null,
    candDur: (c, sh) => c.duration || sh.duration || 5,
    segSpd: s => (s.spd == null ? 1 : s.spd),
    picVolOf: s => (s.vol == null ? 1 : s.vol),
    uid: () => 'id' + (++n),
  });
  const Timeline = createTimeline({
    allShots: () => shots,
    tlCandidateOf: (sh, id) => (sh.candidates || []).find(c => c.vid === id) || null,
    candDur: (c, sh) => c.duration || sh.duration || 5,
  });
  const shot = shots[0];
  const cand = shot.candidates[0];
  const total = 8;
  const segs = seg.segsOf(cand, total);
  const G = Timeline.shotFrames(segs);
  const tl = P.tlSyncFromShots();
  const FG = Timeline.filmFrames(tl);

  const voice = { id: 'v1', shotId: 's1', candId: 'c1', seg: 0, at: 1, dur: 2, src: 'v.mp3', vol: 0.8, spd: 1 };
  const planShot = createPlayPlan({
    getProj: () => proj,
    curShot: () => shot,
    allShots: () => shots,
    tlCandidateOf: (sh, id) => (sh.candidates || []).find(c => c.vid === id) || null,
    candDur: (c, sh) => c.duration || sh.duration || 5,
    picVolOf: s => (s.vol == null ? 1 : s.vol),
    tlSyncFromShots: () => proj.timeline,
    filmFrames: () => FG,
    filmLayGray: () => [[0, 1]],
    candTrackSrc: () => 'clip.mp4',
    clipVoices: () => ({ list: [{ src: 'v.mp3', start: 1, dur: 2, vol: 0.8, off: 0, spd: 1 }] }),
    shotVoices: () => [voice],
    voiceVolOf: v => (v.vol == null ? 1 : v.vol),
  })();

  const actual = {
    clips: tl.clips,
    段表: G,
    框表: FG,
    本镜计划: planShot,
  };
  if (WRITE) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(actual, null, 2) + '\n');
    console.log('✓ 已写入黄金基线：' + path.relative(ROOT, OUT));
    return;
  }
  const want = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert.deepEqual(actual, want);
  console.log('✓ 黄金输出一致（clips / 段表 / 框表 / 播放计划）');
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
