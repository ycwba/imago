/* 导演台Mid域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createMid(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { filmOf, filmTotal, candidateWindow, srcHeadOf, srcUsedOf } from '../film.js';

export function createMid(E, document, window) {
  const {
    $,
    playSafe,
    Play,
    projOf,
    allShots,
    curScene,
    curShot,
    fmtDur,
    shotDurText,
    shotReady,
    dragBusy,
    filmEdited,
    scheduleSave,
    scheduleSaveQuiet,
    thumbKey,
    shotStatusOf,
    candThumbInner,
    candPlaceholder,
    candAddTile,
    midCandExpandOf,
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
    setTrimMode,
    importMedia,
    curDraftCand,
    Timeline,
    Edit,
    syncGenGate,
    syncAtBack,
    renderEditor,
    renderAll,
    setStatus,
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
/* 撤销 / 重做那两颗按钮已删（2026-10 用户点名）：它们埋在候选条下面那一排里，
   笔记本 / 外接键盘没有 Ctrl 的场景用不上，而剪辑态左栏的「历史编辑记录」本来就能点着退回去。
   快捷键（Ctrl+Z / Ctrl+Y）与那一处历史都还在。 */
/* 顺序条的高度可拖（与左右栏、轨道坞同一套 Wb.split，键 dir_strip）：
   host 是静态壳里那一块，整片重画只换 `.mid-body`，所以这一套只接一次。 */
