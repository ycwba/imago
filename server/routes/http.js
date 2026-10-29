/* 路由层唯一的 JSON 回包口径：Content-Type 与 Cache-Control 只在这里写一份。
   - sendJson(res, code, obj, headers)：写一个 JSON 对象；默认 no-store，调用方显式给了
     Cache-Control 就照它说的来。
   - fail(res, code, msg, extra)：错误回包 `{ error: String(msg), ...extra }`，一律 no-store
     （4xx/5xx 不许被缓存）。
   - noStore(res)：给即将用别的 Content-Type 写出（zip / 视频流 / 手写 JSON）的响应补上 no-store。
   这里不做业务判断：谁该回多少、错误文案是什么，仍由各个 routes/*.js 决定。 */
'use strict';

function sendJson(res, code, obj, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {});
  /* 调用方显式给了缓存头（大小写都算）就照它的，否则默认 no-store。 */
  if (!Object.keys(h).some(k => k.toLowerCase() === 'cache-control')) h['Cache-Control'] = 'no-store';
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}

function fail(res, code, msg, extra) {
  sendJson(res, code, Object.assign({ error: String(msg) }, extra || {}), { 'Cache-Control': 'no-store' });
}

function noStore(res) {
  if (!res || res.headersSent) return;
  res.setHeader('Cache-Control', 'no-store');
}

/* 请求体 → JSON：readBody 负责大小上限与超时，这里只把「读失败」与「不是合法 JSON」分开。
   asr 与 search 两条路由以前各抄一份同样的八行。
   ⚠ readBody 超上限时是**自己 writeHead(413) 之后**才 resolve(null) 的（server/app.js 的 readBody），
   所以「拿到 null」不等于「还没答过」——这里抛的这一条带 `alreadyReplied`，
   调用方的 catch 认它就必须收口：再 writeHead 一次是 ERR_HTTP_HEADERS_SENT，
   那条异常从 catch 里逃到外面，健康账记一笔「请求出错」，而用户其实已经拿到正确的 413。 */
async function readJsonBody(readBody, req, res, limit) {
  const b = await readBody(req, res, limit);
  if (b == null) {
    const e = new Error('请求体读取失败');
    e.alreadyReplied = true;
    throw e;
  }
  return JSON.parse(b.toString('utf8'));
}

module.exports = { sendJson, fail, noStore, readJsonBody };
