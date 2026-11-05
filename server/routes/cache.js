/* 缩略图 / 切片帧的代理端持久层（GET / PUT / DELETE /cache/{thumbs,slices}?key=…）。
   与浏览器 origin 无关：换端口、换浏览器、无痕窗口都只有这一份（旧 origin 的 IndexedDB
   缓存不再读、不迁移 —— 缓存不是用户产物，回灌只增加失败面）。
   键来自 Wb.thumbs.keyOf / sliceKey，可能含 `/` `?` `:` 与中文 → 走查询参数（encodeURIComponent），
   不塞进路径段（`/:key` 会被 `/` 截断）。落盘文件名用 sha1(key)，原键记在旁路索引里供 LRU。
   字节原样存（不存 base64）：PUT 主体是原始字节，GET 以 Content-Type + Cache-Control: no-store 回，
   并且用流发 —— 切片帧一条就是几 MB，同步读进内存等于把代理主线程按在那里几十毫秒。
   容量闸与前端同口径：thumbs 3000 条 / 64MB；slices 3000 张 / 40MB —— 只搬一份，不许两端各存一份。
   不进整包备份（丢了能重建）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendJson, fail, sendFileStream } = require('./http');

const TABLES = {
  thumbs: { max: 3000, bytes: 64 * 1024 * 1024, label: '缩略图' },
  slices: { max: 3000, bytes: 40 * 1024 * 1024, label: '切片帧' },
};
/* 索引落盘的合并窗口：一张表的 PUT 隔多久没再来就写一趟盘。
   取这个量级是因为它两头都要躲开：比一次批量生成（几十条缩略图接连落地）短不了多少的窗口
   等于没合；拉到几秒又会让「硬杀进程」丢掉一整批索引 —— 缓存丢了能重建，但白重建一次
   的代价正好落在下一次开机首屏上。 */
const FLUSH_MS = 500;

