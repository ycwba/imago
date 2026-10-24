/* 出站地址护栏（SSRF）—— 从 proxy.js 无行为搬移。
   /fetch、/getv、/getfile、/s3put 会把浏览器递来的 URL 取回/写穿；只允许公网 https。
   DNS rebinding 防护在 guardedLookup；域名解析校验在 assertPublicHost。
   走 HTTP CONNECT 隧道的 URL 在 guardOutboundUrl 里跳过本地 DNS 校验（探针由
   server/outbound.js 经 setProxyProbe 注册，见下面 viaProxyTunnel 的说明）。 */
'use strict';
const dns = require('dns');

/* IPv4 映射的 IPv6（::ffff:127.0.0.1）：URL 解析器会规范化成 ::ffff:7f00:1，DNS 结果里常带点分写法。 */
function ipv4FromMapped(s) {
  const m = /(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
  }
  const m2 = /(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  return m2 ? m2[1] : null;
}
function ipv6Groups(h) {
  let s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return null;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const q = [+v4[1], +v4[2], +v4[3], +v4[4]];
    if (q.some(x => x > 255)) return null;
    s = s.slice(0, v4.index).replace(/:$/, '') + ':' + ((q[0] << 8) + q[1]).toString(16) + ':' + ((q[2] << 8) + q[3]).toString(16);
  }
  if (!/^[0-9a-f:]*$/.test(s)) return null;
  const dbl = s.indexOf('::');
  let head, tail;
  if (dbl >= 0) {
    if (s.indexOf('::') !== s.lastIndexOf('::')) return null;
    head = s.slice(0, dbl).split(':').filter(Boolean);
    tail = s.slice(dbl + 2).split(':').filter(Boolean);
  } else {
    head = s.split(':').filter(Boolean);
    tail = [];
    if (head.length !== 8) return null;
  }
  const need = 8 - head.length - tail.length;
  if (need < 0) return null;
  const g = [...head, ...Array(need).fill('0'), ...tail].map(x => parseInt(x, 16));
  return g.length === 8 && g.every(x => Number.isFinite(x)) ? g : null;
}
function isPrivateIpv6(h) {
  const g = ipv6Groups(h);
  if (!g) return false;
  /* ::ffff:127.0.0.1 的 0xffff 落在第 6 组（下标 5），映射地址的 IPv4 字节在 g[6]/g[7]。
     以前判的是 g.slice(0,6) 全 0 + g[6] === 0xffff —— 那个分支永远不成立，映射内网被当公网放行。 */
  const zero = g.slice(0, 5).every(x => x === 0);
  if (zero && g[5] === 0xffff) return isPrivateHost([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255].join('.'));
  if (g.every(x => x === 0)) return true;
  if (zero && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
  if (zero && g[5] === 0 && (g[6] | g[7])) return isPrivateHost([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255].join('.'));
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  return false;
}
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    /* 198.18.0.0/15（基准测试段，也是 Clash fake-ip 的默认网段）仍按内网拦：直连时
       公网域名解析到这里 = 本机解析已被代理软件接管，绝不该照这个地址自己出站。
       「走 CONNECT 隧道时跳过本地 DNS 闸」是 guardOutboundUrl 里 probe 那一层的豁免，
       不删这一条 —— 直连路径永远要拦它。 */
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (h.includes(':')) {
    const v4 = ipv4FromMapped(h);
    return v4 ? isPrivateHost(v4) : isPrivateIpv6(h);
  }
  return false;
}
function guardedLookup(hostname, opts, cb) {
  const o = opts || {};
  dns.lookup(hostname, { ...o, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: o.family }];
    const bad = list.find(a => a && isPrivateHost(a.address));
    if (bad) return cb(new Error('目标地址解析到内网（已拒绝）：' + bad.address));
    if (o.all) return cb(null, list);
    const first = list.find(a => !o.family || a.family === o.family) || list[0];
    cb(null, first.address, first.family);
  });
}
function safeOutboundUrl(u) {
  let o = null;
  try { o = new URL(String(u)); } catch { return null; }
  if (o.protocol !== 'https:') return null;
  if (isPrivateHost(o.hostname)) return null;
  return o.toString();
}
function baseKeyOf(u) {
  try {
    const o = new URL(String(u));
    return o.protocol + '//' + o.hostname.toLowerCase() + (o.port ? ':' + o.port : '') + o.pathname.replace(/\/+$/, '');
  } catch { return String(u == null ? '' : u).replace(/\/+$/, '').toLowerCase(); }
}
const hostGuardCache = new Map();
const HOST_GUARD_TTL = 5 * 60 * 1000;
let proxyProbe = null;
/* 出站层（server/outbound.js）注册的探针：fn(url) → true 表示这条 URL 将经
   HTTP CONNECT 隧道发出、目标域名由代理端解析。这一层不知道代理配置在哪，
   只认探针的答复；探针抛错或没注册一律当「不走隧道」处理（保守 = 照做本地校验）。 */
function setProxyProbe(fn) { proxyProbe = typeof fn === 'function' ? fn : null; }
function viaProxyTunnel(u) {
  if (!proxyProbe) return false;
  try { return proxyProbe(u) === true; } catch (e) { return false; }
}
/* 代理配置变化（开关系统代理 / 换地址）后由出站层调用：hostGuardCache 里可能压着
   上一轮模式留下的结论 —— 开着代理且代理用 fake-ip 时，公网域名在本机 dns.lookup
   里全是 198.18.x.x、被记成「解析到内网」；不清掉的话，关掉代理后的 HOST_GUARD_TTL
   （5 分钟）内仍然条条被拒。变化即清，让下一次请求按当前模式重新判。 */
function resetHostGuard() { hostGuardCache.clear(); }
function assertPublicHost(host) {
  const hit = hostGuardCache.get(host);
  if (hit && Date.now() - hit.ts < HOST_GUARD_TTL) {
    return hit.err ? Promise.reject(new Error(hit.err)) : Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      let msg = '';
      if (err) msg = '域名解析失败：' + err.message;
      else if (!addrs || !addrs.length) msg = '域名没有解析结果';
      else {
        const bad = addrs.find(a => isPrivateHost(a.address));
        if (bad) msg = '目标地址解析到内网（已拒绝）：' + bad.address;
      }
      if (hostGuardCache.size > 500) hostGuardCache.clear();
      hostGuardCache.set(host, { ts: Date.now(), err: msg });
      msg ? reject(new Error(msg)) : resolve(true);
    });
  });
}
async function guardOutboundUrl(raw) {
  const u = safeOutboundUrl(raw);
  if (!u) throw new Error('只允许取回公网 https 地址（回环 / 内网 / 明文 http 一律拒绝）');
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  /* 走 HTTP CONNECT 隧道时，目标域名的解析由代理端完成，本机不该做这道 DNS 校验：
     代理软件（Clash 等）开 fake-ip 后，公网域名在本机 dns.lookup 里全是 198.18.x.x，
     assertPublicHost 会把全部出站当「解析到内网」拦死。所以非字面量 IP 的主机先问
     probe，走隧道就跳过 assertPublicHost；字面量 IP 的 isPrivateHost 检查与
     https-only 检查在上面 safeOutboundUrl 那一道照旧，不受 probe 影响。 */
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !viaProxyTunnel(u)) await assertPublicHost(h);
  return u;
}

module.exports = { isPrivateHost, guardedLookup, safeOutboundUrl, baseKeyOf, guardOutboundUrl, setProxyProbe, resetHostGuard };
