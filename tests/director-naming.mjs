#!/usr/bin/env node
/* 导演台素材命名（web/director/naming.js）：场景 + 镜头是唯一底座，
   本机索引名、另存文件名、FCPXML 媒体包名都从这里出。
   这里钉四件事：序号补零与空名回落、截断吃不掉后缀、扩展名恰好一个、撞名插序号。 */
import assert from 'node:assert/strict';
import { sceneShotBase, candidateBase, voiceBase, clipLabel,
  stripExt, withExt, uniqueName, shotCtxOf, candidateIndex, voiceIndex } from '../web/director/naming.js';

/* 浏览器里 safe() 直接用 ui.js 的 fileSafe；Node 单测没有它，这里补一份同规则的桩，
   让「非法字符被洗掉、后缀仍在」这条也能在这里判。 */
globalThis.window = { fileSafe: (s, max) => String(s == null ? '' : s)
  .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, max || 80) };

const ctx = { sceneIndex: 0, sceneName: '雨夜街头', shotIndex: 2, shotName: '推门' };
assert.equal(sceneShotBase(ctx), '场景01-雨夜街头_镜头03-推门');
assert.equal(candidateBase(ctx, 2), '场景01-雨夜街头_镜头03-推门_候选2');
assert.equal(voiceBase(ctx, 1), '场景01-雨夜街头_镜头03-推门_配音1');
assert.equal(clipLabel(ctx, 1), '场景01 雨夜街头 · 镜头03 推门 · 片段1');
assert.equal(sceneShotBase({ sceneIndex: 1, shotIndex: 0 }), '场景02_镜头01',
  '空名只留序号，不凭空造「未命名」');
assert.equal(sceneShotBase({ sceneIndex: 9, shotName: 'A' }), '场景10_镜头01-A',
  '序号补零两位、超过 9 原样');

/* 场景名与镜头名各自截 24 字；候选 / 配音后缀不能被截断吃掉。 */
const long = '甲'.repeat(40), longShot = '乙'.repeat(40);
const bean = sceneShotBase({ sceneIndex: 0, sceneName: long, shotIndex: 0, shotName: longShot, tag: '候选3' });
assert.ok(bean.endsWith('_候选3'), '长名截断后后缀还在：' + bean);
assert.ok(!bean.includes('甲'.repeat(25)) && !bean.includes('乙'.repeat(25)), '场景 / 镜头名各自先截 24 字');
assert.equal((bean.match(/候选3/g) || []).length, 1, '后缀只出现一次');

/* 非法字符归 fileSafe：路径分隔符不能把名字拆成两层目录。 */
const dirty = sceneShotBase({ sceneIndex: 0, sceneName: '雨/夜:街*道', shotIndex: 0, shotName: '推?门' });
assert.ok(!/[\\/:*?"<>|]/.test(dirty), '非法字符必须被洗掉：' + dirty);
assert.ok(dirty.includes('雨-夜-街-道'), '洗字符不吞内容：' + dirty);

/* 扩展名：只认最后一个、大小写归一、空 base 有回落。 */
assert.equal(stripExt('foo.mp4'), 'foo');
assert.equal(stripExt('a.b.c'), 'a.b');
assert.equal(stripExt('abc'), 'abc');
assert.equal(stripExt('.env'), '.env');
assert.equal(withExt('foo.mp4', 'MP4'), 'foo.mp4', '带扩展名的 base 不再拼成 .mp4.mp4');
assert.equal(withExt('foo.mp4', 'wav'), 'foo.wav');
assert.equal(withExt('foo', ''), 'foo');
assert.equal(withExt('', 'wav'), '素材.wav');
assert.equal(withExt('foo.tar.gz', 'gz'), 'foo.tar.gz', '多段扩展名只换最后一段');

/* 撞名插在扩展名之前，且同一个 Set 连续调用不重样。 */
const used = new Set();
assert.equal(uniqueName('场景01_镜头01_候选1', 'mp4', used), '场景01_镜头01_候选1.mp4');
assert.equal(uniqueName('场景01_镜头01_候选1.mp4', 'mp4', used), '场景01_镜头01_候选1-2.mp4');
assert.equal(uniqueName('场景01_镜头01_候选1', 'mp4', used), '场景01_镜头01_候选1-3.mp4');
assert.equal(uniqueName('x', 'wav', new Set(['x.wav', 'x-2.wav'])), 'x-3.wav');

/* 镜头位置：跨场景按工程顺序找，找不到返回 null；候选 / 配音序号从 1 起。 */
const s1 = { id: 's1', name: '推门', candidates: [{ id: 'c1' }, { id: 'c2' }] };
const s2 = { id: 's2', name: '回头', candidates: [] };
const proj = { scenes: [{ name: '雨夜街头', shots: [s1] }, { name: '清晨', shots: [s2] }], voices: [{ id: 'v1' }, { id: 'v2' }] };
const at = shotCtxOf(proj, s2);
assert.deepEqual([at.sceneIndex, at.shotIndex, at.sceneName, at.shotName], [1, 0, '清晨', '回头']);
assert.equal(shotCtxOf(proj, { id: 'nope' }), null, '找不到不许编一个序号');
assert.equal(candidateIndex(s1, s1.candidates[1]), 2);
assert.equal(candidateIndex(s1, { id: 'nope' }), 1, '索引里没有就按第一条算');
assert.equal(voiceIndex(proj, proj.voices[1]), 2);

console.log('✓ 导演台命名：场景/镜头补零与空名回落、各自截断且后缀保留、扩展名恰好一个、撞名插序号、跨场景定位');
