/* 云同步（/cloud）—— WebDAV 推送 / 拉取 / 冲突与基线。
   认证信息优先用请求头（设置页填，存浏览器、只发给本地代理），其次读 .env 的 CLOUD_WEBDAV_*。
   路由与文件操作都在这里；数据键读写走 data-store 的同一组导出，归档走 prompts-store。
   handleCloud 返回 true = 已处理。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_KEY_RE } = require('./data-store.js');
const { atomicWrite } = require('./fs-atomic.js');

function createCloudStore(opts) {
  const log = opts.log || (() => {});
  const anyRequest = opts.anyRequest;
  const guardOutboundUrl = opts.guardOutboundUrl;
  const readBody = opts.readBody;
  const dataDirPath = opts.dataDirPath;
  const dataFileOf = opts.dataFileOf;
  const dataList = opts.dataList;
  const dataWriteRaw = opts.dataWriteRaw;
  const keepDataBackup = opts.keepDataBackup;
  const promptCloudDir = opts.promptCloudDir;
  const promptFileList = opts.promptFileList;

async function cloudCfg(req) {
  const h = req.headers;
  const pick = (hdr, env) => String(h[hdr] || process.env[env] || '').trim();
  const url = pick('x-cloud-url', 'CLOUD_WEBDAV_URL').replace(/\/+$/, '');
  const user = pick('x-cloud-user', 'CLOUD_WEBDAV_USER');
  const pass = String(h['x-cloud-pass'] || process.env.CLOUD_WEBDAV_PASS || '');
  if (!url) throw new Error('还没配置云端地址：到「设置 → 数据与同步」里填，或写进 .env 的 CLOUD_WEBDAV_URL');
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
/* 目录校验与文件清单只在 prompts-store 一处（同源参数也要过同一道校验）。 */
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
const CLOUD_STATE_FILE = () => path.join(dataDirPath(), '.cloud-state.json');
const CLOUD_BASE_FILE = () => path.join(dataDirPath(), '.cloud-baseline.json');
/* 结果状态（ui）与同步基线（每个键的指纹）是两码事，分两份文件：
   写基线时不用先把 ui 那一半读回来再合并 —— 一次 read-modify-write 漏读就是「同步一次把上次的诊断抹掉」。 */
