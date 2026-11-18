#!/usr/bin/env node
/* 「润色全部文案」的编排判据（「生成全部分镜」分裂按钮的尾项）。
   种子：四镜 —— 镜一有默认候选（这一镜主描述）+ 一条手动候选自有描述，镜二有主描述，
   镜三有一条已完成候选（「视频已生成」那一档），镜四空（不列进目标）。文字 AI 打桩：
     ① 入口是左栏那颗通栏按钮（与「生成全部分镜」同宽）：点 `#polishAll` 先出范围弹窗；
     ② 范围弹窗：三档芯片（全部 / 视频已生成 / 还没视频）只切显示、勾选跨芯片保留；
        带一格「发给 AI 的备注」；取消勾选一条目标之后「开始润色」只发选中的那几条；
     ③ 范围确认后先走一轮**整体问答**（askPolish 一次；桩回 need:false 就直接开润），
        过程弹窗 4 路并发（打桩里数最大在途 ≥ 2），逐行流式；
     ④ 结束后同一张弹窗换审阅清单：每条候选一行「镜头 · 候选 N（状态）」；
        确认写回按候选定位 —— 每条只改自己那句（包括默认候选），镜头级 prompt 已退役；
     ⑤ 停止：只掐在途请求、弹窗不关；已完成的转审阅（部分结果），取消则一个字不动；
     ⑥ 一条都没润出来：弹窗收起并报「文案没有动」；
     ⑦ 范围弹窗点「取消」：不出过程弹窗、一个请求都不发。
   传输层（真正的中止语义）由 net-abort.cjs 钉住，这一条钉的是导演台自己的编排。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const draft = (vid, id) => ({ vid: 'tmp_' + vid, provider: 'local', status: 'draft', progress: 0, url: '', duration: 0, shotId: id });
const shotOf = (id, name, prompt, cands) => ({ id, name, prompt: prompt || '', ar: '16:9', res: '768p', tier: 'fast',
  draw: 1, line: '', note: '', refImages: [], keyframes: [], candidates: cands || [draft('d_' + id, id)] });
const wsOf = () => ({ projects: [{ id: 'pr_po', name: '润色探针', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: '场景 1', shots: [
    shotOf('sh1', '镜头一', '一个雨夜的路口，路灯闪烁', [
      draft('d_sh1', 'sh1'),
      { vid: 'tmp_v_own', provider: 'local', status: 'draft', prompt: '候选自己的句子', origin: 'manual',
        progress: 0, url: '', duration: 0, shotId: 'sh1' },
    ]),
    shotOf('sh2', '镜头二', '主人公撑伞走过斑马线'),
    shotOf('sh3', '镜头三', '远景，城市灯火慢慢亮起', [
      { vid: 'v_done', provider: 'local', status: 'succeeded', prompt: null, origin: 'imported',
        progress: 100, url: '', duration: 3, shotId: 'sh3' },
    ]),
    shotOf('sh4', '镜头四', ''),
  ] }], film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_po', roles: [], ts: Date.now() });

const wsShots = async proxy => {
  const d = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
  const shots = (d && d.data && d.data.projects && d.data.projects[0].scenes[0].shots) || [];
  return shots.map(x => ({ id: x.id, prompt: x.prompt == null ? null : String(x.prompt),
    cands: (x.candidates || []).map(c => ({ vid: c.vid,
      prompt: c.prompt == null ? null : String(c.prompt), origin: String(c.origin || '') })) }));
};

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    const boot = async tag => {
      if (page) await page.close().catch(() => {});
      page = await browser.newPage();
      await page.clearStorage(new URL(proxy.base).origin);
      await page.skipDataSyncBoot();
      await fetch(proxy.base + '/data/workspace', {
        method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, ts: Date.now(), data: wsOf() }),
      });
      await page.goto(proxy.base + '/shell.html?b=' + tag + '#director.html');
      await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
        && window.WBBridge.get('director').ready(), 25000);
      return page;
    };
    const pickShot = idx => page.eval(i => {
      const cards = document.querySelectorAll('#scenesBox .shot-item');
      if (cards[i]) cards[i].click();
      return cards.length;
    }, idx);
    /* 打桩：文字 AI 固定回稿；数 chatStream / askPolish / 在途峰值。
       delay 是每条请求的等待毫秒；ramp 让第 1 条先回、其余慢回（给「停止」留出部分结果窗口）。 */
    const stubAI = opts => page.eval(async o => {
      const T = window.TextAI;
      window.__PO = { chat: [], ask: 0, inflight: 0, maxInflight: 0, calls: 0 };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      T.chatStream = async (reg, sys, user, op, onDelta) => {
        window.__PO.chat.push(String(user || ''));
        const n = ++window.__PO.calls;
        window.__PO.inflight++;
        if (window.__PO.inflight > window.__PO.maxInflight) window.__PO.maxInflight = window.__PO.inflight;
        try {
          await sleep(o.ramp ? (n === 1 ? 200 : 2500) : (o.delay || 250));
          if (o.empty) return '';
          const txt = '【润】' + String(user || '').slice(0, 40);
          if (onDelta) { try { onDelta(txt, 'content'); } catch (e) {} }
          return txt;
        } finally { window.__PO.inflight--; }
      };
      T.askPolish = async () => { window.__PO.ask++; return { need: false, questions: [] }; };
      const reg = await window.Api.registry();
      const pv = T.prov(reg);
      if (pv && window.LS && window.LS.set) window.LS.set('sk_key_' + (pv.keyId || pv.id), 'sk-probe');
      return pv ? pv.id : '';
    }, opts || {});
    /* 润色入口（通栏按钮）→ 范围弹窗。返回范围弹窗里的勾选集合快照给调用方断言。 */
    const openScope = async () => {
      await page.eval(() => document.getElementById('polishAll').click());
      await page.waitFor(() => !!document.querySelector('dialog.ui-dlg .pl-scope'), 8000);
      return page.eval(() => ({
        chips: [...document.querySelectorAll('.pl-scope-chips .ui-seg')].map(b => b.textContent),
        groups: document.querySelectorAll('.pl-scope-list .pl-shot').length,
        sum: String((document.querySelector('.pl-scope-sum') || {}).textContent || ''),
        hasNote: !!document.querySelector('.pl-scope .pl-note'),
      }));
    };
    const chip = f => page.eval(x => {
      const b = document.querySelector('.pl-scope-chips .ui-seg[data-f="' + x + '"]');
      if (b) b.click();
      return document.querySelectorAll('.pl-scope-list .pl-shot').length;
    }, f);
    const toggleKey = key => page.eval(k => {
      const inp = document.querySelector('input[data-role="take"][data-key="' + k + '"]');
      if (inp) inp.click();
      return !!inp;
    }, key);
    const startRun = () => page.eval(() => {
      const b = document.querySelector('dialog.ui-dlg .pr-foot .pri');
      if (b) b.click();
      return !!b;
    });
    const waitReview = (ms) => page.waitFor(() => {
      const d = document.getElementById('prDlg');
      const t = d && d.querySelector('.pr-head b');
      return !!(t && /润色结果/.test(t.textContent || ''));
    }, ms || 30000, 200);
    const prState = () => page.eval(() => {
      const d = document.getElementById('prDlg');
      if (!d) return { open: false };
      return {
        open: true,
        sub: String((d.querySelector('.pr-head .sub') || {}).textContent || ''),
        rows: [...d.querySelectorAll('.pr-row')].map(r => String((r.querySelector('.tt') || {}).textContent || '')),
        procRows: d.querySelectorAll('.pr-proc-row').length,
        states: [...d.querySelectorAll('.pr-proc-row .st')].map(s => String(s.textContent || '')),
        ok: String((d.querySelector('#prOk') || {}).textContent || ''),
      };
    });

    /* ---------- 档 0：右栏改候选描述只动它自己（第一条不跟着变、基准不被顶掉） ---------- */
    await boot('p1');
    const clickThumb = vid => page.eval(v => {
      const t = document.querySelector('#candThumbs .cand-thumb[data-vid="' + v + '"]');
      if (t) t.click();
      return !!t;
    }, vid);
    const promptValIs = async want => {
      for (let i = 0; i < 100; i++) {
        const v = await page.eval(() => String((document.getElementById('edPrompt') || {}).value || ''));
        if (v === want) return true;
        await sleep(50);
      }
      return false;
    };
    const setPrompt = txt => page.eval(t => {
      const ta = document.getElementById('edPrompt');
      if (!ta) return false;
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, txt);
    /* 500ms 保存去抖 + 800ms 镜像合并窗：等落盘按服务端状态轮询，别掐固定时长 */
    const waitWs = async pred => {
      const until = Date.now() + 8000;
      let shots = [];
      while (Date.now() < until) {
        shots = await wsShots(proxy);
        if (pred(shots)) return shots;
        await sleep(250);
      }
      return shots;
    };
    await pickShot(0);
    await page.waitFor(() => !!document.querySelector('#candThumbs .cand-thumb[data-vid="tmp_v_own"]'), 8000, 100);
    if (!(await clickThumb('tmp_v_own'))) throw new Error('候选条里没有第二条候选（tmp_v_own）');
    if (!(await promptValIs('候选自己的句子'))) throw new Error('切到第二条候选后右栏提示词框没换成它自己的描述');
    if (!(await setPrompt('候选改写句'))) throw new Error('没有右栏提示词框 #edPrompt');
    let w0 = (await waitWs(s => s[0] && s[0].cands[1] && s[0].cands[1].prompt === '候选改写句'))[0];
    if (w0.cands[0].prompt !== '一个雨夜的路口，路灯闪烁') throw new Error('改第二条候选把同一镜的默认候选也改了：' + JSON.stringify(w0));
    if (w0.prompt != null) throw new Error('镜头级 prompt 应已退役：' + JSON.stringify(w0));
    if (w0.cands[1].prompt !== '候选改写句') throw new Error('第二条候选的自有描述没有写进去：' + JSON.stringify(w0.cands[1]));
    if (!(await clickThumb('tmp_d_sh1'))) throw new Error('候选条里没有第一条候选（tmp_d_sh1）');
    if (!(await promptValIs('一个雨夜的路口，路灯闪烁'))) throw new Error('切回第一条（auto）后提示词框没回到这一条自己的描述');
    if (!(await setPrompt('雨夜路口，路灯忽明忽暗'))) throw new Error('没有右栏提示词框 #edPrompt');
    w0 = (await waitWs(s => s[0] && s[0].cands[0] && s[0].cands[0].prompt === '雨夜路口，路灯忽明忽暗'))[0];
    if (w0.cands[0].prompt !== '雨夜路口，路灯忽明忽暗') throw new Error('改第一条（auto）没有落到它自己那句：' + JSON.stringify(w0));
    if (w0.cands[1].prompt !== '候选改写句') throw new Error('改第一条（auto）连带改掉了第二条：' + JSON.stringify(w0.cands));

    /* ---------- 档 1：范围筛选 / 逐条勾选 / 并发 / 审阅写回隔离 ---------- */
    await stubAI({ delay: 250 });
    await pickShot(1); await sleep(300); await pickShot(0);
    await page.waitFor(() => /4 条/.test(document.getElementById('polishAll').title), 8000, 200);
    const st0 = await page.eval(() => {
      const b = document.getElementById('polishAll');
      return { dis: b.disabled, title: b.title };
    });
    if (st0.dis) throw new Error('放了文字 AI 密钥之后润色入口仍然禁用：' + st0.title);

    const sc = await openScope();
    if (!sc.hasNote) throw new Error('范围弹窗里没有「发给 AI 的备注」那格');
    if (sc.chips.join('/') !== '全部/视频已生成/还没视频') throw new Error('范围弹窗芯片不对：' + sc.chips.join('/'));
    if (sc.groups !== 3) throw new Error('范围弹窗镜头组数不对（期望 3 组）：' + sc.groups);
    if (!/已勾选 4 \/ 4/.test(sc.sum)) throw new Error('默认应全选：' + sc.sum);
    if (await chip('done') !== 1) throw new Error('「视频已生成」档应只剩镜三一组');
    if (await chip('todo') !== 2) throw new Error('「还没视频」档应剩镜一 / 镜二两组');
    if (await chip('all') !== 3) throw new Error('「全部」档应回到三组');
    if (!(await toggleKey('t:sh2:tmp_d_sh2'))) throw new Error('范围弹窗里找不到镜二的默认候选勾选框');
    const sumAfter = await page.eval(() => String(document.querySelector('.pl-scope-sum').textContent || ''));
    if (!/已勾选 3 \/ 4/.test(sumAfter)) throw new Error('取消勾选一条之后读数不对：' + sumAfter);
    await startRun();
    await waitReview();
    let pr = await prState();
    const po = await page.eval(() => window.__PO);
    if (po.ask !== 1) throw new Error('批量润色应先走一轮整体问答（askPolish 被调了 ' + po.ask + ' 次；桩回 need:false 就直接开润）');
    if (po.chat.length !== 3) throw new Error('应只润勾选的 3 条（实际请求 ' + po.chat.length + ' 条）');
    if (po.chat.some(x => x.indexOf('撑伞') >= 0)) throw new Error('取消勾选的镜二画面仍被润了');
    if (!po.chat.some(x => x.indexOf('候选改写句') >= 0)) throw new Error('候选自有描述没有被润');
    if (po.maxInflight < 2) throw new Error('过程不是并发（最大在途 ' + po.maxInflight + ' 条）');
    if (pr.rows.length !== 3) throw new Error('审阅清单应 3 行（实际 ' + pr.rows.length + '）：' + pr.rows.join(' | '));
    if (!pr.rows.some(t => /镜头一 · 候选 1（草稿）/.test(t))) throw new Error('审阅清单缺默认候选那一行：' + pr.rows.join(' | '));
    if (!pr.rows.some(t => /镜头一 · 候选 2（草稿）/.test(t))) throw new Error('审阅清单缺候选行：' + pr.rows.join(' | '));
    if (!/写回这些条目/.test(pr.ok)) throw new Error('审阅主按钮文案不对：' + pr.ok);
    await page.eval(() => { const b = document.getElementById('prOk'); if (b) b.click(); });
    let shots = [];
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      shots = await wsShots(proxy);
      if (shots[0] && shots[0].cands[0] && shots[0].cands[0].prompt.indexOf('【润】') === 0
        && shots[0].cands.some(c => String(c.prompt || '').indexOf('【润】') === 0)) break;
    }
    const byId = Object.fromEntries(shots.map(x => [x.id, x]));
    if (!/^【润】/.test(byId.sh1.cands[0].prompt)) throw new Error('镜一默认候选没有写回：' + JSON.stringify(byId.sh1));
    if (!/^【润】/.test(String(byId.sh1.cands[1].prompt))) throw new Error('候选自有描述没有写回：' + JSON.stringify(byId.sh1.cands));
    if (byId.sh1.cands[1].origin !== 'manual') throw new Error('候选的 origin 被改掉了：' + byId.sh1.cands[1].origin);
    if (byId.sh1.cands.some(c => c.prompt == null)) throw new Error('候选不该再回落到镜头级描述：' + JSON.stringify(byId.sh1.cands));
    if (byId.sh2.cands[0].prompt !== '主人公撑伞走过斑马线') throw new Error('取消勾选的镜二描述被写了：' + JSON.stringify(byId.sh2.cands));
    if (!/^【润】/.test(byId.sh3.cands[0].prompt)) throw new Error('镜三候选没有写回：' + JSON.stringify(byId.sh3.cands));
    if (byId.sh4.cands[0].prompt !== '') throw new Error('空描述的镜四被写了：' + JSON.stringify(byId.sh4.cands));
    const opTxt = await page.eval(() => String(document.getElementById('opState').textContent || ''));
    if (!/已写回 3 条/.test(opTxt)) throw new Error('写回回执不对：' + opTxt);

    /* ---------- 档 2：停止 → 部分结果转审阅；审阅取消则一个字不动 ---------- */
    await boot('p2');
    await stubAI({ ramp: true });
    await pickShot(1); await sleep(300); await pickShot(0);
    await page.waitFor(() => /4 条/.test(document.getElementById('polishAll').title), 8000, 200);
    const sc2 = await openScope();
    if (!/已勾选 4 \/ 4/.test(sc2.sum)) throw new Error('档 2 默认没有全选：' + sc2.sum);
    await startRun();
    await page.waitFor(() => !!document.getElementById('prDlg'), 8000);
    await page.waitFor(() => [...document.querySelectorAll('#prDlg .pr-proc-row .st')]
      .some(s => /完成/.test(s.textContent || '')), 15000, 100);
    const stopBtn = await page.eval(() => {
      const b = document.getElementById('prCancel');
      if (!b) return '';
      const t = b.textContent;
      b.click();
      return t;
    });
    if (!/停止/.test(stopBtn) || /正在停止/.test(stopBtn)) throw new Error('过程弹窗的取消键没有换面成「停止」：' + stopBtn);
    await waitReview(20000);
    pr = await prState();
    if (!/已停止/.test(pr.sub)) throw new Error('停止后的审阅没有说明已停止：' + pr.sub);
    if (pr.rows.length < 1 || pr.rows.length >= 4) throw new Error('停止后应只剩部分结果（1..3 行），实际 ' + pr.rows.length);
    await page.eval(() => { const b = document.getElementById('prCancel'); if (b) b.click(); });
    await sleep(800);
    shots = await wsShots(proxy);
    if (shots.some(x => (x.cands || []).some(c => String(c.prompt || '').indexOf('【润】') === 0))) {
      throw new Error('审阅取消后候选描述也被写回去了');
    }

    /* ---------- 档 3：一条都没润出来 → 文案没有动；范围弹窗取消 → 一个请求都不发 ---------- */
    await boot('p3');
    await stubAI({ empty: true, delay: 80 });
    await pickShot(1); await sleep(300); await pickShot(0);
    await page.waitFor(() => /4 条/.test(document.getElementById('polishAll').title), 8000, 200);
    await openScope();
    await startRun();
    await page.waitFor(() => !document.getElementById('prDlg'), 20000, 150);
    const banner = await page.eval(() => {
      const b = document.getElementById('banner');
      return b && !b.hidden ? String((b.querySelector('.msg') || {}).textContent || '') : '';
    });
    if (!/都没润出来/.test(banner) || !/文案没有动/.test(banner)) throw new Error('全失败的回执不对：「' + banner + '」');
    shots = await wsShots(proxy);
    if (shots.some(x => (x.cands || []).some(c => String(c.prompt || '').indexOf('【润】') === 0))) throw new Error('全失败之后文案也被写了回去');
    const before = await page.eval(() => window.__PO.chat.length);
    await openScope();
    await page.eval(() => {
      const b = document.querySelector('dialog.ui-dlg .pr-foot .ghost');
      if (b) b.click();
    });
    await sleep(600);
    const after = await page.eval(() => window.__PO.chat.length);
    const prOpen = await page.eval(() => !!document.getElementById('prDlg'));
    if (after !== before) throw new Error('范围弹窗取消之后仍发出了润色请求');
    if (prOpen) throw new Error('范围弹窗取消之后过程弹窗仍被打开');
    console.log('director-polish-all: 通栏入口/芯片筛选/逐条勾选/备注/整体问答/并发/审阅写回隔离/停止转审阅/全失败/取消 ✓');
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (proxy) {
      await proxy.stop();
      const f = h.logFaults(proxy.log);
      if (f.length) { console.error(f.join('\n')); process.exitCode = 1; }
    }
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
