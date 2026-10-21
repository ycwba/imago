#!/usr/bin/env node
/* 资产库取数这一路的四个门槛数字（批次 2 的 L1 / L2 / L3-L4，AGENTS §7「列表首屏缓存只有一份」）：
     ① 首屏（画到第一张卡片为止）「取列表」的请求数：以前 assets.js 连发两次 fetchMore(1) +
        tally.run(true)（每个来源最多翻 10 页）+ 每批之后逐来源 liveKeys，实测 40+；
        现在两次合成一次 fetchMore(2)、计数延到空闲，门槛 12 以内。
     ② 后台数总数**不许重回第 1 页**：countAll 必须收到页面已有的游标（assets.js 的 tallyFrom），
        且从首屏到数完，整页最多三轮 load（首屏一轮 + 哨兵续拉 + 计数续翻）。
        这一条是结构性判据，不随上游有没有数据变化 —— 少这一条，「首屏 12 笔」迟早又被
        「计数从第 1 页重走一遍」吃回去，而那时首屏那一档还是绿的。
     ③ 同参数第二次 `AssetLib.load`：命中结果级短缓存，一条上游列表请求都不许再发（L1）。
     ④ 有缓存时选择器打开到「首屏可选」：先用 listCache 画底，不等联网那三页（L2，300ms 以内）。
   ①② 只数「把卡片取回来」的那几笔（各来源声明的 list 端点 / 本机资产清单 / 提示词索引），
   余额与外壳启动的请求不计；端点清单从 `server/registry-config.js` 现取，不写死平台名。
   探针实例两处特意固定环境，否则数出来的不是「页面自己要几轮」：
     · `HTTPS_PROXY/HTTP_PROXY` 指到一个没人听的端口 → 上游一律快速失败，判据不依赖任何真实平台、
       也不带密钥出门（这一家能不能连通与这一档要测的东西无关）；
     · 包一层 `Net.fetch/read/json` 把 `retry` 压成 0。**光把设置页那一格（`sk_net_retry`）归零不够**：
       `Api` 的 `rawFetch`（api.js:620）自己写了「没传就重试 1 次」，页面上每一个 5xx/429 都会多一笔，
       数出来的是「重试了几轮」而不是「页面取了几轮」。这一条已经记进执行文档 §13 的风险登记。
   实测数字用 `PERF_WRITE=1 node tests/e2e/asset-requests.cjs` 写进 `tests/fixtures/perf-baseline.json`
   的 `assets` 一节（与切片基线同一份文件、同一个开关）；判据本身只按门槛红，不看基线。
   写入型验证只碰 .data-probe-* 等隔离目录（harness 负责创建与清理），不写用户数据。 */
'use strict';
const path = require('path');
const h = require('./harness.cjs');
const { REGISTRY } = require('../../server/registry-config.js');

/* 门槛：① 首屏列表请求数、② 整页 load 轮数、④ 有缓存时选择器打开耗时（毫秒）。 */
const LIST_REQ_MAX = 12;
const LOAD_ROUNDS_MAX = 4;
const PICKER_MS_MAX = 300;

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* 「取列表那一类」的请求：各来源声明的 list 端点（`local:` 那种就是 /local-assets）、
   本机资产清单、以及提示词归档索引。余额（credits / wallet）、提示词按任务号回源
   （/prompts/find，那是补文字不是取卡片）、外壳启动要打的 /capabilities 与 /data、
   静态资源都不算在这一列里。端点全部从 `server/registry-config.js` 现取。 */
const LIST_PATHS = new Set(['/local-assets', '/prompts']);
for (const p of (REGISTRY.providers || [])) {
  const l = p && p.endpoints && p.endpoints.list;
  if (!l) continue;
  if (String(l).indexOf('local:') === 0) { LIST_PATHS.add(String(l).slice(6).split('?')[0]); continue; }
  if (p.relay) LIST_PATHS.add(String(p.relay) + String(l).split('?')[0]);
}
function isListReq(url) {
  let u;
  try { u = new URL(url, 'http://x'); } catch (e) { return false; }
  return LIST_PATHS.has(u.pathname);
}

