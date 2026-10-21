#!/usr/bin/env node
/* 助手固定右栏：打开时页面让出右边那一条（不再被面板盖住），右上角那枚按钮切换浮层 / 固定，
   偏好记在本机；窗口窄于 900px 时退回浮层（挤完只剩一条缝），回到宽窗口自动恢复固定。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
function must(cond, msg) { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => !!(window.AiChat && window.AiChat.open), 25000, 100);

    const layout = () => page.eval(() => {
      const app = document.getElementById('app');
      const p = document.getElementById('acPanel');
      const ar = app.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const dock = document.getElementById('acDock');
      return {
        dock: document.documentElement.classList.contains('ac-dock'),
        open: document.documentElement.classList.contains('ac-open'),
        inline: app.style.width,
        appRight: Math.round(ar.right),
        panelLeft: Math.round(pr.left),
        panelRight: Math.round(pr.right),
        pressed: dock ? dock.getAttribute('aria-pressed') : '',
        title: dock ? dock.title : '',
        stored: localStorage.getItem('ai_chat_dock'),
        viewport: window.innerWidth,
      };
    });
    const open = async () => {
      await page.eval(() => window.AiChat.open());
      await page.waitFor(() => document.documentElement.classList.contains('ac-open'), 8000, 80);
      await h.sleep(260);   // 面板的 transform 过渡
    };
    const toggle = async () => {
      await page.eval(() => document.getElementById('acDock').click());
      await h.sleep(260);   // #app 的 width 过渡 .18s
    };

    /* 1) 宽窗口默认固定：页面右边界不越过面板左边界 */
    await open();
    let a = await layout();
    must(a.dock, '1440 宽窗口打开助手后没有固定（缺 ac-dock）：' + JSON.stringify(a));
    must(/calc\(100% - var\(--sbw/.test(a.inline), '固定态没有给 #app 写让位宽度：' + a.inline);
    must(a.appRight <= a.panelLeft + 1, '页面与面板重叠了：appRight=' + a.appRight + ' panelLeft=' + a.panelLeft);
    must(a.pressed === 'true', '固定按钮没有进入按下态：' + a.pressed);
    must(a.panelRight >= a.viewport - 2, '面板没有贴住右边：' + a.panelRight + ' / ' + a.viewport);
    must(a.stored == null, '默认固定不该顺手写偏好：' + a.stored);

    /* 2) 切成浮层：页面恢复整宽，面板仍开着（盖上去），偏好记 0 */
    await toggle();
    a = await layout();
    must(!a.dock, '点一下之后还在固定态');
    must(a.inline === '', '浮层态还留着 #app 的让位宽度：' + a.inline);
    must(a.open, '切浮层把面板关掉了');
    must(a.pressed === 'false' && a.stored === '0', '浮层偏好没记下来：' + JSON.stringify(a));
    must(a.appRight > a.panelLeft, '浮层态页面的右边界应被面板盖住（让位宽度已撤）');

    /* 3) 再切回固定：偏好记 1，页面重新让位 */
    await toggle();
    a = await layout();
    must(a.dock && a.stored === '1' && a.appRight <= a.panelLeft + 1,
      '再切回固定没生效：' + JSON.stringify(a));

    /* 4) 刷新之后仍按固定打开（偏好只在本机，跨刷新有效；展开态本身不跨刷新） */
    await page.goto(proxy.base + '/shell.html?dock=1#favorites.html');
    await page.waitFor(() => !!(window.AiChat && window.AiChat.open), 25000, 100);
    await open();
    a = await layout();
    must(a.dock && a.stored === '1', '刷新后偏好丢了：' + JSON.stringify(a));

    /* 5) 窄窗口退回浮层：偏好仍是「固定」，但不挤页面；回到宽窗口自动恢复 */
    await page.setSize(800, 900);
    await h.sleep(300);
    a = await layout();
    must(!a.dock && a.inline === '', '800 宽窗口不该再挤页面：' + JSON.stringify(a));
    must(a.pressed === 'true', '窄窗口只是暂时浮层，偏好不该被改掉：' + a.pressed);
    must(/窄于 900/.test(a.title), '窄窗口的按钮 title 没说明为什么没挤：' + a.title);
    await page.setSize(1440, 900);
    await h.sleep(300);
    a = await layout();
    must(a.dock && a.appRight <= a.panelLeft + 1, '回到宽窗口没恢复固定：' + JSON.stringify(a));

    /* 6) 固定在右栏时页面仍然能操作：页面中心点到的是 #app 里的东西，不是面板 */
    const hit = await page.eval(() => {
      const x = Math.max(100, Math.round(document.getElementById('app').getBoundingClientRect().right) - 40);
      const el = document.elementFromPoint(x, 300);
      return { inApp: !!(el && el.closest('#app')), inPanel: !!(el && el.closest('#acPanel')), tag: el ? el.tagName : '' };
    });
    must(hit.inApp && !hit.inPanel, '固定态页面被面板盖住了（页面中心点到的是面板）：' + JSON.stringify(hit));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 助手固定右栏（页面让位 · 浮层互切 · 偏好跨刷新 · 窄窗回退 · 页面仍可点）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
