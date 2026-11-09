#!/usr/bin/env node
/* 灯光实体化：灯进文档、与机位平级、AI 可控。
   ① 默认灯装置与以前写死在 scene.js 的两盏平行光逐参数一致（存量文档出图不变）；
   ② 归一化：三种形状、`lights` 省掉 = 默认 / 空数组 = 只留半球光、投影只对太阳、锥角与柔边夹取；
   ③ 灯轨道：`of.kind:'light'` 校验、键上的 energy / color、采样（含 follow 与颜色不插值）；
   ④ sparseDoc：默认装置整段省掉、空数组与自定义灯落盘；
   ⑤ applyDocOps 的 light：add / set / remove / 装置级；选中实体时拒绝（与机位同规则）；
   ⑥ run()：没选中实体时交来的 light ops 直接应用（AI 能改光），节点增删仍只认 model；
   ⑦ 渲染侧：setStageLights 建出的灯与采样一致，阴影相机按内容收紧，灯标识能被拾取；
   ⑧ 两份契约逐字节同源（快档）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  normalizeDoc, sparseDoc, applyDocOps, emptyDoc, defaultLights, defaultLightDev, LIGHT_SHAPES,
} from '../web/model3d/schema.js';
import { sampleLights, sampleTrack } from '../web/model3d/anim.js';
import {
  createStage, disposeStage, setStageLights, applyLightSample, tightenStageShadows,
  setLightRigs, updateLightRig,
} from '../web/model3d/scene.js';
import { run } from '../web/model3d/ai.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/* ---- ① 默认灯装置 = 旧 scene.js 的三盏灯（逐参数） ---- */
{
  const lights = defaultLights();
  ok(lights.length === 2, '默认两盏灯（主光 + 补光）');
  const key = lights[0];
  ok(key.id === 'l-key' && key.name === '主光' && key.shape === 'sun', '主光是一盏太阳');
  ok(key.at.join(',') === '4.2,7.5,5.2' && key.target.join(',') === '0,0,0', '主光位置与朝向照旧');
  ok(key.energy === 2.1 && key.color === '#ffffff', '主光能量与颜色照旧');
  ok(key.shadow.on === true && key.shadow.mapSize === 2048
    && close(key.shadow.bias, -0.0005) && close(key.shadow.normalBias, 0.02), '主光的投影参数照旧');
  const fill = lights[1];
  ok(fill.id === 'l-fill' && fill.shape === 'sun' && fill.at.join(',') === '-5,3.5,-4'
    && fill.energy === 0.45 && fill.shadow.on === false, '补光照旧、不投影');
  const dev = defaultLightDev();
  ok(dev.hemi.sky === '#ffffff' && dev.hemi.ground === '#d9d4cc' && dev.hemi.energy === 1.35, '半球光照旧');
  ok(dev.ground.color === '#1a1a1a' && dev.ground.opacity === 0.16 && dev.exposure === 1, '地面阴影与曝光照旧');
}

/* ---- ② 归一化 ---- */
{
  const none = normalizeDoc({ scene: { nodes: [] } }).doc;
  ok(none.scene.lights.length === 2 && none.scene.lights[0].id === 'l-key', '不带 lights 的存量文档读进来是默认灯');
  const blank = normalizeDoc({ scene: { nodes: [], lights: [] } }).doc;
  ok(blank.scene.lights.length === 0, '写成空数组 = 只留半球光');
  const { doc, dropped } = normalizeDoc({
    scene: {
      lights: [
        { id: 'l-x', name: '轮廓', shape: 'spot', at: [2, 2, -2], target: [0, 1, 0], energy: 40, color: '#8FB8FF', angle: 9, penumbra: 3, distance: 8 },
        { id: 'l-y', shape: 'point', at: [1, 1, 1] },
        { id: 'l-key', shape: 'sun', shadow: { on: true } },
        'bad',
      ],
    },
  });
  ok(dropped.light === 1 && dropped.details.some(d => d.what === 'light' && d.why === '不是对象'),
    '坏灯记进丢件明细');
  const spot = doc.scene.lights.find(l => l.id === 'l-x');
  ok(spot.color === '#8fb8ff', '颜色归一成小写六位');
  ok(close(spot.angle, Math.PI / 2, 0.001), '锥角夹在 (0, π/2]：' + spot.angle);
  ok(close(spot.penumbra, 1) && spot.distance === 8, '柔边夹在 0~1，距离照收');
  const point = doc.scene.lights.find(l => l.id === 'l-y');
  ok(point.target === undefined && point.distance === 0 && point.shadow === undefined, '点光没有 target / 阴影，距离默认 0');
  const dup = doc.scene.lights.filter(l => l.id === 'l-key');
  ok(dup.length === 1 && doc.scene.lights[doc.scene.lights.length - 1].id === 'l-key', 'id 撞车时改号（后到的那盏）');
  ok(spot.energy === 40 && LIGHT_SHAPES.join(',') === 'sun,point,spot', '能量照收 / 形状表三种');
}

