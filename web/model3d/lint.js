/* 白膜几何体检 —— AI 交出来的零件树进场景之前先过一遍「站不站得住、进不进画幅」。
   纯数据：不碰 DOM、不碰 three、不联网，输入输出都是 v3 文档，判据能在 Node 里直接跑。

   出问题就修，不丢：零件本身没坏，只是位置 / 比例不对。这里只动让几何不成立的那几个数，
   单件尺寸离谱只提醒 —— 一面墙 / 一座山本来就该很大，自动缩会改坏构图。
   每一处改动都要能回答「动了什么」，所以永远带一句人话交回去。

   量得到与量不到的分开：图元 / 小人 / 群众按形状算包围盒；导入的摆件外观未知，不参与。
   世界矩阵照渲染那一份算：T(at) · R(欧拉 XYZ，度) · S(scale)，镜像在 scale.x 上取负、
   阵列偏移加在父空间；群众的每个人再叠一层 T(at) · Ry(yaw) · S(scale)，而且阵列点的 at
   里已经含过节点自己的 at —— 渲染就是叠两次，体检必须跟着叠，否则量出来矮一截。
   小人的高度不取比例表的估算值：渲染会把零件树按姿势造出来，再把整只抬到脚底贴地
   （root 的落地偏移），所以这里也走同一棵零件树量真实的脚底到头顶。 */

import { cloneDoc, round3 } from './schema.js';
import { variantsOf, cloneNodeForVariant } from './dsl.js';
import { crowdLayout } from './crowd.js';
import { mannequinTree } from './mannequin.js';
import { samplePath } from './anim.js';

const LINT_EPS = 0.02;
const LINT_FLOAT_WARN = 0.1;
const LINT_FRAME_MARGIN = 0.9;
const LINT_CENTER_TOL = 0.02;
const LINT_MIN_H = 0.5;
const LINT_MAX_H = 4;
const LINT_PART_MAX = 20;
const LINT_PASS_MAX = 8;
const LINT_D2R = Math.PI / 180;

const lintNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const lintNumText = v => String(Number(Number(v).toFixed(2)));
const lintAbs = v => Math.abs(lintNum(v));

const lintNameOf = node => {
  if (node.name) return node.name;
  if (node.kind === 'prim') {
    const names = {
      box: '方块', plate: '薄板', sphere: '球', cylinder: '圆柱', cone: '圆锥',
      capsule: '胶囊', torus: '圆环', loft: '放样体', lathe: '旋转体', extrude: '拉伸体',
    };
    return names[node.shape] || '零件';
  }
  if (node.kind === 'mannequin') return '小人';
  if (node.kind === 'crowd') return '群众';
  if (node.kind === 'group') return '组';
  if (node.kind === 'asset') return '摆件';
  return '零件';
};

/* ---------- 包围盒 ---------- */

function lintEmptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function lintIsEmpty(box) {
  return !(box.max[0] >= box.min[0] && box.max[1] >= box.min[1] && box.max[2] >= box.min[2]);
}

function lintUnionInto(a, b) {
  if (lintIsEmpty(b)) return a;
  for (let i = 0; i < 3; i++) {
    if (b.min[i] < a.min[i]) a.min[i] = b.min[i];
    if (b.max[i] > a.max[i]) a.max[i] = b.max[i];
  }
  return a;
}

function lintBoxOfLeaves(leaves) {
  const box = lintEmptyBox();
  for (const leaf of leaves) lintUnionInto(box, leaf.box);
  return box;
}

function lintScaleBox(box, factor, pivot) {
  const out = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let i = 0; i < 3; i++) {
    const a = pivot[i] + (box.min[i] - pivot[i]) * factor;
    const b = pivot[i] + (box.max[i] - pivot[i]) * factor;
    out.min[i] = Math.min(a, b);
    out.max[i] = Math.max(a, b);
  }
  return out;
}

/* ---------- 仿射矩阵（3×3 行主序 + 平移） ---------- */

