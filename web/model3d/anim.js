/* 动画采样 —— 纯函数：一条轨道在某一时刻的位姿。
   两种来源可以同时挂（路径给位移，关键帧给精确位姿）：先按路径算出「该在哪」，
   再用这一时刻前后最近的关键帧覆盖位置 / 朝向 / 姿势。AI 写模型时只会用其中一种，
   但手工调过的轨道常常两种都有（先定走位，再修某两帧）。

   时间一律是「这条时间轴的秒」，不是源素材秒 —— 白膜本来就没有源素材。 */

import { jointPathOf } from './schema.js';

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => v * v * (3 - 2 * v);
const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

/* 关键帧之间的插值：两帧之间用 smoothstep（起停自然），首帧之前 / 末帧之后保持端点。
   与参考项目的 hold / linear / smooth 三档同构，这里统一取 smooth —— 白膜是给人看走位的，
   hold 的跳变在预览里只会像卡顿。 */
export function sampleKeys(keys, t) {
  if (!Array.isArray(keys) || !keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t > b.t) continue;
    const a = keys[i - 1];
    const span = b.t - a.t;
    const k = span <= 1e-6 ? 1 : smooth(clamp01((t - a.t) / span));
    return {
      t,
      at: (a.at && b.at) ? lerp3(a.at, b.at, k) : (b.at || a.at || null),
      rot: (a.rot && b.rot) ? lerp3(a.rot, b.rot, k) : (b.rot || a.rot || null),
      pose: b.pose || a.pose || '',
    };
  }
  return last;
}

/* 轨迹：直线 / 圆 / 矩形。orientation=true 时朝向切线方向（人沿着路走，脸朝前）。 */
export function samplePath(path, t, duration) {
  if (!path) return null;
  const d = Math.max(0.001, Number(duration) || 1);
  const u = clamp01(t / d);
  const from = path.from || [0, 0, 0];
  const to = path.to || [0, 0, 2];
  if (path.kind === 'circle') {
    const r = Math.max(0.05, Number(path.radius) || 1.5);
    const dir = path.clockwise ? -1 : 1;
    const a = u * Math.PI * 2 * dir;
    return {
      at: [from[0] + Math.cos(a) * r, from[1], from[2] + Math.sin(a) * r],
      yawDeg: (Math.atan2(Math.cos(a) * dir, -Math.sin(a) * dir) * 180) / Math.PI,
    };
  }
  if (path.kind === 'rect') {
    const w = Math.max(0.05, Math.abs(to[0] - from[0]) || 2);
    const dp = Math.max(0.05, Math.abs(to[2] - from[2]) || 2);
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
  const at = lerp3(from, to, u);
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const yawDeg = (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) ? 0 : (Math.atan2(dx, dz) * 180) / Math.PI;
  return { at, yawDeg };
}

/* 一条轨道在 t 时刻的结果：{ at, rot, pose, motion, joint }，缺的项是 null（调用方就别动它）。
   `joint` 非空时这条轨道只驱动子关节：路径与步态对它没有意义，关键帧照常采样。 */
export function sampleTrack(track, t, duration) {
  if (!track) return null;
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
  const k = sampleKeys(keys, t);
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
  const duration = Math.max(0.1, Number(anim.duration) || 1);
  for (const tr of anim.tracks) {
    if (!tr || !tr.nodeId) continue;
    const s = sampleTrack(tr, Math.max(0, Math.min(duration, t)), duration);
    if (!s) continue;
    const entry = map[tr.nodeId]
      || (map[tr.nodeId] = { at: null, rot: null, pose: '', motion: '', joints: [] });
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
