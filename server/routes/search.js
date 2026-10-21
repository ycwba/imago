/* 联网搜索路由：设置 / 搜索 / 读网页。
   - Tavily：POST https://api.tavily.com/search；DeepSeek：走对话模型（需模型本身能联网）；
   - 结果只在内存缓存 10 分钟，失败不自动重试，不编结果；
   - /search/read 是唯一主动出站取网页的读路由：只允许公网 https，逐跳过 guardOutboundUrl，
     15 秒超时、≤2MB、不带 Cookie、不执行 JS，HTML 转纯文本后返回。 */
'use strict';
const fs = require('fs');
const { sendJson, readJsonBody } = require('./http');
const { channelKey, channelBase, loopback, collect } = require('../channel-cred.js');

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
  function resolveCred() {
    const s = ctx.store.raw();
    const key = s.credentialSource === 'manual' ? s.key : (channelKey(ctx, s.channelId) || s.key);
    return { s, key };
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

  async function postJson(url, bodyObj, headers, timeoutMs) {
    if (/^https:/i.test(url)) await ctx.guardOutboundUrl(url);
    else if (!loopback(url)) throw httpError('upstream', '搜索接口只允许 https（本机回环可用 http）');
    const body = Buffer.from(JSON.stringify(bodyObj));
    const h = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Accept': 'application/json',
      ...(headers || {}),
    };
    return await new Promise((resolve, reject) => {
      const cb = res => collect(res, JSON_MAX).then(text => resolve({ status: res.statusCode || 0, text }), reject);
      /* 连接层失败要归到 network / timeout（502 / 504），不能落到默认的 bad-request（400）：
         「上游连不上」与「你参数填错了」是两件事，前端与用户看到的下一句话完全不同。 */
      const fail = e => {
        if (e && e.kind) return reject(e);
        const m = (e && e.message) || String(e || '');
        reject(httpError(/timeout|超时/i.test(m) ? 'timeout' : 'network', '搜索请求失败：' + clean(m, 300)));
      };
      let req;
      try {
        /* 两条分支都走出站层：以前 http（本机回环）那条直接 http.request，
           不带 DNS 闸也不带统一的连接处理；多一套出站实现就多一处会忘了加护栏。 */
        req = ctx.anyRequest(url, { method: 'POST', headers: h }, cb);
        req.setTimeout(timeoutMs, () => req.destroy(httpError('timeout', '搜索请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）')));
      } catch (e) { fail(e); return; }
      req.on('error', fail);
      req.write(body);
      req.end();
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

  async function tavilySearch(s, key, q, limit, site, freshness) {
    const base = (s.baseUrl || 'https://api.tavily.com/search').replace(/\/+$/, '');
    const url = /\/search$/i.test(base) ? base : base + '/search';
    const query = q + (site ? ' site:' + site : '');
    const body = { api_key: key, query, max_results: limit, include_answer: false, include_raw_content: false };
    if (freshness) body.days = freshness === 'day' ? 1 : freshness === 'week' ? 7 : freshness === 'month' ? 30 : 365;
    const r = await postJson(url, body, {}, 20000);
    if (r.status < 200 || r.status >= 300) throw upstreamError(r);
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { throw httpError('upstream', '上游没有返回 JSON'); }
    return normResults(j.results, limit);
  }

  async function deepseekSearch(s, key, q, limit, site, freshness) {
    const base = (s.baseUrl || channelBase(ctx, s.channelId) || 'https://api.deepseek.com').replace(/\/+$/, '');
    const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
    const model = s.model || 'deepseek-chat';
    const scope = (site ? ' 只找站点 ' + site + ' 上的内容。' : '')
      + (freshness ? ' 时间范围：最近' + (freshness === 'day' ? '一天' : freshness === 'week' ? '一周' : freshness === 'month' ? '一个月' : '一年') + '。' : '');
    const body = {
      model, stream: false, temperature: 0.2,
      messages: [
        { role: 'system', content: '你是联网搜索助手。根据检索请求给出真实可访问的网页结果。只输出一个 JSON 对象：'
          + '{"results":[{"title":"","url":"","snippet":"","publishedAt":""}]}，最多 ' + limit + ' 条；'
          + '不要输出解释、不要编造网址。' },
        { role: 'user', content: q + scope },
      ],
    };
    const r = await postJson(url, body, { 'Authorization': 'Bearer ' + key }, 45000);
    if (r.status < 200 || r.status >= 300) throw upstreamError(r);
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { throw httpError('upstream', '上游没有返回 JSON'); }
    if (j.error) throw httpError('upstream', '上游拒绝：' + clean(j.error.message || j.error, 400));
    let content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    content = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(content); } catch (e) {
      const m = /\[[\s\S]*\]/.exec(content) || /\{[\s\S]*\}/.exec(content);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!parsed) throw httpError('upstream', '模型没有返回可解析的搜索结果（换一个能联网的模型，或改用 Tavily）');
    const list = Array.isArray(parsed) ? parsed : parsed.results;
    const out = normResults(list, limit);
    if (!out.length) throw httpError('upstream', '模型没有给出带网址的结果（换一个能联网的模型，或改用 Tavily）');
    return out;
  }

  async function readPage(url) {
    let cur = String(url || '');
    for (let hops = 0; hops <= 3; hops++) {
      await ctx.guardOutboundUrl(cur);
      let r;
      try {
        r = await fetch(cur, {
          redirect: 'manual',
          signal: AbortSignal.timeout(READ_TIMEOUT),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wb-search/1.0)', 'Accept': 'text/html,application/xhtml+xml,text/plain' },
        });
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw httpError('timeout', '取网页超时（15 秒）');
        throw httpError('network', '取网页失败：' + ((e && e.message) || e));
      }
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get('location');
        if (!loc) throw httpError('upstream', '网页重定向没有给出地址（HTTP ' + r.status + '）');
        try { cur = new URL(loc, cur).toString(); } catch (e) { throw httpError('upstream', '网页重定向地址非法'); }
        continue;
      }
      if (!r.ok) throw httpError('upstream', '网页返回 HTTP ' + r.status);
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (!/text\/html|application\/xhtml|text\/plain/.test(ct)) {
        throw httpError('upstream', '这不是网页（Content-Type: ' + (ct || '未知') + '），只读 HTML / 纯文本');
      }
      const len = Number(r.headers.get('content-length') || 0);
      if (len && len > READ_MAX) throw httpError('upstream', '网页超过 2MB，已拒绝');
      if (!r.body) throw httpError('upstream', '网页没有返回内容');
      const reader = r.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > READ_MAX) { try { await reader.cancel(); } catch (e) {} throw httpError('upstream', '网页超过 2MB，已截断读取'); }
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        if (e && e.kind) throw e;
        throw httpError('network', '读网页失败：' + ((e && e.message) || e));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
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
        const s = ctx.store.patch(body && body.settings ? body.settings : body);
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
        if (limit > 8) limit = 8;
        const site = clean(body && body.site, 100);
        if (site && !/^[A-Za-z0-9.-]+$/.test(site)) throw httpError('bad-request', 'site 只填域名（例如 example.com）');
        const freshness = ['day', 'week', 'month', 'year'].includes(body && body.freshness) ? body.freshness : '';
        const cred = resolveCred();
        if (!cred.key) throw httpError('not-configured', '没有可用的搜索密钥（选一个已配密钥的渠道，或在设置里单填一把）');
        const ck = [s.provider, s.model, s.baseUrl, q, limit, site, freshness].join('|');
        const hit = cacheGet(ck);
        if (hit) { sendJson(res, 200, { results: hit.val, cached: true, provider: s.provider }); return true; }
        const results = s.provider === 'deepseek'
          ? await deepseekSearch(s, cred.key, q, limit, site, freshness)
          : await tavilySearch(s, cred.key, q, limit, site, freshness);
        if (!results.length) throw httpError('upstream', '上游没有返回结果');
        cacheSet(ck, results);
        sendJson(res, 200, { results, cached: false, provider: s.provider });
        return true;
      }
      if (part[0] === 'read' && method === 'POST') {
        const body = await readJsonBody(ctx.readBody, req, res, 64 * 1024);
        const u = clean(body && body.url, 2000);
        if (!u) throw httpError('bad-request', '没有给 url');
        const page = await readPage(u);
        sendJson(res, 200, page);
        return true;
      }
      sendJson(res, 404, { error: '不认识的搜索路由' });
      return true;
    } catch (e) {
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
