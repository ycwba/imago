#!/usr/bin/env node
/* 本机别名表的常驻回归（不启浏览器、不碰真实数据）。
   跑法：`node tests/local-first.cjs`。

   一份产物只有一份字节，落在库根里，本机号是 la_xxx。「这条平台产物在本机是哪一份」只有
   web/domain/local.js 的 rowOfEntry 一处判据；浏览器只留一张**当前会话**的别名表（内存），
   由代理现给：开机快照 `GET /local-assets/aliases` + 列表加载时 `POST /local-assets/locate`，
   落盘回执与本机资产库列表也会就地补行。没有 localStorage / IndexedDB 副本。

   同一份产物在四种形状里必须算出同一个身份：
     ① 平台列表（带产物号 / 只带任务号 / 只有来源地址）
     ② 本机资产库那一行（la_xxx）
     ③ 收藏 / 工作区里存着的旧地址（签名换了也要认得出）
     ④ 平台外链过期之后（按地址反查本机副本）
   测试直接装真源码，不复制实现。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
let bad = 0, n = 0;
function ok(name, cond, detail) { n++; if (cond) { console.log('  ✓ ' + name); return; } bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }

/* 一条别名行（与代理 aliasRowOf 同一形状）：id 是本机号，assetId / taskId 是平台身份，
   upstream 是取回字节的来源地址。`learn` / locate / 快照三条路都吃这一种。 */
const rowOf = (id, extra) => Object.assign({
  id, assetId: '', taskId: '', upstream: '', format: 'png', name: '',
  byte_length: 0, file: '', media_type: '', created_at: '',
}, extra || {});

/* Net 桩：别名快照与 locate 都是代理的现答。`state.gate` 只在快照那一路生效，
   用来把「取表期间又落盘了一条」这个窗口拉宽。 */
function netStub(state) {
  const s = state || {};
  const calls = [];
  const net = {
    json(p, cfg) {
      calls.push({ path: p, cfg: cfg || {} });
      if (p === '/local-assets/aliases') {
        const body = { rev: s.rev || 1, rows: (s.rows || []).slice() };
        return s.gate ? s.gate.then(() => body) : Promise.resolve(body);
      }
      if (p === '/local-assets/locate') {
        let items = [];
        try { items = (JSON.parse((cfg && cfg.body) || '{}').items) || []; } catch (e) { items = []; }
        const rows = items.map(it => (s.locate ? s.locate(it) : null));
        return Promise.resolve({ rows });
      }
      return Promise.reject(new Error('探测桩不认识 ' + p));
    },
  };
  return { net, calls };
}

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
  if (o.net) ctx.Net = o.net;            // local.js 末尾那次开机 ready() 读的就是它
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/ident.cjs'), 'utf8'), ctx, { filename: 'web/domain/ident.cjs' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/api.js'), 'utf8'), ctx, { filename: 'web/domain/api.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/assetlib.js'), 'utf8'), ctx, { filename: 'web/domain/assetlib.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/local.js'), 'utf8'), ctx, { filename: 'web/domain/local.js' });
  const AL = ctx.AssetLocal, Lib = ctx.AssetLib;
  for (const r of (o.rows || [])) AL.learn(r);
  return { ctx, AL, Lib, localStorage, store };
}

const UP = 'https://cdn.example.com/results/a.mp4?Expires=1790000000&Signature=abc';
const eOne = () => ({ kind: 'asset', provider: 'sparkcine', assetId: 'asset_one', genId: 'job_single', src: '/asset/asset_one?v=2' });

