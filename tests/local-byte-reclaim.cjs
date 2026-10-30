#!/usr/bin/env node
/* 「字节明明在盘上、卡片却加载不出来」的按字节认回判据（常驻，不启实例、不碰用户目录）。
   跑法：`node tests/local-byte-reclaim.cjs`。

   实况：磁盘对账给「账里没有的成品」补建的那一族裸行没有来源地址、也没有平台号，
   于是 /asset/<平台产物号> 与按来源地址反查都指不到它 —— 字节在库根里躺着，界面判成「没存过」。
   这一条装真源码（createLocalAssetsStore + routes/local-assets.js 那一路），
   目录指到系统临时目录，取字节换成探针 downloadTo（交已知内容，不出站）。
   判的是路由里那一段判据本身：签名对上就把身份补写到已有那一行，而不是再落一份字节。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalAssetsStore } = require('../server/local-assets-store.js');
const { createLocalAssets } = require('../server/routes/local-assets.js');
const { safeOutboundUrl } = require('../server/security.js');

let bad = 0, n = 0;
const ok = (name, cond, detail) => {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
};

const MIME = { '.png': 'image/png' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-byte-reclaim-probe-'));
const assets = path.join(tmp, 'assets');
const data = path.join(tmp, 'data');
fs.mkdirSync(path.join(assets, '图片'), { recursive: true });
fs.mkdirSync(path.join(data, 'local-assets'), { recursive: true });

/* 一枚真实像素 PNG 打底，尾字节当内容区分 —— 三条产物是三份不同的字节，签名才分得开。 */
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bytesOf = t => Buffer.concat([PNG1, Buffer.from([t])]);
const B_A = bytesOf(1), B_B = bytesOf(2), B_C = bytesOf(3);

const store = createLocalAssetsStore({
  MIME, dataDirPath: () => data, log: () => {}, spawnSync: () => {},
  localRoot: () => assets, fileSafe: s => String(s || 'x'),
});

/* 出站取字节换成探针：按地址查这张表，地址不在表里就是「这条判据没打算取它」。 */
const BY_URL = new Map();
const fetched = [];
const extInUrl = u => {
  try { const p = new URL(String(u), 'http://x').pathname; return (/\.([a-z0-9]{1,6})$/i.exec(p) || [])[1] || ''; }
  catch { return ''; }
};
const extOfMime = m => {
  const want = String(m || '').split(';')[0].trim().toLowerCase();
  return Object.keys(MIME).find(ext => String(MIME[ext]).split(';')[0].trim().toLowerCase() === want)?.slice(1) || '';
};

const routes = createLocalAssets({
  readBody: () => Promise.resolve(BODY),
  log: () => {},
  resolveSrc: async u => String(u),
  downloadTo: async (u, out) => {
    const b = BY_URL.get(String(u));
    if (!b) throw new Error('探针没这一条地址：' + u);
    fetched.push(String(u));
    fs.writeFileSync(out, b);
    return b.length;
  },
  keyOf: () => '',
  assetStore: null,
  safeOutboundUrl,
  safeDecode: s => { try { return decodeURIComponent(s); } catch (e) { return s; } },
  localUpKey: store.localUpKey,
  extInUrl, extOfMime,
  withLocalSaveLock: (k, fn) => fn(),
  localIndexRead: store.localIndexRead,
  localIndexUpsert: store.localIndexUpsert,
  localIndexUpdate: store.localIndexUpdate,
  localIndexPut: store.localIndexPut,
  localFillMissing: store.localFillMissing,
  localAssetSiblings: store.localAssetSiblings,
  localIndexDrop: store.localIndexDrop,
  whyNoSpace: store.whyNoSpace,
  localAssetFile: store.localAssetFile,
  localAssetPaths: store.localAssetPaths,
  localMediaType: store.localMediaType,
  localAssetWhen: store.localAssetWhen,
  localFileFromEntry: store.localFileFromEntry,
  localSigOf: store.localSigOf,
  fileFidOf: store.fileFidOf,
  newBodyPlace: store.newBodyPlace,
  bodyDirOf: store.bodyDirOf,
  bodyDirNameOf: store.bodyDirNameOf,
  mintAssetId: store.mintAssetId,
  localAdopt: store.localAdopt,
  invalidateScan: store.invalidateScan,
  localRootDir: () => assets,
  MIME,
});

