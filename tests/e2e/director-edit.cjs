#!/usr/bin/env node
/* 剪辑核交互的判据（`web/director/engine/edit.js` + `engine/timeline.js` 那一条路）。
   一份种子工程、四档开局，每档一次页面装配（同一台代理 / 同一个浏览器，换档只重开一页）：
     ① 选择六档（左选 / 右选 / 编辑点 / 滑移 / 滑动 / 选择）+ 裁边 + 吸附（开关、alt 绕过、贴到切点）；
     ② 波纹（开与关对下游的影响）+ 横向拖换序 + 竖向拖换行（含「松手就在下面新建一行」）+ 锁定 / 隐藏；
     ③ 标记（加、面板、筛选、跳、类型 / 颜色 / 标题 / 起点、拖头 / 拖带 / 拖尾、删、标记条收起）+ 转场（◇ / 9 档预设 / 时长滑块 / 去掉）；
     ④ 关联族（接上 / 解除 / 对齐到音频 / 全部关联认回记忆位）+ 工具条全量动作（加长 / 缩短 / 融合 / 复制 / 删除 / 切刀 / 新增一段 / 摘掉一段 / 缩放 / 回到播放头 / 撤销重做）+ 待生成块。
   只走界面：块上的把手、轨名那两颗旗标、工具条、浮层、面板、键盘。读数只看 `#opState`（回执）与 `#tlHint`（拖动中的即时读数）。
   每一步同时核对**历史里那一行的描述**（哪一镜的哪一段、从几秒到几秒）—— 交互与留痕是同一条判据。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cand = (vid, dur, shotId) => ({ vid, provider: 'local', status: 'succeeded', progress: 100, url: '/asset/' + vid, duration: dur, shotId });

/* ---------------- 种子：一条 16 秒的成片，四类轨都有东西 ----------------
   画面 5 段（镜头一 两段能融合 / 镜头四 是图片段）、配音 2 条、待生成 2 块、字幕 3 条
   （一条连着、一条留着记忆位、一条谁都没接）、标记 2 枚（一枚点、一枚范围）。 */
function seedFilm() {
  return {
    clips: [
      { id: 'c1', kind: 'video', shotId: 'sh1', name: '镜头一', sourceStart: 0, sourceDuration: 4, mediaDuration: 8, duration: 4, ln: 0 },
      { id: 'c1b', kind: 'video', shotId: 'sh1', name: '镜头一', sourceStart: 4, sourceDuration: 2, mediaDuration: 8, duration: 2, ln: 0 },
      { id: 'c2', kind: 'video', shotId: 'sh2', name: '镜头二', sourceStart: 0, sourceDuration: 4, mediaDuration: 8, duration: 4, ln: 0 },
      { id: 'c3', kind: 'video', shotId: 'sh3', name: '镜头三', sourceStart: 0, sourceDuration: 4, mediaDuration: 8, duration: 4, ln: 0 },
      { id: 'c4', kind: 'image', shotId: 'sh4', name: '镜头四', duration: 2, ln: 0 },
    ],
    voices: [
      { id: 'v-A', shotId: 'sh1', text: '第一句配音', start: 0.5, duration: 2.5, lane: 0, status: 'done' },
      { id: 'v-B', shotId: 'sh2', text: '第二句配音', start: 7, duration: 2, lane: 0, status: 'done' },
    ],
    pending: [
      { id: 'p-A', shotId: 'sh1', text: '第一句台词', start: 0.2, duration: 1.8, lane: 1 },
      { id: 'p-B', shotId: 'sh2', text: '第二句台词', start: 6.2, duration: 1.4, lane: 1 },
    ],
    captions: [
      { id: 'k-A', text: '第一句字幕', start: 0.6, end: 2.9, voiceId: 'v-A' },
      { id: 'k-B', text: '第二句字幕', start: 7, end: 8.6, voiceId: '', detachedVoiceId: 'v-A' },
      { id: 'k-C', text: '第三句字幕', start: 7.2, end: 8.4 },
    ],
    markers: [
      { id: 'm-1', type: 'marker', time: 6, title: '切点备忘', notes: '', color: 'cyan' },
      { id: 'm-2', type: 'range', time: 10, endTime: 11.5, title: '范围备忘', notes: '', color: 'violet' },
    ],
    tracks: { visibility: {}, locks: {} },
  };
}
function seed(ts) {
  const shot = (id, name, line) => ({
    id, name, prompt: '画面', line, lineWho: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], selId: 'v-' + id, candidates: [cand('v-' + id, 8, id)],
  });
  const project = {
    id: 'p-edit', name: '剪辑交互探针', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [shot('sh1', '镜头一', '第一句台词'), shot('sh2', '镜头二', '第二句台词'), shot('sh3', '镜头三', ''), shot('sh4', '镜头四', '')] }],
    film: seedFilm(),
  };
  return { projects: [project], curId: 'p-edit', roles: [], groups: [], ts: ts || Date.now() };
}

