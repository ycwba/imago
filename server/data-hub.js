/* 本机数据、备份与云同步的唯一落点。
   盘上只有两份文件：state.json（全部业务键）与 backup.json（轮转快照 + 覆盖范围）。
   /data/<key> 是 state 的逻辑视图：路径与语义不变，页面不必知道键住在同一份文件里。
   覆盖、删除、云端拉取、恢复之前统一向 backup.json 留一份快照，盘上不再有 <key>.bak.json。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDir } = require('./open-dir.js');
const userDirs = require('./user-dirs.js');
const { sendJson, fail } = require('./routes/http.js');

/* ============================================================================
   原子写原语
   ---------------------------------------------------------------------------
   tmp → fsync → rename（占用时退避重试）→ 再 fsync 目标。index-store 与资产库、
   FCPXML 媒体包、状态仓、快照仓共用这一份，别再各写一遍 .tmp + rename。
   ========================================================================== */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MAX = 3;
const RENAME_WAIT_MS = 20;
const FSYNC_UNSUPPORTED = new Set(['ENOSYS', 'EINVAL', 'EBADF', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 拿不到就立刻返回 */ }
}
function fsyncPath(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    fs.fsyncSync(fd);
    return { ok: true, why: '' };
  } catch (e) {
    const code = (e && e.code) || '';
    if (code && !FSYNC_UNSUPPORTED.has(code)) return { ok: false, why: code };
    return { ok: false, why: code || ((e && e.message) || String(e)) };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 关不上不影响已经落盘的内容 */ } }
  }
}
const tmpSuffix = () => '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
function renameWithRetry(from, to) {
  let wait = RENAME_WAIT_MS;
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (!e || !RETRYABLE.has(e.code) || i >= RENAME_RETRY_MAX) throw e;
      sleepSync(wait);
      wait *= 3;
    }
  }
}
function atomicWrite(file, data, opts) {
  const o = opts || {};
  const dir = o.dir || path.dirname(file);
  if (o.mkdir !== false) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + tmpSuffix();
  let fsyncWhy = '';
  try {
    fs.writeFileSync(tmp, data);
    const f1 = fsyncPath(tmp);
    if (!f1.ok) fsyncWhy = 'tmp: ' + f1.why;
    renameWithRetry(tmp, file);
    const f2 = fsyncPath(file);
    if (!f2.ok) fsyncWhy = (fsyncWhy ? fsyncWhy + ' / ' : '') + '目标: ' + f2.why;
    return { fsyncWhy };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件本来就没了 */ }
    throw e;
  }
}
/* 一份备份至少留 10 分钟：连着几次误写不会把唯一那份好数据顶掉。 */
const BAK_KEEP_MS = 10 * 60 * 1000;
const bakFileOf = file => String(file).replace(/\.json$/, '.bak.json');
const absentErr = e => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
function backupBeforeOverwrite(file, bakFile, nextBuf) {
  if (bakFile === file || /\.bak\.json$/i.test(file)) return true;
  let old;
  try { old = fs.readFileSync(file); }
  catch (e) {
    if (absentErr(e)) return true;
    throw new Error('覆盖前读不出旧内容 ' + file + '：' + ((e && e.code) || (e && e.message) || e));
  }
  const next = nextBuf == null ? null : (Buffer.isBuffer(nextBuf) ? nextBuf : Buffer.from(String(nextBuf)));
  if (next && next.equals(old)) return true;
  try {
    if (fs.existsSync(bakFile)) {
      if (Date.now() - fs.statSync(bakFile).mtimeMs < BAK_KEEP_MS) return true;
      if (fs.readFileSync(bakFile).equals(old)) return true;
    }
    atomicWrite(bakFile, old);
    return true;
  } catch (e) {
    throw new Error('备份没成，已中止覆盖（磁盘满 / 文件被占用）：' + file
      + '（' + ((e && e.code) || (e && e.message) || e) + '）');
  }
}
function writeJsonWithBak(file, obj, opts) {
  const body = JSON.stringify(obj, null, 2);
  backupBeforeOverwrite(file, bakFileOf(file), body);
  return atomicWrite(file, body, opts);
}

/* ============================================================================
   状态仓：state.json
   ---------------------------------------------------------------------------
   keys 的 body 是客户端原样发来的文本（很多键存普通字符串，不是 JSON）。
   checksum 覆盖全部键的内容；读出来对不上就拒绝任何写入，等人工从快照恢复。
   每次写都是「改内存表 → 整包原子重写」：Node 单线程里这段没有 await，
   两个请求不会各拿一份旧表互相覆盖，因此不需要额外的异步写队列。
   ========================================================================== */
const DATA_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATE_VERSION = 2;
const BACKUP_VERSION = 2;
const INTERNAL_PREFIX = '__';
const CLOUD_STATE_KEY = '__cloud_state';
const CLOUD_BASE_KEY = '__cloud_baseline';
const LEGACY_INTERNAL = { '.cloud-state.json': CLOUD_STATE_KEY, '.cloud-baseline.json': CLOUD_BASE_KEY };
/* 代理自己的运行态，不属于业务键，迁移时不收、不删。 */
const KEEP_FILES = new Set(['.cap-cache.json', '.session', '.proxy.lock']);
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const absent = e => Boolean(e && ABSENT_CODES.has(e.code));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const emptyState = () => ({ version: STATE_VERSION, updatedAt: Date.now(), checksum: '', keys: {} });
const checksumOf = keys => sha256(JSON.stringify(Object.keys(keys).sort().map(k => [k, keys[k].body])));

