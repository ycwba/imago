#!/usr/bin/env node
/* relay 连接级重试的判据（VGENV TLS 断连那一类）：
   · GET 遇到「复用死连接的 TLS 握手中断」→ 换一条新连接再问一次；
   · POST 绝不重发（没有幂等键的创建请求重发可能扣两次钱）；
   · 证书错误不重试（换连接不会变好）。
   用注入口的 upRequest 精确复现，不依赖外网。 */
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { createRelayRoutes } = require('../server/routes/relay.js');
const { failUpstream } = require('../server/outbound.js');

const PROV = {
  id: 'vgenv', name: 'VGENV 视频', relay: '/probe', base: 'https://api.vgenv.example',
  keyId: 'vgenv', keyEnv: 'VGENV_KEY',
  endpoints: { list: '/videos', create: '/create' },
};
const TLS_DROP = {
  code: 'ECONNRESET',
  message: 'Client network socket disconnected before secure TLS connection was established',
};

function mkRes(done) {
  const res = { status: 0, body: '', headersSent: false, writableEnded: false, destroyed: false };
  res.writeHead = s => { res.status = s; res.headersSent = true; };
  res.write = c => { res.body += String(c); };
  res.end = c => {
    if (c != null) res.body += String(c);
    res.writableEnded = true;
    done();
  };
  return res;
}

/* 每次上游尝试按 plan[i] 回放：{ error } 或 { status, body }。 */
function callRelay(method, url, plan) {
  const attempts = [];
  const upRequest = (u, opts, cb) => {
    const i = attempts.length;
    attempts.push({ url: u, opts: { ...opts } });
    const em = new EventEmitter();
    em.end = () => setImmediate(() => {
      const step = plan[i];
      if (!step) { em.emit('error', new Error('计划外的第 ' + (i + 1) + ' 次上游请求')); return; }
      if (step.error) { em.emit('error', Object.assign(new Error(step.error.message), { code: step.error.code })); return; }
      const up = Readable.from([Buffer.from(step.body || 'ok')]);
      up.statusCode = step.status || 200;
      up.headers = {};
      cb(up);
    });
    return em;
  };
  const releases = [];
  const routes = createRelayRoutes({
    allProviders: () => [PROV],
    safeOutboundUrl: u => u,
    baseKeyOf: u => u,
    keyOf: () => 'probe-key',
    DEFAULTS: {},
    log: () => {},
    readBody: async () => Buffer.from(''),
    detailCache: new Map(), detailInflight: new Map(), listCache: new Map(), listInflight: new Map(),
    DETAIL_TTL: 60000,
    relayGateOf: () => ({}),
    relayTake: (gate, issue) => { issue(() => releases.push(Date.now())); return true; },
    relayRefused: () => { throw new Error('不应被限流'); },
    relayRetryWait: () => null,
    noteRelayEvent: () => {},
    cacheSweep: () => {},
    upRequest, failUpstream,
    pipeUpstream: (ur, res) => { ur.on('data', c => res.write(c)); ur.on('end', () => res.end()); },
  });
  return new Promise(resolve => {
    const res = mkRes(() => resolve({ res, attempts, releases }));
    routes.handleRelay({ url, method, headers: { authorization: 'Bearer probe-key' }, destroyed: false }, res);
  });
}

(async () => {
  try {
    const get = await callRelay('GET', '/probe/videos', [{ error: TLS_DROP }, { status: 200, body: 'ok' }]);
    await new Promise(r => setImmediate(r));   // 上游流的 close 在 end 之后一拍
    assert.strictEqual(get.attempts.length, 2, 'GET 遇到 TLS 断连应换新连接重试一次');
    assert.strictEqual(get.attempts[1].opts.fresh, true, '重试必须用 fresh（不复用连接池）');
    assert.notStrictEqual(get.attempts[0].opts.fresh, true, '第一次仍走连接池');
    assert.strictEqual(get.res.status, 200);
    assert.strictEqual(get.res.body, 'ok');
    assert.strictEqual(get.releases.length, 1, '整个尝试串只归还一次名额');

    const post = await callRelay('POST', '/probe/create', [{ error: TLS_DROP }]);
    assert.strictEqual(post.attempts.length, 1, 'POST 不允许换连接重发（无幂等键可能重复扣费）');
    assert.strictEqual(post.res.status, 502);
    assert.ok(/VGENV 视频 转发失败（打到 api\.vgenv\.example）/.test(post.res.body), '失败回执要带真正打出去的那一台：' + post.res.body);

    const cert = await callRelay('GET', '/probe/videos', [{ error: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' } }]);
    assert.strictEqual(cert.attempts.length, 1, '证书错误换连接不会变好，不重试');
    assert.strictEqual(cert.res.status, 502);

    console.log('✓ relay 连接重试：GET 换新连接一次 · POST 不重发 · 证书错误不重试 · 名额只归还一次');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  }
})();
