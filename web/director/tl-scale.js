/* 时间轴比例尺（纯函数，无 DOM）—— 与参考项目同一条路子：
   · 缩放是一个标量 zoom ∈ [0.25, 16]，1 = 默认视野 10 秒；
   · 内容层宽度 = 总长 ÷ 视野秒数（%，不足一屏按一屏铺满）；
   · 刻度密度跟着视野秒数走，像素换算只有 clientX→轴秒那一处（engine/timeline.js 的 board 里）。
   轴秒 = 成片秒（源秒 ÷ 倍速）。 */

export const TL_ZOOM_MIN = 0.25;
export const TL_ZOOM_MAX = 16;
export const TL_VISIBLE_DEFAULT = 10;
export const TL_VISIBLE_MIN = 0.5;
export const TL_FPS = 30;

const ZOOM_IN_CURVE = Math.log(TL_VISIBLE_DEFAULT / TL_VISIBLE_MIN) / Math.log(TL_ZOOM_MAX);

export function tlClampZoom(zoom) {
  return Math.max(TL_ZOOM_MIN, Math.min(TL_ZOOM_MAX, zoom));
}

/* zoom → 视野秒数：zoom ≤ 1 在「整部超长片」与 10 秒之间对数滑，> 1 按幂曲线收紧。 */
export function tlVisible(zoom) {
  const z = tlClampZoom(zoom);
  if (z <= 1) {
    const progress = (z - TL_ZOOM_MIN) / (1 - TL_ZOOM_MIN);
    const maxLog = Math.log(24 * 60 * 60);
    const defaultLog = Math.log(TL_VISIBLE_DEFAULT);
    return Math.exp(maxLog + (defaultLog - maxLog) * progress);
  }
  return Math.max(TL_VISIBLE_MIN, TL_VISIBLE_DEFAULT / Math.pow(z, ZOOM_IN_CURVE));
}

/* 视野秒数 → zoom（对数曲线的反函数，二分 32 轮到浮点精度）。 */
export function tlZoomForVisible(visible) {
  const target = Math.max(TL_VISIBLE_MIN, Math.min(24 * 60 * 60, Number(visible) || TL_VISIBLE_DEFAULT));
  let low = TL_ZOOM_MIN, high = TL_ZOOM_MAX;
  for (let i = 0; i < 32; i++) {
    const mid = (low + high) / 2;
    if (tlVisible(mid) > target) low = mid; else high = mid;
  }
  return tlClampZoom((low + high) / 2);
}

/* 「铺满」档：内容占视口 82%（两头留呼吸），短内容按 5 秒起算。 */
export function tlFitZoom(total, fill = 0.82) {
  const t = Math.max(0.5, Number(total) || 0.5);
  const ratio = Math.max(0.5, Math.min(0.9, Number(fill) || 0.82));
  return tlZoomForVisible(Math.max(5, t / ratio));
}

/* 初始档：空片 10 秒；超过一分钟先给 30 秒视野（铺满没意义），其余铺满。 */
export function tlInitialZoom(total) {
  const t = Number(total) || 0;
  if (t <= 0) return tlZoomForVisible(TL_VISIBLE_DEFAULT);
  if (t > 60) return tlZoomForVisible(30);
  return tlFitZoom(t);
}

/* 内容末尾那截可导航空白：短片 2 秒、一分钟内 5 秒、长片 5%。 */
export function tlTail(total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  if (t < 10) return 2;
  if (t <= 60) return 5;
  return Math.min(30, t * 0.05);
}

/* 导航总长 = 轨道要盖住的那一秒 + 尾垫（向上取整到 0.5 秒），下限 10 秒 —— 针可以放到内容末尾之后。
   reach 是轨道上比成片更靠右的那个落点：标记钉在成片秒、不随剪辑搬移，剪短之后可以留在成片末尾之外。
   不并进来的话那一截画不到尺、网格与行底色 —— 右边多出一条还能滚进去的空道，「跳到标记」也被针的夹算挡在门外。 */
export function tlNavTotal(total, reach = 0) {
  const span = Math.max(0, Number(total) || 0, Number(reach) || 0);
  if (span <= 0) return TL_VISIBLE_DEFAULT;
  return Math.max(TL_VISIBLE_DEFAULT, Math.ceil((span + tlTail(span)) * 2) / 2);
}

