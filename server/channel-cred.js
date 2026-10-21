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

/* 读 `sk_key_<kid>` / `sk_base_<kid>` 那种镜像文件里的字符串值。 */
function mirrored(ctx, kind, kid) {
  if (!kid) return '';
  try {
    const env = JSON.parse(fs.readFileSync(ctx.dataFileOf(kind + kid), 'utf8'));
    const v = env && env.data;
    return typeof v === 'string' ? v.trim() : '';
  } catch { return ''; }
}

function channelKey(ctx, kid) {
  const p = providerOf(ctx, kid);
  return mirrored(ctx, 'sk_key_', kid) || (p && p.keyEnv ? ctx.keyOf(p.keyEnv) : '');
}

function channelBase(ctx, kid) {
  const p = providerOf(ctx, kid);
  return mirrored(ctx, 'sk_base_', kid) || (p && p.base) || '';
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

module.exports = { providerOf, mirrored, channelKey, channelBase, loopback, collect };
