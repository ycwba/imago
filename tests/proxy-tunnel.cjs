/* CONNECT 隧道回归判据：假代理 + 本地 TLS 目标，全程离线。
   抓的回归：ProxyTunnelAgent 里 CONNECT 应答 2xx 之后，preq 自己的 close
   （CONNECT 请求完成的正常收尾，应答后立即发）被当成「提前关闭」报错，
   走系统代理的出站请求条条失败（Clash / v2rayN 一类全命中）。
   判据见 server/outbound.js 的 ProxyTunnelAgent。 */
'use strict';
const net = require('net');
const https = require('https');
const { readFileSync } = require('fs');
const path = require('path');
const { ProxyTunnelAgent, parseProxySpec, proxyBypassed } = require('../server/outbound.js');

const here = __dirname;
const cert = readFileSync(path.join(here, 'fixtures/pki/tunnel-test-cert.pem'));
const key = readFileSync(path.join(here, 'fixtures/pki/tunnel-test-key.pem'));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '：' + extra : '')); }
}

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
function close(server) {
  return new Promise(res => server.close(() => res()));
}

/* 假 CONNECT 代理：deny=true 时一律回 407；否则回 2xx 并把字节原样接到 host:port。 */
function fakeProxy({ deny = false } = {}) {
  const srv = net.createServer(client => {
    let acc = '';
    const onData = chunk => {
      acc += chunk.toString('latin1');
      const i = acc.indexOf('\r\n\r\n');
      if (i < 0) return;
      client.removeListener('data', onData);
      const m = /^CONNECT (\S+) HTTP/i.exec(acc);
      const authority = m ? m[1] : '';
      if (deny) {
        client.end('HTTP/1.1 407 Denied\r\n\r\n');
        return;
      }
      const [h, p] = authority.split(':');
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      const up = net.connect(Number(p) || 443, h, () => {
        client.pipe(up);
        up.pipe(client);
      });
      const bye = () => { try { client.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
      client.on('error', bye); up.on('error', bye); client.on('close', bye); up.on('close', bye);
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  return srv;
}

function get(agent, url) {
  return new Promise((res, rej) => {
    const r = https.request(url, { agent, rejectUnauthorized: false, timeout: 8000 }, resp => {
      let body = '';
      resp.on('data', d => { body += d; });
      resp.on('end', () => res({ status: resp.statusCode, body }));
    });
    r.on('error', rej);
    r.end();
  });
}

(async () => {
  const target = https.createServer({ cert, key }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tunnel-ok:' + req.url);
  });
  const tPort = await listen(target);

  console.log('CONNECT 隧道（假代理 + 本地 TLS 目标）');

  // ① 基础隧道：一次 CONNECT + TLS + HTTP 往返必须通。旧竞态在这里 100% 报「提前关闭」。
  const proxyA = fakeProxy();
  const pPortA = await listen(proxyA);
  const cfgA = parseProxySpec('http://127.0.0.1:' + pPortA);
  const agent = new ProxyTunnelAgent(cfgA);
  try {
    const out = await get(agent, 'https://127.0.0.1:' + tPort + '/a');
    ok(out.status === 200 && out.body === 'tunnel-ok:/a', 'CONNECT + TLS + HTTP 全程打通', JSON.stringify(out));
  } catch (e) {
    ok(false, 'CONNECT + TLS + HTTP 全程打通', e.message);
  }
  // ② 池内复用：同 agent 第二发走已建成的隧道 socket
  try {
    const out = await get(agent, 'https://127.0.0.1:' + tPort + '/b');
    ok(out.status === 200 && out.body === 'tunnel-ok:/b', '同 agent 第二发复用隧道', JSON.stringify(out));
  } catch (e) {
    ok(false, '同 agent 第二发复用隧道', e.message);
  }
  agent.destroy();
  await close(proxyA);

  // ③ 代理明确拒绝：报「代理拒绝 CONNECT」，不是提前关闭
  const proxyB = fakeProxy({ deny: true });
  const pPortB = await listen(proxyB);
  const agentB = new ProxyTunnelAgent(parseProxySpec('http://127.0.0.1:' + pPortB));
  let msg = '';
  try { await get(agentB, 'https://127.0.0.1:' + tPort + '/c'); } catch (e) { msg = e.message; }
  ok(/代理拒绝 CONNECT/.test(msg), '代理拒绝时给出明确错误', msg || '（居然成功了）');
  agentB.destroy();
  await close(proxyB);

  // ④ proxyBypassed 的旁路面：回环 / 私网命中；公网域名不旁路
  ok(proxyBypassed('localhost') && proxyBypassed('127.0.0.1') && proxyBypassed('192.168.1.8'),
    '回环与私网地址旁路代理');
  ok(!proxyBypassed('api.xiaomimimo.com'), '公网域名不旁路代理');

  await close(target);
  console.log((failed ? '✗ ' : '✓ ') + 'proxy-tunnel：' + passed + ' 过 / ' + failed + ' 挂');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('✗ proxy-tunnel 探针异常：', e); process.exit(1); });
