/* 贴纸纯件 —— 成片级图片 overlay 的归一化 / 取活 / 画法。
   消费方三处：film.js 的 normalizeFilm（落盘清洗）、engine/timeline.js（lane 与编辑）、
   media-export.js 与 engine/play.js（同一份 drawStickers —— 预览与成片是同一副样子）。

   数据形状（项目 film.stickers[]，坐标相对画幅 0–1，时间 = 成片秒）：
     { id, name, src, x, y, w, h, t0, t1, opacity, z }
   src 只认两种「记得住的」写法：data: 与 /asset/<id>（blob: 刷新即失效、/getv 一天 403，
   与 sanitize 对场景图 sc.img 的同一道闸）。 */

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

const SRC_OK = /^(data:|\/asset\/)/;

/* 落盘清洗：坏形状整条丢（没有字节的引用只会变破图），字段逐个夹取；数量不设上限。 */
export function normalizeStickers(list) {
  const out = (Array.isArray(list) ? list : [])
    .filter(st => st && typeof st === 'object' && SRC_OK.test(String(st.src || '')))
    .map((st, i) => {
      const t0 = Math.max(0, clamp(st.t0, 0, 1e6, 0));
      const t1 = Math.max(t0 + 0.1, clamp(st.t1, 0, 1e6, t0 + 3));
      return {
        id: String(st.id || '').trim() || 'stk-' + (i + 1),
        name: String(st.name || '').slice(0, 60) || '贴纸',
        src: String(st.src || ''),
        x: clamp(st.x, -0.5, 1.5, 0.3),
        y: clamp(st.y, -0.5, 1.5, 0.3),
        w: clamp(st.w, 0.02, 1.5, 0.25),
        h: clamp(st.h, 0.02, 1.5, 0.25),
        t0, t1,
        opacity: clamp(st.opacity, 0, 1, 1),
        z: Math.round(clamp(st.z, -99, 99, 0)),
      };
    });
  out.sort((a, b) => a.z - b.z);
  return out;
}

/* 导出 / 播放前的那一道：片长收紧（贴片 / 删镜之后 t1 可能越界）。 */
export function clampSticker(st, filmDur) {
  const t0 = Math.max(0, Number(st && st.t0) || 0);
  const t1 = Math.min(filmDur > 0 ? filmDur : 1e6, Math.max(t0 + 0.1, Number(st && st.t1) || t0 + 3));
  return Object.assign({}, st, { t0, t1: Math.max(t0 + 0.1, t1) });
}

/* 播放头那一刻活着的贴纸：时间窗过滤 + 层序（z 升序，同 z 按数组序稳定）。 */
export function activeAt(stickers, t) {
  return (Array.isArray(stickers) ? stickers : [])
    .filter(st => st && t >= st.t0 - 1e-6 && t < st.t1 - 1e-6)
    .slice()
    .sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
}

/* 一份画法两处消费（预览叠层与导出烧入）：imgOf(st) 返回可画对象（img / bitmap）或 null，
   字节缓存归调用方管（导出走 loadStill 的缓存，预览直接 <img>）。 */
export function drawStickers(ctx, w, h, list, imgOf) {
  for (const st of (Array.isArray(list) ? list : [])) {
    const img = imgOf ? imgOf(st) : null;
    if (!img) continue;
    ctx.save();
    ctx.globalAlpha = clamp(st.opacity, 0, 1, 1);
    try {
      ctx.drawImage(img, Number(st.x) * w, Number(st.y) * h, Number(st.w) * w, Number(st.h) * h);
    } catch (e) { /* 单张贴纸画不动不拦整帧 */ }
    ctx.restore();
  }
}

/* media-export.js 是经典脚本（window.MediaExport），拿不到 ESM import ——
   同一份实现挂 window 一份（director 页面只要 play / timeline 模块图跑过就已在）。 */
if (typeof window !== 'undefined') {
  window.DirectorSticker = { normalizeStickers, clampSticker, activeAt, drawStickers };
}
