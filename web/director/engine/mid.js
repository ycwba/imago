/* 导演台Mid域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createMid(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1 } from '../util.js';
import { SEG_MIN, segCarry, segsOf, segsWrite, laneClamp } from '../segments.js';
import { voiceRateOf, voiceFrameOf, roundVoice } from '../voice-layout.js';
import { linksOf, setLinks } from '../links.js';

export function createMid(E, document, window) {
  const {
    $,
    playSafe,
    TlPlay,
    projOf,
    allShots,
    curScene,
    curShot,
    fmtDur,
    shotDurText,
    trimStatus,
    shotReady,
    totalDur,
    undoStack,
    redoStack,
    UNDO_MAX_BYTES,
    UNDO_MAX_COUNT,
    undoMeterText,
    undo,
    redo,
    candDur,
    filmFrames,
    shotFrames,
    shotPinT,
    shotAxTotal,
    cutSegIdx,
    dragBusy,
    reanchorVoices,
    tlCutTarget,
    laneHidden,
    rowFlagToggle,
    addLaneRow,
    dropLaneRow,
    laneMuteToggle,
    tlSyncFromShots,
    setLaneVol,
    laneToggle,
    runCut,
    setTrackVol,
    syncTlTools,
    filmEdited,
    scheduleSave,
    thumbKey,
    shotStatusOf,
    candThumbInner,
    candPlaceholder,
    candAddTile,
    midCandExpandOf,
    tlPlayheadOf,
    bindTlPlay,
    bindPbFull,
    fullscreenHold,
    playerMediaOf,
    playerAreaHTML,
    candActsHTML,
    bindCandActs,
    selectCandidate,
    scrollCurThumbIntoView,
    bindCandidateStrip,
    sortCandidates,
    renderScenesSoon,
    midEditTrimOf,
    isFilmMode,
    midOrderOf,
    setTrimMode,
    curDraftCand,
    paintPin,
    setPin,
    paintTrimRow,
    tlVoiceHit,
    voiceMin,
    laneRowCtlHTML,
    laneRowBtnsHTML,
    tlScrollWantOf,
    tlZoomBy,
    tlZoomWheel,
    tlZoomAuto,
    tlZoomSetPos,
    tlZoomCommit,
    renderTimeline,
    shotAxText,
    filmApplyAt,
    stepShot,
    syncGenGate,
    syncAtBack,
    renderEditor,
    openLibDlg,
    renderAll,
    setStatus,
    setTlPlayhead,
    setMidOrder,
    setTlScrollWant,
  } = E;

function promptTextOf(sh) {
  const c = sh && (sh.candidates || [])[projOf().curCand];
  if (c && c.prompt != null && c.prompt !== '') return c.prompt;
  return (sh && sh.prompt) || '';
}
/* 把提示词框按**当前查看的候选**刷一遍（字数、@ 高亮镜像、按钮状态一起）。
   selectCandidate 走的就是它 —— 那一条路刻意不重画整栏（重画会重建候选缩略图）。 */
function paintPromptBox(sh) {
  const ta = $('edPrompt');
  if (!ta || !sh) return;
  const txt = promptTextOf(sh);
  if (ta.value !== txt) ta.value = txt;
  const pc = $('pCnt'); if (pc) pc.textContent = ta.value.trim().length + ' 字';
  syncGenGate(sh);
  syncAtBack(sh);
}
function playerEmptyText(sh) {
  if (curDraftCand()) return ['这条候选还没有描述', '在右侧「提示词」里写一句，再点「生成这条」'];
  /* 还没写提示词时**不要**推荐「AI 润色提示词」：那道润色入口的守卫是
     「提示词不能为空」（见 polish 那一支的 if (!sh.prompt.trim())），
     而新工作区默认只有一个空镜头 —— 于是这句话推荐的那个按钮，
     对第一次打开的人**必定失败**。
     也不能说「直接点生成，平台会自己编」：空提示词会被 shotBlockReason 拦下（NO_PROMPT_WHY），
     生成按钮压根不发起请求 —— 那是另一句兑现不了的承诺。
     只说一件照做就能成的事：先写一句。（引号里给出可照抄的句式，省掉「该写什么」的猜测。） */
  if (!sh.prompt.trim()) return ['这一镜还没有画面描述',
    '先在右边写一句就能生成 —— 例：「她站在天台栏杆边，风把头发吹起来，背影」'];
  if (!sh.candidates.length) return ['画面还没生成', '点右侧「生成这一镜（' + (sh.draw || 1) + ' 条）」开始生成'];
  if (sh.candidates.some(c => Wb.stLive(c.status))) return ['正在生成这一镜…', '排队位置与进度见下方候选卡片'];
  if (sh.candidates.every(c => ['failed', 'cancelled'].includes(c.status))) return ['这一镜生成失败', '候选卡上有失败原因，改改提示词或换个型号再来一次'];
  return ['候选还没有画面', '稍等片刻，或点右侧再生成一条'];
}
/* 画面比例：按真实画面尺寸算（导入的本地视频 / 资产库选的视频 / 生成的视频都用它），
   标准比例给「16:9」这种写法，非标准给近似整数比或小数比；tooltip 里带实际像素 */
function ratioLabel(w, h) {
  if (!w || !h) return '';
  const STD = [[16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 3, '4:3'], [3 / 4, '3:4'], [1, '1:1'],
               [21 / 9, '21:9'], [9 / 21, '9:21'], [3 / 2, '3:2'], [2 / 3, '2:3'], [5 / 4, '5:4'], [4 / 5, '4:5']];
  const r = w / h;
  for (const [v, l] of STD) if (Math.abs(r - v) / v < 0.02) return l;      // 2% 以内算标准比例
  const g = (a, b) => (b ? g(b, a % b) : a);
  const k = g(w, h) || 1;
  const a = Math.round(w / k), b = Math.round(h / k);
  return (a <= 40 && b <= 40) ? a + ':' + b : r.toFixed(2) + ':1';
}
function updateArBadge(media) {
  const el = document.getElementById('arBadge');
  if (!el || !media) return;
  const w = media.videoWidth || media.naturalWidth || 0, h = media.videoHeight || media.naturalHeight || 0;
  if (!w || !h) return;
  el.textContent = ratioLabel(w, h);
  el.title = w + '×' + h;
}
/* 撤销 / 重做那两颗按钮：原来只有快捷键，不知道有这功能的人一直找不到，
   而笔记本 / 外接键盘没有 Ctrl 的场景**完全无法撤销**。
   disabled 按栈长现算 —— 判据就是 undoStack / redoStack 那两处，与按键走同一份，
   所以按钮与快捷键永远不会出现「一个能点一个不能」。 */
