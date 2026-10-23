/* 时间线几何：两条轨（本镜 / 全片）共用的选区、轴秒、灰场与折算。
   纯函数 + 一份按 tl 对象引用缓存的 filmFrames；不碰 DOM。
   数据层一律是**源秒**；画出来那一遍才折算成轴秒（选区 ÷ 倍速）。
   每格有两个区间，只有一个参与排版：
   · **选区** `[in,out]` = 真进成片的那一截 —— 轨道上的 left/width、切片取帧、轴秒 ↔ 源秒
     全按它算，所以「画出来多宽」与「成片里占几秒」是同一个数（合成那本账不用另算一遍）；
   · **框** `[a,b]` = 这一段从源里分到的那一块，只剩一个用处：**把手往外拖最多恢复到这儿**。
     被剪掉的头尾不再占轨道上的秒，也不再画成遮挡 —— 剪短就是这一格当场变窄，
     后面的格子在轴上整体前移，跟手拖的时候看到的就是成片要成的样子。 */
import { round1 } from './util.js';
import { segsOf, segSpd, picLnOf, laneClamp, tlClipDur } from './segments.js';

/* 一格的选区：老数据没有入出点（或读出来是零长）时选区 = 框 —— 与加这一段之前逐字相同。 */
const selRange = (a, b, inX, outX) => {
  const lo = Math.min(Number(a) || 0, Number(b) || 0), hi = Math.max(Number(a) || 0, Number(b) || 0);
  const i = Number(inX), o = Number(outX);
  if (!(i >= lo) || !(o > i)) return { in: lo, out: hi };
  return { in: Math.min(hi, Math.max(lo, i)), out: Math.min(hi, Math.max(lo, o)) };
}

