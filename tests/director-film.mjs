#!/usr/bin/env node
/* 成片模型 proj.film（新剪辑核）：顺序唯一真相（deriveTimeline）/ 源秒折算 / 转场窗 / 行打包 /
   行级眼睛与锁 / 进成片闸 / 台词行 / 小工具。全部纯函数，不开浏览器。 */
import assert from 'node:assert/strict';
import {
  TL_FPS, MIN_CLIP_SECONDS, IMAGE_SEGMENT_SECONDS, LANE_MAX,
  DEFAULT_TRANSITION_SECONDS, TRANSITION_MAX_SECONDS, TRANSITION_MIN_SECONDS,
  MIN_CAPTION_SECONDS, MAX_FILM_SECONDS,
  filmId, estimateSpeechSeconds,
  TRANSITIONS, transitionNameOf, transitionMax, normalizeTransition, transitionOf,
  transitionWindow, transitionAtTime,
  createClip, clipDurationOf, rateOf, srcHeadOf, srcUsedOf, srcLenOf, withPlaybackRate,
  createVoiceClip, createPending, createCaption, captionForTimed,
  normalizeFilm, filmOf, deriveTimeline, filmTotal, clipBoundary,
  chosenCandOf, candidateWindow, promoteCandidate, demoteShot,
  packVoiceLanes, packCaptionLanes, laneOfItem, voiceLaneMap, captionLaneMap,
  rowVisible, rowLocked, rowSet, itemVisible, itemLocked,
  captionPosition, captionPositions, captionHighlighted, captionStyleOf,
  audibleVoices, visibleCaptions, speakerOf, lineTimeOf, lineRowHTML,
  shiftTimed, windowOf, coversTime, gainOf, fadeGain,
} from '../web/director/film.js';
import { normalizeMarkers, markerClock, markerSnapPoints, markerCounts } from '../web/director/tl-markers.js';

/* ---------- 常量 ---------- */
assert.equal(TL_FPS, 30);
assert.equal(MIN_CLIP_SECONDS, 0.05);
assert.equal(IMAGE_SEGMENT_SECONDS, 2);
assert.equal(LANE_MAX, 12);
assert.equal(DEFAULT_TRANSITION_SECONDS, 0.5);
assert.equal(TRANSITION_MAX_SECONDS, 2);
assert.equal(TRANSITION_MIN_SECONDS, 0.1);
assert.equal(MIN_CAPTION_SECONDS, 0.2);
assert.equal(MAX_FILM_SECONDS, 30 * 60);
assert.ok(filmId('clip').startsWith('clip-'));
assert.ok(filmId('voice').startsWith('voice-'));
assert.ok(filmId('clip') !== filmId('clip'));

/* ---------- Clip 工厂 ---------- */
const vid = createClip({ src: '/asset/a', sourceStart: 1.5, sourceDuration: 8 });
assert.equal(vid.kind, 'video');
assert.equal(vid.duration, 8);                       // video：sourceDuration ÷ rate(1)
assert.equal(vid.playbackRate, 1);
assert.equal(vid.sourceStart, 1.5);
assert.ok(vid.id.startsWith('clip-'));

const fast = createClip({ src: '/a', sourceDuration: 10, playbackRate: 2 });
assert.equal(fast.duration, 5);
assert.equal(createClip({ src: '/a', sourceDuration: 10, playbackRate: 99 }).playbackRate, 4);   // 夹上
assert.equal(createClip({ src: '/a', sourceDuration: 10, playbackRate: 0 }).playbackRate, 1);    // 非法回 1
assert.equal(createClip({ src: '/a', sourceStart: -3 }).sourceStart, 0);                          // pos 夹 0
assert.equal(createClip({ ln: 99 }).ln, LANE_MAX - 1);
assert.equal(createClip({ ln: -1 }).ln, 0);
assert.equal(createClip({ volume: 9 }).volume, 4);
assert.equal(createClip({ volume: -1 }).volume, 0);

