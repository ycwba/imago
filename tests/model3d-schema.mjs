#!/usr/bin/env node
/* 白膜模型文件（schema.js）的归一化与兜底：坏节点只丢自己、数值只保留数学有效性、
   数量 / 规模不设人为上限；v1 旧字段一次性迁移到 v2；AI ops 在克隆上应用。
   全部纯函数，不开浏览器。 */
import assert from 'node:assert/strict';
import {
  normalizeDoc, emptyDoc, emptyScene, countNodes, findNode, removeNode, digest, docIdOf,
  scaleOf, vec3, applyDocOps, trackEndOf, camOf,
} from '../web/model3d/schema.js';

let n = 0;
const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };

/* ---------- 空文档 ---------- */
{
  const d = emptyDoc('猫', '道具');
  ok(d.v === 3 && d.kind === 'model', '空模型版本 3 / kind=model');
  ok(d.name === '猫' && d.group === '道具', '名字与组写进去');
  const sc = emptyScene('街景', '第一幕');
  ok(sc.kind === 'scene' && sc.name === '街景' && sc.group === '第一幕', '空场景 kind/name/group');
  ok(Array.isArray(d.scene.nodes) && d.scene.nodes.length === 0, '空文档没有零件');
  ok(d.scene.cams.length === 1 && d.scene.active === d.scene.cams[0].id, '空文档有一个默认机位');
  ok(d.scene.cams[0].fov > 0 && d.scene.cams[0].fov < 180, '默认机位 FOV 在数学区间内');
  ok(d.scene.view.aspect === '16:9' && d.scene.view.mode === 'director', '默认画幅与视角');
  ok(d.anim.loop === true && Array.isArray(d.anim.tracks), '默认循环、空轨道');
  ok(Array.isArray(d.out) && !d.out.length, '出片条默认是空数组');
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
        { kind: 'crowd', id: 'f', rows: 99, cols: 99 },
        { kind: 'asset', id: 'g', file: '../偷偷跑出去.fbx' },     // 越界路径：丢
        { kind: 'ref', id: 'h', model: '角色/素体' },
        null,
      ],
    },
  };
  const { doc, dropped } = normalizeDoc(raw);
  ok(doc.scene.nodes.length === 4, '坏节点被丢掉（剩 4 个）实际 ' + doc.scene.nodes.length);
  ok(dropped.bad === 5, '丢掉的个数记下来了：' + dropped.bad);
  ok(findNode(doc.scene.nodes, 'a').size[2] === 3, '好节点原样留下');
  const crowd = findNode(doc.scene.nodes, 'f');
  ok(crowd.rows === 99 && crowd.cols === 99 && crowd.rows * crowd.cols === 9801, '群众人数不截断：' + crowd.rows + '×' + crowd.cols);
  ok(findNode(doc.scene.nodes, 'g') === null, '越界的 asset 路径被拒绝');
  ok(findNode(doc.scene.nodes, 'h').model === '角色/素体', 'ref 保留');
  const from = normalizeDoc({ scene: { nodes: [{ kind: 'group', id: 'e', fromModel: '角色/少女', children: [] }] } }).doc;
  ok(findNode(from.scene.nodes, 'e').fromModel === '角色/少女', '实体保留来源模型');
  const colored = normalizeDoc({ scene: { nodes: [
    { kind: 'prim', id: 'c1', shape: 'box', color: '#FF0000' },
    { kind: 'prim', id: 'c2', shape: 'box', color: 'red' },
  ] } }).doc;
  ok(findNode(colored.scene.nodes, 'c1').color === '#ff0000', '合法颜色归一成小写');
  ok(findNode(colored.scene.nodes, 'c2').color === undefined, '非法颜色丢掉（退回白模）');
}

