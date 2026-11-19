#!/usr/bin/env node
/* 批量润色：简洁入口、两级选择、筛选语义、备注与问答、流式并发、审阅写回。
   取消 / 停止 / 失败 / 切换短片不串写；长列表重画保留滚动和键盘焦点。
   所有文字 AI 均打桩，代理与工作区由 harness 隔离。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const draft = (vid, id) => ({ vid: 'tmp_' + vid, provider: 'local', status: 'draft', progress: 0, url: '', duration: 0, shotId: id });
const shotOf = (id, name, prompt, cands) => ({ id, name, prompt: prompt || '', ar: '16:9', res: '768p', tier: 'fast',
  draw: 1, line: '', note: '', refImages: [], keyframes: [], candidates: cands || [draft('d_' + id, id)] });
const wsOf = () => ({ projects: [{ id: 'pr_po', name: '润色探针', curScene: 0, curShot: 0,
  scenes: [{ id: 'sc1', name: '场景 1', shots: [
    shotOf('sh1', '镜头一', '一个雨夜的路口，路灯闪烁', [
      draft('d_sh1', 'sh1'),
      { vid: 'tmp_v_own', provider: 'local', status: 'draft', prompt: '候选自己的句子', origin: 'manual',
        progress: 0, url: '', duration: 0, shotId: 'sh1' },
    ]),
    shotOf('sh2', '镜头二', '主人公撑伞走过斑马线'),
    shotOf('sh3', '镜头三', '远景，城市灯火慢慢亮起', [
      { vid: 'v_done', provider: 'local', status: 'succeeded', prompt: null, origin: 'imported',
        progress: 100, url: '', duration: 3, shotId: 'sh3' },
    ]),
    shotOf('sh4', '镜头四', ''),
  ] }], film: { clips: [], voices: [], captions: [], markers: [], tracks: { visibility: {}, locks: {} } } }],
  curId: 'pr_po', roles: [], ts: Date.now() });

const wsShots = async proxy => {
  const d = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
  const shots = (d && d.data && d.data.projects && d.data.projects[0].scenes[0].shots) || [];
  return shots.map(x => ({ id: x.id, prompt: x.prompt == null ? null : String(x.prompt),
    cands: (x.candidates || []).map(c => ({ vid: c.vid,
      prompt: c.prompt == null ? null : String(c.prompt), origin: String(c.origin || '') })) }));
};

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    const checkConsole = () => {
      if (page && page.errors.length) throw new Error('浏览器控制台错误：\n' + page.errors.join('\n'));
    };
    const boot = async (tag, workspace = wsOf()) => {
      checkConsole();
      if (page) await page.close().catch(() => {});
      page = await browser.newPage();
      await page.clearStorage(new URL(proxy.base).origin);
      await page.skipDataSyncBoot();
      await fetch(proxy.base + '/data/workspace', {
        method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, ts: Date.now(), data: workspace }),
      });
      await page.goto(proxy.base + '/shell.html?b=' + tag + '#director.html');
      await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
        && window.WBBridge.get('director').ready(), 25000);
      return page;
    };
    const pickShot = idx => page.eval(i => {
      const cards = document.querySelectorAll('#scenesBox .shot-item');
      if (cards[i]) cards[i].click();
      return cards.length;
    }, idx);
    /* 打桩：文字 AI 固定回稿；数 chatStream / askPolish / 在途峰值。
       delay 是每条请求的等待毫秒；ramp 让第 1 条先回、其余慢回（给「停止」留出部分结果窗口）。 */
    const stubAI = opts => page.eval(async o => {
      const T = window.TextAI;
      window.__PO = { chat: [], systems: [], ask: 0, inflight: 0, maxInflight: 0, calls: 0, aborted: 0,
        releases: [], more: [], released: false };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      T.canRun = async () => true;
      T.shouldAsk = () => !o.noAsk;
      T.chat = async () => { throw new Error('探针禁止非流式 AI 请求'); };
      T.chatStream = async (reg, sys, user, op, onDelta) => {
        window.__PO.chat.push(String(user || ''));
        window.__PO.systems.push(String(sys || ''));
        const n = ++window.__PO.calls;
        window.__PO.inflight++;
        if (window.__PO.inflight > window.__PO.maxInflight) window.__PO.maxInflight = window.__PO.inflight;
        try {
          if (onDelta && !o.empty) onDelta('【流式】', 'content');
          if (onDelta && o.longText) window.__PO.more.push(() => onDelta(o.longText, 'content'));
          if (o.hold && !window.__PO.released) await new Promise(resolve => window.__PO.releases.push(resolve));
          else await sleep(o.ramp ? (n === 1 ? 200 : 2500) : (o.delay || 250));
          if (op?.signal?.aborted) { window.__PO.aborted++; throw new DOMException('已停止', 'AbortError'); }
          if (o.failAt === n) throw new Error('探针失败 <限流>，请稍后重试');
          if (o.empty) return '';
          const txt = '【润】' + String(user || '').slice(0, 40) + (o.longText || '');
          if (onDelta) onDelta(txt, 'content');
          return txt;
        } finally { window.__PO.inflight--; }
      };
      T.askPolish = async () => {
        window.__PO.ask++;
        if (o.askDelay) await sleep(o.askDelay);
        return o.questions ? { need: true, questions: [{ q: '整体画风？', options: ['写实', '水彩'] }] }
          : { need: false, questions: [] };
      };
      const reg = await window.Api.registry();
      const pv = T.prov(reg);
      if (pv && window.LS && window.LS.set) window.LS.set('sk_key_' + (pv.keyId || pv.id), 'sk-probe');
      return pv ? pv.id : '';
    }, opts || {});
    /* 润色入口（通栏按钮）→ 范围弹窗。返回范围弹窗里的勾选集合快照给调用方断言。 */
    const openScope = async () => {
      await page.eval(() => {
        const b = document.getElementById('polishAll');
        window.focusQuiet(b);
        b.click();
      });
      await page.waitFor(() => !!document.querySelector('dialog.ui-dlg .pl-scope'), 8000);
      return page.eval(() => ({
        chips: [...document.querySelectorAll('.pl-scope-chips.ui-seg > button')].map(b => b.textContent),
        groups: document.querySelectorAll('.pl-scope-list .pl-shot').length,
        sum: String((document.querySelector('.pl-scope-sum') || {}).textContent || ''),
        hasNote: !!document.querySelector('.pl-scope label .pl-note.ui-inp'),
        title: document.querySelector('dialog.ui-dlg .pr-head b').textContent,
        sub: !!document.querySelector('dialog.ui-dlg .pr-head .sub'),
        pressed: [...document.querySelectorAll('.pl-scope-chips button')].map(b => b.getAttribute('aria-pressed')),
        labels: [...document.querySelectorAll('.pl-scope-list input')].map(i => i.getAttribute('aria-label')),
      }));
    };
    const chip = f => page.eval(x => {
      const b = document.querySelector('.pl-scope-chips.ui-seg > button[data-f="' + x + '"]');
      if (!b) throw new Error('缺少公共分段筛选按钮：' + x);
      b.click();
      const chips = [...document.querySelectorAll('.pl-scope-chips.ui-seg > button')];
      if (chips.some(c => c.getAttribute('aria-pressed') !== String(c === b)
        || c.classList.contains('on') !== (c === b))) throw new Error('筛选按钮高亮与 aria-pressed 不同步');
      if (document.activeElement !== b) throw new Error('筛选后焦点丢失');
      return document.querySelectorAll('.pl-scope-list .pl-shot').length;
    }, f);
    const toggleKey = key => page.eval(k => {
      const inp = document.querySelector('input[data-role="take"][data-key="' + k + '"]');
      if (inp) {
        window.focusQuiet(inp);
        inp.click();
        if (document.activeElement?.dataset.key !== k) throw new Error('候选重画后焦点丢失：' + k);
      }
      return !!inp;
    }, key);
    const startRun = () => page.eval(() => {
      const b = document.querySelector('dialog.ui-dlg .pr-foot .pri');
      if (b) b.click();
      return !!b;
    });
    const waitReview = (ms) => page.waitFor(() => {
      const d = document.getElementById('prDlg');
      const t = d && d.querySelector('.pr-head b');
      return !!(t && /润色结果/.test(t.textContent || ''));
    }, ms || 30000, 200);
    const prState = () => page.eval(() => {
      const d = document.getElementById('prDlg');
      if (!d) return { open: false };
      return {
        open: true,
        sub: String((d.querySelector('.pr-head .sub') || {}).textContent || ''),
        rows: [...d.querySelectorAll('.pr-row')].map(r => String((r.querySelector('.tt') || {}).textContent || '')),
        procRows: d.querySelectorAll('.pr-proc-row').length,
        states: [...d.querySelectorAll('.pr-proc-row .st')].map(s => String(s.textContent || '')),
        ok: String((d.querySelector('#prOk') || {}).textContent || ''),
        hint: String((d.querySelector('#prHint') || {}).textContent || ''),
        title: String((d.querySelector('.pr-head b') || {}).textContent || ''),
      };
    });

    const polishWorkflowFrame = (phase, baseline = null, scrollSelector = '') => page.eval(async (label, previous, selector) => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const dlg = document.querySelector('dialog.ui-dlg[open]');
      if (!dlg?.classList.contains('ui-dlg-workflow')) throw new Error(label + '：没有 workflow 尺寸档');
      const rect = dlg.getBoundingClientRect();
      const size = { width: rect.width, height: rect.height };
      const expected = { width: Math.min(804, innerWidth * 0.94), height: Math.min(704, innerHeight * 0.88) };
      for (const axis of ['width', 'height']) {
        if (Math.abs(size[axis] - expected[axis]) > 1 || (previous && Math.abs(size[axis] - previous[axis]) > 1)) {
          throw new Error(label + '：弹窗尺寸跳动 ' + JSON.stringify({ size, expected, previous }));
        }
      }
      const head = dlg.querySelector('.pr-head'), foot = dlg.querySelector('.pr-foot'), body = dlg.querySelector('.pr-body');
      const hr = head.getBoundingClientRect(), fr = foot.getBoundingClientRect(), br = body.getBoundingClientRect();
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1
        || hr.top < rect.top || fr.bottom > rect.bottom || fr.left < rect.left || fr.right > rect.right
        || br.top < hr.bottom - 1 || br.bottom > fr.top + 1 || br.height <= 0
        || dlg.scrollWidth > dlg.clientWidth + 1 || dlg.scrollHeight > dlg.clientHeight + 1) {
        throw new Error(label + '：正文或页脚溢出弹窗');
      }
      if (selector) {
        const scroller = dlg.querySelector(selector);
        if (!scroller || !body.contains(scroller) || scroller.clientHeight <= 0
          || scroller.scrollHeight <= scroller.clientHeight || !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
          throw new Error(label + '：正文未形成内部滚动 ' + selector);
        }
        const oldTop = scroller.scrollTop;
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise(requestAnimationFrame);
        if (scroller.scrollTop <= 0 || Math.abs(foot.getBoundingClientRect().top - fr.top) > 1
          || Math.abs(head.getBoundingClientRect().top - hr.top) > 1 || dlg.scrollTop !== 0) {
          throw new Error(label + '：正文滚动带动了标题或页脚');
        }
        scroller.scrollTop = oldTop;
      }
      return size;
    }, phase, baseline, scrollSelector);

    /* ---------- 档 0：右栏改候选描述只动它自己（第一条不跟着变、基准不被顶掉） ---------- */
    await boot('p1');
    const clickThumb = vid => page.eval(v => {
      const t = document.querySelector('#candThumbs .cand-thumb[data-vid="' + v + '"]');
      if (t) t.click();
      return !!t;
    }, vid);
    const promptValIs = async want => {
      for (let i = 0; i < 100; i++) {
        const v = await page.eval(() => String((document.getElementById('edPrompt') || {}).value || ''));
        if (v === want) return true;
        await sleep(50);
      }
      return false;
    };
    const setPrompt = txt => page.eval(t => {
      const ta = document.getElementById('edPrompt');
      if (!ta) return false;
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, txt);
    /* 500ms 保存去抖 + 800ms 镜像合并窗：等落盘按服务端状态轮询，别掐固定时长 */
    const waitWs = async pred => {
      const until = Date.now() + 8000;
      let shots = [];
      while (Date.now() < until) {
        shots = await wsShots(proxy);
        if (pred(shots)) return shots;
        await sleep(250);
      }
      return shots;
    };
    await pickShot(0);
    await page.waitFor(() => !!document.querySelector('#candThumbs .cand-thumb[data-vid="tmp_v_own"]'), 8000, 100);
    if (!(await clickThumb('tmp_v_own'))) throw new Error('候选条里没有第二条候选（tmp_v_own）');
    if (!(await promptValIs('候选自己的句子'))) throw new Error('切到第二条候选后右栏提示词框没换成它自己的描述');
    if (!(await setPrompt('候选改写句'))) throw new Error('没有右栏提示词框 #edPrompt');
    let w0 = (await waitWs(s => s[0] && s[0].cands[1] && s[0].cands[1].prompt === '候选改写句'))[0];
    if (w0.cands[0].prompt !== '一个雨夜的路口，路灯闪烁') throw new Error('改第二条候选把同一镜的默认候选也改了：' + JSON.stringify(w0));
    if (w0.prompt != null) throw new Error('镜头级 prompt 应已退役：' + JSON.stringify(w0));
    if (w0.cands[1].prompt !== '候选改写句') throw new Error('第二条候选的自有描述没有写进去：' + JSON.stringify(w0.cands[1]));
    if (!(await clickThumb('tmp_d_sh1'))) throw new Error('候选条里没有第一条候选（tmp_d_sh1）');
    if (!(await promptValIs('一个雨夜的路口，路灯闪烁'))) throw new Error('切回第一条（auto）后提示词框没回到这一条自己的描述');
    if (!(await setPrompt('雨夜路口，路灯忽明忽暗'))) throw new Error('没有右栏提示词框 #edPrompt');
    w0 = (await waitWs(s => s[0] && s[0].cands[0] && s[0].cands[0].prompt === '雨夜路口，路灯忽明忽暗'))[0];
    if (w0.cands[0].prompt !== '雨夜路口，路灯忽明忽暗') throw new Error('改第一条（auto）没有落到它自己那句：' + JSON.stringify(w0));
    if (w0.cands[1].prompt !== '候选改写句') throw new Error('改第一条（auto）连带改掉了第二条：' + JSON.stringify(w0.cands));

    /* ---------- 档 1：范围筛选 / 逐条勾选 / 并发 / 审阅写回隔离 ---------- */
    await stubAI({ delay: 250 });
    await pickShot(1); await sleep(300); await pickShot(0);
    await page.waitFor(() => !document.getElementById('polishAll').disabled, 8000, 200);
    await page.waitFor(() => !document.getElementById('polishAll').title, 8000, 200);
    const st0 = await page.eval(() => {
      const b = document.getElementById('polishAll');
      return { dis: b.disabled, title: b.title };
    });
    if (st0.dis) throw new Error('放了文字 AI 密钥之后润色入口仍然禁用：' + st0.title);
    if (st0.title) throw new Error('入口仍有动态教学 title：' + st0.title);

    const sc = await openScope();
    if (!sc.hasNote) throw new Error('范围弹窗缺少具名公共备注控件');
    if (sc.title !== '润色文案' || sc.sub) throw new Error('范围标题不简洁或仍有教学说明：' + JSON.stringify(sc));
    if (sc.chips.join('/') !== '全部/视频已生成/未生成视频/草稿') throw new Error('范围弹窗芯片不对：' + sc.chips.join('/'));
    if (sc.pressed.join('/') !== 'true/false/false/false') throw new Error('默认筛选语义不对：' + sc.pressed);
    if (sc.labels.some(x => !x) || !sc.labels.includes('镜头一 · 全部候选')
      || !sc.labels.includes('镜头一 · 候选 2（草稿）')) throw new Error('复选框标签未明确镜头与候选：' + sc.labels);
    if (sc.groups !== 4) throw new Error('范围弹窗镜头组数不对（含空草稿应 4 组）：' + sc.groups);
    if (sc.sum !== '已选 4 / 4 项 · 无描述 1 镜') throw new Error('默认应全选可润色候选：' + sc.sum);
    if (await chip('done') !== 1) throw new Error('「视频已生成」档应只剩镜三一组');
    if (await chip('todo') !== 3) throw new Error('「未生成视频」档应剩镜一 / 镜二 / 镜四三组');
    if (await chip('draft') !== 3) throw new Error('「草稿」档应包含镜四的空草稿');
    if (await chip('all') !== 4) throw new Error('「全部」档应回到四组');
    await page.eval(() => {
      const empty = document.querySelector('.pl-shot[data-shot="sh4"]');
      if (!empty || !empty.textContent.includes('暂无描述')) throw new Error('空草稿缺少「暂无描述」');
      if ([...empty.querySelectorAll('input')].some(i => !i.disabled || i.checked)) throw new Error('空描述仍可勾选润色');
      if (document.querySelector('.pl-take label details')) throw new Error('提示词折叠区被包进复选框标签');
      const details = document.querySelector('.pl-shot[data-shot="sh1"] .pl-take > details[data-prompt]');
      if (!details || details.open || details.querySelector('.pl-prompt-body').textContent !== '雨夜路口，路灯忽明忽暗') {
        throw new Error('候选原描述未默认折叠显示');
      }
    });
    if (!(await toggleKey('t:sh1:tmp_v_own'))) throw new Error('缺少候选勾选框');
    const partial = await page.eval(() => document.querySelector('.pl-shot[data-shot="sh1"] input[data-role="shot"]').indeterminate);
    if (!partial) throw new Error('只选一条候选后镜头没有半选状态');
    await toggleKey('t:sh1:tmp_v_own');
    if (!(await toggleKey('t:sh2:tmp_d_sh2'))) throw new Error('范围弹窗里找不到镜二的默认候选勾选框');
    await chip('done'); await chip('all');
    const sumAfter = await page.eval(() => String(document.querySelector('.pl-scope-sum').textContent || ''));
    if (!/已选 3 \/ 4/.test(sumAfter)) throw new Error('筛选后选择未保留：' + sumAfter);
    await page.eval(() => { document.querySelector('.pl-note').value = '统一黄昏光线'; });
    const beforeReview = await wsShots(proxy);
    await startRun();
    await waitReview();
    if (JSON.stringify(await wsShots(proxy)) !== JSON.stringify(beforeReview)) throw new Error('审阅确认前已写入文案');
    let pr = await prState();
    const po = await page.eval(() => window.__PO);
    if (po.ask !== 1) throw new Error('批量润色应先走一轮整体问答（askPolish 被调了 ' + po.ask + ' 次；桩回 need:false 就直接开润）');
    if (po.chat.length !== 3) throw new Error('应只润勾选的 3 条（实际请求 ' + po.chat.length + ' 条）');
    if (po.chat.some(x => x.indexOf('撑伞') >= 0)) throw new Error('取消勾选的镜二画面仍被润了');
    if (!po.chat.some(x => x.indexOf('候选改写句') >= 0)) throw new Error('候选自有描述没有被润');
    if (po.maxInflight < 2) throw new Error('过程不是并发（最大在途 ' + po.maxInflight + ' 条）');
    if (pr.rows.length !== 3) throw new Error('审阅清单应 3 行（实际 ' + pr.rows.length + '）：' + pr.rows.join(' | '));
    if (!pr.rows.some(t => /镜头一 · 候选 1（草稿）/.test(t))) throw new Error('审阅清单缺默认候选那一行：' + pr.rows.join(' | '));
    if (!pr.rows.some(t => /镜头一 · 候选 2（草稿）/.test(t))) throw new Error('审阅清单缺候选行：' + pr.rows.join(' | '));
    if (pr.ok !== '写入文案' || pr.title !== '润色结果' || pr.hint) throw new Error('审阅仍有冗长文案：' + JSON.stringify(pr));
    if (!po.systems.every(x => x.includes('统一黄昏光线'))) throw new Error('整批备注未传给每条请求');
    await page.eval(() => { const b = document.getElementById('prOk'); if (b) b.click(); });
    let shots = [];
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      shots = await wsShots(proxy);
      if (shots[0] && shots[0].cands[0] && shots[0].cands[0].prompt.indexOf('【润】') === 0
        && shots[0].cands.some(c => String(c.prompt || '').indexOf('【润】') === 0)) break;
    }
    const byId = Object.fromEntries(shots.map(x => [x.id, x]));
    if (!/^【润】/.test(byId.sh1.cands[0].prompt)) throw new Error('镜一默认候选没有写回：' + JSON.stringify(byId.sh1));
    if (!/^【润】/.test(String(byId.sh1.cands[1].prompt))) throw new Error('候选自有描述没有写回：' + JSON.stringify(byId.sh1.cands));
    if (byId.sh1.cands[1].origin !== 'manual') throw new Error('候选的 origin 被改掉了：' + byId.sh1.cands[1].origin);
    if (byId.sh1.cands.some(c => c.prompt == null)) throw new Error('候选不该再回落到镜头级描述：' + JSON.stringify(byId.sh1.cands));
    if (byId.sh2.cands[0].prompt !== '主人公撑伞走过斑马线') throw new Error('取消勾选的镜二描述被写了：' + JSON.stringify(byId.sh2.cands));
    if (!/^【润】/.test(byId.sh3.cands[0].prompt)) throw new Error('镜三候选没有写回：' + JSON.stringify(byId.sh3.cands));
    if (byId.sh4.cands[0].prompt !== '') throw new Error('空描述的镜四被写了：' + JSON.stringify(byId.sh4.cands));
    const opTxt = await page.eval(() => String(document.getElementById('opState').textContent || ''));
    if (!/已写入 3 条/.test(opTxt)) throw new Error('写回回执不对：' + opTxt);

    /* ---------- 档 2：停止 → 部分结果转审阅；审阅取消则一个字不动 ---------- */
    await boot('p2');
    await stubAI({ ramp: true });
    await pickShot(1); await sleep(300); await pickShot(0);
    await page.waitFor(() => !document.getElementById('polishAll').disabled, 8000, 200);
    const sc2 = await openScope();
    if (!/已选 4 \/ 4/.test(sc2.sum)) throw new Error('档 2 默认没有全选：' + sc2.sum);
    await startRun();
    await page.waitFor(() => [...document.querySelectorAll('#prDlg .pr-proc-tx')].some(t => t.textContent.includes('【流式】')), 8000);
    await page.eval(() => { window.__PO.processShell = document.getElementById('prDlg'); });
    await page.waitFor(() => [...document.querySelectorAll('#prDlg .pr-proc-row .st')]
      .some(s => /完成/.test(s.textContent || '')), 15000, 100);
    const stopBtn = await page.eval(() => {
      const b = document.getElementById('prCancel');
      if (!b) return '';
      const t = b.textContent;
      b.click();
      return t;
    });
    if (!/停止/.test(stopBtn) || /正在停止/.test(stopBtn)) throw new Error('过程弹窗的取消键没有换面成「停止」：' + stopBtn);
    await waitReview(20000);
    if (!(await page.eval(() => window.__PO.processShell === document.getElementById('prDlg')))) throw new Error('停止后审阅更换了弹窗');
    pr = await prState();
    if (!/已停止/.test(pr.sub)) throw new Error('停止后的审阅没有说明已停止：' + pr.sub);
    if (pr.rows.length < 1 || pr.rows.length >= 4) throw new Error('停止后应只剩部分结果（1..3 行），实际 ' + pr.rows.length);
    await page.eval(() => { const b = document.getElementById('prCancel'); if (b) b.click(); });
    await sleep(800);
    shots = await wsShots(proxy);
    if (shots.some(x => (x.cands || []).some(c => String(c.prompt || '').indexOf('【润】') === 0))) {
      throw new Error('审阅取消后候选描述也被写回去了');
    }

    /* ---------- 档 3：一条都没润出来 → 文案没有动；范围弹窗取消 → 一个请求都不发 ---------- */
    await boot('p3');
    await stubAI({ empty: true, delay: 80 });
    await pickShot(1); await sleep(300); await pickShot(0);
    await page.waitFor(() => !document.getElementById('polishAll').disabled, 8000, 200);
    await openScope();
    await startRun();
    await page.waitFor(() => window.__PO.calls === 4 && !document.getElementById('prDlg'), 20000, 150);
    const banner = await page.eval(() => {
      const b = document.getElementById('banner');
      return b && !b.hidden ? String((b.querySelector('.msg') || {}).textContent || '') : '';
    });
    if (!/润色失败 4 条/.test(banner) || !/文字 AI 没有返回内容/.test(banner) || !/请重试/.test(banner)) throw new Error('全失败的回执缺少原因与下一步：「' + banner + '」');
    shots = await wsShots(proxy);
    if (shots.some(x => (x.cands || []).some(c => String(c.prompt || '').indexOf('【润】') === 0))) throw new Error('全失败之后文案也被写了回去');
    const before = await page.eval(() => window.__PO.chat.length);
    await openScope();
    await page.eval(() => {
      const b = document.querySelector('dialog.ui-dlg .pr-foot .ghost');
      if (b) b.click();
    });
    await sleep(600);
    const after = await page.eval(() => window.__PO.chat.length);
    const prOpen = await page.eval(() => !!document.getElementById('prDlg'));
    if (after !== before) throw new Error('范围弹窗取消之后仍发出了润色请求');
    if (prOpen) throw new Error('范围弹窗取消之后过程弹窗仍被打开');
    if (!(await page.eval(() => document.activeElement === document.getElementById('polishAll')))) throw new Error('范围取消后焦点未返回入口');

    const readyAI = async opts => {
      await stubAI(opts);
      await pickShot(1); await pickShot(0);
      await page.waitFor(() => !document.getElementById('polishAll').disabled, 8000);
    };
    /* 问答取消不能误当跳过；回答和跳过分别进入流式润色。 */
    await boot('questions');
    await readyAI({ questions: true });
    await openScope(); await startRun();
    await page.waitFor(() => !!document.querySelector('#prDlg .pinl-qa'), 8000);
    await page.eval(() => document.getElementById('prCancel').click());
    await page.waitFor(() => !document.getElementById('prDlg'), 8000);
    if ((await page.eval(() => window.__PO.calls)) !== 0) throw new Error('问答取消后仍开始润色');
    await openScope(); await startRun();
    await page.waitFor(() => !!document.querySelector('#prDlg .pinl-qa'), 8000);
    await page.eval(() => {
      document.querySelector('#prDlg .pinl-opt[data-j="1"]').click();
      document.querySelector('#prDlg [data-act="go"]').click();
    });
    await waitReview();
    if (!(await page.eval(() => window.__PO.systems.every(x => x.includes('水彩'))))) throw new Error('整体问答未传入每条润色');
    await page.eval(() => document.getElementById('prCancel').click());
    await readyAI({ questions: true });
    await openScope(); await startRun();
    await page.waitFor(() => !!document.querySelector('#prDlg .pinl-qa'), 8000);
    await page.eval(() => document.querySelector('#prDlg [data-act="skip"]').click());
    await waitReview();
    if ((await page.eval(() => window.__PO.calls)) !== 4) throw new Error('跳过问答后未润色全部候选');
    await page.eval(() => document.getElementById('prCancel').click());

    /* 部分失败保留真实错误，删除一条审阅结果后错误仍在。 */
    await boot('partial-failure');
    await readyAI({ noAsk: true, failAt: 2 });
    await openScope(); await startRun(); await waitReview();
    pr = await prState();
    if (pr.rows.length !== 3 || !pr.sub.includes('失败 1 条')
      || !pr.hint.includes('镜头一 · 候选 2（草稿）：探针失败 <限流>，请稍后重试')) throw new Error('部分失败原因丢失：' + JSON.stringify(pr));
    if ((await page.eval(() => window.__PO.ask)) !== 0) throw new Error('关闭问答后仍调用 askPolish');
    await page.eval(() => document.querySelector('#prDlg [data-del]').click());
    if ((await prState()).hint !== pr.hint) throw new Error('审阅重画丢失失败原因');
    await page.eval(() => document.getElementById('prCancel').click());

    /* 同名镜头 / 候选 ID 的另一部短片，必须在范围、问答和写回三处挡住串写。 */
    const twoProjects = wsOf();
    twoProjects.projects.push({ ...structuredClone(twoProjects.projects[0]), id: 'pr_other', name: '另一部短片' });
    const switchProject = () => page.eval(() => {
      const menu = document.getElementById('projMenu');
      if (menu.hidden) document.getElementById('projSwitch').click();
      const row = menu.querySelector('.pm-row[data-id="pr_other"]');
      if (!row) throw new Error('缺少另一部短片入口');
      row.click();
    });
    for (const phase of ['scope', 'ask', 'review']) {
      await boot('switch-' + phase, twoProjects);
      await readyAI({ askDelay: phase === 'ask' ? 1000 : 0 });
      await openScope();
      if (phase === 'scope') { await switchProject(); await startRun(); }
      else {
        await startRun();
        if (phase === 'ask') {
          await page.waitFor(() => window.__PO.ask === 1, 8000);
          await switchProject();
        } else {
          await waitReview();
          await switchProject();
          await page.eval(() => document.getElementById('prOk').click());
        }
      }
      await page.waitFor(() => !document.querySelector('dialog[open]')
        && /短片已切换/.test(document.getElementById('opState').textContent + (document.getElementById('banner')?.textContent || '')), 10000);
      if (phase !== 'review' && (await page.eval(() => window.__PO.calls)) !== 0) throw new Error(phase + ' 阶段切换短片后仍发出润色请求');
      const data = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
      if (JSON.stringify(data.data.projects).includes('【润】')) throw new Error(phase + ' 阶段切换短片后串写');
    }

    /* 同镜已完成与草稿分别入档；空草稿可见但不参与选择，失败候选仍属于未生成。 */
    const mixedWs = wsOf();
    const mixedShots = mixedWs.projects[0].scenes[0].shots;
    mixedShots[1].candidates[0].status = 'failed';
    mixedShots[2].candidates.push(
      { ...draft('mixed', 'sh3'), prompt: '同镜的草稿描述', origin: 'manual' },
      { ...draft('empty', 'sh3'), prompt: '', origin: 'manual' });
    await boot('mixed', mixedWs);
    await readyAI({});
    const mixedScope = await openScope();
    if (mixedScope.sum !== '已选 5 / 5 项 · 无描述 1 镜') throw new Error('混合候选计数包含空描述：' + mixedScope.sum);
    const visibleKeys = () => page.eval(() => [...document.querySelectorAll('.pl-scope-list input[data-role="take"]')].map(i => i.dataset.key));
    await chip('done');
    if ((await visibleKeys()).join('/') !== 't:sh3:v_done') throw new Error('已生成档混入同镜草稿');
    await chip('todo');
    let mixedKeys = await visibleKeys();
    if (mixedKeys.length !== 6 || mixedKeys.includes('t:sh3:v_done') || !mixedKeys.includes('t:sh3:tmp_mixed')
      || !mixedKeys.includes('t:sh3:tmp_empty') || !mixedKeys.includes('t:sh2:tmp_d_sh2')) throw new Error('未生成档没有按候选状态分类：' + mixedKeys);
    await chip('draft');
    mixedKeys = await visibleKeys();
    if (mixedKeys.length !== 5 || mixedKeys.includes('t:sh2:tmp_d_sh2')) throw new Error('草稿档混入非草稿状态：' + mixedKeys);
    await page.eval(() => {
      const group = document.querySelector('.pl-shot[data-shot="sh3"]');
      const whole = group.querySelector('input[data-role="shot"]');
      const empty = group.querySelector('input[data-key="t:sh3:tmp_empty"]');
      if (!whole.checked || whole.indeterminate || !empty.disabled || empty.checked) throw new Error('按镜全选包含空草稿');
      if (!empty.closest('.pl-take').textContent.includes('暂无描述')) throw new Error('同镜空草稿缺少占位');
      whole.click();
      if (!document.querySelector('.pl-scope-sum').textContent.startsWith('已选 3 / 5')) throw new Error('按镜取消没有覆盖被筛选隐藏的可润色候选');
    });
    await chip('done');
    if (await page.eval(() => document.querySelector('input[data-key="t:sh3:v_done"]').checked)) throw new Error('过滤隐藏的同镜候选仍被选中');
    await chip('draft');
    await toggleKey('t:sh3:tmp_mixed');
    await page.eval(() => {
      const whole = document.querySelector('.pl-shot[data-shot="sh3"] input[data-role="shot"]');
      if (whole.checked || !whole.indeterminate) throw new Error('混合状态镜头未保持半选');
      whole.click();
      if (!document.querySelector('.pl-scope-sum').textContent.startsWith('已选 5 / 5')) throw new Error('按镜全选计数没有排除空草稿');
      document.querySelector('dialog.ui-dlg .pr-foot .ghost').click();
    });
    if (await page.eval(() => window.__PO.calls)) throw new Error('仅切筛选和选择也发出了 AI 请求');
    const emptyWs = wsOf();
    emptyWs.projects[0].scenes[0].shots = [shotOf('empty', '空草稿', '')];
    await boot('empty-only', emptyWs);
    await stubAI({}); await pickShot(0);
    await page.waitFor(() => {
      const button = document.getElementById('polishAll');
      return button.disabled && button.title === '暂无候选描述';
    }, 8000);
    if (await page.eval(() => window.__PO.calls)) throw new Error('空描述项目发出了 AI 请求');

    /* 桌面与窄窗：长描述局内滚动；重画与过滤保留折叠、描述滚动、列表滚动和焦点。 */
    const longWs = wsOf();
    const longPrompt = '长描述 <雨夜> & 原始文案\n' + Array.from({ length: 80 }, (_, i) => '第 ' + (i + 1) + ' 行：雨水沿着路沿流过，远景中的路灯映在潮湿街道上。').join('\n');
    longWs.projects[0].scenes[0].shots = Array.from({ length: 32 }, (_, i) => shotOf('long' + i, '镜头 ' + (i + 1), longPrompt + '\n候选 ' + i));
    await boot('scroll', longWs);
    await readyAI({});
    for (const size of [[1440, 900], [520, 720], [390, 720]]) {
      await page.setSize(...size);
      await openScope();
      const workflowSize = await polishWorkflowFrame('润色范围 ' + size, null, '.pl-scope-list');
      const promptView = await page.eval(async () => {
        const list = document.querySelector('.pl-scope-list');
        const details = list.querySelector('details[data-prompt]');
        const body = details?.querySelector('.pl-prompt-body');
        const summary = details?.querySelector('summary');
        const row = details?.closest('.pl-take');
        if (!details || !body || !summary || details.open || !row.querySelector(':scope > label.pl-take-check')) {
          throw new Error('候选描述缺少独立的折叠结构');
        }
        if (!body.textContent.startsWith('长描述 <雨夜> & 原始文案\n') || !body.textContent.endsWith('候选 0')) throw new Error('原描述显示截断或未正确转义');
        if (details.querySelector('雨夜')) throw new Error('原描述被当成 HTML 执行');
        const closedHeight = details.getBoundingClientRect().height;
        const selected = document.querySelector('.pl-scope-sum').textContent;
        summary.click();
        await new Promise(requestAnimationFrame);
        if (!details.open || details.getBoundingClientRect().height <= closedHeight) throw new Error('原描述不能展开');
        if (document.querySelector('.pl-scope-sum').textContent !== selected || !row.querySelector('input').checked) throw new Error('展开描述误触发选择');
        if (body.clientHeight <= 0 || body.scrollHeight <= body.clientHeight || !/auto|scroll/.test(getComputedStyle(body).overflowY)) throw new Error('长描述没有局内滚动');
        const dlg = list.closest('dialog');
        const box = dlg.getBoundingClientRect();
        if (box.top < -1 || box.bottom > innerHeight + 1 || dlg.scrollWidth - dlg.clientWidth > 1) throw new Error('展开描述撑出弹窗边界');
        body.scrollTop = 120;
        return { key: details.dataset.prompt, top: body.scrollTop };
      });
      await polishWorkflowFrame('润色展开长描述 ' + size, workflowSize, '.pl-prompt-body');
      await toggleKey('t:long0:tmp_d_long0');
      await chip('done');
      await polishWorkflowFrame('润色空筛选 ' + size, workflowSize);
      await chip('draft'); await chip('all');
      await polishWorkflowFrame('润色恢复长列表 ' + size, workflowSize, '.pl-scope-list');
      await page.eval(view => {
        const details = [...document.querySelectorAll('details[data-prompt]')].find(d => d.dataset.prompt === view.key);
        if (!details?.open || Math.abs(details.querySelector('.pl-prompt-body').scrollTop - view.top) > 1) throw new Error('重画或过滤丢失描述展开与局内滚动');
      }, promptView);
      if (size[0] === 1440) await page.screenshot(require('node:path').resolve(__dirname, '../../.renders/batch-polish.png'));
      await toggleKey('t:long0:tmp_d_long0');
      await page.eval(() => document.querySelector('.pl-scope-list details[data-prompt] summary').click());
      await chip('draft'); await chip('all');
      if (await page.eval(() => document.querySelector('.pl-scope-list details[data-prompt]').open)) throw new Error('描述收起状态没有保留');
      const beforeScroll = await page.eval(() => {
        const list = document.querySelector('.pl-scope-list');
        const inputs = [...list.querySelectorAll('input[data-role="take"]')];
        if (list.scrollHeight <= list.clientHeight) throw new Error('长列表未形成滚动容器');
        list.scrollTop = Math.min(list.scrollHeight - list.clientHeight, inputs[12].offsetTop - list.offsetTop);
        window.focusQuiet(inputs[12]);
        return { top: list.scrollTop, key: inputs[12].dataset.key, outer: list.closest('.pr-body').scrollTop };
      });
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      const afterScroll = await page.eval(async () => {
        await new Promise(requestAnimationFrame);
        const list = document.querySelector('.pl-scope-list');
        const dlg = list.closest('dialog');
        return { top: list.scrollTop, key: document.activeElement.dataset.key, checked: document.activeElement.checked,
          outer: list.closest('.pr-body').scrollTop, overflow: dlg.scrollWidth - dlg.clientWidth };
      });
      if (beforeScroll.top < 1 || Math.abs(beforeScroll.top - afterScroll.top) > 1
        || Math.abs(beforeScroll.outer - afterScroll.outer) > 1 || beforeScroll.key !== afterScroll.key || afterScroll.checked) {
        throw new Error('键盘重画滚动/焦点不稳 ' + size + '：' + JSON.stringify({ beforeScroll, afterScroll }));
      }
      if (afterScroll.overflow > 1) throw new Error('范围弹窗横向溢出 ' + size + '：' + afterScroll.overflow);
      await page.eval(() => {
        const ids = [...document.querySelectorAll('.pl-shot')].map(x => x.dataset.shot);
        ids.forEach(id => {
          const inp = [...document.querySelectorAll('.pl-shot')].find(x => x.dataset.shot === id).querySelector('input[data-role="shot"]');
          if (inp.indeterminate) inp.click();
          const next = [...document.querySelectorAll('.pl-shot')].find(x => x.dataset.shot === id).querySelector('input[data-role="shot"]');
          if (next.checked) next.click();
        });
        if (!document.querySelector('dialog.ui-dlg .pr-foot .pri').disabled) throw new Error('零选择仍可开始');
        const first = document.querySelector('.pl-shot input[data-role="shot"]');
        window.focusQuiet(first); first.click();
        if (document.activeElement.dataset.role !== 'shot') throw new Error('镜头复选框焦点丢失');
        if (document.querySelector('dialog.ui-dlg .pr-foot .pri').disabled) throw new Error('重新勾选后不能开始');
        document.querySelector('dialog.ui-dlg .pr-foot .ghost').click();
      });

      await readyAI({ questions: true, hold: true, longText: longPrompt });
      await openScope();
      await polishWorkflowFrame('润色重新选范围 ' + size, workflowSize);
      await startRun();
      await page.waitFor(() => !!document.querySelector('#prDlg .pinl-qa'), 8000);
      await polishWorkflowFrame('润色问答 ' + size, workflowSize);
      await page.eval(() => {
        document.querySelector('#prDlg .pinl-opt[data-j="1"]').click();
        document.querySelector('#prDlg [data-act="go"]').click();
      });
      await page.waitFor(() => window.__PO.releases.length >= 2
        && document.querySelector('#prDlg .pr-proc-tx')?.textContent.includes('【流式】'), 8000);
      await polishWorkflowFrame('润色流式短内容 ' + size, workflowSize, '#prBody');
      await page.eval(() => window.__PO.more.forEach(push => push()));
      await page.waitFor(() => document.querySelector('#prDlg .pr-proc-tx')?.textContent.includes('第 80 行'), 8000);
      await polishWorkflowFrame('润色流式长内容 ' + size, workflowSize, '.pr-proc-tx');
      await page.eval(() => {
        window.__PO.released = true;
        window.__PO.releases.splice(0).forEach(resolve => resolve());
      });
      await waitReview();
      await polishWorkflowFrame('润色长审阅 ' + size, workflowSize, '#prBody');
      await polishWorkflowFrame('润色审阅长文案 ' + size, workflowSize, '.pr-row textarea');
      await page.eval(() => {
        while (document.querySelectorAll('#prDlg .pr-row').length > 1) document.querySelector('#prDlg [data-del]').click();
      });
      await polishWorkflowFrame('润色审阅仅余一条 ' + size, workflowSize);
      await page.eval(() => document.getElementById('prCancel').click());

      /* 生成入口只验证范围配置，报价打桩且不提交生成。 */
      await page.eval(async () => {
        const reg = await window.Api.registry();
        for (const prov of reg.providers.filter(p => p.kind === 'video')) window.LS.set('sk_key_' + (prov.keyId || prov.id), 'sk-probe');
        window.AssetLib.estimateCost = async () => ({ ok: true, amount: 1, text: '探针报价' });
      });
      await pickShot(1); await pickShot(0);
      await page.waitFor(() => !document.getElementById('genAll').disabled, 8000);
      await page.eval(() => document.getElementById('genAll').click());
      await page.waitFor(() => !!document.querySelector('dialog .batch-settings'), 8000);
      await polishWorkflowFrame('生成全部分镜范围 ' + size, workflowSize, '.pl-scope-list');
      await page.eval(() => document.querySelector('dialog .pl-prompt summary').click());
      await polishWorkflowFrame('生成展开长描述 ' + size, workflowSize, '.pl-prompt-body');
      for (const filter of ['bad', 'can', 'draft', 'all']) {
        await page.eval(f => document.querySelector('dialog .pl-scope-chips [data-f="' + f + '"]').click(), filter);
        await polishWorkflowFrame('生成筛选 ' + filter + ' ' + size, workflowSize);
      }
      await page.eval(() => document.querySelector('dialog.ui-dlg .pr-foot .ghost').click());
      checkConsole();
    }
    checkConsole();
    console.log('director-polish-all: 各阶段固定尺寸/标题页脚固定/520窄窗/生成范围筛选/ 候选级筛选/草稿与空描述/两级选择/分段高亮/原描述折叠与局内滚动/键盘焦点/双尺寸滚动/备注问答/流式并发/审阅写回/停止取消/失败详情/项目身份保护通过');
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
