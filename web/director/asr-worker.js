/* 浏览器内 ASR 的 module worker：transformers.js（Whisper q8）全在这里跑，主线程取消 = 整只 terminate()，
   绝不回落主线程再转一遍。模型文件经 env.localModelPath 走代理的 /models/ 代下载（本机没有时
   代理自己去镜像拉），allowRemoteModels 关死 —— 页面不直连任何外部域名（§4.1），
   ORT 的 wasm 路径也覆写到同源 vendor 目录（默认指 CDN，CSP connect-src 'self' 下必死）。
   协议：进 { type:'run', wav:Blob, language } → 出 { type:'progress' | 'result' | 'error' }
   （progress 两种：transformers.js 的取数进度带 file，worker 自己报 decode / transcribe 阶段）。
   WAV 拆 PCM 与词级成段（断句/时长/字数三把尺）在 asr-text.js —— 要换分段规则只动那一面。 */
import { pipeline, env } from '/web/vendor/asr/transformers.min.js';
import { wavToPcm, groupWords, normalizeAsrWhitespace, applyChineseReplacements,
  isSuspiciousChineseTranscript } from '/web/director/asr-text.js';

const MODEL_ID = 'onnx-community/whisper-small_timestamped';
const WASM_DIR = '/web/vendor/asr/';

env.useBrowserCache = false;                 // 缓存只在代理 .data/models/ 一份，浏览器不落第二份
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.allowRemoteModels = false;
env.backends.onnx.wasm.wasmPaths = WASM_DIR; // 默认指 CDN，同源覆写（ORT 胶水与 .wasm 都在这一目录）

let asr = null;
let asrLang = null;

async function ensurePipeline(language) {
  if (asr && asrLang === (language || '')) return asr;
  const device = (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
  const build = dev => pipeline('automatic-speech-recognition', MODEL_ID, {
    dtype: 'q8',
    device: dev,
    progress_callback: p => { try { self.postMessage({ type: 'progress', data: p }); } catch (e) { /* 主线程先走就算了 */ } },
  });
  try { asr = await build(device); }
  catch (e) { asr = await build('wasm'); }          // WebGPU 起不来退 WASM，同一只 worker 里换
  asrLang = language || '';
  return asr;
}

self.onmessage = async e => {
  const m = e.data || {};
  if (m.type !== 'run') return;
  try {
    self.postMessage({ type: 'progress', data: { status: 'worker', stage: 'decode' } });
    const audio = wavToPcm(await m.wav.arrayBuffer());
    const pipe = await ensurePipeline(m.language);
    self.postMessage({ type: 'progress', data: { status: 'worker', stage: 'transcribe' } });
    const opts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      max_new_tokens: 224,
      return_timestamps: 'word',
      no_repeat_ngram_size: 3,
      repetition_penalty: 1.15,
    };
    const lang = String(m.language || '').trim();
    if (lang) { opts.language = lang; opts.task = 'transcribe'; }
    const out = await pipe(audio, opts);
    const segments = groupWords(out && out.chunks).map(s => ({
      ...s,
      text: applyChineseReplacements(normalizeAsrWhitespace(s.text)),
    })).filter(s => s.text);
    const text = segments.map(s => s.text).join('');
    self.postMessage({
      type: 'result', segments, text,
      suspicious: lang === 'zh' || /^zh/i.test(lang) ? isSuspiciousChineseTranscript(text) : false,
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
