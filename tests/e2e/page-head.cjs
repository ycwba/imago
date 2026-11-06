#!/usr/bin/env node
/* 页头判据：各页面共用那**一条** .phead（全站唯一一份，公共层 ui.css）。
   用户报过「每页的顶栏长得都不一样」——素材库把标题藏在左轨、工作台缩在左栏、
   设置页的标题随文档滚走、导演台自己一套深底 header。
   这一条盯住统一后的形状，防止下一轮又长出第八种页头：
     · 每页都有 .phead（公共件那一份，不是各页自己画一条）
     · 标题在 .phead-h1 里且文本非空（页面名只说一次）
     · **标题左边没有图标铭牌**（2026-10-27 撤掉那枚 26px 强调色方块：
       七页各挂一枚 → 切页时标题旁边多一格、强调色也多一个落点）
     · **标题的左缘 = 本页内容列的左缘**（内容列离内容区左缘一律 32px：
       以前是五套：32 / 24 / 20 / 居中块+22 / 32-above-0 → 切页时标题左右跳）
     · 页头横带是 flex 容器（四个槽并排）
     · **横带定高 = --sz-head**（2026-11-05 补）：以前高度被「槽里最高的那颗控件」顶开，
       纯文字页 50 / 带 32px 按钮的页 57 / 导演台那颗 33px 的导出钮 58 三种并存，
       标题顶边跟着在 y=12 与 y=16 之间跳 —— 光比左缘看不见这一维，所以要单独量 y。
     · **分隔线的起止 = 内容列的起止**（线相对本页根盒子左右各内缩一枚 --shell-px）：
       以前是两套口径：.page-shell 那五页线跟着内容缩进，工作台与导演台通栏到那一块的外缘 → 同一条线两种长度。
     · **七页的首字在同一个绝对 x**（不只「离本页根盒子一样」—— 那一维抓不到某一页整块居中）
     · **页头那一格的底色七页全等且不透明**，页面根自己不许再叠一层装饰底
       （工作台曾整页带两团强调色径向渐变，页头只能写 background:transparent 透过去 →
       七页里只有它那一格是透的，切页时标题那一条跟着变色）
   路由：导演台 / 素材库 / 工作台 / 收藏 / 资产库 / 用量 / 设置（七页全在里面） */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* `col`：那一页**内容列**（标题该与它同起点）。挑的是内容区里最靠左的那一块：
   素材库是左轨、工作台是左栏、设置页是目录轨，其余是工具条那一行。
   `root` 同时是「盒子基准」：线与标题的内缩都相对它量 —— 三种壳（.page-shell 自己留白 /
   .wb 与导演台把留白写在块里）因此能用同一句判据。 */
