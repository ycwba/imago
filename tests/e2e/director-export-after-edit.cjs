#!/usr/bin/env node
/* 「剪辑后导出成片要用新剪的那一版」判据（用户点名：剪辑视频后导出成片还是导出原来成品）。
   链路：种子 2 段画面 → 导出一次（真合成，读回执时长）→ 进剪辑态把第二段右缘裁短
   （真实拖把手手势）→ 断言 film.clips 的源窗口已变 → 再导出断言回执时长变短
   （旧缓存未命中、按新剪重新合成）→ 原样再导一次断言快捷命中（「这一轮刚合成的那份」）。
   素材用真字节（tests/fixtures/media/probe-clip.mp4 经 /local-assets 入探针账）。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    const srcId = (await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-src.mp4', data: fs.readFileSync(h.clipFixture()).toString('base64'),
        format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }),
    })).json()).id;
    if (!srcId) throw new Error('探针素材没建出来');
    const src = '/asset/' + srcId;
    const clip = (id, shotId, dur, ss) => ({ id, kind: 'video', shotId, candId: 'v_' + shotId, name: '镜头',
      src, sourceStart: ss, sourceDuration: dur, mediaDuration: 2, duration: dur, ln: 0, volume: 1, muted: false });
    const shot = (id, name) => ({ id, name, prompt: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      line: '', note: '', selId: 'v_' + id, candidates: [
        { vid: 'v_' + id, provider: 'local', status: 'succeeded', progress: 100, url: src, local: true, duration: 2, shotId: id },
      ] });
    const project = { id: 'pr_exp', name: '导出探针', rev: 0,
      scenes: [{ id: 'sc_1', name: '场景 1', shots: [shot('sh1', '镜头一'), shot('sh2', '镜头二')] }],
      film: { clips: [clip('c1', 'sh1', 1.5, 0), clip('c2', 'sh2', 2, 0)],
        voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } };
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: { projects: [project], curId: 'pr_exp', roles: [] } }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);

    const opText = () => page.eval(() => String(document.getElementById('opState') ? document.getElementById('opState').textContent : ''));
    const exportFilm = async () => {
      const btn = await page.eval(() => {
        const b = document.getElementById('exportFilm');
        if (b) b.click();
        return !!b;
      });
      if (!btn) throw new Error('页头上没有「导出成片」按钮');
      /* 合成期间按钮变成「取消…」；完成的标志：回执出现 ✓ / 报错出现在 #opState */
      const until = Date.now() + 90000;
      let last = '';
      while (Date.now() < until) {
        await sleep(400);
        last = await opText();
        if (/✓|导出失败|导出停下|没有可用素材/.test(last)) return last;
      }
      throw new Error('导出 90 秒没完成（最后状态：' + last + '）');
    };

    /* ① 第一次导出：1.5 + 2 = 3.5 秒 */
    const t1 = await exportFilm();
    const durOf = txt => { const m = /(\d+(?:\.\d+)?) 秒/.exec(txt); return m ? Number(m[1]) : null; };
    const d1 = durOf(t1);
    if (!(d1 > 0)) throw new Error('第一次导出回执没有时长：' + t1);

    /* ② 进剪辑态，把第二段右缘裁短 ~1 秒（真实拖把手） */
    await page.waitFor(() => {
      const b = document.getElementById('trimBtn');
      if (b && !b.classList.contains('on')) b.click();
      return !!document.querySelector('#tlBoard .tl-clip[data-dur="2"]');
    }, 20000, 150);
    await sleep(400);
    /* 拖第二段的 end 把手：块宽/时长 = pps；左移 1 秒的像素 */
    await page.eval(() => {
      const d = document;
      const blocks = Array.prototype.slice.call(d.querySelectorAll('#tlBoard .tl-clip'));
      const b2 = blocks.find(x => Math.abs(Number(x.getAttribute('data-dur')) - 2) < 0.01);
      if (!b2) throw new Error('找不到第二段');
      const hnd = b2.querySelector('.tl-h[data-handle="end"]');
      if (!hnd) throw new Error('第二段没有 end 把手');
      const pps = parseFloat(b2.style.width) / Number(b2.getAttribute('data-dur'));
      const r = hnd.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      fire(hnd, 'pointerdown', x0, y0);
      fire(window, 'pointermove', x0 - pps * 0.5, y0);
      fire(window, 'pointermove', x0 - pps * 1.0, y0);
      fire(window, 'pointerup', x0 - pps * 1.0, y0);
    });
    await sleep(600);
    const c2 = await page.eval(() => {
      const D = window.WBBridge.get('director');
      /* 成片那一份在 proj.film.clips：从 DOM 反查最稳 —— 第二段的 data-dur 应变成 ~1 */
      const b2 = Array.prototype.slice.call(document.querySelectorAll('#tlBoard .tl-clip'))
        .find(x => x.getAttribute('data-clip') !== document.querySelector('#tlBoard .tl-clip').getAttribute('data-clip'));
      return { domDur: b2 ? Number(b2.getAttribute('data-dur')) : null };
    });
    if (!(c2.domDur > 0.5 && c2.domDur < 1.5)) {
      throw new Error('剪辑 commit 后第二段时长没变（data-dur=' + c2.domDur + '）—— 裁边没落进成片');
    }

    /* ③ 第二次导出：时长必须变短（旧缓存未命中，按新剪合成） */
    const t2 = await exportFilm();
    const d2 = durOf(t2);
    if (!(d2 > 0 && d2 < d1 - 0.4)) {
      throw new Error('剪辑后导出的时长没变（第一次 ' + d1 + ' 秒、第二次 ' + d2 + ' 秒）——导出的还是旧成品');
    }

    /* ④ 原样再导一次：快捷缓存命中（不再花一遍合成） */
    const t3 = await exportFilm();
    if (!/这一轮刚合成的那份/.test(t3)) throw new Error('同内容再导没有命中快捷缓存：' + t3);

    console.log('director-export-after-edit: 剪辑后按新剪合成 ✓（' + d1 + 's → ' + d2 + 's）同内容快捷命中 ✓');
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
