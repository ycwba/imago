#!/usr/bin/env node
/* 「存回本机」只存**多选勾选的那几条** + 生成工作台的翻页行住在右栏顶上。
   跑法：node tests/e2e/pull-selected.cjs
   用户 2026-10-25 定的两条：
     · 工作台的翻页组件在**右栏的上方**（搜索那一排下面、结果区上面）—— 右栏自己滚，
       翻页塞在页底要一路滚到底才找得到；
     · 「存回本机」是**多选之后才出现**的一颗，存的是**勾选的那几条** ——
       不多选就点它等于「把这一屏都存一遍」，那不是用户的意思（工作台与资产库两页都是）。
   判据不碰网络：平台清单由 AssetLib.load 的假数据顶上（两条「只有平台那份、本机还没有字节」
   的产物）；落盘那一段（AssetLocal.pullMany）换成记账版，只记「点了要存哪几条」。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* 两条假产物：都是平台那份，本机还没有字节（所以两颗「存回本机」都该把它们算进去）。
   src 走同源相对路径 `/asset/<产物号>`：外链域名过不了 CSP，也不该让探针真去出网。 */
const FAKE = [
  { kind: 'asset', assetId: 'probe_a1', id: 'probe_a1', type: '图片', provider: 'probe',
    providerName: '探针', model: 'probe', prompt: '探针产物一', src: '/asset/probe_a1',
    format: 'png', byteLength: 1024, ts: Date.now() },
  { kind: 'asset', assetId: 'probe_a2', id: 'probe_a2', type: '图片', provider: 'probe',
    providerName: '探针', model: 'probe', prompt: '探针产物二', src: '/asset/probe_a2',
    format: 'png', byteLength: 1024, ts: Date.now() - 1000 },
];

/* 页面脚本之前装好：AssetLib 是后加载的，init script 那一刻它多半还不存在 ——
   轮询到它出现为止再换掉 load（早一步装不上，这一档就只剩真的平台清单：判据会白捡一个绿）。 */
const STUB_LOAD = `
(function () {
  var ENTRIES = ${JSON.stringify(FAKE)};
  function install() {
    var L = window.AssetLib;
    if (!L || typeof L.load !== 'function' || L.__probeLoad) return !!L;
    L.__probeLoad = true;
    L.load = function (opts) {
      try { if (opts && typeof opts.onBatch === 'function') opts.onBatch(ENTRIES); } catch (e) {}
      return Promise.resolve({ entries: ENTRIES, cursors: {}, more: {}, hasMore: false, errors: {}, failed: {} });
    };
    return true;
  }
  if (!install()) { var t = setInterval(function () { if (install()) clearInterval(t); }, 20); }
  /* 点**指定那条**（提示词对得上就点它，对不上就点第一张）：列表是按时间倒序排的，
     不点名就可能点到别的条目上去（探针里曾因此点到用户自己的历史条目）。 */
  window.__pickCard = function (sel) {
    var cards = document.querySelectorAll(sel + ' .task');
    for (var i = 0; i < cards.length; i++) {
      var p = cards[i].querySelector('.tprompt');
      if (p && p.textContent.indexOf('探针产物一') >= 0) return cards[i];
    }
    return cards[0] || null;
  };
})()`;