let BODY = Buffer.from('{}');
/* handleLocalAssets 里那条 readBody().then() 不由返回值 await，所以收口在 res.end 上。 */
const post = spec => new Promise((resolve, reject) => {
  BODY = Buffer.from(JSON.stringify(spec));
  const res = {
    code: 0,
    writeHead(c) { this.code = c; },
    end(s) { let json = null; try { json = JSON.parse(String(s)); } catch (e) {} resolve({ code: this.code, json, text: String(s) }); },
  };
  Promise.resolve(routes.handleLocalAssets({ method: 'POST', url: '/local-assets/from-url' }, res, { pathname: '/local-assets/from-url' }))
    .catch(reject);
});

const rowOf = id => store.localIndexRead().find(x => x && x.id === id);
const bodies = () => {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(assets);
  return out;
};

const UP_A = 'https://cdn.example.com/results/out_a.png?Expires=1793188433&Signature=old';
const UP_B = 'https://cdn.example.com/results/out_b.png?Expires=1&Signature=x';
const UP_C = 'https://cdn.example.com/results/out_c.png?Expires=1&Signature=x';

(async () => {
  /* ① 先把现实搭出来：盘上有一份字节、账里只有一条「磁盘对账补的裸行」（没有来源地址、没有平台号）。 */
  fs.writeFileSync(path.join(assets, '图片', '本机那一份.png'), B_A);
  store.localAdopt(true);
  const bare = store.localIndexRead().find(x => x && x.adopted === true);
  ok('磁盘对账补出一条裸行', !!bare && !String(bare.upstream || '').trim() && !bare.detail, JSON.stringify(bare && { id: bare.id, upstream: bare.upstream, detail: bare.detail }));
  ok('裸行带得上采样签名（按字节认回靠它）', bare && /^\d+:[0-9a-f]{16}$/.test(String(bare.sig)), bare && bare.sig);
  ok('按平台产物号查不到它 —— 这就是「文件在盘上却加载不出来」',
    store.localEntryByPlatformId('asset_81575') === null && store.localEntryByUpstream(UP_A) === null, '');

  /* ② 用户在那张坏卡上点一次「存回本机」：字节取回来、签名对上 → 身份补写到已有那一行。 */
  BY_URL.set(UP_A, B_A);
  const r1 = await post({ url: UP_A, name: '开场镜头.png', mime: 'image/png', format: 'png',
    meta: { upstream: UP_A, provider: 'sparkcine', prompt: '帮我重新设计首页', detail: { asset: 'asset_81575', task: 'job_81575' } } });
  ok('回 200 且判成复用', r1.code === 200 && r1.json && r1.json.reused === true, r1.code + ' ' + r1.text.slice(0, 200));
  ok('交回的还是原来那一条账（不新开号）', r1.json && r1.json.id === bare.id && r1.json.url === '/asset/' + bare.id,
    JSON.stringify(r1.json && { id: r1.json.id, url: r1.json.url }));
  ok('库根里还是那一份字节（没有第二份副本）', bodies().length === 1, JSON.stringify(bodies().map(p => path.basename(p))));
  ok('没留 .tmp', bodies().every(p => !/\.tmp-/.test(p)), '');
  const row = rowOf(bare.id);
  ok('来源地址补写进账', row && row.upstream === UP_A, row && JSON.stringify(row.upstream));
  ok('平台产物号与任务号补写进账', row && row.detail && row.detail.asset === 'asset_81575' && row.detail.task === 'job_81575',
    JSON.stringify(row && row.detail));
  ok('提示词补进账（缺的才补，已有非空值不覆盖）', row && row.prompt === '帮我重新设计首页', row && JSON.stringify(row.prompt));
  ok('归属仍记磁盘对账那一家（认回只补身份，不改谁生的）', row && row.provider === 'local', row && JSON.stringify(row.provider));
  ok('认回不动落点（file 还是那一个）', row && row.file === bare.file && /^图片[\\/]/.test(String(row.file)), row && row.file);

  /* ③ 认回之后地址层必须真的能指到字节：这是「卡片从破图变回图」那一步。 */
  const byAid = store.localEntryByPlatformId('asset_81575');
  ok('按平台产物号现在认得出本机那一份', byAid && byAid.ent.id === bare.id && fs.existsSync(byAid.file),
    JSON.stringify(byAid && byAid.ent.id));
  ok('签名参数换了也算同一个来源', (() => {
    const e = store.localEntryByUpstream(UP_A.replace('Signature=old', 'Signature=brand-new'));
    return !!e && e.ent.id === bare.id;
  })(), '');

  /* ④ 同一来源再点一次：upKey 那一档先命中，一个字节都不必再取。 */
  const before = fetched.length;
  const r2 = await post({ url: UP_A, name: '开场镜头.png', mime: 'image/png', format: 'png',
    meta: { upstream: UP_A, provider: 'sparkcine', detail: { asset: 'asset_81575' } } });
  ok('重复点同一来源不再取字节、不再落盘', r2.json && r2.json.reused === true && r2.json.id === bare.id && fetched.length === before,
    'fetched 多了 ' + (fetched.length - before));

  /* ⑤ 内容不同的那一条不许并进来：该新开一条账、该多落一份字节。 */
  BY_URL.set(UP_B, B_B);
  const r3 = await post({ url: UP_B, name: '另一份.png', mime: 'image/png', format: 'png',
    meta: { upstream: UP_B, provider: 'sparkcine', detail: { asset: 'asset_other', task: 'job_other' } } });
  ok('字节不同就正常新开一条', r3.json && !r3.json.reused && r3.json.id !== bare.id, JSON.stringify(r3.json && { id: r3.json.id, reused: r3.json.reused }));
  ok('库里两份字节各归各', bodies().length === 2, JSON.stringify(bodies().map(p => path.basename(p))));

  /* ⑥ 已经有平台号的那一行不许被盖掉：同内容的另一份产物不是同一件事，接错比不接更糟。 */
  fs.writeFileSync(path.join(assets, '图片', '别人才是这一份.png'), B_C);
  store.invalidateScan();
  store.localAdopt(true);
  const owned = store.localIndexRead().find(x => x && String(x.file || '').includes('别人才是这一份'));
  ok('又补出一条同内容参照行', !!owned && owned.adopted === true, '');
  store.localIndexUpsert(Object.assign({}, owned, { detail: { asset: 'asset_belongs_to_other' } }));
  BY_URL.set(UP_C, B_C);
  const r4 = await post({ url: UP_C, name: '我这一份.png', mime: 'image/png', format: 'png',
    meta: { upstream: UP_C, provider: 'sparkcine', detail: { asset: 'asset_mine' } } });
  const stillOwned = rowOf(owned.id);
  ok('带平台号的那一行没被换身份', stillOwned && stillOwned.detail.asset === 'asset_belongs_to_other' && !String(stillOwned.upstream || '').trim(),
    JSON.stringify(stillOwned && { asset: stillOwned.detail && stillOwned.detail.asset, upstream: stillOwned.upstream }));
  ok('这一份另开新账（不并到别人那张卡上）', r4.json && r4.json.id !== owned.id && !!rowOf(r4.json.id), JSON.stringify(r4.json && r4.json.id));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.log('判据自己炸了：' + ((e && e.stack) || e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
