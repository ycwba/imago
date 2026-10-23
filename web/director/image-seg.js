/* 图片段：`c.segs` 里带 `img` 的那些（与视频段混排在同一份数组里，不新增段数组、不新增轨）。
   ----------------------------------------------------------------------------
   坐标用「虚拟源秒」：视频段落在 [0, total]，图片段一律排在 total 之后（各自一段、互不重叠）。
   为什么不照「a:0,b:dur」写：全站只有一枚插针（`proj.cutAt`）与一份 `shotRowOf` 包含判定，
   两张图都从 0 开始的话，「针在 1 秒」既属于第一张图也属于第二张图 —— 剪谁、挪谁都没有唯一答案。
   虚拟坐标让每张图各占一段没人用的秒数，下游算式（`shotFrames` / `frameToSrc` / `srcToFrame` /
   `segLen` / 成片累计）一个都不用分叉：这些函数只读 `a/b/in/out`，不关心那段秒数对应什么素材。 */
import { round1 } from './util.js';

/* 拖进轨道时的默认时长；右把手（或左把手）改的就是它。 */
export const IMAGE_SEGMENT_SECONDS = 2;
/* 中间带平铺的一格宽与上限：同一张图平铺 N 格，不取帧。 */
export const IMAGE_THUMBNAIL_TARGET_WIDTH = 84;
export const IMAGE_THUMBNAIL_MAX_COUNT = 240;
/* `img` 是字符串且非空 = 图片段。老工程没有这个字段，行为与加它之前逐字相同。 */
export const isImageSeg = s => !!(s && typeof s.img === 'string' && s.img);

/* 这一段有多长（秒）。图片段只有时长、没有入出点，所以 a/b 与 in/out 恒等。 */
export function imageDurOf(s) {
  if (!s) return IMAGE_SEGMENT_SECONDS;
  const a = Number(s.a), b = Number(s.b);
  if (isFinite(a) && isFinite(b) && b > a) return round1(b - a);
  const i = Number(s.in), o = Number(s.out);
  if (isFinite(i) && isFinite(o) && o > i) return round1(o - i);
  const d = Number(s.dur);
  return d > 0 ? round1(d) : IMAGE_SEGMENT_SECONDS;
}

/* 中间带平铺几格：按这一格的像素宽算，至少一格、最多 240 格。 */
export const imageTileCount = px =>
  Math.max(1, Math.min(IMAGE_THUMBNAIL_MAX_COUNT, Math.ceil((Number(px) || 0) / IMAGE_THUMBNAIL_TARGET_WIDTH)));

/* 图片区里的空段（`gap` + `vc`）：坐标也是虚拟的。它与图片段合起来 = 「不落在视频源秒上的段」，
   所以插针、剪刀、`segsOf` 的夹取都按同一份虚拟坐标走。 */
export const isVirtualGap = s => !!(s && s.gap && s.vc);
export const isVirtualSeg = s => isImageSeg(s) || isVirtualGap(s);

/* 虚拟段的坐标是否已经落在这条候选的源时间轴之外（存着的那一份还作不作数）。
   `total` 变大（候选换成长视频）时旧坐标会重新落回 [0,total]，那时按新的一段重新分。 */
export function virtualCoordOk(s, total) {
  if (!isVirtualSeg(s)) return false;
  const T = Math.max(0.1, Number(total) || 0);
  const a = Number(s.a), b = Number(s.b);
  return isFinite(a) && isFinite(b) && a >= T + 0.05 && b > a;
}
export const imageCoordOk = (s, total) => isImageSeg(s) && virtualCoordOk(s, total);

/* 下一段虚拟段能用的起点：排在视频段与所有已排好的虚拟段之后。
   分两遍：先认已经排好的（坐标还在视频之外），再把没排过的按数组顺序接下去 ——
   与 `segsOf` 的分配同一序；一遍过会把「还没排的一张图」算在一张已排好的图前面，
   两张图就叠在同一截虚拟秒上。 */
export function imageVirtualBase(segs, total) {
  const T = Math.max(0.1, Number(total) || 0);
  const list = Array.isArray(segs) ? segs : [];
  let v = T;
  list.forEach(s => {
    if (!s) return;
    if (isVirtualSeg(s)) {
      if (virtualCoordOk(s, T)) v = Math.max(v, Number(s.b) || 0);
      return;
    }
    const b = Number(s.b);
    if (isFinite(b)) v = Math.max(v, Math.min(T, b));
  });
  list.forEach(s => {
    if (s && isVirtualSeg(s) && !virtualCoordOk(s, T)) v = round1(v + Math.max(0.2, imageDurOf(s)));
  });
  return round1(v + 0.1);
}

/* 造一段图片：`base` 由 `imageVirtualBase` 现算（拖进轨道的落点调用方负责把它插进数组）。 */
export function makeImageSeg({ src, name, dur, base }) {
  const d = Math.max(0.2, round1(Number(dur) || IMAGE_SEGMENT_SECONDS));
  const v0 = round1(Number(base) || 0);
  const seg = { img: String(src || ''), in: v0, out: round1(v0 + d), a: v0, b: round1(v0 + d) };
  const nm = String(name || '').trim();
  if (nm) seg.imgName = nm;
  return seg;
}

/* 把一张图插进段列表的第 `index` 段之前（缺省 = 末尾）。返回新数组与新段下标；
   原数组不动 —— 调用方拿到它之后走 `beginEdit` / `segsWrite` / `filmEdited` 那一套。 */
export function placeImageSeg(segs, total, spec) {
  const list = (Array.isArray(segs) ? segs : []).map(s => Object.assign({}, s));
  const raw = spec && spec.index;
  const index = raw == null || !isFinite(Number(raw))
    ? list.length
    : Math.max(0, Math.min(list.length, Math.round(Number(raw))));
  const seg = makeImageSeg({
    src: spec && spec.src,
    name: spec && spec.name,
    dur: spec && spec.dur,
    base: imageVirtualBase(list, total),
  });
  list.splice(index, 0, seg);
  return { segs: list, index: index, seg: seg };
}

/* 图片段切开之后，右半段拿到的那一份新虚拟坐标（左半段保留原来的 a/b）。 */
export function imageTailSeg(s, at, segs, total) {
  const base = imageVirtualBase(segs, total);
  const len = Math.max(0.2, round1((Number(s.out) || 0) - (Number(at) || 0)));
  const seg = { img: String(s.img), in: base, out: round1(base + len), a: base, b: round1(base + len) };
  if (s.imgName) seg.imgName = s.imgName;
  if (s.ln) seg.ln = s.ln;
  if (s.off) seg.off = 1;
  return seg;
}

/* 图片区里的一段空（黑场）。`vc` 让它与图片段一样按虚拟坐标保存 —— 空段没有画面，
   但同样要占住成片里的那几秒，所以走的还是 `off` + `gap` 那一套。 */
export function makeGapSeg(base, dur) {
  const d = Math.max(0.2, round1(Number(dur) || 1));
  const v0 = round1(Number(base) || 0);
  return { in: v0, out: round1(v0 + d), a: v0, b: round1(v0 + d), off: 1, gap: 1, vc: 1 };
}
