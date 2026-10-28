#!/usr/bin/env node
/* 滚动位判据：**点一颗按钮不该把视口甩回最上面**。
   用户报过「有的页面点击按钮等组件后视角会移动到页面最上方」——
   根因是「整片重画把滚动容器一起换掉了」：`el.innerHTML = …` 之后，
   里面那只滚动容器是**新节点**，scrollTop 从 0 起。

   保护不在外壳：全站一份公共件 `Wb.viewport.keep`（实现 `web/ui/workbench.js`），
   重画点自己调它（列表那一族由 `Wb.cards.paint` 统一调用）。这一条盯三件事：
   · **裸重画确实会丢**：不套 keep 的那一次必须回到 0 —— 它是对照，
     没有它，「keep 把位置还回去」可能只是浏览器自己没动。
   · **机制**：套 keep 的那一次必须还回原处（重画把容器整个换掉也一样找回）。
   · **共享列表件**：`Wb.cards` 整箱重画（换一批条目、高度也变了）之后位置还在 ——
     工作台右栏 / 收藏 / 资产库的列表都走这一份，它是「点按钮重画列表」的实景。

   路由：#assets.html（公共件在场；这一条不碰导演台 —— 那一页正在重构） */
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

    /* ---------- 机制：公共件在场，裸重画丢位、套 keep 不还位就红 ---------- */
    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(() => !!document.querySelector('.assets-page'), 25000, 100);
    await page.waitFor(() => window.Wb && window.Wb.viewport && typeof window.Wb.viewport.keep === 'function', 20000, 100);

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
    await sleep(300);   /* scroll 事件在下一帧才派发，锚点按那一帧之后的位置量 */

    const bare = await page.eval(() => {
      const host = document.getElementById('probeScrollHost');
      host.innerHTML = host.innerHTML;          /* 不套公共件：新节点从 0 起 */
      const now = document.getElementById('probeScrollBox');
      return now ? Math.round(now.scrollTop) : -1;
    });
    must(bare === 0, '裸重画本该把滚动位甩回顶（这一条是对照，它不成立就说明探针量错了）：' + bare);

    const kept = await page.eval(() => {
      const host = document.getElementById('probeScrollHost');
      const box = document.getElementById('probeScrollBox');
      box.scrollTop = 200;
      window.Wb.viewport.keep(host, () => { host.innerHTML = host.innerHTML; });
      const now = document.getElementById('probeScrollBox');
      return now ? Math.round(now.scrollTop) : -1;
    });
    must(kept === 200, '整片重画把滚动位吃掉了：' + kept + '（公共件 Wb.viewport.keep 没还原）');

    await page.eval(() => { const host = document.getElementById('probeScrollHost'); if (host) host.remove(); });

    /* ---------- 共享列表件：整箱重画也走 keep ----------
       Wb.cards.paint 是全站「列表重画」的唯一一份（工作台右栏 / 收藏 / 资产库都经它），
       它自己调了 Wb.viewport.keep —— 这里用一个探针箱照同一份 API 走一遍：
       60 条 → 滚到中段 → 换一批（40 条换掉尾部 20 条、每条还从 40px 变成 44px）→ 位置必须还在。
       ⚠ 「还在」的量法是**锚点**（第一个可见的那一条仍停在原来的视口偏移上），不是 scrollTop 的像素值：
       锚点以上的内容变高了，scrollTop 本来就该跟着变大（仍按 600 复位的写法会让锚点往上漂 60px）——
       全站契约见 AGENTS §3.4.5 / `web/ui/workbench.js` 的 viewport.keep。
       浏览器自己的 scroll anchoring 也会动一次，keep 负责把残差按锚点抹平。 */
    const listOk = await page.eval(() => {
      const host = document.createElement('div');
      host.id = 'probeCardsHost';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:200px;overflow:hidden';
      const box = document.createElement('div');
      box.id = 'probeCardsBox';
      box.style.cssText = 'width:100%;height:200px;overflow-y:auto';
      host.appendChild(box);
      document.body.appendChild(host);
      const mk = (i, h) => ({ key: 'k' + i, h });
      const listA = []; for (let i = 0; i < 60; i++) listA.push(mk(i, 40));
      const api = window.Wb.cards.create({
        box: box, keyOf: it => it.key, sigOf: it => it.key + ':' + it.h,
        htmlOf: it => '<div style="height:' + it.h + 'px">' + it.key + '</div>',
      });
      /* 第一个可见的那一条：它的**视口偏移**才是「我原来在看哪儿」。 */
      const anchorOf = () => {
        const er = box.getBoundingClientRect();
        for (const k of box.children) {
          if (k.getBoundingClientRect().bottom > er.top + 1) {
            return { key: k.getAttribute('data-tkey'), off: Math.round(k.getBoundingClientRect().top - er.top) };
          }
        }
        return null;
      };
      api.paint(listA);
      box.scrollTop = 600;
      const before = { top: Math.round(box.scrollTop), anchor: anchorOf() };
      /* 顶部那几条高度变了 + 尾部换掉一批：锚点以上的高度动了，按像素还原会漂。 */
      const listB = listA.slice(0, 40).map(it => ({ key: it.key, h: 44 }))
        .concat([{ key: 'n1', h: 40 }, { key: 'n2', h: 40 }]);
      api.paint(listB);
      const after = { top: Math.round(box.scrollTop), anchor: anchorOf() };
      host.remove();
      return { before: before, after: after };
    });
    must(listOk.before.top > 400, '列表探针没滚下去（探针本身坏了）：' + JSON.stringify(listOk));
    must(listOk.after.top > 400, 'Wb.cards 整箱重画把列表甩回了顶上：' + JSON.stringify(listOk));
    must(listOk.after.anchor && listOk.after.anchor.key === listOk.before.anchor.key,
      '重画之后第一个可见的条目换了（锚点没找回来）：' + JSON.stringify(listOk));
    must(Math.abs(listOk.after.anchor.off - listOk.before.anchor.off) <= 2,
      'Wb.cards 整箱重画把锚点漂了：' + JSON.stringify(listOk) + '（paint 里没走 Wb.viewport.keep）');

    if (page.errors && page.errors.length) {
      console.error('页面异常：\n' + page.errors.slice(0, 5).join('\n'));
      throw new Error('页面上有异常');
    }
    console.log('✓ 滚动位：裸重画甩回顶（对照）· Wb.viewport.keep 还原（机制）· 共享列表件整箱重画不吃位');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