/* 拖动中途被推迟的那一次中栏重建（见 renderMid 开头那一条）：只留一个待补的定时器 */
let midDeferT = 0;
function renderMid() {
  /* 手里正有一次拖动 → 这一轮不重建整列（`dragBusy()` 一份判据，三处手势都算）。
     撞在拖动中途重建会把手指底下那个节点换掉：拖动中的就地重画找不到节点，
     表现是「拖到一半画面不动，松手才跳到位」，而轮询每 3 秒就会撞一次。
     松手那一下本来就走了 `filmEdited()` → 整栏重画，所以这一支只是兜底：
     手势的 `up` 里有提前 return（没改动任何东西）时，这一栏仍然会在拖动结束后补画一次。 */
  if (dragBusy()) {
    if (!midDeferT) midDeferT = setTimeout(() => { midDeferT = 0; if (!dragBusy()) renderMid(); }, 600);
    return;
  }
  const col = $('midCol');
  /* 全屏正开着 → 这一轮欠着，退出那一刻补画（判据与理由在 `fullscreenHold`）。
     必须排在 `dragBusy()` 后面、`col.innerHTML =` 那一族任何写操作之前 —— 早退得越靠前，
     少做的副作用越多（下面那几行会改 `proj.curCand`、`tlScrollWant`、`keepBox` 的记账）。 */
  if (fullscreenHold(col)) return;
  const sc = curScene(), sh = curShot();
  if (!sh) { col.innerHTML = window.Wb.emptyHTML('左侧添加场景和镜头开始创作'); return; }
  /* 记住播放器状态：整列会被重建（轮询每 3 秒一次），同一 src 时接着播，不再打断预览。
     剪辑态记的是「成片第几秒」而不是甲板的 currentTime —— 后者是**段内**秒，
     剪成几段之后拿它当进度接回去，会跳到另一段上去。 */
  const oldPl = col.querySelector('#player');
  const keepPlay = midEditTrimOf()
    ? (TlPlay.plan.length ? { t: TlPlay.t, paused: !TlPlay.playing } : null)
    : (oldPl ? { src: oldPl.getAttribute('src'), t: oldPl.currentTime, paused: oldPl.paused } : null);
  const idx = allShots().indexOf(sh) + 1;
  sortCandidates(sh);                              // 有片的排前面、排队/生成中的排后面（顺序变了当前条会跟着走）
  const cands = sh.candidates;
  if (cands.length) projOf().curCand = Math.max(0, Math.min(Number(projOf().curCand) || 0, cands.length - 1));
  const filmMode = isFilmMode();
  const cur = cands[projOf().curCand] || cands[0];
  const sel = sh.candidates.find(c => c.vid === sh.selId);
  // 候选条的横向滚动位置也要保留：新增候选 / 轮询刷新后不再自动跳回第一条
  const oldThumbBox = col.querySelector('#candThumbs');
  const keepThumbScroll = oldThumbBox ? oldThumbBox.scrollLeft : 0;
  /* 时间轴滚到哪儿了也要记住：整列每 3 秒重建一次，不还原的话每 3 秒被弹回最左边 ——
     片子一长（轨道比屏幕宽）这件事就变成「根本没法看后面那几段」。 */
  const oldTlBar = col.querySelector('#tlBar');
  if (oldTlBar && oldTlBar.scrollLeft > 0) {
    setTlScrollWant(oldTlBar.scrollLeft);
  }
  /* 纵向也一样要记：`col.innerHTML =` 是「先把子节点清空、再插新的」，那一栏的滚动位置在清空
     那一刻被夹回 0 —— 与上面两处（候选条 scrollLeft / 轨道 scrollLeft）是同一族，只是从前只补了横的。
     表现是「正看着时间轴那一排调剪辑，一次重建就弹回栏顶」。窄窗（≤900px）时滚动的是整页而不是
     这一栏（`body{overflow:auto}` 那一条媒体查询），所以两处都记、两处都还。 */
  const keepY = col.scrollTop, keepWinY = window.scrollY || 0;
  /* 整列重建会把播放区那一只 `.player-box` 一起换掉（新节点要重新加载素材、重新 seek，
     画面黑一下 —— 每 3 秒一次）。能保住就摘下来、画完塞回原处：节点不动就没有「闪」。
     什么时候保（两种「不保」都比闪更糟）：
     · **剪辑态**：这一轮画的还是一只播放器、旧的那只**确实是剪辑态那对甲板**（有 `#playerB`），
       且 `TlPlay` 手里有计划。以前只在「正在播」时保 —— 暂停状态照样每 3 秒销毁重建，
       而「我只是看着暂停的画面改剪辑」正是最常走的那一条。
     · **不剪辑**：新画的这只放的**还是同一条素材**才保。换了候选 / 换了镜头，src 不是一个，
       保着旧节点等于显示另一条视频。
     ⚠ 保住之后下面那段「一次性接线」要跟着跳过：`addEventListener` 挂在一只长期活着的节点上
       会一层层叠，几十格之后同一个 `timeupdate` 上有几十个 `syncTime`，每个闭包抓着它那一轮的候选。 */
  let keepBox = null;
  {
    const old2 = col.querySelector('.player-box');
    const pm = playerMediaOf(sh);
    if (!old2) { /* 这一轮本来就没有播放器可保（空态 / 还没候选） */ }
    else if (pm && oldPl && oldPl.getAttribute('src') === pm.src) { keepBox = old2; old2.remove(); }
    else if (midEditTrimOf() && old2.querySelector('#playerB') && TlPlay.plan.length) { keepBox = old2; old2.remove(); }
  }
  col.innerHTML = `
    <div class="mid-head">
      <span class="no">${String(idx).padStart(2, '0')}</span>
      <input class="sname" value="${esc(sh.name)}">
      <span class="meta">${esc(sc.name)} · ${shotDurText(sh)} · ${sel ? '已选用' : '未选用'}</span>
      <span class="sp"></span>
      <button class="ghost" id="prevShot">‹</button>
      <button class="ghost" id="nextShot">›</button>
      <!-- 撤销 / 重做：见renderMid 开头那段说明；disabled 按栈长现算 -->
      <button class="ghost" id="btnUndo" title="撤销上一步（Ctrl+Z）。上限 ${UNDO_MAX_COUNT} 步 / ${window.fmtBytes(UNDO_MAX_BYTES)}，右边写着现在用到第几步"${undoStack.length ? '' : ' disabled'}>撤销</button>
      <button class="ghost" id="btnRedo" title="重做（Ctrl+Y）"${redoStack.length ? '' : ' disabled'}>重做</button>
      <span class="meta" id="undoMeter" title="能撤销的步数 / 上限；内存快用满时会补一句字节数">${esc(undoMeterText())}</span>
      <!-- 这一排不再有合片出口：「导出成片 / 导出素材」搬到页头导入导出那一排，
           「播放成片」那一颗整颗删掉（2026-10 用户点名）—— 看效果走下面播放器那一排的播放，
           它按时间线实时播，从不为播放合成。 -->
    </div>
    <div class="player-wrap" id="playerWrap">${playerAreaHTML(sh)}</div>
    <div class="cand-strip${midCandExpandOf() ? ' expanded' : ''}">
      <div class="thumbs" id="candThumbs">${cands.length ? cands.map((c, i) => candThumbInner(c, i === projOf().curCand)).join('') + candAddTile() : candPlaceholder()}</div>
      ${cands.length ? `<span class="cand-pager">
        <button class="ghost" id="candExpand" title="${midCandExpandOf() ? '收成一排左右滚动' : '展开成多行，一屏看完所有候选'}">${window.icon(midCandExpandOf() ? 'chevronUp' : 'chevronDown', 13)}<span class="tx">${midCandExpandOf() ? '收起' : '展开'}</span></button>
        <button class="ghost" id="cPrev" title="上一条候选">${window.icon('stepBack', 14)}</button>
        <span style="font-size: var(--fs-12);color:var(--sub)">第 ${projOf().curCand + 1} / ${cands.length} 条</span>
        <button class="ghost" id="cNext" title="下一条候选">${window.icon('stepNext', 14)}</button>
      </span>` : ''}
    </div>
    <div class="cand-acts" id="candActs" style="padding: 0 var(--sp-16) var(--sp-6);justify-content:flex-end">
      ${candActsHTML(sh)}
    </div>
    <div class="mid-tools">
      <button class="ghost ${midOrderOf() ? 'active' : ''}" id="ordBtn">${icon('list', 13)} 顺序</button>
      <button class="ghost ${midEditTrimOf() ? 'active' : ''}" id="trimBtn">${icon('scissors', 13)} 剪辑</button>
      <button class="ghost" id="libImportMid">${icon('box', 13)} 导入视频 / 素材</button>
      <span class="total">全片 ${fmtDur(totalDur())}</span>
    </div>
    ${midEditTrimOf() ? `
    <div class="timeline-wrap">
      <div class="tl-tabs">
        <span class="ui-seg" role="tablist" aria-label="时间线范围">
          <button type="button" class="${(projOf().tlTab || 'shot') === 'shot' ? 'on' : ''}" data-tab="shot" role="tab" aria-selected="${(projOf().tlTab || 'shot') === 'shot' ? 'true' : 'false'}">本镜</button>
          <button type="button" class="${projOf().tlTab === 'film' ? 'on' : ''}" data-tab="film" role="tab" aria-selected="${projOf().tlTab === 'film' ? 'true' : 'false'}">全片</button>
        </span>
        <span style="flex:1"></span>
        <span class="tl-tip" style="font-size: var(--fs-11-5);color:var(--sub)">${(projOf().tlTab || 'shot') === 'shot' ? '把这一条候选切成几段、逐段调入出点' : '点一格把焦点切到那一镜，四把剪子剪的都是焦点那一条；左右拖一格 = 把那一镜挪到别一镜前面'}</span>
        <!-- 时间轴缩放（与剪映一致：时间长了整条比屏幕宽，左右拖；Ctrl+滚轮也行）。
             「自适应」= 短片子正好铺满、长片子铺到 12px/秒 就停并开始左右滚动（见 tlCurrentPps）。
             手动缩小**没有那条下限**：可以一直缩到比这条轨道还短，右边留出空白（见 tlMinPps）。
             排布 = [−] [滑块] [+] [读数] [自适应]：滑块是对数位置（px/秒是倍率），一动就切到手动档；
             「自适应」是独立按钮（已在自适应档时 disabled），读数只显示数字、不再兼任出口。
             ⚠ 这几件都别加 data-tab：页签绑定只认 .tl-tabs 里带 data-tab 的按钮（见下面绑定那段）。 -->
        <span class="tl-zoom" title="时间轴缩放：放大看细节，缩小看全局（Ctrl + 滚轮也行；缩小可以缩到比整条轨道还短）">
          <button type="button" id="tlZoomOut" title="缩小（看全局，能缩到比这条轨道还短）">${icon('minus', 13)}</button>
          <input type="range" id="tlZoomRange" min="0" max="1000" step="1" value="0" aria-label="时间轴缩放（像素/秒，对数）" title="拖动无极调节像素/秒（对数刻度）">
          <button type="button" id="tlZoomIn" title="放大（看细节）">${icon('plus', 13)}</button>
          <span class="tl-zval" id="tlZoomVal">自适应</span>
          <button type="button" id="tlZoomAuto" title="回到自适应" disabled>自适应</button>
        </span>
      </div>
      <div class="tl-tools" id="tlTools">
        <button class="tool mini" data-cut="play" id="tlListen" hidden>${icon('play', 12)} 试听</button>
        <button class="tool mini" data-cut="split" title="在插针处把这一段切成两段">${icon('scissors', 13)} 切开</button>
        <button class="tool mini" data-cut="left" title="丢掉插针左边的画面（这一段从插针开始）">${icon('arrowLeft', 13)} 向左切</button>
        <button class="tool mini" data-cut="right" title="丢掉插针右边的画面（这一段到插针为止）">${icon('scissors', 13)} 向右切</button>
        <button class="tool mini danger" data-cut="drop" title="删掉插针所在的那一段（格子不消失，原地变黑场，后面的段不前移）">${icon('trash', 13)} 删掉</button>
        <button class="tool mini" data-cut="merge" title="把插针这一段与它旁边挨着的那一段合回一段（只对「一刀切开、没再动过」的两段有效）">${icon('link', 13)} 融合</button>
        <button class="tool mini" data-cut="gap" title="在插针处插一段空（轨道上多一格灰格，成片里那几秒是黑的、占时间）">${icon('plus', 13)} 空一段</button>
        <button class="tool mini" data-cut="close" title="把选中的空段整段摘掉（成片里那几秒消失，后面的段前移）">${icon('minus', 13)} 摘掉空段</button>
        <!-- 「不剪了」那颗已删（用户点名的第 8 条）：它把「一键抹掉这一条上所有剪切」放在最顺手的位置，
             而 undo（Ctrl+Z / 页头那颗「撤销」）本来就是干这件事的，且还能退回去。
             各处文案里指着它的地方一起换成那条真出路 —— 见 cutSegs 的拒绝语与 paintTrimRow。 -->
      </div>
      <!-- 试听 / 切开那一排的**下一行**（用户点名的第 ① 条）：只读这一句配音的文字。
           内容由 paintVoiceLine 一处写（从 syncTlTools 调）：**选中配音块**时露出来；点画面格、
           点声音轨的空白处都整行收起（空白处那一下会把 curVoice 清掉）。文字取整句、不截断。 -->
      <div class="tl-vline" id="tlVoiceLine" hidden>
        <span class="vl-chip">配音</span>
        <b class="vl-who" id="tlVoiceWho"></b>
        <span class="vl-text" id="tlVoiceText"></span>
        <span class="vl-time" id="tlVoiceTime"></span>
      </div>
      <!-- 读数那一行（用户点名：配音行要在「全片 1 秒 · 第 1/2 格 · …」**上方**）。
           它单独占一行，不再挤在剪子那条 flex-wrap 里 —— 否则按钮排满之前它一直吊在右端，
           配音行一出现就跑到读数下面去了。 -->
      <div class="tl-hint" id="tlHint"></div>
      <!-- 两条轨 + 左边那一列轨名 = 一张两列网格（照参考图的形状）：
           左列不跟着横向滚（轨名一直在手边），右列才是滚动容器。
           每一行的显 / 锁两颗按钮：锁是真的把手势拒掉（判据见 rowLocked —— 轨名那一格管整条轨，
           第 2 行往上的那一格只管自己那一行），显是真的把行高收掉（见 .tl-grid 的 hid-pic / hid-voice
           与每一行的 .hid）—— 两颗都不许只是换个颜色。
           ⚠ 这段注释在模板串里面，不许写反引号：那会把模板串提前关掉。 -->
      <div class="tl-grid${(laneHidden('pic') ? ' hid-pic' : '') + (laneHidden('voice') ? ' hid-voice' : '')}" id="tlGrid">
        <div class="tl-side">
          <div class="tl-hrow ruler"></div>
          <div class="tl-hrow pic">${laneRowBtnsHTML('pic')}${laneRowCtlHTML('pic', 0)}</div>
          <div class="tl-hrow voice">${laneRowBtnsHTML('voice')}${laneRowCtlHTML('voice', 0)}</div>
        </div>
        <div class="tl-bar" id="tlBar"></div>
      </div>
      <div class="tl-time"><span id="tlT0">0:00.0</span><span id="tlT1" title="${(projOf().tlTab || 'shot') === 'shot' ? '这一排按每段**进成片的那一截** ÷ 它自己的倍速摊开，右边就是它的总长（剪掉的头尾不占地方；整格黑场照样占）' : '全片轨按各段自己的长度排（黑场那一格不进画面、照样占时间），右边括号里才是成片真实时长'}">${(projOf().tlTab || 'shot') === 'shot' ? shotAxText(cur, sh) : (fmtDur(filmFrames(tlSyncFromShots()).total) + '（成片 ' + fmtDur(totalDur()) + '）')}</span></div>
      ${cur ? `
      <div class="trim-editor">
        <span id="trimSegLab"></span>
        从 <input type="number" id="trimS" step="0.1" min="0" max="${cur.duration || 15}">
        到 <input type="number" id="trimE" step="0.1" min="0" max="${cur.duration || 15}">
        秒 <button class="ghost" id="trimApply">应用</button>
        <span id="trimNote">这是源视频里的秒数；也可以直接拖动格子两端的把手</span>
      </div>` : ''}
    </div>` : ''}
    ${midOrderOf() ? '<div class="shot-strip" id="shotStrip"></div>' : ''}`;
  if (keepBox) {
    const nb = col.querySelector('.player-box');
    if (nb) nb.replaceWith(keepBox);
  }
  /* 还原纵向滚动位置 —— 与上面那两处（候选条 scrollLeft / 轨道 scrollLeft）同一族、同一立场：
     重建不许改「用户正看到哪儿」。这一栏在宽窗时自己是滚动容器（`.col{overflow-y:auto}`），
     窄窗（≤900px）时那一档被媒体查询放开成整页滚，所以两处都记、两处都还。
     少了这一句的表现就是「点一下切页签 / 一次后台轮询，画面弹回栏顶」。 */
  if (col.scrollTop !== keepY) col.scrollTop = keepY;
  if (Math.abs(window.scrollY - keepWinY) > 1) window.scrollTo(0, keepWinY);
  // 事件
  col.querySelector('.sname').oninput = e => { sh.name = e.target.value; renderScenesSoon(); scheduleSave(); };
  col.querySelector('#prevShot').onclick = () => stepShot(-1);
  col.querySelector('#nextShot').onclick = () => stepShot(1);
  /* 「导出成片 / 导出素材」两颗搬到页头，接线也跟着搬到那里一次绑好（2026-10）：
     这一排每 3 秒随整列重建，把出口绑在这里等于每次重建都要重绑，
     而导出中的按钮文案（「取消渲染 45%」）会被下一次重画冲掉。 */
  /* 撤销 / 重做两颗按钮：与 Ctrl+Z / Ctrl+Y 走**同一个函数**，
     所以两处的判据与上限永远一致（自己写一份接线就会出现「按钮能点但没反应」）。 */
  const bu = col.querySelector('#btnUndo'); if (bu) bu.onclick = undo;
  const br = col.querySelector('#btnRedo'); if (br) br.onclick = redo;
  bindCandidateStrip(col);       // 候选瓦片 / 占位卡 / 「加一条候选」都要绑上（没有候选时也要能点）
  if (cands.length) {
    col.querySelector('#cPrev').onclick = () => { selectCandidate(Math.max(0, projOf().curCand - 1)); scrollCurThumbIntoView(); };
    col.querySelector('#cNext').onclick = () => { selectCandidate(Math.min(cands.length - 1, projOf().curCand + 1)); scrollCurThumbIntoView(); };
    // 缩略图不再靠「换回旧节点」防闪：命中的首帧缓存由 Wb.thumbs.mediaHTML 直接出 <img>
    bindCandActs(col);
  }
  // 还原候选条滚动位置（新增候选 / 后台刷新重画后不再跳回第一条；只有 ‹ › 翻条才滚动到当前那条）
  {
    const box = col.querySelector('#candThumbs');
    if (box && keepThumbScroll) box.scrollLeft = keepThumbScroll;
  }
  // 顺序 / 剪辑：互斥——点开一个会自动关掉另一个，再点自己则关闭
  const ord = col.querySelector('#ordBtn');
  ord.onclick = () => {
    const on = !midOrderOf();
    setMidOrder(on);
    /* 打开顺序模式要顺带关掉剪辑（两排互斥）：还是走 setTrimMode 那一个出口，
       不在这里裸写 `midEditTrim = false; TlPlay.destroy();` —— 那是第二份「关剪辑」的账。 */
    if (on) setTrimMode(false);
    else { renderMid(); renderEditor(); }
    setStatus(on ? '拖动下面的镜头缩略图可调整顺序，点一下切到该镜头' : '已退出顺序模式');
  };
  col.querySelector('#trimBtn').onclick = () => {
    const on = !midEditTrimOf();
    setTrimMode(on);
    setStatus(on ? '剪辑模式：调本镜入出点，或切到「全片」合并整片' : '已退出剪辑模式');
  };
  const libMid = col.querySelector('#libImportMid');
  if (libMid) libMid.onclick = () => openLibDlg(sh);   // 中栏：只导入视频作为本镜候选
  /* 五把剪子 + 试听：这一排**只有一个目标**（画面段或配音句，见 syncTlTools），
     本镜与全片两个页签、两种目标都走 runCut 这一个入口 —— 「在一处剪了另一处跟着变」不是同步
     逻辑，是没有第二份数据；「切画面还是切配音」也不是两套按钮，是同一颗问一次目标。 */
  col.querySelectorAll('#tlTools [data-cut]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.cut === 'drop') {
        /* 删的是用户看得见的一段画面 / 一句配音：走就地二次确认（全站那一份 Confirm.arm）。
           两种落点要做的是两件不同的事，那句 note 就得说两句 —— 指着配音写「这一段画面会去掉」
           是一句页面上不会发生的话。 */
        if (Confirm.arm(b, '确认删掉？', {
          note: tlCutTarget() === 'voice' ? '只删这一句配音，画面不动'
            : '插针那一段原地变成黑场：格子还在原位、时长不变，后面的段一个都不前移（这一段上的配音照放）' })) return;
      }
      runCut(b.dataset.cut);
    };
  });
  syncTlTools();
  /* 轨名栏那几颗按钮：整条轨的显 / 锁走 laneToggle，**其中一行**的显 / 锁走 rowFlagToggle，
     加行走 addLaneRow（锚行那一颗挂在最下面，第 N 行那一颗插在第 N 行下面），删行走 dropLaneRow
     （四颗都只是出口，判据不在按钮上 —— 渲染与手势问的是同一份 laneState() / rowLocked() / laneMinRows()）。
     用**委托**绑在 #tlGrid 上而不是逐颗 forEach：第 2 行往上的标签行由 `syncLaneSide` 在轨道画完之后
     才插进 DOM，逐颗绑的那一刻它们还不存在，那颗「删掉这一行」就会是一颗点了没反应的按钮。 */
  const gridEl = col.querySelector('#tlGrid');
  if (gridEl) gridEl.addEventListener('click', e => {
    /* 音量图标那颗是**静音开关**（用户点名的第 ② 条）—— 它自己一节，不落进 data-lane-act 那几颗里：
       那几颗管的是行 / 轨的显隐锁定，静音是另一种状态（不改任何一级音量）。 */
    const mut = e.target.closest ? e.target.closest('[data-lane-mute]') : null;
    if (mut) { laneMuteToggle(mut.dataset.laneMute); return; }
    const b = e.target.closest('[data-lane-act]');
    if (!b) return;
    const act = b.dataset.laneAct;
    const k = b.dataset.lane, ln = laneClamp(b.dataset.ln);
    if (act === 'links') { openLinksDlg(); return; }
    if (act === 'row+') addLaneRow(k, col, ln > 0 ? ln : null);
    else if (act === 'row-') dropLaneRow(k, ln, col);
    else if (act === 'rhide') rowFlagToggle(k, ln, 'hides', col);
    else if (act === 'rlock') rowFlagToggle(k, ln, 'locks', col);
    else laneToggle(k, act);
  });
  /* 联动设置弹层（主轨 = 画面轨第 0 行）：勾上的类型在主轨段变黑场时挪到下一段还有画面的段。
     字幕不给 checkbox —— 派生字幕跟着配音走，manual/asr 只有 startMs/endMs、定位不到段，
     给一个点了没用的勾就是假承诺。改 links 不改成片内容 → 只 scheduleSave，不 filmEdited。 */
  function openLinksDlg() {
    const cur = linksOf(projOf());
    const OPTS = [['voice', '语音'], ['line', '台词'], ['pending', '待生成']];
    let bodyEl = null;
    UiDialog.open({
      title: '主轨联动',
      sub: '勾上的类型在主轨段变黑场时会挪到下一段还有画面的段；没勾的留在原地（成片里被跳过）。',
      body(el) {
        bodyEl = el;
        el.innerHTML = OPTS.map(([v, label]) =>
          '<label class="dlg-line"><input type="checkbox" data-link="' + v + '"' + (cur.indexOf(v) >= 0 ? ' checked' : '') + '> ' + label + '</label>').join('')
          + '<div class="dlg-hint">字幕不单独勾：派生字幕跟着配音走；手动 / ASR 字幕按源秒定位，不动。</div>';
      },
      actions: [
        { label: '取消', value: null },
        { label: '保存', value: 'go', primary: true },
      ],
    }).then(v => {
      if (v !== 'go' || !bodyEl) return;
      const picked = [];
      bodyEl.querySelectorAll('[data-link]').forEach(x => { if (x.checked) picked.push(x.dataset.link); });
      setLinks(projOf(), picked);
      scheduleSave();
      renderTimeline();
      setStatus('<span class="ok">✓ 联动已更新：' + (picked.length ? picked.map(p => ({ voice: '语音', line: '台词', pending: '待生成' }[p])).join('、') + ' 会在主轨段变黑场时挪走' : '全部关闭（变黑场时留在原地）') + '</span>');
    });
  }
  /* 每一行标签上那枚基数音量：与右栏那两枚同一套规矩 —— `input` 只改这一格上的百分数读数，
     `change`（松手）才写数据 + `filmEdited()`。中途整栏重画会把手指底下的滑块换掉，所以绝不在这一步动数据。
     锁着的那一行：`setLaneVol` 在函数入口硬拒并把原因写回读数旁边（滑块被压暗，这里只是把「为什么」说出口）。 */
  if (gridEl) {
    const rowSl = e => (e.target && e.target.closest ? e.target.closest('.tl-hvol-sl') : null);
    gridEl.addEventListener('input', e => {
      const s = rowSl(e);
      if (!s) return;
      const box = s.parentNode && s.parentNode.querySelector ? s.parentNode.querySelector('.tl-hvol') : null;
      const rd = box ? box.querySelector('.tl-hvol-n') : null;
      if (rd) rd.textContent = Math.round(Number(s.value) || 0) + '%';
      if (box) box.title = box.title.replace(/现在 [^）]*）/, '现在 ' + Math.round(Number(s.value) || 0) + '%）');
    });
    gridEl.addEventListener('change', e => {
      const s = rowSl(e);
      if (!s) return;
      /* 锚行那枚 = 整轨音量（setTrackVol 自己点名改哪一轨，不看此刻指着谁）；
         第 2 行往上仍是这一行的基数（setLaneVol）。 */
      if (laneClamp(s.dataset.ln) > 0) setLaneVol(s.dataset.lane, Number(s.value) / 100, laneClamp(s.dataset.ln));
      else setTrackVol(Number(s.value) / 100, s.dataset.lane);
    });
  }
  const ta = col.querySelector('#trimApply');
  /* 两个输入框调的是「剪辑界面指着的那一段」，不是整条候选的并集：
     切开之后一格就是一段，写并集等于界面画四格、数据改一整条。 */
  paintTrimRow(col);
  const applyTrimFromInputs = () => {
    /* 指着一句配音时，这两框调的是**它的**保留片段（画面的账一个字节不动）：
       `at` 在源秒上量（相对这一段选区起点），`dur`/`off` 在音频文件秒上量（÷ 自己那档倍速才是源长）。
       夹取与块上两根把手**同一套**（voice-lane.js 那一份）：左端退不出框左沿、退不到音频第 0 秒之前；
       右端上界取「框右沿」与「音频内容尽头」里更宽的那头，越过了就把框撑到那儿 ——
       少这一道，输入 0–999 会把 off 写成负、dur 写出文件尾，预览与合成各错各的。 */
    const v = tlVoiceHit();
    if (v) {
      const own = voiceRateOf(v);
      const at0 = Math.max(0, Number(v.at) || 0);
      const dur0 = Math.max(voiceMin(), Number(v.dur) || 0);
      const off0 = Math.max(0, Number(v.off) || 0);
      const fr = voiceFrameOf(v);
      const content = Number(v.srcDur) > 0 ? Math.max(voiceMin(), Number(v.srcDur) - off0) : dur0;
      const lim = Math.max(fr.fb, at0 + content / own);
      const minSpan = voiceMin() / own;          // 最短保留 = VOICE_MIN（音频文件秒）折回源秒
      let na = parseFloat(col.querySelector('#trimS').value);
      let ne = parseFloat(col.querySelector('#trimE').value);
      if (!isFinite(na)) na = at0;
      if (!isFinite(ne)) ne = at0 + dur0 / own;
      const lo = Math.max(fr.fa, at0 - off0 / own);
      na = Math.max(lo, Math.min(na, lim - minSpan));
      ne = Math.max(na + minSpan, Math.min(ne, lim));
      if (Math.abs(na - at0) < 0.05 && Math.abs(ne - (at0 + dur0 / own)) < 0.05) { paintTrimRow(col); return; }
      const grew = na < fr.fa - 0.05 || ne > fr.fb + 0.05;
      const d = na - at0;
      v.at = na; v.off = off0 + d * own; v.dur = (ne - na) * own;
      if (ne > fr.fb) v.fb = ne;
      roundVoice(v);
      setStatus('这一句配音改为 ' + round1(na) + '–' + round1(ne) + ' 秒' + (grew ? '（框跟着撑到新的保留范围）' : '')
        + '；音频从第 ' + round1(v.off) + ' 秒起、放 ' + round1(v.dur) + ' 秒' + (own !== 1 ? '（×' + own + ' 倍速）' : ''));
      filmEdited();
      return;
    }
    if (!cur) return;
    const total = candDur(cur, sh);
    const segs = segsOf(cur, total);
    if (!segs.length) { setStatus('<span class="err">这一段已经没有了：按 Ctrl+Z 退回剪切之前，再调入出点</span>'); return; }
    const i = Math.min(segs.length - 1, cutSegIdx());
    const s0 = segs[i];
    /* 能写的范围 = 这一格左右**没有邻居**的那一块（第一格到 0、最后一格到片尾）。
       不是「整条候选」：写超出就把隔壁那一格的画面抢过来了，两格会叠在一起。 */
    const lo = i > 0 ? segs[i - 1].b : 0;
    const hi = i < segs.length - 1 ? segs[i + 1].a : total;
    let s2 = parseFloat(col.querySelector('#trimS').value);
    let e2 = parseFloat(col.querySelector('#trimE').value);
    if (!isFinite(s2)) s2 = s0.in;
    if (!isFinite(e2)) e2 = s0.out;
    const clamped = !!(s2 > hi || e2 > hi || s2 < lo || e2 < lo);
    s2 = Math.max(lo, Math.min(s2, hi));
    e2 = Math.max(lo, Math.min(e2, hi));
    if (e2 - s2 < SEG_MIN) {
      e2 = Math.min(hi, s2 + SEG_MIN);
      if (e2 - s2 < SEG_MIN) s2 = Math.max(lo, e2 - SEG_MIN);
    }
    /* 整段替换而不是只写 in/out：框（a/b）与这一段**自己身上**的四件事都得跟着走。
       以前这里写的是 `{ in, out }` 两个字面字段 —— 一格调完入出点，框塌回收区（把手再也拖不回
       原来那一块）、音量被抹回 100%，正是「同一个东西两份账」里更坏的那种（改 A 悄悄清了 B）。
       框只向外扩（用户明确要的画面范围），永不越过邻居。 */
    segs[i] = segCarry(s0, { in: round1(s2), out: round1(e2),
      a: round1(Math.max(lo, Math.min(s0.a, s2))), b: round1(Math.min(hi, Math.max(s0.b, e2))) });
    const moved = reanchorVoices(sh, cur, segsOf(cur, total), segs);
    segsWrite(cur, total, segs);
    setStatus(trimStatus(sh, cur, (clamped ? `已按这一格能用的范围 ${fmtDur(lo)}–${fmtDur(hi)} 截断` : '')
      + (moved ? '；有 ' + moved + ' 句配音被切到段外，已挪到下一段开头' : '')));
    filmEdited();
  };
  if (ta) ta.onclick = applyTrimFromInputs;
  ['trimS', 'trimE'].forEach(id2 => {
    const el2 = col.querySelector('#' + id2);
    if (el2) el2.addEventListener('change', applyTrimFromInputs);
  });
  {
    /* 缩放：按钮一步约 1.15 倍，Ctrl/⌘ + 滚轮按 deltaY 连续折算（一次捏合几十条，一条只 1.5% 上下），
       滑块无极调（input 只改内存、松手 change 才落盘），普通滚轮交给浏览器做左右滚动 */
    const zin = col.querySelector('#tlZoomIn'), zout = col.querySelector('#tlZoomOut');
    if (zin) zin.onclick = e => { e.stopPropagation(); tlZoomBy(1); };
    if (zout) zout.onclick = e => { e.stopPropagation(); tlZoomBy(-1); };
    /* 滑块的绝对值入口。「自适应」是独立一颗按钮（读数只显示数字 —— 它不再兼任出口，
       已在自适应档时按钮 disabled，不是看着能点、点了不做事）。 */
    const zr = col.querySelector('#tlZoomRange');
    if (zr) {
      zr.oninput = e => { tlZoomSetPos(parseFloat(e.target.value), false); };
      zr.onchange = () => { tlZoomCommit(); };
    }
    const zauto = col.querySelector('#tlZoomAuto');
    if (zauto) zauto.onclick = e => { e.stopPropagation(); tlZoomAuto(); };
    const tbar = col.querySelector('#tlBar');
    if (tbar) tbar.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      /* 触摸板的捏合就是带 ctrlKey 的 wheel：不拦下浏览器会同时做整页缩放（画面跟着一起糊）。 */
      e.preventDefault();
      tlZoomWheel(e);
    }, { passive: false });
  }
  /* 只认带 data-tab 的那两颗（本镜 / 全片）：`.tl-tabs` 里还住着缩放那两颗，
     不筛就把它们的 onclick 整个换成切页签 —— 表现是点「＋」什么都没发生（缩放从此死掉）。 */
  col.querySelectorAll('.tl-tabs button[data-tab]').forEach(b => b.onclick = () => {
    const was = projOf().tlTab || 'shot';
    projOf().tlTab = b.dataset.tab;
    renderMid();
    /* 切到「全片」**不合成**（同上）：全片页签的预览现在由 `TlPlay` 按时间线直接播，
       不需要先有一份成片文件。合成只剩页头「导出成片」这一颗（「导出素材」走同一套页面内合成，
       但出的是零件不是一条整片）。 */
  });
  renderTimeline(col, sh, cur);
  if (midOrderOf()) renderShotStrip(col);
  // 自制播放控件：只有播放 / 暂停（原生控件已移除，时间跳转只在剪辑里插针）
  const pl = col.querySelector('#player'), pb = col.querySelector('#pbBtn');
  /* 自制控件与播放约束那两段都要挂监听，所以可摘接线只有这一份：`pl.__pbCtl` 是**现读**的，
     谁建了句柄就归谁摘（剪辑态由 `bindTlPlay` 接线，这里没有句柄就照旧直接挂）。
     mm:ss 读数只有 workbench.js 的 Wb.fmtClock 一份（这一处、候选播放器那一处、插针跳转那一处以前各写一份） */
  const onPl = (ev, fn, opt) => {
    const ctl = pl && pl.__pbCtl;
    const o = Object.assign({}, opt || {}, ctl ? { signal: ctl.signal } : {});
    if (pl) pl.addEventListener(ev, fn, o);
  };
  if (pl && pb && midEditTrimOf()) {
    bindTlPlay(col, keepPlay, Wb.fmtClock, keepBox);
  } else if (pl && pb) {
    bindPbFull(col.querySelector('.player-box'));
    if (pl.readyState >= 1) updateArBadge(pl);
    /* 整列重建保住旧节点之后，`addEventListener` 那一族不能每 3 秒再叠一层：
       同一只 `<video>` 上会挂几十个 `syncTime`，每个闭包抓着**它那一轮**的那一条候选 ——
       越滚越慢，而那行读数写的可能是旧一条的时长。
       所以每次接线前先把上一份摘掉（`AbortController` 的 signal 传给 addEventListener）。
       这也顺带修了「切换候选时节点不换、只换 src」那一路：`selectCandidate` 就地改地址之后，
       旧的 `loadedmetadata` 监听还指着上一条候选，尺寸那一格会一直空着。
       属性类接线（`onclick` / `onplay` / `onloadedmetadata`）本来就是「后者覆盖前者」，不用摘。 */
    if (pl.__pbCtl) { try { pl.__pbCtl.abort(); } catch (e) { /* 播控句柄已经结束了就没有可中止的 */ } }
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    pl.__pbCtl = ctl;
    onPl('loadedmetadata', () => updateArBadge(pl), { once: true });
    const sync = () => { pb.innerHTML = icon(pl.paused ? 'play' : 'pause', 15); };
    // 声音开关（与播放/暂停同一类按钮），偏好记在本地
    const mb = col.querySelector('#pbMute');
    pl.muted = window.LS.get('dir_muted') === '1';
    if (mb) {
      mb.innerHTML = icon(pl.muted ? 'speakerOff' : 'speaker', 14);
      mb.onclick = e => {
        e.stopPropagation();
        pl.muted = !pl.muted;
        mb.innerHTML = icon(pl.muted ? 'speakerOff' : 'speaker', 14);
        mb.title = pl.muted ? '已静音（点击开启声音）' : '声音已开启（点击静音）';
        window.LS.set('dir_muted', pl.muted ? '1' : '0');
      };
    }
    // 时长信息：当前时间 / 总时长（总时长优先用视频真实时长）
    const tb = col.querySelector('#pbTime');
    const syncTime = () => {
      if (!tb) return;
      const total = (isFinite(pl.duration) && pl.duration > 0) ? pl.duration : ((cur && cur.duration) || 0);
      tb.textContent = Wb.fmtClock(pl.currentTime) + ' / ' + Wb.fmtClock(total);
      tb.title = '视频时长 ' + Wb.fmtClock(total) + (pl.muted ? '（已静音）' : '');
    };
    syncTime();
    onPl('timeupdate', syncTime);
    onPl('loadedmetadata', syncTime);
    onPl('durationchange', syncTime);
    pb.onclick = e => { e.stopPropagation(); if (pl.paused) playSafe(pl); else pl.pause(); sync(); };
    pl.onclick = () => { if (pl.paused) playSafe(pl); else pl.pause(); sync(); };
    pl.onplay = sync; pl.onpause = sync; pl.onended = sync;
    // 视频元数据到手后回填真实时长（有些数据源不带 duration 字段）——全片模式不适用
    pl.onloadedmetadata = () => {
      if (filmMode) return;
      const d = pl.duration;
      if (isFinite(d) && d > 0 && cur && (!cur.duration || Math.abs(cur.duration - d) > 0.3)) {
        cur.duration = Math.round(d * 10) / 10;
        if (cur.trimE == null) cur.trimE = cur.duration;
        scheduleSave();
        renderMid();
      }
    };
    sync();
    /* 整列重建后接回原来的播放进度（src 未变时）。
       ⚠ 上面把节点整块保住时**这一支整个跳过**：节点没换，进度与播放态本来就还在原地，
       再 `currentTime =` 一次等于自己造一次 seek —— 画面黑一下，正是这一次要修的那件事。 */
    if (!keepBox && keepPlay && keepPlay.src && pl.getAttribute('src') === keepPlay.src) {
      const resume = () => {
        if (keepPlay.t > 0.2) { try { pl.currentTime = keepPlay.t; } catch { /* seek 被拒（元数据还没到）就保持当前位置 */ } }
        if (!keepPlay.paused) playSafe(pl);
      };
      if (pl.readyState >= 1) resume();
      else onPl('loadedmetadata', resume, { once: true });
    }
  }
  // 播放裁剪约束 + 插针跟随播放进度
  if (pl && cur) {
    const lo = cur.trimS || 0, hi = cur.trimE;
    const isFilm = (projOf().tlTab || 'shot') === 'film';
    /* 播放进度就是插针位置：所以「剪哪一段」= 「正在放哪一段」，
       跟着播放自动挪 proj.cutSeg，四把剪子与入出点那一行、工具条那行小字一起跟上（都走 setPin）。
       正在输入框里打秒数时只挪针、不改写那两个框，否则打着字数字就跳。
       全片页签走另一条：播放器放的是**合成后的整片**，currentTime 就是成片秒 ——
       针按成片秒挪，同时把焦点与剪刀带到那一格（filmApplyAt 的 quiet 分支，不重画整栏）。
       入出点的钳制**只在本镜档**做：全片档放的是已经剪好的成片，拿焦点候选的 trimE
       去夹它会把整片拦腰截断（那一档以前就是这样跳的，本轮一并收掉）。 */
    /* 「现在播到哪」：剪辑态由 TlPlay 给（它按剪完的时间轴走，甲板的 currentTime 是段内秒，
       不是成片秒；本镜档再折算回**源秒**（TlPlay.srcT），全片档折算回**框基秒**（TlPlay.frameT）
       —— 后者正是全片那一排插针所在的轴，播放头因此只走真正进成片的画面，灰块会被跳过）。 */
    const nowT = () => (!midEditTrimOf() ? pl.currentTime : isFilm ? TlPlay.frameT() : TlPlay.srcT());
    const syncPlayhead = () => {
      if (!midEditTrimOf()) return;
      if (isFilm) {
        const tl = tlSyncFromShots();
        if (!tl.clips.length) return;
        /* 不再自己算 total：`filmApplyAt` 内部按**框基**现算（两条轨的时间基只有一处口径） */
        filmApplyAt(col, tl, nowT(), { quiet: true });
        return;
      }
      const total = candDur(cur, sh);
      /* 针与尺子读的是**轴秒**，而 `nowT()` / `proj.cutAt` 是数据层的**源秒** —— 画之前折一次，
         只走 `shotPinT` 这一处口径（漏折就是「倍速一上，针比格子偏左一截」）。
         `setPin` 那一路自己也会折（它收的还是源秒），所以焦点、入出点那两框一个字节不改。 */
      const sg = shotFrames(segsOf(cur, total));
      const ax = shotAxTotal(sg, total);
      const ae = document.activeElement;
      if (ae && (ae.id === 'trimS' || ae.id === 'trimE')) paintPin(col, shotPinT(sg, nowT()), ax);
      /* **没在播就不重算焦点**：整栏重画会重建播放器，而 `TlPlay.seek()` 开头无条件 emit 一次
         （新建那一只时递来的是 0 秒），于是「我刚切一刀，剪刀又指回第一段」——
         焦点只该跟着用户的手与播放头走。与全片档 `filmApplyAt` 的 quiet 分支同一立场，
         针仍画回数据里那一秒（`proj.cutAt`），只是不拿它去改写 `cutSeg`。 */
      else if (!TlPlay.playing) paintPin(col, shotPinT(sg, round1(Math.max(0, Math.min(total, Number(projOf().cutAt) || 0)))), ax);
      else setPin(col, sh, cur, total, nowT());
    };
    /* 剪辑态的进度不再挂在甲板的 timeupdate 上（那段会被换掉、也会重复触发），
       由 TlPlay 的 onTime 一处回调 —— 与「插针跟着播放走」是同一件事的两条路，别各走一条。 */
    setTlPlayhead(syncPlayhead);
    if (!midEditTrimOf()) {
      onPl('timeupdate', () => {
        if (!isFilm) {
          /* 按**段**播，不是按「[第一段的头, 最后一段的尾]」播：
             把一条剪成三段、中间那段删掉时，[lo,hi] 这个区间会把被删掉的那一段**照样放过去**
             —— 用户报的「被剪掉的还是会播放」就是它（进剪辑模式走的是另一条播放器，
             那里按时间线调度，不受影响）。落在任何一段之外就跳到紧随其后的那一段开头；
             后面没有段了就停在最后一段末尾、暂停。 */
          const segs = segsOf(cur, candDur(cur, sh));
          if (segs.length) {
            const t = pl.currentTime;
            const inside = segs.some(s => t >= s.in - 0.05 && t <= s.out + 0.02);
            if (!inside) {
              const next = segs.find(s => s.in > t);
              const last = segs[segs.length - 1];
              if (next) { try { pl.currentTime = next.in + 0.01; } catch (e) { /* seek 被拒（元数据还没到）就保持当前位置 */ } }
              else if (t > last.out) {
                try { pl.currentTime = last.out; } catch (e) { /* seek 被拒（元数据还没到）就保持当前位置 */ }
                pl.pause(); if (pb) pb.innerHTML = icon('play', 15);
              } else { try { pl.currentTime = segs[0].in; } catch (e) { /* seek 被拒（元数据还没到）就保持当前位置 */ } }
            }
          } else if (hi != null && pl.currentTime > hi) { pl.pause(); if (pb) pb.innerHTML = icon('play', 15); }
        }
        syncPlayhead();
      });
      ['seeking', 'seeked', 'play', 'pause', 'loadedmetadata'].forEach(ev => onPl(ev, syncPlayhead));
    }
  }
  if (window.Dropdowns) Dropdowns.build(col);   // 中栏参数条重建后重新包装下拉
}
/* 顺序模式：一行镜头缩略图（每个镜头一张），可点击切换、可拖动排序 */
function renderShotStrip(col) {
  const wrap = col.querySelector('#shotStrip');
  if (!wrap) return;
  /* 重画之前先把「此刻已经出画的那一枚媒体」按镜头收起来，建完再照身份收养（与 renderScenes 那一族同一条路）。
     顺序模式那一排跟着中间栏每 3 秒重建一次，而 `<video>` 一销毁就得重新抽帧、缓存没命中时整排退回占位 ——
     用户报的「各个地方的视频预览都在闪」，这一排就是第三份（左栏在 renderScenes、中间栏在 renderMid）。
     只收「已经画上且带得上缩略键」的那些：`data-thumb-key` 在键过长（dataURL）时公共层故意不落到属性上，
     读不到就照旧重画，不拿「大概是同一份」当判据。 */
  const keepThumb = new Map();
  wrap.querySelectorAll('.strip-item').forEach(x => {
    const m = x.querySelector('video, img');
    if (x.dataset.sid && m && m.getAttribute('data-thumb-key')) keepThumb.set(x.dataset.sid, { m, ready: x.classList.contains('mready') });
  });
  wrap.innerHTML = '';
  const all = allShots();
  all.forEach((sh, k) => {
    const c = sh.candidates.find(x => x.vid === sh.selId);
    const it = document.createElement('div');
    it.className = 'strip-item' + (sh === curShot() ? ' sel' : '') + (shotReady(sh) ? ' ready' : '');
    it.dataset.sid = sh.id;
    it.draggable = true;
    const stripRaw = c?.url || sh.firstFrame || '';
    const stripKey = c?.url ? thumbKey(c) : Wb.thumbs.keyOf(stripRaw);
    const thumb = c?.url ? Wb.thumbs.mediaHTML(c.url, { key: stripKey })
      : sh.firstFrame ? Wb.thumbs.mediaHTML(sh.firstFrame, { type: 'image', key: stripKey, mediaAttrs: 'loading="lazy"' })
      : `<div class="ph"></div>`;
    it.innerHTML = `${thumb}<span class="sn">${String(k + 1).padStart(2, '0')}</span>
      <span class="st">${shotReady(sh) ? shotDurText(sh) : shotStatusOf(sh).text}</span>`;
    it.title = sh.name + '（点击切换，拖动排序）';
    /* 收养的条件只有一个：这一格此刻显示的还是**同一份素材**的首帧（键对得上）。
       换了选用的候选就不收 —— 留着旧节点等于界面在替用户说假话（卡片上播的是另一条视频的封面），
       而序号与状态那两行是重建的，收养动不到它们。 */
    const media = it.querySelector('video, img');
    const kept = keepThumb.get(String(sh.id));
    if (kept && media && kept.m.getAttribute('data-thumb-key') === media.getAttribute('data-thumb-key')) {
      media.replaceWith(kept.m);
      /* 占位层那一片只在「旧的那一枚真的已经画上」时撤：`.mready` 是公共层出画之后加在 wrap 上的，
         搬进新 wrap 时它不会自己跟过来，所以要照旧那一格的账补上，否则收养来的画面被 .tph 盖住 = 白闪一次。 */
      if (kept.ready) {
        it.classList.add('mready');
        const tph = it.querySelector('.tph');
        if (tph) tph.remove();
      }
      Wb.thumbs.bind(it, kept.m, stripRaw, 'mready');
    } else Wb.thumbs.bind(it, media, stripRaw, 'mready');
    it.onclick = () => {
      const sc = projOf().scenes.find(s2 => s2.shots.includes(sh));
      projOf().curScene = projOf().scenes.indexOf(sc); projOf().curShot = sc.shots.indexOf(sh);
      renderAll();
    };
    const idxOf = s => { const sc = projOf().scenes.find(x => x.shots.includes(s)); return { si: projOf().scenes.indexOf(sc), xi: sc.shots.indexOf(s) }; };
    it.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'shotstrip:' + k); e.dataTransfer.effectAllowed = 'move'; });
    it.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    it.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      const d2 = e.dataTransfer.getData('text/plain');
      if (!d2.startsWith('shotstrip:')) return;
      const from = +d2.split(':')[1];
      if (from === k) return;
      const f = idxOf(all[from]), t2 = idxOf(all[k]);
      const moved = projOf().scenes[f.si].shots.splice(f.xi, 1)[0];
      /* 同上：同一场景里往后拖，插入下标要减一格，否则落点比手指位置远一个 */
      const at = (f.si === t2.si && f.xi < t2.xi) ? t2.xi - 1 : t2.xi;
      projOf().scenes[t2.si].shots.splice(at, 0, moved);
      const sc = projOf().scenes.find(x => x.shots.includes(moved));
      projOf().curScene = projOf().scenes.indexOf(sc); projOf().curShot = sc.shots.indexOf(moved);
      filmEdited();                      // 顺序也是成片内容：改完按需自动重合并
    });
    wrap.appendChild(it);
  });
}

  return {
    promptTextOf,
    paintPromptBox,
    playerEmptyText,
    updateArBadge,
    renderMid,
  };
}
