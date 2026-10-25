#!/usr/bin/env node
/* 收藏页布局稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/favorites-layout/shot.cjs

   产出（shots/）：
     01-新版-摘录行-浅色-1440.png   新版主视图（摘录行）
     02-新版-缩略墙-浅色-1440.png   第二档：缩略墙
     03-现状-对照-浅色-1440.png     同一批内容、改造前的摆法（对照）
     04-新版-窄窗-浅色-1024.png     窄窗
     05-新版-深色-1440.png           深色档（同一个稿子切 data-theme，不是另设计一版）
     06-新版-空态-浅色-1440.png     搜索无结果

   做法：起一个只读静态服务器（serve.cjs）→ 本地 Chrome（headless）→ 走 CDP 截屏。
   浏览器与 CDP 那部分借项目 tests/e2e/harness.cjs（同一份，不另抄）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');
const { start } = require('./serve.cjs');

const here = __dirname;
const outDir = path.join(here, 'shots');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await start(0);
  const url = srv.base + 'design/favorites-layout/index.html';
  const browser = await h.launchBrowser();
  const page = await browser.newPage();
  const shots = [];

  const shot = async name => {
    await page.screenshot(path.join(outDir, name));
    shots.push(name);
    console.log('  → ' + name);
  };
  /* 整页：滚的是 .page-shell 那一格（不是文档），所以要量它的高度；
     把视口撑到那么高，这一页就整个露出来了。 */
  const fullShot = async name => {
    const hgt = await page.eval(() => {
      const el = document.querySelector('.page-shell');
      return Math.min(6000, Math.ceil((el ? el.scrollHeight : document.documentElement.scrollHeight)) + 16);
    });
    await page.setSize(1440, hgt);
    await wait(600);
    await imgsReady();
    await page.screenshot(path.join(outDir, name));
    await page.setSize(1440, 900);
    await wait(300);
    shots.push(name);
    console.log('  → ' + name + '（整页 ' + hgt + 'px）');
  };
  /* 懒加载的图片在视口外不会触发 load —— 截屏前先把它们改成 eager，
     再给一个有上限的等待（否则 CDP 那边会等到 30 秒超时）。 */
  const imgsReady = async () => {
    await page.eval(() => {
      document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
      return true;
    });
    await page.eval(() => Promise.race([
      Promise.all(Array.prototype.map.call(document.images, i =>
        i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))),
      new Promise(r => setTimeout(r, 4000)),
    ]));
    await wait(250);
  };

  try {
    await page.setSize(1440, 900);
    await page.goto(url);
    await page.waitFor(() => document.querySelectorAll('.fv-row').length >= 10, 20000);
    await imgsReady();
    await wait(500);

    /* ① 新版主视图 */
    await shot('01-新版-摘录行-浅色-1440.png');

    /* ①b 整页：一条一条读下去的样子 */
    await fullShot('07-新版-整页-浅色-1440.png');

    /* ② 缩略墙 */
    await page.eval(() => window.__favSetView('wall'));
    await wait(450);
    await imgsReady();
    await wait(300);
    await shot('02-新版-缩略墙-浅色-1440.png');

    /* ③ 现状对照（同一批内容，改造前的摆法） */
    await page.eval(() => { window.__favSetView('rows'); window.__favSetLayout('old'); });
    await wait(450);
    await imgsReady();
    await wait(300);
    await shot('03-现状-对照-浅色-1440.png');

    /* 回到新版 */
    await page.eval(() => window.__favSetLayout('new'));
    await wait(300);

    /* ④ 窄窗 */
    await page.setSize(1024, 900);
    await wait(500);
    await shot('04-新版-窄窗-浅色-1024.png');
    await page.setSize(1440, 900);
    await wait(400);

    /* ⑤ 深色派生档：只是把 tokens.css 的深色那一段换上（不另设计一版） */
    await page.eval(() => window.__favSetTheme('dark'));
    await wait(450);
    await shot('05-新版-深色-1440.png');
    await page.eval(() => window.__favSetTheme('light'));
    await wait(300);

    /* ⑥ 空态 */
    await page.eval(() => window.__favSetQuery('zzz没有这个词'));
    await wait(400);
    await shot('06-新版-空态-浅色-1440.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：\n' + errs.slice(0, 5).join('\n'));
    else console.log('稿子无控制台报错。');
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
