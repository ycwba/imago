#!/usr/bin/env node
/* 滚动位判据：**点一颗按钮不该把视口甩回最上面**。
   用户报过「有的页面点击按钮等组件后视角会移动到页面最上方」——
   根因是「整片重画把滚动容器一起换掉了」：`el.innerHTML = …` 之后，
   里面那只滚动容器是**新节点**，scrollTop 从 0 起（导演台右栏 engine/panel.js:1627 就是这一族）。

   这一条盯两件事：
   · **机制**：造一只滚动容器 → 滚下去 → 把它的父容器整片重画 → 新容器的位置必须还在。
     （修之前：0）
   · **实景**：导演台右栏 `.ed-body` 滚到中段 → 点右栏里那颗会重画整块编辑器的按钮
     （型号布尔开关 `[data-tb]`；没有就换型号，那条路也走 renderEditor）→ 位置必须还在。
     （修之前：0）

   路由：#director.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();

    /* ---------- 机制：整片重画不许吃掉滚动位 ---------- */
    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(() => !!document.querySelector('.assets-page'), 25000, 100);
    await sleep(1200);

    const built = await page.eval(() => {
      const host = document.createElement('div');
      host.id = 'probeScrollHost';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:120px;overflow:hidden';
      const box = document.createElement('div');
      box.id = 'probeScrollBox';
      box.style.cssText = 'width:100%;height:120px;overflow-y:auto';
      box.innerHTML = '<div style="height:1200px"></div>';
      host.appendChild(box);
      document.body.appendChild(host);
      box.scrollTop = 200;
      return box.scrollTop;
    });
    must(built === 200, '造出来的那只滚动容器没滚到 200（探针本身坏了）：' + built);
    await sleep(300);   /* scroll 事件在下一帧才派发，登记表靠它 */

    const after = await page.eval(() => {
      const host = document.getElementById('probeScrollHost');
      const before = document.getElementById('probeScrollBox').scrollTop;
      host.innerHTML = host.innerHTML;          /* ← 这一句走外壳那份保护（web/core/scroll-guard.js） */
      const now = document.getElementById('probeScrollBox');
      return { before, after: now ? Math.round(now.scrollTop) : -1 };
    });
    must(after.before === 200, '重画之前那一只不在 200：' + JSON.stringify(after));
    must(after.after === 200, '整片重画把滚动位吃掉了：' + JSON.stringify(after)
      + '（修之前这里是 0：新节点从 0 起）');

    /* ---------- 实景：导演台右栏 ---------- */
    await page.setSize(1440, 560);              /* 窗口调矮，右栏正文才溢出成滚动容器 */
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => !!document.querySelector('.director-page'), 30000, 100);
    await page.waitFor(() => !!document.querySelector('.ed-body'), 30000, 100);
    await sleep(2500);

    const ready = await page.eval(() => {
      const b = document.querySelector('.ed-body');
      if (!b) return null;
      return { max: b.scrollHeight - b.clientHeight, tb: !!b.querySelector('[data-tb]'),
        model: !!b.querySelector('#edModel') };
    });
    must(ready, '导演台右栏没有 .ed-body（这一页的结构变了，判据要跟着改）');
    must(ready.max > 80, '右栏正文没溢出，滚不动（窗口不够矮或这一栏变短了）：' + JSON.stringify(ready));

    const before2 = await page.eval(() => {
      const b = document.querySelector('.ed-body');
      b.scrollTop = Math.min(200, Math.floor((b.scrollHeight - b.clientHeight) / 2));
      return Math.round(b.scrollTop);
    });
    must(before2 > 60, '右栏没滚下去：' + before2);
    await sleep(250);

    /* 点右栏里那颗会重画整块编辑器的按钮：型号布尔开关优先；没有就换型号（那条路也走 renderEditor）。 */
    const clicked = await page.eval(() => {
      const b = document.querySelector('.ed-body');
      const tb = b.querySelector('[data-tb]');
      if (tb) { tb.click(); return 'data-tb'; }
      const sel = b.querySelector('#edModel');
      if (sel && sel.options.length > 1) {
        sel.selectedIndex = sel.selectedIndex === 0 ? 1 : 0;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'edModel';
      }
      return '';
    });
    must(clicked, '右栏里找不到能触发重画的那颗按钮（判据要跟着改）');
    await sleep(1800);

    const after2 = await page.eval(() => {
      const b = document.querySelector('.ed-body');
      return b ? Math.round(b.scrollTop) : -1;
    });
    must(after2 === before2, '点那颗按钮之后右栏被甩回顶了：' + before2 + ' → ' + after2
      + '（修之前这里是 0）');

    if (page.errors && page.errors.length) {
      console.error('页面异常：\n' + page.errors.slice(0, 5).join('\n'));
      throw new Error('页面上有异常');
    }
    console.log('✓ 滚动位：整片重画不吃掉滚动位（机制）· 导演台右栏点按钮不甩回顶（实景）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
