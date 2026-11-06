#!/usr/bin/env node
/* 导演台项目组的浏览器判据：
   · 短片菜单按组分树（组头 + 组内的短片 + 未分组）；
   · 老工程（没有 groups / groupId）全部落未分组，**不报错**；
   · 菜单里的每一步都在原地做完，不弹表单窗也不弹确认框：
     - 新建组 = 菜单里的草稿行（填名字 + 建组 / 取消），点完菜单不许自己收掉；
     - 改名 = 名称那一格当场换成输入框（短片与组都是）；
     - 移组 = 那一行下面摊开一个下拉（公共 Dropdowns），选一处就归位；
     - 删除 = 公共 `Confirm.arm` 就地二次确认，第一下只武装、第二下才动手；
   · 删组 → 组里的短片退回未分组，**一条都不少**；删短片只删点中的那一部。 */
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
  /* 第二部短片只给「删短片」那一档用：删掉它，眼前这一部必须还在。 */
  const project2 = {
    id: 'p-del', name: '待删短片', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc2', name: '场景 1', shots: [shot('sh2', '镜头 B')] }],
  };
  let proxy, browser, page;
  let bad = 0;
  const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) bad++; };
  /* 页头那颗是开关：菜单已经开着时再点一次会把它关掉，所以「确保开着」才点。 */
  const openMenu = () => page.eval(() => {
    const m = document.getElementById('projMenu');
    if (m.hidden) document.getElementById('projSwitch').click();
    return !m.hidden;
  });
  /* 「就地做完」的判据就是这一条：菜单里任何时候都不该有开着的弹层。 */
  const popups = () => page.eval(() => document.querySelectorAll('dialog[open]').length);
  /* 菜单那一屏的形状：短片行是组头的兄弟节点，按顺序归到上一组头下面。 */
  const snapshot = () => page.eval(() => {
    const m = document.getElementById('projMenu');
    const out = { groups: [], rows: [], adds: [], edit: 0, move: 0, newg: 0, note: 0, armed: 0 };
    let cur = null;
    Array.from(m.children).forEach(el => {
      if (el.classList.contains('pm-group')) {
        cur = { name: ((el.querySelector('.pm-gname') || {}).textContent || '').trim(), rows: [] };
        out.groups.push(cur);
      } else if (el.classList.contains('pm-row')) {
        const r = { id: el.getAttribute('data-id'), name: ((el.querySelector('.pm-name') || {}).textContent || '').trim(),
          inGroup: el.classList.contains('pm-in-group'), edit: !!el.querySelector('.pm-edit') };
        out.rows.push(r);
        if (cur) cur.rows.push(r.id);
        if (r.edit) out.edit++;
      } else if (el.classList.contains('pm-move')) out.move++;
      else if (el.classList.contains('pm-newg')) out.newg++;
      else if (el.classList.contains('pm-note')) out.note++;
      else if (el.classList.contains('pm-add')) out.adds.push((el.textContent || '').trim());
    });
    out.armed = m.querySelectorAll('.pm-btn.armed').length;
    return out;
  });
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    /* **老工程**：没有 groups、也没有 groupId —— 应当全部落未分组且不报错。 */
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project, project2], curId: project.id, roles: [], ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);

    /* ① 打开短片菜单 */
    ok(await openMenu(), '菜单打开了');
    const tree = await snapshot();
    ok(tree.groups.length >= 1, '菜单画出了组头：' + tree.groups.length + ' 个');
    ok(tree.groups.some(g => /未分组/.test(g.name)), '老工程落在「未分组」：' + tree.groups.map(g => g.name).join(' / '));
    ok(tree.rows.length >= 2, '两部短片都在行里：' + tree.rows.length);
    ok(tree.adds.some(a => /新建项目组/.test(a)), '有「＋ 新建项目组」那一行：' + tree.adds.join(' | '));

    /* ② 新建组：点那一行 → 就地草稿行（输入框 + 建组 / 取消），不弹表单窗。
       这一击是「菜单重画之后全局 click 监听别再把自己当成点到外面」的判据：
       事件派发到 document 时，被点的那个 div 已经从文档上摘下来了。 */
    await page.eval(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const g = Array.from(document.querySelectorAll('#projMenu .pm-add')).find(a => /新建项目组/.test(a.textContent || ''));
      if (g) g.click();
      await sleep(150);
    });
    const draft = await page.eval(() => {
      const box = document.querySelector('#projMenu .pm-newg');
      return { has: !!box, inp: !!(box && box.querySelector('.pm-edit')),
        menuOpen: !document.getElementById('projMenu').hidden,
        focused: !!(box && document.activeElement === box.querySelector('.pm-edit')),
        btns: box ? Array.from(box.querySelectorAll('button')).map(b => (b.textContent || '').trim()) : [],
        popups: document.querySelectorAll('dialog[open]').length };
    });
    ok(draft.has && draft.inp, '新建组在菜单里就地摊开了：' + draft.btns.join(' / '));
    ok(draft.menuOpen, '点「新建项目组」之后菜单仍然开着（重画过的菜单不把自己收掉）');
    ok(draft.focused, '焦点直接进了那一格名称输入框');
    ok(draft.popups === 0, '新建组没有弹表单窗');
    await page.eval(() => {
      const box = document.querySelector('#projMenu .pm-newg');
      box.querySelector('.pm-edit').value = '校园篇';
      Array.from(box.querySelectorAll('button')).find(b => /建组/.test(b.textContent || '')).click();
    });
    await new Promise(r => setTimeout(r, 1200));
    const tree2 = await snapshot();
    ok(tree2.groups.some(g => /校园篇/.test(g.name)), '新组出现在菜单里：' + tree2.groups.map(g => g.name).join(' / '));
    /* ③ 组里的短片确实在那个组下（短片一条都没少），且默认归进去的是当前那一部 */
    ok(tree2.rows.length >= 2, '短片一条都没少：' + tree2.rows.length);
    ok(tree2.rows.filter(r => r.inGroup).length === 1, '当前短片被归进了新组：' + tree2.rows.filter(r => r.inGroup).map(r => r.id).join(','));
    ok(tree2.newg === 0, '建完组那一行草稿收回了');

    /* ④ 就地改短片名：点铅笔 → 名称那一格当场换成输入框 → 保存 */
    const renamed = await page.eval(() => {
      const row = document.querySelector('#projMenu .pm-row[data-id="p-grp"]');
      row.querySelector('[data-rename]').click();
      const inp = document.querySelector('#projMenu .pm-row[data-id="p-grp"] .pm-edit');
      if (!inp) return { has: false };
      inp.value = '分组探针（改过）';
      Array.from(inp.parentNode.querySelectorAll('button')).find(b => /保存/.test(b.textContent || '')).click();
      return { has: true, popups: document.querySelectorAll('dialog[open]').length };
    });
    ok(renamed.has, '短片名那一格当场变成了输入框');
    ok(renamed.popups === 0, '改名没有弹表单窗');
    await new Promise(r => setTimeout(r, 800));
    const afterRename = await page.eval(() => ({
      row: ((document.querySelector('#projMenu .pm-row[data-id="p-grp"] .pm-name') || {}).textContent || '').trim(),
      head: ((document.getElementById('projLabel') || {}).textContent || '').trim(),
    }));
    ok(/改过/.test(afterRename.row), '行上的名字换了：' + afterRename.row);
    ok(/改过/.test(afterRename.head), '页头那一格念的是当前短片名：' + afterRename.head);

    /* ⑤ 就地改组名 */
    await page.eval(() => {
      const g = Array.from(document.querySelectorAll('#projMenu .pm-group')).find(x => /校园篇/.test(x.textContent || ''));
      g.querySelector('[data-grename]').click();
      const inp = document.querySelector('#projMenu .pm-group .pm-edit');
      inp.value = '校园篇·上';
      Array.from(inp.parentNode.querySelectorAll('button')).find(b => /保存/.test(b.textContent || '')).click();
    });
    await new Promise(r => setTimeout(r, 800));
    const tree5 = await snapshot();
    ok(tree5.groups.some(g => /校园篇·上/.test(g.name)), '组名就地换了：' + tree5.groups.map(g => g.name).join(' / '));

    /* ⑥ 就地移组：点文件夹 → 那一行下面摊开一个下拉（公共 Dropdowns，浮层直接打开）
       → 从浮层里点「未分组」。判据盯三件事：候选取自组名单、选完归位、菜单不跟着收掉。 */
    const moved = await page.eval(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const menu = document.getElementById('projMenu');
      document.querySelector('#projMenu .pm-row[data-id="p-grp"] [data-move]').click();
      await sleep(150);
      const box = menu.querySelector('.pm-move');
      if (!box) return { has: false };
      const sel = box.querySelector('select');
      const dd = box.querySelector('.dd');
      const list = dd && dd._ddList;
      const opts = sel ? Array.from(sel.options).map(o => (o.textContent || '').trim()) : [];
      const opened = !!(dd && dd.classList.contains('open') && list && list.classList.contains('on'));
      const target = list && Array.from(list.querySelectorAll('.dd-opt')).find(b => /未分组/.test(b.textContent || ''));
      if (target) target.click();
      return { has: true, opts, opened, menuOpen: !menu.hidden,
        listOpen: !!document.querySelector('.dd-list.on'),
        popups: document.querySelectorAll('dialog[open]').length };
    });
    ok(moved.has, '移组在那一行下面摊开了一个下拉：' + (moved.opts || []).join(' / '));
    ok(moved.opened, '下拉随那一行一起打开（点文件夹就是来看去哪一组的）');
    ok(moved.popups === 0, '移组没有弹选择窗');
    ok(moved.menuOpen, '移完之后菜单仍然开着');
    ok(!moved.listOpen, '选完那一格，下拉浮层收回了');
    await new Promise(r => setTimeout(r, 800));
    const tree6 = await snapshot();
    ok(tree6.rows.filter(r => r.inGroup).length === 0, '两部短片都退回未分组：' + tree6.rows.map(r => r.id + (r.inGroup ? '(组内)' : '(未分组)')).join(' '));
    ok(tree6.move === 0, '移完那一行收回了');

    /* ⑦ 删组：第一下只武装（不弹确认框），第二下才真删 */
    const armGroup = await page.eval(() => {
      const g = Array.from(document.querySelectorAll('#projMenu .pm-group')).find(x => /校园篇·上/.test(x.textContent || ''));
      if (!g) return { found: false };
      const b = g.querySelector('[data-gdel]');
      b.click();
      return { found: true, armed: b.classList.contains('armed'), text: (b.textContent || '').trim(),
        popups: document.querySelectorAll('dialog[open]').length };
    });
    ok(armGroup.found, '改名后的那一组还在菜单里');
    ok(armGroup.armed, '第一下只是武装：按钮变成「' + armGroup.text + '」');
    ok(armGroup.popups === 0, '删组没有弹确认框');
    await page.eval(() => {
      const g = Array.from(document.querySelectorAll('#projMenu .pm-group')).find(x => /校园篇·上/.test(x.textContent || ''));
      g.querySelector('[data-gdel]').click();
    });
    await new Promise(r => setTimeout(r, 1200));
    const tree7 = await snapshot();
    ok(!tree7.groups.some(g => /校园篇/.test(g.name)), '组删掉了：' + tree7.groups.map(g => g.name).join(' / '));
    ok(tree7.rows.length >= 2, '短片退回未分组，一条都没少：' + tree7.rows.length);

    /* ⑧ 删短片：同样就地二次确认，删掉的只有点中的那一部 */
    const armDel = await page.eval(() => {
      const b = document.querySelector('#projMenu .pm-row[data-id="p-del"] [data-del]');
      if (!b) return { found: false };
      b.click();
      return { found: true, armed: b.classList.contains('armed'), popups: document.querySelectorAll('dialog[open]').length };
    });
    ok(armDel.found && armDel.armed, '删短片第一下武装');
    ok(armDel.popups === 0, '删短片没有弹确认框');
    await page.eval(() => document.querySelector('#projMenu .pm-row[data-id="p-del"] [data-del]').click());
    await new Promise(r => setTimeout(r, 1200));
    const tree8 = await snapshot();
    ok(!tree8.rows.some(r => r.id === 'p-del'), '点中的那一部删掉了');
    ok(tree8.rows.some(r => r.id === 'p-grp'), '另一部没被牵连：' + tree8.rows.map(r => r.id).join(','));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log(bad ? '\n✗ ' + bad + ' 项未通过' : '\n✓ 导演台项目组：分树 / 就地新建 / 就地改名 / 就地移组 / 就地二次确认删除 / 老工程零迁移');
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
