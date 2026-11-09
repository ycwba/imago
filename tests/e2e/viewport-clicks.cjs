#!/usr/bin/env node
/* 点击判据：**真点界面上那颗按钮**之后，视野不该回到最上面；展开完，点中的那一行还得留在视野里。
   机制本身（合成宿主、对照、reveal 的夹算）在 tests/e2e/viewport-keep.cjs；
   这一条量的是**接线**：每一处「整片重画」有没有点名它自己那只滚动容器。
   哪一处把 `Wb.viewport.keep` 删掉，这边对应的那一击就该红 —— 机制判据管不到这个。

   一击的协议（全在页内跑，见下面的 PROBE）：
     ① 在候选里挑一颗「点得动又量得出」的控件：它所在的滚动容器（`Wb.viewport.host` 现问，
        或这一档点名那只容器）能滚，且把控件对齐到容器某一缘之后 scrollTop ≥ 20。
        对齐到**下缘**（align:'bottom'）是展开档的打法：那一行贴着容器下边，展开块一挤就挤出去 ——
        正是用户报的形状；对齐到**上缘**是纯还位档的打法（同一颗控件能滚出的 scrollTop 最大）。
        控件是粘顶的（工作台那一排类型开关）对不齐 → 改成把容器滚到 frac，粘着的那颗本来就还在视野里。
     ② 等这一格布局静止（读数连续三次相同才算）→ 记 {锚点身份, 锚点离容器顶的偏移, scrollTop, 可滚上限}
     ③ 真点它（el.click()）→ 再等静止 → 再记一次
     ④ 断言见 judge
   为什么必须等静止：设置页那一条文档在装载期间会自己改滚动位置（余额、型号清单、能力逐家落定，
   每一轮都是一次带 keep 的重画），不等静止就把别人那一轮的还位算到这一击头上。

   断言：
     ① 还位：scrollTop 不许掉到「这次重画之后本来能待的位置」以下 —— 基准是 min(点前 scrollTop,
        点后可滚上限)：允许内容变矮带来的夹取，不允许弹回 0。有身份锚点且没夹在边界上时，再要求
        同一身份仍找得回、离容器顶的偏移漂移 ≤2px。
     ② 展开档（kind:'expand'）：点中的那一行仍在那一格滚动容器里（默认要**完整地**在，
        卡片整块展开那种比视野还高的改用「仍相交」），新展开的一块至少露了一截 ——
        这条直接抓「展开后找不到那颗收起按钮」。
     ③ 收缩档（kind:'shrink'）：那一行还在视野里（还回去那一下同样改了可滚上限）。
     ④ 故意的滚动（kind:'moved'，设置页目录轨那一行）：**必须真的滚过去** ——
        keep 不许把调用点自己的滚动抹掉，那是顺序约束（故意的滚动写在 keep 返回之后）。
     ⑤ 控制台零异常。
   真点到的击数有下限：大量站点被环境跳过时这条判据就退化成摆设，当场红并列出跳过清单。

   ⚠ 必须排除的点击（不是「忘了写」，是故意不点）：
     · 一切建任务 / 花钱的：生成、send、助手动作卡的「执行」、再出候选、取一次型号清单、测试连通；
     · 一切删用户数据的：[data-cdel]、.del、delscene、「从库里删掉」、清除密钥；
     · 打真外站的：[data-vfy]、[data-ttest]、[data-tfetch]（这一条还把上游指到没人听的端口，双保险）；
     · pick-dir / 云同步 / 清缓存 / 导出族（各自起进程或写用户目录）；
     · **翻页 next**：回页首是翻页自己的故意行为（翻页本来就该滚回页首），断言「锚点不变」等于把规矩反向焊死；
     · 导演台的缩放钮：缩放本来就该改视野，不是「重画吃位」。
   数据全在临时目录与独立浏览器 profile 里（harness 的 imago-probe-*），不碰用户库根。
   调试用：VP_ONLY=settings node tests/e2e/viewport-clicks.cjs 只跑点名的那一组（多组用逗号）。

   路由：#settings.html（含侧栏余额卡）· #studio.html · #director.html · #assets.html ·
        #favorites.html · #chars.html */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ONLY = (process.env.VP_ONLY || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const want = key => !ONLY.length || ONLY.indexOf(key.toLowerCase()) >= 0;

/* 一张 1×1 的 gif：探针自己造的，不去碰平台，也不发请求。 */
const PIX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ---------- 页内那一份探针 ---------- */
const PROBE = () => {
  /* 行级身份：与公共件 Wb.viewport 的 _keyOf 同一族名字，但这里是**独立实现** ——
     判据要能指出「公共件按身份找不回锚点了」，不能跟被量的那份共用一张表。 */
  const IDT = ['data-crow', 'data-mblk', 'data-acct', 'data-nav', 'data-tkey', 'data-gid',
    'data-sid', 'data-task', 'data-mid', 'data-key', 'data-id', 'data-hist-i'];
  const PIN_IDT = ['data-crow', 'data-ktoggle', 'data-panel', 'data-cap-pick', 'data-nav', 'data-mid',
    'data-acct', 'data-mblk', 'data-tkey', 'data-key'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const box = el => el.getBoundingClientRect();
  const part = (el, b) => { const r = box(el); return r.bottom > b.top + 1 && r.top < b.bottom - 1; };
  const full = (el, b) => { const r = box(el); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1; };
  const esc = v => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
  const pos = el => { try { return window.getComputedStyle(el).position; } catch (e) { return ''; } };
  const sticky = el => pos(el) === 'sticky' || pos(el) === 'fixed';
  const idOf = el => {
    for (const a of PIN_IDT) { const v = el.getAttribute(a); if (v) return { a: a, v: v }; }
    return el.id ? { a: 'id', v: el.id } : null;
  };
  const anchorOf = (c, idt) => {
    const b = box(c);
    for (const a of idt) {
      const nodes = c.querySelectorAll('[' + a + ']');
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i] === c || !part(nodes[i], b)) continue;
        return { a: a, v: nodes[i].getAttribute(a), off: Math.round(box(nodes[i]).top - b.top) };
      }
    }
    return null;
  };
  const spanOf = c => Math.round(c.scrollHeight - c.clientHeight);
  /* 公共件自己挑的那个锚点（只进失败消息，不参与断言）：量「这一屏是谁被钉住的」。
     探针的 anchorOf 按身份挑，公共件按子节点下钻挑，两边对不上就是还位失准的根。 */
  const productAnchor = c => {
    const V = window.Wb && window.Wb.viewport;
    if (!V || !V._anchorOf) return null;
    let a = null;
    try { a = V._anchorOf(c, 'y'); } catch (e) { return null; }
    return a ? { k: a.key, off: Math.round(a.delta), deep: a.path ? a.path.length : 0 } : null;
  };
  /* 写滚动位不能只 `c.scrollTop = v`：设置页那条文档带 `scroll-behavior: smooth`，
     赋值会变成一次平滑动画，写完立刻读回来还是老数（表现是「对齐之后 scrollTop 只到 0」）。
     用 behavior:'instant' 盖过 CSS，再等两帧让布局把新值落实。 */
  const goTop = async (c, v) => {
    try { c.scrollTo({ top: v, behavior: 'instant' }); } catch (e) { c.scrollTop = v; }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(c.scrollTop);
  };
  /* 型号清单那颗按钮自己就是开合状态的真相（active = 面板正开着）：探针按它挑候选，
     不靠「上一档点了什么」推断 —— 展开与收起两档因此不共用遗留状态。 */
  const panelOpen = el => !!(el.classList && el.classList.contains('active'));
  /* 等这一格静止：scrollTop 与可滚上限连续三次读数相同。装载期间每一轮异步重画都会碰它们。 */
  const settle = async (c, cap) => {
    let last = '', same = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < cap) {
      const sig = Math.round(c.scrollTop) + ':' + spanOf(c);
      same = sig === last ? same + 1 : 0;
      last = sig;
      if (same >= 2) return true;
      await sleep(120);
    }
    return false;
  };
  const contOf = (btn, o, region) => {
    if (o.host === 'mid') return btn.closest('.acct-mid');
    if (typeof o.host === 'string') return document.querySelector(o.host);
    const V = window.Wb && window.Wb.viewport;
    return (V && V.host(btn)) || region || null;
  };
  /* 把控件摆进容器里、顺便把 scrollTop 抬到量得出来的那一档。返回能不能量。 */
  const place = async (c, btn, o) => {
    if (spanOf(c) < 40) return '这一格不滚（可滚 ' + spanOf(c) + 'px），喂不出滚动位';
    if (o.mode === 'frac' || sticky(btn)) {
      await goTop(c, Math.round(spanOf(c) * (o.frac == null ? 0.5 : o.frac)));
    } else {
      const cr = box(c), er = box(btn);
      const rel = er.top - cr.top + c.scrollTop;
      const pad = o.pad == null ? 24 : o.pad;
      await goTop(c, (o.align === 'bottom')
        ? rel + er.height - cr.height + pad
        : rel - pad);
    }
    const top = Math.round(c.scrollTop);
    if (top < 20) {
      const s = window.getComputedStyle(c);
      return '对齐之后 scrollTop 只到 ' + top + '（' + c.tagName.toLowerCase() + '.'
        + String(c.className || '').split(/\s+/)[0] + '，overflow-y:' + s.overflowY
        + '、可滚 ' + spanOf(c) + '）';
    }
    if (!part(btn, box(c)) && o.mode !== 'frac' && !sticky(btn)) return '对齐之后控件不在视野里';
    return null;
  };

  const pinHostOf = (btn, o, c) => (o.pinIn === 'mid' && btn.closest('.acct-mid')) || c;
  /* 摆一次、等静止、再验一遍：装载期间这一格会自己动（余额 / 型号 / 能力逐家落定，每一轮都带一次重画），
     刚对齐好的读数会在 settle 那几秒里被换掉 —— 所以摆 → 等 → 验 要循环，验不过就重摆。
     place 那一步报的是「这颗本来摆不下」（不滚、离顶太近），直接换下一颗候选，不重试。 */
  const fit = async (c, btn, o) => {
    /* 只有开合两档拿「那一行还在不在视野里」当结论，摆位阶段才要求它先完全露着；
       keep 档（筛选、换视图、切类型）不量这一条 —— 粘顶那一排与在视野外点的那一颗本来就不需要。 */
    const wantPin = o.kind === 'expand' || o.kind === 'shrink';
    let reason = '';
    for (let k = 0; k < 3; k++) {
      const hard = await place(c, btn, o);
      if (hard) return hard;
      await settle(c, o.settleCap || 2500);
      const top = Math.round(c.scrollTop);
      const pin = pinOf(btn, o), ph = pinHostOf(btn, o, c);
      const pinOk = !wantPin || !pin || !ph || (o.pinFull === false ? part : full)(pin, box(ph));
      /* frac 打法不要求控件在那一格里面（粘顶的那一排、以及「点的是格子外面的抬头」那一族）。 */
      const inView = (o.mode === 'frac' || sticky(btn)) ? true : part(btn, box(c));
      if (top >= 20 && inView && pinOk) return '';
      reason = '等完这一格 scrollTop=' + top + '、控件' + (inView ? '在' : '不在') + '视野、那一行'
        + (pinOk ? '在' : '不在') + '（可滚 ' + spanOf(c) + '）';
    }
    return reason + '（三次都对不齐）';
  };

  window.__vpProbe = {
    async run(o) {
      const region0 = o.sel ? document.querySelector(o.sel) : null;
      if (o.sel && !region0) return { skip: '页面上没有区域 ' + o.sel };
      if (o.stage === 'hist') {
        /* 历史记录只在内存里（historyLog 开局是空的）：#editLeft 只有历史块，撑不出滚动位。
           用产品自己的写入桥造几条真历史（每条 select 都是一步编辑），这一栏才滚得起来。 */
        const B = window.WBBridge && window.WBBridge.get('director');
        if (!B || !(B.ready && B.ready())) return { skip: '导演台写入桥不在，造不出历史' };
        let made = 0; const errs = [];
        for (let i = 1; i <= 12; i++) {
          const a = { shot: i, take: 2 };
          try {
            const ck = B.check('select', a);
            if (!ck || ck.err) { errs.push(i + ':' + (ck && ck.err || '没有回执')); continue; }
            const rr = B.run('select', a);
            if (rr && rr.ok) made++; else errs.push(i + ':' + (rr && rr.err || 'run 没成'));
          } catch (e) { errs.push(i + ':' + (e && e.message)); }
        }
        if (!made) return { skip: '造历史全落空（' + errs.slice(0, 2).join('；') + '）' };
      }
      /* 前置可以是一串（导演台历史那一击：先进剪辑模式，再把历史折叠区摊开 ——
         收着的 details 只有一行 summary，撑不出滚动位）。 */
      const pres = Array.isArray(o.pre) ? o.pre : (o.pre ? [o.pre] : []);
      for (const psel of pres) {
        const p = document.querySelector(psel);
        if (!p) return { skip: '前置控件 ' + psel + ' 不在页面上' };
        p.click();
        await sleep(o.preWait || 450);
      }
      /* 候选在 pre 之后现取：项目菜单 / 剪辑左栏那一族要点了前置开关才画得出候选。 */
      const region = o.sel ? (document.querySelector(o.sel) || region0) : region0;
      if (o.sel && !region) return { skip: '前置点击之后区域 ' + o.sel + ' 不在了' };
      const pool = Array.prototype.slice.call((region || document).querySelectorAll(o.click));
      if (!pool.length) return { skip: '要点的那颗 ' + o.click + ' 不在' + (o.sel || '页面上') };
      /* 挑一颗「点得动又量得出」的：候选按 DOM 顺序，第一颗摆得下的就用它。
         o.open 是开合预筛（型号面板那一族）：状态不对的候选直接跳过、不算「摆不下」，
         所以展开那一档只会挑到关着的，收起那一档只会挑到开着的。 */
      let btn = null, c = null;
      const why = [];
      let tried = 0;
      const list = o.pick === 'last' ? pool.slice().reverse() : pool;
      const ok = el => o.open == null || panelOpen(el) === o.open;
      for (let i = 0; i < list.length && why.length < 3 && tried < 6; i++) {
        const el = list[i];
        if (!ok(el)) continue;
        const cc = contOf(el, o, region);
        if (!cc) { why.push('第 ' + (i + 1) + ' 颗找不到滚动容器'); continue; }
        if (o.kind === 'moved') {
          /* 这一档不看「还没还位」，看的是「有没有真的滚过去」：先把容器按回 0，
             目标那张卡本来就不在视野里才算量得出这一击。 */
          if (spanOf(cc) < 40) { why.push('文档不滚'); continue; }
          await goTop(cc, 0);
          const nav = el.getAttribute('data-nav');
          const t = nav && document.querySelector('.card[data-nav="' + esc(nav) + '"]');
          if (!t) { why.push('目录轨那一行没有对应的卡'); continue; }
          if (part(t, box(cc))) { why.push('目标那张卡本来就在视野里，滚不滚看不出来'); continue; }
          btn = el; c = cc; break;
        }
        ++tried;
        const bad = await fit(cc, el, o);
        if (bad) { why.push(bad); continue; }
        btn = el; c = cc; break;
      }
      if (!btn) {
        if (o.kind === 'expand' || o.kind === 'shrink' || o.kind === 'goto') {
          /* 开合档不要求先滚出位置：要看的是「展开完那一行还在不在」，容器本来在 0 也要量。 */
          for (let i = 0; i < list.length; i++) {
            const el = list[i], cc = contOf(el, o, region);
            if (!cc || !ok(el)) continue;
            await settle(cc, o.settleCap || 2000);
            const pin = pinOf(el, o), ph = pinHostOf(el, o, cc);
            if (pin && ph && part(pin, box(ph))) { btn = el; c = cc; break; }
          }
        }
        if (!btn) return { skip: o.click + ' 没有一颗摆得下：' + why.join('；') };
      }
      const pin0 = pinOf(btn, o);
      const pinId = pin0 ? idOf(pin0) : null;
      const mid0 = o.pinIn === 'mid' ? btn.closest('.acct-mid') : null;
      const midId = mid0 ? idOf(mid0) : null;
      const pinFn = o.pinFull === false ? part : full;
      const host0 = pinHostOf(btn, o, c);
      /* 展开的那一块按这一颗自己的槽找回（data-panel 与 data-mblk 是同一个槽键）：
         一家账号卡里有好几档，只认「第一个 [data-mblk]」会量到别档的面板上。 */
      const slot = (btn.getAttribute && btn.getAttribute('data-panel')) || '';
      const blkSel = slot ? '[data-mblk="' + esc(slot) + '"]' : o.block;
      const block0 = mid0 ? mid0.querySelector(blkSel || '[data-mblk]') : null;
      const before = {
        top: Math.round(c.scrollTop),
        span: spanOf(c),
        anchor: anchorOf(c, Array.isArray(o.idt) ? o.idt : IDT),
        pinIn: pin0 && host0 ? pinFn(pin0, box(host0)) : null,
        blockIn: (block0 && mid0) ? part(block0, box(mid0)) : null,
        pa: productAnchor(c),
      };
      btn.click();
      await sleep(o.wait || 300);
      /* 整片重画换掉了那一棵子树，旧句柄可能已经脱文档：容器、那一行、展开的那一块都按身份找回新的。
         容器自己没有行身份时（素材库详情层那两块滚动格）退回区域选择器现查一遍 —— 那是这一击
         自己点名的结构位置，重画之后新节点仍然长在那里。 */
      const again = id => (id ? document.querySelector('[' + id.a + '="' + esc(id.v) + '"]') : null);
      const cid = idOf(c);
      const c1 = c.isConnected ? c : (again(midId) || again(cid) || (o.sel ? document.querySelector(o.sel) : null));
      if (!c1) {
        if (midId || cid) return { skip: '那只滚动容器重画之后按身份找不回了（这一击量不了）' };
        return { fail: '滚动容器重画之后整个不在了，也没有身份可以找回' };
      }
      if (c1 !== c) await settle(c1, o.settleCap || 2500);
      const pin1 = again(pinId);
      const host1 = (o.pinIn === 'mid' ? (again(midId) || c1) : c1);
      const block1 = (blkSel && host1) ? host1.querySelector(blkSel) : null;
      const navId = btn.getAttribute && btn.getAttribute('data-nav');
      const target = (o.kind === 'moved' && navId) ? document.querySelector('.card[data-nav="' + esc(navId) + '"]')
        : ((o.kind === 'goto' && o.target) ? document.querySelector(o.target) : null);
      return {
        before: before,
        after: {
          top: Math.round(c1.scrollTop),
          span: spanOf(c1),
          anchor: anchorOf(c1, Array.isArray(o.idt) ? o.idt : IDT),
          pinIn: pin1 ? pinFn(pin1, box(host1)) : null,
          blockIn: block1 ? part(block1, box(host1)) : null,
          moved: Math.round(c1.scrollTop - before.top),
          targetIn: target ? part(target, box(c1)) : false,
          navId: navId || null,
          pa: productAnchor(c1),
        },
      };
    },
  };
  function pinOf(btn, o) {
    if (o.pin === 'crow') return btn.closest('.crow') || btn.closest('.krow') || btn;
    if (o.pin === 'card') return btn.closest('.task') || btn.closest('.card') || btn;
    if (o.pin === 'acct') return btn.closest('[data-acct]') || btn;
    return btn;
  }
};

