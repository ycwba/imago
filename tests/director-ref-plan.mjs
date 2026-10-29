#!/usr/bin/env node
/* 导演台素材计划：编号与发送顺序同源（首帧 → 尾帧 → 画面切片 → 参考图 → 视频 → 音频）、
   画面切片与参考图按地址去重、@ 名字 / 首帧 / 视频 / 音频的替换、平台引用语法。
   纯算法，不碰 DOM / 网络。 */
import assert from 'node:assert/strict';
import { shotRefPlanOf, tokenizeRefPrompt, applyProviderRefSyntax } from '../web/director/ref-plan.js';

const ic = { maxRef: 9, ref: true, refVideo: true, refAudio: true };
const srcOf = id => 'asset:' + id;
const shot = {
  firstFrame: 'first.png',
  lastFrame: 'last.png',
  keyframes: [{ assetId: 'k1', t: 2 }, { assetId: 'k2', t: 4 }],
  refImages: ['r1.png', 'r2.png', 'r3.png'],
  refMeta: [{ label: '小雅' }, { label: '' }, { label: '阿强' }],
  refVideo: { src: 'v.mp4' },
  refAudio: { src: 'a.mp3' },
};
const plan = shotRefPlanOf(shot, ic, null, srcOf);
assert.deepEqual(plan.pictures.map(p => [p.kind, p.n, p.token, p.src]),
  [['first_frame', 1, '@参考图1', 'first.png'],
    ['last_frame', 2, '@参考图2', 'last.png'],
    ['keyframe', 3, '@参考图3', 'asset:k1'],
    ['keyframe', 4, '@参考图4', 'asset:k2'],
    ['ref', 5, '@参考图5', 'r1.png'],
    ['ref', 6, '@参考图6', 'r2.png'],
    ['ref', 7, '@参考图7', 'r3.png']]);
assert.equal(plan.videos[0].token, '@视频1');
assert.equal(plan.audios[0].token, '@音频1');
assert.equal(plan.refUsed, 5);

/* 上限只夹参考图这一族：首尾帧不占 maxRef，切片的编号排在参考图前面。 */
const small = shotRefPlanOf(shot, { maxRef: 3, ref: true, refVideo: true, refAudio: true }, null, srcOf);
assert.deepEqual(small.pictures.map(p => p.n + ':' + p.kind), ['1:first_frame', '2:last_frame', '3:keyframe', '4:keyframe', '5:ref']);
assert.equal(small.refOver, 2);

/* 切片同时也在 refImages 里时按地址去重，不能把同一张图发两遍。 */
const dup = shotRefPlanOf({
  refImages: ['asset:k1', 'r2.png'], keyframes: [{ assetId: 'k1', t: 2 }], refMeta: [{}, { label: '小雅' }],
}, { maxRef: 9, ref: true }, null, srcOf);
assert.deepEqual(dup.pictures.map(p => p.kind + ':' + p.src), ['keyframe:asset:k1', 'ref:r2.png']);
assert.equal(dup.refDup, 1);
assert.equal(dup.refUsed, 2);

/* 接上一镜尾帧：没有显式首帧时占第 1 张图的位置，但在提交前不解析字节。 */
const chain = shotRefPlanOf({ linkPrev: 'tail', refImages: ['r1.png'], refMeta: [{ label: '小雅' }] },
  { maxRef: 9, ref: true }, { chainPending: true }, srcOf);
assert.deepEqual(chain.pictures.map(p => p.kind), ['chain', 'ref']);
assert.equal(chain.pictures[0].pending, true);

/* 模型没有 reference_image 槽位时，切片 / 参考图一张都不进计划；视频 / 音频不受这一条影响。 */
const noRef = shotRefPlanOf({ keyframes: [{ assetId: 'k1' }], refImages: ['r1.png'], refVideo: { src: 'v.mp4' } },
  { maxRef: 9, ref: false, refVideo: true, refAudio: false }, null, srcOf);
assert.equal(noRef.pictures.length, 0);
assert.equal(noRef.videos.length, 1);

/* 提示词：名字 → 规范标记；首帧 / 尾帧 / 视频 / 音频各有写法；已有编号原样留着。 */
const text = '@小雅 看着 @首帧，又看向 @尾帧；参考 @视频1 的运镜，别用 @参考音频 的音色，保留 @参考图3。';
const tok = tokenizeRefPrompt(text, plan);
assert.ok(tok.includes('@参考图5 看着'), tok);
assert.ok(tok.includes('又看向 @参考图2'), tok);
assert.ok(tok.includes('参考 @视频1'), tok);
assert.ok(tok.includes('@音频1 的音色'), tok);
assert.ok(tok.includes('保留 @参考图3'), tok);
assert.equal(tokenizeRefPrompt('@图片2', plan), '@参考图2');
assert.equal(tokenizeRefPrompt('@小雅·三视图', plan), '@小雅·三视图', '没有这张资产时不能被 @小雅 抢先改掉');

/* 平台语法：H3 的三类标签；未声明的平台原样提交。 */
const h3 = { picture: '<Picture {n}>', video: '<Video {n}>', audio: '<Audio {n}>' };
assert.equal(applyProviderRefSyntax('@参考图1 + @图片2 + @视频1 + @参考视频2 + @音频3 + @参考音频4', h3),
  '<Picture 1> + <Picture 2> + <Video 1> + <Video 2> + <Audio 3> + <Audio 4>');
assert.equal(applyProviderRefSyntax('@参考图1', null), '@参考图1');
assert.equal(applyProviderRefSyntax('@参考图1', '[image{n}]'), '[image1]');

console.log('✓ director-ref-plan');
