/* 导演台Lanes域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createLanes(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1, pct, spdTxt } from '../util.js';
import { sliceBoxHTML } from '../slice.js';
import { SEG_MIN, segLen, segFilmLen, segsOf, segsCopy, segsWrite, laneClamp, tlClipDur } from '../segments.js';
import { lineEstSec, lineSpanAt } from '../voice-layout.js';
import { linePointOf, linePointClamp, linePointSet } from '../line-point.js';

export function createLanes(E, document, window) {
  const {
    $,
    TlPlayOf,
    projOf,
    allShots,
    curShot,
    fmtDur,
    shotDurText,
    trimStatus,
    tlCandidateOf,
    candDur,
    filmFrames,
    axisGray,
    frameToSrc,
    srcToFrame,
    shotFrames,
    shotRowAt,
    shotPinT,
    shotAxTotal,
    voiceAxBox,
    fillWaveforms,
    voiceBlockHTML,
    cutSegIdx,
    shotVoices,
    dragOnWindow,
    reanchorVoices,
    cutPin,
    beginEdit,
    chosenCandOf,
    setPin,
    pinFilmTShot,
    sliceUserTouch,
    paintTrimRow,
    picSelOn,
    picSelAt,
    laneHidden,
    rowHidden,
    rowLocked,
    laneNm,
    rowLockWhy,
    rowUnlockHow,
    laneRowsOf,
    laneRowsFor,
    setCellLane,
    moveShotInFilmOrder,
    tlSyncFromShots,
    paintTlGroups,
    syncTlTools,
    sliceForgetFail,
    fillSlices,
    filmEdited,
    subLaneHTML,
    filmSubLaneHTML,
    bindSubLanes,
    scheduleSave,
    renderScenes,
    midEditTrimOf,
    trackDragTOf,
    picLaneStep,
    dragGhostShow,
    dragGhostMove,
    dragGhostHide,
    bindSegDrag,
    candTrackSrc,
    segLabel,
    paintPin,
    bindPinZone,
    paintTlHint,
    orphanVoices,
    lanePut,
    voiceLanesHTML,
    syncLaneSide,
    voiceLaneHTML,
    bindVoiceLane,
    paintVoiceSel,
    dropPicSel,
    TL_MAX_ZOOMOf,
    tlMinPps,
    TL_MIN_PPSOf,
    tlPpsOf,
    tlScrollWantOf,
    voiceDraftOf,
    setVcTab,
    voiceWayOf,
    paintVoicePos,
    voiceReg,
    renderEditor,
    renderAll,
    setStatus,
    setTlPps,
    setTrackDragT,
    setTlScrollWant,
  } = E;

function tlCurrentPps(total, barEl) {
  const T = Math.max(0.1, Number(total) || 0);
  if (tlPpsOf()) return Math.max(tlMinPps(T), Math.min(TL_MAX_ZOOMOf(), tlPpsOf()));
  const avail = (barEl && barEl.clientWidth) ? barEl.clientWidth : 0;
  const fit = avail > 0 ? avail / T : 0;
  return Math.max(TL_MIN_PPSOf(), fit || TL_MIN_PPSOf());
}
/* 内容层的宽度 = 总时长 × 像素/秒，**一个都不再多撑**：
   缩到比轨道短就是比轨道短（右边那段空白是这一档存在的理由）。 */
const tlInnerWidth = (total, pps) => Math.max(1, Math.round(Math.max(0.1, Number(total) || 0) * (Number(pps) || 0)));
/* 读数别用 `Math.round`：不到 1px/秒时它会说「0 px/秒」，而那一排明明还在画。按数量级给小数。 */
const tlPpsText = p => (p >= 10 ? String(Math.round(p)) : p >= 1 ? (Math.round(p * 10) / 10).toFixed(1) : (Math.round(p * 100) / 100).toFixed(2));
/* 缩放时想保持在视野中心的那一秒（重画之后用它把滚动位置放回去）—— -1 = 不还原 */
let tlAnchorT = -1;
/* 这一轮重画要还原的滚动偏移（整列每 3 秒重建一次，不还原的话每 3 秒都会被弹回最左边） */

/* 刻度尺：给一条时间基（本镜 = 这一排的轴秒，全片 = 成片秒）画若干道线 + 秒数。
   两排都是「框 ÷ 倍速」之后的那把尺子，不是源秒 —— 递进来的 `total` 由调用方按页签现算
   （`shotAxTotal` / `filmFrames().total`），所以倍速一变刻度跟着变密或变疏，一格都不用改这里。
   档位要吃两头的约束，别只顾一头：
     · 像素那一头 —— 每档至少 ~56px，否则标签会叠在一起；
     · 档数那一头 —— 至少 4 档（3 秒的短镜头也得看得见刻度）、最多 12 档。
   以前只按「≤10 档」挑，缩放到很宽时每档会拉开到几百像素（一条刻度孤零零挂在中间）。 */
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 2.5, 5, 10, 15, 30, 60, 120, 300];
function rulerStep(total, pps) {
  const T = Math.max(0.1, Number(total) || 0);
  const byPx = RULER_STEPS.find(x => x * pps >= 56) || RULER_STEPS[RULER_STEPS.length - 1];
  const byCount = RULER_STEPS.slice().reverse().find(x => T / x >= 4) || RULER_STEPS[0];
  return Math.max(Math.min(byPx, byCount), T / 12);       // 再夹一道「不超过 12 档」
}
/* 主档之外再算一次次档（照参考项目：minorStep = majorStep / 4）。
   但**只有画得开才画** —— 一格 15px 时四道次档会把主档那根通高线淹了，
   所以按「次档间距 ≥ 14px」现判，画不开就回 0（这一档整条不画，不是画了再藏）。 */
function rulerScale(total, pps) {
  const major = rulerStep(Math.max(0.1, Number(total) || 0), pps);
  const minor = major / 4;
  return { major, minor: (minor * (Number(pps) || 0) >= 14) ? minor : 0 };
}
/* 秒数的写法：整秒不带小数点，其余保留一位（0.5 / 1.5 / 12） */
const rulerText = t => (Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : String(Math.round(t * 10) / 10)) + 's';
function rulerHTML(total, pps) {
  const T = Math.max(0.1, Number(total) || 0);
  const sc = rulerScale(T, pps);
  const step = sc.minor || sc.major;                 // 有次档就按次档走一遍（主档在其中挑出来打标）
  /* 缩到比整条轨道还短是现在允许的（用户点名取消下限），于是「主档只值两三个像素」这种档位真会出现。
     那时标签必然叠成一坨 —— **只画线、不写字**，最左那一档照样写 0（不写就看不出这条从哪儿起）。 */
  const labelOk = sc.major * (Number(pps) || 0) >= 34;
  const n = Math.max(1, Math.floor(T / step + 1e-6));
  /* 尺也照下面那两行轨道补到**看得见的那一段**（用户点名「时间轴下没有画面或配音的地方照样应该有时间段」）：
     轨道比整条短时，右边那一大片从前只有尺底下的空白 —— 线只画到 100% 那一头。
     延长那几道**只画线、不写秒数**：越过总长之后的每一个数都是编的（这一段压根不在成片里），
     而画暗一点是那句「这里没有内容」的一部分，与轨道里那两块被剪掉的灰同一个立场。
     `dx` 按**像素**递出去而不是百分比 —— `pct()` 钳在 0–100，拿它算超过总长的落点会全挤在最右那一根上。 */
  const barEl = document.getElementById('tlBar');
  const avail = barEl ? (barEl.clientWidth || 0) : 0;
  const extPx = Math.max(0, avail - tlInnerWidth(T, pps));
  let h = '<div class="tl-ruler">';
  for (let k = 0; k <= n; k++) {
    const t = Math.round(Math.min(T, k * step) * 100) / 100;
    /* 「是不是主档」按**除法取整**判，不拿浮点数比相等：0.1×3 = 0.30000000000000004，
       比 `t % major === 0` 会让整除的那些档全变成次档（一条线都没有标签）。 */
    const mj = Math.abs(t / sc.major - Math.round(t / sc.major)) < 1e-6;
    /* 恰好落在最右那一档（总时长是档位的整数倍时会有）：标签改挂线左边，
       否则它伸出内容层，多出来一条几像素的横向滚动。 */
    const end = mj && t >= T - 1e-6;
    h += '<span class="tk' + (mj ? ' mj' : '') + (end && labelOk ? ' te' : '') + '" style="left:' + pct(t, T) + '%">'
      + (mj && (labelOk || k === 0) ? '<span class="tkl">' + rulerText(t) + '</span>' : '') + '</span>';
  }
  const p = Number(pps) || 0;
  for (let t = T + step; p > 0 && (t - T) * p <= extPx; t += step) {
    h += '<span class="tk' + (Math.abs(t / sc.major - Math.round(t / sc.major)) < 1e-6 ? ' mj' : '') + ' xt" style="left:calc(100% + '
      + Math.round((t - T) * p) + 'px)"></span>';
  }
  return h + '</div>';
}
/* 把这一页签的比例尺落到内容层上，并放回该在的滚动位置（顺序：先宽、后滚） */
function tlApplyScale(bar, total) {
  const inner = bar.querySelector('#tlInner');
  if (!inner) return;
  const pps = tlCurrentPps(total, bar);
  inner.style.width = tlInnerWidth(total, pps) + 'px';
  /* 把主档那一档有多宽交给淡尺（刻度尺算出来的同一个主档）：`.tl-bar` 打底那一层与
     画面行 `::before` 那一份读的都是**同一个 `--tl-step-px`**，所以「尺上的线」「轨道里的淡竖线」
     「空白处那几条」是同一个落点 —— 写成百分比时行内那一份量的其实是父级宽度，
     换成像素之后两处共用一个数，行宽与内容层宽不一致（缩到比整条短）也不再各漂一处。
     缩到极小（一道淡尺不到 8 像素）时**整条不画**：那时竖线挤成一团脏灰，
     比没有更难看，而且这一档本来也读不出「占几秒」。用一个不可能撞上的大数表达「不画」。 */
  const Tsc = Math.max(0.1, Number(total) || 0.1);
  const mj = Number(rulerScale(Tsc, pps).major) || 0;
  bar.style.setProperty('--tl-step-px', (mj * pps >= 8 ? Math.round(mj * pps * 100) / 100 : 100000) + 'px');
  /* 读数、滑块位置、「自适应」按钮的可用态**只在这一处**刷新（首画与每次缩放重排都经过这里）：
     滑块反推走 tlSliderPos —— 与 input 正推 px/秒是同一对换算、同一对端点（tlZoomEnds），
     两处各写一个 Math.log 迟早在两端差一格。 */
  const val = document.getElementById('tlZoomVal');
  const zr = document.getElementById('tlZoomRange');
  const zauto = document.getElementById('tlZoomAuto');
  const man = !!tlPpsOf();
  if (val) val.textContent = man ? (tlPpsText(pps) + ' px/秒') : '自适应';
  if (zr) zr.value = String(tlSliderPos(pps, total));
  if (zauto) {
    zauto.disabled = !man;
    /* 「比轨道宽、要左右滚」与「只占轨道一段」是这一档最直观的两件事，写给用户看之前先确认量得出：
       容器还没排好时 `clientWidth` 是 0，那时两种都不说。 */
    const avail = bar.clientWidth || 0;
    zauto.title = man
      ? ('点一下回到「自适应」（现在按 ' + tlPpsText(pps) + ' 像素/秒'
        + (avail ? (tlInnerWidth(total, pps) > avail ? '，整条比轨道宽、要左右滚' : '，整条只占轨道的一段') : '') + '）')
      : '现在就是自适应（整条正好铺满；长片铺到 12px/秒 就停，开始左右滚）';
  }
  if (tlAnchorT >= 0) {
    bar.scrollLeft = Math.max(0, tlAnchorT * pps - bar.clientWidth / 2);
    tlAnchorT = -1;
  } else if (tlScrollWantOf() >= 0) {
    bar.scrollLeft = tlScrollWantOf();
    setTlScrollWant(-1);
  }
}
/* 缩放要改的只有两样：`#tlBar` 里那一排的排版，和外面那枚读数（`tlApplyScale` 顺手写的）。
   以前这两处调的是 `renderMid()` —— 那是 `col.innerHTML = …` 整列替换，于是顺手做坏三件事：
   · 候选缩略图换成全新节点，首帧重新取一遍 → 用户看到的「缩放轨道时中间栏那排图闪一下」；
   · 刚点下的那颗「＋」自己也被摘掉 → 这一栏的滚动位置被抹平，页面弹回最上方；
   · 播放器那一只 `.player-box` 即便有 `keepBox` 也先被 `remove()` 了一次（全屏正开着时等于当场退出全屏）。
   这三件都与「这一排摊开几像素/秒」无关，所以缩放只重排时间轴。 */
