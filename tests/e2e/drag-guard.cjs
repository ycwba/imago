#!/usr/bin/env node
/* 拖拽判据：页面里拖一张卡片（浏览器会顺手往 dataTransfer 里塞一份文件）不算上传。
   收藏页拖一下卡片会多出一条收藏，就是这条判据漏了。
   同时验一个正控：从窗口外拖进来的文件仍然会被收藏页收下。 */
'use strict';
const h = require('./harness.cjs');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let n = 0;
function must(cond, msg) { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor('!!window.Fav && !!document.querySelector(".fav-page")', 25000);
    await page.waitFor(() => !!document.querySelector('.fav-page') && !/正在读取收藏/.test(document.querySelector('.fav-page').innerText), 20000);

    /* 先在收藏里放一条，页面上才有「卡片」可拖。 */
    const seeded = await page.eval(() => {
      const it = { key: 'a:probe:1', kind: 'asset', provider: 'probe', providerName: '探针', assetId: '1',
        type: 'image', prompt: '拖拽探针', src: '', dl: '', ts: Date.now() };
      Fav.add(it);
      return Fav.list().length;
    });
    must(seeded === 1, '没种上一条收藏：' + seeded);
    await page.waitFor('!!document.querySelector(".card[data-key=\\"a:probe:1\\"]")', 12000);

    /* ---------- 1) 页面里拖卡片：带 text/html + uri-list + Files，不算外部文件 ---------- */
    const drag = await page.eval(async png => {
      const bin = atob(png);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const mk = (external) => {
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'probe.png', { type: 'image/png' }));
        if (!external) {
          dt.setData('text/html', '<img src="probe.png">');
          dt.setData('text/uri-list', location.origin + '/probe.png');
        }
        return dt;
      };
      const internal = mk(false), external = mk(true);
      const card = document.querySelector('.card[data-key="a:probe:1"]');
      /* dragover 先来一遍：不能亮起「松手上传」的整页遮罩。 */
      card.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: internal }));
      const overLit = document.body.classList.contains('drop');
      card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: internal, clientX: 120, clientY: 160 }));
      await new Promise(r => setTimeout(r, 300));
      return {
        overLit,
        internal: window.isExternalFileDrag({ dataTransfer: internal }),
        external: window.isExternalFileDrag({ dataTransfer: external }),
        count: Fav.list().length,
        stillLit: document.body.classList.contains('drop'),
        dtTypes: [...internal.types],
      };
    }, PNG);
    must(drag.internal === false, '页面内拖拽被判成了外部文件：' + JSON.stringify(drag));
    must(drag.external === true, '外部文件拖拽被判成了页面内：' + JSON.stringify(drag));
    must(drag.overLit === false && drag.stillLit === false, '页面内拖拽亮起了上传遮罩：' + JSON.stringify(drag));
    must(drag.count === 1, '拖一下收藏卡片多出了一条收藏：' + JSON.stringify(drag));

    /* ---------- 2) 正控：真正从窗口外拖进来的文件仍然收下 ---------- */
    await page.eval(png => {
      const bin = atob(png);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'outside.png', { type: 'image/png' }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 200, clientY: 200 }));
    }, PNG);
    await page.waitFor('window.Fav.list().length >= 2', 15000);
    const after = await page.eval(() => ({ n: Fav.list().length, names: Fav.list().map(x => x.name || x.key) }));
    must(after.n === 2, '外部文件没被收下：' + JSON.stringify(after));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 拖拽判据通过（收藏页拖卡片不多收藏 · 遮罩不亮 · 外部文件仍能收下 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