/* ① 平台产物号一路：地址换本机、身份是本机号；开关只管地址，不管身份 */
{
  const { AL } = boot({ rows: [rowOf('la_one', { assetId: 'asset_one', taskId: 'job_single', byte_length: 100,
    name: '王八.png', file: '图片/王八.png' })] });
  const e = eOne();
  AL.decorate(e, { allowGen: false });
  ok('按产物号认回本机那一份', e.mirrorKey === 'la:la_one' && e.mirror && e.mirror.a === 'la_one', JSON.stringify(e.mirrorKey));
  ok('优先用本机时地址换成本机文件', e.src === '/asset/la_one?v=2', e.src);
  ok('平台 + 本机副本 → both', AL.stateOf(e).state === 'both' && AL.stateOf(e).local && AL.stateOf(e).cloud, JSON.stringify(AL.stateOf(e)));
  ok('合卡身份就是本机号', AL.twinOf(e) === 'la:la_one', AL.twinOf(e));
  ok('本机地址能反查到本机号', AL.localAssetIdOf('/asset/la_one?v=2') === 'la_one');
  ok('镜像字段带字节数与规范名', e.mirror.b === 100 && e.mirror.n === '王八.png' && e.mirror.fp === '图片/王八.png', JSON.stringify(e.mirror));

  const b = boot({ rows: [rowOf('la_one', { assetId: 'asset_one', taskId: 'job_single', byte_length: 100 })],
    prefs: { sk_media_prefer: 'off' } });
  const e2 = eOne();
  b.AL.decorate(e2, { allowGen: false });
  ok('关掉「优先用本机文件」后地址退回平台', e2.src === '/asset/asset_one?v=2', e2.src);
  ok('关掉开关不影响身份：仍然 both', b.AL.stateOf(e2).state === 'both', JSON.stringify(b.AL.stateOf(e2)));
}

/* ② 任务号一路：只认「整条任务只出一份」，多产物任务绝不按任务号合 */
{
  const { AL } = boot({ rows: [rowOf('la_multi_a', { assetId: 'asset_a', taskId: 'job_multi', byte_length: 200 })] });
  const one = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new', genId: 'job_multi', outCount: 1, src: '/asset/asset_new?v=2' };
  AL.decorate(one);                                   // 默认 allowGen 由 outCount === 1 推
  ok('单产物任务按任务号认回唯一那份本机文件', one.mirrorKey === 'la:la_multi_a', JSON.stringify(one.mirrorKey));
  const four = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new4', genId: 'job_multi', outCount: 4, src: '/asset/asset_new4?v=2' };
  AL.decorate(four);
  ok('多产物任务不按任务号合（不冒充本机）', !four.mirrorKey && AL.stateOf(four).state === 'cloud', JSON.stringify(AL.stateOf(four)));
  ok('任务号地址只在整条任务只出一份时认', AL.localAssetIdOf('/asset/job_multi?v=2') === 'la_multi_a', AL.localAssetIdOf('/asset/job_multi?v=2'));

  const two = boot({ rows: [
    rowOf('la_m1', { assetId: 'asset_1', taskId: 'job_two' }),
    rowOf('la_m2', { assetId: 'asset_2', taskId: 'job_two' }),
  ] });
  const x = { kind: 'asset', provider: 'p', assetId: 'asset_x', genId: 'job_two', outCount: 1, src: '/asset/asset_x?v=2' };
  two.AL.decorate(x);
  ok('同一个任务有两份本机文件时也不按任务号合', !x.mirrorKey && two.AL.stateOf(x).state === 'cloud', JSON.stringify(x.mirrorKey));
  ok('任务号地址同样不认', two.AL.localAssetIdOf('/asset/job_two?v=2') === '', two.AL.localAssetIdOf('/asset/job_two?v=2'));
}

/* ③ 来源地址一路：签名换了仍认得出 */
{
  const { AL } = boot({ rows: [rowOf('la_up', { upstream: UP, format: 'mp4', byte_length: 300 })] });
  const e = { kind: 'asset', provider: 'vgenv', id: 'job_x', src: '/getv?url=' + encodeURIComponent(UP.replace('abc', 'zzz')) };
  AL.decorate(e);
  ok('签名参数变了也按来源认回本机', e.mirrorKey === 'la:la_up' && e.mirror.a === 'la_up', JSON.stringify(e.mirrorKey));
  ok('来源路的本机地址可反查', AL.localAssetIdOf('/asset/la_up?v=2') === 'la_up');
  ok('同一条外链（签名不同）算同一份', AL.localAssetIdOf(UP.replace('abc', 'zzz')) === 'la_up');
}

