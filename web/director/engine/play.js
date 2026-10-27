/* 导演台播放域（engine/play.js）：主时钟、单一预览面、配音对齐、转场层与字幕叠层。

   口径照参考项目（hooks/useMediaSync.js + components/PreviewStage.jsx）：
   · **单调主时钟**：锚定 performance.now，rAF 推进；界面读数按 15ms 节流。
     媒体元素只向时钟对齐（换段 / seek 时定一次），**绝不反向驱动时钟**。
   · **单一预览面**：同一个 `.player-box`，按当前 clip 的 kind 换元素 ——
     视频用 `<video>`、图片用 `<img>`，不抽帧、不做动效；字幕与转场层叠在同一处。
   · **转场层**：播放头进入段尾的转场窗口才盖一层 `.preview-transition-layer type-<id>`，
     `--transition-progress` 从 0 走到 1；出窗即撤层。
   · **配音**：每一条 VoiceClip 一只 `<audio>`，期望位置 = 源起点 + 块内秒 × 倍速；
     音量 > 100% 与淡入淡出包络走 WebAudio GainNode（原生元素音量封顶 1）。

   播放层不碰工程数据：它只读 film，写回（改音量 / 剪段）都归编辑核。 */

import {
  deriveTimeline, coversTime, itemVisible, voiceLaneMap, captionLaneMap,
  fadeGain, clamp, transitionAtTime, captionPosition, captionHighlighted,
} from '../film.js';

/* 界面读数节流：主时钟每帧都走，画读数 / 转场进度只按这个间隔。 */
const UI_FRAME_MS = 15;
/* 换段 / seek 时媒体与时钟的允许偏差：差得比这多才动 currentTime。 */
const SYNC_EPS = 0.04;
/* 同一段里播放中的软校正阈值：媒体解码慢下来时拉回主时钟，但不要每帧都 seek。 */
const DRIFT_EPS = 0.3;

const ZERO = 0;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/* 「开始播，并吞掉自动播放被浏览器拦下来的那个拒绝」只有这一份（生成态的播放器也走它）。
   onErr 只在真被拦下时叫一次 —— 静音轨 / 空 src 的 play() 拒绝不当成错误。 */
export function playSafe(media, onErr) {
  if (!media || typeof media.play !== 'function') return;
  let p = null;
  try { p = media.play(); } catch (e) { if (onErr) onErr(e); return; }
  if (p && typeof p.catch === 'function') {
    p.catch(e => { if (onErr && e && e.name !== 'AbortError') onErr(e); });
  }
}

