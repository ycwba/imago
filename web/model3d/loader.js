/* 本地 3D 文件导入 —— `.fbx` / `.obj` / `.glb` / 内嵌 `.gltf` 四种，交给 vendored three 的 loader。
   这一层的职责只有四件：

   1. **按扩展名分派**（唯一一处判据：accept 文案、上传闸、解析器都读这一张表）；
   2. **白膜化**：`clay` 打开时把整棵树换成同一份黏土材质（白膜只收灰阶，不收贴图颜色）；
   3. **归一**：导入件高度统一成 1 米、脚底落在 y=0、水平居中 —— 用户在视口里拖的是「一个 1 米高的摆件」，
      不是某个导出器留下的、动不动 100 倍的尺寸；灯与相机从文件里剔掉（它们是文件里的布光，不是白膜的灯）；
   4. **缓存**：同一份文件只解析一次（流式重建一秒能重建十几次，重复 parse 一个 20 MB 的 FBX 会卡死）。

   不支持的东西**当场说清楚**（不是静默失败）：Draco / KTX2 压缩、OBJ 的 MTL 与贴图外链、.gltf 的外链 .bin。
   文件自带的 `animations` 会保留下来交给 clip.js 播放；骨骼数量不设上限。 */

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { OBJLoader } from '../vendor/three/OBJLoader.js';
import { FBXLoader } from '../vendor/three/FBXLoader.js';
import { clone as cloneSkinned } from '../vendor/three/SkeletonUtils.js';
import { CLAY } from './palette.js';

export const ASSET_EXT = ['.fbx', '.obj', '.glb', '.gltf'];
const KIND_BY_EXT = { '.fbx': 'fbx', '.obj': 'obj', '.glb': 'glb', '.gltf': 'gltf' };

export function extOf(name) {
  const s = String(name == null ? '' : name).toLowerCase();
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i);
}
export function assetKind(name) {
  return KIND_BY_EXT[extOf(name)] || '';
}
export function isAssetName(name) {
  return !!assetKind(name);
}
export function acceptAttr() {
  return ASSET_EXT.join(',');
}

/* 黏土材质只有两份：普通网格一份，蒙皮网格一份（自阴影要双面，否则白膜上出现条纹）。
   导入件白膜化之后所有网格共用它们，重建时不产生第二份材质。 */
const clayMat = new THREE.MeshStandardMaterial({ color: CLAY.hi, roughness: 0.86, metalness: 0.02 });
const clayMatSkin = new THREE.MeshStandardMaterial({
  color: CLAY.hi, roughness: 0.86, metalness: 0.02, shadowSide: THREE.DoubleSide,
});

