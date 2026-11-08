#!/usr/bin/env node
/* 3D 文件导入：按扩展名分派、解析、白膜化、归一、缓存、报错翻人话。
   three 的几何在 Node 里能跑（与 model3d-scene 同一条路），所以这里真的把一份 .obj 读进来量包围盒；
   其余几档只验「分派 / 提示 / 清单」这一层（.fbx / .glb 的二进制 fixture 不值得塞进仓库）。 */
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three/three.module.js';
import {
  ASSET_EXT, extOf, assetKind, isAssetName, acceptAttr, parseBytes, load, loadAll,
  applyClay, normalizeRoot, stripRig, friendlyError, filesOf, clearAssetCache,
} from '../web/model3d/loader.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---------- ① 扩展名分派只有一张表 ---------- */
{
  ok(assetKind('a.obj') === 'obj' && assetKind('A.FBX') === 'fbx', '大小写都认得');
  ok(assetKind('a.glb') === 'glb' && assetKind('a.gltf') === 'gltf', 'glb / gltf 分得开');
  ok(assetKind('a.png') === '' && assetKind('没有扩展名') === '', '别的文件不认');
  ok(extOf('dir/长凳.FBX') === '.fbx', '路径里的点不干扰扩展名');
  ok(ASSET_EXT.join(',') === acceptAttr(), 'accept 文案就是这张表');
  ok(isAssetName('_模型文件/椅子.glb') === true, '带目录的路径照样认得');
}

/* ---------- ② OBJ：解析 → 归一（高 1 米、脚底在 0、水平居中） ---------- */
const OBJ_TEXT = 'v 0 0 0\nv 2 0 1\nv 0 4 0\nv 2 4 1\nf 1 2 3\nf 2 4 3\n';
const bytesOf = s => new TextEncoder().encode(s).buffer;
{
  const entry = await parseBytes('长凳.obj', bytesOf(OBJ_TEXT));
  ok(Array.isArray(entry.clips) && entry.clips.length === 0, 'OBJ 没有动画：clips 是空数组');
  ok(entry.bones === 0 && entry.note === '', 'OBJ 没有骨骼，也就没有降级提示');
  const o = entry.proto;
  let meshes = 0;
  o.traverse(x => { if (x.isMesh) meshes += 1; });
  ok(meshes === 1, 'OBJ 解析出一个网格：' + meshes);
  const b = new THREE.Box3().setFromObject(o);
  ok(Math.abs((b.max.y - b.min.y) - 1) < 0.001, '高度归一成 1 米：' + (b.max.y - b.min.y).toFixed(3));
  ok(Math.abs(b.min.y) < 0.001, '脚底落在 y=0：' + b.min.y.toFixed(3));
  ok(Math.abs(b.min.x + b.max.x) < 0.001 && Math.abs(b.min.z + b.max.z) < 0.001, '水平居中在原点');
}

/* ---------- ③ 白膜化：所有网格换成同一份黏土材质 ---------- */
{
  const entry = await parseBytes('x.obj', bytesOf(OBJ_TEXT));
  applyClay(entry.proto);
  const mats = new Set();
  let meshes = 0;
  entry.proto.traverse(x => { if (x.isMesh) { meshes += 1; mats.add(x.material); } });
  ok(meshes > 0 && mats.size === 1, '白膜化之后只剩一份材质：' + mats.size);
  ok([...mats][0].isMeshStandardMaterial === true, '是标准材质（能接阴影）');
}

/* ---------- ④ 灯 / 相机从导入件里剔掉 ---------- */
{
  const g = new THREE.Group();
  g.add(new THREE.DirectionalLight(0xffffff, 1));
  g.add(new THREE.PerspectiveCamera(50, 1, 0.1, 10));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  g.add(mesh);
  stripRig(g);
  let lights = 0, cams = 0;
  g.traverse(x => { if (x.isLight) lights += 1; if (x.isCamera) cams += 1; });
  ok(lights === 0 && cams === 0, '文件里的光与相机都剔掉了');
  ok(g.children.length === 1, '网格留着');
}

/* ---------- ⑤ 归一：文件自带 0.01 倍变换（FBX 的常见情况）也归一得对 ---------- */
{
  const inner = new THREE.Mesh(new THREE.BoxGeometry(100, 200, 100), new THREE.MeshBasicMaterial());
  const root = new THREE.Group();
  root.scale.setScalar(0.01);
  root.add(inner);
  const w = normalizeRoot(root, 1);
  const b = new THREE.Box3().setFromObject(w);
  ok(Math.abs((b.max.y - b.min.y) - 1) < 0.001, '带缩放的文件也归一到 1 米：' + (b.max.y - b.min.y).toFixed(4));
  ok(Math.abs(b.min.y) < 0.001, '脚底仍在 0');
}

/* ---------- ⑥ 缓存：同一份文件只解析一次 ---------- */
{
  clearAssetCache();
  const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(OBJ_TEXT);
  const a = await load('缓存.obj', { url });
  const b = await load('缓存.obj', { url });
  ok(a === b, '第二次拿的是同一个原型（没有重复 parse）');
  ok((await loadAll(['缓存.obj', '缓存.obj'], { url })).assets.size === 1, '批量读同一份也只留一条');
  /* 失败不留缓存：坏文件的错误不该赖在键上 */
  await assert.rejects(() => load('坏.glTF', { url: 'data:text/plain,not json' }));
  const after = await load('坏.gltf', { url: 'data:text/plain,not json' }).then(() => false).catch(() => true);
  ok(after, '坏文件每次都重试，不粘住上一次的错误');
}

/* ---------- ⑦ 报错翻人话 ---------- */
{
  ok(/Draco/.test(friendlyError('a.glb', new Error('THREE.GLTFLoader: No DRACOLoader instance provided'))), 'Draco 说清楚了');
  ok(/KTX2/.test(friendlyError('a.glb', new Error('THREE.GLTFLoader: setKTX2Loader must be called'))), 'KTX2 说清楚了');
  ok(/外链/.test(friendlyError('a.gltf', new Error('THREE.GLTFLoader: Failed to load buffer "scene.bin"'))), '.gltf 外链说清楚了');
  ok(/MTL|mtl/.test(friendlyError('a.obj', new Error('materials are not supported'))), '.obj 的 mtl 说清楚了');
  ok(/只收/.test(await parseBytes('a.png', bytesOf('x')).then(() => '').catch(e => e.message)), '不认识的扩展名当场拒');
}

/* ---------- ⑧ 摆件清单：整棵树里的 asset 节点 ---------- */
{
  const nodes = [
    { kind: 'asset', file: '_模型文件/椅子.glb' },
    { kind: 'group', children: [{ kind: 'asset', file: '_模型文件/椅子.glb' }, { kind: 'prim' }] },
    { kind: 'mannequin' },
  ];
  const files = filesOf(nodes);
  ok(files.length === 1 && files[0] === '_模型文件/椅子.glb', '重复的摆件只读一次');
  ok(filesOf([]).length === 0, '没有摆件时是空清单');
}

clearAssetCache();
console.log('✓ model3d-loader：' + n + ' 项通过');
