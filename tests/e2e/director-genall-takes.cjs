#!/usr/bin/env node
/* 「生成全部分镜」就地更新已有候选（用户点名的主行为）。
   种子：一镜 + 一条默认候选（auto、描述「镜一画面」、还没有画面）。
   假平台：create 记下请求体；detail 回 succeeded（产物 = 真字节样本视频的 dataURL）。
   必须成立的三件事：
     ① 那一镜的候选**数量没多**（界面上没有多出第二张卡 —— 以前批量会另建一张 auto 占位）；
     ② 那条候选的状态离开了「草稿」（它自己跑起来了）；
     ③ 提交体里的提示词就是**那条候选自己的描述**（不是别的句子）。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const B64 = fs.readFileSync(h.clipFixture()).toString('base64');

/* 一镜 + 一条默认候选（描述与配置都在候选身上）。 */
const shotOf = (id, name, prompt) => ({ id, name, draw: 1, line: '', lineWho: '', note: '', selId: null,
  candidates: [{ vid: 'tk_' + id, shotId: id, created: Date.now(), prompt, origin: 'auto',
    status: 'draft', progress: 0, url: null, error: null, selected: false, locked: false,
    trimS: null, trimE: null, provider: '', priceText: '', priceMicros: null, duration: null,
    model: 'probe-v1', modelAuto: '', tier: 'fast', res: '768p', ar: '16:9', size: '', dur: 5,
    refImages: [], refMeta: [], refVideo: null, refAudio: null, keyframes: [], combo: '',
    firstFrame: null, lastFrame: null, linkPrev: '' }] });

const wsOf = () => ({ projects: [{ id: 'pr_gen', name: '批量探针', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: '场景 1', shots: [shotOf('sh1', '镜头一', '镜一画面')] }],
  film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_gen', roles: [], ts: Date.now() });

/* 假平台：与 chain-auto 同一套（registry 里 unshift 一家即两处同时生效，拦掉它的 Api.request）。 */
function installProbe() {
  const cfg = window.__GEN = { create: [], tasks: {}, seq: 0 };
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
    reg.providers.unshift(prov);
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
        if (t.polls >= 2) return { id: tid, status: 'succeeded', video_url: window.__PROBE_MP4_URL, duration: 5 };
        return { id: tid, status: 'queued', progress: 30 + t.polls * 20 };
      }
      if (name === 'list') return { data: [] };
      if (name === 'quote') return { ok: true, amount: 1 };
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

/* 候选条上的卡片（带 vid 的那些）：数量与标题里的状态。 */
const candStateOf = page => page.eval(() => {
  const cards = [...document.querySelectorAll('#midBody .cand-thumb[data-vid]')];
  return cards.map(c => ({ vid: c.dataset.vid, title: String(c.getAttribute('title') || '') }));
});

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await boot(proxy, browser, 'gen');

    /* ① 批量之前：只有那一条默认候选。 */
    const before = await candStateOf(page);
    if (before.length !== 1) throw new Error('种子不对：候选条上应有 1 条，实际 ' + before.length + ' 条');

    /* 点「生成全部分镜」→ 确认框 → 确认。 */
    await page.eval(() => { const b = document.getElementById('genAll'); if (b) b.click(); });
    await page.waitFor(() => !!document.querySelector('dialog.ui-dlg .pr-foot .pri'), 8000);
    await page.eval(() => { const b = document.querySelector('dialog.ui-dlg .pr-foot .pri'); if (b) b.click(); });
    await page.waitFor(() => window.__GEN.create.length >= 1, 20000, 200);

    /* ③ 提交体里的提示词就是那条候选自己的描述。 */
    const c = await page.eval(() => window.__GEN.create);
    const prompt = String((c[0].body && c[0].body.prompt) || '');
    if (prompt.indexOf('镜一画面') < 0) throw new Error('提交体不是那条候选的描述：' + prompt);

    /* ①② 候选条上还是那一条（数量没多），状态已经离开「草稿」。 */
    await sleep(1500);
    const after = await candStateOf(page);
    if (after.length !== 1) throw new Error('批量生成多出了候选：' + after.length + ' 条（'
      + JSON.stringify(after.map(x => x.title)) + '）');
    if (/待写描述|草稿/.test(after[0].title)) throw new Error('那条候选还在草稿：' + after[0].title);

    console.log('✓ 生成全部分镜：已有候选就地更新（不新建卡）· 提交体是它自己的描述');
  } catch (e) {
    /* 页面里的报错要一并报出来：这条判据盯的是「点下去有没有反应」，
       引擎起不来时静默超时最费时间。 */
    if (page && page.errors && page.errors.length) console.error('页面错误：\n' + page.errors.join('\n'));
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxy) await proxy.stop().catch(() => {});
  }
})().catch(e => { console.error('✗ ' + (e && e.message || e)); process.exit(1); });
