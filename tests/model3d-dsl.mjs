#!/usr/bin/env node
/* 建模契约这一侧：流式抓节点（括号配平）、坏节点只丢该节点并计数、
   给 AI 看的当前场景（大纲 + 选中子树，不设条数上限）、集群 / 复用的形状。
   纯函数，不需要浏览器。 */
import assert from 'node:assert/strict';
import { scanNodes, currentText, catalogText, animationText } from '../web/model3d/ai.js';
import { normalizeDoc, countNodes, findNode, removeNode, outlineOf } from '../web/model3d/schema.js';
import { variantsOf, cloneNodeForVariant } from '../web/model3d/dsl.js';

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

/* ---------- ④ 不设上限：节点数、群众人数 ---------- */
{
  const many = [];
  for (let i = 0; i < 430; i++) many.push({ kind: 'prim', shape: 'box', size: [0.1, 0.1, 0.1] });
  const out = normalizeDoc({ scene: { nodes: many } });
  ok(out.doc.scene.nodes.length === 430, '430 个节点全保留：' + out.doc.scene.nodes.length);
  ok(out.dropped.extra === 0, '没有 extra 截断');

  const crowd = normalizeDoc({ scene: { nodes: [{ kind: 'crowd', rows: 24, cols: 24 }] } });
  const c = crowd.doc.scene.nodes[0];
  ok(c.rows * c.cols === 576, '群众 576 人不截断：' + c.rows + '×' + c.cols);
}

/* ---------- ⑤ 当前场景：没选中时只有大纲，节点不截断、坐标不进大纲 ---------- */
{
  ok(currentText(null).indexOf('新建') >= 0, '没有旧模型时给一句说明');
  const nodes = [];
  for (let i = 0; i < 300; i++) nodes.push({ kind: 'prim', id: 'p' + i, shape: 'box', size: [1, 1, 1], at: [i, 0, 0] });
  const doc = normalizeDoc({ scene: { nodes } }).doc;
  const txt = currentText(doc);
  ok(txt.startsWith('【场景大纲】'), '无选中时只有大纲这一段');
  ok(txt.indexOf('p0(box)') >= 0 && txt.indexOf('p299(box)') >= 0, '300 个节点全在大纲里');
  ok(txt.indexOf('"size"') < 0 && txt.indexOf('"at"') < 0, '大纲不带几何字段');
  ok(txt.indexOf('【选中实体完整细节】') < 0 && txt.indexOf('【选中实体骨架】') < 0, '没有选中时不给第二段');
  ok(txt.length < 4000, '300 个节点的大纲远短于全量：' + txt.length);
  ok(txt.indexOf('机位 cam-1') >= 0 && txt.indexOf('时间轴 4s · 24fps · 循环') >= 0, '机位与时间轴各一行');
  ok(currentText(doc, '没有这个 id') === txt, '选中 id 不存在时退回纯大纲');
}

