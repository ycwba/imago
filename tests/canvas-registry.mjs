#!/usr/bin/env node
/* 画布节点注册表：类型档 / 尺寸下限 / 连线判据 / 成环检测（纯数据 + 纯函数）。 */
import assert from 'node:assert/strict';
import { NODE_TYPES, MEDIA_KINDS, typeOf, hasType, labelOf, createMenu,
  defaultSize, minSize, whyConnect, wouldCycle } from '../web/domain/canvas/registry.js';

const TYPES = Object.keys(NODE_TYPES);

/* ---------- 声明本身要自洽：这一页只认这里写的，写歪了界面就画出一张接不住的节点 ---------- */
assert.deepEqual(TYPES, ['text', 'image', 'video', 'audio', 'config', 'asset-ref']);
for (const t of TYPES) {
  const d = NODE_TYPES[t];
  assert.equal(d.type, t, '描述里的 type 要和键同名');
  assert.ok(d.label && d.icon, t + ' 要有中文名和图标');
  assert.ok(['asset', 'none'].includes(d.generationMode), t + ' 的 generationMode 只这两档');
  for (const k of ['defaultSize', 'minSize']) {
    assert.ok(Number.isInteger(d[k].width) && Number.isInteger(d[k].height), t + '.' + k + ' 要写整数');
  }
  assert.ok(d.minSize.width <= d.defaultSize.width && d.minSize.height <= d.defaultSize.height,
    t + ' 的下限不能比默认还大');
  for (const a of d.acceptsInputKind) assert.ok(TYPES.includes(a), t + ' 收了一个不存在的类型：' + a);
  assert.equal(d.acceptsInputKind.length > 0, d.maxInputCount > 0, t + ' 的容量要和「收不收」一起写');
}
/* 「会出产物」这件事只由 generationMode 决定，MEDIA_KINDS 是派生出来的，不是第二份名单。 */
assert.deepEqual(MEDIA_KINDS, TYPES.filter(t => NODE_TYPES[t].generationMode === 'asset'));
assert.deepEqual(MEDIA_KINDS, ['image', 'video', 'audio']);

/* ---------- 查表 ---------- */
assert.equal(typeOf('image'), NODE_TYPES.image);
assert.equal(typeOf('nope'), null);
assert.equal(typeOf(''), null);
assert.equal(typeOf(null), null);
assert.equal(typeOf(undefined), null);
assert.equal(hasType('config'), true);
assert.equal(hasType('Config'), false, '类型名大小写敏感：写错就当没有');
assert.equal(labelOf('asset-ref'), '资产引用');
assert.equal(labelOf('未来某档'), '未来某档', '未知类型照实回原名，不编一个中文');
assert.equal(labelOf(''), '节点');

const menu = createMenu();
assert.equal(menu.length, 6);
assert.deepEqual(menu.map(d => d.type), TYPES, '创建菜单按注册表顺序');
assert.deepEqual(defaultSize('image'), { width: 288, height: 162 });
assert.deepEqual(defaultSize('没这一档'), { width: 240, height: 160 });
assert.deepEqual(minSize('config'), { width: 200, height: 120 });
assert.deepEqual(minSize('没这一档'), { width: 80, height: 60 });
/* 交回的是副本：界面拿去夹尺寸不能把注册表改掉。 */
const ds = defaultSize('image'); ds.width = 1;
assert.equal(NODE_TYPES.image.defaultSize.width, 288, 'defaultSize 要回副本');
const ms = minSize('image'); ms.height = 1;
assert.equal(NODE_TYPES.image.minSize.height, 54, 'minSize 要回副本');

/* ---------- 连线判据：36 对全过一遍，收不收只由 acceptsInputKind 决定 ---------- */
for (const a of TYPES) for (const b of TYPES) {
  const reason = whyConnect(a, b, 0);
  const ok = NODE_TYPES[b].acceptsInputKind.includes(a) && !(a === 'config' && b === 'config');
  assert.equal(reason === '', ok, a + ' → ' + b + ' 判成「' + reason + '」');
  if (!ok && a !== 'config' && b !== 'config') assert.match(reason, new RegExp('^' + labelOf(b) + ' 不接受'));
}
assert.equal(whyConnect('config', 'config', 0), '两个配置节点之间不连线');
assert.equal(whyConnect('text', 'image', 0), '');
assert.equal(whyConnect('asset-ref', 'video', 0), '', '资产引用是喂给生成节点的料');
assert.equal(whyConnect('image', 'asset-ref', 0), '资产引用 不接受 图片 作为输入', '引用节点只出不进');
assert.equal(whyConnect('image', 'audio', 0), '音频 不接受 图片 作为输入');
assert.equal(whyConnect('video', 'text', 0), '文本 不接受 视频 作为输入');
assert.equal(whyConnect('不存在的', 'image', 0), '这一端不是注册表里的节点类型');
assert.equal(whyConnect('text', '也不存在', 0), '这一端不是注册表里的节点类型');

/* ---------- 容量：满不满按「已经接了几路」算，ignoreCount 是给体检用的 ---------- */
assert.equal(whyConnect('text', 'image', 7), '');
assert.equal(whyConnect('text', 'image', 8), '图片 最多接 8 路输入（已经满了）');
assert.equal(whyConnect('text', 'audio', 4), '音频 最多接 4 路输入（已经满了）');
assert.equal(whyConnect('text', 'image', 99, { ignoreCount: true }), '', '只看类型合不合，容量留给调用方自己数');
assert.equal(whyConnect('video', 'audio', 99), '音频 不接受 视频 作为输入', '类型不对就先报类型，不报容量');

/* ---------- 成环：新边 from→to 若让 to 又能绕回 from 就是环 ---------- */
assert.equal(wouldCycle([], 'a', 'a'), true, '自环');
assert.equal(wouldCycle([], 'a', 'b'), false);
assert.equal(wouldCycle(null, 'a', 'b'), false);
assert.equal(wouldCycle(undefined, 'a', 'b'), false);
const chain = [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'b', toNodeId: 'c' }];
assert.equal(wouldCycle(chain, 'a', 'b'), false, '重边不是环（重复由 ops 那边单独拦）');
assert.equal(wouldCycle(chain, 'b', 'a'), true, '把已有的边倒着接回去是环');
assert.equal(wouldCycle(chain, 'c', 'a'), true, '长链首尾接起来');
assert.equal(wouldCycle(chain, 'c', 'd'), false, '接到新节点上没有环');
assert.equal(wouldCycle(chain, 'b', 'd'), false);
/* 菱形：两条路都汇到 d，seen 要拦住重复展开，否则图一大就指数爆炸。 */
const diamond = [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'a', toNodeId: 'c' },
  { fromNodeId: 'b', toNodeId: 'd' }, { fromNodeId: 'c', toNodeId: 'd' }];
assert.equal(wouldCycle(diamond, 'd', 'a'), true);
assert.equal(wouldCycle(diamond, 'd', 'b'), true);
assert.equal(wouldCycle(diamond, 'd', 'e'), false);
assert.equal(wouldCycle(diamond, 'e', 'a'), false, 'e 是条死头，接不回谁');
const looped = [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'b', toNodeId: 'a' },
  { fromNodeId: 'b', toNodeId: 'c' }];
assert.equal(wouldCycle(looped, 'c', 'a'), true, '图里本来就有环时，接进环也算');
assert.equal(wouldCycle([{ fromNodeId: 'a' }], 'a', 'b'), false, '缺 toNodeId 的脏数据不当边');

console.log('✓ 画布注册表：六档自洽 / 产物名单派生 / 36 对连线判据 / 容量 / 成环');