const img = createClip({ kind: 'image', src: '/asset/p' });
assert.equal(img.kind, 'image');
assert.equal(img.duration, IMAGE_SEGMENT_SECONDS);   // 图片段显式时长，缺省 2s
assert.equal(img.sourceDuration, 0);                 // 图片没有源窗口
assert.equal(rateOf(img), 1);                        // 图片折算恒 1（哪怕误存了倍速）
assert.equal(rateOf({ kind: 'image', playbackRate: 3 }), 1);

/* 存下来的 duration 是权威：clipDurationOf 只夹下限，不再现算 */
assert.equal(clipDurationOf({ duration: 2.345 }), 2.35);
assert.equal(clipDurationOf({ duration: 0.001 }), MIN_CLIP_SECONDS);
assert.equal(clipDurationOf(null), 0);

/* 源窗口三件 */
assert.equal(srcHeadOf({ sourceStart: 2 }), 2);
assert.equal(srcUsedOf({ sourceStart: 2, sourceDuration: 5, duration: 4 }), 5);
assert.equal(srcUsedOf({ duration: 4 }), 4);                          // 缺 sourceDuration 按 duration×rate 兜
assert.equal(srcLenOf({ sourceStart: 2, sourceDuration: 5, mediaDuration: 20 }), 20);   // 原长说了算
assert.equal(srcLenOf({ sourceStart: 2, sourceDuration: 5 }), 7);     // 不知道原长按用到的那一尾

/* 改倍速：源窗口不动，duration = sourceDuration ÷ rate */
const rated = withPlaybackRate(vid, 2);
assert.equal(rated.sourceStart, 1.5);
assert.equal(rated.sourceDuration, 8);
assert.equal(rated.duration, 4);
assert.equal(withPlaybackRate(vid, 99).playbackRate, 4);
assert.equal(withPlaybackRate(img, 2), img);           // 图片段不吃倍速

/* ---------- 派生时间线：顺序唯一真相 ---------- */
const c1 = createClip({ src: '/1', sourceDuration: 2 });
const c2 = createClip({ src: '/2', sourceDuration: 3 });
const c3 = createClip({ kind: 'image', duration: 1 });
const tl = deriveTimeline([c1, c2, c3]);
assert.equal(tl.total, 6);
assert.deepEqual(tl.rows.map(r => [r.start, r.end]), [[0, 2], [2, 5], [5, 6]]);
assert.equal(tl.indexAtTime(0), 0);
assert.equal(tl.indexAtTime(1.99), 0);
assert.equal(tl.indexAtTime(2), 1);                    // 段起点归新段
assert.equal(tl.indexAtTime(5.5), 2);
assert.equal(tl.indexAtTime(100), 2);                  // 越界夹到尾
assert.equal(tl.indexAtTime(-5), 0);                   // 越界夹到头
assert.equal(tl.rowAtTime(3).clip, c2);
assert.equal(filmTotal([c1, c2, c3]), 6);
assert.equal(filmTotal([]), 0);
assert.deepEqual(clipBoundary([c1, c2, c3], 1), { start: 2, end: 5 });
assert.equal(clipBoundary([c1, c2, c3], 3), null);     // 找不到不拿 0 冒充
assert.equal(deriveTimeline([]).indexAtTime(1), -1);

