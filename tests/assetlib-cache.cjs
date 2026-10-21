#!/usr/bin/env node
/* 列表结果级短缓存（L1）：同参数 30 秒内第二次 load 必须 0 次上游请求（探针计数）。
   跑法：`node tests/assetlib-cache.cjs`。

   装的是真源码（api.js + assetlib.js），只把最外层两件事换成探针：
   `Api.request`（数上游请求）与 `Api.listSources`（给一个假来源）。
   续拉（带 out / cursors / more）、数总数（prompts:false）与 noCache 都不许吃这份缓存 ——
   它们要的是「接着上次的游标往下翻」或「这次现数」，命中旧快照会少条目 / 数错。 */
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

  const prov = {
    id: 'probe', name: '探针', kind: 'image', relay: '/probe', endpoints: { list: '/list' },
    list: {
      limit: 100,
      map: { id: 'id', status: 'status', outputUrl: 'url', created: 'created', prompt: 'prompt' },
      media: { fixed: '图片' },
    },
  };
  const src = { key: 'probe', prov, spec: prov.list };
  let hits = 0;
  A.listSources = () => [src];
  A.listCursor = () => '';
  A.request = async () => {
    hits++;
    return { data: [{ id: 'job_' + hits, status: 'succeeded', url: 'https://cdn.example.com/' + hits + '.png',
      created: '2026-10-20T00:00:00Z', prompt: '第 ' + hits + ' 条' }] };
  };

  const r1 = await Lib.load({ pages: 1 });
  ok('第一次 load 真的打到上游', hits === 1 && r1.entries.length === 1, 'hits=' + hits + ' entries=' + r1.entries.length);

  const r2 = await Lib.load({ pages: 1 });
  ok('同参数 30 秒内第二次 load：0 次上游请求', hits === 1, 'hits=' + hits);
  ok('第二次拿的是缓存条目（内容一致、标记 cached）', r2.cached === true && r2.entries.length === 1
    && r2.entries[0].id === 'job_1', JSON.stringify(r2.entries && r2.entries[0] && r2.entries[0].id));

  r1.entries[0]._probeMutation = 1;
  const r3 = await Lib.load({ pages: 1 });
  ok('调用方改条目不会改到缓存本体', r3.entries[0]._probeMutation === undefined, String(r3.entries[0]._probeMutation));

  await Lib.load({ pages: 1, noCache: true });
  ok('noCache 强制重取（并刷新缓存）', hits === 2, 'hits=' + hits);

  await Lib.load({ pages: 1, out: [], cursors: {}, more: {} });
  ok('续拉（带 out / cursors / more）不进缓存、照常请求', hits === 3, 'hits=' + hits);

  await Lib.load({ pages: 1, prompts: false });
  ok('数总数（prompts:false）不吃结果缓存', hits === 4, 'hits=' + hits);

  await Lib.load({ pages: 1, kinds: ['video'] });
  ok('参数（kinds）不同即另一条缓存', hits === 5, 'hits=' + hits);

  /* accept 的签名按函数源码算：两个调用点的筛选函数源码不同就是两条缓存，
     同一处源码重复调用才算同参数 —— 不能把「只数视频」的缓存交给「只数图片」。 */
  const onlyImg = e => e.type === '图片';
  const onlyVid = e => e.type === '视频';
  await Lib.load({ pages: 2, accept: onlyImg });
  const beforeAccept = hits;
  await Lib.load({ pages: 2, accept: onlyVid });
  ok('accept 不同即另一条缓存', hits === beforeAccept + 1, 'hits=' + hits + ' before=' + beforeAccept);

  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
