#!/usr/bin/env node
/* 「问一次盘」判据（常驻，不启实例、不碰用户目录）：批量读路径一页问了多少次磁盘。
   跑法：`node tests/read-cache.cjs`。

   盯的是三族批量读，它们都站在页面加载的关键路径上、又都跑在代理的主线程里：
     · `localAliases` / `localLocateBatch` —— 开机取别名表 + 列表加载时批量补问；
     · `/prompts` 与 `/prompts/find` —— 一张卡问一次提示词归档；
     · `/cache/{thumbs,slices}` —— 一屏几十个缩略图 GET 与开机那一次整表拉回。
   判的是**磁盘问话的次数**而不是墙钟耗时：耗时受机器负载影响会假红，
   而「600 行 = 600 次 existsSync」「十几张卡 = 十几遍整目录」「几十次命中 = 几十趟整份索引读写」
   这三件事本身就是病。
   同时钉住缓存的另一半 —— 缓存不许把刚落盘的归档、本体与刚 PUT 的那一条挡在门外。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { createLocalAssetsStore } = require('../server/local-assets-store.js');
const { createPromptsStore } = require('../server/prompts-store.js');
const { createCacheRoutes } = require('../server/routes/cache.js');

let bad = 0, n = 0;
const ok = (name, cond, detail) => {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
};

/* 磁盘问话计数器：只数落在探针目录里的那些（判据自己写的文件与 require 不算）。
   同步那一路（fs.xxxSync）与异步那一路（fs.promises.xxx，键前缀 `p.`）分开数：
   一次请求问盘问了几次是「病不病」，而**同步**问的那几次才额外是「挡不挡主线程」。 */
const counters = {};
let watched = [];
const patch = [];
/* 索引写入单独计：判据要量的是「__index.json 写了几趟」。
   一程批量 PUT 的 .bin 字节也是异步 fs.promises.writeFile，响应回来了写未必落完，
   会串到下一个采样窗口 —— 拿「本窗所有 p.writeFile」当索引的代理会偶发假红
   （全量并发跑时尤其容易撞上）。按文件名分开数，判据才量到它真正想量的东西。 */
const IDX_WRITE = 'p.writeFile:index';
function startWatch(roots) {
  watched = roots.map(r => path.resolve(r));
  counters[IDX_WRITE] = 0;
  const put = (name, host, key) => {
    const orig = host[name];
    counters[key] = 0;
    patch.push({ host, name, orig });
    host[name] = function (...a) {
      let p = '';
      try { p = path.resolve(String(a[0] || '')); } catch (e) { p = ''; }
      if (watched.some(w => p === w || p.startsWith(w + path.sep))) {
        counters[key]++;
        if (key === 'p.writeFile' && path.basename(p) === '__index.json') counters[IDX_WRITE]++;
      }
      return orig.apply(host, a);
    };
  };
  ['existsSync', 'readdirSync', 'openSync', 'readFileSync', 'writeFileSync'].forEach(k => put(k, fs, k));
  ['stat', 'open', 'readFile', 'writeFile', 'unlink', 'rm'].forEach(k => put(k, fs.promises, 'p.' + k));
}
function stopWatch() {
  while (patch.length) { const p = patch.pop(); p.host[p.name] = p.orig; }
}
const c = k => counters[k] || 0;
const reset = () => Object.keys(counters).forEach(k => { counters[k] = 0; });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/* 第三族的探针根要在异常出口里也清得掉，所以在模块级声明、进到判据流程里才建。 */
let tmpC = '';

/* ---------- 第一族：本机产物的批量读 ---------- */
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'read-cache-assets-'));
const assets = path.join(tmpA, 'assets');
const dataA = path.join(tmpA, 'data');
fs.mkdirSync(path.join(assets, '图片'), { recursive: true });
fs.mkdirSync(path.join(dataA, 'local-assets'), { recursive: true });

const store = createLocalAssetsStore({
  MIME: { '.png': 'image/png' },
  dataDirPath: () => dataA,
  log: () => {},
  spawnSync: () => {},
  localRoot: () => assets,
  fileSafe: s => String(s || 'x'),
});

