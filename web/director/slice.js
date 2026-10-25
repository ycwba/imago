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
    /* 第一张钉在**这一段自己的第一帧**（lo 原样，只做 0.001 量化）——
       以前它也走「就近栅格」，段起点不在栅格上时（lo=1.3、q=0.5）第一张显示的是
       1.5 秒那一帧，与上面那句「第一张必须是这一段自己的第一帧」的承诺相反。 */
    const raw = i === 0 ? lo : Math.round((lo + st * i) / q) * q;
    const x = Math.round(Math.max(lo, Math.min(hi - 0.02, raw)) * 1000) / 1000;
    if (!out.length || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

/* ---------- 数据层预算（「解多少帧」的唯一口径） ----------
   与上面的显示层（磁贴几何，「画多少格」）是**两层**，不能合成一层：
   数据层决定一条素材的帧索引解多密（费解码、进缓存），显示层决定屏上摆几格（费 DOM）。
   合成一层就会「解了 480 帧只画 8 格」，或反过来「画 60 格每格都触发一次解码」。
   档位按素材时长走：越长的素材每格跨的源秒越大（30 分钟的素材按 1/30s 解就是 5.4 万帧），
   封顶 480 —— 一条素材的帧索引到顶就不再变密，磁贴再放大也只从索引里挑已有的帧。 */
export const FRAME_INDEX_MAX = 480;
export function frameIndexPlan(dur) {
  const d = Math.max(0.1, Number(dur) || 0);
  const step = d <= 16 ? 1 / 30 : d <= 30 ? 1 / 20 : d <= 60 ? 0.1 : d <= 120 ? 0.2 : d <= 600 ? 0.5 : 1.5;
  return { step, count: Math.min(FRAME_INDEX_MAX, Math.max(1, Math.ceil(d / step))) };
}
/* 数据层栅格时刻：0 起按 step 等分到时长，按 0.001s 量化、升序去重。
   栅格与磁贴的绝对栅格（SLICE_STEPS）不是同一套 —— 磁贴时刻由 at-or-before 查帧兜住
   （见 frameAtOrBefore），不要求两套栅格点重合。 */
export function frameIndexTimes(dur, plan) {
  const p = plan || frameIndexPlan(dur);
  const d = Math.max(0.1, Number(dur) || 0.1);
  const out = [];
  for (let i = 0; i < p.count; i++) {
    const x = Math.round(Math.min(d - 0.02, i * p.step) * 1000) / 1000;
    if (x < 0) break;
    if (!out.length || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}
/* at-or-before 二分：升序数组里 ≤ t 的**最后一帧**下标（没有给 -1）。
   语义与播放器「播到哪显哪帧」一致 —— 取最近邻会在 0.5 倍速时提前显出下一帧。 */
export function frameAtOrBefore(sorted, t) {
  if (!sorted || !sorted.length) return -1;
  const x = Number(t);
  if (!Number.isFinite(x)) return -1;
  let lo = 0, hi = sorted.length;                 // 第一个 > x 的下标
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
  return lo - 1;
}
