#!/usr/bin/env node
/* 公共组件判据（用量页 / 导演台剪辑与右栏 / 工作台）：光有 class 不算数 —— 点开、切换之后都要还是那一份。
   用量页：账单筛选下拉由公共 Dropdowns 包住（原生 select 仍是数据源，点开浮层选一项要同步回
        select 的 value 与按钮上的字）；范围那一路是静态选项，不依赖任何已配置的供应商）。
   导演台：右栏档位条是公共 .ui-seg（选中态 .on 由一处翻，旧 .vc-tab 标记不再出现），
        时间线工具条那三颗缩放（缩小 / 自适应 / 放大）也是公共图标；整栏重画（点档位 / 缩一下）
        之后这两条仍然成立。
   工作台：型号下拉与高级设置里每一颗下拉都在公共 .dd 里（原生 select 留在里面当数据源），
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

    /* ---------- 导演台：右栏档位条 + 时间线缩放（公共件的两处落点） ---------- */
    await page.goto(proxy.base + '/shell.html?probe=1#director.html');
    await page.waitFor(() => !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);
    const strip = await page.eval(() => {
      const host = document.getElementById('shotStripHost');
      const col = document.querySelector('.col-left');
      const page = document.querySelector('.director-page');
      return {
        shown: !!host && !host.hidden,
        split: host.querySelectorAll('.wb-split, .wb-split-y').length,
        fixed: host.hasAttribute('data-split-fixed'),
        stored: localStorage.getItem('dir_strip'),
        bg: getComputedStyle(host).backgroundColor,
        colBg: col ? getComputedStyle(col).backgroundColor : '',
        pageBg: page ? getComputedStyle(page).backgroundColor : '',
      };
    });
    must(strip.shown && strip.split === 0 && !strip.fixed && strip.stored == null,
      '生成态中栏底栏仍留着上下拖高控件或旧高度：' + JSON.stringify(strip));
    must(strip.bg !== 'rgba(0, 0, 0, 0)' && strip.bg !== 'transparent'
      && strip.bg === strip.colBg && strip.bg !== strip.pageBg,
      '生成态中栏底栏没有和左右栏同一张白底：' + JSON.stringify(strip));
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('on')) t.click();
    });
    const seg = await readWhen(() => {
      const tabs = document.getElementById('vcTabs');
      const tools = document.getElementById('tlTools');
      if (!tabs || !tools) return null;
      return {
        tabs: tabs.classList.contains('ui-seg'),
        /* .on 只有一颗，且可能是「这一段画面」那枚 span（指着画面段的时候）：
           所以读的是档位条里带 .on 的**那一个**，不是「按钮里的那一个」。 */
        on: [...tabs.querySelectorAll('.on')].map(e => e.dataset.vctab),
        legacy: document.querySelectorAll('.vc-tab').length,
        zoomSvg: tools.querySelectorAll('[data-tl="zoom-out"] svg, [data-tl="zoom-fit"] svg, [data-tl="zoom-in"] svg').length,
      };
    }, 15000);
    must(seg.tabs, '右栏档位条没有用公共 .ui-seg');
    must(seg.on.length === 1 && seg.on[0] === 'voice', '右栏默认应停在「配音」（.on 只有一颗）：' + JSON.stringify(seg.on));
    must(seg.legacy === 0, '旧的自制 .vc-tab 标记还在 DOM 里：' + seg.legacy);
    must(seg.zoomSvg === 3, '时间线缩放那三颗要用公共图标：' + seg.zoomSvg);

    /* 右栏切到「这一段」再切到「字幕」：.on 只落在点中的那一颗，对应那几格真的露出来（其余几格收起）。
       顶上那一层写的是**此刻看着的这一镜**（镜头名），不是档位名 —— 档位的名字由它自己那颗按钮说，
       两处都写同一个词就分出两个层级（见 `track.js` 的 paintTlGroups）。 */
    const lines = await readWhen(() => {
      document.querySelector('#vcTabs [data-vctab="clip"]').click();
      const g = document.getElementById('grpVoiceList');
      if (!g || g.hidden) return null;
      const on = [...document.querySelectorAll('#vcTabs .on')].map(b => b.dataset.vctab);
      const other = ['grpLines', 'grpVoiceAdd', 'grpSub']
        .filter(id => { const e = document.getElementById(id); return e && !e.hidden; });
      return { tabs: on, hidden: ['grpLines', 'grpVoiceAdd', 'grpSub'].map(id => { const e = document.getElementById(id); return e && e.hidden; }), other, title: (document.getElementById('edTitle') || {}).textContent };
    }, 15000);
    must(lines.tabs.length === 1 && lines.tabs[0] === 'clip', '右栏选中态应只有一颗且在「这一段」：' + JSON.stringify(lines.tabs));
    must(!lines.other.length, '切到「这一段」时别的那些格没收起：' + JSON.stringify(lines.other));
    must(lines.hidden.every(Boolean), '切到「这一段」时台词/生成配音/字幕三格要收起');
    must(lines.title === '镜头 A', '右栏顶上该写此刻看着的这一镜（档位名由按钮说）：' + lines.title);

    const sub = await page.eval(() => {
      document.querySelector('#vcTabs [data-vctab="sub"]').click();
      const tabs = document.getElementById('vcTabs');
      const on = [...tabs.querySelectorAll('.on')].map(b => b.dataset.vctab);
      const g = document.getElementById('grpSub');
      return { tabs: on, grpVisible: !!g && !g.hidden };
    });
    must(sub.tabs.length === 1 && sub.tabs[0] === 'sub', '右栏选中态应只有一颗且在「字幕」：' + JSON.stringify(sub.tabs));
    must(sub.grpVisible, '切到「字幕」那一格没有露出来');

    /* 缩一下（走工具条那颗放大 → 整条重排）之后公共件不丢：档位条仍只有一颗 .on、三颗图标还在 */
    await page.eval(() => document.querySelector('#tlTools [data-tl="zoom-in"]').click());
    const zoomed = await readWhen(() => {
      const on = [...document.querySelectorAll('#vcTabs .on')].map(b => b.dataset.vctab);
      if (!on.length) return null;
      const tools = document.getElementById('tlTools');
      return { on, zoomSvg: tools ? tools.querySelectorAll('[data-tl="zoom-out"] svg, [data-tl="zoom-fit"] svg, [data-tl="zoom-in"] svg').length : 0 };
    }, 12000);
    must(zoomed.on.length === 1 && zoomed.on[0] === 'sub', '缩放重排之后右栏选中态不对：' + JSON.stringify(zoomed.on));
    must(zoomed.zoomSvg === 3, '重排之后缩放图标丢了：' + zoomed.zoomSvg);

    /* ---------- 工作台：型号下拉 / 高级设置走公共下拉件，右栏次序 ---------- */
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
        advBtnBg: advBtn ? getComputedStyle(advBtn).backgroundColor : '',
        advBtnShadow: advBtn ? getComputedStyle(advBtn).boxShadow : '',
        theme: document.documentElement.dataset.theme,
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
    if (studio.theme === 'light') {
      must(studio.advBtnBg === 'rgb(255, 255, 255)' && studio.advBtnShadow !== 'none',
        '高级设置里的下拉按钮不是白底轻阴影（' + studio.advBtnBg + ' / ' + studio.advBtnShadow + '）');
    }
    must(studio.typeRow >= 0 && studio.dlRow >= 0 && studio.typeRow < studio.dlRow,
      '右栏次序不对：类型选择那一排（' + studio.typeRow + '）要排在下载/动作那一排（' + studio.dlRow + '）上面');
    must(studio.typeTop >= 0 && studio.dlTop >= 0 && studio.typeTop < studio.dlTop,
      '右栏视觉次序不对：类型选择那一排（top ' + studio.typeTop + '）没有排在下载/动作那一排（top '
      + studio.dlTop + '）上面');
    must(studio.bulkRow > studio.typeRow, '批量下载那一排要排在类型选择的下面');

    const controls = await page.eval(() => {
      const root = document.querySelector('.studio-page');
      const seg = root.querySelector('[data-r="typeSeg"]');
      const box = seg.getBoundingClientRect();
      const on = seg.querySelector('.on');
      const go = root.querySelector('[data-r="go"]');
      const tool = root.querySelector('[data-r="clearAll"]');
      const r = tool.getBoundingClientRect();
      window.focusQuiet(seg.querySelector('button'));
      return {
        height: box.height,
        inset: [...seg.children].every(b => { const r = b.getBoundingClientRect();
          return r.top > box.top && r.bottom < box.bottom; }),
        selectedShadow: getComputedStyle(on).boxShadow,
        trackBg: getComputedStyle(seg).backgroundColor,
        selectedBg: getComputedStyle(on).backgroundColor,
        selectedFg: getComputedStyle(on).color,
        primary: go.classList.contains('pri'),
        disabled: go.disabled && getComputedStyle(go).cursor === 'not-allowed',
        tool: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    });
    must(controls.height === 32 && controls.inset, '分段按钮没有完整收在 32px 公共控件内');
    must(controls.selectedShadow !== 'none' && controls.selectedBg !== controls.trackBg && controls.selectedFg !== controls.selectedBg,
      '选中分段没有从底色和文字上拉开层次');
    must(controls.primary && controls.disabled, '生成按钮没有复用公共主按钮或空提示词禁用态');
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focus = await page.eval(() => {
      const el = document.activeElement, css = getComputedStyle(el);
      return el !== document.body && el.matches(':focus-visible') && css.outlineStyle === 'solid' && parseFloat(css.outlineWidth) >= 2;
    });
    must(focus, 'Tab 导航没有可见的公共焦点环');
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
      x: controls.tool.x + controls.tool.width / 2, y: controls.tool.y + controls.tool.height / 2 });
    const hover = await page.eval(() => {
      const el = document.querySelector('.studio-page [data-r="clearAll"]');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, transform: getComputedStyle(el).transform, hover: el.matches(':hover') };
    });
    must(hover.hover && hover.transform === 'none' && hover.x === controls.tool.x && hover.y === controls.tool.y,
      '工具按钮悬停时改变了位置');

    await page.eval(() => window.GoPage.go('settings.html'));
    await page.waitFor(() => !!document.querySelector('.settings-page button[data-panel]'), 30000);
    const inputPadding = await page.eval(() => getComputedStyle(document.querySelector('#cloudUrl')).paddingLeft);
    must(parseFloat(inputPadding) >= 8, '设置页文本输入框的公共内边距被页面复位抹掉');
    await page.eval(() => document.querySelector('.settings-page button[data-panel]').click());
    await page.waitFor(() => !!document.querySelector('.settings-page button[data-panel].active'));
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await page.eval(() => Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime))
      .map(a => a.finished.catch(() => {}))));
    const selected = await page.eval(() => {
      const el = document.querySelector('.settings-page button[data-panel].active');
      const css = getComputedStyle(el), r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, background: css.backgroundColor, color: css.color };
    });
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selected.x, y: selected.y });
    await page.eval(() => Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime))
      .map(a => a.finished.catch(() => {}))));
    const selectedHover = await page.eval(() => {
      const el = document.querySelector('.settings-page button[data-panel].active');
      const css = getComputedStyle(el);
      return { hover: el.matches(':hover'), background: css.backgroundColor, color: css.color };
    });
    must(selectedHover.hover && selectedHover.background === selected.background && selectedHover.color === selected.color,
      '型号展开按钮悬停时丢失了选中态');

    await page.eval(() => {
      window.Confirm.ask({ title: '确认操作', body: '公共弹窗样式检查' })
        .then(value => { document.body.dataset.confirmResult = String(value); });
    });
    const dialog = await page.eval(() => {
      const el = document.querySelector('dialog.ui-dlg[open]'), css = getComputedStyle(el), r = el.getBoundingClientRect();
      return { radius: css.borderRadius, border: css.borderTopWidth, shadow: css.boxShadow,
        font: css.fontFamily === getComputedStyle(document.body).fontFamily,
        fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
    });
    must(dialog.radius === '14px' && dialog.border === '1px' && dialog.shadow !== 'none' && dialog.font && dialog.fits,
      '公共弹窗没有保持统一表面、字体或视口边界');
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor(() => document.body.dataset.confirmResult === 'false' && !document.querySelector('dialog.ui-dlg[open]'));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 用量页 / 导演台 / 工作台用上公共组件（筛选下拉 · 分段开关 · 图标 · 参数卡；切换与重画后仍是同一份）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
