#!/usr/bin/env node
/* 「这一屏还要存回本机哪几条」的常驻判据（不启浏览器、不碰真实数据）。
   跑法：`node tests/pull-scope.mjs`。

   三页（资产库 / 收藏 / 工作台）各给一个 keyOf，喂**同一份 fixture**：
   结果必须逐条相等 —— 判据只有 web/domain/local.js 的 pullPlan 一份，
   页面自己的筛选只决定「进 plan 之前那一屏有哪些」。
   另外守住四件事：本地上传不算、没有地址不算、本机已有字节不算、同一身份只算一次。 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0, n = 0;
const ok = (name, cond, detail) => {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
};

function boot() {
  const store = new Map();
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
  vm.createContext(ctx);
  for (const f of ['web/domain/ident.cjs', 'web/domain/api.js', 'web/domain/assetlib.js', 'web/domain/local.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const ctx = boot();
const AL = ctx.AssetLocal;
const keyAssets = a => (a.provider || '') + '|' + ctx.AssetLib.entryKey(a);
const keyFav = it => it.key;
const keyStudio = e => [e.provider, e.assetId || e.id || e.genId || e.taskId].join('|');

const UP = (n) => 'https://cdn.example.com/results/' + n + '.mp4?Expires=1790000000&Signature=abc';
const fixture = [
  { provider: 'p1', assetId: 'a1', src: UP('a1'), key: 'p1|a1' },
  { provider: 'p1', assetId: 'a1', src: UP('a1'), key: 'p1|a1' },                 // 同一身份第二次出现
  { provider: 'p2', assetId: 'a2', src: UP('a2'), key: 'p2|a2' },
  { provider: 'p1', assetId: 'la_local', src: '/asset/la_local', key: 'p1|la_local' }, // 本机已有字节
  { provider: 'p1', assetId: 'a4', src: '', key: 'p1|a4' },                       // 没有地址
  { provider: 'local', kind: 'local', src: 'blob:x', key: 'local|1' },            // 本地上传
  { provider: 'p3', assetId: 'a5', src: UP('a5'), fromLocal: true, key: 'p3|a5' },// 本机自产
];
const run = keyOf => AL.pullPlan(fixture, { keyOf });
const a = run(keyAssets), f = run(keyFav), s = run(keyStudio);
const sig = list => list.map(e => e.src || e.dl || e.rawSrc || e.media || e.url);
ok('三页喂同一份 fixture，plan 逐条相等',
  JSON.stringify(sig(a)) === JSON.stringify(sig(f)) && JSON.stringify(sig(f)) === JSON.stringify(sig(s)),
  JSON.stringify([sig(a), sig(f), sig(s)]));
ok('只剩两条（a1 去重、a2 一条）', a.length === 2, String(a.length));
ok('本机已有字节不算', !a.some(e => e.assetId === 'la_local'));
ok('没有地址不算', !a.some(e => e.assetId === 'a4'));
ok('本地上传 / 本机自产不算', !a.some(e => e.kind === 'local' || e.fromLocal));
ok('返回的是新数组，改它不动输入', (() => { const out = run(keyFav); out.push({}); return fixture.length === 7; })());
ok('不传 keyOf 也能按公共身份去重', AL.pullPlan(fixture, {}).length === 2, String(AL.pullPlan(fixture, {}).length));
ok('空输入给空数组', Array.isArray(AL.pullPlan(null, {})) && AL.pullPlan(null, {}).length === 0);
ok('pullBar 返回同一批并写按钮计数', (() => {
  const b = { dataset: {}, disabled: false, title: '', innerHTML: '' };
  const r = AL.pullBar(b, a, { what: '产物' });
  return r === a && String(b.innerHTML).includes('（2）');
})(), String((() => { const b = { dataset: {}, disabled: false, title: '', innerHTML: '' }; AL.pullBar(b, a, {}); return b.innerHTML; })()));

console.log(bad ? '\n✗ ' + bad + ' 项未通过（共 ' + n + ' 项）' : '\n✓ ' + n + ' 项，0 项未通过');
process.exit(bad ? 1 : 0);
