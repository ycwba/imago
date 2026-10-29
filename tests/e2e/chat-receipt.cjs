#!/usr/bin/env node
/* 助手回执与 Skill 卡：
   1) 执行完的写动作把 changedIds 留在卡片上（「改动了 N 处」+ 一枚「定位」），点「定位」选中并闪，
      执行完那一下自己闪但不抢视图。
   2) 这一轮用过的 Skill 挂在折叠卡外面，芯片写名字与版本；点开能读正文。
      库里改过之后，旧回合的芯片标「下一轮生效」。
   不花钱：TextAI.chatStream 固定回包；唯一的真实写入是探针工程一镜的字幕。
   试验台是导演台的 set_clip（改画面段音量）：返回 changedIds（块 id）、桥上有 locate ——
   回执卡片、执行后闪、定位选中这条链正好每一环都验得到，且不需要真的媒体字节。
   新剪辑核里 locate 落的是**轨道上的那一块**：先点进剪辑态把板画出来再验闪与选中。 */
'use strict';
const h = require('./harness.cjs');

const SKILL_ID = 'receipt-skill';
const skillMd = body => '---\nid: ' + SKILL_ID + '\nname: 回执测试 Skill\ndescription: 回执与定位探针\n'
  + 'triggers: ["回执测试"]\npages: ["director.html"]\ncontract: polish.image\nversion: 1\n---\n\n' + body + '\n';

/* 探针工程：一景一镜一条候选。候选不指真实字节 —— 字幕写入是纯数据账，
   画面轨取帧失败会按退避记账（设计内），不进控制台错误。 */
