#!/usr/bin/env node
/* 本机优先 / 云端那套身份判据的常驻回归（不启浏览器、不碰真实数据）。
   跑法：`node tests/local-first.cjs`。

   要点：同一份产物在四种形状里必须算出同一个身份 ——
     ① 平台列表（带产物号 / 只带任务号 / 只有来源地址）
     ② 本机资产库那一行（la_xxx，detail 里可能只有任务号）
     ③ 镜像索引（浏览器那份 sk_local_mirror 丢过之后按本机列表认回来）
     ④ 收藏 / 工作区里存着的旧地址
   这条判据只有 web/domain/local.js 的 mirrorOf 一处；测试直接装真源码，不复制实现。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
let bad = 0, n = 0;
function ok(name, cond, detail) { n++; if (cond) { console.log('  ✓ ' + name); return; } bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }

function boot(opts) {
  const o = opts || {};
  const store = new Map(Object.entries(o.prefs || {}));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    get length() { return store.size; },
    key: i => [...store.keys()][i],
  };
  if (o.index) localStorage.setItem('sk_local_mirror', JSON.stringify(o.index));
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: cb => setTimeout(cb, 0),
    Promise, JSON, Math, Date, Number, String, Object, Array, Map, Set, WeakMap, URL, URLSearchParams,
    encodeURIComponent, decodeURIComponent, isFinite, RegExp, Error, localStorage, sessionStorage: localStorage,
    location: { href: 'http://localhost:5175/shell.html' },
    navigator: { userAgent: 'node' },
    document: {
      hidden: false, addEventListener() {}, removeEventListener() {},
      createElement() { return { style: {}, dataset: {}, appendChild() {}, setAttribute() {} }; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    },
    fetch: () => Promise.reject(new Error('no net')),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Blob: class {}, FileReader: class {},
    CustomEvent: class { constructor(t, x) { this.type = t; this.detail = x && x.detail; } },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.dispatchEvent = () => {};
  ctx.URL.revokeObjectURL = () => {}; ctx.URL.createObjectURL = () => 'blob:x';
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/ident.cjs'), 'utf8'), ctx, { filename: 'web/domain/ident.cjs' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/api.js'), 'utf8'), ctx, { filename: 'web/domain/api.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/assetlib.js'), 'utf8'), ctx, { filename: 'web/domain/assetlib.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/local.js'), 'utf8'), ctx, { filename: 'web/domain/local.js' });
  return { ctx, store, AL: ctx.AssetLocal, Lib: ctx.AssetLib, localStorage };
}

const UP = 'https://cdn.example.com/results/a.mp4?Expires=1790000000&Signature=abc';
const IDX = {
  v: 1,
  m: {
    'sparkcine|a:asset_one': { a: 'la_one', f: 'png', n: '', t: 0, b: 100, up: '', p: 'asset_one', g: 'job_single' },
    'sparkcine|g:job_multi': { a: 'la_multi_a', f: 'png', n: '', t: 0, b: 200, up: '', g: 'job_multi' },
    'vgenv|u:cdn.example.com/results/a.mp4': { a: 'la_up', f: 'mp4', n: '', t: 0, b: 300, up: UP },
  },
  a: {
    la_one: 'sparkcine|a:asset_one',
    la_multi_a: 'sparkcine|g:job_multi',
    la_up: 'vgenv|u:cdn.example.com/results/a.mp4',
  },
};

/* ① 平台产物号一路：preferLocal 开 → 地址换本机；关 → 退回平台，但「两边都有」不变 */
{
  const { AL } = boot({ index: IDX });
  const e = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_one', genId: 'job_single', src: '/asset/asset_one?v=2' };
  AL.decorate(e, { allowGen: false });
  ok('按产物号认回本机镜像', e.mirrorKey === 'sparkcine|a:asset_one' && e.mirror && e.mirror.a === 'la_one', JSON.stringify(e.mirrorKey));
  ok('优先用本机时地址换成本机文件', e.src === '/asset/la_one?v=2', e.src);
  const st = AL.stateOf(e);
  ok('平台 + 本机副本 → both', st.state === 'both' && st.local && st.cloud, JSON.stringify(st));

  const b = boot({ index: IDX, prefs: { sk_media_prefer: 'off' } });
  const e2 = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_one', genId: 'job_single', src: '/asset/asset_one?v=2' };
  b.AL.decorate(e2, { allowGen: false });
  ok('关掉「优先用本机」后地址退回平台', e2.src === '/asset/asset_one?v=2', e2.src);
  ok('关掉开关不影响身份：仍然 both', b.AL.stateOf(e2).state === 'both', JSON.stringify(b.AL.stateOf(e2)));
}

/* ② 老镜像只留了任务号：单产物任务允许按任务号认；多产物任务绝不认 */
{
  const { AL } = boot({ index: IDX });
  const one = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new', genId: 'job_multi', outCount: 1, src: '/asset/asset_new?v=2' };
  AL.decorate(one, { allowGen: true });
  ok('单产物任务按任务号认回老镜像', one.mirrorKey === 'sparkcine|g:job_multi' && one.localAsset === true, JSON.stringify(one.mirrorKey));
  const four = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new', genId: 'job_multi', outCount: 4, src: '/asset/asset_new?v=2' };
  AL.decorate(four, { allowGen: false });
  ok('多产物任务不按任务号合（不冒充本机）', !four.mirrorKey && AL.stateOf(four).state === 'cloud', JSON.stringify(AL.stateOf(four)));
}

