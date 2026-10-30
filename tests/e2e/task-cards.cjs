#!/usr/bin/env node
/* 工作台右栏任务卡的三条硬判据（用户 2026-10-29 报的三个毛病，逐条对住）：
     ① 一次生成**只有一张卡** —— 那条占位记录不能与同一条任务的另一份形状并成两张；
     ② 卡不会停在「什么都没有」的空盒上 —— 平台出图之后这一张必须升级成「已完成」并带上产物号；
     ③ 画出来的卡**等高** —— 提示词长短、失败原因有无、按钮多少都不能把某一张卡撑高或压矮。
   上游用一份状态机答复，四条任务号各盯一个**真实会分歧**的形状：
     · 甲：列表已出图，详情一直答「在跑」——占位那一张只能靠列表条目露出的任务号（genId）认回来；
     · 乙：详情当场就出图，列表里根本没有这一条——占位与轮询回来的那一份必须并成同一条记录；
     · 丙：详情一直 404，列表早就出图——「平台上找不到」不许把这张卡的身份（任务号）抹掉；
     · 丁：详情早出图、列表还咬着「在跑」（列表那一份是缓存）——轮询读到的真相要写回来源条目，
           否则卡片每一轮都由旧条目现派生，永远转圈。
   全程不出网：`window.fetch` 只放行本机路由，平台那一路（创建 / 轮询 / 列表 / 能力）由这一份状态机
   答复；代理侧再叠一层「上游指到一个没人听的端口」，就算漏了一条也不会打到真平台、更不会真的扣费。 */
'use strict';
const path = require('path');
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* 四条任务号与它们的产物号、提示词（前缀互不相同，卡片按画出来的那句也能认回来）。 */
const A1 = { job: 'probe-job-1', asset: 'probe-asset-1', prompt: '探针甲：一只纸船漂在雨后的水洼上' };
const B4 = { job: 'probe-job-4', asset: 'probe-asset-4', prompt: '探针乙：凌晨四点的渔港，起重机逆光' };
const C3 = { job: 'probe-job-3', asset: 'probe-asset-3', prompt: '探针丙：湿透的缆绳上落了一只海鸥' };
const D2 = { job: 'probe-job-2', asset: 'probe-asset-2', prompt: '探针丁：盐雾里的灯塔，长曝光' };
const JOBS = [A1, B4, C3, D2];

/* 列表里另外三条是**几何样本**：一条超长提示词、一条带长失败原因、一条最短。
   三张的按钮数相同，撑不撑得住全看 .tprompt 的行钳与 .terr 那一格留没留位。 */
const NOW = new Date('2026-10-29T00:00:00Z').toISOString();
const LONG_PROMPT = '一段很长很长要占满两行才排完的提示词：' + '黄昏的港口、起重机、湿透的缆绳、逆光的盐雾、'.repeat(6);
const FAIL_WHY = 'The generation service rejected the prompt and the reference media, '
  + 'and no credits were charged for this attempt.';
/* 丁那一条：列表在这一刻之前一直咬「在跑」（详情早就出图了）。窗口按时间算，不按轮询次数算 ——
   轮询节奏是页面自己的（间隔能在设置页改，一轮里还能发好几条），按次数就赌在节奏上。 */
const FLIP_MS = 26000;

