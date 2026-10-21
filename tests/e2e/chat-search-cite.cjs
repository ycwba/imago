#!/usr/bin/env node
/* 助手「联网搜索引用」端到端（「搜索有引用」那条出口）：
   - 一条 javascript: 地址在代理归一那一层就被丢掉，根本进不到页面（结果数与地址都查）
   - 一轮里查两次：来源编号跟着这一轮往后数（不是每次搜索各自从 1 数）
   - 回答下面按同一编号画来源卡片；链接 target=_blank rel=noopener
   - 搜索结果里的标题是外部内容：只当文字，不许变成节点
   - 刷新后来源卡片跟着回合一起回来，而且不再打上游
   不花钱：TextAI.chatStream 换成固定回包；搜索上游是 127.0.0.1 的假 Tavily。
   不碰真实 .data：全部落在 harness 的 .*-probe-* 目录。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page, fake;
  try {
    proxy = await h.startProxy();
    /* 第一问故意把 javascript: 排在前面、并多给一条：代理归一那层要把它剔掉、按 limit 截断 */
    fake = await h.startFakeSearch(q => /第二次/.test(q)
      ? [{ title: '第二问的一条', url: 'https://example.com/c', content: '再一次搜索。', published_date: '2026-10-03' }]
      : [
        { title: '一条不能点的地址', url: 'javascript:alert(1)', content: '不该进结果', published_date: '' },
        { title: '<img src=x onerror=alert(1)>外部标题', url: 'https://example.com/a', content: '把数据留在本机。', published_date: '2026-10-01' },
        { title: '第二条', url: 'https://example.com/b', content: '第二条摘要。', published_date: '2026-10-02' },
        { title: '超出结果数的一条', url: 'https://example.com/d', content: '不该进来', published_date: '' },
      ]);

    const call = async (p, opt = {}) => {
      const r = await fetch(proxy.base + p, { ...opt, headers: { cookie: proxy.cookie, ...(opt.headers || {}) } });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, json, text };
    };

    /* 搜索走代理那一边：启用 + 指到本机假上游（密钥只落盘，不回显） */
    await h.useFakeSearch(proxy, fake, 'tvly-cite');

    /* 代理归一这一层：非 http(s) 的地址进不到结果里，超出结果数的被截掉（页面从此拿不到 javascript:） */
    const gated = await call('/search/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '剔地址探针', limit: 2 }),
    });
    if (gated.status !== 200 || !gated.json || !Array.isArray(gated.json.results)) {
      throw new Error('归一探针搜索失败：' + gated.status + ' ' + gated.text);
    }
    const gUrls = (gated.json.results || []).map(x => x.url);
    if (gUrls.length !== 2) throw new Error('结果数没按 limit 截：' + JSON.stringify(gUrls));
    if (gUrls.some(u => !/^https:\/\//i.test(u))) throw new Error('非 http(s) 的地址被当成结果送回页面：' + JSON.stringify(gUrls));
    if (/javascript:/.test(gated.text)) throw new Error('归一之后的回包里还留着 javascript: 地址');

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => !!window.AiChat, 15000);
    /* 脚本一轮一轮地喂给助手：查两次 → 再给正文。工具循环自己跑，这里只替掉上游那一段。 */
    const seeded = await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      const script = [
        'CALL: web_search {"query":"本地优先 是什么","limit":2}',
        'CALL: web_search {"query":"第二次查询","limit":1}',
        '按搜到的资料回答：本机优先的做法见 [来源 1]，另一条见 [来源 3]。',
      ];
      window.TextAI.chatStream = async () => {
        const line = script.shift();
        return line == null ? '（探针脚本用完）' : line;
      };
      AiChat.open();
      return true;
    });
    if (!seeded) throw new Error('没能准备助手');
    await h.sleep(900);

    await page.eval(() => AiChat.ask('帮我查一下本地优先的做法'));
    await page.waitFor(() => !!document.querySelector('.ac-src'), 25000);

    const cards = await page.eval(() => {
      const box = document.querySelector('.ac-src');
      const a = [...box.querySelectorAll('.ac-src-a')];
      return {
        标题行: (box.querySelector('.ac-src-h') || {}).textContent || '',
        条数: a.length,
        标签: a.map(x => x.textContent.slice(0, 10)),
        地址: a.map(x => x.getAttribute('href')),
        新窗口: a.map(x => x.getAttribute('target')),
        rel: a.map(x => x.getAttribute('rel')),
        被注入的节点: box.querySelectorAll('img,script,iframe').length,
        正文: document.body.innerText.includes('[来源 1]'),
      };
    });
    if (!/来源/.test(cards.标题行)) throw new Error('来源卡片没有说明行：' + cards.标题行);
    if (cards.条数 !== 3) throw new Error('两次搜索一共三条来源，卡片该画三条：' + JSON.stringify(cards));
    if (!(cards.标签[0].startsWith('[来源 1]') && cards.标签[1].startsWith('[来源 2]') && cards.标签[2].startsWith('[来源 3]'))) {
      throw new Error('编号要跟着这一轮往后数（第二次搜索那条该是 3，不是各自从 1 数），实际：' + JSON.stringify(cards.标签));
    }
    if (cards.地址.join(' ') !== 'https://example.com/a https://example.com/b https://example.com/c') {
      throw new Error('卡片地址顺序或取值不对：' + JSON.stringify(cards.地址));
    }
    if (cards.地址.some(u => !/^https:\/\//.test(u || ''))) throw new Error('卡片地址必须是 http(s)：' + JSON.stringify(cards.地址));
    if (cards.新窗口.some(t => t !== '_blank')) throw new Error('来源要开在新标签：' + JSON.stringify(cards.新窗口));
    if (cards.rel.some(r => !/noopener/.test(r || ''))) throw new Error('来源链接少了 rel=noopener：' + JSON.stringify(cards.rel));
    if (cards.被注入的节点 !== 0) throw new Error('外部标题里的 HTML 被当成节点画出来了：' + cards.被注入的节点);
    if (!cards.正文) throw new Error('回答正文里该有 [来源 n]：' + JSON.stringify(cards));

    /* 回合数据要照实存着：刷新后卡片靠它回来；不能点的地址从代理那层就没有进来 */
    const stored = await page.eval(() => localStorage.getItem('ai_chat') || '');
    for (const u of ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']) {
      if (!stored.includes(u)) throw new Error('来源没有随回合落盘：' + u);
    }
    if (/javascript:/.test(stored)) throw new Error('不能点的地址被塞进了回合数据（该在归一层就剔掉）');

    /* 刷新一次：来源卡片跟着回合回来，不靠这一次的上游 */
    const hitsBefore = fake.hits();
    if (hitsBefore !== 3) throw new Error('归一探针 1 次 + 这一轮两次搜索应当打上游 3 次，实际 ' + hitsBefore);
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => !!window.AiChat, 15000);
    await page.eval(() => AiChat.open());
    await page.waitFor(() => !!document.querySelector('.ac-src'), 20000);
    const again = await page.eval(() => [...document.querySelectorAll('.ac-src-a')].map(x => x.textContent.slice(0, 10)));
    if (!(again.length === 3 && /^\[来源 1\]/.test(again[0]) && /^\[来源 2\]/.test(again[1]) && /^\[来源 3\]/.test(again[2]))) {
      throw new Error('刷新后来源卡片没跟着回合回来：' + JSON.stringify(again));
    }
    if (fake.hits() !== hitsBefore) throw new Error('只是回看历史，却又打了一次搜索上游：' + (fake.hits() - hitsBefore));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 助手搜索引用通过（非 http 地址在代理归一层就剔掉 / 一轮两次搜索编号连着数 /'
      + ' 卡片与编号对齐、target=_blank rel=noopener / 外部标题只当文字 / 刷新跟着回合回来、不再打上游）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    if (fake) fake.stop();
  }
})();