/* ④ 多图任务：两份产物各有各的身份，第二张不会被吞掉 */
{
  const { AL } = boot({ rows: [
    rowOf('la_new_1', { assetId: 'asset_a', taskId: 'job_z', byte_length: 10 }),
    rowOf('la_new_2', { assetId: 'asset_b', taskId: 'job_z', byte_length: 20 }),
  ] });
  const a = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_a', genId: 'job_z', outCount: 2, src: '/asset/asset_a?v=2' };
  const b = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_b', genId: 'job_z', outCount: 2, src: '/asset/asset_b?v=2' };
  AL.decorate(a); AL.decorate(b);
  ok('多图任务两份产物各有各的本机号', a.mirror && a.mirror.a === 'la_new_1' && b.mirror && b.mirror.a === 'la_new_2',
    JSON.stringify([a.mirrorKey, b.mirrorKey]));
}

/* ⑤ 只有任务号的老行：各按各的本机号站住，不互相合并 */
{
  const { AL } = boot({ rows: [
    rowOf('la_old_1', { taskId: 'job_old', byte_length: 210 }),
    rowOf('la_old_2', { taskId: 'job_old', byte_length: 220 }),
  ] });
  ok('两条本机文件都能按本机地址反查',
    AL.localAssetIdOf('/asset/la_old_1?v=2') === 'la_old_1' && AL.localAssetIdOf('/asset/la_old_2?v=2') === 'la_old_2');
  ok('同一个任务的两条本机文件不合成一份', AL.localAssetIdOf('/asset/job_old?v=2') === '');
  ok('本机资产库那一条自己的身份就是本机号',
    AL.twinOf({ kind: 'asset', provider: 'sparkcine', assetId: 'la_old_2', id: 'la_old_2', genId: 'la_old_2',
      src: '/asset/la_old_2?v=2', localAsset: true }) === 'la:la_old_2');
}

/* ⑥ 自产素材（MiMo 语音）：只有本机一份，不能因为 provider 有 id 就标成「本机+云端」 */
{
  const { AL } = boot({});
  const e = { kind: 'asset', provider: 'mimo', assetId: 'la_voice', genId: 'la_voice', src: '/asset/la_voice?v=2', localAsset: true };
  AL.decorate(e);
  const st = AL.stateOf(e);
  ok('本机自产 → local（不是 both）', st.state === 'local' && st.local && !st.cloud, JSON.stringify(st));
  ok('在跑的任务 → cloud', AL.stateOf({ kind: 'task', provider: 'sparkcine', id: 'job_1', genId: 'job_1', status: 'running' }).state === 'cloud');
  ok('本机自产条目不会被别名表改写', e.src === '/asset/la_voice?v=2' && AL.twinOf(e) === 'la:la_voice');
}

/* ⑦ 删掉本机副本之后：地址退回平台、标记摘掉、不再被当成「本机」 */
{
  const { AL } = boot({ rows: [
    rowOf('la_one', { assetId: 'asset_one', taskId: 'job_single', byte_length: 100 }),
    rowOf('la_two', { assetId: 'asset_two', byte_length: 110 }),
  ] });
  const e = eOne();
  AL.decorate(e, { allowGen: false });
  ok('删之前：地址是本机文件', e.src === '/asset/la_one?v=2', e.src);
  ok('删掉的是那一行', AL.forgetMirror(e.mirror.a) === true && AL.stats().count === 1, JSON.stringify(AL.stats()));
  AL.decorate(e, { allowGen: false });
  ok('删掉本机副本后地址退回平台', e.src === '/asset/asset_one?v=2', e.src);
  ok('删掉本机副本后不再标「本机」', !e.localAsset && !e.mirrorKey && AL.stateOf(e).state === 'cloud', JSON.stringify(AL.stateOf(e)));
  const e2 = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_two', src: '/asset/asset_two?v=2' };
  AL.decorate(e2);
  ok('别的行不受影响', e2.mirrorKey === 'la:la_two', JSON.stringify(e2.mirrorKey));
  ok('la: 合卡键也收', AL.forgetMirror('la:la_two') === true && AL.stats().count === 0);
}

