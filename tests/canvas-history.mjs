#!/usr/bin/env node
/* 画布历史：补丁栈只存被改到的那几件；外部写入（助手）抬高基线，Ctrl+Z 撤不到它。 */
import assert from 'node:assert/strict';
import { MAX_LEVELS, patchFrom, applyPatch, createHistory } from '../web/domain/canvas/history.js';

const N = (id, extra) => ({ id, type: 'text', x: 0, y: 0, width: 100, height: 50, ...extra });
const C = (id, from, to) => ({ id, fromNodeId: from, toNodeId: to });
const D = (nodes, connections, revision) => ({ nodes, connections, revision: revision || 0, viewport: { x: 0, y: 0, scale: 1 } });

/* ---------- patchFrom：只罩住 changed 里那些 ---------- */
assert.equal(patchFrom(D([N('a')]), D([N('a')]), { nodes: [], connections: [] }), null, '没改动就不该有补丁');
assert.equal(patchFrom(D([N('a')]), D([N('a')]), null), null);
const add = patchFrom(D([N('a')]), D([N('a'), N('b', { title: '新的' })]), { nodes: ['a', 'b'], connections: [] });
assert.equal(add.before.nodes[1], null, '新增的东西 before 是 null');
assert.equal(add.after.nodes[1].title, '新的');
assert.deepEqual(add.ids.nodes, ['a', 'b']);
const del = patchFrom(D([N('a'), N('b')]), D([N('a')]), { nodes: ['b'], connections: [] });
assert.equal(del.before.nodes[0].id, 'b');
assert.equal(del.after.nodes[0], null, '删掉的东西 after 是 null');
const conn = patchFrom(D([N('a'), N('b')], []), D([N('a'), N('b')], [C('c1', 'a', 'b')]), { nodes: [], connections: ['c1'] });
assert.equal(conn.before.connections[0], null);
assert.equal(conn.after.connections[0].toNodeId, 'b');
/* changed 里点了名、但两侧都查不到的（撤销栈里不该凭空多出一次写） */
assert.equal(patchFrom(D([N('a')]), D([N('a')]), { nodes: ['ghost'], connections: [] }).after.nodes[0], null);

/* ---------- applyPatch：反向写回、revision 照实 +1 ---------- */
const cur = D([N('a'), N('b', { title: '新的' })], [], 3);
const back = applyPatch(cur, add, 'before', 1234);
assert.deepEqual(back.doc.nodes.map(n => n.id), ['a']);
assert.equal(back.doc.revision, 4);
assert.equal(back.doc.updatedAt, 1234);
assert.deepEqual(back.changed.nodes, ['a', 'b']);
const fwd = applyPatch(back.doc, add, 'after', 2222);
assert.deepEqual(fwd.doc.nodes.map(n => n.id), ['a', 'b']);
assert.equal(fwd.doc.nodes[1].title, '新的');
assert.equal(fwd.doc.revision, 5);
assert.equal(applyPatch(cur, null, 'before').doc, cur, '没有补丁就原样交回');
assert.equal(applyPatch(cur, add, '没有这一侧').changed.nodes.length, 0);

/* ---------- 栈：push / undo / redo ---------- */
const h = createHistory();
const d1 = D([N('a')]), d2 = D([N('a'), N('b')]), d3 = D([N('a'), N('b'), N('c')]);
const p1 = h.push(d1, d2, { nodes: ['b'], connections: [] }, { label: '加了一块' });
assert.equal(p1.label, '加了一块');
assert.equal(p1.source, 'local');
h.push(d2, d3, { nodes: ['c'], connections: [] }, { label: '又加一块' });
assert.equal(h.canUndo(), true);
assert.equal(h.canRedo(), false);
assert.equal(h.undoLabel(), '又加一块');
assert.equal(h.redoLabel(), '');
const step1 = h.undo(d3);
assert.equal(step1.ok, true);
assert.deepEqual(step1.doc.nodes.map(n => n.id), ['a', 'b']);
assert.equal(step1.label, '又加一块');
assert.equal(h.canRedo(), true);
assert.equal(h.redoLabel(), '又加一块');
const again = h.redo(step1.doc);
assert.deepEqual(again.doc.nodes.map(n => n.id), ['a', 'b', 'c']);
assert.equal(again.ok, true);
/* 撤到底之后：再撤就是拒绝，而不是把用户第一次打开时的样子也抹了 */
h.undo(again.doc); h.undo(step1.doc);
assert.equal(h.canUndo(), false);
assert.equal(h.undo(d1).ok, false);
assert.match(h.undo(d1).reason, /已经没有可撤销的人工改动了/);
/* 撤销之后写新的：redo 那一段作废（同一条编辑器规矩） */
const h2 = createHistory();
h2.push(d1, d2, { nodes: ['b'], connections: [] }, { label: '第一笔' });
h2.push(d2, d3, { nodes: ['c'], connections: [] }, { label: '第二笔' });
h2.undo(d3);
assert.equal(h2.depth().levels, 2);
h2.push(d2, D([N('a'), N('z')]), { nodes: ['z'], connections: [] }, { label: '岔出去的一笔' });
assert.equal(h2.canRedo(), false, '岔出去之后旧的那一步不能重做');
assert.equal(h2.depth().levels, 2);
assert.equal(h2.undoLabel(), '岔出去的一笔');

