#!/usr/bin/env node
/* 写盘稀疏化（schema.js 的 sparseDoc）：只写非默认字段，读回一套 normalizeDoc 还原成同一份文档。
   与 model3d-schema.mjs 分开一份 —— 那边守运行期形状，这边守磁盘形状。全部纯函数，不开浏览器。 */
import assert from 'node:assert/strict';
import { normalizeDoc, sparseDoc, emptyDoc, findNode } from '../web/model3d/schema.js';

let n = 0;
const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };
const roundTrip = doc => normalizeDoc(sparseDoc(doc)).doc;
const bytesOf = v => Buffer.byteLength(JSON.stringify(v, null, 2));
const spOf = (doc, id) => findNode(sparseDoc(doc).scene.nodes, id);

/* 一份把每类节点 / 机位 / 轨道 / 出片 / 来源都填满的完整文档。 */
const full = normalizeDoc({
  kind: 'scene',
  name: '街角',
  group: '第一幕',
  note: '备注',
  ts: 1700000000000,
  scene: {
    nodes: [
      { kind: 'group', id: 'g1', name: '组', at: [1, 0, 0], children: [
        { kind: 'prim', id: 'p1', shape: 'box', size: [1, 2, 3], tone: 'lo', at: [0.5, 0.5, 0.5], rot: [0, 45, 0], scale: [2, 2, 2], color: '#AABBCC', repeat: { n: 3, dx: 1 } },
        { kind: 'prim', id: 'p2', shape: 'sphere', r: 2, seg: 48, mirror: true, visible: false, locked: true, fromModel: '角色/素体' },
      ] },
      { kind: 'prim', id: 'p3', shape: 'cylinder', r: 0.5, r2: 0.7, h: 2, tone: 'mid' },
      { kind: 'prim', id: 'p4', shape: 'cone', r: 0.4, h: 1.2 },
      { kind: 'prim', id: 'p5', shape: 'capsule', r: 0.2, h: 0.8 },
      { kind: 'prim', id: 'p6', shape: 'torus', r: 1, r2: 0.2 },
      { kind: 'prim', id: 'p7', shape: 'plate', size: [2, 0.1, 2] },
      { kind: 'prim', id: 'p8', shape: 'loft', seg: 32, rings: [{ y: 0, rx: 1, rz: 1, cx: 0.1 }, { y: 1, rx: 0.5, rz: 0.5 }] },
      { kind: 'prim', id: 'p9', shape: 'lathe', seg: 32, profile: [[0.001, 0], [1, 0], [1, 1]] },
      { kind: 'prim', id: 'p10', shape: 'extrude', depth: 0.5, poly: [[0, 0], [1, 0], [1, 1]] },
      { kind: 'mannequin', id: 'm1', body: 'female', pose: 'walk', controls: { 'rightShoulder.pitch': 60 }, tone: 'mid', at: [2, 0, 0] },
      { kind: 'crowd', id: 'c1', body: 'teen', pose: 'run', rows: 4, cols: 5, gapX: 1, gapZ: 1.2, jitter: 0.1, tone: 'lo' },
      { kind: 'asset', id: 'a1', file: '_模型文件/长凳.fbx', lib: '默认库', clay: false, clip: 'Idle', clipSpeed: 2, clipLoop: 'once', clipOffset: 0.25 },
      { kind: 'ref', id: 'r1', model: '角色/素体' },
    ],
    cams: [
      { id: 'cam-1', name: '机位 1', pos: [3.2, 2.1, 4.2], target: [0, 1, 0], fov: 35, follow: '' },
      { id: 'cam-2', name: '侧面', pos: [0, 1.5, 5], target: [0, 1, 0], fov: 50, follow: 'm1' },
    ],
    active: 'cam-2',
    panorama: { src: '/asset/pano', yaw: 0.5, radius: 30 },
    view: { mode: 'camera', aspect: '9:16', grid: false, ground: false, outline: false },
  },
  anim: {
    duration: 8, fps: 30, loop: false,
    tracks: [
      { id: 't1', of: { kind: 'node', id: 'm1' }, motion: 'walk', joint: 'torso/leftShoulder', interp: 'linear', enabled: false, color: 2,
        path: { kind: 'line', from: [-1, 0, 0], to: [1, 0, 0] },
        keys: [{ t: 0, at: [0, 0, 0], rot: [0, 10, 0], pose: 'walk' }, { t: 2, at: [2, 0, 0], rot: [0, 20, 0] }] },
      { id: 't2', of: { kind: 'cam', id: 'cam-2' }, interp: 'hold',
        path: { kind: 'circle', from: [1, 0, 0], radius: 2, clockwise: true },
        keys: [{ t: 0, target: [0, 1, 0], fov: 40 }, { t: 3, target: [1, 1, 1], fov: 60 }] },
      { id: 't3', of: { kind: 'node', id: 'g1' },
        path: { kind: 'free', pts: [[0, 0, 0], [1, 0, 1]], closed: true } },
      { id: 't4', of: { kind: 'node', id: 'p1' }, path: { kind: 'rect', from: [0, 0, 0], to: [2, 0, 2] }, keys: [] },
    ],
  },
  out: [
    { id: 'o1', assetId: 'la_1', url: '/asset/la_1', type: 'video', name: '出片', at: 1700000000000, picked: false },
    { id: 'o2', assetId: '', url: '', type: 'image', at: 1700000000001 },
  ],
  src: { prompt: '一句提示词', reuse: { id: '道具/椅子', mode: 'as-is', why: '一样' } },
}).doc;

