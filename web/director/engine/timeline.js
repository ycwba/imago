/* 导演台Timeline域（engine/timeline.js）：时间线面板本身 —— 工具栏、刻度尺、标记条、
   轨道与块、连接点 ◇ 与转场浮层、播放头与吸附线、缩放与滚动。
   这一份只管「画」与「视口操作」（缩放 / 滚动 / 放针）；块上的手势（拖 / 切 / 调边）
   在 engine/edit.js，播放推进在 engine/play.js，帧与波形在 engine/strip.js。

   与参考项目同一条路子（components/Timeline.jsx 的骨架）：
     · 一条横滚容器 = 内容层，刻度尺、标记条、轨道、播放头**共用同一次 scrollLeft**；
     · 缩放只有一个标量（tl-scale.js），往外给的像素换算只有 timeAtClientX 一处；
     · 轨道左列（眼睛 / 锁 / 名字）与右列逐行对齐 —— 两边由同一张 rows 表画出来。 */
import {
  deriveTimeline, packVoiceLanes, packCaptionLanes, rowVisible, rowSet,
  itemVisible, itemLocked, transitionOf, transitionNameOf, TRANSITIONS,
  DEFAULT_TRANSITION_SECONDS, transitionMax, LANE_MAX,
} from '../film.js';
import {
  TL_ZOOM_MIN, TL_ZOOM_MAX, tlClampZoom, tlNavTotal, tlTicks, tlZoomLabel,
  tlPxPerSec, tlTimelineWidth, tlTimeAtX, tlXOfTime, tlAnchoredScroll,
  tlZoomByWheel, tlFitZoom, tlZoomFloor, tlInitialZoom,
} from '../tl-scale.js';
import { markerRangeOf, markerTimeText, MARKER_TYPE_ICON, MARKER_TYPE_ZH } from '../tl-markers.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/* 时间读数的唯一一份（工具栏 / 播放头 / 块角标共用；带零点一秒）。 */
export function clockText(sec) {
  const s = Math.max(0, num(sec));
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m ? `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}` : rest.toFixed(1) + 's';
}

