#!/usr/bin/env node
/* 建模契约这一侧：流式抓节点（括号配平）、坏节点只丢该节点并计数、给 AI 看的截断、
   集群 / 复用的形状。纯函数，不需要浏览器。 */
import assert from 'node:assert/strict';
import { scanNodes, currentText, catalogText, animationText } from '../web/model3d/ai.js';
import { normalizeDoc, LIMITS, countNodes, findNode, removeNode } from '../web/model3d/schema.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---------- ① 流式：边收边抓，只有收全的那个对象才算数 ---------- */
const FULL = '{"say":"建了三样","reuse":null,"model":{"scene":{"nodes":['
  + '{"id":"n1","kind":"prim","shape":"box","size":[1,1,1]},'
  + '{"id":"n2","kind":"mannequin","body":"female","pose":"walk"},'
  + '{"id":"n3","kind":"prim","shape":"sphere","r":0.5}'
  + '],"camera":{"pos":[3,2,4]}}}}';
{
  ok(scanNodes('').length === 0, '空串没有节点');
  ok(scanNodes('{"say":"还没开始"}').length === 0, '没有 nodes 时不出节点');
  const seen = [];
  for (let i = 8; i <= FULL.length; i += 7) seen.push(scanNodes(FULL.slice(0, i)).length);
  ok(seen[0] === 0, '开头还没收全时是 0');
  ok(Math.max(...seen) === 3, '收到最后能抓满 3 个：' + Math.max(...seen));
  /* 单调不减：已经抓到的节点不会因为多收了几个字就消失 */
  for (let i = 1; i < seen.length; i++) ok(seen[i] >= seen[i - 1], '节点数是单调不减的');
  const nodes = scanNodes(FULL);
  ok(nodes.length === 3 && nodes[2].id === 'n3', '最后一个节点也解出来了');
}

/* ---------- ② 字符串里的花括号 / 转义不能骗过配平 ---------- */
{
  const txt = '{"model":{"nodes":[{"id":"n1","kind":"prim","shape":"box","name":"a{b}c\\"d"},{"id":"n2"}]}}';
  const nodes = scanNodes(txt);
  ok(nodes.length === 2, '字符串里的 { } 与转义引号不影响配平：' + nodes.length);
  ok(nodes[0].name === 'a{b}c"d', '名字里的括号与引号原样留着');
}

/* ---------- ③ 坏节点只丢该节点，并记账 ---------- */
{
  const out = normalizeDoc({ scene: { nodes: [
    { kind: 'prim', shape: 'box', size: [1, 2, 3] },              // 好
    { kind: 'prim' },                                             // 没有 shape
    { kind: 'wat' },                                              // 不认识的 kind
    { kind: 'asset', file: '../etc/passwd' },                     // 越界路径
    { kind: 'asset', file: '_模型文件/椅子.glb', clay: true },      // 好
    { kind: 'ref' },                                              // 没有 model
    { kind: 'mannequin', body: 'female', pose: 'run' },           // 好
    { kind: 'prim', shape: 'loft', rings: [{ y: 0, rx: 1, rz: 1 }] }, // 环不足 2 个
  ] } });
  ok(out.doc.scene.nodes.length === 3, '留下 3 个好节点：' + out.doc.scene.nodes.length);
  ok(out.dropped.bad === 5, '丢了 5 个坏节点并计数：' + out.dropped.bad);
  ok(countNodes(out.doc) === 3, '节点计数与树一致');
}

/* ---------- ④ 上限：节点数、群众人数 ---------- */
{
  const many = [];
  for (let i = 0; i < LIMITS.nodes + 12; i++) many.push({ kind: 'prim', shape: 'box', size: [0.1, 0.1, 0.1] });
  const out = normalizeDoc({ scene: { nodes: many } });
  ok(out.doc.scene.nodes.length === LIMITS.nodes, '节点数被夹到上限：' + out.doc.scene.nodes.length);
  ok(out.dropped.extra === 12, '多出来的记在 extra：' + out.dropped.extra);

  const crowd = normalizeDoc({ scene: { nodes: [{ kind: 'crowd', rows: 24, cols: 24 }] } });
  const c = crowd.doc.scene.nodes[0];
  ok(c.rows * c.cols <= 400, '群众不超过 400 人：' + c.rows + '×' + c.cols);
  ok(crowd.dropped.crowd === 1, '截断记了一笔');
}

