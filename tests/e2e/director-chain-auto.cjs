#!/usr/bin/env node
/* 「生成全部分镜」的接续链**自动逐级生成**判据（用户点名的主行为）。
   种子：三镜 —— 镜 1 普通镜，镜 2 / 镜 3 `linkPrev:'tail'`（接上一镜尾帧），全部无候选。
   页面里注入一个假视频平台（/registry 的对象在 engine 与 Api 两层是**同一份引用**，
   unshift 一家即两处同时生效）并拦掉它的 Api.request：create 记下请求体、detail 前 2 轮回
   queued、第 3 轮起回 succeeded（产物 = 真字节样本视频的 dataURL，让上一镜真的有「可截的尾帧」）。
   必须成立的四件事：
     ① 镜 1 先提交，提交体**不带**首帧输入；镜 2 / 镜 3 此刻一个都不发；
     ② 镜 1 轮询出画面后，镜 2 **自动**提交，提交体 inputs 里带 role=first_frame 的 dataURL（上一镜尾帧）；
     ③ 镜 2 出画面后镜 3 同样自动提交、同样带上一镜尾帧 —— 级联不需要任何人再点一次；
     ④ 三镜提交体里带的尾帧各自是**上一镜**那一份（链没接错人）。
   另一档：镜 1 生成失败 → 镜 2 / 镜 3 一个都不发（级联 blocked），状态行点名上一镜。
   纯调度算法已在 tests/director-genall.mjs 钉过，这一条负责「页面把调度链接对了」。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const B64 = fs.readFileSync(h.clipFixture()).toString('base64');

const shotOf = (id, name, tail) => ({ id, name, prompt: '画面：' + name, ar: '16:9', res: '768p', tier: 'fast',
  draw: 1, line: '', note: '', model: 'probe-v1', linkPrev: tail ? 'tail' : '', modelAuto: '',
  refImages: [], keyframes: [], candidates: [] });
const wsOf = () => ({ projects: [{ id: 'pr_chain', name: '链式探针', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: '场景 1', shots: [shotOf('sh1', '镜头一', false), shotOf('sh2', '镜头二', true), shotOf('sh3', '镜头三', true)] }],
  film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_chain', roles: [], ts: Date.now() });

/* 这个箭头是**搬到页面里跑的**：里面不许引用本文件的其他名字。
   拦截的 create / detail 只认假平台；其余原路放行。请求体深拷贝进账本供断言。 */
function installProbe() {
  const cfg = window.__CHAIN = { create: [], tasks: {}, seq: 0, fail: false };
  const prov = {
    id: 'probevideo', kind: 'video', name: '探针视频', displayName: '探针视频',
    relay: '/probevideo', keyEnv: 'PROBEVIDEO_KEY', site: 'https://probe.invalid',
    endpoints: { create: '/v1/videos', detail: '/v1/videos/{id}', list: '/v1/videos' },
    models: [{ id: 'probe-v1', name: '探针一号', min: 2, max: 10, modes: ['first_last_frame'] }],
    create: { body: { model: 'model', prompt: 'prompt' }, inputTemplates: {
      first_frame: { to: 'inputs', tmpl: { role: '$role', url: '$url' } },
      last_frame: { to: 'inputs', tmpl: { role: '$role', url: '$url' } },
    } },
    list: { map: { id: 'id', status: 'status', outputUrl: 'video_url', duration: 'duration', error: 'error.message' },
      statusMap: { succeeded: 'done', failed: 'failed' } },
  };
  return Api.registry().then(reg => {
    reg.providers.unshift(prov);            // engine.REG 与 Api._reg 是同一份对象：改这一处两边同时生效
    /* pickable 按「没配密钥的也不出现」筛家：探针平台在本机放一把假密钥，否则
       resolvedModel 找不到它、退到注册表里第一家真平台 —— 整条链就测了个寂寞。 */
    if (window.LS && window.LS.set) window.LS.set('sk_key_probevideo', 'sk-probe');
    const req0 = Api.request.bind(Api);
    Api.request = async (p, name, opts) => {
      if (!p || p.id !== 'probevideo') return req0(p, name, opts);
      const o = opts || {};
      if (name === 'create') {
        cfg.create.push({ at: Date.now(), body: JSON.parse(JSON.stringify(o.body || {})) });
        const tid = 't' + (++cfg.seq);
        cfg.tasks[tid] = { polls: 0 };
        return { id: tid, status: 'queued' };
      }
      if (name === 'detail') {
        const tid = String(o.id);
        const t = cfg.tasks[tid] || (cfg.tasks[tid] = { polls: 0 });
        t.polls++;
        if (cfg.fail) return { id: tid, status: 'failed', error: { message: '探针让它失败' } };
        if (t.polls >= 3) {
          if (!t.doneAt) t.doneAt = Date.now();
          return { id: tid, status: 'succeeded', video_url: window.__PROBE_MP4_URL, duration: 5 };
        }
        return { id: tid, status: 'queued', progress: 20 + t.polls * 20 };
      }
      if (name === 'list') return { data: [] };
      if (name === 'quote') return { ok: true, amount: 1 };       // 询价拦在本地，不发真转发
      return req0(p, name, opts);
    };
    return true;
  });
}

