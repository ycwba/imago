/* DSL → three 场景图。这里是「零件树变成能画的东西」的唯一一处：
   几何怎么造、材质怎么给、阴影与描边谁来挂、群众怎么合批，全在这一份里。

   两条口径：
   · **白膜**：材质只有三档灰阶（palette.js），导入的模型默认也被换成这套（`clay`），
     所以「白膜参考图」这件事在渲染层就定死了，不靠用户调。
   · **可重建**：AI 流式生成时每收全一个节点就整场重建一次，`buildContent` 必须便宜、可丢弃；
     几何按参数做缓存（同尺寸的胶囊只造一份），模型换掉时统一 dispose。 */

import * as THREE from '../vendor/three/three.module.js';
import { mergeGeometries } from '../vendor/three/BufferGeometryUtils.js';
import { CLAY, CLAY_DETAIL, GROUND, SKY, FOG, GRID, GRID_BOLD, SELECT, toneOf, trackColorOf, nodeColorOf } from './palette.js';
import { mannequinTree, poseLimitOf } from './mannequin.js';
import { crowdLayout } from './crowd.js';
import { variantsOf, cloneNodeForVariant } from './dsl.js';
import { quatOfDegrees, registerJoint } from './rig.js';
import { clipOf, mixerFor, bindClip, applyClip } from './clip.js';
import { cloneAsset, assetLookupKey } from './loader.js';

const D2R = Math.PI / 180;
const v3 = a => new THREE.Vector3(a[0] || 0, a[1] || 0, a[2] || 0);
const e3 = a => new THREE.Euler((a[0] || 0) * D2R, (a[1] || 0) * D2R, (a[2] || 0) * D2R, 'XYZ');

/* ---------------- 几何工厂（带缓存） ---------------- */
const geoCache = new Map();
function cached(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}
function disposeGeoCache() {
  for (const g of geoCache.values()) { try { g.dispose(); } catch (e) { /* 共享几何释放失败不影响重建 */ } }
  geoCache.clear();
}

function shapeGeometry(node) {
  const s = node.shape;
  if (s === 'box' || s === 'plate') {
    const size = node.size || [1, 1, 1];
    return cached('box:' + size.join(','), () => new THREE.BoxGeometry(size[0], size[1], size[2]));
  }
  if (s === 'sphere') {
    const seg = node.seg || 24;
    const heightSeg = Math.max(3, Math.round(seg * 2 / 3));
    return cached('sph:' + node.r + ':' + seg, () => new THREE.SphereGeometry(node.r, seg, heightSeg));
  }
  if (s === 'cylinder') {
    const seg = node.seg || 24;
    return cached('cyl:' + [node.r, node.r2, node.h, seg].join(','),
      () => new THREE.CylinderGeometry(node.r2, node.r, node.h, seg));
  }
  if (s === 'cone') {
    const seg = node.seg || 24;
    return cached('cone:' + [node.r, node.h, seg].join(','), () => new THREE.ConeGeometry(node.r, node.h, seg));
  }
  if (s === 'capsule') {
    const seg = node.seg || 20;
    const capSeg = Math.max(3, Math.round(seg / 2.5));
    return cached('cap:' + [node.r, node.h, seg].join(','), () => new THREE.CapsuleGeometry(node.r, node.h, capSeg, seg));
  }
  if (s === 'torus') {
    const seg = node.seg || 36;
    const radial = Math.max(3, Math.round(seg / 3));
    return cached('tor:' + [node.r, node.r2, seg].join(','), () => new THREE.TorusGeometry(node.r, node.r2, radial, seg));
  }
  if (s === 'lathe') {
    return cached('lathe:' + JSON.stringify(node.profile) + ':' + node.seg, () => {
      const pts = node.profile.map(p => new THREE.Vector2(p[0], p[1]));
      return new THREE.LatheGeometry(pts, node.seg || 24);
    });
  }
  if (s === 'extrude') {
    return cached('ext:' + JSON.stringify(node.poly) + ':' + node.depth + ':' + (node.seg || 8), () => {
      const shape = new THREE.Shape(node.poly.map(p => new THREE.Vector2(p[0], p[1])));
      return new THREE.ExtrudeGeometry(shape, { depth: node.depth, bevelEnabled: false, curveSegments: node.seg || 8 });
    });
  }
  if (s === 'loft') return cached('loft:' + JSON.stringify(node.rings) + ':' + node.seg, () => loftGeometry(node));
  return cached('box:1,1,1', () => new THREE.BoxGeometry(1, 1, 1));
}

