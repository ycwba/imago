#!/usr/bin/env node
/* 设计稿自检（只为看稿子方便，不是产品的一部分）。
   用法：node design/sidebar-v2/check-demo.cjs

   判据：
     ① 稿子能打开，**没有一条控制台报错**
     ② 两个形态的宽度真的落地：满 232 / 窄 56
     ③ 满形态显完整名字，窄形态显两字短标签（**不靠悬停也认得出**）
     ④ 窄形态悬停出名牌（补全全名）
     ⑤ 收 / 展是顶行右端单独一颗按钮，点了就切
     ⑥ 导航六项、余额三行、底部两块都在
     ⑦ 导航行里**没有**任何行内数值（这一稿去掉了值速记）
     ⑧ 键盘 ← → 能切形态
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
  const srv = await require(path.join(here, 'serve.cjs')).start(8094);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 1400);
    await page.goto(srv.base + 'index.html');
    await page.waitFor(() => !!document.querySelector('#sb .sb-item'), 15000);
    await h.sleep(400);

    console.log('① 打开与报错');
    const errs = page.errors.filter(e => !/favicon/i.test(e));
    ok('控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    console.log('② 两个形态的宽度');
    const want = { full: 232, slim: 56 };
    for (const [f, w] of Object.entries(want)) {
      await page.eval(x => window.__sbSetForm(x), f);
      await h.sleep(320);
      const got = await page.eval(() => Math.round(document.querySelector('#sb').getBoundingClientRect().width));
      ok(f + ' 形态宽度 = ' + w + 'px', got === w, '实测 ' + got + 'px');
    }

    console.log('③ 名字怎么露出来');
    await page.eval(() => window.__sbSetForm('full'));
    await h.sleep(300);
    const inFull = await page.eval(() => {
      const a = document.querySelector('.sb-nav .sb-item[data-id="studio"]');
      const lb = a.querySelector('.sb-lb'), sh = a.querySelector('.sb-short');
      return {
        lb: getComputedStyle(lb).display !== 'none',
        sh: getComputedStyle(sh).display !== 'none',
        lbText: lb.textContent.trim(), shText: sh.textContent.trim(),
      };
    });
    ok('满形态：显示完整名字', inFull.lb && !inFull.sh, inFull.lbText);
    await page.eval(() => window.__sbSetForm('slim'));
    await h.sleep(300);
    const inSlim = await page.eval(() => {
      const a = document.querySelector('.sb-nav .sb-item[data-id="studio"]');
      const lb = a.querySelector('.sb-lb'), sh = a.querySelector('.sb-short');
      const r = sh.getBoundingClientRect();
      return {
        lb: getComputedStyle(lb).display !== 'none',
        sh: getComputedStyle(sh).display !== 'none',
        shText: sh.textContent.trim(),
        visible: sh.textContent.trim().length > 0 && r.height > 0 && r.width > 0,
        itemW: Math.round(a.getBoundingClientRect().width),
      };
    });
    ok('窄形态：完整名字收起来', !inSlim.lb);
    ok('窄形态：短标签常驻可见', inSlim.sh && inSlim.visible, inSlim.shText);
    ok('窄形态：短标签是两个字', inSlim.shText.length === 2, inSlim.shText);

    console.log('④ 窄形态的悬停名牌');
    await page.eval(() => window.__sbSetForm('slim'));
    await h.sleep(300);
    const tipBefore = await page.eval(() => document.querySelector('.sb-tip').classList.contains('on'));
    ok('默认不弹名牌', tipBefore === false);
    const pt = await page.eval(() => {
      const el = document.querySelector('.sb-nav .sb-item[data-id="studio"]');
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    });
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await h.sleep(400);
    const tip = await page.eval(() => {
      const t = document.querySelector('.sb-tip');
      return { on: t.classList.contains('on'), text: t.textContent.trim() };
    });
    ok('悬停后名牌出现', tip.on === true);
    ok('名牌补全全名', /生成工作台/.test(tip.text), tip.text);

    console.log('⑤ 收 / 展的开关（品牌砖）');
    const geom = {};
    for (const f of ['full', 'slim']) {
      await page.eval(x => window.__sbSetForm(x), f);
      await h.sleep(300);
      geom[f] = await page.eval(() => {
        const b = document.querySelector('#sbTile');
        const r = b.getBoundingClientRect();
        const sb = document.querySelector('#sb').getBoundingClientRect();
        const item = document.querySelector('.sb-nav .sb-item').getBoundingClientRect();
        const foot = document.querySelector('.sb-foot .sb-item').getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          top: Math.round(r.top - sb.top), left: Math.round(r.left - sb.left),
          tag: b.tagName, text: b.textContent.trim(), title: b.title,
          navH: Math.round(item.height), footH: Math.round(foot.height),
        };
      });
    }
    ok('收 / 展的开关是那块品牌砖（一个真按钮）', geom.full.tag === 'BUTTON' && geom.full.text === 'AI',
      { tag: geom.full.tag, text: geom.full.text });
    ok('两个形态里是同一块砖（同宽同高）', geom.full.w === geom.slim.w && geom.full.h === geom.slim.h,
      geom.full.w + '×' + geom.full.h + ' / ' + geom.slim.w + '×' + geom.slim.h);
    ok('两个形态里位置也一致（同一行、同一左边界）', geom.full.top === geom.slim.top && geom.full.left === geom.slim.left,
      { full: { top: geom.full.top, left: geom.full.left }, slim: { top: geom.slim.top, left: geom.slim.left } });
    ok('侧栏里没有第二样收展标识（没有箭头按钮）', await page.eval(() =>
      !document.querySelector('.sb-toggle') && !document.querySelector('#sbToggle')), {});
    ok('两个形态的导航行高一样', geom.full.navH === geom.slim.navH, geom.full.navH + ' / ' + geom.slim.navH);
    ok('两个形态的底部行高一样', geom.full.footH === geom.slim.footH, geom.full.footH + ' / ' + geom.slim.footH);

    await page.eval(() => window.__sbSetForm('full'));
    await h.sleep(250);
    await page.eval(() => document.querySelector('#sbTile').click());
    await h.sleep(320);
    const afterTg = await page.eval(() => ({
      form: document.querySelector('#sb').dataset.form,
      w: Math.round(document.querySelector('#sb').getBoundingClientRect().width),
    }));
    ok('点品牌砖就切形态', afterTg.form === 'slim' && afterTg.w === 56, afterTg.form + ' / ' + afterTg.w + 'px');

    console.log('⑥ 窄形态的余额与落盘进度');
    await page.eval(() => window.__sbSetForm('slim'));
    await h.sleep(320);
    const slimLive = await page.eval(() => {
      const dots = [...document.querySelectorAll('.sb-dots i')];
      const bar = document.querySelector('.sb-slim-mirror .sb-mirror-bar');
      const n = document.querySelector('.sb-slim-mirror .sb-mirror-n');
      const r = bar.getBoundingClientRect();
      return {
        dots: dots.length,
        ok: dots.filter(d => d.classList.contains('ok')).length,
        bad: dots.filter(d => d.classList.contains('bad')).length,
        title: dots.length ? document.querySelector('.sb-dots').title : '',
        barH: Math.round(r.height), barW: Math.round(r.width),
        fill: bar.querySelector('i').style.width,
        n: n ? n.textContent.trim() : '',
      };
    });
    ok('窄形态画得出每家一个状态点', slimLive.dots === 3, slimLive.dots + ' 个点');
    ok('点分得出取到 / 取不到', slimLive.ok === 2 && slimLive.bad === 1,
      slimLive.ok + ' 取到 / ' + slimLive.bad + ' 取不到');
    ok('点上有说明（悬停能读到）', /取不到/.test(slimLive.title) && /OpenRouter/.test(slimLive.title), slimLive.title);
    ok('落盘进度条画出来了', slimLive.barH >= 3 && slimLive.barW > 0 && /%$/.test(slimLive.fill),
      slimLive.barW + '×' + slimLive.barH + ' 满 ' + slimLive.fill);
    ok('进度旁边有份数', /\d+\/\d+/.test(slimLive.n), slimLive.n);

    console.log('⑦ 内容齐不齐');
    const cnt = await page.eval(() => ({
      nav: document.querySelectorAll('.sb-nav .sb-item').length,
      bal: document.querySelectorAll('.sb-bal-row').length,
      foot: document.querySelectorAll('.sb-foot .sb-item').length,
    }));
    ok('导航六项', cnt.nav === 6, String(cnt.nav));
    ok('余额三行', cnt.bal === 3, String(cnt.bal));
    ok('底部两块', cnt.foot === 2, String(cnt.foot));

    console.log('⑦ 导航行里没有行内数值');
    const badges = await page.eval(() => Array.from(document.querySelectorAll('.sb-nav .sb-item'))
      .map(a => a.innerText.replace(/\s+/g, ' ').trim()).filter(t => /\d/.test(t)));
    ok('导航行没有出现数字', badges.length === 0, badges.join(' | '));

    console.log('⑧ 键盘');
    await page.eval(() => window.__sbSetForm('full'));
    await h.sleep(250);
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await h.sleep(320);
    const kb = await page.eval(() => document.querySelector('#sb').dataset.form);
    ok('→ 能切形态', kb === 'slim', '现在是 ' + kb);

    const errs2 = page.errors.filter(e => !/favicon/i.test(e));
    ok('跑完仍然没有报错', errs2.length === 0, errs2.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await srv.stop();
  }
  console.log(bad ? '\n没过 ' + bad + ' 条。' : '\n全过。');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
