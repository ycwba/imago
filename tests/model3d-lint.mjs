#!/usr/bin/env node
/* 几何体检：悬空的落回支撑面、整体高度离谱的等比缩进范围、出画幅的缩 / 挪进画幅、
   单件离谱只提醒不改、入参不被改写、修过再跑一遍不再动。
   包围盒用 three 现造一遍复核（与渲染同一份 buildContent）：体检量的必须就是画面上那只盒子，
   小人按零件树量（不是比例表的估算值），群众按「节点 at 叠两次」量。 */
import assert from 'node:assert/strict';
import { lintDoc } from '../web/model3d/lint.js';
import { lintSayOf } from '../web/model3d/ai.js';
import { normalizeDoc } from '../web/model3d/schema.js';
import { buildContent, boundsOf } from '../web/model3d/scene.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

const make = raw => normalizeDoc({ scene: { nodes: raw } }).doc;
const renderBox = doc => boundsOf(buildContent(doc, { outline: false }));
const close = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const fixesText = res => res.fixes.join(' | ');

const legs = () => [
  { kind: 'prim', id: 'leg1', name: '腿1', shape: 'box', size: [0.08, 0.7, 0.08], at: [0.45, 0.35, 0.45] },
  { kind: 'prim', id: 'leg2', name: '腿2', shape: 'box', size: [0.08, 0.7, 0.08], at: [-0.45, 0.35, 0.45] },
  { kind: 'prim', id: 'leg3', name: '腿3', shape: 'box', size: [0.08, 0.7, 0.08], at: [0.45, 0.35, -0.45] },
  { kind: 'prim', id: 'leg4', name: '腿4', shape: 'box', size: [0.08, 0.7, 0.08], at: [-0.45, 0.35, -0.45] },
];

/* ---------- 桌面悬空：落到腿顶，腿不动 ---------- */
{
  const doc = make([{
    kind: 'group', id: 'g1', name: '桌子',
    children: legs().concat([
      { kind: 'prim', id: 'top', name: '桌面', shape: 'box', size: [1.1, 0.08, 1.1], at: [0, 1.2, 0] },
    ]),
  }]);
  const snapshot = JSON.stringify(doc);
  const res = lintDoc(doc);
  ok(res.changed === true, '悬空桌面要被修');
  ok(res.fixes.length === 1 && res.fixes[0] === '把「桌面」落到「腿1」上',
    'fix 要说清落到了哪：' + fixesText(res));
  ok(JSON.stringify(doc) === snapshot, '入参一个字节都不动');
  const box = renderBox(res.doc);
  ok(close(box.min.y, 0), '落地后脚底贴地：min.y=' + box.min.y.toFixed(3));
  ok(close(box.max.y, 0.78), '桌面落到腿顶：max.y=' + box.max.y.toFixed(3));
  ok(res.doc.scene.nodes[0].children[0].at[1] === 0.35, '四条腿原地不动');
}

/* ---------- 整张桌子悬空：整棵一起落，子零件相对位置不变 ---------- */
{
  const doc = make([{
    kind: 'group', id: 'g2', name: '桌子', at: [0, 2, 0],
    children: legs().concat([
      { kind: 'prim', id: 'top2', name: '桌面', shape: 'box', size: [1.1, 0.08, 1.1], at: [0, 0.74, 0] },
    ]),
  }]);
  const res = lintDoc(doc);
  ok(res.fixes.length === 1 && res.fixes[0] === '把「桌子」落到地面',
    '整棵悬空只落一次、报在根上：' + fixesText(res));
  ok(res.doc.scene.nodes[0].children[4].at[1] === 0.74, '子零件相对位置不动（不是逐个落）');
  const box = renderBox(res.doc);
  ok(close(box.min.y, 0) && close(box.max.y, 0.78), '整桌落地后仍是 0.78 米高：'
    + box.min.y.toFixed(3) + '–' + box.max.y.toFixed(3));
}

