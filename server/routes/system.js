/* 本机系统路由：/sys-status（体检）、/whoami（启动器认领端口）、/env-status（密钥来源）、
   /clear-cache、/client-error（页面侧报错进同一本健康账）。
   只回状态与清代理侧缓存，不写用户数据；业务函数由 app 注入。 */
'use strict';

function createSystemRoutes(ctx) {
  const sysStatus = ctx.sysStatus;
  const registryVersion = ctx.registryVersion;
  const port = ctx.port;
  const providers = ctx.providers || [];
  const defaults = ctx.defaults || {};
  const caches = ctx.caches || {};
  const readBody = ctx.readBody;
  const noteFault = ctx.noteFault;

  /* /client-error 的限流两道（见下面那条路由的注释）。 */
  const ERR_DEDUP_MS = 30 * 1000;
  const ERR_WINDOW_MS = 60 * 1000;
  const ERR_WINDOW_MAX = 20;
  const errSeen = new Map();
  let errWindow = { from: 0, n: 0 };
  function admit(key) {
    const now = Date.now();
    if (now - errWindow.from > ERR_WINDOW_MS) errWindow = { from: now, n: 0 };
    errWindow.n++;
    if (errWindow.n > ERR_WINDOW_MAX) return false;
    const last = errSeen.get(key) || 0;
    errSeen.set(key, now);
    if (errSeen.size > 80) { for (const [k, v] of errSeen) { if (now - v > ERR_DEDUP_MS) errSeen.delete(k); } }
    return now - last >= ERR_DEDUP_MS;
  }
  const cut = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const send = (res, code, obj) => {
    try { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { /* 连接已经断了 */ }
  };

  function handleSystem(req, res, urlObj) {
    const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (dataPath === '/sys-status') {
      const body = JSON.stringify(sysStatus(req.url.includes('fresh=1')));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
    if (dataPath === '/whoami') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ app: 'shiji-workbench', registry: registryVersion, port: port, pid: process.pid }));
      return true;
    }
    if (dataPath === '/env-status') {
      /* 密钥来源状态：只暴露「有没有」和尾 4 位，不泄露完整密钥。 */
      const out = {};
      for (const p of providers) {
        const kid = p.keyId || p.id;
        if (out[kid] !== undefined) continue;
        const v = process.env[p.keyEnv] || defaults[kid] || '';
        out[kid] = { hasEnv: !!v, tail: v ? String(v).slice(-4) : '' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
      return true;
    }
    if (dataPath === '/clear-cache' && req.method === 'POST') {
      /* 只清「上游数据的副本」：列表 / 详情 / 资产签名地址 / 能力表。
         hostGuardCache 故意不清：那是 SSRF 防护的 DNS 结果，清了只会让外链重新解析。 */
      const n = {
        list: (caches.listCache && caches.listCache.size) || 0,
        detail: (caches.detailCache && caches.detailCache.size) || 0,
        assetUrl: (caches.assetUrlCache && caches.assetUrlCache.size) || 0,
        cap: (caches.capCache && caches.capCache.size) || 0,
      };
      for (const c of [caches.listCache, caches.detailCache, caches.assetUrlCache, caches.capCache]) {
        if (c && typeof c.clear === 'function') c.clear();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, cleared: n }));
      return true;
    }
    /* /client-error —— 页面侧报错唯一的落点（报告 §6.1-5：Toast、ErrBanner、健康账三份互不通）。
       web/core/report.js 把「致命 / 警告」两类都送到这里，进同一本账，用户在
       「设置 → 本机环境 → 代理健康」里看得见；页面空着而代理一无所知那种事从此有地方查。
       限流两道：同一条消息 30 秒内只记一次、每分钟最多 20 条 —— 页面里有个死循环报错时，
       既不能把这本账只有八条的名额刷满（真故障会被淹掉），也不能变成自己打自己。
       被限流的那几条照实回 counted:false，上报层不重试、不排队。 */
    if (dataPath === '/client-error' && req.method === 'POST') {
      readBody(req, res, 16 * 1024).then(raw => {
        if (raw == null) return;                        // 超上限时 readBody 自己已经应答过
        let b = null;
        try { b = JSON.parse(String(raw)); } catch { b = null; }
        const msg = cut(b && b.message, 160);
        if (!msg) { send(res, 400, { ok: false, error: { message: '没带 message' } }); return; }
        const kind = b.kind === 'warn' ? '警告' : '致命';
        const page = cut(b.page, 40) || '未知页';
        const where = cut(b.where, 120);
        if (!admit(kind + '|' + page + '|' + msg)) { send(res, 200, { ok: true, counted: false }); return; }
        noteFault('页面报错', '[' + page + '] ' + msg + (where ? ' @ ' + where : ''), page);
        send(res, 200, { ok: true, counted: true });
      }).catch(() => send(res, 500, { ok: false }));
      return true;
    }
    return false;
  }

  return { handleSystem };
}

module.exports = { createSystemRoutes };
