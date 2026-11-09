/* 动画采样 —— 纯函数：一条轨道在某一时刻的位姿。
   两种来源可以同时挂（路径给位移，关键帧给精确位姿）：先按路径算出「该在哪」，
   再用这一时刻前后最近的关键帧覆盖位置 / 朝向 / 姿势。AI 写模型时只会用其中一种，
   但手工调过的轨道常常两种都有（先定走位，再修某两帧）。

   时间一律是「这条时间轴的秒」，不是源素材秒 —— 白膜本来就没有源素材。
   节点 / 机位 / 灯光三种轨道共用这一套采样；机位与灯光的 follow 只在没有 target 关键帧时生效。 */

import { findNode, jointPathOf } from './schema.js';

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => v * v * (3 - 2 * v);
const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const D2R = Math.PI / 180;
const soloTaken = tracks => (tracks || []).some(t => t && t.solo === true);

/* 速度曲线：in / out / inout / linear / hold。路径与整条轨道共用这一份。 */
function easeU(u, ease) {
  const x = clamp01(u);
  if (ease === 'in') return x * x;
  if (ease === 'out') return 1 - (1 - x) * (1 - x);
  if (ease === 'inout') return x * x * (3 - 2 * x);
  if (ease === 'hold') return x >= 1 ? 1 : 0;
  return x;
}
const aspectOf = v => {
  const p = String(v == null ? '' : v).split(':').map(Number);
  return (p.length === 2 && p[0] > 0 && p[1] > 0) ? p[0] / p[1] : 16 / 9;
};

/* 一条轨道自己的时钟：从第 offset 秒开始、按 speed 倍速走、自己的 duration（0 = 用全局）。
   offset 之前返回 null（这条轨道还没开始）；之后按自己的局部时间采样，整条轨道可带 ease。 */
