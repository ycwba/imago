#!/usr/bin/env node
/* 左栏那一列的验收（2026-10-25 随「满 232 / 窄 56」两个形态重写）：
   ① 两个形态的宽度真的落地，且**收 / 展的开关是那块品牌砖**（侧栏里没有第二样收展标识）；
   ② 窄形态六项都认得出（图标 + 两字短标签常驻），不必悬停；
   ③ 余额区在任何窗口尺寸下都不许长出内滚动条；导航一条不许被挤掉（导航优先）；
   ④ 窄形态的压缩块：家数 + 每家一个状态点（取到 / 取不到分得清）+ 落盘进度条；
   ⑤ 本机产物那一行：点标题就地展开明细，重画之后开关还点得动；
   ⑥ 点开压缩块 → 公共弹窗里全量卡，侧栏不堆第二摞卡。
   假件只替 Api / AssetLocal 的**读数**（六家平台 + 传输中），取数与刷新链路仍跑 sidebar.js 那一份 ——
   探针不许另写一份余额卡。只跑 headless（harness 起隔离代理），不写视觉基线。 */
'use strict';
const h = require('./harness.cjs');

/* 六家「都开了余额、都在用」的假平台 + 本机正在传输。
   取数链路与刷新逻辑仍走 sidebar.js 那一份（只把 Api / AssetLocal 的读数换成假的），
   探针不许另写一份余额卡。 */
const STUB = () => {
  const kids = [];
  for (let i = 0; i < 6; i++) kids.push({ id: 'probe' + i, keyId: 'probe' + i, name: 'Probe 平台 ' + i + ' 号', endpoints: { credits: '/credits' } });
  window.Api.registry = async () => ({ providers: kids });
  window.Api.envStatus = async () => ({});
  window.Api.provUsable = () => true;
  window.Api.request = async () => ({ available_amount: '1234.5678', frozen_amount: '0' });
  window.Api.balance = () => ({ available: '1234.5678', frozen: '0', unit: 'credits' });
  window.Api.balNum = v => String(v);
  window.AssetLocal.info = () => ({ on: true, inFlight: 2, count: 5, bytes: 1234567890, fail: 0, ok: 3,
    lastAt: Date.now() - 95000, lastErr: '', dlTotal: 1000, dlSent: 420, dlName: 'probe-clip.mp4' });
  localStorage.setItem('sb_bal_cache', JSON.stringify({ ts: 0, rows: [], kids: [] }));
  return true;
};

/* 「有内滚动条」= overflow 这一轴**真的生效**且内容确实超出。
   只判 scrollHeight > clientHeight 会把 overflow:hidden 的容器也算成「在滚」（误报）；
   只判 overflow 又把「写着 auto 但其实没超出」算成红。 */
const fs = require('fs');
const path = require('path');
/* 侧栏导航条数从路由表现算（web/core/routes.js 里没有 nav:false 的页）：
   写死一个数，路由加一页 / 并一页这条判据就悄悄变成假话。 */
const NAV_N = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../../web/core/routes.js'), 'utf8');
  const pages = (src.match(/file:\s*'[^']+\.html'/g) || []).length;
  const off = (src.match(/nav:\s*false/g) || []).length;
  return pages - off;
})();
/* 两字短标签每项都得有（窄形态靠它认路）：从路由表现读，缺一个就红。 */
const SHORTS = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../../web/core/routes.js'), 'utf8');
  return (src.match(/short:\s*'([^']*)'/g) || []).map(s => /'([^']*)'/.exec(s)[1]);
})();
const BARS = sel => {
  const el = document.querySelector(sel);
  if (!el) return { miss: 1 };
  const cs = getComputedStyle(el);
  const eff = v => /^(auto|scroll|overlay)$/.test(v);
  return {
    sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth,
    ovY: cs.overflowY, ovX: cs.overflowX,
    barY: eff(cs.overflowY) && el.scrollHeight - el.clientHeight > 1,
    barX: eff(cs.overflowX) && el.scrollWidth - el.clientWidth > 1,
  };
};

