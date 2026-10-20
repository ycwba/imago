/* 声音轨波形：AudioContext 解码 → 包络 → SVG。
   只算一次并按地址缓存：拖把手会连着重画整条轨道，每画一次都解一遍会把中栏拖死。 */

export function createWaveform({ mediaSrc, voiceOf }) {
  const peakCache = new Map();
  let peakCtx = null;

  function voicePeaks(src) {
    const key = String(src || '');
    if (!key) return Promise.resolve(null);
    if (peakCache.has(key)) return peakCache.get(key);
    const job = (async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const buf = await (await fetch(mediaSrc(key))).arrayBuffer();
      /* 解码只需要一个 AudioContext（浏览器同时能开的就那么几个），但它必须**不**被 suspend 卡住 ——
         首次创建时若处于 suspended，decodeAudioData 照样能解，所以这里不 resume。 */
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
    })().catch(() => null);
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

  return { voicePeaks, waveformSVG, fillWaveforms };
}
