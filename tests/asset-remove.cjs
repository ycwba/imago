#!/usr/bin/env node
/* 本机条目「删除」与「归属显示」的常驻回归（不启浏览器、不碰真实数据）。
   跑法：`node tests/asset-remove.cjs`。

   装的是真源码（api.js + assetlib.js），只把上游请求换成探针。盯两件事：
     ① 删除：/local-assets 那张列表里的行（localSelf）—— 索引里 provider 记的只是
        「谁生成的」注记（语音平台 id / '本机' / 'local'），以前把它当平台 id 查注册表，
        'local' 与 '本机' 查不到任何一家，删除按钮一点就抛「找不到平台」永远删不掉
        （老版字幕烧录栅格化落下的 subtitle-*.png 正是 provider='local' 这一族，
        用户点名「字幕文件总是出现在资产库、删除好像有问题」）。
     ② 归属：provider 注记解析不到注册表平台时显示「本机」，不再挂来源那家
        （语音平台）的 displayName —— 用户点名「供应商显示的是语音的供应商」。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
let bad = 0, n = 0;
function ok(name, cond, detail) { n++; if (cond) { console.log('  ✓ ' + name); return; } bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }

function boot() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Promise, JSON, Math, Date, Number, String, Object, Array, Map, Set, WeakMap, WeakSet,
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, isFinite, RegExp, Error,
    localStorage, sessionStorage: localStorage,
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
    fileExtOf: o => (o && o.format) || (o && o.mtype === '视频' ? 'mp4' : 'png'),
    isAudioType: t => /音频|语音|audio/.test(String(t)),
    errText: e => String((e && e.message) || e || ''),
    esc: s => String(s == null ? '' : s),
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.dispatchEvent = () => {};
  ctx.URL.revokeObjectURL = () => {}; ctx.URL.createObjectURL = () => 'blob:x';
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/ident.cjs'), 'utf8'), ctx, { filename: 'web/domain/ident.cjs' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/api.js'), 'utf8'), ctx, { filename: 'web/domain/api.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/assetlib.js'), 'utf8'), ctx, { filename: 'web/domain/assetlib.js' });
  return ctx;
}

(async () => {
  const ctx = boot();
  const A = ctx.Api, Lib = ctx.AssetLib;

  /* 注册表探针：两家 selfAsset 来源共用 local:/local-assets（与真表同一形状，
     listSources 按 local: 端点去重后只剩第一家 —— 那家是语音 kind，正是「归属被挂到语音平台」的来源），
     另有一家带 remove 端点的平台与一家没有 remove 端点的平台。 */
  const selfList = {
    dataField: 'data', selfAsset: true, limit: 100,
    map: { id: 'id', status: 'status', prompt: 'prompt', created: 'created_at', format: 'format' },
    statusMap: { succeeded: 'done' },
    media: { by: 'media_type', videoPrefix: ['视频', 'video'], imagePrefix: ['图片', 'image'], fallback: '音频' },
  };
  const REG = {
    providers: [
      { id: 'mimo', name: 'MiMo语音', displayName: 'MiMo', kind: 'audio', relay: '/mimo',
        endpoints: { list: 'local:/local-assets', remove: 'local:/local-assets/{id}' }, list: selfList },
      { id: 'minimax-tts', name: 'MiniMax 语音合成', displayName: 'MiniMax', kind: 'audio', relay: '/minimax/tts',
        endpoints: { list: 'local:/local-assets', remove: 'local:/local-assets/{id}' }, list: selfList },
      { id: 'platx', name: '平台X', displayName: '平台X', kind: 'video', relay: '/platx',
        endpoints: { list: '/tasks', remove: '/assets/{id}' },
        list: { dataField: 'data', limit: 100, map: { id: 'id', status: 'status' }, statusMap: { succeeded: 'done' }, media: { fixed: '视频' } } },
      { id: 'platnor', name: '平台无删', displayName: '平台无删', kind: 'video', relay: '/platnor',
        endpoints: { list: '/tasks' },
        list: { dataField: 'data', limit: 100, map: { id: 'id', status: 'status' }, statusMap: { succeeded: 'done' }, media: { fixed: '视频' } } },
    ],
  };
  A.setRegistry(REG);
  A.listCursor = () => '';

  /* /local-assets 那张表里的三行：字幕残留（provider='local'）、语音产物（provider=平台 id）、
     导入的视频（provider='本机'）。 */
  const LOCAL_ROWS = { data: [
    { id: 'la_junk', status: 'succeeded', media_type: '图片', format: 'png', provider: 'local',
      prompt: '', created_at: '2026-10-22T10:50:40.890Z' },
    { id: 'la_voice', status: 'succeeded', media_type: '音频', format: 'mp3', provider: 'minimax-tts',
      prompt: '你好', created_at: '2026-10-22T11:00:00Z' },
    { id: 'la_import', status: 'succeeded', media_type: '视频', format: 'mp4', provider: '本机',
      prompt: '', created_at: '2026-10-22T12:00:00Z' },
  ] };
  const calls = [];
  A.request = async (prov, op, o) => {
    calls.push({ prov: prov && prov.id, op, id: o && o.id, method: o && o.method });
    if (op === 'remove') return { ok: true };
    return prov && prov.id === 'mimo' ? LOCAL_ROWS : { data: [] };
  };

  console.log('· 归属显示（normalize 后）');
  const r = await Lib.load({ pages: 1, reg: REG });
  const byId = {}; r.entries.forEach(e => { byId[e.id] = e; });
  ok('三行都进了列表且带 localSelf', ['la_junk', 'la_voice', 'la_import'].every(k => byId[k] && byId[k].localSelf === true),
    'entries=' + JSON.stringify(r.entries.map(e => e.id)));
  ok("provider='local'（盘上补的账 / 字幕残留）显示「本机」，不再挂语音平台名", byId.la_junk && byId.la_junk.providerName === '本机',
    'providerName=' + JSON.stringify(byId.la_junk && byId.la_junk.providerName));
  ok("provider='本机'（导入的视频）显示「本机」", byId.la_import && byId.la_import.providerName === '本机',
    'providerName=' + JSON.stringify(byId.la_import && byId.la_import.providerName));
  ok("provider=平台 id（语音产物）仍归生它那家", byId.la_voice && byId.la_voice.providerName === 'MiniMax',
    'providerName=' + JSON.stringify(byId.la_voice && byId.la_voice.providerName));

  console.log('· 删除路由');
  calls.length = 0;
  const rj = await Lib.remove(byId.la_junk);
  ok("provider='local' 的本机条目删得掉（走 /local-assets，不抛「找不到平台」）",
    !!rj && rj.localGone === true && rj.mirrorGone == null
      && calls.length === 1 && calls[0].op === 'remove' && calls[0].id === 'la_junk' && calls[0].method === 'DELETE',
    'calls=' + JSON.stringify(calls));
  const ri = await Lib.remove(byId.la_import);
  ok("provider='本机' 的本机条目同样删得掉", !!ri && ri.localGone === true && calls.length === 2 && calls[1].id === 'la_import',
    'calls=' + JSON.stringify(calls));
  const rv = await Lib.remove(byId.la_voice);
  ok("provider=平台 id 的本机条目也走 /local-assets（它本来就是本机那份）",
    !!rv && rv.localGone === true && calls.length === 3 && calls[2].id === 'la_voice',
    'calls=' + JSON.stringify(calls));
  const ro = await Lib.remove({ localAsset: true, assetId: 'la_old', id: 'la_old', provider: 'local' });
  ok('缓存里没带 localSelf 的旧形状（localAsset + la_ 号、无 mirror）同样走 /local-assets',
    !!ro && ro.localGone === true && calls.length === 4 && calls[3].id === 'la_old',
    'calls=' + JSON.stringify(calls));
  const rm = await Lib.remove({ provider: 'platx', assetId: 'px_1', id: 'px_1', mirror: { a: 'la_m1' } });
  ok('平台条目带本机副本：删的是镜像那份（mirrorGone，卡片留着）',
    !!rm && rm.mirrorGone === true && rm.localGone == null && calls.length === 5 && calls[4].id === 'la_m1',
    'calls=' + JSON.stringify(calls));
  const rp = await Lib.remove({ provider: 'platx', assetId: 'px_9', id: 'px_9' });
  ok('纯平台条目走平台自己的 remove 端点',
    !!rp && calls.length === 6 && calls[5].prov === 'platx' && calls[5].id === 'px_9',
    'calls=' + JSON.stringify(calls));
  let norErr = '';
  try { await Lib.remove({ provider: 'platnor', assetId: 'pn_1', id: 'pn_1' }); }
  catch (e) { norErr = String(e && e.message || e); }
  ok('平台没声明 remove 端点：照实说「存放在平台侧」', /平台侧/.test(norErr), 'err=' + norErr);

  console.log((bad ? '✗ ' + bad + '/' + n + ' 红\n' : '✓ ' + n + ' 条全绿\n'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('探针自身挂了：', e); process.exit(1); });
