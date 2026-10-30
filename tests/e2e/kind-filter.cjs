#!/usr/bin/env node
/* 文件类型筛选（全部 / 视频 / 图片 / 音频）判据：三页共用**同一副**公共件。
   用户报过两件事：
     · 「素材库和收藏页面等页面的文件类型筛选应该使用工作台的筛选的那个公共组件」
       —— 以前三页三副样子：工作台自己拼 innerHTML（分段 + 每档计数）、收藏页走 Wb.filterBar 的
          芯片行、资产库走 Chips.render 的芯片行。现在收成公共件 Wb.kindFilter（分段 + 每档计数）。
     · 「资产库等各种文件筛选按钮都应该按照全部 视频 图片 音频的顺序，并且应该一次性按钮都出现」
       —— 以前档位表与顺序有四份（收藏与资产库各抄一份「图片 视频 音频」、工作台按「这一屏出现过的
          类型」现攒），于是同一排在三页顺序不同、音频那一档要等第一条音频到账才冒出来。

   这一条盯住别退回去：
     · 每页有且只有**一处**文件类型筛选（挂 data-kind-filter 旗标；
       页面上还有别的 .ui-seg —— 工作台左栏那颗是「生成类型」开关，不是这一族）
     · 它是分段控件（.ui-seg），每一档是一颗 button[data-k] + 一枚计数芯片（.seg-n）
     · **DOM 里的顺序 = 全部 → 视频 → 图片 → 音频**（「全部」的内部键两页不同：工作台与收藏用 all，
       资产库用 全部）；顺序由公共件定一次，页面给的数组顺序不作数
     · **页面给的每一档恒画**：计数为 0 也画着（不许「跟着数据长出来」，也不许选一档就把别的档藏掉）
     · 计数与实际条数一致；点一档 → 当前档 .on、列表按那一档筛、计数刷新
     · 三页的 DOM 契约一模一样（同一份公共件，不是三份各画各的）

   路由：#favorites.html / #studio.html / #assets.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 一张 1×1 的 gif：探针自己造的，不去碰平台，也不发请求。 */