/* ---------- 各页的站点 ---------- */
const SETTINGS = [
  /* 芯片那一排贴在文档最上面：把文档滚到中段再点它（控件已在视野外也照点）——
     这一击要量的是「按档筛选重画不许把 3000px 那一屏甩回 0」。 */
  { g: 'settings', name: '设置页·按档筛芯片', click: '[data-fchip]', kind: 'keep', mode: 'frac', frac: 0.5 },
  { g: 'settings', name: '设置页·展开密钥行', click: '[data-ktoggle]', kind: 'expand', pin: 'self' },
  /* 型号面板：开合状态由那颗按钮自己说（active = 开着），两档各挑各的 ——
     收起那一档只能挑到刚被上一档打开的那一颗，两边都不看「上一击留了什么」。
     展开时看的是「钉住按钮那一行」：面板比卡内可视区高，也只许滚到那一行贴住上缘为止。 */
  { g: 'settings', name: '设置页·展开型号清单', sel: '.set-doc-scroll', click: '[data-panel]', host: 'mid',
    kind: 'expand', open: false, pin: 'crow', pinIn: 'mid', align: 'bottom', block: '[data-mblk]' },
  { g: 'settings', name: '设置页·收起型号清单', sel: '.set-doc-scroll', click: '[data-panel]', host: 'mid',
    kind: 'shrink', open: true, pin: 'crow', pinIn: 'mid', align: 'bottom', block: '[data-mblk]' },
  { g: 'settings', name: '设置页·手动加一档（展开档位）', sel: '.set-doc-scroll', click: '[data-cap-pick]',
    kind: 'expand', pin: 'self' },
  /* 「＋ 自定义」那一步自带一次 scrollToEl（故意的滚动），所以这一击不量还位，只量
     「表单真的出现在视野里」；下一击「返回预设」没有故意的滚动，量还位 + 那张卡还在。
     wait 要盖过 scrollToEl 自己那套补校正（落定再验，最多补三回，每回隔 520ms）——
     不等它收尾，下一次击的「等静止」会被它中途那一下平滑滚搅了。
     两击量的都是那条文档（不是卡里那格 —— 添加卡在两种形态下会整块换掉自己那一格）。 */
  { g: 'settings', name: '设置页·打开自定义表', sel: '.set-doc-scroll', host: '.set-doc-scroll',
    click: '[data-cus-open]', kind: 'goto', target: '.set-doc-scroll [data-cus-close]', wait: 2600 },
  /* 自定义表是固定浮层：关掉它不改变文档高度，所以量的是「文档滚动位与眼前那一屏不动」，
     不是「把卡片流那一格还回来」（浮层后面那一格本来就一直在原位）。 */
  { g: 'settings', name: '设置页·返回预设（关闭浮层）', sel: '.set-doc-scroll', host: '.set-doc-scroll',
    click: '[data-cus-close]', kind: 'keep', mode: 'frac', frac: 0.5 },
  { g: 'settings', name: '设置页·暂时不用', click: 'input[data-off]', kind: 'keep', wait: 800 },
  /* 目录轨那一行的**目的**就是把右边的文档滚到那一张卡：这一击断言的是「真的滚过去了」，
     与上面七击相反 —— 公共件的还原不许把调用点自己的滚动抹掉。控件在左轨、滚的是右文档。
     wait 要盖过：展开「本机维护」那组（最后一张卡默认收着）+ 平滑滚整条文档 + scrollToEl
     自己那套补校正（最多三回，每回隔 520ms）。 */
  { g: 'settings', name: '设置页·目录轨跳最后一张卡', sel: '.set-rail', click: '.set-rail-i', pick: 'last',
    host: '.set-doc-scroll', mode: 'frac', frac: 0, kind: 'moved', wait: 3200 },
];
const STUDIO = [
  /* 整栏内容按类型换掉（型号 / 参数 / 输入区都不一样），没有跨类型仍然存在的行身份 →
     量的是「滚动位没被甩回顶」这一条，正是用户报的那个症状。那一排开关粘在栏顶，用 frac 打法。 */
  { g: 'studio', name: '工作台·切到图像', click: '[data-r="typeSeg"] button[data-t="image"]', kind: 'keep',
    idt: [], mode: 'frac', frac: 0.4 },
  { g: 'studio', name: '工作台·切到语音', click: '[data-r="typeSeg"] button[data-t="audio"]', kind: 'keep',
    idt: [], mode: 'frac', frac: 0.4 },
  { g: 'studio', name: '工作台·切回视频', click: '[data-r="typeSeg"] button[data-t="video"]', kind: 'keep',
    idt: [], mode: 'frac', frac: 0.4 },
];
const DIRECTOR = [
  /* 镜头行没有跨重画的行身份？有（data-sid），但这一击量的是「点了另一镜，列表重画不许弹回顶」
     —— 列表短（这一栏可滚 100 来像素），frac 摆位就够了。 */
  { g: 'director', name: '导演台·点另一镜', sel: '#scenesBox', click: '.shot-item', kind: 'keep',
    mode: 'frac', frac: 0.45 },
  /* 项目菜单：#projMenu 自己就是那只 max-height:60vh 的滚动容器，一次改名 / 移组 / 折叠
     就把整栏行重造一遍。组头带 data-gid、短片行带 data-id（engine 里给的行身份）→
     还位按身份走，折叠那一击量得出的正是「折叠后不许滚到别的行上」。 */
  { g: 'director', name: '导演台·项目菜单收起项目组', sel: '#projMenu', click: '[data-gfold]', kind: 'shrink',
    pre: '#projSwitch', preWait: 700, mode: 'frac', frac: 0.7, wait: 700 },
  { g: 'director', name: '导演台·项目菜单展开项目组', sel: '#projMenu', click: '[data-gfold]', kind: 'keep',
    mode: 'frac', frac: 0.4, wait: 700 },
  /* 历史块的开合是浏览器原生的 details 开关（不重画、不滚）；这一栏真正的重画是「点一行回退」：
     historySync 当场重画整块（罩在公共件里），日志末尾还追加一条「回退到」——
     倒序画的新行把整列往下顶一格，量的是「锚定那一行还回它自己身上，不许整屏弹回顶」。
     历史只在内存里：stage 先用写入桥造 12 条真编辑，折叠区摊开、行才存在。 */
  { g: 'director', name: '导演台·历史回退一行', sel: '#editLeft', click: '#editLeft [data-hist-i]',
    kind: 'keep', stage: 'hist', pick: 'last', pre: ['#trimBtn', '#editLeft .el-hist > summary'],
    preWait: 700, mode: 'frac', frac: 0.5, wait: 800 },
];
const ASSETS = [
  { g: 'assets', name: '资产库·类型档换到视频', sel: '.assets-page', click: '[data-kind-filter] button[data-k="视频"]',
    kind: 'keep', mode: 'frac', frac: 0.4 },
  { g: 'assets', name: '资产库·视图切档', sel: '.assets-page', click: '.viewtoggle button', kind: 'keep',
    mode: 'frac', frac: 0.4 },
  { g: 'assets', name: '资产库·点开一张卡看详情', sel: '.assets-page', click: '.grid .task', kind: 'expand',
    pin: 'card', pinFull: false, wait: 800 },
  /* 页头三档芯片点完把列表筛到那一档（状态会留下来）：排在最后，别让后面的击摆不下。
     摘要的计数带着其它筛条件现算（applyFilters({noBucket:true})）：类型档停在「视频」时
     图片任务数成 0、芯片根本不画，所以先点「全部」把类型档收回来再量。
     芯片贴在文档最上面，用 frac 打法（对齐打法会把 scrollTop 抬回 0 量不出来）。 */
  { g: 'assets', name: '资产库·页头摘要芯片', sel: '.assets-page', click: '[data-bucket]', kind: 'keep',
    pre: ['[data-kind-filter] button[data-k="全部"]'], mode: 'frac', frac: 0.5 },
];
const FAVS = [
  { g: 'favorites', name: '收藏·类型档换到视频', sel: '.fav-page', click: '[data-kind-filter] button[data-k="视频"]',
    kind: 'keep', mode: 'frac', frac: 0.4 },
  { g: 'favorites', name: '收藏·点开一张卡看详情', sel: '.fav-page', click: '.fav-page .fav-card', kind: 'expand',
    pin: 'card', pinFull: false, wait: 800 },
];
const CHARS = [
  /* 详情层里真正滚的是两块：.md-media 与 .md-doc 各自 overflow:auto。
     「换身份锚点」那一排按钮长在媒体列（.md-media）里，不是文档列。 */
  { g: 'chars', name: '素材库·详情里换身份锚点', sel: '.md-layer .md-media', click: '[data-d-act="setanchor"]',
    kind: 'keep', mode: 'frac', frac: 0.4, wait: 800 },
];
const SIDEBAR = [
  /* 满形态里「账户余额 · N 家」那条抬头是刷新入口（.sb-now-t）；.sb-bal-sum 是收起态 /
     矮窗的压缩块，点它开的是气泡不是刷新。探针会话里侧栏默认收着（sb_open 没种），
     收起态里 .sb-bal-body 整块 display:none —— 前置先点品牌砖把侧栏摊开，卡列表才有几何。
     卡列表定高三张，第四家起在里面滚：带余额接口的账号得比三张多。 */
  { g: 'sidebar', name: '侧栏·点账户余额抬头重取', sel: '#sbBalance', click: '#sbBalance .sb-now-t',
    pre: ['.sb-logo'], preWait: 700, host: '#sbBalance .sb-bal-cards', mode: 'frac', frac: 0.6,
    kind: 'keep', wait: 1200 },
];

