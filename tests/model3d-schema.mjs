#!/usr/bin/env node
/* 白膜模型文件（schema.js）的归一化与兜底：坏节点只丢自己、数值夹取、上限收口。
   全部纯函数，不开浏览器。 */
import assert from 'node:assert/strict';
import {
  normalizeDoc, emptyDoc, countNodes, findNode, removeNode, digest, docIdOf,
  LIMITS, scaleOf, vec3,
} from '../web/model3d/schema.js';

let n = 0;
const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };

/* ---------- 空文档 ---------- */
{
  const d = emptyDoc('猫', '道具');
  ok(d.v === 1, '空文档版本是 1');
  ok(d.name === '猫' && d.group === '道具', '名字与组写进去');
  ok(Array.isArray(d.scene.nodes) && d.scene.nodes.length === 0, '空文档没有零件');
  ok(d.scene.camera.fov >= 10 && d.scene.camera.fov <= 120, '默认机位 FOV 在区间内');
  ok(d.scene.view.aspect === '16:9' && d.scene.view.mode === 'director', '默认画幅与视角');
  ok(docIdOf(d) === '道具/猫', '身份是「组/名」');
}

/* ---------- 坏节点只丢自己 ---------- */
{
  const raw = {
    name: '混合',
    scene: {
      nodes: [
        { kind: 'prim', id: 'a', shape: 'box', size: [1, 2, 3] },
        { kind: 'prim', id: 'b' },                              // 没有 shape：丢
        { kind: 'nope', id: 'c' },                              // 不认识的 kind：丢
        { kind: 'prim', id: 'd', shape: 'loft', rings: [{ y: 0, rx: 1 }] }, // 环不够：丢
        { kind: 'mannequin', id: 'e', body: 'female', pose: 'run' },
        { kind: 'crowd', id: 'f', rows: 99, cols: 99 },          // 会被夹到 400 人上限
        { kind: 'asset', id: 'g', file: '../偷偷跑出去.fbx' },     // 越界路径：丢
        { kind: 'ref', id: 'h', model: '角色/素体' },
        null,
      ],
    },
  };
  const { doc, dropped } = normalizeDoc(raw);
  /* 留下来的应是 a / e / f / h 四个；被丢的五个：没有 shape、不认识的 kind、环数不够的放样、
     越界路径的摆件、以及一个 null。 */
  ok(doc.scene.nodes.length === 4, '坏节点被丢掉了（剩 4 个）实际 ' + doc.scene.nodes.length);
  ok(dropped.bad === 5, '丢掉的个数记下来了：' + dropped.bad);
  ok(findNode(doc.scene.nodes, 'a').size[2] === 3, '好节点原样留下');
  const crowd = findNode(doc.scene.nodes, 'f');
  ok(crowd.rows * crowd.cols <= 400, '群众被夹到 400 人以内：' + crowd.rows + '×' + crowd.cols);
  ok(findNode(doc.scene.nodes, 'g') === null, '越界的 asset 路径被拒绝');
  ok(findNode(doc.scene.nodes, 'h').model === '角色/素体', 'ref 保留');
}

/* ---------- 数值夹取 ---------- */
{
  ok(JSON.stringify(vec3(['1.23456', 2, null], [0, 0, 0])) === '[1.235,2,0]', '坐标取 3 位小数');
  ok(JSON.stringify(vec3(['x', 1e9, -1e9], [0, 0, 0])) === '[0,10000,-10000]', '坐标夹到 ±1e4');
  ok(scaleOf(0)[0] === 0.01, '缩放 0 被夹到 0.01');
  ok(scaleOf([2, 3, 4]).join(',') === '2,3,4', '三元组缩放原样');
  const { doc } = normalizeDoc({ scene: { nodes: [{ kind: 'prim', shape: 'sphere', r: -5, at: [1, 1, 1] }], camera: { fov: 999 } } });
  ok(doc.scene.nodes[0].r > 0, '球半径被夹成正数');
  ok(doc.scene.camera.fov === 120, 'FOV 夹到 120');
}

/* ---------- 节点上限与深度 ---------- */
{
  const many = [];
  for (let i = 0; i < LIMITS.nodes + 30; i++) many.push({ kind: 'prim', id: 'p' + i, shape: 'box', size: [1, 1, 1] });
  const { doc, dropped } = normalizeDoc({ scene: { nodes: many } });
  ok(doc.scene.nodes.length === LIMITS.nodes, '节点数收到上限 ' + LIMITS.nodes);
  ok(dropped.extra === 30, '多出来的记成 extra：' + dropped.extra);

  /* 深度超过 8 层：第 9 层的子节点不再收 */
  let deep = { kind: 'group', id: 'g8', children: [] };
  for (let i = 7; i >= 0; i--) deep = { kind: 'group', id: 'g' + i, children: [deep] };
  const r2 = normalizeDoc({ scene: { nodes: [deep] } });
  ok(countNodes(r2.doc) <= 8, '嵌套深度被夹住，实际 ' + countNodes(r2.doc) + ' 个节点');
}

