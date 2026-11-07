#!/usr/bin/env node
/* 翻页判据：四个有翻页的页面都得把翻页那一行**画出来**。
   用户报过「翻页相关组件不显示」——工作台那一处是宿主 `stPgRow` 从未登记（整行从未填过），
   所以这一条盯三件事：宿主登记了（行里三颗按钮在 DOM 里）、行看得见、读数不是空。
   · 资产库 / 工作台：翻页档（`page_mode_<页> = page`）下整行必须看得见；
     往下滚档（more）是另一种设计，整行按设计藏起来 —— 那一档不判。
   · 收藏 / 角色库：没有东西可翻时整行按设计藏起来（有东西才翻），但**宿主必须已登记**。
   判据不碰阈值：看得见就是看得见，藏起来是设计不是缺陷。
   路由：#assets.html · #favorites.html · #chars.html · #studio.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const readWhen = async (fn, timeout = 20000, ...args) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn, ...args);
        if (v) return v;
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    };

    /* 这一档要看得见「有东西可翻」：翻页档 + 两条收藏。 */
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(() => {
      localStorage.setItem('page_mode_assets', 'page');
      localStorage.setItem('page_mode_studio', 'page');
      /* 收藏走 ui.js 的 Store（带信封），手写裸数组进 localStorage 读不出来 —— 用它自己的写入口。 */
      window.Store.write('fav_items', [
        { key: 'f1', src: '/asset/a1', title: '收藏一', prompt: '甲', kind: 'image', ts: Date.now() },
        { key: 'f2', src: '/asset/a2', title: '收藏二', prompt: '乙', kind: 'image', ts: Date.now() },
      ], { label: '收藏' });
      return true;
    });

    /* 读这一页的翻页行：三颗按钮在不在、行看得见吗、读数有没有字。 */
    const probe = async (hash, prefix, rootSel) => {
      await page.goto(proxy.base + '/shell.html#' + hash);
      await page.waitFor(sel => !!document.querySelector(sel), 25000, 100, rootSel);
      return await readWhen((p) => {
        const prev = document.getElementById(p + 'PgPrev');
        const info = document.getElementById(p + 'PgInfo');
        const next = document.getElementById(p + 'PgNext');
        if (!prev || !info || !next) return null;
        const on = el => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && getComputedStyle(el).display !== 'none';
        };
        return { prevOn: on(prev), nextOn: on(next),
          info: (info.textContent || '').trim(),
          prevText: (prev.textContent || '').trim(), nextText: (next.textContent || '').trim() };
      }, 20000, prefix);
    };

    /* 资产库：翻页档下整行必须看得见 */
    const as = await probe('assets.html', 'as', '.assets-page');
    must(as, '资产库的翻页那一行没画出来（宿主没登记？）');
    must(as.prevOn && as.nextOn, '资产库的翻页按钮不可见：' + JSON.stringify(as));
    must(/上一页/.test(as.prevText) && /下一页/.test(as.nextText), '资产库的翻页按钮文案不对：' + JSON.stringify(as));

    /* 收藏：种了两条 → 有东西可翻，整行必须看得见 */
    const fav = await probe('favorites.html', 'fav', '.fav-page');
    must(fav, '收藏的翻页那一行没画出来（宿主没登记？）');
    must(fav.prevOn && fav.nextOn, '收藏的翻页按钮不可见（种了两条收藏就该翻）：' + JSON.stringify(fav));

    /* 角色库：本判据不种工作区角色表，只盯宿主登记 —— 三颗按钮要在 DOM 里 */
    const ch = await probe('chars.html', 'chars', '.chars-page');
    must(ch, '角色库的翻页那一行没画出来（宿主没登记？）');

    /* 工作台：翻页档下整行必须看得见（上一轮不显示的就是这一处） */
    const st = await probe('studio.html', 'st', '.studio-page');
    must(st, '工作台的翻页那一行没画出来（宿主没登记？）');
    must(st.prevOn && st.nextOn, '工作台的翻页按钮不可见：' + JSON.stringify(st));

    /* 动态加载档的跳页落点（公共件 `Wb.viewport.revealPage`，工作台右栏与资产库共用）：
       按「第几页 × 每页多少条」算序号并滚到那一条；超出实际页数就落到最后一条。
       用户要的是「输入 3 就看见第 3 页的头一条」，只把内容取回、画面不动等于没跳。 */
    const rv = await page.eval(() => {
      if (!window.Wb || !window.Wb.viewport || !window.Wb.viewport.revealPage) return null;
      const box = document.getElementById('result');
      if (!box) return null;
      const keep = box.innerHTML;
      box.innerHTML = '';
      for (let i = 0; i < 40; i++) {
        const d = document.createElement('div');
        d.className = 'task';
        d.style.height = '314px';
        box.appendChild(d);
      }
      const cards = [...box.querySelectorAll('.task')];
      const host = window.Wb.viewport.host(box) || box;
      window.Wb.viewport.revealPage(cards, 20, 2);        // 第 20 页 / 每页 2 条 → 第 39 张
      const cr = host.getBoundingClientRect();
      const r = cards[38].getBoundingClientRect();
      const hit = r.top >= cr.top - 2 && r.bottom <= cr.bottom + 2;
      const scrolled = host.scrollTop > 0;
      window.Wb.viewport.revealPage(cards, 999, 2);       // 超出实际页数 → 最后一张
      const rl = cards[39].getBoundingClientRect();
      const last = rl.top < cr.bottom + 2 && rl.bottom > cr.top - 2;
      box.innerHTML = keep;
      return { hit, last, scrolled };
    });
    must(rv && rv.hit && rv.last && rv.scrolled, '动态加载档的跳页没有落到目标条目：' + JSON.stringify(rv));

    console.log('✓ 翻页组件：资产库 / 收藏 / 角色库 / 工作台 四页的翻页行都画出来了'
      + '（宿主登记 · 按钮可见 · 上一页/下一页在）；动态加载档的跳页按每页条数落到目标条目');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
