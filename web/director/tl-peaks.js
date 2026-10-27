/* 波形 peaks（纯件，无 DOM）—— 参考 lib/waveform.js 的预算口径：
   每秒 PEAKS_PER_SECOND 根，值域 0–1（RMS 与峰值取大后按全段最大值归一化）。
   数组覆盖**这一段 clip 的源窗口**（下标 0 = sourceStart），所以切刀/裁剪按比例切数组即可。
   画成什么样（CSS 条）在 engine/strip.js，这里只算数。 */

import { num } from './util.js';

export const PEAKS_PER_SECOND = 48;

const clamp01 = v => Math.max(0, Math.min(1, v));

export const normalizePeaks = raw => (Array.isArray(raw) ? raw : []).map(v => clamp01(num(v)));

export const peaksBars = seconds => Math.max(1, Math.round(Math.max(0, num(seconds)) * PEAKS_PER_SECOND));

/* 按比例切数组：`from` / `to` 是 0–1 的比例（切刀与把手都用这一份）。 */
export function slicePeaks(peaks, from, to) {
  const list = Array.isArray(peaks) ? peaks : [];
  if (!list.length) return [];
  const n = list.length;
  const i0 = Math.max(0, Math.min(n, Math.floor(clamp01(num(from)) * n)));
  const i1 = Math.max(i0, Math.min(n, Math.ceil(clamp01(num(to)) * n)));
  return list.slice(i0, i1).map(v => clamp01(num(v)));
}

/* 重采样成固定根数（切完两半根数会变，画的时候按格数再摊一次）。 */
export function resamplePeaks(peaks, bars) {
  const list = Array.isArray(peaks) ? peaks : [];
  const n = Math.max(1, Math.round(num(bars, 1)));
  if (!list.length) return new Array(n).fill(0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / n * list.length);
    const b = Math.max(a + 1, Math.floor((i + 1) / n * list.length));
    let max = 0;
    for (let j = a; j < b && j < list.length; j++) max = Math.max(max, clamp01(num(list[j])));
    out[i] = max;
  }
  return out;
}

/* 从解码后的单声道采样造 peaks：每格取 RMS 与峰值的较大者，最后按全段最大值归一化。 */
export function peaksFromSamples(samples, sampleRate, perSecond = PEAKS_PER_SECOND) {
  const data = samples && samples.length ? samples : null;
  if (!data) return [];
  const sr = Math.max(1, num(sampleRate, 48000));
  const per = Math.max(1, Math.round(num(perSecond, PEAKS_PER_SECOND)));
  const step = Math.max(1, Math.round(sr / per));
  const out = [];
  for (let i = 0; i < data.length; i += step) {
    let sum = 0, peak = 0, n = 0;
    for (let j = i; j < Math.min(data.length, i + step); j++) {
      const v = Number(data[j]) || 0;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
      n++;
    }
    out.push(Math.max(n ? Math.sqrt(sum / n) : 0, peak));
  }
  const max = out.reduce((m, v) => Math.max(m, v), 0);
  return max > 0 ? out.map(v => clamp01(v / max)) : out.map(() => 0);
}