/* ---------- 数值只保留有效性 ---------- */
{
  ok(JSON.stringify(vec3(['1.23456', 2, null], [0, 0, 0])) === '[1.235,2,0]', '坐标取 3 位小数');
  ok(JSON.stringify(vec3(['x', 1e9, -1e9], [0, 0, 0])) === '[0,1000000000,-1000000000]', '坐标不夹到 ±1e4');
  ok(scaleOf(0)[0] === 1, '缩放 0 换成 1');
  ok(scaleOf([2, 3, 4]).join(',') === '2,3,4', '三元组缩放原样');
  ok(scaleOf([-2, 3, 4])[0] === -2, '负数缩放保留（镜像写法）');
  const { doc } = normalizeDoc({ scene: { nodes: [{ kind: 'prim', shape: 'sphere', r: -5, at: [1, 1, 1] }], cams: [{ id: 'c', fov: 999 }] } });
  ok(doc.scene.nodes[0].r > 0, '球半径被夹成正数');
  ok(doc.scene.cams[0].fov === 35, '非法 FOV 回到默认 35');
  const { doc: d2 } = normalizeDoc({ scene: { cams: [{ id: 'c', fov: 179 }] } });
  ok(d2.scene.cams[0].fov === 179, 'FOV 179 原样保留');
}

/* ---------- 数量与规模不设上限 ---------- */
{
  const many = [];
  for (let i = 0; i < 500; i++) many.push({ kind: 'prim', id: 'p' + i, shape: 'box', size: [1, 1, 1] });
  const { doc, dropped } = normalizeDoc({ scene: { nodes: many } });
  ok(doc.scene.nodes.length === 500, '500 个节点全保留：' + doc.scene.nodes.length);
  ok(dropped.extra === 0, '没有 extra 截断');

  let deep = { kind: 'group', id: 'g11', children: [] };
  for (let i = 10; i >= 0; i--) deep = { kind: 'group', id: 'g' + i, children: [deep] };
  const r2 = normalizeDoc({ scene: { nodes: [deep] } });
  ok(countNodes(r2.doc) === 12, '12 层深树全保留，实际 ' + countNodes(r2.doc));

  const wide = { kind: 'group', id: 'wide', children: [] };
  for (let i = 0; i < 100; i++) wide.children.push({ kind: 'prim', id: 'w' + i, shape: 'box' });
  const r3 = normalizeDoc({ scene: { nodes: [wide] } });
  ok(findNode(r3.doc.scene.nodes, 'wide').children.length === 100, '100 个子节点全保留');

  const { doc: d4 } = normalizeDoc({ scene: { nodes: [
    {
      kind: 'prim', id: 'loft', shape: 'loft', seg: 200,
      rings: Array.from({ length: 100 }, (_, i) => ({ y: i, rx: 1, rz: 1 })),
    },
    {
      kind: 'prim', id: 'lathe', shape: 'lathe', seg: 200,
      profile: Array.from({ length: 100 }, (_, i) => [1, i]),
    },
    {
      kind: 'prim', id: 'extrude', shape: 'extrude', depth: 100,
      poly: Array.from({ length: 200 }, (_, i) => [i, 0]),
    },
    { kind: 'prim', id: 'rep', shape: 'box', repeat: { n: 100, dx: 0.1 } },
    { kind: 'crowd', id: 'cr', rows: 100, cols: 100 },
    { kind: 'asset', id: 'as', file: '_模型文件/x.fbx', clip: 'x'.repeat(200), clipSpeed: 99, clipOffset: 999 },
  ] } });
  ok(d4.scene.nodes.find(x => x.id === 'loft').rings.length === 100 && d4.scene.nodes.find(x => x.id === 'loft').seg === 200, '放样 100 环 / seg 200 保留');
  ok(d4.scene.nodes.find(x => x.id === 'lathe').profile.length === 100, '旋转体 100 个轮廓点保留');
  ok(d4.scene.nodes.find(x => x.id === 'extrude').poly.length === 200, '拉伸 200 个多边形点保留');
  ok(d4.scene.nodes.find(x => x.id === 'rep').repeat.n === 100, '阵列 100 份保留');
  ok(d4.scene.nodes.find(x => x.id === 'cr').rows * d4.scene.nodes.find(x => x.id === 'cr').cols === 10000, '群众 10000 人不截断');
  const asset = d4.scene.nodes.find(x => x.id === 'as');
  ok(asset.clip.length === 200 && asset.clipSpeed === 99 && asset.clipOffset === 999, '摆件动画参数不设上限');
}