function tlRescale() {
  const col = $('midCol'), sh = curShot();
  if (!col || !sh || !col.querySelector('#tlBar')) return;   // 不在剪辑态就没有这一排可重排
  const cands = sh.candidates || [];
  renderTimeline(col, sh, cands[projOf().curCand] || cands[0]);
}
/* 改比例尺要做的三件事（新值、锚点、落盘）只有这一处，按钮 / 滚轮 / 滑块都走它 ——
   倍率入口（tlZoomTo）与绝对值入口（tlZoomSet）只算出 next 再调它，「缩放围绕视野中心那一秒」
   的锚点因此只有一份，是结构上保证的，不靠记性。 */
function tlZoomApply(next, opts) {
  const bar = document.getElementById('tlBar');
  if (!bar) return;
  const total = tlTotalNow(bar);
  const cur = tlCurrentPps(total, bar);
  next = Math.max(tlMinPps(total), Math.min(TL_MAX_ZOOMOf(), next));
  if (Math.abs(next - cur) < 1e-9) return;                 // 贴到上下限：一次无谓的重排都不做
  tlAnchorT = (bar.scrollLeft + bar.clientWidth / 2) / Math.max(0.01, cur);
  /* 三位小数而不是两位：滚轮那一档一步只有 1.5%，而两位量化在 1 px/秒 那一档的格宽正好是 1%，
     会把半步吃掉 —— 捏一下读数一动不动，看着像滚轮坏了。 */
  setTlPps(Math.round(next * 1000) / 1000);
  /* 滑块拖动中（input）只改内存 —— 每帧写盘太密，与右栏那几枚滑块同一条纪律；
     松手 / 键盘松开（change）由 tlZoomCommit 落盘。按钮与滚轮一次就是一档，当场落。 */
  if (!opts || opts.persist !== false) window.LS.set('dir_tl_pps', String(tlPpsOf()));   // 存不下（隐私模式）就只生效这一次
  /* 缩放换了采样点，也换了用户盯着看的那一片：失败退避不再拦这一次重排。 */
  sliceForgetFail();
  if (midEditTrimOf()) tlRescale();
}
function tlZoomTo(mult) {
  const bar = document.getElementById('tlBar');
  if (!bar) return;
  tlZoomApply(tlCurrentPps(tlTotalNow(bar), bar) * mult);
}
/* 绝对值入口（px/秒）。persist=true 只用于滑块拖动中：input 只改内存，松手才由 tlZoomCommit 落盘。 */
function tlZoomSet(pps, persist) {
  tlZoomApply(Number(pps) || 0, persist ? { persist: false } : undefined);
}
/* 滑块的位置 ↔ px/秒：px/秒是倍率、滑块是线性的 → 位置必须取**对数**，线性摆位会把低档位
   全挤在左端、拖起来像卡住（滚轮那条路本来就是对数折算，两条路同一手感）。
   端点跟 tlMinPps(total) / TL_MAX_ZOOM 走：本镜 ⇄ 全片、换镜头，总长一变同一个位置对应的 px/秒
   就不同 —— tlApplyScale 反推位置与 input 正推 px/秒读的都是这一对函数，别处各写一个 log 必然漂。 */
const TL_SLIDER_MAX = 1000;
function tlZoomEnds(total) {
  const min = tlMinPps(total) || 0.02;
  return { min, max: Math.max(min * 1.0001, TL_MAX_ZOOMOf()) };
}
function tlSliderPos(pps, total) {
  const e = tlZoomEnds(total);
  const p = Math.max(e.min, Math.min(e.max, Number(pps) > 0 ? Number(pps) : e.min));
  return Math.round((Math.log(p) - Math.log(e.min)) / (Math.log(e.max) - Math.log(e.min)) * TL_SLIDER_MAX);
}
function tlSliderPps(pos, total) {
  const e = tlZoomEnds(total);
  const t = Math.max(0, Math.min(TL_SLIDER_MAX, Number(pos) || 0)) / TL_SLIDER_MAX;
  return e.min * Math.pow(e.max / e.min, t);
}
function tlZoomSetPos(pos, persist) {
  const bar = document.getElementById('tlBar');
  if (!bar) return;
  tlZoomSet(tlSliderPps(pos, tlTotalNow(bar)), persist === false);
}
/* 滑块松手（change）那一刻落盘。没动成（还是自适应档，pps = 0）就不写 —— 那一档本来走 LS.del。 */
function tlZoomCommit() { if (tlPpsOf()) window.LS.set('dir_tl_pps', String(tlPpsOf())); }
/* 按钮那两颗：一步约 1.15 倍 —— 与滚轮一格（≈1.16）同一档手感；以前是 1.6，一按跳太远。 */
function tlZoomBy(dir) { tlZoomTo(dir > 0 ? 1.15 : 1 / 1.15); }
/* 触摸板的一次捏合连发几十条 wheel（每条 deltaY 只有一二十像素，一秒能出 60 条以上），
   以前每条都乘按钮那一步的 1.6 —— 一次捏合翻几十倍，就是用户报的「幅度太大、没法用」。
   滚轮因此不当「一步」用，按 deltaY 的像素数**连续折算**：鼠标一格（Chrome 回 100）≈ 1.16 倍，
   和旁边那两颗按钮同一档手感；按行回的那家（deltaMode 1）先换成像素再算。
   攒到下一帧只重排一次顺带修掉第二件事：以前每条都拿**还没重排完的** scrollLeft 算视野中心那一秒，
   而一次重排赶不上事件流速时队列必排 —— 锚点跟着漂，松手后画面还在继续跳。 */
const TL_WHEEL_K = 0.0015, TL_WHEEL_CLAMP = 120, TL_WHEEL_LINE = 33;
let tlWheelMult = 1, tlWheelRaf = 0;
function tlZoomWheel(e) {
  /* 单条夹一道上限：惯性甩动一条能回几百像素，不夹就等于一条事件走完整程。 */
  const px = (e.deltaY || 0) * (e.deltaMode === 1 ? TL_WHEEL_LINE : 1);
  tlWheelMult *= Math.exp(-Math.max(-TL_WHEEL_CLAMP, Math.min(TL_WHEEL_CLAMP, px)) * TL_WHEEL_K);
  if (tlWheelRaf) return;
  tlWheelRaf = requestAnimationFrame(() => {
    const m = tlWheelMult; tlWheelMult = 1; tlWheelRaf = 0;
    tlZoomTo(m);
  });
}
/* 回到「自适应」那一档（「自适应」那颗按钮的出口；读数只显示数字，不再兼任出口）。这一档**以前没有出口**：
   手动缩过一次之后 `tlPpsOf()` 就永远是手动值，读数再也不会写「自适应」。旧下限 4px/秒 时缩到底
   看着还是铺满一整条，「回不去」是含糊的；现在能缩到比这条轨道还短，回不去就成了看得见的一件事 —— 所以给它一颗真出口。 */
function tlZoomAuto() {
  if (!tlPpsOf()) return false;
  setTlPps(0);
  window.LS.del('dir_tl_pps');
  sliceForgetFail();
  if (midEditTrimOf()) tlRescale();
  return true;
}
/* 当前页签那把尺子的总长（本镜 = 这一排的轴秒，全片 = 各格框摊开的总长）—— 缩放与比例尺都问它一处。
   ⚠ 本镜那一支**不能再返回 `candDur`**（候选的源秒）：内容层的宽度 = 这一个数 × 像素/秒，
   而格子、刻度尺、插针全按 `shotAxTotal` 的百分比铺 —— 两者不等时「像素/秒」就成了一个假数
   （切片密度、缩放到视野中心那一秒、`tlAnchorT` 全都偏，且倍速越偏越明显）。 */
function tlTotalNow(bar) {
  const sh = curShot();
  if (!sh) return 0;
  if ((projOf().tlTab || 'shot') === 'film') {
    return Math.max(0.05, filmFrames(tlSyncFromShots()).total);
  }
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  if (!c) return 0;
  const total = candDur(c, sh);
  return shotAxTotal(shotFrames(segsOf(c, total)), total);
}

/* 时间线：剪辑模式打开时才画。两个页签是**同一份 c.segs 的两种读数** ——
   「本镜」按源视频秒摆这一段剪出来的几格，「全片」按成片秒比例摆所有已选用镜头的格。
   两个页签**形状一致**（一排绝对定位的段格 + 左右红把手 + 一根插针 + 一条声音行），
   放插针的点击区是整条 .tl-bar（bindPinZone）：格子之间的缝、行上下的空白都算。 */