/* ---------- 片段之间可以留空（clip.gap） ---------- */
const g1 = createClip({ src: '/a', sourceDuration: 2, gap: 1.5 });
assert.equal(g1.gap, 1.5, 'createClip 留住 gap');
const gtl = deriveTimeline([createClip({ sourceDuration: 2 }), createClip({ sourceDuration: 2, gap: 1 })]);
assert.deepEqual(gtl.rows.map(r => [r.start, r.end]), [[0, 2], [3, 5]], 'gap 记在后面那一段的前面');
assert.equal(gtl.total, 5, '总长把空隙算进去');
assert.equal(gtl.rowAtTime(2.5), null, '空隙里没有画面（rowAtTime 给 null）');
assert.equal(gtl.indexAtTime(2.5), 1, '空隙里按后面那一段当邻居');
assert.equal(gtl.rowAtTime(3.2).index, 1);
assert.equal(deriveTimeline([createClip({ sourceDuration: 2, gap: 1 })]).rows[0].start, 1, '首段前面也能空');
assert.equal(normalizeFilm({ clips: [{ src: '/a', sourceDuration: 2, gap: 0.8 }] }).clips[0].gap, 0.8, '正常化留住 gap');

/* ---------- 转场 ---------- */
assert.equal(TRANSITIONS.length, 9);
assert.equal(transitionNameOf('fade'), '淡入淡出');
assert.equal(transitionNameOf('nope'), '无转场');      // 未知 id 落 none
assert.equal(transitionMax(null, null), TRANSITION_MAX_SECONDS);       // 两段都不在 → 上限 2
assert.equal(transitionMax({ duration: 3 }, { duration: 1 }), 0.5);    // 较短段的一半
assert.equal(transitionMax({ duration: 0.1 }, { duration: 10 }), TRANSITION_MIN_SECONDS); // 兜底下限
assert.equal(transitionMax({ duration: 100 }, { duration: 100 }), TRANSITION_MAX_SECONDS);
assert.equal(normalizeTransition(null), null);
assert.equal(normalizeTransition({ id: 'none' }), null);
assert.equal(normalizeTransition({ id: 'nope' }), null);                // 未知 → none → null
assert.deepEqual(normalizeTransition({ id: 'fade' }), { id: 'fade', duration: 0.5 });    // 缺省 0.5
assert.deepEqual(normalizeTransition({ id: 'fade', duration: 99 }, { duration: 2 }, { duration: 2 }),
  { id: 'fade', duration: 1 });                                        // 按两段各半夹
assert.deepEqual(transitionOf({ transition: { id: 'zoom', duration: 1 } }, { duration: 10 }),
  { id: 'zoom', duration: 1 });
assert.equal(transitionOf({}, null), null);

/* 转场窗：[本段末 - dur, 本段末)，dur 再按两段实际行长兜一次底 */
const trow = { clip: { transition: { id: 'fade', duration: 1 } }, start: 0, end: 2 };
const tnext = { clip: {}, start: 2, end: 12 };
let w = transitionWindow(trow, tnext);
assert.deepEqual([w.start, w.end, w.duration], [1, 2, 1]);
w = transitionWindow({ clip: { transition: { id: 'fade', duration: 1 } }, start: 0, end: 0.6 }, tnext);
assert.deepEqual([w.start, w.end, w.duration], [0, 0.6, 0.6]);          // 行比转场短时不留半个窗
assert.equal(transitionWindow(trow, null), null);                       // 没有下一段
assert.equal(transitionWindow({ clip: {}, start: 0, end: 2 }, tnext), null);

/* 某一秒落在哪个窗里（带 progress） */
const rows = deriveTimeline([c1, c2]).rows;
rows[0].clip.transition = { id: 'fade', duration: 1 };
const hit = transitionAtTime(rows, 1.5);
assert.equal(hit.id, 'fade');
assert.deepEqual([hit.start, hit.end], [1, 2]);
assert.ok(Math.abs(hit.progress - 0.5) < 1e-9);
assert.equal(transitionAtTime(rows, 2), null);          // t=2 已在下一段，窗口是 [start, end)
assert.equal(transitionAtTime(rows, 0.5), null);        // 窗外
assert.equal(transitionAtTime([], 1), null);

