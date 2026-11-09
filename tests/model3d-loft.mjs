#!/usr/bin/env node
/* loft 的两条增强：环间 Catmull-Rom 细分（subdiv）与沿路径扫掠（path + profile）。
   ① 不写 subdiv 时与旧版逐字节同构（顶点数 = (环-1)×4+1 圈 × (seg+1) 列 + 2 个封口中心）；
   ② subdiv 只加密、不改变轮廓（包围盒一致）；
   ③ path + profile 不写 rings 也能过 Schema / 归一化 / 稀疏往返；
   ④ 沿直线扫掠出的形体：高度 = 路径长度、横向不超过最大半径；
   ⑤ 沿 X 向扫掠的截面垂直于路径（竖向摆放，而不是横着摊）；
   ⑥ 体检包围盒认 path 模式（不会当它没有体积）。 */
import assert from 'node:assert/strict';
import { normalizeDoc, sparseDoc } from '../web/model3d/schema.js';
import { buildContent } from '../web/model3d/scene.js';
import { boundsOfScene } from '../web/model3d/lint.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const docOf = raw => normalizeDoc({ scene: { nodes: raw } }).doc;
const geomOf = doc => {
  const content = buildContent(doc, { outline: false });
  let geo = null;
  content.group.traverse(o => { if (o.isMesh && !geo && o.geometry.attributes.position) geo = o.geometry; });
  return geo;
};
const geoBoxOf = doc => {
  const a = geomOf(doc).attributes.position;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < a.count; i++) {
    const p = [a.getX(i), a.getY(i), a.getZ(i)];
    for (let k = 0; k < 3; k++) {
      if (p[k] < box.min[k]) box.min[k] = p[k];
      if (p[k] > box.max[k]) box.max[k] = p[k];
    }
  }
  return box;
};

const RINGS = [{ y: 0, rx: 0.5, rz: 0.5 }, { y: 1, rx: 0.2, rz: 0.2 }, { y: 2, rx: 0.3, rz: 0.3 }];
const seg = 12;
const ringDoc = extra => docOf([Object.assign({ kind: 'prim', id: 'p', shape: 'loft', rings: RINGS, seg }, extra || {})]);

/* ---- ① 默认（不写 subdiv）：与旧版同构的顶点数 ---- */
{
  const g = geomOf(ringDoc());
  const steps = (RINGS.length - 1) * 4 + 1;
  ok(g.attributes.position.count === steps * (seg + 1) + 2,
    '默认每两环 4 段 + 两端封口：' + g.attributes.position.count);
  const b = boundsOfScene(ringDoc());
  ok(close(b.min[1], 0) && close(b.max[1], 2), '高度照旧 0~2');
  ok(close(b.max[0], 0.5), '最宽处照旧 0.5');
}

/* ---- ② subdiv 只加密：包围盒一致、顶点更多 ---- */
{
  const base = geomOf(ringDoc());
  const fine = geomOf(ringDoc({ subdiv: 8 }));
  const steps = (RINGS.length - 1) * 8 + 1;
  ok(fine.attributes.position.count === steps * (seg + 1) + 2, 'subdiv=8 的段数对上：' + fine.attributes.position.count);
  ok(fine.attributes.position.count > base.attributes.position.count, '细分之后顶点更多');
  const a = boundsOfScene(ringDoc());
  const c = boundsOfScene(ringDoc({ subdiv: 8 }));
  ok(close(a.min[0], c.min[0], 0.02) && close(a.max[0], c.max[0], 0.02)
    && close(a.min[1], c.min[1]) && close(a.max[1], c.max[1]), '轮廓走向一致（包围盒不漂）');
  const sp = sparseDoc(ringDoc({ subdiv: 8 })).scene.nodes[0];
  ok(sp.subdiv === 8 && !sp.path, 'subdiv 落盘');
  const back = normalizeDoc({ scene: { nodes: [sp] } }).doc.scene.nodes[0];
  ok(back.subdiv === 8 && back.rings.length === RINGS.length, '稀疏往返一致');
}