/* ---- ③ 灯轨道 ---- */
{
  const doc = normalizeDoc({
    scene: { nodes: [], lights: [{ id: 'l-a', shape: 'sun', at: [1, 2, 3], target: [0, 0, 0], energy: 2 }] },
    anim: { tracks: [
      { id: 't1', of: { kind: 'light', id: 'l-a' }, keys: [
        { t: 0, energy: 1, color: '#ff0000' }, { t: 2, energy: 3, color: '#00ff00' },
      ] },
      { id: 't2', of: { kind: 'light', id: 'l-nope' }, keys: [{ t: 0, energy: 1 }] },
    ] },
  }).doc;
  ok(doc.anim.tracks.length === 1 && doc.anim.tracks[0].of.kind === 'light', '灯轨道保留、指错灯的丢掉');
  const tr = doc.anim.tracks[0];
  ok(tr.keys[0].energy === 1 && tr.keys[0].color === '#ff0000' && tr.keys[1].color === '#00ff00', '键上的能量与颜色都收下');
  const s0 = sampleTrack(tr, 0, 2);
  ok(s0.energy === 1 && s0.color === '#ff0000', 't=0 取第一帧');
  const s1 = sampleTrack(tr, 1, 2);
  ok(close(s1.energy, 2), '能量在关键帧之间插值：' + s1.energy);
  ok(s1.color === '#00ff00', '颜色不插值，直接取后一帧那一档');
  const lights = sampleLights(doc.anim, doc, 1, {});
  ok(close(lights['l-a'].energy, 2) && lights['l-a'].target.join(',') === '0,0,0', 'sampleLights 与 sampleTrack 对上');
}

/* 灯的 follow：没有 target 关键帧时照向节点 */
{
  const doc = normalizeDoc({
    scene: {
      nodes: [{ kind: 'prim', id: 'n1', shape: 'box', size: [1, 1, 1], at: [2, 1, 0] }],
      lights: [{ id: 'l-a', shape: 'spot', at: [0, 2, 0], follow: 'n1', energy: 10 }],
    },
  }).doc;
  const lights = sampleLights(doc.anim, doc, 0, {});
  ok(lights['l-a'].target.join(',') === '2,1,0', 'follow 把 target 钉到节点上');
}

/* ---- ④ sparseDoc ---- */
{
  const blank = normalizeDoc({ scene: { nodes: [], lights: [] } }).doc;
  ok(JSON.stringify(sparseDoc(blank).scene.lights) === '[]', '空灯表要落盘（只留半球光）');
  const def = normalizeDoc({ scene: { nodes: [] } }).doc;
  ok(!('lights' in sparseDoc(def).scene) && !('light' in sparseDoc(def).scene), '默认装置整段省掉');
  const custom = normalizeDoc({ scene: {
    nodes: [], lights: [{ id: 'l-x', shape: 'point', at: [1, 2, 3], energy: 5 }],
    light: { exposure: 1.2 },
  } }).doc;
  const sp = sparseDoc(custom).scene;
  ok(sp.lights && sp.lights.length === 1 && sp.lights[0].id === 'l-x', '自定义灯照写');
  ok(sp.light && sp.light.exposure === 1.2, '装置改过曝光要落盘');
  const back = normalizeDoc(sp).doc;
  ok(back.scene.lights[0].energy === 5 && back.scene.light.exposure === 1.2, '稀疏形态读回来一致');
}

/* ---- ⑤ applyDocOps 的 light ---- */
{
  const doc = emptyDoc('灯');
  const r = applyDocOps(doc, [
    { op: 'light', id: 'l-key', set: { energy: 3.2, target: [1, 0.8, 0] } },
    { op: 'light', add: { name: '轮廓光', shape: 'spot', at: [2.4, 1.6, -2.2], target: [0, 0.8, 0], energy: 40, color: '#8fb8ff' } },
    { op: 'light', id: 'l-fill', remove: true },
    { op: 'light', set: { exposure: 1.15, hemi: { energy: 1.1 } } },
  ]);
  ok(r.applied === 4 && r.skipped === 0, '四条灯 op 全部生效：' + JSON.stringify(r.errors));
  const key = r.doc.scene.lights.find(l => l.id === 'l-key');
  ok(key.energy === 3.2 && key.target.join(',') === '1,0.8,0', 'id + set 改的是这一盏');
  const spot = r.doc.scene.lights.find(l => l.name === '轮廓光');
  ok(spot && spot.shape === 'spot' && spot.energy === 40 && spot.color === '#8fb8ff', 'add 的灯按形状归一');
  ok(!r.doc.scene.lights.some(l => l.id === 'l-fill'), 'remove 删掉那盏');
  ok(r.doc.scene.light.exposure === 1.15 && r.doc.scene.light.hemi.energy === 1.1, '没有 id 的 set 改装置级');
  ok(r.doc.scene.light.hemi.sky === '#ffffff', '装置级深合并：没点到的那几格不动');
  const scoped = applyDocOps(doc, [{ op: 'light', id: 'l-key', set: { energy: 9 } }], { scope: new Set(['n1']) });
  ok(scoped.skipped === 1 && scoped.errors[0].why.includes('不能改灯光'), '选中实体时灯 op 被拒（与机位同规则）');
  const bad = applyDocOps(doc, [{ op: 'light', id: 'l-none', set: { energy: 1 } }]);
  ok(bad.skipped === 1 && bad.errors[0].why.includes('找不到灯光'), '指错灯照实说');
}

