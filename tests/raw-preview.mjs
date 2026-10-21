#!/usr/bin/env node
/* 发送前预览（dry-run）的判据 —— 「原始请求」这一族的核心保证：
     ① 预览与实发**同源**：同一份输入，两边拼出的请求体逐字节相同；
     ② 预览**不发任何网络请求**；
     ③ 要上传的槽位在预览里是**占位符**，不触发上传；
     ④ 展示形状（snapOf）在预览与实发一致（dataURL 压摘要、无密钥）。

   为什么这些必须钉死：预览的全部价值就是「用户能据此确认实际发出的提示词与配置」，
   一旦预览与实发走岔（多一处、少一处、形状不同），这个功能就变成了**骗人的界面**。
   而 ② 与 ③ 漏一条就会在「只是看一眼」的时候真的花钱（上传到平台占配额）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

/* 一个最小但够用的沙箱：api.js 是经典脚本，挂 window.Api。
   fetch 被记数 —— 判据要断言「预览一个网络请求都没发」。 */
function boot() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    get length() { return store.size; },
    key: i => [...store.keys()][i],
  };
  const calls = { fetch: 0, lastUrl: '' };
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
    fetch: (u) => { calls.fetch++; calls.lastUrl = String(u); return Promise.reject(new Error('no net')); },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Blob: class {}, FileReader: class {},
    CustomEvent: class { constructor(t, x) { this.type = t; this.detail = x && x.detail; } },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
  const events = [];
  ctx.dispatchEvent = (e) => { events.push(e); };
  ctx.URL.revokeObjectURL = () => {}; ctx.URL.createObjectURL = () => 'blob:x';
  vm.createContext(ctx);
  /* api.js 依赖 window.MediaId（ident.cjs 是 UMD，浏览器挂 window.MediaId）——
     与 tests/local-first.cjs 同一份加载顺序。 */
  vm.runInContext(read('web/domain/ident.cjs'), ctx, { filename: 'web/domain/ident.cjs' });
  /* Capabilities（capabilities.js 是 ESM，浏览器里由别的脚本先挂上）：
     判据只用得到「顶层开关/形状字段看得见」这一小面，给一份最小实现即可 ——
     真实的可见性判据由 tests/providers-validate.cjs 那一族守着。 */
  ctx.Capabilities = {
    fieldState: () => ({ hidden: false }),
    shapeFieldState: () => ({ shown: true }),
  };
  vm.runInContext(read('web/domain/api.js'), ctx, { filename: 'web/domain/api.js' });
  return { ctx, calls, events, Api: ctx.Api };
}

/* 一个假的平台声明：body 映射 + 一个要上传的参考图槽位 + 一个顶层开关。 */
function fakeProv() {
  return {
    id: 'demo', name: '演示家', displayName: '演示家',
    relay: '/demo', base: 'https://api.example.com',
    endpoints: { create: '/create', models: '/models' },
    create: {
      endpoint: 'create',
      body: { model: 'model', prompt: 'prompt', size: 'size' },
      topBools: { optimize_prompt: { label: '平台润色' } },
      /* 声明了嵌套落点：没被点名、又没被 topBools/shapeFields 认领的参数进 `parameters`，
         不混进顶层（那是 createBody 里 `rest` 那一支的判据）。 */
      nest: { parameters: [['quality', 'quality']] },
      inputTemplates: {
        reference_image: { to: 'reference_images', many: true, needsUpload: true, tmpl: { image: '$assetId' } },
        first_frame: { to: 'first_frame', needsUpload: false, tmpl: { url: '$url' } },
      },
    },
  };
}

/* ① 预览与实发同源：同一份 fields，两边拼出的体逐字节相同。 */
{
  const { ctx, calls, Api } = boot();
  const prov = fakeProv();
  const fields = {
    model: 'demo/one', prompt: '黄昏的河岸，一个撑伞的人走过',
    size: '1280x720', params: { optimize_prompt: true },
    inputEntries: [{ role: 'reference_image', assetId: 'asset_123' }],
  };
  const body = Api.buildBody(prov, fields);
  const pv = Api.preview(prov, 'create', fields);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pv.body)),
    JSON.parse(JSON.stringify(Api.snapOf(body))),
    '预览的请求体必须与 buildBody 拼出来的那份逐字节相同'
  );
  /* 预览自己也不能发请求（buildBody / preview 都是纯算）。 */
  assert.equal(calls.fetch, 0, '预览不许发网络请求');
  assert.ok(pv.path.includes('/create'), '预览要给出将要打的路径：' + pv.path);
  assert.equal(pv.method, 'POST');
}