/* ---------- 候选 → 片段 ---------- */
const sh1 = { id: 'sh1', name: '镜头一' };
const sh2 = { id: 'sh2', name: '镜头二' };
const sh3 = { id: 'sh3', name: '镜头三' };
assert.equal(chosenCandOf({ candidates: [{ vid: 'v2' }, { vid: 'v1' }], selId: 'v1' }).vid, 'v1');
assert.equal(chosenCandOf({}), null);

assert.deepEqual(candidateWindow({ duration: 10, trimS: -2, trimE: 99 }), { sourceStart: 0, sourceDuration: 10 });
assert.deepEqual(candidateWindow({ duration: 10, trimS: 5, trimE: 5.01 }), { sourceStart: 5, sourceDuration: MIN_CLIP_SECONDS });
assert.equal(candidateWindow({ trimS: 0 }).sourceDuration, 1);          // 没有时长按 1s 兜

/* 已有片段 → 原位替换：id / 位置保留，种类跟着换，采样缓存清空 */
const old = createClip({ kind: 'image', shotId: 'sh1', duration: 3, trackFrames: [{ t: 1 }], peaks: [1] });
const replaced = promoteCandidate([old], sh1, { vid: 'v9', url: '/asset/x', duration: 8, trimS: 1, trimE: 6 });
assert.equal(replaced.replaced, true);
assert.equal(replaced.index, 0);
const nc = replaced.clips[0];
assert.equal(nc.id, old.id);                            // 原位替换保 id
assert.equal(nc.kind, 'video');                         // 种类跟着候选换
assert.equal(nc.sourceStart, 1);
assert.equal(nc.sourceDuration, 5);
assert.equal(nc.mediaDuration, 8);
assert.equal(nc.duration, 5);                           // video：源窗 ÷ rate(1)
assert.deepEqual(nc.trackFrames, []);
assert.deepEqual(nc.peaks, []);

/* 反向换种：视频段 → 图片候选，时长保住、源窗清零 */
const oldVid = createClip({ shotId: 'sh1', src: '/a', sourceStart: 1, sourceDuration: 6, duration: 6 });
const repImg = promoteCandidate([oldVid], sh1, { vid: 'p1', kind: 'image', url: '/asset/p', duration: 4 });
assert.equal(repImg.replaced, true);
assert.equal(repImg.clips[0].kind, 'image');
assert.equal(repImg.clips[0].duration, 6);              // 图片段保住旧时长
assert.equal(repImg.clips[0].sourceDuration, 0);

/* 还没有片段 → 按镜头顺序插：插在第一个「更晚镜头」的片段之前 */
const a1 = createClip({ shotId: 'sh1', src: '/1', sourceDuration: 2 });
const a3 = createClip({ shotId: 'sh3', src: '/3', sourceDuration: 2 });
const ins = promoteCandidate([a1, a3], sh2, { vid: 'v2', url: '/asset/2', duration: 4 }, ['sh1', 'sh2', 'sh3']);
assert.equal(ins.replaced, false);
assert.equal(ins.index, 1);
assert.equal(ins.clips.length, 3);
assert.equal(ins.clips[1].shotId, 'sh2');
const insTail = promoteCandidate([a1], sh3, { vid: 'v3', url: '/asset/3', duration: 2 }, ['sh1', 'sh3']);
assert.equal(insTail.index, 1);                          // 没有更晚的 → 追加到末尾
const insEnd = promoteCandidate([a1], { id: 'sh9', name: '镜头九' }, { vid: 'v9', url: '/asset/9', duration: 2 }, []);
assert.equal(insEnd.index, 1);                           // 缺顺序表退回追加

/* 取消选用：按 shotId 全撤（切出来的多段一起） */
const dem = demoteShot([a1, ins.clips[1], a3], 'sh2');
assert.equal(dem.removed, 1);
assert.equal(dem.clips.length, 2);
assert.equal(demoteShot([a1], 'nope').removed, 0);