export function createTimeline({ allShots, tlCandidateOf, candDur }) {
  /* 全片轨的一格来自时间线上的 clip：框读源段（读不到就退回 clip 自己的选区），
     选区优先读源段 —— 两排都从同一份 `c.segs` 取值，本镜那一排与全片那一排才不会各说各话。 */
  function clipFrame(cl) {
    const zi = Math.max(0, Number(cl && cl.in) || 0);
    const zo = Math.max(zi, Number(cl && cl.out) || 0);
    const fb = { a: zi, b: zo, in: zi, out: zo, ln: 0 };
    if (!cl || cl.kind !== 'shot') return fb;
    const t = allShots().find(x => x.id === cl.shotId);
    const cand = t ? tlCandidateOf(t, cl.candId) : null;
    if (!t || !cand) return fb;
    const list = segsOf(cand, candDur(cand, t));
    const s = list[Math.min(list.length - 1, Math.max(0, Number(cl.seg) || 0))];
    if (!s) return fb;
    const se = selRange(s.a, s.b, s.in, s.out);
    return { a: s.a, b: s.b, in: se.in, out: se.out, ln: picLnOf(s) };
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
      const d = Math.max(0.05, f.out - f.in);
      /* `dur` = 选区在**源**里有多长（排版、取帧、把手夹取比的都是它）；
         `w` = 这一格在轨道那一排上占的**轴秒** = `dur / spd` = 这一格在成片里占的秒数。
         倍速缩的是轴不是选区：2 倍速时这一格整排缩短一半，格子内容与后面每一格跟着挪。 */
      const sp = Math.max(0.25, Math.min(4, Number(cl.speed) || 1));
      /* `ln` = 这一格落在画面轨的第几行（与「本镜」那一排同一个数：行号存在段上，不是两排各排一次）。
         行只决定「画在哪一条横带里」，时间线一个字节都不动。 */
      /* `f0` / `fd` = 这一格在**成片秒**上的起点与时长（Σ 前面每一格的 tlClipDur）——
         与代理的 `offset += outDur` 是同一本账。排版那把轴秒现在与它同一把尺子
         （`w` = `fd`、`start` = `f0`，只差 round1 与 0.05/0.1 两个下限），
         仍然两个数都存：合成侧与播放计划读的是成片秒，不许改成跟着排版走。 */
      const fd = tlClipDur(cl);
      rows.push({ cl: cl, k: rows.length, a: f.a, b: f.b, in: f.in, out: f.out, dur: d, spd: sp,
        ln: laneClamp(f.ln), w: Math.max(0.05, d / sp), start: acc, f0: film, fd: fd });
      acc += Math.max(0.05, d / sp);
      film += fd;
    });
    const g = { rows: rows, total: acc, filmTotal: film };
    filmGeomCache = { tl: tl, g: g };
    return g;
  }

  /* 灰场（轨道上那一排**没有画面**的秒）只剩一种，仍有两把尺子，别混用：
     ① `axisGray` —— **轴秒**（两条轨各用一次：本镜那一排的行读 `r.s`、全片那一排的行读 `r.cl`，
         两排同一套几何，所以是**同一份实现**而不是两条）；
     ② `filmLayGray` —— **成片秒**（算跳过用：`clipVoices` 的 ctx / 指纹 / 播放计划 ——
       与代理的 `offset` 累加同一本账，`f0` / `fd` 就是为此存的）。
     两种尺子都只认**整格黑场**（`s.off` / `cl.gray`）：那几秒在成片里真占时间，音频在那儿停住、
     越过之后接着放，所以配音块要顺延拉长、重合处要画灰带。
     剪掉的头尾不再出现在这份清单里 —— 它们不占轨道上的秒，也没有「压在灰场上」这件事可算。
     每条灰场仍是 `[起, 止, 是不是成片里的真洞]`（第三个元素恒 1，`voiceRuns` 那一份算式不分叉）。 */
  const axisGray = G => (G.rows || []).reduce((acc, r) => {
    const s = r.s || r.cl || {};
    const gone = r.s ? !!s.off : !!(r.cl && r.cl.gray);
    const lo = round1(r.start), hi = round1(r.start + r.w);
    return gone && hi - lo > 0.02 ? acc.concat([[lo, hi, 1]]) : acc;
  }, []);
  const filmLayGray = G => G.rows.filter(r => r.cl && r.cl.gray).map(r => [r.f0, r.f0 + r.fd]);
  /* 轴秒 ↔ 源秒：格子里的一切换算只走这两行（以前只有一根轴，两个方向写成一行就够；
     倍速把两根轴拉开之后，任何一处忘了折算都是「针与格子对不上」的旧病复发）。
     两头都夹在**选区**里：落在被剪掉的那截源秒上的点（插针、配音落点）会夹到这一格的边上，
     不会再被摆到「格子外面那块灰」上 —— 那一块如今根本不占轨道上的秒。 */
  const frameToSrc = (r, tFrame) => round1(Math.max(r.in, Math.min(r.out, r.in + (tFrame - r.start) * r.spd)));
  const srcToFrame = (r, s) => round1(r.start + (Math.max(r.in, Math.min(r.out, s)) - r.in) / r.spd);

  /* 本镜轨的轴 —— 与 filmFrames 同一套几何，只是行来自「这一条候选自己的 segs」。
     两条不变的性质：① 倍速全为 1、没剪过头尾时 `start` 恰好等于 `s.in`、`w` 恰好等于 `out − in`；
     ② 数据层**一律还是源秒** —— `c.segs` 的 `a/b/in/out`、`proj.cutAt`、配音的 `at/dur/fa/fb/off`
     全都不动，只有画出来的那一遍做折算（否则倍速一改就要重写整本剪辑账）。 */
  function shotFrames(segs) {
    const rows = [];
    let acc = 0;
    (segs || []).forEach((s, i) => {
      const se = selRange(s.a, s.b, s.in, s.out);
      const d = Math.max(0.05, se.out - se.in);
      const sp = segSpd(s);
      rows.push({ s: s, i: i, a: round1(s.a), b: round1(s.b), in: se.in, out: se.out,
        dur: d, spd: sp, ln: picLnOf(s), w: Math.max(0.05, d / sp), start: acc });
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
  /* 源秒落在哪一格的**选区**里（数据层进来的数一律是源秒：插针、把手、配音的 `seg`）。
     先找选区**真的包住**它的那一格：图片段用虚拟坐标（见 image-seg.js），与视频的 [0,total]
     之间有缝，「第一个右沿比它大的」会把缝判给前一张图。找不到（越界 / 落在缝里 / 落在被剪掉的那截上）
     再归最近的那一格，`srcToFrame` 会把它夹到那一格的边上。 */
  const shotRowOf = (G, src) => {
    const rows = (G && G.rows) || [];
    if (!rows.length) return null;
    const x = Number(src) || 0;
    for (const r of rows) if (x >= r.in && x < r.out) return r;
    let best = rows[0], bd = Infinity;
    rows.forEach(r => {
      const d = x < r.in ? r.in - x : x > r.out ? x - r.out : 0;
      if (d < bd) { bd = d; best = r; }
    });
    return best;
  };
  /* 数据里的插针（源秒）→ 这一排的针该画在第几秒（轴秒）。 */
  const shotPinT = (G, src) => { const r = shotRowOf(G, src); return r ? srcToFrame(r, src) : 0; };
  /* 这一排时间基的总长：一段都没有时退回候选时长，免得刻度尺塌成 0 格（「一段画面都不留」是有效状态）。 */
  const shotAxTotal = (G, total) => Math.max(0.05, (G && G.rows && G.rows.length) ? G.total : (Number(total) || 0));

  return {
    clipFrame, filmFrames, axisGray, filmLayGray, frameToSrc, srcToFrame,
    shotFrames, shotRowAt, shotRowOf, shotPinT, shotAxTotal,
  };
}
