/* 白膜模型文件（`白膜/<库>/模型/<组>/<名>.json`）v3 的唯一形状定义与校验。
   纯函数：不碰 DOM、不碰 three、不碰网络 —— 判据（tests/model3d-*.mjs）直接 import 这一份。

   一条硬约定：**校验只丢坏节点，不整棵失败**。AI 写的树里出现一个 `shape:"box"` 却没给
   `size` 的零件时，正确的行为是把那一个零件丢掉并记一笔（界面上照实报「丢了 3 个零件」），
   而不是让整次生成白跑 —— 用户要的是能看见的模型，不是一份完美的 JSON。

   另一条硬约定：**不设人为数量 / 规模上限**。节点、children、机位、轨道、关键帧、环、
   轮廓点、多边形点、群众人数、骨骼数、出片条目全部照收；只保留「数字必须是有限数、
   尺寸必须大于 0、fov 必须在 0~180 之间、路径不能越出库根、引用不能成环」这类
   数学与文件系统本身的约束。

   坐标与单位：米。Y 向上，模型朝 +Z（与 three 的默认一致，参考项目也是这一套）。
   `fov` 是**竖直**视场角（three 的约定），不是水平角。
   `rot` 是**度制**，欧拉序为 three 的 Rx·Ry·Rz（'XYZ'，见 scene.js 的 e3）。
   `scale` 接受数组或单个数（单数 = 三轴同值）；0 会被换成 1（0 缩放等于消失且不可再选中），
   负数保留 —— 负缩放是镜像的一种写法。 */

export const MODEL_V = 3;
/* 磁盘上出现过的版本。v2 从未单独发布过（0.4.0 从 v1 直接写到 v3），那一行留着是为了
   让 `--from 2` 的迁移有据可查，也防止有人把「中间那一版」当成一份需要兼容的格式。 */
export const MODEL_VERSIONS = [
  { v: 1, changed: '初版：单机位（scene.camera）、轨道用 tr.nodeId 指节点' },
  { v: 2, changed: '未发布：没有单独落过盘，v1 直接升到了 v3' },
  { v: 3, changed: '多机位 scene.cams[] + active、灯光实体 scene.lights[] + 装置 scene.light、轨道 of:{kind,id} 统一驱动节点/机位/灯光、节点 fromModel / color、anim.loop' },
];
export const KINDS = ['group', 'prim', 'mannequin', 'crowd', 'asset', 'ref'];
export const LIGHT_SHAPES = ['sun', 'point', 'spot'];
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
/* 颜色只收 `#rgb` / `#rrggbb`；写错就当没写（白模灰阶）。
   轨道坞的逐帧颜色编辑也走这一份，判定只有一处。 */
