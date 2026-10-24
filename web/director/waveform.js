/* 声音轨波形：流式解码 → 包络 → SVG（配音块） / canvas 条形（画面格的原声波纹带）。
   配音与视频原声共用同一份流式解包络核心（每秒 24 点峰值、串行队列一次只跑一个后台解码器、
   8ms 让出主线程、失败一律 null 不抛）；配音那条在核心解不动时退 AudioContext.decodeAudioData
   整段解（长音频吃内存，是兜底不是负担），再不行就不画（格子里留空）。
   只算一次并按地址缓存：拖把手会连着重画整条轨道，每画一次都解一遍会把中栏拖死。 */

export function createWaveform({ mediaSrc, voiceOf }) {
  const peakCache = new Map();       // 配音：流式 → 兜底 → null 的合并结果，按地址缓存
  let peakCtx = null;                // decodeAudioData 兜底只开一个 AudioContext（浏览器同时能开的就那么几个）

  /* ---------- 流式解包络核心（配音与视频原声两处共用，别各改各的） ---------- */
  const waveCache = new Map();       // src → Promise<Float32Array|null>（流式那一档的结果）
  let waveQueue = Promise.resolve(); // 串行：一次只跑一个后台解码器
  function audioPeaks(src) {
    const key = String(src || '');
    if (!key) return Promise.resolve(null);
    if (waveCache.has(key)) return waveCache.get(key);
    const job = waveQueue.catch(() => {}).then(async () => {
      try {
        const MB = await import('/web/vendor/mediabunny.min.mjs');
        if (!MB || !MB.Input) return null;
        const r = await fetch(mediaSrc(key));
        if (!r.ok) return null;
        const input = new MB.Input({ source: new MB.BlobSource(await r.blob()), formats: MB.ALL_FORMATS });
        try {
          const track = await input.getPrimaryAudioTrack();
          if (!track || !await track.canDecode()) return null;
          const duration = await input.computeDuration();
          /* 峰值点数按秒密度：每秒 24 点，下限 256 / 上限 8192（配音几十秒的句与几十分钟的视频都落在这条尺上）。 */
          const n = Math.min(8192, Math.max(256, Math.ceil(duration * 24)));
          const peaks = new Float32Array(n);
          const sink = new MB.AudioBufferSink(track);
          let lastYield = performance.now();
          for await (const { buffer, timestamp } of sink.buffers()) {
            const sr = buffer.sampleRate || 48000;
            for (let c = 0; c < buffer.numberOfChannels; c++) {
              const ch = buffer.getChannelData(c);
              for (let i = 0; i < ch.length; i += 4) {
                const v = Math.abs(ch[i]);
                const pi = Math.min(n - 1, Math.floor((timestamp + i / sr) * 24));
                if (v > peaks[pi]) peaks[pi] = v;
              }
            }
            const now = performance.now();
            if (now - lastYield >= 8) { lastYield = now; await new Promise(r2 => setTimeout(r2, 0)); }
          }
          let top = 0;
          for (let i = 0; i < n; i++) if (peaks[i] > top) top = peaks[i];
          if (top > 0) for (let i = 0; i < n; i++) peaks[i] = Math.pow(peaks[i] / top, 0.72);
          return peaks;
        } finally { try { input.dispose(); } catch (e) { /* 释放失败不影响结果 */ } }
      } catch (e) { return null; }
    });
    waveCache.set(key, job);
    waveQueue = job;
    return job;
  }

  /* 兜底档：AudioContext.decodeAudioData 整段进内存 → 按整条等分 120 点（今天之前的那一套）。 */
  async function legacyPeaks(src) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const buf = await (await fetch(mediaSrc(src))).arrayBuffer();
      /* decodeAudioData 不要求 context 处于 running，这里不 resume。 */
      if (!peakCtx) peakCtx = new AC();
      const dec = await peakCtx.decodeAudioData(buf);
      const ch = dec.getChannelData(0);
      const N = 120, block = Math.max(1, Math.floor(ch.length / N)), out = new Array(N);
      let top = 0.001;
      for (let i = 0; i < N; i++) {
        let peak = 0, sum = 0, n = 0;
        const s0 = i * block;
        for (let j = s0; j < s0 + block && j < ch.length; j++) {
          const a = Math.abs(ch[j]);
          if (a > peak) peak = a;
          sum += a * a; n++;
        }
        out[i] = (n ? Math.sqrt(sum / n) : 0) * 0.78 + peak * 0.22;
        if (out[i] > top) top = out[i];
      }
      return out.map(x => Math.max(0.05, Math.min(1, Math.pow(x / top, 0.72))));
    } catch (e) { return null; }
  }

  function voicePeaks(src) {
    const key = String(src || '');
    if (!key) return Promise.resolve(null);
    if (peakCache.has(key)) return peakCache.get(key);
    const job = audioPeaks(key).then(p => p || legacyPeaks(key));
    peakCache.set(key, job);
    return job;
  }

  /* 包络 → 一块 SVG（上下对称的闭合多边形）。
     viewBox 固定 100×20 + preserveAspectRatio="none"：块多宽多高都靠 CSS 撑，
     不用按像素重算点 —— 轨道宽度一变（换页签、改窗口）也不会错位。 */
  function waveformSVG(peaks) {
    const N = peaks.length;
    if (N < 2) return '';
    const top = [], bot = [];
    for (let i = 0; i < N; i++) {
      const x = ((i / (N - 1)) * 100).toFixed(2);
      top.push(x + ',' + (10 - peaks[i] * 9.2).toFixed(2));
      bot.push(x + ',' + (10 + peaks[i] * 9.2).toFixed(2));
    }
    return '<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><polygon points="'
      + top.concat(bot.reverse()).join(' ') + '"/></svg>';
  }

  /* 画完轨道再后台填波形：先出块、后出波形，绝不为了几张小图把整条轨道卡住。 */
  async function fillWaveforms(root) {
    if (!root || !root.querySelectorAll) return;
    const els = Array.prototype.slice.call(root.querySelectorAll('.tl-v[data-vid]'));
    await Promise.all(els.map(async el => {
      const v = voiceOf(el.getAttribute('data-vid'));
      if (!v || !v.src) return;
      const peaks = await voicePeaks(v.src);
      if (!peaks || !el.isConnected) return;         // 期间又重画过一次：别往孤立的块里塞
      const box = el.querySelector('.wv-box');
      if (box) box.innerHTML = waveformSVG(peaks);
    }));
  }

  /* ================= 视频原声波纹（画面格下带，B 的三段式下段） =================
     数据源就是上面那份流式核心（配音与视频原声一条解码管线，串行队列共享）；
     失败 null → fillSegWaveforms 在格子里写「波形不可用」，绝不卡住轨道。 */
  return { voicePeaks, waveformSVG, fillWaveforms };
}
