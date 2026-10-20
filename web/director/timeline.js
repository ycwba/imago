/* 时间线几何：两条轨（本镜 / 全片）共用的框、轴秒、灰场与折算。
   纯函数 + 一份按 tl 对象引用缓存的 filmFrames；不碰 DOM。
   数据层一律是**源秒**；画出来那一遍才折算成轴秒（框 ÷ 倍速）。 */
import { round1 } from './util.js';
import { segsOf, segSpd, picLnOf, laneClamp, tlClipDur } from './segments.js';

export function createTimeline({ allShots, tlCandidateOf, candDur }) {
  /* 全片轨的一格来自时间线上的 clip；读不到源段时退回它的选区。 */
  function clipFrame(cl) {
    const fb = { a: Math.max(0, Number(cl && cl.in) || 0), b: Math.max(0, Number(cl && cl.out) || 0), ln: 0 };
    if (!cl || cl.kind !== 'shot') return fb;
    const t = allShots().find(x => x.id === cl.shotId);
    const cand = t ? tlCandidateOf(t, cl.candId) : null;
    if (!t || !cand) return fb;
    const list = segsOf(cand, candDur(cand, t));
    const s = list[Math.min(list.length - 1, Math.max(0, Number(cl.seg) || 0))];
    return s ? { a: s.a, b: s.b, ln: picLnOf(s) } : fb;
  }

  /* 算一次、整渲染期共用（按 tl 的**对象引用**记：每次 tlSyncFromShots 都会造新对象，所以不会读旧值）。
     播放跟随时每帧都要换算，不缓存的话一帧要遍历所有镜头重算一遍 segsOf。 */
  let filmGeomCache = { tl: null, g: null };
  function filmFrames(tl) {
    if (filmGeomCache.tl === tl && filmGeomCache.g) return filmGeomCache.g;
    const rows = [];
    let acc = 0, film = 0;
    ((tl && tl.clips) || []).forEach(cl => {
      const f = clipFrame(cl);
      const d = Math.max(0.05, f.b - f.a);
      /* `dur` = 框在**源**里有多长（把手拖的、切片取的、灰遮罩比的都是它，口径一个字不动）；
         `w` = 这一格在轨道那一排上占的**轴秒** = `dur / spd`。
         倍速缩的是轴不是框：2 倍速时这一格整排缩短一半，而框内两块灰的比例一点没变 ——
         于是「倍速把轨道拉长 / 缩小」（用户点名的那件事）与「剪一段不影响别的段」同时成立。
         这一根轴对**进成片的部分**就是成片秒（选区 `(out-in)/spd` = `tlClipDur`），
         只有灰掉那两块是「本来会占、其实没占」的秒数 —— 全片总时长另算（`filmTotal`）。 */
      const sp = Math.max(0.25, Math.min(4, Number(cl.speed) || 1));
      /* `ln` = 这一格落在画面轨的第几行（与「本镜」那一排同一个数：行号存在段上，不是两排各排一次）。
         排版依据仍然是框与轴秒，行只决定「画在哪一条横带里」，时间线一个字节都不动。 */
      /* `f0` / `fd` = 这一格在**成片秒**上的起点与时长（Σ 前面每一格的 tlClipDur）——
         与代理的 `offset += outDur` 是同一本账。为什么要多存这一对：配音的跳过判定
         （`clipVoices` 的 ctx）走成片秒这一把尺子，而排版走上面的轴秒（`start` / `w`）——
         两把尺子各管各的，别混用（合成按成片秒、画块按轴秒，见 `filmLayGray` 的注释）。 */
      const fd = tlClipDur(cl);
      rows.push({ cl: cl, k: rows.length, a: f.a, b: f.b, dur: d, spd: sp, ln: laneClamp(f.ln),
        w: Math.max(0.05, d / sp), start: acc, f0: film, fd: fd });
      acc += Math.max(0.05, d / sp);
      film += fd;
    });
    const g = { rows: rows, total: acc, filmTotal: film };
    filmGeomCache = { tl: tl, g: g };
    return g;
  }

  /* 灰场（轨道上那一排**没有画面**的秒）有三把尺子，别混用：
     ①② `axisGray` —— **轴秒**（两条轨各用一次：本镜那一排的行读 `r.s`、全片那一排的行读 `r.cl`。
         两排现在同一套几何 —— 那一排也按「框 ÷ 这一段的倍速」摊，所以是**同一份实现**而不是两条）；
     ③ `filmLayGray` —— **成片秒**（算跳过用：`clipVoices` 的 ctx / 指纹 / 播放计划 ——
       与代理的 `offset` 累加同一本账，`f0` / `fd` 就是为此存的）。
     ①② 都带 round1（与画出来的位置同一份读数），且都要**包得住两种灰**
     （整格黑场 + 框内被剪掉的头尾 —— 见 `voiceRuns` 上面那段）：轨道上那两块 mask 画的本来就是灰纹，
     配音压上去却说「没有重合」，等于界面自己前后矛盾。
     ③ **不取整**（差 0.05 秒就会让「压上去的那一秒」在音频侧与画面上各说各话），
     且只认整格黑场 —— 被剪掉的头尾在成片里根本不占时间，没有洞可跳。
     每条灰场是 `[起, 止, 是不是成片里的真洞]`：黑场 = 1，头尾 = 0。 */
  function graySpans(a, b, inX, outX, gone) {
    const lo = Math.min(Number(a) || 0, Number(b) || 0), hi = Math.max(Number(a) || 0, Number(b) || 0);
    if (gone) return hi - lo > 0.02 ? [[lo, hi, 1]] : [];
    const i = Math.max(lo, Math.min(hi, Number(inX) || 0)), o = Math.max(lo, Math.min(hi, Number(outX) || 0));
    const out = [];
    if (i - lo > 0.02) out.push([lo, i, 0]);
    if (hi - o > 0.02) out.push([o, hi, 0]);
    return out;
  }
  /* 轴秒上的两块头尾 = 源秒那两块**除以这一格的倍速**（框与选区都按 `r.spd` 折算，
     漏掉倍速就是「2 倍速那一格上灰带画到画面外面去」）。
     两条轨共用这一份：行的形状（`start` / `w` / `a` / `b` / `spd`）本来就同一套，
     只是负载不同 —— 全片那一排读 `r.cl`（时间线上的那一条），本镜那一排读 `r.s`（候选自己的那一段）。
     以前本镜另有一份按**源秒**的 `segsGray`，两条轨各量各的灰，配音块压在格子上时
     两排算出来的「重合几秒」不是一回事（倍速 ≠ 1 才露馅）。 */
  const axisGray = G => (G.rows || []).reduce((acc, r) => {
    const s = r.s || r.cl || {};
    const i = Math.max(r.a, Math.min(r.b, Number(s.in) || 0)), o = Math.max(r.a, Math.min(r.b, Number(s.out) || 0));
    return acc.concat(graySpans(round1(r.start), round1(r.start + r.w),
      round1(r.start + (i - r.a) / r.spd), round1(r.start + (o - r.a) / r.spd),
      r.s ? !!s.off : !!(r.cl && r.cl.gray)));
  }, []);
  const filmLayGray = G => G.rows.filter(r => r.cl && r.cl.gray).map(r => [r.f0, r.f0 + r.fd]);
  /* 轴秒 ↔ 源秒：格子里的一切换算只走这两行（以前只有一根轴，两个方向写成一行就够；
     倍速把两根轴拉开之后，任何一处忘了折算都是「针与格子对不上」的旧病复发）。 */
  const frameToSrc = (r, tFrame) => round1(Math.max(r.a, Math.min(r.b, r.a + (tFrame - r.start) * r.spd)));
  /* 源秒 → 轴秒：与上面同一条式子的逆（夹在框里，灰区不许把点甩到格子外面）。 */
  const srcToFrame = (r, s) => round1(r.start + (Math.max(r.a, Math.min(r.b, s)) - r.a) / r.spd);

  /* 本镜轨的轴 —— 与 filmFrames 同一套几何，只是行来自「这一条候选自己的 segs」。
     两条不变的性质：① 倍速全为 1 时 `start` 恰好等于 `s.a`、`w` 恰好等于 `b − a`；
     ② 数据层**一律还是源秒** —— `c.segs` 的 `a/b/in/out`、`proj.cutAt`、配音的 `at/dur/fa/fb/off`
     全都不动，只有画出来的那一遍做折算（否则倍速一改就要重写整本剪辑账）。 */
  function shotFrames(segs) {
    const rows = [];
    let acc = 0;
    (segs || []).forEach((s, i) => {
      const d = Math.max(0.05, (Number(s.b) || 0) - (Number(s.a) || 0));
      const sp = segSpd(s);
      rows.push({ s: s, i: i, a: round1(s.a), b: round1(s.b), dur: d, spd: sp, ln: picLnOf(s),
        w: Math.max(0.05, d / sp), start: acc });
      acc += Math.max(0.05, d / sp);
    });
    return { rows: rows, total: acc };
  }
  /* 轴秒落在哪一格（针、鼠标都在这根轴上；接缝归左边那一格，越界夹到首 / 末格）。 */
  const shotRowAt = (G, tAx) => {
    const rows = (G && G.rows) || [];
    for (const r of rows) if (tAx < r.start + r.w) return r;
    return rows.length ? rows[rows.length - 1] : null;
  };
  /* 源秒落在哪一格的**框**里（数据层进来的数一律是源秒：插针、把手、配音的 `seg`）。
     段与段之间真有缝时归到缝右边那一格，`srcToFrame` 会把它夹到那一格的左沿。 */
  const shotRowOf = (G, src) => {
    const rows = (G && G.rows) || [];
    if (!rows.length) return null;
    const x = Math.max(rows[0].a, Math.min(rows[rows.length - 1].b, Number(src) || 0));
    for (const r of rows) if (x < r.b) return r;
    return rows[rows.length - 1];
  };
  /* 数据里的插针（源秒）→ 这一排的针该画在第几秒（轴秒）。 */
  const shotPinT = (G, src) => { const r = shotRowOf(G, src); return r ? srcToFrame(r, src) : 0; };
  /* 这一排时间基的总长：一段都没有时退回候选时长，免得刻度尺塌成 0 格（「一段画面都不留」是有效状态）。 */
  const shotAxTotal = (G, total) => Math.max(0.05, (G && G.rows && G.rows.length) ? G.total : (Number(total) || 0));

  return {
    clipFrame, filmFrames, graySpans, axisGray, filmLayGray, frameToSrc, srcToFrame,
    shotFrames, shotRowAt, shotRowOf, shotPinT, shotAxTotal,
  };
}
