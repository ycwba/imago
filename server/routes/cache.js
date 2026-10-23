/* 缩略图 / 切片帧的代理端持久层（GET / PUT / DELETE /cache/{thumbs,slices}?key=…）。
   与浏览器 origin 无关：换端口、换浏览器、无痕窗口都只有这一份（旧 origin 的 IndexedDB
   缓存不再读、不迁移 —— 缓存不是用户产物，回灌只增加失败面）。
   键来自 Wb.thumbs.keyOf / sliceKey，可能含 `/` `?` `:` 与中文 → 走查询参数（encodeURIComponent），
   不塞进路径段（`/:key` 会被 `/` 截断）。落盘文件名用 sha1(key)，原键记在旁路索引里供 LRU。
   字节原样存（不存 base64）：PUT 主体是原始字节，GET 以 Content-Type + Cache-Control: no-store 回。
   容量闸与前端同口径：thumbs 3000 条 / 64MB；slices 3000 张 / 40MB —— 只搬一份，不许两端各存一份。
   不进整包备份（丢了能重建）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendJson, fail } = require('./http');

const TABLES = {
  thumbs: { max: 3000, bytes: 64 * 1024 * 1024, label: '缩略图' },
  slices: { max: 3000, bytes: 40 * 1024 * 1024, label: '切片帧' },
};

function createCacheRoutes(ctx) {
  const { readBody, log, dataDirPath } = ctx;
  const root = () => path.join(dataDirPath(), 'cache');

  const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
  const dirOf = t => path.join(root(), t);
  const idxPath = t => path.join(dirOf(t), '__index.json');

  function readIndex(t) {
    try {
      const v = JSON.parse(fs.readFileSync(idxPath(t), 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function writeIndex(t, idx) {
    fs.mkdirSync(dirOf(t), { recursive: true });
    fs.writeFileSync(idxPath(t), JSON.stringify(idx));
  }
  function totals(idx) {
    let n = 0, bytes = 0;
    for (const e of idx) { n += 1; bytes += e.bytes || 0; }
    return { n, bytes };
  }
  /* LRU：从最久没碰过的开始删，刚写的这条排在最后不会当场被删。 */
  function prune(t, idx) {
    const conf = TABLES[t];
    let { n, bytes } = totals(idx);
    const dead = [];
    const ordered = idx.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const e of ordered) {
      if (n <= conf.max && bytes <= conf.bytes) break;
      dead.push(e);
      n -= 1; bytes -= e.bytes || 0;
    }
    if (!dead.length) return idx;
    dead.forEach(e => { try { fs.unlinkSync(path.join(dirOf(t), e.id + '.bin')); } catch (err) { /* 已经没了 */ } });
    const keep = idx.filter(e => !dead.includes(e));
    writeIndex(t, keep);
    return keep;
  }

  function contentTypeOf(t, key) {
    /* 缩略图存的是 JPEG 字节；切片帧也是 JPEG/WEBP 一类的图片字节 —— 用 image/jpeg 兜底，
       前端拿回去自己转 dataURL / Blob，类型只影响 <img> 直接用时的解码。 */
    if (/\.png\b/i.test(key)) return 'image/png';
    if (/\.webp\b/i.test(key)) return 'image/webp';
    return 'image/jpeg';
  }

  async function handleCache(req, res, urlObj) {
    const m = /^\/cache\/(thumbs|slices)\/?$/.exec(urlObj.pathname || '');
    if (!m) return false;
    const t = m[1];
    const key = urlObj.searchParams.get('key') || '';

    if (req.method === 'GET') {
      if (!key) {
        /* 不带 key = 整表拉回（前端 hydrate 暖启动用；表有 3000 条 / 64MB 上限兜着） */
        const idx = readIndex(t);
        const items = [];
        idx.forEach(e => {
          try {
            const buf = fs.readFileSync(path.join(dirOf(t), e.id + '.bin'));
            items.push({ k: e.key, v: buf.toString('utf8'), ts: e.at || 0 });
          } catch (err) { /* 文件不在了：跳过这一条 */ }
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ items }));
        return true;
      }
      const idx = readIndex(t);
      const e = idx.find(x => x.key === key);
      if (!e) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return true; }
      const fp = path.join(dirOf(t), e.id + '.bin');
      if (!fs.existsSync(fp)) {
        /* 索引说有、文件没了：把这条从索引里摘掉，回 404（不假装还在） */
        writeIndex(t, idx.filter(x => x !== e));
        res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end();
        return true;
      }
      const buf = fs.readFileSync(fp);
      /* 命中就刷新 at（LRU 认「读过」） */
      e.at = Date.now();
      writeIndex(t, idx);
      res.writeHead(200, {
        'Content-Type': e.type || contentTypeOf(t, key),
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      });
      res.end(buf);
      return true;
    }

    if (req.method === 'PUT') {
      if (!key) return fail(res, 400, '缺 key 查询参数');
      const body = await readBody(req, res, 32 * 1024 * 1024);
      if (!body || !body.length) return fail(res, 400, '空字节');
      fs.mkdirSync(dirOf(t), { recursive: true });
      const id = sha1(key);
      fs.writeFileSync(path.join(dirOf(t), id + '.bin'), body);
      let idx = readIndex(t).filter(x => x.key !== key && x.id !== id);
      idx.push({ key, id, bytes: body.length, at: Date.now(), type: contentTypeOf(t, key) });
      idx = prune(t, idx);
      writeIndex(t, idx);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'DELETE') {
      if (!key) {
        /* 不带 key = 清空整张表（设置页那颗「清空导演台切片缓存」用这个） */
        const idx = readIndex(t);
        const removed = idx.length;
        idx.forEach(e => { try { fs.unlinkSync(path.join(dirOf(t), e.id + '.bin')); } catch (err) { /* 已经没了 */ } });
        writeIndex(t, []);
        log && log('[cache] 清空 ' + t + '：' + removed + ' 条');
        sendJson(res, 200, { ok: true, removed });
        return true;
      }
      const idx = readIndex(t);
      const e = idx.find(x => x.key === key);
      if (!e) { sendJson(res, 200, { ok: true, removed: 0 }); return true; }
      try { fs.unlinkSync(path.join(dirOf(t), e.id + '.bin')); } catch (err) { /* 已经没了 */ }
      writeIndex(t, idx.filter(x => x !== e));
      sendJson(res, 200, { ok: true, removed: 1 });
      return true;
    }

    res.writeHead(405, { 'Allow': 'GET, PUT, DELETE' });
    res.end();
    return true;
  }

  return { handleCache };
}

module.exports = { createCacheRoutes };
