#!/usr/bin/env node
/* 公共组件判据（用量页 / 导演台剪辑与右栏 / 生成工作台）：光有 class 不算数 —— 点开、切换之后都要还是那一份。
   用量页：账单筛选下拉由公共 Dropdowns 包住（原生 select 仍是数据源，点开浮层选一项要同步回
        select 的 value 与按钮上的字）；范围那一路是静态选项，不依赖任何已配置的供应商）。
   导演台：本镜 / 全片与右栏四档都是公共 .ui-seg（选中态 .on 由一处翻，旧 .vc-tab 标记不再出现），
        时间线缩放两颗也是公共图标。
   生成工作台：型号下拉与高级设置里每一颗下拉都在公共 .dd 里（原生 select 留在里面当数据源），
        公共那颗型号按钮没有被页面样式压成一个窄条；右栏「类型选择」那一排在「存回本机 / 多选 /
        批量下载」那一排**上面**。 */
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

    /* ---------- 用量页：账单筛选下拉由公共 Dropdowns 包住 ---------- */
    await page.goto(proxy.base + '/shell.html#usage.html');
    await page.waitFor(() => !!document.querySelector('.usage-page'), 20000);
    const usageBits = await readWhen(() => {
      const sel = document.querySelector('#fRange');
      const dd = sel && sel.closest('.dd');
      const btn = dd && dd.querySelector('.dd-btn');
      if (!sel || !dd || !btn || !sel.options.length) return null;
      return { label: btn.querySelector('.lbl').textContent, nativeInside: dd.querySelector('select') === sel };
    }, 20000);
    must(usageBits.nativeInside, '原生 select 被挪出了 .dd：数据源必须留在里面');
    must(usageBits.label === '近 30 天', '公共下拉没读出当前值：' + usageBits.label);

    /* 点开公共浮层、选「今天」：原生 select 与按钮文字要一起变 */
    const picked = await page.eval(() => {
      const sel = document.querySelector('#fRange');
      const dd = sel.closest('.dd');
      dd.querySelector('.dd-btn').click();
      const list = document.querySelector('.dd-list.on');
      if (!list) return { err: '点开范围下拉没有出现 .dd-list.on' };
      const opt = list.querySelector('.dd-opt[data-val="1"]');
      if (!opt) return { err: '浮层里没有「今天」这一项：' + list.textContent };
      opt.click();
      return { value: sel.value, label: dd.querySelector('.dd-btn .lbl').textContent,
        closed: !document.querySelector('.dd-list.on') };
    });
    must(!picked.err, picked.err || '');
    must(picked.value === '1' && picked.label === '今天', '公共下拉的选择没回到原生 select / 按钮：' + JSON.stringify(picked));
    must(picked.closed, '选完之后浮层没有收起');
    await page.eval(() => window.Dropdowns && window.Dropdowns.closeAll && window.Dropdowns.closeAll());

    /* ---------- 导演台：时间线范围 / 右栏五档 / 缩放图标 ---------- */
    await page.goto(proxy.base + '/shell.html?probe=1#director.html');
    await page.waitFor(() => !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('on')) t.click();
    });
    const seg = await readWhen(() => {
      const tabs = document.getElementById('vcTabs');
      /* 轨道坞（#tlDock）的页签：元素自己就是公共 .ui-seg（不再嵌一层壳）。 */
      const range = document.querySelector('#tlDock .tl-tabs.ui-seg');
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

    /* ---------- 生成工作台：型号下拉 / 高级设置走公共下拉件，右栏次序 ---------- */
    /* 这一页以前栽在同一个坑上：页面自己的样式还在给**原生** select 写尺寸与外观，
       公共 Dropdowns 上来之后原生 select 已经藏进 .dd 里，那几条规则整条落空 ——
       型号那颗公共按钮按内容宽收缩成一个 61px 的小方块，看着像没做完。
       高级设置那一排同理：写给原生 select 的宽度规则落空后，公共 .dd 的宽度没人管。
       这里判「公共件在位」+「公共件没有被页面样式压塌」+「右栏次序」三件事。 */
    /* 只打工作台三档用的那份空清单（视觉档那一招）：这一节不查平台，跨平台读口一律换成空清单。 */
    await page.addInitScript(() => {
      const L = window.AssetLib;
      if (!L || typeof L.load !== 'function') return;
      if (!L.__sharedLoad) {
        L.__sharedLoad = L.load;
        L.load = async () => ({ entries: [], cursors: {}, hasMore: false, errors: {}, failed: {} });
      }
    });
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => !!document.querySelector('.studio-page'), 25000);
    /* 型号清单要等注册表回来：选项没填上时公共按钮只能显示「请选择」，判据会白捡一个绿。 */
    await readWhen(() => {
      const sel = document.querySelector('.studio-page select[data-r="model"]');
      return !!(sel && sel.value && sel.options.length);
    }, 30000);
    const studio = await page.eval(() => {
      const root = document.querySelector('.studio-page');
      const sel = root.querySelector('select[data-r="model"]');
      const dd = sel && sel.closest('.dd');
      const btn = dd && dd.querySelector('.dd-btn');
      const advSels = [...root.querySelectorAll('.adv-body select')];
      const adv = root.querySelector('.adv');
      const col = root.querySelector('.col-right');
      const rows = [...col.children];
      const at = cls => rows.findIndex(r => (r.className || '').split(' ').includes(cls));
      const top = sel2 => (sel2 ? Math.round(sel2.getBoundingClientRect().top) : -1);
      /* 公共按钮的内边距：页面那条 `* { margin:0; padding:0 }` 重置曾经把公共件的边距整排抹掉
         （工作台这一页的 `.dd-btn` 是 0px / 17px 高，用量页同一个是 8px 12px / 37px 高），
         于是公共件「在位」却不像公共件。这一条盯住内边距。 */
      const padOf = el => (el ? Math.round(parseFloat(getComputedStyle(el).paddingLeft) || 0) : -1);
      const advBtn = root.querySelector('.adv-body .dd .dd-btn');
      return {
        inDD: !!dd,
        nativeInside: !!(dd && dd.querySelector('select') === sel),
        label: btn ? btn.querySelector('.lbl').textContent : '',
        wantLabel: sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : '',
        btnW: btn ? Math.round(btn.getBoundingClientRect().width) : 0,
        btnPad: padOf(btn),
        advBtnPad: padOf(advBtn),
        advPublic: !!(adv && adv.className.split(' ').includes('adv')),
        advSels: advSels.length,
        advInDD: advSels.length ? advSels.every(s => !!s.closest('.dd')) : false,
        typeRow: at('hist-filters'), dlRow: at('tasks-head'), bulkRow: at('bulkbar'),
        typeTop: top(col.querySelector('.hist-filters')), dlTop: top(col.querySelector('.tasks-head')),
      };
    });
    must(studio.inDD, '型号下拉没有走公共 Dropdowns（.dd 壳）');
    must(studio.nativeInside, '原生 select 被挪出了 .dd：它必须留在里面当数据源');
    must(studio.label && studio.label === studio.wantLabel,
      '公共下拉按钮没读出当前型号：按钮「' + studio.label + '」/ 选项「' + studio.wantLabel + '」');
    must(studio.btnW >= 120, '公共那颗型号按钮被页面样式压塌了（宽 ' + studio.btnW
      + 'px —— 页面样式不该再按原生 select 定尺寸）');
    must(studio.btnPad >= 8, '公共那颗型号按钮的内边距被页面那条重置抹掉了（padding-left '
      + studio.btnPad + 'px，公共件是 9px）');
    must(studio.advPublic, '高级设置用的不是公共参数卡（.adv）');
    must(studio.advSels > 0 && studio.advInDD, '高级设置里的下拉有 ' + studio.advSels
      + ' 颗，不是每一颗都在公共 .dd 里');
    must(studio.advBtnPad >= 8, '高级设置里公共那颗下拉按钮的内边距被页面那条重置抹掉了（padding-left '
      + studio.advBtnPad + 'px，公共件是 9px）');
    must(studio.typeRow >= 0 && studio.dlRow >= 0 && studio.typeRow < studio.dlRow,
      '右栏次序不对：类型选择那一排（' + studio.typeRow + '）要排在下载/动作那一排（' + studio.dlRow + '）上面');
    must(studio.typeTop >= 0 && studio.dlTop >= 0 && studio.typeTop < studio.dlTop,
      '右栏视觉次序不对：类型选择那一排（top ' + studio.typeTop + '）没有排在下载/动作那一排（top '
      + studio.dlTop + '）上面');
    must(studio.bulkRow > studio.typeRow, '批量下载那一排要排在类型选择的下面');

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 用量页 / 导演台 / 生成工作台用上公共组件（筛选下拉 · 分段开关 · 图标 · 参数卡；切换与重画后仍是同一份）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