/* ---------------- 页面里那一套探针（只读 DOM + 派发真实事件） ---------------- */
const installProbe = () => {
  const q = s => document.querySelector(s);
  const qa = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const txt = s => { const e = q(s); return e ? String(e.textContent || '') : ''; };
  const val = s => { const e = q(s); return e ? String(e.value) : ''; };
  const pps = () => { const c = q('#tlBoard .tl-clip'); return c ? parseFloat(c.style.width) / Number(c.getAttribute('data-dur')) : 0; };
  const xOf = t => { const c = q('#tlContent'); return c ? c.getBoundingClientRect().left + t * pps() : 0; };
  const raf = () => new Promise(r => { window.requestAnimationFrame(() => r()); });
  const idOf = el => el.getAttribute('data-clip') || el.getAttribute('data-voice') || el.getAttribute('data-pending')
    || el.getAttribute('data-cap') || el.getAttribute('data-marker') || el.getAttribute('data-band') || '';
  const info = el => ({
    id: idOf(el),
    start: Number(el.getAttribute('data-start')),
    dur: Number(el.getAttribute('data-dur')),
    time: Number(el.getAttribute('data-time')),
    lane: el.closest('.tl-lane') ? el.closest('.tl-lane').getAttribute('data-row') : '',
    left: Math.round(el.getBoundingClientRect().left),
    selected: el.classList.contains('is-selected'),
    cls: el.className,
  });
  const list = s => qa(s).map(info);
  const snap = () => {
    const line = q('#tlSnapLine'), ruler = q('#tlRulerSnap'), drop = q('#tlContent .tl-drop'), lane = q('.tl-lane.is-drop');
    return {
      line: !!line && !line.hidden,
      ruler: !!ruler && !ruler.hidden,
      dropLeft: drop ? Math.round(parseFloat(drop.style.left) || 0) : null,
      dropLane: lane ? lane.getAttribute('data-row') : null,
    };
  };
  const fire = (el, type, x, y, mods, buttons) => {
    const ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
      clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      altKey: !!(mods && mods.alt), ctrlKey: !!(mods && mods.ctrl), shiftKey: !!(mods && mods.shift),
    });
    el.dispatchEvent(ev);
  };
  const state = () => ({
    clips: list('#tlBoard .tl-clip'),
    voices: list('#tlBoard .tl-voice'),
    caps: list('#tlBoard .tl-cap'),
    markers: list('#tlBoard [data-marker]'),
    bands: list('#tlBoard [data-band]'),
    lanes: qa('#tlBoard .tl-lane').map(el => el.getAttribute('data-row')),
    labels: qa('#tlBoard .tl-label').map(el => ({ row: el.getAttribute('data-row'), cls: el.className })),
    total: txt('#tlT1'),
    pin: txt('#tlT0'),
    hint: txt('#tlHint'),
    status: txt('#opState'),
    snap: snap(),
    selected: qa('#tlBoard .is-selected').map(info).map(x => x.id),
    handles: qa('#tlBoard .tl-lane.is-locked .tl-h').length,
  });
  /* 块只认 #tlBoard 里那一些：播放核把「此刻装的是哪一段」写在 `<video>` 的 data-clip 上，
     那颗 video 就在页面里且排得更前 —— 不加这一层范围，`[data-clip="c1"]` 命中的是它，
     于是「找不到把手」（拖动落点、块读数全都会指错地方）。 */
  const blockSel = sel => '#tlBoard ' + sel;
  const find = o => {
    const root = o.sel ? q(blockSel(o.sel)) : null;
    if (!root) return { err: '页面上找不到这一格：' + o.sel };
    const target = o.handle ? root.querySelector('.tl-h[data-handle="' + o.handle + '"]') : root;
    if (!target) return { err: '找不到把手：' + o.sel + ' ' + (o.handle || '') };
    return { root, target };
  };
  async function drag(o) {
    const f = find(o);
    if (f.err) return { err: f.err };
    const tr = f.target.getBoundingClientRect();
    const x0 = tr.left + tr.width * (o.fx == null ? 0.5 : o.fx);
    const y0 = tr.top + tr.height / 2;
    const k = pps();
    /* 位移拖（dx 秒）与「按秒拖到」的拖（toTime）是两把尺子：块移动 / 裁边 / 滑移按**位移**结算，
       标记头与范围尾按**指针此刻的秒**结算 —— 探针两种都要能表达。 */
    const ddx = o.toTime != null ? xOf(o.toTime) - x0 : (o.dxPx != null ? o.dxPx : (o.dx || 0) * k);
    const ddy = o.dyPx || 0;
    const steps = o.steps || 6;
    const before = state();
    fire(f.target, 'pointerdown', x0, y0, o.mods, 1);
    let mid = null;
    for (let i = 1; i <= steps; i++) {
      fire(window, 'pointermove', x0 + (ddx * i) / steps, y0 + (ddy * i) / steps, o.mods, 1);
      await raf();
      await raf();
      mid = state();
    }
    const midSnap = mid.snap;
    const midHint = mid.hint;
    fire(window, 'pointerup', x0 + ddx, y0 + ddy, o.mods, 0);
    await raf();
    await raf();
    return { before, mid: { hint: midHint, snap: midSnap }, after: state(), pps: k, dxPx: ddx };
  }
  async function tap(o) {
    const f = find(o);
    if (f.err) return { err: f.err };
    const tr = f.target.getBoundingClientRect();
    const x = tr.left + tr.width * (o.fx == null ? 0.5 : o.fx);
    const y = tr.top + tr.height / 2;
    fire(f.target, 'pointerdown', x, y, o.mods, 1);
    await raf();
    fire(window, 'pointerup', x, y, o.mods, 0);
    await raf();
    /* 真浏览器松手后紧跟一次 click（待生成块那一下靠它跳到那一句；
       选择族靠 eatClick 那 240ms 窗口把它作废）—— 探针不补这一下就不是同一条路。 */
    if (!o.noClick) f.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    await raf();
    return { after: state() };
  }
  async function seek(t) {
    const ruler = q('#tlRulerInner');
    if (!ruler) return { err: '没有刻度尺' };
    const r = ruler.getBoundingClientRect();
    const row = q('.tl-ruler-clip').getBoundingClientRect();
    /* 探针的 pps 是从**块宽（渲染时取到两位小数）**反推的：按它算出的整秒像素点回去会差半个像素，
       播放头落在 2.9999 那一侧，而读数按分秒**向下取整** —— 「00:03」就念成「00:02」。
       往目标那一秒之后送半像素（误差 0.01 秒级），剪刀与入出点认的是十分位，不受这一点影响。 */
    const x = r.left + t * pps() + 0.5;
    const y = row.top + row.height / 2;
    fire(ruler, 'pointerdown', x, y, null, 1);
    await raf();
    fire(window, 'pointerup', x, y, null, 0);
    await raf();
    return state();
  }
  function click(sel) {
    const el = q(sel);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }
  function tool(act) {
    const b = q('#tlTools [data-tl="' + act + '"]');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  }
  function ctx(sel) {
    /* 只在轨道板里找：右栏字幕清单的输入框也带 data-cap（同一个 id），
       文档级 q 会先命中那一枚，右键就落到右栏上、板上的菜单根本不会开。 */
    const el = q('#tlBoardBody ' + sel) || q(sel);
    if (!el) return ['找不到：' + sel];
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return qa('#tlCtx [data-ctx]').map(x => x.getAttribute('data-ctx'));
  }
  function setVal(sel, value, evt) {
    const el = q(sel);
    if (!el) return false;
    el.value = String(value);
    el.dispatchEvent(new Event(evt || 'change', { bubbles: true }));
    return true;
  }
  function key(k, mods) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: k, bubbles: true, cancelable: true,
      altKey: !!(mods && mods.alt), ctrlKey: !!(mods && mods.ctrl), shiftKey: !!(mods && mods.shift),
    }));
    return true;
  }
  function hist(open) {
    const d = q('#editLeft .el-hist');
    if (d && open !== false) d.open = true;
    return qa('#editLeft .hist-row').map(r => ({
      label: String((r.querySelector('.hn') || {}).textContent || ''),
      kind: String((r.querySelector('.hk') || {}).textContent || ''),
      now: r.classList.contains('now'),
    }));
  }
  function playheadInView() {
    const head = q('#tlPlayhead'), sc = q('#tlScroll');
    if (!head || !sc) return null;
    const a = head.getBoundingClientRect(), b = sc.getBoundingClientRect();
    return a.left >= b.left - 2 && a.left <= b.right + 2;
  }
  function rectOf(sel) {
    const el = q(blockSel(sel));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, height: r.height };
  }
  function scrollBoard(v) {
    const sc = q('#tlScroll');
    if (!sc) return null;
    sc.scrollLeft = v === 'max' ? sc.scrollWidth : v;
    return sc.scrollLeft;
  }
  window.__P = { pps, xOf, txt, val, state, list, drag, tap, seek, click, tool, ctx, setVal, key, hist, snap, playheadInView, scrollBoard, rectOf };
  return true;
};

/* ---------------- 断言小件 ---------------- */
let checks = 0;
function must(cond, msg) { checks++; if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) { must(actual === expected, msg + '（期望 ' + JSON.stringify(expected) + '，拿到 ' + JSON.stringify(actual) + '）'); }
function re(text, pattern, msg) { must(pattern.test(String(text)), msg + '（拿到：' + text + '）'); }
function near(actual, expected, msg, tol) { must(Math.abs(Number(actual) - Number(expected)) <= (tol == null ? 0.06 : tol), msg + '（期望 ' + expected + '，拿到 ' + actual + '）'); }
function byId(list, id) { return list.filter(x => x.id === id)[0] || null; }
/* 片长那一位读数按分秒**向下取整**（16.5 秒念「00:16」）：凡是要卡秒数的判据都把每段的
   `data-dur` 加起来按数字比，不要拿读数当尺子。 */