/* ---------- 配音 / 待生成 / 字幕工厂 ---------- */
const vc = createVoiceClip({ text: '你好', start: 1, sourceDuration: 4, playbackRate: 2 });
assert.ok(vc.id.startsWith('voice-'));
assert.equal(vc.duration, 2);
assert.equal(vc.start, 1);
assert.equal(vc.status, 'done');
assert.equal(createVoiceClip({}).duration, MIN_CLIP_SECONDS);   // 下限

const pd = createPending({ text: '待念', start: 3, duration: 1.5 });
assert.ok(pd.id.startsWith('pend-'));
assert.equal(pd.status, 'pending');
assert.equal(createPending({}).duration, 0.6);                  // 缺省估读半句的底

const cap = createCaption({ text: '字幕', start: 1 });
assert.ok(cap.id.startsWith('cap-'));
assert.equal(cap.end, 3);                                       // 缺省 2s 长
assert.equal(createCaption({ start: 1, end: 1 }).end, 1.2);     // 最短 MIN_CAPTION_SECONDS
const capFor = captionForTimed(pd);
assert.equal(capFor.text, '待念');
assert.equal(capFor.start, 3);
assert.equal(capFor.end, 4.5);
assert.equal(capFor.voiceId, pd.id);

/* ---------- 整份规整 ---------- */
const empty = normalizeFilm(null);
assert.deepEqual(empty.clips, []);
assert.deepEqual(empty.voices, []);
assert.deepEqual(empty.pending, []);
assert.deepEqual(empty.captions, []);
assert.deepEqual(empty.markers, []);
assert.deepEqual(empty.tracks, { visibility: {}, locks: {} });
assert.deepEqual(filmOf(null), empty);
assert.equal(filmOf({ film: { clips: [{ src: '/a', sourceDuration: 2 }] } }).clips.length, 1);

const nf = normalizeFilm({
  clips: [null, 'x', { src: '/a', sourceDuration: 1, transition: { id: 'fade', duration: 2 } },
          { src: '/b', sourceDuration: 1, transition: { id: 'nope' } }],
  voices: [{ id: 'voice-x', text: 'v', start: 0 }],
  pending: [{ text: 'p', start: 1 }],
  captions: [{ text: '连着的', start: 0, voiceId: 'voice-x' },
             { text: '断了的', start: 2, voiceId: 'voice-dead', detachedVoiceId: 'voice-old' }],
  markers: [{ type: 'chapter', time: 1 }],
  tracks: { visibility: { voice: false } },
});
assert.equal(nf.clips.length, 2);
assert.deepEqual(nf.clips[0].transition, { id: 'fade', duration: 0.5 });  // 相邻两段重新夹
assert.ok(!('transition' in nf.clips[1]));                                 // 未知 id 摘掉
assert.equal(nf.captions[0].voiceId, 'voice-x');                           // 活引用保留
assert.equal(nf.captions[1].voiceId, '');                                  // 死链接断开
assert.equal(nf.captions[1].detachedVoiceId, 'voice-old');                 // 记忆位不覆盖已有
assert.equal(nf.markers[0].type, 'chapter');
assert.equal(nf.tracks.visibility.voice, false);

/* ---------- 行打包 ---------- */
let voiceSeq = 0;
const mkVoice = (start, duration, lane) => ({ id: 'vq' + (voiceSeq++), start, duration, lane: lane || 0 });
let pack = packVoiceLanes([mkVoice(0, 5, 0), mkVoice(10, 1, 0)]);
assert.equal(pack.lanes.length, 1);                              // 偏好行真的空 → 尊重
assert.equal(pack.lanes[0].items.length, 2);
assert.equal(pack.overflow, 0);
pack = packVoiceLanes([mkVoice(0, 5, 0), mkVoice(0, 5, 0)]);
assert.deepEqual(pack.lanes.map(l => l.items.length), [1, 1]);   // 偏好行放不下 → 第一个空行
pack = packVoiceLanes([mkVoice(0, 1, 3)]);
assert.equal(pack.lanes.length, 4);                              // 偏好行在更远处 → 行号留出来
assert.equal(pack.lanes[3].items.length, 1);
pack = packVoiceLanes([mkVoice(0, 5), mkVoice(0, 5), mkVoice(0, 5)], { maxLanes: 2 });
assert.equal(pack.overflow, 1);                                  // 超行报数，不静默丢
pack = packVoiceLanes([mkVoice(3, 1), mkVoice(0, 2)]);
assert.deepEqual(pack.lanes[0].items.map(x => x.start), [0, 3]); // 行内按 start 排（不重叠才同行）

