#!/usr/bin/env node
/* 导入件的动画播放：clip 清单 / 步态采样成 clip / mixer 按白膜时间轴写时间 / 蒙皮克隆互不串骨。
   全部纯 JS（AnimationMixer 不需要 WebGL），不开浏览器。 */
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three/three.module.js';
import { cloneAsset } from '../web/model3d/loader.js';
import {
  clipOf, clipNamesOf, loopOf, compileGait, mixerFor, bindClip, applyClip,
} from '../web/model3d/clip.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= (eps || 1e-6), m + '（' + a + ' ≈ ' + b + '）');
/* 四元数 → 绕轴转过的角度（度）。测试里的旋转都绕单轴，等价于 2·acos(|w|)。 */
const angleDeg = q => (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;

/* ---------- ① clip 清单：数组与 {clips} 两种形状 ---------- */
{
  const list = [{ name: 'idle' }, { name: 'walk' }, null, { name: '' }];
  ok(clipOf(list, 'walk') === list[1], '数组里按名字取到');
  ok(clipOf({ clips: list }, 'idle') === list[0], '{clips} 形状也认');
  ok(clipOf(list, 'nope') === null && clipOf(list, '') === null, '没有的名字 / 空名字是 null');
  ok(clipOf(null, 'walk') === null, '没有来源时是 null');
  ok(clipNamesOf(list).join(',') === 'idle,walk', '名字清单跳过坏项：' + clipNamesOf(list).join(','));
  ok(clipNamesOf({ clips: list }).length === 2, '{clips} 形状同样收名字');
  ok(clipNamesOf(null).length === 0, '没有来源时是空清单');
  ok(loopOf('once') === 'once' && loopOf('hold') === 'hold', 'once / hold 原样');
  ok(loopOf('nope') === 'loop' && loopOf(undefined) === 'loop', '不认识的循环档回到 loop');
}

/* ---------- ② 步态采样成 clip：时长 = 一个周期，首尾接得上 ---------- */
{
  const walk = compileGait('walk');
  near(walk.duration, 1 / 1.65, 1e-9, '走一个周期的时长');
  const run = compileGait('run');
  near(run.duration, 1 / 2.45, 1e-9, '跑一个周期的时长');
  near(compileGait('jump').duration, 1 / 1.65, 1e-9, '不认识的步态按走处理');

  const body = walk.tracks.find(t => t.name === 'body.position');
  ok(!!body, '有根位移轨道');
  ok(body.values.length === body.times.length * 3, '位移轨道每个时刻三个分量');
  const quats = walk.tracks.filter(t => t.name.endsWith('.quaternion'));
  ok(quats.length >= 10, '每个关节一条四元数轨道：' + quats.length);
  ok(quats.every(t => t.values.length === t.times.length * 4), '四元数轨道每个时刻四个分量');
  for (const t of quats) {
    const k = t.values.length;
    for (let i = 0; i < 4; i++) {
      near(t.values[i], t.values[k - 4 + i], 1e-6, '首尾帧接得上：' + t.name);
    }
  }
  /* KeyframeTrack 的时刻存成 Float32Array，0.6060606 会被舍入到 float32，比较留 1e-6 */
  near(walk.tracks[0].times[walk.tracks[0].times.length - 1], walk.duration, 1e-6, '最后一个采样点落在周期末尾');
  /* fps 决定采样密度：12 帧的一个周期是 7 步、8 个采样点 */
  ok(compileGait('walk', 12).tracks[0].times.length === 8, '采样密度跟着 fps 走');
}

/* ---------- ③ mixer 只按绝对时间写：同一时刻写两次结果相同 ---------- */
const makeHip = () => {
  const root = new THREE.Group();
  const hip = new THREE.Bone();
  hip.name = 'Hip';
  root.add(hip);
  return { root, hip };
};
const spin = new THREE.AnimationClip('spin', 2, [
  new THREE.QuaternionKeyframeTrack('Hip.quaternion', [0, 2], [
    ...new THREE.Quaternion().toArray(),
    ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray(),
  ]),
]);
{
  const { root, hip } = makeHip();
  const rec = mixerFor({ mixers: new Map() }, 'n1', root);
  ok(!!rec && !!rec.mixer, '建出了 mixer');
  bindClip(rec, spin, 'loop');
  const a = applyClip(rec, {}, 0.5);
  near(angleDeg(hip.quaternion), 22.5, 1e-3, 't=0.5 / 2 秒的轨道走到 22.5°');
  near(a.at, 0.5, 1e-9, '环内取模后的时间是 0.5');
  applyClip(rec, {}, 1.5);
  near(angleDeg(hip.quaternion), 67.5, 1e-3, 't=1.5 走到 67.5°');
  applyClip(rec, {}, 0.5);
  near(angleDeg(hip.quaternion), 22.5, 1e-3, '时间拖回去，角度也回得去（没有按 dt 累积）');
  const wrap = applyClip(rec, {}, 2.5);
  near(wrap.at, 0.5, 1e-9, '循环档对时长取模');
  const back = applyClip(rec, {}, 0);
  near(angleDeg(hip.quaternion), 0, 1e-3, '回到 0 即首帧');
  ok(back.ended === false, '循环档永远不算结束');
}

/* ---------- ④ 速度 / 偏移 / 循环档 / 结束判定 ---------- */
{
  const { root, hip } = makeHip();
  const rec = mixerFor({ mixers: new Map() }, 'n2', root);
  bindClip(rec, spin, 'loop');
  const fast = applyClip(rec, { clipSpeed: 2, clipOffset: 1 }, 0.5);
  near(fast.local, 3, 1e-9, '局部时间 = (成片秒 + 偏移) × 速度');
  near(fast.at, 1, 1e-9, '1.5 秒对 2 秒取模是 1');
  near(angleDeg(hip.quaternion), 45, 1e-3, '速度与偏移真的作用到骨头上');

  const big = applyClip(rec, { clipSpeed: 99, clipOffset: 999 }, 0);
  near(big.local, 98901, 1e-9, '速度 / 偏移不设上限：99 × 999');
  near(big.at, 1, 1e-9, '98901 秒对 2 秒取模是 1');
  const low = applyClip(rec, { clipSpeed: -5, clipOffset: -3 }, -2);
  near(low.local, 0, 1e-9, '速度非正时回到 0.001、负时间按 0 算');
  ok(rec.duration === 2, '时长沿用 clip.duration');
}
{
  const { root, hip } = makeHip();
  const rec = mixerFor({ mixers: new Map() }, 'n3', root);
  bindClip(rec, spin, 'once');
  ok(rec.action.loop === THREE.LoopOnce && rec.action.repetitions === 1, 'once 档绑成播一次');
  const e = applyClip(rec, { clipLoop: 'once' }, 2.5);
  ok(e.at === 2 && e.ended === true, 'once 播完停在末帧');
  near(angleDeg(hip.quaternion), 90, 1e-3, '末帧角度保持 90°');
  ok(rec.ended === true, '结束状态记在 rec 上');
  const r = applyClip(rec, { clipLoop: 'once' }, 0);
  ok(r.ended === false, '回拖到 0 就不再是结束态');
  near(angleDeg(hip.quaternion), 0, 1e-3, '上一轮停在末帧后，重新启一遍还能写回首帧');
}
{
  const { root } = makeHip();
  const rec = mixerFor({ mixers: new Map() }, 'n4', root);
  bindClip(rec, spin, 'hold');
  ok(rec.action.loop === THREE.LoopOnce, 'hold 与 once 同一档（末帧由 clamp 语义体现在 at=时长）');
  const h = applyClip(rec, { clipLoop: 'hold' }, 9);
  ok(h.at === 2 && h.ended === true, 'hold 也停在末帧');
  const bad = applyClip(rec, { clipLoop: 'nope' }, 0);
  ok(bad.ended === false && bad.at === 0, '不认识的循环档回到 loop');
}
{
  const { root } = makeHip();
  const rec = mixerFor({ mixers: new Map() }, 'n5', root);
  bindClip(rec, new THREE.AnimationClip('zero', 0, []), 'loop');
  ok(rec.duration === 1e-4, '零时长 clip 有下限，不会除零');
  const z = applyClip(rec, {}, 3);
  ok(z.at <= 1e-4 && z.ended === false, '零时长按首帧算');
}

/* ---------- ⑤ mixer 的复用与换代 ---------- */
{
  const content = { mixers: new Map() };
  const { root: r1 } = makeHip();
  const rec1 = mixerFor(content, 'n1', r1);
  bindClip(rec1, spin, 'loop');
  applyClip(rec1, {}, 0.5);
  ok(mixerFor(content, 'n1', r1) === rec1, '同一个节点同一个 root 复用');
  const { root: r2 } = makeHip();
  const rec2 = mixerFor(content, 'n1', r2);
  ok(rec2 !== rec1 && content.mixers.get('n1') === rec2, '换了 root 就换一条记录');
  ok(rec1.action.isRunning() === false, '旧 mixer 上的动作停掉了');
  ok(mixerFor(content, '', r2) === null && mixerFor(content, 'n1', null) === null, '缺参数不建');
  ok(applyClip(null, {}, 0) === null, '没有记录不写时间');
  ok(applyClip(rec2, {}, 0) === null, '还没绑 clip 时不写时间');
}

/* ---------- ⑥ 蒙皮克隆：两个实例各动各的 ---------- */
{
  const buildSkinned = () => {
    const hip = new THREE.Bone();
    hip.name = 'Hip';
    const leg = new THREE.Bone();
    leg.name = 'Leg';
    leg.position.set(0, -0.4, 0);
    hip.add(leg);
    const mesh = new THREE.SkinnedMesh(
      new THREE.BoxGeometry(0.4, 0.9, 0.2),
      new THREE.MeshStandardMaterial());
    mesh.name = 'Body';
    mesh.add(hip);
    mesh.bind(new THREE.Skeleton([hip, leg]));
    const root = new THREE.Group();
    root.add(mesh);
    return root;
  };
  const proto = buildSkinned();
  const c1 = cloneAsset(proto);
  const c2 = cloneAsset(proto);
  const boneOf = (root) => {
    let found = null;
    root.traverse(o => { if (o.isBone && o.name === 'Hip') found = o; });
    return found;
  };
  const skelOf = (root) => {
    let found = null;
    root.traverse(o => { if (o.isSkinnedMesh) found = o.skeleton; });
    return found;
  };
  const h1 = boneOf(c1), h2 = boneOf(c2), hp = boneOf(proto);
  ok(h1 && h2 && hp, '三棵树里都找得到骨头');
  ok(h1 !== h2 && h1 !== hp, '克隆出来的骨头是独立对象');
  const s1 = skelOf(c1), s2 = skelOf(c2);
  ok(s1 && s2 && s1 !== s2, '骨架也各自一份');
  ok(s1.bones[0] === h1 && s2.bones[0] === h2, '每份骨架指向自己那棵树上的骨头');

  const content = { mixers: new Map() };
  const rec1 = mixerFor(content, 'a', c1);
  const rec2 = mixerFor(content, 'b', c2);
  bindClip(rec1, spin, 'loop');
  bindClip(rec2, spin, 'loop');
  applyClip(rec1, {}, 1);
  applyClip(rec2, {}, 0);
  near(angleDeg(h1.quaternion), 45, 1e-3, '第一份在 t=1 转到 45°');
  near(angleDeg(h2.quaternion), 0, 1e-3, '第二份没被带着动');
  near(angleDeg(hp.quaternion), 0, 1e-3, '原型也没被带着动');
}

console.log('✓ model3d-clip：' + n + ' 项通过');
