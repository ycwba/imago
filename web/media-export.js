/* 浏览器内离线导出 —— 成片与素材都在这一条链上出，代理只负责取数与落盘。
   管线形状照参考项目的 offlineVideoExport.js：帧计划 → 合成（逐帧画） → 混音 → mediabunny Output。
   交进来的口径 = 新剪辑核的成片（`proj.film` 经 `deriveTimeline` 摊平），engine/export.js 是唯一的组表人：
   · `clips[i] = { kind:'video'|'image', src, start, duration, sourceStart, sourceDuration, playbackRate, volume, muted }`
     —— start/duration 是**成片秒**（顺序派生，这一层不再自己累加起点），源窗口是**源秒**；
   · `transitions[i] = { id, start, end, duration, from, to }` —— 窗口由 `film.js` 的 `transitionWindow`
     算好（预览问的是同一枚函数），这一层只按它摆帧，**不再夹第二次**；
   · `voices[i]` = 绝对成片秒的配音块（含淡入淡出与倍速）；
   · `captions[i] = { text, start, end, position, highlight }` —— 字幕在画布上现画，
     不再为每一条生成一张整幅 PNG（几十条字幕就是几十张全帧图留在内存里）。
   画面按 **contain** 铺（与预览的 `object-fit: contain` 同一条）：黑边照实留在文件里，
   导出的那幅画与屏幕上看到的那幅画是同一幅 —— 比例不同的素材不裁切。
   取帧走 mediabunny CanvasSink 顺序解（整段一次解完比逐格 seek 快且稳），解不动退逐格定位
   （`MediaBackend.seekIter`，造 <video> 的活只在 media-backend.js 那一份里）；
   混音走 OfflineAudioContext（原声按段 vol、配音按块 vol × 淡入淡出，倍速用 WSOLA 变速不变调）。
   ⚠ 成片整个在内存里（BufferTarget）：1080p/几分钟的片子几十 MB，可接受；
   这个版本不支持超长片（>10 分钟会顶内存）—— 那是 StreamTarget 的活，要时再加。 */
