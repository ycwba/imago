/* 联动与空段的公共判据 —— 全站只有这一份。
   两件事共用一个模块是有意的：任务 A 的「配音不挂空段」与任务 C 的「变黑场时挪到下一段有画面的段」
   都要回答「哪一段算有画面」，各写一份早晚会对不齐。
   纯数据层：不碰 DOM、不问当前镜头、不写工程数据。 */

/* 这一段是不是「插进来的一段空」（不是「删掉画面」的黑场）。
   `gap` 与 `off` 一起出现：`off` 说「成片里是黑的」，`gap` 说「这段黑是插进来的空段，
   可以整段摘掉」。「删掉画面」出来的黑场只有 `off`、没有 `gap`，不许被 `close` 摘掉。 */
export const isGap = s => !!(s && s.gap);

/* 从第 from 段往右找第一段**还有画面**的段（跳过所有 `off`，含 `gap` 与「删掉画面」的黑场）；
   找不到回 -1。给「主轨段变黑场时，被勾选的东西挪到哪」用。 */
export function nextLiveSeg(segs, from) {
  const list = Array.isArray(segs) ? segs : [];
  const start = Math.max(0, Math.min(list.length - 1, Math.round(Number(from) || 0)));
  for (let i = start + 1; i < list.length; i++) if (!list[i].off) return i;
  for (let i = 0; i < start; i++) if (!list[i].off) return i;
  return -1;
}

/* 联动设置的唯一读口：`proj.lane.pic.links`，取值 'voice' / 'line' / 'pending'。
   空数组 / 缺键 / 含非法值一律回 []（不抛、不写）—— 「联动关」与「没配过」在行为上是同一件事。 */
export function linksOf(proj) {
  const raw = proj && proj.lane && proj.lane.pic && proj.lane.pic.links;
  if (!Array.isArray(raw)) return [];
  const OK = ['voice', 'line', 'pending'];
  const out = [];
  OK.forEach(k => { if (raw.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k); });
  return out;
}

/* 联动设置的唯一写口：只在非空时占键，空数组 / 全非法一律 `delete`（与 `vols`/`hides`/`locks`
   「只有非默认才占键」同一记账）。它**不是** `ROW_FLAG_COLS` 那张按行表，搬行时不跟着走。 */
export function setLinks(proj, arr) {
  if (!proj || !proj.lane || !proj.lane.pic) return;
  const clean = linksOf({ lane: { pic: { links: arr } } });
  if (clean.length) proj.lane.pic.links = clean;
  else delete proj.lane.pic.links;
}

/* 纯函数：算出「这一格上的配音 / 台词落点」该挪到哪。
   返回 `{ voices:[{v, toSeg, toAt}], line:{toSeg,toAt}|null }` —— 只算「该去哪」，
   真正的写入仍走现有的 `v.seg/v.at` 与 `linePointSet`（不许写第二套搬块机制）。
   `seg` = 从「有画面」变成 `off:1` 的那一段下标。不勾的类型不出现在返回里。 */
export function relinkTargets({ segs, voices, linePoint, links, seg }) {
  const out = { voices: [], line: null };
  const list = Array.isArray(segs) ? segs : [];
  const want = linksOf({ lane: { pic: { links } } });
  const ni = nextLiveSeg(list, seg);
  if (ni < 0) return out;                       // 后面没有画面了 → 全部留在原地
  if (want.indexOf('voice') >= 0) {
    (Array.isArray(voices) ? voices : []).forEach(v => {
      if (v && (Number(v.seg) || 0) === seg) out.voices.push({ v: v, toSeg: ni, toAt: 0 });
    });
  }
  if ((want.indexOf('line') >= 0 || want.indexOf('pending') >= 0) && linePoint != null) {
    if ((Number(linePoint.seg) || 0) === seg) out.line = { toSeg: ni, toAt: 0 };
  }
  return out;
}
