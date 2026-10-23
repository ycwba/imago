/* ASR 路由：设置 / 提交转写 / 查任务 / 取消。
   - 本地路线：页面把音轨解成 16k mono WAV 走 POST /asr/pcm → whisper-cli（代理只跑识别，不转码）；
   - 在线路线：OpenAI 兼容 POST /audio/transcriptions（multipart，verbose_json）；
   - 源只认本机资产 / /asset/<id> / /getv|/fetch 包着的公网地址，走与渲染同一条 resolveSrc；
   - 任务回调抓住自己那一单（mine），用户切走 / 取消都不改写别的任务。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { localAsrState } = require('../asr-store.js');
const { sendJson, readJsonBody } = require('./http');
const { channelKey, channelBase, loopback, collect } = require('../channel-cred.js');

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_PCM_BYTES = 320 * 1024 * 1024;   // 16k mono 16-bit ≈ 32KB/s → 约 2.8 小时
const MAX_ONLINE_RESPONSE = 8 * 1024 * 1024;
const MAX_SEGMENTS = 20000;
const RUN_MAX = 2;
const STDOUT_TAIL = 4000;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
function tail(s) { const t = String(s || ''); return t.length > STDOUT_TAIL ? t.slice(-STDOUT_TAIL) : t; }
function parseTs(s) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(String(s || ''));
  if (!m) return Number(s) || 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}
function segsOf(raw) {
  const tr = raw && (Array.isArray(raw.transcription) ? raw.transcription
    : Array.isArray(raw.segments) ? raw.segments : null);
  if (!tr) {
    const text = clean(raw && raw.text, 200000);
    return text ? [{ start: 0, end: 0, text }] : [];
  }
  const out = [];
  for (const x of tr.slice(0, MAX_SEGMENTS)) {
    let start = 0, end = 0, text = '';
    if (x && x.offsets) { start = (+x.offsets.from || 0) / 1000; end = (+x.offsets.to || 0) / 1000; }
    else if (x && x.timestamps) { start = parseTs(x.timestamps.from); end = parseTs(x.timestamps.to); }
    else { start = Number(x && x.start) || 0; end = Number(x && x.end) || start; }
    text = clean(x && x.text, 4000);
    if (text) out.push({ start, end: Math.max(start, end), text });
  }
  return out;
}
function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  const map = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
    '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.mkv': 'video/x-matroska' };
  return map[ext] || 'application/octet-stream';
}
function joinEndpoint(base, tailPath) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return '';
  if (/\/audio\/transcriptions$/i.test(b)) return b;
  return b + tailPath;
}
/* 页面在浏览器里把音轨解成 16k mono WAV 再传上来，代理只落盘与核对头。
   文件按流写、边写边算 hash（去重口径与在线路线同一处 findByHash）。 */
function readPcmTo(req, dest) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const out = fs.createWriteStream(dest);
    let got = 0, done = false;
    const fail = e => {
      if (done) return;
      done = true;
      try { out.destroy(); } catch (err) {}
      reject(e);
    };
    req.on('data', c => {
      if (done) return;
      got += c.length;
      if (got > MAX_PCM_BYTES) {
        const e = new Error('音频超过 320MB（16k 单声道约 2.8 小时），先切小再转写');
        e.status = 413;
        fail(e);
        try { req.destroy(); } catch (err) {}
        return;
      }
      h.update(c);
    });
    req.on('aborted', () => fail(new Error('上传中断')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (done) return;
      done = true;
      resolve({ bytes: got, hash: h.digest('hex').slice(0, 16) });
    });
    req.pipe(out);
  });
}
/* 只收浏览器抽出来的那一种：16k / 单声道 / 16-bit PCM。
   别的采样率 whisper-cli 也能吃，但认下来就等于允许任何字节流伪装成音频 —— 头三个字段是它唯一能对上的凭据。 */
