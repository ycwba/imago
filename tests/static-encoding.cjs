#!/usr/bin/env node
/* 静态预压缩判据：brotli 优先 → gzip → 原文，三档共用同一套 ETag 与同一份缓存。
   两层跑法各有看不见的那一半：
     ① 进程内直接驱动 server/static.js（假 req/res）：协商表、ETag 口径、缓存命中计数、
「压不动就退下一档」这几件只有现调才看得见 —— 走 HTTP 只能看到结果，看不到压了几次。
     ② 真起一个隔离代理实例（harness）：验响应头与字节数真的到了线上，
        并实测同一份文件在 原文 / gzip / br 三档下的体积与二次请求的耗时。
   ① 是常驻档（不起实例，几十毫秒）；② 只在 `--live` 下跑，由 tests/all.cjs 的 e2e 档点名 ——
   为一份响应头多起一个 proxy 会把常驻档的耗时拖过预算线。
   服务端判据不碰浏览器件（没有 localStorage、没有页面）。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const H = require('./e2e/harness.cjs');
const { serveStatic, acceptedEncodings, staticCacheStats, brQuality } = require('../server/static.js');
const LIVE = process.argv.includes('--live');

const MIME = { '.js': 'application/javascript', '.html': 'text/html' };
const BR = 'br, gzip, deflate, zstd';

/* ---------- ① 协商表（纯函数）---------- */
const NEGO = [
  [BR, ['br', 'gz']],                                    // 浏览器实际发的那一串
  ['br', ['br']],
  ['gzip', ['gz']],
  ['gzip, br', ['br', 'gz']],                            // 表序说了算（最省的在前），不是头的顺序
  ['gzip;q=0.5, br;q=0.8', ['br', 'gz']],                // q 大的在前
  ['br;q=0, gzip', ['gz']],                              // q=0 是「明确不要」
  ['gzip, br;q=0', ['gz']],
  ['BR, GZIP', ['br', 'gz']],                            // 大小写无关
  ['identity', []],
  ['deflate', []],                                       // 没声明 br/gzip 就发原文
  ['*', []],
  ['', []],
  [undefined, []],
];
for (const [h, want] of NEGO) assert.deepEqual(acceptedEncodings(h), want, '协商对不上：' + JSON.stringify(h));

/* 大文件那一档确实退了一步（600KB 那一份：q10 326 ms / q9 33 ms，冷启动首请求压在它身上）。 */
assert.ok(brQuality(1 << 20) < brQuality(1 << 15), '256KB 以上还在用高质量档：首请求会重回几百毫秒');
assert.ok(brQuality(1 << 15) >= 9, '小文件的质量档掉到 9 以下，「再省约 15%」那条就没了根据');

/* ---------- ② 进程内驱动 serveStatic ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-static-enc-'));
function write(file, text) {
  const full = path.join(dir, file);
  fs.writeFileSync(full, text, 'utf8');
  return full;
}
function writeBuf(file, buf) {
  const full = path.join(dir, file);
  fs.writeFileSync(full, buf);
  return full;
}
/* 假 res：只记 writeHead 的头与 end 的字节，跟 routes-smoke 那一份假件同一套形状。 */
function ask(full, acceptEncoding, method = 'GET', extra = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serveStatic 没落地任何响应：' + path.basename(full))), 8000);
    const done = r => { clearTimeout(timer); resolve(r); };
    const res = {
      code: 0, headers: {}, chunks: [],
      writeHead(code, h) { this.code = code; Object.assign(this.headers, h || {}); },
      end(c) { if (c) this.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); finish(); },
    };
    const finish = () => {
      const body = Buffer.concat(res.chunks);
      const header = k => {
        const key = Object.keys(res.headers).find(x => x.toLowerCase() === k.toLowerCase());
        return key ? res.headers[key] : undefined;
      };
      done({ code: res.code, body, header, headers: res.headers });
    };
    const req = { method, headers: Object.assign({ 'accept-encoding': acceptEncoding }, extra) };
    try { serveStatic(req, res, full, path.extname(full), MIME); }
    catch (e) { clearTimeout(timer); reject(e); }
  });
}
const reprOf = etag => String(etag).replace(/^"(.*)-(br|gz|id)"$/, '$2');

