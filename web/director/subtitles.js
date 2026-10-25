/* 字幕：台词/配音派生的可编辑轨。
   数据层一律是**候选源秒**（AGENTS §9.2）：entries 的 startMs/endMs 落在当前选用候选的源时间轴上，
   显示、SRT、烧录、FCPXML 只使用 mapToFilm 折成成片秒；SRT 导入用 mapFromFilm 折回源秒。
   本模块是纯函数，不碰 DOM、不问当前镜头；currentOf 是唯一出口（预览/SRT/烧录/FCPXML 都问它）。 */
import { round1, escHTML } from './util.js';
import { segsOf } from './segments.js';
import { voiceFrameOf, lineEstSec } from './voice-layout.js';

/* 内置标题效果：FCP 的 Basic Title。UID 只在这里出现一次，模板与导出器都读它。 */
export const BASIC_TITLE_UID = '.../Titles.localized/Basic Title.localized/Basic Title.moti';
export const SUB_POSITION_KEY = '9999/999166631/999166633/1/100/101';
export const SUB_FR = 30;

const STYLE_DEF = {
  fontFamily: 'PingFang SC',
  fontSize: 54,
  color: '#FFFFFF',
  position: 'bottom',
  maxCharsPerEntry: 24,
  highlight: false,
};
const POSITIONS = ['bottom', 'middle', 'top'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const txt = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const ms = sec => Math.round((Number(sec) || 0) * 1000);

/* 候选时长与引擎同一口径（`candDur`）：候选自己声明的优先，其次镜头，最后 5 秒。 */
const durOf = (c, sh) => Math.max(0.1, Number(c && c.duration) || Number(sh && sh.duration) || 5);
export const chosenCandOf = sh => ((sh && sh.candidates) || []).find(c => c && c.vid === sh.selId) || null;
const segsOfShot = (sh, cand) => {
  const c = cand || chosenCandOf(sh);
  return c ? segsOf(c, durOf(c, sh)) : [];
};

const hex6 = v => {
  const s = String(v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map(x => x + x).join('')).toUpperCase();
  return STYLE_DEF.color;
};
const rgbOf = color => {
  const s = hex6(color).slice(1);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};

export function styleOf(sh) {
  const raw = (sh && sh.subtitle && sh.subtitle.style) || {};
  const st = Object.assign({}, STYLE_DEF, raw);
  st.fontSize = clamp(Math.round(Number(st.fontSize) || STYLE_DEF.fontSize), 12, 300);
  st.color = hex6(st.color);
  st.position = POSITIONS.includes(st.position) ? st.position : STYLE_DEF.position;
  st.maxCharsPerEntry = clamp(Math.round(Number(st.maxCharsPerEntry) || STYLE_DEF.maxCharsPerEntry), 8, 120);
  st.highlight = !!st.highlight;
  st.fontFamily = String(st.fontFamily || STYLE_DEF.fontFamily).slice(0, 60);
  return st;
}

/* 只改样式，不碰 entries / candId / source；sh.subtitle 不存在时建一个空壳（样式本身是用户编辑）。 */
export function setStyle(sh, patch) {
  if (!sh) return STYLE_DEF;
  if (!sh.subtitle || typeof sh.subtitle !== 'object') sh.subtitle = {};
  const next = Object.assign({}, sh.subtitle.style || {}, patch || {});
  if (next.color != null) next.color = hex6(next.color);
  sh.subtitle.style = next;
  return styleOf(sh);
}

function normalizeEntries(list, opts) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(e => {
    if (!e || typeof e !== 'object') return;
    const text = String(e.text == null ? '' : e.text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return;
    let a = Math.max(0, Number(e.startMs) || 0);
    let b = Math.max(0, Number(e.endMs) || 0);
    if (b <= a) b = a + (Number(opts && opts.minMs) || 1);
    out.push(Object.assign({}, e, {
      startMs: Math.round(a), endMs: Math.round(b), text,
      src: e.src === 'voice' ? 'voice' : e.src === 'line' ? 'line' : (e.src || 'manual'),
    }));
  });
  out.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  out.forEach((e, i) => { e.index = i + 1; });
  return out;
}

/* 台词 + 已选用候选上的配音 → 源秒 entries。
   有配音：每句一条，文本取配音自己的 text；起点 = 段选区起点 + v.at，
   终点 = 段选区起点 + voiceFrameOf(v).fb（fb 已按句速折算回源秒）。
   没有配音：sh.line 一条，挂第一段，时长按 lineEstSec 估（与待生成占位符同一把尺子）。 */
export function entriesFromShot(sh, voices, cand) {
  const c = cand || chosenCandOf(sh);
  if (!c) return [];
  const segs = segsOf(c, durOf(c, sh));
  if (!segs.length) return [];
  const list = [];
  const own = (Array.isArray(voices) ? voices : []).filter(v => v && v.shotId === sh.id && v.candId === c.vid
    && String(v.text == null ? '' : v.text).trim());
  own.forEach(v => {
    const si = Math.max(0, Math.min(segs.length - 1, Number(v.seg) || 0));
    const s = segs[si];
    if (!s) return;
    const at = Math.max(0, Number(v.at) || 0);
    const start = s.in + at;
    const end = Math.max(start + 0.05, s.in + voiceFrameOf(v).fb);
    list.push({
      startMs: ms(start), endMs: ms(Math.min(durOf(c, sh), end)),
      text: String(v.text).trim(), src: 'voice', seg: si,
      voiceKey: v.id || v.key || ('v' + si + ':' + round1(at)),
    });
  });
  if (list.length) return normalizeEntries(list);
  const line = txt(sh.line);
  if (!line) return [];
  const s = segs[0];
  const start = s.in;
  const end = Math.max(start + 0.05, Math.min(s.out, start + lineEstSec(line)));
  return normalizeEntries([{ startMs: ms(start), endMs: ms(end), text: line, src: 'line', seg: 0 }]);
}

/* 源数据指纹：candId + 台词/说话人 + 选中候选上每句配音的文本与时间。
   只要这四类有一个变了，旧字幕就可能对不上（导出前重算一次）。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}
export function sourceHashOf(sh, voices) {
  const c = chosenCandOf(sh);
  const rows = (Array.isArray(voices) ? voices : [])
    .filter(v => v && v.shotId === sh.id && (!c || v.candId === c.vid))
    .map(v => [Number(v.seg) || 0, Number(v.at) || 0, Number(v.dur) || 0,
      Number(v.off) || 0, Number(v.spd) || 1, String(v.text == null ? '' : v.text)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || String(a[5]).localeCompare(String(b[5])));
  return fnv1a(JSON.stringify([c ? c.vid : '', txt(sh.line), txt(sh.lineWho), rows]));
}

/* 字幕的**唯一出口**。老工程没有 sh.subtitle 时现派生、绝不写盘；
   只有用户编辑/导入/生成字幕时才落 sh.subtitle。
   `line+voice` 在台词/配音/候选变化后按新数据重派生；`manual`/`asr` 只标 stale，不覆盖、不硬套新候选。 */
export function currentOf(sh, voices) {
  const c = chosenCandOf(sh);
  const candId = c ? c.vid : '';
  const hash = sourceHashOf(sh, voices);
  const style = styleOf(sh);
  const stored = sh && sh.subtitle && typeof sh.subtitle === 'object' ? sh.subtitle : null;
  if (!stored) {
    const entries = entriesFromShot(sh, voices, c);
    return { entries, candId, style, source: 'line+voice', sourceHash: hash, stale: false,
      staleWhy: '', derived: true, lineMismatch: lineMismatchOf(sh, entries) };
  }
  const source = stored.source === 'manual' || stored.source === 'asr' ? stored.source : 'line+voice';
  const entries0 = normalizeEntries(stored.entries);
  const storedCand = stored.candId ? String(stored.candId) : '';
  const candMismatch = !!candId && storedCand !== candId;
  const hashMismatch = !!stored.sourceHash && stored.sourceHash !== hash;
  const noCand = !candId;
  if (source === 'line+voice' && (candMismatch || hashMismatch || !entries0.length)) {
    const entries = entriesFromShot(sh, voices, c);
    return { entries, candId, style, source, sourceHash: hash, stale: false, staleWhy: '',
      derived: true, lineMismatch: lineMismatchOf(sh, entries) };
  }
  const stale = candMismatch || hashMismatch || noCand;
  return {
    entries: entries0, candId, style, source, sourceHash: hash, stale,
    staleWhy: noCand ? 'nocand' : candMismatch ? 'cand' : hashMismatch ? 'hash' : '',
    derived: false, storedHash: stored.sourceHash || '', storedCand,
    lineMismatch: lineMismatchOf(sh, entries0),
  };
}

function lineMismatchOf(sh, entries) {
  const line = txt(sh && sh.line);
  if (!line || !entries.length) return false;
  if (!entries.some(e => e.src === 'voice')) return false;
  return entries.map(e => txt(e.text)).join('') !== line.replace(/\s+/g, '');
}

/* ---------- SRT（文件里的时间是**成片秒**） ---------- */
export function srtParse(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = [];
  let skipped = 0;
  src.split(/\n{2,}/).forEach(block => {
    const lines = block.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return;
    let ti = -1;
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (/-->/.test(lines[i])) { ti = i; break; }
    }
    if (ti < 0) { skipped++; return; }
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(lines[ti]);
    if (!m) { skipped++; return; }
    const toMs = (h, mi, s, frac) => ((+h) * 3600 + (+mi) * 60 + (+s)) * 1000 + Number((frac + '000').slice(0, 3));
    const a = toMs(m[1], m[2], m[3], m[4]);
    let b = toMs(m[5], m[6], m[7], m[8]);
    const body = lines.slice(ti + 1).join('\n').replace(/^\s+|\s+$/g, '');
    if (!body) { skipped++; return; }
    if (b <= a) b = a + 1;
    out.push({ index: out.length + 1, startMs: a, endMs: b, text: body });
  });
  out.sort((x, y) => x.startMs - y.startMs);
  out.forEach((e, i) => { e.index = i + 1; });
  Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false });
  return out;
}