function checkWav(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(44);
    if (fs.readSync(fd, b, 0, 44, 0) < 44
      || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE'
      || b.toString('ascii', 12, 16) !== 'fmt ') {
      throw new Error('传上来的不是 WAV（浏览器抽音轨那一步要 POST /asr/pcm）');
    }
    const fmt = b.readUInt16LE(20), ch = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
    if (fmt !== 1 || ch !== 1 || rate !== 16000 || bits !== 16) {
      throw new Error('只收 16k 单声道 16-bit PCM 的 WAV（收到 ' + rate + 'Hz / ' + ch + ' 声道 / ' + bits + '-bit）');
    }
  } finally { try { fs.closeSync(fd); } catch (e) {} }
}
function spawnTool(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, cwd: opts.cwd || undefined });
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (e) {}
      finish(new Error(opts.what + '超时（' + Math.round((opts.timeoutMs || 0) / 60000) + ' 分钟）'));
    }, opts.timeoutMs || 3600000);
    const finish = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (opts.onChild) opts.onChild(null);
      e ? reject(e) : resolve();
    };
    if (opts.onChild) opts.onChild(p);
    p.stderr.on('data', c => { err = tail(err + c.toString()); });
    p.stdout.on('data', () => {});
    p.on('error', e => finish(new Error(opts.what + '起不动：' + ((e && e.message) || e))));
    p.on('close', code => {
      if (code === 0) finish();
      else finish(new Error(opts.what + '退出码 ' + code + (err ? '：' + err : '')));
    });
  });
}

