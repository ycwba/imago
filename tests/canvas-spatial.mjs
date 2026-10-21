#!/usr/bin/env node
/* 画布空间索引：网格挂载、跨格节点、视口余量对称、框选整框、整体居中。 */
import assert from 'node:assert/strict';
import { CELL, createIndex, rectHits, containedIds, snap, fitViewport } from '../web/domain/canvas/spatial.js';
import { LIMITS } from '../web/domain/canvas/doc.js';

const nodes = [
  { id: 'a', x: 10, y: 10, width: 100, height: 50 },
  { id: 'b', x: 500, y: 400, width: 200, height: 120 },
  { id: 'far', x: 9000, y: 9000, width: 60, height: 60 },
  { id: 'wide', x: 0, y: 0, width: CELL * 3, height: 40 },            // 横跨三个格子
  { id: 'neg', x: -1500, y: -1500, width: 100, height: 100 },          // 负坐标也要落对格
];
const ix = createIndex();
assert.equal(ix.rebuild(nodes), 5);
assert.equal(ix.size(), 5);
assert.deepEqual(ix.queryRect(0, 0, 300, 300).sort(), ['a', 'wide']);
assert.deepEqual(ix.queryRect(450, 350, 700, 500), ['b']);
assert.deepEqual(ix.queryRect(-2000, -2000, -1000, -1000), ['neg']);
assert.deepEqual(ix.queryRect(8950, 8950, 9100, 9100), ['far']);
assert.deepEqual(ix.queryRect(1e6, 1e6, 1e6 + 1, 1e6 + 1), [], '空区域什么都不能捞到');
assert.deepEqual(ix.queryRect(1e6, 1e6, NaN, 5), [], '坐标不是数字就当没问过');
/* 横跨的节点：每一格都挂号，问哪一段都答得出 */
assert.deepEqual(ix.queryRect(CELL * 2 + 5, 0, CELL * 2 + 6, 10), ['wide']);
assert.equal(ix.rectOf('a').w, 100);
assert.equal(ix.rectOf('不存在'), null);

/* update 只在已登记时改；remove 之后彻底查不到 */
ix.update('a', { x: 60, y: 60, width: 100, height: 50 });
assert.equal(ix.rectOf('a').x, 60);
assert.deepEqual(ix.queryRect(60, 60, 90, 90), ['a']);
assert.equal(ix.update('没挂过', { x: 0, y: 0 }), null);
assert.equal(ix.remove('a'), true);
assert.equal(ix.remove('a'), false);
assert.deepEqual(ix.queryRect(-9000, -9000, 90000, 90000).sort(), ['b', 'far', 'neg', 'wide']);

/* 自定义格子：小格子也一样跨格；摘干净之后空格子要一起删 */
const small = createIndex({ cell: 64 });
small.insert('s', { x: 0, y: 0, width: 200, height: 10 });
assert.equal(small.stats().cells >= 4, true);
assert.deepEqual(small.queryRect(190, 0, 195, 5), ['s']);
small.remove('s');
assert.equal(small.stats().cells, 0);
assert.equal(createIndex({ cell: 0 }).stats().nodes, 0, '格子大小给 0 就用默认');

