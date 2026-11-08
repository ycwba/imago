#!/usr/bin/env node
/* 动画采样：关键帧插值、三种轨迹、整表采样。纯函数。 */
import assert from 'node:assert/strict';
import { sampleKeys, samplePath, sampleTrack, sampleAnim } from '../web/model3d/anim.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= (eps || 1e-6), m + '（' + a + ' ≈ ' + b + '）');

/* ---------- 关键帧 ---------- */
{
  const keys = [
    { t: 0, at: [0, 0, 0], rot: [0, 0, 0] },
    { t: 2, at: [2, 0, 0], rot: [0, 90, 0], pose: 'wave' },
  ];
  const k0 = sampleKeys(keys, 0);
  ok(k0.at[0] === 0, 't=0 落在第一帧');
  const k1 = sampleKeys(keys, 2);
  ok(k1.at[0] === 2 && k1.pose === 'wave', 't=2 落在第二帧（带姿势）');
  const km = sampleKeys(keys, 1);
  near(km.at[0], 1, 1e-6, '中点是 1（线性中点）');
  near(km.rot[1], 45, 1e-6, '角度也插值');
  ok(km.pose === 'wave', '姿势按「后一帧」算（姿势不能插值）');
  ok(sampleKeys(keys, -5).at[0] === 0, '早于第一帧保持第一帧');
  ok(sampleKeys(keys, 99).at[0] === 2, '晚于最后一帧保持最后一帧');
  ok(sampleKeys([], 1) === null, '空表返回 null');
  const single = sampleKeys([{ t: 1, at: [5, 0, 0] }], 3);
  ok(single.at[0] === 5, '只有一帧时一直用它');
}

/* ---------- 直线 ---------- */
{
  const p = { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] };
  near(samplePath(p, 0, 4).at[0], 0, 1e-6, '起点');
  near(samplePath(p, 2, 4).at[0], 2, 1e-6, '走一半');
  near(samplePath(p, 4, 4).at[0], 4, 1e-6, '终点');
  near(samplePath(p, 2, 4).yawDeg, 90, 1e-6, '沿 +X 走时朝向 +X（yaw 90°）');
  const back = { kind: 'line', from: [0, 0, 0], to: [0, 0, -3] };
  near(Math.abs(samplePath(back, 1, 3).yawDeg), 180, 1e-6, '沿 -Z 走时朝后');
}

/* ---------- 圆 ---------- */
{
  const c = { kind: 'circle', from: [0, 0, 0], radius: 2, clockwise: false };
  const a0 = samplePath(c, 0, 8);
  near(a0.at[0], 2, 1e-6, '圆的起点在 +X 上（半径 2）');
  const a2 = samplePath(c, 2, 8);
  near(a2.at[0], 0, 1e-6, '四分之一圈到 +Z');
  near(a2.at[2], 2, 1e-6, '四分之一圈 z=2');
  const cw = samplePath({ kind: 'circle', from: [0, 0, 0], radius: 2, clockwise: true }, 2, 8);
  near(cw.at[2], -2, 1e-6, '顺时针时四分之一圈到 -Z');
}

/* ---------- 矩形 ---------- */
{
  const r = { kind: 'rect', from: [0, 0, 0], to: [2, 0, 2] };
  const p0 = samplePath(r, 0, 8);
  near(p0.at[0], 0, 1e-6, '矩形起点在角上');
  const p2 = samplePath(r, 2, 8);
  near(p2.at[0], 2, 1e-6, '四分之一圈走完第一条边');
  const pEnd = samplePath({ kind: 'rect', from: [0, 0, 0], to: [2, 0, 2] }, 7.999, 8);
  ok(Math.abs(pEnd.at[0]) < 0.01 && Math.abs(pEnd.at[2]) < 0.01, '绕回起点附近');
}

/* ---------- 轨道合成：路径打底、关键帧覆盖 ---------- */
{
  const track = {
    nodeId: 'm1', motion: 'walk',
    path: { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] },
    keys: [{ t: 2, at: [0, 0, 5], pose: 'run' }],
  };
  const s1 = sampleTrack(track, 1, 4);
  near(s1.at[0], 1, 1e-6, '没有关键帧时按路径走');
  ok(s1.motion === 'walk', '轨道上的 motion 带出来');
  const s2 = sampleTrack(track, 2, 4);
  near(s2.at[2], 5, 1e-6, '关键帧覆盖路径的位置');
  ok(s2.pose === 'run', '关键帧覆盖姿势');
}

/* ---------- 整表采样 ---------- */
{
  const anim = {
    duration: 4,
    tracks: [
      { nodeId: 'a', path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } },
      { nodeId: 'b', keys: [{ t: 0, at: [0, 1, 0] }, { t: 4, at: [0, 3, 0] }] },
    ],
  };
  const m = sampleAnim(anim, 2);
  ok(Object.keys(m).length === 2, '两条轨道都采到');
  near(m.a.at[0], 1, 1e-6, 'a 在 t=2 走到中点');
  near(m.b.at[1], 2, 1e-6, 'b 在 t=2 升到一半');
  const clamped = sampleAnim(anim, 99);
  near(clamped.a.at[0], 2, 1e-6, '超出时长按最后一刻算');
  ok(Object.keys(sampleAnim(null, 1)).length === 0, '没有动画返回空表');
}

/* ---------- 子关节轨道：只动一个关节，路径与步态对它无效 ---------- */
{
  const track = {
    nodeId: 'm1', joint: 'torso/leftShoulder', motion: 'walk',
    path: { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] },
    keys: [{ t: 0, rot: [0, 0, 0], pose: 'wave' }, { t: 2, rot: [80, 0, 0], pose: 'wave' }],
  };
  const s0 = sampleTrack(track, 0, 2);
  ok(s0.joint === 'torso/leftShoulder', '关节路径带出来');
  ok(s0.motion === '' && s0.at === null, '关节轨道不跑步态、也不走路径');
  ok(s0.pose === '', '关节轨道不设整身姿势');
  near(sampleTrack(track, 1, 2).rot[0], 40, 1e-6, '关节角度在关键帧之间插值');
  const s2 = sampleTrack({ ...track, joint: ' / torso // head / ' }, 1, 2);
  ok(s2.joint === 'torso/head', '关节路径归一：' + s2.joint);
}

/* ---------- 整表：同一节点的关节轨道并进 joints，节点自身的走位照旧 ---------- */
{
  const anim = {
    duration: 2,
    tracks: [
      { nodeId: 'm1', motion: 'run', path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } },
      { nodeId: 'm1', joint: 'torso/leftShoulder', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 2, rot: [80, 0, 0] }] },
      { nodeId: 'm1', joint: 'torso/rightShoulder', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 2, rot: [-80, 0, 0] }] },
    ],
  };
  const m = sampleAnim(anim, 1);
  ok(m.m1.joints.length === 2, '两条关节轨道都并进 joints：' + m.m1.joints.length);
  near(m.m1.joints[0].rot[0], 40, 1e-6, '第一条关节轨道的角度');
  near(m.m1.joints[1].rot[0], -40, 1e-6, '第二条各算各的');
  ok(m.m1.motion === 'run' && Math.abs(m.m1.at[0] - 1) < 1e-6, '节点自身的 motion / 位移不受关节轨道影响');
  ok(!('joint' in m.m1), '关节不进节点自身那一层');
}

console.log('✓ model3d-anim：' + n + ' 项通过');