const mkCap = (start, end) => ({ id: 'c' + start, text: 'x', start, end });
const capPack = packCaptionLanes([mkCap(0, 2), mkCap(1, 3), mkCap(2.5, 4), mkCap(3.5, 5)]);
assert.equal(capPack.lanes.length, 2);                            // 后一段在前一段结束后才换行
assert.deepEqual(capPack.lanes[0].items.map(c => c.start), [0, 2.5]);
assert.deepEqual(capPack.lanes[1].items.map(c => c.start), [1, 3.5]);
assert.equal(packCaptionLanes([mkCap(0, 2), mkCap(0.5, 1), mkCap(0.2, 3)], 1).overflow, 2);

const v0 = mkVoice(0, 5, 0), v1 = mkVoice(0, 5, 0);
const vMap = voiceLaneMap({ voices: [v0, v1], pending: [createPending({ start: 6 })] });
assert.equal(vMap.get(v0.id), 0);
assert.equal(vMap.get(v1.id), 1);                                // 重叠的两条分两行
const capMap = captionLaneMap({ captions: [mkCap(0, 2), mkCap(1, 3)] });
assert.deepEqual([...capMap.values()], [0, 1]);
assert.equal(laneOfItem([{ id: 'a', start: 0, duration: 2 }, { id: 'b', start: 0, duration: 2 }], 'b'), 1);   // 重叠 → 分行
assert.equal(laneOfItem([{ id: 'a', start: 0, duration: 1 }, { id: 'b', start: 2, duration: 1 }], 'b'), 0);   // 不重叠 → 同行
assert.equal(laneOfItem([{ id: 'a', start: 0, duration: 1 }], 'nope'), -1);

/* ---------- 行级眼睛 / 锁 ---------- */
assert.equal(rowVisible(null, 'voice'), true);          // 没记 = 可见
assert.equal(rowVisible({ visibility: { voice: false } }, 'voice'), false);
assert.equal(rowLocked(null, 'voice'), false);
assert.equal(rowLocked({ locks: { voice: true } }, 'voice'), true);
const t0 = { visibility: {}, locks: {} };
rowSet(t0, 'visibility', 'voice', false);
assert.deepEqual(t0, { visibility: { voice: false }, locks: {} });
rowSet(t0, 'lock', 'image', true);
assert.deepEqual(t0.locks, { image: true });
rowSet(t0, 'visibility', 'voice', null);                // null = 摘掉（回默认可见）
assert.deepEqual(t0.visibility, {});

/* 条目两道闸：整轨 + 行级（`voice-N`） */
const tv = { visibility: { 'voice-1': false }, locks: { caption: true } };
assert.equal(itemVisible(tv, 'voice', 0), true);
assert.equal(itemVisible(tv, 'voice', 1), false);
assert.equal(itemVisible({ visibility: { voice: false } }, 'voice', 0), false);   // 整轨盖过行
assert.equal(itemVisible(tv, 'voice', null), true);      // lane 未知只看整轨
assert.equal(itemLocked(tv, 'caption', 0), true);        // 整轨锁
assert.equal(itemLocked(tv, 'voice', 0), false);
const tl2 = { locks: { 'caption-0': true } };
assert.equal(itemLocked(tl2, 'caption', 0), true);
assert.equal(itemLocked(tl2, 'caption', 1), false);