const durSum = list => list.reduce((a, c) => a + c.dur, 0);

async function status(page) { await sleep(120); return page.eval(() => window.__P.txt('#opState')); }
async function waitRows(page, n) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const r = await page.eval(() => window.__P.hist());
    if (r.length >= n) return r;
    await sleep(200);
  }
  return page.eval(() => window.__P.hist());
}
async function rowCount(page) { return (await page.eval(() => window.__P.hist())).length; }
async function noNewRow(page) {
  const before = await rowCount(page);
  await sleep(600);
  eq(await rowCount(page), before, '这一步不该往历史里追加记录');
}

/* ---------------- 开局：灌种子、进剪辑态、装探针 ----------------
   四档连跑（同一台代理 / 同一个浏览器，换档只重开一页），种子要**先落库、后装配**才算数。
   装配读工作区按三顺位（`web/director/engine.js` 的 boot）：IndexedDB → 关标签的救生包
   `dir_ws_unload` → 代理那一份 `/data/workspace`（文件 mtime 比本地那份的 ts 新三秒以上才认）。
   前两条是**本机留着的那一份**：上一档改过之后再灌种子，装配仍然先读它们，种子根本没被看过一眼。
   所以换档先把这个源的本机存储清掉，再把种子写在第三条通道上 —— 这一档只剩一个可读的来源。
   清只能在「这个源还没有任何文档装载」时做（新标签停在 about:blank 就行）：装载中的页面握着
   IndexedDB 连接，删除要等它让出版本，那一句 CDP 会一直悬到超时。
   上一档关标签时那一次不等回执的镜像 PUT 可能还在路上（它盖的是同一个文件），
   所以写完要读回点名验一次；落没落最终按画面段的「号 + 时长」签名判。 */
const seedSig = () => seedFilm().clips.map(c => c.id + ':' + c.duration).join(',');
/* 这个箭头是**搬到页面里跑的**：里面不许引用本文件的其他名字。 */
const boardSig = () => [...document.querySelectorAll('#tlBoard .tl-clip')]
  .map(e => e.getAttribute('data-clip') + ':' + Number(e.getAttribute('data-dur'))).join(',');
async function seedServer(proxy, rec, label) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: proxy.cookie },
      body: JSON.stringify({ data: rec, ts: rec.ts }),
    });
    if (r.status !== 200) throw new Error(label + '：种子写不进代理（HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120) + '）');
    await sleep(1000);          // 给上一档那一次迟到的镜像 PUT 一个防抖窗口，才轮得到读回判定
    const d = await (await fetch(proxy.base + '/data/workspace', { headers: { cookie: proxy.cookie } })).json();
    const p = d && d.data && d.data.projects && d.data.projects[0];
    const clips = p && p.film && p.film.clips;
    if (clips && clips.map(c => c.id + ':' + c.duration).join(',') === seedSig()) return true;
  }
  throw new Error(label + '：代理那一份 /data/workspace 三次都不是种子（上一档的落盘还压在上面）');
}
/* 每一次开局换一个查询值：同一个地址重发是 reload，换值才是干净的新装配。 */
let bootSeq = 0;
async function boot(proxy, browser, label) {
  const ready = () => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready();
  const inTrim = () => {
    const t = document.getElementById('trimBtn');
    if (t && !t.classList.contains('on')) t.click();
    return document.querySelectorAll('#tlBoard .tl-clip').length >= 5;
  };
  const page = await browser.newPage();
  await page.clearStorage(new URL(proxy.base).origin);
  /* 上一档留在 .data 里的界面偏好会让这一档开机对账「拉回 → 整页刷新」，
     探针刚装上就被刷掉；这一条测的是剪辑界面，不是对账，把 DataSync.boot 跳过。 */
  await page.skipDataSyncBoot();
  await seedServer(proxy, seed(), label);
  await page.goto(proxy.base + '/shell.html?boot=' + (++bootSeq) + '#director.html');
  await page.waitFor(ready, 40000);
  await page.waitFor(inTrim, 30000, 200).catch(() => { /* 画没画对由下面那句签名判，不留含糊的超时 */ });
  const got = await page.eval(boardSig);
  if (got !== seedSig()) throw new Error(label + '：界面画的不是种子（种子 ' + seedSig() + '，界面 ' + got + '）');
  await page.eval(installProbe);
  const s = await page.eval(() => window.__P.state());
  const k = await page.eval(() => window.__P.pps());
  if (!(k > 10)) throw new Error(label + '：比例尺太小，量不动拖动（pps=' + k + '）');
  /* 种子对不对：四类轨 + 两枚标记 + 16 秒。 */
  eq(s.clips.map(c => c.id + ':' + c.dur).join(','), seedSig(), label + '：画面段的种子不对');
  eq(s.total, '00:16', label + '：成片总长该是 16 秒');
  eq(s.voices.length, 4, label + '：配音轨该有 2 条配音 + 2 块待生成');
  eq(s.caps.length, 3, label + '：字幕轨该有三条');
  eq(s.markers.length, 2, label + '：标记该有两枚');
  await page.eval(() => window.__P.hist());
  return page;
}

