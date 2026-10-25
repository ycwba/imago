#!/usr/bin/env node
/* 新建/编辑素材布局稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/materials-detail/shot.cjs
   产出：shots/*.png（1440×900；浅色五张 + 深色派生一张）

   做法：起一个只读静态服务器（serve.cjs）→ 本地 Chrome（headless）→ 走 CDP 截屏。
   浏览器与 CDP 那部分借项目 tests/e2e/harness.cjs（同一份，不另抄）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('../../tests/e2e/harness.cjs');
const { start } = require('./serve.cjs');

const here = __dirname;
const outDir = path.join(here, 'shots-design');   // 静态稿的图单独放 —— 别把真机截图盖了
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await start(0);
  const url = srv.base + 'design/materials-detail/index.html';
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const shots = [];

  try {
    await page.setSize(1440, 900);
    await page.goto(url);
    await page.waitFor(() => !!window.__mdRender);
    await page.eval(() => document.body.classList.add('shotting'));   // 藏掉演示切换条
    await page.eval(() => Promise.all(Array.prototype.map.call(document.images, i =>
      i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
    await wait(400);

    const shot = async (name) => {
      await page.screenshot(path.join(outDir, name));
      shots.push(name);
    };
    /* 某一节的特写：按元素位置截一块（scale 2，看得清字） */
    const clipShot = async (name, selector) => {
      const box = await page.eval(sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, selector);
      if (!box) { console.log('没找到 ' + selector); return; }
      const r = await page.cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), scale: 2 },
      });
      fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
      shots.push(name);
    };
    const goto = async (state) => {
      await page.eval(s => window.__mdRender(s), state);
      await wait(300);
    };

    /* ① 新建素材：空骨架 —— 先把人写清楚，再出图 */
    await goto('new');
    await shot('01-新建素材-空骨架-浅色.png');

    /* ② 新建素材：出图之后 —— 挑一张当预览图 */
    await goto('newPick');
    await shot('02-新建素材-出图后-浅色.png');

    /* ③ 编辑素材 · 角色：预览图 / 锚点 / 候选 / 资产 / 声音 / 使用关系 */
    await goto('actor');
    await shot('03-编辑素材-角色-浅色.png');

    /* ③b 角色资产那一节的特写：生成条 + 每一行自己的重出参数 */
    await clipShot('04-角色资产-特写.png', '.md-sec-assets');

    /* ④ 同一页滚到底：声音与使用关系 */
    await page.eval(() => { const d = document.getElementById('mdDoc'); d.scrollTop = d.scrollHeight; });
    await wait(300);
    await shot('07-编辑素材-角色-声音与使用关系-浅色.png');

    /* ④b 声音那一节的特写：型号 + 条数 + 定声音的方式 + 候选 */
    await clipShot('05-声音-特写.png', '.md-sec-voice');

    /* ④c 换成「复刻参考音频」：下面那一块当场换成参考音频 */
    await page.eval(() => {
      const b = document.querySelector('.gen-way[data-way="复刻参考音频"]');
      if (b) b.click();
    });
    await wait(300);
    await clipShot('06-声音-复刻参考音频-特写.png', '.md-sec-voice');

    /* ⑤ 编辑素材 · 场景：时段出现，角色资产与声音两节不画 */
    await goto('scene');
    await shot('08-编辑素材-场景-浅色.png');

    /* ⑥ 编辑素材 · 道具：只有预览图与描述 */
    await goto('prop');
    await shot('09-编辑素材-道具-浅色.png');

    /* ⑦ 深色派生稿：只是把 tokens.css 的深色那一段换上（不另设计一版） */
    await page.eval(() => {
      window.__mdRender('actor');
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await wait(400);
    await shot('10-编辑素材-角色-深色.png');

    const errs = page.errors || [];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
