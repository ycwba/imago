#!/usr/bin/env node
/* 台词的落点（web/director/line-point.js）：落在第几段、段内哪一秒，读写都从这一份过。
   缺省 = 第一段起点，且缺省值不占键（老工程加了字段也一个字节都不变）。
   读的时候也夹：剪过一刀之后旧的落点可能落在已经不存在的段 / 段尾之外。 */
import assert from 'node:assert/strict';
import { linePointClamp, linePointOf, linePointSet } from '../web/director/line-point.js';

const segs = [
  { in: 2, out: 6 },
  { in: 10, out: 13.5 },
  { in: 20, out: 21 },
];

/* 夹取：段号夹进 [0, n-1]，秒数夹进这一段的 [in, out - 0.1]。 */
assert.deepEqual(linePointClamp({ seg: 0, at: 2 }, segs), { seg: 0, at: 2 }, '段内起点原样');
assert.deepEqual(linePointClamp({ seg: 1, at: 12.34 }, segs), { seg: 1, at: 12.3 }, '一位小数');
assert.deepEqual(linePointClamp({ seg: 9, at: 50 }, segs), { seg: 2, at: 20.9 },
  '段号越界落到最后一段，秒数夹到段尾前 0.1 秒');
assert.deepEqual(linePointClamp({ seg: -3, at: -8 }, segs), { seg: 0, at: 2 },
  '负数段号与秒数都夹回第一段起点');
assert.deepEqual(linePointClamp({ seg: '2', at: '20' }, segs), { seg: 2, at: 20 }, '字符串数字照收');
assert.deepEqual(linePointClamp({ seg: 1, at: NaN }, segs), { seg: 1, at: 10 },
  'NaN 秒数当 0 → 夹到这一段起点（不写 null / undefined）');
assert.deepEqual(linePointClamp({ seg: 0, at: 5 }, [{ in: '' }]), { seg: 0, at: 0 },
  '段上没有 in/out 时起点按 0');
assert.deepEqual(linePointClamp({ seg: 1, at: 3 }, []), { seg: 1, at: 3 },
  '还没有段就只把数字规整，不做区间夹取');
assert.deepEqual(linePointClamp(null, segs), { seg: 0, at: 2 }, '整个交空也不崩，回第一段起点');

/* 读：没有落点就是第一段起点；坏值同样回落，不把脏数据带到轨道上。 */
assert.deepEqual(linePointOf({}, segs), { seg: 0, at: 2 }, '老工程（没有 lineAt）回第一段起点');
assert.deepEqual(linePointOf(null, segs), { seg: 0, at: 2 }, '台词本身是空也回缺省');
assert.deepEqual(linePointOf({ lineAt: '' }, segs), { seg: 0, at: 2 }, '空串不算落点');
assert.deepEqual(linePointOf({ lineAt: 'abc' }, segs), { seg: 0, at: 2 }, '写坏的字不算落点');
assert.deepEqual(linePointOf({ lineAt: 0, lineSeg: 0 }, segs), { seg: 0, at: 2 },
  'lineAt = 0 是合法值，但落在第 0 段之外 → 夹到该段起点');
assert.deepEqual(linePointOf({ lineAt: 11.5, lineSeg: 1 }, segs), { seg: 1, at: 11.5 });
assert.deepEqual(linePointOf({ lineAt: 12.5, lineSeg: 7 }, segs), { seg: 2, at: 20 },
  '段号已经不存在 → 夹到最后一段，秒数低于那一段起点就顶在起点（剪过一刀之后的老落点）');
assert.deepEqual(linePointOf({ lineAt: 99, lineSeg: 7 }, segs), { seg: 2, at: 20.9 },
  '段号与秒数都越界 → 一起夹到最后一段的段尾前');
assert.deepEqual(linePointOf({ lineAt: 13.5, lineSeg: 1 }, segs), { seg: 1, at: 13.4 },
  '段尾那一秒也夹到 out - 0.1');

/* 写：返回「真的改了没有」，回到缺省时把键删掉 —— 缺省值不占盘。 */
const sh = {};
assert.equal(linePointSet(sh, 1, 11.5, segs), true, '从缺省写到第 2 段 → 改了');
assert.deepEqual({ seg: sh.lineSeg, at: sh.lineAt }, { seg: 1, at: 11.5 });
assert.equal(linePointSet(sh, 1, 11.5, segs), false, '写同一个数 → 没改（不压快照、不标脏）');
assert.equal(linePointSet(sh, 1, 11.54, segs), false, '取整到同一位小数也算没改');
assert.equal(linePointSet(sh, 1, 12.5, segs), true, '换一秒 → 改了');
assert.equal(sh.lineAt, 12.5);
assert.equal(linePointSet(sh, 1, 99, segs), true, '夹到段尾 → 改了');
assert.equal(sh.lineAt, 13.4);
assert.equal(linePointSet(sh, 0, 2, segs), true, '写回第一段起点 → 改了');
assert.equal('lineSeg' in sh, false, '回到缺省就把 lineSeg 删掉');
assert.equal('lineAt' in sh, false, '回到缺省就把 lineAt 删掉');
assert.equal(linePointSet(sh, 0, 2, segs), false, '本来就在缺省 → 没改');

const withKeys = { lineSeg: 0, lineAt: 2 };
assert.equal(linePointSet(withKeys, 0, 2, segs), false, '旧版留下的缺省键：算没改');
assert.equal('lineAt' in withKeys, false, '但顺手把缺省键清掉，缺省值不占盘');

const wild = { lineAt: 99, lineSeg: 9 };
assert.equal(linePointSet(wild, 0, 0, segs), true, '脏落点写回缺省 → 改了');
assert.equal('lineAt' in wild, false);
assert.equal('lineSeg' in wild, false);

assert.equal(linePointSet(null, 0, 2, segs), false, '没有台词对象就什么都不写');
assert.equal(linePointSet({}, 0, 0, []), false, '还没有段时缺省与写入同一个数 → 没改');

/* 写空段表：只规整数字，不造段号区间。 */
const noSegs = {};
assert.equal(linePointSet(noSegs, 2, 7, []), true);
assert.deepEqual({ seg: noSegs.lineSeg, at: noSegs.lineAt }, { seg: 2, at: 7 });

console.log('✓ director-line-point');