/* 内容层宽度 %（相对滚动视口）：内容不足一屏时按一屏铺满。 */
export function tlWidthPct(navTotal, zoom) {
  if (!(navTotal > 0)) return 100;
  return Math.max(100, (navTotal / tlVisible(zoom)) * 100);
}

/* 刻度密度分档：视野越小刻度越细。labelMode 决定大刻度带不带小数/帧。 */
export function tlRulerScale(visible) {
  if (visible <= 0.75) return { minorStep: 1 / TL_FPS, majorStep: 0.5, labelMode: 'frames' };
  if (visible <= 2) return { minorStep: 0.1, majorStep: 0.5, labelMode: 'subseconds' };
  if (visible <= 6) return { minorStep: 0.25, majorStep: 0.5, labelMode: 'subseconds' };
  if (visible <= 16) return { minorStep: 0.5, majorStep: 1, labelMode: 'seconds' };
  if (visible <= 45) return { minorStep: 1, majorStep: 5, labelMode: 'seconds' };
  if (visible <= 120) return { minorStep: 5, majorStep: 15, labelMode: 'seconds' };
  if (visible <= 420) return { minorStep: 15, majorStep: 60, labelMode: 'minutes' };
  if (visible <= 900) return { minorStep: 60, majorStep: 300, labelMode: 'minutes' };
  return { minorStep: 300, majorStep: 600, labelMode: 'minutes' };
}

const RULER_MAJOR_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/* 画哪几根刻度：只算视口前后各 35% 视野那一截（范围外不画）；
   档位倍升时小刻度 = 大刻度 ÷ 4、标签改回秒（否则 4 分钟一根还标 00:04 会读错）。 */
export function tlTicks(navTotal, zoom, visibleStart = 0, visibleEnd = navTotal, minimumMajorStep = 0) {
  if (!(navTotal > 0)) return [];
  const visible = tlVisible(zoom);
  const scale = tlRulerScale(visible);
  const majorStep = RULER_MAJOR_STEPS.find(step => step >= Math.max(scale.majorStep, minimumMajorStep))
    ?? RULER_MAJOR_STEPS[RULER_MAJOR_STEPS.length - 1];
  const raised = majorStep > scale.majorStep;
  const minorStep = raised ? majorStep / 4 : scale.minorStep;
  const labelMode = raised && majorStep >= 1 ? 'seconds' : scale.labelMode;
  const pad = Math.max(visible * 0.35, majorStep);
  const start = Math.max(0, visibleStart - pad);
  const end = Math.min(navTotal, visibleEnd + pad);
  const i0 = Math.max(0, Math.floor(start / minorStep));
  const i1 = Math.max(i0, Math.ceil(end / minorStep));
  const ticks = [];
  for (let i = i0; i <= i1; i++) {
    const time = Math.min(navTotal, i * minorStep);
    const isMajor = Math.abs(time / majorStep - Math.round(time / majorStep)) < 0.001;
    ticks.push({
      time,
      isMajor,
      label: isMajor ? tlTickLabel(time, labelMode) : '',
    });
  }
  return ticks;
}

