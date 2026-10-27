#!/usr/bin/env node
/* 剪辑态左栏「历史编辑记录」的判据 —— 历史是**只追加的操作日志 + 当前状态指针**：
     ① 每一步都有**精确描述**（哪一镜的哪一段、从几秒到几秒 / 切在哪一秒），不是「编辑」两个字；
     ② 日志**只追加**：做过什么全在，条数只增不减；
     ③ 回退**不删记录**：回退后在末尾追一条「回退到「xxx」」，并把「当前生效」的指针挪回去；
     ④ 撤销 / 重做走同一套：Ctrl+Z 追一条回退记录，Ctrl+Y 追一条重做记录；
     ⑤ 桥上的 `history().最近` 念的是**日志末尾那一条**（刚做完的事），不是「下一步要退掉的那一条」。
   判据跑的是产品自己的那一行（`.hist-row`）与工具条上那几颗按钮，不绕开界面。
   走的全是真实路径：点「用这条」把候选接进成片（建段）→ 点尺子放针 → 剪子切一刀 → 复制那一段。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.05;
const cand = (vid, dur, shotId) => ({ vid, provider: 'local', status: 'succeeded', progress: 100, url: '/asset/' + vid, duration: dur, shotId });

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const shot1 = { id: 'sh1', name: '镜头一', prompt: '画面', line: '', lineWho: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1, refImages: [], keyframes: [], selId: '', candidates: [cand('v1', 8, 'sh1')] };
    const project = { id: 'p-hist', name: '历史探针', curScene: 0, curShot: 0, scenes: [{ id: 'sc1', name: '场景 1', shots: [shot1] }] };
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: 'p-hist', roles: [], groups: [], ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);

    /* 面板：打开折叠区，读倒序那几行（最新在最上）。 */
    const openHist = () => page.eval(() => {
      const d = document.querySelector('#editLeft .el-hist');
      if (d) d.open = true;
      return !!d;
    });
    const rows = () => page.eval(() => [...document.querySelectorAll('#editLeft .hist-row')].map(r => ({
      label: (r.querySelector('.hn') || {}).textContent || '',
      kind: (r.querySelector('.hk') || {}).textContent || '',
      now: r.classList.contains('now'),
    })));
    const waitRows = async n => {
      const until = Date.now() + 10000;
      while (Date.now() < until) { await openHist(); const r = await rows(); if (r.length >= n) return r; await sleep(200); }
      return rows();
    };
    const hist = () => page.eval(() => window.WBBridge.get('director').history());
    const clips = () => page.eval(() => [...document.querySelectorAll('#tlBoard .tl-clip')].map(el => ({
      start: Number(el.getAttribute('data-start')), dur: Number(el.getAttribute('data-dur')),
    })));
    const pps = () => page.eval(() => {
      const c = document.querySelector('#tlBoard .tl-clip');
      return c ? parseFloat(c.style.width) / Number(c.getAttribute('data-dur')) : 0;
    });
    /* 放针 = 点尺子/轨道空处那同一颗处理器（pointerdown 之后必须补 pointerup，
       不然手势层一直以为手里还有一次拖动，中栏整列重画会被一路推迟）。 */
    async function seek(t) {
      const k = await pps();
      if (!(k > 5)) throw new Error('时间轴太窄，量不出比例尺：' + k);
      await page.eval((time, p) => {
        const sc = document.getElementById('tlScroll');
        const r = sc.getBoundingClientRect();
        const opt = { bubbles: true, cancelable: true, button: 0, clientX: r.left + time * p - sc.scrollLeft,
          clientY: r.top + 12, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        sc.dispatchEvent(new PointerEvent('pointerdown', opt));
        window.dispatchEvent(new PointerEvent('pointerup', opt));
      }, t, k);
      await sleep(150);
    }
    const clickTool = act => page.eval(a => {
      const b = document.querySelector(`#tlTools [data-tl="${a}"]`);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, act);

    /* ---------------- ① 把候选接进成片：这一步在日志里叫什么 ---------------- */
    if (!(await page.eval(() => { const b = document.getElementById('usec'); if (!b || b.disabled) return false; b.click(); return true; }))) {
      throw new Error('生成态没有可点的「用这条」');
    }
    await sleep(900);
    await page.eval(() => { const t = document.getElementById('trimBtn'); if (t && !t.classList.contains('on')) t.click(); });
    await page.waitFor(() => !!document.getElementById('tlScroll'), 15000);
    await page.waitFor(() => document.querySelectorAll('#tlBoard .tl-clip').length >= 1, 15000, 200);
    if (!(await openHist())) throw new Error('剪辑态左栏没有「历史编辑记录」那块');
    let rs = await waitRows(1);
    if (!rs.length) throw new Error('接进成片之后历史里该有一条：' + JSON.stringify(await hist()));
    if (!/镜头一/.test(rs[0].label)) throw new Error('接进成片那一步该点名是哪一镜：' + rs[0].label);
    if (!/候选/.test(rs[0].label)) throw new Error('接进成片那一步该说清接的是第几条候选：' + rs[0].label);
    const n0 = rs.length;

    /* ---------------- ② 剪一刀：描述精确到「哪一段 · 从几秒到几秒 · 切在哪一秒」 ---------------- */
    await seek(3);
    if (!(await clickTool('cut'))) throw new Error('工具条没有可点的剪子（或它被压暗了）');
    const afterCut = await waitRows(n0 + 1);
    if (afterCut.length <= n0) throw new Error('切了一刀，历史里该多一条记录：' + n0 + ' → ' + afterCut.length);
    const cut = afterCut[0];
    if (cut.kind !== '编辑') throw new Error('刚做的这一步该记成「编辑」：' + JSON.stringify(cut));
    if (!/^把「镜头一」第 1 段（/.test(cut.label)) throw new Error('这一条该说清是哪一镜的第几段、它原来从几秒到几秒：' + cut.label);
    if (!/在 3.0 秒处切开$/.test(cut.label)) throw new Error('这一条该说清切在 3.0 秒：' + cut.label);
    if (!cut.now) throw new Error('刚做的这一步该是「当前生效」的那一条');
    /* ⑤ 桥上那句「最近」念的就是这一条 */
    const hc = await hist();
    if (hc.最近 !== cut.label) throw new Error('history().最近 该是刚做的那一步（日志末尾），不是「下一步要退掉的那一条」：' + JSON.stringify(hc));
    const cs = await clips();
    if (cs.length !== 2) throw new Error('切完画面轨该有两段：' + JSON.stringify(cs));
    if (!near(cs[0].start, 0) || !near(cs[1].start, 3)) throw new Error('两段的落点不对：' + JSON.stringify(cs));

    /* ---------------- ③ 再做一次（复制选中那一段）→ 日志只增，描述各不相同 ---------------- */
    const n1 = afterCut.length;
    if (!(await clickTool('duplicate'))) throw new Error('切完之后右边那一截没被选中，复制键压着点不动');
    let rs2 = await waitRows(n1 + 1);
    if (rs2.length <= n1) throw new Error('再改一次该多一条记录（日志只追加）：' + n1 + ' → ' + rs2.length);
    if (!/^复制 1 块：「镜头一」第 2 段（/.test(rs2[0].label)) throw new Error('复制那一步该点名复制了哪一段：' + rs2[0].label);
    if (rs2[0].label === rs2[1].label) throw new Error('两条的描述不该一样：' + JSON.stringify(rs2));
    /* 每一行都不是那句「编辑」两个字（用户点名）。 */
    const bare = rs2.filter(r => r.kind === '编辑' && !/[0-9]/.test(r.label));
    if (bare.length) throw new Error('有记录没带秒数 / 段号，等于没说：' + JSON.stringify(bare));

    /* ---------------- ④ 回退到很早那一条（点面板上的行）：末尾留痕、指针指回去 ---------------- */
    const before = await hist();
    const beforeN = (await rows()).length;
    await page.eval(() => {
      /* 倒序列表里最后那一行 = 日志最老的那一条（接进成片那一步）。 */
      const list = [...document.querySelectorAll('#editLeft .hist-row')];
      const target = list[list.length - 1];
      if (target) target.click();
    });
    await sleep(900);
    const after = await hist();
    const afterRows = await rows();
    if (afterRows.length <= beforeN) throw new Error('回退该在末尾追一条记录（不能删）：' + beforeN + ' → ' + afterRows.length);
    if (afterRows[0].kind !== '回退') throw new Error('末尾那条该是「回退」记录：' + JSON.stringify(afterRows[0]));
    if (!/^回退到「/.test(afterRows[0].label)) throw new Error('回退记录该写明回退到哪一条：' + afterRows[0].label);
    if (afterRows[0].now) throw new Error('回退之后，「当前生效」的指针该指向**回退到的那一条**，不是刚追的这条流水');
    if (!afterRows.some(r => r.now)) throw new Error('回退之后总要有一条是「当前生效」的：' + JSON.stringify(afterRows));
    if (!(after.可撤销 < before.可撤销)) throw new Error('回退之后可退的步数该变少：' + JSON.stringify({ before, after }));
    const back = await clips();
    if (back.length !== 1) throw new Error('退回到「刚接进成片」那一版，画面轨该只剩一段：' + JSON.stringify(back));

    /* ---------------- ⑤ 撤销 / 重做也走同一套：各追一条，条数继续只增 ---------------- */
    const n3 = afterRows.length;
    await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    await sleep(900);
    const afterUndo = await rows();
    if (afterUndo.length <= n3) throw new Error('Ctrl+Z 该追一条回退记录：' + n3 + ' → ' + afterUndo.length);
    if (afterUndo[0].kind !== '回退') throw new Error('Ctrl+Z 之后末尾那条该是回退记录：' + JSON.stringify(afterUndo[0]));
    const undone = await clips();
    if (undone.length !== 0) throw new Error('一路退到底就是「这一镜还没进成片」，画面轨该是空的：'
      + JSON.stringify(undone) + ' rows=' + JSON.stringify(afterUndo) + ' hist=' + JSON.stringify(await hist())
     );

    const n4 = afterUndo.length;
    await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })));
    await sleep(900);
    const afterRedo = await rows();
    if (afterRedo.length <= n4) throw new Error('Ctrl+Y 该追一条重做记录：' + n4 + ' → ' + afterRedo.length);
    if (afterRedo[0].kind !== '重做') throw new Error('Ctrl+Y 之后末尾那条该是重做记录：' + JSON.stringify(afterRedo[0]));
    if (!/^重做到「/.test(afterRedo[0].label)) throw new Error('重做记录该写明重做到哪一条：' + afterRedo[0].label);

    /* ---------------- ⑥ 日志里一条都没被删（最早那几步的名字都还在） ---------------- */
    const labels = afterRedo.map(r => r.label).join('\n');
    if (!/镜头一/.test(labels)) throw new Error('回退几次之后，最早那条编辑记录也该还在：' + labels);
    if (!/切开/.test(labels)) throw new Error('那一刀的记录也不该被回退抹掉：' + labels);
    if (!/复制/.test(labels)) throw new Error('那一次复制的记录也不该被回退抹掉：' + labels);
    const hh = await hist();
    if (!(hh.可撤销 >= 0 && hh.上限 === 30)) throw new Error('桥上的历史摘要读数不对：' + JSON.stringify(hh));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理故障：' + faults.slice(0, 3).join(' | '));
    console.log('✓ 历史编辑记录：只追加的日志（条数只增不减）· 描述精确（哪一镜的哪一段 · 从几秒到几秒 · 切在哪一秒）'
      + '· 回退留痕并把指针指回去 · 撤销重做同一条路 · 桥上「最近」念的是日志末尾那一条');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    try { if (page) page.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