/* ⑧ 整表：单产物任务平台那条 + 本机那一条合成一张；多产物不合 */
{
  const { AL, Lib } = boot({ rows: [
    rowOf('la_multi_a', { taskId: 'job_multi', byte_length: 200 }),
    rowOf('la_multi_4a', { taskId: 'job_multi4', byte_length: 220 }),
  ] });
  const platform = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new', genId: 'job_multi', outCount: 1,
    src: '/asset/asset_new?v=2', prompt: '' };
  const localRow = { kind: 'asset', provider: 'sparkcine', assetId: 'la_multi_a', id: 'la_multi_a', genId: 'la_multi_a',
    src: '/asset/la_multi_a?v=2', localAsset: true, prompt: '本机留底的那句提示词' };
  const merged = Lib.settleEntries([platform, localRow]);
  ok('单产物任务合成一张卡', merged.length === 1, 'len=' + merged.length + ' ' + JSON.stringify(merged.map(x => x.assetId)));
  ok('合成时保留平台那条、补上本机提示词', merged[0].assetId === 'asset_new' && merged[0].prompt === '本机留底的那句提示词', JSON.stringify(merged[0]));
  ok('合成后是 both', AL.stateOf(merged[0]).state === 'both', JSON.stringify(AL.stateOf(merged[0])));

  const p4 = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_new4', genId: 'job_multi4', outCount: 4, src: '/asset/asset_new4?v=2' };
  const l4 = { kind: 'asset', provider: 'sparkcine', assetId: 'la_multi_4a', id: 'la_multi_4a', genId: 'la_multi_4a',
    src: '/asset/la_multi_4a?v=2', localAsset: true };
  const merged4 = Lib.settleEntries([p4, l4]);
  ok('多产物任务不硬合', merged4.length === 2, 'len=' + merged4.length);
}

/* ⑨ 「不显示云端任务」：有本机副本的不藏；只有平台地址的藏；在跑的不藏 */
{
  const { AL } = boot({
    rows: [rowOf('la_one', { assetId: 'asset_one', taskId: 'job_single', byte_length: 100 })],
    prefs: { sk_media_cloud_hide: '1', sk_media_local: 'on', sk_media_prefer: 'on' },
  });
  ok('本机优先三个开关都开时 localOnly 为真', AL.localOnly() === true);
  const both = eOne();
  AL.decorate(both, { allowGen: false });
  ok('有本机副本的不藏', AL.hideAsCloud(both) === false);
  const cloud = { kind: 'asset', provider: 'vgenv', assetId: 'asset_x', genId: 'job_x', src: '/asset/asset_x?v=2' };
  ok('只有平台地址的藏', AL.hideAsCloud(cloud) === true);
  ok('在跑的不藏', AL.hideAsCloud({ kind: 'task', provider: 'sparkcine', id: 'job_q', genId: 'job_q', status: 'running' }) === false);
}

/* ⑩ 同一个本机号只留一行：换了身份之后旧产物号不许再命中（落盘回执按 la 号就地替换） */
{
  const { AL } = boot({});
  AL.learn(rowOf('la_x', { assetId: 'asset_a', taskId: 'task_a', byte_length: 10 }));
  const a1 = { kind: 'asset', provider: 'p', assetId: 'asset_a', src: '/asset/asset_a?v=2' };
  AL.decorate(a1);
  ok('先认到的身份命中', a1.mirrorKey === 'la:la_x', JSON.stringify(a1.mirrorKey));
  AL.learn(rowOf('la_x', { assetId: 'asset_b', taskId: 'task_b', byte_length: 12 }));
  const a2 = { kind: 'asset', provider: 'p', assetId: 'asset_a', src: '/asset/asset_a?v=2' };
  AL.decorate(a2);
  ok('同一个本机号换了身份：旧产物号不再命中', !a2.mirrorKey && AL.stateOf(a2).state === 'cloud', JSON.stringify(a2.mirrorKey));
  const b = { kind: 'asset', provider: 'p', assetId: 'asset_b', src: '/asset/asset_b?v=2' };
  AL.decorate(b);
  ok('新产物号命中同一行', b.mirrorKey === 'la:la_x' && b.mirror.b === 12, JSON.stringify(b.mirror));
  ok('表里仍只有一行', AL.stats().count === 1, JSON.stringify(AL.stats()));
}

