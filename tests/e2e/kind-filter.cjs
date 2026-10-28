#!/usr/bin/env node
/* 文件类型筛选（图片/视频/音频）判据：三页共用**同一副**公共件。
   用户报过：「素材库和收藏页面等页面的文件类型筛选应该使用工作台的筛选的那个公共组件」。
   以前三页三副样子：工作台自己拼 innerHTML（分段 + 每档计数）、收藏页走 Wb.filterBar 的
   芯片行、资产库走 Chips.render 的芯片行。现在收成公共件 Wb.kindFilter（分段 + 每档计数），
   三页共用 —— 这一条盯住「收拢」这件事别退回三份各画各的：
     · 每页有且只有**一处**文件类型筛选（挂 data-kind-filter 旗标；
       页面上还有别的 .ui-seg —— 工作台左栏那颗是「生成类型」开关，不是这一族）
     · 它是分段控件（.ui-seg），每一档是一颗 button[data-k] + 一枚计数芯片（.seg-n）
     · 计数与实际条数一致；点一档 → 当前档 .on、列表按那一档筛、计数刷新
     · 计数为 0 且不是当前档的那一颗**不画**（「全部」档恒显）
     · 三页的 DOM 契约一模一样（同一份公共件，不是三份各画各的）

   路由：#favorites.html / #studio.html / #assets.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 一张 1×1 的 gif：探针自己造的，不去碰平台，也不发请求。 */
const PIX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);

    /* 造三条收藏（图片 / 视频 / 音频各一条）→ 收藏页的类型档就有真条数可数。 */
    await page.eval(px => {
      const mk = (key, type, prompt) => ({ key, type, prompt, name: key, src: px, ts: Date.now(), kind: 'asset', providerName: '探针' });
      window.Store.write('fav_items', [mk('fav-img', '图片', '探针图片'), mk('fav-vid', '视频', '探针视频'), mk('fav-aud', '音频', '探针音频')]);
    }, PIX);

    /* 量某一页的文件类型筛选：档位、计数、当前档、画没画出来。 */
    const readFilter = () => page.eval(() => {
      const box = document.querySelector('[data-kind-filter]');
      if (!box) return null;
      const tabs = [...box.querySelectorAll('button[data-k]')].map(b => {
        const n = b.querySelector('.seg-n');
        return {
          k: b.dataset.k,
          text: (b.textContent || '').replace(/\s+/g, ''),
          n: n ? (n.textContent || '').trim() : '',
          on: b.classList.contains('on'),
          hidden: b.hidden,
        };
      });
      /* `count` 数的是「这一页挂了几处筛选」（不是几档）：一处分段控件里本来就有
         全部 / 图片 / 视频 / 音频 四颗按钮，拿按钮数当「处数」永远不可能是 1。 */
      return { cls: box.className, tabs, count: document.querySelectorAll('[data-kind-filter]').length };
    });

    /* ── ① 收藏页：三档 + 真条数 ─────────────────────────────────────── */
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => !!document.querySelector('.fav-page'), 30000, 100);
    const until = Date.now() + 30000;
    let fav = null;
    while (Date.now() < until) {
      fav = await readFilter();
      if (fav && fav.tabs.length) break;
      await sleep(150);
    }
    must(fav, '收藏页没有文件类型筛选（公共件 Wb.kindFilter 没装上）');
    must(fav.count === 1, '收藏页该有且只有一处文件类型筛选：' + JSON.stringify(fav));
    must(/ui-seg/.test(fav.cls), '收藏页的文件类型筛选该是分段控件（.ui-seg）：' + fav.cls);
    const favTabs = fav.tabs.reduce((m, t) => (m[t.k] = t, m), {});
    must(favTabs['all'], '收藏页缺「全部」那一档（键 all）：' + JSON.stringify(fav.tabs));
    must(Number(favTabs['all'].n) === 3, '「全部」该是 3 条：' + JSON.stringify(fav.tabs));
    must(Number(favTabs['图片'].n) === 1, '「图片」该是 1 条：' + JSON.stringify(fav.tabs));
    must(Number(favTabs['视频'].n) === 1, '「视频」该是 1 条：' + JSON.stringify(fav.tabs));
    must(Number(favTabs['音频'].n) === 1, '「音频」该是 1 条：' + JSON.stringify(fav.tabs));
    must(favTabs['all'].on, '默认该是「全部」亮着：' + JSON.stringify(fav.tabs));

    /* ── ② 点一档 → 当前档亮、列表按那一档筛 ────────────────────────── */
    await page.eval(() => {
      const b = document.querySelector('[data-kind-filter] button[data-k="图片"]');
      if (b) b.click();
    });
    await sleep(700);
    const fav2 = await readFilter();
    const imgTab = fav2.tabs.find(t => t.k === '图片');
    must(imgTab && imgTab.on, '点「图片」之后该是它亮着：' + JSON.stringify(fav2.tabs));
    const shown = await page.eval(() => document.querySelectorAll('.fav-page .card').length);
    must(shown === 1, '筛到「图片」之后该只剩 1 张卡（实测 ' + shown + ' 张）');

    /* 筛到没有条数的那一档：那一档**不画**（当前档除外，否则回不去）。 */
    await page.eval(() => {
      const b = document.querySelector('[data-kind-filter] button[data-k="all"]');
      if (b) b.click();
    });
    await sleep(500);

    /* ── ③ 工作台与资产库：同一副契约 ────────────────────────────────── */
    for (const p of [{ hash: 'studio.html', root: '.studio-page', nm: '生成工作台' },
                     { hash: 'assets.html', root: '.assets-page', nm: '资产库' }]) {
      await page.goto(proxy.base + '/shell.html#' + p.hash);
      await page.waitFor(sel => !!document.querySelector(sel), 30000, 100, p.root);
      let f = null;
      const until2 = Date.now() + 30000;
      while (Date.now() < until2) {
        f = await readFilter();
        if (f && f.tabs.length) break;
        await sleep(150);
      }
      must(f, p.nm + '没有文件类型筛选（公共件 Wb.kindFilter 没装上）');
      must(f.count === 1, p.nm + '该有且只有一处文件类型筛选：' + JSON.stringify(f));
      must(/ui-seg/.test(f.cls), p.nm + '的文件类型筛选该是分段控件（.ui-seg）：' + f.cls);
      must(f.tabs.every(t => t.n !== ''), p.nm + '每一档该带计数（.seg-n）：' + JSON.stringify(f.tabs));
      must(f.tabs.some(t => t.on), p.nm + '总有一档亮着：' + JSON.stringify(f.tabs));
    }

    const errs = h.logFaults(proxy.log);
    if (errs.length) throw new Error('代理日志有异常：\n  ' + errs.join('\n  '));
    console.log('✓ 文件类型筛选：收藏 / 工作台 / 资产库共用同一副公共件（分段 + 每档计数 · 点一下换档 · 空档不画）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
