#!/usr/bin/env node
/* 画布文档：默认值、收敛（sanitize）、校验、导入导出与摘要（纯函数）。 */
import assert from 'node:assert/strict';
import { DOC_V, LIMITS, newDoc, newNode, newConnection, cleanMeta, sanitizeDoc, validDoc,
  exportDoc, importDoc, indexRecord, docSummary, findNode, inputCount, typesInUse }
  from '../web/domain/canvas/doc.js';

/* ---------- 新建与默认值 ---------- */
const d = newDoc({ id: 'cv_a', title: '一支片子' });
assert.equal(d.v, DOC_V);
assert.equal(d.id, 'cv_a');
assert.equal(d.title, '一支片子');
assert.deepEqual(d.nodes, []);
assert.deepEqual(d.viewport, { x: 0, y: 0, scale: 1 });
assert.equal(d.revision, 0);
assert.equal(d.createdAt, d.updatedAt);
assert.equal(newDoc({}).title, '未命名画布');
assert.match(newDoc({}).id, /^cv_/);
assert.equal(newDoc({ title: 'x'.repeat(500) }).title.length, LIMITS.title);   // 标题夹到上限

/* 类型不认识就落回文本；尺寸按注册表的默认值/下限夹 */
assert.equal(newNode({ type: 'nope' }).type, 'text');
assert.equal(newNode({ type: 'image' }).width, 288);
assert.equal(newNode({ type: 'image', width: 5, height: 5 }).width, 96);        // 夹到该型下限
assert.equal(newNode({ type: 'image', width: 9e9 }).width, LIMITS.side);
assert.equal(newNode({ x: NaN, y: '12' }).x, 0);
assert.equal(newNode({ x: NaN, y: '12' }).y, 12);
assert.equal(newConnection({ fromNodeId: 'a', toNodeId: 'b' }).fromNodeId, 'a');

/* ---------- metadata 白名单：密钥形状与未知字段一律不进文档 ---------- */
assert.deepEqual(Object.keys(cleanMeta({ content: '正文', token: 'sk-1', apiKey: 'x', 随便: 1 })),
  ['content', 'status']);
assert.equal(cleanMeta({ status: 'loading' }).status, 'loading');
assert.equal(cleanMeta({ status: '跑起来了' }).status, 'idle');                 // 不认识的落回 idle
assert.deepEqual(cleanMeta({ params: ['a'] }).params, {});                       // 数组不是参数表
assert.deepEqual(cleanMeta({ params: { ar: '16:9' } }).params, { ar: '16:9' });
assert.equal(cleanMeta({ error: 'x'.repeat(2000) }).error.length, 400);
/* 产物号只对能装素材的档有意义：文本/配置存它只会让导出件里出现假引用 */
assert.equal(cleanMeta({ assetId: 'as_1' }, 'text').assetId, undefined);
assert.equal(cleanMeta({ assetId: 'as_1' }, 'image').assetId, 'as_1');
assert.equal(cleanMeta({ assetId: 'as_1' }, 'asset-ref').assetId, 'as_1');

/* ---------- sanitize：坏元素丢掉，坏连线不留下悬端 ---------- */
const raw = { id: 'cv_s', title: '脏的', nodes: [
  { id: 'n1', type: 'text', metadata: { content: '一', token: 'sk-live' } },
  { id: 'n1', type: 'image' },                                                  // 重复 id
  null, '不是对象',
  { id: 'n3', type: '没这种', x: 1e12 },
], connections: [
  { id: 'c1', fromNodeId: 'n1', toNodeId: 'n3' },
  { id: 'c2', fromNodeId: 'n1', toNodeId: 'n3' },                               // 同一对再来一次
  { id: 'c3', fromNodeId: 'n1', toNodeId: '不存在' },                            // 悬空
  { id: 'c4', fromNodeId: 'n3', toNodeId: 'n3' },                               // 自连
  null,
], viewport: { x: '3', y: NaN, scale: 99 } };
const s = sanitizeDoc(raw);
assert.equal(s.nodes.length, 3);
assert.equal(new Set(s.nodes.map(n => n.id)).size, 3, '重复 id 必须换成新的');
assert.equal(s.nodes[2].type, 'text');
assert.equal(s.nodes[2].x, LIMITS.side);
assert.equal(s.connections.length, 1);
assert.deepEqual(s.viewport, { x: 3, y: 0, scale: LIMITS.scaleMax });
assert.equal(JSON.stringify(s).includes('sk-live'), false, '密钥形状不许活过 sanitize');
assert.equal(validDoc(s).ok, true);
assert.equal(sanitizeDoc(null).nodes.length, 0);