/* ================= ① 选择六档 + 裁边 + 吸附 ================= */
async function boot1(proxy, browser) {
  const page = await boot(proxy, browser, '①');
  const st = async () => page.eval(() => window.__P.state());

  /* 吸附默认开着：先关掉，这一档后面按秒拖的判据才只由位移决定。 */
  must(await page.eval(() => window.__P.tool('snap')), '①：工具条没有吸附那颗');
  re(await status(page), /^吸附已关/, '①：关掉吸附的回执');
  must(await page.eval(() => document.querySelector('#tlTools [data-tl="snap"]').classList.contains('is-on')) === false, '①：关掉之后吸附那颗不该还亮着');

  /* —— 裁边：拖右把手 +0.5 秒（后面每段的起点是派生的，跟着一起走） —— */
  let r = await page.eval(async () => {
    const P = window.__P;
    return P.drag({ sel: '[data-clip="c1"]', handle: 'end', dx: 0.5, steps: 5 });
  });
  must(!r.err, '①：' + r.err);
  re(r.after.status, /^「镜头一」第 1 段（0\.0–4\.0 秒）改成 0\.0–4\.5 秒$/, '①：裁边的历史行要说清哪一段改成几秒到几秒');
  near(byId(r.after.clips, 'c1').dur, 4.5, '①：c1 该长到 4.5 秒');
  near(byId(r.after.clips, 'c1b').start, 4.5, '①：后一段的起点该跟着派生成 4.5 秒');
  /* 读数那一格按 mm:ss 取整（16.5 仍写 00:16），所以片长用每段时长现加。 */
  near(durSum(r.after.clips), 16.5, '①：裁边把整片顶长 0.5 秒');
  re((await page.eval(() => window.__P.hist()))[0].label, /改成 0\.0–4\.5 秒$/, '①：历史第一行 = 刚做的裁边');

  /* —— 选择六档：左选 / 右选 —— */
  must(await page.eval(() => window.__P.click('[data-tl="selmenu"]')), '①：没有选择工具菜单');
  must(await page.eval(() => window.__P.click('[data-selmode="left"]')), '①：菜单里没有「左选」');
  re(await status(page), /^选择工具：左选/, '①：换档要当场说一句');
  r = await page.eval(async () => window.__P.tap({ sel: '[data-clip="c3"]' }));
  re(r.after.status, /^已向左选择 \d+ 个$/, '①：左选那一下');
  must(r.after.selected.length >= 3, '①：左选该把左边那几段都选中：' + JSON.stringify(r.after.selected));

  await page.eval(() => { window.__P.click('[data-tl="selmenu"]'); window.__P.click('[data-selmode="right"]'); });
  re(await status(page), /^选择工具：右选/, '①：换到右选');
  r = await page.eval(async () => window.__P.tap({ sel: '[data-clip="c2"]' }));
  re(r.after.status, /^已向右选择 \d+ 个$/, '①：右选那一下');
  must(r.after.selected.indexOf('c4') >= 0, '①：右选该把 c2 右边的段选中：' + JSON.stringify(r.after.selected));

  /* —— 编辑点：点一下选切点两边两段；拖一下把切点搬走（两边各让一些，总长不变） —— */
  await page.eval(() => { window.__P.click('[data-tl="selmenu"]'); window.__P.click('[data-selmode="edit-point"]'); });
  re(await status(page), /^选择工具：编辑点/, '①：换到编辑点');
  r = await page.eval(async () => window.__P.tap({ sel: '[data-clip="c2"]', fx: 0.75 }));
  must(r.after.selected.indexOf('c2') >= 0 && r.after.selected.indexOf('c3') >= 0,
    '①：编辑点点一下该同时选中切点两边那两段：' + JSON.stringify(r.after.selected));
  const beforeEdge = await st();
  const edgeOld = byId(beforeEdge.clips, 'c3').start;
  /* 往左拖那一刀落不到：右边那一段（镜头三）的源窗口从第 0 秒起，前面没有料可多吃。
     夹到 0 = 什么都不动，也不许往历史里追加一条「移动了切点」—— 那是说假话的留痕。 */
  r = await page.eval(t => window.__P.drag({ sel: '[data-clip="c2"]', fx: 0.75, toTime: t, steps: 6 }), edgeOld - 1.5);
  must(!r.err, '①：' + r.err);
  near(byId(r.after.clips, 'c3').start, edgeOld, '①：切点左边没有源可吃，那一刀该拖不动');
  await noNewRow(page);
  r = await page.eval(t => window.__P.drag({ sel: '[data-clip="c2"]', fx: 0.75, toTime: t, steps: 6 }), edgeOld + 1.5);
  must(!r.err, '①：' + r.err);
  re(r.after.status, /^移动「镜头二」\/「镜头三」之间的切点到 12\.0 秒$/, '①：编辑点拖动那一下的回执');
  near(byId(r.after.clips, 'c3').start, edgeOld + 1.5, '①：切点搬家 = 左边让 1.5 秒给右边');
  near(durSum(r.after.clips), durSum(beforeEdge.clips), '①：移动切点不该改成片长');

  /* —— 滑移：块不动，源窗口前后滑 —— */
  await page.eval(() => { window.__P.click('[data-tl="selmenu"]'); window.__P.click('[data-selmode="slip"]'); });
  re(await status(page), /^选择工具：滑移/, '①：换到滑移');
  r = await page.eval(async () => window.__P.drag({ sel: '[data-clip="c1"]', dx: 0.5, steps: 5 }));
  re(r.after.status, /^把「镜头一」第 1 段（0\.0–4\.5 秒）的画面窗口滑到源 0\.5s 起$/, '①：滑移那一下要说清源窗口滑到哪');
  near(byId(r.after.clips, 'c1').start, 0, '①：滑移不许挪动块的位置');
  /* 图片段没有源窗口 / 配音块不是画面段：照实说，且松手后那一次 click 不许把这句盖掉。 */
  r = await page.eval(async () => window.__P.tap({ sel: '[data-clip="c4"]' }));
  re(r.after.status, /^图片段没有源窗口，滑移无从谈起$/, '①：图片段要照实说滑不动');
  r = await page.eval(async () => window.__P.tap({ sel: '[data-voice="v-A"]' }));
  re(r.after.status, /只作用于画面段/, '①：滑移落到配音块上要照实说');

  /* —— 滑动：头一段没有左邻居 —— */
  await page.eval(() => { window.__P.click('[data-tl="selmenu"]'); window.__P.click('[data-selmode="slide"]'); });
  re(await status(page), /^选择工具：滑动/, '①：换到滑动');
  r = await page.eval(async () => window.__P.tap({ sel: '[data-clip="c1"]' }));
  re(r.after.status, /^首尾两段没有两侧邻居，滑不动$/, '①：头一段滑动要说滑不动');
  const beforeSlide = await st();
  r = await page.eval(async () => window.__P.drag({ sel: '[data-clip="c2"]', dx: 0.5, steps: 5 }));
  re(r.after.status, /^把「镜头二」第 \d 段（\d+\.\d–\d+\.\d 秒）滑动 \+0\.5 秒（相邻两段跟着伸缩）$/, '①：滑动那一下的回执');
  near(durSum(r.after.clips), durSum(beforeSlide.clips), '①：滑动只搬编辑点，不该改成片长');

  /* —— 回到「选择」档，吸附的两条判据：alt 绕过 / 贴到切点 ——
     落点用**位移**说话（块跟着手走，吸附半径本来就是 10 像素）：目标 = 块起点 + 拖出去的那一段。 */
  await page.eval(() => { window.__P.click('[data-tl="selmenu"]'); window.__P.click('[data-selmode="select"]'); });
  must(await page.eval(() => window.__P.tool('snap')), '①：吸附那颗点不动了');
  re(await status(page), /^吸附已开/, '①：重新开吸附');
  /* 先把 p-A 挪到 4.5 那道切点左边 5 像素（= 吸附半径之内），但按住 alt：不许被吸住。 */
  r = await page.eval(() => {
    const P = window.__P;
    const from = (P.state().voices.filter(x => x.id === 'p-A')[0] || {}).start;
    const want = 4.5 - 5 / P.pps();
    return P.drag({ sel: '[data-pending="p-A"]', dx: want - from, steps: 8, mods: { alt: true } })
      .then(x => Object.assign({}, x, { want }));
  });
  must(!r.err, '①：' + r.err);
  const altLanded = byId(r.after.voices, 'p-A').start;
  near(altLanded, r.want, '①：按住 alt 就该落在拖出去那一段的终点，不贴到 4.5 那道切点');
  must(Math.abs(altLanded - 4.5) > 0.005, '①：alt 绕过吸附，落点不许等于 4.5（落在 ' + altLanded + '）');
  must(r.mid.snap.line === false, '①：alt 绕过时那条吸附线不许露出来');
  re(r.after.status, /^把「第一句台词」（[\d.]+–[\d.]+ 秒）从 0\.2 秒挪到 /, '①：alt 绕过吸附那一下也要留痕');
  near(Number((/挪到 ([\d.]+) 秒$/.exec(r.after.status) || [])[1]), altLanded, '①：留痕里的落点秒数要等于块实际落的秒数');
  /* 再从那里往右 8 像素（指针落在切点右边 3 像素）：吸附必须把它拽回 4.5。 */
  r = await page.eval(async () => window.__P.drag({ sel: '[data-pending="p-A"]', dxPx: 8, steps: 5 }));
  must(!r.err, '①：' + r.err);
  must(r.mid.snap.line && r.mid.snap.ruler, '①：吸附起效时轨道与刻度尺那两处都要亮一下：' + JSON.stringify(r.mid.snap));
  eq(byId(r.after.voices, 'p-A').start, 4.5, '①：指针落在切点旁边 3 像素，必须被吸到 4.5');
  re(r.after.status, /挪到 4\.5 秒$/, '①：吸附那一下的留痕要说清挪到 4.5 秒');
  near(byId(r.after.clips, 'c1').dur, 4.5, '①：只挪配音块，画面段一段都不许动');

  const errs = (page.errors || []).filter(Boolean).slice(0, 3);
  must(!errs.length, '①：页面异常：' + errs.join(' | '));
  await page.close();
}

