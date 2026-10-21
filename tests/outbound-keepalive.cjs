#!/usr/bin/env node
/* P7 的前置判据：「复用 socket 必须同 host」，且复用路径不能绕过内网闸。
   两件事分开验：
     ① Node 的连接池按 host:port 分组 —— A 家的 socket 不会被拿去发 B 家的请求；
     ② 新连接仍走 guardedLookup —— 解析到内网的域名在建连前就被拒（复用只发生在
        已经过闸的同一条连接上；换 host 必然重新解析、重新过闸）。 */
'use strict';
const assert = require('node:assert/strict');
const { keepAliveAgent } = require('../server/outbound.js');
const { guardedLookup } = require('../server/security.js');

assert.equal(keepAliveAgent.keepAlive, true, 'keep-alive agent 必须是 keepAlive');
assert.equal(keepAliveAgent.options.keepAlive, true, 'keepAlive 选项要真的传给 Agent');
const keyA1 = keepAliveAgent.getName({ host: 'a.example.com', port: 443 });
const keyA2 = keepAliveAgent.getName({ host: 'a.example.com', port: 443 });
const keyB = keepAliveAgent.getName({ host: 'b.example.com', port: 443 });
assert.equal(keyA1, keyA2, '同一 host 的请求要落在同一个池键上（这才有复用）');
assert.notEqual(keyA1, keyB, '不同 host 必须用不同池键（复用 socket 必须同 host）');
assert.notEqual(
  keepAliveAgent.getName({ host: 'a.example.com', port: 443 }),
  keepAliveAgent.getName({ host: 'a.example.com', port: 8443 }),
  '同 host 不同端口也不能复用'
);

/* 建连闸：localhost 解析到回环，必须拒绝；错误信息要说清是内网。 */
const lookup = (host) => new Promise(res => {
  guardedLookup(host, {}, (err) => res(err || null));
});
(async () => {
  const e1 = await lookup('localhost');
  assert.ok(e1 && /内网/.test(e1.message), 'localhost 必须在建连前被内网闸拒绝，实际：' + (e1 && e1.message));
  const e2 = await lookup('[::ffff:127.0.0.1]'.replace(/^\[|\]$/g, ''));
  assert.ok(e2, '::ffff:127.0.0.1 形式的回环也必须被拒');
  console.log('✓ 出站 keep-alive：同 host 才复用；建连仍过内网闸');
})().catch(e => { console.error('✗ ' + (e && e.message || e)); process.exit(1); });