const ROWS = 120;
const bodyOf = i => path.join(assets, '图片', 'p' + i + '.png');
for (let i = 0; i < ROWS; i++) {
  fs.writeFileSync(bodyOf(i), Buffer.concat([PNG, Buffer.from('|' + i + '|' + 'x'.repeat(i % 90))]));
  store.localIndexUpsert({
    id: 'la_p' + i, file: '图片\\p' + i + '.png', name: 'p' + i + '.png',
    mime: 'image/png', format: 'png', byte_length: fs.statSync(bodyOf(i)).size,
    created_at: new Date().toISOString(), media_type: '图片',
    provider: 'probe', prompt: '', model: '', upstream: 'https://cdn.example.com/r/a' + i + '.png',
    detail: { asset: 'asset_' + i, task: 'job_' + i },
  });
}

startWatch([assets]);

reset();
let al = store.localAliases().rows;
const readsCold = { exists: c('existsSync'), readdir: c('readdirSync') };
ok('别名表把每一条账都报出来了', al.length === ROWS, al.length + '/' + ROWS);
ok('取一次别名表：逐条 existsSync 一次都不许问（本体全在磁盘快照里）',
  readsCold.exists === 0, 'existsSync=' + readsCold.exists);
ok('取一次别名表：整库 readdir 只走一趟（快照按根复用）',
  readsCold.readdir <= 2, 'readdir=' + readsCold.readdir);

reset();
const loc = store.localLocateBatch(Array.from({ length: ROWS }, (_, i) => ({ assetId: 'asset_' + i })));
ok('批量定位按平台产物号都认回了自己那一条', loc.filter(Boolean).length === ROWS, loc.filter(Boolean).length + '/' + ROWS);
ok('批量定位同样不逐条问盘', c('existsSync') === 0, 'existsSync=' + c('existsSync'));

/* 用户在文件管理器里删了一批本体：那些条目要当场从别名表里掉出去，
   而且「一条不在」不许变成「每一条都重扫一遍库」。 */
const GONE = 24;
for (let i = 0; i < GONE; i++) fs.unlinkSync(bodyOf(i));
store.invalidateScan();
reset();
al = store.localAliases().rows;
const readsGone = { exists: c('existsSync'), readdir: c('readdirSync') };
ok('删掉的本体不再报「本机有」（别名表少了那几条）',
  al.length === ROWS - GONE, al.length + '，应 ' + (ROWS - GONE));
ok('一批不在的本体只翻得起一趟磁盘对账（不是每条翻一遍）',
  readsGone.readdir <= 4 * 2, 'readdir=' + readsGone.readdir + '（' + GONE + ' 条不在）');

/* 快照之后刚落盘的本体：查不到那张表不等于「没有」，必须退回逐条认回。 */
const late = path.join(assets, '图片', 'late.png');
store.localIndexUpsert({
  id: 'la_late', file: '图片\\late.png', name: 'late.png',
  mime: 'image/png', format: 'png', byte_length: PNG.length,
  created_at: new Date().toISOString(), media_type: '图片',
  provider: 'probe', prompt: '', model: '', upstream: 'https://cdn.example.com/r/late.png',
  detail: { asset: 'asset_late' },
});
store.localAliases();               // 把快照钉在「这条的本体还不存在」的那一刻
fs.writeFileSync(late, PNG);        // 先落账、后落字节，且不重扫：模拟「刚落盘的那一条」
reset();
const alLate = store.localAliases().rows;
ok('刚落盘、磁盘快照里还没有的那一条照样被认出来（认回那三级不能被缓存替掉）',
  alLate.some(r => r.id === 'la_late'), alLate.length + ' 行');
ok('认回走的是逐条那一条路（一次 existsSync 起步，不是整库重扫）',
  c('existsSync') >= 1 && c('readdirSync') <= 4 * 2, 'exists=' + c('existsSync') + ' readdir=' + c('readdirSync'));

stopWatch();
for (let i = GONE; i < ROWS; i++) { try { fs.unlinkSync(bodyOf(i)); } catch (e) {} }