export function srtSerialize(entries, opts) {
  const o = opts || {};
  const bom = o.bom !== false;
  const crlf = o.crlf !== false;
  const nl = crlf ? '\r\n' : '\n';
  const stamp = v => {
    /* 先取整再分解：分开「对毫秒 Math.round」的话 0.9995 秒会被进位成 ,1000 ——
       SRT 的时间行必须是 0–999 的毫秒。 */
    const t = Math.max(0, Math.round(Number(v) || 0));
    const h = Math.floor(t / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const mm = t % 1000;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':'
      + String(s).padStart(2, '0') + ',' + String(mm).padStart(3, '0');
  };
  const list = (Array.isArray(entries) ? entries : [])
    .filter(e => e && String(e.text == null ? '' : e.text).trim())
    .map(e => ({
      /* 同一条 entry 上可能同时带着源毫秒（startMs）与成片毫秒（filmStartMs，filmOf 的产物）：
         SRT 文件里的时间是**成片秒**（见本段头注），有成片毫秒必须用它 ——
         以前 startMs 先判，全片导出的时间轴整体错位回源秒。 */
      a: Math.max(0, Number(e.filmStartMs != null ? e.filmStartMs
        : e.startMs != null ? e.startMs : (Number(e.filmStart) || 0) * 1000) || 0),
      b: Math.max(0, Number(e.filmEndMs != null ? e.filmEndMs
        : e.endMs != null ? e.endMs : (Number(e.filmEnd) || 0) * 1000) || 0),
      text: String(e.text).replace(/\r\n?/g, '\n').trim(),
    }))
    .sort((x, y) => x.a - y.a || x.b - y.b);
  const parts = list.map((e, i) => {
    const b = e.b > e.a ? e.b : e.a + 1;
    return (i + 1) + nl + stamp(e.a) + ' --> ' + stamp(b) + nl + e.text.replace(/\n/g, nl);
  });
  return (bom ? '\uFEFF' : '') + parts.join(nl + nl) + (parts.length ? nl : '');
}

/* 按每行字数切分；时间按字符数比例分给各片。只重排已有字幕，不改变内容与总区间。 */
export function resegment(entries, maxChars) {
  const lim = Math.max(1, Math.round(Number(maxChars) || 24));
  const list = normalizeEntries(entries);
  const out = [];
  list.forEach(e => {
    const chars = Array.from(e.text);
    if (chars.length <= lim) { out.push(e); return; }
    const pieces = [];
    let i = 0;
    while (i < chars.length) {
      let n = Math.min(lim, chars.length - i);
      let cut = n;
      if (i + n < chars.length) {
        for (let k = n; k >= Math.max(4, Math.floor(n * 0.45)); k--) {
          if (/[，。！？；：、,.!?;:）)\]】”’\s]/.test(chars[i + k - 1])) { cut = k; break; }
        }
      }
      const piece = chars.slice(i, i + cut).join('').trim();
      if (piece) pieces.push(piece);
      i += cut;
    }
    if (pieces.length <= 1) { out.push(e); return; }
    const total = pieces.reduce((a, p) => a + Array.from(p).length, 0) || 1;
    let at = e.startMs;
    const span = Math.max(pieces.length, e.endMs - e.startMs);
    pieces.forEach((p, k) => {
      const len = Array.from(p).length;
      const end = k === pieces.length - 1 ? e.endMs : Math.round(at + span * len / total);
      out.push(Object.assign({}, e, { startMs: Math.round(at), endMs: Math.max(Math.round(at) + 1, end), text: p }));
      at = end;
    });
  });
  return normalizeEntries(out);
}

