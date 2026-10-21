/* 片段模型：一条候选身上的 `c.segs` 怎么读、怎么复制、怎么落回去。
   纯数据层 —— 不碰 DOM、不问当前镜头；时间线几何（轴向、框、灰场）在 timeline.js。 */
import { round1 } from './util.js';

/* 一条时间线 clip 在成片里占几秒（选区源长 ÷ 倍速）。 */
export const tlClipDur = c => Math.max(0.1, ((Number(c.out) || 0) - (Number(c.in) || 0)) / (Number(c.speed) || 1));

export const SEG_MIN = 0.2;          // 一刀下去两头至少各留这么多，否则下一次「再切」会切出零长段
export const segLen = s => Math.max(0.1, round1((Number(s && s.out) || 0) - (Number(s && s.in) || 0)));
/* 一段画面自己的音量：与配音那一句同一把尺子（0–200%，缺省 100%），交给 `/render` 后代理按它混原声
   （`clips[].volume` → `volume=` 那一条滤镜，proxy.js 的 clampVol 还宽到 400%，界面这一头先夹 200%）。
   **只在真的调过时才写进数据**（=100% 时不留这个键），否则每个工程的每一段都挂一个没人看的 1。
   读的地方一律问这一个函数：`tlFromShots`（派生成片 clip）、格子上那行小字、音量滑块都问它，
   自己写 `s.vol || 1` 早晚有一处把 0 当成「没设过」。 */
export const segVol = s => (s && s.vol != null && isFinite(Number(s.vol)) ? Math.max(0, Math.min(2, Number(s.vol))) : 1);
/* 一段画面自己的**倍速**（0.25–4，与代理 `/render` 那侧 `Math.min(4, Math.max(0.25, …))` 同一区间）。
   与 `segVol` 同一套记账：只在真的改过才占一个键（`spd`），缺省 1 不落盘。
   倍速改的是「这一段在**成片**里占多久」（`tlClipDur` 与全片轨那一格的排版宽都除它），
   不改源秒 —— 而**两条轨都按轴秒摆**（轴秒 = 框 ÷ 倍速），所以改一档倍速，本镜那一排的这一格
   与全片那一排的这一格一起变宽/变窄，压在这一格上的配音块也跟着折算（用户点名的第 ① 条）；
   合成时画面 `setpts/speed`、原声与配音各按同一 `atempo`（代理那侧早就写好了，只缺一个写点）。 */
export const segSpd = s => (s && s.spd != null && isFinite(Number(s.spd)) ? Math.max(0.25, Math.min(4, Number(s.spd))) : 1);
/* 这一段在**成片**里占的秒数（= 选区源长 ÷ 倍速）。界面那些「这一段留了几秒」的读数一律问它，
   不要有的地方报源秒、有的地方报成片秒 —— 倍速一上，两者就不是一回事了。 */
export const segFilmLen = s => Math.max(0.05, round1(segLen(s) / segSpd(s)));

export const TRACK_LANES_MAX = 12;
export const laneClamp = ln => Math.max(0, Math.min(TRACK_LANES_MAX - 1, Math.round(Number(ln) || 0)));
export const picLnOf = s => laneClamp(s && s.ln);

/* 段身上那四件「用户自己调出来的东西」只有这一处会搬：音量、倍速、第几行画面轨、黑场旗标。
   凡「重建一个新段对象」的地方（切一刀 / 融合 / 调入出点 / 拖把手时复制整条列表）都必须过它。
   以前每处各抄一遍、每处各漏一两件 —— 切一刀抹掉倍速与行号，调一次入出点也抹掉倍速与行号，
   而那一格在轨道上的位置与宽度一个字没动，界面上完全看不出数据被换了（「改 A 悄悄清 B」）。
   记账：100% / ×1 / 第 1 行 / 有画面 都是缺省值，不占键 —— 老工程不用迁移，读一次也不会让成片指纹变陈旧。 */
export const segCarry = (src, o) => {
  const v = segVol(src), sp = segSpd(src), ln = picLnOf(src);
  if (v !== 1) o.vol = v;
  if (sp !== 1) o.spd = sp;
  if (ln) o.ln = ln;
  if (src && src.off) o.off = 1;
  return o;
};

