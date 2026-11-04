#!/usr/bin/env node
/* 联网搜索端到端：
   - 本机路由要 wb_session Cookie；关闭时 query 回 disabled，不碰上游
   - 设置只回 hasKey、不回明文；非法服务 / 结果数当场 400
   - 假上游同时演 Tavily / DeepSeek / 智谱 / OpenRouter 四种搜索形状：
     请求字段与结果字段按注册表声明映射、10 分钟缓存（同问第二次 cached，不再打上游）
   - 没有声明搜索接口的供应商不能存成搜索服务（400）
   - 上游连不上归到 502 network；/search/read 拒绝回环与明文 http
   - 设置页真的读回设置；改结果数并点保存后落盘
   不碰真实 .data：全部落在 harness 的临时探针目录。 */
'use strict';
const http = require('http');
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page, fake;
  try {
    proxy = await h.startProxy();
    let hits = 0, reads = 0, lastKey = '';
    let lastAuth = '', lastBody = null;
    const sendJson = (res, o) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    /* 一台假上游同时演四种搜索接口的形状：Tavily（api_key + results）、
       DeepSeek（/v1/tools/search + query/count）、智谱（/web_search + search_query/search_result）、
       OpenRouter（chat/completions + url_citation annotations）。
       字段名照各家官方文档写 —— 解析一改错就会在这里露出来。 */
    fake = http.createServer((req, res) => {
      if (req.method !== 'POST' || !/^\/search|^\/v1\/tools\/search$|^\/web_search$|^\/chat\/completions$|^\/api\/paas\/v4\/web_search$/.test(req.url)) {
        reads++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<title>probe</title><p>should never be fetched</p>');
        return;
      }
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        hits++;
        let body = {};
        try { body = JSON.parse(raw); } catch (e) {}
        lastBody = body;
        lastAuth = String(req.headers.authorization || '');
        if (/\/v1\/tools\/search$/.test(req.url)) {
          return sendJson(res, { results: [
            { title: 'DeepSeek 官方搜索', url: 'https://example.com/ds', snippet: '自研搜索引擎', date: '2026-10-19' },
          ] });
        }
        if (/(?:^|\/)web_search$/.test(req.url)) {
          return sendJson(res, { search_result: [
            { title: '智谱网络搜索', link: 'https://example.com/zp', content: '搜索结果摘要', publish_date: '2026-10-18' },
          ] });
        }
        if (/\/chat\/completions$/.test(req.url)) {
          return sendJson(res, { choices: [{ message: { annotations: [
            { type: 'url_citation', url_citation: { url: 'https://example.com/or', title: 'OpenRouter 引用', content: '联网引用正文' } },
          ] } }] });
        }
        lastKey = body.api_key || '';
        sendJson(res, {
          results: [
            { title: '本地优先的 AI 工作台', url: 'https://example.com/a', content: '把数据留在本机。', published_date: '2026-10-01' },
            { title: 'Tavily 文档', url: 'https://example.com/b', content: 'Search API.', published_date: '2026-09-20' },
          ],
        });
      });
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;

    const call = async (p, opt = {}) => {
      const r = await fetch(proxy.base + p, { ...opt, headers: { cookie: proxy.cookie, ...(opt.headers || {}) } });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, json, text };
    };

    const noCookie = await fetch(proxy.base + '/search/settings');
    if (noCookie.status !== 401) throw new Error('没带 Cookie 也读到了搜索设置：HTTP ' + noCookie.status);

    let g = await call('/search/settings');
    if (g.status !== 200 || !g.json || !g.json.settings) throw new Error('读搜索设置失败：' + g.status + ' ' + g.text);
    if (g.json.settings.key !== undefined) throw new Error('搜索设置回显了密钥');
    if (g.json.settings.enabled !== false) throw new Error('默认不应启用联网搜索');

    const off = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '本地优先' }),
    });
    if (off.status !== 400 || !off.json || off.json.kind !== 'disabled') throw new Error('未启用时应当 400 disabled：' + off.status + ' ' + off.text);
    if (hits !== 0) throw new Error('未启用时还是打了上游');

    /* 读网页不跟着总开关一起关：关着时也应走到出站护栏，而不是先回「没有启用」 */
    const readOff = await call('/search/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/x' }),
    });
    if (readOff.status !== 400 || /没有启用/.test(readOff.text)) {
      throw new Error('/search/read 不该跟着搜索总开关一起关：' + readOff.status + ' ' + readOff.text);
    }

    const badProvider = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'bing' }),
    });
    if (badProvider.status !== 400) throw new Error('非法服务应当 400：HTTP ' + badProvider.status);

    const badLimit = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxResults: 50 }),
    });
    if (badLimit.status !== 400) throw new Error('非法结果数应当 400：HTTP ' + badLimit.status);

    const put = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, provider: 'tavily', maxResults: 5,
        credentialSource: 'manual', baseUrl: 'http://127.0.0.1:' + fakePort + '/search', key: 'tvly-e2e' }),
    });
    if (put.status !== 200) throw new Error('保存搜索设置失败：' + put.status + ' ' + put.text);
    if (!put.json.settings.hasKey) throw new Error('保存后 hasKey 应为 true');
    if (put.json.settings.key !== undefined) throw new Error('保存响应回显了密钥');
    const disk = require('fs').readFileSync(require('path').join(proxy.dataDir, 'search.json'), 'utf8');
    if (!/"key": "tvly-e2e"/.test(disk)) throw new Error('搜索密钥没有落到代理那一边的 search.json');

    if (hits !== 0) throw new Error('保存设置不应该打搜索上游');

    const q1 = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '本地优先', limit: 3 }),
    });
    if (q1.status !== 200 || !q1.json || !Array.isArray(q1.json.results)) throw new Error('搜索失败：' + q1.status + ' ' + q1.text);
    if (q1.json.results.length !== 2) throw new Error('结果条数不对：' + q1.json.results.length);
    if (q1.json.results[0].domain !== 'example.com' || q1.json.results[0].publishedAt !== '2026-10-01') throw new Error('结果归一不对：' + JSON.stringify(q1.json.results[0]));
    if (q1.json.cached !== false) throw new Error('第一次搜索不该是缓存');
    if (hits !== 1) throw new Error('第一次搜索应当打一次上游，实际 ' + hits);
    if (lastKey !== 'tvly-e2e') throw new Error('上游没收到 TAVILY api_key');

    const q2 = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '本地优先', limit: 3 }),
    });
    if (q2.status !== 200 || q2.json.cached !== true) throw new Error('同问第二次应当命中缓存：' + q2.status + ' ' + q2.text);
    if (hits !== 1) throw new Error('命中缓存却又打了上游：' + hits);

    /* 专用搜索接口（style: api）：请求字段与结果字段照注册表声明映射。
       DeepSeek 的官方 Search API 是 /v1/tools/search + query/count + 结果里的 snippet/date。 */
    const putDs = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, provider: 'deepseek', credentialSource: 'manual',
        baseUrl: 'http://127.0.0.1:' + fakePort, key: 'sk-ds-e2e' }),
    });
    if (putDs.status !== 200) throw new Error('切到 DeepSeek 搜索接口失败：' + putDs.status + ' ' + putDs.text);
    const ds = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '官方搜索', limit: 2, freshness: 'week' }),
    });
    if (ds.status !== 200 || ds.json.provider !== 'deepseek') throw new Error('DeepSeek 搜索接口没走通：' + ds.status + ' ' + ds.text);
    if (ds.json.freshnessIgnored !== true) throw new Error('DeepSeek 没有标出 freshness 被忽略（时效只有 Tavily 生效）');
    if (ds.json.results[0].url !== 'https://example.com/ds' || ds.json.results[0].publishedAt !== '2026-10-19') {
      throw new Error('DeepSeek 结果字段没映射对：' + JSON.stringify(ds.json.results[0]));
    }
    if (!lastBody || lastBody.query !== '官方搜索' || lastBody.count !== 2) {
      throw new Error('DeepSeek 请求体没按声明映射（query / count）：' + JSON.stringify(lastBody));
    }
    if (lastAuth !== 'Bearer sk-ds-e2e') throw new Error('DeepSeek 请求没带这把密钥：' + lastAuth);

    /* 智谱：/web_search + search_query/count + search_engine，结果是 search_result / link / content */
    const putZp = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'zhipu', credentialSource: 'manual',
        baseUrl: 'http://127.0.0.1:' + fakePort + '/api/paas/v4', key: 'sk-zp-e2e' }),
    });
    if (putZp.status !== 200) throw new Error('切到智谱搜索接口失败：' + putZp.status + ' ' + putZp.text);
    const zp = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '智谱搜索', limit: 1 }),
    });
    if (zp.status !== 200 || zp.json.provider !== 'zhipu') throw new Error('智谱搜索接口没走通：' + zp.status + ' ' + zp.text);
    if (zp.json.results[0].url !== 'https://example.com/zp' || zp.json.results[0].snippet !== '搜索结果摘要') {
      throw new Error('智谱结果字段（link / content）没映射对：' + JSON.stringify(zp.json.results[0]));
    }
    if (!lastBody || lastBody.search_query !== '智谱搜索' || lastBody.count !== 1 || lastBody.search_engine !== 'search_std') {
      throw new Error('智谱请求体没按声明映射（search_query / count / search_engine）：' + JSON.stringify(lastBody));
    }

    /* OpenRouter：chat/completions + openrouter:web_search server tool，结果在 url_citation annotations */
    const putOr = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', credentialSource: 'manual', model: 'probe/model',
        baseUrl: 'http://127.0.0.1:' + fakePort, key: 'sk-or-e2e' }),
    });
    if (putOr.status !== 200) throw new Error('切到 OpenRouter 搜索接口失败：' + putOr.status + ' ' + putOr.text);
    const or = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'OpenRouter 搜索', limit: 1 }),
    });
    if (or.status !== 200 || or.json.provider !== 'openrouter') throw new Error('OpenRouter 搜索接口没走通：' + or.status + ' ' + or.text);
    if (or.json.results[0].url !== 'https://example.com/or' || or.json.results[0].snippet !== '联网引用正文') {
      throw new Error('OpenRouter 的 url_citation 没解析对：' + JSON.stringify(or.json.results[0]));
    }
    if (!lastBody || lastBody.model !== 'probe/model' || !lastBody.tools || lastBody.tools[0].type !== 'openrouter:web_search') {
      throw new Error('OpenRouter 请求体没带 server tool：' + JSON.stringify(lastBody));
    }

    /* 没有声明搜索接口的家不能存进「搜索服务」（存进去点下去必失败） */
    const noSearch = await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });
    if (noSearch.status !== 400) throw new Error('没有搜索接口的供应商应当 400：HTTP ' + noSearch.status);

    const badSite = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x', site: 'bad site' }),
    });
    if (badSite.status !== 400) throw new Error('非法 site 应当 400：HTTP ' + badSite.status);
    const empty = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '   ' }),
    });
    if (empty.status !== 400) throw new Error('空搜索词应当 400：HTTP ' + empty.status);

    /* 上游连不上：502 network（不是 400 bad-request） */
    await call('/search/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1/search' }),
    });
    const dead = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '连不上上游' }),
    });
    if (dead.status !== 502 || !dead.json || dead.json.kind !== 'network') throw new Error('上游连不上应当 502 network：' + dead.status + ' ' + dead.text);

    /* 读网页：回环与明文 http 一律拒绝，且一个字节都不去取 */
    for (const url of ['http://127.0.0.1:' + fakePort + '/page', 'ftp://example.com/a']) {
      const r = await call('/search/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      if (r.status === 200) throw new Error('不该读到的地址被读了：' + url);
    }
    if (reads !== 0) throw new Error('/search/read 把回环地址真取了一次');

    /* 设置页：读回 + 改结果数 + 保存 */
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#settings.html');
    /* 联网搜索那一份表单住在账号卡流里（有哪家顶着这一档就在那张卡上，否则通栏在网格下面），
       「切到那一档」的分段开关已经撤掉 —— 直接等它画出来。 */
    await page.waitFor(() => !!document.querySelector('#searchCard'), 15000);
    await page.waitFor(() => {
      const c = document.querySelector('#searchCard');
      return !!(c && c.offsetParent !== null);
    }, 10000);
    await page.waitFor(() => {
      const c = document.querySelector('#searchCard input[type=checkbox]');
      return c && c.checked;
    }, 10000);
    const ui = await page.eval(async () => {
      const card = document.querySelector('#searchCard');
      const num = card.querySelector('input[type=number]');
      const before = num ? num.value : '';
      if (num) {
        num.value = '4';
        num.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const btn = [...card.querySelectorAll('button')].find(b => /^保存$/.test(b.textContent || ''));
      if (btn) btn.click();
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        if (/已保存/.test(card.innerText)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { before, after: num ? num.value : '', msg: card.innerText.slice(-120), title: card.innerText.slice(0, 30) };
    });
    if (!/联网搜索/.test(ui.title)) throw new Error('设置页没有联网搜索卡：' + ui.title);
    if (ui.before !== '5') throw new Error('设置页没读回 maxResults=5：' + ui.before);
    if (!/已保存/.test(ui.msg)) throw new Error('点保存后没有成功回执：' + ui.msg);
    const after = await call('/search/settings');
    if (after.json.settings.maxResults !== 4) throw new Error('UI 保存没有落盘：maxResults=' + after.json.settings.maxResults);

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 联网搜索端到端通过（Cookie / 关闭闸 / 密钥不回显 / 缓存 / 错误分类 / 读网页护栏 / 设置页）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    if (fake) fake.close();
  }
})();
