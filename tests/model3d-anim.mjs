#!/usr/bin/env node
/* 动画采样：关键帧插值、四种轨迹、节点 / 机位轨道、整表采样、播放时钟边界。纯函数。 */
import assert from 'node:assert/strict';
import { sampleKeys, samplePath, sampleTrack, sampleAnim, sampleCams, advanceTime } from '../web/model3d/anim.js';
import { normalizeDoc } from '../web/model3d/schema.js';
import { gaitControls, controlsOf } from '../web/model3d/mannequin.js';

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
  const hold = sampleKeys(keys, 1, 'hold');
  ok(hold.at[0] === 0, 'hold 在两帧之间保持前一帧');
  const linear = sampleKeys(keys, 1, 'linear');
  near(linear.at[0], 1, 1e-6, 'linear 是直线中点');
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

/* ---------- 自由路径 ---------- */
{
  const p = { kind: 'free', pts: [[-2, 0, 0], [0, 0, 2], [2, 0, 0]], closed: false };
  const a = samplePath(p, 0, 4);
  near(a.at[0], -2, 1e-6, '自由路径起点');
  const b = samplePath(p, 4, 4);
  near(b.at[0], 2, 1e-6, '自由路径终点');
  const m = samplePath(p, 2, 4);
  ok(m && Number.isFinite(m.at[0]) && Number.isFinite(m.at[2]), '自由路径中点可算');
  const closed = samplePath({ ...p, closed: true }, 4, 4);
  ok(closed && Number.isFinite(closed.at[0]), '闭合自由路径可算');
}

/* ---------- 轨道合成：路径打底、关键帧覆盖 ---------- */
{
  const track = {
    of: { kind: 'node', id: 'm1' }, motion: 'walk',
    path: { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] },
    keys: [{ t: 2, at: [0, 0, 5], pose: 'run' }],
  };
  const s1 = sampleTrack(track, 1, 4);
  near(s1.at[0], 1, 1e-6, '没有关键帧时按路径走');
  ok(s1.motion === 'walk', '轨道上的 motion 带出来');
  const s2 = sampleTrack(track, 2, 4);
  near(s2.at[2], 5, 1e-6, '关键帧覆盖路径的位置');
  ok(s2.pose === 'run', '关键帧覆盖姿势');
  ok(sampleTrack({ ...track, enabled: false }, 1, 4) === null, '停用的轨道不采样');
}

/* ---------- 整表采样 ---------- */
{
  const anim = {
    duration: 4,
    tracks: [
      { of: { kind: 'node', id: 'a' }, path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } },
      { of: { kind: 'node', id: 'b' }, keys: [{ t: 0, at: [0, 1, 0] }, { t: 4, at: [0, 3, 0] }] },
    ],
  };
  const m = sampleAnim(anim, 2);
  ok(Object.keys(m).length === 2, '两条轨道都采到');
  near(m.a.at[0], 1, 1e-6, 'a 在 t=2 走到中点');
  near(m.b.at[1], 2, 1e-6, 'b 在 t=2 升到一半');
  const late = sampleAnim(anim, 99);
  near(late.a.at[0], 2, 1e-6, '超出时长时路径停在终点');
  ok(Object.keys(sampleAnim(null, 1)).length === 0, '没有动画返回空表');
}