async function boot(proxy, browser, label) {
  const page = await browser.newPage();
  await page.clearStorage(new URL(proxy.base).origin);
  await page.skipDataSyncBoot();
  const put = await fetch(proxy.base + '/data/workspace', {
    method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, ts: Date.now(), data: wsOf() }),
  });
  if (!put.ok) throw new Error(label + '：写入探针工作区失败 HTTP ' + put.status);
  await page.goto(proxy.base + '/shell.html?b=' + label + '#director.html');
  await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
    && window.WBBridge.get('director').ready(), 25000);
  await page.eval(b64 => { window.__PROBE_MP4_URL = 'data:video/mp4;base64,' + b64; }, B64);
  await page.eval(installProbe);
  return page;
}

/* inputTemplates 的 to:'inputs'：单帧时是**一个对象**，多帧时是数组 —— 两种形状都认。 */
const inputFramesOf = body => {
  const x = body && body.inputs;
  const arr = Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []);
  return arr.filter(it => it && it.role === 'first_frame').map(it => String(it.url || ''));
};

/* 中栏空态抬头（`.player-empty .pe-t`）：等待接续的文案就画在这一行。 */
const emptyTitleOf = page => page.eval(() => {
  const t = document.querySelector('#midBody .player-empty .pe-t');
  return t ? String(t.textContent || '') : '';
});
const pickShotRow = (page, idx) => page.eval(i => {
  const rows = document.querySelectorAll('#scenesBox .shot-item');
  if (rows[i]) rows[i].click();
  return rows.length;
}, idx);

