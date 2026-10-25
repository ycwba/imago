#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：node design/director-layout/capture.cjs

   出图：
     01-生成态-浅色-1440.png   顺序模式（生成态）整屏
     02-剪辑态-浅色-1440.png   剪辑模式整屏（这一镜的轨道 + 底部全片轨道）
     03-剪辑态-轨道-浅色.png   底部轨道坞特写（时码尺 + 四条轨行）
     04-生成态-深色-1440.png   同一份稿子切深色档（不是另设计一版）
     05-剪辑态-浅色-1208.png   窄窗
     before-现状-生成态.png / before-现状-剪辑态.png   真机画面，做对照用 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

const URL_PATH = 'design/director-layout/index.html';

async function shot(page, name) {
  await page.screenshot(path.join(shots, name));
  console.log('  → ' + name);
}

/* 按元素取一块（轨道坞特写用）—— harness 的 page.screenshot 只截整屏，
   这里直接走 CDP 的 clip。 */
async function shotEl(page, selector, name) {
  const r = await page.eval(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, selector);
  if (!r) { console.log('  ! 没找到 ' + selector); return; }
  const res = await page.cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 1 },
  });
  fs.writeFileSync(path.join(shots, name), Buffer.from(res.data, 'base64'));
  console.log('  → ' + name);
}

(async () => {
  /* 现状对照：真机画面 */
  const actual = path.join(h.root, 'tests/fixtures/visual/actual');
  for (const [src, dst] of [
    ['01-导演台-生成态.png', 'before-现状-生成态.png'],
    ['10-导演台-剪辑态.png', 'before-现状-剪辑态.png'],
  ]) {
    if (fs.existsSync(path.join(actual, src))) {
      fs.copyFileSync(path.join(actual, src), path.join(shots, dst));
      console.log('  → ' + dst + '（真机画面拷过来做对照）');
    }
  }

  const srv = await require(path.join(here, 'serve.cjs')).start(8097);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(srv.base + URL_PATH);
    await page.waitFor(() => !!document.querySelector('.shot'), 15000);
    await h.sleep(500);

    /* 1 · 生成态（顺序模式） */
    await shot(page, '01-生成态-浅色-1440.png');

    /* 2 · 剪辑态 */
    await page.eval(() => window.__dir.setMode('edit'));
    await h.sleep(500);
    await shot(page, '02-剪辑态-浅色-1440.png');

    /* 3 · 轨道坞特写 */
    await shotEl(page, '#dock', '03-剪辑态-轨道-浅色.png');

    /* 4 · 深色档（同一份稿子切深浅派生，不是另设计一版） */
    await page.eval(() => { window.__dir.setMode('gen'); window.__dir.setTheme('dark'); });
    await h.sleep(450);
    await shot(page, '04-生成态-深色-1440.png');
    await page.eval(() => { window.__dir.setTheme('light'); });
    await h.sleep(350);

    /* 5 · 窄窗 */
    await page.setSize(1208, 900);
    await h.sleep(450);
    await shot(page, '05-生成态-浅色-1208.png');

    /* 6 · 窄窗下的剪辑态 */
    await page.eval(() => window.__dir.setMode('edit'));
    await h.sleep(450);
    await shot(page, '06-剪辑态-浅色-1208.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：' + errs.slice(0, 5).join(' | '));
    else console.log('稿子无控制台报错。');
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
