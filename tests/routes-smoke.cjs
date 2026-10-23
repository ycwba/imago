#!/usr/bin/env node
/* 路由冒烟判据（常驻）—— 跑法：`node tests/routes-smoke.cjs`
   治的是 `pick-dir` 那一类 bug：路由工厂的 ctx 少注入一个 key、或函数体里用了一个没解构
   出来的变量，功能就是坏的，而全绿的单测一条都不会红。
   做法：
     1. 对 server/routes/*.js 的每个工厂（外加 data / prompts / cloud 三条 store 路由），
        从 server/ 顶层的**真实注入点**读出「app 给了哪些 key」（tests/support.cjs 的 findWiring，
        app.js 拆到 server/wiring 一类的新文件后照样找得到）；
     2. 用这份 key 清单造 ctx，外面套一层 Proxy：路由读到一个注入点没给的 key → 当场抛
        「路由要的 ctx.xxx 没注入」；
     3. 假 req/res 走一遍表里的每个端点，断言：不抛 ReferenceError / TypeError、有响应、状态码合理；
     4. 每个模块都得在 server/app.js 的 ROUTE_TABLE 里有一行（把分发从 if 链改成表，
        「新写一条路由忘了挂表」就是这一条判据治的：注入点找得到、单跑也通，只有从表上查才红）；
     5. 静态对账整棵依赖树的两个方向（搬域时真踩出来的那一类）：
        「工厂解构了、调用点没给」→ 拿到的是 undefined，界面一格空数；
        「工厂用了 app.js 的配置名、本文件既没声明也没解构」→ 自由变量，跑到那一行才 ReferenceError。
        两条都只在源码上比名单，不发一次请求；这类漏注入在 `node --check`、语法判据与端点冒烟里
        都是全绿的 —— 只有这两条对账能在起进程之前拦住。
   依赖全部是假对象：不碰网络（上游一律回 example.com 的假 JSON）、不起真子进程（spawn 只记账）、
   不写用户目录（写盘类落点全部指到 os.tmpdir 的探针目录，跑完整包删掉）。
   目标：全部端点 2 秒内跑完。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const S = require('./support.cjs');

const t0 = Date.now();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-routes-probe-'));
function tmpDir(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
};

/* ---------- 假 req / res ---------- */
function mkReq(hit) {
  const req = new EventEmitter();
  req.url = hit.url;
  req.method = hit.method || 'GET';
  req.headers = Object.assign(
    { host: '127.0.0.1:5175', origin: 'http://127.0.0.1:5175', cookie: 'wb_session=probe' },
    hit.headers || {});
  req.socket = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' };
  req.connection = req.socket;
  req.httpVersion = '1.1';
  req.destroy = () => { req.destroyed = true; };
  req.pause = req.resume = () => {};
  req.pipe = dest => { dest.end(Buffer.alloc(0)); return dest; };
  req.read = () => null;
  /* 用例带的请求体挂在 req 上（不挂在假件闭包里）：工厂类路由的 ctx 是**构造那一次**建的，
     那时还没有用例 —— 挂在闭包里就等于每条 POST 都读到 `{}`，测的从来不是那条 body。 */
  if (hit.body != null) req.probeBody = String(hit.body);
  return req;
}
function mkRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.chunks = [];
  res.body = '';
  res.headersSent = false;
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  /* 不合理的回话**记账而不抛**：这些调用点常在 response 回调 / Promise 链里，
     抛出去就掉进 uncaughtException，判据会整包崩而不是指出这一条红。 */
  res.violations = [];
  res.writeHead = (code, h) => {
    if (res.headersSent) res.violations.push('writeHead 调了第二次（这一次是 ' + code + '）');
    if (!Number.isInteger(code) || code < 100 || code > 599) res.violations.push('状态码不合理：' + code);
    res.statusCode = Number.isInteger(code) ? code : res.statusCode;
    Object.assign(res.headers, h || {});
    res.headersSent = true;
    return res;
  };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.getHeader = k => res.headers[k];
  res.removeHeader = k => { delete res.headers[k]; };
  res.flushHeaders = () => {};
  res.cork = res.uncork = () => {};
  res.write = c => { if (c) res.chunks.push(Buffer.from(c)); return true; };
  res.end = c => {
    if (res.writableEnded) res.violations.push('res.end 调了第二次');
    if (c) res.chunks.push(Buffer.from(c));
    res.body = Buffer.concat(res.chunks).toString('utf8');
    res.writableEnded = true;
    res.writableFinished = true;
    setImmediate(() => { try { res.emit('finish'); res.emit('close'); } catch (e) {} });
    return res;
  };
  res.destroy = () => { if (!res.writableEnded) { res.destroyed = true; setImmediate(() => res.emit('close')); } return res; };
  res.abort = res.destroy;
  res.resume = () => res;
  res.response = res;
  return res;
}

/* ---------- 上游假件：只够路由那一层用，一个真字节都不发出去 ---------- */
const upState = { status: 200, body: '' };
function fakeUp(status, body) {
  const up = new EventEmitter();
  up.statusCode = status;
  up.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
  up.destroy = () => {}; up.setTimeout = () => up; up.resume = () => up; up.setEncoding = () => up;
  up.pipe = dest => { setTimeout(() => { dest.write(Buffer.from(body)); dest.end(); }, 0); return dest; };
  /* data/end 排到一个 macrotask：路由是在 response 回调里**同步**注册监听的，
     同一 tick 就发数据的话第一个监听会漏掉。 */
  setTimeout(() => { up.emit('data', Buffer.from(body)); up.emit('end'); }, 0);
  return up;
}
function upBodyFor(url, method) {
  if (upState.body) return upState.body;
  const u = String(url || '');
  if (/\/models\b/.test(u)) return JSON.stringify({ data: [{ id: 'm1', name: 'M1' }] });
  if (/credits|balance/.test(u)) return JSON.stringify({ total: 100 });
  if (method === 'POST') return JSON.stringify({ id: 'job_probe', status: 'queued' });
  return JSON.stringify({ id: 'job_probe', status: 'succeeded' });
}
function fakeUpRequest(url, opts, cb) {
  const r = new EventEmitter();
  const o = opts || {};
  r.setHeader = () => r; r.removeHeader = () => r; r.write = () => true;
  r.setTimeout = (ms, fn) => { if (fn) r.once('timeout', fn); return r; };
  r.setNoDelay = r.setSocketKeepAlive = () => {};
  r.abort = r.destroy = () => { r.destroyed = true; return r; };
  r.end = () => {
    if (r.destroyed) return r;
    /* `up` 必须在这个 macrotask **里面**造。fakeUp 一造好就把 data/end 排进定时器；调用点的监听
       要到 cb / response 回调里才同步挂上。在外面造就等于把两件事的先后交给
       「setImmediate 与 setTimeout(0) 谁先跑」—— 那是 Node 明确不保证的顺序，
       详情缓存那一条支因此红过（同一份判据连跑四次红两次，产品代码一个字没错）。 */
    setImmediate(() => {
      if (r.destroyed) return;
      const up = fakeUp(upState.status || 200, upBodyFor(url, o.method || 'GET'));
      if (typeof cb === 'function') cb(up);
      r.emit('response', up);
    });
    /* 真实 Node 在响应走完后会补一个 close；调用点（registry 那条 25 秒墙钟）靠它清表。
       这里 delay 一点、只发一次，免得那条 25 秒的 timer 挂着让判据本身跑不完。 */
    setTimeout(() => { if (!r.destroyed && !r.closed) { r.closed = true; r.emit('close'); } }, 5);
    return r;
  };
  /* 故意**不**自动 end：真实 `https.request` 不 end 就一个字节都不发。
     漏写 `rq.end()` 的那一类（GET 建完请求就挂在那儿等墙钟超时）只有在这里保持
     「不 end 就没响应」才测得出来 —— 假件替调用点补一句 end，判据当场变成假绿。 */
  return r;
}
const spawned = [];
/* noteFault 记的账：/client-error 那条要验「送到代理的到底是哪一类」，
   状态码 200 只能证明路由接了，证明不了它真进健康账。 */
