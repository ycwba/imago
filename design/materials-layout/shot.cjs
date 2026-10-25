#!/usr/bin/env node
/* 素材库布局稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/materials-layout/shot.cjs
   产出：shots/*.png（浅色三张 + 深色派生一张 + 窄窗两张）

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
  const url = srv.base + 'design/materials-layout/index.html';
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const shots = [];

  try {
    await page.setSize(1440, 900);
    await page.goto(url);
    await page.waitFor(() => document.querySelectorAll('.mcard').length >= 10);
    // 等图都进缓存再截（否则首屏有几张是空框）
    await page.eval(() => Promise.all(Array.prototype.map.call(document.images, i =>
      i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
    await wait(400);

    /* ① 主稿：目录轨 + 素材台（浅色） */
    await page.screenshot(path.join(outDir, '01-素材台-浅色-1440.png'));
    shots.push('01-素材台-浅色-1440.png');

    /* ② 检查器态：点开「林晚」 */
    await page.eval(() => document.querySelector('.mcard[data-id="linwan"]').click());
    await wait(350);
    await page.screenshot(path.join(outDir, '02-检查器-浅色-1440.png'));
    shots.push('02-检查器-浅色-1440.png');

    /* ③ 多选态：公共 .bulkbar 出来，卡上冒出勾选框 */
    await page.eval(() => {
      document.getElementById('inspClose').click();
      document.getElementById('btnMulti').click();
      const p = document.querySelector('.mcard[data-id="sunian"] .pick');
      if (p) p.click();
    });
    await wait(350);
    await page.screenshot(path.join(outDir, '03-多选态-浅色-1440.png'));
    shots.push('03-多选态-浅色-1440.png');

    /* ④ 深色派生稿：只是把 tokens.css 的深色那一段换上（不另设计一版） */
    await page.eval(() => {
      document.getElementById('btnMulti2').click();
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await wait(400);
    await page.screenshot(path.join(outDir, '04-素材台-深色-1440.png'));
    shots.push('04-素材台-深色-1440.png');

    /* ⑤ 窄窗：目录轨收成覆盖抽屉，检查器也改覆盖式 */
    await page.eval(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.setSize(1100, 860);
    await page.eval(() => document.querySelector('.mcard[data-id="rooftop"]').click());
    await wait(400);
    await page.screenshot(path.join(outDir, '05-窄窗-检查器-浅色.png'));
    shots.push('05-窄窗-检查器-浅色.png');

    /* ⑥ 窄窗 + 目录轨抽屉打开 */
    await page.eval(() => {
      document.getElementById('inspClose').click();
      document.getElementById('railToggle').click();
    });
    await wait(400);
    await page.screenshot(path.join(outDir, '06-窄窗-目录轨-浅色.png'));
    shots.push('06-窄窗-目录轨-浅色.png');

    const errs = page.errors || [];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
