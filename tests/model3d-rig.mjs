#!/usr/bin/env node
/* 骨架写回：关节表的两套键（路径 / 短名）、角度 → 四元数、限位夹取、子关节轨道的叠加语义。
   全部纯函数 + vendored three 的 Bone，不开浏览器。 */
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three/three.module.js';
import {
  quatOfDegrees, poseTableOf, applyPose, applyJoints, jointsOf, registerJoint,
  jointParts, jointPathOf,
} from '../web/model3d/rig.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= (eps || 1e-6), m + '（' + a + ' ≈ ' + b + '）');

/* ---------- ① 度 → 四元数：轴序 XYZ，90° 的实部是 √2/2 ---------- */
{
  const q = quatOfDegrees([90, 0, 0]);
  near(q.x, Math.SQRT1_2, 1e-6, '绕 X 转 90° 的 x 分量');
  near(q.w, Math.SQRT1_2, 1e-6, '绕 X 转 90° 的 w 分量');
  const y = quatOfDegrees([0, 180, 0]);
  near(Math.abs(y.y), 1, 1e-6, '绕 Y 转 180° 的 y 分量');
  ok(quatOfDegrees(null).w === 1, '没有角度时是单位四元数');
}

/* ---------- ② 角度表：轴名归一到 XYZ，位移单列 ---------- */
{
  const { angles, moves } = poseTableOf({
    'leftShoulder.pitch': 10, 'leftShoulder.bend': 5, 'leftShoulder.twist': 15,
    'leftHip.roll': 20, 'leftHip.spread': 5, 'body.offsetY': -0.4,
    'nope': 1, '.x': 2,
  });
  ok(JSON.stringify(angles.get('leftShoulder')) === '[15,15,0]', 'pitch / bend 归 X，twist 归 Y：' + JSON.stringify(angles.get('leftShoulder')));
  ok(JSON.stringify(angles.get('leftHip')) === '[0,0,25]', 'roll / spread 归 Z：' + JSON.stringify(angles.get('leftHip')));
  ok(moves.get('body')[1] === -0.4, 'offsetY 进位移');
  ok(!angles.has('nope') && !angles.has(''), '没有点号 / 空名字的键不计');
}

/* ---------- ③ 关节表：路径与短名落到同一根骨头 ---------- */
function buildJoints() {
  const body = new THREE.Bone(); body.name = 'body';
  body.userData.baseRot = [0, 0, 0]; body.userData.baseAt = [0, 1, 0];
  const torso = new THREE.Bone(); torso.name = 'torso';
  torso.userData.baseRot = [0, 0, 0]; torso.userData.baseAt = [0, 0.3, 0];
  const shoulder = new THREE.Bone(); shoulder.name = 'leftShoulder';
  shoulder.userData.baseRot = [10, 0, 0]; shoulder.userData.baseAt = [0, 0, 0]; shoulder.userData.limitDeg = 90;
  const elbow = new THREE.Bone(); elbow.name = 'leftElbow';
  elbow.userData.baseRot = [0, 0, 0]; elbow.userData.baseAt = [0, 0, 0]; elbow.userData.limitDeg = 120;
  body.add(torso); torso.add(shoulder); shoulder.add(elbow);
  const joints = new Map();
  registerJoint(joints, 'body', body);
  registerJoint(joints, 'torso', torso);
  registerJoint(joints, 'torso/leftShoulder', shoulder);
  registerJoint(joints, 'torso/leftShoulder/leftElbow', elbow);
  return { body, torso, shoulder, elbow, joints };
}
{
  const { shoulder, elbow, joints } = buildJoints();
  ok(joints.get('torso/leftShoulder') === shoulder, '路径键查得到');
  ok(joints.get('leftShoulder') === shoulder, '裸关节名也查得到（姿势表用短名）');
  ok(joints.get('torso/leftShoulder/leftElbow') === elbow, '深层路径查得到');
  const content = { joints: new Map([['m1', joints]]) };
  ok(jointsOf(content, 'm1') === joints, 'jointsOf 按节点 id 取表');
  ok(jointsOf(content, 'nope') === null, '没有这个节点的表时返回 null');
  ok(jointsOf({}, 'm1') === null, '内容里没有关节表时返回 null');
  ok(jointPathOf(' torso / / leftShoulder ') === 'torso/leftShoulder', '路径去空白与空段');
  ok(jointParts('a/b/c/d/e/f/g').length === 7, '切段不截断');
  ok(jointPathOf('a/b/c/d/e/f/g') === 'a/b/c/d/e/f/g', '关节路径不截断');
}

