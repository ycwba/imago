#!/usr/bin/env node
/* 导演台「开机没有人碰，就不该被记成改过」判据。
   右栏每次重画都按当前型号的声明回写参数（`web/director/engine/panel.js` 的 `put`），
   播放器元数据也会回填时长（`web/director/engine/mid.js` 的 `onloadedmetadata`），
   接续那一档还会先挑一个支持首帧的型号（`ensureChainModel`）。
   以前这一路统一走非静默的 `scheduleSave`：打开一页谁都没动，500ms 保存窗口到期就压一枚
   「编辑」进历史日志 —— Ctrl+Z 退回去只是把字段变回从来没存过的样子，
   助手与历史面板也凭空看见一次「工程又改过」（`tests/e2e/editing-assistant.cjs` 那条
   「只读工具不许动工程」正是被这种时序撞红的）。新桥按身份对账，没有修订号这一层：
   静默的判据是「撤销条数一直是 0，历史日志末尾没有多出一条」。
   现在按「原来有没有存过值」分开结算：
     · 补齐（原来是空）= 程序第一次把默认填进来 → 静默落盘：字节照样写，不占撤销、不推进修订号；
     · 收正（存过的值不在声明里）= 真的动了用户那份数 → 照旧压撤销 + 带标签 + 推进修订号。
   三档开机各跑一次：
     A 一次没存过参数的镜头（`linkPrev:'tail'` 一定会走到型号与参数回写那一路）→ 计数器不动，但盘上必须
       真的被补齐了（否则「计数器不动」可能只是「什么都没发生」，这一条就是空对空 —— 实测把 panel/mid
       退回改动前那一份，同一颗种子在 1.5 秒时报出 `rev:1 undo:1「参数按型号声明收正」`）；
     B 拿 A 补齐出来的那一份原样再开一次 → 每个字段都「存过且合法」，一个字节都不该动；
     C 存了非法分辨率的一镜 → 必须动得有声有色（撤销、标签、修订号、状态行都在）。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

/* 一次完整开机：种一份工作区 → 打开导演台 → 等过「500ms 保存窗口 + 能力补画」→ 读数。
   读的是浏览器里那一份（IndexedDB），磁盘上的 `.data/workspace.json` 是镜像、可能还带着节流。 */
async function bootWith(mutate, tag) {
  const shot = { id: 'sh_2', name: '镜头二', prompt: '接上一镜', line: '', lineWho: '', refImages: [], candidates: [], selId: null };
  Object.assign(shot, mutate || {});
  const project = { id: 'p-' + tag, name: '开机静默探针', scenes: [{ id: 'sc1', name: '场景 1', shots: [shot] }] };
  const proxy = await h.startProxy();
  let browser;
  try {
    await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: { projects: [project], curId: project.id, roles: [], groups: [] } }),
    });
    browser = await h.launchBrowser();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__errs = [];
      window.addEventListener('error', e => window.__errs.push(String((e && e.message) || e)));
    });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    /* 采样而不是只读末值：幻象那一次落在装配后 1~1.5 秒，只等 3.5 秒再读末值的话
       「先 +1 又退回 0」这种也会被骗过去。 */
    const samples = [];
    for (let i = 0; i < 7; i++) {
      samples.push(await page.eval(() => {
        const d = window.WBBridge.get('director');
        const c = d.context();
        const hh = d.history ? d.history() : {};
        return { undo: c.可撤销, 最近: hh.最近, 状态: ((document.getElementById('opState') || {}).textContent || '').trim() };
      }));
      await h.sleep(500);
    }
    const got = await page.eval(async () => {
      const ws = await window.Kv.at('ws').get('workspace');
      const p = (ws && ws.projects || []).find(x => x && x.scenes && x.scenes.length);
      const sh = p && p.scenes[0].shots[0];
      return { shot: sh || null, errs: (window.__errs || []).slice(0, 3), 落盘: !!(sh && p) };
    });
    return { samples, got };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await proxy.stop();
  }
}

/* 整段开机里两个计数器一次都没动（取末值不够：见上面采样的理由）。 */
/* 静默 = 撤销条数一直是 0，而且历史日志末尾一直没多出东西（`最近` 空串）。 */
const 静默 = r => r.samples.every(s => !s.undo && s.最近 === '');

