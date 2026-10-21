#!/usr/bin/env node
/* 自由画布浏览器判据：真点界面 —— 建画布、注册表六类节点各建一枚再读回来、拖动、
   连线与拦环、框选、就地改名、复制、整批删除的两种下场、撤销重做、缩放、落盘与刷新恢复、
   项目库的检索/改名/删除。
   不碰任何生成平台：那颗「生成」按钮在这里只该被前置判据拦住，一次出站请求都不许发。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
function must(cond, msg) { if (!cond) throw new Error('第 ' + (++n) + ' 项不成立：' + msg); ++n; }

/* 指针事件在页内合成：元素的位置矩形是真的、坐标是真的，走的仍是同一套 hit() 判据。
   fromSel 按下去，toSel（可选）接到谁身上，dx/dy 是屏幕位移。
   写成函数而不是字符串 —— eval 传字符串时不会带参数，那一拖只会得到函数本身。 */
function DRAG(fromSel, toSel, dx, dy) {
  const pe = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
  const a = document.querySelector(fromSel);
  if (!a) return '没有元素：' + fromSel;
  const r = a.getBoundingClientRect();
  const x0 = r.left + Math.min(r.width / 2, 24), y0 = r.top + Math.min(r.height / 2, 12);
  a.dispatchEvent(pe('pointerdown', x0, y0));
  const mid = toSel ? (document.querySelector(toSel) || window) : window;
  mid.dispatchEvent(pe('pointermove', x0 + dx, y0 + dy));
  mid.dispatchEvent(pe('pointerup', x0 + dx, y0 + dy));
  return '';
}

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const ctx = () => page.eval(() => window.WBBridge.get('canvas').context());
    const click = sel => page.eval(s => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
    /* waitFor 只把函数原文交给页面执行，闭包带不过去 —— 所以要判断的东西一律写成字符串表达式。
       等不到要把判据本身报出来：光一句「等待超时」在这页上根本分不出是页面没接上还是状态不对。 */
    const until = async (expr, ms, note) => {
      try { return await page.waitFor(expr, ms || 12000, 60); }
      catch (e) { throw new Error('第 ' + (++n) + ' 项等不到：' + (note || expr) + '（' + e.message + '）'); }
    };
    const has = sel => '!!document.querySelector(' + JSON.stringify(sel) + ')';
    /* 零参数的判据可以写成函数再包成立即调用 —— waitFor 只收字符串，参数带不过去。 */
    const untilFn = (f, ms, note) => until('(' + f.toString() + ')()', ms, note);
    /* 合成拖动跑不成（选择器找不到元素）就直接报出原因，别让它变成「后面某项不成立」。 */
    const drag = async (...a) => { const r = await page.eval(DRAG, ...a); if (r) throw new Error('第 ' + (++n) + ' 项不成立：' + r); };

    /* ---------- 1) 项目库：空态 → 新建 → 落盘回执 ---------- */
    await page.goto(proxy.base + '/shell.html#canvas.html');
    await until(has('.cv-lib'));
    await until('window.WBBridge && window.WBBridge.get("canvas")', 20000);
    must(await page.eval(() => !!document.querySelector('.cv-grid .empty')), '空库要给出「还没有画布」那句提示');
    /* 成功回执默认是安静的（这一条设置页里能勾）。后面要验「删掉一个节点顺带断开几条线」那句
       —— 它是一句 ok 回执，所以先把这一档打开，探针验的是「这句话在不在」，不是界面默认吵不吵。 */
    await page.eval(() => localStorage.setItem('sk_quiet_ok', '1'));
    /* 出站计数挂在两处：网络层与生成层各一份，拦住的那一步不该碰任何一家。 */
    await page.eval(() => {
      window.__out = 0;
      const wrap = (obj, k) => { if (obj && typeof obj[k] === 'function') { const f = obj[k]; obj[k] = function () { window.__out++; return f.apply(this, arguments); }; } };
      wrap(window.Api, 'create'); wrap(window.Api, 'createBody'); wrap(window.AiGen, 'create');
    });

    must(await click('.cv-lib-bar button.pri'), '新建画布按钮点得到');
    await until(has('#pfDlg'));
    await page.eval(() => { document.getElementById('pf_0').value = '探针画布'; document.getElementById('pfOk').click(); });
    await until('window.WBBridge.get("canvas").ready()', 15000);
    let c = await ctx();
    must(c.标题 === '探针画布' && c.节点数 === 1, '新建出来是一张只有 1 个文本节点的空白画布：' + JSON.stringify(c));
    const hash = await page.eval(() => location.hash);
    must(hash.indexOf('id=') > 0, '地址要带上这份画布的号，刷新才回得来：' + hash);
    await until('/已存本机/.test((document.querySelector(".cv-state")||{}).textContent||"")', 9000);

    /* ---------- 2) 加节点（走真实的类型菜单）：注册表那六类都要建得出来、读得回去 ---------- */
    const addNode = async type => {
      must(await click('.cv-dock .tool[title="添加节点（N）"]'), '加节点按钮点得到');
      await until(has('#uiDlg'));
      await page.eval(v => { const b = document.querySelector('#uiDlg .cv-menu button[data-v="' + v + '"]');
        if (!b) throw new Error('类型菜单里没有 ' + v); b.click(); }, type);
    };
    const rev0 = (await ctx()).revision;
    /* 菜单里的档只来自注册表：先按桥报的六类点一遍，界面少一档或多一档当场就报。 */
    const TYPES = await page.eval(() => window.WBBridge.get('canvas').types().map(t => t.类型));
    must(TYPES.length === 6, '注册表是六类节点，不是别的：' + JSON.stringify(TYPES));
    const ADD = ['image', 'config', 'image', 'video', 'audio', 'asset-ref'];
    for (let i = 0; i < ADD.length; i++) {
      await addNode(ADD[i]);
      await until('window.WBBridge.get("canvas").context().节点数 === ' + (2 + i));
    }
    c = await ctx();
    must(c.revision === rev0 + ADD.length, ADD.length + ' 次加节点要涨 ' + ADD.length + ' 格修订号：' + rev0 + ' → ' + c.revision);
    const total = c.节点数;
    const txt = c.节点.find(x => x.type === 'text');
    const img = c.节点.find(x => x.type === 'image');
    const img2 = c.节点.filter(x => x.type === 'image')[1];
    const cfg = c.节点.find(x => x.type === 'config');
    must(!!txt && !!img && !!img2 && !!cfg, '四档都在：' + JSON.stringify(c.节点.map(x => x.type)));
    must(TYPES.every(t => c.节点.some(x => x.type === t)), '六类节点一个都不该缺席：' + JSON.stringify(c.节点.map(x => x.type)));
    /* 每一类都按自己的类挂进 DOM，并能按号从桥读回来（读的是数据面，不是数 DOM 数量）。 */
    for (const t of TYPES) {
      const row = c.节点.find(x => x.type === t);
      must(await page.eval(([tt, id]) => !!document.querySelector('.cv-node.cv-' + tt + '[data-id="' + id + '"]'), [t, row.id]),
        t + ' 节点要按注册表里那个类名挂进 DOM，并带着自己的号');
      const r = await page.eval(id => window.WBBridge.get('canvas').nodeRead(id), row.id);
      must(!!r && r.type === t && r.id === row.id && Number.isFinite(r.x) && Number.isFinite(r.width),
        t + ' 读回来还是它自己：' + JSON.stringify(r));
    }
    const nb = id => '.cv-node[data-id="' + id + '"] .cv-nb[data-act="run"]';
    must(await page.eval(s => !!document.querySelector(s), nb(img.id)), '可生成的节点才画那颗生成按钮');
    must(await page.eval(s => !document.querySelector(s), nb(cfg.id)), '配置节点不画生成按钮');

    /* ---------- 3) 拖标题栏：预览即落文档 ---------- */
    const revA = (await ctx()).revision;
    const p0 = await page.eval(id => { const x = window.WBBridge.get('canvas').nodeRead(id); return { x: x.x, y: x.y }; }, txt.id);
    await drag('.cv-node[data-id="' + txt.id + '"] .cv-tt', null, 96, 64);
    const p1 = await page.eval(id => { const x = window.WBBridge.get('canvas').nodeRead(id); return { x: x.x, y: x.y }; }, txt.id);
    must(p1.x - p0.x >= 80 && Math.abs(p1.y - p0.y - 64) <= 10,
      '标题栏按下去也要能拖动节点（原本那是只能双击的死区）：' + JSON.stringify({ p0, p1 }));
    must((await ctx()).revision === revA + 1, '拖动算一次写：修订号 +1');
    must(await page.eval(() => !document.querySelector('.cv-grabbing')), '松手后要松开抓取样式');
    /* 贴网格：8px 一档，落点要能被 8 整除 */
    must(p1.x % 8 === 0 && p1.y % 8 === 0, '默认贴网格：' + JSON.stringify(p1));

    /* ---------- 4) 连线：合法的两条画上去，非法与成环各拦一次 ---------- */
    await drag('.cv-node[data-id="' + txt.id + '"] .cv-port.cv-out', '.cv-node[data-id="' + img.id + '"]', 0, 0);
    c = await ctx();
    must(c.连线数 === 1, '这一拖要连上一条线：' + JSON.stringify(c.连线数));
    await drag('.cv-node[data-id="' + img.id + '"] .cv-port.cv-out', '.cv-node[data-id="' + img2.id + '"]', 0, 0);
    must((await ctx()).连线数 === 2, '第二条也该连上');
    const bad = await page.eval((a, b) => window.WBBridge.get('canvas').check({ op: 'connect_nodes', from: a, to: b }), img.id, txt.id);
    must(!bad.ok && /不接受/.test(bad.reason || ''), '图片连回文本要被注册表拦住：' + JSON.stringify(bad));
    const cyc = await page.eval((a, b) => window.WBBridge.get('canvas').check({ op: 'connect_nodes', from: a, to: b }), img2.id, img.id);
    must(!cyc.ok && /环/.test(cyc.reason || ''), '已有的线倒过来接回去要判成环：' + JSON.stringify(cyc));
    must(await page.eval(() => document.querySelectorAll('.cv-svg path').length >= 2), '连线要画出路径');
    /* 重边不是环，但也不许再来一条 */
    const dupEdge = await page.eval((a, b) => window.WBBridge.get('canvas').check({ op: 'connect_nodes', from: a, to: b }), txt.id, img.id);
    must(!dupEdge.ok, '同一条线不该能连两次：' + JSON.stringify(dupEdge));

    /* ---------- 5) 框选 / 检查器 / 就地改名 / 复制 ---------- */
    await drag('.cv-stage', null, 1000, 760);
    const marq = await page.eval(() => document.querySelectorAll('.cv-node.on').length);
    must(marq >= 3, '框住几个选几个：' + marq);
    must(await page.eval(() => !!document.querySelector('.cv-selbar')), '选了东西要冒出那一条小工具栏');
    await page.eval(s => { document.querySelector(s).dispatchEvent(new MouseEvent('click', { bubbles: true })); },
      '.cv-node[data-id="' + img.id + '"] .cv-tt');
    await until(has('.cv-insp-b'));
    must(await page.eval(() => !!document.querySelector('.cv-insp-b [data-f="w"]')), '检查器要有尺寸这一格');
    await page.eval(() => { const i = document.querySelector('.cv-insp-b [data-f="title"]'); i.value = '改过的标题';
      i.dispatchEvent(new Event('change', { bubbles: true })); });
    await until('window.WBBridge.get("canvas").context().节点.some(x => x.标题 === "改过的标题")');
    /* 就地改名：双击 → contenteditable → Enter 落文档 */
    await page.eval(id => { const t = document.querySelector('.cv-node[data-id="' + id + '"] .cv-tt');
      t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, txt.id);
    await until(has('.cv-editing'));
    await page.eval(() => { const e = document.querySelector('.cv-editing'); e.textContent = '双击改的名';
      e.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })); });
    await until('window.WBBridge.get("canvas").context().节点.some(x => x.标题 === "双击改的名")');
    must(await page.eval(() => !document.querySelector('.cv-editing')), 'Enter 之后编辑态要收掉');
    const revB = (await ctx()).revision;
    /* 后面几段的数量都从这里推：这一节多建几类节点，不该逼着下面每一处硬编码跟着改数字。 */
    const nAll = total + 1;
    await page.eval(id => { const el = document.querySelector('.cv-node[data-id="' + id + '"]'); const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 })); }, img.id);
    await until(has('#uiDlg'));
    await page.eval(() => { const b = [...document.querySelectorAll('#uiDlg .cv-menu button')].find(x => /复制一份/.test(x.textContent));
      if (!b) throw new Error('节点菜单里没有「复制一份」：' + document.querySelector('#uiDlg .cv-menu').textContent); b.click(); });
    await until('window.WBBridge.get("canvas").context().节点数 === ' + nAll);
    must((await ctx()).revision === revB + 1, '复制是一次新写');

    /* ---------- 6) 那颗生成按钮：没配平台就一次网络都不发 ---------- */
    const imgAlive = await page.eval(() => window.WBBridge.get('canvas').context().节点.filter(x => x.type === 'image').map(x => x.id));
    /* 节点上的两颗按钮走的是指针按下（surface 自己接的 hit），不是 click —— 探针要按同一颗按钮的真实触发点。 */
    await page.eval(s => document.querySelector(s).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true })), nb(imgAlive[0]));
    await until(has('.toast'));
    const toast = await page.eval(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    must(/还没有平台/.test(toast), '没配平台的生成要拦下来并说明原因：' + toast);
    must((await page.eval(() => window.__out)) === 0, '拦住之后不该有任何出站生成请求：' + (await page.eval(() => window.__out)));
    must(await page.eval(id => window.WBBridge.get('canvas').nodeRead(id).metadata.status === 'idle', imgAlive[0]),
      '被拦住的节点不该变成忙状态');

    /* ---------- 7) 全选删除的两种下场：整批被拒 / 删一个带断线 ---------- */
    await page.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', ctrlKey: true })));
    const allSel = await page.eval(() => document.querySelectorAll('.cv-node.on').length);
    must(allSel === nAll, 'Ctrl+A 要全选（快捷键清单里写了它）：' + allSel);
    must(await page.eval(() => { const b = [...document.querySelectorAll('.cv-selbar button')].find(x => /删除/.test(x.textContent));
      if (!b) return false; b.click(); return true; }), '小工具栏里的删除点得到');
    await until(has('dialog#cfDlg'));
    await page.eval(() => document.querySelector('#cfDlg #cfFoot button.pri').click());
    await until('!document.querySelector("#cfDlg")');
    must((await ctx()).节点数 === nAll, '一次删空要被整批拒掉（不能把最后一个节点删掉）');
    const rejToast = await page.eval(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    must(/最后一/.test(rejToast), '拒掉要说清为什么：' + rejToast);
    /* 只删那个图片节点：先 Esc 清掉刚才全选的那一整组（按在已选中的节点上要保住整组选择，
       那是画布的常识，不是缺陷），再按下即松手 = 单独选中它，然后 Delete。
       它身上挂着两条连线，删掉要一起断，回执里得报数。 */
    await page.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    await untilFn(() => document.querySelectorAll('.cv-node.on').length === 0, 9000, 'Esc 要清空选择');
    await drag('.cv-node[data-id="' + img.id + '"] .cv-tt', null, 0, 0);
    await page.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Delete' })));
    await until(has('dialog#cfDlg'));
    await page.eval(() => document.querySelector('#cfDlg #cfFoot button.pri').click());
    const nAfterDel = nAll - 1;
    await until('window.WBBridge.get("canvas").context().节点数 === ' + nAfterDel);
    const afterDel = await ctx();
    must(afterDel.连线数 === 0, '删掉那个节点要把它身上两条线一起带走：' + JSON.stringify(afterDel.连线数));
    const delToast = await page.eval(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    must(/断开 2 条连线/.test(delToast), '连带断了几条线要报数：' + delToast);

    /* ---------- 8) 撤销 / 重做 / 缩放 / 开关 ---------- */
    must(await click('.cv-dock .tool[title*="撤销"]'), '撤销按钮此刻可点');
    must((await ctx()).节点数 === nAll, '撤销那一步删除，节点要回来');
    must((await ctx()).连线数 === 2, '连着的线也要一起回来');
    must(await click('.cv-dock .tool[title*="重做"]'), '重做按钮可点');
    must((await ctx()).节点数 === nAfterDel, '重做要回到删掉之后');
    const z0 = await page.eval(() => document.querySelector('.cv-zt').textContent);
    must(await click('.cv-zoom button[aria-label="放大"]'), '放大点得到');
    const z1 = await page.eval(() => document.querySelector('.cv-zt').textContent);
    must(z0 !== z1, '放大之后百分比要变：' + z0 + ' → ' + z1);
    must(await click('.cv-zoom button[title="全部装进屏幕"]'), '全部装进屏幕');
    must((await page.eval(() => document.querySelectorAll('.cv-mini i').length)) >= 4, '小地图要按节点画出块与视口框');
    const vp = await page.eval(() => window.WBBridge.get('canvas').context().视口);
    must(vp.scale > 0.2 && vp.scale < 3 && isFinite(vp.x) && isFinite(vp.y), 'fit 之后视口是个正常值：' + JSON.stringify(vp));
    must(await click('.cv-dock .tool[title="显示连线"]'), '连线开关点得到');
    must(await page.eval(() => document.querySelector('.cv-svg').classList.contains('cv-hid')), '关掉连线是给图层加隐藏类');
    must(await click('.cv-dock .tool[title="显示连线"]'), '再点开');
    must(await page.eval(() => !document.querySelector('.cv-svg').classList.contains('cv-hid')), '连线又回来了');

    /* ---------- 9) 落盘与刷新恢复 ---------- */
    const revC = (await ctx()).revision;
    const idC = (await ctx()).id;
    await page.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 's', ctrlKey: true })));
    await until('/已存本机/.test((document.querySelector(".cv-state")||{}).textContent||"")', 9000);
    /* 只换 fragment 的 goto 根本不会重新取文档（撤销栈还在原地，那一条判据就假了），
       所以带一个只对探针有意义的查询号，逼浏览器真的重跑一遍启动。地址里的 ?id= 才是恢复的凭据。 */
    await page.goto(proxy.base + '/shell.html?probe=' + Date.now() + hash);
    await until('window.WBBridge && window.WBBridge.get("canvas") && window.WBBridge.get("canvas").ready()', 25000);
    c = await ctx();
    must(c.id === idC && c.节点数 === nAfterDel && c.连线数 === 0 && c.revision === revC,
      '刷新后应原样回来：' + JSON.stringify({ id: c.id, 应为号: idC, 节点数: c.节点数, 连线数: c.连线数, 修订: c.revision, 应为修订: revC }));
    must(await page.eval(() => document.querySelector('.cv-name').value === '探针画布'), '页头标题回填');
    must(await page.eval(() => document.querySelector('.cv-dock .tool[title*="撤销"]').disabled), '重开之后撤销是灰的：历史不跨会话');

    /* ---------- 10) 项目库：卡片 / 检索 / 改名 / 删除 ---------- */
    must(await click('.cv-back'), '返回项目库');
    await untilFn(() => !!document.querySelector('.cv-lib'), 8000, '要回到项目库那一屏');
    await until(has('.cv-grid .task'), 12000, '库里要画出这份画布的卡片（v-if 回来时盒子会换一只）');
    must((await page.eval(() => document.querySelectorAll('.cv-grid .task').length)) === 1, '库里要有这一份画布');
    must(await page.eval(w => new RegExp(w).test(document.querySelector('.cv-grid .task').textContent),
      nAfterDel + ' 个节点'), '卡片要写出节点数');
    /* 再走一遍同一个来回：第二次换盒子也要重接（只修第一次那种「回去看不见」不算修完）。 */
    await page.eval(() => document.querySelector('.cv-grid .task [data-x="open"]').click());
    await untilFn(() => !!document.querySelector('.cv-work'), 9000, '卡片上的「打开」要进工程页');
    must((await ctx()).节点数 === nAfterDel, '打开的还是那一份');
    must(await click('.cv-back'), '再一次返回项目库');
    await untilFn(() => document.querySelectorAll('.cv-grid .task').length === 1, 9000, '第二次回来卡片还得在');
    await page.eval(() => { const i = document.querySelector('.cv-q'); i.value = '探针'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    must((await page.eval(() => document.querySelectorAll('.cv-grid .task').length)) === 1, '按标题搜「探针」要还在');
    await page.eval(() => { const i = document.querySelector('.cv-q'); i.value = '没有这种名字'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await until('!!document.querySelector(".cv-grid .empty")');
    await page.eval(() => { const i = document.querySelector('.cv-q'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.eval(() => document.querySelector('.cv-grid .task [data-x="ren"]').click());
    await until(has('#pfDlg'));
    await page.eval(() => { document.getElementById('pf_0').value = '改名的画布'; document.getElementById('pfOk').click(); });
    await until('/改名的画布/.test(document.querySelector(".cv-grid .task").textContent)');
    await page.eval(() => document.querySelector('.cv-grid .task [data-x="del"]').click());
    await until(has('dialog#cfDlg'));
    await page.eval(() => { const b = document.querySelector('#cfDlg #cfFoot button.pri');
      if (!b) throw new Error('删除确认里没有那颗主按钮'); b.click(); });
    await until('!!document.querySelector(".cv-grid .empty")');
    must((await page.eval(() => document.querySelectorAll('.cv-grid .task').length)) === 0, '删完库里不该留东西');

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 画布页 e2e 通过（' + n + ' 项：建画布落盘 / 六类节点都建得出也读得回 / 拖标题栏贴网格 / 连线与拦环拦重边 / 框选 / 检查器 / 就地改名 / 复制 / 生成拦住不发请求 / 全选删空整批拒 / 删一个连带断线报数 / 撤销重做 / 缩放小地图 / 连线开关 / Ctrl+S 落盘与刷新恢复 / 库检索改名删除 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
