#!/usr/bin/env node
/* 审阅弹窗「按这句再改」的行为判据（PromptReview.onFollow，mountFollow 那一行）：
   ① 行只在给了 onFollow 时出现（不给就不画，点了没反应的按钮不许有）；
   ② 提交时调用方拿到三样：那句话、ctl（push / signal 都在）、**弹窗里此刻这份**（含手改）——
      改要落在用户看到的那一版上，不是最初那份；
   ③ 跑的过程中流式面板就地画在弹窗里；跑完清单被返回值换掉、对话记录出现这一轮、
      流式面板收掉、状态行说「已按你这句话改过一版」；
   ④ 「按这句再改」在跑时「重新规划」让路（retry 桩不被调）；
   ⑤ 调用方抛错：清单原样退回（一条不丢），状态行变红说原因；
   ⑥ 待建素材跟着返回值换，确认时经 onAssets 交回去；
   ⑦ 平铺审阅（mode 不传，改稿那一路）同一行同一套，返回数组就地换条目。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const readWhen = async (fn, timeout = 20000, ...args) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn, ...args);
        if (v) return v;
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    };

    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv && !!window.PromptReview, 20000);

    /* ---- ① 没给 onFollow 就不画那一行 ---- */
    await page.eval(() => {
      window.__pr = PromptReview.openList({
        title: '判据：无 onFollow',
        items: [{ label: 'A', text: '甲' }],
      }).then(r => { window.__prRes = r; });
    });
    await page.waitFor(() => !!document.querySelector('#prDlg'), 10000);
    must(await page.eval(() => !document.querySelector('#prDlg .pr-follow')), '没给 onFollow 不该画「按这句再改」那行');
    await page.eval(() => document.querySelector('#prCancel').click());
    await page.waitFor(() => !document.querySelector('#prDlg'), 10000);

    /* ---- ②③④⑥ 分组审阅：提交 / 流式 / 让路 / 换清单 / 素材 ---- */
    await page.eval(() => {
      window.__followCalls = []; window.__retried = false; window.__followLiveShown = false;
      window.__prRes = null; window.__prAssets = null;
      window.__prDone = PromptReview.openList({
        title: '判据：按这句再改',
        sub: '探针',
        mode: 'board', durEditable: true, lineEditable: true, assetEditable: true,
        items: [
          { key: '场景 1·1', scene: '场景 1', name: '一镜', dur: 5, text: '原来的提示词', line: '', who: '', chain: '' },
          { key: '场景 1·2', scene: '场景 1', name: '二镜', dur: 4, text: '第二条', line: '旧台词', who: '小雅', chain: 'tail' },
        ],
        assets: [{ name: '旧素材', kind: 'prop', look: '旧描述' }],
        onAssets: list => { window.__prAssets = list; },
        retry: async () => { window.__retried = true; return []; },
        onFollow: async (askText, ctl, cur) => {
          window.__followCalls.push({ askText, cur: JSON.parse(JSON.stringify(cur)),
            ctlOk: typeof ctl.push === 'function' && 'signal' in ctl });
          ctl.push('AI 改写的片段…');
          window.__followLiveShown = !!document.querySelector('#prDlg .pr-live .pinl');
          await new Promise(r => setTimeout(r, 400));
          return { items: [
              { key: '场景 1·1', scene: '场景 1', name: '改后一镜', dur: 4, text: '改后的提示词', line: '', who: '', chain: '' },
              { key: '场景 1·2', scene: '场景 1', name: '二镜', dur: 4, text: '第二条', line: '旧台词', who: '小雅', chain: 'tail' },
            ], assets: [{ name: '小雅', kind: 'actor', look: '短发', voice: '清亮' }] };
        },
        followPlaceholder: '判据输入占位',
      }).then(r => { window.__prRes = r; });
    });
    await page.waitFor(() => !!document.querySelector('#prDlg .pr-follow'), 10000);
    must(await page.eval(() => !!document.querySelector('#prDlg .pr-followin')
      && /判据输入占位/.test(document.querySelector('#prDlg .pr-followin').placeholder)), '输入行与占位在');

    /* 手改第一镜的正文 —— snapshot 必须把这份带回去 */
    await page.eval(() => {
      const ta = document.querySelector('#prDlg .brow .pb-text');
      ta.value = '用户手改过的提示词';
      ta.dispatchEvent(new Event('input'));
      document.querySelector('#prDlg .pr-followin').value = '第一镜再具体一点';
    });
    /* 点「按这句再改」，紧接着点「重新规划」——那一轮在跑，retry 必须让路 */
    await page.eval(() => {
      document.querySelector('#prDlg .pr-followbtn').click();
      document.querySelector('#prRetry').click();
    });
    await readWhen(() => window.__followLiveShown, 10000);
    must(await page.eval(() => window.__followLiveShown), '跑的过程中流式面板就地画在弹窗里');
    must(await page.eval(() => document.querySelector('#prRetry').disabled), '跑的过程中「重新规划」被禁用');
    const call = await readWhen(() => window.__followCalls[0], 10000);
    must(call, 'onFollow 被调用了');
    must(call.askText === '第一镜再具体一点', '调用方拿到的是那句话');
    must(call.ctlOk, 'ctl 带着 push 与 signal');
    must(call.cur && call.cur.length === 2 && call.cur[0].text === '用户手改过的提示词'
      && call.cur[1].who === '小雅' && call.cur[1].chain === 'tail',
      'snapshot 交回的是弹窗里此刻这份（含手改 / 台词 / 接续）');
    must(await page.eval(() => window.__retried === false), '「按这句再改」在跑时「重新规划」让路');

    /* 跑完：清单换掉 / 对话记录出现 / 流式收掉 / 状态行说改过一版 */
    await readWhen(() => document.querySelector('#prDlg') && /改后的提示词/.test(document.querySelector('#prDlg .pr-body').textContent), 10000);
    must(await page.eval(() => /第 1 轮 · 你说：第一镜再具体一点/.test(document.querySelector('#prDlg .pr-talk').textContent)),
      '对话记录出现这一轮');
    must(await page.eval(() => !document.querySelector('#prDlg .pr-live .pinl')), '流式面板收掉了');
    must(await page.eval(() => /已按你这句话改过一版/.test(document.querySelector('#prDlg .pr-fnote').textContent)),
      '状态行说「已按你这句话改过一版」');
    must(await page.eval(() => !document.querySelector('#prDlg .pr-fnote').classList.contains('bad')), '成功状态不是红色');
    must(await page.eval(() => document.querySelector('#prDlg .pr-followbtn').textContent.includes('按这句再改')
      && !document.querySelector('#prRetry').disabled), '收尾恢复：按钮文案与「重新规划」复位');

    /* ---- ⑤ 失败：清单原样退回，状态行变红 ---- */
    await page.eval(() => {
      const dlg = document.querySelector('#prDlg');
      dlg.querySelector('.pr-followin').value = '让它报个错';
      dlg.__badFollow = PromptReview; // 占位，真正动作在下面替换 onFollow 不行 —— 桩已闭包；改为让桩读旗标
    });
    /* 桩已经闭包在弹窗里，改不了 —— 关掉这张，再开一张专门试失败路径 */
    await page.eval(() => document.querySelector('#prCancel').click());
    await page.waitFor(() => !document.querySelector('#prDlg'), 10000);
    await page.eval(() => {
      window.__prRes = null;
      window.__prDone = PromptReview.openList({
        title: '判据：失败路径', mode: 'board', durEditable: true,
        items: [{ key: '场景 1·1', scene: '场景 1', name: '一镜', dur: 5, text: '还在的提示词', line: '', who: '', chain: '' }],
        onFollow: async () => { throw new Error('桩里故意失败'); },
      }).then(r => { window.__prRes = r; });
    });
    await page.waitFor(() => !!document.querySelector('#prDlg .pr-follow'), 10000);
    await page.eval(() => {
      document.querySelector('#prDlg .pr-followin').value = '让它报个错';
      document.querySelector('#prDlg .pr-followbtn').click();
    });
    await readWhen(() => document.querySelector('#prDlg .pr-fnote') && document.querySelector('#prDlg .pr-fnote').hidden === false, 10000);
    must(await page.eval(() => document.querySelector('#prDlg .pr-fnote').classList.contains('bad')
      && /这一轮没改成：桩里故意失败/.test(document.querySelector('#prDlg .pr-fnote').textContent)), '失败状态变红并说原因');
    must(await page.eval(() => /还在的提示词/.test(document.querySelector('#prDlg .pr-body').textContent)),
      '失败后清单原样退回，一条不丢');
    await page.eval(() => document.querySelector('#prCancel').click());
    await page.waitFor(() => !document.querySelector('#prDlg'), 10000);

    /* ---- ⑥⑦ 平铺审阅 + 确认时的素材交回 ---- */
    await page.eval(() => {
      window.__flatCur = null; window.__flatLive = false;
      window.__prRes = null; window.__prAssets = null;
      window.__prDone = PromptReview.openList({
        title: '判据：平铺 + 确认',
        items: [{ label: '改 · 一镜', text: '旧' }],
        onFollow: async (askText, ctl, cur) => {
          window.__flatCur = JSON.parse(JSON.stringify(cur));
          ctl.push('…'); window.__flatLive = true;
          return [{ label: '改 · 一镜', text: '平铺的新正文', op: 'update' }];
        },
        onAssets: list => { window.__prAssets = list; },
      }).then(r => { window.__prRes = r; });
    });
    await page.waitFor(() => !!document.querySelector('#prDlg .pr-follow'), 10000);
    await page.eval(() => {
      document.querySelector('#prDlg .pr-followin').value = '平铺也要能改';
      document.querySelector('#prDlg .pr-followbtn').click();
    });
    await readWhen(() => window.__flatCur, 10000);
    must(await page.eval(() => window.__flatCur.length === 1 && window.__flatCur[0].text === '旧'), '平铺 snapshot 同样交回此刻这份');
    await readWhen(() => document.querySelector('#prDlg') && /平铺的新正文/.test(document.querySelector('#prDlg .pr-body').textContent), 10000);
    must(await page.eval(() => window.__flatLive), '平铺审阅同样就地流式');
    /* 确认：返回值带着改后的条目（附加字段 op 原样在），待建素材那块没启用时不强交 */
    await page.eval(() => document.querySelector('#prOk').click());
    await readWhen(() => window.__prRes, 10000);
    must(await page.eval(() => window.__prRes && window.__prRes.length === 1
      && window.__prRes[0].text === '平铺的新正文' && window.__prRes[0].op === 'update'),
      '确认时返回改后的条目，附加字段原样在');

    console.log('\n✓ split-follow e2e 通过');
  } catch (e) {
    console.error('\n✗ ' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
