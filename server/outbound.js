/* 出站请求层：keep-alive、系统/环境代理、CONNECT 隧道、统一超时与失败收尾。
   从 proxy.js 无行为搬移；依赖 server/security.js 的 isPrivateHost。 */
'use strict';
const http = require('http');
const { request: httpsRequest, Agent: HttpsAgent } = require('https');
const tls = require('tls');
const { isPrivateHost, guardedLookup } = require('./security.js');

const UP_TIMEOUT = 60000;

/* keep-alive 只给 relay / capabilities 两条目标来自注册表的通道；/getv 等四条保持每次新建，
   否则复用 socket 会跳过 guardedLookup，SSRF 闸在复用路径上被绕过。 */
const keepAliveAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000 });

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
function parseProxySpec(s) {
  let v = String(s || '').trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
  let o = null;
  try { o = new URL(v); } catch { return null; }
  const proto = o.protocol.replace(':', '').toLowerCase();
  if (proto !== 'http' && proto !== 'https') return null;
  const host = o.hostname;
  if (!host) return null;
  const port = Number(o.port) || (proto === 'https' ? 443 : 80);
  let auth = '';
  try {
    if (o.username || o.password) {
      auth = 'Basic ' + Buffer.from(decodeURIComponent(o.username) + ':' + decodeURIComponent(o.password)).toString('base64');
    }
  } catch (e) {}
  return { proto, host, port, auth, label: proto + '://' + host + ':' + port };
}
const { execFile } = require('child_process');
/* 把 `reg query` 的输出解析成代理配置（纯函数：读的那一半在 refreshSystemProxy）。 */
function registryProxy(stdout) {
  try {
    const on = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
    if (!on || parseInt(on[1], 16) !== 1) return null;
    const srv = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(stdout);
    if (!srv) return null;
    let spec = srv[1].trim();
    if (spec.includes('=')) {
      const parts = {};
      spec.split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim(); });
      spec = parts.https || parts.http || '';
    }
    return parseProxySpec(spec);
  } catch (e) { return null; }
}
const PROXY_TTL = 30 * 1000;
let _sysProxy = null;
/* 系统代理只能在后台刷：以前这一句是请求路径上的 `spawnSync('reg', …, timeout:3000)`，
   reg 一旦卡住，整个事件循环被按住最长 3 秒 —— 渲染进度、媒体流、健康检查一起停。 */
function refreshSystemProxy() {
  if (process.platform !== 'win32') { _sysProxy = null; return Promise.resolve(null); }
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, stdout) => {
        _sysProxy = (!err && stdout) ? registryProxy(stdout) : null;
        _proxyAt = 0;              // 让下一次 outboundProxy() 重新算一遍来源，别把旧的「直连」再缓存 30 秒
        resolve(_sysProxy);
      });
  });
}
/* 启动刷一次 + 每 PROXY_TTL 后台刷一次；unref 是为了让这个定时器不成为进程退出的理由。 */
function startProxyWatcher() {
  refreshSystemProxy();
  const t = setInterval(() => { refreshSystemProxy(); }, PROXY_TTL);
  if (t.unref) t.unref();
  return t;
}
let _proxyCfg = null, _proxySrc = '', _proxyAt = 0;
function outboundProxy() {
  const now = Date.now();
  if (now - _proxyAt < PROXY_TTL) return { cfg: _proxyCfg, src: _proxySrc };
  _proxyAt = now; _proxyCfg = null; _proxySrc = '';
  if (String(process.env.PROXY_OFF || '') === '1') { _proxySrc = 'PROXY_OFF=1（.env 里关掉了，全部直连）'; return { cfg: null, src: _proxySrc }; }
  for (const k of PROXY_ENV_KEYS) {
    const c = parseProxySpec(process.env[k]);
    if (c) { _proxyCfg = c; _proxySrc = '环境变量 ' + k + ' = ' + c.label; return { cfg: _proxyCfg, src: _proxySrc }; }
  }
  if (_sysProxy) { _proxyCfg = _sysProxy; _proxySrc = 'Windows 系统代理 ' + _sysProxy.label; return { cfg: _proxyCfg, src: _proxySrc }; }
  return { cfg: null, src: '' };
}
function proxyBypassed(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return isPrivateHost(h);
  const list = String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  return list.some(p => p === '*' || h === p || h.endsWith('.' + p));
}
class ProxyTunnelAgent extends HttpsAgent {
  constructor(cfg) { super({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000 }); this.cfg = cfg; }
  createConnection(options, cb) {
    const cfg = this.cfg;
    const host = options.host, port = options.port || 443;
    let done = false;
    const finish = (err, sock) => { if (done) return; done = true; cb(err, sock); };
    const mod = cfg.proto === 'https' ? httpsRequest : http.request;
    const preq = mod({
      host: cfg.host, port: cfg.port, method: 'CONNECT',
      path: host + ':' + port, agent: false, rejectUnauthorized: false,
      headers: Object.assign({ host: host + ':' + port }, cfg.auth ? { 'proxy-authorization': cfg.auth } : {}),
    });
    preq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch (e) {}
        return finish(new Error('代理拒绝 CONNECT（HTTP ' + res.statusCode + '）：' + cfg.label + ' 连不上 ' + host + ':' + port));
      }
      const tlsSock = tls.connect({
        socket,
        servername: options.servername || host,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      }, () => finish(null, tlsSock));
      tlsSock.once('error', e => finish(e));
    });
    preq.once('error', e => finish(new Error('连不上代理 ' + cfg.label + '：' + e.message)));
    /* 假死代理（accept 了却永远不回 2xx）不能把请求挂到天荒地老：15 秒兜底。 */
    preq.setTimeout(15000, () => {
      try { preq.destroy(); } catch (e) {}
      finish(new Error('连不上代理 ' + cfg.label + '：CONNECT 超过 15 秒没有应答'));
    });
    preq.once('close', () => { if (!done) finish(new Error('连不上代理 ' + cfg.label + '：CONNECT 连接提前关闭')); });
    preq.end();
  }
}
let _tunnelAgent = null, _tunnelKey = '';
function proxyAgentFor(cfg) {
  if (_tunnelAgent && _tunnelKey === cfg.label) return _tunnelAgent;
  try { if (_tunnelAgent) _tunnelAgent.destroy(); } catch (e) {}
  _tunnelAgent = new ProxyTunnelAgent(cfg);
  _tunnelKey = cfg.label;
  return _tunnelAgent;
}
function agentFor(url, keepAlive) {
  const p = outboundProxy();
  if (p.cfg) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    if (!proxyBypassed(host)) return proxyAgentFor(p.cfg);
  }
  return keepAlive ? keepAliveAgent : undefined;
}
/* 一条**不与池子共享**的连接：池里那条 socket 可能已经被对端静默关掉
   （`Client network socket disconnected before secure TLS connection was established`
   正是复用一条死连接时 TLS 层的原话）。retry 时用它，保证真的重新握手。
   走代理时新建一个隧道 agent（同样没有旧 socket 可复用），请求结束就销毁，不进池。 */
