/* 时间切片几何：定宽磁贴、每格张数、采样时刻与切片盒标记。
   从 web/director/engine.js 拆出。 */

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
/* 采样时刻吸附到**绝对时间栅格**：量化步长只取这几档里离 `step` 最近的一档。
   定宽磁贴让每一格在缩放后仍落在同一个屏幕位置，但左沿对应的源秒会跟着比例尺整体平移；
   若按 `a + i·step` 取，缩放一次所有时刻都变、缓存全不命中（用户看到的正是「缩放就重解」）。
   吸附之后 `t = k·q` 与框的位置无关，只要比例尺没跨档，同一批时刻原样复用。 */
export const SLICE_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5];
export function snapSliceStep(step) {
  const s = Math.max(0.01, Number(step) || 0);
  let best = SLICE_STEPS[0];
  for (const q of SLICE_STEPS) if (Math.abs(q - s) < Math.abs(best - s)) best = q;
  return best;
}
/* 这一格里采哪几个时刻（**源秒**）：每张磁贴按左沿位置取离它最近的绝对栅格点，
   夹回框内、按 0.001 秒量化后相邻去重。第一张是例外 —— 它必须是这一段自己的第一帧，
   所以钉在 `lo` 上；其余全部落在 `q` 的整数倍上，缩放时整批原样复用。
   `sliceBoxHTML` 写下的 step 仍是屏上比例尺，这里只把它折算成栅格档 ——
   两处读的是同一个函数，不会各算一档。 */
export function sliceTimes(a, b, n, step) {
  const lo = Math.max(0, Number(a) || 0);
  const hi = Math.max(lo + 0.01, Number(b) || 0);
  const k = Math.max(1, Math.min(SLICE_N_MAX, Math.round(Number(n) || 1)));
  const st = Math.max(0.01, Number(step) || (hi - lo) / k);
  const q = snapSliceStep(st);
  const out = [];
  for (let i = 0; i < k; i++) {
    const x = Math.round(Math.max(lo, Math.min(hi - 0.02, Math.round((lo + st * i) / q) * q)) * 1000) / 1000;
    if (!out.length || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}
