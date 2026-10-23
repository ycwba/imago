/* 一句台词的「落点」：落在第几段、段内哪一秒（源秒）。
   待生成占位摆在哪、插针停在哪、这一句合成后铺在哪，三处读的都是这一份 ——
   它们是同一个数，不是三本账。缺省（老工程没有这两个键）= 第一段起点，与加这个字段之前
   逐字相同；落回缺省时把键删掉，缺省值不占盘（与段上的 vol / spd / ln 同一条记账）。
   这里只决定「用第几段、传哪个秒」，落到轨道上仍走 `lineSpanAt` / `shotRowAt`，
   一把尺子都不新增。 */
import { round1 } from './util.js';
import { isImageSeg } from './image-seg.js';

/* 夹到合法区间：段号落在 [0, 段数-1]，秒数落在这一段的选区 `[in, out - 0.1]`。
   读的时候也要夹 —— 剪过一刀之后段数会变、段会变短，旧的 `lineAt` 可能落在
   已经不存在的段 / 段尾之外，不夹就会把块画到这一镜外面。
   图片段不接台词（它没有「源里的第几秒」可念）：落点跳过它们，往后找第一段视频，
   后面没有就往前找；一镜全是图片段时落回 0，不硬造一个不存在的视频秒。 */
export function linePointClamp(pt, segs) {
  const list = Array.isArray(segs) ? segs : [];
  const seg0 = Math.max(0, Math.round(Number(pt && pt.seg) || 0));
  const at0 = Math.max(0, Number(pt && pt.at) || 0);
  if (!list.length) return { seg: seg0, at: round1(at0) };
  const isVideo = i => !isImageSeg(list[i]);
  let seg = Math.min(list.length - 1, seg0);
  if (!isVideo(seg)) {
    let fwd = -1, back = -1;
    for (let i = seg; i < list.length; i++) if (isVideo(i)) { fwd = i; break; }
    for (let i = seg - 1; i >= 0; i--) if (isVideo(i)) { back = i; break; }
    if (fwd < 0 && back < 0) return { seg: 0, at: 0 };
    seg = fwd >= 0 ? fwd : back;
  }
  const s = list[seg] || {};
  const a = Math.max(0, Number(s.in) || 0);
  const b = Math.max(a, Number(s.out) || a);
  return { seg, at: round1(Math.max(a, Math.min(Math.max(a, b - 0.1), at0))) };
}

/* 读这一句的落点。没有落点（或值坏掉）时回落到第一段起点 —— 老工程的观感与从前一样。 */
export function linePointOf(sh, segs) {
  const has = !!sh && sh.lineAt != null && sh.lineAt !== '' && Number.isFinite(Number(sh.lineAt));
  return linePointClamp(has ? { seg: sh.lineSeg, at: sh.lineAt } : { seg: 0, at: 0 }, segs);
}

/* 写这一句的落点：先夹取，再与现值比。返回「真的改了没有」——
   没改就不该压撤销快照、也不该把成片标脏。 */
export function linePointSet(sh, seg, srcSec, segs) {
  if (!sh) return false;
  const list = Array.isArray(segs) ? segs : [];
  const pt = linePointClamp({ seg, at: srcSec }, list);
  const cur = linePointOf(sh, list);
  const def = list.length ? linePointClamp({ seg: 0, at: 0 }, list) : null;
  const isDef = !!def && pt.seg === def.seg && pt.at === def.at;
  if (cur.seg === pt.seg && cur.at === pt.at) {
    if (isDef && sh.lineAt != null) { delete sh.lineSeg; delete sh.lineAt; }
    return false;
  }
  if (isDef) { delete sh.lineSeg; delete sh.lineAt; return true; }
  sh.lineSeg = pt.seg;
  sh.lineAt = pt.at;
  return true;
}