function lintMat(at, rot, scale) {
  const rx = lintNum(rot[0]) * LINT_D2R;
  const ry = lintNum(rot[1]) * LINT_D2R;
  const rz = lintNum(rot[2]) * LINT_D2R;
  const a = Math.cos(rx), b = Math.sin(rx);
  const c = Math.cos(ry), d = Math.sin(ry);
  const e = Math.cos(rz), f = Math.sin(rz);
  const r = [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i][j] *= scale[j];
  }
  return { r, t: [lintNum(at[0]), lintNum(at[1]), lintNum(at[2])] };
}

function lintMatOf(node, mirrorX) {
  const at = node.at || [0, 0, 0];
  const rot = node.rot || [0, 0, 0];
  const sc = node.scale || [1, 1, 1];
  const scale = [mirrorX ? -lintNum(sc[0], 1) : lintNum(sc[0], 1), lintNum(sc[1], 1), lintNum(sc[2], 1)];
  return lintMat(at, rot, scale);
}

function lintMul(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i][j] = a.r[i][0] * b.r[0][j] + a.r[i][1] * b.r[1][j] + a.r[i][2] * b.r[2][j];
    }
  }
  const t = [
    a.r[0][0] * b.t[0] + a.r[0][1] * b.t[1] + a.r[0][2] * b.t[2] + a.t[0],
    a.r[1][0] * b.t[0] + a.r[1][1] * b.t[1] + a.r[1][2] * b.t[2] + a.t[1],
    a.r[2][0] * b.t[0] + a.r[2][1] * b.t[1] + a.r[2][2] * b.t[2] + a.t[2],
  ];
  return { r, t };
}

function lintInvLinear(m) {
  const a = m.r;
  const A = a[0][0], B = a[0][1], C = a[0][2];
  const D = a[1][0], E = a[1][1], F = a[1][2];
  const G = a[2][0], H = a[2][1], I = a[2][2];
  const det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  return [
    [(E * I - F * H) / det, (C * H - B * I) / det, (B * F - C * E) / det],
    [(F * G - D * I) / det, (A * I - C * G) / det, (C * D - A * F) / det],
    [(D * H - E * G) / det, (B * G - A * H) / det, (A * E - B * D) / det],
  ];
}

function lintInvPoint(inv, v) {
  return [
    inv[0][0] * v[0] + inv[0][1] * v[1] + inv[0][2] * v[2],
    inv[1][0] * v[0] + inv[1][1] * v[1] + inv[1][2] * v[2],
    inv[2][0] * v[0] + inv[2][1] * v[1] + inv[2][2] * v[2],
  ];
}

function lintMatMul3(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return r;
}

function lintXformBox(m, box) {
  const c = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const h = [
    (box.max[0] - box.min[0]) / 2,
    (box.max[1] - box.min[1]) / 2,
    (box.max[2] - box.min[2]) / 2,
  ];
  const rc = [0, 0, 0];
  const re = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    rc[i] = m.r[i][0] * c[0] + m.r[i][1] * c[1] + m.r[i][2] * c[2] + m.t[i];
    re[i] = Math.abs(m.r[i][0]) * h[0] + Math.abs(m.r[i][1]) * h[1] + Math.abs(m.r[i][2]) * h[2];
  }
  return {
    min: [rc[0] - re[0], rc[1] - re[1], rc[2] - re[2]],
    max: [rc[0] + re[0], rc[1] + re[1], rc[2] + re[2]],
  };
}

/* ---------- 各类零件的局部包围盒 ---------- */

/* 小人零件树里那四种几何（与 scene.js 的 partGeometry 一一对应）。 */
function lintJointBox(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.k === 'capsule') {
    const r = lintAbs(g.r);
    const len = lintAbs(g.len);
    return { min: [-r, -len / 2 - r, -r], max: [r, len / 2 + r, r] };
  }
  if (g.k === 'sphere') {
    const r = lintAbs(g.r);
    return { min: [-r, -r, -r], max: [r, r, r] };
  }
  if (g.k === 'cyl') {
    const r = Math.max(lintAbs(g.rt), lintAbs(g.rb));
    const h = lintAbs(g.h);
    return { min: [-r, -h / 2, -r], max: [r, h / 2, r] };
  }
  if (g.k === 'torus') {
    const r = lintAbs(g.r);
    const r2 = lintAbs(g.r2);
    return { min: [-(r + r2), -(r + r2), -r2], max: [r + r2, r + r2, r2] };
  }
  return null;
}

