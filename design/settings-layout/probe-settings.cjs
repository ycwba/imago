#!/usr/bin/env node
/* 真机探针：设置页改版后的行为自检（目录轨 / 连续文档 / 滚动定位）。
   用法：node design/settings-layout/probe-settings.cjs */
'use strict';
const h = require('../../tests/e2e/harness.cjs');

(async () => {
  const proxy = await h.startProxy();
  const b = await h.launchBrowser();
  const out = [];
  const ok = (name, pass, detail) => {
    out.push((pass ? '✓ ' : '✗ ') + name + (detail ? '　' + detail : ''));
    return pass;
  };
  try {
    const p = await b.newPage();
    await p.setSize(1440, 900);
    await p.goto(proxy.base + '/shell.html#settings.html');
    await p.waitFor(() => {
      const e = document.querySelector('.settings-page');
      return !!e && e.innerText.length > 200;
    }, 20000);
    await h.sleep(2500);

    const s1 = await p.eval(() => {
      const doc = document.querySelector('.set-doc-scroll');
      const rows = [...document.querySelectorAll('.set-rail-i')];
      return {
        railRows: rows.length,
        groups: document.querySelectorAll('.set-rail-g').length,
        notes: document.querySelectorAll('.set-rail-scroll .set-rail-note').length,
        values: rows.slice(0, 5).map(r => r.innerText.replace(/\n/g, ' | ')),
        docH: doc.scrollHeight,
        docClient: doc.clientHeight,
        pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
        on: (document.querySelector('.set-rail-i.on') || {}).innerText || '',
        pos: (document.querySelector('.set-pos') || {}).innerText || '',
        save: (document.querySelector('.set-save') || {}).innerText || '',
        anchor: getComputedStyle(document.querySelector('.set-doc-scroll')).getPropertyValue('--setanchor').trim()
      };
    });
    ok('目录轨 15 行 / 5 组', s1.railRows === 15 && s1.groups === 5, s1.railRows + ' 行 · ' + s1.groups + ' 组');
    ok('每组有一句说明', s1.notes === 5, s1.notes + ' 条');
    ok('值速记有内容', s1.values.every(v => v.split(' | ')[1]), s1.values.join(' / '));
    ok('页面自己不滚', !s1.pageScrolls);
    ok('文档自己滚（长文档）', s1.docH > s1.docClient * 3, s1.docH + 'px / 视口 ' + s1.docClient + 'px');
    ok('状态行说得出「第几项」', /第 \d+ \/ \d+ 项/.test(s1.pos), s1.pos);
    ok('保存回执还在（没有「保存」按钮）', /自动存|已存|存进本机/.test(s1.save), s1.save.slice(0, 30));
    ok('停靠位量出来了', !!s1.anchor, s1.anchor);

    /* 点轨上的一项 → 右栏滚到那一栏 */
    await p.eval(() => {
      const el = [...document.querySelectorAll('.set-rail-i')].find(x => x.innerText.indexOf('产物存放') >= 0);
      if (el) el.click();
    });
    await h.sleep(1600);
    const s2 = await p.eval(() => {
      const doc = document.querySelector('.set-doc-scroll');
      const card = document.querySelector('.card[data-nav="storage"]');
      const r = card.getBoundingClientRect(), dr = doc.getBoundingClientRect();
      const gh = document.querySelectorAll('.set-group-h');
      let pinned = null;
      gh.forEach(g => { const gr = g.getBoundingClientRect(); if (Math.abs(gr.top - dr.top) < 3) pinned = g.innerText.trim(); });
      return {
        cardTop: Math.round(r.top - dr.top),
        on: (document.querySelector('.set-rail-i.on') || {}).innerText || '',
        pos: (document.querySelector('.set-pos') || {}).innerText || '',
        pinned: pinned,
        scrollTop: Math.round(doc.scrollTop)
      };
    });
    ok('点轨上那一项 → 滚到那张卡（卡顶让开钉住的组标题）', s2.cardTop > 0 && s2.cardTop < 120, '卡顶在容器上方 ' + s2.cardTop + 'px');
    ok('滚过去那一项当场就亮', s2.on.indexOf('产物存放') >= 0, s2.on.replace(/\n/g, ' | '));
    ok('状态行跟着换', s2.pos.indexOf('产物存放') >= 0, s2.pos);

    /* 滚到别处 → 轨上的高亮跟着换；组标题这时该钉在顶上 */
    await p.eval(() => { document.querySelector('.set-doc-scroll').scrollTop = 4200; });
    await h.sleep(700);
    const s3 = await p.eval(() => {
      const doc = document.querySelector('.set-doc-scroll');
      const dr = doc.getBoundingClientRect();
      let pinned = null;
      document.querySelectorAll('.set-group-h').forEach(g => {
        const gr = g.getBoundingClientRect();
        if (Math.abs(gr.top - dr.top) < 3) pinned = g.innerText.trim();
      });
      return {
        on: (document.querySelector('.set-rail-i.on') || {}).innerText || '',
        pos: (document.querySelector('.set-pos') || {}).innerText || '',
        pinned: pinned
      };
    });
    ok('滚到别处 → 轨上跟着亮', !!s3.on, s3.on.replace(/\n/g, ' | ') + '　' + s3.pos);
    ok('组标题钉在顶上', !!s3.pinned, s3.pinned || '(没钉住)');

    /* 搜一个词 → 命中落到行 */
    await p.eval(() => {
      const el = document.querySelector('.set-rail-top input[type=search]');
      el.value = '缓存';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await h.sleep(600);
    const s4 = await p.eval(() => ({
      hits: document.querySelectorAll('.set-hit').length,
      off: document.querySelectorAll('.card.set-off').length,
      sum: (document.querySelector('.set-rail-note') || {}).innerText || '',
      foot: (document.querySelector('.set-rail-foot') || {}).innerText || ''
    }));
    ok('搜「缓存」有行级命中', s4.hits > 0, s4.hits + ' 处命中 · ' + s4.foot);
    ok('没命中的栏收起来', s4.off > 0, s4.off + ' 栏收着');

    await p.screenshot('design/settings-layout/shots/real-settings-scrolled.png');
    console.log(out.join('\n'));
    console.log('\n页面报错：' + (p.errors.filter(e => !/favicon/i.test(e)).join(' | ') || '（无）'));
    console.log('通过 ' + out.filter(x => x[0] === '✓').length + ' / ' + out.length);
  } finally {
    await b.close();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
