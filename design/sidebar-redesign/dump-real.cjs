#!/usr/bin/env node
/* 把真机上的真实数字导成 design/sidebar-redesign/real.js（设计稿的数据底稿）。
   用法：node design/sidebar-redesign/dump-real.cjs

   跑的是**隔离探针代理**（tests/e2e/harness.cjs）：另起一份 .data 探针目录，
   把真机 .data 整份拷进去当底稿 —— 画面与计数都是**真实内容**，
   但一个字节都没写回真机目录；跑完探针目录自动删掉。

   导出的 real.js 只放**能现读的数**（本机产物条数、角色数、收藏数、
   已接平台数、调用次数）。余额那种要出网问平台的数不在这里 ——
   稿子里那一栏标着「示例」，落地时由侧栏自己取。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const root = h.root;
const here = __dirname;

/* 真机 .data → 探针目录：整棵子树都拷（local-assets/index.json 在子目录里，
   只拷顶层 *.json 会漏掉资产账）。不拷 .proxy.lock 与 cache/。 */
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

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

(async () => {
  const proxy = await h.startProxy();
  let out = {};
  try {
    const dataDir = proxy.dataDir;
    const n = seed(dataDir);
    console.log('已拷入真机 .data：' + n + ' 个文件 → ' + dataDir);

    /* ── 1. 本机产物账（.data/local-assets/index.json）── */
    const idx = readJson(path.join(dataDir, 'local-assets', 'index.json')) || [];
    const assets = Array.isArray(idx) ? idx : [];
    const byType = {};
    for (const a of assets) {
      const t = (a && (a.media_type || '其他')) || '其他';
      byType[t] = (byType[t] || 0) + 1;
    }

    /* ── 2. 角色库 / 收藏 / 工作区 / 调用 ── */
    const chars = (readJson(path.join(dataDir, 'char_lib.json')) || {}).data || [];
    const favs = (readJson(path.join(dataDir, 'fav_items.json')) || {}).data || [];
    const ws = (readJson(path.join(dataDir, 'workspace.json')) || {}).data || {};
    const usage = (readJson(path.join(dataDir, 'ai_usage.json')) || {}).data || [];
    const projects = ws.projects || [];
    let scenes = 0, shots = 0;
    for (const p of projects) {
      for (const s of (p.scenes || [])) { scenes++; shots += (s.shots || []).length; }
    }
    /* 本月调用次数（按 at 落在当月算） */
    const now = new Date();
    const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const calls = usage.filter(u => Number(u && u.at) >= m0).length;

    /* ── 3. 已接平台：问探针的 /env-status ──
       它的形状是**按供应商 id 列**的字典：{ sparkcine: {hasEnv:true, tail:"…"}, … }。 */
    let providers = [];
    try {
      const r = await fetch(proxy.base + '/env-status', { headers: { cookie: proxy.cookie } });
      const j = await r.json().catch(() => ({}));
      const list = j && (j['平台'] || j.providers || j.data);
      const dict = (list && !Array.isArray(list) && typeof list === 'object') ? list
        : (j && typeof j === 'object' ? j : {});
      for (const [id, v] of Object.entries(dict)) {
        if (!v || typeof v !== 'object') continue;
        providers.push({ id, hasKey: !!(v.hasEnv || v.hasKey), tail: v.tail || '' });
      }
    } catch (e) { console.log('/env-status 取不到：' + e.message); }

    out = {
      ts: new Date().toISOString(),
      source: '真机 .data（隔离探针目录）',
      scenes, shots, projects: projects.length,
      chars: chars.length,
      favs: favs.length,
      assets: assets.length,
      assetsByType: byType,
      calls,
      providers,
      platforms: providers.filter(p => p.hasKey).length,
      balances: [],
    };

    /* ── 4. 账户余额：要**出网问平台**才能拿到，所以这一段得把真机外壳开起来，
       让侧栏自己取一遍，再从画好的卡上读回来（不另写一份取数逻辑）。 ── */
    const browser = await h.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => { try { localStorage.setItem('dir_theme', 'light'); } catch (e) {} });
      await page.setSize(1440, 900);
      await page.goto(proxy.base + '/shell.html#director.html');
      await page.waitFor(() => !!document.querySelector('.sb-bal-card'), 30000);
      await h.sleep(6000);
      /* 「展开」把这一档摆不下的那几家也摆出来（只有卡列表那一格滚） */
      await page.eval(() => { const b = document.querySelector('[data-bal="expand"]'); if (b) b.click(); });
      await h.sleep(2500);
      const rows = await page.eval(() => {
        const afterB = el => {
          if (!el) return '';
          const b = el.querySelector('b');
          if (!b) return el.textContent.replace(/^(可用|冻结)\s*/, '').trim();
          const full = el.textContent;
          const i = full.indexOf(b.textContent);
          return (i >= 0 ? full.slice(i + b.textContent.length) : '').trim();
        };
        return Array.from(document.querySelectorAll('#sbBalance .sb-bal-card')).map(c => {
          const nm = c.querySelector('.l1 .nm');
          const l2 = c.querySelector('.l2'), l3 = c.querySelector('.l3');
          const b2 = l2 && l2.querySelector('b'), b3 = l3 && l3.querySelector('b');
          const err = c.querySelector('.balerr');
          return {
            name: nm ? nm.textContent.trim() : '',
            avail: b2 ? b2.textContent.trim() : '',
            unit: afterB(l2),
            frozen: b3 ? b3.textContent.trim() : '',
            failed: !!err,
            why: err ? err.textContent.trim() : '',
          };
        });
      });
      out.balances = rows;
      console.log('余额行（真机取回来的）：' + rows.length + ' 家');
    } catch (e) {
      console.log('余额没取到（不出网或平台报错）：' + e.message);
    } finally {
      await browser.close();
    }
  } finally {
    await proxy.stop();
    console.log('探针已清理');
  }

  const file = path.join(here, 'real.js');
  fs.writeFileSync(file, '/* 自动生成：node design/sidebar-redesign/dump-real.cjs —— 真机现读的数。\n'
    + '   不要手改；重跑脚本覆盖。 */\nwindow.__REAL = ' + JSON.stringify(out, null, 2) + ';\n', 'utf8');
  console.log('已写出 ' + file);
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