/* 放样：一串截面环（rx/rz/cx/cz/y）之间插值成一张筒，端头封口。
   用它做有机形体（躯干、尾巴、瓶子）比拿一堆球去拼干净得多 —— AI 也更容易写对。 */
function loftGeometry(node) {
  const rings = node.rings;
  const seg = node.seg || 20;
  const SUB = 4;                        // 每两环之间插 4 段，环少时也够顺
  const steps = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let k = 0; k < SUB; k++) {
      const u = k / SUB;
      const sm = u * u * (3 - 2 * u);
      steps.push({
        y: a.y + (b.y - a.y) * u,
        rx: a.rx + (b.rx - a.rx) * sm,
        rz: a.rz + (b.rz - a.rz) * sm,
        cx: a.cx + (b.cx - a.cx) * sm,
        cz: a.cz + (b.cz - a.cz) * sm,
      });
    }
  }
  steps.push(rings[rings.length - 1]);
  const cols = seg + 1;
  const pos = [], idx = [];
  for (const r of steps) {
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(r.cx + Math.cos(a) * r.rx, r.y, r.cz + Math.sin(a) * r.rz);
    }
  }
  for (let i = 0; i < steps.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  /* 端头：以中心点做扇形封口（不封的话从下往上看能看到内部） */
  const capAt = (ring, flip) => {
    const center = pos.length / 3;
    pos.push(ring.cx, ring.y, ring.cz);
    const base = flip ? (steps.length - 1) * cols : 0;
    for (let j = 0; j < seg; j++) {
      const a = base + j, b = base + j + 1;
      if (flip) idx.push(center, a, b); else idx.push(center, b, a);
    }
  };
  capAt(rings[0], false);
  capAt(rings[rings.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function partGeometry(g) {
  if (g.k === 'capsule') return cached('cap:' + [g.r, g.len].join(','), () => new THREE.CapsuleGeometry(g.r, g.len, 8, 20));
  if (g.k === 'sphere') return cached('sph:' + g.r, () => new THREE.SphereGeometry(g.r, 20, 14));
  if (g.k === 'cyl') return cached('cyl:' + [g.rt, g.rb, g.h].join(','), () => new THREE.CylinderGeometry(g.rt, g.rb, g.h, 20));
  if (g.k === 'torus') return cached('tor:' + [g.r, g.r2].join(','), () => new THREE.TorusGeometry(g.r, g.r2, 8, 28));
  return cached('box:1,1,1', () => new THREE.BoxGeometry(1, 1, 1));
}

/* ---------------- 材质 ---------------- */
const matCache = new Map();
/* 蒙皮网格单独一份材质：`shadowSide = DoubleSide` 压掉白膜上的自阴影条纹。
   只有 `isSkinnedMesh` 走这一份，其余零件的像素与以前逐字节相同。 */
function clayMat(tone, detail, skin, custom) {
  const color = detail ? CLAY_DETAIL : (custom || toneOf(tone));
  const key = color + ':' + (detail ? 'd' : 'c') + (skin ? ':s' : '');
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color, roughness: detail ? 0.7 : 0.86, metalness: 0.02,
      shadowSide: skin ? THREE.DoubleSide : THREE.FrontSide,
    });
    matCache.set(key, m);
  }
  return m;
}
export function disposeMaterials() {
  for (const m of matCache.values()) { try { m.dispose(); } catch (e) { /* 同上：释放失败不影响重建 */ } }
  matCache.clear();
}

function trisOfGeometry(g) {
  if (!g) return 0;
  return Math.round(g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0));
}
function countTris(obj) {
  return trisOfGeometry(obj && obj.geometry);
}