const faults = [];
function fakeChild(code, stdout, stderr) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { write: () => {}, end: () => {} };
  c.kill = () => {}; c.pid = 4242; c.exitCode = code;
  setTimeout(() => {
    if (stdout) c.stdout.emit('data', Buffer.from(stdout));
    if (stderr) c.stderr.emit('data', Buffer.from(stderr));
    c.stdout.emit('end'); c.stderr.emit('end');
    c.emit('close', code, null);
    c.emit('exit', code, null);
  }, 0);
  return c;
}

/* ---------- 注入点里那些 key 的假件 ---------- */
/* 统一形状：每条登记的都是「app 实际注入的那个东西」，写成 `hit => 值`。
   app 注函数就 `hit => (...args) => 返回值`，注常量就 `hit => 常量`。
   形状写错判据会以 TypeError 红，那也是它有用的一部分（真跑的是路由里那句调用）。 */
const PROVIDERS = [{
  id: 'smoke', keyId: 'smoke', name: '冒烟平台', kind: 'image', relay: '/smoke',
  base: 'https://example.com/api', keyEnv: 'SMOKE_KEY', site: 'https://example.com',
  endpoints: { create: '/jobs', list: '/jobs', poll: '/jobs/:id', detail: '/jobs/:id', cancel: '/jobs/:id', credits: '/balance', models: '/models', upload: '/uploads' },
  list: { cacheTtl: 1000 }, models: [{ id: 'm1', name: 'M1', kinds: ['image'] }],
  create: { idempotencyKey: true }, inputRoles: {}, inputTemplates: {}, pricing: {},
  capabilities: { models: { m1: { ratios: ['1:1'], resolutions: ['1k'] } } },
}];
const NO_MODEL_PROVIDERS = [{
  ...PROVIDERS[0], id: 'silent', keyId: 'silent', name: '没有型号接口的家', relay: '/silent',
  endpoints: { create: '/jobs' }, models: [],
}];
const ALL_PROVIDERS = PROVIDERS.concat(NO_MODEL_PROVIDERS);
const REGISTRY_FIX = { version: 99, providers: PROVIDERS };

const asrStore = {
  settings: () => ({ revision: 1, route: 'service', language: '' }),
  rawSettings: () => ({ route: 'service', language: '' }),
  patchSettings: s => Object.assign({ revision: 2 }, s || {}),
  putJob: () => {}, job: () => null, patchJob: () => {}, removeJob: () => {},
  jobs: () => [], running: () => 0,
  /* browser-result 那一支用的三件：段落归一 / SRT 拼装 / 哈希去重，直接用真实现（纯函数，无副作用） */
  normSegments: require(S.abs('server/asr-store.js')).normSegments,
  toSrt: require(S.abs('server/asr-store.js')).toSrt,
  findByHash: () => null,
};
const searchStore = {
  settings: () => ({ revision: 1, enabled: false, provider: 'tavily', maxResults: 3 }),
  raw: () => ({ enabled: false, provider: 'tavily', maxResults: 3, model: '', baseUrl: '', apiKey: '' }),
  patch: s => Object.assign({ revision: 2 }, s || {}),
};
const skillsStore = {
  list: () => [], statePath: path.join(tmp, 'skills-state.json'),
  get: () => null, install: () => ({ id: 'sk', source: 'probe' }),
  importBundle: () => ({ id: 'sk', source: 'probe' }),
  update: () => ({ skill: { id: 'sk', source: 'probe' }, hash: 'h' }),
  listFiles: () => [], skillHash: () => 'h', readRef: () => '',
  setEnabled: () => {}, remove: () => {},
  exportBundle: () => Buffer.from('probe'), dir: () => tmpDir('skills'),
};
/* 注入点里没有、但 route 自己带兜底（`ctx.X || 默认值`）的 key：读到就给 undefined，不判红。
   登记在案，不许默默变多；app 真的下发了这个 key，就该把这一行删掉。 */
const CTX_TOLERATED = [];
const tolerated = new Map(CTX_TOLERATED.map(r => [r.id, r]));
const toleratedHit = new Set();
const unregistered = new Set();   // 注入点里有、这份表没登记假件的 key：只提示，不算红

