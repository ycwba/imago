#!/usr/bin/env node
/* 逐卡截图：把真机设置页的每一张卡单独截成一张 PNG（clip 抓元素框）。
   用途：新稿内部行式的排版要按**真内容**来设计，不是按想象。
   用法：node design/settings-layout/capture-cards.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const root = h.root;
const here = __dirname;
const out = path.join(here, 'shots', 'cards');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const proxy = await h.startProxy();
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('dir_theme', 'light'); } catch (e) {} });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => {
      const el = document.querySelector('.settings-page');
      return !!el && el.innerText.length > 120;
    }, 20000);
    await h.sleep(1500);

    /* 这一页是**容器内滚**：文档高度只有视口那么高，内容在 .settings-page 里滚。
       所以先把视口撑到整页高度（容器是 absolute inset:0，长高就全露出来了），
       这时元素的 getBoundingClientRect 就是文档坐标，clip 才抓得到。 */
    const total = await page.eval(() => {
      const cont = document.querySelector('.settings-page');
      return cont ? cont.scrollHeight : 0;
    });
    await page.setSize(1440, Math.min(7000, total + 40));
    await h.sleep(700);

    const rects = await page.eval(() => {
      return Array.from(document.querySelectorAll('.settings-page .card')).map((c, i) => {
        const r = c.getBoundingClientRect();
        const h2 = c.querySelector('.card-h');
        return {
          i,
          title: (h2 ? h2.innerText : '(无标题)').trim().replace(/\s+/g, ' '),
          group: (c.closest('.set-group') || { dataset: {} }).dataset.group || '?',
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height)
        };
      });
    });
    console.log('找到卡片 ' + rects.length + ' 张（视口 1440×' + Math.min(7000, total + 40) + '）');

    for (const c of rects) {
      if (!c.w || !c.h) { console.log('跳过 #' + c.i + '（尺寸 0）'); continue; }
      const r = await page.cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: c.x, y: c.y, width: c.w, height: Math.min(c.h, 2400), scale: 1 }
      });
      const safe = (c.title || 'card').replace(/[\\/:*?"<>|]/g, '_').replace(/[^0-9A-Za-z\u4e00-\u9fa5_.-]/g, '').slice(0, 24);
      const name = String(c.i + 1).padStart(2, '0') + '-' + safe + '.png';
      fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
      console.log('  ' + name + '  (' + c.w + '×' + c.h + ')');
    }
  } finally {
    await browser.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
