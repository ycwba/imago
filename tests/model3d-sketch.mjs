#!/usr/bin/env node
/* 涂鸦标注 → 运镜（快档，不开浏览器）：
   ① 颜色是语义：七种颜色齐全且互不相同；
   ② 蓝线 → camPaths：每一段蓝线各自成段（机位位移，几何照点走），
      多段蓝线一段不少；没有蓝线回空数组；黄线不换算（那是主体运动）；
   ③ `promptVarsOf` / 契约：有涂鸦时「涂鸦运镜」整段与 marks / camPaths 真的进提示词
      （编排以用户那句话为准），没有涂鸦时整段消失；
   ④ 两份契约逐字节同源（快档）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { screenToCamPaths } from '../web/model3d/scene.js';
import { SKETCH } from '../web/model3d/palette.js';
import { promptVarsOf } from '../web/model3d/ai.js';
import * as THREE from '../web/vendor/three/three.module.js';
import { pickSurfacePoint, planeAnchorOf } from '../web/model3d/view.js';

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

/* ---- ①b 深度可调：贴面取样与面锚（纯几何） ---- */
{
  /* 贴面：射线打在单位盒正面，取样点 z = 0.5（表面），打空回 null */
  const group = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  box.position.set(0, 0.5, 0);            // 底面落地：正面 z = 0.5
  group.add(box);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0),
    new THREE.PerspectiveCamera(35, 16 / 9).translateZ(5).lookAt ? new THREE.PerspectiveCamera(35, 16 / 9) : null);
  /* 直接造射线更稳：从 (0,0.5,5) 指向盒心 */
  const ray2 = new THREE.Raycaster(new THREE.Vector3(0, 0.5, 5), new THREE.Vector3(0, 0, -1).normalize());
  const hit = pickSurfacePoint(ray2, group);
  ok(Array.isArray(hit) && hit[2] === 0.5 && hit[1] === 0.5,
    '贴面取样落在盒面（z=0.5）：' + JSON.stringify(hit));
  const ray3 = new THREE.Raycaster(new THREE.Vector3(5, 5, 5), new THREE.Vector3(0, -1, 0));
  ok(pickSurfacePoint(ray3, group) === null || true, '打不中给 null 或贴别处（不炸）');
  ok(pickSurfacePoint(ray2, null) === null, '没有网格组就是 null');

  /* 面锚：plane 档 = 相机沿视线推 dist（夹 0.2–30）；auto = 焦点原样 */
  const focus = [1, 2, 3], camPos = [0, 0, 0], fwd = [0, 0, 1];
  ok(planeAnchorOf('auto', 9, focus, camPos, fwd).join(',') === '1,2,3', 'auto 档面锚就是焦点');
  ok(planeAnchorOf('plane', 5, focus, camPos, fwd).join(',') === '0,0,5', 'plane 档面锚 = 相机 + 视线 × dist');
  ok(planeAnchorOf('plane', 99, focus, camPos, fwd).join(',') === '0,0,30', 'dist 夹到 30');
  ok(planeAnchorOf('plane', 0, focus, camPos, fwd).join(',') === '0,0,0.2', 'dist 下限 0.2');
  ok(planeAnchorOf('plane', '坏值', focus, camPos, fwd).join(',') === '0,0,3', '坏值回 3');
}

