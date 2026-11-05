/* 静态文件服务：ETag + no-cache + 文本预压缩（brotli 优先、退 gzip、再退原文）。
   仅服务工作台自己的前端资源；/asset、/local-assets 等带签名的媒体路由不要用这里的缓存策略。 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

/* 预压缩缓存：一个文件一份表项，gzip 与 brotli 各存自己那一档的字节，新鲜判据（mtime + size）
   两档共用 —— 加一档只是在同一条里多一个字段，不是第二套缓存体系。
   档位字段三种状态：Buffer 是压好了；false 是压过但不采用（压不动 / 压完更大 / 不在这一档的
   适用区间），留着它下次不再白压一遍；字段不存在是还没试过。 */
const staticEnc = new Map();
/* 只留最近若干份，避免无界。开机预热会一次填进全站文本资源（约一百来份，压完一两 MB），
   上限必须盖得住它 —— 否则预热压到最后几份时把最前面的首屏那几份挤掉，等于白热。 */
const STATIC_ENC_MAX = 192;
/* 档位是量出来的，不是拍的（本机 node 24，仓库里 120 份 .js/.css/.html 各压一遍）：
     统一 q9  ：相对 gzip 省 12.7% ｜ 累计 1.0 s ｜ 最慢单份 engine.js 33 ms
     统一 q10 ：相对 gzip 省 15.9% ｜ 累计 2.7 s ｜ 最慢单份 engine.js 326 ms
   q10 多出来的那 3 个百分点几乎全在 256KB 以下的尾巴上（每份只贵 60~100 ms），
   而最贵的是 600KB 那一份：33 ms 涨到 326 ms，冷启动首请求正好压在它身上。
   所以按体积切一刀：只有超大那几份退 q9，其余走 q10 —— 实测相对 gzip 省 15.4%、
   累计 1.8 s、最慢单份 101 ms（「再省约 15%」与「冷启动 TTI ≤1.5s」两头都够）。 */
const BR_QUALITY = 10;
const BR_QUALITY_BIG = 9;
const BR_BIG_BYTES = 256 * 1024;
const brQuality = raw => (raw > BR_BIG_BYTES ? BR_QUALITY_BIG : BR_QUALITY);
/* 编码档位表：协商顺序就是这里的顺序（最省的那一档在前）。加一档只改这张表，不开第二条管道。
   · br：质量按上面的体积切；全站 .js/.css/.html 一份一个进程只压一次（异步走 libuv 线程池），
     结果进缓存。min 以下 brotli 自己的容器开销抵不回收益；max 以上不值得在请求路径上占这一份内存。
   · gz：口径与加 brotli 之前一致（不设上下限、默认质量），它是 br 落空时退的那一路。 */
const ENCODINGS = [
  { repr: 'br', token: 'br', min: 1024, max: 8 << 20,
    compress: (raw, cb) => zlib.brotliCompress(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brQuality(raw.length), [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    }, cb) },
  { repr: 'gz', token: 'gzip', compress: (raw, cb) => zlib.gzip(raw, cb) },
];
const encodingOf = repr => ENCODINGS.find(e => e.repr === repr);
/* 只给判据看「第二次请求有没有真命中缓存」与「一共压了几次」，不参与任何回话逻辑。 */
const ENC_STATS = { hits: 0, encodes: 0 };
const staticCacheStats = () => ({ entries: staticEnc.size, hits: ENC_STATS.hits, encodes: ENC_STATS.encodes });

/* ---------- brotli 压缩的唯一一只入口（请求路径与开机预热共用） ----------
   同一份文件同一时刻只压一次：开机预热正在压那一份时，先到的请求挂上去等同一份结果，
   不再自己压一遍（两次都压就是冷启动最贵的那一段被做两遍）。 */
const pendingBr = new Map();
const brKeyOf = (full, entry) => full + '|' + entry.mtimeMs + '|' + entry.size;

function compressBrCached(full, entry, raw, cb) {
  const key = brKeyOf(full, entry);
  const list = pendingBr.get(key);
  if (list) { list.push(cb); return; }
  pendingBr.set(key, [cb]);
  ENC_STATS.encodes++;
  zlib.brotliCompress(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brQuality(raw.length), [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
  }, (err, buf) => {
    const ok = !err && buf && buf.length && buf.length < raw.length;
    /* 压的这段时间里文件可能被换掉：换掉了就不往旧 entry 上写结果（下一次按新 mtime 重来）。 */
    if (staticEnc.get(full) === entry) entry.br = ok ? buf : false;
    const waiters = pendingBr.get(key) || [];
    pendingBr.delete(key);
    for (const fn of waiters) { try { fn(ok ? buf : false); } catch (e) {} }
  });
}