function lintJointTreeBox(spec, parent, box) {
  if (!spec || typeof spec !== 'object') return;
  const here = lintMul(parent, lintMat(spec.at, spec.rot, spec.scale));
  for (const p of (spec.parts || [])) {
    const local = lintJointBox(p.g);
    if (!local) continue;
    lintUnionInto(box, lintXformBox(lintMul(here, lintMat(p.at, p.rot, p.scale)), local));
  }
  for (const child of (spec.children || [])) lintJointTreeBox(child, here, box);
}

const lintMannequinCache = new Map();

/* 渲染侧把整只抬到脚底贴地，所以交回去的盒子底线恒为 0。 */
function lintMannequinBox(node) {
  const key = [node.body || '', node.pose || '', JSON.stringify(node.controls || {})].join('|');
  let box = lintMannequinCache.get(key);
  if (!box) {
    box = lintEmptyBox();
    const tree = mannequinTree({
      body: node.body, pose: node.pose, controls: node.controls || {}, motion: '', t: 0,
    });
    lintJointTreeBox(tree, lintMat([0, 0, 0], [0, 0, 0], [1, 1, 1]), box);
    if (lintIsEmpty(box)) box = { min: [-0.35, -1, -0.25], max: [0.35, 1.8, 0.25] };
    box = {
      min: [box.min[0], 0, box.min[2]],
      max: [box.max[0], box.max[1] - box.min[1], box.max[2]],
    };
    lintMannequinCache.set(key, box);
  }
  return box;
}

function lintPrimBox(node) {
  const s = node.shape;
  if (s === 'box' || s === 'plate') {
    const size = Array.isArray(node.size) ? node.size : [1, 1, 1];
    const hx = (lintAbs(size[0]) || 1) / 2;
    const hy = (lintAbs(size[1]) || 1) / 2;
    const hz = (lintAbs(size[2]) || 1) / 2;
    return { min: [-hx, -hy, -hz], max: [hx, hy, hz] };
  }
  if (s === 'sphere') {
    const r = lintAbs(node.r) || 0.5;
    return { min: [-r, -r, -r], max: [r, r, r] };
  }
  if (s === 'cylinder' || s === 'cone') {
    const r = Math.max(lintAbs(node.r) || 0.3, s === 'cylinder' ? lintAbs(node.r2) : 0);
    const h = lintAbs(node.h) || 1;
    return { min: [-r, -h / 2, -r], max: [r, h / 2, r] };
  }
  if (s === 'capsule') {
    const r = lintAbs(node.r) || 0.3;
    const h = lintAbs(node.h) || 1;
    return { min: [-r, -h / 2 - r, -r], max: [r, h / 2 + r, r] };
  }
  if (s === 'torus') {
    const r = lintAbs(node.r) || 0.4;
    const r2 = lintAbs(node.r2) || 0.12;
    return { min: [-(r + r2), -(r + r2), -r2], max: [r + r2, r + r2, r2] };
  }
  if (s === 'loft') {
    /* 沿路径扫掠：路径上取几处，按最大截面半径放宽（体检只要「大概在哪、多大」） */
    if (node.path && Array.isArray(node.profile) && node.profile.length) {
      let maxR = 0.001;
      for (const p of node.profile) maxR = Math.max(maxR, lintAbs(p[0]));
      const box = lintEmptyBox();
      for (let i = 0; i <= 8; i++) {
        const sp = samplePath(node.path, i / 8, 1);
        if (!sp || !sp.at) continue;
        lintUnionInto(box, {
          min: [sp.at[0] - maxR, sp.at[1] - maxR, sp.at[2] - maxR],
          max: [sp.at[0] + maxR, sp.at[1] + maxR, sp.at[2] + maxR],
        });
      }
      return lintIsEmpty(box) ? null : box;
    }
    const rings = Array.isArray(node.rings) ? node.rings : [];
    if (!rings.length) return null;
    const box = lintEmptyBox();
    for (const ring of rings) {
      const y = lintNum(ring.y);
      const rx = lintAbs(ring.rx) || 0.001;
      const rz = lintAbs(ring.rz) || 0.001;
      const cx = lintNum(ring.cx);
      const cz = lintNum(ring.cz);
      lintUnionInto(box, { min: [cx - rx, y, cz - rz], max: [cx + rx, y, cz + rz] });
    }
    return box;
  }
  if (s === 'lathe') {
    const prof = Array.isArray(node.profile) ? node.profile : [];
    if (!prof.length) return null;
    const box = lintEmptyBox();
    for (const p of prof) {
      const r = lintAbs(p[0]);
      const y = lintNum(p[1]);
      lintUnionInto(box, { min: [-r, y, -r], max: [r, y, r] });
    }
    return box;
  }
  if (s === 'extrude') {
    const poly = Array.isArray(node.poly) ? node.poly : [];
    if (!poly.length) return null;
    const depth = lintAbs(node.depth) || 0.2;
    const box = lintEmptyBox();
    for (const p of poly) {
      const x = lintNum(p[0]);
      const y = lintNum(p[1]);
      lintUnionInto(box, { min: [x, y, 0], max: [x, y, depth] });
    }
    return box;
  }
  return null;
}

