#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：
     node design/sidebar-redesign/capture.cjs before   → 真机侧栏（改造前）
     node design/sidebar-redesign/capture.cjs after    → 设计稿（改造后）
     node design/sidebar-redesign/capture.cjs all

   「before」跑的是隔离探针代理（tests/e2e/harness.cjs）：另起一份 .data 探针目录，
   把真机 .data 整棵子树拷进去当底稿 —— 画面是**真实内容**（余额卡、角色、产物都是真的），
   但一个字节都没写回真机目录；跑完探针目录自动删掉。

   截图落在 design/sidebar-redesign/shots/ 下。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const root = h.root;
const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

/* 真机 .data → 探针目录：整棵子树都拷（local-assets/index.json 在子目录里）。
   不拷 .proxy.lock 与 cache/。 */
function seed(dataDir) {
  const src = path.join(root, '.data');
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

/* 截一块区域（CSS 像素，2 倍图）。clip 用的是**文档坐标**，所以要把滚动量加回去。 */
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

/* ============================================================================
   改造前：真机
   ========================================================================== */
async function shotBefore() {
  const proxy = await h.startProxy();
  try {
    const n = seed(proxy.dataDir);
    console.log('已拷入真机 .data：' + n + ' 个文件 → ' + proxy.dataDir);

    const browser = await h.launchBrowser();
    const page = await browser.newPage();
    /* 浅色档 + 收起态（产品在 localStorage 里记着这个偏好）；
       必须在任何页面脚本之前改掉，主题是 shell-boot.js 读 localStorage 的。 */
    await page.addInitScript(() => {
      try {
        localStorage.setItem('dir_theme', 'light');
        localStorage.setItem('sb_open', '0');
      } catch (e) {}
    });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => !!document.querySelector('.sidebar nav a'), 25000);
    /* 余额区要出网问平台，等它落定 */
    await h.sleep(9000);

    const st = await page.eval(() => ({
      open: document.documentElement.classList.contains('sb-open'),
      narrow: document.documentElement.classList.contains('sb-narrow'),
      w: document.querySelector('.sidebar').getBoundingClientRect().width,
      cards: document.querySelectorAll('.sb-bal-card').length,
      sum: !!document.querySelector('.sb-bal-sum'),
    }));
    console.log('真机侧栏状态：' + JSON.stringify(st));

    await clipShot(page, path.join(shots, 'before-rail.png'), '.sidebar');
    await page.screenshot(path.join(shots, 'before-page-rail.png'));
    console.log('  → before-page-rail.png（整屏 1440×900）');

    /* 展开：点左上角那个 AI 方块（真机唯一的开关就在那儿） */
    await page.eval(() => { const el = document.querySelector('.sb-logo'); if (el) el.click(); });
    await h.sleep(2500);
    const st2 = await page.eval(() => ({
      open: document.documentElement.classList.contains('sb-open'),
      w: document.querySelector('.sidebar').getBoundingClientRect().width,
      cards: document.querySelectorAll('.sb-bal-card').length,
    }));
    console.log('展开后：' + JSON.stringify(st2));
    await clipShot(page, path.join(shots, 'before-open.png'), '.sidebar');
    await page.screenshot(path.join(shots, 'before-page-open.png'));
    console.log('  → before-page-open.png（整屏 1440×900）');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('页面报错：' + errs.slice(0, 5).join(' | '));
    await browser.close();
  } finally {
    await proxy.stop();
    console.log('探针已清理');
  }
}

/* ============================================================================
   改造后：设计稿
   ========================================================================== */
async function shotAfter() {
  const srv = await require(path.join(here, 'serve.cjs')).start(8097);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 1400);
    await page.goto(srv.base + 'index.html');
    await page.waitFor(() => !!document.querySelector('#sb .sb-item'), 15000);
    await h.sleep(500);

    const setMode = async m => {
      await page.eval(x => window.__sbSetMode(x), m);
      await h.sleep(420);
    };

    /* 三档各一张：整段外壳（侧栏 + 内容区占位） */
    for (const m of ['rail', 'column', 'shelf']) {
      await setMode(m);
      await clipShot(page, path.join(shots, 'after-' + m + '.png'), '.dg-shell');
    }
    /* 三档各一张：只截侧栏本身（看细节用） */
    for (const m of ['rail', 'column', 'shelf']) {
      await setMode(m);
      await clipShot(page, path.join(shots, 'after-side-' + m + '.png'), '.sb');
    }

    /* 轨态 + 悬停预告卡 */
    await setMode('rail');
    await hoverSel(page, '#sbNav .sb-item[data-id="studio"]');
    await clipShot(page, path.join(shots, 'after-rail-peek.png'), '.dg-shell');

    /* 整页 */
    await setMode('shelf');
    await page.screenshot(path.join(shots, 'after-page.png'));
    console.log('  → after-page.png（整页）');

    /* 稿子底部那段「改造前 · 真机截图」并排对照 */
    await clipShot(page, path.join(shots, 'after-compare.png'), '.dg-before');

    /* ---------- 夜间档：同一份稿子把 data-theme 换成 dark，没有另设计一版 ---------- */
    await page.eval(() => window.__sbSetTheme('dark'));
    await h.sleep(420);
    for (const m of ['rail', 'column', 'shelf']) {
      await setMode(m);
      await clipShot(page, path.join(shots, 'after-dark-' + m + '.png'), '.dg-shell');
    }
    await setMode('shelf');
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

(async () => {
  const mode = process.argv[2] || 'all';
  if (mode === 'before' || mode === 'all') { console.log('—— 改造前（真机）——'); await shotBefore(); }
  if (mode === 'after' || mode === 'all') { console.log('—— 改造后（设计稿）——'); await shotAfter(); }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