function trackClock(track, t, duration) {
  const off = Math.max(0, Number(track.offset) || 0);
  const sp = Number(track.speed) > 0 ? Number(track.speed) : 1;
  const dur = Math.max(0.001, Number(track.duration) > 0 ? Number(track.duration) : duration);
  if (t < off) return null;
  const u = clamp01(((t - off) * sp) / dur);
  return { lt: easeU(u, track.ease) * dur, dur };
}

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
    const mode = b.ease || interp;
    if (mode === 'hold') return a;
    const span = b.t - a.t;
    const raw = span <= 1e-6 ? 1 : clamp01((t - a.t) / span);
    const k = mode === 'linear' ? raw : smooth(raw);
    return {
      t,
      at: (a.at && b.at) ? lerp3(a.at, b.at, k) : (b.at || a.at || null),
      rot: (a.rot && b.rot) ? lerp3(a.rot, b.rot, k) : (b.rot || a.rot || null),
      pose: b.pose || a.pose || '',
      target: (a.target && b.target) ? lerp3(a.target, b.target, k) : (b.target || a.target || null),
      fov: (a.fov != null && b.fov != null) ? lerp(a.fov, b.fov, k) : (b.fov != null ? b.fov : (a.fov != null ? a.fov : null)),
      energy: (a.energy != null && b.energy != null) ? lerp(a.energy, b.energy, k)
        : (b.energy != null ? b.energy : (a.energy != null ? a.energy : null)),
      /* 颜色不做插值：两帧之间换色直接跳到后一帧那一档（灯色是离散的意图） */
      color: b.color || a.color || '',
      scale: (a.scale && b.scale) ? lerp3(a.scale, b.scale, k) : (b.scale || a.scale || null),
      /* 显隐是 STEP：两帧之间保持前一帧的状态，到后一帧才切 */
      visible: a.visible != null ? a.visible : (b.visible != null ? b.visible : null),
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
  const u = easeU(t / d, path.ease);
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
/* 一条轨道在 t 时刻的结果（t 是整条时间轴的秒；轨道自己的 offset / speed / duration
   在 trackClock 里折算成局部时间）。
   节点：{ at, rot, pose, motion, joint, scale, visible }
   机位：{ at, target, fov, heading }
   缺的项是 null（调用方就别动它）。 */
export function sampleTrack(track, t, duration) {
  if (!track || track.enabled === false) return null;
  const of = track.of;
  if (!of) return null;
  const clock = trackClock(track, t, duration);
  if (!clock) return null;
  const { lt, dur } = clock;
  if (of.kind === 'cam') {
    const out = { at: null, target: null, fov: null, heading: null };
    const p = track.path ? samplePath(track.path, lt, dur) : null;
    if (p) { out.at = p.at; out.heading = p.yawDeg; }
    const keys = track.keys || [];
    const hasTarget = keys.some(k => k.target);
    const hasFov = keys.some(k => k.fov != null);
    const k = sampleKeys(keys, lt, track.interp);
    if (k) {
      if (k.at) out.at = (track.keysMode === 'offset' && track.path && out.at) ? add3(out.at, k.at) : k.at;
      if (hasTarget && k.target) out.target = (track.keysMode === 'offset' && track.path && out.target) ? add3(out.target, k.target) : k.target;
      if (hasFov && k.fov != null) out.fov = k.fov;
    }
    return out;
  }
  if (of.kind === 'light') {
    /* 灯：位置可以走路径，朝向 / 顶点的目标与能量由关键帧覆盖；颜色不插值 */
    const out = { at: null, target: null, energy: null, color: '' };
    const p = track.path ? samplePath(track.path, lt, dur) : null;
    if (p) out.at = p.at;
    const k = sampleKeys(track.keys || [], lt, track.interp);
    if (k) {
      if (k.at) out.at = k.at;
      if (k.target) out.target = k.target;
      if (k.energy != null) out.energy = k.energy;
      if (k.color) out.color = k.color;
    }
    return out;
  }

  const joint = jointPathOf(track.joint);
  const out = {
    at: null, rot: null, pose: '', motion: joint ? '' : (track.motion || ''), joint,
    scale: null, visible: null,
  };
  if (!joint) {
    const p = track.path ? samplePath(track.path, lt, dur) : null;
    if (p) {
      out.at = p.at;
      out.rot = [0, p.yawDeg, 0];
    }
  }
  const keys = track.keys || [];
  const k = sampleKeys(keys, lt, track.interp);
  if (track.keysMode === 'offset' && track.path && k) {
    /* 叠加模式：路径给位移，关键帧只给「相对路径的偏移」 */
    if (k.at) out.at = add3(out.at || [0, 0, 0], k.at);
    if (k.rot) out.rot = add3(out.rot || [0, 0, 0], k.rot);
    if (!joint && k.pose) out.pose = k.pose;
    if (k.scale) out.scale = k.scale;
    if (k.visible != null) out.visible = k.visible;
    return out;
  }
  /* 有路径时，第一帧之前按路径走（人还在路上），第一帧之后关键帧接管。
      纯关键帧轨道没有这个问题：第一帧之前保持第一帧，就是「还没开演」的样子。 */
  const useKeys = k && (!track.path || !keys.length || lt >= keys[0].t);
  if (useKeys) {
    if (k.at) out.at = k.at;
    if (k.rot) out.rot = k.rot;
    if (!joint && k.pose) out.pose = k.pose;
    if (k.scale) out.scale = k.scale;
    if (k.visible != null) out.visible = k.visible;
  }
  return out;
}

/* 整份动画在 t 时刻的「按节点 id 索引的位姿表」；页面每帧只查一次表。
   同一个节点可以挂多条轨道（节点自身一条 + 若干子关节轨道），关节轨道并进 `joints` 数组。
   `doc` 可选：节点轨道带 `follow` 时要读被跟随节点的静态位置（没给就查不到 follow）。 */
export function sampleAnim(anim, t, doc) {
  const map = {};
  if (!anim || !Array.isArray(anim.tracks)) return map;
  const duration = Math.max(0.001, Number(anim.duration) || 1);
  const solo = soloTaken(anim.tracks);
  const baseAtOf = id => {
    const s = map[id];
    if (s && s.at) return s.at;
    const n = doc ? findNode(doc.scene.nodes, id) : null;
    return n ? n.at : null;
  };
  for (const tr of anim.tracks) {
    if (!tr || !tr.of || tr.of.kind !== 'node') continue;
    if (tr.enabled === false) continue;
    if (solo && !tr.solo) continue;
    const s = sampleTrack(tr, Math.max(0, Number(t) || 0), duration);
    if (!s) continue;
    const entry = map[tr.of.id]
      || (map[tr.of.id] = { at: null, rot: null, pose: '', motion: '', scale: null, visible: null, joints: [] });
    if (s.joint) {
      if (s.at || s.rot) entry.joints.push({ joint: s.joint, at: s.at, rot: s.rot });
      continue;
    }
    if (tr.follow) {
      const base = baseAtOf(tr.follow);
      if (base) s.at = add3(s.at || [0, 0, 0], base);
    }
    if (s.at) entry.at = s.at;
    if (s.rot) entry.rot = s.rot;
    if (s.pose) entry.pose = s.pose;
    if (s.motion) entry.motion = s.motion;
    if (s.scale) entry.scale = s.scale;
    if (s.visible != null) entry.visible = s.visible;
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
  const solo = soloTaken(tracks);
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
      if (solo && !tr.solo) continue;
      if ((tr.keys || []).some(k => k.target)) hasTargetKey = true;
      if (tr.path && (tr.path.look === 'heading' || tr.path.look === 'target')) hasTargetKey = true;
      const s = sampleTrack(tr, Math.max(0, Number(t) || 0), duration);
      if (!s) continue;
      if (s.at) out.at = s.at;
      if (s.target) out.target = s.target;
      if (s.fov != null) out.fov = s.fov;
      /* 沿路径走时的朝向：heading = 沿切线；target = 一直看着 lookAt 那个节点 */
      const look = tr.path && tr.path.look;
      if (look === 'heading' && s.at && s.heading != null) {
        const rad = s.heading * D2R;
        out.target = [s.at[0] + Math.sin(rad) * 1.5, s.at[1], s.at[2] + Math.cos(rad) * 1.5];
      } else if (look === 'target' && tr.path.lookAt) {
        const tgt = atOf(tr.path.lookAt);
        if (tgt) out.target = tgt;
      }
      /* 三分法：把主体从正中挪到偏右三分之一；center / keep 不偏（keep 的原位基线留待后续） */
      const framing = tr.path && tr.path.framing;
      if (framing === 'rule3' && s.at && out.target) {
        const fx = out.target[0] - s.at[0], fy = out.target[1] - s.at[1], fz = out.target[2] - s.at[2];
        const depth = Math.hypot(fx, fy, fz);
        if (depth > 1e-6) {
          /* 屏幕右向 = forward × 上 */
          let rx = -fz, rz = fx;
          const rl = Math.hypot(rx, rz);
          if (rl > 1e-6) {
            rx /= rl; rz /= rl;
            const fov = Math.min(179, Math.max(1, out.fov || 35)) * D2R;
            const shift = depth * Math.tan(fov / 2) * aspectOf(doc.scene.view && doc.scene.view.aspect) / 3;
            out.target = [out.target[0] - rx * shift, out.target[1], out.target[2] - rz * shift];
          }
        }
      }
    }
    if (!hasTargetKey && cam.follow) {
      const followAt = atOf(cam.follow);
      if (followAt) out.target = followAt;
    }
    map[cam.id] = out;
  }
  return map;
}

