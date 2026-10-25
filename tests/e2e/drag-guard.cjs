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

    /* ---------- 2) 从窗口外拖进来的文件**要**被收藏页收下（2026-10-25 产品口径）----------
       「上传本地文件」这一支**在**（入口、拖拽导入、Fav.addLocalFile 都在）：
       用户手里的本机素材要能直接进收藏，就得有个地方把它丢进来 ——
       工具行那颗「上传本地文件」按钮与「拖文件进窗口」是同一个 addFiles。
       （去掉的只是「文件」那一颗筛选芯片，不是这个入口。） */
    const dropped = await page.eval(async png => {
      const bin = atob(png);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'outside.png', { type: 'image/png' }));
      /* 先 dragover：上传遮罩（body.drop）要亮起来 */
      document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 200, clientY: 200 }));
      const lit = document.body.classList.contains('drop');
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 200, clientY: 200 }));
      return { lit, stillLit: document.body.classList.contains('drop') };
    }, PNG);
    must(dropped.lit === true, '外部文件拖进来没有亮起上传遮罩：' + JSON.stringify(dropped));
    must(dropped.stillLit === false, '放下之后上传遮罩没撤：' + JSON.stringify(dropped));
    /* 本体进 IndexedDB，异步落盘：等它真的进收藏 */
    await page.waitFor(() => Fav.list().length === 2, 10000).catch(() => {});
    const after = await page.eval(() => ({
      n: Fav.list().length,
      local: Fav.list().filter(x => x.kind === 'local').map(x => x.name),
    }));
    must(after.n === 2, '外部文件拖进来没有进收藏：' + JSON.stringify(after));
    must(after.local.length === 1 && /outside\.png/.test(after.local[0]),
      '进收藏的不是那个本地上传的文件：' + JSON.stringify(after));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 拖拽判据通过（收藏页拖卡片不多收藏 · 遮罩不亮 · 外部文件拖进来进收藏 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
