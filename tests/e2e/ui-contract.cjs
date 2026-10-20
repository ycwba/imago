#!/usr/bin/env node
/* 公共件契约测试（报告 §7.3④）—— 跑法：node tests/e2e/ui-contract.cjs
   这三则都是「光看代码看不出来、只有连着跑两次才露馅」的契约：

   ① 灯箱 / 详情全站只有一副 DOM、一份配置。五个页面各写一份的旧账收敛到 `Wb.lightbox` 之后，
      剩下两个失效方式：
        · 换配置没换对 —— 先开资产库再回收藏，翻页翻的还是上一家那份 list；
        · 监听装了两份 —— KeepAlive 的页面每次切回来都再 init 一次，一次右箭头翻两页。
      所以两条都要判：`use(A)` → `use(B)` 之后 cfg 必须是 B；反复 init 之后
      **按一次键只翻一格**（列表给 5 条：绑了几份就前进几格，1 份才等于 1）。

   ② 图片取不到字节时不许撞 CSP（P0-12 那一类）。旧写法是页面往 `<img>` 上塞内联
      `onerror="…"`，严格 CSP 把它整条拦掉 —— 兜底一次都没生效，画面上只有碎图标，
      而控制台里那句「violates Content Security Policy」没人看。
      现在兜底在 `AssetLocal.watch` 那一个全局捕获监听里。判据：喂一个必定 404 的图源，
      监听 `securitypolicyviolation` 要 0 次，同时裂图必须被「已丢失」角标替掉
      —— 只判「没违规」会漏掉另一半：监听没跑、图还是裂的，也算坏。

   ③ 「生成完成」这条事件（`wb:asset-done`）曾经有四个生产者各写一份 payload（见报告 §6.2
      「事件契约靠字符串」）。收成 `AssetLocal.announce()` 之后，纯 Node 那半边只能判「委托给了谁」，
      归一化本身对不对只有真 AssetLocal 在场才验得到，所以这一节判六件事：
        · 三种生产者形状（工作台全字段 / 导演台带价目 / 画布只给地址）折完之后 own key 集合一模一样，
          别名（`taskId` / `raw`）折进正名之后要从条目里删掉 —— 一份事实只留一个出处；
        · 派生那六个（src / assetId / genId / id / rawSrc / dl）按一条规则算，且不给缺的字段凭空造值；
        · 该不投的三种（没有地址 / `la_` 本机导入 / 空批次）一条都不许投出去；
        · 同一批里同一条产物只投一遍（换签名地址算同一条），换一家平台算另一条；
        · 消费方那道闸（wantSave）与生产者输出说的是同一种字段 —— 把归一化后的条目直接喂给它；
        · `wb:asset-done` 只装一份消费者，反复 `watch()` 不再装第二份（装两份 = 同一份产物下两遍）。
     探针条目全部用磁盘上不存在的产物号：所以这一节既要把「真消费方跑到底也不下单」判住，
     又不能真去网络取字节 —— 开关与判据各管一半，见下面两处注释。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* 页面脚本之前装：把 addEventListener 记一笔。只记跟灯箱有关的那几条 + `wb:` 那几条契约事件，
   别把整页监听抄回来。 */