const SNAP = () => {
  const box = document.querySelector('#sbBalance');
  const rail = document.querySelector('.sidebar');
  const nav = document.querySelector('.sidebar nav');
  const sum = box.querySelector('.sb-bal-sum');
  const body = box.querySelector('.sb-bal-body');
  const wrap = box.querySelector('.sb-bal-cards');
  const mir = box.querySelector('.sb-bal-body > .sb-mirror');
  const head = mir ? mir.querySelector('.l1') : null;
  const l3 = mir ? mir.querySelector('.l3') : null;
  const acts = box.querySelector('.sb-bal-acts');
  const nowT = box.querySelector('.sb-now-t');
  const dots = [...box.querySelectorAll('.sb-bal-dots i')];
  const sumMirror = box.querySelector('.sb-bal-sum-mirror');
  const sumMirrorN = sumMirror ? sumMirror.querySelector('.sb-mirror-n') : null;
  const sumMirrorBar = sumMirror ? sumMirror.querySelector('.dlbar i') : null;
  const vis = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const links = [...nav.querySelectorAll('a')];
  const nb = nav.getBoundingClientRect();
  const cards = [...box.querySelectorAll('.sb-bal-card')].filter(c => c.getBoundingClientRect().height > 0);
  const bb = box.getBoundingClientRect();
  const inside = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { top: Math.round(r.top - bb.top), bottom: Math.round(bb.bottom - r.bottom), h: Math.round(r.height) }; };
  const logo = document.querySelector('.sb-logo');
  const lrect = logo ? logo.getBoundingClientRect() : null;
  /* 家数从「状态点那一行」的说明里读（它是 balList() 那一份的投影）——
     **不许写死 6**：探针里真机那几家（.env 里有密钥的）也会进来，家数是环境相关的。 */
  const dotsTitle = (box.querySelector('.sb-bal-dots') || {}).title || '';
  const mN = /(\d+) 家余额/.exec(dotsTitle);
  const total = mN ? Number(mN[1]) : 0;
  return {
    /* ---------- 两个形态 ---------- */
    open: document.documentElement.classList.contains('sb-open'),
    sbw: getComputedStyle(document.documentElement).getPropertyValue('--sbw').trim(),
    railW: Math.round(rail.getBoundingClientRect().width),
    /* 收 / 展的开关 = 那块品牌砖（两个形态里是同一块：同宽、同高、同一左边界） */
    logoBox: lrect ? { w: Math.round(lrect.width), h: Math.round(lrect.height), left: Math.round(lrect.left) } : null,
    logoRole: logo ? (logo.getAttribute('role') || '') : '',
    /* 窄形态的短标签 */
    sh: links.map(a => (a.querySelector('.sh') || {}).textContent || ''),
    shVisible: (() => { const e = nav.querySelector('a .sh'); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; })(),
    lbVisible: (() => { const e = nav.querySelector('a .lb'); return !!e && getComputedStyle(e).display !== 'none'; })(),
    navItemH: links.length ? Math.round(links[0].getBoundingClientRect().height) : 0,
    /* ---------- 余额区 ---------- */
    sumVis: vis(sum),
    bodyVis: vis(body),
    nowVis: vis(nowT),
    nowT: nowT ? nowT.textContent.replace(/\s+/g, ' ').trim() : '',
    sumText: sum ? sum.textContent.replace(/\s+/g, ' ').trim() : '',
    sumTitle: sum ? (sum.getAttribute('title') || '') : '',
    sumRole: sum ? sum.getAttribute('role') : '',
    sumH: sum ? Math.round(sum.getBoundingClientRect().height) : 0,
    sumOver: sum ? sum.scrollHeight - sum.clientHeight : 0,
    dots: dots.length,
    dotsOk: dots.filter(d => d.classList.contains('ok')).length,
    dotsBad: dots.filter(d => d.classList.contains('bad')).length,
    dotsTitle: dotsTitle,
    total: total,
    sumMirrorN: sumMirrorN ? sumMirrorN.textContent.trim() : '',
    sumMirrorFill: sumMirrorBar ? sumMirrorBar.style.width : '',
    navCount: links.length,
    navClipped: links.filter(a => { const r = a.getBoundingClientRect(); return r.top < nb.top - 1 || r.bottom > nb.bottom + 1; }).length,
    cards: cards.map(c => Math.round(c.getBoundingClientRect().height)),
    cardTotal: box.querySelectorAll('.sb-bal-card').length,
    balExp: rail.classList.contains('bal-exp'),
    wrapVis: vis(wrap),
    wrapBar: wrap ? (/^(auto|scroll|overlay)$/.test(getComputedStyle(wrap).overflowY)
      && wrap.scrollHeight - wrap.clientHeight > 1) : false,
    wrapBox: inside(wrap), mirBox: inside(mir), actsBox: inside(acts),
    /* 本机产物那一行在卡**底**（窄形态的压缩块也是「余额在上、落盘在下」——两个形态同一顺序） */
    mirrorLast: !!(body && body.lastElementChild && body.lastElementChild.classList.contains('sb-mirror')),
    mirrorH: Math.round(((box.querySelector('.sb-bal-body > .sb-mirror') || { getBoundingClientRect: () => ({ height: 0 }) })).getBoundingClientRect().height),
    mirrorText: ((box.querySelector('.sb-bal-body > .sb-mirror .l2') || {}).textContent || '').trim(),
    mirAttr: head ? head.getAttribute('data-mirror') : '',
    mirL3: l3 ? l3.textContent.replace(/\s+/g, ' ').trim() : '',
    acts: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => b.getAttribute('data-bal')),
    actTexts: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
    actTitles: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => b.getAttribute('title') || ''),
    /* 箭头指向：读 path 的头两点（起点 → 尖），尖在上 = 朝上，在下 = 朝下。不抄图标表。 */
    actIconDirs: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => {
      const p = b.querySelector('.ic svg path');
      const n = p ? (p.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g) : null;
      if (!n || n.length < 4) return '';
      const y0 = Number(n[1]), y1 = Number(n[3]);
      return y1 < y0 ? 'up' : (y1 > y0 ? 'down' : '');
    }),
    /* 「产物存本机」明细那一枚开关的箭头（同一套：展开朝上、收起朝下）。 */
    mirIconDir: (() => {
      const p = document.querySelector('#sbBalance .sb-mirror .l1 .chev svg path');
      const n = p ? (p.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g) : null;
      if (!n || n.length < 4) return '';
      const y0 = Number(n[1]), y1 = Number(n[3]);
      return y1 < y0 ? 'up' : (y1 > y0 ? 'down' : '');
    })(),
    /* 底部两块（设置 / 换背景）与底边的距离：差得大 = 它们离底边浮起来了。 */
    bottomGap: Math.round(rail.getBoundingClientRect().bottom
      - (document.querySelector('#sbTheme') || { getBoundingClientRect: () => ({ bottom: 0 }) }).getBoundingClientRect().bottom),
    /* 品牌砖的高度：它同时是整栏收 / 展的开关，被挤扁就是最显眼的一处错位。 */
    brandH: Math.round((document.querySelector('.sidebar .sb-brand')
      || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
    actRects: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => {
      const r = b.getBoundingClientRect();
      return { act: b.getAttribute('data-bal'), top: Math.round(r.top), sw: b.scrollWidth, cw: b.clientWidth };
    }),
    actsRow: acts ? { sw: acts.scrollWidth, cw: acts.clientWidth } : null,
    /* 「去用量页 / 去设置」两枚已撤：整条侧栏里都不许再出现这两个动作名。 */
    jumps: document.querySelectorAll('.sidebar [data-bal="usage"], .sidebar [data-bal="settings"]').length,
    cardTitles: [...box.querySelectorAll('.sb-bal-card')].map(c => c.getAttribute('title') || ''),
    /* 余额卡两行：l1（名字 + 金额）/ l2（冻结 + 单位）——都是单行、放不下才省略号 */
    lines: cards.map(c => ['.l1 .nm', '.l1 .am', '.l2'].map(k => {
      const e = c.querySelector(k);
      return e ? [e.scrollWidth - e.clientWidth, getComputedStyle(e).whiteSpace,
        getComputedStyle(e).textOverflow, Math.round(e.getBoundingClientRect().height)] : ['-', '-', '-', '-'];
    })),
  };
};

