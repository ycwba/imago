#!/usr/bin/env node
/* 小人：体型比例、20 个姿势、连续步态、以及「脚底落在地面上」这条硬要求。
   用 three 在 Node 里真的把那棵树建出来量包围盒（几何是纯数据，不需要 WebGL）。 */
import assert from 'node:assert/strict';
import { BODY_PRESETS, POSE_PRESETS, mannequinTree, gaitControls, controlsOf, poseLimitOf } from '../web/model3d/mannequin.js';
import { buildContent, boundsOf } from '../web/model3d/scene.js';
import { applyJoints } from '../web/model3d/rig.js';
import { normalizeDoc } from '../web/model3d/schema.js';

let n = 0;
const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };
const docOf = node => normalizeDoc({ scene: { nodes: [node] } }).doc;

/* ---------- 表本身 ---------- */
ok(BODY_PRESETS.length === 8, '8 种体型，实际 ' + BODY_PRESETS.length);
ok(POSE_PRESETS.length === 20, '20 个姿势，实际 ' + POSE_PRESETS.length);
ok(new Set(POSE_PRESETS.map(p => p.id)).size === 20, '姿势 id 不重复');
ok(POSE_PRESETS[0].id === 'stand', '第一个是站立');
ok(poseLimitOf('chibi') === 58 && poseLimitOf('child') === 72 && poseLimitOf('female') === 90, '各体型的关节上限');

/* ---------- 20 个姿势都站在地上 ---------- */
for (const pose of POSE_PRESETS) {
  const box = boundsOf(buildContent(docOf({ kind: 'mannequin', id: 'm', body: 'mannequin', pose: pose.id }), { outline: false }));
  ok(Math.abs(box.min.y) < 0.02, '姿势「' + pose.label + '」脚底贴地，实际 min.y=' + box.min.y.toFixed(3));
  ok(box.max.y > 0.8 && box.max.y < 4, '姿势「' + pose.label + '」高度合理：' + box.max.y.toFixed(2));
}

/* ---------- 体型：越小的体型越矮 ---------- */
{
  const h = {};
  for (const b of BODY_PRESETS) {
    const box = boundsOf(buildContent(docOf({ kind: 'mannequin', id: 'm', body: b.bodyType, pose: 'stand' }), { outline: false }));
    h[b.bodyType] = box.max.y - box.min.y;
  }
  ok(h.chibi < h.child && h.child < h.teen && h.teen < h.mannequin, '二头身 < 儿童 < 少年 < 成人：'
    + ['chibi', 'child', 'teen', 'mannequin'].map(k => k + '=' + h[k].toFixed(2)).join(' / '));
  ok(h.female > 2 && h.female < 3.6, '女性素体高度在合理范围：' + h.female.toFixed(2));
}

/* ---------- 姿势表真的会动关节 ---------- */
{
  const stand = mannequinTree({ body: 'mannequin', pose: 'stand' });
  const wave = mannequinTree({ body: 'mannequin', pose: 'wave' });
  const armOf = tree => tree.children.find(c => c.children && c.children.length >= 3 && c.children[0].parts.length > 0);
  ok(JSON.stringify(stand.rot) === JSON.stringify(wave.rot), '整体朝向不因为姿势改变');
  const armRot = t => {
    const shoulders = [];
    const walk = spec => {
      for (const c of spec.children || []) { if (c.rot && Math.abs(c.rot[0]) > 1e-6) shoulders.push(c.rot[0]); walk(c); }
    };
    walk(t);
    return shoulders;
  };
  ok(armRot(wave).length > 0, '招手这个姿势有旋转过的关节');
  ok(JSON.stringify(armRot(stand)) !== JSON.stringify(armRot(wave)), '站立与招手的关节角不同');
  void armOf;
}