/* ---------- 字幕外观 ---------- */
assert.equal(captionPosition({ position: 'top' }), 'top');
assert.equal(captionPosition({ position: 'nope' }), 'bottom');
assert.equal(captionPosition(null), 'bottom');
assert.deepEqual(captionPositions(), ['top', 'middle', 'bottom']);
assert.equal(captionHighlighted({ style: 'default' }), true);
assert.equal(captionHighlighted({ style: 'plain' }), false);
assert.equal(captionHighlighted({}), false);
assert.equal(captionStyleOf(true), 'default');
assert.equal(captionStyleOf(false), 'plain');

/* ---------- 进成片的两道闸 ---------- */
const gv1 = { ...mkVoice(0, 5, 0), id: 'gv1', src: '/1' };
const gv2 = { ...mkVoice(0, 5, 0), id: 'gv2', src: '/2' };
const gv3 = { id: 'gv3', start: 9, duration: 1 };                       // 没字节
const gateFilm = { voices: [gv1, gv2, gv3], pending: [], tracks: { visibility: { 'voice-1': false } } };
let aud = audibleVoices(gateFilm);
assert.deepEqual(aud.list.map(v => v.id), ['gv1']);
assert.deepEqual(aud.skipped, { hidden: 1, noSrc: 1 });
aud = audibleVoices(null);
assert.deepEqual(aud, { list: [], skipped: { hidden: 0, noSrc: 0 } });

const gc1 = { id: 'gc1', text: '一句', start: 0, end: 2 };
const gc2 = { id: 'gc2', text: '两句', start: 1, end: 3 };
const gc3 = { id: 'gc3', text: '   ', start: 5, end: 7 };               // 空文
const gc4 = { id: 'gc4', text: '零长', start: 6, end: 6 };               // 零长窗
let vis = visibleCaptions({ captions: [gc1, gc2, gc3, gc4], tracks: { visibility: { 'caption-1': false } } });
assert.deepEqual(vis.list.map(c => c.id), ['gc1']);
assert.deepEqual(vis.skipped, { hidden: 1, empty: 2 });
vis = visibleCaptions(null);
assert.deepEqual(vis, { list: [], skipped: { hidden: 0, empty: 0 } });

/* ---------- 台词行 ---------- */
const lib = [{ name: '小明', anchor: '/a.png' }, { name: '小红', face: '/b.png' }];
assert.deepEqual(speakerOf('小明', lib), { name: '小明', img: '/a.png', inLib: true, empty: false });
assert.equal(speakerOf('小红', lib).img, '/b.png');
assert.equal(speakerOf('路人', lib).inLib, false);
assert.equal(speakerOf('路人', lib).name, '路人');                        // 名字原样带回，不吞
assert.deepEqual(speakerOf('', lib), { name: '', img: '', inLib: false, empty: true });
assert.deepEqual(speakerOf('  ', lib).empty, true);

assert.equal(lineTimeOf({ start: 1.5, duration: 2 }).whenText, '成片 1.5–3.5 秒');
assert.equal(lineTimeOf({}).whenText, '成片 —');
assert.equal(lineTimeOf(null).whenText, '成片 —');

