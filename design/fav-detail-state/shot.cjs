#!/usr/bin/env node
/* 这一稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/fav-detail-state/shot.cjs
   产出：shots/*.png

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
  const url = srv.base + 'design/fav-detail-state/index.html';
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const shots = [];

  try {
    await page.setSize(1440, 900);
    await page.goto(url);
    await page.waitFor(() => document.querySelectorAll('.fv-card').length >= 10);
    await page.eval(() => Promise.all(Array.prototype.map.call(document.images, i =>
      i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
    await wait(500);

    /* ① 主稿：网格档 —— 各种收藏都是同一副骨骸（同宽同形） */
    await page.screenshot(path.join(outDir, '01-主稿-网格档-浅色-1440.png'));
    shots.push('01-主稿-网格档-浅色-1440.png');

    /* ② 网格档里就地展开：那一行保持原样，带子接在它下面，连线指回那张卡 */
    await page.eval(() => window.__demo.open('la:la_mvm5arxotol0'));
    await wait(500);
    await page.screenshot(path.join(outDir, '02-展开带子-浅色-1440.png'));
    shots.push('02-展开带子-浅色-1440.png');

    /* ③ 一条「只剩外链」的：状态牌 + 诊断块（说清代价：换不回来得重新生成，要再扣一次费） */
    await page.eval(() => window.__demo.open('a:sparkcine:7f0c51aa-0c3e-4a2f-9b44-1d0f5a2e8c11'));
    await wait(500);
    await page.screenshot(path.join(outDir, '03-只剩外链-浅色-1440.png'));
    shots.push('03-只剩外链-浅色-1440.png');

    /* ④ 清单档：卡自己变高，下面几行顺移（另一种展开方式，同一份公共件） */
    await page.eval(() => { window.__demo.close(); window.__demo.set({ view: 'list' }); window.__demo.open('la:la_mvm5arxgpu6y'); });
    await wait(500);
    await page.screenshot(path.join(outDir, '04-清单档-就地展开-浅色-1440.png'));
    shots.push('04-清单档-就地展开-浅色-1440.png');

    /* ⑤ 紧凑档 */
    await page.eval(() => { window.__demo.close(); window.__demo.set({ view: 'compact' }); });
    await wait(450);
    await page.screenshot(path.join(outDir, '05-紧凑档-浅色-1440.png'));
    shots.push('05-紧凑档-浅色-1440.png');

    /* ⑥ 深色派生：只是把 tokens.css 的深色那一段换上（不是另设计的一版） */
    await page.eval(() => { window.__demo.set({ view: 'grid', theme: 'dark' }); window.__demo.open('la:la_mvm5arxotol0'); });
    await wait(500);
    await page.screenshot(path.join(outDir, '06-深色派生-1440.png'));
    shots.push('06-深色派生-1440.png');

    /* ⑦ 窄窗 */
    await page.eval(() => { window.__demo.set({ theme: 'light' }); window.__demo.open('la:la_mvm5arxotol0'); });
    await page.setSize(1180, 860);
    await wait(500);
    await page.screenshot(path.join(outDir, '07-窄窗-浅色-1180.png'));
    shots.push('07-窄窗-浅色-1180.png');

    const errs = page.errors || [];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