/* ---------------- 静态舞台：地台 / 灯 / 全景 ---------------- */
export function createStage() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(FOG, 14, 46);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xd9d4cc, 1.35);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(4.2, 7.5, 5.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  /* bias 压阴影条纹：白膜是一整片浅色，自阴影的血丝最刺眼（见实施要点） */
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const cam = key.shadow.camera;
  cam.left = -9; cam.right = 9; cam.top = 9; cam.bottom = -9; cam.near = 0.5; cam.far = 40;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(-5, 3.5, -4);
  scene.add(fill);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.ShadowMaterial({ color: 0x1a1a1a, opacity: 0.16 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'stage-ground';
  scene.add(ground);

  /* 地台底色：与 GridHelper 叠在一起，网格线压在浅底上；纯 ShadowMaterial 的平面是透明的，
     下面必须有一层实底，否则背景的 SKY 直接透上来，模型像浮在虚空里。 */
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  floor.receiveShadow = false;
  floor.name = 'stage-floor';
  scene.add(floor);

  const grid = new THREE.GridHelper(40, 40, GRID_BOLD, GRID);
  grid.material.opacity = 0.55;
  grid.material.transparent = true;
  grid.position.y = 0.001;
  scene.add(grid);

  const pano = new THREE.Group();
  pano.name = 'stage-panorama';
  scene.add(pano);

  /* 真实出图 / 出片用的那台机位相机。它只有一台，按当前活动机位逐帧写入；
     视口里的「机位在哪、朝哪、画幅多大」另由 rigs 里的影子相机画。 */
  const camC = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 400);

  /* 每个机位一份视锥标识。锥体用一台影子相机画（近 0.3 / 远 2.2 米）：
     按真机位那台画（0.1~100）会拉出一百米长的线，整个视口全是线框；
     真实机位仍在 camC 上，影子只负责画形状。机位数量不设上限。 */
  const rigs = new THREE.Group();
  rigs.name = 'stage-camera-rigs';
  scene.add(rigs);
  const rigMap = new Map();

  /* 轨道路径线。放在 content 之外：取景包围盒只量模型，不把辅助线算进去。 */
  const paths = new THREE.Group();
  paths.name = 'stage-paths';
  scene.add(paths);

  return { scene, key, hemi, fill, ground, floor, grid, pano, camC, rigs, rigMap, paths };
}

function rigOf(stage, id) {
  return stage && stage.rigMap ? stage.rigMap.get(id) : null;
}

function makeRig() {
  const rigCam = new THREE.PerspectiveCamera(35, 16 / 9, 0.3, 2.2);
  const helper = new THREE.CameraHelper(rigCam);
  /* CameraHelper 默认是橙/红/蓝三色的霓虹线（一眼假）；白膜里统一用强调色，且半透明，
     这样它不会盖过模型本身。 */
  helper.material.vertexColors = false;
  helper.material.color.set(SELECT);
  helper.material.transparent = true;
  helper.material.opacity = 0.55;
  const group = new THREE.Group();
  group.name = 'stage-camera-rig';
  group.add(helper);
  /* 不可见的拾取球：视锥线本身不好点，点击机位时用这颗球命中。 */
  const pick = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
  );
  pick.name = 'stage-camera-pick';
  group.add(pick);
  return { group, helper, rigCam, pick };
}

/* 把机位相机的位姿与画幅同步到视锥标识上。`aspect` 传的是画幅比（不是字符串）：
   画幅一换，锥体的开口就要跟着换，否则「看到的框」和「拍出来的框」对不上。 */
export function updateCameraRig(stage, cam, aspect, active = false) {
  if (!stage || !cam) return;
  let rig = rigOf(stage, cam.id);
  if (!rig) {
    rig = makeRig();
    rig.helper.userData.camId = cam.id;
    stage.rigs.add(rig.group);
    stage.rigMap.set(cam.id, rig);
  }
  const ar = Math.max(0.005, Number(aspect) || 16 / 9);
  const r = rig.rigCam;
  r.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  r.lookAt(new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]));
  if (rig.pick) {
    rig.pick.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    rig.pick.userData.camId = cam.id;
    rig.pick.visible = true;
  }
  r.fov = cam.fov;
  r.aspect = ar;
  r.updateProjectionMatrix();
  r.updateMatrixWorld(true);
  rig.helper.update();
  rig.helper.material.color.set(active ? SELECT : 0x8f8a83);
  rig.helper.material.opacity = active ? 0.7 : 0.28;
}

