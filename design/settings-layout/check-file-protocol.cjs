#!/usr/bin/env node
/* 验证设计稿能不能直接 file:// 双击打开（CSP script-src 'self' 在 file:// 下是否放行）。
   用法：node design/settings-layout/check-file-protocol.cjs */
'use strict';
const path = require('path');
const url = require('url');
const h = require('../../tests/e2e/harness.cjs');

(async () => {
  const file = url.pathToFileURL(path.join(__dirname, 'index.html')).href;
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(file);
    await h.sleep(1200);
    const info = await page.eval(() => ({
      url: location.href,
      railItems: document.querySelectorAll('#rail .rl-item').length,
      searchVisible: !!document.querySelector('#railSearch'),
      detailLen: (document.querySelector('#detail') || { innerText: '' }).innerText.length
    }));
    console.log(JSON.stringify(info, null, 2));
    console.log('报错：' + (page.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
