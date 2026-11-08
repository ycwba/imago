/* 白膜模型文件（`白膜/<组>/<名>.json`，v2）的唯一形状定义与校验。
   纯函数：不碰 DOM、不碰 three、不碰网络 —— 判据（tests/model3d-*.mjs）直接 import 这一份。

   一条硬约定：**校验只丢坏节点，不整棵失败**。AI 写的树里出现一个 `shape:"box"` 却没给
   `size` 的零件时，正确的行为是把那一个零件丢掉并记一笔（界面上照实报「丢了 3 个零件」），
   而不是让整次生成白跑 —— 用户要的是能看见的模型，不是一份完美的 JSON。

   另一条硬约定：**不设人为数量 / 规模上限**。节点、children、机位、轨道、关键帧、环、
   轮廓点、多边形点、群众人数、骨骼数、出片条目全部照收；只保留「数字必须是有限数、
   尺寸必须大于 0、fov 必须在 0~180 之间、路径不能越出库根、引用不能成环」这类
   数学与文件系统本身的约束。

   坐标与单位：米。Y 向上，模型朝 +Z（与 three 的默认一致，参考项目也是这一套）。 */

export const MODEL_V = 3;
export const KINDS = ['group', 'prim', 'mannequin', 'crowd', 'asset', 'ref'];
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'plate', 'loft', 'lathe', 'extrude'];
export const TONES = ['hi', 'mid', 'lo'];
export const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];
export const CLIP_LOOPS = ['loop', 'once', 'hold'];
export const TRACK_INTERPS = ['smooth', 'linear', 'hold'];
export const PATH_KINDS = ['line', 'circle', 'rect', 'free'];

export const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const round3 = v => Math.round(num(v) * 1000) / 1000;
const positive = (v, d) => { const n = num(v, d); return n > 0 ? n : d; };
const nonNeg = (v, d = 0) => { const n = num(v, d); return n >= 0 ? n : d; };
const intAtLeast = (v, min, d) => Math.max(min, Math.round(num(v, d)));

/* 只清洗控制字符与首尾空白，不按显示长度截断。 */
const cleanText = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
const cleanLine = v => cleanText(v).replace(/\s+/g, ' ');
/* 颜色只收 `#rgb` / `#rrggbb`；写错就当没写（白模灰阶）。 */
const cleanColor = v => {
  const s = cleanLine(v).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return '';
};

/* 子关节路径的唯一解析口：按 `/` 切段、去掉空白与空段。
   rig.js 直接复用这两枚，别处不再各写一份 split('/')。不截断层数。 */
export function jointParts(raw) {
  return String(raw == null ? '' : raw).split('/').map(s => s.trim()).filter(Boolean);
}
export function jointPathOf(raw) {
  return jointParts(raw).join('/');
}

export function vec3(v, d) {
  const a = Array.isArray(v) ? v : null;
  if (!a) return d.slice();
  return [round3(num(a[0], d[0])), round3(num(a[1], d[1])), round3(num(a[2], d[2]))];
}
/* 缩放既接受一个数也接受三元组；0 会被换成 1（0 缩放的节点在 three 里等于消失，
   且不可再选中）。负数保留：负数缩放是镜像的一种写法。 */
export function scaleOf(v) {
  const scaleOne = x => { const n = round3(num(x, 1)); return n === 0 ? 1 : n; };
  if (Array.isArray(v)) return v.map(scaleOne);
  const n = scaleOne(v);
  return [n, n, n];
}

export function defaultCamera(id = 'cam-1', name = '机位 1') {
  return { id, name, pos: [3.2, 2.1, 4.2], target: [0, 1, 0], fov: 35, follow: '' };
}
export function defaultView() {
  return { mode: 'director', aspect: '16:9', grid: true, ground: true, outline: true };
}
export function defaultAnim() {
  return { duration: 4, fps: 24, loop: true, tracks: [] };
}

let seq = 1;
export function newId(prefix = 'n') {
  seq += 1;
  return prefix + '-' + Date.now().toString(36) + '-' + seq.toString(36);
}