function createStateStore(opts) {
  const root = opts.root;
  const log = opts.log || (() => {});
  const readBody = opts.readBody;
  const safeDecode = opts.safeDecode || (s => { try { return decodeURIComponent(s); } catch { return String(s == null ? '' : s); } });
  const dataDirPath = () => path.resolve(root, process.env.DATA_DIR || '.data');
  const statePath = () => path.join(dataDirPath(), 'state.json');
  let state = null;
  let degraded = '';
  let fsyncDegraded = '';
  let snapshotHook = null;
  let snapshotsPaused = false;
  let migrationLegacy = null;

  function load() {
    if (state) return state;
    let raw;
    try { raw = fs.readFileSync(statePath(), 'utf8'); }
    catch (e) {
      if (absent(e)) { migrate(); return state; }
      degraded = '读不出 state.json：' + e.message;
      state = emptyState();
      return state;
    }
    let v = null;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (!v || v.version !== STATE_VERSION || !v.keys || typeof v.keys !== 'object'
      || typeof v.checksum !== 'string' || checksumOf(v.keys) !== v.checksum) {
      degraded = 'state.json 校验不通过（内容坏了或版本不对）：已拒绝写入，先到「数据与备份」从快照恢复';
      log('[data] ' + degraded);
      state = emptyState();
      return state;
    }
    state = v;
    return state;
  }
  function persist() {
    if (degraded) throw new Error(degraded);
    const next = { version: STATE_VERSION, updatedAt: Date.now(), checksum: checksumOf(state.keys), keys: state.keys };
    const { fsyncWhy } = atomicWrite(statePath(), JSON.stringify(next));
    state = next;
    if (fsyncWhy) { fsyncDegraded = fsyncWhy; log('[data] state.json 落盘同步退化：' + fsyncWhy); }
    return next;
  }
  function readKey(key) {
    const s = load();
    const hit = s.keys[String(key)];
    return hit ? hit.body : null;
  }
  function dataList() {
    const s = load();
    return Object.entries(s.keys)
      .filter(([k]) => !k.startsWith(INTERNAL_PREFIX) && !k.endsWith('.bak'))
      .map(([k, v]) => ({ key: k, size: v.size, mtime: v.mtime }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  /* 虚拟路径只用来给读盘口径报位置：state 里没有单个文件，调用方一律走 readKey。 */
  const dataFileOf = key => path.join(dataDirPath(), String(key) + '.json');
  const dataWriteRaw = (key, buf) => writeKey(key, buf);
  function noteSnapshot(reason, extra) {
    if (snapshotsPaused || !snapshotHook) return;
    try { snapshotHook(reason, extra || {}); }
    catch (e) { throw new Error('覆盖前留快照失败，已中止写入：' + e.message); }
  }
  function writeKey(key, buf) {
    const k = String(key);
    if (!DATA_KEY_RE.test(k)) throw new Error('非法的数据键名：' + k);
    const s = load();
    if (degraded) throw new Error(degraded);
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (!text.length) throw new Error('内容是空的');
    if (text.includes(String.fromCharCode(0))) throw new Error('内容含 NUL 字节，拒绝写入');
    const old = s.keys[k];
    if (!old || old.body !== text) noteSnapshot('before-overwrite', { key: k });
    s.keys[k] = { body: text, size: Buffer.byteLength(text), mtime: Date.now() };
    persist();
    return { key: k, size: s.keys[k].size, mtime: s.keys[k].mtime };
  }
  function deleteKey(key, noBak) {
    const k = String(key);
    if (!DATA_KEY_RE.test(k)) throw new Error('非法的数据键名：' + k);
    const s = load();
    if (degraded) throw new Error(degraded);
    if (!s.keys[k]) return false;
    if (!noBak) noteSnapshot('before-delete', { key: k });
    delete s.keys[k];
    persist();
    return true;
  }
  function restoreKeys(next, only) {
    const s = load();
    if (degraded) throw new Error(degraded);
    const keys = { ...s.keys };
    let written = 0;
    for (const [k, v] of Object.entries(next || {})) {
      if (!DATA_KEY_RE.test(k)) continue;
      if (only && !only.includes(k)) continue;
      const body = String(v && v.body != null ? v.body : v);
      keys[k] = { body, size: Buffer.byteLength(body), mtime: Date.now() };
      written++;
    }
    state = { version: STATE_VERSION, updatedAt: Date.now(), checksum: checksumOf(keys), keys };
    const { fsyncWhy } = atomicWrite(statePath(), JSON.stringify(state));
    if (fsyncWhy) { fsyncDegraded = fsyncWhy; log('[data] 恢复落盘同步退化：' + fsyncWhy); }
    return written;
  }
  /* ---------- 一次性搬迁：旧的一堆 <key>.json / .bak.json 合成 state.json ----------
     顺序不能变：先把新文件写齐并回读逐键校验，再把旧文件挪进暂存目录，
     最后才真删。任一步失败都把旧字节留在盘上，绝不留下「新文件半写、旧文件已删」。 */
  function migrate() {
    const dir = dataDirPath();
    let names;
    try { names = fs.readdirSync(dir); }
    catch (e) {
      if (absent(e)) { state = emptyState(); persist(); return; }
      throw new Error('读不出数据目录 ' + dir + '：' + e.message);
    }
    const keys = {};
    const legacyBaks = {};
    const toMove = [];
    for (const f of names) {
      if (!f.endsWith('.json') || KEEP_FILES.has(f) || f === 'state.json' || f === 'backup.json') continue;
      const full = path.join(dir, f);
      let body;
      try { body = fs.readFileSync(full, 'utf8'); }
      catch (e) { throw new Error('迁移读不出 ' + f + '：' + e.message); }
      let st = null;
      try { st = fs.statSync(full); } catch { /* 文件刚好被删：用当前时间兜底 */ }
      if (f.endsWith('.bak.json')) { legacyBaks[f] = body; toMove.push(f); continue; }
      const rawKey = LEGACY_INTERNAL[f] || f.slice(0, -5);
      if (!DATA_KEY_RE.test(rawKey)) continue;
      keys[rawKey] = { body, size: Buffer.byteLength(body), mtime: st ? st.mtimeMs : Date.now() };
      toMove.push(f);
    }
    state = { version: STATE_VERSION, updatedAt: Date.now(), checksum: checksumOf(keys), keys };
    atomicWrite(statePath(), JSON.stringify(state));
    let back;
    try { back = JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
    catch (e) { throw new Error('迁移回读 state.json 失败：' + e.message); }
    if (back.checksum !== state.checksum || Object.keys(back.keys || {}).length !== Object.keys(keys).length) {
      throw new Error('迁移回读校验不通过：键数或校验和对不上，旧文件一个都没动');
    }
    for (const k of Object.keys(keys)) {
      if (!back.keys[k] || back.keys[k].body !== keys[k].body) {
        throw new Error('迁移回读校验不通过：' + k + ' 内容不一致，旧文件一个都没动');
      }
    }
    const staging = path.join(dir, '.migration-' + Date.now());
    fs.mkdirSync(staging, { recursive: true });
    for (const f of toMove) renameWithRetry(path.join(dir, f), path.join(staging, f));
    for (const f of toMove) {
      try { fs.unlinkSync(path.join(staging, f)); }
      catch (e) { throw new Error('迁移暂存目录里的 ' + f + ' 删不掉（' + e.message + '），请手动清理 ' + staging); }
    }
    try { fs.rmdirSync(staging); } catch { /* 空目录留着不影响数据 */ }
    migrationLegacy = { keys: Object.keys(legacyBaks).length, baks: legacyBaks, migrated: Object.keys(keys).length };
    log('[data] 已把 ' + Object.keys(keys).length + ' 份旧数据键与 ' + Object.keys(legacyBaks).length
      + ' 份旧备份合成 state.json，旧文件已删除');
  }

  function handleData(req, res, urlObj) {
    const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (dataPath === '/data' && req.method === 'GET') {
      let files;
      try { files = dataList(); }
      catch (e) {
        log('[data] ' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { message: e.message }, degraded: true, dir: dataDirPath(), files: [] }));
        return true;
      }
      if (degraded) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { message: degraded }, degraded: true, dir: dataDirPath(), files: [] }));
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
    if (req.method === 'GET') {
      const body = readKey(key);
      if (body == null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"没有这份数据"}');
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
    if (req.method === 'PUT') {
      readBody(req, res, 32 * 1024 * 1024).then(buf => {
        if (buf == null) return;
        try {
          const r = writeKey(key, buf);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, size: r.size, mtime: r.mtime }));
        } catch (e) {
          log('[data] 写入失败 ' + key + '：' + e.message);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '写入数据文件失败：' + e.message } }));
          } else try { res.end(); } catch {}
        }
      }).catch(e => {
        log('[data] 读请求体失败 ' + key + '：' + e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '读取数据文件失败：' + e.message } }));
        } else try { res.end(); } catch {}
      });
      return true;
    }
    if (req.method === 'DELETE') {
      const q = req.url.split('?')[1] || '';
      const nobak = /(^|&)nobak=1(&|$)/.test(q);
      try {
        deleteKey(key, nobak);
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

  load();
  return {
    dataDirPath, dataFileOf, dataList, dataWriteRaw, readKey, writeKey, deleteKey, restoreKeys,
    handleData, statePath,
    get state() { return load(); },
    get degraded() { return degraded; },
    get fsyncDegraded() { return fsyncDegraded; },
    /* 迁移回执要能被「健康提示」反复读到：以前读一次就清，status 永远看不见它。
       开机快照用不用它由 createDataHub 自己在装配时决定，不靠读取即清空来防重复。 */
    get migrationLegacy() { return migrationLegacy; },
    setSnapshotHook(fn) { snapshotHook = fn; },
    pauseSnapshots(fn) { snapshotsPaused = true; try { return fn(); } finally { snapshotsPaused = false; } },
    CLOUD_STATE_KEY, CLOUD_BASE_KEY,
  };
}

/* ============================================================================
   备份中心：backup.json
   ---------------------------------------------------------------------------
   一份快照 = 当时全部业务键 + 本机资产索引 + 提示词归档正文 + 云同步状态与基线。
   轮转 5 份；同内容不新增；自动类快照 10 分钟内最多一份；恢复 / 手动 / 迁移强制留。
   快照带 sha256，恢复前重算一遍；对不上就拒绝恢复，不把半份数据写进本机。
   ========================================================================== */
const MAX_SNAPSHOTS = 5;
/* 这些是「撤销点」而不是普通的自动快照：10 分钟去重会把删除前那一刻的状态吃掉，
   恢复回去就找不回刚删的键（或刚被云端覆盖的值），所以一律强制新增。
   只有逐字输入那类 before-overwrite 才走下面的 10 分钟窗口。 */
const FORCED_SNAPSHOT_REASONS = new Set([
  'manual', 'migration', 'before-restore', 'before-delete',
  'before-cloud', 'before-cloud-pull', 'before-cloud-delete',
]);
const PROMPT_PACK_MAX_FILES = 20000, PROMPT_PACK_MAX_BYTES = 64 * 1024 * 1024;
const AUTO_INTERVAL_MS = 30 * 60 * 1000;

function createBackupStore(opts) {
  const log = opts.log || (() => {});
  const stateStore = opts.stateStore;
  const prompts = opts.prompts;
  const dataDirPath = stateStore.dataDirPath;
  const file = () => path.join(dataDirPath(), 'backup.json');
  let cache = null;
  let degraded = '';
  let lastAutoAt = 0;

  function load() {
    if (cache) return cache;
    let raw;
    try { raw = fs.readFileSync(file(), 'utf8'); }
    catch (e) {
      if (absent(e)) { cache = { version: BACKUP_VERSION, snapshots: [] }; return cache; }
      degraded = '读不出 backup.json：' + e.message;
      cache = { version: BACKUP_VERSION, snapshots: [] };
      return cache;
    }
    let v = null;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (!v || v.version !== BACKUP_VERSION || !Array.isArray(v.snapshots)) {
      degraded = 'backup.json 内容坏了或版本不对：已停止自动备份，先手动建一份';
      log('[backup] ' + degraded);
      cache = { version: BACKUP_VERSION, snapshots: [] };
      return cache;
    }
    cache = v;
    return cache;
  }
  function persist() {
    if (degraded) throw new Error(degraded);
    const { fsyncWhy } = atomicWrite(file(), JSON.stringify(cache));
    if (fsyncWhy) log('[backup] 落盘同步退化：' + fsyncWhy);
  }
  /* 名字带语义：合并进来的几个模块里本来就有 collect / find / status / reply 这些通用短名，
     同一个大文件里撞上别处的同名定义会被「重复实现」判据当成新长出第二份。 */
  function collectSnapshotBody(extra) {
    const keys = stateStore.state.keys;
    const state = {};
    for (const k of Object.keys(keys).sort()) state[k] = { body: keys[k].body, size: keys[k].size, mtime: keys[k].mtime };
    let assetsIndex = null;
    try { assetsIndex = fs.readFileSync(path.join(dataDirPath(), 'local-assets', 'index.json'), 'utf8'); }
    catch { /* 还没建过资产索引：不是错误 */ }
    const promptPack = { files: [], skipped: 0, bytes: 0 };
    try {
      const dir = prompts.promptsDefaultDir();
      for (const f of prompts.promptFileList(dir)) {
        if (promptPack.files.length >= PROMPT_PACK_MAX_FILES || promptPack.bytes >= PROMPT_PACK_MAX_BYTES) { promptPack.skipped++; continue; }
        try {
          const text = fs.readFileSync(path.join(dir, f.name), 'utf8');
          promptPack.files.push({ name: f.name, text });
          promptPack.bytes += text.length;
        } catch { promptPack.skipped++; }
      }
    } catch { /* 归档目录还没建：不是错误 */ }
    return {
      state, assetsIndex, prompts: promptPack,
      cloud: { state: stateStore.readKey(CLOUD_STATE_KEY), baseline: stateStore.readKey(CLOUD_BASE_KEY) },
      legacyBaks: (extra && extra.legacyBaks) || null,
      key: (extra && extra.key) || '',
    };
  }
  const checksumOfSnapshot = body => sha256(JSON.stringify(body));
  function createSnapshot(reason, extra) {
    const c = load();
    if (degraded) throw new Error(degraded);
    const force = !!(extra && extra.force) || FORCED_SNAPSHOT_REASONS.has(String(reason));
    const body = collectSnapshotBody(extra);
    const checksum = checksumOfSnapshot(body);
    const latest = c.snapshots[0];
    if (latest && latest.checksum === checksum && !force) return { created: false, id: latest.id, why: '内容没变' };
    if (!force && latest && Date.now() - latest.ts < BAK_KEEP_MS && String(latest.reason).startsWith('before-')) {
      return { created: false, id: latest.id, why: '10 分钟内已有一份' };
    }
    const snap = {
      id: 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      ts: Date.now(), reason: String(reason || 'auto'), checksum, body,
    };
    c.snapshots.unshift(snap);
    if (c.snapshots.length > MAX_SNAPSHOTS) c.snapshots.length = MAX_SNAPSHOTS;
    persist();
    lastAutoAt = Date.now();
    log('[backup] 已留快照 ' + snap.id + '（' + snap.reason + '，' + Object.keys(body.state).length + ' 个键）');
    return { created: true, id: snap.id, ts: snap.ts, reason: snap.reason, keys: Object.keys(body.state).length };
  }
  function maybeAuto(reason) {
    try { return createSnapshot(reason || 'auto', { key: '' }); }
    catch (e) { log('[backup] 自动备份失败：' + e.message); return { created: false, error: e.message }; }
  }
  function verify() {
    const c = load();
    const bad = [];
    for (const s of c.snapshots) {
      if (!s || !s.body || s.checksum !== checksumOfSnapshot(s.body)) bad.push(s && s.id);
    }
    return { ok: bad.length === 0, bad, count: c.snapshots.length, degraded };
  }
  function list() {
    return load().snapshots.map(s => ({
      id: s.id, ts: s.ts, reason: s.reason, checksum: s.checksum,
      keys: Object.keys((s.body && s.body.state) || {}).length,
      prompts: ((s.body && s.body.prompts && s.body.prompts.files) || []).length,
      assetsIndex: !!(s.body && s.body.assetsIndex),
    }));
  }
  function snapshotById(id) {
    const c = load();
    if (!id) return c.snapshots[0] || null;
    return c.snapshots.find(s => s.id === String(id)) || null;
  }
  function preview(id) {
    const snap = snapshotById(id);
    if (!snap) throw new Error('没有这份快照');
    const v = verify();
    if (!v.ok) throw new Error('快照校验不通过，已拒绝恢复：' + v.bad.join('、'));
    const cur = stateStore.state.keys;
    const pack = snap.body.state || {};
    let overwrite = 0, add = 0, same = 0;
    for (const [k, val] of Object.entries(pack)) {
      if (!cur[k]) add++;
      else if (cur[k].body === val.body) same++;
      else overwrite++;
    }
    const kept = Object.keys(cur).filter(k => !Object.prototype.hasOwnProperty.call(pack, k)).length;
    return {
      id: snap.id, ts: snap.ts, reason: snap.reason, overwrite, add, same, kept,
      prompts: (snap.body.prompts && snap.body.prompts.files || []).length,
      assetsIndex: !!snap.body.assetsIndex,
      text: '快照 ' + snap.ts + '（' + snap.reason + '）：将覆盖 ' + overwrite + ' 项、补回 ' + add
        + ' 项、' + same + ' 项一致；不在快照里的当前数据 ' + kept + ' 项保留，不会被删；'
        + '提示词归档 ' + (snap.body.prompts && snap.body.prompts.files || []).length + ' 份（同名不覆盖）。',
    };
  }
  function restoreBody(body, wanted) {
    if (!body || typeof body !== 'object' || !body.state) throw new Error('备份内容里没有业务键');
    const next = {};
    for (const [k, val] of Object.entries(body.state)) {
      if (wanted && !wanted.includes(k)) continue;
      next[k] = val;
    }
    /* 恢复前那一份必须在写任何东西之前落盘，且强制新增；写回过程不再逐键留快照。 */
    createSnapshot('before-restore', { force: true });
    let written = 0, failed = 0, promptsRestored = 0, promptsDup = 0, promptsBad = 0, assetsOk = false;
    stateStore.pauseSnapshots(() => {
      try { written = stateStore.restoreKeys(next); }
      catch (e) { failed++; log('[backup] 恢复业务键失败：' + e.message); }
      const files = (body.prompts && body.prompts.files) || [];
      if (files.length && prompts.restorePromptFiles) {
        const r = prompts.restorePromptFiles(files);
        promptsRestored = r.restored; promptsDup = r.dup; promptsBad = r.bad;
        failed += promptsBad;
      }
      if (body.assetsIndex && opts.applyAssetsIndex) {
        try { opts.applyAssetsIndex(body.assetsIndex); assetsOk = true; }
        catch (e) { failed++; log('[backup] 恢复资产索引失败：' + e.message); }
      }
      if (body.cloud) {
        try {
          if (body.cloud.state) stateStore.writeKey(CLOUD_STATE_KEY, body.cloud.state);
          /* 基线作废：下次同步按现状重新判定，不拿旧指纹把刚恢复的数据又判成冲突。 */
          stateStore.writeKey(CLOUD_BASE_KEY, JSON.stringify({ ts: Date.now(), keys: {} }));
        } catch (e) { failed++; log('[backup] 恢复云同步状态失败：' + e.message); }
      }
    });
    return {
      ok: failed === 0, written, failed, promptsRestored, promptsDup, promptsBad, assetsIndex: assetsOk,
      message: '已从备份恢复 ' + written + ' 项业务键、归档 ' + promptsRestored + ' 份'
        + (promptsDup ? '（' + promptsDup + ' 份同名未覆盖）' : '')
        + (assetsOk ? '、资产索引' : '') + (failed ? '；⚠ ' + failed + ' 项没写进去' : '')
        + '；恢复前的当前数据已另留一份快照。',
    };
  }
  function restore(input) {
    const snap = snapshotById(input && input.snapshot);
    if (!snap) throw new Error('没有这份快照');
    const v = verify();
    if (!v.ok) throw new Error('快照校验不通过，已拒绝恢复：' + v.bad.join('、'));
    if (snap.checksum !== checksumOfSnapshot(snap.body)) throw new Error('这份快照的校验和对不上，已拒绝恢复');
    const wanted = input && Array.isArray(input.keys) && input.keys.length ? input.keys : null;
    return restoreBody(snap.body, wanted);
  }
  function restorePack(pack) {
    if (!pack || pack.version !== BACKUP_VERSION) throw new Error('整包备份版本不对，已拒绝导入');
    const body = { state: pack.state, assetsIndex: pack.assetsIndex, prompts: pack.prompts,
      cloud: pack.cloud, legacyBaks: pack.legacyBaks || null, key: '' };
    if (pack.checksum !== checksumOfSnapshot(body)) throw new Error('整包备份校验和对不上，已拒绝导入');
    return restoreBody(body, null);
  }
  function backupStatus() {
    const c = load();
    const v = verify();
    return {
      /* 两份文件都得健康：state.json 校验不过时业务键已经拒绝写入了，
         这里再说「正常」会让人以为刚才那次修改存下来了（踩过）。 */
      ok: !degraded && !stateStore.degraded && v.ok, dir: dataDirPath(), file: file(),
      snapshots: list(), count: c.snapshots.length, degraded,
      verified: v.ok, bad: v.bad,
      lastAt: c.snapshots[0] ? c.snapshots[0].ts : 0,
      stateDegraded: stateStore.degraded, fsyncDegraded: stateStore.fsyncDegraded,
      legacy: stateStore.migrationLegacy || null,
    };
  }
  function exportPack() {
    const body = collectSnapshotBody({});
    return { version: BACKUP_VERSION, ts: Date.now(), checksum: checksumOfSnapshot(body), ...body };
  }
  function handleBackup(req, res, urlObj) {
    const pn = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (!pn.startsWith('/backup')) return false;
    const cmd = pn === '/backup' ? 'status' : pn.slice('/backup/'.length);
    const backupReply = (code, obj) => sendJson(res, code, obj);
    if (cmd === 'status' && req.method === 'GET') { backupReply(200, backupStatus()); return true; }
    if (cmd === 'export' && req.method === 'GET') { backupReply(200, { ok: true, pack: exportPack() }); return true; }
    if (cmd === 'verify' && req.method === 'POST') { backupReply(200, { ok: true, ...verify() }); return true; }
    if (req.method !== 'POST') { fail(res, 405, '不支持的请求：' + req.method + ' ' + pn); return true; }
    opts.readBody(req, res, 2 * 1024 * 1024).then(raw => {
      if (raw == null) return;
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      try {
        /* 端点上的每一次 create 都是人点的（或覆盖前的撤销点）：强制留一份，
           不去重。自动快照走 noteSnapshot / maybeAuto，不经这个端点。 */
        if (cmd === 'create') backupReply(200, { ok: true, ...createSnapshot(String(body.reason || 'manual'), { force: true }) });
        else if (cmd === 'preview') backupReply(200, { ok: true, ...preview(body.snapshot) });
        else if (cmd === 'restore') backupReply(200, restore(body));
        else if (cmd === 'import') backupReply(200, restorePack(body.pack));
        else fail(res, 404, '没有这条备份命令：' + pn);
      } catch (e) {
        log('[backup] ' + cmd + ' 失败：' + e.message);
        fail(res, 500, e.message);
      }
    }).catch(e => {
      if (!res.headersSent) fail(res, 500, e.message);
    });
    return true;
  }
  const timer = setInterval(() => {
    if (Date.now() - lastAutoAt < AUTO_INTERVAL_MS) return;
    maybeAuto('timer');
  }, AUTO_INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
  return { createSnapshot, maybeAuto, verify, list, preview, restore, restorePack, status: backupStatus,
    exportPack, handleBackup, get degraded() { return degraded; } };
}

/* ===== ASR 设置与任务账本 ===== */

/* ASR 设置与任务账本（server 侧唯一实现）。
   - state.json 的 `asr` 键：设置（路线 / 语言 / 在线服务）。`service.key` 只留在盘上，
     读接口一律只回 hasKey，绝不回明文。
   - state.json 的 `asr-jobs` 键：转写任务（状态 / 进度 / 分段 / SRT / sourceHash）。
     两个键都由状态仓整包原子重写（tmp → fsync → rename），覆盖前统一向 backup.json 留快照。
   - 代理重启时把 queued/running 标成 interrupted，不自动重试（避免重复计费）。 */

const ROUTES = new Set(['auto', 'browser', 'local', 'service']);
const JOB_KEEP = 60;
const SEG_MAX = 20000;

const defSettings = () => ({
  revision: 1,
  route: 'auto',
  language: '',
  /* 型号空着 = 用这一家声明里的默认型号（openai 是 whisper-1、智谱是 glm-asr-2512…）。
     以前这里写死 whisper-1，换一家之后照样把 whisper-1 发过去 —— 上游直接 400。 */
  service: { providerId: '', model: '', baseUrl: '', key: '' },
  updatedAt: '',
});

function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function isHttpUrl(v) {
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && String(v).length <= 500;
  } catch { return false; }
}
function srtTime(sec) {
  /* 先整体取整到毫秒再拆位：`Math.round(小数部分 * 1000)` 在 1.9996 这种值上会算出 1000，
     拼出来是 `00:00:01,1000` —— 那不是合法 SRT 时间（毫秒只有 000–999），
     导进别的软件会当场报错。整体取整还会自然进位到下一秒。 */
  const total = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
}
function toSrt(segs) {
  const list = Array.isArray(segs) ? segs : [];
  return list.map((s, i) => String(i + 1) + '\n'
    + srtTime(s.start) + ' --> ' + srtTime(s.end) + '\n'
    + String(s.text == null ? '' : s.text).replace(/\r/g, '').trim() + '\n').join('\n');
}
function normSegments(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, SEG_MAX).map(s => {
    const start = Math.max(0, Number(s && s.start) || 0);
    const end = Math.max(start, Number(s && s.end) || start);
    const text = String((s && s.text) == null ? '' : s.text).replace(/\s+/g, ' ').trim();
    return { start, end, text };
  }).filter(s => s.text);
}

