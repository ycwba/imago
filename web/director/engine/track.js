/* 导演台Track域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createTrack(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1, pct, spdTxt, escHTML } from '../util.js';
import { SEG_MIN, segLen, segVol, segSpd, segFilmLen, segCarry, segsOf, segsFilmLen, segsCopy, segsWrite, segsPan, TRACK_LANES_MAX, laneClamp, picLnOf, tlClipDur } from '../segments.js';
import { isImageSeg, isVirtualSeg, imageVirtualBase, imageTailSeg, makeGapSeg, placeImageSeg } from '../image-seg.js';
import { isGap, linksOf, nextLiveSeg, relinkTargets, setLinks } from '../links.js';
import { linePointOf, linePointSet } from '../line-point.js';
import { createTimeline } from '../timeline.js';
import { voiceRateOf, voiceFrameOf, voiceRuns, makeVoiceAxBox, createVoiceFilm, VOICE_SPD_MIN, VOICE_SPD_MAX } from '../voice-layout.js';
import { createWaveform } from '../waveform.js';
import { createProjection } from '../projection.js';
import { createVoiceBlockRenderer } from '../voice-block.js';
import { defaultKeyOf, groupByMaterial, planLaneRows, applyLanePlan, pickVoiceLane } from '../voice-lanes.js';

export function createTrack(E, document, window) {
  const {
    projOf,
    uid,
    allShots,
    curShot,
    fmtDur,
    shotReady,
    beginEdit,
    filmEdited,
    scheduleSave,
    isFilmMode,
    segLabel,
    voiceElOf,
    playVoicePreview,
    paintVoiceVol,
    voiceLn,
    voiceMin,
    selectVoice,
    paintTrimRow,
    filmPinT,
    vcTabOf,
    renderAll,
    setStatus,
  } = E;

/* ============================================================================
   成片时间线（timeline）—— LLM 剪辑与浏览器内离线导出的数据基础
   clip = { id, kind:'shot'|'asset', shotId?, candId?, assetId?, src?, name, in, out, speed, volume, gray? }
     · kind 'shot'  引用某个镜头的候选（可重排、可重复使用、可单独裁剪）
     · kind 'asset' 直接引用资产库素材（按 src 或资产号取用）
     · gray 1 = 这一段画面被删成黑场（kind 还是 shot，仍占这一段的时间）
   ========================================================================== */
function tlEnsure() {
  if (!projOf().timeline || !Array.isArray(projOf().timeline.clips)) projOf().timeline = { clips: [] };
  return projOf().timeline;
}
const tlDuration = () => tlEnsure().clips.reduce((a, c) => a + tlClipDur(c), 0);
const tlCandidateOf = (sh, candId) =>
  (sh.candidates || []).find(c => c.vid === candId) || (sh.candidates || []).find(c => c.vid === sh.selId) || null;

/* ============================================================================
   多段剪辑（切开 / 向左切 / 向右切 / 删掉这一段）—— 段存在**候选自己身上**
   ----------------------------------------------------------------------------
   `c.segs = [{ in, out }, …]`：源视频里的秒，按播放顺序。
   为什么不存时间线的 clip 上：clip 是每次 `tlFromShots()` 现派出来的（换候选、拖顺序都会重建），
   段存在 clip 上就等于「本镜」与「全片」各存一份 —— 用户点名的正是这件事：在一处剪完，另一处照旧。
   存在候选上，两处都只是它的读数：本镜切一刀，全片的段数、秒数、切片图和配音位置一起跟着变。
   老数据只有 `trimS/trimE`（单段）：`segsOf` 认它；每次落地又把 `trimS/trimE` 回写成
   「首段入点 / 末段出点」—— 候选卡与归档摘要还在读那两个字段，不能各说各话。 */
const candDur = (c, sh) => Math.max(0.1, Number(c && c.duration) || Number(sh && sh.duration) || 5);
/* 时间线几何：两条轨共用的框 / 轴秒 / 灰场 / 折算。纯算法在 timeline.js，这里只把
   「当前工程有哪些镜头、怎么找候选」交给它。 */
const Timeline = createTimeline({ allShots, tlCandidateOf, candDur });
const {
  filmFrames, axisGray, filmLayGray, frameToSrc, srcToFrame,
  shotFrames, shotRowAt, shotRowOf, shotPinT, shotAxTotal,
} = Timeline;
const voiceAxBox = makeVoiceAxBox(srcToFrame);
const {
  voiceFilmSpan, voiceFilmGap, VOICE_GAP_TXT, voiceFilmWhy, voiceInFilm, VOICE_GAP_FIX, voiceAdoptable,
} = createVoiceFilm({ filmFrames, tlSyncFromShots: () => tlSyncFromShots(), allShots, voiceAxBox });
const { voicePeaks, waveformSVG, fillWaveforms, videoPeaks, drawSegWave, fillSegWaveforms } = createWaveform({
  mediaSrc: s => Api.mediaSrc(s),
  voiceOf: id => voicesEnsure().find(x => x.id === id),
});
/* 配音块标记（本镜 / 全片共用的那一份）在 voice-block.js；这里只把页面状态接进去。 */
const voiceBlockHTML = createVoiceBlockRenderer({
  esc: s => esc(s), icon: (n, s) => icon(n, s),
  voiceSelId: () => voiceSelId(), voiceLn: v => voiceLn(v),
  rowLocked: (k, ln) => rowLocked(k, ln),
  rowLockWhy: (k, ln) => rowLockWhy(k, ln),
  rowUnlockHow: (k, ln) => rowUnlockHow(k, ln),
});
/* 剪辑界面正指着哪一段（切完之后指针要留在看得见的地方；老工程没这个字段 = 第 0 段） */
const cutSegIdx = () => Math.max(0, Number(projOf() && projOf().cutSeg) || 0);
const curSegOf = (sh, c) => { const ss = segsOf(c, candDur(c, sh)); return ss.length ? ss[Math.min(ss.length - 1, cutSegIdx())] : null; };
const candSelected = (sh, c) => !!(c && sh && sh.selId === c.vid);

/* ---------------- 声音轨（剪辑模式新增）----------------
   `projOf().voices = [{ id, shotId, candId, seg, at, dur, vol, src, name, text, provider, model, voice, fa, fb }]`
   （`fa`/`fb` = 这一句在轨道上的**框**，与画面轨同一个概念：块摆哪儿、多宽只看它，拖把手不改；
   `[at, at+dur]` 是框内的**选区** = 真进成片的那一截。老数据没有这两个键时按「框 = 选区」现算）。
   `at` 相对**这一段自己**的起点（不是整条候选，也不是整片）：段会被切开、会被裁短，
   锚在段上才能在剪完之后仍然落在原来那句话的位置 —— 这是「本镜剪了、全片跟着变」在声音上的落点。
   导出合成按 `clips[].voices = [{ src, start, dur, vol }]` 取（start 相对该段起点；
   绝对偏移由那一段的 span 决定，调用方自己加会漂）。 */
function voicesEnsure() { if (!Array.isArray(projOf().voices)) projOf().voices = []; return projOf().voices; }
const shotVoices = (shotId, candId) => voicesEnsure().filter(v => v.shotId === shotId && (!candId || v.candId === candId));
const clipVoiceKey = (shotId, candId, seg) => [shotId, candId, seg == null ? 0 : seg].join('|');
/* 这一段该带上哪几句配音，以及有几句被这一剪挤到了段外面（**不静默丢**：计数交给状态行说）。
   「放不放得下」用的是**源秒**（这一格选区的长度），不是这一段在成片里占的秒数：
   配音是跟着画面一起变速的（合成那一侧是 `at = 段起点 + start/speed`、只取 `dur` 这一截，
   span 就是源秒），拿成片秒当上界会让 2 倍速的那一段把后半句误判成「挤不出去」。
   以前这一句要靠调用方把 `tlClipDur(c)` 递进来（倍速恒为 1 时两个数相等，所以没人发现），
   现在上界只有这一处现算 —— 五个调用点都只递那一个 clip。
   这里的 `vol` 是**合成后**的那一个（这一句 × 它所在那一行的基数），六个调用点拿到的都是「进成片的音量」：
   指纹、预览、逐句导出、合成因此不会再各说一件事（乘算只有 `voiceVolOf` 一份）。
   `spd` 同一立场：这一句自己的那一档（`voiceRateOf` 一份），合成与预览都从这一处拿，不在调用点各拼一遍。 */
/* 这一句压在的那一格**画面段**现在的倍速（回执与右栏那句读数要说这一句在成片里占多久时用）。
   找法与 `voicePinLocal` 的本镜那一支、右栏「这一条上的配音」那一行完全一样：shotId → candId → 段下标。
   ⚠ 它与 `bindVoiceLane` 里那枚局部 `voiceSpdOf` 是两条路：那一枚从**正在画的那一排的行表**里取
   `r.spd`（几何尺子，找不到行就是 1，比如别的镜压进来的那一截），这一枚从**数据**里取那一段真正的速度。
   倍速全为 1 时两者相等；行表换了（换页签、换候选）而数据没换时，只有前者跟着界面走。
   候选没了 / 段被删了就按 1 —— 那时这一句本来就进不了成片，由 `voiceFilmGap` 去说原因。 */
function voicePicSpd(v) {
  const sh = allShots().find(x => x.id === (v && v.shotId));
  const c = sh ? (sh.candidates || []).find(x => x.vid === v.candId) : null;
  if (!c) return 1;
  const segs = segsOf(c, candDur(c, sh));
  if (!segs.length) return 1;
  const s = segs[Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0))];
  return Math.max(0.25, Math.min(4, Number(s && s.spd) || 1));
}
/* 这一段带哪几句配音（`at` 相对本段起点，代理那侧按 start 延迟后与原声 amix）。
   `ctx` = `{ start, gray }`（**成片秒**）：`start` 是这一段的成片起点（= 前面每一格的 tlClipDur 之和），
   `gray` 是**全片**灰场区间表 `[[F0, F0+tlClipDur), …]` —— 一句配音压在灰场上时，音频在那里跳过
   （`voiceRuns`），逐段推一条：代理与预览都按「一段一条」放，跳过的那几秒自然空着。
   不给 `ctx` 时（逐句导出那条路）逐字节与从前相同：一段、start=v.at、off=off0。 */
function clipVoices(c, ctx) {
  const list = []; let skip = 0, placed = 0;
  const seg = c.seg == null ? 0 : c.seg;
  const span = Math.max(0.1, (Number(c.out) || 0) - (Number(c.in) || 0));
  const sp = Math.max(0.25, Math.min(4, Number(c.speed) || 1));
  const F0 = ctx ? Math.max(0, Number(ctx.start) || 0) : 0;
  const gray = ctx && ctx.gray && ctx.gray.length ? ctx.gray : null;
  voicesEnsure().forEach(v => {
    if (v.shotId !== c.shotId || v.candId !== c.candId || (v.seg == null ? 0 : v.seg) !== seg) return;
    const start = Math.max(0, Number(v.at) || 0);
    if (!v.src || start >= span) { skip++; return; }
    /* `off` = 这一句在**音频文件内部**的起点（拖左把手切掉开头时写的，默认 0）。
       它与 `start` 是两件事：start 是「在画面里从第几秒开始响」，off 是「从音频的第几秒开始取」。
       合成（-ss off）、播放（currentTime = off）都读它，两边口径必须一致。 */
    const dur = Math.max(0.1, Number(v.dur) || 0);
    const off0 = Math.max(0, Number(v.off) || 0);
    const base = { src: (window.EditorMedia ? window.EditorMedia.exportSrc({ src: v.src }) : v.src), vol: voiceVolOf(v), spd: voiceRateOf(v) };
    const vr = sp * (Number(v.spd) || 1);       // 这一句在成片里一秒吃掉多少音频文件秒（代理 atempo 同一把尺子）
    const lay = gray ? voiceRuns(F0 + start / sp, dur / vr, gray) : null;
    /* `placed` 数的是**句数**（不是拼出来的截数）：拆成两截的一句仍然只算「进画面了一句」——
       外面那句 `anchored - placed - skip` 是「锚在已不存在的段上」的会计，拿截数去比
       会把「拆了两截的一句」当成两句，真正的孤儿反而被盖过去。 */
    if (!lay || !lay.skips.length) {
      /* 没有跳过（或这一条根本没有灰场）→ 与从前一字不差：一段、原样三个数。
         也正因为这里逐字节相同，指纹（voiceFp）只在真的跳过时才变。 */
      list.push(Object.assign({ start: start, dur: dur, off: off0 }, base));
      placed++;
      return;
    }
    /* 有跳过：逐段推一条。换算回**源秒**口径（代理 `at = offset + start/speed`、`dur` 是音频文件秒）
       —— 单个 run 时 `(r0-F0)·sp` 恰好等于 start、`(r1-r0)·vr` 恰好等于 dur，两条路同源。 */
    let consumed = 0;
    lay.runs.forEach(r => {
      list.push(Object.assign({
        start: (r[0] - F0) * sp, dur: Math.max(0.1, (r[1] - r[0]) * vr), off: off0 + consumed,
      }, base));
      consumed += (r[1] - r[0]) * vr;
    });
    placed++;
  });
  return { list, skip, placed };
}

/* 一次拖动的手势骨架：在 window 上收 pointermove / pointerup / **pointercancel**，
   三处（画面轨把手、全片轨把手、语音块三个手势）共用这一份 —— 各写一遍就会各漏一个。
   为什么必须收 pointercancel：拖动是横向的，而轨道现在是个**横向滚动容器**，
   触屏/触控板上的横向手势会被浏览器抢去当滚动 —— 那时只来一个 pointercancel、**pointerup 永远不来**，
   表现就是「按下去拖不动 / 拖到一半卡住」。jsdom 里没有「浏览器抢手势」这回事，
   所以探针对此一直是绿的，只有真机上才看得见。 */
/* 手里正有一次拖动（下面那三处手势都从这里过）—— 唯一判据。
   轮询每 3 秒把中栏整列重建一次，撞在拖动中途就是把手指底下那个节点换掉：
   `paintVoice` / `segsPaint` 找不到节点只能干等，表现是「拖到一半画面不动，松手才跳到位」。
   `renderMid` 问这一处，一处落地（别在各个手势里各加一句「拖完再重画」）。 */
let dragDepth = 0;
const dragBusy = () => dragDepth > 0;
function dragOnWindow(move, up) {
  dragDepth++;
  let ended = false;
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    /* 计数先减、再收尾：松手那一下的 `up()` 里就有 `filmEdited()` → `renderAll()` → `renderMid()`，
       那时若还判成「正在拖」，整栏就不重画了 —— 用户看到的是「拖完/剪完界面停在旧的那一份」。 */
    if (!ended) { ended = true; dragDepth = Math.max(0, dragDepth - 1); }
    up();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  return stop;
}

/* 一次段编辑之后把配音重新落到段上：先把旧的相对秒还原成**源视频里的绝对秒**，
   再看这个绝对时刻新落在哪一段。正好被切掉那一句不删 —— 挪到紧随其后的那段开头，
   并把「挪了几句」照实说（这与「选了却没发」是同一类偏差）。
   ⚠ 找新段时**跳过空段**（`isGap`）与**图片段 / 图片区空段**（虚拟坐标，不是源秒）：
     它们的 `in/out` 不在源秒上，落在它们区间里的配音会命中一格没有「源里第几秒」可念的段。
     跳过的只是 `gap` 与虚拟段，**不是**所有 `off` ——「删掉画面」的黑场今天就允许配音留在原地
     （成片里被跳过），那件事归联动开关管。 */
function reanchorVoices(sh, c, oldSegs, newSegs) {
  const anchorable = s => !!s && !isGap(s) && !isVirtualSeg(s);
  let moved = 0;
  shotVoices(sh.id, c.vid).forEach(v => {
    const os = oldSegs[Math.min(oldSegs.length - 1, Math.max(0, Number(v.seg) || 0))];
    if (!os) return;
    const fr = voiceFrameOf(v), at0 = Math.max(0, Number(v.at) || 0);
    const abs = os.in + at0;
    if (!newSegs.length) { v.seg = 0; v.at = 0; moved++; }
    else {
      let ni = newSegs.findIndex(s => anchorable(s) && abs >= s.in && abs < s.out);
      if (ni < 0) {
        ni = newSegs.findIndex(s => anchorable(s) && s.in > abs);
        /* 后面没有视频段了就落到**最后一段视频**（不是最后一段：最后一段可能是图片）。 */
        if (ni < 0) {
          for (let k = newSegs.length - 1; k >= 0; k--) if (anchorable(newSegs[k])) { ni = k; break; }
        }
        v.at = 0; moved++;
      } else v.at = round1(Math.max(0, abs - newSegs[ni].in));
      v.seg = ni < 0 ? 0 : ni;
    }
    /* 框与选区**一起**平移：画面剪一刀改的是「这一段从源里第几秒开始算」，
       不是「用户把音频的哪一截切掉了」—— 框（把手往外拖的上限）必须原样跟着走。
       （只挪 at 不挪 fa 的话，画面剪一下就把配音的剪辑痕迹抹平了。） */
    const d = (Number(v.at) || 0) - at0;
    v.fa = round1(fr.fa + d); v.fb = round1(fr.fb + d);
  });
  return moved;
}
/* 四把剪子都只改「这一条候选的段列表」，不碰别的东西 —— 本镜与全片读的是同一份。
   返回 `{ segs, at }`（at = 剪完之后指针该落在第几段）或 `{ err }`（当场把原因说清，不剪）。 */
