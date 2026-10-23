#!/usr/bin/env node
/* 空段（`gap`）与摘空段（`close`）：插空的两档（边界 +1 / 段中 +2）、越界报错、
   `gap` 标记穿过搬运链、`drop`/`merge` 不许顶替、配音不挂空段。
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

/* ── 1. 边界插空：段数 +1、该段 off===1 && gap===1、时长之和 = 原时长 + N ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 4, a: 0, b: 4 }]);
  const r = t.cutSegs(c, 10, 4, 'gap');          // 插针落在段边界（out 处）
  assert.ok(!r.err, '边界插空不该报错：' + r.err);
  assert.equal(r.segs.length, 2, '边界插空段数 +1');
  assert.equal(r.segs[1].off, 1);
  assert.equal(r.segs[1].gap, 1);
  assert.equal(isGap(r.segs[1]), true);
  assert.equal(r.gapLen, 1);
  const sum = r.segs.reduce((a, s) => a + (s.out - s.in), 0);
  assert.ok(Math.abs(sum - 5) < 1e-9, '各段时长之和 = 原 4s + 1s 空');
}

/* ── 2. 段中插空：段数 +2（切开 + 空段），左右两段的框与选区接得上 ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 6, a: 0, b: 6 }]);
  const r = t.cutSegs(c, 10, 3, 'gap');          // 插针落在段中间
  assert.ok(!r.err, '段中插空不该报错：' + r.err);
  assert.equal(r.segs.length, 3, '段中插空段数 +2');
  assert.equal(r.splitForGap, 1);
  assert.equal(r.segs[0].out, 3);
  assert.equal(r.segs[0].b, 3);
  assert.equal(r.segs[1].gap, 1);
  assert.equal(r.segs[2].in, 3);
  assert.equal(r.segs[2].a, 3);
  const sum = r.segs.reduce((a, s) => a + (s.out - s.in), 0);
  assert.ok(Math.abs(sum - 7) < 1e-9, '时长之和 = 原 6s + 1s 空');
}

/* ── 3. close：段数 −1、时长回落；close 对 off && !gap 报 err ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 4, a: 0, b: 4 }, { in: 4, out: 5, a: 4, b: 5, off: 1, gap: 1 }, { in: 5, out: 9, a: 5, b: 9 }]);
  const r = t.cutSegs(c, 10, 4.5, 'close');
  assert.ok(!r.err, 'close 对空段不该报错：' + r.err);
  assert.equal(r.segs.length, 2, 'close 后段数 −1');
  assert.equal(r.closed, 1);
  const sum = r.segs.reduce((a, s) => a + (s.out - s.in), 0);
  assert.ok(Math.abs(sum - 8) < 1e-9, '时长回落到 8s');
  /* 对「删掉画面」的黑场（off && !gap）必须拒绝 */
  const c2 = C([{ in: 0, out: 4, a: 0, b: 4, off: 1 }]);
  const r2 = t.cutSegs(c2, 10, 1, 'close');
  assert.ok(r2.err, 'close 对 off && !gap 必须报 err');
  /* 对有画面的段也拒绝 */
  const c3 = C([{ in: 0, out: 4, a: 0, b: 4 }]);
  assert.ok(t.cutSegs(c3, 10, 1, 'close').err, 'close 对有画面段必须报 err');
}

/* ── 4. segCarry / segsCopy / segsWrite 一圈不丢 off 与 gap ── */
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

/* ── 5. 落在空段区间里的配音不挂空段；落在 drop 黑场上的配音仍留原段 ── */
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

/* ── 6. gap 越界（T - at < 0.2）返回 err；夹短但 ≥0.2 时带 gapLen ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 4, a: 0, b: 4 }]);
  const r = t.cutSegs(c, 4.1, 4.0, 'gap');       // T=4.1，at=4.0 → 只剩 0.1s
  assert.ok(r.err, '越界插空必须报 err');
  /* 空间刚好够 0.5s：夹短后仍插得进，gapLen 照实说 */
  const r2 = t.cutSegs(c, 4.5, 4.0, 'gap');
  assert.ok(!r2.err, '剩余 0.5s 该插得进：' + r2.err);
  assert.ok(Math.abs(r2.gapLen - 0.5) < 1e-9, 'gapLen 说清实际插了 0.5s');
}

/* ── 7. drop 对 gap 段报 err；merge 对含 gap 的邻接报 err ── */
{
  const { t } = T();
  const c = C([{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 3, a: 2, b: 3, off: 1, gap: 1 }]);
  assert.ok(t.cutSegs(c, 10, 2.5, 'drop').err, 'drop 对空段必须报 err');
  const c2 = C([{ in: 0, out: 2, a: 0, b: 2 }, { in: 2, out: 3, a: 2, b: 3, off: 1, gap: 1 }, { in: 3, out: 5, a: 3, b: 5 }]);
  const r2 = t.cutSegs(c2, 10, 3.5, 'merge');   // 插针在第三段，试与左边（空段）融
  assert.ok(r2.err, 'merge 含 gap 的邻接必须报 err');
}

console.log('✓ 空段：插空两档 / close / 搬运链 / 配音不挂空段 / 越界 / drop·merge 拒绝');