function createAsrStore(opts) {
  const dataDir = opts.dataDir;
  const readKey = opts.readKey;
  const writeKey = opts.writeKey;
  const log = opts.log || (() => {});
  const settingsPath = path.join(dataDir, 'asr.json');
  const jobsPath = path.join(dataDir, 'asr-jobs.json');
  let settings = null;
  let jobs = null;

  const readJson = p => {
    const key = path.basename(p, '.json');
    try {
      const raw = readKey(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      log('[asr] 读不出来 ' + key + '：' + e.message);
      return null;
    }
  };
  /* 覆盖写 + `.bak` 备份和写盘纪律都在 fs-atomic（writeJsonWithBak）：
     同内容不留、一份备份至少留 10 分钟、备份没成就不覆盖（会抛，调用方照实回错）；
     tmp → fsync → rename，被杀软/同步盘占住时退避重试。这里不再自己拼一份。 */
  const atomic = (p, obj) => writeKey(path.basename(p, '.json'), JSON.stringify(obj, null, 2));

  const loadSettings = () => {
    if (settings) return settings;
    const raw = readJson(settingsPath) || {};
    const d = defSettings();
    settings = {
      revision: Number(raw.revision) || 1,
      route: ROUTES.has(raw.route) ? raw.route : d.route,
      language: cleanStr(raw.language, 32),
      service: {
        providerId: cleanStr(raw.service && raw.service.providerId, 60),
        model: cleanStr(raw.service && raw.service.model, 120),
        baseUrl: cleanStr(raw.service && raw.service.baseUrl, 500),
        key: cleanStr(raw.service && raw.service.key, 500),
      },
      updatedAt: cleanStr(raw.updatedAt, 40),
    };
    return settings;
  };
  const saveSettings = () => {
    const s = loadSettings();
    s.revision = (Number(s.revision) || 0) + 1;
    s.updatedAt = new Date().toISOString();
    atomic(settingsPath, s);
    return publicSettings();
  };
  const publicSettings = () => {
    const s = loadSettings();
    return {
      revision: s.revision,
      route: s.route,
      language: s.language,
      service: {
        providerId: s.service.providerId,
        model: s.service.model,
        baseUrl: s.service.baseUrl,
        hasKey: !!s.service.key,
      },
      updatedAt: s.updatedAt,
    };
  };
  /* patch 只收白名单字段；返回前不回明文。`service.key` 传空串不覆盖，
     要清掉得显式 clearKey（与设置页「清空密钥」那条路一致）。 */
  const patchSettings = patch => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const base = loadSettings();
    /* 先在副本上改、全部校验通过再落回缓存对象：以前中途抛错（例如接口地址非法）时，
       前面几项已经改在内存里、磁盘却没写 —— 运行中的设置成了「半截新半截旧」，
       重启才复原，而这中间每一单转写都按那份半截配置走。 */
    const s = { ...base, service: { ...base.service } };
    const prevProvider = s.service.providerId;
    if (ROUTES.has(p.route)) s.route = p.route;
    if (p.language != null) {
      const lang = cleanStr(p.language, 32);
      if (lang && !/^[A-Za-z-]+$/.test(lang)) throw new Error('语言只能填 zh / en / ja 这类短标记');
      s.language = lang;
    }
    const svc = p.service && typeof p.service === 'object' ? p.service : {};
    if (svc.providerId != null) {
      const id = cleanStr(svc.providerId, 60);
      if (id && !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('供应商 id 不合法');
      s.service.providerId = id;
    }
    if (svc.model != null) s.service.model = cleanStr(svc.model, 120);
    if (svc.baseUrl != null) {
      const url = cleanStr(svc.baseUrl, 500).replace(/\/+$/, '');
      if (!isHttpUrl(url)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      s.service.baseUrl = url;
    }
    if (p.clearKey === true) s.service.key = '';
    else if (svc.key != null && String(svc.key).trim()) s.service.key = cleanStr(svc.key, 500);
    /* 换在线服务商：接口地址 / 型号 / 单独那把密钥都属于「上一家」，一并作废。
       不清的话，上一家的密钥会带着 Authorization 发到新那家的地址上，
       上一家的自定义地址也会顶掉新那家声明的默认端点。同一趟显式给了新值就以新值为准。 */
    if (s.service.providerId !== prevProvider) {
      if (!String(svc.baseUrl == null ? '' : svc.baseUrl).trim()) s.service.baseUrl = '';
      if (svc.model == null) s.service.model = '';
      if (p.clearKey !== true && !String(svc.key == null ? '' : svc.key).trim()) s.service.key = '';
    }
    Object.assign(base, s);
    return saveSettings();
  };

  const normJob = raw => {
    const j = raw && typeof raw === 'object' ? raw : {};
    const state = ['queued', 'running', 'done', 'error', 'canceled', 'interrupted'].includes(j.state) ? j.state : 'error';
    const segments = state === 'done' ? normSegments(j.segments) : [];
    return {
      id: cleanStr(j.id, 80),
      state,
      progress: Math.max(0, Math.min(1, Number(j.progress) || 0)),
      segments,
      srt: state === 'done' ? (String(j.srt || '') || toSrt(segments)) : '',
      error: cleanStr(j.error, 800),
      sourceHash: cleanStr(j.sourceHash, 40),
      route: cleanStr(j.route, 20),
      language: cleanStr(j.language, 32),
      engine: cleanStr(j.engine, 120),
      /* 「这份结果是谁出的」：local:<模型> / service:<供应商>/<型号> / browser。
         去重要连它一起比 —— 同一份音频换个在线模型再转一次，本来就是为了不同的结果。 */
      engineKey: cleanStr(j.engineKey, 160),
      media: cleanStr(j.media, 300),
      createdAt: Number(j.createdAt) || Date.now(),
      updatedAt: Number(j.updatedAt) || Date.now(),
    };
  };
  const loadJobs = () => {
    if (jobs) return jobs;
    const raw = readJson(jobsPath) || {};
    const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
    jobs = {};
    for (const id of Object.keys(items)) {
      const j = normJob({ ...items[id], id });
      if (j.id) jobs[j.id] = j;
    }
    let changed = false;
    for (const j of Object.values(jobs)) {
      if (j.state === 'queued' || j.state === 'running') {
        j.state = 'interrupted';
        j.error = '代理重启时这一单还没跑完；没有自动重试（避免重复计费）';
        j.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) persistJobs();
    return jobs;
  };
  const persistJobs = () => {
    const all = Object.values(loadJobs()).sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = {};
    for (const j of all.slice(0, JOB_KEEP)) keep[j.id] = j;
    jobs = keep;
    atomic(jobsPath, { revision: 1, items: keep });
  };
  const getJob = id => loadJobs()[String(id || '')] || null;
  const putJob = job => {
    loadJobs();
    jobs[job.id] = normJob(job);
    persistJobs();
    return jobs[job.id];
  };
  const patchJob = (id, patch) => {
    const cur = getJob(id);
    if (!cur) return null;
    const next = normJob({ ...cur, ...(patch || {}), id: cur.id, updatedAt: Date.now() });
    jobs[cur.id] = next;
    persistJobs();
    return next;
  };
  const removeJob = id => {
    loadJobs();
    if (!jobs[id]) return false;
    delete jobs[id];
    persistJobs();
    return true;
  };
  /* 去重：同一份媒体 + 同一路线 + 同一语言 + 同一个引擎（`engineKey`）。
     engineKey 缺省时退回旧口径（只看前三样），旧账本里没有这个字段的条目仍可被复用。 */
  const findByHash = (hash, route, language, engineKey) => {
    const all = Object.values(loadJobs());
    return all.find(j => j.state === 'done' && j.sourceHash === hash
      && j.route === route && j.language === (language || '')
      && (!engineKey || j.engineKey === engineKey)) || null;
  };
  const listJobs = () => Object.values(loadJobs()).sort((a, b) => b.createdAt - a.createdAt);

  return {
    settingsPath, jobsPath, toSrt, normSegments,
    settings: publicSettings, rawSettings: loadSettings, patchSettings,
    jobs: listJobs, job: getJob, putJob, patchJob, removeJob, findByHash,
  };
}

const LOCAL_NAMES = process.platform === 'win32'
  ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
  : ['whisper-cli', 'whisper', 'main'];
function localAsrState(root) {
  const toolDir = path.join(root, 'tools', 'whisper');
  const candidates = [];
  const envBin = String(process.env.WHISPER_BIN || '').trim();
  if (envBin) candidates.push(envBin);
  for (const n of LOCAL_NAMES) candidates.push(path.join(toolDir, n));
  let bin = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
  /* 相对路径一律按「启动代理时的工作目录」解析成绝对路径：runLocal 起子进程时
     cwd 是那一单的临时目录，相对路径到那里就找不到了。 */
  if (bin && !path.isAbsolute(bin)) bin = path.resolve(bin);
  let model = String(process.env.WHISPER_MODEL || '').trim();
  if (!model) {
    const dirs = [path.join(toolDir, 'models'), toolDir];
    for (const dir of dirs) {
      try {
        const hit = fs.readdirSync(dir).find(f => /\.bin$/i.test(f));
        if (hit) { model = path.join(dir, hit); break; }
      } catch (e) {}
    }
  }
  if (model && !path.isAbsolute(model)) model = path.resolve(model);
  let bytes = 0;
  if (model) { try { bytes = fs.statSync(model).size; } catch (e) { bytes = 0; } }
  const why = !bin ? '没找到 whisper-cli（放到 tools/whisper/ 或在 .env 里设 WHISPER_BIN）'
    : !model ? '没找到模型（.bin 放到 tools/whisper/models/ 或在 .env 里设 WHISPER_MODEL）'
    : !bytes ? '模型文件读不到：' + model : '';
  return {
    available: !!(bin && model && bytes),
    bin,
    /* `model` 是给界面看的短名（basename）；真正传给 whisper-cli `-m` 的必须是 `modelPath`
       这一份绝对路径 —— 以前调用点拿的是 basename，而工作目录是临时目录，模型永远找不到。 */
    model: model ? path.basename(model) : '', modelPath: model, bytes, why,
  };
}

/* ===== 联网搜索设置 ===== */

/* 联网搜索设置（server 侧唯一实现）。
   - state.json 的 `search` 键：开关 / 服务 / 结果数 / 凭据来源。`key` 只留在盘上，读接口只回 hasKey。
   - 原子写 + 覆盖前 .bak.json；与 asr-store 同一种写盘纪律。 */

/* `provider` 是搜索**引擎**：'auto'（挑第一家声明了 search 且配了密钥的供应商）/
   'tavily'（独立搜索接口，只认单独填的那把密钥）/ 供应商 id（deepseek、zhipu、moonshot…）。
   不在这一层校验 id 是否存在 —— 注册表是动态的，未知 id 由 /search/query 按「这家没有搜索接口」报。 */
const SOURCES = new Set(['channel', 'manual']);
const def = () => ({
  revision: 1,
  enabled: false,
  provider: 'auto',
  maxResults: 5,
  credentialSource: 'channel',
  model: '',
  baseUrl: '',
  key: '',
  updatedAt: '',
});
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
function urlOk(v) {
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && String(v).length <= 500;
  } catch { return false; }
}

function createSearchStore(opts) {
  const dataDir = opts.dataDir;
  const readKey = opts.readKey;
  const writeKey = opts.writeKey;
  const log = opts.log || (() => {});
  const file = path.join(dataDir, 'search.json');
  let cur = null;

  const load = () => {
    if (cur) return cur;
    let raw = {};
    try { const text = readKey('search'); raw = text ? (JSON.parse(text) || {}) : {}; }
    catch (e) { log('[search] 读不出来 search：' + e.message); }
    const d = def();
    cur = {
      revision: Number(raw.revision) || 1,
      enabled: raw.enabled === true,
      provider: clean(raw.provider, 60) || d.provider,
      maxResults: Math.max(1, Math.min(10, Number(raw.maxResults) || d.maxResults)),
      credentialSource: SOURCES.has(raw.credentialSource) ? raw.credentialSource : d.credentialSource,
      model: clean(raw.model, 120),
      baseUrl: clean(raw.baseUrl, 500),
      key: clean(raw.key, 500),
      updatedAt: clean(raw.updatedAt, 40),
    };
    return cur;
  };
  /* 覆盖写 + `.bak` 备份与写盘纪律都在 fs-atomic（writeJsonWithBak），与 asr-store 同一份。 */
  const atomic = obj => writeKey('search', JSON.stringify(obj, null, 2));
  const persist = () => {
    const s = load();
    s.revision = (Number(s.revision) || 0) + 1;
    s.updatedAt = new Date().toISOString();
    atomic(s);
    return pub();
  };
  const pub = () => {
    const s = load();
    return {
      revision: s.revision, enabled: s.enabled, provider: s.provider,
      maxResults: s.maxResults, credentialSource: s.credentialSource,
      model: s.model, baseUrl: s.baseUrl,
      hasKey: !!s.key, updatedAt: s.updatedAt,
    };
  };
  const patch = p => {
    const o = p && typeof p === 'object' ? p : {};
    const base = load();
    /* 先在副本上改、全部校验通过再落回缓存：以前中途抛错（例如结果数填 50）时，
       前面几项已经改在内存里、磁盘却没写，运行中的搜索就按一份半截配置走。 */
    const s = { ...base };
    const prevProvider = s.provider;
    if (o.enabled != null) s.enabled = o.enabled === true;
    if (o.provider != null) {
      const id = clean(o.provider, 60);
      if (id && id !== 'auto' && id !== 'tavily' && !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('搜索服务只能是 auto / tavily / 供应商 id');
      }
      s.provider = id || 'auto';
    }
    if (o.maxResults != null) {
      const n = Math.round(Number(o.maxResults));
      if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('结果数只能是 1–10');
      s.maxResults = n;
    }
    if (o.credentialSource != null) {
      if (!SOURCES.has(o.credentialSource)) throw new Error('凭据来源只支持 channel / manual');
      s.credentialSource = o.credentialSource;
    }
    if (o.model != null) s.model = clean(o.model, 120);
    if (o.baseUrl != null) {
      const base = clean(o.baseUrl, 500).replace(/\/+$/, '');
      if (!urlOk(base)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      s.baseUrl = base;
    }
    if (o.clearKey === true) s.key = '';
    else if (o.key != null && String(o.key).trim()) s.key = clean(o.key, 500);
    /* 换搜索服务：接口地址 / 对话型号 / 单独那把密钥都属于「上一家」，一并作废。
       不清的话，上一家的密钥会被发到新那家的域名上（Tavily 与供应商两个方向都会漏），
       上一家的接口地址也会顶掉新那家声明的默认地址。同一趟显式给了新值就以新值为准。 */
    if (s.provider !== prevProvider) {
      if (!String(o.baseUrl == null ? '' : o.baseUrl).trim()) s.baseUrl = '';
      if (o.model == null) s.model = '';
      if (o.clearKey !== true && !String(o.key == null ? '' : o.key).trim()) s.key = '';
      if (o.credentialSource == null) s.credentialSource = 'channel';
    }
    Object.assign(base, s);
    return persist();
  };
  return { file, settings: pub, raw: load, patch };
}

/* ===== Skill 状态与安装 ===== */

/* Skill 的唯一解析 / 校验 / 安装实现（server 侧）。
   - 内置 skills/ 只读；用户 .skills/ 可写；启用状态存 DATA_DIR/skills.json
   - frontmatter 只支持受限子集：key: value、[a, b]、字符串/数字/布尔
   - 同一个 contract 同一时刻只留一份启用的：启一份就把同 contract 的**别的直接停掉**
     （不报错、不让人先关掉再开 —— 用户的这份顶上去，内置那份也让位）
   - 占 contract 的场景**恰好一份启用**：停掉场景里最后那份启用会被拒；卸载场景里最后那份启用
     会把内置份拉回来；老状态文件里的「两份都启用 / 一份都不启用」开机修一次
   - 安装先写临时目录再原子替换；zip 解压在路由层完成并只提交文本文件 */

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/* contract 白名单：一份 Skill 的正文由 contract 唯一标识（TextAI.SKILL_CONTRACT 是同一张表的页面侧）。
   `board_assets.json` = 拆分镜那一条「判断哪些新角色/场景/物品要建档并出图」的指令；
   `split_follow.json` = 拆分镜审查弹窗「按这句再改」——对着已拆好的方案按一句话再改一轮。 */
const CONTRACTS = new Set(['polish.video', 'polish.image', 'polish.voice', 'polish.follow', 'story.json', 'split.json', 'board_edit.json', 'split_follow.json', 'img_split.json', 'char.image.json', 'char.voice.json', 'board_assets.json', 'line_write.json', 'model3d.json']);
const ALLOWED_EXT = new Set(['.md', '.txt', '.json']);

function parseFrontmatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return { meta: {}, body: s };
  const end = s.indexOf('\n---', 3);
  if (end < 0) throw new Error('frontmatter 没有结束的 ---');
  const head = s.slice(3, end).replace(/\r/g, '');
  const body = s.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error('frontmatter 行无法解析：' + line);
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (!val) { meta[key] = ''; continue; }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (val === 'true' || val === 'false') meta[key] = val === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(val)) meta[key] = Number(val);
    else meta[key] = val.replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

function createSkillsStore(opts) {
  const root = opts.root;
  const readKey = opts.readKey;
  const writeKey = opts.writeKey;
  const builtinDir = path.join(root, 'skills');
  /* 用户 Skill 目录默认在项目里；隔离实例用 SKILLS_DIR 指出去 ——
     否则 e2e 安装的测试 Skill 会直接写进用户真实的那一份。 */
  const userDir = opts.userDir ? path.resolve(opts.userDir) : path.join(root, '.skills');
  const statePath = path.join(opts.dataDir || path.join(root, '.data'), 'skills.json');
  const log = opts.log || (() => {});
  /* 启动清扫：上次安装中途崩溃留下的 `<id>.tmp-<pid>-<串>` 目录。
     只认自己写出来的形状，且只收 10 分钟以前的 —— 另一个实例可能正在装同一份。 */
  try {
    if (fs.existsSync(userDir)) {
      for (const ent of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !/\.tmp-\d+-[a-z0-9]{2,8}$/.test(ent.name)) continue;
        const p = path.join(userDir, ent.name);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
      }
    }
  } catch (e) { log('[skills] 启动清扫临时目录失败：' + e.message); }
  let state = null;
  const loadState = () => {
    if (state) return state;
    try { const raw = readKey('skills'); state = raw ? (JSON.parse(raw) || {}) : {}; } catch (e) { state = {}; }
    if (!state.enabled || typeof state.enabled !== 'object') state.enabled = {};
    return state;
  };
  const saveState = () => {
    /* 与其余 store 同一份写盘纪律（fs-atomic）：tmp → fsync → 占用时退避重试的 rename。
       这里以前自己写 .tmp + renameSync，Windows 上杀软/同步盘占住目标就 EPERM，
       而调用方只会看到「启停没生效」。 */
    writeKey('skills', JSON.stringify(loadState(), null, 2));
  };
  const readSkillDir = (dir, source) => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue;
      const file = path.join(dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const id = String(meta.id || ent.name);
        if (id !== ent.name) throw new Error('id 与目录名不一致');
        out.push({ ...meta, id, source, body, dir: path.join(dir, ent.name) });
      } catch (e) {
        log('[skills] 跳过坏 Skill ' + ent.name + '：' + e.message);
      }
    }
    return out;
  };
  const all = () => {
    const st = loadState();
    return [...readSkillDir(builtinDir, 'builtin'), ...readSkillDir(userDir, 'user')]
      .map(x => ({ ...x, enabled: x.source === 'builtin' ? st.enabled[x.id] !== false : st.enabled[x.id] === true }));
  };
  const get = id => all().find(x => x.id === id) || null;
  const list = () => {
    const items = all();
    return items.map(x => ({
      id: x.id, name: x.name || x.id, description: x.description || '', triggers: x.triggers || [],
      pages: x.pages || [], tools: x.tools || [], contract: x.contract || '', version: x.version || 1,
      source: x.source, enabled: !!x.enabled, replaces: x.replaces || '',
      /* 「素材范围优先」：一份 Skill 可以声明「这个项目优先用哪几个素材组」。
         拆分镜那一路的「素材范围」下拉会把这些组**排在前面**（不排除其它组）。
         ⚠ 这**不是**「项目引用规则」：项目引用规则指的是**正文里的变量占位符**
         （`{cast}` `{what}` `{board}` …），由程序按项目填料 —— 变量名在正文里，不在这里。 */
      assetGroups: Array.isArray(x.assetGroups) ? x.assetGroups : [],
    }));
  };
  const enabled = () => all().filter(x => x.enabled);
  /* 同一个 contract 同一时刻只留一份：启一份就把**别的直接停掉**（不报错、不让人先关掉再开）。
     内置那份同样让位 —— 用户的这份顶上去，内置那份自动停（这一直是这个行为）。
     ⚠ 不占固定位的 Skill（没有 contract）不参与这条规则：它由助手按触发词自己挑。
     返回被让位的那几份 id —— 前端要当场说清「哪一份停了」，不能让人猜。 */
  const displaceSameContract = (st, contract, exceptId) => {
    const out = [];
    if (!contract) return out;
    for (const o of enabled()) {
      if (o.id === exceptId || o.contract !== contract) continue;
      st.enabled[o.id] = false;
      out.push(o.id);
    }
    return out;
  };
  const setEnabled = (id, on) => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill：' + id);
    /* 场景恰好一份启用：停掉场景里最后那份启用是非法操作 —— 先启用另一份
       （那一走会把这份自动停掉），再回来停它就没有这条路了。助手（无 contract）随便停。 */
    if (!on && x.enabled && x.contract && !all().some(o => o.enabled && o.contract === x.contract && o.id !== id)) {
      throw new Error('这个场景至少要有一份 Skill 在用 —— 先启用另一份，再停这一份');
    }
    const st = loadState();
    const displaced = on ? displaceSameContract(st, x.contract, id) : [];
    st.enabled[id] = !!on;
    saveState();
    return displaced;
  };
  /* 开机修一次老状态文件：多份启用的按 [builtin, user] 顺序留最后启用那份（与界面取「正在生效」
     同一条尺子），其余停掉；一份都不启用且场景里还有 Skill 的，把内置份（没有内置就第一份用户）
     拉回来。没修的东西不动盘。 */
  const ensureInvariants = () => {
    const st = loadState();
    let fixed = false;
    const seen = new Map();
    for (const x of all()) {
      if (!x.enabled || !x.contract) continue;
      const prev = seen.get(x.contract);
      if (prev) { st.enabled[prev.id] = false; fixed = true; log('[skills] 场景 ' + x.contract + ' 多份启用，停掉 ' + prev.id); }
      seen.set(x.contract, x);
    }
    const byC = new Map();
    for (const x of all()) {
      if (!x.contract) continue;
      if (!byC.has(x.contract)) byC.set(x.contract, []);
      byC.get(x.contract).push(x);
    }
    for (const [contract, xs] of byC) {
      if (xs.some(y => y.enabled)) continue;
      const pick = xs.find(y => y.source === 'builtin') || xs[0];
      if (!pick) continue;
      st.enabled[pick.id] = true;
      fixed = true;
      log('[skills] 场景 ' + contract + ' 一份都不启用，拉回 ' + pick.id);
    }
    if (fixed) saveState();
  };
  const safeFiles = files => {
    if (!Array.isArray(files) || !files.length) throw new Error('没有文件');
    if (files.length > 50) throw new Error('文件超过 50 个');
    let total = 0;
    const out = [];
    for (const f of files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.includes('..') || /^[a-z]:/i.test(rel)) throw new Error('非法路径：' + rel);
      const ext = path.extname(rel).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) throw new Error('不允许的文件类型：' + rel);
      const text = String(f.text == null ? '' : f.text);
      total += Buffer.byteLength(text, 'utf8');
      if (total > 5 * 1024 * 1024) throw new Error('解压后超过 5MB');
      out.push({ rel, text });
    }
    return out;
  };
  const install = (files, opts2 = {}) => {
    const listFiles = safeFiles(files);
    const main = listFiles.find(f => f.rel === 'SKILL.md') || listFiles.find(f => /^[^/]+\/SKILL\.md$/.test(f.rel));
    if (!main) throw new Error('缺少 SKILL.md');
    const { meta } = parseFrontmatter(main.text);
    const id = String(meta.id || '').trim();
    if (!ID_RE.test(id)) throw new Error('id 不合法：' + id);
    if (readSkillDir(builtinDir, 'builtin').some(x => x.id === id)) throw new Error('内置 Skill id 不可覆盖：' + id);
    if (!meta.description) throw new Error('缺少 description');
    if (!CONTRACTS.has(String(meta.contract || ''))) throw new Error('contract 不在注册表里：' + (meta.contract || ''));
    const pages = Array.isArray(meta.pages) ? meta.pages : (meta.pages ? [meta.pages] : []);
    if (pages.some(p => !/^[a-z0-9-]+\.html$/.test(p))) throw new Error('pages 必须是页面文件名');
    const cur = get(id);
    if (cur && cur.contract && meta.contract && cur.contract !== meta.contract && cur.enabled) throw new Error('已启用的 Skill 不能换 contract');
    /* 同 contract 的原来那份**不拦**：装上去就等于「启用这一份」，让位由下面的状态写入一步做掉。 */
    const dst = path.join(userDir, id);
    const tmp = dst + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const prefix = main.rel.includes('/') ? main.rel.slice(0, main.rel.lastIndexOf('/') + 1) : '';
      for (const f of listFiles) {
        let rel = f.rel.startsWith(prefix) ? f.rel.slice(prefix.length) : f.rel;
        if (!rel || rel.includes('..')) continue;
        const dest = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        atomicWrite(dest, f.text);        // 落盘（fsync）之后才允许那次目录 swap，否则掉电后 swap 过去的是半个文件
      }
      let bak = '';
      if (cur) {
        bak = dst + '.bak-' + Date.now();
        /* 旧版本挪不动就别往下装：renameWithRetry 只重试「此刻被占着」那一类，
           真让新目录盖上去，旧的那份就再也找不回来了（bak 是这次唯一后悔药）。 */
        try { renameWithRetry(dst, bak); } catch (e) {
          throw new Error('旧版本 Skill 挪不去备份 ' + path.basename(bak) + '（' + ((e && e.code) || '') + ' ' + ((e && e.message) || e) + '），安装已中止：' + id);
        }
      }
      try {
        renameWithRetry(tmp, dst);
      } catch (e) {
        /* 新目录没能换上位：把刚挪走的旧版本放回原处 ——
           「升级失败」不该变成「这个 Skill 凭空没了」，放回后再报错。 */
        if (bak) { try { renameWithRetry(bak, dst); } catch {} }
        throw new Error('Skill 目录换不到位（' + ((e && e.code) || '') + ' ' + ((e && e.message) || e) + '）：' + id + ' 已保持原样');
      }
      const st = loadState();
      let displaced = [];
      if (!opts2.keepState) {
        if (opts2.enable !== false) {
          /* 装上去就等于「启用这一份」：同 contract 的原来那份**直接让位**（不报错、不拦着）。
             让位的是哪几份要报给前端 —— 界面上得说清「哪一份停了」。 */
          displaced = displaceSameContract(st, String(meta.contract || ''), id);
          st.enabled[id] = true;
        }
        saveState();
      }
      return { skill: get(id), displaced };
    } finally {
      /* 任何一步抛出（写文件失败 / 旧版挪不动 / 换位失败）都把本次临时目录收掉：
         以前失败就留在 .skills/ 里，堆积的 .tmp-* 还会被当成坏 Skill 逐个读一遍。 */
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
  };
  const remove = id => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    if (x.source !== 'user') throw new Error('内置 Skill 不能删除');
    /* 删的是场景里最后那份启用的：删完那份就落空 —— 内置份（没有内置就第一份用户）顶回来。 */
    const wasLastEnabled = x.enabled && !!x.contract
      && !all().some(o => o.enabled && o.contract === x.contract && o.id !== id);
    fs.rmSync(x.dir, { recursive: true, force: true });
    const st = loadState(); delete st.enabled[id];
    let restored = '';
    if (wasLastEnabled) {
      const cands = all().filter(o => o.contract === x.contract);
      const pick = cands.find(o => o.source === 'builtin') || cands[0];
      if (pick) { st.enabled[pick.id] = true; restored = pick.id; }
    }
    saveState();
    return restored;
  };
  /* 根目录内的文本文件：列表 / 读取 / 整包哈希。
     路径规范化、扩展名、大小与行数上限都只在这里判一次；路由与助手不另写一套。 */
  const safeRel = rel => {
    const s = String(rel || '').replace(/\\/g, '/');
    if (!s || s.startsWith('/') || s.includes('..') || /^[a-z]:/i.test(s)) return '';
    if (!ALLOWED_EXT.has(path.extname(s).toLowerCase())) return '';
    return s;
  };
  const listFiles = id => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    const out = [];
    const walk = (dir, base) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const rel = path.relative(base, full).replace(/\\/g, '/');
        if (ent.isDirectory()) { walk(full, base); continue; }
        if (!ent.isFile() || !safeRel(rel)) continue;
        const buf = fs.readFileSync(full);
        out.push({ path: rel, size: buf.length, hash: crypto.createHash('sha1').update(buf).digest('hex') });
      }
    };
    walk(x.dir, x.dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };
  const skillHash = id => crypto.createHash('sha1')
    .update(listFiles(id).map(f => f.path + ':' + f.hash).join('\n')).digest('hex');
  const readFile = (id, file) => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    const rel = safeRel(file);
    if (!rel) throw new Error('非法文件（只读 Skill 目录下的 .md / .txt / .json）');
    const full = path.join(x.dir, rel);
    if (!full.startsWith(x.dir + path.sep)) throw new Error('非法文件');
    let st;
    try { st = fs.statSync(full); } catch { throw new Error('没有这个文件：' + rel); }
    if (!st.isFile()) throw new Error('不是文件：' + rel);
    if (st.size > 1024 * 1024) throw new Error('文件超过 1MB：' + rel);
    const text = fs.readFileSync(full, 'utf8');
    if (text.split(/\r?\n/).length > 1000) throw new Error('文件超过 1000 行：' + rel);
    return text;
  };
  /* 兼容旧调用名：/skills/:id/read 现在读根目录内任意允许的文本文件。 */
  const readRef = (id, file) => readFile(id, file);
  const update = (id, files, expectedHash) => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    if (x.source !== 'user') throw new Error('内置 Skill 不能改，要改就在设置页新建一份自己的');
    const main = (Array.isArray(files) ? files : []).find(f => /(^|\/)SKILL\.md$/.test(String(f && f.path || '')));
    if (!main) throw new Error('更新包缺少 SKILL.md');
    const meta = parseFrontmatter(String(main.text || '')).meta;
    if (String(meta.id || '') !== id) throw new Error('更新包里的 id（' + (meta.id || '空') + '）与要更新的 Skill 不一致');
    const cur = skillHash(id);
    if (String(expectedHash || '') !== cur) {
      const e = new Error('Skill 已经变了（当前 hash ' + cur.slice(0, 12) + '），刷新后再改');
      e.status = 409;
      e.currentHash = cur;
      throw e;
    }
    const next = install(files, { enable: !!x.enabled, keepState: true });
    return { skill: next.skill, hash: skillHash(id) };
  };
  const importBundle = (files, opts2 = {}) => install(files, opts2);
  ensureInvariants();
  return { parseFrontmatter, list, all, get, enabled, setEnabled, install, remove, readRef,
    listFiles, readFile, skillHash, update, importBundle,
    statePath, userDir, builtinDir, CONTRACTS };
}

