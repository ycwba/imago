/* 联网搜索路由：设置 / 搜索 / 读网页。
   - Tavily：POST https://api.tavily.com/search；DeepSeek：走对话模型（需模型本身能联网）；
   - 结果只在内存缓存 10 分钟，失败不自动重试，不编结果；
   - /search/read 是唯一主动出站取网页的读路由（独立于「启用联网搜索」开关）：只允许公网 https，逐跳过 guardOutboundUrl，
     15 秒超时、≤2MB、不带 Cookie、不执行 JS，HTML 转纯文本后返回。 */
'use strict';
const fs = require('fs');
const { sendJson, readJsonBody } = require('./http');
const { channelKey, collect, postJson } = require('../channel-cred.js');

const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 50;
const READ_TIMEOUT = 15000;
const READ_MAX = 2 * 1024 * 1024;
const READ_TEXT_MAX = 40000;
const JSON_MAX = 2 * 1024 * 1024;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
function httpError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}
function domainOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}
function normResults(list, limit) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : [])) {
    const url = clean(x && (x.url || x.link), 1000);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = clean(x && (x.title || x.name), 300) || url;
    const snippet = clean(x && (x.snippet || x.content || x.description || x.text), 1200);
    out.push({
      id: 'r' + (out.length + 1), title, url, domain: clean(x && x.domain, 120) || domainOf(url),
      publishedAt: clean(x && (x.publishedAt || x.published_date || x.date), 40), snippet,
    });
    if (out.length >= limit) break;
  }
  return out;
}
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', copy: '©', reg: '®' };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] != null ? named[n.toLowerCase()] : m));
}
function htmlToText(html) {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const ogM = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html);
  const title = decodeEntities(clean(titleM ? titleM[1] : (ogM ? ogM[1] : ''), 300));
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|template|canvas|video|audio)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(header|footer|nav|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  s = s.replace(/\n{3,}/g, '\n\n');
  const truncated = s.length > READ_TEXT_MAX;
  return { title, text: truncated ? s.slice(0, READ_TEXT_MAX) : s, truncated };
}

