#!/usr/bin/env node
/* 资产库布局稿的「现状」对照图（设计稿专用，不进产品）。
   用法：node design/assets-layout/shot-before.cjs
   产出：shots/before-现状-资产库.png

   这一张拍的是**真品现在这一页**（本机已经起着的那个代理，端口从 .proxy-port 读），
   用来跟新稿并排看 —— 它只读，不改任何数据。

   浏览器与 CDP 那部分借项目 tests/e2e/harness.cjs（同一份，不另抄）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const outDir = path.join(here, 'shots');
const wait = ms => new Promise(r => setTimeout(r, ms));

function proxyBase() {
  const p = path.resolve(here, '../../.proxy-port');
  const port = fs.existsSync(p) ? String(fs.readFileSync(p, 'utf8')).trim() : '';
  if (!port) throw new Error('读不到 .proxy-port：先起一次代理再拍现状图');
  return 'http://127.0.0.1:' + port + '/';
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const base = proxyBase();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.setSize(1440, 900);
    /* 先取一次首页，把会话 Cookie 收下 —— 本机路由（/data 等）要这枚 Cookie。 */
    await page.goto(base);
    await wait(300);
    await page.goto(base + 'shell.html#assets.html');
    await wait(1500);
    /* 侧栏收成窄形态（56px），跟新稿同一个取景 —— 不然两比的是侧栏宽度，不是布局。
       收展开关是左上角那块品牌砖（AGENTS §3.4.3），点它一下就行。 */
    await page.eval(() => {
      const b = document.querySelector('.sb-brand');
      if (b) b.click();
      return !!document.documentElement.classList.contains('sb-open');
    });
    await wait(600);
    /* 等这一页自己画出来：网格里出卡片，或者出了空态 / 错误横幅，都算画出来了。 */
    await page.waitFor(() => {
      const g = document.querySelector('#grid');
      return !!g && (g.children.length > 0 || (g.textContent || '').trim().length > 0);
    }, 45000, 500).catch(() => {});
    await wait(2500);
    await page.eval(() => {
      const hide = document.createElement('style');
      hide.textContent = '#acBall,.toast-box{display:none!important}';
      document.head.appendChild(hide);
      return true;
    });
    await wait(400);
    await page.screenshot(path.join(outDir, 'before-现状-资产库.png'));
    console.log('出图完成：\n  shots/before-现状-资产库.png');
    const errs = page.errors || [];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