/* ---------- 开机预热 ----------
   冷启动第一屏要 40+ 份文本资源，每份现压 brotli 约 25–100ms（libuv 线程池 4 条），
   串起来就是首屏多出来的那半秒到一秒（实测 12 份计 740ms）。开机后先把这些档算好塞进缓存，
   浏览器第一次来时就只剩读缓存 + 发字节。只热 br —— 浏览器实际都发它；gzip 仍按需压。
   有预算就停：预热是抢在用户前面做的，不是把 CPU 占住不放。 */
function warmStaticFile(full, done) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return done();
    let entry = staticEnc.get(full);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = { mtimeMs: st.mtimeMs, size: st.size };
      staticEnc.set(full, entry);
      if (staticEnc.size > STATIC_ENC_MAX) {
        const oldest = staticEnc.keys().next().value;
        if (oldest !== full) staticEnc.delete(oldest);
      }
    }
    if (Buffer.isBuffer(entry.br) || entry.br === false) return done();
    fs.readFile(full, (err2, raw) => {
      if (err2) return done();
      if (raw.length < ENCODINGS[0].min || raw.length > ENCODINGS[0].max) { entry.br = false; return done(); }
      compressBrCached(full, entry, raw, () => done());
    });
  });
}

/* files 是按优先级排好的绝对路径（调用方负责去重与筛选）；超预算就停手，剩下的按需压。 */
function warmStatic(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const budgetMs = opts.budgetMs > 0 ? opts.budgetMs : 4000;
  const conc = Math.max(1, Math.min(6, opts.concurrency || 3));
  const started = Date.now();
  let i = 0, active = 0;
  return new Promise(resolve => {
    const runQueue = () => {
      while (active < conc && i < list.length && Date.now() - started < budgetMs) {
        active++;
        warmStaticFile(list[i++], () => { active--; runQueue(); });
      }
      if (i >= list.length || Date.now() - started >= budgetMs) {
        if (active === 0) resolve({ warmed: i, ms: Date.now() - started });
        return;
      }
    };
    runQueue();
  });
}

/* Accept-Encoding → 客户端能收的那几一档（按 ENCODINGS 的顺序回，最省的在前）。
   · q=0 是「明确不要这一档」，当它没有；把它当接受会让 br 永远抢在前面。
   · 不认 `*`：静态全是文本，为一个通配把 brotli 塞给没声明过它的客户端不值当。
   · 同 q 时保持表序（br 在前）：sort 是稳定的，排完 q 表序自然留着。 */
function acceptedEncodings(header) {
  const q = {};
  for (const part of String(header || '').toLowerCase().split(',')) {
    const name = part.split(';')[0].trim();
    const m = /\bq\s*=\s*([0-9.]+)/.exec(part);
    const val = m ? Number(m[1]) : 1;
    if (!(val > 0)) continue;
    for (const e of ENCODINGS) if (e.token === name) q[e.repr] = Math.max(q[e.repr] || 0, val);
  }
  return ENCODINGS.filter(e => q[e.repr]).sort((a, b) => q[b.repr] - q[a.repr]).map(e => e.repr);
}

const HTML_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self' blob:";