const fails = [];
const check = (name, cond, detail) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || !detail ? '' : ' —— ' + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();

    const isOpen = () => page.eval(() => document.documentElement.classList.contains('sb-open'));
    /* 收 / 展就走用户走的那条路：点那块品牌砖。 */
    const setOpen = want => page.eval(() => { document.querySelector('.sb-logo').click(); return true; }).then(() => want);
    const repaint = async ms => {
      await page.eval(() => { window.dispatchEvent(new Event('sb-balance-refresh')); return true; });
      await h.sleep(ms || 400);
    };
    const open = async (w, ht, expanded) => {
      await page.setSize(w, ht);
      await page.goto(proxy.base + '/shell.html#studio.html');
      await page.waitFor(() => window.Api && window.AssetLocal && document.querySelector('#sbBalance .sb-bal-sum'), 20000);
      await page.eval(STUB);
      if ((await isOpen()) !== expanded) await setOpen(expanded);
      await repaint(500);
      await repaint(400);
      /* 余额是**出网取回来**的：等它落定再判（不等就是竞态 ——
         窄形态那排状态点是取回来的数画的，取数没回来时它一片空白）。
         状态点画在压缩块里，满形态时那块是藏着的但**节点还在**，所以两态都能等。 */
      await page.waitFor(() => document.querySelectorAll('#sbBalance .sb-bal-dots i').length >= 1, 20000)
        .catch(() => {});
      await repaint(300);
      const cls = await page.eval(() => document.documentElement.className);
      console.log('\n===== 档 ' + w + 'x' + ht + (expanded ? ' 满形态' : ' 窄形态') + '（html.' + cls + '）=====');
      const dbg = await page.eval(SNAP);
      if (!dbg.sbw) console.log('  [警告] 没读到 --sbw：' + JSON.stringify(dbg).slice(0, 300));
      return dbg;
    };
    const clickBal = act => page.eval(a => {
      const b = document.querySelector('#sbBalance .sb-bal-acts [data-bal="' + a + '"]');
      if (!b) return 0; b.click(); return 1;
    }, act);
    const clickMirror = () => page.eval(() => {
      const hd = document.querySelector('#sbBalance .sb-bal-body > .sb-mirror .l1');
      if (!hd) return 0; hd.click(); return 1;
    });
    const expPref = () => page.eval(() => localStorage.getItem('sb_bal_exp'));

    /* ---------- 档一：1440x900 满形态（232px）---------- */
    let s = await open(1440, 900, true);
    let bal = await page.eval(BARS, '#sbBalance');
    let nv = await page.eval(BARS, '.sidebar nav');
    console.log('  --sbw ' + s.sbw + ' · 栏宽 ' + s.railW + ' · 卡 ' + s.cards.join('/') + '（共 ' + s.cardTotal + '）');
    check('满形态：--sbw = 232px', s.sbw === '232px', { sbw: s.sbw });
    check('满形态：品牌砖是收 / 展的开关（role=button）', s.logoRole === 'button', { role: s.logoRole });
    check('满形态：显示完整名字、藏起两字短标签', s.lbVisible && !s.shVisible, { lbVisible: s.lbVisible, shVisible: s.shVisible });
    check('满形态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('满形态：导航无内滚动条', !nv.barY && !nv.barX, nv);
    check('满形态：导航全部露出', s.navCount === NAV_N && s.navClipped === 0, { navCount: s.navCount, clipped: s.navClipped });
    check('满形态：卡面有抬头「账户余额 N 家」', s.nowVis && /账户余额 \d+ 家/.test(s.nowT), { nowT: s.nowT });
    check('满形态：本机产物行在卡**底**（窄形态也是「余额在上、落盘在下」）', s.mirrorLast, {});
    check('整栏：余额区里没有「去用量页 / 去设置」跳转钮', s.jumps === 0, { jumps: s.jumps });

    /* ---------- 档二：1440x900 窄形态（56px）---------- */
    s = await open(1440, 900, false);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    console.log('  --sbw ' + s.sbw + ' · 栏宽 ' + s.railW + ' · 压缩块「' + s.sumText + '」· 点 ' + s.dots + ' 个');
    check('窄形态：--sbw = 56px', s.sbw === '56px', { sbw: s.sbw });
    check('窄形态：两字短标签常驻可见（认得出，不必悬停）', s.shVisible && !s.lbVisible, { shVisible: s.shVisible, lbVisible: s.lbVisible });
    check('窄形态：六项都有两字短标签', s.sh.length === NAV_N && s.sh.every(x => x.length === 2), { sh: s.sh });
    check('窄形态：短标签与路由表那一行对得上', JSON.stringify(s.sh) === JSON.stringify(SHORTS.slice(0, NAV_N)), { 页面: s.sh, 路由表: SHORTS.slice(0, NAV_N) });
    check('窄形态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('窄形态：导航无内滚动条', !nv.barY && !nv.barX, nv);
    check('窄形态：导航全部露出', s.navCount === NAV_N && s.navClipped === 0, { navCount: s.navCount, clipped: s.navClipped });
    check('窄形态：压缩块画出来了（满形态那块卡不画）', s.sumVis && !s.bodyVis, { sumVis: s.sumVis, bodyVis: s.bodyVis });
    check('窄形态：每家一个状态点（点数 = 家数，取到 / 取得到分得清）',
      s.total > 0 && s.dots === s.total && s.dotsOk + s.dotsBad === s.total,
      { dots: s.dots, ok: s.dotsOk, bad: s.dotsBad, 家数: s.total });
    check('窄形态：状态点上有说明（悬停念得出是哪几家）',
      s.total > 0 && /家余额/.test(s.dotsTitle) && /取到/.test(s.dotsTitle), { title: s.dotsTitle });
    check('窄形态：落盘进度条画出来了（满 100% 的那一条）', /%$/.test(s.sumMirrorFill), { fill: s.sumMirrorFill });
    check('窄形态：压缩块是可点开的按钮（role=button）', s.sumRole === 'button', { role: s.sumRole });
    check('窄形态：区域里也没有跳转钮', s.jumps === 0, { jumps: s.jumps });

    /* ---------- 档三：窄形态的悬停名牌（补全全名，不是认路的唯一手段）---------- */
    const tipBefore = await page.eval(() => document.querySelector('.sb-tip') ? document.querySelector('.sb-tip').hidden : true);
    const tipTxt = await page.eval(() => {
      const a = document.querySelector('.sidebar nav a[data-page="studio.html"]');
      if (!a) return '';
      a.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return (document.querySelector('.sb-tip') || {}).textContent || '';
    });
    check('窄形态：悬停弹出名牌并补全全名', /生成工作台/.test(tipTxt), { tipTxt, tipBefore });

    /* ---------- 档四：矮窗（≤660px 高）满形态 —— 整块退成压缩版 ---------- */
    s = await open(1024, 600, true);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    console.log('  区域高 ' + (await page.eval(() => Math.round(document.querySelector('#sbBalance').getBoundingClientRect().height)))
      + ' · 压缩块「' + s.sumText + '」');
    check('矮窗满形态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('矮窗满形态：导航无内滚动条', !nv.barY && !nv.barX, nv);
    check('矮窗满形态：导航全部露出', s.navCount === NAV_N && s.navClipped === 0, { navCount: s.navCount, clipped: s.navClipped });
    check('矮窗满形态：卡块不画，压缩块是唯一入口', s.sumVis && !s.bodyVis, { sumVis: s.sumVis, bodyVis: s.bodyVis });

    /* ---------- 档五：1024x500 满形态（验收：窗口高 500px 时导航全部可见）---------- */
    s = await open(1024, 500, true);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    check('1024x500：#sbBalance 无内滚动条', !bal.barY && !bal.barX, bal);
    check('1024x500：导航无内滚动条且全部可见', !nv.barY && s.navCount === NAV_N && s.navClipped === 0,
      { nav: nv, navCount: s.navCount, clipped: s.navClipped });

    /* ---------- 档六：满形态就地展开 → 全量卡就在侧栏里，只有卡格滚；导航一条不被挤 ---------- */
    await open(1440, 900, true);
    const EXP = '就地展开 @1440x900';
    /* 展开前的底边位置与品牌砖高度：展开只许改「那张卡有多高」，
       别的一律不许动（底部两块要仍钉在底边、品牌砖不许被挤扁）。 */
    const pre6 = await page.eval(SNAP);
    check(EXP + '：「展开」箭头朝上（这一区的约定：展开 = 朝上，收起 = 朝下）',
      pre6.actIconDirs[0] === 'up', { dirs: pre6.actIconDirs, acts: pre6.acts });
    check(EXP + '：点得动「展开」', (await clickBal('expand')) === 1, {});
    await h.sleep(350);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    s = await page.eval(SNAP);
    console.log('\n===== ' + EXP + ' =====\n  卡 ' + s.cards.length + ' 张（共 ' + s.cardTotal + '）· 卡格滚=' + s.wrapBar);
    check(EXP + '：整份名单都摆出来了', s.total > 0 && s.cardTotal === s.total && s.cards.length === s.total,
      { cards: s.cards.length, total: s.total });
    check(EXP + '：.bal-exp 挂上，包在唯一滚动位 .sb-bal-cards 里', s.balExp && s.wrapVis, { balExp: s.balExp, wrapVis: s.wrapVis });
    check(EXP + '：导航仍全部可见、自己不长滚动条（导航优先于「看全」）',
      !nv.barY && !nv.barX && s.navCount === NAV_N && s.navClipped === 0, { nav: nv, clipped: s.navClipped });
    check(EXP + '：整个区域自己不长第二条滚动条', !bal.barY && !bal.barX, bal);
    check(EXP + '：本机产物行与按钮行完整留在盒子里（「收起」永远点得到，不死锁）',
      s.mirBox && s.mirBox.top >= -1 && s.mirBox.bottom >= -1 && s.actsBox && s.actsBox.bottom >= -1,
      { mirBox: s.mirBox, actsBox: s.actsBox });
    check(EXP + '：按钮换成「收起」+「刷新余额」', JSON.stringify([...s.acts].sort()) === JSON.stringify(['collapse', 'refresh']),
      { acts: s.acts });
    check(EXP + '：「收起」箭头朝下（与「展开」同一套方向）', s.actIconDirs[0] === 'down',
      { dirs: s.actIconDirs, acts: s.acts });
    /* 展开不该让整栏错位：底部两块仍钉在底边、品牌砖不被挤扁、
       按钮行与本机产物行仍钉在**卡底**（`inside()` 给的 bottom 是「离区域下边缘多远」——
       卡往上长高时这两块不许跟着跑，top 会变、bottom 不变）。 */
    check(EXP + '：底部两块仍钉在底边（不因展开而往上飘）',
      s.bottomGap <= 12 && s.bottomGap >= 0 && Math.abs(s.bottomGap - pre6.bottomGap) <= 2,
      { 展开前: pre6.bottomGap, 展开后: s.bottomGap });
    check(EXP + '：品牌砖没被挤扁（高度与展开前一致）', s.brandH === pre6.brandH,
      { 展开前: pre6.brandH, 展开后: s.brandH });
    check(EXP + '：按钮行与本机产物行仍钉在卡底（卡变高，它们不跑）',
      s.actsBox && pre6.actsBox && Math.abs(s.actsBox.bottom - pre6.actsBox.bottom) <= 1
        && s.mirBox && pre6.mirBox && Math.abs(s.mirBox.bottom - pre6.mirBox.bottom) <= 1,
      { 展开前: { acts: pre6.actsBox, mir: pre6.mirBox }, 展开后: { acts: s.actsBox, mir: s.mirBox } });
    check(EXP + '：展开是偏好，当场落盘', (await expPref()) === '1', { pref: await expPref() });

    /* 余额卡两行的口径：名字与第二行放不下才省略号；
       **金额那一位不许截**（数字截了就是假账）—— 它自己占位，名字让位。 */
    check('余额卡两行（名字 + 金额 / 冻结 + 单位），名字与第二行放不下才省略号',
      s.lines.length === s.cardTotal
        && s.lines.every(l => l[0][1] === 'nowrap' && l[0][2] === 'ellipsis'
          && l[2][1] === 'nowrap' && l[2][2] === 'ellipsis'
          && l[1][1] === 'nowrap'),
      { lines: s.lines.slice(0, 2) });
    check('每张卡都带全文 title', s.cardTitles.length === s.cardTotal && s.cardTitles.every(t => t.length > 0), { cardTitles: s.cardTitles.slice(0, 2) });

    /* 重载之后照旧是展开态（这一条只判「偏好活过一次重载」）。 */
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => window.Api && window.AssetLocal && document.querySelector('#sbBalance .sb-bal-sum'), 20000);
    await page.eval(STUB);
    if (!(await isOpen())) await setOpen(true);
    await repaint(650);
    const s2 = await page.eval(SNAP);
    check('重载后仍是展开态（卡数 = 家数、.bal-exp 挂回）', s2.balExp && s2.total > 0 && s2.cardTotal === s2.total,
      { balExp: s2.balExp, cards: s2.cardTotal, total: s2.total });

    /* 收回一档：回到 cap 张，`.bal-exp` 摘掉，界面上不多留一条没人管的滚动条。 */
    check('点得动「收起」', (await clickBal('collapse')) === 1, {});
    await h.sleep(350);
    s = await page.eval(SNAP);
    bal = await page.eval(BARS, '#sbBalance');
    check('收起后回到这一档的 cap 张（不多摆一张）', !s.balExp && s.cards.length >= 1 && s.cards.length <= 3 && s.cards.length < s.total,
      { balExp: s.balExp, cards: s.cards.length, total: s.total });
    check('收起后不再有多余滚动位', !s.wrapBar && !bal.barY && !bal.barX, { wrapBar: s.wrapBar, bal });
    check('收起也写盘（下次打开照旧是收着的）', (await expPref()) === '0', { pref: await expPref() });

    /* ---------- 档七：本机产物那一行 —— 就地展开明细，重画之后开关还点得动 ---------- */
    await open(1440, 900, true);
    const MIR = '本机产物明细';
    check(MIR + '：标题行是开关（data-mirror=1、role=button）', await page.eval(() => {
      const hd = document.querySelector('#sbBalance .sb-bal-body > .sb-mirror .l1');
      return !!hd && hd.getAttribute('data-mirror') === '1' && hd.getAttribute('role') === 'button';
    }), {});
    const pre7 = await page.eval(SNAP);
    check(MIR + '：默认不收明细（没有第三行）', pre7.mirL3 === '', { mirL3: pre7.mirL3 });
    check(MIR + '：收着时箭头朝上（这一区的约定：展开 = 朝上，收起 = 朝下）',
      pre7.mirIconDir === 'up', { dir: pre7.mirIconDir });
    check(MIR + '：点标题行能展开', (await clickMirror()) === 1, {});
    await h.sleep(300);
    const after7 = await page.eval(SNAP);
    check(MIR + '：展开后箭头朝下（与「展开全部」同一套方向）', after7.mirIconDir === 'down',
      { dir: after7.mirIconDir });
    check(MIR + '：展开后报「本次会话存成几份 + 最后一次落盘」', /本次会话存成 3 份/.test(after7.mirL3) && /上次存成/.test(after7.mirL3),
      { mirL3: after7.mirL3 });
    check(MIR + '：开关换成收起（data-mirror=0）', after7.mirAttr === '0', { attr: after7.mirAttr });
    /* 落盘事件会整块换掉这一行 —— 换完必须重新绑一遍，否则「长得对但点了没反应」。 */
    await page.eval(() => { window.dispatchEvent(new Event('wb:mirror-ready')); return true; });
    await h.sleep(300);
    const re7 = await page.eval(SNAP);
    check(MIR + '：落盘重画之后明细还在（状态是全局的，不只活在被点那一刻）', /本次会话存成 3 份/.test(re7.mirL3), { mirL3: re7.mirL3 });
    check(MIR + '：落盘重画之后标题行还点得动（重画一次就重绑一次）', (await clickMirror()) === 1, {});
    await h.sleep(300);
    const off7 = await page.eval(SNAP);
    check(MIR + '：再点一次收回去', off7.mirL3 === '' && off7.mirAttr === '1', { mirL3: off7.mirL3, attr: off7.mirAttr });
    await clickMirror();
    await h.sleep(250);
    await repaint(500);
    check(MIR + '：整块重画没把展开的明细弄丢', /本次会话存成 3 份/.test((await page.eval(SNAP)).mirL3), {});
    check(MIR + '：整块重画之后标题行仍点得动', (await clickMirror()) === 1, {});
    await h.sleep(250);
    check(MIR + '：点下去能收回', (await page.eval(SNAP)).mirL3 === '', {});
    await clickMirror();
    await h.sleep(250);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    check(MIR + '：摆出明细之后余额区仍不长内滚动条', !bal.barY && !bal.barX && !nv.barY, { bal, nv });
    await clickMirror();
    await h.sleep(250);

    /* ---------- 档八：点开窄形态的压缩块 → 公共弹窗里全量卡，侧栏不堆第二摞卡 ---------- */
    await open(1440, 900, false);
    const pre9 = await page.eval(SNAP);
    await page.eval(() => { document.querySelector('#sbBalance .sb-bal-sum').click(); return true; });
    await page.waitFor(() => document.querySelectorAll('dialog .sb-bal-card').length >= 6, 10000);
    const pop = await page.eval(() => {
      const d = document.querySelector('dialog');
      if (!d) return { miss: 1 };
      const cs = getComputedStyle(d);
      const cards = [...d.querySelectorAll('.sb-bal-card')];
      return { open: d.open, n: cards.length, hs: cards.map(c => Math.round(c.getBoundingClientRect().height)),
        bar: /^(auto|scroll|overlay)$/.test(cs.overflowY) && d.scrollHeight - d.clientHeight > 1,
        acts: [...d.querySelectorAll('.sb-bal-acts .ghost')].map(b => b.getAttribute('data-bal')),
        ghost: d.querySelectorAll('.ghost.mini').length,
        sideCards: [...document.querySelectorAll('#sbBalance .sb-bal-card')].filter(c => c.getBoundingClientRect().height > 0).length,
        text: d.textContent.replace(/\s+/g, ' ').slice(0, 60) };
    });
    console.log('\n===== 详情弹窗 =====\n  ' + JSON.stringify(pop));
    check('窄形态点开压缩块有公共弹窗（UiDialog，不是侧栏里堆卡）', !!pop.open && pre9.total > 0 && pop.n === pre9.total, { pop, total: pre9.total });
    check('弹窗里全量卡等高', pop.n >= 1 && Math.max(...pop.hs) - Math.min(...pop.hs) <= 1, { hs: pop.hs });
    check('弹窗里也没有跳转钮：动作只剩就地刷新', JSON.stringify([...pop.acts].sort()) === JSON.stringify(['refresh']), { acts: pop.acts });
    check('弹窗打开时侧栏区里没有第二摞卡', pop.sideCards === 0, { sideCards: pop.sideCards });
    await page.eval(() => { const d = document.querySelector('dialog'); if (d && d.close) d.close(); return true; });

    /* ---------- 档九：只改窗口高度（不重加载）扫一遍 ——「余额区滚动条 = 0（任意窗口尺寸）」 ---------- */
    const resizeOnly = async (ht, expanded) => {
      await page.setSize(1440, ht);
      if ((await isOpen()) !== expanded) await setOpen(expanded);
      await page.eval(() => { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('sb-balance-refresh')); return true; });
      await h.sleep(450);
      return { b: await page.eval(BARS, '#sbBalance'), v: await page.eval(BARS, '.sidebar nav'), st: await page.eval(SNAP) };
    };
    for (const expanded of [true, false]) {
      for (const ht of [480, 500, 560, 640, 720, 800, 960, 1100]) {
        const tag = (expanded ? '满形态' : '窄形态') + ' @1440x' + ht;
        const r = await resizeOnly(ht, expanded);
        check(tag + '：余额区没有内滚动条（纵/横）', !r.b.barY && !r.b.barX && !r.b.miss, { bal: r.b });
        if (ht >= 500) {
          check(tag + '：导航没有内滚动条且全部不被裁',
            !r.v.barY && !r.v.barX && r.st.navCount === NAV_N && r.st.navClipped === 0,
            { nav: r.v, navCount: r.st.navCount, clipped: r.st.navClipped });
        }
      }
    }

    /* ---------- 档十：两个形态之间来回切，一切都还在（不重建、不丢高亮） ---------- */
    await open(1440, 900, true);
    await page.eval(() => { document.querySelector('.sidebar nav a[data-page="studio.html"]').click(); return true; });
    for (let i = 0; i < 4; i++) {   /* 偶数次 → 回到原样 */
      await page.eval(() => { document.querySelector('.sb-logo').click(); return true; });
      await h.sleep(320);
    }
    const back = await page.eval(SNAP);
    check('来回切三次之后回到满形态', back.open === true && back.sbw === '232px', { open: back.open, sbw: back.sbw });
    check('来回切之后当前项还在（切页没被侧栏重建冲掉）', await page.eval(() =>
      !!document.querySelector('.sidebar nav a.active[data-page="studio.html"]')), {});
    check('来回切之后余额区仍然完整', back.cardTotal >= 1 && back.dots === 6, { cards: back.cardTotal, dots: back.dots });

    console.log('\n结论：' + (fails.length ? '未过 ' + fails.length + ' 条：' + fails.join(' / ') : '全部通过'));
  } catch (e) {
    console.error('探针跑挂了：' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    if (proxy) { try { await proxy.stop(); } catch (e) {} }
  }
  if (fails.length) process.exitCode = 1;
})();
