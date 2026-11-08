#!/usr/bin/env node
/* 群众阵列：行列坐标、抖动有界且确定、400 人上限、合批之后的绘制对象数。
   纯布局 + three 场景（后者在 Node 里只建对象、不碰 WebGL）。 */
import assert from 'node:assert/strict';
import { crowdLayout, CROWD_LIMIT } from '../web/model3d/crowd.js';
import { buildContent, boundsOf } from '../web/model3d/scene.js';
import { normalizeDoc } from '../web/model3d/schema.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---------- 行列与居中 ---------- */
{
  const r = crowdLayout({ rows: 2, cols: 3, gapX: 1, gapZ: 1, at: [0, 0, 0] });
  ok(r.people.length === 6, '2×3 是 6 个人');
  ok(r.truncated === false, '没被截断');
  const xs = r.people.map(p => p.at[0]).sort((a, b) => a - b);
  ok(JSON.stringify(xs) === JSON.stringify([-1, -1, 0, 0, 1, 1]), '列以阵列原点居中：' + xs.join(','));
  const zs = [...new Set(r.people.map(p => p.at[2]))].sort((a, b) => a - b);
  ok(JSON.stringify(zs) === JSON.stringify([-0.5, 0.5]), '行沿 Z 等距：' + zs.join(','));
  ok(r.people.every(p => p.at[1] === 0), '默认不抬高');
}

/* ---------- 抖动：有界、确定、不同人不同 ---------- */
{
  const a = crowdLayout({ rows: 4, cols: 5, gapX: 1, gapZ: 1, jitter: 0.4 });
  const b = crowdLayout({ rows: 4, cols: 5, gapX: 1, gapZ: 1, jitter: 0.4 });
  ok(JSON.stringify(a) === JSON.stringify(b), '抖动是确定性的（流式重建不会让人群跳一下）');
  const base = crowdLayout({ rows: 4, cols: 5, gapX: 1, gapZ: 1, jitter: 0 });
  let maxOff = 0;
  for (let i = 0; i < a.people.length; i++) {
    maxOff = Math.max(maxOff, Math.abs(a.people[i].at[0] - base.people[i].at[0]));
    maxOff = Math.max(maxOff, Math.abs(a.people[i].at[2] - base.people[i].at[2]));
  }
  ok(maxOff <= 0.2 + 1e-9, '抖动幅度不超过 jitter/2：' + maxOff.toFixed(3));
  ok(new Set(a.people.map(p => p.at[0].toFixed(3))).size > 5, '每个人位置不同（不是整齐一条线）');
}

/* ---------- 上限 ---------- */
{
  const r = crowdLayout({ rows: 24, cols: 24, gapX: 1, gapZ: 1 });
  ok(r.total === CROWD_LIMIT, '24×24 收到 ' + CROWD_LIMIT + ' 人，实际 ' + r.total);
  ok(r.truncated === true, '截断被标出来');
  const { doc } = normalizeDoc({ scene: { nodes: [{ kind: 'crowd', rows: 24, cols: 24 }] } });
  ok(doc.scene.nodes[0].rows * doc.scene.nodes[0].cols <= 400, '归一化阶段就把人数收口');
}

/* ---------- 合批：一个群众节点只出两条 InstancedMesh（身体 + 细节） ---------- */
{
  const { doc } = normalizeDoc({
    scene: { nodes: [{ kind: 'crowd', id: 'c', rows: 3, cols: 4, gapX: 1, gapZ: 1, body: 'mannequin', pose: 'stand', tone: 'mid' }] },
  });
  const w = buildContent(doc, { outline: false });
  const wrap = w.group.children[0];
  const crowd = wrap.children[0];
  const inst = [];
  crowd.traverse(o => { if (o.isInstancedMesh) inst.push(o); });
  ok(inst.length === 2, '两条 InstancedMesh（身体 + 眼睛嘴），实际 ' + inst.length);
  ok(inst.every(i => i.count === 12), '每条画 12 个人');
  ok(w.tris > 12 * 100, '三角形数是「人 × 单人」量级：' + w.tris);
  const box = boundsOf(w);
  ok(Math.abs(box.min.y) < 0.02, '群众整体站在地上：min.y=' + box.min.y.toFixed(3));
  ok(box.max.x - box.min.x > 2, '横向铺开了：' + (box.max.x - box.min.x).toFixed(2) + ' 米');
}

/* ---------- 群众掉地：合批时落地偏移必须进矩阵 ---------- */
{
  const { doc } = normalizeDoc({ scene: { nodes: [{ kind: 'crowd', id: 'c', rows: 1, cols: 1, body: 'female', pose: 'stand' }] } });
  const box = boundsOf(buildContent(doc, { outline: false }));
  ok(Math.abs(box.min.y) < 0.02, '单人阵列也贴地：' + box.min.y.toFixed(3));
}

console.log('✓ model3d-crowd：' + n + ' 项通过');