/* ⑪ 开机快照：并发 ready 只问一次；取表期间落盘的那条不被早于它的快照抹掉；
     第二次取表时服务端那份说了算 */
const g11 = (async () => {
  const state = { rows: [rowOf('la_srv', { assetId: 'asset_srv', byte_length: 30 })] };
  let release = null;
  state.gate = new Promise(r => { release = r; });
  const { net, calls } = netStub(state);
  const { AL } = boot({ net });
  const p1 = AL.ready(0), p2 = AL.ready(0);
  ok('并发 ready 共用同一只在途请求', p1 === p2);
  AL.learn(rowOf('la_session', { assetId: 'asset_session', byte_length: 40 }));
  release();
  await p1;
  ok('快照只问了一次', calls.filter(c => c.path === '/local-assets/aliases').length === 1, JSON.stringify(calls.map(c => c.path)));
  const srv = { kind: 'asset', provider: 'p', assetId: 'asset_srv', src: '/asset/asset_srv?v=2' };
  AL.decorate(srv);
  ok('快照里的行按产物号命中', srv.mirrorKey === 'la:la_srv', JSON.stringify(srv.mirrorKey));
  const sess = { kind: 'asset', provider: 'p', assetId: 'asset_session', src: '/asset/asset_session?v=2' };
  AL.decorate(sess);
  ok('取表期间新落盘的那一条还在', sess.mirrorKey === 'la:la_session', JSON.stringify(sess.mirrorKey));

  AL.learn(rowOf('la_stale', { assetId: 'asset_stale', byte_length: 50 }));
  await new Promise(r => setTimeout(r, 5));           // 下一轮取表要晚于这次落盘（同毫秒会被当成「取表期间」）
  state.rows = [rowOf('la_srv', { assetId: 'asset_srv', byte_length: 30 })];
  await AL.ready(0);
  const stale = { kind: 'asset', provider: 'p', assetId: 'asset_stale', src: '/asset/asset_stale?v=2' };
  AL.decorate(stale);
  ok('服务端快照里没有的行被抹掉（以账为准）', !stale.mirrorKey && AL.stateOf(stale).state === 'cloud', JSON.stringify(stale.mirrorKey));
  const srv2 = { kind: 'asset', provider: 'p', assetId: 'asset_srv', src: '/asset/asset_srv?v=2' };
  AL.decorate(srv2);
  ok('快照里有的行留着', srv2.mirrorKey === 'la:la_srv', JSON.stringify(srv2.mirrorKey));

  const off = boot({ net: { json: () => Promise.reject(new Error('offline')) } });
  let err = null;
  await off.AL.ready(0).catch(e => { err = e; });
  ok('取不回别名表也不抛错', !err, err && err.message);
  const none = { kind: 'asset', provider: 'p', assetId: 'asset_srv', src: '/asset/asset_srv?v=2' };
  off.AL.decorate(none);
  ok('没有表就按「本机没有」画', !none.mirrorKey && off.AL.stateOf(none).state === 'cloud');
})();