export const cleanColor = v => {
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

/* ---------- 灯光 ---------- */

/* 默认灯装置 = 以前写死在 scene.js 的两盏平行光，参数逐字照抄：不带 `lights` 段的
   存量白膜读进来就是这两盏，出图与改动前一致。半球光 / 地面阴影 / 曝光是装置级，
   不可增删（它们没有位置，当实体摆没有意义）。 */
export function defaultLights() {
  const used = new Set();
  return [
    normalizeLight({
      id: 'l-key', name: '主光', shape: 'sun', at: [4.2, 7.5, 5.2], target: [0, 0, 0], energy: 2.1,
      color: '#ffffff', shadow: { on: true, mapSize: 2048, bias: -0.0005, normalBias: 0.02 },
    }, used, 0, emptyDropped()),
    normalizeLight({
      id: 'l-fill', name: '补光', shape: 'sun', at: [-5, 3.5, -4], target: [0, 0, 0], energy: 0.45,
      color: '#ffffff',
    }, used, 1, emptyDropped()),
  ];
}

export function defaultLightDev() {
  return {
    hemi: { sky: '#ffffff', ground: '#d9d4cc', energy: 1.35 },
    ground: { color: '#1a1a1a', opacity: 0.16 },
    exposure: 1,
  };
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
      lights: defaultLights(),
      light: defaultLightDev(),
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
  if (!raw || typeof raw !== 'object') { dropItem(dropped, 'bad', 'node', raw, '不是对象'); return null; }
  const kind = KINDS.indexOf(raw.kind) >= 0 ? raw.kind : (raw.shape ? 'prim' : '');
  if (!kind) {
    const k = cleanLine(raw.kind);
    dropItem(dropped, 'bad', 'node', raw, k ? 'kind「' + k + '」不认识，也没有 shape' : '缺 kind');
    return null;
  }
  const node = { kind, id: cleanLine(raw.id) || newId(kind === 'mannequin' ? 'm' : kind === 'crowd' ? 'c' : 'n') };
  if (raw.name != null && cleanLine(raw.name)) node.name = cleanLine(raw.name);
  if (raw.fromModel != null && cleanLine(raw.fromModel)) node.fromModel = cleanLine(raw.fromModel);
  node.at = vec3(raw.at, [0, 0, 0]);
  node.rot = vec3(raw.rot, [0, 0, 0]);
  node.scale = scaleOf(raw.scale);
  /* 通用阵列：任意节点都能摆成一个网格（crowd 用它自己那套行列字段，不叠两份）。
     第一格落在节点自己的 at 上；间距可负（允许重叠 / 反向排）；jitter 是确定性微差。 */
  if (kind !== 'crowd' && raw.array && typeof raw.array === 'object') {
    node.array = {
      rows: intAtLeast(raw.array.rows, 1, 1),
      cols: intAtLeast(raw.array.cols, 1, 1),
      gapX: round3(num(raw.array.gapX, 1)),
      gapZ: round3(num(raw.array.gapZ, 1)),
      jitter: nonNeg(raw.array.jitter, 0),
    };
  }
  if (raw.visible === false) node.visible = false;
  if (raw.locked === true) node.locked = true;
  if (raw.color != null) {
    const c = cleanColor(raw.color);
    if (c) node.color = c;
  }

  if (kind === 'prim') {
    const shape = SHAPES.indexOf(raw.shape) >= 0 ? raw.shape : '';
    if (!shape) {
      const s = cleanLine(raw.shape);
      dropItem(dropped, 'bad', 'node', raw, s ? '形状「' + s + '」不认识' : '缺 shape');
      return null;
    }
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
      const prof = Array.isArray(raw.profile) ? raw.profile : [];
      const sweepPath = normalizePath(raw.path);
      /* 沿路径扫掠：`path` + `profile`（半径沿路径走，`profile` 的第一列是半径、
         第二列是进度，按进度归一）。不写 path 时还是等高 rings 那一套，行为照旧。 */
      if (sweepPath && prof.length >= 2) {
        node.path = sweepPath;
        node.profile = prof.map(p => [nonNeg(p && p[0], 0.001), round3(num(p && p[1], 0))]);
      } else {
        node.rings = rings.map(rr => ({
          y: round3(num(rr && rr.y, 0)),
          rx: positive(rr && (rr.rx != null ? rr.rx : rr.r), 0.001),
          rz: positive(rr && (rr.rz != null ? rr.rz : rr.r), 0.001),
          cx: round3(num(rr && rr.cx, 0)),
          cz: round3(num(rr && rr.cz, 0)),
        }));
        if (node.rings.length < 2) {
          dropItem(dropped, 'bad', 'node', raw, '缺 rings，至少 2 环；沿路径扫掠要给 path + profile');
          return null;
        }
        /* 环间细分：写了就用 Catmull-Rom 按这个段数补；不写保持旧的 4 段平滑（像素不变） */
        if (raw.subdiv != null) node.subdiv = intAtLeast(raw.subdiv, 1, 4);
      }
      node.seg = intAtLeast(raw.seg, 3, 20);
    }
    if (shape === 'lathe') {
      const prof = Array.isArray(raw.profile) ? raw.profile : [];
      node.profile = prof.map(p => [nonNeg(p && p[0], 0.001), round3(num(p && p[1], 0))]);
      if (node.profile.length < 2) { dropItem(dropped, 'bad', 'node', raw, '缺 profile，至少 2 点'); return null; }
      node.seg = intAtLeast(raw.seg, 3, 24);
    }
    if (shape === 'extrude') {
      const poly = Array.isArray(raw.poly) ? raw.poly : [];
      node.poly = poly.map(p => [round3(num(p && p[0], 0)), round3(num(p && p[1], 0))]);
      if (node.poly.length < 3) { dropItem(dropped, 'bad', 'node', raw, '缺 poly，至少 3 点'); return null; }
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
    if (!/^_模型文件\//.test(node.file) || node.file.includes('..')) {
      dropItem(dropped, 'bad', 'node', raw, 'file 不在 _模型文件/ 下');
      return null;
    }
    if (raw.lib != null && cleanLine(raw.lib)) node.lib = cleanLine(raw.lib);
    node.clay = raw.clay !== false;
    node.clip = cleanLine(raw.clip);
    node.clipSpeed = positive(raw.clipSpeed, 1);
    node.clipLoop = CLIP_LOOPS.indexOf(raw.clipLoop) >= 0 ? raw.clipLoop : 'loop';
    node.clipOffset = round3(num(raw.clipOffset, 0));
  }

  if (kind === 'ref') {
    node.model = cleanLine(raw.model);
    if (!node.model) { dropItem(dropped, 'bad', 'node', raw, '缺 model，要引用哪份白膜'); return null; }
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
      if (seen.has(raw)) { dropItem(dropped, 'bad', 'node', raw, '同一棵树里重复引用了这个对象'); continue; }
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

function emptyDropped() {
  return { bad: 0, extra: 0, crowd: 0, anim: 0, cam: 0, light: 0, out: 0, details: [] };
}

/* ---------- 灯光 ---------- */

/* 一盏灯归一化：形状只收太阳 / 点光 / 聚光；`shadow` 只对太阳有效；
   聚光的锥角收在 (0, π/2] 内；颜色只收十六进制（写错回白）。 */
function normalizeLight(raw, usedIds, index, dropped) {
  if (!raw || typeof raw !== 'object') { dropItem(dropped, 'light', 'light', raw, '不是对象'); return null; }
  const shape = LIGHT_SHAPES.indexOf(raw.shape) >= 0 ? raw.shape : 'sun';
  let id = cleanLine(raw.id) || ('l-' + (index + 1));
  if (usedIds.has(id)) id = id + '-' + (index + 1);
  usedIds.add(id);
  const light = {
    id,
    name: cleanLine(raw.name) || ('灯光 ' + (index + 1)),
    shape,
    at: vec3(raw.at, [3, 4, 3]),
    energy: nonNeg(raw.energy, shape === 'sun' ? 2 : (shape === 'spot' ? 40 : 10)),
    color: cleanColor(raw.color) || '#ffffff',
    follow: cleanLine(raw.follow),
  };
  if (shape !== 'point') light.target = vec3(raw.target, [0, 0, 0]);
  if (shape === 'sun') {
    const sh = (raw.shadow && typeof raw.shadow === 'object') ? raw.shadow : {};
    light.shadow = {
      on: sh.on === true,
      mapSize: intAtLeast(sh.mapSize, 32, 2048),
      bias: Number.isFinite(Number(sh.bias)) ? Number(sh.bias) : -0.0005,
      normalBias: Number.isFinite(Number(sh.normalBias)) ? Number(sh.normalBias) : 0.02,
    };
  }
  if (shape === 'spot') {
    light.angle = round3(Math.min(Math.PI / 2, Math.max(0.01, num(raw.angle, Math.PI / 6))));
    light.penumbra = round3(Math.min(1, Math.max(0, num(raw.penumbra, 0.35))));
    light.distance = nonNeg(raw.distance, 0);
  } else if (shape === 'point') {
    light.distance = nonNeg(raw.distance, 0);
  }
  return light;
}

/* `lights` 整段省掉 = 内置默认装置；写成空数组 = 只留半球光（无实体灯）。 */
function normalizeLights(raw, dropped) {
  if (!Array.isArray(raw)) return defaultLights();
  const out = [];
  const used = new Set();
  for (const item of raw) {
    const light = normalizeLight(item, used, out.length, dropped);
    if (light) out.push(light);
  }
  return out;
}

/* 装置级：半球光 / 地面阴影 / 曝光。不可增删，只改值。 */
function normalizeLightDev(raw) {
  const dev = defaultLightDev();
  if (!raw || typeof raw !== 'object') return dev;
  const hemi = (raw.hemi && typeof raw.hemi === 'object') ? raw.hemi : {};
  dev.hemi = {
    sky: cleanColor(hemi.sky) || dev.hemi.sky,
    ground: cleanColor(hemi.ground) || dev.hemi.ground,
    energy: nonNeg(hemi.energy, dev.hemi.energy),
  };
  const g = (raw.ground && typeof raw.ground === 'object') ? raw.ground : {};
  dev.ground = {
    color: cleanColor(g.color) || dev.ground.color,
    opacity: round3(Math.min(1, Math.max(0, num(g.opacity, dev.ground.opacity)))),
  };
  const ex = num(raw.exposure, dev.exposure);
  dev.exposure = ex > 0 ? round3(ex) : 1;
  return dev;
}

function normalizeCams(rawCams, legacyCam, dropped) {
  let list = Array.isArray(rawCams) ? rawCams : [];
  if (!list.length && legacyCam && typeof legacyCam === 'object') list = [legacyCam];
  if (!list.length) list = [defaultCamera()];
  const out = [];
  const ids = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { dropItem(dropped, 'cam', 'cam', raw, '不是对象'); continue; }
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
  /* 机位沿路径走时的朝向：fixed（保持轨道自己的 target，默认）/ heading（沿切线）/
     target（看向 lookAt 那个节点）；heading 也可带 lookAt，给 framing:keep 当主体 */
  if (raw.look === 'heading' || raw.look === 'target') {
    path.look = raw.look;
    if (raw.lookAt) path.lookAt = cleanLine(raw.lookAt);
  }
  /* 速度曲线与构图：ease 不写 = linear（旧行为照旧）；framing 只在有 look 时有意义 */
  if (['in', 'out', 'inout', 'linear', 'hold'].indexOf(raw.ease) >= 0) path.ease = raw.ease;
  if (raw.framing === 'center' || raw.framing === 'keep' || raw.framing === 'rule3') path.framing = raw.framing;
  return path;
}

function normalizeTracks(rawTracks, nodeIds, camIds, lightIds, dropped) {
  const out = [];
  const ids = new Set();
  for (const tr of (Array.isArray(rawTracks) ? rawTracks : [])) {
    if (!tr || typeof tr !== 'object') { dropItem(dropped, 'anim', 'track', tr, '不是对象'); continue; }
    let of = null;
    if (tr.of && typeof tr.of === 'object') {
      const kind = tr.of.kind === 'cam' ? 'cam' : (tr.of.kind === 'light' ? 'light' : 'node');
      of = { kind, id: cleanLine(tr.of.id) };
    } else if (tr.nodeId != null) {
      of = { kind: 'node', id: cleanLine(tr.nodeId) };
    }
    if (!of || !of.id) { dropItem(dropped, 'anim', 'track', tr, '缺 of，这条轨道驱动谁'); continue; }
    const known = of.kind === 'cam' ? camIds : (of.kind === 'light' ? lightIds : nodeIds);
    if (!known.has(of.id)) {
      const what = of.kind === 'cam' ? '机位' : (of.kind === 'light' ? '灯光' : '节点');
      dropItem(dropped, 'anim', 'track', tr, 'of.id 指向不存在的' + what + '：' + of.id);
      continue;
    }

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
      if (k.energy != null) {
        const energy = num(k.energy, 0);
        if (energy >= 0) key.energy = round3(energy);
      }
      if (k.color != null) {
        const color = cleanColor(k.color);
        if (color) key.color = color;
      }
      if (k.scale != null) key.scale = scaleOf(k.scale);
      if (typeof k.visible === 'boolean') key.visible = k.visible;
      if (k.ease === 'smooth' || k.ease === 'linear' || k.ease === 'hold') key.ease = k.ease;
      if (key.at || key.rot || key.pose || key.target || key.fov != null
        || key.energy != null || key.color || key.scale || key.visible != null || key.ease) keys.push(key);
    }
    keys.sort((a, b) => a.t - b.t);
    const path = normalizePath(tr.path);
    if (!keys.length && !path) { dropItem(dropped, 'anim', 'track', tr, '没有关键帧也没有路径'); continue; }

    let id = cleanLine(tr.id) || newId('t');
    if (ids.has(id)) id = id + '-' + (out.length + 1);
    ids.add(id);
    out.push({
      id,
      of,
      enabled: tr.enabled !== false,
      color: Math.abs(Math.round(num(tr.color, 0))),
      interp: TRACK_INTERPS.indexOf(tr.interp) >= 0 ? tr.interp : 'smooth',
      motion: normalizeMotion(tr.motion),
      joint: jointPathOf(tr.joint),
      path,
      keys,
      /* 轨道自己的时钟：offset 从第几秒开始、speed 倍速、duration 自己的长度（0 = 用全局） */
      offset: nonNeg(tr.offset, 0),
      speed: Number(tr.speed) > 0 ? round3(Number(tr.speed)) : 1,
      duration: Number(tr.duration) > 0 ? round3(Number(tr.duration)) : 0,
      keysMode: tr.keysMode === 'offset' ? 'offset' : 'override',
      solo: tr.solo === true,
      follow: cleanLine(tr.follow),
      ease: ['in', 'out', 'inout', 'linear', 'hold'].indexOf(tr.ease) >= 0 ? tr.ease : '',
    });
  }
  return out;
}

/* 步态：`"walk"` / `"run"` 照旧，也可以给对象调参数（speed 步频、stride 步幅、arm 臂摆）。 */
function normalizeMotion(raw) {
  if (raw === 'walk' || raw === 'run') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const kind = raw.kind === 'run' ? 'run' : (raw.kind === 'walk' ? 'walk' : '');
  if (!kind) return '';
  return {
    kind,
    speed: positive(raw.speed, 1),
    stride: positive(raw.stride, 1),
    arm: nonNeg(raw.arm, 1),
  };
}

/* ---------- 文档 ---------- */

/* 丢一个条目时记一笔明细：AI 下一轮要知道自己丢了谁、为什么丢（否则会继续引用
   一个已经不存在的 id，那条 op 又被 scope 拒掉，用户只看到「什么也没发生」）。
   计数与明细同一次长，界面上的读数仍读计数。 */
function dropItem(dropped, bucket, what, raw, why) {
  dropped[bucket] += 1;
  const d = { what, why };
  if (raw && typeof raw === 'object') {
    const id = cleanLine(raw.id);
    const name = cleanLine(raw.name);
    if (id) d.id = id;
    if (name) d.name = name;
  }
  dropped.details.push(d);
}

/* 一整个文档的归一化。返回 { doc, dropped } —— dropped 是给人看的计数 + 明细，不是错误码。 */
export function normalizeDoc(raw) {
  const dropped = { bad: 0, extra: 0, crowd: 0, anim: 0, cam: 0, light: 0, out: 0, details: [] };
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

  doc.scene.lights = normalizeLights(scene.lights, dropped);
  const lightIds = new Set(doc.scene.lights.map(l => l.id));
  for (const light of doc.scene.lights) {
    if (light.follow && !nodeIds.has(light.follow)) light.follow = '';
  }
  doc.scene.light = normalizeLightDev(scene.light);

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
    tracks: normalizeTracks(anim.tracks, nodeIds, camIds, lightIds, dropped),
  };

  const out = [];
  for (const item of (Array.isArray(raw.out) ? raw.out : [])) {
    if (!item || typeof item !== 'object') { dropItem(dropped, 'out', 'out', item, '不是对象'); continue; }
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

/* ---------- 版本迁移 ---------- */

/* 旧文档升级 = 归一化补齐：老形状（scene.camera、tr.nodeId）由 normalizeDoc 就地翻成 v3，
   缺的默认值一并填上。只按「从哪一版到哪一版」整对登记，不拼相邻链 —— 磁盘上真实出现过的
   只有 v1 与 v3，中间没有落过盘的版本不造一条假的迁移出来。 */
const toV3 = doc => normalizeDoc(doc).doc;
export const MIGRATIONS = {
  '1>3': toV3,
  '2>3': toV3,
};

export function migrateDoc(doc, from, to) {
  const src = Number(from);
  const dst = Number(to);
  if (!Number.isInteger(src) || !Number.isInteger(dst) || src < 1 || dst < 1) throw new Error('版本号必须是正整数');
  if (src === dst) return cloneDoc(doc);
  if (dst < src) throw new Error('白膜文档只能往上升级，不能降级：' + src + ' → ' + dst);
  const step = MIGRATIONS[src + '>' + dst];
  if (!step) throw new Error('没有 ' + src + ' → ' + dst + ' 的迁移');
  return step(doc);
}

/* ---------- 写盘用的稀疏形态 ---------- */

/* sparseDoc 是 normalizeDoc 的逆操作：只写非默认字段，读回来一套归一化就能还原。
   两边的默认值必须成对维护 —— 这里少省一个只是文件大一点，多省一个会在读回时改变形状。
   不进磁盘的字段（`fromModel:""`、全零 `rot`、全一 `scale`、默认枚举）都不写。 */
const isVec3At = (v, x, y, z) => Array.isArray(v) && v[0] === x && v[1] === y && v[2] === z;
const copyVec = v => (Array.isArray(v) ? v.slice() : v);
const copyPairs = list => (Array.isArray(list) ? list.map(p => (Array.isArray(p) ? p.slice() : p)) : []);

function sparsePath(path) {
  const out = {};
  if (path.kind && path.kind !== 'line') out.kind = path.kind;
  if (!isVec3At(path.from, 0, 0, 0)) out.from = copyVec(path.from);
  if (!isVec3At(path.to, 0, 0, 2)) out.to = copyVec(path.to);
  if (path.radius != null && path.radius !== 1.5) out.radius = path.radius;
  if (path.clockwise === true) out.clockwise = true;
  if (path.kind === 'free') {
    out.pts = copyPairs(path.pts);
    if (path.closed === true) out.closed = true;
  }
  if (path.look === 'heading' || path.look === 'target') {
    out.look = path.look;
    if (path.lookAt) out.lookAt = path.lookAt;
  }
  if (path.ease) out.ease = path.ease;
  if (path.framing) out.framing = path.framing;
  return out;
}

function sparseKey(key) {
  const out = { t: key.t };
  if (key.at) out.at = copyVec(key.at);
  if (key.rot) out.rot = copyVec(key.rot);
  if (key.pose) out.pose = key.pose;
  if (key.target) out.target = copyVec(key.target);
  if (key.fov != null) out.fov = key.fov;
  if (key.energy != null) out.energy = key.energy;
  if (key.color) out.color = key.color;
  if (key.scale) out.scale = copyVec(key.scale);
  if (key.visible != null) out.visible = key.visible;
  if (key.ease) out.ease = key.ease;
  return out;
}

/* 轨道读侧 / 写盘共用的稀疏形态：默认值不写（enabled / interp / 路径默认值），
   关键帧上 `at` / `rot` 出现与否是语义，照原样保留。 */
export function sparseTrack(track) {
  const of = track.of && typeof track.of === 'object' ? track.of : {};
  const out = {
    id: track.id,
    of: { kind: of.kind === 'cam' ? 'cam' : (of.kind === 'light' ? 'light' : 'node'), id: of.id },
  };
  if (track.enabled === false) out.enabled = false;
  if (track.color) out.color = track.color;
  if (track.interp && track.interp !== 'smooth') out.interp = track.interp;
  if (track.motion) out.motion = track.motion;
  if (track.joint) out.joint = track.joint;
  if (track.offset) out.offset = track.offset;
  if (track.speed != null && track.speed !== 1) out.speed = track.speed;
  if (track.duration) out.duration = track.duration;
  if (track.keysMode === 'offset') out.keysMode = 'offset';
  if (track.solo === true) out.solo = true;
  if (track.follow) out.follow = track.follow;
  if (track.ease) out.ease = track.ease;
  if (track.path) out.path = sparsePath(track.path);
  if (Array.isArray(track.keys) && track.keys.length) out.keys = track.keys.map(sparseKey);
  return out;
}

function sparseNode(node) {
  const out = { kind: node.kind, id: node.id };
  if (node.name) out.name = node.name;
  if (node.fromModel) out.fromModel = node.fromModel;
  if (!isVec3At(node.at, 0, 0, 0)) out.at = copyVec(node.at);
  if (!isVec3At(node.rot, 0, 0, 0)) out.rot = copyVec(node.rot);
  if (!isVec3At(node.scale, 1, 1, 1)) out.scale = copyVec(node.scale);
  if (node.array) {
    out.array = {
      rows: node.array.rows,
      cols: node.array.cols,
      gapX: node.array.gapX,
      gapZ: node.array.gapZ,
      jitter: node.array.jitter,
    };
  }
  if (node.visible === false) out.visible = false;
  if (node.locked === true) out.locked = true;
  if (node.color) out.color = node.color;

  if (node.kind === 'prim') {
    out.shape = node.shape;
    if (node.tone && node.tone !== 'hi') out.tone = node.tone;
    if ((node.shape === 'box' || node.shape === 'plate') && !isVec3At(node.size, 1, 1, 1)) out.size = copyVec(node.size);
    if (node.shape === 'sphere' && node.r !== 0.5) out.r = node.r;
    if (node.shape === 'cylinder' || node.shape === 'cone' || node.shape === 'capsule') {
      if (node.r !== 0.3) out.r = node.r;
      if (node.h !== 1) out.h = node.h;
      if (node.shape === 'cylinder' && node.r2 !== node.r) out.r2 = node.r2;
    }
    if (node.shape === 'torus') {
      if (node.r !== 0.4) out.r = node.r;
      if (node.r2 !== 0.12) out.r2 = node.r2;
    }
    if (node.shape === 'loft') {
      if (node.path) {
        out.path = sparsePath(node.path);
        out.profile = copyPairs(node.profile);
      } else {
        out.rings = (Array.isArray(node.rings) ? node.rings : []).map(rr => ({
          y: rr.y, rx: rr.rx, rz: rr.rz, cx: rr.cx, cz: rr.cz,
        }));
        if (node.subdiv != null) out.subdiv = node.subdiv;
      }
      if (node.seg !== 20) out.seg = node.seg;
    }
    if (node.shape === 'lathe') {
      out.profile = copyPairs(node.profile);
      if (node.seg !== 24) out.seg = node.seg;
    }
    if (node.shape === 'extrude') {
      out.poly = copyPairs(node.poly);
      if (node.depth !== 0.2) out.depth = node.depth;
    }
    if (node.shape !== 'loft' && node.shape !== 'lathe' && node.seg != null) out.seg = node.seg;
    if (node.mirror === true) out.mirror = true;
    if (node.repeat) out.repeat = { n: node.repeat.n, dx: node.repeat.dx, dy: node.repeat.dy, dz: node.repeat.dz };
  } else if (node.kind === 'mannequin') {
    if (node.body && node.body !== 'mannequin') out.body = node.body;
    if (node.pose && node.pose !== 'stand') out.pose = node.pose;
    if (node.controls) out.controls = Object.assign({}, node.controls);
    if (node.tone && node.tone !== 'hi') out.tone = node.tone;
  } else if (node.kind === 'crowd') {
    if (node.body && node.body !== 'mannequin') out.body = node.body;
    if (node.pose && node.pose !== 'stand') out.pose = node.pose;
    if (node.rows !== 3) out.rows = node.rows;
    if (node.cols !== 3) out.cols = node.cols;
    if (node.gapX !== 0.9) out.gapX = node.gapX;
    if (node.gapZ !== 0.9) out.gapZ = node.gapZ;
    if (node.jitter !== 0) out.jitter = node.jitter;
    if (node.tone && node.tone !== 'mid') out.tone = node.tone;
  } else if (node.kind === 'asset') {
    out.file = node.file;
    if (node.lib) out.lib = node.lib;
    if (node.clay === false) out.clay = false;
    if (node.clip) out.clip = node.clip;
    if (node.clipSpeed != null && node.clipSpeed !== 1) out.clipSpeed = node.clipSpeed;
    if (node.clipLoop && node.clipLoop !== 'loop') out.clipLoop = node.clipLoop;
    if (node.clipOffset) out.clipOffset = node.clipOffset;
  } else if (node.kind === 'ref') {
    out.model = node.model;
  }

  if (Array.isArray(node.children) && node.children.length) out.children = node.children.map(sparseNode);
  return out;
}

function sparseCam(cam, index) {
  const base = defaultCamera();
  const out = { id: cam.id };
  if (cam.name && cam.name !== '机位 ' + (index + 1)) out.name = cam.name;
  if (!isVec3At(cam.pos, base.pos[0], base.pos[1], base.pos[2])) out.pos = copyVec(cam.pos);
  if (!isVec3At(cam.target, base.target[0], base.target[1], base.target[2])) out.target = copyVec(cam.target);
  if (cam.fov !== 35) out.fov = cam.fov;
  if (cam.follow) out.follow = cam.follow;
  return out;
}

/* 灯写盘：灯很少，字段不多，整盏写出来读着清楚（默认那两盏整段省掉）。 */
function sparseLight(light) {
  const out = { id: light.id, name: light.name, shape: light.shape, at: copyVec(light.at) };
  if (light.shape !== 'point') out.target = copyVec(light.target);
  out.energy = light.energy;
  out.color = light.color;
  if (light.shape === 'sun') {
    out.shadow = {
      on: light.shadow.on,
      mapSize: light.shadow.mapSize,
      bias: light.shadow.bias,
      normalBias: light.shadow.normalBias,
    };
  } else if (light.shape === 'spot') {
    out.angle = light.angle;
    out.penumbra = light.penumbra;
    out.distance = light.distance;
  } else if (light.shape === 'point') {
    out.distance = light.distance;
  }
  if (light.follow) out.follow = light.follow;
  return out;
}

function sparseLightDev(dev) {
  return {
    hemi: { sky: dev.hemi.sky, ground: dev.hemi.ground, energy: dev.hemi.energy },
    ground: { color: dev.ground.color, opacity: dev.ground.opacity },
    exposure: dev.exposure,
  };
}

function sparseOutItem(item) {
  const out = { id: item.id };
  if (item.assetId) out.assetId = item.assetId;
  if (item.url) out.url = item.url;
  if (item.type && item.type !== 'image') out.type = item.type;
  if (item.name) out.name = item.name;
  if (item.at != null) out.at = item.at;
  if (item.picked === false) out.picked = false;
  return out;
}

export function sparseDoc(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const out = { v: src.v == null ? MODEL_V : src.v };
  if (src.kind) out.kind = src.kind;
  if (src.name) out.name = src.name;
  if (src.group) out.group = src.group;
  if (src.note) out.note = src.note;
  if (Number.isFinite(src.ts)) out.ts = src.ts;

  const scene = src.scene && typeof src.scene === 'object' ? src.scene : {};
  const s = { nodes: (Array.isArray(scene.nodes) ? scene.nodes : []).map(sparseNode) };
  const cams = (Array.isArray(scene.cams) ? scene.cams : []).map(sparseCam);
  const onlyDefaultCam = cams.length === 1 && Object.keys(cams[0]).length === 1 && cams[0].id === defaultCamera().id;
  if (cams.length && !onlyDefaultCam) s.cams = cams;
  if (scene.active && cams.length && scene.active !== cams[0].id) s.active = scene.active;

  /* 默认灯装置整段省掉；写成空数组（只留半球光）要落盘，那是用户的选择。 */
  if (Array.isArray(scene.lights)) {
    const lights = scene.lights.map(sparseLight);
    if (JSON.stringify(lights) !== JSON.stringify(defaultLights().map(sparseLight))) s.lights = lights;
  }
  if (scene.light && typeof scene.light === 'object') {
    const dev = sparseLightDev(scene.light);
    if (JSON.stringify(dev) !== JSON.stringify(sparseLightDev(defaultLightDev()))) s.light = dev;
  }

  const pan = scene.panorama && typeof scene.panorama === 'object' ? scene.panorama : {};
  const p = {};
  if (pan.src) p.src = pan.src;
  if (pan.yaw) p.yaw = pan.yaw;
  if (pan.radius != null && pan.radius !== 20) p.radius = pan.radius;
  if (Object.keys(p).length) s.panorama = p;

  const view = scene.view && typeof scene.view === 'object' ? scene.view : {};
  const vv = {};
  if (view.mode && view.mode !== 'director') vv.mode = view.mode;
  if (view.aspect && view.aspect !== '16:9') vv.aspect = view.aspect;
  if (view.grid === false) vv.grid = false;
  if (view.ground === false) vv.ground = false;
  if (view.outline === false) vv.outline = false;
  if (Object.keys(vv).length) s.view = vv;
  out.scene = s;

  const anim = src.anim && typeof src.anim === 'object' ? src.anim : {};
  const a = {};
  if (anim.duration != null && anim.duration !== 4) a.duration = anim.duration;
  if (anim.fps != null && anim.fps !== 24) a.fps = anim.fps;
  if (anim.loop === false) a.loop = false;
  const tracks = (Array.isArray(anim.tracks) ? anim.tracks : []).map(sparseTrack);
  if (tracks.length) a.tracks = tracks;
  if (Object.keys(a).length) out.anim = a;

  const rows = (Array.isArray(src.out) ? src.out : []).map(sparseOutItem);
  if (rows.length) out.out = rows;

  const sp = src.src && typeof src.src === 'object' ? src.src : {};
  const spOut = {};
  if (sp.prompt) spOut.prompt = sp.prompt;
  if (sp.reuse && sp.reuse.id) {
    const reuse = { id: sp.reuse.id };
    if (sp.reuse.mode && sp.reuse.mode !== 'base') reuse.mode = sp.reuse.mode;
    if (sp.reuse.why) reuse.why = sp.reuse.why;
    spOut.reuse = reuse;
  }
  if (Object.keys(spOut).length) out.src = spOut;
  return out;
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

/* 场景大纲：一层一行、只给「够认出来」的骨架 —— id、名字、形状或种类、子节点数。
   坐标 / 材质 / 轨道都不进大纲（它们在选中子树的完整细节里）。
   顶层行不带缩进，往下每层两个空格；缩进到第 8 层封顶（更深的行前面加 `… `），
   免得一条深链把提示词按深度的平方撑大。返回一行一条字符串。 */
export function outlineOf(doc) {
  const roots = (doc && doc.scene && Array.isArray(doc.scene.nodes)) ? doc.scene.nodes : [];
  const lines = [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) stack.push({ node: roots[i], depth: 0 });
  while (stack.length) {
    const it = stack.pop();
    const node = it.node;
    if (!node || typeof node !== 'object') continue;
    const kids = Array.isArray(node.children) ? node.children : [];
    const kindOrShape = node.kind === 'prim' ? (cleanLine(node.shape) || 'prim') : (cleanLine(node.kind) || '?');
    const name = cleanLine(node.name);
    const pad = it.depth === 0 ? ''
      : '  '.repeat(Math.min(it.depth, 8)) + (it.depth > 8 ? '… ' : '- ');
    lines.push(pad + cleanLine(node.id) + (name ? '「' + name + '」' : '')
      + '(' + kindOrShape + ')' + (kids.length ? ' 子' + kids.length : ''));
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ node: kids[i], depth: it.depth + 1 });
  }
  return lines;
}

export function camOf(doc, id) {
  return (doc && doc.scene && Array.isArray(doc.scene.cams))
    ? doc.scene.cams.find(c => c.id === id) || null : null;
}

/* 轨道在这条时间轴上到第几秒为止（按它自己的 offset / speed / duration 折算）：
   关键帧的 t 是局部时间；没写 duration 的路径本来就跟全片一样长，不算「超出」。停用的轨道不算。 */
export function trackEndOf(anim) {
  let end = 0;
  for (const tr of ((anim && anim.tracks) || [])) {
    if (tr.enabled === false) continue;
    const off = Math.max(0, Number(tr.offset) || 0);
    const sp = Number(tr.speed) > 0 ? Number(tr.speed) : 1;
    const dur = Number(tr.duration) > 0 ? Number(tr.duration) : 0;
    const keys = Array.isArray(tr.keys) ? tr.keys : [];
    let local = 0;
    if (keys.length) local = Math.max(local, Number(keys[keys.length - 1].t) || 0);
    if (dur > 0) local = Math.max(local, dur);
    if (local > 0) end = Math.max(end, off + local / sp);
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
    } else if (kind === 'light') {
      tryOp(() => {
        if (scope) throw new Error('选中实体编辑不能改灯光');
        const lights = base.scene.lights || (base.scene.lights = []);
        const dev = base.scene.light || (base.scene.light = defaultLightDev());
        if (op.remove === true) {
          const i = lights.findIndex(l => l.id === String(op.id));
          if (i < 0) throw new Error('找不到灯光：' + op.id);
          lights.splice(i, 1);
          return;
        }
        if (op.add && typeof op.add === 'object') {
          const used = new Set(lights.map(l => l.id));
          const light = normalizeLight(op.add, used, lights.length, emptyDropped());
          if (!light) throw new Error('light.add 不是一盏灯');
          lights.push(light);
          return;
        }
        /* 没有 id 的 set 是装置级：曝光 / 半球光 / 地面阴影 */
        if ((op.id == null || op.id === '') && op.set && typeof op.set === 'object') {
          base.scene.light = normalizeLightDev({
            hemi: Object.assign({}, dev.hemi, (op.set.hemi && typeof op.set.hemi === 'object') ? op.set.hemi : {}),
            ground: Object.assign({}, dev.ground, (op.set.ground && typeof op.set.ground === 'object') ? op.set.ground : {}),
            exposure: op.set.exposure != null ? op.set.exposure : dev.exposure,
          });
          return;
        }
        const i = lights.findIndex(l => l.id === String(op.id));
        if (i < 0) throw new Error('找不到灯光：' + op.id);
        if (op.set && typeof op.set === 'object') {
          const used = new Set(lights.map(l => l.id).filter(id => id !== lights[i].id));
          const light = normalizeLight(Object.assign({}, lights[i], op.set, { id: lights[i].id }), used, i, emptyDropped());
          if (!light) throw new Error('light.set 之后不是一盏灯');
          lights[i] = light;
        }
      });
    } else if (kind === 'track') {
      tryOp(() => {
        const tracks = base.anim.tracks || (base.anim.tracks = []);
        const needTrackScope = tr => {
          if (!scope) return;
          if (!tr || !tr.of || tr.of.kind !== 'node') throw new Error('op 越界：选中实体编辑不能改机位或灯光轨道');
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