const FAKES = {
  /* --- 通用基建 --- */
  log: () => (...a) => void a,
  noteFault: () => (kind, e, extra) => {
    faults.push({ kind: String(kind || ''), message: String((e && e.message) || e || ''), extra });
  },
  readBody: () => async (req) => Buffer.from(req && req.probeBody != null ? req.probeBody : '{}'),
  readJson: () => async (req) => { try { return JSON.parse(req && req.probeBody != null ? req.probeBody : '{}'); } catch (e) { return {}; } },
  spawn: () => (...a) => { spawned.push(typeof a[0] === 'string' ? a[0] : String((a[0] && a[0].cmd) || '')); return fakeChild(3, '', ''); },
  spawnSync: () => () => ({ status: 3, stdout: '', stderr: '' }),
  cap120: () => s => String(s == null ? '' : s).slice(0, 120),
  firstLine: () => s => String(s || '').split(/\r?\n/)[0] || '',
  safeDecode: () => s => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s == null ? '' : s); } },
  fileSafe: () => s => String(s || '').replace(/[^\w.\-]/g, '_'),
  sha1Of: () => () => 'deadbeef',
  keyOf: () => () => '',
  baseKeyOf: () => u => String(u || ''),
  dataFileOf: () => k => path.join(tmpDir('data'), String(k) + '.json'),
  dataDirPath: () => () => tmpDir('data'),
  dataDir: () => () => tmpDir('data'),
  dataList: () => () => [],
  dataWriteRaw: () => (async () => true),
  keepDataBackup: () => () => {},
  dirStamp: () => () => 'probe',
  timeText: () => () => '00:00',
  httpError: () => (kind, message) => { const e = new Error(String(message || kind)); e.kind = kind; return e; },
  /* --- 出站护栏：全是指向 example.com 的字面量，一次真的 DNS 都不做 --- */
  guardOutboundUrl: () => (async raw => {
    const s = String(raw || '');
    if (!/^https:\/\//i.test(s)) throw new Error('只允许取回公网 https 地址（回环 / 内网 / 明文 http 一律拒绝）');
    return s;
  }),
  safeOutboundUrl: () => u => (/^https:\/\//i.test(String(u || '')) ? String(u) : null),
  takeOutboundUrl: () => (async (req, res, prefix) => {
    const raw = String((req && req.url) || '');
    const i = raw.indexOf('url=');
    if (i < 0) return null;
    try { const u = decodeURIComponent(raw.slice(i + 4)); return /^https:\/\//i.test(u) ? u : null; } catch (e) { return null; }
  }),
  upRequest: () => (url, opts, cb) => fakeUpRequest(url, opts, cb),
  anyRequest: () => (url, opts, cb) => fakeUpRequest(url, opts, cb),
  failUpstream: () => (res, msg, tag) => {
    try {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((tag ? tag + '：' : '') + String(msg == null ? '' : msg));
    } catch (e) {}
  },
  pipeUpstream: () => (up, res) => { try { if (!res.writableEnded) res.end('probe'); } catch (e) {} },
  passthroughHeaders: () => (upH, o = {}) => {
    /* 形状与 app.js 那一份一致：{ st, bad, h }（调用点解构这三个名字） */
    const hh = upH || {};
    const st = (o.status >= 200 ? o.status : 502);
    const bad = st >= 400;
    const h = {
      'content-type': bad ? (hh['content-type'] || 'text/plain; charset=utf-8') : (o.okType || 'application/octet-stream'),
      'cache-control': bad ? 'no-store' : o.cacheOk,
      'accept-ranges': hh['accept-ranges'] || 'bytes',
    };
    if (o.cors) h['Access-Control-Allow-Origin'] = '*';
    if (hh['content-range']) h['Content-Range'] = hh['content-range'];
    if (hh['content-length'] && !bad) h['Content-Length'] = hh['content-length'];
    if (o.disposition) h['content-disposition'] = o.disposition;
    return { st, bad, h };
  },
  assetInfoOf: () => (async () => ({ url: 'https://example.com/x.png', mime: 'image/png' })),
  /* 资产存储声明解析出来的那一份（server/registry-config.js 的 resolveAssetStore）：
     路由只在密钥回退那一行读 keyEnv，其余字段给「按资产号换地址」的调用点用。 */
  assetStore: () => ({
    provider: 'sparkcine', base: 'https://hi.example', keyEnv: 'SPARKCINE_API_KEY',
    retrieve: '/api/open/v1/assets/{id}', urlFields: ['url'], mimeField: 'mime_type',
  }),
  s3putStream: () => (req, res) => { try { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end('{}\n'); } catch (e) {} },
  serveLocalFile: () => (req, res) => { try { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('local'); } catch (e) {} },
  resolveSrc: () => (async () => 'https://example.com/src.mp4'),
  downloadTo: () => (async (url, file) => { if (file) fs.writeFileSync(String(file), 'probe'); return 5; }),
  /* --- 本机资产：索引 / 落盘全部指向探针目录，条目一律「查无此资产」 --- */
  localAssetFile: () => () => '',
  localAssetEntry: () => () => null,
  localFileFromEntry: () => () => '',
  localMediaType: () => () => 'image',
  localAssetWhen: () => () => 0,
  localUpKey: () => u => String(u || ''),
  localUsageScan: () => (async () => ({ dirs: [], entries: 0, bytes: 0 })),
  extInUrl: () => () => 'png',
  extOfMime: () => () => 'png',
  withLocalSaveLock: () => (k, fn) => (typeof fn === 'function' ? fn() : undefined),
  /* app.js 里这两条是**同步**的（`() => indexStore.read()` 那一族），假件必须同形状 */
  localIndexRead: () => () => [],
  localIndexUpsert: () => item => item,
  /* 一张卡背后的那几条账（删除按整组收，判据与列表并卡同一份）：假件回空表，
     于是 DELETE 走的仍是「只有眼前这一条」那一路，冒烟不碰真盘。 */
  localAssetSiblings: () => () => [],
  /* 串行队列那两条（见 server/index-store.js 的 update / putInto）：假件必须真的把回调跑一次，
     否则「忘了 await」「回调里传错参数」在这一层看不见；put 反过来要求第一个参数是那张表，
     直接把 item 传进来就当场抛 —— 端点变 500，这一条判据就红。 */
  localIndexUpdate: () => fn => Promise.resolve().then(() => {
    if (typeof fn !== 'function') throw new Error('update 没收到回调');
    return fn([]);
  }),
  localIndexPut: () => (list, item) => {
    if (!Array.isArray(list)) throw new Error('putInto 拿到的不是那张表');
    if (!item || !item.id) throw new Error('putInto 少了条目');
    return true;
  },
  localIndexDrop: () => (list, id) => {
    if (!Array.isArray(list)) throw new Error('dropFrom 拿到的不是那张表');
    if (!id) throw new Error('dropFrom 少了资产号');
    return true;
  },
  localFillMissing: () => () => 0,
  whyNoSpace: () => () => null,
  /* --- 并发闸（形状抄 app.js：gate 一份对象、relayTake(gate, onSlot, opts) 当场给名额） --- */
  relayGateOf: () => p => ({
    key: String((p && (p.keyId || p.id)) || 'smoke'), name: String((p && (p.name || p.id)) || '冒烟平台'),
    inflight: 0, queue: [], 退过: 0, 等过: 0, 拒过: 0, 走掉: 0, 等超时: 0,
  }),
  relayTake: () => (g, onSlot) => {
    if (!g || typeof onSlot !== 'function') return false;
    g.inflight = (g.inflight || 0) + 1;
    let done = false;
    onSlot(() => { if (done) return; done = true; g.inflight = Math.max(0, (g.inflight || 0) - 1); });
    return true;
  },
  relayRefused: () => (res, g) => {
    if (res.headersSent) return;
    res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { message: '本地转发闸：' + ((g && g.name) || '?') + ' 排满（探针假件）', code: 'relay_queue_full' } }));
  },
  relayRetryWait: () => () => null,
  noteRelayEvent: () => () => {},
  cacheSweep: () => () => {},
  /* --- 本机资产库的落点与账 ---
     下面这几枚是 /local-assets 那一条落链要的假件：落点只有一种（库根下的类型子目录），
     既没有「再另存一份」那条路，也没有第二个落点要收编。 */
  bodyDirOf: () => () => tmpDir('save'),
  bodyDirNameOf: () => () => '图片',
  localRootDir: () => () => tmpDir('assets'),
  mintAssetId: () => () => 'la_smoke',
  newBodyPlace: () => () => ({ abs: path.join(tmpDir('save'), 'probe.png') }),
  invalidateScan: () => () => {},
  localAdopt: () => () => ({ added: [], skipped: 0 }),
  entryAbsOf: () => () => '',
  localSigOf: () => () => '',
  /* fid 由存储层现算（fileFidOf）：冒烟里不 stat 真文件，给一个固定号即可。 */
  fileFidOf: () => () => '0:0',
  localAssetPaths: () => () => [],
  localAssetRepair: () => () => null,
  /* --- 系统 / 注册表 --- */
  sysStatus: () => () => ({
    目录: { 数据: { 路径: tmpDir('data') }, 资产: { 路径: tmpDir('assets') }, 渲染: { 路径: tmpDir('renders') } },
    端口: 5175,
  }),
  registryVersion: () => 99,
  version: () => 99,
  port: () => 5175,
  providers: () => PROVIDERS,
  allProviders: () => () => ALL_PROVIDERS,
  defaults: () => ({}),
  DEFAULTS: () => ({}),
  REGISTRY: () => REGISTRY_FIX,
  caches: () => ({ listCache: new Map(), detailCache: new Map(), assetUrlCache: new Map(), capCache: new Map() }),
  detailCache: () => new Map(), listCache: () => new Map(),
  detailInflight: () => new Map(), listInflight: () => new Map(),
  DETAIL_TTL: () => 5000,
  store: () => asrStore,
  customNotice: () => ({ reason: '', dropped: [] }),
  modelPrefsNotice: () => ({ reason: '', notice: [] }),
  MODEL_PREFS_KEY: () => 'sk_model_prefs',
  LOCAL_DIR: () => tmpDir('assets'),
  RENDER_DIR: () => tmpDir('renders'),
  root: () => tmp,
  ROOT: () => tmp,
  MIME: () => MIME_MAP,
  mime: () => MIME_MAP,
  LOCAL_INDEX_MAX: () => 100,
  VOICE_MAX: () => 40,
  renderDir: () => tmpDir('renders'),
  maxAssetBytes: () => 5 * 1024 * 1024,
  maxBundleBytes: () => 20 * 1024 * 1024,
  promptCloudDir: () => () => tmpDir('prompts'),
  promptFileList: () => () => [],
};
/* 全大写常量没登记到就按名字给个中性值（*_MAX / *_TTL / *_KEY 那些） */
function looseValue(name) {
  if (/MAX$/.test(name)) return 50;
  if (/_TTL$/.test(name)) return 1000;
  if (/_KEY$/.test(name)) return 'sk_probe';
  if (/^RE_/.test(name)) return null;
  return 0;
}
function fakeForKey(key, hit) {
  const f = FAKES[key];
  if (f) return f(hit);
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) return looseValue(key);
  unregistered.add(key + '@' + ((hit && hit.file) || '?').replace(/^.*\//, ''));
  return () => undefined;   // 兜底：未登记的 key 一律当函数，调用点不会炸成 TypeError
}

/* 用注入点那份 key 清单造 ctx，外面套 Proxy：读到没注入的 key 立刻抛。 */
function buildCtx(keys, info) {
  const base = {};
  for (const k of keys) base[k] = fakeForKey(k, info);
  if (keys.includes('store')) {
    if (/asr/.test(info.file || '')) base.store = asrStore;
    else if (/search/.test(info.file || '')) base.store = searchStore;
    else if (/skills/.test(info.file || '')) base.store = skillsStore;
  }
  /* 同一个 key 在不同注入点形状不同（providers：system 注数组、asr/search 注函数）→ 按模块覆盖 */
  Object.assign(base, info.overrides || {});
  return new Proxy(base, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k === 'then' || k.startsWith('__')) return t[k];
      if (!(k in t)) {
        const id = (info.file || '') + '#' + k;
        if (tolerated.has(id)) { toleratedHit.add(id); return undefined; }
        throw new Error('路由要的 ctx.' + k + ' 没注入（注入点：' + (info.wiring || 'server/app.js') + '）');
      }
      return t[k];
    },
    has(t, k) { return k in t; },
  });
}

