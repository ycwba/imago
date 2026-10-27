#!/usr/bin/env node
/* 导演台性能预算（新剪辑核）：512 格胶片条的排版 p95 < 50ms；成片模型的派生表、每帧要问一次的
   转场窗、显示层帧计划都不超预算。量的是真实 DOM 插入与布局 + 真模块的真函数，
   不是「文件里有没有某个函数名」。 */
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
      const film = await import('/web/director/film.js');
      const strip = await import('/web/director/tl-filmstrip.js');
      /* 一条 512 格的胶片条：`.tl-strip` + 定宽磁贴 `i.tl-fr`（与 engine/strip.js 同一副形状）。
         插进文档再量高度，量的才是「真实布局」，不是内存里的 element 数。 */
      const box = document.createElement('div');
      box.className = 'tl-strip';
      box.style.cssText = 'position:absolute;left:0;top:0;display:flex;width:1200px;height:60px;overflow:hidden';
      document.body.appendChild(box);
      const one = '<i class="tl-fr" style="flex:0 0 84px;height:100%;background-image:url(&quot;/asset/x&quot;)"></i>'.repeat(512);
      const times = [];
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        box.innerHTML = one;
        void box.offsetHeight;
        times.push(performance.now() - t0);
      }
      box.remove();
      const p95 = times.slice().sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
      /* 成片模型：512 段顺序 clip 的派生表（每次重画都要摊一遍）。 */
      const clips = Array.from({ length: 512 }, (_, i) => ({
        id: 'c' + i, kind: 'video', sourceStart: i, sourceDuration: 1, mediaDuration: 600,
        duration: 1, playbackRate: 1,
        transition: i % 4 === 0 ? { id: 'fade', duration: 0.5 } : null,
      }));
      let t0 = performance.now();
      for (let i = 0; i < 20; i++) film.deriveTimeline(clips);
      const deriveMs = (performance.now() - t0) / 20;
      const rows = film.deriveTimeline(clips).rows;
      /* 预览每帧都要问一次「这一刻在不在转场窗里」：2000 次看平均每次多少微秒。 */
      t0 = performance.now();
      for (let i = 0; i < 2000; i++) film.transitionAtTime(rows, (i % 512) + 0.75);
      const transUs = (performance.now() - t0) / 2000 * 1000;
      /* 显示层帧计划：512 格的采样点（缩放时整排重算一遍）。 */
      t0 = performance.now();
      for (let i = 0; i < 20; i++) strip.planFrameTimes({ kind: 'video', sourceStart: 0, sourceDuration: 300 }, 512);
      const planMs = (performance.now() - t0) / 20;
      return { p95, max: Math.max(...times), deriveMs, transUs, planMs };
    });
    if (!(out.p95 < 50)) throw new Error('512 格胶片条排版 p95 ' + out.p95.toFixed(1) + 'ms，超过 50ms');
    if (!(out.max < 100)) throw new Error('512 格胶片条排版最大 ' + out.max.toFixed(1) + 'ms，出现 >100ms 长任务');
    if (!(out.deriveMs < 10)) throw new Error('deriveTimeline×512 平均 ' + out.deriveMs.toFixed(2) + 'ms，超过 10ms');
    if (!(out.transUs < 200)) throw new Error('transitionAtTime 平均 ' + out.transUs.toFixed(1) + 'µs，超过 200µs');
    if (!(out.planMs < 10)) throw new Error('planFrameTimes×512 平均 ' + out.planMs.toFixed(2) + 'ms，超过 10ms');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 导演台性能通过（512 格胶片条 p95 ' + out.p95.toFixed(1) + 'ms / max ' + out.max.toFixed(1) +
      'ms；deriveTimeline ' + out.deriveMs.toFixed(2) + 'ms；transitionAtTime ' + out.transUs.toFixed(1) +
      'µs；planFrameTimes ' + out.planMs.toFixed(2) + 'ms）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
