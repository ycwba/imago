#!/usr/bin/env node
/* 「云端那份没了、本机还存着」的地址层判据（常驻，不启实例、不碰用户目录）。
   跑法：`node tests/local-fallback.cjs`。

   实况：平台把资产清掉 / 签名外链过期之后，界面上一张写着「本机+云端」的卡变成破图 ——
   浏览器那份镜像索引（按源分家）认不出这条外链，而代理账里明明记着「这个来源地址的字节就在库根」。
   所以地址层要能只凭代理这一份账把地址换成 /asset/<本机号>，不依赖页面索引。
   这条判据装真源码（createLocalAssetsStore + createMediaSrc），只把目录指到系统临时目录。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalAssetsStore } = require('../server/local-assets-store.js');
const { createMediaSrc } = require('../server/media-src.js');

let bad = 0, n = 0;
const ok = (name, cond, detail) => {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-fallback-probe-'));
const assets = path.join(tmp, 'assets');
const data = path.join(tmp, 'data');
fs.mkdirSync(path.join(assets, '图片'), { recursive: true });
fs.mkdirSync(path.join(data, 'local-assets'), { recursive: true });

const store = createLocalAssetsStore({
  MIME: { '.png': 'image/png' },
  dataDirPath: () => data,
  log: () => {},
  spawnSync: () => {},
  localRoot: () => assets,
  fileSafe: s => String(s || 'x'),
});

const UP = 'https://cdn.example.com/results/asset_a.png?Expires=1793188433&Signature=old';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(assets, '图片', '本机那一份.png'), PNG);

store.localIndexUpsert({
  id: 'la_probe', file: '图片\\本机那一份.png', name: '本机那一份.png',
  mime: 'image/png', format: 'png', byte_length: PNG.length,
  created_at: new Date().toISOString(), media_type: '图片',
  provider: 'sparkcine', prompt: '', model: '', upstream: UP,
  detail: { asset: 'asset_probe_1', task: 'job_probe_1' },
});

/* ① 来源地址：签名参数变了、地址没变，就算同一份 */
const up2 = UP.replace('Signature=old', 'Signature=brand-new');
const byUp = store.localEntryByUpstream(up2);
ok('按来源地址认回本机那一份（签名不参与身份）', byUp && byUp.ent.id === 'la_probe', JSON.stringify(byUp && byUp.ent.id));
ok('交出来的是盘上真实存在的那个文件', !!(byUp && fs.existsSync(byUp.file)), byUp && byUp.file);

/* ② 平台产物号 / 唯一的任务号 */
const byAid = store.localEntryByPlatformId('asset_probe_1');
ok('按平台产物号认回本机那一份', byAid && byAid.ent.id === 'la_probe', JSON.stringify(byAid && byAid.ent.id));
const byJob = store.localEntryByPlatformId('job_probe_1');
ok('这个任务只出一份时按任务号也认得出', byJob && byJob.ent.id === 'la_probe', JSON.stringify(byJob && byJob.ent.id));
ok('不存在的号交白卷（不猜）', store.localEntryByPlatformId('asset_nope') === null && store.localEntryByUpstream('https://elsewhere.example.com/x.png') === null, '');

/* ③ 多产物任务：同任务号第二条进来之后，按任务号不再认（多图会指到同一个文件） */
fs.writeFileSync(path.join(assets, '图片', '第二份.png'), PNG);
store.localIndexUpsert({
  id: 'la_probe2', file: '图片\\第二份.png', name: '第二份.png',
  mime: 'image/png', format: 'png', byte_length: PNG.length,
  created_at: new Date().toISOString(), media_type: '图片',
  provider: 'sparkcine', prompt: '', model: '', upstream: '',
  detail: { asset: 'asset_probe_2', task: 'job_probe_1' },
});
ok('同任务出两份之后按任务号不认（多图任务会指错文件）', store.localEntryByPlatformId('job_probe_1') === null, '');
ok('按产物号仍然各认各的',
  store.localEntryByPlatformId('asset_probe_1').ent.id === 'la_probe'
  && store.localEntryByPlatformId('asset_probe_2').ent.id === 'la_probe2', '');

/* ④ 地址层：FCPXML 打包 / ASR / 补存走的 resolveSrc 也先问本机账 */
const mediaSrc = createMediaSrc({
  assetStore: null, upRequest: () => { throw new Error('这条判据不该出站'); }, cacheSweep: null,
  guardOutboundUrl: async u => u, anyRequest: () => { throw new Error('这条判据不该出站'); },
  keyOf: () => '', localAssetFile: store.localAssetFile,
  localEntryByUpstream: store.localEntryByUpstream, localEntryByPlatformId: store.localEntryByPlatformId,
  PORT: 5175, SESSION_COOKIE: 'wb_session', SESSION_TOKEN: 'probe',
  safeDecode: s => { try { return decodeURIComponent(s); } catch (e) { return s; } }, log: () => {},
});

(async () => {
  const want = 'http://127.0.0.1:5175/asset/la_probe';
  const r1 = await mediaSrc.resolveSrc('/getv?url=' + encodeURIComponent(up2));
  ok('resolveSrc(/getv?url=<过期外链>) 交本机地址', r1 === want, r1);
  const r2 = await mediaSrc.resolveSrc('/fetch?url=' + encodeURIComponent(UP) + '&dl=1');
  ok('resolveSrc(/fetch?url=<过期外链>) 交本机地址', r2 === want, r2);
  const r3 = await mediaSrc.resolveSrc(UP);
  ok('resolveSrc(<外链本身>) 交本机地址', r3 === want, r3);
  const r4 = await mediaSrc.resolveSrc('/asset/asset_probe_1');
  ok('resolveSrc(/asset/<平台产物号>) 交本机地址', r4 === want, r4);

  /* ⑤ 账变了反查表必须跟着变：新镜像一条之后立刻按它的来源地址查得到 */
  const up3 = 'https://cdn.example.com/results/asset_c.png?Expires=1&Signature=x';
  fs.writeFileSync(path.join(assets, '图片', '第三份.png'), PNG);
  store.localIndexUpsert({
    id: 'la_probe3', file: '图片\\第三份.png', name: '第三份.png',
    mime: 'image/png', format: 'png', byte_length: PNG.length,
    created_at: new Date().toISOString(), media_type: '图片',
    provider: 'sparkcine', prompt: '', model: '', upstream: up3,
  });
  const byUp3 = store.localEntryByUpstream(up3);
  ok('新写进账的那一条马上查得到（反查表跟着账的版本走）', byUp3 && byUp3.ent.id === 'la_probe3', JSON.stringify(byUp3 && byUp3.ent.id));

  /* ⑥ 文件被用户删了：不许拿一条「文件已不在」的账冒充本机副本 */
  fs.unlinkSync(path.join(assets, '图片', '本机那一份.png'));
  ok('文件没了就不再冒充本机副本',
    store.localEntryByUpstream(up2) === null && store.localEntryByPlatformId('asset_probe_1') === null, '');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.log('判据自己炸了：' + ((e && e.stack) || e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
