/* 路由层唯一的 JSON 回包口径：Content-Type 与 Cache-Control 只在这里写一份。
   - sendJson(res, code, obj, headers)：写一个 JSON 对象；默认 no-store，调用方显式给了
     Cache-Control 就照它说的来。
   - fail(res, code, msg, extra)：错误回包 `{ error: String(msg), ...extra }`，一律 no-store
     （4xx/5xx 不许被缓存 —— 见 AGENTS §4.3）。
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
   asr 与 search 两条路由以前各抄一份同样的八行。 */
async function readJsonBody(readBody, req, res, limit) {
  const b = await readBody(req, res, limit);
  if (b == null) throw new Error('请求体读取失败');
  return JSON.parse(b.toString('utf8'));
}

module.exports = { sendJson, fail, noStore, readJsonBody };