/* 灯在 t 时刻的采样表；与 sampleCams 对称。
   轨道键里的 at / target / energy / color 覆盖静态值；`follow` 只在没有 target 关键帧时生效。 */
export function sampleLights(anim, doc, t, nodeSamples) {
  const map = {};
  const lights = (doc && doc.scene && doc.scene.lights) || [];
  const tracks = (anim && Array.isArray(anim.tracks)) ? anim.tracks : [];
  const duration = Math.max(0.001, Number(anim && anim.duration) || 1);
  const solo = soloTaken(tracks);
  const atOf = id => {
    const s = nodeSamples && nodeSamples[id];
    if (s && s.at) return s.at;
    const n = doc ? findNode(doc.scene.nodes, id) : null;
    return n ? n.at : null;
  };
  for (const light of lights) {
    const out = { at: light.at, target: light.target || null, energy: light.energy, color: light.color };
    let hasTargetKey = false;
    for (const tr of tracks) {
      if (!tr || tr.enabled === false || !tr.of || tr.of.kind !== 'light' || tr.of.id !== light.id) continue;
      if (solo && !tr.solo) continue;
      if ((tr.keys || []).some(k => k.target)) hasTargetKey = true;
      const s = sampleTrack(tr, Math.max(0, Number(t) || 0), duration);
      if (!s) continue;
      if (s.at) out.at = s.at;
      if (s.target) out.target = s.target;
      if (s.energy != null) out.energy = s.energy;
      if (s.color) out.color = s.color;
    }
    if (!hasTargetKey && light.follow) {
      const followAt = atOf(light.follow);
      if (followAt) out.target = followAt;
    }
    map[light.id] = out;
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