/* ---------- 第二族：提示词归档的读 ---------- */
const tmpP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-cache-prompts-'));
const promptsDir = path.join(tmpP, '提示词');
fs.mkdirSync(promptsDir, { recursive: true });
/* 归档目录只认这一枚环境变量（不注入就会落到用户真实的 下载\成像\提示词）。
   ⚠ 这一族判据会 POST 归档：目录没指对就是在往用户的成品目录里写探针残留，
   所以先把现算出来的落点验一遍，不对就当场退出，一个字节都不落。 */
process.env.PROMPTS_DIR = promptsDir;
let seq = 0;
let pendingBody = '';
const pstore = createPromptsStore({
  root: tmpP,
  log: () => {},
  readBody: () => Promise.resolve(Buffer.from(pendingBody)),
  localAssetEntry: () => null,
  fileSafe: (s, cap) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, cap || 60),
  dirStamp: () => 'st' + String(++seq).padStart(5, '0'),
  timeText: () => '2026-11-04 00:00',
});
function call(method, url, body) {
  pendingBody = body || '';
  return new Promise(resolve => {
    const res = {
      writeHead(code) { res.statusCode = code; },
      end(chunk) { resolve({ statusCode: res.statusCode || 0, body: String(chunk || '') }); },
    };
    pstore.handlePrompts({ method }, res, new URL(url, 'http://x'));
  });
}
const POST = (task, title) => call('POST', '/prompts', JSON.stringify({
  prompt: '这一条提示词的正文', type: '图片生成', title: title || task, provider: 'probe', task,
}));
const findRow = async id => JSON.parse((await call('GET', '/prompts/find?id=' + encodeURIComponent(id))).body);

