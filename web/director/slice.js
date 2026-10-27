/* 数据层预算（「解多少帧」的唯一口径）：一条素材的帧索引解多密由这里一处算；
   显示层要摆几格由 tl-filmstrip.js（frameCountFor / planFrameTimes）另一处算。
   两层各管各的，合成一层就会「解了 480 帧只画 8 格」，或反过来「画 60 格每格都触发一次解码」。
   档位按素材时长走：越长的素材每格跨的源秒越大（30 分钟的素材按 1/30s 解就是 5.4 万帧），
   封顶 480 —— 一条素材的帧索引到顶就不再变密，磁贴再放大也只从索引里挑已有的帧。 */
export const FRAME_INDEX_MAX = 480;
export function frameIndexPlan(dur) {
  const d = Math.max(0.1, Number(dur) || 0);
  const step = d <= 16 ? 1 / 30 : d <= 30 ? 1 / 20 : d <= 60 ? 0.1 : d <= 120 ? 0.2 : d <= 600 ? 0.5 : 1.5;
  return { step, count: Math.min(FRAME_INDEX_MAX, Math.max(1, Math.ceil(d / step))) };
}
/* 数据层栅格时刻：0 起按 step 等分到时长，按 0.001s 量化、升序去重。
   栅格与磁贴采样点不是同一套 —— 磁贴时刻由就近顶上兜住（strip.js 的 urlsAligned），
   不要求两套栅格点重合。 */
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