function cutSegs(c, total, at, way) {
  const segs = segsOf(c, total);
  if (!segs.length) return { err: '这一条候选现在一段画面都没有：先在「全片」里换一条候选，或按 Ctrl+Z 退回剪切之前' };
  let i = segs.findIndex(s => at >= s.in && at < s.out);
  if (i < 0) i = segs.reduce((b, s, k) => (Math.abs(s.in - at) < Math.abs(segs[b].in - at) ? k : b), 0);
  const s = segs[i];
  /* 剪一刀要把这一段**自己身上**的四件事一起带走（音量 / 倍速 / 第几行 / 黑场旗标）——
     搬法只有 `segCarry` 一处，见它上面那段「以前每处各漏一两件」。 */
  const keep = o => segCarry(s, o);
  /* 图片段与图片区里的空段：只有时长、没有「源里的入出点」，剪法按下面三支各走一条。 */
  const virt = isVirtualSeg(s);
  if (way === 'split') {
    if (at - s.in < SEG_MIN || s.out - at < SEG_MIN) return { err: '插针离这一段的边界不到 0.2 秒，切不开（往中间挪一点再切）' };
    /* 虚拟段切开的右半段要**换一份新的虚拟坐标**（原来的 a/b 还在左半段手里）：
       两半仍然各占自己的时长，数组顺序决定谁在前，坐标只负责让插针有唯一答案。 */
    if (virt) {
      const tail = isImageSeg(s)
        ? imageTailSeg(s, at, segs, total)
        : makeGapSeg(imageVirtualBase(segs, total), s.out - at);
      if (!isImageSeg(s) && s.ln) tail.ln = s.ln;
      segs.splice(i, 1, keep({ in: s.in, out: at, a: s.a, b: at }), tail);
      return { segs, at: Math.min(segs.length - 1, i + 1), pinAt: tail.a };
    }
    /* 切开 = 把这一段的**框**按切点分成两个框，两段的选区各占一半 ——
       于是切开之后拖任一段的把手都不影响另一段（它们各在自己的框里）。 */
    segs.splice(i, 1, keep({ in: s.in, out: at, a: s.a, b: at }), keep({ in: at, out: s.out, a: at, b: s.b }));
    return { segs, at: Math.min(segs.length - 1, i + 1) };
  }
  if (way === 'left') {
    if (s.out - at < SEG_MIN) return { err: '插针后面剩不到 0.2 秒 —— 整段不要就点「删掉这一段」' };
    /* 虚拟段没有「框内灰区」可留（图 / 空段没有源画面可露）：左剪 = 起点后移、时长缩短。 */
    if (virt) { segs[i] = keep({ in: at, out: s.out, a: at, b: s.b }); return { segs, at: i }; }
    /* 向左切 = 把这一段的头切掉：选区左沿挪到插针处（夹在框里），**框一个字都不动** ——
       所以轨道上这一格的左边界、宽度，以及别的段的切片，全都不变，只是框内左边多一块灰。 */
    segs[i] = keep({ in: Math.max(s.a, round1(at)), out: s.out, a: s.a, b: s.b });
    return { segs, at: i };
  }
  if (way === 'right') {
    if (at - s.in < SEG_MIN) return { err: '插针前面不到 0.2 秒 —— 整段不要就点「删掉这一段」' };
    if (virt) { segs[i] = keep({ in: s.in, out: at, a: s.a, b: at }); return { segs, at: i }; }
    segs[i] = keep({ in: s.in, out: Math.min(s.b, round1(at)), a: s.a, b: s.b });
    return { segs, at: i };
  }
  if (way === 'drop') {
    /* 删掉一段画面 = **留在原位变灰**（成片里出黑场），不是从段列表里摘掉：
       这一段的框、选区、时长一格都不动，后面那些段不前移，锚在它们上面的配音也就不会被无声挪走
       —— 用户点名的「视频片段不消失而是变灰…以确保时间统一」就落在这里。
       对着已经灰掉的那一段再点一次就是把它放回来（同一颗按钮，按状态改口，见 syncTlTools）。
       ⚠ 空段不走这条路：它是「插进来的一段空」，用「摘掉空段」整段去掉，
       不许被当成有画面的段来「恢复」（空段本来就没有画面可恢复）。 */
    if (isGap(s)) return { err: '这是空段，用「摘掉空段」把它去掉' };
    if (s.off) { const o = Object.assign({}, s); delete o.off; segs[i] = o; return { segs, at: i, back: true }; }
    segs[i] = Object.assign({}, s, { off: 1 });
    return { segs, at: i, gray: 1 };
  }
  /* 插一段空（`gap`）：轨道上多一格灰格，成片里那几秒是黑的、**占时间**（多出来的，不是从别处挪的）。
     与 `drop` 的区别见上：`drop` 是「这一格不要画面」（原段不动），`gap` 是「多插一段空」。
     插针落在段边界 → 段数 +1；落在段中间 → 先按插针切开原段再插空 → 段数 +2。
     插针落在框内灰头/灰尾（那里本来就没画面）→ 按最近的选区边界插入，不切选区。 */
  if (way === 'gap') {
    /* 图片区里没有「视频源秒」：空段接在这一格**后面**，用新的虚拟坐标（占 1 秒，黑场）。
       插针也要跟着落到它上面（`pinAt`）：留在图片上，下一次「摘掉空段」问的是图片那一格，
       而图片不是空段 —— 刚插进来的东西当场就够不着了。 */
    if (virt) {
      const g = makeGapSeg(imageVirtualBase(segs, total), 1);
      segs.splice(i + 1, 0, g);
      return { segs, at: i + 1, gapLen: 1, pinAt: g.a };
    }
    const T = Math.max(0.1, Number(total) || 0);
    const pos = round1(Math.max(0, Math.min(T, at)));
    let len = 1;
    if (T - pos < SEG_MIN) return { err: '插针太靠尾，这里剩下不到 0.2 秒，往左挪一点再插空' };
    len = round1(Math.min(len, T - pos));
    if (len < SEG_MIN) return { err: '剩下的空间不到 0.2 秒，插不进一段空（往左挪一点再插）' };
    const gapSeg = { in: pos, out: round1(pos + len), a: pos, b: round1(pos + len), off: 1, gap: 1 };
    const atIn = Math.abs(pos - s.in) < 0.001;
    const atOut = Math.abs(pos - s.out) < 0.001;
    if (atIn || atOut) {
      segs.splice(atIn ? i : i + 1, 0, gapSeg);
      return { segs, at: atIn ? i : i + 1, gapLen: len };
    }
    if (pos > s.in + 0.001 && pos < s.out - 0.001) {
      segs.splice(i, 1, keep({ in: s.in, out: pos, a: s.a, b: pos }), gapSeg, keep({ in: pos, out: s.out, a: pos, b: s.b }));
      return { segs, at: i + 1, gapLen: len, splitForGap: 1 };
    }
    /* 框内灰头 / 灰尾：按最近的选区边界插，不切选区（再切只会多出一段 0.2 秒的碎片）。 */
    const near = Math.abs(pos - s.in) <= Math.abs(pos - s.out) ? i : i + 1;
    segs.splice(near, 0, gapSeg);
    return { segs, at: near, gapLen: len };
  }
  /* 摘掉空段（`close`）：只接受 `off && gap` 的段，整段 splice 掉 →
     后面的段前移、成片里那几秒消失。「删掉画面」的黑场（`off && !gap`）不许走这条路。 */
  if (way === 'close') {
    if (!isGap(s)) return { err: s.off ? '这一段是「删掉画面」的黑场，不是空段：要恢复画面点「删掉」，要缩短请用把手' : '这一段有画面，不是空段' };
    segs.splice(i, 1);
    return { segs, at: Math.max(0, Math.min(segs.length - 1, i)), closed: 1 };
  }
  /* 融合：把插针这一段与它**右边**挨着的那一段合回一段（右边不行再试左边）。
     判据是「本来就是一刀切开、之后没再动过」—— 两段的**框**挨着（x.b === y.a）、
     且**选区**也接得上（x.out === y.in）。合成一段后框与选区都是并集，
     于是留下的东西与切开之前一模一样（这正是用户要的「再融合」）。
     ⚠ 中间被剪掉过一截的两段不许融：一段只有一个框、一个选区，接不上的话
       并集会把用户故意切掉的那一截**悄悄加回来**（静默改动画面 = 最坏的一种）。
     ⚠ 空段不许融：空段没有画面，融进有画面的段等于把一段空悄悄塞进画面里。 */
  if (way === 'merge') {
    if (segs.length === 1) return { err: '这一条只有一段，没有可融合的相邻段' };
    const near = (a, b) => Math.abs(a - b) < 0.011;      // round1 过后同一秒可能差 1 个末位
    for (const p of [[i, i + 1], [i - 1, i]]) {
      const x = segs[p[0]], y = segs[p[1]];
      if (!x || !y) continue;
      if (isGap(x) || isGap(y)) return { err: '空段不能融合：先摘掉它，再融两边' };
      /* 两张静态图各占自己的时长，没有「一刀切开的两半」这回事：融合后只剩一张图与一段并集时长，
         另一张就从成片里消失了 —— 静默丢画面，与「把剪掉的那一截加回来」同一类。 */
      if (isImageSeg(x) || isImageSeg(y)) return { err: '图片段不合并：静态图各自一段，没有「一刀切开的两半」这回事' };
      if (!near(x.b, y.a) || !near(x.out, y.in)) continue;
      /* 音量不一样就不许融：一段只有一个音量，硬合就得替用户挑一个（或取平均），
         而那是**悄悄改声音** —— 与「把切掉的那一截加回来」同一类。当场说清、让人先调成一样。 */
      if (segVol(x) !== segVol(y)) {
        return { err: '这两段的音量不一样（' + Math.round(segVol(x) * 100) + '% / ' + Math.round(segVol(y) * 100)
          + '%），先调成一样再融合' };
      }
      /* 黑场与有画面的两段不许融：融合后一段只有一个画面旗标，硬合就等于替用户决定
         「这一整块要么全黑、要么全有画面」—— 与「把切掉的那一截悄悄加回来」同一类静默改动。 */
      if (!!x.off !== !!y.off) return { err: '这两段一个有画面、一个是黑场，先点「恢复这一段画面」把黑场变回来再融合' };
      /* 倍速不一样不许融：一段只有一个倍速，硬合就得替用户挑一个 —— 那是**悄悄改这一格在成片里占几秒**，
         与音量同一类。合成后那一段的秒数会变，而界面上没有任何一处说过「融合还会改时长」。 */
      if (segSpd(x) !== segSpd(y)) {
        return { err: '这两段的倍速不一样（' + spdTxt(segSpd(x)) + ' / ' + spdTxt(segSpd(y)) + '），先调成一样再融合' };
      }
      /* 不在同一行不许融：合完只有一行装得下，另一行上那一格等于被无声搬走了（行级音量也跟着换了一份基数）。 */
      if (picLnOf(x) !== picLnOf(y)) {
        return { err: '这两段不在同一行（第 ' + (picLnOf(x) + 1) + ' 行 / 第 ' + (picLnOf(y) + 1) + ' 行），把其中一段拖到同一行再融合' };
      }
      segs.splice(p[0], 2, keep({ in: x.in, out: y.out, a: x.a, b: y.b }));
      return { segs, at: p[0], fused: 2 };
    }
    return { err: '这两段中间被剪掉过一截（不是单纯切开的两半），融不回一段：按 Ctrl+Z 退回到剪那一刀之前，或直接用把手把入出点拖回去' };
  }
  return { err: '不认识这种剪法' };
}
/* 插针在哪个秒：播放器一直在放**焦点那条候选**，所以本镜与全片两个页签指的是同一个位置
   （不存在「全片里另有一根针」这第二份口径）。重画之后播放器还没就位时读上次记下的那一个。 */
function cutPin(c, total) {
  const pl = document.getElementById('player');
  /* 播放器刚建出来时 `currentTime` 是个合法的 0（`isFinite(Number(0))` 恒真），
     以前这里等于永远读播放器，`projOf().cutAt` 的回退一次都轮不到 —— 一进剪辑针就停在 0。
     只认「已经读到元数据、且真的播过/跳过一个非零位置」的那一份。 */
  /* 夹到这一条的**整把尺子**（视频的 [0,total] 之后还有图片段 / 图片区空段的虚拟秒）：
     拿 `total` 去夹会把落在图片段上的针推回视频末尾，下一次「切开」就切在别处。 */
  const max = segsPan(c, total);
  const saved = round1(Math.max(0, Math.min(max, Number(projOf().cutAt) || 0)));
  /* 播放器只认视频的源秒：针落在图片段的虚拟秒上时 `currentTime` 根本到不了那儿，
     读它就是拿一个旧位置去剪图片（点图片、切开 = 切在视频里的某处）。这一支优先读记下的那个。 */
  if (saved > total + 0.05) return saved;
  const t = (pl && pl.readyState >= 1 && Number(pl.currentTime) > 0)
    ? Number(pl.currentTime) : saved;
  return round1(Math.max(0, Math.min(max, t)));
}
/* 一次剪切的唯一出口：算新段 → 写候选 → 配音重新锚定 → 重画 → 一句话说清进不进成片。
   两颗入口（本镜页签、全片页签）都调它，所以「在 A 处剪了 B 处也要变」不是同步逻辑，是根本没有第二份数据。 */
function applyCut(way) {
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先挑一个镜头</span>'); return; }
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  if (!c) { setStatus('<span class="err">这一镜还没有候选，先生成或导入一条视频再剪</span>'); return; }
  const total = candDur(c, sh);
  const oldSegs = segsOf(c, total);
  const at = cutPin(c, total);
  const r = cutSegs(c, total, at, way);
  if (r.err) { setStatus('<span class="err">' + r.err + '</span>'); return; }
  const newSegs = segsWrite(c, total, r.segs);
  projOf().cutSeg = Math.max(0, Math.min(newSegs.length - 1, Number(r.at) || 0));
  /* 虚拟段把针一起带走（`pinAt`）：插入的图片区空段落在虚拟坐标的另一头，
     针留在原地的话，下一次「摘掉空段」指着的是图片那一格。 */
  projOf().cutAt = r.pinAt != null ? round1(r.pinAt) : at;
  const moved = reanchorVoices(sh, c, oldSegs, newSegs);
  /* 联动：这次操作让某一段从「有画面」变成 `off:1`（`drop` 的 `gray`）时，
     被勾选的那几类挪到下一段还有画面的段。`gap` 是新插的空段（插在段中时左右两半各自保留原配音，
     不需要挪）；`close` 段被摘掉，`reanchorVoices` 已经按绝对源秒重锚，不再二次挪。 */
  let relinkNote = '';
  if (r.gray) {
    const links = linksOf(projOf());
    if (links.length) {
      const seg = Number(r.at) || 0;
      const lnOld = oldSegs[seg], lnNew = newSegs[seg];
      if (lnOld && lnNew && !lnOld.off && lnNew.off) {
        const vs = shotVoices(sh.id, c.vid);
        const lp = linePointOf(sh, newSegs);
        const tg = relinkTargets({ segs: newSegs, voices: vs, linePoint: lp, links, seg });
        let vmoved = 0;
        tg.voices.forEach(x => {
          const d = (Number(x.v.at) || 0);
          x.v.seg = x.toSeg; x.v.at = 0;
          const fr = voiceFrameOf(x.v);
          x.v.fa = round1(fr.fa - d); x.v.fb = round1(fr.fb - d);
          vmoved++;
        });
        if (tg.line) linePointSet(sh, tg.line.toSeg, tg.line.toAt, newSegs);
        if (vmoved || tg.line) {
          relinkNote = '；联动：' + (vmoved ? '挪了 ' + vmoved + ' 句配音' : '')
            + (vmoved && tg.line ? '、' : '')
            + (tg.line ? '台词落点挪到第 ' + (tg.line.toSeg + 1) + ' 段开头' : '');
        }
      }
    }
  }
  const left = round1(segsFilmLen(c, total));
  /* 「删掉」现在不删段：段还留在原位，只是打上黑场旗标（时长与后面的段一个都不动 ——
     这正是用户要的「时间统一」）。所以这句回执不能说「删掉了」，得说清「成片里出黑、后面的段不前移」，
     并报出压在这一格上的配音句数（它们会跟着变色，但不会被人以为被删了）。 */
  const grayIdx = Number(r.at) || 0;
  const underGray = r.gray ? shotVoices(sh.id, c.vid).filter(v => (Number(v.seg) || 0) === grayIdx).length : 0;
  const what = way === 'split' ? '已在 ' + fmtDur(at) + ' 处切开'
    : way === 'left' ? '已把插针左边切掉'
    : way === 'right' ? '已把插针右边切掉'
    : way === 'drop' ? (r.back ? '已把这一段画面放回来'
      : '这一段画面删掉了（格子还在原位，成片里出 ' + fmtDur(round1((newSegs[grayIdx] || {}).out || 0) - round1((newSegs[grayIdx] || {}).in || 0)) + ' 黑场，后面的段一个都不前移'
        + (underGray ? '；压在这上面的 ' + underGray + ' 句配音照放，音轨上那几截已变色' : '') + '）')
    : way === 'merge' ? '已把这两段融合回一段'
    : way === 'gap' ? ('插了 ' + fmtDur(r.gapLen || 1) + ' 空' + (r.splitForGap ? '（原段已按插针切开）' : ''))
    : way === 'close' ? '已把这段空摘掉（成片里那几秒消失，后面的段前移）'
    : '已取消裁剪';
  const inFilm = candSelected(sh, c);
  setStatus((inFilm ? '<span class="ok">✓ ' : '')
    + what + '：这一条现在 ' + newSegs.length + ' 段、共 ' + fmtDur(left)
    + (inFilm ? '，左栏时长与全片跟着变' : '，但这一条还没被选用，成片仍按选用的那条算')
    + (moved ? '；有 ' + moved + ' 句配音正好被切掉，已挪到紧随其后的那段开头' : '')
    + relinkNote
    + (inFilm ? '</span>' : ''));
  filmEdited();
}
/* 把一张图片放进画面轨（拖素材到画面轨 / 图片产物上「加到时间线」的唯一落点）。
   图片段与视频段同一份 `c.segs`：本镜 / 全片两排、播放、导出、FCPXML 读的都是它。
   落点 = 传进来的那一秒（拖放处）或插针所在处；插在接住这一秒的那一格**之后**。
   插入会让后面每一段的下标整体后移，所以配音要按**源秒**重锚、台词落点要跟着平移 ——
   少做一件，插一张图就把台词与配音挪到下一段去了。 */
