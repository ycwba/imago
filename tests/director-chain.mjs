#!/usr/bin/env node
/* 接续拆分镜的纯算法（web/director/chain.js）：顺序、依赖、选型、拆分、报价键与合计。
   这些规则一旦错，表现分别是「接错上一镜」「长镜头被悄悄截短」「预计价当 0」，都很难从界面看出来。 */
import assert from 'node:assert/strict';
import { shotPlacement, hasTailFrame, isRunning, chainDeps, pickChainModel,
  splitLongShots, quoteKeyOf, sumQuotes } from '../web/director/chain.js';

/* ---------- 全片顺序：跨场景连续，上一镜就是排在它前面的那一镜 ---------- */
const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' }, c = { id: 'c', name: 'C' };
const places = shotPlacement([{ name: '场一', shots: [a, b] }, { name: '场二', shots: [c] }]);
assert.deepEqual(places.map(p => [p.sceneIndex, p.shotIndex, p.shot.id]), [[0, 0, 'a'], [0, 1, 'b'], [1, 0, 'c']]);
assert.equal(places[0].prev, null);
assert.equal(places[1].prev, a);
assert.equal(places[2].prev, b, '场景边界不影响接续：上一场最后一镜就是下一场第一镜的上一镜');
assert.equal(places[1].next, c);

/* ---------- 上一镜有没有可用画面 ---------- */
assert.equal(hasTailFrame({}), false);
assert.equal(hasTailFrame({ lastFrame: 'data:image/png;base64,x' }), true);
assert.equal(hasTailFrame({ keyframes: [{ assetId: 'la_k' }] }), true);
assert.equal(hasTailFrame({ candidates: [{ status: 'succeeded' }] }), false, '成功但没有地址不算可用画面');
assert.equal(hasTailFrame({ candidates: [{ status: 'succeeded', url: '/asset/la_x' }] }), true);
assert.equal(isRunning({ candidates: [{ status: 'running' }] }), true);
assert.equal(isRunning({ candidates: [{ status: 'succeeded' }] }), false);

/* ---------- 依赖：谁在等上一镜 / 为什么等不到 ---------- */
const chained = (extra) => Object.assign({ id: 's', linkPrev: 'tail', candidates: [] }, extra || {});
const first = chained({});
const second = chained({});
const deps = chainDeps([first, second], { pending: new Set([first]) });
assert.equal(deps[0].ok, false);
assert.equal(deps[0].code, 'no-prev', '第一个镜头没有上一镜');
assert.equal(deps[1].ok, false);
assert.equal(deps[1].code, 'waiting', '上一镜排在本批里 → 等，不是不能生成');
assert.equal(deps[1].prev, first);

const hasFrame = chained({});
const ready = chainDeps([{ id: 'p', candidates: [{ status: 'succeeded', url: '/asset/la_p' }] }, hasFrame]);
assert.equal(ready[1].ok, true);
assert.equal(ready[1].code, 'ready');

const explicit = chained({ firstFrame: '/asset/la_frame' });
assert.equal(chainDeps([{ id: 'p' }, explicit])[1].ok, true, '用户显式放了首帧就不需要等上一镜');

const runningPrev = { id: 'p', candidates: [{ status: 'running' }] };
assert.equal(chainDeps([runningPrev, chained({})])[1].code, 'waiting', '上一镜在跑 → 等');
const idlePrev = { id: 'p', candidates: [] };
assert.equal(chainDeps([idlePrev, chained({})])[1].code, 'no-frame', '上一镜没画面也不在跑 → 让它先单独生成');

/* ---------- 选型：当前型号支持首帧就沿用；否则先找首尾都支持的 ---------- */
const mBothBig = { id: 'big', name: '大', min: 1, max: 30, first: true, last: true };
const mBothSmall = { id: 'small', name: '小', min: 1, max: 12, first: true, last: true };
const mFirstOnly = { id: 'first', name: '只首帧', min: 1, max: 20, first: true, last: false };
const mNoFirst = { id: 'nofirst', name: '不支持', min: 1, max: 60, first: false, last: false };
assert.equal(pickChainModel([mBothBig, mBothSmall], 'small').id, 'small', '当前型号能接首帧就别换');
assert.equal(pickChainModel([mBothSmall, mBothBig, mFirstOnly], '').id, 'big', '自动挑：首尾都支持的优先，再按上限最大');
assert.equal(pickChainModel([mFirstOnly, mBothSmall], 'first').id, 'first', '当前型号支持首帧就沿用');
assert.equal(pickChainModel([mNoFirst, mFirstOnly], 'nofirst').id, 'first', '当前型号接不了首帧 → 换');
assert.equal(pickChainModel([mFirstOnly], '', 25, m => m.max >= 25), null, '时长覆盖不了就不选');
assert.equal(pickChainModel([mFirstOnly, mMaybe()], '', 25, m => m.max >= 25).id, 'maybe');
function mMaybe() { return { id: 'maybe', name: '够长', min: 1, max: 26, first: true, last: false }; }

/* ---------- 拆长镜头：能一口吃下就不拆；必须拆时总秒数守恒 ---------- */
const items = [{ key: 'k1', scene: '场一', name: '长镜头', dur: 30,
  text: '一。二。三。四。五。六。', line: '台词', who: '角色', note: '注', label: '镜一' }];