function renderTimeline(col, sh, cur) {
  const bar = col.querySelector('#tlBar');
  if (!bar) return;
  /* 一切内容都装在 `.tl-inner` 里，它的宽度 = 总时长 × 像素/秒（见 tlApplyScale）——
     行内元素继续按百分比定位，于是「比例尺」只有这一个落点。 */
  bar.innerHTML = '<div class="tl-inner" id="tlInner"></div>';
  const inner = bar.querySelector('#tlInner');
  /* 比例尺**先**落地再画行：行的宽度是父级的 100%，先有宽度才不至按旧宽度排一帧 */
  tlApplyScale(bar, tlTotalNow(bar));
  const tab = projOf().tlTab || 'shot';
  if (tab === 'shot') renderShotTrack(inner, col, sh, cur);
  else renderFilmTrack(inner, col, sh);
  paintTlHint(col, sh, cur);
}
/* 这一页签的像素/秒（要问**滚动容器**的宽度，不能问内容层 —— 内容层已经是 pxPerSec 撑出来的） */
const tlPpsNow = total => tlCurrentPps(total, document.getElementById('tlBar'));
/* 屏幕横坐标 → 这一排的落点：只量、不写。量尺子 / 折轴秒 / 折源秒只有这一份 ——
   `bindPinZone`（点轨道空白 / 画面格 / 字幕块）与待生成占位的点击、拖动都调它。
   两处各写一遍，迟早一处量 `#tlInner`、一处量 `#tlBar`：缩到比轨道还短时，
   同一根手指会落出两个秒数。量的一律是**内容层**（画面行 / 声音行 / 刻度尺都是它的 100% 宽），
   与格子、针同一把尺子。返回 `{ seg, at, box, ax }`（段号 / 段内源秒 / 这一排在轴上的秒 / 轴总长）；
   量不出来时回 `{ why }`，由调用方决定说给谁听（拖动途中不说话，点击时才报）。 */
function pinMeasure(scope, sh, clientX) {
  const inner = (scope && (scope.querySelector('#tlInner') || scope.querySelector('#tlBar'))) || scope;
  if (!inner) return { why: '' };
  const r = inner.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (Number(clientX) - r.left) / Math.max(1, r.width)));
  if ((projOf().tlTab || 'shot') === 'shot') {
    const cands = (sh && sh.candidates) || [];
    const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId) || cands[0];
    /* 没有候选时这条时间轴压根还没有长度，针无处可放 —— 但**别说都不说**
       （用户点了、屏幕上一个字都没动，看着像轨道坏了）。 */
    if (!c) return { why: '这一镜还没有候选：先出一条或导入一条，轨道上才有「第几秒」可指。' };
    const total = candDur(c, sh);
    const G = shotFrames(segsOf(c, total));
    const ax = shotAxTotal(G, total);
    const tAx = ratio * ax;
    const row = shotRowAt(G, tAx);
    const t = row ? frameToSrc(row, tAx) : 0;
    return { seg: row ? row.i : 0, at: t, box: shotPinT(G, t), ax: ax, c: c, total: total };
  }
  const tl = tlSyncFromShots();
  if (!tl.clips.length) return { why: '全片轨还是空的：先在候选上点「用这条」，这里才会出现格子。' };
  const G = filmFrames(tl);
  const tAx = ratio * G.total;
  const hit = filmSeek(tl, tAx, G);
  return { seg: hit && hit.target ? hit.si : 0, at: hit && hit.target ? hit.at : 0, box: tAx, ax: G.total, tl: tl };
}
/* 按一个屏幕横坐标放针（量完就写）：针、播放器、剪刀指的段都从这里落。
   `lane` 原样交给 `setPin` / `filmApplyAt`：`null` 是「别动目标轨」（点在配音块上那一档），
   不能拿缺省的 `'voice'` 顶掉它。 */
function pinAtX(scope, col, sh, clientX, opts) {
  const lane = opts && 'lane' in opts ? opts.lane : 'voice';
  const m = pinMeasure(scope, sh, clientX);
  if (m.why) { Toast.warn(m.why); return false; }
  if (!m.why && m.ax == null) return false;
  if (m.c && m.total != null) {
    sliceUserTouch();
    TlPlayOf().pause();
    TlPlayOf().seek(pinFilmTShot(m.c, sh, m.at), false);
    setPin(col, sh, m.c, m.total, m.at, lane);
  } else {
    sliceUserTouch();
    filmApplyAt(col, m.tl, m.box, { lane: lane });
  }
  return { seg: m.seg, at: m.at, box: m.box, ax: m.ax };
}
function renderShotTrack(bar, col, sh, cur) {
  const c = cur || (sh.candidates || []).find(x => x.vid === sh.selId) || (sh.candidates || []).find(x => x.status === 'succeeded');
  if (!c) {
    bar.innerHTML = '<div class="tl-empty">这一镜还没有候选：先生成一条，或点「导入视频 / 素材」挑一条，才谈得上剪。</div>';
    return;
  }
  const total = candDur(c, sh);
  const segs = segsOf(c, total);
  /* 这一排的时间基 = **轴秒**（各段的框 ÷ 自己那一段的倍速累加，见 `shotFrames`）：
     倍速一改，这一格真的变宽 / 变窄，而数据层一个字节没动（`c.segs` 仍是源秒）。
     段数为零时退回候选时长，免得刻度尺塌成一格（「一段画面都不留」是有效状态）。 */
  const G = shotFrames(segs);
  const ax = shotAxTotal(G, total);
  /* 没在播时针画的是**数据里那一秒**（`proj.cutAt`），不是播放器的 `currentTime`：
     播放器刚建出来（还没 seek、或者这条素材取不到字节）时它恒为 0，
     于是一个存着 1.8 秒的工作区一进剪辑，针停在 0%、读数和剪刀却在 1.8 秒。
     播放中仍读 `cutPin`（跟着播放头走）—— 与 `syncPlayhead` 那两个分支同一份口径。 */
  const pinSrc = TlPlayOf().playing ? cutPin(c, total)
    : round1(Math.max(0, Math.min(total, Number(projOf().cutAt) || 0)));
  const pinAx = shotPinT(G, pinSrc);
  /* 这一页签此刻的像素/秒（与 tlApplyScale 给内容层设宽时问的是同一个）——
     它只决定「这一格摊得下几张定宽磁贴」：放大 → 格子变宽 → 多几张，缩小 → 少几张，
     每张在屏上始终 SLICE_TILE_PX 那么宽（放不下整张就裁掉右边那一截）。 */
  const pps = tlPpsNow(ax);
  const src = candTrackSrc(c);
  const iSel = picSelAt(segs.length);
  /* 格子按**框** [a,b] 摊在轴上（`start` / `w`，不是按选区）：拖把手时框不动，所以这一格的
     左右边界与切片画面都不变 —— 变的是框内那两层灰遮罩的宽度（左边那块 = 被切掉的片头，
     右边那块 = 被切掉的片尾）。选段之间也互不影响：改一段的倍速只挪它后面那些格。
     切片图也按框取（`data-in/out` = 源秒 a/b）：拖把手改的是选区，帧不需要重新解码。 */
  /* 锁上画面轨 = 把手一颗都不画（不是画出来再禁用）：留一颗拖不动的把手等于
     「看着能点、其实什么都不做」。问的是**这一格自己那一行**（`rowLocked`：整条轨锁着时每一格都锁，
     只锁第 2 行时第 1 行的把手照画），与声音轨那一句走同一份判据。 */
  const cellHTML = r => {
    const s = r.s, i = r.i;
    const picLocked = rowLocked('pic', r.ln);
    const bw = Math.max(0.01, r.dur);          // 框在**源**里有多长（灰遮罩比的都是它）
    const gone = !!s.off;
    /* 黑场那一格**不解码切片**（画面已经不进了，取帧只是白烧 CPU），但格子本身照原样占着位置 ——
       「点哪个轨道操作哪个轨道」要求它仍然可点、可选、可被「删掉」那颗按钮再点回来。 */
    return `
    <div class="tl-seg${i === iSel ? ' sel' : ''}${gone ? ' gone' : ''}" data-seg="${i}"
         style="left:${pct(r.start, ax)}%;width:${pct(r.w, ax)}%"
         title="${gone ? '第 ' + (i + 1) + ' 段：画面已删掉，成片里这一段出黑场（时长还是 ' + round1(segFilmLen(s)) + ' 秒，后面那段不前移）。想放回来就点上面那颗「恢复这一段画面」'
           : '第 ' + (i + 1) + ' 段：这一段框住源视频 ' + round1(s.a) + '–' + round1(s.b) + ' 秒；保留 ' + round1(s.in) + '–' + round1(s.out) + ' 秒（' + round1(segFilmLen(s)) + ' 秒）。点空白处放插针'
           + (picLocked ? '（' + rowLockWhy('pic', r.ln) + '，把手不画也拖不动；' + rowUnlockHow('pic', r.ln) + '）'
             : '，拖格子两端的把手把这一段的头/尾切掉（灰掉的那块就是被切掉的）；上下拖 = 挪到另一行')}">
      ${gone ? '' : sliceBoxHTML(src, s.a, s.b, r.w * pps, frameToSrc(r, pinAx))}
      <span class="mask l" style="width:${pct(s.in - s.a, bw)}%"></span>
      <span class="mask r" style="width:${pct(s.b - s.out, bw)}%"></span>
      <span class="lab">${esc(segLabel(i, s))}</span>
      ${picLocked ? '' : `<span class="cut l" data-seg="${i}" data-edge="l"></span><span class="cut r" data-seg="${i}" data-edge="r"></span>`}
    </div>`;
  };
  /* 画面轨也可以有几行（`s.ln`，用户点名「视频也改成可以无限多轨道，方便剪辑」）。
     格子从不重叠（一段接着一段），所以多行**纯粹是排版** —— 把一段拖到第二行只改它画在哪一行，
     进成片的顺序、时长、切片与音量账一个字节都不改（那一行的基数另说）。
     行数按数据长（最高那一行 + 1），空着的中间行照样画：抽掉空行会把它上面那一行往下塌一格，
     而那一格正好是插针与刻度尺对齐的地方。 */
  const lanes = laneRowsFor('pic', laneRowsOf(segs));
  let picHTML = '';
  for (let ln = 0; ln < lanes; ln++) {
    const body = G.rows.filter(r => r.ln === ln).map(r => cellHTML(r)).join('');
    /* 那句「一段都没留」只说一次（挂在第一行）：行数可以是用户自己加的，
       每一行都重复一句等于把三行空白变成三条警告。 */
    picHTML += `<div class="tl-vrow${rowHidden('pic', ln) ? ' hid' : ''}" data-ln="${ln}">` + (body
      || (segs.length || ln ? '' : '<div class="tl-empty">这一条候选一段画面都没留：按 Ctrl+Z 退回去，或在上面「切开」重新分一段。</div>')) + '</div>';
  }
  bar.insertAdjacentHTML('beforeend', rulerHTML(ax, tlPpsNow(ax)));
  bar.insertAdjacentHTML('beforeend', picHTML);
  bar.insertAdjacentHTML('beforeend', voiceLaneHTML(sh, c, total, G));
  /* 待生成配音那一轨排在**真配音轨下方**（用户点名）：它说的是「这一镜还有话没配」，
     合成之后占位符自己消失（判据是 `pendingLineOf`，不是另存一份状态）。 */
  bar.insertAdjacentHTML('beforeend', shotPendingHTML(sh, G, ax));
  /* 字幕行排在最下面（点块跳转、拖块 / 把手改起止走 sub-lane.js 那一套手势，改字在右栏）。 */
  bar.insertAdjacentHTML('beforeend', subLaneHTML(sh, c, G, ax));
  bindSubLanes(bar, col, false);
  /* 插针最后挂（挂在内容层上，穿过刻度尺 + 画面行 + 声音行）：
     它不属于任何一行，所以行的显隐、锁定都不影响它 —— 收起画面轨时针还得在。 */
  bar.insertAdjacentHTML('beforeend', `<span class="tl-pin" style="left:${pct(pinAx, ax)}%"></span>`);
  bar.querySelectorAll('.tl-vrow').forEach(r => { bindSegDrag(r, sh, c, total, G); fillSlices(r); });
  bar.querySelectorAll('.tl-lane').forEach(l => bindVoiceLane(l, { total: ax, G: G }));
  bindPendingLanes(bar, { col, film: false, ax, G, sh, c, total, fallen: sh });
  syncLaneSide(col, bar);        // 左边那一列的轨名跟着行数长（画面几行、配音几行各有各的）
  syncTlTools();            // 统一剪辑条跟着这一排重画（选中着就把那一句写回条上）
  fillWaveforms(bar);          // 后台填声音轨的波形（不挡轨道出来）
  /* 点轨道空白 / 格子里不带把手的地方 = 放插针（也就是定了四把剪子下一刀剪在哪）。
     绑在**整张网格**上（轨名那一列也算），不绑在滚动容器里：画面轨一行都没画出来时，
     从前那个「取第一行的矩形」直接 bail，于是整块区域点了没有任何反应。
     不依赖 duration 是否已知：钳在 0–total 之间，播放器能跳就跳。 */
  bindPinZone(col.querySelector('#tlGrid') || bar, col, sh, pinAtX);
  paintPin(col, pinAx, ax);
}
/* 刻度尺右端那枚读数（#tlT1）= 上面那把尺子的终点，与格子的 `left/width` 同一份账。
   还没出画面时照旧说「未生成」，不摆一个假 0 秒。 */
