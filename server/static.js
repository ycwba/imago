/* 静态文件服务：ETag + no-cache + 文本 gzip。仅服务工作台自己的前端资源；
   /render、/asset、/local-assets 等带签名的媒体路由不要用这里的缓存策略。 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const staticGz = new Map();
const STATIC_GZ_MAX = 64;
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function htmlHeaders(ext) {
  return ext === '.html'
    ? { 'Content-Security-Policy': HTML_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
    : {};
}

function serveStatic(req, res, full, ext, mime) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const isHead = req.method === 'HEAD';
    const type = (mime && mime[ext]) || 'application/octet-stream';
    const compressible = /^(text\/|application\/(javascript|json|svg))/.test(type) || /^image\/svg/.test(type);
    const wantGz = compressible && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    /* ETag 里带上「这一份是哪种表示」：同一文件有原文 / gzip 两份，只按 mtime+size 算的话，
       gzip 请求拿到 304 会让客户端把上一次那份**原文**接着用 —— 字节数对不上，解压直接失败。
       后缀写在验证器本体里（`W/` 不够：弱验证器本来就允许两份不同字节互相顶替）。 */
    const etagOf = gz => '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '-' + (gz ? 'gz' : 'id') + '"';
    const etag = etagOf(wantGz);
    /* Vary 无论如何都要写：它描述的是「这个地址的响应还取决于哪个请求头」，
       跟这一次有没有真的压缩无关，缺了它中间的缓存就可能把 gzip 那份发给不接受 gzip 的客户端。 */
    const base = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag,
      'Vary': 'Accept-Encoding' }, htmlHeaders(ext));
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return; }
    const respond = (buf, gz) => {
      /* HEAD 与 GET 走同一条算路：报出去的 Content-Length 就是 GET 会发的那一份的字节数，
         以前 HEAD 在压缩分支里填的是原文长度，两个头自相矛盾。
         ETag 也跟着「实际发出去的那一份」算：压不动时发的是原文，验证器就得写 id，
         不能留着 gz 那个号 —— 否则下一轮拿它来要 304，客户端会把 gzip 那份继续用。 */
      const head = Object.assign({}, base, { 'ETag': etagOf(gz), 'Content-Length': String(buf.length) });
      if (gz) head['Content-Encoding'] = 'gzip';
      res.writeHead(200, head);
      res.end(isHead ? undefined : buf);
    };
    const cached = staticGz.get(full);
    const fresh = cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size;
    if (wantGz && fresh) { respond(cached.buf, true); return; }
    fs.readFile(full, (err2, raw) => {
      if (err2) { res.writeHead(404); res.end('not found'); return; }
      if (!wantGz) { respond(raw, false); return; }
      if (fresh) { respond(cached.buf, true); return; }
      zlib.gzip(raw, (err3, gz) => {
        if (err3 || !gz) { respond(raw, false); return; }        // 压不动就发原文，只是没省流量
        staticGz.set(full, { mtimeMs: st.mtimeMs, size: st.size, buf: gz });
        if (staticGz.size > STATIC_GZ_MAX) { const k = staticGz.keys().next().value; staticGz.delete(k); }
        respond(gz, true);
      });
    });
  });
}
module.exports = { serveStatic };
