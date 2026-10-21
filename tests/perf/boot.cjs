#!/usr/bin/env node
/* 冷启动探针（批次 0.1 / 0.3）：一次全新 profile 的 headless 导航，量首屏的六个头号数字：
     FCP、DCL、load、TTI、首屏脚本字节、JS 解析时间（外加脚本数 / 长任务 / 堆用量做诊断）。
   数据来源只有两处：页面的 Navigation / Paint / Resource / Long Task 计时，以及 CDP
   `Performance.getMetrics`（V8 编译耗时、脚本执行耗时、JSHeapUsedSize）。
   TTI 用标准口径的简化版：从 FCP 起找最早一个「其后 5 秒内既没有新长任务、也没有仍在途的资源」
   的时刻；本应用会在空闲时补载 AI 助手，所以资源静默之后再算，不把首屏之后的后台加载算进去。
   跑法：
     node tests/perf/boot.cjs                 # 只量、只打印（fixture 缺这一节时才补写）
     node tests/perf/boot.cjs --write         # 把实测写进 tests/fixtures/perf-baseline.json
     node tests/perf/boot.cjs --strict        # 与基线比：首屏脚本字节 +10% 或 TTI ×1.5 即红
     node tests/perf/boot.cjs --soak          # 量完再常驻 30 分钟，GC 前后各取一次 JSHeapUsedSize
     node tests/perf/boot.cjs --soak=1800     # 同上，指定秒数（探针用短时长）
   写入型验证只碰 .data-probe-* 等隔离目录（harness 负责创建与清理），不写用户数据。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../e2e/harness.cjs');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'perf-baseline.json');
const WRITE = process.argv.includes('--write');
const STRICT = process.argv.includes('--strict');
const DEBUG = process.argv.includes('--debug');
const soakArg = process.argv.find(a => a === '--soak' || a.startsWith('--soak='));
const SOAK_S = soakArg ? Math.max(10, Number((soakArg.split('=')[1] || 1800)) || 1800) : 0;

function readFixture() {
  try { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); } catch (e) { return {}; }
}
function patchFixture(patch) {
  const next = Object.assign({}, readFixture(), patch, { generatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(next, null, 2) + '\n');
  return next;
}
const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : (n / 1024).toFixed(1) + 'KB';

/* 装到导航之前：资源 / 绘制 / 长任务 / 导航四条计时都在文档最早的脚本之前开始记，
   否则首屏那几笔（shell.html 拉 app.js 与首块渲染）永远落在观察窗之外。 */
