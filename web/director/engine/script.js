/* 导演台Script域：AI 分镜这一面只留「镜头时长的口径」——可用型号声明区间的交集、给 AI 的那句约束、
   落盘之后逐镜夹回它自己那一档。区间内的代码由 engine.js 逐字搬出，E 只递 shotModels / videoPlanOf
   两位（Panel 那份解构结果，建包时还没初始化，所以 engine 那边包成箭头）；document / window 用参数名遮蔽全局。 */

export function createScript(E, document, window) {
  'use strict';
  const {
    shotModels,
    videoPlanOf,
  } = E;

/* ---------------- ④ AI 分镜：拆新 / 改现有 / 加镜头（2026-10 扩成三件事） ----------------
   页头「拆分镜」那一个入口下现在挂三档任务，判据与落点都在这一节：
     · 拆一份新的（new）   —— 贴剧本拆一个新短片（老路，口径一个字节没动）
     · 修改现有分镜（edit）—— 对着现有分镜说一句话（不说就是整体优化提示词），AI 回一份 changes
     · 接着往下拆（append）—— 把现有分镜的清单连同新文案一起喂给 AI，顺着往下加镜头
   后两档都不重拆已有镜头 —— 以前想改一句话只能「拆一份新的」，而那是另起一个短片：
   用户已经生成好的画面与剪辑记录全留在旧那个里。
   改 / 加走 board_edit 那条链，四个纯函数管全链：
     snapBoard       把当前分镜编成带序号的清单（给 AI 看、给用户对）
     boardListText   把清单拼成给 AI 的那段正文（长提示词截断，一条只留认得出身份的信息）
     boardPlanOf     把 AI 回的 changes 翻成「对哪一条镜头做什么」的账（**序号在这里就翻成镜头 id**）
     applyBoardPlan  唯一的落盘点：按 id 找到那一条就地改 / 按位置插进去
   序号只对 AI 那一句有效：审查弹窗里用户删掉几条之后序号就漂了，所以账上必须已经是 id。 */
/* 镜头时长的口径**只有「型号自己声明的区间」这一份**。
   以前这里是一份写死的 2–15 秒加一个默认 5 秒：全站根本没有统一值，各家各自声明自己的 min/max
   （注册表里实测过的是「4 到 15」与「5 到 10」两种），而界面把 AI 回的 duration clamp 到那份 2–15
   就当「合法」—— 用户不逐镜点开右栏、直接点「生成全部分镜」时，提交体发的是 AI 那个越界原值
   （按型号回写那一句只在打开这一镜时执行），平台一句 4xx 才算完。
   现在这几件事各归一处，页面不认任何一家供应商：
     videoDurSpan()       可用型号声明区间的**交集**（批量时不同镜头会落到不同平台，
                          取并集会产出「至少有一家收不了」的时长）
     boardDurNote()       把上面那个区间写成给 AI 的那句约束；区间算不出时**整句不加**
     boardDurSub()        同一件事在审查弹窗里那句「区间从哪来」，与 hint 共用算式
     clampShotDurations() 落盘之后**逐镜**按「这一镜真由谁发出去」夹回它自己那一档，并报了改了哪几镜
     suggestShots()       镜数的**软上限**：按剧本字数现算，只提示，不截断、不拦截
   ⚠ 交集不许拿 `resolvedModel(null)` 当基准：它取的是 `Api.pickable` 清单的第一项，而那份清单
     随「这台机器配了哪几家密钥」而变 —— 同一份剧本在 A 机器算 14 秒合法、在只配了上限 10 秒那家的
     B 机器就不合法。约束要跟着**路由**走，不是跟着账号的第一项走。 */
function videoDurSpan() {
  const spans = [];
  (shotModels(null) || []).forEach(g => (g.models || []).forEach(m => {
    const d = (((m && m.options) || g.options) || {}).durations;
    if (Array.isArray(d) && d.length === 2 && Number(d[0]) > 0 && Number(d[1]) >= Number(d[0]))
      spans.push([Number(d[0]), Number(d[1])]);
  }));
  const lo = spans.length ? Math.max(...spans.map(s => s[0])) : 0;
  const hi = spans.length ? Math.min(...spans.map(s => s[1])) : 0;
  const ok = spans.length > 0 && hi >= lo;
  /* `n` = 共同区间成立时参与交集的型号数（那句说明要报这个数）；
     `any` = **声明了区间**的型号数（哪怕它们彼此没有交集）。两个数不能合并：
     「一家都没声明」与「声明了但互相没有交集」是两件事，界面上要说的话不一样，
     而落盘那一 gate 只认 `any`（有声明就有得校验，逐镜夹自己那一档总做得成）。 */
  return { min: ok ? lo : 0, max: ok ? hi : 0, n: ok ? spans.length : 0, any: spans.length };
}
/* 这份 AI 给的秒数到底有没有「能判合法」的依据：没有任何一家声明区间时一个字都不写进镜头
   （镜头上没有 duration = 交给平台默认，比替平台编一个秒数诚实）。 */
const durWritable = () => videoDurSpan().any > 0;
/* 两条落盘路径唯一的 duration 写点：判据 + 取整 + 「不写」这一档都只在这里一次。 */
function setShotDur(sh, v) {
  const d = Math.round(Number(v));
  if (durWritable() && Number.isFinite(d) && d > 0) sh.duration = d;
}
/* 给 AI 的那句时长约束。可用型号为零（或它们的区间压根没有交集）时**整句不加**，
   落盘时也一律不替它写 duration —— 沿用「没声明就不碰」的立场。 */
function boardDurNote() {
  const s = videoDurSpan();
  if (!s.n) return '';
  return '每一镜的 duration 必须是 ' + s.min + ' 到 ' + s.max + ' 秒之间的整数；'
    + '按信息量分配（建立环境的镜头可以长，纯反应镜头要短），不要所有镜头一样长。'
    + '真正需要更长时间的长镜头照常给足秒数：超过所有可用型号上限时，程序会按接续型号把它拆成几段，'
    + '第二段起自动接上一段的尾帧，你不用自己拆成多条。';
}
/* 区间从哪来，那句说明就得写从哪来 —— 表单 hint 与审查弹窗 sub 共用这一句，
   否则「5–10 秒」在两处各拼一遍，其中一处迟早漏掉「按什么算的」。
   「一家都没声明」与「声明了但互相没有交集」分两句话说：后者的镜头照样按自己那一档夹得住。 */
function boardDurSub() {
  const s = videoDurSpan();
  /* 超出所有型号上限的长镜头会被程序拆成接续段（`splitLongShots`）：这是落盘前就会发生的事，
     弹窗里只看得到「5–10 秒」会让人以为长镜头被截短了。 */
  const splitNote = '；超过所有可用型号上限的长镜头会自动拆成接续段（第二段起接上一镜尾帧）';
  if (s.n) return '时长 ' + s.min + '–' + s.max + ' 秒（按本机当前可用的 ' + s.n + ' 个视频型号共同支持范围）' + splitNote;
  if (s.any) return '这 ' + s.any + ' 个可用型号的时长区间彼此没有交集，AI 不给区间、落盘时逐镜按各自型号夹回' + splitNote;
  return '本机现在没有声明时长区间的可用视频型号，镜头的 duration 交给平台默认';
}
/* 镜数的软上限：按剧本字数现算。写死一个数会跟「上限只从声明来算」的口径打架。
   它只是提醒用的档，不参与任何截断与拦截。 */
const suggestShots = text => Math.max(4, Math.round(String(text || '').length / 200 * 9));
/* 「这一段大概拆几镜」那一句话只写一次：`got` 为空 = 表单里还没 AI 结果，给了 = 审查弹窗那句。 */
function softShotsNote(text, got) {
  const n = suggestShots(text), L = String(text || '').length;
  if (got == null) return '按这段长度（' + L + ' 字），预计拆 ' + n + ' 镜左右'
    + (L > 2000 ? '；剧本较长，建议先用「拆一份新的」出骨架，再用「接着往下拆」分批补' : '');
  if (got <= n) return '共 ' + got + ' 个镜头（这一段按字数预计 ' + n + ' 镜左右）';
  return '这一段按字数预计 ' + n + ' 镜左右，这次给了 ' + got + ' 个：镜头多可以分批生成，'
    + '也可以取消重拆（本次照常写入，一个都没截掉）';
}
/* 落盘之后的兜底：逐镜按「这一镜最终由谁发出去」判（同一份 AI 结果里不同镜头落到不同平台是常态），
   夹完必须报数，不悄悄改。尺子复用 `videoPlanOf` → `AdvParams.plan` 那一档「数字档夹到最近那一秒」，
   不在这页再写一份 min/max —— 那是同一件事的第二把尺子。
   吃的是**扁平的镜头清单**：两条落盘路径各知道自己「这一次动过哪几镜」，
   拿全片所有镜头去夹会把没参与这次写入的也改一遍，那两句报数就成了假话。 */
function clampShotDurations(shots) {
  const bits = []; let n = 0;
  (shots || []).forEach(sh => {
    const cur = Number(sh && sh.duration);
    if (!Number.isFinite(cur) || cur <= 0) return;          // 没填时长的镜头不替它编一个
    const vp = videoPlanOf(sh);
    const d = (vp.kinds || {}).duration;
    if (!d || !d.list.length) return;                        // 这一家没声明区间 → 一个字不动
    const to = Number(d.value);
    if (!Number.isFinite(to) || to === cur) return;
    const mm = vp.model || {};
    bits.push((sh.name || '未命名镜头') + ' · ' + cur + ' 秒 → ' + to + ' 秒（'
      + (mm.name || mm.id || '这一型') + ' 支持 ' + d.min + '–' + d.max + ' 秒）');
    sh.duration = to; n++;
  });
  return { fixed: n, detail: bits.slice(0, 5).join('；'), more: Math.max(0, n - 5) };
}
/* 结果行里那半句「顺手夹了哪几镜」：没夹就一个字不加。 */
const clampNote = c => (!c || !c.fixed ? '' : '（其中 ' + c.fixed
  + ' 镜的时长超出各自型号支持范围，已收进区间：' + c.detail
  + (c.more ? '；另有 ' + c.more + ' 镜' : '') + '）');


  return {
    boardDurNote,
    boardDurSub,
    clampNote,
    clampShotDurations,
    durWritable,
    setShotDur,
    softShotsNote,
  };
}