(async () => {
  const landing = path.resolve(pstore.promptsDir());
  if (landing !== path.resolve(promptsDir)) {
    console.log('✗ 归档落点没指进探针目录，会写进用户那一份：' + landing);
    try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpP, { recursive: true, force: true }); } catch (e) {}
    process.exit(1);
  }
  ok('归档只写探针目录（现算的落点先验一遍再落第一个字节）', true);
  const ARCH = 80;
  for (let i = 0; i < ARCH; i++) await POST('job-' + i, '归档 ' + i);

  startWatch([promptsDir]);

  const hit = await findRow('job-3');
  ok('索引里的归档按任务号找得到', hit.matched >= 1 && /\.md$/.test(String(hit.file || '')), JSON.stringify(hit).slice(0, 120));

  const miss1 = await findRow('没归档过的号-1');
  const afterFirst = { readdir: c('readdirSync'), open: c('openSync') };
  ok('归档里没有这个任务号时照实说没有', miss1.matched === 0 && miss1.archived === false, JSON.stringify(miss1).slice(0, 120));
  ok('第一次查不到：整目录翻了一遍（这是兜底，本该花钱）',
    afterFirst.readdir >= 1 && afterFirst.open >= ARCH, JSON.stringify(afterFirst));

  reset();
  for (let i = 2; i <= 8; i++) await findRow('没归档过的号-' + i);
  ok('连着查不到不再一遍遍翻整目录（readdir 与逐条 open 都不许随次数涨）',
    c('readdirSync') === 0 && c('openSync') === 0,
    'readdir=' + c('readdirSync') + ' open=' + c('openSync') + '（7 次查不到）');

  /* 索引备忘录按「_index.json 的 mtime + 字节数」认档，而前面那几次查已经把它记熟了：
     先把 mtime 抹新，让下面第一读是冷的 —— 量的才是「读一次记住」，不是「早就记着了」。 */
  const idxFile = path.join(promptsDir, '_index.json');
  const stamped = new Date(Date.now() + 2000);
  fs.utimesSync(idxFile, stamped, stamped);
  reset();
  await call('GET', '/prompts');
  const idxReads1 = c('readFileSync');
  reset();
  await call('GET', '/prompts');
  ok('索引读一次记住：同一档第二次列表不再重读 _index.json',
    idxReads1 === 1 && c('readFileSync') === 0, '第一次 ' + idxReads1 + ' 次，第二次又读了 ' + c('readFileSync') + ' 次');

  /* 缓存不许把刚落盘的挡在门外 */
  await POST('job-刚存的', '刚存的那一条');
  const fresh = await findRow('job-刚存的');
  ok('刚 POST 的归档马上按任务号查得到', fresh.matched >= 1, JSON.stringify(fresh).slice(0, 120));
  const listNow = JSON.parse((await call('GET', '/prompts')).body);
  ok('刚 POST 的归档也进了列表的条数', listNow.count === ARCH + 1, listNow.count + '/' + (ARCH + 1));

  pendingBody = JSON.stringify({ files: [{ name: '导入的一份.md',
    text: '---\ntitle: 导入的一份\ntype: 任务\nts: 5\ntask: job-imported\n---\n\n## 提示词\n\n导入的正文\n' }] });
  const imp = await call('POST', '/prompts/import', pendingBody);
  ok('导入回的是恢复成功', imp.statusCode === 200 && JSON.parse(imp.body).restored === 1, imp.body.slice(0, 120));
  const gotImp = await findRow('job-imported');
  ok('刚导入的归档马上按任务号查得到', gotImp.matched >= 1, JSON.stringify(gotImp).slice(0, 120));

  /* 用户自己往目录里拷了一份、而索引整份不在：现搭那一路必须以盘上为准，
     拿旧缓存搭出来的索引会把缺口永久写回盘上。 */
  fs.writeFileSync(path.join(promptsDir, '自己拷进来的一份.md'),
    '---\ntitle: 自己拷的\ntype: 任务\nts: 9\ntask: job-handcopy\n---\n\n## 提示词\n\n拷进来的正文\n');
  await call('GET', '/prompts/find?id=job-handcopy');           // 先让兜底那一遍缓住（不含新文件）
  fs.unlinkSync(path.join(promptsDir, '_index.json'));
  const rebuilt = JSON.parse((await call('GET', '/prompts')).body);
  ok('索引没了就现搭：自己拷进来的那一份也在条数里',
    rebuilt.count === ARCH + 3, rebuilt.count + '/' + (ARCH + 3));
  const hand = await findRow('job-handcopy');
  ok('自己拷进来的那一份按任务号也查得到', hand.matched >= 1, JSON.stringify(hand).slice(0, 120));

  stopWatch();

  /* ---------- 第三族：代理端那份持久缓存（缩略图 / 切片帧） ----------
     这一族站在每一次页面加载上：一屏卡片要发几十个带 key 的 GET，开机还要整表拉回一次。
     盯的是「命中这一趟到底问了几次盘」—— 以前每一次命中都先把整份索引读进内存解析、
     改一个 at 再整份写回去，几百 KB 的同步读写 × 几十个请求，全压在代理主线程上。 */
  tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'read-cache-cache-'));
  const dataC = path.join(tmpC, 'data');
  const cacheDir = path.join(dataC, 'cache', 'thumbs');
  let cacheBody = Buffer.alloc(0);
  const cache = createCacheRoutes({
    dataDirPath: () => dataC,
    log: () => {},
    readBody: () => Promise.resolve(cacheBody),
  });
  const CKEY = i => 'https://cdn.example.com/图片/p' + i + '.jpeg?sig=' + i;
  const CU = i => '/cache/thumbs?key=' + encodeURIComponent(CKEY(i));
  /* 命中那一路把文件交给流（createReadStream 走异步 open），所以 fake res 要真接得住字节：
     PassThrough 收 data、end 之后把整份拼回来。 */
  function ccall(method, url, body) {
    cacheBody = body == null ? Buffer.alloc(0) : Buffer.from(String(body));
    const res = new PassThrough();
    res.statusCode = 0; res.headers = {}; res.headersSent = false;
    res.writeHead = (code, h) => {
      if (res.headersSent) throw new Error('writeHead 调了第二次（这一次是 ' + code + '）');
      res.statusCode = code; Object.assign(res.headers, h || {}); res.headersSent = true;
      return res;
    };
    const chunks = [];
    res.on('data', d => chunks.push(Buffer.from(d)));
    const done = new Promise(resolve => res.on('end', () => resolve({
      statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
    })));
    cache.handleCache({ method }, res, new URL(url, 'http://x'));
    return done;
  }
  const CN = 200;
  startWatch([dataC]);

  reset();
  for (let i = 0; i < CN; i++) await ccall('PUT', CU(i), 'dataURL-' + i);
  /* 每 PUT 必然落一份 .bin 字节（那才是被读回来的东西），索引则是另一码事：满表 3000 条那一份
     有 475KB，逐条 stringify + 整份重写等于把同一份字节往盘上摞 N 遍，而 stringify 那 1.3 毫秒
     是站在代理主线程上的。合并之后这一程只落几趟。 */
  const burstWrites = c('p.writeFile');
  const idxWrites = burstWrites - CN;
  /* 这张表第一次被用到才从盘上读索引，读这一次就驻在内存里 —— 之后所有的 PUT / GET / 整表拉回
     都不该再问这一趟。所以「冷的只有一趟」在这一头钉住。 */
  const burstReads = c('readFileSync');
  ok('存一条都落自己的字节（异步，没有一个同步写把主线程按住）',
    burstWrites >= CN && c('writeFileSync') === 0,
    'p.writeFile=' + burstWrites + ' writeFileSync=' + c('writeFileSync') + '（' + CN + ' 次 PUT）');
  ok('一程批量 PUT 的索引落盘被合并：远少于 PUT 次数（一 PUT 一趟就是病）',
    idxWrites >= 0 && idxWrites * 8 <= CN,
    '索引写了 ' + idxWrites + ' 趟（' + CN + ' 次 PUT，这一程最多容 ' + Math.floor(CN / 8) + ' 趟）');
  ok('整族只有一趟冷的：第一次用这张表读一次索引，之后一概走内存',
    burstReads === 1, 'readFileSync=' + burstReads + '（' + CN + ' 次 PUT）');
  /* 攒着不等于丢了：主动排空一次，盘上那一份必须把这一批全认下来。
     放在命中那一轮之前做，是因为「命中不写盘」那条判据要量的是干净的窗口。 */
  reset();
  const flushed = await cache.flushPending();
  ok('没落盘的那几趟索引一补就落，且一张表只补一趟',
    flushed === 1 && c(IDX_WRITE) === 1,
    '补了 ' + flushed + ' 张表，索引写了 ' + c(IDX_WRITE) + ' 趟（本窗 p.writeFile=' + c('p.writeFile') + '）');
  const onDisk = JSON.parse(fs.readFileSync(path.join(cacheDir, '__index.json'), 'utf8'));
  const keysOnDisk = new Set(onDisk.map(e => e.key));
  ok('合并之后盘上那一份把这一批全认下来（一条都没丢）',
    onDisk.length === CN && Array.from({ length: CN }, (_, i) => CKEY(i)).every(k => keysOnDisk.has(k)),
    onDisk.length + ' 条');
  reset();
  ok('没有新写就不许再落一趟（合并不是「每隔一会儿重写一遍」）',
    (await cache.flushPending()) === 0 && c(IDX_WRITE) === 0,
    '索引写了 ' + c(IDX_WRITE) + ' 趟');

  const firstHit = await ccall('GET', CU(0));
  ok('命中回的就是存进去的那一份字节（换成流出去也一样）',
    firstHit.statusCode === 200 && firstHit.body === 'dataURL-0',
    firstHit.statusCode + ' / ' + JSON.stringify(firstHit.body.slice(0, 20)));

  reset();
  let hits = 0;
  for (let i = 0; i < CN; i++) if ((await ccall('GET', CU(i))).statusCode === 200) hits++;
  ok('每一枚键都认回自己那一条', hits === CN, hits + '/' + CN);
  ok('一整轮命中：索引一次都不许重读、更不许重写（整表驻内存，读只刷新内存里的 at）',
    c('readFileSync') === 0 && c('writeFileSync') === 0 && c(IDX_WRITE) === 0,
    'readSync=' + c('readFileSync') + ' writeSync=' + c('writeFileSync') + ' indexWrite=' + c(IDX_WRITE)
    + '（' + CN + ' 次命中）');
  ok('一整轮命中也不逐条问「文件在不在」再读整份进内存（字节交给流，只留一次 stat 报长度）',
    c('existsSync') === 0 && c('openSync') === 0 && c('readFileSync') === 0 && c('p.readFile') === 0
    && c('p.stat') === CN,
    'exists=' + c('existsSync') + ' openSync=' + c('openSync') + ' readFile=' + c('p.readFile')
    + ' stat=' + c('p.stat'));

  reset();
  const all = JSON.parse((await ccall('GET', '/cache/thumbs')).body);
  ok('整表拉回的条数与形状都对（k / v / ts 三样，前端 hydrate 只认这个形状）',
    all.items.length === CN && all.items.every(x => typeof x.k === 'string'
      && /^dataURL-\d+$/.test(x.v) && typeof x.ts === 'number'),
    (all.items || []).length + ' 条');
  ok('整表拉回不回盘问索引（内存那份说了算），逐条字节走异步读',
    c('readFileSync') === 0 && c('p.readFile') === CN,
    'readSync=' + c('readFileSync') + ' readFile=' + c('p.readFile'));

  /* 缓存不许把刚落盘的挡在门外：PUT 完当场就要按 key 读得回来，也要进整表拉回 */
  await ccall('PUT', CU(999), '刚存的那一份');
  const freshHit = await ccall('GET', CU(999));
  ok('刚 PUT 的那一条马上按 key 读得回来', freshHit.statusCode === 200 && freshHit.body === '刚存的那一份',
    freshHit.statusCode + ' / ' + JSON.stringify(freshHit.body.slice(0, 20)));
  const allFresh = JSON.parse((await ccall('GET', '/cache/thumbs')).body);
  ok('刚 PUT 的那一条也在整表拉回里', allFresh.items.length === CN + 1, allFresh.items.length + '/' + (CN + 1));

  /* 用户在别处清了盘上那份字节：索引说有、文件没了 → 当场 404 并把这一条摘掉落盘，
     不假装还在（留着它每一帧都要白问一次，而它下一帧还是没字节）。 */
  const goneId = crypto.createHash('sha1').update(CKEY(7)).digest('hex');
  fs.unlinkSync(path.join(cacheDir, goneId + '.bin'));
  /* 上面那次 PUT 的索引是攒着的：先把 pending 排空，下面量的才是「摘掉失效那一条」自己写了几趟。 */
  await cache.flushPending();
  reset();
  const gone = await ccall('GET', CU(7));
  ok('字节没了的那一条当场回 404', gone.statusCode === 404, '状态码 ' + gone.statusCode);
  ok('摘掉这一条时索引真落了盘（下次开机不再白问这一枚键）',
    c(IDX_WRITE) === 1, '索引写了 ' + c(IDX_WRITE) + ' 趟');
  const afterHeal = JSON.parse((await ccall('GET', '/cache/thumbs')).body);
  ok('失效的那一条从整表拉回里也掉出去了',
    afterHeal.items.length === CN && !afterHeal.items.some(x => x.k === CKEY(7)),
    afterHeal.items.length + ' 条');

  const del = await ccall('DELETE', CU(3));
  ok('删一条报 removed:1，之后按 key 读不回来',
    del.statusCode === 200 && /"removed":1/.test(del.body) && (await ccall('GET', CU(3))).statusCode === 404,
    del.body.slice(0, 60));

  /* 退出钩子（server/app.js 的 process.on('exit')）走的是同步那一路 —— exit 回调里等不到 Promise。
     攒着没落的索引必须当场落得下去，否则「关掉代理」就等于把最近一屏缩略图的账丢掉。 */
  await ccall('PUT', CU('exit'), '退出前攒着的那一份');
  reset();
  const syncFlushed = cache.flushPendingSync();
  const diskAfterSync = JSON.parse(fs.readFileSync(path.join(cacheDir, '__index.json'), 'utf8'));
  ok('退出前的同步补盘把攒着的那一条落到盘上（这一路走同步写，不排队等异步）',
    syncFlushed >= 1 && c('writeFileSync') >= 1 && c(IDX_WRITE) === 0
      && diskAfterSync.some(e => e.key === CKEY('exit')),
    JSON.stringify({ syncFlushed, syncWrite: c('writeFileSync'), indexAsyncWrite: c(IDX_WRITE), 盘上: diskAfterSync.length }));

  stopWatch();
  try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpP, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  stopWatch();
  console.log('判据自己炸了：' + ((e && e.stack) || e));
  try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch (x) {}
  try { fs.rmSync(tmpP, { recursive: true, force: true }); } catch (x) {}
  try { if (tmpC) fs.rmSync(tmpC, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
