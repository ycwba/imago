#!/usr/bin/env node
/* 丢件明细回灌（快档，不开浏览器）：
   ① 坏条目不再只计数 —— 节点 / 机位 / 轨道 / 出片记录各留一份 {id, name, why}；计数照旧；
   ② `problemsTextOf` 把丢件明细 / 被跳过的修改 / 几何体检结论 / 本轮失败原因整理成一小段；
      没有问题时给一个空格（TplVars 空串会原样留着占位符）;
   ③ `promptVarsOf` + 契约正文：有问题时那一整段真的进了系统提示词，没问题时整段消失；
   ④ 两份契约同源（与 smoke 同一把尺子的快档）：skills/model3d/SKILL.md 正文 == DEF.model3d；
   ⑤ `run` 跑两轮：第一轮 AI 交来坏零件，结果带 problems；第二轮把它原样交回去，
      系统提示词里能看到「上一轮的问题」那一段。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeDoc } from '../web/model3d/schema.js';
import { problemsTextOf, promptVarsOf, run } from '../web/model3d/ai.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---- 在 vm 里加载真实的 TplVars 与 text-ai.js（不注水，填法就是浏览器那一份）---- */
const ctx = {
  window: {
    LS: { get: k => (k === 'sk_model_probe' ? 'probe-model' : ''), set: () => {} },
    Store: { read: () => [], write: () => {} },
    Api: { errorMessage: () => 'err' },
  },
  console,
};
vm.createContext(ctx);
{
  const src = read('web/domain/gen-forms.js');
  const at = src.indexOf('window.TplVars = {');
  const end = src.indexOf('\n};', at) + 3;
  ok(at > 0 && end > at, 'gen-forms.js 里应当找得到 TplVars 那一段');
  vm.runInContext(src.slice(at, end), ctx, { filename: 'gen-forms.js#TplVars' });
}
vm.runInContext(read('web/domain/text-ai.js'), ctx);
const TextAI = ctx.window.TextAI;
ok(TextAI && TextAI.DEF && TextAI.DEF.model3d, 'text-ai.js 没能加载出 window.TextAI');

