#!/usr/bin/env node
/* 场景与 DSL：图元/曲面能不能建出来、镜像与阵列展开对不对、引用怎么铺平、
   多机位 / 路径线、三角形不再停建。three 在 Node 里能跑（几何是纯数据），
   所以这一条真的把场景建出来称包围盒。 */
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three/three.module.js';
import {
  buildContent, boundsOf, clearEdgeCache, createStage, setCameraRigs, setTrackPaths, disposeStage,
} from '../web/model3d/scene.js';
import { variantsOf, cloneNodeForVariant, resolveRefs, countExpanded } from '../web/model3d/dsl.js';
import { normalizeDoc } from '../web/model3d/schema.js';
import { frameRect, sizeOfAspect } from '../web/model3d/view.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const build = raw => buildContent(normalizeDoc(raw).doc, { outline: false });

/* ---------- 十种图元都建得出来，且包围盒与参数相符 ---------- */
{
  const cases = [
    ['box', { size: [2, 1, 3] }, b => Math.abs(b.max.x - b.min.x - 2) < 0.01 && Math.abs(b.max.z - b.min.z - 3) < 0.01],
    ['sphere', { r: 1 }, b => Math.abs(b.max.y - b.min.y - 2) < 0.02],
    ['cylinder', { r: 1, r2: 1, h: 2 }, b => Math.abs(b.max.y - b.min.y - 2) < 0.02],
    ['cone', { r: 1, h: 2 }, b => Math.abs(b.max.y - b.min.y - 2) < 0.02 && b.max.y > 0.9],
    ['capsule', { r: 0.5, h: 1 }, b => Math.abs((b.max.y - b.min.y) - 2.0) < 0.05],
    ['torus', { r: 1, r2: 0.2 }, b => Math.abs(b.max.x - b.min.x - 2.4) < 0.05],
    ['plate', { size: [3, 0.1, 2] }, b => Math.abs(b.max.x - b.min.x - 3) < 0.01],
    ['lathe', { profile: [[0.001, 0], [0.4, 0], [0.4, 1], [0.001, 1]] }, b => Math.abs(b.max.y - b.min.y - 1) < 0.02],
    ['extrude', { poly: [[0, 0], [1, 0], [1, 1], [0, 1]], depth: 0.5 }, b => Math.abs(b.max.x - b.min.x - 1) < 0.02],
    ['loft', { rings: [{ y: 0, rx: 0.3, rz: 0.3 }, { y: 1, rx: 0.1, rz: 0.1 }] }, b => Math.abs(b.max.y - b.min.y - 1) < 0.05],
  ];
  for (const [shape, params, check] of cases) {
    const raw = { scene: { nodes: [Object.assign({ kind: 'prim', id: 'p', shape }, params)] } };
    const w = build(raw);
    const b = boundsOf(w);
    ok(w.tris > 0, shape + ' 建出了三角形：' + w.tris);
    ok(check(b), shape + ' 的包围盒与参数相符：x ' + (b.max.x - b.min.x).toFixed(2) + ' y ' + (b.max.y - b.min.y).toFixed(2));
  }
}

/* ---------- 镜像 / 阵列 ---------- */
{
  const node = { kind: 'prim', id: 'p', shape: 'box', size: [0.4, 0.4, 0.4], at: [1, 0.2, 0], mirror: true };
  ok(variantsOf(node).length === 2, 'mirror 展开成两份');
  const rep = { kind: 'prim', id: 'p', shape: 'box', size: [0.4, 0.4, 0.4], at: [0, 0.2, 0], repeat: { n: 4, dx: 0.5 } };
  ok(variantsOf(rep).length === 4, 'repeat 展开成 4 份');
  const both = { kind: 'prim', id: 'p', shape: 'box', size: [0.4, 0.4, 0.4], at: [1, 0.2, 0], mirror: true, repeat: { n: 3, dx: 0.5 } };
  ok(variantsOf(both).length === 6, 'mirror + repeat 是 6 份');
  const v = variantsOf(rep)[3];
  ok(v.at[0] === 1.5, '第 4 份的偏移是 3×0.5');
  const cloned = cloneNodeForVariant(rep, v);
  ok(cloned.node.at[0] === 1.5 && cloned.node.repeat === undefined, '复制出来的份带着偏移、不带 repeat');

  const w = build({ scene: { nodes: [both] } });
  const b = boundsOf(w);
  ok(Math.abs(b.min.x + b.max.x) < 0.05, '镜像之后左右对称（中心在 0 附近）：' + (b.min.x + b.max.x).toFixed(3));
  ok(b.max.x - b.min.x > 2.5, '横向铺开了：' + (b.max.x - b.min.x).toFixed(2));
}

