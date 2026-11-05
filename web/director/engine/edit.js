/* 导演台Edit域（engine/edit.js）：块上的手势与工具条动作 —— 搓擦放针、拖动换序 / 换行、裁边、
   切刀、复制删除、增删段与长短微调、吸附与波纹、六档选择工具与组拖、标记（加 / 拖 / 面板）、
   关联族（接上 / 解除 / 全部关联认回记忆位 / 对齐到音频）。
   画归 engine/timeline.js（整块重画）与 engine/strip.js（块里画什么），时钟归 engine/play.js；
   这一份只改 `proj.film` 的数据，改完一律 beginEdit(精确描述) → 落盘 → filmEdited()。
   几何换算只走 Timeline 的 timeAtClientX / geometry —— 秒数不在这里再折第二遍。 */
import {
  deriveTimeline, normalizeFilm, createClip, createCaption, filmId,
  itemLocked, coversTime, clipDurationOf, filmLaneOf,
  MIN_CAPTION_SECONDS, IMAGE_SEGMENT_SECONDS, MAX_FILM_SECONDS,
} from '../film.js';
import {
  splitClipAt, splitVoiceAt, splitCaptionAt, canMergeClips, mergeClipsAt, removeClipAt, duplicateClipAt,
} from '../tl-cut.js';
import {
  trimClipLeft, trimClipRight, trimClipLeftAnchored,
  trimVoiceLeft, trimVoiceRight, trimCaptionLeft, trimCaptionRight,
  slipClip, rollClipsBoundary, slideClip, followCaptions,
} from '../tl-resize.js';
import {
  reorderClips, dropIndexAt, moveClipToLane, moveTimedToLane, compactLanes, newLaneBelow, shiftGroupStart,
  placeClipGroupStill,
} from '../tl-reorder.js';
import { applyTimelineRipple, rippleDeltaOf } from '../tl-ripple.js';
import { collectTimelineSnapPoints, snapTimelineValue, TL_SNAP_PX } from '../tl-snap.js';
import { createEdgeAutoScroll } from '../tl-autoscroll.js';
import {
  createMarker, markerRangeOf, markersSorted, markerClock, markerCounts,
  MARKER_TYPES, MARKER_TYPE_ZH, MARKER_TYPE_ICON, MARKER_COLORS, MARKER_COLOR_ZH,
} from '../tl-markers.js';
import { num, round2, ctxClip } from '../util.js';

const DRAG_PX = 4;          // 超过这个像素数才算「拖」，否则算点一下
const CLICK_SUPPRESS_MS = 240;
const CLICK_SUPPRESS_PX = 4;  // 手势终点与紧随其后的那一下 click 的坐标容差（同一颗点才算「那一发」）
const CAPTION_ADD_SECONDS = 1.8;

/* 读数：轨道上一律带零点一秒。 */
const fmtTenth = v => (Math.round(Math.max(0, num(v)) * 10) / 10).toFixed(1);
/* 写回 `data-start` / `data-dur`：layoutBoard 现读这两个属性，精度只到毫秒足够。 */
const attr = v => String(Math.round(Math.max(0, num(v)) * 1000) / 1000);
const selKey = (kind, id) => `${kind}:${id}`;

