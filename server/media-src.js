/* 素材地址解析与下载的唯一实现（resolveSrc / downloadTo / assetInfoOf）：
   FCPXML 媒体包、/asset/<id> 路由都靠它。
   工厂注入依赖（assetStore / upRequest / guardOutboundUrl / anyRequest / keyOf / localAssetFile / PORT / SESSION_* / safeDecode / cacheSweep），
   不做转码 —— 只做「地址 → 可下载 https URL」与「流式下载到文件」。 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOWNLOAD_MAX = 2 * 1024 * 1024 * 1024;   // 单片素材下载上限 2 GiB（防超大/恶意地址打爆进程）
const ASSET_URL_TTL = 5 * 60 * 1000;

function createMediaSrc(deps) {
  const { assetStore, upRequest, cacheSweep, guardOutboundUrl, anyRequest, keyOf,
    localAssetFile, PORT, SESSION_COOKIE, SESSION_TOKEN, safeDecode, log } = deps;

  const assetUrlCache = new Map();          // id|密钥尾号 → { ts, ttl, url, mime }
  const keyTagOf = k => (k ? String(k).slice(-8) : 'anon');
  function pickPath(obj, dotted) {
    if (!obj || !dotted) return '';
    let cur = obj;
    for (const k of String(dotted).split('.')) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = cur[k];
    }
    return cur == null ? '' : cur;
  }
  function assetInfoOf(id, key) {
    if (!assetStore) {
      const e = new Error('当前注册表没有声明 assetStore，代理不知道去哪一家换资产下载地址');
      e.status = 501;
      return Promise.reject(e);
    }
    const ck = id + '|' + keyTagOf(key);
    const hit = assetUrlCache.get(ck);
    if (hit && Date.now() - hit.ts < (hit.ttl || ASSET_URL_TTL)) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const url = assetStore.base + String(assetStore.retrieve).replace('{id}', encodeURIComponent(id));
      const up = upRequest(url, { headers: { authorization: 'Bearer ' + key } }, ur => {
        let b = '';
        ur.on('error', reject);
        ur.on('data', c => {
          b += c;
          if (b.length > 1048576) { ur.destroy(); reject(new Error('资产信息响应超过 1 MiB，已中止')); }
        });
        ur.on('end', () => {
          let d = null;
          try { d = JSON.parse(b); } catch {}
          let urlOut = '';
          for (const f of assetStore.urlFields) {
            urlOut = pickPath(d, f);
            if (typeof urlOut === 'string' && urlOut) break;
          }
          if (!urlOut) {
            let msg = '资产 ' + id + ' 没有可用下载链接';
            if (ur.statusCode === 404) msg = '资产 ' + id + ' 不存在（上游 404）';
            else if (ur.statusCode === 401 || ur.statusCode === 403) msg = '读资产信息被拒 HTTP ' + ur.statusCode + '（密钥不被接受，检查设置里的 API Key）';
            else if (ur.statusCode >= 400) msg = '读资产信息失败 HTTP ' + ur.statusCode;
            const e = new Error(msg);
            e.status = ur.statusCode >= 400 ? ur.statusCode : 502;
            reject(e);
            return;
          }
          if (cacheSweep) cacheSweep(assetUrlCache, 500);
          const info = { ts: Date.now(), ttl: ASSET_URL_TTL, url: urlOut, mime: pickPath(d, assetStore.mimeField) || '' };
          assetUrlCache.set(ck, info);
          resolve(info);
        });
      });
      up.on('error', reject);
      up.end();
    });
  }
  async function resolveSrc(src, reqKey) {
    const s = String(src || '');
    if (/^https?:\/\//i.test(s)) {
      try { return await guardOutboundUrl(s); }
      catch (e) { throw new Error('素材地址不允许：' + e.message + '（' + s.slice(0, 100) + '）'); }
    }
    const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(s);
    if (m) {
      if (localAssetFile(m[1])) return `http://127.0.0.1:${PORT}/asset/${m[1]}`;
      const key = reqKey || (assetStore ? keyOf(assetStore.keyEnv) : '');
      const info = await assetInfoOf(m[1], key);
      return info.url;
    }
    const gv = /^(?:\/getv|\/fetch)\?url=([^&]+)/i.exec(s);
    if (gv) {
      const inner = safeDecode(gv[1]);
      if (/^https?:\/\//i.test(inner)) {
        try { return await guardOutboundUrl(inner); }
        catch (e) { throw new Error('素材地址不允许：' + e.message + '（' + inner.slice(0, 100) + '）'); }
      }
      throw new Error('素材地址不允许：/getv 里必须包公网 https 地址（' + s.slice(0, 100) + '）');
    }
    if (/^\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')
      && /\.(html|js|css|png|jpe?g|webp|gif|svg|ico|mp4|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(s)
      && !/^\/(proxy\.(js|log|out\.log)|package(-lock)?\.json|启动\.bat)$/i.test(s)) {
      return `http://127.0.0.1:${PORT}${s}`;
    }
    throw new Error('素材路径只能是 /asset/<id>、/getv?url=<公网地址> 或本机静态文件：' + s.slice(0, 100));
  }
  function internalFetchHeaders(url) {
    try {
      const u = new URL(url);
      const own = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || 80) === PORT;
      return own ? { Cookie: SESSION_COOKIE + '=' + SESSION_TOKEN } : undefined;
    } catch (e) { return undefined; }
  }
  async function downloadTo(url, dest, hops) {
    const depth = hops || 0;
    if (depth > 4) throw new Error('素材下载重定向次数过多（已中止）');
    let r;
    try {
      r = await new Promise((resolve, reject) => {
        const up = anyRequest(url, { method: 'GET', headers: internalFetchHeaders(url) }, resolve);
        up.on('error', reject);
        up.end();
      });
    } catch (e) {
      throw new Error('素材下载失败：' + (e && e.message ? e.message : '无法连接'));
    }
    if ([301, 302, 303, 307, 308].includes(r.statusCode)) {
      try { r.resume(); } catch {}
      const loc = r.headers.location;
      if (!loc) throw new Error('素材下载失败：重定向没有给出地址');
      let next = '';
      try { next = new URL(loc, url).toString(); } catch { throw new Error('素材下载失败：重定向地址非法'); }
      if (/^https?:\/\//i.test(next)) {
        try { next = await guardOutboundUrl(next); }
        catch (e) { throw new Error('素材重定向目标不允许：' + e.message); }
      }
      return downloadTo(next, dest, depth + 1);
    }
    if (r.statusCode < 200 || r.statusCode >= 300) {
      try { r.resume(); } catch {}
      throw new Error('素材下载失败 HTTP ' + r.statusCode);
    }
    const len = Number(r.headers['content-length'] || 0);
    if (len && len > DOWNLOAD_MAX) { try { r.destroy(); } catch {}; throw new Error('素材超过 ' + Math.round(DOWNLOAD_MAX / 1073741824) + ' GiB，已拒绝下载'); }
    const src = r;
    let size = 0;
    await new Promise((resolve, reject) => {
      let done = false;
      const out = fs.createWriteStream(dest);
      const finDl = err => {
        if (done) return;
        done = true;
        try { out.destroy(); } catch {}
        try { src.destroy(); } catch {}
        err ? reject(err) : resolve();
      };
      src.on('data', c => {
        size += c.length;
        if (size > DOWNLOAD_MAX) finDl(new Error('素材超过 ' + Math.round(DOWNLOAD_MAX / 1073741824) + ' GiB，已中止下载'));
      });
      src.on('error', e => finDl(new Error('素材下载中断：' + e.message)));
      out.on('error', e => finDl(new Error('素材写入失败：' + e.message)));
      out.on('finish', () => finDl(null));
      src.pipe(out);
    });
    if (!size) throw new Error('素材为空');
    return size;
  }

  return { assetUrlCache, assetInfoOf, resolveSrc, downloadTo };
}

module.exports = { createMediaSrc, DOWNLOAD_MAX };
