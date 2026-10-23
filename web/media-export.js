/* 浏览器内离线导出 —— 成片与素材都在这一条链上出，代理只负责取数与落盘。
   管线形状照参考项目的 offlineVideoExport.js：帧计划 → 合成（逐帧画） → 混音 → mediabunny Output。
   合成模型是**本项目的 clips**：`{ src: 'black'|地址, in, out, speed, volume, voices:[…] }`
   （buildRenderClips 组的那份；黑场 = src:'black'，配音挂在段上）。
   图片段多一个 `still`（静态图地址）：`src` 仍是 'black'（没有原声、没有解码源），整段画那一张。
   取帧走 mediabunny CanvasSink 顺序解（整段一次解完比逐格 seek 快且稳），解不动退逐格定位
   （`MediaBackend.seekIter`，造 <video> 的活只在 media-backend.js 那一份里）；
   混音走 OfflineAudioContext（原声按段 vol、配音按句 vol，倍速用 WSOLA 变速不变调）。
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

  /* 混音：原声（段 vol × 变速）+ 配音（句 vol × 变速）→ 一个 AudioBuffer（或 null = 全静音）。
     clips 的口径只有一份（`clipVoices`）：voice.start 是源秒（相对段 in），落点 = 段起点 + start/speed。 */
  async function mixAudio(opts) {
    const duration = Math.max(0.1, Number(opts.duration) || 0.1);
    const rate = 48000;
    const ctx = new window.OfflineAudioContext(2, Math.ceil(duration * rate), rate);
    let scheduled = 0;
    const putGain = (buffer, atSec, gain, stretch) => {
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
      g.gain.value = gain;
      src.connect(g).connect(ctx.destination);
      try { src.start(Math.max(0, atSec)); scheduled++; } catch (e) { /* 收尾清理，失败也要往下走 */ }
    };
    /* 每段的原声 */
    for (const cl of (opts.clips || [])) {
      const sp = clampN(Number(cl.speed) || 1, 0.25, 4);
      const f0 = Math.max(0, Number(cl.filmStart) || 0);
      const vol = cl.volume == null ? 1 : Number(cl.volume);
      if (cl.src && cl.src !== 'black' && vol > 0) {
        const from = Math.max(0, Number(cl.in) || 0);
        const to = Math.max(from + 0.05, Number(cl.out) || 0);
        const buf = await decodeSlice(cl.src, from, to);
        putGain(buf, f0, vol, sp);
      }
      /* 挂在这一段上的配音（口径见 clipVoices：start 源秒 / dur 音频秒 / off 音频内起点） */
      for (const v of (cl.voices || [])) {
        const vr = sp * (clampN(Number(v.spd) || 1, 0.25, 4));
        const at = f0 + (Math.max(0, Number(v.start) || 0) / sp);
        const dur = Math.max(0.1, Number(v.dur) || 0);
        const off = Math.max(0, Number(v.off) || 0);
        const buf = await decodeSlice(v.src, off, off + dur);
        putGain(buf, at, Number(v.vol) == null ? 1 : Number(v.vol), vr);
      }
    }
    if (!scheduled) return null;
    return await ctx.startRendering();
  }

  /* 画一帧：黑场填黑；图片/视频帧按 cover（居中裁切）铺满画布。 */
  function drawFrame(ctx, w, h, src) {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
    if (!src) return;
    const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight;
    if (!sw || !sh) return;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
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

  /* 图片段（cl.still）：字节只取一次，之后每一帧都画同一张。
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
     解不动退逐格定位（慢但兼容）。黑场不出帧。 */
  async function makeFrameIter(cl, timestamps, MB) {
    if (!cl.src || cl.src === 'black' || !timestamps.length) return null;
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

  /* 主入口：导出一条成片。clips 里每条要带 filmStart（段在成片里的起点秒）。
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
      : mixAudio({ clips: opts.clips, duration });
    /* 每段的取帧器（按帧计划切出各段要的源时刻） */
    const iters = [];
    for (const cl of (opts.clips || [])) {
      throwIfAbort();
      const sp = clampN(Number(cl.speed) || 1, 0.25, 4);
      const f0 = Math.max(0, Number(cl.filmStart) || 0);
      const span = Math.max(0, (Number(cl.out) - Number(cl.in)) / sp);
      if (cl.still) {
        const still = await loadStill(cl.still);
        iters.push({ cl, iter: null, still: stillDrawable(still), stillRes: still, times: [], at: 0, f0, span });
        continue;
      }
      const times = plan.filter(f => f.timestamp >= f0 - 1e-6 && f.timestamp < f0 + span - 1e-6)
        .map(f => Math.max(0, (Number(cl.in) || 0) + (f.timestamp - f0) * sp));
      const iter = await makeFrameIter(cl, times, MB);
      iters.push({ cl, iter, times, at: 0, f0, span });
    }
    const audioBuffer = await audioPromise;
    throwIfAbort();
    onProgress({ progress: 10, msg: '正在逐帧合成…' });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('创建不了离线导出画布');
    /* 字幕帧（整幅 PNG，start/end 成片秒） */
    const subImgs = [];
    for (const s of (opts.subtitles || [])) {
      const im = new Image();
      im.src = s.src;
      await new Promise(res => { im.onload = res; im.onerror = res; });
      if (im.width) subImgs.push({ im, start: Number(s.start) || 0, end: Number(s.end) || 0 });
    }
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
    const disposeAll = async () => {
      for (const it of iters) {
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
    try {
      throwIfAbort();
      await output.start();
      if (audioSource) await audioSource.add(audioBuffer);
      const step = Math.max(1, Math.round(plan.length / 100));
      for (const f of plan) {
        throwIfAbort();
        /* 找这一帧落在哪一段 */
        let hit = null;
        for (const it of iters) {
          if (f.timestamp >= it.f0 - 1e-6 && f.timestamp < it.f0 + it.span - 1e-6) { hit = it; break; }
        }
        if (hit && hit.still) {
          drawFrame(ctx, w, h, hit.still);
          if (decodeModes.indexOf('static-image') < 0) decodeModes.push('static-image');
        } else if (hit && hit.iter) {
          const frame = await hit.iter.next();
          if (frame) drawFrame(ctx, w, h, frame);
          else drawFrame(ctx, w, h, null);
          if (decodeModes.indexOf(hit.iter.mode) < 0) decodeModes.push(hit.iter.mode);
        } else {
          drawFrame(ctx, w, h, null);           // 黑场 / 空档
        }
        for (const s of subImgs) {
          if (f.timestamp >= s.start && f.timestamp < s.end) ctx.drawImage(s.im, 0, 0, w, h);
        }
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
      diag: { width: w, height: h, fps, frames: plan.length, decodeModes, hasAudio: !!audioBuffer, codec: pk.video },
    };
  }

  /* 素材导出的一小段：单段视频（或一条纯音频）。audioOnly 时出 m4a（没有画面轨）。 */
  async function exportClip(o) {
    const opts = o || {};
    if (opts.audioOnly) {
      const MB = await loadMb();
      if (!MB) throw new Error('浏览器里没有 mediabunny，编不了音频');
      await ensureAac(MB);
      const buf = await mixAudio({ clips: opts.clips, duration: opts.duration });
      if (!buf) throw new Error('这一段没有声音可导');
      const target = new MB.BufferTarget();
      const output = new MB.Output({
        format: new MB.Mp4OutputFormat({ fastStart: 'in-memory', metadataFormat: 'mdta' }),
        target,
      });
      const src = new MB.AudioBufferSource({ codec: 'aac', bitrate: 192000 });
      output.addAudioTrack(src);
      await output.start();
      await src.add(buf);
      await output.finalize();
      return { blob: new Blob([target.buffer], { type: 'audio/mp4' }), ext: 'm4a', mime: 'audio/mp4' };
    }
    return await exportFilm(o);
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

  window.MediaExport = { framePlan, exportFilm, exportClip, pickCodec, mixAudio, timeStretchCh, ensureAudioTrack };
})();