/* SKILL.md → 与 skillBody 同一套归一：剥 frontmatter 与首个标题行、CRLF 归一、掐头尾空白 */
const bodyOf = rel => read(rel).replace(/\r\n/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');

/* ---- ① 丢件留明细：四类条目各一条，id / 名字 / 原因都在；计数照旧 ---- */
const { doc, dropped } = normalizeDoc({
  scene: {
    nodes: [
      { kind: 'prim', id: 'n-5', name: '斜撑', shape: 'hexagon' },
      { kind: 'group', id: 'g1', name: '桌子', children: [
        { kind: 'prim', id: 'n-6', name: '桌面', shape: 'box', size: [1, 0.1, 1], at: [0, 0.75, 0] },
      ] },
    ],
    cams: [{ id: 'cam-1' }, 'bad'],
  },
  anim: { tracks: [
    { id: 't1', of: { kind: 'node', id: 'nope' }, keys: [{ t: 0 }] },
    { id: 't2', of: { kind: 'node', id: 'n-6' }, keys: [{ t: 0, at: [0, 0.75, 0] }] },
  ] },
  out: [{ id: 'o1' }, 5],
});
ok(doc.scene.nodes.some(x => x.id === 'g1'), '好节点照收');
ok(dropped.bad === 1 && dropped.cam === 1 && dropped.anim === 1 && dropped.out === 1,
  '计数照旧：' + JSON.stringify(dropped));
ok(Array.isArray(dropped.details) && dropped.details.length === 4, '四条丢件各留一份明细');
assert.deepEqual(dropped.details[0],
  { what: 'node', why: '形状「hexagon」不认识', id: 'n-5', name: '斜撑' }, '节点明细带 id 与名字');
assert.deepEqual(dropped.details[1], { what: 'cam', why: '不是对象' }, '机位明细没有 id 时也有一行');
assert.deepEqual(dropped.details[2],
  { what: 'track', why: 'of.id 指向不存在的节点：nope', id: 't1' }, '轨道明细带上它自己的 id');
assert.deepEqual(dropped.details[3], { what: 'out', why: '不是对象' }, '出片记录明细');

/* ---- ② problemsTextOf：明细 / 坏 op / 体检结论 / 本轮失败原因一起整理 ---- */
const prob = problemsTextOf({ dropped });
ok(prob.indexOf('**上一轮的问题**（程序按上一轮结果整理；这一轮别重犯）：') === 0,
  '开头是那一段的标题：' + prob.slice(0, 40));
ok(prob.includes('- 丢了 n-5「斜撑」（形状「hexagon」不认识）'), '丢件的 id / 名字 / 原因都写进去');
ok(prob.includes('- 丢了 一个机位（不是对象）') && prob.includes('- 丢了 一条出片记录（不是对象）'),
  '没有 id 的条目按类说话');
ok(problemsTextOf({ errors: [{ i: 0, why: '找不到节点：n-9' }] })
  === '**上一轮的问题**（程序按上一轮结果整理；这一轮别重犯）：\n- 跳过一条修改：找不到节点：n-9',
'被跳过的修改单独一行');
ok(problemsTextOf({ lint: { fixes: ['把「桌面」落到「腿1」上'], warnings: ['主体在机位背后或把机位包在里面，画幅检查跳过'] } })
  .includes('- 几何体检改过：把「桌面」落到「腿1」上'), '体检改过什么也要带进下一轮');
ok(problemsTextOf({ why: '这一轮没有拿到 JSON' })
  .includes('- 这一轮的结果：这一轮没有拿到 JSON'), '整轮失败的原因照说');
ok(problemsTextOf(null) === ' ', '没有问题给一个空格（占位符才会整段消失）');
ok(problemsTextOf({ dropped: null, errors: [], lint: null, why: '' }) === ' ', '空结果同样是空格');

/* ---- ③ 契约正文：有问题那一整段进提示词，没问题时整段消失 ---- */
const vars = promptVarsOf({ prompt: '建一张桌子', mode: 'new', problems: prob });
ok(vars.problems === prob, 'promptVarsOf 原样交出去');
const sys = TextAI.defaultPrompt('model3d', false, vars);
ok(sys.includes('**上一轮的问题**（程序按上一轮结果整理；这一轮别重犯）：\n- 丢了 n-5「斜撑」（形状「hexagon」不认识）'),
  '系统提示词里真的带上了上一轮的问题');
ok(sys.indexOf('{problems}') < 0 && sys.indexOf('{current}') < 0, '占位符都被填掉了');
const sys0 = TextAI.defaultPrompt('model3d', false, promptVarsOf({ prompt: '建一张桌子', mode: 'new' }));
ok(sys0.indexOf('**上一轮的问题**（程序按上一轮结果整理；这一轮别重犯）') < 0,
  '没有上一轮问题时那一整段不出现');
ok(sys0.indexOf('{problems}') < 0, '空的那一段也不会把占位符留在提示词里');
const varNames = [...ctx.window.TplVars.names(TextAI.DEF.model3d)];
ok(varNames.includes('problems'), '契约正文里要有 {problems} 占位符（现在有：' + varNames.join(',') + '）');
ok(TextAI.SKILL_VARS['model3d.json'].some(v => v.name === 'problems'), '设置页「这一步会拿到什么」列出 problems');

/* ---- ④ 两份契约同源：SKILL.md 正文与 DEF.model3d 逐字节相同 ---- */
ok(bodyOf('skills/model3d/SKILL.md') === TextAI.DEF.model3d,
  'skills/model3d/SKILL.md 与 TextAI.DEF.model3d 漂开了');

/* ---- ⑤ 跑两轮：第一轮的丢件明细回到第二轮的提示词里 ---- */
{
  const replies = [
    JSON.stringify({ say: '桌子来了', model: { name: '桌子', scene: { nodes: [
      { kind: 'prim', id: 'n-5', name: '斜撑', shape: 'hexagon' },
      { kind: 'group', id: 'g1', name: '桌子', children: [
        { kind: 'prim', id: 'n-6', name: '桌面', shape: 'box', size: [1, 0.1, 1], at: [0, 0.75, 0] },
      ] },
    ] } } }),
    JSON.stringify({ say: '再来一次', model: { name: '桌子', scene: { nodes: [
      { kind: 'prim', id: 'n-7', name: '桌面', shape: 'box', size: [1, 0.1, 1], at: [0, 0.75, 0] },
    ] } } }),
  ];
  const calls = [];
  globalThis.window = {
    Api: { registry: async () => ({ providers: [] }) },
    TextAI: {
      prompt: (...a) => TextAI.prompt(...a),
      prov: () => ({ id: 'probe', kind: 'text' }),
      canRun: async () => true,
      chatStream: async (REG, sys, user, opts, push) => {
        calls.push({ sys, user });
        const txt = replies.shift();
        push(txt);
        return txt;
      },
    },
  };

  const r1 = await run({ prompt: '建一张桌子', mode: 'new', doc: null, aspect: '16:9' });
  ok(calls.length === 1, '第一轮只发一次');
  ok(r1.problems.includes('- 丢了 n-5「斜撑」（形状「hexagon」不认识）'),
    '第一轮的结果带着丢件明细：' + r1.problems);
  ok(calls[0].sys.indexOf('**上一轮的问题**（程序按上一轮结果整理') < 0,
    '第一轮没有「上一轮的问题」那一段');

  const r2 = await run({ prompt: '再来一次', mode: 'new', doc: null, aspect: '16:9', problems: r1.problems });
  ok(calls.length === 2, '第二轮又发一次');
  ok(calls[1].sys.includes('- 丢了 n-5「斜撑」（形状「hexagon」不认识）'),
    '第二轮的系统提示词里带着上一轮丢掉的零件');
  ok(r2.doc && r2.doc.scene.nodes.length > 0, '第二轮照常拿到模型');
}

console.log('✓ model3d-problems：' + n + ' 项通过');
