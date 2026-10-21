#!/usr/bin/env node
/* 助手动作卡片：RUN → ActionRegistry.plan → 用户点「执行」→ run；一张卡只认一次。
   不花钱：把 TextAI.chatStream 换成固定回包，动作选 set_setting（只写一个主题偏好）。 */
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
    const seeded = await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      localStorage.setItem('dir_theme', 'light');
      window.TextAI.chatStream = async () => 'RUN: set_setting {"key":"dir_theme","value":"dark"}';
      AiChat.open();
      return true;
    });
    if (!seeded) throw new Error('没能准备助手');
    await sleep(900);
    await page.waitFor(() => {
      const hint = document.getElementById('acHint');
      return !!(hint && /stub-model/.test(hint.textContent || ''));
    }, 8000);
    await page.eval(() => AiChat.ask('把主题改成深色'));
    await page.waitFor(() => !!document.querySelector('.ac-run'), 15000);
    const card = await page.eval(() => {
      const c = document.querySelector('.ac-run');
      return { text: c.innerText.slice(0, 300), buttons: [...c.querySelectorAll('button')].map(b => b.textContent) };
    });
    if (!card.text.includes('改一项设置') || !card.buttons.includes('执行')) throw new Error('动作卡片不对：' + JSON.stringify(card));
    await page.eval(() => { [...document.querySelector('.ac-run').querySelectorAll('button')].find(b => b.textContent === '执行').click(); });
    await page.waitFor(() => localStorage.getItem('dir_theme') === 'dark', 15000);
    const after = await page.eval(() => {
      const c = document.querySelector('.ac-run');
      return { theme: localStorage.getItem('dir_theme'), buttons: [...c.querySelectorAll('button')].map(b => b.textContent) };
    });
    if (after.theme !== 'dark') throw new Error('动作没有落盘：' + JSON.stringify(after));
    if (after.buttons.includes('执行')) throw new Error('执行过的卡片还留着「执行」按钮（会被点第二次）');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 助手动作卡片通过（planToken 卡片 → 执行 → 落盘 → 不可重复执行）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
