/* 配音的时间账：一句配音的框 / 选区 / 倍速 / 灰场跳过 / 它在全片轴上的那一段。
   纯计算 —— DOM 块与拖动在 engine.js，这里只管数。 */
import { round1 } from './util.js';

/* 一句配音**自己**的倍速（用户点名的第 ③ 条：点轨道上那一句配音，右栏给声音那一侧的倍速）。
   0.25–4、缺省 1。它是乘在画面那一格 `spd` **之上**的一档，不是替换：
   「这一格 2 倍速 + 这一句念慢一点 0.5×」= 1×，而旧数据没有这个键 → 读回来 1 → 合成与预览逐字同于从前。
   锚点不参与这个乘法（`at` 只按画面倍速平移 —— 这一句从画面的第几秒开始响，与它自己念多快无关），
   所以四个消费者读的是同一个数：滑块（写）、`clipVoices`（递进 `/render`）、指纹（判新旧）、`TlPlay`（预览）。 */
export const VOICE_SPD_MIN = 0.25, VOICE_SPD_MAX = 4;
export const voiceRateOf = v => Math.max(VOICE_SPD_MIN,
  Math.min(VOICE_SPD_MAX, Number(v && v.spd) || 1));

/* 没有配音时按字数估一句要念多久（只用于待生成占位符的宽度与无配音字幕的初始时长，
   不参与任何计费/提交）。导演台与字幕模块共用这一份，不在两边各写一个 4.5。 */
export const LINE_EST_CPS = 4.5;
export const lineEstSec = text => Math.max(1.2, String(text || '').length / LINE_EST_CPS);

/* 一句「还没配音的台词」压在哪一格画面的什么位置：起点与按字数估出的念白长度。
   轨道上那两个待生成占位、右栏台词行上的两个读数都走这一份算式 —— 块长在那儿而读数说另一处，
   就是同一句话两把尺子（数据层仍是源秒，这里出的已经是轴秒）。
   `film = true` 时起点取这一格在**成片秒**上的起点 `f0`：被剪掉的头不占成片时间，
   所以不再按 `(from − a) / spd` 平移 —— 那一平移是排版那把轴秒尺子的账（见 timeline.js 开头）。 */
export function lineSpanAt(r, fromSrc, est, film) {
  if (!r) return null;
  const spd = Math.max(0.25, Math.min(4, Number(r.spd) || 1));
  const a = Number(r.a) || 0, b = Number(r.b) || 0;
  const from = Math.max(a, Math.min(b, Number(fromSrc) || a));
  const at = film ? (Number(r.f0) || 0) : (Number(r.start) || 0) + (from - a) / spd;
  return { at: round1(Math.max(0, at)), len: round1(Math.max(0.05, (Number(est) || 0) / spd)) };
}

/* 一句配音的「框」与「选区」—— 与画面轨同一套概念（见 engine.js「时间轴只有两件东西」那段）：
     · **框** `[fa, fb]`：这一格摆在轨道上的哪儿、有多宽。加进来时定下（= 那一刻的整条音频），
       拖把手**不改它** —— 所以块的左右沿、宽度一个字节都不动；
     · **选区** `[at, at+dur]`：真正进成片的那一截，永远夹在框里。
   框内那两块灰 = 被切掉的头 / 尾。老数据没有 fa/fb：框 = 选区（一灰不挂），与从前一模一样。
   `off`（音频文件内部的起点）跟着选区起点走：往右切多少秒，off 就前进多少秒。 */
export function voiceFrameOf(v) {
  const at = Math.max(0, Number(v && v.at) || 0);
  const dur = Math.max(0.05, Number(v && v.dur) || 0);
  /* 选区在**源秒**上占多长：`dur` 是音频文件秒，念得快只占更短的画面时间 —— 少除这一档，
     「框必须包住选区」这条兜底会把 ×1.5 的框读长（切开的前半被顶到 at+dur=1.15，与后半
     的左沿 0.9 对不上，融合判据于是永远说不出「挨着」—— 表现是「切开的两半融不回去」）。 */
  const span = dur / voiceRateOf(v);
  let fa = Number(v && v.fa), fb = Number(v && v.fb);
  if (!(fa >= 0) || !(fb > fa)) { fa = at; fb = at + span; }
  /* 框必须包住选区：任何时候读到的都是一个「画得出、夹得住」的形状，
     不让越界的数据把灰块算成负宽度。 */
  return { fa: Math.min(fa, at), fb: Math.max(fb, at + span) };
}

/* 一次拖动收尾时把这一句的秒数量到 0.1 秒。
   拖动中途**不**量化：`round1` 夹在每一帧里，高倍档（600 像素/秒）上就是 60 像素一跳，
   看着是「咔咔跳格」而不是跟手；而落盘、指纹与提交体要的是干净的数，只在松手这一次做就够。 */
export function roundVoice(v) {
  if (!v) return v;
  ['at', 'dur', 'fa', 'fb', 'off'].forEach(k => { if (v[k] != null) v[k] = round1(v[k]); });
  return v;
}

