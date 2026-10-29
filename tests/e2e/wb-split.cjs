#!/usr/bin/env node
/* 工作台左右两栏的**可拖分栏**判据：
   用户报过两条：
     ① 「拖动时页面最左边最右边的空白大小也会发生变化」—— 两栏块是 flex 子项又带
        margin:0 auto，按 flex 规则不拉伸、按内容（fit-content）定宽，而那份宽度里含着
        左栏那一轨 → 拖一下，宽度变 → 因为居中，外侧空白跟着变（这一条盯的是
        **拖动全程 .layout 的 left/right/width 不变**）；
     ② 「手感不对、左右移动总在中间附近变动」—— 把手要长在**本页自己的** .layout 上：
        文档级 '.layout' 在 KeepAlive 页面池里会命中别的页（导演台也有 .layout），
        而那边早已 _wbSplit=true → enable 直接返回 null → 这一页既没有把手、
        也读不到存下来的 wb_split。

   这一条盯：
     · 工作台有且只有一根左右轴把手，且它在**工作台自己的** .layout 里
     · 拖把手 → 左栏宽度跟手 1:1（拖多少，差多少）
     · 拖动全程页面左右两端的空白不变（.layout 的 left/right/width 一模一样）
     · 拖出来的值落盘（wb_split.sp0），刷新后还是那个宽度
     · 双击把手复位：行内 --sp0 撤掉、回到弹性默认档
     · 切到别的页再切回来，把手与宽度都还在（KeepAlive 不许把它吃掉）
     · 页头那条与两栏块同宽同起点（标题落在左栏左缘）

   路由：#studio.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1600, 900);
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => !!document.querySelector('.studio-page'), 30000, 100);
    /* 等把手装上（Wb.split.enable 在页面初始化末尾才跑）。 */
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const has = await page.eval(() => !!document.querySelector('.studio-page .wb-split'));
      if (has) break;
      await sleep(150);
    }

    const measure = () => page.eval(() => {
      const root = document.querySelector('.studio-page');
      const layout = root ? root.querySelector('.layout') : null;
      const left = root ? root.querySelector('.col-left') : null;
      const right = root ? root.querySelector('.col-right') : null;
      const head = root ? root.querySelector('.phead') : null;
      const hs = root ? [...root.querySelectorAll('.wb-split')] : [];
      const h0 = hs[0];
      const lr = layout ? layout.getBoundingClientRect() : null;
      const hr = head ? head.getBoundingClientRect() : null;
      const rr = right ? right.getBoundingClientRect() : null;
      let rec = null;
      try { rec = JSON.parse(localStorage.getItem('wb_split') || 'null'); } catch (e) { rec = null; }
      return {
        handles: hs.length,
        handleInLayout: !!(h0 && layout && layout.contains(h0)),
        handleHidden: h0 ? h0.classList.contains('hide') : null,
        handleRect: h0 ? (() => { const r = h0.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })() : null,
        leftW: left ? Math.round(left.getBoundingClientRect().width) : -1,
        rightW: right ? Math.round(rr.width) : -1,
        layoutLeft: lr ? Math.round(lr.left) : -1,
        layoutRight: lr ? Math.round(lr.right) : -1,
        layoutW: lr ? Math.round(lr.width) : -1,
        headLeft: hr ? Math.round(hr.left) : -1,
        headRight: hr ? Math.round(hr.right) : -1,
        inline: layout ? layout.getAttribute('style') || '' : '',
        rec: rec,
      };
    });

    const m0 = await measure();
    must(m0.handles === 1, '工作台上该有且只有一根左右轴把手：' + JSON.stringify(m0));
    must(m0.handleInLayout, '把手不在工作台自己的 .layout 里（串页了：文档级 .layout 命中了别的页）：' + JSON.stringify(m0));
    must(!m0.handleHidden, '把手不该是藏着的：' + JSON.stringify(m0));

    /* 拖把手：真鼠标事件（Wb.split 用 pointerdown + setPointerCapture，
       合成事件搬不动它 —— 指针不是真的按下，捕获会抛）。 */
    const drag = async (from, dx) => {
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 8; i++) {
        await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + dx * i / 8), y: from.y, button: 'left', buttons: 1 });
        await sleep(25);
      }
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(from.x + dx), y: from.y, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(450);
    };

    /* ── ① 往右拖 120：左栏宽 120，且**页面左右两端的空白纹丝不动** ────── */
    await drag(m0.handleRect, 120);
    const m1 = await measure();
    must(Math.abs((m1.leftW - m0.leftW) - 120) <= 3,
      '往右拖 120 像素，左栏该宽 120（' + m0.leftW + ' → ' + m1.leftW + '）：' + JSON.stringify(m1));
    must(m1.layoutLeft === m0.layoutLeft && m1.layoutRight === m0.layoutRight && m1.layoutW === m0.layoutW,
      '拖动时两栏块的位置/宽度变了 → 页面最左最右的空白跟着变（'
      + JSON.stringify({ l: m0.layoutLeft, r: m0.layoutRight, w: m0.layoutW })
      + ' → ' + JSON.stringify({ l: m1.layoutLeft, r: m1.layoutRight, w: m1.layoutW }) + '）');
    must(/--sp0\s*:/.test(m1.inline), '拖完该在 .layout 上写出 --sp0：' + m1.inline);
    must(m1.rec && Number(m1.rec.sp0) > 0, '拖出来的值该落盘（wb_split.sp0）：' + JSON.stringify(m1.rec));

    /* ── ② 页头那条与两栏块同宽同起点（标题落在左栏左缘） ───────────── */
    must(m1.headLeft === m1.layoutLeft && m1.headRight === m1.layoutRight,
      '页头与两栏块该同宽同起点（' + JSON.stringify({ h: [m1.headLeft, m1.headRight], l: [m1.layoutLeft, m1.layoutRight] }) + '）');

    /* ── ③ 落盘：真的重载一次，宽度还是那个 ──────────────────────────── */
    const stored = m1.rec.sp0;
    await page.eval(() => { window.__beforeReload = 1; });
    await page.cdp.send('Page.reload', {});
    await page.waitFor(() => !window.__beforeReload, 30000);
    await page.waitFor(() => !!document.querySelector('.studio-page'), 30000, 100);
    const until2 = Date.now() + 30000;
    while (Date.now() < until2) {
      const has = await page.eval(() => !!document.querySelector('.studio-page .wb-split'));
      if (has) break;
      await sleep(150);
    }
    const m2 = await measure();
    must(Math.abs(m2.leftW - stored) <= 3, '刷新后左栏该还是存下来的那个宽度（存 ' + stored + '，实测 ' + m2.leftW + '）：' + JSON.stringify(m2));
    must(m2.layoutW === m0.layoutW, '刷新后两栏块的宽度不该变（fit-content 那条老路又回来了）：' + JSON.stringify(m2));

    /* ── ④ 双击把手：复位回弹性默认 ─────────────────────────────────── */
    await page.eval(() => {
      const h0 = document.querySelector('.studio-page .wb-split');
      if (h0) h0.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    await sleep(450);
    const m3 = await measure();
    must(m3.inline.indexOf('--sp0') < 0, '双击复位该把行内的 --sp0 撤掉：' + m3.inline);
    must(!m3.rec || m3.rec.sp0 == null, '双击复位该把记录里的那一档走掉：' + JSON.stringify(m3.rec));

    /* ── ⑤ 站内切到别的页再切回来（不刷新）：把手与宽度都还在 ──────────
       ⚠ 必须走外壳的 appShow（KeepAlive 换页），不能 page.goto ——
       整页重载验不到「页面池里另一个页面也被装着 .layout」这件事（串页就是那么发生的）。 */
    await drag((await measure()).handleRect, 100);
    const before = await measure();
    await page.eval(() => { window.appShow('favorites.html', true); });
    await page.waitFor(() => !!document.querySelector('.fav-page'), 30000, 100);
    await sleep(600);
    await page.eval(() => { window.appShow('studio.html', true); });
    await page.waitFor(() => !!document.querySelector('.studio-page'), 30000, 100);
    const until3 = Date.now() + 30000;
    while (Date.now() < until3) {
      const has = await page.eval(() => !!document.querySelector('.studio-page .wb-split'));
      if (has) break;
      await sleep(150);
    }
    const m4 = await measure();
    must(m4.handles === 1 && m4.handleInLayout, '切回工作台后把手该还在本页的 .layout 里：' + JSON.stringify(m4));
    must(Math.abs(m4.leftW - before.leftW) <= 3,
      '切回工作台后左栏宽度该还是那个（' + before.leftW + ' → ' + m4.leftW + '）：' + JSON.stringify(m4));

    const errs = h.logFaults(proxy.log);
    if (errs.length) throw new Error('代理日志有异常：\n  ' + errs.join('\n  '));
    console.log('✓ 工作台分栏：把手在本页 · 拖得动且跟手 · 拖动时页面左右空白不动 · 落盘 · 复位 · 切页不丢');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
