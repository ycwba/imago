#!/usr/bin/env node
/* 联网搜索端到端：
   - 本机路由要 wb_session Cookie；关闭时 query 回 disabled，不碰上游
   - 设置只回 hasKey、不回明文；非法服务 / 结果数当场 400
   - Tavily 形状的假上游：结果归一、10 分钟缓存（同问第二次 cached，不再打上游）
   - 上游连不上归到 502 network；/search/read 拒绝回环与明文 http
   - 设置页真的读回设置；改结果数并点保存后落盘
   不碰真实 .data：全部落在 harness 的 .data-probe-*。 */
'use strict';
const http = require('http');
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page, fake;
  try {
    proxy = await h.startProxy();
    let hits = 0, reads = 0, lastKey = '';
    fake = http.createServer((req, res) => {
      if (req.method !== 'POST' || !/^\/search/.test(req.url)) {
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
        lastKey = body.api_key || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [
            { title: '本地优先的 AI 工作台', url: 'https://example.com/a', content: '把数据留在本机。', published_date: '2026-10-01' },
            { title: 'Tavily 文档', url: 'https://example.com/b', content: 'Search API.', published_date: '2026-09-20' },
          ],
        }));
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