/* 处理器第三个及以后参数按**形参名**给（dataPath / pathname / urlObj / ctx），不写死第几位。 */
function paramNames(fn) {
  const src = String(fn);
  const m = /^(?:async\s+)?function\s*[\w$]*\s*\(([^)]*)\)/.exec(src) || /^(?:async\s+)?[\w$]+\s*\(([^)]*)\)\s*=>/.exec(src);
  if (!m) return [];
  return m[1].split(',').map(x => x.trim().replace(/[=:].*$/, '').trim()).filter(Boolean);
}
function extraArgs(params, req, mod, wiring, hit) {
  const info = () => Object.assign({ file: mod.file, wiring: wiring.file, overrides: mod.fakes || {} }, hit);
  return params.slice(2).map(p => {
    if (/^(dataPath|pathname)$/.test(p)) return req.url.split('?')[0];
    if (/^urlObj$/.test(p)) return new URL(req.url, 'http://127.0.0.1');
    if (/^ctx$/.test(p)) return buildCtx(wiring.keys, info());
    return undefined;
  });
}

const MODULES = [
  { file: 'server/routes/system.js', factory: 'createSystemRoutes' },
  { file: 'server/routes/registry.js', factory: 'createRegistryRoutes' },
  { file: 'server/routes/capabilities.js', factory: 'createCapabilities' },
  { file: 'server/routes/relay.js', factory: 'createRelayRoutes' },
  { file: 'server/routes/outbound.js', factory: 'createOutboundRoutes' },
  { file: 'server/routes/local-assets.js', factory: 'createLocalAssets' },
  { file: 'server/routes/usage.js', factory: 'createUsageRoutes' },
  { file: 'server/routes/skills.js', standalone: 'handleSkills' },
  { file: 'server/routes/fcpxml.js', standalone: 'handleFcpxml' },
  { file: 'server/routes/pick-dir.js', factory: 'createPickDirRoute' },
  { file: 'server/routes/asr.js', factory: 'createAsrRoutes', fakes: { providers: () => ALL_PROVIDERS } },
  { file: 'server/routes/models.js', factory: 'createModelsRoutes' },
  { file: 'server/routes/search.js', factory: 'createSearchRoutes', fakes: { providers: () => ALL_PROVIDERS } },
  { file: 'server/routes/static.js', standalone: 'handleStatic' },
  { file: 'server/data-store.js', factory: 'createDataStore', handler: 'handleData' },
  { file: 'server/prompts-store.js', factory: 'createPromptsStore', handler: 'handlePrompts' },
  { file: 'server/cloud-store.js', factory: 'createCloudStore', handler: 'handleCloud' },
];