/* ---------- 往返：稀疏写盘 → 归一化读回，逐字段等于写之前那份 ---------- */
{
  assert.deepEqual(roundTrip(full), full);
  ok(true, '整份文档往返一致（节点 / 机位 / 轨道 / 出片 / 来源全覆盖）');

  const one = normalizeDoc({ scene: { nodes: [], cams: [{ id: 'cam-1', pos: [1, 2, 3] }] } }).doc;
  ok(JSON.stringify(sparseDoc(one).scene.cams) === '[{"id":"cam-1","pos":[1,2,3]}]', '单台自定义机位只写改过的字段');
  assert.deepEqual(roundTrip(one), one);
  ok(true, '单机位文档往返一致');

  const twoCam = normalizeDoc({ scene: { nodes: [], cams: [{ id: 'cam-1' }, { id: 'cam-2', name: '机位 2' }], active: 'cam-2' } }).doc;
  assert.deepEqual(roundTrip(twoCam), twoCam);
  ok(sparseDoc(twoCam).scene.active === 'cam-2', '第二台机位是默认值时仍靠 active 认回');

  /* 同一份文档往返：分别新建两次会各取一次 Date.now()，跨毫秒边界时 ts 天然不等。 */
  const empty = emptyDoc('空模型', '道具');
  assert.deepEqual(roundTrip(empty), empty);
  ok(true, '空文档往返一致');
}

/* ---------- 默认字段不落盘 ---------- */
{
  const empty = emptyDoc('空', '组');
  const sp = sparseDoc(empty);
  ok(JSON.stringify(Object.keys(sp)) === JSON.stringify(['v', 'kind', 'name', 'group', 'ts', 'scene']), '空文档顶层只剩必要字段：' + Object.keys(sp).join('/'));
  ok(!('cams' in sp.scene) && !('active' in sp.scene) && !('view' in sp.scene) && !('panorama' in sp.scene), '默认机位 / 视角 / 全景整段省掉');
  ok(!('anim' in sp) && !('out' in sp) && !('src' in sp), '默认时间轴 / 空出片 / 空来源整段省掉');
  ok(sp.kind === 'model', '模型 kind 保留（导入场景那一侧靠它认模型文件）');

  const defaults = normalizeDoc({ scene: { nodes: [
    { kind: 'prim', id: 'd1', shape: 'box' },
    { kind: 'mannequin', id: 'd2' },
    { kind: 'crowd', id: 'd3' },
    { kind: 'asset', id: 'd4', file: '_模型文件/x.fbx' },
  ] } }).doc;
  ok(JSON.stringify(spOf(defaults, 'd1')) === '{"kind":"prim","id":"d1","shape":"box"}', '全默认 box 只剩 kind / id / shape：' + JSON.stringify(spOf(defaults, 'd1')));
  ok(JSON.stringify(spOf(defaults, 'd2')) === '{"kind":"mannequin","id":"d2"}', '全默认人台只剩 kind / id');
  ok(JSON.stringify(spOf(defaults, 'd3')) === '{"kind":"crowd","id":"d3"}', '全默认群众只剩 kind / id');
  ok(JSON.stringify(spOf(defaults, 'd4')) === '{"kind":"asset","id":"d4","file":"_模型文件/x.fbx"}', '默认摆件只剩文件');

  const spFull = sparseDoc(full);
  const node = findNode(spFull.scene.nodes, 'p2');
  ok(!('at' in node) && !('rot' in node) && !('scale' in node), '全零 / 全一的变换不写');
  const json = JSON.stringify(spFull, null, 2);
  ok(!json.includes('"fromModel": ""'), '空 fromModel 不写');
  ok(!json.includes('"tone": "hi"') && !json.includes('"clay": true'), '默认枚举 / 布尔不写');
  ok(!json.includes('\\"') && !json.includes('undefined'), '稀疏形态仍是合法 JSON');
}

