#!/usr/bin/env node
/* 滚动位判据：**点一颗按钮不该把视口甩回最上面**。
   用户报过「有的页面点击按钮等组件后视角会移动到页面最上方」——
   根因是「整片重画把滚动容器一起换掉了」：`el.innerHTML = …` 之后，
   里面那只滚动容器是**新节点**，scrollTop 从 0 起。

   保护不在外壳：全站一份公共件 `Wb.viewport.keep`（实现 `web/ui/workbench.js`），
   重画点自己调它（列表那一族由 `Wb.cards.paint` 统一调用）。这一条盯机制本身：
   · **裸重画确实会丢**：不套 keep 的那一次必须回到 0 —— 它是对照，
     没有它，「keep 把位置还回去」可能只是浏览器自己没动。
   · **机制**：套 keep 的那一次必须还回原处（重画把容器整个换掉也一样找回）。
   · **往壳子里钻**：滚动容器的直接子节点是一整组 / 一整栏时，壳子里塌掉一截也要把
     眼前那一行钉住（锚点落在「一行」那种尺度，不是落在壳子上）。
   · **横向**：`scrollLeft` 与纵向同一趟一起还（候选条那一族）。
   · **外层**：`opts.outer` 罩住「这一页在窄窗里改由外层滚」的那一只祖先。
   · **共享列表件**：`Wb.cards` 整箱重画（换一批条目、高度也变了）之后位置还在 ——
     工作台右栏 / 收藏 / 资产库的列表都走这一份，它是「点按钮重画列表」的实景。
   · **节点跨空列表存活**：同一份 `Wb.cards` 画到空列表、再画回同一批条目时，必须按 key
     找回**原来那一批 DOM 节点**（一张都不重建），而条目内容变了的那一张必须重画。
     这一条管的是「搜一个不命中的词再清空」那一趟要不要从零重建整箱 —— 只数结构（画了几次、
     是不是同一个节点），不量毫秒：机器负载会让计时读数假红。
   · **展开**：`viewport.reveal(块, { pin: 那一行 })` 把点中的那一行钉在视野里，
     块比容器高也不许把行顶出去（对照：不传 pin 就是旧的「底边对齐」滚法，行会没）。

   这一条只喂合成宿主、不点真实组件：它量的是机制，要快要稳、不碰用户数据。
   「按路由喂滚动状态 + 真点界面上那颗按钮」在 tests/e2e/viewport-clicks.cjs。

   路由：#assets.html（公共件在场） */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();

    /* ---------- 机制：公共件在场，裸重画丢位、套 keep 不还位就红 ---------- */
    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(() => !!document.querySelector('.assets-page'), 25000, 100);
    await page.waitFor(() => window.Wb && window.Wb.viewport && typeof window.Wb.viewport.keep === 'function', 20000, 100);
    await page.waitFor(() => typeof window.Wb.viewport.reveal === 'function'
      && typeof window.Wb.viewport.host === 'function', 20000, 100);

    const built = await page.eval(() => {
      const host = document.createElement('div');
      host.id = 'probeScrollHost';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:120px;overflow:hidden';
      const box = document.createElement('div');
      box.id = 'probeScrollBox';
      box.style.cssText = 'width:100%;height:120px;overflow-y:auto';
      box.innerHTML = '<div style="height:1200px"></div>';
      host.appendChild(box);
      document.body.appendChild(host);
      box.scrollTop = 200;
      return box.scrollTop;
    });
    must(built === 200, '造出来的那只滚动容器没滚到 200（探针本身坏了）：' + built);
    await sleep(300);   /* scroll 事件在下一帧才派发，锚点按那一帧之后的位置量 */

    const bare = await page.eval(() => {
      const host = document.getElementById('probeScrollHost');
      host.innerHTML = host.innerHTML;          /* 不套公共件：新节点从 0 起 */
      const now = document.getElementById('probeScrollBox');
      return now ? Math.round(now.scrollTop) : -1;
    });
    must(bare === 0, '裸重画本该把滚动位甩回顶（这一条是对照，它不成立就说明探针量错了）：' + bare);

    const kept = await page.eval(() => {
      const host = document.getElementById('probeScrollHost');
      const box = document.getElementById('probeScrollBox');
      box.scrollTop = 200;
      window.Wb.viewport.keep(host, () => { host.innerHTML = host.innerHTML; });
      const now = document.getElementById('probeScrollBox');
      return now ? Math.round(now.scrollTop) : -1;
    });
    must(kept === 200, '整片重画把滚动位吃掉了：' + kept + '（公共件 Wb.viewport.keep 没还原）');

    await page.eval(() => { const host = document.getElementById('probeScrollHost'); if (host) host.remove(); });

    /* ---------- 共享列表件：整箱重画也走 keep ----------
       Wb.cards.paint 是全站「列表重画」的唯一一份（工作台右栏 / 收藏 / 资产库都经它），
       它自己调了 Wb.viewport.keep —— 这里用一个探针箱照同一份 API 走一遍：
       60 条 → 滚到中段 → 换一批（40 条换掉尾部 20 条、每条还从 40px 变成 44px）→ 位置必须还在。
       ⚠「还在」的量法是**锚点**（第一个可见的那一条仍停在原来的视口偏移上），不是 scrollTop 的像素值：
       锚点以上的内容变高了，scrollTop 本来就该跟着变大（仍按 600 复位的写法会让锚点往上漂 60px）——
       全站契约 / `web/ui/workbench.js` 的 viewport.keep。
       浏览器自己的 scroll anchoring 也会动一次，keep 负责把残差按锚点抹平。 */
    const listOk = await page.eval(() => {
      const host = document.createElement('div');
      host.id = 'probeCardsHost';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:200px;overflow:hidden';
      const box = document.createElement('div');
      box.id = 'probeCardsBox';
      box.style.cssText = 'width:100%;height:200px;overflow-y:auto';
      host.appendChild(box);
      document.body.appendChild(host);
      const mk = (i, h) => ({ key: 'k' + i, h });
      const listA = []; for (let i = 0; i < 60; i++) listA.push(mk(i, 40));
      const api = window.Wb.cards.create({
        box: box, keyOf: it => it.key, sigOf: it => it.key + ':' + it.h,
        htmlOf: it => '<div style="height:' + it.h + 'px">' + it.key + '</div>',
      });
      /* 第一个可见的那一条：它的**视口偏移**才是「我原来在看哪儿」。 */
      const anchorOf = () => {
        const er = box.getBoundingClientRect();
        for (const k of box.children) {
          if (k.getBoundingClientRect().bottom > er.top + 1) {
            return { key: k.getAttribute('data-tkey'), off: Math.round(k.getBoundingClientRect().top - er.top) };
          }
        }
        return null;
      };
      api.paint(listA);
      box.scrollTop = 600;
      const before = { top: Math.round(box.scrollTop), anchor: anchorOf() };
      /* 顶部那几条高度变了 + 尾部换掉一批：锚点以上的高度动了，按像素还原会漂。 */
      const listB = listA.slice(0, 40).map(it => ({ key: it.key, h: 44 }))
        .concat([{ key: 'n1', h: 40 }, { key: 'n2', h: 40 }]);
      api.paint(listB);
      const after = { top: Math.round(box.scrollTop), anchor: anchorOf() };
      host.remove();
      return { before: before, after: after };
    });
    must(listOk.before.top > 400, '列表探针没滚下去（探针本身坏了）：' + JSON.stringify(listOk));
    must(listOk.after.top > 400, 'Wb.cards 整箱重画把列表甩回了顶上：' + JSON.stringify(listOk));
    must(listOk.after.anchor && listOk.after.anchor.key === listOk.before.anchor.key,
      '重画之后第一个可见的条目换了（锚点没找回来）：' + JSON.stringify(listOk));
    must(Math.abs(listOk.after.anchor.off - listOk.before.anchor.off) <= 2,
      'Wb.cards 整箱重画把锚点漂了：' + JSON.stringify(listOk) + '（paint 里没走 Wb.viewport.keep）');

    /* ---------- 卡片节点跨「空列表」存活：对齐是复用，不是从零重建 ----------
       搜一个不命中的词、再把框清空，是这一箱最贵的一趟：paint 到空列表时只换掉容器里的内容，
       `els` 那一批节点必须留在手上，下一次同一批条目按 key 找回**同一批 DOM 节点**插回去。
       留在手上与从零重建差一个数量级（1500 张卡那一档实测差近十倍），所以这一条盯结构事实
       —— 画了几次、找回的是不是原来那个节点 —— 不盯毫秒：本机负载会让计时读数假红。
       反向也要成立：留着节点不等于留着旧画面。条目内容变了那一张必须重画；反复筛几轮之后
       摘下来的节点要有上限，不然留在手上的那份只涨不落。 */
    const reuse = await page.eval(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:200px;overflow:hidden';
      const box = document.createElement('div');
      box.style.cssText = 'width:100%;height:200px;overflow-y:auto';
      host.appendChild(box);
      document.body.appendChild(host);
      let drawn = 0;
      const api = window.Wb.cards.create({
        box: box, keyOf: it => it.key, sigOf: it => it.key + ':' + it.txt,
        htmlOf: it => { ++drawn; return '<div>' + it.txt + '</div>'; },
      });
      const mk = (n, pre) => Array.from({ length: n }, (_, i) => ({ key: pre + i, txt: 'a' }));
      const keys = () => [...box.children].filter(e => e.classList.contains('task'))
        .map(e => e.getAttribute('data-tkey'));
      const list = mk(30, 'r');
      api.paint(list);
      const built = drawn;
      const node7 = api.el('r7');
      api.paint([]);
      const afterEmpty = { cards: keys().length, empty: !!box.querySelector('.empty') };
      drawn = 0;
      api.paint(list);
      const back = { drawn: drawn, same: !!node7 && api.el('r7') === node7, order: keys().join(',') === list.map(it => it.key).join(',') };
      /* 内容变了那一张必须重画，不能因为节点还留着就留着旧画面。 */
      const edited = list.map((it, i) => (i === 3 ? { key: it.key, txt: 'b' } : it));
      drawn = 0;
      api.paint(edited);
      const changed = { drawn: drawn, text: api.el('r3').textContent };
      /* 40 轮各 5 条、每轮换一批新 key：没有上限的话手上会攒下这 200 个节点。 */
      for (let r = 0; r < 40; r++) api.paint(mk(5, 'c' + r + '-'));
      const churn = api.count();
      host.remove();
      return { built, afterEmpty, back, changed, churn, touched: 30 + 200 };
    });
    must(reuse.built === 30, '第一次画没把 30 张都建出来（探针本身坏了）：' + JSON.stringify(reuse.built));
    must(reuse.afterEmpty.cards === 0 && reuse.afterEmpty.empty,
      '画空列表那一次没换成空态（列表里还有 ' + reuse.afterEmpty.cards + ' 张 / 空态 '
      + reuse.afterEmpty.empty + '）——这一条是对照的地基，它坏了后面都算不准');
    must(reuse.back.drawn === 0, '清空之后把同一批条目再画一遍，重建了 ' + reuse.back.drawn
      + ' 张卡：空列表那一次不该把手上的节点清掉（一次「搜不命中→清空」就是从零重建那一趟）');
    must(reuse.back.same, '找回的不是原来那一批节点（els 被清了，或者对齐没按 key 找回旧节点）');
    must(reuse.back.order, '清空再画回来，卡片的次序没按列表复原：' + JSON.stringify(reuse.back.order));
    must(reuse.changed.drawn === 1 && reuse.changed.text === 'b',
      '条目内容变了没有只重画那一张（重画 ' + reuse.changed.drawn + ' 张 / 现在写着「'
      + reuse.changed.text + '」）：留着节点不等于留着旧画面');
    must(reuse.churn < reuse.touched, '反复筛 40 轮之后手上还留着 ' + reuse.churn + ' 个节点'
      + '（这一路一共出现过 ' + reuse.touched + ' 个 key）：摘下来的节点没有上限，只涨不落');

    /* ---------- 横向：候选条那一族 ----------
       重画换掉容器时 scrollLeft 同样从 0 起；还原与纵向共用同一趟锚点记账。 */
    const xOk = await page.eval(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:100px;overflow:hidden';
      const box = document.createElement('div');
      box.style.cssText = 'width:100%;height:100px;overflow-x:auto;overflow-y:hidden;white-space:nowrap';
      let inner = '';
      for (let i = 0; i < 40; i++) inner += '<span style="display:inline-block;width:60px">x' + i + '</span>';
      box.innerHTML = inner;
      host.appendChild(box);
      document.body.appendChild(host);
      box.scrollLeft = 300;
      const before = Math.round(box.scrollLeft);
      window.Wb.viewport.keep(host, () => { host.innerHTML = host.innerHTML; });
      const now = host.firstElementChild;
      const after = now ? Math.round(now.scrollLeft) : -1;
      host.remove();
      return { before: before, after: after };
    });
    must(xOk.before === 300, '横向探针没滚到位（探针本身坏了）：' + JSON.stringify(xOk));
    must(xOk.after === 300, '重画把横向滚动位吃掉了：' + JSON.stringify(xOk) + '（keep 没还原 scrollLeft）');

    /* ---------- 外层：opts.outer ----------
       「这一页在窄窗里改由外层滚」（导演台 ≤900px / 整页滚的那些页）：重画只换掉外层里
       更深的一块，外层自己的子节点没动 —— 那一格的滚动位在内容被掏空的那一帧被夹回上限，
       长回来不会自动补。外壳把 html/body 钉成 overflow:hidden，文档永远不滚，
       所以「整页滚」在这类产品里总是一只祖先元素，用 host 现找、用 outer 点名罩住。 */
    const outerProbe = () => {
      const outer = document.createElement('div');
      outer.style.cssText = 'position:fixed;left:-9999px;top:0;width:240px;height:160px;overflow-y:auto';
      const col = document.createElement('div');
      col.style.cssText = 'height:700px';
      const repaint = document.createElement('div');
      repaint.innerHTML = '<div style="height:300px"></div>';
      const tail = document.createElement('div');
      tail.style.cssText = 'height:400px';
      col.appendChild(repaint); col.appendChild(tail);
      outer.appendChild(col);
      document.body.appendChild(outer);
      outer.scrollTop = 300;
      const before = Math.round(outer.scrollTop);
      const fn = () => {
        repaint.innerHTML = '';                 /* 内容塌了：外层被夹回新上限 */
        void outer.scrollTop;                    /* 读一次，把夹算兑现 */
        repaint.innerHTML = '<div style="height:300px"></div>';
      };
      window.Wb.viewport.keep(repaint, fn);      /* 不点名外层：这一条是对照 */
      const naked = Math.round(outer.scrollTop);
      outer.scrollTop = 300;
      window.Wb.viewport.keep(repaint, fn, { outer: true });
      const keptY = Math.round(outer.scrollTop);
      outer.remove();
      return { before: before, naked: naked, kept: keptY };
    };
    const outerOk = await page.eval(outerProbe);
    must(outerOk.before === 300, '外层探针没滚到位（探针本身坏了）：' + JSON.stringify(outerOk));
    must(outerOk.naked < 300, '外层本该被夹回上限（这一条是对照，它不成立就是探针量错了）：' + JSON.stringify(outerOk));
    must(outerOk.kept === 300, '外层在滚时重画把整页甩上去了：' + JSON.stringify(outerOk) + '（keep 的 opts.outer 没罩住祖先）');

    /* ---------- 锚点要往壳子里钻：一整组塌掉一截 ----------
       滚动容器的直接子节点常常是一整只壳子（设置页的一个 .set-group、素材库的一栏），
       它的顶边早就在视野外。只按「第一个可见的**子元素**」量，壳子里面塌掉一截量不出来：
       壳子的顶没动 → keep 等于没做事 → 用户眼前那一行整片上移。
       所以锚点钻进壳子，落到「一行」那种尺度；重画把行换成新节点也按同一条路径找回新的那一行。
       `overflow-anchor:none` 关掉浏览器自己的 scroll anchoring —— 这一条要量的是公共件，
       留着它的话「裸重画」那一次也可能被浏览器偷偷补好，对照就假绿了。 */
    const deepProbe = () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:200px;overflow:hidden';
      const box = document.createElement('div');
      box.style.cssText = 'width:100%;height:200px;overflow-y:auto;overflow-anchor:none';
      const body = top => '<div style="height:' + top + 'px"></div>'
        + Array.from({ length: 20 }, (_, i) => '<div style="height:40px">R' + i + '</div>').join('')
        + '<div style="height:600px"></div>';
      const grp = document.createElement('div');
      grp.innerHTML = body(600);
      box.appendChild(grp);
      host.appendChild(box);
      document.body.appendChild(host);
      /* 眼前那一行是谁、离容器顶多远：这就是「用户看到的还是不是同一屏」。 */
      const read = () => {
        const br = box.getBoundingClientRect(), kids = grp.children;
        for (let i = 0; i < kids.length; i++) {
          const r = kids[i].getBoundingClientRect();
          if (r.bottom > br.top + 1) return { idx: i, off: Math.round(r.top - br.top) };
        }
        return { idx: -1, off: 0 };
      };
      box.scrollTop = 620;                       /* 上面那一坨 600px 刚滚过去，第一行露着下半截 */
      const start = read();
      window.Wb.viewport.keep(box, () => { grp.innerHTML = body(200); });   /* 壳子里塌掉 400px */
      const kept = read();
      grp.innerHTML = body(600);
      box.scrollTop = 620;
      const back = read();
      grp.innerHTML = body(200);                 /* 对照：同样这一次塌法，不套公共件 */
      const naked = read();
      host.remove();
      return { start: start, kept: kept, back: back, naked: naked };
    };
    const deepOk = await page.eval(deepProbe);
    must(deepOk.start.idx === 1 && deepOk.start.off === -20,
      '深锚点探针没滚到「第一行露着下半截」（探针本身坏了）：' + JSON.stringify(deepOk));
    must(deepOk.back.idx === deepOk.start.idx && deepOk.back.off === deepOk.start.off,
      '同一个位置两次读数对不上（探针量错了）：' + JSON.stringify(deepOk));
    must(deepOk.naked.idx !== deepOk.start.idx,
      '裸重画本该让停在容器上缘的那一行换掉（顶上塌掉 400px，视野里就成了另几行）——'
      + '这一条是对照，它不成立就是探针量错了：' + JSON.stringify(deepOk));
    must(deepOk.kept.idx === deepOk.start.idx && deepOk.kept.off === deepOk.start.off,
      '壳子里塌掉一截，公共件没把眼前那一行还回原位：' + JSON.stringify(deepOk)
      + '（keep 的锚点只量滚动容器的直接子节点，得钻进壳子）');

    /* ---------- 扫描那一趟不读「会不会滚」，只读「此刻滚开没有」 ----------
       `_grab` 要找的是**重画前真的滚开着**的那几只：停在 0 的一格没有要还的位置（`_anchorOf`
       对 ≤0 直接返回 null）。所以判定用 `scrollTop` / `scrollLeft`（盒子那一份读数），
       不用 `scrollHeight` / `scrollWidth` —— 后两枚读的是整棵子树的可滚范围，除了贵，
       还会把 `content-visibility` 故意跳过的那一格重新排一遍（资产库那 1500 张卡的列表最吃这个）。
       这里数**读了几次**那两枚，不量毫秒：机器负载会让计时读数假红，而「读没读」是结构事实。
       反向对照（把扫描改回逐格问「会不会滚」）就是这一条红。 */
    const cheapScan = await page.eval(() => {
      const rdH = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      const rdW = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
      let hits = 0;
      Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { ++hits; return rdH.get.call(this); } });
      Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get() { ++hits; return rdW.get.call(this); } });
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:200px;overflow:hidden';
      const box = document.createElement('div');
      box.style.cssText = 'width:100%;height:200px;overflow-y:auto';
      let html = '';
      for (let i = 0; i < 160; i++) html += '<div style="height:30px">行' + i + '</div>';
      /* 滚开着的那一只混在这几百格中间，带一枚身份（找回时走身份那张表，那一趟也只在
         命中身份的那几格上才问「会不会滚」）。 */
      box.innerHTML = html + '<div data-mid="m1" style="height:60px;overflow-y:auto">'
        + '<div style="height:400px"></div></div>' + html;
      host.appendChild(box);
      document.body.appendChild(host);
      const mid = box.querySelector('[data-mid="m1"]');
      box.scrollTop = 900;
      mid.scrollTop = 120;
      const start = { box: Math.round(box.scrollTop), mid: Math.round(mid.scrollTop) };
      hits = 0;
      window.Wb.viewport.keep(host, () => { host.innerHTML = host.innerHTML; });
      const reads = hits;
      /* 重画之后两只容器都是**新节点**：读手上那只旧的（已从文档里摘掉）永远是 0，
         量的就不是「还没还回来」了 —— 按 host 现取。 */
      const nbox = host.firstElementChild;
      const after = nbox && nbox.querySelector('[data-mid="m1"]');
      const end = { box: nbox ? Math.round(nbox.scrollTop) : -1, mid: after ? Math.round(after.scrollTop) : -1 };
      Object.defineProperty(Element.prototype, 'scrollHeight', rdH);
      Object.defineProperty(Element.prototype, 'scrollWidth', rdW);
      host.remove();
      return { start, end, reads, nodes: 320 };
    });
    must(cheapScan.start.box === 900 && cheapScan.start.mid === 120,
      '扫描探针没把两只容器都滚到位（探针本身坏了）：' + JSON.stringify(cheapScan));
    must(cheapScan.end.box === 900 && cheapScan.end.mid === 120,
      '几百格里混着一只在滚的容器，重画后位置没还回来：' + JSON.stringify(cheapScan));
    must(cheapScan.reads <= 12, '重画前那一趟扫了 ' + cheapScan.reads + ' 次「会不会滚」'
      + '（' + cheapScan.nodes + ' 格里逐格读 scrollHeight / scrollWidth）：'
      + '扫描只该问「此刻滚开没有」，逐格问会把整份布局催起来、还会重排 content-visibility 跳过的那一格');

    /* ---------- 有身份的容器被挪了位置：找回按身份，不按「第几格」 ----------
       卡片流会重排：`_byPath` 按下标链找到的那张是**邻卡**，把位还到邻卡身上就是
       「A 卡的滚动位跑到 B 卡上」。带身份（`_keyOf` 认得出）的那一只才走得通那张表；
       那张表只给 `_grab` 记下的那几枚身份建，建表那一趟也只在命中身份的格上才问「会不会滚」。
       对照：同样这一次换序，容器没有身份 → 只能够下标 → 还错（这一条保证探针真在量换序）。 */
    const identity = await page.eval(() => {
      const build = withKey => {
        const card = (name, top) => '<div style="height:120px"><div ' + (withKey ? 'data-mid="' + name + '"' : '')
          + ' style="height:60px;overflow-y:auto"><div style="height:' + top + 'px"></div></div></div>';
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-9999px;top:0;width:260px;height:150px;overflow:hidden';
        host.innerHTML = '<div>' + card('a', 400) + card('b', 400) + '</div>';
        document.body.appendChild(host);
        const box = host.children[0];
        box.children[0].firstElementChild.scrollTop = 150;
        const start = Math.round(box.children[0].firstElementChild.scrollTop);
        /* 换序：A 卡与 B 卡对调 —— 重画之后「第 0 格」不再是当初那一只。 */
        window.Wb.viewport.keep(host, () => {
          host.innerHTML = '<div>' + card('b', 400) + card('a', 400) + '</div>';
        });
        const out = {
          start,
          a: Math.round(host.firstElementChild.children[1].firstElementChild.scrollTop),
          b: Math.round(host.firstElementChild.children[0].firstElementChild.scrollTop),
        };
        host.remove();
        return out;
      };
      return { keyed: build(true), naked: build(false) };
    });
    must(identity.keyed.start === 150, '身份探针没把那一格滚到位（探针本身坏了）：' + JSON.stringify(identity));
    must(identity.keyed.a === 150 && identity.keyed.b === 0,
      '带身份的容器被换序后没把位还给自己（或还给了邻卡）：' + JSON.stringify(identity.keyed)
      + '（找回没走身份那张表）');
    must(identity.naked.start === 150 && identity.naked.a === 0 && identity.naked.b === 150,
      '对照不成立：没有身份的容器被换序后本该把位还到邻卡身上（这一条保证探针真在量换序）：'
      + JSON.stringify(identity.naked));

    /* ---------- 展开：viewport.reveal 的钉位夹算 ----------
       等高卡里展开一坨比卡内可视区还高的面板：只按「把整块带进视野」滚，点中的那一行必然
       从容器上缘顶出去（用户报的「展开后找不到那颗收起按钮」）。传 pin 就是把那一行钉住，
       面板超出的一截留在容器里自己滚 —— 卡高不许为了展开而变。 */
    const rev = await page.eval(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:180px;overflow:hidden';
      const box = document.createElement('div');
      box.style.cssText = 'width:100%;height:180px;overflow-y:auto';
      box.innerHTML = '<div style="height:20px"></div>'
        + '<div id="probePin" style="height:40px"></div>'
        + '<div id="probePanel" style="height:400px"></div>'
        + '<div style="height:40px"></div>';
      host.appendChild(box);
      document.body.appendChild(host);
      const pin = box.querySelector('#probePin'), panel = box.querySelector('#probePanel');
      /* 点中那一行时它在容器里的位置（露着一截，还能点）与面板露出的高度。 */
      const read = () => {
        const cr = box.getBoundingClientRect(), pr = pin.getBoundingClientRect(), nr = panel.getBoundingClientRect();
        return {
          top: Math.round(box.scrollTop),
          pinIn: pr.top >= cr.top - 1 && pr.bottom <= cr.bottom + 1,
          panelShown: Math.round(Math.min(nr.bottom, cr.bottom) - Math.max(nr.top, cr.top))
        };
      };
      box.scrollTop = 0;
      const start = read();
      window.Wb.viewport.reveal(panel);                       /* 不钉：旧的「底边对齐」滚法 */
      const noPin = read();
      box.scrollTop = 0;
      window.Wb.viewport.reveal(panel, { pin: pin });         /* 钉住点中的那一行 */
      const pinned = read();
      box.scrollTop = 4;
      window.Wb.viewport.reveal(pin, { pin: pin });           /* 要展开的块本来就在视野里 */
      const noop = read();
      host.remove();
      return { start: start, noPin: noPin, pinned: pinned, noop: noop };
    });
    must(rev.start.pinIn, '探针里点中的那一行本来就不在视野里（探针本身坏了）：' + JSON.stringify(rev));
    must(rev.noPin.top > rev.pinned.top, '钉位没夹住那一次滚动：' + JSON.stringify(rev) + '（pin 的夹算没生效）');
    must(!rev.noPin.pinIn,
      '对照不成立：不钉位本该把那一行顶出视野（reveal 没按「底边对齐」滚）：' + JSON.stringify(rev));
    must(rev.pinned.pinIn, 'reveal 把点中的那一行推出视野了：' + JSON.stringify(rev));
    must(rev.pinned.panelShown > rev.start.panelShown,
      '钉住之后展开块露出的高度不比展开前更多：' + JSON.stringify(rev) + '（reveal 没把块带进视野）');
    must(rev.noop.top === 4, '块本来就在视野里还多滚了一次：' + JSON.stringify(rev) + '（reveal 该一格不动）');

    if (page.errors && page.errors.length) {
      console.error('页面异常：\n' + page.errors.slice(0, 5).join('\n'));
      throw new Error('页面上有异常');
    }
    console.log('✓ 视口机制：裸重画甩回顶（对照）· keep 还原（纵向 / 横向 / opts.outer 外层 / 锚点钻进壳子）· '
      + '共享列表件整箱重画不吃位 · 空列表后按 key 找回同一批节点（不重建，改内容才重画）· '
      + 'reveal 钉住点中的那一行');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