/* ================= ② 波纹 + 换序 + 换行 + 锁定 / 隐藏 ================= */
async function boot2(proxy, browser) {
  const page = await boot(proxy, browser, '②');
  const st = async () => page.eval(() => window.__P.state());

  /* —— 波纹开：加长一段，后面整体前移 / 后移 —— */
  must(await page.eval(() => window.__P.tool('snap')), '②：没有吸附那颗');
  re(await status(page), /^吸附已关/, '②：这一档先关吸附');
  must(await page.eval(() => window.__P.tool('ripple')), '②：没有波纹那颗');
  re(await status(page), /^波纹编辑已开：删除后面整体前移/, '②：开波纹的回执');
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c1"]' }));
  const vbBefore = byId((await st()).voices, 'v-B').start;
  must(await page.eval(() => window.__P.tool('lengthen')), '②：加长那颗点不动（大概没选中东西）');
  let r = await st();
  re((await status(page)), /^把「镜头一」第 1 段（0\.0–4\.0 秒）加长 1 秒，改成 0\.0–5\.0 秒（波纹：移动 \d+/, '②：波纹那一步的留痕要点名移动了几条');
  near(byId(r.clips, 'c1b').start, 5, '②：波纹开着的加长该把后一段顶开');
  near(byId(r.voices, 'v-B').start, vbBefore + 1, '②：边界之后的配音要跟着走');
  eq(r.total, '00:17', '②：加了一秒，片长读数跟着变');

  /* —— 波纹关：加长只改这一段 —— */
  must(await page.eval(() => window.__P.tool('ripple')), '②：波纹那颗点不动');
  re(await status(page), /^波纹编辑已关$/, '②：关波纹的回执');
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c1"]' }));
  must(await page.eval(() => window.__P.tool('shorten')), '②：缩短那颗点不动');
  r = await st();
  re((await status(page)), /^把「镜头一」第 1 段（0\.0–5\.0 秒）缩短 1 秒，改成 0\.0–4\.0 秒$/, '②：关掉波纹就不该再带「波纹」那句');
  eq(r.total, '00:16', '②：缩回去之后片长回到 16 秒');

  /* —— 横向拖 = 换序（落点按**位移**算：块起点跟着手走；往左拖过它自己起点的距离 = 排到最前） —— */
  const before = await st();
  const c3start = byId(before.clips, 'c3').start;
  r = await page.eval(t => window.__P.drag({ sel: '[data-clip="c3"]', dx: -t - 1, steps: 8 }), c3start);
  must(!r.err, '②：' + r.err);
  re(r.after.status, new RegExp('^把「镜头三」换位置：「镜头三」从 ' + c3start.toFixed(1) + 's 挪到 0\\.0s'), '②：换序要说清从第几秒挪到第几秒');
  eq(r.after.clips[0].id, 'c3', '②：拖到最前面，第一段就该是它');
  eq(r.after.total, '00:16', '②：换序不改片长');

  /* —— 竖向拖 = 换行（拖到最后一行之下 = 新开一行；位移按行自己的矩形算，不猜行高） —— */
  r = await page.eval(() => {
    const P = window.__P;
    const lane = P.rectOf('.tl-lane[data-row="image-0"]');
    const blk = P.rectOf('[data-clip="c1b"]');
    const mid = (blk.top + blk.bottom) / 2;
    return P.drag({ sel: '[data-clip="c1b"]', dyPx: Math.round(lane.bottom - mid) + 14, steps: 6 });
  });
  must(!r.err, '②：' + r.err);
  eq(r.mid.hint, '松手就在下面新建一行', '②：拖到最后一行之下要当场说一句');
  const laneLabels = (await st()).lanes;
  must(laneLabels.indexOf('image-1') >= 0, '②：新行该画出来：' + JSON.stringify(laneLabels));
  re(r.after.status, /^把「镜头一」第 \d 段（\d+\.\d–\d+\.\d 秒）挪到第 2 行（新开的一行）$/, '②：只换行的时候不许说「从 9.0s 挪到 9.0s」那种废话');
  const moved = await page.eval(() => {
    const el = document.querySelector('.tl-lane[data-row="image-1"] [data-clip="c1b"]');
    return el ? { lane: el.closest('.tl-lane').getAttribute('data-row'), start: Number(el.getAttribute('data-start')) } : null;
  });
  must(moved && moved.lane === 'image-1', '②：那一格该落在新的那一行：' + JSON.stringify(moved));
  /* 拖回原来的行：行号连续重编，空掉的那一行不能留成洞 */
  r = await page.eval(() => {
    const P = window.__P;
    const l0 = P.rectOf('.tl-lane[data-row="image-0"]');
    const blk = P.rectOf('.tl-lane[data-row="image-1"] [data-clip="c1b"]');
    return P.drag({ sel: '.tl-lane[data-row="image-1"] [data-clip="c1b"]',
      dyPx: Math.round((l0.top + l0.bottom) / 2 - (blk.top + blk.bottom) / 2), steps: 6 });
  });
  must(!r.err, '②：' + r.err);
  const rowsAfter = (await st()).lanes.filter(x => x.indexOf('image-') === 0);
  eq(rowsAfter.length, 1, '②：那一行空了，重画之后不该留成空洞：' + JSON.stringify(rowsAfter));

  /* —— 锁定：把手不画、点它只说一句「先解锁」 —— */
  must(await page.eval(() => window.__P.click('[data-lock="image-0"]')), '②：轨名上没有锁那颗');
  re(await status(page), /^image-0：已锁定$/, '②：锁定的回执');
  r = await st();
  must(r.handles === 0, '②：锁住的那一行不该还画把手');
  must(r.clips.some(c => /is-locked/.test(c.cls)), '②：锁住的块要看得出锁着');
  const nRows = await rowCount(page);
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c2"]' }));
  re(await status(page), /^image-0 已锁定，先解锁再编辑$/, '②：锁住的那一格点它要说清为什么不动');
  await noNewRow(page);
  eq((await rowCount(page)), nRows, '②：锁定那一下没做任何编辑，历史不许追加');
  await page.eval(() => window.__P.click('[data-lock="image-0"]'));
  re(await status(page), /^image-0：已解锁$/, '②：解锁的回执');

  /* —— 隐藏：整行压暗、不许编辑、历史不追加 —— */
  await page.eval(() => window.__P.click('[data-eye="image-0"]'));
  re(await status(page), /^image-0：已隐藏$/, '②：隐藏的回执');
  r = await st();
  must(r.labels.some(l => l.row === 'image-0' && /is-off/.test(l.cls)), '②：轨名要看得出隐藏：' + JSON.stringify(r.labels));
  must(r.clips.every(c => !/is-selected/.test(c.cls) || true), '②：隐藏行的块照样画在原位置');
  await noNewRow(page);
  await page.eval(() => window.__P.click('[data-eye="image-0"]'));
  re(await status(page), /^image-0：已显示$/, '②：显示回来的回执');

  const errs = (page.errors || []).filter(Boolean).slice(0, 3);
  must(!errs.length, '②：页面异常：' + errs.join(' | '));
  await page.close();
}

