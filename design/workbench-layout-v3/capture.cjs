#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：node design/workbench-layout-v3/capture.cjs

   出图：
     01-两栏-浅色-1440.png   整屏（宽窗）
     02-两栏-浅色-1208.png   真实内容宽（侧栏展开时工作台能分到的宽度）
     03-两栏-浅色-1024.png   窄窗
     04-两栏-深色-1440.png   同一份稿子切深色档（不是另设计一版）
     05-两栏-图像档-1440.png 切到「图像」那一档
     06-两栏-提交回执-1440.png 提交后：状态条原地出回执
     before-现状-工作台.png   现状那一张（真机画面，从视觉回归的实际图拷过来） */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

const URL_PATH = 'design/workbench-layout-v3/index.html';

async function shot(page, name) {
  await page.screenshot(path.join(shots, name));
  console.log('  → ' + name);
}

(async () => {
  /* 现状对照：真机画面 */
  const before = path.join(h.root, 'tests/fixtures/visual/actual/02-生成工作台-视频.png');
  if (fs.existsSync(before)) {
    fs.copyFileSync(before, path.join(shots, 'before-现状-工作台.png'));
    console.log('  → before-现状-工作台.png（真机画面拷过来做对照）');
  }

  const srv = await require(path.join(here, 'serve.cjs')).start(8095);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(srv.base + URL_PATH);
    await page.waitFor(() => !!document.querySelector('.card'), 15000);
    await h.sleep(600);

    await shot(page, '01-两栏-浅色-1440.png');

    await page.setSize(1208, 900);
    await h.sleep(400);
    await shot(page, '02-两栏-浅色-1208.png');

    await page.setSize(1024, 900);
    await h.sleep(400);
    await shot(page, '03-两栏-浅色-1024.png');

    await page.setSize(1440, 900);
    await h.sleep(400);
    await page.eval(() => window.__benchSetTheme('dark'));
    await h.sleep(450);
    await shot(page, '04-两栏-深色-1440.png');

    await page.eval(() => { window.__benchSetTheme('light'); window.__benchSetType('image'); });
    await h.sleep(450);
    await shot(page, '05-两栏-图像档-1440.png');

    await page.eval(() => { window.__benchSetType('video'); });
    await h.sleep(350);
    await page.eval(() => { document.getElementById('goBtn').click(); });
    await h.sleep(2600);
    await shot(page, '06-两栏-提交回执-1440.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：' + errs.slice(0, 5).join(' | '));
    else console.log('稿子无控制台报错。');
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