(async () => {
  let proxy, browser, page;
  const skipped = [];
  const done = [];
  let ran = 0;
  const judge = (o, r) => {
    if (r.skip) { skipped.push(o.name + '：' + r.skip); return; }
    ++ran;
    done.push(o.name);
    if (r.fail) throw new Error(o.name + '：' + r.fail);
    const b = r.before, a = r.after;
    if (o.kind === 'moved') {
      must(Math.abs(a.moved) > 20, o.name + '：点目录轨那一行本该把文档滚到那一张卡（只滚了 '
        + a.moved + 'px）—— 「故意的滚动」被 Wb.viewport.keep 的还原抹掉了');
      must(a.targetIn === true, o.name + '：文档滚完了，目标那张卡（' + a.navId + '）却不在视野里：'
        + JSON.stringify(a));
      return;
    }
    if (o.kind === 'goto') {
      /* 这一击自带一次故意的 scrollToEl，还位那条不量（量了就是把规矩反向焊死）；
         要量的是「展开出来的那一格真的在视野里」——滚过去没滚过去都算这一条说话。 */
      must(a.targetIn === true, o.name + '：点完看不到展开的那一格（' + o.target + '）：' + JSON.stringify(a));
      return;
    }
    /* ① 还位（展开那一档不量：它的 reveal 本来就要滚，量的是②；收缩那一档没有故意的滚动，量）。 */
    if (o.kind !== 'expand') {
      const floor = Math.min(b.top, a.span);
      must(a.top >= floor - 2, o.name + '：视野从 ' + b.top + ' 掉到 ' + a.top
        + '（点完这一格最多只能待在 ' + floor + '）—— 这一处重画没点名它的容器，或公共件没还位：'
        + JSON.stringify(r));
      const clamped = a.top <= 2 || a.top >= a.span - 2;
      if (b.anchor && !clamped) {
        must(a.anchor, o.name + '：重画之后按身份找不到锚点了（' + JSON.stringify(b.anchor) + ' → ' + JSON.stringify(a) + '）');
        must(a.anchor.a === b.anchor.a && a.anchor.v === b.anchor.v,
          o.name + '：眼前那一屏换了身份：' + JSON.stringify(b.anchor) + ' → ' + JSON.stringify(a.anchor));
        must(Math.abs(a.anchor.off - b.anchor.off) <= 2,
          o.name + '：锚点漂了 ' + (a.anchor.off - b.anchor.off) + 'px：' + JSON.stringify(r));
      }
    }
    if (o.kind === 'expand') {
      must(b.pinIn === true, o.name + '：点之前那一行就不在视野里（探针喂的状态不对）：' + JSON.stringify(b));
      must(a.pinIn === true, o.name + '：展开之后点中的那一行被推出视野了（收起按钮找不回来）：' + JSON.stringify(r));
      if (o.block) {
        must(b.blockIn !== true, o.name + '：展开前那一块就已经露着（探针喂的状态不对）：' + JSON.stringify(b));
        must(a.blockIn === true, o.name + '：展开的那一块一格都没露（reveal 没起作用或被 keep 顶掉了）：'
          + JSON.stringify(r));
      }
    }
    if (o.kind === 'shrink' && o.pin) {
      must(a.pinIn === true, o.name + '：收回去之后点中的那一行不在视野里了：' + JSON.stringify(r));
      if (o.block) {
        must(b.blockIn === true, o.name + '：点之前那一个槽的面板就没露着（探针挑的不是开着的那一颗）：'
          + JSON.stringify(b));
        must(a.blockIn !== true, o.name + '：说是要收起，那一块还挂在视野里：' + JSON.stringify(r));
      }
    }
  };
  const clickAll = async list => {
    for (const o of list) {
      if (!want(o.g)) continue;
      const r = await page.eval(x => window.__vpProbe.run(x), o);
      judge(o, r);
    }
  };
  const openPage = async hash => {
    await page.goto(proxy.base + '/shell.html' + hash);
    await page.waitFor(() => window.Wb && window.Wb.viewport && typeof window.Wb.viewport.host === 'function', 25000, 100);
  };

  try {
    proxy = await h.startProxy({ env: {
      /* 上游指到一个没人听的端口：这一条只点界面，任何一次真出站都该当场失败，
         更不该把本机 .env 里的真密钥带出门（PROXY_OFF 显式给 '0'：环境变量比 .env 优先）。 */
      HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', PROXY_OFF: '0',
    } });
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.skipDataSyncBoot();
    await page.addInitScript(PROBE);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    /* 种几家「已填密钥」的账号：账号卡流里要有真的卡，.crow 行、密钥开关、型号面板才画得出来；
       侧栏余额那一档还要比「三张定高」更多的卡才滚得起来 —— 六家里带余额接口的：
       sparkcine / vgenv / deepseek / openrouter / moonshot / siliconflow。
       密钥是探针造的假串；余额那一档会去撞没人听的端口，卡照样画（原因写在第二行）。 */
    await page.eval(() => {
      ['sparkcine', 'vgenv', 'mimo', 'deepseek', 'openrouter', 'zhipu', 'moonshot', 'siliconflow']
        .forEach(k => localStorage.setItem('sk_key_' + k, 'probe-key-not-a-real-secret'));
      localStorage.setItem('sk_media_local', 'off');
      localStorage.setItem('ai_chat_off', '1');
    });

    /* ---------- 设置页（用户点名那一处），顺带侧栏余额卡 ---------- */
    if (want('settings') || want('sidebar')) {
      await openPage('#settings.html');
      await page.waitFor(() => !!document.querySelector('.set-doc-scroll .acct'), 25000, 100);
      await sleep(1200);
      await clickAll(SETTINGS);
      if (want('sidebar')) {
        /* 密钥是在导航之前才种进去的，侧栏开机那一趟已经按「没有在用的平台」画完收场；
           点名重取一轮（与抬头同一个入口的事件），占位卡画出来卡列表才有得滚。
           占位卡先画、每家回执再各重画一次 —— 得等这排回执落完（占位的小转点全消失），
           不然击摆好位之后半路一次重画把容器整个换掉，量出来的全是假摔。 */
        await page.eval(() => window.dispatchEvent(new Event('sb-balance-refresh')));
        await page.waitFor(() => document.querySelectorAll('#sbBalance .sb-bal-card').length >= 4, 30000, 200).catch(() => {});
        await page.waitFor(() => !document.querySelector('#sbBalance .spin-dot'), 30000, 200).catch(() => {});
        await sleep(800);
      }
      await clickAll(SIDEBAR);
    }

    /* ---------- 工作台：左栏整块重画 ---------- */
    if (want('studio')) {
      await openPage('#studio.html?t=video');
      await page.waitFor(() => !!document.querySelector('[data-r="typeSeg"] button[data-t="image"]'), 25000, 100);
      /* 左栏只在内容高过视口时才滚（图像 / 语音两档的表单更矮）：窗口压到 520，
         三种类型的左栏都喂得出滚动位。 */
      await page.setSize(1440, 520);
      await sleep(900);
      await clickAll(STUDIO);
      await page.setSize(1440, 900);
    }

    /* ---------- 导演台：种一批工程（每工程 12 镜），左栏与项目菜单才真的能滚 ---------- */
    if (want('director')) {
      await page.goto(proxy.base + '/shell.html');
      await page.waitFor(() => !!window.Kv, 15000);
      /* 每镜带一条已选用且成功的候选：剪辑态左栏只列 shotReady 的镜头（engine 里现筛），
         不给的话 #editLeft 只剩历史块、撑不出滚动位，「历史那一档开合」这一击摆不下。 */
      const shot = (id, name) => ({
        id: id, name: name, prompt: '画面 ' + name, duration: 5, ar: '16:9', res: '768p', tier: 'fast', draw: 1,
        refImages: [], keyframes: [],
        selId: 'v1',
        candidates: [
          { vid: 'v1', status: 'succeeded', provider: 'probe', url: PIX },
          { vid: 'v2', status: 'succeeded', provider: 'probe', url: PIX },
        ],
      });
      const projects = Array.from({ length: 18 }, (_, x) => {
        const i = x + 1;
        return {
          id: 'p' + i, name: '探针工程 ' + i, curScene: 0, curShot: 0, groupId: i % 3 === 0 ? '' : 'g' + (i % 3),
          scenes: [{ id: 'sc' + i, name: '场景 ' + i, shots: Array.from({ length: 12 }, (_, k) => shot('sh' + i + '-' + (k + 1), '镜头 ' + (k + 1))) }],
        };
      });
      await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); }, {
        projects, curId: projects[1].id, roles: [],
        groups: [{ id: 'g1', name: '甲组' }, { id: 'g2', name: '乙组' }],
        ts: Date.now(),
      });
      await page.goto(proxy.base + '/shell.html#director.html');
      await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 30000);
      await page.waitFor(() => !!document.querySelector('.shot-item'), 20000);
      await sleep(900);
      await clickAll(DIRECTOR);
    }

    /* ---------- 资产库：种 30 条（页头摘要带与类型档才有数） ---------- */
    if (want('assets')) {
      await page.goto(proxy.base + '/shell.html');
      await page.waitFor(() => !!window.Kv, 15000);
      await page.eval(px => {
        const ts = Date.now(), out = [];
        for (let i = 0; i < 20; i++) out.push({ provider: 'jia', providerName: '甲', kind: 'asset', assetId: 'jia-' + i, type: '图片', prompt: '甲图片' + i, name: '甲图片' + i, src: px, ts: ts - i * 1000 });
        for (let i = 0; i < 10; i++) out.push({ provider: 'yi', providerName: '乙', kind: 'asset', assetId: 'yi-' + i, type: '视频', prompt: '乙视频' + i, name: '乙视频' + i, src: px, ts: ts - (50 + i) * 1000 });
        /* 页头摘要三档只数 kind:'task' 的条目（bucketOf 现筛）。种缓存只能给「失败」那一档：
           首屏缓存进界面前要过 AssetLib.cacheable —— 在制 / 结果未知的任务条目两眼都活不过去
           （读时滤掉、写回也滤掉，为的是不让过期的在制卡常驻），这是产品语义，探针绕开它。 */
        out.push({ provider: 'jia', providerName: '甲', kind: 'task', assetId: 'jia-t2', type: '图片', prompt: '甲失败', name: '甲失败', status: 'failed', src: px, ts: ts - 2000 });
        localStorage.setItem('assets_cache_v1', JSON.stringify({ ts: Date.now(), entries: out }));
        localStorage.setItem('page_mode_assets', 'page');
        localStorage.setItem('page_size_assets', '24');
      }, PIX);
      await openPage('#assets.html');
      await page.waitFor(() => document.querySelectorAll('.assets-page .grid .task').length >= 10, 30000, 150);
      await sleep(900);
      await clickAll(ASSETS);
    }

    /* ---------- 收藏：种 12 条 ---------- */
    if (want('favorites')) {
      await page.goto(proxy.base + '/shell.html');
      await page.waitFor(() => !!window.Store, 20000, 100);
      await page.eval(px => {
        const mk = (id, type, name) => ({ id: id, key: id, type: type, name: name, prompt: name + ' 的提示词', src: px, ts: Date.now() });
        window.Store.write('fav_items', [
          mk('vp-f1', '图片', '探针一'), mk('vp-f2', '视频', '探针二'), mk('vp-f3', '图片', '探针三'),
          mk('vp-f4', '视频', '探针四'), mk('vp-f5', '图片', '探针五'), mk('vp-f6', '视频', '探针六'),
          mk('vp-f7', '图片', '探针七'), mk('vp-f8', '视频', '探针八'), mk('vp-f9', '图片', '探针九'),
          mk('vp-f10', '视频', '探针十'), mk('vp-f11', '图片', '探针十一'), mk('vp-f12', '视频', '探针十二'),
        ], { label: '收藏' });
      }, PIX);
      /* 种完直接 hash 过去（外壳还挂着，路由现挂收藏页）：先挂上收藏页再种再整页重载，
         同一地址的 goto 会被当成原地导航，页面带着旧状态等不到卡。 */
      await page.goto(proxy.base + '/shell.html#favorites.html');
      await page.waitFor(() => document.querySelectorAll('.fav-page .fav-card').length >= 6, 30000, 150);
      await sleep(900);
      await clickAll(FAVS);
    }

    /* ---------- 素材库：种一条有三个候选的角色（详情里「身份锚点」那一排才画得出来） ---------- */
    if (want('chars')) {
      await page.goto(proxy.base + '/shell.html');
      await page.waitFor(() => !!window.Kv, 15000);
      await page.eval(px => {
        const f = i => ({ src: px, ts: Date.now() - i, ok: true });
        localStorage.setItem('char_lib', JSON.stringify({ data: [{
          id: 'c_vp', name: '视口探针', kind: 'char', face: px, anchor: px,
          faces: [f(1), f(2), f(3)],
          look: '一张用来量视口的探针图，' + '下面垫 enough 长的字让详情那一格真的能滚起来。'.repeat(8),
          bio: '生平也是长句，' + '好让那一格溢出自己的可视高度。'.repeat(8),
        }], ts: Date.now() }));
      }, PIX);
      await openPage('#chars.html');
      await page.waitFor(() => !!document.querySelector('.chars-page'), 30000, 100);
      /* 点卡 → 检查器开 → 检查器上「打开详情」→ 详情里点一颗换身份锚点的钮（详情整块 innerHTML 重来，
         里面那格滚动容器是新节点 —— 从 0 起就是「弹回顶」那个症状）。 */
      const step1 = await page.eval(() => {
        const card = document.querySelector('.chars-page .mcard');
        if (!card) return '素材库里没有卡';
        card.click();
        return true;
      });
      if (step1 !== true) skipped.push('素材库那一族：' + step1);
      else {
        await sleep(1200);
        const step2 = await page.eval(() => {
          const b = document.querySelector('[data-insp="open"]');
          if (!b) return '检查器没开（页面上没有 [data-insp="open"]）';
          b.click();
          return true;
        });
        if (step2 !== true) skipped.push('素材库那一族：' + step2);
        else {
          await page.waitFor(() => !!document.querySelector('.md-layer [data-d-act="setanchor"]'), 20000, 150).catch(() => {});
          await sleep(600);
          await clickAll(CHARS);
        }
      }
    }

    /* 真点下限：全量 24 击里至少 12 击要真点到位；VP_ONLY 点名某一组时按那一组的站点数算。 */
    const planned = [].concat(SETTINGS, STUDIO, DIRECTOR, ASSETS, FAVS, CHARS, SIDEBAR)
      .filter(o => want(o.g)).length;
    must(ran >= Math.min(12, planned), '这一条只真点了 ' + ran + ' / ' + planned
      + ' 击（大量站点被跳过，判据退化成摆设）。跳过清单：\n  '
      + (skipped.join('\n  ') || '（无）'));
    if (page.errors && page.errors.length) {
      console.error('页面异常：\n' + page.errors.slice(0, 8).join('\n'));
      throw new Error('页面上有异常');
    }
    console.log('✓ 点击视口：真点 ' + ran + ' 击（还位 / 展开钉住那一行 / 收缩还找得回 / 故意的滚动没被抹掉）\n  '
      + done.join('\n  ')
      + (skipped.length ? '\n  跳过 ' + skipped.length + ' 处：\n  ' + skipped.join('\n  ') : ''));
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    if (skipped.length) console.error('跳过清单：\n  ' + skipped.join('\n  '));
    if (done.length) console.error('已点：\n  ' + done.join('\n  '));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
