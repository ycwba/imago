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
const path = require('path');
const assert = require('assert/strict');
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
  const cfg = window.__GEN = { create: [], quotes: [], tasks: {}, seq: 0 };
  const prov = {
    id: 'probevideo', kind: 'video', name: '探针视频', displayName: '探针视频',
    relay: '/probevideo', keyEnv: 'PROBEVIDEO_KEY', site: 'https://probe.invalid',
    endpoints: { create: '/v1/videos', detail: '/v1/videos/{id}', list: '/v1/videos', quote: '/v1/quote' },
    models: [{ id: 'probe-v1', name: '探针一号', min: 2, max: 10, modes: ['first_last_frame'] },
      { id: 'probe-v2', name: '探针二号', min: 2, max: 6, modes: ['first_last_frame'], options: { max_outputs: 2, bools: { watermark: { def: true } }, durations: [2, 4, 6], combos: [
        { id: 'text', mode: 'text_to_video', label: '纯文字', roles: [] },
        { id: 'frame', mode: 'first_last_frame', label: '首帧', roles: [{ role: 'first_frame', min: 1, max: 1 }] },
      ] } },
      { id: 'probe-v3', name: '探针三号', min: 2, max: 4, modes: ['text_to_video'], options: { durations: [2, 4], combos: [
        { id: 'text', mode: 'text_to_video', label: '纯文字', roles: [] },
      ] } }],
    pricing: { type: 'quote', currency: '¥', endpoint: 'quote', method: 'POST', body: { model: 'model', seed: 'seed' } },
    create: { body: { model: 'model', prompt: 'prompt' },
      topBools: { turbo: { label: '加速', def: true } },
      shapeFields: { seed: { kind: 'int', label: '随机种子', min: 0 } },
      inputTemplates: {
      first_frame: { to: 'inputs', tmpl: { role: '$role', url: '$url' } },
      last_frame: { to: 'inputs', tmpl: { role: '$role', url: '$url' } },
    } },
    list: { map: { id: 'id', status: 'status', outputUrl: 'video_url', duration: 'duration', error: 'error.message' },
      statusMap: { succeeded: 'done', failed: 'failed' } },
  };
  return Api.registry().then(reg => {
    reg.providers.unshift(prov);
    if (window.LS && window.LS.set) window.LS.set('sk_key_probevideo', 'sk-probe');
    const fetch0 = Net.fetch.bind(Net);
    Net.fetch = async (url, opts) => {
      if (new URL(url, location.href).pathname !== '/probevideo/v1/quote') return fetch0(url, opts);
      cfg.quotes.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ amount_micros: 1000000 }), { headers: { 'content-type': 'application/json' } });
    };
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
      if (name === 'quote') { cfg.quotes.push(o.body); return { ok: true, amount: 1 }; }
      return req0(p, name, opts);
    };
    return true;
  });
}