/* ---------- 机位采样：target / fov / follow ---------- */
{
  const { doc } = normalizeDoc({
    scene: {
      nodes: [{ kind: 'mannequin', id: 'hero', at: [10, 0, 0] }],
      cams: [
        { id: 'c1', name: '跟随', pos: [0, 2, 4], target: [0, 1, 0], fov: 35, follow: 'hero' },
        { id: 'c2', name: '看别处', pos: [0, 2, 4], target: [0, 1, 0], fov: 35 },
      ],
      active: 'c1',
    },
    anim: {
      duration: 4,
      tracks: [
        { id: 't1', of: { kind: 'cam', id: 'c1' }, keys: [{ t: 0, at: [0, 2, 4], target: [1, 1, 0], fov: 40 }] },
        { id: 't2', of: { kind: 'cam', id: 'c2' }, keys: [{ t: 0, at: [0, 2, 4] }] },
      ],
    },
  });
  const nodeSamples = sampleAnim(doc.anim, 0);
  const cams = sampleCams(doc.anim, doc, 0, nodeSamples);
  ok(cams.c1.fov === 40, '机位 fov 关键帧生效');
  near(cams.c1.target[0], 1, 1e-6, '机位 target 关键帧压过 follow');
  near(cams.c2.target[0], 0, 1e-6, '没有 target 关键帧时用静态 target');
  near(cams.c2.target[0], 0, 1e-6, '静态机位 target 不变');

  const noTarget = normalizeDoc({
    scene: {
      nodes: [{ kind: 'mannequin', id: 'hero', at: [10, 0, 0] }],
      cams: [{ id: 'c', pos: [0, 2, 4], target: [0, 1, 0], fov: 35, follow: 'hero' }],
      active: 'c',
    },
    anim: { duration: 4, tracks: [{ id: 't', of: { kind: 'cam', id: 'c' }, keys: [{ t: 0, at: [0, 2, 4] }] }] },
  }).doc;
  const follow = sampleCams(noTarget.anim, noTarget, 0, sampleAnim(noTarget.anim, 0));
  near(follow.c.target[0], 10, 1e-6, '没有 target 关键帧时机位跟到节点位置');
}

/* ---------- 播放时钟：循环 / 停住 ---------- */
{
  ok(advanceTime({ duration: 4, loop: true }, 3.5, 1).t === 0.5, '循环回卷');
  const once = advanceTime({ duration: 4, loop: false }, 3.5, 1);
  ok(once.t === 4 && once.ended === true, '不循环时停在时长末尾');
  ok(advanceTime({ duration: 4, loop: false }, 1, 1).t === 2, '不循环时中途照常走');
}

/* ---------- 子关节轨道：只动一个关节，路径与步态对它无效 ---------- */
{
  const track = {
    of: { kind: 'node', id: 'm1' }, joint: 'torso/leftShoulder', motion: 'walk',
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
  const deep = sampleTrack({ ...track, joint: 'a/b/c/d/e/f/g/h' }, 0, 2);
  ok(deep.joint === 'a/b/c/d/e/f/g/h', '关节路径不截断');
}

/* ---------- 整表：同一节点的关节轨道并进 joints，节点自身的走位照旧 ---------- */
{
  const anim = {
    duration: 2,
    tracks: [
      { of: { kind: 'node', id: 'm1' }, motion: 'run', path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } },
      { of: { kind: 'node', id: 'm1' }, joint: 'torso/leftShoulder', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 2, rot: [80, 0, 0] }] },
      { of: { kind: 'node', id: 'm1' }, joint: 'torso/rightShoulder', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 2, rot: [-80, 0, 0] }] },
    ],
  };
  const m = sampleAnim(anim, 1);
  ok(m.m1.joints.length === 2, '两条关节轨道都并进 joints：' + m.m1.joints.length);
  near(m.m1.joints[0].rot[0], 40, 1e-6, '第一条关节轨道的角度');
  near(m.m1.joints[1].rot[0], -40, 1e-6, '第二条各算各的');
  ok(m.m1.motion === 'run' && Math.abs(m.m1.at[0] - 1) < 1e-6, '节点自身的 motion / 位移不受关节轨道影响');
  ok(!('joint' in m.m1), '关节不进节点自身那一层');
}