/* ---- ⑥ run()：没选中实体时 light ops 直接应用 ---- */
{
  const FINAL = JSON.stringify({ say: '把主光挪到右边', ops: [
    { op: 'light', id: 'l-key', set: { target: [2, 1, 0] } },
  ] });
  globalThis.window = {
    Api: { registry: async () => ({ providers: [] }) },
    TextAI: {
      prompt: (sys) => sys,
      prov: () => ({ id: 'probe', kind: 'text' }),
      canRun: async () => true,
      chatStream: async (REG, sys, user, opts, push) => { push(FINAL); return FINAL; },
    },
  };
  const doc = normalizeDoc({ scene: { nodes: [{ kind: 'prim', id: 'n1', shape: 'box', size: [1, 1, 1] }] } }).doc;
  const r = await run({ prompt: '把主光换到右边', mode: 'auto', doc, selectedId: '', aspect: '16:9' });
  ok(r.applied === 1 && r.doc && r.doc.scene.lights.find(l => l.id === 'l-key').target.join(',') === '2,1,0',
    '没选中实体时 light op 也应用');
  const doc2 = normalizeDoc({ scene: { nodes: [{ kind: 'prim', id: 'n1', shape: 'box', size: [1, 1, 1] }] } }).doc;
  const del = JSON.stringify({ say: '删', ops: [{ op: 'remove', id: 'n1' }] });
  globalThis.window.TextAI.chatStream = async (REG, sys, user, opts, push) => { push(del); return del; };
  const r2 = await run({ prompt: '删掉那个盒子', mode: 'auto', doc: doc2, selectedId: '', aspect: '16:9' });
  ok(r2.doc === null && r2.why, '没选中实体时节点增删 op 不接（仍只认 model）');
}

/* ---- ⑦ 渲染侧 ---- */
{
  const stage = createStage();
  try {
    const lights = defaultLights();
    setStageLights(stage, lights, defaultLightDev());
    ok(stage.lightMap.size === 2, '两盏灯都建出来了');
    const key = stage.lightMap.get('l-key');
    ok(key.light.isDirectionalLight && close(key.light.intensity, 2.1), '主光是平行光、能量 2.1');
    ok(key.light.position.toArray().join(',') === '4.2,7.5,5.2', '主光位置照旧');
    ok(key.light.castShadow === true && key.light.shadow.mapSize.x === 2048, '主光投影照旧');
    ok(close(stage.hemi.intensity, 1.35), '半球光照旧');
    ok(close(stage.ground.material.opacity, 0.16), '地面阴影浓度照旧');
    tightenStageShadows(stage, 4);
    ok(close(key.light.shadow.camera.right, Math.max(2.5, 4 * 0.85)), '阴影相机按内容收紧');
    /* 逐帧采样：把能量与位置写进灯 */
    const doc = normalizeDoc({ scene: { lights: [{ id: 'l-a', shape: 'sun', at: [1, 2, 3], energy: 1 }] }, anim: { tracks: [
      { id: 't1', of: { kind: 'light', id: 'l-a' }, keys: [{ t: 0, energy: 2, at: [0, 1, 0] }] },
    ] } }).doc;
    setStageLights(stage, doc.scene.lights, { ...defaultLightDev(), exposure: 2 });
    const rec = stage.lightMap.get('l-a');
    const sample = sampleLights(doc.anim, doc, 0, {})['l-a'];
    applyLightSample(rec, sample);
    ok(close(rec.light.intensity, 4), '曝光倍率乘进能量：' + rec.light.intensity);
    ok(rec.light.position.toArray().join(',') === '0,1,0', '关键帧位置写进灯');
    setLightRigs(stage, doc.scene.lights, 'l-a');
    ok(stage.lightRigMap.size === 1 && stage.lightRigMap.get('l-a').pick.userData.lightId === 'l-a',
      '灯标识带得可拾取');
    updateLightRig(stage, doc.scene.lights[0], sample, true);
    ok(stage.lightRigMap.get('l-a').core.position.toArray().join(',') === '0,1,0', '标识跟着采样走');
  } finally {
    disposeStage(stage);
  }
}

/* ---- ⑧ 两份契约逐字节同源 ---- */
{
  const bodyOf = rel => read(rel).replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');
  const ctx = {
    window: {
      LS: { get: () => '' }, Store: { read: () => [], write: () => {} },
      Api: { errorMessage: () => 'err' },
      TplVars: { fill: t => t },
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(read('web/domain/text-ai.js'), ctx);
  const TextAI = ctx.window.TextAI;
  ok(bodyOf('skills/model3d/SKILL.md') === TextAI.DEF.model3d, 'SKILL.md 与 DEF.model3d 逐字节相同');
  ok(TextAI.DEF.model3d.includes('**灯光**：') && TextAI.DEF.model3d.includes('"op":"light"'), '契约里有灯光段与 light op');
}

console.log('✓ model3d-lights：' + n + ' 项通过');
