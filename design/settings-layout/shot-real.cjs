#!/usr/bin/env node
/* 真机截图：改完之后的设置页（首屏 + 切到「语音识别」那一档）。
   用法：node design/settings-layout/shot-real.cjs */
'use strict';
const h = require('../../tests/e2e/harness.cjs');

(async () => {
  const proxy = await h.startProxy();
  const b = await h.launchBrowser();
  try {
    const p = await b.newPage();
    await p.setSize(1440, 900);
    await p.goto(proxy.base + '/shell.html#settings.html');
    await p.waitFor(() => {
      const e = document.querySelector('.settings-page');
      return !!e && e.innerText.length > 200;
    }, 20000);
    await h.sleep(2500);
    await p.screenshot('design/settings-layout/shots/real-settings.png');
    console.log('首屏已截');
    await p.eval(() => {
      const el = [...document.querySelectorAll('.set-rail-i')]
        .find(x => x.querySelector('.set-rail-n').textContent.indexOf('语音识别') >= 0);
      if (el) el.click();
    });
    await h.sleep(1800);
    await p.screenshot('design/settings-layout/shots/real-settings-asr-tab.png');
    console.log('语音识别那一档已截');
    console.log('报错：' + (p.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await b.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