/* 把一棵导入树整成白膜：换材质、关掉文件里带的光与相机、统一投影开关。 */
export function applyClay(root) {
  root.traverse(o => {
    if (o.isLight || o.isCamera) { o.visible = false; return; }
    if (!o.isMesh) return;
    o.material = o.isSkinnedMesh ? clayMatSkin : clayMat;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return root;
}

/* 归一：高度 → `height` 米、脚底 y=0、水平中心在原点。
   包围盒退化（空模型 / 只有一个点）时原样返回，交给场景层当「空摆件」处理。 */
export function normalizeRoot(root, height = 1) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return root;
  const size = box.getSize(new THREE.Vector3());
  const h = Math.max(size.y, 1e-4);
  const k = (Number(height) || 1) / h;
  /* 缩放与位移都挂在外面那层 group 上：文件自己的根节点常带导出器的变换（FBX 的 0.01 很有名），
     改它自己的 position / scale 就会把那份变换算漏一层。 */
  const wrap = new THREE.Group();
  wrap.name = root.name || 'asset';
  wrap.scale.setScalar(k);
  wrap.add(root);
  wrap.position.set(
    -(box.min.x + box.max.x) / 2 * k,
    -box.min.y * k,
    -(box.min.z + box.max.z) / 2 * k
  );
  return wrap;
}

/* 文件里的光 / 相机剔掉：它们会让白膜的布光「跟着美术文件走」，同一个摆件换一份文件就变一张脸。 */
export function stripRig(root) {
  const kill = [];
  root.traverse(o => { if (o.isLight || o.isCamera) kill.push(o); });
  for (const o of kill) { if (o.parent) o.parent.remove(o); }
  return root;
}

/* 报错翻成人话：上游的 message 是英文的（DRACOLoader / KTX2 / Failed to load buffer），
   直接甩给用户等于没说。这几条覆盖实际会遇到的绝大多数。 */
export function friendlyError(name, err) {
  const msg = String((err && err.message) || err || '');
  if (/draco/i.test(msg)) return '这个文件用了 Draco 压缩，本期不支持（导出未压缩的 .glb / .fbx 再试）';
  if (/ktx2|basisu/i.test(msg)) return '这个文件用了 KTX2 压缩贴图，本期不支持（导出普通 PNG / JPEG 贴图再试）';
  if (/materials|mtl/i.test(msg)) return '这个 .obj 引用了外链的 .mtl / 贴图，本期只收不带贴图的 .obj';
  if (/\.bin|buffer|Failed to load|fetch|NetworkError/i.test(msg)) {
    return extOf(name) === '.gltf'
      ? '这个 .gltf 用了外链的 .bin / 贴图，本期只认自包含文件（换成 .glb）'
      : '这个文件的贴图 / 附属文件没跟过来，本期只认自包含文件';
  }
  if (/Unexpected token|JSON/i.test(msg)) return '这个文件的内容不是它扩展名声明的那种格式';
  return '这个 3D 文件读不出来：' + (msg || '格式不认识');
}

function countBones(root) {
  let n = 0;
  root.traverse(o => { if (o.isBone) n += 1; });
  return n;
}

/* 原始字节 → { proto, clips, bones, note }。`data` 是 ArrayBuffer（.obj 自己转成字符串）。
   骨骼数量不设上限：文件里有多少根就按多少根播。 */
export function parseBytes(name, data) {
  const kind = assetKind(name);
  if (!kind) return Promise.reject(new Error('只收 ' + ASSET_EXT.join(' / ') + ' 这几种 3D 文件'));
  return new Promise((resolve, reject) => {
    const settleWith = (obj, clips) => {
      try {
        if (!obj) throw new Error('文件里没有可用的网格');
        const proto = normalizeRoot(stripRig(obj));
        const list = (Array.isArray(clips) ? clips : []).filter(c => c && Array.isArray(c.tracks) && c.tracks.length);
        const bones = countBones(proto);
        resolve({ proto, clips: list, bones, note: '' });
      } catch (e) { reject(new Error(friendlyError(name, e))); }
    };
    const rejectParse = err => reject(new Error(friendlyError(name, err)));
    try {
      if (kind === 'obj') {
        settleWith(new OBJLoader().parse(new TextDecoder().decode(data)), []);
      } else if (kind === 'fbx') {
        const obj = new FBXLoader().parse(data, '');
        settleWith(obj, obj.animations);
      } else if (kind === 'glb') {
        new GLTFLoader().parse(data, '', g => settleWith(g.scene || g.scenes[0], g.animations), rejectParse);
      } else {
        const txt = new TextDecoder().decode(data);
        new GLTFLoader().parse(txt, '', g => settleWith(g.scene || g.scenes[0], g.animations), rejectParse);
      }
    } catch (e) { rejectParse(e); }
  });
}

/* 克隆一份摆件原型。必须走 SkeletonUtils：普通 clone(true) 会共享同一个 Skeleton，
   两个实例互相覆盖骨骼矩阵，表现为「两个角色同时做同一个动作且抖动」。 */
export function cloneAsset(proto) {
  return cloneSkinned(proto);
}

/* ---------------- 缓存：一份文件只解析一次 ---------------- */
const cache = new Map();          // file → Promise<{ proto, clips, bones, note }>（原型，调用方自己 clone）
export function clearAssetCache() {
  for (const p of cache.values()) {
    p.then(entry => {
      const proto = entry && entry.proto;
      if (!proto) return;
      proto.traverse(o => { if (o.isMesh && o.geometry) { try { o.geometry.dispose(); } catch (e) { /* 共享原型释放失败不影响重建 */ } } });
    }).catch(() => {});
  }
  cache.clear();
}

function fetchBytes(url) {
  if (typeof window !== 'undefined' && window.Net && window.Net.blob) {
    return window.Net.blob(url, { cache: 'no-store' }).then(b => b.arrayBuffer());
  }
  /* Node（判据里跑）：没有 Net 时走全局 fetch（本机回环的 URL 由调用方给全） */
  return fetch(url).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  });
}

