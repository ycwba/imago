#!/usr/bin/env node
/* 探针（不进产品）：素材卡的图取不到字节时，「已丢失」那个角标跑到哪儿去了。
   角标是 `position:absolute; inset:0` —— 铺开的是「最近的定位祖先」。
   灯箱的舞台、检查器那格大图、详情层的候选排都不是定位容器，
   于是角标会一路铺到整层/整屏。这份探针把那三处都量一遍。 */
'use strict';
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const OUT = path.resolve(__dirname, 'shots-lost');

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Store && !!window.Chars, 20000, 100);
    /* 一条**图取不到**的素材（/asset/<不存在的号> → 代理 404） */
    await page.eval(() => {
      localStorage.setItem('ai_chat_dock', '0');
      localStorage.setItem('char_lib', JSON.stringify({ data: [
        { id: 'c1', name: '坏图的那位', kind: 'actor', face: '/asset/la_missing_probe', anchor: '', look: '齐肩黑发', bio: '师姐',
          assets: [{ id: 'a1', name: '三视图', tpl: 'three', src: '/asset/la_missing_probe2' }] },
      ], ts: Date.now() }));
    });
    await page.goto(proxy.base + '/shell.html#chars.html');
    await page.waitFor(() => document.querySelectorAll('.chars-page .card').length >= 1, 25000, 120);
    await h.sleep(2500);

    const box = sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const probe = () => ({
      tips: [...document.querySelectorAll('.lost-tip')].map(t => {
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          parent: t.parentElement ? (t.parentElement.className || t.parentElement.id || t.parentElement.tagName) : '' };
      }),
      vw: window.innerWidth, vh: window.innerHeight,
    });

    console.log('① 素材台：' + JSON.stringify(await page.eval(probe)));
    console.log('   卡片图位：' + JSON.stringify(await page.eval(() => {
      const el = document.querySelector('.chars-page .mthumb');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })));

    /* ② 点卡片正文 → 右侧检查器 */
    await page.eval(() => { const n = document.querySelector('.chars-page .card .mname'); if (n) n.click(); });
    await h.sleep(1500);
    console.log('② 检查器：' + JSON.stringify(await page.eval(probe)));
    console.log('   检查器大图：' + JSON.stringify(await page.eval(() => {
      const el = document.querySelector('.chars-page .insp-hero');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })));
    await page.screenshot(path.join(OUT, '01-检查器.png'));

    /* ③ 点「编辑」→ 整屏层 */
    await page.eval(() => { const b = document.querySelector('.chars-page .card .macts button'); if (b) b.click(); });
    await h.sleep(2000);
    console.log('③ 详情层：' + JSON.stringify(await page.eval(probe)));
    await page.screenshot(path.join(OUT, '02-详情层.png'));

    /* ④ 点缩略图 → 灯箱 */
    await page.eval(() => {
      const back = document.querySelector('.md-layer .md-back'); if (back) back.click();
    });
    await h.sleep(500);
    await page.eval(() => {
      const t = document.querySelector('.chars-page .mthumb img'); if (t) t.click();
    });
    await h.sleep(1500);
    console.log('④ 灯箱：' + JSON.stringify(await page.eval(probe)));
    await page.screenshot(path.join(OUT, '03-灯箱.png'));

    const errs = (page.errors || []).filter(Boolean);
    console.log(errs.length ? '页面报错：\n' + errs.slice(0, 5).join('\n') : '零控制台错误');
    console.log('截图在 ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