/* ---------- 轨道自己的时钟：offset / speed / duration ---------- */
{
  const path = { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] };
  const base = { of: { kind: 'node', id: 'n1' }, path };
  ok(sampleTrack({ ...base, offset: 2 }, 1, 2) === null, 'offset 之前这条轨道不动');
  near(sampleTrack({ ...base, offset: 2 }, 3, 2).at[0], 1, 1e-6, 'offset 之后按局部时间走');
  near(sampleTrack({ ...base, speed: 2 }, 1, 2).at[0], 2, 1e-6, 'speed=2 时一秒走完全程');
  near(sampleTrack({ ...base, duration: 1 }, 0.5, 2).at[0], 1, 1e-6, 'duration 用自己的长度');
  near(sampleTrack({ ...base, duration: 1 }, 2, 2).at[0], 2, 1e-6, '走完停在终点');
  near(sampleTrack({ ...base, offset: 1, speed: 2, duration: 2 }, 2, 9).at[0], 2, 1e-6,
    '局部时间 = (t − offset) × speed');
}

/* ---------- keysMode=offset：路径形状保留，关键帧只当偏移 ---------- */
{
  const tr = {
    of: { kind: 'node', id: 'n1' },
    path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] },
    keysMode: 'offset',
    keys: [{ t: 0, at: [0, 0.5, 0] }, { t: 2, at: [0, 1, 0] }],
  };
  const s = sampleTrack(tr, 1, 2);
  near(s.at[0], 1, 1e-6, '路径的位移还在');
  near(s.at[1], 0.75, 1e-6, '关键帧在它上面加偏移');
  const over = sampleTrack({ ...tr, keysMode: 'override' }, 1, 2);
  near(over.at[0], 0, 1e-6, 'override 模式下关键帧接管（旧行为不变）');
}

/* ---------- 运镜：path / 轨道的 ease 与 framing ---------- */
{
  const path = { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] };
  near(samplePath(path, 0.5, 2).at[0], 0.5, 1e-6, '默认线性：半程走一半');
  near(samplePath({ ...path, ease: 'inout' }, 0.5, 2).at[0], 0.3125, 1e-6, 'inout 起停缓');
  near(samplePath({ ...path, ease: 'in' }, 0.5, 2).at[0], 0.125, 1e-6, 'in：起步慢');
  near(samplePath({ ...path, ease: 'out' }, 0.5, 2).at[0], 0.875, 1e-6, 'out：收尾慢');
  const tr = { of: { kind: 'node', id: 'n1' }, path };
  near(sampleTrack({ ...tr, ease: 'inout' }, 0.5, 2).at[0], 0.3125, 1e-6, '轨道级 ease 也生效');
}

/* framing：rule3 把主体挪到三分之一（目标点横向偏移） */
{
  const doc = normalizeDoc({
    scene: {
      nodes: [{ kind: 'prim', id: 'n1', shape: 'box', at: [0, 2, 0] }],
      cams: [{ id: 'cam-1', pos: [5, 0, 0], target: [0, 0, 0] }],
      view: { aspect: '16:9' },
    },
    anim: { duration: 4, tracks: [
      { id: 't1', of: { kind: 'cam', id: 'cam-1' }, path: { kind: 'line', from: [5, 2, 0], to: [5, 2, 0], look: 'target', lookAt: 'n1' } },
    ] },
  }).doc;
  const c1 = sampleCams(doc.anim, doc, 0, {})['cam-1'];
  ok(c1.target.join(',') === '0,2,0', 'center：目标就是主体');
  const doc2 = normalizeDoc({
    scene: {
      nodes: [{ kind: 'prim', id: 'n1', shape: 'box', at: [0, 2, 0] }],
      cams: [{ id: 'cam-1', pos: [5, 0, 0], target: [0, 0, 0] }],
      view: { aspect: '16:9' },
    },
    anim: { duration: 4, tracks: [
      { id: 't1', of: { kind: 'cam', id: 'cam-1' }, path: { kind: 'line', from: [5, 2, 0], to: [5, 2, 0], look: 'target', lookAt: 'n1', framing: 'rule3' } },
    ] },
  }).doc;
  const c2 = sampleCams(doc2.anim, doc2, 0, {})['cam-1'];
  ok(Math.abs(c2.target[2]) > 0.3, 'rule3：目标点横向让出位置（主体偏到三分之一）：' + c2.target.join(','));
  ok(Math.abs(c2.target[1] - 2) < 1e-6, 'rule3 只动横向，不改高度');
}

