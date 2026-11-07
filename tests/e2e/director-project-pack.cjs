#!/usr/bin/env node
/* 导演台「项目文件」的浏览器判据（页头短片下拉底部那一组入口）：
   · 默认折叠；摊开后两颗**同级**入口（导出拆分按钮 / 导入项目文件），整组缩进在一条竖线里、
     用正文色而不是强调色；
   · 导出主钮导当前短片，尾钮摊开「导出当前项目组短片」「导出全部短片」两种更大范围；
     当前短片没归组时那一格标成不可用；
   · 导出包里带全部候选（含没选用 / 失败）、提示词、台词与成片轨，运行时地址不带出去；
   · 项目组随包往返但只认组名；组名撞车要先问「并入现有同名组 / 给导入的组改名」，
     本机没有同名组则直接新建；
   · 内容与本机某部完全一致的短片要先问「跳过 / 照导并重命名」，全跳过时一部都不写；
   · 导入走「追加为新短片」：撞 id / 撞名字都不覆盖现有作品，确认框先把差异说清楚；
   · 全程没有一个页面异常。
   纯格式判据在 tests/director-project-pack.mjs，这一条只验「按钮真能点、数据真来回」。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page;
  let bad = 0, n = 0;
  const ok = (cond, msg) => { n++; console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) bad++; };
  const project = {
    id: 'p-pack', name: '项目文件探针', curScene: 0, curShot: 0,
    composition: { width: 1920, height: 1080 },
    film: {
      clips: [{ id: 'cl1', shotId: 'sh1', candId: 'v1', duration: 5 }],
      voices: [{ id: 'vo1', text: '旁白', duration: 2 }],
      captions: [{ id: 'cp1', text: '字幕', start: 0, duration: 1 }],
      markers: [], tracks: { visibility: {}, locks: {} },
    },
    scenes: [{
      id: 'sc1', name: '场景 1',
      shots: [{
        id: 'sh1', name: '镜头 A', prompt: '晨雾里的木栈道', line: '我们走吧', note: '画面说明',
        ar: '16:9', res: '768p', tier: 'fast', draw: 1, selId: 'v1',
        refImages: [], keyframes: [],
        candidates: [
          { vid: 'v1', status: 'succeeded', url: '/asset/vid-1', prompt: '晨雾里的木栈道',
            selected: true, locked: true, trimS: 0.3, trimE: 4.5 },
          { vid: 'v2', status: 'failed', url: '', prompt: '另一种写法', error: '额度不足' },
          { vid: 'v3', status: 'draft', url: null, prompt: '' },
        ],
      }],
    }],
  };
  /* 三部短片：两部在「默认组」里、一部未归组 —— 三种导出范围因此数得出差别：
     当前 = 1 部、工作区全部 = 3 部、当前项目组 = 2 部。 */
  const GROUP = { id: 'g1', name: '默认组' };
  project.groupId = GROUP.id;
  const cloneProject = (id, name, groupId) => {
    const p = JSON.parse(JSON.stringify(project));
    p.id = id; p.name = name; p.groupId = groupId || '';
    return p;
  };
  const projectB = cloneProject('p-pack-2', '同组第二部', GROUP.id);
  const projectC = cloneProject('p-pack-3', '未归组那部');
  const openMenu = () => page.eval(() => {
    const m = document.getElementById('projMenu');
    if (m.hidden) document.getElementById('projSwitch').click();
    return !m.hidden;
  });
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project, projectB, projectC], curId: project.id, roles: [], groups: [GROUP],
        ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);

    /* ① 底部「项目文件」默认折叠；摊开后 = 两颗同级入口：导出（拆分按钮）与导入项目文件。 */
    ok(await openMenu(), '短片菜单打开了');
    const collapsed = await page.eval(() => {
      const box = document.querySelector('#projMenu .pm-io-box');
      const t = box && box.querySelector('.pm-io-toggle');
      return { has: !!box, expanded: t ? t.getAttribute('aria-expanded') : '',
        label: t ? (t.textContent || '').trim() : '',
        rows: box ? box.querySelectorAll('.pm-io').length : -1,
        split: !!(box && box.querySelector('.pm-io-split')),
        sub: !!(box && box.querySelector('.pm-io-sub')) };
    });
    ok(collapsed.has && collapsed.expanded === 'false' && collapsed.rows === 0
      && !collapsed.split && !collapsed.sub,
      '默认折叠：底部只留一行开关，没有摊开的入口：' + JSON.stringify(collapsed));
    ok(!/全部候选 \/ 提示词 \/ 剪辑状态/.test(collapsed.label) && !/视频字节不在包里/.test(collapsed.label),
      '被要求删掉的那两段说明没有留在菜单里');
    const expanded = await page.eval(async () => {
      document.querySelector('#projMenu .pm-io-toggle').click();
      await new Promise(r => setTimeout(r, 100));
      const box = document.querySelector('#projMenu .pm-io-box');
      const more = box.querySelector('.pm-io-more');
      return {
        expanded: box.querySelector('.pm-io-toggle').getAttribute('aria-expanded'),
        top: Array.from(box.querySelectorAll(':scope > .pm-io-body > .pm-io')).map(x => (x.textContent || '').trim()),
        main: ((box.querySelector('.pm-io-split .pm-io-main') || {}).textContent || '').trim(),
        moreOpen: more ? more.getAttribute('aria-expanded') : 'missing',
        sub: !!box.querySelector('.pm-io-sub'),
        notes: (box.textContent || ''),
      };
    });
    ok(expanded.expanded === 'true' && expanded.top.length === 2,
      '点开关后摊开两颗同级入口：' + expanded.top.join(' | '));
    ok(/导出当前短片/.test(expanded.main), '第一颗是导出的主钮「导出当前短片」：' + expanded.main);
    ok(expanded.moreOpen === 'false', '导出行尾有独立的下拉热区，默认收起：' + expanded.moreOpen);
    ok(/导入项目文件/.test(expanded.top[1] || '') && !expanded.sub,
      '第二颗是「导入项目文件」，与导出一级、次级默认收起：' + expanded.top[1]);
    ok(!/视频字节不在包里|全部候选 \/ 提示词 \/ 剪辑状态/.test(expanded.notes),
      '摊开之后也没有那两段说明');
    /* 层级与配色：摊开的入口缩进在一条竖线里、用正文色（不是强调色）——
       得看得出它们长在「项目文件 · 导入 / 导出」下面，而不是与上面那串短片行同级。 */
    const look = await page.eval(() => {
      const box = document.querySelector('#projMenu .pm-io-box');
      const toggle = box.querySelector('.pm-io-toggle');
      const body = box.querySelector('.pm-io-body');
      const row = body && body.querySelector('.pm-io');
      const probe = document.createElement('span');
      probe.style.color = 'var(--acc)';
      document.body.appendChild(probe);
      const acc = getComputedStyle(probe).color;
      probe.remove();
      return {
        hasBody: !!body,
        indent: (body && row)
          ? Math.round(row.getBoundingClientRect().left - toggle.getBoundingClientRect().left) : -1,
        rail: body ? getComputedStyle(body).borderLeftWidth : '',
        rowColor: row ? getComputedStyle(row).color : '',
        acc,
      };
    });
    ok(look.hasBody && look.indent >= 8 && look.rail !== '0px',
      '摊开的入口缩进在一条竖线里（看得出长在「项目文件」下面）：' + JSON.stringify(look));
    ok(!!look.rowColor && look.rowColor !== look.acc,
      '项目文件里的入口还在用强调色：' + JSON.stringify(look));

    /* 尾钮摊开两种**更大范围**的导出；每次导出后菜单都会被收起，所以每次都要重新摊开。 */
    const splitOpen = await page.eval(async () => {
      document.querySelector('#projMenu .pm-io-more').click();
      await new Promise(r => setTimeout(r, 100));
      const box = document.querySelector('#projMenu .pm-io-box');
      return {
        moreOpen: document.querySelector('#projMenu .pm-io-more').getAttribute('aria-expanded'),
        rows: Array.from(box.querySelectorAll('.pm-io-sub .pm-io')).map(x => (x.textContent || '').trim()),
      };
    });
    ok(splitOpen.moreOpen === 'true' && splitOpen.rows.length === 2,
      '尾钮摊开两种更宽范围：' + splitOpen.rows.join(' | '));
    ok(/导出当前项目组短片/.test(splitOpen.rows[0] || '') && /默认组/.test(splitOpen.rows[0] || '')
      && /2 部/.test(splitOpen.rows[0] || ''),
      '第一格是「导出当前项目组短片」，带组名与本组部数：' + splitOpen.rows[0]);
    ok(/导出全部短片/.test(splitOpen.rows[1] || '') && /3 部/.test(splitOpen.rows[1] || ''),
      '第二格是「导出全部短片」，提示是工作区总数（窄范围在前）：' + splitOpen.rows[1]);

    const openIO = (split) => page.eval(async want => {
      const m = document.getElementById('projMenu');
      if (m.hidden) { document.getElementById('projSwitch').click(); await new Promise(r => setTimeout(r, 80)); }
      const t = document.querySelector('#projMenu .pm-io-toggle');
      if (t && t.getAttribute('aria-expanded') === 'false') { t.click(); await new Promise(r => setTimeout(r, 80)); }
      const more = document.querySelector('#projMenu .pm-io-more');
      if (want && more && more.getAttribute('aria-expanded') === 'false') {
        more.click(); await new Promise(r => setTimeout(r, 80));
      }
      return !!more;
    }, split);
    const exportSub = (idx) => page.eval(async i => {
      window.__packCapture = null;
      const row = document.querySelectorAll('#projMenu .pm-io-sub .pm-io')[i];
      if (!row) throw new Error('找不到拆分按钮摊开的第 ' + (i + 1) + ' 格');
      row.click();
      await new Promise(r => setTimeout(r, 150));
      const c = window.__packCapture;
      return c ? { name: c.name, json: await c.blob.text() } : null;
    }, idx);

    /* ② 导出当前短片：主钮点下去只带当前这一部。把 Net.save 截下来读字节，不真触发下载。 */
    await page.eval(() => {
      window.__packCapture = null;
      window.Net.save = (blob, name) => { window.__packCapture = { blob, name }; };
    });
    await page.eval(() => {
      const row = document.querySelector('#projMenu .pm-io-split .pm-io-main');
      if (!row) throw new Error('找不到导出当前短片那颗主钮');
      row.click();
    });
    const got = await page.eval(async () => {
      const c = window.__packCapture;
      return c ? { name: c.name, json: await c.blob.text() } : null;
    });
    ok(!!got && /\.json$/.test(got.name || ''), '导出交出了一份 .json：' + (got && got.name));
    let pack = null;
    try { pack = JSON.parse(got.json); } catch (e) { /* 下面统一报 */ }
    ok(!!pack && pack.type === 'ai-workbench-director-project' && pack.version === 1,
      '包类型 / 格式版本对得上');
    const p = pack && pack.projects && pack.projects[0];
    ok(!!p && p.scenes[0].shots[0].candidates.length === 3, '没选用 / 失败 / 草稿三条候选全在包里');
    const cs = p ? p.scenes[0].shots[0].candidates : [];
    /* 中栏的 sortCandidates 会把候选排成「有画面 / 草稿 / 失败」，导出带的是排好序的当前状态，
       所以按 vid 认人，不按下标认。 */
    const byVid = vid => cs.find(c => c && c.vid === vid) || {};
    ok(p && p.scenes[0].shots[0].prompt === '晨雾里的木栈道'
      && p.scenes[0].shots[0].line === '我们走吧' && byVid('v2').prompt === '另一种写法',
      '镜头提示词 / 台词 / 候选提示词都在包里：' + (p ? JSON.stringify({
        prompt: p.scenes[0].shots[0].prompt, line: p.scenes[0].shots[0].line,
        cands: cs.map(c => c.prompt) }) : 'no project'));
    ok(p && byVid('v1').selected === true && byVid('v1').trimS === 0.3 && byVid('v1').locked === true,
      '选用与裁剪状态都在包里');
    ok(p && p.film.clips.length === 1 && p.film.voices.length === 1 && p.film.captions.length === 1,
      '成片轨（画面 / 配音 / 字幕）都在包里');
    ok(p && p.curScene === undefined && p.curShot === undefined, '视口游标没被带出去');
    ok(!!pack && !!pack.checksum && pack.stats.candidates === 3, '包里带校验和与摘要数');

    /* ③ 尾钮摊开的两种范围：当前项目组 = 同组那两部；全部 = 工作区三部。 */
    await openIO(true);
    const grpPack = await exportSub(0);
    let grp = null;
    try { grp = grpPack && JSON.parse(grpPack.json); } catch (e) { /* 下面统一报 */ }
    const grpNames = grp ? grp.projects.map(x => x.name).sort() : [];
    ok(grpNames.join('|') === '同组第二部|项目文件探针',
      '「导出当前项目组短片」只收同组那两部：' + (grpNames.join(' | ') || 'null'));
    ok(!!grpPack && /默认组-项目-/.test(grpPack.name || ''),
      '按组导出的文件名带组名：' + (grpPack && grpPack.name));
    ok(!!grp && grp.projects.every(x => x.groupName === '默认组' && x.groupId === undefined),
      '按组导出：组名要带上、组 id 不许带出去：'
      + JSON.stringify(grp && grp.projects.map(x => ({ name: x.name, groupName: x.groupName, groupId: x.groupId }))));

    await openIO(true);
    const allPack0 = await exportSub(1);
    let all0 = null;
    try { all0 = allPack0 && JSON.parse(allPack0.json); } catch (e) { /* 下面统一报 */ }
    ok(!!all0 && all0.projects.length === 3,
      '「导出全部短片」带的是工作区三部，不是只导当前：' + (all0 ? all0.projects.length : 'null'));
    ok(!!allPack0 && /全部短片/.test(allPack0.name || ''),
      '全部那份的文件名是「全部短片」：' + (allPack0 && allPack0.name));
    ok(!!all0 && all0.projects.filter(x => x.groupName === '默认组').length === 2
      && all0.projects.some(x => x.groupName === ''),
      '导出全部时每部短片各自带自己的组名（未归组的就空着）：'
      + JSON.stringify(all0 && all0.projects.map(x => ({ name: x.name, groupName: x.groupName }))));

    /* ---- 导入的公共走法 ----
       一道导入最多连着弹三窗：内容完全一致（跳过 / 照导）、项目组重名（并入 / 改名）、
       最后才是「追加为新短片」那一道确认。按标题认窗、按选择点按钮，
       顺便把每一窗的原话收回来给断言用。 */
    const clickInDialog = pattern => page.eval(p => {
      const d = document.querySelector('dialog[open]');
      if (!d) return '';
      const b = Array.from(d.querySelectorAll('button'))
        .find(x => new RegExp(p).test(x.textContent || ''));
      if (!b) return '';
      const label = (b.textContent || '').trim();
      b.click();
      return label;
    }, String(pattern));
    const statusText = () => page.eval(() => (document.getElementById('opState') || {}).textContent || '');
    const runImport = async (json, fileName, opt) => {
      const o = opt || {};
      const beforeN = await page.eval(() => document.querySelectorAll('#projMenu .pm-row').length);
      await page.eval(async (j, nm) => {
        const inp = document.getElementById('projPackFile');
        if (!inp) throw new Error('项目文件选择器不在页面上');
        const dt = new DataTransfer();
        dt.items.add(new File([j], nm, { type: 'application/json' }));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
      }, json, fileName);
      const seen = { dup: '', group: '', confirm: '', picks: [] };
      let answered = 0;
      for (let guard = 0; guard < 5; guard++) {
        try {
          await page.waitFor(() => !!document.querySelector('dialog[open]'), answered ? 2500 : 8000);
        } catch (e) {
          /* 答过至少一窗之后就没下文了：全跳过那条路本来就没有「追加为新短片」那一道。 */
          if (answered) break;
          const dbg = await page.eval(() => ({
            banner: (document.getElementById('banner') || {}).textContent || '',
            op: (document.getElementById('opState') || {}).textContent || '',
            rows: document.querySelectorAll('#projMenu .pm-row').length,
          }));
          throw new Error('等待导入弹窗超时：' + JSON.stringify(dbg)
            + ' / 页面异常：' + ((page.errors || []).slice(-3).join(' | ') || '（无）'));
        }
        answered++;
        const dlg = await page.eval(() => {
          const d = document.querySelector('dialog[open]');
          return { title: ((d.querySelector('.pr-head b') || {}).textContent || '').trim(),
            text: (d.textContent || '') };
        });
        if (/内容完全一致/.test(dlg.title)) {
          seen.dup = dlg.text;
          seen.picks.push(await clickInDialog(o.dup === 'skip' ? '跳过这' : '仍然导入并重命名'));
          continue;
        }
        if (/项目组重名/.test(dlg.title)) {
          seen.group = dlg.text;
          seen.picks.push(await clickInDialog(o.group === 'rename' ? '给导入的组改名' : '并入现有同名组'));
          continue;
        }
        if (/导入项目文件/.test(dlg.title)) {
          seen.confirm = dlg.text;
          seen.picks.push(await clickInDialog('追加为新短片'));
          break;
        }
        throw new Error('导入时弹出了不认识的窗：' + dlg.title);
      }
      if (o.add) {
        await page.waitFor(n => document.querySelectorAll('#projMenu .pm-row').length === n,
          10000, 100, beforeN + o.add);
      } else {
        await page.eval(() => new Promise(r => setTimeout(r, 400)));
      }
      const afterN = await page.eval(() => document.querySelectorAll('#projMenu .pm-row').length);
      return { seen, beforeN, afterN };
    };

    /* ④ 导入：直接把那份包塞进菜单外的选择器，走与点按钮之后同一条 onchange。
       包里的 id / 名字与本机现有短片撞车、内容也和本机那部一模一样 ——
       所以先问「重复的要不要再来一份」，答「照导」才是那道「追加、不覆盖」的确认。 */
    const before = await page.eval(() => Array.from(document.querySelectorAll('#projMenu .pm-row .pm-name'))
      .map(x => (x.textContent || '').trim()));
    const first = await runImport(got.json, 'probe.json', { dup: 'rename', add: 1 });
    ok(/有内容完全一致/.test(first.seen.dup) && /项目文件探针/.test(first.seen.dup),
      '导入前先问「内容完全一致的那部要不要再来一份」：'
      + first.seen.dup.replace(/\s+/g, ' ').slice(0, 110));
    ok(/项目文件 v1/.test(first.seen.confirm) && /3 条候选/.test(first.seen.confirm)
      && /不覆盖现有项目/.test(first.seen.confirm),
      '确认框说清了带什么、不动什么：' + first.seen.confirm.replace(/\s+/g, ' ').slice(0, 90));
    ok(first.afterN === before.length + 1, '选「照导」之后多了一部短片：' + before.length + ' → ' + first.afterN);
    await openMenu();
    const after = await page.eval(() => Array.from(document.querySelectorAll('#projMenu .pm-row .pm-name'))
      .map(x => (x.textContent || '').trim()));
    ok(after.length === before.length + 1, '导入后多了一部短片：' + after.join(' | '));
    ok(after.some(x => /项目文件探针（导入）/.test(x)), '撞名字的那部加了后缀，原短片没被覆盖：' + after.join(' | '));
    ok(after.some(x => /项目文件探针(?!（导入）)/.test(x)), '原来的那部还在');

    /* ⑤ 坏包零写入：改一个字再导一次，确认框不许出现、短片数不许变。 */
    const tampered = JSON.parse(got.json);
    tampered.projects[0].scenes[0].shots[0].prompt = '被改坏的一个字';
    await page.eval(async json => {
      const inp = document.getElementById('projPackFile');
      const dt = new DataTransfer();
      dt.items.add(new File([json], 'bad.json', { type: 'application/json' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    }, JSON.stringify(tampered));
    const rejected = await page.eval(() => ({
      dlg: !!document.querySelector('dialog[open]'),
      rows: document.querySelectorAll('#projMenu .pm-row').length,
      banner: (document.getElementById('banner') || {}).textContent || '',
    }));
    ok(!rejected.dlg && rejected.rows === after.length, '校验和对不上：确认框没弹、短片数没变（零写入）');
    ok(/校验和对不上/.test(rejected.banner), '拒绝原因写进了错误横幅：' + rejected.banner.replace(/\s+/g, ' ').slice(0, 80));

    /* ⑥ 导入之后再从尾钮导一次全部：工作区现在有四部，包里也得有四部。 */
    ok(await openIO(true), '导出拆分按钮又能摊开');
    const allPack = await exportSub(1);
    let all = null;
    try { all = allPack && JSON.parse(allPack.json); } catch (e) { /* 下面统一报 */ }
    ok(!!allPack && /全部短片/.test(allPack.name || ''), '导出全部交出了一份整包 .json：' + (allPack && allPack.name));
    ok(!!all && all.projects.length === after.length,
      '包里是全部 ' + after.length + ' 部短片，不是只导当前：' + (all ? all.projects.length : 'null'));

    /* ⑦ 项目组随包往返但**只认组名**：
       · 先把包里的组 id 换成这台机器上没有的一枚（组名仍是「默认组」）—— 认 id 会退回未分组，
         认名字才轮得到「并入还是改名」那一问；
       · 再把组名换成一个本机没有的名字 —— 这时不必问，直接现建一个组。 */
    const { projectPackChecksum } = await import('../../web/director/project-pack.js');
    const menuTree = () => page.eval(() => {
      const menu = document.getElementById('projMenu');
      const out = [];
      let cur = null;
      for (const el of menu.children) {
        if (el.classList.contains('pm-group')) {
          cur = { name: ((el.querySelector('.pm-gname') || {}).textContent || '').trim(),
            cnt: ((el.querySelector('.pm-cnt') || {}).textContent || '').trim(), rows: [] };
          out.push(cur);
        } else if (el.classList.contains('pm-row') && cur) {
          cur.rows.push(((el.querySelector('.pm-name') || {}).textContent || '').trim());
        }
      }
      return out;
    });
    /* 成功回执走工具栏那行小字（`#opState`），横幅只留错误 —— 别拿横幅读成功消息。 */

    /* ⑦-1 组名撞车选「并入」：组 id 是别的机器的，组名不变。 */
    const foreignPack = JSON.parse(grpPack.json);
    foreignPack.projects.forEach(x => { x.groupId = 'g-from-another-machine'; });
    foreignPack.checksum = projectPackChecksum(JSON.stringify(foreignPack.projects));
    const joinRes = await runImport(JSON.stringify(foreignPack), 'foreign-group.json', { add: 2 });
    ok(/内容完全一致/.test(joinRes.seen.dup), '包里这两部本机也有，重复那一问先出现：'
      + joinRes.seen.dup.replace(/\s+/g, ' ').slice(0, 100));
    ok(/项目组重名/.test(joinRes.seen.group) && /默认组/.test(joinRes.seen.group),
      '组名撞车时先问怎么落位：' + joinRes.seen.group.replace(/\s+/g, ' ').slice(0, 120));
    await openMenu();
    const treeJoin = await menuTree();
    const gDefault = treeJoin.filter(g => g.name === '默认组');
    ok(gDefault.length === 1, '同名组没有重复建出一个：' + JSON.stringify(treeJoin.map(g => g.name)));
    ok(gDefault.length === 1 && /5 部/.test(gDefault[0].cnt),
      '同名的两部并进了现有「默认组」，组里成 5 部：' + (gDefault[0] && gDefault[0].cnt));
    /* 行文本是「名字 · N 镜」，比名字先剥掉后面那截。 */
    const joinNames = gDefault.length === 1 ? gDefault[0].rows.map(x => x.split(' · ')[0]) : [];
    ok(joinNames.includes('项目文件探针（导入）') && joinNames.includes('项目文件探针（导入 2）'),
      '认的是组名而不是包里的组 id；撞名短片接着往后编号、不和上次重名：'
      + JSON.stringify(joinNames));
    ok(new Set(joinNames).size === joinNames.length,
      '组里出现了两部同名短片：' + JSON.stringify(joinNames));
    const joinBanner = await statusText();
    ok(/并入了现有同名组/.test(joinBanner) && !/新建 1 个项目组/.test(joinBanner),
      '回执说清是并入而不是新建：' + joinBanner.replace(/\s+/g, ' ').slice(0, 120));

    /* ⑦-2 自动建组：包里带一个本机没有的组名 —— 这一问不必出现，直接建。 */
    const newGroupPack = JSON.parse(grpPack.json);
    newGroupPack.projects.forEach(x => { x.groupName = '包里带来的新组'; x.groupId = 'g-whatever'; });
    newGroupPack.checksum = projectPackChecksum(JSON.stringify(newGroupPack.projects));
    const newRes = await runImport(JSON.stringify(newGroupPack), 'new-group.json', { add: 2 });
    ok(!newRes.seen.group, '本机没有同名组时不该问「并入还是改名」');
    ok(/1 个项目组/.test(newRes.seen.confirm), '确认框说清了包里带几个组：'
      + newRes.seen.confirm.replace(/\s+/g, ' ').slice(0, 120));
    await openMenu();
    const treeNew = await menuTree();
    const gNew = treeNew.filter(g => g.name === '包里带来的新组');
    ok(gNew.length === 1 && /2 部/.test(gNew[0].cnt),
      '本机没有同名组时按组名现建一个、短片全在里面：'
      + JSON.stringify(treeNew.map(g => g.name + g.cnt)));
    /* 第三次导入同一份包：名字得继续往后编，不许与前面几部重名。 */
    const namesNew = treeNew.flatMap(g => g.rows.map(x => x.split(' · ')[0]));
    ok(new Set(namesNew).size === namesNew.length,
      '多次导入后菜单里出现了同名短片：' + JSON.stringify(namesNew));
    const newBanner = await statusText();
    ok(/新建 1 个项目组/.test(newBanner) && /包里带来的新组/.test(newBanner),
      '回执说清了新建的是哪个组：' + newBanner.replace(/\s+/g, ' ').slice(0, 140));

    /* ⑦-3 组名撞车选「给导入的组改名」：本机原有的「默认组」一部都不许被挪走，
       导入那两部落进新组「默认组（导入）」。 */
    const renameRes = await runImport(grpPack.json, 'rename-group.json',
      { group: 'rename', dup: 'rename', add: 2 });
    ok(/项目组重名/.test(renameRes.seen.group), '再导一次撞名组，还是要先问怎么落位');
    await openMenu();
    const treeRename = await menuTree();
    const gRenamed = treeRename.filter(g => g.name === '默认组（导入）');
    const gKept = treeRename.filter(g => g.name === '默认组');
    ok(gRenamed.length === 1 && /2 部/.test(gRenamed[0].cnt),
      '改了名的新组里是包里那 2 部：' + JSON.stringify(treeRename.map(g => g.name + g.cnt)));
    ok(gKept.length === 1 && /5 部/.test(gKept[0].cnt),
      '本机原有的「默认组」一部都没被挪走：' + (gKept[0] && gKept[0].cnt));
    const renameBanner = await statusText();
    ok(/1 个重名组改了名（默认组 → 默认组（导入））/.test(renameBanner),
      '回执说清了哪个组改成了什么：' + renameBanner.replace(/\s+/g, ' ').slice(0, 160));

    /* ⑦-4 重复短片选「跳过」：本机已经有同样内容，一部都不再导，连名单都不该动。 */
    const skipRes = await runImport(got.json, 'dup-skip.json', { dup: 'skip' });
    ok(skipRes.afterN === skipRes.beforeN,
      '选「跳过重复」时短片数一部都没变：' + skipRes.beforeN + ' → ' + skipRes.afterN);
    ok(!skipRes.seen.group && !skipRes.seen.confirm,
      '全跳过时不该再问组名、也不必再走确认框：' + JSON.stringify(skipRes.seen.picks));
    const skipBanner = await statusText();
    ok(/一部都没重复导入/.test(skipBanner),
      '回执说清一部都没重复导入：' + skipBanner.replace(/\s+/g, ' ').slice(0, 120));

    /* ⑧ 当前短片没归组时，「导出当前项目组短片」标成不可用 —— 位置留着、但点不动。 */
    await openMenu();
    await page.eval(() => {
      const row = Array.from(document.querySelectorAll('#projMenu .pm-row'))
        .find(x => /未归组那部/.test(x.textContent || ''));
      if (!row) throw new Error('找不到未归组那部短片');
      row.click();
    });
    await openIO(true);
    const offRow = await page.eval(() => {
      const rows = Array.from(document.querySelectorAll('#projMenu .pm-io-sub .pm-io'));
      const r = rows[0] || null;
      return { off: !!r && r.classList.contains('pm-io-off'),
        disabled: r ? r.getAttribute('aria-disabled') : '',
        text: r ? (r.textContent || '').trim() : '' };
    });
    ok(offRow.off && offRow.disabled === 'true' && /未归组/.test(offRow.text),
      '未归组时按组导出那格标成不可用并说明原因：' + offRow.text);

    /* ⑨ 收起这一组会连尾钮一起收回：再摊开是默认那一屏，次级不残留。 */
    const collapsedAgain = await page.eval(async () => {
      document.querySelector('#projMenu .pm-io-toggle').click();
      await new Promise(r => setTimeout(r, 80));
      document.querySelector('#projMenu .pm-io-toggle').click();
      await new Promise(r => setTimeout(r, 80));
      const box = document.querySelector('#projMenu .pm-io-box');
      const more = box.querySelector('.pm-io-more');
      return { sub: !!box.querySelector('.pm-io-sub'),
        more: more ? more.getAttribute('aria-expanded') : '' };
    });
    ok(!collapsedAgain.sub && collapsedAgain.more === 'false',
      '收起再摊开时尾钮回到收起、次级不残留：' + JSON.stringify(collapsedAgain));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log(bad ? '\n✗ ' + bad + ' 项未通过' : '\n✓ 导演台项目文件：' + n + ' 项，0 项未通过');
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
