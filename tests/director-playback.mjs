#!/usr/bin/env node
/* 剪辑态播放计划：成片时长 / 段起点 / 源秒与框基秒折算 / 计划指纹 / 黑场与静态图串。 */
import assert from 'node:assert/strict';
import { createPlayback } from '../web/director/playback.js';

globalThis.window = {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { TlPlay } = createPlayback({ mediaSrc: s => '/getv?url=' + s });

const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, why + '：' + a + ' ≠ ' + b);

TlPlay.setPlan([
  { src: 'a', in: 1, out: 4, spd: 1, vol: 1 },
  { src: '', in: 0, out: 2, spd: 1 },
], [], { film: false });
near(TlPlay.total, 5, '本镜档总时长');
assert.deepEqual(TlPlay.starts, [0, 3]);
assert.equal(TlPlay.clipAt(2.9), 0);
assert.equal(TlPlay.clipAt(3), 1);
assert.equal(TlPlay.clipAt(4.9), 1);
/* 本镜档 rate 恒 1：源秒 = 入点 + 段内偏移 */
TlPlay.idx = 0;
TlPlay.t = 1.5;
near(TlPlay.srcT(), 2.5, '本镜档源秒');
/* frameT = 该格在选区轴上的起点（fs）+ 段内走过的成片秒：不再有「(in-fa)/rate」那一项 ——
   排版轴就是选区轴（被剪掉的头尾不占秒），重复加会把播放头推到真实位置之外。本镜档 fs=0 → frameT 就是 t。 */
assert.equal(TlPlay.frameT(), 1.5);

/* 全片档：2 倍速真的把这一格缩成一半，源秒按 rate 涨 */
TlPlay.setPlan([{ src: 'b', in: 4, out: 8, spd: 2, fs: 10, fa: 1, vol: 0.8 }], [], { film: true });
near(TlPlay.total, 2, '全片档倍速折算');
assert.equal(TlPlay.plan[0].rate, 2);
TlPlay.idx = 0;
TlPlay.t = 1;
near(TlPlay.srcT(), 6, '全片档源秒');
/* fs=10（这一格在选区轴上的起点）、t=1（段内走过 1 秒）→ 11。被剪掉的片头（fa=1 与 in=4 之间的差）
   不再重复加：轨道那根轴上根本没有那一截。 */
near(TlPlay.frameT(), 11, '全片档播放头');

/* 指纹认倍速与配音，不认画面段音量（音量当场 applyVol 就能改，不该触发 seek） */
const fp1 = TlPlay.fp;
TlPlay.setPlan([{ src: 'b', in: 4, out: 8, spd: 2, fs: 10, fa: 1, vol: 0.3 }], [], { film: true });
assert.equal(TlPlay.fp, fp1, '画面段音量不进指纹');
TlPlay.setPlan([{ src: 'b', in: 4, out: 8, spd: 3, fs: 10, fa: 1, vol: 0.3 }], [], { film: true });
assert.notEqual(TlPlay.fp, fp1, '倍速必须进指纹');
TlPlay.setPlan([{ src: 'b', in: 4, out: 8, spd: 2, fs: 10, fa: 1, vol: 0.3 }],
  [{ src: 'v', at: 0, dur: 1, vol: 1, spd: 1 }], { film: true });
assert.notEqual(TlPlay.fp, fp1, '配音必须进指纹');

/* 连续黑场 / 同一张静态图整串一次走完（holdRun）：不同的图不并串 —— 并了就只有第一张
   会被打开，后面那张的时间过去了、画面却停在上一张；有视频素材的段不进串。 */
TlPlay.setPlan([
  { src: 'a', in: 0, out: 1, spd: 1 },
  { src: '', in: 0, out: 2, spd: 1 },
  { src: '', in: 0, out: 2, spd: 1 },
  { src: '', in: 0, out: 2, spd: 1, still: 'x' },
  { src: '', in: 0, out: 2, spd: 1, still: 'x' },
  { src: '', in: 0, out: 2, spd: 1, still: 'y' },
  { src: 'a', in: 1, out: 2, spd: 1 },
], [], { film: false });
TlPlay.idx = 1;
assert.equal(TlPlay.holdRun(), 2);
TlPlay.idx = 3;
assert.equal(TlPlay.holdRun(), 4);
TlPlay.idx = 5;
assert.equal(TlPlay.holdRun(), 5);
TlPlay.idx = 6;
assert.equal(TlPlay.holdRun(), 6);

TlPlay.destroy();
assert.equal(TlPlay.plan.length, 0);
assert.equal(TlPlay.playing, false);

console.log('✓ 剪辑态播放计划：时长 / 起点 / 源秒与框基秒 / 指纹 / 黑场与静态图串');