function addImageToTrack(spec) {
  const src = String((spec && spec.src) || '').trim();
  if (!src) { setStatus('<span class="err">这张图没有可用的素材地址，放不进轨道</span>'); return null; }
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先挑一个镜头，再把图片放进它的画面轨</span>'); return null; }
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  if (!c) { setStatus('<span class="err">这一镜还没有候选：图片段挂在候选自己的段列表上，先生成或导入一条视频</span>'); return null; }
  const total = candDur(c, sh);
  const oldSegs = segsOf(c, total);
  const at = spec && isFinite(Number(spec.at)) ? Number(spec.at) : cutPin(c, total);
  let index = oldSegs.length;
  for (let k = 0; k < oldSegs.length; k++) if (at < oldSegs[k].b) { index = k + 1; break; }
  const lp = oldSegs.length ? linePointOf(sh, oldSegs) : null;
  beginEdit('插入图片');
  const placed = placeImageSeg(oldSegs, total, { src: src, name: spec && spec.name, dur: spec && spec.dur, index: index });
  const newSegs = segsWrite(c, total, placed.segs);
  reanchorVoices(sh, c, oldSegs, newSegs);
  if (lp && sh.lineAt != null && lp.seg >= placed.index) linePointSet(sh, lp.seg + 1, lp.at, newSegs);
  projOf().cutSeg = placed.index;
  projOf().cutAt = round1(placed.seg.a);
  setStatus('<span class="ok">✓ 已把「' + escHTML(String((spec && spec.name) || '图片')) + '」插到第 '
    + (placed.index + 1) + ' 格（' + round1(placed.seg.b - placed.seg.a)
    + ' 秒；拖这一格的右把手改时长，静态图没有原声也没有倍速）</span>');
  filmEdited();
  return placed;
}
/* ============================================================================
   统一剪辑条 —— 画面段与配音句共用这一排按钮
   ----------------------------------------------------------------------------
   以前声音那一份是另一根条（挂在音轨行下面、点中一句才出现，按钮叫 `data-vop`），于是
   同一件事在两处两种做法：那一排剪子只对画面齐、音量有三个出口（±10% 两颗、块底拖动一条、
   条上读数一个）。用户点名的「两者功能一致使用统一的剪辑按钮」就收在这里。

   这一排只有**一个目标**（`tlCutTarget()`）：点过配音块就指那一句，点过画面格（含放插针）就指画面那一段。
   那五把「动某一段」的剪子（切开 / 向左 / 向右 / 删掉 / 融合）语义两边逐条对齐，差别只由数据形状本身决定：
     · 画面切「一段候选里的某一段」，声音切「一句配音」，切开都是新建一份；
     · 时间基不同：两排都按**轴秒**摊，只是尺子各量各的（本镜 = 这一条候选的框 ÷ 各段倍速，
       全片 = 成片秒）—— 从插针回到 `v.at` 那把尺子的换算只在 `voicePinLocal` 一处。
   音量也只有这一个出口（0–200%、步进 0.1 的滑块，挂在右栏那张「这一段 / 这一句」的卡上，
   与倍速并排）：块底那条可拖的横条已删，
   它把鼠标扫过音轨就变成 `ns-resize` 的「调整」光标，而那块地方本来是「挪位置 / 试听」。
   ========================================================================== */
const tlVoiceSel = () => voicesEnsure().find(x => x.id === projOf().curVoice) || null;
/* 目标由**最后点的是哪一轨**决定（`proj.tlLane`），不是「只要还选中着一句配音就一直指配音」。
   以前那一版让「点了一格画面、把滑块推下去」调的是上一句配音，「删掉」删的也是配音 ——
   用户点名的两条（视频音量调不动、优先删语音）都出自这一行。
   配音那一侧还要多问一句「它真的还在」（删掉的、换镜丢下的都算没有），否则芯片指着空气。 */
const tlCutTarget = () => (projOf().tlLane === 'voice' && tlVoiceSel() ? 'voice' : 'pic');
/* 按目标读回来的那一句配音（目标不是配音时一律 null —— 所有「改东西」的入口只问它，别问 tlVoiceSel） */
const tlVoiceHit = () => (tlCutTarget() === 'voice' ? tlVoiceSel() : null);
/* 「这一句此刻算不算被点中」也只有一份：目标轨是配音、而且就是当前那一句。
   从前画高亮只看 `projOf().curVoice` —— 点一格画面之后目标已经交回画面轨（剪子与滑块改的是那一段），
   配音那一排却还留着一圈亮环，界面说的还是「指着这一句」（用户点名的「不被选中时不应该高亮」）。
   `projOf().curVoice` 仍然留着：那是「回来接着改哪一句」的记号，不是「现在亮着哪一句」。 */
const voiceSelId = () => (tlCutTarget() === 'voice' ? projOf().curVoice : '');
/* 画面那一侧的同一件事：`proj.cutSeg` 是「剪子指着第几段」（音量 / 倍速 / 入出点都写它），
   而「哪一格画着亮环」是另一件事 —— 目标换成配音那一下，上面那一格的白环必须当场掉，
   否则两条轨同时亮，用户看不出剪子究竟在哪一轨（与上面配音那一侧是同一个缺陷的另一半）。
   所以这里也只读目标，不读 `projOf().cutSeg` 本身。判据仍然只有一份 `tlCutTarget`。 */
const picSelOn = () => tlCutTarget() === 'pic';
const picSelAt = (n) => (picSelOn() && n > 0) ? Math.min(n - 1, cutSegIdx()) : -1;
/* 右栏那一张卡此刻该显示**哪一轨**的功能（用户点名的第 ②③④ 条：点画面格开倍速那一族、点配音块开
   声音那一族、点空白轨道开「生成配音」）。它与 `tlCutTarget` 只差一件事：什么也没点过时照旧开配音那一侧
   （这一栏本来就是「剪辑 = 调这一条 + 加一句配音」，没点过画面轨就不要一上来把那块藏掉）。
   这里只读目标与用户的手指点在哪一轨，不写第二份「指着谁」（剪子仍只认 tlVoiceHit）。 */
function tlPanel() {
  if (tlCutTarget() === 'voice') return 'voice';
  /* 用户**点过一格画面**就是画面那一侧 —— 这一条得排在「这条候选一句配音都没有」之前（第 ② 条）：
     一个数都没有时照样有倍速、入出点、行音量可调，把它们藏掉等于点了画面格却只见「生成配音」。
     旧口径在这里多一道 `shotVoices()` 闸（没有配音就永远开配音那一侧），第 ② 条在最常见的那一镜上
     必然落空；「加上第一句配音」的出路改由落点给 —— 点空白轨道（`bindPinZone` 第三档）就是配音那一侧。 */
  if (projOf().tlLane === 'pic') return 'pic';
  return 'voice';
}
/* 焦点候选：先看页签上当前那一条，再退回被选用的那一条（与 applyCut 同一取法） */
function cutCand() {
  const sh = curShot();
  if (!sh) return null;
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  return c ? { sh: sh, c: c, total: candDur(c, sh) } : null;
}
/* 「剪刀此刻指着第几格 / 第几段」的唯一口径：条上那颗芯片与下面那句读数都问它（以前两处各数一遍，
   全片那一排明明有 4 格却同时能写出「第 1/1 段」—— 用户点名的第 6 条）。
   两个页签数的东西本来就不是同一族：
     · 本镜 = 这一条候选自己剪成的**段**（第 i/n 段）；
     · 全片 = 焦点那一格在**整排**里的位置（第 k/K 格），段号只作为副语（这一镜的第 i/n 段）。
   返回 { film, f, segs, i, seg, row, k, rows, tl, G, chip, sub }：算不出来的一律给保守值（不给假数）。 */
function tlFocusPos() {
  const f = cutCand();
  const segs = f ? segsOf(f.c, f.total) : [];
  const i = segs.length ? Math.min(segs.length - 1, cutSegIdx()) : -1;
  const o = { film: isFilmMode(), f: f, segs: segs, i: i, seg: i >= 0 ? segs[i] : null,
    row: null, k: -1, rows: 0, tl: null, G: null };
  if (!o.film) {
    o.chip = i >= 0 ? '第 ' + (i + 1) + '/' + segs.length + ' 段' : '没有画面段';
    o.sub = '';
    return o;
  }
  o.tl = tlSyncFromShots();
  o.G = filmFrames(o.tl);
  o.rows = o.G.rows.length;
  if (f && i >= 0) {
    o.row = o.G.rows.find(x => x.cl.kind === 'shot' && x.cl.shotId === f.sh.id
      && x.cl.candId === f.c.vid && Number(x.cl.seg || 0) === i) || null;
    if (o.row) o.k = o.row.k;
  }
  o.chip = o.k >= 0 ? '第 ' + (o.k + 1) + '/' + o.rows + ' 格' : '不在全片那一排';
  /* 副语只在这一镜真的被剪成几段时才说 —— 每一镜一段是最常见的形状，那句「第 1/1 段」是噪声 */
  o.sub = i >= 0 && segs.length > 1 ? '（这一镜第 ' + (i + 1) + '/' + segs.length + ' 段）' : '';
  return o;
}
/* 两条轨各自的「显 / 锁」（两颗小图标在轨道名旁边；音量不在这里 —— 它是**按行**的，见下面的 laneVol）：
     · 锁 = 这一轨不许拖、不许剪、不许调音量 —— 把手不画、手势当场拒并说明原因；
     · 显 = 关掉就把这一轨收成一条窄条（内容不画），长片子上腾出看另一轨的地方。
   两个都是**真拦 / 真收**，不是装饰：判据只有这里的 `laneState` 一份，
   渲染与手势都问它（自己拼 `projOf().lane.x.lock` 的地方迟早有一处忘了问，锁就成了假锁）。
   存进工程（`projOf().lane`）：它是「这一条片子怎么摆」的一部分，换镜头要跟着走。 */
function laneState(k) {
  const o = (projOf() && projOf().lane && projOf().lane[k]) || {};
  return { hide: !!o.hide, lock: !!o.lock };
}
const laneLocked = k => laneState(k).lock;
const laneHidden = k => laneState(k).hide;
/* ============================================================================
   上面那两颗管的是**整条轨**；这一组管的是**其中一行**
   ----------------------------------------------------------------------------
   用户点名的「添加出来的画面 / 配音轨道也要有收起、锁定、添加、音量」—— 四件事里
   添加与音量本来就有落点（`addLaneRow` / `laneVol`），缺的是单行的显与锁。
   **第 1 行不另设一套**：它就是这条轨的锚行，它的显 / 锁 = 轨名旁那两颗（`laneState`），
   所以 `ln<=0` 一律回退到轨级 —— 否则「锁了整条轨」与「锁了第 1 行」会算成两个数，
   左列两把锁各说各话，而 ⑰f/⑰g 那几档量的正是「按轨名那颗下去管的是整条轨」。
   存法与 `vols` / `rows` 同一记账：**只有非默认才占键**（`projOf().lane[k].hides[ln]` / `.locks[ln]`），
   没收过、没锁过的行在数据里根本不存在，旧工程读回来一个字节都不用迁。
   整条轨那一档永远压得住单行（锁了轨 = 每一行都锁），反过来不成立：锁第 3 行不牵连
   第 1、2 行，也不牵连另一轨 —— 与「锁不牵连」那几条判据同一立场。
   ========================================================================== */
const rowFlag = (k, ln, what) => {
  if (ln <= 0) return false;
  const o = projOf() && projOf().lane && projOf().lane[k];
  const m = o && o[what];
  return !!(m && m[laneClamp(ln)]);
};
const rowHidden = (k, ln) => (ln <= 0 ? laneHidden(k) : (laneHidden(k) || rowFlag(k, ln, 'hides')));
const rowLocked = (k, ln) => (ln <= 0 ? laneLocked(k) : (laneLocked(k) || rowFlag(k, ln, 'locks')));
/* 两条轨的名字只在这里点一次名。以前「声音轨 / 配音轨」两种写法在同一个文件里各漂一半
   （左栏轨名、右栏标签、回执、title 四处各写各的），而「音轨」这个词在本页留给视频自己带的那条声音。 */
const laneNm = k => (k === 'voice' ? '配音轨' : '画面轨');
const rowNm = (k, ln) => laneNm(k) + '第 ' + (laneClamp(ln) + 1) + ' 行';
/* 「这一行现在为什么动不了」的一句话原因（空串 = 能）。锁的三处落地（把手不画 / 按钮压暗 /
   函数入口硬拒）与右栏那两枚滑块都问它，别在调用点各拼一句 —— 拼出来的措辞一漂，
   界面就在说一件数据层没做的事（整条轨锁着时说「第 N 行的锁」就是那种假话）。 */
function rowLockWhy(k, ln) {
  if (!rowLocked(k, ln)) return '';
  /* 整条轨那一句**逐字保持原样**（`配音轨已锁定` / `画面轨已锁定`）：调用点在它后面拼的
     「：这一刀不接。」+ `tlUnlockHow()` 与 ⑯b/⑰f 那几档判据读的都是这一串；
     行级才补上行号与「只这一行」，否则锁第 3 行会说成整条轨都锁了。 */
  if (laneLocked(k)) return laneNm(k) + '已锁定';
  return rowNm(k, ln) + '已锁定（只这一行，别的行照旧能拖能剪）';
}
/* 「去哪儿解锁」跟着上面那句的原因一起换：整条轨锁着指着轨名旁那颗，只锁了这一行就指着
   这一行标签上那颗。两处各写一遍「点轨名栏上那颗锁」就会出现「按钮亮着、点下去被拒，
   而拒的那句话指着一颗根本改不了这件事的按钮」。 */
function rowUnlockHow(k, ln) {
  return laneLocked(k) ? '点轨名栏上那颗锁解锁' : '点' + rowNm(k, ln) + '标签上那颗锁解锁';
}
/* 「这一行的基数音量为什么调不了」只在这一处拼。函数入口那道硬拒与右栏那枚滑块的 title 以前
   各写一遍 `rowNm + '已锁定：这一行的基数音量不调。'`，于是**整条轨锁着时界面说的是「画面轨第 1 行已锁定」**，
   而行标签上那颗锁明明亮着 —— 点它只管这一行，解不开整条轨的锁；指出去的出路是错的。
   措辞跟着 `laneLocked` 分两岔，`rowUnlockHow` 已经分过，这里只是把「不调」那一句接到同一份判据上。 */
function laneVolWhy(k, ln) {
  if (!rowLocked(k, ln)) return '';
  return (laneLocked(k)
    ? '整条' + laneNm(k) + '已锁定：这一行的基数音量不调（锁的是这条轨，不是单独这一行）。'
    : rowNm(k, ln) + '已锁定：这一行的基数音量不调。')
    + rowUnlockHow(k, ln) + '。';
}
/* 现在指着的那一轨（哪一行）为什么动不了 + 去哪儿解锁。闸与出口仍只有 `tlLockWhy` 一份，
   这里只是把「指着一行」那一句交出去，调用点不要自己拼行号。 */
function tlUnlockHow() {
  const t = cutLaneOf();
  const k = t ? t.k : (tlCutTarget() === 'voice' ? 'voice' : 'pic');
  return rowUnlockHow(k, t ? t.ln : 0);
}
function rowFlagToggle(k, ln, what, col) {
  const ln2 = laneClamp(ln);
  if (ln2 <= 0) { toolRefuse(rowNm(k, 0) + '是这条轨的锚行：它的收起与锁定就是轨名旁那两颗按钮，按它们就行。'); return; }
  projOf().lane = projOf().lane || {};
  const o = projOf().lane[k] = projOf().lane[k] || {};
  const m = o[what] = o[what] || {};
  const on = !m[ln2];
  if (on) m[ln2] = true; else delete m[ln2];
  if (!Object.keys(m).length) delete o[what];
  setStatus('<span class="ok">✓ ' + rowNm(k, ln2) + (what === 'locks'
    ? (on ? '已锁定：这一行上的块拖不动、剪不了，这一行的音量也不调（别的行与另一轨不受影响；解锁就点这一行标签上那颗锁）' : '已解锁')
    : (on ? '已收起（只剩这一行标签自己，块与把手都不画，再点一下眼睛展开）' : '已展开')) + '</span>');
  renderAll();
  scheduleSave();
}
/* 一条轨上第 ln 行的基数（默认 1，**只有 ≠1 才占一个键**，与段上的 vol/spd 同一记账）。
   它与片段音量是**乘算**不是覆盖 —— 「这一行压到 60%」之后某一格单独调到 100%，进成片仍是 60%，
   而那一格被调到 50% 时是 30%。两级各有出口，乘算只有下面 `picVolOf` / `voiceVolOf` 两处。
   夹回 0–200% 也只做这一处：`TlPlay.setPlan`、`filmFingerprint`、合成拿到的必须是同一个数，
   夹在下游就会出现「指纹说变了、听着没变」与反过来的那种。
   ⚠ 行数可以有很多行（用户点名的「配音 / 视频都要无限多条轨道」），所以基数是**按行**记的，
   不是按整轨记的：只有一行时两者本来就是同一件事，多行时「整轨调音量」会把人刚调好的那一行盖掉。 */
const laneVol = (k, ln) => {
  const o = projOf() && projOf().lane && projOf().lane[k];
  const v = o && o.vols ? o.vols[Math.max(0, Math.round(Number(ln) || 0))] : undefined;
  return v == null || !isFinite(Number(v)) ? 1 : Math.max(0, Math.min(2, Number(v)));
};
const clampVol = x => Math.max(0, Math.min(2, Number(x) || 0));
/* 这一排要画几行 = **画得出来的东西里最高那一行 + 1**，至少一行（两条轨共用这一个判据）。
   空着的中间行照样画：抽掉空行会把它上面那一行整体往下塌一格，而那一格正是插针与刻度尺对齐的地方。 */
