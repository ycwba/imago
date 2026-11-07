#!/usr/bin/env node
/* 拆分镜 / 改分镜的「AI 反问」判据（快档，不开浏览器）：
   ① 内置 Skill 正文与 TextAI.DEF 逐字一致 —— smoke 那条同源判据的**快档**版
     （smoke 要开 Chrome；这里直接读盘上的 skills/<id>/SKILL.md 与 DEF 对，
      改了 DEF 忘了同步 SKILL.md 在 npm run test:fast 就红）；
   ② 「回答是硬约束」的契约写进了两份指令的要求清单（split 第 10 条 / board_edit 第 12 条）；
   ③ split / board_edit / split_follow 仍在 NO_ASK：反问走单独一轮 askPolish，正文指令永不接 ASK_NOTE；
   ④ askPolish 的 focus 真的拼进系统提示词（带 focus 有、不带没有），问答 JSON 能解析出来；
   ⑤ 接线在位：apply.js 的 splitUI / askRound / renderSplitPanel、engine.js 与 panel.js 的
     重画钩子、设置页那一档的文案覆盖拆分镜；
   ⑥ 确认弹窗的「按这句再改」：split_follow 契约四处登记（SKILL_CONTRACT / 服务端 CONTRACTS /
     SKILL_VARS / SKILL_SCENES）+ SKILL.md 同步 + 弹窗与两路调用方的接线。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

/* ---- 在 vm 里加载 text-ai.js（浏览器脚本，只需一个 window 壳）---- */
const ctx = { window: { LS: { get: k => (k === 'sk_model_probe' ? 'probe-model' : '') },
    Store: { read: () => [], write: () => {} }, Api: { errorMessage: () => 'err' },
    TplVars: { fill: (tpl, vals) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vals && vals[k];
      return (v == null || v === '') ? m : String(v);
    }) } },
  console };
vm.createContext(ctx);
vm.runInContext(read('web/domain/text-ai.js'), ctx);
const TextAI = ctx.window.TextAI;
assert.ok(TextAI && TextAI.DEF, 'text-ai.js 没能加载出 window.TextAI');