const HITS = {
  'server/routes/system.js': [
    { url: '/sys-status' }, { url: '/whoami' }, { url: '/env-status' },
    { url: '/clear-cache', method: 'POST', body: '{}' },
    /* /client-error 是页面侧报错唯一的落点：光验状态码不够，
       要验它真把这一笔记进「页面报错」那一类，否则代理健康账上永远是干净的。 */
    {
      url: '/client-error', method: 'POST',
      body: JSON.stringify({ kind: 'fatal', message: '探针：页面报错', page: 'assets', where: 'at probe' }),
      check: (res, only) => {
        const f = only.faults[only.faults.length - 1];
        if (!f) return '一条都没记进健康账（noteFault 没被调用）';
        if (f.kind !== '页面报错') return '记成了「' + f.kind + '」，应该是「页面报错」';
        if (!/^\[assets\]/.test(f.message)) return '消息没带上页面名：' + f.message;
        if (!/探针：页面报错/.test(f.message)) return '消息把正文丢了：' + f.message;
        try { if (JSON.parse(res.body).counted !== true) return '回执没写 counted:true：' + res.body; } catch (e) { return '回执不是 JSON：' + res.body; }
        return '';
      },
    },
    /* 没带 message 的那一条必须 400 并且**不记账**：拿空消息占健康账的名额，
       真故障就会被淹掉（限流那两道是同一个理由）。 */
    {
      url: '/client-error', method: 'POST', body: '{}',
      check: (res, only) => (res.statusCode !== 400
        ? '状态码 ' + res.statusCode + '，应该是 400'
        : (only.faults.length ? '空消息也记进账了' : '')),
    },
    {
      url: '/client-error', method: 'POST', body: 'not json at all',
      check: res => (res.statusCode === 400 ? '' : '状态码 ' + res.statusCode + '，坏 JSON 也要 400 而不是抛'),
    },
  ],
  'server/routes/registry.js': [
    { url: '/registry' },
    /* 这一条以前只会「回个状态码」就通过：GET 上游忘了 `rq.end()` 那种挂法要等 25 秒墙钟
       才回一句「连不通」，状态码照样是 200，判据看不出来。现在验的是「真的问到型号」。 */
    {
      url: '/custom/models', method: 'POST',
      body: JSON.stringify({ shape: 'smoke', base: 'https://gw.example.com/v1', key: 'sk-probe', kind: 'image' }),
      check: res => {
        let d = null; try { d = JSON.parse(res.body); } catch (e) { return '回执不是 JSON：' + res.body; }
        if (!d || d.ok !== true) return '没问到型号：' + ((d && d.error) || res.body);
        if (!Array.isArray(d.models) || !d.models.length) return 'ok:true 却给不出型号数组';
        return '';
      },
    },
    {
      url: '/custom/models', method: 'POST', body: JSON.stringify({ shape: 'nope', base: 'https://gw.example.com/v1', key: '' }),
      check: res => (res.statusCode === 400 ? '' : '模板找不到应当 400，实际 ' + res.statusCode),
    },
  ],
  'server/routes/capabilities.js': [
    { url: '/capabilities?provider=smoke' },
    { url: '/capabilities?provider=silent' },
    { url: '/capabilities?provider=ghost' },
  ],
  'server/routes/relay.js': [
    { url: '/smoke/jobs', method: 'POST', body: JSON.stringify({ model: 'm1', prompt: 'x' }) },
    { url: '/smoke/jobs' },
    { url: '/smoke/jobs/job_abc123' },
    { url: '/smoke/credits' },
    { url: '/nope/jobs', expect: false },
  ],
  'server/routes/outbound.js': [
    { url: '/getfile?url=' + encodeURIComponent('https://example.com/a.mp4') },
    { url: '/fetch?url=' + encodeURIComponent('https://example.com/a.png') },
    { url: '/getv?url=' + encodeURIComponent('https://example.com/a.mp4') },
    { url: '/asset/la_probe' },
    /* dl=1 走 disposition 分支。以前那行拿同一句里还没赋值的 st 作判据（TDZ），必抛 → 502。 */
    { url: '/asset/la_probe?dl=1', check: res => {
      if (res.statusCode !== 200) return '带 dl=1 应当 200，实际 ' + res.statusCode;
      return /attachment/i.test(String(res.headers['content-disposition'] || ''))
        ? '' : '带 dl=1 应当回 Content-Disposition，实际没有';
    } },
    { url: '/s3put?url=' + encodeURIComponent('https://example.com/put'), method: 'POST', body: '{}' },
  ],
  'server/routes/local-assets.js': [
    { url: '/local-assets' },
    { url: '/local-assets/from-url', method: 'POST', body: JSON.stringify({ url: 'https://example.com/a.png', meta: {} }) },
    { url: '/local-assets', method: 'POST', body: JSON.stringify({ data: 'aGk=', name: 'a.png', mime: 'image/png' }) },
    { url: '/local-assets/la_probe', method: 'DELETE' },
    { url: '/nope', expect: false },
  ],
  'server/routes/usage.js': [{ url: '/assets-usage' }],
  'server/routes/skills.js': [
    { url: '/skills' },
    { url: '/skills/ghost' },
    { url: '/skills/install', method: 'POST', body: JSON.stringify({ files: [{ path: 'SKILL.md', text: '---\nid: probe\n---\n正文' }] }) },
  ],
  'server/routes/fcpxml.js': [
    { url: '/fcpxml/bundle', method: 'POST', body: JSON.stringify({ name: 'probe', clips: [{ src: '/asset/la_ghost', in: 0, out: 1 }] }) },
  ],
  'server/routes/pick-dir.js': [
    { url: '/pick-dir', method: 'POST', body: JSON.stringify({ title: '探针', start: '' }) },
  ],
  'server/routes/asr.js': [
    { url: '/asr' }, { url: '/asr/settings' },
    { url: '/asr/settings', method: 'PUT', body: JSON.stringify({ settings: { route: 'service' } }) },
    { url: '/asr/transcribe', method: 'POST', body: JSON.stringify({ route: 'service', assetId: 'la_ghost' }) },
    {
      /* 浏览器内那一路线代理跑不了：不拦的话任务照建、work() 按「非 local 即在线」默默扣一次钱，
         账上却写着 browser。 */
      url: '/asr/transcribe', method: 'POST', body: JSON.stringify({ route: 'browser', src: '/asset/la_ghost' }),
      check: res => res.statusCode === 400 ? '' : '浏览器路线该当场拒，实际 ' + res.statusCode + ' ' + String(res.body || ''),
    },
    { url: '/asr/jobs/ghost' },
    {
      url: '/asr/browser-result', method: 'POST',
      body: JSON.stringify({ segments: [{ start: 0, end: 1.2, text: '探针一句' }], language: 'zh', sourceHash: 'h1234567890abcdef', engine: '浏览器内 Whisper', media: 'probe.wav' }),
      check: res => {
        try {
          const d = JSON.parse(res.body);
          if (d.state !== 'done') return '落账不是 done：' + res.body;
          if (!d.jobId || d.jobId !== d.id) return '回执缺 jobId（wait(r.jobId) 的调用方要靠它）';
          if (!/探针一句/.test(d.srt)) return 'SRT 没按同一份 toSrt 出：' + String(d.srt);
        } catch (e) { return '回执不是 JSON：' + res.body; }
        return '';
      },
    },
    {
      url: '/asr/browser-result', method: 'POST', body: JSON.stringify({ segments: [] }),
      check: res => res.statusCode === 400 ? '' : '空段落该回 400，实际 ' + res.statusCode,
    },
  ],
  'server/routes/models.js': [
    {
      url: '/models/status?id=onnx-community/whisper-small_timestamped',
      check: res => {
        try {
          const d = JSON.parse(res.body);
          if (d.id !== 'onnx-community/whisper-small_timestamped') return 'id 没回写：' + res.body;
          if (!Array.isArray(d.files) || typeof d.bytes !== 'number') return 'files/bytes 形状不对：' + res.body;
          if (d.files.some(f => /\.part$/.test(f.file))) return '.part 算进了已就绪清单：' + res.body;
        } catch (e) { return '回执不是 JSON：' + res.body; }
        return '';
      },
    },
    { url: '/models/status?id=abc', check: res => res.statusCode === 400 ? '' : '单段 id 该回 400，实际 ' + res.statusCode },
    /* 点号段走不到模型目录：URL 归一（/models/../x → /x）与百分号编码（%2e%2e）都按 400 拒 */
    { url: '/models/../.env', check: res => res.statusCode === 400 ? '' : '点号段该回 400，实际 ' + res.statusCode },
    { url: '/models/%2e%2e/.env', check: res => res.statusCode === 400 ? '' : '编码点号段该回 400，实际 ' + res.statusCode },
    { url: '/models/org', check: res => res.statusCode === 400 ? '' : '缺文件段该回 400，实际 ' + res.statusCode },
    { url: '/models/org/name/f.bin', method: 'POST', check: res => res.statusCode === 405 ? '' : '非 GET 该回 405，实际 ' + res.statusCode },
    /* 本机没有这份文件 → 走镜像代下载（假上游回 200 小 JSON）：整条「写 .part → 改名 → 流回」要跑得通 */
    {
      url: '/models/org/name/missing.bin',
      check: res => res.statusCode === 200 ? '' : '代下载落空了：' + res.statusCode + ' ' + String(res.body || ''),
    },
  ],
  'server/routes/search.js': [
    { url: '/search' }, { url: '/search/settings' },
    { url: '/search/settings', method: 'PUT', body: JSON.stringify({ settings: { enabled: false } }) },
    { url: '/search/query', method: 'POST', body: JSON.stringify({ query: '探针' }) },
    { url: '/search/read', method: 'POST', body: JSON.stringify({ url: 'https://example.com/' }) },
  ],
  'server/routes/static.js': [
    { url: '/' }, { url: '/web/app.js' }, { url: '/video.html' }, { url: '/.env' }, { url: '/nope.xyz' },
  ],
  'server/data-store.js': [
    { url: '/data' }, { url: '/data/sk_probe', method: 'PUT', body: JSON.stringify({ v: 1 }) },
    { url: '/data/sk_probe' }, { url: '/data/bad%20key' },
  ],
  'server/prompts-store.js': [
    { url: '/prompts' }, { url: '/prompts/find', method: 'POST', body: JSON.stringify({ ids: ['p1'] }) },
  ],
  'server/cloud-store.js': [
    { url: '/cloud/status' },
    { url: '/cloud/sync', method: 'POST', body: JSON.stringify({}) },
  ],
};