const assetUrlOf = (file, library) => '/model3d/asset?library=' + encodeURIComponent(String(library || ''))
  + '&name=' + encodeURIComponent(String(file || ''));

/* 读一份导入文件（相对 `白膜/` 的路径，形如 `_模型文件/长凳.fbx`）。
   `clay` 默认 false：白膜化是**每个摆件节点自己的开关**（`node.clay`），scene.js 按节点决定；
   这里给 true 只是把原型本身也换成黏土（用不上贴图时省显存）。 */
export async function load(file, opts = {}) {
  const key = String(file || '');
  if (!key) throw new Error('这一格没有文件');
  if (!isAssetName(key)) throw new Error('只收 ' + ASSET_EXT.join(' / ') + ' 这几种 3D 文件');
  const cacheKey = String(opts.library || '') + '::' + key;
  let p = cache.get(cacheKey);
  if (!p) {
    p = fetchBytes(opts.url || assetUrlOf(key, opts.library))
      .then(buf => parseBytes(key, buf))
      .then(entry => { if (opts.clay) applyClay(entry.proto); return entry; });
    /* 失败不留在缓存里：用户换一份文件重试时不该继续拿上一次的错误 */
    p.catch(() => { cache.delete(cacheKey); });
    cache.set(cacheKey, p);
  }
  return p;
}

/* 错误 → 一句人话：浏览器里交给公共层（net.js 的 errText，全站唯一口径），
   Node（判据）里没有那一层，退回 message。 */
function errorLine(err) {
  if (typeof window !== 'undefined' && window.errText) return window.errText(err);
  if (!err) return '';
  return String(err.message ? err.message : err);
}

/* 一次读一批（页面在打开模型时用）：返回 Map<file, { proto, clips }>，坏的那份记一条人话，
   不影响别的摆件 —— 与「坏节点只丢该节点」同一个口径。 */
export async function loadAll(files, opts = {}) {
  const out = new Map();
  const notes = [];
  const list = Array.from(new Set((files || []).filter(Boolean)));
  await Promise.all(list.map(async f => {
    try {
      const entry = await load(f, opts);
      out.set(f, entry);
      if (entry && entry.note) notes.push(entry.note);
    } catch (e) { notes.push(errorLine(e)); }
  }));
  return { assets: out, notes };
}

/* 摆件在场景资源表里的键：跨库放进来的摆件带着自己的库名，同名文件才不会串库。 */
export function assetLookupKey(node) {
  const file = String((node && node.file) || '');
  const lib = String((node && node.lib) || '');
  return lib ? lib + '::' + file : file;
}

/* 摆件节点上要读的文件清单（页面与判据共用这一份，别各自遍历一遍） */
export function filesOf(nodes) {
  const out = [];
  const gatherFiles = list => {
    for (const n of list || []) {
      if (n && n.kind === 'asset' && n.file) out.push(n.file);
      if (n && n.children) gatherFiles(n.children);
    }
  };
  gatherFiles(nodes);
  return Array.from(new Set(out));
}
