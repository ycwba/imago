#!/usr/bin/env node
/* 白膜文档 v3 的磁盘格式判据：
   1. skills/model3d/schema.json 能解析、引用全部指得到、枚举与 schema.js 的常量表同源；
   2. 一份覆盖每种节点 / 图元形状 / 轨道 / 机位 / 路径 / 出片条的文档，归一化后与稀疏写盘后都过 Schema；
   3. Schema 拒绝 normalizeDoc 也会拒绝的那些坏形状（缺 shape、环不够、路径越界……）；
   4. migrateDoc 把 v1 / v2 补齐成 v3，结果与 normalizeDoc 逐字段一致；不能降级；
   5. tools/migrate-model.cjs 在隔离目录里真跑：预览不写盘、--yes 落稀疏文件并留备份、再跑一遍 0 份。
   不装任何校验器依赖：下面是一份 JSON Schema 子集解释器，只认这份 Schema 用到的关键字。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MODEL_V, MODEL_VERSIONS, MIGRATIONS, migrateDoc, normalizeDoc, sparseDoc,
  emptyDoc, emptyScene, KINDS, SHAPES, TONES, ASPECTS, CLIP_LOOPS, TRACK_INTERPS, PATH_KINDS,
  LIGHT_SHAPES,
} from '../web/model3d/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCHEMA_FILE = path.join(REPO, 'skills', 'model3d', 'schema.json');
const CLI = path.join(REPO, 'tools', 'migrate-model.cjs');

let n = 0;
const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };
const deep = (a, b, msg) => { n += 1; assert.deepEqual(a, b, msg); };

/* ---------- JSON Schema 子集解释器 ---------- */

const KEYWORDS = new Set([
  '$schema', '$defs', '$ref', 'title', 'description', 'x-help',
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'pattern', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then',
]);

function typeOk(type, v) {
  if (type === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (type === 'array') return Array.isArray(v);
  if (type === 'string') return typeof v === 'string';
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'integer') return Number.isInteger(v);
  if (type === 'boolean') return typeof v === 'boolean';
  if (type === 'null') return v === null;
  return false;
}

function refTarget(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw new Error('只认本地 $ref：' + ref);
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) throw new Error('$ref 指不到：' + ref);
    cur = cur[seg];
  }
  return cur;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(schema, value, root, ptr, errors) {
  if (schema === true || schema == null) return;
  if (schema.$ref) check(refTarget(root, schema.$ref), value, root, ptr, errors);

  if (schema.type) {
    const list = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!list.some(t => typeOk(t, value))) { errors.push(ptr + ' 类型应为 ' + list.join('|')); return; }
  }
  if ('const' in schema && !sameJson(value, schema.const)) errors.push(ptr + ' 应恒为 ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.some(x => sameJson(x, value))) errors.push(ptr + ' 不在枚举里');
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(ptr + ' 小于 ' + schema.minimum);
    if (schema.maximum != null && value > schema.maximum) errors.push(ptr + ' 大于 ' + schema.maximum);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(ptr + ' 不大于 ' + schema.exclusiveMinimum);
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) errors.push(ptr + ' 不小于 ' + schema.exclusiveMaximum);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(ptr + ' 太短');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(ptr + ' 不匹配 ' + schema.pattern);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(ptr + ' 少于 ' + schema.minItems + ' 项');
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(ptr + ' 多于 ' + schema.maxItems + ' 项');
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => check(schema.items, item, root, ptr + '[' + i + ']', errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const key of (schema.required || [])) {
      if (!(key in value)) errors.push(ptr + ' 缺少 ' + key);
    }
    for (const key of Object.keys(value)) {
      if (props[key]) check(props[key], value[key], root, ptr + '.' + key, errors);
      else if (schema.additionalProperties === false) errors.push(ptr + ' 多出字段 ' + key);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, value[key], root, ptr + '.' + key, errors);
      }
    }
  }

  for (const sub of (schema.allOf || [])) check(sub, value, root, ptr, errors);
  if (schema.anyOf) {
    const hits = schema.anyOf.filter(sub => passes(sub, value, root, ptr)).length;
    if (!hits) errors.push(ptr + ' 不满足 anyOf 的任何一支');
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter(sub => passes(sub, value, root, ptr)).length;
    if (hits !== 1) errors.push(ptr + ' 应恰好命中 oneOf 一支，实际 ' + hits);
  }
  if (schema.not && passes(schema.not, value, root, ptr)) errors.push(ptr + ' 命中了 not');
  if (schema.if && passes(schema.if, value, root, ptr) && schema.then) check(schema.then, value, root, ptr, errors);
}

