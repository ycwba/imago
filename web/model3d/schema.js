/* 白膜模型文件（`白膜/<组>/<名>.json`，v1）的唯一形状定义与校验。
   纯函数：不碰 DOM、不碰 three、不碰网络 —— 判据（tests/model3d-*.mjs）直接 import 这一份。

   一条硬约定：**校验只丢坏节点，不整棵失败**。AI 写的树里出现一个 `shape:"box"` 却没给
   `size` 的零件时，正确的行为是把那一个零件丢掉并记一笔（界面上照实报「丢了 3 个零件」），
   而不是让整次生成白跑 —— 用户要的是能看见的模型，不是一份完美的 JSON。

   坐标与单位：米。Y 向上，模型朝 +Z（与 three 的默认一致，参考项目也是这一套）。 */

export const MODEL_V = 1;
export const LIMITS = {
  nodes: 400,          // 整棵树的节点上限（含嵌套）
  depth: 8,            // 一条链上最多几层（含最外层）
  children: 64,        // 单个节点的子节点数
  tris: 60000,         // 三角形预算（scene.js 累加后超了停建并报数）
  nodesFromAi: 200,    // AI 一次生成建议别超过这个数（超出只告警，不拒）
  riggedAssets: 16,    // 同时播 clip 的导入件上限（第 17 个降级为静态并记一笔）
};

export const KINDS = ['group', 'prim', 'mannequin', 'crowd', 'asset', 'ref'];
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'plate', 'loft', 'lathe', 'extrude'];
export const TONES = ['hi', 'mid', 'lo'];
export const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];
export const CLIP_LOOPS = ['loop', 'once', 'hold'];

export const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const round3 = v => Math.round(num(v) * 1000) / 1000;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/* 子关节路径的唯一解析口：按 `/` 切段、去掉空白与空段。超过 6 段视为坏路径（防环），
   rig.js 直接复用这两枚，别处不再各写一份 split('/')。 */
export const JOINT_DEPTH = 6;
export function jointParts(raw) {
  return String(raw == null ? '' : raw).split('/').map(s => s.trim()).filter(Boolean);
}
export function jointPathOf(raw) {
  return jointParts(raw).slice(0, JOINT_DEPTH).join('/');
}

export function vec3(v, d) {
  const a = Array.isArray(v) ? v : null;
  if (!a) return d.slice();
  return [round3(clamp(num(a[0], d[0]), -1e4, 1e4)), round3(clamp(num(a[1], d[1]), -1e4, 1e4)), round3(clamp(num(a[2], d[2]), -1e4, 1e4))];
}
/* 缩放既接受一个数也接受三元组；0 会被夹到 0.01（0 缩放的节点在 three 里等于消失，且不可再选中）。 */
export function scaleOf(v) {
  if (Array.isArray(v)) return v.map(x => clamp(num(x, 1), 0.01, 100)).map(round3);
  return [clamp(num(v, 1), 0.01, 100), clamp(num(v, 1), 0.01, 100), clamp(num(v, 1), 0.01, 100)].map(round3);
}

export function defaultCamera() {
  return { pos: [3.2, 2.1, 4.2], target: [0, 1, 0], fov: 35 };
}
export function defaultView() {
  return { mode: 'director', aspect: '16:9', grid: true, ground: true, outline: true };
}
export function defaultAnim() {
  return { duration: 4, fps: 24, tracks: [] };
}

let seq = 1;
export function newId(prefix = 'n') {
  seq += 1;
  return prefix + '-' + Date.now().toString(36) + '-' + seq.toString(36);
}

export function emptyDoc(name = '未命名白膜', group = '') {
  return {
    v: MODEL_V, name: str(name, 40) || '未命名白膜', group: str(group, 20), note: '', ts: Date.now(),
    scene: { nodes: [], camera: defaultCamera(), panorama: { src: '', yaw: 0, radius: 20 }, view: defaultView() },
    anim: defaultAnim(),
    src: { prompt: '', reuse: null },
  };
}

