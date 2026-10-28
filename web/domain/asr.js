/* Asr — 语音识别（设置 / 提交 / 轮询 / 取消）。只走 Net，不裸 fetch。
   三条路线：browser（浏览器内 Whisper，worker 里跑，模型经 /models/ 代下载）→
   local（whisper-cli，页面先抽 16k WAV）→ service（OpenAI 兼容在线）。
   shell 不常驻加载；设置页与导演台首次使用时 __spaLoadScript('web/domain/asr.js', () => window.Asr)。 */
(function () {
  let cached = null;
  let localState = null;

  const BROWSER_MODEL = 'onnx-community/whisper-small_timestamped';
  /* 「模型齐没齐」按这份清单对：缺任何一件都算没就绪（其余文件会在用到时按需补拉）。 */
  const BROWSER_FILES = [
    'config.json', 'preprocessor_config.json', 'tokenizer.json',
    'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
  ];

  const errOf = (e, fallback) => window.Api.errOf(e, fallback || '语音识别请求失败');
  async function settings() {
    try {
      const d = await window.Net.json('/asr/settings', { retry: 0 });
      cached = d.settings || null;
      localState = d.local || null;
      return { settings: cached, local: localState, revision: d.revision };
    } catch (e) { throw errOf(e, '读不到语音识别设置'); }
  }
  async function save(patch) {
    try {
      const d = await window.Net.json('/asr/settings', {
        method: 'PUT', retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      });
      cached = d.settings || null;
      localState = d.local || null;
      return { settings: cached, local: localState, revision: d.revision };
    } catch (e) { throw errOf(e, '保存语音识别设置失败'); }
  }
  /* 这一档走哪条路：显式给了 browser / local / service 就照办；auto 先看浏览器模型在不在
     （模型已就绪才自动走浏览器 —— 首次的几百 MB 下载必须用户显式选了 browser 才会发生），
     再看本地运行包，最后在线。 */
  async function pickRoute(want) {
    const s = cached || {};
    const w = ['browser', 'local', 'service'].includes(want) ? want : s.route;
    if (w && w !== 'auto') return w;
    try {
      const st = await browserStatus();
      if (st && st.complete) return 'browser';
    } catch (e) { /* 模型状态问不到就当没有这一档 */ }
    return (localState && localState.available) ? 'local' : 'service';
  }
  /* 「这一条路线是什么、扣不扣费」的说法只在这一处：设置页、导演台、助手回执都翻译它。 */
  function routeLabel(route) {
    if (route === 'browser') return '浏览器内 Whisper（在本页 worker 里跑，不产生平台费用）';
    if (route === 'local') return '本地 whisper（在本机跑，不产生平台费用）';
    if (route === 'service') return '在线服务（按次计费）';
    return '自动（按模型与运行包就绪情况挑一条）';
  }
  /* 浏览器内模型的状态：/models/status 回本机已落盘的文件，按 BROWSER_FILES 对「齐没齐」。 */
  async function browserStatus() {
    const d = await window.Net.json('/models/status?id=' + encodeURIComponent(BROWSER_MODEL), { retry: 0 });
    const have = new Set(((d && d.files) || []).map(f => f.file));
    const missing = BROWSER_FILES.filter(f => !have.has(f));
    return {
      id: (d && d.id) || BROWSER_MODEL,
      files: (d && d.files) || [], bytes: (d && d.bytes) || 0,
      present: !!(d && d.present), missing, complete: !missing.length,
      modelId: BROWSER_MODEL,
    };
  }
  /* ---------- 浏览器内 Whisper（worker）----------
     取消语义：调用方传 `signal`（AbortSignal）—— 命中就 terminate() 整只 worker 并拒绝在途的这一次，
     绝不回落主线程再转一遍。进度三段：extract（抽音轨）→ model（首次下载模型，几百 MB）→
     transcribe（真识别）；文案只有下面的 stageText 一份。 */
  function stageText(s) {
    const st = String((s && s.stage) || '');
    const p = Math.max(0, Math.min(100, Math.round(((s && s.progress) || 0) * 100)));
    if (st === 'extract') return '正在浏览器里抽音轨…' + (p ? ' ' + p + '%' : '');
    if (st === 'upload') return '正在把抽好的音频交给代理…';
    if (st === 'model') {
      const f = String((s && s.file) || '');
      return '正在经代理下载识别模型' + (f ? '（' + f + '）' : '') + ' ' + p + '% —— 首次要下几百 MB，之后读本机';
    }
    if (st === 'decode') return '正在解码音频…';
    if (st === 'transcribe') return '正在浏览器里识别语音…';
    return '识别处理中…';
  }
  function sha1OfBlob(blob) {
    /* 音频哈希只给「同一份媒体同一种语言复用旧结果」的去重用；太长的音频不整块进内存，宁可不哈希。 */
    if (!blob || blob.size > 64 * 1024 * 1024 || !window.crypto || !crypto.subtle) return Promise.resolve('');
    return blob.arrayBuffer().then(ab => crypto.subtle.digest('SHA-1', ab))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16))
      .catch(() => '');
  }
  async function transcribeBrowser(a) {
    const stage = typeof a.onStage === 'function' ? a.onStage : null;
    const src = String(a.src || '') || (a.assetId ? window.Api.assetSrc(String(a.assetId)) : '');
    if (!src) throw new Error('没有给素材：传 assetId 或 src');
    if (typeof Worker === 'undefined') throw new Error('这个浏览器不支持 Web Worker，跑不了浏览器内识别（可以改用本地或在线）');
    if (!window.MediaBackend) await window.__spaLoadScript('/web/media-backend.js', () => !!window.MediaBackend);
    if (!window.MediaBackend) throw new Error('浏览器里的媒体后端没加载起来，抽不出音轨（可以改用本地或在线识别）');
    if (stage) stage({ stage: 'extract', progress: 0 });
    const wav = await window.MediaBackend.wav16(src, {
      onProgress: p => { if (stage) stage({ stage: 'extract', progress: p }); },
    });
    if (a.signal && a.signal.aborted) throw new Error('已取消');
    const language = String(a.language || (cached && cached.language) || '');
    const hash = await sha1OfBlob(wav.blob);
    const worker = new Worker('/web/director/asr-worker.js', { type: 'module' });
    try {
      const run = new Promise((resolve, reject) => {
        worker.onmessage = ev => {
          const m = ev.data || {};
          if (m.type === 'progress') {
            const d = m.data || {};
            if (d.status === 'progress' && d.file) {
              const p = d.progress != null ? Math.max(0, Math.min(1, d.progress / 100))
                : (d.total ? (d.loaded || 0) / d.total : 0);
              if (stage) stage({ stage: 'model', progress: p, file: String(d.file || '') });
            } else if (d.status === 'worker' && stage) {
              stage({ stage: d.stage === 'decode' ? 'decode' : 'transcribe', progress: 0 });
            }
            return;
          }
          if (m.type === 'result') return resolve(m);
          if (m.type === 'error') return reject(new Error(m.message || '浏览器内识别失败'));
        };
        worker.onerror = e => reject(new Error(window.errText(e, '浏览器内识别的 worker 起不动')));
        if (a.signal) {
          const die = () => { try { worker.terminate(); } catch (err) { /* 已经死了 */ } reject(new Error('已取消')); };
          if (a.signal.aborted) { die(); return; }
          a.signal.addEventListener('abort', die, { once: true });
        }
      });
      worker.postMessage({ type: 'run', wav: wav.blob, language });
      const out = await run;
      const r = await window.Net.json('/asr/browser-result', {
        method: 'POST', retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: out.segments || [], language, sourceHash: hash, suspicious: !!out.suspicious,
          engine: '浏览器内 Whisper', media: String(a.name || 'audio.wav'),
        }),
      });
      return r;
    } finally {
      try { worker.terminate(); } catch (e) { /* 收尾时已经不在了 */ }
    }
  }
  /* 提交一单转写。本地路线在**浏览器里**把音轨抽成 16k WAV 再交给代理（代理不做转码）；
     在线路线照旧只递素材地址，由代理取回并转发。arg.onStage({stage,progress}) 可选：
     抽音轨 / 下模型可能要几秒到几分钟，界面可以跟着报（stage 是 extract / model / transcribe）。 */
  async function transcribe(arg) {
    const a = arg || {};
    try {
      if (!cached) await settings();
      const route = await pickRoute(a.route);
      if (route === 'browser') return await transcribeBrowser(a);
      if (route !== 'local') {
        return await window.Net.json('/asr/transcribe', {
          method: 'POST', retry: 0,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src: a.src, assetId: a.assetId, language: a.language, route: 'service' }),
        });
      }
      const src = String(a.src || '') || (a.assetId ? window.Api.assetSrc(String(a.assetId)) : '');
      if (!src) throw new Error('没有给素材：传 assetId 或 src');
      if (!window.MediaBackend) {
        await window.__spaLoadScript('/web/media-backend.js', () => !!window.MediaBackend);
      }
      if (!window.MediaBackend) throw new Error('浏览器里的媒体后端没加载起来，抽不出音轨（可以改用在线识别）');
      const stage = typeof a.onStage === 'function' ? a.onStage : null;
      if (stage) stage({ stage: 'extract', progress: 0 });
      const wav = await window.MediaBackend.wav16(src, {
        onProgress: p => { if (stage) stage({ stage: 'extract', progress: p }); },
      });
      if (stage) stage({ stage: 'upload', progress: 1 });
      const q = new URLSearchParams();
      if (a.language) q.set('language', String(a.language));
      if (a.name) q.set('name', String(a.name));
      const r = await window.Net.fetch('/asr/pcm' + (q.toString() ? '?' + q.toString() : ''), {
        method: 'POST', timeout: 0, retry: 0,
        headers: { 'Content-Type': 'audio/wav' }, body: wav.blob,
      });
      const x = await window.Net.readRes(r);
      if (!x.ok) throw new Error((x.d && x.d.error) || ('HTTP ' + x.status));
      return x.d;
    } catch (e) { throw errOf(e, '提交转写失败'); }
  }
  async function job(id) {
    try { return await window.Net.json('/asr/jobs/' + encodeURIComponent(id), { retry: 0 }); }
    catch (e) { throw errOf(e, '读不到转写任务'); }
  }
  async function cancel(id) {
    try {
      return await window.Net.json('/asr/jobs/' + encodeURIComponent(id), { method: 'DELETE', retry: 0 });
    } catch (e) { throw errOf(e, '取消转写失败'); }
  }
  /* 轮询到 done / error / canceled / interrupted 为止；onTick 拿到每一次的任务对象。
     opts.signal 用来在页面切走 / 用户放弃时停掉轮询（任务本身仍由 cancel 负责杀进程）。 */
  async function wait(id, onTick, opts) {
    const o = opts || {};
    const every = Math.max(600, Math.min(5000, Number(o.every) || 1200));
    const deadline = Date.now() + (Number(o.timeoutMs) || 2 * 60 * 60 * 1000);
    for (;;) {
      if (o.signal && o.signal.aborted) throw new Error('已停止等待');
      const j = await job(id);
      if (typeof onTick === 'function') { try { onTick(j); } catch (e) {} }
      if (['done', 'error', 'canceled', 'interrupted'].includes(j.state)) return j;
      if (Date.now() > deadline) throw new Error('等了太久还没转写完（任务可能还在跑，可以稍后回来查看）');
      await new Promise(r => setTimeout(r, every));
    }
  }
  window.Asr = {
    settings, save, transcribe, job, cancel, wait, browserStatus, pickRoute, stageText, routeLabel,
    /* 同步读上一次 settings() 的缓存：本地运行包可不可用不该让界面再等一次网络 */
    cache: () => cached,
    local: () => localState,
    available: () => !!(localState && localState.available),
  };
})();