(function () {
  'use strict';
  const VENDOR = '/web/vendor/mediabunny.min.mjs';
  const AAC_VENDOR = '/web/vendor/mediabunny-aac-encoder.min.js';
  let mbPromise = null;
  let aacPromise = null;

  function loadMb() {
    if (!mbPromise) mbPromise = import(VENDOR).catch(() => null);
    return mbPromise;
  }
  /* Chrome 的 AudioEncoder 没有 AAC → 不注册软件编码器就编不出 mp4 音轨。
     vendor 是 UMD 打包：内部按全局 `Mediabunny` 取 registerEncoder，自己再挂出
     `MediabunnyAacEncoder`。主包却是 ESM（不挂全局），所以加载前先把模块命名空间借给
     那个全局，脚本执行完再撤掉 —— 不借就是 ReferenceError，编码器根本没注册上。 */
  function ensureAac(MB) {
    if (!aacPromise) {
      aacPromise = new Promise(resolve => {
        const had = 'Mediabunny' in globalThis;
        const prev = globalThis.Mediabunny;
        try { globalThis.Mediabunny = MB; } catch (e) { /* 设不进全局就按注册失败走 */ }
        const done = ok => {
          try { if (had) globalThis.Mediabunny = prev; else delete globalThis.Mediabunny; }
          catch (e) { /* 撤不掉也不影响已经注册的编码器 */ }
          resolve(ok);
        };
        const s = document.createElement('script');
        s.src = AAC_VENDOR;
        s.onload = () => {
          try {
            const g = globalThis.MediabunnyAacEncoder;
            if (g && g.registerAacEncoder) { g.registerAacEncoder(); done(true); return; }
          } catch (e) { /* 落到下面按失败报 */ }
          done(false);
        };
        s.onerror = () => done(false);
        document.head.appendChild(s);
      });
    }
    return aacPromise;
  }

  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

  /* 选容器与编码：探针说了算（probe 是 WebCodecs 自己的 isConfigSupported，唯一一份在
     media-backend.js），不是写死 mp4 —— 没有原生 H.264 的浏览器以前会编到一半才炸。
     avc 在 → mp4（音频 aac，缺原生就靠随包软件编码器）；
     avc 不在但 vp9 在 → webm（vp9 / opus 都是 Chrome 原生）；
     两样都不在才真的导不了，当场报「换浏览器」。 */
  async function pickCodec() {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('这个浏览器不支持 WebCodecs 离线编码（要 Chrome 94+ / Edge 94+）');
    }
    if (!window.MediaBackend) {
      try { await window.__spaLoadScript('/web/media-backend.js', () => !!window.MediaBackend); } catch (e) { /* 探不到就按全不支持走 */ }
    }
    let avc = false, vp9 = false;
    if (window.MediaBackend && window.MediaBackend.probe) {
      try {
        const p = await window.MediaBackend.probe();
        avc = p.avc === true;
        vp9 = p.vp9 === true;
      } catch (e) { /* 探针出错按「都不知道」处理，落到底下的报错 */ }
    }
    if (avc) return { video: 'avc', audio: 'aac', ext: 'mp4', mime: 'video/mp4' };
    if (vp9) return { video: 'vp9', audio: 'opus', ext: 'webm', mime: 'video/webm' };
    throw new Error('这个浏览器没有可用的视频编码器（H.264 / VP9 都不行）：换 Chrome / Edge（94 以上）再导出');
  }
  /* 输出格式按选出来的容器走：fastStart 只属于 mp4。 */
  function outputFormatOf(MB, pk) {
    return pk.ext === 'mp4'
      ? new MB.Mp4OutputFormat({ fastStart: 'in-memory', metadataFormat: 'mdta' })
      : new MB.WebMOutputFormat();
  }

  /* 帧计划：fps 夹到 24–60；每格 { index, timestamp, duration, keyFrame }。 */
  function framePlan(duration, fps, keyFrameInterval) {
    const f = clampN(Math.round(Number(fps) || 30), 24, 60);
    const dur = Math.max(1 / f, Number(duration) || 0);
    const n = Math.max(1, Math.ceil(dur * f));
    const keyEvery = Math.max(1, Math.round(f * clampN(Number(keyFrameInterval) || 2, 0.25, 10)));
    return Array.from({ length: n }, (_, i) => ({
      index: i, timestamp: i / f, duration: 1 / f, keyFrame: i % keyEvery === 0,
    }));
  }

  /* WSOLA 变速不变调（照参考项目 pitchPreservingTimeStretch.js 的做法）：
     重叠叠接 + 相关对齐找接缝。rate>1 = 变快（输出更短）。纯函数、逐声道跑。 */
  function timeStretchCh(input, rate) {
    const r = clampN(Number(rate) || 1, 0.25, 4);
    const src = input instanceof Float32Array ? input : Float32Array.from(input || []);
    if (!src.length) return new Float32Array(1);
    if (Math.abs(r - 1) < 0.0001) return src.slice();
    const frame = Math.min(2048, Math.max(256, src.length));
    const hop = Math.max(1, Math.round(frame / 4));
    const overlap = frame - hop;
    const outLen = Math.max(1, Math.round(src.length / r));
    const out = new Float32Array(outLen);
    let outPos = 0, srcPos = 0;
    let prevOut = new Float32Array(frame);
    let first = true;
    while (outPos < outLen) {
      const expected = Math.round(outPos * r);
      let best = expected, bestScore = -Infinity;
      if (!first) {
        const radius = Math.max(32, Math.min(256, Math.floor(frame / 8)));
        for (let off = -radius; off <= radius; off += 4) {
          const cand = clampN(expected + off, 0, src.length - 1);
          let dot = 0, le = 0, re = 0;
          for (let i = 0; i < overlap; i += 16) {
            const a = prevOut[hop + i] || 0;
            const b = src[cand + i] || 0;
            dot += a * b; le += a * a; re += b * b;
          }
          const score = dot / Math.sqrt(Math.max(1e-12, le * re));
          if (score > bestScore) { bestScore = score; best = cand; }
        }
      }
      srcPos = best;
      for (let i = 0; i < frame && outPos + i < outLen; i++) {
        const s = src[srcPos + i] || 0;
        if (first || i < hop) out[outPos + i] = s;
        else {
          const w = (i - hop) / overlap;
          out[outPos + i] = (out[outPos + i] || 0) * (1 - w) + s * w;
        }
      }
      prevOut = Float32Array.from(src.subarray(srcPos, srcPos + frame));
      first = false;
      outPos += hop;
    }
    return out;
  }

  /* 取字节：与 AssetTransfer 同一通道（/asset/、外链、data:）都认。 */
  async function bytesOf(src) {
    if (window.AssetTransfer && AssetTransfer.blobOf) return await AssetTransfer.blobOf(src);
    const r = await fetch(src);
    if (!r.ok) throw new Error('取不到素材字节：' + src);
    return await r.blob();
  }

  /* 解一段音频 [from, to]（秒）→ AudioBuffer；解不了返回 null（不硬来）。 */
  async function decodeSlice(src, from, to) {
    const MB = await loadMb();
    if (!MB || !MB.Input) return null;
    let input = null;
    try {
      const blob = await bytesOf(src);
      input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track || !await track.canDecode()) return null;
      const sink = new MB.AudioBufferSink(track);
      const out = [];
      let rate = 48000, ch = 2;
      for await (const { buffer, timestamp } of sink.buffers()) {
        if (to != null && timestamp >= to) break;
        if (to != null && timestamp + buffer.duration <= from) continue;
        rate = buffer.sampleRate; ch = buffer.numberOfChannels;
        out.push({ buffer, timestamp });
      }
      if (!out.length) return null;
      /* 拼回一整段，再按 [from,to] 裁齐（段间可能有缝，按时间戳摆正）。 */
      const start = Math.max(0, Number(from) || 0);
      const end = to != null ? Number(to) : (out[out.length - 1].timestamp + out[out.length - 1].buffer.duration);
      const len = Math.max(1, Math.round((end - start) * rate));
      const ctx = new window.OfflineAudioContext(ch, len, rate);
      const acc = ctx.createBuffer(ch, len, rate);
      for (const { buffer, timestamp } of out) {
        for (let c = 0; c < Math.min(ch, buffer.numberOfChannels); c++) {
          const dst = acc.getChannelData(c);
          const srcD = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
          const at = Math.round((timestamp - start) * rate);
          for (let i = 0; i < srcD.length && at + i < dst.length; i++) {
            if (at + i >= 0) dst[at + i] = srcD[i];
          }
        }
      }
      return acc;
    } catch (e) { return null; }
    finally { try { if (input) input.dispose(); } catch (e) { /* 收尾清理，失败也要往下走 */ } }
  }

  /* 混音：原声（段音量 / 静音）+ 配音（块音量 × 淡入淡出包络 × 倍速）→ 一个 AudioBuffer（null = 全静音）。
     两路都是**绝对成片秒**：`clips[i].start` 是段在成片里的起点，`voices[i].start` 是块在成片里的起点 ——
     配音不再挂在段上、也不再从段起点折算（那是旧模型的第二本账）。
     包络形状与预览一致（`film.js` 的 `fadeGain`：线性斜坡，淡入淡出各夹到块时长的一半）。 */
  async function mixAudio(opts) {
    const duration = Math.max(0.1, Number(opts.duration) || 0.1);
    const rate = 48000;
    const ctx = new window.OfflineAudioContext(2, Math.ceil(duration * rate), rate);
    let scheduled = 0;
    /* atSec = 落点（成片秒）；stretch = 倍速（>1 = 变快、输出更短）；fade = { in, out } 块内秒。 */
    const putGain = (buffer, atSec, gain, stretch, fade) => {
      if (!buffer || !(gain > 0) || atSec >= duration) return;
      let buf = buffer;
      if (stretch && Math.abs(stretch - 1) > 0.01) {
        const chs = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(timeStretchCh(buffer.getChannelData(c), stretch));
        const nb = ctx.createBuffer(chs.length || 1, chs[0] ? chs[0].length : 1, buffer.sampleRate);
        chs.forEach((d, c) => nb.getChannelData(c).set(d));
        buf = nb;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      src.connect(g).connect(ctx.destination);
      /* 包络按**变速之后**的实际长度走：那才是这一块在成片里占的秒数。 */
      const blockDur = buf.duration;
      const t0 = Math.max(0, atSec);
      const fi = Math.min(Math.max(0, Number(fade && fade.in) || 0), blockDur / 2);
      const fo = Math.min(Math.max(0, Number(fade && fade.out) || 0), blockDur / 2);
      g.gain.setValueAtTime(fi > 0 ? 0 : gain, t0);
      if (fi > 0) g.gain.linearRampToValueAtTime(gain, t0 + fi);
      if (fo > 0) {
        g.gain.setValueAtTime(gain, Math.max(t0 + fi, t0 + blockDur - fo));
        g.gain.linearRampToValueAtTime(0, Math.min(duration, t0 + blockDur));
      }
      try { src.start(t0); scheduled++; } catch (e) { /* 收尾清理，失败也要往下走 */ }
    };
    /* 每段的原声：图片段没有原声；`volume` 已由渲染计划按 gainOf 算过（静音 = 0），
       这里不再重判 muted —— 两处各判一次，屏幕上静着、导出来却有声就是从这里开始的。 */
    for (const cl of (opts.clips || [])) {
      if (cl.kind === 'image') continue;
      const sp = clampN(Number(cl.playbackRate) || 1, 0.25, 4);
      const f0 = Math.max(0, Number(cl.start) || 0);
      const vol = cl.volume == null ? 1 : Number(cl.volume);
      if (cl.src && vol > 0) {
        const from = Math.max(0, Number(cl.sourceStart) || 0);
        const to = from + Math.max(0.05, Number(cl.sourceDuration) || 0);
        const buf = await decodeSlice(cl.src, from, to);
        putGain(buf, f0, vol, sp, null);
      }
    }
    /* 配音：解「素材里的那一窗」，变速之后落在成片的绝对秒上 */
    for (const v of (opts.voices || [])) {
      const vol = v.volume == null ? 1 : Number(v.volume);
      if (!v.src || !(vol > 0)) continue;
      const from = Math.max(0, Number(v.sourceStart) || 0);
      const to = from + Math.max(0.1, Number(v.sourceDuration) || 0);
      const buf = await decodeSlice(v.src, from, to);
      putGain(buf, Math.max(0, Number(v.start) || 0), vol,
        clampN(Number(v.playbackRate) || 1, 0.25, 4), { in: v.fadeIn, out: v.fadeOut });
    }
    if (!scheduled) return null;
    return await ctx.startRendering();
  }

  /* 只画画面、不清底：转场层要把下一段叠在已经铺好的那一帧上面。 */
  function drawContain(ctx, w, h, src) {
    if (!src) return;
    const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight;
    if (!sw || !sh) return;
    const scale = Math.min(w / sw, h / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /* 画一帧：先铺黑底，再把画面按 contain 居中放进去（预览的 `object-fit: contain` 同一条）。
     没有画面（素材地址空 / 解不出帧）= 只剩那块黑底。 */
  function drawFrame(ctx, w, h, src) {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
    drawContain(ctx, w, h, src);
  }

  /* 转场合成：与预览层 `.preview-transition-layer`（web/director/template.html）逐条对应 ——
     屏幕上那一刀与片子里那一刀得是同一刀。下面三枚数是照那几条 CSS 抄的，改一边要改另一边：
     `--sp-12` = 模糊半径 12px（type-blur）、1.12 = type-zoom 的起始缩放、0.7 = 闪白那层的透明度。
     `glitch` 在预览里没有对应的效果（只有淡入），这里也照实按淡入合成 —— 不假装导出了花屏。 */
  const TR_BLUR_PX = 12;
  const TR_ZOOM_SCALE = 1.12;
  const TR_FLASH_ALPHA = 0.7;

  /* `p` = 窗口进度 0→1：下一段淡入 / 推进 / 落回清晰的整幅叠在底帧上。 */
  function compositeTransition(ctx, w, h, id, p, src) {
    if (!src) return;
    const prog = clampN(p, 0, 1);
    ctx.save();
    let alpha = prog;
    if (id === 'wipe-left') {
      ctx.beginPath(); ctx.rect(w * (1 - prog), 0, w * prog, h); ctx.clip(); alpha = 1;
    } else if (id === 'wipe-up') {
      ctx.beginPath(); ctx.rect(0, h * (1 - prog), w, h * prog); ctx.clip(); alpha = 1;
    } else if (id === 'split') {
      const dw = w * prog;
      ctx.beginPath(); ctx.rect((w - dw) / 2, 0, dw, h); ctx.clip(); alpha = 1;
    } else if (id === 'zoom') {
      const s = TR_ZOOM_SCALE - prog * (TR_ZOOM_SCALE - 1);
      ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
    } else if (id === 'blur') {
      /* 半径按画幅高等比缩（CSS 那条作用在 ~1080 高的台子上） */
      ctx.filter = 'blur(' + ((1 - prog) * TR_BLUR_PX * (h / 1080)).toFixed(2) + 'px)';
    }
    ctx.globalAlpha = clampN(alpha, 0, 1);
    drawContain(ctx, w, h, src);
    ctx.restore();
    if (id === 'flash') {
      ctx.save();
      ctx.globalAlpha = TR_FLASH_ALPHA * prog;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  /* 字幕现画：形状照预览叠层 `.sub-ov`（web/director/template.html）那一条 ——
     字号 = 画布高的 54/1080、左右各留 6%、行高 1.28、底部块离底 9% / 顶部块离顶 8% /
     居中那一档垂直居中、高亮 = 黑底 55% + 圆角 + .18em .45em 内边距、字色 `--on-acc`（白）带黑投影。
     改那一族 CSS 要回来对着改这里，否则屏幕上与片子里的字幕是两副样子。 */
  const CAP_SIZE_RATIO = 54 / 1080;
  const CAP_SIDE_RATIO = 0.06;
  const CAP_LINE_HEIGHT = 1.28;
  const CAP_BOTTOM_RATIO = 0.09;
  const CAP_TOP_RATIO = 0.08;
  const CAP_HL_ALPHA = 0.55;
  const CAP_FONT_WEIGHT = 600;
  const CAP_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  /* 中日韩与全角标点：逐字可断（与浏览器的 pre-wrap 一样）；拉丁词不拆开。 */
  const CAP_CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

  /* 把一行切成「可断单元」：CJK 一字一单元，其余攒到空白为止（空白跟着前一个单元，
     这样换行不会把一行的开头空出来）。 */
  function captionUnits(text) {
    const units = [];
    let buf = '';
    for (const ch of String(text || '')) {
      if (CAP_CJK.test(ch)) { if (buf) { units.push(buf); buf = ''; } units.push(ch); continue; }
      buf += ch;
      if (/\s/.test(ch)) { units.push(buf); buf = ''; }
    }
    if (buf) units.push(buf);
    return units;
  }

  function wrapCaptionLine(ctx, text, maxW) {
    const out = [];
    let line = '', lineWidth = 0;
    const pushLine = () => { out.push(line.replace(/\s+$/, '')); line = ''; lineWidth = 0; };
    for (const u of captionUnits(text)) {
      const uw = ctx.measureText(u).width;
      if (line && lineWidth + uw > maxW) pushLine();
      /* 单个单元本身就超宽（一长串字母数字）：逐字硬断，不断就溢出画面 */
      if (!line && uw > maxW && u.length > 1) {
        for (const ch of u) {
          const cw = ctx.measureText(ch).width;
          if (line && lineWidth + cw > maxW) pushLine();
          line += ch; lineWidth += cw;
        }
        continue;
      }
      line += u; lineWidth += uw;
    }
    if (line) pushLine();
    return out;
  }

  /* 一条字幕 → 要画的几行：先按硬换行分段（`\n` 在预览里是 `<br>`），每段再按宽度折。 */
  function captionLines(ctx, text, maxW) {
    const out = [];
    for (const para of String(text || '').split(/\r?\n/)) {
      if (!para) { out.push(''); continue; }
      for (const l of wrapCaptionLine(ctx, para, maxW)) out.push(l);
    }
    return out.length ? out : [''];
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const rad = Math.min(Math.max(0, r), w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y); ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad); ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h); ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad); ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
  }

  /* `list` 已经由调用方按「这一秒该露哪几条」筛好（行可见性在编辑核那一层判，这里不问）。 */
  function drawCaptions(ctx, w, h, list) {
    if (!list || !list.length) return;
    const fs = Math.max(8, h * CAP_SIZE_RATIO);
    const lh = fs * CAP_LINE_HEIGHT;
    const maxW = w * (1 - CAP_SIDE_RATIO * 2);
    const cx = w / 2;
    ctx.save();
    ctx.font = CAP_FONT_WEIGHT + ' ' + fs.toFixed(1) + 'px ' + CAP_FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of list) {
      const text = String((c && c.text) || '');
      if (!text.trim()) continue;
      const lines = captionLines(ctx, text, maxW);
      const blockH = lines.length * lh;
      const pos = c.position === 'top' ? 'top' : (c.position === 'middle' ? 'middle' : 'bottom');
      const top = pos === 'top' ? h * CAP_TOP_RATIO
        : pos === 'middle' ? (h - blockH) / 2
          : h * (1 - CAP_BOTTOM_RATIO) - blockH;
      if (c.highlight) {
        let bw = 0;
        for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
        const padX = fs * 0.45, padY = fs * 0.18;
        roundRectPath(ctx, cx - bw / 2 - padX, top - padY, bw + padX * 2, blockH + padY * 2, fs * 0.11);
        ctx.fillStyle = 'rgba(0,0,0,' + CAP_HL_ALPHA + ')';
        ctx.fill();
      }
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = fs * (6 / 54);
      ctx.shadowOffsetY = fs * (2 / 54);
      ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, cx, top + lh * (i + 0.5)));
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.restore();
  }

  /* 兜底取帧要借 media-backend.js 的 <video> 原语；这一页还没加载它就补一次。
     AGENTS §7：`createElement('video')` 只许出现在那一份里，导出这层只调它的口。 */
  async function mediaBackend() {
    if (window.MediaBackend && window.MediaBackend.seekIter) return window.MediaBackend;
    if (typeof window.__spaLoadScript === 'function') {
      try { await window.__spaLoadScript('/web/media-backend.js', () => !!(window.MediaBackend && window.MediaBackend.seekIter)); } catch (e) { /* 加载不起来就报不可用 */ }
    }
    return window.MediaBackend && window.MediaBackend.seekIter ? window.MediaBackend : null;
  }

  /* 图片段（kind:'image'）：字节只取一次，之后每一段里的每一帧都画同一张。
     createImageBitmap 直接给 drawImage 用；解不动（老浏览器 / 格式怪）退 <img> + blob URL，
     两个都要在收尾时释放 —— 一段一张，三十段不释放就是三十张整图留在内存里。 */
  async function loadStill(src) {
    const blob = await bytesOf(src);
    if (typeof createImageBitmap === 'function') {
      try { return { bmp: await createImageBitmap(blob), url: '' }; } catch (e) { /* 退下面的 <img> */ }
    }
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.src = url;
    await new Promise(res => { im.onload = res; im.onerror = res; });
    if (!im.width) { URL.revokeObjectURL(url); throw new Error('这张图片解不开：' + src); }
    return { bmp: null, img: im, url };
  }
  const stillDrawable = st => (st ? (st.bmp || st.img) : null);

  /* 每段一个「顺序取帧器」：主档 CanvasSink.canvasesAtTimestamps（顺序解，快且稳）；
     解不动退逐格定位（慢但兼容）。没有地址的段不出帧（画面上就是黑底）。 */
  async function makeFrameIter(cl, timestamps, MB) {
    if (!cl.src || !timestamps.length) return null;
    try {
      const blob = await bytesOf(cl.src);
      const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error('解不动');
      const sink = new MB.CanvasSink(track, { poolSize: 2, decoderOptions: { optimizeForLatency: true } });
      const it = sink.canvasesAtTimestamps(timestamps)[Symbol.asyncIterator]();
      return {
        mode: 'sequential-webcodecs',
        async next() {
          const r = await it.next();
          return r.done ? null : (r.value && r.value.canvas) || null;
        },
        /* 先结束迭代器、等它把在途的解码收完，再释放 input ——
           顺序反过来时还在拉的样本会撞上已释放的 input（InputDisposedError）。 */
        async close() {
          try { if (typeof it.return === 'function') await it.return(); } catch (e) { /* 迭代器收尾失败也要往下走 */ }
          try { input.dispose(); } catch (e) { /* 收尾清理，失败也要往下走 */ }
        },
        dispose() { try { input.dispose(); } catch (e) { /* 兜底：close 没走到时才用它 */ } },
      };
    } catch (e) {
      const be = await mediaBackend();
      if (!be) return { mode: 'unavailable', async next() { return null; }, dispose() { /* 没有要释放的东西 */ } };
      return be.seekIter(cl.src, timestamps);
    }
  }

  /* 主入口：导出一条成片。`clips[i]` 带成片秒的 start/duration 与源窗口（源秒），
     `transitions[i]` 是 film.js 夹好的窗口，`voices` / `captions` 都是绝对成片秒。
     返回 { blob, ext, mime, diag }；取消走 signal（abort 后抛 '已取消'）。 */
  async function exportFilm(o) {
    const opts = o || {};
    const MB = await loadMb();
    if (!MB) throw new Error('浏览器里没有 mediabunny，编不了成片');
    /* 容器与编码先定：后面每一处（音频编码器、输出格式、回执的扩展名）都按它走 */
    const pk = await pickCodec();
    const w = Math.max(2, Math.round(Number(opts.width) || 1280));
    const h = Math.max(2, Math.round(Number(opts.height) || 720));
    const fps = clampN(Math.round(Number(opts.fps) || 30), 24, 60);
    const duration = Math.max(1 / fps, Number(opts.duration) || 1);
    const signal = opts.signal;
    const throwIfAbort = () => { if (signal && signal.aborted) throw new Error('已取消'); };
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    throwIfAbort();
    if (opts.audio !== false && pk.audio === 'aac') await ensureAac(MB);
    onProgress({ progress: 4, msg: '正在准备…' });
    const plan = framePlan(duration, fps, opts.keyFrameInterval);
    /* 混音与取帧准备并行 —— 互不依赖 */
    const audioPromise = opts.audio === false ? Promise.resolve(null)
      : mixAudio({ clips: opts.clips, voices: opts.voices, duration });
    /* 每段一个槽：起点 / 跨度按**成片秒**给（deriveTimeline 摊出来的那一列），不再自己累加 */
    const rows = [];
    for (const cl of (opts.clips || [])) {
      throwIfAbort();
      const sp = clampN(Number(cl.playbackRate) || 1, 0.25, 4);
      const f0 = Math.max(0, Number(cl.start) || 0);
      const span = Math.max(0, Number(cl.duration) || 0);
      if (cl.kind === 'image') {
        const still = cl.src ? await loadStill(cl.src) : null;
        rows.push({ cl, f0, span, speed: sp, iter: null, still: stillDrawable(still), stillRes: still });
        continue;
      }
      const times = plan.filter(f => f.timestamp >= f0 - 1e-6 && f.timestamp < f0 + span - 1e-6)
        .map(f => Math.max(0, (Number(cl.sourceStart) || 0) + (f.timestamp - f0) * sp));
      const iter = await makeFrameIter(cl, times, MB);
      rows.push({ cl, f0, span, speed: sp, iter, still: null, stillRes: null });
    }
    /* 转场窗口：下一段在那一窗里露的是**它自己的开头**（与预览同一把尺子：
       源时刻 = 下段 sourceStart + (成片秒 − 窗口起点) × 下段倍速）。
       这一段帧落在下段顺序表的前面，同一只迭代器不能倒着走，所以进窗时**另建一只**、出窗立刻释放
       —— 同时最多活着一只，不会为每个窗口各留一份解码器。 */
    const windows = (opts.transitions || [])
      .map(x => ({
        id: String((x && x.id) || ''),
        start: Math.max(0, Number(x && x.start) || 0),
        end: Math.max(0, Number(x && x.end) || 0),
        duration: Math.max(0.01, Number(x && x.duration) || 0),
        to: Number(x && x.to),
        active: null,
      }))
      .filter(x => x.end > x.start);
    const captionList = (opts.captions || []).map(c => ({
      text: String((c && c.text) || ''),
      start: Math.max(0, Number(c && c.start) || 0),
      end: Math.max(0, Number(c && c.end) || 0),
      position: c && c.position,
      highlight: !!(c && c.highlight),
    })).filter(c => c.end > c.start && c.text.trim());
    async function ensureIncoming(win) {
      const row = rows[win.to];
      if (!row) return null;
      /* 图片段本来就是「一张画一直用」：直接借它已经载好的那一张，不再解第二遍 */
      if (row.cl.kind === 'image') return { kind: 'image', drawable: row.still };
      const times = plan.filter(f => f.timestamp >= win.start - 1e-6 && f.timestamp < win.end - 1e-6)
        .map(f => Math.max(0, (Number(row.cl.sourceStart) || 0) + (f.timestamp - win.start) * row.speed));
      const iter = await makeFrameIter(row.cl, times, MB);
      return iter ? { kind: 'video', iter } : null;
    }
    async function releaseIncoming(win) {
      const a = win && win.active;
      if (!a || !a.iter) { if (win) win.active = null; return; }
      win.active = null;
      try { if (a.iter.close) await a.iter.close(); else if (a.iter.dispose) a.iter.dispose(); }
      catch (e) { /* 释放失败不影响结果 */ }
    }
    const audioBuffer = await audioPromise;
    throwIfAbort();
    onProgress({ progress: 10, msg: '正在逐帧合成…' });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('创建不了离线导出画布');
    const target = new MB.BufferTarget();
    const output = new MB.Output({ format: outputFormatOf(MB, pk), target });
    const videoSource = new MB.CanvasSource(canvas, {
      codec: pk.video,
      bitrate: Math.max(1e6, Number(opts.bitrate) || 12e6),
      keyFrameInterval: Math.max(0.25, Number(opts.keyFrameInterval) || 2),
      latencyMode: 'realtime',
    });
    output.addVideoTrack(videoSource, { frameRate: fps });
    let audioSource = null;
    if (audioBuffer) {
      audioSource = new MB.AudioBufferSource({ codec: pk.audio, bitrate: Math.max(96000, Number(opts.audioBitrate) || 320000) });
      output.addAudioTrack(audioSource);
    }
    const abortOut = () => { output.cancel().catch(() => {}); };
    if (signal) signal.addEventListener('abort', abortOut, { once: true });
    /* 此刻正压着的那一窗转场：声明在 try 外面，收尾（disposeAll）才拿得到它去释放那只在途的取帧器 */
    let winNow = null;
    const disposeAll = async () => {
      await releaseIncoming(winNow);
      for (const it of rows) {
        if (it.stillRes) {
          try { if (it.stillRes.bmp && it.stillRes.bmp.close) it.stillRes.bmp.close(); } catch (e) { /* 释放失败不影响结果 */ }
          try { if (it.stillRes.url) URL.revokeObjectURL(it.stillRes.url); } catch (e) { /* 释放失败不影响结果 */ }
        }
        if (!it.iter) continue;
        try {
          if (it.iter.close) await it.iter.close();
          else if (it.iter.dispose) it.iter.dispose();
        } catch (e) { /* 释放失败不影响结果 */ }
      }
    };
    /* 取帧链的诊断（顺序解 / 逐格定位）在外面的回执里要报 —— 声明放 try 外面 */
    const decodeModes = [];
    const pushMode = m => { if (m && decodeModes.indexOf(m) < 0) decodeModes.push(m); };
    try {
      throwIfAbort();
      await output.start();
      if (audioSource) await audioSource.add(audioBuffer);
      const step = Math.max(1, Math.round(plan.length / 100));
      for (const f of plan) {
        throwIfAbort();
        const t = f.timestamp;
        /* 这一帧落在哪一段 / 正压在哪一窗转场上（两个都是顺序表上的小扫描，段数与窗数都不大） */
        let win = null;
        for (const x of windows) {
          if (t >= x.start - 1e-6 && t < x.end - 1e-6) { win = x; break; }
        }
        if (win !== winNow) {
          if (winNow) await releaseIncoming(winNow);
          winNow = win;
          if (winNow && !winNow.active) winNow.active = await ensureIncoming(winNow);
        }
        let hit = null;
        for (const it of rows) {
          if (t >= it.f0 - 1e-6 && t < it.f0 + it.span - 1e-6) { hit = it; break; }
        }
        if (hit && hit.still) {
          drawFrame(ctx, w, h, hit.still);
          pushMode('static-image');
        } else if (hit && hit.iter) {
          const frame = await hit.iter.next();
          drawFrame(ctx, w, h, frame || null);
          pushMode(hit.iter.mode);
        } else {
          drawFrame(ctx, w, h, null);           // 没有地址 / 解不出画面：留一块黑底
        }
        if (winNow && winNow.active) {
          const a = winNow.active;
          const inc = a.kind === 'image' ? a.drawable : await a.iter.next();
          if (a.kind === 'image') pushMode('static-image'); else pushMode(a.iter.mode);
          compositeTransition(ctx, w, h, winNow.id, (t - winNow.start) / winNow.duration, inc);
        }
        let live = null;
        for (const c of captionList) {
          if (t >= c.start && t < c.end) (live || (live = [])).push(c);
        }
        drawCaptions(ctx, w, h, live);
        await videoSource.add(f.timestamp, f.duration, { keyFrame: f.keyFrame });
        if (f.index % step === 0) onProgress({ progress: 10 + Math.round(f.index / plan.length * 84), msg: '正在合成 ' + (f.index + 1) + '/' + plan.length + ' 帧' });
      }
      throwIfAbort();
      await output.finalize();
    } catch (e) {
      await output.cancel().catch(() => {});
      throw e;
    } finally {
      if (signal) signal.removeEventListener('abort', abortOut);
      await disposeAll();
    }
    onProgress({ progress: 98, msg: '正在打包…' });
    return {
      blob: new Blob([target.buffer], { type: pk.mime }),
      ext: pk.ext, mime: pk.mime,
      diag: {
        width: w, height: h, fps, frames: plan.length, decodeModes,
        hasAudio: !!audioBuffer, codec: pk.video,
        transitions: windows.length, captions: captionList.length,
      },
    };
  }

  /* 给没有音轨的视频补一条静音轨：
     有些平台的参考视频槽位声明 requiresAudio —— 没有音轨的视频直接传会被拒。
     先试**流拷贝**（PacketSource 原样搬视频样本，不重编码，秒级）；解不动退逐帧重编码。
     返回 { blob, added }：added = 1 表示补了音轨（调用方按它把文件名改成 .mp4）。 */
  async function ensureAudioTrack(blob) {
    const MB = await loadMb();
    if (!MB) throw new Error('浏览器里没有 mediabunny，补不了音轨');
    let input = null;
    try {
      input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) return { blob, added: false };            // 不是视频，原样交
      const at = await input.getPrimaryAudioTrack();
      if (at && await at.canDecode()) return { blob, added: false };   // 本来就有音轨
      const duration = await input.computeDuration();
      const silent = silentAudioBuffer(duration);
      /* 每条路一个**新的** Output：流拷贝失败时 output 可能已经 start 过，复用会炸 */
      if (MB.PacketSource) {
        try {
          const target = new MB.BufferTarget();
          const output = new MB.Output({
            format: new MB.Mp4OutputFormat({ fastStart: 'in-memory', metadataFormat: 'mdta' }),
            target,
          });
          const vSrc = new MB.PacketSource(vt);
          output.addVideoTrack(vSrc);
          const aSrc = new MB.AudioBufferSource({ codec: 'aac', bitrate: 96000 });
          output.addAudioTrack(aSrc);
          await output.start();
          const pumpPackets = async () => {
            for await (const packet of vt.packets()) await vSrc.add(packet);
          };
          await Promise.all([aSrc.add(silent), pumpPackets()]);
          await output.finalize();
          if (target.buffer && target.buffer.byteLength) {
            return { blob: new Blob([target.buffer], { type: 'video/mp4' }), added: true };
          }
        } catch (e) { /* 流拷贝这条路解不动 → 退逐帧重编码 */ }
      }
      /* 兜底：逐帧重编码（慢，但任何能解的视频都走得通） */
      {
        const target = new MB.BufferTarget();
        const output = new MB.Output({
          format: new MB.Mp4OutputFormat({ fastStart: 'in-memory', metadataFormat: 'mdta' }),
          target,
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, Math.round(vt.codedWidth || 1280));
        canvas.height = Math.max(2, Math.round(vt.codedHeight || 720));
        const ctx = canvas.getContext('2d', { alpha: false });
        const vEnc = new MB.CanvasSource(canvas, { codec: 'avc', bitrate: 8e6, latencyMode: 'realtime' });
        output.addVideoTrack(vEnc, { frameRate: 30 });
        const aSrc2 = new MB.AudioBufferSource({ codec: 'aac', bitrate: 96000 });
        output.addAudioTrack(aSrc2);
        await output.start();
        await aSrc2.add(silent);
        const sink = new MB.CanvasSink(vt, { poolSize: 2 });
        let lastT = 0;
        for await (const { canvas: fr, timestamp, duration: fd } of sink.canvases()) {
          drawFrame(ctx, canvas.width, canvas.height, fr);
          await vEnc.add(timestamp, fd || (timestamp - lastT) || 0.04, { keyFrame: false });
          lastT = timestamp;
        }
        await output.finalize();
        if (!target.buffer || !target.buffer.byteLength) throw new Error('补音轨失败：这段视频解不出帧');
        return { blob: new Blob([target.buffer], { type: 'video/mp4' }), added: true };
      }
    } finally { try { if (input) input.dispose(); } catch (e) { /* 释放失败不影响结果 */ } }
  }

  /* 全零的静音 AudioBuffer（补音轨用）：createBuffer 出来本身就是零，不用渲染。 */
  function silentAudioBuffer(duration) {
    const rate = 48000;
    const len = Math.max(1, Math.ceil(Math.max(0.1, duration) * rate));
    const ctx = new window.OfflineAudioContext(2, len, rate);
    return ctx.createBuffer(2, len, rate);
  }

  window.MediaExport = { framePlan, exportFilm, pickCodec, mixAudio, timeStretchCh, ensureAudioTrack };
})();
