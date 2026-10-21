#!/usr/bin/env node
/* 助手回执与 Skill 卡：
   1) 执行完的写动作把 changedIds 留在卡片上（「改动了 N 处」+ 一枚「定位」），点「定位」选中并闪，
      执行完那一下自己闪但不抢视图。
   2) 这一轮用过的 Skill 挂在折叠卡外面，芯片写名字与版本；点开能读正文。
      库里改过之后，旧回合的芯片标「下一轮生效」。
   不花钱：TextAI.chatStream 固定回包；唯一的真实写入是探针画布里建一枚文本节点。 */
'use strict';
const h = require('./harness.cjs');

const SKILL_ID = 'receipt-skill';
const skillMd = body => '---\nid: ' + SKILL_ID + '\nname: 回执测试 Skill\ndescription: 回执与定位探针\n'
  + 'triggers: ["回执测试"]\npages: ["canvas.html"]\ncontract: polish.image\nversion: 1\n---\n\n' + body + '\n';

let n = 0;
function must(cond, msg) { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const call = async (path, method = 'GET', body) => {
      const r = await fetch(proxy.base + path, {
        method,
        headers: { cookie: proxy.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, text, json };
    };
    const inst = await call('/skills/install', 'POST', { files: [{ path: 'SKILL.md', text: skillMd('第一版写法：先写清楚这一镜要什么。') }] });
    if (inst.status !== 200) throw new Error('探针 Skill 没装上：' + inst.text);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#canvas.html');
    await page.waitFor('window.WBBridge && window.WBBridge.get("canvas")', 25000);

    const click = sel => page.eval(s => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
    const has = sel => '!!document.querySelector(' + JSON.stringify(sel) + ')';
    const until = async (expr, ms, note) => {
      try { return await page.waitFor(expr, ms || 15000, 80); }
      catch (e) { throw new Error('等不到：' + (note || expr) + '（' + e.message + '）'); }
    };
    const lastCard = () => page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      return a.length ? a[a.length - 1].innerText.slice(0, 1200) : ''; });

    /* ---------- 建一份画布，助手装好、模型指到 stub ---------- */
    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      window.TextAI.chatStream = async () => window.__nextRun || '没有 RUN 行';
    });
    must(await click('.cv-lib-bar button.pri'), '新建画布按钮点得到');
    await until(has('#pfDlg'), 15000, '新建画布的表单');
    await page.eval(() => { document.getElementById('pf_0').value = '回执画布'; document.getElementById('pfOk').click(); });
    await until('window.WBBridge.get("canvas").ready()', 20000, '画布打开');
    await until('!!window.AiChat && !!window.AiChat.open', 25000, '助手装载');
    await page.eval(() => { AiChat.open(); });
    await h.sleep(500);

    const turnDone = (p, note) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('这一句助手回合 60 秒没跑完：' + note)), 60000);
      p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });
    const ctx = () => page.eval(() => {
      const c = window.WBBridge.get('canvas').context({ limit: 200 });
      return { revision: c.revision, 视口: c.视口, 选中: (c.选中 || []).map(x => x.id),
        节点: c.节点.map(x => ({ id: x.id, 标题: x.标题 })) };
    });

    /* ---------- 1) 真实写动作：执行完卡片留 changedIds，节点自己闪 ---------- */
    const before = await ctx();
    await page.eval(() => { window.__nextRun = 'RUN: canvas_nodes_create {"nodes":[{"type":"text","title":"定位测试","content":"定位正文"}]}'; });
    await turnDone(page.eval(() => AiChat.ask('加一枚文本节点')), '加节点');
    must(await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')]; const last = a[a.length - 1];
      return !!last && [...last.querySelectorAll('button')].some(b => b.textContent === '执行'); }), '加节点卡片没出来：' + await lastCard());
    must(await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      const b = [...a[a.length - 1].querySelectorAll('button')].find(x => x.textContent === '执行');
      if (!b) return false; b.click(); return true; }), '卡片上没有「执行」');
    await page.waitFor(() => { const a = [...document.querySelectorAll('.ac-run')];
      return a.length && ![...a[a.length - 1].querySelectorAll('button')].some(x => x.textContent === '执行'); }, 30000, 120);
    const after = await ctx();
    must(after.节点.length === before.节点.length + 1, '节点没建出来：' + JSON.stringify(after));
    const node = after.节点.find(x => x.标题 === '定位测试');
    must(!!node, '新节点读不回来：' + JSON.stringify(after.节点));

    const row = await page.eval(() => {
      const a = [...document.querySelectorAll('.ac-run')];
      const c = a[a.length - 1].querySelector('.ac-run-changed');
      return c ? { text: c.innerText, ids: [...c.querySelectorAll('.ac-loc')].map(b => b.dataset.changedId) } : null;
    });
    must(!!row && /改动了 1 处/.test(row.text), '卡片上没写「改动了 N 处」：' + JSON.stringify(row) + ' / ' + await lastCard());
    must(row.ids.length === 1 && row.ids[0] === node.id, '「定位」没带上是哪一枚节点：' + JSON.stringify(row) + ' / ' + node.id);

    /* 执行完那一下只闪，不抢视图：视口没被挪走（add_node 自己会把这枚加进选中，那是写入的既有语义）。 */
    const nodeSel = '.cv-node[data-id=' + JSON.stringify(node.id) + ']';
    await until('!!document.querySelector(' + JSON.stringify(nodeSel + '.flash') + ')', 8000, '执行完没有闪一下');
    must(JSON.stringify(after.视口) === JSON.stringify(before.视口), '执行完不该挪视口：' + JSON.stringify({ 前: before.视口, 后: after.视口 }));

    /* ---------- 2) 点「定位」：选中、滚动、再闪；视图不变内容 ---------- */
    must(await page.eval(() => typeof window.WBBridge.get('canvas').locate === 'function'), '桥上没有 locate');
    /* 先把选中清回原来那枚：执行时 add_node 顺手选中了新节点，不先还原就看不出「定位」到底选中了谁。 */
    must(await page.eval(id => window.WBBridge.get('canvas').apply([{ op: 'select_nodes', ids: [id] }],
      { expectedRevision: window.WBBridge.get('canvas').context().revision }).ok, before.节点[0].id), '清选中失败');
    must((await ctx()).选中[0] === before.节点[0].id, '清选中后选中的不是原来那枚');
    const revBefore = (await ctx()).revision;
    must(await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      const b = [...a[a.length - 1].querySelectorAll('.ac-loc')][0];
      if (!b) return false; b.click(); return true; }), '「定位」按钮点不到');
    await until('!!document.querySelector(' + JSON.stringify(nodeSel + '.on') + ')', 8000, '定位后节点没被选中');
    await until('!!document.querySelector(' + JSON.stringify(nodeSel + '.flash') + ')', 8000, '定位后没有再闪');
    const revAfter = (await ctx()).revision;
    must(revAfter === revBefore, '定位是视图操作，不该涨修订：' + revBefore + ' → ' + revAfter);

    /* ---------- 3) Skill 芯片：本轮用过的写法挂在折叠卡外面，点开读正文 ---------- */
    await page.eval(() => { window.__nextRun = ''; });
    await turnDone(page.eval(() => AiChat.ask('回执测试：这一句有触发词')), 'Skill 回合');
    await until(has('.ac-skill'), 15000, 'Skill 芯片没画出来');
    const chip = await page.eval(() => {
      const a = [...document.querySelectorAll('.ac-skill')];
      const b = a[a.length - 1];
      return b ? { text: b.textContent, insideDetails: !!b.closest('details'), id: b.dataset.skillId } : null;
    });
    must(!!chip && chip.id === SKILL_ID, '芯片不是本轮用的那一份：' + JSON.stringify(chip));
    must(/回执测试 Skill/.test(chip.text) && /v1/.test(chip.text), '芯片没写名字与版本：' + JSON.stringify(chip));
    must(chip.insideDetails === false, 'Skill 芯片被折叠进「工具活动」里了：' + JSON.stringify(chip));

    await page.eval(() => { const a = [...document.querySelectorAll('.ac-skill')]; a[a.length - 1].click(); });
    await until(has('.ac-skill-pre'), 12000, '点芯片没打开正文');
    const body1 = await page.eval(() => document.querySelector('.ac-skill-pre').textContent);
    must(/第一版写法/.test(body1), '正文不是这一份：' + body1.slice(0, 120));
    const sub1 = await page.eval(() => { const d = document.getElementById('uiDlg'); return d ? d.innerText : ''; });
    must(/同一份|同一轮/.test(sub1), '弹窗没写「与本轮用的是同一份」：' + sub1.slice(0, 200));
    await page.eval(() => { const d = document.getElementById('uiDlg');
      const b = d && [...d.querySelectorAll('button')].find(x => /关闭|知道了/.test(x.textContent)); if (b) b.click(); });
    await until('!document.getElementById("uiDlg") || document.getElementById("uiDlg").offsetParent === null', 8000, '弹窗没关掉');

    /* ---------- 4) 库里改过这一份：旧回合标「下一轮生效」，点开看到新正文 ---------- */
    const got = await call('/skills/' + SKILL_ID);
    must(got.status === 200 && got.json && got.json.hash, '读不到这一份的 hash：' + got.text);
    const upd = await call('/skills/' + SKILL_ID + '/update', 'POST', {
      files: [{ path: 'SKILL.md', text: skillMd('第二版写法：动作、情绪、镜头一次说全。') }],
      expectedHash: got.json.hash,
    });
    must(upd.status === 200, '更新这一份失败：' + upd.text);

    /* 换一个 query 再进：hash 相同的导航只是同文档跳转，不会重新载入模块与 Skill 缓存。 */
    await page.goto(proxy.base + '/shell.html?receipt=1#canvas.html');
    await page.waitFor('!!window.AiChat && !!window.AiChat.open', 30000);
    await page.eval(() => AiChat.open());
    await until(has('.ac-skill'), 15000, '刷新后 Skill 芯片没回来');
    try {
      await until('[...document.querySelectorAll(".ac-skill-tag")].some(x => x.textContent === "下一轮生效")', 12000, '改过的 Skill 没标「下一轮生效」');
    } catch (e) {
      const dbg = await page.eval(async () => {
        const o = window.Store.read('ai_chat', null);
        const s = o && o.list && o.list.find(x => x.id === o.cur);
        const turns = (s && s.turns) || [];
        const sk = turns.filter(t => (t.skills || []).length).map(t => t.skills);
        let live = null;
        try { const f = await window.WbSkills.full('receipt-skill'); live = { hash: f.contentHash, version: f.version, enabled: f.enabled, body: String(f.body || '').slice(0, 30) }; } catch (x) { live = { err: String(x && x.message || x) }; }
        const items = await window.WbSkills.list(true).catch(() => []);
        return { turns: sk, live, item: items.filter(x => x.id === 'receipt-skill'),
          chips: [...document.querySelectorAll('.ac-skill')].map(b => b.textContent),
          tags: [...document.querySelectorAll('.ac-skill-tag')].map(x => x.textContent) };
      });
      throw new Error(e.message + '｜' + JSON.stringify(dbg));
    }
    const restored = await page.eval(() => { const a = [...document.querySelectorAll('.ac-skill')];
      const b = a[a.length - 1]; return b ? b.textContent : ''; });
    must(/下一轮生效/.test(restored), '芯片上没有「下一轮生效」：' + restored);

    await page.eval(() => { const a = [...document.querySelectorAll('.ac-skill')]; a[a.length - 1].click(); });
    await until(has('.ac-skill-pre'), 12000, '刷新后点芯片没打开正文');
    const body2 = await page.eval(() => document.querySelector('.ac-skill-pre').textContent);
    must(/第二版写法/.test(body2), '点开的不是库里现在这一份：' + body2.slice(0, 120));
    const sub2 = await page.eval(() => { const d = document.getElementById('uiDlg'); return d ? d.innerText : ''; });
    must(/下一轮才生效/.test(sub2), '弹窗没写清下一轮才生效：' + sub2.slice(0, 240));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 助手回执与 Skill 卡通过（执行后「改动了 1 处」+ 定位 · 执行只闪不抢视图 · 定位选中且不涨修订 · '
      + 'Skill 芯片在折叠卡外/名字+版本/点开正文 · 库里改过标「下一轮生效」并读到新正文 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