/* ---------- 整体高度不在 0.5–4 米：等比缩 / 放到范围内，底面不离地 ---------- */
{
  const doc = make([{ kind: 'prim', id: 'tiny', name: '小块', shape: 'box', size: [0.2, 0.2, 0.2], at: [0, 0.1, 0] }]);
  const res = lintDoc(doc);
  ok(res.fixes.some(f => f === '整体高度 0.2 米不在 0.5–4 米内，等比放到 0.5 米'),
    '太矮要说清放到多少：' + fixesText(res));
  const box = renderBox(res.doc);
  ok(close(box.min.y, 0, 0.01) && close(box.max.y, 0.5, 0.01),
    '放到 0.5 米且仍站在地上：' + box.min.y.toFixed(3) + '–' + box.max.y.toFixed(3));
  ok(close(res.doc.scene.nodes[0].at[1], 0.25, 0.01), '缩放绕底面中心：节点抬到 0.25');
}
{
  const doc = make([{ kind: 'prim', id: 'huge', name: '巨块', shape: 'box', size: [10, 10, 10], at: [0, 5, 0] }]);
  const res = lintDoc(doc);
  ok(res.fixes.some(f => f.indexOf('整体高度 10 米不在 0.5–4 米内，等比缩到 4 米') === 0),
    '太高先夹到 4 米：' + fixesText(res));
  ok(res.fixes.some(f => f.indexOf('主体超出画幅，等比缩小到') === 0),
    '夹完还出画幅就继续缩：' + fixesText(res));
  const box = renderBox(res.doc);
  ok(close(box.min.y, 0) && box.max.y > 0.5 && box.max.y < 4,
    '最后在画幅与高度范围内落地：' + box.min.y.toFixed(3) + '–' + box.max.y.toFixed(3));
}

/* ---------- 嵌在墙里的窗：不单独落地；出画幅只缩外层 ---------- */
{
  const doc = make([{
    kind: 'group', id: 'g3', name: '墙体',
    children: [
      { kind: 'prim', id: 'wall', name: '墙', shape: 'box', size: [4, 3, 0.2], at: [0, 1.5, 0] },
      { kind: 'prim', id: 'win', name: '窗', shape: 'box', size: [0.8, 1, 0.05], at: [0, 1.7, 0.125] },
    ],
  }]);
  const res = lintDoc(doc);
  ok(!res.fixes.some(f => f.indexOf('把「窗」') === 0), '有支撑的窗不被单独挪：' + fixesText(res));
  ok(res.doc.scene.nodes[0].children[1].at.join(',') === '0,1.7,0.125', '窗相对墙的位置一个数都不变');
  ok(res.fixes.length === 1 && res.fixes[0].indexOf('主体超出画幅，等比缩小到') === 0,
    '只做一次整体等比缩：' + fixesText(res));
}

/* ---------- 群众：at 在包装组与阵列点里各算一次，落地要按这个量 ---------- */
{
  const doc = make([{ kind: 'crowd', id: 'c1', name: '人群', rows: 2, cols: 2, gapX: 1, gapZ: 1, at: [0, 1, 0] }]);
  const res = lintDoc(doc);
  ok(res.fixes.some(f => f === '把「人群」落到地面'), '抬高 1 米的群众要落地：' + fixesText(res));
  ok(close(res.doc.scene.nodes[0].at[1], 0, 0.02), '节点回到 y≈0：' + res.doc.scene.nodes[0].at[1]);
  const box = renderBox(res.doc);
  ok(close(box.min.y, 0), '渲染出来脚底贴地：min.y=' + box.min.y.toFixed(3));
}
{
  const doc = make([{ kind: 'crowd', id: 'c2', name: '人群', rows: 2, cols: 2, gapX: 1, gapZ: 1, at: [0, 1, 0], rot: [0, 45, 0] }]);
  const res = lintDoc(doc);
  const box = renderBox(res.doc);
  ok(close(box.min.y, 0), '转过的群众也贴地：min.y=' + box.min.y.toFixed(3));
}

