#!/usr/bin/env node
/* 主轨联动的纯判据：`nextLiveSeg` 跳过 off/gap、`linksOf` 过滤非法值、
   `relinkTargets` 按勾选算目标、`setLinks` 只在非空时占键。 */
import assert from 'node:assert/strict';
import { isGap, nextLiveSeg, linksOf, setLinks, relinkTargets } from '../web/director/links.js';

/* isGap：只有 gap 标记才是空段；off && !gap 是「删掉画面」的黑场 */
assert.equal(isGap({ gap: 1 }), true);
assert.equal(isGap({ off: 1 }), false);
assert.equal(isGap({ off: 1, gap: 1 }), true);
assert.equal(isGap(null), false);

/* nextLiveSeg：跳过 off / gap，找不到回 -1；from 之后优先，回头找前面 */
const segs = [
  { in: 0, out: 2 },                     // 0 有画面
  { in: 2, out: 3, off: 1 },             // 1 黑场
  { in: 3, out: 4, off: 1, gap: 1 },     // 2 空段
  { in: 4, out: 6 },                     // 3 有画面
];
assert.equal(nextLiveSeg(segs, 0), 3, '从 0 往右找：跳过黑场与空段，命中 3');
assert.equal(nextLiveSeg(segs, 1), 3);
assert.equal(nextLiveSeg(segs, 3), 0, '3 是最后一段有画面的，回头找 0');
assert.equal(nextLiveSeg([{ off: 1 }], 0), -1, '全黑场找不到');

/* linksOf：空数组 / 缺键 / 含非法值 → []（不抛、不写） */
assert.deepEqual(linksOf(null), []);
assert.deepEqual(linksOf({}), []);
assert.deepEqual(linksOf({ lane: {} }), []);
assert.deepEqual(linksOf({ lane: { pic: {} } }), []);
assert.deepEqual(linksOf({ lane: { pic: { links: [] } } }), []);
assert.deepEqual(linksOf({ lane: { pic: { links: ['bad', 'voice'] } } }), ['voice']);
assert.deepEqual(linksOf({ lane: { pic: { links: ['pending', 'voice', 'line'] } } }), ['voice', 'line', 'pending'], '固定顺序');

/* setLinks：非空才占键，空则 delete */
{
  const p = { lane: { pic: {} } };
  setLinks(p, ['voice']);
  assert.deepEqual(p.lane.pic.links, ['voice']);
  setLinks(p, []);
  assert.equal('links' in p.lane.pic, false, '空数组不占键');
  setLinks(p, ['nope']);
  assert.equal('links' in p.lane.pic, false, '全非法也不占键');
}

/* relinkTargets：voice 勾选时算出 toSeg/toAt；不勾时 voices 为空 */
{
  const voices = [
    { id: 'a', seg: 1, at: 0.5 },
    { id: 'b', seg: 0, at: 0.2 },
    { id: 'c', seg: 1, at: 1.2 },
  ];
  const segList = [
    { in: 0, out: 2 },
    { in: 2, out: 3, off: 1 },          // 变黑场的那段
    { in: 3, out: 4, off: 1, gap: 1 },
    { in: 4, out: 6 },
  ];
  const r = relinkTargets({ segs: segList, voices, links: ['voice'], seg: 1 });
  assert.equal(r.voices.length, 2, '只有 seg===1 的两条要挪');
  assert.equal(r.voices[0].toSeg, 3);
  assert.equal(r.voices[0].toAt, 0);
  assert.equal(r.line, null, '没给 linePoint 就不算 line');
  /* 不勾 voice → voices 为空 */
  const r2 = relinkTargets({ segs: segList, voices, links: [], seg: 1 });
  assert.equal(r2.voices.length, 0);
  /* 勾 line + 给落点 → line 算出目标 */
  const r3 = relinkTargets({ segs: segList, voices, linePoint: { seg: 1, at: 0 }, links: ['line'], seg: 1 });
  assert.deepEqual(r3.line, { toSeg: 3, toAt: 0 });
  assert.equal(r3.voices.length, 0, '没勾 voice 就不算 voice');
  /* 后面没有画面 → 全部留在原地（返回空） */
  const r4 = relinkTargets({ segs: [{ in: 0, out: 2, off: 1 }], voices, links: ['voice'], seg: 0 });
  assert.equal(r4.voices.length, 0, '后面没有画面了，留在原地');
  assert.equal(r4.line, null);
}

console.log('✓ 联动：nextLiveSeg / linksOf / setLinks / relinkTargets');
