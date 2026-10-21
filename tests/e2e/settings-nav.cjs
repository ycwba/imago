#!/usr/bin/env node
/* 设置页「找到一项设置」这条路（组锚点 B1 / 关键词命中到行 B2 / 回车落点 B4 / Esc 清空 B5）。
   判据要的是**能定位、能落盘、滚动落点真的让开 sticky 导航**，不是「页面能打开」：
     顶栏吸附：这一页比屏幕高好几屏，下滑之后 sticky 顶栏必须**贴在滚动容器顶上**（上面不许留空带）——
       滚动容器自己带 padding-top 时吸附边是内容边，顶栏会停在那条留白下面，就是「没有顶在上面」；
       修法是把那份留白挪进内容层（.set-wrap），首屏那一截照旧要有，不是把它抹了；
     B1 组锚点：点最后一组（本机维护，默认折叠）→ 展开 + 滚到该组，落点停在导航下面；
        点完当场二级行与锚点高亮就换过去、落定后原地还是这一组（判定线必须落在跳转落点下面，
        不然落定事件把刚到的组判回上一组，要再滚一点才变）；
     B4 展开不写盘：折叠状态是界面偏好，但「为了跳过去而展开」那一下不许落进 localStorage；
     B2 行级命中：搜索词命中落到**行**上（.set-hit）并带计数，回车滚到第一处命中且该行整条可见，
        高亮短暂之后自己清掉；Esc 一键清空筛选；
     B5 一行声明即渲染 + 写盘：改清单里的一行（sb_bal_on）→ 值落进 localStorage，改回去也落；
        分组这一层的「一处声明」= 芯片上的组名逐颗等于模板里那一节标题（JS 里没有第二份组名单）；
     滚动只有一个出口：这一页不许再有第二处裸 `scrollIntoView`（sticky 导航不让位、也不会补校正）。
   只跑隔离实例（harness 自建 .data-probe-*），浏览器档位干净，不动用户 LS。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => {
      const nav = document.querySelector('.settings-page .set-nav');
      return !!nav && nav.querySelectorAll('.set-nav-chips .chip').length > 0;
    }, 60000);
    await h.sleep(1200);

    /* ---------- 顶栏吸附：下滑之后它必须**贴在滚动容器顶上**，上面不许留一条空带 ----------
       这一条抓的是真缺陷（用户原话「下滑后不是顶在上面的，上面有空余」）：滚动容器自己带
       padding-top 时，sticky 的吸附边是容器的**内容边**，顶栏就停在那条留白下面 —— 卡片从那截
       底下滚过去，界面上看着就是「没顶住」，而 scrollToEl 给导航让出的那 14px 也跟着算错。
       修法只搬**顶部**那一条留白（`.settings-page.page-shell { padding-top: 0 }` +
       `.set-wrap { padding-top: var(--sp-5) }`，左右与底部仍归 ui.css 的 `.page-shell` 管），
       所以判据也判三件事：容器顶部零 padding、滑下去之后顶栏 top 与容器 top 严丝合缝、
       容器最上面那 5px 里摸到的就是顶栏自己（不是背景）。 */
    const sticky = await page.eval(() => {
      const root = document.querySelector('.settings-page');
      const nav = root.querySelector('.set-nav');
      const wrap = root.querySelector('.set-wrap');
      const probe = () => {
        const r = nav.getBoundingClientRect(), rb = root.getBoundingClientRect();
        /* 取 nav 自己那一列的最上面 5px：容器是整幅宽、nav 在居中的 .set-wrap 里，
           拿容器左边去摸会摸到页面底色（那是探针写错，不是「空带」）。 */
        const hit = document.elementFromPoint(r.left + 20, rb.top + 5);
        return { gap: Math.round(r.top - rb.top), navH: Math.round(r.height),
          stick: getComputedStyle(nav).position,
          hitInNav: !!hit && !!(hit.closest && hit.closest('.set-nav')),
          hitTag: hit ? (hit.tagName + '.' + String(hit.className).split(' ').slice(0, 2).join('.')) : '' };
      };
      root.scrollTop = 0;
      const atTop = probe();
      root.scrollTop = 900;               /* 这一页比屏幕高好几屏：900 一定离开顶端 */
      const scrolled = probe();
      return { atTop, scrolled, scrollTop: Math.round(root.scrollTop),
        padTop: getComputedStyle(root).paddingTop,
        wrapPad: Math.round(parseFloat(getComputedStyle(wrap).paddingTop) || 0) };
    });
    must(sticky.scrollTop >= 800, '没有真的滑下去（scrollTop 只到 ' + sticky.scrollTop + '）：这一条判的是「下滑之后」的吸附');
    must(sticky.padTop === '0px', '滚动容器自己还留着顶部 padding（' + sticky.padTop + '）—— sticky 会停在那条带子下面，顶栏上面永远空一截');
    must(sticky.wrapPad >= 8, '顶部留白被整条删掉了（.set-wrap 的 padding-top = ' + sticky.wrapPad + '）：修的是吸附边，不是把首屏留白抹了');
    must(sticky.scrolled.stick === 'sticky', '顶栏不是 sticky（' + sticky.scrolled.stick + '）：这一页比屏幕高好几屏，没有它就得滚回顶端才能换栏');
    /* 首屏那一截不是 bug：nav 上面还有页头（标题 + 输入模式那一行）。要判的是**滑下去之后**
       sticky 的吸附边等于容器内容边 —— 停 0 才算「顶在上面」；停 20 就是用户报的那条空带。 */
    must(sticky.scrolled.gap === 0,
      '下滑之后顶栏没贴住容器顶（停在 ' + sticky.scrolled.gap + 'px）—— 那一条空带还在');
    must(sticky.atTop.gap > sticky.scrolled.gap,
      '顶栏在下滑后没有真的收上去（首屏 ' + sticky.atTop.gap + 'px → 下滑后 ' + sticky.scrolled.gap + 'px）');
    must(sticky.scrolled.hitInNav, '下滑之后顶栏自己那列的最上面 5px 摸到的不是它（摸到 ' + sticky.scrolled.hitTag +
      '）—— 那条空带还在，卡片从它底下滚过去');

    /* ---------- B1 + B4：组锚点直达（默认折叠的最后一组） ---------- */
    await page.eval(() => {
      document.querySelectorAll('.set-group.foldable').forEach(f => f.classList.remove('open'));
      const root = document.querySelector('.settings-page'); if (root) root.scrollTop = 0;
      return 1;
    });
    await h.sleep(300);
    const navH0 = await page.eval(() => Math.round(document.querySelector('.settings-page .set-nav').getBoundingClientRect().height));
    const b1 = await page.eval(async () => {
      const chips = [...document.querySelectorAll('.set-nav-chips:not(.set-nav-sub) .chip')];
      chips[chips.length - 1].click();                 /* 最后一组 = 本机维护（默认折叠） */
      await new Promise(r => setTimeout(r, 1400));      /* 平滑滚动 + 落定后的那一次校正都要等过 */
      const g = document.querySelector('.set-group[data-group="maint"]');
      const root = document.querySelector('.settings-page');
      const r1 = g.getBoundingClientRect(), rb = root.getBoundingClientRect();
      const sub = document.querySelector('.set-nav-sub');
      return {
        groupChips: chips.map(c => c.textContent.trim()),
        jumpTop: Math.round(r1.top - rb.top),
        maintOpen: g.classList.contains('open'),
        foldKey: (() => { try { return localStorage.getItem('set_fold_maint'); } catch (e) { return 'ERR'; } })(),
        subTitles: sub ? [...sub.querySelectorAll('.chip')].map(c => c.textContent.trim()) : [],
        subVisible: !!sub && !sub.hidden && sub.getBoundingClientRect().height > 0,
        navH: Math.round(document.querySelector('.set-nav').getBoundingClientRect().height),
      };
    });
    must(b1.groupChips.length >= 4, '组锚点只有 ' + b1.groupChips.length + ' 颗（B1 要 5 组都在）：' + b1.groupChips.join('、'));
    /* B5「一处声明」在分组这一层的形状：芯片上的字必须逐颗等于模板里那一节标题 ——
       组名单在 JS 里不许有第二份（折叠那一组的标题在按钮里，后面还跟着「展开」，所以取 .fold-title）。 */
    const heads = await page.eval(() => [...document.querySelectorAll('.set-group')].map(sec => {
      const hd = sec.querySelector('.set-group-h');
      return hd ? (((hd.querySelector('.fold-title') || hd).textContent) || '').trim() : '';
    }));
    must(heads.length === b1.groupChips.length && b1.groupChips.every((t, i) => t === heads[i]),
      '组锚点的字与模板标题对不上（组名只许声明一处，两边读同一份 DOM）：' + JSON.stringify(b1.groupChips) + ' vs ' + JSON.stringify(heads));
    must(heads.length === 5 && heads[heads.length - 1] === '本机维护', '组不是一共 5 组或最后一组不是默认折叠的「本机维护」：' + heads.join('、'));
    must(b1.maintOpen, '点组锚点没有把默认折叠的「本机维护」展开（命中藏在收着的组里等于没找到）');
    /* 导航是 sticky 的：目标要停在导航**下面**，但又不能滚过头。scrollToEl 的落点是 navH + 14。 */
    must(b1.jumpTop >= b1.navH - 24 && b1.jumpTop <= b1.navH + 160,
      '组锚点落点没让开 sticky 导航：导航高 ' + b1.navH + '，组顶在 ' + b1.jumpTop);
    must(b1.foldKey === null, '「为了跳过去」把折叠状态写进了 localStorage（B4：展开这一动作不写盘），实到 ' + b1.foldKey);
    must(b1.subVisible && b1.subTitles.length > 0, '二级行没出来（点组锚点后这一组的栏目标题那一排必须可见）');

    /* ---------- 一级跳转后，二级行与锚点高亮必须当场跟上（2026-10-21 报告） ----------
       旧缺陷：点组锚点滚完，组顶正好停在 scroll-margin 那条线（导航底 + 14px），
       而 activeGroup 的判定线只在导航底 + 8px —— 刚跳到的组永远差 6px 不算数，
       落定的滚动事件把它判回上一组：二级跳转要「再往下滚一点」才变。
       判三件事：点下去当场就亮 / 就换（不等滚动）；飞行途中不许被路过的组改回去；
       落定之后不加任何手动滚动，原地也必须还是这一组。 */
    const j2 = await page.eval(async () => {
      const titleOf = c => {
        const h = c.querySelector('h2');
        if (!h) return '';
        const clone = h.cloneNode(true);
        clone.querySelectorAll('.set-hcnt').forEach(x => x.remove());
        return clone.textContent.trim();
      };
      const groupTitles = i => {
        const sec = document.querySelectorAll('.set-group[data-group]')[i];
        return [...sec.querySelectorAll(':scope > .card, :scope > .fold-body > .card')]
          .filter(c => !c.hidden).map(titleOf);
      };
      const subNow = () => {
        const sub = document.querySelector('.set-nav-sub');
        return sub && !sub.hidden ? [...sub.querySelectorAll('.chip')].map(c => c.textContent.trim()) : [];
      };
      const want = groupTitles(1);
      const chips0 = [...document.querySelectorAll('.set-nav-chips:not(.set-nav-sub) .chip')];
      chips0[1].click();                                  /* 从「本机维护」往回跳到第二组 */
      await new Promise(r => setTimeout(r, 200));          /* 当场：不许等滚动 */
      const atClick = { on: chips0[1].classList.contains('on'), sub: subNow() };
      await new Promise(r => setTimeout(r, 1800));         /* 平滑滚动 + 落定校正全过完 */
      const chips1 = [...document.querySelectorAll('.set-nav-chips:not(.set-nav-sub) .chip')];
      return { want, atClick, settled: { on: chips1[1].classList.contains('on'), sub: subNow() } };
    });
    must(j2.atClick.on, '点组锚点当场没亮（高亮要等滚动事件才跟上）');
    must(j2.atClick.sub.length > 0 && j2.atClick.sub[0] === j2.want[0],
      '点组锚点当场二级行没换过去（还是别的组的栏目）：' + JSON.stringify(j2.atClick.sub));
    must(j2.settled.on, '滚动落定后锚点高亮被改回别的组了（判定线比跳转落点高，刚到的组不算数）');
    must(j2.settled.sub.length === j2.want.length && j2.settled.sub.every((t, i) => t === j2.want[i]),
      '落定之后二级行不是这一组的栏目（要再滚一点才变就是这条）：'
      + JSON.stringify(j2.settled.sub) + ' vs ' + JSON.stringify(j2.want));

    /* ---------- B2：搜索 → 行级命中 → 回车定位 → 高亮自清 → Esc 清空 ---------- */
    const b2 = await page.eval(async () => {
      const q = document.querySelector('.set-nav input[type=search]');
      q.value = 'ffmpeg';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      const hits = [...document.querySelectorAll('.settings-page .set-hit')];
      const root = document.querySelector('.settings-page');
      const before = root.scrollTop;
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const flashNow = document.querySelectorAll('.settings-page .set-flash').length;
      await new Promise(r => setTimeout(r, 1800));
      const f = document.querySelector('.settings-page .set-hit');
      const r1 = f.getBoundingClientRect(), rb = root.getBoundingClientRect();
      const nav = document.querySelector('.set-nav').getBoundingClientRect();
      return {
        hitRows: hits.length,
        counts: [...document.querySelectorAll('.settings-page .set-hcnt')].map(x => x.textContent.trim()),
        offGroups: document.querySelectorAll('.settings-page .set-group.set-off').length,
        scrolled: root.scrollTop !== before,
        firstTopUnderNav: r1.top < nav.bottom,
        firstVisible: r1.top >= rb.top - 4 && r1.bottom <= rb.bottom + 4,
        flashOnEnter: flashNow,
        flashCleared: document.querySelectorAll('.settings-page .set-flash').length,
        navBottom: Math.round(nav.bottom),
      };
    });
    must(b2.hitRows > 0, '搜「ffmpeg」一个行级命中都没有（命中要落到 .set-hit 那一行，不是整张卡）');
    must(b2.counts.length > 0 && b2.counts.some(c => /\d/.test(c)), '命中计数没画出来：' + JSON.stringify(b2.counts));
    must(b2.scrolled, '回车没有滚到第一处命中');
    must(!b2.firstTopUnderNav, '第一处命中停在 sticky 导航底下（导航底 ' + b2.navBottom + '，行顶在它上面）—— 滚动没给导航让位');
    must(b2.firstVisible, '回车之后第一处命中不在可视区里');
    must(b2.flashOnEnter >= 1, '回车后没有短暂高亮（.set-flash 一处都没有）');
    must(b2.flashCleared === 0, '高亮没有自己清掉，还留着 ' + b2.flashCleared + ' 处');

    const esc = await page.eval(async () => {
      const q = document.querySelector('.set-nav input[type=search]');
      q.focus();
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      return {
        off: document.querySelectorAll('.settings-page .set-off').length,
        hits: document.querySelectorAll('.settings-page .set-hit').length,
        value: q.value,
      };
    });
    must(!esc.value && !esc.hits && !esc.off, 'Esc 没把筛选清干净：值「' + esc.value + '」/ 命中 ' + esc.hits + ' / 被压下的行 ' + esc.off);

    /* ---------- B5：改一行声明就落盘（清单行不用回到写盘点补一句） ---------- */
    const b5 = await page.eval(async () => {
      const cb = document.querySelector('[data-mkey="sb_bal_on"]');
      if (!cb) return { missing: true };
      const was = cb.checked;
      cb.checked = !was; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1300));
      const first = (() => { try { return localStorage.getItem('sb_bal_on'); } catch (e) { return 'ERR'; } })();
      cb.checked = was; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1300));
      const back = (() => { try { return localStorage.getItem('sb_bal_on'); } catch (e) { return 'ERR'; } })();
      return { first, back, flipped: !was, restored: was };
    });
    must(!b5.missing, '清单里那一行 sb_bal_on 没渲染出来（B5 的「新增一项设置只改一行声明」不成立）');
    must(String(b5.first) !== String(b5.back), '改开关前后 localStorage 没跟着变（' + b5.first + ' → ' + b5.back + '）：这一行没落盘');

    /* ---------- 1024 档：不横向溢出、行不出现内部滚动条 ---------- */
    await page.setSize(1024, 800);
    await h.sleep(700);
    const m = await page.eval(() => {
      const root = document.querySelector('.settings-page');
      const over = [...root.querySelectorAll('.krow, .card')].filter(el => el.scrollWidth > el.clientWidth + 2).length;
      return {
        docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        overflowEls: over,
        chips: document.querySelectorAll('.set-nav-chips:not(.set-nav-sub) .chip').length,
      };
    });
    must(!m.docOverflow, '1024 档整页出现横向溢出（文档宽 ' + 1024 + ' 之外还有东西）');
    must(m.overflowEls === 0, m.overflowEls + ' 个设置行在 1024 档里被撑出自己内部的横向滚动');

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 设置页找项：下滑后顶栏贴住容器顶（gap ' + sticky.scrolled.gap + ' / 导航高 ' + sticky.scrolled.navH
      + '、容器 padding-top ' + sticky.padTop + '）· ' + b1.groupChips.length + ' 颗组锚点 + 折叠组自动展开（组顶 '
      + b1.jumpTop + ' vs 导航 ' + b1.navH + '）· 点锚点当场换二级行、落定不回跳（' + j2.settled.sub.length
      + ' 栏对齐）· 行级命中 ' + b2.hitRows + ' 处（回车落点让开 ' + b2.navBottom
      + 'px 导航）、高亮自清、Esc 清空、1024 档零溢出');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
