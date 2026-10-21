#!/usr/bin/env node
/* 动作结果反馈：卡片执行后必须有回执、按钮消失、结果落盘。 */
'use strict';
const h = require('./harness.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => !!window.AiChat, 15000);
    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      localStorage.setItem('dir_theme', 'light');
      window.TextAI.chatStream = async () => 'RUN: set_setting {"key":"dir_theme","value":"dark"}';
      AiChat.open();
    });
    await page.waitFor(() => !!document.querySelector('#acPanel'), 8000);
    await sleep(300);
    await page.eval(() => AiChat.ask('把主题改成深色'));
    await page.waitFor(() => !!document.querySelector('.ac-run'), 15000);
    await page.eval(() => { [...document.querySelector('.ac-run').querySelectorAll('button')].find(b => b.textContent === '执行').click(); });
    await page.waitFor(() => localStorage.getItem('dir_theme') === 'dark', 15000);
    await page.waitFor(() => {
      const st = document.querySelector('.ac-run-st');
      return !!(st && st.textContent.trim().length);
    }, 15000);
    const after = await page.eval(() => {
      const st = document.querySelector('.ac-run-st');
      return {
        theme: localStorage.getItem('dir_theme'),
        receipt: st ? st.textContent.trim() : '',
        cls: st ? st.className : '',
        buttons: [...document.querySelector('.ac-run').querySelectorAll('button')].map(b => b.textContent),
      };
    });
    if (after.theme !== 'dark') throw new Error('动作没有落盘');
    if (!after.receipt) throw new Error('执行后没有回执');
    if (!/成功|完成|已/.test(after.receipt)) throw new Error('回执没有说清结果：' + after.receipt);
    if (after.buttons.includes('执行')) throw new Error('执行过的卡片还留着「执行」按钮');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 动作结果反馈通过（回执可见、按钮不可重复、结果已落盘）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
