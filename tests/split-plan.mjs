#!/usr/bin/env node
/* 「拆分那一排选项」公共件判据（快档，不开浏览器）：
   ① SplitPlan 一家一份的选项表能画出那一排，画出来的每一个 id 都在 ids() 里，
     页面里写死的那几个取手名字也都要在这张表里（漏一个就是 `$()` 静默拿到 null）；
   ② userLines 那两行的口径：选了就说死数，选「自定义…」就取框里那句，
     两个都没选也要说清「自动」那一句按哪家的范围（两家张数档不同，共用的话术不能替另一家报数）；
   ③ 一把尺子：「自动」那句报的范围 ↔ 契约正文里「用户没指定就定几张」那一句；
     导演台张数档的上限 ↔ parseFrames 的那道夹（多给一档永远点不满，少给一档就是白藏）；
   ④ story 契约两份正文逐字一致（内置 Skill 与 TextAI.DEF，smoke 那条同源判据的快档版）；
   ⑤ `.split-opts` 只在公共样式表里定义一份（页面补丁里再抄一条就是 G20 红 + 两处会漂开）。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

/* ---- 在 vm 里加载 forms.js（浏览器脚本，只需 window / document 的空壳）----
   ui.js 先加载：dir 那一家那颗「开始规划」的外观与转义都来自它 —— 拿真身而不是替身，
   判据看到的才是页面实际画出来的那一段。 */
const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {}, querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, dataset: {},
  innerHTML: '', textContent: '', value: '' });
const doc = { createElement: el, createElementNS: el, addEventListener() {}, removeEventListener() {},
  body: el(), documentElement: el(), head: el(), querySelector: () => null, querySelectorAll: () => [],
  readyState: 'complete' };
const mem = {};
const LS = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; } };
const win = { addEventListener() {}, removeEventListener() {}, localStorage: LS,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { hash: '', href: 'http://localhost/', pathname: '/' }, navigator: { userAgent: 'node' },
  setTimeout, clearTimeout, setInterval, clearInterval, devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800 };
const ctx = { window: win, document: doc, console, setTimeout, clearTimeout, setInterval, clearInterval,
  location: win.location, navigator: win.navigator, localStorage: LS, Image: function () {},
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x' } };
win.window = ctx; win.self = win; win.document = doc;
vm.createContext(ctx);
for (const rel of ['web/ui/ui.js', 'web/ui/forms.js']) vm.runInContext(read(rel), ctx, { filename: rel });
const SplitPlan = ctx.window.SplitPlan;
assert.ok(SplitPlan && SplitPlan.FAM && SplitPlan.FAM.wb && SplitPlan.FAM.dir,
  'forms.js 没能加载出 window.SplitPlan（wb / dir 两家）');
assert.ok(ctx.window.esc && ctx.window.aiBtnHTML, 'ui.js 没能加载出 esc / aiBtnHTML（判据在量替身）');

/* ---- 文字 AI 的契约正文（两份 DEF 与「自动」那句要同一把尺子）---- */
const tctx = { window: { LS: { get: () => '' }, Store: { read: () => [], write: () => {} },
  Api: { errorMessage: () => 'err' },
  TplVars: { fill: (tpl, vals) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g,
    (m2, k) => { const v = vals && vals[k]; return (v == null || v === '') ? m2 : String(v); }) } },
  console };
vm.createContext(tctx);
vm.runInContext(read('web/domain/text-ai.js'), tctx);
const TextAI = tctx.window.TextAI;
assert.ok(TextAI && TextAI.DEF && TextAI.DEF.story && TextAI.DEF.img_split,
  'text-ai.js 没能加载出 window.TextAI（story / img_split）');

const maxOf = fam => Math.max(...SplitPlan.FAM[fam].counts.filter(Boolean).map(Number));
const CONTRACT = { wb: 'img_split', dir: 'story' };

