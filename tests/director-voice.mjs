#!/usr/bin/env node
/* 配音时间账：框与选区 / 灰场跳过 / 全片轴上的那一段与原因码。 */
import assert from 'node:assert/strict';
import {
  voiceRateOf, voiceFrameOf, roundVoice, voiceRuns, rowSelIn, rowSelOut,
  makeVoiceAxBox, createVoiceFilm, lineSpanAt, lineEstSec,
} from '../web/director/voice-layout.js';

const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, why + '：' + a + ' ≠ ' + b);

assert.equal(voiceRateOf({ spd: 9 }), 4);
assert.equal(voiceRateOf({ spd: 0.1 }), 0.25);
assert.equal(voiceRateOf({}), 1);

/* 老数据没有框：框 = 选区，且 dur 是文件秒，要按自己那一档折回源秒 */
let fr = voiceFrameOf({ at: 1, dur: 2, spd: 2 });
near(fr.fa, 1);
near(fr.fb, 2);
/* 框必须包住选区 */
fr = voiceFrameOf({ at: 2, dur: 2, fa: 0, fb: 1 });
near(fr.fa, 0);
near(fr.fb, 4);

const v = roundVoice({ at: 1.234, dur: 2.345, fa: 0.111, fb: 3.999, off: 0.444 });
assert.deepEqual([v.at, v.dur, v.fa, v.fb, v.off], [1.2, 2.3, 0.1, 4, 0.4]);

/* 没有灰场：一段、不拉长 */
let lay = voiceRuns(1, 3, []);
assert.deepEqual(lay.runs, [[1, 4]]);
assert.equal(lay.end, 4);
assert.equal(lay.filmSec, 3);
/* 黑场：成片里多占；头尾灰：不占成片时长，但轨道上照样跳过 */
lay = voiceRuns(0, 4, [[1, 2, 1], [3, 3.5, 0]]);
assert.deepEqual(lay.runs, [[0, 1], [2, 3], [3.5, 5.5]]);
assert.deepEqual(lay.skips, [[1, 2, 1], [3, 3.5, 0]]);
assert.equal(lay.end, 5.5);
assert.equal(lay.filmSec, 5, '只有黑场那 1 秒计进成片');
assert.deepEqual(voiceRuns(0, 0.01, []).runs, []);

/* 两句：轴行上的折算只乘一次画面倍速、一次自己那档 */
const srcToFrame = (r, s) => r.start + (s - r.a) / r.spd;
const ax = makeVoiceAxBox(srcToFrame);
const row = { s: { in: 4, out: 12 }, a: 4, b: 12, start: 2, spd: 2 };
const box = ax(row, { at: 2, dur: 4, spd: 2 });
assert.equal(box.base, 2);
near(box.box.l, 3);
near(box.box.w, 1);
near(box.sel.l, 3);
near(box.sel.w, 1);
assert.equal(rowSelIn(row), 4);
assert.equal(rowSelOut(row), 12);
assert.equal(rowSelIn({ cl: { in: 7 } }), 7);

/* 全片轴上的那一段 + 原因码 */
const shots = [{
  id: 's1', selId: 'c1', candidates: [{ vid: 'c1' }, { vid: 'c2' }],
}];
const rows = [{ cl: { kind: 'shot', shotId: 's1', candId: 'c1', seg: 0 }, a: 0, b: 10, start: 0, spd: 1 }];
const vf = createVoiceFilm({
  filmFrames: () => ({ rows }),
  tlSyncFromShots: () => ({}),
  allShots: () => shots,
  voiceAxBox: () => ({ sel: { l: 2, w: 3 } }),
});
assert.deepEqual(vf.voiceFilmSpan({ shotId: 's1', candId: 'c1', seg: 0 }), { from: 2, to: 5 });
assert.equal(vf.voiceFilmGap({ shotId: 's1', candId: 'c1', seg: 0, src: 'a' }), '');
assert.equal(vf.voiceFilmGap({ shotId: 's1', candId: 'c1', seg: 0 }), 'noaudio');
assert.equal(vf.voiceFilmGap({ shotId: 'x', candId: 'c1', src: 'a' }), 'noshot');
assert.equal(vf.voiceFilmGap({ shotId: 's1', candId: 'c2', src: 'a' }), 'unsel');
assert.equal(vf.voiceFilmGap({ shotId: 's1', candId: 'nope', src: 'a' }), 'nocand');
assert.ok(vf.voiceAdoptable({ shotId: 's1', candId: 'c2', src: 'a' }));
assert.equal(vf.voiceInFilm({ shotId: 's1', candId: 'c1', seg: 0, src: 'a' }), true);
assert.match(vf.voiceFilmWhy({ shotId: 's1', candId: 'c2', src: 'a' }), /没被选用/);

/* 台词那一格的时间尺（轨道上两个占位与剪辑右栏那两段共用这一份算式）：
   本镜那一排折成本镜轴秒，全片那一排读成片秒 f0；倍速同时压起点偏移与长度。 */
assert.equal(lineSpanAt(null, 0, 4, false), null, '那一排没有这一镜的格子时不给读数，不拿 0 冒充起点');
assert.deepEqual(lineSpanAt({ a: 0, b: 10, start: 0, spd: 1 }, 2, 6, false), { at: 2, len: 6 });
assert.deepEqual(lineSpanAt({ a: 0, b: 10, start: 1, spd: 2 }, 4, 6, false), { at: 3, len: 3 },
  '×2 时偏移与长度都只占一半（框不变，缩的是轴）');
assert.deepEqual(lineSpanAt({ a: 2, b: 8, f0: 20, spd: 4 }, 2, 8, true), { at: 20, len: 2 },
  '全片那一排读 f0（成片秒），不受这一格在轴上的位置影响');
assert.deepEqual(lineSpanAt({ a: 2, b: 8, start: 0, spd: 2 }, 100, 4, false), { at: 3, len: 2 },
  '起点越界先夹回框里：这一句不能摆到这一格之外');
assert.deepEqual(lineSpanAt({ a: 0, b: 5, start: 0, spd: 1 }, 0, 0, false), { at: 0, len: 0.1 },
  '空台词塌成下限那一小格（0.05 进位到一位小数就是 0.1），不塌成看不见的 0 宽');
assert.ok(lineEstSec('') >= 1.2 && Math.abs(lineEstSec('x'.repeat(45)) - 10) < 1e-9,
  '一句要念多久按字数估（下限 1.2 秒，4.5 字 / 秒）');

console.log('✓ 配音时间账：框 / 灰场 / 全片轴 / 原因码');
