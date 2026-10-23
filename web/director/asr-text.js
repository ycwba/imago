/* 浏览器内 ASR 的纯算法面（worker 与 Node 判据共用，无任何环境依赖）：
   - wavToPcm：16k / 单声道 / 16-bit WAV → Float32Array（worker 里没有 AudioContext；裸 PCM 自己拆）
   - groupWords：词级 chunk → 字幕段（断句 / 时长 / 字数三把尺）
   - normalizeAsrWhitespace / applyChineseReplacements / isSuspiciousChineseTranscript：转写文本清理 */

export function wavToPcm(buf) {
  /* 调用面给 ArrayBuffer 或任意 typed-array 视图（Node Buffer 也是视图）：统一成一段 DataView 读。 */
  const v = buf instanceof ArrayBuffer ? new DataView(buf)
    : ArrayBuffer.isView(buf) ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    : null;
  if (!v) throw new Error('传进 worker 的不是 WAV');
  if (v.byteLength < 12 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) {
    throw new Error('传进 worker 的不是 WAV');
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(off + 8, true), channels: v.getUint16(off + 10, true), rate: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
    else if (id === 'data') { data = { off: off + 8, size }; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 里缺 fmt 或 data 块');
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) {
    throw new Error('只认 16k 单声道 16-bit PCM（收到 ' + fmt.rate + 'Hz / ' + fmt.channels + ' 声道 / ' + fmt.bits + '-bit）');
  }
  const n = Math.floor(data.size / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(data.off + i * 2, true) / 32768;
  return out;
}

/* 词间静音 > 0.6s 断开；攒满 40 字或句末标点收段；末尾残词并进上一条不丢。 */
export function groupWords(chunks) {
  const words = (chunks || []).map(c => ({
    text: String(c.text || '').trim(),
    start: c.timestamp && c.timestamp[0] != null ? Number(c.timestamp[0]) : 0,
    end: c.timestamp && c.timestamp[1] != null ? Number(c.timestamp[1]) : 0,
  })).filter(w => w.text);
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text) out.push({ start: cur.start, end: cur.end, text: cur.text.replace(/\s+/g, ' ').trim() });
    cur = null;
  };
  for (const w of words) {
    if (!cur) { cur = { start: w.start, end: w.end, text: w.text }; continue; }
    const gap = w.start - cur.end;
    const joint = cur.text + (/[A-Za-z0-9]$/.test(cur.text) && /^[A-Za-z0-9]/.test(w.text) ? ' ' : '') + w.text;
    const sentenceEnd = /[。．.！！?？;；]/.test(cur.text.slice(-1));
    if (gap > 0.6 || joint.length > 40 || sentenceEnd) {
      flush();
      cur = { start: w.start, end: w.end, text: w.text };
    } else { cur.end = w.end || cur.end; cur.text = joint; }
  }
  flush();
  return out;
}

/* 中日文字符之间的空格是 ASR 分词残留，全去。 */
export function normalizeAsrWhitespace(text) {
  return String(text || '')
    .replace(/([\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf])\s+(?=[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf])/g, '$1')
    .replace(/\r/g, '')
    .trim();
}

/* 中文转写的固定误识表：转写完按整词替换（键在前值在后）。先立机制，条目按实际误识慢慢攒。 */
export const CHINESE_ASR_CONTEXT_REPLACEMENTS = [
  /* ['误识词', '正确词'], */
];
export function applyChineseReplacements(text) {
  let t = String(text || '');
  for (const [from, to] of CHINESE_ASR_CONTEXT_REPLACEMENTS) {
    try { t = t.split(from).join(to); } catch (e) { /* 表目写坏只跳过这一条 */ }
  }
  return t;
}

/* 中文转写可疑判定：CJK 占比过低，或夹着一大段没断开的拉丁串 → 多半是误识，提示人工复核。 */
export function isSuspiciousChineseTranscript(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return false;
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  if (cjk / t.length < 0.3) return true;
  return /[A-Za-z0-9]{20,}/.test(t);
}
