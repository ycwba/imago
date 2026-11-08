/* 动画采样 —— 纯函数：一条轨道在某一时刻的位姿。
   两种来源可以同时挂（路径给位移，关键帧给精确位姿）：先按路径算出「该在哪」，
   再用这一时刻前后最近的关键帧覆盖位置 / 朝向 / 姿势。AI 写模型时只会用其中一种，
   但手工调过的轨道常常两种都有（先定走位，再修某两帧）。

   时间一律是「这条时间轴的秒」，不是源素材秒 —— 白膜本来就没有源素材。
   节点轨道与机位轨道共用这一套采样；机位的 follow 只在没有 target 关键帧时生效。 */

import { findNode, jointPathOf } from './schema.js';

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => v * v * (3 - 2 * v);
const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

/* 关键帧之间的插值：smooth（默认，起停自然）/ linear / hold。
   首帧之前 / 末帧之后保持端点。 */
export function sampleKeys(keys, t, interp = 'smooth') {
  if (!Array.isArray(keys) || !keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t > b.t) continue;
    const a = keys[i - 1];
    if (interp === 'hold') return a;
    const span = b.t - a.t;
    const raw = span <= 1e-6 ? 1 : clamp01((t - a.t) / span);
    const k = interp === 'linear' ? raw : smooth(raw);
    return {
      t,
      at: (a.at && b.at) ? lerp3(a.at, b.at, k) : (b.at || a.at || null),
      rot: (a.rot && b.rot) ? lerp3(a.rot, b.rot, k) : (b.rot || a.rot || null),
      pose: b.pose || a.pose || '',
      target: (a.target && b.target) ? lerp3(a.target, b.target, k) : (b.target || a.target || null),
      fov: (a.fov != null && b.fov != null) ? lerp(a.fov, b.fov, k) : (b.fov != null ? b.fov : (a.fov != null ? a.fov : null)),
    };
  }
  return last;
}

