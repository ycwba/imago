#!/usr/bin/env node
/* 收藏翻页后缩略图必须跟着换到那一页。
   缺陷现场：`Wb.pager` 的 render 回调只推了 `pagerTick`，而缩略图地址只按
   「上一次渲染时的当前页」取；翻到第 2 页，卡片换了、`urls` 还是第 1 页的键，
   于是第 2 页每一格 `.thumb` 都是空的（图片区一片白）。
   判据：种 30 条收藏（24 条一页），点「下一页」后第 2 页的每一格都要有 img/video。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

const SEED_N = 30;

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    /* 收藏是 localStorage 信封（Store.read 只认 {data,ts}）：要在页面脚本之前种进去，
       否则等页面跑起来再写，列表已经画完第一遍了。 */
    await page.addInitScript(() => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const now = Date.now();
      const items = [];
      for (let i = 0; i < 30; i++) {
        items.push({
          key: 'a:probe:' + i, kind: 'asset', provider: 'probe', providerName: '翻页探针',
          assetId: 'la_probe_' + i, type: '图片', prompt: '收藏第 ' + i + ' 条',
          src: png, ts: now - i * 1000,
        });
      }
      localStorage.setItem('fav_items', JSON.stringify({ data: items, ts: now }));
    });
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => {
      const info = document.getElementById('favPgInfo');
      return document.querySelectorAll('.fav-page .card[data-key]').length === 24
        && info && /^第 1 页/.test(info.textContent || '');
    }, 30000);

    const page1 = await page.eval(() => {
      const cards = [...document.querySelectorAll('.fav-page .card[data-key]')];
      return {
        keys: cards.map(c => c.dataset.key),
        thumbs: cards.filter(c => c.querySelector('.thumb img, .thumb video')).length,
        total: cards.length,
        info: (document.getElementById('favPgInfo') || {}).textContent || '',
        nextDisabled: !!(document.getElementById('favPgNext') || {}).disabled,
      };
    });
    must(page1.total === 24, '第 1 页应显示 24 条：' + page1.total);
    must(page1.thumbs === page1.total, '第 1 页有 ' + (page1.total - page1.thumbs) + ' 格缩略图是空的');
    must(/共 2 页/.test(page1.info), '第 1 页的分页文案不对：' + page1.info);
    must(!page1.nextDisabled, '第 1 页的「下一页」不该禁用');

    await page.eval(() => document.getElementById('favPgNext').click());
    await page.waitFor(() => {
      const info = document.getElementById('favPgInfo');
      return document.querySelectorAll('.fav-page .card[data-key]').length === 6
        && info && /^第 2 页/.test(info.textContent || '');
    }, 20000);

    const page2 = await page.eval(() => {
      const cards = [...document.querySelectorAll('.fav-page .card[data-key]')];
      return {
        keys: cards.map(c => c.dataset.key),
        thumbs: cards.filter(c => c.querySelector('.thumb img, .thumb video')).length,
        total: cards.length,
        info: (document.getElementById('favPgInfo') || {}).textContent || '',
        prevDisabled: !!(document.getElementById('favPgPrev') || {}).disabled,
      };
    });
    must(page2.total === 6, '第 2 页应显示 6 条：' + page2.total);
    must(page2.thumbs === page2.total, '翻页后第 2 页有 ' + (page2.total - page2.thumbs) + ' 格缩略图是空的（urls 还停在第 1 页）');
    must(/第 2 页/.test(page2.info), '第 2 页的分页文案不对：' + page2.info);
    must(!page2.prevDisabled, '第 2 页的「上一页」不该禁用');

    const overlap = page2.keys.filter(k => page1.keys.includes(k));
    must(overlap.length === 0, '两页出现了重复条目：' + overlap.slice(0, 3).join(', '));
    must(page2.keys.every(k => k), '第 2 页有卡片缺少 data-key');

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 收藏翻页：第 2 页 6 条各自带缩略图，两页不重复（' + SEED_N + ' 条种入，24 条一页）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
