/* 导入件自带的动画 clip（以及给判据造的一条步态 clip）—— 这里只有三件事：
   取 clip、绑 mixer、按白膜时间轴写时间。

   一条硬规矩：**只 `mixer.setTime`，不 `mixer.update(dt)`**。按 dt 累加会与墙钟播放漂移，
   而白膜的时间源只有 `doc.anim.duration` 一条（播放、拖动时间轴、出片都读它）。

   循环三档：`loop` 取模；`once` / `hold` 夹到末帧。`once` 不能在 finished 事件里改界面 ——
   出片不跑事件循环 —— 所以结束与否按 `local >= duration` 现算。 */

import * as THREE from '../vendor/three/three.module.js';
import { gaitControls } from './mannequin.js';
import { poseTableOf, quatOfDegrees } from './rig.js';

const LOOP_MODES = ['loop', 'once', 'hold'];

export function clipOf(source, name) {
  const list = Array.isArray(source) ? source : (source && Array.isArray(source.clips) ? source.clips : []);
  const want = String(name == null ? '' : name).trim();
  if (!want) return null;
  return list.find(c => c && c.name === want) || null;
}

export function clipNamesOf(source) {
  const list = Array.isArray(source) ? source : (source && Array.isArray(source.clips) ? source.clips : []);
  return list.filter(c => c && c.name).map(c => c.name);
}

export function loopOf(v) {
  return LOOP_MODES.indexOf(v) >= 0 ? v : 'loop';
}

/* 步态正弦按一个周期采样成一条可循环的 clip。人台自己仍走程序化采样（更省内存、参数可调），
   这条 clip 给判据与「想拿 mixer 播步态」的场合用：时长 = 一个步态周期。 */
export function compileGait(motion, fps = 24) {
  const kind = motion === 'run' ? 'run' : 'walk';
  const cadence = kind === 'run' ? 2.45 : 1.65;
  const cycle = 1 / cadence;
  const steps = Math.max(2, Math.round(cycle * (Number(fps) || 24)));
  const times = [];
  const quats = new Map();
  const rootPos = [];
  for (let i = 0; i <= steps; i++) {
    const t = cycle * (i / steps);
    times.push(t);
    const table = gaitControls(kind, t) || {};
    const { angles, moves } = poseTableOf(table);
    for (const [path, deg] of angles) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!quats.has(name)) quats.set(name, []);
      const q = quatOfDegrees(deg);
      quats.get(name).push(q.x, q.y, q.z, q.w);
    }
    const mv = moves.get('body') || [0, 0, 0];
    rootPos.push(mv[0], mv[1], mv[2]);
  }
  const tracks = [];
  for (const [name, values] of quats) {
    tracks.push(new THREE.QuaternionKeyframeTrack(name + '.quaternion', times.slice(), values));
  }
  tracks.push(new THREE.VectorKeyframeTrack('body.position', times.slice(), rootPos));
  return new THREE.AnimationClip(kind + '-gait', cycle, tracks);
}

/* 给一个节点建（或复用）mixer。`rebuild` 会换掉整棵树，旧 root 上的 mixer 必须停掉；
   同一个 nodeId 只留一条记录，绑的 root 变了就重建。 */
export function mixerFor(content, nodeId, root) {
  if (!content || !content.mixers || !nodeId || !root) return null;
  let rec = content.mixers.get(nodeId);
  if (rec && rec.root === root) return rec;
  if (rec) {
    try { rec.mixer.stopAllAction(); } catch (e) { /* 旧 mixer 停不下来不影响新的一棵 */ }
  }
  rec = { mixer: new THREE.AnimationMixer(root), root, clip: null, action: null, ended: false, duration: 0 };
  content.mixers.set(nodeId, rec);
  return rec;
}

/* 把 clip 绑到 mixer 上。同一个 rec 换 clip 时先把上一个 action 停掉 —— 两份动画同时叠着
   会互相覆盖同一批骨头，看起来像抖动。 */
export function bindClip(rec, clip, loop = 'loop') {
  if (!rec || !clip) return null;
  if (rec.clip === clip && rec.action) return rec.action;
  try { rec.mixer.stopAllAction(); } catch (e) { /* 同上 */ }
  const once = loopOf(loop) !== 'loop';
  const action = rec.mixer.clipAction(clip);
  action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  /* once / hold 夹住末帧：播到末尾时 action 自己失活，但 `_updateWeight` 会返回 0，
     末帧其实写不进骨头 —— 不夹的话「拖到末尾 / 重建后从末尾起播」看到的是绑定前的姿势。
     夹住之后每次同步由 applyClip 先清 paused 再 setTime，回拖不会跳回第一帧。 */
  action.clampWhenFinished = once;
  action.enabled = true;
  action.time = 0;
  action.play();
  rec.clip = clip;
  rec.action = action;
  rec.duration = Math.max(1e-4, Number(clip.duration) || 0);
  return action;
}

/* 按节点上的四格参数把时间写进去。`t` 是白膜成片秒。 */
export function applyClip(rec, node, t) {
  if (!rec || !rec.action || !rec.clip) return null;
  const speed = Math.max(0.1, Math.min(4, Number(node && node.clipSpeed) || 1));
  const offset = Math.max(0, Math.min(60, Number(node && node.clipOffset) || 0));
  const loop = loopOf(node && node.clipLoop);
  const dur = rec.duration;
  const local = (Math.max(0, Number(t) || 0) + offset) * speed;
  const ended = loop !== 'loop' && local >= dur;
  const at = loop === 'loop' ? local % dur : Math.min(dur, local);
  const action = rec.action;
  /* 上一轮停在末帧时 enabled 已经变 false；不重新启一遍，setTime 什么都不写 */
  action.enabled = true;
  action.paused = false;
  rec.mixer.setTime(at);
  rec.ended = ended;
  return { local, at, duration: dur, ended };
}
