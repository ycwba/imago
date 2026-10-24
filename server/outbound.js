/* 出站请求层：keep-alive、系统/环境代理、CONNECT 隧道、统一超时与失败收尾。
   从 proxy.js 无行为搬移；依赖 server/security.js 的 isPrivateHost。 */
'use strict';
const http = require('http');
const { request: httpsRequest, Agent: HttpsAgent } = require('https');
const tls = require('tls');
const { isPrivateHost, guardedLookup, setProxyProbe, resetHostGuard } = require('./security.js');

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
        const prevLabel = _sysProxy ? _sysProxy.label : null;
        _sysProxy = (!err && stdout) ? registryProxy(stdout) : null;
        _proxyAt = 0;              // 让下一次 outboundProxy() 重新算一遍来源，别把旧的「直连」再缓存 30 秒
        /* 系统代理开关 / 换地址：立刻清一次本机 DNS 闸的缓存（security.resetHostGuard）。
           fake-ip 时期留下的「解析到内网（198.18.x.x）」结论不能在关掉代理后继续压着
           那 5 分钟 TTL；reg 查询是后台刷的，等 outboundProxy 下一次重算最多还会再压 30 秒。 */
        if ((_sysProxy ? _sysProxy.label : null) !== prevLabel) resetHostGuard();
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
let _proxyLabel = '';
function outboundProxy() {
  const now = Date.now();
  if (now - _proxyAt < PROXY_TTL) return { cfg: _proxyCfg, src: _proxySrc };
  _proxyAt = now; _proxyCfg = null; _proxySrc = '';
  if (String(process.env.PROXY_OFF || '') === '1') _proxySrc = 'PROXY_OFF=1（.env 里关掉了，全部直连）';
  else {
    for (const k of PROXY_ENV_KEYS) {
      const c = parseProxySpec(process.env[k]);
      if (c) { _proxyCfg = c; _proxySrc = '环境变量 ' + k + ' = ' + c.label; break; }
    }
    if (!_proxyCfg && _sysProxy) { _proxyCfg = _sysProxy; _proxySrc = 'Windows 系统代理 ' + _sysProxy.label; }
  }
  /* 代理从无到有 / 从有到无 / 换了地址（label 变了）：清一次本机 DNS 闸的缓存
     （security.resetHostGuard）。开着代理且代理用 fake-ip 时，公网域名在本机
     dns.lookup 里全是 198.18.x.x、被 assertPublicHost 记成「解析到内网」；
     不清掉的话，关掉代理后这条结论还会压满 5 分钟 TTL。变化即清。 */
  const label = _proxyCfg ? _proxyCfg.label : '';
  if (label !== _proxyLabel) { _proxyLabel = label; resetHostGuard(); }
  return { cfg: _proxyCfg, src: _proxySrc };
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
/* 给 security.guardOutboundUrl 注册「这条 URL 走不走 CONNECT 隧道」的探针：
   有代理配置、且目标主机没被 proxyBypassed（NO_PROXY / 内网 / 回环旁路）= 走隧道，
   DNS 由代理端解析，guardOutboundUrl 那道本地 dns.lookup 校验整道跳过 —— 否则
   Clash fake-ip 模式下公网域名在本机全解析成 198.18.x.x，出站条条被拦。
   URL 解析失败回 false（当直连处理，校验照做，保守不放大）。 */
setProxyProbe(url => {
  const p = outboundProxy();
  if (!p.cfg) return false;
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return false; }
  return !proxyBypassed(host);
});
class ProxyTunnelAgent extends HttpsAgent {
  constructor(cfg) { super({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000 }); this.cfg = cfg; }
  createConnection(options, cb) {
    const cfg = this.cfg;
    const host = options.host, port = options.port || 443;
    let done = false, saw2xx = false, timer = null;
    const finish = (err, sock) => {
      if (done) return; done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      cb(err, sock);
    };
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
      /* 2xx 一到，preq 自己的 close 就是「CONNECT 请求完成」的正常收尾（紧接着就发），
         不是提前关闭 —— 提前关闭只可能在应答之前。真正的半途断链由下面 tlsSock 的
         error/close 兜住（TLS 握手或其后任一时刻断开都有明确错误可报）。 */
      saw2xx = true;
      /* servername 只给域名：目标是 IP 字面量时按 RFC 6066 不该带 SNI（Node 会弃用告警）。 */
      const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
      const tlsSock = tls.connect({
        socket,
        servername: options.servername || (isIpLiteral ? undefined : host),
        rejectUnauthorized: options.rejectUnauthorized !== false,
      }, () => finish(null, tlsSock));
      tlsSock.once('error', e => { try { socket.destroy(); } catch (e2) {} finish(e); });
    });
    preq.once('error', e => finish(new Error('连不上代理 ' + cfg.label + '：' + e.message)));
    /* 假死代理（accept 了却永远不回 2xx）不能把请求挂到天荒地老：15 秒兜底。
       用独立定时器而不用 preq.setTimeout —— 后者把不活跃超时留在 socket 上，
       隧道建成、连接进池之后照样会把空闲 15 秒的池内连接掐死。 */
    timer = setTimeout(() => {
      try { preq.destroy(); } catch (e) {}
      finish(new Error('连不上代理 ' + cfg.label + '：CONNECT 超过 15 秒没有应答'));
    }, 15000);
    preq.once('close', () => { if (!done && !saw2xx) finish(new Error('连不上代理 ' + cfg.label + '：CONNECT 连接提前关闭')); });
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
  const idle = Number(o.timeoutMs) || UP_TIMEOUT;
  delete o.timeoutMs;
  const ka = o.keepAlive === true; delete o.keepAlive;
  const fresh = o.fresh === true; delete o.fresh;
  let tmpAgent = null;
  if (fresh) { tmpAgent = freshAgentFor(url); o.agent = tmpAgent || false; }
  else if (!o.agent) o.agent = agentFor(url, ka);
  /* 建连一律过 DNS rebinding 这道闸（写字面量判据拦不住「解析到 127.0.0.1 的公网域名」）：
     放在这一层，是为了让每个出站调用点都拿到同一份判据，不用各自记得传 lookup。
     例外：选出的 agent 是 ProxyTunnelAgent（走 HTTP CONNECT 隧道）时不注入 ——
     目标域名由代理端解析，本机 dns.lookup 在 fake-ip 模式下只会看到 198.18.x.x，
     注入等于把隧道请求拦死在自己手里。直连与 keep-alive 池照旧注入。 */
  if (!o.lookup && !(o.agent instanceof ProxyTunnelAgent)) o.lookup = guardedLookup;
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
  if (!o.agent && /^https:\/\//i.test(url)) o.agent = agentFor(url, false);
  /* 与 upRequest 同一条 DNS 闸：以前 anyRequest 不传 lookup，云同步的 https 地址
     解析到内网也照样带着凭据去连。本机回环（自建 WebDAV 调试、渲染取自己的 /asset）
     按字面量放行 —— 那是明确的本机目标，不是「公网域名解析到内网」那类绕过。
     与 upRequest 同一个例外：选出的 agent 是 ProxyTunnelAgent（走 CONNECT 隧道）
     时不注入 —— 目标域名由代理端解析，本机 dns.lookup 在 fake-ip 模式下只会
     看到 198.18.x.x，注入即拦死。 */
  if (!o.lookup) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    const literalLocal = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i.test(host);
    if (!literalLocal && !(o.agent instanceof ProxyTunnelAgent)) o.lookup = guardedLookup;
  }
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