const laneRowsOf = items => (Array.isArray(items) ? items : [])
  .reduce((a, x) => Math.max(a, laneClamp(x && x.ln) + 1), 1);
/* 一条轨**至少**画几行（用户点名的「现在怎么添加新轨道」）。
   从前行数只由内容推出来（最高那一行 + 1），于是空行根本造不出来：想把下一句配音放到第 3 行，
   就得先把它拖过去，而第 3 行在界面上还不存在 —— 没有落点。
   存在工程里（`projOf().lane[k].rows`，**只有 >1 才占一个键**，与 `vols` 同一记账，老数据不用迁移）。
   行数读法只有一份 `laneRowsFor`：渲染那一排的四条路（本镜画面 / 本镜声音 / 全片画面 / 全片声音）
   与左栏标签都问它，不许各自再拼一遍 `Math.max`。 */
const laneMinRows = k => {
  const o = projOf() && projOf().lane && projOf().lane[k];
  return Math.max(1, Math.min(TRACK_LANES_MAX, Number(o && o.rows) || 0));
};
const laneRowsFor = (k, n) => Math.max(laneMinRows(k), Math.max(1, Number(n) || 0));
/* 一句配音压在哪一格画面段上（按 `shotId / candId / seg` 找那一排的行；找不到 = 画不出来）。 */
const voiceBoxRowOf = v => {
  const sh = allShots().find(s => s && s.id === v.shotId);
  const c = sh && (sh.candidates || []).find(x => x && x.vid === v.candId);
  if (!sh || !c) return null;
  const rows = shotFrames(segsOf(c, candDur(c, sh))).rows || [];
  return rows[Math.min(rows.length - 1, Math.max(0, Number(v.seg) || 0))] || null;
};
/* 新加一句配音落在哪一行（本镜那一排的轴秒口径，与轨道画块同一把尺子）。
   `vLike` 只要有落点与长度（shotId / candId / seg / at / dur）—— 配好 `fa/fb` 的老句同样照收。
   `narrow` 只问「目标左沿这一秒被没被占」（合成发请求前的预检：还不知道音频多长，
   用一个极窄窗问，不会误伤「长度不确定但位置空着」的正常情况）。 */
function voiceLanePlan(vLike, narrow) {
  const rows = Math.max(laneMinRows('voice'), laneRowsOf(voicesEnsure()));
  const items = voicesEnsure().map(v => {
    const r = voiceBoxRowOf(v);
    if (!r) return null;
    const bx = voiceAxBox(r, v);
    /* 抢行看的是**画出来的那一段**（选区），不是句自己的框：拖把手把块剪窄之后，
       让开的正是剪掉那几秒所在的行 —— 按框算会把已经空出来的地方当成还占着。 */
    return { ln: voiceLn(v), l: bx.sel.l, w: bx.sel.w };
  }).filter(Boolean);
  const r = voiceBoxRowOf(vLike);
  const bx = r ? voiceAxBox(r, { at: Number(vLike && vLike.at) || 0, dur: Math.max(0.05, Number(vLike && vLike.dur) || 0) }) : null;
  const target = bx ? { l: bx.sel.l, w: narrow ? 0.01 : bx.sel.w } : null;
  const plan = pickVoiceLane(items, target, rows, TRACK_LANES_MAX);
  return { ln: plan.ln, needNewRow: plan.needNewRow, why: plan.why, rows: rows };
}
/* 现在画了几行：数**已经画出来的行**（与 `syncLaneSide` 同一口径），不重算一遍数据 ——
   收起的那一轨仍然占着一行窄条，行数照旧。 */
const LANE_ROW_SEL = { pic: '.tl-vrow, .tl-film', voice: '.tl-lane' };
function drawnRows(k, col) {
  const bar = col && col.querySelector('#tlBar');
  if (!bar) return laneMinRows(k);
  return Math.max(1, bar.querySelectorAll(LANE_ROW_SEL[k]).length);
}
/* 加一行 / 删一行的判据与落地只有这一处（轨名旁那颗「＋」与每一行标签上那颗「×」只是它的两个出口）。
   两条要说清的拒绝：这一轨收着（加了也看不见）、到上限（再多左栏自己就要滚）。
   拒绝走工具栏那行小字（`class="info"`），不占顶部横幅 —— 横幅是「出错才常驻」那一档，
   「只剩一行」不是错误，用户按不动的原因写在按钮 title 里（见 syncLaneSide），这一句只是补一句。
   「＋」现在挂在**每一行**的标签上（用户点名的第 19 条），所以加行有两种走法：
   轨名那一颗挂在最下面（沿用从前的形状），第 N 行那一颗插在**这一行下面**、下面那些整体往下挪一格。 */
function toolRefuse(t) { setStatus('<span class="info">' + t + '</span>'); }
function addLaneRow(k, col, atLn) {
  if (atLn != null && atLn > 0) return insertLaneRow(k, atLn, col);
  const nm = laneNm(k);
  if (laneHidden(k)) { toolRefuse(nm + '此刻是收起的（行高只有 18px，加了也看不见）：先点轨名旁那颗眼睛展开。'); return -1; }
  const n = drawnRows(k, col);
  if (n >= TRACK_LANES_MAX) { toolRefuse(nm + '已经到 ' + n + ' 行，这是上限（再多左边那一列标签自己就要滚起来了）。'); return -1; }
  setLaneRows(k, n + 1);
  setStatus('<span class="ok">✓ ' + nm + '加到第 ' + (n + 1) + ' 行：把块上下拖就能挪到新行（行距、锁与音量都按行算；'
    + '每一行的标签上都有一颗「×」，能单独把它删掉）</span>');
  filmEdited();
  return n;
}
/* 在**第 at 行下面**插一行（第 2 行往上那些标签上的「＋」）。新行是空的，但它占一个行号 ——
   原来挂在 at 以下的那些行整体往下挪一格，块上的 `ln` 与按行的三张表（基数音量 / 收起 / 锁定）
   必须一起挪：只挪块的话，「第 3 行的 60%」还挂在 3 上，于是压到补上来的那一行；
   只挪表的话，收起与锁定会跟着一个已经换了块的空行。 */
function insertLaneRow(k, at, col) {
  const nm = laneNm(k);
  const want = laneClamp(at);
  if (rowHidden(k, want)) {
    toolRefuse((want <= 0 ? nm : rowNm(k, want)) + '此刻是收起的（行高只有 18px，在它下面加了也看不见）：'
      + (want <= 0 ? '先点轨名旁那颗眼睛展开。' : '先点这一行上那颗眼睛展开。'));
    return -1;
  }
  const n = drawnRows(k, col);
  if (n >= TRACK_LANES_MAX) { toolRefuse(nm + '已经到 ' + n + ' 行，这是上限（再多左边那一列标签自己就要滚起来了）。'); return -1; }
  if (want >= n) { toolRefuse(nm + '第 ' + (want + 1) + ' 行此刻并不存在（现在 ' + n + ' 行）：整栏重画之后行号跟着变，重新点一次。'); return -1; }
  mapLaneBlockRows(k, cur => rowAfterInsert(cur, want));
  moveRowFlags(k, cur => rowAfterInsert(cur, want));
  const nextRows = n + 1;
  setLaneRows(k, nextRows);
  setStatus('<span class="ok">✓ 在' + rowNm(k, want) + '下面插了一行（现在 ' + nextRows + ' 行）：'
    + '原来第 ' + (want + 2) + ' 行往下的块整体往下挪一格，每一段的入出点、时长、倍速与配音一个字没动</span>');
  filmEdited();
}
/* 行号在「删一行 / 插一行」之后的走法，两张表（块上的 ln + 按行的三张表）共用同一个映射：
   · 删：被删那一行上的块并到**上面一行**（ln-1），再往上的每一行往下补一格；
   · 插：新行落在 at+1，at 以下（含 at 自己）不动，比 at 大的每一行往下挪一格。 */
const rowAfterDrop = (cur, ln) => (cur === ln ? ln - 1 : cur > ln ? cur - 1 : cur);
const rowAfterInsert = (cur, at) => (cur > at ? cur + 1 : cur);
/* 块上的行号过一遍（画面轨要遍历**所有候选**，不只当前那条：全片那一排把每一镜的段摊在同一批行里，
   只改当前这条的话，插/删的行号在别的镜上还留着，行自己长回来）。 */
function mapLaneBlockRows(k, fn) {
  let moved = 0;
  if (k === 'voice') {
    voicesEnsure().forEach(v => { const to = fn(voiceLn(v)); if (to !== voiceLn(v)) { v.ln = to; moved++; } });
  } else {
    allShots().forEach(sh => (sh.candidates || []).forEach(c => {
      if (!Array.isArray(c.segs)) return;
      const total = candDur(c, sh);
      const list = segsOf(c, total);
      let ch = 0;
      list.forEach(s => { const to = fn(picLnOf(s)); if (to !== picLnOf(s)) { s.ln = to; ch = 1; moved++; } });
      /* 写回走 `segsWrite`：它顺手把 `ln=0` 那个键摘掉（第一行是缺省，与 vol/spd 同一记账） */
      if (ch) segsWrite(c, total, list);
    }));
  }
  return moved;
}
/* 按行记的那三张表（基数音量 `vols` / 收起 `hides` / 锁定 `locks`）一起过同一个映射。
   只有非默认才占键（与 `laneVol` / `rowFlag` 同一记账），所以搬完之后：并进第 0 行的那一份
   没有地方记就随它消失（第 0 行 = 默认，不留一份「看不见的加压」），塌空的表整个删掉。 */
const ROW_FLAG_COLS = ['vols', 'hides', 'locks'];
function moveRowFlags(k, fn) {
  const o = projOf() && projOf().lane && projOf().lane[k];
  if (!o) return;
  ROW_FLAG_COLS.forEach(what => {
    const src = o[what];
    if (!src) return;
    const out = {};
    Object.keys(src).forEach(key => {
      const cur = Number(key);
      if (!isFinite(cur)) { out[key] = src[key]; return; }
      const to = laneClamp(fn(cur));
      if (to > 0) out[to] = src[key];
    });
    if (Object.keys(out).length) o[what] = out; else delete o[what];
  });
}
function shiftLaneRows(k, ln) {
  let on = 0, below = 0;
  const hit = cur => {
    const to = rowAfterDrop(cur, ln);
    if (to !== cur) { if (cur === ln) on++; else below++; }
    return to;
  };
  mapLaneBlockRows(k, hit);
  moveRowFlags(k, cur => rowAfterDrop(cur, ln));
  return { on: on, below: below };
}
/* 删掉**指定的那一行**（用户点名的第 ⑤ 条：多添加出来的轨道要能够独立删除）。
   从前只有「最后一行并且它是空的」收得掉（− 只挂在最后一行的标签上），于是加出来的第 2、3 行
   只要摆上过东西就永远删不掉。这一行上的块不许凭空消失：它们并到上面那一行，
   再往上的行整体往下补一格 —— 画面段在同一条候选里时间上前后不相接，并上去不会叠；
   配音句本来就允许同一行有好几句。这与「上下拖块体换行」是同一件事的反方向，不是新出口。
   第 1 行是锚行：整条轨至少留一行，要收起来用轨名旁那颗眼睛。 */
function dropLaneRow(k, ln, col) {
  const nm = laneNm(k);
  if (laneHidden(k)) { toolRefuse(nm + '此刻是收起的（行高只有 18px，删了也看不见）：先点轨名旁那颗眼睛展开。'); return; }
  const n = drawnRows(k, col);
  if (n <= 1) { toolRefuse(nm + '只剩一行，没有可删的：整条轨要收起来点轨名旁那颗眼睛。'); return; }
  const want = Math.max(0, Math.round(Number(ln) || 0));
  if (want <= 0) { toolRefuse(nm + '第 1 行是这条轨的锚行：整条轨至少留一行，删掉它等于整条轨没了。'); return; }
  if (want >= n) { toolRefuse(nm + '第 ' + (want + 1) + ' 行此刻并不存在（现在 ' + n + ' 行）：整栏重画之后行号跟着变，重新点一次。'); return; }
  /* 只收起**这一行**时那颗「×」本来就被 CSS 藏掉、`syncLaneSide` 又把它压暗，函数入口照样硬拒 ——
     删掉一条看不见的行等于让用户不知道自己删了什么（与「承诺要么实现、要么改文案」同一立场）。 */
  if (rowHidden(k, want)) { toolRefuse(rowNm(k, want) + '此刻是收起的（行高只有 18px，删了也看不见）：先点这一行上那颗眼睛展开。'); return; }
  const mv = shiftLaneRows(k, want);
  setLaneRows(k, n - 1);
  setStatus('<span class="ok">✓ 删掉了' + nm + '第 ' + (want + 1) + ' 行'
    + (mv.on ? '：这一行上的 ' + mv.on + ' 个块并到第 ' + want + ' 行' : '')
    + (mv.below ? (mv.on ? '，' : '：') + '再往下的 ' + mv.below + ' 个块往上补一格' : '')
    + '（每一段的入出点、时长、倍速、配音与它们各自的音量一个字没动；'
    + '按行记的那三张表 —— 基数音量 / 收起 / 锁定 —— 跟着块一起挪了行号）</span>');
  filmEdited();
}
function setLaneRows(k, n) {
  projOf().lane = projOf().lane || {};
  const o = projOf().lane[k] = projOf().lane[k] || {};
  const v = Math.max(1, Math.min(TRACK_LANES_MAX, Math.round(Number(n) || 1)));
  if (v <= 1) delete o.rows; else o.rows = v;
}
/* 全片配音按「声音来源」分到各自的轨道上（右栏「分轨」那颗按钮的唯一落点）。
   分组键三级兜底在 `voice-lanes.js`；第三级在这里把 `src` 换成剥掉签名参数的身份 ——
   同一段音频换了签名仍是同一个 key，两段不同的音频不会被合并。
   只写 `v.ln`：时间、时长、选区、音量、倍速与台词一个字节都不动，成片里的声音完全一样。 */
const voiceSrcKeyOf = u => {
  const api = window.Api;
  return api && api.mediaKey ? api.mediaKey(u) : String(u || '');
};
function voiceSplitByMaterial(keyOf) {
  const why = tlLockWhy();
  if (why) { setStatus('<span class="err">' + why + '：分轨只改画在第几行，锁着的时候也一样不动。' + tlUnlockHow() + '。</span>'); return; }
  const voices = voicesEnsure();
  if (!voices.length) { toolRefuse('全片还没有配音：先合成一句，再按声音来源分轨。'); return; }
  const groups = groupByMaterial(voices, typeof keyOf === 'function' ? keyOf : (v => defaultKeyOf(v, voiceSrcKeyOf)));
  const { rows, overflow } = planLaneRows(groups, TRACK_LANES_MAX);
  const dirty = rows.some(r => r.voices.some(v => voiceLn(v) !== r.ln)) || laneMinRows('voice') < rows.length;
  if (dirty) beginEdit('配音分轨');
  const moved = applyLanePlan(rows);
  const need = Math.max(laneMinRows('voice'), rows.length);
  if (need !== laneMinRows('voice')) setLaneRows('voice', need);
  setStatus('<span class="ok">✓ 已把 ' + voices.length + ' 句分到 ' + rows.length + ' 条轨道'
    + (moved ? '（挪了 ' + moved + ' 句）' : '（本来就在这些行上）')
    + '（时间、时长与音量一个字不动；只改画在第几行，成片里的声音完全一样）</span>'
    + (overflow.length ? '；另有 ' + overflow.length + ' 组没排上：'
      + overflow.map(g => escHTML(g.label)).join('、') + '（配音轨最多 ' + TRACK_LANES_MAX + ' 行）' : ''));
  if (dirty) filmEdited();
}
/* 全片配音合并到第 1 条轨道（右栏「合轨」那颗按钮的唯一落点）。只改排版：
   同一行里可能有好几句在时间上重叠，成片里会一起响 —— 回执里写清楚。 */
function voiceMergeAll() {
  const why = tlLockWhy();
  if (why) { setStatus('<span class="err">' + why + '：合轨只改画在第几行，锁着的时候也一样不动。' + tlUnlockHow() + '。</span>'); return; }
  const voices = voicesEnsure();
  if (!voices.length) { toolRefuse('全片还没有配音：先合成一句，再点合轨。'); return; }
  if (!voices.some(v => voiceLn(v) !== 0) && laneMinRows('voice') === 1) { toolRefuse('全片配音已经都在第 1 条轨道上了。'); return; }
  beginEdit('配音合轨');
  mapLaneBlockRows('voice', () => 0);
  keepRowFlagsFirst('voice');
  setLaneRows('voice', 1);
  setStatus('<span class="ok">✓ 已把 ' + voices.length + ' 句合并到第 1 条轨道（只改排版，不改成片；同一行里可能有重叠，成片里会一起响）</span>');
  filmEdited();
}
/* 合轨之后只剩第 1 行：按行记的三张表（基数音量 / 收起 / 锁定）里那些已经不存在的行不能留着，
   否则下次加到那一行会「凭空」被压暗 / 收起 / 锁住。第 1 行自己的设置保留。 */
function keepRowFlagsFirst(k) {
  const o = projOf() && projOf().lane && projOf().lane[k];
  if (!o) return;
  ROW_FLAG_COLS.forEach(what => {
    const src = o[what];
    if (!src) return;
    const out = {};
    if (src[0] != null) out[0] = src[0];
    if (Object.keys(out).length) o[what] = out; else delete o[what];
  });
}
/* 把「某一格画面」挪到画面轨第几行的落地只有一份：本镜那一排（`bindSegDrag` 上下拖）与
   全片那一排（`bindFilmReorder` 上下拖）两只手都只是它的出口。行号写在候选那一段的 `s.ln` 上，
   两条轨读的是同一个数 —— 所以「在本镜挪到第 3 行、切到全片还在第 3 行」不是同步逻辑，是没有第二份账。
   只改排版：入出点、框、倍速、配音一律不动（进成片看的是时间线，不是第几行）。 */
