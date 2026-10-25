#!/usr/bin/env node
/* 拍**真机**这两页现在的样子（只读，不改任何数据）。
   用法：node design/fav-detail-state/shot-real.cjs
   产出：shots/real-*.png
   做法借项目 tests/e2e/harness.cjs（隔离代理 + 本地 Chrome + CDP）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser, startProxy } = require('../../tests/e2e/harness.cjs');

const outDir = path.join(__dirname, 'shots');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const proxy = await startProxy();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const shots = [];
  try {
    await page.setSize(1440, 900);

    /* ── 资产库 ── */
    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(() => document.querySelectorAll('.task').length > 0, 20000);
    await wait(1500);
    await page.screenshot(path.join(outDir, 'real-资产库.png'));
    shots.push('real-资产库.png');

    /* 点开第一张卡的「详情」：就地展开（卡自己长高），不是另起一层 */
    const opened = await page.eval(() => {
      const b = document.querySelector('.task .dt');
      if (!b) return false;
      b.click();
      return true;
    });
    if (opened) {
      await wait(1200);
      await page.screenshot(path.join(outDir, 'real-资产库-详情就地展开.png'));
      shots.push('real-资产库-详情就地展开.png');
    }

    /* 紧凑档（网格）：卡片上要有固定的「详情 / 下载」按钮（跟别的界面一样），
       展开的内容落在**行下面那条带子**上。 */
    await page.eval(() => {
      const vt = document.querySelector('.assets-page .viewtoggle button[data-v="compact"]');
      if (vt) vt.click();
    });
    await wait(900);
    const gridActs = await page.eval(() => {
      const acts = document.querySelector('.assets-page .view-compact .task .acts');
      if (!acts) return { ok: false, why: '紧凑档的卡上没有 .acts 这一排' };
      const cs = getComputedStyle(acts);
      const dt = acts.querySelector('.dt');
      const dl = acts.querySelector('.dl2');
      return { ok: cs.display !== 'none' && !!dt, display: cs.display, hasDetail: !!dt, hasDl: !!dl };
    });
    console.log('资产库紧凑档动作行：' + JSON.stringify(gridActs));
    await page.screenshot(path.join(outDir, 'real-资产库-紧凑档.png'));
    shots.push('real-资产库-紧凑档.png');

    /* 收藏那颗（★/☆）要卡在卡面上、与「详情」同一排；卡片高度要一致。 */
    const cardProbe = await page.eval(() => {
      const cards = [...document.querySelectorAll('.assets-page .task')].slice(0, 12);
      const hs = cards.map(c => Math.round(c.getBoundingClientRect().height));
      const fav = document.querySelector('.assets-page .task .acts .favbtn');
      const dt = document.querySelector('.assets-page .task .acts .dt');
      const rt = document.querySelector('.assets-page .task .acts .rt');
      return {
        n: cards.length, heights: hs,
        same: hs.every(h => h === hs[0]),
        hasFav: !!fav, favLabel: fav ? (fav.textContent || '').trim() : '',
        favNextToDetail: !!(fav && dt && fav.parentElement === dt.parentElement),
        retryText: rt ? (rt.textContent || '').trim() : '',
        actsLines: [...document.querySelectorAll('.assets-page .task .acts')].slice(0, 8)
          .map(e => Math.round(e.getBoundingClientRect().height)),
      };
    });
    console.log('资产库卡面（紧凑档）：' + JSON.stringify(cardProbe));

    const openedGrid = await page.eval(() => {
      const b = document.querySelector('.assets-page .view-compact .task .acts .dt');
      if (!b) return false;
      b.click();
      return true;
    });
    if (openedGrid) {
      await wait(1200);
      await page.screenshot(path.join(outDir, 'real-资产库-紧凑档展开带子.png'));
      shots.push('real-资产库-紧凑档展开带子.png');
    }

    /* 回到清单档：高度也要一致，多选条上那两颗（收藏 / 取消收藏）也在这一档看。 */
    await page.eval(() => {
      const vt = document.querySelector('.assets-page .viewtoggle button[data-v="list"]');
      if (vt) vt.click();
    });
    await wait(700);
    const listProbe = await page.eval(() => {
      const hs = [...document.querySelectorAll('.assets-page .task')].slice(0, 12)
        .map(c => Math.round(c.getBoundingClientRect().height));
      return { heights: hs, same: hs.every(h => h === hs[0]) };
    });
    console.log('资产库卡面（清单档）：' + JSON.stringify(listProbe));

    await page.eval(() => {
      const b = document.getElementById('multiBtn');
      if (b) b.click();
    });
    await wait(700);
    const bulk = await page.eval(() => ({
      add: !!document.getElementById('bulkFavAdd'),
      addLabel: ((document.getElementById('bulkFavAdd') || {}).textContent || '').trim(),
      remove: !!document.getElementById('bulkFavRemove'),
      removeLabel: ((document.getElementById('bulkFavRemove') || {}).textContent || '').trim(),
    }));
    console.log('资产库批量条：' + JSON.stringify(bulk));
    await page.screenshot(path.join(outDir, 'real-资产库-多选.png'));
    shots.push('real-资产库-多选.png');
    await page.eval(() => { const b = document.getElementById('multiBtn'); if (b) b.click(); });
    await wait(400);

    /* ── 收藏页 ── */
    /* 收藏是 localStorage 信封：要在页面脚本之前种进去，否则等页面跑起来再写，
       列表已经画完第一遍了。探针的数据目录是空的，所以这里自己种一批。
       用**新开一页**：init 脚本只对之后的导航生效，而上一页已经跑过一轮同步。 */
    const favPage = await browser.newPage();
    await favPage.setSize(1440, 900);
    await favPage.addInitScript(() => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const now = Date.now();
      const notes = ['开场镜头的暖调参考', '便利店雨街的霓虹底子', '女主的过场：站在走廊尽头', '',
        '片尾镜头，节奏要慢', '片头环境音，凌晨的街道'];
      const items = [];
      for (let i = 0; i < 9; i++) {
        items.push({
          key: 'a:probe:' + i, kind: 'asset', provider: 'probe', providerName: 'SparkCine',
          assetId: 'la_probe_' + i, type: i === 6 ? '视频' : (i === 7 ? '音频' : '图片'),
          format: i === 6 ? 'mp4' : (i === 7 ? 'mp3' : 'png'),
          prompt: '雨夜天台 · 人物转身，积水里映着霓虹（第 ' + i + ' 条）',
          src: png, ts: now - i * 3600000, duration: i === 6 ? 5 : (i === 7 ? 96 : null),
          size: 2343615, note: notes[i] || '',
        });
      }
      localStorage.setItem('fav_items', JSON.stringify({ data: items, ts: now }));
    });
    await favPage.goto(proxy.base + '/shell.html#favorites.html');
    await favPage.waitFor(() => document.querySelectorAll('.fav-page .card[data-key]').length > 0, 20000);
    await wait(1500);
    await favPage.screenshot(path.join(outDir, 'real-收藏页.png'));
    shots.push('real-收藏页.png');

    /* 详情就地展开：点卡上那颗「详情」→ 那张卡自己长高 */
    const openedFav = await favPage.eval(() => {
      const b = document.querySelector('.fav-page .card .fav-open');
      if (!b) return false;
      b.click();
      return true;
    });
    if (openedFav) {
      await wait(1200);
      await favPage.screenshot(path.join(outDir, 'real-收藏页-详情就地展开.png'));
      shots.push('real-收藏页-详情就地展开.png');
    }

    /* 多选：点「多选」→ 卡上出现勾选框 + 批量条（收藏页这一份） */
    await favPage.eval(() => {
      const b = document.getElementById('multiBtn');
      if (b) b.click();
    });
    await wait(700);
    await favPage.screenshot(path.join(outDir, 'real-收藏页-多选.png'));
    shots.push('real-收藏页-多选.png');

    /* 紧凑档（网格）：展开的内容落在**行下面那条带子**上，连线指回那个格子 */
    await favPage.eval(() => {
      const b = document.getElementById('multiBtn');
      if (b) b.click();
      const vt = document.querySelector('.fav-page .viewtoggle button[data-v="compact"]');
      if (vt) vt.click();
    });
    await wait(900);
    await favPage.eval(() => {
      const b = document.querySelector('.fav-page .card .fav-open');
      if (b) b.click();
    });
    await wait(1200);
    await favPage.screenshot(path.join(outDir, 'real-收藏页-紧凑档展开带子.png'));
    shots.push('real-收藏页-紧凑档展开带子.png');

    /* 上传入口：工具行那颗「上传本地文件」按钮（拖文件进窗口是同一个 addFiles）。
       这里真走一遍上传 —— 浏览器是一次性隔离 profile（跑完就删），种子数据不碰用户机器。
       看完收藏里是不是真的多了一条。 */
    const uploadInfo = await favPage.eval(async () => {
      const btn = Array.from(document.querySelectorAll('.fav-page button')).find(b => /上传本地文件/.test(b.textContent || ''));
      const input = document.querySelector('.fav-page input[type=file]');
      if (!btn) return { ok: false, why: '工具行里没有那颗「上传本地文件」按钮' };
      if (!input) return { ok: false, why: '没有那个 file input' };
      /* CSP 的 connect-src 只有 'self'：data: 走 fetch 会被拦，所以直接拆 base64 造字节。 */
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '探针上传的图.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, button: (btn.textContent || '').trim() };
    });
    await wait(1600);
    const uploadAfter = await favPage.eval(() => {
      const names = Array.from(document.querySelectorAll('.fav-page .card .t')).map(e => (e.textContent || '').trim());
      return { total: names.length, hasProbe: names.some(n => /探针上传的图/.test(n)) };
    });
    console.log('收藏页上传：' + JSON.stringify(uploadInfo) + ' → ' + JSON.stringify(uploadAfter));
    await favPage.screenshot(path.join(outDir, 'real-收藏页-上传后.png'));
    shots.push('real-收藏页-上传后.png');

    /* ── 素材库（chars）：目录轨里那行「出齐用」的下拉已经撤掉 ── */
    const matPage = await browser.newPage();
    await matPage.setSize(1440, 900);
    await matPage.goto(proxy.base + '/shell.html#chars.html');
    await matPage.waitFor(() => !!document.querySelector('.chars-page'), 25000);
    await wait(1500);
    const rail = await matPage.eval(() => ({
      hasRailGen: !!document.querySelector('.chars-page .rail-gen'),
      hasFillModel: !!document.querySelector('.chars-page [data-fill-model]'),
      fillBtn: !!document.querySelector('.chars-page [data-rail="fill"]'),
      sections: [...document.querySelectorAll('.chars-page .rail-st')].map(e => (e.textContent || '').trim()),
    }));
    console.log('素材库目录轨：' + JSON.stringify(rail));
    await matPage.screenshot(path.join(outDir, 'real-素材库.png'));
    shots.push('real-素材库.png');

    /* ── 工作台右栏：多选条上那两颗（收藏 / 取消收藏） ── */
    const stPage = await browser.newPage();
    await stPage.setSize(1440, 900);
    await stPage.goto(proxy.base + '/shell.html#studio.html?t=image');
    await stPage.waitFor(() => !!document.querySelector('.studio-page'), 25000);
    await wait(1800);
    await stPage.eval(() => { const b = document.getElementById('multiBtn'); if (b) b.click(); });
    await wait(800);
    const st = await stPage.eval(() => ({
      bar: !!(document.getElementById('stBulkBar') && !document.getElementById('stBulkBar').hidden),
      add: !!document.getElementById('stBulkFavAdd'),
      addLabel: ((document.getElementById('stBulkFavAdd') || {}).textContent || '').trim(),
      remove: !!document.getElementById('stBulkFavRemove'),
      removeLabel: ((document.getElementById('stBulkFavRemove') || {}).textContent || '').trim(),
    }));
    console.log('工作台右栏批量条：' + JSON.stringify(st));
    await stPage.screenshot(path.join(outDir, 'real-工作台右栏多选.png'));
    shots.push('real-工作台右栏多选.png');

    const errs = [...(page.errors || []), ...(favPage.errors || []), ...(matPage.errors || []), ...(stPage.errors || [])];
    if (errs.length) console.log('页面报错：\n' + errs.join('\n'));
    console.log('出图完成：\n' + shots.map(s => '  shots/' + s).join('\n'));
  } finally {
    await browser.close();
    await proxy.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