async function boot(proxy, browser, label, workspace = wsOf()) {
  const page = await browser.newPage();
  await page.clearStorage(new URL(proxy.base).origin);
  await page.skipDataSyncBoot();
  const put = await fetch(proxy.base + '/data/workspace', {
    method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, ts: Date.now(), data: workspace }),
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

const choose = (page, selector, value) => page.eval((sel, v) => {
  const input = document.querySelector(sel);
  if (!input) throw new Error('找不到选项 ' + sel);
  input.value = v;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, selector, value);
const action = (page, name) => page.eval(n => {
  const b = [...document.querySelectorAll('dialog.ui-dlg .pr-foot button')].find(x => x.textContent === n);
  if (!b || b.disabled) throw new Error('动作不可用 ' + n);
  b.click();
}, name);
const openBatch = async page => {
  await page.waitFor(() => !document.getElementById('genAll').disabled, 8000);
  await page.eval(() => document.getElementById('genAll').click());
  await page.waitFor(() => document.querySelector('.pl-scope-list .pl-shot'), 8000);
};
const generationDialogBox = page => page.eval(() => {
  const dlg = document.querySelector('dialog.ui-dlg[open]'), r = dlg.getBoundingClientRect();
  const foot = dlg.querySelector('.pr-foot').getBoundingClientRect();
  if (!dlg.classList.contains('ui-dlg-workflow') || foot.bottom > r.bottom || foot.top < r.top) {
    throw new Error('固定流程弹窗的页脚越界');
  }
  return { width: r.width, height: r.height };
});
const storedShots = async proxy => {
  const data = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
  return data.data.projects[0].scenes[0].shots;
};
const mixedWorkspace = () => {
  const ws = wsOf(), sh1 = ws.projects[0].scenes[0].shots[0];
  sh1.candidates[0].prompt = '长描述 <雨夜> & 第一版\n' + '雨水沿着路沿流过，远处路灯映在潮湿街道上。\n'.repeat(80);
  sh1.candidates.push({ ...structuredClone(sh1.candidates[0]), vid: 'tk_second', prompt: '第二版画面' });
  sh1.candidates.push({ ...structuredClone(sh1.candidates[0]), vid: 'tk_done', status: 'succeeded', prompt: '已完成画面' });
  const blank = shotOf('sh2', '镜头二', '');
  const ref = shotOf('sh3', '镜头三', '首帧画面');
  ref.candidates[0].firstFrame = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  ws.projects[0].scenes[0].shots.push(blank, ref);
  return ws;
};

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await boot(proxy, browser, 'gen');

    /* ① 批量之前：只有那一条默认候选。 */
    const before = await candStateOf(page);
    if (before.length !== 1) throw new Error('种子不对：候选条上应有 1 条，实际 ' + before.length + ' 条');

    await page.eval(() => { const b = document.getElementById('genAll'); if (b) b.click(); });
    await page.waitFor(() => {
      const b = document.querySelector('dialog.ui-dlg:has(.pl-scope) .pr-foot .pri');
      return b && !b.disabled;
    }, 8000);
    await page.eval(() => document.querySelector('dialog.ui-dlg .pr-foot .pri').click());
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

    assert.deepEqual(page.errors, [], '基础生成无页面错误');
    await page.close();
    page = await boot(proxy, browser, 'config', mixedWorkspace());
    await page.setSize(1200, 900);
    await openBatch(page);
    const batchBox = await generationDialogBox(page);
    assert.deepEqual(batchBox, { width: 804, height: 704 });
    await sleep(1800);
    assert.equal(await page.eval(() => document.getElementById('genAll').disabled), true, '弹窗期间旧定时器不解禁');
    await page.eval(() => { void document.getElementById('genAll').onclick(); });
    assert.equal(await page.eval(() => document.querySelectorAll('dialog.ui-dlg[open]').length), 1, '批量配置入口互斥');
    assert.equal(await page.eval(() => document.querySelectorAll('.pl-takes [data-role="take"]').length), 4,
      '已出片镜头的草稿与空描述草稿全部列出，成片不重投');
    assert.equal(await page.eval(() => document.querySelector('.pl-prompt').open), false);
    await page.eval(() => document.querySelector('.pl-prompt summary').click());
    const preview = await page.eval(() => {
      const details = document.querySelector('.pl-prompt'), box = details.querySelector('.pl-prompt-body');
      box.scrollTop = 120;
      return { open: details.open, height: box.clientHeight, total: box.scrollHeight,
        overflow: getComputedStyle(box).overflowY, text: box.textContent, htmlInjected: !!box.querySelector('雨夜') };
    });
    assert.ok(preview.open && preview.height >= 140 && preview.height <= 180 && preview.total > preview.height);
    assert.equal(preview.overflow, 'auto');
    assert.ok(preview.text.includes('<雨夜> &'));
    assert.equal(preview.htmlInjected, false);
    await choose(page, '[data-sh="sh1"][data-role="model"]', 'probe-v2');
    assert.equal(await page.eval(() => document.querySelector('.pl-prompt').open), true, '选型保留展开');
    assert.equal(await page.eval(() => document.querySelector('.pl-prompt-body').scrollTop), 120, '选型保留文案滚动');
    await choose(page, '[data-sh="sh1"][data-role="mode"]', 'frame');
    assert.equal(await page.eval(() => [...document.querySelectorAll('.pr-foot button')]
      .find(b => b.textContent === '仅保存配置').disabled), true, '缺少首帧的模式不保存');
    assert.equal(await page.eval(() => document.querySelector('.pr-foot .pri').disabled), true, '不兼容模式不生成');
    await choose(page, '[data-sh="sh1"][data-role="mode"]', 'text');
    await choose(page, '[data-sh="sh2"][data-role="model"]', 'probe-v3');
    await choose(page, '[data-sh="sh3"][data-role="model"]', 'probe-v3');
    assert.equal(await page.eval(() => [...document.querySelectorAll('.pr-foot button')]
      .find(b => b.textContent === '仅保存配置').disabled), true, '不能静默丢首帧换纯文字型号');
    await choose(page, '[data-sh="sh3"][data-role="model"]', 'probe-v1');
    for (const f of ['bad', 'draft', 'can', 'all']) {
      await page.eval(filter => document.querySelector('.pl-scope-chips [data-f="' + filter + '"]').click(), f);
      const active = await page.eval(() => {
        const on = document.querySelector('.pl-scope-chips button.on');
        const off = document.querySelector('.pl-scope-chips button:not(.on)');
        return { id: on.dataset.f, pressed: on.getAttribute('aria-pressed'),
          highlighted: getComputedStyle(on).backgroundColor !== getComputedStyle(off).backgroundColor };
      });
      assert.deepEqual(active, { id: f, pressed: 'true', highlighted: true });
      assert.deepEqual(await generationDialogBox(page), batchBox, '筛选与展开不改变弹窗尺寸');
    }
    await page.screenshot(path.resolve(__dirname, '../../.renders/batch-generation.png'));
    for (const width of [760, 520]) {
      await page.setSize(width, 800);
      const narrowBox = await generationDialogBox(page);
      await page.eval(() => document.querySelector('.pl-scope-chips [data-f="bad"]').click());
      assert.deepEqual(await generationDialogBox(page), narrowBox, '窄窗空筛选不缩小');
      await page.eval(() => document.querySelector('.pl-scope-chips [data-f="all"]').click());
      assert.deepEqual(await generationDialogBox(page), narrowBox, '窄窗全量不撑大');
      assert.equal(await page.eval(() => {
        const dlg = document.querySelector('dialog.ui-dlg'), rect = dlg.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth + 1 && dlg.scrollWidth <= dlg.clientWidth + 1;
      }), true, '窄窗不横溢 ' + width);
    }
    await page.setSize(1200, 900);
    assert.equal(await page.eval(() => window.__GEN.create.length), 0, '预览不生成');
    await action(page, '取消');
    await openBatch(page);
    assert.ok((await page.eval(() => [...document.querySelectorAll('.pl-take .meta')].map(x => x.textContent)))
      .every(text => !text.includes('探针二号') && !text.includes('探针三号')), '取消不写入型号');
    await choose(page, '[data-sh="sh1"][data-role="model"]', 'probe-v2');
    await choose(page, '[data-sh="sh1"][data-role="mode"]', 'text');
    await choose(page, '[data-sh="sh2"][data-role="model"]', 'probe-v3');
    await action(page, '仅保存配置');
    await page.waitFor(async () => {
      const data = await (await fetch('/data/workspace')).json();
      return data.data.projects[0].scenes[0].shots[0].candidates.filter(c => c.status === 'draft').every(c => c.model === 'probe-v2');
    }, 8000);
    const saved = await storedShots(proxy);
    assert.equal(saved[0].candidates.length, 3, '保存不增候选');
    assert.equal(saved[0].candidates.find(c => c.vid === 'tk_done').model, 'probe-v1', '保存不改成片');
    assert.ok(saved[0].candidates.filter(c => c.status === 'draft').every(c => c.model === 'probe-v2' && c.combo === 'text'));
    assert.equal(saved[1].candidates[0].model, 'probe-v3', '每镜独立型号');
    assert.equal(saved[1].candidates[0].status, 'draft', '空描述也只改配置');
    assert.equal(saved[1].candidates[0].prompt, '');
    assert.ok(saved[2].candidates[0].firstFrame, '不丢首帧');
    assert.equal(await page.eval(() => window.__GEN.create.length), 0, '仅保存无创建请求');
    await page.close();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge?.get('director')?.ready(), 25000);
    await page.eval(b64 => { window.__PROBE_MP4_URL = 'data:video/mp4;base64,' + b64; }, B64);
    await page.eval(installProbe);
    await openBatch(page);
    assert.ok(await page.eval(() => document.querySelector('[data-shot="sh1"] .pl-take .meta').textContent.includes('探针二号')),
      '刷新后恢复型号');
    await page.eval(() => {
      document.querySelector('[data-sh="sh2"][data-role="shot"]').click();
      document.querySelector('[data-sh="sh3"][data-role="shot"]').click();
    });
    await page.waitFor(() => !document.querySelector('.pr-foot .pri').disabled, 8000);
    await action(page, '开始生成');
    await page.waitFor(() => window.__GEN.create.length === 2, 20000);
    const sent = await page.eval(() => window.__GEN.create.map(x => x.body));
    assert.ok(sent.every(x => x.model === 'probe-v2'), '按保存型号提交');
    assert.ok(sent.some(x => x.prompt.includes('长描述')) && sent.some(x => x.prompt.includes('第二版画面')));
    assert.ok(sent.every(x => !x.prompt.includes('已完成画面')), '只生成草稿');
    assert.deepEqual(page.errors, [], '批量编辑与生成无页面错误');
    await page.close();
    const advancedWs = wsOf(), advancedShot = advancedWs.projects[0].scenes[0].shots[0];
    advancedShot.candidates[0].model = 'probe-v2';
    page = await boot(proxy, browser, 'advanced', advancedWs);
    await page.eval(() => document.querySelector('#scenesBox .shot-item').click());
    await page.waitFor(() => document.querySelector('#edDraw') && document.querySelector('[data-tb="turbo"]'), 8000);
    await choose(page, '#edDraw', '2');
    await page.eval(() => {
      const turbo = document.querySelector('[data-tb="turbo"]');
      if (turbo.classList.contains('on')) turbo.click();
    });
    await choose(page, '[data-bool="watermark"]', '0');
    await choose(page, '[data-sf="seed"]', '37');
    await openBatch(page);
    await page.waitFor(() => !document.querySelector('.pr-foot .pri').disabled, 8000);
    const quoted = await page.eval(() => window.__GEN.quotes);
    assert.ok(quoted.some(q => q.model === 'probe-v2' && q.turbo === false && q.seed === 37),
      '询价带所选高级参数：' + JSON.stringify({ quoted, ui: await page.eval(() => document.querySelector('.pl-scope').textContent) }));
    await action(page, '开始生成');
    await page.waitFor(() => window.__GEN.create.length === 2, 20000);
    const advancedBodies = await page.eval(() => window.__GEN.create.map(x => x.body));
    assert.ok(advancedBodies.every(x => x.turbo === false && x.seed === 37 && x.watermark === false),
      '已有候选与补建候选均使用已报价高级参数：' + JSON.stringify(advancedBodies));
    assert.deepEqual(page.errors, [], '高级参数补建无页面错误');
    console.log('✓ 批量生成：就地更新、逐镜选型、模式闸、仅保存/取消无提交、草稿、固定尺寸、提示词滚动、高亮、互斥、补建高级参数与刷新');
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