export function emptyDoc(name = '未命名白膜', group = '') {
  const cam = defaultCamera();
  return {
    v: MODEL_V, kind: 'model', name: cleanLine(name) || '未命名白膜', group: cleanLine(group), note: '', ts: Date.now(),
    scene: {
      nodes: [],
      cams: [cam],
      active: cam.id,
      panorama: { src: '', yaw: 0, radius: 20 },
      view: defaultView(),
    },
    anim: defaultAnim(),
    out: [],
    src: { prompt: '', reuse: null },
  };
}
export function emptyScene(name = '未命名场景', group = '') {
  const doc = emptyDoc(name, group);
  doc.kind = 'scene';
  doc.name = cleanLine(name) || '未命名场景';
  return doc;
}

/* ---------- 节点 ---------- */

/* 归一化一个节点自身的字段；children 由 normalizeNodes 用显式栈处理。 */
function normalizeNodeFields(raw, dropped) {
  if (!raw || typeof raw !== 'object') { dropped.bad += 1; return null; }
  const kind = KINDS.indexOf(raw.kind) >= 0 ? raw.kind : (raw.shape ? 'prim' : '');
  if (!kind) { dropped.bad += 1; return null; }
  const node = { kind, id: cleanLine(raw.id) || newId(kind === 'mannequin' ? 'm' : kind === 'crowd' ? 'c' : 'n') };
  if (raw.name != null && cleanLine(raw.name)) node.name = cleanLine(raw.name);
  if (raw.fromModel != null) node.fromModel = cleanLine(raw.fromModel);
  node.at = vec3(raw.at, [0, 0, 0]);
  node.rot = vec3(raw.rot, [0, 0, 0]);
  node.scale = scaleOf(raw.scale);
  if (raw.visible === false) node.visible = false;
  if (raw.locked === true) node.locked = true;
  if (raw.color != null) {
    const c = cleanColor(raw.color);
    if (c) node.color = c;
  }

  if (kind === 'prim') {
    const shape = SHAPES.indexOf(raw.shape) >= 0 ? raw.shape : '';
    if (!shape) { dropped.bad += 1; return null; }
    node.shape = shape;
    node.tone = TONES.indexOf(raw.tone) >= 0 ? raw.tone : 'hi';
    if (shape === 'box' || shape === 'plate') {
      node.size = vec3(raw.size, [1, 1, 1]).map(x => Math.abs(x) || 1);
    }
    if (shape === 'sphere') node.r = positive(raw.r, 0.5);
    if (shape === 'cylinder' || shape === 'cone' || shape === 'capsule') {
      node.r = positive(raw.r, 0.3);
      node.h = positive(raw.h, 1);
      if (shape === 'cylinder') node.r2 = positive(raw.r2, node.r);
    }
    if (shape === 'torus') {
      node.r = positive(raw.r, 0.4);
      node.r2 = positive(raw.r2, 0.12);
    }
    if (shape === 'loft') {
      const rings = Array.isArray(raw.rings) ? raw.rings : [];
      node.rings = rings.map(rr => ({
        y: round3(num(rr && rr.y, 0)),
        rx: positive(rr && (rr.rx != null ? rr.rx : rr.r), 0.001),
        rz: positive(rr && (rr.rz != null ? rr.rz : rr.r), 0.001),
        cx: round3(num(rr && rr.cx, 0)),
        cz: round3(num(rr && rr.cz, 0)),
      }));
      if (node.rings.length < 2) { dropped.bad += 1; return null; }
      node.seg = intAtLeast(raw.seg, 3, 20);
    }
    if (shape === 'lathe') {
      const prof = Array.isArray(raw.profile) ? raw.profile : [];
      node.profile = prof.map(p => [nonNeg(p && p[0], 0.001), round3(num(p && p[1], 0))]);
      if (node.profile.length < 2) { dropped.bad += 1; return null; }
      node.seg = intAtLeast(raw.seg, 3, 24);
    }
    if (shape === 'extrude') {
      const poly = Array.isArray(raw.poly) ? raw.poly : [];
      node.poly = poly.map(p => [round3(num(p && p[0], 0)), round3(num(p && p[1], 0))]);
      if (node.poly.length < 3) { dropped.bad += 1; return null; }
      node.depth = positive(raw.depth, 0.2);
    }
    if (raw.seg != null) node.seg = intAtLeast(raw.seg, 3, 3);
    if (raw.mirror === true) node.mirror = true;
    if (raw.repeat && typeof raw.repeat === 'object') {
      const n = intAtLeast(raw.repeat.n, 1, 1);
      if (n > 1) node.repeat = { n, dx: round3(num(raw.repeat.dx, 0)), dy: round3(num(raw.repeat.dy, 0)), dz: round3(num(raw.repeat.dz, 0)) };
    }
  }

  if (kind === 'mannequin') {
    node.body = cleanLine(raw.body) || 'mannequin';
    node.pose = cleanLine(raw.pose) || 'stand';
    if (raw.controls && typeof raw.controls === 'object') {
      const c = {};
      for (const k of Object.keys(raw.controls)) {
        const v = Number(raw.controls[k]);
        if (Number.isFinite(v)) c[String(k)] = round3(v);
      }
      node.controls = c;
    }
    node.tone = TONES.indexOf(raw.tone) >= 0 ? raw.tone : 'hi';
  }

  if (kind === 'crowd') {
    node.body = cleanLine(raw.body) || 'mannequin';
    node.pose = cleanLine(raw.pose) || 'stand';
    node.rows = intAtLeast(raw.rows, 1, 3);
    node.cols = intAtLeast(raw.cols, 1, 3);
    node.gapX = nonNeg(raw.gapX, 0.9);
    node.gapZ = nonNeg(raw.gapZ, 0.9);
    node.jitter = nonNeg(raw.jitter, 0);
    node.tone = TONES.indexOf(raw.tone) >= 0 ? raw.tone : 'mid';
  }

  if (kind === 'asset') {
    node.file = cleanText(raw.file);
    if (!/^_模型文件\//.test(node.file) || node.file.includes('..')) { dropped.bad += 1; return null; }
    if (raw.lib != null && cleanLine(raw.lib)) node.lib = cleanLine(raw.lib);
    node.clay = raw.clay !== false;
    node.clip = cleanLine(raw.clip);
    node.clipSpeed = positive(raw.clipSpeed, 1);
    node.clipLoop = CLIP_LOOPS.indexOf(raw.clipLoop) >= 0 ? raw.clipLoop : 'loop';
    node.clipOffset = round3(num(raw.clipOffset, 0));
  }

  if (kind === 'ref') {
    node.model = cleanLine(raw.model);
    if (!node.model) { dropped.bad += 1; return null; }
  }

  return node;
}

/* 显式栈遍历：删掉深度上限之后，深树不再依赖 JS 调用栈。 */
function normalizeNodes(rawNodes, dropped) {
  const out = [];
  const ids = new Set();
  const seen = new WeakSet();
  const stack = [{ raw: rawNodes, out, i: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.raw.length) { stack.pop(); continue; }
    const raw = frame.raw[frame.i++];
    if (raw && typeof raw === 'object') {
      if (seen.has(raw)) { dropped.bad += 1; continue; }
      seen.add(raw);
    }
    const node = normalizeNodeFields(raw, dropped);
    if (!node) continue;
    if (ids.has(node.id)) {
      let n = 2;
      while (ids.has(node.id + '-' + n)) n += 1;
      node.id = node.id + '-' + n;
    }
    ids.add(node.id);
    frame.out.push(node);
    if (Array.isArray(raw.children) && raw.children.length) {
      node.children = [];
      stack.push({ raw: raw.children, out: node.children, i: 0 });
    }
  }
  return out;
}

/* ---------- 机位 ---------- */

function normalizeCams(rawCams, legacyCam, dropped) {
  let list = Array.isArray(rawCams) ? rawCams : [];
  if (!list.length && legacyCam && typeof legacyCam === 'object') list = [legacyCam];
  if (!list.length) list = [defaultCamera()];
  const out = [];
  const ids = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { dropped.cam += 1; continue; }
    let id = cleanLine(raw.id) || 'cam-' + (out.length + 1);
    if (ids.has(id)) id = id + '-' + (out.length + 1);
    ids.add(id);
    const fov = num(raw.fov, 35);
    out.push({
      id,
      name: cleanLine(raw.name) || ('机位 ' + (out.length + 1)),
      pos: vec3(raw.pos, defaultCamera().pos),
      target: vec3(raw.target, defaultCamera().target),
      fov: fov > 0 && fov < 180 ? round3(fov) : 35,
      follow: cleanLine(raw.follow),
    });
  }
  if (!out.length) out.push(defaultCamera());
  return out;
}