/* ---------- 视口查询：四条边各多出 over/2，左右对称 ---------- */
const vi = createIndex({ cell: 100 });
vi.rebuild([
  { id: 'in', x: 10, y: 10, width: 50, height: 50 },          // 屏幕里
  { id: 'near', x: 820, y: 10, width: 20, height: 20 },       // 右外 20：余量里
  { id: 'far', x: 1200, y: 10, width: 20, height: 20 },       // 右外 400：余量外
  { id: 'left', x: -90, y: 10, width: 20, height: 20 },       // 左外 90：余量里（以前左边只算一半，这种会漏挂）
  { id: 'gone', x: -1200, y: 10, width: 20, height: 20 },     // 左外 1200：余量外
]);
const vw = 800, vh = 600;
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: 1 }, vw, vh).sort(), ['in', 'left', 'near']);
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: 1 }, vw, vh, 0).sort(), ['in'], 'pad 给 0 就只剩屏幕那一块');
/* 平移：文档坐标 = (屏幕 - 平移) / 缩放。往左推 600（ox=-600）等于看 x=600..1400 */
assert.deepEqual(vi.queryViewport({ x: -600, y: 0, scale: 1 }, vw, vh).sort(), ['far', 'near']);
assert.deepEqual(vi.queryViewport({ x: -1100, y: 0, scale: 1 }, vw, vh).sort(), ['far'], '再推 500 只剩最右那一个');
/* 缩到 0.5：一屏看到的文档宽度翻倍，左右余量也一起翻倍 */
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: 0.5 }, vw, vh).sort(), ['far', 'in', 'left', 'near']);
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: 0.05 }, vw, vh).sort(), ['far', 'gone', 'in', 'left', 'near'], '缩到 0.05 才够看见最远那两个');
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: 1 }, 0, 0), [], '零尺寸什么都看不见');
assert.deepEqual(vi.queryViewport(null, vw, vh).sort(), ['in', 'left', 'near'], '没有视口信息就按 1:1 在原点');
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: -3 }, vw, vh).sort(), ['in', 'left', 'near'], '坏倍率兜到 1:1，不除出负数');
assert.deepEqual(vi.queryViewport({ x: 0, y: 0, scale: 0 }, vw, vh).sort(), ['in', 'left', 'near'], '0 倍率同样兜住');

/* ---------- 一次性查询与框选 ---------- */
assert.deepEqual(rectHits(nodes, 0, 0, 300, 300).sort(), ['a', 'wide']);
assert.deepEqual(rectHits(nodes, 110, 60, 200, 200), [], '只擦到边不算命中');
assert.deepEqual(rectHits(null, 0, 0, 1, 1), []);
/* 框选要整框在里面（跟 Figma / 剪映一致）：擦边不算，横跨的大块也不算 */
assert.deepEqual(containedIds(nodes, 0, 0, 200, 200), ['a']);
assert.deepEqual(containedIds(nodes, 0, 0, 900, 700).sort(), ['a', 'b'], '横跨三个格的大块整框放不下就不算');
assert.deepEqual(containedIds(nodes, 200, 200, 0, 0), ['a'], '反向拖的框也要能算');
assert.deepEqual(containedIds(null, 0, 0, 1, 1), []);

/* ---------- 吸附 ---------- */
assert.equal(snap(123, 8), 120);
assert.equal(snap(124, 8), 128);
assert.equal(snap(-123, 8), -120);
assert.equal(snap(37, 0), 37, '关掉吸附时原样交回');
assert.equal(snap(37, NaN), 37);

/* ---------- 整体居中：内容中心落到屏幕中心 ---------- */
const fit = fitViewport(nodes, ['a', 'b'], { x: 0, y: 0, scale: 1 }, vw, vh, 64, 1);
assert.ok(fit.scale <= 1 && fit.scale > 0.9, '内容比屏幕略大就微微缩小：' + fit.scale);
assert.ok(Math.abs(355 * fit.scale + fit.x - 400) < 1e-6, '横向居中');    // 内容中心 x = (10+700)/2
assert.ok(Math.abs(265 * fit.scale + fit.y - 300) < 1e-6, '纵向居中');    // 内容中心 y = (10+520)/2
const squeezed = fitViewport(nodes, ['a', 'far'], { x: 0, y: 0, scale: 1 }, vw, vh, 0, 1);
assert.equal(squeezed.scale, LIMITS.scaleMin, '跨度太大压到下限为止');
assert.deepEqual(fitViewport(nodes, ['不存在'], { x: 5, y: 6, scale: 2 }, vw, vh), { x: 5, y: 6, scale: 2 }, '没点名就原样交回');
assert.deepEqual(fitViewport([], ['a'], { x: 5, y: 6, scale: 2 }, vw, vh), { x: 5, y: 6, scale: 2 });
const single = fitViewport(nodes, ['b'], { x: 0, y: 0, scale: 1 }, vw, vh, 64, 1);
assert.equal(single.scale, 1);
assert.ok(Math.abs(600 * single.scale + single.x - 400) < 1e-6);
assert.ok(Math.abs(460 * single.scale + single.y - 300) < 1e-6);
console.log('✓ 画布空间索引：网格 / 跨格 / 对称余量 / 整框选 / 吸附 / 居中');
