#!/usr/bin/env node
/* 资产库布局稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/assets-layout/shot.cjs
   产出：shots/*.png（浅色主稿 + 抽屉 + 多选 + 清单 + 窄窗 + 深色派生 + 空态）

   做法：起一个只读静态服务器（serve.cjs）→ 本地 Chrome（headless）→ 走 CDP 截屏。
   浏览器与 CDP 那部分借项目 tests/e2e/harness.cjs（同一份，不另抄）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('../../tests/e2e/harness.cjs');
const { start } = require('./serve.cjs');

const here = __dirname;
const outDir = path.join(here, 'shots');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await start(0);
  const url = srv.base + 'design/assets-layout/index.html';
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const shots = [];

  try {
    await page.setSize(1440, 900);
    await page.goto(url);
    await page.waitFor(() => document.querySelectorAll('.as-cell').length >= 10);
    // 等图都进缓存再截（否则首屏有几张是空框）
    await page.eval(() => Promise.all(Array.prototype.map.call(document.images, i =>
      i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
    await wait(500);

    /* ① 主稿：在制台 + 筛选行 + 按天分槽的片墙（浅色） */
    await page.screenshot(path.join(outDir, '01-交片台-浅色-1440.png'));
    shots.push('01-交片台-浅色-1440.png');

    /* ② 详情就地展开：点开一条 → 详情插在它那一行的下面，没有单独一层 */
    await page.eval(() => document.querySelector('.as-cell[data-id="a-01"]').click());
    await wait(400);
    await page.screenshot(path.join(outDir, '02-详情就地展开-浅色-1440.png'));
    shots.push('02-详情就地展开-浅色-1440.png');

    /* ③ 多选态：公共 .bulkbar + 卡上勾选框 */
    await page.eval(() => {
      window.__demo.close();
      window.__demo.set({ multi: true });
      window.__demo.select('a-02');
      window.__demo.select('a-06');
    });
    await wait(350);
    await page.screenshot(path.join(outDir, '03-多选态-浅色-1440.png'));
    shots.push('03-多选态-浅色-1440.png');

    /* ④ 清单档：同一批数据，换一种读法（按天分行，详情也插在行下面） */
    await page.eval(() => window.__demo.set({ multi: false, view: 'list' }));
    await wait(350);
    await page.screenshot(path.join(outDir, '04-清单档-浅色-1440.png'));
    shots.push('04-清单档-浅色-1440.png');

    /* ⑤ 窄窗：日期槽收成一行标签 */
    await page.eval(() => {
      window.__demo.set({ view: 'wall' });
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.setSize(1180, 860);
    await wait(400);
    await page.screenshot(path.join(outDir, '05-窄窗-浅色-1180.png'));
    shots.push('05-窄窗-浅色-1180.png');

    /* ⑥ 深色派生稿：只是把 tokens.css 的深色那一段换上（不另设计一版） */
    await page.setSize(1440, 900);
    await page.eval(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await wait(450);
    await page.screenshot(path.join(outDir, '06-交片台-深色-1440.png'));
    shots.push('06-交片台-深色-1440.png');

    /* ⑦ 空态：筛不出东西时说什么 */
    await page.eval(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      window.__demo.set({ q: '海边的灯塔' });
    });
    await wait(350);
    await page.screenshot(path.join(outDir, '07-空态-浅色-1440.png'));
    shots.push('07-空态-浅色-1440.png');

    /* ⑧ 常态：没有在跑的、也没有出错的 —— 大部分时候页面就是这个样子。
           在制台与问题台一撤，片墙直接顶到页头下面。 */
    await page.eval(() => window.__demo.set({ q: '', showBands: false }));
    await wait(350);
    await page.screenshot(path.join(outDir, '08-常态-浅色-1440.png'));
    shots.push('08-常态-浅色-1440.png');

    const errs = page.errors || [];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