/* ---------- 叶子收集：每个实例一条世界包围盒 ---------- */

function lintCollect(doc) {
  const leaves = [];
  const parentMatById = new Map();
  const roots = (doc.scene && Array.isArray(doc.scene.nodes)) ? doc.scene.nodes : [];
  const identity = lintMat([0, 0, 0], [0, 0, 0], [1, 1, 1]);
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], parent: identity });
  while (stack.length) {
    const cur = stack.pop();
    const node = cur.node;
    if (!node || typeof node !== 'object') continue;
    if (node.visible === false) continue;
    if (!parentMatById.has(node.id)) parentMatById.set(node.id, cur.parent);
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const variant of variantsOf(node)) {
      const { node: vnode, mirrorX } = cloneNodeForVariant(node, variant);
      const world = lintMul(cur.parent, lintMatOf(vnode, mirrorX));
      const pushWorld = box => {
        if (!box || lintIsEmpty(box)) return;
        leaves.push({
          id: node.id,
          name: lintNameOf(node),
          kind: node.kind,
          box,
        });
      };
      const pushBox = box => {
        if (!box || lintIsEmpty(box)) return;
        pushWorld(lintXformBox(world, box));
      };
      if (node.kind === 'prim') pushBox(lintPrimBox(vnode));
      else if (node.kind === 'mannequin') pushBox(lintMannequinBox(vnode));
      else if (node.kind === 'crowd') {
        /* 每个阵列点已经乘过 world，union 就是世界盒，别再乘第二次 */
        const union = lintEmptyBox();
        const person = lintMannequinBox(vnode);
        for (const pp of crowdLayout(vnode).people) {
          const pm = lintMat(pp.at, [0, pp.yaw, 0], [pp.scale, pp.scale, pp.scale]);
          lintUnionInto(union, lintXformBox(lintMul(world, pm), person));
        }
        pushWorld(union);
      }
      if (kids.length) {
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], parent: world });
      }
    }
  }
  return { leaves, parentMatById };
}

/* ---------- 悬空：量每个实例到最近支撑面的距离 ---------- */

function lintGapOf(leaf, leaves, skipIds) {
  const b = leaf.box;
  if (b.min[1] <= LINT_EPS) return { gap: 0, on: '' };
  let gap = b.min[1];
  let on = '';
  for (const other of leaves) {
    if (other.id === leaf.id) continue;
    if (skipIds && skipIds.has(other.id)) continue;
    const o = other.box;
    if (o.min[0] > b.max[0] + LINT_EPS || o.max[0] < b.min[0] - LINT_EPS) continue;
    if (o.min[2] > b.max[2] + LINT_EPS || o.max[2] < b.min[2] - LINT_EPS) continue;
    if (o.min[1] > b.min[1] + LINT_EPS) continue;
    if (o.max[1] >= b.min[1] - LINT_EPS) return { gap: 0, on: other.name };
    const g = b.min[1] - o.max[1];
    if (g < gap) { gap = g; on = other.name; }
  }
  return { gap, on };
}