/* ---------- v1 迁移：camera / nodeId ---------- */
{
  const { doc } = normalizeDoc({
    scene: {
      nodes: [{ kind: 'mannequin', id: 'm1', body: 'mannequin', pose: 'walk' }],
      camera: { pos: [3, 2, 4], target: [0, 1, 0], fov: 40 },
    },
    anim: { duration: 3, fps: 30, tracks: [{ nodeId: 'm1', motion: 'walk', path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } }] },
  });
  ok(doc.scene.cams.length === 1 && doc.scene.cams[0].fov === 40, '旧 camera 迁成 cams');
  ok(doc.scene.active === doc.scene.cams[0].id, 'active 指向迁移后的机位');
  ok(!('camera' in doc.scene), '运行期没有 scene.camera');
  ok(doc.anim.tracks.length === 1 && doc.anim.tracks[0].of.kind === 'node' && doc.anim.tracks[0].of.id === 'm1', '旧 nodeId 迁成 of');
}

/* ---------- 轨道：节点 / 机位 / 关键帧 / 自由路径 ---------- */
{
  const { doc, dropped } = normalizeDoc({
    scene: {
      nodes: [{ kind: 'mannequin', id: 'm1' }],
      cams: [{ id: 'c1', name: '机位', pos: [1, 2, 3] }],
      active: 'c1',
    },
    anim: {
      duration: 600, fps: 240, loop: false,
      tracks: [
        { id: 't1', of: { kind: 'node', id: 'm1' }, joint: 'a/b/c/d/e/f/g', interp: 'linear', keys: Array.from({ length: 200 }, (_, i) => ({ t: i, at: [i, 0, 0] })) },
        { id: 't2', of: { kind: 'cam', id: 'c1' }, keys: [{ t: 0, target: [0, 0, 0], fov: 30 }, { t: 2, target: [1, 0, 0], fov: 60 }], path: { kind: 'free', pts: [[0, 0, 0], [1, 0, 1], [2, 0, 0]], closed: true } },
        { id: 't3', of: { kind: 'node', id: 'ghost' }, keys: [{ t: 0, at: [0, 0, 0] }] },
      ],
    },
  });
  ok(doc.anim.duration === 600 && doc.anim.fps === 240, '动画时长 / fps 不设上限');
  ok(doc.anim.tracks.length === 2 && dropped.anim === 1, '坏轨道丢掉并计数');
  const t1 = doc.anim.tracks.find(t => t.id === 't1');
  ok(t1.keys.length === 200 && t1.joint === 'a/b/c/d/e/f/g', '200 个关键帧 / 7 段关节路径全保留');
  const t2 = doc.anim.tracks.find(t => t.id === 't2');
  ok(t2.path.kind === 'free' && t2.path.pts.length === 3 && t2.path.closed === true, '自由路径保留');
  ok(t2.keys[1].target[0] === 1 && t2.keys[1].fov === 60, '机位 target / fov 关键帧保留');
  ok(trackEndOf(doc.anim) === 199, '轨道末尾按最后一个关键帧算：' + trackEndOf(doc.anim));
}

/* ---------- 出片条 ---------- */
{
  const out = Array.from({ length: 100 }, (_, i) => ({ id: 'o' + i, assetId: 'la_' + i, url: '/asset/la_' + i, type: i % 2 ? 'video' : 'image', name: 'n' + i, at: i }));
  const { doc } = normalizeDoc({ out });
  ok(doc.out.length === 100, '100 条出片全保留');
  ok(doc.out[1].type === 'video', '类型保留');
}

