#!/usr/bin/env node
/* FCPXML 模块行为：给定一条带倍速与配音的时间线，真的生成 XML。
   把 window 上的三个小工具换成桩，Net.save 接住 Blob，不联网、不花钱。
   另外钉「本机索引名 = 媒体包文件名 = <asset name>」：同一份素材多段复用只进包一次，
   扩展名恰好一个，片段显示名带场景与镜头。 */
import assert from 'node:assert/strict';
import { buildFCPXML, exportFCPXML } from '../web/director/fcpxml.js';

let saved = null, status = '';
const localFiles = {
  '/asset/la_pic?dl=1': { id: 'la_pic', format: 'mp4', name: '场景01-雨夜街头_镜头01-推门_候选1.mp4' },
  '/asset/la_voice?dl=1': { id: 'la_voice', format: 'wav', name: '场景01-雨夜街头_镜头01-推门_配音1.wav' },
  '/asset/la_still?dl=1': { id: 'la_still', format: 'png', name: '封面.png' },
};
const AssetLocal = {
  ready: async () => {},
  localFileOf: u => localFiles[String(u || '')] || null,
};
globalThis.window = {
  fileSafe: (s, n) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').slice(0, n || 60),
  pad2: n => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(2, '0'),
  fileStamp: () => '20261018-120000',
  Api: {
    sysStatus: async () => ({ 目录: { 资产: { 路径: 'C:/work/assets' } } }),
    assetSrc: id => '/asset/' + encodeURIComponent(id) + '?v=2',
  },
  AssetLocal,
  /* 导出侧只认 `{ src }` 这一种形状：图片段与画面段走同一个「本机优先」解析口。 */
  EditorMedia: { exportSrc: o => String((o && o.src) || '') },
  Net: {
    save: async (blob, name) => { saved = { blob, name }; },
    blob: async () => new Blob(['PK\u0003\u0004zip'], { type: 'application/zip' }),
  },
};
const cand = { vid: 'c1', name: '镜一', format: 'mp4', status: 'done' };
const shot = { id: 's1', name: '推门', candidates: [cand] };
const voices = [
  { shotId: 's1', candId: 'c1', seg: 0, src: '/asset/la_voice?dl=1', at: 0, dur: 1, off: 0, text: '第一句', spd: 1 },
  /* 黑场那一段上的配音：走 grayVoices 分支（那里的倍速要先算再判 row.ref）。 */
  { shotId: 's1', candId: 'c1', seg: 1, src: '/asset/la_voice?dl=1', at: 0, dur: 1, off: 0, text: '黑场里那句', spd: 1 },
];
const proj = { name: '测试片', scenes: [{ name: '雨夜街头', shots: [shot] }], voices };
const ctx = {
  proj,
  tlSyncFromShots: () => ({ clips: [
    { shotId: 's1', candId: 'c1', name: '镜一', in: 0, out: 2, speed: 2, seg: 0 },
    /* 同一份画面再出现一段：素材只该进包一次，XML 两段引用同一个 media/<名>。 */
    { shotId: 's1', candId: 'c1', name: '镜一', in: 0, out: 1, speed: 1, seg: 2 },
    { shotId: 's1', candId: 'c1', name: '黑场', gray: true, in: 0, out: 1, speed: 1, seg: 1 },
    /* 图片段：`in/out` 是虚拟坐标（不在源视频的秒数上），XML 里只能写成 still。 */
    { shotId: 's1', candId: 'c1', name: '图片', img: '/asset/la_still?dl=1', imgName: '封面', in: 2.1, out: 4.1, speed: 1, seg: 3 },
  ] }),
  healStaleUrls: async () => 0,
  filmSize: () => ({ w: 1920, h: 1080 }),
  setStatus: s => { status = s; },
  el: () => ({ disabled: false }),
  tlClipDur: c => Math.max(0.1, ((Number(c.out) || 0) - (Number(c.in) || 0)) / (Number(c.speed) || 1)),
  tlClipSrc: async () => '/asset/la_pic?dl=1',
  allShots: () => [shot],
  tlCandidateOf: () => cand,
  candDur: () => 2,
  voicesEnsure: () => proj.voices,
  voiceVolOf: () => 1,
  AssetLocal,
  Api: window.Api,
  Net: window.Net,
};

