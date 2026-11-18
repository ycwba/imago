/* 导演台Strip域（engine/strip.js）：块里面画什么 —— 画面段的胶片格、配音段与
   波形与文字、字幕段的文字。块的几何（位置 / 宽度 / 把手 / 选中）在 timeline.js 与 edit.js，
   这一份不碰。
   画面帧不在这边解码：`E.ensureFrames` 走 frames.js 那条全页共用的流水线，
   这里只算「这一段要几个采样点」（tl-filmstrip.js），再把回来的图贴进格子。
   波形只读 `peaks`（源窗口上的 RMS，tl-peaks.js 的重采样），不在剪辑时再解码音频。 */
import { frameCountFor, planFrameTimes, spanTolOf } from '../tl-filmstrip.js';
import { resamplePeaks } from '../tl-peaks.js';
import { num } from '../util.js';

const IMAGE_CELL_PX = 84;
/* 单格解码回执的看门狗：超过它还没回来就当挂死处理（见 paintClip 的 busy 注释）。
   元数据 20s / 定位 15s 的上游上限之后再加 10s 余量，30s 足够盖住「这会儿忙」。 */
const STRIP_BUSY_WATCHDOG_MS = 30000;

/* 胶片格宽随缩放收紧（与参考 Timeline.jsx 的 targetCellWidth 同一口径）：
   放大之后格子窄一点，同样的像素宽度里能看到更多采样点，剪点才对得上画面。 */
export function videoCellFor(zoom) {
  const z = num(zoom, 1);
  if (z >= 8) return 48;
  if (z >= 3) return 56;
  if (z >= 1) return 64;
  return 76;
}