function createSearchRoutes(ctx) {
  const cache = new Map();
  /* 哪些供应商会做「联网搜索」：注册表里同时有 extraCaps 与 search 端点声明的那几家。
     设置页的下拉与这里读的是同一份声明，页面不再自己维护一份「tavily / deepseek」名单。 */
  function searchProviders() {
    try {
      return (ctx.providers() || []).filter(p => p.kind === 'text' && p.search
        && (p.extraCaps || []).indexOf('search') >= 0);
    } catch { return []; }
  }
  function providerById(id) {
    try {
      const want = String(id || '');
      return (ctx.providers() || []).find(p => p.id === want || p.keyId === want) || null;
    } catch { return null; }
  }
  /* 这次走谁：
     · auto —— 第一家「声明了搜索接口、并且拿得到密钥」的供应商；都没有时退回单独填的 Tavily 密钥；
     · tavily —— 独立搜索接口，只认单独填的那把（不拿任何供应商的密钥去调它）；
     · 供应商 id —— 用这家自己的搜索接口；密钥默认取渠道那家，credentialSource = manual 时取单独那把。 */
  function resolveEngine(s) {
    const list = searchProviders();
    let pid = String(s.provider || '');
    if (!pid || pid === 'auto') {
      const usable = list.filter(p => channelKey(ctx, p.id));
      /* 接口型优先：chat 那一族（OpenRouter）还要一个对话型号，自动挑它等于留下一个空必填项。 */
      const hit = usable.find(p => p.search.style === 'api') || usable[0];
      if (hit) pid = hit.id;
      else if (s.key) pid = 'tavily';
      else throw httpError('not-configured',
        '没有可用的搜索服务：先接一家支持联网搜索的供应商并配好密钥，或在「联网搜索」里单独填一把 Tavily 密钥');
    }
    if (pid === 'tavily') {
      if (!s.key) throw httpError('not-configured', 'Tavily 要单独填一把搜索密钥（它不认其他供应商的密钥）');
      return { id: 'tavily', style: 'tavily', base: s.baseUrl || 'https://api.tavily.com/search', key: s.key };
    }
    const p = providerById(pid);
    if (!p || !p.search || (p.extraCaps || []).indexOf('search') < 0) {
      throw httpError('not-configured', '「' + pid + '」没有注册搜索接口 —— 在设置里换一家支持联网搜索的供应商');
    }
    const key = s.credentialSource === 'manual' && s.key ? s.key : channelKey(ctx, p.id);
    if (!key) {
      throw httpError('not-configured', '「' + (p.name || p.id) + '」还没有密钥：先给这家配一把，或在下面单独填一把搜索密钥');
    }
    const serviceModels = (p.modelKind === 'search' && Array.isArray(p.models))
      ? p.models : ((p.serviceModels && p.serviceModels.search) || []);
    return { id: p.id, style: p.search.style, decl: p.search, base: s.baseUrl || p.base || '', key, name: p.name || p.id,
      models: serviceModels.map(m => (m && m.id) || m).filter(Boolean) };
  }
  function cacheGet(k) {
    const hit = cache.get(k);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) { cache.delete(k); return null; }
    return hit;
  }
  function cacheSet(k, val) {
    if (cache.size >= CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 10);
      for (const [key] of oldest) cache.delete(key);
    }
    cache.set(k, { at: Date.now(), val });
  }

  /* 与语音识别的 chat-audio 那一族共用 channel-cred 的 postJson：同一份出站护栏、
     同一条系统代理隧道、同一份带上限收字节。这里只补搜索自己的头与超时。 */
  function postSearchJson(url, bodyObj, headers, timeoutMs) {
    const body = Buffer.from(JSON.stringify(bodyObj));
    return postJson(ctx, {
      url, body, timeoutMs, maxBytes: JSON_MAX,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Accept: 'application/json',
        ...(headers || {}),
      },
    });
  }
  function upstreamError(r) {
    let msg = '';
    try {
      const j = JSON.parse(r.text);
      msg = (j.error && (j.error.message || j.error)) || j.message || '';
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch (e) { msg = clean(r.text, 300); }
    return httpError('upstream', '上游拒绝（HTTP ' + r.status + '）' + (msg ? '：' + clean(msg, 400) : ''));
  }
  function joinUrl(base, p) {
    const b = String(base || '').replace(/\/+$/, '');
    const s = String(p || '');
    if (!s) return b;
    if (/^https?:\/\//i.test(s)) return s;
    return b + (s.charAt(0) === '/' ? s : '/' + s);
  }

  async function tavilySearch(s, key, q, limit, site, freshness) {
    const base = (s.baseUrl || 'https://api.tavily.com/search').replace(/\/+$/, '');
    const url = /\/search$/i.test(base) ? base : base + '/search';
    const query = q + (site ? ' site:' + site : '');
    const body = { api_key: key, query, max_results: limit, include_answer: false, include_raw_content: false };
    if (freshness) body.days = freshness === 'day' ? 1 : freshness === 'week' ? 7 : freshness === 'month' ? 30 : 365;
    const r = await postSearchJson(url, body, {}, 20000);
    if (r.status < 200 || r.status >= 300) throw upstreamError(r);
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { throw httpError('upstream', '上游没有返回 JSON'); }
    return normResults(j.results, limit);
  }

  /* 专用搜索接口（DeepSeek / 智谱 / Kimi）：请求体与结果字段全按注册表声明映射，
     解析只有这一份 —— 加一家只加一条声明，不在路由里写 if (prov === …)。
     拿不到带网址的结果就报失败：以前这里是让对话模型「给出网址」，回的是一串编造的链接。 */
  async function apiSearch(eng, q, limit, site) {
    const d = eng.decl;
    const body = { ...(d.extra || {}) };
    const map = d.body || {};
    if (map.query) body[map.query] = q + (site ? ' site:' + site : '');
    if (map.limit) body[map.limit] = limit;
    const r = await postSearchJson(joinUrl(eng.base, d.path), body,
      { Authorization: 'Bearer ' + eng.key }, 30000);
    if (r.status < 200 || r.status >= 300) throw upstreamError(r);
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { throw httpError('upstream', '上游没有返回 JSON'); }
    if (j && j.error) throw httpError('upstream', '上游拒绝：' + clean(j.error.message || j.error, 400));
    const arr = j && (d.results ? j[d.results] : null);
    const f = d.fields || {};
    const rows = (Array.isArray(arr) ? arr : []).map(x => ({
      title: x && x[f.title], url: x && x[f.url], snippet: x && x[f.snippet], publishedAt: x && x[f.publishedAt],
    }));
    const out = normResults(rows, limit);
    if (!out.length) throw httpError('upstream', '上游没有返回带网址的结果');
    return out;
  }

  /* 对话接口里开联网（OpenRouter 的 server tool）：搜索结果以 url_citation annotations 返回。
     解析不到引用就是这次没联网 —— 报失败，不拿正文冒充搜索。 */
  async function chatSearch(eng, q, limit, model, site) {
    const d = eng.decl;
    const m = String(model || (eng.models && eng.models[0]) || d.model || '').trim();
    if (!m) throw httpError('bad-request', '这家联网搜索要一个对话型号：在「联网搜索」里填一个能联网的型号');
    const body = {
      model: m, stream: false, temperature: 0.2,
      /* site 与另外两族同一口径（追在查询词后面）：以前这一族把 site 静默丢了，
         助手传了 site 也当没传。 */
      messages: [{ role: 'user', content: '联网搜索并回答（最多参考 ' + limit + ' 条结果）：' + q + (site ? ' site:' + site : '') }],
      tools: [d.tool],
    };
    const r = await postSearchJson(joinUrl(eng.base, d.path || '/chat/completions'), body,
      { Authorization: 'Bearer ' + eng.key }, 60000);
    if (r.status < 200 || r.status >= 300) throw upstreamError(r);
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { throw httpError('upstream', '上游没有返回 JSON'); }
    if (j && j.error) throw httpError('upstream', '上游拒绝：' + clean(j.error.message || j.error, 400));
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    const anns = Array.isArray(msg.annotations) ? msg.annotations : [];
    const rows = anns.map(a => {
      const c = (a && (a.url_citation || a.citation)) || {};
      return { title: c.title, url: c.url, snippet: c.content || c.snippet };
    });
    const out = normResults(rows, limit);
    if (!out.length) throw httpError('upstream', '上游没有返回搜索引用（这个型号没有执行联网搜索）');
    return out;
  }

  /* 取一页的字节：与 postJson 同一条出站路（ctx.anyRequest + channel-cred 的 collect）。
     为什么不能用全局 fetch：
     · 系统 / 环境代理那一路是 CONNECT 隧道，anyRequest 才会挑出
       ProxyTunnelAgent —— 直连 fetch 在一台「只有代理才出得去」的机器上条条失败，
       而搜索与读网页恰好是唯一需要出公网的两条；
     · guardOutboundUrl 自己解析一次 DNS、undici 再独立解析一次，中间换 IP 就是
       DNS rebinding 的口子；anyRequest 注入的是同一份 guardedLookup，解析只发生一次；
     · collect 是登记在案的那一份「带上限收字节」（见 server/channel-cred.js），
       自己写一份 reader 循环就是第五份，而且漏掉重定向那一跳的 body（不 cancel 就是一条不回收的 socket）。 */
  function getPage(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectOnce = e => { if (settled) return; settled = true; reject(e); };
      const netErr = e => {
        if (e && e.kind) return e;
        const m = String((e && e.message) || e || '');
        return httpError(/timeout|超时/i.test(m) ? 'timeout' : 'network', '取网页失败：' + clean(m, 300));
      };
      let req;
      try {
        req = ctx.anyRequest(url, {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wb-search/1.0)', 'Accept': 'text/html,application/xhtml+xml,text/plain' },
        }, res => {
          const status = res.statusCode;
          const headers = res.headers;
          if ([301, 302, 303, 307, 308].includes(status)) {
            res.resume();                    // 那一小段跳转页丢掉，连接才能回收
            resolve({ status, headers, redirect: headers.location });
            return;
          }
          const len = Number(headers['content-length'] || 0);
          if (len && len > READ_MAX) { res.resume(); rejectOnce(httpError('upstream', '网页超过 2MB，已拒绝')); return; }
          collect(res, READ_MAX)
            .then(text => { if (!settled) { settled = true; resolve({ status, headers, text }); } })
            .catch(e => rejectOnce(/超过/.test(String((e && e.message) || e))
              ? httpError('upstream', '网页超过 2MB，已截断读取') : netErr(e)));
        });
      } catch (e) { rejectOnce(netErr(e)); return; }
      req.setTimeout(READ_TIMEOUT, () => req.destroy(httpError('timeout', '取网页超时（' + Math.round(READ_TIMEOUT / 1000) + ' 秒）')));
      req.on('error', e => rejectOnce(netErr(e)));
      req.end();
    });
  }

  async function readPage(url) {
    let cur = String(url || '');
    for (let hops = 0; hops <= 3; hops++) {
      await ctx.guardOutboundUrl(cur);
      const r = await getPage(cur);
      if (r.redirect !== undefined) {
        if (!r.redirect) throw httpError('upstream', '网页重定向没有给出地址（HTTP ' + r.status + '）');
        try { cur = new URL(r.redirect, cur).toString(); } catch (e) { throw httpError('upstream', '网页重定向地址非法'); }
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw httpError('upstream', '网页返回 HTTP ' + r.status);
      const ct = String(r.headers['content-type'] || '').toLowerCase();
      if (!/text\/html|application\/xhtml|text\/plain/.test(ct)) {
        throw httpError('upstream', '这不是网页（Content-Type: ' + (ct || '未知') + '），只读 HTML / 纯文本');
      }
      const raw = r.text || '';
      if (/text\/plain/.test(ct)) {
        const truncated = raw.length > READ_TEXT_MAX;
        return { title: domainOf(cur), url: cur, domain: domainOf(cur), text: truncated ? raw.slice(0, READ_TEXT_MAX) : raw, truncated };
      }
      const out = htmlToText(raw);
      return { title: out.title || domainOf(cur), url: cur, domain: domainOf(cur), text: out.text, truncated: out.truncated };
    }
    throw httpError('upstream', '网页重定向次数过多（已中止）');
  }

  async function handleSearch(req, res) {
    const url = new URL(req.url, 'http://local');
    const part = url.pathname.replace(/^\/search\/?/, '').split('/').filter(Boolean);
    const method = req.method;
    try {
      if ((!part.length || part[0] === 'settings') && method === 'GET') {
        const s = ctx.store.settings();
        sendJson(res, 200, { settings: s, revision: s.revision });
        return true;
      }
      if (part[0] === 'settings' && method === 'PUT') {
        const body = await readJsonBody(ctx.readBody, req, res, 64 * 1024);
        const patch = body && body.settings ? body.settings : body;
        /* 「搜索服务」只能选 auto / tavily / 真有一条 search 声明的供应商：
           这里先判一次（注册表是动态的，store 那一层看不到它），免得存进一个点下去必失败的 id。 */
        const pid = patch && patch.provider;
        if (pid != null && pid !== 'auto' && pid !== 'tavily') {
          const p = providerById(pid);
          if (!p || !p.search || (p.extraCaps || []).indexOf('search') < 0) {
            sendJson(res, 400, { error: '「' + String(pid) + '」没有注册搜索接口（只能选声明了联网搜索的供应商，或 Tavily）', kind: 'bad-request' });
            return true;
          }
        }
        const s = ctx.store.patch(patch);
        /* 换了引擎 / 接口地址 / 密钥之后，旧结果不能还按同一个 key 命中 10 分钟：
           用户会以为「新密钥没生效」。 */
        cache.clear();
        sendJson(res, 200, { ok: true, settings: s, revision: s.revision });
        return true;
      }
      if (part[0] === 'query' && method === 'POST') {
        const body = await readJsonBody(ctx.readBody, req, res, 64 * 1024);
        const s = ctx.store.raw();
        if (!s.enabled) throw httpError('disabled', '联网搜索没有启用（设置 → 联网搜索）');
        const q = clean(body && body.query, 200);
        if (!q) throw httpError('bad-request', '搜索词不能为空（1–200 字）');
        if (String(body.query || '').trim().length > 200) throw httpError('bad-request', '搜索词最多 200 字');
        let limit = Math.round(Number(body && body.limit) || s.maxResults);
        if (!Number.isFinite(limit) || limit < 1) limit = 1;
        /* 与设置页 / search-store 的上限（1–10）对齐：以前这里截到 8，
           用户把「结果数」设成 10 只回 8 条，界面上看不出被截过。 */
        if (limit > 10) limit = 10;
        const site = clean(body && body.site, 100);
        if (site && !/^[A-Za-z0-9.-]+$/.test(site)) throw httpError('bad-request', 'site 只填域名（例如 example.com）');
        const freshness = ['day', 'week', 'month', 'year'].includes(body && body.freshness) ? body.freshness : '';
        const eng = resolveEngine(s);
        /* 时效过滤只有 Tavily 的 days 参数认；api / chat 两族没有等价字段。
           不静默丢：回执里带一句，助手才知道「这不是只搜了最近一天」。 */
        const freshnessIgnored = !!freshness && eng.style !== 'tavily';
        const ck = [eng.id, eng.style, s.model, eng.base, q, limit, site, freshness].join('|');
        const hit = cacheGet(ck);
        if (hit) { sendJson(res, 200, { results: hit.val, cached: true, provider: eng.id, freshnessIgnored }); return true; }
        const results = eng.style === 'tavily'
          ? await tavilySearch(s, eng.key, q, limit, site, freshness)
          : eng.style === 'api' ? await apiSearch(eng, q, limit, site)
            : await chatSearch(eng, q, limit, s.model, site);
        if (!results.length) throw httpError('upstream', '上游没有返回结果');
        cacheSet(ck, results);
        sendJson(res, 200, { results, cached: false, provider: eng.id, freshnessIgnored });
        return true;
      }
      if (part[0] === 'read' && method === 'POST') {
        const body = await readJsonBody(ctx.readBody, req, res, 64 * 1024);
        /* 读网页不归「启用联网搜索」管：它是「打开一个用户给的公网 https 页面」，
           与搜索渠道、密钥都无关。以前跟着总开关一起关，用户关掉搜索后连自己给的网址都读不了。 */
        const u = clean(body && body.url, 2000);
        if (!u) throw httpError('bad-request', '没有给 url');
        const page = await readPage(u);
        sendJson(res, 200, page);
        return true;
      }
      sendJson(res, 404, { error: '不认识的搜索路由' });
      return true;
    } catch (e) {
      /* 请求体太大 / 连接中断由 readBody 自己答过了（server/app.js），再回一次就是
         ERR_HTTP_HEADERS_SENT —— 异常逃到健康账上记成「请求出错」，而用户已经拿到正确的 413。 */
      if (e && e.alreadyReplied) return true;
      const kind = (e && e.kind) || 'bad-request';
      const code = kind === 'disabled' || kind === 'not-configured' ? 400
        : kind === 'upstream' ? 502 : kind === 'timeout' ? 504 : kind === 'network' ? 502 : 400;
      sendJson(res, code, { error: clean((e && e.message) || e, 800), kind });
      return true;
    }
  }

  return { handleSearch, cache };
}

module.exports = { createSearchRoutes };
