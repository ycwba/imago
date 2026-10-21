#!/usr/bin/env node
/* 导演台性能预算：512 个切片磁贴的一轮排版 p95 < 50ms；段表/框表纯函数不超预算。
   量的是真实 DOM 插入与布局，不是“文件里有没有 paintTiles”。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => document.body && document.body.innerText.length > 20, 15000);
    const out = await page.eval(async () => {
      const slice = await import('/web/director/slice.js');
      const seg = await import('/web/director/segments.js');
      const tl = await import('/web/director/timeline.js');
      const box = document.createElement('div');
      box.className = 'tl-inner';
      box.style.cssText = 'position:relative;width:1200px;height:60px;overflow:hidden';
      document.body.appendChild(box);
      const html = slice.sliceBoxHTML('/getv?url=x', 0, 60, 1200, 0);
      const one = html.repeat(512);
      const times = [];
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        box.innerHTML = one;
        void box.offsetHeight;
        times.push(performance.now() - t0);
      }
      box.remove();
      const p95 = times.slice().sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
      const segs = Array.from({ length: 512 }, (_, i) => ({ a: i, b: i + 1, in: i + 0.1, out: i + 0.9 }));
      const T = tl.createTimeline({ allShots: () => [], tlCandidateOf: () => null, candDur: () => 512 });
      let t0 = performance.now();
      for (let i = 0; i < 20; i++) T.shotFrames(segs);
      const shotMs = (performance.now() - t0) / 20;
      t0 = performance.now();
      for (let i = 0; i < 20; i++) seg.segsOf({ segs }, 512);
      const segMs = (performance.now() - t0) / 20;
      return { p95, max: Math.max(...times), shotMs, segMs, n: box.childElementCount };
    });
    if (!(out.p95 < 50)) throw new Error('512 磁贴排版 p95 ' + out.p95.toFixed(1) + 'ms，超过 50ms');
    if (!(out.max < 100)) throw new Error('512 磁贴排版最大 ' + out.max.toFixed(1) + 'ms，出现 >100ms 长任务');
    if (!(out.shotMs < 10)) throw new Error('shotFrames×512 平均 ' + out.shotMs.toFixed(2) + 'ms，超过 10ms');
    if (!(out.segMs < 10)) throw new Error('segsOf×512 平均 ' + out.segMs.toFixed(2) + 'ms，超过 10ms');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 导演台性能通过（512 磁贴 p95 ' + out.p95.toFixed(1) + 'ms / max ' + out.max.toFixed(1) +
      'ms；shotFrames ' + out.shotMs.toFixed(2) + 'ms；segsOf ' + out.segMs.toFixed(2) + 'ms）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