/* ---------- 源秒 ↔ 成片秒 ---------- */
/* 一段在成片里占几秒：与 `tlClipDur` / `filmFrames` 同一算式（不取整）。 */
const segFilm = s => Math.max(0.1, ((Number(s.out) || 0) - (Number(s.in) || 0))
  / Math.max(0.25, Math.min(4, Number(s.spd) || 1)));
/* 本镜甲板那一把尺子（`plan.js` 的本镜分支）：段只按选区源长累加，倍速不缩。 */
const segShot = s => Math.max(0.1, round1((Number(s.out) || 0) - (Number(s.in) || 0)));

function srcToFilm(sh, shotAt, sec, cand, ownShotAxis) {
  const segs = segsOfShot(sh, cand);
  if (!segs.length) return null;
  const src = Math.max(0, Number(sec) || 0);
  let acc = 0, hit = null, clamped = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const len = ownShotAxis ? segShot(s) : segFilm(s);
    const lo = Number(s.in) || 0, hi = Number(s.out) || 0;
    if (src >= lo && (src < hi || (i === segs.length - 1 && src <= hi))) {
      hit = { s, i, off: src - lo }; break;
    }
    if (src < lo) { hit = { s, i, off: 0 }; clamped = true; break; }
    acc += len;
  }
  if (!hit) {
    const i = segs.length - 1, s = segs[i];
    acc = segs.slice(0, i).reduce((a, x) => a + (ownShotAxis ? segShot(x) : segFilm(x)), 0);
    hit = { s, i, off: Math.max(0, (Number(s.out) || 0) - (Number(s.in) || 0)) };
    clamped = true;
  }
  const off = ownShotAxis ? hit.off : hit.off / Math.max(0.25, Math.min(4, Number(hit.s.spd) || 1));
  return { at: (ownShotAxis ? 0 : (Number(shotAt) || 0)) + acc + off, segIndex: hit.i, clamped };
}