function passes(schema, value, root, ptr) {
  const bag = [];
  check(schema, value, root, ptr, bag);
  return bag.length === 0;
}

function validate(schema, value) {
  const errors = [];
  check(schema, value, schema, '$', errors);
  return errors;
}

function schemaNodes(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(x => schemaNodes(x, out)); return out; }
  out.push(node);
  for (const group of ['properties', '$defs']) {
    if (node[group]) for (const sub of Object.values(node[group])) schemaNodes(sub, out);
  }
  if (node.items) schemaNodes(node.items, out);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') schemaNodes(node.additionalProperties, out);
  for (const group of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[group])) node[group].forEach(x => schemaNodes(x, out));
  }
  if (node.not) schemaNodes(node.not, out);
  if (node.if) schemaNodes(node.if, out);
  if (node.then) schemaNodes(node.then, out);
  return out;
}

/* 文档字段只挂在 properties / items / additionalProperties 这三条路上；
   if / anyOf 里的 properties 是条件判断的辅助件，不是给人看的字段。 */
function docNodes(node, out) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const group of ['properties', '$defs']) {
    for (const sub of Object.values(node[group] || {})) docNodes(sub, out);
  }
  if (node.items) docNodes(node.items, out);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') docNodes(node.additionalProperties, out);
  return out;
}

