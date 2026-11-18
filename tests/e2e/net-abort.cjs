#!/usr/bin/env node
/* Net 层的「停止要真能停下」判据。
   根因回归位：Net.fetch 在返回 Response 的 finally 里**摘掉外部 signal 的监听**之后，
   流式响应的正文（readSseStream 的 reader.read()）是在返回**之后**才读的 ——
   那时按「停止」，abort 传不到解码流，全站 AI 的停止按钮全部失效。
   修法是保留监听；本判据在页面里把全局 fetch 换成一个「响应头先到 + 一帧 + 挂住、
   signal abort 就 error 掉流」的仿真（与真 fetch 的取消语义一致），两件事必须同时成立：
     ① 正文读到一半按停止 → reader.read() 在 2 秒内 reject，错误名是 AbortError；
     ② 响应头还没到就按停止 → 不许再重试（GET 默认 retry=1，以前取消后还会把重试发完）。
   不碰真网络：仿真只拦 /probe-abort 开头的 URL，页面其余请求照走真 fetch。
   起 Chrome：判据要的是浏览器原生的 ReadableStream / AbortSignal 语义。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => !!window.Net && !!window.Net.fetch, 15000);

    const r = await page.eval(async () => {
      const real = window.fetch;
      const abortErr = () => { const x = new Error('The operation was aborted.'); x.name = 'AbortError'; return x; };
      let calls = 0;
      /* 仿真：只拦 /probe-abort*。与真 fetch 相同的三段语义：
         · signal 已 abort → 立刻 reject（请求根本没发出去）；
         · signal 在头到达前 abort → reject（请求被叫停）；
         · 头到达后 abort → 手动 error 掉正文流（真 fetch 由实现代劳，这里自己挂监听模拟）。 */
      const fake = (url, opts) => {
        calls++;
        const signal = opts && opts.signal;
        if (signal && signal.aborted) return Promise.reject(abortErr());
        return new Promise((res, rej) => {
          const rs = new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
              if (signal) signal.addEventListener('abort', () => {
                try { c.error(abortErr()); } catch (e) { /* 流已经关了 */ }
                try { rej(abortErr()); } catch (e2) { /* 响应已经 resolve */ }
              }, { once: true });
            },
          });
          setTimeout(() => res(new Response(rs, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })), 30);
        });
      };
      window.fetch = (url, opts) => (String(url).indexOf('/probe-abort') === 0 ? fake(url, opts) : real(url, opts));
      const out = {};
      try {
        /* ① 正文读到一半按停止 */
        const ctl = new AbortController();
        const resp = await window.Net.fetch('/probe-abort/stream', { signal: ctl.signal, timeout: 0 });
        const reader = resp.body.getReader();
        const first = await reader.read();                 // 头一帧已在缓冲，立即到手
        const t0 = Date.now();
        setTimeout(() => ctl.abort(), 300);
        let err = null;
        try { await reader.read(); } catch (e) { err = e; }
        out.firstOk = !!first && !first.done;
        out.abortMs = Date.now() - t0;
        out.abortName = err && err.name;
      } catch (e) { out.err1 = String((e && e.message) || e); }
      try {
        /* ② 头还没到就按停止：不许再重试 */
        calls = 0;
        const ctl = new AbortController();
        const p = window.Net.fetch('/probe-abort/pre', { signal: ctl.signal, retry: 2 });
        setTimeout(() => ctl.abort(), 20);                 // 假 fetch 的响应 30ms 后才到
        let name = '';
        try { await p; } catch (e) { name = e && e.name; }
        out.calls = calls;
        out.preName = name;
      } catch (e) { out.err2 = String((e && e.message) || e); }
      window.fetch = real;
      return out;
    });

    const bad = [];
    if (r.err1) bad.push('① Net.fetch 正文流判据抛错：' + r.err1);
    if (!r.firstOk) bad.push('① 头一帧没读到（' + JSON.stringify(r) + '）');
    if (r.abortName !== 'AbortError') bad.push('① 按停止后 reader.read() 没有以 AbortError 拒绝：' + JSON.stringify(r));
    if (!(r.abortMs >= 0 && r.abortMs < 2000)) bad.push('① 按停止后正文流没有及时断开：' + r.abortMs + 'ms');
    if (r.err2) bad.push('② 取消判据抛错：' + r.err2);
    if (r.preName !== 'AbortError') bad.push('② 响应头前按停止没有被认成取消：' + JSON.stringify(r));
    if (r.calls !== 1) bad.push('② 取消后仍然重试了（期望 1 次，实际 ' + r.calls + ' 次）');
    if (bad.length) throw new Error(bad.join('\n'));
    console.log('net-abort: 流式中断可停 ✓ 取消不重试 ✓（' + r.abortMs + 'ms）');
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (proxy) {
      await proxy.stop();
      const f = h.logFaults(proxy.log);
      if (f.length) { console.error(f.join('\n')); process.exitCode = 1; }
    }
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
