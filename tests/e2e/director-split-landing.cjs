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
const assert = require('node:assert/strict');

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
    await page.addInitScript(() => {
      const originalFetch = window.fetch, paidPaths = new Set();
      window.__LAND_PAID = [];
      window.fetch = async (...args) => {
        const input = args[0];
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = String(args[1]?.method || input?.method || 'GET').toUpperCase();
        if (paidPaths.has(url.pathname) && method !== 'GET' && method !== 'HEAD') {
          window.__LAND_PAID.push(url.pathname);
          throw new Error('探针禁止真实生成请求：' + url.pathname);
        }
        const response = await originalFetch(...args);
        if (url.pathname === '/registry' && response.ok) {
          const reg = await response.clone().json();
          for (const prov of reg.providers || []) {
            for (const key of ['create', 'chat']) {
              const endpoint = prov.endpoints?.[key];
              if (prov.relay && endpoint) paidPaths.add(new URL(prov.relay + endpoint, location.href).pathname);
            }
          }
        }
        return response;
      };
    });
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: wsOf() }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);

    await page.eval(async () => {
      const T = window.TextAI;
      window.__LAND = { calls: [], images: [], assets: [
        { name: '小雅', kind: 'actor', look: '短发少女，灰色卫衣', voice: '清亮的年轻女声', why: '主角' },
        { name: '雨巷', kind: 'scene', look: '雨夜小巷，青石路面', why: '故事发生地' },
        { name: '红伞', kind: 'prop', look: '红色油纸伞，竹制伞柄', why: '重要道具' },
        { name: '路灯', kind: 'prop', look: '铁制路灯，暖黄色灯光', why: '照明道具' },
      ] };
      const plan = JSON.stringify({ title: '雨夜短片', scenes: [
        { name: '雨夜街头', shots: [
          { prompt: '第一个镜头画面：小雅在雨巷举着红伞经过路灯', duration: 5, name: '开场', note: '', chain: '' },
          { prompt: '第二个镜头画面：小雅在雨巷路灯下收起红伞（延续上一镜落幅）', duration: 4, name: '推进', note: '', chain: 'tail' },
        ] },
        { name: '天台', shots: [
          { prompt: '天台镜头：她推开天台的门', duration: 5, name: '', note: '', chain: '' },
        ] },
      ] });
      T.chatStream = async (reg, sys, user, opts, onDelta) => {
        window.__LAND.calls.push(String(sys || ''));
        const txt = plan;
        if (onDelta) { try { onDelta(txt.slice(0, 30), 'content'); } catch (e) {} }
        await new Promise(resolve => { window.__LAND.releasePlan = resolve; });
        return txt;
      };
      T.askPolish = async () => ({ need: false, questions: [] });
      T.chat = async (_reg, sys, user) => {
        if (user !== '请写出这张图的提示词。') return JSON.stringify({ newAssets: window.__LAND.assets });
        const asset = window.__LAND.assets.find(a => sys.includes(a.look));
        if (!asset) throw new Error('提示词缺少原素材描述');
        return '最终出图提示词：' + asset.name + '，精细质感与柔和光线，无文字无水印';
      };
      window.AiGen.image = async o => {
        window.__LAND.images.push(o.prompt);
        if (o.prompt.includes('路灯')) throw new Error('测试生图失败');
        const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        return { src };
      };
      const reg = await window.Api.registry();
      for (const prov of reg.providers.filter(p => p.kind === 'video')) {
        window.LS.set('sk_key_' + (prov.keyId || prov.id), 'sk-probe');
      }
      const pv = T.prov(reg);
      if (pv && window.LS && window.LS.set) window.LS.set('sk_key_' + (pv.keyId || pv.id), 'sk-probe');
      return pv ? pv.id : '';
    });

    await page.waitFor(() => window.Capabilities && window.Capabilities.settled, 60000);

    const splitLandingWorkflowBounds = async (stage, reference = null, scrollIn = '') => {
      const metrics = await page.eval(async selector => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const dlg = document.querySelector('dialog.ui-dlg[open]');
        if (!dlg) throw new Error('没有打开的拆分弹窗');
        const box = dlg.getBoundingClientRect();
        const head = dlg.querySelector('.pf-head, .pr-head'), foot = dlg.querySelector('.pf-foot, .pr-foot');
        const body = dlg.querySelector('.pf-body, .pr-body');
        const h = head.getBoundingClientRect(), f = foot.getBoundingClientRect(), b = body.getBoundingClientRect();
        let scrolls = true, pinned = true;
        if (selector) {
          const scroller = dlg.querySelector(selector);
          scrolls = !!scroller && body.contains(scroller) && scroller.clientHeight > 0
            && scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY);
          if (scrolls) {
            const saved = scroller.scrollTop;
            scroller.scrollTop = scroller.scrollHeight;
            await new Promise(requestAnimationFrame);
            pinned = scroller.scrollTop > 0 && dlg.scrollTop === 0
              && Math.abs(head.getBoundingClientRect().top - h.top) <= 1
              && Math.abs(foot.getBoundingClientRect().top - f.top) <= 1;
            scroller.scrollTop = saved;
          }
        }
        return {
          workflow: dlg.classList.contains('ui-dlg-workflow'), width: box.width, height: box.height,
          expectedWidth: Math.min(804, innerWidth * 0.94), expectedHeight: Math.min(704, innerHeight * 0.88),
          contained: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1
            && h.top >= box.top && f.bottom <= box.bottom && f.left >= box.left && f.right <= box.right
            && b.height > 0 && b.top >= h.bottom - 1 && b.bottom <= f.top + 1
            && dlg.scrollWidth <= dlg.clientWidth + 1 && dlg.scrollHeight <= dlg.clientHeight + 1,
          scrolls, pinned,
        };
      }, scrollIn);
      const detail = stage + '：' + JSON.stringify({ metrics, reference });
      assert.ok(metrics.workflow, stage + '：未使用 workflow 尺寸档');
      assert.ok(Math.abs(metrics.width - metrics.expectedWidth) <= 1 && Math.abs(metrics.height - metrics.expectedHeight) <= 1, detail);
      if (reference) assert.ok(Math.abs(metrics.width - reference.width) <= 1 && Math.abs(metrics.height - reference.height) <= 1, detail);
      assert.ok(metrics.contained, stage + '：正文或页脚溢出弹窗');
      assert.ok(metrics.scrolls && metrics.pinned, stage + '：正文未内部滚动或带动标题页脚 ' + scrollIn);
      return { width: metrics.width, height: metrics.height };
    };

    await page.setSize(1440, 900);
    /* 打开表单 → 填文案 → 开始。 */
    await page.eval(() => { const b = document.getElementById('scriptBtn'); if (b) b.click(); });
    await page.waitFor(() => !!document.querySelector('#pfDlg'), 8000);
    await page.eval(() => {
      const dlg = document.querySelector('#pfDlg');
      const ta = Array.from(dlg.querySelectorAll('textarea')).find(x => x.offsetParent !== null);
      if (ta) ta.value = '写一个雨夜短片：街口路灯、伞沿特写、最后上天台';
      if (ta) ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (dlg.querySelector('[data-key="model"], [data-key="combo"]')) throw new Error('拆分表单不应包含视频选型');
      const label = dlg.querySelector('[data-key="script"] label');
      if (label.htmlFor !== ta.id) throw new Error('剧本标签缺少 for');
    });
    const landingSize = await splitLandingWorkflowBounds('拆分输入');
    await page.eval(() => { const b = document.querySelector('#pfDlg .pf-foot .pri, #pfDlg #pfOk'); if (b) b.click(); });
    await page.waitFor(() => !!window.__LAND.releasePlan && !!document.querySelector('#prDlg .pinl-out')?.textContent, 15000);
    await splitLandingWorkflowBounds('拆分流式', landingSize);
    await page.eval(() => window.__LAND.releasePlan());

    /* ① 审查弹窗出现（统一格式方案）。 */
    await page.waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog')).find(x => /分镜方案/.test(x.textContent || ''));
      return d && d.querySelectorAll('.pr-row').length >= 3;
    }, 60000, 300);
    const rows = await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog'))
        .find(x => /分镜方案/.test(x.textContent || ''));
      return { n: d.querySelectorAll('.pr-row').length,
        sub: String((d.querySelector('.pr-head .sub') || {}).textContent || '') };
    });
    await splitLandingWorkflowBounds('拆分审查', landingSize);
    if (rows.n !== 3) throw new Error('审查清单行数不对（期望 3 行新镜头）：' + rows.n);
    if (!/新增 3 镜/.test(rows.sub)) throw new Error('审查弹窗没有报「新增 3 镜」：' + rows.sub);

    const aiConstraint = await page.eval(() => window.__LAND.calls[0]);
    assert.doesNotMatch(aiConstraint, /视频型号：|输入模式：/, '拆分不附加手选型号约束');
    assert.doesNotMatch(rows.sub, /型号|模式/, '审查不重复描述视频选型');

    /* 确认写入。 */
    await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog'))
        .find(x => /分镜方案/.test(x.textContent || ''));
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
    const shotState = project => project.scenes.flatMap(sc => sc.shots).map(sh =>
      ({ id: sh.id, dur: sh.candidates[0].dur, chain: sh.candidates[0].linkPrev }));
    const landedShots = shotState(ws);
    const s1 = ws.scenes[0].shots[1];
    if (!s1.candidates || s1.candidates[0].linkPrev !== 'tail') throw new Error('接续标记没有落到候选上：' + JSON.stringify(s1.candidates));
    if (ws.scenes[1].name !== '天台' || ws.scenes[1].shots.length !== 1) throw new Error('新场景没有按方案落到后面：' + JSON.stringify(ws.scenes[1]));
    const opTxt = await page.eval(() => String(document.getElementById('opState').textContent || ''));
    if (!/短片已命名为「雨夜短片」/.test(opTxt)) throw new Error('状态行没报短片命名：' + opTxt);
    if (!/占位首镜已由拆分结果覆盖/.test(opTxt)) throw new Error('状态行没报首镜覆盖：' + opTxt);
    if (!/新增 3 个新镜头/.test(opTxt) && !/3 个新镜头/.test(opTxt)) throw new Error('状态行没报新增镜数：' + opTxt);

    await page.waitFor(() => Array.from(document.querySelectorAll('dialog'))
      .some(d => /顺便给 4 条新素材出预览图/.test(d.textContent)), 8000);
    const before = await page.eval(() => ({ images: window.__LAND.images,
      assets: window.Chars.Lib.list().map(x => ({ name: x.name, look: x.look, face: x.face })) }));
    assert.equal(before.images.length, 0, '确认前不发出生图请求');
    assert.equal(before.assets.length, 4);
    assert.ok(before.assets.every(x => x.look && !x.face), '确认前仅保留建档描述');
    await page.eval(() => {
      const d = Array.from(document.querySelectorAll('dialog'))
        .find(x => /顺便给 4 条新素材出预览图/.test(x.textContent));
      d.querySelector('.pri').click();
    });
    await page.waitFor(() => document.body.textContent.includes('新素材出图：3 条已发'), 15000);
    const generated = await page.eval(() => ({ images: window.__LAND.images,
      assets: window.__LAND.assets.map(a => ({ ...a, saved: window.Chars.Lib.list().find(x => x.name === a.name) })) }));
    assert.equal(generated.images.length, 4);
    for (const [i, a] of generated.assets.entries()) {
      const prompt = '最终出图提示词：' + a.name + '，精细质感与柔和光线，无文字无水印';
      assert.equal(generated.images[i], prompt, '发送的是最终生图提示词');
      assert.equal(a.saved.look, a.name === '路灯' ? a.look : a.look + '\n\n' + prompt,
        a.name + '：保留原描述，仅成功后追加实际提示词');
      assert.equal(!!a.saved.face, a.name !== '路灯', '图片与描述一起保存');
    }
    assert.equal(generated.assets[0].saved.voiceNote, '清亮的年轻女声', '不修改音色描述');

    const partial = await page.eval(async () => {
      let n = 0;
      window.TextAI.chat = async () => '部分成功提示词 ' + (++n);
      window.AiGen.image = async o => {
        if (o.prompt.endsWith('1')) throw new Error('第一张失败');
        return { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
      };
      const registry = await window.Api.registry();
      const picked = window.Chars.Pipe.pickProvModel(registry, 'image', '', 'text_to_image');
      const reg = { ...registry, providers: registry.providers.map(p => p.id === picked.prov.id
        ? { ...p, models: [{ ...picked.model, options: { ...picked.model.options, max_outputs: 2 } }] } : p) };
      return await window.Chars.Pipe.drawPreview(reg, { opts: { imgModel: picked.key } },
        window.Chars.newProp({ name: '部分成功探针', look: '旧木箱' }), { count: 2 });
    });
    assert.equal(partial.n, 1);
    assert.equal(partial.prompt, '部分成功提示词 2', '返回成功图片的提示词，不误用失败请求');

    const openSplit = async () => {
      await page.eval(() => document.getElementById('scriptBtn').click());
      await page.waitFor(() => !!document.querySelector('#pfDlg'), 8000);
      await page.eval(() => {
        document.querySelector('#pfDlg textarea').value = '新增一个长镜头，保留现有镜头';
      });
    };
    await openSplit();
    await page.eval(() => document.querySelector('#pfCancel').click());

    const longSeconds = await page.eval(async () => {
      const reg = await window.Api.registry();
      const models = window.Api.pickable(reg.providers.filter(p => p.kind === 'video')).flatMap(p => p.models || []);
      const duration = Math.max(...models.map(m => Number(m.options?.durations?.[1]) || 0)) * 2;
      window.TextAI.chat = async () => JSON.stringify({ newAssets: [] });
      window.TextAI.chatStream = async () => JSON.stringify({ scenes: [{ name: '测试长镜', shots: [
        { name: '长镜头', prompt: '窗外的雨持续落下', duration, chain: '' },
      ] }] });
      return duration;
    });
    assert.ok(Number.isFinite(longSeconds) && longSeconds > 0, '测试使用已声明时长的视频能力');
    await openSplit();
    await page.eval(() => document.querySelector('#pfOk').click());
    await page.waitFor(() => !!document.querySelector('#prDlg .pb-dur'), 15000);
    const splitDurations = await page.eval(() => [...document.querySelectorAll('#prDlg .pb-dur')].map(el => Number(el.value)));
    assert.ok(splitDurations.length > 1, '长镜头自动匹配可用接续能力拆段');
    assert.equal(splitDurations.reduce((n, sec) => n + sec, 0), longSeconds, '自动拆段保持总时长');
    await page.eval(() => document.querySelector('#prCancel').click());

    await page.eval(() => {
      window.TextAI.chatStream = () => new Promise(resolve => {
        window.__LAND.release = () => { resolve(JSON.stringify({ scenes: [{ name: '取消后不落盘', shots: [
          { name: '取消结果', prompt: '不应该出现的镜头', duration: 5 },
        ] }] })); window.__LAND.returned = true; };
      });
    });
    await openSplit();
    await page.eval(() => document.querySelector('#pfOk').click());
    await page.waitFor(() => !!window.__LAND.release, 15000);
    await page.eval(() => { document.querySelector('#prCancel').click(); window.__LAND.release(); });
    await page.waitFor(() => window.__LAND.returned && !document.querySelector('#prDlg'), 5000);
    /* 长输入、问答、流式和审查始终同尺寸，取消后不采用测试方案。 */
    for (const viewport of [[1440, 900], [520, 720]]) {
      await page.setSize(...viewport);
      await page.eval(() => {
        const longText = '雨夜长文案\n' + '雨水沿路沿缓慢流动，远处暖黄灯光映在街面。\n'.repeat(80);
        const plan = JSON.stringify({ scenes: [{ name: '尺寸探针', shots: Array.from({ length: 18 }, (_, i) =>
          ({ name: '长镜头 ' + (i + 1), prompt: longText, duration: 5, chain: '' })) }] });
        window.__LAND.layoutText = longText;
        window.__LAND.layoutRelease = null;
        window.TextAI.shouldAsk = () => true;
        window.TextAI.askPolish = async () => ({ need: true, questions: Array.from({ length: 8 }, (_, i) =>
          ({ q: '第 ' + (i + 1) + ' 段画风？', options: ['写实', '水彩'] })) });
        window.TextAI.chat = async () => JSON.stringify({ newAssets: [] });
        window.TextAI.chatStream = async (_reg, _sys, _user, _opts, onDelta) => {
          onDelta(plan.slice(0, 30), 'content');
          window.__LAND.layoutMore = () => onDelta(plan.slice(30), 'content');
          await new Promise(resolve => { window.__LAND.layoutRelease = resolve; });
          return plan;
        };
      });
      await openSplit();
      const fixed = await splitLandingWorkflowBounds('拆分短输入 ' + viewport);
      await page.eval(() => {
        const ta = document.querySelector('#pfDlg textarea');
        ta.value = window.__LAND.layoutText;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await splitLandingWorkflowBounds('拆分长输入 ' + viewport, fixed, 'textarea');
      await page.eval(() => document.getElementById('pfOk').click());
      await page.waitFor(() => !!document.querySelector('#prDlg .pinl-qa'), 8000);
      await splitLandingWorkflowBounds('拆分长问答 ' + viewport, fixed, '#prBody');
      await page.eval(() => {
        document.querySelector('#prDlg .pinl-opt[data-j="1"]').click();
        document.querySelector('#prDlg [data-act="go"]').click();
      });
      await page.waitFor(() => !!window.__LAND.layoutRelease && !!document.querySelector('#prDlg .pinl-out')?.textContent, 15000);
      await splitLandingWorkflowBounds('拆分流式短内容 ' + viewport, fixed);
      await page.eval(() => window.__LAND.layoutMore());
      await splitLandingWorkflowBounds('拆分流式长内容 ' + viewport, fixed, '.pinl-out');
      await page.eval(() => window.__LAND.layoutRelease());
      await page.waitFor(() => document.querySelectorAll('#prDlg .pr-row').length === 18, 20000);
      await splitLandingWorkflowBounds('拆分长审查 ' + viewport, fixed, '#prBody');
      await splitLandingWorkflowBounds('拆分审查长文案 ' + viewport, fixed, '.pb-text');
      await page.eval(() => {
        while (document.querySelectorAll('#prDlg .pr-row').length > 1) document.querySelector('#prDlg [data-del]').click();
      });
      await splitLandingWorkflowBounds('拆分审查仅余一条 ' + viewport, fixed);
      await page.eval(() => document.getElementById('prCancel').click());
      await page.waitFor(() => !document.getElementById('prDlg'), 8000);
      if (page.errors.length) throw new Error('尺寸回归控制台错误：' + page.errors.join(' | '));
    }
    const afterCancel = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
    const cancelledProject = afterCancel.data.projects[0];
    assert.deepEqual(shotState(cancelledProject), landedShots, '取消表单、审查、在途结果都不改已有镜头');
    assert.deepEqual(await page.eval(() => window.__LAND_PAID), [], '文字与生图全程打桩，没有真实付费请求');

    await page.goto(proxy.base + '/shell.html#chars.html');
    await page.waitFor(() => document.querySelector('.chars-page .mbio')
      && document.querySelector('.chars-page').textContent.includes('最终出图提示词：小雅'), 15000);
    const restored = await page.eval(() => window.Chars.Lib.list());
    for (const a of generated.assets) {
      assert.equal(restored.find(x => x.id === a.saved.id).look, a.saved.look, a.name + '：刷新后描述保持一致');
    }
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready() && document.querySelector('#edModel'), 25000);
    const reloaded = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
    assert.deepEqual(shotState(reloaded.data.projects[0]), landedShots, '刷新后镜头、时长和接续保持一致');
    assert.deepEqual(await page.eval(() => window.__LAND_PAID), [], '刷新没有触发真实付费请求');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('拆分镜落地链通过：桌面/520窄窗各阶段固定尺寸、正文内滚与固定页脚 + 自动接续 / 取消 / 刷新 + 素材实际提示词追加与持久化');
  } catch (e) {
    if (page) console.error('页面状态：', await page.eval(() => ({ dialogs: [...document.querySelectorAll('dialog')].map(d => d.textContent),
      status: document.getElementById('opState')?.textContent, script: document.getElementById('scriptBtn')?.outerHTML,
      video: window.Api?.pickable(window.Api.providers().filter(p => p.kind === 'video')).map(p =>
        ({ id: p.id, models: p.models.map(m => ({ id: m.id, durations: m.options?.durations })) })),
      text: document.body.innerText.slice(-1800) })).catch(() => null));
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
