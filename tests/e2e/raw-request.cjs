#!/usr/bin/env node
/* 原始请求折叠条（web/ui/raw-request.js + Api.snapOf）：
   · 默认收起，点开后摘要与请求体就地更新；
   · 导演台整栏每 3 秒 / 切镜重画时展开状态不丢（openTags 记的是 tag，不是那枚 DOM）；
   · 展示的请求体经过脱敏：没有 headers / 授权 / Cookie，dataURL 只留摘要，长提示词截断；
   · 导演台与工作台三型都挂上了自己的标签（tag 跟镜头 / 类型走，不串台）。
   全部用合成事件与假快照，不发一次真实生成请求、不扣费。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const shot = (id, name) => ({
    id, name, prompt: '画面 ' + name, duration: 5,
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], candidates: [],
  });
  const project = {
    id: 'p-raw', name: '原始请求探针', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [shot('sh1', '镜头 A'), shot('sh2', '镜头 B')] }],
  };
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: project.id, roles: [], ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);

    /* 默认收起，且在没有快照时给出「尚未算出 / 预览」的占位。
       ⚠ 这一块现在只有**一栏**：显示的是「本次输入将要发出的那一份」（预览），
       真发出去的那一份只在单栏快照（`RawRequest.html`）里回看 —— 所以这里只有一个 pre。 */
    const tag = 'dir:shot:sh1';
    await page.waitFor(() => !!document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]'), 15000);
    const before = await page.eval(() => {
      const el = document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]');
      return { open: el.open, summary: el.querySelector('summary').textContent,
        halves: el.querySelectorAll('.raw-half').length, pres: el.querySelectorAll('pre').length,
        pre: (el.querySelector('pre') || {}).textContent || '' };
    });
    if (before.open) throw new Error('原始请求折叠条默认不该展开');
    if (!/尚未算出|预览/.test(before.summary)) throw new Error('没有快照时摘要不对：' + before.summary);
    if (before.halves !== 0 || before.pres !== 1) throw new Error('预览块应当是单栏：halves=' + before.halves + ' pres=' + before.pres);

    /* 合成一份快照：生产路径里 `Api.request` 先把请求体过一遍 `snapOf` 再投事件，这里照做。
       headers / 授权字段必须被剔除，dataURL 压成摘要，长提示词截断。 */
    await page.eval(t => {
      const data = 'data:image/png;base64,' + 'A'.repeat(6000);
      window.dispatchEvent(new CustomEvent('wb:raw-request', { detail: {
        tag: t, label: '镜头 A', provider: 'probe', providerName: '探针平台',
        endpoint: 'create', method: 'POST', path: '/relay/probe/v1/create',
        body: window.Api.snapOf({ prompt: '第一句画面提示词', image: data,
          headers: { Authorization: 'Bearer secret-token' }, authorization: 'secret-token',
          nested: { prompt: '嵌套提示词' } }),
        at: Date.now(),
      } }));
    }, tag);
    /* 预览块**不看**发出去的那一份：收到快照后，它的正文仍是「将要发」的请求体 */
    await page.waitFor(() => document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]'), 10000);
    const after = await page.eval(() => {
      const el = document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]');
      return { open: el.open, summary: el.querySelector('summary').textContent,
        pre: (el.querySelector('pre') || {}).textContent || '' };
    });
    if (after.open) throw new Error('收到快照不该自动展开');
    if (/已发送/.test(after.summary)) throw new Error('预览块不该被已发送的快照顶掉标题：' + after.summary);
    /* 发出去的那一份在单栏快照里（素材库 / 批量结果那一族）：脱敏与摘要只在那一份上看。 */
    const sent = await page.eval(t => {
      const host = document.createElement('div');
      host.innerHTML = window.RawRequest.html(t);
      window.RawRequest.bind(host);
      document.body.appendChild(host);
      const out = { summary: (host.querySelector('summary') || {}).textContent || '',
        pre: (host.querySelector('pre') || {}).textContent || '' };
      host.remove();
      return out;
    }, tag);
    if (!/已发送/.test(sent.summary) || !/探针平台/.test(sent.summary)) throw new Error('快照摘要没有说清已发送与平台：' + sent.summary);
    if (!/第一句画面提示词/.test(sent.pre) || !/嵌套提示词/.test(sent.pre)) throw new Error('请求体没有展示提示词：' + sent.pre);
    if (!/<dataURL image\/png/.test(sent.pre)) throw new Error('dataURL 没有压成摘要：' + sent.pre.slice(0, 200));
    if (sent.pre.includes('AAAA')) throw new Error('dataURL 原文被塞进了 DOM');
    if (/secret-token|Authorization|Cookie/i.test(sent.pre)) throw new Error('请求体展示了凭据字段：' + sent.pre.slice(0, 200));

    /* 展开 → 切到另一镜再切回来：整栏重画后仍保持展开（openTags 按 tag 记）。 */
    await page.eval(() => {
      const el = document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]');
      el.open = true;
      el.dispatchEvent(new Event('toggle'));
    });
    await page.eval(() => { const x = document.querySelector('.shot-item[data-sid="sh2"]'); if (x) x.click(); });
    await page.waitFor(() => !!document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh2"]'), 15000);
    await page.eval(() => { const x = document.querySelector('.shot-item[data-sid="sh1"]'); if (x) x.click(); });
    await page.waitFor(() => !!document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]'), 15000);
    const reopened = await page.eval(() => {
      const el = document.querySelector('details.raw-req[data-raw-tag="dir:shot:sh1"]');
      return { open: el.open, summary: el.querySelector('summary').textContent,
        pre: (el.querySelector('pre') || {}).textContent || '' };
    });
    if (!reopened.open) throw new Error('切镜重画后展开状态被收回去了');
    if (!/尚未算出|预览/.test(reopened.summary)) throw new Error('重画后预览块的标题不对：' + reopened.summary);
    if (!reopened.pre) throw new Error('重画后请求体那一格丢了');

    /* Api.snapOf 的独立判据：截断与数组 / 深度封顶。 */
    const snap = await page.eval(() => window.Api.snapOf({
      prompt: '长'.repeat(30000),
      arr: Array.from({ length: 60 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: { f: { g: '太深' } } } } } } },
      cookie: 'session=1',
    }));
    if (!snap.prompt.endsWith('…（已截断，完整原文见提示词归档）')) throw new Error('长提示词没有截断标记：len=' + snap.prompt.length + ' tail=' + JSON.stringify(snap.prompt.slice(-40)));
    if (snap.arr.length !== 51 || snap.arr[50] !== '… 共 60 项') throw new Error('数组没有按 50 项封顶：' + snap.arr.length);
    if (snap.deep.a.b.c.d.e !== '…（层级更深，已省略）') throw new Error('对象深度没有封顶');
    if ('cookie' in snap) throw new Error('Cookie 字段没有被剔除');

    /* 工作台三型各挂各的标签。 */
    for (const t of ['video', 'image', 'audio']) {
      await page.goto(proxy.base + '/shell.html#studio.html?t=' + t);
      const sel = '[data-raw-host] details.raw-req[data-raw-tag="studio:' + t + '"]';
      let n = 0;
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        n = await page.eval(s => document.querySelectorAll(s).length, sel);
        if (n) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (n !== 1) throw new Error('工作台 ' + t + ' 的原始请求折叠条数量不对：' + n);
    }

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log('✓ 原始请求：默认收起 / 单栏预览不被已发送顶掉 / 快照脱敏与摘要 / 展开后重画仍开 / 三型标签各就位');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