function setCellLane(sh, cand, segIdx, ln) {
  if (!sh || !cand) return null;
  const total = candDur(cand, sh);
  const list = segsCopy(segsOf(cand, total));
  const s = list[Math.max(0, Math.min(list.length - 1, Number(segIdx) || 0))];
  if (!s) return null;
  s.ln = laneClamp(ln);
  segsWrite(cand, total, list);   // 走 segsWrite：它顺手把 `ln=0` 那个键摘掉（第一行是缺省）
  return s;
}
/* 整条轨的静音（用户点名的第 ② 条：点轨道左边那枚音量图标切静音）。
   与音量是**两件事**：静音不动任何一级音量（段 / 句自己的 vol 与行基数原样留着），
   取消静音就回到原样；乘算只在 `picVolOf` / `voiceVolOf` 两处，所以预览、指纹、
   合成三处读到的是同一个数。只有 true 才占键（与 vols / hides / locks 同一记账）。 */
const laneMute = k => {
  const o = projOf() && projOf().lane && projOf().lane[k];
  return !!(o && o.mute);
};
/* 整轨音量那个数的清单（**不按「此刻选中谁」筛**）：左列那枚滑块与右栏那枚「整轨音量」
   改的是同一批东西（段 / 句自己的 vol），但左列不看选中，右栏跟着手走。 */
function trackVoiceScope() {
  if ((projOf().tlTab || 'shot') === 'film') return voicesEnsure().filter(x => !!voiceFilmSpan(x));
  const sh = curShot();
  if (!sh) return [];
  const c = cutCand();
  return shotVoices(sh.id, c && c.vid);
}
const trackOwnVol = k => (k === 'voice'
  ? trackVoiceScope().map(v => (v && v.vol != null && isFinite(Number(v.vol)) ? Number(v.vol) : 1))
  : trackSegsNow().map(s => segVol(s)));
function laneMuteToggle(k) {
  k = k === 'voice' ? 'voice' : 'pic';
  if (laneLocked(k)) {
    toolRefuse('整条' + laneNm(k) + '已锁定：静音也不切。' + rowUnlockHow(k, 0) + '。');
    return;
  }
  projOf().lane = projOf().lane || {};
  const o = projOf().lane[k] = projOf().lane[k] || {};
  const on = !o.mute;
  if (on) o.mute = true; else delete o.mute;
  setStatus('<span class="' + (on ? 'warn' : 'ok') + '">' + icon(on ? 'speakerOff' : 'speaker', 12) + ' '
    + laneNm(k) + (on
      ? '已静音：预览与成片这一轨都不出声（每一段 / 每一句的音量原样留着，再点一下恢复）'
      : '已取消静音') + '</span>');
  renderAll();
  scheduleSave();
}
const picVolOf = s => clampVol(segVol(s) * laneVol('pic', picLnOf(s)) * (laneMute('pic') ? 0 : 1));
/* 工程 → 时间线的投影（镜头顺序与 clips 派生）在 projection.js；播放计划 / 导出 / FCPXML 读同一份。 */
const { filmShotsOrdered, filmOrderNow, moveShotInFilmOrder, tlFromShots, tlSyncFromShots } = createProjection({
  getProj: () => projOf(), allShots, shotReady, tlCandidateOf, candDur, segSpd, picVolOf, uid,
});
const voiceVolOf = v => clampVol((v && v.vol != null && isFinite(Number(v.vol)) ? Number(v.vol) : 1)
  * laneVol('voice', voiceLn(v)) * (laneMute('voice') ? 0 : 1));
function setLaneVol(k, vol, ln) {
  const ln2 = laneClamp(ln);
  const nm = rowNm(k, ln2);
  /* 与片段那枚滑块同一把锁的判据，但问的是**这一行**：锁着第 3 行时第 1、2 行照样要能调（不牵连），
     锁着另一轨也管不着这一轨 —— 判据只有 `rowLocked` 一份（整条轨锁着时它压得住每一行）。 */
  if (rowLocked(k, ln2)) { setStatus('<span class="err">' + laneVolWhy(k, ln2) + '</span>'); return; }
  projOf().lane = projOf().lane || {};
  const o = projOf().lane[k] = projOf().lane[k] || {};
  if (o.vol != null) delete o.vol;          // 上一版的「整轨」那一个键：换成按行记之后不留双份
  o.vols = o.vols || {};
  const v = clampVol(vol);
  if (v === 1) delete o.vols[ln2]; else o.vols[ln2] = v;
  const other = k === 'voice' ? '画面上的原声不受影响' : '配音那一句不受影响';
  /* 正在试听的那一句要当场跟着变（画面那一路不用管：下面的 filmEdited → 整栏重画
     → `TlPlay.setPlan` 末尾的 applyVol 会把新音量按到正在播的甲板上，而甲板音量不进播放指纹，
     不会把正在听的那一句掐断重放）。 */
  if (k === 'voice' && voiceElOf() && !voiceElOf().paused) {
    const cur = voicesEnsure().find(x => x.id === voiceElOf().__vid);
    if (cur) { try { voiceElOf().volume = Math.max(0, Math.min(1, voiceVolOf(cur))); } catch (e) { /* 播放器此刻拒设音量就保持原音量，不打断播放 */ } }
  }
  setStatus('<span class="ok">✓ ' + nm + '音量 ' + Math.round(v * 100) + '%（这一行上每一段都跟着'
    + (v < 1 ? '变轻' : v > 1 ? '变响（超过 100% 的部分只在合并成片时生效）' : '回到原样') + '，别的行与' + other + '）</span>');
  filmEdited();
}
function laneToggle(k, what) {
  projOf().lane = projOf().lane || {};
  const o = projOf().lane[k] = projOf().lane[k] || {};
  o[what] = !o[what];
  const nm = laneNm(k);
  setStatus('<span class="ok">✓ ' + nm + (what === 'lock' ? (o.lock ? '已锁定：拖、剪、调音量都不接了' : '已解锁')
    : (o.hide ? '已收起（再点一下眼睛展开）' : '已展开')) + '</span>');
  renderAll();
  scheduleSave();
}
/* 把焦点切到「这一句自己那一镜 + 它那一条候选 + 它那一段」，然后整栏重画。
   本镜那一排上「溢出进来的那一截」是只读的（时间基不是它的），而用户点它就等于说
   「我要改这一句」—— 所以给的是跳过去，不是留一句「这里改不了」。 */
function focusVoiceShot(v) {
  const sh = allShots().find(x => x.id === v.shotId);
  if (!sh) { setStatus('<span class="err">这一句挂的那个镜头已经不在了：它只是留在时间线上的一条配音</span>'); return false; }
  const sc = projOf().scenes.find(s2 => s2.shots.includes(sh));
  if (sc) { projOf().curScene = projOf().scenes.indexOf(sc); projOf().curShot = sc.shots.indexOf(sh); }
  const ci = (sh.candidates || []).findIndex(x => x.vid === v.candId);
  if (ci >= 0) projOf().curCand = ci;
  projOf().cutSeg = Math.max(0, Number(v.seg) || 0);
  selectVoice(v.id);              // 连目标一起交回配音（只写 curVoice 的话芯片还指着画面，剪子却该剪这一句）
  setStatus('<span class="ok">✓ 已跳到「' + (sh.name || '镜头') + '」：这一句现在可以拖、可以剪了</span>');
  renderAll();
  return true;
}
/* 插针落在「这一句」的时间轴上的第几秒（口径 = `v.at` 用的那个：相对它锚定那一段的选区起点）。
   取不到就带 `{ err }` 回来，由调用方把原因说清 —— 猜一个 0 会把人话剪成静音。 */
function voicePinLocal(v) {
  const sh = allShots().find(x => x.id === v.shotId);
  const c = sh ? (sh.candidates || []).find(x => x.vid === v.candId) : null;
  if ((projOf().tlTab || 'shot') === 'film') {
    const tl = tlSyncFromShots(), G = filmFrames(tl);
    const r = G.rows.find(x => x.cl.kind === 'shot' && x.cl.shotId === v.shotId && x.cl.candId === v.candId
      && (Number(x.cl.seg) || 0) === (Number(v.seg) || 0));
    if (!r) return { err: '这一句在「全片」那一排上找不到它那一格（它那一镜可能还没被选用）：切回「本镜」再剪' };
    /* `base` 与 `filmPinT` 都是**轴秒**（轨道那一排的尺子），相减之后还要 × 倍速才回到
       `v.at` 的那一把尺子（段内源 / 音频秒）—— 忘了这一步，2 倍速的那一格上「在针处剪一刀」会剪在句子中间。 */
    const base = srcToFrame(r, Math.max(0, Number(r.cl.in) || 0));
    return { at: round1((filmPinT(tl, G) - base) * r.spd) };
  }
  if (!c) return { err: '这一句挂的那条候选已经不在了：到它自己那一镜的剪辑里再看一眼' };
  const total = candDur(c, sh), segs = segsOf(c, total);
  const s = segs.length ? segs[Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0))] : null;
  if (!s) return { err: '这一句锚着的那一段画面已经被删掉了：按 Ctrl+Z 退回到删段之前，或直接删掉这一句' };
  return { at: round1(cutPin(c, total) - s.in) };
}
/* 声音那一侧的五把剪子。与 `cutSegs` 逐条同义：框不动、只收选区、切开新建一份、
   融合只接「一刀切开且之后没再动过」的两半、音量不等就拒绝融合。 */
function applyVoiceCut(way) {
  const v = tlVoiceHit();
  if (!v) { setStatus('<span class="err">先点轨道上的一句配音，这一排按钮才指着它</span>'); return; }
  const fr = voiceFrameOf(v);
  const at0 = Math.max(0, Number(v.at) || 0), dur0 = Math.max(voiceMin(), Number(v.dur) || 0);
  const off0 = Math.max(0, Number(v.off) || 0);
  /* 一句自己的倍速（第 ⑤ 条那一档；merge 那一路另按每对 x/y 各取各的）：
     `at / fa / fb` 在**源秒**上量，`dur / off` 在**音频文件秒**上量 ——
     剪一刀或切一头时「消耗了多少文件秒」= 源秒差 × own，三把剪子都要这一道。 */
  const own = voiceRateOf(v);
  const near = (a, b) => Math.abs(a - b) < 0.011;         // round1 之后同一秒可能差 1 个末位
  const name = String(v.name || v.text || '配音').slice(0, 12);
  const say = (ok, t) => { setStatus((ok ? '<span class="ok">✓ ' : '<span class="err">') + t + '</span>'); };
  if (way === 'drop') {
    projOf().voices = voicesEnsure().filter(x => x.id !== v.id);
    projOf().curVoice = '';
    say(1, '已删掉那一句配音（画面没动）'); filmEdited(); return;
  }
  if (way === 'merge') {
    /* 同一段里的配音按框左沿排队，先试右边那一颗再试左边（与画面同一顺序）。
       三条都接上才算「本来是一刀切开的两半」：框挨着、选区挨着、**音频文件里的位置**也挨着 ——
       最后那一条是音频独有的（两句可能都从音频第 0 秒起，时间上接着、内容上却是重复的一段）。 */
    const list = voicesEnsure().filter(x => x.shotId === v.shotId && x.candId === v.candId
      && (Number(x.seg) || 0) === (Number(v.seg) || 0))
      .sort((a, b) => (voiceFrameOf(a).fa - voiceFrameOf(b).fa));
    const k = list.findIndex(x => x.id === v.id);
    for (const p of [[k, k + 1], [k - 1, k]]) {
      const x = list[p[0]], y = list[p[1]];
      if (!x || !y) continue;
      const fx = voiceFrameOf(x), fy = voiceFrameOf(y);
      /* 相邻判据里的「x 的结尾在哪」必须换回**源秒**再和 `y.at` 比：`x.dur` 是音频文件秒，
         直接加在 `x.at`（源秒）上等于把念多快当成占多长 —— ×1.5 的两半之间会算出
         「相隔 0.25 秒」，看着永远融不回去。`off + dur` 那一头是文件秒比文件秒，不用动。 */
      const sx = voiceRateOf(x), sy = voiceRateOf(y);
      const ex = Math.max(0, Number(x.at) || 0) + Math.max(0, Number(x.dur) || 0) / sx;
      if (!(near(fx.fb, fy.fa) && near(ex, Number(y.at) || 0) && near(Math.max(0, Number(x.off) || 0) + Number(x.dur || 0), Number(y.off) || 0))) continue;
      const vx = Number(x.vol == null ? 1 : x.vol), vy = Number(y.vol == null ? 1 : y.vol);
      if (vx !== vy) {
        say(0, '这两句的音量不一样（' + Math.round(vx * 100) + '% / ' + Math.round(vy * 100) + '%），先调成一样再融合');
        return;
      }
      /* 倍速同一立场（第 ③ 条之后它是切得开的两半了）：一刀切开的两半本来同一个数，
         切完之后单独调过其中一半就说明它们已经不是「原来那一句」，并回去等于悄悄丢掉一档变速。 */
      if (sx !== sy) {
        say(0, '这两句的倍速不一样（' + spdTxt(sx) + ' / ' + spdTxt(sy) + '），先调成一样再融合');
        return;
      }
      x.fb = round1(fy.fb);
      x.dur = round1((ex - (Number(x.at) || 0)) * sx + (Number(y.dur) || 0));
      projOf().voices = voicesEnsure().filter(z => z.id !== y.id);
      projOf().curVoice = x.id;
      say(1, '已把这两句融合回一句（' + round1(x.dur) + ' 秒，画面没动）'); filmEdited(); return;
    }
    say(0, '这一句与旁边的不是「一刀切开、之后没再动过」的两半，融不回一句：按 Ctrl+Z 退回到切开之前，或直接删掉这一句');
    return;
  }
  const loc = voicePinLocal(v);
  if (loc.err) { say(0, loc.err); return; }
  if (way === 'split') {
    /* `loc.at` 与 `at0` 都是**源秒**，而 `dur0 / off0` 是**音频文件秒**：切下去消耗的文件秒
       = 源秒差 × `own`。直接拿源秒差去减 `dur0`，×1.5 的那一句切出来两半的时长加起来
       不等于原来的（回执与轨道都会跟着错）。
       三个写点（切开 / 向左切 / 向右切）一律**不 round1**：两半是「一份账拆开」，独立取整会把
       守恒断掉（0.75 / 0.25 各自进成 0.8 / 0.3，两半加起来比原来长 0.1 秒），而且后半的
       `at` 与前半的右沿对不上（0.9333 vs 0.9），融合那道相邻判据先于倍速判据把它拦掉 ——
       表现是「一刀切开之后这两半永远融不回去」。量化只发生在**手势入点**：插针按 `voicePinLocal`
       取整、拖动松手按 `roundVoice` 取整，所以这里拿到的 `loc.at` 本来就是整齐的。 */
    const d = loc.at - at0, df = d * own;
    if (df < voiceMin() || dur0 - df < voiceMin()) {
      say(0, '插针离这一句的两头太近（切完会有一段不足 ' + round1(voiceMin()) + ' 秒），切不开：把针挪到这一句中间再切'); return;
    }
    const fb0 = fr.fb;
    const v2 = Object.assign({}, v, {
      id: uid(), at: loc.at, dur: dur0 - df, off: off0 + df,
      fa: loc.at, fb: fb0,
    });
    v.fb = loc.at; v.dur = df;
    voicesEnsure().push(v2);
    projOf().curVoice = v.id;
    say(1, '在 ' + fmtDur(loc.at) + ' 秒处把这一句切成两句（前半 ' + round1(d) + ' 秒 / 后半 ' + round1(dur0 / own - d) + ' 秒）');
    filmEdited(); return;
  }
  if (way === 'left') {
    if (loc.at <= at0 + voiceMin() / own) {
      say(0, '插针在这一句的开头之前（这一句从 ' + round1(at0) + ' 秒起）——向左切没东西可切。把针挪进这一句里，或改用「向右切」');
      return;
    }
    if (loc.at >= at0 + (dur0 - voiceMin()) / own) {
      say(0, '插针在这一句的结尾之后 —— 向左切等于整句都不要了，那样请直接点「删掉这一句」'); return;
    }
    const na = Math.max(Math.max(fr.fa, at0 - off0 / own), loc.at);
    const d = (na - at0) * own;
    v.at = na; v.dur = dur0 - d; v.off = off0 + d;
    say(1, '已把这一句的开头切掉到插针处（现在从音频第 ' + round1(v.off) + ' 秒起、长 ' + round1(v.dur) + ' 秒）');
    filmEdited(); return;
  }
  if (way === 'right') {
    if (loc.at >= at0 + (dur0 - voiceMin()) / own) {
      say(0, '插针在这一句的结尾之后（或正好压在结尾）——向右切没东西可切'); return;
    }
    if (loc.at <= at0 + voiceMin() / own) {
      say(0, '插针在这一句的开头之前 —— 向右切等于整句都不要了，那样请直接点「删掉这一句」'); return;
    }
    v.dur = Math.max(voiceMin(), (loc.at - at0) * own);
    say(1, '已把这一句的结尾切到插针处（块当场变窄，现在长 ' + round1(v.dur) + ' 秒，右边切掉的那一截不进成片）');
    filmEdited(); return;
  }
  say(0, '不认识这种剪法');
}
/* 这一排按钮的唯一入口：先问目标，再走对应那把剪子。
   两颗入口（本镜 / 全片页签）都绑它 —— 「在一处剪了另一处跟着变」不是同步逻辑，是没有第二份数据。 */