function lintSubtreeIds(node) {
  const ids = new Set();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    ids.add(n.id);
    for (const kid of (Array.isArray(n.children) ? n.children : [])) stack.push(kid);
  }
  return ids;
}

/* 整棵子树是不是浮着，要和子树**外面**的支撑比：桌子浮在半空时，桌面正压在同样是
   这棵子树的四条腿上 —— 若把子树内部的互撑也算进来，整张桌子永远不会被判为悬空，
   最后变成四条腿各自往地里钻。所以量一个节点时，把子树里的叶子从支撑列表里摘掉：
   只有地面或子树外的零件能把它托住。浮着的最上层节点就是这一轮要动的单位。 */
function lintUnits(doc, leaves) {
  const units = [];
  const roots = (doc.scene && Array.isArray(doc.scene.nodes)) ? doc.scene.nodes : [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || node.visible === false) continue;
    const ids = lintSubtreeIds(node);
    let subGap = Infinity;
    let on = '';
    for (const leaf of leaves) {
      if (!ids.has(leaf.id)) continue;
      const g = lintGapOf(leaf, leaves, ids);
      if (g.gap < subGap) { subGap = g.gap; on = g.on; }
    }
    if (Number.isFinite(subGap) && subGap > LINT_EPS) {
      units.push({ node, gap: subGap, on });
      continue;
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return units;
}

function lintApplyMove(parentMatById, unit) {
  const parent = parentMatById.get(unit.node.id);
  if (!parent) return false;
  let lin = parent.r;
  if (unit.node.kind === 'crowd') {
    /* 群众的 at 在包装组与每个阵列点里各算一次：世界位移是 parent · (I + R·S) · Δat */
    const own = lintMatOf(unit.node, false).r;
    lin = lintMatMul3(parent.r, [
      [own[0][0] + 1, own[0][1], own[0][2]],
      [own[1][0], own[1][1] + 1, own[1][2]],
      [own[2][0], own[2][1], own[2][2] + 1],
    ]);
  }
  const inv = lintInvLinear({ r: lin });
  if (!inv) return false;
  const d = lintInvPoint(inv, [0, -unit.gap, 0]);
  if (!d.every(Number.isFinite)) return false;
  const at = unit.node.at || [0, 0, 0];
  unit.node.at = [round3(at[0] + d[0]), round3(at[1] + d[1]), round3(at[2] + d[2])];
  return true;
}

/* ---------- 整体缩放：只动顶层节点（子节点跟着父变换走） ----------
   相机不跟着缩：这一步是「让主体进画幅」，机位与主体的相对构图本来就是要改的东西。
   机位跟着缩的话主体在画面里的大小一点没变，缩完还在画幅外。 */
function lintScaleAll(doc, factor, pivot, topIds) {
  const point = p => [
    round3(pivot[0] + (lintNum(p[0]) - pivot[0]) * factor),
    round3(pivot[1] + (lintNum(p[1]) - pivot[1]) * factor),
    round3(pivot[2] + (lintNum(p[2]) - pivot[2]) * factor),
  ];
  for (const node of (doc.scene.nodes || [])) {
    if (!node || typeof node !== 'object') continue;
    node.at = point(node.at || [0, 0, 0]);
    const sc = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
    node.scale = [round3(lintNum(sc[0], 1) * factor), round3(lintNum(sc[1], 1) * factor), round3(lintNum(sc[2], 1) * factor)];
    if (node.repeat) {
      node.repeat.dx = round3(lintNum(node.repeat.dx) * factor);
      node.repeat.dy = round3(lintNum(node.repeat.dy) * factor);
      node.repeat.dz = round3(lintNum(node.repeat.dz) * factor);
    }
  }
  for (const tr of ((doc.anim && Array.isArray(doc.anim.tracks)) ? doc.anim.tracks : [])) {
    if (!tr || !tr.of) continue;
    if (tr.of.kind !== 'node' || !topIds.has(tr.of.id) || tr.joint) continue;
    for (const key of (tr.keys || [])) {
      if (Array.isArray(key.at)) key.at = point(key.at);
      if (Array.isArray(key.target)) key.target = point(key.target);
    }
    if (tr.path) {
      if (Array.isArray(tr.path.from)) tr.path.from = point(tr.path.from);
      if (Array.isArray(tr.path.to)) tr.path.to = point(tr.path.to);
      if (Array.isArray(tr.path.pts)) tr.path.pts = tr.path.pts.map(point);
      if (Number.isFinite(Number(tr.path.radius))) tr.path.radius = round3(Number(tr.path.radius) * factor);
    }
  }
}

/* 横向平移只动模型（相机不动）：贴地关系靠 y 不变保住，构图靠画幅那一步补齐。 */
function lintShiftAll(doc, delta, topIds) {
  const addPoint = p => [
    round3(lintNum(p[0]) + delta[0]),
    round3(lintNum(p[1]) + delta[1]),
    round3(lintNum(p[2]) + delta[2]),
  ];
  for (const node of (doc.scene.nodes || [])) {
    if (!node || typeof node !== 'object') continue;
    node.at = addPoint(node.at || [0, 0, 0]);
  }
  for (const tr of ((doc.anim && Array.isArray(doc.anim.tracks)) ? doc.anim.tracks : [])) {
    if (!tr || !tr.of || tr.of.kind !== 'node' || tr.joint) continue;
    if (!topIds.has(tr.of.id)) continue;
    for (const key of (tr.keys || [])) if (Array.isArray(key.at)) key.at = addPoint(key.at);
    if (tr.path) {
      if (Array.isArray(tr.path.from)) tr.path.from = addPoint(tr.path.from);
      if (Array.isArray(tr.path.to)) tr.path.to = addPoint(tr.path.to);
      if (Array.isArray(tr.path.pts)) tr.path.pts = tr.path.pts.map(addPoint);
    }
  }
}

/* ---------- 画幅 ---------- */

function lintAspectOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const parts = String(v == null ? '' : v).split(':').map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) return parts[0] / parts[1];
  return 16 / 9;
}

