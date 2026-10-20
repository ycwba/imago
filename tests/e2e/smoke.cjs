#!/usr/bin/env node
/* W0 浏览器冒烟：隔离代理 + headless Chrome，确认外壳可加载、七个页面能切、无控制台异常。
   跑法：`node tests/e2e/smoke.cjs`（或 `node tests/all.cjs --e2e`） */
'use strict';
const path = require('path');
const h = require('./harness.cjs');

const PAGES = [
  ['director.html', 'director'],
  ['studio.html?t=video', 'studio'],
  ['studio.html?t=image', 'studio'],
  ['studio.html?t=audio', 'studio'],
  ['chars.html', 'chars'],
  ['favorites.html', 'favorites'],
  ['assets.html', 'assets'],
  ['usage.html', 'usage'],
  ['settings.html', 'settings'],
];

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    let bad = 0;
    for (const [route, name] of PAGES) {
      await page.goto(proxy.base + '/shell.html#' + route);
      await page.waitFor(() => document.body && document.body.innerText.trim().length > 20, 15000);
      const info = await page.eval(() => ({
        route: window.__spaRoute ? window.__spaRoute().file : location.hash,
        text: document.body.innerText.length,
        title: document.title,
        sheets: document.styleSheets.length,
        css: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean),
      }));
      if (!info || !info.text) { bad++; console.log('✗ ' + route + ' 空白'); continue; }
      if (!info.sheets) { bad++; console.log('✗ ' + route + ' 没有加载样式'); continue; }
      if (page.errors.length) { bad++; console.log('✗ ' + route + ' 控制台错误：' + page.errors.slice(-3).join(' | ')); page.errors.length = 0; }
      else console.log('✓ ' + route + '（' + info.text + ' 字）');
      if (route === 'settings.html') {
        await page.waitFor(() => !!(window.__skillBodies && Object.keys(window.__skillBodies).length), 8000).catch(() => {});
        const sk = await page.eval(async () => {
          if (!window.WbSkills) return { client: false };
          const items = await window.WbSkills.list(true);
          const sync = window.__skillBodies && window.TextAI
            ? Object.keys(window.TextAI.SKILL_CONTRACT).every(k => !window.TextAI.skillBody(k) || window.TextAI.skillBody(k) === window.TextAI.DEF[k])
            : false;
          return { client: true, n: items.length, builtin: items.some(x => x.id === 'video-prompt' && x.source === 'builtin'), sync };
        });
        if (!sk.client || !sk.builtin) { bad++; console.log('✗ Skill 客户端或内置 Skill 清单不可用：' + JSON.stringify(sk)); }
        if (!sk.sync) { bad++; console.log('✗ 内置 Skill 正文与 TextAI.DEF 漂开了（同一份提示词两处维护）'); }
      }
      if (route === 'director.html') {
        await page.waitFor(() => !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()), 15000)
          .catch(() => {});
        await page.screenshot(path.join(__dirname, '../fixtures/golden/smoke-director.png'));
        const wired = await page.eval(() => ({
          media: !!(window.EditorMedia && typeof window.EditorMedia.exportSrc === 'function' && typeof window.EditorMedia.previewSrc === 'function'),
          engine: !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()),
          fallback: !!document.querySelector('.director-fallback'),
        }));
        if (!wired.media) { bad++; console.log('✗ 导演台没有接上 EditorMedia'); }
        if (!wired.engine) { bad++; console.log('✗ 导演台引擎没有挂载（WBBridge.director 未就绪）'); }
        if (wired.fallback) { bad++; console.log('✗ 导演台显示了启动失败提示'); }
      }
    }
    if (bad) throw new Error(bad + ' 个页面失败');
    console.log('\n✓ e2e 冒烟通过');
  } catch (e) {
    console.error('\n✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