/* SKILL.md → 与 skillBody 同一套归一：剥 frontmatter 与首个标题行、CRLF 归一、掐头尾空白 */
const bodyOf = rel => read(rel).replace(/\r\n/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');

assert.equal(bodyOf('skills/split-script/SKILL.md'), TextAI.DEF.split,
  'skills/split-script/SKILL.md 与 TextAI.DEF.split 漂开了');
assert.equal(bodyOf('skills/board-edit/SKILL.md'), TextAI.DEF.board_edit,
  'skills/board-edit/SKILL.md 与 TextAI.DEF.board_edit 漂开了');

/* ---- 问答契约写进了要求清单（回答是硬约束）---- */
assert.ok(TextAI.DEF.split.includes('10. 消息里若带着「用户已经回答了你先前的追问」')
  && TextAI.DEF.split.includes('硬约束'), 'DEF.split 缺「回答是硬约束」那条（要求 10）');
assert.ok(TextAI.DEF.board_edit.includes('12. 消息里若带着「用户已经回答了你先前的追问」')
  && TextAI.DEF.board_edit.includes('硬约束'), 'DEF.board_edit 缺「回答是硬约束」那条（要求 12）');

/* ---- 反问走单独一轮：这两条仍在 NO_ASK（正文永不接 ASK_NOTE）---- */
assert.ok(TextAI.NO_ASK.includes('split') && TextAI.NO_ASK.includes('board_edit'),
  'split / board_edit 必须留在 NO_ASK（正文指令不接追问说明，反问是单独一轮）');
assert.equal(TextAI.defaultPrompt('split'), TextAI.stripAskNote(TextAI.DEF.split),
  'split 的默认指令不应带 ASK_NOTE');

/* ---- askPolish：focus 真的拼进系统提示词；问答 JSON 能解析 ---- */
const PROV = { id: 'probe', kind: 'text', relay: '/relay/probe', endpoints: { chat: '/chat/completions' }, keyId: 'probe' };
const REG = { providers: [PROV] };
let captured = null;
ctx.netFetch = async (url, opts) => {
  captured = { url, opts, body: JSON.parse(opts.body) };
  return { ok: true, json: async () => ({ choices: [{ message: { content:
    '{"need":true,"questions":[{"q":"整片的节奏取向？","options":["快剪","多留白"]}]}' } }] }) };
};
ctx.respBody = async r => ({ d: await r.json(), plain: '' });

const withFocus = await TextAI.askPolish(REG, '基础指令', '要拆的正文', { focus: '节奏与画幅' });
assert.ok(withFocus.need && withFocus.questions.length === 1
  && withFocus.questions[0].q === '整片的节奏取向？', 'askPolish 没能把问答 JSON 解出来');
assert.ok(captured.body.messages[0].content.includes('这一类活儿最值得先问清楚的缺口：节奏与画幅'),
  'focus 没拼进反问那一轮的系统提示词');
assert.ok(captured.body.messages[0].content.includes('【这一轮你的任务：判断这段内容值不值得先问问题】'),
  '反问契约不在系统提示词里');

captured = null;
await TextAI.askPolish(REG, '基础指令', '要拆的正文', {});
assert.ok(!captured.body.messages[0].content.includes('这一类活儿最值得先问清楚的缺口'),
  '不带 focus 时不应出现 focus 那一句');

/* ---- 接线在位（静态）---- */
const applySrc = read('web/director/engine/apply.js');
assert.ok(/function renderSplitPanel\(/.test(applySrc) && /async function askRound\(/.test(applySrc)
  && /let splitUI = null;/.test(applySrc), 'apply.js 缺 splitUI / askRound / renderSplitPanel');
assert.ok(/return\s*\{\s*aiStoryboard,\s*renderSplitPanel,/.test(applySrc),
  'createApply 没把 renderSplitPanel 交出去');
const engineSrc = read('web/director/engine.js');
assert.ok(/renderSplitPanel: \(\.\.\.a\) => renderSplitPanel\(\.\.\.a\)/.test(engineSrc)
  && /const \{\s*aiStoryboard,\s*renderSplitPanel,/.test(engineSrc),
  'engine.js 没把 renderSplitPanel 接进 Panel 域 / 没从 Apply 解构');
const panelSrc = read('web/director/engine/panel.js');
assert.ok(panelSrc.includes('    renderSplitPanel,\n'), 'panel.js 没解构 renderSplitPanel');
assert.ok(/renderPolishPanel\(sh\);[\s\S]{0,400}?renderSplitPanel\(\);/.test(panelSrc),
  'renderEditor 尾部没在润色面板之后拼拆分镜面板');
/* 空态分支只认「没有镜头那一条路里调了 renderSplitPanel」：
   那一行外层现在套的是公共件（重画不吃滚动位），把写法钉死就变成盯着壳子测接线。 */
assert.ok(/if \(!sh\) \{[\s\S]{0,400}?renderSplitPanel\(\);/.test(panelSrc),
  'renderEditor 的空态分支（空项目）没接 renderSplitPanel —— 拆一份新的从空项目发起时问答面板没有落点');

/* ---- 设置页那一档还在，且与读取端同一个键 ----
   设置页的选项不再配说明文字（用户点名：设置页不留描述），所以这里不再要求文案里写「也管导演台」；
   要守的是**接线**：这一行的键名必须与 TextAI.askMode 读的那个键是同一个，否则档位改了不生效。 */
const settingsSrc = read('web/pages/settings.js');
const askRow = /key: 'sk_polish_ask'[\s\S]{0,400}?opts: \[\['ai'/.exec(settingsSrc);
assert.ok(askRow, 'sk_polish_ask 那一行不在设置页（AI 反问的档位就没有入口了）');
assert.ok(/askMode\(\)\s*\{\s*return window\.LS\.get\('sk_polish_ask'\)/.test(read('web/domain/text-ai.js')),
  '设置页那一档与 TextAI.askMode 读的键名漂开了');

/* ---- 确认弹窗的「按这句再改」（split_follow）---- */
assert.equal(bodyOf('skills/split-follow/SKILL.md'), TextAI.DEF.split_follow,
  'skills/split-follow/SKILL.md 与 TextAI.DEF.split_follow 漂开了');
assert.equal(TextAI.SKILL_CONTRACT.split_follow, 'split_follow.json', 'split_follow 没登记 SKILL_CONTRACT');
assert.ok(TextAI.NO_ASK.includes('split_follow'), 'split_follow 必须在 NO_ASK（它自己就是一次性 JSON 指令）');
assert.ok(Array.isArray(TextAI.SKILL_VARS['split_follow.json']) && TextAI.SKILL_VARS['split_follow.json'].some(v => v.name === 'what'),
  'split_follow.json 缺 SKILL_VARS 说明');
assert.ok(TextAI.SKILL_SCENES.some(s => s.key === 'split_follow'), 'SKILL_SCENES 缺 split_follow 场景');
assert.ok(TextAI.PROMPTS.some(g => (g.items || []).some(it => it.key === 'split_follow')),
  'PROMPTS 缺 split_follow 的说明行');
assert.ok(/split_follow\.json/.test(read('server/data-hub.js')), '服务端 CONTRACTS 白名单没有 split_follow.json');
assert.ok(/输出\*\*?改后的完整方案|输出\*\*改后的完整方案\*\*/.test(TextAI.DEF.split_follow),
  'split_follow 必须写明「输出完整方案」（程序整份替换，只回改动几条会真丢镜头）');

const formsSrc = read('web/ui/forms.js');
assert.ok(/function mountFollow\(dlg, o, okBtn, blocked, hooks\)/.test(formsSrc), 'forms.js 缺 mountFollow');
assert.ok((formsSrc.match(/const follow = mountFollow\(dlg, o,/g) || []).length === 2,
  'mountFollow 必须被分组审阅与平铺审阅各接一次');
assert.ok((applySrc.match(/onFollow: async \(askText, ctl/g) || []).length === 2,
  'apply.js 的拆新与改稿两路都要接 onFollow');
assert.ok(/const itemsOfDraft = j =>/.test(applySrc), 'apply.js 缺 itemsOfDraft（生成轮与再改轮共用解析）');
assert.ok(/TextAI\.prompt\('split_follow'\)/.test(applySrc), '拆新档的再改轮没走 split_follow 契约');

/* ---- 润色 Skill 的请求条件变量：正文写了，设置页的说明表也得列 ---- */
for (const [contract, want] of [
  ['polish.video', ['duration', 'mode', 'model', 'ar', 'assets']],
  ['polish.image', ['model', 'ar', 'assets']],
]) {
  const names = (TextAI.SKILL_VARS[contract] || []).map(v => v.name);
  for (const n of want) assert.ok(names.includes(n), contract + ' 的 SKILL_VARS 缺 ' + n);
}
assert.ok(TextAI.DEF.video.includes('{duration}') && TextAI.DEF.video.includes('{assets}'),
  '视频 Skill 正文没写 {duration} / {assets}：程序填了也进不去');
assert.ok(TextAI.DEF.img.includes('{assets}'), '图片 Skill 正文没写 {assets}');
assert.equal(bodyOf('skills/line-write/SKILL.md'), TextAI.DEF.line_write,
  'skills/line-write/SKILL.md 与 TextAI.DEF.line_write 漂开了');
assert.equal(TextAI.SKILL_CONTRACT.line_write, 'line_write.json', 'line_write 没登记 SKILL_CONTRACT');
assert.ok((TextAI.SKILL_VARS['line_write.json'] || []).some(v => v.name === 'duration'),
  'line_write.json 缺 SKILL_VARS 说明');
const filled = TextAI.prompt('video', false, {
  duration: '8 秒', mode: '首尾帧', model: 'MiniMax-H3（MiniMax）', ar: '16:9',
  assets: '- @参考图1 首帧\n- @视频1 参考视频',
});
assert.ok(filled.includes('成片时长：8 秒') && filled.includes('- @视频1 参考视频'),
  'TextAI.prompt 没把 {duration} / {assets} 填进 Skill 正文');
assert.ok(!filled.includes('{duration}') && !filled.includes('{assets}'), '填过之后不该还留着占位符');

/* ---- 联网工具循环：模型自己 CALL、结果回灌；CALL 那一轮不进流式面板 ---- */
const parsedCall = TextAI._parseToolCall('CALL: web_search {"query":"1999 香港","limit":2}');
assert.equal(parsedCall.name, 'web_search');
assert.equal(parsedCall.arg.query, '1999 香港');
assert.equal(parsedCall.arg.limit, 2);
assert.equal(TextAI._parseToolCall('画面描述'), null);
assert.equal(TextAI._parseToolCall('CALL: web_search {"query":oops}'), null);

const seen = [];
const gate = TextAI._callGate(p => seen.push(p));
gate.push('CALL: web_', 'content');
gate.push('search {"query":"x"}', 'content');
gate.finish();
assert.equal(seen.join(''), '', 'CALL 那一轮不该出现在流式面板里');
const seen2 = [];
const gate2 = TextAI._callGate(p => seen2.push(p));
gate2.push('画', 'content');
gate2.push('面', 'content');
gate2.finish();
assert.equal(seen2.join(''), '画面', '普通正文不能被吞');

/* 总开关关着：请求里连工具说明都不加 */
ctx.window.Search = { state: async () => ({ enabled: false }), search: async () => ({ results: [] }), read: async () => ({}) };
TextAI._toolOnAt = 0;
let bodyOff = null;
ctx.netFetch = async (url, opts) => {
  bodyOff = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
};
assert.equal(await TextAI.chat(REG, 'SYS', '写一句台词', {}), 'ok');
assert.ok(!JSON.stringify(bodyOff).includes('web_search'), '总开关关着时不该加工具说明');

/* noTools：助手自己的工具循环 / 纯协议调用退出这一层 */
let bodyNo = null;
ctx.netFetch = async (url, opts) => {
  bodyNo = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
};
await TextAI.chat(REG, 'SYS', '只回复 ok', { noTools: true });
assert.ok(!JSON.stringify(bodyNo).includes('web_search'), 'noTools 仍然加了工具说明');

/* 开着：模型先 CALL，执行后回灌，再出最终结果 */
let searchCalls = 0;
ctx.window.Search = {
  state: async () => ({ enabled: true }),
  search: async () => { searchCalls++; return { results: [{ title: '1999 年的香港', url: 'https://e.com/a', snippet: '背景资料' }] }; },
  read: async () => ({ title: '', url: '', text: '' }),
};
TextAI._toolOnAt = 0;
const bodies = [];
ctx.netFetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  bodies.push(b);
  const content = bodies.length === 1 ? 'CALL: web_search {"query":"1999 香港"}' : '最终分镜';
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
};
const final = await TextAI.chat(REG, 'SYS', '把剧本改成 1999 年的香港', {});
assert.equal(final, '最终分镜');
assert.equal(searchCalls, 1, 'CALL 没有真的执行搜索');
assert.ok(bodies[0].messages[0].content.includes('web_search'), '第一轮没带工具说明');
assert.ok(bodies[1].messages.some(m => /web_search 结果/.test(String(m.content))), '搜索结果没有回灌给模型');
assert.equal(bodies[1].messages[0].content, bodies[0].messages[0].content, '工具说明不该在第二轮重复追加');

/* 流式那一轮同样把 CALL 藏起来，只把最终结果交给面板 */
let sseRound = 0;
ctx.readSseStream = async (res, onPiece) => {
  sseRound++;
  const text = sseRound === 1 ? 'CALL: web_search {"query":"1999 香港"}' : '最终分镜';
  onPiece(text, 'content');
  return { text, reasoning: '', usage: {} };
};
ctx.netFetch = async () => ({ ok: true, headers: { get: () => 'text/event-stream' } });
TextAI._toolOnAt = 0;
const deltas = [];
const streamed = await TextAI.chatStream(REG, 'SYS', '把剧本改成 1999 年的香港', {}, p => deltas.push(p));
assert.equal(streamed, '最终分镜');
assert.ok(!deltas.join('').includes('CALL'), 'CALL 那一轮漏进了流式面板');
assert.ok(deltas.join('').includes('最终分镜'), '最终结果没有流到面板');
assert.equal(sseRound, 2, '流式工具循环应当两轮');

console.log('✓ director-split-ask：Skill 同步 / 问答契约 / NO_ASK / focus 拼装 / 联网工具循环 / 再改契约 全部就位');
