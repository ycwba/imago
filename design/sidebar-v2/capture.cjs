#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：
     node design/sidebar-v2/capture.cjs after    → 设计稿（两个形态）
     node design/sidebar-v2/capture.cjs all

   「before」那两张（真机 66px / 200px）是从上一稿目录拷过来的，
   源头是 design/sidebar-redesign/capture.cjs 的 before 段：
   跑隔离探针代理截的真机，拷的是真机 .data，一个字节都没写回真机。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

/* 真机 .data → 探针目录：整棵子树都拷（local-assets/index.json 在子目录里）。
   不拷 .proxy.lock 与 cache/。 */
function seed(dataDir) {
  const src = path.join(h.root, '.data');
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === '.proxy.lock' || e.name === 'cache') continue;
      const s = path.join(from, e.name), d = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); }
      else { try { fs.copyFileSync(s, d); n++; } catch (e) { /* 单个拷不动不算失败 */ } }
    }
  };
  fs.mkdirSync(dataDir, { recursive: true });
  copy(src, dataDir);
  return n;
}

/* 截一块区域（CSS 像素，2 倍图） */
async function clipShot(page, file, sel, scale) {
  const r = await page.eval(s => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + window.scrollX, y: b.top + window.scrollY, w: b.width, h: b.height };
  }, sel);
  if (!r || !r.w || !r.h) { console.log('截不到：' + sel); return null; }
  const res = await page.cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.ceil(r.w), height: Math.ceil(r.h), scale: scale || 2 },
  });
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log('  → ' + path.basename(file) + '（' + Math.ceil(r.w) + '×' + Math.ceil(r.h) + '）');
  return r;
}

async function hoverSel(page, sel) {
  const p = await page.eval(s => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  }, sel);
  if (!p) return false;
  await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await h.sleep(420);
  return true;
}

async function shotAfter() {
  const srv = await require(path.join(here, 'serve.cjs')).start(8095);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 1400);
    await page.goto(srv.base + 'index.html');
    await page.waitFor(() => !!document.querySelector('#sb .sb-item'), 15000);
    await h.sleep(500);

    const setForm = async f => {
      await page.eval(x => window.__sbSetForm(x), f);
      await h.sleep(420);
    };

    /* 两个形态各一张：整段外壳（侧栏 + 内容区占位） */
    for (const f of ['full', 'slim']) {
      await setForm(f);
      await clipShot(page, path.join(shots, 'after-' + f + '.png'), '.dg-shell');
    }
    /* 只截侧栏本身（看细节用） */
    for (const f of ['full', 'slim']) {
      await setForm(f);
      await clipShot(page, path.join(shots, 'after-side-' + f + '.png'), '.sb');
    }

    /* 窄形态 + 悬停名牌 */
    await setForm('slim');
    await hoverSel(page, '.sb-nav .sb-item[data-id="studio"]');
    await clipShot(page, path.join(shots, 'after-slim-tip.png'), '.dg-shell');

    /* 整页 + 底部对照 */
    await setForm('full');
    await page.screenshot(path.join(shots, 'after-page.png'));
    console.log('  → after-page.png（整页）');
    await clipShot(page, path.join(shots, 'after-compare.png'), '.dg-before');

    /* ---------- 夜间档：同一份稿子切 data-theme，没有另设计一版 ---------- */
    await page.eval(() => window.__sbSetTheme('dark'));
    await h.sleep(420);
    for (const f of ['full', 'slim']) {
      await setForm(f);
      await clipShot(page, path.join(shots, 'after-dark-' + f + '.png'), '.dg-shell');
    }
    await setForm('full');
    await page.screenshot(path.join(shots, 'after-dark-page.png'));
    console.log('  → after-dark-page.png（整页 · 深色档）');
    await page.eval(() => window.__sbSetTheme('light'));
    await h.sleep(300);

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：' + errs.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
    await srv.stop();
  }
}

/* ---------- 真机侧栏（两个形态）----------
   跑隔离探针代理：真机 .data 整棵子树拷进探针目录（一个字节都没写回真机），
   画面是真实内容（余额是真取回来的，OpenRouter 那家是真的取不到）。 */
async function shotReal() {
  const proxy = await h.startProxy();
  const browser = await h.launchBrowser();
  try {
    seed(proxy.dataDir);
    const page = await browser.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem('dir_theme', 'light'); localStorage.setItem('sb_open', '1'); } catch (e) {}
    });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => !!document.querySelector('.sidebar nav a'), 25000);
    await h.sleep(9000);
    const st = await page.eval(() => ({
      open: document.documentElement.classList.contains('sb-open'),
      sbw: getComputedStyle(document.documentElement).getPropertyValue('--sbw').trim(),
      cards: document.querySelectorAll('.sb-bal-card').length,
      dots: document.querySelectorAll('.sb-bal-dots i').length,
      sh: [...document.querySelectorAll('.sidebar nav a .sh')].map(e => e.textContent).join('/'),
    }));
    console.log('  真机满形态: ' + JSON.stringify(st));
    await clipShot(page, path.join(shots, 'real-full.png'), '.sidebar');
    await page.eval(() => { const l = document.querySelector('.sb-logo'); if (l) l.click(); return true; });
    await h.sleep(1500);
    const st2 = await page.eval(() => ({
      open: document.documentElement.classList.contains('sb-open'),
      sbw: getComputedStyle(document.documentElement).getPropertyValue('--sbw').trim(),
      dots: document.querySelectorAll('.sb-bal-dots i').length,
    }));
    console.log('  真机窄形态: ' + JSON.stringify(st2));
    await clipShot(page, path.join(shots, 'real-slim.png'), '.sidebar');
    await page.eval(() => { const l = document.querySelector('.sb-logo'); if (l) l.click(); return true; });
    await h.sleep(900);
    await page.screenshot(path.join(shots, 'real-page.png'));
    console.log('  → real-page.png（整屏 1440×900）');
    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('  页面报错: ' + errs.slice(0, 6).join(' | '));
  } finally {
    await browser.close();
    await proxy.stop();
  }
}

(async () => {
  const mode = process.argv[2] || 'after';
  if (mode === 'after' || mode === 'all') { console.log('—— 设计稿 ——'); await shotAfter(); }
  if (mode === 'real' || mode === 'all') { console.log('—— 真机 ——'); await shotReal(); }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