/* ---------- ⑤ 给 AI 看的当前树：节点太多要截断（不是把整棵树塞进去） ---------- */
{
  ok(currentText(null).indexOf('新建') >= 0, '没有旧模型时给一句说明');
  const nodes = [];
  for (let i = 0; i < 300; i++) nodes.push({ kind: 'prim', shape: 'box', size: [1, 1, 1], at: [i, 0, 0] });
  const doc = normalizeDoc({ scene: { nodes } }).doc;
  const txt = currentText(doc);
  ok(txt.length <= 9200, '过长时截断：' + txt.length);
  ok(txt.indexOf('截断') >= 0 || txt.length < 9000, '截断时留一句说明');
}

/* ---------- ⑥ 历史清单：最多 40 条，一条一行 ---------- */
{
  const models = [];
  for (let i = 0; i < 60; i++) models.push({ id: '组/模型' + i, nodes: 3, note: i === 0 ? '一句话说明' : '' });
  const rows = catalogText(models).split('\n');
  ok(rows.length === 40, '截到 40 条：' + rows.length);
  ok(/模型0/.test(rows[0]) && /3 个零件/.test(rows[0]), '带零件数');
  ok(catalogText([]).indexOf('还没有') >= 0, '空清单给一句人话');
}

/* ---------- ⑦ 树的读写：找得到、删得掉 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'group', id: 'g1', children: [{ kind: 'prim', id: 'p1', shape: 'box', size: [1, 1, 1] }] },
  ] } }).doc;
  ok(findNode(doc.scene.nodes, 'p1') !== null, '子节点找得到');
  ok(removeNode(doc.scene.nodes, 'p1') === true && findNode(doc.scene.nodes, 'p1') === null, '删得掉');
  ok(removeNode(doc.scene.nodes, '没有这个') === false, '删不存在的返回 false');
}

/* ---------- ⑧ 库里有动画的摆件清单：最多 20 条、一条 60 字，空时整段消失 ---------- */
{
  ok(animationText([]) === '' && animationText(null) === '', '没有带动画的摆件时是空串（调用方用空格顶掉占位符）');
  ok(animationText([{ file: '_模型文件/a.fbx', clips: [] }]) === '', '有文件没 clip 不算一条');
  ok(animationText([{ file: '', clips: ['idle'] }]) === '', '没有文件名不算一条');
  const one = animationText([{ file: '_模型文件/长凳.fbx', clips: ['idle', 'sway'] }]);
  ok(one.indexOf('长凳.fbx') >= 0 && one.indexOf('idle / sway') >= 0, '一条写成「文件名：clip1 / clip2」');
  ok(one.split('\n').length === 2, '抬头一行 + 一条清单');
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ file: '_模型文件/文件' + i + '.fbx', clips: ['a'] });
  ok(animationText(many).split('\n').length === 21, '最多 20 条 + 抬头：' + animationText(many).split('\n').length);
  const long = animationText([{ file: '_模型文件/' + 'x'.repeat(50) + '.fbx', clips: ['c'.repeat(20), 'd'.repeat(20)] }]);
  const row = long.split('\n')[1];
  ok(row.length <= 60 && row.endsWith('…'), '一条不超过 60 字并带省略号：' + row.length);
  ok(animationText(many, 3).split('\n').length === 4, 'limit 比条数小时照 limit');
}

/* ---------- ⑨ 当前模型的摆件：clip 只在有时才写，默认值不占字 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'asset', id: 'a', file: '_模型文件/静态.fbx' },
    { kind: 'asset', id: 'b', file: '_模型文件/动态.fbx', clip: 'walk' },
    { kind: 'asset', id: 'c', file: '_模型文件/动态2.fbx', clip: 'run', clipSpeed: 2, clipLoop: 'hold', clipOffset: 0.5 },
  ] } }).doc;
  const body = JSON.parse(currentText(doc));
  const byId = {};
  for (const x of body.scene.nodes) byId[x.id] = x;
  ok(!('clip' in byId.a), '静态摆件不写 clip');
  ok(byId.b.clip === 'walk' && !('clipSpeed' in byId.b) && !('clipLoop' in byId.b) && !('clipOffset' in byId.b),
    '默认的速度 / 循环 / 偏移不写');
  ok(byId.c.clip === 'run' && byId.c.clipSpeed === 2 && byId.c.clipLoop === 'hold' && byId.c.clipOffset === 0.5,
    '非默认值照写');
}

console.log('✓ model3d-dsl：' + n + ' 项通过');