const LISTENER_PROBE = () => {
  const rec = [];
  window.__probeListeners = rec;
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn) {
    try {
      if ((typeof fn === 'function' && /W\.lightbox|window\.Wb\.lightbox/.test(String(fn)))
        || /^wb:/.test(String(type))) {
        rec.push({ type: String(type), where: this === document ? 'document' : this === window ? 'window' : 'other' });
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
};

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.addInitScript(LISTENER_PROBE);
    await page.goto(proxy.base + '/shell.html#assets.html');
    await page.waitFor(() => window.Wb && window.Wb.lightbox && window.Wb.detail
      && document.getElementById('lightbox') && document.getElementById('lbStage'), 30000);

    /* ---------- ① 灯箱 / 详情单例 ---------- */
    /* 两道闸各挂在不同的对象上：按键在 document，换页归还在 window。只数一边的话
       另一边绑了两份也报绿 —— 所以两份都要数，且都按 where 分开数。 */
    const count = () => page.eval(() => (window.__probeListeners || []).map(x => x.where + ':' + x.type));
    const kd0 = await count();
    must(kd0.filter(t => t === 'document:keydown').length === 1,
      '挂载后 document 上的灯箱 keydown 应当正好一份，实际 ' + JSON.stringify(kd0));
    must(kd0.filter(t => t === 'window:spa:page').length === 1,
      '挂载后 window 上的灯箱 spa:page 应当正好一份，实际 ' + JSON.stringify(kd0));

    /* 模拟「切回来再挂一次」：KeepAlive 的页面每次 onMounted 都可能再走一遍 init。
       这是灯箱自己那道幂等闸（`_inited`）要拦的东西，直接从公共件上按。 */
    const storm = await page.eval(() => {
      const W = window.Wb;
      for (let i = 0; i < 4; i++) W.lightbox.init({ list: () => [], keyOf: it => String(it && it.k || '') });
      return true;
    });
    must(storm, '反复 init 没跑完');
    const kd1 = await count();
    must(kd1.filter(t => t === 'document:keydown').length === 1,
      'init 再跑四遍之后 keydown 还是只有一份才对，实际 ' + JSON.stringify(kd1));
    must(kd1.filter(t => t === 'window:spa:page').length === 1,
      'init 再跑四遍之后 spa:page 换页归还还是只有一份，实际 ' + JSON.stringify(kd1));

    /* 换配置：登记 A、登记 B，前台切到 B → 灯箱与详情都必须是 B 那份；切回 A 又是 A。 */
    const swap = await page.eval(() => {
      const W = window.Wb;
      const mk = (tag, detailTag) => ({
        lb: { __tag: tag, list: () => [], keyOf: it => String(it && it.k || ''), srcOf: it => String(it && it.src || ''), kindOf: () => 'image' },
        detail: { __tag: detailTag, render: () => {} },
      });
      const A = mk('A', 'dA'), B = mk('B', 'dB');
      W.lightbox.use('probe-a.html', A);
      W.lightbox.use('probe-b.html', B);
      W.lightbox._applyFront('probe-b.html');
      const atB = { lb: W.lightbox.cfg && W.lightbox.cfg.__tag, detail: W.detail.cfg && W.detail.cfg.__tag };
      W.lightbox._applyFront('probe-a.html');
      const atA = { lb: W.lightbox.cfg && W.lightbox.cfg.__tag, detail: W.detail.cfg && W.detail.cfg.__tag };
      /* 没登记过的页不抢别人家的（这就是「收藏忘了归还」那一类） */
      W.lightbox._applyFront('probe-unknown.html');
      const keep = W.lightbox.cfg && W.lightbox.cfg.__tag;
      return { atB, atA, keep };
    });
    must(swap.atB.lb === 'B', 'use(A) → use(B) → 切到 B，灯箱 cfg 应当是 B，实际 ' + swap.atB.lb);
    must(swap.atB.detail === 'dB', '详情这一半也要跟着换成 B，实际 ' + swap.atB.detail);
    must(swap.atA.lb === 'A' && swap.atA.detail === 'dA', '切回 A 应当归还 A 那份：' + JSON.stringify(swap.atA));
    must(swap.keep === 'A', '没登记过的那页不该抢配置，实际 ' + swap.keep);

    /* 一次按键只翻一格：给 5 条的列表，绑了几份监听就前进几格 */
    const step = await page.eval(async () => {
      const W = window.Wb;
      const items = [];
      for (let i = 0; i < 5; i++) items.push({ k: 'p' + i, src: '', title: 'P' + (i + 1) });
      const cfg = { __tag: 'step', list: () => items, keyOf: it => it.k, srcOf: it => '', kindOf: () => 'task', info: () => [] };
      W.lightbox.use('probe-step.html', { lb: cfg, detail: { render: () => {} } });
      W.lightbox._applyFront('probe-step.html');
      W.lightbox.open(items[0], items);
      await new Promise(r => setTimeout(r, 120));
      const before = { idx: W.lightbox.idx, count: (document.getElementById('lbCount') || {}).textContent };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const after = { idx: W.lightbox.idx, count: (document.getElementById('lbCount') || {}).textContent, open: W.lightbox.isOpen() };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const closed = !W.lightbox.isOpen();
      return { before, after, closed };
    });
    must(step.before.idx === 0, '灯箱应当开在第一格，实际 ' + step.before.idx);
    must(step.after.idx === 1, '一次右箭头应当只翻一格，实际从 ' + step.before.idx + ' 走到 ' + step.after.idx
      + '（计数条 ' + step.after.count + '）—— 监听绑了几份就翻几格');
    must(/2\s*\/\s*5/.test(String(step.after.count || '')), '页码条应当显示 2 / 5，实际 ' + step.after.count);
    must(step.after.open, '翻页后灯箱还开着');
    must(step.closed, 'Escape 关不掉灯箱');

    /* ---------- ② 404 图源不撞 CSP，且真被占位替掉 ---------- */
    const csp = await page.eval(async () => {
      const viol = [];
      const onV = e => { try { viol.push({ d: String(e.violatedDirective || ''), b: String(e.blockedURI || ''), o: String(e.originalURI || '') }); } catch (x) {} };
      window.addEventListener('securitypolicyviolation', onV, true);
      document.addEventListener('securitypolicyviolation', onV, true);
      /* 阳性对照：先故意插一段内联脚本，要求监听**必须**收到一次违规。
         收不到就说明这道监听是死的（浏览器不报 / 名字写错 / 页面根本没在严格 CSP 下），
         那下面那句「0 次违规」就是白捡的绿。 */
      const probe = document.createElement('script');
      probe.textContent = 'window.__cspProbe = 1';
      document.head.appendChild(probe);
      probe.remove();
      await new Promise(r => setTimeout(r, 200));
      const control = viol.length;
      viol.length = 0;

      const host = document.createElement('div');
      host.id = 'cspProbe';
      document.body.appendChild(host);
      const bad = '/probe-missing-image-' + Date.now() + '.png';
      const html = window.Wb.thumbs.mediaHTML(bad, { type: 'image' });
      host.innerHTML = html;
      const img = host.querySelector('img');
      /* 内联处理器就算这一版没写，也可能被谁顺手加回模板串里 —— 直接看生成的标记 */
      const inline = /<(img|video|audio)\b[^>]*\son[a-z]+\s*=/i.test(html);
      if (img) window.Wb.thumbs.bind(host, img, bad);
      /* 404 的 error 事件 + 索引回退那一条链走完要一点时间；等到角标出现或 4 秒到 */
      const until = Date.now() + 4000;
      while (Date.now() < until && !(host.querySelector('.lost-tip') || (img && img.dataset.lost === '1'))) {
        await new Promise(r => setTimeout(r, 80));
      }
      const tip = host.querySelector('.lost-tip');
      const r = { html: html.slice(0, 240), inline, control, viol: viol.slice(), lost: !!tip,
        tipText: tip ? tip.textContent : '', dataLost: img ? String(img.dataset.lost || '') : '(无 img)',
        cspMeta: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '' };
      host.remove();
      return r;
    });
    /* 前置条件：这一页真的在严格 CSP 之下。没有那道闸，下面「0 次违规」是白捡的 ——
       内联处理器照样能跑，判据就变成永远绿。 */
    must(/script-src[^;]*'self'/.test(csp.cspMeta || ''), "外壳没带上 script-src 'self' 的 CSP，"
      + '下面那两条「不违规 / 无内联处理器」失去意义（标记里读到：' + String(csp.cspMeta).slice(0, 80) + '）');
    must(csp.control > 0, '故意插的内联脚本一次 CSP 违规都没被监听到 —— 监听是死的，'
      + '那下面那句「0 次违规」不算证据（这一项本身才是判据的判据）');
    must(!csp.inline, '公共件生成的媒体标记里不许有内联事件处理器（严格 CSP 会整条拦掉）：' + csp.html);
    must(csp.viol.length === 0, '加载失败的图源触发了 ' + csp.viol.length + ' 次 CSP 违规：'
      + JSON.stringify(csp.viol.slice(0, 2)) + '；标记=' + csp.html);
    must(csp.lost || csp.dataLost === '1',
      '404 的缩略图要被「已丢失」兜底替掉，不能留一张裂图（data-lost=' + csp.dataLost + '，角标=' + csp.lost + '）');
    if (csp.lost) must(/已丢失/.test(csp.tipText), '角标文案要说清「已丢失」，实际：' + csp.tipText);
    const cspErr = (page.errors || []).filter(e => /Content Security Policy|unsafe-inline|Refused to execute/i.test(e))
      /* 阳性对照那句「Refused to execute inline script」是我们自己插出来的，不算违规证据；
         真正的回退会说 "inline event handler"，那句不会被这条滤掉。 */
      .filter(e => !/Refused to execute inline script/.test(e));
    must(cspErr.length === 0, '控制台里有 CSP 报错：' + JSON.stringify(cspErr.slice(0, 2)));

    /* ---------- ③ 「生成完成」这条事件：四处写法折成同一种形状 ---------- */
    /* 判的都是「只有真 AssetLocal 在场才验得到」的那几件事（tests/canvas-gen.mjs 里
       引用了这一处，纯 Node 那半边只判委托、不判归一化）：
         · 三家生产者的字段集合本来不一样（导演台带 priceMicros/currency/gstatus、工作台带
           duration/priceText、画布只给一条最小条目，地址一家写 `src`、一家写 `url`）——
           折完之后**own key 集合必须是同一份**，否则消费方还要逐字段可选容错，加字段就改四处；
         · 派生那六个（src / assetId / genId / id / rawSrc / dl）按一条规则算出来；
         · 该不投的三种（没有地址 / `la_` 本机导入 / 空批次）一条都不许投出去；
         · 同一批里同一条产物（换了签名地址也算同一条）只投一遍，换一家平台算另一条；
         · **不凭空造**：kind 缺了留空 → 消费方那道 wantSave 把它挡在门外（安全方向是「不下载」），
           时刻字段缺了留空 → 「一个时刻都没有」本身就是 wantSave 放行的判据；
         · 消费方只有 local.js 那一份，且反复 watch() 不再装第二份（装两份 = 同一份产物下两遍）。 */
    const ann = await page.eval(() => {
      const AL = window.AssetLocal;
      /* 这一节会投 kind:'asset' 的条目，先把「自动存回本机」整档关掉：探针造的产物号在磁盘上不存在，
         让真消费方排上下单就是拿一条假地址去撞出站护栏（还会把这一条判据变成依赖网络的一等公民）。
         代价是 scan 第一行 `if (!saveOn()) return;` 会先返回 —— 所以「消费方收不收这一条」不靠这条判据，
         靠下面直接问 wantSave（scan 每一批都问的就是它），监听装了几份靠 __probeListeners 数。 */
      const keys = { save: 'sk_media_local', since: 'sk_media_local_since' };
      const was = { save: localStorage.getItem(keys.save), since: localStorage.getItem(keys.since) };
      localStorage.setItem(keys.save, 'off');
      /* 给「只存开启之后新生成的」那一档一个明确的开启时刻：干净 profile 里 saveSince() 为空 =
         「当作一直是开的」，那条判据就会永远绿。 */
      localStorage.setItem(keys.since, String(Date.now()));
      const info0 = AL.info();
      const batches = [];
      const rec = window.__probeListeners || [];
      const nInst = () => rec.filter(x => x.type === 'wb:asset-done').length;
      const installed0 = nInst();          // 我这只探针还没装之前 = 真消费方那一份
      const on = e => batches.push(((e && e.detail && e.detail.entries) || []).slice());
      window.addEventListener('wb:asset-done', on);
      const run = list => { const before = batches.length; const ret = AL.announce(list); return { ret, sent: batches.length - before }; };

      /* 三种生产者形状各投一次（字段集合按各页历史上真发过的那份写）。
         任务号故意两种写法都摆出来：工作台当年写 `genId`，导演台与画布写 `taskId` —— 折完之后
         别名必须消失，条目里只留 `genId` 一个出处（下面那句 own key 集合相同就是判这一条）。 */
      const likeStudio = { kind: 'asset', provider: 'provA', assetId: 'a1', genId: 't1', type: 'image', format: 'png',
        status: 'done', src: 'https://up.example/x1.png?sig=1', rawSrc: 'https://up.example/x1.png?sig=1',
        prompt: 'p', model: 'm', tier: 'std', res: '1k', ar: '1:1', duration: 5, priceText: '￥0.2',
        created: '2026-10-19T00:00:00.000Z' };
      const likeDirector = { kind: 'asset', provider: 'provB', assetId: 'a2', taskId: 't2', url: '/asset/a2',
        priceMicros: 123456, currency: 'CNY', gstatus: 'succeeded' };
      const likeCanvas = { provider: 'provC', src: '/asset/a3', taskId: 't3' };
      const likeCanvasExtra = { provider: 'provD', src: '/asset/a4', taskId: 't4', extraField: '留着' };
      run([likeStudio]);
      const s0 = batches[batches.length - 1][0];
      run([likeDirector]);
      const d0 = batches[batches.length - 1][0];
      run([likeCanvas]);
      const c0 = batches[batches.length - 1][0];
      run([likeCanvasExtra]);
      const e0 = batches[batches.length - 1][0];
      const shapeOf = n => Object.keys(n || {}).sort().join('|');

      /* 派生那六个（src / assetId / genId / id / rawSrc / dl）：只给 `url` 也要认回产物号；
         `taskId` 要变成 genId；id 依次退到 genId、assetId；本地地址不伪造 rawSrc，外链不伪造 dl。 */
      const derived = {
        srcFromUrl: !!d0 && d0.src === '/asset/a2',
        idFromTaskId: !!c0 && c0.id === 't3',
        genFromTaskId: !!c0 && c0.genId === 't3',
        assetFromLocalAddr: !!c0 && c0.assetId === 'a3',
        rawFromHttp: !!s0 && s0.rawSrc === likeStudio.src,
        rawNotInvented: !!c0 && c0.rawSrc === '',
        dlForLocal: !!c0 && c0.dl === '/asset/a3' && !!d0 && d0.dl === '/asset/a2',
        dlNotForHttp: !!s0 && s0.dl === '',
        extraKept: !!e0 && e0.extraField === '留着' && Object.keys(e0).length === Object.keys(c0).length + 1,
        aliasDropped: [s0, d0, c0, e0].every(x => x && !('taskId' in x) && !('raw' in x)),
        fullKept: !!s0 && s0.duration === 5 && s0.priceText === '￥0.2' && s0.created === likeStudio.created,
        noUndef: [s0, d0, c0, e0].every(x => x && Object.keys(x).every(k => x[k] !== undefined)),
      };

      /* 不凭空造：likeCanvas 没给 kind / status / 时刻 —— 补了 kind 就等于替用户决定「这是产物，去下载」，
         补了时刻就等于把一条历史产物判成新产物（wantSave 的「一个时刻都没有」那一档会失效）。 */
      const invented = { kind: !!c0 && c0.kind !== '', status: !!c0 && c0.status !== '',
        created: !!c0 && c0.created !== '', completed: !!c0 && c0.completed !== '', ts: !!c0 && c0.ts !== '' };
      /* 缺数字的留 null：补 0 会被侧栏/详情当成「已知时长 / 已知花费」念出来 */
      const nulls = { duration: !!c0 && c0.duration === null, credits: !!c0 && c0.credits === null,
        priceMicros: !!c0 && c0.priceMicros === null && !!d0 && d0.priceMicros === 123456 };

      /* 该不投的三种 + 一次空批次 */
      const drops = [
        { name: '没有地址', case: [{ provider: 'provD', assetId: 'a9' }] },
        { name: '本机导入的号', case: [{ kind: 'asset', provider: 'provD', assetId: 'la_7', src: '/asset/la_7' }] },
        { name: '本机导入的地址', case: [{ kind: 'asset', provider: 'provD', src: '/asset/la_7?dl=1' }] },
        { name: '空批次', case: [] },
      ].map(x => Object.assign({ name: x.name }, run(x.case)));

      /* 同一批：同一家同一产物号（换了签名地址）只投一遍；同一产物号换一家算另一条 */
      const dedup = run([
        { provider: 'provE', assetId: 'x1', src: 'https://up.example/x1.png?sig=A' },
        { provider: 'provE', assetId: 'x1', src: 'https://up.example/x1.png?sig=B' },
        { provider: 'provF', assetId: 'x1', src: 'https://up.example/x1.png?sig=A' },
        { provider: 'provE', taskId: 'z9', src: 'https://up.example/z9.png' },
      ]);
      const ids = (batches[batches.length - 1] || []).map(n => n.provider + '/' + (n.assetId || n.genId));

      /* 消费方那道闸读的是同一份判据（scan 每一批都问 wantSave 一次） */
      const gate = { noKind: AL.wantSave({ kind: '', src: '/asset/q1' }),
        noTimestampPasses: AL.wantSave({ kind: 'asset', src: '/asset/q1' }, 'new'),
        alreadyLocal: AL.wantSave({ kind: 'asset', src: '/asset/q1', localAsset: 'la_1' }),
        oldOneBlocked: AL.wantSave({ kind: 'asset', src: '/asset/q1', completed: '1' }, 'new') };

      /* 最后把「自动存回本机」打开，再投一条**没有 kind** 的条目：这一次真消费方（scan）会跑到底，
         拦住它的只可能是 wantSave 那道判据。要是归一化替它补了 kind，这一条就会排进镜像队列、
         拿一个磁盘上不存在的 `/asset/probeG` 去下单 —— 下面那句「队列读数没动」就红了。 */
      localStorage.setItem(keys.save, 'on');
      const consumerPass = run([{ provider: 'provG', src: '/asset/probeG', type: 'image' }]);
      const info1 = AL.info();
      window.removeEventListener('wb:asset-done', on);
      /* 唯一消费方已经装着（local.js 顶层就 watch() 了）；再 watch() 两遍不许装第二份 */
      AL.watch(); AL.watch();
      const installed1 = nInst();          // 含我自己那一只（记录只加不减）
      if (was.save == null) localStorage.removeItem(keys.save); else localStorage.setItem(keys.save, was.save);
      if (was.since == null) localStorage.removeItem(keys.since); else localStorage.setItem(keys.since, was.since);
      return {
        shapes: [shapeOf(s0), shapeOf(d0), shapeOf(c0)], nBatches: batches.length,
        derived, invented, nulls, drops, dedup: dedup.ret, ids, gate, installed0, installed1, consumerPass,
        mirrorMoved: (info1.inFlight - info0.inFlight) + (info1.ok - info0.ok) + (info1.fail - info0.fail),
        oldPrivate: typeof window.AssetLib._announce,
      };
    });
    must(ann.oldPrivate === 'undefined', 'AssetLib 上那份私有的 _announce（第二个生产者）还没删干净：' + ann.oldPrivate);
    must(ann.shapes.every(s => s && s === ann.shapes[0]),
      '三家生产者投出去的条目形状必须折成同一份，实际各自的 own key：\n    ' + ann.shapes.join('\n    '));
    must(ann.nBatches === 6, '该投的每一次 announce 各投一条事件（四种生产者 + 去重那批 + 消费方那一次），实际 '
      + ann.nBatches + ' 条');
    for (const k of Object.keys(ann.derived)) must(ann.derived[k], '派生字段判据没成立：' + k);
    for (const k of Object.keys(ann.invented)) must(ann.invented[k] === false, '归一化凭空造了字段：' + k
      + ' —— 缺的必须留空：wantSave 靠 kind 为空把这一条挡在下载之外，时刻为空是「历史产物一律放行」那条判据');
    for (const k of Object.keys(ann.nulls)) must(ann.nulls[k], '数字字段缺省要留 null（补 0 会被当成已知数值）：' + k);
    for (const d of ann.drops) must(d.ret === 0 && d.sent === 0,
      '「' + d.name + '」不该投出去，实际返回 ' + d.ret + ' 且发了 ' + d.sent + ' 条事件');
    must(ann.dedup === 3, '同一批四条里同一家同一产物号（换了签名地址）只该留一条，实际投出 ' + ann.dedup + ' 条：'
      + JSON.stringify(ann.ids));
    must(ann.ids.length === 3 && new Set(ann.ids).size === 3, '去重后剩下的该是三条不同身份，实际 ' + JSON.stringify(ann.ids));
    must(ann.gate.noKind === false, '没有 kind 的条目 wantSave 要拦住（安全方向是不下载）—— 它放了行，说明归一化补了 kind');
    must(ann.gate.noTimestampPasses === true, 'kind=asset 且一个时刻都没有的条目 wantSave 要放行（「多存一份只花磁盘」那一档）');
    must(ann.gate.alreadyLocal === false, '本机已经有副本的还要再存一遍？wantSave 这一关没拦住');
    must(ann.gate.oldOneBlocked === false, '「只存开启之后新生成的」那一档要把 1970 年那条历史产物挡住（现在放了行，'
      + '就是 saveSince 那道边界没生效）');
    must(ann.consumerPass.ret === 1 && ann.consumerPass.sent === 1, '消费方那一次投出去了吗？返回 '
      + ann.consumerPass.ret + '、发了 ' + ann.consumerPass.sent + ' 条');
    must(ann.mirrorMoved === 0, '自动存本机开着、真消费方跑到底的那一次，没有 kind 的条目一条都不该进镜像队列'
      + '（队列读数动了 ' + ann.mirrorMoved + '）—— 那就是归一化替它补了 kind，页面开始拿不存在的产物号下单');
    must(ann.installed0 === 1, 'wb:asset-done 的消费者应当只装一份，页面挂载后数到 ' + ann.installed0 + ' 份');
    must(ann.installed1 - 1 === ann.installed0, '再调两遍 AssetLocal.watch() 之后多装了 '
      + (ann.installed1 - 1 - ann.installed0) + ' 份 —— 装两份就是同一份产物下两遍');

    /* 前端契约跑完这段时间里，代理自己不能崩过：公共件走的每条同源地址都在真实分发里过一遍。 */
    const faults = h.logFaults(proxy.log);
    must(faults.length === 0, '代理日志里有未处理的异常（' + faults.length + ' 行）：\n  ' + faults.join('\n  '));

    console.log('✓ 公共件契约：灯箱/详情单例 + 404 图源不违规 CSP + 生成完成事件单一形状（' + n + ' 项）');
    await browser.close(); browser = null;
    await proxy.stop(); proxy = null;
    process.exitCode = 0;
  } catch (e) {
    console.error('✗ ' + (e && e.message));
    if (page) { try { console.error('  控制台：' + JSON.stringify((page.errors || []).slice(0, 4))); } catch (x) {} }
    if (browser) await browser.close().catch(() => {});
    if (proxy) await proxy.stop().catch(() => {});
    process.exitCode = 1;
  }
})();
