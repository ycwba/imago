#!/usr/bin/env node
/* 拖一张素材卡到悬浮球 = 引用这一条（不是上传）：
   ① 卡片 draggable、dragstart 写进去的载荷里有号或地址（防「有类型、没载荷」）；
   ② 面板**收起**时拖到球就能引用并打开面板（不用先点开窗口）；
   ③ 球是浮层、贴在球旁边；输入框里出现 `[引用素材：…]` 且高亮可删；
   ④ 拖外部文件到球走的是上传（文件进附件队列），输入框里不多出引用；
   ⑤ 拖卡片经过球时球自己不动。 */
'use strict';
const h = require('./harness.cjs');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA = 'data:image/png;base64,' + PNG;

let n = 0;
function must(cond, msg) { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();

    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Store && !!window.Chars, 20000, 100);
    await page.eval((data) => {
      localStorage.setItem('ai_chat_dock', '0');          // 钉成浮层：这台机器上次点过「固定」也不算坏
      localStorage.removeItem('ai_chat_fxy');
      localStorage.setItem('char_lib', JSON.stringify({ data: [{
        id: 'c_ref', name: '引用探针', kind: 'char', face: data, anchor: data,
        bio: '海边来的人', look: '短发、浅色外套', group: '探针组',
      }], ts: Date.now() }));
    }, DATA);
    await page.goto(proxy.base + '/shell.html#chars.html');
    await page.waitFor(() => !!(window.AiChat && window.AiChat.open), 25000, 100);
    await page.waitFor(() => !!document.querySelector('.chars-page .card[data-id="c_ref"]'), 20000, 120);
    await h.sleep(200);

    /* ---------- 1) 卡片可拖；载荷里有号（或地址），不是空壳 ---------- */
    const got = await page.eval(() => {
      const card = document.querySelector('.chars-page .card[data-id="c_ref"]');
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const ref = window.AssetRef.read(dt);
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return {
        draggable: card.draggable,
        types: [...dt.types],
        mime: window.AssetRef.MIME,
        hasMime: dt.types.indexOf(window.AssetRef.MIME) >= 0,
        plain: dt.getData('text/plain'),
        ref,
        open: document.documentElement.classList.contains('ac-open'),
      };
    });
    must(got.draggable === true, '素材卡不是 draggable：' + JSON.stringify(got));
    must(got.hasMime, 'dragstart 没写进 application/x-studio-ref：' + JSON.stringify(got.types));
    must(got.ref && (got.ref.assetId || got.ref.src), '载荷里号与地址都是空（有类型、没载荷）：' + JSON.stringify(got));
    must(got.ref && got.ref.name === '引用探针' && got.ref.from === 'chars', '载荷字段不对：' + JSON.stringify(got.ref));
    must(!!got.plain, '纯文本那一档是空的（拖到地址栏会什么都没）：' + JSON.stringify(got));
    must(!got.open, '还没拖到球上，面板不该已经打开');

    /* ---------- 2) 面板收起时拖到球：高亮、球不动、引用进输入框 ---------- */
    const drop = await page.eval(async () => {
      const card = document.querySelector('.chars-page .card[data-id="c_ref"]');
      const ball = document.getElementById('acBall');
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const b0 = ball.getBoundingClientRect();
      const fire = (el, type, extra) => el.dispatchEvent(new DragEvent(type,
        Object.assign({ bubbles: true, cancelable: true, dataTransfer: dt }, extra || {})));
      fire(ball, 'dragenter');
      fire(ball, 'dragover', { clientX: b0.left + 10, clientY: b0.top + 10 });
      const lit = ball.classList.contains('ac-drop');
      const b1 = ball.getBoundingClientRect();
      fire(ball, 'drop', { clientX: b0.left + 10, clientY: b0.top + 10 });
      fire(card, 'dragend');
      await new Promise(r => setTimeout(r, 300));   // 面板打开 + 一次 rAF 的高亮重画
      const ta = document.getElementById('acTa');
      const panel = document.getElementById('acPanel');
      const pr = panel.getBoundingClientRect();
      const b2 = ball.getBoundingClientRect();
      const layer = document.getElementById('acRefLayer');
      const x = document.querySelector('.ac-ref-x');
      const cs = getComputedStyle(ta);
      const chips = document.querySelectorAll('#acFiles .ac-fi').length;
      return {
        lit, litAfter: ball.classList.contains('ac-drop'),
        moved: Math.abs(b1.left - b0.left) > 0.5 || Math.abs(b1.top - b0.top) > 0.5,
        ballStable: Math.abs(b2.left - b0.left) <= 0.5 && Math.abs(b2.top - b0.top) <= 0.5,
        open: document.documentElement.classList.contains('ac-open'),
        dock: document.documentElement.classList.contains('ac-dock'),
        value: ta.value,
        files: chips, filesHidden: document.getElementById('acFiles').hidden,
        hl: document.querySelectorAll('.ac-ref-hl').length,
        hasX: !!x, xTab: x ? x.getAttribute('tabindex') : '',
        layerPE: layer ? getComputedStyle(layer).pointerEvents : '',
        color: cs.color, opacity: cs.opacity,
        panel: { left: pr.left, top: pr.top, right: pr.right, bottom: pr.bottom },
        ball: { left: b2.left, top: b2.top, right: b2.right, bottom: b2.bottom },
        vw: window.innerWidth, vh: window.innerHeight,
        refs: Array.from(document.querySelectorAll('#acRefLayer .ac-ref-hl')).length,
        taValue: ta.value,
      };
    });
    must(drop.lit === true, '拖到球上时球没高亮：' + JSON.stringify(drop));
    must(drop.moved === false && drop.ballStable === true, '拖卡片经过球时球被挪动了：' + JSON.stringify(drop));
    must(drop.litAfter === false, '松手之后高亮没去掉：' + JSON.stringify(drop));
    must(drop.open === true && drop.dock === false, '拖到球上没有打开浮层（面板收起是这次的核心路径）：' + JSON.stringify(drop));
    must(/\[引用素材：[^\]\n]+/.test(drop.value), '输入框里没有 [引用素材：…]：' + JSON.stringify(drop.value));
    must(/引用探针|短发、浅色外套/.test(drop.value), '引用行里没有这一条的名字或描述：' + JSON.stringify(drop.value));
    must(drop.hl >= 1 && drop.hasX, '输入框里没画出引用高亮与删除钮：' + JSON.stringify(drop));
    must(drop.xTab === '-1', '删除钮不该进 Tab 序列（textarea 的焦点不能被它抢走）：' + drop.xTab);
    must(drop.layerPE === 'none', '高亮层会挡住输入框的点击：' + drop.layerPE);
    must(drop.opacity === '1' && !/rgba\([^)]*,\s*0\)|transparent/.test(drop.color),
      '文字被画成了透明（高亮盖住了正文）：' + JSON.stringify({ color: drop.color, opacity: drop.opacity }));
    must(drop.files === 0 && drop.filesHidden === true, '引用被当成上传了（附件队列里多出文件）：' + JSON.stringify({ files: drop.files }));
    const gapX = Math.min(Math.abs(drop.panel.right - drop.ball.left), Math.abs(drop.panel.left - drop.ball.right));
    const gapY = Math.min(Math.abs(drop.panel.bottom - drop.ball.top), Math.abs(drop.panel.top - drop.ball.bottom));
    must(gapX <= 12 && gapY <= 12, '浮窗没贴在球旁边：' + JSON.stringify({ gapX, gapY, panel: drop.panel, ball: drop.ball }));
    must(drop.panel.left >= 0 && drop.panel.top >= 0 && drop.panel.right <= drop.vw && drop.panel.bottom <= drop.vh,
      '浮窗越出视口：' + JSON.stringify(drop.panel));

    /* ---------- 3) 拖外部文件到球 = 上传，不是引用 ---------- */
    const ext = await page.eval(async png => {
      const bin = atob(png);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'outside-ref-probe.png', { type: 'image/png' }));
      const ball = document.getElementById('acBall');
      const ta = document.getElementById('acTa');
      const before = ta.value;
      ball.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const lit = ball.classList.contains('ac-drop');
      ball.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      for (let i = 0; i < 80 && !document.querySelectorAll('#acFiles .ac-fi').length; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      return { lit, before, after: ta.value, chips: document.querySelectorAll('#acFiles .ac-fi').length,
        hidden: document.getElementById('acFiles').hidden };
    }, PNG);
    must(ext.lit === false, '拖外部文件时球点亮成了「引用」：' + JSON.stringify(ext));
    must(ext.after === ext.before, '拖外部文件被写成了引用文字：' + JSON.stringify(ext));
    must(ext.chips === 1 && ext.hidden === false, '外部文件没进附件队列（被当成引用吞了）：' + JSON.stringify(ext));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 拖素材到球（卡片可拖 · 载荷有号 · 面板收起时可直接引用 · 高亮可删 · 浮层贴球 · 外部文件仍走上传 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