/* 单条字幕 → 成片秒。返回的 `filmStart/filmEnd` 是绝对成片秒；`ok=false` 表示有端点被夹过。 */
export function filmOf(sh, shotAt, entry, opts) {
  if (!entry) return null;
  const a = srcToFilm(sh, shotAt, (Number(entry.startMs) || 0) / 1000, opts && opts.cand, false);
  const b = srcToFilm(sh, shotAt, (Number(entry.endMs) || 0) / 1000, opts && opts.cand, false);
  if (!a || !b) return null;
  const start = Math.max(0, a.at);
  const end = Math.max(start + 1 / SUB_FR, b.at);
  return Object.assign({}, entry, {
    filmStart: start, filmEnd: end,
    filmStartMs: ms(start), filmEndMs: ms(end),
    segIndex: a.segIndex, clampedStart: a.clamped, clampedEnd: b.clamped,
    ok: !a.clamped && !b.clamped,
  });
}

export function mapToFilm(sh, shotAt, entries, opts) {
  return normalizeEntries(entries, { minMs: 1 })
    .map(e => filmOf(sh, shotAt, e, opts))
    .filter(Boolean)
    .sort((x, y) => x.filmStart - y.filmStart || x.filmEnd - y.filmEnd)
    .map((e, i) => Object.assign(e, { index: i + 1 }));
}