function ensureStripSplit(col) {
  const host = col.querySelector('#shotStripHost');
  if (!host || col.__stripSplit || !(window.Wb && window.Wb.split)) return;
  col.__stripSplit = true;
  window.Wb.split.enable({
    box: col, axis: 'y', key: 'dir_strip',
    cols: [{ el: '#shotStripHost' }],
    handles: [{ left: 0, right: 0, resize: 0, varName: 'strip-h', min: 96, max: 360 }],
    handleHost: '#shotStripHost',
  });
}
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
  const body = col ? col.querySelector('#midBody') : null;
  if (!col || !body) return;
  col.classList.toggle('is-trim', midEditTrimOf());
  /* 全屏正开着 → 这一轮欠着，退出那一刻补画（判据与理由在 `fullscreenHold`）。
     必须排在 `dragBusy()` 后面、`col.innerHTML =` 那一族任何写操作之前 —— 早退得越靠前，
     少做的副作用越多（下面那几行会改 `proj.curCand`、`tlScrollWant`、`keepBox` 的记账）。 */
  if (fullscreenHold(col)) return;
  const sc = curScene(), sh = curShot();
  if (!sh) {
    body.innerHTML = window.Wb.emptyHTML('左侧添加场景和镜头开始创作');
    const hs = col.querySelector('#shotStripHost');
    if (hs) hs.hidden = true;
    return;
  }
  /* 记住播放器状态：整列会被重建（轮询每 3 秒一次），同一 src 时接着播，不再打断预览。
     剪辑态记的是「成片第几秒」而不是甲板的 currentTime —— 后者是**段内**秒，
     剪成几段之后拿它当进度接回去，会跳到另一段上去。 */
  const oldPl = col.querySelector('#player');
  const keepPlay = midEditTrimOf()
    ? (Play.plan.length ? { t: Play.t, paused: !Play.playing } : null)
    : (oldPl ? { src: oldPl.getAttribute('src'), t: oldPl.currentTime, paused: oldPl.paused } : null);
  const idx = allShots().indexOf(sh) + 1;
  sortCandidates(sh);                              // 有片的排前面、排队/生成中的排后面（顺序变了当前条会跟着走）
  const cands = sh.candidates;
  if (cands.length) projOf().curCand = Math.max(0, Math.min(Number(projOf().curCand) || 0, cands.length - 1));
  const cur = cands[projOf().curCand] || cands[0];
  const sel = sh.candidates.find(c => c.vid === sh.selId);
  // 候选条的横向滚动位置也要保留：新增候选 / 轮询刷新后不再自动跳回第一条
  const oldThumbBox = col.querySelector('#candThumbs');
  const keepThumbScroll = oldThumbBox ? oldThumbBox.scrollLeft : 0;
  /* 纵向也要记：`col.innerHTML =` 是「先把子节点清空、再插新的」，那一栏的滚动位置在清空
     那一刻被夹回 0 —— 与候选条 scrollLeft 同一族，只是从前只补了横的。
     表现是「正看着中栏那一排调剪辑，一次重建就弹回栏顶」。窄窗（≤900px）时滚动的是整页而不是
     这一栏（`body{overflow:auto}` 那一条媒体查询），所以两处都记、两处都还。 */
  const keepY = body.scrollTop, keepWinY = window.scrollY || 0;
  /* 整列重建会把播放区那一只 `.player-box` 一起换掉（新节点要重新加载素材、重新 seek，
     画面黑一下 —— 每 3 秒一次）。能保住就摘下来、画完塞回原处：节点不动就没有「闪」。
     什么时候保（两种「不保」都比闪更糟）：
     · **剪辑态**：这一轮画的还是一只播放器、旧的那只**确实是剪辑态的预览面**（有静止层），
       且 `Play` 手里有成片可播。以前只在「正在播」时保 —— 暂停状态照样每 3 秒销毁重建，
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
    else if (midEditTrimOf() && old2.querySelector('#playerStill') && Play.plan.length) { keepBox = old2; old2.remove(); }
  }
  body.innerHTML = `
    <div class="mid-head">
      <span class="no">${String(idx).padStart(2, '0')}</span>
      <input class="sname" value="${esc(sh.name)}">
      <span class="meta">${esc(sc.name)} · ${shotDurText(sh)} · ${sel ? '已选用' : '未选用'}</span>
      <span class="sp"></span>
      <!-- 工作模式只剩「剪辑」一枚开关（用户点名去掉「顺序」）：镜头顺序条已经常驻在栏底，
           不再需要先点开才看得到。撤销 / 重做走 Ctrl+Z / Ctrl+Y 与剪辑态左栏的历史记录。 -->
      <span class="ui-seg mid-mode" id="midMode" role="tablist" aria-label="工作模式">
        <button type="button" class="${midEditTrimOf() ? 'on' : ''}" id="trimBtn" role="tab" aria-selected="${midEditTrimOf() ? 'true' : 'false'}">${icon('scissors', 13)} 剪辑</button>
      </span>
    </div>
    <div class="player-wrap" id="playerWrap">${playerAreaHTML(sh)}</div>
    ${/* 剪辑态不画候选条与「用这条 / 锁定 / 删除」那排（用户点名）：轨道坞 + 播放器就是剪辑的全部，
         换候选回生成态点候选条。 */ ''}
    ${midEditTrimOf() ? '' : `
    <div class="cand-strip${midCandExpandOf() ? ' expanded' : ''}">
      <div class="thumbs" id="candThumbs">${cands.length ? cands.map((c, i) => candThumbInner(c, i === projOf().curCand)).join('') + candAddTile() : candPlaceholder()}</div>
      ${cands.length ? `<span class="cand-pager">
        <button class="ghost" id="candExpand" title="${midCandExpandOf() ? '收成一排左右滚动' : '展开成多行，一屏看完所有候选'}">${window.icon(midCandExpandOf() ? 'chevronUp' : 'chevronDown', 13)}</button>
        <button class="ghost" id="cPrev" title="上一条候选">${window.icon('stepBack', 14)}</button>
        <span class="cand-count" title="第 ${projOf().curCand + 1} 条候选，共 ${cands.length} 条（左右两颗切换）">${projOf().curCand + 1} / ${cands.length}</span>
        <button class="ghost" id="cNext" title="下一条候选">${window.icon('stepNext', 14)}</button>
      </span>` : ''}
    </div>
    <div class="cand-acts" id="candActs">
      <!-- 导入是项目级动作，但这一屏最常用 —— 跟「用这条 / 锁定 / 删除」同一排（用户点名搬到这儿）。 -->
      <button class="ghost" id="importMid" title="导入视频 / 素材：视频成为这一镜的新候选，图片成为静态段">${icon('box', 13)} 导入</button>
      <span class="sp"></span>
      ${candActsHTML(sh)}
    </div>`}
    <div class="mid-tools">
      <span class="total">${fmtDur(filmTotal(filmOf(projOf()).clips))}</span>
    </div>`;
  if (keepBox) {
    const nb = col.querySelector('.player-box');
    if (nb) nb.replaceWith(keepBox);
  }
  /* 还原纵向滚动位置 —— 与上面那两处（候选条 scrollLeft / 轨道 scrollLeft）同一族、同一立场：
     重建不许改「用户正看到哪儿」。这一栏在宽窗时自己是滚动容器（`.col{overflow-y:auto}`），
     窄窗（≤900px）时那一档被媒体查询放开成整页滚，所以两处都记、两处都还。
     少了这一句的表现就是「点一下切档 / 一次后台轮询，画面弹回栏顶」。 */
  if (body.scrollTop !== keepY) body.scrollTop = keepY;
  if (Math.abs(window.scrollY - keepWinY) > 1) window.scrollTo(0, keepWinY);
  // 事件
  col.querySelector('.sname').oninput = e => { sh.name = e.target.value; renderScenesSoon(); scheduleSave('改镜头名'); };
  /* 「‹ › 切上一镜 / 下一镜」与「撤销 / 重做」那一簇已删（2026-10 用户点名）：
     切镜走左栏的分镜列表，撤销 / 重做走 Ctrl+Z / Ctrl+Y 与剪辑态左栏的「历史编辑记录」。 */
  /* 「导出成片 / 导出素材」两颗搬到页头，接线也跟着搬到那里一次绑好（2026-10）：
     这一排每 3 秒随整列重建，把出口绑在这里等于每次重建都要重绑，
     而导出中的按钮文案（「取消渲染 45%」）会被下一次重画冲掉。 */
  bindCandidateStrip(col);       // 候选瓦片 / 占位卡 / 「加一条候选」都要绑上（没有候选时也要能点）
  const cPrevEl = col.querySelector('#cPrev'), cNextEl = col.querySelector('#cNext');
  if (cands.length && cPrevEl && cNextEl) {
    cPrevEl.onclick = () => { selectCandidate(Math.max(0, projOf().curCand - 1)); scrollCurThumbIntoView(); };
    cNextEl.onclick = () => { selectCandidate(Math.min(cands.length - 1, projOf().curCand + 1)); scrollCurThumbIntoView(); };
    // 缩略图不再靠「换回旧节点」防闪：命中的首帧缓存由 Wb.thumbs.mediaHTML 直接出 <img>
    bindCandActs(col);
  }
  // 还原候选条滚动位置（新增候选 / 后台刷新重画后不再跳回第一条；只有 ‹ › 翻条才滚动到当前那条）
  {
    const box = col.querySelector('#candThumbs');
    if (box && keepThumbScroll) box.scrollLeft = keepThumbScroll;
  }
  // 导入入口跟着这一排走（每一轮重建都要重绑）
  const impBtn = col.querySelector('#importMid');
  if (impBtn) impBtn.onclick = () => importMedia();
  col.querySelector('#trimBtn').onclick = () => {
    const on = !midEditTrimOf();
    setTrimMode(on);
    setStatus(on ? '剪辑模式：调这一段的入出点、拖轨道上的块' : '已退出剪辑模式');
  };
  /* 剪辑态时间线板（`.tl-board`，铺满页宽）与三栏平级：生成态整块 hidden，剪辑态画出来。
     播放器仍在中栏 —— 两种模式切换时中栏那几块一个像素不动。
     板的接线只做一次（`Timeline.bind` 把处理器委托在板上），之后每次重建只重画内容；
     滚动位置由 `Timeline.render()` 自己收着，不靠这边记账。 */
  const board = document.getElementById('tlBoard');
  const boardBody = board ? board.querySelector('#tlBoardBody') : null;
  if (midEditTrimOf() && boardBody) {
    board.hidden = false;
    if (!boardBody.__bound) { Timeline.bind(boardBody); boardBody.__bound = true; }
    else Timeline.render();
    if (!boardBody.__boundEdit) { Edit.bind(boardBody); boardBody.__boundEdit = true; }
  } else if (board) {
    board.hidden = true;
    /* 生成态里那块板看不见，板上没有手势可言，Edit 那一份**文档级**键盘监听更要摘掉 ——
       否则 Delete / M / 空格 会在「正在写提示词」的那一栏后面剪到一条看不见的轨道。
       摘掉之后 `__bound` 仍然留着（Timeline 那一份不挂文档级监听，重画时接着用）。 */
    if (boardBody && boardBody.__boundEdit) { Edit.unbind(); boardBody.__boundEdit = false; }
  }
  /* 镜头顺序条是**生成态**那一侧的东西（与候选条同族）：剪辑态里它让位给轨道板 ——
     和左右两栏一样，两种模式各有自己的栏，不把生成态那一套留在剪辑屏上（用户点名）。
     生成态里它常显（不再由「顺序」开关决定），可点可拖排序。 */
  {
    const hs = col.querySelector('#shotStripHost');
    if (hs) hs.hidden = !!midEditTrimOf();
    if (!midEditTrimOf()) { ensureStripSplit(col); renderShotStrip(col); }
  }
  // 自制播放控件：只有播放 / 暂停（原生控件已移除，时间跳转只在剪辑里插针）
  const pl = col.querySelector('#player'), pb = col.querySelector('#pbBtn');
  /* 自制控件与播放约束那两段都要挂监听，所以可摘接线只有这一份：`pl.__pbCtl` 是**现读**的，
     谁建了句柄就归谁摘（剪辑态由播放核接线，这里没有句柄就照旧直接挂）。
     mm:ss 读数只有 workbench.js 的 Wb.fmtClock 一份（这一处、候选播放器那一处、插针跳转那一处以前各写一份） */
  const onPl = (ev, fn, opt) => {
    const ctl = pl && pl.__pbCtl;
    const o = Object.assign({}, opt || {}, ctl ? { signal: ctl.signal } : {});
    if (pl) pl.addEventListener(ev, fn, o);
  };
  if (pl && pb && midEditTrimOf()) {
    /* 剪辑态：主时钟、媒体对齐、配音与转场全在播放核里；这一句只是把新的预览面接上去。 */
    Play.bind(col, keepPlay, keepBox);
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
    // 视频元数据到手后回填真实时长（有些数据源不带 duration 字段）
    pl.onloadedmetadata = () => {
      const d = pl.duration;
      if (isFinite(d) && d > 0 && cur && (!cur.duration || Math.abs(cur.duration - d) > 0.3)) {
        const had = Number(cur.duration) > 0;
        cur.duration = Math.round(d * 10) / 10;
        if (cur.trimE == null) cur.trimE = cur.duration;
        /* 这一格时长是从视频元数据学来的，不是用户写的，所以按「原来有没有值」分开结算
           （与右栏参数回写同一把尺子）：原来是空 = 程序第一次填 → 静默落盘，
           不占撤销步数、不推进助手的修订号（开机只是打开一页就多一枚「编辑」是假账）；
           原来存过值且差过 0.3 秒 = 动的确实是工程里那份数 → 进撤销栈并写明是谁改的。 */
        if (had) scheduleSave('时长按视频元数据收正');
        else scheduleSaveQuiet();
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
  // 生成态：播放裁剪约束（剪掉的那一截不放）
  if (pl && cur && !midEditTrimOf()) {
    /* 保留窗按**成片那一份**算：这一镜已提升的片段在素材里各占一段源窗口（剪辑态改过刀
       这里就跟着改）；还没提升时退候选自己的裁剪窗（`candidateWindow` 与 promoteCandidate
       同一份）。按**窗**播，不是按「[第一段的头, 最后一段的尾]」播：中间剪掉的那一截
       不会照样放过去。落在任何一窗之外就跳到紧随其后的那窗开头；
       后面没有窗了就停在最后一窗末尾、暂停。 */
    const kept = (filmOf(projOf()).clips || [])
      .filter(c => c && c.shotId === sh.id && c.candId === cur.vid && c.kind !== 'image')
      .map(c => [srcHeadOf(c), srcHeadOf(c) + srcUsedOf(c)])
      .sort((a, b) => a[0] - b[0]);
    if (!kept.length) { const w = candidateWindow(cur); kept.push([w.sourceStart, w.sourceStart + w.sourceDuration]); }
    onPl('timeupdate', () => {
      const t = pl.currentTime;
      const inside = kept.some(([a, b]) => t >= a - 0.05 && t <= b + 0.02);
      if (inside) return;
      const next = kept.find(([a]) => a > t);
      const last = kept[kept.length - 1];
      if (next) { try { pl.currentTime = next[0] + 0.01; } catch (e) { /* seek 被拒（元数据还没到）就保持当前位置 */ } }
      else if (t > last[1]) {
        try { pl.currentTime = last[1]; } catch (e) { /* seek 被拒（元数据还没到）就保持当前位置 */ }
        pl.pause(); if (pb) pb.innerHTML = icon('play', 15);
      } else { try { pl.currentTime = kept[0][0]; } catch (e) { /* seek 被拒（元数据还没到）就保持当前位置 */ } }
    });
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