const shotAxText = (c, sh) => {
  const t = c ? candDur(c, sh) : 0;
  if (!t) return shotDurText(sh);
  return fmtDur(shotAxTotal(shotFrames(segsOf(c, t)), t));
};

/* ============================================================================
   「这一镜的台词还没配音」那一族（2026-10 用户点名的第 ④ 条）
   ---------------------------------------------------------------------------
   AI 拆分镜时会带回 `speaker`（落成 `sh.lineWho`）与 `line`。台词本身**不进配音轨**
   （它就是一行字，没有音频），所以界面上另开一条「待生成配音」轨：每个有台词、且这一镜上
   还没有同文配音的镜头摆一个虚线占位符。点它 = 把这一句填进右栏「生成配音」，
   并**按说话人去素材库取音色描述 / 参考音频**（音色设计取 `voiceNote`、音色复刻取那段字节）。
   三条不能各写一份的口径：
     ① 判据只有 `pendingLineOf`（台词有字 + 这一镜没有任何一句配音的文字与它相同）；
     ② 位置只有 `shotPendingHTML` / `filmPendingHTML` 两处，都按各自那一排的轴秒摆
        （本镜读 `shotFrames` 的行、全片读 `filmFrames` 的行，与格子和插针同一把尺子）；
     ③ 点击只有一个出口 `openPendingVoice`，且它一个计费请求都不发（合成仍只在
        `addVoiceAtPin` 那一下）。 */
function lineDraftOf(sh) {
  return {
    text: String((sh && sh.line) || '').replace(/\s+/g, ' ').trim(),
    who: String((sh && sh.lineWho) || '').replace(/\s+/g, ' ').trim()
  };
}
/* AI 拆分镜 / 改分镜带回台词时那句「出路」只有一份：两处报数共用同一个串，指的都是新落点
   （剪辑右栏「台词」那一档，或轨道上那个待生成占位）。话里不写「已合成」—— 那一次一个计费
   请求都没发，合成只在「合成并加到这一轨」那一下。 */
function lineLandedNote(n) {
  return '、' + n + ' 镜带上了台词（到剪辑右栏「台词」点那一句，或点轨道上的待生成占位，才填进合成框）';
}
/* 「这一镜还有话没配」：台词有字，且这一镜上没有任何一句配音的文字与它相同。
   按**文字**认而不是按「有没有配音」：台词改过之后旧配音还在，那一句仍然算待生成
   （否则改完台词，轨道上那个占位符永远不会再出现）。 */
function pendingLineOf(sh) {
  const p = lineDraftOf(sh);
  if (!p.text) return null;
  const hit = shotVoices(sh.id, '').some(v => String(v.text || '').replace(/\s+/g, ' ').trim() === p.text);
  return hit ? null : p;
}
function pendingBlockHTML(p, l, w, ax, where, shotId) {
  const who = p.who ? p.who + '：' : '';
  const est = lineEstSec(p.text);
  const tip = '待生成配音：' + who + p.text + ' · 约 ' + round1(est) + ' 秒（按' + where + '的位置摆，合成后时长以真实音频为准）'
    + '。点一下：这一句的落点搬到点击处（针也跟过去），并把这一句填进右栏「生成配音」，'
    + '按说话人去素材库取音色描述 / 参考音频；按住左右拖 = 把这一句的落点（块、针与合成落点一起）挪到别处';
  return `<span class="tl-vp" data-shot="${esc(shotId || '')}" style="left:${pct(l, ax)}%;width:${pct(Math.max(0.2, Math.min(ax - l, Math.max(0.6, w))), ax)}%"
    title="${esc(tip)}"><b>待生成</b><span>${esc(who + p.text)}</span><i class="vpm">${p.text.length} 字</i></span>`;
}
/* 本镜那一排：一行台词摆在**这一句自己的落点**（`sh.lineAt` / `sh.lineSeg`；缺省 = 第一段起点）。
   落点只是「第几段 + 段内源秒」，落到轨道上仍走 `lineSpanAt` 那一份换算 —— 这里不碰几何。
   宽度按语速估，再除以这一格的倍速 —— 倍速把这一格压窄时，占位符跟着窄，
   否则「2 倍速的一格里摆着 8 倍速宽度的一句话」本身就是假的。 */
function shotPendingHTML(sh, G, ax) {
  const p = pendingLineOf(sh);
  if (!p) return '';
  const rows = (G && G.rows) || [];
  /* 一条画面段都没有（还没出候选 / 全被剪成黑场）：照样把这一句摆出来，从左沿铺到整条，
     不让「这一镜有台词」在剪辑界面里彻底看不见（点它仍然进得了「生成配音」，
     只是合成那一步会在 `voiceTarget` 那里说清「还没有可放的位置」）。 */
  if (!rows.length) return '<div class="tl-vp-lane">' + pendingBlockHTML(p, 0, ax, ax, '整条（这一镜还没有画面段）', sh.id) + '</div>';
  const pt = linePointOf(sh, rows.map(r => r.s));
  const r = rows[Math.min(rows.length - 1, pt.seg)] || rows[0];
  const sp = lineSpanAt(r, pt.at, lineEstSec(p.text), false);
  const l = Math.min(Math.max(0, ax - 0.05), sp.at);
  const w = Math.min(Math.max(0, ax - l), sp.len);
  return '<div class="tl-vp-lane">' + pendingBlockHTML(p, l, w, ax, '第 ' + (r.i + 1) + ' 段', sh.id) + '</div>';
}
/* 全片那一排：每一镜只摆一次（它可能被剪成好几格；块挂在**落点那一段**对应的那一格下面）。
   同一条台词在这一镜已经配过音时 `pendingLineOf` 给 null，占位不画。 */
function filmPendingHTML(tl, G) {
  const ax = Math.max(0.05, G.total);
  const seen = new Set();
  let out = '';
  G.rows.forEach(r => {
    const cl = r.cl;
    if (!cl || cl.kind !== 'shot' || seen.has(cl.shotId)) return;
    seen.add(cl.shotId);
    const sh = allShots().find(x => x.id === cl.shotId);
    const p = sh ? pendingLineOf(sh) : null;
    if (!p) return;
    /* 落点按**段号**挑那一格，不是永远挑这一镜的第一格：落在第 2 段的那一句要画在第 2 段下面。 */
    const cand = chosenCandOf(sh);
    const segs = cand ? segsOf(cand, candDur(cand, sh)) : [];
    const pt = linePointOf(sh, segs);
    const rs = G.rows.filter(x => x.cl && x.cl.kind === 'shot' && x.cl.shotId === sh.id);
    const row = rs.find(x => (Number(x.cl.seg) || 0) === pt.seg) || rs[0];
    if (!row) return;
    const sp = lineSpanAt(row, pt.at, lineEstSec(p.text), false);
    const l = Math.min(Math.max(0, ax - 0.05), sp.at);
    const w = Math.min(Math.max(0, ax - l), sp.len);
    out += pendingBlockHTML(p, l, w, ax, '第 ' + (row.k + 1) + ' 格', sh.id);
  });
  return out ? '<div class="tl-vp-lane">' + out + '</div>' : '';
}
/* 指针横坐标 → 待生成块的新落点（段号 + 段内源秒 + 它在轴上的位置）：只量，不写。
   两排各问各的几何：本镜走 `shotRowAt`（行上的 `i` 就是段号），全片走 `filmSeek`（行上的
   `cl.seg` 才是段号 —— 一行一格，不是一段）。指针落在轨道外（键盘 / 程序化 click 的
   clientX = 0）时回 null：那一路只开面板、不动落点，拿 0 当点击处会把刚摆好的落点拽回第 0 秒。 */
function pendingHitAt(el, ctx, clientX) {
  const inner = (ctx.col && (ctx.col.querySelector('#tlInner') || ctx.col.querySelector('#tlBar')))
    || (el.closest && el.closest('#tlInner'));
  if (!inner) return null;
  const r = inner.getBoundingClientRect();
  if (!(clientX >= r.left - 0.5 && clientX <= r.right + 0.5)) return null;
  const ratio = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
  if (!ctx.film) {
    if (!ctx.sh || !ctx.c) return null;
    const ax = Math.max(0.05, Number(ctx.ax) || 0);
    const tAx = ratio * ax;
    const row = shotRowAt(ctx.G, tAx);
    if (!row) return null;
    return { seg: row.i, at: frameToSrc(row, tAx), box: tAx, ax: ax };
  }
  const rows = ((ctx.G && ctx.G.rows) || []).filter(x => x.cl && x.cl.kind === 'shot' && x.cl.shotId === (el.dataset.shot || ''));
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  /* 块拖不出自己那一镜：落点是一条候选上的源秒，越界等于挂到别的镜（与字幕块同一条边界）。 */
  const tAx = Math.max(rows[0].start, Math.min(last.start + last.w - 0.001, ratio * (Number(ctx.ax) || 0)));
  const hit = filmSeek(ctx.tl, tAx, ctx.G);
  if (!hit || !hit.target) return null;
  return { seg: hit.si, at: hit.at, box: tAx, ax: Number(ctx.ax) || 0 };
}
/* 占位符的三条手势（两排各绑一次，节点每次重画都是新的）：
   点 / 按住左右拖 = 把这一句的**落点**搬到指针那一秒：
     · 点击当场写 `sh.lineSeg` / `sh.lineAt`（`linePointSet` 唯一写口），针与合成落点跟着它；
     · 拖动中只改这一块自己的 `left` 与针（不写数据、不重画整列），松手才落一次盘。
   块的位置、针的位置、`voiceTarget` 将来铺在哪，三处读的是同一个数（`linePointOf`）——
   拖动途中它们不会各说各的，拖完也不会「块没动、针走了」。
   程序化 / 键盘触发的 click 没有坐标，只开面板、不动落点（见 `pendingHitAt`）。
   落点两条路各归各的既有出口：本镜走 `setPin`（源秒口径 + 播放器跟一步），
   全片走 `filmApplyAt`（焦点、针、播放器、那句报数都归它），在这里再写一份折算就是两本账。
   `bindPinZone` 已把 `.tl-vp` 排除在「放插针」之外（见那一条），这里的 stopPropagation 是第二道。 */
