#!/usr/bin/env node
/* 主题两根轴：5 套配色 + 跟随系统（深色由浅色现算）。
   用户要的是：底色配色能挑，日夜能跟系统走，深色不是另一份手写色值。
   这一条盯七件事：
     ① 缺省：浅色 + 海洋（两个键都没设过时解析出来的就是这一档）
     ② 设置页「外观与界面」里两行都在（配色 5 档 / 日夜 3 档），点一下当场生效并落盘
     ③ 5 套配色 × 浅/深：强调色两两不同，中性色逐字节不动（换配色只换强调色那一族）
     ④ 跟随系统：偏好 system 时由系统的深色档决定 data-theme，系统档一变当场跟着变
     ⑤ 侧栏那颗「换背景」：跟随系统时点一下 = 按**解析后**的那一档取反并钉住，不再跟系统
     ⑥ 坏值回落：存储里是认不出的名字时退回 浅色 / 海洋，data-theme 里永远不出现 system
     ⑦ 深色确实是「深色」：底与字的亮度掉转过来；换配色不动底色（深色档也一样）

   data-theme 只放解析后的 light / dark；配色在 data-palette。
   颜色一律读**解析之后**的像素（自定义属性本身是 token 流，oklch 推导要等浏览器算完）——
   判的是画出来是什么颜色，不是源码字符串长什么样。

   路由：#shell.html（缺省与矩阵）/ #settings.html（两行设置）。只跑隔离实例。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PALETTES = ['violet', 'ocean', 'teal', 'berry', 'amber'];
/* 换配色时**不许**动的那些：底色 / 面 / 描边 / 文字 / 底纹 / 滚动条。 */
const NEUTRALS = ['--bg', '--panel', '--panel2', '--line', '--txt', '--sub', '--input', '--thumbbg', '--scroll', '--atbg'];
/* 强调色那一族：换配色只动这三枚。 */
const ACCENTS = ['--acc', '--acc2', '--pri'];

