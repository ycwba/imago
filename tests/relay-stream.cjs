#!/usr/bin/env node
/* relay 大请求体流式直通的判据：
   · 超过阈值的 POST 走 req → 上游管道（不过 readBody 整份缓冲），content-length 原样带上；
   · 客户端半路断开 → 上游跟着掐，名额恰好归还一次，响应侧回 502；
   · 上游提前回话（早于上传结束，大多是被拒）→ 停泵请求体，响应照常发完；
     此后请求体这一侧再怎么断都不掐已经发出去的响应；
   · 小体与 GET 保持缓冲路径（readBody 照常被调）。
   用真 PassThrough 管道 + 假上游，不依赖外网。 */
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough, Readable } = require('stream');
const { createRelayRoutes } = require('../server/routes/relay.js');
const { failUpstream } = require('../server/outbound.js');

const PROV = {
  id: 'vgenv', name: 'VGENV 视频', relay: '/probe', base: 'https://api.vgenv.example',
  keyId: 'vgenv', keyEnv: 'VGENV_KEY',
  endpoints: { list: '/videos', create: '/create' },
};

/* 假上游：既是收请求体的 Writable（write / end / destroy），又能发响应（cb 收一份流）。 */
function mkUp() {
  const em = new EventEmitter();
  em.received = [];
  em.destroyed = false;
  em.ended = false;
  em.write = c => { if (!em.destroyed) em.received.push(Buffer.from(c)); return true; };
  em.end = c => {
    if (c != null) em.write(c);
    em.ended = true;
    em.emit('end');                      // 真上游收到完整请求体后才回话；假件用 end 事件当那一刻
  };
  em.destroy = () => {
    if (em.destroyed) return;
    em.destroyed = true;
    setImmediate(() => em.emit('error', new Error('socket hang up')));
  };
  em.setTimeout = () => {};
  return em;
}