function installCollector() {
  const P = window.__bootPerf = { long: [], res: [], paints: {}, nav: null };
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) P.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 老浏览器没有 longtask：TTI 退化成「资源静默 + FCP」 */ }
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.initiatorType === 'script' || /\.m?js(\?|$)/.test(e.name)) {
          P.res.push({ name: e.name, start: e.startTime, end: e.responseEnd,
            size: e.encodedBodySize || e.transferSize || 0 });
        }
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { /* 没有 Resource Timing：脚本字节记 0，其余数字照旧 */ }
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) P.paints[e.name] = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch (e) { /* 没有 Paint Timing：FCP 记 0 */ }
  window.addEventListener('load', () => {
    const n = performance.getEntriesByType('navigation')[0];
    if (n) P.nav = { type: n.type, start: n.startTime, responseEnd: n.responseEnd,
      dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd };
  }, { once: true });
}

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.cdp.send('Network.enable');
    await page.cdp.send('Network.setCacheDisabled', { cacheDisabled: true });  // 冷缓存：新 profile 也不能靠磁盘缓存
    await page.cdp.send('Performance.enable');
    await page.cdp.send('HeapProfiler.enable').catch(() => {});
    await page.addInitScript(installCollector);

    /* JS 解析（parse+compile）只有 tracing 里数得准：`Performance.getMetrics` 的
       V8CompileDuration 只算主线程那一小段（实测 1ms，后台流式解析全不在里面）。
       计时的两个外层事件互不嵌套：`v8.parseOnBackgroundParsing`（网络流式下载时在后台
       线程边解边编，主项）与 `V8.CompileCode`（主线程编译）；`V8.CompileCode` 内部的
       ParseFunction / CompileIgnition 不单独计，避免重复。 */
    let parseUs = 0, parseN = 0;
    page.cdp.on('Tracing.dataCollected', p => {
      for (const e of (p && p.value) || []) {
        if (e && e.dur > 0 && /^(v8\.parseOnBackgroundParsing|V8\.CompileCode)$/.test(e.name || '')) {
          parseUs += e.dur; parseN++;
        }
      }
    });
    let traceDone = null;
    let tracing = false;
    try {
      await page.cdp.send('Tracing.start', { categories: 'v8,disabled-by-default-v8.compile', transferMode: 'ReportEvents' });
      tracing = true;
      traceDone = new Promise(res => page.cdp.on('Tracing.tracingComplete', res));
    } catch (e) { /* 没有 Tracing 域（老内核）就退回 getMetrics 的主线程口径 */ }

    await page.goto(proxy.base + '/');
    await page.waitFor(() => document.readyState === 'complete', 30000);

    /* 资源静默 1.5 秒（AI 助手是空闲补载的，首屏与它之间有一段空窗）；
       静默之后再多等一拍，让 paint / longtask 的缓冲队列落进观察者。 */
    let last = -1, stableSince = Date.now();
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const n = await page.eval(() => performance.getEntriesByType('resource').length).catch(() => 0);
      if (n !== last) { last = n; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 1500) break;
      await h.sleep(150);
    }
    await h.sleep(400);

    const out = await page.eval(() => {
      const P = window.__bootPerf || { long: [], res: [], paints: {}, nav: null };
      const nav = performance.getEntriesByType('navigation')[0];
      const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
      const fcp = (P.paints && P.paints['first-contentful-paint']) || (fcpEntry && fcpEntry.startTime) || 0;
      const res = (P.res || []).slice().sort((a, b) => a.start - b.start);
      const long = (P.long || []).slice().sort((a, b) => a.start - b.start);
      const lastRes = res.reduce((m, r) => Math.max(m, r.end), 0);
      const lastLong = long.reduce((m, l) => Math.max(m, l.start + l.dur), 0);
      const horizon = Math.max(nav ? nav.loadEventEnd : 0, lastRes, lastLong, fcp) + 5000;
      /* TTI：其后 5 秒内没有新长任务、也没有「跨进这段窗口还在途」的资源 */
      const busy = t => long.some(l => l.start >= t && l.start < t + 5000)
        || res.some(r => r.start < t + 5000 && r.end > t);
      let tti = 0;
      for (let t = Math.ceil(fcp / 50) * 50; t <= horizon; t += 50) {
        if (!busy(t)) { tti = t; break; }
      }
      const sum = xs => xs.reduce((n, x) => n + (x.size || 0), 0);
      const upToFcp = res.filter(r => r.end <= fcp);
      const upToLoad = res.filter(r => r.start <= (nav ? nav.loadEventEnd : Infinity));
      return {
        fcpMs: Math.round(fcp),
        dclMs: Math.round(nav ? nav.domContentLoadedEventEnd : 0),
        loadMs: Math.round(nav ? nav.loadEventEnd : 0),
        ttiMs: Math.round(tti || horizon),
        firstScreenScriptBytes: sum(upToFcp),
        firstScreenScriptCount: upToFcp.length,
        initialScriptBytes: sum(upToLoad),
        initialScriptCount: upToLoad.length,
        longTaskCount: long.length,
        longTaskMs: Math.round(long.reduce((n, l) => n + l.dur, 0)),
      };
    });

    const perf = await page.cdp.send('Performance.getMetrics');
    const m = {};
    for (const x of perf.metrics) m[x.name] = x.value;
    if (DEBUG) console.log('CDP metrics: ' + Object.keys(m).sort().join(', '));
    if (tracing) {
      await page.cdp.send('Tracing.end').catch(() => {});
      await Promise.race([traceDone, h.sleep(15000)]);
    }
    const compile = m.V8CompileDuration != null ? m.V8CompileDuration : null;
    const script = m.ScriptDuration != null ? m.ScriptDuration : null;
    const parseMs = parseUs > 0 ? parseUs / 1000 : (compile != null ? compile * 1000 : (script || 0) * 1000);
    out.jsParseMs = Math.round(parseMs);
    out.jsParseSource = parseUs > 0 ? 'v8 parse/compile trace' : (compile != null ? 'V8CompileDuration' : 'ScriptDuration');
    out.jsParseEvents = parseN;
    out.scriptMs = Math.round((script || 0) * 1000);
    out.jsHeapUsedBytes = Math.round(m.JSHeapUsedSize || 0);
    out.nodes = Math.round(m.Nodes || 0);

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));

    const head = {
      firstScreenScriptBytes: out.firstScreenScriptBytes,
      initialScriptBytes: out.initialScriptBytes,
      fcpMs: out.fcpMs,
      dclMs: out.dclMs,
      loadMs: out.loadMs,
      ttiMs: out.ttiMs,
      jsParseMs: out.jsParseMs,
      scriptMs: out.scriptMs,
      jsHeapUsedBytes: out.jsHeapUsedBytes,
    };
    const base = (readFixture().boot) || null;
    if (WRITE || !base) patchFixture({ boot: head });

    console.log('冷启动：FCP ' + out.fcpMs + 'ms · DCL ' + out.dclMs + 'ms · load ' + out.loadMs + 'ms · TTI ' + out.ttiMs + 'ms');
    console.log('  首屏脚本 ' + fmtBytes(out.firstScreenScriptBytes) + '（' + out.firstScreenScriptCount + ' 个，到 FCP 为止）· 整页 ' +
      fmtBytes(out.initialScriptBytes) + '（' + out.initialScriptCount + ' 个）');
    console.log('  JS 解析 ' + out.jsParseMs + 'ms（' + out.jsParseSource + '）· 执行 ' + out.scriptMs + 'ms · 长任务 ' +
      out.longTaskCount + ' 个/' + out.longTaskMs + 'ms · 堆 ' + fmtBytes(out.jsHeapUsedBytes));
    if (base && !WRITE) {
      console.log('  基线差：首屏脚本 ' + (out.firstScreenScriptBytes - base.firstScreenScriptBytes >= 0 ? '+' : '') +
        fmtBytes(out.firstScreenScriptBytes - base.firstScreenScriptBytes) + ' · TTI ' +
        (out.ttiMs - base.ttiMs >= 0 ? '+' : '') + (out.ttiMs - base.ttiMs) + 'ms');
    }

    if (STRICT && base) {
      if (out.firstScreenScriptBytes > base.firstScreenScriptBytes * 1.1) {
        throw new Error('首屏脚本 ' + fmtBytes(out.firstScreenScriptBytes) + '，比基线 ' +
          fmtBytes(base.firstScreenScriptBytes) + ' 多出 10% 以上');
      }
      if (out.ttiMs > base.ttiMs * 1.5 + 200) {
        throw new Error('TTI ' + out.ttiMs + 'ms，超过基线 ' + base.ttiMs + 'ms 的 1.5 倍');
      }
    }

    if (SOAK_S) {
      /* 起点也要先 GC：启动时的短命对象（解析中间层、首屏数据）不算驻留增长。 */
      await page.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      const before = await page.cdp.send('Performance.getMetrics').catch(() => null);
      let heapStart = out.jsHeapUsedBytes;
      if (before) {
        const bm = {};
        for (const x of before.metrics) bm[x.name] = x.value;
        if (bm.JSHeapUsedSize) heapStart = Math.round(bm.JSHeapUsedSize);
      }
      console.log('内存驻留 ' + SOAK_S + ' 秒（起始堆 ' + fmtBytes(heapStart) + '）…');
      const step = Math.max(10, Math.min(60, Math.round(SOAK_S / 10)));
      for (let left = SOAK_S; left > 0; left -= step) {
        await h.sleep(Math.min(step, left) * 1000);
        if (left - step > 0) console.log('  驻留中：还剩 ' + (left - step) + 's');
      }
      await page.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      const after = await page.cdp.send('Performance.getMetrics');
      const am = {};
      for (const x of after.metrics) am[x.name] = x.value;
      const heapEnd = Math.round(am.JSHeapUsedSize || 0);
      const growth = heapEnd - heapStart;
      const memory = { soakSeconds: SOAK_S, heapStartBytes: heapStart, heapEndBytes: heapEnd, growthBytes: growth };
      patchFixture({ memory });
      console.log('内存驻留结果：' + fmtBytes(heapStart) + ' → ' + fmtBytes(heapEnd) + '（增长 ' + fmtBytes(growth) + '）');
      const cap = Math.max(32 * 1024 * 1024, heapStart * 0.5);
      if (growth > cap) throw new Error('驻留 ' + SOAK_S + 's 后堆增长 ' + fmtBytes(growth) + '，超过 ' + fmtBytes(cap));
    }

    console.log('✓ 冷启动探针通过（首屏脚本 ' + fmtBytes(out.firstScreenScriptBytes) + ' / TTI ' + out.ttiMs +
      'ms / JS 解析 ' + out.jsParseMs + 'ms' + (WRITE ? '，已写基线' : '') + '）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
