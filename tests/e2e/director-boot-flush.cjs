#!/usr/bin/env node
/* 导演台「装配窗口里的关标签保存」判据。
   boot() 把读回来的工作区挂到界面上之前，有一个网络往返的窗口（`await DataSync.workspaceFromServer`）。
   以前在这个窗口里跑 `__spaFlush`（关标签 / 刷新 / `__spaReload` 走的就是它）会照 WS 的**空默认值**
   写一份「一个工程都没有」的工作区 —— 同时盖掉 IndexedDB 与 `.data/workspace.json`，
   用户那份真工作区就地消失。现在两份落盘都先问 `wsLoaded`：没装配完一个字节都不许写。
   探针做法：把 `/data` 清单那一次 GET 拖慢，把窗口拉宽到 2 秒以上，好精确复现那一次 flush。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  const project = {
    id: 'p-bootflush', name: '装配窗口探针', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [{
      id: 'sh1', name: '镜头 A', prompt: 'A 的画面', line: '', lineWho: '',
      ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      refImages: [], keyframes: [], candidates: [], selId: null,
    }] }],
  };
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    /* 只拖慢「数据目录清单」那一次 GET：写 `/data/<key>` 与别的接口都不受影响的相对地址。 */
    await page.addInitScript(() => {
      const raw = window.fetch;
      window.fetch = function (u, o) {
        const p = raw.call(this, u, o);
        try {
          const s = String(u).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
          if (s === '/data') return new Promise(res => setTimeout(() => res(p), 2500));
        } catch (e) {}
        return p;
      };
    });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => !!window.Kv, 20000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: project.id, roles: [], groups: [], ts: Date.now() });

    /* 等到引擎把 `__spaFlush` 挂上（模块体跑完）；首屏此时还没渲染 —— 就是那个窗口。 */
    await page.waitFor(() => typeof window.__spaFlush === 'function', 25000);
    const notRendered = await page.eval(() => !document.querySelector('.shot-item'));
    must(notRendered, '窗口没抓住：拖慢 /data 之后首屏仍然先渲染出来了，这条判据管不住东西');

    /* 就在窗口里关标签：这一次 flush 不许把空工作区落下去 */
    await page.eval(() => window.__spaFlush());
    const afterFlush = await page.eval(async () => {
      const ws = await window.Kv.at('ws').get('workspace');
      return {
        ids: ((ws && ws.projects) || []).map(p => p.id),
        unload: !!window.LS.json('dir_ws_unload', null),
      };
    });
    must(afterFlush.ids.includes('p-bootflush'),
      '装配窗口里的 flush 把工作区盖掉了（IndexedDB 现在的项目：' + JSON.stringify(afterFlush.ids) + '）');
    must(!afterFlush.unload, '没装配完也写了 dir_ws_unload 救生包（那份空值会被下一次启动当成更新的）');

    /* 装配完成后种子工程要照常渲染出来；再真改一笔（改片名走页面自己的 oninput）让保存确实发生一次：
       落盘的两份都必须是带着那个工程的那一份。 */
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 25000);
    await page.eval(() => {
      const el = document.getElementById('projName');
      el.value = '装配窗口探针（改过）';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saved = await page.eval(() => new Promise(res => {
      const t0 = Date.now();
      const tick = async () => {
        const ws = await window.Kv.at('ws').get('workspace');
        const ps = (ws && ws.projects) || [];
        const ids = ps.map(p => p.id);
        if (ps.length && String(ps[0].name || '').indexOf('改过') >= 0) return res({ ids, err: '' });
        if (Date.now() - t0 > 12000) return res({ ids, err: '等一次真保存超时：现在的项目是 ' + JSON.stringify(ids) });
        setTimeout(tick, 200);
      };
      tick();
    }));
    must(!saved.err, saved.err);
    must(saved.ids.includes('p-bootflush'), '真保存之后 IndexedDB 里的种子工程不见了：' + JSON.stringify(saved.ids));

    const file = path.join(proxy.dataDir, 'workspace.json');
    let mirror = null;
    for (let i = 0; i < 70 && !mirror; i++) {
      if (fs.existsSync(file)) {
        try { mirror = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { await h.sleep(200); }
      } else await h.sleep(200);
    }
    must(!!mirror, '改过一笔之后 .data/workspace.json 一直没落盘（镜像那一条路断了）');
    const mp = (mirror.data && mirror.data.projects) || [];
    must(mp.length > 0 && mp.some(p => p && p.id === 'p-bootflush'),
      '.data/workspace.json 不是带着种子工程的那一份：' + JSON.stringify(mp.map(p => p && p.id)));

    const faults = h.logFaults(proxy.log);
    must(!faults.length, '代理日志里有请求处理异常：' + faults.join(' | '));
    console.log('✓ 装配窗口里的关标签保存不空盖工作区（IndexedDB 与 .data 两份都守住）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxy) { try { proxy.stop(); } catch (e) {} }
  }
})();
