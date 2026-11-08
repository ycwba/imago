#!/usr/bin/env node
/* 库模型 ↔ 场景实体：深拷贝 / 重发 id / 轨道带过来 / 存回库时根归零。 */
import assert from 'node:assert/strict';
import { normalizeDoc } from '../web/model3d/schema.js';
import { entityFromModel, modelFromEntity, subtreeIds } from '../web/model3d/entities.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

const model = normalizeDoc({
  kind: 'model',
  name: '椅子',
  scene: { nodes: [{ kind: 'group', id: 'g1', name: '椅子', children: [{ kind: 'prim', id: 'p1', shape: 'box' }] }] },
  anim: { duration: 6, tracks: [{ id: 't1', of: { kind: 'node', id: 'p1' }, keys: [{ t: 0, at: [0, 0, 0] }] }] },
}).doc;

const made = entityFromModel(model, '默认库 :: 椅子');
ok(made.entity.kind === 'group' && made.entity.name === '椅子', '根 group 直接复用');
ok(made.entity.id !== 'g1', '实体 id 重新发过');
ok(made.entity.fromModel === '默认库 :: 椅子', '记录来源模型');
ok(made.tracks.length === 1 && made.tracks[0].of.id === made.entity.children[0].id, '轨道改指到新 id');
ok(made.duration === 6, '动画时长跟着模型');

const ids = subtreeIds(made.entity);
ok(ids.has(made.entity.id) && ids.has(made.entity.children[0].id), '子树 id 全覆盖');

const multi = normalizeDoc({
  kind: 'model', name: '双机位',
  scene: {
    nodes: [{ kind: 'prim', id: 'p1', shape: 'box' }],
    cams: [{ id: 'c1', name: '正面', pos: [0, 1, 4], target: [0, 1, 0], fov: 35 }, { id: 'c2', name: '侧面', pos: [4, 1, 0], target: [0, 1, 0], fov: 35 }],
  },
  anim: { duration: 4, tracks: [
    { id: 't1', of: { kind: 'node', id: 'p1' }, keys: [] },
    { id: 't2', of: { kind: 'cam', id: 'c1' }, keys: [{ t: 0, at: [0, 1, 4] }] },
  ] },
}).doc;
const manyCams = entityFromModel(multi, '双机位', { includeCams: true });
ok(manyCams.cams.length === 2, '多机位一起带进场景');
ok(manyCams.cams[0].id !== 'c1' && manyCams.cams[1].id !== 'c2', '机位 id 重新发过');
ok(manyCams.camTracks.length === 1 && manyCams.camTracks[0].of.id === manyCams.cams[0].id, '相机轨道跟着机位重映射');
const oneCam = entityFromModel(normalizeDoc({ scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'box' }] } }).doc, '单机位', { includeCams: true });
ok(oneCam.cams.length === 0, '只有默认单机位时不重复加机位');

made.entity.at = [3, 0, 2];
made.entity.children[0].lib = '别的库';
made.entity.children[0].kind = 'asset';
made.entity.children[0].file = '_模型文件/长凳.fbx';
const back = modelFromEntity(made.entity, '椅子2', { library: '默认库', tracks: made.tracks, duration: made.duration });
ok(back.kind === 'model' && back.name === '椅子2', '存回库是模型文档');
ok(back.scene.nodes[0].at[0] === 0 && back.scene.nodes[0].at[2] === 0, '根 transform 归零');
ok(back.scene.nodes[0].fromModel === undefined, '来源不写进库模型');
ok(back.scene.nodes[0].children[0].lib === '别的库', '指向别的库的摆件保留 lib');
ok(back.anim.tracks.length === 1, '轨道一起存回');

console.log('✓ model3d-entities：' + n + ' 项通过');