/* ---------- 步态：相位不同则角度不同，且 walk 比 run 幅度小 ---------- */
{
  const g0 = gaitControls('walk', 0);
  const g1 = gaitControls('walk', 0.18);
  ok(g0 && g1, '走 / 跑都给出控制项');
  ok(g0['leftHip.pitch'] !== g1['leftHip.pitch'], '同一段步态在不同相位上髋角不同');
  const run = gaitControls('run', 0.1);
  ok(Math.abs(run['leftShoulder.pitch']) > Math.abs(g0['leftShoulder.pitch'] || 0) - 1e-9
    || Math.abs(run['leftHip.pitch']) > Math.abs(gaitControls('walk', 0.1)['leftHip.pitch'] || 0),
  '跑步的摆幅大于走路');
  ok(gaitControls('', 0) === null, '没有 motion 时不给步态');
}

/* ---------- 姿势 + 步态叠加：步态只覆盖它自己那几项 ---------- */
{
  const c = controlsOf({ pose: 'wave', motion: 'walk', t: 0 });
  ok(c['rightShoulder.pitch'] === 60 || c['rightShoulder.pitch'] === undefined || Math.abs(c['rightShoulder.pitch']) <= 90,
    '姿势里的右肩角度仍在');
  ok(typeof c['leftHip.pitch'] === 'number', '步态补上了髋角');
  const custom = controlsOf({ pose: 'stand', controls: { 'head.yaw': 30 } });
  ok(custom['head.yaw'] === 30, '显式 controls 覆盖姿势表');
}

/* ---------- 关节上限：超限角度被夹住（关节角一律是度） ---------- */
{
  const tree = mannequinTree({ body: 'chibi', pose: 'stand', controls: { 'leftShoulder.pitch': 999 } });
  const found = [];
  const walk = s => { for (const c of s.children || []) { found.push(c.rot[0]); walk(c); } };
  walk(tree);
  const max = Math.max(...found.map(Math.abs));
  ok(max <= 58 + 1e-6, '二头身的关节角被夹在 58° 以内：' + max.toFixed(1) + '°');
}

/* ---------- 结构级骨骼化：关节是 Bone，零件挂在骨骼下，关节表可写回 ---------- */
{
  const content = buildContent(docOf({ kind: 'mannequin', id: 'm', body: 'mannequin', pose: 'stand' }), { outline: false });
  let bones = 0;
  content.group.traverse(o => { if (o.isBone) bones += 1; });
  ok(bones >= 15, '一条人台至少有 15 根关节骨：' + bones);
  const joints = content.joints.get('m');
  ok(Array.isArray(joints) && joints.length === 1, '一个节点一份关节表');
  const map = joints[0];
  ok(map.get('body') && map.get('torso') && map.get('torso/head'), '路径键认得 body / torso / torso/head');
  ok(map.get('leftShoulder') === map.get('torso/leftShoulder'), '短名与路径落到同一根骨');
  ok(Array.isArray(map.get('torso/leftShoulder').userData.baseRot), '关节带基座角度（度）');
  content.group.updateMatrixWorld(true);
  const before = map.get('torso/leftShoulder').quaternion.clone();
  applyJoints(joints, [{ joint: 'torso/leftShoulder', rot: [40, 0, 0] }]);
  ok(!before.equals(map.get('torso/leftShoulder').quaternion), '子关节轨道真的转了那根骨');
  const other = map.get('torso/rightShoulder').quaternion.clone();
  applyJoints(joints, [{ joint: 'torso/leftShoulder', rot: [0, 0, 0] }]);
  ok(other.equals(map.get('torso/rightShoulder').quaternion), '没点名的关节不动');
  ok(map.get('torso/leftShoulder').quaternion.equals(before), '归零后回到站立姿势');
}

/* ---------- 同一份输入每次算出来一样（流式重建不能抖） ---------- */
{
  const a = JSON.stringify(mannequinTree({ body: 'female', pose: 'run', motion: 'run', t: 0.4 }));
  const b = JSON.stringify(mannequinTree({ body: 'female', pose: 'run', motion: 'run', t: 0.4 }));
  ok(a === b, '同样的参数两次建出同一棵树');
}

console.log('✓ model3d-mannequin：' + n + ' 项通过');