/* 本镜预览那一把尺子（倍速不缩、只累计选区源长），与 `plan.js` 本镜分支、`TlPlay.t` 完全一致。 */
export function mapToShot(sh, entries, opts) {
  return normalizeEntries(entries, { minMs: 1 }).map(e => {
    const a = srcToFilm(sh, 0, (Number(e.startMs) || 0) / 1000, opts && opts.cand, true);
    const b = srcToFilm(sh, 0, (Number(e.endMs) || 0) / 1000, opts && opts.cand, true);
    if (!a || !b) return null;
    const start = Math.max(0, a.at), end = Math.max(start + 0.033, b.at);
    return Object.assign({}, e, { shotStart: start, shotEnd: end, segIndex: a.segIndex });
  }).filter(Boolean).sort((x, y) => x.shotStart - y.shotStart);
}

/* 本镜在成片里占几秒（Σ 每段选区 ÷ 倍速，**不取整**）。
   SRT 导入的「本镜范围」过滤必须用它 —— 折回（mapFromFilm）用的就是这一把不取整的尺，
   过滤那一边用取整口径的话，恰好落在边界 0.1 秒里的那条会被判成本镜之外而丢掉。 */
export function filmSpanOf(sh, shotAt, cand) {
  return segsOfShot(sh, cand).reduce((a, s) => a + segFilm(s), 0);
}

/* 成片秒 → 源秒（SRT 导入）。与 mapToFilm 同一套段映射，只是方向反过来。 */
export function mapFromFilm(sh, shotAt, entries, opts) {
  const cand = opts && opts.cand;
  const segs = segsOfShot(sh, cand);
  if (!segs.length) return [];
  const base = Number(shotAt) || 0;
  const lens = segs.map(segFilm);
  const total = lens.reduce((a, b) => a + b, 0);
  const fromFilm = sec => {
    const rel = Math.max(0, Math.min(total, (Number(sec) || 0) - base));
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      if (rel < acc + lens[i] || i === segs.length - 1) {
        const s = segs[i];
        const off = Math.min(lens[i], Math.max(0, rel - acc));
        return { src: (Number(s.in) || 0) + off * Math.max(0.25, Math.min(4, Number(s.spd) || 1)), seg: i, clamped: rel <= 0 || rel >= total };
      }
      acc += lens[i];
    }
    return { src: Number(segs[segs.length - 1].out) || 0, seg: segs.length - 1, clamped: true };
  };
  return normalizeEntries(entries).map(e => {
    const a = fromFilm((Number(e.startMs) || 0) / 1000);
    const b = fromFilm((Number(e.endMs) || 0) / 1000);
    return Object.assign({}, e, {
      startMs: ms(a.src), endMs: ms(Math.max(a.src + 0.001, b.src)), seg: a.seg,
    });
  }).filter(e => e.endMs > e.startMs);
}

/* 换「选用候选」时把**手改 / 识别**那份字幕搬到新候选的源时间轴上：
   旧源秒 →（旧候选的段几何）成片秒 →（新候选的段几何）新源秒。
   派生那一份（line+voice）不用搬 —— 换完自动按新候选重派生。
   纯函数：返回新的 subtitle 对象（不修改 sh），搬不了（旧候选已删 / 全被夹掉）返回 null，
   由调用方决定要不要在回执里说一句。 */