function createCacheRoutes(ctx) {
  const { readBody, log, dataDirPath } = ctx;
  const root = () => path.join(dataDirPath(), 'cache');

  const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
  const dirOf = t => path.join(root(), t);
  const binOf = (t, id) => path.join(dirOf(t), id + '.bin');

  /* 索引在内存里驻一份。以前每一次缩略图 GET 都要「整份读盘 + JSON.parse + 改一个 at + 整份写回」，
     满表 3000 条那一份有几百 KB，而一次页面加载要发几十个这样的 GET —— 全在代理主线程上同步过，
     被挡住的每一毫秒里队列中别的请求都动不了。
     现在读命中只改内存里那一条的 at；落盘等到下一次真正的写（PUT / DELETE / 清表 / 摘掉失效条目），
     那时把整份表连着这些新 at 一起带上。进程重启后 LRU 退回「最后一次落盘时那一份」的顺序 ——
     缓存的淘汰次序不值得为它每次读都写一趟盘。
     按目录认档：探针实例换 DATA_DIR 时不会把上一份的内存当成眼前这张表。 */
  const mem = new Map();
  function tableState(t) {
    const dir = dirOf(t);
    let s = mem.get(t);
    if (s && s.dir === dir) return s;
    if (s && s.dirty) flushIndex(s).catch(() => {});      // 换 DATA_DIR：把上一张表的 pending 补掉再丢开它
    s = { dir, list: [], byKey: new Map(), queue: Promise.resolve(), dirty: false, timer: 0 };
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, '__index.json'), 'utf8'));
      if (Array.isArray(v)) {
        s.list = v.filter(e => e && typeof e.key === 'string' && typeof e.id === 'string');
        s.list.forEach(e => s.byKey.set(e.key, e));
      }
    } catch (e) { /* 没建过 / 读坏了：从空表开始，第一次写会把它盖出来 */ }
    mem.set(t, s);
    return s;
  }
  function useList(s, list) {
    s.list = list;
    s.byKey = new Map(list.map(e => [e.key, e]));
  }
  /* 落盘串行化：两次 PUT 并发时后取的快照必须后写进文件，否则索引退回前一份，
     刚存进去的那一条就变成「文件在、索引不认」。链条本身不带失败往后传（一次写坏了
     不能把这张表后续的落盘全堵死），失败只让当前这一次 await 到。 */
  function flushIndex(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    s.dirty = false;
    const snap = JSON.stringify(s.list);
    const dir = s.dir;
    const run = s.queue
      .then(() => fs.promises.mkdir(dir, { recursive: true }))
      .then(() => fs.promises.writeFile(path.join(dir, '__index.json'), snap));
    s.queue = run.catch(() => {});
    return run;
  }
  /* 索引落盘的两个口子：
     · flushIndex —— 当场落。删除那两路用它（「文件已经没了」这件事必须立刻让别人知道）。
     · markDirty —— 写后合并。PUT 用它：满表 3000 条那一份索引有 475KB，
       一次批量生成几十条缩略图连着 PUT，逐条 stringify + 整份重写既挡主线程（3000 条实测
       每次 1.3 毫秒）又把同一份字节往盘上摞几十遍；合并之后一趟批量只落一次。
       读的那一侧看的是 s.list / s.byKey（内存说了算），所以「刚 PUT 的那一条当场查得到」
       完全不依赖落盘 —— 这一点是这一路成立的前提，不是巧合。 */
  function markDirty(s) {
    s.dirty = true;
    if (s.timer) return;
    s.timer = setTimeout(() => { s.timer = 0; if (s.dirty) flushIndex(s).catch(() => {}); }, FLUSH_MS);
  }
  /* 把几张表 pending 的索引补上：退出路上（process.on('exit')）与判据各叫这一次。
     同步写：exit 回调里等不到 Promise。 */
  function flushPendingSync() {
    let written = 0;
    for (const s of mem.values()) {
      if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
      if (!s.dirty) continue;
      s.dirty = false;
      written++;
      try {
        fs.mkdirSync(s.dir, { recursive: true });
        fs.writeFileSync(path.join(s.dir, '__index.json'), JSON.stringify(s.list));
      } catch (e) { /* 退出路上写不进去就算了：那是缓存，下次开机能重建 */ }
    }
    return written;
  }
  /* 异步那一路给判据用：等的是真正落完盘，返回这次补写了几张表（没脏表就是 0）。 */
  function flushPending() {
    const dirty = [...mem.values()].filter(s => s.dirty);
    return Promise.all(dirty.map(s => flushIndex(s).catch(() => {}))).then(() => dirty.length);
  }
  /* 从表里摘掉一条并落盘：索引说有、文件没了，或者用户就是要删这一条。 */
  function drop(s, e) {
    useList(s, s.list.filter(x => x !== e));
    return flushIndex(s);
  }
  function totals(idx) {
    let n = 0, bytes = 0;
    for (const e of idx) { n += 1; bytes += e.bytes || 0; }
    return { n, bytes };
  }
  /* LRU：从最久没碰过的开始删，刚写的这条排在最后不会当场被删。
     只删字节、只回新表，落盘交给调用那一次的 persist（一次写请求一趟落盘，不在这里再写一遍）。 */
  async function prune(t, idx) {
    const conf = TABLES[t];
    const { n, bytes } = totals(idx);
    /* 没超闸就直接回去：以前这里每条 PUT 都先把整份表拷一份再排一遍，
       而「拷 + 排」只有在真要塞不进上限时才有意义（3000 条那档实测 0.05 毫秒，
       主要省的是每次 PUT 都新建一只三千元素的数组）。 */
    if (n <= conf.max && bytes <= conf.bytes) return idx;
    const dead = new Set();
    let left = n, used = bytes;
    for (const e of idx.slice().sort((a, b) => (a.at || 0) - (b.at || 0))) {
      if (left <= conf.max && used <= conf.bytes) break;
      dead.add(e);
      left -= 1; used -= e.bytes || 0;
    }
    if (!dead.size) return idx;
    for (const e of dead) { try { await fs.promises.unlink(binOf(t, e.id)); } catch (err) { /* 已经没了 */ } }
    return idx.filter(e => !dead.has(e));
  }

  function contentTypeOf(t, key) {
    /* 缩略图存的是 JPEG 字节；切片帧也是 JPEG/WEBP 一类的图片字节 —— 用 image/jpeg 兜底，
       前端拿回去自己转 dataURL / Blob，类型只影响 <img> 直接用时的解码。 */
    if (/\.png\b/i.test(key)) return 'image/png';
    if (/\.webp\b/i.test(key)) return 'image/webp';
    return 'image/jpeg';
  }
  function notFound(res) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  async function handleCache(req, res, urlObj) {
    const m = /^\/cache\/(thumbs|slices)\/?$/.exec(urlObj.pathname || '');
    if (!m) return false;
    const t = m[1];
    const key = urlObj.searchParams.get('key') || '';

    if (req.method === 'GET') {
      const s = tableState(t);
      if (!key) {
        /* 不带 key = 整表拉回（前端 hydrate 暖启动用；表有 3000 条 / 64MB 上限兜着）。
           逐条异步读、读一条写一条：满表这一份是几十 MB 的文本，攒成数组再一次 stringify 发出去
           会把主线程按住两百多毫秒，而这一次拉表正赶上开机 —— 页面在等字节，代理那边还有一排请求。 */
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        const writePart = c => new Promise(resolve => {
          if (res.write(c) === false) { res.once('drain', resolve); res.once('close', resolve); } else resolve();
        });
        await writePart('{"items":[');
        let first = true;
        for (const e of s.list) {
          if (res.destroyed) break;          // 客户端中途走了：剩下的文件不用再读
          let buf;
          try { buf = await fs.promises.readFile(binOf(t, e.id)); } catch (err) { continue; }
          await writePart((first ? '' : ',') + JSON.stringify({ k: e.key, v: buf.toString('utf8'), ts: e.at || 0 }));
          first = false;
        }
        await writePart(']}');
        res.end();
        return true;
      }
      const e = s.byKey.get(key);
      if (!e) return notFound(res);
      e.at = Date.now();                     // 读过就算最新（只改内存，见 tableState 那一段）
      try {
        await sendFileStream(res, binOf(t, e.id), {
          'Content-Type': e.type || contentTypeOf(t, key),
          'Cache-Control': 'no-store',
        });
      } catch (err) {
        if (!res.headersSent) {
          if (err && err.code === 'ENOENT') {
            /* 索引说有、文件没了：当场摘掉这一条再回 404（不假装还在 ——
               留着它每一帧都要白问一次，而它下一帧还是没字节）。 */
            await drop(s, e);
            return notFound(res);
          }
          throw err;
        }
        /* 头已经发出去了，状态码改不了：掐掉这一条连接，账上照实留一句。 */
        log && log('[cache] ' + t + ' 发到一半断了：' + ((err && err.code) || err));
      }
      return true;
    }

    if (req.method === 'PUT') {
      if (!key) return fail(res, 400, '缺 key 查询参数');
      const body = await readBody(req, res, 32 * 1024 * 1024);
      /* readBody 返回 null 的两种情况（超上限 413 / 连接中断 400）都由它自己答过了
         —— server/app.js 里那两条出口都先 writeHead 再 resolve(null)。所以这里只收口，
         再 fail 一次就是 ERR_HTTP_HEADERS_SENT。真正「传了零字节」才是这条路由要拒的。 */
      if (body == null) return true;
      if (!body.length) return fail(res, 400, '空字节');
      const s = tableState(t);
      const id = sha1(key);
      /* 写字节也走异步：切片帧一条几 MB，writeFileSync 那几十毫秒同样挡着主线程 */
      await fs.promises.mkdir(dirOf(t), { recursive: true });
      await fs.promises.writeFile(binOf(t, id), body);
      const keep = s.list.filter(x => x.key !== key && x.id !== id);
      keep.push({ key, id, bytes: body.length, at: Date.now(), type: contentTypeOf(t, key) });
      useList(s, await prune(t, keep));
      markDirty(s);                      // 索引写后合并；字节已经落盘，读这一条走内存不用等它
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'DELETE') {
      if (!key) {
        /* 不带 key = 清空整张表（设置页那颗「清空导演台切片缓存」用这个）。
           整目录一次删掉、再落一份空索引：三千个文件逐个 unlink 要排三千趟队，
           而删完之后盘上留下的东西与逐个删一模一样。 */
        const s = tableState(t);
        const removed = s.list.length;
        try { await fs.promises.rm(s.dir, { recursive: true, force: true }); } catch (e) { /* 目录本来就没建过 */ }
        useList(s, []);
        await flushIndex(s);
        log && log('[cache] 清空 ' + t + '：' + removed + ' 条');
        sendJson(res, 200, { ok: true, removed });
        return true;
      }
      const s = tableState(t);
      const e = s.byKey.get(key);
      if (!e) { sendJson(res, 200, { ok: true, removed: 0 }); return true; }
      try { await fs.promises.unlink(binOf(t, e.id)); } catch (err) { /* 已经没了 */ }
      await drop(s, e);
      sendJson(res, 200, { ok: true, removed: 1 });
      return true;
    }

    res.writeHead(405, { 'Allow': 'GET, PUT, DELETE' });
    res.end();
    return true;
  }

  return { handleCache, flushPendingSync, flushPending };
}

module.exports = { createCacheRoutes };