function runCut(way) {
  /* 「试听」只听按目标读回来的那一句：指着画面时它是隐藏的，但快捷键之类别的路径照样得拒 ——
     拿 projOf().curVoice 去试听会出现「芯片写着画面、嘴里放的是上一句配音」。 */
  if (way === 'play') {
    const vv = tlVoiceHit();
    if (!vv) { setStatus('<span class="err">现在指着的是画面段，没有可试听的配音：先点轨道上的一句配音</span>'); return; }
    playVoicePreview(vv.id); return;
  }
  /* 空段只对画面段有效：配音句没有「插一段空 / 摘掉空段」这两支，
     必须在转去 applyVoiceCut **之前**拦住 —— 否则会落进配音剪法的「不认识这种剪法」默认分支。 */
  if ((way === 'gap' || way === 'close') && tlCutTarget() === 'voice') {
    setStatus('<span class="err">空段只对画面段有效：先点一格画面（或把插针放到画面上）再试</span>');
    return;
  }
  /* 锁轨是「改不动」的判据，剪辑条与轨上手势问同一个 tlLockWhy()：
     按钮压暗、点下去也照实说原因 —— 只在手势里拒，就会出现「按钮亮着、点了没反应」。 */
  const why = tlLockWhy();
  if (why) { setStatus('<span class="err">' + why + '：这一刀不接。' + tlUnlockHow() + '。</span>'); return; }
  if (tlCutTarget() === 'voice') applyVoiceCut(way);
  else applyCut(way);
}
/* 现在指着的那一轨锁没锁，锁了就说人话（没锁回空串）。
   「试听」不走这里 —— 锁的是「改」，不是「听」。
   问的是**那一行**（`rowLocked`）：整条轨锁着时每一行都锁（它压得住行级），
   只锁了第 3 行时第 1、2 行照旧能剪 —— 指到第 3 行那一格才拒。
   没有可指的目标（还没有段 / 还没选过）时按锚行那一档问，也就是问整条轨。 */
function tlLockWhy() {
  const k = tlCutTarget() === 'voice' ? 'voice' : 'pic';
  const t = cutLaneOf();
  return rowLockWhy(k, t && t.k === k ? t.ln : 0);
}
/* 音量的唯一出口：滑块 0–200%（步进 0.1 = 无级）。画面写进段自己的 `vol`，
   配音写 `v.vol`；两边都只有一份账，块上的颜色与读数由这次写入之后现画。 */
function setCutVol(vol) {
  /* 与那一排剪子同一把锁的判据：滑块虽然已经被 syncTlTools 压暗，这里还是要真拒 ——
     「按钮 disabled 了但函数还能被别的路径调到」正是承诺与实现分家的地方。 */
  const whyLock = tlLockWhy();
  if (whyLock) { setStatus('<span class="err">' + whyLock + '：音量不调。' + tlUnlockHow() + '。</span>'); return; }
  const v = tlVoiceHit();
  if (v) {
    v.vol = vol;
    document.querySelectorAll('#tlBar .tl-lane').forEach(l => paintVoiceVol(l, v));
    const rd = document.getElementById('tlVolVal');
    if (rd) rd.textContent = Math.round(vol * 100) + '%';
    /* 正在响的就是这一句 → 就地改（拖到哪儿听到哪儿；浏览器给 <audio> 封顶 1，超出只在合并时生效）
       —— 按**合成后**的数改（这一句 × 它所在那一行的基数），不然那一行压到 60% 时拖这一句会当场听到 100%。 */
    if (voiceElOf() && !voiceElOf().paused) { try { voiceElOf().volume = Math.max(0, Math.min(1, voiceVolOf(v))); } catch (e) { /* 播放器此刻拒设音量就保持原音量，不打断播放 */ } }
    filmEdited();
    return;
  }
  const f = cutCand();
  if (!f) { setStatus('<span class="err">这一镜还没有候选，没有可调音量的画面段</span>'); return; }
  const segs = segsOf(f.c, f.total);
  if (!segs.length) { setStatus('<span class="err">这一条一段画面都没留：按 Ctrl+Z 退回剪切之前，再调音量</span>'); return; }
  const i = Math.min(segs.length - 1, cutSegIdx());
  /* 图片段没有原声（`segVol` 恒 0），空段也没有画面 —— 写进去也听不出任何区别，
     回执说「已调」就是一句假话。 */
  if (isVirtualSeg(segs[i])) {
    setStatus('<span class="err">' + (isImageSeg(segs[i]) ? '图片段没有原声' : '空段没有画面，也没有原声') + '：这一段没有可调的音量</span>');
    return;
  }
  segs[i].vol = vol;
  segsWrite(f.c, f.total, segs);
  const rd2 = document.getElementById('tlVolVal');
  if (rd2) rd2.textContent = Math.round(vol * 100) + '%';
  const pl = document.getElementById('player');
  if (pl) { try { pl.volume = Math.min(1, picVolOf(segs[i])); } catch (e) { /* 画面段音量设不上就按原音量继续，不中断 */ } }
  /* 格子分在好几行里之后，DOM 顺序不再等于段号 —— 只能按 `data-seg` 找回那一格的读数。 */
  const lab = document.querySelector('#tlBar .tl-vrow .tl-seg[data-seg="' + i + '"] .lab');
  if (lab) {
    /* 三段结构：只换时长那一格（整行写会把静音钮写掉） */
    const d2 = lab.querySelector('.lab-dur');
    if (d2) d2.textContent = (window.Wb && window.Wb.fmtClock) ? window.Wb.fmtClock(segFilmLen(segs[i])) : (round1(segFilmLen(segs[i])) + 's');
    else lab.textContent = segLabel(i, segs[i]);
  }
  setStatus('<span class="ok">✓ 第 ' + (i + 1) + ' 段的原声现在是 ' + Math.round(vol * 100) + '%（'
    + (vol > 1 ? '超过 100% 的部分只在合并成片时生效' : '预览里当场就能听到') + '）</span>');
  filmEdited();
}
/* ---------------- 第几行（画面轨与声音轨的「多行」）----------------
   行数 `ln` 是**显式数据**（段上的 `s.ln` / 配音上的 `v.ln`，缺省 0 = 第一行，与从前一模一样）。
   不自动挤行：自动排的话同一句在「本镜」那一排与「全片」那一排的重叠集合不是同一个
   （本镜只看这条候选的段，全片看所有镜），切一次页就跳一次行，而用户刚刚亲手拖到第二行等于白拖。
   两个出口：轨道上**上下拖块体**（见 bindVoiceLane ②）与这里这颗「移一行」（拖不动的时候用它）。 */
const cutLaneOf = () => {
  const v = tlVoiceHit();
  if (v) return { k: 'voice', ln: voiceLn(v), obj: v };
  const w = cutSpdSeg();
  if (!w) return null;
  return { k: 'pic', ln: picLnOf(w.segs[w.i]), w: w };
};
function laneWhy() {
  const why = tlLockWhy();
  if (why) return why + '：不换行。' + tlUnlockHow() + '。';
  if (!cutLaneOf()) return '还没有指着可以换行的东西：点轨道上的一格画面或一句配音。';
  return '';
}
function setCutLane(delta) {
  const why = laneWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const t = cutLaneOf();
  const to = laneClamp(t.ln + (delta > 0 ? 1 : -1));
  if (to === t.ln) {
    setStatus('<span class="err">' + laneNm(t.k) + '一共 ' + TRACK_LANES_MAX
      + ' 行，这一' + (t.k === 'voice' ? '句' : '段') + '已经在' + (delta > 0 ? '最下面' : '最上面') + '那一行了</span>');
    return;
  }
  if (t.k === 'voice') {
    t.obj.ln = to;
    setStatus('<span class="ok">✓ 这一句配音移到了' + laneNm('voice') + '第 ' + (to + 1) + ' 行（时间、时长与音量一个字不动；这一行的音量在右栏那枚滑块上调）</span>');
  } else {
    t.w.segs[t.w.i].ln = to;
    segsWrite(t.w.f.c, t.w.f.total, t.w.segs);
    setStatus('<span class="ok">✓ 第 ' + (t.w.i + 1) + ' 段画面移到了画面轨第 ' + (to + 1) + ' 行（只是排版：进成片的顺序与时长看的是时间线，不是第几行）</span>');
  }
  filmEdited();
}
/* 画面那一枚倍速**只改画面段**（配音那一侧有它自己的一枚：`voiceSpdWhy` / `setVoiceSpd`，
   乘在画面倍速之上）。
   所以「指着配音」时这一枚一律不接，并把原因写成「这一句念多快用『这一句倍速』那一排」，
   不是干脆压暗不吭声。（说「上面那一排」曾经就是错的：画面那一排此刻整块收起，
   用户看得见的那一枚在它**下面**，指路要指着看得见的那一排。）
   目标不是配音时把「指着的那一段」连同候选一起递回来 —— 三个写点都用它，判据只这一份。 */
function cutSpdSeg() {
  if (tlCutTarget() === 'voice') return null;
  const f = cutCand();
  if (!f) return null;
  const segs = segsOf(f.c, f.total);
  if (!segs.length) return null;
  return { f: f, segs: segs, i: Math.min(segs.length - 1, cutSegIdx()) };
}
/* 「这一段现在能不能改倍速」的一句话原因（空串 = 能）。锁、目标、有没有段三种情形同一条路，
   syncTlTools 的压暗与 setCutSpd 入口的硬拒问的都是它 —— 分开写就会出现
   「按钮亮着、点下去说什么都不发生」。 */
function spdWhy() {
  const why = tlLockWhy();
  if (why) return why + '：倍速不改。' + tlUnlockHow() + '。';
  if (tlCutTarget() === 'voice') return '这一枚调的是画面那一段在成片里占多久：现在指着的是配音那一句，画面那一排整个收起 —— 要改这一句念多快，用「这一句倍速」那一排';
  const w = cutSpdSeg();
  if (!w) return '这一镜还没有画面段：先生成或导入一条候选，或按 Ctrl+Z 退回剪切之前。';
  const s = w.segs[w.i];
  if (isImageSeg(s)) return '这一格是图片段：静态图没有倍速，它占多久就是它自己的时长 —— 拖这一格的右把手改';
  if (isVirtualSeg(s)) return '这一格是空段：没有画面就没有倍速，它多长由插空时定下，要改就摘掉重插一段';
  return '';
}
/* 倍速的唯一写点（形状与 setCutVol 一致：先问闸 → 写段 → segsWrite → 读数现画 → filmEdited）。
   改的是这一段的 `spd`，也就是「这一段占多久」。**两条轨的格子都跟着缩 / 放**（`shotFrames` 与
   `filmFrames` 都按 框 ÷ 倍速 摆），数据层一个字节不添 —— 从前这里只改全片那一排，本镜那一排按
   源秒摆所以一格不动，用户拖到底看不出这一镜有什么变化（点名的第 11 条）。 */
function setCutSpd(spd) {
  const why = spdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const w = cutSpdSeg();
  const v = Math.max(0.25, Math.min(4, Number(spd) || 1));
  w.segs[w.i].spd = v;
  const list = segsWrite(w.f.c, w.f.total, w.segs);
  const s = list[Math.min(list.length - 1, w.i)];
  syncTlTools();
  const word = v > 1 ? '变窄' : v < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 第 ' + (w.i + 1) + ' 段现在是 ' + spdTxt(v) + '：源 ' + round1(segLen(s))
    + ' 秒 → 成片 ' + round1(segFilmLen(s)) + ' 秒（两条轨的这一段与压在它上面的配音块一起' + word + '）</span>');
  filmEdited();
}
/* 右栏最下面那行的画面分支。倍速按**传进来的那一个**算，不回头读数据：拖动中途数据还没写，
   读 `segSpd(seg)` 就等于「手已经拖到 ×2，那行字还写着上一秒的 ×1」，非要人松手才看到对的数。 */
function segLenText(seg, spd) {
  if (!seg) return '';
  if (isImageSeg(seg)) {
    return '这一段：图片「' + String(seg.imgName || '未命名') + '」占 ' + round1(segLen(seg))
      + ' 秒（拖右把手改时长；静态图没有原声，也没有倍速）';
  }
  if (isVirtualSeg(seg)) return '这一段：空段占 ' + round1(segLen(seg)) + ' 秒（成片里出黑场，没有画面与原声）';
  const r = Math.max(0.25, Math.min(4, Number(spd) || 1));
  const ln = picLnOf(seg), base = laneVol('pic', ln);
  const mix = base !== 1 ? ' · 原声进成片 ' + Math.round(picVolOf(seg) * 100) + '%（段 '
    + Math.round(segVol(seg) * 100) + '% × 第 ' + (ln + 1) + ' 行 ' + Math.round(base * 100) + '%）' : '';
  return '这一段：源 ' + round1(segLen(seg)) + ' 秒 → 成片 '
    + Math.max(0.05, round1(segLen(seg) / r)) + ' 秒（' + spdTxt(r) + '）' + mix;
}
/* 这一句在**成片里**念几秒：块上那行小字、右栏那句读数、`setVoiceSpd` 的回执读的都是这一个除法。
   三处各写一遍就会出现「回执念 0.7 秒而旁边读数还挂着 1 秒」。 */
const voiceSecs = (v, spd) => v ? round1(Math.max(0.1,
  (Number(v.dur) || 0) / (Math.max(0.01, Number(spd) || 1) * voicePicSpd(v)))) : '0';
/* 右栏最下面那行的配音分支（与 `segLenText` 同一立场：倍速按传进来的那一个算）。 */
function voiceLenText(v, spd) {
  if (!v) return '';
  const ln = voiceLn(v), base = laneVol('voice', ln), pic = voicePicSpd(v);
  const r = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, Number(spd) || 1));
  const mix = base !== 1 ? ' · 这一句进成片 ' + Math.round(voiceVolOf(v) * 100)
    + '%（句 ' + Math.round(Number(v.vol == null ? 1 : v.vol) * 100) + '% × 第 ' + (ln + 1) + ' 行 '
    + Math.round(base * 100) + '%）' : '';
  return '这一句：从画面第 ' + round1(Math.max(0, Number(v.at) || 0)) + ' 秒起 · 念 '
    + voiceSecs(v, r) + ' 秒（画面 ' + spdTxt(pic) + ' × 自己 ' + spdTxt(r) + '）' + mix;
}
/* 「这一句现在能不能改倍速」的一句话原因（空串 = 能）：锁 + 有没有指着配音两档走同一条路。
   右栏那枚滑块压暗与 `setVoiceSpd` 入口的硬拒问的都是它 —— 与 `spdWhy` 同一立场：
   「按钮亮着、点下去说什么都不发生」与「按不动却没说为什么」都算承诺与实现分家。 */
function voiceSpdWhy() {
  const why = tlLockWhy();
  if (why) return why + '：倍速不改。' + tlUnlockHow() + '。';
  if (!tlVoiceHit()) return '这一枚改的是配音那一句：先点轨道上的一句声音块（现在指着的是画面那一段）。';
  return '';
}
/* 把「这一句念多快」写进数据，**并把它在轨道上那个框跟着缩放**（用户点名的第 11 条）。
   框（`fa/fb`，源秒、相对所在那一格选区起点）就是这一句「占地方」的那一段 —— 念得快该占得更少。
   从前这里只写 `spd`、框一个字不动，而 `voiceFrameOf` 的兜底只会长框（`fb = max(fb, at + dur/own)`），
   于是 ×2 之后块上那行小字写着「念 0.7 秒」而那块还占着 1.4 秒的地方（界面上「听着快了、看着没变」）。
   缩放只能锚在**选区起点 `at`** 上：整框乘倍数会把这一句的起点一起搬走（×2 之后从画面第 2 秒起
   变成从第 1 秒起 = 改个倍速顺手把时间也改了）。锚在 `at` 上，左、右两块灰按同一个倍数一起缩，
   起点一秒不挪，`at / dur / off` 三个合成字段照旧不动（倍速不改变「从音频第几秒起、念几秒内容」）。
   ⚠ **只有本来就有框的句才缩放，且缩完之后一律留着**（以前「恰好等于选区就把两个键摘掉」）：
     · 本来没有框 = 老数据，它的框按定义就是「跟着选区走的整条音频」（`voiceFrameOf` 现算 `at + dur/own`），
       倍速一变那个现算值自己就跟着变 —— 写一份等于它的数进数据里纯属占位；
     · 本来有框的句要是被摘掉，下一次拖左把手切头就没了「框」这个参照：块会**整体缩小**而不是
       「左沿不动、左边那块灰变宽」（把手的下界正是 `fr.fa`）—— 加进来时定下的那块地方被一次改倍速无声抹平，
       与「拖把手不改框」这条几何纪律直接打架。`fa/fb` 既不进播放计划指纹也不进提交体，留着没有陈旧代价。
   ⚠ 缩放后的两个数**按 0.01 秒收**，不用拖动收尾那把 0.1 秒的尺子（`roundVoice`）：倍速是乘在一个
     已经量化过的数上再乘回去的，0.1 的格子每走一趟最多漏 0.05 再乘上 4 倍 —— 本机实测
     ×1→×2→×4→×1 一圈下来框从 1.2 秒变成 1.4 秒（块比听着的一句长一截）。0.1 那一档只属于手拖的落点。 */
const frame1 = x => Math.round((Number(x) || 0) * 100) / 100;
function voiceSetRate(v, r) {
  const own = voiceRateOf(v);
  const at = Math.max(0, Number(v.at) || 0);
  const fa = Number(v.fa), fb = Number(v.fb);
  if (r !== own && fa >= 0 && fb > fa) {
    const k = own / r;
    /* 左沿只能缩到「这一格选区的起点」（`fa` 的基准就是它，负数=框跑到这一格之前，
       那块灰会画出格子外面）；右沿不设上界 —— 尾巴越过这一格就是跨到后面那一段 / 那一镜。 */
    v.fa = Math.max(0, frame1(at + (fa - at) * k));
    v.fb = Math.max(at + 0.05, frame1(at + (fb - at) * k));
  }
  if (r === 1) delete v.spd; else v.spd = r;
  return own;
}
/* 配音倍速的唯一写点（形状与 setCutSpd / setCutVol 一致：先问闸 → 写数据 → 读数现画 → filmEdited）。
   1 是缺省，所以**删键不写**：旧数据、新数据在指纹里是同一个数，导出过一次的那份成片不会因为
   「多了一个 spd:1」而被判成旧的。 */