/* 按当前机位表重建视锥标识。机位被删 / 改名后调用；逐帧只调 updateCameraRig。 */
export function setCameraRigs(stage, cams, activeId, aspect) {
  if (!stage) return;
  const keep = new Set((cams || []).map(c => c.id));
  for (const [id, rig] of stage.rigMap) {
    if (keep.has(id)) continue;
    stage.rigs.remove(rig.group);
    try { rig.helper.geometry.dispose(); rig.helper.material.dispose(); } catch (e) { /* 释放失败不影响重建 */ }
    if (rig.pick) { try { rig.pick.geometry.dispose(); rig.pick.material.dispose(); } catch (e) { /* 释放失败不影响重建 */ } }
    stage.rigMap.delete(id);
  }
  for (const cam of (cams || [])) updateCameraRig(stage, cam, aspect, cam.id === activeId);
}

/* 轨道路径线：节点与机位共用。几何不进 content，取景与包围盒不受影响。 */
function pathPoints(path) {
  if (!path) return [];
  const from = path.from || [0, 0, 0];
  const to = path.to || [0, 0, 2];
  if (path.kind === 'free') return (path.pts || []).map(p => new THREE.Vector3(p[0], p[1], p[2]));
  if (path.kind === 'line') return [new THREE.Vector3(from[0], from[1], from[2]), new THREE.Vector3(to[0], to[1], to[2])];
  if (path.kind === 'circle') {
    const pts = [];
    const r = Math.max(0.001, Number(path.radius) || 1.5);
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2 * (path.clockwise ? -1 : 1);
      pts.push(new THREE.Vector3(from[0] + Math.cos(a) * r, from[1], from[2] + Math.sin(a) * r));
    }
    return pts;
  }
  if (path.kind === 'rect') {
    const x2 = from[0] + (to[0] - from[0]);
    const z2 = from[2] + (to[2] - from[2]);
    return [
      new THREE.Vector3(from[0], from[1], from[2]),
      new THREE.Vector3(x2, from[1], from[2]),
      new THREE.Vector3(x2, from[1], z2),
      new THREE.Vector3(from[0], from[1], z2),
      new THREE.Vector3(from[0], from[1], from[2]),
    ];
  }
  return [];
}

export function setTrackPaths(stage, doc) {
  if (!stage || !stage.paths) return;
  for (const child of [...stage.paths.children]) {
    stage.paths.remove(child);
    try { child.geometry.dispose(); child.material.dispose(); } catch (e) { /* 释放失败不影响重建 */ }
  }
  const tracks = (doc && doc.anim && doc.anim.tracks) || [];
  for (const tr of tracks) {
    if (!tr || tr.enabled === false || !tr.path) continue;
    const pts = pathPoints(tr.path);
    if (pts.length < 2) continue;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: trackColorOf(tr.color),
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.name = 'track-path';
    line.userData.trackId = tr.id;
    stage.paths.add(line);
  }
}

export function disposeStage(stage) {
  if (!stage) return;
  try {
    for (const rig of stage.rigMap ? stage.rigMap.values() : []) {
      try { rig.helper.geometry.dispose(); rig.helper.material.dispose(); } catch (e) { /* 释放失败不影响重建 */ }
      if (rig.pick) { try { rig.pick.geometry.dispose(); rig.pick.material.dispose(); } catch (e) { /* 释放失败不影响重建 */ } }
    }
    stage.rigMap && stage.rigMap.clear();
    for (const child of stage.paths ? [...stage.paths.children] : []) {
      try { child.geometry.dispose(); child.material.dispose(); } catch (e) { /* 释放失败不影响重建 */ }
    }
    stage.scene.clear();
  } catch (e) { /* 清场失败不影响下一次挂载 */ }
}

