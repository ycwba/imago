/* 设置页两条「通道」共用的取数小件：语音识别（asr.json）与联网搜索（search.json）。
   providerOf / mirrored / channelKey / channelBase / loopback / collect 以前在
   routes/asr.js 与 routes/search.js 各抄一份 —— 相同的东西两份实现，改一处漏一处：
   search 那份的回环判定先 net.isIP 再认 127.*，asr 那份直接 /^127\./，
   于是 http://127.evil.tld 在识别路线会被当成「本机」放行并带着密钥发出去。
   现在两边都从这里取，判据只有这一份。 */
'use strict';
const fs = require('fs');
const net = require('net');

/* 按 id 或 keyId 找供应商（注册表读不出来就当没有）。 */
function providerOf(ctx, id) {
  if (!id) return null;
  try { return (ctx.providers() || []).find(p => p.id === id || p.keyId === id) || null; }
  catch { return null; }
}

/* 读 `sk_key_<kid>` / `sk_base_<kid>` 那种镜像文件里的字符串值。
   镜像文件的正文就是客户端 localStorage 的原值（data-store 原样落盘）：字符串类的键
   （sk_key_* / sk_base_* 都是）落盘是**裸文本**（`D:\作品`、`sk-or-v1-…`，不是 JSON），
   只有对象类的键才是 Store 的信封 `{"data":…,"ts":…}`。所以先按裸文本读；
   只有内容长得像信封（JSON 对象且带 data 字段）才按信封拆。
   以前只按信封 JSON.parse —— 字符串键必抛 → catch → 返回空，
   「用渠道那把密钥」永远读不到设置页里填的那把，设置页明明显示「已填密钥」。 */
function mirrored(ctx, kind, kid) {
  if (!kid) return '';
  let raw = '';
  try { raw = fs.readFileSync(ctx.dataFileOf(kind + kid), 'utf8'); } catch { return ''; }
  const text = String(raw).trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const env = JSON.parse(text);
      const v = env && env.data;
      if (typeof v === 'string') return v.trim();
    } catch { /* 不是合法 JSON（或不是信封形状）：按裸文本原样用 */ }
  }
  return text;
}

/* 密钥 / 地址按**存密钥的那一格**（keyId）读：一条 provider 的 id 可能只是它的一档
   （minimax-text 的密钥存在 sk_key_minimax、siliconflow-image 的存在 sk_key_siliconflow），
   拿 id 去拼文件读不到，会悄悄退化到 .env —— 设置页里明明填了一把，页面上却当没填。 */
function channelKey(ctx, kid) {
  const p = providerOf(ctx, kid);
  const store = (p && p.keyId) || kid;
  return mirrored(ctx, 'sk_key_', store)
    || (store !== kid ? mirrored(ctx, 'sk_key_', kid) : '')
    || (p && p.keyEnv ? ctx.keyOf(p.keyEnv) : '');
}

function channelBase(ctx, kid) {
  const p = providerOf(ctx, kid);
  const store = (p && p.keyId) || kid;
  return mirrored(ctx, 'sk_base_', store)
    || (store !== kid ? mirrored(ctx, 'sk_base_', kid) : '')
    || (p && p.base) || '';
}

/* 是不是本机回环。先确认 hostname **是 IP 字面量**再看前缀：
   /^127\./ 会把 127.evil.tld 这种域名当成回环放行，而那个域名解析到哪都行 ——
   http 分支就带着密钥直连过去了。 */
function loopback(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost') return true;
    if (net.isIP(h) === 4) return h.startsWith('127.');
    if (net.isIP(h) === 6) return h === '::1';
    return false;
  } catch { return false; }
}

/* 发一次 JSON POST 并收回整段响应（上限 maxBytes）。
   搜索的几套接口与语音识别的 chat-audio 那一族共用这一份：两条路都必须在发之前过
   guardOutboundUrl（异步，含 DNS），并走 ctx.anyRequest 那一条出站（系统代理的 CONNECT 隧道
   只有它会挑），自己再写一份就会漏掉其中一样。
   连接层失败归到 network / timeout ——「上游连不上」与「参数填错了」在页面上是两句话。 */
function postJson(ctx, arg) {
  const a = arg || {};
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = e => {
      if (settled) return;
      settled = true;
      if (e && e.kind) return reject(e);
      const m = (e && e.message) || String(e || '');
      const err = new Error('请求失败：' + String(m).slice(0, 300));
      err.kind = /timeout|超时/i.test(m) ? 'timeout' : 'network';
      reject(err);
    };
    const dispatch = () => {
      let req;
      try {
        req = ctx.anyRequest(a.url, { method: 'POST', headers: a.headers || {} }, res => {
          collect(res, a.maxBytes || 4 * 1024 * 1024)
            .then(text => { if (!settled) { settled = true; resolve({ status: res.statusCode || 0, text }); } }, fail);
        });
      } catch (e) { fail(e); return; }
      if (a.timeoutMs) {
        req.setTimeout(a.timeoutMs, () => req.destroy(new Error('超时（' + Math.round(a.timeoutMs / 1000) + ' 秒）')));
      }
      if (typeof a.onReq === 'function') { try { a.onReq(req); } catch (e) { /* 调用点自己的记账失败不该打断请求 */ } }
      req.on('error', fail);
      req.write(a.body || Buffer.alloc(0));
      req.end();
    };
    const u = String(a.url || '');
    if (/^https:/i.test(u)) ctx.guardOutboundUrl(u).then(dispatch, e => {
      if (settled) return;
      settled = true;
      const err = new Error('地址没通过出站护栏：' + String((e && e.message) || e || ''));
      reject(err);
    });
    else if (loopback(u)) dispatch();
    else {
      settled = true;
      const err = new Error('只允许 https（本机回环可用 http）');
      err.kind = 'upstream';
      reject(err);
    }
  });
}

/* 收一段上游响应，超过 max 字节当场断掉（不先把整段吞进内存）。 */
function collect(res, max) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    res.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        res.destroy(new Error('上游响应超过 ' + Math.round(max / 1048576) + 'MB'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')); });
    res.on('error', reject);
  });
}

module.exports = { providerOf, mirrored, channelKey, channelBase, loopback, collect, postJson };