/* ---------- Schema 自检 ---------- */
const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
{
  ok(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', '$schema 是 2020-12');
  ok(schema.type === 'object' && schema.additionalProperties === false, '根是封闭对象');
  ok(Array.isArray(schema.required) && schema.required.includes('scene'), '根要求 scene');

  const nodes = schemaNodes(schema, []);
  const used = new Set();
  for (const node of nodes) {
    for (const key of Object.keys(node)) ok(KEYWORDS.has(key), 'Schema 关键字都认识：' + key);
    if (node.$ref) {
      refTarget(schema, node.$ref);
      const name = node.$ref.replace(/^#\/\$defs\//, '');
      used.add(name);
    }
  }
  for (const node of docNodes(schema, [])) {
    for (const [field, sub] of Object.entries(node.properties || {})) {
      ok(typeof sub['x-help'] === 'string' && sub['x-help'].trim().length > 0, '字段带 x-help：' + field);
    }
  }
  for (const name of Object.keys(schema.$defs)) ok(used.has(name), '$defs 里的 ' + name + ' 有人引用');

  const def = name => schema.$defs[name];
  deep(def('node').properties.kind.enum, KINDS, '节点 kind 枚举与 schema.js 的 KINDS 同源');
  deep(def('node').properties.shape.enum, SHAPES, '图元 shape 枚举与 SHAPES 同源');
  deep(def('node').properties.tone.enum, TONES, '灰阶 tone 枚举与 TONES 同源');
  deep(def('node').properties.clipLoop.enum, CLIP_LOOPS, 'clipLoop 枚举与 CLIP_LOOPS 同源');
  deep(def('track').properties.interp.enum, TRACK_INTERPS, '轨道 interp 枚举与 TRACK_INTERPS 同源');
  deep(def('path').properties.kind.enum, PATH_KINDS, '路径 kind 枚举与 PATH_KINDS 同源');
  deep(def('view').properties.aspect.enum, ASPECTS, '画幅枚举与 ASPECTS 同源');
  deep(def('light').properties.shape.enum, LIGHT_SHAPES, '灯光 shape 枚举与 LIGHT_SHAPES 同源');
  deep(def('trackOf').properties.kind.enum, ['node', 'cam', 'light'], '轨道 of.kind 收节点 / 机位 / 灯光三种');
  deep(schema.properties.v.const, MODEL_V, 'v 的常量等于 MODEL_V');

  /* 三条约定（坐标 / fov 竖直 / rot 欧拉序 / scale 语义）在源码注释与 Schema 里说法一致 */
  const src = fs.readFileSync(path.join(REPO, 'web', 'model3d', 'schema.js'), 'utf8');
  ok(src.includes('`fov` 是**竖直**视场角'), 'schema.js 顶部写了「fov 是竖直视场角」');
  ok(src.includes('Rx·Ry·Rz') && src.includes('`scale` 接受数组或单个数'), 'schema.js 顶部写了欧拉序与 scale 语义');
  ok(def('cam').properties.fov['x-help'].includes('竖直'), '机位 fov 的 x-help 说明是竖直视场角');
  ok(def('node').properties.rot['x-help'].includes('Rx·Ry·Rz'), '节点 rot 的 x-help 写了欧拉序');
  ok(def('scale')['x-help'].includes('负数保留'), 'scale 的 x-help 写了负数保留（镜像）');
  const skill = fs.readFileSync(path.join(REPO, 'skills', 'model3d', 'SKILL.md'), 'utf8');
  ok(skill.includes('`fov` 是**竖直**视场角') && skill.includes('欧拉序 Rx·Ry·Rz')
    && skill.includes('负数保留（镜像写法）'), 'SKILL.md 写了同样的约定');
}

/* ---------- 覆盖每种形状的完整文档 ---------- */
const FULL = {
  v: 3, kind: 'scene', name: '全形状', group: '测试', note: '覆盖每种节点与轨道', ts: 1700000000000,
  scene: {
    nodes: [
      { kind: 'group', id: 'g1', name: '组', rot: [0, 45, 0], scale: 1, children: [
        { kind: 'prim', id: 'p-box', shape: 'box', size: [1, 2, 3], tone: 'lo', color: '#abc', mirror: true, array: { rows: 2, cols: 2, gapX: 1.44, gapZ: 0.76, jitter: 0.1 }, repeat: { n: 2, dx: 1 } },
        { kind: 'prim', id: 'p-sphere', shape: 'sphere', r: 0.7 },
        { kind: 'prim', id: 'p-cyl', shape: 'cylinder', r: 0.2, r2: 0.1, h: 2 },
        { kind: 'prim', id: 'p-cone', shape: 'cone', r: 0.3, h: 0.8, seg: 12 },
        { kind: 'prim', id: 'p-cap', shape: 'capsule', r: 0.2, h: 0.5 },
        { kind: 'prim', id: 'p-torus', shape: 'torus', r: 0.5, r2: 0.1 },
        { kind: 'prim', id: 'p-plate', shape: 'plate', size: [2, 0.1, 2] },
        { kind: 'prim', id: 'p-loft', shape: 'loft', seg: 8, rings: [
          { y: 0, rx: 0.5, rz: 0.5 }, { y: 1, rx: 0.4, rz: 0.4, cx: 0.1 },
        ], subdiv: 6 },
        { kind: 'prim', id: 'p-sweep', shape: 'loft', seg: 8,
          path: { kind: 'line', from: [0, 0, 0], to: [0, 2, 0] },
          profile: [[0.2, 0], [0.12, 1], [0.16, 2]] },
        { kind: 'prim', id: 'p-lathe', shape: 'lathe', seg: 16, profile: [[0.1, 0], [0.3, 0.2], [0.2, 1]] },
        { kind: 'prim', id: 'p-extrude', shape: 'extrude', depth: 0.3, poly: [[-0.5, 0], [0.5, 0], [0, 1]] },
      ] },
      { kind: 'mannequin', id: 'm1', body: 'female', pose: 'run', tone: 'mid', controls: { 'rightShoulder.pitch': 60 } },
      { kind: 'crowd', id: 'c1', body: 'chibi', pose: 'sit', rows: 5, cols: 4, gapX: 1, gapZ: 1.2, jitter: 0.2, tone: 'lo' },
      { kind: 'asset', id: 'a1', file: '_模型文件/长凳.fbx', lib: '道具库', clay: false, clip: 'idle', clipSpeed: 1.5, clipLoop: 'once', clipOffset: 0.5 },
      { kind: 'ref', id: 'r1', model: '角色/素体', fromModel: '角色/素体' },
    ],
    cams: [
      { id: 'cam-1', name: '正面', pos: [3.2, 2.1, 4.2], target: [0, 1, 0], fov: 35, follow: 'm1' },
      { id: 'cam-2', pos: [0, 5, 0], target: [0, 0, 0], fov: 60 },
    ],
    active: 'cam-2',
    lights: [
      { id: 'l-key', name: '主光', shape: 'sun', at: [-3.2, 4.1, 2.6], target: [0, 0.8, 0], energy: 2.1, color: '#ffffff', shadow: { on: true, mapSize: 2048, bias: -0.0005, normalBias: 0.02 } },
      { id: 'l-rim', name: '轮廓光', shape: 'spot', at: [2.4, 1.6, -2.2], target: [0, 0.8, 0], energy: 40, color: '#8fb8ff', angle: 0.5, penumbra: 0.6, distance: 8, follow: 'm1' },
      { id: 'l-dot', shape: 'point', at: [1, 1, 1], energy: 10, distance: 0 },
    ],
    light: { hemi: { sky: '#ffffff', ground: '#d9d4cc', energy: 1.35 }, ground: { color: '#1a1a1a', opacity: 0.16 }, exposure: 1.1 },
    panorama: { src: 'https://example.com/pan.jpg', yaw: 90, radius: 30 },
    view: { mode: 'camera', aspect: '9:16', grid: false, ground: false, outline: false },
  },
  anim: {
    duration: 6, fps: 30, loop: false,
    tracks: [
      { id: 't1', of: { kind: 'node', id: 'g1' }, color: 2, interp: 'linear', keys: [
        { t: 0, at: [0, 0, 0], scale: [1, 1, 1] },
        { t: 2, at: [1, 0, 0], rot: [0, 90, 0], scale: [2, 2, 2], visible: false, ease: 'hold' },
      ] },
      { id: 't2', of: { kind: 'node', id: 'm1' }, motion: { kind: 'walk', speed: 0.8, stride: 1.1, arm: 0.9 }, path: { kind: 'line', to: [0, 0, 5] } },
      { id: 't3', of: { kind: 'node', id: 'm1' }, joint: 'torso/leftShoulder', keys: [
        { t: 0, rot: [0, 0, 0] }, { t: 1, rot: [10, 0, 0] },
      ] },
      { id: 't4', of: { kind: 'node', id: 'm1' }, path: { kind: 'circle', radius: 2, clockwise: true } },
      { id: 't5', of: { kind: 'node', id: 'm1' }, path: { kind: 'rect' } },
      { id: 't6', of: { kind: 'node', id: 'm1' }, path: { kind: 'free', closed: true, pts: [[0, 0, 0], [1, 0, 1], [2, 0, 0]] } },
      { id: 't7', of: { kind: 'cam', id: 'cam-2' }, enabled: false, offset: 1, speed: 2, duration: 2, solo: true, keys: [
        { t: 0, target: [0, 1, 0] }, { t: 3, target: [1, 1, 0], fov: 50 },
      ] },
      { id: 't10', of: { kind: 'cam', id: 'cam-2' }, path: { kind: 'circle', from: [0, 0, 0], radius: 2, look: 'target', lookAt: 'm1' } },
      { id: 't11', of: { kind: 'node', id: 'm1' }, follow: 'g1', keysMode: 'offset',
        path: { kind: 'line', to: [0, 0, 3] }, keys: [{ t: 0, at: [0, 1, 0] }] },
      { id: 't8', of: { kind: 'node', id: 'g1' }, path: { kind: 'line' } },
      { id: 't9', of: { kind: 'light', id: 'l-key' }, keys: [
        { t: 0, at: [-3.2, 4.1, 2.6], energy: 2.1 }, { t: 3, at: [3.2, 4.1, 2.6], energy: 3, color: '#ffd9a0' },
      ] },
    ],
  },
  out: [
    { id: 'o1', assetId: 'la_1', url: 'https://example.com/a.png', name: '图', at: 1700000000000, picked: false },
    { id: 'o2', type: 'video' },
  ],
  src: { prompt: '一座桥', reuse: { id: '场景/桥', mode: 'as-is', why: '沿用' } },
};

const full = normalizeDoc(FULL).doc;
const sparse = sparseDoc(full);

{
  deep(validate(schema, emptyDoc()), [], '空模型过 Schema');
  deep(validate(schema, emptyScene('街景', '第一幕')), [], '空场景过 Schema');
  deep(validate(schema, { scene: { nodes: [] } }), [], '只写 scene.nodes 的最小文档过 Schema（默认值都可省）');
  deep(validate(schema, full), [], '归一化后的完整文档过 Schema');
  deep(validate(schema, sparse), [], '稀疏写盘的完整文档过 Schema');

  const t5 = sparse.anim.tracks.find(t => t.id === 't5');
  deep(t5.path, { kind: 'rect' }, 'rect 路径只写非默认的那一格');
  const t8 = sparse.anim.tracks.find(t => t.id === 't8');
  deep(t8.path, {}, '全默认的 line 路径稀疏成空对象');
  deep(validate(schema, sparse), [], '空对象的 path 仍算合法（kind 省略按 line 读）');

  deep(normalizeDoc(sparse).doc, full, '稀疏写盘再归一化与原来逐字段一致');
  deep(validate(schema, { scene: { nodes: [{ kind: 'group', id: 'g', scale: 2 }] } }), [], 'scale 可以是单个数字');
  deep(validate(schema, { scene: { nodes: [{ kind: 'group', id: 'g' }] }, anim: { tracks: [
    { id: 't', of: { kind: 'node', id: 'g' }, path: {} },
  ] } }), [], '只写空 path 的轨道合法');
  deep(validate(schema, { scene: { nodes: [], cams: [{ id: 'c', fov: 179.9 }] } }), [], 'fov 边界以内合法');
}

/* ---------- 坏形状必须被拒 ---------- */
{
  const bad = [
    ['缺 scene', { v: 3 }],
    ['多出顶层字段', { scene: { nodes: [] }, extra: true }],
    ['版本还是 v2', { v: 2, scene: { nodes: [] } }],
    ['不认识的节点 kind', { scene: { nodes: [{ kind: 'nope', id: 'x' }] } }],
    ['prim 缺 shape', { scene: { nodes: [{ kind: 'prim', id: 'x' }] } }],
    ['loft 只有一环', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'loft', rings: [{ rx: 1, rz: 1 }] }] } }],
    ['lathe 只有一点', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'lathe', profile: [[0, 0]] }] } }],
    ['extrude 只有两点', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'extrude', poly: [[0, 0], [1, 0]] }] } }],
    ['asset 路径不在 _模型文件 下', { scene: { nodes: [{ kind: 'asset', id: 'x', file: '模型/长凳.fbx' }] } }],
    ['asset 路径带 ..', { scene: { nodes: [{ kind: 'asset', id: 'x', file: '_模型文件/../长凳.fbx' }] } }],
    ['ref 缺 model', { scene: { nodes: [{ kind: 'ref', id: 'x' }] } }],
    ['节点多出字段', { scene: { nodes: [{ kind: 'group', id: 'x', extra: 1 }] } }],
    ['size 只有两维', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'box', size: [1, 2] }] } }],
    ['tone 不在枚举里', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'box', tone: 'ultra' }] } }],
    ['seg 小于 3', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'sphere', seg: 2 }] } }],
    ['repeat.n 不是整数', { scene: { nodes: [{ kind: 'prim', id: 'x', shape: 'box', repeat: { n: 2.5 } }] } }],
    ['色值不是十六进制', { scene: { nodes: [{ kind: 'group', id: 'x', color: 'red' }] } }],
    ['scale 是字符串', { scene: { nodes: [{ kind: 'group', id: 'x', scale: '2' }] } }],
    ['轨道既没 keys 也没 path', { scene: { nodes: [{ kind: 'group', id: 'x' }] }, anim: { tracks: [
      { id: 't', of: { kind: 'node', id: 'x' } },
    ] } }],
    ['free 路径缺 pts', { scene: { nodes: [{ kind: 'group', id: 'x' }] }, anim: { tracks: [
      { id: 't', of: { kind: 'node', id: 'x' }, path: { kind: 'free' } },
    ] } }],
    ['轨道色号为负', { scene: { nodes: [{ kind: 'group', id: 'x' }] }, anim: { tracks: [
      { id: 't', of: { kind: 'node', id: 'x' }, color: -1, path: { kind: 'line' } },
    ] } }],
    ['机位一个都没有', { scene: { nodes: [], cams: [] } }],
    ['fov 到 180', { scene: { nodes: [], cams: [{ id: 'c', fov: 180 }] } }],
    ['画幅不认识', { scene: { nodes: [], view: { aspect: '21:9' } } }],
  ];
  for (const [label, doc] of bad) {
    const errors = validate(schema, doc);
    ok(errors.length > 0, 'Schema 拒绝：' + label);
  }
}