let bad = 0, checks = 0, hits = 0, counting = true;
/* 异步链（ur.on('end') / setTimeout 回调）里抛出来的错不在任何 try/catch 上 —— relay.js 那段
   LIST_CACHE_MAX 的旧事故正是这一类：catch 接不住、响应永远不发。
   这里兜住并记成**当前这条用例**红，而不是让判据自己崩。 */
let currentLabel = '';
function red(line) {
  if (!counting) return;
  bad++;
  console.log('  ✗ ' + line);
}
process.on('uncaughtException', e => red((currentLabel || '(没有进行中的用例)')
  + ' —— 异步链里抛出 ' + ((e && e.name) || 'Error') + '：' + ((e && e.message) || e)));
process.on('unhandledRejection', e => red((currentLabel || '(没有进行中的用例)')
  + ' —— Promise 没人接的拒绝：' + ((e && e.message) || e)));
function ok(name, cond, detail) {
  if (counting) checks++;
  if (cond) return true;
  red(name + (detail ? ' —— ' + detail : ''));
  return false;
}
const errKind = e => (e && e.name) || 'Error';
/* 等响应落地：路由里不少是 readBody(...).then(...)，同步返回不代表答完了。
   这里以前是 3ms 一轮的定长轮询，两条「不该接的 URL」用例（relay /nope、
   local-assets /nope）本来就被路由**同步返回 false**，却仍要空等满 300ms —— 占掉本判据约
   1/3 的墙钟（1269ms idle 里 620ms 是这两条）。现在：
     · 处理器已经明确返回 false 且用例是 expect:false 的，不再等（断言读的就是这个返回值，没等头）；
     · 其余改成事件驱动（finish/close 一到就走），失败上限从 300ms 放宽到 800ms —— 只影响
       「确实没响应」的红速度，不影响断言本身；并发池下机器被压满时也不再拿 300ms 抖出假红。 */
async function settle(res, ms = 800) {
  if (res.writableEnded || res.destroyed) return true;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); res.off('finish', done); res.off('close', done); resolve(); };
    const timer = setTimeout(done, ms);
    res.once('finish', done); res.once('close', done);
  });
  return res.writableEnded || res.destroyed;
}

async function runHit(mod, wiring, handlerName, handler, hit) {
  return (await _runHit(mod, wiring, handlerName, handler, hit)) === true;
}
/* ---------- 分发表覆盖（if 链改成一张表之后才有的这一种坏法） ---------- */
/* 注入点找得到、工厂构造得出、端点单独跑也通 —— 唯独「新写的路由忘了挂进 app.js 的
   ROUTE_TABLE」只有从表上查才看得出来：那条路由整条不可见，页面点它就是 404，
   而上面每一条判据都不会红。表里的行按「调的是不是这个模块的那个处理器」认，
   app 里 `const mediaRoutes = createMediaRoutes(…)` 的变量名与处理器名都要对上。 */
let appSrcCache = null;
const appSrc = () => (appSrcCache || (appSrcCache = S.read('server/app.js')));
function dispatchBlock() {
  const src = appSrc();
  const i = src.indexOf('const ROUTE_TABLE');
  if (i < 0) return null;
  const end = src.indexOf('\n];', i);
  return end < 0 ? src.slice(i) : src.slice(i, end);
}
/* 一律回 `{ why }`：why 非空就是这条路由没挂在表上（红）。只盯 `handle*` 那一族导出 ——
   模块顺手导出的别的函数（给 app 当依赖用的那些小件）不归分发分管。
   回空串当成功、回字符串当失败那种写法容易自己绕进去。 */
function tableCheck(mod, handlers) {
  const block = dispatchBlock();
  if (!block) return { why: 'server/app.js 里找不到 ROUTE_TABLE（分发又变回 if 链了？）' };
  const names = Object.keys(handlers).filter(n => typeof handlers[n] === 'function' && /^handle/.test(n));
  if (!names.length) return { why: '' };
  if (mod.standalone) {
    return new RegExp('\\b' + mod.standalone + '\\s*\\(').test(block)
      ? { why: '' } : { why: mod.standalone + ' 不在分发表里（这条路由从表上走不到）' };
  }
  const m = new RegExp('const\\s+(\\w+)\\s*=\\s*' + mod.factory + '\\s*\\(').exec(appSrc());
  if (!m) return { why: mod.factory + ' 的返回值没赋给变量（表判据读不出来，改成 `const x = createXRoutes({...})` 那种写法）' };
  const miss = names.filter(n => !new RegExp('\\b' + m[1] + '\\.\\s*' + n + '\\s*\\(').test(block));
  return miss.length ? { why: m[1] + '.' + miss.join('/') + ' 不在分发表里（这条路由从表上走不到，页面点它就是个 404）' } : { why: '' };
}
async function _runHit(mod, wiring, handlerName, handler, hit) {
  hits++;
  const faultBase = faults.length;
  const req = mkReq(hit);
  const res = mkRes();
  const savedUp = Object.assign({}, upState);
  Object.assign(upState, hit.up || {});
  const extra = extraArgs(paramNames(handler), req, mod, wiring, hit);
  const label = mod.file + ' ← ' + handlerName + ' ' + req.method + ' ' + hit.url;
  currentLabel = label;
  let ret, err = null;
  try { ret = await handler.call(null, req, res, ...extra); }
  catch (e) { err = e; }
  Object.assign(upState, savedUp);
  if (err) {
    const m = (err && err.message) || String(err);
    const kind = errKind(err);
    ok(label, false, '抛异常 ' + (kind === 'ReferenceError'
      ? 'ReferenceError（函数体用了没声明的变量，正是 pick-dir 那一类）：' + m : kind + '：' + m));
    return;
  }
  /* 「不该接的 URL」且处理器已明确返回 false：契约上不会再有响应，只留 20ms 抓「迟到的回写」
     这一类坏法（判据不松，只是不再为必然不发生的事空等 300ms —— V7）。 */
  const settled = await settle(res, hit.expect === false && ret === false ? 20 : undefined);
  const violations = res.violations.join('；');
  if (hit.expect === false) {
    ok(label + '（不该接的 URL）', (ret === false || !res.headersSent) && !violations,
      violations || (ret === false ? '' : '这条 URL 路由不该接，却回了 ' + res.statusCode));
    return;
  }
  if (violations) { ok(label, false, '回话不合法：' + violations); return; }
  if (ret === false && !res.headersSent) { ok(label, false, '这条路由没接（返回 false）—— 用例的地址或方法不对'); return; }
  if (!settled && !res.headersSent) { ok(label, false, '没落地任何响应（既没 writeHead/end，也没返回 false）'); return; }
  ok(label, res.statusCode >= 100 && res.statusCode <= 599, '状态码 ' + res.statusCode);
  /* 附带判据：一条端点除「回得合理」之外还要满足的东西（进了哪本账、回执里 counted 对不对）。
     check 返回空 = 满足，返回一句 = 就是这一句没满足。
     `only.faults` 是**这一次调用**记下的账，前面的用例不留进来 —— 否则「不该记账」那类
     判据会被上一用例的记录假红。 */
  if (hit.check) {
    const why = hit.check(res, { faults: faults.slice(faultBase) });
    ok(label + ' 附带判据', !why, why || '');
  }
}

