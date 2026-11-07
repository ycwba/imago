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
const { createLocalAssetsStore, portableIdOfName, portableFallbackName } = require('../server/local-assets-store.js');
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
  /* 「盘上已有字节 → 只补索引」：这一份判据装的是真存储层，不用假件。 */
  adoptBodyByHint: store.adoptBodyByHint,
  rebindBodies: store.rebindBodies,
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
/* base64 直传那一路（POST /local-assets）：任务卡 / 语音 / 成片走的就是它。 */
const postRaw = spec => new Promise((resolve, reject) => {
  BODY = Buffer.from(JSON.stringify(spec));
  const res = {
    code: 0,
    writeHead(c) { this.code = c; },
    end(s) { let json = null; try { json = JSON.parse(String(s)); } catch (e) {} resolve({ code: this.code, json, text: String(s) }); },
  };
  Promise.resolve(routes.handleLocalAssets({ method: 'POST', url: '/local-assets' }, res, { pathname: '/local-assets' }))
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

  /* ⑦ 可移植身份：文件名带着 la_ 号一起走 —— 新机器只拷视频文件、不搬索引时，
     磁盘对账 / `/asset/<旧号>` 都能按名把**原来那一枚号**复原，不用重新导入素材。 */
  ok('文件名尾标认得出本机号（含撞名 -2）',
    portableIdOfName('视频/场景01-镜头03__la_ab12cd.mp4') === 'la_ab12cd'
    && portableIdOfName('场景01-镜头03__la_ab12cd-2.mp4') === 'la_ab12cd'
    && portableIdOfName('la_legacy.mp4') === 'la_legacy'
    && portableIdOfName('用户自己的一段.mp4') === '', '');
  const B_PORT = bytesOf(71);
  const place = store.newBodyPlace({ name: '换机器要认回.png', id: 'la_portable1', format: 'png', mime: 'image/png' });
  ok('新落盘的文件名带 __<本机号>', portableIdOfName(place.file) === 'la_portable1', place.file);
  fs.writeFileSync(place.abs, B_PORT);
  store.invalidateScan();

  /* 「另一台机器」：同一个库根，账本整个是空的。 */
  const mkFresh = sub => {
    const d = path.join(tmp, sub);
    fs.mkdirSync(path.join(d, 'local-assets'), { recursive: true });
    return createLocalAssetsStore({
      MIME, dataDirPath: () => d, log: () => {}, spawnSync: () => {},
      localRoot: () => assets, fileSafe: s => String(s || 'x'),
    });
  };
  const fresh = mkFresh('data-fresh');
  const byOldId = String(fresh.localAssetFile('la_portable1') || '');
  ok('账全空、只留文件时，`/asset/<旧号>` 一问就按名认回同一枚号',
    !!byOldId && fs.existsSync(byOldId) && fs.readFileSync(byOldId).equals(B_PORT), byOldId);
  ok('补建出来的那一行用的就是旧号', !!(fresh.localIndexRead().find(x => x && x.id === 'la_portable1')), '');
  const adopted = mkFresh('data-adopted');
  adopted.localAdopt(true);
  const adoptedRow = adopted.localIndexRead().find(x => x && x.id === 'la_portable1');
  ok('启动磁盘对账也复原旧号（不重新铸号）', !!adoptedRow && fs.existsSync(path.join(assets, adoptedRow.file)),
    adoptedRow && adoptedRow.file);
  ok('同一枚号不会补出第二张卡', adopted.localIndexRead().filter(x => x && x.id === 'la_portable1').length === 1, '');

  /* ⑧ 老文件（没有尾标、还被改过名）：项目文件带的线索照样把旧号认回盘上那一份。 */
  const B_OLD = bytesOf(72);
  fs.writeFileSync(path.join(assets, '图片', '被用户改过名的旧素材.png'), B_OLD);
  const rb = fresh.rebindBodies([{ id: 'la_from_old_pc', name: '旧机器那段.png',
    file: path.join('图片', '被用户改过名的旧素材.png'), bytes: B_OLD.length,
    format: 'png', assetId: 'asset_old_pc', taskId: 'job_old_pc',
    upstream: 'https://cdn.example.com/results/old_pc.png?sig=1' }]);
  ok('重绑回执给回旧号那一行', rb.bound === 1 && rb.rows[0] && rb.rows[0].id === 'la_from_old_pc',
    JSON.stringify(rb));
  ok('重绑只写账、不复制字节', bodies().filter(p => /被用户改过名的旧素材/.test(p)).length === 1, '');
  ok('按旧号就取得到字节', fs.existsSync(String(fresh.localAssetFile('la_from_old_pc'))), '');
  const oldRow = fresh.localIndexRead().find(x => x && x.id === 'la_from_old_pc');
  ok('平台身份一并补进账', oldRow && oldRow.assetId === 'asset_old_pc' && /old_pc\.png/.test(String(oldRow.upstream)),
    JSON.stringify(oldRow && { assetId: oldRow.assetId, upstream: oldRow.upstream }));
  ok('重绑端点同一批线索（走路由那层也算）', (() => {
    const r = fresh.rebindBodies([{ id: 'la_from_old_pc', name: '旧机器那段.png' }]);
    return r.bound === 1 && r.rows[0].id === 'la_from_old_pc';
  })(), '');

  /* ⑨ 「盘上已经有这份字节 → 只补索引、零下载」：from-url 在取字节之前按规范名认盘。 */
  const B_RECOG = bytesOf(73);
  const recName = '盘上早就有的那一段__la_recog9.png';
  fs.writeFileSync(path.join(assets, '图片', recName), B_RECOG);
  store.invalidateScan();                       // 真实写盘会作废快照；探针手动写也一样
  const fetchedBefore = fetched.length;
  const r5 = await post({ url: 'https://cdn.example.com/results/recog9.png', name: '盘上早就有的那一段.png',
    mime: 'image/png', format: 'png',
    meta: { upstream: 'https://cdn.example.com/results/recog9.png', provider: 'sparkcine',
      /* 字节数是认盘的必带线索之一：只给名字不给大小会把「同一镜头重做的那一版」认成旧的。 */
      byteLength: B_RECOG.length,
      detail: { asset: 'asset_recog9', task: 'job_recog9' } } });
  ok('按规范名认回：回 200 且判成盘上复用', r5.code === 200 && r5.json && r5.json.recognized === true
    && r5.json.reused === true, r5.code + ' ' + r5.text.slice(0, 200));
  ok('一个字节都没下载（downloadTo 探针没被问到）', fetched.length === fetchedBefore,
    '多取了 ' + (fetched.length - fetchedBefore) + ' 次');
  ok('回的是文件名里那一枚号', r5.json && r5.json.id === 'la_recog9', r5.json && r5.json.id);
  const recRow = rowOf('la_recog9');
  ok('平台身份补写进账、落点没动', recRow && recRow.detail && recRow.detail.asset === 'asset_recog9'
    && /la_recog9/.test(String(recRow.file)), JSON.stringify(recRow && { file: recRow.file, detail: recRow.detail }));
  ok('没有多落一份字节', bodies().filter(p => /盘上早就有的那一段/.test(p)).length === 1, '');

  /* ⑨b 只给规范名、不给字节数时**不许**认：同一个镜头重做一次候选，名字一样而内容不同，
     凭名字认就会把上一版当成这一版（界面显示旧片，新的那份永远不下）。 */
  const B_RE = bytesOf(77);
  fs.writeFileSync(path.join(assets, '图片', '重做候选__la_redo1.png'), B_RE);
  store.invalidateScan();
  const noSize = store.adoptBodyByHint({ name: '重做候选.png', format: 'png',
    upstream: 'https://cdn.example.com/results/redo1.png', requirePortable: true });
  ok('只给名字不给字节数：不认盘', noSize === null, JSON.stringify(noSize && noSize.row));
  const withSize = store.adoptBodyByHint({ name: '重做候选.png', format: 'png', bytes: B_RE.length,
    upstream: 'https://cdn.example.com/results/redo1.png', requirePortable: true });
  ok('名字 + 字节数两条线索齐了才认', !!withSize && withSize.row.id === 'la_redo1',
    JSON.stringify(withSize && withSize.row));

  /* ⑩ 只认库根：账里指到库根外面的那一条按「不在这里」处理 —— 既不报「本机有」，
     也不顺着它去读盘。用户口径：只查设置里选的那一个目录，不翻机器上其它地方。 */
  const outsideDir = path.join(tmp, 'outside-root');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, '库根外面这一份.png');
  const B_OUT = bytesOf(74);
  fs.writeFileSync(outsideFile, B_OUT);
  fresh.localIndexUpsert({ id: 'la_outside', file: outsideFile, name: '库根外面这一份.png',
    format: 'png', mime: 'image/png', byte_length: B_OUT.length, media_type: '图片',
    created_at: new Date().toISOString(), provider: 'local' });
  ok('库根外面的账行取不到字节', String(fresh.localAssetFile('la_outside') || '') === '', '');
  ok('别名表不把它报成「本机有」', !fresh.localAliases().rows.some(x => x && x.id === 'la_outside'), '');
  const rbOut = fresh.rebindBodies([{ id: 'la_outside2', file: outsideFile,
    name: '库根外面这一份.png', bytes: B_OUT.length }]);
  ok('重绑线索指到库根外面也不认', rbOut.bound === 0, JSON.stringify(rbOut.rows));

  /* ⑪ base64 直传（任务卡 / 语音 / 成片）：盘上已经有同一份字节时只补索引、不再落第二份。
     判据是内容而不是名字 —— 同名同大小、字节不同的是两份作品，不许吞掉新的一份。 */
  const B_POST = bytesOf(75);
  fs.writeFileSync(path.join(assets, '图片', '以前存过的同一份.png'), B_POST);
  store.invalidateScan();
  const r6 = await postRaw({ name: '任务卡产物.png', mime: 'image/png', format: 'png',
    data: B_POST.toString('base64'), meta: { prompt: '同一份字节' } });
  ok('直传先按内容认盘：回 200 且判成盘上复用', r6.code === 200 && r6.json && r6.json.recognized === true
    && r6.json.reused === true, r6.code + ' ' + r6.text.slice(0, 200));
  ok('没有再落第二份字节', bodies().filter(p => /以前存过的同一份|任务卡产物/.test(p)).length === 1,
    bodies().filter(p => /以前存过的同一份|任务卡产物/.test(p)).join(' | '));
  ok('认回来的那条落点就是盘上那一份', r6.json && /以前存过的同一份\.png$/.test(String(r6.json.file)),
    r6.json && r6.json.file);

  const B_OTHER = bytesOf(76);                       // 同长度、不同内容
  const r7 = await postRaw({ name: '以前存过的同一份.png', mime: 'image/png', format: 'png',
    data: B_OTHER.toString('base64'), meta: {} });
  ok('同名同长度但字节不同：认不出，照常落新的一份', r7.code === 200 && !r7.json.recognized
    && bodies().filter(p => /以前存过的同一份/.test(p)).length === 2,
    r7.code + ' ' + bodies().filter(p => /以前存过的同一份/.test(p)).join(' | '));

  /* ⑫ 同来源的账行还在、文件却没了（用户手删 / 盘满只剩账）：不许回 reused 假成功 ——
     以前这里直接返回 /asset/<id>，前端拿到一个 404 而且再也不会重下。
     重下一份，**沿用原号**，旧工程里的地址继续有效。 */
  const B_GONE = bytesOf(77);
  BY_URL.set(UP_B, B_GONE);
  const goneSpec = { url: UP_B, name: '文件被删了的那一段.png', mime: 'image/png', format: 'png',
    meta: { upstream: UP_B, detail: { asset: 'asset_gone', task: 'job_gone' } } };
  const r8 = await post(goneSpec);
  const id8 = r8.json && r8.json.id;
  const file8 = id8 ? path.join(assets, String(rowOf(id8).file)) : '';
  ok('先存了一份（打底）', r8.code === 200 && !!id8 && fs.existsSync(file8), r8.text.slice(0, 200));
  fs.unlinkSync(file8);
  store.invalidateScan();
  const r9 = await post(goneSpec);
  ok('文件没了不许回 reused', r9.code === 200 && r9.json && r9.json.reused !== true
    && r9.json.id === id8, r9.code + ' ' + r9.text.slice(0, 200));
  ok('字节按原号补回来了', fs.existsSync(path.join(assets, String(rowOf(id8).file))), String(rowOf(id8).file));
  ok('还是一条账，没有同号两份', store.localIndexRead().filter(x => x && x.id === id8).length === 1, '');
  ok('来源身份没丢', rowOf(id8).upstream === UP_B && rowOf(id8).detail && rowOf(id8).detail.asset === 'asset_gone', '');

  /* ⑬ 按号补建（/asset/<旧号> 那一问）：同号旧行要保住 upstream，别拿新对象把它盖掉；
     文件已经归给另一条账时只挂别名，绝不开第二条账指向同一份文件。 */
  store.localIndexUpsert({ id: 'la_keep1', file: '图片/早就不在了.png', name: '早就不在了.png',
    mime: 'image/png', format: 'png', byte_length: 1, upstream: 'https://keep.example.com/a.png?sig=1',
    detail: { asset: 'asset_keep' }, provider: 'sparkcine' });
  const keepBytes = bytesOf(78);
  fs.writeFileSync(path.join(assets, '图片', '保留来源__la_keep1.png'), keepBytes);
  store.invalidateScan();
  const kept = store.localAssetRepair('la_keep1');
  ok('同号旧行被认回', !!kept && kept.id === 'la_keep1', JSON.stringify(kept && kept.id));
  ok('旧行的来源外链没被抹掉', kept && kept.upstream === 'https://keep.example.com/a.png?sig=1', kept && kept.upstream);
  ok('落点换成了盘上这一份', kept && /保留来源__la_keep1\.png$/.test(String(kept.file)), kept && kept.file);

  const conflictFile = '图片/别人的作品__la_conflict.png';
  fs.writeFileSync(path.join(assets, conflictFile), bytesOf(79));
  store.localIndexUpsert({ id: 'la_owner_row', file: conflictFile, name: '别人的作品.png',
    mime: 'image/png', format: 'png', byte_length: 3, upstream: '', provider: 'local' });
  store.invalidateScan();
  const rowsBefore = store.localIndexRead().length;
  const conflict = store.localAssetRepair('la_conflict');
  ok('同一份文件不补第二条账', store.localIndexRead().length === rowsBefore, rowsBefore + ' → ' + store.localIndexRead().length);
  ok('旧号挂成别名指回已有那一行', !!conflict && conflict.id === 'la_owner_row'
    && Array.isArray(conflict.aliasIds) && conflict.aliasIds.includes('la_conflict'),
    JSON.stringify(conflict && { id: conflict.id, aliasIds: conflict.aliasIds }));

  /* ⑭ 999 个同名之后的兜底文件名：时间戳必须插在可移植尾标前面，
     否则 portableIdOfName 认不出这一枚号，换机器时这份文件永远对不上原号。 */
  const fb = portableFallbackName('片段__la_abc123.mp4', 'k3j4h5');
  ok('兜底名保住可移植尾标', fb === '片段-k3j4h5__la_abc123.mp4', fb);
  ok('兜底名仍认得出原号', portableIdOfName(fb) === 'la_abc123', portableIdOfName(fb));
  ok('没有尾标的兜底名照旧加戳', portableFallbackName('片段.mp4', 'k3j4h5') === '片段-k3j4h5.mp4', '');

  /* ⑮ 重绑超过单次上限时把尾巴如实报出来（以前 total 报的是截断后的数，用户看不出还有没认回的）。 */
  const tmp2 = path.join(tmp, 'cap');
  const assets2 = path.join(tmp2, 'assets');
  const data2 = path.join(tmp2, 'data');
  fs.mkdirSync(path.join(assets2, '图片'), { recursive: true });
  fs.mkdirSync(path.join(data2, 'local-assets'), { recursive: true });
  const capped = createLocalAssetsStore({
    MIME, dataDirPath: () => data2, log: () => {}, spawnSync: () => {},
    localRoot: () => assets2, fileSafe: s => String(s || 'x'), rebindMax: 1,
  });
  fs.writeFileSync(path.join(assets2, '图片', '第一条__la_cap1.png'), bytesOf(81));
  fs.writeFileSync(path.join(assets2, '图片', '第二条__la_cap2.png'), bytesOf(82));
  capped.invalidateScan();
  const capOut = capped.rebindBodies([
    { id: 'la_cap1', name: '第一条.png', bytes: bytesOf(81).length },
    { id: 'la_cap2', name: '第二条.png', bytes: bytesOf(82).length },
  ]);
  ok('超过上限：total 报请求条数', capOut.total === 2, JSON.stringify(capOut.total));
  ok('超过上限：omitted 报没处理的尾巴', capOut.omitted === 1 && capOut.bound === 1, JSON.stringify(capOut));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.log('判据自己炸了：' + ((e && e.stack) || e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