/* ③ 来源地址一路：签名换了仍认得出 */
{
  const { AL } = boot({ index: IDX });
  const e = { kind: 'asset', provider: 'vgenv', id: 'job_x', src: '/getv?url=' + encodeURIComponent(UP), rawSrc: UP.replace('abc', 'zzz') };
  AL.decorate(e, { allowGen: false });
  ok('签名参数变了也按来源认回本机', e.mirrorKey && e.mirror.a === 'la_up', JSON.stringify(e.mirrorKey));
  ok('来源路的本机地址可反查', AL.localAssetIdOf('/asset/la_up?v=2') === 'la_up', AL.localAssetIdOf('/asset/la_up?v=2'));
}

/* ④ 本机列表认回：detail.asset 逐份落盘；多图任务里第二份不会再被吞掉 */
{
  const { AL } = boot({ index: { v: 1, m: {}, a: {} } });
  AL.learn({ id: 'la_new_1', provider: 'sparkcine', format: 'png', byte_length: 10, upstream: '', detail: { asset: 'asset_a', task: 'job_z' } });
  AL.learn({ id: 'la_new_2', provider: 'sparkcine', format: 'png', byte_length: 20, upstream: '', detail: { asset: 'asset_b', task: 'job_z' } });
  const recA = AL.mirrorKeyOf({ kind: 'asset', provider: 'sparkcine', assetId: 'asset_a', genId: 'job_z' });
  const recB = AL.mirrorKeyOf({ kind: 'asset', provider: 'sparkcine', assetId: 'asset_b', genId: 'job_z' });
  ok('多图任务两份产物各有各的身份', recA === 'sparkcine|a:asset_a' && recB === 'sparkcine|a:asset_b', recA + ' / ' + recB);
  ok('第二份也认得出本机号', AL.localAssetIdOf('/asset/la_new_2?v=2') === 'la_new_2', AL.localAssetIdOf('/asset/la_new_2?v=2'));
  const e = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_b', genId: 'job_z', src: '/asset/asset_b?v=2' };
  AL.decorate(e, { allowGen: false });
  ok('平台第二份对应到本机第二份', e.mirror && e.mirror.a === 'la_new_2', JSON.stringify(e.mirror));
}

/* ⑤ 老数据：同一个任务号下第二份本机文件不再被吞掉（各自落到 |f:） */
{
  const { AL } = boot({ index: { v: 1, m: {}, a: {} } });
  AL.learn({ id: 'la_old_1', provider: 'sparkcine', format: 'png', byte_length: 210, upstream: '', detail: { task: 'job_multi' } });
  AL.learn({ id: 'la_old_2', provider: 'sparkcine', format: 'png', byte_length: 220, upstream: '', detail: { task: 'job_multi' } });
  const k1 = AL.mirrorKeyOf({ kind: 'asset', provider: 'sparkcine', assetId: 'la_old_1', genId: 'la_old_1' });
  const k2 = AL.mirrorKeyOf({ kind: 'asset', provider: 'sparkcine', assetId: 'la_old_2', genId: 'la_old_2' });
  ok('同任务第二条本机文件有自己的键', k2 === 'sparkcine|f:la_old_2', String(k2));
  ok('第一条仍占着任务号那条记录', k1 === 'sparkcine|g:job_multi', String(k1));
  ok('两条都能按本机地址反查', AL.localAssetIdOf('/asset/la_old_2?v=2') === 'la_old_2', AL.localAssetIdOf('/asset/la_old_2?v=2'));
}

/* ⑥ 自产素材（MiMo 语音）：只有本机一份，不能因为 provider 有 id 就标成「本机+云端」 */
{
  const { AL } = boot({ index: { v: 1, m: {}, a: {} } });
  const e = { kind: 'asset', provider: 'mimo', assetId: 'la_voice', genId: 'la_voice', src: '/asset/la_voice?v=2', localAsset: true };
  AL.decorate(e);
  const st = AL.stateOf(e);
  ok('本机自产 → local（不是 both）', st.state === 'local' && st.local && !st.cloud, JSON.stringify(st));
  const t = { kind: 'task', provider: 'sparkcine', id: 'job_1', genId: 'job_1', status: 'running' };
  ok('在跑的任务 → cloud', AL.stateOf(t).state === 'cloud', JSON.stringify(AL.stateOf(t)));
}

/* ⑦ 删掉本机副本之后：地址退回平台、标记摘掉、不再被当成「本机」 */
{
  const { AL } = boot({ index: IDX });
  const e = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_one', genId: 'job_single', src: '/asset/la_one?v=2', platSrc: '/asset/asset_one?v=2', localAsset: true, mirrorKey: 'sparkcine|a:asset_one' };
  AL.forgetMirror(e);
  AL.decorate(e, { allowGen: false });
  ok('删掉本机副本后地址退回平台', e.src === '/asset/asset_one?v=2', e.src);
  ok('删掉本机副本后不再标「本机」', !e.localAsset && !e.mirrorKey && AL.stateOf(e).state === 'cloud', JSON.stringify(AL.stateOf(e)));
}