/* ---- ① 表与 id ---- */
for (const fam of ['wb', 'dir']) {
  const ids = SplitPlan.ids(fam);
  const html = SplitPlan.html(fam);
  for (const [k, v] of Object.entries(ids)) {
    assert.ok(html.includes('id="' + v + '"'), fam + ' 的 ids.' + k + '（' + v + '）没画进 html()');
  }
  assert.ok(!html.includes('undefined'), fam + ' 的 html() 里混进了 undefined');
  assert.notEqual(SplitPlan.ids(fam), ids, fam + ' 的 ids() 每次要给一份新的（改一份不能把表带脏）');
  assert.equal(SplitPlan.FAM[fam].dims[0], '', fam + ' 的维度第一档必须是「自动」那个空值');
  assert.equal(SplitPlan.FAM[fam].counts[0], '', fam + ' 的张数第一档必须是「自动」那个空值');
  assert.ok(SplitPlan.FAM[fam].dims.includes(SplitPlan.CUSTOM), fam + ' 没有「自定义…」那一档');
}
/* 自定义那一格选中才露出来：默认画的时候要带着 hidden。 */
assert.ok(/hidden/.test(SplitPlan.html('wb')) && !/hidden/.test(SplitPlan.html('wb', { dimKey: SplitPlan.CUSTOM })),
  '「自定义…」那一格不是按 dimKey 决定显隐');

const WB = SplitPlan.ids('wb');
const studio = read('web/pages/studio.js');
/* 页面里那些写死的 `$('splitXxx')` 必须就是这张表里的哪一个 —— 改了名而页面还按旧名取，
   `$()` 静默给 null，那一排就再也没人接线。 */
['splitDim', 'splitDimCustom', 'splitGo', 'splitCancel'].forEach(n => {
  assert.ok(Object.values(WB).includes(n), 'wb 的表里没有 ' + n + '，但页面还在按这个名字取节点');
  assert.ok(studio.includes("$('" + n + "')"), 'studio.js 不再引用 ' + n + '（公共件的表与页面接线漂开）');
});
assert.ok(studio.includes('window.SplitPlan.html'), 'studio.js 那一排选项不是 SplitPlan 画的');
assert.ok(studio.includes('window.SplitPlan.userLines'), 'studio.js 没走 SplitPlan.userLines（自己又拼了一遍那两行）');
const panel = read('web/director/engine/panel.js');
assert.ok(panel.includes("SplitPlan.ids('dir')"), 'panel.js 没按 SplitPlan.ids 取名字（硬编码就会和表漂开）');
assert.ok(panel.includes("SplitPlan.html('dir'"), 'panel.js 那一排选项不是 SplitPlan 画的');

/* ---- ② 那两行的口径 ---- */
assert.equal(SplitPlan.userLines(SplitPlan.selOf('wb', { count: '3', dimKey: '按场景变化' })),
  '\n\n张数：恰好 3 张，一张不多一张不少\n拆分维度：按场景变化', '选了的那一句口径变了');
const auto = SplitPlan.userLines(SplitPlan.selOf('dir', {}));
assert.ok(auto.includes('张数：') && auto.includes('拆分维度：'), '两个都没选也不能整段不出现（口径不能空）');
assert.ok(!auto.includes('2 到 6'), 'dir 不能念 wb 的张数档');
assert.ok(SplitPlan.userLines(SplitPlan.selOf('wb', { dimKey: SplitPlan.CUSTOM, custom: '按主角情绪变化' }))
  .endsWith('拆分维度：按主角情绪变化'), '选「自定义…」时那句要取框里的字');
assert.ok(SplitPlan.isCustom(SplitPlan.selOf('wb', { dimKey: SplitPlan.CUSTOM })), 'isCustom 没认出自定义那一档');
assert.ok(!SplitPlan.isCustom(SplitPlan.selOf('wb', { dimKey: '按时间顺序' })), 'isCustom 认错了档');
/* 读 DOM 的那一路：取手由页面交进来，件内一个字都不查 document。 */
const nodes = { [WB.count]: { value: '4' }, [WB.dim]: { value: SplitPlan.CUSTOM }, [WB.custom]: { value: ' 按光线 ' } };
const fromDom = SplitPlan.read('wb', id => nodes[id] || null);
assert.equal(fromDom.count, '4', 'read() 没从取手里读到张数');
assert.equal(fromDom.dim, '按光线', 'read() 选自定义时没取框里那句（也没剥空白）');
assert.equal(SplitPlan.read('wb', () => null).count, '', '取手给 null 时 read() 要当「没选」');

