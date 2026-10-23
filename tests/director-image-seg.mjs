#!/usr/bin/env node
/* 图片段：虚拟坐标与视频段不重叠 / 平铺格数夹取 / 插入与切开 / 行查找按包含不在右沿。 */
import assert from 'node:assert/strict';
import {
  IMAGE_SEGMENT_SECONDS, IMAGE_THUMBNAIL_TARGET_WIDTH, IMAGE_THUMBNAIL_MAX_COUNT,
  isImageSeg, imageDurOf, imageTileCount, imageCoordOk, imageVirtualBase,
  makeImageSeg, placeImageSeg, imageTailSeg,
} from '../web/director/image-seg.js';
import { segsOf, segsPan, segsWrite, segsFilmLen, segVol, segSpd, segCarry, SEG_MIN } from '../web/director/segments.js';
import { createTimeline } from '../web/director/timeline.js';
import { createProjection } from '../web/director/projection.js';

assert.equal(IMAGE_SEGMENT_SECONDS, 2);
assert.equal(IMAGE_THUMBNAIL_TARGET_WIDTH, 84);
assert.equal(IMAGE_THUMBNAIL_MAX_COUNT, 240);
assert.equal(isImageSeg({ img: '/asset/a.png' }), true);
assert.equal(isImageSeg({ img: '' }), false);
assert.equal(isImageSeg({ in: 0, out: 2 }), false);

/* 时长：有 a/b 用框，其次选区，再次 dur，缺省 2 秒 */
assert.equal(imageDurOf({ a: 10, b: 12.5 }), 2.5);
assert.equal(imageDurOf({ in: 4, out: 5.5 }), 1.5);
assert.equal(imageDurOf({ dur: 3 }), 3);
assert.equal(imageDurOf({}), 2);

/* 平铺格数：至少 1、最多 240、按 84px 向上取整 */
assert.equal(imageTileCount(0), 1);
assert.equal(imageTileCount(84), 1);
assert.equal(imageTileCount(85), 2);
assert.equal(imageTileCount(84 * 240), 240);
assert.equal(imageTileCount(1e9), 240);

/* 虚拟坐标：视频段占 [0,total]，图片一律排在 total 之后 0.1 秒起 */
assert.equal(imageCoordOk({ img: 'x', a: 10, b: 12 }, 10), false, '落在视频轴上不算有效');
assert.equal(imageCoordOk({ img: 'x', a: 10.2, b: 12 }, 10), true);
assert.equal(imageVirtualBase([{ in: 0, out: 4, a: 0, b: 4 }], 4), 4.1);
assert.equal(imageVirtualBase([{ in: 0, out: 4, a: 0, b: 4 }, { img: 'x', a: 4.1, b: 6.1 }], 4), 6.2);

/* 混排归一：视频不动；没坐标的图片按顺序分到视频之后；再读一遍坐标不变 */
const mixed = segsOf({ segs: [
  { in: 0, out: 4, a: 0, b: 4 },
  { img: '/asset/a.png', imgName: 'A', dur: 2 },
  { img: '/asset/b.png', dur: 3, ln: 2 },
] }, 4);
assert.equal(mixed.length, 3);
assert.deepEqual(mixed[1], { in: 4.1, out: 6.1, a: 4.1, b: 6.1, img: '/asset/a.png', imgName: 'A' });
assert.deepEqual(mixed[2], { in: 6.1, out: 9.1, a: 6.1, b: 9.1, img: '/asset/b.png', ln: 2 });
assert.deepEqual(segsOf({ segs: mixed }, 4), mixed, '存回去再读一个字都不变');
assert.equal(segVol(mixed[1]), 0, '图片没有原声');
assert.equal(segSpd(mixed[1]), 1, '图片没有倍速');
assert.equal(segsPan({ segs: mixed }, 4), 9.1);
assert.equal(segsFilmLen({ segs: mixed }, 4), 9);

/* 只写 dur 的图片：坐标落在视频之后，绝不从 0 开始 */
const bare = segsOf({ segs: [{ img: 'x', dur: 2 }] }, 10);
assert.deepEqual(bare[0], { in: 10.1, out: 12.1, a: 10.1, b: 12.1, img: 'x' });
assert.equal(imageCoordOk(bare[0], 10), true);

/* 老视频段：图片段一个都没有时输出逐字不变 */
assert.deepEqual(segsOf({ segs: [{ in: 1, out: 3 }] }, 10), [{ in: 1, out: 3, a: 1, b: 3 }]);

/* 插进第 i 段之前：虚拟坐标接在所有内容之后；原数组不动 */
const before = [{ in: 0, out: 3, a: 0, b: 3 }];
const placed = placeImageSeg(before, 3, { src: '/asset/c.png', name: 'C', index: 0 });
assert.equal(before.length, 1, '原数组不动');
assert.equal(placed.index, 0);
assert.equal(placed.segs.length, 2);
assert.equal(placed.seg.img, '/asset/c.png');
assert.equal(placed.seg.imgName, 'C');
assert.deepEqual({ a: placed.seg.a, b: placed.seg.b }, { a: 3.1, b: 5.1 });
assert.equal(placed.segs[1].in, 0, '原视频段原样跟在后面');