/* ---------- 外部写入：基线抬到它那一层 ---------- */
const h3 = createHistory();
h3.push(d1, d2, { nodes: ['b'], connections: [] }, { label: '用户加的' });
const ext = h3.push(d2, d3, { nodes: ['c'], connections: [] }, { label: '助手加的', source: 'external', operationId: 'op-1' });
assert.equal(ext.source, 'external');
assert.equal(h3.canUndo(), false, '助手那一步不能被 Ctrl+Z 撤掉');
assert.equal(h3.depth().baseline, 2);
/* 助手再退自己那一条：必须是当前最上层 */
const out = h3.undoOperation(d3, 'op-1');
assert.equal(out.ok, true);
assert.equal(out.external, true);
assert.deepEqual(out.doc.nodes.map(n => n.id), ['a', 'b']);
assert.equal(h3.positionOf('op-1'), -1);
assert.match(h3.undoOperation(d3, 'op-1').reason, /历史里没有这一步/);
assert.equal(h3.undoOperation(d3, '').ok, false);

/* 后面又压了人工改动 → 不能硬退，要照实说还有几步 */
const h4 = createHistory();
h4.push(d1, d2, { nodes: ['b'], connections: [] }, { label: '助手加的', source: 'external', operationId: 'op-2' });
h4.push(d2, d3, { nodes: ['c'], connections: [] }, { label: '用户加的' });
const blocked = h4.undoOperation(d3, 'op-2');
assert.equal(blocked.ok, false);
assert.equal(blocked.code, 'not_top');
assert.equal(blocked.steps, 1);
assert.match(blocked.reason, /已经有 1 步改动/);
/* 退完外部那一步之后，人工那一步仍然在 redo 一侧等着 */
h4.undo(d3);
assert.equal(h4.canUndo(), false);
assert.equal(h4.canRedo(), true);

/* advanceBaseline：助手一次改完直接对齐 */
const h5 = createHistory();
h5.push(d1, d2, { nodes: ['b'], connections: [] }, { label: '一笔' });
h5.advanceBaseline();
assert.equal(h5.canUndo(), false);

/* ---------- 层数上限：挤掉最老的，游标与基线一起左移 ---------- */
const h6 = createHistory({ max: 2 });
const seen = [];
const h7 = createHistory({ max: 2, trace: m => seen.push(m) });
for (let i = 0; i < 4; i++) h6.push(D([N('a')]), D([N('a'), N('x' + i)]), { nodes: ['x' + i], connections: [] }, { label: '第' + i + '笔' });
assert.equal(h6.depth().levels, 2);
assert.equal(h6.depth().max, 2);
assert.deepEqual(h6.list().map(e => e.label), ['第2笔', '第3笔']);
assert.equal(h6.list().every(e => e.applied), true);
for (let i = 0; i < 4; i++) h7.push(D([N('a')]), D([N('a'), N('x' + i)]), { nodes: ['x' + i], connections: [] }, { label: '第' + i + '笔' });
assert.match(seen.join('|'), /挤出最老的一层/);
/* max 越界不越 MAX_LEVELS */
assert.equal(createHistory({ max: 9999 }).depth().max, MAX_LEVELS);
assert.equal(createHistory({ max: 0 }).depth().max, MAX_LEVELS);
/* clear：换一份文档时把栈倒空 */
const h8 = createHistory();
h8.push(d1, d2, { nodes: ['b'], connections: [] }, { label: '一笔' });
h8.clear();
assert.equal(h8.canUndo(), false);
assert.deepEqual(h8.list(), []);
assert.equal(h8.entryAt(0), null);
console.log('✓ 画布历史：补丁只罩改动 / 撤与重做 / 外部写入抬基线 / 层数上限');
