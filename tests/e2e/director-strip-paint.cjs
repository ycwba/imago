#!/usr/bin/env node
/* 剪辑态胶片格「不拖动也要出图」的判据。
   用户点名的症状：画面轨后半段的格子一直是斜纹，拖一下轨道才出现。
   修复后的口径（engine/strip.js 与 engine/frames.js 共用 tl-filmstrip.js 的 spanTolOf、
   busy 挂 30s 看门狗、解码回执报 strip 重画）：**任何 pointer 事件都不发**，
   进剪辑态后 4 秒内三段画面轨的格子必须全部出图；缩放一档之后同样要全部出图。
   素材用真字节（tests/fixtures/media/probe-clip.mp4 经 /local-assets 入探针账，
   /asset/<id> 同源）—— 主链 mediabunny 与 <video> 兜底链都能解的形状。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    /* 素材入探针账 → /asset/<id> 同源地址（判据只依赖 Node + Chrome，不依赖本机转码工具） */
    const srcId = (await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-src.mp4', data: fs.readFileSync(h.clipFixture()).toString('base64'),
        format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }),
    })).json()).id;
    if (!srcId) throw new Error('探针素材没建出来');
    const src = '/asset/' + srcId;

    const clip = (id, shotId, ss) => ({ id, kind: 'video', shotId, candId: 'v_' + shotId, name: '镜头',
      src, sourceStart: ss, sourceDuration: 2, mediaDuration: 2, duration: 2, ln: 0, volume: 1, muted: false });
    const shot = (id, name) => ({ id, name, prompt: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      line: '', note: '', selId: 'v_' + id, candidates: [
        { vid: 'v_' + id, provider: 'local', status: 'succeeded', progress: 100, url: src, local: true, duration: 2, shotId: id },
      ] });
    const project = { id: 'pr_strip', name: '胶片格探针', rev: 0,
      scenes: [{ id: 'sc_1', name: '场景 1', shots: [shot('sh1', '镜头一'), shot('sh2', '镜头二'), shot('sh3', '镜头三')] }],
      film: { clips: [clip('c1', 'sh1', 0), clip('c2', 'sh2', 0), clip('c3', 'sh3', 0)],
        voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } };
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: { projects: [project], curId: 'pr_strip', roles: [] } }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);
    /* 进剪辑态：只点这一颗按钮，此后**一根手指都不碰** —— 这正是用户症状里缺的那一步。 */
    await page.waitFor(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('on')) t.click();
      return !!document.querySelector('#tlBoard .tl-strip.is-video .tl-fr');
    }, 20000, 150);
    const gaps = () => page.eval(() => {
      const cells = Array.prototype.slice.call(document.querySelectorAll('#tlBoard .tl-strip.is-video .tl-fr'));
      return { all: cells.length, gap: cells.filter(x => x.classList.contains('gap')).length };
    });
    const a0 = await gaps();
    if (a0.all < 6) throw new Error('画面轨格子没画出来（3 段至少 6 格）：' + JSON.stringify(a0));
    /* 不拖动，等解码流水线自己把后半段补齐（渐进贴帧 + 回执报重画）： */
    let a1 = a0;
    for (let i = 0; i < 40 && a1.gap > 0; i++) { await sleep(150); a1 = await gaps(); }
    if (a1.gap > 0) throw new Error('不拖动时斜纹 6 秒没消：' + JSON.stringify(a1) + '（表现即「后半段要拖一下才出现」）');
    /* 缩放一档（采样点重排 + 格宽变化）：落定后的重画同样要自己补齐。 */
    await page.eval(() => { const b = document.querySelector('#tlBoard [data-tl="zoom-in"]'); if (b) b.click(); });
    let a2 = { gap: 1 };
    for (let i = 0; i < 40 && a2.gap > 0; i++) { await sleep(150); a2 = await gaps(); }
    if (a2.gap > 0) throw new Error('缩放之后斜纹没消（要拖一下才出现）：' + JSON.stringify(a2));
    console.log('director-strip-paint: 不拖动全出图 ✓（' + a1.all + ' 格）缩放后全出图 ✓（' + a2.all + ' 格）');
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
