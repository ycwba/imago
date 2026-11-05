/* 裁剪（纯件，无 DOM）—— 参考 lib/anchoredResize.js：
   拖哪条边就只改哪条边，另一条边**锚定不动**。
   画面段的两头各有自己的边界：
     · 左缘外扩的上限 = 已经吃掉的源（sourceStart ÷ 倍速）；
     · 右缘外扩的上限 = 素材原长 − 已用窗口（film.js 的 srcLenOf）。
   成片秒与源秒之间只有 film.js 那把尺子（`rateOf` / `srcHeadOf` / `srcUsedOf` / `srcLenOf`），
   这一份只算「能动多少、动完之后各字段是什么」。 */

import { MAX_FILM_SECONDS, MIN_CLIP_SECONDS, MIN_CAPTION_SECONDS, pos, rateOf, srcHeadOf, srcLenOf, srcUsedOf } from './film.js';
import { num, round2 } from './util.js';

/* 画面段左缘：delta > 0 = 往里裁（变短），delta < 0 = 往外拉（变长）。 */
export function trimClipLeft(clip, deltaFilm) {
  if (!clip) return null;
  const rate = rateOf(clip);
  const dur = pos(clip.duration);
  const d = num(deltaFilm);
  if (!d) return clip;
  if (d > 0) {
    if (dur - d < MIN_CLIP_SECONDS) return null;
    if (clip.kind === 'image') return { ...clip, duration: round2(dur - d) };
    const srcDelta = round2(d * rate);
    return {
      ...clip,
      sourceStart: round2(pos(clip.sourceStart) + srcDelta),
      sourceDuration: round2(Math.max(0, pos(clip.sourceDuration) - srcDelta)),
      duration: round2(dur - d),
    };
  }
  if (clip.kind === 'image') return { ...clip, duration: round2(dur - d) };
  const backFilm = Math.min(-d, srcHeadOf(clip) / rate);              // 最多退到源的头
  if (!(backFilm > 0)) return null;
  const srcBack = round2(backFilm * rate);
  return {
    ...clip,
    sourceStart: round2(pos(clip.sourceStart) - srcBack),
    sourceDuration: round2(pos(clip.sourceDuration) + srcBack),
    duration: round2(dur + backFilm),
  };
}

/* 画面段左缘**锚定裁剪**（波纹关）：左缘动、右缘钉死 —— 时长变化折进段前空隙（gap），
   后面的段一秒都不挪。delta > 0 = 左缘往右裁（块从左边缩小、gap 变大）；
   delta < 0 = 往左拉长（吃 gap，gap 用尽就贴住前一段）。源上限仍由 trimClipLeft 那把尺子夹
   （实际吃下的量按「时长变了多少」反推，右缘锚定在任何夹取下都成立）。 */
export function trimClipLeftAnchored(clip, deltaFilm) {
  if (!clip) return null;
  const dur = pos(clip.duration);
  const gap = Math.max(0, num(clip.gap));
  let d = num(deltaFilm);
  if (d < -gap) d = -gap;                       // 往左最多吃到 gap 用尽
  if (!d) return { ...clip };
  const next = trimClipLeft(clip, d);
  if (!next) return null;
  const eff = round2(dur - pos(next.duration));  // 实际吃下的量（可能被源边界夹小）
  return { ...next, gap: round2(Math.max(0, gap + eff)) };
}

/* 画面段右缘：delta > 0 = 往外拉（变长），delta < 0 = 往里裁（变短）。 */
export function trimClipRight(clip, deltaFilm) {
  if (!clip) return null;
  const rate = rateOf(clip);
  const dur = pos(clip.duration);
  const d = num(deltaFilm);
  if (!d) return clip;
  if (clip.kind === 'image') {
    if (dur + d < MIN_CLIP_SECONDS) return null;
    return { ...clip, duration: round2(dur + d) };
  }
  const head = srcHeadOf(clip);
  const used = srcUsedOf(clip);
  if (d > 0) {
    const roomFilm = Math.min(d, (srcLenOf(clip) - head - used) / rate);   // 最多拉到素材的尾
    if (!(roomFilm > 0)) return null;
    return {
      ...clip,
      sourceDuration: round2(used + roomFilm * rate),
      duration: round2(dur + roomFilm),
    };
  }
  if (dur + d < MIN_CLIP_SECONDS) return null;
  const srcCut = round2(Math.min(used, -d * rate));
  return {
    ...clip,
    sourceDuration: round2(Math.max(0, used - srcCut)),
    duration: round2(dur + d),
  };
}