const PIX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* 除「全部」以外的三档，顺序就是用户要的那一副。 */
const KINDS = ['视频', '图片', '音频'];

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);

    /* 造三条收藏（图片 / 视频 / 音频各一条）→ 收藏页的类型档就有真条数可数。 */
    await page.eval(px => {
      const mk = (key, type, prompt) => ({ key, type, prompt, name: key, src: px, ts: Date.now(), kind: 'asset', providerName: '探针' });
      window.Store.write('fav_items', [mk('fav-img', '图片', '探针图片'), mk('fav-vid', '视频', '探针视频'), mk('fav-aud', '音频', '探针音频')]);
    }, PIX);

    /* 量某一页的文件类型筛选：档位（按 DOM 顺序）、计数、当前档、画没画出来。 */
    const readFilter = () => page.eval(() => {
      const box = document.querySelector('[data-kind-filter]');
      if (!box) return null;
      const tabs = [...box.querySelectorAll('button[data-k]')].map(b => {
        const n = b.querySelector('.seg-n');
        return {
          k: b.dataset.k,
          text: (b.textContent || '').replace(/\s+/g, ''),
          n: n ? (n.textContent || '').trim() : '',
          on: b.classList.contains('on'),
          hidden: b.hidden,
        };
      });
      /* `count` 数的是「这一页挂了几处筛选」（不是几档）：一处分段控件里本来就有
         全部 / 视频 / 图片 / 音频 四颗按钮，拿按钮数当「处数」永远不可能是 1。 */
      return { cls: box.className, tabs, count: document.querySelectorAll('[data-kind-filter]').length };
    });

    /* 四档恒在 + 顺序 + 一颗都不藏 —— 三页同一条尺子，allKey 按页给。 */
    const mustLadder = (f, nm, allKey) => {
      must(f, nm + '没有文件类型筛选（公共件 Wb.kindFilter 没装上）');
      must(f.count === 1, nm + '该有且只有一处文件类型筛选：' + JSON.stringify(f));
      must(/ui-seg/.test(f.cls), nm + '的文件类型筛选该是分段控件（.ui-seg）：' + f.cls);
      must(f.tabs.map(t => t.k).join('|') === [allKey, ...KINDS].join('|'),
        nm + '的档位顺序该是「全部 → 视频 → 图片 → 音频」：' + JSON.stringify(f.tabs.map(t => t.k)));
      must(KINDS.every(k => tabOf(f, k).text.startsWith(k)),
        nm + '三档的显示名与内部键同字：' + JSON.stringify(f.tabs.map(t => t.text)));
      must(f.tabs.every(t => t.n !== ''), nm + '每一档该带计数（.seg-n）：' + JSON.stringify(f.tabs));
      must(f.tabs.every(t => !t.hidden), nm + '每一档都要画出来（计数为 0 也不许藏）：' + JSON.stringify(f.tabs));
      must(f.tabs.filter(t => t.on).length === 1, nm + '恰好一颗是当前档：' + JSON.stringify(f.tabs));
    };
    const tabOf = (f, k) => f.tabs.find(t => t.k === k);

    /* ── ① 收藏页：四档 + 真条数 ───────────────────────────────────── */
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => !!document.querySelector('.fav-page'), 30000, 100);
    const until = Date.now() + 30000;
    let fav = null;
    while (Date.now() < until) {
      fav = await readFilter();
      if (fav && fav.tabs.length) break;
      await sleep(150);
    }
    mustLadder(fav, '收藏页', 'all');
    must(Number(tabOf(fav, 'all').n) === 3, '「全部」该是 3 条：' + JSON.stringify(fav.tabs));
    must(Number(tabOf(fav, '图片').n) === 1, '「图片」该是 1 条：' + JSON.stringify(fav.tabs));
    must(Number(tabOf(fav, '视频').n) === 1, '「视频」该是 1 条：' + JSON.stringify(fav.tabs));
    must(Number(tabOf(fav, '音频').n) === 1, '「音频」该是 1 条：' + JSON.stringify(fav.tabs));
    must(tabOf(fav, 'all').on, '默认该是「全部」亮着：' + JSON.stringify(fav.tabs));

    /* ── ② 公共件排顺序：页面给的数组顺序不作数 ───────────────────────
       档位表由公共件按全站那一份顺序现排；认不出的档名落末尾、保持页面自己的相对顺序，
       不硬塞进三档里的哪一档。 */
    const sorted = await page.eval(() => Wb.kindFilter
      .normKinds([['音频', '音频'], ['其它', '其它'], ['图片', '图片'], ['all', '全部'], ['视频', '视频'], ['第二批', '第二批']])
      .map(k => k[0]).join('|'));
    must(sorted === 'all|视频|图片|音频|其它|第二批',
      '公共件该把档位排成「全部 → 视频 → 图片 → 音频」（认不出的落末尾）：' + sorted);

    /* ── ③ 点一档 → 当前档亮、列表按那一档筛、别的档不跟着消失 ──────── */
    await page.eval(() => {
      const b = document.querySelector('[data-kind-filter] button[data-k="图片"]');
      if (b) b.click();
    });
    await sleep(700);
    const fav2 = await readFilter();
    mustLadder(fav2, '收藏页（筛到「图片」之后）', 'all');
    must(tabOf(fav2, '图片').on, '点「图片」之后该是它亮着：' + JSON.stringify(fav2.tabs));
    must(Number(tabOf(fav2, '视频').n) === 1 && Number(tabOf(fav2, '音频').n) === 1,
      '别的档条数不该因为选中一档变 0：' + JSON.stringify(fav2.tabs));
    const shown = await page.eval(() => document.querySelectorAll('.fav-page .card').length);
    must(shown === 1, '筛到「图片」之后该只剩 1 张卡（实测 ' + shown + ' 张）');

    await page.eval(() => {
      const b = document.querySelector('[data-kind-filter] button[data-k="all"]');
      if (b) b.click();
    });
    await sleep(500);

    /* ── ④ 工作台：一条任务都没有，四档也该一次给全 ──────────────────
       以前这一页按「这一屏出现过的类型」现攒档位表：没到账的那一档整颗不存在，
       等它到了才冒出来，整排跟着左右挪。 */
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(sel => !!document.querySelector(sel), 30000, 100, '.studio-page');
    let wb = null;
    const until3 = Date.now() + 30000;
    while (Date.now() < until3) {
      wb = await readFilter();
      if (wb && wb.tabs.length) break;
      await sleep(150);
    }
    mustLadder(wb, '工作台', 'all');
    must(tabOf(wb, 'all').on, '工作台默认该是「全部」亮着：' + JSON.stringify(wb.tabs));

    /* 资产库的类型档要从真条目里数出条数，而探针没有平台来源：
       先往首屏缓存里放三条（图片 / 视频 / 音频各一条），打开资产库时按缓存画。
       顺手关掉自动存本机：这三条是 data: 地址，不下发任何镜像请求。 */
    await page.eval(px => {
      try { localStorage.setItem('sk_media_local', 'off'); } catch (e) {}
      const mk = (id, type) => ({ provider: 'probe', providerName: '探针', kind: 'asset', assetId: id,
        type, prompt: id, name: id, src: px, ts: Date.now() });
      try {
        localStorage.setItem('assets_cache_v1', JSON.stringify({
          ts: Date.now(),
          entries: [mk('probe-img', '图片'), mk('probe-vid', '视频'), mk('probe-aud', '音频')],
        }));
      } catch (e) {}
    }, PIX);

    /* ── ⑤ 资产库：四档 + 计数，选中一档之后别的档仍在 ────────────────
       计数池要是带着类型条件算，点「图片」之后视频 / 音频的条数会全变 0。
       正确口径：每一档的条数只看「除类型以外」的条件，选中一档不影响别的档。 */
    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(sel => !!document.querySelector(sel), 30000, 100, '.assets-page');
    let as = null;
    const until4 = Date.now() + 30000;
    while (Date.now() < until4) {
      as = await readFilter();
      if (as && as.tabs.length) break;
      await sleep(150);
    }
    mustLadder(as, '资产库', '全部');
    must(Number(tabOf(as, '全部').n) === 3, '资产库「全部」该是 3 条：' + JSON.stringify(as.tabs));
    must(KINDS.every(k => Number(tabOf(as, k).n) === 1),
      '资产库视频 / 图片 / 音频各 1 条：' + JSON.stringify(as.tabs));
    await page.eval(() => {
      const b = document.querySelector('[data-kind-filter] button[data-k="图片"]');
      if (b) b.click();
    });
    await sleep(700);
    const asAfter = await readFilter();
    mustLadder(asAfter, '资产库（筛到「图片」之后）', '全部');
    must(tabOf(asAfter, '图片').on, '点「图片」之后该是它亮着：' + JSON.stringify(asAfter.tabs));
    must(Number(tabOf(asAfter, '视频').n) === 1 && Number(tabOf(asAfter, '音频').n) === 1,
      '别的档条数不该因为选中一档变 0：' + JSON.stringify(asAfter.tabs));
    const asCards = await page.eval(() => document.querySelectorAll('.assets-page .task').length);
    must(asCards === 1, '筛到「图片」之后该只剩 1 张卡（实测 ' + asCards + ' 张）');

    /* ── ⑥ 资产库：某一档此刻 0 条也要在 ─────────────────────────────
       资产是分几批到的（本机账 → 各平台列表）：按「计数为 0 就不画」会让音频那一档
       过一会儿才冒出来、整排跟着左右挪。 */
    await page.eval(() => {
      try {
        const c = JSON.parse(localStorage.getItem('assets_cache_v1') || '{}');
        c.entries = (c.entries || []).filter(e => e.type === '图片');
        localStorage.setItem('assets_cache_v1', JSON.stringify(c));
      } catch (e) {}
      location.reload();
    });
    await page.waitFor(() => !!document.querySelector('.assets-page'), 30000, 100);
    await sleep(1200);
    const zero = await readFilter();
    mustLadder(zero, '资产库（只剩图片那一条时）', '全部');
    must(Number(tabOf(zero, '音频').n) === 0, '资产库「音频」此刻该是 0 条：' + JSON.stringify(zero.tabs));
    must(!tabOf(zero, '音频').hidden,
      '资产库「音频」此刻 0 条也该留着（不许过一会儿才冒出来）：' + JSON.stringify(zero.tabs));

    const errs = h.logFaults(proxy.log);
    if (errs.length) throw new Error('代理日志有异常：\n  ' + errs.join('\n  '));
    console.log('✓ 文件类型筛选：收藏 / 工作台 / 资产库共用同一副公共件（顺序 全部→视频→图片→音频 · 四档一次给全 · 点一下换档 · 计数不跟着选中档变）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