/* ---------- 版本表与迁移函数 ---------- */
{
  deep(MODEL_VERSIONS.map(x => x.v), [1, 2, 3], '版本表从 v1 排到 v3');
  ok(MODEL_V === 3, 'MODEL_V 是 3');
  ok(MODEL_VERSIONS.find(x => x.v === 2).changed.includes('未发布'), 'v2 在表里写明从未发布');

  const v1Raw = {
    v: 1, name: '旧模型', ts: 1700000000000, scene: {
      nodes: [{ kind: 'prim', id: 'p', shape: 'box' }, { kind: 'mannequin', id: 'm', pose: 'walk' }],
      camera: { id: 'cam-old', pos: [1, 2, 3], target: [0, 0, 0], fov: 50 },
    },
    anim: { tracks: [{ id: 'tr1', nodeId: 'm', keys: [{ t: 0, at: [0, 0, 0] }, { t: 1, at: [1, 0, 0] }] }] },
  };
  const v1 = normalizeDoc(v1Raw).doc;
  deep(migrateDoc(v1Raw, 1, 3), v1, 'v1 迁到 v3 与 normalizeDoc 逐字段一致');
  ok(v1.scene.cams[0].id === 'cam-old' && v1.scene.active === 'cam-old', 'v1 的单机位翻成 cams[] + active');
  ok(v1.anim.tracks[0].of.kind === 'node' && v1.anim.tracks[0].of.id === 'm', 'v1 的 tr.nodeId 翻成 of');
  deep(validate(schema, sparseDoc(v1)), [], 'v1 迁移后的稀疏形态过 Schema');

  const v2Raw = {
    v: 2, kind: 'scene', name: '旧景', ts: 1700000000000, scene: {
      nodes: [{ kind: 'prim', id: 'p', shape: 'box' }],
      cams: [{ id: 'c1', fov: 60 }], active: 'c1',
    },
    anim: { duration: 3, tracks: [{ id: 't', of: { kind: 'cam', id: 'c1' }, keys: [
      { t: 0, target: [0, 1, 0] }, { t: 2, target: [1, 1, 0] },
    ] }] },
  };
  deep(migrateDoc(v2Raw, 2, 3), normalizeDoc(v2Raw).doc, 'v2 迁到 v3 与 normalizeDoc 逐字段一致');
  deep(validate(schema, sparseDoc(normalizeDoc(v2Raw).doc)), [], 'v2 迁移后的稀疏形态过 Schema');
  ok(MIGRATIONS['1>3'] && MIGRATIONS['2>3'], '迁移表登记了 1>3 与 2>3');

  const copy = migrateDoc(full, 3, 3);
  deep(copy, full, '同版本迁移原样返回');
  ok(copy !== full && copy.scene !== full.scene, '同版本返回的是副本，不是同一个对象');
  assert.throws(() => migrateDoc(full, 3, 1), /不能降级/, '降级要报错');
  assert.throws(() => migrateDoc(full, 1, 4), /没有 1 → 4 的迁移/, '没有的迁移要报错');
  assert.throws(() => migrateDoc(full, 'x', 3), /正整数/, '版本号不是数字要报错');
  n += 3;
}