/* 配音块左缘（成片秒 + 源窗口一起动）：delta > 0 往右裁。 */
export function trimVoiceLeft(item, deltaFilm) {
  if (!item) return null;
  const rate = rateOf(item);
  const dur = pos(item.duration);
  const d = num(deltaFilm);
  if (!d) return item;
  if (d > 0) {
    if (dur - d < MIN_CLIP_SECONDS) return null;
    const srcDelta = round2(d * rate);
    return {
      ...item,
      start: round2(pos(item.start) + d),
      duration: round2(dur - d),
      sourceStart: round2(pos(item.sourceStart) + srcDelta),
      sourceDuration: round2(Math.max(0, pos(item.sourceDuration) - srcDelta)),
    };
  }
  const backFilm = Math.min(-d, srcHeadOf(item) / rate);
  if (!(backFilm > 0)) return null;
  return {
    ...item,
    start: round2(Math.max(0, pos(item.start) - backFilm)),
    duration: round2(dur + backFilm),
    sourceStart: round2(pos(item.sourceStart) - backFilm * rate),
    sourceDuration: round2(pos(item.sourceDuration) + backFilm * rate),
  };
}

/* 配音块右缘：delta > 0 往右拉长。上限是素材原长（原长未知时 = 已有窗口的尾，拉不动）。 */
export function trimVoiceRight(item, deltaFilm) {
  if (!item) return null;
  const rate = rateOf(item);
  const dur = pos(item.duration);
  const d = num(deltaFilm);
  if (!d) return item;
  const head = srcHeadOf(item);
  const used = srcUsedOf(item);
  if (d > 0) {
    const roomFilm = Math.min(d, (srcLenOf(item) - head - used) / rate);
    if (!(roomFilm > 0)) return null;
    return {
      ...item,
      duration: round2(dur + roomFilm),
      sourceDuration: round2(used + roomFilm * rate),
    };
  }
  if (dur + d < MIN_CLIP_SECONDS) return null;
  return {
    ...item,
    duration: round2(dur + d),
    sourceDuration: round2(Math.max(0, used + d * rate)),
  };
}

/* 字幕左缘（只动 start；end 锚定）。 */
export function trimCaptionLeft(cap, deltaFilm) {
  if (!cap) return null;
  const d = num(deltaFilm);
  if (!d) return cap;
  const start = pos(cap.start) + d;
  if (start < 0) return null;
  if (pos(cap.end) - start < MIN_CAPTION_SECONDS) return null;
  return { ...cap, start: round2(start) };
}

/* 字幕右缘（只动 end；start 锚定）。 */
export function trimCaptionRight(cap, deltaFilm) {
  if (!cap) return null;
  const d = num(deltaFilm);
  if (!d) return cap;
  const end = pos(cap.end) + d;
  if (end - pos(cap.start) < MIN_CAPTION_SECONDS) return null;
  return { ...cap, end: round2(end) };
}

/* ---------------- 精细编辑（滑移 / 滑动 / 编辑点） ----------------
   三者都只动画面段；delta 一律是**成片秒**，源窗口按 ÷ 倍速 折算。
   图片段没有源窗口，滑移无从谈起；编辑点与滑动对它只是改时长（邻居跟着伸缩）。 */

const EPS = 0.000001;

/* 滑移：画面窗口在段内前后挪，块在成片里的位置与时长都不变。
   前退的上限 = 已经吃掉的源；后挪的上限 = 素材还剩多少。 */
export function filmSlipBounds(clip) {
  if (!clip || clip.kind === 'image') return { minimum: 0, maximum: 0 };
  const rate = rateOf(clip);
  const head = srcHeadOf(clip);
  return {
    minimum: -head / rate,
    maximum: Math.max(0, srcLenOf(clip) - head - srcUsedOf(clip)) / rate,
  };
}

export function slipClip(clip, requestedDelta) {
  const bounds = filmSlipBounds(clip);
  const delta = Math.max(bounds.minimum, Math.min(bounds.maximum, num(requestedDelta)));
  if (!clip || Math.abs(delta) < EPS) return { clip, delta: 0, bounds };
  return {
    bounds,
    delta,
    clip: { ...clip, sourceStart: round2(srcHeadOf(clip) + delta * rateOf(clip)) },
  };
}

/* 编辑点（第 boundaryIndex 条切点，即 clips[boundaryIndex-1] 与 clips[boundaryIndex] 之间）：
   左边加长多少，右边就缩短多少，切点整体平移。 */
