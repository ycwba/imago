#!/usr/bin/env node
/* 涂鸦标注 → 运镜（快档，不开浏览器）：
   ① 颜色是语义：七种颜色齐全且互不相同；
   ② 蓝线 → camPath（程序换算机位位移，AI 照抄）；没有蓝线回空表；
   ③ `promptVarsOf` / 契约：有涂鸦时「涂鸦运镜」整段与 marks / camPath 真的进提示词，
      没有涂鸦时整段消失；
   ④ 两份契约逐字节同源（快档）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { screenToCamPath } from '../web/model3d/scene.js';
import { SKETCH } from '../web/model3d/palette.js';
import { promptVarsOf } from '../web/model3d/ai.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---- ① 颜色语义 ---- */
{
  const keys = Object.keys(SKETCH);
  ok(keys.join(',') === 'blue,yellow,red,green,white,gray,black', '七种标注颜色齐全：' + keys.join(','));
  ok(new Set(Object.values(SKETCH)).size === keys.length, '七种颜色互不相同');
}

/* ---- ② 蓝线 → camPath ---- */
{
  const marks = [
    { type: 'path', color: 'blue', pts: [[0, 0, 0], [0.4, 0.3, 0.6], [0.8, 0.55, 1.0]] },
    { type: 'arrow', color: 'red', from: [1, 1, 0], to: [1.5, 1, 0.4] },
  ];
  const camPath = screenToCamPath(marks, { pos: [3.2, 2.1, 4.2] });
  ok(camPath.length === 3, '蓝线三个点都换算：' + camPath.length);
  ok(camPath[0].join(',') === '3.2,2.1,4.2', '第一点就是当前机位');
  ok(camPath[2].join(',') === '4,2.65,5.2', '后面按蓝线相对位移：' + camPath[2].join(','));
  ok(screenToCamPath([marks[1]], { pos: [0, 0, 0] }).length === 0, '没有蓝线就没有 camPath');
  ok(screenToCamPath([{ type: 'path', color: 'yellow', pts: [[0, 0, 0], [1, 0, 0]] }], { pos: [0, 0, 0] }).length === 0,
    '黄线不装机位路径（那是主体运动）');
}

/* ---- ③ 提示词里的涂鸦段 ---- */
const ctx = {
  window: {
    LS: { get: () => '' }, Store: { read: () => [], write: () => {} },
    Api: { errorMessage: () => 'err' },
    TplVars: { fill: (tpl, vals) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vals && vals[k];
      return (v == null || v === '') ? m : String(v);
    }) },
  },
  console,
};
vm.createContext(ctx);
vm.runInContext(read('web/domain/text-ai.js'), ctx);
const TextAI = ctx.window.TextAI;

{
  const marks = [
    { type: 'path', color: 'blue', pts: [[0, 0, 0], [0.4, 0.3, 0.6]] },
    { type: 'arrow', color: 'red', from: [1, 1, 0], to: [1.5, 1, 0.4] },
    { type: 'text', color: 'green', at: [0.8, 0.6, 0], text: '这里慢一点' },
  ];
  const sketch = { mode: 'camera', marks, camPath: screenToCamPath(marks, { pos: [3.2, 2.1, 4.2] }), aspect: '16:9', duration: 6, fps: 24 };
  const vars = promptVarsOf({ prompt: '按标注运镜', mode: 'auto', sketch });
  ok(vars.sketch.includes('模式：camera'), '写出模式');
  ok(vars.sketch.includes('- path · blue') && vars.sketch.includes('- arrow · red') && vars.sketch.includes('这里慢一点'),
    '图元类型 / 颜色 / 文字都进提示词');
  ok(vars.sketch.includes('程序算好的机位路径（照抄，不要自己换算）') && vars.sketch.includes('3.2,2.1,4.2'),
    'camPath 明说要照抄');
  const sys = TextAI.defaultPrompt('model3d', false, vars);
  ok(sys.includes('**涂鸦运镜（材料里「涂鸦标注」那一段）**'), '契约里的涂鸦运镜说明在');
  ok(sys.indexOf('{sketch}') < 0, '占位符被填掉');
  const blank = promptVarsOf({ prompt: '建个盒子', mode: 'auto' });
  const sys0 = TextAI.defaultPrompt('model3d', false, blank);
  ok(sys0.indexOf('模式：camera') < 0 && sys0.indexOf('程序算好的机位路径') < 0, '没有涂鸦时整段内容不出现');
  ok(sys0.indexOf('{sketch}') < 0, '没有涂鸦也不会把占位符留在提示词里');
}

/* ---- ④ 两份契约同源 ---- */
const bodyOf = rel => read(rel).replace(/\r\n/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');
ok(bodyOf('skills/model3d/SKILL.md') === TextAI.DEF.model3d, 'SKILL.md 与 DEF.model3d 逐字节相同');
ok(TextAI.SKILL_VARS['model3d.json'].some(v => v.name === 'sketch'), '设置页「这一步会拿到什么」列出 sketch');

console.log('✓ model3d-sketch：' + n + ' 项通过');
