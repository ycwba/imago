#!/usr/bin/env node
/* 设计稿自检（只为看稿子方便，不是产品的一部分）。
   用法：node design/sidebar-redesign/check-demo.cjs

   判据：
     ① 稿子能打开，**没有一条控制台报错**（真机的前端错误不许带进稿子）
     ② 三档宽度真的落地：60 / 196 / 256
     ③ 轨态悬停出预告卡，且预告卡上有名字、有说明、有现状
     ④ 刻度拉片三档都在，点一下就切
     ⑤ 导航六项、余额三行都在
     ⑥ 键盘 ← → 能切档
   退出码非 0 = 有判据没过。 */
'use strict';
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
let bad = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? '  —— ' + detail : ''));
  if (!cond) bad++;
};

(async () => {
  const srv = await require(path.join(here, 'serve.cjs')).start(8096);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 1100);
    await page.goto(srv.base + 'index.html');
    await page.waitFor(() => !!document.querySelector('#sb .sb-item'), 15000);
    await h.sleep(400);

    console.log('① 打开与报错');
    const errs = page.errors.filter(e => !/favicon/i.test(e));
    ok('控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    console.log('② 三档宽度');
    const want = { rail: 60, column: 196, shelf: 256 };
    for (const [m, w] of Object.entries(want)) {
      await page.eval(x => window.__sbSetMode(x), m);
      await h.sleep(320);
      const got = await page.eval(() => Math.round(document.querySelector('#sb').getBoundingClientRect().width));
      ok(m + ' 档宽度 = ' + w + 'px', got === w, '实测 ' + got + 'px');
    }

    console.log('③ 预告卡');
    await page.eval(() => window.__sbSetMode('rail'));
    await h.sleep(300);
    const before = await page.eval(() => {
      const p = document.querySelector('.sb-peek');
      return { on: p.classList.contains('on'), text: p.innerText.replace(/\s+/g, ' ').trim() };
    });
    ok('轨态默认不弹预告卡', before.on === false);
    const pt = await page.eval(() => {
      const el = document.querySelector('#sbNav .sb-item[data-id="studio"]');
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    });
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await h.sleep(400);
    const after = await page.eval(() => {
      const p = document.querySelector('.sb-peek');
      const r = p.getBoundingClientRect();
      return {
        on: p.classList.contains('on'),
        text: p.innerText.replace(/\s+/g, ' ').trim(),
        left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width),
      };
    });
    ok('悬停后预告卡出现', after.on === true);
    ok('预告卡上有名字', /生成工作台/.test(after.text), after.text);
    ok('预告卡上有说明与现状', /图片/.test(after.text) && /平台/.test(after.text), after.text);
    ok('预告卡落在侧栏右侧之外', after.left >= 60, 'left=' + after.left);

    console.log('④ 刻度拉片');
    const g = await page.eval(() => {
      const bs = [...document.querySelectorAll('#gauge button')];
      return { n: bs.length, modes: bs.map(b => b.dataset.mode), cur: bs.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.mode) };
    });
    ok('拉片有三档', g.n === 3, g.modes.join('/'));
    ok('当前档被标出来了', g.cur.length === 1, g.cur.join('/'));
    await page.eval(() => { const b = document.querySelector('#gauge button[data-mode="shelf"]'); b.click(); });
    await h.sleep(320);
    const afterG = await page.eval(() => ({
      w: Math.round(document.querySelector('#sb').getBoundingClientRect().width),
      cur: [...document.querySelectorAll('#gauge button')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.mode),
    }));
    ok('点拉片能切档', afterG.w === 256 && afterG.cur[0] === 'shelf', 'w=' + afterG.w);

    console.log('⑤ 内容齐不齐');
    const cnt = await page.eval(() => ({
      nav: document.querySelectorAll('#sbNav .sb-item').length,
      bal: document.querySelectorAll('.sb-bal-row').length,
      foot: document.querySelectorAll('.sb-foot .sb-item').length,
    }));
    ok('导航六项', cnt.nav === 6, String(cnt.nav));
    ok('余额三行', cnt.bal === 3, String(cnt.bal));
    ok('底部两块', cnt.foot === 2, String(cnt.foot));

    console.log('⑥ 键盘');
    await page.eval(() => document.body.focus());
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await h.sleep(320);
    const kb = await page.eval(() => document.querySelector('#sb').dataset.mode);
    ok('← 能往窄切', kb !== 'shelf', '现在是 ' + kb);

    const errs2 = page.errors.filter(e => !/favicon/i.test(e));
    ok('跑完仍然没有报错', errs2.length === 0, errs2.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await srv.stop();
  }
  console.log(bad ? '\n没过 ' + bad + ' 条。' : '\n全过。');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