/* ② preview 与 create 走的是同一段拼体：把 buildBody 换成 create 里的那一行也不该有差别。
      这里用一个「记录被调用过的 body」的假 request 来验证 create 用的就是 buildBody 的结果。 */
{
  const { ctx, Api } = boot();
  const prov = fakeProv();
  let seen = null;
  const origRequest = Api.request;
  Api.request = async (p, ep, opts) => { seen = opts.body; return {}; };
  const fields = { model: 'demo/one', prompt: '河岸', inputEntries: [{ role: 'reference_image', assetId: 'a1' }] };
  await Api.create(prov, fields);
  Api.request = origRequest;
  assert.ok(seen, 'create 应当走 request');
  const pv = Api.preview(prov, 'create', fields);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pv.body)),
    JSON.parse(JSON.stringify(Api.snapOf(seen))),
    'create 真正发出去的体，必须与 preview 显示的那份相同'
  );
}

/* ③ 要上传的槽位在预览里是占位符：不带真实资产号，也不该触发上传。 */
{
  const { ctx, calls, Api } = boot();
  const prov = fakeProv();
  const pv = Api.preview(prov, 'create', {
    model: 'demo/one', prompt: '河岸',
    inputEntries: [{ role: 'reference_image', placeholder: '<待上传：参考图 1>' }],
  });
  const txt = JSON.stringify(pv.body);
  assert.match(txt, /待上传/, '占位说明必须出现在预览的请求体里：' + txt);
  assert.doesNotMatch(txt, /asset_\d/, '预览里不该出现真实资产号');
  assert.equal(calls.fetch, 0, '预览不许发网络请求（上传更是绝对不行）');
  /* 形状与真发一致：落点、数组性都照声明来。 */
  const refs = pv.body.reference_images;
  assert.ok(Array.isArray(refs), 'reference_images 按声明是数组');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].image, '<待上传：参考图 1>');
}

/* ④ 展示形状：dataURL 压成摘要、不含密钥/请求头。 */
{
  const { ctx, Api } = boot();
  const snap = Api.snapOf({
    prompt: '一个很长很长的提示词'.repeat(50),
    img: 'data:image/png;base64,' + 'A'.repeat(4000),
    headers: { Authorization: 'Bearer sk-secret' },
    api_key: 'sk-secret2',
    'Idempotency-Key': 'k-123',
    nested: { cookie: 'x', keep: 'y' },
  });
  assert.match(String(snap.img), /^<dataURL image\/png/, 'dataURL 要压成摘要：' + snap.img);
  assert.equal(snap.headers, undefined, 'headers 不许进展示');
  assert.equal(snap.api_key, undefined, 'api_key 不许进展示');
  assert.equal(snap['Idempotency-Key'], undefined, '幂等键不许进展示');
  assert.equal(snap.nested.keep, 'y', '别的字段照旧');
  assert.equal(snap.nested.cookie, undefined, 'cookie 不许进展示');
}

/* ⑤ 顶层开关：声明过的开关在**顶层**（两边一致）；没声明的字段不混进顶层，
      而是按声明落进嵌套的 parameters（那是既有行为，preview 与 create 一致即可）。 */
{
  const { ctx, Api } = boot();
  const prov = fakeProv();
  const pv = Api.preview(prov, 'create', { model: 'demo/one', prompt: 'x', params: { optimize_prompt: true } });
  assert.equal(pv.body.optimize_prompt, true, '声明过的顶层开关要进体');
  const pv2 = Api.preview(prov, 'create', { model: 'demo/one', prompt: 'x', params: { 未声明的: 'v' } });
  assert.equal(pv2.body['未声明的'], undefined, '没声明的字段不许混进顶层');
  assert.equal(pv2.body.optimize_prompt, undefined, '没给值的顶层开关不发');
}

/* ⑥ preview 算不出来时**抛**（不返回空 JSON）：
      空 JSON 会被读成「这次没有请求体」，那是骗人。
      平台压根没声明怎么提交（`create` 缺失）时，`createBody` 当场抛 —— preview 走同一条路。 */
{
  const { ctx, Api } = boot();
  let threw = false;
  try { Api.preview({ id: 'x', name: '没声明的那家' }, 'create', { model: 'm' }); } catch (e) { threw = true; }
  assert.ok(threw, '没有声明怎么提交时 preview 应当抛错');
}

console.log('✓ 发送前预览：与实发同源 / 不发网络请求 / 占位符 / 展示形状');
