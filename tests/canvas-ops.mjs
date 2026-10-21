#!/usr/bin/env node
/* 画布操作：一条 op 只做一件事、先验后写；连线规则问注册表；整批要么全做要么不动。 */
import assert from 'node:assert/strict';
import { sanitizeDoc, LIMITS } from '../web/domain/canvas/doc.js';
import { OPS, VIEW_OPS, BadOp, applyOperation, applyOperations } from '../web/domain/canvas/ops.js';
import { whyConnect, wouldCycle } from '../web/domain/canvas/registry.js';

const doc0 = sanitizeDoc({ id: 'cv_o', nodes: [
  { id: 't1', type: 'text', metadata: { content: '一句提示' } },
  { id: 'i1', type: 'image' },
  { id: 'v1', type: 'video' },
  { id: 'cf', type: 'config', metadata: { prov: 'VGENV', model: 'x', prompt: 'p' } },
], connections: [{ id: 'c1', fromNodeId: 't1', toNodeId: 'i1' }] });

assert.deepEqual(OPS.slice().sort(), ['add_node', 'connect_nodes', 'delete_connections', 'delete_nodes',
  'run_generation', 'select_nodes', 'set_viewport', 'update_node'].sort());
assert.deepEqual(VIEW_OPS, ['set_viewport', 'select_nodes'], '视图操作只有这两类能不进撤销栈');

/* ---------- add_node ---------- */
let r = applyOperation(doc0, { op: 'add_node', type: 'text', title: '新块', x: 20, y: 30 });
assert.equal(r.doc.nodes.length, 5);
assert.equal(r.changed.nodes.length, 1);
assert.equal(r.node.title, '新块');
assert.deepEqual(r.doc.selection, [r.node.id], '新节点要自己站到选中里');
assert.equal(r.doc.nodes !== doc0.nodes, true, '文档是不可变入参');
assert.throws(() => applyOperation(doc0, { op: 'add_node', type: '不存在' }), BadOp);
/* 撞号的 id 换一个新的，不是覆盖掉原来那一个 */
const dup = applyOperation(doc0, { op: 'add_node', id: 't1', type: 'text' });
assert.notEqual(dup.node.id, 't1');
assert.equal(dup.doc.nodes.filter(n => n.id === 't1').length, 1);
const full = { ...doc0, nodes: Array.from({ length: LIMITS.nodes }, (_, i) => ({ id: 'n' + i, type: 'text', x: 0, y: 0, width: 100, height: 100, metadata: {} })) };
assert.throws(() => applyOperation(full, { op: 'add_node', type: 'text' }), /上限/);

/* ---------- update_node：夹取值、合并 metadata ---------- */
const u = applyOperation(doc0, { op: 'update_node', id: 't1', patch: { title: '  改过的  ', x: 1e12, y: -1e12, metadata: { content: '新正文' } } });
const t1 = u.doc.nodes.find(n => n.id === 't1');
assert.equal(t1.title, '  改过的  ', '标题只截长度，不替用户 trim');
assert.equal(t1.x, LIMITS.side);
assert.equal(t1.y, -LIMITS.side);
assert.equal(t1.metadata.content, '新正文');
assert.equal(t1.metadata.status, 'idle', '没写的字段留着');
/* 尺寸下限听注册表的：压到比图标还小就再也点不回来了 */
assert.equal(applyOperation(doc0, { op: 'update_node', id: 'i1', patch: { width: 3, height: 3 } }).doc.nodes.find(n => n.id === 'i1').width, 96);
assert.equal(applyOperation(doc0, { op: 'update_node', id: 'cf', patch: { width: 0, height: 0 } }).doc.nodes.find(n => n.id === 'cf').width, 200);
assert.throws(() => applyOperation(doc0, { op: 'update_node', id: '没有这个', patch: {} }), /没有这个节点/);
/* 坏字段进不了文档：密钥形状被 cleanMeta 丢掉 */
assert.equal(applyOperation(doc0, { op: 'update_node', id: 'i1', patch: { metadata: { token: 'sk-live' } } }).doc.nodes.find(n => n.id === 'i1').metadata.token, undefined);

/* ---------- delete_nodes：连带连线照实报数 ---------- */
const del = applyOperation(doc0, { op: 'delete_nodes', ids: ['i1'] });
assert.equal(del.doc.nodes.length, 3);
assert.deepEqual(del.doc.connections, [], '端点没了的连线一起走');
assert.deepEqual(del.changed.connections, ['c1'], '被带走的线要出现在 changed 里');
assert.equal(del.连带连线数, 1);
assert.throws(() => applyOperation(doc0, { op: 'delete_nodes', ids: ['没有'] }), /没有这个节点/);
assert.throws(() => applyOperation(doc0, { op: 'delete_nodes', ids: [] }), /至少要一个 id/);
const one = sanitizeDoc({ nodes: [{ id: 'only', type: 'text' }] });
assert.throws(() => applyOperation(one, { op: 'delete_nodes', ids: ['only'] }), /不能把最后一个节点删掉/);

