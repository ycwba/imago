/* ============================================================================
   给外壳 / AI 助手的**时间线写入桥**（全项目只有这一份）
   ----------------------------------------------------------------------------
   助手不该靠 DOM 去点轨道上的按钮：那要「先 page_state 找按钮 → 再点」两步，
   而按钮本身还依赖「现在指着哪一块」这种界面态。桥只认**成片秒**（proj.film 的
   start/end 都是它），写只有两条出口 —— Edit.patch（画面段 / 配音）、
   Edit.toolAction（切开 / 删 / 复制 / 融合，与工具条同一批函数）、Caption.*（字幕一族）：
     · select   选一条候选进成片（= 候选上那颗「选用」）→ setSelectedCandidate
     · cut      切开 / 剪头 / 剪尾 / 删段 / 复制 / 融合 → Edit.toolAction
     · set      倍速 / 音量 / 静音 / 行 / 起止 / 滑移 / 滚切点 / 滑动 / 挪位 / 转场 / 字幕
     · undo     撤销 / 重做（Ctrl+Z / Ctrl+Y 的同一份栈）
   规矩：① 只在导演台**前台**可用；② 先 check（纯读）再 run，check 把这次动作的
   **身份**记下来（工程 id + 块 id），run 前按同样的参数重算一遍，身份对不上就拒 ——
   「你读的时候是这一段，动手时已经不是了」；③ 任何写入都在撤销窗口里（用户点完
   执行马上说「撤销」也退得回去）；④ 行锁着的块一律拒绝。
   页面那三条 UI 路径不经过这里 —— 这是给「外壳那一层」的唯一入口，不是第二套剪辑实现。
   两个点名例外写在参数名里：srcStart / srcEnd 是素材自己的源秒。桥自己不碰 proj.film 的
   字段、不留第二份剪辑账，check 与 run 两次解析之间靠**身份**对账（工程 id + 块 id），
   不靠修订号。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。
   ========================================================================== */
import { escHTML, num, round1, round2, ctxClip, spdTxt } from '../util.js';
import {
  LANE_MAX, MIN_CAPTION_SECONDS, MIN_CLIP_SECONDS,
  captionHighlighted, captionPositions, captionStyleOf, clamp, deriveTimeline,
  filmLaneOf, itemLocked, normalizeTransition, pos, rateOf, shiftTimed, srcHeadOf, srcLenOf,
  srcUsedOf, transitionNameOf, visibleCaptions, withPlaybackRate,
} from '../film.js';
import { canMergeClips } from '../tl-cut.js';
import {
  followCaptions, rollClipsBoundary, slipClip, slideClip,
  trimClipLeft, trimClipRight, trimVoiceLeft, trimVoiceRight,
} from '../tl-resize.js';
import { compactLanes, dropIndexAt, moveClipToLane, moveTimedToLane, reorderClips } from '../tl-reorder.js';
import { rippleDeltaOf } from '../tl-ripple.js';

