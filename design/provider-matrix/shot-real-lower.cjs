#!/usr/bin/env node
/* 真机截图：设置页下面那几张卡（确认 .hint 基字号改动没有把别处弄糟）。 */
'use strict';
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const outDir = path.join(__dirname, 'shots-real');

(async () => {
  const proxy = await h.startProxy();
  const b = await h.launchBrowser();
  try {
    const p = await b.newPage();
    await p.setSize(1440, 1000);
    await p.goto(proxy.base + '/shell.html#settings.html');
    await p.waitFor(() => !!document.querySelector('.acct-grid'), 30000);
    await h.sleep(2200);
    await p.eval(() => {
      const el = [...document.querySelectorAll('.set-rail-i')]
        .find(x => (x.innerText || '').indexOf('网络与刷新') >= 0);
      if (el) el.click();
    });
    await h.sleep(1200);
    await p.screenshot(path.join(outDir, '04-lower-cards.png'));
    console.log('④ 下面那几张卡已截');
    console.log('报错：' + (p.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await b.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