function createAsrRoutes(ctx) {
  const running = new Map();     // jobId → { child, req, canceled, dir }
  const pending = new Map();     // jobId → 提交时的 { assetId, src }（任务跑起来前只留在内存）
  function resolveService() {
    const s = ctx.store.rawSettings();
    const key = s.service.key || channelKey(ctx, s.service.providerId) || '';
    const base = s.service.baseUrl || channelBase(ctx, s.service.providerId) || '';
    return { key, base, model: s.service.model || 'whisper-1', providerId: s.service.providerId };
  }
  function routeNow(bodyRoute) {
    const s = ctx.store.rawSettings();
    const want = ['local', 'service'].includes(bodyRoute) ? bodyRoute : s.route;
    if (want !== 'auto') return want;
    return localAsrState(ctx.root).available ? 'local' : 'service';
  }

  async function prepareSource(body, dir) {
    const assetId = clean(body.assetId, 200);
    let src = String(body.src == null ? '' : body.src);
    if (!src && assetId) src = '/asset/' + assetId;
    if (!src) throw new Error('没有给素材：传 assetId 或 src');
    const la = /^la_[A-Za-z0-9_-]+$/.test(assetId) ? assetId
      : (/^\/asset\/(la_[A-Za-z0-9_-]+)/.exec(src) || [])[1];
    if (la) {
      const f = ctx.localAssetFile(la);
      if (!f) throw new Error('本机没有这个资产：' + la);
      return { file: f, media: path.basename(f), temporary: false };
    }
    if (!/^(?:https?:\/\/|\/asset\/|\/getv\?|\/fetch\?)/i.test(src)) {
      throw new Error('素材只接受本机资产、/asset/<id>、/getv 或 /fetch 包着的公网地址');
    }
    const url = await ctx.resolveSrc(src);
    const dest = path.join(dir, 'source' + (path.extname(new URL(url).pathname) || ''));
    await ctx.downloadTo(url, dest);
    return { file: dest, media: path.basename(dest), temporary: true };
  }
  async function hashFile(file) {
    return await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha1');
      const st = fs.createReadStream(file);
      st.on('data', c => h.update(c));
      st.on('error', reject);
      st.on('end', () => resolve(h.digest('hex').slice(0, 16)));
    });
  }

  async function runLocal(job, wav, dir, rt) {
    const st = localAsrState(ctx.root);
    if (!st.available) throw new Error('本地转写不可用：' + (st.why || '缺少运行包'));
    let size = 0;
    try { size = fs.statSync(wav).size; } catch (e) { throw new Error('没拿到要识别的音频'); }
    if (size < 1000) throw new Error('这一份里没有可识别的音轨（抽出来的音频是空的）');
    ctx.store.patchJob(job.id, { state: 'running', progress: 0.35, engine: 'whisper.cpp' });
    const out = path.join(dir, 'out');
    const args = ['-m', st.model, '-f', wav, '-oj', '-of', out, '-np'];
    const lang = ctx.store.rawSettings().language || job.language;
    if (lang) args.push('-l', lang);
    await spawnTool(st.bin, args, {
      what: '本地识别（whisper-cli）', timeoutMs: 2 * 60 * 60 * 1000, cwd: dir,
      onChild: p => { rt.child = p; },
    });
    let parsed = null;
    for (const cand of [out + '.json', path.join(dir, 'out.json')]) {
      try { parsed = JSON.parse(fs.readFileSync(cand, 'utf8')); break; } catch (e) {}
    }
    if (!parsed) throw new Error('whisper-cli 没有写出识别结果（out.json 不存在）');
    return { segments: segsOf(parsed), engine: 'whisper.cpp · ' + path.basename(st.model) };
  }

  async function runOnline(job, media, rt) {
    const svc = resolveService();
    if (!svc.key) throw new Error('在线转写没有可用密钥：在设置 → 语音识别里填，或先给供应商配一把密钥');
    if (!svc.base) throw new Error('在线转写没有接口地址：先选供应商，或手动填一个 OpenAI 兼容地址');
    const url = joinEndpoint(svc.base, '/audio/transcriptions');
    /* 在线转写的地址与 /search 用**同一份**出站判据：除了「必须是 https」，还要真的解析一次域名，
       拦住 `inner.example.com` 这种「看着是公网、AAAA/A 记录指回 127.0.0.1」的地址。
       这一条尤其要紧：asr.json 会被云同步写进本机（.data/asr.json），
       一份被改过的云端设置就等于让别人替我们选了一个出站目标 —— 而这一跳还带着密钥（Authorization）。
       明文 http 仍然只允许本机回环（自建 whisper-server 那条路）。 */
    if (/^https:/i.test(url)) {
      try { await ctx.guardOutboundUrl(url); }
      catch (e) { throw new Error('在线转写地址没进出站护栏：' + ((e && e.message) || e)); }
    } else if (!(/^http:/i.test(url) && loopback(url))) {
      throw new Error('在线转写只允许 https（本机回环地址可以用 http）');
    }
    const size = fs.statSync(media).size;
    if (size > MAX_BYTES) throw new Error('音频超过 200MB，先切小再转写');
    const boundary = '----wbasr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const lang = ctx.store.rawSettings().language || job.language;
    const fields = { model: svc.model, response_format: 'verbose_json' };
    if (lang) fields.language = lang;
    const head = Buffer.concat(Object.keys(fields).map(k => Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n')));
    const fileHead = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="'
      + path.basename(media).replace(/["\r\n]/g, '_') + '"\r\nContent-Type: ' + guessMime(media) + '\r\n\r\n');
    const tailBuf = Buffer.from('\r\n--' + boundary + '--\r\n');
    ctx.store.patchJob(job.id, { state: 'running', progress: 0.2, engine: 'openai-asr' });
    const text = await new Promise((resolve, reject) => {
      const headers = {
        'Authorization': 'Bearer ' + svc.key,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': head.length + fileHead.length + size + tailBuf.length,
      };
      /* 走出站层（本机回环的 http 也走同一份）：以前这里自己 http/https.request，
         既不带 DNS 闸，也就多了一套会忘记加护栏的出站实现。 */
      const req = ctx.anyRequest(url, { method: 'POST', headers }, res => {
        collect(res, MAX_ONLINE_RESPONSE).then(resolve, reject);
      });
      rt.req = req;
      req.setTimeout(15 * 60 * 1000, () => { try { req.destroy(new Error('在线转写超时（15 分钟）')); } catch (e) {} });
      req.on('error', reject);
      req.write(head); req.write(fileHead);
      const st = fs.createReadStream(media);
      st.on('error', reject);
      st.on('end', () => req.end(tailBuf));
      st.pipe(req, { end: false });
    });
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error('上游没有返回 JSON：' + clean(text, 300)); }
    if (parsed && parsed.error) {
      throw new Error('上游拒绝：' + clean(parsed.error.message || parsed.error, 400));
    }
    const segments = segsOf(parsed);
    if (!segments.length) throw new Error('上游返回里没有转写内容（可能是格式不支持 verbose_json）');
    return { segments, engine: 'online · ' + svc.model };
  }

  async function work(jobId) {
    const rt = running.get(jobId) || { canceled: false, child: null, req: null, dir: '' };
    running.set(jobId, rt);
    let dir = '';
    let source = null;
    try {
      const p = pending.get(jobId) || {};
      if (p.pcmFile) {
        /* 页面已经把音频抽好了：临时目录与文件都是提交那一刻建的，不再 prepareSource */
        dir = p.pcmDir;
        rt.dir = dir;
        ctx.store.patchJob(jobId, { state: 'running', progress: 0.1 });
        source = { file: p.pcmFile, media: p.media || 'audio.wav', temporary: true };
      } else {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asr-'));
        rt.dir = dir;
        ctx.store.patchJob(jobId, { state: 'running', progress: 0.02 });
        source = await prepareSource(p, dir);
      }
      const hash = p.pcmHash || await hashFile(source.file);
      const mine = ctx.store.job(jobId);
      if (!mine) return;
      const lang = ctx.store.rawSettings().language || mine.language || '';
      const route = mine.route;
      ctx.store.patchJob(jobId, { sourceHash: hash, media: source.media });
      const hit = ctx.store.findByHash(hash, route, lang);
      if (hit && hit.id !== jobId) {
        ctx.store.patchJob(jobId, {
          state: 'done', progress: 1, sourceHash: hash, segments: hit.segments, srt: hit.srt,
          engine: (hit.engine || '') + '（同一份媒体同一语言，复用旧结果）', media: source.media,
        });
        return;
      }
      const res = route === 'local' ? await runLocal(mine, source.file, dir, rt)
        : await runOnline(mine, source.file, rt);
      if (rt.canceled) return;
      ctx.store.patchJob(jobId, {
        state: 'done', progress: 1, sourceHash: hash,
        segments: res.segments.slice(0, MAX_SEGMENTS),
        srt: ctx.store.toSrt(res.segments),
        engine: res.engine, media: source.media, error: '',
      });
    } catch (e) {
      const mine = ctx.store.job(jobId);
      if (mine && (rt.canceled || mine.state === 'canceled')) {
        ctx.store.patchJob(jobId, { state: 'canceled', error: '已取消' });
      } else if (mine) {
        ctx.store.patchJob(jobId, { state: 'error', error: clean((e && e.message) || e, 800) });
      }
    } finally {
      running.delete(jobId);
      pending.delete(jobId);
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
    }
  }

  async function handleAsr(req, res) {
    const url = new URL(req.url, 'http://local');
    const part = url.pathname.replace(/^\/asr\/?/, '').split('/').filter(Boolean);
    const method = req.method;
    try {
      if (!part.length && method === 'GET') {
        sendJson(res, 200, {
          settings: ctx.store.settings(),
          local: localAsrState(ctx.root),
          revision: ctx.store.settings().revision,
        });
        return true;
      }
      if (part[0] === 'settings' && method === 'GET') {
        const s = ctx.store.settings();
        sendJson(res, 200, { settings: s, local: localAsrState(ctx.root), revision: s.revision });
        return true;
      }
      if (part[0] === 'settings' && method === 'PUT') {
        const body = await readJsonBody(ctx.readBody, req, res, 64 * 1024);
        const s = ctx.store.patchSettings(body && body.settings ? body.settings : body);
        sendJson(res, 200, { ok: true, settings: s, local: localAsrState(ctx.root), revision: s.revision });
        return true;
      }
      if (part[0] === 'pcm' && method === 'POST') {
        if (running.size >= RUN_MAX) {
          req.resume();
          sendJson(res, 429, { error: '已经有 ' + RUN_MAX + ' 单在转写，等一单跑完再提交' });
          return true;
        }
        const st = localAsrState(ctx.root);
        if (!st.available) {
          req.resume();
          sendJson(res, 400, { error: '本地转写不可用：' + (st.why || '缺少运行包') + '；可以改用在线服务' });
          return true;
        }
        const declared = Number(req.headers['content-length']) || 0;
        if (declared > MAX_PCM_BYTES) {
          req.resume();
          sendJson(res, 413, { error: '音频超过 320MB（16k 单声道约 2.8 小时），先切小再转写' });
          return true;
        }
        const language = clean(url.searchParams.get('language'), 32) || ctx.store.rawSettings().language || '';
        const media = clean(url.searchParams.get('name'), 140) || 'audio.wav';
        const id = 'asr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asr-'));
        const file = path.join(dir, 'audio.wav');
        let got = null;
        try {
          got = await readPcmTo(req, file);
          checkWav(file);
          if (got.bytes < 1000) throw new Error('这一份里没有可识别的音轨（上传的音频是空的）');
        } catch (e) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
          sendJson(res, e.status || 400, { error: clean((e && e.message) || e, 800) });
          return true;
        }
        const job = {
          id, state: 'queued', progress: 0, segments: [], srt: '', error: '',
          sourceHash: '', route: 'local', language, engine: '', media,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        ctx.store.putJob(job);
        pending.set(id, { pcmFile: file, pcmDir: dir, media, pcmHash: got.hash });
        setImmediate(() => { work(id).catch(e => ctx.log('[asr] 任务异常 ' + id + '：' + ((e && e.message) || e))); });
        sendJson(res, 200, { jobId: id, state: 'queued', route: 'local', language });
        return true;
      }
      if (part[0] === 'transcribe' && method === 'POST') {
        if (running.size >= RUN_MAX) {
          sendJson(res, 429, { error: '已经有 ' + RUN_MAX + ' 单在转写，等一单跑完再提交' });
          return true;
        }
        const body = await readJsonBody(ctx.readBody, req, res, 256 * 1024);
        const route = routeNow(body && body.route);
        if (route === 'local') {
          sendJson(res, 400, { error: '本地转写要由页面先在浏览器里抽出 16k WAV 再提交（POST /asr/pcm）：代理只认抽好的音频' });
          return true;
        }
        if (route === 'browser') {
          /* 这一路没有代理能跑的兑现方式：识别在页面 worker 里，结果由 POST /asr/browser-result 落账。
             不拦的话任务照建，work() 的三元判据（local 才本地，否则在线）会**默默扣一次在线转写的钱**，
             而账上还写着 browser。 */
          sendJson(res, 400, { error: '浏览器内识别由页面在自己的 worker 里跑，代理不做这一路：要代理转写请选本地或在线' });
          return true;
        }
        if (route === 'service') {
          const svc = resolveService();
          if (!svc.key) { sendJson(res, 400, { error: '在线转写没有可用密钥：先给供应商配密钥，或在语音识别里单填一把' }); return true; }
          if (!svc.base) { sendJson(res, 400, { error: '在线转写没有接口地址：先选供应商或手动填写' }); return true; }
        }
        /* 缺素材要当场拒绝：等任务建出来再在后台失败，用户会拿到一个任务号、
           然后每隔一秒看到它变成 error —— 那一步本来此刻就能说清。 */
        if (!clean(body && body.assetId, 200) && !String((body && body.src) || '').trim()) {
          sendJson(res, 400, { error: '没有给素材：传 assetId 或 src' });
          return true;
        }
        const language = clean(body && body.language, 32) || ctx.store.rawSettings().language || '';
        const id = 'asr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const job = {
          id, state: 'queued', progress: 0, segments: [], srt: '', error: '',
          sourceHash: '', route, language, engine: '', media: '',
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        ctx.store.putJob(job);
        pending.set(id, { assetId: body && body.assetId, src: body && body.src });
        setImmediate(() => { work(id).catch(e => ctx.log('[asr] 任务异常 ' + id + '：' + ((e && e.message) || e))); });
        sendJson(res, 200, { jobId: id, state: 'queued', route, language });
        return true;
      }
      if (part[0] === 'browser-result' && method === 'POST') {
        /* 浏览器内 Whisper 跑完的那一单：转写本身在页面 worker 里完成，
           代理只负责把结果落成一条与 whisper-cli / 在线同形的任务账（SRT 在这里按同一份 toSrt 出）。
           同一份音频哈希同一种语言已有一单 done 的 → 直接回旧单（与本地 / 在线的去重同口径）。 */
        if (running.size >= RUN_MAX) {
          sendJson(res, 429, { error: '已经有 ' + RUN_MAX + ' 单在转写，等一单跑完再提交' });
          return true;
        }
        const body = await readJsonBody(ctx.readBody, req, res, 8 * 1024 * 1024);
        const segments = ctx.store.normSegments(body && body.segments);
        if (!segments.length) {
          sendJson(res, 400, { error: '转写结果里没有内容（可能是纯静音或模型没出字）' });
          return true;
        }
        const language = clean(body && body.language, 32) || ctx.store.rawSettings().language || '';
        const hash = clean(body && body.sourceHash, 40);
        const hit = hash ? ctx.store.findByHash(hash, 'browser', language) : null;
        if (hit) {
          sendJson(res, 200, {
            id: hit.id, jobId: hit.id, state: hit.state, progress: 1, segments: hit.segments, srt: hit.srt,
            sourceHash: hit.sourceHash, route: hit.route, language: hit.language,
            engine: hit.engine + '（同一份音频同一语言，复用旧结果）', media: hit.media,
          });
          return true;
        }
        const suspicious = !!(body && body.suspicious);
        const base = clean(body && body.engine, 120) || '浏览器内 Whisper';
        const engine = suspicious ? (base + '（文本可疑，建议人工复核）') : base;
        const job = {
          id: 'asr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          state: 'done', progress: 1, segments, srt: ctx.store.toSrt(segments),
          error: '', sourceHash: hash, route: 'browser', language, engine,
          media: clean(body && body.media, 140) || 'audio.wav',
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        ctx.store.putJob(job);
        sendJson(res, 200, {
          id: job.id, jobId: job.id, state: 'done', progress: 1, segments: job.segments, srt: job.srt,
          sourceHash: job.sourceHash, route: 'browser', language: job.language,
          engine: job.engine, media: job.media,
        });
        return true;
      }
      if (part[0] === 'jobs' && part[1]) {
        const id = part[1];
        const job = ctx.store.job(id);
        if (!job) { sendJson(res, 404, { error: '没有这个转写任务' }); return true; }
        if (method === 'GET') {
          sendJson(res, 200, {
            id: job.id, state: job.state, progress: job.progress, segments: job.segments,
            srt: job.srt, error: job.error, sourceHash: job.sourceHash, route: job.route,
            language: job.language, engine: job.engine, media: job.media,
          });
          return true;
        }
        if (method === 'DELETE') {
          const rt = running.get(id);
          if (rt) {
            rt.canceled = true;
            try { if (rt.child) rt.child.kill('SIGKILL'); } catch (e) {}
            try { if (rt.req) rt.req.destroy(new Error('已取消')); } catch (e) {}
            ctx.store.patchJob(id, { state: 'canceled', error: '已取消' });
            sendJson(res, 200, { ok: true, canceled: true });
            return true;
          }
          ctx.store.removeJob(id);
          sendJson(res, 200, { ok: true, canceled: false });
          return true;
        }
      }
      sendJson(res, 404, { error: '不认识的 ASR 路由' });
      return true;
    } catch (e) {
      sendJson(res, e.status || 400, { error: clean((e && e.message) || e, 800) });
      return true;
    }
  }

  /* 代理退出时收掉还在跑的 whisper-cli：以前没人管，Ctrl+C 之后它会继续吃满一个核；
     任务照实标成「代理退出」，下次启动不会被当成还在跑。 */
  function stopAll() {
    for (const [id, rt] of running) {
      rt.canceled = true;
      try { if (rt.child) rt.child.kill('SIGKILL'); } catch (e) {}
      try { if (rt.req) rt.req.destroy(new Error('代理退出')); } catch (e) {}
      try { ctx.store.patchJob(id, { state: 'canceled', error: '代理退出时这一单还没跑完' }); } catch (e) {}
    }
  }

  return { handleAsr, running, pending, stopAll };
}

module.exports = { createAsrRoutes };