export function createEdit(E, document, window) {
  const {
    filmOf, icon, esc, setStatus, beginEdit, filmEdited, scheduleSaveQuiet,
    Timeline, Play, addMarkerAt, shotLines, onFocus, sliceForgetFail,
  } = E;

  let host = null;              // #tlBoardBody：Timeline 每次重画换掉它的孩子
  let board = null;             // .tl-board：浮层挂这里（重画不动它）
  /* host 里「不属于轨道面」的那几块：工具条（含选择工具那排菜单）与转场浮层。
     上下文菜单与标记面板挂在板子上（host 之外），自己接自己的点击，够不着这里这三颗捕获式监听。
     拖动与点击的归属判定都按这一份 —— 轨道面上的手势不该把这些格子里的一下当成「点到哪一格」。 */
  const UI_ZONES = '.tl-tools,.tl-pop,.tl-menu';
  let drag = null;
  /* 松手 / 点选之后浏览器紧跟着一发的那一下 click 要作废（否则它会按「点到哪一格」再改一次选择、再挪一次针）。
     作废**只认坐标**：那一下永远发生在手势结束的那一点上，所以按「同一颗点 + 同一段时间」认，
     不按「这段时间里所有的 click」认 —— 后者会连用户在别处真点的那一下一起吞掉
     （刚拖完一段，去点轨名上的锁，那点下去没反应）。 */
  let suppUntil = 0;
  let suppAt = null;
  const sel = new Set();        // 'clip:xxx' / 'voice:xxx' / 'cap:xxx' / 'marker:xxx'
  let anchor = '';
  let focus = { track: 'image', kind: 'clip', id: '', lane: 0 };
  let panelOpen = false;
  let panelFilter = 'all';
  let panelQuery = '';
  let ctxInfo = null;           // 上下文菜单指向的那一条

  /* ---------------- 现读的几何与节点 ---------------- */
  const g = () => Timeline.geometry();
  const pps = () => Math.max(1, g().pps);
  const scroller = () => (host && host.querySelector('#tlScroll')) || null;
  const contentEl = () => (host && host.querySelector('#tlContent')) || null;
  const selText = v => (host ? host.querySelector(v) : null);
  const nodes = () => (host ? Array.prototype.slice.call(host.querySelectorAll('.tl-clip,.tl-voice,.tl-cap')) : []);
  const nodeOf = (kind, id) => {
    if (!host || !id) return null;
    const attrName = kind === 'clip' ? 'data-clip' : kind === 'voice' ? 'data-voice'
      : kind === 'cap' ? 'data-cap' : 'data-marker';
    const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(id)) : String(id);
    return host.querySelector(`[${attrName}="${escId}"]`);
  };

  /* DOM 上那一块 ↔ 数据里那一条：kind 只认 clip / voice / cap。 */
  function describeEl(el) {
    if (!el || !el.classList) return null;
    if (el.classList.contains('tl-clip')) return { kind: 'clip', id: el.getAttribute('data-clip') || '', track: 'image' };
    if (el.classList.contains('tl-voice')) return { kind: 'voice', id: el.getAttribute('data-voice') || '', track: 'voice' };
    if (el.classList.contains('tl-cap')) return { kind: 'cap', id: el.getAttribute('data-cap') || '', track: 'caption' };
    return null;
  }

  const laneOfEl = el => (el ? Math.max(0, Math.round(num(el.getAttribute('data-lane'), num(el.closest('.tl-lane') && el.closest('.tl-lane').getAttribute('data-lane'))))) : 0);

  function filmItemOf(kind, id, work) {
    const src = work || filmOf();
    const list = kind === 'clip' ? src.clips : kind === 'voice' ? src.voices
      : kind === 'cap' ? src.captions : src.markers;
    const found = (Array.isArray(list) ? list : []).find(x => x && x.id === id);
    return found || null;
  }
  const indexOfItem = (kind, id, work) => {
    const src = work || filmOf();
    const list = kind === 'clip' ? src.clips : kind === 'voice' ? src.voices
      : src.captions;
    return (Array.isArray(list) ? list : []).findIndex(x => x && x.id === id);
  };

  /* ---------------- 名称与历史描述 ---------------- */
  const shotsOf = () => (Array.isArray(shotLines && shotLines()) ? shotLines() : []);
  const shotName = id => { const s = shotsOf().find(x => x && x.id === id); return s ? (s.name || '镜头') : ''; };
  function clipTitle(clip) {
    if (!clip) return '画面段';
    const s = shotName(clip.shotId);
    return s || ctxClip(clip.name || (clip.kind === 'image' ? '图片' : '视频'), 14);
  }
  /* 「镜头一」第 2 段（3.2–8.0 秒）—— 历史里要点名到哪一镜的哪一段。 */
  function clipDesc(clip, start, end) {
    const sameShot = (filmOf().clips || []).filter(c => c && c.shotId === clip.shotId);
    const no = Math.max(1, sameShot.findIndex(c => c.id === clip.id) + 1);
    const name = clipTitle(clip);
    return `「${name}」第 ${no} 段（${fmtTenth(start)}–${fmtTenth(end)} 秒）`;
  }
  function timedLabel(item, kind) {
    const name = kind === 'clip' ? clipTitle(item)
      : ctxClip(String(item && item.text || (kind === 'cap' ? '字幕' : '配音')), 14);
    const start = num(item.start), end = kind === 'cap' ? num(item.end) : num(item.start) + num(item.duration);
    return `「${name}」（${fmtTenth(start)}–${fmtTenth(end)} 秒）`;
  }
  /* ---------------- 锁定 / 隐藏 ---------------- */
  /* 行号三档取法：描述符自己带的（DOM 上读到的，点在哪一行就是哪一行）> 节点 > 打包口径。
     存下来的 `item.lane` 只是偏好，落到第几行由打包说了算 —— 拿它判锁会锁错行。 */
  function laneLocked(d, el) {
    const f = filmOf();
    const lane = d.kind === 'clip'
      ? filmLaneOf(f, 'clip', d.id)
      : (Number.isInteger(d.lane) ? d.lane : (el ? laneOfEl(el) : filmLaneOf(f, d.kind, d.id)));
    if (lane < 0) return false;
    const track = d.kind === 'clip' ? 'image' : d.kind === 'cap' ? 'caption' : 'voice';
    return itemLocked(f.tracks, track, lane);
  }
  const rowKeyOf = (kind, lane) => (kind === 'clip' ? `image-${lane}` : kind === 'cap' ? `caption-${lane}` : `voice-${lane}`);
  function refuse(d) {
    const kind = d.kind === 'clip' ? 'clip' : d.kind === 'cap' ? 'cap' : 'voice';
    if (setStatus) setStatus(`${rowKeyOf(kind, Math.max(0, d.lane || 0))} 已锁定，先解锁再编辑`);
  }

  /* ---------------- 吸附 ---------------- */
  function snapPoints(excludeId, skipPlayhead) {
    const gg = g(); const f = filmOf();
    return collectTimelineSnapPoints({
      total: gg.total, playhead: Timeline.playhead(), rows: gg.tl.rows,
      voices: f.voices, captions: f.captions, markers: f.markers,
      exclude: { clipId: excludeId || '', itemId: excludeId || '', skipPlayhead: !!skipPlayhead },
    });
  }
  /* Alt = 旁路吸附（判据只在这一处）。 */
  function snapTime(t, excludeId, alt, skipPlayhead) {
    if (alt || !Timeline.snapOn()) { Timeline.hideSnap(); return Math.max(0, num(t)); }
    const hit = snapTimelineValue(t, snapPoints(excludeId, skipPlayhead), TL_SNAP_PX / pps());
    if (hit.snapped) Timeline.showSnap(hit.time, `吸附 ${fmtTenth(hit.time)}s`);
    else Timeline.hideSnap();
    return Math.max(0, hit.time);
  }

  /* ---------------- 落盘 ---------------- */
  function currentWork() {
    const f = filmOf();
    return {
      clips: (f.clips || []).slice(), voices: (f.voices || []).slice(),
      captions: (f.captions || []).slice(), markers: (f.markers || []).slice(), tracks: f.tracks,
    };
  }
  function writeFilm(next) {
    const f = filmOf();
    const clean = normalizeFilm(next);
    f.clips = clean.clips; f.voices = clean.voices;
    f.captions = clean.captions; f.markers = clean.markers; f.tracks = clean.tracks;
  }
  /* 波纹开着就把「边界之后的定时块」一起平移，回执里点名移动了几条、跳过了几条锁定。 */
  function commit(next, label, ripple) {
    let work = next;
    if (Timeline.rippleOn() && ripple && Math.abs(num(ripple.delta)) > 0.0005) {
      const r = applyTimelineRipple(work, ripple.boundary, ripple.delta);
      work = r.film;
      label += `（波纹：移动 ${r.moved}${r.skipped ? ' · 跳过锁定 ' + r.skipped : ''}）`;
    }
    if (!undoWindow) beginEdit(label);
    writeFilm(work);
    pruneSelection();
    if (!undoWindow) filmEdited();
    if (setStatus) setStatus(label);
    return true;
  }

  /* 别处（右栏那张卡、助手写入桥）改一份 film 的唯一出口：只交「改完的那几条」，
     标签由调用方给（历史要点名到哪一镜哪一段）。它和板上手势走的是同一个 commit ——
     于是撤销、波纹、落盘、重画只有一套，卡片自己不留第二份「我在改哪一段」的状态。 */
  function patchFilm(next, label, ripple) {
    return commit({ ...currentWork(), ...next }, label, ripple);
  }
  /* 一次动作要落好几笔（助手批量、一条字幕改三个字段）时，用这一对把中间那几笔罩起来：
     开窗时压一份快照，窗口里的 commit 不再各自压快照、也不重画，
     关窗时统一重画一次 —— 于是「一个动作」在历史里只有一条，撤销一次就回到动手之前。
     嵌套开窗只有最外层那份算数（内层直接返回 false），关窗必须配对，
     漏关会让用户自己的编辑一直不压快照。 */
  let undoWindow = null;
  function openUndoWindow(label) {
    if (undoWindow) return false;
    undoWindow = String(label || '编辑');
    beginEdit(undoWindow);
    return true;
  }
  function closeUndoWindow() {
    if (!undoWindow) return false;
    undoWindow = null;
    pruneSelection();
    filmEdited();
    return true;
  }
  /* 一条块的「点名」写法（历史与回执共用）：
       画面段 → 「镜头一」第 2 段（3.2–8.0 秒）；定时块 → 「那句话」（12.4–15.0 秒）。
     判据只在这一处：卡片写「把 X 的音量调到 120%」与轨道上拖把手写「把 X 改成 …」必须点同一个名。 */
  function describeItem(kind, id) {
    const w = currentWork();
    const it = filmItemOf(kind, id, w);
    if (!it) return '';
    if (kind !== 'clip') return timedLabel(it, kind);
    const row = deriveTimeline(w.clips).rows[indexOfItem('clip', id, w)];
    return clipDesc(it, num(row && row.start), num(row && row.end));
  }

  /* ---------------- 选择 ---------------- */
  function pruneSelection() {
    const f = filmOf();
    const live = new Set([
      ...(f.clips || []).map(c => selKey('clip', c.id)),
      ...(f.voices || []).map(v => selKey('voice', v.id)),
      ...(f.captions || []).map(c => selKey('cap', c.id)),
      ...(f.markers || []).map(m => selKey('marker', m.id)),
    ]);
    let changed = false;
    sel.forEach(k => { if (!live.has(k)) { sel.delete(k); changed = true; } });
    if (changed) paintSelection();
  }
  function paintSelection() {
    if (!host) return;
    nodes().forEach(el => {
      const d = describeEl(el);
      el.classList.toggle('is-selected', !!(d && sel.has(selKey(d.kind, d.id))));
    });
    Array.prototype.slice.call(host.querySelectorAll('[data-marker]')).forEach(el => {
      el.classList.toggle('is-selected', sel.has(selKey('marker', el.getAttribute('data-marker'))));
    });
    /* 选中数一变，工具条上「删除 / 复制 / 合并」的可点状态跟着变（就地刷，不整条重画）。 */
    if (Timeline.paintTimelineTools) Timeline.paintTimelineTools();
  }
  function setSel(keys, from) {
    sel.clear();
    keys.forEach(k => sel.add(k));
    anchor = keys[0] || '';
    if (from) focus = { track: from.track, kind: from.kind, id: from.id, lane: from.lane || 0 };
    paintSelection();
    /* 「此刻指着谁」变了：右栏那张卡（哪一档亮、卡上那几个数）跟着换 —— 判据只有焦点这一份，
       卡片自己不再存一份「我在改哪一段」，否则轨道与卡片迟早各说一件事。 */
    onFocus();
  }
  /* 从界面外面选中一条（右栏清单点一行 / 助手按 id 指哪一块）：与在轨道上点同一件事，
     走同一个 setSel —— 于是选择高亮、焦点与卡片全都跟着变，不是第二套状态。 */
  function selectItem(kind, id) {
    const it = filmItemOf(kind, id);
    if (!it) return false;
    const track = kind === 'clip' ? 'image' : kind === 'cap' ? 'caption' : kind === 'marker' ? 'markers' : 'voice';
    const lane = kind === 'marker' ? 0 : Math.max(0, filmLaneOf(filmOf(), kind, id));
    setSel([selKey(kind, id)], { kind, id, track, lane });
    return true;
  }
  const selectedByKind = kind => {
    const out = [];
    sel.forEach(k => { const i = k.indexOf(':'); if (k.slice(0, i) === kind) out.push(k.slice(i + 1)); });
    return out;
  };
  const selectedDescriptors = () => {
    const out = [];
    sel.forEach(k => {
      const i = k.indexOf(':'); const kind = k.slice(0, i); const id = k.slice(i + 1);
      if (kind === 'marker') return;
      const it = filmItemOf(kind, id);
      if (!it) return;
      /* 有节点就用节点上读到的行（打包后的行号）；没有节点（生成态里板是隐着的，助手仍会从桥上
         选中一块再剪）就按打包口径现算 —— 块在不在不取决于板画没画，判据也不该依赖 DOM。 */
      const el = nodeOf(kind, id);
      const track = kind === 'clip' ? 'image' : kind === 'cap' ? 'caption' : 'voice';
      out.push(el
        ? { kind, id, track: describeEl(el).track, lane: laneOfEl(el) }
        : { kind, id, track, lane: Math.max(0, filmLaneOf(filmOf(), kind, id)) });
    });
    return out;
  };

  /* pointerdown 里已经把选择定好了（左/右范围选、切点选中相邻两段、锁定行的加减选），
     紧接着浏览器还要发一次 click —— 那一下会走 onClickCapture 的「只留这一条」，
     刚选上的一排又缩回一枚。它与松手拖动那一发是同一颗点上的同一件事，借用同一个作废窗口。 */
  function eatClick() { suppUntil = Date.now() + CLICK_SUPPRESS_MS; }
  /* 作废判定：同一颗点（手势结束的那一点）+ 同一段时间。
     `element.click()` 与键盘触发的 click 坐标是 (0,0)，永远对不上这一点 —— 那两种是「真点了一下」。 */
  function clickSuppressed(e) {
    if (Date.now() >= suppUntil || !suppAt) return false;
    return Math.abs(e.clientX - suppAt.x) <= CLICK_SUPPRESS_PX && Math.abs(e.clientY - suppAt.y) <= CLICK_SUPPRESS_PX;
  }

  /* 点一下：Shift = 同轨范围，Ctrl/⌘ = 加删这一条，其余 = 只留这一条。 */
  function applyClickSelection(d, e) {
    const k = selKey(d.kind, d.id);
    if (e.shiftKey && anchor) {
      const same = sameTrackList(d).map(x => selKey(d.kind, x.id));
      const a = same.indexOf(anchor), b = same.indexOf(k);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSel(same.slice(lo, hi + 1), d);
        if (setStatus) setStatus(`已选择 ${hi - lo + 1} 个`);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (sel.has(k)) sel.delete(k); else sel.add(k);
      anchor = k;
      focus = { track: d.track, kind: d.kind, id: d.id, lane: d.lane || 0 };
      paintSelection();
      if (setStatus) setStatus(sel.size ? `已选择 ${sel.size} 个` : '已取消选择');
      return;
    }
    setSel([k], d);
  }

  /* 同轨的有序列表（范围选择用它数下标）。 */
  function sameTrackList(d) {
    const f = filmOf();
    if (d.kind === 'clip') return f.clips;
    if (d.kind === 'cap') return (f.captions || []).slice().sort((a, b) => num(a.start) - num(b.start));
    const list = f.voices;
    return (list || []).slice().sort((a, b) => num(a.start) - num(b.start));
  }

  /* 六档里的「向左 / 向右全选」：按点击那一格的边缘切。 */
  function rangeSelect(d, side) {
    const it = filmItemOf(d.kind, d.id);
    if (!it) return;
    const isClip = d.kind === 'clip';
    const rows = g().tl.rows;
    const at = isClip ? indexOfItem('clip', d.id) : 0;
    const start = isClip ? num(rows[at] && rows[at].start) : num(it.start);
    const end = isClip ? num(rows[at] && rows[at].end) : num(it.start) + num(it.duration);
    const keep = (isClip ? filmOf().clips : sameTrackList(d)).filter(x => {
      if (!x) return false;
      if (isClip) {
        const r = rows[filmOf().clips.findIndex(c => c && c.id === x.id)] || { start: 0, end: 0 };
        return side === 'left' ? r.start < start - 0.0005 : r.end > end + 0.0005;
      }
      return side === 'left' ? num(x.start) < start - 0.0005 : (num(x.start) + num(x.duration)) > end + 0.0005;
    });
    setSel(keep.map(x => selKey(d.kind, x.id)), d);
    eatClick();
    if (setStatus) setStatus(`已${side === 'left' ? '向左' : '向右'}选择 ${keep.length} 个`);
  }

  /* ---------------- 拖动框架 ---------------- */
  function beginDrag(e, spec) {
    if (drag) return false;
    e.preventDefault(); e.stopPropagation();
    drag = {
      spec, work: currentWork(), moved: false, excludeId: spec.excludeId || '',
      startX: e.clientX, startY: e.clientY, startTime: Timeline.timeAtClientX(e.clientX),
      lastX: e.clientX, lastY: e.clientY, alt: !!e.altKey, raf: 0, state: {},
    };
    drag.auto = createEdgeAutoScroll({ viewport: scroller, onScroll: () => pumpScroll() });
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    document.addEventListener('pointercancel', onDragUp);
    document.addEventListener('keydown', onDragKey);
    if (spec.onStart) spec.onStart(drag);
    return true;
  }
  const dxSec = () => (drag ? (drag.lastX - drag.startX) / pps() : 0);
  function pumpScroll() {
    if (!drag || drag.raf) return;
    drag.raf = window.requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      if (drag.spec.onMove) drag.spec.onMove(drag, { dx: dxSec(), time: Timeline.timeAtClientX(drag.lastX), y: drag.lastY, alt: drag.alt });
    });
  }
  function onDragMove(e) {
    if (!drag) return;
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.alt = !!e.altKey;
    if (!drag.moved && (Math.abs(e.clientX - drag.startX) > DRAG_PX || Math.abs(e.clientY - drag.startY) > DRAG_PX)) drag.moved = true;
    if (!drag.moved) return;
    if (Play && Play.playing && drag.spec.pauseOnDrag && Play.playing) Play.pause();
    pumpScroll();
    drag.auto.update(e.clientX);
  }
  function onDragUp() { endDrag(true); }
  function onDragKey(e) {
    if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); endDrag(false); }
  }
  function endDrag(doCommit) {
    const rec = drag;
    if (!rec) return;
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    document.removeEventListener('pointercancel', onDragUp);
    document.removeEventListener('keydown', onDragKey);
    if (rec.auto) rec.auto.stop();
    if (rec.raf) { window.cancelAnimationFrame(rec.raf); rec.raf = 0; }
    if (rec.ghost) { try { rec.ghost.remove(); } catch (e) { /* 浮层已经不在就不删 */ } rec.ghost = null; }
    if (rec.dragBoard) { rec.dragBoard.classList.remove('is-dragging'); rec.dragBoard = null; }
    if (rec.draggedIds && rec.draggedIds.length) {
      rec.draggedIds.forEach(id => { const n = nodeOf('clip', id); if (n) n.classList.remove('is-dragged'); });
      rec.draggedIds = null;
    }
    Timeline.hideSnap();
    dropHint(null);
    laneMark(null);
    if (rec.moved) { suppAt = { x: rec.lastX, y: rec.lastY }; eatClick(); }
    if (rec.moved && doCommit) {
      const changed = rec.spec.onCommit ? !!rec.spec.onCommit(rec) : false;
      if (!changed) Timeline.render();
    } else if (rec.moved) {
      Timeline.render();
      if (setStatus) setStatus('已取消这次拖动');
    } else if (rec.spec.onClick) rec.spec.onClick(rec);
  }
  const dragBusy = () => !!drag;

  /* 预览：只改节点上的 data-start / data-dur，再让 layoutBoard 现量现摆。 */
  function previewBox(d, start, dur) {
    const el = nodeOf(d.kind, d.id);
    if (!el) return;
    el.setAttribute('data-start', attr(start));
    el.setAttribute('data-dur', attr(Math.max(0.02, dur)));
    Timeline.layoutBoard();
  }
  function previewGroup(list) {
    list.forEach(x => previewBox(x.d, x.start, x.dur));
  }

  /* 落点提示：一条竖线 + 目标行高亮。 */
  function dropHint(time) {
    const c = contentEl();
    if (!c) return;
    let el = c.querySelector('.tl-drop');
    if (time == null) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'tl-drop'; c.appendChild(el); }
    el.style.left = Math.round(num(time) * pps()) + 'px';
  }
  let markedLane = null;
  function laneMark(el) {
    if (markedLane && markedLane !== el) markedLane.classList.remove('is-drop');
    markedLane = el || null;
    if (markedLane) markedLane.classList.add('is-drop');
  }

  /* 指针落在哪一行（按各行自己的矩形竖着找；落在整轨之下 = 新开一行）。 */
  function laneAtY(kind, clientY) {
    if (!host) return { lane: null, isNew: false };
    const trackSel = kind === 'clip' ? '.tl-track.is-image' : kind === 'cap' ? '.tl-track.is-caption' : '.tl-track.is-voice';
    const lanes = Array.prototype.slice.call((host.querySelector(trackSel) || { querySelectorAll: () => [] }).querySelectorAll(':scope > .tl-lane'));
    if (!lanes.length) return { lane: 0, isNew: false };
    for (let i = 0; i < lanes.length; i++) {
      const r = lanes[i].getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        laneMark(lanes[i]);
        return { lane: Math.max(0, Math.round(num(lanes[i].getAttribute('data-lane')))), isNew: false };
      }
    }
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    if (clientY > last.bottom) { laneMark(lanes[lanes.length - 1]); return { lane: null, isNew: true }; }
    laneMark(lanes[0]);
    return { lane: 0, isNew: false };
  }

  /* ---------------- 搓擦放针（轨道空处与刻度尺同一出口） ---------------- */
  function startScrub(e) {
    const sc = scroller();
    if (Play && Play.playing) Play.pause();
    if (sliceForgetFail) sliceForgetFail();      // 用户主动 seek = 明确的重试信号：取帧退避放行一次
    /* 拖针：**针立刻跟手**（setPlayhead 是纯视图），画面按 ~40ms 一档追。
       以前每次 pointermove（60–120Hz）都 `video.currentTime = t`：每一次都会把在途的那次
       seek 取消掉，解码永远追不上指针 —— 看起来就是「拖的时候画面一顿一顿、跟不上」。
       松手（onCommit）补一次精确 seek，最终落点仍是逐帧准的。 */
    let pending = -1, timer = 0;
    const seekNow = t => { if (Play && Play.seek) Play.seek(t); else Timeline.setPlayhead(t, { force: true }); };
    const flushSeek = () => {
      if (timer) { window.clearTimeout(timer); timer = 0; }
      if (pending < 0) return;
      const t = pending; pending = -1;
      seekNow(t);
    };
    const scheduleSeek = () => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = 0; if (pending >= 0) { const t = pending; pending = -1; seekNow(t); } }, 40);
    };
    const spec = {
      excludeId: '', pauseOnDrag: false,
      onMove(rec, p) {
        const t = snapTime(p.time, '', p.alt, true);
        Timeline.setPlayhead(t, { force: true, follow: true });
        pending = t;
        scheduleSeek();
        if (sc) sc.focus({ preventScroll: true });
      },
      onClick(rec) {
        const t = snapTime(rec.startTime, '', rec.alt, true);
        Timeline.setPlayhead(t, { force: true });
        seekNow(t);
      },
      onCommit() { flushSeek(); return false; },
    };
    beginDrag(e, spec);
    if (e.button === 0) {
      const t = snapTime(Timeline.timeAtClientX(e.clientX), '', e.altKey, true);
      Timeline.setPlayhead(t, { force: true });
      seekNow(t);
    }
  }

  /* ---------------- 裁边 ---------------- */
  function startTrim(e, el, d, side) {
    const it = filmItemOf(d.kind, d.id);
    if (!it) return;
    if (laneLocked(d, el)) { refuse({ ...d, lane: laneOfEl(el) }); return; }
    if (Play && Play.playing) Play.pause();
    const gg = g();
    const isClip = d.kind === 'clip';
    const row = isClip ? gg.tl.rows[indexOfItem('clip', d.id)] : null;
    const oldStart = isClip ? num(row && row.start) : num(it.start);
    const oldEnd = isClip ? num(row && row.end) : (d.kind === 'cap' ? num(it.end) : num(it.start) + num(it.duration));
    const oldDur = Math.max(0, oldEnd - oldStart);
    const grab = Timeline.timeAtClientX(e.clientX);
    let live = { start: oldStart, end: oldEnd };

    const trimOne = (delta, alt) => {
      const edge = side === 'start'
        ? snapTime(oldStart + delta, d.id, alt)
        : snapTime(oldEnd + delta, d.id, alt);
      const dd = side === 'start' ? edge - oldStart : edge - oldEnd;
      /* 画面段的左缘走到这里的只有**第一段**（切点上那一只走的是编辑点 roll，见 onPointerDownCapture）：
         没有左邻可吸收变化，左缘动 = 段前 gap 开出来，右缘照样钉死（trimClipLeftAnchored）。
         其余（右缘 / 配音 / 字幕）照旧。 */
      const next = isClip && side === 'start' ? trimClipLeftAnchored(it, dd)
        : isClip ? trimClipRight(it, dd)
          : d.kind === 'cap' ? (side === 'start' ? trimCaptionLeft : trimCaptionRight)
            : (side === 'start' ? trimVoiceLeft : trimVoiceRight);
      if (!next) { live = { start: oldStart, end: oldEnd }; return null; }
      if (isClip) {
        const nrows = deriveTimeline(applyClipAt(gg.tl.rows.length, indexOfItem('clip', d.id), next, drag ? drag.work.clips : filmOf().clips)).rows;
        const nr = nrows[indexOfItem('clip', d.id)];
        live = { start: num(nr && nr.start), end: num(nr && nr.end) };
        return { next, start: live.start, dur: Math.max(0.02, live.end - live.start) };
      }
      live = { start: num(next.start), end: d.kind === 'cap' ? num(next.end) : num(next.start) + num(next.duration) };
      return { next, start: live.start, dur: Math.max(0.02, live.end - live.start) };
    };

    if (!beginDrag(e, {
      excludeId: d.id,
      pauseOnDrag: true,
      onMove(rec, p) {
        const r = trimOne(p.dx, p.alt);
        if (!r) { previewBox(d, oldStart, oldDur); setHint(`已到最短 ${fmtTenth(oldEnd - oldStart)}s`); return; }
        previewBox(r.start === live.start ? d : d, r.start, r.dur);
        Timeline.stripRefresh();
        setHint(side === 'start' ? `起 ${fmtTenth(live.start)}s · 长 ${fmtTenth(live.end - live.start)}s` : `止 ${fmtTenth(live.end)}s · 长 ${fmtTenth(live.end - live.start)}s`);
      },
      onClick() { setSel([selKey(d.kind, d.id)], d); },
      onCommit(rec) {
        const r = trimOne((rec.lastX - rec.startX) / pps(), rec.alt);
        if (!r) return false;
        const w = rec.work;
        const label = `${isClip ? clipDesc(it, oldStart, oldEnd) : timedLabel(it, d.kind)}改成 ${fmtTenth(live.start)}–${fmtTenth(live.end)} 秒`;
        const next = listWith(w, d.kind, indexOfList(w, d.kind, d.id), r.next);
        /* 只有画面段的右缘动的是「边界」：边界之后的定时块按波纹走（波纹开着才带）。
           左缘是 end 锚定，不动边界（第一段的左缘动的是段前 gap，同样不碰边界）。 */
        const ripple = isClip && side === 'end' && Timeline.rippleOn()
          ? { boundary: oldEnd, delta: rippleDeltaOf(oldEnd, live.end) } : null;
        return commit(next, label, ripple);
      },
    })) return;
    setHint(side === 'start' ? `起 ${fmtTenth(oldStart)}s` : `止 ${fmtTenth(oldEnd)}s`);
  }
  const setHint = txt => { const el = selText('#tlHint'); if (el) el.textContent = txt; };

  /* 把一份数组里第 index 条换成 next（不改变别的条目）。 */
  const listKey = kind => (kind === 'clip' ? 'clips' : kind === 'voice' ? 'voices' : 'captions');
  const indexOfList = (w, kind, id) => (w[listKey(kind)] || []).findIndex(x => x && x.id === id);
  function listWith(w, kind, index, next) {
    const k = listKey(kind);
    const out = { ...w };
    out[k] = (w[k] || []).map((x, i) => (i === index ? next : x));
    return out;
  }
  /* 预览重排后的画面段（用临时 clips 数组算出新 start）。 */
  function applyClipAt(count, index, clip, source) {
    const list = (source || []).slice();
    list[index] = clip;
    return list;
  }

  /* ---------------- 切点（编辑点模式） ---------------- */
  function startBoundary(e, d, el, boundaryIndex) {
    if (laneLocked(d, el)) { refuse(d); return; }
    if (Play && Play.playing) Play.pause();
    const w0 = filmOf().clips;
    const left = w0[boundaryIndex - 1], right = w0[boundaryIndex];
    if (!left || !right) return;
    const rows = g().tl.rows;
    const edge = num(rows[boundaryIndex - 1] && rows[boundaryIndex - 1].end);
    if (!beginDrag(e, {
      excludeId: right.id,
      pauseOnDrag: true,
      onMove(rec, p) {
        const t = snapTime(rec.startTime + p.dx, right.id, p.alt);
        const delta = t - edge;
        const r = rollClipsBoundary(w0, boundaryIndex, delta);
        const nr = deriveTimeline(r.clips).rows;
        previewGroup([
          { d: { kind: 'clip', id: left.id }, start: num(nr[boundaryIndex - 1].start), dur: num(nr[boundaryIndex - 1].end) - num(nr[boundaryIndex - 1].start) },
          { d: { kind: 'clip', id: right.id }, start: num(nr[boundaryIndex].start), dur: num(nr[boundaryIndex].end) - num(nr[boundaryIndex].start) },
        ]);
        Timeline.stripRefresh();
        setHint(`切点 ${fmtTenth(num(nr[boundaryIndex - 1].end))}s`);
      },
      onClick() { setSel([selKey('clip', left.id), selKey('clip', right.id)], { kind: 'clip', id: right.id, track: 'image' }); eatClick(); },
      onCommit(rec) {
        const t = snapTime(rec.startTime + (rec.lastX - rec.startX) / pps(), right.id, rec.alt);
        const r = rollClipsBoundary(w0, boundaryIndex, t - edge);
        if (!r.delta) return false;
        const nr = deriveTimeline(r.clips).rows;
        return commit({ ...rec.work, clips: r.clips },
          `移动「${clipTitle(left)}」/「${clipTitle(right)}」之间的切点到 ${fmtTenth(num(nr[boundaryIndex - 1].end))} 秒`);
      },
    })) return;
  }

  /* ---------------- 块上的拖动（六档工具在这里分派） ---------------- */
  function startBlock(e, el) {
    const d = describeEl(el);
    if (!d) return;
    const it = filmItemOf(d.kind, d.id);
    if (!it) return;
    d.lane = laneOfEl(el);
    const mode = Timeline.mode();
    const locked = laneLocked(d, el);
    if (locked && mode === 'select') { applyClickSelection(d, e); eatClick(); refuse(d); return; }

    if (mode === 'left' || mode === 'right') { rangeSelect(d, mode); return; }
    if (mode === 'edit-point' && d.kind === 'clip') {
      const r = el.getBoundingClientRect();
      const idx = indexOfItem('clip', d.id);
      const boundary = e.clientX < r.left + r.width / 2 ? idx : idx + 1;
      startBoundary(e, d, el, boundary);
      return;
    }
    if (mode === 'slip' && d.kind === 'clip') { startSlip(e, d, el); return; }
    if (mode === 'slide' && d.kind === 'clip') { startSlide(e, d, el); return; }
    if ((mode === 'slip' || mode === 'slide') && d.kind !== 'clip') {
      if (setStatus) setStatus(`${mode === 'slip' ? '滑移' : '滑动'}只作用于画面段`);
      /* 紧接着浏览器还要发一次 click —— 不作废的话那句照实说的「只作用于画面段」
         会被 onClickCapture 里「这一块配音身上挂着 N 条字幕」盖掉（说了一半的话）。 */
      eatClick();
    }
    startMove(e, d, el);
  }

  /* 滑移：块不动，画面窗口在段内前后挪。 */
  function startSlip(e, d, el) {
    const it = filmItemOf('clip', d.id);
    if (!it) return;
    if (laneLocked(d, el)) { refuse(d); return; }
    if (it.kind === 'image') { if (setStatus) setStatus('图片段没有源窗口，滑移无从谈起'); eatClick(); return; }
    const old = num(it.sourceStart);
    let cur = old;
    if (!beginDrag(e, {
      excludeId: d.id,
      onMove(rec, p) {
        const r = slipClip(it, p.dx);
        cur = num(r.clip.sourceStart);
        Timeline.stripRefresh();
        setHint(`源窗口 ${fmtTenth(cur)}s 起`);
      },
      onClick() { setSel([selKey('clip', d.id)], d); },
      onCommit(rec) {
        const r = slipClip(it, (rec.lastX - rec.startX) / pps());
        if (!r.delta) return false;
        return commit({ ...rec.work, clips: rec.work.clips.map(c => (c.id === d.id ? r.clip : c)) },
          `把${clipDesc(it, num(g().tl.rows[indexOfItem('clip', d.id)].start), num(g().tl.rows[indexOfItem('clip', d.id)].end))}的画面窗口滑到源 ${fmtTenth(cur)}s 起`);
      },
    })) return;
    setHint(`源窗口 ${fmtTenth(old)}s 起`);
  }

  /* 滑动：这一段前后挪、时长不变，左右两段的编辑点跟着伸缩。 */
  function startSlide(e, d, el) {
    const idx = indexOfItem('clip', d.id);
    const clips = filmOf().clips;
    if (idx <= 0 || idx >= clips.length - 1) {
      if (setStatus) setStatus('首尾两段没有两侧邻居，滑不动');
      eatClick();
      return;
    }
    if (laneLocked(d, el)) { refuse(d); return; }
    const rows = g().tl.rows;
    if (!beginDrag(e, {
      excludeId: d.id,
      onMove(rec, p) {
        const r = slideClip(clips, idx, p.dx);
        paintRows(r.clips, [idx - 1, idx, idx + 1]);
        Timeline.stripRefresh();
        setHint(`滑动 ${fmtTenth(p.dx)}s`);
      },
      onClick() { setSel([selKey('clip', d.id)], d); },
      onCommit(rec) {
        const r = slideClip(clips, idx, (rec.lastX - rec.startX) / pps());
        if (!r.delta) return false;
        const nr = deriveTimeline(r.clips).rows;
        return commit({ ...rec.work, clips: r.clips },
          `把${clipDesc(clips[idx], num(rows[idx].start), num(rows[idx].end))}滑动 ${r.delta > 0 ? '+' : ''}${fmtTenth(r.delta)} 秒（相邻两段跟着伸缩）`);
      },
    })) return;
    function paintRows(list, picks) {
      const nr = deriveTimeline(list).rows;
      previewGroup(picks.filter(i => nr[i]).map(i => ({
        d: { kind: 'clip', id: list[i].id }, start: num(nr[i].start), dur: num(nr[i].end) - num(nr[i].start),
      })));
    }
  }

  /* 挪位置 / 换行 / 换序 —— select 档的主拖动。 */
  function startMove(e, d, el) {
    const group = sel.size > 1 && sel.has(selKey(d.kind, d.id))
      ? selectedDescriptors().filter(x => x.track === d.track)
      : [d];
    if (!group.length) group.push(d);
    if (group.length === 1 && (e.ctrlKey || e.metaKey || e.shiftKey)) { applyClickSelection(d, e); eatClick(); }
    const isClip = d.kind === 'clip';
    const oldRows = g().tl.rows;
    const originals = group.map(x => {
      const it = filmItemOf(x.kind, x.id);
      const idx = indexOfItem(x.kind, x.id);
      const start = isClip ? num(oldRows[idx] && oldRows[idx].start) : num(it.start);
      const dur = isClip ? num(oldRows[idx] && oldRows[idx].end) - start : (x.kind === 'cap' ? num(it.end) - num(it.start) : num(it.duration));
      return { ...x, it, idx, start, dur, lane: isClip ? num(it.ln) : x.lane };
    });
    if (Play && Play.playing) Play.pause();

    if (!beginDrag(e, {
      excludeId: d.id,
      pauseOnDrag: true,
      /* 拖动浮层：用户点名「拖动轨道片段没有预览图」——
         pointer 手势没有原生 drag ghost，这里自己挂一条跟着手指的胶片条。 */
      onStart(rec) {
        if (!isClip) return;
        const el = nodeOf('clip', d.id);
        const page = host && host.closest ? host.closest('.director-page') : null;
        if (!el || !page) return;
        const ghost = document.createElement('div');
        ghost.className = 'tl-drag-ghost';
        const strip = el.querySelector('.tl-strip');
        ghost.innerHTML = strip ? strip.outerHTML : '<i class="ph"></i>';
        /* 磁带格的宽度是板上的一枚局部变量（`--cell`），浮层不在板上，继承不到 —— 现读一份带过来。 */
        if (strip) {
          const cell = window.getComputedStyle(strip).getPropertyValue('--cell').trim();
          if (cell) ghost.style.setProperty('--cell', cell);
        }
        ghost.style.width = Math.round(Math.min(220, Math.max(120, el.getBoundingClientRect().width))) + 'px';
        page.appendChild(ghost);
        rec.ghost = ghost;
        rec.draggedIds = originals.map(o => o.id);
        originals.forEach(o => { const n = nodeOf('clip', o.id); if (n) n.classList.add('is-dragged'); });
        /* 类挂在**板根**上（`#tlBoard`）：被重画的是 `#tlBoardBody`，拖动的过渡要罩住整块板。 */
        const boardEl = host && host.closest ? host.closest('.tl-board') : null;
        if (boardEl) { boardEl.classList.add('is-dragging'); rec.dragBoard = boardEl; }
        rec.ghostMove = (x, y) => {
          ghost.style.left = Math.round(x + 14) + 'px';
          ghost.style.top = Math.round(y - 34) + 'px';
        };
        rec.ghostMove(e.clientX, e.clientY);
      },
      onMove(rec, p) {
        if (isClip) clipMovePreview(rec, p, originals, d);
        else timedMovePreview(rec, p, originals, d);
      },
      onCommit(rec) {
        if (isClip) return clipMoveCommit(rec, originals, d);
        return timedMoveCommit(rec, originals, d);
      },
    })) return;
  }

  /* 画面段：横着拖 = 换序（落点按「中点在指针之前」数出来），竖着拖 = 换行。 */
  /* 画面段：横着拖 = 换序 / 留空（落点按「中点在指针之前」数出来），竖着拖 = 换行。
     被拖的那一组**钉在指针那一秒**；后面的段按换序后的座位让开（挤开效果），
     组前面空出来的那截就是 gap —— 片段之间允许有空。
     波纹关（默认）：只挪被拖的组 —— 落点被前后邻居顶住就夹在洞里，不换序、不推后面的段。 */
  function clipMovePreview(rec, p, originals, d) {
    /* 落点按**位移**算：块跟着手走。拿指针此刻的秒当落点，捏住块的中部一动手就会
       整块弹到指针底下（跳一个身位），吸附也就成了「吸到手指边」而不是「吸到块边」。 */
    const t = snapTime(originals[0].start + p.dx, d.id, p.alt);
    const target = laneAtY('clip', p.y);
    const lane = target.isNew ? newLaneBelow(originals.map(o => ({ lane: o.lane }))) : target.lane;
    const ids = originals.map(o => o.id);
    if (Timeline.rippleOn()) {
      const rows = g().tl.rows.map((r, i) => ({ ...r, ln: (originals[i] && originals[i].lane) || 0 }));
      const drop = dropIndexAt(rows, t, originals[0] ? originals[0].idx : -1);
      rec.state = { time: t, drop, lane, isNew: target.isNew };
      dropHint(t);
      if (rec.ghostMove) rec.ghostMove(rec.lastX, rec.lastY);
      /* 换序（落点跨过了别的段的中点）= 「挪到那儿」，落地紧贴；
         落点没变、只是往右拖出去 = 「这儿留一段空」。 */
      const laid = layoutClipMove(groupReorder(rec.work.clips, ids, drop), ids, t, drop === originals[0].idx);
      previewGroup(originals.map(o => {
        const i = laid.rows.findIndex(r => r.clip.id === o.id);
        return { d: { kind: 'clip', id: o.id }, start: i >= 0 ? num(laid.rows[i].start) : o.start, dur: o.dur };
      }));
      const gapNote = laid.gap > 0.001 ? ` · 前面空 ${round2(laid.gap)}s` : '';
      setHint((target.isNew ? '松手就在下面新建一行' : `放到第 ${(rec.state.lane || 0) + 1} 行 · 第 ${drop + 1} 段`) + gapNote);
      return;
    }
    const laid = placeClipGroupStill(rec.work.clips, ids, t);
    rec.state = { time: laid.start, lane, isNew: target.isNew, still: true, contiguous: !laid.why, clamped: laid.clamped || '' };
    dropHint(laid.why ? t : laid.start);
    if (rec.ghostMove) rec.ghostMove(rec.lastX, rec.lastY);
    if (!laid.why) {
      const rows = deriveTimeline(laid.clips).rows;
      previewGroup(originals.map(o => {
        const i = rows.findIndex(r => r.clip.id === o.id);
        return { d: { kind: 'clip', id: o.id }, start: i >= 0 ? num(rows[i].start) : o.start, dur: o.dur };
      }));
    }
    const laneNote = target.isNew ? '松手就在下面新建一行' : `放到第 ${(lane || 0) + 1} 行`;
    const stillNote = laid.why === 'non-contiguous' ? ' · 多选的段不相邻，波纹关着不挪'
      : laid.clamped === 'prev' ? ' · 顶住前一段'
        : laid.clamped === 'next' ? ' · 顶住后一段'
          : laid.gapBefore > 0.001 ? ` · 前面空 ${round2(laid.gapBefore)}s（后续段不动）` : '';
    setHint(laneNote + stillNote);
  }
  /* 换序之后的落点：被拖的那一组从**指针那一秒**开始（被上一段顶住就贴住上一段末尾），
     它们前面空出来的那截记进第一块的 gap。返回 { list, rows, gap }。 */
  function layoutClipMove(clips, ids, desired, allowGap) {
    const list = (clips || []).map(c => ({ ...c }));
    const first = list.findIndex(c => c && c.id === ids[0]);
    if (first < 0) return { list, rows: deriveTimeline(list).rows, gap: 0 };
    const prevEnd = first > 0 ? deriveTimeline(list.slice(0, first)).total : 0;
    const want = allowGap ? round2(Math.max(0, num(desired))) : prevEnd;
    const start = Math.max(prevEnd, want);
    ids.forEach((id, k) => {
      const at = list.findIndex(c => c && c.id === id);
      if (at < 0) return;
      list[at].gap = k === 0 ? round2(Math.max(0, start - prevEnd)) : 0;
    });
    return { list, rows: deriveTimeline(list).rows, gap: round2(Math.max(0, start - prevEnd)) };
  }
  function clipMoveCommit(rec, originals, d) {
    const st = rec.state;
    if (!st) return false;
    /* 波纹关：只挪被拖的组（placeClipGroupStill 把后邻钉回原位），不换序、不推后面的段。 */
    if (st.still) {
      if (!st.contiguous) { if (setStatus) setStatus('多选的段不相邻：波纹关着不挪（开波纹后再拖，或先把它们排成相邻）'); return false; }
      const ids = originals.map(o => o.id);
      const laid = placeClipGroupStill(rec.work.clips, ids, st.time);
      let clips = laid.clips;
      const laneChanged = originals.filter(o => o.lane !== st.lane);
      if (laneChanged.length) {
        laneChanged.forEach(o => { clips = moveClipToLane(clips, o.id, st.lane).clips; });
        /* 行号是「用到的行」连续编出来的：搬走一行的全部段之后，中间那行不能留成空洞。 */
        const packed = compactLanes(clips.map(c => ({ ...c, lane: num(c.ln) })));
        clips = packed.items.map((c, i) => ({ ...clips[i], ln: Math.max(0, Math.round(num(c.lane))) }));
      }
      const nr = deriveTimeline(clips).rows;
      const startAt = id => {
        const i = nr.findIndex(r => r.clip.id === id);
        return i >= 0 ? num(nr[i].start) : -1;
      };
      const movedOnes = originals.filter(o => Math.abs(startAt(o.id) - o.start) > 0.001);
      const gapBefore = originals.length ? Math.max(0, num(originals[0].it.gap)) : 0;
      if (!movedOnes.length && !laneChanged.length && Math.abs(gapBefore - laid.gapBefore) < 0.001) return false;
      const laneNote = `挪到第 ${st.lane + 1} 行${st.isNew ? '（新开的一行）' : ''}`;
      const clampNote = st.clamped === 'prev' ? '，贴住前一段'
        : st.clamped === 'next' ? '，贴住后一段'
          : laid.gapBefore > 0.001 ? `，前面留出 ${round2(laid.gapBefore)}s 空（后续段不动）` : '';
      const label = !movedOnes.length
        ? `把${clipDesc(originals[0].it, originals[0].start, originals[0].start + originals[0].dur)}${laneNote}`
        : `把「${clipTitle(originals[0].it)}」换位置：${movedOnes.map(o => `「${clipTitle(o.it)}」从 ${fmtTenth(o.start)}s 挪到 ${fmtTenth(startAt(o.id))}s`).join('、')}`
          + clampNote + (laneChanged.length ? `，并${laneNote}` : '');
      return commit({ ...rec.work, clips }, label);
    }
    const ids = originals.map(o => o.id);
    const laid = layoutClipMove(groupReorder(rec.work.clips, ids, st.drop), ids, st.time, st.drop === originals[0].idx);
    let clips = laid.list;
    const laneChanged = originals.filter(o => o.lane !== st.lane);
    if (laneChanged.length) {
      laneChanged.forEach(o => { clips = moveClipToLane(clips, o.id, st.lane).clips; });
      /* 行号是「用到的行」连续编出来的：搬走一行的全部段之后，中间那行不能留成空洞。 */
      const packed = compactLanes(clips.map(c => ({ ...c, lane: num(c.ln) })));
      clips = packed.items.map((c, i) => ({ ...clips[i], ln: Math.max(0, Math.round(num(c.lane))) }));
    }
    const nr = deriveTimeline(clips).rows;
    const startAt = id => {
      const i = nr.findIndex(r => r.clip.id === id);
      return i >= 0 ? num(nr[i].start) : -1;
    };
    const movedOnes = originals.filter(o => Math.abs(startAt(o.id) - o.start) > 0.001);
    const gapBefore = originals.length ? Math.max(0, num(originals[0].it.gap)) : 0;
    if (!movedOnes.length && !laneChanged.length && Math.abs(gapBefore - laid.gap) < 0.001) return false;
    const laneNote = `挪到第 ${st.lane + 1} 行${st.isNew ? '（新开的一行）' : ''}`;
    const gapNote = laid.gap > 0.001 ? `，前面留出 ${round2(laid.gap)}s 空` : '';
    /* 只换行、顺序没动：说「从 9.0s 挪到 9.0s」是废话，但段号与起止还得留着（历史里要点名是哪一段）。 */
    const label = !movedOnes.length
      ? `把${clipDesc(originals[0].it, originals[0].start, originals[0].start + originals[0].dur)}${laneNote}`
      : `把「${clipTitle(originals[0].it)}」换位置：${movedOnes.map(o => `「${clipTitle(o.it)}」从 ${fmtTenth(o.start)}s 挪到 ${fmtTenth(startAt(o.id))}s`).join('、')}`
        + gapNote + (laneChanged.length ? `，并${laneNote}` : '');
    return commit({ ...rec.work, clips }, label);
  }
  /* 组内保持相对顺序整体搬到 dest。 */
  function groupReorder(clips, ids, dest) {
    const list = (clips || []).slice();
    const picked = list.filter(c => c && ids.includes(c.id));
    if (picked.length !== ids.length) {
      const first = list.findIndex(c => c && c.id === ids[0]);
      if (first < 0) return list;
      return reorderClips(list, first, Math.min(Math.max(0, dest), list.length - 1)).clips;
    }
    const rest = list.filter(c => c && !ids.includes(c.id));
    const at = Math.max(0, Math.min(dest, rest.length));
    return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
  }

  /* 配音 / 字幕：横着拖 = 改出现时刻，竖着拖 = 换行（字幕的行由重叠自动排）。 */
  function timedMovePreview(rec, p, originals, d) {
    const t = snapTime(originals[0].start + p.dx, d.id, p.alt);
    const applied = t - originals[0].start;
    const shifted = shiftGroupStart(originals.map(o => o.start), applied, 0);
    const target = d.kind === 'cap' ? { lane: originals[0].lane, isNew: false } : laneAtY(d.kind, p.y);
    const lane = target.isNew ? newLaneBelow(timedAll(rec.work).map(x => ({ lane: num(x.lane) }))) : target.lane;
    rec.state = { starts: shifted.starts, delta: shifted.delta, lane, isNew: target.isNew };
    dropHint(t);
    previewGroup(originals.map((o, i) => ({ d: o, start: num(shifted.starts[i]), dur: o.dur })));
    setHint(target.isNew && d.kind !== 'cap' ? '松手就在下面新建一行' : `${fmtTenth(t)}s 起 · 移动 ${fmtTenth(shifted.delta)}s`);
  }
  const timedAll = w => (w.voices || []);
  function timedMoveCommit(rec, originals, d) {
    const st = rec.state;
    if (!st || !st.delta) {
      if (st && st.lane != null && d.kind !== 'cap') return laneOnlyCommit(rec, originals, d, st);
      return false;
    }
    const w = rec.work;
    let voices = w.voices.slice();
    let captions = w.captions.slice();
    const ids = originals.map(o => o.id);
    originals.forEach((o, i) => {
      const next = { ...o.it, start: round2(Math.max(0, num(st.starts[i]))) };
      if (o.kind === 'voice') voices = voices.map(v => (v.id === o.id ? next : v));
      else {
        const dur = o.dur;
        captions = captions.map(c => (c.id === o.id ? { ...c, start: round2(Math.max(0, num(st.starts[i]))), end: round2(Math.max(0, num(st.starts[i])) + dur) } : c));
        return;
      }
      /* 挂在这一条上的字幕跟着走（只跟着改起点位移）。 */
      captions = followCaptions(captions, o.id, o.it, next);
    });
    const from = originals.map(o => fmtTenth(o.start)).join('、');
    const to = originals.map((o, i) => fmtTenth(num(st.starts[i]))).join('、');
    const moved = ids.length === 1 ? `把${timedLabel(originals[0].it, d.kind)}从 ${fmtTenth(originals[0].start)} 秒挪到 ${fmtTenth(num(st.starts[0]))} 秒`
      : `整组移动 ${fmtTenth(st.delta)} 秒（${ids.length} 条：${from} → ${to}）`;
    return commit({ ...w, voices, captions }, moved, null);
  }
  function laneOnlyCommit(rec, originals, d, st) {
    const w = rec.work;
    const ids = originals.map(o => o.id);
    const withLane = (w.voices || []).map(x => {
      return { ...x, lane: ids.includes(x.id) ? st.lane : num(x.lane) };
    });
    const moved = moveTimedToLane(withLane, originals[0].id, st.lane);
    if (!moved.moved) return false;
    const laneById = new Map();
    compactLanes(moved.items).items.forEach(x => {
      laneById.set(x.id, Math.max(0, Math.round(num(x.lane))));
    });
    const numberLanes = list => (list || []).map(x => {
      if (!laneById.has(x.id)) return x;
      return { ...x, lane: laneById.get(x.id) };
    });
    return commit({ ...w, voices: numberLanes(w.voices) },
      `把${timedLabel(originals[0].it, d.kind)}挪到第 ${st.lane + 1} 行${st.isNew ? '（新开的一行）' : ''}`);
  }

  /* ---------------- 标记的拖动（头 / 带 / 尾） ---------------- */
  function markerById(id) { return (filmOf().markers || []).find(m => m && m.id === id) || null; }
  function startMarker(e, el, part) {
    const id = el.getAttribute(part === 'move' ? 'data-band' : 'data-marker') || el.getAttribute('data-band-tail');
    const m = markerById(id);
    if (!m) return;
    const range = markerRangeOf(m);
    const grab = Timeline.timeAtClientX(e.clientX);
    let live = { start: range.start, end: range.end };
    if (!beginDrag(e, {
      excludeId: '',
      pauseOnDrag: true,
      onMove(rec, p) {
        const t = round2(snapTime(p.time, '', p.alt));
        live = part === 'time' ? { start: t, end: Math.max(t, live.end) }
          : part === 'endTime' ? { start: range.start, end: Math.max(range.start + 0.05, t) }
            : { start: round2(Math.max(0, range.start + p.dx)), end: round2(Math.max(0.05, range.end + p.dx)) };
        const node = nodeOf('marker', id);
        if (node) node.setAttribute('data-time', attr(live.start));
        const band = host.querySelector(`[data-band="${cssId(id)}"]`);
        if (band) { band.setAttribute('data-start', attr(live.start)); band.setAttribute('data-dur', attr(Math.max(0, live.end - live.start))); }
        Timeline.layoutBoard();
        setHint(`${markerClock(live.start)}${m.type === 'range' ? ' – ' + markerClock(live.end) : ''}`);
      },
      onClick() {
        setSel([selKey('marker', id)], { kind: 'marker', id, track: 'markers' });
      },
      onCommit(rec) {
        const t = snapTime(Timeline.timeAtClientX(rec.lastX), '', rec.alt);
        live = part === 'time' ? { start: t, end: Math.max(t, range.end) }
          : part === 'endTime' ? { start: range.start, end: Math.max(range.start + 0.05, t) }
            : { start: Math.max(0, range.start + (rec.lastX - rec.startX) / pps()), end: Math.max(0.05, range.end + (rec.lastX - rec.startX) / pps()) };
        if (!rec.moved) return false;
        const next = createMarker({ ...m, time: live.start, endTime: live.end });
        /* 留痕与即时读数报的是**落定之后**那一对秒数（createMarker 把拖出来的浮点夹到 0.01）：
           原始读数 12.999999 直接进钟面会写成「00:00:12.1000」那种鬼话。 */
        const landed = markerRangeOf(next);
        const typeZh = MARKER_TYPE_ZH[m.type] || '标记';
        /* 三种拖法说的是三件事：拎块体 = 整段挪（起止一起动）、拎头 = 只有起点动、拎尾 = 只有止点动。
           后两种照写「从 X 挪到 X」就是把没动的数报成动了。 */
        const label = part === 'endTime'
          ? `把${typeZh}的止点从 ${markerClock(range.end)} 挪到 ${markerClock(landed.end)}`
          : `把${typeZh}从 ${markerClock(range.start)} 挪到 ${markerClock(landed.start)}${m.type === 'range' ? `（止 ${markerClock(landed.end)}）` : ''}`;
        return commit({ ...rec.work, markers: rec.work.markers.map(x => (x.id === id ? next : x)) }, label);
      },
    })) return;
    setHint(markerClock(range.start));
    /* 拖动之前先让 Timeline 的「点标记跳针」不抢：只有没真的拖起来才跳。 */
    e.stopPropagation();
  }
  const cssId = id => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(id)) : String(id));

  /* ---------------- 上下文菜单 ---------------- */
  function closeCtx() {
    const el = board ? board.querySelector('#tlCtx') : null;
    if (el) el.remove();
    ctxInfo = null;
  }
  function openCtx(e, d, id) {
    closeCtx();
    ctxInfo = { d, id };
    const items = [];
    if (!d || d.kind === 'clip') {
      items.push(['cut', '在播放头处切开'], ['duplicate', '复制这一段'], ['merge', '与下一段融合'],
        ['add-seg', '在这里新增一段'], ['delete', '删除这一段']);
      /* 转场入口的第二条路（菱形骑在行顶那条带子上，找不着的时候右键一定找得着）：
         指着哪一段就开它身上的缝 —— 有左邻开左缝，首段开右缝。 */
      if (d) {
        const cidx = indexOfItem('clip', d.id);
        const clips = filmOf().clips || [];
        const seam = cidx > 0 ? cidx : (clips.length > 1 ? cidx + 1 : -1);
        if (seam > 0 && seam < clips.length) {
          items.splice(3, 0, ['transition', clips[seam] && clips[seam].transition ? '改这条缝的转场' : '给这条缝加转场']);
          ctxInfo.seam = seam;
        }
      }
    } else if (d.kind === 'cap') {
      items.push(['cap-link', '接上配音'], ['cap-unlink', '解除关联'], ['cap-align', '对齐到音频'], ['delete', '删除这条字幕']);
    } else {
      items.push(['item-link', '把这一段配音接上字幕'], ['item-unlink', '断开这一段配音'], ['item-align', '字幕对齐到配音'], ['delete', '删除这一块']);
    }
    const el = document.createElement('div');
    el.className = 'tl-ctx';
    el.id = 'tlCtx';
    el.innerHTML = items.map(([act, name]) => `<button type="button" class="tl-ctx-row" data-ctx="${act}">${esc(name)}</button>`).join('');
    const rect = board.getBoundingClientRect();
    el.style.left = Math.max(4, e.clientX - rect.left) + 'px';
    el.style.top = Math.max(4, e.clientY - rect.top) + 'px';
    board.appendChild(el);
    /* 菜单挂在板上（轨道整块重画时不能被抹掉），而板**不是** host 的子孙 ——
       host 上那颗捕获式 click 够不着它，所以这一层自己接：与标记面板同一套做法。 */
    el.addEventListener('click', ev => {
      const row = ev.target && ev.target.closest ? ev.target.closest('[data-ctx]') : null;
      if (!row) return;
      const act = row.getAttribute('data-ctx');
      const info = ctxInfo;
      closeCtx();
      if (info) runCtxRow(act, info);
    });
  }
  function runCtxRow(act, info) {
    if (info.d) setSel([selKey(info.d.kind, info.d.id)], info.d);
    if (act === 'add-seg') { addSegmentAt(info.time); return; }
    if (act === 'transition') {
      const j = info.seam != null && host ? host.querySelector('[data-junction="' + info.seam + '"]') : null;
      if (j) j.click();                                   // 轨道自己的 click 委托会开转场浮层
      return;
    }
    if (act === 'item-link' || act === 'item-unlink' || act === 'item-align'
      || act === 'cap-link' || act === 'cap-unlink' || act === 'cap-align') {
      focus = info.d || focus; linkAction(act); return;
    }
    toolAction(act);
  }

  /* ---------------- 关联族 ---------------- */
  const liveTimed = f => (f.voices || []);
  const timedById = f => new Map(liveTimed(f).map(x => [x.id, x]));
  /* 「认回记忆位 → 否则找重叠最多的」—— 与参考项目 findCaptionAudioLinkTarget 同一条判据。 */
  function linkTargetFor(cap, f) {
    const timed = liveTimed(f);
    const remembered = timed.find(x => x.id === cap.detachedVoiceId);
    if (remembered) return remembered;
    const cs = num(cap.start), ce = num(cap.end), cc = (cs + ce) / 2;
    const overlap = x => Math.max(0, Math.min(ce, num(x.start) + num(x.duration)) - Math.max(cs, num(x.start)));
    return timed.slice().sort((a, b) => (overlap(b) - overlap(a)) || (Math.abs(num(a.start) + num(a.duration) / 2 - cc) - Math.abs(num(b.start) + num(b.duration) / 2 - cc)))[0] || null;
  }
  const captionsOfVoice = (f, id) => (f.captions || []).filter(c => c && (c.voiceId === id || (!c.voiceId && c.detachedVoiceId === id)));
  function allLinked(f) {
    const caps = f.captions || [];
    if (!caps.length) return false;
    return caps.every(c => c.voiceId && timedById(f).has(c.voiceId));
  }
  const linkableCount = f => (f.captions || []).filter(c => !c.voiceId || c.detachedVoiceId).length;

  function linkAction(act) {
    const f = filmOf();
    const w = currentWork();
    let caps = w.captions.slice();
    const id = (focus.kind === 'cap' ? focus.id : '') || (ctxInfo && ctxInfo.id) || '';
    if (act === 'link-all') {
      const map = timedById(w);
      let n = 0;
      caps = caps.map(c => {
        if (c.voiceId && map.has(c.voiceId)) return c;
        const target = (c.detachedVoiceId && map.has(c.detachedVoiceId)) ? map.get(c.detachedVoiceId) : linkTargetFor(c, w);
        if (!target) return c;
        n++;
        return { ...c, voiceId: target.id, detachedVoiceId: '' };
      });
      if (!n) { if (setStatus) setStatus('没有可接回的字幕（记忆位里的配音已经不在了）'); return false; }
      return commit({ ...w, captions: caps }, `全部接回字幕与配音的关联（${n} 条）`);
    }
    if (act === 'unlink-all') {
      let n = 0;
      caps = caps.map(c => {
        if (!c.voiceId) return c;
        n++;
        return { ...c, detachedVoiceId: c.voiceId, voiceId: '' };
      });
      if (!n) { if (setStatus) setStatus('本来就没有关联着的字幕'); return false; }
      return commit({ ...w, captions: caps }, `全部解除字幕与配音的关联（${n} 条，记忆位留着）`);
    }
    const cap = act.startsWith('cap-') ? caps.find(c => c.id === id) : null;
    if (cap) {
      if (act === 'cap-unlink') {
        if (!cap.voiceId) { if (setStatus) setStatus('这一条字幕本来就没接配音'); return false; }
        return commit({ ...w, captions: caps.map(c => (c.id === cap.id ? { ...c, detachedVoiceId: c.voiceId, voiceId: '' } : c)) },
          `解除字幕「${ctxClip(cap.text, 12)}」与配音的关联`);
      }
      if (act === 'cap-link') {
        const target = linkTargetFor(cap, w);
        if (!target) { if (setStatus) setStatus('这一刻没有可接的配音块'); return false; }
        return commit({ ...w, captions: caps.map(c => (c.id === cap.id ? { ...c, voiceId: target.id, detachedVoiceId: '' } : c)) },
          `把字幕「${ctxClip(cap.text, 12)}」接到配音「${ctxClip(target.text, 12)}」上`);
      }
      const target = timedById(w).get(cap.voiceId);
      if (!target) { if (setStatus) setStatus('这一条字幕没接配音，无从对齐'); return false; }
      return commit({ ...w, captions: caps.map(c => (c.id === cap.id ? { ...c, start: round2(num(target.start)), end: round2(num(target.start) + num(target.duration)) } : c)) },
        `把字幕「${ctxClip(cap.text, 12)}」对齐到配音（${fmtTenth(target.start)}–${fmtTenth(num(target.start) + num(target.duration))} 秒）`);
    }
    const vid = focus.kind === 'voice' ? focus.id : (ctxInfo && ctxInfo.id) || '';
    if (!vid) { if (setStatus) setStatus('先点一块配音，再做关联'); return false; }
    const mine = captionsOfVoice(w, vid);
    if (!mine.length) { if (setStatus) setStatus('这一段配音身上没有字幕'); return false; }
    const item = timedById(w).get(vid);
    if (act === 'item-unlink') {
      return commit({ ...w, captions: w.captions.map(c => (c.voiceId === vid ? { ...c, detachedVoiceId: vid, voiceId: '' } : c)) },
        `断开配音「${ctxClip(item && item.text, 12)}」下的 ${mine.length} 条字幕`);
    }
    if (act === 'item-link') {
      return commit({ ...w, captions: w.captions.map(c => (c.detachedVoiceId === vid || (!c.voiceId && !c.detachedVoiceId && coversTime(item, (num(c.start) + num(c.end)) / 2)) ? { ...c, voiceId: vid, detachedVoiceId: '' } : c)) },
        `把「${ctxClip(item && item.text, 12)}」这一刻附近的字幕接上`);
    }
    return commit({ ...w, captions: w.captions.map(c => (c.voiceId === vid ? { ...c, start: round2(num(item.start)), end: round2(num(item.start) + num(item.duration)) } : c)) },
      `把「${ctxClip(item && item.text, 12)}」下的 ${mine.length} 条字幕对齐到配音`);
  }

  /* ---------------- 工具条动作 ---------------- */
  const activeClipRow = () => {
    const gg = g();
    const idx = focus.kind === 'clip' && sel.has(selKey('clip', focus.id)) ? indexOfItem('clip', focus.id) : gg.tl.indexAtTime(Timeline.playhead());
    return gg.tl.rows[idx] || null;
  };
  const activeCapIndex = () => {
    const caps = (filmOf().captions || []).slice().sort((a, b) => num(a.start) - num(b.start));
    const at = focus.kind === 'cap' && sel.has(selKey('cap', focus.id)) ? focus.id : (caps.find(c => Timeline.playhead() >= num(c.start) && Timeline.playhead() < num(c.end)) || {}).id;
    return caps.findIndex(c => c.id === at);
  };

  function deleteSelected() {
    const w = currentWork();
    const ids = selectedDescriptors();
    if (!ids.length) { if (setStatus) setStatus('先选中要删的块'); return false; }
    let clips = w.clips.slice(), voices = w.voices.slice(), captions = w.captions.slice();
    const gone = [];
    let locked = 0, skipped = 0;
    /* 按当前下标从大到小删：删后面的不动前面的下标，`clips.findIndex` 与时间线的行始终对得上。 */
    ids.sort((a, b) => indexOfItem(b.kind, b.id) - indexOfItem(a.kind, a.id)).forEach(d => {
      const it = filmItemOf(d.kind, d.id, w);
      if (!it) return;
      if (laneLocked(d)) { locked++; return; }
      const rowForDesc = d.kind === 'clip' ? deriveTimeline(w.clips).rows[indexOfItem('clip', d.id)] : null;
      gone.push(rowForDesc ? clipDesc(it, num(rowForDesc.start), num(rowForDesc.end)) : timedLabel(it, d.kind));
      if (d.kind === 'clip') {
        const i = clips.findIndex(c => c.id === d.id);
        if (i < 0) return;
        const row = deriveTimeline(clips).rows[i];
        clips = removeClipAt(clips, i).clips;
        /* 波纹开着时删掉这一段：边界之后的定时块一起前移（配音 / 字幕一次算完，
           锁住的行由它自己跳过并报数）—— 不开波纹就一个定时块都不动。 */
        if (Timeline.rippleOn()) {
          const rr = applyTimelineRipple({ ...w, clips, voices, captions }, num(row.end), -clipDurationOf(it));
          voices = rr.film.voices; captions = rr.film.captions;
          skipped += rr.skipped;
        }
      } else if (d.kind === 'voice') voices = voices.filter(v => v.id !== d.id);
      else captions = captions.filter(c => c.id !== d.id);
    });
    if (!gone.length) {
      if (setStatus) setStatus(locked ? '选中的块所在的行锁着，先解锁再删' : '先选中要删的块');
      return false;
    }
    /* 配音删掉之后挂在它身上的字幕不删，只是断开链接（normalizeFilm 会把断掉的写进记忆位）。 */
    let label = `删除 ${gone.length} 块：${gone.join('、')}`;
    if (skipped) label += `（波纹：跳过锁定 ${skipped} 条）`;
    if (locked) label += `（${locked} 块所在的行锁着，没删）`;
    return commit({ ...w, clips, voices, captions }, label.slice(0, 200));
  }

  function duplicateSelected() {
    const w = currentWork();
    const ids = selectedDescriptors();
    if (!ids.length) { if (setStatus) setStatus('先选中要复制的块'); return false; }
    let clips = w.clips.slice(), voices = w.voices.slice(), captions = w.captions.slice();
    const names = [], ripples = [];
    let locked = 0, skipped = 0;
    /* 从大到小处理：插进去的副本总在当前下标之后，前面那几块的下标不受影响。 */
    ids.sort((a, b) => indexOfItem(b.kind, b.id) - indexOfItem(a.kind, a.id)).forEach(d => {
      const it = filmItemOf(d.kind, d.id, w);
      if (!it) return;
      if (laneLocked(d)) { locked++; return; }
      if (d.kind === 'clip') {
        const i = clips.findIndex(c => c.id === d.id);
        if (i < 0) return;
        const row = deriveTimeline(w.clips).rows[i];
        clips = duplicateClipAt(clips, i).clips;
        /* 副本插在原段之后：波纹开着时，边界之后的定时块一起后移这一段的时间。 */
        if (row) ripples.push({ boundary: num(row.end), delta: clipDurationOf(it) });
        names.push(row ? clipDesc(it, num(row.start), num(row.end)) : clipTitle(it));
        return;
      }
      const copy = { ...it, id: filmId(d.kind === 'cap' ? 'cap' : 'voice') };
      if (d.kind === 'cap') { copy.start = round2(num(it.end) + 0.05); copy.end = round2(copy.start + Math.max(MIN_CAPTION_SECONDS, num(it.end) - num(it.start))); }
      else { copy.start = round2(num(it.start) + num(it.duration)); delete copy.transition; }
      if (d.kind === 'voice') voices = [...voices, copy];
      else captions = [...captions, copy];
      names.push(ctxClip(it.text || '这一块', 12));
    });
    if (!names.length) {
      if (setStatus) setStatus(locked ? '选中的块所在的行锁着，先解锁再复制' : '先选中要复制的块');
      return false;
    }
    /* 多段一起复制时从后往前落波纹：靠后的边界先移，靠前的边界再把整段（含已移过的）一起推。 */
    if (Timeline.rippleOn() && ripples.length) {
      ripples.sort((a, b) => b.boundary - a.boundary).forEach(rp => {
        const rr = applyTimelineRipple({ ...w, clips, voices, captions }, rp.boundary, rp.delta);
        voices = rr.film.voices; captions = rr.film.captions;
        skipped += rr.skipped;
      });
    }
    let label = `复制 ${names.length} 块：${names.join('、')}`;
    if (skipped) label += `（波纹：跳过锁定 ${skipped} 条）`;
    if (locked) label += `（${locked} 块所在的行锁着，没复制）`;
    return commit({ ...w, clips, voices, captions }, label.slice(0, 200));
  }

  /* 段上那颗静音钮（strip.js 画的 `data-mute`）：只写 `clip.muted`，音量数值一个字节都不动 ——
     「这一段的原声进不进成片」与「多大」是两件事，压进同一个数就恢复不了用户原来调好的大小。 */
  function toggleMute(id) {
    const w = currentWork();
    const i = indexOfItem('clip', id, w);
    const clip = w.clips[i];
    if (!clip || clip.kind === 'image') return false;
    const row = deriveTimeline(w.clips).rows[i];
    const next = { ...clip, muted: !clip.muted };
    return commit({ ...w, clips: w.clips.map((c, k) => (k === i ? next : c)) },
      `${next.muted ? '静音' : '恢复'} ${clipDesc(clip, num(row && row.start), num(row && row.end))} 的原声`);
  }

  function cutAtPlayhead() {
    const t = Timeline.playhead();
    const w = currentWork();
    const ids = selectedDescriptors();
    let clips = w.clips.slice(), voices = w.voices.slice(), captions = w.captions.slice();
    let done = 0, reason = '';
    /* 历史里要点名「切的是哪一镜的哪一段」：切之前先记下每一块自己的描述（切完就没那个段号了）。 */
    const what = [];
    const clipTargets = ids.filter(d => d.kind === 'clip');
    const row = g().tl.rowAtTime(t);
    const clipTarget = clipTargets.length ? clipTargets[0] : (row ? { kind: 'clip', id: row.clip.id } : null);
    const clipIdx = clipTarget ? indexOfItem('clip', clipTarget.id) : -1;
    if (clipIdx >= 0) {
      if (laneLocked(clipTarget)) reason = '这一块所在的行锁着，先解锁再切';
      else {
        const before = deriveTimeline(clips).rows[clipIdx];
        const r = splitClipAt(clips, clipIdx, t);
        if (r.ok) { clips = r.clips; done++; if (before) what.push(clipDesc(before.clip, num(before.start), num(before.end))); }
        else reason = r.reason;
      }
    }
    const timedTargets = ids.filter(d => d.kind === 'voice');
    const cover = timedTargets.length ? timedTargets : liveTimed(w).filter(x => coversTime(x, t)).map(x => ({ kind: 'voice', id: x.id }));
    cover.forEach(d => {
      const it = filmItemOf(d.kind, d.id, { ...w, voices });
      if (!it || !coversTime(it, t)) return;
      if (laneLocked(d)) { if (!reason) reason = timedLabel(it, d.kind) + '所在的行锁着，先解锁再切'; return; }
      const list = voices;
      const r = splitVoiceAt(list, it.id, t);
      if (r.ok) {
        voices = r.voices;
        done++; what.push(timedLabel(it, d.kind));
      } else if (!reason) reason = r.reason;
    });
    const capTargets = ids.filter(d => d.kind === 'cap');
    const caps = capTargets.length ? capTargets
      : (w.captions || []).filter(c => t > num(c.start) + 0.0005 && t < num(c.end) - 0.0005).map(c => ({ kind: 'cap', id: c.id }));
    caps.forEach(d => {
      if (laneLocked(d)) { if (!reason) reason = '字幕所在的行锁着，先解锁再切'; return; }
      const before = filmItemOf('cap', d.id, { ...w, captions });
      const r = splitCaptionAt(captions, d.id, t);
      if (r.ok) { captions = r.captions; done++; if (before) what.push(timedLabel(before, 'cap')); }
      else if (!reason) reason = r.reason;
    });
    if (!done) { if (setStatus) setStatus(reason || '播放头没有落在可切的块上'); return false; }
    /* 切完之后选中**右边那一截**（剪映 / PR 同一条习惯：下一刀往往就在新段的起点）。 */
    const keys = Array.from(sel);
    if (clipIdx >= 0) {
      const right = deriveTimeline(clips).rows[clipIdx + 1];
      const k = right ? selKey('clip', right.clip.id) : '';
      if (k && !keys.includes(k)) keys.unshift(k);
    }
    setSel(keys, focus);
    return commit({ ...w, clips, voices, captions }, `把${what.join('、')}在 ${fmtTenth(t)} 秒处切开`);
  }

  function mergeSelected() {
    const w = currentWork();
    const ids = selectedDescriptors().filter(d => d.kind === 'clip').map(d => d.id);
    let i = ids.length >= 2 ? Math.min(w.clips.findIndex(c => c.id === ids[0]), w.clips.findIndex(c => c.id === ids[1])) : -1;
    if (i < 0) {
      const row = activeClipRow();
      i = row ? row.index : -1;
      if (i >= 0 && !canMergeClips(w.clips[i], w.clips[i + 1])) {
        if (setStatus) setStatus('相邻两段接不上（不同素材，或中间动过）');
        return false;
      }
    }
    if (i < 0) { if (setStatus) setStatus('先选中要融合的画面段'); return false; }
    const left = w.clips[i], right = w.clips[i + 1];
    if (!canMergeClips(left, right)) { if (setStatus) setStatus('相邻两段接不上（不同素材，或中间动过）'); return false; }
    const f = filmOf();
    const locked = [left, right].some(c => {
      const ln = filmLaneOf(f, 'clip', c.id);
      return ln >= 0 && itemLocked(f.tracks, 'image', ln);
    });
    if (locked) { if (setStatus) setStatus('相邻两段所在的行锁着，先解锁再融合'); return false; }
    const r = mergeClipsAt(w.clips, i);
    const rows = deriveTimeline(w.clips).rows;
    const oldEnd = num(g().tl.rows[i].end);
    return commit({ ...w, clips: r.clips },
      `把${clipDesc(left, num(rows[i] && rows[i].start), num(rows[i] && rows[i].end))}与`
      + `${clipDesc(right, num(rows[i + 1] && rows[i + 1].start), num(rows[i + 1] && rows[i + 1].end))}融合成一段`,
      { boundary: oldEnd, delta: 0 });
  }

  /* 在播放头处新增一段（参考 handleAddSegment）：落在边界就插进去，落在段中就切成左 / 新 / 右。 */
  function addSegmentAt(time) {
    const w = currentWork();
    const t = Math.max(0, num(time == null ? Timeline.playhead() : time));
    if (focus.track === 'caption') return addCaptionAt(t, w);
    const total = deriveTimeline(w.clips).total;
    if (total >= MAX_FILM_SECONDS - MIN_CAPTION_SECONDS) { if (setStatus) setStatus('视觉轨已经达到 30 分钟上限'); return false; }
    const rows = deriveTimeline(w.clips).rows;
    const dur = Math.min(IMAGE_SEGMENT_SECONDS, MAX_FILM_SECONDS - total);
    const boundary = rows.findIndex(r => Math.abs(num(r.start) - t) < 0.001);
    const base = () => {
      const row = rows[deriveTimeline(w.clips).indexAtTime(Math.min(t, Math.max(0, total - 0.001)))];
      return row ? row.clip : (w.clips[w.clips.length - 1] || null);
    };
    const seed = base();
    const fresh = createClip({
      ...(seed || {}), id: filmId('clip'), shotId: seed ? seed.shotId : '', candId: '', name: seed ? seed.name : '',
      src: seed ? seed.src : '', kind: seed ? seed.kind : 'image',
      sourceStart: seed && seed.kind === 'image' ? 0 : t > 0 ? num(seed && seed.sourceStart) : 0,
      sourceDuration: dur * Math.max(0.25, num(seed && seed.playbackRate, 1) || 1),
      duration: dur, mediaDuration: 0, trackFrames: [], peaks: [],
    });
    delete fresh.transition;
    let clips = w.clips.slice();
    if (boundary >= 0) clips.splice(boundary, 0, fresh);
    else if (rows.length) {
      const idx = deriveTimeline(clips).indexAtTime(t);
      const row = rows[idx];
      const act = clips[idx];
      const leftDur = t - num(row.start), rightDur = num(row.end) - t;
      if (row && act && leftDur > 0.05 && rightDur > 0.05) {
        const rate = act.kind === 'image' ? 1 : Math.max(0.25, num(act.playbackRate, 1) || 1);
        const left = createClip({ ...act, id: filmId('clip'), duration: leftDur, sourceDuration: act.kind === 'image' ? act.sourceDuration : leftDur * rate, trackFrames: [], peaks: [] });
        const right = createClip({
          ...act, id: filmId('clip'), duration: rightDur,
          sourceStart: act.kind === 'image' ? num(act.sourceStart) : num(act.sourceStart) + leftDur * rate,
          sourceDuration: act.kind === 'image' ? act.sourceDuration : rightDur * rate, trackFrames: [], peaks: [],
        });
        delete left.transition;
        clips.splice(idx, 1, left, fresh, right);
      } else clips.push(fresh);
    } else clips = [fresh];
    const at = boundary >= 0 ? t : (rows.length ? t : total);
    return commit({ ...w, clips }, `在 ${fmtTenth(at)} 秒处新增一段画面（长 ${fmtTenth(dur)} 秒）`, { boundary: at, delta: dur });
  }
  function addCaptionAt(t, w) {
    if (!(w.captions || []).length && !w.captions) w.captions = [];
    const cap = createCaption({ text: '新的字幕片段', start: t, end: t + CAPTION_ADD_SECONDS });
    const captions = [...(w.captions || []), cap].sort((a, b) => num(a.start) - num(b.start));
    setSel([selKey('cap', cap.id)], { kind: 'cap', id: cap.id, track: 'caption', lane: 0 });
    return commit({ ...w, captions }, `新增一条字幕「${ctxClip(cap.text, 12)}」（${fmtTenth(cap.start)}–${fmtTenth(cap.end)} 秒）`);
  }

  /* 减少一段（参考 handleRemoveSegment）：多段就删当前，只剩一段就缩短 2 秒。 */
  function removeSegment() {
    const w = currentWork();
    if (focus.track === 'caption') {
      const i = activeCapIndex();
      if (i < 0) { if (setStatus) setStatus('当前没有字幕片段可删除'); return false; }
      const cap = w.captions[i];
      return commit({ ...w, captions: w.captions.filter((c, k) => k !== i) },
        `删掉字幕「${ctxClip(cap.text, 12)}」（${fmtTenth(cap.start)}–${fmtTenth(cap.end)} 秒）`);
    }
    const row = activeClipRow();
    if (!w.clips.length) { if (setStatus) setStatus('当前没有视觉片段可减少'); return false; }
    if (w.clips.length > 1) {
      const idx = row ? row.index : w.clips.length - 1;
      const it = w.clips[idx];
      const r = removeClipAt(w.clips, idx);
      return commit({ ...w, clips: r.clips }, `删掉${clipDesc(it, num(row && row.start), num(row && row.end))}`,
        { boundary: num(row && row.end), delta: -clipDurationOf(it) });
    }
    const only = w.clips[0];
    if (clipDurationOf(only) <= IMAGE_SEGMENT_SECONDS) {
      return commit({ ...w, clips: [] }, `删掉最后那一段${clipDesc(only, 0, clipDurationOf(only))}`,
        { boundary: clipDurationOf(only), delta: -clipDurationOf(only) });
    }
    const next = createClip({ ...only, duration: Math.max(0.05, clipDurationOf(only) - IMAGE_SEGMENT_SECONDS), sourceDuration: only.kind === 'image' ? only.sourceDuration : Math.max(0, num(only.sourceDuration) - IMAGE_SEGMENT_SECONDS * Math.max(0.25, num(only.playbackRate, 1) || 1)) });
    return commit({ ...w, clips: [next] },
      `只剩这一段，把它缩短 ${IMAGE_SEGMENT_SECONDS} 秒：${clipDesc(only, 0, clipDurationOf(only))} 改成 0–${fmtTenth(clipDurationOf(next))} 秒`,
      { boundary: clipDurationOf(only), delta: -IMAGE_SEGMENT_SECONDS });
  }

  /* 长短微调：画面段 ±1 秒，字幕 ±0.6 秒（与参考项目同一档步进）。 */
  function adjustWeight(delta) {
    const w = currentWork();
    const step = delta > 0 ? 1 : -1;
    if (focus.track === 'caption') {
      const i = activeCapIndex();
      if (i < 0) { if (setStatus) setStatus('当前没有字幕片段可调整'); return false; }
      const cap = w.captions[i];
      const others = w.captions.filter((c, k) => k !== i && num(c.start) > num(cap.start)).sort((a, b) => num(a.start) - num(b.start))[0];
      const maxEnd = Math.min(MAX_FILM_SECONDS, others ? num(others.start) : MAX_FILM_SECONDS);
      const end = Math.max(num(cap.start) + Math.max(0.45, MIN_CAPTION_SECONDS), Math.min(maxEnd, num(cap.end) + (delta > 0 ? 0.6 : -0.6)));
      if (Math.abs(end - num(cap.end)) < 0.001) { if (setStatus) setStatus(delta > 0 ? '当前字幕已贴近下一段' : '当前字幕已到最短时长'); return false; }
      return commit({ ...w, captions: w.captions.map((c, k) => (k === i ? { ...c, end: round2(end) } : c)) },
        `把字幕「${ctxClip(cap.text, 12)}」${delta > 0 ? '加长' : '缩短'}到 ${fmtTenth(cap.start)}–${fmtTenth(end)} 秒`);
    }
    const row = activeClipRow();
    if (!row) { if (setStatus) setStatus('先选中一段画面，再调整长短'); return false; }
    const idx = row.index, it = w.clips[idx];
    const without = deriveTimeline(w.clips).total - clipDurationOf(it);
    const max = Math.max(0.05, MAX_FILM_SECONDS - without);
    const dur = Math.min(max, Math.max(0.05, clipDurationOf(it) + step));
    if (Math.abs(dur - clipDurationOf(it)) < 0.001) {
      if (setStatus) setStatus(delta > 0 ? '视觉轨道已经达到 30 分钟上限' : '当前视觉片段已到最短时长');
      return false;
    }
    const rate = it.kind === 'image' ? 1 : Math.max(0.25, num(it.playbackRate, 1) || 1);
    const next = createClip({ ...it, duration: round2(dur), sourceDuration: it.kind === 'image' ? it.sourceDuration : round2(dur * rate) });
    return commit({ ...w, clips: w.clips.map((c, k) => (k === idx ? next : c)) },
      `把${clipDesc(it, num(row.start), num(row.end))}${delta > 0 ? '加长' : '缩短'} 1 秒，改成 ${fmtTenth(row.start)}–${fmtTenth(num(row.start) + dur)} 秒`,
      { boundary: num(row.end), delta: round2(dur - clipDurationOf(it)) });
  }

  const TOOL_ACTS = {
    delete: deleteSelected, duplicate: duplicateSelected, cut: cutAtPlayhead, merge: mergeSelected,
    'add-seg': () => addSegmentAt(null), 'remove-seg': removeSegment,
    shorten: () => adjustWeight(-1), lengthen: () => adjustWeight(1),
    'link-all': () => linkAction(filmOf().captions.length && allLinked(filmOf()) ? 'unlink-all' : 'link-all'),
    'unlink-all': () => linkAction('unlink-all'), 'link-one': () => linkAction('cap-link'),
    'unlink-one': () => linkAction('cap-unlink'), 'align-audio': () => linkAction('cap-align'),
    'markers-panel': () => { panelOpen = !panelOpen; paintPanel(); },
  };

  function toolAction(act) {
    if (act === 'link') {
      const f = filmOf();
      if (!linkableCount(f) && !allLinked(f) && !(f.captions || []).length) {
        if (setStatus) setStatus('没有字幕可关联：字幕行现在是空的');
        return true;
      }
      return TOOL_ACTS['link-all']();
    }
    const fn = TOOL_ACTS[act];
    if (!fn) return false;
    fn();
    return true;
  }

  /* ---------------- 标记面板 ---------------- */
  /* 列表那一块单独一个出口：搜索框改关键字时只换这一块（重画整面板会把输入焦点丢掉）。 */
  function mpListHTML() {
    const q = panelQuery.trim().toLowerCase();
    const selId = selectedByKind('marker')[0] || '';
    const rows = markersSorted(filmOf().markers).filter(m => (panelFilter === 'all' || m.type === panelFilter)
      && (!q || `${m.title} ${m.notes}`.toLowerCase().includes(q)));
    if (!rows.length) return '<div class="empty">这一档没有标记</div>';
    return rows.map(m => `<button type="button" class="tl-mp-row${m.id === selId ? ' is-on' : ''} color-${m.color}" data-mp-jump="${esc(m.id)}" title="${esc(markerClock(m.time))}">
          <i class="tl-mp-ic">${icon(MARKER_TYPE_ICON[m.type] || 'flag', 11)}</i>
          <span class="tl-mp-name">${esc(m.title || MARKER_TYPE_ZH[m.type])}</span>
          <span class="tl-mp-time">${esc(markerClock(m.time))}</span>
        </button>`).join('');
  }

  function panelHTML() {
    const f = filmOf();
    const all = markersSorted(f.markers);
    const counts = markerCounts(f.markers);
    const cur = all.find(m => m.id === (selectedByKind('marker')[0] || '')) || null;
    const filters = ['all'].concat(MARKER_TYPES).map(t => {
      const name = t === 'all' ? '全部' : MARKER_TYPE_ZH[t];
      return `<button type="button" class="tl-mp-chip${panelFilter === t ? ' is-on' : ''}" data-mp-filter="${t}">${esc(name)}</button>`;
    }).join('');
    const colors = MARKER_COLORS.map(c => `<button type="button" class="tl-mp-color color-${c}${cur && cur.color === c ? ' is-on' : ''}" data-mp-color="${c}" title="${esc(MARKER_COLOR_ZH[c])}"></button>`).join('');
    return `<div class="tl-mpanel-head">
        <span class="tl-mpanel-title">${icon('flag', 13)}标记 · ${counts.total}</span>
        <button type="button" class="tl-tb" data-mp="close" title="关闭">${icon('close', 13)}</button>
      </div>
      <div class="tl-mpanel-search">${icon('search', 12)}<input id="mpQ" type="text" placeholder="搜标题与备注" value="${esc(panelQuery)}"></div>
      <div class="tl-mpanel-chips">${filters}</div>
      <div class="tl-mpanel-list" id="mpList">${mpListHTML()}</div>
      ${cur ? `<div class="tl-mpanel-detail">
        <label class="tl-mp-field"><span>标题</span><input id="mpTitle" type="text" value="${esc(cur.title)}"></label>
        <label class="tl-mp-field"><span>备注</span><textarea id="mpNotes" rows="2">${esc(cur.notes)}</textarea></label>
        <div class="tl-mp-field"><span>类型</span><div class="tl-mp-types">${MARKER_TYPES.map(t => `<button type="button" class="tl-mp-chip${cur.type === t ? ' is-on' : ''}" data-mp-type="${t}">${esc(MARKER_TYPE_ZH[t])}</button>`).join('')}</div></div>
        <div class="tl-mp-field"><span>颜色</span><div class="tl-mp-colors">${colors}</div></div>
        <div class="tl-mp-field"><span>起点</span><input id="mpStart" type="number" min="0" step="0.1" value="${fmtTenth(cur.time)}">
          <button type="button" class="tl-mp-chip" data-mp="use-playhead" title="用播放头这一刻">用播放头</button></div>
        ${cur.type === 'range' ? `<div class="tl-mp-field"><span>止点</span><input id="mpEnd" type="number" min="0" step="0.1" value="${fmtTenth(markerRangeOf(cur).end)}"></div>` : ''}
        <div class="tl-mp-acts">
          <button type="button" class="tl-mp-chip" data-mp="prev" title="上一处标记">${icon('stepBack', 12)}</button>
          <button type="button" class="tl-mp-chip" data-mp="next" title="下一处标记">${icon('stepNext', 12)}</button>
          <button type="button" class="tl-mp-chip" data-mp="jump" title="把播放头挪到这个标记">${icon('skipBack', 12)}跳过去</button>
          <span class="tl-grow"></span>
          <button type="button" class="tl-mp-chip is-danger" data-mp="del" title="删除这一枚标记">${icon('trash', 12)}删除</button>
        </div>
      </div>` : ''}
      <div class="tl-mpanel-foot">
        <button type="button" class="tl-mp-chip" data-mp="add" title="在播放头处加一枚标记（M）">${icon('plus', 12)}加一枚</button>
        <button type="button" class="tl-mp-chip${Timeline.markersOpen() ? ' is-on' : ''}" data-mp="rail" title="标记条显示 / 收起">${icon(Timeline.markersOpen() ? 'chevronDown' : 'chevronUp', 12)}标记条</button>
        <span class="tl-grow"></span>
        <span class="tl-mp-sum">${counts.marker} 标记 · ${counts.chapter} 章节 · ${counts.range} 范围 · ${counts.note} 便签</span>
      </div>`;
  }
  function paintPanel() {
    if (!board) return;
    let el = board.querySelector('#tlMPanel');
    if (!panelOpen) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'tl-mpanel';
      el.id = 'tlMPanel';
      board.appendChild(el);
      el.addEventListener('click', onPanelClick);
      el.addEventListener('input', onPanelInput);
      el.addEventListener('change', onPanelInput);
    }
    /* 面板整片重画会把里面那一列（`.tl-mpanel-list` 自己竖滚）连着换掉 → 滚动位从 0 起：
       滚到列表下半段改一枚标记，面板一刷新就弹回顶部。公共件按锚点还回去。 */
    Wb.viewport.keep(el, () => { el.innerHTML = panelHTML(); });
  }
  function panelPatch(id, patch, label) {
    const w = currentWork();
    const at = w.markers.findIndex(m => m.id === id);
    if (at < 0) return;
    const next = createMarker({ ...w.markers[at], ...patch });
    w.markers = w.markers.map((m, i) => (i === at ? next : m));
    commit(w, label || `改了一枚标记（${MARKER_TYPE_ZH[next.type] || '标记'} · ${markerClock(next.time)}）`);
    paintPanel();
  }
  function onPanelClick(e) {
    const t = e.target;
    const jump = t.closest('[data-mp-jump]');
    if (jump) {
      const id = jump.getAttribute('data-mp-jump');
      const m = markerById(id);
      setSel([selKey('marker', id)], { kind: 'marker', id, track: 'markers' });
      if (m) Timeline.seekTo(num(m.time));
      paintPanel();
      return;
    }
    const filter = t.closest('[data-mp-filter]');
    if (filter) { panelFilter = filter.getAttribute('data-mp-filter'); paintPanel(); return; }
    const type = t.closest('[data-mp-type]');
    if (type) { const id = selectedByKind('marker')[0]; if (id) panelPatch(id, { type: type.getAttribute('data-mp-type') }); return; }
    const color = t.closest('[data-mp-color]');
    if (color) { const id = selectedByKind('marker')[0]; if (id) panelPatch(id, { color: color.getAttribute('data-mp-color') }); return; }
    const btn = t.closest('[data-mp]');
    if (!btn) return;
    const act = btn.getAttribute('data-mp');
    const id = selectedByKind('marker')[0];
    const m = id ? markerById(id) : null;
    if (act === 'close') { panelOpen = false; paintPanel(); return; }
    if (act === 'rail') { toolToggle('markers'); paintPanel(); return; }
    if (act === 'add') { if (addMarkerAt) addMarkerAt(Timeline.playhead()); paintPanel(); return; }
    if (!m) { if (setStatus) setStatus('先在列表里点一枚标记'); return; }
    if (act === 'use-playhead') { panelPatch(m.id, { time: Timeline.playhead() }, `把标记起点改成播放头 ${fmtTenth(Timeline.playhead())} 秒`); return; }
    if (act === 'jump') { Timeline.seekTo(num(m.time)); return; }
    if (act === 'prev' || act === 'next') {
      const all = markersSorted(filmOf().markers);
      const i = all.findIndex(x => x.id === m.id);
      const nx = all[act === 'prev' ? Math.max(0, i - 1) : Math.min(all.length - 1, i + 1)];
      if (nx) { setSel([selKey('marker', nx.id)], { kind: 'marker', id: nx.id, track: 'markers' }); Timeline.seekTo(num(nx.time)); }
      paintPanel();
      return;
    }
    if (act === 'del') {
      const w = currentWork();
      w.markers = w.markers.filter(x => x.id !== m.id);
      sel.delete(selKey('marker', m.id));
      commit(w, `删除标记（${MARKER_TYPE_ZH[m.type] || '标记'} · ${markerClock(m.time)}）`);
      paintPanel();
    }
  }
  function onPanelInput(e) {
    const el = e.target;
    const id = selectedByKind('marker')[0];
    if (el.id === 'mpQ') {
      panelQuery = el.value;
      const list = board.querySelector('#mpList');
      /* 搜索框改一个字就换这一列的行：行数变少了，浏览器把 `.tl-mpanel-list` 的滚动位夹回上限，
         视图整个往上蹿 —— 公共件按锚点把它挪回「当初露着的那一行还在原来那个位置」。 */
      if (list) Wb.viewport.keep(list, () => { list.innerHTML = mpListHTML(); });
      return;
    }
    if (!id) return;
    if (el.id === 'mpTitle') { const m = markerById(id); panelPatch(id, { title: el.value }, `把标记标题改成「${ctxClip(el.value, 12)}」`); return; }
    if (el.id === 'mpNotes') { const m = markerById(id); if (m && m.notes === el.value) return; panelPatch(id, { notes: el.value }, '改了标记的备注'); return; }
    if (el.id === 'mpStart') { panelPatch(id, { time: num(el.value) }, `把标记起点改成 ${fmtTenth(num(el.value))} 秒`); return; }
    if (el.id === 'mpEnd') { panelPatch(id, { endTime: num(el.value) }, `把标记止点改成 ${fmtTenth(num(el.value))} 秒`); }
  }
  /* 搜索框只换列表那一块（重画整面板会把输入焦点丢掉）。 */
  function toolToggle(act) {
    const btn = host && host.querySelector(`[data-tl="${act}"]`);
    if (btn) btn.click();
  }

  /* ---------------- 事件 ---------------- */
  function onPointerDownCapture(e) {
    if (e.pointerType === 'mouse' && e.button === 2) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(UI_ZONES)) return;
    if (t.closest('[data-mute]')) return;
    if (e.button !== 0) return;
    suppAt = { x: e.clientX, y: e.clientY };   // 记住这一颗点：紧接着那一发 click 就落在这里（拖动会把它挪到松手那一点）
    const handle = t.closest('.tl-h');
    const block = t.closest('.tl-clip,.tl-voice,.tl-cap');
    if (handle && block) {
      const d = describeEl(block);
      if (d) {
        e.stopPropagation();
        const hSide = handle.getAttribute('data-handle') === 'start' ? 'start' : 'end';
    /* 画面段的**左把手骑在切点上**（与参考项目同一刀法）：与左邻贴着时捏它 = 拖切点（roll，
       左邻吸收变化、右缘钉死、总长不变），不用先换「编辑点」工具；两段已经被拖开（段前 gap > 0）
       就不再联动 —— 捏它 = 锚定裁，左缘动、右缘钉死，左邻一秒不挪。首段没有左邻，同为锚定裁。
       右把手与其余两类块照旧走裁边。 */
    const idx = d.kind === 'clip' ? indexOfItem('clip', d.id) : -1;
    const clipIt = d.kind === 'clip' ? filmItemOf('clip', d.id) : null;
    if (d.kind === 'clip' && hSide === 'start' && idx > 0 && clipIt && num(clipIt.gap) < 0.001) {
      startBoundary(e, d, block, idx);
    } else startTrim(e, block, d, hSide);
      }
      return;
    }
    const tail = t.closest('[data-band-tail]');
    if (tail) { e.stopPropagation(); startMarker(e, tail, 'endTime'); return; }
    const band = t.closest('[data-band]');
    if (band) { e.stopPropagation(); startMarker(e, band, 'move'); return; }
    const marker = t.closest('[data-marker]');
    if (marker) { startMarker(e, marker, 'time'); return; }
    if (block) { e.stopPropagation(); startBlock(e, block); return; }
    const knob = t.closest('.tl-playhead');
    if (knob) { startScrub(e); return; }
    if (t.closest('.tl-scroll') || t.closest('.tl-ruler-clip') || t.closest('.tl-content')) { startScrub(e); return; }
  }

  function onClickCapture(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    /* 作废的只有「手势那一颗点上、这 240 毫秒里」的那一下 —— 按坐标认，不按时间认。
       工具条、浮层、菜单与轨名上那两颗旗标都点在自己的坐标上，从来不在被作废的那一发里。 */
    if (clickSuppressed(e)) { e.stopPropagation(); return; }
    /* 板上的菜单自己接自己的点击（它不在 host 里）；这里只管「点了别处就关掉」。 */
    if (board && board.querySelector('#tlCtx') && !t.closest('#tlCtx')) closeCtx();
    const block = t.closest('.tl-clip,.tl-voice,.tl-cap');
    if (block) {
      const d = describeEl(block);
      if (!d) return;
      d.lane = laneOfEl(block);
      const it = filmItemOf(d.kind, d.id);
      if (t.closest('[data-mute]')) { toggleMute(d.id); return; }
      applyClickSelection(d, e);
      const f = filmOf();
      if (it && d.kind === 'voice' && captionsOfVoice(f, d.id).length) {
        if (setStatus) setStatus(`这一块配音身上挂着 ${captionsOfVoice(f, d.id).length} 条字幕`);
      }
      return;
    }
    const marker = t.closest('[data-marker]');
    if (marker) setSel([selKey('marker', marker.getAttribute('data-marker'))], { kind: 'marker', id: marker.getAttribute('data-marker'), track: 'markers' });
  }

  function onContextMenu(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(UI_ZONES)) return;
    const block = t.closest('.tl-clip,.tl-voice,.tl-cap');
    const sc = t.closest('.tl-scroll');
    if (!block && !sc) return;
    e.preventDefault();
    const d = describeEl(block);
    const time = Timeline.timeAtClientX(e.clientX);
    if (d) { d.lane = laneOfEl(block); setSel([selKey(d.kind, d.id)], d); }
    openCtx(e, d, d ? d.id : '');
    if (ctxInfo && !d) ctxInfo.time = time;
  }

  function onKeyDoc(e) {
    if (!host || !host.isConnected) return;
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('input,textarea,select,[contenteditable]')) return;
    const k = e.key;
    const lower = String(k || '').toLowerCase();
    if (k === 'Escape') {
      if (ctxInfo) { closeCtx(); return; }
      if (panelOpen) { panelOpen = false; paintPanel(); return; }
      if (Timeline.mode() !== 'select') { Timeline.setMode('select'); return; }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && lower === 'b') { e.preventDefault(); cutAtPlayhead(); return; }
    if ((e.ctrlKey || e.metaKey) && lower === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && lower === 'm') { e.preventDefault(); mergeSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); deleteSelected(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (lower === 'm' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.shiftKey) { panelOpen = !panelOpen; paintPanel(); return; }
      if (addMarkerAt) addMarkerAt(Timeline.playhead());
      paintPanel();
      return;
    }
    if (k === '[') { e.preventDefault(); adjustWeight(-1); return; }
    if (k === ']') { e.preventDefault(); adjustWeight(1); return; }
    if (k === '+' || k === '=') { e.preventDefault(); Timeline.zoomIn(); return; }
    if (k === '-' || k === '_') { e.preventDefault(); Timeline.zoomOut(); return; }
    if (k === ' ' || k === 'Spacebar') {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      e.preventDefault(); if (Play) Play.toggle(); return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const dir = k === 'ArrowLeft' ? -1 : 1;
      const step = e.shiftKey ? 1 : 1 / 30;
      if (Timeline.mode() === 'edit-point' && focus.kind === 'clip') {
        const idx = indexOfItem('clip', focus.id);
        const r = rollClipsBoundary(filmOf().clips, dir > 0 ? idx + 1 : idx, dir * step * 4);
        if (r.delta) commit({ ...currentWork(), clips: r.clips }, `把${clipTitle(filmOf().clips[idx])}旁边的切点动了 ${fmtTenth(Math.abs(r.delta))} 秒`);
        return;
      }
      Timeline.seekTo(Math.max(0, Timeline.playhead() + dir * step));
    }
  }

  /* ---------------- 绑定与对外面 ---------------- */
  function bind(el) {
    host = el;
    board = (el.closest && el.closest('.tl-board')) || el;
    host.addEventListener('pointerdown', onPointerDownCapture, true);
    host.addEventListener('click', onClickCapture, true);
    host.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDoc);
  }
  function unbind() {
    if (host) {
      host.removeEventListener('pointerdown', onPointerDownCapture, true);
      host.removeEventListener('click', onClickCapture, true);
      host.removeEventListener('contextmenu', onContextMenu);
    }
    document.removeEventListener('keydown', onKeyDoc);
    closeCtx();
    host = null;
    sel.clear();
  }
  const onBoardRender = () => { paintSelection(); if (panelOpen) paintPanel(); };
  const clearSelection = () => { sel.clear(); paintSelection(); };

  /* 工具条上那三处状态（选中几条 / 关联是不是全连着 / 面板开没开）现读同一份真相，
     不另存一份 —— 存了就会和轨道上画着的那些各说各话。 */
  function toolState() {
    const f = filmOf();
    return {
      selected: sel.size,
      linkOn: (f.captions || []).length > 0 && allLinked(f),
      panelOn: panelOpen,
    };
  }

  return {
    bind, unbind, onBoardRender, dragBusy, toolAction, toolState,
    addSegmentAt, commit, patch: patchFilm, describeItem,
    openUndoWindow, closeUndoWindow,
    selected: () => Array.from(sel), clearSelection,
    focusOf: () => focus,
    selectItem, toggleMute,
  };
}
