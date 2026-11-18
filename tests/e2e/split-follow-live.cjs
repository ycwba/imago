#!/usr/bin/env node
/* 「按这句再改」的**真实链**判据（split-follow.cjs 钉的是 PromptReview 的 UI 机制，
   这一条走 aiBoardSplit 全链：打桩文字 AI 与「接着往下拆」到审阅弹窗，再真点那一行）。
   必须成立：
     ① 「接着往下拆」跑完审阅清单出现在屏上（现有场景「xxx」+ AI 的新镜头）；
     ② 点「按这句再改」→ 流式面板就地出现（.pr-live 有 .pinl）；
     ③ onFollow 收到的 current 是**弹窗此刻那份**（用户手改过的行，不是最初那份）；
     ④ 跑完清单被返回值换新（行数变化）、对话记录出现这一轮、状态行说「已按你这句话改过一版」；
     ⑤ 「拆一份新的」那一档已删：表单里只剩「接着往下拆 / 修改现有分镜」两档。
   文字 AI 打桩按 sys 特征分流：拆分轮与 follow 轮（split_follow 的「改后的完整方案」）各回各的 JSON。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const wsOf = () => ({ projects: [{ id: 'pr_sf', name: '按句再改探针', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: 'xxx', shots: [
    { id: 'sh1', name: '镜头一', prompt: 'xxx 场景的原有镜头', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      line: '', note: '', linkPrev: '', modelAuto: '', refImages: [], keyframes: [], candidates: [] },
  ] }], film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_sf', roles: [], ts: Date.now() });

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.clearStorage(new URL(proxy.base).origin);
    await page.skipDataSyncBoot();
    await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: wsOf() }),
    });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);

    /* 打桩：按 sys 特征分流 + 记账。素材判定轮（board_assets）回一个它认不出的形状 → warn 跳过，不影响断言。 */
    await page.eval(() => {
      const T = window.TextAI;
      window.__SF = { calls: [], followDraft: null };
      const splitJson = JSON.stringify({ title: '探针短片', scenes: [
        { name: 'xxx', shots: [
          { prompt: 'xxx 场景的原有镜头（补全版）', duration: 5, name: '镜头一补', note: '', line: '', speaker: '', chain: '' },
          { prompt: 'xxx 场景里新加的一个镜头', duration: 4, name: '新镜头', note: '', line: '', speaker: '', chain: 'tail' },
          { prompt: 'xxx 场景里另一个新镜头', duration: 4, name: '新镜头二', note: '', line: '', speaker: '', chain: '' },
        ] },
      ] });
      const followJson = JSON.stringify({ title: '探针短片', scenes: [
        { name: 'xxx', shots: [
          { prompt: 'xxx 场景的原有镜头（补全版）', duration: 3, name: '镜头一补', note: '', line: '', speaker: '', chain: '' },
          { prompt: '按你那句改过的新镜头', duration: 4, name: '新镜头', note: '', line: '', speaker: '', chain: 'tail' },
        ] },
      ] });
      T.chatStream = async (reg, sys, user, opts, onDelta) => {
        const isFollow = String(sys || '').indexOf('改后的完整方案') >= 0;
        window.__SF.calls.push({ isFollow, user: String(user || '').slice(0, 200) });
        const txt = isFollow ? followJson : splitJson;
        if (onDelta) {
          try {
            onDelta(txt.slice(0, 40), 'content');
            /* follow 轮：面板此刻应已就地出现（批 B 的 reveal 修复位）——
               真流式时它存在几秒到几十秒；桩是同步返回，面板只在 push 那一瞬存在，就在这里量。 */
            if (isFollow) {
              const live = document.querySelector('#prDlg .pr-live .pinl');
              window.__SF.liveShown = !!live;
              if (live) {
                const r = live.getBoundingClientRect();
                window.__SF.liveVisible = r.height > 0 && r.width > 0;
              }
            }
          } catch (e) {}
        }
        return txt;
      };
      T.askPolish = async () => ({ need: false, questions: [] });
      T.chat = async () => '{}';
      return true;
    });

    /* 打开「拆分镜」表单：⑤ 表单里只剩两档（「拆一份新的」已删） */
    await page.eval(() => { const b = document.getElementById('scriptBtn'); if (b) b.click(); });
    await page.waitFor(() => !!document.querySelector('dialog.pf-dlg, dialog#pfDlg'), 8000);
    const taskOpts = await page.eval(() => Array.from(document.querySelectorAll('dialog select option'))
      .map(o => o.value).filter(v => v === 'append' || v === 'edit' || v === 'new'));
    if (taskOpts.includes('new')) throw new Error('「拆一份新的」那一档还在表单里：' + JSON.stringify(taskOpts));
    if (!(taskOpts.includes('append') && taskOpts.includes('edit'))) throw new Error('两档不见了：' + JSON.stringify(taskOpts));
    /* 默认档是「接着往下拆」：直接填文案开始 */
    await page.eval(() => {
      const dlg = document.querySelector('#pfDlg');
      const ta = Array.from(dlg.querySelectorAll('textarea')).find(x => x.offsetParent !== null);
      if (ta) ta.value = '再补一个镜头：雨夜的霓虹灯特写';
      if (ta) ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.eval(() => { const b = document.querySelector('#pfDlg .pf-foot .pri, #pfDlg #pfOk'); if (b) b.click(); });

    /* ① 审阅清单出现在屏上（弹窗里 .pr-row 分镜行） */
    await page.waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      return d && d.querySelectorAll('.pr-row').length >= 2;
    }, 60000, 300);
    let rows = await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      return d.querySelectorAll('.pr-row').length;
    });
    if (rows < 2) throw new Error('审阅清单行数不对：' + rows);

    /* 手改第一行的正文（onFollow 的 current 必须带着这一版） */
    await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      const ta = d.querySelector('.pr-row textarea, .pr-row .pb-text');
      if (ta) { ta.value = '手改过的提示词'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    });

    /* ② 点「按这句再改」→ 流式面板就地出现（桩内量：同步返回时面板只在 push 那一瞬存在） */
    await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      const inp = d.querySelector('.pr-followin');
      inp.value = '把第一镜再短一点';
      const b = d.querySelector('.pr-followbtn');
      if (b) b.click();
    });

    /* ③④ 跑完：清单换新、对话记录一轮、fnote 说「已按你这句话改过一版」 */
    await page.waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      return d && /已按你这句话改过一版/.test(d.textContent || '');
    }, 30000, 250);
    const st = await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      return {
        rows: d.querySelectorAll('.pr-row').length,
        turns: d.querySelectorAll('.pr-turn').length,
        note: (d.querySelector('.pr-fnote') || {}).textContent || '',
        texts: Array.from(d.querySelectorAll('.pr-row textarea, .pr-row .pb-text')).map(x => x.value),
      };
    });
    if (st.turns < 1) throw new Error('对话记录里没有这一轮');
    if (!/已按你这句话改过一版/.test(st.note)) throw new Error('fnote 没说完成：' + st.note);
    if (!st.texts.some(t => String(t).indexOf('按你那句改过') >= 0)) {
      throw new Error('清单没有被 follow 的返回值换新：' + JSON.stringify(st.texts));
    }
    const calls = await page.eval(() => window.__SF.calls);
    const followCall = calls.filter(c => c.isFollow);
    if (!followCall.length) throw new Error('follow 那一轮没有发起文字 AI 调用');
    /* ② 面板出现过且可见（桩内量） */
    const shown = await page.eval(() => ({ shown: window.__SF.liveShown === true, vis: window.__SF.liveVisible === true }));
    if (!shown.shown) throw new Error('follow 的流式面板没有就地出现');
    if (!shown.vis) throw new Error('follow 的流式面板出现了但不可见（reveal 修复位失效）');
    /* ③ current 要带用户手改的那一版 */
    if (!followCall.some(c => String(c.user).indexOf('手改过的提示词') >= 0)) {
      throw new Error('onFollow 的 current 不是弹窗此刻那份（手改丢了）：' + followCall.map(c => c.user).join('|').slice(0, 200));
    }
    /* 收尾：取消审阅，不写回 */
    await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      const b = d.querySelector('#prCancel');
      if (b) b.click();
    });
    await sleep(400);
    console.log('split-follow-live: 真链 follow ✓（面板可见 / 清单换新 / current 带手改 / 记录一轮）+ 两档表单 ✓');
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
