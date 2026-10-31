#!/usr/bin/env node
/* 页头判据：各页面共用那**一条** .phead（全站唯一一份，公共层 ui.css）。
   用户报过「每页的顶栏长得都不一样」——素材库把标题藏在左轨、工作台缩在左栏、
   设置页的标题随文档滚走、导演台自己一套深底 header。
   这一条盯住统一后的形状，防止下一轮又长出第八种页头：
     · 每页都有 .phead（公共件那一份，不是各页自己画一条）
     · 标题在 .phead-h1 里且文本非空（页面名只说一次）
     · **标题左边没有图标铭牌**（2026-10-27 撤掉那枚 26px 强调色方块：
       七页各挂一枚 → 切页时标题旁边多一格、强调色也多一个落点）
     · **标题的左缘 = 本页内容列的左缘**（内容列离内容区左缘一律 32px：
       以前是五套：32 / 24 / 20 / 居中块+22 / 32-above-0 → 切页时标题左右跳）
     · 页头横带是 flex 容器（四个槽并排），高度够一条横带
   路由：素材库 / 工作台 / 收藏 / 资产库 / 用量 / 设置（导演台正在重构，暂不在这一条里） */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* `col`：那一页**内容列**（标题该与它同起点）。挑的是内容区里最靠左的那一块：
   素材库是左轨、工作台是左栏、设置页是目录轨，其余是工具条那一行。
   ⚠ 导演台**不在这一条里**：那一页正在重构，它的页头另算 —— 等重构落地再把它接回来
   （接回来时补一行 `{ hash: 'director.html', root: '.director-page', nm: '导演台', col: '.col-left' }`）。 */
const PAGES = [
  { hash: 'chars.html', root: '.chars-page', nm: '素材库', col: '.mat-rail' },
  { hash: 'studio.html', root: '.studio-page', nm: '工作台', col: '.col-left' },
  { hash: 'favorites.html', root: '.fav-page', nm: '我的收藏', col: '.toolbar' },
  { hash: 'assets.html', root: '.assets-page', nm: '资产库', col: '.as-tools' },
  { hash: 'usage.html', root: '.usage-page', nm: '用量与余额', col: '.ub-layout' },
  { hash: 'settings.html', root: '.settings-page', nm: '设置', col: '.set-rail' },
];

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);

    /* 取值用 page.eval 轮询（waitFor 只等条件、不返值）。 */
    const readWhen = async (fn, timeout = 30000, ...args) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn, ...args);
        if (v) return v;
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    };

    for (const p of PAGES) {
      await page.goto(proxy.base + '/shell.html#' + p.hash);
      await page.waitFor(sel => !!document.querySelector(sel), 30000, 100, p.root);
      /* 等那条横带真的画出来（导演台要等 engine 装好，页面比别页慢）。 */
      const head = await readWhen((rootSel, colSel) => {
        const root = document.querySelector(rootSel);
        if (!root) return null;
        const el = root.querySelector('.phead');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r.height) return null;
        const h1 = el.querySelector('.phead-h1');
        const hr = h1 ? h1.getBoundingClientRect() : null;
        const colEl = colSel ? root.querySelector(colSel) : null;
        const cr = colEl ? colEl.getBoundingClientRect() : null;
        return {
          title: h1 ? (h1.textContent || '').trim() : '',
          display: getComputedStyle(el).display,
          h: Math.round(r.height),
          hasIcon: !!el.querySelector('.phead-ic'),
          titleLeft: hr ? Math.round(hr.left) : -1,
          colLeft: cr ? Math.round(cr.left) : -1,
          hasId: !!el.querySelector('.phead-id'),
          hasActs: !!el.querySelector('.phead-acts'),
          hasSub: !!el.querySelector('.phead-sub'),
        };
      }, 30000, p.root, p.col);

      must(head, p.nm + '：页头 .phead 没画出来');
      must(head.title === p.nm, p.nm + '：页头标题是「' + head.title + '」，不是「' + p.nm + '」');
      must(head.display === 'flex', p.nm + '：页头不是 flex 容器（四个槽并排）：' + head.display);
      must(head.h >= 30, p.nm + '：页头高度只有 ' + head.h + 'px，像是被压扁了');
      must(!head.hasIcon, p.nm + '：页头里还有图标铭牌 .phead-ic（2026-10-27 起标题不带图标）');
      must(head.hasId, p.nm + '：页头没有 .phead-id（身份槽：标题）');
      /* 说明槽与动作槽按页留空，但**槽本身要在**（位置不挪；没有说明的页面也留一个空的）。 */
      must(head.hasSub, p.nm + '：页头没有 .phead-sub（说明槽的位置不能挪走）');
      must(head.hasActs, p.nm + '：页头没有 .phead-acts（动作槽的位置不能挪走）');
      must(head.colLeft >= 0, p.nm + '：找不到内容列（' + p.col + '），没法比标题的起点');
      must(Math.abs(head.titleLeft - head.colLeft) <= 1,
        p.nm + '：标题左缘 ' + head.titleLeft + ' 与内容列左缘 ' + head.colLeft
        + ' 不齐（切页时标题会左右跳）');
    }

    console.log('✓ 页头组件：六个页面共用一条 .phead（标题对 · 不带图标 · 标题与内容列同起点 · 四个槽都在）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