/* framing：keep 把主体钉在轨道起点那一刻的画幅位置（基线纯函数重算，不存上一帧） */
{
  const D2R = Math.PI / 180;
  /* 与采样同一把尺子：主体在画幅里的 NDC（正中 0、右缘 +1） */
  const ndcOf = (cam, subj, aspect) => {
    const fx = cam.target[0] - cam.at[0], fy = cam.target[1] - cam.at[1], fz = cam.target[2] - cam.at[2];
    const fl = Math.hypot(fx, fy, fz);
    const f = [fx / fl, fy / fl, fz / fl];
    let rx = -f[2], rz = f[0];
    const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;
    const u = [-rz * f[1], rz * f[0] - rx * f[2], rx * f[1]];
    const v = [subj[0] - cam.at[0], subj[1] - cam.at[1], subj[2] - cam.at[2]];
    const d = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    const tanH = Math.tan(Math.min(179, Math.max(1, cam.fov || 35)) * D2R / 2);
    return [(v[0] * rx + v[2] * rz) / (d * tanH * aspect),
      (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (d * tanH)];
  };
  const mkDoc = (track, nodeAt) => normalizeDoc({
    scene: {
      nodes: [{ kind: 'prim', id: 'n1', shape: 'box', at: nodeAt || [1, 0.5, 0] }],
      cams: [{ id: 'cam-1', pos: [0, 0, 5], target: [0, 0, 0] }],
      view: { aspect: '16:9' },
    },
    anim: { duration: 4, tracks: [{ id: 't1', of: { kind: 'cam', id: 'cam-1' }, ...track }] },
  }).doc;

  /* 横移机位 + 偏右上的主体：look:target 本来就把主体顶在正中，keep 与它同效；
     真正能分辨的是「不写 framing 时主体跟着路径漂」—— 用 center 档对照 */
  const path = { kind: 'line', from: [0, 0, 5], to: [3, 0, 5], look: 'target', lookAt: 'n1', framing: 'keep' };
  const doc = mkDoc({ path });
  const subj = [1, 0.5, 0];
  const c0 = sampleCams(doc.anim, doc, 0, {})['cam-1'];
  const base = ndcOf(c0, subj, 16 / 9);
  near(base[0], 0, 1e-6, '基线：起点主体在正中');
  near(base[1], 0, 1e-6, '基线：纵向也在正中');
  for (const t of [1, 2, 3.5, 4]) {
    const c = sampleCams(doc.anim, doc, t, {})['cam-1'];
    const ndc = ndcOf(c, subj, 16 / 9);
    near(ndc[0], base[0], 1e-3, 'keep：t=' + t + ' 横向回到基线');
    near(ndc[1], base[1], 1e-3, 'keep：t=' + t + ' 纵向回到基线');
  }
  /* 对照：同一条路径不写 look（target 留在原地），主体真的会漂 —— keep 把它拉回来 */
  const docDrift = mkDoc({ path: { kind: 'line', from: [0, 0, 5], to: [3, 0, 5] } });
  const drift = ndcOf(sampleCams(docDrift.anim, docDrift, 4, {})['cam-1'], subj, 16 / 9);
  ok(Math.abs(drift[0] - base[0]) > 0.05, '不 keep 主体真的会漂（判据没 vacuous）');
  const docKeepFixed = mkDoc({ path: { kind: 'line', from: [0, 0, 5], to: [3, 0, 5], framing: 'keep' } });
  for (const t of [1, 4]) {
    const c = sampleCams(docKeepFixed.anim, docKeepFixed, t, {})['cam-1'];
    const ndc = ndcOf(c, [0, 0, 0], 16 / 9);
    near(ndc[0], 0, 1e-3, 'keep（fixed）：原瞄准点横向钉在正中 t=' + t);
    near(ndc[1], 0, 1e-3, 'keep（fixed）：原瞄准点纵向钉在正中 t=' + t);
  }

  /* heading + lookAt：起点主体偏上，横移全程钉住那个偏上的位置 */
  const docHead = mkDoc({ path: { kind: 'line', from: [0, 0, 5], to: [1, 0, 5], look: 'heading', lookAt: 'n1', framing: 'keep' } }, [2, 0.3, 5]);
  const h0 = sampleCams(docHead.anim, docHead, 0, {})['cam-1'];
  const hBase = ndcOf(h0, [2, 0.3, 5], 16 / 9);
  ok(Math.abs(hBase[1]) > 0.1, 'heading 基线主体偏上：' + hBase.join(','));
  for (const t of [1, 2, 4]) {
    const c = sampleCams(docHead.anim, docHead, t, {})['cam-1'];
    const ndc = ndcOf(c, [2, 0.3, 5], 16 / 9);
    near(ndc[0], hBase[0], 2e-3, 'keep+heading：t=' + t + ' 横向钉住');
    near(ndc[1], hBase[1], 2e-3, 'keep+heading：t=' + t + ' 纵向钉住');
  }

  /* offset：基线取轨道自己开始那一刻，不是时间轴 0 秒 */
  const docOff = mkDoc({ offset: 2, path });
  const oStart = sampleCams(docOff.anim, docOff, 2, {})['cam-1'];
  const oBase = ndcOf(oStart, subj, 16 / 9);
  near(oBase[0], base[0], 1e-6, 'offset 轨道的基线 = 起点那一刻（与无 offset 同）');
  const oMid = ndcOf(sampleCams(docOff.anim, docOff, 3.5, {})['cam-1'], subj, 16 / 9);
  near(oMid[0], oBase[0], 1e-3, 'offset 轨道中途也钉住');
  const before = sampleCams(docOff.anim, docOff, 1, {})['cam-1'];
  ok(before.at.join(',') === '0,0,5', 'offset 之前轨道还没开始（机位静态）');

  /* 主体在机位初始位置身后：采样不炸、target 仍是有限数 */
  const docBehind = mkDoc({ path: { ...path, lookAt: 'n1' } }, [-1, 0.5, 9]);
  const cb = sampleCams(docBehind.anim, docBehind, 2, {})['cam-1'];
  ok(cb.target.every(Number.isFinite), '主体在身后：target 仍是有限数');
}

/* ---------- 机位沿路径走的朝向：heading / target ---------- */
{
  const doc = normalizeDoc({
    scene: {
      nodes: [{ kind: 'prim', id: 'n1', shape: 'box', at: [0, 2, 0] }],
      cams: [{ id: 'cam-1', pos: [0, 0, 5], target: [0, 0, 0] }],
    },
    anim: { duration: 4, tracks: [
      { id: 't1', of: { kind: 'cam', id: 'cam-1' }, path: { kind: 'circle', from: [0, 0, 0], radius: 2, look: 'heading' } },
    ] },
  }).doc;
  const cams = sampleCams(doc.anim, doc, 0, {});
  const c = cams['cam-1'];
  ok(c.at[0] > 1.5 && Math.abs(c.at[2]) < 1e-6, '机位在圆上：' + c.at.join(','));
  ok(c.target[0] > c.at[0] && Math.abs(c.target[2] - c.at[2]) < 1e-6,
    'heading：镜头沿切线看（不再死盯原来的 target）：' + c.target.join(','));

  const doc2 = normalizeDoc({
    scene: {
      nodes: [{ kind: 'prim', id: 'n1', shape: 'box', at: [0, 2, 0] }],
      cams: [{ id: 'cam-1', pos: [0, 0, 5], target: [0, 0, 0] }],
    },
    anim: { duration: 4, tracks: [
      { id: 't1', of: { kind: 'cam', id: 'cam-1' }, path: { kind: 'circle', from: [0, 0, 0], radius: 2, look: 'target', lookAt: 'n1' } },
    ] },
  }).doc;
  const c2 = sampleCams(doc2.anim, doc2, 0, {})['cam-1'];
  ok(c2.target.join(',') === '0,2,0', 'look:target 一直看着那个节点：' + c2.target.join(','));
}

/* ---------- solo / follow ---------- */
{
  const anim = {
    duration: 4,
    tracks: [
      { of: { kind: 'node', id: 'n1' }, keys: [{ t: 0, at: [1, 0, 0] }] },
      { of: { kind: 'node', id: 'n1' }, keys: [{ t: 0, at: [9, 0, 0] }], solo: true },
    ],
  };
  const m = sampleAnim(anim, 0);
  near(m.n1.at[0], 9, 1e-6, 'solo 之后只采样被 solo 的轨道');
  const m2 = sampleAnim({ tracks: anim.tracks.map(t => ({ ...t, solo: false })) }, 0);
  near(m2.n1.at[0], 9, 1e-6, '同节点的后一条轨道照旧覆盖前一条（旧行为）');

  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'group', id: 'a', children: [{ kind: 'prim', id: 'p', shape: 'box' }] },
    { kind: 'group', id: 'b', at: [5, 0, 0], children: [{ kind: 'prim', id: 'q', shape: 'box' }] },
  ] } }).doc;
  const fam = { duration: 4, tracks: [
    { of: { kind: 'node', id: 'a' }, follow: 'b', keys: [{ t: 0, at: [1, 0, 0] }] },
  ] };
  const fm = sampleAnim(fam, 0, doc);
  near(fm.a.at[0], 6, 1e-6, 'follow：位移叠在被跟随节点身上');
}