/* 一句配音撞上**灰场**（轨道上那一排不画画面的秒）时的真实时间账：音频不在那几秒里推进，
   越过整段灰场之后接着放（内容一秒不丢），所以这一句在轨道上要顺延拉长。
   与画面轨同一套判据：灰场**整段跳过**，不半穿 —— 音频在灰场开始那一秒停下、在灰场结束那一秒续上，
   所以「撞上的整段灰场」才是被跳过的那一块（从灰场里起选的那一句，跳过带从起选点画起）。
   `lo` / `len` / `gray` 都是**这一排自己的那把尺子（轴秒）**上的秒（两条轨都是，只是各自的轴：
   本镜 = 这一条候选的框 ÷ 各段倍速，全片 = 成片秒；合成与预览在成片 / 墙钟尺上各算一遍，见 clipVoices 的 ctx）。
   ⚠ 灰场有两种，**画在同一条尺子上是同一件事，在成片里不是**：
     · 整格黑场（`s.off` / `cl.gray`）在成片里**占时间** → 音频真的在那几秒暂停，成片里多占那么长；
     · 框内被剪掉的头 / 尾（`[a,in]` 与 `[out,b]` 那两块 mask）**不占成片时间**（下一格的选区紧接着就上），
       音频没有停，只是轨道这一把尺子在那几秒里没有画面 —— 所以块照样要跳过它画，但那几秒不计进秒数读数。
   因此灰场清单带第三个元素：`[起, 止, 是不是真洞]`（缺省 = 真洞，与从前逐字节相同）。返回：
     · runs     —— 真正在放的几段 `[r0, r1)`（依次相接，中间隔着 skips）
     · skips    —— 被跳过的灰场 `[g0, g1, 真洞?]`（整段灰场，画成灰带）
     · end      —— 音频放完落在哪一秒（= 拉长之后的右沿，两种灰场都算进去）
     · filmSec  —— 这一句在**成片里**占几秒（只有真洞加进去）：块上那行秒数读的是它，
                   不是 `end - lo` —— 后者会把「轨道上没有画面的那几秒」报成配音的时长。
   没有灰场时 runs 恰好是一段 `[lo, lo+len)`、end = lo+len、filmSec = len —— 与从前逐字节相同。 */
export function voiceRuns(lo, len, gray) {
  const runs = [], skips = [];
  let cur = Math.max(0, Number(lo) || 0);
  let left = Math.max(0, Number(len) || 0);
  if (!(left > 0.02)) return { runs: runs, skips: skips, end: cur, filmSec: Math.max(0, Number(len) || 0) };
  const gs = (gray || []).map(g => [Number(g[0]) || 0, Number(g[1]) || 0, g.length > 2 ? (g[2] ? 1 : 0) : 1])
    .filter(g => g[1] - g[0] > 0.02).sort((x, y) => x[0] - y[0]);
  let held = 0;
  for (let guard = 0; guard < 64 && left > 0.02; guard++) {
    /* 下一个撞上的灰场 = 第一条与 `[cur, cur+left)` 有实质重叠的（清单排过序，取第一条即是最近的） */
    const hit = gs.find(g => g[1] > cur + 0.02 && g[0] < cur + left - 0.02);
    if (!hit) { runs.push([cur, cur + left]); cur += left; left = 0; break; }
    const stop = Math.max(cur, hit[0]);
    if (stop - cur > 0.02) { runs.push([cur, stop]); left -= stop - cur; }
    skips.push([stop, hit[1], hit[2]]);
    if (hit[2]) held += hit[1] - stop;      // 只有黑场在成片里占时间，剪掉的头尾不占
    cur = hit[1];
  }
  return { runs: runs, skips: skips, end: cur + Math.max(0, left), filmSec: Math.max(0, Number(len) || 0) + held };
}

/* 轴行表里那一格「进成片的那一截」的源秒左右沿：全片那一排的行带 `cl`（时间线那条），
   本镜那一排的行带 `s`（候选自己的 segs）。两条轨之后只按这一对取值，不再各写一份 `?.`。 */
export const rowSelIn = r => Math.max(0, Number(r && (r.cl ? r.cl.in : r.s ? r.s.in : 0)) || 0);
export const rowSelOut = r => Number(r && (r.cl ? r.cl.out : r.s ? r.s.out : 0)) || 0;

/* 一句配音摊到「它锚着的那一格的轴」上的三件数：块（= 句自己的框 `fa/fb`）、选区、块上那行小字要的秒数。
   **两条轨共用这一份**（本镜那一排的行来自候选自己的 segs，全片那一排来自时间线；行的形状同一套）。
   两道折算一道都不能少：`v.dur` 是**音频文件秒**，÷ 自己那一档（`own`，句的倍速）才是源秒，
   再 ÷ 那一格的倍速（`r.spd`，画面段）才是轴秒 —— 少除哪一道，界面上那块就比听着的一句长一截。 */
