#!/usr/bin/env node
/* 真机截图：设置页「账户与密钥」那一张卡（现状）。
   用法：node design/provider-matrix/shot-real.cjs */
'use strict';
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const outDir = path.join(__dirname, 'shots-real');

(async () => {
  const proxy = await h.startProxy();
  const b = await h.launchBrowser();
  try {
    const p = await b.newPage();
    await p.setSize(1440, 1000);
    await p.goto(proxy.base + '/shell.html#settings.html');
    await p.waitFor(() => {
      const e = document.querySelector('.settings-page');
      return !!e && !!e.querySelector('.acct-grid') && e.querySelectorAll('.acct').length > 0;
    }, 30000);
    await h.sleep(2500);
    await p.screenshot(path.join(outDir, '01-accounts.png'));
    console.log('① 账户卡已截');

    /* ② 展开第一家的密钥 */
    await p.eval(() => {
      const t = document.querySelector('[data-ktoggle]');
      if (t) t.click();
    });
    await h.sleep(600);
    await p.screenshot(path.join(outDir, '02-key-open.png'));
    console.log('② 密钥展开已截');

    /* ③ 展开第一档的型号清单 */
    await p.eval(() => {
      const t = document.querySelector('[data-panel]');
      if (t) t.click();
    });
    await h.sleep(900);
    await p.screenshot(path.join(outDir, '03-model-panel.png'));
    console.log('③ 型号清单已截');

    const info = await p.eval(() => ({
      accounts: document.querySelectorAll('.acct').length,
      addTile: document.querySelectorAll('.add-tile').length,
      rows: document.querySelectorAll('.crow').length,
      capStripCells: document.querySelectorAll('.capcell').length,
      keyRows: document.querySelectorAll('.keyrow').length,
      panels: document.querySelectorAll('.mpanel').length,
      passked: !!(document.querySelector('.acct-park #asrCard') || document.querySelector('.acct-park #searchCard')),
      /* 语音识别 / 联网搜索那两块表单现在住在哪张卡里（不在卡里就是 0） */
      asrInCard: !!document.querySelector('.acct #asrCard'),
      searchInCard: !!document.querySelector('.acct #searchCard'),
      asrCardOwner: (() => {
        const el = document.querySelector('.acct #asrCard');
        const acct = el && el.closest('.acct');
        return acct ? acct.dataset.acct : '';
      })(),
      extraBlock: !!document.querySelector('.acct-extra'),
    }));
    console.log(JSON.stringify(info));

    /* ④ 自定义供应商：同一张「添加供应商」卡变成「添加自定义供应商」，字段就在卡里 */
    await p.eval(() => {
      const t = document.querySelector('[data-cus-open]');
      if (t) t.click();
    });
    await h.sleep(900);
    await p.eval(() => {
      const el = document.querySelector('.add-tile');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await h.sleep(400);
    await p.screenshot(path.join(outDir, '05-custom-in-card.png'));
    console.log('④ 自定义供应商（在卡里）已截');
    const cus = await p.eval(() => {
      const t = document.querySelector('.add-tile');
      return {
        title: (t.querySelector('.fcard-t') || {}).textContent || '',
        hasOldHead: !!document.querySelector('.cus-h, .cus-t'),
        backBtn: !!t.querySelector('[data-cus-close]'),
        rows: t.querySelectorAll('.cus-form .krow').length,
        slotFilled: !!t.querySelector('[data-formslot="cus"] .cus-form'),
      };
    });
    console.log('自定义卡：' + JSON.stringify(cus));
    await p.eval(() => { const t = document.querySelector('[data-cus-close]'); if (t) t.click(); });
    await h.sleep(600);
    const back = await p.eval(() => {
      const t = document.querySelector('.add-tile');
      return { title: (t.querySelector('.fcard-t') || {}).textContent || '', presets: t.querySelectorAll('.preset').length };
    });
    console.log('返回预设：' + JSON.stringify(back));
    console.log('报错：' + (p.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
  } finally {
    await b.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