/* 全景球：等距柱状图贴在球的内壁（BackSide），绕 Y 转向。没有图就清空，退回纯色摄影棚。 */
const panoCache = new Map();
export async function setPanorama(stage, pan) {
  const g = stage.pano;
  while (g.children.length) {
    const c = g.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material && c.material.map) c.material.map.dispose();
    if (c.material) c.material.dispose();
  }
  const src = pan && pan.src ? String(pan.src) : '';
  if (!src) return { ok: true, empty: true };
  const radius = Math.max(0.001, Number(pan.radius) || 20);
  let tex = panoCache.get(src);
  if (!tex) {
    tex = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(src, t => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.mapping = THREE.EquirectangularReflectionMapping;
        resolve(t);
      }, undefined, () => reject(new Error('全景图读不出来：' + src)));
    }).catch(() => null);
    if (!tex) return { ok: false, why: '全景图读不出来' };
    panoCache.set(src, tex);
  }
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 32),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, toneMapped: false })
  );
  mesh.rotation.y = (Number(pan.yaw) || 0) * D2R;
  mesh.name = 'panorama-sphere';
  g.add(mesh);
  return { ok: true };
}

/* ---------------- 内容：DSL 节点 → Object3D ---------------- */
function applyTransform(obj, node) {
  obj.position.set(node.at[0], node.at[1], node.at[2]);
  obj.rotation.copy(e3(node.rot));
  obj.scale.set(node.scale[0], node.scale[1], node.scale[2]);
  obj.userData.nodeId = node.id;
  if (node.visible === false) obj.visible = false;
}

function meshOf(geometry, material, node) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.nodeId = node.id;
  return m;
}

/* 描边几何按源几何缓存：建模台每次重建都会给每个零件配一条线，重造 EdgesGeometry
   在一帧里就是几十次三角形配对 —— 缓存之后重建只多一条 LineSegments。 */
const edgeCache = new Map();
function edgesOf(geometry) {
  let e = edgeCache.get(geometry.uuid);
  if (!e) {
    e = new THREE.EdgesGeometry(geometry, 32);
    edgeCache.set(geometry.uuid, e);
  }
  return e;
}
export function clearEdgeCache() {
  for (const e of edgeCache.values()) { try { e.dispose(); } catch (err) { /* 共享描边释放失败不影响下一次 */ } }
  edgeCache.clear();
}

function addOutline(mesh, width) {
  const line = new THREE.LineSegments(edgesOf(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x6f6a63, transparent: true, opacity: 0.35 }));
  line.scale.setScalar(1 + (width || 0.001));
  line.userData.outlineOf = mesh.userData.nodeId;
  return line;
}

/* 小人 / 群众：先由 mannequin.js 算出零件树，这一层只负责「树 → Group」。
   `bake` 为真时把零件几何按灰阶合批（给群众用：一个人 30 来个网格，上千人就是几万个绘制调用）。 */
/* 落地偏移：参考项目那套比例里，腿的总长比髋高更长（脚底会陷到 y=0 以下）。
   白膜是拿去做构图参考的，人必须站在地台上 —— 所以按「站立姿势的脚底」量一次偏移，
   之后每个小人 / 群众都加上它。偏移按体型缓存，且只在站立姿势上量：
   播放时若跟着当前姿势量，人物会随步态上下漂（那是最刺眼的一种假）。
   量的时候带 `noOffset` 标记，避免递归。 */
const groundOffsetCache = new Map();
function groundOffsetOf(bodyType, pose) {
  const key = bodyType + '|' + pose;
  if (groundOffsetCache.has(key)) return groundOffsetCache.get(key);
  const probe = buildMannequin({ body: bodyType, pose }, { noOffset: true });
  const box = new THREE.Box3().setFromObject(probe.group);
  const off = Number.isFinite(box.min.y) ? -box.min.y : 0;
  groundOffsetCache.set(key, off);
  return off;
}