/* ===== 提示词归档 ===== */

/* 提示词归档：目录校验、front matter、索引重建、/prompts 路由、云端文件清单。
   目录 root 与库根 localRoot 注入；fileSafe / dirStamp / timeText / readBody / localAssetEntry 由 app 注入。 */

function createPromptsStore(opts) {
  const root = opts.root;
  /* 库根（本机资产库本体住在哪）：归档默认目录是它下面的「提示词\」，
     与产物共用同一个根 —— 用户只挑一次位置。 */
  const localRoot = opts.localRoot;
  const log = opts.log || (() => {});
  const readBody = opts.readBody;
  const localAssetEntry = opts.localAssetEntry;
  const fileSafe = opts.fileSafe;
  const dirStamp = opts.dirStamp;
  const timeText = opts.timeText;
  const PROMPT_INDEX = '_index.json';
  const PROMPT_PACK_MAX_FILES = 20000, PROMPT_PACK_MAX_BYTES = 64 * 1024 * 1024;

  /* 归档默认目录 = 库根\提示词：与产物本体共用**用户挑的那一个根**（设置页「本机资产库」），
     根下按类别分子目录。库根由 app.js 注入的 localRoot 现读，换根后归档跟着搬过去 ——
     这一格不再单独给位置（以前是页面存 prompt_dir，与库根各指一处，换根后归档留在老地方）。
     PROMPTS_DIR 环境变量仍优先（部署 / 探针口子，不是版本兼容）。
     ⚠ 只认这一个目录 —— 项目内的老 prompts/ 已经搬走并且不存在了，不做双读。 */
  const promptsDefaultDir = () => process.env.PROMPTS_DIR
    ? path.resolve(root, process.env.PROMPTS_DIR)
    : path.join(localRoot(), userDirs.PROMPTS_DIR_NAME);
  function promptsDir(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return promptsDefaultDir();
    if (s.indexOf(String.fromCharCode(0)) >= 0) throw new Error('目录里有非法字符');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const p = (/^~($|[\\/])/.test(s) && home) ? path.join(home, s.slice(1)) : s;
    const abs = path.resolve(p);
    /* 白名单：项目目录 / 用户目录 / 下载根（成像那一族的家）/ 用户挑的库根——
       下载被搬到 D:\下载 时不在 home 之下，不加这一支默认目录自己都进不了白名单；
       库根可能被指到任何一块盘（D:\作品），归档跟着它走，这一支也得放行。 */
    const roots = [path.resolve(root), path.resolve(userDirs.downloadsRoot()), path.resolve(localRoot())];
    if (home) roots.push(path.resolve(home));
    const inside = roots.some(r => abs === r || abs.startsWith(r + path.sep));
    if (!inside) throw new Error('提示词目录只能在项目目录、下载目录、用户目录或本机资产库之下：' + abs);
    return abs;
  }
  const promptIndexPath = dir => path.join(dir, PROMPT_INDEX);
  /* 索引按「目录 + _index.json 的 mtime 与字节数」记住解析好的那一份：
     列表、按任务号找、写归档前读底座三条路都读它，一次 readFileSync + JSON.parse
     在 2000 行那一档上限上是几十毫秒的同步阻塞。凡是写归档的路径（POST 追加、导入重建、
     索引缺失时现搭）都整份重写索引 —— 重写一次 mtime 就变，下一读自动重取，不用另外记时间窗。
     ⚠ 交出去的是缓存里那一只数组：调用方只做 filter / slice（现在这三条都是），不许就地改它。 */
  const indexMemo = new Map();
  function readPromptIndex(dir) {
    const file = promptIndexPath(dir);
    let st = null;
    try { st = fs.statSync(file); } catch { return null; }
    const key = path.resolve(dir);
    const hit = indexMemo.get(key);
    if (hit && hit.mt === st.mtimeMs && hit.size === st.size) return hit.rows;
    let rows = null;
    try {
      const a = JSON.parse(fs.readFileSync(file, 'utf8'));
      rows = Array.isArray(a) ? a : null;
    } catch { rows = null; }
    if (!rows) { indexMemo.delete(key); return null; }
    indexMemo.set(key, { mt: st.mtimeMs, size: st.size, rows });
    return rows;
  }
  /* 索引写盘：整份覆盖，必须原子写 —— 直接 writeFileSync 写一半断电 / 被占用，
     下次读到的就是半截 JSON；而读不出来时 promptRows 会整目录重建，
     在归档很多时是一次明显卡顿，还会把「本次刚追加的那一行」暂时丢掉。
     读改写的串行队列见 updateIndex（同一目录同一时刻只有一份在跑）。 */
  const indexQueues = new Map();
  function updateIndex(dir, fn) {
    const key = path.resolve(dir);
    const run = (indexQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => fn());
    const tail = run.catch(() => {});
    indexQueues.set(key, tail);
    tail.then(() => { if (indexQueues.get(key) === tail) indexQueues.delete(key); });
    return run;
  }
  function writePromptIndex(dir, rows) {
    try {
      atomicWrite(promptIndexPath(dir), JSON.stringify(rows.slice(0, 2000)));
      forgetDirScan(dir);
    }
    catch (e) { log('[prompts] 索引写入失败：' + e.message); }
  }
  function parseFrontMatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return null;
    const o = {};
    m[1].split(/\r?\n/).forEach(line => {
      const i = line.indexOf(':');
      if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return o;
  }
  function promptMetaOf(file) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);
      return parseFrontMatter(buf.slice(0, n).toString('utf8'));
    } catch { return null; }
  }
  function promptBodyOf(file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const i = text.indexOf('## 提示词');
      return i >= 0 ? text.slice(i + '## 提示词'.length).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    } catch { return ''; }
  }
  /* 整目录那一遍（readdir + 逐条读 1KB front matter）缓住，30 秒内同一目录只翻一次：
     索引文件只写 2000 行，比这更老的归档不在索引里，/prompts/find 查不到时必须整目录翻一遍 ——
     600 条归档实测一次 130~200ms 的主线程同步阻塞，而一页十几张卡各问一次就是十几遍（2.3 秒）。
     缓的只有元数据：`pr` 那一句要把整份文件读完，仍然只对命中的那几条现算。
     写归档都经 writePromptIndex → forgetDirScan 清掉这一份，刚落盘的那一条当场认得到；
     受这一窗影响的只剩「用户自己在资源管理器里往归档目录里拷 .md」那一种，最长 30 秒
     （而索引整份不在时由 rebuildPromptIndex 强制重扫，不照这一份缓存搭索引）。 */
  const SCAN_TTL = 30 * 1000;
  const metaScans = new Map();
  function readDirMetaRows(dir, force) {
    const key = path.resolve(dir);
    if (!force) {
      const hit = metaScans.get(key);
      if (hit && Date.now() - hit.at < SCAN_TTL) return hit.rows;
    }
    const files = fs.readdirSync(key).filter(f => f.endsWith('.md'));
    const rows = [];
    files.forEach(f => {
      const o = promptMetaOf(path.join(key, f));
      if (!o) return;
      rows.push({ f, t: o.title || '', k: o.type || '', ts: Number(o.ts) || 0,
        p: o.provider || '', m: o.model || '', i: o.task || '' });
    });
    metaScans.set(key, { at: Date.now(), rows });
    return rows;
  }
  /* 落了新归档就清掉这一份：索引写盘排在异步队列里，那一段窗口里刚落盘的归档
     只能靠「整目录那一遍」认到 —— 缓存不旧它就不会被翻到。 */
  function forgetDirScan(dir) { metaScans.delete(path.resolve(dir)); }
  /* 索引整份不在 / 读坏时的现搭：这是「以盘上那一份为准」的修复那一路，所以 force 重扫一遍 ——
     缓存里那一份可能是用户自己往目录里拷了 .md 之前翻的，照它搭出来的索引会少几条，
     而且少完还写回盘上，缺口就固定下来了。 */
  function rebuildPromptIndex(dir) {
    let meta = [];
    try { meta = readDirMetaRows(dir, true); } catch { return []; }
    const rows = meta.map(r => ({ ...r, pr: promptBodyOf(path.join(dir, r.f)) }));
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    writePromptIndex(dir, rows);
    return rows;
  }
  const promptRows = dir => readPromptIndex(dir) || rebuildPromptIndex(dir);
  function scanPromptTask(dir, id, cap) {
    let meta;
    try { meta = readDirMetaRows(dir); } catch { return []; }
    const out = [];
    for (const r of meta) {
      if (out.length >= (cap || 50)) break;
      if (r.i !== id) continue;
      out.push({ ...r, pr: promptBodyOf(path.join(dir, r.f)) });
    }
    return out;
  }
  function promptFileList(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter(n => /\.md$/i.test(n))
      .map(n => { try { const st = fs.statSync(path.join(dir, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => a.mtime - b.mtime);
  }
  function promptCloudDir(raw) {
    try { return promptsDir(String(raw == null ? '' : raw)); }
    catch (e) { throw new Error('提示词目录不合法：' + e.message); }
  }
  function handlePrompts(req, res, urlObj) {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    let dir;
    try { dir = promptsDir(urlObj.searchParams.get('dir')); }
    catch (e) { json(400, { error: { message: e.message } }); return true; }
    const where = urlObj.pathname.replace(/^\/prompts\/?/, '');
    const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

    if (req.method === 'GET' && !where) {
      const rows = promptRows(dir);
      const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit')) || 300, 1), 2000);
      json(200, { dir, defaultDir: promptsDefaultDir(), count: rows.length, recent: rows.slice(0, limit) });
      return true;
    }
    if (req.method === 'GET' && where === 'find') {
      const id = String(urlObj.searchParams.get('id') || '');
      const prov = String(urlObj.searchParams.get('provider') || '');
      if (!id) { json(400, { error: { message: '缺少 id（任务号）' } }); return true; }
      if (/^la_[A-Za-z0-9]+$/.test(id)) {
        const it = localAssetEntry(id);
        let prompt = String((it && it.prompt) || '');
        const task = String((it && (it.taskId || (it.detail && it.detail.task))) || '');
        /* 本机账里那份提示词可能是列表索引的 300 字（镜像时列表还没拿到全文）：
           账里记着平台任务号，就再去归档里找整份 —— 以前这里直接返回 300 字那份，
           详情面板对 `la_` 号永远只能显示被截断的提示词。 */
        if (task) {
          const rows = promptRows(dir).filter(r => r.i && r.i === task);
          if (!rows.length) rows.push(...scanPromptTask(dir, task));
          if (rows.length) {
            rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
            /* 本机账的 provider 恒为 'local'（三条建账路径硬编码），归档行的 p 是平台 id ——
               按 provider 挑那份的分支永远命不中，别留着骗读者：同名任务的归档取最新一份。 */
            const hit = rows[0];
            try {
              const text = fs.readFileSync(path.join(dir, hit.f), 'utf8');
              const at = text.indexOf('## 提示词');
              if (at >= 0) {
                const full = text.slice(at + '## 提示词'.length).trim();
                if (full.length > prompt.length) prompt = full;
              }
            } catch (e) { /* 归档文件读不出来就用账里那份 */ }
          }
        }
        json(200, { ok: true, id, matched: 1, local: true, provider: (it && it.provider) || '',
          file: (it && it.file) || '', title: (it && it.name) || '', type: 'local', prompt, all: [] });
        return true;
      }
      const rows = promptRows(dir).filter(r => r.i && r.i === id);
      if (!rows.length) rows.push(...scanPromptTask(dir, id));
      if (!rows.length) { json(200, { ok: true, id, matched: 0, archived: false, prompt: '', all: [] }); return true; }
      rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const hit = (prov && rows.find(r => r.p === prov)) || rows.find(r => !r.p) || rows[0];
      let prompt = '';
      try {
        const text = fs.readFileSync(path.join(dir, hit.f), 'utf8');
        const i = text.indexOf('## 提示词');
        if (i >= 0) prompt = text.slice(i + '## 提示词'.length).trim();
      } catch {}
      json(200, { ok: true, id, matched: rows.length, provider: hit.p || '', file: hit.f,
        path: path.join(dir, hit.f), title: hit.t, type: hit.k, prompt,
        all: rows.map(r => ({ file: r.f, title: r.t, type: r.k, provider: r.p || '', ts: r.ts || 0, pr: r.pr || '' })) });
      return true;
    }
    if (req.method === 'POST' && where === 'open') {
      try {
        fs.mkdirSync(dir, { recursive: true });
        /* 打开目录走公共件：Windows 上 explorer 由后台进程拉起会被前台锁压在应用后面，
           那一层「再把窗口拽到前台」只在 open-dir.js 一处（FCPXML 工程目录同一条路）。 */
        openDir(dir);
        json(200, { ok: true, dir });
      } catch (e) { json(500, { error: { message: '打不开目录：' + e.message } }); }
      return true;
    }
    if (req.method === 'POST' && !where) {
      readBody(req, res, 4 * 1024 * 1024).then(raw => {
        if (raw == null) return;
        let f = null;
        try { f = JSON.parse(raw.toString('utf8')); } catch { return json(400, { error: { message: '请求体不是合法 JSON' } }); }
        if (!f || typeof f !== 'object') return json(400, { error: { message: '请求体不是对象' } });
        const prompt = String(f.prompt == null ? '' : f.prompt);
        if (!prompt.trim()) return json(400, { error: { message: '提示词是空的' } });
        const now = new Date();
        const rawTitle = oneLine(f.title).slice(0, 80) || oneLine(prompt).slice(0, 10);
        const rawType = oneLine(f.type).slice(0, 40) || '任务';
        const provider = oneLine(f.provider).slice(0, 60);
        const model = oneLine(f.model).slice(0, 80);
        const task = oneLine(f.task).slice(0, 100);
        const title = fileSafe(rawTitle, 60) || '未命名';
        const type = fileSafe(rawType, 24) || '任务';
        const meta = (f.meta && typeof f.meta === 'object') ? f.meta : {};
        const metaKeys = Object.keys(meta).filter(k => {
          const v = meta[k];
          return v !== undefined && v !== null && v !== '' && typeof v !== 'object';
        });
        try { fs.mkdirSync(dir, { recursive: true }); }
        catch (e) { return json(500, { error: { message: '建不了目录（' + dir + '）：' + e.message } }); }
        const base = dirStamp(now) + '-' + type + '-' + title;
        const fm = ['---', 'title: ' + rawTitle, 'type: ' + rawType, 'ts: ' + now.getTime(), 'time: ' + timeText(now)];
        if (provider) fm.push('provider: ' + provider);
        if (model) fm.push('model: ' + model);
        if (task) fm.push('task: ' + task);
        metaKeys.forEach(k => fm.push(fileSafe(k, 24) + ': ' + oneLine(meta[k]).slice(0, 120)));
        fm.push('---');
        const body = ['', '# ' + rawTitle, ''].concat([
          '- 类型：' + rawType, '- 时间：' + timeText(now),
          provider ? '- 平台：' + provider : '', model ? '- 模型：' + model : '', task ? '- 任务号：' + task : '',
        ].filter(Boolean)).concat(metaKeys.map(k => '- ' + k + '：' + oneLine(meta[k])))
          .concat(['', '## 提示词', '', prompt.trim(), '']).join('\n');
        let file = '', wrote = false;
        for (let n = 1; n <= 50 && !wrote; n++) {
          const cand = base + (n === 1 ? '' : '-' + n) + '.md';
          try { fs.writeFileSync(path.join(dir, cand), fm.join('\n') + '\n' + body, { flag: 'wx' }); file = cand; wrote = true; }
          catch (e) { if (e && e.code === 'EEXIST') continue; return json(500, { error: { message: '写不进文件（' + dir + '）：' + e.message } }); }
        }
        if (!wrote) return json(500, { error: { message: '同一个名字的归档太多（' + base + '），换一个标题再存' } });
        forgetDirScan(dir);
        const row = { f: file, t: rawTitle, k: rawType, ts: now.getTime(), p: provider, m: model,
          i: task, pr: oneLine(prompt).slice(0, 300) };
        updateIndex(dir, () => writePromptIndex(dir, [row].concat(promptRows(dir).filter(r => r.f !== file))))
          .catch(e => log('[prompts] 索引更新失败：' + e.message))
          .finally(() => json(200, { ok: true, dir, file, path: path.join(dir, file), title, type }));
      });
      return true;
    }
    if (req.method === 'POST' && (where === 'export' || where === 'import')) {
      readBody(req, res, 128 * 1024 * 1024).then(async raw => {
        if (raw == null) return;
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(400, { error: { message: '请求体不是合法 JSON' } }); }
        if (where === 'export') {
          const all = promptFileList(dir);
          const files = [];
          let bytes = 0, skipped = 0;
          for (const f of all) {
            if (files.length >= PROMPT_PACK_MAX_FILES || bytes >= PROMPT_PACK_MAX_BYTES) { skipped++; continue; }
            try { const text = fs.readFileSync(path.join(dir, f.name), 'utf8'); bytes += text.length; files.push({ name: f.name, text }); }
            catch (e) { skipped++; }
          }
          return json(200, { ok: true, dir, count: files.length, total: all.length, skipped, bytes, files,
            message: '归档 ' + files.length + ' 份' + (skipped ? '（还有 ' + skipped + ' 份因为超出上限没带上）' : '') + '，压缩后存进备份文件' });
        }
        const list = Array.isArray(body.files) ? body.files : [];
        let ok = 0, dup = 0, bad = 0;
        const errs = [];
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(500, { error: { message: '建不了目录（' + dir + '）：' + e.message } }); }
        for (const it of list) {
          const name = String((it && it.name) || '');
          if (!/^[^\\/:*?"<>|\u0000-\u001f]+\.md$/i.test(name) || name === '_index.md') { bad++; continue; }
          try { fs.writeFileSync(path.join(dir, name), String(it.text == null ? '' : it.text), { flag: 'wx' }); ok++; }
          catch (e) { if (e && e.code === 'EEXIST') { dup++; continue; } bad++; if (errs.length < 5) errs.push(name + '（' + e.message + '）'); }
        }
        await updateIndex(dir, () => rebuildPromptIndex(dir)).catch(e => log('[prompts] 索引重建失败：' + e.message));
        json(200, { ok: true, dir, restored: ok, dup, bad, errors: errs,
          message: '恢复归档 ' + ok + ' 份' + (dup ? '，' + dup + ' 份本机已有同名（没覆盖）' : '') + (bad ? '，' + bad + ' 份没恢复' : '') });
      });
      return true;
    }
    json(405, { error: { message: '不支持的请求：' + req.method + ' ' + urlObj.pathname } });
    return true;
  }
  function restorePromptFiles(list) {
    const dir = promptsDefaultDir();
    let restored = 0, dup = 0, bad = 0;
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { throw new Error('建不了归档目录（' + dir + '）：' + e.message); }
    for (const it of (Array.isArray(list) ? list : [])) {
      const name = String((it && it.name) || '');
      if (!/^[^\\/:*?"<>|\u0000-\u001f]+\.md$/i.test(name) || name === '_index.md') { bad++; continue; }
      try { fs.writeFileSync(path.join(dir, name), String(it.text == null ? '' : it.text), { flag: 'wx' }); restored++; }
      catch (e) { if (e && e.code === 'EEXIST') { dup++; continue; } bad++; }
    }
    try { rebuildPromptIndex(dir); } catch (e) { log('[prompts] 恢复后索引重建失败：' + e.message); }
    return { restored, dup, bad };
  }
  return { promptsDefaultDir, promptsDir, promptCloudDir, promptFileList, promptRows,
    handlePrompts, parseFrontMatter, restorePromptFiles };
}

/* ===== 云同步（WebDAV）===== */

/* 云端地址的最后一档：页面没填、.env 也没写时就用它。文件夹名跟仓库名一致（imago）。
   这是全项目唯一一份默认地址 —— 设置页只从 /cloud/status 拿回去做提示，不再自己写一遍，
   也不再把它预填进输入框（预填等于「页面填了」，会把 .env 里的地址压掉）。 */
const CLOUD_DEFAULT_URL = 'https://dav.jianguoyun.com/dav/imago/';

/* 云同步（/cloud）—— WebDAV 推送 / 拉取 / 冲突与基线。
   每一格的优先级：请求头（设置页填，存浏览器、只发给本地代理）> .env 的 CLOUD_WEBDAV_*
   > 上面那份内置默认（只有地址这一格有）。路由与文件操作都在这里；
   数据键读写走本文件状态仓的 readKey / writeKey，归档走本文件的提示词段。
   handleCloud 返回 true = 已处理。 */

function createCloudStore(opts) {
  const log = opts.log || (() => {});
  const anyRequest = opts.anyRequest;
  const guardOutboundUrl = opts.guardOutboundUrl;
  const readBody = opts.readBody;
  const dataDirPath = opts.dataDirPath;
  const dataFileOf = opts.dataFileOf;
  const dataList = opts.dataList;
  const dataWriteRaw = opts.dataWriteRaw;
  const promptCloudDir = opts.promptCloudDir;
  const promptFileList = opts.promptFileList;
  const readKey = opts.readKey;
  const writeKey = opts.writeKey;
  const getBackup = opts.getBackup || (() => null);
  const cloudStateKey = opts.cloudStateKey || CLOUD_STATE_KEY;
  const cloudBaseKey = opts.cloudBaseKey || CLOUD_BASE_KEY;

async function cloudCfg(req) {
  const h = req.headers;
  const pick = (hdr, env) => String(h[hdr] || process.env[env] || '').trim();
  /* 三档里的最后一档：页面留空、env 也没写地址时，用仓库同名的默认目录。
     账号与应用密码没有默认值，缺了照样当场报错，不会拿空凭据去试。 */
  const url = (pick('x-cloud-url', 'CLOUD_WEBDAV_URL') || CLOUD_DEFAULT_URL).replace(/\/+$/, '');
  const user = pick('x-cloud-user', 'CLOUD_WEBDAV_USER');
  const pass = String(h['x-cloud-pass'] || process.env.CLOUD_WEBDAV_PASS || '');
  // 必须 https（明文 http 会把账号密码暴露在网上）；只有本机回环地址例外，方便自建 WebDAV 调试
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
  if (!loopback && !/^https:\/\//i.test(url)) {
    throw new Error('云端地址必须是 https://（用明文 http 传 WebDAV 会把账号密码暴露在网上）');
  }
  if (!user || !pass) throw new Error('云同步需要账号与应用密码（坚果云请在「安全选项」里生成应用密码）');
  let checked = url;
  if (!loopback) {
    /* 光看协议不够：一个解析到内网 / 回环的公网域名照样能拿到 WebDAV 账号密码。
       出站前过与其它通道同一份护栏（含 DNS）。 */
    try { checked = String(await guardOutboundUrl(url)).replace(/\/+$/, ''); }
    catch (e) { throw new Error('云端地址不可用：' + e.message); }
  }
  return { url: checked, user, pass };
}
const cloudAuth = cfg => 'Basic ' + Buffer.from(cfg.user + ':' + cfg.pass, 'utf8').toString('base64');
/* sub 为空 = 操作基地址本身；asCollection=true 时给目标补上结尾的 / ——
   WebDAV 里「集合」的规范写法就是带斜杠，MKCOL 不带会被多数服务端当成对已存在资源的请求
   （返回 409/404），目录建不出来，之后所有 PUT 都会 404。 */
function cloudRequest(cfg, method, sub, headers, body, asCollection) {
  return new Promise((resolve, reject) => {
    const base = cfg.url + (sub ? '/' + String(sub).replace(/^\/+/, '') : '');
    const target = (asCollection && !base.endsWith('/')) ? base + '/' : base;
    const up = anyRequest(target, {
      method,
      headers: { Authorization: cloudAuth(cfg), 'User-Agent': 'local-workbench', ...(headers || {}) },
    }, ur => {
      const bufs = [];
      ur.on('data', c => bufs.push(c));
      ur.on('end', () => resolve({ status: ur.statusCode, body: Buffer.concat(bufs) }));
      ur.on('error', e => reject(new Error('云同步读取失败：' + e.message)));
    });
    up.on('error', e => reject(new Error('连不上云端：' + e.message)));
    up.end(body || undefined);
  });
}
/* WebDAV 的 PROPFIND 响应是 XML，这里只取我们需要的三个信息（文件名 / 修改时间 / 大小）。
   命名空间前缀各服务商不一样（d: / D: / 无），所以按标签尾巴匹配。 */
/* Windows / POSIX 都不允许出现在文件名里的字符 + 控制字符：远端给的那一段先过这一道。 */
const ILL_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/;
/* 把云端 href 里那一段解成**能安全落盘的文件名**，不合格就回空串（调用方跳过并计数）。
   顺序必须是「按编码好的路径切段 → 解码那一段 → 再验一次它还是一个纯文件名」：
   反过来先解码整条 href，`..%2F..%2Fevil.md` 里的 `%2F` 就变成分隔符，切段这一步形同虚设，
   拉取会写到 PROMPTS_DIR 之外（数据键那一条有 DATA_KEY_RE，md 这一条以前什么都没判）。 */
function remoteNameOf(href) {
  const seg = String(href || '').trim().replace(/\/+$/, '').split('/').pop() || '';
  let name = '';
  try { name = decodeURIComponent(seg); } catch { return ''; }        // 解不动的段本来就不是合法文件名
  if (!name || name === '.' || name === '..') return '';
  if (name !== path.basename(name) || ILL_NAME_RE.test(name)) return '';
  return name;
}
/* kind='data'（默认）只收 .json 并按 DATA_KEY_RE 过滤键名 —— 数据键那套判据；
   kind='md' 收 .md，键就是文件名 —— 提示词归档用。**不能只收 .json**：
   那样云端明明有那几份归档、这边却每次都当「云端没有」重新传一遍（传得越多越慢，
   而且真出问题时会被淹没在一堆重复上传里）。 */
function parseDavList(xml, kind) {
  const md = kind === 'md';
  const out = new Map();
  out.skipped = 0;              // 名字不合格（越界 / 非法字符）被跳过的条数：不能静默吞掉
  const blocks = String(xml).match(/<[a-zA-Z0-9]*:?response[\s>][\s\S]*?<\/[a-zA-Z0-9]*:?response>/g) || [];
  for (const b of blocks) {
    if (/<[a-zA-Z0-9]*:?collection\s*\/?>/.test(b)) continue;                 // 目录本身跳过
    const href = (/<[a-zA-Z0-9]*:?href>([\s\S]*?)<\/[a-zA-Z0-9]*:?href>/.exec(b) || [])[1] || '';
    const name = remoteNameOf(href);
    if (!name) { out.skipped++; continue; }
    let key;
    if (md) {
      if (!/\.md$/i.test(name)) continue;
      key = name;
    } else {
      if (!name.endsWith('.json')) continue;
      key = name.slice(0, -5);
      if (!DATA_KEY_RE.test(key)) continue;
    }
    const lm = (/<[a-zA-Z0-9]*:?getlastmodified>([\s\S]*?)<\/[a-zA-Z0-9]*:?getlastmodified>/.exec(b) || [])[1] || '';
    const len = (/<[a-zA-Z0-9]*:?getcontentlength>(\d+)</.exec(b) || [])[1];
    const t = Date.parse(lm.trim());
    out.set(key, { mtime: isNaN(t) ? 0 : t, size: len ? Number(len) : 0 });
  }
  return out;
}
/* 确保云端目录存在：先 PROPFIND 问一下，不存在才 MKCOL 建（带斜杠）。
   建不出来就**直接报错并给出可操作的下一步** —— 以前这里只写日志、继续往下走，
   结果上传时每个文件都 404，界面上只看到一句「上传 ai_usage 失败 HTTP 404」，很难猜到是目录不存在。 */
async function cloudEnsureDir(cfg) {
  const probe = await cloudRequest(cfg, 'PROPFIND', '', { Depth: '0', 'Content-Type': 'application/xml' });
  if (probe.status === 401 || probe.status === 403) throw new Error('云端拒绝访问（' + probe.status + '）：账号或应用密码不对');
  if (probe.status < 400) return true;                                  // 目录已在
  if (probe.status !== 404) throw new Error('云端路径不对：PROPFIND 返回 ' + probe.status + '（检查地址是否写错）');
  const mk = await cloudRequest(cfg, 'MKCOL', '', { 'Content-Length': 0 }, undefined, true);
  if (mk.status < 400 || mk.status === 405) return true;                // 405 = 已存在
  throw new Error('云端目录不存在，自动创建也失败（MKCOL 返回 ' + mk.status + '）。'
    + '有些网盘不允许通过 WebDAV 建目录，请先在网盘网页端手动建好这个目录：' + cfg.url);
}
/* ============================================================================
   提示词归档 → 云端（默认不勾，跟着 push/pull/sync 一起走）
   ---------------------------------------------------------------------------
   归档是**只增不改**的一份份 `.md`：文件名带时间戳、落盘用独占创建（`wx`），
   所以「文件名」就是它的身份 —— 同步因此比数据键那一套简单得多，也安全得多：
     同名同内容 → 跳过；只有本机有 → 传；只有云端有 → 下载。
   **永远不删云端那份。** 归档是一份只增的创作历史，误删一整份提示词没法恢复；
   而「本机删了、云端也跟着删」要判对必须先有基线/墓碑，那是数据键那套才值得上的机制。
   这里不引入它：云端多出来的只**报数量**，由用户自己决定要不要拉下来。
   （`_index.json` 是派生索引，本机重建就行，不上传 —— 传了反而可能把另一台机器的条目带歪。）
   ========================================================================== */
const PROMPT_CLOUD_SUB = 'prompts';
const PROMPT_CLOUD_MAX = 20000;        // 单次最多传多少份，防一个跑飞的目录把网盘塞满
/* 目录校验与文件清单只在本文件这一处（同源参数也要过同一道校验）。 */
async function cloudEnsureSub(cfg, sub) {
  const probe = await cloudRequest(cfg, 'PROPFIND', sub, { Depth: '0', 'Content-Type': 'application/xml' });
  if (probe.status < 400) return true;
  if (probe.status === 401 || probe.status === 403) throw new Error('云端拒绝访问（' + probe.status + '）');
  if (probe.status !== 404) return false;                       // 有些网盘不给子目录 PROPFIND，试试直接写
  const mk = await cloudRequest(cfg, 'MKCOL', sub, { 'Content-Length': 0 });
  return mk.status < 400 || mk.status === 405;
}
async function cloudListSub(cfg, sub) {
  if (!(await cloudEnsureSub(cfg, sub))) return new Map();
  const r = await cloudRequest(cfg, 'PROPFIND', sub, { Depth: '1', 'Content-Type': 'application/xml' });
  if (r.status === 401 || r.status === 403) throw new Error('云端拒绝访问（' + r.status + '）');
  if (r.status === 404) return new Map();
  if (r.status >= 400) return new Map();                        // 列不出来就当没有：只会上传，不会误删
  return parseDavList(r.body.toString('utf8'), 'md');
}
/* 返回 { up, down, same, onlyRemote, failed[] }，**不删任何东西** */
async function cloudSyncPrompts(cfg, dir, cmd) {
  const out = { up: 0, down: 0, same: 0, onlyRemote: 0, skipped: 0, failed: [] };
  const dirOk = await cloudEnsureSub(cfg, PROMPT_CLOUD_SUB);
  if (!dirOk) { out.failed.push('云端建不出 ' + PROMPT_CLOUD_SUB + '/ 目录（有些网盘不允许 WebDAV 建目录，请在网盘网页端手动建一个）'); return out; }
  let remote = new Map();
  try { remote = await cloudListSub(cfg, PROMPT_CLOUD_SUB); }
  catch (e) { out.failed.push('列云端归档失败：' + e.message); return out; }
  if (remote.skipped) {
    out.skipped += remote.skipped;
    log('[cloud] 云端有 ' + remote.skipped + ' 条归档名字不合格（越界 / 非法字符），已跳过不下载');
  }
  const local = promptFileList(dir);
  const byName = new Map(local.map(f => [f.name, f]));
  for (const f of local) {
    const finfo = remote.get(f.name) || null;
    /* 「一致」先判，模式后判：这样 same 在三种模式下都是「两边一模一样」这一个意思，
       pull 模式下也能如实报出「云端已有的那几份没动」。 */
    if (finfo && Number(finfo.size) === f.size) { out.same++; continue; }   // 同名同大小：归档不会被改写，不必下载比对
    if (cmd === 'pull') { out.skipped++; continue; }            // 只下载：本地那份不动
    if (out.up >= PROMPT_CLOUD_MAX) { out.skipped++; continue; }
    try {
      const buf = fs.readFileSync(path.join(dir, f.name));
      const putOnce = () => cloudRequest(cfg, 'PUT', PROMPT_CLOUD_SUB + '/' + encodeURIComponent(f.name),
        { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': buf.length }, buf);
      let r = await putOnce();
      if (r.status === 404 || r.status === 409) { await cloudEnsureSub(cfg, PROMPT_CLOUD_SUB); r = await putOnce(); }
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      out.up++;
    } catch (e) { out.failed.push(f.name + '（' + e.message + '）'); }
  }
  for (const [name, info] of remote) {
    if (byName.has(name)) continue;
    if (cmd === 'push') { out.onlyRemote++; continue; }        // 只上传：如实报「云端有本机没有」，不往本机写
    try {
      /* 落盘前再判一次范围：清单那一道闸已经过了，这里防的是「目录参数被换成别的」之后
         两个解析口径不一致。flag 用 wx 只防覆盖，不防越界。 */
      const root = path.resolve(dir);
      const full = path.resolve(root, name);
      if (path.dirname(full) !== root) { out.skipped++; log('[cloud] 归档名越界，已跳过：' + name); continue; }
      const got = await cloudRequest(cfg, 'GET', PROMPT_CLOUD_SUB + '/' + encodeURIComponent(name), {});
      if (got.status !== 200) throw new Error('HTTP ' + got.status);
      /* 独占创建：万一本机刚生成了同名的一份，绝不把它盖掉（归档丢了比多一份严重得多） */
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(full, got.body, { flag: 'wx' });
      out.down++;
    } catch (e) { if (!e || e.code !== 'EEXIST') { out.onlyRemote++; out.failed.push(name + '（' + (e && e.message) + '）'); } }
  }
  return out;
}
/* 读某个数据文件里的写入时间（ts）：判「谁更新」只认它，不认文件 mtime *//* 从一份数据内容里取写入时间 ts（裸数组/字符串那种老格式没有 ts → 0） */
function tsOfBuf(buf) {
  try { const v = JSON.parse(buf.toString('utf8')); return (v && typeof v === 'object' && !Array.isArray(v) && v.ts) ? Number(v.ts) || 0 : 0; } catch { return 0; }
}
async function cloudList(cfg) {
  await cloudEnsureDir(cfg);
  const r = await cloudRequest(cfg, 'PROPFIND', '', { Depth: '1', 'Content-Type': 'application/xml' });
  if (r.status === 401 || r.status === 403) throw new Error('云端拒绝访问（' + r.status + '）：账号或应用密码不对');
  if (r.status >= 400) throw new Error('列目录失败 HTTP ' + r.status);
  return parseDavList(r.body.toString('utf8'));
}

const cloudState = { lastAt: 0, lastResult: '', conflicts: [], unread: [], lastUp: 0, lastDown: 0 };
const CLOUD_STATE_BODY = s => JSON.stringify({ ts: Date.now(), ui: { at: s.lastAt, result: s.lastResult, conflicts: s.conflicts || [], unread: s.unread || [], up: s.lastUp || 0, down: s.lastDown || 0 } });
/* 结果状态（ui）与同步基线（每个键的指纹）是两码事，分两份文件：
   写基线时不用先把 ui 那一半读回来再合并 —— 一次 read-modify-write 漏读就是「同步一次把上次的诊断抹掉」。 */
function cloudStateFileRead() {
  try { const raw = readKey(cloudStateKey); return raw ? (JSON.parse(raw) || {}) : {}; } catch { return {}; }
}
function cloudStateSave() {
  try { writeKey(cloudStateKey, CLOUD_STATE_BODY(cloudState)); }
  catch (e) { log('[cloud] 状态写入失败：' + e.message); }
}
/* 赋值 + 落盘一次（调用方只管说「现在是什么样」，不要自己记着还要写盘） */
function cloudStateSet(patch) {
  Object.assign(cloudState, patch || {});
  cloudStateSave();
}
function cloudStateLoad() {
  const ui = cloudStateFileRead().ui;
  if (!ui || typeof ui !== 'object') return;
  cloudState.lastAt = Number(ui.at) || 0;
  cloudState.lastResult = String(ui.result || '');
  cloudState.conflicts = Array.isArray(ui.conflicts) ? ui.conflicts : [];
  cloudState.unread = Array.isArray(ui.unread) ? ui.unread : [];
  cloudState.lastUp = Number(ui.up) || 0;
  cloudState.lastDown = Number(ui.down) || 0;
}

/* ============================================================================
   云同步的「计划」：先判定每个键该怎么动，再执行
   ---------------------------------------------------------------------------
   冲突判定靠**基线**：状态仓的 `__cloud_baseline` 键记着上次成功同步时每个键的内容指纹。
     · 只有本机变过（指纹 != 基线）→ 上传
     · 只有云端变过          → 下载
     · 两边都没变            → 跳过
     · **两边都变过**（都 != 基线且彼此不同）→ 冲突：不自动覆盖，列出来让用户选一边
   没有基线时（第一次同步 / 基线被删）退回老的「按内容 ts 取新」策略，
   但会在结果里标成「自动采用较新」让用户知道这次是猜的；同步成功后基线就建起来了。
   为什么要基线：只看修改时间取新，等于「两边都改过」时静默丢弃一边 —— 用户不知道哪份数据被顶掉了。
   ========================================================================== */
/* 只有「这份文件还没建过」（ENOENT）才叫第一次同步、回空表；
   读不动 / 内容坏了回 null —— 调用方必须中止本次同步：把坏基线当空表走「取较新」，
   等于用本机这份（可能是旧的）去覆盖云端较新的那份，而且一句冲突都不报。 */
function cloudBaselineRead() {
  let raw = null;
  try { raw = readKey(cloudBaseKey); }
  catch (e) { log('[cloud] 基线读不出来：' + e.message); return null; }
  if (raw == null) return {};
  let v = null;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || !v.keys || typeof v.keys !== 'object') {
    log('[cloud] 基线内容不像一份基线（可能是手工改过，也可能被截断）');
    return null;
  }
  return v.keys;
}
function cloudBaselineWrite(keys) {
  try { writeKey(cloudBaseKey, JSON.stringify({ ts: Date.now(), keys })); return true; }
  catch (e) { log('[cloud] 基线写入失败：' + e.message); return false; }
}
/* 基线的读-改-写整段排队：并发两次同步时，后写回的那一份是基于它自己读到的旧表算的，
   会把前一次刚记进去的指纹抹掉 —— 表现是「同步明明成了，下次又把同一批键列成冲突」。 */
let cloudTx = Promise.resolve();
function cloudExclusive(fn) {
  const run = cloudTx.then(fn);
  cloudTx = run.then(() => null, () => null);
  return run;
}
const sha1Of = buf => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
/* 只在本机有意义的派生数据：换台机器拉回来要么没用、要么会把本机状态顶掉。
   · asr / asr-jobs：识别任务与结果属于这一台机器上的媒体文件；
   · search：联网搜索的短缓存，过期即丢；
   · render-jobs：老版本留下的本机导出账本（服务端已不再产生），别跟着云走到另一台机器。 */
const CLOUD_SKIP_KEYS = new Set(['asr', 'asr-jobs', 'search', 'render-jobs']);
/* 拉两边现状，给出每个键的动作：
   action: same | push | pull | delete-remote | conflict | push-auto | pull-auto | error
   localBuf / remoteBuf 一并带上（判方向和执行都要用，避免重复下载） */
async function cloudPlan(cfg, withKeys, base) {
  const remote = await cloudList(cfg);
  const locals = new Map(dataList().map(f => [f.key, f]));
  const isKeyFile = k => k.startsWith('sk_key_');
  const items = [];
  for (const key of new Set([...remote.keys(), ...locals.keys()])) {
    if (CLOUD_SKIP_KEYS.has(key)) continue;
    if (!withKeys && isKeyFile(key)) continue;
    /* 本地这份读不下来（被占用 / 权限 / 半个文件）时要和「本地确实没有」区分开：
       都当成「没有」的话，下面会判成 delete-remote 把云端那份好数据删掉。 */
    let localBuf = null, localErr = '';
    if (locals.has(key)) {
      try { const raw = readKey(key); localBuf = raw == null ? null : Buffer.from(raw); }
      catch (e) { localErr = '本机数据文件读不下来：' + e.message; }
    }
    const remoteInfo = remote.get(key) || null;
    let remoteBuf = null, remoteErr = '';
    if (remoteInfo) {
      try {
        const got = await cloudRequest(cfg, 'GET', key + '.json', {});
        if (got.status === 200) remoteBuf = got.body;
        else remoteErr = 'HTTP ' + got.status;
      } catch (e) { remoteErr = e.message; }
    }
    const it = { key, localBuf, remoteBuf, remoteInfo, remoteErr, localErr,
      /* 时间只用来看和显示（判方向靠基线）：内容里没有 ts（纯字符串值 / 裸数组老格式）时
         退回文件修改时间 —— 否则冲突列表里两边都是"—"，用户没法判断谁更新。 */
      localTs: localBuf ? (tsOfBuf(localBuf) || Math.round(locals.get(key).mtime)) : 0,
      remoteTs: remoteBuf ? (tsOfBuf(remoteBuf) || (remoteInfo ? Math.round(remoteInfo.mtime) : 0)) : 0 };
    items.push(Object.assign(it, { action: cloudClassify(it, base[key] || null) }));
  }
  return items;
}
function cloudClassify(it, base) {
  const l = it.localBuf, r = it.remoteBuf;
  /* 远端**存在但没读下来**（网络抖动 / 401 / 超时）：绝不能当成「本地独有」去 push ——
     那会用本地旧数据覆盖云端较新的一份（无冲突提示、云端也没有 .bak）。判成 error 跳过这个键。 */
  if (it.remoteErr || it.localErr) return 'error';
  if (!l && !r) return 'same';
  if (!r) return 'push';
  /* 本地没有、云端有：
     · 基线里有这个键 = 这台机器曾经同步过这份数据，现在它没了 → 用户在本地删了它，
       删除也要镜像到云端（否则下次同步又把它拉回来，「删不掉」）。
     · 基线里没有 = 换了机器 / 清空过 .data → 这是要**恢复**的数据，从云端拉回来。
     这两种情况长得一样，只有基线能区分，所以没有基线时绝不做删除。 */
  if (!l) return base && base.h ? 'delete-remote' : 'pull';
  if (Buffer.compare(l, r) === 0) return 'same';
  if (base && base.h) {
    const lc = sha1Of(l) !== base.h, rc = sha1Of(r) !== base.h;
    if (lc && rc) return 'conflict';
    if (lc) return 'push';
    if (rc) return 'pull';
    return 'conflict';                 // 都等于基线却又不同：基线过期 / 手工改过 → 交给用户
  }
  // 没有基线：按内容里的写入时间猜（结果里会标注是自动决定的）
  const lt = it.localTs || 0, rt = it.remoteTs || (it.remoteInfo ? it.remoteInfo.mtime : 0) || 0;
  if (rt && lt && rt > lt + 1000) return 'pull-auto';
  if (lt && rt && lt > rt + 1000) return 'push-auto';
  return 'conflict';
}
/* 上传（404/409 会重建目录重试一次）；返回 true 表示成功 */
async function cloudPushKey(cfg, key, buf) {
  const putOnce = () => cloudRequest(cfg, 'PUT', key + '.json', { 'Content-Type': 'application/json', 'Content-Length': buf.length }, buf);
  let put = await putOnce();
  if (put.status === 404 || put.status === 409) { await cloudEnsureDir(cfg); put = await putOnce(); }
  if (put.status >= 400) throw new Error('上传 ' + key + ' 失败 HTTP ' + put.status
    + (put.status === 401 || put.status === 403 ? '（账号或应用密码不对）' : '（检查云端目录是否存在）'));
  return true;
}
/* 删除云端的一份（本地删除的镜像）。404 当作「本来就没有」= 成功。 */
async function cloudDeleteKey(cfg, key) {
  const d = await cloudRequest(cfg, 'DELETE', key + '.json', {});
  if (d.status >= 400 && d.status !== 404) throw new Error('删除云端 ' + key + ' 失败 HTTP ' + d.status);
  return true;
}
function cloudPullKey(key, remoteBuf) {
  if (getBackup()) getBackup().createSnapshot('before-cloud-pull', { key });
  dataWriteRaw(key, remoteBuf);
}
/* 清单接口：给设置页展示「云端有哪些、本地有哪些、各自多大/多新」 */
function cloudBackups() {
  return getBackup() ? getBackup().list() : [];
}

/* ---------- /cloud 的一组路由（/data 在 本文件；返回 true 表示已处理） ---------- */
function handleCloud(req, res, urlObj) {
  /* catch 里写头之前必须判一次：readBody 撞 413 时响应已经发出去了，这里再 writeHead 就是
     ERR_HTTP_HEADERS_SENT —— 这个异常没人接，进程级报 unhandledRejection，界面上只看到「同步中」不动。 */
  const replyErr = e => {
    const m = (e && e.message) || String(e);
    if (res.headersSent || res.writableEnded) { log('[cloud] 响应已经发出，错误只记日志：' + m); try { res.end(); } catch {} return; }
    /* 分档：本地参数 / 配置问题才是 400；云端连不上是 502；等不到是 504。
       以前一律 400，设置页与外部调用方都会把「云端超时」当成「你填错了」。 */
    const code = String((e && (e.code || e.name)) || '');
    const timeout = /ETIMEDOUT|ESOCKETTIMEDOUT|ABORT_ERR/i.test(code) || /超时|timed?\s*out/i.test(m);
    const net = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE/i.test(code + ' ' + m)
      || /连不上云端|云同步读取失败|\bHTTP 5\d\d\b/i.test(m);
    const httpStatus = timeout ? 504 : (net ? 502 : 400);
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: m } }));
  };
  /* 基线读不出来时统一的一句话：三份 handler 都要用，别说成三种口径。 */
  const baseOrThrow = () => {
    const base = cloudBaselineRead();
    if (!base) throw new Error('云同步基线（状态仓的 __cloud_baseline 键）读不出来或内容坏了：本次不动任何数据。'
      + '到「数据与备份」从快照恢复，或删掉这一格让下一次同步按「首次同步」重建基线。');
    return base;
  };
  /* ---------- 云同步 ---------- */
  if (req.url.startsWith('/cloud')) {
    /* 命令必须精确匹配 /cloud/<cmd>（/cloud 本身 = status）。
       以前用 replace('/cloud','') 取子路径 —— /cloudsync、/cloudresolve、/cloudpull 这类
       「撞名路径」也会命中，而 LOCAL_ONLY 的同源检查要求 cloud 后面是 /、? 或串尾，
       于是这些路径**绕过同源保护**就能触发云同步（还会带着 .env 里的 WebDAV 凭据出网）。 */
    const pn = urlObj.pathname;
    const cmd = pn === '/cloud' ? 'status' : (/^\/cloud\/[A-Za-z]+$/.test(pn) ? pn.slice('/cloud/'.length) : '');
    if (!cmd) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '没有这条云同步命令：' + pn + '（路径必须精确写成 /cloud/<命令>）' } }));
      return true;
    }
    if (cmd === 'status' && req.method === 'GET') {
      /* 判的是「凭据是否在代理侧」，不是「地址写在哪」：地址常常由页面给（设置页总会带上
         默认地址），账号与应用密码才可能留在 .env / 环境变量里。把 URL 也算进来，会出现
         用户明明在 .env 配好了账号密码、只因 URL 留空，界面就永远不显示「凭据已配置」。 */
      const hasEnv = !!(process.env.CLOUD_WEBDAV_USER && process.env.CLOUD_WEBDAV_PASS);
      let prompts = null;
      try { const d = promptCloudDir(urlObj.searchParams.get('dir')); prompts = { dir: d, count: promptFileList(d).length }; }
      catch (e) { prompts = { error: e.message }; }
      /* 数据目录读不出来时这里绝不能报 0 份：设置页据此会显示「本地没有数据」，
         用户接着点同步就把一个「读不出」当成了「本机为空」。 */
      let files;
      try { files = dataList(); } catch (e) {
        log('[cloud] ' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { message: e.message }, degraded: true }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        dir: dataDirPath(), files: files.length, degraded: false,
        envConfigured: hasEnv, defaultUrl: CLOUD_DEFAULT_URL,
        lastAt: cloudState.lastAt, lastResult: cloudState.lastResult,
        conflicts: cloudState.conflicts || [], lastUp: cloudState.lastUp || 0, lastDown: cloudState.lastDown || 0,
        unread: cloudState.unread || [], prompts,
      }));
      return true;
    }
    /* 冲突二选一：{ key, side:'local'|'remote' } —— 选本机就上传覆盖云端，选云端就下载覆盖本机 */
    if (cmd === 'resolve' && req.method === 'POST') {
      cloudExclusive(async () => {
        try {
          const cfg = await cloudCfg(req);
          const raw = await readBody(req, res, 1 * 1024 * 1024);
          if (raw == null) return;
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const key = String(body.key || '');
          const side = String(body.side || '');
          if (!DATA_KEY_RE.test(key)) throw new Error('非法的数据键名：' + key);
          if (side !== 'local' && side !== 'remote') throw new Error('side 只能是 local 或 remote');
          const base = baseOrThrow();
          const backups = [];
          if (side === 'local') {
            const localRaw = readKey(key);
            if (localRaw == null) throw new Error('本机没有这份数据：' + key);
            const buf = Buffer.from(localRaw);
            await cloudPushKey(cfg, key, buf);
            base[key] = { h: sha1Of(buf), ts: Date.now() };
            log('[cloud] 冲突解决：' + key + ' → 用本机覆盖云端');
          } else {
            await cloudEnsureDir(cfg);
            const got = await cloudRequest(cfg, 'GET', key + '.json', {});
            if (got.status !== 200) throw new Error('云端读不到这份数据 HTTP ' + got.status);
            cloudPullKey(key, got.body);
            base[key] = { h: sha1Of(got.body), ts: Date.now() };
            log('[cloud] 冲突解决：' + key + ' → 用云端覆盖本机（覆盖前已备份 .bak.json）');
          }
          cloudBaselineWrite(base);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, side, backups,
            message: (side === 'local' ? '已用本机版本覆盖云端：' : '已用云端版本覆盖本机（已留备份）：') + key }));
        } catch (e) {
          replyErr(e);
        }
      });
      return true;
    }
    if (cmd === 'test' || cmd === 'push' || cmd === 'pull' || cmd === 'sync') {
      cloudExclusive(async () => {
        try {
          const cfg = await cloudCfg(req);
          /* 提示词归档默认不传（body 里带 prompts:1 才走）。归档里是创作正文，
             比设置更不该默认出网；但它又恰恰是**丢了就没了**的那类东西（本地 .md 不进整包备份），
             所以给一个明确的开关，而不是替用户决定。
             body 放在最前面读：「测试连接」也要用它，好让「测一下」真的测出备份能不能成，
             而不是只测出一个连得上、传上去照样失败的假通过。 */
          let body = {};
          /* readBody 回 null = 它已经替这次请求发过 413/400 了：必须立刻收手，
             再往下跑就是一次完整的云同步 + 第二次 writeHead（进程级抛错）。
             JSON 解析失败可以当空 body，读体失败不行 —— 两者不能混在一个 try 里。 */
          const raw = await readBody(req, res, 256 * 1024);
          if (raw == null) return;
          try { if (raw.length) body = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { body = {}; }
          if (cmd === 'test') {
            await cloudEnsureDir(cfg);
            const list = await cloudList(cfg);
            let msg = '连接正常（云端已有 ' + list.size + ' 份数据）';
            let prompts = null;
            if (body.prompts) {
              try {
                const pdir = promptCloudDir(body.promptDir);
                const local = promptFileList(pdir).length;
                const subOk = await cloudEnsureSub(cfg, PROMPT_CLOUD_SUB);
                const remote = subOk ? await cloudListSub(cfg, PROMPT_CLOUD_SUB) : new Map();
                prompts = { dir: pdir, local, remote: remote.size, ok: !!subOk };
                msg += subOk
                  ? '；归档可传（本机 ' + local + ' 份 · 云端 ' + remote.size + ' 份）'
                  : '；归档目录建不出来（有些网盘不允许 WebDAV 建目录，请在网盘网页端手动建一个 ' + PROMPT_CLOUD_SUB + '/）';
              } catch (e) { prompts = { error: e.message }; msg += '；归档不可用：' + e.message; }
            }
            cloudStateSet({ lastAt: Date.now(), lastResult: msg });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, remoteCount: list.size, prompts, message: msg }));
            return;
          }
          /* 密钥默认不进云端：sk_key_* 是各处平台的 API 密钥，传到第三方网盘属于额外风险。
             设置页勾选「同步密钥」后会带 x-cloud-keys: 1，那时才参与上传/下载。 */
          const withKeys = String(req.headers['x-cloud-keys'] || '') === '1';
          const withPrompts = !!body.prompts;
          if (getBackup()) getBackup().createSnapshot('before-cloud', { key: '' });
          const base = baseOrThrow();
          let nUp = 0, nDown = 0, nDel = 0, same = 0;
          const details = [], conflicts = [], autoPicked = [], averted = [], backups = [], unread = [], skipDel = [], failed = [];
          for (const it of await cloudPlan(cfg, withKeys, base)) {
            const key = it.key, a = it.action;
            /* 单个键失败（某份上传被拒 / 云端拒绝删除）不要拖垮整次同步：
               以前这里没有 try，一份失败就跳到最外层 catch，后面的键全部不处理，
               而且基线不写回 → 用户看到「失败」却不知道哪份失败、下次还得从头再来。 */
            try {
              /* push 模式只上传、pull 模式只下载（老按钮的语义保留：手动控制方向）；
                 sync 模式两边都做（一键同步）。 */
              const wantPush = (a === 'push' || a === 'push-auto') && cmd !== 'pull';
              const wantPull = (a === 'pull' || a === 'pull-auto') && cmd !== 'push';
              /* 远端有这份、但这次没读下来：跳过并报出来（绝不 push 覆盖，见 cloudClassify） */
              if (a === 'error') { unread.push(key + '（' + (it.remoteErr || it.localErr || '读取失败') + '）'); continue; }
              if (a === 'conflict') { conflicts.push({ key, localTs: it.localTs, remoteTs: it.remoteTs }); continue; }
              /* 本地删掉的键要把云端那份也删掉，否则下次同步又把它拉回来（「删了又回来」）。
                 pull 模式不动云端；删除前先把云端内容存成 .bak.json，留一条找回的路。 */
              if (a === 'delete-remote') {
                if (cmd === 'pull') { skipDel.push(key); continue; }
                if (getBackup()) getBackup().createSnapshot('before-cloud-delete', { key });
                await cloudDeleteKey(cfg, key);
                delete base[key];
                nDel++; details.push('✗ ' + key);
                continue;
              }
              if (a === 'same') { same++; if (it.localBuf) base[key] = { h: sha1Of(it.localBuf), ts: Date.now() }; continue; }
              if (a === 'push-auto' || a === 'pull-auto') autoPicked.push(key + '（' + (a === 'push-auto' ? '取本机' : '取云端') + '，首次同步没有基线）');
              if (wantPush) {
                if (!it.localBuf) continue;
                await cloudPushKey(cfg, key, it.localBuf);
                base[key] = { h: sha1Of(it.localBuf), ts: Date.now() };
                nUp++; details.push('↑ ' + key);
              } else if (wantPull) {
                if (!it.remoteBuf) continue;
                cloudPullKey(key, it.remoteBuf);
                base[key] = { h: sha1Of(it.remoteBuf), ts: Date.now() };
                nDown++; details.push('↓ ' + key);
              } else if (cmd === 'pull' && it.localBuf && it.remoteBuf) {
                averted.push(key);          // pull 模式遇到该上传的：不动它（本次只做下载）
              } else if (cmd === 'push' && it.localBuf && it.remoteBuf) {
                averted.push(key);          // push 模式遇到该下载的：不动它（本次只做上传）
              }
            } catch (ek) { failed.push(key + '（' + ek.message + '）'); }
          }
          const baseWritten = cloudBaselineWrite(base);
          /* 提示词归档跟着这一次同步走（勾了才走）。数据键全部处理完再动它 ——
             归档是独立的一份文件集合，不共用上面的基线，失败也不该影响数据键的结果。 */
          let prompts = null;
          if (withPrompts) {
            try {
              const pdir = promptCloudDir(body.promptDir);
              prompts = Object.assign({ dir: pdir }, await cloudSyncPrompts(cfg, pdir, cmd));
            } catch (e) { prompts = { error: e.message, failed: [e.message] }; }
          }
          /* 状态接口据此让设置页显示「待选择」清单；一起落盘，重启代理也还在 */
          cloudStateSet({ lastAt: Date.now(), conflicts, lastUp: nUp, lastDown: nDown });
          const parts = [];
          if (nUp) parts.push('已上传 ' + nUp + ' 份');
          if (nDown) parts.push('已下载 ' + nDown + ' 份');
          if (nDel) parts.push('已删除云端 ' + nDel + ' 份（本机删掉的，云端同步删除；覆盖前留了 .bak）');
          if (skipDel.length) parts.push(skipDel.length + ' 份本机已删除但本次是「只下载」，没动云端');
          if (same) parts.push(same + ' 份一致');
          if (conflicts.length) parts.push('「' + conflicts.length + ' 份冲突待选择」');
          if (unread.length) parts.push(unread.length + ' 份读不下来（已跳过，未覆盖云端）');
          if (failed.length) parts.push('「' + failed.length + ' 份处理失败」');
          if (!baseWritten) parts.push('基线没能写回：下一次同步会重新判定这批键（数据本身已经同步过了）');
          if (prompts) {
            if (prompts.error) parts.push('提示词归档：' + prompts.error);
            else {
              if (prompts.up) parts.push('归档上传 ' + prompts.up + ' 份');
              if (prompts.down) parts.push('归档下载 ' + prompts.down + ' 份');
              if (prompts.onlyRemote) parts.push('云端有 ' + prompts.onlyRemote + ' 份这次没拿下来'
                + (cmd === 'push' ? '（这次是「只上传」；点「↓ 从云端下载」或「⇅ 一键双向同步」即可取回）' : ''));
              if (prompts.same) parts.push('归档 ' + prompts.same + ' 份一致');
              if (prompts.skipped) parts.push(prompts.skipped + ' 份归档没动（模式不匹配 / 超出单次上限 / 名字不合格）');
              if (prompts.failed && prompts.failed.length) parts.push('「归档 ' + prompts.failed.length + ' 份处理失败」');
            }
          }
          cloudStateSet({ lastResult: parts.join('，') || '没有需要同步的数据', unread });
          log('[cloud] ' + cloudState.lastResult + (details.length ? '：' + details.join(' ') : '')
            + (unread.length ? '；读不下来：' + unread.join(' ') : '')
            + (failed.length ? '；失败：' + failed.join(' ') : '')
            + (prompts && prompts.failed && prompts.failed.length ? '；归档失败：' + prompts.failed.join(' ') : ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: nUp + nDown, up: nUp, down: nDown, del: nDel, same, details,
            conflicts, autoPicked, averted, backups, unread, failed, skipDel, prompts, message: cloudState.lastResult }));
        } catch (e) {
          cloudStateSet({ lastResult: '失败：' + e.message });
          log('[cloud] 失败：' + e.message);
          replyErr(e);
        }
      });
      return true;
    }
  }
  return false;
}

  return { handleCloud, cloudCfg, cloudRequest, cloudState, cloudStateLoad, cloudSyncPrompts, cloudBackups,
    defaultUrl: CLOUD_DEFAULT_URL };
}