/* Catmull-Rom：给自由路径用。closed 时首尾相接；开放路径两端各复制一个端点。 */
function catmull(p0, p1, p2, p3, k) {
  const k2 = k * k, k3 = k2 * k;
  return [0, 1, 2].map(i => 0.5 * (
    (2 * p1[i]) +
    (-p0[i] + p2[i]) * k +
    (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * k2 +
    (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * k3
  ));
}

function freeAt(path, u) {
  const pts = Array.isArray(path.pts) ? path.pts : [];
  if (pts.length < 2) return null;
  const closed = path.closed === true;
  const segs = closed ? pts.length : pts.length - 1;
  const pos = clamp01(u) * segs;
  const i = Math.min(segs - 1, Math.floor(pos));
  const k = pos - i;
  const pointAt = n => {
    if (closed) return pts[(n + pts.length) % pts.length];
    return pts[Math.max(0, Math.min(pts.length - 1, n))];
  };
  const p0 = pointAt(i - 1), p1 = pointAt(i), p2 = pointAt(i + 1), p3 = pointAt(i + 2);
  const point = catmull(p0, p1, p2, p3, k);
  const tangent = [
    (p2[0] - p0[0]) * 0.5,
    (p2[1] - p0[1]) * 0.5,
    (p2[2] - p0[2]) * 0.5,
  ];
  const yawDeg = (Math.abs(tangent[0]) < 1e-6 && Math.abs(tangent[2]) < 1e-6)
    ? 0 : (Math.atan2(tangent[0], tangent[2]) * 180) / Math.PI;
  return { at: point, yawDeg };
}

/* 轨迹：直线 / 圆 / 矩形 / 自由点列。orientation 由 yawDeg 给出（人沿着路走，脸朝前）。 */
export function samplePath(path, t, duration) {
  if (!path) return null;
  const d = Math.max(0.001, Number(duration) || 1);
  const u = clamp01(t / d);
  const from = path.from || [0, 0, 0];
  const to = path.to || [0, 0, 2];
  if (path.kind === 'free') return freeAt(path, u);
  if (path.kind === 'circle') {
    const r = Math.max(0.001, Number(path.radius) || 1.5);
    const dir = path.clockwise ? -1 : 1;
    const a = u * Math.PI * 2 * dir;
    return {
      at: [from[0] + Math.cos(a) * r, from[1], from[2] + Math.sin(a) * r],
      yawDeg: (Math.atan2(Math.cos(a) * dir, -Math.sin(a) * dir) * 180) / Math.PI,
    };
  }
  if (path.kind === 'rect') {
    const w = Math.abs(to[0] - from[0]) || 2;
    const dp = Math.abs(to[2] - from[2]) || 2;
    const per = 2 * (w + dp);
    let s = u * per;
    const corners = [[from[0], from[2]], [from[0] + w, from[2]], [from[0] + w, from[2] + dp], [from[0], from[2] + dp]];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const seg = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (s <= seg) {
        const k = seg <= 1e-6 ? 0 : s / seg;
        const x = lerp(a[0], b[0], k), z = lerp(a[1], b[1], k);
        return { at: [x, from[1], z], yawDeg: (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI };
      }
      s -= seg;
    }
    return { at: [from[0], from[1], from[2]], yawDeg: 0 };
  }
  /* 直线：默认沿 from → to；朝向取这条路的方向 */
  const point = lerp3(from, to, u);
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const yawDeg = (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) ? 0 : (Math.atan2(dx, dz) * 180) / Math.PI;
  return { at: point, yawDeg };
}

/* 一条轨道在 t 时刻的结果。
   节点：{ at, rot, pose, motion, joint }
   机位：{ at, target, fov }
   缺的项是 null（调用方就别动它）。 */
export function sampleTrack(track, t, duration) {
  if (!track || track.enabled === false) return null;
  const of = track.of;
  if (!of) return null;
  if (of.kind === 'cam') {
    const out = { at: null, target: null, fov: null };
    const p = track.path ? samplePath(track.path, t, duration) : null;
    if (p) out.at = p.at;
    const keys = track.keys || [];
    const hasTarget = keys.some(k => k.target);
    const hasFov = keys.some(k => k.fov != null);
    const k = sampleKeys(keys, t, track.interp);
    if (k) {
      if (k.at) out.at = k.at;
      if (hasTarget && k.target) out.target = k.target;
      if (hasFov && k.fov != null) out.fov = k.fov;
    }
    return out;
  }

  const joint = jointPathOf(track.joint);
  const out = { at: null, rot: null, pose: '', motion: joint ? '' : (track.motion || ''), joint };
  if (!joint) {
    const p = track.path ? samplePath(track.path, t, duration) : null;
    if (p) {
      out.at = p.at;
      out.rot = [0, p.yawDeg, 0];
    }
  }
  const keys = track.keys || [];
  const k = sampleKeys(keys, t, track.interp);
  /* 有路径时，第一帧之前按路径走（人还在路上），第一帧之后关键帧接管。
      纯关键帧轨道没有这个问题：第一帧之前保持第一帧，就是「还没开演」的样子。 */
  const useKeys = k && (!track.path || !keys.length || t >= keys[0].t);
  if (useKeys) {
    if (k.at) out.at = k.at;
    if (k.rot) out.rot = k.rot;
    if (!joint && k.pose) out.pose = k.pose;
  }
  return out;
}

/* 整份动画在 t 时刻的「按节点 id 索引的位姿表」；页面每帧只查一次表。
   同一个节点可以挂多条轨道（节点自身一条 + 若干子关节轨道），关节轨道并进 `joints` 数组。 */
export function sampleAnim(anim, t) {
  const map = {};
  if (!anim || !Array.isArray(anim.tracks)) return map;
  const duration = Math.max(0.001, Number(anim.duration) || 1);
  for (const tr of anim.tracks) {
    if (!tr || !tr.of || tr.of.kind !== 'node') continue;
    if (tr.enabled === false) continue;
    const s = sampleTrack(tr, Math.max(0, Number(t) || 0), duration);
    if (!s) continue;
    const entry = map[tr.of.id]
      || (map[tr.of.id] = { at: null, rot: null, pose: '', motion: '', joints: [] });
    if (s.joint) {
      if (s.at || s.rot) entry.joints.push({ joint: s.joint, at: s.at, rot: s.rot });
      continue;
    }
    if (s.at) entry.at = s.at;
    if (s.rot) entry.rot = s.rot;
    if (s.pose) entry.pose = s.pose;
    if (s.motion) entry.motion = s.motion;
  }
  return map;
}

/* 机位在 t 时刻的采样表；`nodeSamples` 来自 sampleAnim，用来跟随节点。
   follow 只在没有 target 关键帧时生效；track 里的 target 键优先。 */
export function sampleCams(anim, doc, t, nodeSamples) {
  const map = {};
  const cams = (doc && doc.scene && doc.scene.cams) || [];
  const tracks = (anim && Array.isArray(anim.tracks)) ? anim.tracks : [];
  const duration = Math.max(0.001, Number(anim && anim.duration) || 1);
  const atOf = id => {
    const s = nodeSamples && nodeSamples[id];
    if (s && s.at) return s.at;
    const n = doc ? findNode(doc.scene.nodes, id) : null;
    return n ? n.at : null;
  };
  for (const cam of cams) {
    const out = { at: cam.pos, target: cam.target, fov: cam.fov };
    let hasTargetKey = false;
    for (const tr of tracks) {
      if (!tr || tr.enabled === false || !tr.of || tr.of.kind !== 'cam' || tr.of.id !== cam.id) continue;
      if ((tr.keys || []).some(k => k.target)) hasTargetKey = true;
      const s = sampleTrack(tr, Math.max(0, Number(t) || 0), duration);
      if (!s) continue;
      if (s.at) out.at = s.at;
      if (s.target) out.target = s.target;
      if (s.fov != null) out.fov = s.fov;
    }
    if (!hasTargetKey && cam.follow) {
      const followAt = atOf(cam.follow);
      if (followAt) out.target = followAt;
    }
    map[cam.id] = out;
  }
  return map;
}

/* 播放时钟的边界：loop=true 回卷，false 停到 duration。 */
export function advanceTime(anim, t, dt) {
  const duration = Math.max(0.001, Number(anim && anim.duration) || 1);
  const next = Math.max(0, (Number(t) || 0) + (Number(dt) || 0));
  if (anim && anim.loop === false) {
    return { t: Math.min(duration, next), ended: next >= duration };
  }
  return { t: next % duration, ended: false };
}
