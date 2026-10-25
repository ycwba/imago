#!/usr/bin/env node
/* 把真机设置页每一张卡的文字内容导成一份 JSON（给设计稿当底稿用）。
   用法：node design/settings-layout/dump-cards.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;

(async () => {
  const proxy = await h.startProxy();
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('dir_theme', 'light'); } catch (e) {} });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => {
      const el = document.querySelector('.settings-page');
      return !!el && el.innerText.length > 120;
    }, 20000);
    await h.sleep(1500);
    /* 把低频那一组展开，不然那三张卡量不到 */
    await page.eval(() => {
      document.querySelectorAll('.settings-page .set-group.foldable').forEach(g => g.classList.add('open'));
    });
    await h.sleep(400);

    const dump = await page.eval(() => {
      const groups = [];
      document.querySelectorAll('.settings-page .set-group').forEach(g => {
        const gh = g.querySelector('.set-group-h');
        const cards = [];
        g.querySelectorAll('.card').forEach(c => {
          const h2 = c.querySelector('.card-h');
          const rows = [];
          c.querySelectorAll('.krow').forEach(r => {
            const label = r.querySelector('.kn, .lab');
            rows.push({
              label: label ? label.innerText.trim().replace(/\s+/g, ' ') : '',
              text: r.innerText.trim().replace(/\s+/g, ' ')
            });
          });
          cards.push({
            title: (h2 ? h2.innerText : '').trim().replace(/\s+/g, ' '),
            sub: (c.querySelector('.sub') || { innerText: '' }).innerText.trim().replace(/\s+/g, ' '),
            rows: rows,
            buttons: Array.from(c.querySelectorAll('button')).map(b => b.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean)
          });
        });
        groups.push({ key: g.dataset.group || '', title: (gh ? gh.innerText : '').trim().replace(/\s+/g, ' '), cards: cards });
      });
      const nav = {
        sum: (document.querySelector('.set-nav-sum') || { innerText: '' }).innerText.trim(),
        chips: Array.from(document.querySelectorAll('.set-nav-chips:not(.set-nav-sub) .chip, .set-nav-chips:not(.set-nav-sub) button')).map(e => e.innerText.trim()),
        subChips: Array.from(document.querySelectorAll('.set-nav-sub .chip, .set-nav-sub button')).map(e => e.innerText.trim())
      };
      return { groups: groups, nav: nav };
    });

    fs.writeFileSync(path.join(here, 'cards.json'), JSON.stringify(dump, null, 2), 'utf8');
    console.log('已写出 cards.json：' + dump.groups.length + ' 组 / ' +
      dump.groups.reduce((n, g) => n + g.cards.length, 0) + ' 张卡');
  } finally {
    await browser.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
