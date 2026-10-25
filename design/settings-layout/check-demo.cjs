#!/usr/bin/env node
/* 稿子自检：把设计稿在 headless Chrome 里打开，把报错与关键文本打出来。
   用法：node design/settings-layout/check-demo.cjs */
'use strict';
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');
const here = __dirname;

(async () => {
  const srv = await require(path.join(here, 'serve.cjs')).start(8096);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(srv.base + 'index.html');
    await h.sleep(1200);
    const info = await page.eval(() => {
      const s = document.querySelector('#railSearch');
      const r = s ? s.getBoundingClientRect() : null;
      return {
        url: location.href,
        title: document.title,
        bodyLen: document.body.innerText.length,
        hasRail: !!document.querySelector('#rail'),
        hasSearch: !!s,
        searchVisible: !!(r && r.width > 0 && r.height > 0),
        railItems: document.querySelectorAll('#rail .rl-item').length,
        detailLen: (document.querySelector('#detail') || { innerText: '' }).innerText.length,
        head: document.body.innerText.slice(0, 300)
      };
    });
    console.log(JSON.stringify(info, null, 2));
    console.log('页面报错：');
    console.log(page.errors.slice(0, 10).join('\n---\n') || '（无）');
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