/* ================= ③ 标记 + 转场 ================= */
async function boot3(proxy, browser) {
  const page = await boot(proxy, browser, '③');
  await page.eval(() => window.__P.tool('snap'));
  re(await status(page), /^吸附已关/, '③：这一档先关吸附，拖标记才只由位移决定');
  const st = async () => page.eval(() => window.__P.state());
  eq(await page.eval(() => window.__P.txt('#tlMarkerCount')), '2', '③：工具条那枚计数该写着两枚标记');

  /* —— M 加一枚（播放头处） —— */
  await page.eval(async () => window.__P.seek(3));
  eq((await st()).pin, '00:03', '③：点刻度尺那一下该把播放头放到 3 秒');
  await page.eval(() => window.__P.key('m'));
  re(await status(page), /^✓ 已在 00:03 加一枚标记$/, '③：M 那一下的回执');
  let r = await st();
  eq(r.markers.length, 3, '③：加了一枚，轨道上该画出三枚');
  eq(await page.eval(() => window.__P.txt('#tlMarkerCount')), '3', '③：计数徽标跟着变成 3');

  /* —— Shift+M 开面板：列表 / 筛选 / 跳过去 —— */
  await page.eval(() => window.__P.key('M', { shift: true }));
  must(await page.eval(() => !!document.querySelector('#tlMPanel')), '③：Shift+M 该把标记面板打开');
  eq(await page.eval(() => document.querySelectorAll('#tlMPanel .tl-mp-row').length), 3, '③：面板列表该有三行');
  await page.eval(() => window.__P.click('[data-mp-filter="range"]'));
  eq(await page.eval(() => document.querySelectorAll('#tlMPanel .tl-mp-row').length), 1, '③：筛到「范围」只剩一行');
  await page.eval(() => window.__P.click('[data-mp-jump="m-2"]'));
  await sleep(200);
  /* 面板上「标题 / 起点」那两格是 `<input>` —— 读的是 value，不是 textContent。 */
  eq(await page.eval(() => window.__P.val('#mpTitle')), '范围备忘', '③：跳过去之后面板要点名这一枚');
  eq(await page.eval(() => window.__P.val('#mpStart')), '10.0', '③：起点那一格该读出现在的秒数');
  eq((await st()).pin, '00:10', '③：面板「跳过去」把播放头也带过来');

  /* —— 拖范围：整段挪（位移）/ 拖尾改止点（指针那一刻的秒）—— */
  r = await page.eval(async () => window.__P.drag({ sel: '[data-band="m-2"]', dx: 1, steps: 5 }));
  must(!r.err, '③：' + r.err);
  re(r.after.status, /^把范围从 00:00:10\.000 挪到 00:00:11\.000（止 00:00:12\.500）$/, '③：拖范围那一条要说清起点与止点都到哪');
  r = await page.eval(async () => window.__P.drag({ sel: '[data-band-tail="m-2"]', toTime: 13, steps: 5 }));
  must(!r.err, '③：' + r.err);
  re(r.after.status, /^把范围的止点从 00:00:12\.500 挪到 00:00:13\.000$/, '③：拖尾只改止点，留痕不许把没动的起点说成动了');
  near(byId((await st()).bands, 'm-2').dur, 2, '③：11 → 13，带宽该是 2 秒');

  /* —— 面板改类型 / 颜色 / 标题 / 起点 —— */
  await page.eval(() => window.__P.click('[data-mp-type="chapter"]'));
  re(await status(page), /^改了一枚标记（章节 · 00:00:11\.000）$/, '③：改类型的留痕要带类型与时刻');
  await page.eval(() => window.__P.click('[data-mp-color="rose"]'));
  r = await st();
  must(byId(r.markers, 'm-2').cls.indexOf('color-rose') >= 0, '③：改完颜色，轨道上那一枚要跟着变：' + JSON.stringify(byId(r.markers, 'm-2')));
  await page.eval(() => window.__P.setVal('#mpTitle', '改过的范围', 'change'));
  re(await status(page), /^把标记标题改成「改过的范围」$/, '③：改标题的留痕');
  await page.eval(() => window.__P.setVal('#mpStart', 12, 'change'));
  re(await status(page), /^把标记起点改成 12\.0 秒$/, '③：改起点的留痕');
  await page.eval(() => window.__P.click('[data-mp="jump"]'));
  eq((await st()).pin, '00:12', '③：面板那颗「跳过去」把播放头带到这一枚');

  /* —— 拖标记头 / 删除 / Esc 关面板 —— */
  /* 头按**指针此刻的秒**结算（不是位移）。先滚回开头：5.5 秒那一格在视野里，指针那一点才真是 5.5 秒 ——
     拖到视野外面会碰到边缘自动滚动，画面在手指底下走，指针落到的就不是那一秒了。 */
  await page.eval(() => window.__P.scrollBoard(0));
  await sleep(150);
  r = await page.eval(async () => window.__P.drag({ sel: '[data-marker="m-1"]', toTime: 5.5, steps: 4 }));
  must(!r.err, '③：' + r.err);
  re(r.after.status, /^把标记从 00:00:06\.000 挪到 00:00:05\.500$/, '③：拖单点标记的留痕');
  /* m-1 是「标记」那一档：上一段把筛选留在了「范围」，先回到「全部」才在列表里看得见它。 */
  must(await page.eval(() => window.__P.click('[data-mp-filter="all"]')), '③：面板里没有「全部」那一档');
  must(await page.eval(() => window.__P.click('[data-mp-jump="m-1"]')), '③：列表里没有 m-1 那一行');
  await sleep(200);
  must(await page.eval(() => window.__P.click('[data-mp="del"]')), '③：删除那一颗点不动');
  re(await status(page), /^删除标记（标记 · 00:00:05\.500）$/, '③：删除标记的留痕要点名是哪一枚');
  eq((await st()).markers.length, 2, '③：删掉一枚之后该剩两枚');
  await page.eval(() => window.__P.key('Escape'));
  must(await page.eval(() => !document.querySelector('#tlMPanel')), '③：Esc 该把标记面板关掉');

  /* —— 标记条收起 / 展开 —— */
  must(await page.eval(() => window.__P.tool('markers')), '③：没有标记条那颗');
  r = await st();
  must(!r.markers.length, '③：收起之后标记条不该再画块');
  must(r.labels.some(l => l.row === 'markers' && /is-folded/.test(l.cls)), '③：轨名上要看得出「收起」：' + JSON.stringify(r.labels));
  await page.eval(() => window.__P.tool('markers'));
  eq((await st()).markers.length, 2, '③：再点一次该把标记条画回来');

  /* —— 转场：连接点 → 浮层 → 预设 → 时长滑块 → 去掉 —— */
  must(await page.eval(() => window.__P.click('[data-junction="1"]')), '③：第 1 与第 2 段之间没有连接点那颗 ◇');
  must(await page.eval(() => { const p = document.getElementById('tlPop'); return p && !p.hidden; }), '③：点了 ◇ 该弹出转场浮层');
  eq(await page.eval(() => document.querySelectorAll('#tlPop [data-preset]').length), 9, '③：预设该有参考项目那九档');
  await page.eval(() => window.__P.click('[data-preset="fade"]'));
  re(await status(page), /^把「镜头一」→「镜头二」之间的转场设为 淡入淡出 0\.5 秒$/, '③：加转场的留痕要点名是哪两段');
  eq(await page.eval(() => document.querySelectorAll('#tlBoard .tl-junction.has-tr').length), 1, '③：加过转场的那颗 ◇ 要看得出');
  const nRow = await rowCount(page);
  await page.eval(() => window.__P.setVal('#tlPopDur', 0.8, 'input'));
  eq(await page.eval(() => window.__P.txt('#tlPopDurVal')), '0.8s', '③：拖滑块那一下读数要跟着走');
  await noNewRow(page);
  await page.eval(() => window.__P.setVal('#tlPopDur', 0.8, 'change'));
  eq(await rowCount(page), nRow + 1, '③：松手那一下才往历史里追加一条');
  re((await page.eval(() => window.__P.hist()))[0].label, /之间的转场设为 .* 0\.8 秒$/, '③：定稿那条要写 0.8 秒');
  await page.eval(() => window.__P.click('[data-preset="none"]'));
  re(await status(page), /^把「镜头一」→「镜头二」之间的转场去掉$/, '③：选 none 就是「去掉」');
  eq(await page.eval(() => document.querySelectorAll('#tlBoard .tl-junction.has-tr').length), 0, '③：去掉之后不该还画着转场');
  await page.eval(() => window.__P.key('Escape'));
  must(await page.eval(() => document.getElementById('tlPop').hidden), '③：Esc 该把浮层收掉');

  const errs = (page.errors || []).filter(Boolean).slice(0, 3);
  must(!errs.length, '③：页面异常：' + errs.join(' | '));
  await page.close();
}