/* 装到任何页面脚本之前：
   · 把 fetch / XHR 记成一列流水（带时刻），事后按端点分类计数；
   · 包一层 `AssetLib.load / countAll`，把「这一轮是从头取还是接着游标取」记下来（第 ② 项要读）。
   包的是 `window.AssetLib` 上的方法本身：页面与 countAll 内部都是 `AssetLib.xxx()` 这样调，
   所以两处都拦得到，不需要改任何运行时代码。 */
const COLLECT = () => {
  window.__reqLog = [];
  window.__calls = [];
  const push = u => { try { window.__reqLog.push({ u: String(u), at: Math.round(performance.now()) }); } catch (e) {} };
  const of = window.fetch;
  if (typeof of === 'function') {
    window.fetch = function (input) {
      try { push(typeof input === 'string' ? input : (input && input.url) || String(input)); } catch (e) {}
      return of.apply(this, arguments);
    };
  }
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { try { push(u); } catch (e) {} return oo.apply(this, arguments); };
  const t = setInterval(() => {
    const N = window.Net;
    if (N && !N.__probeRetry) {
      N.__probeRetry = 1;
      /* 把传输层重试压成 0：`Api.rawFetch` 自己写了「没传 retry 就重试 1 次」，
         探针里上游必然 5xx，每一笔都会再多一次 —— 那一类重复与页面取数结构无关。 */
      ['fetch', 'read', 'json'].forEach(k => {
        const f = N[k];
        if (typeof f !== 'function') return;
        N[k] = function (url, o) {
          return f.call(this, url, Object.assign({}, o, { retry: 0 }));
        };
      });
    }
    const A = window.AssetLib;
    if (!A || A.__probeWrapped) { if (++window.__probeTries > 8000) clearInterval(t); return; }
    A.__probeWrapped = 1;
    clearInterval(t);
    const note = (f, o) => window.__calls.push({
      at: Math.round(performance.now()), f,
      pages: o && o.pages != null ? Number(o.pages) : null,
      out: o && Array.isArray(o.out) ? o.out.length : 0,
      cursors: o && o.cursors && typeof o.cursors === 'object' ? Object.keys(o.cursors).length : 0,
      more: o && o.more && typeof o.more === 'object' ? Object.keys(o.more).length : 0,
      prompts: !!(o && o.prompts === false),
    });
    ['load', 'countAll'].forEach(k => {
      const f = A[k];
      A[k] = function (o) {
        note(k, o);
        return f.apply(this, arguments);
      };
    });
  }, 3);
  window.__probeTries = 0;
  return true;
};