/* ============================================================================
   组合根：一份 createDataHub 装出全部落点，app.js 只注入环境与跨层读法。
   ========================================================================== */
function createDataHub(opts) {
  const log = opts.log || (() => {});
  const stateStore = createStateStore(opts);
  const prompts = createPromptsStore(Object.assign({}, opts, {
    root: opts.root, localRoot: opts.localRoot, log, readBody: opts.readBody,
    localAssetEntry: opts.localAssetEntry, fileSafe: opts.fileSafe,
    dirStamp: opts.dirStamp, timeText: opts.timeText,
  }));
  let backup = null;
  const cloud = createCloudStore(Object.assign({}, opts, {
    log, anyRequest: opts.anyRequest, guardOutboundUrl: opts.guardOutboundUrl, readBody: opts.readBody,
    dataDirPath: stateStore.dataDirPath, dataFileOf: stateStore.dataFileOf,
    dataList: stateStore.dataList, dataWriteRaw: stateStore.dataWriteRaw,
    readKey: stateStore.readKey, writeKey: stateStore.writeKey,
    promptCloudDir: prompts.promptCloudDir, promptFileList: prompts.promptFileList,
    getBackup: () => backup,
    cloudStateKey: stateStore.CLOUD_STATE_KEY, cloudBaseKey: stateStore.CLOUD_BASE_KEY,
  }));
  backup = createBackupStore(Object.assign({}, opts, {
    log, stateStore, prompts,
    applyAssetsIndex: opts.applyAssetsIndex,
  }));
  stateStore.setSnapshotHook((reason, extra) => backup.createSnapshot(reason, extra));
  const skillsStore = createSkillsStore({
    root: opts.root, dataDir: stateStore.dataDirPath(), userDir: process.env.SKILLS_DIR || '', log,
    readKey: stateStore.readKey, writeKey: stateStore.writeKey,
  });
  const asrStore = createAsrStore({
    dataDir: stateStore.dataDirPath(), log,
    readKey: stateStore.readKey, writeKey: stateStore.writeKey,
  });
  const searchStore = createSearchStore({
    dataDir: stateStore.dataDirPath(), log,
    readKey: stateStore.readKey, writeKey: stateStore.writeKey,
  });
  /* 开机快照由组合根在第一个请求收尾后调用：构造期间 localRoot 还没法反查状态仓，
     而且收集归档正文是同步读盘，不能压在首屏前面。 */
  const migration = stateStore.migrationLegacy;
  function bootBackup() {
    if (migration) {
      try { backup.createSnapshot('migration', { force: true, legacyBaks: migration.baks }); }
      catch (e) { log('[backup] 迁移快照没留成：' + e.message); }
    } else backup.maybeAuto('boot');
  }
  cloudStateLoadSafe(cloud);
  return {
    dataDirPath: stateStore.dataDirPath, dataFileOf: stateStore.dataFileOf,
    dataList: stateStore.dataList, dataWriteRaw: stateStore.dataWriteRaw,
    readKey: stateStore.readKey, writeKey: stateStore.writeKey,
    deleteKey: stateStore.deleteKey, restoreKeys: stateStore.restoreKeys,
    handleData: stateStore.handleData, handleCloud: cloud.handleCloud,
    handlePrompts: prompts.handlePrompts, handleBackup: backup.handleBackup,
    promptsStore: prompts, cloudStore: cloud, backupStore: backup,
    stateStore, skillsStore, asrStore, searchStore, bootBackup,
    cloudState: cloud.cloudState, cloudStateLoad: cloud.cloudStateLoad,
    promptCloudDir: prompts.promptCloudDir, promptFileList: prompts.promptFileList,
    promptsDefaultDir: prompts.promptsDefaultDir, promptsDir: prompts.promptsDir,
    promptRows: prompts.promptRows, parseFrontMatter: prompts.parseFrontMatter,
  };
}
function cloudStateLoadSafe(cloud) {
  try { if (cloud && cloud.cloudStateLoad) cloud.cloudStateLoad(); } catch (e) { /* 启动诊断读不出来不拦开机 */ }
}

module.exports = {
  createDataHub, createStateStore, createBackupStore,
  createCloudStore, createPromptsStore, createAsrStore, createSearchStore, createSkillsStore,
  atomicWrite, writeJsonWithBak, backupBeforeOverwrite, bakFileOf, BAK_KEEP_MS,
  fsyncPath, sleepSync, renameWithRetry, DATA_KEY_RE,
  parseFrontmatter, CONTRACTS, ID_RE, localAsrState, toSrt, normSegments, srtTime,
  CLOUD_STATE_KEY, CLOUD_BASE_KEY, MAX_SNAPSHOTS,
};