/* ---------- ⑥ 选中子树：细节只给一遍，轨道只取子树里的 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'group', id: 'g', name: '桌子', children: [
      { kind: 'prim', id: 'p1', shape: 'box', size: [1, 1, 1], at: [0, 0.5, 0] },
      { kind: 'group', id: 'sub', children: [{ kind: 'mannequin', id: 'm1' }] },
    ] },
    { kind: 'prim', id: 'q', shape: 'sphere', r: 1 },
  ] }, anim: { tracks: [
    { id: 't1', of: { kind: 'node', id: 'p1' }, keys: [{ t: 0, at: [0, 0, 0] }, { t: 1, at: [1, 0, 0] }] },
    { id: 't2', of: { kind: 'node', id: 'm1' }, joint: 'torso/leftShoulder', keys: [{ t: 0, rot: [10, 0, 0] }] },
    { id: 't3', of: { kind: 'node', id: 'q' }, motion: 'walk', path: { kind: 'line', from: [0, 0, 0], to: [1, 0, 0] } },
    { id: 't4', of: { kind: 'cam', id: 'cam-1' }, keys: [{ t: 0, at: [1, 2, 3] }] },
  ] } }).doc;
  const txt = currentText(doc, 'g');
  ok(txt.split('【选中实体完整细节】').length === 2, '第二段恰好出现一次');
  const at = txt.indexOf('【选中实体完整细节】');
  const detail = JSON.parse(txt.slice(txt.indexOf('\n', at) + 1));
  ok(detail.node.id === 'g' && detail.node.children.length === 2, '细节里是整棵选中子树');
  ok(txt.slice(0, at).indexOf('"size"') < 0, '大纲段不带几何字段');
  ok(txt.split('"size":[1,1,1]').length === 2, '几何字段只在细节段出现一遍');
  ok(detail.tracks.length === 2 && detail.tracks[0].id === 't1' && detail.tracks[1].id === 't2',
    '只给子树内的节点轨道（外层与机位轨道都不给）：' + detail.tracks.map(t => t.id).join(','));
  ok(detail.tracks[0].keys.length === 2 && detail.tracks[0].keys[1].at[0] === 1, '关键帧原样保留');
  ok(detail.tracks[1].joint === 'torso/leftShoulder', '关节轨道照写');
}

/* ---------- ⑦ 预算：选中子树细节超了，就退成骨架（id 仍可用） ---------- */
{
  const kids = [];
  for (let i = 0; i < 600; i++) kids.push({ kind: 'prim', id: 'b' + i, shape: 'box', size: [0.5, 0.5, 0.5], at: [i * 0.5, 0, 0] });
  const doc = normalizeDoc({ scene: { nodes: [{ kind: 'group', id: 'big', name: '大组', children: kids }] },
    anim: { tracks: [{ id: 'tb', of: { kind: 'node', id: 'b5' }, keys: [{ t: 0, at: [0, 0, 0] }, { t: 2, at: [2, 0, 0] }] }] } }).doc;
  const txt = currentText(doc, 'big');
  ok(txt.indexOf('【选中实体骨架】') >= 0, '超预算时细节退成骨架');
  ok(txt.indexOf('【选中实体完整细节】') < 0, '不再给完整字段');
  ok(txt.indexOf('b0(box)') >= 0 && txt.indexOf('b599(box)') >= 0, '骨架里 id 仍然全部在');
  ok(txt.indexOf('"size"') < 0, '降级后一个几何字段都不给');
  ok(txt.indexOf('轨道摘要') >= 0 && txt.indexOf('tb → b5') >= 0, '轨道退成一行摘要');
  ok(txt.length < 30000, '降级后总长有界：' + txt.length);
}

/* ---------- ⑧ 历史清单：全部列出，一条一行 ---------- */
{
  const models = [];
  for (let i = 0; i < 60; i++) models.push({ id: '组/模型' + i, nodes: 3, note: i === 0 ? '一句话说明' : '' });
  const rows = catalogText(models).split('\n');
  ok(rows.length === 60, '60 条全列：' + rows.length);
  ok(/模型0/.test(rows[0]) && /3 个零件/.test(rows[0]), '带零件数');
  ok(catalogText([]).indexOf('还没有') >= 0, '空清单给一句人话');
  const briefed = catalogText([{ id: '桌子', library: '默认库', nodes: 4, brief: ['桌面 box', '桌腿 box×4', '花瓶 lathe'] }]);
  ok(briefed.indexOf('[ 桌面 box / 桌腿 box×4 / 花瓶 lathe ]') >= 0, '结构摘要进清单：' + briefed);
  const multi = catalogText([{ id: '角色/少女', library: '系列A', nodes: 2 }]);
  ok(multi.indexOf('系列A :: 角色/少女') >= 0, '多库清单带库名，复用能回到正确的库');
}

/* ---------- ⑨ 树的读写：找得到、删得掉 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'group', id: 'g1', children: [{ kind: 'prim', id: 'p1', shape: 'box', size: [1, 1, 1] }] },
  ] } }).doc;
  ok(findNode(doc.scene.nodes, 'p1') !== null, '子节点找得到');
  ok(removeNode(doc.scene.nodes, 'p1') === true && findNode(doc.scene.nodes, 'p1') === null, '删得掉');
  ok(removeNode(doc.scene.nodes, '没有这个') === false, '删不存在的返回 false');
}

/* ---------- ⑩ 库里有动画的摆件清单：全部列出、不截断，空时整段消失 ---------- */
{
  ok(animationText([]) === '' && animationText(null) === '', '没有带动画的摆件时是空串（调用方用空格顶掉占位符）');
  ok(animationText([{ file: '_模型文件/a.fbx', clips: [] }]) === '', '有文件没 clip 不算一条');
  ok(animationText([{ file: '', clips: ['idle'] }]) === '', '没有文件名不算一条');
  const one = animationText([{ file: '_模型文件/长凳.fbx', clips: ['idle', 'sway'] }]);
  ok(one.indexOf('长凳.fbx') >= 0 && one.indexOf('idle / sway') >= 0, '一条写成「文件名：clip1 / clip2」');
  ok(one.split('\n').length === 2, '抬头一行 + 一条清单');
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ file: '_模型文件/文件' + i + '.fbx', clips: ['a'] });
  ok(animationText(many).split('\n').length === 31, '30 条全列 + 抬头：' + animationText(many).split('\n').length);
  const longName = 'x'.repeat(50);
  const long = animationText([{ file: '_模型文件/' + longName + '.fbx', clips: ['c'.repeat(20), 'd'.repeat(20)] }]);
  const row = long.split('\n')[1];
  ok(row.indexOf(longName) >= 0 && row.indexOf('c'.repeat(20)) >= 0, '文件名与 clip 名不截断：' + row.length);
}