/* ---------- 拼装（媒体包）：名字与去重 ---------- */
const built = await buildFCPXML(ctx, { bundle: true });
assert.equal(built.ok, true);
const videoName = '场景01-雨夜街头_镜头01-推门_候选1.mp4';
const voiceName = '场景01-雨夜街头_镜头01-推门_配音1.wav';
const stillName = '封面.png';
assert.equal(built.bundleAssets.length, 3, '画面两段复用 + 一句配音 + 一张图 = 三份素材，不能重复进包');
assert.deepEqual(built.bundleAssets.map(a => a.name).sort(), [voiceName, videoName, stillName].sort());
assert.ok(!/\.(mp4|wav|png)\.(mp4|wav|png)/.test(built.xml), '不能出现双扩展名');
assert.ok(new RegExp('<asset id="r2" name="' + videoName + '"').test(built.xml),
  '本机索引名要原样进 <asset name>：' + videoName);
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(videoName) + '"'),
  '媒体包里的 media-rep 要与 asset name 同一个文件名');
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(voiceName) + '"'), '配音同样同源');
assert.ok(built.xml.includes('name="场景01 雨夜街头 · 镜头01 推门 · 片段1"'), '片段名要带场景与镜头');
assert.ok(built.xml.includes('name="场景01 雨夜街头 · 镜头01 推门 · 片段3"'), '片段序号按 seg 现算');
assert.equal(built.missing.length, 0, '本机都能找到文件就不该报缺失');
assert.equal((built.xml.match(/ref="r2"/g) || []).length >= 2, true, '两段画面引用同一个 asset');

/* ---------- 图片段：写成 still，不是一段「有入出点的视频」 ---------- */
const stillClip = (built.xml.match(/<asset-clip ref="r\d+" name="封面"[^>]*>[\s\S]*?<\/asset-clip>/) || [])[0] || '';
assert.ok(stillClip, '图片段要写成一条 asset-clip');
assert.ok(/ start="0s"/.test(stillClip), 'still 的起点恒为 0（段里的虚拟坐标不进 XML）');
assert.ok(/ duration="60\/30s"/.test(stillClip), '图片段的时长按框算：2 秒');
assert.ok(!/<timeMap>/.test(stillClip), 'still 没有倍速，不能写 timeMap');
const stillRef = (stillClip.match(/ref="(r\d+)"/) || [])[1];
const stillAsset = (built.xml.match(new RegExp('<asset id="' + stillRef + '"[^>]*>')) || [])[0] || '';
assert.ok(/ name="封面\.png"/.test(stillAsset), '静态图的本机索引名要进 asset name');
assert.ok(/ hasVideo="1"/.test(stillAsset) && !/hasAudio/.test(stillAsset), '静态图只有视频轨属性');
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(stillName) + '"'), '媒体包里的图片路径与 asset name 同源');
assert.ok(built.bundleAssets.some(a => a.name === stillName && /la_still/.test(a.src)), '图片也要真的进媒体包');

/* 黑场上的配音：gap 挂不了子元素，写成独立 asset-clip（倍速与 row.ref 的判定顺序在这里钉住）。 */
assert.equal(built.grayVoices.length, 1, '压在黑场上的那句配音要单独记一条');
assert.ok(built.xml.includes('lane="1"'), '黑场上的配音挂在主轨上方');
assert.ok(built.xml.includes('name="黑场里那句"'), '黑场上的那句配音要进 XML');

/* ---------- 下载两档：单文件写真实路径，媒体包写相对路径 ---------- */
await exportFCPXML(ctx, { bundle: false });
assert.ok(saved && saved.blob && /\.fcpxml$/.test(saved.name), '应落一份 .fcpxml');
const xml = await saved.blob.text();
assert.ok(/<timeMap>/.test(xml), '倍速要写成 timeMap');
assert.ok(/lane="-/.test(xml), '配音要挂在 lane 上');
assert.ok(/<gap /.test(xml), '黑场要写成 gap');
assert.ok(/file:\/\/\/C:\/work\/assets\/la_pic\.mp4/.test(xml), '单文件仍指向本机真实文件');
assert.ok(/C:\/work\/assets\/la_voice\.wav/.test(xml), '配音也要走本机文件');
assert.ok(/file:\/\/\/C:\/work\/assets\/la_still\.png/.test(xml), '图片也走本机真实文件（导出始终本机优先）');
assert.ok(xml.includes('name="' + videoName + '"'), '单文件的 <asset name> 仍是同一个可读名');
assert.ok(/<asset [^>]*name="封面\.png"[^>]*hasVideo="1"/.test(xml), '单文件里静态图的 asset 属性与媒体包一致');
assert.ok(!xml.includes('src="media/'), '单文件不写相对 media/ 路径');
assert.ok(/已导出 FCPXML/.test(status), '状态栏要说话');

const before = saved;
await exportFCPXML(ctx, { bundle: true });
assert.notEqual(saved, before, '媒体包也要落盘');
assert.ok(/媒体包/.test(saved.name), '媒体包文件名要对');
assert.ok(/已导出媒体包/.test(status), '状态栏要说媒体包');
console.log('✓ FCPXML 模块：倍速 / 配音 lane / 黑场 gap / 图片 still / 本机路径 / 两档导出；场景镜头名与媒体包名一致、复用素材只进包一次');