/* ---------- 迁移器真跑一遍（隔离目录） ---------- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imago-model3d-format-'));
  try {
    const root = path.join(tmp, '白膜');
    const v1File = path.join(root, '默认库', '模型', '道具', '旧件.json');
    const v2File = path.join(root, '默认库', '场景', '第一幕', '旧景.json');
    const v3File = path.join(root, '默认库', '模型', '道具', '新版.json');
    const binFile = path.join(root, '默认库', '_模型文件', '别动.json');
    const trashFile = path.join(root, '.trash', '别动.json');
    const v1Raw = {
      v: 1, name: '旧件', ts: 1700000000000, scene: {
        nodes: [{ kind: 'mannequin', id: 'm', pose: 'walk' }],
        camera: { id: 'cam-old', pos: [1, 2, 3], fov: 50 },
      },
      anim: { tracks: [{ id: 'tr1', nodeId: 'm', keys: [{ t: 0, at: [0, 0, 0] }, { t: 1, at: [1, 0, 0] }] }] },
    };
    const v2Raw = {
      v: 2, kind: 'scene', name: '旧景', ts: 1700000000000,
      scene: { nodes: [{ kind: 'prim', id: 'p', shape: 'box' }] },
      anim: { duration: 3, tracks: [{ id: 't', of: { kind: 'node', id: 'p' }, keys: [{ t: 0, at: [0, 0, 0] }] }] },
    };
    const v3Raw = { v: 3, name: '新版', ts: 1700000000000, scene: { nodes: [{ kind: 'group', id: 'g' }] } };
    for (const [file, doc] of [[v1File, v1Raw], [v2File, v2Raw], [v3File, v3Raw], [binFile, v1Raw], [trashFile, v1Raw]]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    }
    const read = f => fs.readFileSync(f, 'utf8');
    const bytes = { v1: read(v1File), v2: read(v2File), v3: read(v3File), bin: read(binFile), trash: read(trashFile) };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: REPO });

    const preview = run('--from', '1', '--to', '3', '--dir', tmp);
    ok(preview.status === 0, '预览退出码 0：' + preview.stderr);
    ok(preview.stdout.includes('待迁移 1'), '预览报出 1 份待迁移：' + preview.stdout);
    ok(read(v1File) === bytes.v1, '预览不写盘');

    const first = run('--from', '1', '--to', '3', '--dir', tmp, '--yes');
    ok(first.status === 0, '迁移 v1 退出码 0：' + first.stderr);
    const migratedV1 = JSON.parse(read(v1File));
    deep(migratedV1.v, 3, '旧件升到 v3');
    deep(validate(schema, migratedV1), [], '迁移器写出的旧件过 Schema');
    deep(normalizeDoc(migratedV1).doc, normalizeDoc(v1Raw).doc, '迁移器写出的旧件与 normalizeDoc 补全一致');
    ok(read(v2File) === bytes.v2, '--from 1 不动 v2 文件');
    ok(read(v3File) === bytes.v3, '已是 v3 的文件一个字节都不动');
    ok(read(binFile) === bytes.bin && read(trashFile) === bytes.trash, '_模型文件 与 .trash 不扫');
    const stampDirs = fs.readdirSync(path.join(root, '.trash')).filter(name => name.startsWith('model-migrate-'));
    ok(stampDirs.length === 1, '原文件备份到一个 model-migrate-* 目录');
    const backup = path.join(root, '.trash', stampDirs[0], '默认库', '模型', '道具', '旧件.json');
    ok(fs.existsSync(backup) && read(backup) === bytes.v1, '备份是逐字节的原文件');

    const second = run('--from', '2', '--to', '3', '--dir', tmp, '--yes');
    ok(second.status === 0, '迁移 v2 退出码 0：' + second.stderr);
    deep(validate(schema, JSON.parse(read(v2File))), [], '迁移器写出的旧景过 Schema');

    const again = run('--from', '2', '--to', '3', '--dir', tmp, '--yes');
    ok(again.status === 0 && again.stdout.includes('待迁移 0'), '再跑一遍报 0 份：' + again.stdout);
    ok(again.stdout.includes('没有要迁的'), '再跑一遍直接收工');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('✓ model3d-format：' + n + ' 项通过');