let pendDrag = null;
function bindPendingLanes(bar, ctx) {
  bar.querySelectorAll('.tl-vp').forEach(el => {
    /* 一块占位的身份：哪一排（本镜 / 全片）+ 哪一镜。拖完 A 块紧接着点 B 块是两次手势，
       不能因为「刚刚有人拖过」就把那一下也吞掉（从前全局一个时间戳，全片拖完 600ms 内
       点本镜那一块，右栏不翻、落点也不动）。 */
    const dragKey = () => (ctx.film ? 'film:' : 'shot:') + (el.dataset.shot || '');
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const x0 = e.clientX;
      let moved = false, last = null;
      const move = ev => {
        const m = pendingHitAt(el, ctx, ev.clientX);
        if (!moved) {
          if (Math.abs(ev.clientX - x0) < 3) return;   // 3px 阈值：单击不起步，真拖才亮
          moved = true;
          el.classList.add('act');
          TlPlayOf().pause();                          // 播放头跟随与手里的针是两根轴，先停播再拖
        }
        if (!m) { dragGhostMove(ev); return; }
        last = m;
        dragGhostShow(ev, el, (ctx.film ? '成片 ' : '') + round1(m.box) + ' 秒');
        /* 只改左沿、不改宽度：这是「挪落点」不是「改这一句多长」。 */
        el.style.left = pct(m.box, m.ax) + '%';
        paintPin(ctx.col, m.box, m.ax);
      };
      const up = () => {
        el.classList.remove('act');
        dragGhostHide();
        if (!moved) return;
        /* 松手那一下的 click 不算「点进生成配音」。记在模块上而不是节点上：
           落点一改就 `filmEdited()` 整列重画，这个节点会被换掉，挂在节点上的标记活不过重画。 */
        pendDrag = { at: Date.now(), key: dragKey() };
        const sh = ctx.film ? (allShots().find(x => x.id === el.dataset.shot) || ctx.fallen) : ctx.sh;
        const cand = sh ? chosenCandOf(sh) : null;
        const segs = cand ? segsOf(cand, candDur(cand, sh)) : [];
        const m = last;
        if (!sh || !cand || !m || !segs.length) return;
        const cur = linePointOf(sh, segs);
        const pt = linePointClamp({ seg: m.seg, at: m.at }, segs);
        const changed = cur.seg !== pt.seg || cur.at !== pt.at;
        if (changed) beginEdit();
        /* 针与焦点先落数据，再落台词落点、整列重画：重画时块与针读的是同一份新数。 */
        if (ctx.film) filmApplyAt(ctx.col, ctx.tl, m.box, { lane: 'voice' });
        else {
          TlPlayOf().pause();
          TlPlayOf().seek(pinFilmTShot(cand, sh, pt.at), false);
          setPin(ctx.col, sh, cand, candDur(cand, sh), pt.at, 'voice');
        }
        if (changed) { linePointSet(sh, pt.seg, pt.at, segs); filmEdited(); }
        if (ctx.film) return;                 // 全片那句报数由 filmApplyAt 说（与点轨道空白同一份）
        /* 报的合成落点与右栏 `voiceTarget` 同一把夹法：段不够长时顶在段尾，别报一个合成不出来的数。 */
        const s = segs[pt.seg] || segs[0];
        const at = s
          ? '第 ' + (pt.seg + 1) + '/' + segs.length + ' 段的 +'
            + round1(Math.max(0, Math.min(Math.max(0, segLen(s) - SEG_MIN), pt.at - (Number(s.in) || 0)))) + ' 秒'
          : '整条开头（这一镜还没有画面段）';
        setStatus('下一句配音会合成在「' + esc(sh.name || '镜头') + '」' + at + ' —— 点这个占位符把台词填进右栏「生成配音」');
      };
      dragOnWindow(move, up);
    });
    el.onclick = e => {
      e.stopPropagation();
      /* 只吞「这一块刚拖完补发的那一下」：标记消费一次就清空 —— 留着不消费会把它后面
         第一次真点击也一起吞掉（刚拖完隔一会儿再点，右栏不开）。 */
      if (pendDrag && pendDrag.key === dragKey()) {
        const since = Date.now() - pendDrag.at;
        pendDrag = null;
        if (since < 600) return;
      }
      const id = el.dataset.shot || '';
      const target = allShots().find(x => x.id === id) || ctx.fallen;
      if (!target) return;
      const hit = pendingHitAt(el, ctx, e.clientX);
      if (hit) {
        const cand = chosenCandOf(target);
        const segs = cand ? segsOf(cand, candDur(cand, target)) : [];
        const cur = linePointOf(target, segs);
        const pt = linePointClamp({ seg: hit.seg, at: hit.at }, segs);
        if (segs.length && (cur.seg !== pt.seg || cur.at !== pt.at)) {
          beginEdit();
          linePointSet(target, pt.seg, pt.at, segs);
          filmEdited();
        }
      }
      openPendingVoice(target, ctx.col);
    };
  });
}
/* 点「待生成」占位 / 台词清单里的一行：把焦点切到那一镜，台词填进合成框，翻到「生成配音」。
   `col` = 这一下是从哪条轨道点的（缺省 = 中栏）：针要画在**那一条**轨道上；
   落点仍只有一个（`linePointOf`），从台词清单点进来也走同一条。
   先画一版（字已经在了），素材库那边取字节回来再补画一次那两格 —— 一条人声可能几 MB，
   为了等它把整个点击拖住不动，用户会以为没点中。 */
function openPendingVoice(sh, col) {
  if (!sh) return;
  const sc = projOf().scenes.find(s2 => s2.shots.includes(sh));
  if (sc) { projOf().curScene = projOf().scenes.indexOf(sc); projOf().curShot = sc.shots.indexOf(sh); }
  const cands = sh.candidates || [];
  let c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId)
    || cands.find(x => x.status === 'succeeded') || cands[0];
  const ci = c ? cands.indexOf(c) : -1;
  if (ci >= 0) projOf().curCand = ci;
  /* **不动 `proj.curVoice` 之外的目标写法**：这里没有一句配音可选中，所以直接把目标交给声音轨；
     占位符不是块，不能走 `selectVoice('')`（那一条会把目标交回画面）。 */
  projOf().curVoice = '';
  projOf().tlLane = 'voice';
  projOf().tlTab = 'shot';
  const total = c ? candDur(c, sh) : 0;
  const segs = c ? segsOf(c, total) : [];
  /* 针落在这一句自己的落点上（不是无条件回第一段起点）：块画在哪、针就落在哪、合成也在哪。
     写 `cutSeg/cutAt` 与画针都走 `setPin` 一处 —— 它按源秒认段，点在灰区里也不会指错段。 */
  const host = col || document.getElementById('midCol');
  if (c && segs.length) {
    const pt = linePointOf(sh, segs);
    setPin(host, sh, c, total, pt.at, 'voice');
  }
  setVcTab('gen');
  const p = lineDraftOf(sh);
  /* 换了一句台词就把上一句的音色草稿清掉（同一句重复点则留着用户手改过的那一份）：
     上一句的参考音频要是留在这一格里，合成出来会是另一个人的声音，而且真扣费。 */
  const sameText = voiceDraftOf().text === p.text;
  if (!sameText) { voiceDraftOf().design = ''; voiceDraftOf().ref = null; }
  voiceDraftOf().text = p.text;
  /* 说话人跟着这一句（换一句就换一个人）——
     「把这一格的声音描述存回素材库」靠它找素材库里那一位。 */
  voiceDraftOf().who = p.who || '';
  renderAll();
  prefillVoiceWho(p.who, { keep: sameText }).then(note => {
    if (curShot() !== sh) return;
    paintTlGroups();
    renderEditor();
    if (note) setStatus('<span class="meta">' + esc(note) + '</span>');
  }).catch(() => {});
}
/* 按说话人去素材库找料：音色设计取那位的 `voiceNote`，音色复刻取那段参考音频的字节。
   找不到人 / 那一位没写描述 / 没挂音频时**一个字都不写**（仍可手挑），但要把原因说出来 ——
   「点了占位符，参考那一格却还空着」必须有一句话解释，否则看着像页面没接上。
   返回的是给人看的那句话（调用方决定往哪儿放），不在这里弹提示。 */
async function prefillVoiceWho(who, opt) {
  const way = voiceWayOf(voiceReg(), projOf().voiceModel || '');
  /* 同一句台词重复点占位符：那一格已经有用户手挑的音色（描述 / 参考音频）就不再用素材库那份盖掉。
     只有「换了一句」才重新按说话人预填。 */
  if (opt && opt.keep) {
    if (way.mode === 'design' && String(voiceDraftOf().design || '').trim()) return '';
    if (way.mode === 'clone' && voiceDraftOf().ref) return '';
  }
  /* 找谁、读音色描述还是取参考音频字节，全在 `Chars.Pipe.voicePrefillOf` 那一份里：
     库里那一列叫什么不出 web/domain/chars.js，这里只认它交回来的 note / blob / why。 */
  const pick = await Chars.Pipe.voicePrefillOf(who, way.mode);
  if (!pick.found) return pick.why;
  if (pick.why) return pick.why;
  if (way.mode === 'design') {
    voiceDraftOf().design = pick.note;
    return '已按素材库「' + pick.name + '」的音色描述填进「声音描述」';
  }
  if (way.mode === 'clone') {
    voiceDraftOf().ref = { assetId: '', src: '', name: pick.refName || pick.name, file: pick.blob };
    return '已把素材库「' + pick.name + '」的参考音频填进「音色素材」';
  }
  return '这一档是预设音色：台词里的说话人「' + pick.name + '」不参与选音色，音色请在下拉里手挑';
}