function lintCamOf(doc) {
  const cams = Array.isArray(doc.scene.cams) ? doc.scene.cams : [];
  if (!cams.length) return null;
  const active = doc.scene.active;
  return cams.find(c => c && c.id === active) || cams[0];
}

function lintCamLocked(doc, cam) {
  if (cam.follow) return true;
  const tracks = (doc.anim && Array.isArray(doc.anim.tracks)) ? doc.anim.tracks : [];
  return tracks.some(tr => tr && tr.of && tr.of.kind === 'cam' && tr.of.id === cam.id
    && (tr.keys || []).some(k => Array.isArray(k.at) || Array.isArray(k.target)));
}

function lintBasisOf(cam) {
  const pos = Array.isArray(cam.pos) ? cam.pos.map(lintNum) : [0, 0, 0];
  const target = Array.isArray(cam.target) ? cam.target.map(lintNum) : [0, 0, 0];
  const f = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
  const fl = Math.hypot(f[0], f[1], f[2]);
  if (!(fl > 1e-6)) return null;
  for (let i = 0; i < 3; i++) f[i] /= fl;
  let r = [-f[2], 0, f[0]];
  const rl = Math.hypot(r[0], r[1], r[2]);
  if (rl < 1e-6) r = [1, 0, 0];
  else { r[0] /= rl; r[1] /= rl; r[2] /= rl; }
  const u = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  return { pos, f, r, u };
}

function lintFitOf(box, cam, aspect) {
  const basis = lintBasisOf(cam);
  if (!basis) return null;
  const fov = Math.min(179, Math.max(1, lintNum(cam.fov, 35))) * LINT_D2R;
  const tan = Math.tan(fov / 2);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let depthSum = 0;
  for (let i = 0; i < 8; i++) {
    const p = [
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2],
    ];
    const d = [p[0] - basis.pos[0], p[1] - basis.pos[1], p[2] - basis.pos[2]];
    const depth = d[0] * basis.f[0] + d[1] * basis.f[1] + d[2] * basis.f[2];
    if (depth < 0.05) return { behind: true };
    const x = (d[0] * basis.r[0] + d[1] * basis.r[1] + d[2] * basis.r[2]) / (depth * tan * aspect);
    const y = (d[0] * basis.u[0] + d[1] * basis.u[1] + d[2] * basis.u[2]) / (depth * tan);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    depthSum += depth;
  }
  return {
    behind: false,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    ext: Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY)),
    depth: depthSum / 8,
    tan,
  };
}