/* ⑫ 列表加载时的批量补问：只问没认出来的、allowGen 只在条目声明只出一份时为真 */
const g12 = (async () => {
  const state = { rows: [] };
  state.locate = it => {
    if (it.assetId === 'asset_hit') return rowOf('la_hit', { assetId: 'asset_hit', byte_length: 50 });
    if (it.taskId === 'job_uniq' && it.allowGen) return rowOf('la_uniq', { assetId: 'asset_uniq', taskId: 'job_uniq', byte_length: 60 });
    if (it.url === 'https://cdn.example.com/expired/v.mp4?Expires=1&Signature=old') return rowOf('la_url',
      { upstream: 'https://cdn.example.com/expired/v.mp4?Expires=2&Signature=new', format: 'mp4', byte_length: 70 });
    return null;
  };
  const { net, calls } = netStub(state);
  const { AL } = boot({ net });
  await AL.ready(0);
  AL.learn(rowOf('la_known', { assetId: 'asset_known', byte_length: 80 }));
  const entries = [
    { kind: 'asset', provider: 'p', assetId: 'asset_hit', genId: 'job_h', outCount: 1, src: '/asset/asset_hit?v=2' },
    { kind: 'asset', provider: 'p', genId: 'job_uniq', outCount: 1, src: '/asset/asset_uniq?v=2' },
    { kind: 'asset', provider: 'p', genId: 'job_multi', outCount: 4, src: '/asset/asset_multi?v=2' },
    { kind: 'asset', provider: 'p', assetId: 'la_self', id: 'la_self', localAsset: true, src: '/asset/la_self?v=2' },
    { kind: 'asset', provider: 'p', assetId: 'asset_known', genId: 'job_k', outCount: 1, src: '/asset/asset_known?v=2' },
    { kind: 'asset', provider: 'vgenv', genId: 'job_v', rawSrc: 'https://cdn.example.com/expired/v.mp4?Expires=1&Signature=old',
      src: '/getv?url=' + encodeURIComponent('https://cdn.example.com/expired/v.mp4?Expires=1&Signature=old') },
  ];
  const hit = await AL.locate(entries);
  ok('locate 只补问还没认出来的那几条', hit === 3, 'hit=' + hit);
  const loc = calls.filter(c => c.path === '/local-assets/locate');
  const items = JSON.parse(loc[0].cfg.body).items;
  ok('已经认出的 / 本机自产的不进请求', items.length === 4
    && !items.some(x => x.assetId === 'asset_known' || x.assetId === 'la_self'), JSON.stringify(items));
  ok('allowGen 只在条目声明只出一份时为真',
    items.find(x => x.taskId === 'job_uniq').allowGen === true && items.find(x => x.taskId === 'job_multi').allowGen === false,
    JSON.stringify(items.map(x => [x.taskId, x.allowGen])));
  ok('产物号那一路换成本机地址', entries[0].mirrorKey === 'la:la_hit' && entries[0].src === '/asset/la_hit?v=2', entries[0].src);
  ok('任务号那一路只认唯一那份', entries[1].mirrorKey === 'la:la_uniq', JSON.stringify(entries[1].mirrorKey));
  ok('多产物任务不按任务号认', !entries[2].mirrorKey && AL.stateOf(entries[2]).state === 'cloud', JSON.stringify(entries[2].mirrorKey));
  ok('本机自产条目原样不动', !entries[3].mirrorKey && entries[3].src === '/asset/la_self?v=2');
  ok('地址那一路（外链过期）也认得出本机副本',
    entries[5].mirrorKey === 'la:la_url' && entries[5].src === '/asset/la_url?v=2', JSON.stringify([entries[5].mirrorKey, entries[5].src]));
})();

/* ⑬ 磁盘对账补的裸行（没有产物号 / 任务号）：按来源地址认出之后当场补上身份 */
{
  const BARE = 'https://cdn.example.com/results/bare.mp4?Expires=1&Signature=y';
  const { AL } = boot({ rows: [rowOf('la_bare', { upstream: BARE, format: 'mp4', byte_length: 1234 })] });
  const ent = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_bare', genId: 'job_bare',
    src: '/asset/asset_bare?v=2', rawSrc: 'https://cdn.example.com/results/bare.mp4?Expires=2&Signature=z' };
  ok('按来源地址认出已存过（不重下）', AL.offer('sparkcine', ent, ent.rawSrc) === 'saved');
  const e = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_bare', genId: 'job_bare',
    src: '/asset/asset_bare?v=2', rawSrc: ent.rawSrc };
  AL.decorate(e, { allowGen: false });
  ok('裸行当场补上产物号，下一轮直接命中', e.mirrorKey === 'la:la_bare' && e.mirror.a === 'la_bare', JSON.stringify(e.mirrorKey));
}