(async () => {
  let proxy = null, browser = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();

    /* ---------- 档 1：三镜链自动逐级生成 ---------- */
    let page = await boot(proxy, browser, 'ok');
    await page.eval(() => { const b = document.getElementById('genAll'); if (b) b.click(); });
    await page.waitFor(() => !!document.querySelector('dialog.ui-dlg .pl-scope'), 8000);
    await page.eval(() => { const b = document.querySelector('dialog.ui-dlg .pr-foot .pri'); if (b) b.click(); });
    await page.waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog.ui-dlg'))
        .find(x => /开始生成/.test(x.textContent || ''));
      return !!d;
    }, 8000, 200);
    await page.eval(() => {
      const dlg = Array.from(document.querySelectorAll('dialog.ui-dlg'))
        .find(x => /开始生成/.test(x.textContent || ''));
      const b = dlg && dlg.querySelector('.pr-foot .pri');
      if (b) b.click();
    });

    /* ① 先只提交镜 1；镜 2 / 镜 3 一个都不发 */
    await page.waitFor(() => window.__CHAIN.create.length >= 1, 10000);
    await sleep(1200);
    let c = await page.eval(() => window.__CHAIN.create);
    if (c.length !== 1) throw new Error('启动批只该提交镜 1，实际发了 ' + c.length + ' 条：'
      + JSON.stringify(c.map(x => String(x.body && x.body.prompt))));
    if (inputFramesOf(c[0].body).length) throw new Error('镜 1 不接上一镜，提交体却带了首帧');
    if (String(c[0].body.prompt || '').indexOf('镜头一') < 0) throw new Error('第 1 条提交不是镜 1：' + c[0].body.prompt);

    /* ①-b 等待期间中栏说的话：接续镜点开时先讲「在等上一镜的尾帧」，
       不摆「这条候选还没有描述，去写一句」那种要用户动手的指路。 */
    await pickShotRow(page, 1);
    await sleep(200);
    const waitTxt = await emptyTitleOf(page);
    if (!/等待上一镜/.test(waitTxt)) throw new Error('接续镜等待期间中栏没有等待文案：「' + waitTxt + '」');
    if (!/尾帧/.test(waitTxt)) throw new Error('等待文案没说清在等尾帧：「' + waitTxt + '」');
    if (/还没有描述/.test(waitTxt)) throw new Error('等待期间仍摆着「还没有描述」的指路：「' + waitTxt + '」');

    /* ② 镜 1 出画面后镜 2 自动提交，且提交体带上一镜尾帧（dataURL），
       提交时刻必须晚于镜 1 被判成功的时刻（逐级等待，不是一开始就并发发出）。 */
    await page.waitFor(() => window.__CHAIN.create.length >= 2, 60000, 300);
    await sleep(400);
    c = await page.eval(() => window.__CHAIN.create);
    const fr2 = inputFramesOf(c[1].body);
    if (!fr2.length || !/^data:image\//.test(fr2[0])) {
      throw new Error('镜 2 的提交体没带上一镜尾帧（inputs=' + JSON.stringify(c[1].body.inputs).slice(0, 120) + '）');
    }
    if (String(c[1].body.prompt || '').indexOf('镜头二') < 0) throw new Error('第 2 条提交不是镜 2：' + c[1].body.prompt);
    const done1 = await page.eval(() => Math.min.apply(null, Object.values(window.__CHAIN.tasks)
      .map(t => t.doneAt || Infinity)));
    if (!(c[1].at >= done1)) throw new Error('镜 2 在镜 1 出画面之前就被提交（时序不对）');

    /* ②-b 镜 2 已经接上并提交：等待文案必须消失（换成「正在生成这一镜」那一档）。 */
    await pickShotRow(page, 1);
    await sleep(200);
    const afterTxt = await emptyTitleOf(page);
    if (/等上一镜|等待上一镜/.test(afterTxt)) throw new Error('镜 2 已提交，等待文案还挂着：「' + afterTxt + '」');

    /* ②-c 点按钮之后新加的镜头：复制镜 3（带 linkPrev:'tail'）得到一镜不在本次计划里，
       它没有「在等上一镜」这回事 —— 等待集合只装点按钮那一刻计划里的镜头。 */
    await page.eval(() => {
      const rows = document.querySelectorAll('#scenesBox .shot-item');
      const dup = rows[2] && rows[2].querySelector('.dup');
      if (dup) dup.click();
    });
    await page.waitFor(() => document.querySelectorAll('#scenesBox .shot-item').length === 4, 5000, 100);
    await pickShotRow(page, 3);
    await sleep(200);
    const dupTxt = await emptyTitleOf(page);
    if (/等上一镜|等待上一镜|先单独生成/.test(dupTxt)) {
      throw new Error('批量之后新加的接续镜头出现了等待文案：「' + dupTxt + '」');
    }

    /* ③ 镜 2 出画面后镜 3 自动提交、同样带上一镜尾帧 —— 级联不用任何人再点 */
    await page.waitFor(() => window.__CHAIN.create.length >= 3, 60000, 300);
    c = await page.eval(() => window.__CHAIN.create);
    const fr3 = inputFramesOf(c[2].body);
    if (!fr3.length || !/^data:image\//.test(fr3[0])) throw new Error('镜 3 的提交体没带上一镜尾帧');
    if (String(c[2].body.prompt || '').indexOf('镜头三') < 0) throw new Error('第 3 条提交不是镜 3');
    await page.close();

    /* ---------- 档 2：镜 1 生成失败 → 后面的接续镜一个都不发 ---------- */
    page = await boot(proxy, browser, 'fail');
    await page.eval(() => { window.__CHAIN.fail = true; });
    await page.eval(() => { const b = document.getElementById('genAll'); if (b) b.click(); });
    await page.waitFor(() => !!document.querySelector('dialog.ui-dlg .pl-scope'), 8000);
    await page.eval(() => { const b = document.querySelector('dialog.ui-dlg .pr-foot .pri'); if (b) b.click(); });
    await page.waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog.ui-dlg'))
        .find(x => /开始生成/.test(x.textContent || ''));
      return !!d;
    }, 8000, 200);
    await page.eval(() => {
      const dlg = Array.from(document.querySelectorAll('dialog.ui-dlg'))
        .find(x => /开始生成/.test(x.textContent || ''));
      const b = dlg && dlg.querySelector('.pr-foot .pri');
      if (b) b.click();
    });
    await page.waitFor(() => window.__CHAIN.create.length >= 1, 10000);
    /* 镜 1 三轮后判失败；接续镜必须保持 1 条（不发）。等一段真实轮询窗口再数。 */
    await sleep(9000);
    c = await page.eval(() => window.__CHAIN.create);
    if (c.length !== 1) throw new Error('上一镜失败后接续镜仍被提交（发了 ' + c.length + ' 条）');
    const op = await page.eval(() => String(document.getElementById('opState') ? document.getElementById('opState').textContent : ''));
    if (!/没有提交/.test(op)) throw new Error('失败级联没有回执（opState=「' + op + '」）—— 级联 blocked 的镜头一声不吭');
    await page.close();

    console.log('director-chain-auto: 三镜链逐级自动生成 ✓（尾帧逐镜传递）失败级联 ✓（不发续镜）');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxy) {
      await proxy.stop();
      const f = h.logFaults(proxy.log);
      if (f.length) { console.error(f.join('\n')); process.exitCode = 1; }
    }
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