function setVoiceSpd(spd) {
  const why = voiceSpdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const v = tlVoiceHit();
  const r = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, Number(spd) || 1));
  voiceSetRate(v, r);
  /* 正在试听的就是这一句 → 当场跟着变（与音量同一立场：拖到哪儿听到哪儿）。 */
  if (voiceElOf() && !voiceElOf().paused && voiceElOf().__vid === v.id) { try { voiceElOf().playbackRate = r; } catch (e) { /* 倍速设不上（元素未就绪）就按当前速度播 */ } }
  /* 三处读数（主读数 / 轨道块上那行小字 / 最下面那句秒数）一起跟着数据走 ——
     从前这里只改主读数，于是「×1.5」配着一句没改口的「念 1 秒」，而 `setCutSpd` 早就调了
     `syncTlTools()`：同一排两枚滑块一个改三处、一个改一处，就是两份口径各漂一处。 */
  syncTlTools();
  const word = r > 1 ? '变窄' : r < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 这一句现在是 ' + spdTxt(r) + '：念 ' + voiceSecs(v, r)
    + ' 秒（画面那一段 ' + spdTxt(voicePicSpd(v)) + '），轨道上这一块' + word + '、起点不动）</span>');
  filmEdited();
}
/* ---------------- 「整轨」那一族：把这一排画出来的每一格 / 每一句都设成**这一枚滑块自己**那一档 ----------------
   用户点名的第 11 条的后半（「调整整轨则整个轨的都进行相应拉长或者收缩」），与 2026-10-16 点名的
   「整轨的倍速与音量应该和段 / 句的分开，可以分别调整」：从前这里是一颗按钮，读的是**旁边那枚滑块的当前档**，
   于是「整排 ×2、这一句仍 ×1」做不到 —— 非先把拇指拖到 ×2 才按得动那颗按钮，而那一步本身已经把指着的那一句
   改成 ×2 了（改一个顺手改了另一个，两件事被拴在同一枚滑块上）。现在整轨自己有枚滑块，各读各的、各写各的。
   范围**跟着页签走**，因为「整条轨」在界面上就是这一排：本镜 = 这一条候选的所有段 / 锚在它上面的所有句，
   全片 = 每一镜选用那一条候选的所有段 / 此刻进得了成片的所有句。
   三条硬纪律：**① 写点只有 `segsWrite` 那一条数据路、`voiceSetRate` 那一份与句上的 `vol`** ——
   这一族只是对着清单把它们各调一遍，不另开一份批量写数据的口径（自己拼 segs 就是「整轨改了、
   音量与行号被抹了」那一类）；**② 闸与段 / 句那一枚同一个**（`spdWhy` / `voiceSpdWhy` / `tlLockWhy`），
   压暗与硬拒分家 = 滑块亮着、拖下去屏幕上一个字都不动；**③「这一排此刻没东西可改」那句话只拼一份**
   （`trackEmptyWhy`）：压暗时写进 title、拖下去时打进回执，两处各写一遍迟早对不上。 */
function trackSegTargets() {
  const out = [];
  if ((projOf().tlTab || 'shot') === 'film') {
    const seen = new Set();
    tlSyncFromShots().clips.forEach(cl => {
      if (!cl || cl.kind !== 'shot') return;
      const sh = allShots().find(x => x.id === cl.shotId);
      const c = sh ? tlCandidateOf(sh, cl.candId) : null;
      if (!c) return;
      const key = sh.id + '::' + c.vid;
      if (seen.has(key)) return;
      seen.add(key);
      const total = candDur(c, sh);
      const segs = segsOf(c, total);
      if (segs.length) out.push({ c: c, total: total, segs: segs });
    });
    return out;
  }
  const w = cutSpdSeg();
  if (w && w.segs.length) out.push({ c: w.f.c, total: w.f.total, segs: w.segs });
  return out;
}
/* 「这一排此刻没有可改的东西」那句原因只拼一份（画卡时压暗的 title 与函数入口的硬拒读的是它）。
   闸（锁 / 指着别的轨）与「没东西」是两类话，合成一句就会在解锁之后仍然说不通。 */
function trackEmptyWhy(k) {
  const film = (projOf().tlTab || 'shot') === 'film';
  return k === 'voice'
    ? '这一排此刻没有可改的配音：' + (film ? '先在候选上点「用这条」，或到「插入语音」合成一句。'
      : '先点轨道上的一句声音块。')
    : (film ? '全片那一排此刻没有格子：先在候选上点「用这条」，这一排才会出现画面段。'
      : '这一镜还没有画面段：先生成或导入一条候选，轨道上才有格子可设。');
}
/* 这一排此刻画出来的所有视频段（「整轨倍速」与「整轨音量」共用同一份清单，不按要改哪个字段分两份）。
   图片段 / 空段不算：它们没有倍速与原声，算进读数会让整轨那两枚滑块显示「不一 · 2 档」——
   而那一档根本不是用户调出来的，也调不回去。写回仍走完整的 `t.segs`（见 setTrackSpd）。 */
const trackSegsNow = () => trackSegTargets().reduce((a, t) => a.concat(t.segs.filter(s => !isVirtualSeg(s))), []);
/* 「这一排是不是都同一档」只在这一处问：一致返回那一个数，不一致返回 null（读数不能替其中一档代言）。 */
function trackOne(vals) {
  const u = [];
  vals.forEach(x => { if (u.indexOf(x) < 0) u.push(x); });
  return { one: u.length === 1 ? u[0] : null, kinds: u.length, first: u.length ? u[0] : null };
}
function setTrackSpd(spd) {
  const why = spdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const list = trackSegTargets();
  /* 「这一排此刻没有格子可改」与「闸没通过」是两句话：`spdWhy()` 走到这里已经必然是空串，
     拿它当回执等于滑块拖到底屏幕上一个字都不动。 */
  if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('pic') + '</span>'); return; }
  const v = Math.max(0.25, Math.min(4, Number(spd) || 1));
  let n = 0;
  list.forEach(t => {
    /* 图片段与空段跳过，但**整份列表照旧写回** —— 只把能调的那些递回 `segsWrite`
       等于把这一条里的图片段整段删掉。 */
    t.segs.forEach(s => { if (isVirtualSeg(s)) return; s.spd = v; n++; });
    segsWrite(t.c, t.total, t.segs);
  });
  if (!n) { setStatus('<span class="err">这一排的画面都是图片段或空段：它们没有倍速可调</span>'); return; }
  syncTlTools();
  const word = v > 1 ? '变窄' : v < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 整条画面轨 ' + n + ' 段（' + list.length
    + ((projOf().tlTab || 'shot') === 'film' ? ' 镜' : ' 条候选')
    + '）都设成 ' + spdTxt(v) + '：这一排的每一格一起' + word + '，源秒与入出点不动）</span>');
  filmEdited();
}
/* 配音那一侧的「整轨」：范围与画出来的块同一份判据（本镜 = `shotVoices`，全片 = 能算出 `voiceFilmSpan`
   的那几句 —— 挂在没被选用的候选上的孤句这一排根本不画，改它等于背着一句没说出口的话动手）。 */
function trackVoiceTargets() {
  if ((projOf().tlTab || 'shot') !== 'film') {
    const v = tlVoiceHit();
    if (!v) return [];
    return shotVoices(v.shotId, v.candId);
  }
  return voicesEnsure().filter(x => !!voiceFilmSpan(x));
}
function setTrackVoiceSpd(spd) {
  const why = voiceSpdWhy();
  if (why) { setStatus('<span class="err">' + why + '</span>'); return; }
  const list = trackVoiceTargets();
  if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('voice') + '</span>'); return; }
  const v = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, Number(spd) || 1));
  list.forEach(x => voiceSetRate(x, v));
  if (voiceElOf() && !voiceElOf().paused && list.some(x => x.id === voiceElOf().__vid)) { try { voiceElOf().playbackRate = v; } catch (e) { /* 倍速设不上（元素未就绪）就按当前速度播 */ } }
  syncTlTools();
  const word = v > 1 ? '变窄' : v < 1 ? '变宽' : '复原';
  setStatus('<span class="ok">✓ 整条配音轨 ' + list.length + ' 句都设成 ' + spdTxt(v)
    + '：每一块一起' + word + '，各句起点与时长一个字不动）</span>');
  filmEdited();
}
/* 「整轨音量」：把这一排此刻画出来的每一段 / 每一句**自己的**音量都设成这一档（用户点名的
   「整轨与段 / 句分开、可以分别调整」的音量那一半 —— 倍速那一半在上面那两个 `setTrack*Spd`）。
   改谁跟着手走：指着配音就改句、指着画面就改段，与上面那枚「这一段 / 这一句音量」共用同一份
   `tlVoiceHit()` 判据，不在这里留第二份「现在改谁」。
   它与「那一行的基数」是两件事：基数是乘在每一份之上的那一个数（`laneVol`），这一枚改的是那一些数本身。
   写点仍只有那两条：段走 `segsWrite`、句走 `paintVoiceVol` 现画块上那一层颜色，
   乘算只在 `picVolOf` / `voiceVolOf` 一处 —— 这里不碰那两份。 */
function setTrackVol(vol, lane) {
  /* 左列那枚滑块**自己点名**改哪一轨（用户点名的第 ② 条：轨道左边的音量 = 整轨音量）。
     右栏那枚不传 lane，仍跟着「此刻指着谁」走。两处写的是同一批字段，闸却要各问各的轨：
     指着配音时去调画面轨那枚，拿 tlLockWhy 会把配音轨的锁算到画面头上。 */
  const k = lane === 'voice' || lane === 'pic' ? lane : (tlVoiceHit() ? 'voice' : 'pic');
  const why = lane ? (laneLocked(k) ? '整条' + laneNm(k) + '已锁定：整轨音量不调。' : '') : tlLockWhy();
  if (why) { setStatus('<span class="err">' + why + (lane ? rowUnlockHow(k, 0) + '。' : '：音量不调。' + tlUnlockHow() + '。') + '</span>'); return; }
  const n = Number(vol);
  const r = Math.max(0, Math.min(2, isFinite(n) ? n : 1));
  const pct = Math.round(r * 100) + '%';
  if (k === 'voice') {
    const list = trackVoiceScope();
    if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('voice') + '</span>'); return; }
    list.forEach(x => { x.vol = r; });
    document.querySelectorAll('#tlBar .tl-lane').forEach(l => list.forEach(x => paintVoiceVol(l, x)));
    /* 正在响的那一句就在这一排里 → 按**合成后**的数当场改口（拖到哪儿听到哪儿；浏览器给 <audio> 封顶 1，
       超出 100% 的部分只在合并时生效）。 */
    if (voiceElOf() && !voiceElOf().paused) {
      const cur = list.filter(x => x.id === voiceElOf().__vid)[0];
      if (cur) { try { voiceElOf().volume = Math.max(0, Math.min(1, voiceVolOf(cur))); } catch (e) { /* 播放器此刻拒设音量就保持原音量，不打断播放 */ } }
    }
    syncTlTools();
    if (!lane) { setStatus('<span class="ok">✓ 整条配音轨 ' + list.length + ' 句自己的音量都设成 ' + pct
      + '（与上面那枚各调各的；进成片还要乘所在那一行的基数）</span>'); }
    else { setStatus('<span class="ok">✓ 整条配音轨 ' + list.length + ' 句自己的音量都设成 ' + pct
      + '（每一句现在指着谁都不影响这一枚；进成片还要乘所在那一行的基数）</span>'); }
    filmEdited();
    return;
  }
  const list = trackSegTargets();
  if (!list.length) { setStatus('<span class="err">' + trackEmptyWhy('pic') + '</span>'); return; }
  let cnt = 0;
  list.forEach(t => {
    /* 同 setTrackSpd：图片段 / 空段没有原声，跳过；列表整份写回，不删段。 */
    t.segs.forEach(s => { if (isVirtualSeg(s)) return; s.vol = r; cnt++; });
    segsWrite(t.c, t.total, t.segs);
  });
  if (!cnt) { setStatus('<span class="err">这一排的画面都是图片段或空段：它们没有原声可调</span>'); return; }
  syncTlTools();
  const w = cutSpdSeg();
  const pl = document.getElementById('player');
  if (pl && w) { try { pl.volume = Math.min(1, picVolOf(w.segs[w.i])); } catch (e) { /* 画面段音量设不上就按原音量继续，不中断 */ } }
  setStatus('<span class="ok">✓ 整条画面轨 ' + cnt + ' 段（' + list.length
    + ((projOf().tlTab || 'shot') === 'film' ? ' 镜' : ' 条候选') + '）原声都设成 ' + pct
    + '（与上面那枚各调各的；'
    + (r > 1 ? '超过 100% 的部分只在合并成片时生效' : '进成片还要乘所在那一行的基数') + '）</span>');
  filmEdited();
}
/* 右栏那张「这一段 / 这一句」卡的就地重画：只由 syncTlTools 调（它已经算好了目标），
   这里不自己再判一遍「指着谁」—— 两处各判一次就可能出现芯片与滑块各说一件事。
   `v` = 现在指着的那一句配音（不是配音就 null），`seg` = 现在指着的那一段画面（没有就 null）。
   最下面那两枚「行音量」问的是**目标所在那一行**的锁（`rowLocked`：整条轨锁着时每一行都锁），
   不是芯片指着谁就锁谁：锁住画面轨不会把配音轨那枚一起按死（锁不牵连），
   只锁了第 3 行也不会挡住第 1、2 行的基数。
   ── 这一张卡（含它旁边轨道上的措辞）只有五个名词，新增一排控件时照这张表取名，
      别再为同一个东西起第六个别名（用户点名的第 26 条：「段 / 格 / 条」三种叫法混在一排里，
      看着像三个不同的东西各有自己的一枚滑块）：
        段 = 画面轨上被切出来的一段（`c.segs` 的一条）→「这一段」
        句 = 配音轨上的一句配音（`projOf().voices` 的一条）→「这一句」
        行 = 一条轨里的一条横带（`ln`，只决定画在哪，不决定时间）→「第 N 行」
        轨 = 画面轨 / 配音轨整一条（锁、收起、基数音量都有「轨级」与「行级」两档）
        镜 = 一条候选镜头（`candidates` 的一条）→「这一镜」，不用「这一条」
      「格 / 格子」只留给**轨道上那个看得见的方块**这一层（「删掉之后格子还在原位、原地变黑场」说的就是它），
      不再拿来当「段」的别名；「颗 / 枚」的分工是按钮用颗、滑块用枚。 */
