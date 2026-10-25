#!/usr/bin/env node
/* 设计稿截图脚本（只为看稿子方便，不是产品的一部分）。
   用法：
     node design/settings-layout/capture.cjs before   → 真机设置页（改造前）
     node design/settings-layout/capture.cjs after    → 设计稿（改造后）
     node design/settings-layout/capture.cjs all

   「before」跑的是隔离探针代理（tests/e2e/harness.cjs）：另起一份 .data 探针目录，
   把真机 .data 里的设置 JSON 拷进去当底稿 —— 画面是**真实内容**（供应商、分页、
   主题、润色正文都在），但一个字节都没写回真机目录；跑完探针目录自动删掉。

   截图落在 design/settings-layout/shots/ 下。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const root = h.root;
const here = __dirname;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

/* 真机 .data → 探针目录：只拷设置类 JSON（目录里的 .proxy.lock 不拷）。
   密钥文件也拷（页面显示的是「已存·不回显」，截图里不会出现明文）。 */
function seedProbeData(dataDir) {
  const src = path.join(root, '.data');
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.json') || f === '.cap-cache.json') continue;
    if (f.endsWith('.bak.json')) continue;
    try {
      fs.copyFileSync(path.join(src, f), path.join(dataDir, f));
      n++;
    } catch (e) { /* 单个文件拷不动不算失败 */ }
  }
  return n;
}

/* 整页截图：这一页是**容器内滚**（.page-shell 固定高、内部 overflow:auto），
   文档高度永远等于视口高度 —— 量文档是没用的，要量滚动容器自己的 scrollHeight，
   再把视口撑到那么高，重截一次。 */
async function shotFull(page, file, minW = 1440) {
  const cs = await page.eval(() => {
    const el = document.querySelector('.settings-page') || document.querySelector('#dtScroll') ||
      document.querySelector('.page-shell');
    if (el) return { w: el.scrollWidth, h: el.scrollHeight };
    /* 设计稿没有那两个壳，量整份文档 */
    return { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
  });
  const w = Math.max(minW, Math.ceil(cs.w || minW));
  const hgt = Math.max(900, Math.min(7000, Math.ceil(cs.h || 900)) + 8);
  await page.setSize(w, hgt);
  await h.sleep(500);
  await page.screenshot(file);
  await page.setSize(minW, 900);
  return { w, h: hgt };
}

async function shotBefore() {
  const proxy = await h.startProxy();
  const dataDir = path.join(root, '.data-probe-' + path.basename(proxy.base) + '');
  let n = 0;
  try {
    /* 探针的数据目录名从 /sys-status 里问出来（harness 造的是 .data-probe-*） */
    const dir = await probeDataDir(proxy.base);
    n = seedProbeData(dir);
    console.log('已拷入真机设置 JSON：' + n + ' 份 → ' + dir);

    const browser = await h.launchBrowser();
    const page = await browser.newPage();
    /* 浅色档（真机存的是 dark）：这一稿是浅色设计稿，对照图也得是浅色。
       主题在 shell-boot.js 里从 localStorage 读，所以要在任何页面脚本之前改掉。 */
    await page.addInitScript(() => { try { localStorage.setItem('dir_theme', 'light'); } catch (e) {} });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => {
      const el = document.querySelector('.settings-page');
      return !!el && el.innerText.length > 120;
    }, 20000);
    await h.sleep(1200);
    const size = await shotFull(page, path.join(shots, 'before-settings.png'));
    console.log('改造前整页：' + size.w + '×' + size.h);

    /* 顶栏（现状：sticky 导航条）单独截一张 */
    await page.setSize(1440, 900);
    await h.sleep(300);
    await page.screenshot(path.join(shots, 'before-settings-viewport.png'));
    console.log('改造前首屏：1440×900');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('页面报错：' + errs.slice(0, 5).join(' | '));
    await browser.close();
  } finally {
    await proxy.stop();
    console.log('探针已清理');
  }
  return n;
}

async function probeDataDir(base) {
  const res = await fetch(base + '/sys-status', { headers: { cookie: '' } });
  const j = await res.json().catch(() => ({}));
  const p = j && j['目录'] && j['目录']['数据'] && j['目录']['数据']['路径'];
  if (p) return p;
  /* 退一步：找根目录下最新的 .data-probe-* */
  const cands = fs.readdirSync(root).filter(d => d.startsWith('.data-probe-'))
    .map(d => path.join(root, d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return cands[0];
}

async function shotAfter() {
  const port = 8098;
  const srv = await require(path.join(here, 'serve.cjs')).start(port);
  const base = srv.base;
  console.log('设计稿预览：' + base);
  const browser = await h.launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(base + 'index.html');
    await page.waitFor(() => document.querySelector('#rail') && document.body.innerText.length > 200, 15000);
    await h.sleep(600);
    await page.screenshot(path.join(shots, 'after-settings-viewport.png'));
    console.log('改造后首屏：1440×900');
    await shotFull(page, path.join(shots, 'after-settings-full.png'));
    console.log('改造后整页已截');

    /* 各栏：逐个点左轨，每栏截一张 */
    const items = await page.eval(() => Array.from(document.querySelectorAll('#rail [data-item]')).map(el => el.getAttribute('data-item')));
    console.log('左轨条目：' + items.join(', '));
    for (const it of items) {
      await page.eval(id => {
        const el = document.querySelector('#rail [data-item="' + id + '"]');
        if (el) el.click();
      }, it);
      await h.sleep(420);
      await page.screenshot(path.join(shots, 'after-' + it + '.png'));
    }
    console.log('逐栏截图 ' + items.length + ' 张');

    /* 栏内自滚：把最长的一栏滚到中间，组标题应当还钉在那儿 */
    await page.eval(() => {
      const el = document.querySelector('#rail [data-item="storage"]');
      if (el) el.click();
    });
    await h.sleep(700);
    const scrolled = await page.eval(() => {
      const dt = document.querySelector('#dtScroll');
      dt.scrollTop = Math.round(dt.scrollHeight * 0.32);
      const dtTop = dt.getBoundingClientRect().top;
      /* 有一枚组标题正钉在容器顶上吗 */
      let pinned = null;
      document.querySelectorAll('.set-group-h').forEach(g => {
        const r = g.getBoundingClientRect();
        if (Math.abs(r.top - dtTop) < 3) pinned = g.innerText.replace(/\s+/g, ' ').trim();
      });
      return {
        pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
        dtScrollable: dt.scrollHeight > dt.clientHeight + 4,
        dtScrollTop: dt.scrollTop,
        docHeight: dt.scrollHeight,
        groupHeaderPinned: pinned,
        railActive: (document.querySelector('#rail .rl-item.on') || {}).innerText.replace(/\s+/g, ' ') || '(none)',
        pos: (document.querySelector('#dtPos') || {}).innerText || '(none)'
      };
    });
    console.log('栏内自滚：' + JSON.stringify(scrolled));
    await h.sleep(400);
    await page.screenshot(path.join(shots, 'after-storage-scrolled.png'));
    console.log('栏内滚动态已截');

    /* 搜一下：目录轨跨组过滤的样子 */
    await page.eval(() => {
      const el = document.querySelector('#railSearch');
      el.value = '密钥';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await h.sleep(400);
    await page.screenshot(path.join(shots, 'after-rail-search.png'));
    console.log('搜索态已截');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('稿子报错：' + errs.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
    await srv.stop();
  }
}

(async () => {
  const mode = process.argv[2] || 'all';
  if (mode === 'before' || mode === 'all') await shotBefore();
  if (mode === 'after' || mode === 'all') await shotAfter();
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