/* ---------- 动画轨道：引用了不存在的节点就丢 ---------- */
{
  const { doc, dropped } = normalizeDoc({
    scene: { nodes: [{ kind: 'mannequin', id: 'm1', body: 'mannequin', pose: 'walk' }] },
    anim: {
      duration: 3, fps: 30,
      tracks: [
        { nodeId: 'm1', motion: 'walk', path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } },
        { nodeId: 'ghost', keys: [{ t: 0, at: [0, 0, 0] }] },
      ],
    },
  });
  ok(doc.anim.tracks.length === 1, '引用了不存在节点的轨道被丢掉');
  ok(doc.anim.tracks[0].path.kind === 'line', '保留的轨道带着路径');
  ok(dropped.anim === 1, '丢掉的轨道计数');
}

/* ---------- 摆件的 clip 四格：缺省 = 静态摆件，数值夹取 ---------- */
{
  const { doc } = normalizeDoc({ scene: { nodes: [
    { kind: 'asset', id: 'a', file: '_模型文件/长凳.fbx' },
    { kind: 'asset', id: 'b', file: '_模型文件/人.fbx', clip: ' 走路 ', clipSpeed: 9, clipLoop: 'pingpong', clipOffset: -3 },
  ] } });
  const a = findNode(doc.scene.nodes, 'a');
  ok(a.clip === '' && a.clipSpeed === 1 && a.clipLoop === 'loop' && a.clipOffset === 0,
    '没给 clip 时四格都是默认值（行为与加字段之前一致）');
  const b = findNode(doc.scene.nodes, 'b');
  ok(b.clip === '走路', 'clip 名归一（去空白）：' + b.clip);
  ok(b.clipSpeed === 4, '速度夹到 4：' + b.clipSpeed);
  ok(b.clipLoop === 'loop', '不认识的循环档回到 loop');
  ok(b.clipOffset === 0, '负偏移夹到 0');
  const long = normalizeDoc({ scene: { nodes: [
    { kind: 'asset', file: '_模型文件/x.fbx', clip: 'x'.repeat(80), clipSpeed: 0.01, clipOffset: 999 },
  ] } }).doc.scene.nodes[0];
  ok(long.clip.length === 40, 'clip 名截到 40 字');
  ok(long.clipSpeed === 0.1, '速度下限 0.1');
  ok(long.clipOffset === 60, '偏移上限 60');
}

/* ---------- 子关节轨道：路径归一，超过 6 段整条丢 ---------- */
{
  const { doc, dropped } = normalizeDoc({
    scene: { nodes: [{ kind: 'mannequin', id: 'm1' }] },
    anim: {
      duration: 4,
      tracks: [
        { nodeId: 'm1', joint: ' torso / / leftShoulder / leftElbow ', motion: 'walk', keys: [{ t: 0, rot: [0, 0, 0] }] },
        { nodeId: 'm1', joint: 'a/b/c/d/e/f/g', keys: [{ t: 0, rot: [0, 0, 0] }] },
      ],
    },
  });
  ok(doc.anim.tracks.length === 1, '超过 6 段的关节路径整条丢掉');
  ok(dropped.anim === 1, '丢掉的关节轨道计数：' + dropped.anim);
  ok(doc.anim.tracks[0].joint === 'torso/leftShoulder/leftElbow', '关节路径去掉空白与空段：' + doc.anim.tracks[0].joint);
  ok(doc.anim.tracks[0].motion === 'walk', '轨道上的 motion 原样保留（是否生效由采样层判）');
}

/* ---------- 树操作 ---------- */
{
  const { doc } = normalizeDoc({ scene: { nodes: [{ kind: 'group', id: 'g', children: [{ kind: 'prim', id: 'c', shape: 'box', size: [1, 1, 1] }] }] } });
  ok(countNodes(doc) === 2, '两级节点都数得到');
  ok(removeNode(doc.scene.nodes, 'c') === true, '删子节点成功');
  ok(countNodes(doc) === 1, '删完只剩父节点');
  ok(removeNode(doc.scene.nodes, 'nope') === false, '删不存在的返回 false');
  ok(digest(doc) === digest(JSON.parse(JSON.stringify(doc))), 'digest 对相同内容稳定');
}

console.log('✓ model3d-schema：' + n + ' 项通过');