function freshAgentFor(url) {
  const p = outboundProxy();
  if (p.cfg) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    if (!proxyBypassed(host)) return new ProxyTunnelAgent(p.cfg);
  }
  return false;   // https.request 的 agent:false = 一次性 Agent（不 keep-alive）
}
function upRequest(url, opts, cb) {
  const o = { ...(opts || {}) };
  /* 建连一律过 DNS rebinding 这道闸（写字面量判据拦不住「解析到 127.0.0.1 的公网域名」）：
     放在这一层，是为了让每个出站调用点都拿到同一份判据，不用各自记得传 lookup。 */
  if (!o.lookup) o.lookup = guardedLookup;
  const idle = Number(o.timeoutMs) || UP_TIMEOUT;
  delete o.timeoutMs;
  const ka = o.keepAlive === true; delete o.keepAlive;
  const fresh = o.fresh === true; delete o.fresh;
  let tmpAgent = null;
  if (fresh) { tmpAgent = freshAgentFor(url); o.agent = tmpAgent || false; }
  else if (!o.agent) o.agent = agentFor(url, ka);
  const r = httpsRequest(url, o, cb);
  if (tmpAgent) r.once('close', () => { try { tmpAgent.destroy(); } catch (e) {} });
  r.setTimeout(idle, () => { r.destroy(new Error('上游响应超时（' + Math.round(idle / 1000) + 's）')); });
  return r;
}
function failUpstream(res, msg, tag) {
  const body = (tag ? tag + '：' : '') + String(msg == null ? '' : msg);
  try {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  } catch {}
}
function anyRequest(url, opts, cb) {
  const o = { ...(opts || {}) };
  /* 与 upRequest 同一条 DNS 闸：以前 anyRequest 不传 lookup，云同步的 https 地址
     解析到内网也照样带着凭据去连。本机回环（自建 WebDAV 调试、渲染取自己的 /asset）
     按字面量放行 —— 那是明确的本机目标，不是「公网域名解析到内网」那类绕过。 */
  if (!o.lookup) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    const literalLocal = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i.test(host);
    if (!literalLocal) o.lookup = guardedLookup;
  }
  if (!o.agent && /^https:\/\//i.test(url)) o.agent = agentFor(url, false);
  const mod = /^http:\/\//i.test(url) ? http.request : httpsRequest;
  const r = mod(url, o, cb);
  r.setTimeout(UP_TIMEOUT, () => { r.destroy(new Error('请求超时（' + (UP_TIMEOUT / 1000) + 's）')); });
  return r;
}
function destroyAgents() {
  try { keepAliveAgent.destroy(); } catch (e) {}
  try { if (_tunnelAgent) _tunnelAgent.destroy(); } catch (e) {}
  _tunnelAgent = null; _tunnelKey = '';
}

module.exports = { UP_TIMEOUT, keepAliveAgent, parseProxySpec, refreshSystemProxy, startProxyWatcher, outboundProxy, proxyBypassed, ProxyTunnelAgent, proxyAgentFor, agentFor, upRequest, failUpstream, anyRequest, destroyAgents };