/* ---------- ④ applyPose：先复位到 base 再叠加，逐次调用不攒增量 ---------- */
{
  const { body, shoulder, elbow, joints } = buildJoints();
  applyPose(joints, { 'leftShoulder.pitch': 30 });
  ok(shoulder.quaternion.angleTo(quatOfDegrees([40, 0, 0])) < 1e-6, 'base 10 + 30 = 40');
  applyPose(joints, { 'leftShoulder.pitch': 30 });
  ok(shoulder.quaternion.angleTo(quatOfDegrees([40, 0, 0])) < 1e-6, '再调一次仍是 40（不累加到 70）');
  applyPose(joints, { 'leftShoulder.pitch': 500 });
  ok(shoulder.quaternion.angleTo(quatOfDegrees([90, 0, 0])) < 1e-6, '超过限位被夹到 90');
  applyPose(joints, { 'leftElbow.bend': 200 });
  ok(elbow.quaternion.angleTo(quatOfDegrees([120, 0, 0])) < 1e-6, '肘的限位是 120');
  applyPose(joints, { 'body.offsetY': -0.4, 'leftShoulder.offsetY': 0.2 });
  near(body.position.y, 0.6, 1e-6, 'body 从 base 1 降到 0.6');
  near(shoulder.position.y, 0.2, 1e-6, '关节位移叠加在 baseAt 上');
  applyPose(joints, { 'ghost.pitch': 10 });
  ok(shoulder.quaternion.angleTo(quatOfDegrees([10, 0, 0])) < 1e-6, '不认识的关节名跳过，别的关节照旧复位');
}

/* ---------- ⑤ applyJoints：一条轨道一个关节，rot 是「当前姿势之上」的增量 ---------- */
{
  const { elbow, shoulder, joints } = buildJoints();
  applyJoints(joints, [{ joint: 'torso/leftShoulder/leftElbow', rot: [80, 0, 0] }]);
  ok(elbow.quaternion.angleTo(quatOfDegrees([80, 0, 0])) < 1e-6, '小臂抬 80°');
  applyJoints(joints, [{ joint: 'torso/leftShoulder/leftElbow', rot: [40, 0, 0] }]);
  ok(elbow.quaternion.angleTo(quatOfDegrees([40, 0, 0])) < 1e-6, '下一帧是 40（每帧从 base 重算）');
  const before = shoulder.quaternion.clone();
  applyJoints(joints, [{ joint: '', rot: [30, 0, 0] }, { joint: null, rot: [30, 0, 0] }]);
  ok(shoulder.quaternion.angleTo(before) < 1e-6, '没有 joint 的条目整个跳过');

  /* 镜像 / 阵列：同一个节点两套骨头，同一张角度表写两遍 */
  const second = buildJoints();
  applyJoints([joints, second.joints], [{ joint: 'leftShoulder', rot: [0, 20, 0] }]);
  ok(shoulder.quaternion.angleTo(quatOfDegrees([10, 20, 0])) < 1e-6, '第一份写到');
  ok(second.shoulder.quaternion.angleTo(quatOfDegrees([10, 20, 0])) < 1e-6, '第二份也写到');
  ok(second.elbow.quaternion.angleTo(quatOfDegrees([0, 0, 0])) < 1e-6, '没点名的关节仍在 base');
}

console.log('✓ model3d-rig：' + n + ' 项通过');
