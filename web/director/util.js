/* 导演台纯工具：秒数取整与上下文裁剪（不依赖 DOM / 工程状态）。
   宽松 JSON 解析在 `web/domain/json-loose.js`，
   这里把它再导出一次 —— 导演台的调用点与判据一行都不用改。 */
export { parseJsonLoose } from '../domain/json-loose.js';

export const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/* 输入框逐字触发的那类重渲染走防抖：只有最外面这三行是可共享的，保存路径各自有状态机不在此列。 */
export const debounce = (fn, ms) => { let t = null; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
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

/* 把一段文字当成正则字面量（素材名 / 占位符前缀里可能有 `.` `(` 这类字符）。
   拼 token 正则的两处（engine 的待建占位符、board-assets 的重复出现统计）共用这一份。 */
export const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
