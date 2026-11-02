#!/usr/bin/env node
/* 发送前预览的浏览器判据：导演台**不点生成**就能看到将要发出的请求体；
   改提示词它跟着变；预览**没有**多发任何一个创建请求。
   用法与 harness 文档一致：page.eval(fn) / page.waitFor(fn) / page.addInitScript(fn)。
   这一档判的是「上游通了以后预览对不对」：那一栏要算得出请求体，先得有型号清单
   （`Capabilities.modelsFor` 只认平台 /models 落回来的那些型号）。上游不通时那一栏本来就画不出东西 ——
   那是「能不能连上平台」那一档的事，这里等不到清单就**整档跳过并报明**
   既不判绿也不判红。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const proxy = await h.startProxy();
  const browser = await h.launchBrowser();
  let bad = 0;
  const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) bad++; };
  let skipped = '';
  try {
    /* ⓪ 按家增量：**一家**能力落定就广播 `wb:cap-ready`、右栏就补画，
       不等所有在用的平台都回来 —— 以前只认 `Capabilities.load().then` 那一次，
       上游慢的那一家把「将要发出」那栏拖到分钟级且不自愈。
       用受控的假 /capabilities 把「第一家 vs 其余」的落定时间拉开 2 秒多，
       事件与补画都必须按家发生。这一段不碰真上游（/capabilities 被本探针截住），
       放在最前面：上游不通也照跑。 */
    {
      const p2 = await browser.newPage();
      await p2.addInitScript(() => {
        window.__probeReady = [];
        window.__probeSentinelAt = null;
        window.__probeSentinelGoneAt = null;
        const seen = [];
        const of = window.fetch;
        window.fetch = function (u, o) {
          const s = String(u && u.url ? u.url : u);
          if (s.indexOf('/capabilities?provider=') >= 0) {
            const id = decodeURIComponent((s.split('provider=')[1] || '').split('&')[0]);
            if (!seen.includes(id)) seen.push(id);
            const delay = seen.length === 1 ? 300 : 2600;
            return new Promise(res => setTimeout(() =>
              res(new Response(JSON.stringify({ models: {} }), { status: 200, headers: { 'content-type': 'application/json' } })), delay));
          }
          return of.apply(this, arguments);
        };
        window.addEventListener('wb:cap-ready', e => {
          const d = (e && e.detail) || {};
          window.__probeReady.push({ id: d.id, ok: !!d.ok, t: performance.now() });
          /* 第一家落定那一刻往右栏插一枚哨兵：renderEditor 是整片 innerHTML 重画，
             哨兵消失 = 补画跑过。MutationObserver 记下它被拿走的时刻，
             等最后一家落定的时刻一比，就知道补画是「按家」还是「等全部」。 */
          const col = document.querySelector('#edCol');
          if (col && window.__probeReady.length === 1 && window.__probeSentinelAt == null) {
            const sen = document.createElement('i');
            sen.id = 'capSentinel';
            col.appendChild(sen);
            window.__probeSentinelAt = performance.now();
            new MutationObserver(() => {
              if (!document.getElementById('capSentinel') && window.__probeSentinelGoneAt == null) {
                window.__probeSentinelGoneAt = performance.now();
              }
            }).observe(col, { childList: true, subtree: true });
          }
        });
      });
      try {
        await p2.goto(proxy.base + '/shell.html#director.html');
        await p2.waitFor(() => (window.__probeReady || []).length >= 2, 30000).catch(() => {});
        const ev = await p2.eval(() => ({
          ready: (window.__probeReady || []).slice(),
          sentAt: window.__probeSentinelAt, goneAt: window.__probeSentinelGoneAt,
        }));
        const ids = [...new Set(ev.ready.map(r => r.id))];
        ok(ev.ready.length >= 1, '能力按家广播了 wb:cap-ready（' + ev.ready.length + ' 次 / ' + ids.length + ' 家：'
          + ids.slice(0, 6).join(',') + (ids.length > 6 ? '…' : '') + '）');
        if (ev.ready.length >= 2) {
          const gap = Math.round(ev.ready[ev.ready.length - 1].t - ev.ready[0].t);
          ok(gap >= 800, '第一家与其余各家确实拉开了落地时间（首末差 ' + gap
            + 'ms）：事件是按家投的，不是攒齐一波再投');
          if (ev.sentAt != null) {
            ok(ev.goneAt != null && ev.goneAt < ev.ready[ev.ready.length - 1].t,
              '第一家落定后右栏就补画了（哨兵在最后一家落定前被重画拿走）：不等全部平台');
          } else {
            ok(false, '第一家落定那一刻右栏还不存在（#edCol 没挂上），按家补画没测到');
          }
        } else {
          console.log('    （探针实例只有 ' + ev.ready.length + ' 家在用，拉开落定时间的对照做不了；事件层已验）');
        }
        const faults2 = await h.logFaults ? await h.logFaults(p2) : [];
        const real2 = (faults2 || []).filter(e => !/Failed to load resource|net::ERR|AbortError|favicon/i.test(String(e)));
        ok(!real2.length, '按家增量档没有未捕获异常' + (real2.length ? '：' + real2.slice(0, 3).join(' | ') : ''));
      } finally {
        await p2.close();
      }
    }

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

    /* 先等型号清单落地，再等「预览画上」——两处都等条件，不拍固定毫秒数。
       以前这里睡固定 2500ms：机器忙（全量档里紧跟 422s 的 ui-visual 之后）或上游慢的时候，
       那一栏还是占位符，而「有内容」那句把占位符也算成了内容 —— 假绿。 */
    const capsOk = await page.waitFor(() => window.Capabilities && window.Capabilities.models
      && Object.keys(window.Capabilities.models).length > 0, 60000).catch(() => false);
    if (!capsOk) {
      skipped = '60 秒内一个模型能力都没拿到（平台 /models 没通）：没有型号清单，「将要发出」那一栏本来就算不出请求体';
    } else {
      const livePre = () => page.eval(() => {
        const el = document.querySelector('details.raw-req[data-raw-live]');
        if (!el) return null;
        const pre = el.querySelector('pre');
        return pre ? pre.textContent : null;
      });
      const painted = await page.waitFor(() => {
        const el = document.querySelector('details.raw-req[data-raw-live]');
        if (!el) return false;
        const pre = el.querySelector('pre');
        const t = pre ? pre.textContent : '';
        return !!t && t.indexOf('还没有可预览') < 0;
      }, 30000).catch(() => false);

      /* ① 原始请求面板已按需补载 */
      const hasRaw = await page.eval(() => !!(window.RawRequest && typeof window.RawRequest.liveHTML === 'function'));
      ok(hasRaw, '原始请求面板已按需补载（window.RawRequest 就绪）');

      /* ② 右栏画出了「将要发出」那一块（单栏：只有预览） */
      const live = await page.eval(() => {
        const el = document.querySelector('details.raw-req[data-raw-live]');
        if (!el) return null;
        return { summary: (el.querySelector('summary') || {}).textContent || '',
          pres: el.querySelectorAll('pre').length, halves: el.querySelectorAll('.raw-half').length };
      });
      ok(!!live, '导演台右栏画出了「原始请求」折叠块');
      if (live) {
        ok(/预览|尚未算出/.test(live.summary), '标题说的是「预览」：' + live.summary);
        ok(live.pres === 1 && live.halves === 0, '单栏：只显示将要发出的那一份（pre=' + live.pres + '，旧两栏=' + live.halves + '）');
      }

      /* ③ 预览那一栏是真请求体（占位符不算内容） */
      const pre = (await livePre()) || '';
      ok(painted && /^POST\s|^GET\s/.test(pre) && pre.indexOf('{') >= 0,
        '预览那一栏有请求体（长度 ' + pre.length + '）：' + JSON.stringify(pre.slice(0, 24)));

      /* ④ 预览没有发过任何 create 请求 */
      const creates = await page.eval(() => (window.__probeCreates || []).slice());
      ok(creates.length === 0, '预览没有发出任何创建请求（' + creates.length + ' 条）' + (creates.length ? '：' + creates.join(',') : ''));

      /* ⑤ 改提示词 → 预览跟着变（等的同样是条件：重画由编辑器的防抖排下去，
         固定睡 1200ms 在机器忙时会先读到旧的那一份，把「跟着变」判成假） */
      const before = (await livePre()) || '';
      await page.eval(t => { window.__preBefore = t; }, before);
      const edited = await page.eval(() => {
        const ta = document.querySelector('#edPrompt');
        if (!ta) return false;
        ta.value = '黄昏的河岸，一个撑伞的人走过石桥';
        ta.dispatchEvent(new Event('input'));
        return true;
      });
      const moved = edited ? await page.waitFor(() => {
        const el = document.querySelector('details.raw-req[data-raw-live]');
        const pre2 = el && el.querySelector('pre');
        const t = pre2 ? pre2.textContent : '';
        return !!t && t !== window.__preBefore;
      }, 15000).catch(() => false) : false;
      const after = (await livePre()) || '';
      if (edited) {
        console.log('    改前: ' + before.slice(0, 90));
        console.log('    改后: ' + after.slice(0, 90));
        ok(moved && after !== before && after.indexOf('黄昏的河岸') >= 0, '改了提示词之后预览跟着变了');
      } else {
        ok(false, '改提示词那一步没做成：没有提示词框');
      }
      const creates2 = await page.eval(() => (window.__probeCreates || []).slice());
      ok(creates2.length === 0, '改提示词也没有多发请求（' + creates2.length + ' 条）');

      /* ⑥ 没有未捕获异常 */
      const faults = await h.logFaults ? await h.logFaults(page) : [];
      const real = (faults || []).filter(e => !/Failed to load resource|net::ERR|AbortError|favicon/i.test(String(e)));
      ok(!real.length, '没有未捕获异常' + (real.length ? '：' + real.slice(0, 3).join(' | ') : ''));
    }
  } finally {
    await browser.close();
    await proxy.stop();
  }
  if (skipped) { console.log('\nℹ 跳过：' + skipped); process.exit(0); }
  console.log(bad ? '\n✗ ' + bad + ' 项未通过' : '\n✓ 发送前预览：不用点生成就能看到请求体');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
