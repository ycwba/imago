#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：node design/assistant-layout/capture.cjs

   出图：
     01-副驾台-固定档-浅色-1440.png   主形态：固定档（占住右边一整条）
     02-副驾台-工序展开-浅色-1440.png 展开每道工序的细节
     03-副驾台-历史会话-浅色-1440.png  历史会话浮层（沿用真产品那块浮层，做了优化）
     04-副驾台-浮窗档-浅色-1440.png   浮窗形态（贴着屏幕右下角）
     05-副驾台-空态-浅色-1440.png     刚打开、还不知道能问什么
     06-副驾台-固定档-深色-1440.png   同一份稿子切深色档（不是另设计一版）
     07-副驾台-产物区-浅色-1440.png   工单流滚到底：产物网格 / 来源 / 改写前后
     08-副驾台-引用高光-浅色-1440.png 拖进来的素材：正文里那段高亮 + 悬停出缩略图
     09-副驾台-拖放到球-浅色-1440.png 拖资产到悬浮球：球点亮一圈虚线（另一个落点）
     10-副驾台-引用失效-浅色-1440.png 引用文字被改坏 → 高亮消失 + 这条引用作废
     before-现状-助手.png              现状那一张（真机画面，从视觉回归的实际图拷过来）

   「before」那一张来自 tests/fixtures/visual/actual/chat-src_1440_dark.png
   —— 那是真机跑出来的画面，拷进来做对照，一个字节都没改。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

const URL_PATH = 'design/assistant-layout/index.html';

async function shot(page, name) {
  const file = path.join(shots, name);
  await page.screenshot(file);
  console.log('  → ' + name);
}

(async () => {
  /* 现状对照：真机画面 */
  const before = path.join(h.root, 'tests/fixtures/visual/actual/chat-src_1440_dark.png');
  if (fs.existsSync(before)) {
    fs.copyFileSync(before, path.join(shots, 'before-现状-助手.png'));
    console.log('  → before-现状-助手.png（真机画面拷过来做对照）');
  }

  const srv = await require(path.join(here, 'serve.cjs')).start(8094);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(srv.base + URL_PATH);
    await page.waitFor(() => !!document.querySelector('.job'), 15000);
    await h.sleep(700);

    await shot(page, '01-副驾台-固定档-浅色-1440.png');

    /* 引用：正文里那段高亮 + 悬停出来的缩略图浮层（趁工单流还在顶上拍） */
    await page.eval(() => window.__deckShowRefTip(true));
    await h.sleep(400);
    await shot(page, '08-副驾台-引用高光-浅色-1440.png');
    await page.eval(() => window.__deckShowRefTip(false));
    await h.sleep(250);

    /* 引用被改坏：正文是真相 —— 高亮消失，这条引用就作废了 */
    await page.eval(() => window.__deckBreakRef(true));
    await h.sleep(400);
    await shot(page, '10-副驾台-引用失效-浅色-1440.png');
    await page.eval(() => window.__deckBreakRef(false));
    await h.sleep(250);

    /* 工序展开：每道工序多一行说明 */
    await page.eval(() => window.__deckSetTrace(true));
    await h.sleep(400);
    await shot(page, '02-副驾台-工序展开-浅色-1440.png');
    await page.eval(() => window.__deckSetTrace(false));
    await h.sleep(300);

    /* 历史会话：顶栏那枚时钟按钮打开的浮层 */
    await page.eval(() => window.__deckSetHist(true));
    await h.sleep(400);
    await shot(page, '03-副驾台-历史会话-浅色-1440.png');
    await page.eval(() => window.__deckSetHist(false));
    await h.sleep(300);

    /* 浮窗档 */
    await page.eval(() => window.__deckSetMode('float'));
    await h.sleep(450);
    await shot(page, '04-副驾台-浮窗档-浅色-1440.png');

    /* 拖资产到悬浮球：球点亮一圈虚线（浮窗档才看得见球） */
    await page.eval(() => window.__deckSetDrop(true));
    await h.sleep(350);
    await shot(page, '09-副驾台-拖放到球-浅色-1440.png');
    await page.eval(() => window.__deckSetDrop(false));
    await h.sleep(250);

    await page.eval(() => window.__deckSetMode('dock'));
    await h.sleep(350);

    /* 空态 */
    await page.eval(() => window.__deckSetEmpty(true));
    await h.sleep(400);
    await shot(page, '05-副驾台-空态-浅色-1440.png');
    await page.eval(() => window.__deckSetEmpty(false));
    await h.sleep(300);

    /* 深色档：同一份稿子切主题（不是另设计一版） */
    await page.eval(() => window.__deckSetTheme('dark'));
    await h.sleep(450);
    await shot(page, '06-副驾台-固定档-深色-1440.png');
    await page.eval(() => window.__deckSetTheme('light'));
    await h.sleep(350);

    /* 工单流滚到底：产物网格 / 来源 / 改写前后 */
    await page.eval(() => { const s = document.getElementById('deckStream'); s.scrollTop = s.scrollHeight; });
    await h.sleep(450);
    await shot(page, '07-副驾台-产物区-浅色-1440.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：' + errs.slice(0, 5).join(' | '));
    else console.log('稿子无控制台报错。');
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