/* ---------- connect_nodes：规则只问注册表 ---------- */
assert.equal(whyConnect('text', 'image', 0), '');
assert.match(whyConnect('image', 'text', 0), /不接受/);
assert.match(whyConnect('config', 'config', 0), /两个配置节点之间不连线/);
assert.match(whyConnect('text', 'image', 8), /最多接 8 路输入/);
assert.equal(wouldCycle([{ fromNodeId: 'a', toNodeId: 'b' }], 'b', 'a'), true);
assert.equal(wouldCycle([{ fromNodeId: 'a', toNodeId: 'b' }], 'a', 'b'), false);
const conn = applyOperation(doc0, { op: 'connect_nodes', from: 'i1', to: 'v1' });
assert.equal(conn.doc.connections.length, 2);
assert.equal(conn.connection.fromNodeId, 'i1');
assert.throws(() => applyOperation(doc0, { op: 'connect_nodes', from: 't1', to: 'i1' }), /已经有连线/);
assert.throws(() => applyOperation(doc0, { op: 'connect_nodes', from: 't1', to: 't1' }), /自己连自己/);
assert.throws(() => applyOperation(doc0, { op: 'connect_nodes', from: 'i1', to: 't1' }), /不接受/);
const chain = sanitizeDoc({ nodes: [{ id: 'a', type: 'image' }, { id: 'b', type: 'image' }], connections: [{ id: 'x', fromNodeId: 'a', toNodeId: 'b' }] });
assert.throws(() => applyOperation(chain, { op: 'connect_nodes', from: 'b', to: 'a' }), /成环/);

/* ---------- delete_connections ---------- */
const dc = applyOperation(doc0, { op: 'delete_connections', ids: ['c1'] });
assert.deepEqual(dc.doc.connections, []);
assert.deepEqual(dc.changed.connections, ['c1']);
assert.throws(() => applyOperation(doc0, { op: 'delete_connections', ids: ['不存在'] }), /没有这条连线/);

/* ---------- 视图类：不动 revision ---------- */
const vp = applyOperation(doc0, { op: 'set_viewport', viewport: { x: 12, y: -8, scale: 99 } });
assert.deepEqual(vp.doc.viewport, { x: 12, y: -8, scale: LIMITS.scaleMax });
assert.equal(vp.view, true);
const se = applyOperation(doc0, { op: 'select_nodes', ids: ['t1', '不存在'] });
assert.deepEqual(se.doc.selection, ['t1'], '已经不存在的选中项要丢掉');

/* ---------- 整批：先验后写 ---------- */
const batch = applyOperations(doc0, [
  { op: 'add_node', type: 'text', title: '一块' },
  { op: 'update_node', id: 't1', patch: { metadata: { content: '改了' } } },
], { expectedRevision: 0 });
assert.equal(batch.ok, true);
assert.equal(batch.doc.nodes.length, 5);
assert.equal(batch.revision, 1, '一整批只涨一个修订号');
assert.equal(batch.viewOnly, false);
assert.equal(batch.node.title, '一块');
assert.equal(batch.changed.nodes.length, 2);

/* 第二条坏 → 整批不动（不做「前三条成功、第四条失败」的半截画布） */
const half = applyOperations(doc0, [
  { op: 'add_node', type: 'text' },
  { op: 'delete_connections', ids: ['不存在'] },
]);
assert.equal(half.ok, false);
assert.equal(half.at, 1);
assert.match(half.reason, /第 2 条（delete_connections）/);
assert.equal(doc0.nodes.length, 4, '被拒绝的批次不能改动传进来的文档');

assert.equal(applyOperations(doc0, []).reason, '至少要有一条操作');
const mis = applyOperations(doc0, [{ op: 'add_node', type: 'text' }], { expectedRevision: 7 });
assert.equal(mis.ok, false);
assert.equal(mis.code, 'revision_mismatch');
assert.match(mis.reason, /重新读一次再改/);
/* 只改视图的一批：revision 与 updatedAt 都不动 */
const before = doc0.updatedAt;
const viewOnly = applyOperations(doc0, [{ op: 'set_viewport', viewport: { x: 1, y: 1, scale: 1 } }, { op: 'select_nodes', ids: ['t1'] }]);
assert.equal(viewOnly.ok, true);
assert.equal(viewOnly.viewOnly, true);
assert.equal(viewOnly.revision, 0);
assert.equal(viewOnly.doc.updatedAt, before);
/* run_generation 是真改动：状态与产物号落到节点上 */
const run = applyOperations(doc0, [{ op: 'run_generation', id: 'i1', patch: { status: 'loading', taskId: 'tk_1' } }]);
assert.equal(run.ok, true);
assert.equal(run.viewOnly, false);
assert.equal(run.doc.nodes.find(n => n.id === 'i1').metadata.status, 'loading');
console.log('✓ 画布操作：七类 op / 连线规则 / 整批先验后写 / 视图不动修订号');