/* ---------- applyOps ---------- */
{
  const base = normalizeDoc({ scene: {
    nodes: [
      { kind: 'group', id: 'g1', name: '组', children: [{ kind: 'prim', id: 'p1', shape: 'box', size: [1, 1, 1] }] },
      { kind: 'prim', id: 'p2', shape: 'sphere', r: 1 },
    ],
    cams: [{ id: 'c1', name: '机位 1', pos: [3, 2, 4] }],
    active: 'c1',
  }, anim: { tracks: [{ id: 't1', of: { kind: 'node', id: 'p2' }, keys: [{ t: 0, at: [0, 0, 0] }] }] } }).doc;

  const r = applyDocOps(base, [
    { op: 'update', id: 'p1', set: { at: [1, 2, 3] } },
    { op: 'add', parent: 'g1', node: { kind: 'prim', id: 'p3', shape: 'box' } },
    { op: 'move', id: 'p3', parent: null, index: 0 },
    { op: 'group', ids: ['p2'], name: '新组' },
    { op: 'cam', add: { id: 'c2', name: '机位 2', pos: [0, 2, 5] } },
    { op: 'cam', id: 'c2', set: { fov: 50 } },
    { op: 'track', add: { id: 't2', of: { kind: 'cam', id: 'c2' }, keys: [{ t: 0, target: [0, 1, 0] }] } },
    { op: 'track', id: 't2', set: { interp: 'hold' } },
    { op: 'anim', set: { duration: 10, fps: 60, loop: false } },
    { op: 'remove', id: 'p3' },
    { op: 'update', id: '没有这个', set: { at: [0, 0, 0] } },
  ]);
  ok(r.applied === 10 && r.skipped === 1, '10 条成功、1 条失败：' + r.applied + '/' + r.skipped);
  ok(findNode(r.doc.scene.nodes, 'p1').at[0] === 1, 'update 生效');
  ok(r.doc.scene.cams.length === 2 && camOf(r.doc, 'c2').fov === 50, 'cam add / set 生效');
  ok(r.doc.anim.tracks.find(t => t.id === 't2').interp === 'hold', 'track set 生效');
  ok(r.doc.anim.duration === 10 && r.doc.anim.loop === false, 'anim set 生效');
  ok(findNode(r.doc.scene.nodes, 'p3') === null, 'remove 生效');

  const un = applyDocOps(r.doc, [{ op: 'ungroup', id: 'g1' }]);
  ok(un.applied === 1 && findNode(un.doc.scene.nodes, 'p1') !== null, 'ungroup 把子节点提升出来');
  ok(findNode(un.doc.scene.nodes, 'g1') === null, 'ungroup 后组不在了');

  const scene = normalizeDoc({ kind: 'scene', scene: { nodes: [
    { kind: 'group', id: 'e1', children: [{ kind: 'prim', id: 'c1', shape: 'box' }] },
    { kind: 'group', id: 'e2', children: [{ kind: 'prim', id: 'c2', shape: 'box' }] },
  ] } }).doc;
  const scoped = applyDocOps(scene, [
    { op: 'update', id: 'c1', set: { at: [1, 0, 0] } },
    { op: 'remove', id: 'c2' },
  ], { scope: new Set(['e1', 'c1']) });
  ok(scoped.applied === 1 && scoped.skipped === 1, 'scope 内成功、scope 外跳过');
  ok(findNode(scoped.doc.scene.nodes, 'c1').at[0] === 1, 'scope 内节点可改');
  ok(findNode(scoped.doc.scene.nodes, 'c2') !== null, 'scope 外实体不会被删');
  const timed = applyDocOps(scene, [
    { op: 'anim', set: { duration: 8, fps: 30 } },
    { op: 'track', add: { of: { kind: 'node', id: 'c1' }, keys: [{ t: 0, at: [0, 0, 0] }] } },
    { op: 'track', add: { of: { kind: 'node', id: 'c2' }, keys: [] } },
  ], { scope: new Set(['e1', 'c1']) });
  ok(timed.applied === 2 && timed.skipped === 1, 'scope 内可改时间轴与自己的轨道，scope 外轨道跳过');
  ok(timed.doc.anim.duration === 8 && timed.doc.anim.fps === 30, 'anim op 不受实体 scope 限制');
  ok((timed.doc.anim.tracks || []).length === 1, '只加进选中实体自己的轨道');
}

/* ---------- 树工具 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'group', id: 'g1', children: [{ kind: 'prim', id: 'p1', shape: 'box', size: [1, 1, 1] }] },
  ] } }).doc;
  ok(findNode(doc.scene.nodes, 'p1') !== null, '子节点找得到');
  ok(removeNode(doc.scene.nodes, 'p1') === true && findNode(doc.scene.nodes, 'p1') === null, '删得掉');
  ok(removeNode(doc.scene.nodes, '没有这个') === false, '删不存在的返回 false');
  ok(digest(doc) === JSON.stringify(doc), 'digest 是 JSON');
}

console.log('✓ model3d-schema：' + n + ' 项通过');
