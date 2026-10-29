#!/usr/bin/env node
/* 左栏那一列的验收（2026-10-29 随「余额恒为全量 + 定高三张 + 气泡」重写）：
   ① 两个形态的宽度真的落地，且**收 / 展的开关是那块品牌砖**（侧栏里没有第二样收展标识）；
   ② 窄形态六项都认得出（图标 + 两字短标签常驻），不必悬停；
   ③ 满形态的余额卡：**恒为全量**（六家都在 DOM 里），卡列表只占三张卡的高度、多出来的自己滚，
      滚动条不画；点「账户余额」抬头重取一次余额（那一区没有第二颗刷新钮）；
   ④ 收起态 / 矮窗只画压缩块（家数 + 每家一个状态点 + 落盘进度条），点它开一只气泡：
      里面是同一份卡、没有展开 / 刷新按钮、每开一次自动重取一次，点别处 / Esc 关；
   ⑤ 「产物存本机」的明细常驻（不再有展开开关），文案是精简后的那几句；
   ⑥ 导航一条不许被挤掉；任何窗口尺寸下 #sbBalance 自己都不长滚动条。
   假件只替 Api / AssetLocal 的**读数**（六家平台 + 传输中），取数与刷新链路仍跑 sidebar.js 那一份 ——
   探针不许另写一份余额卡。只跑 headless（harness 起隔离代理），不写视觉基线。 */
'use strict';
const h = require('./harness.cjs');

/* 六家「都开了余额、都在用」的假平台 + 本机正在传输。
   取数链路与刷新逻辑仍走 sidebar.js 那一份（只把 Api / AssetLocal 的读数换成假的），
   探针不许另写一份余额卡。`__balCalls` 数的是 credits 请求次数（判「点标题 / 开气泡真的重取」）。 */