/* 没有任何型号能覆盖 30 秒（上限 12）→ 必须拆；3 × 10 秒都在区间内。 */
const splitBig = { id: 'big', name: '十二秒', min: 1, max: 12, first: true, last: true };
const models = [splitBig];
const out = splitLongShots(items, { models, canDur: true });
assert.equal(out.split, 1);
assert.equal(out.added, 2);
assert.equal(out.items.length, 3);
assert.equal(out.items.reduce((n, x) => n + x.dur, 0), 30, '拆完总秒数必须还是 30');
assert.ok(out.items.every(x => Number.isInteger(x.dur) && x.dur >= splitBig.min && x.dur <= splitBig.max));
assert.equal(out.items[0].chain, '');
assert.equal(out.items[1].chain, 'tail');
assert.equal(out.items[2].chain, 'tail');
assert.equal(out.items[0].line, '台词');
assert.equal(out.items[1].line, '', '台词只留在第一段，不重复发给后面几段');
assert.equal(out.items[2].who, '');
assert.equal(out.items[0].chainModel, 'big', '选的是能覆盖整段、首尾都支持的型号');
assert.ok(out.items[1].name.endsWith('（2/3）') && out.items[2].name.endsWith('（3/3）'));
assert.ok(out.items[1].key.endsWith('（2/3）'));
assert.ok(out.items[1].text.includes('（第 2 段，延续上一段结尾）'), '后续段要说明自己在延续上一段');
assert.ok(!out.items[1].text.startsWith('一。'), '后续段不许把整段提示词再发一遍');

const fits = splitLongShots([{ key: 'k', name: '刚好', dur: 30, text: '' }],
  { models: [{ id: 'long', min: 1, max: 30, first: true, last: true }], canDur: true });
assert.equal(fits.split, 0);
assert.equal(fits.note, '', '有型号能吃下整段就不拆，也不报「已拆」');

const noDur = splitLongShots(items, { models, canDur: false });
assert.equal(noDur.split, 0, '没有时长声明就不替平台编拆分');

const impossible = splitLongShots([{ key: 'k', name: '十三秒', dur: 13, text: '' }],
  { models: [{ id: 'm', min: 7, max: 12, first: true, last: true }], canDur: true });
assert.equal(impossible.split, 0);
assert.equal(impossible.impossible.length, 1, '拆不成合法片段要照实报，不许悄悄截短');
assert.ok(impossible.impossible[0].why.includes('13'));

const tooMany = splitLongShots([{ key: 'k', name: '短句', dur: 30, text: 'AB' }],
  { models: [{ id: 'm', min: 5, max: 12, first: true, last: true }], canDur: true });
assert.equal(tooMany.split, 1);
assert.equal(tooMany.items.length, 3);
assert.ok(tooMany.items[1].text.includes('延续上一段结尾'), '句子不够时按字符切，也要带接续说明');

const already = splitLongShots([{ key: 'k', name: '接续镜', dur: 30, text: '', chain: 'tail' }],
  { models: [splitBig], canDur: true, currentModel: 'big' });
assert.equal(already.split, 1);
assert.equal(already.items[0].chain, 'tail', '原镜头本来接上一镜，第一段仍然接');
assert.equal(already.items[1].chain, 'tail');

/* ---------- 报价键：同规格可合并，影响价钱的输入变了就不合并 ---------- */
const sh = { duration: 5, res: '1080p', tier: 'pro', ar: '16:9', size: '', draw: 3 };
const qctx = { provider: 'p', model: 'm', intent: 'i', mode: 'v',
  topBools: { b: true, a: false }, shapeFields: { s: 1 }, caps: ['x'], combo: '' };
const k1 = quoteKeyOf(sh, qctx);
assert.equal(k1, quoteKeyOf(Object.assign({}, sh, { draw: 9 }), qctx), 'count/draw 不进键');
assert.equal(k1, quoteKeyOf(sh, Object.assign({}, qctx, { topBools: { a: false, b: true } })),
  '对象键顺序不影响');
assert.notEqual(k1, quoteKeyOf(sh, Object.assign({}, qctx, { model: 'm2' })));
assert.notEqual(k1, quoteKeyOf(Object.assign({}, sh, { duration: 6 }), qctx));

/* ---------- 报价合计：缺金额绝不当 0；多币种不合计 ---------- */
const usd = sumQuotes([
  { ok: true, amount: 10, currency: 'USD' },
  { ok: true, amount: 5, currency: 'USD' },
  { ok: false, amount: 0, currency: 'USD' },
  { ok: true, reason: '只给了最低消费', currency: 'USD' },
]);
assert.equal(usd.total, 15);
assert.equal(usd.priced, 2);
assert.equal(usd.unpriced, 2, '失败与没有金额的都要计入，不能当 0');
assert.equal(usd.mixed, false);
const mixed = sumQuotes([{ ok: true, amount: 10, currency: 'USD' }, { ok: true, amount: 3, currency: 'CNY' }]);
assert.equal(mixed.total, null, '多币种不合并成一个总数');
assert.equal(mixed.mixed, true);
assert.deepEqual(mixed.byCurrency.sort((x, y) => x.currency.localeCompare(y.currency)),
  [{ currency: 'CNY', amount: 3 }, { currency: 'USD', amount: 10 }]);
const none = sumQuotes([{ ok: false, amount: 2 }]);
assert.equal(none.total, 0);
assert.equal(none.priced, 0);
assert.equal(none.unpriced, 1, '一笔都没报出金额时 priced=0，不能冒出一个 0 元的总价');

console.log('✓ 接续拆分：顺序 / 依赖原因码 / 选型优先级 / 拆分守恒与台词只留首段 / 报价键 / 缺金额不当 0');