/* ---------- 校验器要拦的四种 ---------- */
assert.equal(validDoc(null).ok, false);
assert.equal(validDoc({ nodes: [], connections: [] }).ok, true, '空画布是合法的');
assert.equal(validDoc({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10 },
  { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10 }], connections: [] }).why, '节点 id 重复：a');
assert.equal(validDoc({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 0, height: 10 }], connections: [] }).why, '节点尺寸必须为正');
assert.equal(validDoc({ nodes: [{ id: 'a', type: 'nope', x: 0, y: 0, width: 10, height: 10 }], connections: [] }).ok, false);
const two = [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10 }, { id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10 }];
assert.equal(validDoc({ nodes: two, connections: [{ id: 'c', fromNodeId: 'a', toNodeId: 'a' }] }).why, '连线不能自己连自己');
assert.equal(validDoc({ nodes: two, connections: [{ id: 'c', fromNodeId: 'a', toNodeId: 'b' }, { id: 'd', fromNodeId: 'a', toNodeId: 'b' }] }).why, '同一对节点已有连线');
assert.equal(validDoc({ nodes: two, connections: [{ id: 'c', fromNodeId: 'a', toNodeId: 'zz' }] }).why, '连线两端有已经不存在的节点');

/* ---------- 导入导出是一条闭环 ---------- */
const doc = sanitizeDoc({ id: 'cv_e', title: '导出一份',
  nodes: [{ id: 'a', type: 'text', metadata: { content: '你好' } }, { id: 'b', type: 'image' }],
  connections: [{ fromNodeId: 'a', toNodeId: 'b' }] });
const ex = exportDoc(doc);
assert.equal(ex.ok, true);
const im = importDoc(ex.text);
assert.equal(im.ok, true);
assert.equal(im.doc.id, 'cv_e');
assert.equal(im.doc.nodes.length, 2);
assert.equal(im.doc.connections.length, 1);
assert.equal(im.doc.nodes[0].metadata.content, '你好');
assert.equal(importDoc('').why, '空的');
assert.equal(importDoc('{ 坏掉的').ok, false);
assert.match(importDoc('{"kind":"wb-canvas","doc":{"nodes":"不是数组"}}').why, /缺少 nodes 数组/);
/* 裸文档（没有 kind 外壳）也要收：用户手抄的 JSON 常是这样 */
assert.equal(importDoc(JSON.stringify(doc)).ok, true);
assert.equal(importDoc('{"kind":"wb-canvas","doc":null}').why, '文件里没有画布文档');
assert.equal(exportDoc({ nodes: '坏' }).ok, false, '导出不合法的文档要拒绝');
const huge = JSON.stringify({ nodes: [{ id: 'a', type: 'text', metadata: { content: 'x'.repeat(LIMITS.importBytes + 10) } }] });
assert.match(importDoc(huge).why, /太大/);

/* ---------- 索引条目 / 摘要 / 读法 ---------- */
const rec = indexRecord(doc);
assert.equal(rec.id, 'cv_e');
assert.equal(rec.nodeCount, 2);
assert.equal(rec.coverNodeId, 'b', '有产物的节点优先当封面');
assert.equal(indexRecord(newDoc()).coverNodeId, '');
assert.equal(indexRecord(doc, { createdAt: 111 }).createdAt, 111, '首次创建时间要留着');
const sum = docSummary(doc, 1);
assert.equal(sum.节点数, 2);
assert.equal(sum.截断, true);
assert.equal(sum.节点.length, 1);
assert.equal(sum.节点[0].摘要, '你好');
assert.equal(sum.节点[0].有产物, false);
assert.equal(docSummary(sanitizeDoc({ nodes: [{ id: 'a', type: 'image', metadata: { assetId: 'as_1' } }] })).节点[0].有产物, true);
assert.equal(findNode(doc, 'a').type, 'text');
assert.equal(findNode(doc, 'nope'), null);
assert.equal(inputCount(doc, 'b'), 1);
assert.deepEqual(typesInUse(doc), { text: 1, image: 1 });
console.log('✓ 画布文档：默认值 / 收敛 / 校验 / 导入导出 / 摘要');