/* 先种 24 条本机产物（够一页）：空库时页面会一路往后取，数出来的不是用户真实那一屏。 */
async function seedLocalAssets(proxy, count) {
  const b64 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
  for (let i = 0; i < count; i++) {
    const r = await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ data: b64, format: 'png', mime: 'image/png',
        meta: { prompt: '资产取数门槛探针第 ' + i + ' 条', model: 'probe-model' } }),
    });
    if (r.status !== 200) throw new Error('种本机产物失败 HTTP ' + r.status + '：' + (await r.text()).slice(0, 140));
    await r.text();
  }
}

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
    await seedLocalAssets(proxy, 24);
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.addInitScript(COLLECT);

    /* ---------- ① 首屏：画到第一张卡片为止，数打到列表来源的那几笔 ---------- */
    await page.goto(proxy.base + '/shell.html#assets.html');
    const painted = await page.waitFor(() => {
      const t = document.querySelector('.assets-page');
      return !!(t && t.querySelector('#grid .task'));
    }, 30000).then(() => true).catch(() => false);
    must(painted, '资产库首屏 30 秒内一张卡片都没画出来（种了 24 条本机产物，空态也算通过才对）');
    const atPaint = await page.eval(() => ({
      log: (window.__reqLog || []).slice(), calls: (window.__calls || []).slice(), ms: Math.round(performance.now()),
    }));
    /* 数到「首屏自己的取数走完」为止，切点取「卡片画出来」与「后台数总数开始」里更早的那个。
       不这么切的话，这一档量的是快还是慢：tally 走 requestIdleCallback(timeout 3000)，
       机器忙就先跑计数、空闲就先画卡片，同一份代码能数出 9 笔也能数出 12 笔。
       后台计数本来就不算首屏（那正是 L4 要延后的东西），把它排除在切点之后。 */
    const tallyAt = (atPaint.calls.filter(c => c.f === 'countAll')[0] || {}).at;
    const cutoff = tallyAt == null ? Infinity : Math.min(tallyAt, atPaint.ms);
    const firstScreen = atPaint.log.filter(x => isListReq(x.u) && x.at <= cutoff);
    const listReqs = firstScreen.length;
    must(listReqs <= LIST_REQ_MAX, '资产库首屏「取列表」的请求 ' + listReqs + ' 笔（门槛 ' + LIST_REQ_MAX
      + '，切点 ' + cutoff + 'ms：卡片 ' + atPaint.ms + 'ms / 后台计数 ' + (tallyAt == null ? '没跑' : tallyAt + 'ms')
      + '）：' + firstScreen.map(x => String(x.u).replace(/^https?:\/\/[^/]+/, '')).join(' | '));

    /* ---------- ② 后台数完为止：轮数上限 + 计数必须接着游标走 ---------- */
    /* 等到流水安静 1.5 秒（提示词回源与镜像扫描会拖一条尾巴，安静比固定 sleep 稳）。 */
    let last = -1, quietAt = 0, waited = 0;
    while (waited < 30000) {
      await h.sleep(1000); waited += 1000;
      const len = await page.eval(() => (window.__reqLog || []).length);
      if (len === last) { quietAt += 1000; if (quietAt >= 1500) break; } else { quietAt = 0; last = len; }
    }
    const after = await page.eval(() => ({ log: (window.__reqLog || []).slice(), calls: (window.__calls || []).slice() }));
    const loads = after.calls.filter(c => c.f === 'load');
    const counted = after.calls.filter(c => c.f === 'countAll');
    must(counted.length > 0, '后台数总数一趟都没跑过（scheduleTally 没触发？L4 的「延到空闲」就没了依据）');
    must(loads.length <= LOAD_ROUNDS_MAX, '从首屏到数完一共走了 ' + loads.length + ' 轮 load（门槛 '
      + LOAD_ROUNDS_MAX + '：首屏一轮 + 哨兵续拉 + 计数续翻）：'
      + loads.map(x => 'pages=' + x.pages + '/out=' + x.out + '/cursors=' + x.cursors).join(' | '));
    /* 计数那一轮必须拿着页面已有的游标（或已有条目）往后走，不许从空游标重走第 1 页。
       内层 load 是 countAll 自己起的那一轮：它的 pages 是「剩下的预算」（10 - 已经翻到的页数）。 */
    const inner = loads.filter(x => x.prompts);            // prompts:false 只有 countAll 那一轮
    must(inner.length > 0, 'countAll 里那一轮 load 没带上 prompts:false 标记，取不到计数那轮的参数');
    const fresh = inner.filter(x => !x.cursors && !x.out);
    must(!fresh.length, '后台数总数从第 1 页重走了 ' + fresh.length + ' 轮（cursors=0 且 out=0）：'
      + 'countAll 的 opts.from 没接上 → 首屏已经拿回来的页等于又取一遍（' + LIST_PATHS.size + ' 个端点各一笔）');

    /* ---------- ③ 同参数第二次 load 必须命中结果级短缓存（一条列表请求都不发） ---------- */
    const twice = await page.eval(async () => {
      const before = (window.__reqLog || []).length;
      const a = await window.AssetLib.load({ pages: 1 });
      const mid = (window.__reqLog || []).length;
      const b = await window.AssetLib.load({ pages: 1 });
      const after2 = (window.__reqLog || []).length;
      return { firstReq: mid - before, secondReq: after2 - mid, firstCached: !!a.cached, secondCached: !!b.cached };
    });
    must(twice.secondReq === 0, '同参数 30 秒内第二次 AssetLib.load 又发了 ' + twice.secondReq
      + ' 笔请求（结果级短缓存没命中，cached=' + twice.secondCached + '）');
    must(twice.firstCached === false && twice.secondCached === true,
      '两次 load 的命中状态不对：第一次 cached=' + twice.firstCached + '，第二次 cached=' + twice.secondCached);

    /* ---------- ④ 有缓存时选择器打开到首屏可选 ---------- */
    /* 缓存就是资产页首屏自己写下的那一份（listCache('assets_cache_v1')），探针不另外造形状：
       种进去的东西与页面写的不是同一份，测到的「有缓存」就不是用户那一屏。
       换到工作台那一页开弹窗 —— AssetPicker 只在需要它的页面按 needs 补载。 */
    const seeded = await page.eval(() => window.AssetLib.listCache('assets_cache_v1').read().length);
    must(seeded > 0, '资产库首屏没把列表写进 listCache（读回来 ' + seeded + ' 条），这一档测不到「有缓存时」');

    await page.goto(proxy.base + '/shell.html#studio.html?t=image');
    const ready = await page.waitFor(() => {
      const t = document.querySelector('.studio-page');
      return !!(t && window.AssetPicker);
    }, 30000).then(() => true).catch(() => false);
    must(ready, '工作台那一页没把 AssetPicker 备齐（needs 里没有它？）');
    const openMs = await page.eval(async () => {
      const t0 = performance.now();
      const p = window.AssetPicker.open({ types: ['图片'], multiple: true, title: '门槛探针' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
      const got = () => document.querySelectorAll('#apGrid .ap-item').length;
      let ms = -1, waited2 = 0;
      while (waited2 < 4000) {
        if (got() > 0) { ms = Math.round(performance.now() - t0); break; }
        await new Promise(r => setTimeout(r, 8));
        waited2 += 8;
      }
      const cards = got();
      const cancel = document.getElementById('apCancel');
      if (cancel) cancel.click();
      return { ms, cards };
    });
    must(openMs.ms >= 0, '选择器打开后 4 秒内 #apGrid 里一张卡都没有（缓存底稿没画上，L2 失效）');
    must(openMs.ms <= PICKER_MS_MAX, '有缓存时选择器打开到首屏可选用了 ' + openMs.ms + 'ms（门槛 ' + PICKER_MS_MAX + 'ms）');

    const listAfter = after.log.filter(x => isListReq(x.u)).length;
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理日志异常：' + faults.join(' | '));

    if (process.env.PERF_WRITE) {
      const fs = require('fs');
      const FIX = path.join(__dirname, '../fixtures/perf-baseline.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(FIX, 'utf8')); } catch (e) { /* 第一次写：没有旧基线 */ }
      cur.assets = {
        firstScreenListRequests: listReqs,
        firstScreenPaintMs: atPaint.ms,
        firstScreenCutoffMs: Number.isFinite(cutoff) ? cutoff : null,
        loadRounds: loads.length,
        listRequestsToQuiet: listAfter,
        sameOriginRequestsToQuiet: after.log.length,
        secondLoadRequests: twice.secondReq,
        pickerOpenWithCacheMs: openMs.ms,
        budgets: { listRequests: LIST_REQ_MAX, loadRounds: LOAD_ROUNDS_MAX, pickerMs: PICKER_MS_MAX,
          why: '批次 2 的 L1-L4 验收口径（首屏 12 笔以内 / 计数不许重回第 1 页 / 有缓存时 300ms 以内）；'
            + '首屏那一档的切点取「卡片画出来」与「后台计数开始」里更早的那个，两边同用 performance.now()；'
            + '探针把上游指到一个没人听的端口并归零重试档位，所以这里数的是页面自己的取数轮次，'
            + '不是重试轮次 —— 收紧前先对照 listRequestsToQuiet 与 sameOriginRequestsToQuiet' },
        measuredAt: new Date().toISOString(),
      };
      fs.writeFileSync(FIX, JSON.stringify(cur, null, 2) + '\n');
      console.log('  已写资产取数基线：' + FIX);
    }

    console.log('✓ 资产取数门槛通过（' + n + ' 项：首屏列表请求 ' + listReqs + ' 笔/' + atPaint.ms + 'ms（门槛 '
      + LIST_REQ_MAX + '）· load ' + loads.length + ' 轮（门槛 ' + LOAD_ROUNDS_MAX
      + '）· 数完为止列表 ' + listAfter + ' 笔 / 同源 ' + after.log.length + ' 笔 · 第二次 load 0 笔 · '
      + '有缓存时选择器 ' + openMs.ms + 'ms（门槛 ' + PICKER_MS_MAX + 'ms））');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxy) { try { proxy.stop(); } catch (e) {} }
  }
})();
