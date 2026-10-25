#!/usr/bin/env node
/* 这一稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/asset-detail-state/shot.cjs
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
  const url = srv.base + 'design/asset-detail-state/index.html';
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const shots = [];

  try {
    await page.setSize(1440, 900);
    await page.goto(url);
    await page.waitFor(() => document.querySelectorAll('.as2-card').length >= 10);
    await page.eval(() => Promise.all(Array.prototype.map.call(document.images, i =>
      i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
    await wait(500);

    /* ① 主稿：五种状态同屏 —— 每一张都是同一副骨骸（同宽同形） */
    await page.screenshot(path.join(outDir, '01-主稿-同形卡片-浅色-1440.png'));
    shots.push('01-主稿-同形卡片-浅色-1440.png');

    /* ② 就地展开：一条完成品 —— 那张卡自己打开，下面几行顺移 */
    await page.eval(() => window.__demo.open('a-01'));
    await wait(500);
    await page.screenshot(path.join(outDir, '02-就地展开-完成品-浅色-1440.png'));
    shots.push('02-就地展开-完成品-浅色-1440.png');

    /* ③ 就地展开：一条失败条目 —— 平台原话给全句 + 代价 + 动作 */
    await page.eval(() => window.__demo.open('a-02'));
    await wait(500);
    await page.screenshot(path.join(outDir, '03-就地展开-失败条目-浅色-1440.png'));
    shots.push('03-就地展开-失败条目-浅色-1440.png');

    /* ④ 就地展开：一条「结果未知」 —— 琥珀那一档，代价与按钮挨着放 */
    await page.eval(() => window.__demo.open('a-05'));
    await wait(500);
    await page.screenshot(path.join(outDir, '04-就地展开-结果未知-浅色-1440.png'));
    shots.push('04-就地展开-结果未知-浅色-1440.png');

    /* ⑤ 方块档：同一批数据换一种读法（格子不展开 —— 展开的是行下面那条带子） */
    await page.eval(() => { window.__demo.close(); window.__demo.set({ view: 'tiles' }); });
    await wait(450);
    await page.screenshot(path.join(outDir, '05-方块档-浅色-1440.png'));
    shots.push('05-方块档-浅色-1440.png');

    /* ⑤b 方块档里就地展开：那一行保持原样，带子接在它下面，连线指回那个格子 */
    await page.eval(() => window.__demo.open('a-05'));
    await wait(500);
    await page.screenshot(path.join(outDir, '05b-方块档-展开带子-浅色-1440.png'));
    shots.push('05b-方块档-展开带子-浅色-1440.png');

    /* ⑥ 常态：没有失败的、也没有结果未知的 —— 大部分时候页面就是这个样子 */
    await page.eval(() => { window.__demo.set({ view: 'list', hideAnomalies: true }); });
    await wait(450);
    await page.screenshot(path.join(outDir, '06-常态-浅色-1440.png'));
    shots.push('06-常态-浅色-1440.png');

    /* ⑦ 深色派生：只是把 tokens.css 的深色那一段换上（不是另设计的一版） */
    await page.eval(() => { window.__demo.set({ hideAnomalies: false, theme: 'dark' }); window.__demo.open('a-02'); });
    await wait(500);
    await page.screenshot(path.join(outDir, '07-深色派生-1440.png'));
    shots.push('07-深色派生-1440.png');

    /* ⑧ 窄窗：就地展开在窄窗里也一样（清单档的卡变高，下面顺移） */
    await page.eval(() => { window.__demo.set({ theme: 'light' }); window.__demo.open('a-01'); });
    await page.setSize(1180, 860);
    await wait(500);
    await page.screenshot(path.join(outDir, '08-窄窗-就地展开-浅色-1180.png'));
    shots.push('08-窄窗-就地展开-浅色-1180.png');

    const errs = page.errors || [];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
