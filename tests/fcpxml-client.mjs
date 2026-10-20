#!/usr/bin/env node
/* FCPXML 模块行为：给定一条带倍速与配音的时间线，真的生成 XML。
   把 window 上的三个小工具换成桩，Net.save 接住 Blob，不联网、不花钱。 */
import assert from 'node:assert/strict';
import { exportFCPXML } from '../web/director/fcpxml.js';

let saved = null, status = '';
globalThis.window = {
  fileSafe: (s, n) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').slice(0, n || 60),
  fileStamp: () => '20261018-120000',
  Api: {
    sysStatus: async () => ({ 目录: { 资产: { 路径: 'C:/work/assets' } } }),
    assetSrc: id => '/asset/' + encodeURIComponent(id) + '?v=2',
  },
  AssetLocal: { ready: async () => {}, localFileOf: () => null },
  Net: {
    save: async (blob, name) => { saved = { blob, name }; },
    blob: async () => new Blob(['PK\u0003\u0004zip'], { type: 'application/zip' }),
  },
};
const cand = { vid: 'c1', name: '镜一', format: 'mp4', status: 'done' };
const voices = [
  { shotId: 's1', candId: 'c1', seg: 0, src: '/asset/la_voice?dl=1', at: 0, dur: 1, off: 0, text: '第一句', spd: 1 },
];
const proj = { name: '测试片', voices };
const ctx = {
  proj,
  tlSyncFromShots: () => ({ clips: [
    { shotId: 's1', candId: 'c1', name: '镜一', in: 0, out: 2, speed: 2, seg: 0 },
    { shotId: 's1', candId: 'c1', name: '黑场', gray: true, in: 0, out: 1, speed: 1, seg: 1 },
  ] }),
  healStaleUrls: async () => 0,
  filmSize: () => ({ w: 1920, h: 1080 }),
  setStatus: s => { status = s; },
  el: () => ({ disabled: false }),
  tlClipDur: c => c.gray ? 1 : 1,
  tlClipSrc: async () => '/asset/la_pic?dl=1',
  allShots: () => [{ id: 's1', candidates: [cand] }],
  tlCandidateOf: () => cand,
  candDur: () => 2,
  voicesEnsure: () => proj.voices,
  voiceVolOf: () => 1,
  AssetLocal: window.AssetLocal,
  Api: window.Api,
  Net: window.Net,
};
await exportFCPXML(ctx, { bundle: false });
assert.ok(saved && saved.blob && /\.fcpxml$/.test(saved.name), '应落一份 .fcpxml');
const xml = await saved.blob.text();
assert.ok(/<timeMap>/.test(xml), '倍速要写成 timeMap');
assert.ok(/lane="-/.test(xml), '配音要挂在 lane 上');
assert.ok(/<gap /.test(xml), '黑场要写成 gap');
assert.ok(/file:\/\/\/C:\/work\/assets\/la_pic/.test(xml), '本机素材要写真实文件路径');
assert.ok(/C:\/work\/assets\/la_voice/.test(xml), '配音也要走本机文件');
assert.ok(/已导出 FCPXML/.test(status), '状态栏要说话');

const before = saved;
await exportFCPXML(ctx, { bundle: true });
assert.notEqual(saved, before, '媒体包也要落盘');
assert.ok(/媒体包/.test(saved.name), '媒体包文件名要对');
assert.ok(/已导出媒体包/.test(status), '状态栏要说媒体包');
console.log('✓ FCPXML 模块：倍速 / 配音 lane / 黑场 gap / 本机路径 / 两档导出');