function lintFrameFix(doc, box, aspect, topIds, pushFix, pushWarn) {
  const cam = lintCamOf(doc);
  if (!cam) return;
  let fit = lintFitOf(box, cam, aspect);
  if (!fit) return;
  if (fit.behind) {
    pushWarn('主体在机位背后或把机位包在里面，画幅检查跳过');
    return;
  }
  const boxH = box.max[1] - box.min[1];
  if (fit.ext > LINT_FRAME_MARGIN + 0.01) {
    const floorFactor = boxH > 1e-6 ? LINT_MIN_H / boxH : 0;
    const factor = Math.max(LINT_FRAME_MARGIN / fit.ext, floorFactor);
    if (factor < 0.999) {
      const pivot = [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2];
      lintScaleAll(doc, factor, pivot, topIds);
      box = lintScaleBox(box, factor, pivot);
      pushFix(`主体超出画幅，等比缩小到 ${lintNumText(factor)} 倍`);
      fit = lintFitOf(box, cam, aspect);
      if (!fit || fit.behind) {
        pushWarn('主体在机位背后或把机位包在里面，画幅检查跳过');
        return;
      }
    }
  }
  if (fit.ext <= LINT_FRAME_MARGIN + 0.01) return;
  let changed = false;
  if (Math.abs(fit.cx) > LINT_CENTER_TOL) {
    const basis = lintBasisOf(cam);
    if (basis) {
      const dx = -fit.cx * fit.depth * fit.tan * aspect;
      const delta = [basis.r[0] * dx, basis.r[1] * dx, basis.r[2] * dx];
      lintShiftAll(doc, delta, topIds);
      box = {
        min: [box.min[0] + delta[0], box.min[1] + delta[1], box.min[2] + delta[2]],
        max: [box.max[0] + delta[0], box.max[1] + delta[1], box.max[2] + delta[2]],
      };
      pushFix(fit.cx > 0 ? '主体偏右，横向挪回画幅中央' : '主体偏左，横向挪回画幅中央');
      changed = true;
    }
  }
  if (Math.abs(fit.cy) > LINT_CENTER_TOL) {
    if (lintCamLocked(doc, cam)) {
      pushWarn('主体在画幅里偏高或偏低，机位带轨道或跟着节点，没有自动平移');
    } else {
      const basis = lintBasisOf(cam);
      if (basis) {
        const dy = fit.cy * fit.depth * fit.tan;
        cam.pos = [
          round3(basis.pos[0] + basis.u[0] * dy),
          round3(basis.pos[1] + basis.u[1] * dy),
          round3(basis.pos[2] + basis.u[2] * dy),
        ];
        cam.target = [
          round3(lintNum(cam.target[0]) + basis.u[0] * dy),
          round3(lintNum(cam.target[1]) + basis.u[1] * dy),
          round3(lintNum(cam.target[2]) + basis.u[2] * dy),
        ];
        pushFix(fit.cy > 0 ? '机位抬高，主体回到画幅中央' : '机位压低，主体回到画幅中央');
        changed = true;
      }
    }
  }
  if (!changed) return;
  fit = lintFitOf(box, cam, aspect);
  if (fit && !fit.behind && fit.ext > LINT_FRAME_MARGIN + 0.01) {
    pushWarn('主体仍有一部分在画幅外');
  }
}

/* ---------- 入口 ---------- */

/* 量一棵零件树的世界包围盒（与体检 / 渲染同一把尺子）。没有能量尺寸的零件时回 null
   （导入的摆件外观未知，不算）。AI 自查构图那条工具就靠这一份，别处不要另写量法。 */
export function boundsOfScene(doc) {
  const { leaves } = lintCollect(doc || {});
  const box = lintBoxOfLeaves(leaves);
  return lintIsEmpty(box) ? null : box;
}