const STUB = `
(function () {
  var A1 = ${JSON.stringify(A1)}, B4 = ${JSON.stringify(B4)}, C3 = ${JSON.stringify(C3)}, D2 = ${JSON.stringify(D2)};
  var SUBMIT = [A1, B4, C3];                  /* 三次点击生成，按这个顺序发号 */
  var NOW = '${NOW}', FLIP = ${FLIP_MS};
  var LONG = ${JSON.stringify(LONG_PROMPT)}, FAIL_WHY = ${JSON.stringify(FAIL_WHY)};
  /* 本机路由白名单：只有这些前缀（以及静态文件）交给真代理，其余一律当成平台中继。 */
  var LOCAL = /^\\/(registry|data|prompts|cloud|capabilities|skills|local-assets|assets-usage|pick-dir|env-status|sys-status|clear-cache|cache|fcpxml|models|getv|getfile|fetch|s3put|asr|search|client-error|shell\\.html|index\\.html|favicon|manifest)/;
  var STATIC = /^(\\/web\\/|\\/vue|\\/assets\\/|\\/[a-z-]+\\.(js|css|html|json|png|svg|ico|woff2?))/;
  var created = 0, listHits = 0, t0 = 0, detBy = {};
  var done = function (one) {
    return { id: one.job, status: 'succeeded', prompt: one.prompt, model: 'img-probe', mode: 'text_to_image',
      created_at: NOW, completed_at: NOW, output_asset_ids: [one.asset], tier: 'standard', credits: 1,
      parameters: { resolution: '1024', aspect_ratio: '1:1', quality: 'standard', output_count: 1, output_format: 'png' } };
  };
  var running = function (one) {
    return { id: one.job, status: 'processing', prompt: one.prompt, model: 'img-probe',
      created_at: NOW, output_asset_ids: [], parameters: { aspect_ratio: '1:1', quality: 'standard', output_count: 1 } };
  };
  /* 列表那一份：只要创建过就画出来。甲与丙说「图早出了」，丁按时间翻脸，乙根本不在列表里。 */
  var rows = function () {
    listHits++;
    window.__probeList = listHits;
    if (!created) return [];
    return [done(A1), (t0 && Date.now() - t0 < FLIP) ? running(D2) : done(D2), done(C3),
      done({ job: 'probe-asset-long', asset: 'probe-asset-long', prompt: LONG }),
      { id: 'probe-job-fail', status: 'failed', prompt: '探针失败条目', model: 'img-probe', created_at: NOW,
        completed_at: NOW, error: { message: FAIL_WHY } },
      done({ job: 'probe-asset-short', asset: 'probe-asset-short', prompt: '短' })];
  };
  var json = function (obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200,
      headers: { 'Content-Type': 'application/json' } });
  };
  var real = window.fetch;
  window.fetch = function (url, opts) {
    var path = String(typeof url === 'string' ? url : (url && url.url) || '');
    try { path = new URL(path, location.href).pathname; } catch (e) {}
    var method = String((opts && opts.method) || (url && url.method) || 'GET').toUpperCase();
    /* 注册表那一份要**改一个字段再交回页面**：SparkCine 生图的型号清单本来由上游 /models 现取，
       探针不许出网，就按产品自己的那一层兜底（注册表声明）给它一条型号 ——
       没有型号可选的话生成按钮整档是灰的，这一档连「点了没提交」都测不到。
       能力接口照旧放行：代理撞不上上游时回「按平台声明兜底」，那正是没有型号接口时产品的真实形状。 */
    if (path === '/registry') {
      return real.call(window, url, opts).then(function (r) {
        return r.clone().json().then(function (j) {
          var hit = (j.providers || []).find(function (p) { return p.id === 'sparkcine'; });
          if (hit) hit.models = [{ id: 'img-probe', name: '探针型号', modes: ['text_to_image'] }];
          window.__probeReg = (window.__probeReg || 0) + 1;
          return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }, function () { return r; });
      });
    }
    if (LOCAL.test(path) || STATIC.test(path)) return real.call(window, url, opts);
    if (/\\/wallet/.test(path)) return Promise.resolve(json({ data: { balance_credit: 0, frozen_credit: 0 } }));
    /* 平台那一路按 generations 后面的那一截分派（''=创建、'/号'=问一条、带查询串=列表）。 */
    var gi = path.indexOf('/generations');
    if (gi >= 0) {
      var tail = path.slice(gi + '/generations'.length);
      window.__probePaths = (window.__probePaths || []);
      if (window.__probePaths.length < 40) window.__probePaths.push(method + ' …' + tail.slice(0, 24));
      if (method === 'POST' && tail === '') {
        var one = SUBMIT[Math.min(created, SUBMIT.length - 1)];
        created++;
        if (!t0) t0 = Date.now();
        window.__probeCreated = created; window.__probeList = 0; window.__probeT0 = t0;
        return Promise.resolve(json({ id: one.job, status: 'queued', created_at: NOW }));
      }
      if (tail.charAt(0) === '/') {
        var id = tail.slice(1).split('?')[0];
        detBy[id] = (detBy[id] || 0) + 1;
        window.__probeDet = detBy;
        if (id === B4.job) return Promise.resolve(json(done(B4)));        /* 当场出图 */
        if (id === D2.job) return Promise.resolve(json(done(D2)));        /* 详情比列表快 */
        if (id === A1.job) return Promise.resolve(json(running(A1)));     /* 详情一直追不上列表 */
        return Promise.resolve(json({ error: { message: 'task not found' } }, 404));   /* 丙：一直查不到 */
      }
      return Promise.resolve(json({ data: rows() }));
    }
    if (/\\/models/.test(path)) return Promise.resolve(json({ data: [] }));
    return Promise.resolve(json({ data: [] }));
  };
  window.__probeStubReady = true;
})()`;