export function filmBoundaryBounds(clips, boundaryIndex) {
  const list = Array.isArray(clips) ? clips : [];
  const prev = list[boundaryIndex - 1];
  const next = list[boundaryIndex];
  if (!prev || !next) return { minimum: 0, maximum: 0 };
  let minimum = -(pos(prev.duration) - MIN_CLIP_SECONDS);
  let maximum = pos(next.duration) - MIN_CLIP_SECONDS;
  if (next.kind !== 'image') minimum = Math.max(minimum, -srcHeadOf(next) / rateOf(next));
  if (prev.kind !== 'image') maximum = Math.min(maximum, Math.max(0, srcLenOf(prev) - srcHeadOf(prev) - srcUsedOf(prev)) / rateOf(prev));
  return { minimum: Math.max(-MAX_FILM_SECONDS, minimum), maximum: Math.min(MAX_FILM_SECONDS, maximum) };
}

export function rollClipsBoundary(clips, boundaryIndex, requestedDelta) {
  const list = Array.isArray(clips) ? clips : [];
  const bounds = filmBoundaryBounds(list, boundaryIndex);
  const delta = Math.max(bounds.minimum, Math.min(bounds.maximum, num(requestedDelta)));
  if (!list[boundaryIndex - 1] || !list[boundaryIndex] || Math.abs(delta) < EPS) return { clips: list, delta: 0, bounds };
  const out = list.map((clip, i) => {
    if (i === boundaryIndex - 1) {
      const rate = rateOf(clip);
      return {
        ...clip,
        duration: round2(pos(clip.duration) + delta),
        ...(clip.kind === 'image' ? {} : { sourceDuration: round2(srcUsedOf(clip) + delta * rate) }),
      };
    }
    if (i !== boundaryIndex) return clip;
    const rate = rateOf(clip);
    return {
      ...clip,
      duration: round2(pos(clip.duration) - delta),
      ...(clip.kind === 'image' ? {} : {
        sourceStart: round2(srcHeadOf(clip) + delta * rate),
        sourceDuration: round2(srcUsedOf(clip) - delta * rate),
      }),
    };
  });
  return { clips: out, delta, bounds };
}

/* 滑动：这一段前后挪、时长不变，左右两段的编辑点跟着动（左段伸缩、右段伸缩）。
   首尾两段没有两侧邻居，滑不动。 */
export function filmSlideBounds(clips, index) {
  const list = Array.isArray(clips) ? clips : [];
  if (index <= 0 || index >= list.length - 1) return { minimum: 0, maximum: 0 };
  return filmBoundaryBounds([list[index - 1], list[index + 1]], 1);
}

export function slideClip(clips, index, requestedDelta) {
  const list = Array.isArray(clips) ? clips : [];
  if (index <= 0 || index >= list.length - 1) return { clips: list, delta: 0, bounds: { minimum: 0, maximum: 0 } };
  const bounds = filmSlideBounds(list, index);
  const delta = Math.max(bounds.minimum, Math.min(bounds.maximum, num(requestedDelta)));
  if (Math.abs(delta) < EPS) return { clips: list, delta: 0, bounds };
  const out = list.map((clip, i) => {
    if (i === index - 1) {
      const rate = rateOf(clip);
      return {
        ...clip,
        duration: round2(pos(clip.duration) + delta),
        ...(clip.kind === 'image' ? {} : { sourceDuration: round2(srcUsedOf(clip) + delta * rate) }),
      };
    }
    if (i !== index + 1) return clip;
    const rate = rateOf(clip);
    return {
      ...clip,
      duration: round2(pos(clip.duration) - delta),
      ...(clip.kind === 'image' ? {} : {
        sourceStart: round2(srcHeadOf(clip) + delta * rate),
        sourceDuration: round2(srcUsedOf(clip) - delta * rate),
      }),
    };
  });
  return { clips: out, delta, bounds };
}

/* 配音块被拖动 / 裁剪之后，挂在它身上的字幕跟着走（参考 updateAudioSegment 的联动）：
   起点按 start 的位移整体平移，长度按块的**新**区间夹住（夹出一个正长度为止）。 */
export function followCaptions(captions, voiceId, oldItem, newItem) {
  if (!voiceId || !oldItem || !newItem) return Array.isArray(captions) ? captions : [];
  const dStart = num(newItem.start) - num(oldItem.start);
  if (!dStart) return captions;
  const lo = pos(newItem.start);
  const hi = lo + pos(newItem.duration);
  return (Array.isArray(captions) ? captions : []).map(c => {
    if (!c || c.voiceId !== voiceId) return c;
    let start = Math.max(lo, pos(c.start) + dStart);
    let end = Math.min(hi, pos(c.end) + dStart);
    if (end - start < MIN_CAPTION_SECONDS) {
      start = Math.min(start, Math.max(lo, hi - MIN_CAPTION_SECONDS));
      end = Math.min(hi, start + MIN_CAPTION_SECONDS);
    }
    return { ...c, start: round2(start), end: round2(end) };
  });
}
