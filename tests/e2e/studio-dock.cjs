#!/usr/bin/env node
/* 工作台左栏的**「正文滚 + 生成区钉底」**判据（用户点名：生成按钮要像导演台右栏那样悬浮在栏底）。
   以前整栏是一只滚动容器、按钮跟在内容最末，于是两种坏形状同时存在：
     · 提示词长 / 参考素材多 → 要一路滚到底才够得着按钮；
     · 窗口一高、内容又短 → 按钮浮在半空，下面留一大片空白。
   这一条盯：
     · 左栏自己不滚：`.col-left` 的 scrollHeight == clientHeight，滚的是里面的 `.wb-body`
     · 内容短（高窗）时按钮也贴着栏底（dock 底边 == 栏底边），不是浮在内容后面
     · 内容长（矮窗）时 `.wb-body` 真的在滚，且滚到底之后按钮仍在栏内、仍贴着栏底
     · 原始请求（可以展开老长的那块）归正文，不在钉底段里
     · 切换生成类型（视频 → 图像）之后，按钮还在栏底，文案跟着变
     · ≤1100px 单列：滚的是整块 `.layout`，钉底段改成 sticky，滚一段之后仍在视口底部
   路由：#studio.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const measure = page => page.eval(() => {
  const root = document.querySelector('.studio-page');
  const col = root.querySelector('.col-left');
  const body = col.querySelector('.wb-body');
  const dock = col.querySelector('.wb-dock');
  const go = root.querySelector('[data-r="go"]');
  const raw = root.querySelector('[data-raw-host]');
  const layout = root.querySelector('.layout');
  const r = el => (el ? el.getBoundingClientRect() : null);
  const cr = r(col), br = r(body), dr = r(dock), gr = r(go), lr = r(layout);
  return {
    hasBody: !!body, hasDock: !!dock, dockLast: !!(dock && col.lastElementChild === dock),
    rawInBody: !!(raw && body && body.contains(raw)),
    colScroll: { sh: col.scrollHeight, ch: col.clientHeight, top: Math.round(col.scrollTop) },
    bodyScroll: { sh: body ? body.scrollHeight : 0, ch: body ? body.clientHeight : 0, top: body ? Math.round(body.scrollTop) : 0 },
    colBottom: Math.round(cr.bottom), dockBottom: Math.round(dr.bottom), dockTop: Math.round(dr.top),
    goBottom: Math.round(gr.bottom), goTop: Math.round(gr.top), bodyBottom: Math.round(br.bottom),
    layout: { bottom: Math.round(lr.bottom), top: Math.round(lr.top), sh: layout.scrollHeight, ch: layout.clientHeight },
    dockPos: getComputedStyle(dock).position,
    goText: go.textContent.trim(),
    vh: window.innerHeight,
  };
});

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    /* ── ① 高窗 + 内容短：按钮也得贴着栏底（不被内容留在半空） ─────────── */
    await page.setSize(1440, 980);
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => !!document.querySelector('.studio-page .wb-dock'), 30000, 100);
    await sleep(900);

    const m0 = await measure(page);
    must(m0.hasBody && m0.hasDock && m0.dockLast,
      '左栏该是「.wb-body 正文 + .wb-dock 钉底」两段，且 dock 是最后一个子节点：' + JSON.stringify(m0));
    must(m0.colScroll.sh <= m0.colScroll.ch + 1,
      '左栏自己不该再是滚动容器（滚的只有正文那一段）：' + JSON.stringify(m0.colScroll));
    must(m0.rawInBody, '「原始请求」那块该在正文里（它一展开老长，放进钉底会把按钮挤走）：' + JSON.stringify(m0));
    must(Math.abs(m0.dockBottom - m0.colBottom) <= 1,
      '内容没占满时钉底段也得贴着栏底（按钮浮在半空就是这一条坏了）：'
      + JSON.stringify({ dock: m0.dockBottom, col: m0.colBottom, body: m0.bodyBottom }));

    /* ── ② 矮窗 + 内容溢出：正文滚，按钮不动 ─────────────────────────── */
    await page.setSize(1280, 520);
    await sleep(700);
    const m1 = await measure(page);
    must(m1.bodyScroll.sh > m1.bodyScroll.ch + 20,
      '矮窗里该由正文那一段滚（scrollHeight 得比 clientHeight 大）：' + JSON.stringify(m1.bodyScroll));
    must(m1.colScroll.sh <= m1.colScroll.ch + 1,
      '矮窗里左栏自己仍然不该滚：' + JSON.stringify(m1.colScroll));
    must(Math.abs(m1.dockBottom - m1.colBottom) <= 1
      && m1.goBottom <= m1.dockBottom + 1 && m1.goBottom > m1.dockBottom - 60,
      '矮窗里按钮该仍在栏底（dock 贴栏底，状态行那一格留在按钮下面）：'
      + JSON.stringify({ dock: m1.dockBottom, col: m1.colBottom, go: m1.goBottom }));

    await page.eval(() => { const b = document.querySelector('.studio-page .wb-body'); b.scrollTop = 1e6; });
    await sleep(400);
    const m2 = await measure(page);
    must(m2.bodyScroll.top > 20, '正文该真的滚下去了：' + JSON.stringify(m2.bodyScroll));
    must(m2.goTop >= m2.layout.top && m2.goBottom <= m2.colBottom + 1,
      '正文滚到底之后按钮该还在栏内、还贴着栏底（跟着内容滚走了就是没钉住）：'
      + JSON.stringify({ go: [m2.goTop, m2.goBottom], col: [m2.layout.top, m2.colBottom] }));
    must(Math.abs(m2.dockBottom - m2.colBottom) <= 1, '滚到底之后 dock 仍要贴栏底：' + JSON.stringify(m2));

    /* ── ③ 换类型：dock 不重建、按钮还在栏底、文案跟着换 ────────────── */
    await page.eval(() => {
      const seg = document.querySelector('.studio-page [data-r="typeSeg"]');
      const b = seg && [...seg.querySelectorAll('button')].find(x => /图像/.test(x.textContent));
      if (b) b.click();
    });
    await sleep(700);
    const m3 = await measure(page);
    must(/图像/.test(m3.goText), '切到图像栏之后按钮文案该跟着变（现在的字是「' + m3.goText + '」）');
    must(Math.abs(m3.dockBottom - m3.colBottom) <= 1,
      '换类型之后按钮还得贴着栏底（重画不许把 dock 挪走）：' + JSON.stringify(m3));

    /* ── ④ ≤1100 单列：滚的是 .layout，dock 改成 sticky 贴视口底 ──────── */
    await page.setSize(1000, 620);
    await sleep(700);
    const m4 = await measure(page);
    must(m4.dockPos === 'sticky',
      '单列时钉底段该是 position:sticky（滑动时贴住视口底）：' + JSON.stringify({ pos: m4.dockPos }));
    must(m4.layout.sh > m4.layout.ch + 20, '单列时该由 .layout 整块滚：' + JSON.stringify(m4.layout));
    const stuck = await page.eval(() => {
      const layout = document.querySelector('.studio-page .layout');
      const dock = document.querySelector('.studio-page .wb-dock');
      layout.scrollTop = 240;
      const lr = layout.getBoundingClientRect(), dr = dock.getBoundingClientRect();
      return { scrollTop: Math.round(layout.scrollTop), dockBottom: Math.round(dr.bottom), layoutBottom: Math.round(lr.bottom),
        layoutTop: Math.round(lr.top), dockTop: Math.round(dr.top) };
    });
    must(stuck.scrollTop > 100, '单列时 .layout 该滚得动：' + JSON.stringify(stuck));
    must(stuck.dockTop >= stuck.layoutTop && stuck.dockBottom <= stuck.layoutBottom + 1,
      '滚动之后按钮该还留在视口里（sticky 没生效就会跟着内容滑出去）：' + JSON.stringify(stuck));

    const errs = h.logFaults(proxy.log);
    if (errs.length) throw new Error('代理日志有异常：\n  ' + errs.join('\n  '));
    console.log('✓ 工作台左栏：正文一段滚 · 生成区钉在栏底（内容长短都贴底）· 换类型不丢 · 单列时 sticky 贴视口底');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