const project = { id: 'pr_rc', name: '回执探针', rev: 0, scenes: [{ id: 'sc_1', name: '场景 1', shots: [{
  id: 'sh_rc', name: '镜头 1', prompt: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1, line: '', note: '',
  selId: 'v_rc_1', refImages: [], keyframes: [],
  candidates: [{ vid: 'v_rc_1', provider: 'probe', status: 'succeeded', progress: 100,
    url: '/asset/receipt-probe', local: false, duration: 2, shotId: 'sh_rc' }],
}] }],
  /* 成片里一段画面：写动作（改音量）与「定位」都对着它演（块 id = c_rc）。 */
  film: { clips: [{ id: 'c_rc', kind: 'video', shotId: 'sh_rc', candId: 'v_rc_1', name: '镜头 1',
    src: '/asset/receipt-probe', sourceStart: 0, sourceDuration: 2, mediaDuration: 2,
    duration: 2, playbackRate: 1, volume: 1, muted: false, ln: 0 }],
    voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } };

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
    const put = await call('/data/workspace', 'PUT', { v: 1, ts: Date.now(), data: { projects: [project], curId: 'pr_rc', roles: [] } });
    if (put.status !== 200) throw new Error('写入探针工作区失败：HTTP ' + put.status + ' ' + put.text);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor('window.WBBridge && window.WBBridge.get("director") && window.WBBridge.get("director").ready()', 25000);

    const has = sel => '!!document.querySelector(' + JSON.stringify(sel) + ')';
    const until = async (expr, ms, note) => {
      try { return await page.waitFor(expr, ms || 15000, 80); }
      catch (e) { throw new Error('等不到：' + (note || expr) + '（' + e.message + '）'); }
    };
    const lastCard = () => page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      return a.length ? a[a.length - 1].innerText.slice(0, 1200) : ''; });

    /* ---------- 助手装好、模型指到 stub ---------- */
    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      window.TextAI.chatStream = async () => window.__nextRun || '没有 RUN 行';
    });
    await until('!!window.AiChat && !!window.AiChat.open', 25000, '助手装载');
    await page.eval(() => { AiChat.open(); });
    await h.sleep(500);

    const turnDone = (p, note) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('这一句助手回合 60 秒没跑完：' + note)), 60000);
      p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });
    const ctx = () => page.eval(() => {
      const c = window.WBBridge.get('director').context();
      return { 可撤销: c.可撤销, 字幕: (c.字幕 && c.字幕.条数) || 0 };
    });
    /* 点进剪辑态：`.tl-clip` 只在这块板上画出来（生成态里板是隐着的）。 */
    must(await page.eval(() => { const t = document.getElementById('trimBtn'); if (!t) return false; if (!t.classList.contains('on')) t.click(); return true; }), '没有 #trimBtn 那颗剪辑开关');
    await until('!!document.querySelector(' + JSON.stringify('.tl-clip[data-clip="c_rc"]') + ')', 20000, '剪辑态没有画出画面块');

    /* ---------- 1) 真实写动作：执行完卡片留 changedIds，镜头自己闪 ---------- */
    const before = await ctx();
    await page.eval(() => { window.__nextRun = 'RUN: set_clip {"kind":"clip","id":"c_rc","volume":0.4}'; });
    await turnDone(page.eval(() => AiChat.ask('把这一段的原声压到四成')), '改音量');
    must(await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')]; const last = a[a.length - 1];
      return !!last && [...last.querySelectorAll('button')].some(b => b.textContent === '执行'); }), '改音量卡片没出来：' + await lastCard());
    must(await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      const b = [...a[a.length - 1].querySelectorAll('button')].find(x => x.textContent === '执行');
      if (!b) return false; b.click(); return true; }), '卡片上没有「执行」');
    await page.waitFor(() => { const a = [...document.querySelectorAll('.ac-run')];
      return a.length && ![...a[a.length - 1].querySelectorAll('button')].some(x => x.textContent === '执行'); }, 30000, 120);
    const after = await ctx();
    must(after.可撤销 === before.可撤销 + 1, '写动作没进历史：' + JSON.stringify({ 前: before, 后: after }));

    const row = await page.eval(() => {
      const a = [...document.querySelectorAll('.ac-run')];
      const c = a[a.length - 1].querySelector('.ac-run-changed');
      return c ? { text: c.innerText, ids: [...c.querySelectorAll('.ac-loc')].map(b => b.dataset.changedId) } : null;
    });
    must(!!row && /改动了 1 处/.test(row.text), '卡片上没写「改动了 N 处」：' + JSON.stringify(row) + ' / ' + await lastCard());
    must(row.ids.length === 1 && row.ids[0] === 'c_rc', '「定位」没带上改了哪一块：' + JSON.stringify(row));

    /* 执行完那一下只闪，不抢视图：块自己闪一下，闪完 class 要自己摘掉。 */
    const blockSel = '.tl-clip[data-clip="c_rc"]';
    await until('!!document.querySelector(' + JSON.stringify(blockSel + '.flash') + ')', 8000, '执行完没有闪一下');
    await until('!document.querySelector(' + JSON.stringify(blockSel + '.flash') + ')', 8000, '闪完之后 flash 没摘掉');

    /* ---------- 2) 点「定位」：选中那一块、再闪；定位是视图操作，不产生新的历史 ---------- */
    must(await page.eval(() => typeof window.WBBridge.get('director').locate === 'function'), '桥上没有 locate');
    const undoBeforeLocate = (await ctx()).可撤销;
    must(await page.eval(() => { const a = [...document.querySelectorAll('.ac-run')];
      const b = [...a[a.length - 1].querySelectorAll('.ac-loc')][0];
      if (!b) return false; b.click(); return true; }), '「定位」按钮点不到');
    await until('!!document.querySelector(' + JSON.stringify(blockSel + '.flash') + ')', 8000, '定位后没有闪');
    await until('!!document.querySelector(' + JSON.stringify(blockSel + '.is-selected') + ')', 8000, '定位后没有选中那一块');
    const undoAfterLocate = (await ctx()).可撤销;
    must(undoAfterLocate === undoBeforeLocate, '定位是视图操作，不该往历史里记一步：' + undoBeforeLocate + ' → ' + undoAfterLocate);

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
    await page.goto(proxy.base + '/shell.html?receipt=1#director.html');
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
    console.log('✓ 助手回执与 Skill 卡通过（执行后「改动了 1 处」+ 定位 · 执行只闪不抢视图 · 定位停镜且不涨修订 · '
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