export function makeVoiceAxBox(srcToFrame) {
  return (r, v) => {
    const spd = Math.max(0.25, Number(r && r.spd) || 1);
    const base = srcToFrame(r, rowSelIn(r));
    const fr = voiceFrameOf(v), own = voiceRateOf(v);
    const dur = Math.max(0.3, Number(v.dur) || 0) / own / spd;
    return { spd: spd, fr: fr, base: base, dur: dur,
      box: { l: base + fr.fa / spd, w: (fr.fb - fr.fa) / spd },
      sel: { l: base + Math.max(0, Number(v.at) || 0) / spd, w: dur } };
  };
}

/* 一句配音在**全片时间轴**上占的那一段（成片秒 `[from, from+dur)`）+ 它为什么画不出来。
   音轨可以跨镜：在全片轨上把一句从这一镜拖到那一镜，数据里 shotId/candId/seg 一起换掉了；
   反过来，一句**锚在这一镜某一段**、却比那一段还长的配音，在成片里会**溢出到后面那一镜**
   （用户点名的「音轨能够跨越多个镜」）。全站只有这一份算法（frameT 的逆）。 */
export function createVoiceFilm({ filmFrames, tlSyncFromShots, allShots, voiceAxBox }) {
  function voiceFilmSpan(v) {
    const G = filmFrames(tlSyncFromShots());
    if (!G.rows.length) return null;
    const mine = G.rows.find(r => r.cl.kind === 'shot' && r.cl.shotId === v.shotId && r.cl.candId === v.candId
      && (Number(r.cl.seg) || 0) === (Number(v.seg) || 0));
    /* 找不到它锚着的那一格 = 这一句**压根不在成片时间轴上**，不能给它编一个位置。
       以前这里没有闸：拿 0 当那一格的起点照样算出一段 `{from:0,to:dur}`，于是「本镜」那一排把
       挂在没选用的候选上的一句当成「别的镜压过来的那一截」画了出来，而全片那一排按 candId 精确匹配
       什么也不画 —— 用户点名的「本镜里有配音，全片里居然没有配音」正是这两行的差。
       画不出来交回调用方，由 `voiceFilmGap` 说清为什么（同一个判据，两条轨共用）。 */
    if (!mine) return null;
    /* 这一句在**轴**上的那一段 = `voiceAxBox` 的选区（与两条轨画块用的是同一份折算）：
       位置那两样都只折算画面倍速（`v.at` 是源秒，轴上是 `/sp`；句自己的倍速不挪起点）。
       长度是另一回事：`v.dur` 是**音频文件秒**（合成侧 atempo 之前那一段），
       ÷ 自己那一档（`own`）才回到源秒，再 ÷ 画面倍速才是轴秒 —— 少除 `own`，
       ×1.5 的那一句在全片这一排上会画长一半。调用处拿它和 `r.start ~ r.start + r.w` 比，
       两边同一把尺子才谈得上重叠。 */
    const bx = voiceAxBox(mine, v);
    return { from: round1(bx.sel.l), to: round1(bx.sel.l + bx.sel.w) };
  }
  /* 「这一句为什么画不出来 / 进不了成片」的原因，全站只有这一份：返回一个**原因码**（空串 = 画得出来）。
     界面那句人话由 `VOICE_GAP_TXT` 现拼，「能不能挪」由 `voiceAdoptable` 按码判 ——
     拿句子当判据的话，改一个字文案就把功能判没了。 */
  function voiceFilmGap(v) {
    if (!v || !v.src) return 'noaudio';
    const sh = allShots().find(x => x.id === v.shotId);
    if (!sh) return 'noshot';
    const G = filmFrames(tlSyncFromShots());
    if (!G.rows.some(r => r.cl.kind === 'shot' && r.cl.shotId === sh.id)) return 'shotout';
    if (voiceFilmSpan(v)) return '';
    const c = (sh.candidates || []).find(x => x.vid === v.candId);
    if (!c) return 'nocand';
    if (sh.selId !== c.vid) return 'unsel';
    return 'nogseg';
  }
  const VOICE_GAP_TXT = {
    noaudio: '这一句还没有合成出音频',
    noshot: '它挂的那个镜头已经不在了',
    shotout: '这一镜还没进成片（先在候选上点「用这条」）',
    nocand: '它挂的那一条候选已经不在了',
    unsel: '它挂在没被选用的那一条候选上',
    nogseg: '它锚着的那一段画面已经被剪掉了',
  };
  const voiceFilmWhy = v => VOICE_GAP_TXT[voiceFilmGap(v)] || '';
  const voiceInFilm = v => !voiceFilmGap(v);
  /* 「能挪」那一族：它自己那一镜在成片里，只是锚点没了（换了候选 / 候选没了 / 那一段被剪了）。
     `shotout` 不在这一族里 —— 那一整镜都没进成片，把配音挪到它自己的选用候选上照样进不了成片，
     挪一下等于替用户做了一件不做不错的事。 */
  const VOICE_GAP_FIX = ['unsel', 'nocand', 'nogseg'];
  const voiceAdoptable = v => VOICE_GAP_FIX.includes(voiceFilmGap(v));
  return { voiceFilmSpan, voiceFilmGap, VOICE_GAP_TXT, voiceFilmWhy, voiceInFilm, VOICE_GAP_FIX, voiceAdoptable };
}