const PAGES = [
  { hash: 'director.html', root: '.director-page', nm: '导演台', col: '.col-left' },
  { hash: 'chars.html', root: '.chars-page', nm: '素材库', col: '.mat-rail' },
  { hash: 'studio.html', root: '.studio-page', nm: '工作台', col: '.col-left' },
  { hash: 'favorites.html', root: '.fav-page', nm: '我的收藏', col: '.toolbar' },
  { hash: 'assets.html', root: '.assets-page', nm: '资产库', col: '.as-tools' },
  { hash: 'usage.html', root: '.usage-page', nm: '用量与余额', col: '.ub-layout' },
  { hash: 'settings.html', root: '.settings-page', nm: '设置', col: '.set-rail' },
];

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    /* 窗口取 1920：跨页比的是**绝对 x**，而「这一页自己另有限宽 + 居中」那种画法只在
       内容区比那档宽的时候才露出来（工作台曾经如此，首字 300 vs 别页 88）。
       窄一点的窗两边都贴着左缘，量不出这一维。 */
    await page.setSize(1920, 1080);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);

    /* --sz-head 从 :root 现读（令牌那一族都在 :root）；--shell-px 不在 :root ——
       它是各副壳自己声明的（.page-shell / .wb / 导演台的 .page-main），所以按页读它自己那一枚。 */
    const headToken = await page.eval(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sz-head')) || 0));
    must(headToken > 0, '读不到 --sz-head（页头定高那枚令牌）');

    /* 各页读到的「相对本页根盒子」的位置，攒起来最后逐条比全等。 */
    const rows = [];
    for (const p of PAGES) {
      await page.goto(proxy.base + '/shell.html#' + p.hash);
      await page.waitFor(sel => !!document.querySelector(sel), 30000, 100, p.root);
      /* 等那条横带真的画出来（导演台要等 engine 装好，页面比别页慢），再一次性读几何。 */
      const head = await (async () => {
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          const v = await page.eval((rootSel, colSel) => {
            const root = document.querySelector(rootSel);
            if (!root) return null;
            const el = root.querySelector('.phead');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (!r.height) return null;
            const h1 = el.querySelector('.phead-h1');
            const hr = h1 ? h1.getBoundingClientRect() : null;
            const colEl = colSel ? root.querySelector(colSel) : null;
            const cr = colEl ? colEl.getBoundingClientRect() : null;
            const cs = getComputedStyle(el);
            /* 这一页生效的那枚 --shell-px：它是继承来的，直接读页头自己这一格最准
               （导演台声明在 .page-main 上、.page-shell 声明在壳上、.wb 声明在 .wb 上，
                三个主容器名字不同但页头吃到的就是同一枚值）。 */
            const shellPx = Math.round(parseFloat(cs.getPropertyValue('--shell-px')) || 0);
            /* 字形盒（不含 line-height 的行距）：Range 量第一行，y 才与「看着的位置」一致。 */
            let g = hr;
            if (h1) {
              const rg = document.createRange();
              rg.selectNodeContents(h1);
              const rs = Array.from(rg.getClientRects());
              if (rs.length) g = rs[0];
            }
            return {
              title: h1 ? (h1.textContent || '').trim() : '',
              display: cs.display,
              hasIcon: !!el.querySelector('.phead-ic'),
              hasId: !!el.querySelector('.phead-id'),
              hasActs: !!el.querySelector('.phead-acts'),
              hasSub: !!el.querySelector('.phead-sub'),
              lineStyle: cs.borderBottomStyle + ' ' + Math.round(parseFloat(cs.borderBottomWidth) || 0),
              /* 页头那一格的底：七页必须同一个色，且不许是透明 ——
                 透明那一格底下要是「页面自己的一层装饰底」，切页时标题那一条就跟着变色。 */
              bg: cs.backgroundColor,
              colBg: colEl ? getComputedStyle(colEl).backgroundColor : '',
              rootColor: getComputedStyle(root).backgroundColor,
              rootBg: getComputedStyle(root).backgroundImage,
              h: Math.round(r.height),
              titleLeft: hr ? Math.round(hr.left) : -1,
              colLeft: cr ? Math.round(cr.left) : -1,
              /* 相对本页根盒子：三种壳的绝对 x 不同（有的靠 padding 留白、有的靠块自己留白），
                 内缩量必须一样，这才是「线的位置统一」。 */
              lineIn: Math.round(r.left - root.getBoundingClientRect().left),
              lineOut: Math.round(root.getBoundingClientRect().right - r.right),
              /* 文字在横带里的位置：顶边离横带顶多高 + 离那条线多高。 */
              titleIn: g ? Math.round(g.top - r.top) : -1,
              titleToLine: g ? Math.round(r.bottom - g.bottom) : -1,
              center: g ? Math.round((g.top + g.height / 2) - (r.top + r.height / 2)) : -1,
              shellPx,
            };
          }, p.root, p.col);
          if (v) return v;
          await new Promise(res => setTimeout(res, 150));
        }
        return null;
      })();

      must(head, p.nm + '：页头 .phead 没画出来');
      must(head.title === p.nm, p.nm + '：页头标题是「' + head.title + '」，不是「' + p.nm + '」');
      must(head.display === 'flex', p.nm + '：页头不是 flex 容器（四个槽并排）：' + head.display);
      must(!head.hasIcon, p.nm + '：页头里还有图标铭牌 .phead-ic（2026-10-27 起标题不带图标）');
      must(head.hasId, p.nm + '：页头没有 .phead-id（身份槽：标题）');
      /* 说明槽与动作槽按页留空，但**槽本身要在**（位置不挪；没有说明的页面也留一个空的）。 */
      must(head.hasSub, p.nm + '：页头没有 .phead-sub（说明槽的位置不能挪走）');
      must(head.hasActs, p.nm + '：页头没有 .phead-acts（动作槽的位置不能挪走）');
      must(head.colLeft >= 0, p.nm + '：找不到内容列（' + p.col + '），没法比标题的起点');
      must(Math.abs(head.titleLeft - head.colLeft) <= 1,
        p.nm + '：标题左缘 ' + head.titleLeft + ' 与内容列左缘 ' + head.colLeft
        + ' 不齐（切页时标题会左右跳）');
      /* 定高：横带高度 = --sz-head（±1，线那 1px 的舍入），不被槽里的控件顶开。 */
      must(Math.abs(head.h - headToken) <= 1,
        p.nm + '：页头高 ' + head.h + 'px，不是定高的 ' + headToken + 'px'
        + '（高度一随内容变，标题的 y 与那条线就跟着各页不一样）');
      must(head.lineStyle === 'solid 1', p.nm + '：那条分隔线不是 1px solid（border-bottom 被改走了？）：' + head.lineStyle);
      /* 线的起止：相对本页根盒子各内缩一枚该页自己的 --shell-px（左 = 内容列左缘，右 = 内容列右缘）。 */
      must(head.shellPx > 0, p.nm + '：读不到这一页的 --shell-px');
      must(Math.abs(head.lineIn - head.shellPx) <= 1,
        p.nm + '：分隔线左端离本页根盒子 ' + head.lineIn + 'px，不是这一页 --shell-px 的 ' + head.shellPx + 'px');
      must(Math.abs(head.lineOut - head.shellPx) <= 1,
        p.nm + '：分隔线右端离本页根盒子 ' + head.lineOut + 'px，不是这一页 --shell-px 的 ' + head.shellPx + 'px');
      /* 文字垂直居中在横带里（离上离下相等）—— 这一条管「标题比线高/低一截」那种漂移。 */
      must(Math.abs(head.center) <= 1, p.nm + '：标题不在横带的垂直中线上（偏 ' + head.center + 'px）');
      /* 那一格的底：公共那一份是不透明的 --bg。透明 = 底下那一层在参与画法（工作台曾经整页带渐变底，
         页头只能透过去，切页时标题那一格的颜色就跟着那一页走）。 */
      must(head.bg && head.bg !== 'rgba(0, 0, 0, 0)' && head.bg !== 'transparent',
        p.nm + '：页头那一格是透明的（底色 ' + head.bg + '）—— 底下有什么就在透什么');
      must(head.rootBg === 'none',
        p.nm + '：这一页的页面根自己带了一层装饰底（background-image: ' + head.rootBg
        + '）—— 七页同一条 --bg，页头才可能七页同一个色');
      if (p.hash === 'chars.html' || p.hash === 'settings.html') {
        must(head.colBg && head.colBg !== 'rgba(0, 0, 0, 0)' && head.colBg !== 'transparent'
          && head.colBg !== head.rootColor,
          p.nm + '：左栏底色和页面底一样（' + head.colBg + ' vs ' + head.rootColor + '），分不出这是一栏');
      }
      rows.push({ nm: p.nm, titleIn: head.titleIn, titleToLine: head.titleToLine, h: head.h,
        shellPx: head.shellPx, bg: head.bg, titleLeft: head.titleLeft });
    }

    /* 跨页全等：文字顶边离横带顶、文字底线离那条线 —— 各页必须是同一个数。 */
    const base = rows[0];
    for (const r of rows) {
      must(r.titleIn === base.titleIn, r.nm + '：标题顶边离横带顶 ' + r.titleIn + 'px，与 ' + base.nm + ' 的 ' + base.titleIn + 'px 不同（切页时标题上下跳）');
      must(r.titleToLine === base.titleToLine, r.nm + '：标题离分隔线 ' + r.titleToLine + 'px，与 ' + base.nm + ' 的 ' + base.titleToLine + 'px 不同（那一格高度各页不一）');
      must(r.bg === base.bg, r.nm + '：页头那一格的底色是 ' + r.bg + '，与 ' + base.nm + ' 的 ' + base.bg + ' 不同（切页时标题那一条会变色）');
      /* **绝对 x 也要全等**：上一组比的是「离本页根盒子」，那一维抓不到「某一页整块居中」——
         块的左缘自己就动了，页头与内容列仍然逐像素对齐，看上去合规，切页时首字照样跳一截。 */
      must(r.titleLeft === base.titleLeft, r.nm + '：标题左缘在 x=' + r.titleLeft + '，与 ' + base.nm + ' 的 x=' + base.titleLeft
        + ' 不同（这一页的主体那块自己被限宽 / 居中了，切页时首字左右跳）');
    }
    console.log('✓ 页头组件：七个页面共用一条 .phead（标题对 · 不带图标 · 四个槽都在 · 横带定高 '
      + base.h + 'px · 标题顶边离横带 ' + base.titleIn + 'px · 分隔线各内缩 ' + base.shellPx
      + 'px 与内容列同起止 · 那一格七页同一个不透明底色）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
