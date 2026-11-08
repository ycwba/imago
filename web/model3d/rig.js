/* 骨架：关节表的读法与写回。这是「一串角度」变成「关节四元数」的唯一一处 ——
   mannequin.js 只算角度（度），scene.js 只造骨骼，页面只给路径与数字。

   · 关节树里每个关节对象带 `userData.baseRot`（度）/ `baseAt`（米）/ `limitDeg`；
     `applyPose` 每次先把关节复位到 base，再叠加这一轮的角度与位移，所以子关节轨道
     不会把上一帧的增量攒起来。
   · `jointsOf` 返回的 Map 同时认「路径」（`torso/leftShoulder`）与「关节名」（`leftShoulder`）：
     姿势表按名字写，子关节轨道按路径写，两种写法落到同一个 Bone 上。
   · 导入件不建关节表（骨头是文件自带的，归 mixer 管）；对着它们写子关节轨道不会生效。 */

import * as THREE from '../vendor/three/three.module.js';
import { jointParts, jointPathOf } from './schema.js';

export { jointParts, jointPathOf };

const D2R = Math.PI / 180;
const AXIS = {
  x: 0, pitch: 0, bend: 0,
  y: 1, yaw: 1, twist: 1,
  z: 2, roll: 2, spread: 2,
};
const OFFSET = { offsetx: 0, offsety: 1, offsetz: 2 };

export function quatOfDegrees(deg) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    (Number(deg && deg[0]) || 0) * D2R,
    (Number(deg && deg[1]) || 0) * D2R,
    (Number(deg && deg[2]) || 0) * D2R,
    'XYZ'));
}

/* 角度表 → 每个关节的 XYZ（度）+ 位移（米）。轴名与姿势表同一套：
   pitch / bend → X，yaw / twist → Y，roll / spread → Z；位移写 offsetX / offsetY / offsetZ。 */
export function poseTableOf(table) {
  const angles = new Map();
  const moves = new Map();
  for (const key of Object.keys(table || {})) {
    const i = key.lastIndexOf('.');
    if (i <= 0) continue;
    const path = key.slice(0, i);
    const prop = key.slice(i + 1).toLowerCase();
    const v = Number(table[key]);
    if (!Number.isFinite(v)) continue;
    if (AXIS[prop] !== undefined) {
      const a = angles.get(path) || [0, 0, 0];
      a[AXIS[prop]] += v;
      angles.set(path, a);
    } else if (OFFSET[prop] !== undefined) {
      const m = moves.get(path) || [0, 0, 0];
      m[OFFSET[prop]] = v;
      moves.set(path, m);
    }
  }
  return { angles, moves };
}

/* 关节表的写回。`joints` 是 `jointsOf` 给的那张 Map；同一个 Bone 的别名只复位 / 写一次。 */
export function applyPose(joints, table, opts = {}) {
  if (!joints || !joints.size) return;
  const { angles, moves } = poseTableOf(table);
  const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : 180;
  const state = new Map();
  for (const [, joint] of joints) {
    if (state.has(joint)) continue;
    const baseRot = joint.userData.baseRot || [0, 0, 0];
    const baseAt = joint.userData.baseAt || [0, 0, 0];
    state.set(joint, { deg: baseRot.slice(), at: baseAt.slice() });
  }
  for (const [path, delta] of angles) {
    const joint = joints.get(path);
    const st = joint && state.get(joint);
    if (!st) continue;
    const cap = Number.isFinite(joint.userData.limitDeg) ? joint.userData.limitDeg : limit;
    for (let i = 0; i < 3; i++) {
      st.deg[i] = Math.max(-cap, Math.min(cap, st.deg[i] + delta[i]));
    }
  }
  for (const [path, delta] of moves) {
    const joint = joints.get(path);
    const st = joint && state.get(joint);
    if (!st) continue;
    for (let i = 0; i < 3; i++) st.at[i] += delta[i];
  }
  for (const [joint, st] of state) {
    joint.quaternion.copy(quatOfDegrees(st.deg));
    joint.position.set(st.at[0], st.at[1], st.at[2]);
  }
}

/* 子关节轨道：entries = [{ joint, at, rot }]，rot 是度。走的是同一条 applyPose。
   一个节点可能有多份关节表（镜像 / 阵列的每一份各有一套 Bone），逐份写同一张角度表。 */
export function applyJoints(joints, entries, opts = {}) {
  if (!entries || !entries.length) return;
  const table = {};
  let any = false;
  for (const e of entries) {
    if (!e || !e.joint) continue;
    any = true;
    const rot = e.rot || null;
    if (rot) {
      table[e.joint + '.x'] = (table[e.joint + '.x'] || 0) + (rot[0] || 0);
      table[e.joint + '.y'] = (table[e.joint + '.y'] || 0) + (rot[1] || 0);
      table[e.joint + '.z'] = (table[e.joint + '.z'] || 0) + (rot[2] || 0);
    }
    const at = e.at || null;
    if (at) {
      table[e.joint + '.offsetX'] = at[0] || 0;
      table[e.joint + '.offsetY'] = at[1] || 0;
      table[e.joint + '.offsetZ'] = at[2] || 0;
    }
  }
  if (!any) return;
  for (const map of (Array.isArray(joints) ? joints : [joints])) {
    if (map && map.size) applyPose(map, table, opts);
  }
}

/* 一个节点的关节表。目前只有参数化人台建这张表（导入件的骨头由 clip 驱动）。 */
export function jointsOf(content, nodeId) {
  if (!content || !content.joints || !nodeId) return null;
  return content.joints.get(nodeId) || null;
}

/* 关节树里给每个关节记账：名字（applyPose 的短键）与路径（子关节轨道的键）都进同一张 Map。 */
export function registerJoint(map, path, joint) {
  if (!map || !joint) return;
  const clean = jointPathOf(path);
  if (clean) map.set(clean, joint);
  if (joint.name && !map.has(joint.name)) map.set(joint.name, joint);
  return joint;
}
