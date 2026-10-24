#!/usr/bin/env node
/* 空段（`gap`）：空段的来处只剩一个 —— 把某一格左右拖走，原位自动空出一段（engine.js bindSegDrag
   的 order 支）；「空一段 / 摘掉空段」两把剪法已随按钮撤掉，这里盯它们真的不在了、
   gap 标记穿过搬运链、drop/merge 不许顶替、配音不挂空段。
   `cutSegs` / `reanchorVoices` 在 createTrack 闭包里，但它们只用纯导入与 `projOf().voices`
   —— 用最小 E 桩实例化，不碰 DOM。 */
import assert from 'node:assert/strict';
import { segsOf, segsCopy, segsWrite, segCarry, SEG_MIN } from '../web/director/segments.js';
import { isGap, nextLiveSeg, linksOf, setLinks, relinkTargets } from '../web/director/links.js';
import { createTrack } from '../web/director/engine/track.js';

/* 最小 E 桩：cutSegs / reanchorVoices 只碰 projOf().voices，其余成员不进这两条路。 */
const mkE = (voices = []) => {
  const proj = { voices, lane: {} };
  return {
    projOf: () => proj,
    fmtDur: t => t + 's',
    setStatus: () => {},
    shotVoices: null,
  };
};
const T = (voices = []) => {
  const E = mkE(voices);
  const t = createTrack(E, {}, {});
  return { t, E };
};
const C = segs => ({ segs: segsCopy(segs) });

/* ── 1. 「空一段 / 摘掉空段」两把剪法已撤：cutSegs 不再认识它们 ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 4, a: 0, b: 4 }, { in: 4, out: 5, a: 4, b: 5, off: 1, gap: 1 }, { in: 5, out: 9, a: 5, b: 9 }]);
  assert.ok(t.cutSegs(c, 10, 2, 'gap').err, 'gap 剪法已撤：必须报「不认识这种剪法」');
  assert.ok(t.cutSegs(c, 10, 4.5, 'close').err, 'close 剪法已撤：必须报「不认识这种剪法」');
  /* 段列表原样没被动过（被拒的剪法不许半途改数据） */
  assert.equal(c.segs.length, 3);
  assert.equal(c.segs[1].gap, 1);
}

/* ── 2. 拖走自动空那一支写出来的空段：同长、占时间、gap 标记齐全（形状判据） ── */
{
  const me = { in: 2, out: 5, a: 2, b: 5 };
  const gap = { in: 2, out: 5, a: 2, b: 5, off: 1, gap: 1 };
  assert.ok(isGap(gap), '自动空段必须是 isGap 认得出的空段');
  assert.equal(gap.out - gap.in, me.out - me.in, '空段与被拖走那一段同长（时间守恒）');
}

/* ── 3. segCarry / segsCopy / segsWrite 一圈不丢 off 与 gap ── */
{
  const o = segCarry({ in: 0, out: 1, off: 1, gap: 1 }, {});
  assert.equal(o.off, 1);
  assert.equal(o.gap, 1);
  const cp = segsCopy([{ in: 0, out: 1, off: 1, gap: 1 }]);
  assert.equal(cp[0].off, 1);
  assert.equal(cp[0].gap, 1);
  const cand = {};
  const wrote = segsWrite(cand, 10, [{ in: 0, out: 2 }, { in: 2, out: 3, off: 1, gap: 1 }]);
  assert.equal(wrote[1].off, 1);
  assert.equal(wrote[1].gap, 1);
  const back = segsOf(cand, 10);
  assert.equal(back[1].gap, 1, 'segsOf 归一后 gap 仍在');
}

/* ── 4. 落在空段区间里的配音不挂空段；落在 drop 黑场上的配音仍留原段 ── */
{
  const voices = [
    { id: 'v1', shotId: 's1', candId: 'c1', seg: 1, at: 0.5, dur: 1, fa: 2.5, fb: 3.5 },  // 压在空段上
  ];
  const { t } = T(voices);
  const oldSegs = segsOf({ segs: [{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 4, a: 2, b: 4 }, { in: 4, out: 6, a: 4, b: 6 }] }, 10);
  /* 新段列表：中间那段变成空段 */
  const newSegs = segsOf({ segs: [{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 4, a: 2, b: 4, off: 1, gap: 1 }, { in: 4, out: 6, a: 4, b: 6 }] }, 10);
  t.reanchorVoices({ id: 's1' }, { vid: 'c1' }, oldSegs, newSegs);
  assert.notEqual(voices[0].seg, 1, '配音不能挂在空段上');
  /* drop 黑场（off && !gap）上的配音仍留原段 —— 今天的行为 */
  const voices2 = [{ id: 'v2', shotId: 's1', candId: 'c1', seg: 1, at: 0.5, dur: 1, fa: 2.5, fb: 3.5 }];
  const { t: t2 } = T(voices2);
  const newSegs2 = segsOf({ segs: [{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 4, a: 2, b: 4, off: 1 }, { in: 4, out: 6, a: 4, b: 6 }] }, 10);
  t2.reanchorVoices({ id: 's1' }, { vid: 'c1' }, oldSegs, newSegs2);
  assert.equal(voices2[0].seg, 1, 'drop 黑场上的配音仍留在原段');
}

/* ── 5. drop 对 gap 段报 err；merge 对含 gap 的邻接报 err ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 3, a: 2, b: 3, off: 1, gap: 1 }]);
  assert.ok(t.cutSegs(c, 10, 2.5, 'drop').err, 'drop 对空段必须报 err');
  const c2 = C([{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 3, a: 2, b: 3, off: 1, gap: 1 }, { in: 3, out: 5, a: 3, b: 5 }]);
  const r2 = t.cutSegs(c2, 10, 3.5, 'merge');   // 插针在第三段，试与左边（空段）融
  assert.ok(r2.err, 'merge 含 gap 的邻接必须报 err');
}

console.log('✓ 空段：剪法已撤改拖走自动空 / 搬运链 / 配音不挂空段 / drop·merge 拒绝');