/* ---------- 引用：铺平、防环、缺失 ---------- */
{
  const lib = {
    '角色/素体': { scene: { nodes: [{ kind: 'mannequin', id: 'x', body: 'mannequin', pose: 'stand' }] } },
    '道具/椅子': { scene: { nodes: [{ kind: 'ref', id: 'r2', model: '角色/素体' }] } },
    '环/A': { scene: { nodes: [{ kind: 'ref', id: 'r3', model: '环/B' }] } },
    '环/B': { scene: { nodes: [{ kind: 'ref', id: 'r4', model: '环/A' }] } },
  };
  const load = async id => JSON.parse(JSON.stringify(lib[id] || null));

  const r1 = await resolveRefs([{ kind: 'ref', id: 'r', model: '道具/椅子', at: [1, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }], load);
  ok(r1.nodes.length === 1 && r1.nodes[0].kind === 'group', '引用被换成一层 group');
  const inner = r1.nodes[0].children;
  ok(inner.length === 1 && inner[0].kind === 'group', '两级引用都铺平了');
  ok(r1.dropped.cycle === 0, '没有环');

  const r2 = await resolveRefs([{ kind: 'ref', id: 'r', model: '环/A' }], load);
  ok(r2.dropped.cycle >= 1, '环被拦下来：' + r2.dropped.cycle);
  ok(r2.notes.some(t => t.indexOf('引用了自己') >= 0), '环有一句人话说明');

  const r3 = await resolveRefs([{ kind: 'ref', id: 'r', model: '不存在/X' }], load);
  ok(r3.dropped.missing === 1, '找不到的引用被记下来');

  ok(countExpanded(r1.nodes) === 3, '铺平之后数得到 3 个节点：' + countExpanded(r1.nodes));
}

/* ---------- 三角形：只统计，不停建 ---------- */
{
  const nodes = [];
  for (let i = 0; i < 120; i++) nodes.push({ kind: 'prim', shape: 'sphere', r: 0.5, at: [i * 0.2, 0, 0] });
  const w = build({ scene: { nodes } });
  ok(w.tris > 60000, '三角形数超过旧预算仍继续建：' + w.tris);
  ok(!w.notes.some(t => t.indexOf('预算') >= 0), '没有「超过预算」的停建提示');
}

/* ---------- 多机位 / 路径线：辅助物挂在 content 之外 ---------- */
{
  const stage = createStage();
  const cams = [
    { id: 'c1', name: '一', pos: [1, 2, 3], target: [0, 1, 0], fov: 35, follow: '' },
    { id: 'c2', name: '二', pos: [4, 2, 5], target: [0, 1, 0], fov: 50, follow: '' },
    { id: 'c3', name: '三', pos: [0, 3, 8], target: [0, 1, 0], fov: 28, follow: '' },
  ];
  setCameraRigs(stage, cams, 'c2', 16 / 9);
  ok(stage.rigMap.size === 3, '每个机位一份视锥标识：' + stage.rigMap.size);
  ok(stage.rigs.parent === stage.scene, '视锥标识挂在场景根上');
  const doc = normalizeDoc({
    scene: { nodes: [{ kind: 'prim', id: 'p', shape: 'box' }], cams, active: 'c1' },
    anim: { duration: 4, tracks: [
      { id: 't1', of: { kind: 'node', id: 'p' }, path: { kind: 'line', from: [0, 0, 0], to: [2, 0, 0] } },
      { id: 't2', of: { kind: 'cam', id: 'c1' }, path: { kind: 'free', pts: [[0, 0, 0], [1, 0, 1]], closed: false } },
    ] },
  }).doc;
  setTrackPaths(stage, doc);
  ok(stage.paths.children.length === 2, '两条路径线都画出来：' + stage.paths.children.length);
  ok(stage.paths.parent === stage.scene, '路径线挂在场景根上');
  disposeStage(stage);
}

/* ---------- 画幅：屏幕上那块矩形与导出尺寸同源 ---------- */
{
  const fr = frameRect('16:9', 800, 400);
  ok(fr.w === 711 || Math.abs(fr.w / fr.h - 16 / 9) < 0.01, '16:9 在 800×400 里按高度撑满：' + fr.w + '×' + fr.h);
  ok(fr.x >= 0 && fr.y >= 0 && fr.w <= 800 && fr.h <= 400, '矩形不出画布');
  const s1 = sizeOfAspect('16:9', 720);
  ok(s1.w === 1280 && s1.h === 720, '短边 720 的 16:9 是 1280×720');
  const s2 = sizeOfAspect('9:16', 720);
  ok(s2.w === 720 && s2.h === 1280, '短边 720 的 9:16 是 720×1280');
  const s3 = sizeOfAspect('1:1', 720);
  ok(s3.w === 720 && s3.h === 720, '1:1 是正方形');
  const tall = frameRect('9:16', 1200, 600);
  ok(Math.abs(tall.w / tall.h - 9 / 16) < 0.01, '竖画幅在横窗里按高度收窄');
}

/* ---------- 实体：隐藏留在树里，锁定不改外观 ---------- */
{
  /* 隐藏 = 建出来的那份不可见（节点还在、包围盒还算它，导出时也原样带着） */
  const raw = { scene: { nodes: [
    { kind: 'prim', id: 'a', shape: 'box', size: [1, 1, 1], at: [0, 0.5, 0] },
    { kind: 'prim', id: 'b', shape: 'box', size: [1, 1, 1], at: [2, 0.5, 0], visible: false },
  ] } };
  const w = build(raw);
  ok(w.byId.get('a').visible === true, '没写 visible 的实体默认可见');
  ok(w.byId.get('b').visible === false, 'visible:false 的实体建出来就是不可见');
  ok(w.tris > 0 && w.byId.has('b'), '隐藏的实体仍留在场景树里（不是被删掉）');

  /* 锁定只是交互锁：外观与三角形一个不差，schema 也原样保留这个标记 */
  const lockRaw = { scene: { nodes: [{ kind: 'prim', id: 'c', shape: 'box', size: [1, 1, 1], locked: true }] } };
  const locked = normalizeDoc(lockRaw).doc;
  ok(locked.scene.nodes[0].locked === true, 'normalize 保留 locked 标记');
  const wl = buildContent(locked, { outline: false });
  ok(wl.byId.get('c').visible === true, '锁定的实体照样渲染（锁的是操作，不是外观）');
}

/* ---------- 带 clip 的摆件：全部建 mixer，不设数量上限 ---------- */
{
  const clip = new THREE.AnimationClip('wave', 1, []);
  const assets = new Map();
  const nodes = [];
  for (let i = 0; i < 24; i++) {
    const file = '_模型文件/r' + i + '.glb';
    assets.set(file, { proto: new THREE.Group(), clips: [clip] });
    nodes.push({ kind: 'asset', id: 'r' + i, file, clip: 'wave' });
  }
  const doc = normalizeDoc({ scene: { nodes } }).doc;
  const w = buildContent(doc, { outline: false, assets });
  ok(w.mixers.size === 24, '24 个摆件都建了 mixer：' + w.mixers.size);
  ok(w.mixers.has('r23'), '最后一个摆件也有 mixer');
  ok(!w.notes.some(t => t.indexOf('超过 16 个') >= 0), '没有数量上限提示');

  const unclipped = [];
  for (let i = 0; i < 24; i++) unclipped.push({ kind: 'asset', id: 'u' + i, file: '_模型文件/r0.glb' });
  const w2 = buildContent(normalizeDoc({ scene: { nodes: unclipped } }).doc, { outline: false, assets });
  ok(w2.mixers.size === 0, '没选 clip 的摆件不建 mixer');
}

/* ---------- 颜色：自己的色优先，组色沿子树继承 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'prim', id: 'p1', shape: 'box', color: '#ff0000' },
    { kind: 'group', id: 'g1', color: '#00ff00', children: [{ kind: 'prim', id: 'p2', shape: 'box' }] },
  ] } }).doc;
  const c = buildContent(doc, { outline: false });
  const colors = [];
  c.group.traverse(o => { if (o.isMesh && o.material && o.material.color) colors.push(o.material.color.getHexString()); });
  ok(colors.includes('ff0000'), '节点自己的颜色进材质');
  ok(colors.includes('00ff00'), '组色沿子树继承');
}

clearEdgeCache();
console.log('✓ model3d-scene：' + n + ' 项通过');
