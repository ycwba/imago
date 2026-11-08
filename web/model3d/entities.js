/* 库模型 ↔ 场景实体。白模库里的模型是模板，放进场景时深拷贝成一个普通实体；
   场景里改的是副本，白模库原模型不动。保存回库时再序列化成 model 文档。

   这里只做纯数据：不碰 DOM、不碰网络、不碰 three。 */

import { cloneDoc, emptyDoc, newId, walkNodes } from './schema.js';

function prefixOf(node) {
  if (node.kind === 'mannequin') return 'm';
  if (node.kind === 'crowd') return 'c';
  if (node.kind === 'asset') return 'a';
  if (node.kind === 'group') return 'e';
  return 'n';
}

/* 给一棵子树重新发 id，返回 oldId -> newId。 */
export function remapTree(nodes) {
  const map = new Map();
  walkNodes(nodes, n => {
    const old = n.id;
    n.id = newId(prefixOf(n));
    map.set(old, n.id);
  });
  return map;
}

export function subtreeIds(node) {
  const set = new Set();
  if (!node) return set;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (n.id) set.add(n.id);
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return set;
}

/* 库模型 → 场景实体。modelDoc 必须已经 resolve 过 ref。
   `includeCams`：模型里带多机位 / 机位运镜时，把机位与相机轨道一起带进场景；
   只有一个默认机位、没有运镜的普通模型不会重复加一个「机位 1」。 */
export function entityFromModel(modelDoc, modelId, opts = {}) {
  const nodes = cloneDoc((modelDoc && modelDoc.scene && modelDoc.scene.nodes) || []);
  const map = remapTree(nodes);
  const sourceTracks = cloneDoc((modelDoc && modelDoc.anim && modelDoc.anim.tracks) || []);
  const sourceCams = cloneDoc((modelDoc && modelDoc.scene && modelDoc.scene.cams) || []);
  const hasCamTrack = sourceTracks.some(t => t && t.of && t.of.kind === 'cam');
  const withCams = !!opts.includeCams && (sourceCams.length > 1 || hasCamTrack);
  const camMap = new Map();
  const cams = withCams ? sourceCams.map(c => {
    const id = newId('cam');
    camMap.set(c.id, id);
    return { ...c, id };
  }) : [];
  const tracks = sourceTracks
    .filter(t => t && t.of && t.of.kind === 'node' && map.has(t.of.id))
    .map(t => ({
      ...t,
      id: newId('t'),
      of: { kind: 'node', id: map.get(t.of.id) },
    }));
  const camTracks = withCams ? sourceTracks
    .filter(t => t && t.of && t.of.kind === 'cam' && camMap.has(t.of.id))
    .map(t => ({
      ...t,
      id: newId('t'),
      of: { kind: 'cam', id: camMap.get(t.of.id) },
    })) : [];
  /* 从场景存回库的模型通常只有一个根 group；放回场景时直接复用这个根，
     不再套一层同名 group。 */
  let entity;
  if (nodes.length === 1 && nodes[0].kind === 'group') {
    entity = nodes[0];
    entity.name = (modelDoc && modelDoc.name) || entity.name || modelId;
    entity.fromModel = modelId;
  } else {
    entity = {
      kind: 'group',
      id: newId('e'),
      name: (modelDoc && modelDoc.name) || modelId,
      fromModel: modelId,
      at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
      children: nodes,
    };
  }
  return {
    entity, tracks, cams, camTracks,
    duration: Number(modelDoc && modelDoc.anim && modelDoc.anim.duration) || 0,
    fps: Number(modelDoc && modelDoc.anim && modelDoc.anim.fps) || 0,
    loop: modelDoc && modelDoc.anim && modelDoc.anim.loop != null ? modelDoc.anim.loop !== false : null,
  };
}

/* 场景实体 → 库模型文档。根位置归零，内部组件状态原样保留。 */
export function modelFromEntity(entity, name, opts = {}) {
  const copy = cloneDoc(entity);
  copy.at = [0, 0, 0];
  copy.rot = [0, 0, 0];
  copy.scale = [1, 1, 1];
  delete copy.fromModel;
  /* 摆件上的 `lib` 是跨库来源：落回目标库时去掉指向该库的那一层；
     指向别的库的保留，模型换库后仍能读到原文件。 */
  walkNodes([copy], n => { if (!opts.library || n.lib === opts.library) delete n.lib; });
  const ids = subtreeIds(copy);
  const doc = emptyDoc(name || copy.name || '实体');
  doc.kind = 'model';
  doc.scene.nodes = [copy];
  const tracks = (opts.tracks || [])
    .filter(t => t && t.of && t.of.kind === 'node' && ids.has(t.of.id))
    .map(t => cloneDoc(t));
  doc.anim.tracks = tracks;
  if (opts.duration) doc.anim.duration = opts.duration;
  if (opts.fps) doc.anim.fps = opts.fps;
  if (opts.loop != null) doc.anim.loop = opts.loop !== false;
  return doc;
}
