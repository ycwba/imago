#!/usr/bin/env node
/* 验证设计稿能不能直接 file:// 双击打开（CSP script-src 'self' 在 file:// 下是否放行）。
   用法：node design/provider-matrix/check-file-protocol.cjs */
'use strict';
const path = require('path');
const url = require('url');
const h = require('../../tests/e2e/harness.cjs');

(async () => {
  const file = url.pathToFileURL(path.join(__dirname, 'index.html')).href;
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 980);
    await page.goto(file);
    await h.sleep(1200);
    const info = await page.eval(() => ({
      url: location.href,
      accounts: document.querySelectorAll('.acct').length,
      addTiles: document.querySelectorAll('.add-tile').length,
      forms: document.querySelectorAll('.incard-form').length,
      formRows: document.querySelectorAll('.incard-form .krow').length,
      demoApi: typeof window.__demo
    }));
    console.log(JSON.stringify(info, null, 2));
    console.log('报错：' + (page.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