/* 全片那一排下面的声音行：块的左沿按**成片秒**算（它所在那一格在成片里的起点 + 段内偏移）。
   于是在本镜切一刀之后，这一排的格子数与配音块位置一起跟着变 —— 两处仍是同一份数据的两种读数，
   不是「同步」出来的（配音锚在段上，段在候选上，全片只是把它摊开画一遍）。 */
function filmVoiceHTML(tl, g) {
  const G = g || filmFrames(tl);
  const ax = Math.max(0.05, G.total);
  const per = [];
  /* 这一排时间基（轴秒）上的灰场区间：一句配音压在灰场上时，那几秒跳过（音频停住、
     越过整段接着放），块顺延拉长、重合处画灰带 —— 取法收在 `axisGray` 一份（两条轨共用）。 */
  const gray = axisGray(G);
  G.rows.forEach(r => {
    const cl = r.cl;
    if (cl.kind !== 'shot') return;
    shotVoices(cl.shotId, cl.candId).forEach(v => {
      if ((Number(v.seg) || 0) !== (Number(cl.seg) || 0)) return;
      /* 与「本镜」那一排走同一份折算（`voiceAxBox`）：块在框里的位置 = 选区起点相对框左沿的偏移
         + 段内偏移（`v.at` 一直是「相对选区起点」的，这个口径从它诞生起就没变过 ——
         变的是框基之后「格子的起点」怎么算）。
         这一排的框左沿 = 那一格的轴起点 +（画面选区起点 - 画面框左沿）÷ 倍速 + 配音框的偏移。
         ⚠ 块宽要过两道折算：`v.dur` 是**音频文件秒**（合成侧 atempo 之前那一段），
         ÷ 自己那一档（`own`）才是源秒，再 ÷ `r.spd` 才是轴秒 —— 合成侧正是
         `atempo = speed × spd`（`v.start` 只按画面倍速折算；句自己的倍速只改念多快、不挪位置）。
         少除 `own` 就是「右栏写着 ×1.5、这一排还按 1× 画长一截」。 */
      const bx = voiceAxBox(r, v);
      lanePut(per, v, voiceBlockHTML(v, bx.box, bx.sel, ax,
        '这一段第 ' + round1(bx.box.l - r.start) + ' 秒起，长 ' + round1(bx.dur) + ' 秒', { gray }));
    });
  });
  const orph = orphanVoices().length;
  return voiceLanesHTML(per, laneHidden('voice') ? 1 : laneRowsFor('voice', per.length),
    orph ? laneNm('voice') + '：全片有 ' + orph + ' 句配音挂在没被选用的候选上，进不了成片 —— 切到「本镜」在右栏点「搬回选用的这一镜」'
      : laneNm('voice') + '：切到「本镜」在右栏合成一句配音，它会出现在这里对应的那一格下面');
}
/* 全片那一排：一格 = 一段画面（一条候选剪出几段就是几格），按成片秒定位。
   与本镜同一套形状：格子两端的把手拖这一格的**源视频**头尾（折算回那一条候选的 segs），
   插针跟着成片秒走，点任意位置把焦点切到那一镜那一段（四把剪子剪的就是它）。 */
function renderFilmTrack(bar, col, sh) {
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    bar.insertAdjacentHTML('beforeend',
      '<div class="tl-film" data-ln="0"><div class="tl-empty">还没有已选用的镜头：先在候选上点「用这条」，这里才会出现格子。</div></div>');
    return;
  }
  /* 排版依据 = 各段的**框**（不是成片秒）：剪一段只改它自己框内的灰块，
     别的格、别的格的切片、刻度尺，一个字节都不动（见 filmFrames 的说明）。 */
  const G = filmFrames(tl);
  const total = G.total;
  /* 与「本镜」那一排同一份像素/秒：一格的屏上宽度 = r.w（轴秒）× pps，
     切片密度按**轴秒**现算 —— 用 r.dur 会在 spd ≠ 1 时把格子算宽/算窄，密度跟着偏。 */
  const pps = tlPpsNow(total);
  /* 插针在**这一排的轴秒**上落在哪一格的框里（切片排解码顺序用的热区，见 fillSlices 的 chunkHot）：
     与下面画格子用的是同一个 filmPinT，不在这里另算一份针的位置。 */
  const pinAx = filmPinT(tl, G);
  const curShotNow = curShot();
  const cellHTML = r => {
    /* 与「本镜」那一排同一份判据：**这一格所在那一行**锁着才不画把手（整条轨锁着时每一行都锁）。
       行号读 `r.ln`，而它来自段上的 `s.ln` —— 两排同一个数，不存在「本镜能拖而全片不能」。 */
    const picLocked = rowLocked('pic', r.ln);
    const cl = r.cl, k = r.k;
    const isShot = cl.kind === 'shot';
    const target = isShot ? allShots().find(x => x.id === cl.shotId) : null;
    const cand = target ? tlCandidateOf(target, cl.candId) : null;
    const focus = picSelOn() && !!target && target === curShotNow && Number(cl.seg || 0) === cutSegIdx();
    const nSeg = segsOf(cand, candDur(cand, target)).length;
    const name = target ? (target.name || '镜头') : (cl.name || '素材');
    const keep = round1(Math.max(0.05, tlClipDur(cl)));
    const gone = !!cl.gray;
    const tip = (gone ? `第 ${k + 1} 格：${name} 的第 ${(Number(cl.seg || 0) + 1)}${nSeg > 1 ? '/' + nSeg : ''} 段 · 画面已删掉，成片里出 ${keep} 秒黑场（后面那格不前移）`
      : `第 ${k + 1} 格：${name} 的第 ${(Number(cl.seg || 0) + 1)}${nSeg > 1 ? '/' + nSeg : ''} 段`
        + ` · 保留 ${keep} 秒（这一段在源里分到 ${round1(r.dur)} 秒，灰掉的部分不进成片）`)
        + (picLocked ? '（点一下把焦点切到这里；' + rowLockWhy('pic', r.ln) + '，把手不画、拖不动，顺序也拖不了；'
          + rowUnlockHow('pic', r.ln) + '）'
          : '（点一下把焦点切到这里，四把剪子剪的就是这一条；拖格子两端的把手把这一段的头尾切掉；左右拖这一格 = 把那一镜在成片里挪个先后）');
    /* 格子背景：**每一镜**都铺它自己剪出来的切片图（用户点名「全片剪辑所有镜的切片都应该显示」）。
       取帧区间 = 这一格的**框**（拖把手不改它）→ 剪一刀不会让整排重新解码。
       取不到帧的（外链过期 / 没有候选地址）才退回镜头首帧；黑场没有画面。 */
    const pic = (!isShot || !cand || !cand.url) ? ((target && target.firstFrame) ? Api.mediaSrc(target.firstFrame) : '') : '';
    const slices = gone ? ''
      : (isShot && cand && cand.url)
      ? sliceBoxHTML(candTrackSrc(cand), r.a, r.b, r.w * pps, frameToSrc(r, pinAx))
      : pic ? `<span class="frs"><i class="fr whole" style="background-image:url(&quot;${esc(pic)}&quot;)"></i></span>` : '';
    /* 框内两块灰：左边 = 被切掉的片头（选区起点相对框左沿），右边 = 被切掉的片尾 */
    const masks = isShot
      ? `<span class="mask l" style="width:${pct(Math.max(0, Number(cl.in) || 0) - r.a, r.dur)}%"></span>`
        + `<span class="mask r" style="width:${pct(r.b - Math.max(0, Number(cl.out) || 0), r.dur)}%"></span>`
      : '';
    /* 把手只画给「有源可拖」的画面格（拖的是框内选区，左右两颗）；外来素材一格都不画。
       **画面轨锁上时一颗都不画**（与声音轨同一套：锁 = 不画 + 手势拒，不是画出来再禁用） */
    const cuts = (picLocked || !isShot) ? ''
      : `<span class="cut l" data-k="${k}" data-edge="l"></span><span class="cut r" data-k="${k}" data-edge="r"></span>`;
    /* 小字的前半截（名字 + 段号 + 黑场）也记进 `data-lab`：拖把手时只换后半截的「保留秒数」与倍速，
       以前拖动中重写的是一份更短的串，一上手「黑场」前缀与倍速后缀就没了。 */
    const labPre = esc(name) + (nSeg > 1 ? ' ' + (Number(cl.seg || 0) + 1) : '') + ' · ' + (gone ? '黑场 ' : '');
    return `<div class="tl-seg${focus ? ' sel' : ''}${gone ? ' gone' : ''}" data-k="${k}"
         style="left:${pct(r.start, total)}%;width:${pct(r.w, total)}%"
         title="${esc(tip)}">
      ${slices}${masks}<span class="lab" data-lab="${labPre}">${labPre}${keep}s${r.spd !== 1 ? ' ' + spdTxt(r.spd) : ''}</span>${cuts}</div>`;
  };
  /* 画面轨有几行就摊几行（`r.ln` 读的是那一段上的 `s.ln` —— 与「本镜」那一排同一份数据，
     所以在本镜把某一格挪到第 3 行，切到全片它还在第 3 行）。外来素材没有段可挂，一律第一行。
     空着的中间行照样画：抽掉空行会把上面的行往下塌一格，而那一格正是插针与刻度尺对齐的地方。 */
  const lanes = laneRowsFor('pic', laneRowsOf(G.rows));
  let filmHTML = '';
  for (let ln = 0; ln < lanes; ln++) {
    filmHTML += `<div class="tl-film${rowHidden('pic', ln) ? ' hid' : ''}" data-ln="${ln}">`
      + G.rows.filter(r => r.ln === ln).map(cellHTML).join('') + '</div>';
  }
  bar.insertAdjacentHTML('beforeend', rulerHTML(total, tlPpsNow(total)));
  bar.insertAdjacentHTML('beforeend', filmHTML);
  /* 声音行**无条件画**（用户点名的第 ① 条）：从前这里先看 `voices`，于是「这一片一句配音都没有」
     那一排在界面上根本没有声音轨 —— 针没有可穿的第二行，空白处也无处可点（第 ④ 条要的「点空白 → 生成配音」
     连落点都没有）。本镜那一排本来就是无条件画（见 renderShotTrack），两条轨同一套形状。
     三种情况都仍然要有这一行：一句块都没有（把原因说出来）、有孤句（该进成片却进不了）、
     用户自己加过声音行（行数在两个页签都得落出来）。
     待生成那一轨排在它**下面**（用户点名），每一镜只摆一个占位，跟在它第一格后面。 */
  bar.insertAdjacentHTML('beforeend', filmVoiceHTML(tl, G));
  bar.insertAdjacentHTML('beforeend', filmPendingHTML(tl, G));
  /* 全片字幕行：按成片秒摆，与 SRT / FCPXML 用同一份 filmEntriesOf。 */
  bar.insertAdjacentHTML('beforeend', filmSubLaneHTML(tl, G));
  bar.querySelectorAll('.tl-lane').forEach(l => bindVoiceLane(l, { total: total, film: true }));
  bindPendingLanes(bar, { col, film: true, ax: total, G, tl, fallen: curShotNow });
  bindSubLanes(bar, col, true);
  fillWaveforms(bar);          // 后台填声音轨的波形（不挡轨道出来）
  /* 插针挂在内容层最外面，穿过刻度尺 + 全片行 +（有配音时）声音行 —— 与本镜那一排同一根针的画法。
     放在所有行之后：它不属于任何一行，行的显隐与锁定都不该把它一起收掉。 */
  bar.insertAdjacentHTML('beforeend', `<span class="tl-pin" style="left:${pct(filmPinT(tl, G), total)}%"></span>`);
  syncTlTools();                 // 统一剪辑条跟着这一排重画（本镜 / 全片都走这一份）
  syncLaneSide(col, bar);        // 左边那一列的轨名跟着行数长（画面几行、配音几行各有各的）
  fillSlices(bar);
  bindFilmDrag(bar, tl, total, G);
  bindFilmReorder(bar, col, tl, total, G);
  bindPinZone(col.querySelector('#tlGrid') || bar, col, sh, pinAtX);
  paintPin(col, filmPinT(tl, G), total);
}
/* 全片轨的插针落在哪（成片秒）：焦点那一格的起点 + 插针在源里的偏移（按这一格的速度折算）。
   焦点 = 当前镜头 + cutSeg 指着的那一段；当前镜头没进成片时针停在 0。 */
