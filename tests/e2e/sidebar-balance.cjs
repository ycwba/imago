#!/usr/bin/env node
/* 左栏余额与本机传输那一条验收（指标：任意窗口尺寸滚动条 = 0）：
   六家全开 + 正在传输时，#sbBalance 与导航在任何一档窗口尺寸下都不许长出内滚动条；
   矮窗（≤660px 高）与 66px 收起态整区收成**一行摘要**，展开态卡片限 cap 张且等高。
   ⚠ 这一版改了两件事，判据跟着改：
     · 多的那几家不再「跳去用量页」，改成就地展开（`sb_bal_exp`）：整份名单摆在同一条列里，
       **只有卡列表那一格滚**，导航与本机产物行钉在原位；收起后回到 cap 张。展开是偏好，要跨重载。
     · 余额区里**不再有跳转钮**（去用量页 / 去设置）：侧栏里只许出现 expand / collapse / refresh 三枚。
   「展开」这一位撞的就是「导航优先」那条硬约束，所以每档都同时判：卡全摆出来时导航仍 7 条不被裁、
   自己不长滚动条，而「收起」钮永远点得到（点不回就是死锁）。
   ≤660 与 66px 那两档卡片块本来不画，展开位对它们必须等于不存在（sidebar.css 里那两条 revert）。
   本机产物那一行的明细照同一句话走：要看更多就点开标题行，不跳转 —— 顺带判「重画一次就重绑一次」。
   假件只替 Api / AssetLocal 的**读数**（六家平台 + 传输中），取数与刷新链路仍跑 sidebar.js 那一份 ——
   探针不许另写一份余额卡。只跑 headless（harness 起隔离代理），不写视觉基线。 */
'use strict';
const h = require('./harness.cjs');