(async () => {
  try {
    /* ── A 一次没存过参数的镜头：补齐要落盘，但不许记成一次编辑 ─────────── */
    const fill = await bootWith({ linkPrev: 'tail' }, 'fill');
    must(!fill.got.errs.length, '开机过程中页面抛错（静默落盘那一路是域模块里调的，E 名单漏了名字就在这里炸）：' + fill.got.errs.join(' | '));
    must(fill.got.落盘, '开机后 IndexedDB 里没有那一份工作区（探针没跑通，下面的判据都无从读起）');
    must(静默(fill), '开机没有人操作，工程却被记成改过：'
      + JSON.stringify(fill.samples.map(s => ({ undo: s.undo, 最近: s.最近 }))));
    /* 补齐确实跑了：型号是接续那一路挑出来的，时长/分辨率/画幅/档位/条数是按声明填的。
       没有这一条，上面那句「计数器没动」就可能是「回写压根没发生」蒙过去的。 */
    const f = fill.got.shot;
    must(String(f.model || '') !== '', '开机没给这一镜补上型号（盘上那份还是空的，说明补齐那一路没走）：' + JSON.stringify(f));
    must(Number(f.duration) > 0, '开机没把型号声明的默认时长补齐到盘上：' + JSON.stringify(f));
    must(String(f.res || '') !== '' && String(f.ar || '') !== '' && String(f.tier || '') !== '' && Number(f.draw) > 0,
      '开机补齐只填了一半参数（静默落盘只跑了一次，还剩几个字段是空的）：' + JSON.stringify(f));

    /* ── B 拿 A 补齐出来的那一份原样再开一次：每个字段都存过且合法 ────────
       这一档盯的是另一件事：收正判定不能把「已经等于声明默认值」也算成一次改写，
       否则每次开机都多一枚撤销步数，Ctrl+Z 退的是自己刚填进去的值。 */
    const same = await bootWith(f, 'same');
    must(!same.got.errs.length, '第二档开机页面抛错：' + same.got.errs.join(' | '));
    must(静默(same), '一份参数已经全部合法的工程，开机又把它记成改过一次：'
      + JSON.stringify(same.samples.map(s => ({ undo: s.undo, 最近: s.最近 }))));
    const s = same.got.shot;
    must(s.model === f.model && s.duration === f.duration && s.res === f.res && s.ar === f.ar
      && s.tier === f.tier && Number(s.draw) === Number(f.draw),
      '第二档开机改写了参数（第一档补齐出来的那一份没收敛）：前 ' + JSON.stringify(f) + ' 后 ' + JSON.stringify(s));

    /* ── C 对照组：存过的值不在型号声明里 = 真编辑，必须记账 ───────────────
       `res:'9999p'` 是补齐那一路认得的「有值」（它只补空值），却一定不在任何型号声明的分辨率档里，
       所以右栏第一次重画就会把它收正成声明里的那一档。 */
    const drift = await bootWith({ res: '9999p' }, 'drift');
    const last = drift.samples[drift.samples.length - 1];
    must(Number(last.undo) >= 1, '存过的非法值被收正了，却没进撤销栈（Ctrl+Z 退不回去）：undo=' + last.undo);
    must(String(last.最近 || '').indexOf('收正') >= 0,
      '撤销栈顶那一步该报出收正的名字，而不是空的「编辑」：' + JSON.stringify(last.最近));
    must(drift.got.shot.res !== '9999p', '非法的分辨率没有落到盘上（说明这一路压根没跑，上面三条是空对空）：' + drift.got.shot.res);
    /* 状态行经过 `sanitizeHTML`，空格可能是普通空格也可能是 &nbsp; 解码出来的 U+00A0，
       所以这一条按「空白无关」匹配 —— 要盯的是这句退得回去的话在不在，不是它中间那个字节。 */
    must(/可\s*Ctrl\+Z\s*退回/.test(last.状态), '收正要说一句退得回去（状态行）：' + JSON.stringify(last.状态));
    must(!drift.got.errs.length, '收正那一路页面抛错：' + drift.got.errs.join(' | '));
    console.log('✓ 开机静默补齐不进历史日志（撤销 0 步）；参数已合法的一次都不动；存过的值被收正才算一次真编辑');
  } catch (e) {
    console.error('✗ ' + ((e && e.stack) || e));
    process.exitCode = 1;
  }
})();
