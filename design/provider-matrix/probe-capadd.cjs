#!/usr/bin/env node
/* 探针：手动加一档能力（真机）。只用来看行为，不写盘（用的是隔离探针目录）。 */
'use strict';
const h = require('../../tests/e2e/harness.cjs');

(async () => {
  const proxy = await h.startProxy();
  const b = await h.launchBrowser();
  try {
    const p = await b.newPage();
    await p.setSize(1440, 1000);
    await p.goto(proxy.base + '/shell.html#settings.html');
    await p.waitFor(() => !!document.querySelector('.acct-grid'), 30000);
    await h.sleep(2000);

    const before = await p.eval(() => {
      const c = document.querySelector('.acct');
      return { kid: c && c.dataset.acct, caps: [...c.querySelectorAll('.capcell')].map(x => x.textContent) };
    });
    console.log('加之前：', JSON.stringify(before));

    /* ① 点「手动加一档能力」→ 出现可选档位 */
    await p.eval(() => {
      const t = document.querySelector('[data-cap-pick]');
      if (t) t.click();
    });
    await h.sleep(500);
    const chips = await p.eval(() => [...document.querySelectorAll('[data-cap-add]')].map(x => x.dataset.cap + ':' + x.textContent.trim()));
    console.log('可选档位：', JSON.stringify(chips));

    /* ② 加一档「语音合成」进来（SparkCine 没有这一档） */
    await p.eval(() => {
      const t = document.querySelector('[data-cap-add][data-cap="audio"]');
      if (t) t.click();
    });
    await h.sleep(900);
    const after = await p.eval(() => {
      const c = document.querySelector('.acct');
      const row = c.querySelector('[data-crow$=":image"], [data-crow*=":image"]');
      const panel = c.querySelector('.mpanel');
      return {
        caps: [...c.querySelectorAll('.capcell')].map(x => x.textContent),
        hasManual: !!c.querySelector('.manual'),
        note: (c.querySelector('.manual-note') || {}).textContent || '',
        rowText: row ? row.textContent.replace(/\s+/g, ' ').trim() : '',
        panelOpen: !!panel,
        fetchBtn: panel ? !!panel.querySelector('[data-tfetch]') : null,
        hasTypedInput: panel ? !!panel.querySelector('[data-tmnew]') : null,
        stored: localStorage.getItem('sk_caps_' + c.dataset.acct),
      };
    });
    console.log('加之后：', JSON.stringify(after, null, 1));

    /* ③ 自己填一个型号 id */
    await p.eval(() => {
      const inp = document.querySelector('[data-tmnew]');
      if (!inp) return;
      inp.value = 'flux-pro-1.1';
      const btn = inp.parentNode.querySelector('[data-tadd]');
      if (btn) btn.click();
    });
    await h.sleep(900);
    const typed = await p.eval(() => {
      const c = document.querySelector('.acct');
      const ids = [...c.querySelectorAll('.mlist-row code')].map(x => x.textContent);
      const counts = [...c.querySelectorAll('.crow[data-crow]')].map(r => {
        const b = r.querySelector('[data-mcount]');
        return r.dataset.crow + ' → ' + (b ? b.textContent : '（无计数）');
      });
      return { ids, counts };
    });
    console.log('自己填之后：', JSON.stringify(typed, null, 1));

    /* ④ 撤掉这一档 */
    await p.eval(() => {
      const t = document.querySelector('[data-cap-rm]');
      if (t) t.click();
    });
    await h.sleep(800);
    const removed = await p.eval(() => {
      const c = document.querySelector('.acct');
      return { caps: [...c.querySelectorAll('.capcell')].map(x => x.textContent), stored: localStorage.getItem('sk_caps_' + c.dataset.acct) };
    });
    console.log('撤掉之后：', JSON.stringify(removed));

    console.log('报错：' + (p.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await b.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
