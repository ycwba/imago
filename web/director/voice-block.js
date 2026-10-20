/* 配音块标记：本镜与全片两排共用一份（块长得一样，只是左沿按的时间基不同）。
   纯字符串构建 —— 拖动中的就地重画也读这里的小字与算式。 */
import { round1, pct, spdTxt } from './util.js';
import { voiceRuns } from './voice-layout.js';

export const voiceBlockLabel = v => String(v.name || v.text || '配音').slice(0, 10);
/* 块上那一整行小字（名字 · 成片里念几秒 · 自己那枚倍速）：首屏、拖动中的就地重画、跟手那张卡
   三处读同一个式子。倍速的写法只走 `spdTxt`（0.05 步进就不写成 ×1.3），与右栏那枚滑块同一个格式 ——
   两处格式不一样，用户就会以为块上那个数是另一回事。 */
export const voiceBlockText = (v, sec) => voiceBlockLabel(v) + ' · '
  + round1(Math.max(0, Number(sec) || 0)) + 's'
  + ((Number(v && v.spd) || 1) !== 1 ? ' ' + spdTxt(v.spd) : '');

export function createVoiceBlockRenderer(ctx) {
  /* 一块声音的标记。`box` / `sel` 都是**这一排的时间基**里的秒（`{l, w}`）：
     框决定 left/width，选区只决定框内那两块灰有多宽。 */
  return function voiceBlockHTML(v, box, sel, total, tip, opt) {
    const spill = !!(opt && opt.spill);
    const label = voiceBlockLabel(v);
    const vol = Number(v.vol == null ? 1 : v.vol);
    const bw = Math.max(0.05, box.w);
    const cutL = Math.max(0, sel.l - box.l);
    const off = Math.max(0, Number(v.off) || 0);
    /* 这一句与**灰场**（画面被删掉的那一格）重合的那几截：音频在那里跳过（停住、越过之后接着放），
       所以块要顺延拉长，重合的那几截画成灰带（与跳过的画面格同一种灰）—— `voiceRuns` 是唯一算法，
       这一排自己的尺子上算一遍即可（`opt.gray` = 这一排时间基上的灰场区间）。
       只读的溢出块（`.spill`）**只画带、不拉长**：那一截锚在别的镜上，顺延出一个更长的右沿
       会让人以为它能拖（它在这一排连把手都没有）。 */
    const gray = (opt && opt.gray ? opt.gray : []);
    const selR = sel.l + sel.w;
    const lay = spill ? null : voiceRuns(sel.l, sel.w, gray);
    const end = lay ? lay.end : selR;
    /* 块上那行秒数 = 这一句在**成片里**占几秒，不是它在轨道尺子上跨几秒：
       压在剪掉的头尾上时轨道拉长了而音频一秒没多，报 `end - sel.l` 就是替用户编一个听不到的时长。 */
    const shownSec = lay ? lay.filmSec : sel.w;
    const right = Math.max(box.l + bw, end);       // 拉长后的右沿（框还要盖得住顺延出来的那一截）
    const w = Math.max(0.05, right - box.l);
    const cutR = Math.max(0, right - Math.max(selR, end));
    const bands = (lay ? lay.skips : gray.map(g => [Math.max(sel.l, Number(g[0]) || 0), Math.min(selR, Number(g[1]) || 0)]))
      .map(b => b[1] - b[0] > 0.02
        ? `<span class="vo-skip" style="left:${pct(b[0] - box.l, w)}%;width:${pct(b[1] - b[0], w)}%"></span>` : '').join('');
    const skipSec = Math.max(0, end - selR);       // 被跳过（顺延）掉的那几秒
    /* 那几秒里有多少是**成片里的真洞**（整格黑场）：剩下的那一截只是「轨道上没画面的头尾」，
       音频在成片里一秒都不多占。两句分开说，合成侧与界面上才是同一件事。 */
    const holeSec = lay ? lay.filmSec - sel.w : 0;
    /* 「溢出进来的那一截」是**只读**的：它锚在别的镜上，而这一排的格子是本镜那一条候选的段，
       在这里拖动/剪切会拿错段长与上界（`voiceRowOf` 在本镜那一排按段号找行，它的段号属于别的候选）。
       所以不给它把手 —— 只留试听，点一下会把焦点跳到它自己那一镜（见 bindVoiceLane 的单击分支）。
       声音轨**锁上时同样一颗把手都不画**（与画面轨一致：锁 = 不画 + 手势拒，不是画出来再禁用），
       而且问的是**这一句自己那一行**：锁了第 2 行，第 1 行上的句子照样有把手。 */
    const vLn = ctx.voiceLn(v);
    const vLocked = ctx.rowLocked('voice', vLn);
    const tools = (spill || vLocked) ? '' : `
    <span class="vo-cut l" data-vcut="${ctx.esc(v.id)}" data-edge="l" title="拖这里是剪切：把这一句的开头盖掉（灰掉的那块不进成片）"></span>
    <span class="vo-cut r" data-vcut="${ctx.esc(v.id)}" data-edge="r" title="拖这里是剪切：把这一句的结尾盖掉（灰掉的那块不进成片）"></span>`;
    return `<span class="tl-v${spill ? ' spill' : ''}${ctx.voiceSelId() === v.id && !spill ? ' sel' : ''}${vol < 1 ? ' quiet' : vol > 1 ? ' loud' : ''}${bands ? ' over' : ''}" data-vid="${ctx.esc(v.id)}"
    style="left:${pct(box.l, total)}%;width:${pct(w, total)}%"
    title="${ctx.esc(v.name || label)} · ${ctx.esc(tip)}｜${spill ? '这是别的镜上的一句压到本镜的这一截：点一下跳到你那一句自己那一镜（跳过去就能拖、能剪）'
      : vLocked ? ctx.rowLockWhy('voice', vLn) + '：' + ctx.rowUnlockHow('voice', vLn) + '后才能拖、能剪（点一下仍可选中）'
      : '拖块体挪位置（可挪到别的段），拖左右两条红边把这一句的头/尾切掉（灰掉的那块不进成片），点一下选中（要听走上面那颗「试听」）；音量在右栏那张卡上调'}${off > 0.02 ? '；这一句从音频第 ' + round1(off) + ' 秒起' : ''}${skipSec > 0.02 ? '；压在「灰场」（轨道上没有画面的那几秒）上的 ' + round1(skipSec) + ' 秒会跳过：音频在那几秒不推进、越过之后接着放，块右沿因此顺延到 ' + round1(end - sel.l) + ' 秒' + (holeSec > 0.02 ? '（其中整格黑场 ' + round1(holeSec) + ' 秒在成片里也占时间，这一句成片里念 ' + round1(shownSec) + ' 秒）' : '（这几秒是剪掉的头 / 尾，成片里不占时间，所以这一句仍是 ' + round1(shownSec) + ' 秒）') : ''}">
    <span class="wv-box"></span>
    ${cutL > 0.02 ? `<span class="vo-off" style="width:${pct(cutL, w)}%"></span>` : ''}
    ${cutR > 0.02 ? `<span class="vo-off r" style="width:${pct(cutR, w)}%"></span>` : ''}
    ${bands}
    ${ctx.icon('speaker', 10)}<span class="vt">${ctx.esc(voiceBlockText(v, shownSec))}</span><span class="vn"${vol === 1 || spill ? ' hidden' : ''}>${vol === 1 ? '' : Math.round(vol * 100) + '%'}</span>${tools}</span>`;
  };
}
