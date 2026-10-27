/* SRT 文件的进与出 + 按每行字数重切。
   只做这一件事：新模型里字幕本身就存**成片秒**（`film.captions` 的 start / end），
   而 SRT 文件里的时间按惯例也是成片时间 —— 两边同一把尺子，所以这一族**没有任何秒制折算**。
   （旧那套「候选源秒 ↔ 本镜轴秒 ↔ 成片秒」的换算层随数据模型一起删了。）
   纯函数：不碰 DOM、不写工程数据；落盘由调用方（engine 的字幕那一族）做。 */
import { round2, num } from './util.js';
import { MIN_CAPTION_SECONDS } from './film.js';

/* 一行最多几个字（重切的缺省档）：调用方给数字就用调用方的，没给就用这一档。 */
export const RESEGMENT_DEFAULT_CHARS = 24;
/* 文件头的 BOM：Windows 记事本与不少字幕工具按本地编码猜，没有它中文全乱。
   写成码点而不是裸字符 —— 源码里不许出现不可见控制字符（AGENTS §14.1）。 */
const BOM = String.fromCharCode(0xFEFF);

const secOf = ms => Math.max(0, Number(ms) || 0) / 1000;

/* SRT 文本 → `[{ start, end, text }]`（成片秒）。
   一个块解析不出来（没有时间行 / 没有正文）就计数并跳过：`list.skipped` 挂在数组上（不可枚举，
   不进 JSON），回执要能说出「有 N 块格式不对没读进来」，不静默吞。 */
export function srtParse(text) {
  const raw = String(text == null ? '' : text);
  const src = (raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
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
    const b = toMs(m[5], m[6], m[7], m[8]);
    const body = lines.slice(ti + 1).join('\n').trim();
    if (!body) { skipped++; return; }
    out.push({ start: secOf(a), end: secOf(Math.max(a + 1, b)), text: body });
  });
  out.sort((x, y) => x.start - y.start || x.end - y.end);
  Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false });
  return out;
}

/* 字幕条目（成片秒）→ SRT 文本。没字的与零长的不写（写出去也是一条废块）。
   时间行先按毫秒取整再分解：分开「对秒 round、再拆毫秒」的话 0.9995 秒会被进位成 `,1000` ——
   SRT 的毫秒位必须是 0–999。 */
export function srtSerialize(list, opts) {
  const o = opts || {};
  const nl = o.crlf === false ? '\n' : '\r\n';
  const stamp = sec => {
    const t = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const h = Math.floor(t / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':'
      + String(s).padStart(2, '0') + ',' + String(t % 1000).padStart(3, '0');
  };
  const rows = (Array.isArray(list) ? list : [])
    .map(c => ({ a: num(c && c.start), b: num(c && c.end), text: String((c && c.text) == null ? '' : c.text).replace(/\r\n?/g, '\n').trim() }))
    .filter(x => x.text && x.b > x.a)
    .sort((x, y) => x.a - y.a || x.b - y.b);
  const parts = rows.map((x, i) => (i + 1) + nl + stamp(x.a) + ' --> ' + stamp(x.b) + nl + x.text.replace(/\n/g, nl));
  return (o.bom === false ? '' : BOM) + parts.join(nl + nl) + (parts.length ? nl : '');
}

/* 一条里塞了太多字 → 按每行上限切开，时间按字数比例分给各片。
   只在**这一条自己**的区间里分：别的字幕一概不动（总区间守恒）。
   切点优先落在标点之后（往回找，最少回退到四成处）—— 硬切断句读比错一拍节拍还难受。
   返回新的字幕数组：切片沿用原来那条的 `position` / `style` / `voiceId`，
   第一片保住原 id（撤销与「字幕跟着配音走」都按 id 认人），多出来的片交给 `createCaption` 编号。 */
export function resegment(captions, maxChars) {
  const lim = Math.max(1, Math.round(Number(maxChars) || RESEGMENT_DEFAULT_CHARS));
  const out = [];
  (Array.isArray(captions) ? captions : [])
    .filter(c => c && String(c.text || '').trim())
    .sort((a, b) => num(a.start) - num(b.start) || num(a.end) - num(b.end))
    .forEach(cap => {
      const start = num(cap.start);
      const end = Math.max(start + MIN_CAPTION_SECONDS, num(cap.end));
      const whole = () => out.push({ ...cap, start: round2(start), end: round2(end) });
      const chars = Array.from(String(cap.text).trim());
      if (chars.length <= lim) { whole(); return; }
      const pieces = [];
      let i = 0;
      while (i < chars.length) {
        const n = Math.min(lim, chars.length - i);
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
      if (pieces.length <= 1) { whole(); return; }
      const total = pieces.reduce((a, p) => a + Array.from(p).length, 0) || 1;
      const span = end - start;
      let at = start;
      pieces.forEach((p, k) => {
        const len = Array.from(p).length;
        const to = k === pieces.length - 1 ? end : at + span * len / total;
        const piece = {
          text: p, start: round2(at), end: round2(Math.max(at + MIN_CAPTION_SECONDS, to)),
          position: cap.position, style: cap.style, voiceId: cap.voiceId,
        };
        if (k === 0) piece.id = cap.id;
        out.push(piece);
        at = to;
      });
    });
  return out;
}
