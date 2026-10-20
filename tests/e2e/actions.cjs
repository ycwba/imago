#!/usr/bin/env node
/* 助手动作目录：关键动作齐全、参数说明与执行入口存在、跨页守卫会说清原因。
   还判两件事（报告 §6.2「新增动作要改 6 张表」）：动作面与策略表 ACTION_META 一一对得上
   （缺 effect / 缺 route / 多登记都红），以及「按当前页过滤」真的在过滤 ——
   这一条以前从来没生效过（读的是 ACTS 上不存在的 route 字段），模型在设置页也看得见 select_take。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => !!window.AiChat, 15000);
    const out = await page.eval(async () => {
      const acts = window.AiChat.ACTS || {};
      const need = ['generate', 'save_char', 'remove_char', 'set_setting', 'fill',
        'select_take', 'cut_timeline', 'set_clip', 'undo_edit'];
      const miss = need.filter(k => !acts[k]);
      const broken = Object.keys(acts).filter(k => {
        const d = acts[k] || {};
        return typeof d.check !== 'function' || typeof d.run !== 'function' || !d.arg || !d.title;
      });
      const guard = await acts.select_take.check({ take: 1 });
      const mod = await import('/web/core/actions.js');
      const reg = mod.createActionRegistry({});
      reg.register({
        id: 't.bad', effect: 'read', route: '*',
        input: { type: 'object', properties: { n: { type: 'number', min: 1, max: 2 } }, required: ['n'] },
        check: a => ({ ok: true, plan: a }), run: () => ({ ok: true }),
      });
      const bad = await reg.plan('t.bad', { n: 9 }, { route: 'favorites.html' });
      const rejected = bad && bad.ok === false ? String(bad.reason || '') : '';
      /* 策略表（effect / route / undo）与动作面必须一一对得上，且「按当前页过滤」真的在过滤。
         这条判据对着的是报告 §6.2 那两个静默坏：漏 route 时清单里谁都看得见，
         漏 effect 时一条花钱的动作被当只读（不标 irreversible、不画撤销、cancel 也不声明）。 */
      const meta = window.AiChat.ACT_META || {};
      const actIds = Object.keys(acts);
      const noMeta = actIds.filter(k => !meta[k] || !meta[k].effect || !meta[k].route);
      const orphanMeta = Object.keys(meta).filter(k => !acts[k]);
      const costIds = actIds.filter(k => meta[k] && meta[k].effect === 'cost');
      const visible = r => (window.AiChat.visibleActs ? window.AiChat.visibleActs(r) : []);
      const onSettings = visible('settings.html');
      const onDirector = visible('director.html');
      const onCanvas = visible('canvas.html');
      const has = (arr, k) => arr.indexOf(k) >= 0;
      return { miss, broken, guard, rejected, n: actIds.length,
        noMeta, orphanMeta, costIds,
        settingsCount: onSettings.length,
        dirLeak: ['select_take', 'cut_timeline', 'undo_edit'].filter(k => has(onSettings, k)),
        cvLeak: ['canvas_undo', 'canvas_nodes_create'].filter(k => has(onDirector, k)),
        dirOnCanvas: ['select_take', 'subtitle_update'].filter(k => has(onCanvas, k)),
        settingsHasGenerate: has(onSettings, 'generate'),
        directorHasOwn: has(onDirector, 'select_take'),
        canvasHasOwn: has(onCanvas, 'canvas_undo') };
    });
    if (out.miss.length) throw new Error('缺少动作：' + out.miss.join(','));
    if (out.broken.length) throw new Error('动作定义不完整：' + out.broken.join(','));
    if (!out.guard || out.guard.err == null) throw new Error('不在导演台时 select_take 没有给出守卫原因');
    if (!/不能大于/.test(out.rejected)) throw new Error('ActionRegistry 没有拒绝越界参数：' + out.rejected);
    if (out.noMeta.length) throw new Error('这些动作没有策略登记（ACTION_META 缺 effect 或 route）：' + out.noMeta.join(',')
      + ' —— 漏 route = 谁都看得见，漏 effect = 花钱的当只读');
    if (out.orphanMeta.length) throw new Error('ACTION_META 里登记了动作面没有的条目：' + out.orphanMeta.join(','));
    const needCost = ['generate', 'media_transcribe', 'canvas_generation_propose'];
    const lostCost = needCost.filter(k => out.costIds.indexOf(k) < 0);
    if (lostCost.length) throw new Error('这几条要花钱的动作没标成 cost：' + lostCost.join(',')
      + ' —— 卡片不画 cancel，出事时没人知道它扣了费');
    if (out.dirLeak.length) throw new Error('设置页的动作清单里还有导演台那几条：' + out.dirLeak.join(',')
      + '（按页过滤没生效 —— 就是报告 §6.2 那个「route 从来没生效过」的坏法）');
    if (out.cvLeak.length) throw new Error('导演台页的清单里混进了画布动作：' + out.cvLeak.join(','));
    if (out.dirOnCanvas.length) throw new Error('画布页的清单里混进了导演台动作：' + out.dirOnCanvas.join(','));
    if (!out.settingsHasGenerate) throw new Error('generate 是全站动作，设置页却看不见它');
    if (!out.directorHasOwn) throw new Error('导演台页看不见 select_take —— route 登记或 visibleActs 读错了');
    if (!out.canvasHasOwn) throw new Error('画布页看不见 canvas_undo —— 同上');
    if (!out.settingsCount) throw new Error('设置页一条动作都没有（清单或策略表空了）');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 助手动作目录通过（' + out.n + ' 个动作；跨页守卫与 schema 拒绝生效；'
      + '策略表齐全，设置页 ' + out.settingsCount + ' 条 · 导演台/画布互不串页）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