export function createBridge(E, document, window) {
  const {
    ExportFormats,
    Timeline,
    Edit,
    Caption,
    projOf,
    filmOf,
    allShots,
    allProjects,
    scheduleSaveQuiet,
    curScene,
    curShot,
    undoStack,
    redoStack,
    UNDO_MAX_BYTES,
    UNDO_MAX_COUNT,
    undoBytesOf,
    undoSkipWhyOf,
    newestHistoryLabelOf,
    undo,
    redo,
    candDur,
    setSelectedCandidate,
    candTrackSrc,
    mediaInfo,
    renderAll,
    setStatus,
    Export,
  } = E;

(function () {
  const READY = () => { try { return !!(projOf() && projOf().scenes && allShots().length); } catch (e) { return false; } };
  /* 前台判据只有公共层那一份（core/activity.js，外壳挂在 window.__spaActivity）。
     只看路由的话，整个标签页切到后台时照样为真，助手就能在用户看不见的时候动时间线。 */
  const ACTIVE = () => {
    try { return window.__spaActivity.visible('director.html'); }
    catch (e) { return true; }
  };
  const capTxt = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const loose = msg => ({ ok: false, err: msg });
  /* 成片秒的读数写法：一律一位小数（0.1 秒是这一页的最短计量）。 */
  const sec = v => (Math.round(Math.max(0, num(v)) * 10) / 10).toFixed(1);
  const sgn = v => { const x = Math.round(num(v) * 10) / 10; return (x > 0 ? '+' : '') + x.toFixed(1); };
  const KIND_TRACK = { clip: 'image', voice: 'voice', cap: 'caption' };
  const KIND_ZH = { clip: '画面段', voice: '配音块', cap: '字幕' };
  const FIELD_ZH = { speed: '倍速', volume: '音量', muted: '静音', lane: '行', start: '起点', end: '终点',
    srcStart: '源窗口', srcEnd: '源窗口', slip: '滑移', roll: '滚动切点', slide: '滑动', moveTo: '挪位',
    transition: '转场', fadeIn: '淡入', fadeOut: '淡出' };
  const POS_ZH = { top: '顶部', middle: '居中', bottom: '底部' };
  function shotOf(a) {
    a = a || {};
    if (a.shotId != null && a.shotId !== '') {
      for (const sc of projOf().scenes) {
        const hit = (sc.shots || []).find(x => String(x.id) === String(a.shotId));
        if (hit) return { sc, sh: hit };
      }
      return loose('找不到镜头 id「' + a.shotId + '」：先用 page_state 看这一镜的 id');
    }
    if (a.shot != null) {
      const sc = (a.scene != null) ? projOf().scenes[Number(a.scene) - 1] : (projOf().scenes[projOf().curScene] || projOf().scenes[0]);
      if (!sc) return loose('找不到第 ' + a.scene + ' 个场景');
      const n = Number(a.shot);
      if (!Number.isInteger(n) || n < 1 || n > (sc.shots || []).length) {
        return loose('「' + sc.name + '」里没有第 ' + a.shot + ' 镜（一共 ' + (sc.shots || []).length + ' 镜）');
      }
      return { sc, sh: sc.shots[n - 1] };
    }
    const sc = curScene(), sh = curShot();
    return sh ? { sc, sh } : loose('当前没有镜头');
  }
  function candOf(sh, a, mode) {
    a = a || {};
    const list = sh.candidates || [];
    if (!list.length) return loose('「' + sh.name + '」还没有候选：先生成或导入一条视频');
    let i = -1;
    if (a.take != null) {
      const n = Number(a.take);
      if (!Number.isInteger(n) || n < 1 || n > list.length) {
        return loose('take 是第几条候选（1–' + list.length + '），给的是「' + a.take + '」');
      }
      i = n - 1;
    } else if (a.candId != null && a.candId !== '') {
      i = list.findIndex(c => String(c.vid) === String(a.candId));
      if (i < 0) {
        return loose('这一镜没有候选 id「' + a.candId + '」。现有：'
          + list.map((c, k) => '第' + (k + 1) + '条 ' + c.vid).join(' / '));
      }
    } else if (mode === 'selected') {
      i = list.findIndex(c => c.vid === sh.selId);
    }
    if (i < 0) i = Math.max(0, Math.min(list.length - 1, Number(projOf().curCand) || 0));
    return { i, c: list[i], list };
  }
  const hasPic = c => !!(c && c.status === 'succeeded' && c.url);
  function focus(sc, sh, ci) {
    const si = projOf().scenes.indexOf(sc), xi = (sc.shots || []).indexOf(sh);
    if (si >= 0) projOf().curScene = si;
    if (xi >= 0) projOf().curShot = xi;
    if (ci != null) projOf().curCand = Math.max(0, Math.min(ci, (sh.candidates || []).length - 1));
  }

  /* ---------- 块定位：三种指法（id / at 成片秒 / index 第几块）只有这一份 ----------
     返回统一的 { item, index, start, end }：画面段按 deriveTimeline 累加出 start/end，
     字幕按 start 排序，配音按 start + duration。 */
  function blocksOf(kind) {
    const f = filmOf();
    if (kind === 'clip') {
      return deriveTimeline(f.clips).rows.map(r => ({ item: r.clip, index: r.index, start: num(r.start), end: num(r.end) }));
    }
    if (kind === 'cap') {
      return (f.captions || []).slice().sort((x, y) => num(x.start) - num(y.start))
        .map((c, i) => ({ item: c, index: i, start: num(c.start), end: num(c.end) }));
    }
    const list = kind === 'voice' ? (f.voices || []) : [];
    return list.map((v, i) => ({ item: v, index: i, start: num(v.start), end: num(v.start) + num(v.duration) }));
  }
  /* 行号按打包口径现算：存下来的 `item.lane` 只是偏好，真正画在第几行由打包说了算。 */
  const lockWhy = (kind, item) => {
    const f = filmOf();
    const lane = filmLaneOf(f, kind, item && item.id);
    return lane >= 0 && itemLocked(f.tracks, KIND_TRACK[kind], lane)
      ? '这一块所在的行锁着：先在轨道左列把锁打开再试' : '';
  };
  function pick(a, kind) {
    a = a || {};
    const blocks = blocksOf(kind);
    if (!blocks.length) {
      return loose('成片里现在没有' + KIND_ZH[kind] + (kind === 'clip' ? '：先在候选卡上点「选用」接进几条' : ''));
    }
    if (a.id != null && a.id !== '') {
      const at = blocks.findIndex(b => String(b.item.id) === String(a.id));
      if (at < 0) return loose(KIND_ZH[kind] + '里没有 id「' + a.id + '」：先用 context / subtitle_list 看现存的块');
      return blocks[at];
    }
    if (a.at != null) {
      const t = num(a.at);
      const at = blocks.findIndex(b => t >= b.start - 0.001 && t < b.end - 0.001);
      return blocks[at >= 0 ? at : blocks.length - 1];
    }
    if (a.index != null) {
      const n = Number(a.index);
      if (!Number.isInteger(n) || n < 1 || n > blocks.length) {
        return loose('index 是第几块（1–' + blocks.length + '），给的是「' + a.index + '」');
      }
      return blocks[n - 1];
    }
    const f = Edit.focusOf();
    if (f && f.kind === kind && f.id) {
      const at = blocks.findIndex(b => String(b.item.id) === String(f.id));
      if (at >= 0) return blocks[at];
    }
    const t = num(Timeline.playhead());
    const at = blocks.findIndex(b => t >= b.start - 0.001 && t < b.end - 0.001);
    if (at >= 0) return blocks[at];
    return loose('指哪一块要说清：id / at（成片第几秒）/ index（第几块，1 起）。都不给就取播放头压着的那一块，现在没压在任何' + KIND_ZH[kind] + '上');
  }
  /* 一次写入前压一份撤销快照（多字段合并成一条历史），收尾时补一次重画与「成片变过」；
     select 走 setSelectedCandidate（那一侧不带快照），所以也包在窗里。 */
  function undoWindow(label, fn) {
    if (!Edit.openUndoWindow(label)) return loose('上一步编辑还没收尾，等一下再试');
    try { return fn(); } finally { Edit.closeUndoWindow(); }
  }

  /* ---------- select：把一条候选选进成片 ---------- */
  function selectPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) {
      return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条现在还不能选用（状态：'
        + (q.c.status || '未知') + '，没有可播放地址）。等它出了画面再选');
    }
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, already: s.sh.selId === q.c.vid };
  }

  /* ---------- cut：切开 / 剪头 / 剪尾 / 删段 / 复制 / 融合 ----------
     split / remove / duplicate / merge 与工具条同一批函数（选段 + 播放头 + toolAction），
     left / right 是「从 at 裁到段头 / 段尾」，走 tl-resize 的两把剪子直接落。 */
  const WAY_ZH = {
    split: '切开', left: '剪掉这一段开头那截', right: '剪掉这一段末尾那截',
    remove: '删掉这一段', duplicate: '复制这一段', merge: '与下一段融合',
  };
  function cutPlan(a) {
    a = a || {};
    const way = String(a.way || '').trim();
    if (!WAY_ZH[way]) return loose('way 只能是 split / left / right / remove / duplicate / merge');
    const b = pick(a, 'clip'); if (b.err) return b;
    const lock = lockWhy('clip', b.item); if (lock) return loose(lock);
    if (way === 'merge' && !canMergeClips(b.item, filmOf().clips[b.index + 1])) {
      return loose('相邻两段接不上（不同素材，或中间动过）');
    }
    let at = null;
    if (way === 'split' || way === 'left' || way === 'right') {
      at = a.at != null ? num(a.at) : num(Timeline.playhead());
      if (!(at > b.start + MIN_CLIP_SECONDS) || !(b.end - at > MIN_CLIP_SECONDS)) {
        return loose('at（' + sec(at) + ' 秒）要落在这一段里面（' + sec(b.start) + '–' + sec(b.end)
          + ' 秒），离两头都要留出最短时长（' + MIN_CLIP_SECONDS + ' 秒）');
      }
    }
    return { way, block: b, at: round2(at) };
  }
  /* toolAction 吃掉动作自己的布尔值，回执靠「段数 / 总长」对账：没变成预期形状就照实说没切成。 */
  function cutDelegated(p) {
    const id = p.block.item.id;
    if (!Edit.selectItem('clip', id)) return loose('这一段已经不在了：重新读 context 再来');
    const before = filmOf().clips.length;
    if (p.way === 'split') {
      Timeline.seekTo(p.at, { playNow: false });
      Edit.toolAction('cut');
    } else {
      Edit.toolAction(p.way === 'remove' ? 'delete' : p.way);
    }
    const after = filmOf().clips.length;
    const expect = { split: before + 1, duplicate: before + 1, remove: before - 1, merge: before - 1 }[p.way];
    if (after !== expect) {
      return { ok: false, err: '执行了但时间线没有变（看导演台状态行说的原因）：重新读 context 再试' };
    }
    const rows = deriveTimeline(filmOf().clips).rows;
    const name = Edit.describeItem('clip', id);
    let text = '';
    if (p.way === 'split') {
      const also = ['voice', 'cap'].map(kind => (blocksOf(kind).some(bl => p.at > bl.start + 0.0005 && p.at < bl.end - 0.0005) ? KIND_ZH[kind] : '')).filter(Boolean);
      text = '已在 ' + sec(p.at) + ' 秒处切开' + name + '：现在 ' + rows.length + ' 段'
        + (also.length ? '，同一时刻压着的' + also.join('、') + '也一并切开' : '');
    } else if (p.way === 'remove') {
      text = '已删掉' + name + '：成片现在 ' + rows.length + ' 段、共 ' + sec(rows.length ? rows[rows.length - 1].end : 0) + ' 秒';
    } else if (p.way === 'duplicate') {
      text = '已复制' + name + '，副本排在它后面';
    } else {
      text = '已把相邻两段融合成一段：成片现在 ' + rows.length + ' 段';
    }
    return { ok: true, text: text + '。要退回就说「撤销最近一步」。' };
  }

  /* ---------- set：改一块的属性 / 位置 / 源窗口 ----------
     几何改动（start / end / 源窗口 / slip / roll / slide / moveTo）一次只做一处；
     非几何的（speed / volume / muted / lane / transition / fadeIn / fadeOut）可以一起给。 */
  const GEO_KEYS = ['startAt', 'endAt', 'window', 'slip', 'roll', 'slide', 'moveTo'];
  function windowClip(a, it, kind) {
    const rate = rateOf(it);
    const head = srcHeadOf(it), used = srcUsedOf(it);
    const hi = Math.max(srcLenOf(it), head + used);
    if (!(hi > 0)) return { err: '这一块读不到素材原长，改不了源窗口：先在素材上重新取一次信息' };
    const minSrc = MIN_CLIP_SECONDS * rate;
    const na = clamp(pos(a.srcStart != null ? a.srcStart : head), 0, Math.max(0, hi - minSrc));
    const nb = clamp(pos(a.srcEnd != null ? a.srcEnd : head + used), na + minSrc, hi);
    const clamped = (a.srcStart != null && Math.abs(pos(a.srcStart) - na) > 0.001)
      || (a.srcEnd != null && Math.abs(pos(a.srcEnd) - nb) > 0.001);
    return { na: round2(na), nb: round2(nb), hi, clamped };
  }
  function setPlan(a) {
    a = a || {};
    const kind = String(a.kind || '');
    if (kind === 'subtitle') return subPlan(a);
    if (!KIND_ZH[kind]) return loose('kind 只能是 clip / voice / subtitle');
    const b = pick(a, kind); if (b.err) return b;
    const lock = lockWhy(kind, b.item); if (lock) return loose(lock);
    const it = b.item;
    const next = {};
    if (kind === 'clip') {
      if (a.speed != null) {
        if (it.kind === 'image') return loose('图片段没有倍速');
        const v = Number(a.speed);
        if (!Number.isFinite(v) || v < 0.25 || v > 4) return loose('speed 要在 0.25–4 之间（1 = 原速）');
        next.speed = Math.round(v * 100) / 100;
      }
      if (a.volume != null) {
        const v = Number(a.volume);
        if (!Number.isFinite(v) || v < 0 || v > 4) return loose('volume 要在 0–4 之间（1 = 原声，百分比请除以 100）');
        next.volume = Math.round(v * 100) / 100;
      }
      if (a.muted != null) {
        if (it.kind === 'image') return loose('图片段没有原声，静不了音');
        next.muted = !!a.muted;
      }
      if (a.lane != null) {
        const n = Number(a.lane);
        if (!Number.isInteger(n) || n < 0 || n >= LANE_MAX) return loose('lane 要是 0–' + (LANE_MAX - 1) + ' 的整数（画在第几行）');
        next.lane = n;
      }
      if (a.start != null) {
        const at = num(a.start);
        if (at <= b.start + 0.0005) return loose('起点不能往左挪：start 只能往后裁，要整体挪位置用 moveTo');
        if (!(at < b.end - MIN_CLIP_SECONDS)) return loose('start 裁得太狠：段的末尾至少要留 ' + MIN_CLIP_SECONDS + ' 秒');
        next.startAt = at;
      }
      if (a.end != null) {
        const at = num(a.end);
        if (!(at > b.start + MIN_CLIP_SECONDS)) return loose('end 太靠前：段的开头至少要留 ' + MIN_CLIP_SECONDS + ' 秒');
        next.endAt = at;
      }
      if (a.srcStart != null || a.srcEnd != null) {
        if (it.kind === 'image') return loose('图片段没有源窗口：srcStart / srcEnd 只对视频段有效');
        const w = windowClip(a, it, kind); if (w.err) return loose(w.err);
        next.window = w;
      }
      if (a.slip != null) {
        if (it.kind === 'image') return loose('图片段滑不动');
        next.slip = num(a.slip);
      }
      if (a.roll != null) {
        if (!(b.index + 1 < filmOf().clips.length)) return loose('这一段是最后一段：roll 需要后面有下一段');
        next.roll = num(a.roll);
      }
      if (a.slide != null) {
        if (!(b.index > 0 && b.index + 1 < filmOf().clips.length)) return loose('滑动要左右两段都有邻居');
        next.slide = num(a.slide);
      }
      if (a.moveTo != null) {
        if (!(num(a.moveTo) >= 0)) return loose('moveTo 要是成片第几秒（0 起）');
        next.moveTo = num(a.moveTo);
      }
      if (a.transition !== undefined && a.transition !== null) {
        if (!(b.index + 1 < filmOf().clips.length)) return loose('这是最后一段：没有下一段可接转场');
        next.transition = typeof a.transition === 'string' ? { id: a.transition } : a.transition;
      }
    } else {
      if (a.speed != null) {
        const v = Number(a.speed);
        if (!Number.isFinite(v) || v < 0.25 || v > 4) return loose('speed 要在 0.25–4 之间（1 = 原速）');
        next.speed = Math.round(v * 100) / 100;
      }
      if (a.volume != null) {
        const v = Number(a.volume);
        if (!Number.isFinite(v) || v < 0 || v > 4) return loose('volume 要在 0–4 之间（1 = 原声，百分比请除以 100）');
        next.volume = Math.round(v * 100) / 100;
      }
      if (a.fadeIn != null || a.fadeOut != null) {
        if (a.fadeIn != null) {
          const v = Math.max(0, num(a.fadeIn));
          if (v > num(it.duration) / 2) return loose('fadeIn 要在 0–' + sec(num(it.duration) / 2) + ' 秒之间');
          next.fadeIn = round2(v);
        }
        if (a.fadeOut != null) {
          const v = Math.max(0, num(a.fadeOut));
          if (v > num(it.duration) / 2) return loose('fadeOut 要在 0–' + sec(num(it.duration) / 2) + ' 秒之间');
          next.fadeOut = round2(v);
        }
      }
      if (a.muted != null) return loose(KIND_ZH[kind] + '没有「静音」这一项：要它不出声用 volume: 0');
      if (a.lane != null) {
        const n = Number(a.lane);
        if (!Number.isInteger(n) || n < 0 || n >= LANE_MAX) return loose('lane 要是 0–' + (LANE_MAX - 1) + ' 的整数（画在第几行）');
        next.lane = n;
      }
      if (a.start != null) {
        if (!(num(a.start) >= 0)) return loose('start 要是成片第几秒（0 起）');
        next.startAt = num(a.start);
      }
      if (a.end != null) {
        const at = num(a.end);
        if (!(at > b.start + MIN_CLIP_SECONDS)) return loose('end 太靠前：块的开头至少要留 ' + MIN_CLIP_SECONDS + ' 秒');
        next.endAt = at;
      }
      if (a.srcStart != null || a.srcEnd != null) {
        const w = windowClip(a, it, kind); if (w.err) return loose(w.err);
        next.window = w;
      }
      const clipOnly = ['slip', 'roll', 'slide', 'moveTo'].find(k => a[k] != null);
      if (clipOnly) return loose(KIND_ZH[kind] + '没有「' + clipOnly + '」：这些只对画面段有效');
      if (a.transition !== undefined) return loose(KIND_ZH[kind] + '没有转场：转场挂在画面段与下一段之间');
    }
    const fields = Object.keys(next);
    if (!fields.length) {
      return loose('要改什么没说：' + (kind === 'clip'
        ? 'speed / volume / muted / lane / start / end / srcStart·srcEnd / slip / roll / slide / moveTo / transition 至少给一项'
        : 'speed / volume / fadeIn / fadeOut / lane / start / end / srcStart·srcEnd 至少给一项'));
    }
    const geo = fields.filter(k => GEO_KEYS.includes(k));
    if (geo.length > 1 || (geo.length === 1 && fields.length > 1)) {
      return loose('几何改动（start / end / srcStart·srcEnd / slip / roll / slide / moveTo）一次只做一处，也不与别的字段混给');
    }
    return { kind, block: b, it, next, fields };
  }
  function setRun(p, a) {
    if (p.kind === 'subtitle') return subRun(p, a);
    const { kind, block, it, next, fields } = p;
    const id = it.id;
    const desc = Edit.describeItem(kind, id);
    const multi = fields.length > 1;
    const w = multi ? undoWindow('AI 改' + KIND_ZH[kind] + '（' + fields.map(k => FIELD_ZH[k] || k).join('、') + '）', () => null) : null;
    if (w && w.err) return w;
    try {
      const bits = [];
      /* muted 走编辑器自己的 toggleMute（它的标签就是「静音 / 恢复 … 的原声」）；
         状态确实变了才调，别的字段照常走同一次 patch。 */
      if (next.muted != null && !!block.item.muted !== next.muted) {
        if (!Edit.toggleMute(id)) return loose('静音没改成（图片段没有原声）');
        bits.push(next.muted ? '原声静音' : '取消静音');
      }
      const f = filmOf();
      const key = kind === 'clip' ? 'clips' : 'voices';
      const list = (f[key] || []).slice();
      const idx = list.findIndex(x => x && x.id === id);
      if (idx < 0) return loose('这一块已经不在了：重新读 context 再来');
      let cur = list[idx];
      let patchData = null;
      let label = '';
      if (kind === 'clip') {
        if (next.speed != null) { cur = withPlaybackRate(cur, next.speed); bits.push('倍速 → ' + spdTxt(next.speed)); }
        if (next.volume != null) { cur = { ...cur, volume: next.volume }; bits.push('原声 → ' + Math.round(next.volume * 100) + '%'); }
        if (next.transition !== undefined) {
          const t = next.transition ? normalizeTransition(next.transition, cur, list[idx + 1] || null) : null;
          cur = { ...cur, transition: t || null };
          const wanted = next.transition && next.transition.duration;
          bits.push('转场 → ' + (t ? transitionNameOf(t.id) + ' ' + sec(t.duration) + ' 秒'
            + (wanted != null && Math.abs(num(wanted) - num(t.duration)) > 0.001 ? '（时长按两段的长度夹到这里）' : '') : '无'));
        }
        if (next.lane != null) {
          const r = moveClipToLane(list.map(x => (x && x.id === id ? cur : x)), id, next.lane);
          if (!r.moved) bits.push('行不变（已经在第 ' + (num(cur.ln) + 1) + ' 行）');
          else { bits.push('挪到第 ' + (next.lane + 1) + ' 行'); patchData = { clips: r.clips }; }
        }
        if (!patchData) patchData = { clips: list.map(x => (x && x.id === id ? cur : x)) };
        label = '把' + desc + '的' + fields.map(k => FIELD_ZH[k] || k).join('、') + '改掉（' + bits.join(' · ') + '）';
      } else {
        if (next.speed != null) { cur = withPlaybackRate(cur, next.speed); bits.push('倍速 → ' + spdTxt(next.speed) + '（折回成片里占 ' + sec(srcUsedOf(cur) / rateOf(cur)) + ' 秒）'); }
        if (next.volume != null) { cur = { ...cur, volume: next.volume }; bits.push('音量 → ' + Math.round(next.volume * 100) + '%'); }
        if (next.fadeIn != null) { cur = { ...cur, fadeIn: next.fadeIn }; bits.push('淡入 → ' + sec(next.fadeIn) + ' 秒'); }
        if (next.fadeOut != null) { cur = { ...cur, fadeOut: next.fadeOut }; bits.push('淡出 → ' + sec(next.fadeOut) + ' 秒'); }
        if (next.lane != null) {
          const merged = moveTimedToLane((f.voices || []), id, next.lane);
          if (!merged.moved) return loose('就在第 ' + (next.lane + 1) + ' 行：没有要挪的');
          const byId = new Map(compactLanes(merged.items).items.map(x => [x.id, Math.max(0, Math.round(pos(x.lane)))]));
          patchData = {
            voices: (f.voices || []).map(x => (x && byId.has(x.id) ? { ...x, lane: byId.get(x.id) } : x)),
          };
          bits.push('挪到第 ' + (byId.get(id) + 1) + ' 行');
        }
        if (!patchData) patchData = { [key]: list.map(x => (x && x.id === id ? cur : x)) };
        label = '把' + desc + '的' + fields.map(k => FIELD_ZH[k] || k).join('、') + '改掉（' + bits.join(' · ') + '）';
      }
      Edit.patch(patchData, label);
      return { ok: true, text: '已改' + desc + '：' + bits.join(' · ') + '。要退回就说「撤销最近一步」。' };
    } finally { if (multi) Edit.closeUndoWindow(); }
  }
  /* 几何改动各走各的（一次一处），每一处都是一次独立的 commit 与一条历史。 */
  function setGeo(p, a) {
    const { kind, block, it, next, fields } = p;
    const id = it.id;
    const desc = Edit.describeItem(kind, id);
    const f = filmOf();
    const key = kind === 'clip' ? 'clips' : 'voices';
    const list = (f[key] || []).slice();
    const idx = list.findIndex(x => x && x.id === id);
    if (idx < 0) return loose('这一块已经不在了：重新读 context 再来');
    const cur = list[idx];
    const replace = out => ({ [key]: list.map(x => (x && x.id === id ? out : x)) });
    if (next.window) {
      const w = next.window;
      const rate = rateOf(cur), head = srcHeadOf(cur), used = srcUsedOf(cur);
      const mid = (kind === 'clip' ? trimClipLeft(cur, (w.na - head) / rate) : trimVoiceLeft(cur, (w.na - head) / rate)) || cur;
      const out = (kind === 'clip' ? trimClipRight(mid, (w.nb - srcHeadOf(mid) - srcUsedOf(mid)) / rate)
        : trimVoiceRight(mid, (w.nb - srcHeadOf(mid) - srcUsedOf(mid)) / rate)) || mid;
      if (pos(out.sourceStart) === pos(cur.sourceStart) && pos(out.sourceDuration) === pos(cur.sourceDuration)
        && pos(out.start) === pos(cur.start) && pos(out.duration) === pos(cur.duration)) {
        return { ok: true, text: '源窗口没有变化，没有动任何数据' };
      }
      let label = '把' + desc + '的保留片段改成素材 ' + round1(pos(out.sourceStart)) + '–'
        + round1(pos(out.sourceStart) + pos(out.sourceDuration)) + ' 源秒';
      if (w.clamped) label += '（已按这一条素材能用的范围 0–' + round1(w.hi) + ' 秒截断）';
      const data = replace(out);
      if (kind === 'voice') data.captions = followCaptions(f.captions || [], id, cur, out);
      Edit.patch(data, label);
      return { ok: true, text: '已把' + desc + '的保留片段改成素材 ' + round1(pos(out.sourceStart)) + '–'
        + round1(pos(out.sourceStart) + pos(out.sourceDuration)) + ' 源秒'
        + (w.clamped ? '（按素材能用的范围截过）' : '') + '。要退回就说「撤销最近一步」。' };
    }
    if (next.startAt != null) {
      if (kind === 'clip') {
        const d = round2(next.startAt - block.start);
        const out = trimClipLeft(cur, d);
        if (!out) return loose('这一刀裁不下去（剩下的不足最短时长）');
        Edit.patch(replace(out), '把' + desc + '开头 ' + sec(d) + ' 秒裁掉');
        return { ok: true, text: '已把' + desc + '的开头裁掉 ' + sec(d) + ' 秒：现在从 ' + sec(block.start) + ' 不变、到 ' + sec(block.start + num(out.duration)) + ' 秒。要退回就说「撤销最近一步」。' };
      }
      const d = round2(next.startAt - block.start);
      if (!d) return { ok: true, text: 'start 就是现在的位置，没有动任何数据' };
      const out = shiftTimed(cur, d);
      const data = replace(out);
      data.captions = followCaptions(f.captions || [], id, cur, out);
      Edit.patch(data, '把' + desc + '挪到 ' + sec(next.startAt) + ' 秒处');
      return { ok: true, text: '已把' + desc + '挪到 ' + sec(next.startAt) + ' 秒处（长 ' + sec(num(out.duration)) + ' 秒）。要退回就说「撤销最近一步」。' };
    }
    if (next.endAt != null) {
      const d = round2(next.endAt - block.end);
      const out = kind === 'clip' ? trimClipRight(cur, d) : trimVoiceRight(cur, d);
      if (!out) {
        return loose(d > 0 ? '拉不长：' + (kind === 'clip' ? '素材原长就到这里' : '这条配音的素材原长就到这里') + '（或最少要留 ' + MIN_CLIP_SECONDS + ' 秒）'
          : '裁不下去：剩下的不足最短时长（' + MIN_CLIP_SECONDS + ' 秒）');
      }
      let label = '把' + desc + (d > 0 ? '拉长' : '裁短') + '到 ' + sec(block.start) + '–' + sec(next.endAt) + ' 秒';
      let data = replace(out);
      let ripple = null;
      if (kind === 'clip') {
        ripple = { boundary: block.end, delta: rippleDeltaOf(block.end, block.start + num(out.duration)) };
      } else {
        data.captions = followCaptions(f.captions || [], id, cur, out);
      }
      Edit.patch(data, label, ripple);
      return { ok: true, text: '已把' + desc + (d > 0 ? '拉长' : '裁短') + '到 ' + sec(block.start) + '–' + sec(block.start + num(out.duration)) + ' 秒。要退回就说「撤销最近一步」。' };
    }
    if (next.slip != null) {
      const r = slipClip(cur, next.slip);
      if (!r.delta) return loose('滑不动：源窗口能滑的范围是 ' + sgn(r.bounds.minimum) + ' 到 ' + sgn(r.bounds.maximum) + ' 秒');
      Edit.patch(replace(r.clip), '把' + desc + '的源窗口滑移 ' + sgn(r.delta) + ' 秒');
      return { ok: true, text: '已把' + desc + '的源窗口滑移 ' + sgn(r.delta) + ' 秒（画面出现在成片的时刻不变，换的是素材里的哪一段）。要退回就说「撤销最近一步」。' };
    }
    if (next.roll != null) {
      const r = rollClipsBoundary(list, idx + 1, next.roll);
      if (!r.delta) return loose('切点推不动：能动的范围是 ' + sgn(r.bounds.minimum) + ' 到 ' + sgn(r.bounds.maximum) + ' 秒');
      const rightName = Edit.describeItem('clip', list[idx + 1] && list[idx + 1].id);
      Edit.patch({ clips: r.clips }, '把' + desc + '与' + rightName + '之间的切点平移 ' + sgn(r.delta) + ' 秒');
      const rows = deriveTimeline(filmOf().clips).rows;
      const L = rows[idx], R = rows[idx + 1];
      return { ok: true, text: '已把' + desc + '与' + rightName + '之间的切点平移 ' + sgn(r.delta) + ' 秒：左边一段现在 '
        + sec(L.start) + '–' + sec(L.end) + ' 秒、右边一段 ' + sec(R.start) + '–' + sec(R.end) + ' 秒。要退回就说「撤销最近一步」。' };
    }
    if (next.slide != null) {
      const r = slideClip(list, idx, next.slide);
      if (!r.delta) return loose('滑不动：能动的范围由左右两段的长度决定（' + sgn(r.bounds.minimum) + ' 到 ' + sgn(r.bounds.maximum) + ' 秒）');
      Edit.patch({ clips: r.clips }, '把' + desc + '在时间线上滑动 ' + sgn(r.delta) + ' 秒');
      const rows = deriveTimeline(filmOf().clips).rows;
      return { ok: true, text: '已把' + desc + '滑到 ' + sec(rows[idx].start) + '–' + sec(rows[idx].end) + ' 秒'
        + '（这一段的长度与内容都不变，前后两段跟着换位）。要退回就说「撤销最近一步」。' };
    }
    if (next.moveTo != null) {
      const time = round2(num(next.moveTo));
      const rows = deriveTimeline(list).rows;
      const to = dropIndexAt(rows, time, idx);
      const r = reorderClips(list, idx, to);
      if (r.index === idx) return { ok: true, text: '落点就在原位（第 ' + (idx + 1) + ' 位），没有动任何数据' };
      const outRows = deriveTimeline(r.clips).rows;
      const self = outRows[outRows.findIndex(x => x.clip && x.clip.id === id)];
      Edit.patch({ clips: r.clips }, '把' + desc + '挪到 ' + sec(time) + ' 秒处（第 ' + (self.index + 1) + ' 位）');
      return { ok: true, text: '已把' + desc + '从第 ' + (idx + 1) + ' 位挪到第 ' + (self.index + 1) + ' 位：现在占 '
        + sec(self.start) + '–' + sec(self.end) + ' 秒（这一段本身没被剪）。要退回就说「撤销最近一步」。' };
    }
    return loose('没有落到的几何分支');
  }

  /* ---------- set 的字幕分支：单条（id + 字段）与整轨（entries / SRT / 重切 / 补齐） ----------
     字幕的时间就是成片秒（film.captions 的 start/end），没有第二把尺子；
     单条可多字段一起给（一个撤销窗一条历史），整轨内容改动一次只做一样。 */
  const SUB_FIELDS = ['text', 'start', 'end', 'position', 'highlight', 'remove'];
  function subPlan(a) {
    a = a || {};
    if (a.id != null && a.id !== '') {
      const b = pick({ id: a.id }, 'cap'); if (b.err) return b;
      const fields = SUB_FIELDS.filter(k => a[k] !== undefined && a[k] !== null);
      if (!fields.length) return loose('改这一条字幕的什么没说：text / start / end / position（top·middle·bottom）/ highlight / remove 至少给一项');
      if (a.remove != null && fields.length > 1) return loose('remove 是把这一条删掉：不要与别的字段一起给');
      const next = {};
      for (const k of fields) {
        if (k === 'text') {
          const v = String(a.text == null ? '' : a.text);
          if (!v.trim()) return loose('text 不能是空串（要删掉这一条用 remove: true）');
          next.text = v;
        } else if (k === 'start' || k === 'end') {
          const v = num(a[k]);
          if (!(v >= 0)) return loose(k + ' 要是成片第几秒（0 起），给的是「' + a[k] + '」');
          next[k] = v;
        } else if (k === 'position') {
          if (!POS_ZH[a.position]) return loose('position 只能是 top / middle / bottom');
          next.position = a.position;
        } else if (k === 'highlight') next.highlight = !!a.highlight;
        else next.remove = !!a.remove;
      }
      return { kind: 'subtitle', mode: 'targeted', target: b.item, next, fields };
    }
    const content = [];
    if (a.entries !== undefined) content.push('entries');
    if (a.text != null && a.text !== '') content.push('text');
    if (a.maxChars !== undefined) content.push('maxChars');
    if (a.regenerate !== undefined) content.push('regenerate');
    if (!content.length) {
      return loose('要改字幕的什么没说：单条给 id + text/start/end/position/highlight/remove；'
        + '整轨给 entries（成片秒条目）/ text（SRT 文本）/ maxChars（按字数重切）/ regenerate（按配音补齐）其中一样');
    }
    if (content.length > 1) return loose('整轨的内容改动一次只做一样：entries / text（SRT）/ maxChars / regenerate 互斥');
    const mode = content[0];
    if (mode === 'entries') {
      const rows = a.entries;
      if (!Array.isArray(rows) || !rows.length) return loose('entries 要是非空数组：[{text, start, end, position?}]，时间是成片秒');
      if (rows.length > 5000) return loose('字幕一次最多 5000 条');
      for (let i = 0; i < rows.length; i++) {
        const e = rows[i] || {};
        if (!String(e.text == null ? '' : e.text).trim()) return loose('第 ' + (i + 1) + ' 条字幕没有文字');
        const s = num(e.start), t = num(e.end);
        if (!Number.isFinite(s) || !Number.isFinite(t)) return loose('第 ' + (i + 1) + ' 条的 start/end 要是成片秒的数字');
        if (t <= s) return loose('第 ' + (i + 1) + ' 条的 end 必须大于 start');
        if (e.position != null && !POS_ZH[e.position]) return loose('第 ' + (i + 1) + ' 条的 position 只能是 top / middle / bottom');
      }
    } else if (mode === 'text') {
      if (String(a.text).indexOf('-->') < 0) return loose('这段不像 SRT：时间行要写成 00:00:00,000 --> 00:00:02,000（改单条的字用 id + text）');
    } else if (mode === 'maxChars') {
      const n = Number(a.maxChars);
      if (!Number.isInteger(n) || n < 1 || n > 500) return loose('maxChars 是每行最多几个字（1–500 的整数）');
    }
    return { kind: 'subtitle', mode, arg: a };
  }
  function subRun(p) {
    if (p.mode === 'targeted') {
      const id = p.target.id;
      const name = Edit.describeItem('cap', id);
      const bits = [];
      const wrap = p.fields.length > 1;
      if (wrap && !Edit.openUndoWindow('AI 改字幕' + name)) return loose('上一步编辑还没收尾，等一下再试');
      try {
        for (const k of p.fields) {
          let ok = false;
          if (k === 'text') { ok = Caption.capSetText(id, p.next.text); if (ok) bits.push('文字 → 「' + ctxClip(p.next.text, 20) + '」'); }
          else if (k === 'start') { ok = Caption.capSetTime(id, 'start', p.next.start); if (ok) bits.push('起点 → ' + sec(p.next.start) + ' 秒'); }
          else if (k === 'end') { ok = Caption.capSetTime(id, 'end', p.next.end); if (ok) bits.push('终点 → ' + sec(p.next.end) + ' 秒'); }
          else if (k === 'position') {
            ok = Caption.capSetStyle(id, { position: p.next.position }, '位置改成「' + POS_ZH[p.next.position] + '」');
            if (ok) bits.push('位置 → ' + POS_ZH[p.next.position]);
          } else if (k === 'highlight') {
            ok = Caption.capSetStyle(id, { style: captionStyleOf(p.next.highlight) }, (p.next.highlight ? '加上' : '去掉') + '高亮底');
            if (ok) bits.push(p.next.highlight ? '加上高亮底' : '去掉高亮底');
          } else if (k === 'remove') { ok = Caption.capDelete(id); if (ok) bits.push('删掉这一条'); }
        }
        if (!bits.length) return { ok: true, text: '这些字段本来就是那个值，没有动任何数据' };
        return { ok: true, text: '已改字幕' + name + '：' + bits.join(' · ') + '。要退回就说「撤销最近一步」。' };
      } finally { if (wrap) Edit.closeUndoWindow(); }
    }
    if (p.mode === 'entries') {
      const r = Caption.capAddEntries(p.arg.entries);
      if (!r.ok) return loose(r.why || '没有写进任何字幕');
      return { ok: true, text: '已新增 ' + r.count + ' 条字幕（全片现在 ' + r.total + ' 条）：时间是成片秒，直接对着整条时间线写 start/end。要退回就说「撤销最近一步」。' };
    }
    if (p.mode === 'text') {
      const r = Caption.capImportSrtText(p.arg.text, p.arg.name || '助手导入');
      if (!r.ok) return loose(r.why || 'SRT 没有导入');
      return { ok: true, text: '已导入 SRT：并入 ' + r.count + ' 条、全片现在 ' + r.total + ' 条（文件里的时间按成片秒直接用）。要退回就说「撤销最近一步」。' };
    }
    if (p.mode === 'maxChars') {
      const n = Number(p.arg.maxChars);
      const before = (filmOf().captions || []).length;
      if (!Caption.capResegment(n)) {
        return loose('没有切出更多条：字幕轨是空的，或每行已经不超过 ' + Math.max(8, Math.min(120, n)) + ' 个字');
      }
      const after = (filmOf().captions || []).length;
      return { ok: true, text: '已按每行 ' + n + ' 字把长字幕重切：' + before + ' 条 → ' + after + ' 条（内容不变，时间按字数比例分）。要退回就说「撤销最近一步」。' };
    }
    const before = (filmOf().captions || []).length;
    if (!Caption.capGenerate()) {
      return loose('没有补出新的字幕：配音轨上没有带字的块，或每一句都已经有字幕挂着（要改字给 id 单条改）');
    }
    const after = (filmOf().captions || []).length;
    return { ok: true, text: '已按配音补出 ' + (after - before) + ' 条字幕（全片现在 ' + after
      + ' 条）：每条接在自己那句上，之后块挪位字幕跟着走。要退回就说「撤销最近一步」。' };
  }

  /* ---------- 只读口：字幕清单 / SRT 文本 / 撤销栈 ---------- */
  function subtitleInfo(a) {
    a = a || {};
    const f = filmOf();
    const got = visibleCaptions(f);
    let rows = got.list;
    if (a.id != null && a.id !== '') rows = rows.filter(c => String(c.id) === String(a.id));
    if (a.voiceId != null && a.voiceId !== '') rows = rows.filter(c => String(c.voiceId || '') === String(a.voiceId));
    const out = {
      时间基准: 'film',
      全轨: (f.captions || []).length,
      条数: rows.length,
      跳过: { 被眼睛藏掉: (got.skipped && got.skipped.hidden) || 0, 没有字: (got.skipped && got.skipped.empty) || 0 },
      条目: rows.slice(0, 200).map((c, i) => ({ 序: i + 1, id: c.id, start: num(c.start), end: num(c.end),
        text: c.text, 位置: c.position || 'bottom', 高亮: (c.style || 'default') !== 'plain', 挂着: c.voiceId || '' })),
    };
    if (rows.length > 200) out.说明 = '只列出前 200 条（共 ' + rows.length + ' 条）：用 id 过滤看单条';
    return out;
  }
  function srtOut() {
    const got = Caption.capSrtText({ bom: false, crlf: false });
    return { ok: true, 条数: got.条数, 跳过: got.跳过, 时间基准: 'film', text: got.text };
  }
  function undoPlan(a) {
    a = a || {};
    const mode = String(a.mode || 'undo') === 'redo' ? 'redo' : 'undo';
    const steps = Math.max(1, Math.min(5, Number(a.steps) || 1));
    const n = mode === 'redo' ? redoStack.length : undoStack.length;
    if (!n) {
      return loose(mode === 'redo' ? '没有可重做的操作'
        : ('可撤销的已经用完了' + (undoSkipWhyOf() ? '（' + undoSkipWhyOf() + '）' : '')));
    }
    return { kind: 'undo', mode, steps: Math.min(steps, n), n };
  }

  /* left / right 不走工具条（工具条的剪子认播放头）：直接用 tl-resize 那两把剪子裁这一段。
     剪尾带波纹（后面开跑的定时块跟着挪），剪头不带（起点是累加出来的，前面没有「边界之后」）。 */
  function cutTrim(p) {
    const b = p.block, it = b.item;
    const name = Edit.describeItem('clip', it.id);
    const d = round2(p.way === 'left' ? p.at - b.start : b.end - p.at);
    const out = p.way === 'left' ? trimClipLeft(it, d) : trimClipRight(it, d);
    if (!out) return loose('这一刀裁不下去（剩下的不足最短时长 ' + MIN_CLIP_SECONDS + ' 秒）');
    const f = filmOf();
    const data = { clips: (f.clips || []).map(x => (x && x.id === it.id ? out : x)) };
    let ripple = null;
    if (p.way === 'right') ripple = { boundary: b.end, delta: rippleDeltaOf(b.end, b.start + num(out.duration)) };
    Edit.patch(data, '把' + name + (p.way === 'left' ? '开头 ' : '末尾 ') + sec(d) + ' 秒裁掉', ripple);
    return { ok: true, changedIds: [it.id],
      text: '已把' + name + (p.way === 'left' ? '的开头裁掉 ' : '的末尾裁掉 ') + sec(d) + ' 秒：这一段现在 '
        + sec(b.start) + '–' + sec(b.start + num(out.duration)) + ' 秒。要退回就说「撤销最近一步」。' };
  }

  /* ---------- check / run：身份对账（不再有修订号） ----------
     check 把「这一次要动谁」按身份记在 lastCheck；run 先按同一份参数再解析一遍 plan，
     两边的目标对不上（换工程 / 块被删或换了）就当场拒掉，让模型按新状态重读。
     用户批准的是那一块，不是「第几块」—— 下标是活的，id 才是身份。 */
  let lastCheck = null;
  function targetOf(p) {
    if (!p || p.err) return null;
    if (p.kind === 'select') return ['select', (p.sh && p.sh.id) || '', (p.c && p.c.vid) || ''];
    if (p.kind === 'cut') return ['cut', (p.block && p.block.item && p.block.item.id) || ''];
    if (p.kind === 'subtitle') return ['subtitle', p.mode === 'targeted' ? ((p.target && p.target.id) || '') : p.mode];
    if (p.kind === 'undo') return ['undo'];
    return ['set', p.kind, (p.it && p.it.id) || ''];
  }
  const sameTarget = (x, y) => JSON.stringify(x || null) === JSON.stringify(y || null);
  function planOf(op, a) {
    if (op === 'select') return selectPlan(a);
    if (op === 'cut') return cutPlan(a);
    if (op === 'set') return setPlan(a);
    if (op === 'undo') return undoPlan(a);
    return loose('不认识的时间线动作：' + op);
  }
  function dirCheck(op, a) {
    if (!ACTIVE()) return loose('当前不在导演台：切到导演台再让我动时间线（别切走之后让我盲改）');
    if (!READY()) return loose('导演台还没加载完，等这一页画出来再说');
    try {
      const p = planOf(op, a);
      if (p.err) { lastCheck = null; return p; }
      lastCheck = { op, target: targetOf(p) };
      if (op === 'select') {
        return { ok: true,
          text: '把「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选设为选用' + (p.already ? '（现在已经是）' : ''),
          lines: ['镜头：' + capTxt(p.sh.name, 40) + (p.sc ? '（' + capTxt(p.sc.name, 20) + '）' : ''),
            '候选：第 ' + (p.i + 1) + ' / ' + (p.sh.candidates || []).length + ' 条 · ' + round1(candDur(p.c, p.sh)) + ' 秒',
            '状态：' + (p.c.status || '未知'),
            '动作：设为选用 —— 成片里这一镜的片段换成这一条' + (p.already ? '（已经是，执行不会改任何东西）' : '')] };
      }
      if (op === 'cut') {
        const b = p.block;
        const delta = { split: 1, remove: -1, duplicate: 1, merge: -1 }[p.way] || 0;
        const keep = p.way === 'left' ? '保留：从 ' + sec(p.at) + ' 到 ' + sec(b.end) + ' 秒'
          : p.way === 'right' ? '保留：从 ' + sec(b.start) + ' 到 ' + sec(p.at) + ' 秒'
          : '这一段正压着成片的这一截，剪它成片就变';
        return { ok: true,
          text: WAY_ZH[p.way] + '：' + (Edit.describeItem('clip', b.item.id) || KIND_ZH.clip),
          lines: ['这一段：' + sec(b.start) + '–' + sec(b.end) + ' 秒',
            '剪法：' + WAY_ZH[p.way] + (p.way === 'split' || p.way === 'left' || p.way === 'right' ? '（在 ' + sec(p.at) + ' 秒处）' : ''),
            keep,
            '剪完：成片 ' + (filmOf().clips.length + delta) + ' 段'] };
      }
      if (op === 'set') {
        if (p.kind === 'subtitle') {
          if (p.mode === 'targeted') {
            return { ok: true,
              text: '改字幕' + (Edit.describeItem('cap', p.target.id) || '（一条）') + '：' + p.fields.map(k => FIELD_ZH[k] || k).join('、'),
              lines: ['这一条：' + sec(num(p.target.start)) + '–' + sec(num(p.target.end)) + ' 秒 · 「' + ctxClip(p.target.text, 30) + '」',
                '改成：' + p.fields.map(k => (k === 'position' ? '位置 → ' + POS_ZH[p.next.position]
                  : k === 'highlight' ? (p.next.highlight ? '加上高亮底' : '去掉高亮底')
                  : k === 'text' ? '文字 → 「' + ctxClip(p.next.text, 20) + '」'
                  : k === 'remove' ? '删掉这一条'
                  : k + ' → ' + sec(p.next[k]) + ' 秒')).join(' · ')] };
          }
          const zh = { entries: '新增 ' + (p.arg.entries || []).length + ' 条字幕（成片秒）',
            text: '导入一段 SRT（时间按成片秒直接用）',
            maxChars: '按每行 ' + p.arg.maxChars + ' 字重切长字幕',
            regenerate: '按配音补齐缺字幕的句子' };
          return { ok: true, text: '整轨字幕改动：' + zh[p.mode],
            lines: ['现在全轨：' + (filmOf().captions || []).length + ' 条', '动作：' + zh[p.mode]] };
        }
        return { ok: true,
          text: '改' + KIND_ZH[p.kind] + '（' + (Edit.describeItem(p.kind, p.it.id) || KIND_ZH[p.kind]) + '）的' + p.fields.map(k => FIELD_ZH[k] || k).join('、'),
          lines: ['这一块：' + (p.kind === 'clip'
              ? sec(p.block.start) + '–' + sec(p.block.end) + ' 秒'
              : sec(num(p.it.start)) + '–' + sec(num(p.it.start) + num(p.it.duration)) + ' 秒'),
            '改成：' + p.fields.map(k => {
              if (k === 'speed') return '倍速 → ' + spdTxt(p.next.speed);
              if (k === 'volume') return '音量 → ' + Math.round(p.next.volume * 100) + '%';
              if (k === 'muted') return p.next.muted ? '原声静音' : '取消静音';
              if (k === 'lane') return '行 → 第 ' + (p.next.lane + 1) + ' 行';
              if (k === 'transition') return '转场 → ' + (p.next.transition ? p.next.transition.id : '无');
              return k + ' → ' + p.next[k];
            }).join(' · ')] };
      }
      return { ok: true, text: (p.mode === 'redo' ? '重做 ' : '撤销 ') + p.steps + ' 步',
        lines: [(p.mode === 'redo' ? '可重做：' : '可撤销：') + p.n + ' 步', '这次做 ' + p.steps + ' 步'] };
    } catch (e) { lastCheck = null; return loose(errText(e)); }
  }
  function dirRun(op, a) {
    if (!ACTIVE()) return loose('当前不在导演台：切到导演台再让我动时间线');
    if (!READY()) return loose('导演台还没加载完');
    const prior = lastCheck;
    lastCheck = null;
    if (!prior || prior.op !== op) return loose('执行之前要先 check 同一个动作（先校验、给用户过目、再执行）');
    try {
      const p = planOf(op, a);
      if (p.err) return p;
      if (!sameTarget(prior.target, targetOf(p))) {
        return loose('check 与 run 之间时间线变过了（要动的那一块已经不在或换了）：重新读 timeline_get，再 check 一次');
      }
      if (op === 'select') {
        if (p.already) return { ok: true, text: '它本来就是选用的那条，数据没动', changedIds: [] };
        const w = undoWindow('AI 选片：把「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条设为选用', () => null);
        if (w && w.err) return w;
        try {
          focus(p.sc, p.sh, p.i);
          setSelectedCandidate(p.sh, p.c);
        } finally { Edit.closeUndoWindow(); }
        const rows = deriveTimeline(filmOf().clips).rows;
        const text = '已把「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条设为选用：成片现在 ' + rows.length
          + ' 段、共 ' + sec(rows.length ? rows[rows.length - 1].end : 0) + ' 秒。要退回就说「撤销最近一步」。';
        setStatus('<span class="ok">✓ ' + escHTML(text) + '</span>');
        return { ok: true, text, changedIds: [p.sh.id] };
      }
      if (op === 'cut') {
        const r = (p.way === 'left' || p.way === 'right') ? cutTrim(p) : cutDelegated(p);
        if (r.ok && !r.changedIds) r.changedIds = [p.block.item.id];
        if (r.ok) setStatus('<span class="ok">✓ ' + escHTML(r.text) + '</span>');
        return r;
      }
      if (op === 'set') {
        const r = p.kind === 'subtitle' ? subRun(p)
          : (Object.keys(p.next).some(k => GEO_KEYS.includes(k)) ? setGeo(p, a) : setRun(p, a));
        if (r && r.ok && !r.changedIds) r.changedIds = [(p.it && p.it.id) || (p.target && p.target.id) || ''].filter(Boolean);
        if (r && r.ok) setStatus('<span class="ok">✓ ' + escHTML(r.text) + '</span>');
        return r;
      }
      let done = 0;
      for (let k = 0; k < p.steps; k++) {
        if (p.mode === 'redo') { if (!redoStack.length) break; redo(); }
        else { if (!undoStack.length) break; undo(); }
        done++;
      }
      if (!done) return loose('一步都没有退成：撤销栈已经空了');
      return { ok: true, changedIds: [], text: (p.mode === 'redo' ? '已重做 ' : '已撤销 ') + done
        + ' 步（还能撤销 ' + undoStack.length + ' 步 · 可重做 ' + redoStack.length + ' 步）' };
    } catch (e) { return loose(errText(e)); }
  }

  /* ---------- 媒体 / 转写 / 导出：助手入口（都复用页面已有的那一条实现） ---------- */
  function candSrcOf(a) {
    a = a || {};
    const assetId = String(a.assetId || '').trim();
    if (assetId && !a.take && a.shotId == null && a.shot == null && !a.src) {
      return { src: Api.assetSrc(assetId), sh: null, c: null };
    }
    let sh = null, c = null;
    if (a.take != null || a.shotId != null || a.shot != null || a.shotIndex != null) {
      const s = shotOf(a); if (s.err) return s;
      sh = s.sh;
      const q = candOf(sh, a, 'selected'); if (q.err) return q;
      c = q.c;
    }
    const src = String(a.src || '').trim()
      || (a.assetId ? Api.assetSrc(a.assetId) : '')
      || (c ? candTrackSrc(c) : '');
    if (!src) return loose('要检查哪一条没说：给 take（第几条候选）/ shotId，或 src / assetId');
    return { sh, c, src };
  }
  async function mediaCheck(a) {
    a = a || {};
    const assetId = String(a.assetId || '').trim();
    const q = candSrcOf(a); if (q.err) return q;
    try {
      const info = await mediaInfo(assetId && !a.take && a.shotId == null && a.shot == null && !a.src
        ? { assetId } : { src: q.src });
      return Object.assign({ ok: true, 源: q.src.slice(0, 160),
        镜头: q.sh ? capTxt(q.sh.name, 30) : '', 候选: q.c ? String(q.c.vid).slice(0, 60) : '' }, info);
    } catch (e) { return loose('媒体检查失败：' + errText(e)); }
  }
  /* 帧是给用户看的（助手 UI 画成卡片）；返回值里带 dataURL，工具层负责剥掉再给模型。 */
  async function mediaFrames(a) {
    a = a || {};
    const q = candSrcOf(a); if (q.err) return q;
    let times = Array.isArray(a.times) ? a.times.map(Number).filter(Number.isFinite) : [];
    if (!times.length) {
      const total = q.c ? candDur(q.c, q.sh) : 0;
      if (!(total > 0)) return loose('这一条读不到时长：给 times（秒数组，1–8 个）再取帧');
      const n = Math.max(1, Math.min(8, Number(a.count) || 3));
      times = Array.from({ length: n }, (_, i) => Math.round((total * (i + 0.5) / n) * 100) / 100);
    }
    times = times.map(t => Math.max(0, Math.round(Number(t) * 1000) / 1000));
    if (times.length > 8) return loose('一次最多取 8 帧');
    const out = [];
    for (const sec of times) {
      try {
        out.push({ 秒: sec, dataURL: await Wb.vframe.dataURL(q.src, null, sec, 1280) });
      } catch (e) { out.push({ 秒: sec, 错误: errText(e)}); }
    }
    return { ok: out.some(x => x.dataURL), 镜头: q.sh ? capTxt(q.sh.name, 30) : '',
      候选: q.c ? String(q.c.vid).slice(0, 60) : '', 帧: out };
  }
  async function asrStart(a) {
    a = a || {};
    const q = candSrcOf(a); if (q.err) return q;
    /* dryRun：助手在画确认卡片之前要先把「查哪一份、走哪条路、扣不扣费」说清楚，
       但那一步**不许提交任务**（提交了就是一次真实转写，远程还按次计费）。 */
    if (a.dryRun) {
      /* 路线判定只有 `Asr.pickRoute` 一份（浏览器模型就绪 → 本地运行包 → 在线）：
         在这儿再算一套，就会出现「卡片说在线按次计费、实际在浏览器里免费跑」那种假话。 */
      let st = null; let route = '';
      const want = String(a.route || '');
      try {
        if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
        st = await window.Asr.settings();
        route = await window.Asr.pickRoute(want);
      } catch (e) { /* 读不到转写设置就按「没配」那一档报，dryRun 不是错 */ }
      const s = (st && st.settings) || {};
      const svc = s.service || {};
      const local = !!(st && st.local && st.local.available);
      if (!route) route = ['local', 'service', 'browser'].includes(want || s.route) ? (want || s.route) : (local ? 'local' : 'service');
      const routeZh = (window.Asr && window.Asr.routeLabel) ? window.Asr.routeLabel(route) : route;
      let why = routeZh;
      if (route === 'browser') {
        let ready = false;
        try { const bs = await window.Asr.browserStatus(); ready = !!(bs && bs.complete); }
        catch (e) { /* 问不到模型状态就按没就绪说 */ }
        why += ready ? '；模型已就绪' : '；模型还没下全：首次要先经代理下几百 MB，可能等几分钟，关页就停';
      } else if (route === 'local') {
        why = local ? routeZh + '；本机运行包可用'
          : '路线定在本地，但本地模型不可用：' + ((st && st.local && st.local.why) || '缺少运行包') + '（提交会当场被拒）';
      } else {
        why = routeZh + '：供应商 ' + (svc.providerId || '没选') + ' · 模型 ' + (svc.model || 'whisper-1')
          + (svc.hasKey ? '' : '（这一家还没配密钥时提交会被拒）');
      }
      return { ok: true, 镜头: q.sh ? capTxt(q.sh.name, 30) : '', 源: q.src.slice(0, 160),
        route, routeZh, language: String(a.language || s.language || ''), 会扣费: route === 'service', 说明: why };
    }
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      const r = await window.Asr.transcribe({ src: q.src, language: String(a.language || ''), route: String(a.route || '') });
      const routeZh = (window.Asr && window.Asr.routeLabel) ? window.Asr.routeLabel(r && r.route) : '';
      return Object.assign({ ok: true, 镜头: q.sh ? capTxt(q.sh.name, 30) : '', routeZh,
        源: q.src.slice(0, 160), 说明: '转写路线：' + routeZh + '；用 media_transcription 读结果，不会自动改写台词或字幕' }, r);
    } catch (e) {
      /* 「结果未知」不能写成「提交失败」：maybeSubmitted 标记在这个异常上
         （Net 打的），loose 把它压成纯字符串就丢了 —— 助手与用户都以为没提交，
         重试一次就是第二次扣费（在线转写按次计费）。 */
      const unknown = !!(window.Api && Api.maybeSubmitted && Api.maybeSubmitted(e));
      return loose((unknown ? '提交结果未知（平台可能已受理并计费，先读 asrJob 确认，别急着重提）：' : '提交转写失败：') + errText(e));
    }
  }
  async function asrJob(a) {
    const id = String((a && a.jobId) || '').trim();
    if (!id) return loose('要给 jobId');
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      const j = await window.Asr.job(id);
      return Object.assign({ ok: true }, j);
    } catch (e) { return loose('读不到转写任务：' + errText(e)); }
  }

  /* ---------- 导出：助手发起的导出仍调用页面同一套导出函数（不另写渲染管线），这里只做记录与状态查询 ---------- */
  const expJobs = new Map();
  let expSeq = 0;
  function expNew(format) {
    const id = 'ex_' + Date.now().toString(36) + '_' + (++expSeq);
    const rec = { id, format, state: 'running', at: Date.now(), endedAt: 0,
      progress: 0, renderId: '', out: '', err: '', text: '', counts: null };
    expJobs.set(id, rec);
    while (expJobs.size > 20) expJobs.delete(expJobs.keys().next().value);
    return rec;
  }
  function expView(r) {
    return { id: r.id, format: r.format, state: r.state, progress: Math.round(Number(r.progress) || 0),
      开始: r.at, 结束: r.endedAt || null, 渲染任务: r.renderId || '',
      文件: r.out || '', 说明: r.text || '', 错误: r.err || '',
      ...(r.counts ? { 条数: r.counts } : {}),
      可取消: r.state === 'running' && !!(ExportFormats.of(r.format) || {}).cancelable && !!r.renderId };
  }
  function expSettle(rec, ok, extra) {
    rec.state = ok ? 'done' : (extra && extra.cancelled ? 'canceled' : 'error');
    rec.endedAt = Date.now();
    if (extra) {
      if (extra.err) rec.err = String(extra.err);
      if (extra.text) rec.text = String(extra.text);
      if (extra.out) rec.out = String(extra.out);
      if (extra.renderId) rec.renderId = String(extra.renderId);
    }
    if (!rec.text) rec.text = ok ? '导出完成' : (rec.err || '导出失败');
  }
  function expOf(id) {
    if (!id) return [...expJobs.values()].sort((a, b) => b.at - a.at)[0] || null;
    return expJobs.get(String(id)) || null;
  }
  function exportStart(a) {
    a = a || {};
    const fmt = String(a.format || ExportFormats.ids()[0]);
    const f = ExportFormats.of(fmt);
    if (!f) return loose('format 只能是 ' + ExportFormats.hint());
    if (!(filmOf().clips || []).length) return loose('现在成片里一段画面都没有：先选用几条候选（候选卡上的「选用」），或者先生成画面');
    if (f.renders && Export.isRendering()) return loose('已有导出任务在进行中，等这一轮结束或先取消');
    const rec = expNew(fmt);
    const settle = r => expSettle(rec, !!(r && r.ok), r);
    if (f.kind === 'film') {
      Export.exportFilm({
        onStarted: x => {
          rec.renderId = x.renderId;
          rec.progress = 1;
          rec.text = '正在合成成片（' + x.clips + ' 段' + (x.subtitles ? ' · 字幕 ' + x.subtitles + ' 条' : '') + '）';
        },
        onProgress: j => { rec.progress = Number(j && j.progress) || rec.progress; },
      }).then(r => {
        settle(r);
        if (r && r.ok) rec.counts = { 段: r.clips, 秒: r.duration, 字幕: r.subtitles };
      }).catch(e => settle({ ok: false, err: errText(e)}));
      return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
    }
    /* 工程目录：与单文件 / 媒体包同一份 FCPXML，只是摊开落在本机资产库下的 FCPXML工程/ 并回路径。 */
    if (f.project) {
      Export.project({ silent: true }).then(r => {
        settle(r);
        if (r && r.ok) rec.counts = { 画面段: r.rows, 配音句: r.voices, 字幕条: r.subtitles };
      }).catch(e => settle({ ok: false, err: errText(e)}));
      return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
    }
    Export.fcp({ bundle: !!f.bundle }).then(r => {
      settle(r);
      if (r && r.ok) rec.counts = { 画面段: r.rows, 配音句: r.voices, 字幕条: r.subtitles };
    }).catch(e => settle({ ok: false, err: errText(e)}));
    return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
  }
  async function exportStatus(a) {
    const rec = expOf(a && a.jobId);
    if (!rec) return loose('没有这次导出记录（助手发起的导出只在本次页面会话里记账；最近的导出用 export_list 读）');
    /* 进度由导出回调实时写在 rec 上（浏览器内合成，没有代理任务可问）。 */
    return Object.assign({ ok: true }, expView(rec));
  }
  function exportList() {
    return { ok: true, jobs: [...expJobs.values()].sort((a, b) => b.at - a.at).map(expView) };
  }
  /* 助手侧「最近导出」：本次页面会话里发起的那几笔。
     服务端没有渲染账本（导出在浏览器内合成）—— 刷新之后就没有「最近导出」可查，
     要文件就再导一次或去下载目录找。 */
  async function exportRecent(a) {
    return { ok: true, 助手发起的: exportList().jobs, 说明: '只有本次页面会话里的记录（导出在浏览器内合成，代理不留账本）' };
  }
  async function exportCancel(a) {
    const rec = expOf(a && a.jobId);
    if (!rec) return loose('没有这次导出记录');
    if (rec.state !== 'running') return loose('这次导出已经不在跑（可能已经结束）');
    Export.cancelJob();
    expSettle(rec, false, { cancelled: true, err: '已取消' });
    return { ok: true, text: '已取消这次导出（已经落盘的部分不受影响）' };
  }
  async function exportSaveToAssets(a) {
    a = a || {};
    const name = String(a.name || (projOf().merged && projOf().merged.name) || '').trim();
    if (!name) return loose('没说要存哪一份：给 name（最近导出里的文件名），或先导出一份成片');
    try {
      /* 成片字节在会话缓存里（这一轮刚合成的那份）—— 直接把字节交给资产库，
         不再走「服务端渲染目录里复制一份」那条路。 */
      const blob = Export.filmBlobOf(name);
      if (!blob) return loose('这一份的字节不在本次会话里（缓存只留最近导出的那一份）：再点一次「导出成片」，导完立刻存');
      const b64 = await window.AssetTransfer.toB64(blob);
      /* 类型跟文件名 / 字节走：成片没有 H.264 时导出来的是 .webm（选容器在 MediaExport.pickCodec）。 */
      const fmt = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4';
      const d = await window.Api.saveLocalAsset({
        name: name, mime: blob.type || (fmt === 'webm' ? 'video/webm' : 'video/mp4'), format: fmt, data: b64,
        meta: { provider: 'local', prompt: String(a.title || projOf().name || '').slice(0, 200) },
      });
      return Object.assign({ ok: true, text: (d && d.reused ? '资产库里已经有这一份：' : '已存进本机资产库：') + (name) }, d || {});
    } catch (e) { return loose('存进资产库失败：' + errText(e)); }
  }

  /* ---------- 定位：changedIds 是块 id（画面段 id / 配音块 id / 字幕 id；select 动作给镜头 id） ----------
     显式点「定位」才把播放头带过去并选中那一块；执行完那一下只闪、不切视图。
     页不在前台就拒绝 —— 不做自动跳页，免得抢走用户当前的视图。 */
  function locateItems(ids, opts) {
    if (!READY()) return { ok: false, reason: '导演台还没加载完' };
    if (!ACTIVE()) return { ok: false, reason: '导演台现在不在前台：切回导演台再点「定位」' };
    const o = opts || {};
    const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
    const f = filmOf();
    const hits = [];
    /* 画面段：块 id 优先，也认镜头 id（select 动作的回执给镜头 id）。 */
    (deriveTimeline(f.clips).rows || []).forEach(r => {
      if (list.includes(String(r.clip.id)) || list.includes(String(r.clip.shotId))) hits.push(r.clip);
    });
    (f.voices || []).forEach(v => { if (list.includes(String(v.id))) hits.push(v); });
    (f.captions || []).forEach(c => { if (list.includes(String(c.id))) hits.push(c); });
    if (!hits.length) return { ok: false, reason: '成片里已经没有这几块了（可能刚被删掉）' };
    const sel = (kind, item) => { try { Edit.selectItem(kind, item.id); } catch (e) { /* 选中失败不拦定位 */ } };
    /* 闪是渲染层的一份状态（见 timeline.js 的 flashBlocks）：写入 / 定位之后板还要再重画，
       直接加在节点上的 class 会被那次重画换掉，用户看到的就是「点了执行 / 定位，什么都没闪」。 */
    const flash = () => Timeline.flashBlocks(hits.map(it => it.id));
    const first = hits[0];
    const kind = (f.captions || []).includes(first) ? 'cap'
      : (f.voices || []).includes(first) ? 'voice' : 'clip';
    if (o.focus !== false) {
      sel(kind, first);
      Timeline.seekTo(num(first.start), { playNow: false });
      renderAll();
      requestAnimationFrame(() => requestAnimationFrame(flash));
    } else {
      /* 执行完那一下只闪、不切视图：但写入刚把板重画过，闪在**旧节点**上就跟着一起被换掉。
         等这一轮重画落定（两帧）再闪，用户看到的就是新块亮一下。 */
      requestAnimationFrame(() => requestAnimationFrame(flash));
    }
    return { ok: true, found: hits.length,
      label: hits.length === 1 ? (Edit.describeItem(kind, first.id) || KIND_ZH[kind]) : hits.length + ' 块' };
  }

  /* 唯一写入桥：只读快照 + check + run，装进 `WBBridge`（web/core/bridges.js）。
     助手侧只认这一个名字，不再往 window 上挂页面专用全局。 */
  if (window.WBBridge && typeof window.WBBridge.install === 'function') window.WBBridge.install('director', {
    version: 3,
    ready: () => ACTIVE() && READY(),
    history: () => ({
      可撤销: undoStack.length,
      可重做: redoStack.length,
      上限: UNDO_MAX_COUNT,
      最近: newestHistoryLabelOf(),
      占内存: window.fmtBytes(undoBytesOf()) + ' / ' + window.fmtBytes(UNDO_MAX_BYTES),
    }),
    locate: (ids, opts) => locateItems(ids, opts),
    context: () => {
      if (!READY()) return { 导演台: '还没加载完' };
      const f = filmOf();
      const tl = deriveTimeline(f.clips).rows;
      const total = tl.length ? num(tl[tl.length - 1].end) : 0;
      const caps = visibleCaptions(f);
      const out = {
        项目: capTxt(projOf().name, 40),
        场景: curScene() ? capTxt(curScene().name, 30) : '',
        成片: {
          段数: tl.length,
          总秒: round1(total),
          播放头: tl.length ? round1(num(Timeline.playhead())) : null,
          段: tl.slice(0, 12).map(r => ({
            第: r.index + 1, id: r.clip.id, start: round1(num(r.start)), end: round1(num(r.end)),
            素材: capTxt(r.clip.name || r.clip.shotId || '', 20),
            倍速: spdTxt(r.clip.rate), 音量: Math.round(num(r.clip.volume, 1) * 100) + '%',
            转场: r.clip.transition ? transitionNameOf(r.clip.transition) : '',
          })),
          行可见: f.tracks && f.tracks.visibility ? Object.keys(f.tracks.visibility).length : 0,
          行锁定: f.tracks && f.tracks.locks ? Object.keys(f.tracks.locks).length : 0,
        },
        配音: (f.voices || []).length,
        字幕: { 条数: caps.list.length, 藏掉: caps.skipped.hidden, 没字: caps.skipped.empty },
        标记: (f.markers || []).slice(0, 12).map(m => ({
          id: m.id, 类型: m.type, 秒: round1(num(m.time)), 标题: capTxt(m.title, 20),
          ...(m.type === 'range' ? { 到: round1(num(m.endTime)) } : {}),
        })),
        焦点: Edit.focusOf() || null,
        可撤销: undoStack.length,
        可重做: redoStack.length,
      };
      const sh = curShot();
      if (sh) {
        const list = sh.candidates || [];
        const k = list.findIndex(x => x.vid === sh.selId);
        out.当前镜头 = capTxt(sh.name, 30);
        out.镜头id = sh.id;
        out.选用 = k >= 0 ? ('第 ' + (k + 1) + ' 条') : '未选用';
        out.候选 = list.slice(0, 12).map((x, i) => ({
          序号: i + 1, id: x.vid, 状态: x.status || '', 秒: round1(candDur(x, sh)), 选用: x.vid === sh.selId,
        }));
      }
      return out;
    },
    subtitle: a => subtitleInfo(a),
    srt: () => srtOut(),
    mediaInfo: a => mediaCheck(a),
    mediaFrames: a => mediaFrames(a),
    asrStart: a => asrStart(a),
    asrJob: a => asrJob(a),
    exportNow: a => exportStart(a),
    exportStatus: a => exportStatus(a),
    exportList: a => exportRecent(a),
    exportCancel: a => exportCancel(a),
    saveToAssets: a => exportSaveToAssets(a),
    /* 素材改名回填（素材库页改了名字 → 全片 @旧名 与 refMeta.label 刷成新名）。
       改写规则只有一份（`Chars.renameShotRefs`，纯函数）；这里只负责把活内存里那份工程
       交出去改、改完排一次静默落盘。直接写 IndexedDB 会被导演台下一次整包 scheduleSave
       静默冲掉 —— 所以这条路只在「导演台已装配」时走，不在场时页面自己落 Kv。 */
    libRenameBackfill: a => {
      const C = window.Chars;
      if (!C || !C.renameShotRefs) return 0;
      const projects = (typeof allProjects === 'function' ? allProjects() : null) || [];
      if (!projects.length) return 0;
      let n = 0;
      try {
        n = C.renameShotRefs(projects, a) || 0;
      } catch (e) { return 0; }
      if (n && typeof scheduleSaveQuiet === 'function') { try { scheduleSaveQuiet(); } catch (e) { /* 排不上保存不影响这次改写已经落进内存 */ } }
      return n;
    },
    check: (op, a) => dirCheck(op, a),
    run: (op, a) => dirRun(op, a),
  });
})();

  /* 这一域没有要交回 engine 的名字：它在模块自己那一段里就把活干完了（装桥、挂钩子）。 */
}
