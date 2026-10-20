/* 时间切片几何：定宽磁贴、每格张数、采样时刻与切片盒标记。
   从 web/director/engine.js 拆出；round2 来自 util.js。 */
import { round2 } from './util.js';

/* 一张磁贴在屏上占多少像素 —— 与比例尺无关的一个常数（下面 `sliceGeom` 那一族的设计口径） */
export const SLICE_TILE_PX = 64;
/* 512 张 = 32768px 宽的一格才够得着：这条只是防御性上限（一张一次 seek，真跑满是渐进填的）。
   夹住之后把磁贴**放宽**到正好铺满整格（w/n）—— 到这一档说明比例尺已经推到顶，
   每张宽一点比「右边留一片没铺的洞」好看，也不会让一格里出现两张一模一样的画面。 */
export const SLICE_N_MAX = 512;
/* 一格摊几张（n）、每张屏上多宽（tile，px）、每张跨几秒源（step）—— 三个数只从这一处算，
   渲染那一遍与填帧那一遍都要问它，各算一次迟早对不上。
   `px` = 这一格在屏上有多少像素宽（轴秒 × 比例尺），`span` = 这一格的**框**跨几秒源。
   从前按比例尺分四档（48/56/64/76 像素每帧）并把张数**升到 2 的幂**，换的是「任意两档的采样点
   互为子集 → 缩放不作废旧帧」；代价是磁贴宽度跟着缩放漂，放大时看着就是把画面拉宽
   （用户点名的「无论怎么缩放切片大小应该保持一致」）。定宽之后采样点每次缩放都会挪，
   所以缩放会排一遍后台重解 —— 但**同步那一遍**照旧按「一张磁贴跨度内最近的一张」就地顶上
   （见 `tileFrames`），界面上永远先看到一套完整的画面，再逐张换清楚，不会先空一排。 */
export function sliceGeom(px, span) {
  const w = Math.max(0, Number(px) || 0);
  const s = Math.max(0.01, Number(span) || 0);
  if (!(w > 0)) return { n: 1, tile: SLICE_TILE_PX, step: s };
  const n = Math.max(1, Math.min(SLICE_N_MAX, Math.ceil(w / SLICE_TILE_PX)));
  const tile = n * SLICE_TILE_PX >= w ? SLICE_TILE_PX : w / n;
  return { n, tile, step: Math.max(0.01, s * tile / w) };
}
/* 段格上那只切片盒的标记：两排（本镜 / 全片）写的都是同样几个数，只在这一处拼。
   `data-step` 带六位小数而不是按 0.01 量化 —— 它是「px → 源秒」的比例尺，
   量化到一格 0.01 秒时看着没事，512 张累积能漂出两秒半（磁贴与画面彻底对不上）。 */
export const sliceBoxHTML = (src, a, b, px, pin) => {
  const g = sliceGeom(px, Math.max(0.01, (Number(b) || 0) - (Number(a) || 0)));
  return `<span class="frs" data-frs="${window.esc(src)}" data-in="${a}" data-out="${b}" data-pin="${pin}"`
    + ` data-n="${g.n}" data-step="${Math.round(g.step * 1e6) / 1e6}" style="--frs-w:${Math.round(g.tile * 10) / 10}px"></span>`;
};
/* 这一格里采哪几个时刻（**源秒**，按 0.01 秒量化后相邻去重）：
   采磁贴**左沿**（`a + i·step`）—— 与从前采格左沿同一个理由：剪一刀只动右半边，
   左边那几张的时刻原地不动，缓存照旧命中。量化格子 0.01 秒比任何一张磁贴跨的源秒都细
   （顶档 600px/秒时一张才跨 0.107 秒），正常路径一张不少；末尾那点去重只是防 `b-a` 极小这种脏数据。 */
export function sliceTimes(a, b, n, step) {
  const lo = Math.max(0, Number(a) || 0);
  const hi = Math.max(lo + 0.01, Number(b) || 0);
  const k = Math.max(1, Math.min(SLICE_N_MAX, Math.round(Number(n) || 1)));
  const st = Math.max(0.01, Number(step) || (hi - lo) / k);
  const out = [];
  for (let i = 0; i < k; i++) {
    const x = round2(Math.max(lo, Math.min(hi - 0.02, lo + st * i)));
    if (!out.length || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}