function paintTlAdjust(v, seg) {
  const card = document.getElementById('tlAdj');
  if (!card) return;
  /* 三种口径先各就各位（用户点名的第 20 条：以前「音量」那一排与「画面轨 / 配音轨」那一排
     标签都只写「音量」，看着像同一件事的两个入口，而它们一个是**这一段 / 这一句自己**、
     一个是**它所在那一行的基数**，两者相乘才进成片）。标签与 title 都按此刻指着谁现写：
     点画面格说「段」，点配音块说「句」；两个乘起来是多少写在最下面那行读数里。 */
  const labOf = (id, t) => { const el = document.getElementById(id); if (!el) return; el.textContent = t;
    // 标签叫什么，旁边那枚控件在读屏里就叫什么（以前静态 aria-label 一直停在「音量」，
    // 界面上已经写「这一段音量 / 这一句音量」了，读出来还是那个分不清归属的老词）。
    const nx = el.nextElementSibling;
    const sl = nx && nx.querySelector ? nx.querySelector('input') : null;
    if (sl) sl.setAttribute('aria-label', t); };
  const volBox = document.getElementById('tlVolBox');
  if (seg && isVirtualSeg(seg)) {
    labOf('tlVolLab', isImageSeg(seg) ? '图片段没有原声' : '空段没有原声');
    if (volBox) volBox.title = '图片段与空段都没有原声：这一枚不调';
  } else if (seg) {
    labOf('tlVolLab', '这一段音量');
    if (volBox) volBox.title = '这一段画面的音量（0–200%，无级）：进成片还要乘所在那一行的基数';
  } else if (v) {
    labOf('tlVolLab', '这一句音量');
    if (volBox) volBox.title = '这一句配音的音量（0–200%，无级）：进成片还要乘所在那一行的基数';
  } else {
    labOf('tlVolLab', '音量');
    if (volBox) volBox.title = '先在轨道上点一段画面或一句配音：这一枚调的是那一个自己的音量，不是整条轨';
  }
  const whySpd = spdWhy();
  const box = document.getElementById('tlSpdBox');
  const spdSl = document.getElementById('tlSpd');
  const spdRd = document.getElementById('tlSpdVal');
  const curSpd = seg ? segSpd(seg) : 1;
  if (box) box.classList.toggle('off', !!whySpd);
  if (spdSl) { spdSl.disabled = !!whySpd; spdSl.value = String(Math.round(curSpd * 20) / 20); }
  if (spdRd) spdRd.textContent = spdTxt(curSpd);
  /* 配音那一侧的倍速（第 ③ 条）：读数与压暗都在这一处现算，
     与 `setVoiceSpd` 的闸、回执读同一份 `voiceRateOf` / `voicePicSpd` —— 不留第二份口径。
     指着画面段时这一枚压暗并写明它管的是配音（两块本来互斥，这里只是把「按不动」说清楚）。 */
  const vBox = document.getElementById('tlVoiceSpdBox');
  const vSpdSl = document.getElementById('tlVoiceSpd');
  const vSpdRd = document.getElementById('tlVoiceSpdVal');
  const whyVSpd = voiceSpdWhy();
  const curVSpd = v ? voiceRateOf(v) : 1;
  if (vBox) vBox.classList.toggle('off', !!whyVSpd);
  if (vSpdSl) vSpdSl.disabled = !!whyVSpd;
  if (vSpdSl) vSpdSl.value = String(Math.round(curVSpd * 20) / 20);
  if (vSpdRd) vSpdRd.textContent = spdTxt(curVSpd);
  /* 三枚「整轨」滑块与段 / 句那几枚**各读各的、各写各的**（用户点名要分开的正是这一对）：
     闸仍是那一份（`spdWhy` / `voiceSpdWhy` / `tlLockWhy`）—— 闸分写两处就会出现
     「那一枚拖不动、这一枚照样能拖，一拖批改了整排」。
     读数问的是「这一排此刻是不是都同一档」（`trackOne`）：不一致就写「不一 · N 档」，
     不替其中一档代言（把第 1 段的 ×1 写成整排的档，等于界面在说一件这一排并不满足的话）；
     不一致时滑块停在**第一个数**上，拖下去以它为起点是可预期的。
     title 里那句范围跟着页签现写 —— 「整条轨」在界面上就是**此刻这一排**，
     本镜与全片装的段数不是一回事，写死一句就是假话。 */
  const filmTab = (projOf().tlTab || 'shot') === 'film';
  const scopePic = filmTab ? '每一镜选用那一条候选的所有段' : '这一条候选的所有段';
  const scopeVoice = filmTab ? '此刻进得了成片的所有句' : '这一条候选上的所有句';
  const SPD_OPTS = { def: 1, defRd: '×1', toSl: x => Math.round(x * 20) / 20, fmt: spdTxt };
  const VOL_OPTS = { def: 1, defRd: '100%', toSl: x => Math.round(x * 1000) / 10, fmt: x => Math.round(x * 100) + '%' };
  const ownVol = x => (v ? Number(x.vol == null ? 1 : x.vol) : segVol(x));
  const trackPaint = (kind, boxId, slId, rdId, vals, why, scope, o) => {
    const bx = document.getElementById(boxId), sl = document.getElementById(slId), rd = document.getElementById(rdId);
    if (!sl || !rd) return;
    const t = trackOne(vals);
    const gap = vals.length ? '' : trackEmptyWhy(kind);
    const off = !!why || !!gap;
    if (bx) {
      if (!bx.dataset.base) bx.dataset.base = bx.title;
      bx.classList.toggle('off', off);
      bx.title = why || gap || (bx.dataset.base + '（' + scope + '）');
    }
    sl.disabled = off;
    sl.value = String(o.toSl(vals.length ? (t.one === null ? vals[0] : t.one) : o.def));
    rd.textContent = !vals.length ? o.defRd
      : (t.one === null ? '不一 · ' + t.kinds + ' 档' : o.fmt(t.one));
  };
  const trSegs = trackSegsNow(), trVoices = trackVoiceTargets();
  trackPaint('pic', 'tlSpdTrackBox', 'tlSpdTrack', 'tlSpdTrackVal',
    trSegs.map(segSpd), whySpd, scopePic, SPD_OPTS);
  trackPaint('voice', 'tlVoiceSpdTrackBox', 'tlVoiceSpdTrack', 'tlVoiceSpdTrackVal',
    trVoices.map(voiceRateOf), whyVSpd, scopeVoice, SPD_OPTS);
  trackPaint(v ? 'voice' : 'pic', 'tlVolTrackBox', 'tlVolTrack', 'tlVolTrackVal',
    (v ? trVoices : trSegs).map(ownVol), tlLockWhy(), v ? scopeVoice : scopePic, VOL_OPTS);
  const lenEl = document.getElementById('tlAdjLen');
  /* 那一行上的音量：压暗与硬拒问的都是**自己那一轨**的锁（画面轨锁着时配音轨照样能调 —— 锁不牵连）。
     读数问的是「目标所在那一行」的基数，不在这里留第二份：芯片指着第 2 行的时候把滑块拖到 60%，
     调的就该是第 2 行 —— 调整轨会把第 1 行刚调好的那一个数盖掉。 */
  const lanePct = x => Math.round(x * 100) + '%';
  const laneRow = (k, slId, rdId, boxId, rwId) => {
    const ln = k === 'voice' ? (v ? voiceLn(v) : 0) : (seg ? picLnOf(seg) : 0);
    const why = laneVolWhy(k, ln);
    const sl = document.getElementById(slId), rd = document.getElementById(rdId), bx = document.getElementById(boxId);
    const rw = document.getElementById(rwId);
    const val = laneVol(k, ln);
    if (bx) bx.classList.toggle('off', !!why);
    if (bx) {
      /* 原文案只在标记里写一份：第一次把这句存到节点上，之后锁着就换成原因、解锁就换回来。
         直接 `bx.title = why || bx.title` 会把原因永久盖成新的「原文案」，解锁后界面还在说锁着。 */
      if (!bx.dataset.base) bx.dataset.base = bx.title;
      bx.title = why || bx.dataset.base;
    }
    if (sl) { sl.disabled = !!why; sl.value = String(Math.round(val * 1000) / 10); sl.dataset.ln = String(ln); }
    if (rd) rd.textContent = lanePct(val);
    if (rw) rw.textContent = '第 ' + (ln + 1) + ' 行';
    return { ln: ln, vol: val };
  };
  laneRow('pic', 'laneVolPic', 'laneVolPicVal', 'lanePicBox', 'lanePicRow');
  laneRow('voice', 'laneVolVoice', 'laneVolVoiceVal', 'laneVoiceBox', 'laneVoiceRow');
  /* 换行那两颗管的是**芯片指着的这一个东西**（与上面两枚「按行的音量」读同一个 `ln`）：
     在轨道上直接上下拖也能换行，这两颗是拖不准时的出口。压暗判据只有 `laneWhy()` 一份。 */
  const cl = cutLaneOf();
  const whyLn = laneWhy();
  const clRow = document.getElementById('cutLaneRow');
  if (clRow) clRow.textContent = cl ? '第 ' + (cl.ln + 1) + ' 行 · ' + (cl.k === 'voice' ? '配音' : '画面')
    : '还没有指着可以换行的东西';
  [[document.getElementById('laneUp'), -1], [document.getElementById('laneDown'), 1]].forEach(pair => {
    const b = pair[0];
    if (!b) return;
    if (!b.dataset.base) b.dataset.base = b.title;
    b.disabled = !!whyLn;
    b.title = whyLn || b.dataset.base;
  });
  /* 最下面那行读数：画面那句与配音那句各收在一份函数里（`segLenText` / `voiceLenText`），
     拖动中的 `input` 调的是同一份 —— 从前这两句写在模板里，拖动时只有主读数改口，
     于是「×1.5」配着一句还写着「念 1 秒」，同一个组件里两个数互相打架。
     那半句「进成片 = 段 / 句 × 行」只在行基数不是 100% 时才说，平时那一句读数已经够长。 */
  if (lenEl) lenEl.textContent = seg ? segLenText(seg, curSpd)
    : (v ? voiceLenText(v, curVSpd)
      : '这一镜还没有画面段：按 Ctrl+Z 退回到剪切之前，或按「切开」重新分一段，再来调音量与倍速。');
}
/* 右栏那张卡按**目标轨**分档（用户点名的第 5 条）：点着画面只留倍速与画面轨那一行，
   点着配音只留配音轨那一行（音量 + 它自己的倍速）与「加一句配音」那一整块。判据只有 `tlPanel()` 一份，落点只有这一处
   （syncTlTools 每次换目标、每次重画都走到，右栏初次渲染末尾也调它）。
   只翻 `hidden`、节点不销毁：那些滑块的绑定在整栏渲染时一次做完，重建会把正在拖的那只手底下的
   节点换掉，也会把刚敲了一半的台词清空。 */
function paintTlGroups() {
  const voice = tlPanel() === 'voice';
  const hide = (id, yes) => { const el = document.getElementById(id); if (el) el.hidden = !!yes; };
  /* 配音那一侧再分四格（用户点名的第 ③ 条）：不点过 = 这一镜上的配音，点中一句 = 音量与倍速，
     点台词 = 台词那一档，点空白 / 待生成占位 = 生成配音。`vcTabOf()` 只有这四个取值，别的地方不写第五种。 */
  const tab = voice ? (vcTabOf() === 'adj' || vcTabOf() === 'gen' || vcTabOf() === 'sub' || vcTabOf() === 'lines' ? vcTabOf() : 'list') : '';
  hide('vcTabs', !voice);
  hide('tlAdj', voice && tab !== 'adj');
  hide('grpPic', voice);
  hide('grpVoice', !voice || tab !== 'adj');
  hide('grpLines', !voice || tab !== 'lines');
  hide('grpVoiceAdd', !voice || tab !== 'gen');
  hide('grpVoiceList', !voice || tab !== 'list');
  hide('grpSub', !voice || tab !== 'sub');
  const titles = { list: '这一镜上的配音', adj: '音量与倍速', lines: '台词', gen: '加一句配音', sub: '字幕' };
  const t = document.getElementById('edTitle');
  if (t) t.textContent = voice ? titles[tab] : '这一段画面';
  document.querySelectorAll('#vcTabs [data-vctab]').forEach(b => {
    const on = b.dataset.vctab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const l = document.getElementById('edLane');
  if (l) l.textContent = laneNm(voice ? 'voice' : 'pic');
}
/* 「试听 / 切开」那一排的下一行：**只读**选中的那一句配音（用户点名的第 ① 条）。
   判据与右边那张卡同一个 `v`（syncTlTools 里的 tlVoiceHit），所以「卡片说在调这一句」与
   「这一行写的是这一句」永远是同一条。指着画面段 / 什么都没选中时整行收起。
   文字取整句、不截断 —— 这一行存在的意义就是看全这一句要念什么。 */
function paintVoiceLine(v) {
  const row = document.getElementById('tlVoiceLine');
  if (!row) return;
  if (!v) { row.hidden = true; return; }
  const who = document.getElementById('tlVoiceWho');
  const tx = document.getElementById('tlVoiceText');
  const tm = document.getElementById('tlVoiceTime');
  const name = String(v.who || v.name || '').replace(/\s+/g, ' ').trim();
  const text = String(v.text || '').replace(/\s+/g, ' ').trim();
  /* 说话人与正文是同一句时**只印一遍**（用户点名的第 ③ 条）：
     `who` / `name` 常常就是这句台词本身，两格各印一次会读成「21212121 21212121」。
     正文框在没台词时本来就会退回名字，所以「名字那一格」只在两者确实不同时才画。 */
  const dup = !!name && (!text || name === text);
  if (who) { who.textContent = dup ? '' : name; who.hidden = dup || !name; }
  if (tx) tx.textContent = text || name || '（这一句没有文字）';
  if (tm) {
    const segNo = (Number(v.seg) || 0) + 1;
    const at = Number(v.at) || 0;
    const dur = Number(v.dur) || 0;
    tm.textContent = '第 ' + segNo + ' 段 · ' + at.toFixed(1) + ' 秒起 · 念 ' + dur.toFixed(1) + ' 秒';
  }
  row.hidden = false;
}
/* 把「此刻指着谁」写到条上：目标芯片、试听按钮的显隐、每一颗的 title、滑块读数，
   再加右栏那张卡（音量 / 倍速两档）。几件事同一出口 —— 分开写就会出现
   「芯片写着配音、按钮切的是画面」，也会写出「芯片指着一格画面、卡上还是上一句配音的音量」。 */
function syncTlTools() {
  const listen = document.getElementById('tlListen');
  const box = document.getElementById('tlVolBox');
  const sl = document.getElementById('tlVol');
  const rd = document.getElementById('tlVolVal');
  const v = tlVoiceHit();
  let vol = 1, picGray = false, seg = null;
  if (v) {
    vol = Number(v.vol == null ? 1 : v.vol);
  } else {
    const p = tlFocusPos();
    seg = p.seg;
    vol = seg ? segVol(seg) : 1;
    picGray = !!seg && !!seg.off;
  }
  /* 图片段 / 空段没有原声：音量滑块压暗（与倍速那几枚同一立场，按不动就说得出原因）。 */
  const silent = !!seg && isVirtualSeg(seg);
  if (listen) listen.hidden = !v;
  if (box) box.classList.toggle('off', !!tlLockWhy() || silent);
  if (sl) { sl.disabled = !!tlLockWhy() || silent; sl.title = silent ? '图片段 / 空段没有原声：音量不调' : ''; }
  if (sl) sl.value = String(Math.round(vol * 100 * 10) / 10);
  if (rd) rd.textContent = Math.round(vol * 100) + '%';
  /* 右栏那张卡：两枚滑块跟着闸走（锁 / 指着配音 / 没有画面段三种都写得出原因），
     读数一律从目标上现算 —— 不留第二份口径。 */
  paintTlAdjust(v, seg);
  paintVoiceLine(v);
  paintTlGroups();
  /* 入出点那一行（正在调谁、起止几秒、能不能直接输数字）也跟着目标走：
     以前它只挂在「点了一格画面」那条路上，点一句配音 / 全片跳回来它就停在上一条。 */
  paintTrimRow();
  const who = v ? '这一句配音' : '插针那一段画面';
  const tips = {
    split: '在插针处把' + who + '切成两段（' + (v ? '画面不动' : '两段的音量都跟着带走') + '）',
    left: '丢掉插针左边的' + (v ? '声音' : '画面') + '（' + who + '从插针开始）',
    right: '丢掉插针右边的' + (v ? '声音' : '画面') + '（' + who + '到插针为止）',
    drop: v ? '删掉这一句配音（画面不动）'
      : picGray ? '把这一段的画面放回来：它现在出黑，格子还留在原位，恢复后按选区出画面'
        : '删掉插针所在的那一段（格子不消失，原地变成黑场占位，后面的段一个都不前移 —— 这一段上的配音照放并在音轨上变色）',
    merge: '把' + who + '与旁边挨着的那一段合回一段（只对「一刀切开、没再动过」的两段有效）',
    gap: '在插针处插一段空（轨道上多一格灰格，成片里那几秒是黑的、占时间；与「删掉」不同，这段空可以整段摘掉）',
    close: '把选中的空段整段摘掉（成片里那几秒消失，后面的段前移）',
  };
  /* 空段那一支只对**画面段**目标开（配音句没有「插空 / 摘空」两支）；
     「摘掉空段」只在当前选中的段真的是空段时可见（`isGap`）——
     显隐只在 syncTlTools 一处，别处不许再改一遍。 */
  const isVoiceTarget = !!v;
  const segIsGap = !!seg && isGap(seg);
  document.querySelectorAll('#tlTools [data-cut]').forEach(b => {
    const k = b.dataset.cut;
    if (tips[k]) b.title = tips[k];
    if (k === 'play') b.title = '试听' + who + '（听的就是留在成片里的那一段）';
    if (k === 'gap') b.hidden = isVoiceTarget;
    if (k === 'close') b.hidden = isVoiceTarget || !segIsGap;
    /* 指着黑场那一段时「删掉」这颗改口成「恢复画面」：段并没有被删（还在原位、只是出黑），
       再写「删掉」就是界面在撒谎，而它同时是用户把画面找回来的唯一出口。
       带图标的按钮**不能用 textContent 改字**（那会把里面那枚 svg 一起抹掉），整段重画。 */
    if (k === 'drop' && !v) {
      b.innerHTML = icon(picGray ? 'refresh' : 'trash', 13) + (picGray ? ' 恢复画面' : ' 删掉');
      b.classList.toggle('danger', !picGray);
    }
    /* 锁上的那一轨：除试听外每一颗当场压暗并把原因写进 title（试听不压 —— 锁拦的是「改」，不是「听」）。
       判据就是 runCut 里那一份 tlLockWhy，不在这里再拼一遍 projOf().lane。 */
    if (k !== 'play') {
      const lk = !!tlLockWhy();
      b.disabled = lk;
      if (lk) b.title = tlLockWhy() + '：' + b.title;
    }
  });
}

  return {
    tlDuration,
    tlCandidateOf,
    candDur,
    filmFrames,
    axisGray,
    filmLayGray,
    frameToSrc,
    srcToFrame,
    shotFrames,
    shotRowAt,
    shotPinT,
    shotAxTotal,
    voiceAxBox,
    voiceFilmSpan,
    voiceFilmWhy,
    voiceAdoptable,
    fillWaveforms,
    videoPeaks,
    drawSegWave,
    fillSegWaveforms,
    voiceBlockHTML,
    cutSegIdx,
    curSegOf,
    candSelected,
    voicesEnsure,
    shotVoices,
    clipVoices,
    dragBusy,
    dragOnWindow,
    reanchorVoices,
    cutSegs,
    cutPin,
    tlCutTarget,
    tlVoiceHit,
    voiceSelId,
    picSelOn,
    picSelAt,
    tlFocusPos,
    laneLocked,
    laneHidden,
    rowHidden,
    rowLocked,
    laneNm,
    rowNm,
    rowLockWhy,
    rowUnlockHow,
    rowFlagToggle,
    laneVol,
    laneRowsOf,
    laneRowsFor,
    LANE_ROW_SEL,
    addLaneRow,
    voiceLanePlan,
    dropLaneRow,
    voiceSplitByMaterial,
    voiceMergeAll,
    setCellLane,
    addImageToTrack,
    laneMute,
    trackOwnVol,
    laneMuteToggle,
    picVolOf,
    moveShotInFilmOrder,
    tlSyncFromShots,
    voiceVolOf,
    setLaneVol,
    laneToggle,
    focusVoiceShot,
    runCut,
    setCutVol,
    setCutLane,
    cutSpdSeg,
    setCutSpd,
    segLenText,
    voiceLenText,
    setVoiceSpd,
    trackOne,
    setTrackSpd,
    setTrackVoiceSpd,
    setTrackVol,
    paintTlGroups,
    syncTlTools,
  };
}