function filmPinT(tl, g) {
  const G = g || filmFrames(tl);
  const sh = curShot();
  const cands = (sh && sh.candidates) || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId) || null;
  if (!sh || !c) return 0;
  const r = G.rows.find(x => x.cl.kind === 'shot' && x.cl.shotId === sh.id && x.cl.candId === c.vid
    && Number(x.cl.seg || 0) === cutSegIdx());
  if (!r) return 0;
  /* 焦点那一段的插针 = 这一格的轴起点 + 插针在**源**里的秒数相对框左沿的偏移（÷ 倍速换算到轴上）。
     灰区里不放针（它在成片里不存在），所以夹在框内。 */
  const t = srcToFrame(r, Number(projOf().cutAt) || 0);
  return round1(Math.max(r.start, Math.min(r.start + r.w, t)));
}
/* 轨道上那一排的秒（轴秒）→ 这一格里的源秒：点轨道、拖把手、播放跟随共用 frameToSrc / srcToFrame
   这两行（定义在 filmFrames 那一段）。
   写成具名函数是因为三处各写一遍 `in + (t - start) * speed` 迟早有一处忘了乘速度；
   倍速之后又多一根轴，两条方向各一份，任何一处自己拼算式都是下一次「针与格子对不上」。 */
/* 轴秒 t 落在哪一格：返回那一格的镜头 / 候选 / 段下标 / 段内源秒。
   点轨道与「播成片时针跟着走」都走它 —— 两条路必须落在同一个判据上。 */
function filmSeek(tl, tFrame, g) {
  const G = g || filmFrames(tl);
  if (!G.rows.length) return null;
  let r = G.rows[G.rows.length - 1];
  for (const x of G.rows) { if (tFrame < x.start + x.w) { r = x; break; } }
  const cl = r.cl;
  if (cl.kind !== 'shot') return { clip: cl, row: r, start: r.start, target: null, at: 0 };
  const target = allShots().find(x => x.id === cl.shotId);
  const cands = (target && target.candidates) || [];
  const ci = cands.findIndex(x => x.vid === cl.candId);
  const cand = ci >= 0 ? cands[ci] : (target ? tlCandidateOf(target, cl.candId) : null);
  const segs = cand ? segsOf(cand, candDur(cand, target)) : [];
  const si = Math.min(segs.length - 1, Math.max(0, Number(cl.seg) || 0));
  const s = segs[si];
  /* 框里任何位置都换算得出源秒，**包括被剪掉的头尾（灰区）**——
     用户点灰区就是要把针放到那儿（用户点名的第 ⑥ 条）。以前这里把它夹回选区，
     点下去针会自己弹回白区的边上，看着像「灰区点不动」。
     注意这里放开的只是**针**：真正剪的那一刀仍由 `cutSegs` 管（灰区里切头尾照样会夹/拒并说明原因）。 */
  const tSrc = frameToSrc(r, tFrame);
  return { clip: cl, row: r, start: r.start, target: target, cand: cand, ci: ci, segs: segs, si: si, s: s,
    at: round1(tSrc) };
}
/* 点全片轨某一处：焦点切到那一镜那一段 + 插针放到那儿 + 播放器跟着跳。
   opts.quiet = 播放中跟着走的那条路（只挪针与数据，不重画整栏 —— 重画会把正在放的视频换掉）。
   opts.lane  = 用户手势把目标交给哪一轨（'pic' / 'voice'），与 setPin 那一个参数同一份含义。 */
function filmApplyAt(col, tl, tFrame, opts) {
  const G = filmFrames(tl);
  /* 播放跟随（quiet）在**没在播**时既不换焦点也不挪针：拖一下全片的顺序、剪一刀、切页签都会整栏重画
     → 播放器重建 → `TlPlayOf().seek()` 开头无条件 emit 一次 → 走到这一支，递来的是上一次那一秒（新建时是 0 秒）。
     而那一秒在**新顺序**下落的是别的镜，于是「我只是改了个顺序，本镜就变成了另一条」。
     针的位置本来就由焦点算出来（`filmPinT`），所以焦点不动、针也不动才是自洽的。
     真在播的时候仍跟着播放头走（右栏与剪刀指着正在放的那一格是有用的）。 */
  if (opts && opts.quiet && !TlPlayOf().playing) {
    paintPin(col, filmPinT(tl, G), G.total);
    paintTlHint(col, curShot(), (curShot().candidates || [])[projOf().curCand]);
    paintVoicePos(); syncTlTools();
    return;
  }
  const hit = filmSeek(tl, tFrame, G);
  if (!hit) return;
  if (opts && opts.lane) projOf().tlLane = opts.lane;   // 与 setPin 同一件事：**用户**点全片那一排（画面格 / 空白）才把目标交过去（播放跟随不算）
  let msg = '已跳到全片轨第 ' + round1(tFrame) + ' 秒';
  if (hit.target) {
    const sc2 = projOf().scenes.find(s2 => s2.shots.includes(hit.target));
    if (sc2) { projOf().curScene = projOf().scenes.indexOf(sc2); projOf().curShot = sc2.shots.indexOf(hit.target); }
    if (hit.ci >= 0) projOf().curCand = hit.ci;
    if (hit.s) { projOf().cutSeg = hit.si; projOf().cutAt = hit.at; }
    msg += '，焦点切到「' + (hit.target.name || '镜头') + '」第 ' + (hit.si + 1) + '/' + hit.segs.length + ' 段';
  }
  paintPin(col, tFrame, G.total);
  const bar = col.querySelector('#tlBar');
  /* 这一排的亮环同样只给「目标那一轨」：点在空白处（目标交给配音）时 `kk` 取 -1，一格都不亮。 */
  if (bar) { const kk = picSelOn() ? hit.row.k : -1;
    bar.querySelectorAll('.tl-film .tl-seg').forEach(x => x.classList.toggle('sel', Number(x.dataset.k) === kk)); }
  paintVoiceSel();          // 与「本镜」那一排同一件事：目标换了，配音那一排的亮环要跟着收
  dropPicSel();             // 反过来那一下：目标交给配音时，本镜那一排残留的白环也要当场掉
  if (opts && opts.quiet) { paintTlHint(col, curShot(), (curShot().candidates || [])[projOf().curCand]); paintVoicePos(); syncTlTools(); return; }
  /* 跳到这一格这一秒：全片那一档放的是**整片**（`TlPlay` 按时间线调度），
     所以「这一格的源秒」要先折成**成片秒** = 计划里那一笔的起点 + 段内偏移 ÷ 这一格的倍速。
     按 `fs`（框基起点）认计划里那一笔，不按下标对：没有可用地址的格子不进计划，
     下标会错位（`hit.row.f0` 是几何表的数，那种时候与计划的轴对不上）。
     暂停与定位一起交给 TlPlayOf() —— 与「本镜」那一档同一个立场（见 `bindPinZone`）：
     以前这里递的是 `hit.at`（那一格的**源**秒）而且只打甲板 A —— 真在播时前甲板可能是 B，
     整个动作打在后甲板上；`TlPlayOf().playing` 也没落定，下一帧播放跟随又把针推回去。 */
  const planI = TlPlayOf().plan.findIndex(p => Number(p.fs) === hit.row.start);
  const segOff = Math.max(0, Math.min(Number(hit.row.fd) || 0,
    (Number(hit.at) - Math.max(0, Number(hit.clip.in) || 0)) / (Number(hit.row.spd) || 1)));
  TlPlayOf().pause();
  TlPlayOf().seek((planI >= 0 ? TlPlayOf().starts[planI] : (Number(hit.row.f0) || 0)) + segOff, false);
  setStatus(msg);
  renderScenes(); renderEditor();
  paintTrimRow();               // 入出点那一行跟着新焦点走（renderEditor 只重画右栏，不重画工具条那一行）
  paintTlHint(col, curShot(), (curShot().candidates || [])[projOf().curCand]);
  scheduleSave();
}
/* 全片轨的把手：拖的是**这一格的源视频头尾**（折算回那一条候选的 segs）。
   拖动期间只改框内那两块灰与那行小字 —— 格子的位置与宽度由**框**定，把手不改框，
   所以别的格一格都不挪位（松手才写数据、才整栏重画）。
   ⚠ 与「本镜」那一排同一条纪律：拖动全程不碰剪针（`dragBusy()` 期间针本来就该站着）。 */