export function createTimeline(E, document, window) {
  const {
    filmOf,
    icon,
    esc,
    fmtClock,
    getZoom,
    setZoom,
    setStatus,
    scheduleSaveQuiet,
    transitionSet,
    toolAction,
    toolState,
    strip,
    beforeRender,
    onBoardRender,
    dblClickEmpty,
    seekRequest,
    sliceForgetFail,
  } = E;

  let host = null;
  let scrollEl = null;
  let labelsInner = null;
  let rulerInner = null;
  let contentEl = null;
  let popEl = null;
  let menuEl = null;
  let zoom = tlClampZoom(num(getZoom && getZoom(), 0) || tlInitialZoom(0));
  let playhead = 0;
  let snapOn = true;
  let rippleOn = false;
  let mode = 'select';
  let markersOpen = true;
  let commitTimer = 0;
  let resizing = null;
  let popIndex = -1;
  let selMenuOpen = false;
  let snapTime = null;
  let lastTicksLeft = 0;
  /* 播放中的播放头走 WAAPI 线性滑行（transform 由合成器推进），不靠每帧改样式；
     暂停 / seek / 缩放时先落精确位、再撤动画 —— 否则会先露出上一轮的原点。 */
  let gliding = false;
  let glideLine = null;
  let glideHead = null;

  const secText = sec => (fmtClock ? fmtClock(sec) : clockText(sec));
  const qs = sel => (host ? host.querySelector(sel) : null);
  const qsa = sel => (host ? Array.prototype.slice.call(host.querySelectorAll(sel)) : []);
  const filmNow = () => filmOf();

  /* ---------------- 播放头几何 ---------------- */
  const lineEl = () => qs('#tlPlayhead');
  const headEl = () => qs('#tlRulerHead');
  const navTotalNow = () => tlNavTotal(deriveTimeline(filmNow().clips).total);
  const clampPlayhead = t => Math.max(0, Math.min(navTotalNow(), num(t)));
  function playheadX(t, pps = ppsNow()) {
    return tlXOfTime(Math.max(0, num(t)), pps);
  }
  function setPlayheadX(el, x) {
    if (el) el.style.transform = `translate3d(${Math.round(x * 100) / 100}px,0,0)`;
  }
  function cancelGlideLine() {
    if (glideLine) { try { glideLine.cancel(); } catch (e) { /* 节点已经换掉就没有可撤的 */ } glideLine = null; }
  }
  function cancelGlideHead() {
    if (glideHead) { try { glideHead.cancel(); } catch (e) { /* 同上 */ } glideHead = null; }
  }
  function glideTo(el, x0, x1, ms) {
    if (!el || typeof el.animate !== 'function' || !(ms > 0)) return null;
    return el.animate(
      [{ transform: `translate3d(${x0}px,0,0)` }, { transform: `translate3d(${x1}px,0,0)` }],
      { duration: ms, easing: 'linear', fill: 'forwards' });
  }
  /* 落精确位 + （播放中才）挂滑行。撤旧动画在写 transform 之前 —— 同一个任务里完成，不会闪。 */
  function anchorPlayhead(t) {
    const pps = ppsNow();
    const x0 = playheadX(t, pps);
    const x1 = playheadX(navTotalNow(), pps);
    const ms = (x1 - x0) / pps * 1000;
    cancelGlideLine();
    cancelGlideHead();
    setPlayheadX(lineEl(), x0);
    setPlayheadX(headEl(), x0);
    if (!gliding) return;
    glideLine = glideTo(lineEl(), x0, x1, ms);
    glideHead = glideTo(headEl(), x0, x1, ms);
  }
  /* 刻度尺重画之后尺上那一枚头是新节点：只把它接回滑行（线那一枚没动）。 */
  function anchorHead() {
    const pps = ppsNow();
    const head = headEl();
    const x0 = playheadX(playhead, pps);
    const x1 = playheadX(navTotalNow(), pps);
    cancelGlideHead();
    setPlayheadX(head, x0);
    if (gliding) glideHead = glideTo(head, x0, x1, (x1 - x0) / pps * 1000);
  }
  function paintReadout(t) {
    const t0 = qs('#tlT0');
    if (t0) t0.textContent = secText(t);
    const t1 = qs('#tlT1');
    if (t1) t1.textContent = secText(deriveTimeline(filmNow().clips).total);
    paintBack();
  }

  /* ---------------- 行表（标签列与轨道列共用的一张） ---------------- */
  /* 行键与 film.tracks 的键一致：`image` / `voice` / `voice-N` / `caption` / `caption-N`。
     待生成与配音共用同一组打包行（同一副 lane 语义），行键都写 `voice-N`。 */
  function rowsOf(film) {
    const tl = deriveTimeline(film.clips);
    const imageLanes = [];
    tl.rows.forEach(row => {
      const lane = Math.max(0, Math.round(num(row.clip && row.clip.ln)));
      while (imageLanes.length <= lane) imageLanes.push([]);
      imageLanes[lane].push(row);
    });
    if (!imageLanes.length) imageLanes.push([]);
    const pendingById = new Map(film.pending.map(p => [p.id, p]));
    const timed = [
      ...film.voices.map(v => ({ ...v, __kind: 'voice' })),
      ...film.pending.map(p => ({ ...p, __kind: 'pending' })),
    ];
    const voicePack = packVoiceLanes(timed);
    const capPack = packCaptionLanes(film.captions);
    const voiceLanes = voicePack.lanes.length ? voicePack.lanes : [{ lane: 0, items: [] }];
    const capLanes = capPack.lanes.length ? capPack.lanes : [{ lane: 0, items: [] }];
    const rows = [{ kind: 'markers', key: 'markers', label: '标记' }];
    imageLanes.forEach((items, lane) => rows.push({
      kind: 'image', key: `image-${lane}`, lane, items,
      label: lane ? `画面 ${lane + 1}` : '画面',
    }));
    voiceLanes.forEach(l => rows.push({
      kind: 'voice', key: `voice-${l.lane}`, lane: l.lane, items: l.items,
      label: l.lane ? `配音 ${l.lane + 1}` : '配音',
    }));
    capLanes.forEach(l => rows.push({
      kind: 'caption', key: `caption-${l.lane}`, lane: l.lane, items: l.items,
      label: l.lane ? `字幕 ${l.lane + 1}` : '字幕',
    }));
    return { tl, rows, voiceOverflow: voicePack.overflow, capOverflow: capPack.overflow, pendingById };
  }

  const rowOff = (film, row) => row.kind !== 'markers' && (!rowVisible(film.tracks, row.kind) || !rowVisible(film.tracks, row.key));
  const rowLock = (film, row) => row.kind !== 'markers' && itemLocked(film.tracks, row.kind, row.lane);

  /* ---------------- 几何 ---------------- */
  function viewportWidth() {
    return scrollEl && scrollEl.clientWidth ? scrollEl.clientWidth : 800;
  }
  function ppsNow() { return tlPxPerSec(viewportWidth(), zoom); }
  function geometry() {
    const film = filmNow();
    const tl = deriveTimeline(film.clips);
    const width = viewportWidth();
    const navTotal = tlNavTotal(tl.total);
    return {
      film, tl, total: tl.total, navTotal, width, zoom,
      pps: tlPxPerSec(width, zoom),
      contentW: tlTimelineWidth(navTotal, width, zoom),
      scrollLeft: scrollEl ? scrollEl.scrollLeft : 0,
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
    };
  }

  /* ---------------- 工具栏 ---------------- */
  const SEL_MODES = [
    { id: 'select', name: '选择', icon: 'select', hint: '点选 / 框选；拖动挪位置' },
    { id: 'left', name: '左选', icon: 'selectEdge', hint: '点一下选中它左边的那一截' },
    { id: 'right', name: '右选', icon: 'select', hint: '点一下选中它右边的那一截' },
    { id: 'edit-point', name: '编辑点', icon: 'scissors', hint: '在切点处修整相邻两段' },
    { id: 'slip', name: '滑移', icon: 'slip', hint: '画面窗口在段内前后滑，位置不变' },
    { id: 'slide', name: '滑动', icon: 'slide', hint: '这一段前后挪，邻居跟着伸缩' },
  ];
  const modeOf = id => SEL_MODES.find(m => m.id === id) || SEL_MODES[0];

  /* 工具条分三组（与参考项目同一条排法）：
     ① 标记 / 历史 / 剪法（删、复制、切刀、融合、吸附、波纹、选择工具、关联）
     ② 播放与段落（播放、新增一段、摘掉一段、缩短、加长）
     ③ 视图（回到播放头 —— 只在针离开视野时出现、缩小 / 读数 / 自适应 / 放大）。
     状态（is-on / disabled / 计数徽标）由 paintTimelineTools 就地刷，不整条重画。 */
  function toolsHTML() {
    const tb = (act, iconName, title, on) => `<button type="button" class="tl-tb${on ? ' is-on' : ''}" data-tl="${act}" title="${esc(title)}">${icon(iconName, 15)}</button>`;
    const film = filmNow();
    const st = toolState ? toolState() : {};
    return `<div class="tl-tools" id="tlTools">
      <div class="tl-tgroup">
        ${tb('markers', 'flag', '标记条：展开 / 收起', markersOpen)}
        <button type="button" class="tl-tb tl-tb-count${st.panelOn ? ' is-on' : ''}" data-tl="markers-panel" title="标记面板：全部标记、改类型与颜色">
          ${icon('list', 15)}<span class="tl-badge" id="tlMarkerCount"${film.markers.length ? '' : ' hidden'}>${film.markers.length}</span>
        </button>
      </div>
      <i class="tl-sep"></i>
      <div class="tl-tgroup">
        ${tb('undo', 'undo', '撤销（Ctrl/⌘+Z）')}
        ${tb('redo', 'redo', '重做（Ctrl/⌘+Shift+Z）')}
      </div>
      <i class="tl-sep"></i>
      <div class="tl-tgroup">
        ${tb('delete', 'trash', '删掉选中的那几段（Del）')}
        ${tb('duplicate', 'copy', '复制选中的那一段（Ctrl/⌘+D）')}
        ${tb('cut', 'scissors', '在播放头处切开（Ctrl/⌘+B）')}
        ${tb('merge', 'merge', '与下一段融合成一段')}
      </div>
      <i class="tl-sep"></i>
      <div class="tl-tgroup">
        ${tb('snap', 'magnet', '吸附：拖动时贴到切点 / 标记 / 播放头', snapOn)}
        ${tb('ripple', 'ripple', '波纹编辑：删除后后面的内容整体前移', rippleOn)}
      </div>
      <div class="tl-tgroup tl-selgroup">
        <button type="button" class="tl-tb tl-selmode" data-tl="selmenu" title="选择工具">
          ${icon(modeOf(mode).icon, 15)}<span class="tl-selmode-name">${modeOf(mode).name}</span>${icon('chevronDown', 12)}
        </button>
        <div class="tl-menu" id="tlSelMenu"${selMenuOpen ? '' : ' hidden'}>
          ${SEL_MODES.map(m => `<button type="button" class="tl-menu-row${m.id === mode ? ' is-on' : ''}" data-selmode="${m.id}" title="${esc(m.hint)}">${icon(m.icon, 14)}<span>${m.name}</span></button>`).join('')}
        </div>
      </div>
      ${tb('link', 'link', '字幕与配音关联：全部接上 / 全部解除', st.linkOn)}
      <i class="tl-sep"></i>
      <div class="tl-tgroup">
        <button type="button" class="tl-tb tl-play" data-tl="play" title="播放 / 暂停（空格）">${icon('play', 15)}</button>
        ${tb('add-seg', 'segAdd', '在播放头处新增一段')}
        ${tb('remove-seg', 'segRemove', '摘掉播放头指着的那一段')}
        ${tb('shorten', 'shorten', '把指着的那一段缩短 1 秒')}
        ${tb('lengthen', 'lengthen', '把指着的那一段加长 1 秒')}
      </div>
      <span class="tl-grow"></span>
      <div class="tl-tgroup">
        ${tb('to-playhead', 'skipBack', '回到播放头')}
        ${tb('zoom-out', 'minus', '缩小（视野更长）')}
        <span class="tl-zoom" id="tlZoomVal" title="视野秒数：滚轮缩放">${tlZoomLabel(zoom)}</span>
        ${tb('zoom-fit', 'expand', '自适应：整部铺满这一栏')}
        ${tb('zoom-in', 'plus', '放大（视野更短）')}
      </div>
      <span class="tl-total" title="成片总长">${secText(deriveTimeline(film.clips).total)}</span>
    </div>`;
  }

  /* 播放头这一刻在不在当前视野里（「回到播放头」那颗只在离开视野时画）。 */
  function timeInView(t) {
    if (!scrollEl) return true;
    const g = geometry();
    const x = tlXOfTime(t, g.pps) - g.scrollLeft;
    return x >= 0 && x <= g.width;
  }

  /* 就地刷工具条状态：选中数 / 开关 / 计数徽标 / 回到播放头的可见性。
     重画整条会丢掉焦点与已展开的下拉，所以只改类名与 disabled。 */
  let backBtn = null;
  function paintBack() {
    if (backBtn && backBtn.isConnected) backBtn.hidden = timeInView(playhead);
  }
  function paintTimelineTools() {
    const st = toolState ? toolState() : {};
    const film = filmNow();
    const setOn = (act, on) => { const el = qs(`[data-tl="${act}"]`); if (el) el.classList.toggle('is-on', !!on); };
    setOn('markers', markersOpen);
    setOn('snap', snapOn);
    setOn('ripple', rippleOn);
    setOn('markers-panel', st.panelOn);
    setOn('link', st.linkOn);
    const badge = qs('#tlMarkerCount');
    if (badge) { badge.textContent = String(film.markers.length); badge.hidden = !film.markers.length; }
    const none = (Number(st.selected) || 0) === 0;
    ['delete', 'duplicate', 'merge'].forEach(act => {
      const el = qs(`[data-tl="${act}"]`);
      if (el) el.disabled = none;
    });
    const back = qs('[data-tl="to-playhead"]');
    if (back) backBtn = back;
    paintBack();
  }

  /* ---------------- 刻度尺 ---------------- */
  function rulerTicksHTML(navTotal, pps) {
    const start = (scrollEl ? scrollEl.scrollLeft : 0) / pps;
    const end = start + viewportWidth() / pps;
    return tlTicks(navTotal, zoom, start, end).map(t => {
      const x = Math.round(t.time * pps * 100) / 100;
      return `<i class="tl-tick${t.isMajor ? ' major' : ''}" style="left:${x}px">${t.isMajor ? `<em>${t.label}</em>` : ''}</i>`;
    }).join('');
  }

  function rulerRowHTML() {
    const g = geometry();
    return `<div class="tl-ruler-row">
      <div class="tl-corner"><span class="tl-corner-txt">成片</span></div>
      <div class="tl-ruler-clip">
        <div class="tl-ruler-inner" id="tlRulerInner" style="width:${g.contentW}px">
          ${rulerTicksHTML(g.navTotal, g.pps)}
          <div class="tl-ruler-head" id="tlRulerHead"></div>
          <div class="tl-ruler-snap" id="tlRulerSnap" hidden></div>
        </div>
      </div>
    </div>`;
  }

  /* ---------------- 标记条 ---------------- */
  function markersHTML(film, pps) {
    if (!markersOpen) return '';
    const pins = film.markers.map(m => {
      const range = markerRangeOf(m);
      const x = Math.round(tlXOfTime(m.time, pps) * 100) / 100;
      const iconName = MARKER_TYPE_ICON[m.type] || 'flag';
      const head = `<button type="button" class="tl-marker type-${m.type} color-${m.color}" data-marker="${esc(m.id)}" data-time="${m.time}" style="left:${x}px"
        title="${esc(`${MARKER_TYPE_ZH[m.type] || '标记'} · ${markerTimeText(m)}${m.title ? ' · ' + m.title : ''}`)}">${icon(iconName, 11)}</button>`;
      if (!range || !(range.end > range.start)) return head;
      const w = Math.max(2, Math.round(tlXOfTime(range.end - range.start, pps) * 100) / 100);
      return head + `<i class="tl-marker-band color-${m.color}" data-band="${esc(m.id)}" data-start="${range.start}" data-dur="${range.end - range.start}"
        style="left:${x}px;width:${w}px" title="${esc(`${MARKER_TYPE_ZH[m.type] || '范围'}：拖一下整段挪，拖右沿改止点`)}"><i class="tl-band-tail" data-band-tail="${esc(m.id)}"></i></i>`;
    }).join('');
    return `<div class="tl-marker-rail" data-row="markers">
      ${pins}
      ${film.markers.length ? '' : '<span class="tl-rail-hint">按 M 在播放头处加标记</span>'}
    </div>`;
  }

  /* ---------------- 轨道与块 ---------------- */
  /* 「闪一下」是渲染层的一份状态，不是直接怼在节点上的 class：
     写入与定位之后几百毫秒里板还要再重画一次，直接加的 class 会跟着旧节点一起被换掉
     （用户看到的就是「点了执行/定位，什么都没闪」）。渲染时按到期时刻补上，到期再画一次。 */
  const flashUntil = new Map();
  let flashTimer = 0;
  const flashClsOf = id => ((flashUntil.get(String(id)) || 0) > Date.now() ? ' flash' : '');
  function flashBlocks(ids) {
    const until = Date.now() + 2400;
    (Array.isArray(ids) ? ids : [ids]).forEach(id => { if (id) flashUntil.set(String(id), until); });
    render();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      const now = Date.now();
      let hit = false;
      flashUntil.forEach((t, k) => { if (t <= now) { flashUntil.delete(k); hit = true; } });
      if (hit) render();
    }, 2500);
    return flashUntil.size;
  }

  function clipHTML(clip, start, pps, film) {
    const w = Math.max(2, Math.round(tlXOfTime(clip.duration, pps) * 100) / 100);
    const x = Math.round(tlXOfTime(start, pps) * 100) / 100;
    const locked = itemLocked(film.tracks, 'image', clip.ln);
    const visible = itemVisible(film.tracks, 'image', clip.ln);
    const cls = ['tl-clip', clip.kind === 'image' ? 'is-image' : 'is-video',
      clip.muted ? 'is-muted' : '', locked ? 'is-locked' : '', visible ? '' : 'is-off'].filter(Boolean).join(' ') + flashClsOf(clip.id);
    const label = clip.name || (clip.kind === 'image' ? '图片' : '视频');
    return `<div class="${cls}" data-clip="${esc(clip.id)}" data-start="${start}" data-dur="${clip.duration}"
      style="left:${x}px;width:${w}px"
      title="${esc(label)} · ${secText(clip.duration)}${clip.playbackRate !== 1 ? ' · ' + clip.playbackRate + '×' : ''}">
      <div class="tl-block-in">${strip.clipBody(clip, { locked })}</div>
      ${locked ? '' : '<i class="tl-h is-start" data-handle="start"></i><i class="tl-h is-end" data-handle="end"></i>'}
    </div>`;
  }

  function voiceHTML(item, pps, film, isPending) {
    const w = Math.max(2, Math.round(tlXOfTime(item.duration, pps) * 100) / 100);
    const x = Math.round(tlXOfTime(item.start, pps) * 100) / 100;
    const lane = Number.isInteger(item.lane) ? item.lane : 0;
    const locked = itemLocked(film.tracks, 'voice', lane);
    const visible = itemVisible(film.tracks, 'voice', lane);
    const cls = ['tl-voice', isPending ? 'is-pending' : '', locked ? 'is-locked' : '', visible ? '' : 'is-off'].filter(Boolean).join(' ') + flashClsOf(item.id);
    const attr = isPending ? `data-pending="${esc(item.id)}"` : `data-voice="${esc(item.id)}"`;
    return `<div class="${cls}" ${attr} data-start="${item.start}" data-dur="${item.duration}" data-lane="${lane}"
      style="left:${x}px;width:${w}px"
      title="${esc(item.text || (isPending ? '待生成' : '配音'))} · ${secText(item.duration)}">
      <div class="tl-block-in">${isPending ? strip.pendingBody(item) : strip.voiceBody(item)}</div>
      ${locked ? '' : '<i class="tl-h is-start" data-handle="start"></i><i class="tl-h is-end" data-handle="end"></i>'}
    </div>`;
  }

  function captionHTML(cap, pps, film) {
    const dur = Math.max(0.05, num(cap.end) - num(cap.start));
    const w = Math.max(2, Math.round(tlXOfTime(dur, pps) * 100) / 100);
    const x = Math.round(tlXOfTime(cap.start, pps) * 100) / 100;
    const lane = Number.isInteger(cap.lane) ? cap.lane : 0;
    const locked = itemLocked(film.tracks, 'caption', lane);
    const visible = itemVisible(film.tracks, 'caption', lane);
    const cls = ['tl-cap', locked ? 'is-locked' : '', visible ? '' : 'is-off'].filter(Boolean).join(' ') + flashClsOf(cap.id);
    return `<div class="${cls}" data-cap="${esc(cap.id)}" data-start="${cap.start}" data-dur="${dur}" data-lane="${lane}"
      style="left:${x}px;width:${w}px" title="${esc(cap.text || '字幕')}">
      <div class="tl-block-in">${strip.captionBody(cap)}</div>
      ${locked ? '' : '<i class="tl-h is-start" data-handle="start"></i><i class="tl-h is-end" data-handle="end"></i>'}
    </div>`;
  }

  function junctionsHTML(film, tl, pps) {
    let html = '';
    for (let i = 0; i < tl.rows.length - 1; i++) {
      const row = tl.rows[i];
      const tr = transitionOf(row.clip, tl.rows[i + 1].clip);
      const x = Math.round(tlXOfTime(row.end, pps) * 100) / 100;
      const title = tr ? `转场：${transitionNameOf(tr.id)} ${tr.duration}s` : '连接点：点一下加转场';
      html += `<button type="button" class="tl-junction${tr ? ' has-tr' : ''}" data-junction="${i}" data-time="${row.end}"
        style="left:${x}px" title="${esc(title)}"><i class="tl-junction-dot"></i></button>`;
    }
    return `<div class="tl-junctions"${html ? '' : ' hidden'}>${html}</div>`;
  }

  function labelHTML(film, row) {
    if (row.kind === 'markers') {
      return `<div class="tl-label is-markers${markersOpen ? '' : ' is-folded'}" data-row="markers">
        <span class="tl-label-ic">${icon('flag', 11)}</span>
        <span class="tl-name">标记</span>
        <span class="tl-count">${film.markers.length || ''}</span>
      </div>`;
    }
    const off = rowOff(film, row);
    const locked = rowLock(film, row);
    const count = row.items ? row.items.length : 0;
    return `<div class="tl-label is-${row.kind}${off ? ' is-off' : ''}${locked ? ' is-locked' : ''}" data-row="${row.key}">
      <button type="button" class="tl-flag" data-eye="${row.key}" title="${off ? '显示这一行' : '隐藏这一行'}">${icon(off ? 'eyeOff' : 'eye', 12)}</button>
      <button type="button" class="tl-flag" data-lock="${row.key}" title="${locked ? '解锁这一行' : '锁定这一行'}">${icon('lock', 12)}</button>
      <span class="tl-name" title="${esc(row.label)}">${esc(row.label)}</span>
      <span class="tl-count">${count || ''}</span>
    </div>`;
  }

  function laneHTML(film, row, pps) {
    const off = rowOff(film, row);
    const locked = rowLock(film, row);
    const cls = `tl-lane is-${row.kind}${off ? ' is-off' : ''}${locked ? ' is-locked' : ''}`;
    let body = '';
    if (row.kind === 'image') {
      body = row.items.map(r => clipHTML(r.clip, r.start, pps, film)).join('');
      if (!film.clips.length) body = '<span class="tl-lane-hint">在右栏点「用这条」，画面就落到这一轨</span>';
    } else if (row.kind === 'voice') {
      body = row.items.map(item => voiceHTML(item, pps, film, item.__kind === 'pending')).join('');
      if (!film.voices.length && !film.pending.length) body = '<span class="tl-lane-hint">配音与待生成的句子会排在这一轨</span>';
    } else if (row.kind === 'caption') {
      body = row.items.map(cap => captionHTML(cap, pps, film)).join('');
      if (!film.captions.length) body = '<span class="tl-lane-hint">字幕会排在这一轨（按台词生成）</span>';
    }
    return `<div class="${cls}" data-row="${row.key}" data-lane="${row.lane == null ? 0 : row.lane}">${body}</div>`;
  }

  /* 网格竖线间距（主刻度那一档）：只用来画背景，不参与任何换算。 */
  function gridStepPx(navTotal, pps) {
    const major = tlTicks(navTotal, zoom, 0, 0).find(t => t.isMajor);
    return Math.max(24, (major ? major.time : 1) * pps);
  }

  function tracksHTML(film, table, pps) {
    const kindRows = kind => table.rows.filter(r => r.kind === kind);
    const trackBlock = kind => `<div class="tl-track is-${kind}" data-track="${kind}">
      ${kindRows(kind).map(r => laneHTML(film, r, pps)).join('')}
      ${kind === 'image' ? junctionsHTML(film, table.tl, pps) : ''}
    </div>`;
    const over = table.voiceOverflow ? `<div class="tl-overflow">配音超出 ${table.voiceOverflow} 行未画（上限 ${LANE_MAX} 行）</div>` : '';
    const overCap = table.capOverflow ? `<div class="tl-overflow">字幕超出 ${table.capOverflow} 行未画（上限 ${LANE_MAX} 行）</div>` : '';
    const navTotal = tlNavTotal(table.tl.total);
    return `<div class="tl-content" id="tlContent" style="width:${tlTimelineWidth(navTotal, viewportWidth(), zoom)}px;--tl-grid:${gridStepPx(navTotal, pps)}px">
      <div class="tl-playhead" id="tlPlayhead"><i class="tl-playhead-knob"></i></div>
      ${markersHTML(film, pps)}
      ${trackBlock('image')}
      ${trackBlock('voice')}
      ${trackBlock('caption')}
      ${over}${overCap}
      <div class="tl-snap-line" id="tlSnapLine" hidden></div>
    </div>`;
  }

  function boardHTML(film) {
    const table = rowsOf(film);
    const pps = ppsNow();
    return `${toolsHTML()}
      ${rulerRowHTML()}
      <div class="tl-body">
        <div class="tl-labels">
          <div class="tl-labels-inner" id="tlLabelsInner">
            ${table.rows.filter(r => r.kind !== 'markers' || markersOpen).map(r => labelHTML(film, r)).join('')}
          </div>
        </div>
        <div class="tl-scroll" id="tlScroll" tabindex="0">
          ${tracksHTML(film, table, pps)}
        </div>
      </div>
      <div class="tl-foot">
        <span class="tl-read" id="tlT0" title="播放头在成片第几秒">${secText(playhead)}</span>
        <span class="tl-foot-sep">/</span>
        <span class="tl-read" id="tlT1" title="成片总长">${secText(table.tl.total)}</span>
        <span class="tl-foot-hint" id="tlHint"></span>
      </div>
      <div class="tl-pop" id="tlPop" hidden></div>`;
  }

  /* ---------------- 整块重画 ---------------- */
  function render() {
    if (!host) return;
    /* 台词有没有变成待生成块 —— 重画之前先问一次（syncPending 自己只在真的变了才落盘）。 */
    if (beforeRender) beforeRender();
    const film = filmNow();
    const keep = scrollEl ? { left: scrollEl.scrollLeft, top: scrollEl.scrollTop } : { left: 0, top: 0 };
    host.innerHTML = boardHTML(film);
    scrollEl = qs('#tlScroll');
    labelsInner = qs('#tlLabelsInner');
    rulerInner = qs('#tlRulerInner');
    contentEl = qs('#tlContent');
    popEl = qs('#tlPop');
    menuEl = qs('#tlSelMenu');
    if (scrollEl) {
      scrollEl.scrollLeft = keep.left;
      scrollEl.scrollTop = keep.top;
      observeScroll();
    }
    lastTicksLeft = scrollEl ? scrollEl.scrollLeft : 0;
    syncScroll();
    paintPlayhead();
    strip.paint(contentEl, film);
    if (popIndex >= 0) {
      const j = qs(`[data-junction="${popIndex}"]`);
      if (j) openPopover(popIndex, j); else closePopover();
    }
    if (onBoardRender) onBoardRender();
    paintTimelineTools();
  }

  /* 滚动位置变了：尺、左列共用同一次平移。 */
  function syncScroll() {
    if (!scrollEl) return;
    if (rulerInner) rulerInner.style.transform = `translateX(${-scrollEl.scrollLeft}px)`;
    if (labelsInner) labelsInner.style.transform = `translateY(${-scrollEl.scrollTop}px)`;
  }

  /* 只重画刻度（缩放 / 滚动时走它，不重建块）。 */
  function paintRuler() {
    if (!rulerInner) return;
    const g = geometry();
    const snapLeft = snapTime == null ? null : Math.round(tlXOfTime(snapTime, g.pps) * 100) / 100;
    rulerInner.style.width = g.contentW + 'px';
    rulerInner.innerHTML = rulerTicksHTML(g.navTotal, g.pps)
      + '<div class="tl-ruler-head" id="tlRulerHead"></div>'
      + `<div class="tl-ruler-snap" id="tlRulerSnap"${snapLeft == null ? ' hidden' : ''}${snapLeft == null ? '' : ` style="left:${snapLeft}px"`}></div>`;
    anchorHead();
    lastTicksLeft = scrollEl ? scrollEl.scrollLeft : 0;
  }

  /* 缩放后块的位置与宽度就地改（不重建节点：重建会把已经解好的帧全部拆掉重贴）。 */
  function layoutBoard() {
    if (!contentEl) return;
    const g = geometry();
    contentEl.style.width = g.contentW + 'px';
    contentEl.style.setProperty('--tl-grid', gridStepPx(g.navTotal, g.pps) + 'px');
    qsa('[data-start][data-dur]').forEach(el => {
      const start = num(el.getAttribute('data-start'));
      const dur = num(el.getAttribute('data-dur'));
      el.style.left = Math.round(tlXOfTime(start, g.pps) * 100) / 100 + 'px';
      el.style.width = Math.max(2, Math.round(tlXOfTime(dur, g.pps) * 100) / 100) + 'px';
    });
    qsa('[data-junction]').forEach(el => {
      el.style.left = Math.round(tlXOfTime(num(el.getAttribute('data-time')), g.pps) * 100) / 100 + 'px';
    });
    qsa('[data-marker]').forEach(el => {
      el.style.left = Math.round(tlXOfTime(num(el.getAttribute('data-time')), g.pps) * 100) / 100 + 'px';
    });
    paintPlayhead();
    syncScroll();
  }

  function paintPlayhead() {
    anchorPlayhead(playhead);
    paintReadout(playhead);
  }

  /* ---------------- 播放头 / 吸附 ---------------- */
  function setPlayhead(t, opts = {}) {
    const next = clampPlayhead(t);
    if (next !== playhead || opts.force) {
      gliding = false;
      playhead = next;
      paintPlayhead();
    }
    if (opts.follow) follow();
    return playhead;
  }
  const playheadAt = () => playhead;

  /* 放针的唯一出口：有播放核时由它接管（停下时钟、换画面、再报回新位置），
     没有就只落针。点空处 / 拖针边滚 / 点标记都走它。 */
  function seekTo(t, opts = {}) {
    const next = clampPlayhead(t);
    if (seekRequest) {
      seekRequest(next, opts.playNow);
      if (opts.follow) follow();
      return next;
    }
    return setPlayhead(next, opts);
  }

  function follow() {
    if (!scrollEl) return;
    const g = geometry();
    const x = tlXOfTime(playhead, g.pps) - g.scrollLeft;
    if (x >= 0 && x <= g.width * 0.85) return;
    scrollEl.scrollLeft = Math.max(0, tlXOfTime(playhead, g.pps) - g.width * 0.15);
    syncScroll();
  }

  function scrollToTime(t, align = 0.5) {
    if (!scrollEl) return;
    const g = geometry();
    scrollEl.scrollLeft = Math.max(0, tlXOfTime(t, g.pps) - g.width * align);
    syncScroll();
  }

  /* ---------------- 播放核的出口（engine/play.js 只走这三条） ---------------- */
  /* 开播：落精确位并挂上滑行；播放中的读数与跟随由 playbackSync 接。 */
  function playbackStart(t) {
    playhead = clampPlayhead(t);
    gliding = true;
    anchorPlayhead(playhead);
    paintReadout(playhead);
    follow();
  }
  function playbackSync(t) {
    playhead = clampPlayhead(t);
    if (!gliding) anchorPlayhead(playhead);
    paintReadout(playhead);
    follow();
  }
  /* 停（暂停 / seek / 播到片尾 / 卸下）：撤滑行、落精确位。 */
  function playbackStop(t) {
    playhead = clampPlayhead(t);
    gliding = false;
    anchorPlayhead(playhead);
    paintReadout(playhead);
    follow();
  }

  function showSnap(time, label) {
    snapTime = num(time, null);
    const line = qs('#tlSnapLine');
    if (line) {
      line.hidden = false;
      line.style.left = Math.round(tlXOfTime(snapTime, ppsNow()) * 100) / 100 + 'px';
    }
    const ruler = qs('#tlRulerSnap');
    if (ruler) {
      ruler.hidden = false;
      ruler.style.left = Math.round(tlXOfTime(snapTime, ppsNow()) * 100) / 100 + 'px';
    }
    const hint = qs('#tlHint');
    if (hint && label) hint.textContent = label;
  }
  function hideSnap() {
    snapTime = null;
    const line = qs('#tlSnapLine');
    if (line) line.hidden = true;
    const ruler = qs('#tlRulerSnap');
    if (ruler) ruler.hidden = true;
  }

  /* ---------------- 缩放 ---------------- */
  function zoomBounds() {
    return { min: Math.max(TL_ZOOM_MIN, tlZoomFloor(deriveTimeline(filmNow().clips).total)), max: TL_ZOOM_MAX };
  }
  function applyZoom(nextZoom, anchorClientX) {
    const bounds = zoomBounds();
    const z = Math.max(bounds.min, Math.min(bounds.max, tlClampZoom(nextZoom)));
    if (Math.abs(z - zoom) < 1e-6) return;
    const sc = scrollEl;
    let nextScroll = null;
    if (sc) {
      const rect = sc.getBoundingClientRect();
      const anchorX = anchorClientX == null ? rect.width / 2 : Math.max(0, Math.min(rect.width, anchorClientX - rect.left));
      nextScroll = tlAnchoredScroll(sc.scrollLeft, anchorX, rect.width, zoom, z);
    }
    zoom = z;
    if (setZoom) setZoom(zoom);
    if (sc && nextScroll != null) sc.scrollLeft = nextScroll;
    const val = qs('#tlZoomVal');
    if (val) val.textContent = tlZoomLabel(zoom);
    layoutBoard();
    paintRuler();
    syncScroll();
    scheduleStrip();
  }
  /* 缩放停下来之后才重算帧数（每滚一格都重排一遍胶片的代价太大，而且会满屏闪烁）。
     落定那一下也是用户的重试信号：格子宽度换了、采样点跟着换，原来记的「这一刻取不到帧」
     不再作数（frames.js 的退避放行一次，取不到的当场重新排活）。 */
  function scheduleStrip() {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = 0;
      if (sliceForgetFail) sliceForgetFail();
      if (contentEl && contentEl.isConnected) strip.paint(contentEl, filmNow());
    }, 180);
  }
  const zoomNow = () => zoom;
  /* 一颗按钮 = 1.25 倍视野（参考项目 TIMELINE_BUTTON_ZOOM_RATIO 同一档）：
     1.6 倍在「缩一档看细节」时跨得太狠，两档之间没有落脚处。 */
  const ZOOM_STEP = 1.25;
  function zoomIn() { applyZoom(zoom * ZOOM_STEP); }
  function zoomOut() { applyZoom(zoom / ZOOM_STEP); }
  function zoomFit() {
    applyZoom(tlFitZoom(deriveTimeline(filmNow().clips).total));
    if (scrollEl) scrollEl.scrollLeft = 0;
    syncScroll();
  }

  /* ---------------- 转场浮层 ---------------- */
  function openPopover(index, anchor) {
    const film = filmNow();
    const left = film.clips[index];
    const right = film.clips[index + 1];
    if (!left || !right || !popEl) return;
    popIndex = index;
    const tr = transitionOf(left, right);
    const maxDur = transitionMax(left, right);
    const dur = tr ? tr.duration : Math.min(DEFAULT_TRANSITION_SECONDS, maxDur);
    const current = tr ? tr.id : 'none';
    popEl.innerHTML = `<div class="tl-pop-head">
        <strong>连接点 · 转场</strong>
        <button type="button" class="tl-tb" data-pop-close title="关掉">${icon('close', 13)}</button>
      </div>
      <div class="tl-pop-presets">
        ${TRANSITIONS.map(t => `<button type="button" class="tl-pop-preset${t.id === current ? ' is-on' : ''}" data-preset="${t.id}" title="${esc(t.name)}">
          <i class="tl-trp t-${t.id}"></i><span>${esc(t.name)}</span>
        </button>`).join('')}
      </div>
      <label class="tl-pop-dur${tr ? '' : ' is-off'}" title="转场时长：最多吃掉较短那一段的一半">
        <span>时长</span>
        <input type="range" id="tlPopDur" min="0.1" max="${Math.round(maxDur * 10) / 10}" step="0.1" value="${dur}"${tr ? '' : ' disabled'}>
        <em id="tlPopDurVal">${dur.toFixed(1)}s</em>
      </label>`;
    popEl.hidden = false;
    positionPopover(anchor);
  }
  function positionPopover(anchor) {
    if (!popEl || popEl.hidden || !host) return;
    const hostRect = host.getBoundingClientRect();
    let x = 40, y = 40;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      x = r.left - hostRect.left + r.width / 2 - 150;
      y = r.top - hostRect.top - 240;
    }
    popEl.style.left = Math.max(8, Math.min(Math.max(8, hostRect.width - 316), x)) + 'px';
    popEl.style.top = Math.max(8, Math.min(Math.max(8, hostRect.height - 80), y)) + 'px';
  }
  function closePopover() {
    popIndex = -1;
    if (popEl) { popEl.hidden = true; popEl.innerHTML = ''; }
  }

  /* ---------------- 选择工具菜单 ---------------- */
  function openSelMenu() {
    selMenuOpen = true;
    if (menuEl) menuEl.hidden = false;
  }
  function closeSelMenu() {
    selMenuOpen = false;
    if (menuEl) menuEl.hidden = true;
  }
  function setMode(id) {
    if (!SEL_MODES.some(m => m.id === id)) return;
    mode = id;
    closeSelMenu();
    const btn = qs('.tl-selmode');
    if (btn) btn.innerHTML = `${icon(modeOf(mode).icon, 15)}<span class="tl-selmode-name">${modeOf(mode).name}</span>${icon('chevronDown', 12)}`;
    qsa('[data-selmode]').forEach(el => el.classList.toggle('is-on', el.getAttribute('data-selmode') === mode));
    if (toolAction) toolAction('mode', { mode });
    if (setStatus) setStatus('选择工具：' + modeOf(mode).name + '。' + modeOf(mode).hint);
  }
  const modeNow = () => mode;

  /* ---------------- 行眼睛 / 锁 ---------------- */
  function toggleRowFlag(kind, key) {
    const film = filmNow();
    const tracks = film.tracks || (film.tracks = { visibility: {}, locks: {} });
    const locked = kind === 'lock';
    if (locked) rowSet(tracks, 'lock', key, !(tracks.locks && tracks.locks[key] === true));
    else rowSet(tracks, 'vis', key, tracks.visibility && tracks.visibility[key] === false ? null : false);
    if (scheduleSaveQuiet) scheduleSaveQuiet();
    render();
    if (setStatus) {
      if (locked) setStatus(`${key}：${tracks.locks[key] ? '已锁定' : '已解锁'}`);
      else setStatus(`${key}：${tracks.visibility[key] === false ? '已隐藏' : '已显示'}`);
    }
  }

  /* ---------------- 交互（整块委托在 host 上，重画不丢处理器） ---------------- */
  function onBoardClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (popEl && popEl.contains(t)) {
      const close = t.closest('[data-pop-close]');
      if (close) { closePopover(); return; }
      const preset = t.closest('[data-preset]');
      if (preset && popIndex >= 0 && transitionSet) {
        transitionSet(popIndex, { id: preset.getAttribute('data-preset') });
      }
      return;
    }
    const selRow = t.closest('[data-selmode]');
    if (selRow) { e.stopPropagation(); setMode(selRow.getAttribute('data-selmode')); return; }
    const tool = t.closest('[data-tl]');
    if (tool) {
      e.preventDefault();
      const act = tool.getAttribute('data-tl');
      if (act === 'zoom-in') return zoomIn();
      if (act === 'zoom-out') return zoomOut();
      if (act === 'zoom-fit') return zoomFit();
      if (act === 'markers') { markersOpen = !markersOpen; render(); return; }
      if (act === 'snap') {
        snapOn = !snapOn;
        tool.classList.toggle('is-on', snapOn);
        if (setStatus) setStatus('吸附已' + (snapOn ? '开' : '关'));
        return;
      }
      if (act === 'ripple') {
        rippleOn = !rippleOn;
        tool.classList.toggle('is-on', rippleOn);
        if (setStatus) setStatus('波纹编辑已' + (rippleOn ? '开：删除后面整体前移' : '关'));
        return;
      }
      if (act === 'selmenu') {
        e.stopPropagation();
        if (selMenuOpen) closeSelMenu(); else openSelMenu();
        return;
      }
      if (toolAction) toolAction(act, { playhead });
      return;
    }
    const eye = t.closest('[data-eye]');
    if (eye) { e.stopPropagation(); return toggleRowFlag('vis', eye.getAttribute('data-eye')); }
    const lock = t.closest('[data-lock]');
    if (lock) { e.stopPropagation(); return toggleRowFlag('lock', lock.getAttribute('data-lock')); }
    /* 左列「标记」那一行本身也是开关（和工具条上那颗旗子同一件事）：收起 / 展开标记条。 */
    if (t.closest('.tl-label.is-markers')) {
      e.stopPropagation();
      markersOpen = !markersOpen;
      render();
      return;
    }
    const junction = t.closest('[data-junction]');
    if (junction) {
      e.stopPropagation();
      const index = Number(junction.getAttribute('data-junction'));
      jsClick(index, junction);
      return;
    }
    function jsClick(index, el) {
      if (popIndex === index) closePopover();
      else openPopover(index, el);
    }
    const marker = t.closest('[data-marker]');
    if (marker) {
      const m = filmNow().markers.find(x => x.id === marker.getAttribute('data-marker'));
      if (m) {
        e.stopPropagation();
        seekTo(m.time, { follow: true });
        if (setStatus) setStatus(`${MARKER_TYPE_ZH[m.type] || '标记'}：${markerTimeText(m)}${m.title ? ' · ' + m.title : ''}`);
      }
      return;
    }
    if (popEl && !popEl.hidden) closePopover();
    if (selMenuOpen && !t.closest('.tl-selgroup')) closeSelMenu();
  }

  function onDblClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.tl-clip,.tl-voice,.tl-cap,.tl-junction,.tl-marker,.tl-label,.tl-tools')) return;
    if (t.closest('.tl-scroll') && dblClickEmpty) dblClickEmpty(timeAtClientX(e.clientX));
  }

  function onWheel(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.tl-pop,.tl-menu')) return;
    if (e.altKey) {
      if (scrollEl) { e.preventDefault(); scrollEl.scrollTop += e.deltaY; syncScroll(); }
      return;
    }
    if (t.closest('.tl-labels')) {
      if (scrollEl) { e.preventDefault(); scrollEl.scrollTop += e.deltaY; syncScroll(); }
      return;
    }
    e.preventDefault();
    /* 触控板 / 滚轮的三种走法（按「用户此刻想干什么」分，不按设备分）：
       · 捏合 = 带 ctrlKey 的 wheel（macOS / Windows 触控板都一样）→ 缩放，锚在指针那一秒；
       · 两指横滑（deltaX）与普通竖向滚动（deltaY）→ **都当横向滚动**：这条时间线本来就是横的，
         两指上下搓一下看到后面的镜头，比「一不小心把比例尺缩到最小」顺手得多；
       · 竖着翻行仍走 Alt / 把指针放到左边标签列（上面那两条分支）。 */
    if (e.ctrlKey || e.metaKey) { applyZoom(tlZoomByWheel(zoom, e.deltaY), e.clientX); return; }
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (scrollEl && dx) { scrollEl.scrollLeft += dx; syncScroll(); paintRuler(); }
  }

  function onPopInput(e) {
    const el = e.target;
    if (!el || el.id !== 'tlPopDur' || popIndex < 0) return;
    const v = Math.max(0.1, num(el.value, 0.5));
    const val = qs('#tlPopDurVal');
    if (val) val.textContent = v.toFixed(1) + 's';
    if (transitionSet) transitionSet(popIndex, { duration: v }, { live: true });
  }
  function onPopChange(e) {
    const el = e.target;
    if (!el || el.id !== 'tlPopDur' || popIndex < 0) return;
    if (transitionSet) transitionSet(popIndex, { duration: Math.max(0.1, num(el.value, 0.5)) });
  }

  function timeAtClientX(clientX) {
    if (!scrollEl) return 0;
    const rect = scrollEl.getBoundingClientRect();
    const g = geometry();
    return Math.max(0, Math.min(g.navTotal, tlTimeAtX(clientX - rect.left + scrollEl.scrollLeft, g.pps)));
  }

  function handleScroll() {
    if (!scrollEl) return;
    syncScroll();
    paintBack();
    /* 刻度只画了视口前后各 35% 那一截：滚出去太远就补画一次（否则滚到远处是一把空尺）。 */
    if (Math.abs(scrollEl.scrollLeft - lastTicksLeft) > viewportWidth() * 0.25) paintRuler();
  }

  function onKeyDown(e) {
    if (e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
    if (e.key !== 'Escape') return;
    if (popIndex >= 0) { closePopover(); e.stopPropagation(); }
    if (selMenuOpen) { closeSelMenu(); e.stopPropagation(); }
  }

  function observeScroll() {
    if (resizing) { resizing.disconnect(); resizing = null; }
    if (!scrollEl || typeof window.ResizeObserver !== 'function') return;
    /* 观察回调里量出来再写样式：同一帧里改布局会被浏览器记一笔
       「ResizeObserver loop completed with undelivered notifications」。
       所以回调只记尺寸，真正重排推到下一帧，且尺寸没变就什么都不做。 */
    let lastW = -1, lastH = -1, pending = 0;
    resizing = new window.ResizeObserver(entries => {
      const box = entries && entries[entries.length - 1] && entries[entries.length - 1].contentRect;
      if (!box) return;
      const w = Math.round(box.width), h = Math.round(box.height);
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      if (pending) return;
      pending = window.requestAnimationFrame(() => {
        pending = 0;
        if (!scrollEl || !scrollEl.isConnected) return;
        layoutBoard(); paintRuler(); syncScroll();
      });
    });
    resizing.observe(scrollEl);
  }

  function bind(el) {
    host = el;
    host.addEventListener('click', onBoardClick);
    host.addEventListener('dblclick', onDblClick);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('scroll', handleScroll, true);
    host.addEventListener('input', onPopInput);
    host.addEventListener('change', onPopChange);
    document.addEventListener('keydown', onKeyDown);
    render();
  }

  /* ---------------- 对外面 ---------------- */
  return {
    bind,
    render,
    geometry,
    timeAtClientX,
    scrollToTime,
    setPlayhead,
    seekTo,
    playbackStart,
    playbackSync,
    playbackStop,
    playhead: playheadAt,
    follow,
    showSnap,
    hideSnap,
    zoomIn,
    zoomOut,
    zoom: zoomNow,
    setMode,
    mode: modeNow,
    snapOn: () => snapOn,
    rippleOn: () => rippleOn,
    markersOpen: () => markersOpen,
    paintTimelineTools,
    flashBlocks,
    layoutBoard,
    stripRefresh: () => { if (contentEl) strip.paint(contentEl, filmNow()); },
  };
}