/* ---- ③ 一把尺子 ----
   「自动」那句是替契约正文说话的那一句：它报的范围必须就是契约里「用户没指定时定几张」那一条。 */
for (const fam of ['wb', 'dir']) {
  const m = /（(\d+)[ 到]+(\d+) 张）/.exec(SplitPlan.FAM[fam].autoCount);
  assert.ok(m, fam + ' 的「自动」那句没写范围');
  const d = /(\d+)[–\-](\d+) 张/.exec(TextAI.DEF[CONTRACT[fam]]);
  assert.ok(d, 'DEF.' + CONTRACT[fam] + ' 没写「没指定时定几张」那一档');
  assert.deepEqual([Number(m[1]), Number(m[2])], [Number(d[1]), Number(d[2])],
    fam + ' 的「自动」那句与 DEF.' + CONTRACT[fam] + ' 兜底那一档报的不是同一个范围');
}
const engine = read('web/director/engine.js');
const cap = /function parseFrames[\s\S]*?list\.slice\(0,\s*(\d+)\)/.exec(engine);
assert.ok(cap, 'engine.js 的 parseFrames 找不到那道张数夹');
assert.equal(maxOf('dir'), Number(cap[1]),
  '导演台张数档的上限与 parseFrames 的夹不是同一个数（多给的那一档永远点不满）');
assert.ok(engine.includes('SplitPlan.userLines(kfSplitSel())'), '导演台那两行不是公共件拼的');
assert.ok(!/请决定需要几张关键画面/.test(engine), 'engine.js 还写死了「请决定需要几张」');
/* 导演台的选择存在模块变量里（右栏每 3 秒整片重画，DOM 里的值活不过下一次）并一起落盘。
   落盘键名（sc/sd/sx）由 engine 自己定，判据只认「写进那一份 JSON」与「从那一枚读回来」两件事。 */
const saveAt = engine.indexOf('function kfParamsSave');
assert.ok(saveAt >= 0, 'engine.js 找不到 kfParamsSave');
const saveBody = engine.slice(saveAt, engine.indexOf('\n}', saveAt));
assert.ok(/\bsetJson\s*\(/.test(saveBody), 'kfParamsSave 没往本机写那一枚 JSON');
/* 顶格写的 let 才是模块级（函数体里的那些都带缩进）—— 值存不进 DOM，只能存这一层。 */
['kfSplitCount', 'kfSplitDim', 'kfSplitCustom'].forEach(n => {
  assert.ok(new RegExp('^let\\b[^\\n]*\\b' + n + '\\b', 'm').test(engine),
    'engine.js 的 ' + n + ' 不是模块变量（右栏每 3 秒重画，存 DOM 会被抹掉）');
  assert.ok(new RegExp(':[ \\t]*' + n + '\\b').test(saveBody), 'engine.js 没把 ' + n + ' 写进落盘那一份');
  assert.ok(new RegExp(n + '[ \\t]*=[ \\t]*String\\(').test(engine), 'engine.js 没从落盘那一份读回 ' + n);
});

/* ---- ④ story 两份正文逐字一致 ---- */
const bodyOf = rel => read(rel).replace(/\r\n/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');
const storyBody = bodyOf('skills/storyboard-frames/SKILL.md');
assert.equal(storyBody, TextAI.DEF.story, 'skills/storyboard-frames/SKILL.md 与 TextAI.DEF.story 漂开了');
assert.ok(storyBody.includes('以用户消息给的为准'),
  'story 正文没写「张数与拆分维度以用户消息给的为准」（那一排选项白给）');

/* ---- ⑤ 样式只有一份 ---- */
assert.ok(/(^|\n)\s*\.split-opts\b/.test(read('web/styles/ui.css')),
  'ui.css 没有 .split-opts（导演台那一排拿不到样式）');
assert.ok(!/\.split-opts/.test(read('web/styles/spa-studio.css')),
  'spa-studio.css 又抄了一遍 .split-opts（两处会漂开，且 G20 红）');

console.log('✓ 拆分选项公共件：两家的表与 id / 那两行口径 / 三处尺子 / story 两份正文 / 样式一份 都对得上');