/* 读一遍右栏：每一张卡归到它那一条探针任务下面（按号、按键、也按画出来的那句提示词认）。
   老代码会把任务号抹掉（详情 404 那一刀），键就退化成「平台+时间+提示词」那一族 ——
   只按号筛正好看不见它，而用户看到的重复就是这一对。 */
const READ = `(() => {
  const H = el => (el ? Math.round(el.getBoundingClientRect().height) : 0);
  const JOBS = ${JSON.stringify(JOBS)};
  const PREFIX = {};
  const all = [];
  const by = {};
  document.querySelectorAll('#result .task').forEach(d => {
    const it = d._item || {};
    const st = ((d.querySelector('.task-status') || {}).textContent || '').trim();
    const pt = ((d.querySelector('.tprompt') || {}).textContent || '').trim();
    const media = d.querySelector('.timg img') ? 'img' : d.querySelector('.timg video') ? 'video'
      : d.querySelector('.timg .ph, .timg svg') ? 'ph' : d.querySelector('.timg') ? 'blank' : 'none';
    const rec = { key: d.dataset.tkey || '', st, media, h: H(d), pt,
      assetId: String(it.assetId || ''), taskId: String(it.taskId || ''),
      err: String(((d.querySelector('.terr') || {}).getAttribute && d.querySelector('.terr').getAttribute('title')) || '').trim(),
      btns: [...d.querySelectorAll('.acts .card-act')].length,
      blocks: { img: H(d.querySelector('.timg')), prompt: H(d.querySelector('.tprompt')),
        terr: H(d.querySelector('.terr')), meta: H(d.querySelector('.meta2')), acts: H(d.querySelector('.acts')) } };
    all.push(rec);
    for (const j of JOBS) {
      const mine = rec.taskId === j.job || rec.assetId === j.asset
        || rec.key === 'i:' + j.job || rec.key === 'i:' + j.asset
        || pt.indexOf(j.prompt.slice(0, 10)) === 0;
      if (mine) { (by[j.job] = by[j.job] || []).push(rec); PREFIX[j.job] = true; break; }
    }
  });
  return { all, by, clock: (window.__probeT0 ? Date.now() - window.__probeT0 : -1),
    det: window.__probeDet || {}, list: window.__probeList || 0, created: window.__probeCreated || 0 };
})()`;