const STUB = () => {
  const kids = [];
  for (let i = 0; i < 6; i++) kids.push({ id: 'probe' + i, keyId: 'probe' + i, name: 'Probe 平台 ' + i + ' 号', endpoints: { credits: '/credits' } });
  window.__balCalls = 0;
  window.Api.registry = async () => ({ providers: kids });
  window.Api.envStatus = async () => ({});
  window.Api.provUsable = () => true;
  window.Api.request = async () => { window.__balCalls++; return { available_amount: '1234.5678', frozen_amount: '0' }; };
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
/* 滚动条「画没画出来」：滚动条会占掉 clientWidth 之外的那条槽。
   藏掉（scrollbar-width:none / ::-webkit-scrollbar{width:0}）之后槽宽是 0。 */
const GUTTER = sel => {
  const el = document.querySelector(sel);
  if (!el) return { miss: 1 };
  const cs = getComputedStyle(el);
  return {
    gutter: el.offsetWidth - el.clientWidth,
    sw: cs.scrollbarWidth || '',
    overflow: cs.overflowY,
    scrollable: el.scrollHeight - el.clientHeight > 1,
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
  const nowT = box.querySelector('.sb-now-t');
  const dots = [...box.querySelectorAll('.sb-bal-dots i')];
  const sumMirror = box.querySelector('.sb-bal-sum-mirror');
  const sumMirrorN = sumMirror ? sumMirror.querySelector('.sb-mirror-n') : null;
  const sumMirrorBar = sumMirror ? sumMirror.querySelector('.dlbar i') : null;
  const vis = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const links = [...nav.querySelectorAll('a')];
  const nb = nav.getBoundingClientRect();
  const cards = [...box.querySelectorAll('.sb-bal-card')];
  const cardH = cards.length ? Math.round(cards[0].getBoundingClientRect().height) : 0;
  const pop = document.querySelector('.sb-bal-pop');
  const dotsTitle = (box.querySelector('.sb-bal-dots') || {}).title || '';
  const mN = /(\d+) 家余额/.exec(dotsTitle);
  return {
    open: document.documentElement.classList.contains('sb-open'),
    sbw: getComputedStyle(document.documentElement).getPropertyValue('--sbw').trim(),
    railW: Math.round(rail.getBoundingClientRect().width),
    railRight: Math.round(rail.getBoundingClientRect().right),
    navCount: links.length,
    navClipped: links.filter(a => { const r = a.getBoundingClientRect(); return r.top < nb.top - 1 || r.bottom > nb.bottom + 1; }).length,
    dots: dots.length,
    dotsOk: dots.filter(d => d.classList.contains('ok')).length,
    dotsBad: dots.filter(d => d.classList.contains('bad')).length,
    dotsTitle,
    total: mN ? Number(mN[1]) : 0,
    sumVis: vis(sum),
    sumRole: sum ? sum.getAttribute('role') : '',
    sumMirrorN: sumMirrorN ? sumMirrorN.textContent.trim() : '',
    sumMirrorFill: sumMirrorBar ? sumMirrorBar.style.width : '',
    sumIconN: sum ? sum.querySelectorAll('.p .ic').length : 0,
    bodyVis: vis(body),
    wrapVis: vis(wrap),
    wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : 0,
    wrapScroll: wrap ? { sh: wrap.scrollHeight, ch: wrap.clientHeight } : null,
    cardH,
    cardTotal: cards.length,
    nowVis: vis(nowT),
    nowT: nowT ? nowT.textContent.replace(/\s+/g, ' ').trim() : '',
    nowRole: nowT ? nowT.getAttribute('role') : '',
    nowIcon: nowT ? nowT.querySelectorAll('.ic svg').length : 0,
    mirVis: vis(mir),
    mirL1: mir ? (mir.querySelector('.l1').textContent || '').replace(/\s+/g, ' ').trim() : '',
    mirL2: mir ? (mir.querySelector('.l2').textContent || '').replace(/\s+/g, ' ').trim() : '',
    mirL3: mir ? (mir.querySelector('.l3').textContent || '').replace(/\s+/g, ' ').trim() : '',
    mirChev: mir ? mir.querySelectorAll('.chev').length : 0,
    mirToggle: mir ? mir.querySelectorAll('[data-mirror], [role="button"]').length : 0,
    mirDl: mir ? ([...mir.querySelectorAll('.l2')].pop().textContent || '').replace(/\s+/g, ' ').trim() : '',
    mirDlTitle: mir ? ((mir.querySelector('.dlbar') || {}).title || '') : '',
    acts: box.querySelectorAll('[data-bal]').length + box.querySelectorAll('.sb-bal-acts').length,
    pop: pop ? {
      exists: true,
      left: Math.round(pop.getBoundingClientRect().left),
      top: Math.round(pop.getBoundingClientRect().top),
      bottom: Math.round(pop.getBoundingClientRect().bottom),
      cards: pop.querySelectorAll('.sb-bal-card').length,
      btns: pop.querySelectorAll('button, [data-bal], [data-mirror], .sb-bal-acts').length,
      nowIcon: pop.querySelectorAll('.sb-now-t .ic svg').length,
      title: (pop.querySelector('.sb-now-t') || {}).textContent || '',
      mirL3: ((pop.querySelector('.sb-mirror .l3') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
      vw: window.innerWidth, vh: window.innerHeight,
    } : null,
    calls: window.__balCalls || 0,
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
      /* 余额是**出网取回来**的：等它落定再判（不等就是竞态 —— 状态点是取回来的数画的）。
         状态点画在压缩块里，满形态时那块是藏着的但**节点还在**，所以两态都能等。 */
      await page.waitFor(() => document.querySelectorAll('#sbBalance .sb-bal-dots i').length >= 1, 20000)
        .catch(() => {});
      await repaint(300);
      const cls = await page.eval(() => document.documentElement.className);
      console.log('\n===== 档 ' + w + 'x' + ht + (expanded ? ' 满形态' : ' 窄形态') + '（html.' + cls + '）=====');
      return await page.eval(SNAP);
    };
    const clickTitle = () => page.eval(() => {
      const t = document.querySelector('#sbBalance .sb-now-t');
      if (!t) return 0; t.click(); return 1;
    });
    const clickSum = () => page.eval(() => {
      const s = document.querySelector('#sbBalance .sb-bal-sum');
      if (!s) return 0; s.click(); return 1;
    });
    const clickOutside = () => page.eval(() => {
      const app = document.querySelector('#app') || document.body;
      app.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      return true;
    });
    const pressEsc = () => page.eval(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    });

    /* ---------- 档一：1440x900 满形态（232px）---------- */
    let s = await open(1440, 900, true);
    let bal = await page.eval(BARS, '#sbBalance');
    let nv = await page.eval(BARS, '.sidebar nav');
    let cg = await page.eval(GUTTER, '#sbBalance .sb-bal-cards');
    console.log('  --sbw ' + s.sbw + ' · 栏宽 ' + s.railW + ' · 卡 ' + s.cardTotal + ' 张（高 ' + s.cardH
      + '，视口 ' + s.wrapH + '，内容 ' + JSON.stringify(s.wrapScroll) + '）');
    check('满形态：--sbw = 232px', s.sbw === '232px', { sbw: s.sbw });
    check('满形态：显示完整名字、藏起两字短标签', await page.eval(() =>
      getComputedStyle(document.querySelector('.sidebar nav a .lb')).display !== 'none'
      && getComputedStyle(document.querySelector('.sidebar nav a .sh')).display === 'none'), {});
    check('满形态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('满形态：导航无内滚动条且全部露出', !nv.barY && !nv.barX && s.navCount >= 6 && s.navClipped === 0, { nav: nv, count: s.navCount, clipped: s.navClipped });
    check('满形态：余额卡恒为全量（六家都在、不再有「展开」）', s.cardTotal === 6 && s.total === 6 && s.acts === 0,
      { cards: s.cardTotal, total: s.total, acts: s.acts });
    check('满形态：卡列表只占三张卡的高度（多出来的自己滚）',
      s.wrapVis && s.wrapH > s.cardH * 3 - 4 && s.wrapH <= s.cardH * 3 + 2 && s.wrapScroll.sh > s.wrapScroll.ch,
      { wrapH: s.wrapH, cardH: s.cardH, scroll: s.wrapScroll });
    check('满形态：卡列表不画滚动条', cg.gutter <= 0 && cg.overflow === 'auto', cg);
    check('满形态：抬头是刷新入口（role=button、不画刷新图标）', s.nowVis && s.nowRole === 'button' && s.nowIcon === 0,
      { nowRole: s.nowRole, nowIcon: s.nowIcon, nowT: s.nowT });
    check('满形态：抬头写「账户余额 6 家」', /账户余额\s*6\s*家/.test(s.nowT), { nowT: s.nowT });
    /* 点抬头真的重取：六家各一笔 credits。 */
    let before = s.calls;
    check('满形态：点得动抬头', (await clickTitle()) === 1, {});
    await h.sleep(600);
    s = await page.eval(SNAP);
    check('满形态：点抬头重取了一轮余额', s.calls >= before + 6, { before, after: s.calls });

    /* ---------- 「产物存本机」：明细常驻、文案精简、没有开关 ---------- */
    const mir = '本机产物行';
    check(mir + '：标题行不是开关（没有 data-mirror / role=button、没有箭头）',
      s.mirToggle === 0 && s.mirChev === 0, { toggle: s.mirToggle, chev: s.mirChev });
    check(mir + '：明细常驻（本次会话 + 上次落盘）', /本次 3 份 · 上次 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s.mirL3), { mirL3: s.mirL3 });
    check(mir + '：状态行是精简后的「正在存 2 份」', s.mirL2 === '正在存 2 份', { mirL2: s.mirL2 });
    check(mir + '：下载进度不把文件名与字节数塞进行面（全文在 title 里）',
      s.mirDl === '正在下这一份 42%' && /probe-clip\.mp4 · 420 B \/ 1000 B/.test(s.mirDlTitle),
      { mirDl: s.mirDl, title: s.mirDlTitle });
    check(mir + '：在卡底（余额在上、落盘在下）', await page.eval(() =>
      document.querySelector('#sbBalance .sb-bal-body').lastElementChild.classList.contains('sb-mirror')), {});

    /* ---------- 档二：1440x900 窄形态（56px）---------- */
    s = await open(1440, 900, false);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    console.log('  --sbw ' + s.sbw + ' · 压缩块「' + s.nowT + '」· 点 ' + s.dots + ' 个');
    check('窄形态：--sbw = 56px', s.sbw === '56px', { sbw: s.sbw });
    check('窄形态：两字短标签常驻可见（认得出，不必悬停）', await page.eval(() => {
      const sh = document.querySelector('.sidebar nav a .sh');
      return !!sh && getComputedStyle(sh).display !== 'none' && sh.getBoundingClientRect().height > 0
        && getComputedStyle(document.querySelector('.sidebar nav a .lb')).display === 'none';
    }), {});
    check('窄形态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('窄形态：导航无内滚动条且全部露出', !nv.barY && !nv.barX && s.navCount >= 6 && s.navClipped === 0, { nav: nv, count: s.navCount, clipped: s.navClipped });
    check('窄形态：压缩块画出来了（满形态那块卡不画）', s.sumVis && !s.bodyVis, { sumVis: s.sumVis, bodyVis: s.bodyVis });
    check('窄形态：压缩块不画图标（只留家数）', s.sumIconN === 0, { sumIconN: s.sumIconN });
    check('窄形态：每家一个状态点（点数 = 家数）', s.total > 0 && s.dots === s.total && s.dotsOk + s.dotsBad === s.total,
      { dots: s.dots, ok: s.dotsOk, bad: s.dotsBad, total: s.total });
    check('窄形态：落盘进度条画出来了（满 42% 的那一条）', s.sumMirrorFill === '42%', { fill: s.sumMirrorFill });
    check('窄形态：压缩块是按钮（role=button）', s.sumRole === 'button', { role: s.sumRole });

    /* ---------- 档三：点压缩块 → 气泡 ---------- */
    const popTag = '气泡';
    before = s.calls;
    check(popTag + '：点得动压缩块', (await clickSum()) === 1, {});
    await page.waitFor(() => !!document.querySelector('.sb-bal-pop'), 5000);
    await h.sleep(600);
    s = await page.eval(SNAP);
    console.log('  气泡 left ' + (s.pop && s.pop.left) + ' · 侧栏右缘 ' + s.railRight + ' · 卡 ' + (s.pop && s.pop.cards));
    check(popTag + '：开在压缩块右边', !!s.pop && s.pop.left >= s.railRight,
      { left: s.pop && s.pop.left, railRight: s.railRight });
    check(popTag + '：留在视口里', !!s.pop && s.pop.left >= 0 && s.pop.top >= 0
      && s.pop.bottom <= s.pop.vh + 1 && s.pop.left < s.pop.vw, { pop: s.pop });
    check(popTag + '：里面是全量卡（六家）', s.pop.cards === 6, { cards: s.pop.cards });
    check(popTag + '：里面没有展开 / 刷新按钮', s.pop.btns === 0 && s.pop.nowIcon === 0,
      { btns: s.pop.btns, nowIcon: s.pop.nowIcon });
    check(popTag + '：本机产物明细也在这里', /本次 3 份/.test(s.pop.mirL3), { mirL3: s.pop.mirL3 });
    check(popTag + '：每开一次自动重取一轮余额', s.calls >= before + 6, { before, after: s.calls });
    /* 点里面不关 */
    await page.eval(() => {
      const c = document.querySelector('.sb-bal-pop .sb-bal-card');
      if (c) c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      return true;
    });
    await h.sleep(120);
    check(popTag + '：点里面不关', await page.eval(() => !!document.querySelector('.sb-bal-pop')), {});
    /* 点外面关 */
    await clickOutside();
    await h.sleep(150);
    check(popTag + '：点别处自动关闭', !(await page.eval(() => !!document.querySelector('.sb-bal-pop'))), {});
    /* 再开一次：Esc 关 */
    await clickSum();
    await page.waitFor(() => !!document.querySelector('.sb-bal-pop'), 5000);
    await h.sleep(200);
    await pressEsc();
    await h.sleep(150);
    check(popTag + '：Esc 也能关', !(await page.eval(() => !!document.querySelector('.sb-bal-pop'))), {});
    /* 再点一次压缩块 = 收起 */
    await clickSum();
    await page.waitFor(() => !!document.querySelector('.sb-bal-pop'), 5000);
    await clickSum();
    await h.sleep(150);
    check(popTag + '：再点压缩块就收起', !(await page.eval(() => !!document.querySelector('.sb-bal-pop'))), {});

    /* ---------- 档四：矮窗（≤660px 高）满形态 —— 整块退成压缩版，点开气泡 ---------- */
    s = await open(1024, 600, true);
    bal = await page.eval(BARS, '#sbBalance');
    nv = await page.eval(BARS, '.sidebar nav');
    check('矮窗满形态：#sbBalance 无内滚动条', !bal.barY && !bal.barX && !bal.miss, bal);
    check('矮窗满形态：导航无内滚动条且全部露出', !nv.barY && !nv.barX && s.navClipped === 0, { nav: nv, clipped: s.navClipped });
    check('矮窗满形态：卡块不画，压缩块是详情入口', s.sumVis && !s.bodyVis && s.sumRole === 'button',
      { sumVis: s.sumVis, bodyVis: s.bodyVis, role: s.sumRole });
    await clickSum();
    await page.waitFor(() => !!document.querySelector('.sb-bal-pop'), 5000);
    const popShort = await page.eval(SNAP);
    check('矮窗满形态：气泡照样开得出全量卡', !!popShort.pop && popShort.pop.cards === 6, { pop: popShort.pop });
    await clickOutside();
    await h.sleep(120);

    /* ---------- 档五：高度扫描 ——「余额区滚动条 = 0（任意窗口尺寸）」，导航不许被裁 ---------- */
    const resizeOnly = async (ht, expanded) => {
      await page.setSize(1440, ht);
      if ((await isOpen()) !== expanded) await setOpen(expanded);
      await page.eval(() => { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('sb-balance-refresh')); return true; });
      await h.sleep(450);
      return { b: await page.eval(BARS, '#sbBalance'), v: await page.eval(BARS, '.sidebar nav'),
        g: await page.eval(GUTTER, '#sbBalance .sb-bal-cards'), st: await page.eval(SNAP) };
    };
    for (const expanded of [true, false]) {
      for (const ht of [480, 560, 640, 720, 800, 960, 1100]) {
        const tag = (expanded ? '满形态' : '窄形态') + ' @1440x' + ht;
        const r = await resizeOnly(ht, expanded);
        check(tag + '：余额区没有内滚动条（纵/横）', !r.b.barY && !r.b.barX && !r.b.miss, { bal: r.b });
        check(tag + '：导航没有内滚动条且全部不被裁',
          !r.v.barY && !r.v.barX && r.st.navCount >= 6 && r.st.navClipped === 0,
          { nav: r.v, navClipped: r.st.navClipped });
        if (r.g.miss) continue;
        /* 卡列表可见时也不许露出滚动条槽（藏起来的那一条不算）。 */
        check(tag + '：卡列表不画滚动条', r.g.gutter <= 0, { gutter: r.g.gutter });
      }
    }

    /* ---------- 档六：两个形态之间来回切，一切都还在 ---------- */
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
    check('来回切之后余额区仍然完整（六张卡）', back.cardTotal === 6, { cards: back.cardTotal });

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