function buildMannequin(node, opts) {
  const tree = mannequinTree({
    body: node.body, pose: node.pose, controls: node.controls || {},
    motion: (opts && opts.motion) || '', t: (opts && opts.t) || 0,
  });
  const group = new THREE.Group();
  group.name = node.name || '小人';
  const bake = opts && opts.bake;
  const bodyTone = (opts && opts.tone) || 'hi';
  const bodyColor = (opts && opts.color) || null;
  const pieces = [];
  const joints = new Map();
  const limit = poseLimitOf(node.body);

  /* 关节是 Bone，零件是它的硬绑定子节点（权重恒 1，没有 Skeleton 也没有蒙皮）。
     关节自己记住「基座角度 / 基座位移 / 限位」，子关节轨道与姿势写回都从这三个值起步。 */
  function makeJoint(spec) {
    const b = new THREE.Bone();
    b.name = spec.name || '';
    b.position.copy(v3(spec.at));
    b.quaternion.copy(quatOfDegrees(spec.rot));
    b.scale.copy(v3(spec.scale));
    b.userData.baseRot = spec.rot.slice();
    b.userData.baseAt = spec.at.slice();
    b.userData.limitDeg = limit;
    return b;
  }

  function fill(spec, parentMatrix, parentObj, path) {
    const local = new THREE.Matrix4().compose(v3(spec.at), quatOfDegrees(spec.rot), v3(spec.scale));
    const world = parentMatrix.clone().multiply(local);
    for (const p of spec.parts) {
      const geo = partGeometry(p.g);
      const mat = clayMat(p.tone === 'lo' ? 'lo' : bodyTone, p.tone === 'lo', false, p.tone === 'lo' ? null : bodyColor);
      if (bake) {
        const m = new THREE.Matrix4().compose(v3(p.at), quatOfDegrees(p.rot), v3(p.scale));
        const g2 = geo.clone();
        g2.applyMatrix4(world.clone().multiply(m));
        pieces.push({ geometry: g2, material: mat });
        continue;
      }
      const m = meshOf(geo, mat, node);
      m.position.copy(v3(p.at));
      m.quaternion.copy(quatOfDegrees(p.rot));
      m.scale.copy(v3(p.scale));
      parentObj.add(m);
      if (opts && opts.outline) parentObj.add(addOutline(m));
    }
    for (const child of spec.children || []) {
      if (bake) { fill(child, world, null, ''); continue; }
      const g = makeJoint(child);
      parentObj.add(g);
      const childPath = path === 'body' ? (child.name || '') : (child.name ? path + '/' + child.name : '');
      if (childPath) {
        registerJoint(joints, childPath, g);
        fill(child, world, g, childPath);
      } else {
        fill(child, world, g, '');
      }
    }
  }

  const root = new THREE.Group();
  root.position.y = (opts && opts.noOffset) ? 0 : groundOffsetOf(node.body, (opts && opts.motion) ? 'stand' : node.pose);
  group.add(root);
  const body = makeJoint(tree);
  registerJoint(joints, 'body', body);
  root.add(body);
  /* 合批那条路不吃对象层级：把「落地偏移」作为起始矩阵带进去，
     否则烤出来的群众会陷在 y=0 以下（root 的位移不进几何） */
  fill(tree, new THREE.Matrix4().makeTranslation(0, root.position.y, 0), body, 'body');
  return { group, pieces, joints };
}

