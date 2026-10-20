/* 导演台纯工具：宽松 JSON 解析与秒数取整（不依赖 DOM / 工程状态）。 */

/* 宽松 JSON 解析：兼容 ```json 围栏、前后废话、单引号 */
export function parseJsonLoose(txt) {
  if (!txt) return null;
  let raw = String(txt).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) raw = fence[1].trim();
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let v = tryParse(raw);
  if (v) return v;
  // 夹杂说明文字时：取「跨度最长」的候选（对象里的空数组不能当结果）
  const cands = [];
  for (const re of [/\[[\s\S]*\]/, /\{[\s\S]*\}/]) {
    const m = re.exec(raw);
    if (m) cands.push(m[0]);
  }
  cands.sort((a, b) => b.length - a.length);
  for (const c of cands) { v = tryParse(c); if (v) return v; }
  return null;
}

export const round1 = v => Math.round((Number(v) || 0) * 10) / 10;
/* 0.01 秒的取整，只给切片采样点用（采样点兼作帧缓存键）。 */
export const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

/* 截断并加省略号：分镜清单与素材描述共用这一份写法。 */
export const ctxClip = (s, max) => {
  const t = String(s == null ? '' : s);
  return t.length > max ? t.slice(0, max) + '…' : t;
};
export const BOARD_CTX_PROMPT = 300;
export const BOARD_CTX_SHORT = 30;

/* 轨道排版：比例 → 百分比（夹在 0–100，分母至少 0.1）。 */
export const pct = (v, total) => Math.max(0, Math.min(100, ((Number(v) || 0) / Math.max(0.1, Number(total) || 0.1)) * 100));
/* 倍速的唯一写法：滑块步进 0.05，最多两位小数；读数不写成 ×1.3000000000000003。 */
export const spdTxt = x => '×' + (Math.round((Number(x) || 1) * 100) / 100);

/* HTML/XML 转义（导演台这几个纯模块在 node 判据里也要跑，页面层的 `window.esc` 在那儿不存在）。
   字符表与 `window.esc` **逐字相同**，是登记在案的「浏览器与 Node 各一份」例外（同 `fileSafe`）：
   改一边必须改另一边，否则同一段提示词在剪辑右栏与在 .fcpxml 里会转得不一样。 */
const ESC_CHARS = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHTML = s => String(s == null ? '' : s).replace(ESC_CHARS, c => ESC_MAP[c]);
