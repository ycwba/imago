#!/usr/bin/env node
/* 探针：手动加「联网搜索」这一档之后，能不能真的让它顶着（单选档的语义走通）。
   只看行为；设置写进隔离探针目录的 .data/search.json。 */
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

    /* SparkCine 没有「搜」这一档 → 手动加进来 */
    await p.eval(() => { const t = document.querySelector('[data-cap-pick]'); if (t) t.click(); });
    await h.sleep(400);
    await p.eval(() => { const t = document.querySelector('[data-cap-add][data-cap="search"]'); if (t) t.click(); });
    await h.sleep(900);
    const added = await p.eval(() => {
      const c = document.querySelector('.acct');
      const r = c.querySelector('[data-crow="sparkcine:search"]');
      return { row: r ? r.textContent.replace(/\s+/g, ' ').trim() : '(没有这一行)', manual: !!c.querySelector('.manual') };
    });
    console.log('加完：', JSON.stringify(added));

    /* 点这一档的状态牌 → 这家上位 */
    await p.eval(() => {
      const c = document.querySelector('.acct');
      const r = c.querySelector('[data-crow="sparkcine:search"]');
      const t = r && r.querySelector('[data-cap-toggle]');
      if (t) t.click();
    });
    await h.sleep(1200);
    const after = await p.eval(() => {
      const c = document.querySelector('.acct');
      const r = c.querySelector('[data-crow="sparkcine:search"]');
      return {
        plate: r ? r.querySelector('.st').textContent : '',
        hasForm: !!c.querySelector('[data-formslot="search"] .incard, [data-formslot="search"]'),
        slotText: (c.querySelector('[data-formslot]') || {}).innerText ? 'form-in-card' : '',
      };
    });
    console.log('点成主位：', JSON.stringify(after));
    const saved = await (await fetch(proxy.base + '/search/settings', { headers: { cookie: proxy.cookie } })).json();
    console.log('服务端 search.json：', JSON.stringify({ provider: saved.provider, channelId: saved.channelId, enabled: saved.enabled, credentialSource: saved.credentialSource }));
    console.log('报错：' + (p.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await b.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
