#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：node design/style-v2/capture.cjs

   出图：
     01-封面-浅色.png    首屏（1440×900）
     02-全页-浅色.png    整页
     03-全页-深色.png    同一份稿子切深色档（不是另设计一版）
     04-窄窗-全页.png    1024 宽
     05-封面-深色.png    首屏（深色） */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

const URL_PATH = 'design/style-v2/index.html';

async function fullShot(page, name) {
  const r = await page.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
  console.log('  → ' + name);
}

async function shot(page, name) {
  await page.screenshot(path.join(shots, name));
  console.log('  → ' + name);
}

/* 整页太长，看不清细节 —— 按段切一张。 */
async function sectionShot(page, sel, name) {
  const box = await page.eval(function (s) {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }, sel);
  if (!box) { console.log('  × 找不到 ' + sel); return; }
  const r = await page.cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: {
      x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16),
      width: box.width + 32, height: box.height + 32, scale: 1,
    },
  });
  fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
  console.log('  → ' + name);
}

(async () => {
  const srv = await require(path.join(here, 'serve.cjs')).start(8097);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(srv.base + URL_PATH);
    await page.waitFor(() => !!document.querySelector('.sheet__row .cell img'), 15000);
    await h.sleep(900);

    await shot(page, '01-封面-浅色.png');
    await fullShot(page, '02-全页-浅色.png');

    await page.eval(() => document.querySelector('[data-theme-set="dark"]').click());
    await h.sleep(600);
    await shot(page, '05-封面-深色.png');
    await fullShot(page, '03-全页-深色.png');

    await page.eval(() => document.querySelector('[data-theme-set="light"]').click());
    await h.sleep(400);
    await page.setSize(1024, 900);
    await h.sleep(500);
    await fullShot(page, '04-窄窗-全页.png');

    await page.setSize(1440, 900);
    await h.sleep(400);
    await sectionShot(page, '#s-color', '06-色彩.png');
    await sectionShot(page, '#s-signature', '07-签名.png');
    await sectionShot(page, '#s-controls', '08-控件.png');
    await sectionShot(page, '#s-parts', '09-件.png');
    await sectionShot(page, '#s-rhythm', '10-节奏.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：' + errs.slice(0, 5).join(' | '));
    else console.log('稿子无控制台报错。');
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