function cloudStateFileRead() {
  try { return JSON.parse(fs.readFileSync(CLOUD_STATE_FILE(), 'utf8')) || {}; } catch { return {}; }
}
function cloudStateSave() {
  try {
    fs.mkdirSync(dataDirPath(), { recursive: true });
    const { fsyncWhy } = atomicWrite(CLOUD_STATE_FILE(), JSON.stringify({
      ts: Date.now(),
      ui: { at: cloudState.lastAt, result: cloudState.lastResult, conflicts: cloudState.conflicts || [],
        unread: cloudState.unread || [], up: cloudState.lastUp || 0, down: cloudState.lastDown || 0 },
    }));
    if (fsyncWhy) log('[cloud] 状态落盘同步退化：' + fsyncWhy);
  } catch (e) { log('[cloud] 状态写入失败：' + e.message); }
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
   冲突判定靠**基线**：.data/.cloud-baseline.json 记着上次成功同步时每个键的内容指纹。
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
  let text;
  try { text = fs.readFileSync(CLOUD_BASE_FILE(), 'utf8'); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return {};
    log('[cloud] 基线读不出来：' + e.message);
    return null;
  }
  let v = null;
  try { v = JSON.parse(text); } catch { v = null; }
  if (!v || !v.keys || typeof v.keys !== 'object') {
    log('[cloud] 基线内容不像一份基线（可能是手工改过，也可能被截断）');
    return null;
  }
  return v.keys;
}
function cloudBaselineWrite(keys) {
  try {
    fs.mkdirSync(dataDirPath(), { recursive: true });
    const { fsyncWhy } = atomicWrite(CLOUD_BASE_FILE(), JSON.stringify({ ts: Date.now(), keys }));
    if (fsyncWhy) log('[cloud] 基线落盘同步退化：' + fsyncWhy);
    return true;
  } catch (e) { log('[cloud] 基线写入失败：' + e.message); return false; }
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
   · render-jobs：成片文件只在 .renders 里，任务记录跟着云走到另一台机器只会指向不存在的文件。 */
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
      try { localBuf = fs.readFileSync(dataFileOf(key)); }
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
/* 下载：覆盖前先把本机那份存成 .bak.json（云同步唯一的"后悔药"） */function cloudPullKey(key, remoteBuf, backupList) {
  if (fs.existsSync(dataFileOf(key))) {
    dataWriteRaw(key + '.bak', fs.readFileSync(dataFileOf(key)));
    if (backupList) backupList.push(key + '.bak.json');
  }
  dataWriteRaw(key, remoteBuf);
}
/* 清单接口：给设置页展示「云端有哪些、本地有哪些、各自多大/多新」 */
function cloudBackups() {
  try {
    const dir = dataDirPath();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.bak.json')).map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { key: f.slice(0, -'.bak.json'.length), file: f, size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/* ---------- /cloud 的一组路由（/data 在 server/data-store.js；返回 true 表示已处理） ---------- */
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
    const status = timeout ? 504 : (net ? 502 : 400);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: m } }));
  };
  /* 基线读不出来时统一的一句话：三份 handler 都要用，别说成三种口径。 */
  const baseOrThrow = () => {
    const base = cloudBaselineRead();
    if (!base) throw new Error('云同步基线（.data/.cloud-baseline.json）读不出来或内容坏了：本次不动任何数据。'
      + '确认这份文件不需要留底后可以删掉它，下一次同步会按「首次同步」重建基线。');
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
      const hasEnv = !!(process.env.CLOUD_WEBDAV_URL && process.env.CLOUD_WEBDAV_USER);
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
        envConfigured: hasEnv, lastAt: cloudState.lastAt, lastResult: cloudState.lastResult,
        conflicts: cloudState.conflicts || [], lastUp: cloudState.lastUp || 0, lastDown: cloudState.lastDown || 0,
        unread: cloudState.unread || [], prompts,
      }));
      return true;
    }
    /* 备份清单：覆盖前留下的 .bak.json（云同步唯一能"后悔"的地方），设置页可一键恢复 */
    if (cmd === 'backups' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, dir: dataDirPath(), items: cloudBackups() }));
      return true;
    }
    /* 恢复某份备份：把 .bak.json 拷回 <key>.json（本机数据文件 → 下次页面加载/刷新时进浏览器） */
    if (cmd === 'restore' && req.method === 'POST') {
      cloudExclusive(async () => {
        try {
          const raw = await readBody(req, res, 1 * 1024 * 1024);
          if (raw == null) return;
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const key = String(body.key || '');
          if (!DATA_KEY_RE.test(key)) throw new Error('非法的数据键名：' + key);
          const bak = dataFileOf(key + '.bak');                    // 备份名是 <key>.bak.json（不是 <key>.json.bak.json）
          if (!fs.existsSync(bak)) throw new Error('这份数据没有备份（' + key + '.bak.json 不存在）');
          const base = baseOrThrow();                              // 基线读不动就先停手，别留一份自相矛盾的指纹
          dataWriteRaw(key, fs.readFileSync(bak));                 // 覆盖当前这份
          delete base[key];                                        // 基线作废：下次同步按现状重新判定
          cloudBaselineWrite(base);
          log('[cloud] 已从备份恢复 ' + key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, message: '已用备份覆盖本机数据文件：' + key + '（刷新页面后生效）' }));
        } catch (e) {
          replyErr(e);
        }
      });
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
            if (!fs.existsSync(dataFileOf(key))) throw new Error('本机没有这份数据：' + key);
            const buf = fs.readFileSync(dataFileOf(key));
            await cloudPushKey(cfg, key, buf);
            base[key] = { h: sha1Of(buf), ts: Date.now() };
            log('[cloud] 冲突解决：' + key + ' → 用本机覆盖云端');
          } else {
            await cloudEnsureDir(cfg);
            const got = await cloudRequest(cfg, 'GET', key + '.json', {});
            if (got.status !== 200) throw new Error('云端读不到这份数据 HTTP ' + got.status);
            cloudPullKey(key, got.body, backups);
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
                if (it.remoteBuf) { dataWriteRaw(key + '.bak', it.remoteBuf); backups.push(key + '.bak.json'); }
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
                cloudPullKey(key, it.remoteBuf, backups);
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

  return { handleCloud, cloudCfg, cloudRequest, cloudState, cloudStateLoad, cloudSyncPrompts, cloudBackups };
}
module.exports = { createCloudStore };
