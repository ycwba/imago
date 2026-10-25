#!/usr/bin/env node
/* 拍**真机**的「我的收藏」页（改造前），顺带把真侧栏的结构取出来。
   这一步只读真机，一个字节都不写回 `.data/`。

   用法：node design/favorites-layout/shoot-real.cjs

   产出：
     shots/before-现状-收藏页.png   真机首屏（1440×900，浅色）
     sidebar.html                 真侧栏的结构（稿子直接用这一份，保证前后可比） */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

const PORT = Number((fs.readFileSync(path.join(h.root, '.proxy-port'), 'utf8').trim()) || 5175);

(async () => {
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    /* 先打一次根，拿到会话 Cookie（同源之后就带着走了）。 */
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.goto(`http://127.0.0.1:${PORT}/shell.html#favorites.html`);
    await page.waitFor(() => document.querySelector('.fav-page') !== null, 30000);
    /* 等这一页真的画完：卡片出来，或者空态那句话出来（两种都算「读完了」）。 */
    await page.waitFor(() => {
      const p = document.querySelector('.fav-page');
      if (!p) return false;
      return !!p.querySelector('.grid .card') || /还没有收藏|没有匹配/.test(p.innerText || '');
    }, 60000);
    await h.sleep(2500);

    /* 真侧栏的结构（满形态 232px） */
    const sb = await page.eval(() => {
      const el = document.querySelector('.sidebar');
      return el ? el.outerHTML : '';
    });
    if (sb) {
      fs.writeFileSync(path.join(here, 'sidebar.html'), sb, 'utf8');
      console.log('侧栏结构：sidebar.html（' + sb.length + ' 字符）');
    } else {
      console.log('! 没取到侧栏结构');
    }

    await page.screenshot(path.join(shots, 'before-现状-收藏页.png'));
    console.log('→ before-现状-收藏页.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('真机报错：' + errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