/* 静态分发的扩展名白名单必须认 .mjs：vendor 的 mediabunny 是 ESM（`import('/web/vendor/mediabunny.min.mjs')`），
   白名单漏了它就 404 —— 而调用方全都优雅降级（切片走 <video>、波形写「不可用」、导出退精确 seek），
   表面一切正常、实际整条新栈没跑起来。这一条钉住「确实能取到」。 */
{
  const rs = fs.readFileSync(S.abs('server/routes/static.js'), 'utf8');
  const app = fs.readFileSync(S.abs('server/app.js'), 'utf8');
  const hasMjs = /mjs/.test(rs);
  ok('静态白名单认 .mjs（vendor 的 ESM 靠它）', hasMjs && /'\.mjs':\s*'text\/javascript'/.test(app));
}

/* 自检跑一遍这套判据自己：两份故意写坏的样品必须红，否则「永远绿」的判据比没有判据更坏。 */
async function selfTest() {
  const sample = require(S.abs('tests/fixtures/route-defect-sample.js'));
  const mod = { file: 'tests/fixtures/route-defect-sample.js', factory: 'createDefectSample' };
  const wiring = { file: '（合成样品的注入点）', keys: ['log'] };
  const handlers = sample.createDefectSample(buildCtx(wiring.keys, { file: mod.file, wiring: wiring.file }));
  const cases = [
    ['用了没声明的变量', 'handleUndeclared', { url: '/x' }],
    ['读没注入的 ctx key', 'handleMissingKey', { url: '/y' }],
  ];
  console.log('\n判据自检（这两条必须红，不红说明上面那条判据失效了）');
  let allCaught = true;
  counting = false;                     // 样品的红不算进正式判据
  const savedBad = bad, savedChecks = checks, savedHits = hits;
  for (const [name, handlerName, hit] of cases) {
    const caught = !(await runHit(mod, wiring, handlerName, handlers[handlerName], hit));
    if (!caught) allCaught = false;
    console.log('  ' + (caught ? '✓ ' : '✗ ') + name + '：' + (caught ? '确实红了' : '判据没挡住'));
  }
  counting = true;
  bad = savedBad; checks = savedChecks; hits = savedHits;
  if (!allCaught) { ok('判据自检', false, '样品的坏法没被挡住 —— 上面的端点冒烟是假绿'); }
  return allCaught;
}

/* ---------- 依赖注入对账（「把域搬出 app.js」的配套判据）----------
   搬域最容易留的一种雷：函数搬走了，它读的那些配置没跟着搬。这种代码**语法通、require 得动、
   面也挂得上**，静态与运行期各判据都看不见，只有真请求打进去才在 catch 里冒出来 ——
   `/sys-status` 整条 500、设置页「代理体检」那一格空转，而 `node tests/all.cjs` 全绿。
   这里不做作用域分析，只做集合比对：**模块声明要的 ⊆ 调用点给的**。
   只数「把 deps 整包解构」的那种工厂（`const { a, b } = deps;`）；逐个 `ctx.x` 读的那一族
   由上面那面 Proxy 在运行期盯着，两条判据各管一半、不重叠。 */
function declaredDeps(file, factory) {
  const src = S.read(file);
  const at = src.indexOf('function ' + factory);
  if (at < 0) return null;
  const next = src.indexOf('\nfunction ', at + 1);
  const body = src.slice(at, next < 0 ? at + 6000 : Math.min(next, at + 6000));
  const m = /(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*(?:deps|ctx|options|opts)\s*;/.exec(body);
  if (!m) return [];
  return [...new Set(m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',')
    .map(x => (x.split(':')[0].split('=')[0] || '').trim())
    .filter(x => /^[A-Za-z_$][\w$]*$/.test(x)))];
}
function callSites() {
  const src = appSrc();
  const out = [];
  const re = /(?:const|let)\s+[\w$]+\s*=\s*(create[A-Z][\w$]*)\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(src))) out.push({ factory: m[1], at: m.index });
  return out;
}
function injectionAudit() {
  const files = S.serverSources().map(S.rel);   // S.read 要的是仓库相对路径
  const rows = [];
  for (const cs of callSites()) {
    const def = files.find(f => new RegExp('\\bfunction\\s+' + cs.factory + '\\b').test(S.read(f)));
    if (!def) { rows.push({ factory: cs.factory, why: '找不到 `function ' + cs.factory + '` 的定义（工厂搬进子目录请把 serverSources 的候选补上）' }); continue; }
    const want = declaredDeps(def, cs.factory);
    if (want == null) { rows.push({ factory: cs.factory, why: cs.factory + ' 在 ' + def + ' 里读不出来' }); continue; }
    if (!want.length) continue;                       // 逐个 ctx.x 读的那一族：Proxy 那面已经盯着
    const w = S.findWiring(cs.factory);
    if (w.error) { rows.push({ factory: cs.factory, why: w.error }); continue; }
    const miss = want.filter(k => !w.keys.includes(k));
    if (miss.length) rows.push({ factory: cs.factory, where: def, given: (w.file || '') + ' 注入 ' + w.keys.length + ' 个 key',
      why: def + ' 的 ' + cs.factory + ' 解构了 ' + miss.join('/') + '，注入点没给 —— 拿在手里是 undefined，'
        + '界面上是一格空数或直接抛 ReferenceError' });
  }
  return rows;
}

/* 反向那一半，也是**真的漏过一次的那一半**：模块里用了一个只有 app.js 才有的配置名，
   却没从注入里接下来 —— 那是自由变量，运行期当场 ReferenceError。
   只查「长得像配置」的那一批（app.js 顶层的 UPPER_SNAKE 常量），不做完整作用域分析：
   要防的就是「搬域时把函数搬走、配置名忘了一起解构」，查得准比查得全有用。 */
function appConfigConsts() {
  const out = [];
  const re = /(?:^|\n)(?:const|let)\s+([A-Z][A-Z0-9_]{2,})\s*=/g;
  let m;
  while ((m = re.exec(appSrc()))) out.push(m[1]);
  return [...new Set(out)];
}
/* 只数代码：注释与字符串里出现的那些名字不算「用了它」—— 界面文案里写「在 .env 里把
   RENDER_DIR 指到别的盘」是给人看的一句话，不是自由变量。
   一次扫描同时抹两种（先抹注释再抹字符串的话，字符串里的引号会把注释边界吃掉；
   反过来先抹字符串，注释的 `/*` 可能被整段抹掉 —— 都实测过，只有单遍扫描靠得住）。
   正则字面量里的引号会让这一遍多抹一点，方向是「少判」而不是「瞎判」，可接受。 */