export function remapSubtitles(sh, voices, toVid) {
  const stored = sh && sh.subtitle;
  if (!stored || typeof stored !== 'object') return null;
  const source = stored.source === 'manual' || stored.source === 'asr' ? stored.source : '';
  if (!source || !Array.isArray(stored.entries) || !stored.entries.length) return null;
  const cands = sh.candidates || [];
  const from = cands.find(c => c && c.vid === stored.candId) || null;
  const to = cands.find(c => c && c.vid === toVid) || null;
  if (!from || !to || from === to) return null;
  const film = mapToFilm(sh, 0, stored.entries, { cand: from });
  if (!film.length) return null;
  const asFilmMs = film.map(e => ({ text: e.text, startMs: e.filmStartMs, endMs: e.filmEndMs }));
  const back = mapFromFilm(sh, 0, asFilmMs, { cand: to });
  if (!back.length) return null;
  return Object.assign({}, stored, { entries: back, candId: toVid, sourceHash: sourceHashOf(sh, voices) });
}

/* 播放头（成片秒或本镜甲板秒）落在哪一条字幕。默认 film 轴；本镜预览传 axis:'shot'。 */
export function entryAt(sh, sec, opts) {
  const o = opts || {};
  const cur = currentOf(sh, o.voices);
  if (!cur.entries.length) return null;
  const list = o.axis === 'shot' ? mapToShot(sh, cur.entries, o) : mapToFilm(sh, o.shotAt || 0, cur.entries, o);
  const t = Math.max(0, Number(sec) || 0) * 1000;
  let hit = null;
  list.forEach(e => {
    const a = o.axis === 'shot' ? e.shotStart * 1000 : e.filmStartMs;
    const b = o.axis === 'shot' ? e.shotEnd * 1000 : e.filmEndMs;
    if (t >= a - 1 && t < b - 1) hit = Object.assign({}, e, { atStart: a / 1000, atEnd: b / 1000, axis: o.axis || 'film' });
  });
  return hit;
}