/* ---- ③ 沿路径扫掠：不写 rings 也能过归一化 ---- */
{
  const doc = docOf([{ kind: 'prim', id: 'p', shape: 'loft',
    path: { kind: 'line', from: [0, 0, 0], to: [0, 2, 0] },
    profile: [[0.2, 0], [0.12, 1], [0.16, 2]], seg }]);
  const node = doc.scene.nodes[0];
  ok(node, 'path + profile 的 loft 没有被丢掉');
  ok(node.rings === undefined && node.path.kind === 'line' && node.profile.length === 3, '存的是路径 + 半径曲线');
  ok(node.path.to.join(',') === '0,2,0', '路径照收');
  const sp = sparseDoc(doc).scene.nodes[0];
  ok(sp.path && sp.path.to.join(',') === '0,2,0' && sp.profile && sp.profile.length === 3 && !sp.rings,
    '稀疏写 path + profile：' + JSON.stringify(sp));
  const back = normalizeDoc({ scene: { nodes: [sp] } }).doc.scene.nodes[0];
  ok(back.path.kind === 'line' && back.path.to.join(',') === '0,2,0' && back.profile[1][0] === 0.12, '读回来一致');
}

/* 只给 path 不给 profile（也没有 rings）：照实丢件并说清 ------- */
{
  const out = normalizeDoc({ scene: { nodes: [{ kind: 'prim', id: 'p', shape: 'loft', path: { kind: 'line' } }] } });
  ok(out.doc.scene.nodes.length === 0 && out.dropped.bad === 1, '缺料时丢这一件');
  ok(out.dropped.details[0].why.includes('path + profile'), '说明扫掠要 path + profile：' + out.dropped.details[0].why);
}

/* ---- ④ 竖直线扫掠：高度 = 2，横向不超过最大半径 0.2 ---- */
{
  const doc = docOf([{ kind: 'prim', id: 'p', shape: 'loft',
    path: { kind: 'line', from: [0, 0, 0], to: [0, 2, 0] },
    profile: [[0.2, 0], [0.12, 1], [0.16, 2]], seg }]);
  const g = geomOf(doc);
  ok(g.attributes.position.count > 0, '扫掠几何建出来了');
  const b = geoBoxOf(doc);
  ok(close(b.min[1], 0, 1e-4) && close(b.max[1], 2, 1e-4), '高度等于路径长度：' + b.min[1] + '~' + b.max[1]);
  ok(b.max[0] - b.min[0] <= 0.41 && b.max[2] - b.min[2] <= 0.41, '横向不超过直径：' + (b.max[0] - b.min[0]));
  const lb = boundsOfScene(doc);
  ok(lb.min[1] <= -0.1 && lb.max[1] >= 2, '体检包围盒按最大半径放宽（保守覆盖）');
}

/* ---- ⑤ 沿 X 向扫掠：截面垂直于路径（竖向圆环） ---- */
{
  const doc = docOf([{ kind: 'prim', id: 'p', shape: 'loft',
    path: { kind: 'line', from: [0, 1, 0], to: [2, 1, 0] },
    profile: [[0.3, 0], [0.3, 1]], seg }]);
  const b = geoBoxOf(doc);
  ok(close(b.min[0], 0, 1e-4) && close(b.max[0], 2, 1e-4), '沿 X 铺满 0~2：' + b.min[0] + '~' + b.max[0]);
  ok(close(b.max[1], 1.3, 1e-4) && close(b.min[1], 0.7, 1e-4), '截面竖向撑开 ±0.3：' + b.min[1] + '~' + b.max[1]);
  ok(close(b.max[2], 0.3, 1e-4) && close(b.min[2], -0.3, 1e-4), '另一向同样 ±0.3');
}

/* ---- ⑥ 圆形路径：半径方向也能量出来 ---- */
{
  const doc = docOf([{ kind: 'prim', id: 'p', shape: 'loft',
    path: { kind: 'circle', from: [0, 0, 0], radius: 1, clockwise: false },
    profile: [[0.1, 0], [0.1, 1]], seg }]);
  const b = geoBoxOf(doc);
  ok(b.max[0] >= 1 && b.min[0] <= -1, '圆路径在 X 向撑到 ±1：' + b.min[0] + '~' + b.max[0]);
  ok(close(b.max[1], 0.1, 1e-4) && close(b.min[1], -0.1, 1e-4), '圆环在 y 向只有管半径那么厚：' + b.min[1] + '~' + b.max[1]);
}

console.log('✓ model3d-loft：' + n + ' 项通过');