/* web/ 子树里所有 .js/.css/.html，从大到小（体积比对的样品池）。
   现扫而不是写死名单：页面正被拆分时，写死的文件名会变成「文件不存在」那种假红。 */
function textAssets() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css|html)$/i.test(e.name)) out.push(p);
    }
  })(path.join(H.root, 'web'));
  return out.map(p => ({ p, size: fs.statSync(p).size })).sort((a, b) => b.size - a.size)
    .map(x => path.relative(H.root, x.p).split(path.sep).join('/'));
}
const largestAssets = n => textAssets().slice(0, n);

/* 线上真的会发出去的那一份：质量按 server/static.js 的 brQuality 取（大文件退一档），
   min 门槛以下不发 brotli，压完不比原文短就不发 —— 判据算的是这套口径，
   否则「省了 15%」是拿一个线上根本不用的质量档压出来的。 */
const brOf = b => (b.length < 1024 ? null
  : zlib.brotliCompressSync(b, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brQuality(b.length), [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length },
  }));
const sentOf = (b, br) => {
  const plain = Math.min(zlib.gzipSync(b).length, b.length);
  return { gzip: plain, br: br && br.length < b.length ? br.length : plain };
};

(async () => {
  const big = '/* 合成的大文件：让 brotli 的容器开销真的能被量出来 */\n'
    + 'const 探针 = ' + JSON.stringify({ 内容: '重复的中文与英文 mixed content  '.repeat(120) }) + ';\n';
  const fullBig = write('big.js', big);
  const fullSmall = write('small.js', 'const a = ' + JSON.stringify({ 小: '重复重复重复'.repeat(40) }) + ';\n');
  const fullHtml = write('page.html', '<!doctype html><html><body>' + '外壳'.repeat(600) + '</body></html>');

  /* —— 三种表示都在、ETag 口径一致 —— */
  const rBr = await ask(fullBig, BR);
  assert.equal(rBr.code, 200, 'br 请求要 200');
  assert.equal(rBr.header('content-encoding'), 'br', '接受 br 时必须回 br');
  assert.equal(reprOf(rBr.header('etag')), 'br', 'ETag 要写明这一份是 brotli：' + rBr.header('etag'));
  assert.equal(zlib.brotliDecompressSync(rBr.body).toString('utf8'), big, 'br 的字节解不回原文');
  assert.equal(Number(rBr.header('content-length')), rBr.body.length, 'br 的 Content-Length 与字节数不符');
  assert.equal(rBr.header('vary'), 'Accept-Encoding', '缺 Vary 会把 br 那份发给不接受 br 的缓存');

  const rGz = await ask(fullBig, 'gzip');
  assert.equal(rGz.header('content-encoding'), 'gzip', '只接受 gzip 时必须回 gzip');
  assert.equal(reprOf(rGz.header('etag')), 'gz');
  assert.equal(zlib.gunzipSync(rGz.body).toString('utf8'), big, 'gzip 的字节解不回原文');

  const rId = await ask(fullBig, 'identity');
  assert.equal(rId.header('content-encoding'), undefined, '不接受编码时不许带 Content-Encoding');
  assert.equal(reprOf(rId.header('etag')), 'id');
  assert.equal(rId.body.toString('utf8'), big, '原文那一路必须一字不改');
  assert.equal(Number(rId.header('content-length')), Buffer.byteLength(big), '原文长度不等于磁盘文件大小');

  /* ETag 口径：同一文件同一版本，三种表示只有末位表示名不同（前半截必须一样，否则 304 会串编码）。 */
  const stem = etag => String(etag).replace(/-(br|gz|id)"$/, '-"');
  assert.equal(stem(rBr.header('etag')), stem(rGz.header('etag')), 'mtime+size 那一截在三种表示间漂了');
  assert.equal(stem(rBr.header('etag')), stem(rId.header('etag')), 'mtime+size 那一截在三种表示间漂了');

  /* —— 二次请求命中缓存：hits 加一、encodes 不加 —— */
  const s0 = staticCacheStats();
  const rBr2 = await ask(fullBig, BR);
  const s1 = staticCacheStats();
  assert.equal(rBr2.header('etag'), rBr.header('etag'), '命中缓存后 ETag 变了');
  assert.ok(Buffer.compare(rBr2.body, rBr.body) === 0, '两次 br 的字节不一样');
  assert.equal(s1.hits - s0.hits, 1, '第二次请求没有走缓存（hits 没加）');
  assert.equal(s1.encodes - s0.encodes, 0, '第二次请求又压了一次（encodes 加了）：缓存没起作用');
  assert.ok(s1.entries >= 1, '缓存里一份都没有');

  /* —— 304 与 HEAD —— */
  const r304 = await ask(fullBig, BR, 'GET', { 'if-none-match': rBr.header('etag') });
  assert.equal(r304.code, 304, '拿自己的 ETag 来要，应该 304');
  assert.equal(r304.body.length, 0, '304 不许带正文');
  const rHead = await ask(fullBig, BR, 'HEAD');
  assert.equal(Number(rHead.header('content-length')), rBr.body.length, 'HEAD 报的长度不是 GET 会发的那一份');
  assert.equal(rHead.body.length, 0, 'HEAD 不许带正文');
  /* 别的编码的验证器不能拿来要 304：那会把 gzip 那份当 brotli 用。 */
  const rCross = await ask(fullBig, BR, 'GET', { 'if-none-match': rGz.header('etag') });
  assert.equal(rCross.code, 200, '拿 gzip 的 ETag 来要 brotli 不该 304');

  /* —— 小文件：brotli 的容器开销抵不回收益，退 gzip —— */
  const rSmall = await ask(fullSmall, BR);
  assert.equal(rSmall.header('content-encoding'), 'gzip', '小文件应当跳过 brotli 退到 gzip：' + rSmall.header('content-encoding'));

  /* —— HTML 的 CSP 不因编码而丢 —— */
  const rHtml = await ask(fullHtml, BR);
  assert.equal(rHtml.header('content-encoding'), 'br');
  assert.match(String(rHtml.header('content-security-policy')), /script-src 'self'/, 'HTML 的 CSP 头被编码分支弄丢了');

  /* —— 压不动：只退档，不 500 ——（直接把 zlib 的入口换成「回调报错」，
     static.js 是调用时才取 zlib.brotliCompress，所以这一改就命中那一条退路） */
  const realBr = zlib.brotliCompress;
  const fullFailBr = write('fail-br.js', big);
  zlib.brotliCompress = (buf, opts, cb) => cb(new Error('探针：brotli 压不动'));
  const rFailBr = await ask(fullFailBr, BR);
  assert.equal(rFailBr.code, 200, 'brotli 失败不能让请求 500');
  assert.equal(rFailBr.header('content-encoding'), 'gzip', 'brotli 失败要退到 gzip');
  const s2 = staticCacheStats();
  const rFailBr2 = await ask(fullFailBr, BR);
  const s3 = staticCacheStats();
  assert.equal(rFailBr2.header('content-encoding'), 'gzip', '压不动那一档要记住，第二次别再压');
  assert.equal(s3.encodes - s2.encodes, 0, '同一份文件把失败那一档又压了一遍');
  zlib.brotliCompress = realBr;

  const realGz = zlib.gzip;
  const fullFailBoth = write('fail-both.js', big);
  zlib.brotliCompress = (buf, opts, cb) => cb(new Error('探针：brotli 坏了'));
  zlib.gzip = (buf, cb) => cb(new Error('探针：gzip 坏了'));
  const rFailBoth = await ask(fullFailBoth, BR);
  zlib.brotliCompress = realBr;
  zlib.gzip = realGz;
  assert.equal(rFailBoth.code, 200, '两档都压不动也不能 500');
  assert.equal(rFailBoth.header('content-encoding'), undefined, '两档都失败要发原文');
  assert.equal(rFailBoth.body.toString('utf8'), big, '退到原文时正文要原样');
  /* 压完不比原文短就不算「压成功了」：这一路要退到下一档，两档都退不动就发原文。
     4096 字节随机数谁都压不动（实测 br 4100 / gzip 4119），正好是这条退路的样品。 */
  const noiseBuf = require('crypto').randomBytes(4096);
  const fullNoise = writeBuf('noise.js', noiseBuf);
  const rNoise = await ask(fullNoise, BR);
  assert.equal(rNoise.code, 200, '压不动的文件也要正常回话');
  assert.equal(rNoise.header('content-encoding'), undefined, '压完比原文长却仍发了压缩那份');
  assert.ok(rNoise.body.equals(noiseBuf), '退到原文时正文要原样');

  /* —— 文件变了：三档一起作废 —— */
  const fullEdit = write('edit.js', big);
  const rEdit1 = await ask(fullEdit, BR);
  fs.writeFileSync(fullEdit, big + '\n\n/* 加了几行让 size 与 mtime 变掉 */\n', 'utf8');
  const rEdit2 = await ask(fullEdit, BR);
  assert.notEqual(rEdit2.header('etag'), rEdit1.header('etag'), '文件变了 ETag 还留着旧的');
  assert.equal(zlib.brotliDecompressSync(rEdit2.body).toString('utf8'),
    fs.readFileSync(fullEdit, 'utf8'), '文件变了却还在发缓存里那一份');

  /* ---------- ③ 真起一个隔离代理实例 ---------- */
  if (!LIVE) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不算判据失败 */ }
    console.log('✓ 静态预压缩判据通过（协商、ETag 口径、304/HEAD、压不动退档、缓存命中；线上响应加 --live）');
    return;
  }
  const proxy = await H.startProxy();
  let http1 = 0, http2 = 0;
  try {
    const get = (urlPath, acceptEncoding) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const req = http.get(proxy.base + urlPath, { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - t0 }));
        });
      req.on('error', reject);
    });
    /* 线上这一路挑的是随仓库一起 vendored 的那份 Vue runtime：它由静态路由的「根级单文件」放行、
       体积够大（14 万+ 字节），而且**不会跟着别的会话正在改的 web/ 一起漂** —— 拿 web/ 里的文件比，
       读盘与响应之间被人改一行就会假红。 */
    const rel = '/vue.runtime.esm-browser.prod.js';
    const r1 = await get(rel, BR);
    http1 = r1.ms;
    const disk = fs.readFileSync(path.join(H.root, 'vue.runtime.esm-browser.prod.js'));
    assert.equal(r1.code, 200, '线上 br 请求要 200');
    assert.equal(r1.headers['content-encoding'], 'br', '线上没走 brotli：' + r1.headers['content-encoding']);
    assert.equal(reprOf(r1.headers.etag), 'br', '线上 ETag 没写明表示：' + r1.headers.etag);
    assert.equal(Number(r1.headers['content-length']), r1.body.length);
    assert.ok(zlib.brotliDecompressSync(r1.body).equals(disk), '线上 br 的字节解不回磁盘那份');
    const rg = await get(rel, 'gzip');
    assert.equal(rg.headers['content-encoding'], 'gzip');
    assert.ok(zlib.gunzipSync(rg.body).equals(disk), '线上 gzip 的字节解不回磁盘那份');
    const stBr = String(r1.headers.etag), stGz = String(rg.headers.etag);
    assert.equal(stBr.replace(/-br"$/, '-x"'), stGz.replace(/-gz"$/, '-x"'), '两种表示的 ETag 前半截不一致（口径漂了）');
    const ri = await get(rel, undefined);
    assert.ok(!ri.headers['content-encoding'], '不带 Accept-Encoding 却给了 Content-Encoding');
    assert.equal(ri.body.length, disk.length, '原文那一路的字节数不等于磁盘大小');
    const r2 = await get(rel, BR);
    http2 = r2.ms;
    assert.equal(r2.headers.etag, stBr, '第二次请求的 ETag 变了');
    const faults = H.logFaults(proxy.log);
    assert.ok(!faults.length, '代理日志里有未处理异常：' + faults.join(' / '));

    /* 体积比对（「再省约 15%」这一句的常驻证据）：按上面 sentOf 那套线上口径，
       样品 = web/ 全部 .js/.css/.html 与最大的那几份，两个口径都要过。 */
    const pool = textAssets();
    let raw = 0, gz = 0, br = 0, brWin = 0;
    for (const f of pool) {
      const b = fs.readFileSync(path.join(H.root, f));
      const s = sentOf(b, brOf(b));
      raw += b.length; gz += s.gzip; br += s.br;
      if (s.br < s.gzip) brWin++;
    }
    assert.ok(pool.length >= 50, '样品池只有 ' + pool.length + ' 份，全站口径量不出名堂');
    const pct = (a, b2) => ((1 - b2 / a) * 100).toFixed(2);
    assert.ok(br < gz, '全站 brotli 反而比 gzip 大：gz ' + gz + ' / br ' + br);
    assert.ok((gz - br) / gz >= 0.13, '全站 brotli 相对 gzip 只省 ' + pct(gz, br) + '%，够不上「再省约 15%」'
      + '（质量档、min 门槛或 sentOf 的口径被动过？）');

    let topRaw = 0, topGz = 0, topBr = 0;
    for (const f of largestAssets(5)) {
      const b = fs.readFileSync(path.join(H.root, f));
      const s = sentOf(b, brOf(b));
      topRaw += b.length; topGz += s.gzip; topBr += s.br;
    }
    assert.ok(topBr < topGz, '最大五份里 brotli 反而比 gzip 大：gz ' + topGz + ' / br ' + topBr);
    assert.ok((topGz - topBr) / topGz >= 0.12, '最大五份只省 ' + pct(topGz, topBr) + '%，低于阈值');

    console.log('  线上实测 ' + rel + '：原文 ' + disk.length + ' B ｜ gzip ' + rg.body.length + ' B ｜ br ' + r1.body.length + ' B');
    console.log('  ETag：br ' + stBr + ' ｜ gzip ' + stGz + ' ｜ 原文 ' + String(ri.headers.etag));
    console.log('  首次（要压）' + http1 + ' ms ｜ 二次（走缓存）' + http2 + ' ms');
    console.log('  最大的五份合计：原文 ' + topRaw + ' B ｜ gzip ' + topGz + ' B ｜ br ' + topBr + ' B（省 ' + pct(topGz, topBr) + '%）');
    console.log('  全站 ' + pool.length + ' 份 .js/.css/.html 合计：原文 ' + raw + ' B ｜ gzip ' + gz + ' B ｜ br ' + br
      + ' B（省 ' + pct(gz, br) + '%，其中 ' + brWin + ' 份真的发了 br）');
    console.log('  缓存计数：' + JSON.stringify(staticCacheStats()));
  } finally {
    await proxy.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不算判据失败 */ }
  }
  console.log('✓ 静态预压缩判据通过（br→gzip→原文 协商、ETag 口径、304/HEAD、压不动退档、缓存命中、线上响应）');
})().catch(e => {
  console.error('✗ ' + ((e && e.stack) || e));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (x) { /* 同上 */ }
  process.exitCode = 1;
});
