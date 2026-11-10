/* 整包备份的格式判据（v2）：版本闸门、服务端快照、导入前摘要、零写入与失败报数。
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
/* v2 包里的 `server` 段：/backup/export 出的整份状态快照。
   state / checksum 这些字段是闸门认的，prompts.files 是摘要数的。 */
const srvPack = (over = {}) => Object.assign({
  version: 2, ts: '2026-11-07T00:00:00.000Z', checksum: 'sha256-probe',
  state: { sk_theme: { body: 'dark', size: 4, mtime: 1 }, sk_key_p1: { body: 'x', size: 1, mtime: 2 } },
  assetsIndex: null,
  prompts: { files: [{ name: 'a.md', text: 'A' }, { name: 'b.md', text: 'B' }], skipped: 0, bytes: 2 },
  cloud: { state: null, baseline: null }, legacyBaks: null, key: '',
}, over);
const packOf = (over = {}) => Object.assign({
  type: 'ai-workbench-backup', version: 2, ts: '2026-11-07T00:00:00.000Z',
  localStorage: {}, indexedDB: {}, server: srvPack(),
}, over);

function load(opts = {}) {
  const store = new Map(Object.entries(opts.local || {}));
  const ops = [];                       // 真实写入与备份请求的先后顺序
  const localStorage = {
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] === undefined ? null : [...store.keys()][i]; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { ops.push('ls:' + k); store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
  const Kv = {
    TARGETS: {},
    async entries() { return []; },
    async open() { return opts.openOk !== false; },
    async put() { if (opts.putFail) throw new Error('quota'); },
  };
  const Net = {
    async json(url, rq) {
      ops.push('net:' + url);
      if (url === '/backup/export') {
        if (opts.serverFail) throw new Error('代理没在运行');
        return { ok: true, pack: srvPack() };
      }
      if (url === '/backup/import') {
        const body = rq && rq.body ? JSON.parse(rq.body) : {};
        if (opts.importFail || (body.pack && body.pack.__checksumBroken)) {
          const e = new Error('整包备份校验和对不上，已拒绝导入'); e.status = 500; throw e;
        }
        return { ok: true, written: 2, failed: 0, promptsRestored: 2, message: '已从备份恢复 2 项业务键' };
      }
      return {};
    },
  };
  const ctx = {
    window: {
      UI_PREFS: { syncOf: k => k === 'sk_theme' || k.startsWith('sk_model_') },
      LS: { get: k => localStorage.getItem(k) },
      Kv, Net, Toast: {}, Store: {}, PromptLog: null,
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
  return { DS: ctx.window.DataSync, store, ops };
}

(async () => {
  /* ---------- ① 版本闸门：只认 v2，高版本 / 旧版 / 没版本 / 缺服务端段一律拒 ---------- */
  const a = load();
  ok(typeof a.DS.assertPack === 'function', 'DataSync 没有 assertPack');
  ok(a.DS.assertPack(packOf()) === undefined, 'v2 备份被自己的闸门挡住了');
  const rejects = [
    [packOf({ version: 1 }), '旧版 v1'],
    [packOf({ version: 3 }), '更新版本'],
    [{ type: 'ai-workbench-backup' }, '缺少可识别的格式版本'],
    [{ type: 'other', version: 2 }, '不是本工具导出的备份文件'],
    [packOf({ server: null }), '缺少服务端快照'],
    [packOf({ server: srvPack({ checksum: null }) }), '缺少服务端快照'],
  ];
  for (const [p, want] of rejects) {
    let msg = '';
    try { a.DS.assertPack(p); } catch (e) { msg = e.message || ''; }
    ok(msg.includes(want), '版本闸门该说「' + want + '」，实际：' + (msg || '没抛错'));
  }
  /* 静态：导出写的是同一枚常量，导入不许出现「读不到就当旧版」的双读；
     提示词归档只从服务端快照带一份，不再有 PromptLog 的第二条导出路径。 */
  ok(/version:\s*PACK_VERSION/.test(src), 'exportAll 还在写死 version（版本真相分成两份）');
  ok(/this\.assertPack\(pack\)/.test(src), 'importAll 没有走格式闸门');
  ok(!/version\s*\|\|\s*1/.test(src), '出现了「version 读不到就当 1」的兼容双读');
  ok(!/PromptLog\.exportAll/.test(src), '提示词归档又从 PromptLog 导了第二份');
  ok(/\/backup\/'\s*\+\s*cmd/.test(src), '备份端点字符串没有收进唯一的 backupCall');
  ok(/const\s+PACK_VERSION\s*=\s*2/.test(src), 'PACK_VERSION 没升到 2');

  /* ---------- ② 拒绝导入时一个字节都不许写：旧版包 + 校验和不通过的服务端段 ---------- */
  const b = load({ local: { sk_model_old: '旧值' } });
  let refused = '';
  try {
    await b.DS.importAll(packOf({ version: 1, localStorage: { sk_model_old: '新值' } }));
  } catch (e) { refused = e.message || ''; }
  ok(refused.includes('旧版 v1'), '旧版包被 importAll 放行了');
  ok(b.store.get('sk_model_old') === '旧值', '拒绝导入时本机数据被改了（闸门没兜住写入口）');
  ok(b.ops.length === 0, '被拒的包居然还发了请求 / 写了本机（' + b.ops.join('、') + '）');

  const b2 = load({ local: { sk_model_old: '旧值' } });
  let refused2 = '';
  try {
    await b2.DS.importAll(packOf({ localStorage: { sk_model_old: '新值' },
      server: srvPack({ __checksumBroken: true }) }));
  } catch (e) { refused2 = e.message || ''; }
  ok(refused2.includes('校验和'), '服务端校验和不通过时没有把错误报上来');
  ok(b2.store.get('sk_model_old') === '旧值', '服务端校验没过，浏览器那半截却已经写了');
  ok(b2.ops[0] === 'net:/backup/import', '没有先过服务端校验就动本机数据（顺序：' + b2.ops.join('、') + '）');

  /* ---------- ③ 差异摘要：说清覆盖什么、保留什么、归档同名不覆盖 ---------- */
  const c = load({ local: { sk_model_extra: '留着我', sk_theme: 'dark' } });
  const p = packOf({
    localStorage: { sk_theme: 'light', sk_model_a: 'x' },
    indexedDB: { 'imago/workspace': [['w1', { a: 1 }], ['w2', { a: 2 }]] },
    server: srvPack({ prompts: { files: [1, 2, 3], skipped: 0, bytes: 3 } }),
  });
  const d = c.DS.describePack(p);
  ok(d.ls === 2 && d.tables === 1 && d.rows === 2 && d.prompts === 3 && d.serverKeys === 2,
    '差异摘要的数不对（' + JSON.stringify(d) + '）');
  ok(d.kept === 1, '没算出「不在备份里的当前数据」有几项（实际 ' + d.kept + '）');
  for (const phrase of ['v2', '将覆盖', '服务端业务键', '同名不覆盖', '会保留，不会被删', '校验和']) {
    ok(d.text.includes(phrase), '差异摘要少了「' + phrase + '」：' + d.text);
  }
  ok(!/undefined|NaN/.test(d.text), '差异摘要里混进了 undefined / NaN');

  /* ---------- ④ 导出包带 v2 版本 + 服务端快照 ---------- */
  const e = load();
  const out = await e.DS.exportAll(false);
  ok(out.type === 'ai-workbench-backup' && out.version === 2, '导出的包没带正确的 type / version');
  ok(out.server && out.server.version === 2 && out.server.state && out.server.checksum,
    '导出的包没带服务端快照（不是完整整包）');
  ok(e.ops[0] === 'net:/backup/export', '导出没有先取服务端快照');
  ok(e.DS.assertPack(out) === undefined, '自己导出的包过不了自己的闸门');
  /* 服务端取不到时宁可导出失败，也不吐一个少一半的包 */
  const e2 = load({ serverFail: true });
  let expErr = '';
  try { await e2.DS.exportAll(false); } catch (x) { expErr = x.message || ''; }
  ok(/服务端快照读不出来|代理没在运行/.test(expErr), '服务端快照取不到却照样报导出成功');

  /* ---------- ⑤ 写入失败要报数，不能只回成功条数 ---------- */
  const f = load({ local: {}, putFail: true });
  const r = await f.DS.importAll(packOf({
    localStorage: { sk_theme: 'light' },
    indexedDB: { 'imago/workspace': [['w1', { a: 1 }]] },
  }));
  ok(r.localStorage === 1, 'localStorage 恢复条数不对：' + r.localStorage);
  ok(r.failed === 1, 'IndexedDB 写失败被吞了（failed=' + r.failed + '）');
  ok(typeof r.failed === 'number', 'importAll 回执里没有 failed');
  ok(r.server && r.server.written === 2 && r.server.ok === true, '回执没把服务端恢复的条数带出来');

  /* ---------- ⑥ 设置页接线：确认框之前先过闸门，回执要说失败 ---------- */
  const set = fs.readFileSync(path.join(root, 'web/pages/settings.js'), 'utf8');
  ok(/DataSync\.assertPack\(pack\)/.test(set), '设置页没在弹确认框之前过版本闸门');
  ok(/describePack\(pack\)/.test(set), '确认框没展示差异摘要');
  ok(/res\.failed/.test(set), '导入回执没把失败条数说出来');

  console.log(bad ? '\n✗ 整包备份格式：' + bad + ' / ' + n + ' 条对不上'
    : '\n✓ 整包备份格式：' + n + ' 条判据通过');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('整包备份判据自身出错：', e); process.exit(1); });