function htmlHeaders(ext) {
  return ext === '.html'
    ? { 'Content-Security-Policy': HTML_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
    : {};
}

function serveStatic(req, res, full, ext, mime) {
  fs.stat(full, (err, st) => {
    /* no-store：一次坏 404（比如白名单漏了 .wasm 那阵子）不许被浏览器启发式缓存，
       否则修好之后 ORT 还在反复拿旧的那句 "not found" 当 wasm 喂给 WebAssembly.instantiate。 */
    if (err || !st.isFile()) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('not found'); return; }
    const isHead = req.method === 'HEAD';
    const type = (mime && mime[ext]) || 'application/octet-stream';
    const compressible = /^(text\/|application\/(javascript|json|svg))/.test(type) || /^image\/svg/.test(type);
    const want = compressible ? acceptedEncodings(req.headers['accept-encoding']) : [];
    /* ETag 里带上「这一份是哪种表示」：同一文件有原文 / gzip / brotli 三份，只按 mtime+size 算的话，
       某一种编码的请求拿到 304 会让客户端把上一次那份**别的编码**接着用 —— 字节数对不上，解压直接失败。
       后缀写在验证器本体里（`W/` 不够：弱验证器本来就允许两份不同字节互相顶替）。
       三份的前半截（mtime-size）完全相同，只有末位的表示名不同：同一文件同一版本在三种编码下
       是同一个口径，客户端换编码时只会重新要一次，不会串用另一份编码的缓存。 */
    const etagOf = repr => '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '-' + repr + '"';
    const etag = etagOf(want[0] || 'id');
    /* Vary 无论如何都要写：它描述的是「这个地址的响应还取决于哪个请求头」，
       跟这一次有没有真的压缩无关，缺了它中间的缓存就可能把 br 那份发给不接受 br 的客户端。 */
    const base = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag,
      'Vary': 'Accept-Encoding' }, htmlHeaders(ext));
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return; }
    const respond = (buf, repr) => {
      /* HEAD 与 GET 走同一条算路：报出去的 Content-Length 就是 GET 会发的那一份的字节数，
         以前 HEAD 在压缩分支里填的是原文长度，两个头自相矛盾。
         ETag 也跟着「实际发出去的那一份」算：压不动时发的是原文，验证器就得写 id，
         不能留着 br / gz 那个号 —— 否则下一轮拿它来要 304，客户端会把别的编码那份继续用。 */
      const head = Object.assign({}, base, { 'ETag': etagOf(repr), 'Content-Length': String(buf.length) });
      const enc = encodingOf(repr);
      if (enc) head['Content-Encoding'] = enc.token;
      res.writeHead(200, head);
      res.end(isHead ? undefined : buf);
    };
    /* 文件换了（mtime 或 size 对不上）三档一起作废。
       客户端一档都不接受时不留条目：那一路每次读的都是原文，占缓存名额没有意义。 */
    let entry = staticEnc.get(full);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = want.length ? { mtimeMs: st.mtimeMs, size: st.size } : null;
      if (entry) {
        staticEnc.set(full, entry);
        if (staticEnc.size > STATIC_ENC_MAX) {
          const oldest = staticEnc.keys().next().value;
          if (oldest !== full) staticEnc.delete(oldest);     // 别把刚刚要往里写的那一份端掉
        }
      }
    }
    /* 命中缓存那一档：一个字节不读、一次都不压。 */
    const cached = want.find(r => entry && Buffer.isBuffer(entry[r]));
    if (cached) { ENC_STATS.hits++; respond(entry[cached], cached); return; }
    fs.readFile(full, (err2, raw) => {
      if (err2) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('not found'); return; }
      /* 沿档位表往下退：压不动、压完不比原文短、不在这一档的适用区间 —— 都记 false 试下一档，
         全落空就发原文。任何一种失败都不让这一条请求 500；量不出该不该压时按「不压」走。 */
      const tryRepr = i => {
        if (i >= want.length) { respond(raw, 'id'); return; }
        const repr = want[i];
        if (Buffer.isBuffer(entry[repr])) { ENC_STATS.hits++; respond(entry[repr], repr); return; }
        const e = encodingOf(repr);
        if (entry[repr] === false || !e || raw.length < (e.min || 0) || raw.length > (e.max || Infinity)) {
          entry[repr] = false;
          tryRepr(i + 1);
          return;
        }
        if (repr === 'br') {
          /* 走公共那一只入口：开机预热正在压这一份时挂上去等同一份结果（计入 encodes 也在那一份里）。 */
          compressBrCached(full, entry, raw, buf => {
            if (buf) respond(buf, 'br');
            else tryRepr(i + 1);                              // 压不动 / 压完不更短：往下退，不重试、不报错
          });
          return;
        }
        ENC_STATS.encodes++;
        e.compress(raw, (err3, buf) => {
          if (!err3 && buf && buf.length && buf.length < raw.length) { entry[repr] = buf; respond(buf, repr); return; }
          entry[repr] = false;                                // 这一档没用：往下退，不重试、不报错
          tryRepr(i + 1);
        });
      };
      tryRepr(0);
    });
  });
}
module.exports = { serveStatic, acceptedEncodings, encodingOf, staticCacheStats, brQuality, BR_QUALITY, warmStatic };
