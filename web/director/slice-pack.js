/* 切片帧的持久格式（代理 `/cache/slices` 里一条素材一条记录）。
   写与读只有这一份：两边各写一遍时，只要一端换了排布，另一端读出来的就是
   「第一帧对、后面全错位」的那种半坏数据 —— 界面看起来只是「缓存没命中、又解了一遍」，
   没有第二处能看出来。
   排布（全部大端，与 DataView 一致）：
     [8 字节 magic "SLICES02"][4 字节帧数 N][N × (8 字节时间 float64 + 4 字节长度)][N 段 JPEG 字节]
   magic 不认识（旧格式、被别的版本写过）一律当「没有缓存」：重新解码一遍是正确行为，
   猜测排布去读断掉的一份才是错的。 */
export const SLICE_PACK_MAGIC = 'SLICES02';
const MAGIC = SLICE_PACK_MAGIC;
const HEAD = 12;

export function packFrames(list) {
  const frames = (Array.isArray(list) ? list : []).filter(f => f && f.blob);
  const buf = new ArrayBuffer(MAGIC.length + 4 + frames.length * HEAD);
  const dv = new DataView(buf);
  for (let i = 0; i < MAGIC.length; i++) dv.setUint8(i, MAGIC.charCodeAt(i));
  dv.setUint32(MAGIC.length, frames.length);
  let off = MAGIC.length + 4;
  frames.forEach(f => {
    dv.setFloat64(off, Number(f.t) || 0);
    dv.setUint32(off + 8, f.blob.size || 0);
    off += HEAD;
  });
  const parts = [buf];
  frames.forEach(f => parts.push(f.blob));
  return new Blob(parts, { type: 'application/octet-stream' });
}

/* 收 Blob（浏览器里从 `Api.cacheGet` 来的）或 ArrayBuffer（判据在 Node 里直接读的）。 */
export async function unpackFrames(src) {
  if (!src) return [];
  let ab = typeof src.arrayBuffer === 'function' ? await src.arrayBuffer() : src;
  if (ArrayBuffer.isView(ab)) ab = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
  if (!ab || ab.byteLength < MAGIC.length + 4) return [];
  const dv = new DataView(ab);
  for (let i = 0; i < MAGIC.length; i++) if (dv.getUint8(i) !== MAGIC.charCodeAt(i)) return [];
  const n = dv.getUint32(MAGIC.length);
  const headEnd = MAGIC.length + 4 + n * HEAD;
  if (headEnd > ab.byteLength) return [];
  const out = [];
  let off = headEnd;
  for (let i = 0; i < n; i++) {
    const p = MAGIC.length + 4 + i * HEAD;
    const t = dv.getFloat64(p);
    const size = dv.getUint32(p + 8);
    if (off + size > ab.byteLength) return [];       // 截断的一份按「没有缓存」处理
    out.push({ t, blob: new Blob([ab.slice(off, off + size)]) });
    off += size;
  }
  return out;
}
