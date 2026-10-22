#!/usr/bin/env node
/* 助手的两档摆法：
   · 缺省 = 浮层（贴着悬浮球的小浮窗，宽高可拖、可拖走；拖走后不再跟球）；
   · 点「固定到右侧」= 页面让出右边那一条，面板撑满一列（球让位、没有下沿把手）。
   偏好只在本机（ai_chat_dock），窄于 900px 时固定档退回浮层、偏好不改。 */
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
      const ball = document.getElementById('acBall');
      const ar = app.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const br = ball.getBoundingClientRect();
      const dock = document.getElementById('acDock');
      const gb = document.getElementById('acGripB');
      return {
        dock: document.documentElement.classList.contains('ac-dock'),
        open: document.documentElement.classList.contains('ac-open'),
        inline: app.style.width,
        appRight: Math.round(ar.right),
        panelLeft: Math.round(pr.left), panelTop: Math.round(pr.top),
        panelRight: Math.round(pr.right), panelBottom: Math.round(pr.bottom),
        panelW: Math.round(pr.width), panelH: Math.round(pr.height),
        ballLeft: Math.round(br.left), ballTop: Math.round(br.top),
        ballRight: Math.round(br.right), ballBottom: Math.round(br.bottom),
        ballW: Math.round(br.width),
        pressed: dock ? dock.getAttribute('aria-pressed') : '',
        title: dock ? dock.title : '',
        stored: localStorage.getItem('ai_chat_dock'),
        storedW: localStorage.getItem('ai_chat_w'),
        storedH: localStorage.getItem('ai_chat_h'),
        fxy: localStorage.getItem('ai_chat_fxy'),
        gripB: gb ? getComputedStyle(gb).display : 'missing',
        viewport: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    const open = async () => {
      await page.eval(() => window.AiChat.open());
      await page.waitFor(() => document.documentElement.classList.contains('ac-open'), 8000, 80);
      await h.sleep(260);   // 面板的 transform / opacity 过渡
    };
    const toggle = async () => {
      await page.eval(() => document.getElementById('acDock').click());
      await h.sleep(260);   // #app 的 width 过渡与浮窗摆位
    };
    /* 浮窗默认落在球旁边：横向、纵向各有一边相隔 8px（球左上 / 左下 / 右上 / 右下四选一）。 */
    const gapOf = a => ({
      x: Math.min(Math.abs(a.panelRight - a.ballLeft), Math.abs(a.panelLeft - a.ballRight)),
      y: Math.min(Math.abs(a.panelBottom - a.ballTop), Math.abs(a.panelTop - a.ballBottom)),
    });
    const nearBall = a => { const g = gapOf(a); return g.x <= 12 && g.y <= 12; };
    const inView = a => a.panelLeft >= 0 && a.panelTop >= 0 && a.panelRight <= a.viewport && a.panelBottom <= a.vh;
    const ptr = (sel, dx, dy) => page.eval((sel, dx, dy) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('找不到拖动把手：' + sel);
      const r = el.getBoundingClientRect();
      const x = r.left + Math.max(2, r.width / 2), y = r.top + Math.max(2, r.height / 2);
      const fire = (type, px, py) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
      fire('pointerdown', x, y);
      fire('pointermove', x + dx, y + dy);
      fire('pointerup', x + dx, y + dy);
    }, sel, dx, dy);

    /* 1) 宽窗口、从没点过「固定」：打开的是球旁浮窗 */
    await open();
    let a = await layout();
    must(!a.dock, '1440 宽窗口、偏好未设时不该固定（缺省是浮层）：' + JSON.stringify(a));
    must(a.open, '助手没打开');
    must(a.inline === '', '浮层态不该给 #app 写让位宽度：' + a.inline);
    must(a.stored == null, '缺省浮层不该顺手写偏好：' + a.stored);
    must(a.pressed === 'false', '固定按钮没有进入未按下态：' + a.pressed);
    must(nearBall(a), '浮窗没落在球旁边：' + JSON.stringify({ gap: gapOf(a), a }));
    must(a.panelRight <= a.viewport - 8, '浮窗贴在视口右缘（应当是球旁的小窗）：' + a.panelRight + ' / ' + a.viewport);
    must(a.ballW > 0, '悬浮档里球被藏起来了：' + a.ballW);
    must(a.gripB !== 'none', '悬浮档没有下沿把手：' + a.gripB);
    must(inView(a), '浮窗越出视口：' + JSON.stringify(a));

    /* 2) 点「固定」：页面让出右边，面板撑满一列；球让位、下沿把手不画 */
    await toggle();
    a = await layout();
    must(a.dock && a.stored === '1', '点「固定」没生效或偏好没记 1：' + JSON.stringify(a));
    must(/calc\(100% - var\(--sbw/.test(a.inline), '固定态没有给 #app 写让位宽度：' + a.inline);
    must(a.appRight <= a.panelLeft + 1, '页面与面板重叠了：appRight=' + a.appRight + ' panelLeft=' + a.panelLeft);
    must(a.panelRight >= a.viewport - 2, '固定态面板没有贴住右边：' + a.panelRight + ' / ' + a.viewport);
    must(a.pressed === 'true', '固定按钮没有进入按下态：' + a.pressed);
    must(a.ballW === 0, '固定档里球应当让位：' + a.ballW);
    must(a.gripB === 'none', '固定档不该画下沿把手：' + a.gripB);

    /* 3) 再点一次：回到球旁浮窗，页面恢复整宽 */
    await toggle();
    a = await layout();
    must(!a.dock && a.stored === '0', '切回浮层没生效或偏好没记 0：' + JSON.stringify(a));
    must(a.inline === '', '浮层态还留着 #app 的让位宽度：' + a.inline);
    must(a.open, '切浮层把面板关掉了');
    must(a.ballW > 0, '浮层态球该回来：' + a.ballW);
    must(nearBall(a), '切回浮层后没有回到球旁边：' + JSON.stringify({ gap: gapOf(a), a }));
    must(inView(a), '浮窗越出视口：' + JSON.stringify(a));

    /* 4) 宽高可拖：左沿调宽、下沿调高，都记在本机 */
    const beforeW = await layout();
    await ptr('#acGrip', -80, 0);
    await h.sleep(80);
    const afterW = await layout();
    must(afterW.panelW >= beforeW.panelW + 60, '拖左沿没把浮窗调宽：' + beforeW.panelW + ' → ' + afterW.panelW);
    must(Number(afterW.storedW) === afterW.panelW, '调宽没落进 ai_chat_w：' + afterW.storedW + ' / ' + afterW.panelW);
    must(inView(afterW), '调宽后浮窗越出视口：' + JSON.stringify(afterW));

    const beforeH = await layout();
    await ptr('#acGripB', 0, 70);
    await h.sleep(80);
    const afterH = await layout();
    must(afterH.panelH >= beforeH.panelH + 50, '拖下沿没把浮窗调高：' + beforeH.panelH + ' → ' + afterH.panelH);
    must(Number(afterH.storedH) === afterH.panelH, '调高没落进 ai_chat_h：' + afterH.storedH + ' / ' + afterH.panelH);
    must(inView(afterH), '调高后浮窗越出视口：' + JSON.stringify(afterH));

    /* 5) 球动了浮窗跟着（还没拖走过，没有 ai_chat_fxy） */
    const b0 = await layout();
    must(b0.fxy == null, '还没拖浮窗就写下了 ai_chat_fxy：' + b0.fxy);
    await ptr('#acBall', -90, -70);
    await h.sleep(120);
    const b1 = await layout();
    must(b1.ballLeft !== b0.ballLeft || b1.ballTop !== b0.ballTop, '球没被拖动：' + JSON.stringify({ b0, b1 }));
    must(b1.panelLeft !== b0.panelLeft || b1.panelTop !== b0.panelTop, '球移动后浮窗没跟着：' + JSON.stringify({ b0, b1 }));
    must(nearBall(b1), '跟着球之后浮窗没贴住球：' + JSON.stringify({ gap: gapOf(b1), b1 }));
    must(inView(b1), '跟球后浮窗越出视口：' + JSON.stringify(b1));

    /* 6) 拖走浮窗：记 ai_chat_fxy，此后球再动它也不动 */
    const p0 = await layout();
    await ptr('.ac-hd', -120, 80);
    /* 真实浏览器在 pointerup 后会补发一枚 click（拖完那一下由面板吃掉）；合成的 PointerEvent 不会，
       这里补上，否则「拖动过」的旗标会挂到下一次真点击上。 */
    await page.eval(() => document.querySelector('.ac-hd').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await h.sleep(120);
    const p1 = await layout();
    must(p1.fxy != null, '拖走浮窗后没记 ai_chat_fxy：' + p1.fxy);
    must(p1.panelLeft !== p0.panelLeft || p1.panelTop !== p0.panelTop,
      '拖标题栏没挪动浮窗：' + JSON.stringify({ p0, p1 }));
    must(p1.open && !p1.dock, '拖浮窗时把它关掉或切档了：' + JSON.stringify({ p1 }));
    must(inView(p1), '拖走后浮窗越出视口：' + JSON.stringify(p1));
    const p2 = await layout();
    await ptr('#acBall', 60, -40);
    await h.sleep(120);
    const p3 = await layout();
    must(p3.ballLeft !== p2.ballLeft || p3.ballTop !== p2.ballTop, '第二次拖球没动：' + JSON.stringify({ p2, p3 }));
    must(p3.panelLeft === p2.panelLeft && p3.panelTop === p2.panelTop,
      '浮窗已经拖走却还跟着球：' + JSON.stringify({ p2, p3 }));

    /* 删掉 ai_chat_fxy = 回到跟球：球再动，浮窗重新贴上去 */
    await page.eval(() => localStorage.removeItem('ai_chat_fxy'));
    await ptr('#acBall', -40, -20);
    await h.sleep(120);
    const p4 = await layout();
    must(p4.panelLeft !== p3.panelLeft || p4.panelTop !== p3.panelTop,
      '清掉 ai_chat_fxy 后浮窗没有回到跟球：' + JSON.stringify({ p3, p4 }));
    must(nearBall(p4), '重新跟球后没贴住球：' + JSON.stringify({ gap: gapOf(p4), p4 }));

    /* 7) 刷新后仍按偏好打开：先切回固定（偏好=1），刷新，再打开仍是固定 */
    await toggle();
    a = await layout();
    must(a.dock && a.stored === '1', '切回固定失败：' + JSON.stringify(a));
    await page.goto(proxy.base + '/shell.html?dock=1#favorites.html');
    await page.waitFor(() => !!(window.AiChat && window.AiChat.open), 25000, 100);
    await open();
    a = await layout();
    must(a.dock && a.stored === '1', '刷新后偏好丢了：' + JSON.stringify(a));

    /* 8) 窄窗口退回浮层：偏好仍是「固定」，但不挤页面；浮窗仍在视口内 */
    await page.setSize(800, 900);
    await h.sleep(300);
    a = await layout();
    must(!a.dock && a.inline === '', '800 宽窗口不该再挤页面：' + JSON.stringify(a));
    must(a.pressed === 'true', '窄窗口只是暂时浮层，偏好不该被改掉：' + a.pressed);
    must(/窄于 900/.test(a.title), '窄窗口的按钮 title 没说明为什么没挤：' + a.title);
    must(inView(a), '800 宽窗口里浮窗越出视口：' + JSON.stringify(a));
    must(nearBall(a), '窄窗口退回浮层后没贴住球：' + JSON.stringify({ gap: gapOf(a), a }));
    await page.setSize(1440, 900);
    await h.sleep(300);
    a = await layout();
    must(a.dock && a.appRight <= a.panelLeft + 1, '回到宽窗口没恢复固定：' + JSON.stringify(a));

    /* 9) 固定在右栏时页面仍然能操作：页面中心点到的是 #app 里的东西，不是面板 */
    const hit = await page.eval(() => {
      const x = Math.max(100, Math.round(document.getElementById('app').getBoundingClientRect().right) - 40);
      const el = document.elementFromPoint(x, 300);
      return { inApp: !!(el && el.closest('#app')), inPanel: !!(el && el.closest('#acPanel')), tag: el ? el.tagName : '' };
    });
    must(hit.inApp && !hit.inPanel, '固定态页面被面板盖住了（页面中心点到的是面板）：' + JSON.stringify(hit));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 助手两档（缺省球旁浮窗 · 宽高可拖 · 可拖走脱离球 · 固定档页面让位 · 窄窗回退）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