/* 返回 { doc, fixes, warnings, changed }。doc 是新对象，入参一个字节都不动。
   fixes 是「我改了什么」的人话（会并进 AI 的 say 与下一轮提示词），warnings 只提醒不改。 */
export function lintDoc(doc, opts = {}) {
  const work = cloneDoc(doc);
  const fixes = [];
  const warnings = [];
  const seenFixes = new Set();
  const seenWarns = new Set();
  const pushFix = msg => {
    if (!msg || seenFixes.has(msg)) return;
    seenFixes.add(msg);
    fixes.push(msg);
  };
  const pushWarn = msg => {
    if (!msg || seenWarns.has(msg)) return;
    seenWarns.add(msg);
    warnings.push(msg);
  };
  if (!work || typeof work !== 'object' || !work.scene || typeof work.scene !== 'object') {
    return { doc: work, fixes, warnings, changed: false };
  }
  if (!Array.isArray(work.scene.nodes)) work.scene.nodes = [];

  for (let pass = 0; pass < LINT_PASS_MAX; pass += 1) {
    const { leaves, parentMatById } = lintCollect(work);
    if (!leaves.length) break;
    const moves = lintUnits(work, leaves).filter(u => u.gap > LINT_EPS && u.gap < Infinity);
    if (!moves.length) break;
    let moved = 0;
    for (const unit of moves) {
      if (lintApplyMove(parentMatById, unit)) moved += 1;
    }
    if (!moved) break;
    for (const unit of moves) {
      pushFix(`把「${lintNameOf(unit.node)}」落到${unit.on ? `「${unit.on}」上` : '地面'}`);
    }
  }

  let leaves = lintCollect(work).leaves;
  let box = lintBoxOfLeaves(leaves);
  if (!lintIsEmpty(box)) {
    const h = box.max[1] - box.min[1];
    let factor = 1;
    if (h > LINT_MAX_H + 0.005) factor = LINT_MAX_H / h;
    else if (h < LINT_MIN_H - 0.005) factor = LINT_MIN_H / h;
    if (factor !== 1 && h > 1e-6) {
      const pivot = [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2];
      const topIds = new Set(work.scene.nodes.map(n => n && n.id).filter(Boolean));
      lintScaleAll(work, factor, pivot, topIds);
      pushFix(`整体高度 ${lintNumText(h)} 米不在 0.5–4 米内，等比${factor < 1 ? '缩' : '放'}到 ${lintNumText(h * factor)} 米`);
      leaves = lintCollect(work).leaves;
      box = lintBoxOfLeaves(leaves);
    }
  }

  if (!lintIsEmpty(box)) {
    const topIds = new Set(work.scene.nodes.map(n => n && n.id).filter(Boolean));
    const aspect = lintAspectOf(opts.aspect != null ? opts.aspect : (work.scene.view && work.scene.view.aspect));
    lintFrameFix(work, box, aspect, topIds, pushFix, pushWarn);
  }

  leaves = lintCollect(work).leaves;
  const bigById = new Map();
  for (const leaf of leaves) {
    if (leaf.kind === 'crowd') continue;
    const cur = bigById.get(leaf.id);
    if (!cur) {
      bigById.set(leaf.id, {
        name: leaf.name,
        box: { min: leaf.box.min.slice(), max: leaf.box.max.slice() },
      });
    } else {
      lintUnionInto(cur.box, leaf.box);
    }
  }
  for (const [, item] of bigById) {
    const dim = Math.max(
      item.box.max[0] - item.box.min[0],
      item.box.max[1] - item.box.min[1],
      item.box.max[2] - item.box.min[2],
    );
    if (dim > LINT_PART_MAX + 0.005) {
      pushWarn(`「${item.name}」单件约 ${lintNumText(dim)} 米，明显超出常见尺度`);
    }
  }
  for (const leaf of leaves) {
    const gap = lintGapOf(leaf, leaves).gap;
    if (gap > LINT_FLOAT_WARN) {
      pushWarn(`「${leaf.name}」离支撑面还有 ${lintNumText(gap)} 米，没有自动下落`);
    }
  }

  return { doc: work, fixes, warnings, changed: fixes.length > 0 };
}
