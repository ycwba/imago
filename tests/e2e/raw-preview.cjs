#!/usr/bin/env node
/* 发送前预览的浏览器判据：导演台**不点生成**就能看到将要发出的请求体；
   改提示词它跟着变；预览**没有**多发任何一个创建请求。
   用法与 harness 文档一致：page.eval(fn) / page.waitFor(fn) / page.addInitScript(fn)。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const proxy = await h.startProxy();
  const browser = await h.launchBrowser();
  let bad = 0;
  const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) bad++; };
  try {
    const page = await browser.newPage();
    /* 数「真正发到平台的 create 请求」：在页面脚本之前包一层 fetch。
       预览若偷偷发一次，这里就多一条（这是这一档最要紧的一条）。 */
    await page.addInitScript(() => {
      window.__probeCreates = [];
      const of = window.fetch;
      window.fetch = function (u, o) {
        try { const s = String(u && u.url ? u.url : u); if (/\/create(\?|$)/.test(s)) window.__probeCreates.push(s); } catch (e) {}
        return of.apply(this, arguments);
      };
    });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => document.body && document.body.innerText.length > 0, 20000);
    await new Promise(r => setTimeout(r, 2500));

    /* ① 原始请求面板已按需补载 */
    const hasRaw = await page.eval(() => !!(window.RawRequest && typeof window.RawRequest.liveHTML === 'function'));
    ok(hasRaw, '原始请求面板已按需补载（window.RawRequest 就绪）');

    /* ② 右栏画出了并排那一块 */
    const live = await page.eval(() => {
      const el = document.querySelector('details.raw-req[data-raw-live]');
      if (!el) return null;
      return { summary: (el.querySelector('summary') || {}).textContent || '',
        halves: el.querySelectorAll('.raw-half').length };
    });
    ok(!!live, '导演台右栏画出了「原始请求」折叠块');
    if (live) {
      ok(/将要发送|尚未发送/.test(live.summary), '标题说的是「将要发送」：' + live.summary);
      ok(live.halves === 2, '并排两栏（将要发出 / 已发送）：' + live.halves);
    }

    /* ③ 预览那一栏有内容 */
    const pre = await page.eval(() => {
      const el = document.querySelector('details.raw-req[data-raw-live]');
      if (!el) return '';
      const ps = el.querySelectorAll('.raw-half pre');
      return ps && ps[0] ? ps[0].textContent : '';
    });
    ok(!!pre, '预览那一栏有内容（长度 ' + pre.length + '）');

    /* ④ 预览没有发过任何 create 请求 */
    const creates = await page.eval(() => (window.__probeCreates || []).slice());
    ok(creates.length === 0, '预览没有发出任何创建请求（' + creates.length + ' 条）' + (creates.length ? '：' + creates.join(',') : ''));

    /* ⑤ 改提示词 → 预览跟着变 */
    const changed = await page.eval(async () => {
      const el = document.querySelector('details.raw-req[data-raw-live]');
      if (!el) return { ok: false, why: '没有面板' };
      const ps = el.querySelectorAll('.raw-half pre');
      const before = ps && ps[0] ? ps[0].textContent : '';
      const ta = document.querySelector('#edPrompt');
      if (!ta) return { ok: false, why: '没有提示词框' };
      ta.value = '黄昏的河岸，一个撑伞的人走过石桥';
      ta.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      const ps2 = el.querySelectorAll('.raw-half pre');
      const after = ps2 && ps2[0] ? ps2[0].textContent : '';
      return { ok: true, changed: before !== after, before: before.slice(0, 90), after: after.slice(0, 90) };
    });
    if (changed.ok) {
      console.log('    改前: ' + changed.before);
      console.log('    改后: ' + changed.after);
      ok(changed.changed, '改了提示词之后预览跟着变了');
    } else {
      ok(false, '改提示词那一步没做成：' + changed.why);
    }
    const creates2 = await page.eval(() => (window.__probeCreates || []).slice());
    ok(creates2.length === 0, '改提示词也没有多发请求（' + creates2.length + ' 条）');

    /* ⑥ 没有未捕获异常 */
    const faults = await h.logFaults ? await h.logFaults(page) : [];
    const real = (faults || []).filter(e => !/Failed to load resource|net::ERR|AbortError|favicon/i.test(String(e)));
    ok(!real.length, '没有未捕获异常' + (real.length ? '：' + real.slice(0, 3).join(' | ') : ''));
  } finally {
    await browser.close();
    await proxy.stop();
  }
  console.log(bad ? '\n✗ ' + bad + ' 项未通过' : '\n✓ 发送前预览：不用点生成就能看到请求体');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