function codeText(src) {
  const arr = src.split('');
  const blank = (a, b) => { for (let k = a; k < b && k < arr.length; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && src[i + 1] === '*') { const s = i; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; blank(s, i); continue; }
    if (c === '"' || c === "'" || c === '`') {
      const s = i, q = c; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
      i++; blank(s, i); continue;
    }
    i++;
  }
  return arr.join('');
}
function freeConfigAudit() {
  const names = appConfigConsts();
  if (!names.length) return [{ why: 'app.js 顶层读不到任何 UPPER_SNAKE 配置常量（判据失去比对对象）' }];
  const rows = [];
  for (const file of S.serverSources().map(S.rel)) {
    if (file === 'server/app.js') continue;
    const src = codeText(S.read(file));
    const known = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    /* 任何一份解构（`const { a, b } = deps;`、`const { x } = require(...)`）里的名字都算本地有 */
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) {
      for (const n of m[1].split(',')) {
        const t = (n.split(':')[0].split('=')[0] || '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) known.add(t);
      }
    }
    /* 「用了它」必须是**裸标识符**：`deps.LOCAL_DIR` 是属性访问（读的就是注入进来的那一份），
       不是自由变量。`\b` 挡不住这一点 —— 点不在 \w 里，所以 `deps.` 后面照样算一个词边界。 */
    const free = names.filter(n => known.has(n) === false
      && new RegExp('(?:^|[^$.\\w])' + n + '\\b').test(src));
    if (free.length) rows.push({ file, why: file + ' 直接用了 app.js 的配置 ' + free.join('/')
      + '，但本文件既没声明也没从注入里解构 —— 那是自由变量，跑到那一行就是 ReferenceError' });
  }
  return rows;
}

(async () => {
  if (process.argv.includes('--selftest')) { process.exitCode = (await selfTest()) ? 0 : 1; return; }

  console.log('路由工厂 ctx 注入 + 端点冒烟（' + MODULES.length + ' 个模块）');
  /* 表里有一行 ≠ 那一行还兜得住：最后一条必须是静态兜底，前面任何一条 fallthrough 都要落到它。 */
  const blk = dispatchBlock() || '';
  const rowNames = [...blk.matchAll(/name:\s*'([^']+)'/g)].map(x => x[1]);
  const lastRow = blk.slice(blk.lastIndexOf("name: 'static'"));
  ok('分发表最后一条是静态兜底', rowNames.length > 0 && rowNames[rowNames.length - 1] === 'static'
    && /match:\s*\(\)\s*=>\s*true/.test(lastRow),
    'ROUTE_TABLE 的末尾不是 `static` + 恒真 match —— 前面 fallthrough 的请求会没人接');
  const inj = injectionAudit();
  ok('依赖注入对账（' + callSites().length + ' 处 create*({...}) 调用点）', inj.length === 0,
    inj.map(r => r.why).join('；\n    '));
  const free = freeConfigAudit();
  ok('注入侧自由变量对账（' + appConfigConsts().length + ' 个 app.js 配置名）', free.length === 0,
    free.map(r => r.why).join('；\n    '));
  for (const mod of MODULES) {
    if (!S.exists(mod.file)) { ok(mod.file + ' 存在', false, '文件不见了'); continue; }
    const name = mod.factory || mod.standalone;
    const wiring = S.findWiring(name);
    if (wiring.error) { ok(name + ' 的注入点', false, wiring.error + '（落点搬走请把新位置补进 tests/support.cjs 的 findWiring 候选）'); continue; }
    const modReq = require(S.abs(mod.file));
    const handlers = {};
    if (mod.factory) {
      const factory = modReq[mod.factory];
      if (typeof factory !== 'function') { ok(mod.file + ' 导出 ' + mod.factory, false, '拿不到工厂函数'); continue; }
      let built;
      try { built = factory(buildCtx(wiring.keys, { file: mod.file, wiring: wiring.file, overrides: mod.fakes || {} })); }
      catch (e) { ok(mod.file + ' 构造（key 清单来自 ' + (wiring.file || '?') + '）', false, ((e && e.message) || e)); continue; }
      ok(mod.file + ' 构造（按 ' + (wiring.file || '?') + ' 注入 ' + wiring.keys.length + ' 个 key）', !!built && typeof built === 'object');
      Object.assign(handlers, built || {});
    } else {
      const fn = modReq[mod.standalone];
      if (typeof fn !== 'function') { ok(mod.file + ' 导出 ' + mod.standalone, false, '拿不到处理器'); continue; }
      handlers[mod.standalone] = fn;
    }
    const names = Object.keys(handlers).filter(n => typeof handlers[n] === 'function');
    const tc = tableCheck(mod, handlers);
    ok(mod.file + ' 挂在分发表上', !tc.why, tc.why);
    const table = HITS[mod.file] || [];
    if (!table.length) { ok(mod.file + ' 有用例表', false, '没有一条端点用例'); continue; }
    for (const hit of table) {
      const handlerName = hit.handler || names.find(n => /^handle/.test(n)) || names[0];
      const handler = handlers[handlerName];
      if (!handler) { ok(mod.file + ' 的 ' + handlerName, false, '工厂没返回这个处理器（返回了 ' + names.join('/') + '）'); continue; }
      await runHit(mod, wiring, handlerName, handler, hit);
    }
  }
  await selfTest();
  /* ::ffff: 形式的 IPv4 映射地址。以前 zero 判前 6 组、映射位读 g[6]，
     0xffff 实际在下标 5 —— 分支永不进入，映射内网被判公网放行。 */
  const { isPrivateHost } = require(S.abs('server/security.js'));
  ok("isPrivateHost('[::ffff:127.0.0.1]') 为真", isPrivateHost('[::ffff:127.0.0.1]') === true);
  ok("isPrivateHost('[::ffff:192.168.1.5]') 为真", isPrivateHost('[::ffff:192.168.1.5]') === true);
  ok("isPrivateHost('[::ffff:8.8.8.8]') 为假", isPrivateHost('[::ffff:8.8.8.8]') === false);
  const ms = Date.now() - t0;
  console.log('\n' + (bad ? '✗ ' : '✓ ') + checks + ' 项判据 / ' + hits + ' 条端点，' + bad + ' 项未通过（' + ms + ' ms）');
  if (ms > 2000) console.log('  ⚠ 超过 2 秒预算（要求 < 2 s）');
  if (spawned.length) console.log('  ℹ 假 spawn 被调用 ' + spawned.length + ' 次（真子进程一个都没起）：' + [...new Set(spawned)].join(', '));
  const unusedTol = CTX_TOLERATED.filter(r => !toleratedHit.has(r.id));
  if (unusedTol.length) console.log('  ℹ ctx 例外登记里 ' + unusedTol.length + ' 条这次没被读到，核对后可删：' + unusedTol.map(r => r.id).join(', '));
  if (unregistered.size) console.log('  ℹ 注入点里 ' + unregistered.size + ' 个 key 没登记假件（走兜底，判据照样跑）：' + [...unregistered].sort().join('、'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  /* 不用 process.exit()：stdout 是管道/重定向时那句 console.log 还在异部下刷，立刻 exit 会在
     Windows 上撞 libuv 的 `UV_HANDLE_CLOSING` 断言（进程以 0xC0000409 死掉，判据明明全绿却报失败，
     跑十次坏四五次）。只留一个**短**timer（假 upRequest 的 close 那 5 毫秒），让循环自己排空。 */
  process.exitCode = bad ? 1 : 0;
})().catch(e => {
  console.error('✗ 判据自己坏了：' + (e && e.stack || e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) {}
  process.exitCode = 1;
});