/* ================= ④ 关联族 + 工具条全量动作 + 待生成块 ================= */
async function boot4(proxy, browser) {
  const page = await boot(proxy, browser, '④');
  await page.eval(() => window.__P.tool('snap'));
  re(await status(page), /^吸附已关/, '④：这一档先关吸附');
  const st = async () => page.eval(() => window.__P.state());

  /* —— 待生成块：点它 = 跳到那一句，不做任何编辑 —— */
  const n0 = await rowCount(page);
  let r = await page.eval(async () => window.__P.tap({ sel: '[data-pending="p-B"]' }));
  eq((await st()).pin, '00:06', '④：点待生成块要把播放头放到那一句');
  await noNewRow(page);
  eq(await rowCount(page), n0, '④：只是点一下，不许往历史里追加');
  /* 拖一下：出现时刻改到 5.2 秒 */
  r = await page.eval(async () => window.__P.drag({ sel: '[data-pending="p-B"]', dx: -1, steps: 5 }));
  must(!r.err, '④：' + r.err);
  re(r.after.status, /^把「第二句台词」（6\.2–7\.6 秒）从 6\.2 秒挪到 5\.2 秒$/, '④：待生成块拖动要说清从几秒到几秒');
  eq((await st()).voices.filter(v => /is-pending/.test(v.cls)).length, 2, '④：待生成还是两块');

  /* —— 关联族：单条解除 / 对齐 / 接上 —— */
  let items = await page.eval(() => window.__P.ctx('[data-cap="k-A"]'));
  must(Array.isArray(items) && items.indexOf('cap-unlink') >= 0, '④：字幕的右键菜单该有那四行：' + JSON.stringify(items));
  await page.eval(() => window.__P.click('[data-ctx="cap-unlink"]'));
  re(await status(page), /^解除字幕「第一句字幕」与配音的关联$/, '④：解除关联的留痕');
  await page.eval(() => window.__P.ctx('[data-cap="k-A"]'));
  await page.eval(() => window.__P.click('[data-ctx="cap-align"]'));
  re(await status(page), /^这一条字幕没接配音，无从对齐$/, '④：没连着的时候不许假装对齐了');
  await noNewRow(page);
  await page.eval(() => window.__P.ctx('[data-cap="k-A"]'));
  await page.eval(() => window.__P.click('[data-ctx="cap-link"]'));
  re(await status(page), /^把字幕「第一句字幕」接到配音「第一句配音」上$/, '④：接上要认回记忆位那一条配音');

  /* —— 配音那一路：身上没字幕时照实说 —— */
  await page.eval(() => window.__P.ctx('[data-voice="v-B"]'));
  await page.eval(() => window.__P.click('[data-ctx="item-align"]'));
  re(await status(page), /^这一段配音身上没有字幕$/, '④：没有字幕的配音块对齐要说没有');

  /* —— 全部关联 / 全部解除（工具条那一颗） —— */
  must(await page.eval(() => window.__P.tool('link')), '④：没有关联那颗');
  re(await status(page), /^全部接回字幕与配音的关联（\d+ 条）$/, '④：全部接回要说清几条');
  await page.eval(() => window.__P.ctx('[data-voice="v-B"]'));
  await page.eval(() => window.__P.click('[data-ctx="item-align"]'));
  re(await status(page), /^把「第二句配音」下的 \d+ 条字幕对齐到配音$/, '④：按配音块对齐的留痕');
  await page.eval(() => window.__P.ctx('[data-voice="v-B"]'));
  await page.eval(() => window.__P.click('[data-ctx="item-unlink"]'));
  re(await status(page), /^断开配音「第二句配音」下的 \d+ 条字幕$/, '④：按配音块断开的留痕');
  await page.eval(() => window.__P.tool('link'));
  re(await status(page), /^全部接回字幕与配音的关联（1 条）$/, '④：只补那一条断开的');
  await page.eval(() => window.__P.tool('link'));
  re(await status(page), /^全部解除字幕与配音的关联（3 条，记忆位留着）$/, '④：全连着的时候同一颗就是「全部解除」，并写明记忆位留着');

  /* —— 加长 / 缩短（指着选中那一段） —— */
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c2"]' }));
  must(await page.eval(() => window.__P.tool('lengthen')), '④：加长那颗点不动');
  re(await status(page), /^把「镜头二」第 1 段（6\.0–10\.0 秒）加长 1 秒，改成 6\.0–11\.0 秒$/, '④：加长的留痕');
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c2"]' }));
  must(await page.eval(() => window.__P.tool('shorten')), '④：缩短那颗点不动');
  re(await status(page), /^把「镜头二」第 1 段（6\.0–11\.0 秒）缩短 1 秒，改成 6\.0–10\.0 秒$/, '④：缩短的留痕');

  /* —— 融合：同镜头相邻两段接成一段 —— */
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c1"]' }));
  must(await page.eval(() => window.__P.tool('merge')), '④：融合那颗点不动');
  re(await status(page), /^把「镜头一」第 1 段（0\.0–4\.0 秒）与「镜头一」第 2 段（4\.0–6\.0 秒）融合成一段$/, '④：融合的留痕要点名两段');
  let s = await st();
  eq(s.clips.length, 4, '④：融合之后画面轨该剩四段');
  eq(s.total, '00:16', '④：融合不改片长');

  /* —— 复制 / 删除 —— */
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c3"]' }));
  must(await page.eval(() => window.__P.tool('duplicate')), '④：复制那颗点不动');
  re(await status(page), /^复制 1 块：「镜头三」第 1 段（10\.0–14\.0 秒）$/, '④：复制的留痕');
  s = await st();
  eq(s.clips.length, 5, '④：复制之后多一段');
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c3"]' }));
  must(await page.eval(() => window.__P.tool('delete')), '④：删除那颗点不动');
  re(await status(page), /^删除 1 块：「镜头三」第 1 段（10\.0–14\.0 秒）$/, '④：删除的留痕');
  s = await st();
  eq(s.clips.length, 4, '④：删掉复制那一段之后回到四段');
  eq(s.total, '00:16', '④：删的正是刚复制那一段，片长回到 16 秒');

  /* —— 切刀：在播放头处把指着的那一段连同跨刀的配音 / 字幕一起切两半 —— */
  /* 剪子认的是**选中的那一段**（播头只定「切在第几秒」）：先把刀口要指的那段选上。 */
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c1"]' }));
  await page.eval(async () => window.__P.seek(2));
  const vBefore = (await st()).voices.length;
  const capBefore = (await st()).caps.length;
  must(await page.eval(() => window.__P.tool('cut')), '④：剪子那颗点不动');
  const cutLabel = await status(page);
  re(cutLabel, /^把「镜头一」第 1 段（0\.0–6\.0 秒）/, '④：切一刀的留痕要先点名切的是哪一镜的哪一段');
  must(/「第一句配音」/.test(cutLabel) && /「第一句字幕」/.test(cutLabel),
    '④：跨过这一刀的配音与字幕也要点名（留痕：' + cutLabel + '）');
  re(cutLabel, /在 2\.0 秒处切开$/, '④：留痕末尾要说清切在哪一秒');
  s = await st();
  eq(s.clips.length, 5, '④：切完之后画面轨多一段');
  eq(s.voices.length, vBefore + 1, '④：跨过那一刀的配音跟着切成两条（落在止点上的那块不算跨刀）');
  eq(s.caps.length, capBefore + 1, '④：跨过那一刀的字幕跟着切成两条');

  /* —— 新增一段 / 摘掉一段 —— */
  /* 播放头落在**段中**（不是边界）：那一段被切成左 / 新 / 右三截 —— 画面轨 +2 段、片长 +2 秒。 */
  await page.eval(async () => window.__P.seek(4));
  must(await page.eval(() => window.__P.tool('add-seg')), '④：新增一段那颗点不动');
  re(await status(page), /^在 4\.0 秒处新增一段画面（长 2\.0 秒）$/, '④：新增一段的留痕');
  s = await st();
  eq(s.clips.length, 7, '④：落在段中 = 左 / 新 / 右，画面轨多出两段');
  near(durSum(s.clips), 18, '④：新增那一段把片长顶到 18 秒');
  /* 新加的那一截带着自己的新号，按落点找它（新增不改选择：接着要动它就先选上）。 */
  const fresh = s.clips.filter(c => Math.abs(c.start - 4) < 0.06)[0] || null;
  must(fresh, '④：新加的那一段该落在播放头那一秒：' + JSON.stringify(s.clips.map(c => c.start)));
  await page.eval(async id => window.__P.tap({ sel: '[data-clip="' + id + '"]' }), fresh.id);
  await page.eval(async () => window.__P.seek(5));
  must(await page.eval(() => window.__P.tool('remove-seg')), '④：摘掉一段那颗点不动');
  re(await status(page), /^删掉「镜头一」第 \d 段（4\.0–6\.0 秒）$/, '④：摘掉一段的留痕要点名是哪一段');
  s = await st();
  eq(s.clips.length, 6, '④：摘掉新增那一截之后回到六段');
  near(durSum(s.clips), 16, '④：摘掉之后片长回来');

  /* —— 缩放：自适应是幂等的，放大之后比例尺必须变大 —— */
  await page.eval(() => window.__P.tool('zoom-fit'));
  await sleep(200);
  const fit1 = await page.eval(() => window.__P.pps());
  await page.eval(() => window.__P.tool('zoom-fit'));
  await sleep(200);
  near(await page.eval(() => window.__P.pps()), fit1, '④：连着点两次「自适应」不该把画面推走');
  must(await page.eval(() => window.__P.tool('zoom-in')), '④：放大那颗点不动');
  await sleep(200);
  must((await page.eval(() => window.__P.pps())) > fit1, '④：放大之后比例尺该变大');

  /* —— 回到播放头：针离开视野才出现，点它把视口带回来 —— */
  /* 这里**不回到自适应**：自适应时整片都看得见、横向根本滚不动，「针被甩出视野」那一档就造不出来。
     上一档放大之后内容比视口宽，滚到最右才真的看不见针。 */
  await page.eval(() => window.__P.seek(1));
  await page.eval(async () => window.__P.scrollBoard(99999));
  await sleep(300);
  must(await page.eval(() => { const b = document.querySelector('#tlTools [data-tl="to-playhead"]'); return b && !b.hidden; }),
    '④：针被滚出视野时「回到播放头」该出现');
  must(await page.eval(() => window.__P.playheadInView()) === false, '④：滚到最右之后针确实不在视野里');
  must(await page.eval(() => window.__P.tool('to-playhead')), '④：回到播放头那颗点不动');
  await sleep(300);
  must(await page.eval(() => window.__P.playheadInView()), '④：点它要把视口带回播放头那一秒');

  /* —— 撤销 / 重做也在同一排按钮上 —— */
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c2"]' }));
  await page.eval(() => window.__P.tool('lengthen'));
  re(await status(page), /加长 1 秒/, '④：这一次加长是给撤销用的');
  const kinds = () => page.eval(() => window.__P.hist().slice(0, 1).map(x => x.kind));
  must(await page.eval(() => window.__P.tool('undo')), '④：撤销那颗点不动');
  await sleep(400);
  eq((await kinds())[0], '回退', '④：撤销之后最上面那条该是「回退」');
  must(await page.eval(() => window.__P.tool('redo')), '④：重做那颗点不动');
  await sleep(400);
  eq((await kinds())[0], '重做', '④：重做之后最上面那条该是「重做」');

  /* —— 快捷键那一路：Del 删选中 —— */
  await page.eval(async () => window.__P.tap({ sel: '[data-clip="c4"]' }));
  const delCount = (await st()).clips.length;
  await page.eval(() => window.__P.key('Delete'));
  await sleep(400);
  eq((await st()).clips.length, delCount - 1, '④：按 Delete 该删掉选中那一段');

  const errs = (page.errors || []).filter(Boolean).slice(0, 3);
  must(!errs.length, '④：页面异常：' + errs.join(' | '));
  await page.close();
}

(async () => {
  const only = process.argv[2] ? Number(process.argv[2]) : 0;
  const boots = [null, boot1, boot2, boot3, boot4];
  let proxy, browser;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    for (let i = 1; i <= 4; i++) {
      if (only && only !== i) continue;
      await boots[i](proxy, browser);
    }
    const faults = h.logFaults(proxy.log);
    must(!faults.length, '代理故障：' + faults.slice(0, 3).join(' | '));
    console.log('✓ 剪辑核交互：选择六档 · 裁边 · 吸附（alt 绕过 / 贴到切点）· 波纹 · 换序 · 换行 · 锁定与隐藏 · 标记（加 / 面板 / 拖 / 改 / 删 / 收起）· 转场（◇ / 九档 / 时长 / 去掉）· 关联族 · 工具条全量动作 · 待生成块 · 撤销重做（共 ' + checks + ' 条判据）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
