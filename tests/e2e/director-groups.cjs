#!/usr/bin/env node
/* 导演台项目组的浏览器判据：
   · 「我的短片」菜单按组分树（组头 + 组内的短片 + 未分组）；
   · 新建一个组 → 菜单里出现那个组，当前短片落进去；
   · 老工程（没有 groups / groupId）全部落未分组，**不报错**；
   · 删组 → 组里的短片退回未分组，**一条都不少**。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const shot = (id, name) => ({
    id, name, prompt: '画面 ' + name, duration: 5,
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], candidates: [],
  });
  const project = {
    id: 'p-grp', name: '分组探针', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [shot('sh1', '镜头 A')] }],
  };
  let proxy, browser, page;
  let bad = 0;
  const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) bad++; };
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    /* **老工程**：没有 groups、也没有 groupId —— 应当全部落未分组且不报错。 */
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: project.id, roles: [], ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);

    /* ① 打开「我的短片」菜单 */
    await page.eval(() => { const x = document.getElementById('projSwitch'); if (x) x.click(); });
    await page.waitFor(() => !document.getElementById('projMenu').hidden, 10000);

    const tree = await page.eval(() => {
      const m = document.getElementById('projMenu');
      return {
        head: (m.querySelector('.pm-head') || {}).textContent || '',
        groups: Array.from(m.querySelectorAll('.pm-group')).map(g => ({
          name: (g.querySelector('.pm-gname') || {}).textContent || '',
          rows: g.parentNode.querySelectorAll('.pm-row').length,
        })),
        rows: m.querySelectorAll('.pm-row').length,
        adds: Array.from(m.querySelectorAll('.pm-add')).map(a => a.textContent || ''),
      };
    });
    ok(tree.groups.length >= 1, '菜单画出了组头：' + tree.groups.length + ' 个');
    ok(tree.groups.some(g => /未分组/.test(g.name)), '老工程落在「未分组」：' + tree.groups.map(g => g.name).join(' / '));
    ok(tree.rows >= 1, '短片行还在：' + tree.rows);
    ok(tree.adds.some(a => /新建项目组/.test(a)), '有「＋ 新建项目组」那一行：' + tree.adds.join(' | '));

    /* ② 新建一个组（走公共 PromptForm —— 它要用户填名字，这里直接填） */
    await page.eval(() => {
      const rows = Array.from(document.querySelectorAll('#projMenu .pm-add'));
      const g = rows.find(a => /新建项目组/.test(a.textContent || ''));
      if (g) g.click();
    });
    await page.waitFor(() => !!document.querySelector('dialog#pfDlg'), 10000);
    const filled = await page.eval(() => {
      const dlg = document.querySelector('dialog#pfDlg');
      if (!dlg) return { ok: false, why: '没有 #pfDlg' };
      const f = dlg.querySelector('.pf-field');
      const inp = f ? f.querySelector('input,textarea') : null;
      if (!inp) return { ok: false, why: '表单里没有输入框' };
      inp.value = '校园篇';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const okb = dlg.querySelector('#pfOk');
      if (!okb) return { ok: false, why: '没有 #pfOk' };
      okb.click();
      return { ok: true };
    });
    ok(filled.ok, '新建组的表单填了：' + (filled.ok ? '' : filled.why));
    await new Promise(r => setTimeout(r, 1500));

    await page.eval(() => { const x = document.getElementById('projSwitch'); if (x) x.click(); });
    await new Promise(r => setTimeout(r, 400));
    const tree2 = await page.eval(() => {
      const m = document.getElementById('projMenu');
      return {
        groups: Array.from(m.querySelectorAll('.pm-group')).map(g => (g.querySelector('.pm-gname') || {}).textContent || ''),
        rows: m.querySelectorAll('.pm-row').length,
      };
    });
    ok(tree2.groups.some(g => /校园篇/.test(g)), '新组出现在菜单里：' + tree2.groups.join(' / '));

    /* ③ 组里的短片确实在那个组下（行数不变 —— 短片一条都没少） */
    ok(tree2.rows >= 1, '短片一条都没少：' + tree2.rows);

    /* ④ 删组 → 短片退回未分组，一条都不少 */
    const del = await page.eval(() => {
      const g = Array.from(document.querySelectorAll('#projMenu .pm-group')).find(x => /校园篇/.test(x.textContent || ''));
      if (!g) return 'no-group';
      const b = g.querySelector('[data-gdel]');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked';
    });
    ok(del === 'clicked', '删组那颗按钮在：' + del);
    /* 二次确认（公共 Confirm 弹窗：dialog#cfDlg，确定键在 #cfFoot 里） */
    await page.waitFor(() => !!document.querySelector('dialog#cfDlg'), 8000);
    const confirmed = await page.eval(() => {
      const dlg = document.querySelector('dialog#cfDlg');
      if (!dlg) return { ok: false, why: '没有 #cfDlg' };
      const foot = dlg.querySelector('#cfFoot');
      const btns = foot ? Array.from(foot.querySelectorAll('button')) : [];
      const okb = btns.find(b => /删掉这个组|删除|确定/.test(b.textContent || ''));
      if (!okb) return { ok: false, why: '确认框里没有确定键：' + btns.map(b => b.textContent).join('/') };
      okb.click();
      return { ok: true };
    });
    ok(confirmed.ok, '确认框点掉了：' + (confirmed.ok ? '' : confirmed.why));
    await new Promise(r => setTimeout(r, 1500));
    await page.eval(() => { const x = document.getElementById('projSwitch'); if (x) x.click(); });
    await new Promise(r => setTimeout(r, 400));
    const tree3 = await page.eval(() => {
      const m = document.getElementById('projMenu');
      return {
        groups: Array.from(m.querySelectorAll('.pm-group')).map(g => (g.querySelector('.pm-gname') || {}).textContent || ''),
        rows: m.querySelectorAll('.pm-row').length,
      };
    });
    ok(!tree3.groups.some(g => /校园篇/.test(g)), '组删掉了：' + tree3.groups.join(' / '));
    ok(tree3.rows >= 1, '短片退回未分组，一条都没少：' + tree3.rows);

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log(bad ? '\n✗ ' + bad + ' 项未通过' : '\n✓ 导演台项目组：分树 / 新建 / 老工程零迁移 / 删组不删短片');
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
