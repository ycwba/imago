#!/usr/bin/env node
/* 切片性能（批次 4 / P1-P6）：真实浏览器里把一条 20 秒素材摆成二十格，量四件事 ——
     首格 ≤ 600ms、整排 20 格 ≤ 2.5s、缩放后重填 ≤ 1.5s、一次重画解码次数不超期望值；
   顺带把 P1（一素材一只 video）、P4（worker 编码真的在跑）、P2（缩放命中 ≥70%）、
   P5（同一工程二次打开 0 次解码）数出来。
   需要 ffmpeg 造 20 秒素材；没有就跳过并报明。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

const FIRST_MS = 600;       // 首格
const ROW_MS = 2500;        // 整排 20 格
const REFILL_MS = 1500;     // 缩放后重填
const HIT = 0.7;            // 缩放命中率下限（P2）

(async () => {
  if (!h.hasFfmpeg()) { console.log('- 跳过切片性能（本机没有 ffmpeg，造不出 20 秒素材）'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-slice-perf-'));
  const clip = h.makeClip(work, 20);
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    /* 64px/秒 × 20 秒 = 1280px：一排正好 20 格（每格 64px）。
       比例尺要**在页面装配前**就定下来 —— 它进的是 tlPps 的初值。 */
    await page.addInitScript(() => {
      try { localStorage.setItem('dir_tl_pps', '64'); } catch (e) {}
    });
    /* P4 的观测点：worker 什么时候建、真的收发了多少条。必须在页面脚本之前装。 */
    await page.addInitScript(() => {
      window.__spWorkers = []; window.__spPosts = 0; window.__spReplies = 0;
      const W = window.Worker;
      if (!W) return;
      window.Worker = function (url, opts) {
        const w = new W(url, opts);
        const u = String(url);
        window.__spWorkers.push(u);
        if (/slice-worker\.js/.test(u)) {
          try {
            const post = w.postMessage.bind(w);
            w.postMessage = function () { window.__spPosts++; return post.apply(null, arguments); };
            w.addEventListener('message', function () { window.__spReplies++; });
          } catch (e) {}
        }
        return w;
      };
      window.Worker.prototype = W.prototype;
    });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);

    /* 数解码原语：meta / seek / el / release 都从这里走（切片与首帧缩略图共用这一份）。 */
    const armed = await page.eval(() => {
      const V = window.Wb && window.Wb.vframe;
      if (!V) return { err: '页面没有 Wb.vframe' };
      const o = { meta: 0, seek: 0, seekTimes: [], els: 0, release: 0, trace: [] };
      window.__sp = o;
      const T = k => { if (o.trace.length < 90) o.trace.push(k + '=' + Math.round(performance.now())); };
      const om = V.meta.bind(V), os = V.seek.bind(V), oe = V.el.bind(V), orl = V.release.bind(V);
      /* 每块解码都会问一次 meta，但只有 readyState 还没到 1 的那次才真的在读元数据：
         P1 数的是「解析了几次」，不是「问了几次」。 */
      V.meta = function (v) { if (v.readyState < 1) { o.meta++; T('meta0'); const p = om(v); p.then(() => T('meta1'), () => T('metaX')); return p; } return om(v); };
      V.seek = function (v, t) { o.seek++; o.seekTimes.push(Number(t)); T('seek' + t); return os(v, t); };
      V.el = function (src) { o.els++; T('el'); return oe(src); };
      V.release = function (v) { o.release++; T('rel'); return orl(v); };
      return { ok: true };
    });
    if (armed.err) throw new Error(armed.err);

    await page.setFile('#importMediaFile', clip);
    const okCand = () => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
    };
    await page.waitFor(okCand, 25000, 200).catch(async () => {
      await page.eval(() => { const f = document.getElementById('importMediaFile'); if (f) f.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitFor(okCand, 30000, 200);
    });
    const imported = await page.eval(() => {
      const c = window.WBBridge.get('director').context();
      const hit = (c.候选 || []).find(x => x.状态 === 'succeeded');
      return hit ? { id: hit.id, dur: hit.秒 } : null;
    });
    if (!imported) throw new Error('导入之后没有「已出片」的候选');
    if (!(parseFloat(imported.dur) >= 19)) throw new Error('导入素材时长读成 ' + imported.dur + ' 秒，摆不出二十格（ffprobe 没读到 20 秒）');
    const sel = await page.eval(async id => {
      const A = window.WBBridge.get('director');
      const c = A.context();
      const r = await A.run('select', { candId: id, expectedRevision: c.revision });
      return { ok: r.ok !== false, why: r.text || r.err || JSON.stringify(r).slice(0, 160) };
    }, imported.id);
    if (!sel.ok) throw new Error('选用导入的那一条失败：' + sel.why);
    /* 轨道画的是「当前在看的那一条候选」：点它那颗瓦片就是用户会做的动作。 */
    const focus = await page.eval(id => {
      const t = [...document.querySelectorAll('.cand-thumb[data-vid]')].find(x => x.dataset.vid === id);
      if (!t) return { err: '候选条里找不到导入那一条的瓦片（data-vid=' + id + '）' };
      t.click();
      return { ok: true };
    }, imported.id);
    if (focus.err) throw new Error(focus.err);
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      const row = (c.候选 || []).find(x => x.状态 === 'succeeded' && x.选用);
      return !!(row && row.当前);
    }, 10000, 200).catch(() => { throw new Error('点了瓦片也没把轨道焦点切到导入的那一条'); });

    /* 起表之前先让中栏预览把元数据读出来：真实用户点开候选时播放器已经在了，按「剪辑」时
       浏览器媒体栈不会再冷启一次。切片首格的预算量的是切片流水线，而媒体进程冷启动在
       与用户浏览器共用的这台机器上能到秒级（实测一次 2.7 秒，其余次 1ms）。 */
    await page.waitFor(() => {
      const pl = document.getElementById('player');
      return !!(pl && pl.readyState >= 2);
    }, 20000, 100).catch(() => { throw new Error('候选预览的 <video> 一直没读到首帧，量不了切片首格'); });

    /* 起跑：清计数 → 看一眼旧轨道格数 → 进剪辑 → 每 16ms 看一次哪一格先有图、什么时候整排齐。 */
    const startRows = await page.eval(() => {
      const P = window.__sp;
      P.meta = 0; P.seek = 0; P.seekTimes = []; P.els = 0; P.release = 0;
      const t0 = performance.now();
      const run = { t0: t0, first: 0, full: 0, total: 0, done: false };
      window.__spRun = run;
      const read = () => {
        const row = document.querySelector('.tl-vrow');
        const tiles = row ? Array.prototype.slice.call(row.querySelectorAll('i.fr')) : [];
        const filled = tiles.filter(x => x.style.backgroundImage).length;
        run.total = tiles.length;
        if (!run.first && filled > 0) run.first = performance.now() - t0;
        if (!run.done && tiles.length > 0 && filled >= tiles.length) { run.done = true; run.full = performance.now() - t0; }
      };
      run.timer = setInterval(read, 16);
      read();
      const t = document.getElementById('trimBtn');
      if (!t) return { err: '导演台没有 #trimBtn 那颗剪辑开关' };
      if (!t.classList.contains('active')) t.click();
      return { ok: true };
    });
    if (startRows.err) throw new Error(startRows.err);
    await page.waitFor(() => window.__spRun && window.__spRun.done, 15000, 100).catch(() => {});
    const first = await page.eval(() => {
      const r = window.__spRun, P = window.__sp;
      clearInterval(r.timer);
      return { first: r.first, full: r.full, total: r.total, done: r.done, t0: r.t0,
        meta: P.meta, seek: P.seek, uniq: Array.from(new Set(P.seekTimes)).length,
        els: P.els, release: P.release, trace: P.trace,
        workers: window.__spWorkers, posts: window.__spPosts, replies: window.__spReplies };
    });
    if (!first.done) throw new Error('进剪辑后 15 秒还没把一排切片填满：' + JSON.stringify(first));
    if (!(first.total >= 20)) throw new Error('这一排只画出 ' + first.total + ' 格，量不到「整排 20 格」');
    if (!(first.first > 0 && first.first <= FIRST_MS)) {
      throw new Error('首格 ' + first.first.toFixed(0) + 'ms，超过 ' + FIRST_MS + 'ms；时序 '
        + first.trace.map(x => { const [k, t] = x.split('='); return k + '@' + (Number(t) - first.t0).toFixed(0); }).join(' '));
    }
    if (!(first.full <= ROW_MS)) throw new Error('整排 ' + first.total + ' 格用了 ' + first.full.toFixed(0) + 'ms，超过 ' + ROW_MS + 'ms');
    /* P1：一条素材只该有一只 <video>、一次元数据解析。 */
    if (first.els > 1) throw new Error('一条素材开了 ' + first.els + ' 只 <video>（P1 要求一素材一只）');
    if (first.meta > 1) throw new Error('一条素材解析了 ' + first.meta + ' 次元数据（P1 要求一次）');
    /* 解码次数不超期望：每格一个时刻，同一时刻不重解（栅格去重后 ≤ 格数）。 */
    if (!(first.seek <= first.total)) throw new Error('首排解码 ' + first.seek + ' 次，超过期望的 ' + first.total + ' 次');
    if (first.uniq !== first.seek) throw new Error('同一批时刻里有重复解码：seek ' + first.seek + ' 次，去重后 ' + first.uniq + ' 个时刻');
    /* P4：浏览器支持 ImageBitmap/OffscreenCanvas 时，切片编码必须真的交给 worker 且收到回执。 */
    const supportsWorker = await page.eval(() => typeof Worker !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function');
    if (supportsWorker) {
      if (!first.workers.some(u => /slice-worker\.js/.test(u))) throw new Error('浏览器支持 worker，但切片 worker 从没建起来');
      if (!(first.posts >= 1 && first.replies >= 1)) throw new Error('切片 worker 没收到/没回过编码任务（posts=' + first.posts + ' replies=' + first.replies + '）');
      if (first.replies !== first.posts) throw new Error('切片 worker 有任务没回执（posts=' + first.posts + ' replies=' + first.replies + '，会退回主线程）');
    }

    /* rVFC 等不到时改用 seeked 直接抓（GPU 被关掉的环境里游离的 <video> 永远不出帧回调）：
       抓早了会把上一格又贴一遍。这条按 JPEG 字节指纹数「整排有几种画面」。 */
    const fps = await page.eval(async () => {
      const tiles = Array.prototype.slice.call(document.querySelectorAll('.tl-vrow i.fr'));
      const urls = tiles.map(t => {
        const m = /url\(["']?(.*?)["']?\)/.exec(t.style.backgroundImage || '');
        return m ? m[1] : '';
      }).filter(Boolean);
      const hash = u => new Promise(res => {
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = 24; c.height = 14;
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0, 24, 14);
            const d = x.getImageData(0, 0, 24, 14).data;
            let h = 2166136261 >>> 0;
            for (let i = 0; i < d.length; i += 4) { h ^= d[i] + d[i + 1] * 3 + d[i + 2] * 7; h = Math.imul(h, 16777619) >>> 0; }
            res(h.toString(16));
          } catch (e) { res('err'); }
        };
        img.onerror = () => res('err');
        img.src = u;                 // 走 <img> 而不是 fetch：CSP 的 connect-src 不含 blob:
      });
      const hs = [];
      for (const u of urls) hs.push(await hash(u));
      const frs = document.querySelector('.tl-vrow [data-frs]');
      return { tiles: tiles.length, urls: urls.length, distinct: new Set(hs).size,
        sampleUrls: Array.from(new Set(urls)).slice(0, 3),
        hashes: Array.from(new Set(hs)).slice(0, 3),
        attrs: frs ? { n: frs.getAttribute('data-n'), step: frs.getAttribute('data-step'), a: frs.getAttribute('data-in'), b: frs.getAttribute('data-out') } : null };
    });
    if (!(fps.urls >= Math.min(18, first.total))) throw new Error('整排 ' + first.total + ' 格里只有 ' + fps.urls + ' 格带图，数不了指纹');
    if (!(fps.distinct / fps.urls >= 0.9)) {
      throw new Error('整排 ' + fps.urls + ' 格里只有 ' + fps.distinct + ' 种画面：切片抓到的是同一帧（rVFC 等不到时贴重了）'
        + '；seek=' + first.seek + ' done=' + first.done + ' ' + JSON.stringify(fps));
    }

    /* 缩放（P2）：64 → 51.2px/秒，采样仍吸附在整数秒栅格上 → 一次解码都不该发生。 */
    const zoomOut = await page.eval(() => {
      const P = window.__sp;
      P.seek = 0; P.seekTimes = [];
      const before = document.querySelectorAll('.tl-vrow i.fr').length;
      const t0 = performance.now();
      const run = { t0: t0, full: 0, total: 0, done: false, before: before };
      window.__spZoom = run;
      const read = () => {
        const row = document.querySelector('.tl-vrow');
        const tiles = row ? Array.prototype.slice.call(row.querySelectorAll('i.fr')) : [];
        const filled = tiles.filter(x => x.style.backgroundImage).length;
        run.total = tiles.length;
        if (!run.done && tiles.length > 0 && tiles.length !== run.before && filled >= tiles.length) {
          run.done = true; run.full = performance.now() - t0;
        }
      };
      run.timer = setInterval(read, 16);
      const bar = document.getElementById('tlBar');
      if (!bar) return { err: '导演台没有 #tlBar' };
      bar.dispatchEvent(new WheelEvent('wheel', { deltaY: 148.7, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true }));
      return { ok: true };
    });
    if (zoomOut.err) throw new Error(zoomOut.err);
    await page.waitFor(() => window.__spZoom && window.__spZoom.done, 6000, 50).catch(() => {});
    const z1 = await page.eval(() => {
      const r = window.__spZoom, P = window.__sp;
      clearInterval(r.timer);
      return { full: r.full, total: r.total, before: r.before, done: r.done, seek: P.seek, uniq: Array.from(new Set(P.seekTimes)).length };
    });
    if (!z1.done) throw new Error('缩放后 6 秒还没把重排的一排填满：' + JSON.stringify(z1));
    if (!(z1.total > 0 && z1.total !== z1.before)) throw new Error('缩放没有改变格数（' + z1.before + ' → ' + z1.total + '），这一档没测到重填');
    if (!(z1.full <= REFILL_MS)) throw new Error('缩放后重填 ' + z1.full.toFixed(0) + 'ms，超过 ' + REFILL_MS + 'ms');
    const hit1 = z1.total ? 1 - z1.uniq / z1.total : 0;
    if (!(hit1 >= HIT)) throw new Error('缩放后命中率 ' + (hit1 * 100).toFixed(0) + '%（' + z1.uniq + '/' + z1.total + ' 个时刻重新解码），低于 ' + (HIT * 100) + '%');

    /* 再缩回去：这一档同样落在整数秒栅格上，单次重画的解码次数应当是 0。 */
    const zoomIn = await page.eval(() => {
      const P = window.__sp;
      P.seek = 0; P.seekTimes = [];
      const before = document.querySelectorAll('.tl-vrow i.fr').length;
      const t0 = performance.now();
      const run = { t0: t0, full: 0, total: 0, done: false, before: before };
      window.__spZoom2 = run;
      const read = () => {
        const row = document.querySelector('.tl-vrow');
        const tiles = row ? Array.prototype.slice.call(row.querySelectorAll('i.fr')) : [];
        const filled = tiles.filter(x => x.style.backgroundImage).length;
        run.total = tiles.length;
        if (!run.done && tiles.length > 0 && tiles.length !== run.before && filled >= tiles.length) {
          run.done = true; run.full = performance.now() - t0;
        }
      };
      run.timer = setInterval(read, 16);
      document.getElementById('tlBar').dispatchEvent(new WheelEvent('wheel', { deltaY: -148.7, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true }));
      return { ok: true };
    });
    if (zoomIn.err) throw new Error(zoomIn.err);
    await page.waitFor(() => window.__spZoom2 && window.__spZoom2.done, 6000, 50).catch(() => {});
    const z2 = await page.eval(() => {
      const r = window.__spZoom2, P = window.__sp;
      clearInterval(r.timer);
      return { full: r.full, total: r.total, before: r.before, done: r.done, seek: P.seek, uniq: Array.from(new Set(P.seekTimes)).length };
    });
    if (!z2.done) throw new Error('缩回去之后 6 秒还没填满：' + JSON.stringify(z2));
    if (!(z2.full <= REFILL_MS)) throw new Error('缩回去后重填 ' + z2.full.toFixed(0) + 'ms，超过 ' + REFILL_MS + 'ms');
    if (z2.seek !== 0) throw new Error('整排都在缓存里，缩回去还解码了 ' + z2.seek + ' 次（单次重画解码次数应为 0）');

    /* P5：等这批帧真的落进 IndexedDB（写入是后台事，不等它），再刷新同一工程看二次打开。 */
    await page.waitFor(async () => {
      const row = document.querySelector('.tl-vrow');
      const frs = row && row.querySelector('[data-frs]');
      if (!frs || !window.Kv || !window.Wb || !window.Wb.thumbs) return false;
      const key = window.Wb.thumbs.keyOf(frs.getAttribute('data-frs'));
      const rec = await window.Kv.at('slices').get(key);
      return !!(rec && Array.isArray(rec.frames) && rec.frames.length >= 20);
    }, 15000, 200).catch(() => {});
    const cached = await page.eval(async () => {
      const row = document.querySelector('.tl-vrow');
      const frs = row && row.querySelector('[data-frs]');
      if (!frs) return { err: '轨道上没有 [data-frs]' };
      const key = window.Wb.thumbs.keyOf(frs.getAttribute('data-frs'));
      const rec = await window.Kv.at('slices').get(key);
      return { key, n: rec && Array.isArray(rec.frames) ? rec.frames.length : 0 };
    });
    if (cached.err) throw new Error(cached.err);
    if (!(cached.n >= 20)) throw new Error('首开后 IndexedDB 里只有 ' + cached.n + ' 张切片（应 ≥20），二次打开必然重解');
    await page.eval(() => { try { if (window.__spaFlush) window.__spaFlush(); } catch (e) {} return true; });
    await h.sleep(1300);                       // scheduleSave 的 500ms 防抖 + IndexedDB 写入

    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
    }, 15000, 200).catch(() => { throw new Error('刷新后工作区里没有已出片的候选（工程没恢复）'); });
    const restoreOff = await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && t.classList.contains('active')) { t.click(); return true; }
      return false;
    });
    if (restoreOff) await h.sleep(200);       // 剪辑态被恢复的话先关掉，从一个没有轨道的界面重新量
    await page.waitFor(() => {
      const pl = document.getElementById('player');
      return !!(pl && pl.readyState >= 2);
    }, 20000, 100).catch(() => {});           // 恢复出来的预览读不到首帧也不影响这一档（只量缓存贴图）
    const rearmed = await page.eval(() => {
      const V = window.Wb && window.Wb.vframe;
      if (!V) return { err: '刷新后页面没有 Wb.vframe' };
      const o = { meta: 0, seek: 0, seekTimes: [], els: 0, release: 0, trace: [] };
      window.__sp = o;
      const T = k => { if (o.trace.length < 60) o.trace.push(k + '=' + Math.round(performance.now())); };
      const om = V.meta.bind(V), os = V.seek.bind(V), oe = V.el.bind(V), orl = V.release.bind(V);
      /* 每块解码都会问一次 meta，但只有 readyState 还没到 1 的那次才真的在读元数据：
         P1 数的是「解析了几次」，不是「问了几次」。 */
      V.meta = function (v) { if (v.readyState < 1) { o.meta++; T('meta0'); const p = om(v); p.then(() => T('meta1'), () => T('metaX')); return p; } return om(v); };
      V.seek = function (v, t) { o.seek++; o.seekTimes.push(Number(t)); T('seek' + t); return os(v, t); };
      V.el = function (src) { o.els++; T('el'); return oe(src); };
      V.release = function (v) { o.release++; T('rel'); return orl(v); };
      return { ok: true };
    });
    if (rearmed.err) throw new Error(rearmed.err);
    const secondStart = await page.eval(() => {
      const P = window.__sp;
      const t0 = performance.now();
      const run = { t0: t0, first: 0, full: 0, total: 0, done: false };
      window.__spRun2 = run;
      const read = () => {
        const row = document.querySelector('.tl-vrow');
        const tiles = row ? Array.prototype.slice.call(row.querySelectorAll('i.fr')) : [];
        const filled = tiles.filter(x => x.style.backgroundImage).length;
        run.total = tiles.length;
        if (!run.first && filled > 0) run.first = performance.now() - t0;
        if (!run.done && tiles.length > 0 && filled >= tiles.length) { run.done = true; run.full = performance.now() - t0; }
      };
      run.timer = setInterval(read, 16);
      read();
      const t = document.getElementById('trimBtn');
      if (!t) return { err: '刷新后没有 #trimBtn' };
      if (!t.classList.contains('active')) t.click();
      return { ok: true };
    });
    if (secondStart.err) throw new Error(secondStart.err);
    await page.waitFor(() => window.__spRun2 && window.__spRun2.done, 15000, 100).catch(() => {});
    const second = await page.eval(() => {
      const r = window.__spRun2, P = window.__sp;
      clearInterval(r.timer);
      return { first: r.first, full: r.full, total: r.total, done: r.done,
        meta: P.meta, seek: P.seek, uniq: Array.from(new Set(P.seekTimes)).length, els: P.els };
    });
    if (!second.done) throw new Error('二次打开 15 秒还没填满切片：' + JSON.stringify(second));
    if (!(second.total >= 20)) throw new Error('二次打开只画出 ' + second.total + ' 格（工程恢复后比例尺变了？）');
    if (!(second.first > 0 && second.first <= FIRST_MS)) throw new Error('二次打开首格 ' + second.first.toFixed(0) + 'ms，超过 ' + FIRST_MS + 'ms');
    if (!(second.full <= ROW_MS)) throw new Error('二次打开整排 ' + second.total + ' 格用了 ' + second.full.toFixed(0) + 'ms，超过 ' + ROW_MS + 'ms');
    if (second.seek !== 0 || second.meta !== 0 || second.els !== 0) {
      throw new Error('二次打开仍在解码（P5 要求 0 次）：seek=' + second.seek + ' meta=' + second.meta + ' video=' + second.els
        + '（IndexedDB 里有 ' + cached.n + ' 张，key=' + cached.key + '）');
    }

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理日志异常：' + faults.join(' | '));
    /* 批次 0 的切片基线：三个预算就是「P1 之前的实测 × 0.6」，这里把落地后的实测量回去，
       后面要收紧阈值时先看这份数字，不凭印象调。跑法：PERF_WRITE=1 node tests/e2e/director-slice-perf.cjs */
    if (process.env.PERF_WRITE) {
      const FIX = path.join(__dirname, '../fixtures/perf-baseline.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(FIX, 'utf8')); } catch (e) { /* 第一次写：没有旧基线 */ }
      cur.slice = {
        firstMs: Math.round(first.first),
        rowMs: Math.round(first.full),
        refillMs: Math.round(z1.full),
        refillBackMs: Math.round(z2.full),
        firstRowDecodes: first.seek,
        decodesAfterRefill: z2.seek,
        zoomHitRate: Math.round(hit1 * 1000) / 1000,
        secondOpenDecodes: second.seek,
        firstRowTiles: first.total,
        videos: first.els,
        workerPosts: first.posts,
        workerReplies: first.replies,
        budgets: { firstMs: FIRST_MS, rowMs: ROW_MS, refillMs: REFILL_MS, hitRate: HIT,
          why: 'P1 之前的实测 × 0.6（批次 0），收紧前先看这里的实测值' },
        measuredAt: new Date().toISOString(),
      };
      fs.writeFileSync(FIX, JSON.stringify(cur, null, 2) + '\n');
      console.log('  已写切片基线：' + FIX);
    }
    console.log('✓ 切片性能通过（首格 ' + first.first.toFixed(0) + 'ms / ' + first.total + ' 格 ' + first.full.toFixed(0)
      + 'ms / 缩放重填 ' + z1.full.toFixed(0) + 'ms、' + z2.full.toFixed(0) + 'ms / 首排解码 ' + first.seek
      + ' 次、一只 video / 缩放命中 ' + (hit1 * 100).toFixed(0) + '% / 整排重画 0 次解码 / 二次打开 0 次解码（'
      + cached.n + ' 张来自 IndexedDB）/ worker 收发 ' + first.posts + ':' + first.replies + '）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
})();