/* ⑭ 地址 → 磁盘落点（FCPXML 这类要路径的出口读它） */
{
  const { AL } = boot({ rows: [rowOf('la_f', { assetId: 'asset_f', format: 'mp4', name: '王八.mp4', byte_length: 99, file: '视频/王八.mp4' })] });
  const f = AL.localFileOf('/asset/asset_f?v=2');
  ok('平台产物号地址 → 本机落点', f && f.id === 'la_f' && f.path === '视频/王八.mp4' && f.bytes === 99 && f.format === 'mp4', JSON.stringify(f));
  ok('认不出的地址 → null', AL.localFileOf('https://cdn.example.com/other.mp4') === null);
}

/* ⑮ 索引重建 / 本机文件被删之后：缓存里留着上一天的本机身份，账里已经没有那一行 */
const g15 = (async () => {
  const { net } = netStub({ rows: [] });
  const { AL, Lib } = boot({ net });
  await AL.ready(0);
  /* 平台那条：上次换过本机地址，字段全留在首屏缓存里 */
  const mirrored = { kind: 'asset', provider: 'sparkcine', assetId: 'asset_m', genId: 'job_m', outCount: 1,
    src: '/asset/la_gone?v=2', platSrc: '/asset/asset_m?v=2', mirrorKey: 'la:la_gone',
    mirror: { a: 'la_gone', b: 10, n: 'x.png', up: '', p: 'asset_m', g: 'job_m' },
    localAsset: true, byteLength: 10 };
  AL.decorate(mirrored);
  ok('缓存里留着已删镜像的平台条目：地址退回平台', mirrored.src === '/asset/asset_m?v=2', mirrored.src);
  ok('缓存里留着已删镜像的平台条目：标记摘掉、不再合卡',
    !mirrored.mirrorKey && !mirrored.mirror && !mirrored.localAsset && AL.twinOf(mirrored) === '');
  ok('缓存里留着已删镜像的平台条目：状态只剩云端', AL.stateOf(mirrored).state === 'cloud', JSON.stringify(AL.stateOf(mirrored)));

  /* 本机资产库那条（条目即资产）：账里没有它那个本机号 */
  const selfE = { kind: 'asset', provider: 'kolors', assetId: 'la_gone', id: 'la_gone', genId: 'la_gone',
    taskId: 'job_platform', status: 'done', localSelf: true, localAsset: true, src: '/asset/la_gone?v=2' };
  AL.decorate(selfE);
  ok('账里没有的自产条目不再算本机', AL.staleSelf(selfE) === true && AL.stateOf(selfE).local === false,
    JSON.stringify(AL.stateOf(selfE)));
  ok('自产条目的地址退回平台任务号', selfE.src === '/asset/job_platform?v=2', selfE.src);
  ok('进界面前摘掉这条自产条目', Lib.settleEntries([selfE]).length === 0);
  ok('/asset/la_gone 不再算本机地址',
    AL.localAssetIdOf('/asset/la_gone?v=2') === '' && AL.hasLocalAddr('/asset/la_gone?v=2') === false);
  AL.learn(rowOf('la_live', { assetId: 'asset_live', byte_length: 5 }));
  ok('账里有的行照样认', AL.localAssetIdOf('/asset/la_live?v=2') === 'la_live' && AL.hasLocalAddr('/asset/la_live?v=2') === true);

  /* 表没取回来（离线）时「查不到」不等于「没有」：仍按条目自己带的标记算 */
  const offline = boot({});
  ok('取不到表时本机地址照旧认', offline.AL.localAssetIdOf('/asset/la_voice?v=2') === 'la_voice');
})();

Promise.all([g11, g12, g15]).then(() => {
  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
}).catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