export function createPlay(E, document, window) {
  const {
    filmNow,
    icon,
    esc,
    fmtClock,
    mediaSrc,
    Timeline,
    bindPbFull,
    pbBarHTML,
    updateArBadge,
    setStatus,
  } = E;

  const now = () => window.performance.now();
  const film = () => filmNow();
  const clipsOf = () => film().clips || [];
  const timelineOf = () => deriveTimeline(clipsOf());
  const total = () => timelineOf().total;
  const clampT = t => Math.max(0, Math.min(total(), num(t)));

  /* ---------------- 播放状态（模块级单例：切页 / 整列重画都接着用） ---------------- */
  let col = null;
  let box = null;
  let video = null;
  let still = null;
  let trLayer = null;
  let subWrap = null;
  let pbBtn = null;
  let pbTime = null;
  let pbMute = null;

  let playing = false;
  let pos = 0;
  let baseT = 0;
  let baseWall = 0;
  let rafId = 0;
  let lastUi = 0;

  /* 当前主画面是视频还是图片（决定媒体怎么对齐）。 */
  let stageKind = '';
  let stageClipId = '';
  /* 视频换源之后的「到点该去哪儿」：元数据到了才把它落下去。 */
  let pendingSeek = null;
  let pendingPlay = false;

  let muted = !!(window.LS && window.LS.get('dir_muted') === '1');

  /* WebAudio：只有需要 >100% 音量或淡入淡出包络时才建；建不起来就退回元素音量（上限 1）。 */
  let ctx = null;
  let audioDead = false;
  let mainNode = null;
  let mainGain = null;

  /* 配音：一条一块 <audio>，按 film.voices 的 id 保活。 */
  const voices = new Map();

  /* 字幕 / 转场只记「上一次画的是什么」，key 没变就不动 innerHTML。 */
  let capKey = null;
  const trState = { key: '', owner: null, start: 0, incoming: null };
  /* 转场窗走完之后的「先别撤层」截止时刻（见 applyTransition 那一段）。 */
  let trHoldUntil = 0;

  const clockNow = () => (playing
    ? Math.min(total(), baseT + (now() - baseWall) / 1000)
    : pos);

  /* ---------------- 音频上下文 ---------------- */
  function ensureAudio() {
    if (ctx || audioDead) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { audioDead = true; return null; }
    try { ctx = new AC(); } catch (e) { audioDead = true; ctx = null; }
    if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => ZERO);
    return ctx;
  }
  function audioReady() {
    if (!ctx) return false;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => ZERO);
    return ctx.state === 'running' || ctx.state === 'suspended';
  }

  /* 主画面的增益：静音 = 0，正常 = clip.volume（上限 4）。 */
  function applyMainGain(clip) {
    if (!video) return;
    const gain = muted || !clip ? 0 : clamp(num(clip.volume, 1), 0, 4);
    if (ctx && video.__pvWiredGain !== ctx) {
      try {
        if (!mainNode || mainNode.mediaElement !== video) {
          mainNode = ctx.createMediaElementSource(video);
          mainGain = ctx.createGain();
          mainNode.connect(mainGain).connect(ctx.destination);
        }
        video.__pvWiredGain = ctx;
      } catch (e) {
        mainNode = null;
        mainGain = null;
      }
    }
    if (mainGain && mainNode && mainNode.mediaElement === video) {
      mainGain.gain.value = gain;
      video.volume = 1;
      video.muted = false;
    } else {
      video.muted = muted;
      video.volume = Math.min(1, gain);
    }
  }

  /* 配音的增益：>1 的部分只能走 WebAudio；建不起来就按元素音量封顶 1。 */
  function applyVoiceGain(rec, gain) {
    if (!rec || !rec.el) return;
    if (ctx) {
      if (!rec.gainNode) {
        try {
          rec.sourceNode = ctx.createMediaElementSource(rec.el);
          rec.gainNode = ctx.createGain();
          rec.sourceNode.connect(rec.gainNode).connect(ctx.destination);
          rec.el.volume = 1;
        } catch (e) {
          rec.gainNode = null;
        }
      }
      if (rec.gainNode) {
        rec.gainNode.gain.value = gain;
        rec.el.muted = false;
        return;
      }
    }
    rec.el.volume = Math.min(1, Math.max(0, gain));
    rec.el.muted = gain <= 0.0001;
  }

  /* ---------------- 预览面 ---------------- */
  function clipCount() { return clipsOf().length; }

  function stageHTML() {
    return `<div class="player-box">
      <video id="player" playsinline></video>
      <img id="playerStill" class="player-still" alt="">
      <div class="preview-transition-layer" id="pvTr" hidden></div>
      <div class="sub-wrap" id="subWrap" aria-hidden="true"></div>
      ${pbBarHTML()}
      <span class="arbadge" id="arBadge"></span>
    </div>`;
  }

  function rowAt(t) { return timelineOf().rowAtTime(t); }

  /* 片段之间允许留空（clip.gap）：空出来的那几秒**放黑**，不是停着上一帧。
     不暂停的话视频会接着往下走，回到下一段时对不上；黑滤镜与暂停一起做。 */
  function applyGap(on) {
    if (!video) return;
    video.classList.toggle('blackout', !!on);
    if (on && !video.paused) video.pause();
    if (on && still) still.classList.remove('on');
  }

  /* 这一格在 t 这一秒该读到素材里的哪一帧（源秒）。 */
  function sourceTimeAt(clip, start, t) {
    const local = Math.max(0, num(t) - num(start));
    return Math.max(0, num(clip.sourceStart) + local * (clip.kind === 'image' ? 1 : num(clip.playbackRate, 1)));
  }

  function ensureVideoWiring() {
    if (!video || video.__pvWired) return;
    video.__pvWired = true;
    video.addEventListener('loadedmetadata', () => {
      if (!video || !video.dataset.clip) return;
      if (pendingSeek != null) {
        try { video.currentTime = pendingSeek; } catch (e) { /* 元数据刚到时的定位失败就等下一帧 */ }
        pendingSeek = null;
      }
      if (pendingPlay && playing) playSafe(video);
      pendingPlay = false;
      if (updateArBadge) updateArBadge(video);
      const row = rowAt(pos);
      if (row && row.clip.kind !== 'image') applyMainGain(row.clip);
    });
    video.addEventListener('click', toggle);
    video.addEventListener('play', paintBtn);
    video.addEventListener('pause', paintBtn);
  }

  function loadVideo(clip, t, shouldPlay) {
    if (!video) return;
    stageKind = 'video';
    stageClipId = clip.id;
    /* ⚠ 这个 data 属性是「主画面现在放的是哪一段」的唯一判据：applyStage 会写它，
       而播放中换段走的是 syncMain —— 那条路以前**只**调 loadVideo、不写它，
       于是每帧都判「不是这一段」→ 每帧重设 src → 播到切点之后画面一直黑。
       写在 loadVideo 里，两条路就都记得住。 */
    video.dataset.clip = clip.id;
    pendingSeek = sourceTimeAt(clip, rowAt(t) ? rowAt(t).start : 0, t);
    pendingPlay = shouldPlay;
    video.playbackRate = num(clip.playbackRate, 1);
    video.preservesPitch = true;
    video.src = mediaSrc(clip.src || '');
    applyMainGain(clip);
    if (shouldPlay) playSafe(video);
  }

  /* 按 t 换主画面：视频段放视频、图片段把静止层盖上来。force = 这一次必须对齐。 */
  function applyStage(t, force) {
    const row = rowAt(t);
    if (!row) { stageKind = 'gap'; stageClipId = ''; applyGap(true); return; }
    applyGap(false);
    const clip = row.clip;
    if (clip.kind === 'image') {
      stageKind = 'image';
      stageClipId = clip.id;
      if (video && !video.paused) video.pause();
      if (still) {
        still.classList.add('on');
        if (still.dataset.clip !== clip.id) {
          still.dataset.clip = clip.id;
          still.src = mediaSrc(clip.src || '');
        }
      }
      return;
    }
    stageKind = 'video';
    if (still) still.classList.remove('on');
    if (!video) return;
    if (video.dataset.clip !== clip.id) {
      video.dataset.clip = clip.id;
      loadVideo(clip, t, playing);
      return;
    }
    video.playbackRate = num(clip.playbackRate, 1);
    video.preservesPitch = true;
    applyMainGain(clip);
    if (!playing) {
      if (force || !video.paused) {
        try { video.currentTime = sourceTimeAt(clip, row.start, t); } catch (e) { /* 元数据没到就等 loadedmetadata */ }
        pendingSeek = sourceTimeAt(clip, row.start, t);
      }
      if (!video.paused) video.pause();
    } else if (force) {
      try { video.currentTime = sourceTimeAt(clip, row.start, t); } catch (e) { /* 同上 */ }
      playSafe(video);
    }
  }

  /* ---------------- 转场 ---------------- */
  /* 窗口与进度只由 film.js 的 `transitionAtTime` 算一份：导出侧（MediaExport 的逐帧合成）
     问的是同一枚函数，屏幕上看到的那一刀与导出来的那一刀才是同一刀。 */
  function transitionAt(t) { return transitionAtTime(timelineOf().rows, t); }

  function hideTransition() {
    if (!trLayer) return;
    if (!trState.key && trLayer.hidden) return;
    trState.key = '';
    trState.owner = null;
    trState.incoming = null;
    trLayer.hidden = true;
    trLayer.innerHTML = '';
    /* 撤层时把「是哪一种转场、走到几成」一起清掉：留着的话界面下一次读到的是
       上一次那一刀的旧状态，回执与判据都没法信（tests/e2e/director-playback.cjs 直接读这两枚）。 */
    trLayer.className = 'preview-transition-layer';
    trLayer.style.removeProperty('--transition-progress');
  }

  function applyTransition(t, force) {
    if (!trLayer) return;
    const tr = transitionAt(t);
    if (!tr) {
      if (!trState.key) return;
      /* 窗口刚走完：主画面这时才换到下一段，换源那一两百毫秒是黑的 ——
         转场层里放的**正是下一段的画面**，等主画面真有了帧再撤层，别把黑底露出来。
         超过 900ms 还没就绪（素材取不到 / 解码失败）就照常撤，不无限挂着一层旧画面。 */
      const row = rowAt(t);
      const ready = !row || row.clip.kind === 'image'
        || (video && video.dataset.clip === row.clip.id && video.readyState >= 2);
      if (ready) hideTransition();
      else if (!trHoldUntil) trHoldUntil = now() + 900;
      else if (now() > trHoldUntil) hideTransition();
      return;
    }
    trHoldUntil = 0;
    const nextCl = tr.next.clip;
    const key = tr.row.index + '|' + tr.id + '|' + nextCl.id;
    if (trState.key !== key) {
      trState.key = key;
      trState.owner = tr;
      trState.start = tr.start;
      trLayer.className = 'preview-transition-layer type-' + tr.id;
      trLayer.hidden = false;
      const src = nextCl.src ? mediaSrc(nextCl.src) : '';
      trLayer.innerHTML = nextCl.kind === 'image'
        ? `<img src="${esc(src)}" alt="">${tr.id === 'flash' ? '<i></i>' : ''}`
        : `<video muted playsinline preload="auto" src="${esc(src)}"></video>${tr.id === 'flash' ? '<i></i>' : ''}`;
      const inc = trLayer.querySelector('video,img');
      trState.incoming = inc;
      if (inc && inc.tagName === 'VIDEO') {
        inc.playbackRate = num(nextCl.playbackRate, 1);
        inc.preservesPitch = true;
        const seekTo = Math.max(0, num(nextCl.sourceStart) + Math.max(0, t - tr.start) * num(nextCl.playbackRate, 1));
        inc.addEventListener('loadedmetadata', () => {
          try { inc.currentTime = seekTo; } catch (e) { /* 元数据刚到，下一次 tick 再对 */ }
          if (playing) playSafe(inc);
        }, { once: true });
        if (playing) playSafe(inc); else inc.pause();
      }
    } else if (force) {
      const inc = trState.incoming;
      if (inc && inc.tagName === 'VIDEO') {
        const seekTo = Math.max(0, num(nextCl.sourceStart) + Math.max(0, t - tr.start) * num(nextCl.playbackRate, 1));
        try { inc.currentTime = seekTo; } catch (e) { /* 同上 */ }
        if (playing) playSafe(inc); else inc.pause();
      }
    } else if (!playing) {
      const inc = trState.incoming;
      if (inc && inc.tagName === 'VIDEO' && !inc.paused) inc.pause();
    }
    trLayer.style.setProperty('--transition-progress', String(Math.round(tr.progress * 1000) / 1000));
  }

  /* ---------------- 字幕叠层 ---------------- */
  function captionsAt(t) {
    const f = film();
    const laneOf = captionLaneMap(f);
    return f.captions.filter(c => {
      const dur = Math.max(0, num(c.end) - num(c.start));
      return dur > 0 && coversTime({ start: c.start, duration: dur }, t)
        && itemVisible(f.tracks, 'caption', laneOf.get(c.id));
    });
  }

  function applyCaptions(t) {
    if (!subWrap) return;
    const hits = captionsAt(t);
    const key = hits.map(c => [c.id, c.text, c.position, c.style].join('\u0001')).join('\u0002');
    if (key === capKey) return;
    capKey = key;
    subWrap.innerHTML = hits.map(c => `<div class="sub-ov sub-ov-${captionPosition(c)}${captionHighlighted(c) ? ' hl' : ''}">`
      + `${esc(String(c.text || '')).replace(/\n/g, '<br>')}</div>`).join('');
  }

  /* ---------------- 配音 ---------------- */
  function ensureVoiceEl(id, src) {
    let rec = voices.get(id);
    if (!rec) {
      rec = { el: document.createElement('audio'), src: '', gainNode: null, sourceNode: null };
      rec.el.preload = 'auto';
      rec.el.__pvVoice = id;
      voices.set(id, rec);
    }
    if (src && rec.src !== src) {
      rec.src = src;
      rec.el.src = src;
    }
    return rec;
  }

  function pruneVoices(live) {
    voices.forEach((rec, id) => {
      if (live.has(id)) return;
      try { rec.el.pause(); rec.el.removeAttribute('src'); rec.el.load(); } catch (e) { /* 元素已经坏了就没有可清的 */ }
      voices.delete(id);
    });
  }

  /* 按成片秒对齐每一条配音：在块里且没静音才播；期望位置 = 源起点 + 块内秒 × 倍速。 */
  function syncVoices(t, force) {
    const f = film();
    const live = new Set(f.voices.map(v => v.id));
    pruneVoices(live);
    if (!f.voices.length) return;
    const laneOf = voiceLaneMap(f);
    f.voices.forEach(v => {
      const src = v.src ? mediaSrc(v.src) : '';
      if (!src) return;
      const rec = ensureVoiceEl(v.id, src);
      const inBlock = coversTime(v, t);
      const visible = itemVisible(f.tracks, 'voice', laneOf.get(v.id));
      const gain = (!muted && inBlock && visible)
        ? clamp(num(v.volume, 1), 0, 4) * fadeGain(v, t - num(v.start))
        : 0;
      const shouldPlay = playing && gain > 0.0001;
      if (!shouldPlay) {
        if (!rec.el.paused) rec.el.pause();
        applyVoiceGain(rec, 0);
        return;
      }
      const rate = Math.max(0.25, Math.min(4, num(v.playbackRate, 1)));
      if (rec.el.playbackRate !== rate) {
        rec.el.playbackRate = rate;
        rec.el.preservesPitch = true;
      }
      const expected = Math.max(0, num(v.sourceStart) + Math.max(0, t - num(v.start)) * rate);
      let drift = Math.abs(num(rec.el.currentTime) - expected);
      if (force || drift > (rec.el.paused ? SYNC_EPS : DRIFT_EPS)) {
        try { rec.el.currentTime = expected; } catch (e) { /* 元数据没到就等下一次 tick */ }
        drift = 0;
      }
      applyVoiceGain(rec, gain);
      if (rec.el.paused) playSafe(rec.el);
    });
  }

  function pauseVoices() {
    voices.forEach(rec => {
      if (!rec.el.paused) rec.el.pause();
      applyVoiceGain(rec, 0);
    });
  }

  /* ---------------- 时钟 ---------------- */
  function paintBtn() {
    if (!pbBtn) return;
    pbBtn.innerHTML = icon(playing ? 'pause' : 'play', 15);
    pbBtn.title = playing ? '暂停' : '播放';
  }

  function paintTime() {
    if (!pbTime) return;
    pbTime.textContent = (fmtClock ? fmtClock(pos) : String(Math.round(pos * 10) / 10)) + ' / '
      + (fmtClock ? fmtClock(total()) : String(Math.round(total() * 10) / 10));
    pbTime.title = '读数 = 成片里的秒数（各段按倍速折算后接起来）';
  }

  function paintMute() {
    if (!pbMute) return;
    pbMute.innerHTML = icon(muted ? 'speakerOff' : 'speaker', 14);
    pbMute.title = muted ? '已静音（点击开启声音）' : '声音已开启（点击静音）';
  }

  function syncMain(t, force) {
    const row = rowAt(t);
    if (!row) { applyGap(true); return; }
    applyGap(false);
    const clip = row.clip;
    if (clip.kind === 'image') {
      if (video && !video.paused) video.pause();
      return;
    }
    if (!video) return;
    if (video.dataset.clip !== clip.id) {
      loadVideo(clip, t, playing);
      return;
    }
    if (!playing) return;
    const expected = sourceTimeAt(clip, row.start, t);
    const drift = Math.abs(num(video.currentTime) - expected);
    if ((force || drift > DRIFT_EPS) && video.readyState >= 1) {
      try { video.currentTime = expected; } catch (e) { /* seek 被拒就保持当前位置，下一帧再试 */ }
    }
    if (video.paused && video.readyState >= 2) playSafe(video);
  }

  function tick() {
    rafId = 0;
    if (!playing) return;
    const nav = total();
    const wall = now();
    const t = Math.min(nav, baseT + (wall - baseWall) / 1000);
    pos = t;
    if (t >= nav) { endPlayback(); return; }
    rafId = window.requestAnimationFrame(tick);
    syncMain(t, false);
    syncVoices(t, false);
    if (wall - lastUi >= UI_FRAME_MS) {
      lastUi = wall;
      paintTime();
      applyTransition(t, false);
      applyCaptions(t);
      if (Timeline) Timeline.playbackSync(t);
    }
  }

  function startClock() {
    if (playing || !clipsOf().length) return;
    ensureAudio();
    if (pos >= total() - 0.005) pos = 0;
    playing = true;
    baseT = pos;
    baseWall = now();
    lastUi = 0;
    applyStage(pos, true);
    applyTransition(pos, true);
    applyCaptions(pos);
    syncVoices(pos, true);
    if (video && stageKind === 'video') playSafe(video);
    paintBtn();
    paintTime();
    if (Timeline) Timeline.playbackStart(pos);
    if (!rafId) rafId = window.requestAnimationFrame(tick);
  }

  function stopMedia() {
    playing = false;
    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    if (video && !video.paused) video.pause();
    const inc = trState.incoming;
    if (inc && inc.tagName === 'VIDEO' && !inc.paused) inc.pause();
    pauseVoices();
  }

  function endPlayback() {
    stopMedia();
    pos = total();
    applyStage(pos, true);
    hideTransition();
    applyCaptions(pos);
    paintBtn();
    paintTime();
    if (Timeline) Timeline.playbackStop(pos);
  }

  function play() {
    if (!clipsOf().length) return;
    startClock();
  }

  function pause() {
    if (!playing) return;
    const t = clockNow();
    stopMedia();
    pos = Math.max(0, Math.min(total(), t));
    applyStage(pos, true);
    applyTransition(pos, true);
    applyCaptions(pos);
    paintBtn();
    paintTime();
    if (Timeline) Timeline.playbackStop(pos);
  }

  function toggle() { if (playing) pause(); else play(); }

  /* 定位：先停时钟与媒体，把画面落到新的一秒；playNow 缺省 = 保持原来的播放态。 */
  function seek(t, playNow) {
    if (!clipsOf().length) return;
    const wasPlaying = playing;
    const shouldPlay = playNow == null ? wasPlaying : !!playNow;
    stopMedia();
    pos = clampT(t);
    baseT = pos;
    baseWall = now();
    applyStage(pos, true);
    applyTransition(pos, true);
    applyCaptions(pos);
    paintBtn();
    paintTime();
    if (Timeline) {
      Timeline.playbackStop(pos);
      Timeline.follow();
    }
    if (shouldPlay) startClock();
  }

  /* ---------------- 接线 ---------------- */
  function bind(colEl, keepPlay, keepBox) {
    col = colEl;
    if (!col) return;
    box = col.querySelector('.player-box');
    if (!box) return;
    video = col.querySelector('#player');
    still = col.querySelector('#playerStill');
    trLayer = col.querySelector('#pvTr');
    subWrap = col.querySelector('#subWrap');
    pbBtn = col.querySelector('#pbBtn');
    pbTime = col.querySelector('#pbTime');
    pbMute = col.querySelector('#pbMute');
    ensureVideoWiring();
    if (video) video.muted = muted;
    if (pbBtn) pbBtn.onclick = e => { e.stopPropagation(); toggle(); };
    if (pbMute) {
      paintMute();
      pbMute.onclick = e => {
        e.stopPropagation();
        setMuted(!muted);
      };
    }
    if (still) still.onclick = toggle;
    if (bindPbFull) bindPbFull(box);

    /* 节点被保住（同一只播放器、同一份媒体）：只补按钮与叠加层，不重新载入、不 seek。
       整块板重画之后 WAAPI 的那两个节点已经换了，播放头在这里重新挂上滑行动画。 */
    if (keepBox) {
      applyStage(pos, false);
      applyTransition(pos, false);
      applyCaptions(pos);
      paintBtn();
      paintTime();
      if (playing && Timeline) Timeline.playbackStart(pos);
      return;
    }

    const t = keepPlay && Number.isFinite(Number(keepPlay.t)) ? clampT(keepPlay.t) : 0;
    const resume = !!(keepPlay && !keepPlay.paused);
    stopMedia();
    pos = t;
    baseT = pos;
    baseWall = now();
    capKey = null;
    trState.key = '';
    applyStage(pos, true);
    applyTransition(pos, true);
    applyCaptions(pos);
    paintBtn();
    paintTime();
    if (Timeline) Timeline.playbackStop(pos);
    if (resume && clipsOf().length) startClock();
  }

  function dispose() {
    stopMedia();
    if (Timeline) Timeline.playbackStop(pos);
    voices.forEach(rec => {
      try { rec.el.pause(); rec.el.removeAttribute('src'); rec.el.load(); } catch (e) { /* 元素已经坏了就没有可清的 */ }
    });
    voices.clear();
    if (video) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { /* 同上 */ }
    }
    if (ctx && ctx.close) { try { ctx.close(); } catch (e) { /* 已经关了 */ } }
    ctx = null;
    mainNode = null;
    mainGain = null;
    col = null; box = null; video = null; still = null; trLayer = null; subWrap = null;
    pbBtn = null; pbTime = null; pbMute = null;
    stageKind = '';
    stageClipId = '';
    pendingSeek = null;
    pendingPlay = false;
    playing = false;
    pos = 0;
    capKey = null;
    trState.key = '';
    trState.owner = null;
    trState.incoming = null;
  }

  /* 工程改了（剪一刀 / 换候选 / 改音量）：暂停状态就地反映新内容；播放中由主时钟换段。 */
  function refresh() {
    if (!col) return;
    if (!playing) applyStage(pos, false);
    syncVoices(pos, true);
  }

  function setMuted(on) {
    muted = !!on;
    if (window.LS) window.LS.set('dir_muted', muted ? '1' : '0');
    const row = rowAt(pos);
    if (row) applyMainGain(row.clip);
    paintMute();
    syncVoices(pos, true);
    if (setStatus) setStatus(muted ? '预览已静音' : '预览声音已开启');
  }

  /* ---------------- 旧两轴口径（导出 / 剪刀的过渡期读法） ---------------- */
  /* `srcT()` = 播放头在**这一格素材的源秒**上；`frameT()` = 播放头在**成片秒**上。 */
  function srcT() {
    const row = rowAt(pos);
    if (!row || row.clip.kind === 'image') return 0;
    return sourceTimeAt(row.clip, row.start, pos);
  }

  function planEntries() {
    return timelineOf().rows.map(r => ({
      fs: r.start, fd: r.end - r.start, start: r.start, end: r.end,
      spd: num(r.clip.playbackRate, 1), clip: r.clip,
    }));
  }

  return {
    stageHTML,
    clipCount,
    bind,
    dispose,
    refresh,
    play,
    pause,
    toggle,
    seek,
    setMuted,
    srcT,
    frameT: () => pos,
    get plan() { return planEntries(); },
    get starts() { return timelineOf().rows.map(r => r.start); },
    get t() { return pos; },
    get total() { return total(); },
    get playing() { return playing; },
    get muted() { return muted; },
  };
}