/* ---------- 不改输入 ---------- */
{
  const before = JSON.stringify(full);
  const sp1 = sparseDoc(full);
  const spJson = JSON.stringify(sp1);
  ok(JSON.stringify(full) === before, 'sparseDoc 不碰传进来的文档');
  sp1.scene.nodes[0].children[0].at[0] = 999;
  ok(JSON.stringify(full) === before, '改稀疏结果里的数组不会回头改输入');
  ok(JSON.stringify(sp1) !== spJson, '稀疏结果本身是可改的副本');
}

/* ---------- 幂等：稀疏文档再稀疏一次还是同一份字节 ---------- */
{
  const once = sparseDoc(full);
  const twice = sparseDoc(normalizeDoc(once).doc);
  ok(JSON.stringify(twice) === JSON.stringify(once), '稀疏 → 归一化 → 稀疏，字节不变');
  const diskOnce = bytesOf(once);
  ok(bytesOf(twice) === diskOnce, '两次写盘的字节数一致');
}

/* ---------- 体积：4 个零件的模型写盘要压到 3KB 以内 ---------- */
{
  const four = normalizeDoc({
    name: '矮桌',
    group: '道具',
    scene: { nodes: [
      { kind: 'prim', id: 'n1', name: '桌面', shape: 'box', size: [1.2, 0.08, 0.7], at: [0, 0.62, 0] },
      { kind: 'prim', id: 'n2', name: '桌腿', shape: 'box', size: [0.08, 0.62, 0.08], at: [0.5, 0.31, 0.25], repeat: { n: 4, dx: 0.34, dz: 0.24 } },
      { kind: 'prim', id: 'n3', name: '横撑', shape: 'cylinder', r: 0.03, h: 0.9, at: [0, 0.1, 0], rot: [90, 0, 0] },
      { kind: 'prim', id: 'n4', name: '花瓶', shape: 'lathe', at: [-0.9, 0, 0], profile: [[0.001, 0], [0.14, 0], [0.18, 0.2], [0.1, 0.5], [0.06, 0.8], [0.09, 0.95], [0.001, 0.95]] },
    ] },
  }).doc;
  const beforeN = bytesOf(four);
  const afterN = bytesOf(sparseDoc(four));
  ok(afterN < 3072, '4 个零件的模型写盘 < 3KB（实际 ' + afterN + ' 字节）');
  ok(afterN < beforeN, '稀疏后确实变小（' + beforeN + ' → ' + afterN + ' 字节）');
  assert.deepEqual(roundTrip(four), four);
  ok(findNode(roundTrip(four).scene.nodes, 'n4').profile.length === 7, '往返之后放样轮廓点一个不少');
}

/* ---------- 坏输入不炸 ---------- */
{
  ok(sparseDoc(null).v === 3, 'sparseDoc(null) 给一份空壳');
  const back = normalizeDoc(sparseDoc(null)).doc;
  ok(back.name === '未命名白膜' && back.scene.cams.length === 1, '空壳读回来是有默认机位的完整文档');
  ok(Array.isArray(normalizeDoc(sparseDoc({ scene: { nodes: null } })).doc.scene.nodes), 'nodes 不是数组也不炸');
}

console.log('✓ model3d-sparse：' + n + ' 项通过');
