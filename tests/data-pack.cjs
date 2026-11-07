/* 整包备份的格式判据：版本闸门、导入前摘要、写入失败不许静默。
   用 vm 把 web/ui/datasync.js 当经典脚本跑起来（它是 IIFE，挂 window.DataSync），
   依赖全给最小替身：不开网络、不碰真实 localStorage / IndexedDB。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'web/ui/datasync.js'), 'utf8');
let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('  ✗ ' + msg); } };
const packOf = (over = {}) => Object.assign({
  type: 'ai-workbench-backup', version: 1, ts: '2026-11-06T00:00:00.000Z',
  localStorage: {}, indexedDB: {},
}, over);

function load(opts = {}) {
  const store = new Map(Object.entries(opts.local || {}));
  const localStorage = {
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] === undefined ? null : [...store.keys()][i]; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
  const Kv = {
    TARGETS: {},
    async entries() { return []; },
    async open() { return opts.openOk !== false; },
    async put() { if (opts.putFail) throw new Error('quota'); },
  };
  const ctx = {
    window: {
      UI_PREFS: { keys: () => ['sk_theme'] },
      LS: { get: k => localStorage.getItem(k) },
      Kv, Net: {}, Toast: {}, Store: {}, PromptLog: null,
      b64Bytes: () => new Uint8Array(),
      addEventListener() {},
    },
    Kv, localStorage,
    /* 写入失败是判据特意造的，别把预期内的 warn 混进 all.cjs 的输出缓冲。 */
    console: { warn() {}, log() {}, error() {} },
    document: { readyState: 'loading', addEventListener() {} },
    setTimeout() {},
    Blob: class {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'web/ui/datasync.js' });
  return { DS: ctx.window.DataSync, store };
}

(async () => {
  /* ---------- ① 版本闸门：只认当前这一版，高版本 / 没版本 / 别的格式一律拒 ---------- */
  const a = load();
  ok(typeof a.DS.assertPack === 'function', 'DataSync 没有 assertPack');
  ok(a.DS.assertPack(packOf()) === undefined, 'v1 备份被自己的闸门挡住了');
  const rejects = [
    [packOf({ version: 2 }), '更新版本'],
    [{ type: 'ai-workbench-backup' }, '缺少可识别的格式版本'],
    [{ type: 'other', version: 1 }, '不是本工具导出的备份文件'],
  ];
  for (const [p, want] of rejects) {
    let msg = '';
    try { a.DS.assertPack(p); } catch (e) { msg = e.message || ''; }
    ok(msg.includes(want), '版本闸门该说「' + want + '」，实际：' + (msg || '没抛错'));
  }
  /* 静态：导出写的是同一枚常量，导入不许出现「读不到就当旧版」的双读 */
  ok(/version:\s*PACK_VERSION/.test(src), 'exportAll 还在写死 version（版本真相分成两份）');
  ok(/this\.assertPack\(pack\)/.test(src), 'importAll 没有走格式闸门');
  ok(!/version\s*\|\|\s*1/.test(src), '出现了「version 读不到就当 1」的兼容双读');

  /* ---------- ② 未来版本的包：一个字节都不许写 ---------- */
  const b = load({ local: { sk_model_old: '旧值' } });
  let refused = '';
  try {
    await b.DS.importAll(packOf({ version: 2, localStorage: { sk_model_old: '新值' } }));
  } catch (e) { refused = e.message || ''; }
  ok(refused.includes('更新版本'), '未来版本的包被 importAll 放行了');
  ok(b.store.get('sk_model_old') === '旧值', '拒绝导入时本机数据被改了（闸门没兜住写入口）');

  /* ---------- ③ 差异摘要：说清覆盖什么、保留什么、归档同名不覆盖 ---------- */
  const c = load({ local: { sk_model_extra: '留着我', sk_theme: 'dark' } });
  const p = packOf({
    localStorage: { sk_theme: 'light', sk_model_a: 'x' },
    indexedDB: { 'imago/workspace': [['w1', { a: 1 }], ['w2', { a: 2 }]] },
    prompts: { files: [1, 2, 3] },
  });
  const d = c.DS.describePack(p);
  ok(d.ls === 2 && d.tables === 1 && d.rows === 2 && d.prompts === 3,
    '差异摘要的数不对（' + JSON.stringify(d) + '）');
  ok(d.kept === 1, '没算出「不在备份里的当前数据」有几项（实际 ' + d.kept + '）');
  for (const phrase of ['v1', '将覆盖', '同名不覆盖', '会保留，不会被删']) {
    ok(d.text.includes(phrase), '差异摘要少了「' + phrase + '」：' + d.text);
  }
  ok(!/undefined|NaN/.test(d.text), '差异摘要里混进了 undefined / NaN');

  /* ---------- ④ 导出包带版本 ---------- */
  const e = load();
  const out = await e.DS.exportAll(false, false);
  ok(out.type === 'ai-workbench-backup' && out.version === 1, '导出的包没带正确的 type / version');

  /* ---------- ⑤ 写入失败要报数，不能只回成功条数 ---------- */
  const f = load({ local: {}, putFail: true });
  const r = await f.DS.importAll(packOf({
    localStorage: { sk_theme: 'light' },
    indexedDB: { 'imago/workspace': [['w1', { a: 1 }]] },
  }));
  ok(r.localStorage === 1, 'localStorage 恢复条数不对：' + r.localStorage);
  ok(r.failed === 1, 'IndexedDB 写失败被吞了（failed=' + r.failed + '）');
  ok(typeof r.failed === 'number', 'importAll 回执里没有 failed');

  /* ---------- ⑥ 设置页接线：确认框之前先过闸门，回执要说失败 ---------- */
  const set = fs.readFileSync(path.join(root, 'web/pages/settings.js'), 'utf8');
  ok(/DataSync\.assertPack\(pack\)/.test(set), '设置页没在弹确认框之前过版本闸门');
  ok(/describePack\(pack\)/.test(set), '确认框没展示差异摘要');
  ok(/res\.failed/.test(set), '导入回执没把失败条数说出来');

  console.log(bad ? '\n✗ 整包备份格式：' + bad + ' / ' + n + ' 条对不上'
    : '\n✓ 整包备份格式：' + n + ' 条判据通过');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('整包备份判据自身出错：', e); process.exit(1); });