/* ---------- 单件离谱：只提醒，不自动改 ---------- */
{
  const doc = make([{ kind: 'prim', id: 'big', name: '长墙', shape: 'box', size: [30, 3, 0.2], at: [0, 1.5, 0] }]);
  doc.scene.cams = [{ id: 'cam-1', name: '机位 1', pos: [0, 12, 70], target: [0, 1.5, 0], fov: 35, follow: '' }];
  doc.scene.active = 'cam-1';
  const snapshot = JSON.stringify(doc);
  const res = lintDoc(doc);
  ok(res.fixes.length === 0, '离谱尺寸不自动改：' + fixesText(res));
  ok(res.warnings.some(w => w === '「长墙」单件约 30 米，明显超出常见尺度'),
    '要记一条警告：' + res.warnings.join(' | '));
  ok(JSON.stringify(res.doc) === snapshot, '文档一个字节没动');
}

/* ---------- 主体在机位背后：画幅这一项跳过并说清 ---------- */
{
  const doc = make([{ kind: 'prim', id: 'n3', name: '小盒', shape: 'box', size: [0.6, 0.6, 0.6], at: [0, 0.3, 0] }]);
  doc.scene.cams = [{ id: 'cam-1', name: '机位 1', pos: [0, 1, 5], target: [0, 1, 10], fov: 35, follow: '' }];
  doc.scene.active = 'cam-1';
  const res = lintDoc(doc);
  ok(res.fixes.length === 0, '背后时不瞎动：' + fixesText(res));
  ok(res.warnings.some(w => w === '主体在机位背后或把机位包在里面，画幅检查跳过'),
    '要说清画幅检查被跳过：' + res.warnings.join(' | '));
}

/* ---------- 小人：按零件树量身高（不是比例表估算值），出画幅缩到约 2 米 ---------- */
{
  const doc = make([{ kind: 'mannequin', id: 'm1', name: '小人' }]);
  const raw = renderBox(doc);
  ok(close(raw.max.y, 3.133, 0.03), '默认小人渲染身高约 3.13 米：' + raw.max.y.toFixed(3));
  const res = lintDoc(doc);
  ok(res.fixes.some(f => f.indexOf('主体超出画幅，等比缩小到') === 0),
    '默认机位装不下 3.13 米的小人，要缩：' + fixesText(res));
  const box = renderBox(res.doc);
  ok(box.max.y > 1.8 && box.max.y < 2.2, '缩完约 2 米高：' + box.max.y.toFixed(3));
  ok(close(box.min.y, 0, 0.01), '缩完仍贴地：min.y=' + box.min.y.toFixed(3));
}

/* ---------- 修过再跑一遍不再动；fixes 并进 say ---------- */
{
  const doc = make([{
    kind: 'group', id: 'g4', name: '桌子',
    children: legs().concat([
      { kind: 'prim', id: 'top4', name: '桌面', shape: 'box', size: [1.1, 0.08, 1.1], at: [0, 1.2, 0] },
    ]),
  }]);
  const first = lintDoc(doc);
  const again = lintDoc(first.doc);
  ok(again.fixes.length === 0 && again.changed === false, '已经修好的文档第二遍不再动：' + fixesText(again));
  const a = renderBox(first.doc);
  const b = renderBox(again.doc);
  ok(Math.abs(a.min.y - b.min.y) < 1e-6 && Math.abs(a.max.y - b.max.y) < 1e-6, '两遍渲染结果一致');
  ok(lintSayOf('桌子做好了', { fixes: ['把「桌面」落到「腿1」上'] })
    === '桌子做好了\n（几何体检：把「桌面」落到「腿1」上）', 'fixes 并进 say');
  ok(lintSayOf('桌子做好了', { fixes: [] }) === '桌子做好了', '没改就不往 say 里塞空话');
  ok(lintSayOf('', { fixes: ['把「桌面」落到地面'] }) === '（几何体检：把「桌面」落到地面）', 'say 为空时只留体检结论');
  ok(lintSayOf('', { fixes: [], warnings: ['主体在机位背后或把机位包在里面，画幅检查跳过'] })
    === '（体检提醒：主体在机位背后或把机位包在里面，画幅检查跳过）', '只提醒时也说清');
}

console.log('✓ model3d-lint：' + n + ' 项通过');