const lum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const key = rgba => rgba.join(',');
const diff = (a, b) => !a.every((v, i) => v === b[i]);

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    /* 这一条测的是界面（解析 / 绘制），不是开机对账：不标的话，这几十次快速改偏好会让
       `.data` 上的镜像一直落后，`DataSync.boot` 在对账时把旧主题拉回来并整页刷新，
       第 ⑤ 步那颗侧栏按钮就点在一次重载的半空里。 */
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.__themeApply && !!window.LS, 30000);
    /* 全新浏览器档位 + 全新探针数据目录：两个键本来就该是空的。 */
    const clean = await page.eval(() => ({
      storedTheme: localStorage.getItem('dir_theme'),
      storedPalette: localStorage.getItem('dir_palette'),
    }));
    must(clean.storedTheme === null && clean.storedPalette === null,
      '开局身上就带着 dir_theme / dir_palette（' + JSON.stringify(clean) + '）：缺省档判不了');

    const readTheme = () => page.eval(() => ({
      theme: document.documentElement.dataset.theme || '',
      palette: document.documentElement.dataset.palette || '',
    }));

    /* 取令牌的**解析值**：自定义属性本身不会算成 rgb（深色那一份是 oklch 推导），
       所以把 var(--x) 塞进一个真属性让浏览器算完，再用 canvas 归一成像素。 */
    const readColors = tokens => page.eval(tokens => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
      document.body.appendChild(host);
      const cv = document.createElement('canvas');
      cv.width = 1; cv.height = 1;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      const out = {};
      for (const t of tokens) {
        host.style.color = '';
        host.style.color = 'var(' + t + ')';
        const raw = getComputedStyle(host).color;
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = '#000';
        cx.fillStyle = raw;
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        out[t] = { raw, rgba: [d[0], d[1], d[2], d[3]] };
      }
      host.remove();
      return out;
    }, tokens);

    /* 写偏好 → 调唯一解析口（__themeApply）→ 读回 DOM 上那两根轴。 */
    const applyTheme = async (mode, palette) => {
      await page.eval((m, p) => {
        if (m == null) window.LS.del('dir_theme'); else window.LS.set('dir_theme', m);
        if (p == null) window.LS.del('dir_palette'); else window.LS.set('dir_palette', p);
        window.__themeApply();
      }, mode, palette);
      return await readTheme();
    };

    /* ── ① 缺省：浅色 + 海洋 ───────────────────────────────────── */
    let t = await readTheme();
    must(t.theme === 'light', '两个键都没设过时 data-theme 该是 light，实际「' + t.theme + '」');
    must(t.palette === 'ocean', '两个键都没设过时 data-palette 该是 ocean，实际「' + t.palette + '」');

    /* ── ② 设置页两行 + 点「莓果」当场生效并落盘 ───────────────── */
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => {
      const el = document.querySelector('.ui-seg[data-ui="dir_theme"]');
      return !!el && el.querySelectorAll('[data-v]').length > 0;
    }, 60000, 150);
    const rows = await page.eval(() => {
      const read = k => {
        const seg = document.querySelector('.ui-seg[data-ui="' + k + '"]');
        if (!seg) return null;
        const on = seg.querySelector('[data-v].on');
        return {
          opts: [...seg.querySelectorAll('[data-v]')].map(b => b.dataset.v + ':' + b.textContent.trim()),
          on: on ? on.dataset.v : '',
          row: (document.querySelector('[data-uik="' + k + '"] .kn') || {}).textContent || '',
        };
      };
      return { palette: read('dir_palette'), theme: read('dir_theme') };
    });
    must(rows.palette, '设置页没有「主题配色」那一行（.ui-seg[data-ui="dir_palette"]）');
    must(rows.theme, '设置页没有「日间 / 夜间」那一行（.ui-seg[data-ui="dir_theme"]）');
    must(rows.palette.opts.length === 5, '配色该是 5 档，实际 ' + JSON.stringify(rows.palette.opts));
    must(PALETTES.every(p => rows.palette.opts.some(o => o.startsWith(p + ':'))),
      '配色 5 档的名字对不上：' + JSON.stringify(rows.palette.opts));
    must(rows.theme.opts.length === 3, '日夜该是 3 档（浅色 / 深色 / 跟随系统），实际 ' + JSON.stringify(rows.theme.opts));
    must(rows.theme.opts.some(o => o === 'system:跟随系统'), '日夜那三档里没有「跟随系统」：' + JSON.stringify(rows.theme.opts));
    must(rows.palette.on === 'ocean', '缺省配色那一格该亮在海洋，实际「' + rows.palette.on + '」');
    must(rows.theme.on === 'light', '缺省日夜那一格该亮在浅色，实际「' + rows.theme.on + '」');

    /* 点「莓果」→ 自动保存（400ms 防抖）→ 解析口被调 → data-palette 跟上、键落盘。 */
    await page.eval(() => {
      const b = document.querySelector('.ui-seg[data-ui="dir_palette"] [data-v="berry"]');
      if (b) b.click();
    });
    const untilBerry = Date.now() + 8000;
    let berryOk = false;
    while (Date.now() < untilBerry) {
      const seen = await page.eval(() => ({
        stored: localStorage.getItem('dir_palette'),
        applied: document.documentElement.dataset.palette,
        on: (document.querySelector('.ui-seg[data-ui="dir_palette"] [data-v].on') || { dataset: {} }).dataset.v,
      }));
      if (seen.stored === 'berry' && seen.applied === 'berry' && seen.on === 'berry') { berryOk = true; break; }
      await sleep(200);
    }
    must(berryOk, '点了「莓果」之后 8 秒内没同时做到：落盘 / data-palette 生效 / 那一格亮着');

    /* 同一页里点「深色」也要当场生效（走同一条保存 + 解析）。 */
    await page.eval(() => {
      const b = document.querySelector('.ui-seg[data-ui="dir_theme"] [data-v="dark"]');
      if (b) b.click();
    });
    const untilDark = Date.now() + 8000;
    let darkOk = false;
    while (Date.now() < untilDark) {
      const seen = await page.eval(() => ({
        stored: localStorage.getItem('dir_theme'),
        applied: document.documentElement.dataset.theme,
      }));
      if (seen.stored === 'dark' && seen.applied === 'dark') { darkOk = true; break; }
      await sleep(200);
    }
    must(darkOk, '在设置页点「深色」之后 8 秒内 data-theme 没变成 dark（落盘 / 解析断了一处）');
    /* 回外壳：后面几组在没人抢焦点的页面里跑。 */
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.__themeApply, 30000);

    /* ── ③ 5 套配色 × 浅/深：强调色两两不同，中性色逐字节不动 ───── */
    const accByMode = { light: {}, dark: {} };
    for (const mode of ['light', 'dark']) {
      let base = null;                       // violet 那一档的中性色（比对的基准）
      const accOf = accByMode[mode];         // palette → 强调色像素
      for (const pal of PALETTES) {
        const seen = await applyTheme(mode, pal);
        must(seen.theme === mode, mode + ' 档设了配色「' + pal + '」之后 data-theme 变成了「' + seen.theme + '」');
        must(seen.palette === pal, mode + ' 档设了配色「' + pal + '」之后 data-palette 是「' + seen.palette + '」');
        const c = await readColors(NEUTRALS.concat(ACCENTS));
        if (!base) base = c;
        else for (const k of NEUTRALS) {
          must(key(c[k].rgba) === key(base[k].rgba),
            mode + ' 档换配色「' + pal + '」把中性色 ' + k + ' 改了（' + key(base[k].rgba) + ' → ' + key(c[k].rgba) + '）：配色块只许动强调色');
        }
        accOf[pal] = { acc: c['--acc'].rgba, acc2: c['--acc2'].rgba, pri: c['--pri'].rgba };
        /* 非紫罗兰那四套：三枚强调色同源（--acc2-base / --pri-base 指回 --acc-base）。
           浅色档两枚基色一样，算出来的像素就该一样；深色档 --pri 的亮度目标与 --acc 不同
           （主按钮要比链接式的强调色更实），所以那里只比 --acc2（与 --acc 同一条亮度）。 */
        if (pal !== 'violet') {
          must(key(accOf[pal].acc) === key(accOf[pal].acc2),
            mode + ' 档「' + pal + '」的 --acc 与 --acc2 不同源：' + key(accOf[pal].acc) + ' vs ' + key(accOf[pal].acc2));
          if (mode === 'light') {
            must(key(accOf[pal].acc) === key(accOf[pal].pri),
              mode + ' 档「' + pal + '」的 --acc 与 --pri 不同源：' + key(accOf[pal].acc) + ' vs ' + key(accOf[pal].pri));
          }
        }
      }
      for (const a of PALETTES) for (const b of PALETTES) {
        if (a >= b) continue;
        must(key(accOf[a].acc) !== key(accOf[b].acc),
          mode + ' 档「' + a + '」与「' + b + '」的 --acc 一样（' + key(accOf[a].acc) + '）：配色没换出区别');
        must(key(accOf[a].pri) !== key(accOf[b].pri),
          mode + ' 档「' + a + '」与「' + b + '」的 --pri 一样（' + key(accOf[a].pri) + '）：配色没换出区别');
      }
    }
    /* 同一套配色，深浅两档的强调色也不该一样（深色是把亮度换到深底上）。 */
    for (const pal of PALETTES) {
      const L = accByMode.light[pal].acc;
      const D = accByMode.dark[pal].acc;
      must(key(L) !== key(D), '配色「' + pal + '」深浅两档的 --acc 是同一个像素（' + key(L) + '）：深色档没在推导');
    }

    /* ── ④ 跟随系统：system 时由系统档决定，系统档变了当场跟 ──────── */
    await page.cdp.send('Emulation.setEmulatedMedia', {
      media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    let seen = await applyTheme('system', 'violet');
    must(seen.theme === 'dark', '系统深色 + 偏好「跟随系统」时 data-theme 该是 dark，实际「' + seen.theme + '」');
    /* 系统档切换 → matchMedia 的 change → 重解析（不再手动调 __themeApply）。 */
    await page.cdp.send('Emulation.setEmulatedMedia', {
      media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    const untilLight = Date.now() + 5000;
    let live = false;
    while (Date.now() < untilLight) {
      const s = await readTheme();
      if (s.theme === 'light') { live = true; break; }
      await sleep(100);
    }
    must(live, '系统换成浅色之后「跟随系统」没有当场跟过去（data-theme 仍是 dark）');

    /* ── ⑤ 侧栏那颗「换背景」：按解析后那一档取反并钉住 ──────────── */
    await page.cdp.send('Emulation.setEmulatedMedia', {
      media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    const untilSysDark = Date.now() + 5000;
    while (Date.now() < untilSysDark) {
      const s = await readTheme();
      if (s.theme === 'dark') break;
      await sleep(100);
    }
    seen = await readTheme();
    must(seen.theme === 'dark', '回到系统深色之后「跟随系统」没跟上（' + JSON.stringify(seen) + '）');
    /* 点的是侧栏那颗按钮：等它挂上（外壳回来时可能刚换过文档，脚本还在排队）。 */
    await page.waitFor(() => !!document.querySelector('#sbTheme'), 30000, 100);
    await page.eval(() => { const b = document.querySelector('#sbTheme'); if (b) b.click(); });
    const pinned = await page.eval(() => ({
      stored: localStorage.getItem('dir_theme'),
      applied: document.documentElement.dataset.theme,
    }));
    must(pinned.stored === 'light', '跟随系统时点「换背景」该把它钉成 light（系统是深色，取反就是浅色），实际存的是「' + pinned.stored + '」');
    must(pinned.applied === 'light', '钉成 light 之后 data-theme 仍是「' + pinned.applied + '」');
    /* 系统仍是深色，但偏好已经钉住 —— 再点一次必须回 dark（说明它不再跟着系统，而是按当前档取反）。 */
    await page.eval(() => { const b = document.querySelector('#sbTheme'); if (b) b.click(); });
    const pinned2 = await page.eval(() => ({
      stored: localStorage.getItem('dir_theme'),
      applied: document.documentElement.dataset.theme,
    }));
    must(pinned2.stored === 'dark' && pinned2.applied === 'dark', '再点一次「换背景」该回到 dark：' + JSON.stringify(pinned2));
    await page.cdp.send('Emulation.setEmulatedMedia', { media: '', features: [] });

    /* ── ⑥ 坏值回落：认不出的名字退回缺省，data-theme 不出现 system ── */
    seen = await applyTheme('neon', 'lava');
    must(seen.theme === 'light', 'dir_theme 是认不出的「neon」时该退回 light，实际「' + seen.theme + '」');
    must(seen.palette === 'ocean', 'dir_palette 是认不出的「lava」时该退回 ocean，实际「' + seen.palette + '」');
    seen = await applyTheme('system', 'violet');
    must(seen.theme === 'light' || seen.theme === 'dark', 'system 被原样写进了 data-theme（「' + seen.theme + '」）：那里只放解析后的一档');

    /* ── ⑦ 深色确实是深色：亮度掉转，换配色不动底色 ──────────────── */
    seen = await applyTheme('light', 'violet');
    const lightC = await readColors(['--bg', '--txt', '--acc']);
    await applyTheme('dark', 'violet');
    const darkC = await readColors(['--bg', '--txt', '--acc']);
    must(lum(lightC['--bg'].rgba) > 0.7,
      '浅色档的底不够浅（亮度 ' + lum(lightC['--bg'].rgba).toFixed(3) + '，像素 ' + key(lightC['--bg'].rgba) + '）');
    must(lum(darkC['--bg'].rgba) < 0.1,
      '深色档的底不够深（亮度 ' + lum(darkC['--bg'].rgba).toFixed(3) + '，像素 ' + key(darkC['--bg'].rgba) + '）');
    must(lum(lightC['--txt'].rgba) < 0.1,
      '浅色档的字不够深（亮度 ' + lum(lightC['--txt'].rgba).toFixed(3) + '）');
    must(lum(darkC['--txt'].rgba) > 0.6,
      '深色档的字不够浅（亮度 ' + lum(darkC['--txt'].rgba).toFixed(3) + '）：深色档推导完读不出来');
    for (const pal of PALETTES) {
      await applyTheme('dark', pal);
      const c = await readColors(['--bg']);
      must(key(c['--bg'].rgba) === key(darkC['--bg'].rgba),
        '深色档换配色「' + pal + '」把底改了（' + key(darkC['--bg'].rgba) + ' → ' + key(c['--bg'].rgba) + '）');
    }
    /* 收尾：两个键都清掉，回到缺省那一档（浅色 + 海洋），不给下一次导航留一个怪状态。 */
    await applyTheme(null, null);

    must(!page.errors.length, '页面有异常：\n  ' + page.errors.join('\n  '));
    const errs = h.logFaults(proxy.log);
    if (errs.length) throw new Error('代理日志有异常：\n  ' + errs.join('\n  '));
    console.log('✓ 主题两根轴：缺省浅色 + 海洋 · 设置页两行 · 5 套配色 × 浅/深 · 跟随系统 · 侧栏钉档 · 坏值回落 · 深色亮度');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