/* 预览叠层：与烧录用同一份样式（字号按 1080p 设计，预览用容器高度折算）。 */
export function overlayHTML(entry, style) {
  if (!entry || !String(entry.text == null ? '' : entry.text).trim()) return '';
  const st = styleOf({ subtitle: { style: style } });
  const body = escHTML(String(entry.text).replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
  return '<div class="sub-ov sub-ov-' + st.position + (st.highlight ? ' hl' : '') + '"'
    + ' style="color:' + st.color + ';font-family:' + escHTML(st.fontFamily) + ',sans-serif;'
    + 'font-size:' + st.fontSize + 'px;font-size:calc(' + st.fontSize + ' / 1080 * 100cqh)">'
    + body + '</div>';
}

/* 全片字幕（按 rows 的镜头顺序，只取每镜第一格作为 shotAt）：
   SRT 导出、烧录、助手查询都读这一份；不另建副本。 */
export function filmEntriesOf(rows, shots, voices) {
  const byId = new Map((Array.isArray(shots) ? shots : []).map(sh => [sh.id, sh]));
  const seen = new Set();
  const out = [], missing = [];
  let dropped = 0;
  (Array.isArray(rows) ? rows : []).forEach((row, idx) => {
    const c = row && row.c;
    if (!c || c.kind !== 'shot' || seen.has(c.shotId)) return;
    seen.add(c.shotId);
    const sh = byId.get(c.shotId);
    if (!sh) return;
    const cur = currentOf(sh, voices);
    if (!cur.entries.length) return;
    cur.entries.forEach(e => {
      const m = filmOf(sh, row.at, e);
      if (!m) return;
      /* 整条落在被剪掉的区间里：映射后只剩 filmOf 兜的那 1/30 秒一闪，
         肉眼等于没有 —— 收下来只会导出一条废条目。照实计数（dropped），不静默。 */
      if (m.filmEnd - m.filmStart < 0.1) { dropped++; return; }
      out.push(Object.assign(m, { shotId: sh.id, holderIndex: idx, source: cur.source, stale: cur.stale, staleWhy: cur.staleWhy }));
    });
  });
  (Array.isArray(shots) ? shots : []).forEach(sh => {
    if (seen.has(sh.id)) return;
    const cur = currentOf(sh, voices);
    if (cur.entries.length) missing.push({ shot: sh, count: cur.entries.length, why: chosenCandOf(sh) ? 'notinfilm' : 'nocand' });
  });
  out.sort((a, b) => a.filmStart - b.filmStart || a.filmEnd - b.filmEnd);
  return { entries: out, missing, dropped };
}

/* FCPXML `<title>`：每镜的字幕挂到它起点所在的那一格（黑场也挂），lane 从正 1 起算。
   `rows` 是 fcpxml.js 现有的 [{ c, at, dur }]；`shots` 是工程镜头；`filmOf` 缺省用本模块的实现。
   返回的 `srt` 与 XML 同一份 mapToFilm 结果，媒体包原样写 `subtitles.srt`。 */
export function fcpxmlTitles({ rows, shots, styleOf: styleFn, size, t, xe, filmOf: mapFn, voices }) {
  const byRow = new Map();
  const warnings = [];
  const counts = { entries: 0, titles: 0, skipped: 0, clamped: 0, overflow: 0, layers: 0,
    withSubtitles: 0, staleShots: 0, staleEntries: 0, missingShots: 0 };
  const byId = new Map((Array.isArray(shots) ? shots : []).map(sh => [sh.id, sh]));
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { byRow, srt: '', counts, warnings };
  const rowTotal = Math.max(0, ...list.map((r, i) => (Number(r.at) || 0) + (Number(r.dur) || 0)));
  const firstRow = new Map();
  list.forEach((r, i) => {
    const c = r && r.c;
    if (!c || c.kind !== 'shot' || firstRow.has(c.shotId)) return;
    firstRow.set(c.shotId, { row: r, idx: i });
  });
  const holderOf = start => {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (start >= (Number(r.at) || 0) - 1e-6 && start < (Number(r.at) || 0) + (Number(r.dur) || 0) - 1e-6) return { row: r, idx: i };
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if ((Number(list[i].at) || 0) <= start) return { row: list[i], idx: i };
    }
    return { row: list[0], idx: 0 };
  };
  const titles = [];
  let seq = 0;
  firstRow.forEach(({ row, idx }, shotId) => {
    const sh = byId.get(shotId);
    if (!sh) return;
    const cur = currentOf(sh, voices);
    if (!cur.entries.length) return;
    const st = (styleFn ? styleFn(sh) : styleOf(sh));
    if (cur.stale) { counts.staleShots++; counts.staleEntries += cur.entries.length; }
    if (!chosenCandOf(sh)) {
      counts.missingShots++;
      warnings.push('「' + (sh.name || shotId) + '」有 ' + cur.entries.length + ' 条字幕，但这一镜没有选用候选，字幕未导出');
      return;
    }
    counts.entries += cur.entries.length;
    if (st.highlight) warnings.push('高亮背景只在预览与烧录里生效，FCPXML 标题不写这个样式（SRT 仍保留全文）');
    if (st.fontFamily && st.fontFamily !== 'PingFang SC') warnings.push('字体「' + st.fontFamily + '」在 FCP 里可能被替换（回执与预览仍按这个字体）');
    cur.entries.forEach(e => {
      const mapped = (mapFn ? mapFn(sh, row.at, e) : filmOf(sh, row.at, e));
      if (!mapped || !isFinite(Number(mapped.filmStart)) || !isFinite(Number(mapped.filmEnd))) {
        counts.skipped++;
        warnings.push('字幕「' + txt(e.text).slice(0, 24) + '」无法映射到成片时间，已跳过');
        return;
      }
      let start = Math.max(0, Number(mapped.filmStart));
      let end = Math.max(start, Number(mapped.filmEnd));
      if (mapped.clampedStart || mapped.clampedEnd) counts.clamped++;
      if (rowTotal <= 0) { counts.skipped++; return; }
      if (start >= rowTotal - 1 / SUB_FR) {
        start = Math.max(0, rowTotal - 1 / SUB_FR);
        end = Math.max(start + 1 / SUB_FR, Math.min(rowTotal, end));
        counts.clamped++;
      }
      end = Math.min(end, rowTotal);
      if (end <= start) end = Math.min(rowTotal, start + 1 / SUB_FR);
      if (end <= start) { counts.skipped++; return; }
      const holder = holderOf(start);
      titles.push({ start, end, text: String(e.text), style: st, holder, shot: sh, entry: e, order: seq++ });
    });
  });
  titles.sort((a, b) => a.start - b.start || a.order - b.order);
  const laneEnds = new Array(9).fill(-Infinity);
  titles.forEach((x, n) => {
    const sF = Math.max(0, Math.round(x.start * SUB_FR));
    const eF = Math.max(sF + 1, Math.round(x.end * SUB_FR));
    let lane = 0;
    for (let l = 1; l <= 8; l++) if (laneEnds[l] <= sF) { lane = l; break; }
    if (!lane) { lane = 8; counts.overflow++; }
    laneEnds[lane] = Math.max(laneEnds[lane], eF);
    counts.layers = Math.max(counts.layers, lane);
    const st = x.style;
    const fs = clamp(Math.round(st.fontSize * (Number(size && size.h) || 1080) / 1080), 12, 300);
    const [r, g, b] = rgbOf(st.color);
    const fc = [r / 255, g / 255, b / 255, 1].map(v => v.toFixed(4)).join(' ');
    const py = st.position === 'top' ? 420 : st.position === 'middle' ? 0 : -420;
    const yy = Math.round(py * (Number(size && size.h) || 1080) / 1080);
    const name = '字幕 ' + (n + 1);
    const dur = Math.max(1 / SUB_FR, x.end - x.start);
    const holderAt = Number(x.holder.row.at) || 0;
    const xml = [
      '              <title ref="r_title" lane="' + lane + '" name="' + xe(name)
        + '" offset="' + t(Math.max(0, x.start - holderAt)) + '" duration="' + t(dur) + '">',
      '                <param name="Position" key="' + SUB_POSITION_KEY + '" value="0 ' + yy + '"/>',
      '                <text><text-style ref="ts' + (n + 1) + '">' + xe(x.text) + '</text-style></text>',
      '                <text-style-def id="ts' + (n + 1) + '">',
      '                  <text-style font="' + xe(st.fontFamily || 'PingFang SC') + '" fontSize="' + fs
        + '" fontColor="' + fc + '" alignment="center"/>',
      '                </text-style-def>',
      '              </title>',
    ].join('\n');
    const arr = byRow.get(x.holder.idx) || [];
    arr.push(xml);
    byRow.set(x.holder.idx, arr);
    x.filmStart = x.start;
    x.filmEnd = x.end;
  });
  const srt = srtSerialize(titles.map(x => ({
    startMs: ms(x.start), endMs: ms(x.end), text: x.text,
  })), { bom: true, crlf: true });
  counts.titles = titles.length;
  counts.withSubtitles = new Set(titles.map(x => x.shot.id)).size;
  if (counts.clamped) warnings.push('有 ' + counts.clamped + ' 条字幕被夹到候选/成片边界');
  if (counts.overflow) warnings.push('有 ' + counts.overflow + ' 条字幕超过 8 层，导入后可能叠在一起（一条都没有丢）');
  if (counts.staleShots) warnings.push('有 ' + counts.staleShots + ' 个镜头的字幕按上一版生成（台词/配音或候选已变），共 ' + counts.staleEntries + ' 条可能对不上');
  if (counts.missingShots) warnings.push('有 ' + counts.missingShots + ' 个有字幕的镜头没有选用候选，字幕未导出');
  return { byRow, srt, counts, warnings };
}
