#!/usr/bin/env node
/* 资产库的筛选 / 翻页链判据。用户在这一页上会连着做四件事，每一件以前都断在一个不同的地方：

     ① **平台下拉选了没反应**：模板里那颗 select 没有任何 change 监听，renderFilters 只负责
        重建 options，没有一处把用户的选择写回 F.provider —— applyFilters 读的正是它。
     ② **改完条件还停在第 5 页**：所有「条件变了」的入口都只重画，不把页码收回第 1 页，
        常见结果是一屏空白（筛选后的条数根本不够第 5 页）。
     ③ **搜完每档条数不刷新**：onSearch 只 renderGrid；每档条数、平台 options、页头状态计数
        都在 renderFilters 里算，于是搜完「全部 / 视频 / 图片」还停在旧数字。
     ④ **真翻页后停在页底**：翻页只换列表，不把列表顶滚回页头下缘 —— 人在第 2 页看到的是
        页面中段，还以为翻页没生效。

   这一条把四件事串成一次真实操作（种 30 条缓存：甲 25 条图片 / 乙 5 条视频，分页档一页 24）：
     · 平台下拉含 全部 / 甲 / 乙；选「乙」→ 5 张卡、第 1 页
     · 翻到第 2 页（6 张卡）后点「图片」→ 回第 1 页、24 张卡
     · 搜索「乙视频」→ 类型计数 全部 5 / 视频 5 / 图片 0（证明 onSearch 重画了筛选）
     · 多选 + 滚动：.bulkbar 顶端 = .phead 底端（±1），不压在标题上
     · 翻页后网格顶端回到页头下缘（±2，证明 Wb.pageHead.scrollToList 生效）

   路由：#assets.html */
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
    /* 上游指到没人听的端口（同 asset-requests）：本机 .env 里的真实平台密钥不许被这条判据带出门，
       更不许它们在第 2 页又拉回一批卡片 —— 这一条数的是筛选与翻页，不是平台通不通。
       PROXY_OFF 显式给 '0'：环境变量比 .env 优先，不然 .env 里的 PROXY_OFF=1 会把这条代理路挡掉。 */
    proxy = await h.startProxy({ env: {
      HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', PROXY_OFF: '0',
    } });
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);

    /* 种 30 条资产（甲 25 条图片 / 乙 5 条视频），并把这页钉成「分页档 · 一页 24」：
       第 1 页 24 张、第 2 页 6 张，正好一次看清「翻页 / 换档回第 1 页」。
       关掉自动存本机：这些都是 data: 地址，不往代理下发镜像请求。 */
    await page.eval(px => {
      const ts = Date.now();
      const out = [];
      for (let i = 0; i < 25; i++) {
        out.push({ provider: 'jia', providerName: '甲', kind: 'asset', assetId: 'jia-' + i,
          type: '图片', prompt: '甲图片' + i, name: '甲图片' + i, src: px, ts: ts - i * 1000 });
      }
      for (let i = 0; i < 5; i++) {
        out.push({ provider: 'yi', providerName: '乙', kind: 'asset', assetId: 'yi-' + i,
          type: '视频', prompt: '乙视频' + i, name: '乙视频' + i, src: px, ts: ts - (100 + i) * 1000 });
      }
      try { localStorage.setItem('sk_media_local', 'off'); } catch (e) {}
      try { localStorage.setItem('page_mode_assets', 'page'); } catch (e) {}
      try { localStorage.setItem('page_size_assets', '24'); } catch (e) {}
      try { localStorage.setItem('assets_cache_v1', JSON.stringify({ ts: Date.now(), entries: out })); } catch (e) {}
    }, PIX);

    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(() => !!document.querySelector('.assets-page'), 30000, 100);

    const cards = () => page.eval(() => document.querySelectorAll('.assets-page .grid .task').length);
    const pagerInfo = () => page.eval(() => (document.getElementById('asPgInfo') || {}).textContent || '');
    const kindCounts = () => page.eval(() => {
      const box = document.querySelector('[data-kind-filter]');
      const out = {};
      if (!box) return out;
      box.querySelectorAll('button[data-k]').forEach(b => {
        const chip = b.querySelector('.seg-n');
        out[b.dataset.k] = chip ? (chip.textContent || '').trim() : '';
      });
      return out;
    });
    const waitCards = async (want, ms = 20000) => {
      const until = Date.now() + ms;
      let got = -1;
      while (Date.now() < until) {
        got = await cards();
        if (got === want) return got;
        await sleep(150);
      }
      throw new Error('等 ' + want + ' 张卡超时（实测 ' + got + ' 张）');
    };
    const selectProvider = async name => {
      await page.eval(v => {
        const s = document.querySelector('.assets-page select[aria-label="按平台筛选"]');
        if (!s) return;
        s.value = v;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, name);
    };
    const clickKind = async k => {
      await page.eval(v => {
        const b = document.querySelector('[data-kind-filter] button[data-k="' + v + '"]');
        if (b) b.click();
      }, k);
    };
    const search = async q => {
      await page.eval(v => {
        const i = document.querySelector('.assets-page #search');
        if (!i) return;
        i.value = v;
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }, q);
    };

    /* ── ① 平台下拉有真选项，选了就筛 ─────────────────────────────── */
    await waitCards(24);
    const provOpts = await page.eval(() => {
      const s = document.querySelector('.assets-page select[aria-label="按平台筛选"]');
      return s ? [...s.options].map(o => o.value) : [];
    });
    must(['全部', '甲', '乙'].every(v => provOpts.includes(v)),
      '平台下拉该有 全部 / 甲 / 乙：' + JSON.stringify(provOpts));

    await selectProvider('乙');
    await waitCards(5);
    must(/第 1 页/.test(await pagerInfo()), '按平台筛到「乙」之后该在第 1 页：' + await pagerInfo());

    await selectProvider('全部');
    await waitCards(24);

    /* ── ② 真翻页：第 2 页 6 张，列表顶回到页头下缘 ───────────────── */
    await page.eval(() => { const r = document.querySelector('.assets-page'); if (r) r.scrollTop = 700; });
    await sleep(200);
    const scrolled = await page.eval(() => Math.round(document.querySelector('.assets-page').scrollTop));
    must(scrolled > 0, '先把这一页滚下去（实测 scrollTop=' + scrolled + '）');

    await page.eval(() => { const b = document.getElementById('asPgNext'); if (b) b.click(); });
    await waitCards(6);
    await sleep(300);
    must(/第 2 页/.test(await pagerInfo()), '点「下一页」该到第 2 页：' + await pagerInfo());
    const afterPage = await page.eval(() => {
      const r = document.querySelector('.assets-page');
      const head = r.querySelector(':scope > .phead');
      const grid = r.querySelector('#grid');
      return {
        gridTop: Math.round(grid.getBoundingClientRect().top),
        headBottom: Math.round(head.getBoundingClientRect().bottom),
        scrollTop: Math.round(r.scrollTop),
      };
    });
    must(Math.abs(afterPage.gridTop - afterPage.headBottom) <= 2,
      '翻页后列表顶该落在页头下缘（±2）：' + JSON.stringify(afterPage));

    /* ── ③ 换类型档 → 回第 1 页 ───────────────────────────────────── */
    await clickKind('图片');
    await waitCards(24);
    must(/第 1 页/.test(await pagerInfo()), '换到「图片」之后该回第 1 页：' + await pagerInfo());
    await clickKind('全部');
    await waitCards(24);

    /* ── ④ 搜索之后每档条数要跟着刷新 ─────────────────────────────── */
    await search('乙视频');
    await waitCards(5);
    const kc = await kindCounts();
    must(Number(kc['全部']) === 5, '搜索「乙视频」后「全部」该是 5：' + JSON.stringify(kc));
    must(Number(kc['视频']) === 5, '搜索「乙视频」后「视频」该是 5：' + JSON.stringify(kc));
    must(Number(kc['图片']) === 0, '搜索「乙视频」后「图片」该是 0：' + JSON.stringify(kc));

    /* 清空搜索框 = 取消筛选（不用回车） */
    await page.eval(() => {
      const i = document.querySelector('.assets-page #search');
      if (!i) return;
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitCards(24);

    /* ── ⑤ 多选条粘顶时贴着页头下缘，不压住标题 ───────────────────── */
    await page.eval(() => { const b = document.getElementById('multiBtn'); if (b) b.click(); });
    await page.waitFor(() => {
      const b = document.getElementById('bulkBar');
      return !!b && b.offsetParent !== null;
    }, 10000, 100);
    await page.eval(() => { const r = document.querySelector('.assets-page'); if (r) r.scrollTop = 600; });
    await sleep(300);
    const stick = await page.eval(() => {
      const r = document.querySelector('.assets-page');
      const head = r.querySelector(':scope > .phead');
      const bar = document.getElementById('bulkBar');
      return {
        scrollTop: Math.round(r.scrollTop),
        barTop: Math.round(bar.getBoundingClientRect().top),
        headBottom: Math.round(head.getBoundingClientRect().bottom),
        pheadVar: getComputedStyle(r).getPropertyValue('--phead-h').trim(),
      };
    });
    must(stick.scrollTop > 0, '多选之后这一页该是滚下去的：' + JSON.stringify(stick));
    must(stick.pheadVar && stick.pheadVar !== '0px',
      '页头高度该写进 --phead-h（多选条的粘顶位读它）：' + JSON.stringify(stick));
    must(Math.abs(stick.barTop - stick.headBottom) <= 1,
      '多选条粘顶时该贴着页头下缘（不许压在标题上）：' + JSON.stringify(stick));

    const errs = h.logFaults(proxy.log);
    if (errs.length) throw new Error('代理日志有异常：\n  ' + errs.join('\n  '));
    console.log('✓ 资产库筛选 / 翻页链：平台下拉生效 · 改条件回第 1 页 · 搜索重画每档条数 · 翻页滚回列表顶 · 多选条不压页头');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