function bindFilmDrag(scope, tl, total, g) {
  const G0 = g || filmFrames(tl);
  /* 拖动中只重画**框内的两块灰**与那行小字 —— 格子的 left/width（由框定）、别的格、
     整排切片，一个字节都不动。这正是「剪一段不影响别的段」在全片轨上的落点。
     ⚠ 格子按行分在好几个 `.tl-film` 里，DOM 顺序不再等于格号，所以只能按 `data-k` 找回节点。 */
  const repaint = () => {
    const G2 = filmFrames(tlSyncFromShots());
    const cells = {};
    scope.querySelectorAll('.tl-seg').forEach(x => { cells[Number(x.dataset.k)] = x; });
    G2.rows.forEach(r => {
      const cell = cells[r.k];
      if (!cell) return;
      /* 画面格的把手**不改框**（拖的是框内选区），所以这一支一格的位置与宽度都不重摆 ——
         只跟着改框内那两块灰与那行小字。 */
      const bw = Math.max(0.01, r.dur);
      const ml = cell.querySelector('.mask.l'), mr = cell.querySelector('.mask.r');
      if (ml) ml.style.width = pct(Math.max(0, Number(r.cl.in) || 0) - r.a, bw) + '%';
      if (mr) mr.style.width = pct(r.b - Math.max(0, Number(r.cl.out) || 0), bw) + '%';
      const lab = cell.querySelector('.lab');
      /* 拖动中只换「保留几秒」；倍速这一段不变，照旧带在尾巴上（`data-lab` 里已有名字/段号/黑场）。 */
      if (lab && lab.dataset.lab) {
        const sp = Number(r.spd) || 1;
        lab.textContent = lab.dataset.lab + round1(Math.max(0.05, tlClipDur(r.cl))) + 's' + (sp !== 1 ? ' ' + spdTxt(sp) : '');
      }
    });
  };
  scope.querySelectorAll('.cut').forEach(el => {
    const edge = el.dataset.edge;
    el.title = edge === 'l' ? '拖动设置这一段的开头（灰掉的那块就是被切掉的）' : '拖动设置这一段的结尾（灰掉的那块就是被切掉的）';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      const r = G0.rows[Number(el.dataset.k)];
      if (!r || !r.cl) return;
      if (r.cl.kind !== 'shot') return;
      const target = allShots().find(x => x.id === r.cl.shotId);
      const cand = target ? tlCandidateOf(target, r.cl.candId) : null;
      if (!cand) return;
      const cTotal = candDur(cand, target);
      const segIdx = Math.min(segsOf(cand, cTotal).length - 1, Math.max(0, Number(r.cl.seg) || 0));
      const before = segsCopy(segsOf(cand, cTotal));   // 拖动之前的那一份（配音要按它还原绝对秒）
      const rect = scope.getBoundingClientRect();
      const move = ev => {
        /* 指针 → 框基秒 → 这一格里的**源秒**（框的左沿 + 框内偏移），再夹在框里：
           拖不出这一格分到的那一块，所以相邻格永远不会叠在一起。 */
        const tFrame = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))) * total;
        const tSrc = frameToSrc(r, tFrame);
        const list = segsCopy(segsOf(cand, cTotal));
        const seg = list[segIdx]; if (!seg) return;
        if (edge === 'l') seg.in = Math.max(seg.a, Math.min(tSrc, seg.out - SEG_MIN));
        else seg.out = Math.min(seg.b, Math.max(tSrc, seg.in + SEG_MIN));
        cand.segs = list;                     // 拖动期间只动 segs（trimS/trimE 在松手时统一回写）
        repaint();
      };
      const up = () => {
        el.classList.remove('act');
        const now = segsOf(cand, cTotal);
        segsWrite(cand, cTotal, now);
        const moved = reanchorVoices(target, cand, before, now);
        /* 焦点跟着被拖的那一镜走：四把剪子与入出点那一行接着就指着它 */
        const sc2 = projOf().scenes.find(s2 => s2.shots.includes(target));
        if (sc2) { projOf().curScene = projOf().scenes.indexOf(sc2); projOf().curShot = sc2.shots.indexOf(target); }
        const ci = (target.candidates || []).findIndex(x => x.vid === cand.vid);
        if (ci >= 0) projOf().curCand = ci;
        projOf().cutSeg = Math.min(now.length - 1, segIdx);
        setStatus(trimStatus(target, cand, moved ? '有 ' + moved + ' 句配音被切到段外，已挪到下一段开头' : ''));
        filmEdited();
      };
      /* `.act` 排在三道守卫之后：认不出这一格 / 不是镜头格 / 找不到那条候选时 `up` 根本不会跑，
         起手就加粗会留下一根永远亮着的把手。 */
      el.classList.add('act');
      dragOnWindow(move, up);
    });
  });
}
/* 全片那一排：左右拖某一格 = 把**那一镜**在成片里挪个先后（用户点名的「成片剪辑应该可以任意拖动
   不同镜头的顺序」）。改的只有 `projOf().filmOrder` 这一份覆盖清单 —— 分镜表里镜头的先后不动，
   所以左栏的场景与镜头列表、AI 分镜的落点都不会被一次剪辑拖乱。
   拖动中途只画一根「插到这儿」的竖线，不重排格子：整栏重画会把手指底下的节点销毁（这是旧病）。
   松手才写数据并走 `filmEdited()`（整栏重画 + 说一句「盘上那份是旧的」，不自动跑 ffmpeg）。
   一镜有几段就一起走（格子按段摊开，但顺序是**按镜**记的）；贴在某一镜后面的黑场跟着那一镜走
   （它在 clips 里就锚在那一镜之后）；**那一格所在的那一行**锁着时这个手势一个字都不接
   （与把手、换行、本镜那一排同一份判据 `rowLocked`）。
   **上下拖同一格 = 换到画面轨的另一行**（用户点名的第 ⑥ 条「视频要能跨轨道拖到别的轨道上去」）：
   走的是 `setCellLane` 那一份落地，行号与「本镜」那一排同一个数；中途跟着指针的是那张缩略图小卡
   （第 ⑧ 条），不是把格子真搬过去 —— 整栏在拖动中途重画会把手指底下的节点销毁。 */
function bindFilmReorder(scope, col, tl, total, g) {
  const G0 = g || filmFrames(tl);
  /* 每一镜在这一排上占的那一段区间（[轴起点, 轴终点)）：判断落在谁身上要以镜为单位，
     否则一镜的第 2 段会把自己的第 1 段当成「别一镜」。 */
  const spans = [];
  G0.rows.forEach(r => {
    if (!r.cl || r.cl.kind !== 'shot') return;
    let s = spans.find(x => x.id === r.cl.shotId);
    if (!s) spans.push(s = { id: r.cl.shotId, name: r.cl.name || '', a: r.start, b: r.start + r.w });
    s.a = Math.min(s.a, r.start); s.b = Math.max(s.b, r.start + r.w);
  });
  scope.querySelectorAll('.tl-film .tl-seg').forEach(el => {
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('.cut')) return;                 // 把手那一路（剪头尾）自己管
      const r0 = G0.rows[Number(el.dataset.k)];
      if (!r0 || !r0.cl || r0.cl.kind !== 'shot') return;   // 黑场与外来素材不参与重排
      const mine = r0.cl.shotId;
      const rect = scope.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY;
      const step = picLaneStep(el.closest('.tl-film') || el);
      const ln0 = r0.ln;
      /* 锁问的是**这一格所在那一行**（整条轨锁着时每一格都锁）：锁了第 2 行，第 1 行的格子照样能挪顺序、能换行。 */
      if (rowLocked('pic', ln0)) return;
      let moved = 0, mark = null, want = null, mode = '', lnWant = ln0;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        /* 起手时那一下位移更大的方向**一次定死**这一趟是「挪顺序」还是「换行」，中途不改判：
           一边拖一边换判据会把一次手势劈成两半（先换了行又去插顺序），而松手只落得下一件事。
           与配音块那一路（`bindVoiceLane` 的「竖直位移更大才算换行」）同一立场。 */
        if (!mode) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          mode = Math.abs(dy) > Math.abs(dx) ? 'lane' : 'order';
          moved = 1; el.style.opacity = '.72';       // 单击不闪暗，真拖起来才淡下去
          dragGhostShow(ev, el, (el.querySelector('.lab') || {}).textContent);
        } else dragGhostMove(ev);
        if (mode === 'lane') {
          lnWant = laneClamp(ln0 + Math.round(dy / step));
          el.style.transform = 'translateY(' + round1((lnWant - ln0) * step) + 'px)';
          return;
        }
        const tFrame = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))) * total;
        /* 目标 = 指针所在那一镜（跳过自己）；落在它右半边就插到它后面，左半边插到它前面。
           指针还在自己那一镜的范围里（或落在两镜之间的缝上）时按**拖动方向**取紧邻的那一镜：
           往右就是右边那一镜，往左就是左边那一镜 —— 不判方向的话，往左拖会挑到右边那一镜，
           于是「把它往前挪」点松手却把它甩到了整排末尾。 */
        const others = spans.filter(x => x.id !== mine);
        let t = others.find(x => tFrame >= x.a && tFrame < x.b);
        if (!t) {
          t = dx > 0 ? (others.find(x => tFrame < x.a) || others[others.length - 1])
            : (others.slice().reverse().find(x => tFrame >= x.b) || others[0]);
        }
        if (!t) { if (mark) { mark.remove(); mark = null; } want = null; return; }
        const after = tFrame > (t.a + t.b) / 2;
        want = { id: t.id, after: after };
        /* 指示线挂内容层 `.tl-inner`（与插针同一个宿主、同样穿满整排），不挂在被点那一格里：
           挂在行里就只有那一行高，而「插到第几秒」是整块轨道共用的一件事。 */
        if (!mark) { mark = document.createElement('span'); mark.className = 'tl-drop'; scope.appendChild(mark); }
        mark.style.left = pct(after ? t.b : t.a, total) + '%';
      };
      const up = () => {
        dragGhostHide();
        if (mark) mark.remove();
        el.style.opacity = '';
        el.style.transform = '';
        if (!moved) return;
        setTrackDragT(Date.now());   // 松手那一下的 click 不算放针（用户拖的是顺序 / 行）
        if (mode === 'lane') {
          if (lnWant === ln0) {
            /* 绕回原来那一行：一个数都没改，不许打「✓ 挪到了」（与本镜那一路同一句纪律） */
            setStatus('<span class="info">这一段拖回了画面轨第 ' + (ln0 + 1) + ' 行，位置没变</span>');
            return;
          }
          const target = allShots().find(x => x.id === r0.cl.shotId);
          const cand = target ? tlCandidateOf(target, r0.cl.candId) : null;
          if (!setCellLane(target, cand, Number(r0.cl.seg) || 0, lnWant)) return;
          setStatus('<span class="ok">✓ 「' + esc(r0.cl.name || '镜头') + '」第 ' + ((Number(r0.cl.seg) || 0) + 1)
            + ' 段挪到了画面轨第 ' + (lnWant + 1) + ' 行（切到「本镜」看还是这一行：两条轨存的是同一个行号；'
            + '进成片的顺序、时长与切片一个字没动，这一行的基数音量在右栏那张卡上调）</span>');
          filmEdited();
          return;
        }
        if (!want || want.id === mine) return;
        if (!moveShotInFilmOrder(mine, want.id, want.after)) return;
        const tn = spans.find(x => x.id === want.id) || {};
        setStatus('<span class="ok">✓ 已把「' + (r0.cl.name || '镜头') + '」挪到「' + (tn.name || '那一镜') + '」'
          + (want.after ? '后面' : '前面') + '（每一段的入出点、音量、倍速与配音都没动；分镜表里的先后也没动，'
          + '要退回拖之前那一份顺序按上面那排「撤销」（或 Ctrl+Z））</span>');
        filmEdited();
      };
      e.preventDefault(); e.stopPropagation();
      dragOnWindow(move, up);
    });
  });
}

  return {
    tlZoomBy,
    tlZoomWheel,
    tlZoomAuto,
    tlZoomSetPos,
    tlZoomCommit,
    renderTimeline,
    shotAxText,
    lineLandedNote,
    pendingLineOf,
    openPendingVoice,
    filmPinT,
    filmApplyAt,
  };
}
