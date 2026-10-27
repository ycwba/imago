#!/usr/bin/env node
/* 这一稿的出图脚本（设计稿专用，不进产品）。
   用法：node design/provider-matrix/shot.cjs
   产出：shots/*.png
   做法：起一个只读静态服务器 → 本地 Chrome（headless）→ 走 CDP 截屏。
   浏览器与 CDP 那部分借项目 tests/e2e/harness.cjs（同一份，不另抄）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const h = require('../../tests/e2e/harness.cjs');

const root = __dirname;
const outDir = path.join(root, 'shots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.join(root, path.normalize(rel).replace(/^[\\/]+/, ''));
      if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ base: 'http://127.0.0.1:' + port + '/', close: () => srv.close() });
    });
  });
}

/* 滚到某个元素（.doc 才是滚动容器） */
async function scrollTo(page, sel) {
  await page.eval((s) => {
    var el = document.querySelector(s);
    if (el) el.scrollIntoView({ block: 'start' });
  }, sel);
  await h.sleep(300);
}
/* 滚到第 n 个（从 0 起）匹配的元素 */
async function scrollToNth(page, sel, n) {
  await page.eval((a) => {
    var els = document.querySelectorAll(a.s);
    if (els[a.n]) els[a.n].scrollIntoView({ block: 'start' });
  }, { s: sel, n: n });
  await h.sleep(300);
}
/* 卡片里那一段自己也要滚（.acct-mid 是独立滚动容器） */
async function scrollInner(page, sel) {
  await page.eval((s) => {
    var el = document.querySelector(s);
    if (!el) return;
    var card = el.closest('.acct');
    if (card) card.scrollIntoView({ block: 'center' });
    var mid = el.closest('.acct-mid');
    if (mid) mid.scrollTop = mid.scrollHeight;
  }, sel);
  await h.sleep(300);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const browser = await h.launchBrowser();
  const page = await browser.newPage();
  const shots = [];
  try {
    await page.setSize(1440, 1000);
    await page.goto(srv.base + 'index.html');
    await page.waitFor(() => document.querySelectorAll('.acct').length >= 6);
    await h.sleep(400);

    /* ① 主稿：等高的账号卡网格 */
    await page.screenshot(path.join(outDir, '01-账号卡网格-浅色-1440.png'));
    shots.push('01-账号卡网格-浅色-1440.png');

    /* ② 密钥展开：名字右边那颗开关，展开后卡片高度不变 */
    await page.eval(() => { var b = document.querySelector('[data-act="key-toggle"]'); if (b) b.click(); });
    await h.sleep(300);
    await page.screenshot(path.join(outDir, '01b-密钥展开-浅色-1440.png'));
    shots.push('01b-密钥展开-浅色-1440.png');
    await page.eval(() => { var b = document.querySelector('[data-act="key-toggle"]'); if (b) b.click(); });
    await h.sleep(200);

    /* ③ 型号清单面板：自动取回 / 在工作台显示与否 / 自己填 */
    await page.eval(() => window.__demo.open('siliconflow:image'));
    await h.sleep(300);
    await page.screenshot(path.join(outDir, '02-型号清单-浅色-1440.png'));
    shots.push('02-型号清单-浅色-1440.png');

    /* ③ 点「取一次型号清单」：自动获取的那一下 */
    await page.eval(() => {
      var b = document.querySelector('[data-act="fetch"]');
      if (b) b.click();
    });
    await h.sleep(250);
    await page.screenshot(path.join(outDir, '03-自动取型号-浅色-1440.png'));
    shots.push('03-自动取型号-浅色-1440.png');
    await h.sleep(900);

    /* ④ 添加供应商：它就是一张普通卡片（挑完变成那家供应商，并自动多出一张新卡） */
    await page.eval(() => window.__demo.close());
    await scrollTo(page, '.add-tile');
    await page.screenshot(path.join(outDir, '04-添加供应商-浅色-1440.png'));
    shots.push('04-添加供应商-浅色-1440.png');

    /* ④b 挑一家接进来：那张卡变成那家供应商，并自动多出一张新的添加卡 */
    await page.eval(() => {
      var b = document.querySelector('[data-act="preset-add"]');
      if (b) b.click();
    });
    await h.sleep(350);
    await scrollTo(page, '.add-tile');
    await page.screenshot(path.join(outDir, '04b-接进来之后-浅色-1440.png'));
    shots.push('04b-接进来之后-浅色-1440.png');

    /* ⑤ 语音识别：顶着那家（DeepSeek）卡里的那一行 + 这一档的表单 */
    await scrollTo(page, '.capform-asr');
    await page.screenshot(path.join(outDir, '05-语音识别-在账号卡里-浅色-1440.png'));
    shots.push('05-语音识别-在账号卡里-浅色-1440.png');

    /* ⑥ 联网搜索：也在那家卡里 */
    await scrollTo(page, '.capform-search');
    await page.screenshot(path.join(outDir, '06-联网搜索-在账号卡里-浅色-1440.png'));
    shots.push('06-联网搜索-在账号卡里-浅色-1440.png');

    /* ⑥b 文字对话那一档的全局项（识图能力）：画在文字主位那家的卡里 */
    await scrollTo(page, '.capform-text');
    await page.screenshot(path.join(outDir, '06b-识图能力-在文字主位卡里-浅色-1440.png'));
    shots.push('06b-识图能力-在文字主位卡里-浅色-1440.png');

    /* ⑥c 手动加一档能力：硬编码里没写这家能做的那一档 */
    await page.eval(() => {
      var b = document.querySelector('[data-act="cap-pick"]');
      if (b) b.click();
    });
    await h.sleep(300);
    await scrollInner(page, '.pickrow');
    await page.screenshot(path.join(outDir, '06c-手动加一档能力-浅色-1440.png'));
    shots.push('06c-手动加一档能力-浅色-1440.png');

    /* ⑥d 加进来之后：这一档出现（带「手动」标记），型号清单打开、自己填 */
    await page.eval(() => {
      var b = document.querySelector('[data-act="cap-add"]');
      if (b) b.click();
    });
    await h.sleep(350);
    await scrollInner(page, '.manual');
    await page.screenshot(path.join(outDir, '06d-手动加的档-自己填型号-浅色-1440.png'));
    shots.push('06d-手动加的档-自己填型号-浅色-1440.png');

    /* ⑦ 筛选：只看做视频的那几家（摘要条 + 排序 + 圈出来的那一格） */
    await page.eval(() => { window.__demo.set({ filter: 'video' }); document.querySelector('.doc').scrollTop = 0; });
    await h.sleep(350);
    await page.screenshot(path.join(outDir, '07-按能力筛选-浅色-1440.png'));
    shots.push('07-按能力筛选-浅色-1440.png');

    /* ⑧ 深色：浅色稿自动派生，不另设计一版 */
    await page.eval(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      window.__demo.set({ filter: 'all' });
      document.querySelector('.doc').scrollTop = 0;
    });
    await h.sleep(350);
    await page.screenshot(path.join(outDir, '08-深色派生-1440.png'));
    shots.push('08-深色派生-1440.png');

    const errs = page.errors.filter(e => !/favicon/i.test(e));
    console.log('出图：' + shots.length + ' 张');
    console.log('报错：' + (errs.join(' | ') || '（无）'));
  } finally {
    await browser.close();
    srv.close();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