function mkRes(done) {
  const res = { status: 0, body: '', headersSent: false, writableEnded: false, destroyed: false };
  res.writeHead = s => { res.status = s; res.headersSent = true; };
  res.write = c => { res.body += String(c); };
  res.end = c => {
    if (c != null) res.body += String(c);
    res.writableEnded = true;
    done();
  };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

/* build：返回 { routes, readBodies, attempts }。planMode 决定上游什么时候回话：
   after-upload —— 收完请求体（pipe end）才回 200；
   immediate   —— upRequest 一被调就立刻回（体还在半路）。 */
function build(planMode) {
  const attempts = [];
  const ups = [];
  const readBodies = { n: 0 };
  const releases = { n: 0 };
  const routes = createRelayRoutes({
    allProviders: () => [PROV],
    safeOutboundUrl: u => u,
    baseKeyOf: u => u,
    keyOf: () => 'probe-key',
    DEFAULTS: {},
    log: () => {},
    readBody: async () => { readBodies.n++; return Buffer.from('small-body'); },
    detailCache: new Map(), detailInflight: new Map(), listCache: new Map(), listInflight: new Map(),
    DETAIL_TTL: 60000,
    relayGateOf: () => ({}),
    /* release 与真件同一契约：幂等（多条出口都会调，只算第一次）。 */
    relayTake: (gate, issue) => { let given = false; issue(() => { if (!given) { given = true; releases.n++; } }); return true; },
    relayRefused: () => { throw new Error('不应被限流'); },
    relayRetryWait: () => null,
    noteRelayEvent: () => {},
    cacheSweep: () => {},
    upRequest: (u, opts, cb) => {
      const up = mkUp();
      attempts.push({ url: u, opts: { ...opts, headers: { ...opts.headers } } });
      ups.push(up);
      if (planMode === 'immediate') {
        setImmediate(() => {
          const ur = Readable.from([Buffer.from('early-reject')]);
          ur.statusCode = 413;
          ur.headers = {};
          cb(ur);
        });
      } else {
        up.on('end', () => setImmediate(() => {
          const ur = Readable.from([Buffer.from('ok-' + up.received.length)]);
          ur.statusCode = 200;
          ur.headers = {};
          cb(ur);
        }));
      }
      return up;
    },
    failUpstream,
    pipeUpstream: (ur, res) => { ur.on('data', c => res.write(c)); ur.on('end', () => res.end()); },
  });
  return { routes, readBodies, attempts, ups, releases };
}

const MB = 1024 * 1024;
/* handleRelay 读 req.url / req.method / req.headers：假 req 就是带这三个字段的 PassThrough。 */
const mkReq = (url, headers) => {
  const req = new PassThrough();
  req.url = url;
  req.method = 'POST';
  req.headers = headers;
  return req;
};

(async () => {
  try {
    /* ① 大 POST 直通：3MB 体走管道，一个字节不少地到上游，content-length 原样带上 */
    {
      const b = build('after-upload');
      const req = mkReq('/probe/create', { 'content-length': String(3 * MB), authorization: 'Bearer probe-key' });
      let res;
      const done = new Promise(resolve => { res = mkRes(() => setTimeout(() => resolve(res), 30)); });
      b.routes.handleRelay(req, res);
      const big = Buffer.alloc(3 * MB, 0x61);
      req.end(big);
      const out = await done;
      assert.equal(b.readBodies.n, 0, '大 POST 不走 readBody（整份缓冲就是那一座山）');
      assert.equal(b.attempts[0].opts.headers['content-length'], 3 * MB, 'content-length 原样转发');
      const got = Buffer.concat(b.ups[0].received);
      assert.equal(got.length, 3 * MB, '上游收到的字节一个不少');
      assert.ok(got.equals(big), '上游收到的字节原样');
      assert.equal(out.status, 200, '响应照常回给客户端');
      assert.equal(b.releases.n, 1, '名额恰好归还一次');
      console.log('  ✓ 大 POST 流式直通（不过 readBody，字节原样到上游，content-length 原样）');
    }

    /* ② 客户端半路断开：上游跟着掐、名额恰好一次、响应侧回 502 */
    {
      const b = build('after-upload');
      const req = mkReq('/probe/create', { 'content-length': String(3 * MB), authorization: 'Bearer probe-key' });
      let res;
      const done = new Promise(resolve => { res = mkRes(() => setTimeout(() => resolve(res), 30)); });
      b.routes.handleRelay(req, res);
      req.write(Buffer.alloc(MB, 0x62));               // 传了一部分…
      await new Promise(r => setImmediate(r));
      req.destroy(new Error('client aborted'));        // …然后断了
      const out = await done;
      assert.equal(b.ups[0].destroyed, true, '客户端断开 → 上游跟着掐（不在后台继续传）');
      assert.equal(b.releases.n, 1, '名额恰好归还一次');
      assert.equal(out.status, 502, '响应侧回 502');
      console.log('  ✓ 客户端半路断开 → 上游跟着掐，名额恰好一次，回 502');
    }

    /* ③ 上游提前回话（413，体还在半路）：停泵、响应发完；此后请求体侧再断也不掐响应 */
    {
      const b = build('immediate');
      const req = mkReq('/probe/create', { 'content-length': String(3 * MB), authorization: 'Bearer probe-key' });
      let res;
      const done = new Promise(resolve => { res = mkRes(() => setTimeout(() => resolve(res), 50)); });
      b.routes.handleRelay(req, res);
      req.write(Buffer.alloc(MB, 0x63));             // 在途的那一批：早于回话，本来就该到上游
      await new Promise(r => setImmediate(r));
      const before = b.ups[0].received.reduce((n, c) => n + c.length, 0);
      // 响应已经回去（immediate 模式在 upRequest 当拍就回话）：再喂数据、再断，都不许动它
      req.write(Buffer.alloc(MB, 0x64));
      await new Promise(r => setImmediate(r));
      b.ups[0].emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
      const out = await done;
      const after = b.ups[0].received.reduce((n, c) => n + c.length, 0);
      assert.equal(after, before, '提前回话之后不再往上游泵字节');
      assert.equal(out.status, 413, '上游那句 413 原样到客户端');
      assert.equal(out.destroyed !== true, true, '响应没有被请求体一侧的断流掐掉');
      assert.equal(b.releases.n, 1, '名额恰好归还一次');
      console.log('  ✓ 上游提前回话：停泵请求体，响应发完不受半路断流影响');
    }

    /* ④ 小体与 GET 保持缓冲路径 */
    {
      const b = build('after-upload');
      const req = mkReq('/probe/create', { 'content-length': String(MB), authorization: 'Bearer probe-key' });
      let res;
      const done = new Promise(resolve => { res = mkRes(() => setTimeout(() => resolve(res), 30)); });
      b.routes.handleRelay(req, res);
      req.end(Buffer.alloc(MB, 0x65));                 // 1MB < 2MB 阈值
      const out = await done;
      assert.equal(out.status, 200, '小体那一路也照常回 200');
      assert.equal(b.readBodies.n, 1, '小体照常走 readBody 缓冲');
      console.log('  ✓ 小体保持缓冲路径（readBody 照常）');
    }

    console.log('✓ relay 大请求体流式直通：四条全过');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  }
})();