const escId = s => String(s == null ? '' : s).replace(/"/g, '&quot;');
const rowBase = { id: 'r1', sh: sh1, no: '3', who: '小明', text: '你好', pending: true, mine: true,
  speaker: speakerOf('小明', lib), time: lineTimeOf({ start: 1, duration: 2 }) };
const html = lineRowHTML(rowBase, { esc: escId, icon: () => '<i-u>', mediaSrc: x => x });
assert.match(html, /data-lineid="r1"/);
assert.match(html, /class="line-row edit on"/);                          // mine 点亮
assert.match(html, /<em class="pend">待生成<\/em>/);
assert.match(html, /data-line-who="r1"/);
assert.match(html, /data-line-text="r1"/);
assert.match(html, /<img src="\/a\.png"/);                               // 素材库头像
assert.match(html, /成片 1–3 秒/);                                       // 行内时间读数
const htmlEmpty = lineRowHTML({ ...rowBase, no: '', text: '  ', pending: false, mine: false,
  speaker: speakerOf('路人', lib), time: lineTimeOf({}) },
  { esc: escId, icon: () => '<i-u>', mediaSrc: x => x });
assert.match(htmlEmpty, /<em class="none">未写<\/em>/);
assert.match(htmlEmpty, /不在素材库/);
assert.match(htmlEmpty, /lr-ph/);                                        // 占位头像
assert.match(htmlEmpty, /全片/);                                          // no 缺省 → 全片

/* ---------- 小工具 ---------- */
assert.equal(estimateSpeechSeconds(''), 1.2);                            // 下限
assert.equal(estimateSpeechSeconds('x'.repeat(45)), 10);                 // 45 ÷ 4.5
assert.equal(estimateSpeechSeconds('x'.repeat(4)), 1.2);                 // 不足下限

assert.deepEqual(shiftTimed({ start: 1, duration: 2 }, 1.5), { start: 2.5, duration: 2 });
assert.equal(shiftTimed({ start: 1, duration: 2 }, -3).start, 0);        // 夹 0
assert.deepEqual(shiftTimed({ start: 1, end: 3 }, -3), { start: 0, end: 0.2 });  // 字幕尾有最短长
assert.deepEqual(shiftTimed({ start: 2, end: 5 }, -1), { start: 1, end: 4 });

assert.deepEqual(windowOf({ start: 1, duration: 2 }), { start: 1, end: 3 });
assert.equal(coversTime({ start: 1, duration: 2 }, 0.9996), true);       // 半毫秒容差
assert.equal(coversTime({ start: 1, duration: 2 }, 0.999), false);
assert.equal(coversTime({ start: 1, duration: 2 }, 2.9994), true);       // 尾沿留半毫秒
assert.equal(coversTime({ start: 1, duration: 2 }, 3), false);

assert.equal(gainOf({ volume: 2 }), 2);
assert.equal(gainOf({ volume: 9 }), 4);
assert.equal(gainOf({}), 1);

assert.equal(fadeGain({ duration: 10, fadeIn: 2, fadeOut: 4 }, 1), 0.5);
assert.equal(fadeGain({ duration: 10, fadeIn: 2, fadeOut: 4 }, 2), 1);
assert.equal(fadeGain({ duration: 10, fadeIn: 2, fadeOut: 4 }, 8), 0.5);
assert.equal(fadeGain({ duration: 10, fadeIn: 2, fadeOut: 4 }, 6), 1);
assert.equal(fadeGain({ duration: 2, fadeIn: 3 }, 0.5), 0.5);            // fade 夹到时长一半
assert.equal(fadeGain({ duration: 2, fadeOut: 1 }, 2), 0);

/* ---------- 标记（film.js 借它规整数组，一并钉住形状） ---------- */
assert.deepEqual(normalizeMarkers([{ time: 1 }]).map(m => m.type), ['marker']);
assert.equal(normalizeMarkers('x').length, 0);
assert.equal(markerClock(3723.5), '01:02:03.500');
assert.deepEqual(markerSnapPoints([{ id: 'm1', time: 2 }, { id: 'm2', time: 3, type: 'range', endTime: 5 }]),
  [{ time: 2, kind: 'marker', id: 'm1' }, { time: 3, kind: 'marker', id: 'm2' }, { time: 5, kind: 'marker', id: 'm2' }]);
assert.deepEqual(markerCounts([{ type: 'range' }, { type: 'range' }, null]),
  { marker: 0, chapter: 0, range: 2, note: 0, total: 2 });

console.log('✓ 导演台成片模型：顺序真相 / 折算 / 转场窗 / 行打包 / 行眼与锁 / 进片闸 / 台词行 / 标记');