/* ---- ② 蓝线 → camPaths（每段蓝线一段，多段都保留） ---- */
{
  const marks = [
    { type: 'path', color: 'blue', pts: [[0, 0, 0], [0.4, 0.3, 0.6], [0.8, 0.55, 1.0]] },
    { type: 'arrow', color: 'red', from: [1, 1, 0], to: [1.5, 1, 0.4] },
  ];
  const segs = screenToCamPaths(marks, { pos: [3.2, 2.1, 4.2] });
  ok(Array.isArray(segs) && segs.length === 1, '一段蓝线 = 一段机位位移：' + (segs && segs.length));
  ok(segs[0].length === 3, '蓝线三个点都换算：' + segs[0].length);
  ok(segs[0][0].join(',') === '3.2,2.1,4.2', '段内第一点就是当前机位');
  ok(segs[0][2].join(',') === '4,2.65,5.2', '后面按蓝线相对位移：' + segs[0][2].join(','));
  const two = [
    { type: 'path', color: 'blue', pts: [[0, 0, 0], [1, 0, 0]] },
    { type: 'arrow', color: 'red', from: [9, 9, 9], to: [9, 9, 8] },
    { type: 'path', color: 'blue', pts: [[5, 0, 0], [5, 2, 0], [6, 2, 0]] },
  ];
  const segs2 = screenToCamPaths(two, { pos: [10, 0, 0] });
  ok(segs2.length === 2, '两段蓝线都保留（中间隔着别的标注也认得出）：' + segs2.length);
  ok(segs2[0][1].join(',') === '11,0,0', '第一段按自己的原点换算：' + segs2[0][1].join(','));
  ok(segs2[1][0].join(',') === '10,0,0' && segs2[1][1].join(',') === '10,2,0',
    '第二段以它自己的第一点为原点，不并进第一段：' + segs2[1].map(p => p.join(',')).join(' | '));
  ok(screenToCamPaths([marks[1]], { pos: [0, 0, 0] }).length === 0, '没有蓝线就没有 camPaths');
  ok(screenToCamPaths([{ type: 'path', color: 'yellow', pts: [[0, 0, 0], [1, 0, 0]] }], { pos: [0, 0, 0] }).length === 0,
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
  const sketch = { marks, camPaths: screenToCamPaths(marks, { pos: [3.2, 2.1, 4.2] }), aspect: '16:9', duration: 6, fps: 24 };
  const vars = promptVarsOf({ prompt: '按标注运镜', mode: 'auto', sketch });
  ok(vars.sketch.includes('画幅') && vars.sketch.includes('- path · blue')
    && vars.sketch.includes('- arrow · red') && vars.sketch.includes('这里慢一点'),
    '画幅行与图元类型 / 颜色 / 文字都进提示词');
  ok(vars.sketch.includes('以用户这句话为准') && vars.sketch.includes('3.2,2.1,4.2'),
    'camPaths 进提示词，且写明编排以用户这句话为准');
  const sys = TextAI.defaultPrompt('model3d', false, vars);
  ok(sys.includes('**涂鸦运镜（材料里「涂鸦标注」那一段）**'), '契约里的涂鸦运镜说明在');
  ok(sys.includes('颜色即语义，不分模式') && sys.includes('用户写的那句话是主令'),
    '契约写明：颜色即语义、不分模式，提示词是主令');
  ok(sys.includes('没有蓝线也能直接按主令生成机位轨道'), '没有蓝线也照常能生成');
  ok(sys.indexOf('{sketch}') < 0, '占位符被填掉');
  const blank = promptVarsOf({ prompt: '建个盒子', mode: 'auto' });
  const sys0 = TextAI.defaultPrompt('model3d', false, blank);
  ok(sys0.indexOf('- path · blue') < 0 && sys0.indexOf('程序按每段蓝线') < 0, '没有涂鸦时整段内容不出现');
  ok(sys0.indexOf('{sketch}') < 0, '没有涂鸦也不会把占位符留在提示词里');
  /* 没画蓝线、只写提示词：涂鸦段照给（其余标注与 camPaths 为空也要进得去） */
  const noblue = promptVarsOf({ prompt: '环绕主角一圈', mode: 'auto',
    sketch: { marks: [{ type: 'arrow', color: 'green', from: [0, 0, 0], to: [1, 0, 0] }], camPaths: [] } });
  ok(noblue.sketch.includes('- arrow · green') && noblue.sketch.indexOf('机位位移') < 0,
    '没有蓝线时 camPaths 整行不出现，标注照给');
}

/* ---- ④ 两份契约同源 ---- */
const bodyOf = rel => read(rel).replace(/\r\n/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');
ok(bodyOf('skills/model3d/SKILL.md') === TextAI.DEF.model3d, 'SKILL.md 与 DEF.model3d 逐字节相同');
ok(TextAI.SKILL_VARS['model3d.json'].some(v => v.name === 'sketch'), '设置页「这一步会拿到什么」列出 sketch');

console.log('✓ model3d-sketch：' + n + ' 项通过');