/* ---------- ⑪ 当前模型的摆件：clip 只在有时才写，默认值不占字 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'asset', id: 'a', file: '_模型文件/静态.fbx' },
    { kind: 'asset', id: 'b', file: '_模型文件/动态.fbx', clip: 'walk' },
    { kind: 'asset', id: 'c', file: '_模型文件/动态2.fbx', clip: 'run', clipSpeed: 2, clipLoop: 'hold', clipOffset: 0.5 },
  ] } }).doc;
  const detailOf = id => {
    const t = currentText(doc, id);
    const at = t.indexOf('【选中实体完整细节】');
    return at < 0 ? null : JSON.parse(t.slice(t.indexOf('\n', at) + 1));
  };
  const a = detailOf('a');
  const b = detailOf('b');
  const c = detailOf('c');
  ok(!('clip' in a.node), '静态摆件不写 clip');
  ok(b.node.clip === 'walk' && !('clipSpeed' in b.node) && !('clipLoop' in b.node) && !('clipOffset' in b.node),
    '默认的速度 / 循环 / 偏移不写');
  ok(c.node.clip === 'run' && c.node.clipSpeed === 2 && c.node.clipLoop === 'hold' && c.node.clipOffset === 0.5,
    '非默认值照写');
}

/* ---------- ⑫ 大纲行格式：层级 / 名字 / 形状 / 缩进封顶 ---------- */
{
  ok(outlineOf(null).length === 0 && outlineOf({ scene: { nodes: [] } }).length === 0, '空文档没有行');
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'group', id: 'g', name: '桌 子', children: [
      { kind: 'prim', id: 'p1', shape: 'box', size: [1, 1, 1] },
      { kind: 'mannequin', id: 'm1', name: '小人' },
    ] },
    { kind: 'prim', id: 's1', shape: 'lathe', profile: [[0.001, 0], [0.2, 0.4]] },
  ] } }).doc;
  const lines = outlineOf(doc);
  ok(lines[0] === 'g「桌 子」(group) 子2', '根行 = id + 名字 + 种类 + 子节点数：' + lines[0]);
  ok(lines[1] === '  - p1(box)', '一层缩进两格 + 形状：' + lines[1]);
  ok(lines[2] === '  - m1「小人」(mannequin)', '子节点名字照写：' + lines[2]);
  ok(lines[3] === 's1(lathe)', '旋转体显示形状而不是 prim：' + lines[3]);
  ok(lines.every(x => x.indexOf('机位') < 0 && x.indexOf('时间轴') < 0), '大纲只有节点，机位与时间轴不进 outlineOf');

  let deep = { kind: 'prim', id: 'l40', shape: 'box', size: [1, 1, 1] };
  for (let i = 39; i >= 0; i -= 1) deep = { kind: 'group', id: 'l' + i, children: [deep] };
  const deepLines = outlineOf(normalizeDoc({ scene: { nodes: [deep] } }).doc);
  ok(deepLines.length === 41, '40 层深链整条都在：' + deepLines.length);
  ok(deepLines[40].indexOf('l40(box)') >= 0, '叶子在最后一行');
  ok(deepLines[40].length < 60, '缩进封顶后深行不按深度膨胀：' + deepLines[40].length);
}