/* ---------- 轨道 ---------- */

function normalizePath(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = PATH_KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'line';
  const path = {
    kind,
    from: vec3(raw.from, [0, 0, 0]),
    to: vec3(raw.to, [0, 0, 2]),
    radius: positive(raw.radius, 1.5),
    clockwise: raw.clockwise === true,
  };
  if (kind === 'free') {
    const pts = (Array.isArray(raw.pts) ? raw.pts : []).map(p => vec3(p, [0, 0, 0]));
    if (pts.length < 2) return null;
    path.pts = pts;
    path.closed = raw.closed === true;
  }
  return path;
}

function normalizeTracks(rawTracks, nodeIds, camIds, dropped) {
  const out = [];
  const ids = new Set();
  for (const tr of (Array.isArray(rawTracks) ? rawTracks : [])) {
    if (!tr || typeof tr !== 'object') { dropped.anim += 1; continue; }
    let of = null;
    if (tr.of && typeof tr.of === 'object') {
      of = { kind: tr.of.kind === 'cam' ? 'cam' : 'node', id: cleanLine(tr.of.id) };
    } else if (tr.nodeId != null) {
      of = { kind: 'node', id: cleanLine(tr.nodeId) };
    }
    if (!of || !of.id) { dropped.anim += 1; continue; }
    if (of.kind === 'cam' ? !camIds.has(of.id) : !nodeIds.has(of.id)) { dropped.anim += 1; continue; }

    const keys = [];
    for (const k of (Array.isArray(tr.keys) ? tr.keys : [])) {
      if (!k || typeof k !== 'object') continue;
      const t = round3(nonNeg(k.t, 0));
      const key = { t };
      if (k.at) key.at = vec3(k.at, [0, 0, 0]);
      if (k.rot) key.rot = vec3(k.rot, [0, 0, 0]);
      if (k.pose != null && cleanLine(k.pose)) key.pose = cleanLine(k.pose);
      if (k.target) key.target = vec3(k.target, [0, 0, 0]);
      if (k.fov != null) {
        const fov = num(k.fov, 0);
        if (fov > 0 && fov < 180) key.fov = round3(fov);
      }
      if (key.at || key.rot || key.pose || key.target || key.fov != null) keys.push(key);
    }
    keys.sort((a, b) => a.t - b.t);
    const path = normalizePath(tr.path);
    if (!keys.length && !path) { dropped.anim += 1; continue; }

    let id = cleanLine(tr.id) || newId('t');
    if (ids.has(id)) id = id + '-' + (out.length + 1);
    ids.add(id);
    out.push({
      id,
      of,
      enabled: tr.enabled !== false,
      color: Math.abs(Math.round(num(tr.color, 0))),
      interp: TRACK_INTERPS.indexOf(tr.interp) >= 0 ? tr.interp : 'smooth',
      motion: (tr.motion === 'walk' || tr.motion === 'run') ? tr.motion : '',
      joint: jointPathOf(tr.joint),
      path,
      keys,
    });
  }
  return out;
}