function buildCrowd(node, motion, t, color) {
  const layout = crowdLayout(node);
  const built = buildMannequin({ body: node.body, pose: node.pose }, { bake: true, tone: node.tone, color, motion, t });
  const group = new THREE.Group();
  group.name = node.name || '群众';
  /* 按材质分组做合批：同一材质（同灰阶）的零件并成一份几何，再一条 InstancedMesh 画完所有人。
     一个人三十来个网格，人一多就是几万次绘制 —— 合批之后只剩「灰阶档数」次。 */
  const byMat = new Map();
  for (const pc of built.pieces) {
    const key = pc.material.uuid;
    if (!byMat.has(key)) byMat.set(key, { material: pc.material, geos: [] });
    byMat.get(key).geos.push(pc.geometry);
  }
  const count = Math.max(1, layout.people.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let tris = 0;
  for (const [, bucket] of byMat) {
    const merged = mergeGeometries(bucket.geos, false);
    bucket.geos.forEach(g => g.dispose());
    if (!merged) continue;
    tris += trisOfGeometry(merged) * count;
    const inst = new THREE.InstancedMesh(merged, bucket.material, count);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.userData.nodeId = node.id;
    inst.userData.crowd = true;
    layout.people.forEach((pp, i) => {
      q.setFromEuler(new THREE.Euler(0, pp.yaw * D2R, 0));
      m4.compose(new THREE.Vector3(pp.at[0], pp.at[1], pp.at[2]), q, new THREE.Vector3(pp.scale, pp.scale, pp.scale));
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }
  return { group, tris };
}

/* 一个 DSL 节点 → 一组包装 Group（镜像 / 阵列各占一份，每份都带自己的子树）。
   `assets` 是「文件 → 已解析的 Object3D 原型」的 Map（loader.js 负责填），这一层只 clone。
   返回 [{ wrap, inner }]：wrap 挂到父上，inner 是这个节点自己的那个对象（子节点挂进它）。 */
function buildNode(node, ctx) {
  const parts = [];
  /* 播放 / 出片时的「这一刻的姿势与步态」由外层给（生成与静态预览时是空） */
  const poseNow = (id) => (ctx.poseOf ? (ctx.poseOf(id) || null) : null);
  for (const variant of variantsOf(node)) {
    const { node: vnode, mirrorX } = cloneNodeForVariant(node, variant);
    const tint = ctx.tintOf ? ctx.tintOf(vnode.id) : nodeColorOf(vnode);
    const over = poseNow(vnode.id);
    if (over && over.pose) vnode.pose = over.pose;
    const wrap = new THREE.Group();
    applyTransform(wrap, vnode);
    if (mirrorX) {
      /* 负缩放由 three 自己处理面朝向（它按世界矩阵行列式翻 frontFace），
         所以镜像不需要把几何整个翻一遍。 */
      wrap.scale.x *= -1;
    }
    let obj = null;
    if (vnode.kind === 'group') {
      obj = new THREE.Group();
      obj.name = vnode.name || '组';
    } else if (vnode.kind === 'prim') {
      const geo = shapeGeometry(vnode);
      ctx.tris += trisOfGeometry(geo);
      obj = meshOf(geo, clayMat(vnode.tone, false, false, tint), vnode);
      if (ctx.outline) obj.add(addOutline(obj));
    } else if (vnode.kind === 'mannequin') {
      const r = buildMannequin(vnode, { outline: ctx.outline, tone: vnode.tone, color: tint, motion: over && over.motion, t: ctx.time });
      obj = r.group;
      if (r.joints.size) {
        const list = ctx.joints.get(vnode.id) || [];
        list.push(r.joints);
        ctx.joints.set(vnode.id, list);
      }
      r.group.traverse(o => {
        if (!o.isMesh) return;
        ctx.tris += countTris(o);
        o.userData.nodeId = vnode.id;
      });
    } else if (vnode.kind === 'crowd') {
      const r = buildCrowd(vnode, over && over.motion, ctx.time, tint);
      obj = r.group;
      ctx.tris += r.tris;
    } else if (vnode.kind === 'asset') {
      const entry = ctx.assets && ctx.assets.get(assetLookupKey(vnode));
      const proto = entry && entry.proto;
      if (!proto) {
        /* 还没加载好（或文件没了）：占位一个半透明盒子，让人看得见「这里有一个摆件」 */
        obj = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial({ color: tint || toneOf('lo'), roughness: 1, transparent: true, opacity: 0.35 }));
        obj.userData.pendingAsset = vnode.file;
        obj.castShadow = false;
        ctx.notes.push('摆件还没加载：' + vnode.file);
      } else {
        obj = cloneAsset(proto);
        obj.traverse(o => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;
          o.userData.nodeId = vnode.id;
          if (vnode.clay) o.material = clayMat('hi', false, o.isSkinnedMesh === true, tint);
          ctx.tris += countTris(o);
        });
        if (vnode.clip) {
          const clip = clipOf(entry, vnode.clip);
          if (!clip) {
            ctx.notes.push('这个文件里没有动画：' + vnode.clip + '（' + vnode.file + '）');
          } else {
            const rec = mixerFor(ctx, vnode.id, obj);
            bindClip(rec, clip, vnode.clipLoop);
            applyClip(rec, vnode, ctx.time);
            ctx.rigged += 1;
          }
        }
      }
    } else {
      continue;
    }
    obj.name = vnode.name || obj.name || vnode.kind;
    obj.userData.nodeId = vnode.id;
    wrap.add(obj);
    parts.push({ wrap, inner: obj });
  }
  return parts;
}

/* 整份文档 → 一个 Group。`byId` 给拾取与属性面板反查（镜像 / 阵列的多份都记在同一个 id 上）；
   `tris` 只是信息计数，不拿来停建。遍历用显式栈，节点树多深都不靠 JS 调用栈。 */
export function buildContent(doc, opts = {}) {
  /* 颜色沿树继承：给实体根 group 上色，整件零件都换色；子节点自己的 color 优先。 */
  const tints = new Map();
  const paintTints = (list, inherited) => {
    for (const n of (list || [])) {
      const c = nodeColorOf(n) || inherited;
      tints.set(n.id, c);
      if (n.children && n.children.length) paintTints(n.children, c);
    }
  };
  paintTints(doc.scene.nodes || [], null);
  const ctx = {
    assets: opts.assets || null,
    outline: opts.outline !== false,
    poseOf: opts.poseOf || null,
    time: Number(opts.time) || 0,
    tintOf: id => tints.get(id) || null,
    tris: 0,
    notes: [],
    mixers: new Map(),
    joints: new Map(),
    rigged: 0,
  };
  const group = new THREE.Group();
  group.name = 'content';
  const byId = new Map();

  const stack = [{ nodes: doc.scene.nodes || [], parent: group, i: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) { stack.pop(); continue; }
    const node = frame.nodes[frame.i++];
    if (!node || typeof node !== 'object') continue;
    for (const { wrap, inner } of buildNode(node, ctx)) {
      frame.parent.add(wrap);
      if (!byId.has(node.id)) byId.set(node.id, wrap);
      if (node.children && node.children.length) {
        stack.push({ nodes: node.children, parent: inner, i: 0 });
      }
    }
  }
  return { group, byId, tris: ctx.tris, notes: ctx.notes, mixers: ctx.mixers, joints: ctx.joints };
}

/* 节点被删 / 模型换掉时统一清一遍：几何与材质是按参数缓存的（共享），
   所以这里只放「本轮自己 new 的」那一份 —— 群众合批出来的几何。
   共享几何 / 材质 / 描边留在缓存里给下一次用（建模台反复重建几百次，每次重造会漏 GPU 内存），
   整页卸载时再调 `disposeAllCaches()`。 */
export function disposeContent(content) {
  if (!content) return;
  if (content.mixers) {
    for (const rec of content.mixers.values()) {
      try { rec.mixer.stopAllAction(); rec.mixer.uncacheRoot(rec.root); } catch (e) { /* 旧 mixer 停不下来不影响整场重建 */ }
    }
    content.mixers.clear();
  }
  if (content.joints) content.joints.clear();
  content.group.traverse(o => {
    if (o.isInstancedMesh && o.geometry) { try { o.geometry.dispose(); } catch (e) { /* 群众合批几何各建各的 */ } }
    if (o.isLineSegments && o.material && o.userData.outlineOf) { try { o.material.dispose(); } catch (e) { /* 描边材质各建各的 */ } }
  });
  try { content.group.clear(); } catch (e) { /* 同上 */ }
}
export function disposeAllCaches() {
  disposeGeoCache();
  disposeMaterials();
  clearEdgeCache();
  for (const t of panoCache.values()) { try { t.dispose(); } catch (e) { /* 全景纹理释放失败不影响重建 */ } }
  panoCache.clear();
}

/* 场景包围盒：取景（近景 / 中景 / 全景）与阴影相机收紧都读它。 */
export function boundsOf(content) {
  const box = new THREE.Box3();
  if (content && content.group) box.setFromObject(content.group);
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1.8, 1));
  return box;
}

export { THREE };
