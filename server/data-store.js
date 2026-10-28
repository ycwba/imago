/* 本地数据落盘（/data）与覆盖前的备份。
   浏览器存储随时可能被清掉，业务数据同时写一份到项目目录的 .data/ 下：普通 JSON 文件，
   看得见、能备份、能被云盘同步。键名只允许 [A-Za-z0-9_-]，杜绝路径穿越。
     GET    /data          清单 [{ key, size, mtime }]（客户端据此判断谁更新）
     GET    /data/<key>    该键的内容
     PUT    /data/<key>    原子写入（先写 .tmp 再 rename，写一半断电也不会留下半个文件）
     DELETE /data/<key>    删除（默认先留 <key>.bak.json；?nobak=1 只给一次性清死键用）
   这里只认 /data；/cloud 仍在 app 里，读的是同一组导出。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fs-atomic.js');

const DATA_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BAK_KEEP_MS = 10 * 60 * 1000;
/* 「这份东西本来就不存在」的那两个码：除此之外读失败都不能当作不存在。 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const absent = e => Boolean(e && ABSENT_CODES.has(e.code));
const why = e => ((e && e.code) || '') + ' ' + ((e && e.message) || e);

function createDataStore(opts) {
  const root = opts.root;
  const log = opts.log || (() => {});
  const readBody = opts.readBody;
  const safeDecode = opts.safeDecode || (s => { try { return decodeURIComponent(s); } catch { return String(s == null ? '' : s); } });

  const dataDirPath = () => path.resolve(root, process.env.DATA_DIR || '.data');
  const dataFileOf = key => path.join(dataDirPath(), key + '.json');

  /* 清单只在「目录 / 文件确实不存在」时才算空。权限、盘被占用、网络盘断开那一类读失败必须往上抛：
     客户端拿到空清单会判定「服务器什么都没有」，于是把本地那份全量补传，
     云端较新的数据就这样被旧内容顶掉 —— 回错误才能让它停手。 */
  function dataList() {
    const dir = dataDirPath();
    let names;
    try { names = fs.readdirSync(dir); }
    catch (e) {
      if (absent(e)) return [];
      throw new Error('读不出数据目录 ' + dir + '：' + why(e));
    }
    return names
      /* *.bak.json 是覆盖前的冲突备份：留在盘上供人工找回，但不参与清单/同步/云上传；
         点开头的（.cloud-baseline.json = 云同步基线）是代理自己的内部状态，同样不参与。 */
      .filter(f => f.endsWith('.json') && !f.endsWith('.bak.json') && !f.startsWith('.'))
      .map(f => {
        try {
          const st = fs.statSync(path.join(dir, f));
          return { key: f.slice(0, -5), size: st.size, mtime: st.mtimeMs };
        } catch (e) {
          /* 刚列出来的文件下一秒就被删掉是正常竞态，跳过就好；其余错误同上，不能当「没有」。 */
          if (absent(e)) return null;
          throw new Error('读不出数据文件 ' + f + ' 的状态：' + why(e));
        }
      }).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));
  }

  /* 覆盖 / 删除之前把旧内容留一份 <key>.bak.json（设置页「数据与备份」能列出并一键恢复）。
     一份备份至少留 BAK_KEEP_MS：连着几次误写不会把唯一那份好数据顶掉。 */
  function keepDataBackup(key, nextBuf) {
    if (/\.bak$/.test(key)) return true;                // 备份本身不再备份
    /* 备份失败要报出来：调用方据此中止写入。界面已经承诺「覆盖前会留一份」，
       备份没成还照样覆盖 = 无提示地丢掉用户配置与密钥。 */
    const cur = dataFileOf(key), bak = dataFileOf(key + '.bak');
    let old;
    try { old = fs.readFileSync(cur); }
    catch (e) {
      /* 旧文件不存在才叫「无需备份」；读不动（占用 / 权限）时继续覆盖就等于把那份丢掉。 */
      if (absent(e)) return true;
      throw new Error('覆盖前读不出旧内容 ' + key + '：' + why(e));
    }
    if (nextBuf && nextBuf.equals(old)) return true;    // 内容一模一样 → 没什么可备份的
    try {
      if (fs.existsSync(bak)) {
        if (Date.now() - fs.statSync(bak).mtimeMs < BAK_KEEP_MS) return true;
        if (fs.readFileSync(bak).equals(old)) return true;
      }
      fs.writeFileSync(bak, old);
      return true;
    } catch (e) {
      log('[data] 备份旧内容失败 ' + key + '：' + e.message);
      return false;
    }
  }

  function dataWriteRaw(key, buf) {
    fs.mkdirSync(dataDirPath(), { recursive: true });
    if (!keepDataBackup(key, buf)) throw new Error('覆盖前备份失败（磁盘满 / 文件被占用），已中止写入：' + key);
    const { fsyncWhy } = atomicWrite(dataFileOf(key), buf);
    if (fsyncWhy) log('[data] 落盘同步退化 ' + key + '：' + fsyncWhy);
  }

  function handleData(req, res, urlObj) {
    const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (dataPath === '/data' && req.method === 'GET') {
      /* degraded:true + 500：让客户端明确知道「这一轮没读到清单」，
         而不是把空清单当成「服务器上一片空白」去全量补传。 */
      let files;
      try { files = dataList(); } catch (e) {
        log('[data] ' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { message: e.message }, degraded: true, dir: dataDirPath(), files: [] }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ dir: dataDirPath(), files, degraded: false }));
      return true;
    }
    if (!req.url.startsWith('/data/')) return false;
    const key = safeDecode(req.url.slice('/data/'.length).split('?')[0]);
    if (!DATA_KEY_RE.test(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"非法的数据键名"}');
      return true;
    }
    const f = dataFileOf(key);
    if (req.method === 'GET') {
      if (!fs.existsSync(f)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"没有这份数据"}');
        return true;
      }
      /* 先读再写头：Windows 上文件可能正被另一个进程占着（EBUSY），
         读到一半才抛的话 200 头已经发出，客户端只会等到超时。 */
      let buf = null;
      try { buf = fs.readFileSync(f); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '读取数据文件失败：' + e.message } }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(buf);
      return true;
    }
    if (req.method === 'PUT') {
      /* 请求体就是客户端那份 localStorage 值，原样落盘：很多键存的是普通字符串，
         要求「必须是合法 JSON」会把这些全挡在 400。只拦空内容与 NUL。 */
      readBody(req, res, 32 * 1024 * 1024).then(buf => {
        if (buf == null) return;
        const text = buf.toString('utf8');
        if (!text.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '内容是空的' } }));
          return;
        }
        if (text.includes(String.fromCharCode(0))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '内容含 NUL 字节，拒绝写入' } }));
          return;
        }
        dataWriteRaw(key, buf);
        /* 写成功之后的 stat 只是回执里的两个数：杀软 / 同步盘占着刚写完的文件时
           statSync 会抛（EPERM/EBUSY），以前被下面那个 catch 当成「写入失败」回 500 ——
           数据其实已经在盘上了，客户端却会把这次保存当失败重试。 */
        let size = buf.length, mtime = Date.now();
        try { const st = fs.statSync(f); size = st.size; mtime = st.mtimeMs; } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, key, size, mtime }));
      }).catch(e => {
        /* 落盘失败（磁盘满 / 文件被占用 / 键名不合法）一定要回错误：
           以前没有 catch，响应永远不发，页面只能等到超时。 */
        log('[data] 写入失败 ' + key + '：' + e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '写入数据文件失败：' + e.message } }));
        } else try { res.end(); } catch {}
      });
      return true;
    }
    if (req.method === 'DELETE') {
      /* 删不掉必须回错误：客户端把「已删除」记进队列就不再重试，而服务器那份还在。 */
      /* `?nobak=1` 只给「一次性清死键」用（ui.js 的 sweepLegacyKeys）：
         走普通删除会给每个作废的键都留一份备份，备份清单里永远挂着用户认不出的键名。 */
      const q = req.url.split('?')[1] || '';
      const nobak = /(^|&)nobak=1(&|$)/.test(q);
      try {
        if (fs.existsSync(f)) {
          /* 备份没成就别删：删完服务器这份没了、本地那份还在被当成「已同步」，
             数据彻底找不回来，而下一次同步也发现不了。 */
          if (!nobak && !keepDataBackup(key)) throw new Error('删除前备份失败（磁盘满 / 文件被占用），已中止删除：' + key);
          fs.unlinkSync(f);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        log('[data] 删除失败：' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '删除数据文件失败：' + e.message } }));
      }
      return true;
    }
    return false;
  }

  return { DATA_KEY_RE, dataDirPath, dataFileOf, dataList, dataWriteRaw, handleData };
}

module.exports = { createDataStore, DATA_KEY_RE };
