#!/usr/bin/env node
/* 公共组件判据（画布 / 导演台剪辑与右栏）：光有 class 不算数 —— 点开、切换、重建之后都要还是那一份。
   画布：排序下拉由公共 Dropdowns 包住（原生 select 仍是数据源）、缩放两颗是公共图标、
        新建那一颗是公共 .pri；从工程页退回库时下拉要重新包上。
   导演台：本镜 / 全片与右栏四档都是公共 .ui-seg（选中态 .on 由一处翻，旧 .vc-tab 标记不再出现），
        时间线缩放两颗也是公共图标。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  const project = {
    id: 'p-uishared', name: '公共组件探针', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [{
      id: 'sh1', name: '镜头 A', prompt: 'A 的画面', line: '一句台词', lineWho: '',
      ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      refImages: [], keyframes: [], candidates: [], selId: null,
    }] }],
  };
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const readWhen = async (fn, timeout = 12000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn);
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('等待超时：' + String(fn).slice(0, 90));
    };

    /* 导演台工作区落在 IndexedDB（`Kv.at('ws')`）：先种一份，等会儿直接进导演台。
       页头已经没有「导入项目」那套 JSON 入口了（用户要求去掉）。 */
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: project.id, roles: [], ts: Date.now() });

    /* ---------- 画布：排序 / 缩放 / 新建 ---------- */
    await page.goto(proxy.base + '/shell.html#canvas.html');
    await page.waitFor(() => !!document.querySelector('.cv-lib'), 20000);
    await page.waitFor(() => !!(window.WBBridge && window.WBBridge.get('canvas')), 20000);

    const canvasBits = await readWhen(() => {
      const sel = document.querySelector('.cv-lib-bar select.cv-sort');
      const dd = sel && sel.closest('.dd');
      const btn = dd && dd.querySelector('.dd-btn');
      if (!sel || !dd || !btn) return null;
      const pri = document.querySelector('.cv-lib-bar button.pri');
      return {
        wrapped: true,
        label: btn.querySelector('.lbl').textContent,
        nativeInside: dd.querySelector('select.cv-sort') === sel,
        pri: !!pri,
        priBg: pri ? getComputedStyle(pri).backgroundColor : '',
      };
    }, 15000);
    must(canvasBits.label === '最近修改', '公共下拉没读出当前排序：' + canvasBits.label);
    must(canvasBits.nativeInside, '原生 select 被挪出了 .dd：数据源必须留在里面');
    must(canvasBits.pri, '新建画布没有用公共 .pri');
    must(!/rgba\(0, 0, 0, 0\)|transparent/.test(canvasBits.priBg), '公共 .pri 没吃到主色底：' + canvasBits.priBg);

    /* 点开公共浮层、选「按标题」：原生 select 与按钮文字要一起变 */
    const picked = await page.eval(() => {
      const dd = document.querySelector('.cv-lib-bar .dd');
      dd.querySelector('.dd-btn').click();
      const list = document.querySelector('.dd-list.on');
      if (!list) return { err: '点开排序下拉没有出现 .dd-list.on' };
      const opt = list.querySelector('.dd-opt[data-val="title"]');
      if (!opt) return { err: '浮层里没有「按标题」这一项：' + list.textContent };
      opt.click();
      return {
        value: document.querySelector('.cv-lib-bar select.cv-sort').value,
        label: dd.querySelector('.dd-btn .lbl').textContent,
        closed: !document.querySelector('.dd-list.on'),
      };
    });
    must(!picked.err, picked.err || '');
    must(picked.value === 'title' && picked.label === '按标题', '公共下拉的选择没回到原生 select / 按钮：' + JSON.stringify(picked));
    must(picked.closed, '选完之后浮层没有收起');

    /* 建一张画布再退回库：v-if 换回来的排序下拉必须重新被 Dropdowns 包上 */
    await page.eval(() => document.querySelector('.cv-lib-bar button.pri').click());
    await page.waitFor(() => !!document.getElementById('pfDlg'), 8000);
    await page.eval(() => { document.getElementById('pf_0').value = '公共组件探针'; document.getElementById('pfOk').click(); });
    await page.waitFor(() => !!(window.WBBridge.get('canvas').context() || {}).id, 15000);
    const workBits = await readWhen(() => {
      if (!document.querySelector('.cv-zoom')) return null;
      return {
        zoomSvg: document.querySelectorAll('.cv-zoom button[aria-label] svg').length,
        dockTools: document.querySelectorAll('.cv-dock .tool').length,
        dockSvg: document.querySelectorAll('.cv-dock .tool .ic svg').length,
      };
    }, 12000);
    must(workBits.zoomSvg === 2, '缩放两颗要用公共图标（应各有 1 个 svg）：' + workBits.zoomSvg);
    must(workBits.dockTools >= 9, '画布工具栏少了按钮：' + workBits.dockTools);
    must(workBits.dockSvg >= workBits.dockTools, '画布工具栏的图标没画出来：' + workBits.dockSvg + '/' + workBits.dockTools);
    await page.eval(() => document.querySelector('.cv-back').click());
    const back = await readWhen(() => {
      const sel = document.querySelector('.cv-lib-bar select.cv-sort');
      const dd = sel && sel.closest('.dd');
      if (!dd) return null;
      dd.querySelector('.dd-btn').click();
      const list = document.querySelector('.dd-list.on');
      return { wrapped: !!dd, opts: list ? list.querySelectorAll('.dd-opt').length : 0 };
    }, 15000);
    must(back.wrapped, '从工程页退回库之后，排序下拉没有被重新包成公共下拉');
    must(back.opts === 3, '退回库之后浮层里的选项丢了：' + back.opts);
    await page.eval(() => window.Dropdowns.closeAll());

    /* ---------- 导演台：时间线范围 / 右栏五档 / 缩放图标 ---------- */
    await page.goto(proxy.base + '/shell.html?probe=1#director.html');
    await page.waitFor(() => !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('active')) t.click();
    });
    const seg = await readWhen(() => {
      const tabs = document.getElementById('vcTabs');
      const range = document.querySelector('.tl-tabs .ui-seg');
      if (!tabs || !range) return null;
      return {
        tabs: tabs.classList.contains('ui-seg'),
        on: (tabs.querySelector('button.on') || {}).dataset ? tabs.querySelector('button.on').dataset.vctab : '',
        legacy: document.querySelectorAll('.vc-tab').length,
        rangeSeg: range.tagName.toLowerCase() + '.' + range.className.replace(/\s+/g, '.'),
        rangeOn: (document.querySelector('.tl-tabs button[data-tab].on') || {}).dataset ?
          document.querySelector('.tl-tabs button[data-tab].on').dataset.tab : '',
        zoomSvg: document.querySelectorAll('#tlZoomOut svg, #tlZoomIn svg').length,
      };
    }, 15000);
    must(seg.tabs, '右栏五档没有用公共 .ui-seg');
    must(seg.on === 'list', '右栏默认应停在「这一镜上的配音」（.on）：' + seg.on);
    must(seg.legacy === 0, '旧的自制 .vc-tab 标记还在 DOM 里：' + seg.legacy);
    must(/ui-seg/.test(seg.rangeSeg), '本镜 / 全片没有用公共 .ui-seg：' + seg.rangeSeg);
    must(seg.rangeOn === 'shot', '时间线默认应停在本镜：' + seg.rangeOn);
    must(seg.zoomSvg === 2, '时间线缩放两颗要用公共图标：' + seg.zoomSvg);

    /* 右栏切到「台词」再切到「字幕」：.on 只落在点中的那一颗，对应那一格真的露出来（其余几格收起） */
    const lines = await readWhen(() => {
      document.querySelector('#vcTabs [data-vctab="lines"]').click();
      const g = document.getElementById('grpLines');
      if (!g || g.hidden) return null;
      const on = [...document.querySelectorAll('#vcTabs button.on')].map(b => b.dataset.vctab);
      const other = ['grpPic', 'grpVoice', 'grpVoiceAdd', 'grpVoiceList', 'grpSub']
        .filter(id => { const e = document.getElementById(id); return e && !e.hidden; });
      return { tabs: on, other, title: (document.getElementById('edTitle') || {}).textContent };
    }, 15000);
    must(lines.tabs.length === 1 && lines.tabs[0] === 'lines', '右栏选中态应只有一颗且在「台词」：' + JSON.stringify(lines.tabs));
    must(!lines.other.length, '切到「台词」时别的那些格没收起：' + JSON.stringify(lines.other));
    must(lines.title === '台词', '右栏标题应跟着换成「台词」：' + lines.title);

    const sub = await page.eval(() => {
      document.querySelector('#vcTabs [data-vctab="sub"]').click();
      const tabs = document.getElementById('vcTabs');
      const on = [...tabs.querySelectorAll('button.on')].map(b => b.dataset.vctab);
      const g = document.getElementById('grpSub');
      return { tabs: on, grpVisible: !!g && !g.hidden };
    });
    must(sub.tabs.length === 1 && sub.tabs[0] === 'sub', '右栏选中态应只有一颗且在「字幕」：' + JSON.stringify(sub.tabs));
    must(sub.grpVisible, '切到「字幕」那一格没有露出来');

    /* 时间线切到全片：renderMid 重画之后 .on 仍只有一颗，缩放图标还在 */
    await page.eval(() => document.querySelector('.tl-tabs button[data-tab="film"]').click());
    const film = await readWhen(() => {
      const on = [...document.querySelectorAll('.tl-tabs button[data-tab].on')].map(b => b.dataset.tab);
      if (!on.length) return null;
      return { on, zoomSvg: document.querySelectorAll('#tlZoomOut svg, #tlZoomIn svg').length };
    }, 12000);
    must(film.on.length === 1 && film.on[0] === 'film', '切到全片后选中态不对：' + JSON.stringify(film.on));
    must(film.zoomSvg === 2, '重画之后缩放图标丢了：' + film.zoomSvg);

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 画布 / 导演台用上公共组件（排序下拉 · 分段开关 · 图标 · 主按钮；重建与重画后仍是同一份）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