/* 切开：左半保留原坐标，右半拿一份新的虚拟坐标，两段各自带走图片身份 */
const tail = imageTailSeg({ img: '/asset/c.png', imgName: 'C', in: 3.1, out: 5.1, a: 3.1, b: 5.1 }, 4.1,
  [{ img: '/asset/c.png', a: 3.1, b: 5.1 }], 3);
assert.equal(tail.img, '/asset/c.png');
assert.equal(tail.imgName, 'C');
assert.equal(tail.in, 5.2);
assert.equal(tail.out, 6.2);
assert.ok(tail.a >= 3 + 0.05);

/* 落回：trimS/trimE 只跟视频段走（图片的虚拟秒不许写进这两个旧字段） */
const cand = {};
const wrote = segsWrite(cand, 4, [{ img: 'x', dur: 2 }, { in: 1, out: 3, a: 1, b: 3 }]);
assert.equal(wrote.length, 2);
assert.equal(cand.trimS, 1);
assert.equal(cand.trimE, 3);
const onlyImg = {};
segsWrite(onlyImg, 4, [{ img: 'x', dur: 2 }]);
assert.equal(onlyImg.trimS, 0);
assert.equal(onlyImg.trimE, 0);

/* 搬运：img / imgName / 行号 / 灰场旗标都跟着走，vol/spd 不上图片段 */
const carried = segCarry({ img: 'x', imgName: 'A', ln: 3, off: 1, vol: 0.5, spd: 2 }, { in: 0, out: 1 });
assert.deepEqual(carried, { in: 0, out: 1, img: 'x', imgName: 'A', ln: 3, off: 1 });
assert.equal(SEG_MIN, 0.2);

/* 行查找：按「框包住」找，不按第一个右沿 —— 视频尾与第一张图之间的缝归最近的那一格 */
const Timeline = createTimeline({ allShots: () => [], tlCandidateOf: () => null, candDur: () => 4 });
const G = Timeline.shotFrames(mixed);
assert.equal(G.rows.length, 3);
assert.equal(Timeline.shotRowOf(G, 1).i, 0, '视频段里');
assert.equal(Timeline.shotRowOf(G, 4.1).i, 1, '第一张图的起点');
assert.equal(Timeline.shotRowOf(G, 5).i, 1);
assert.equal(Timeline.shotRowOf(G, 6.5).i, 2);
assert.equal(Timeline.shotRowOf(G, 4.05).i, 0, '缝里归左边（离视频尾更近）');
assert.equal(Timeline.shotRowOf(G, 9.5).i, 2, '越界夹到最后一张图');
assert.equal(Timeline.shotPinT(G, 4.1), G.rows[1].start);
assert.equal(Timeline.shotPinT(G, 5.1), G.rows[1].start + 1, '图 1 里 1 秒 = 轴秒 1 秒');

/* 单张图片：轴长就是它的时长 */
const one = Timeline.shotFrames(segsOf({ segs: [{ img: 'x', dur: 2 }] }, 10));
assert.equal(one.total, 2);
assert.equal(Timeline.shotRowOf(one, 10.1).i, 0);

/* 工程 → 成片 clips（导出成片 / 导出素材 / FCPXML 都只读这一份投影）：
   图片段带 img/imgName、倍速恒 1、音量恒 0；空段带 gap；没变的工程复用同一份 tl。 */
const pjCand = { vid: 'cp', url: '/asset/la_pic.mp4', segs: [
  { in: 0, out: 2, a: 0, b: 2 },
  { in: 2, out: 4, a: 2, b: 4, off: 1, gap: 1 },
  { img: '/asset/still.png', imgName: '封面', dur: 2 },
] };
const pjShot = { id: 'sp', name: '镜', selId: 'cp', candidates: [pjCand] };
const pj = { name: '图片片' };
const Proj = createProjection({
  getProj: () => pj,
  allShots: () => [pjShot],
  shotReady: () => true,
  tlCandidateOf: (sh, vid) => (sh.candidates || []).find(c => c.vid === vid) || null,
  candDur: () => 4,
  segSpd,
  picVolOf: segVol,
  uid: (() => { let n = 0; return () => 'u' + (++n); })(),
});
const clips = Proj.tlFromShots().clips;
assert.equal(clips.length, 3);
assert.deepEqual({ in: clips[0].in, out: clips[0].out, img: clips[0].img }, { in: 0, out: 2, img: undefined });
assert.equal(clips[1].gap, 1, '空段标记要进 clip（名称行要写「空段」）');
assert.equal(clips[1].gray, 1, '空段在成片里出黑场');
assert.equal(clips[2].img, '/asset/still.png');
assert.equal(clips[2].imgName, '封面');
assert.equal(clips[2].in, 4.1, '图片段从虚拟坐标起（不与视频的源秒重叠）');
assert.equal(clips[2].speed, 1, '静态图没有倍速：导出按 1 写');
assert.equal(clips[2].volume, 0, '静态图没有原声');
assert.equal(clips[2].gray, 0);
const tlOne = Proj.tlSyncFromShots();
assert.equal(Proj.tlSyncFromShots(), tlOne, '内容没变就复用同一份（播放跟随每帧都会调它）');
pjCand.segs[2].imgName = '封面2';
assert.notEqual(Proj.tlSyncFromShots(), tlOne, '换图 / 改名要算变化');

console.log('✓ 图片段：虚拟坐标 / 平铺格数 / 插入切开 / 行查找 / 成片投影');