/* ---------- 文档 ---------- */

/* 一整个文档的归一化。返回 { doc, dropped } —— dropped 是给人看的计数，不是错误码。 */
export function normalizeDoc(raw) {
  const dropped = { bad: 0, extra: 0, crowd: 0, anim: 0, cam: 0, out: 0 };
  const base = emptyDoc();
  if (!raw || typeof raw !== 'object') return { doc: base, dropped };
  const doc = base;
  doc.kind = raw.kind === 'scene' ? 'scene' : 'model';
  doc.name = cleanLine(raw.name) || (doc.kind === 'scene' ? '未命名场景' : base.name);
  doc.group = cleanLine(raw.group);
  doc.note = cleanText(raw.note);
  doc.ts = num(raw.ts, Date.now());
  doc.v = MODEL_V;

  const scene = (raw.scene && typeof raw.scene === 'object') ? raw.scene : raw;
  doc.scene.nodes = normalizeNodes(Array.isArray(scene.nodes) ? scene.nodes : [], dropped);

  const nodeIds = new Set();
  walkNodes(doc.scene.nodes, n => { nodeIds.add(n.id); });

  doc.scene.cams = normalizeCams(scene.cams, scene.camera, dropped);
  const camIds = new Set(doc.scene.cams.map(c => c.id));
  for (const cam of doc.scene.cams) {
    if (cam.follow && !nodeIds.has(cam.follow)) cam.follow = '';
  }
  const active = cleanLine(scene.active);
  doc.scene.active = camIds.has(active) ? active : doc.scene.cams[0].id;

  const pan = (scene.panorama && typeof scene.panorama === 'object') ? scene.panorama : {};
  doc.scene.panorama = {
    src: cleanText(pan.src),
    yaw: round3(num(pan.yaw, 0)),
    radius: positive(pan.radius, 20),
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
  const duration = positive(anim.duration, 4);
  const fps = intAtLeast(anim.fps, 1, 24);
  doc.anim = {
    duration: duration > 0 ? duration : 4,
    fps,
    loop: anim.loop !== false,
    tracks: normalizeTracks(anim.tracks, nodeIds, camIds, dropped),
  };

  const out = [];
  for (const item of (Array.isArray(raw.out) ? raw.out : [])) {
    if (!item || typeof item !== 'object') { dropped.out += 1; continue; }
    out.push({
      id: cleanLine(item.id) || newId('o'),
      assetId: cleanLine(item.assetId),
      url: cleanText(item.url),
      type: item.type === 'video' ? 'video' : 'image',
      name: cleanLine(item.name),
      at: num(item.at, Date.now()),
      picked: item.picked !== false,
    });
  }
  doc.out = out;

  const src = (raw.src && typeof raw.src === 'object') ? raw.src : {};
  const reuse = (src.reuse && typeof src.reuse === 'object' && src.reuse.id) ? {
    id: cleanLine(src.reuse.id),
    mode: src.reuse.mode === 'as-is' ? 'as-is' : 'base',
    why: cleanLine(src.reuse.why),
  } : null;
  doc.src = { prompt: cleanText(src.prompt), reuse };
  return { doc, dropped };
}

/* ---------- 节点树的小工具（页面与 scene 共用） ---------- */

export function walkNodes(list, fn, parent = null) {
  const stack = [{ list: list || [], parent, i: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.list.length) { stack.pop(); continue; }
    const n = frame.list[frame.i++];
    if (!n || typeof n !== 'object') continue;
    fn(n, frame.parent);
    if (Array.isArray(n.children) && n.children.length) {
      stack.push({ list: n.children, parent: n, i: 0 });
    }
  }
}

export function findNode(list, id) {
  let hit = null;
  walkNodes(list, n => { if (!hit && n.id === id) hit = n; });
  return hit;
}

export function findEntry(list, id) {
  const stack = [{ list: list || [], parent: null }];
  while (stack.length) {
    const frame = stack.pop();
    for (let i = 0; i < frame.list.length; i++) {
      const node = frame.list[i];
      if (!node || typeof node !== 'object') continue;
      if (node.id === id) return { node, parent: frame.parent, list: frame.list, index: i };
      if (Array.isArray(node.children) && node.children.length) {
        stack.push({ list: node.children, parent: node });
      }
    }
  }
  return null;
}

export function removeNode(list, id) {
  const hit = findEntry(list, id);
  if (!hit) return false;
  hit.list.splice(hit.index, 1);
  return true;
}

export function countNodes(doc) {
  let n = 0;
  walkNodes(doc.scene.nodes, () => { n += 1; });
  return n;
}

export function camOf(doc, id) {
  return (doc && doc.scene && Array.isArray(doc.scene.cams))
    ? doc.scene.cams.find(c => c.id === id) || null : null;
}

export function trackEndOf(anim) {
  let end = 0;
  for (const tr of ((anim && anim.tracks) || [])) {
    if (tr.enabled === false) continue;
    const keys = Array.isArray(tr.keys) ? tr.keys : [];
    if (keys.length) end = Math.max(end, Number(keys[keys.length - 1].t) || 0);
  }
  return end;
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

/* ---------- AI ops ---------- */

function isDescendantOf(node, id) {
  if (!node) return false;
  const stack = [node];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (n.id === id) return true;
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return false;
}

function moveEntry(root, id, parentId, index) {
  const hit = findEntry(root, id);
  if (!hit) throw new Error('找不到节点：' + id);
  let parent = null;
  if (parentId != null && parentId !== '') {
    parent = findEntry(root, parentId);
    if (!parent) throw new Error('找不到父节点：' + parentId);
    if (isDescendantOf(hit.node, parentId)) throw new Error('不能把节点移进自己的子树');
  }
  hit.list.splice(hit.index, 1);
  const target = parent ? parent.node.children || (parent.node.children = []) : root;
  const at = Math.max(0, Math.min(target.length, Math.round(num(index, target.length))));
  target.splice(at, 0, hit.node);
}

export function applyDocOps(doc, ops, opts = {}) {
  const base = cloneDoc(doc);
  const errors = [];
  let applied = 0;
  let skipped = 0;
  const scope = opts && opts.scope instanceof Set ? opts.scope : null;
  const inScope = id => !scope || scope.has(String(id));
  const needScope = id => { if (!inScope(id)) throw new Error('op 越界：不在选中实体内（' + id + '）'); };
  const list = base && base.scene ? base.scene.nodes : [];
  const tryOp = fn => {
    try {
      fn();
      applied += 1;
    } catch (e) {
      skipped += 1;
      errors.push({ i: applied + skipped - 1, why: String(e) });
    }
  };

  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || typeof op !== 'object') {
      skipped += 1;
      errors.push({ i: applied + skipped - 1, why: 'op 不是对象' });
      continue;
    }
    const kind = String(op.op || '');
    if (kind === 'add') {
      tryOp(() => {
        if (scope && (op.parent == null || op.parent === '')) throw new Error('op 越界：选中实体编辑不能在根层新增');
        if (scope && op.parent != null && op.parent !== '') needScope(op.parent);
        const parent = op.parent != null && op.parent !== '' ? findEntry(list, op.parent) : null;
        if (op.parent != null && op.parent !== '' && !parent) throw new Error('找不到父节点：' + op.parent);
        const node = op.node;
        if (!node || typeof node !== 'object') throw new Error('add 缺少 node');
        const target = parent ? parent.node.children || (parent.node.children = []) : list;
        const at = Math.max(0, Math.min(target.length, Math.round(num(op.index, target.length))));
        target.splice(at, 0, node);
      });
    } else if (kind === 'remove') {
      tryOp(() => { needScope(op.id); if (!removeNode(list, String(op.id))) throw new Error('找不到节点：' + op.id); });
    } else if (kind === 'update') {
      tryOp(() => {
        needScope(op.id);
        const hit = findEntry(list, String(op.id));
        if (!hit) throw new Error('找不到节点：' + op.id);
        const set = op.set;
        if (!set || typeof set !== 'object') throw new Error('update 缺少 set');
        for (const k of Object.keys(set)) {
          if (k === 'id' || k === 'kind' || k === 'children') continue;
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          hit.node[k] = set[k];
        }
      });
    } else if (kind === 'move') {
      tryOp(() => {
        needScope(op.id);
        if (scope && op.parent != null && op.parent !== '') needScope(op.parent);
        moveEntry(list, String(op.id), op.parent == null ? null : String(op.parent), op.index);
      });
    } else if (kind === 'group') {
      tryOp(() => {
        const ids = Array.isArray(op.ids) ? op.ids.map(String) : [];
        if (!ids.length) throw new Error('group 缺少 ids');
        for (const id of ids) needScope(id);
        const hits = ids.map(id => {
          const hit = findEntry(list, id);
          if (!hit) throw new Error('找不到节点：' + id);
          return hit;
        });
        const parentList = hits[0].list;
        if (hits.some(h => h.list !== parentList)) throw new Error('这些节点不在同一层，不能直接编组');
        const at = Math.min(...hits.map(h => h.index));
        const children = hits.map(h => h.node);
        for (const h of hits.slice().sort((a, b) => b.index - a.index)) h.list.splice(h.index, 1);
        const group = {
          kind: 'group',
          id: cleanLine(op.id) || newId('g'),
          name: cleanLine(op.name) || '组',
          at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
          children,
        };
        parentList.splice(Math.min(at, parentList.length), 0, group);
      });
    } else if (kind === 'ungroup') {
      tryOp(() => {
        needScope(op.id);
        const hit = findEntry(list, String(op.id));
        if (!hit) throw new Error('找不到节点：' + op.id);
        if (hit.node.kind !== 'group') throw new Error('只能解组 group 节点');
        const kids = Array.isArray(hit.node.children) ? hit.node.children : [];
        hit.list.splice(hit.index, 1, ...kids);
      });
    } else if (kind === 'cam') {
      tryOp(() => {
        if (scope) throw new Error('选中实体编辑不能改机位');
        const cams = base.scene.cams || (base.scene.cams = []);
        if (op.remove === true) {
          if (cams.length <= 1) throw new Error('不能删最后一个机位');
          const i = cams.findIndex(c => c.id === String(op.id));
          if (i < 0) throw new Error('找不到机位：' + op.id);
          cams.splice(i, 1);
          if (base.scene.active === String(op.id)) base.scene.active = cams[0].id;
          return;
        }
        if (op.add && typeof op.add === 'object') {
          const cam = Object.assign({}, op.add);
          cam.id = cleanLine(cam.id) || newId('cam');
          cam.name = cleanLine(cam.name) || ('机位 ' + (cams.length + 1));
          cams.push(cam);
          if (!base.scene.active) base.scene.active = cam.id;
          return;
        }
        const cam = cams.find(c => c.id === String(op.id));
        if (!cam) throw new Error('找不到机位：' + op.id);
        if (op.set && typeof op.set === 'object') {
          for (const k of Object.keys(op.set)) {
            if (k === 'id' || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            cam[k] = op.set[k];
          }
        }
      });
    } else if (kind === 'track') {
      tryOp(() => {
        const tracks = base.anim.tracks || (base.anim.tracks = []);
        const needTrackScope = tr => {
          if (!scope) return;
          if (!tr || !tr.of || tr.of.kind !== 'node') throw new Error('op 越界：选中实体编辑不能改机位轨道');
          needScope(tr.of.id);
        };
        if (op.remove === true) {
          const i = tracks.findIndex(t => t.id === String(op.id));
          if (i < 0) throw new Error('找不到轨道：' + op.id);
          needTrackScope(tracks[i]);
          tracks.splice(i, 1);
          return;
        }
        if (op.add && typeof op.add === 'object') {
          const tr = Object.assign({}, op.add);
          needTrackScope(tr);
          tr.id = cleanLine(tr.id) || newId('t');
          tracks.push(tr);
          return;
        }
        const tr = tracks.find(t => t.id === String(op.id));
        if (!tr) throw new Error('找不到轨道：' + op.id);
        needTrackScope(tr);
        if (op.set && typeof op.set === 'object') {
          for (const k of Object.keys(op.set)) {
            if (k === 'id' || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            tr[k] = op.set[k];
          }
        }
      });
    } else if (kind === 'anim') {
      tryOp(() => {
        if (!op.set || typeof op.set !== 'object') throw new Error('anim 缺少 set');
        for (const k of Object.keys(op.set)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          base.anim[k] = op.set[k];
        }
      });
    } else {
      skipped += 1;
      errors.push({ i: applied + skipped - 1, why: '不认识的 op：' + kind });
    }
  }

  const out = normalizeDoc(base);
  return { doc: out.doc, dropped: out.dropped, applied, skipped, errors };
}