/* ---------- 键上的 scale / visible / ease ---------- */
{
  const keys = [{ t: 0, scale: [1, 1, 1], visible: true }, { t: 2, scale: [2, 2, 2], visible: false }];
  const mid = sampleKeys(keys, 1, 'smooth');
  near(mid.scale[0], 1.5, 1e-6, '缩放插值');
  ok(mid.visible === true, '显隐是 STEP：到下一帧才切');
  ok(sampleKeys(keys, 2, 'smooth').visible === false, '到最后一帧切过去');
  const slow = [{ t: 0, at: [0, 0, 0] }, { t: 2, at: [1, 0, 0], ease: 'linear' }];
  near(sampleKeys(slow, 0.5, 'smooth').at[0], 0.25, 1e-6, '键上的 ease 覆盖轨道级 interp');
  near(sampleKeys(slow.map(k => ({ ...k, ease: undefined })), 0.5, 'smooth').at[0], 0.15625, 1e-6,
    '不写 ease 时仍是轨道级的平滑');
}

/* ---------- motion 参数化与三层叠加顺序 ---------- */
{
  const base = gaitControls('walk', 0.13);
  const slow = gaitControls({ kind: 'walk', speed: 0.5 }, 0.13);
  ok(base['leftShoulder.pitch'] !== slow['leftShoulder.pitch'], 'speed 0.5 时相位不同（步频减半）');
  const arms = gaitControls({ kind: 'walk', arm: 0.5 }, 0.13);
  near(arms['leftShoulder.pitch'], base['leftShoulder.pitch'] / 2, 1e-6, 'arm 调臂摆');
  const legs = gaitControls({ kind: 'walk', stride: 2 }, 0.13);
  near(legs['leftHip.pitch'], base['leftHip.pitch'] * 2, 1e-6, 'stride 调腿摆');
  ok(gaitControls({ kind: 'walk' }, 0.13)['leftShoulder.pitch'] === base['leftShoulder.pitch'], '对象形态与字符串同值');

  /* 顺序：姿势表 → node.controls → 步态（覆盖同一关节）；关节轨道在 rig.applyPose 里最后叠加 */
  const merged = controlsOf({ pose: 't-pose', motion: 'walk', t: 0.13, controls: { 'head.yaw': 20, 'leftShoulder.pitch': 3 } });
  ok(merged['head.yaw'] === 20, 'node.controls 盖过姿势表');
  ok(merged['leftShoulder.pitch'] === base['leftShoulder.pitch'], '步态最后盖过 controls');
}

console.log('✓ model3d-anim：' + n + ' 项通过');