/* 六家「都开了余额、都在用」的假平台 + 本机正在传输。
   取数链路与刷新逻辑仍走 sidebar.js 那一份（只把 Api / AssetLocal 的读数换成假的），
   探针不许另写一份余额卡。
   `ok` / `lastAt` 是「产物存本机」那一行的明细读的（本次会话存成几份、最后一次落盘什么时候）。 */
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
  const vis = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const links = [...nav.querySelectorAll('a')];
  const nb = nav.getBoundingClientRect();
  const cards = [...box.querySelectorAll('.sb-bal-card')].filter(c => c.getBoundingClientRect().height > 0);
  const title = sum ? (sum.getAttribute('title') || '') : '';
  const m = /账户余额 (\d+) 家/.exec(title);
  const bb = box.getBoundingClientRect();
  /* 块在区域盒子里上下的余量：负的就是被 overflow:hidden 裁出去了（「看着在却点不到」那种）。 */
  const inside = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { top: Math.round(r.top - bb.top), bottom: Math.round(bb.bottom - r.bottom), h: Math.round(r.height) }; };
  return {
    boxH: Math.round(bb.height),
    sumVis: vis(sum), bodyVis: vis(body),
    sumText: sum ? sum.textContent.replace(/\s+/g, ' ').trim() : '',
    sumTitle: title,
    sumTotal: m ? Number(m[1]) : null,
    sumRole: sum ? sum.getAttribute('role') : '',
    sumH: sum ? Math.round(sum.getBoundingClientRect().height) : 0,
    sumOver: sum ? sum.scrollHeight - sum.clientHeight : 0,
    navCount: links.length,
    navClipped: links.filter(a => { const r = a.getBoundingClientRect(); return r.top < nb.top - 1 || r.bottom > nb.bottom + 1; }).length,
    cards: cards.map(c => Math.round(c.getBoundingClientRect().height)),
    cardTotal: box.querySelectorAll('.sb-bal-card').length,
    balExp: rail.classList.contains('bal-exp'),
    wrapVis: vis(wrap),
    wrapBar: wrap ? (/^(auto|scroll|overlay)$/.test(getComputedStyle(wrap).overflowY)
      && wrap.scrollHeight - wrap.clientHeight > 1) : false,
    wrapBox: inside(wrap), mirBox: inside(mir), actsBox: inside(acts),
    mirrorFirst: !!(body && body.firstElementChild && body.firstElementChild.classList.contains('sb-mirror')),
    mirrorH: Math.round(((box.querySelector('.sb-bal-body > .sb-mirror') || { getBoundingClientRect: () => ({ height: 0 }) })).getBoundingClientRect().height),
    mirrorText: ((box.querySelector('.sb-bal-body > .sb-mirror .l2') || {}).textContent || '').trim(),
    mirAttr: head ? head.getAttribute('data-mirror') : '',
    mirL3: l3 ? l3.textContent.replace(/\s+/g, ' ').trim() : '',
    acts: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => b.getAttribute('data-bal')),
    actTexts: [...box.querySelectorAll('.sb-bal-acts .ghost')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
    /* 「去用量页 / 去设置」两枚已撤：整条侧栏里都不许再出现这两个动作名。 */
    jumps: document.querySelectorAll('.sidebar [data-bal="usage"], .sidebar [data-bal="settings"]').length,
    cardTitles: [...box.querySelectorAll('.sb-bal-card')].map(c => c.getAttribute('title') || ''),
    lines: cards.map(c => ['.l1 .nm', '.l2', '.l3'].map(k => {
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
      const cls = await page.eval(() => document.documentElement.className);
      console.log('\n===== 档 ' + w + 'x' + ht + (expanded ? ' 展开' : ' 收起') + '（html.' + cls + '）=====');
      const dbg = await page.eval(SNAP);
      if (!dbg.sumTotal) console.log('  [警告] 区域没画出余额摘要：' + JSON.stringify(dbg).slice(0, 300));
    };
    /* 就地展开 / 收起：点区域里那一枚钮（走用户走的那条路，不自己调开关）。 */
    const clickBal = act => page.eval(a => {
      const b = document.querySelector('#sbBalance .sb-bal-acts [data-bal="' + a + '"]');
      if (!b) return 0; b.click(); return 1;
    }, act);
    const clickMirror = () => page.eval(() => {
      const hd = document.querySelector('#sbBalance .sb-bal-body > .sb-mirror .l1');
      if (!hd) return 0; hd.click(); return 1;
    });
    const setPref = v => page.eval(x => { localStorage.setItem('sb_bal_exp', x); return true; }, v);
    const expPref = () => page.eval(() => localStorage.getItem('sb_bal_exp'));

    /* ---------- 档一：1024x600（≤660px 矮窗：整区退成一行摘要）---------- */
    await open(1024, 600, true);
    let bal = await page.eval(BARS, '#sbBalance');
    let nv = await page.eval(BARS, '.sidebar nav');
    let s = await page.eval(SNAP);
    console.log('  区域高 ' + s.boxH + ' / 摘要 ' + s.sumH + ' 高 · 文案「' + s.sumText + '」');
    console.log('  #sbBalance ' + JSON.stringify(bal) + '\n  nav ' + JSON.stringify(nv));
    check('1024x600：#sbBalance 无内滚动条（纵/横）', !bal.barY && !bal.barX && !bal.miss, bal);
    check('1024x600：导航无内滚动条', !nv.barY && !nv.barX, nv);
    check('1024x600：矮窗整区收成一行摘要（卡片块不画）', s.sumVis && !s.bodyVis, s);
    check('1024x600：摘要只有一行高', s.sumH > 0 && s.sumH <= 32 && s.sumOver <= 1, { sumH: s.sumH, over: s.sumOver });
    check('1024x600：区域总高 = 那一行 + 容器留白（没有第二块）', s.boxH <= s.sumH + 24, { boxH: s.boxH, sumH: s.sumH });
    check('1024x600：导航 7 条全露出（无被裁）', s.navCount === 7 && s.navClipped === 0, s);
    check('整栏：余额区里没有「去用量页 / 去设置」跳转钮', s.jumps === 0, { jumps: s.jumps });

    /* ---------- 档二：1024x500（验收：窗口高 500px 时导航全部可见）---------- */
    await open(1024, 500, true);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    s = await page.eval(SNAP);
    console.log('  区域高 ' + s.boxH + ' · 导航 ' + s.navCount + ' 条 / 裁掉 ' + s.navClipped + ' 条');
    console.log('  #sbBalance ' + JSON.stringify(bal) + '\n  nav ' + JSON.stringify(nv));
    check('1024x500：#sbBalance 无内滚动条', !bal.barY && !bal.barX, bal);
    check('1024x500：导航无内滚动条', !nv.barY && !nv.barX, nv);
    check('1024x500：7 条导航全部可见', s.navCount === 7 && s.navClipped === 0, s);
    check('1024x500：余额区仍是一行摘要', s.sumVis && !s.bodyVis, s);

    /* ---------- 档三：1440x900 收起态（66px）---------- */
    await open(1440, 900, false);
    bal = await page.eval(BARS, '#sbBalance');
    s = await page.eval(SNAP);
    const railW = await page.eval(() => getComputedStyle(document.querySelector('.sidebar')).width);
    console.log('  栏宽 ' + railW + '（内容宽，另有 1px 右边框）· 区域高 ' + s.boxH + ' · 摘要「' + s.sumText + '」· title「' + s.sumTitle + '」');
    console.log('  #sbBalance ' + JSON.stringify(bal));
    check('收起态：栏宽确实是 66px（--sbw 令牌）', railW === '66px', { railW });
    check('收起态：#sbBalance 无内滚动条（横纵都不许）', !bal.barY && !bal.barX, bal);
    check('收起态：整区收成一行摘要，卡片块不画', s.sumVis && !s.bodyVis, s);
    check('收起态：区域只占一行', s.boxH <= s.sumH + 24, { boxH: s.boxH, sumH: s.sumH });
    check('收起态：摘要带「几家余额 / 存本机」两个数', /\d+\D*\d+/.test(s.sumText) && /5/.test(s.sumText), { sumText: s.sumText });
    check('收起态：摘要是可点开的按钮（role=button）', s.sumRole === 'button', { role: s.sumRole });
    check('收起态：区域里也没有跳转钮（看全量走摘要点开的那份弹窗）', s.jumps === 0, { jumps: s.jumps });

    /* ---------- 档四：1440x900 展开默认态（卡片限 cap 张 + 一行按钮：展开 / 刷新）---------- */
    await open(1440, 900, true);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    s = await page.eval(SNAP);
    console.log('  区域高 ' + s.boxH + ' · 卡 ' + s.cards.join('/') + '（共 ' + s.cardTotal + '）· 按钮 ' + JSON.stringify(s.actTexts));
    console.log('  本机行「' + s.mirrorText + '」· data-mirror=' + s.mirAttr);
    console.log('  #sbBalance ' + JSON.stringify(bal) + '\n  nav ' + JSON.stringify(nv));
    check('默认态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('默认态：导航无内滚动条', !nv.barY && !nv.barX, nv);
    check('传输状态固定在区域顶部（.sb-bal-body 第一块，不跟卡一起滚）', s.mirrorFirst && /正在存/.test(s.mirrorText), { mirrorFirst: s.mirrorFirst, mirrorText: s.mirrorText });
    /* 「限 3 张」是**上限**，不是每张窗口都摆满三张：能摆几张由 sidebar.js 的 BAL_CAPS
       按实测高度算（900px 高这一档只摆得下 2 张，摆第 3 张就要挤导航 —— 导航优先）。
       判据不复制那张表，改判两件真话：摆出来的不超过 3 张，且没摆出来的那几家**就地给得出** ——
       「展开全部 N 家」的 N 等于总家数（差一家就是假话），点一下就看全，不跳转。 */
    check('默认摆出来的卡落在 1..3 之间（容器没有 max-height 与内滚动，靠条数定高）',
      s.cards.length >= 1 && s.cards.length <= 3 && s.cardTotal === s.cards.length,
      { cards: s.cards.length, cardTotal: s.cardTotal });
    const expLbl = /^展开全部 (\d+) 家$/.exec((s.actTexts.find(t => /展开全部/.test(t)) || ''));
    check('「展开全部 N 家」报的数 = 总家数（多的那几家就地给得出）',
      s.sumTotal > s.cards.length && !!expLbl && Number(expLbl[1]) === s.sumTotal,
      { total: s.sumTotal, cards: s.cards.length, actTexts: s.actTexts });
    check('按钮族只有就地动作（expand / refresh），且都是公共件 .ghost mini',
      JSON.stringify([...s.acts].sort()) === JSON.stringify(['expand', 'refresh']), { acts: s.acts });
    check('卡等高', s.cards.length > 1 && Math.max(...s.cards) - Math.min(...s.cards) <= 1, { cards: s.cards });
    check('三行都是单行（nowrap + 放不下才省略号），全文在 title 里',
      s.lines.length === s.cards.length && s.lines.every(l => l.every(x => x[1] === 'nowrap' && x[2] === 'ellipsis')),
      { lines: s.lines });
    check('每张卡都带全文 title', s.cardTitles.length === s.cards.length && s.cardTitles.every(t => t.length > 0), { cardTitles: s.cardTitles });

    /* ---------- 档五：就地展开 → 全量卡就在侧栏里，只有卡格滚；导航一条不被挤 ---------- */
    const EXP = '就地展开 @1440x900';
    check(EXP + '：点得动「展开全部 6 家」', (await clickBal('expand')) === 1, {});
    await h.sleep(350);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    s = await page.eval(SNAP);
    console.log('\n===== ' + EXP + ' =====');
    console.log('  区域高 ' + s.boxH + ' · 卡 ' + s.cards.length + ' 张（共 ' + s.cardTotal + '）· 卡格滚=' + s.wrapBar
      + ' · 本机块 ' + JSON.stringify(s.mirBox) + ' · 按钮块 ' + JSON.stringify(s.actsBox));
    console.log('  按钮 ' + JSON.stringify(s.actTexts) + '\n  #sbBalance ' + JSON.stringify(bal) + '\n  nav ' + JSON.stringify(nv));
    check(EXP + '：整份名单都摆出来了（卡数 = 摘要报的家数）', s.cardTotal === s.sumTotal && s.cards.length === s.sumTotal,
      { cards: s.cards.length, total: s.sumTotal });
    check(EXP + '：.bal-exp 挂上，卡包在唯一滚动位 .sb-bal-cards 里', s.balExp && s.wrapVis, { balExp: s.balExp, wrapVis: s.wrapVis });
    check(EXP + '：导航仍 7 条全可见、自己不长滚动条（导航优先于「看全」）',
      !nv.barY && !nv.barX && s.navCount === 7 && s.navClipped === 0, { nav: nv, navClipped: s.navClipped });
    check(EXP + '：整个区域自己不长第二条滚动条（滚的只有卡格）', !bal.barY && !bal.barX, bal);
    check(EXP + '：确实只有卡格超出（900px 高摆 6 张必然要滚 —— 这就是就地展开的代价，摆在明面上）', s.wrapBar,
      { wrapBar: s.wrapBar, wrapBox: s.wrapBox });
    check(EXP + '：本机产物行与按钮行完整留在盒子里（「收起」永远点得到，不死锁）',
      s.mirBox && s.mirBox.top >= -1 && s.mirBox.bottom >= -1 && s.actsBox && s.actsBox.bottom >= -1,
      { mirBox: s.mirBox, actsBox: s.actsBox });
    check(EXP + '：按钮换成「收起」+「刷新余额」', JSON.stringify([...s.acts].sort()) === JSON.stringify(['collapse', 'refresh']),
      { acts: s.acts });
    check(EXP + '：展开是偏好，当场落盘', (await expPref()) === '1', { pref: await expPref() });

    /* 重载之后照旧是展开态（这一条只判「偏好活过一次重载」，不重跑取数）。 */
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => window.Api && window.AssetLocal && document.querySelector('#sbBalance .sb-bal-sum'), 20000);
    await page.eval(STUB);
    if (!(await isOpen())) await setOpen(true);
    await repaint(650);
    const s2 = await page.eval(SNAP);
    const nv2 = await page.eval(BARS, '.sidebar nav');
    console.log('  重载后：卡 ' + s2.cards.length + ' 张 · .bal-exp=' + s2.balExp + ' · 按钮 ' + JSON.stringify(s2.actTexts));
    check('重载后仍是展开态（卡数 = 家数、.bal-exp 挂回）', s2.balExp && s2.cards.length === s2.sumTotal && s2.sumTotal === 6,
      { balExp: s2.balExp, cards: s2.cards.length, total: s2.sumTotal });
    check('重载后导航照旧 7 条不被裁', !nv2.barY && s2.navCount === 7 && s2.navClipped === 0, { nav: nv2, navClipped: s2.navClipped });

    /* 收回一档：回到 cap 张，`.bal-exp` 摘掉，界面上不多留一条没人管的滚动条。 */
    check('点得动「收起」', (await clickBal('collapse')) === 1, {});
    await h.sleep(350);
    s = await page.eval(SNAP);
    bal = await page.eval(BARS, '#sbBalance');
    console.log('  收起后：卡 ' + s.cards.length + ' 张 · .bal-exp=' + s.balExp + ' · 卡格可见=' + s.wrapVis + ' · 按钮 ' + JSON.stringify(s.actTexts));
    check('收起后回到这一档的 cap 张（不多摆一张）', !s.balExp && s.cards.length >= 1 && s.cards.length <= 3 && s.cards.length < s.sumTotal,
      { balExp: s.balExp, cards: s.cards.length, total: s.sumTotal });
    check('收起后不再有多余滚动位', !s.wrapBar && !bal.barY && !bal.barX, { wrapBar: s.wrapBar, bal });
    check('收起后按钮回到「展开全部 N 家」', JSON.stringify([...s.acts].sort()) === JSON.stringify(['expand', 'refresh']), { acts: s.acts });
    check('收起也写盘（下次打开照旧是收着的）', (await expPref()) === '0', { pref: await expPref() });

    /* ---------- 档六：展开偏好开着 × 卡片块不画的那两档 —— 展开位必须等于不存在 ----------
       收起态（66px）与 ≤660 矮窗里 `.sb-bal-body` 整块不画，此时若还钉着导航（`.bal-exp` 那半），
       「导航优先」的兜底就反了：窗口太矮时第 7 条既顶出盒子又滚不回来。这两档判的就是那两条 CSS revert。 */
    for (const [w, ht, expanded, tag] of [[1440, 600, true, '矮窗摘要档'], [1440, 500, true, '更矮摘要档'], [1440, 900, false, '66px 收起档']]) {
      await open(w, ht, expanded);
      await setPref('1');
      await repaint(450);
      const r = await page.eval(SNAP);
      const v = await page.eval(BARS, '.sidebar nav');
      const b = await page.eval(BARS, '#sbBalance');
      console.log('\n===== 展开偏好开着 @' + w + 'x' + ht + '（' + tag + '）=====\n  卡 ' + r.cards.length + ' 张 · .bal-exp=' + r.balExp
        + ' · 摘要可见=' + r.sumVis + ' · 卡片块可见=' + r.bodyVis + '\n  nav ' + JSON.stringify(v));
      check(tag + ' × 展开偏好：卡片块不画（摘要行是这一档唯一入口）', !r.bodyVis && r.sumVis, { bodyVis: r.bodyVis, sumVis: r.sumVis });
      check(tag + ' × 展开偏好：导航没有内滚动条且 7 条不被裁',
        !v.barY && !v.barX && r.navCount === 7 && r.navClipped === 0, { nav: v, navClipped: r.navClipped });
      check(tag + ' × 展开偏好：余额区没有内滚动条', !b.barY && !b.barX && !b.miss, { bal: b });
      await setPref('0');
    }

    /* ---------- 档七：本机产物那一行 —— 就地展开明细，重画之后开关还点得动 ---------- */
    await open(1440, 900, true);
    const MIR = '本机产物明细';
    check(MIR + '：标题行是开关（data-mirror=1、role=button）', await page.eval(() => {
      const hd = document.querySelector('#sbBalance .sb-bal-body > .sb-mirror .l1');
      return !!hd && hd.getAttribute('data-mirror') === '1' && hd.getAttribute('role') === 'button';
    }), {});
    const pre7 = await page.eval(SNAP);
    check(MIR + '：默认不收明细（没有第三行）', pre7.mirL3 === '', { mirL3: pre7.mirL3 });
    check(MIR + '：点标题行能展开', (await clickMirror()) === 1, {});
    await h.sleep(300);
    const after7 = await page.eval(SNAP);
    console.log('\n===== ' + MIR + ' =====\n  第三行「' + after7.mirL3 + '」· data-mirror=' + after7.mirAttr + ' · 整块高 ' + after7.mirrorH);
    check(MIR + '：展开后报「本次会话存成几份 + 最后一次落盘」', /本次会话存成 3 份/.test(after7.mirL3) && /上次存成/.test(after7.mirL3),
      { mirL3: after7.mirL3 });
    check(MIR + '：开关换成收起（data-mirror=0）', after7.mirAttr === '0', { attr: after7.mirAttr });
    /* 落盘事件会整块换掉这一行（mountMirrorBar 的 repaint）—— 换完必须重新绑一遍，
       否则就是「长得对但点了没反应」。wb:mirror-ready 正是 local.js 里推 infoChanged 的那一条。 */
    await page.eval(() => { window.dispatchEvent(new Event('wb:mirror-ready')); return true; });
    await h.sleep(300);
    const re7 = await page.eval(SNAP);
    check(MIR + '：落盘重画之后明细还在（状态是全局的，不只活在被点那一刻）', /本次会话存成 3 份/.test(re7.mirL3), { mirL3: re7.mirL3 });
    check(MIR + '：落盘重画之后标题行还点得动（重画一次就重绑一次）', (await clickMirror()) === 1, {});
    await h.sleep(300);
    const off7 = await page.eval(SNAP);
    check(MIR + '：再点一次收回去', off7.mirL3 === '' && off7.mirAttr === '1', { mirL3: off7.mirL3, attr: off7.mirAttr });
    /* 整块重画（余额刷新走的是 paintBal）之后同样不许变成死钮 —— 那是「点了没反应」的另一条来路。 */
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
    check(MIR + '：摆出明细之后余额区仍不长内滚动条（多那一行是内容，不是第二条滚）', !bal.barY && !bal.barX && !nv.barY, { bal, nv });
    await clickMirror();
    await h.sleep(250);

    /* ---------- 档八：1024x600 展开 + 传输中（文档点名的那一档：六家全开也不许内滚）---------- */
    await open(1024, 600, true);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    s = await page.eval(SNAP);
    console.log('\n===== 六家全开 + 传输中 @1024x600 =====\n  区域高 ' + s.boxH + ' · 摘要「' + s.sumText + '」');
    console.log('  #sbBalance ' + JSON.stringify(bal) + '\n  nav ' + JSON.stringify(nv));
    check('六家全开 + 传输中 @1024x600：无内滚动条', !bal.barY && !bal.barX && !nv.barY && !nv.barX, { bal, nv });

    /* ---------- 档九：点开摘要 → 公共弹窗里全量卡、等高，侧栏不堆第二摞**可见**卡 ----------
       弹层仍是收起态那条路（66px 与矮窗里卡摆不下）；展开位对它没有意义 —— 弹层本来就是全量。 */
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
        ghost: d.querySelectorAll('.ghost.mini').length, mirror: !!d.querySelector('.sb-mirror'),
        sideCards: [...document.querySelectorAll('#sbBalance .sb-bal-card')].filter(c => c.getBoundingClientRect().height > 0).length,
        text: d.textContent.replace(/\s+/g, ' ').slice(0, 60) };
    });
    console.log('\n===== 详情弹窗 =====\n  ' + JSON.stringify(pop));
    check('收起态点开摘要有公共弹窗（UiDialog，不是侧栏里堆卡）', !!pop.open && pop.n === pre9.sumTotal && pop.n >= 6, { pop, total: pre9.sumTotal });
    check('弹窗里全量卡等高', pop.n >= 6 && Math.max(...pop.hs) - Math.min(...pop.hs) <= 1, { hs: pop.hs });
    check('弹窗里也没有跳转钮：动作只剩就地刷新（弹层本来就是全量）',
      JSON.stringify([...pop.acts].sort()) === JSON.stringify(['refresh']), { acts: pop.acts });
    check('弹窗按钮仍是同一族 .ghost mini', pop.ghost >= 1, { ghost: pop.ghost });
    check('弹窗打开时侧栏区里没有第二摞卡', pop.sideCards === 0, { sideCards: pop.sideCards });
    await page.eval(() => { const d = document.querySelector('dialog'); if (d && d.close) d.close(); return true; });

    /* ---------- 档十：只改窗口高度（不重加载）扫一遍 ——「左栏余额区滚动条 = 0（任意窗口尺寸）」 ----------
       六家全开 + 传输中：余额区从 480 到 1100 的每一档都不许长出内滚动条（收起态与展开态都扫）。
       默认态与「就地展开」态各扫一遍：展开态新增的唯一滚动位是 .sb-bal-cards，它不是「挤掉导航」的那条坏路。
       导航那一条按验收线判：窗口高 **500px 起** 7 条全可见且不内滚（再矮下去 7 枚图标加
       brand、分组标题、底部两块在 66px 这一列里真的放不下，导航保留它自己的 overflow-y:auto 兜底 ——
       那不是「挤掉余额区」的那条坏路：余额区在这带已经收成一行摘要，不跟导航抢高度）。
       resize 之后能摆几张卡变了，所以补一次 sb-balance-refresh 让它按新档重画（balCheckCap 那条路）。 */
    const resizeOnly = async (ht, expanded, exp) => {
      await page.setSize(1440, ht);
      await setPref(exp ? '1' : '0');
      if ((await isOpen()) !== expanded) await setOpen(expanded);
      await page.eval(() => { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('sb-balance-refresh')); return true; });
      await h.sleep(450);
      return { b: await page.eval(BARS, '#sbBalance'), v: await page.eval(BARS, '.sidebar nav'), st: await page.eval(SNAP) };
    };
    for (const exp of [false, true]) {
      for (const expanded of [true, false]) {
        for (const ht of [480, 500, 560, 640, 720, 800, 960, 1100]) {
          const tag = (exp ? '展开偏好' : '默认') + '·' + (expanded ? '展开' : '收起') + ' @1440x' + ht;
          const r = await resizeOnly(ht, expanded, exp);
          check(tag + '：余额区没有内滚动条（纵/横）', !r.b.barY && !r.b.barX && !r.b.miss, { bal: r.b });
          if (ht >= 500) {
            check(tag + '：导航没有内滚动条且 7 条不被裁',
              !r.v.barY && !r.v.barX && r.st.navCount === 7 && r.st.navClipped === 0,
              { nav: r.v, navCount: r.st.navCount, navClipped: r.st.navClipped });
          }
          /* 只有卡片块真画出来的那一档才判「展开态真的摆全了」；摘要档由档六管。 */
          if (exp && expanded && ht > 660) {
            check(tag + '：全部 ' + r.st.sumTotal + ' 家都摆出来了（.bal-exp 挂上、卡数 = 家数）',
              r.st.balExp && r.st.cardTotal === r.st.sumTotal && r.st.cardTotal > 3,
              { balExp: r.st.balExp, cards: r.st.cardTotal, total: r.st.sumTotal });
            check(tag + '：本机行与「收起」钮没被卡挤出去（挤出去就是死锁）',
              r.st.mirBox && r.st.mirBox.top >= -1 && r.st.actsBox && r.st.actsBox.bottom >= -1,
              { mirBox: r.st.mirBox, actsBox: r.st.actsBox });
          }
        }
      }
    }

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
