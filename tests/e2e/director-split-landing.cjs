#!/usr/bin/env node
/* 拆分镜统一格式的**落地链**判据（打桩文字 AI，全链走到写入）：
   种子：全新短片 —— 「未命名短片」+「场景 1」+ 一个没动过的占位首镜。
   必须成立：
     ① 审查弹窗出现（统一格式方案：全部是新镜头行）；
     ② 确认写入后：短片自动命名为 AI 回的 title；首场从「场景 1」改成方案首行的场名；
     ③ 占位首镜被拆分结果**覆盖**（不留在最前面），首场里只有方案的那两镜；
     ④ 接上一镜的标记落到候选上（linkPrev:'tail'）；
     ⑤ 状态行报数（写入 / 命名 / 覆盖）。
   统一格式的改镜（带 ref 就地更新）在 director-board.mjs（纯件）与 split-follow-live.cjs（真链）里钉。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const draftCand = () => ({ vid: 'tmp_seed', provider: '', status: 'draft', progress: 0, url: '',
  duration: null, error: null, prompt: '', origin: 'auto', selected: false, locked: false,
  trimS: null, trimE: null, priceText: '', priceMicros: null, model: '', modelAuto: '', tier: '', res: '',
  ar: '', size: '', dur: '', refImages: [], refMeta: [], refVideo: null, refAudio: null,
  keyframes: [], combo: '', firstFrame: null, lastFrame: null, linkPrev: '' });

const wsOf = () => ({ projects: [{ id: 'pr_land', name: '未命名短片', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: '场景 1', shots: [
    { id: 'sh1', name: '新镜头', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      line: '', note: '', modelAuto: '', refImages: [], keyframes: [], candidates: [draftCand()] },
  ] }], film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_land', roles: [], ts: Date.now() });

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.clearStorage(new URL(proxy.base).origin);
    await page.skipDataSyncBoot();
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: wsOf() }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);

    /* 打桩：拆分轮回统一格式（全部新镜头）；问答轮 need:false；素材判定回空。 */
    await page.eval(async () => {
      const T = window.TextAI;
      window.__LAND = { calls: [] };
      const plan = JSON.stringify({ title: '雨夜短片', scenes: [
        { name: '雨夜街头', shots: [
          { prompt: '第一个镜头画面：雨夜街口的路灯', duration: 5, name: '开场', note: '', chain: '' },
          { prompt: '第二个镜头画面：伞沿下的特写（延续上一镜落幅）', duration: 4, name: '推进', note: '', chain: 'tail' },
        ] },
        { name: '天台', shots: [
          { prompt: '天台镜头：她推开天台的门', duration: 5, name: '', note: '', chain: '' },
        ] },
      ] });
      T.chatStream = async (reg, sys, user, opts, onDelta) => {
        window.__LAND.calls.push(String(sys || '').slice(0, 400));
        const txt = plan;
        if (onDelta) { try { onDelta(txt.slice(0, 30), 'content'); } catch (e) {} }
        return txt;
      };
      T.askPolish = async () => ({ need: false, questions: [] });
      T.chat = async () => '{}';
      const reg = await window.Api.registry();
      const pv = T.prov(reg);
      if (pv && window.LS && window.LS.set) window.LS.set('sk_key_' + (pv.keyId || pv.id), 'sk-probe');
      return pv ? pv.id : '';
    });

    /* 打开表单 → 填文案 → 开始。 */
    await page.eval(() => { const b = document.getElementById('scriptBtn'); if (b) b.click(); });
    await page.waitFor(() => !!document.querySelector('#pfDlg'), 8000);
    await page.eval(() => {
      const dlg = document.querySelector('#pfDlg');
      const ta = Array.from(dlg.querySelectorAll('textarea')).find(x => x.offsetParent !== null);
      if (ta) ta.value = '写一个雨夜短片：街口路灯、伞沿特写、最后上天台';
      if (ta) ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.eval(() => { const b = document.querySelector('#pfDlg .pf-foot .pri, #pfDlg #pfOk'); if (b) b.click(); });

    /* ① 审查弹窗出现（统一格式方案）。 */
    await page.waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /确认后写入项目/.test(x.textContent || ''));
      return d && d.querySelectorAll('.pr-row').length >= 3;
    }, 60000, 300);
    const rows = await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog'))
        .find(x => /确认后写入项目/.test(x.textContent || ''));
      return { n: d.querySelectorAll('.pr-row').length,
        sub: String((d.querySelector('.pr-head .sub') || {}).textContent || '') };
    });
    if (rows.n !== 3) throw new Error('审查清单行数不对（期望 3 行新镜头）：' + rows.n);
    if (!/新增 3 镜/.test(rows.sub)) throw new Error('审查弹窗没有报「新增 3 镜」：' + rows.sub);

    /* 确认写入。 */
    await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog'))
        .find(x => /确认后写入项目/.test(x.textContent || ''));
      const b = d && d.querySelector('#prOk');
      if (b) b.click();
    });

    /* ②③④⑤ 读回落盘的工作区：命名 / 覆盖 / 归并 / 接续。 */
    let ws = null;
    for (let t = 0; t < 40; t++) {
      await sleep(250);
      const r = await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } });
      const j = await r.json();
      const p0 = j && j.data && j.data.projects && j.data.projects[0];
      if (p0 && p0.name === '雨夜短片' && p0.scenes.length === 2
        && p0.scenes[0].shots.length === 2) { ws = p0; break; }
    }
    if (!ws) {
      const r = await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } });
      const j = await r.json();
      throw new Error('落盘状态不对：' + JSON.stringify(j && j.data && j.data.projects && j.data.projects[0]));
    }
    if (ws.name !== '雨夜短片') throw new Error('短片没有自动命名：' + ws.name);
    if (ws.scenes[0].name !== '雨夜街头') throw new Error('首场没有按方案首行改名：' + ws.scenes[0].name);
    if (ws.scenes[0].shots.length !== 2) throw new Error('占位首镜没有被覆盖（首场镜数不对）：' + ws.scenes[0].shots.length);
    if (ws.scenes[0].shots.some(x => x.name === '新镜头')) throw new Error('占位首镜还留在场里');
    const s0 = ws.scenes[0].shots[0];
    if (String((s0.candidates || [])[0] && s0.candidates[0].prompt || '').indexOf('第一个镜头画面') < 0) {
      throw new Error('首镜的描述不是方案第一镜：' + JSON.stringify(s0.candidates));
    }
    const s1 = ws.scenes[0].shots[1];
    if (!s1.candidates || s1.candidates[0].linkPrev !== 'tail') throw new Error('接续标记没有落到候选上：' + JSON.stringify(s1.candidates));
    if (ws.scenes[1].name !== '天台' || ws.scenes[1].shots.length !== 1) throw new Error('新场景没有按方案落到后面：' + JSON.stringify(ws.scenes[1]));
    const opTxt = await page.eval(() => String(document.getElementById('opState').textContent || ''));
    if (!/短片已命名为「雨夜短片」/.test(opTxt)) throw new Error('状态行没报短片命名：' + opTxt);
    if (!/占位首镜已由拆分结果覆盖/.test(opTxt)) throw new Error('状态行没报首镜覆盖：' + opTxt);
    if (!/新增 3 个新镜头/.test(opTxt) && !/3 个新镜头/.test(opTxt)) throw new Error('状态行没报新增镜数：' + opTxt);

    console.log('✓ 拆分镜落地链：自动命名（短片 / 首场）+ 占位首镜覆盖 + 新场景归并 + 接续落候选');
  } catch (e) {
    if (page && page.errors && page.errors.length) console.error('页面错误：\n' + page.errors.join('\n'));
    throw e;
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