(async () => {
  let proxy, browser, page;
  try {
    /* 上游指到一个没人听的端口：这一档判的是界面与范围，**不许**真去平台取数，
       也不许把密钥带出门（与 asset-requests 那一条同一手）。 */
    proxy = await h.startProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const readWhen = async (fn, timeout = 20000, ...args) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn, ...args);
        if (v) return v;
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    };

    /* init script 必须在**第一次导航之前**装上：换 hash 不会重新加载文档，
       装晚了这一档就只剩真的平台清单（判据会白捡一个绿）。 */
    await page.addInitScript(STUB_LOAD);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.waitFor(() => !!(window.AssetLib && window.AssetLib.__probeLoad), 20000, 100);
    /* 自动存本机这一档关掉：探针造的那两条没有真字节，让自动补存去下就是让判据去碰网络。 */
    await page.eval(() => { localStorage.clear(); localStorage.setItem('sk_media_local', 'off'); });

    /* ---------- 生成工作台 ---------- */
    await page.eval(() => { location.hash = '#studio.html'; });
    await page.waitFor(() => !!document.querySelector('.studio-page'), 25000);
    const got = await readWhen(() => document.querySelectorAll('#result .task').length >= 2 ? true : null, 25000);
    must(got, '生成工作台没画出那两条假产物（假数据没接上）');

    /* ① 翻页行住在右栏里，排在搜索那一排下面、结果区上面 */
    const geo = await page.eval(() => {
      const col = document.querySelector('.studio-page .col-right');
      const kids = col ? [...col.children] : [];
      const at = pred => kids.findIndex(k => pred(k));
      return {
        hasCol: !!col,
        iHead: at(k => (k.className || '').split(' ').includes('tasks-head')),
        iPager: at(k => (k.className || '').split(' ').includes('wb-pager')),
        iResult: at(k => k.id === 'result'),
        inCol: !!(col && col.querySelector(':scope > .wb-pager')),
        atPageBottom: !!document.querySelector('.studio-page > .wb-pager'),
        headHasSearch: !!(col && col.querySelector('.tasks-head .fb-host')),
      };
    });
    must(geo.hasCol, '生成工作台没有右栏（.col-right）');
    must(geo.inCol, '工作台的翻页行不在右栏里');
    must(!geo.atPageBottom, '工作台的翻页行还留在页底');
    must(geo.headHasSearch, '右栏那一排里没有搜索框（.fb-host）');
    must(geo.iHead >= 0 && geo.iPager > geo.iHead,
      '翻页行没有排在搜索那一排下面（头 ' + geo.iHead + ' / 翻页 ' + geo.iPager + '）');
    must(geo.iResult > geo.iPager,
      '翻页行没有排在结果区上面（翻页 ' + geo.iPager + ' / 结果 ' + geo.iResult + '）');

    /* ② 「存回本机」住在多选条里，不在搜索那一排；没进多选时看不见 */
    const btn0 = await page.eval(() => {
      const b = document.querySelector('#stPullLocal');
      const bar = document.querySelector('#stBulkBar');
      return {
        inBar: !!(b && bar && bar.contains(b)),
        inHead: !!(b && b.closest('.tasks-head')),
        barHidden: !!(bar && bar.hidden),
        visible: !!(b && b.getBoundingClientRect().height > 0),
      };
    });
    must(btn0.inBar, '工作台的「存回本机」不在多选条里');
    must(!btn0.inHead, '工作台的「存回本机」还留在搜索那一排里');
    must(!btn0.visible, '没进多选时「存回本机」就露出来了（它该多选之后才出现）');

    /* ③ 进多选 → 那颗按钮露出来；勾一条 → 按钮上的数 = 1（不是整屏两条） */
    await page.eval(() => { document.querySelector('#multiBtn').click(); });
    await readWhen(() => {
      const b = document.querySelector('#stPullLocal');
      return !!(b && b.getBoundingClientRect().height > 0);
    }, 8000);
    /* 多选态要看得见勾选框：选没选、选了哪几条用户得看得见 ——
       「存的是选中的那几条」这条前提就是靠它成立的。 */
    const pick = await page.eval(() => {
      const p = document.querySelector('#result .task .pick');
      if (!p) return { exists: false };
      return { exists: true, display: getComputedStyle(p).display, h: Math.round(p.getBoundingClientRect().height) };
    });
    must(pick.exists && pick.display !== 'none' && pick.h > 0,
      '工作台多选时勾选框看不见：' + JSON.stringify(pick));
    const label0 = await page.eval(() => {
      const b = document.querySelector('#stPullLocal');
      const tx = b && b.querySelector('.tx');
      return (tx || b || {}).textContent || '';
    });
    must(!/（\d+）/.test(label0), '还没勾任何东西，按钮上却已经有条数了：' + label0);

    await page.eval(() => { const c = window.__pickCard('#result'); c.click(); });
    const label1 = await readWhen(() => {
      const b = document.querySelector('#stPullLocal');
      const tx = b && b.querySelector('.tx');
      const t = (tx || b || {}).textContent || '';
      return /（1）/.test(t) ? t : null;
    }, 8000);
    must(label1, '勾了一条之后按钮上的数不是 1（范围没跟着勾选走）：' + label1);

    /* ④ 点下去只排勾选的那一条 */
    await page.eval(() => {
      window.__pulled = [];
      window.AssetLocal.pullMany = async (jobs) => {
        for (const j of jobs || []) {
          const e = j.entry || j;
          window.__pulled.push({ id: e.assetId || e.id || '', prompt: e.prompt || '' });
        }
        return { ok: 0, kept: 0, busy: 0, cant: 0, skip: 0, fails: [], total: (jobs || []).length };
      };
    });
    await page.eval(() => { document.querySelector('#stPullLocal').click(); });
    const pulled = await readWhen(() => (window.__pulled && window.__pulled.length ? window.__pulled : null), 8000);
    must(pulled && pulled.length === 1,
      '工作台点「存回本机」排了 ' + (pulled ? pulled.length : 0) + ' 条（应当只有勾选的那一条）');
    must(pulled[0].id === 'probe_a1', '存的不是勾选的那一条：' + JSON.stringify(pulled));

    /* ---------- 资产库 ---------- */
    await page.eval(() => { location.hash = '#assets.html'; });
    await page.waitFor(() => !!document.querySelector('.assets-page'), 25000);
    const got2 = await readWhen(() => document.querySelectorAll('#grid .task').length >= 2 ? true : null, 25000);
    must(got2, '资产库没画出那两条假产物（假数据没接上）');

    const abtn0 = await page.eval(() => {
      const b = document.querySelector('#pullLocalBtn');
      const bar = document.querySelector('#bulkBar');
      return {
        inBar: !!(b && bar && bar.contains(b)),
        inFilters: !!(b && b.closest('.filters')),
        visible: !!(b && b.getBoundingClientRect().height > 0),
      };
    });
    must(abtn0.inBar, '资产库的「存回本机」不在多选条里');
    must(!abtn0.inFilters, '资产库的「存回本机」还留在筛选那一排里');
    must(!abtn0.visible, '没进多选时资产库的「存回本机」就露出来了');

    await page.eval(() => { document.querySelector('#multiBtn').click(); });
    await readWhen(() => {
      const b = document.querySelector('#pullLocalBtn');
      return !!(b && b.getBoundingClientRect().height > 0);
    }, 8000);
    const apick = await page.eval(() => {
      const p = document.querySelector('#grid .task .pick');
      if (!p) return { exists: false };
      return { exists: true, display: getComputedStyle(p).display, h: Math.round(p.getBoundingClientRect().height) };
    });
    must(apick.exists && apick.display !== 'none' && apick.h > 0,
      '资产库多选时勾选框看不见：' + JSON.stringify(apick));
    await page.eval(() => { const c = window.__pickCard('#grid'); c.click(); });
    const alabel = await readWhen(() => {
      const b = document.querySelector('#pullLocalBtn');
      const tx = b && b.querySelector('.tx');
      const t = (tx || b || {}).textContent || '';
      return /（1）/.test(t) ? t : null;
    }, 8000);
    must(alabel, '资产库勾了一条之后按钮上的数不是 1：' + alabel);

    await page.eval(() => {
      window.__pulled = [];
      window.AssetLocal.pullMany = async (jobs) => {
        for (const j of jobs || []) {
          const e = j.entry || j;
          window.__pulled.push({ id: e.assetId || e.id || '', prompt: e.prompt || '' });
        }
        return { ok: 0, kept: 0, busy: 0, cant: 0, skip: 0, fails: [], total: (jobs || []).length };
      };
    });
    await page.eval(() => { document.querySelector('#pullLocalBtn').click(); });
    const apulled = await readWhen(() => (window.__pulled && window.__pulled.length ? window.__pulled : null), 8000);
    must(apulled && apulled.length === 1,
      '资产库点「存回本机」排了 ' + (apulled ? apulled.length : 0) + ' 条（应当只有勾选的那一条）');
    must(apulled[0].id === 'probe_a1', '资产库存的不是勾选的那一条：' + JSON.stringify(apulled));

    console.log('✓ 工作台翻页行在右栏顶上（搜索那一排下面）· 资产库翻页行仍在页底');
    console.log('✓ 「存回本机」多选之后才出现，存的是勾选的那几条（工作台 / 资产库）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