/* 节点的归一化：只认白名单字段，数值全部夹取。坏节点返回 null（调用方计数后丢掉）。 */
function normalizeNode(raw, depth, dropped) {
  if (!raw || typeof raw !== 'object') { dropped.bad += 1; return null; }
  const kind = KINDS.indexOf(raw.kind) >= 0 ? raw.kind : (raw.shape ? 'prim' : '');
  if (!kind) { dropped.bad += 1; return null; }
  const node = { kind, id: str(raw.id, 40) || newId(kind === 'mannequin' ? 'm' : kind === 'crowd' ? 'c' : 'n') };
  if (raw.name) node.name = str(raw.name, 24);
  node.at = vec3(raw.at, [0, 0, 0]);
  node.rot = vec3(raw.rot, [0, 0, 0]);
  node.scale = scaleOf(raw.scale);
  if (raw.visible === false) node.visible = false;
  if (raw.locked === true) node.locked = true;

  if (kind === 'prim') {
    const shape = SHAPES.indexOf(raw.shape) >= 0 ? raw.shape : '';
    if (!shape) { dropped.bad += 1; return null; }
    node.shape = shape;
    node.tone = TONES.indexOf(raw.tone) >= 0 ? raw.tone : 'hi';
    if (shape === 'box' || shape === 'plate') node.size = vec3(raw.size, [1, 1, 1]).map(x => clamp(Math.abs(x) || 1, 0.001, 200));
    if (shape === 'sphere') node.r = clamp(num(raw.r, 0.5), 0.001, 200);
    if (shape === 'cylinder' || shape === 'cone' || shape === 'capsule') {
      node.r = clamp(num(raw.r, 0.3), 0.001, 200);
      node.h = clamp(num(raw.h, 1), 0.001, 200);
      if (shape === 'cylinder') node.r2 = clamp(num(raw.r2, node.r), 0.0001, 200);
    }
    if (shape === 'torus') { node.r = clamp(num(raw.r, 0.4), 0.01, 200); node.r2 = clamp(num(raw.r2, 0.12), 0.001, 100); }
    if (shape === 'loft') {
      const rings = Array.isArray(raw.rings) ? raw.rings.slice(0, 24) : [];
      node.rings = rings.map(rr => ({
        y: round3(clamp(num(rr && rr.y, 0), -50, 50)),
        rx: clamp(num(rr && (rr.rx != null ? rr.rx : rr.r), 0.001), 0.0005, 50),
        rz: clamp(num(rr && (rr.rz != null ? rr.rz : rr.r), 0.001), 0.0005, 50),
        cx: round3(clamp(num(rr && rr.cx, 0), -50, 50)),
        cz: round3(clamp(num(rr && rr.cz, 0), -50, 50)),
      }));
      if (node.rings.length < 2) { dropped.bad += 1; return null; }
      node.seg = clamp(Math.round(num(raw.seg, 20)), 6, 48);
    }
    if (shape === 'lathe') {
      const prof = Array.isArray(raw.profile) ? raw.profile.slice(0, 32) : [];
      node.profile = prof.map(p => [clamp(num(p && p[0], 0.001), 0, 50), round3(clamp(num(p && p[1], 0), -50, 50))]);
      if (node.profile.length < 2) { dropped.bad += 1; return null; }
      node.seg = clamp(Math.round(num(raw.seg, 24)), 6, 64);
    }
    if (shape === 'extrude') {
      const poly = Array.isArray(raw.poly) ? raw.poly.slice(0, 64) : [];
      node.poly = poly.map(p => [round3(clamp(num(p && p[0], 0), -50, 50)), round3(clamp(num(p && p[1], 0), -50, 50))]);
      if (node.poly.length < 3) { dropped.bad += 1; return null; }
      node.depth = clamp(num(raw.depth, 0.2), 0.001, 50);
    }
    if (raw.mirror === true) node.mirror = true;          // 关于 X=0 镜像一份
    if (raw.repeat && typeof raw.repeat === 'object') {
      const n = clamp(Math.round(num(raw.repeat.n, 1)), 1, 40);
      if (n > 1) node.repeat = { n, dx: round3(num(raw.repeat.dx, 0)), dy: round3(num(raw.repeat.dy, 0)), dz: round3(num(raw.repeat.dz, 0)) };
    }
  }

  if (kind === 'mannequin') {
    node.body = str(raw.body, 16) || 'mannequin';
    node.pose = str(raw.pose, 16) || 'stand';
    if (raw.controls && typeof raw.controls === 'object') {
      const c = {};
      for (const k of Object.keys(raw.controls).slice(0, 40)) {
        const v = Number(raw.controls[k]);
        if (Number.isFinite(v)) c[String(k).slice(0, 24)] = round3(clamp(v, -360, 360));
      }
      node.controls = c;
    }
    node.tone = TONES.indexOf(raw.tone) >= 0 ? raw.tone : 'hi';
  }

  if (kind === 'crowd') {
    node.body = str(raw.body, 16) || 'mannequin';
    node.pose = str(raw.pose, 16) || 'stand';
    node.rows = clamp(Math.round(num(raw.rows, 3)), 1, 24);
    node.cols = clamp(Math.round(num(raw.cols, 3)), 1, 24);
    node.gapX = clamp(num(raw.gapX, 0.9), 0.3, 6);
    node.gapZ = clamp(num(raw.gapZ, 0.9), 0.3, 6);
    node.jitter = clamp(num(raw.jitter, 0), 0, 2);
    node.tone = TONES.indexOf(raw.tone) >= 0 ? raw.tone : 'mid';
    if (node.rows * node.cols > 400) { node.cols = Math.max(1, Math.floor(400 / node.rows)); dropped.crowd += 1; }
  }

  if (kind === 'asset') {
    node.file = str(raw.file, 120);
    if (!/^_模型文件\//.test(node.file) || node.file.includes('..')) { dropped.bad += 1; return null; }
    node.clay = raw.clay !== false;
    /* 四格全可选：老文档没有它们，归一化后就是「静态摆件」，行为与加字段之前完全一致 */
    node.clip = str(raw.clip, 40);
    node.clipSpeed = round3(clamp(num(raw.clipSpeed, 1), 0.1, 4));
    node.clipLoop = CLIP_LOOPS.indexOf(raw.clipLoop) >= 0 ? raw.clipLoop : 'loop';
    node.clipOffset = round3(clamp(num(raw.clipOffset, 0), 0, 60));
  }

  if (kind === 'ref') {
    node.model = str(raw.model, 80);
    if (!node.model) { dropped.bad += 1; return null; }
  }

  const kids = Array.isArray(raw.children) ? raw.children.slice(0, LIMITS.children) : [];
  /* depth 从 0 数：`LIMITS.depth` 是「一层链上最多几个节点（含最外层）」，所以第 8 层之后不再收子节点 */
  if (kids.length && depth >= LIMITS.depth - 1) { dropped.bad += 1; }
  else if (kids.length) {
    node.children = kids.map(k => normalizeNode(k, depth + 1, dropped)).filter(Boolean);
  }
  return node;
}

/* 一整个文档的归一化。返回 { doc, dropped } —— dropped 是给人看的计数，不是错误码。 */
export function normalizeDoc(raw) {
  const dropped = { bad: 0, extra: 0, crowd: 0, anim: 0 };
  const base = emptyDoc();
  if (!raw || typeof raw !== 'object') return { doc: base, dropped };
  const doc = base;
  doc.name = str(raw.name, 40) || base.name;
  doc.group = str(raw.group, 20);
  doc.note = str(raw.note, 200);
  doc.ts = num(raw.ts, Date.now());
  doc.v = MODEL_V;

  const scene = (raw.scene && typeof raw.scene === 'object') ? raw.scene : raw;
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const out = [];
  for (const n of nodes) {
    if (out.length >= LIMITS.nodes) { dropped.extra += 1; continue; }
    const ok = normalizeNode(n, 0, dropped);
    if (ok) out.push(ok);
  }
  doc.scene.nodes = out;

  const cam = (scene.camera && typeof scene.camera === 'object') ? scene.camera : {};
  doc.scene.camera = {
    pos: vec3(cam.pos, defaultCamera().pos),
    target: vec3(cam.target, defaultCamera().target),
    fov: clamp(num(cam.fov, 35), 10, 120),
  };
  const pan = (scene.panorama && typeof scene.panorama === 'object') ? scene.panorama : {};
  doc.scene.panorama = {
    src: str(pan.src, 300),
    yaw: round3(clamp(num(pan.yaw, 0), -360, 360)),
    radius: clamp(num(pan.radius, 20), 5, 200),
  };
  const view = (scene.view && typeof scene.view === 'object') ? scene.view : {};
  doc.scene.view = {
    mode: view.mode === 'camera' ? 'camera' : 'director',
    aspect: ASPECTS.indexOf(view.aspect) >= 0 ? view.aspect : '16:9',
    grid: view.grid !== false,
    ground: view.ground !== false,
    outline: view.outline !== false,
  };

  const anim = (raw.anim && typeof raw.anim === 'object') ? raw.anim : {};
  doc.anim = {
    duration: clamp(num(anim.duration, 4), 0.5, 60),
    fps: clamp(Math.round(num(anim.fps, 24)), 12, 60),
    tracks: [],
  };
  const ids = new Set();
  const collect = (list) => { for (const n of list) { ids.add(n.id); if (n.children) collect(n.children); } };
  collect(doc.scene.nodes);
  for (const tr of (Array.isArray(anim.tracks) ? anim.tracks.slice(0, 60) : [])) {
    if (!tr || !ids.has(tr.nodeId)) { dropped.anim += 1; continue; }
    const jp = jointParts(tr.joint);
    if (jp.length > JOINT_DEPTH) { dropped.anim += 1; continue; }
    const keys = (Array.isArray(tr.keys) ? tr.keys : []).slice(0, 64).map(k => ({
      t: round3(clamp(num(k && k.t, 0), 0, doc.anim.duration)),
      at: k && k.at ? vec3(k.at, [0, 0, 0]) : null,
      rot: k && k.rot ? vec3(k.rot, [0, 0, 0]) : null,
      pose: k && k.pose ? str(k.pose, 16) : '',
    })).filter(k => k.at || k.rot || k.pose).sort((a, b) => a.t - b.t);
    const path = (tr.path && typeof tr.path === 'object') ? tr.path : null;
    if (!keys.length && !path) { dropped.anim += 1; continue; }
    doc.anim.tracks.push({
      id: str(tr.id, 40) || newId('t'),
      nodeId: String(tr.nodeId),
      joint: jp.join('/'),
      motion: (tr.motion === 'walk' || tr.motion === 'run') ? tr.motion : '',
      path: path ? {
        kind: ['line', 'circle', 'rect'].indexOf(path.kind) >= 0 ? path.kind : 'line',
        from: vec3(path.from, [0, 0, 0]),
        to: vec3(path.to, [0, 0, 2]),
        radius: clamp(num(path.radius, 1.5), 0.1, 30),
        clockwise: path.clockwise === true,
      } : null,
      keys,
    });
  }

  const src = (raw.src && typeof raw.src === 'object') ? raw.src : {};
  const reuse = (src.reuse && typeof src.reuse === 'object' && src.reuse.id) ? {
    id: str(src.reuse.id, 80),
    mode: src.reuse.mode === 'as-is' ? 'as-is' : 'base',
    why: str(src.reuse.why, 120),
  } : null;
  doc.src = { prompt: str(src.prompt, 2000), reuse };
  return { doc, dropped };
}

/* ---------------- 节点树的小工具（页面与 scene 共用） ---------------- */
export function walkNodes(list, fn, parent = null) {
  for (const n of list || []) {
    fn(n, parent);
    if (n.children) walkNodes(n.children, fn, n);
  }
}
export function findNode(list, id) {
  let hit = null;
  walkNodes(list, n => { if (!hit && n.id === id) hit = n; });
  return hit;
}
export function siblingsOf(list, id) {
  let hit = null;
  walkNodes(list, (n, parent) => { if (!hit && n.id === id) hit = { parent, list: parent ? parent.children : list }; });
  return hit;
}
export function removeNode(list, id) {
  const hit = siblingsOf(list, id);
  if (!hit) return false;
  const i = hit.list.indexOf(hit.list.find(n => n.id === id));
  if (i < 0) return false;
  hit.list.splice(i, 1);
  return true;
}
export function countNodes(doc) {
  let n = 0;
  walkNodes(doc.scene.nodes, () => { n += 1; });
  return n;
}
export function digest(doc) {
  return JSON.stringify(doc);
}
export function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}
/* 模型身份 = 「组/名」，与磁盘上的相对路径同形；页面上一切引用（复用、ref、缩略图）都用它。 */
export function docIdOf(doc) {
  return (doc.group ? doc.group + '/' : '') + doc.name;
}