/* 刻度标签：分:秒；subseconds 带百分秒、frames 带帧号。 */
export function tlTickLabel(value, mode = 'seconds') {
  const s = Math.max(0, Number.isFinite(value) ? value : 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const frame = Math.round((s - Math.floor(s)) * TL_FPS);
  const centi = Math.round((s - Math.floor(s)) * 100);
  const clock = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (mode === 'frames' && frame > 0) return `${clock}:${String(frame).padStart(2, '0')}f`;
  if (mode === 'subseconds' && centi > 0) return `${clock}.${String(centi).padStart(2, '0')}`;
  return clock;
}

/* 缩放读数：视野秒数的人话（15f / 3.2s / 45s / 2m）。 */
export function tlZoomLabel(zoom) {
  const visible = tlVisible(zoom);
  if (visible <= 0.75) return '15f';
  if (visible < 2) return `${visible.toFixed(1)}s`;
  if (visible < 60) return `${Math.round(visible)}s`;
  return `${Math.round(visible / 60)}m`;
}

/* 滚轮缩放：deltaY → zoom 倍率（指数，灵敏度 0.00056/像素，单次夹 ±640 像素）。 */
export const TL_WHEEL_SENS = 0.00056;

export function tlZoomByWheel(zoom, deltaY) {
  const delta = Math.max(-640, Math.min(640, Number(deltaY) || 0));
  return tlClampZoom(zoom * Math.exp(-delta * TL_WHEEL_SENS));
}

/* 缩到最远 = 「自适应」那一档：下限与铺满目标必须同一把尺子。
   两边填法不一样时（这里曾经是 0.9 对 0.82），applyZoom 会把自适应的值夹回来 ——
   「自适应」按下去到不了自己算出的那一档，缩小那颗也几乎没有行程。 */
export function tlZoomFloor(total) {
  return tlFitZoom(Math.max(0.5, Number(total) || 0.5));
}

/* ---------------- 像素 ↔ 秒（滚动、指针、自动跟随的唯一换算） ----------------
   视口里能看见 tlVisible(zoom) 秒，所以每像素多少秒 = 视野 ÷ 视口宽。
   内容层宽度 = max(视口宽, navTotal × pxPerSec)：比一屏短时按一屏铺满（时间线不留半截空白）。 */
export function tlPxPerSec(viewportWidth, zoom) {
  const w = Math.max(1, Number(viewportWidth) || 1);
  return w / tlVisible(zoom);
}

/* 内容层像素宽（给滚动容器里的那一层定宽）。 */
export function tlTimelineWidth(navTotal, viewportWidth, zoom) {
  const w = Math.max(1, Number(viewportWidth) || 1);
  return Math.max(w, Math.max(0, Number(navTotal) || 0) * tlPxPerSec(w, zoom));
}

/* 某个像素位置对应的成片秒（clientX 先换成滚动容器里的 x 再进来）。 */
export const tlTimeAtX = (x, pxPerSec) => Math.max(0, (Number(x) || 0) / Math.max(0.0001, pxPerSec));

/* 某一刻距滚动容器左沿多少像素（写播放头 left / 自动跟随都走它）。 */
export const tlXOfTime = (time, pxPerSec) => Math.max(0, Number(time) || 0) * Math.max(0.0001, pxPerSec);

/* 指针锚定缩放：光标底下那个时间点在缩放前后落在同一个像素上（参考 Timeline.jsx 的滚轮段）。
   返回新的 scrollLeft；`xInViewport` 是光标相对**视口左沿**的像素。 */
export function tlAnchoredScroll(scrollLeft, xInViewport, viewportWidth, zoom, nextZoom) {
  const w = Math.max(1, Number(viewportWidth) || 1);
  const pps = tlPxPerSec(w, zoom);
  const nextPps = tlPxPerSec(w, nextZoom);
  const atTime = (Math.max(0, Number(scrollLeft) || 0) + Math.max(0, Number(xInViewport) || 0)) / pps;
  return Math.max(0, atTime * nextPps - Math.max(0, Number(xInViewport) || 0));
}

/* 播放头越过视口 85% 就跟着滚一屏（参考 useTimelinePlayhead 的跟随）。
   没越界返回 null（调用方不写 scrollLeft）。 */
export function tlFollowScroll(playhead, scrollLeft, viewportWidth, zoom, ratio = 0.85) {
  const w = Math.max(1, Number(viewportWidth) || 1);
  const pps = tlPxPerSec(w, zoom);
  const x = tlXOfTime(playhead, pps) - Math.max(0, Number(scrollLeft) || 0);
  if (x >= 0 && x <= w * ratio) return null;
  return Math.max(0, tlXOfTime(playhead, pps) - w * 0.15);
}

/* 这一刻在不在视口里（「回播放头」那颗钮的显隐判据）。 */
export function tlTimeInView(time, scrollLeft, viewportWidth, zoom) {
  const w = Math.max(1, Number(viewportWidth) || 1);
  const pps = tlPxPerSec(w, zoom);
  const x = tlXOfTime(time, pps) - Math.max(0, Number(scrollLeft) || 0);
  return x >= 0 && x <= w;
}