/* 一段 = 「框」+「选区」两个区间，都在**源视频的秒数**上：
     · 框 [a, b]  —— 这一段在源里"分到"的那一块（切开时按切点定下来，**拖把手不改**）。
       它是这一段在轨道上的位置与宽度（两条轨都按 **框 ÷ 这一段的倍速** 摆），所以拖把手时**框不动**。
     · 选区 [in, out] —— 真正留在成片里的那一段。拖左边/右边把手改的就是它：
       框内左侧（或右侧）那段没被选中的画面就"消失"了（画一层灰遮罩），
       而不是整条一起缩小 —— 后者会连带把别的段的切片也重排一遍（用户报的就是这个）。
   老工程里没有 a/b 的段：框 = 选区（与改动前逐字相同），一旦拖过把手就会写上 a/b。
   读的时候一律夹紧 `a ≤ in ≤ out ≤ b`：脏数据（a 比 in 大之类）在界面上表现为
   「遮罩宽度是负的」，宁可夹到合法区间也不画出负宽度。 */
export function segsOf(c, total) {
  const T = Math.max(0.1, Number(total) || 0);
  const raw = (c && Array.isArray(c.segs)) ? c.segs : null;
  const src = raw || [{ in: (c && c.trimS) || 0, out: (c && c.trimE != null ? c.trimE : T) }];
  const out = [];
  src.forEach(s => {
    let i = Math.max(0, Math.min(Number(s && s.in) || 0, T));
    let o = Math.max(0, Math.min(s && s.out != null && isFinite(Number(s.out)) ? Number(s.out) : T, T));
    if (o - i < SEG_MIN) { o = Math.min(T, i + SEG_MIN); if (o - i < SEG_MIN) i = Math.max(0, o - SEG_MIN); }
    if (!(o > i)) return;
    let a = (s && s.a != null && isFinite(Number(s.a))) ? Number(s.a) : i;
    let b = (s && s.b != null && isFinite(Number(s.b))) ? Number(s.b) : o;
    a = round1(Math.max(0, Math.min(a, i)));          // 框必须包住选区
    b = round1(Math.min(T, Math.max(b, o)));
    const seg = { in: round1(i), out: round1(o), a: a, b: b };
    segCarry(s, seg);
    out.push(seg);
  });
  return out;                        // 空数组是**有效状态**：这一条候选一段画面都不留
}

/* 一条候选剪出来的几段**在成片里**一共几秒（每段 `segFilmLen` = 选区 ÷ 倍速）：
   镜头卡片、顶上「全片 X 秒」、剪辑回执那句「这一条共几秒」都问它。
   ⚠ 它**不是**轨道那把尺子：尺子按**框**摊（`shotFrames` / `filmFrames` 的 `total`），
   被剪掉的头尾那两块灰在尺子上占地方、在这个数里不占 —— 混用一处就是
   「格子上写着 4 秒、顶上那句说 2 秒、右边刻度到头却是 5 秒」。
   数据层（剪刀指的哪一秒、入出点那两框、配音的 `at`）一律还是**源秒**，不读这里。 */
export const segsFilmLen = (c, total) => segsOf(c, total).reduce((a, s) => a + segFilmLen(s), 0);

/* 复制一份段列表（**in/out 是选区、a/b 是框，再带走调过的音量、倍速、行号与灰场标记**）。
   拖动里以前写的是 `.map(s => ({ in: s.in, out: s.out }))` —— 加 a/b 那天就漏在这里：
   每动一下鼠标，框就被这一份『只有选区的副本』冲掉、塌回选区，于是
   「拉左边应该是左边消失」变成「整格跟着缩」，而框内的灰遮罩宽度恒为 0（看着像没反应）。
   复制这件事只有这一个函数：以后再加字段，改一处就够。 */
export const segsCopy = list => (Array.isArray(list) ? list : []).map(s =>
  segCarry(s, { in: s.in, out: s.out, a: s.a, b: s.b }));

export function segsWrite(c, total, segs) {
  const list = segsOf({ segs }, total);
  c.segs = list;
  c.trimS = list.length ? list[0].in : 0;
  c.trimE = list.length ? list[list.length - 1].out : 0;
  return list;
}