(async () => {
  let proxy, browser, page;
  try {
    /* AUTOSAVE_DIR 把整个「下载」基座指走：这一条从界面点「生成」，页面会往提示词归档里落一份，
       不设的话那条链路就写进用户真实库根（下载\拾帧\提示词\）。它落在探针父目录里，
       proxy.stop() 跟着父目录整组删。 */
    const probeRoot = h.tempDir('task-cards');
    proxy = await h.startProxy({ probeRoot, env: {
      AUTOSAVE_DIR: path.join(probeRoot, 'downloads'),
      HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
    } });
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.addInitScript(STUB);
    /* 探针造的产物没有真字节：把自动补存关掉，别让判据去撞本机资产那一条链。 */
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sk_key_sparkcine', 'probe-key-not-a-real-secret');
        localStorage.setItem('sk_media_local', 'off');
        localStorage.setItem('sk_media_prefer', 'cloud');
      } catch (e) {}
    });
    await page.goto(proxy.base + '/shell.html#studio.html?t=image');
    await page.waitFor(() => !!document.querySelector('.studio-page'), 30000);

    /* 型号清单是后到的：等探针那一条真的进了下拉，否则点了生成只会得到「没有可用型号」。 */
    let gotModel = false;
    try {
      await page.waitFor(() => {
        const sel = document.querySelector('.studio-page [data-r="model"]');
        return sel && [...sel.options].some(o => /img-probe/.test(o.value) || /img-probe/.test(o.textContent)) ? true : null;
      }, 30000);
      gotModel = true;
    } catch (e) { gotModel = false; }
    if (!gotModel) {
      const diag = await page.eval(`(() => {
        const sel = document.querySelector('.studio-page [data-r="model"]');
        return { opts: sel ? [...sel.options].map(o => o.value) : null,
          txt: sel ? sel.textContent.slice(0, 120) : '', reg: window.__probeReg || 0,
          caps: JSON.stringify((window.Capabilities && window.Capabilities.sources) || null).slice(0, 300),
          provs: (window.Api && Api.providers ? Api.providers().filter(p => p.kind === 'image').map(p => p.id + ':' + (p.models || []).length) : null) };
      })()`);
      must(false, '探针型号没进图片台的型号下拉（能力桩没接上）：' + JSON.stringify(diag));
    }

    /* 提交之前：列表里空着，界面上不该有任何探针的卡。 */
    const boot = await page.eval(READ);
    must(boot.all.every(c => !c.key.startsWith('i:probe-')), '还没提交就在右栏看到了探针的卡：'
      + JSON.stringify(boot.all.map(c => c.key)));

    /* 三次点击生成：甲 / 乙 / 丙 各占一个分歧形状。每一次都换提示词，卡片按画出来的那句认。 */
    const submit = async (prompt) => {
      await page.eval(`(() => {
        const t = document.querySelector('.studio-page [data-r="prompt"]');
        t.value = ${JSON.stringify(prompt)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await h.sleep(500);
      const goState = await page.eval(`(() => {
        const b = document.querySelector('.studio-page [data-r="go"]');
        return { found: !!b, disabled: !!(b && b.disabled), why: ((document.querySelector('.studio-page [data-r="goWhy"]') || {}).textContent || '').trim() };
      })()`);
      must(goState.found && !goState.disabled, '生成按钮不可点：' + JSON.stringify(goState));
      await page.eval(`(() => { document.querySelector('.studio-page [data-r="go"]').click(); return true; })()`);
      await h.sleep(700);
    };
    await submit(A1.prompt);
    const c1 = await page.waitFor(() => window.__probeCreated >= 1 ? true : null, 30000);
    must(c1, '点了生成没有发出创建请求');
    await submit(B4.prompt);
    await submit(C3.prompt);
    const c3 = await page.waitFor(() => window.__probeCreated >= 3 ? true : null, 30000);
    must(c3, '三次生成只提交出去 ' + (await page.eval('(() => window.__probeCreated || 0)()')) + ' 次');

    /* 触发一次「后台重拉列表」：页头那颗刷新走的是 reloadHist，它顺手把占位整批清了，
       所以按它测不出重复 —— 真正会撞上的那一路是总线重拉（别的页 / 别的标签页提交一次，
       本页就 loadServer 重取一轮，而占位条目留在缓冲里）。 */
    const emit = await page.eval(`(() => {
      if (!(window.Wb && Wb.busEmit)) return false;
      Wb.busEmit('create', { provider: 'sparkcine' });
      return true;
    })()`);
    must(emit, '页面没有 Wb.busEmit（总线那一层改了名字，这一档就测不到后台重拉）');

    /* 分歧窗口内每 ~700ms 取一次样：这一段是判据最硬的地方 ——
       同一任务挂两张卡、或占位那一张停在什么都没有的空盒上，都只在这窗口里看得见；
       窗口过去列表与详情一致，坏形状自己就被掩盖了。 */
    const samples = [];
    const winEnd = FLIP_MS + 1500;
    while (true) {
      const s = await page.eval(READ);
      samples.push(s);
      if (s.clock >= winEnd) break;
      await h.sleep(700);
    }
    const label = s => s.map(c => ({ key: c.key, st: c.st, media: c.media, tid: c.taskId, aid: c.assetId }));

    /* ① 一次生成一张卡：四条里任何一条在整个窗口里都不许多于一张。 */
    const dup = [];
    samples.forEach((s, i) => {
      for (const j of JOBS) {
        const hit = s.by[j.job] || [];
        if (hit.length > 1) dup.push({ i, job: j.job, at: s.clock, cards: label(hit) });
      }
    });
    must(dup.length === 0, '分歧窗口里出现了同一任务两张卡（' + dup.length + ' 次采样，第一次：'
      + JSON.stringify(dup[0]) + '）—— 就是「一张没加载出来 + 一张已加载出来」那一对');

    /* ② 乙：详情当场出图，而列表里根本没有这一条。轮询那份必须并回占位那一条，
          不能另起一张，也不能让占位那一张永远转圈。 */
    const bSeen = samples.filter(s => (s.det[B4.job] || 0) >= 1 && (s.by[B4.job] || []).length >= 1);
    must(bSeen.length > 0, '乙那一条从没被轮询过（详情命中 ' + JSON.stringify(samples[samples.length - 1].det) + '）');
    must(bSeen.every(s => (s.by[B4.job] || []).length === 1), '乙在详情已出图之后仍是 '
      + (bSeen[0].by[B4.job] || []).length + ' 张卡：' + JSON.stringify(label(bSeen[0].by[B4.job])));
    must(bSeen.some(s => (s.by[B4.job] || [])[0].assetId === B4.asset), '乙没有升级成带产物号的那一张：'
      + JSON.stringify(label((samples.find(s => (s.by[B4.job] || []).length) || { by: {} }).by[B4.job] || [])));

    /* ③ 丁：详情早出图、列表还咬着「在跑」。轮询读到的那一版必须写回来源条目 ——
          卡片每一轮都由条目现派生，只改副本的话下一轮又回到「生成中」的空盒。 */
    const dWin = samples.filter(s => s.clock < FLIP_MS && (s.by[D2.job] || []).length >= 1);
    must(dWin.length >= 3, '丁那一条在列表分歧窗口里没采到样（只有 ' + dWin.length + ' 次）');
    must(dWin.some(s => (s.by[D2.job] || [])[0].st === '已完成' && (s.by[D2.job] || [])[0].assetId === D2.asset),
      '详情早就答出产物号，丁却一直是「' + ((dWin[dWin.length - 1].by[D2.job] || [])[0] || {}).st
      + ' / ' + ((dWin[dWin.length - 1].by[D2.job] || [])[0] || {}).media + '」—— 那张卡永远加载不出来');

    /* ④ 丙：详情一直 404，而列表早就出图。这一条只许留下列表那一份真相 ——
          问不到几次就把任务号抹掉（等于身份没了）的写法，会让这张卡既判成「平台上找不到」，
          又与列表那一条再也对不上，界面上同一任务两张。 */
    const fakeFail = samples.filter(s => (s.by[C3.job] || []).some(c => /平台上找不到|问不到这条任务/.test(c.err)));
    const ffCards = (fakeFail[0] && fakeFail[0].by[C3.job]) || [];
    must(fakeFail.length === 0, '丙被详情那一路判成了「平台上找不到这条任务」（第 '
      + (fakeFail[0] ? fakeFail[0].clock : -1) + ' 毫秒的采样）：' + JSON.stringify(label(ffCards)));
    const lastC = (samples[samples.length - 1].by[C3.job] || []);
    must(lastC.length === 1 && lastC[0].st === '已完成', '丙最终没有回到列表那一份真相：' + JSON.stringify(label(lastC)));

    /* ⑤ 状态不许倒退：任何一条从「已完成」退回非终态，说明占位那一条把列表那一条盖回去了。 */
    for (const j of JOBS) {
      const seq = samples.map(s => ((s.by[j.job] || [])[0] || {}).st || '');
      const back = seq.findIndex((s, i) => i > 0 && s !== '已完成' && seq[i - 1] === '已完成');
      must(back < 0, j.job + ' 的状态从「已完成」退回了「' + seq[back] + '」（第 ' + back + ' 次采样）：'
        + '占位那一条把列表那一条盖回去了');
    }

    /* ⑥ 窗口过去之后：四条各一张、都是已完成，右栏一起画在同一栏里。 */
    let fin = null;
    const until2 = Date.now() + 30000;
    while (Date.now() <= until2) {
      fin = await page.eval(READ);
      const ok = JOBS.every(j => (fin.by[j.job] || []).length === 1
        && fin.by[j.job][0].st === '已完成' && fin.by[j.job][0].assetId === j.asset);
      if (ok) break;
      await h.sleep(1000);
    }
    for (const j of JOBS) {
      const hit = fin.by[j.job] || [];
      must(hit.length === 1, j.job + ' 收尾仍是 ' + hit.length + ' 张卡：' + JSON.stringify(label(hit)));
      must(hit[0].st === '已完成' && hit[0].assetId === j.asset, j.job + ' 没有停在「已完成 + 产物号」上：'
        + JSON.stringify(label(hit)));
    }

    /* ⑦ 等高：四条探针 + 三条几何样本画在同一栏里，高度必须只有一个档。 */
    const buckets = [...new Set(fin.all.map(c => c.h))].sort((a, b) => a - b);
    must(fin.all.length >= 7, '右栏没有画出那七张卡（只有 ' + fin.all.length + ' 张）：'
      + JSON.stringify(fin.all.map(c => c.key + '/' + c.st)));
    must(buckets.length === 1, '卡片高度分了 ' + buckets.length + ' 档（' + JSON.stringify(buckets) + '）：'
      + JSON.stringify(fin.all.map(c => ({ key: c.key, st: c.st, h: c.h, btns: c.btns, b: c.blocks }))));
    /* 单档之外还有一条上限：等高可以由「每格都留得很宽」轻易做到，那是把整列撑高换来的。
       318 是这一版的预算（缩略图 2/1 + 正文两行 + 动作两行），留 14 像素给字号度量的舍入。 */
    must(buckets[0] <= 332, '卡片高度 ' + buckets[0] + ' 超出预算（这一档是 318 + 舍入余量）：'
      + JSON.stringify(fin.all.map(c => ({ key: c.key, h: c.h, blocks: c.blocks }))));
    /* 失败那一张要有原因可看，同时不许把卡片撑出第三行 —— 两格都算在同一个高度里。 */
    const failed = fin.all.find(c => c.st === '生成失败');
    must(failed && failed.err.length > 0, '失败的那张卡没有画出原因：' + JSON.stringify(fin.all.map(c => [c.st, c.err])));
    /* 没有任何一张是「还在转圈却什么都没有」：空盒只许出现在终态（失败）上。 */
    const stuck = fin.all.filter(c => (c.media === 'blank' || c.media === 'none') && c.st !== '生成失败' && c.st !== '已完成');
    must(stuck.length === 0, '有 ' + stuck.length + ' 张卡既不显示媒体也不是终态：' + JSON.stringify(label(stuck)));

    const jsErr = (page.errors || []).filter(e => !/probe-asset|\/asset\//.test(String(e)));
    must(jsErr.length === 0, '页面报错：' + JSON.stringify(jsErr.slice(0, 5)));
    const faults = h.logFaults(proxy.log).filter(f => !/probe|ECONNREFUSED|127\.0\.0\.1:9|ENOTFOUND/.test(f));
    must(faults.length === 0, '代理日志有异常：\n  ' + faults.slice(0, 6).join('\n  '));

    console.log('task-cards: ' + n + ' 项通过（四条分歧任务各一张卡 / 高度 ' + buckets[0] + ' 单档 / 空盒只在终态）');
  } catch (e) {
    console.error('task-cards 失败：' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
