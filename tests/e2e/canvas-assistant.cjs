#!/usr/bin/env node
/* 画布助手：模型回包里给 RUN: canvas_* → 卡片（校验在这一刻全跑完）→ 用户点「执行」
   → 唯一写出口 WBBridge.canvas.apply(ops, {expectedRevision, operationId})。
   验的是助手这一层：只读工具不动文档、编出来的资产号当场拒、一批只算一条历史、过期修订号盖不掉用户、
   提案画卡片不建任务也不扣费、只读画布根本不交写工具、撤销只退助手自己那一条（压着人工改动时照实拒）。
   TextAI.chatStream 换成固定回包：不花钱、不碰真实模型，全程还要求一次生成请求都不发。 */
'use strict';
const h = require('./harness.cjs');

/* 1×1 PNG：只为在探针资产库里留下一条「查得到号」的本机产物 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let n = 0;
function must(cond, msg) { if (!cond) throw new Error('第 ' + (++n) + ' 项不成立：' + msg); ++n; }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const la = await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '探针图.png', data: PNG, format: 'png', mime: 'image/png', media_type: 'image', meta: {} }),
    })).json();
    const laId = la && la.id;
    if (!laId) throw new Error('探针资产没建出来：' + JSON.stringify(la));

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#canvas.html');
    await page.waitFor('window.WBBridge && window.WBBridge.get("canvas")', 25000);

    const click = sel => page.eval(s => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
    const has = sel => '!!document.querySelector(' + JSON.stringify(sel) + ')';
    const until = async (expr, ms, note) => {
      try { return await page.waitFor(expr, ms || 15000, 80); }
      catch (e) { throw new Error('第 ' + (++n) + ' 项等不到：' + (note || expr) + '（' + e.message + '）'); }
    };
    /* 画布的账只读桥那一份：节点数 / 连线数 / 修订号 / 历史行的 operationId 都在那里。 */
    const ctx = () => page.eval(() => {
      const c = window.WBBridge.get('canvas').context({ limit: 200 });
      return { revision: c.revision, 节点数: c.节点数, 连线数: c.连线数, 可撤销: c.历史.可撤销,
        缩放: Math.round(c.视口.scale * 100),
        节点: c.节点.map(x => ({ id: x.id, type: x.type, 标题: x.标题, 有产物: x.有产物 })),
        历史: c.历史.最近.map(x => ({ label: x.label, source: x.source, applied: x.applied, operationId: x.operationId, 节点数: x.节点数 })) };
    });
    const lastCard = () => page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      return a.length ? a[a.length - 1].innerText.slice(0, 1200) : ''; });
    /* 校验没过时画不出卡片，只在时间线上留一行 step —— 拒得越早越省：连「执行」都不会被点。 */
    const steps = () => page.eval(() => [...document.querySelectorAll('.ac-step')].map(x => x.innerText).join('\n').slice(-1500));
    const runState = () => page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      const s = a.length ? a[a.length - 1].querySelector('.ac-run-st') : null;
      return s ? s.className.replace('ac-run-st', '').trim() + '|' + s.innerText.slice(0, 400) : ''; });

    /* ---------- 建一份画布（文档只在 IndexedDB 里，得由页面自己造）---------- */
    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      window.TextAI.chatStream = async () => window.__nextRun || '没有 RUN 行';
      /* 出站计数：提案这一族一次都不该碰生成接口。 */
      window.__out = 0;
      const wrap = (obj, k) => { if (obj && typeof obj[k] === 'function') { const f = obj[k]; obj[k] = function () { window.__out++; return f.apply(this, arguments); }; } };
      wrap(window.Api, 'create'); wrap(window.Api, 'createBody'); wrap(window.AiGen, 'create');
    });
    must(await click('.cv-lib-bar button.pri'), '新建画布按钮点得到');
    await until(has('#pfDlg'), 15000, '新建画布的表单');
    await page.eval(() => { document.getElementById('pf_0').value = '助手画布'; document.getElementById('pfOk').click(); });
    await until('window.WBBridge.get("canvas").ready()', 20000, '画布打开');
    /* 助手是空闲时才补进来的（boot-assistant），先等到它再打开抽屉，否则这一句拿到的是 undefined。 */
    await until('!!window.AiChat && !!window.AiChat.open', 25000, '助手装载');
    await page.eval(() => { AiChat.open(); });
    await h.sleep(500);

    /* 一次助手回合：固定回包 → 卡片 → 点「执行」→ 读桥的只读快照做断言。
       pause 时把「点执行」这一步交回调用方：卡片阶段有没有偷偷改文档，必须在点之前先读一次账。 */
    /* ask() 回的就是这一整轮的 Promise：send 的 finally 里连「这一轮」收据与回合卡都画完才落地。
       等它，而不是轮询 .ac-run 与 .ac-step 谁先冒头 —— 拒与卡片同在一轮里，采样早晚各差一次就是一次假红。 */
    const turnDone = (p, note) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('这一句助手回合 60 秒没跑完：' + note)), 60000);
      p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });
    async function clickRun() {
      const clicked = await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
        const b = [...a[a.length - 1].querySelectorAll('button')].find(x => x.textContent === '执行');
        if (!b) return false; b.click(); return true; });
      if (!clicked) throw new Error('卡片上没有「执行」按钮：' + await lastCard());
      await page.waitFor(() => { const a = [...document.querySelectorAll('.ac-run')];
        return ![...a[a.length - 1].querySelectorAll('button')].some(x => x.textContent === '执行'); }, 30000, 120);
      await h.sleep(350);
      return { text: await lastCard(), state: await runState(), ctx: await ctx() };
    }
    async function turn(run, opts = {}) {
      const name = String(run).replace(/^RUN:\s*/, '').split(/[ \{]/)[0];
      await page.eval(r => { window.__nextRun = r; }, run);
      await turnDone(page.eval(() => AiChat.ask('按这一句来一次')), run.slice(0, 72));
      /* 认「这一张」而不是「多了一张」：会话记录只留最近 60 条（chat.js 的 CAP），
         跑到后半程旧卡片会被挤出 DOM 与记录，数总量会把「卡片明明画出来了」判成没画。
         卡片标题就是动作名，所以按动作名比对最后一张的标题、且它必须还没点执行。 */
      const got = await page.eval(k => {
        const a = [...document.querySelectorAll('.ac-run')];
        const last = a[a.length - 1];
        if (!last) return false;
        const d = window.AiChat.ACTS[k] || {};
        const t = String(d.title || d.名 || '');
        const hd = last.querySelector('.ac-run-hd');
        return !!t && !!hd && hd.textContent.indexOf(t) === 0
          && [...last.querySelectorAll('button')].some(b => b.textContent === '执行');
      }, name);
      if (!got) return { refused: true, text: await steps(), card: '', state: '', ctx: await ctx() };
      const card = await lastCard();
      if (opts.pause) return { card, text: card, state: '', ctx: await ctx(), exec: clickRun };
      if (opts.before) await opts.before();
      const out = await clickRun();
      return { card, ...out };
    }

    /* ---------- 1) 助手面：八个写动作 + 五项只读，都挂在助手这一层 ---------- */
    const face = await page.eval(() => {
      const acts = ['canvas_nodes_create', 'canvas_nodes_update', 'canvas_nodes_delete', 'canvas_edges_create',
        'canvas_edges_delete', 'canvas_viewport_set', 'canvas_generation_propose', 'canvas_undo'];
      const tools = ['canvas_get', 'canvas_search', 'canvas_node_read', 'canvas_assets_list', 'canvas_generation_status'];
      return { acts: acts.filter(k => !AiChat.ACTS[k]), tools: tools.filter(k => !AiChat.TOOLS[k]) };
    });
    must(!face.acts.length && !face.tools.length, '助手面缺项：' + JSON.stringify(face));

    /* ---------- 2) 五项只读跑一遍，文档一个字都不动 ---------- */
    const before = await ctx();
    must(before.节点数 === 1, '新建的画布只有一枚文本节点：' + JSON.stringify(before));
    const ids = before.节点.map(x => x.id);
    const read1 = await page.eval(() => AiChat.TOOLS.canvas_get.run({ limit: 50 }));
    must(read1 && !read1.错误 && read1.节点数 === 1 && Array.isArray(read1.能建类型) && read1.能建类型.length === 6,
      'canvas_get 要把账与「能建哪六类」一起回：' + JSON.stringify(read1).slice(0, 200));
    const read2 = await page.eval(() => AiChat.TOOLS.canvas_search.run({ q: '文本' }));
    must(Array.isArray(read2) && read2.length >= 1 && !!read2[0].id, 'canvas_search 要回真 id：' + JSON.stringify(read2).slice(0, 200));
    const read3 = await page.eval(id => AiChat.TOOLS.canvas_node_read.run({ id }), ids[0]);
    must(read3 && !read3.错误 && read3.id === ids[0] && Array.isArray(read3.连线), 'canvas_node_read 要回正文与连线：' + JSON.stringify(read3).slice(0, 200));
    const read4 = await page.eval(id => AiChat.TOOLS.canvas_assets_list.run({ limit: 50 }), laId);
    must(read4 && (read4.清单 || []).some(x => x.号 === laId), 'canvas_assets_list 里没有探针那条本机资产：' + JSON.stringify(read4).slice(0, 260));
    const read5 = await page.eval(() => AiChat.TOOLS.canvas_generation_status.run({}));
    must(read5 && !read5.错误 && Array.isArray(read5.节点), 'canvas_generation_status 该回一张状态表：' + JSON.stringify(read5).slice(0, 200));
    const after2 = await ctx();
    must(JSON.stringify(after2) === JSON.stringify(before), '五项只读改动了文档：' + JSON.stringify({ before, after2 }));

    /* ---------- 3) 一批两枚节点 = 历史里一条，卡片写清会动到谁 ---------- */
    const t3 = await turn('RUN: canvas_nodes_create {"nodes":[{"type":"text","title":"助手写的文本","content":"先讲清楚要什么"},'
      + '{"type":"image","title":"助手的图","prompt":"一只猫坐在窗台"}]}');
    must(!t3.refused, '加节点卡片没出来：' + t3.text);
    must(/会动到：2 枚节点/.test(t3.card), '卡片没写明这一批会动到两枚节点：' + t3.card);
    must(t3.ctx.节点数 === 3 && t3.ctx.revision === before.revision + 1,
      '两枚节点该是一次写入（修订 +1）：' + JSON.stringify({ 前: before.revision, 后: t3.ctx.revision, 数: t3.ctx.节点数 }));
    must(t3.ctx.历史.filter(x => x.applied).slice(-1)[0].节点数 === 2,
      '这一批在历史里只占一条、且记下动了两枚节点：' + JSON.stringify(t3.ctx.历史.slice(-3)));
    const txt = t3.ctx.节点.find(x => x.标题 === '助手写的文本');
    const imgA = t3.ctx.节点.find(x => x.标题 === '助手的图');
    must(!!txt && !!imgA, '两枚新节点读不回来：' + JSON.stringify(t3.ctx.节点));

    /* ---------- 4) 类型不在注册表：卡片阶段就拒，文档不动 ---------- */
    const t4 = await turn('RUN: canvas_nodes_create {"nodes":[{"type":"sprite","title":"不存在的类型"}]}');
    must(t4.refused && /没过校验/.test(t4.text) && /节点类型/.test(t4.text), '野类型没在卡片前被拒：' + JSON.stringify(t4.text).slice(0, 300));
    must((await ctx()).节点数 === 3, '被拒的写入不该长出节点');

    /* ---------- 5) 资产号是模型编的：整批拒，并说清去哪找号 ---------- */
    const t5 = await turn('RUN: canvas_nodes_create {"nodes":[{"type":"image","asset":"la_不存在的号"}]}');
    must(t5.refused && /资产库里查不到这个号/.test(t5.text), '编出来的资产号没被拒：' + JSON.stringify(t5.text).slice(0, 300));
    must(/canvas_assets_list/.test(t5.text), '拒的时候没告诉模型去哪找真号：' + JSON.stringify(t5.text).slice(0, 300));
    must((await ctx()).节点数 === 3, '假资产号那一次不该写进文档');

    /* ---------- 6) 真资产号：怎么变成节点只有页面那一份 assetOpOf ---------- */
    const t6 = await turn('RUN: canvas_nodes_create {"nodes":[{"asset":"' + laId + '","title":"探针图进画布"}]}');
    must(!t6.refused, '真资产号那次卡片没出来：' + t6.text);
    const imgB = t6.ctx.节点.find(x => x.标题 === '探针图进画布');
    must(!!imgB && imgB.type === 'image' && imgB.有产物 === true,
      '资产节点该按资产类型建好并标成已有产物：' + JSON.stringify(imgB));

    /* ---------- 7) 连线：合法的两条一次连上 ---------- */
    const t7 = await turn('RUN: canvas_edges_create {"edges":[{"from":"' + ids[0] + '","to":"' + imgA.id + '"},'
      + '{"from":"' + imgA.id + '","to":"' + imgB.id + '"}]}');
    must(!t7.refused, '连线卡片没出来：' + t7.text);
    must(/会动到：2 条连线/.test(t7.card), '卡片没写明连了两条线：' + t7.card);
    must(t7.ctx.连线数 === 2, '两条线没连上：' + JSON.stringify(t7.ctx.连线数));

    /* ---------- 8) 一批里有一条成环：整批拒，不留半截 ---------- */
    const t8 = await turn('RUN: canvas_edges_create {"edges":[{"from":"' + ids[0] + '","to":"' + imgB.id + '"},'
      + '{"from":"' + imgB.id + '","to":"' + imgA.id + '"}]}');
    must(t8.refused && /环/.test(t8.text), '成环那一批没被拒：' + JSON.stringify(t8.text).slice(0, 300));
    must((await ctx()).连线数 === 2, '整批里合法的那一条也被写进去了（半截画布）');

    /* ---------- 9) 视图：只让用户看到这一片，不涨修订、不进历史 ---------- */
    const before9 = await ctx();
    const t9 = await turn('RUN: canvas_viewport_set {"mode":"fit"}');
    must(!t9.refused, '视图卡片没出来：' + t9.text);
    must(/只动视图/.test(t9.card), '卡片没写明这一条只动视图：' + t9.card);
    must(/err/.test(t9.state) === false && /没改任何内容/.test(t9.text), '视图那次执行失败：' + t9.text.slice(0, 300));
    const after9 = await ctx();
    must(after9.revision === before9.revision && after9.节点数 === before9.节点数 && after9.历史.length === before9.历史.length,
      '视图改动涨修订或进了撤销栈：' + JSON.stringify({ 前: before9.revision, 后: after9.revision }));
    must(after9.缩放 > 20 && after9.缩放 < 300, 'fit 之后缩放是个正常值：' + after9.缩放);

    /* ---------- 10) 提案：卡片上把「用什么生成」摆清楚，画卡片与执行都不建任务 ---------- */
    const before10 = await ctx();
    const t10 = await turn('RUN: canvas_generation_propose {"execute":false,"nodes":[{"type":"image","title":"提案图",'
      + '"prompt":"一只狗在雪地里"}]}', { pause: true });
    must(!t10.refused, '提案卡片没出来：' + t10.text);
    must(/这一步会先把它写进画布/.test(t10.card), '提案卡片没写明会先写一枚节点：' + t10.card);
    must(/不建任务、不扣费/.test(t10.card), '提案卡片没写明不建任务不扣费：' + t10.card);
    must(t10.ctx.节点数 === before10.节点数, '提案在点执行之前就改了画布：' + JSON.stringify(t10.ctx.节点数));
    must((await page.eval(() => window.__out)) === 0, '光画一张提案卡片就发了生成请求：' + (await page.eval(() => window.__out)));
    const r10 = await t10.exec();
    must(!/err/.test(r10.state) && r10.ctx.节点数 === before10.节点数 + 1,
      'execute:false 那一次该只落节点：' + JSON.stringify({ state: r10.state, 数: r10.ctx.节点数 }));
    must((await page.eval(() => window.__out)) === 0, 'execute:false 执行时建了任务：' + (await page.eval(() => window.__out)));
    const propNode = r10.ctx.节点.find(x => x.标题 === '提案图');
    /* 只给 nodeId 的那种提案（这一枚打算怎么生成、还缺什么）是最常用的一条：不能拿「至少一条操作」拒掉。 */
    const t10b = await turn('RUN: canvas_generation_propose {"nodeId":"' + propNode.id + '","execute":false}', { pause: true });
    must(!t10b.refused && /节点：/.test(t10b.card), '只给 nodeId 的提案被当场拒了：' + JSON.stringify(t10b.text).slice(0, 300));
    must(/提示词：/.test(t10b.card), '提案没把「打算怎么跑」说清楚：' + t10b.card);
    must(t10b.ctx.revision === r10.ctx.revision && t10b.ctx.节点数 === r10.ctx.节点数,
      '只读一份提案就改掉了文档：' + JSON.stringify({ 前: r10.ctx.revision, 后: t10b.ctx.revision }));

    /* ---------- 11) 撤销：退助手自己刚写的那一条（不填 operationId = 最近一次） ---------- */
    const t11 = await turn('RUN: canvas_undo {}');
    must(!t11.refused, '撤销卡片没出来：' + t11.text);
    must(/已经退掉助手写的/.test(t11.text), '撤销回执不对：' + t11.text.slice(0, 300));
    must((await ctx()).节点数 === r10.ctx.节点数 - 1, '撤销没把提案那枚节点退掉');

    /* ---------- 12) 压着用户自己的编辑时照实拒，用户撤掉那一步之后才退 ---------- */
    const t12 = await turn('RUN: canvas_nodes_create {"nodes":[{"type":"config","title":"助手的配置"}]}');
    must(!t12.refused, '配置节点那次卡片没出来：' + t12.text);
    const opC = t12.ctx.历史.filter(x => x.applied && x.source === 'external').slice(-1)[0];
    must(opC && opC.operationId, '助手写入的历史行没带 operationId：' + JSON.stringify(t12.ctx.历史.slice(-2)));
    must(await click('.cv-dock .tool[title="添加节点（N）"]'), '用户自己也要加一枚');
    await until(has('#uiDlg'), 12000, '类型菜单');
    await page.eval(() => { const b = document.querySelector('#uiDlg .cv-menu button[data-v="text"]');
      if (!b) throw new Error('类型菜单里没有 text'); b.click(); });
    await until('window.WBBridge.get("canvas").context().节点数 === ' + (t12.ctx.节点数 + 1));
    const t12b = await turn('RUN: canvas_undo {"operationId":"' + opC.operationId + '"}');
    must(!t12b.refused, '撤销卡片（按 operationId）没出来：' + t12b.text);
    must(/后面那 1 步|Ctrl\+Z/.test(t12b.text), '压着人工改动时没说清要先撤掉那一步：' + t12b.text.slice(0, 400));
    must(/err/.test(t12b.state), '这一步本该执行失败：' + t12b.state);
    must((await ctx()).节点数 === t12.ctx.节点数 + 1, '被拒的撤销把用户那枚也带走了');
    must(await click('.cv-dock .tool[title*="撤销"]'), '用户按自己的撤销');
    await until('window.WBBridge.get("canvas").context().节点数 === ' + t12.ctx.节点数);
    const t12c = await turn('RUN: canvas_undo {"operationId":"' + opC.operationId + '"}');
    must(!t12c.refused && /err/.test(t12c.state) === false && /已经退掉助手写的/.test(t12c.text),
      '用户撤掉之后仍退不掉助手那一条：' + t12c.text.slice(0, 300));
    must((await ctx()).节点数 === t12.ctx.节点数 - 1, '助手那条配置节点没被退掉');

    /* ---------- 13) 卡片停在屏幕上时用户自己改了画布：过期修订号当场拒，绝不盖掉 ---------- */
    const t13 = await turn('RUN: canvas_nodes_update {"patches":[{"id":"' + txt.id + '","title":"不该落地的改名"}]}', { pause: true });
    must(!t13.refused && /改画布上的节点/.test(t13.card), '改名卡片没出来：' + t13.text);
    must(await page.eval(id => { const A = window.WBBridge.get('canvas');
      return !!A.apply([{ op: 'update_node', id, patch: { title: '用户自己起的名字' } }],
        { expectedRevision: A.context().revision }).ok; }, txt.id), '卡片停留期间用户那次写入没成');
    const revStale = (await ctx()).revision;
    const t13b = await t13.exec();
    must(/被改过|重新读/.test(t13b.text), '过期修订号既没拒也没说清：' + t13b.text.slice(0, 400));
    must(/err/.test(t13b.state), '这一条该是失败态：' + t13b.state);
    must(t13b.ctx.revision === revStale && t13b.ctx.节点.find(x => x.id === txt.id).标题 === '用户自己起的名字',
      '被拒的改名盖掉了用户的编辑：' + JSON.stringify(t13b.ctx.节点.find(x => x.id === txt.id)));

    /* ---------- 14) 只读的那一份画布：写工具根本不交出去 ---------- */
    await page.eval(() => { window.__ro = true; const A = window.WBBridge.get('canvas'); A.readOnly = () => window.__ro; });
    const t14 = await turn('RUN: canvas_nodes_create {"nodes":[{"type":"text","title":"只读时不该出现"}]}');
    must(t14.refused && /只读/.test(t14.text), '只读画布还能接写动作：' + JSON.stringify(t14.text).slice(0, 300));
    must((await ctx()).节点数 === t13b.ctx.节点数, '只读那次写进了文档');
    const snap = await page.eval(() => (window.__acPageCtx() || {}).只读);
    must(snap === true, '当前界面快照没把「只读」带给助手：' + JSON.stringify(snap));
    /* 只读只关写工具：读的那五项照样能用（否则助手连「这一份是什么」都答不上）。 */
    const readRO = await page.eval(() => AiChat.TOOLS.canvas_get.run({ limit: 20 }));
    must(readRO && !readRO.错误 && readRO.节点数 >= 1, '只读时连只读工具都被关掉：' + JSON.stringify(readRO).slice(0, 200));
    await page.eval(() => { const A = window.WBBridge.get('canvas'); A.readOnly = () => false; });

    /* ---------- 15) 删掉几枚：连带断线要报数 ---------- */
    const t15 = await turn('RUN: canvas_nodes_delete {"ids":["' + imgA.id + '"]}');
    must(!t15.refused, '删节点卡片没出来：' + t15.text);
    must(/连带删掉 2 条/.test(t15.text), '删一枚节点没报出连带断开的线：' + t15.text.slice(0, 400));
    must((await ctx()).连线数 === 0, '那两条挂在被删节点上的线没一起走');

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 画布助手通过（8 个动作 / 5 项只读挂齐 · 只读不动文档 · 一批一次历史 · 野类型与假资产号卡片前就拒 · 真资产号走页面 assetOpOf · '
      + '成环整批拒 · 视图不涨修订 · 提案不建任务不扣费（含只给 nodeId 那一种） · 撤销与「压着人工改动就拒」 · 过期修订号盖不掉用户 · 只读不交写工具 · 删节点连带断线报数 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
