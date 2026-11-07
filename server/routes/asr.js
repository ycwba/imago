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
const { localAsrState } = require('../data-hub.js');
const { sendJson, readJsonBody } = require('./http');
const { providerOf, channelKey, channelBase, loopback, collect, postJson } = require('../channel-cred.js');

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_CHAT_AUDIO = 24 * 1024 * 1024;   // chat-audio 要把字节转成 base64 塞进请求体
const MAX_PCM_BYTES = 320 * 1024 * 1024;   // 16k mono 16-bit ≈ 32KB/s → 约 2.8 小时
const MAX_ONLINE_RESPONSE = 8 * 1024 * 1024;
const MAX_SEGMENTS = 20000;
const RUN_MAX = 2;
const STDOUT_TAIL = 4000;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
/* 回给页面的本机运行包状态：`modelPath` 是本机绝对路径，只给服务端起进程用，不往外回。
   （`bin` 一直是绝对路径，页面只拿来显示，沿用旧形状不动。） */
function localView(st) {
  return { available: !!st.available, bin: st.bin, model: st.model, bytes: st.bytes, why: st.why };
}
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
  const p = String(tailPath || '');
  if (/^https?:\/\//i.test(p)) return p;
  return b + (p.charAt(0) === '/' ? p : '/' + p);
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
        /* 不在这里 destroy：那会让下面的 413 没有 socket 可写，客户端只看到连接被掐断。
           先停住上传、把错误交回 handler，响应写完之后再由它收连接（见 /asr/pcm 的 catch）。 */
        try { req.pause(); } catch (err) {}
        fail(e);
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
  /* 在线转写走哪一家、用哪个型号、请求长什么样，全部来自注册表这一家的 `asr` 声明：
     `openai` 是 multipart /audio/transcriptions 那一族；`chat-audio` 是把音频塞进
     chat/completions 的 input_audio（百炼 qwen3-asr-flash）。
     没选供应商时自动挑第一家「声明了 asr 且拿得到密钥」的 —— 设置页打开就能用，
     不用先在一个空白下拉里猜该选谁。 */
  function asrProviders() {
    try {
      return (ctx.providers() || []).filter(p => p.kind === 'text' && p.asr
        && (p.extraCaps || []).indexOf('asr') >= 0);
    } catch { return []; }
  }
  function resolveService() {
    const s = ctx.store.rawSettings();
    let p = s.service.providerId ? providerOf(ctx, s.service.providerId) : null;
    if (!p && !s.service.providerId && !s.service.baseUrl) {
      p = asrProviders().find(x => channelKey(ctx, x.id)) || null;
    }
    /* 没有声明的那一家（手动填地址 / 手动声明识别）按最常见的 OpenAI 兼容形状走：
       旧行为也是 verbose_json（带分段），换掉只会让手填的服务少掉时间戳。 */
    const decl = (p && p.asr) || { style: 'openai', path: '/audio/transcriptions', responseFormat: 'verbose_json', language: 'form' };
    const key = s.service.key || (p ? channelKey(ctx, p.id) : '') || '';
    const base = s.service.baseUrl || (p ? (channelBase(ctx, p.id) || p.base || '') : '') || '';
    const model = s.service.model || decl.model || 'whisper-1';
    const hitModel = (decl.models || []).find(m => m && m.id === model) || {};
    const responseFormat = hitModel.responseFormat != null ? hitModel.responseFormat : (decl.responseFormat || '');
    return {
      key, base, model, providerId: p ? p.id : s.service.providerId,
      style: decl.style || 'openai', path: decl.path || '/audio/transcriptions',
      responseFormat, language: decl.language || 'form',
    };
  }
  function routeNow(bodyRoute) {
    const s = ctx.store.rawSettings();
    /* browser 也算「显式给了」：/asr/transcribe 收到 browser 当场 400。
       把它和 local/service 分开对待的话，客户端显式声明「这一路在我自己的 worker 里跑」
       却被本机设置（service）顶掉 —— 页面以为没花钱，账上却记了一笔在线转写。 */
    const want = ['browser', 'local', 'service'].includes(bodyRoute) ? bodyRoute : s.route;
    if (want !== 'auto') return want;
    /* 这个 JSON 入口接不了本地路线（本地必须先由页面抽 16k WAV 走 /asr/pcm）：
       auto 在这里直接落 service。先判成 local 再回 400，对直接调 API 的人等于「看起来没配置」。 */
    return 'service';
  }

  /* 名额必须**同步**占住：work() 排在 setImmediate 里，只在那里面 running.set 的话，
     同一 tick 进来的两单都过得了上面那道 `running.size >= RUN_MAX`（那会儿表还是空的），
     上限就成了摆设 —— 同时开 N 个 whisper-cli，或同时开 N 单在线转写（后者是直接扣钱）。
     这一条把「判满」与「占位」收进同一个同步块；work() 认的就是这一份 rt，不留第二张表。 */
  function claim(id, meta) {
    if (running.size >= RUN_MAX) return false;
    running.set(id, { canceled: false, child: null, req: null, dir: '' });
    pending.set(id, meta);
    return true;
  }
  /* 名额占了、任务还没交给 work() 就失败（落账写盘失败 / 临时目录收拾不完）：
     两个表一起还回去。只回一句 500 而不还名额的话，running 上留一条永远跑不完的记录，
     几单之后 RUN_MAX 就再也进不来 —— 这一次提交失败会变成整台机器再也不能转写。 */
  function dropSlot(id) {
    running.delete(id);
    pending.delete(id);
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
    const args = ['-m', st.modelPath, '-f', wav, '-oj', '-of', out, '-np'];
    /* 这一单显式带的语言优先于设置里的默认值：设置那一格是「没给时用什么」，
       不是「一律盖掉调用方」。job.language 提交时已经按「请求值 || 设置值」落过账。 */
    const lang = job.language || ctx.store.rawSettings().language || '';
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

  /* 出站地址的判据与 /search 相同：除了「必须是 https」，还要真的解析一次域名
     （拦住 `inner.example.com` 这种看着是公网、A/AAAA 指回 127.0.0.1 的地址）。
     asr.json 会被云同步写进本机，一份被改过的云端设置就等于让别人替我们选了一个出站目标 ——
     而这一跳还带着密钥（Authorization）。明文 http 只允许本机回环（自建 whisper-server 那条路）。 */
  async function checkedUrl(url) {
    if (/^https:/i.test(url)) {
      try { await ctx.guardOutboundUrl(url); }
      catch (e) { throw new Error('在线转写地址没进出站护栏：' + ((e && e.message) || e)); }
    } else if (!(/^http:/i.test(url) && loopback(url))) {
      throw new Error('在线转写只允许 https（本机回环地址可以用 http）');
    }
    return url;
  }
  /* 这一单要用的语言：job.language 在提交时已经落成「请求值 || 当时的设置值」，
     这里再读设置只作兜底 —— 反过来（设置优先）会让调用方显式传的 language 永远不生效。 */
  function langOf(job) {
    return job.language || ctx.store.rawSettings().language || '';
  }

  /* 那一族 multipart /audio/transcriptions：模型 / 返回格式 / 语言放哪儿全按声明，
     不照 OpenAI 的样子硬塞（智谱没有 response_format、MiniMax 的语言在请求头）。 */
  async function runOnlineMultipart(svc, media, rt, job) {
    const url = await checkedUrl(joinEndpoint(svc.base, svc.path));
    const size = fs.statSync(media).size;
    if (size > MAX_BYTES) throw new Error('音频超过 200MB，先切小再转写');
    const boundary = '----wbasr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const lang = langOf(job);
    const fields = { model: svc.model };
    if (svc.responseFormat) fields.response_format = svc.responseFormat;
    if (lang && svc.language === 'form') fields.language = lang;
    const head = Buffer.concat(Object.keys(fields).map(k => Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n')));
    const fileHead = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="'
      + path.basename(media).replace(/["\r\n]/g, '_') + '"\r\nContent-Type: ' + guessMime(media) + '\r\n\r\n');
    const tailBuf = Buffer.from('\r\n--' + boundary + '--\r\n');
    ctx.store.patchJob(job.id, { state: 'running', progress: 0.2, engine: 'online · ' + svc.model });
    const headers = {
      'Authorization': 'Bearer ' + svc.key,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': head.length + fileHead.length + size + tailBuf.length,
    };
    if (lang && svc.language === 'header') headers.language = lang;
    /* 走出站层（本机回环的 http 也走同一份）：以前这里自己 http/https.request，
       既不带 DNS 闸，也就多了一套会忘记加护栏的出站实现。 */
    const text = await new Promise((resolve, reject) => {
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
    return parseOnlineText(text, svc);
  }

  /* chat-audio 那一族（百炼 qwen3-asr-flash）：音频以 data:base64 塞进 input_audio，
     回的是 assistant 正文、没有分段。代理与上游之间没有外链可递，只能把字节带上；
     上限单列：一次请求里塞几十 MB base64 会先把内存吃掉。 */
  async function runOnlineChatAudio(svc, media, rt, job) {
    const url = await checkedUrl(joinEndpoint(svc.base, svc.path));
    const size = fs.statSync(media).size;
    if (size > MAX_CHAT_AUDIO) {
      throw new Error('这一家走 chat/completions 收音频，单次最多 ' + Math.round(MAX_CHAT_AUDIO / 1048576)
        + 'MB（这条 ' + Math.round(size / 1048576) + 'MB）：先切小，或改用 /audio/transcriptions 那一族');
    }
    const dataUri = 'data:' + guessMime(media) + ';base64,' + fs.readFileSync(media).toString('base64');
    const lang = langOf(job);
    const body = {
      model: svc.model, stream: false,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
    };
    if (lang && svc.language === 'body') body.asr_options = { language: lang };
    ctx.store.patchJob(job.id, { state: 'running', progress: 0.2, engine: 'online · ' + svc.model });
    const buf = Buffer.from(JSON.stringify(body));
    const r = await postJson(ctx, {
      url, body: buf, timeoutMs: 15 * 60 * 1000, maxBytes: MAX_ONLINE_RESPONSE,
      headers: {
        'Authorization': 'Bearer ' + svc.key,
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'Accept': 'application/json',
      },
      onReq: req => { rt.req = req; },
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error('上游拒绝（HTTP ' + r.status + '）：' + clean(r.text, 400));
    }
    return parseOnlineText(r.text, svc);
  }
  function parseOnlineText(text, svc) {
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error('上游没有返回 JSON：' + clean(text, 300)); }
    if (parsed && parsed.error) {
      throw new Error('上游拒绝：' + clean(parsed.error.message || parsed.error, 400));
    }
    /* chat 那一族：正文可能是字符串，也可能是 [{type:'text', text}] 的分段数组。 */
    const msg = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
    if (msg && msg.content != null) {
      const contentText = c => (typeof c === 'string' ? c
        : Array.isArray(c) ? c.map(x => (x && (x.text || x.content)) || '').join('') : '');
      const out = contentText(msg.content);
      const segments = clean(out, 200000) ? [{ start: 0, end: 0, text: clean(out, 200000) }] : [];
      if (segments.length) return { segments, engine: 'online · ' + svc.model };
    }
    const segments = segsOf(parsed);
    if (!segments.length) throw new Error('上游返回里没有转写内容（可能是这个型号不支持所选返回格式）');
    return { segments, engine: 'online · ' + svc.model };
  }

  async function runOnline(job, media, rt) {
    const svc = resolveService();
    if (!svc.key) throw new Error('在线转写没有可用密钥：在设置 → 语音识别里填，或先给供应商配一把密钥');
    if (!svc.base) throw new Error('在线转写没有接口地址：先选供应商，或手动填一个接口地址');
    return svc.style === 'chat-audio'
      ? runOnlineChatAudio(svc, media, rt, job)
      : runOnlineMultipart(svc, media, rt, job);
  }

  async function work(jobId) {
    const rt = running.get(jobId) || { canceled: false, child: null, req: null, dir: '' };
    running.set(jobId, rt);
    let dir = '';
    let source = null;
    try {
      const p = pending.get(jobId) || {};
      /* 排队期间就被取消（DELETE 只把 rt.canceled 立起来）：这一单还没开始，直接收尾。
         以前缺少这一道，取消之后仍然会下载素材、发起在线转写 —— 用户点了取消，账照扣。 */
      if (rt.canceled) return;
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
      /* 去重口径与实际转写口径必须是同一个语言：判在这里读设置优先的话，
         显式传了 en 的一单会拿 zh 去找旧结果（找到了就直接复用一段语言不对的文本）。 */
      const lang = langOf(mine);
      const route = mine.route;
      /* 去重还要看「谁出的结果」：同一份音频换在线模型再转一次，本来就是为了不一样的结果，
         只看哈希 + 语言会把上一次的文本直接复用回来。 */
      let engineKey = '';
      if (route === 'local') engineKey = 'local:' + (localAsrState(ctx.root).model || '');
      else if (route === 'service') {
        const svc = resolveService();
        engineKey = 'service:' + (svc.providerId || '') + '/' + (svc.model || '');
      }
      ctx.store.patchJob(jobId, { sourceHash: hash, media: source.media, engineKey });
      const hit = ctx.store.findByHash(hash, route, lang, engineKey);
      if (hit && hit.id !== jobId) {
        ctx.store.patchJob(jobId, {
          state: 'done', progress: 1, sourceHash: hash, segments: hit.segments, srt: hit.srt,
          engine: (hit.engine || '') + '（同一份媒体同一语言，复用旧结果）', media: source.media,
        });
        return;
      }
      /* 取素材可能要几十秒（在线路线要先下载）：取消也要在这一步之后、发上游之前再判一次，
         否则「下载途中取消」仍然会打一次按次计费的转写。 */
      if (rt.canceled) return;
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
          local: localView(localAsrState(ctx.root)),
          revision: ctx.store.settings().revision,
        });
        return true;
      }
      if (part[0] === 'settings' && method === 'GET') {
        const s = ctx.store.settings();
        sendJson(res, 200, { settings: s, local: localView(localAsrState(ctx.root)), revision: s.revision });
        return true;
      }
      if (part[0] === 'settings' && method === 'PUT') {
        const body = await readJsonBody(ctx.readBody, req, res, 64 * 1024);
        const s = ctx.store.patchSettings(body && body.settings ? body.settings : body);
        sendJson(res, 200, { ok: true, settings: s, local: localView(localAsrState(ctx.root)), revision: s.revision });
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
          /* 与 readPcmTo 超限同一种收法：先把 413 写出去，响应写完再断连接，
             不把客户端正在上传的几百 MB 先读完。 */
          try { res.once('finish', () => { try { req.destroy(); } catch (err) {} }); } catch (err) {}
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
          /* 超限是「拒绝这次上传」：先把 413 写出去，响应写完再断连接（见 readPcmTo）。
             以前在读到超限的那一刻就 destroy，客户端拿到的只有连接被掐断。 */
          if (e && e.status === 413) {
            try { res.once('finish', () => { try { req.destroy(); } catch (err) {} }); } catch (err) {}
          }
          sendJson(res, e.status || 400, { error: clean((e && e.message) || e, 800) });
          return true;
        }
        const job = {
          id, state: 'queued', progress: 0, segments: [], srt: '', error: '',
          sourceHash: '', route: 'local', language, engine: '', media,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        /* 先占名额再落账：占不到就把刚建的临时目录收掉，一个字节都不留在系统临时目录里。 */
        if (!claim(id, { pcmFile: file, pcmDir: dir, media, pcmHash: got.hash })) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
          sendJson(res, 429, { error: '已经有 ' + RUN_MAX + ' 单在转写，等一单跑完再提交' });
          return true;
        }
        try { ctx.store.putJob(job); } catch (e) {
          dropSlot(id);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
          throw e;
        }
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
        /* 与 /asr/pcm 同一句：占名额与判满在同一个同步块里，见 claim。 */
        if (!claim(id, { assetId: body && body.assetId, src: body && body.src })) {
          sendJson(res, 429, { error: '已经有 ' + RUN_MAX + ' 单在转写，等一单跑完再提交' });
          return true;
        }
        try { ctx.store.putJob(job); } catch (e) { dropSlot(id); throw e; }
        setImmediate(() => { work(id).catch(e => ctx.log('[asr] 任务异常 ' + id + '：' + ((e && e.message) || e))); });
        sendJson(res, 200, { jobId: id, state: 'queued', route, language });
        return true;
      }
      if (part[0] === 'browser-result' && method === 'POST') {
        /* 浏览器内 Whisper 跑完的那一单：转写本身在页面 worker 里完成，
           代理只负责把结果落成一条与 whisper-cli / 在线同形的任务账（SRT 在这里按同一份 toSrt 出）。
           同一份音频哈希同一种语言已有一单 done 的 → 直接回旧单（与本地 / 在线的去重同口径）。
           **不占 running 名额**：这一路代理不跑任何进程，识别早在页面里做完了；
           以前沿用 RUN_MAX 那道闸，另一单正在转写时，刚跑完几分钟的浏览器结果会被 429 直接丢掉。 */
        const body = await readJsonBody(ctx.readBody, req, res, 8 * 1024 * 1024);
        const segments = ctx.store.normSegments(body && body.segments);
        if (!segments.length) {
          sendJson(res, 400, { error: '转写结果里没有内容（可能是纯静音或模型没出字）' });
          return true;
        }
        const language = clean(body && body.language, 32) || ctx.store.rawSettings().language || '';
        const hash = clean(body && body.sourceHash, 40);
        const hit = hash ? ctx.store.findByHash(hash, 'browser', language, 'browser') : null;
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
          error: '', sourceHash: hash, route: 'browser', language, engine, engineKey: 'browser',
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
      /* 请求体太大 / 连接中断：readBody 已经当场答过 413 或 400 了（见 server/app.js），
         这里再 sendJson 一次是 ERR_HTTP_HEADERS_SENT，异常从 catch 逃到健康账上变成一句「请求出错」。 */
      if (e && e.alreadyReplied) return true;
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