const attrEsc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createStrip(E, document, window) {
  const { getZoom, ensureFrames, framePeek, mediaSrc, icon, esc } = E;

  const mediaSrcOf = raw => {
    const u = String(raw == null ? '' : raw);
    if (!u) return '';
    try { return mediaSrc ? mediaSrc(u) || u : u; } catch (e) { return u; }
  };

  /* ---------------- 画面段 ---------------- */
  function cellHTML(url) {
    return url
      ? `<i class="tl-fr" style="background-image:url(&quot;${attrEsc(url)}&quot;)"></i>`
      : '<i class="tl-fr gap"></i>';
  }

  /* 缺帧的格子贴**最近的一张**（按格序左右各找两格）：解码还没回来时整条带子是实的，
     回来一张换一张 —— 一排斜纹比一张「差半秒」的画面更像坏了。 */
  function urlsAligned(times, frames) {
    const urls = times.map((t, i) => (frames[i] && frames[i].url) || '');
    if (!urls.some(Boolean)) return urls;
    for (let i = 0; i < urls.length; i++) {
      if (urls[i]) continue;
      for (let d = 1; d <= 2 && !urls[i]; d++) {
        if (i - d >= 0 && urls[i - d]) urls[i] = urls[i - d];
        else if (i + d < urls.length && urls[i + d]) urls[i] = urls[i + d];
      }
    }
    return urls;
  }

  function applyCells(node, urls) {
    const sig = urls.join('|');
    if (node.__stripSig === sig) return;
    node.__stripSig = sig;
    node.innerHTML = urls.map(cellHTML).join('');
  }

  function paintClip(node, clip, hidden) {
    const zoom = getZoom ? getZoom() : 1;
    const cell = videoCellFor(zoom);
    const width = node.clientWidth;
    node.style.setProperty('--cell', cell + 'px');
    const count = frameCountFor(width, cell);
    const times = planFrameTimes(clip, count);
    const key = `${count}|${cell}|${num(clip.sourceStart).toFixed(3)}|${num(clip.sourceDuration).toFixed(3)}`;
    if (node.__stripKey !== key) {
      node.__stripKey = key;
      node.__stripTimes = times;
      node.__stripSig = null;
      node.innerHTML = times.map(() => cellHTML('')).join('');
    }
    if (!clip.src || clip.kind === 'image') return;
    const use = node.__stripTimes || times;
    /* ① 缓存里有的先贴（纯读，一步解码都不做）：切镜头回来时画面当场就是满的。
       容差与解码回执（frames.js 的 ensureFrames）**同一份**（spanTolOf）—— 渐进重画时
       解码流水线里现成的帧要按同一把尺顶上来；以前这里固定 0.4s，格距稍稀的素材
       渐进阶段一格都顶不上，表现就是「后半段要拖一下轨道才出现」。 */
    if (framePeek) {
      try { applyCells(node, urlsAligned(use, framePeek(clip, use, spanTolOf(use)))); } catch (e) { /* 读缓存失败就等解码那一路 */ }
    }
    if (hidden || node.__stripBusy || !ensureFrames) return;
    /* ② 剩下的排进解码流水线；回来一批换一批。
       busy 无兜底就是死锁面：回执一旦挂死（持久缓存读卡住 / 解码队列被切页挡住没醒），
       这一块永远停在「忙」，此后每次重画只走①、不再排活 —— 表现正是「后半段要拖一下轨道
       （拖动触发整块重画、节点重建、busy 归零）才出现」。30 秒没回执就放开 busy 自己重问；
       卡死的那份回执真回来时照常贴帧（applyCells 幂等），两条路谁先到谁说了算。 */
    node.__stripBusy = true;
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled || !node.isConnected) return;
      node.__stripBusy = false;
      paintClip(node, clip, hidden);
    }, STRIP_BUSY_WATCHDOG_MS);
    ensureFrames(clip, use).then(frames => {
      settled = true;
      clearTimeout(watchdog);
      node.__stripBusy = false;
      if (!node.isConnected) return;
      applyCells(node, urlsAligned(use, frames));
    }, () => { settled = true; clearTimeout(watchdog); node.__stripBusy = false; });
  }

  /* ---------------- 配音 / 字幕 ---------------- */
  function waveHTML(item) {
    const peaks = Array.isArray(item && item.peaks) ? item.peaks : [];
    if (!peaks.length) return '';
    const dur = Math.max(0.2, num(item.duration, 1));
    const bars = Math.max(10, Math.min(200, Math.round(dur * 8)));
    const list = resamplePeaks(peaks, bars);
    return `<div class="tl-wave" aria-hidden="true">${list.map(v => `<i style="height:${Math.max(6, Math.round(v * 100))}%"></i>`).join('')}</div>`;
  }

  function voiceBody(item) {
    const text = item && item.text ? item.text : '配音';
    return `${waveHTML(item)}<span class="tl-voice-txt">${esc(text)}</span>`;
  }

  function captionBody(cap) {
    return `<span class="tl-cap-txt">${esc((cap && cap.text) || '字幕')}</span>`;
  }

  function clipBody(clip, opts = {}) {
    const isImage = clip.kind === 'image';
    const src = mediaSrcOf(clip.src);
    const name = clip.name || (isImage ? '图片' : '视频');
    let media;
    if (isImage) {
      media = `<div class="tl-strip is-image"${src ? ` style="background-image:url(&quot;${attrEsc(src)}&quot;);--cell:${IMAGE_CELL_PX}px"` : ''}></div>`;
    } else {
      media = `<div class="tl-strip is-video" data-strip="${esc(clip.id)}"${src ? '' : ' data-nosrc="1"'}></div>`;
    }
    const muted = !isImage && clip.muted;
    const mute = isImage ? '' : `<button type="button" class="tl-mute${muted ? ' is-on' : ''}" data-mute="${esc(clip.id)}"
      title="${muted ? '恢复这一段原声' : '静音这一段的原声'}">${icon ? icon(muted ? 'speakerOff' : 'speaker', 11) : ''}</button>`;
    const rate = num(clip.playbackRate, 1);
    const spd = rate !== 1 ? `<span class="tl-spd">${rate}×</span>` : '';
    return `${media}
      <div class="tl-clip-top"><span class="tl-clip-name">${esc(name)}</span>${spd}</div>
      ${mute}
      ${opts.locked && icon ? `<span class="tl-lock-ic">${icon('lock', 10)}</span>` : ''}`;
  }

  /* 整块画一遍：只认还挂在树上的那些节点（重画之后旧节点自动跳过）。 */
  function paint(root, film) {
    if (!root || !film) return;
    const clips = Array.isArray(film.clips) ? film.clips : [];
    const byId = new Map(clips.map(c => [c.id, c]));
    const nodes = root.querySelectorAll('[data-strip]');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const clip = byId.get(node.getAttribute('data-strip'));
      if (!clip) continue;
      paintClip(node, clip, !!node.closest('.tl-lane.is-off'));
    }
  }

  return { paint, clipBody, voiceBody, captionBody };
}
