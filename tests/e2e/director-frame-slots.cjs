#!/usr/bin/env node
/* 右栏首帧 / 尾帧的 × 必须真的清掉**当前候选**上的显式帧。
   回归：删除处理器以前写 `sh[kk] = null`，而首尾帧住在候选配置里（`cfg(sh)`），
   点完界面重画图还在，看起来就是「删不掉」。
   种子：一镜一条候选，firstFrame / lastFrame 都是 dataURL。
   必须成立：
     ① 首帧 / 尾帧两张瓦片与各自的 × 都画出来了；
     ② 点 × 之后图、×、data-view 标记都消失；
     ③ 落盘的候选配置里 firstFrame / lastFrame 都是 null（不是还挂在镜头对象上）。
   判据只走用户看得见的那一面：DOM 点 × + /data/workspace 读回。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const wsOf = () => ({ projects: [{ id: 'pr_fr', name: '首尾帧探针', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: '场景 1', shots: [{ id: 'sh1', name: '镜头一', draw: 1, line: '', lineWho: '',
    note: '', selId: null, candidates: [{ vid: 'tk_sh1', shotId: 'sh1', created: Date.now(),
      prompt: '镜一画面', origin: 'auto', status: 'draft', progress: 0, url: null, error: null,
      selected: false, locked: false, trimS: null, trimE: null, provider: '', priceText: '',
      priceMicros: null, duration: null, model: '', modelAuto: '', tier: '', res: '', ar: '', size: '',
      dur: '', refImages: [], refMeta: [], refVideo: null, refAudio: null, keyframes: [], combo: '',
      firstFrame: PNG, lastFrame: PNG, linkPrev: '' }] }] }],
  film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_fr', roles: [], ts: Date.now() });

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.clearStorage(new URL(proxy.base).origin);
    await page.skipDataSyncBoot();
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: wsOf() }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);

    /* ① 两张瓦片与 × 都在。 */
    await page.waitFor(() => document.querySelector('#edCol [data-k="firstFrame"]')
      && document.querySelector('#edCol [data-k="lastFrame"]'), 15000, 100);
    const tiles = await page.eval(() => document.querySelectorAll('#edCol [data-view="first"], #edCol [data-view="last"]').length);
    if (tiles !== 2) throw new Error('首帧 / 尾帧瓦片没有都画出来：' + tiles + ' 张');

    /* ② 首帧 ×：图与 × 当场消失（重画后不能再冒出来）。 */
    await page.eval(() => document.querySelector('#edCol [data-k="firstFrame"]').click());
    await page.waitFor(() => !document.querySelector('#edCol [data-k="firstFrame"]')
      && !document.querySelector('#edCol [data-view="first"]'), 8000, 100);
    /* 尾帧 × 同理。 */
    await page.eval(() => document.querySelector('#edCol [data-k="lastFrame"]').click());
    await page.waitFor(() => !document.querySelector('#edCol [data-k="lastFrame"]')
      && !document.querySelector('#edCol [data-view="last"]'), 8000, 100);

    /* ③ 落盘的候选配置里两帧都清成 null。 */
    let cand = null;
    for (let t = 0; t < 40; t++) {
      const r = await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } });
      const j = await r.json();
      cand = j && j.data && j.data.projects && j.data.projects[0]
        && j.data.projects[0].scenes[0].shots[0].candidates[0];
      if (cand && cand.firstFrame == null && cand.lastFrame == null) break;
      await sleep(250);
    }
    if (!cand) throw new Error('读不回工作区里的候选');
    if (cand.firstFrame != null || cand.lastFrame != null) {
      throw new Error('首尾帧没有真的清掉：firstFrame=' + String(cand.firstFrame)
        + ' lastFrame=' + String(cand.lastFrame));
    }

    console.log('✓ 右栏首尾帧：× 清掉候选上的显式帧，界面与落盘都不再保留');
  } catch (e) {
    if (page && page.errors && page.errors.length) console.error('页面错误：\n' + page.errors.join('\n'));
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxy) await proxy.stop().catch(() => {});
  }
})().catch(e => { console.error('✗ ' + (e && e.message || e)); process.exit(1); });