/* ⑧ 整表：单产物任务平台那条 + 本机那一条合成一张；多产物不合 */
{
  const { AL, Lib } = boot({ index: IDX });
  const platform = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new', genId: 'job_multi', outCount: 1, src: '/asset/asset_new?v=2', prompt: '' };
  const localRow = { kind: 'asset', provider: 'sparkcine', assetId: 'la_multi_a', id: 'la_multi_a', genId: 'la_multi_a', src: '/asset/la_multi_a?v=2', localAsset: true, prompt: '本机留底的那句提示词' };
  const merged = Lib.settleEntries([platform, localRow]);
  ok('单产物任务合成一张卡', merged.length === 1, 'len=' + merged.length + ' ' + JSON.stringify(merged.map(x => x.assetId)));
  ok('合成时保留平台那条、补上本机提示词', merged[0].assetId === 'asset_new' && merged[0].prompt === '本机留底的那句提示词', JSON.stringify(merged[0]));
  ok('合成后是 both', AL.stateOf(merged[0]).state === 'both', JSON.stringify(AL.stateOf(merged[0])));

  const p4 = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new4', genId: 'job_multi4', outCount: 4, src: '/asset/asset_new4?v=2' };
  const l4 = { kind: 'asset', provider: 'sparkcine', assetId: 'la_multi_4a', id: 'la_multi_4a', genId: 'la_multi_4a', src: '/asset/la_multi_4a?v=2', localAsset: true };
  const merged4 = Lib.settleEntries([p4, l4]);
  ok('多产物任务不硬合', merged4.length === 2, 'len=' + merged4.length);
}

/* ⑨ 「不显示云端任务」：有本机副本的不藏；只有平台地址的藏；在跑的不藏 */
{
  const { AL } = boot({ index: IDX, prefs: { sk_media_cloud_hide: '1', sk_media_local: 'on', sk_media_prefer: 'on' } });
  ok('本机优先三个开关都开时 localOnly 为真', AL.localOnly() === true);
  const both = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_one', genId: 'job_single', src: '/asset/la_one?v=2' };
  AL.decorate(both, { allowGen: false });
  ok('有本机副本的不藏', AL.hideAsCloud(both) === false);
  const cloud = { kind: 'asset', provider: 'vgenv', assetId: 'asset_x', genId: 'job_x', src: '/asset/asset_x?v=2' };
  ok('只有平台地址的藏', AL.hideAsCloud(cloud) === true);
  const run = { kind: 'task', provider: 'sparkcine', id: 'job_q', genId: 'job_q', status: 'running' };
  ok('在跑的不藏', AL.hideAsCloud(run) === false);
}

/* ⑩ 镜像索引满上限时裁的是最老那一头：插入序是旧 → 新，
   以前 `keys.slice(IDX_MAX)` 删尾部，等于新产物刚写进去就被裁掉。 */
(async () => {
  const { AL } = boot({ index: { v: 1, m: {}, a: {} } });
  const N = 20010;                       // IDX_MAX = 20000：多塞 10 条，看被裁的是哪一头
  for (let i = 0; i < N; i++) {
    AL.learn({ id: 'la_t' + i, provider: 'probe', format: 'png', byte_length: 10,
      upstream: '', detail: { asset: 'asset_t' + i } });
  }
  await new Promise(r => setTimeout(r, 30));      // 落盘在微任务里合并执行
  const kOld = AL.mirrorKeyOf({ kind: 'asset', provider: 'probe', assetId: 'asset_t0' });
  const kEdge = AL.mirrorKeyOf({ kind: 'asset', provider: 'probe', assetId: 'asset_t9' });
  const kKeep = AL.mirrorKeyOf({ kind: 'asset', provider: 'probe', assetId: 'asset_t10' });
  const kNew = AL.mirrorKeyOf({ kind: 'asset', provider: 'probe', assetId: 'asset_t' + (N - 1) });
  ok('超上限裁掉最老的 10 条', kOld === '' && kEdge === '', kOld + ' / ' + kEdge);
  ok('上限边上那条仍在', kKeep === 'probe|a:asset_t10', String(kKeep));
  ok('刚写入的最新一条仍在', kNew === 'probe|a:asset_t' + (N - 1), String(kNew));
  const localOld = AL.mirrorKeyOf({ kind: 'asset', provider: 'probe', id: 'la_t0', assetId: 'la_t0', src: '/asset/la_t0?v=2' });
  const localNew = AL.mirrorKeyOf({ kind: 'asset', provider: 'probe', id: 'la_t' + (N - 1), assetId: 'la_t' + (N - 1), src: '/asset/la_t' + (N - 1) + '?v=2' });
  ok('裁掉的那些本机号也从反查表里消失', localOld === '' && localNew === 'probe|a:asset_t' + (N - 1), localOld + ' / ' + localNew);

  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