/* ---------- ⑨ 通用阵列：四条腿的桌子一个字段写完 ---------- */
{
  const doc = normalizeDoc({ scene: { nodes: [
    { kind: 'prim', id: 'leg', name: '桌腿', shape: 'box', size: [0.08, 0.7, 0.08], at: [-0.5, 0.35, -0.4],
      array: { rows: 2, cols: 2, gapX: 1.0, gapZ: 0.8 } },
  ] } }).doc;
  const leg = doc.scene.nodes[0];
  ok(leg.array.rows === 2 && leg.array.cols === 2 && leg.array.gapX === 1 && leg.array.gapZ === 0.8, '阵列字段归一');
  const vs = variantsOf(leg);
  ok(vs.length === 4, '2×2 展开成四份：' + vs.length);
  const ats = vs.map(v => cloneNodeForVariant(leg, v).node.at.join(',')).sort();
  ok(JSON.stringify(ats) === JSON.stringify([
    '0.5,0.35,0.4', '-0.5,0.35,-0.4', '-0.5,0.35,0.4', '0.5,0.35,-0.4',
  ].sort()), '第一格落在节点自己的 at 上，行列按 +X / +Z 排：' + JSON.stringify(ats));

  /* 间距可负（允许反向排 / 重叠） */
  const neg = normalizeDoc({ scene: { nodes: [{ kind: 'prim', id: 'p', shape: 'box', array: { rows: 1, cols: 3, gapX: -0.5 } }] } }).doc;
  ok(neg.scene.nodes[0].array.gapX === -0.5, '间距可负');
  ok(variantsOf(neg.scene.nodes[0]).length === 3, '1×3 三份');

  /* 展开顺序：array × repeat，最后每一份再 mirror */
  const combo = { kind: 'prim', id: 'c', shape: 'box', at: [0, 0, 0],
    array: { rows: 2, cols: 1, gapX: 0, gapZ: 2 }, repeat: { n: 2, dx: 1 }, mirror: true };
  ok(variantsOf(combo).length === 8, '2 格 × 2 份 × 镜像 = 8：' + variantsOf(combo).length);
  ok(JSON.stringify(variantsOf(combo).map(v => v.mirrorX)) === JSON.stringify([false, false, false, false, true, true, true, true]),
    '镜像排在展开出来的每一份之后');

  /* jitter 确定：同一份模型两次展开逐字节相同；幅度落在 ±jitter/2 内 */
  const jit = { kind: 'prim', id: 'j', shape: 'box', array: { rows: 2, cols: 2, gapX: 1, gapZ: 1, jitter: 0.4 } };
  const a = variantsOf(jit);
  const b = variantsOf(jit);
  ok(JSON.stringify(a) === JSON.stringify(b), '抖动是确定性的（重建不跳）');
  const plain = variantsOf(Object.assign({}, jit, { array: { rows: 2, cols: 2, gapX: 1, gapZ: 1, jitter: 0 } }));
  ok(a.every((v, i) => Math.abs(v.at[0] - plain[i].at[0]) <= 0.2 + 1e-9
    && Math.abs(v.at[2] - plain[i].at[2]) <= 0.2 + 1e-9), '抖动幅度不超过 jitter/2');

  /* crowd 不吃 array：它用自己的行列字段（归一化时直接不认） */
  const cr = normalizeDoc({ scene: { nodes: [{ kind: 'crowd', id: 'cr', rows: 2, cols: 2, array: { rows: 3, cols: 3 } }] } }).doc;
  ok(!cr.scene.nodes[0].array, 'crowd 不叠第二套阵列字段');
  ok(variantsOf(cr.scene.nodes[0]).length === 1, 'crowd 的阵列由 crowdLayout 展开，不进 variantsOf');
}

/* ---------- ⑩ 运镜：当前场景里列出机位已有的轨道 ---------- */
{
  const doc = normalizeDoc({
    scene: { nodes: [{ kind: 'prim', id: 'n1', shape: 'box' }], cams: [{ id: 'cam-1', pos: [3, 2, 4], target: [0, 1, 0] }] },
    anim: { tracks: [{ id: 't1', of: { kind: 'cam', id: 'cam-1' }, path: { kind: 'circle', radius: 2, look: 'target', lookAt: 'n1' } }] },
  }).doc;
  const txt = currentText(doc, '');
  ok(txt.includes('轨道 t1(circle/target 0帧'), '机位行带出现有轨道（AI 知道在改哪一条）：'
    + (txt.split(String.fromCharCode(10)).find(l => l.indexOf('机位 ') === 0) || ''));
}

console.log('✓ model3d-dsl：' + n + ' 项通过');
