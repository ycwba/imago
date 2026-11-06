/* 本机落盘的存储层：磁盘余量口径 + 本机资产库那一份「账」与读文件。
   2026-10-20 从 server/app.js 原样搬出：这里只有业务助手与落盘口径，
   请求解析与响应在 server/routes/local-assets.js、server/routes/usage.js。
   库根（localRoot）、dataDirPath、log、MIME、spawnSync、fileSafe 由 app 组合根注入 ——
   路径口径全站只有那一处（path.resolve，绝对路径要能直接用），这里不重复算。
   ---------------------------------------------------------------------------
   一句话说清这一层的立场：**盘上的文件是本体，索引只是它的一份账**。
   所以账可以丢、可以换地方、可以改名搬家，而产物不能因此看不见 ——
   每条记录带两个可移植的身份（fid 与采样内容签名，见下面 localSigOf），启动与列表前做一次磁盘对账，
   账落后的那一条按身份认回新路径，盘上有而账里没有的那一条补一条账。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MediaId = require('../web/domain/ident.cjs');
const { createIndexStore } = require('./index-store.js');

/* ---------- 图片 / 视频 / 音频的已知扩展名（本机资产的类别表，全站只有这一张） ----------
   落点目录（bodyDirNameOf）、磁盘对账补账（localAdopt）、列表重算类型（localMediaType）、
   用量清点（productKindOfName）都查它。表放在**模块层**而不是工厂闭包里：路由那一侧的两个
   写入口（server/routes/local-assets.js）也要用它当闸，直连模块导出 —— 那是一枚纯函数，
   不属于任何一个实例的状态，也不进组合根的注入清单（这份手工名单少一行就是运行期 TypeError）。 */
const LOCAL_KIND_BY_EXT = {
  png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片', bmp: '图片', avif: '图片',
  mp4: '视频', mov: '视频', webm: '视频', mkv: '视频', m4v: '视频',
  mp3: '音频', wav: '音频', m4a: '音频', aac: '音频', ogg: '音频', oga: '音频', flac: '音频',
  pcm: '音频', pcm16: '音频', opus: '音频',
};
/* 「这一枚扩展名是不是图片 / 视频 / 音频」——本机资产库写入口的闸。
   为什么资产库只收媒体：库根是「一条产物一个本体」的作品堆，账、缩略图、播放、回源外链、
   用量清理全按这三类运转；字幕 / 文本没有类型档位，写进来只会落进 其他\，再被列表的
   「认不出兜底成音频」（localMediaType 那句，只服务老数据的读路径）画成一条假音频。
   字幕 / 文本有自己的去处：下载目录与 提示词\ 归档（server/prompts-store.js）。
   与 productKindOfName 同一张表、同一个「只认扩展名、不猜类型」的立场。 */
function isMediaExt(fmt) {
  const f = String(fmt || '').toLowerCase().replace(/^\./, '');
  return !!LOCAL_KIND_BY_EXT[f];
}

/* 已知的「文档类」扩展名（不是媒体，也不该被猜成媒体）。平台把字幕 / 文本挂在产物
   地址上、客户端猜不出格式声明成 mp4 时，按地址上的真相拒收 —— 认不出扩展名
   （.bin 这类）不在此列，仍按声明走，免得误伤真实的媒体下载。 */
const DOC_EXTS = new Set([
  'srt', 'vtt', 'ass', 'ssa', 'scc', 'sbv', 'lrc', 'cue',
  'txt', 'json', 'xml', 'html', 'htm', 'md', 'pdf', 'csv',
]);
function isDocExt(fmt) {
  return DOC_EXTS.has(String(fmt || '').toLowerCase().replace(/^\./, ''));
}

/* 一条账 / 一份写入声明记的是哪一件平台产物：顶层字段优先，detail 只是老数据的回退。
   身份必须在账的最上层 —— 浏览器只靠这一层问「这条外链 / 这个产物号在本机有没有副本」，
   而 detail 是任务详情（展示用的留底），它的形状随平台变，不该承担寻址。 */
function identityOf(x) {
  const d = (x && typeof x.detail === 'object' && x.detail) || null;
  return {
    assetId: String((x && x.assetId) || (d && d.asset) || ''),
    taskId: String((x && x.taskId) || (d && d.task) || ''),
  };
}

function createLocalAssetsStore(deps) {
  const { MIME, dataDirPath, log, spawnSync, localRoot, fileSafe } = deps;
  /* 库根：每次现读（设置页改了不必重启）。 */
  const DIR = () => localRoot();
  /* 账本不在库根里：根是用户翻得到的 下载\成像，里面只放产物本体。
     账放 .data\local-assets\，于是「换根」只是换个本体堆，账一直跟着应用走。 */
  const INDEX_DIR = () => path.resolve(dataDirPath(), 'local-assets');

  /* ---------- 写媒体之前先问一句「这块盘还剩多少」 ----------
     以前是等 ENOSPC 抛出来才报错，而那一句多半落在 handler 的 catch 里只进日志：
     界面上看到的是卡片当场换图、toast 说「已保存」，刷新后资产库里没有它 ——
     「说成功了而其实没落盘」是本项目反复拦的那一类（「存盘失败必须看得见」）。
     三条口径：
     ① **只在本机问、不起子进程**：`fs.statfsSync` 拿 `bsize × bavail`（Node 19.6+）。
        老 Node 上没有这个 API 就当「问不出来」，**照原样继续写** —— 量不到空间不是拒绝服务的理由；
     ② 留一份**余量**再比（不是「装得下就写」）：写到刚好把盘填满，下一步失败的会是
        rename / `.bak.json` 备份 / 索引写入，那些失败比这一条难解释得多；
     ③ 说的是人话并且点名是哪一个目录、还差多少 —— 「磁盘错误」四个字没人知道该清哪一块。 */
  const DISK_HEADROOM = 32 * 1024 * 1024;
  const mbOf = b => (b / 1048576).toFixed(b >= 1048576 ? 1 : 2) + ' MB';
  function freeBytesOf(dir) {
    if (typeof fs.statfsSync !== 'function') return null;
    try { const s = fs.statfsSync(dir); return s.bsize * s.bavail; } catch { return null; }
  }
  /* 够 → 返回 null；不够 → 返回那句要回给调用方的话（**不抛**：各条路由的失败出口不一样，
     落盘那条回 JSON、FCPXML 包写进 missing / 错误回执，让调用方自己决定怎么说）。 */
  function whyNoSpace(dir, need, what) {
    const free = freeBytesOf(dir);
    if (free === null || free >= need + DISK_HEADROOM) return null;
    return (what ? what + ' ' : '') + '要写 ' + mbOf(need) + '，而「' + dir + '」所在的盘只剩 ' + mbOf(free)
      + '（还要留 ' + mbOf(DISK_HEADROOM) + ' 余量给改名与备份）—— 腾点空间或换一个盘再试';
  }
  /* ---------- 启动时清掉崩溃残留的临时写入文件 ----------
     两处原子写（`.data/<key>.json` 与 `.data/local-assets/index.json`）都是「写 <目标名>.tmp-<pid>-<随机串> → rename」，
     正常路径要么 rename 走、要么 catch 里 unlink 掉，**只有进程被硬杀 / 断电才会留下**。
     留下的害处不是占地方（一份 JSON 几十 KB）：`GET /data` 的清单与设置页「数据与备份」会把它们
     列成来路不明的条目，而磁盘对账也会把多出来的名字当成一份没登记的产物。
     三条口径：
     ① **只认自己写出来的那一个形状**（`.tmp-<数字>-<2~8 位小写字母数字>` 结尾），
        用户放进这两个目录的文件名再奇怪都不碰 —— 这条路由删的是我们自己的垃圾，不是用户的东西；
     ② **认年龄**（写完不满 15 分钟的一律不动）：同一台机器上可能同时跑着另一个实例，
        它正在写的那个临时文件与残留形状一模一样，只看形状就会删掉别人在途的那一次。
        不用名字里的 pid 判活（Windows 会回收 pid，撞号的残留反而永远清不掉）；
     ③ 尽力而为：读不到目录 / 删不掉只记一行，**绝不影响启动**。 */
  const TMP_STALE_RE = /\.tmp-\d+-[a-z0-9]{2,8}$/;
  const TMP_STALE_MS = 15 * 60 * 1000;
  function sweepStaleTmp(dirs) {
    let n = 0;
    (dirs || [dataDirPath(), INDEX_DIR(), DIR()]).forEach(dir => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }        // 目录还没建 = 没有残留可言
      names.forEach(name => {
        const f = path.join(dir, name);
        /* 类型子目录再进一层：产物本体现在落在 库根\图片\ 这一档里，
           半成品（`.tmp-` 那份）也跟着落在同一层，只扫库根就永远清不掉它。 */
        let isDir = false;
        try { isDir = fs.statSync(f).isDirectory(); } catch { /* 摸不到就当不是目录 */ }
        if (isDir) { if (dir === DIR() && !SKIP_DIR_NAMES.has(name)) sweepStaleTmp([f]); return; }
        if (!TMP_STALE_RE.test(name)) return;
        try {
          const st = fs.statSync(f);
          if (!st.isFile()) return;
          if (Date.now() - st.mtimeMs < TMP_STALE_MS) return;
          fs.unlinkSync(f);
          n++;
        } catch (e) { log('[清理] 临时文件没删掉（原样留着）：' + f + ' ' + (e.code || e.message)); }
      });
    });
    return n;
  }
  /* ---------- 库根的布局：本体按类型分子目录，账不在库根里 ----------
     库根（localRoot()：默认 系统下载\成像，设置页「本机资产库」那一格可改）下面固定这几档：
       图片\ 视频\ 音频\ —— 产物本体，文件名就是资产库里看到的那个名字（撞名加 -2/-3，不覆盖）
       其他\ —— 扩展名与 mime 都认不出类别的那一份（不替用户编一个类型）
     提示词\ 是 .md 归档（prompts-store），不是产物，所有扫描都跳过它。
     ⚠ 这里**没有**「另存一份到别的文件夹」那一档了：本体本来就落在用户翻得到的地方，
     再拷一份只会让同一个视频在盘上出现两份（这台机器实测 359 份里 344 份字节完全相同），
     而资产库、离线预览、缩略图、删了能回源全靠那一份本体。
     「英文媒体类别 → 中文类型名」在本机代理只这一张表（2026-10-15 从两份逐字相同的表收成一份：
     落点目录那一头叫 `saveKindZh`、本机资产那一头叫 `LOCAL_KIND_ALIAS`，谁改了其中一份另一份不知道，
     表现是「磁盘上的文件夹叫图片、资产库列表里却按另一套名字筛」）。
     ⚠ 这一族的名字是**素材**的名字（音频），与浏览器侧那张「供应商类型」的表（`ui.js` 的 `provKindZh`，
       audio 那一格叫「语音」—— 一型供应方，不是一条素材）差一格，两边不许合并；
       表名也故意不叫 `KIND_ZH`：同名而不同值，迟早被人当成重复实现合并掉。
     与浏览器侧的关系：中文类型名 → `video / audio / image` 那份反查在 `ui.js` 的 `mediaKindOf`，
     Node 里没有 window，所以这张小表必须在本机各留一份（与 `fileSafe` / `dayKey` 同一类登记在案的例外）。 */
  const MEDIA_KIND_ZH = { image: '图片', video: '视频', audio: '音频' };
  const typeLabel = t => MEDIA_KIND_ZH[t] || t;
  /* 系统「下载」文件夹 / 各个根：口径只有一份，在 server/user-dirs.js——
     prompts-store 也 require 同一份，不许各拼各的「下载」路径。 */
  const userDirs = require('./user-dirs.js');
  const OTHER_DIR_NAME = '其他';
  /* 库根里**不当产物**的那几档：提示词归档（.md）、FCPXML 工程目录与回收站（搬东西时留下的空壳）。
     dirScan 是递归的，第一层不跳过就等于把整棵子树都算进来：FCPXML工程/<id>/media/ 里全是
     导出时拷进去的素材副本，会被 localAdopt 当成「用户自己放进来的产物」补进索引、被用量统计
     算成重复文件。名字读 user-dirs 那一枚，与导出端同源。 */
  const SKIP_DIR_NAMES = new Set([userDirs.PROMPTS_DIR_NAME, userDirs.FCPXML_PROJECT_DIR, '.trash']);
  /* 某一类本体的目录（绝对路径，按当前库根现算 —— 库根改了不必重启）。 */
  const bodyDirOf = zh => path.join(DIR(), String(zh || OTHER_DIR_NAME));
  /* 一条产物该落哪一档：**只认扩展名表与 mime**，认不出就 其他。
     刻意不吃 `localMediaType` 那句「兜底成音频」：兜底在索引里顶多筛错档，
     落到目录上就是替用户把一份不知道是什么的字节塞进 音频\。
     ⚠ `LOCAL_KIND_BY_EXT` 在模块层（isMediaExt 用的那张表），这里只**引用**，
       与下面 `productKindOfName` 引同一张表是同一个道理。 */
  function bodyDirNameOf(x) {
    const fmt = String((x && x.format) || '').toLowerCase().replace(/^\./, '');
    if (LOCAL_KIND_BY_EXT[fmt]) return LOCAL_KIND_BY_EXT[fmt];
    const m = String((x && x.mime) || '').toLowerCase();
    if (m.startsWith('image/')) return '图片';
    if (m.startsWith('video/')) return '视频';
    if (m.startsWith('audio/')) return '音频';
    return OTHER_DIR_NAME;
  }
  /* 「图片/视频/音频」反回 image/video/audio。类型判据只有 localMediaType 一处，
     这里只做中英互转，不另写一份扩展名名单（LOCAL_KIND_BY_EXT 已经有一份了）。 */
  const saveKindOf = zh => Object.keys(MEDIA_KIND_ZH).find(k => MEDIA_KIND_ZH[k] === zh) || '';
  /* 在 dir 里找一个不撞名的文件名：同名加 -2 / -3 序号，**不覆盖** ——
     覆盖会把用户自己整理过的文件名换掉，而且没有任何提示。
     落点只有 newBodyPlace 一处走这一份：各写一遍就会出现「这一回叫 a-2、下一回生成又叫 a-2」
     这种同目录里两套编号。 */
  function saveUniqueName(dir, base, onTooMany) {
    let file = base, n = 2;
    while (fs.existsSync(path.join(dir, file))) {
      const dot = base.lastIndexOf('.');
      file = (dot > 0 ? base.slice(0, dot) : base) + '-' + n + (dot > 0 ? base.slice(dot) : '');
      n++;
      if (n > 999) return onTooMany();
    }
    return file;
  }
  /* ---------- 一条记录怎么指回盘上那个文件：三级认回 ----------
     账里的 `file` 是**相对库根**的路径（图片\xxx.png）。用户改名、挪到别的类型目录、整堆搬到另一块盘，
     路径都会失效，而文件还是那一个文件 —— 所以认回按三级走：
       ① 相对路径还在 → 直接用（常态，一次 stat）；
       ② fid（`dev:ino`）对得上 → 同卷改名 / 移动，ino 不变，扫一次目录就认得；
       ③ 采样内容签名（字节数 + 头尾各 1MB 的 sha1，ImageMagick 的 imohash 同一族做法）对得上 →
          跨盘复制、换机、被同步盘重写一遍，这些场合 dev/ino 全变了，路径与 fid 都指望不上，只有内容还认得。
     认回来就把新的 `file` / `fid` / `sig` 一起写进账，下一次就又是①那条常态路。
     三级全落空才说「文件不在了」：不假装还在，也不顺手删条目 —— 条目里还留着回源外链与费用那笔账。 */
  const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
  const absKey = p => { const s = String(p || ''); return CASE_INSENSITIVE_FS ? s.toLowerCase() : s; };
  /* 账里的 file：相对库根，也认绝对路径（历史条目，以及刚从旧目录搬进来还没落定的那一条）。 */
  function entryAbsOf(ent) {
    const f = String((ent && ent.file) || '');
    if (!f) return '';
    try { return path.isAbsolute(f) ? path.normalize(f) : path.join(DIR(), f); } catch { return ''; }
  }
  /* fid = `<dev>:<ino>`，都取字符串（不 Number()：超过 2^53 会丢精度，而 NTFS 的 ino 真能超过）。
     ⚠ 必须用 `{ bigint: true }` 那一次 stat：普通 statSync 交回来的是已经丢过精度的 double，
       同一个文件的两条账就可能算出两个号 —— 写盘那一条与扫盘认回那一条对不上，②那一级永远落空。
     整站只有这一处算法（落盘那一条与磁盘对账那一条都调 fileFidOf）。 */
  const fidOfStat = st => String(st.dev) + ':' + String(st.ino);
  function fileFidOf(abs) {
    try { return fidOfStat(fs.statSync(abs, { bigint: true })); } catch { return ''; }
  }
  const SIG_SAMPLE = 1024 * 1024;
  /* 采样内容签名：`字节数:头尾各 1MB 的 sha1 前 16 位`。
     为什么不用整份 sha1：这一枚在磁盘对账时要给「同字节数的那几个」现算，
     一条 788MB 的片子读全量是几百毫秒的**主线程同步阻塞**，
     而认「还是不是这一个文件」靠长度 + 头尾两段已经够。
     ⚠ 它是「把已经落盘的那一条找回来」的钥匙，不是「这两份内容一模一样」的证据：
       头尾相同、中间不同的两个文件会算出同一个签名。所以靠它动手的地方（认回路径、
       删一张卡带走同一产物的那几张）都以「同一件事的两种落点」为前提，不用它决定删哪一份。 */
  function localSigOf(file, size) {
    let fd = 0;
    try {
      fd = fs.openSync(file, 'r');
      const n = Number(size);
      if (!Number.isFinite(n) || n < 0) return '';
      const head = Buffer.alloc(Math.min(n, SIG_SAMPLE));
      if (head.length) fs.readSync(fd, head, 0, head.length, 0);
      let tail = head;
      if (n > SIG_SAMPLE * 2) {
        tail = Buffer.alloc(SIG_SAMPLE);
        fs.readSync(fd, tail, 0, SIG_SAMPLE, n - SIG_SAMPLE);
      }
      const h = crypto.createHash('sha1');
      h.update(head);
      if (tail !== head) h.update(tail);
      return n + ':' + h.digest('hex').slice(0, 16);
    } catch { return ''; }
    finally { if (fd) { try { fs.closeSync(fd); } catch {} } }
  }
  /* 库根的一次磁盘对账快照：readdir + stat，**不读内容**（签名只在真要认回/补建时才算，
     而且先按字节数分桶，同字节数只有一个的候选什么都不用读）。
     跳开提示词那一档与回收站；30 秒内的同一份根直接复用（列表、认回、用量三处共用这一份）。 */
  let scanCache = null;
  const SCAN_TTL = 30 * 1000;
  /* 快照「新到不用再翻一遍」的那一档：只有超过它的陈旧快照才值得为一条认不回的账补一趟强制重扫。
     为什么要有这一档 —— 强制重扫挂在「这一条没命中」之后，一次批量读里凡是落空的账都翻得起一趟整库，
     几百条本体被删掉的库就是几百趟同步 readdir + stat（跑在主线程上，别的请求全排着）。 */
  const SCAN_FRESH_MS = 2000;
  function dirScan(force) {
    const root = DIR();
    if (!force && scanCache && scanCache.root === root && Date.now() - scanCache.at < SCAN_TTL) return scanCache;
    const files = [];
    const scanTree = (dir, rel) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const name of entries.map(e => e.name)) {
        if (rel === '' && SKIP_DIR_NAMES.has(name)) continue;
        const abs = path.join(dir, name);
        const relPath = rel ? rel + path.sep + name : name;
        let st;
        /* bigint 那一份：ino 超过 2^53 时普通 statSync 交回的是丢过精度的 double（见上面 fileFidOf）。
           字节数与修改时间在下面都要显式收回 Number —— Map 的键与 `Number(ent.byte_length)` 那一档比的是数字，
           BigInt 直接当键会让 bySize 永远查不中（123n 与 123 不是同一个键）。 */
        try { st = fs.statSync(abs, { bigint: true }); } catch { continue; }
        if (st.isDirectory()) { scanTree(abs, relPath); continue; }
        if (!st.isFile()) continue;
        files.push({ rel: relPath, abs, size: Number(st.size), mtimeMs: Number(st.mtimeMs), fid: fidOfStat(st), sig: '' });
      }
    };
    scanTree(root, '');
    const byAbs = new Map(), byFid = new Map(), bySize = new Map();
    for (const f of files) {
      const k = absKey(f.abs);
      if (!byAbs.has(k)) byAbs.set(k, f);
      if (!byFid.has(f.fid)) byFid.set(f.fid, f);
      const a = bySize.get(f.size); if (a) a.push(f); else bySize.set(f.size, [f]);
    }
    scanCache = { at: Date.now(), root, files, byAbs, byFid, bySize };
    return scanCache;
  }
  const invalidateScan = () => { scanCache = null; };
  /* 在某一次磁盘快照里给一条账找文件：相对路径 → fid → 采样签名。**只认不写**，
     用量体检与补账都要靠它判「这一条到底还在不在」，那两处不该顺手改账。
     `altPaths` 是同内容并进来的那几份（见 localAdopt），它们同样是这一条的自己。 */
  function resolveInScan(sc, ent) {
    if (!ent) return null;
    const direct = entryAbsOf(ent);
    let hit = direct ? sc.byAbs.get(absKey(direct)) : null;
    if (!hit) {
      for (const p of (Array.isArray(ent.altPaths) ? ent.altPaths : [])) {
        const s = String(p || '');
        if (!s) continue;
        hit = sc.byAbs.get(absKey(path.isAbsolute(s) ? s : path.join(sc.root, s)));
        if (hit) break;
      }
    }
    if (!hit && ent.fid) hit = sc.byFid.get(String(ent.fid)) || null;
    if (!hit && ent.sig) {
      const same = sc.bySize.get(Number(ent.byte_length) || -1) || [];
      for (const f of same) {
        if (!f.sig) f.sig = localSigOf(f.abs, f.size);
        if (f.sig && f.sig === ent.sig) { hit = f; break; }
      }
    }
    return hit || null;
  }
  /* 三级认回的唯一入口（读路径）：返回绝对路径，'' = 真找不到 —— 调用方照实说「文件不在了」。
     走到②③那两级时把新路径与 fid / sig 一起写回账：认一次落一次，下一次又是①那条常态路。
     ⚠ 早先这里认回来之后调的是 `indexStore.upsert(ent.id, ent)`，而 upsert 的签名是 `upsert(item)`：
       第一个参数被当条目用，`.id` 取在一个字符串上，putInto 当场抛「索引条目缺少 id」，又被 catch 咽掉。
       结果是「跟住改名」只在当次请求里成立，账永远没改，每读一次就重扫一遍目录。现在写的是整条。 */
  function localFileFromEntry(ent) {
    if (!ent || !ent.file) return '';
    const direct = entryAbsOf(ent);
    if (direct && fs.existsSync(direct)) return direct;
    /* 常态是第一句 existsSync 就返回，不花钱；走到这里都是「账对不上盘」的那几次。
       那一份磁盘快照可能是几十秒前的：用户在文件管理器里又挪了一刀，快照里就还留着**上一个位置**。 */
    let sc = dirScan();
    let hit = resolveInScan(sc, ent);
    /* 快照里没有 = 可能刚被挪了一刀（账还指着老位置），也可能是真删了。前者要靠强制重扫认回来，
       后者重扫多少趟都还是不在 —— 所以查不到时只有快照已经过旧（超过 SCAN_FRESH_MS）才补这一趟：
       一批落空的账合起来翻一趟，翻完那一份新快照交给同批剩下的每一条（走 TTL）。
       改名 / 换目录那一级不吃这一档：ino 没变，旧快照里按 fid 照样查得着。 */
    if (!hit) {
      if (Date.now() - sc.at > SCAN_FRESH_MS) { sc = dirScan(true); hit = resolveInScan(sc, ent); }
    } else if (!fs.existsSync(hit.abs)) {
      /* 查着了但那个路径当场不在：这份快照连「还在不在」都在说假话，重扫一次。 */
      sc = dirScan(true);
      hit = resolveInScan(sc, ent);
    }
    if (!hit || !fs.existsSync(hit.abs)) return '';
    ent.file = path.relative(sc.root, hit.abs) || hit.rel;
    ent.fid = hit.fid;
    if (!ent.sig) ent.sig = hit.sig || localSigOf(hit.abs, hit.size);
    try { indexStore.upsert(ent); }
    catch (e) { log('[local-assets] 认回后的路径没写进账（本次按读到的算）：' + e.message); }
    return hit.abs;
  }
  /* ---------- 盘上有、账里没有的那一份：补一条账 ----------
     手动下载后自己拖进 图片\ 的、从别的机器拷过来的一堆、被上限挤出去的那一批，都靠这一步重新看得见。
     三条规矩：
     ① **只补扩展名认得出类别的那些**（.md / .txt / 用户自己的笔记一律不动 —— 替它们编一条「产物」是假话）；
     ② 能通过 fid 或采样签名对上已有那一条的，**不新开**，把新路径挂到它名下（`altPaths`）——
        这是「同一份产物重复下载只出现一张卡」的另一半：文件都在盘上，列表里是一条，
        而两个路径都取得到东西，收藏与工作区里存过的 `/asset/<老号>` 不许断；
     ③ 只写账、**不碰盘上的字节**（不重命名、不移动、不删 —— 那是用户的东西，要搬得用户点头）。
     返回补了几条、跳了几条；调用点是启动一次与列表前一次（都带 dirScan 的 30 秒缓存）。 */
  function mintAssetId() {
    return 'la_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function localAdopt(force) {
    const sc = dirScan(force);
    const list = localIndexRead();
    const knownAbs = new Set(), knownFid = new Set(), knownSig = new Map();
    for (const x of list) {
      if (!x || !x.file) continue;
      const hit = resolveInScan(sc, x);
      if (hit) knownAbs.add(absKey(hit.abs));
      knownAbs.add(absKey(entryAbsOf(x)));
      if (x.fid) knownFid.add(String(x.fid));
      if (x.sig && x.byte_length) {
        const a = knownSig.get(x.sig);
        if (a) a.push(x); else knownSig.set(x.sig, [x]);
      }
    }
    const added = [];
    let skipped = 0;
    for (const f of sc.files) {
      if (knownAbs.has(absKey(f.abs))) continue;
      const fmt = (path.extname(f.abs).slice(1) || '').toLowerCase();
      const zh = LOCAL_KIND_BY_EXT[fmt];
      if (!zh) { skipped++; continue; }                 // 认不出类别的文件不补账（.md 与笔记在这一档被挡掉）
      if (knownFid.has(f.fid)) { skipped++; continue; }
      /* 只有真需要分辨「同字节数的还不止这一个」时才现算签名：
         一个目录里 size 独一份的文件，一个字节都不用读。 */
      const same = sc.bySize.get(f.size) || [];
      const sig = same.length > 1 || !f.size ? localSigOf(f.abs, f.size) : '';
      const peers = sig ? knownSig.get(sig) : null;
      if (peers && peers.length) {
        const ent = peers.find(x => resolveInScan(sc, x)) || peers[0];
        const rel = path.relative(sc.root, f.abs);
        ent.altPaths = (Array.isArray(ent.altPaths) ? ent.altPaths : []).concat([rel]);
        try { indexStore.upsert(ent); } catch (e) { log('[local-assets] 同内容并账没写成：' + e.message); }
        skipped++;
        continue;
      }
      const item = {
        id: mintAssetId(), file: f.rel, name: path.basename(f.rel), mime: MIME['.' + fmt] || 'application/octet-stream',        format: fmt, byte_length: f.size, created_at: new Date(f.mtimeMs).toISOString(),
        media_type: zh, provider: 'local',
        prompt: '', model: '', voice: '', duration: null, credits: null, priceText: '', chars: null, usage: null,
        upstream: '', fid: f.fid, sig: sig || localSigOf(f.abs, f.size), adopted: true,
      };
      try { indexStore.upsert(item); added.push(item); }
      catch (e) { log('[local-assets] 补账没写成（文件仍在盘上）：' + e.message); continue; }
      /* 刚补的那一条要立刻算「已经认过了」：同一趟里后面那份同内容的文件才会走②的并账，
         而不是又开一张新卡（一次拷进来几百份重复，列表就几百张卡）。 */
      knownAbs.add(absKey(f.abs));
      if (f.fid) knownFid.add(String(f.fid));
      if (item.sig) { const a = knownSig.get(item.sig); if (a) a.push(item); else knownSig.set(item.sig, [item]); }
    }
    if (added.length || skipped) log('[local-assets] 磁盘对账：补 ' + added.length + ' 条账，' + skipped + ' 份并到已有条目或跳过');
    return { added: added.length, skipped };
  }
  /* ---------- 一次性重建：旧账与旧本体整体搬进库根的回收站 ----------
     为什么要有这一步：旧账里的身份是靠浏览器镜像逐条「学」回来的，镜像一丢（换端口、清站点数据、
     换机器）那些行就只剩路径与字节，按平台产物号 / 来源地址都查不到 —— 云端签名一过期，
     界面就说「已丢失」，而文件明明还在。修法不是继续修补旧账，而是把旧账与旧本体一起收走，
     之后由平台列表重新生成一份**每条都带产物号**的新账。
     三条口径：
     ① **搬，不删**：整批移动到 `库根\.trash\rebuild-<时刻>\`，保留原来的相对路径；
        用户后悔时整目录搬回来即可。只搬媒体扩展名认得出的文件，笔记 / 字幕 / 其它文档不动；
        提示词归档与 `.trash` 自身不扫。
     ② 账清空之后才写标记（`<数据目录>\local-assets\rebuild.json`）：标记是「这次重建已经做完」
        的唯一凭据，写早了会让没清掉的账再也等不到下一次机会。
     ③ 只在启动时跑一次；失败不拦启动（启动日志照实报搬了几份、几份没搬动）。 */
  const REBUILD_MARK = 'rebuild.json';
  function rebuildBodiesOnce() {
    const markPath = path.join(INDEX_DIR(), REBUILD_MARK);
    if (fs.existsSync(markPath)) return { skipped: true, moved: 0, failed: 0, cleared: 0, trash: '' };
    /* 账本来就是空的 = 没有要重建的东西（新机器 / 刚清过数据）：这时候把一份存在多年的库根
       搬进回收站只会让用户的作品凭空消失一趟。标记照写，这一趟到此为止。 */
    if (!localIndexRead().length) {
      try {
        fs.mkdirSync(INDEX_DIR(), { recursive: true });
        fs.writeFileSync(markPath, JSON.stringify({ v: 2, at: new Date().toISOString(), trash: '', moved: 0, failed: 0, cleared: 0 }));
      } catch (e) { log('[local-assets] 重建标记没写成：' + e.message); }
      return { skipped: true, moved: 0, failed: 0, cleared: 0, trash: '' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
    const trashRoot = path.join(DIR(), '.trash', 'rebuild-' + stamp);
    let moved = 0;
    const failed = [];
    const moveTree = (dir, rel) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (rel === '' && SKIP_DIR_NAMES.has(name)) continue;
        const abs = path.join(dir, name);
        const relPath = rel ? rel + path.sep + name : name;
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) { moveTree(abs, relPath); continue; }
        if (!st.isFile()) continue;
        const fmt = (path.extname(name).slice(1) || '').toLowerCase();
        if (!LOCAL_KIND_BY_EXT[fmt]) continue;      // 只搬产物本体；用户自己的文档原样留着
        try {
          const to = path.join(trashRoot, relPath);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(abs, to);
          moved++;
        } catch (e) {
          failed.push(relPath + '（' + (e.code || e.message) + '）');
        }
      }
    };
    moveTree(DIR(), '');
    const cleared = localIndexRead().length;
    indexStore.write([]);                            // 写不成会抛 indexWrite，标记因此不写，下次开机重试
    invalidateScan();
    try {
      fs.mkdirSync(INDEX_DIR(), { recursive: true });
      fs.writeFileSync(markPath, JSON.stringify({
        v: 2, at: new Date().toISOString(), trash: trashRoot, moved, failed: failed.length, cleared,
      }));
    } catch (e) {
      log('[local-assets] 重建标记没写成（下次开机会再跑一遍，库根已空时不会重复搬）：' + e.message);
    }
    if (failed.length) log('[local-assets] 重建时这几份没搬进回收站（原样留在库根）：' + failed.join('、'));
    return { skipped: false, moved, failed: failed.length, cleared, trash: trashRoot };
  }
  /* ---------- 一条产物该落在哪、叫什么：唯一出处 ----------
     规范名 = 人类可读名（调用方给的 `name`，导演台是「场景+镜头+候选」，别的页是提示词前缀）
     洗过之后的那一段 + 恰好一个扩展名；同名不覆盖，加 -2 / -3。
     没有名字才退回资产号当文件名（仍然可读：la_xxx.mp4，只是不好看）。 */
  function bodyBaseNameOf({ name, id, format }) {
    const fmt = String(format || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const raw = String(name || '').trim();
    const stem = fileSafe(raw.replace(/\.[A-Za-z0-9]{1,6}$/, ''), 80) || fileSafe(id, 40);
    return (stem || id || '素材') + (fmt ? '.' + fmt : '');
  }
  /* 落点一次算全：目录（会 mkdir）、相对库根的路径、绝对路径、最终文件名。
     库里已经有的那份**字节**由磁盘对账那一级认回（dirScan → localAdopt），不在这里比：
     同名而内容不同的两份是两个作品，各自一个文件、各一张卡才对。 */
  function newBodyPlace(spec) {
    const fmt = String(spec.format || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const zh = bodyDirNameOf({ format: fmt, mime: spec.mime });
    const dir = bodyDirOf(zh);
    fs.mkdirSync(dir, { recursive: true });
    const base = bodyBaseNameOf({ name: spec.name, id: spec.id, format: fmt });
    const file = saveUniqueName(dir, base, () => base.replace(/(\.[^.]+)?$/, m => '-' + Date.now().toString(36) + m));
    return { dir, file: zh + path.sep + file, abs: path.join(dir, file), name: file, 类型: zh };
  }
  const LOCAL_INDEX_MAX = 20000;
  /* 账本落在 .data\local-assets\，与本体分开：本体是用户翻得到、可以自己整理的作品，
     账是应用的私有记录 —— 换库根时账跟着应用走，不必把一堆 json 塞进用户的作品文件夹。 */
  const indexStore = createIndexStore({ dir: INDEX_DIR(), log, max: LOCAL_INDEX_MAX });
  const localIndexRead = () => indexStore.read();
  const localIndexEntry = id => indexStore.entry(id);
  const localIndexUpsert = item => indexStore.upsert(item);

  /* 读路径只查账，**不在这里补建**：`/asset/<id>` 每张缩略图都要走它，
     一个不存在的 id 被轮询时（页面 3 秒一问）每次都会扫一遍库根。
     要补建的入口单独一个 localAssetRepair（见下），由真正要拿文件的操作显式调用。 */
  function localAssetEntry(id) {
    return localIndexEntry(id);
  }
  /* ---------- 「这条地址取回来的字节是不是就在库根里」 ----------
     浏览器那一份别名表只活在当前会话、按源（端口）分家：换端口、清浏览器数据、无痕窗口都会清空。
     它是缓存 —— 账与字节都在代理这边，
     所以「云端签名失效 / 平台上被清理之后本机那份还看不看得见」必须在这里能判。
     两句判据：来源地址剥掉签名参数后的身份（localUpKey，与并卡、去重同一把尺子）、
     平台产物号（落盘时写下的 detail.asset；任务号只在整条任务只出一份时用，多图任务按它合会认错文件）。 */
  let byUp = null, byUpRev = -1;
  function upstreamIndex() {
    const rev = indexStore.version();
    if (byUp && byUpRev === rev) return byUp;
    const m = new Map();
    for (const x of localIndexRead()) {
      const k = localUpKey(x && x.upstream);
      if (!k) continue;
      const a = m.get(k);
      if (a) a.push(x); else m.set(k, [x]);
    }
    byUp = m; byUpRev = rev;
    return m;
  }
  function localEntryByUpstream(url) {
    const key = localUpKey(url);
    if (!key) return null;
    for (const ent of (upstreamIndex().get(key) || [])) {
      const file = localFileFromEntry(ent);
      if (file) return { ent, file };
    }
    return null;
  }
  let byPlat = null, byPlatRev = -1;
  function platformIndex() {
    const rev = indexStore.version();
    if (byPlat && byPlatRev === rev) return byPlat;
    const byAsset = new Map(), byTask = new Map();
    for (const x of localIndexRead()) {
      const { assetId, taskId } = identityOf(x);
      if (assetId) { const a = byAsset.get(assetId); if (a) a.push(x); else byAsset.set(assetId, [x]); }
      if (taskId) { const a = byTask.get(taskId); if (a) a.push(x); else byTask.set(taskId, [x]); }
    }
    byPlat = { byAsset, byTask }; byPlatRev = rev;
    return byPlat;
  }
  function localEntryByPlatformId(id) {
    const s = String(id || '');
    if (!s || /^la_/.test(s)) return null;
    const idx = platformIndex();
    const one = idx.byTask.get(s);
    const rows = idx.byAsset.get(s) || (one && one.length === 1 ? one : []);
    for (const ent of rows) {
      const file = localFileFromEntry(ent);
      if (file) return { ent, file };
    }
    return null;
  }
  /* ---------- 浏览器那份别名字典的唯一来源 ----------
     浏览器这一侧不存索引：按源分家的一份缓存（换端口、清浏览器数据、无痕窗口都会空掉）只会让
     同一份产物被重新下载、界面显示「已丢失」而库根里文件一份没少。
     字节与身份都只住在代理这边，浏览器每次开机问一次「哪个平台产物 → 本机哪个号」，
     问到的只是指针（不下载字节），丢了再问一次即可 —— 它不再是一份需要备份、迁移、修复的持久状态。
     `rev` 是账本版本，浏览器拿它判「这份快照是不是比本地刚补的那几条旧」。 */
  function aliasRowOf(x) {
    if (!x || !x.id) return null;
    const { assetId, taskId } = identityOf(x);
    const up = localUpKey(x.upstream);
    /* 没有身份的账行也要交出去：浏览器拿这份快照当「本机有哪些文件」的全集
       （条数 / 字节 / 落点 / 格式）。少掉裸行，资产库统计会比盘上少一截，
       而裸行本身仍要能被 /local-assets/<id> 取到 —— 只是按身份查不到它。 */
    return {
      id: String(x.id), assetId, taskId, up,
      upstream: String(x.upstream || ''),
      format: String(x.format || ''), name: String(x.name || ''),
      byte_length: Number(x.byte_length) || 0,
      media_type: String(x.media_type || ''), created_at: String(x.created_at || ''),
      file: String(x.file || ''),
    };
  }
  /* 「这一条账的本体还在不在」——批量那一族（别名快照 / 批量定位）的唯一走法。
     为什么不能逐条 `localFileFromEntry`：那一条的常态是 `fs.existsSync(直接路径)`，
     一次一问就是几百次同步 stat（实测 600 行 = 260ms，线性涨），而这两族都站在开机与
     列表的关键路径上、又都跑在代理的主线程 —— 那 260ms 里别的请求一个也进不来。
     磁盘对账那一趟 readdir+stat 已经把库根每个文件摸过一遍，账里的相对路径还在不在，
     查那张表就够了；查不到才退回逐条认回（改名 / 挪目录 / 换盘那三级判据与「认一次落一次」
     都只活在那里，快照里没有的也可能是刚落盘的新本体 —— 30 秒内的那一份是旧的）。 */
  function bodyInScan(sc, x) {
    const direct = entryAbsOf(x);
    if (!direct) return '';
    const hit = sc.byAbs.get(absKey(direct));
    return hit ? hit.abs : '';
  }
  function localAliases() {
    const sc = dirScan();
    const rows = [];
    for (const x of localIndexRead()) {
      const row = aliasRowOf(x);
      if (!row) continue;
      /* 文件不在了就不许替它报「本机有」：否则界面会一直画着「本机+云端」，
         点开却是一条断链。认回（改名 / 挪目录 / 换盘）会在这里顺手把新落点写回账。 */
      if (!bodyInScan(sc, x) && !localFileFromEntry(x)) continue;
      row.file = String(x.file || '');
      rows.push(row);
    }
    return { rev: indexStore.version(), rows };
  }
  /* 批量问「这几件平台产物在本机是哪一份」。判据与 localEntryByPlatformId / localEntryByUpstream
     同一把尺：产物号 → 任务号（只在整条任务只出一份时）→ 来源地址（剥签名）。
     调用方（资产列表）先拿到结果再决定卡片上的地址，所以这里**只读、不补建、不下载**；
     文件仍在才算命中，同一个号的几份重复副本取第一条还在地的。 */
  function localLocateBatch(queries) {
    const plat = platformIndex();
    const ups = upstreamIndex();
    const list = Array.isArray(queries) ? queries : [];
    /* 一次批量最多 2000 条问话，每条都可能顺着身份翻到几行账 —— 同一份磁盘快照查表，
       别把每一问都变成一次同步 stat（判据与走法见上面 bodyInScan）。
       快照按第一次真要判存在时才取：一批问话全落在平台号之外时不该扫一遍盘。 */
    let snap = null;
    const diskShot = () => (snap || (snap = dirScan()));
    const present = x => !!(bodyInScan(diskShot(), x) || localFileFromEntry(x));
    const out = [];
    for (const q of list) {
      const aid = String((q && q.assetId) || '');
      const task = String((q && q.taskId) || '');
      const url = String((q && (q.url || q.upstream)) || '');
      const allowGen = !!(q && q.allowGen);
      let ent = null;
      if (aid && !/^la_/.test(aid)) {
        for (const x of (plat.byAsset.get(aid) || [])) { if (present(x)) { ent = x; break; } }
      }
      /* 任务号只在**这一条任务恰好只有一份产物**时才算数：多图任务按任务号认，
         四张卡会一起指向同一个本机文件（比不合更糟）。 */
      if (!ent && allowGen && task) {
        const one = plat.byTask.get(task) || [];
        if (one.length === 1 && present(one[0])) ent = one[0];
      }
      if (!ent && url) {
        const key = localUpKey(url);
        if (key) for (const x of (ups.get(key) || [])) { if (present(x)) { ent = x; break; } }
      }
      out.push(ent ? aliasRowOf(ent) : null);
    }
    return out;
  }
  /* 本机资产的大类型（图片 / 视频 / 音频）：先看扩展名（表在模块层的 LOCAL_KIND_BY_EXT，
     落盘文件名就是 <id>.<格式>，最可靠），再按 mime，最后按调用方给的 media_type
     （英文写法认成中文）。缺省过去写死 audio，「短剧末帧」这种没传类型的 PNG 就被记成音频，
     资产库按图片筛永远挑不到它。末尾那句「认不出兜底成音频」只服务**老数据的读路径**
     （列表 / 认回要能读旧账，不能崩）；新条目进不来这一步 —— 两个写入口在落字节之前
     先过 isMediaExt 那道闸（server/routes/local-assets.js）。 */
  function localMediaType(x) {
    if (!x) return '音频';
    const fmt = String(x.format || path.extname(x.file || '')).toLowerCase().replace(/^\./, '');
    if (LOCAL_KIND_BY_EXT[fmt]) return LOCAL_KIND_BY_EXT[fmt];
    const m = String((x && x.mime) || '').toLowerCase();
    if (m.startsWith('image/')) return '图片';
    if (m.startsWith('video/')) return '视频';
    if (m.startsWith('audio/')) return '音频';
    const given = String((x && x.media_type) || '').trim();
    return given ? (MEDIA_KIND_ZH[given.toLowerCase()] || given) : '音频';
  }
  /* 「磁盘上这一个文件名属不属于某一类产物」——**只看扩展名表，不吃 localMediaType 那句音频兜底**。
     索引里那条记录有 mime、有调用方给的 media_type，兜底成音频顶多让资产库筛错档；
     而对着一个目录里的文件名，能证明类型的只有扩展名，兜底就是**替用户编一个类型**：
     用户自己丢在产物目录里的一张便签 `notes.txt` 会被数成「音频」，跟着「按类型清点」被搬走、删掉。
     清点与动手必须共用这一份严格判据：**数得到的才是动得了的**。 */
  function productKindOfName(name) {
    const fmt = String(path.extname(String(name || ''))).toLowerCase().replace(/^\./, '');
    return saveKindOf(LOCAL_KIND_BY_EXT[fmt] || '');
  }
  /* 这一条产物「是什么时候有的」——**必须是生成时间，不是落盘时间**。
     镜像只是把平台上的产物搬到本机这一步：一次回源能把几百条老产物在同一天写进来，
     索引里的 created_at 于是全成了「今天」，按它倒序排就把资产库里唯一那张图片挤出
     选择器「全部」那一档的前 200 条（表现是「导演台开头画面切到『全部』，图片一张都不出现」）。
     落盘时留在索引里的 detail.created 才是那一件事真正发生的时间；本机自己生成的
     （逐句配音、同步产物）没有 detail，才退到 created_at。
     取不出一个能用时间就退回落盘时间，绝不返回空/0 —— 排在最底等于对界面说「没有这回事」。 */
  function localAssetWhen(x) {
    const d = (x && typeof x.detail === 'object' && x.detail) || null;
    const raw = d && (d.created || d.completed);
    let v = raw;
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);           // 纯数字的时间串按数字判
    const ok = (typeof v === 'number' && v > 0)
      || (typeof v === 'string' && !isNaN(Date.parse(v)));
    return ok ? raw : ((x && x.created_at) || '');
  }
  /* 一份产物在本机资产库里的**身份**：来源外链的 host + path（+ 非易变的 query），签名参数一律不参与。
     为什么判据要放在代理这一层：浏览器那一份别名表只在当前会话、按源（端口）分家，挡重复下载
     只能挡住同一个源；换端口、清浏览器数据、开无痕都会让它整份重建 ——
     于是每一次开页面都把**同一份产物**重新下载、重新落盘一份新文件。
     实测这台机器的索引里 290 行只对应 83 份产物（最多的一份重复 15 次，落盘时刻散在七个不同的
     会话里），磁盘 0.45 GB 中真正在用的只有 0.08 GB；而资产库 / 素材选择器看到的就是
     「同一个视频重复出现 N 张卡」。
     「剥掉哪些签名参数」这条判据在 ident.cjs 里只有一份（浏览器当脚本引、Node 侧 require 同一份）——
     以前这里是本文件自己抄的正则，注释写着「两边必须一致」却没有任何东西保证它一致，
     漂一次就是上面那个数字重新涨一遍。 */
  function localUpKey(u) {
    const s = String(u || '');
    if (!/^https?:\/\//i.test(s)) return '';       // 这里只吃上游原始外链（meta.upstream），不会是 /getv 包装
    let x = null;
    try { x = new URL(s); } catch { return ''; }
    return MediaId.upKeyOf(x);
  }
  /* 索引里没有的字段才用新到的那份补上 —— 外链每次镜像的签名参数不同，但提示词 / 任务详情
     是同一件事；把已有非空值覆盖成空值等于「后到的那份把先到的信息弄丢了」。 */
  const LOCAL_FILL_FIELDS = ['prompt', 'model', 'voice', 'priceText', 'upstream', 'assetId', 'taskId'];
  function localFillMissing(old, inc) {
    let changed = false;
    for (const f of LOCAL_FILL_FIELDS) {
      if (!old[f] && inc[f]) { old[f] = inc[f]; changed = true; }
    }
    for (const f of ['duration', 'credits', 'chars']) {
      if (old[f] == null && inc[f] != null) { old[f] = inc[f]; changed = true; }
    }
    if (!old.usage && inc.usage) { old.usage = inc.usage; changed = true; }
    if (!old.detail && inc.detail) { old.detail = inc.detail; changed = true; }   // 生成时间在这里，缺了就只能回落盘时间
    return changed;
  }
  /* 账里根本没有这一个号：只有「文件名就是资产号」的那一批认得回来
     （给不出可读名字时 newBodyPlace 会退回 `la_xxx.<格式>`，旧版资产库根里也全是这个形状）。
     规范名那一些认不回来是**事实**，不是漏洞：号只活在账里，账没了就没有对应关系，
     只能靠磁盘对账（localAdopt）把它当一份「没登记过的产物」补一条新账。
     **明确补建入口**：只有真正要拿文件、而账里没有时才调（localAssetFile / `/asset/<id>`）。
     盘上确实没有的号记 60 秒负缓存 —— 轮询同一个不存在的 id 时不再每次扫一遍库根。 */
  const repairMiss = new Map();
  const REPAIR_MISS_TTL = 60 * 1000;
  function localAssetRepair(id) {
    const clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!clean) return null;
    const missAt = repairMiss.get(clean);
    if (missAt && Date.now() - missAt < REPAIR_MISS_TTL) return null;
    const sc = dirScan();
    /* 同样要先确认那一份还在原地：快照可能是几十秒前的，而这一条会**当成一条新账写进盘**。
       按一个已经不存在的位置补建，界面上就是一条「已丢失」的假条目。 */
    const hit = sc.files.find(f => path.basename(f.abs).replace(/\.[^.]*$/, '') === clean && fs.existsSync(f.abs));
    if (!hit) { repairMiss.set(clean, Date.now()); return null; }
    repairMiss.delete(clean);
    const fmt = (path.extname(hit.abs).slice(1) || 'wav').toLowerCase();
    const mime = MIME['.' + fmt] || 'application/octet-stream';
    const item = {
      id: clean, file: hit.rel, name: path.basename(hit.rel), mime, format: fmt,
      byte_length: hit.size, created_at: new Date(hit.mtimeMs).toISOString(),
      media_type: localMediaType({ mime, format: fmt }),
      prompt: '', model: '', voice: '', provider: 'local', duration: null,
      credits: null, priceText: '', chars: null, usage: null, upstream: '', rebuilt: true,
      fid: hit.fid, sig: hit.sig || localSigOf(hit.abs, hit.size),
    };
    /* 补建是**读**路径上的一步（文件就在眼前，条目已经拼好了），账写不成也不该让读操作失败 ——
       真正需要「写不成就要报错」的是落盘那两条路（见 index-store 里 upsert 的说明）。 */
    try { localIndexUpsert(item); }
    catch (e) { log('[local-assets] 补建条目写账失败（文件仍在，本次按读到的算）：' + e.message); }
    return item;
  }
  function localAssetFile(id) {
    const p = localFileFromEntry(localAssetEntry(id));
    if (p) return p;
    const repaired = localAssetRepair(id);
    return repaired ? localFileFromEntry(repaired) : '';
  }
  /* ---------- 本机资产库占了多少地方（GET /assets-usage 用，只读） ----------
     为什么必须有这一条：库根是这一台机器上唯一**只增不减**的那一堆 ——
     账封顶 `LOCAL_INDEX_MAX` 条，文件却永远不清（删条目时文件删不掉只报错、不裁账），
     而「同一份产物被存了几次」以前只在 `GET /local-assets` 末尾报一个 `duplicates` 数字，
     界面上没有任何地方把它摊开。于是盘涨到几十 GB 之后，人只知道「C 盘满了」，
     不知道是哪些片子、重复了几份、哪一份最占地方 —— 更没有一条安全的路把它降下来。
     三条口径，缺一条这一格就变成假控件：
     ① **只数、只说，一个字节都不写不删**。删本机产物只有资产库那一页那一条路
       （勾卡片 → 删除 → 二次确认 → `DELETE /local-assets/<id>`，删掉文件才裁账）。
       在这里放一颗「一键清理」等于让一次统计顺带删掉用户的作品 —— 而统计**永远分不出**
       「多余的重复」与「账挤出去了但还要留着的历史产物」（就是下面 `没进账` 那一段），
       所以这份读数只负责把话说清、把出路指对。
     ② 判重用的是这一层认身份的同一把尺：来源去重键 `localUpKey`（host + path，签名参数不参与）
       与采样内容签名 `localSigOf`（长度 + 头尾各 1MB）。与 `localAdopt` 并账、
       `GET /local-assets` 收敛列表是同一套判据 —— 在这一格另写一份「按文件名去重」，
       界面上就会出现「这里说没重复、列表里同一份卡三张」。
     ③ 内容级先按 size 分桶、只有**同字节数**才去算签名，并且一次扫描有**字节预算**：
       签名只读头尾两段（每条最多 2 MB），比整份读便宜两个数量级，但仍然要有界 ——
       同步读盘按住的是整个事件循环（期间轮询、`/asset` 取图、播放全部停摆）。
       超预算的那些**照实说**「还有 N 份同大小的没验」，而不是当它们不存在。
     类型那一档走 `productKindOfName`（只看扩展名表，不吃 `localMediaType` 那句音频兜底）——
     对着一堆文件名猜不出类型的就归「其它」，不替用户编一个类型。 */
  const USAGE_TOP = 6;                         // 「最占地方 / 最旧的」各列几条
  const USAGE_HASH_BUDGET = 96 * 1024 * 1024;  // 一次扫描最多验这么多字节的内容
  const USAGE_LOW_FREE = 1024 * 1024 * 1024;   // 这块盘剩不到这么多就把这一格标黄
  const usageSigCache = new Map();             // 相对路径 → { mtimeMs, size, sig }（没改过就免再读）
  const usageKindOf = name => { const k = productKindOfName(name); return k ? typeLabel(k) : '其它'; };
  /* 「这一份是什么时候有的」→ 毫秒：优先生成时间（localAssetWhen，见它的注释），
     账里那条没有 / 补建出来的那条才退到落盘 mtime。取不出时间就回 0（只用于排序，不参与上色）。 */
  function usageWhenMs(ent, mtimeMs) {
    const raw = localAssetWhen(ent);
    if (raw == null || raw === '') return mtimeMs || 0;
    let t = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
    if (!Number.isFinite(t) || t <= 0) return mtimeMs || 0;
    return t;
  }
  async function localUsageScan() {
    const dir = DIR();
    let 目录 = { 路径: dir, 状态: '可写' };
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) 目录 = { 路径: dir, 状态: '路径上有个同名的文件，不是目录 —— 资产库现在读不到任何产物' };
    } catch (e) {
      目录 = { 路径: dir, 状态: (e && e.code === 'ENOENT')
        ? '还没有这个目录（第一次存产物时代理自己会建）'
        : '读不了这个目录：' + ((e && e.code) || (e && e.message) || e) };
    }

    /* 账读不出来时 localIndexRead 已经把坏文件改名留档、返回空表 —— 那一条本函数不重复处理，
       也不写盘（这里只读）；顶到上限那一档据此照实说。 */
    const idxList = localIndexRead();
    const sc = dirScan(true);
    /* 每一条账先在磁盘快照里找到自己的文件（路径 → fid → 签名，**不写账**），
       同一份文件只归给第一条账（索引顺序 = 新→旧），其余指向它的条目算「对不上」。 */
    const entByAbs = new Map();
    const 没了 = [];
    for (const x of idxList) {
      if (!x || !x.file) { if (x) 没了.push(x); continue; }
      const hit = resolveInScan(sc, x);
      if (!hit) { 没了.push(x); continue; }
      const k = absKey(hit.abs);
      if (!entByAbs.has(k)) entByAbs.set(k, x);
    }
    const files = sc.files.map(f => {
      const ent = entByAbs.get(absKey(f.abs)) || null;
      return { name: f.rel, abs: f.abs, size: f.size, mtimeMs: f.mtimeMs, fid: f.fid,
        sig: f.sig || (ent && ent.sig) || '', ent };
    });
    for (const f of files) { f.when = usageWhenMs(f.ent, f.mtimeMs); f.类型 = usageKindOf(f.name); }
    const 总字节 = files.reduce((s, f) => s + f.size, 0);

    /* ---- 按类型 ---- */
    const kindMap = new Map();
    for (const f of files) {
      const g = kindMap.get(f.类型) || { 类型: f.类型, 条数: 0, 字节: 0 };
      g.条数++; g.字节 += f.size; kindMap.set(f.类型, g);
    }
    const 按类型 = [...kindMap.values()].sort((a, b) => b.字节 - a.字节);

    /* ---- 判重：先并成「同一份产物」的组，再按组算多占 ----
       两种身份并成一族（并查集），因为「同一来源的两次镜像」与「字节相同但来源不同」
       说的是同一件事的两半：只按来源认会漏掉换过中转地址重下的那批，只按内容认又说不清
       「是不是同一件作品」。合完之后每组只留最晚那一份，其余记成多占 —— 这样两个口径
       不会把同一份重复算两次。 */
    const nameIdx = new Map();
    files.forEach((f, i) => nameIdx.set(f.name, i));
    const parent = files.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const upMap = new Map();
    for (const f of files) {
      const up = f.ent ? localUpKey(f.ent.upstream) : '';
      if (!up) continue;
      const a = upMap.get(up) || []; a.push(f); upMap.set(up, a);
    }
    let 同来源组 = 0;
    for (const a of upMap.values()) {
      if (a.length < 2) continue;
      同来源组++;
      for (let i = 1; i < a.length; i++) join(nameIdx.get(a[0].name), nameIdx.get(a[i].name));
    }
    /* 内容级：只有 size 在库里出现过 ≥2 次才可能同内容（不同内容的视频 size 几乎必然不同） */
    const sizeMap = new Map();
    for (const f of files) {
      if (f.size <= 0) continue;                       // 空文件不用读也认不出什么，跳过
      const a = sizeMap.get(f.size) || []; a.push(f); sizeMap.set(f.size, a);
    }
    let 读了字节 = 0, 验过文件 = 0, 没验的 = 0, 同内容组 = 0;
    for (const a of sizeMap.values()) {
      if (a.length < 2) continue;
      for (const f of a) {
        if (f.sig) continue;                            // 目录快照或账里已经带过，不用再读
        const hit = usageSigCache.get(f.name);
        if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) { f.sig = hit.sig; 验过文件++; continue; }
        const cost = Math.min(f.size, SIG_SAMPLE * 2);
        if (读了字节 + cost > USAGE_HASH_BUDGET) { f.unchecked = true; 没验的++; continue; }
        f.sig = localSigOf(f.abs, f.size);
        if (!f.sig) { f.unchecked = true; 没验的++; continue; }
        读了字节 += cost; 验过文件++;
        usageSigCache.set(f.name, { mtimeMs: f.mtimeMs, size: f.size, sig: f.sig });
        if (usageSigCache.size > 8000) usageSigCache.clear();   // 缓存本身也要有界（这是长跑进程）
      }
      const sigMap = new Map();
      for (const f of a) {
        if (!f.sig) continue;
        const g = sigMap.get(f.sig) || []; g.push(f); sigMap.set(f.sig, g);
      }
      for (const g of sigMap.values()) {
        if (g.length < 2) continue;
        同内容组++;
        for (let i = 1; i < g.length; i++) join(nameIdx.get(g[0].name), nameIdx.get(g[i].name));
      }
    }
    const groups = new Map();
    files.forEach(f => { const r = find(nameIdx.get(f.name)); const g = groups.get(r) || []; g.push(f); groups.set(r, g); });
    let 重复组 = 0, 多出份 = 0, 多占字节 = 0;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      重复组++;
      /* 留下的那一份 = 最晚生成的那份（不是最大的）：按「哪一份新」留符合直觉，
         而「留最大的」会让人发现留在列表里的那张卡是很久以前那一次。 */
      let keep = g[0];
      for (const f of g) if (f.when > keep.when) keep = f;
      多出份 += g.length - 1;
      for (const f of g) if (f !== keep) 多占字节 += f.size;
    }

    /* ---- 账与磁盘对不上的那两批 ---- */
    const 没进账 = files.filter(f => !f.ent);
    const 没进账字节 = 没进账.reduce((s, f) => s + f.size, 0);
    const 没了字节 = 没了.reduce((s, x) => s + (Number(x.byte_length) || 0), 0);

    const 顶到上限 = idxList.length >= LOCAL_INDEX_MAX;
    const 剩 = freeBytesOf(dir);

    const pick = f => ({ 名称: f.name, 字节: f.size, 类型: f.类型, 时候: f.when,
      哪家: (f.ent && f.ent.provider) || '', 有索引: !!f.ent });
    const 最大 = [...files].sort((a, b) => b.size - a.size).slice(0, USAGE_TOP).map(pick);
    const 最旧 = [...files].sort((a, b) => (a.when - b.when) || (a.mtimeMs - b.mtimeMs)).slice(0, USAGE_TOP).map(pick);

    /* ---- 上色：只在「说不清 / 会丢东西」的那几种情况标黄标红，重复本身不是故障 ----
       页面只读 `档` 上色，不许拿中文猜（与「成片渲染」那一行同一立场）。 */
    let cls = 'ok';
    const 因由 = [];
    if (目录.状态 !== '可写' && 目录.状态.indexOf('还没有这个目录') < 0) { cls = 'err'; 因由.push('目录读不了'); }
    if (顶到上限) { if (cls === 'ok') cls = 'warn'; 因由.push('索引条数已顶到上限'); }
    if (没了.length) { if (cls === 'ok') cls = 'warn'; 因由.push('有账上没文件的条目'); }
    if (剩 !== null && 剩 < USAGE_LOW_FREE) { if (cls === 'ok') cls = 'warn'; 因由.push('这块盘剩余空间不多'); }
    const chip = files.length
      ? 多出份 ? '压了 ' + 多出份 + ' 份重复' : '没有重复'
      : '还没有产物';

    return {
      at: Date.now(),
      目录, 档: cls, 芯片: chip, 因由,
      总: { 字节: 总字节, 文件数: files.length, 索引条数: idxList.length, 上限: LOCAL_INDEX_MAX, 顶到上限 },
      按类型,
      重复: { 组数: 重复组, 多出份数: 多出份, 多占字节, 同来源组, 同内容组,
        验过文件, 读了字节, 预算字节: USAGE_HASH_BUDGET, 没验份数: 没验的,
        判完: 没验的 === 0 },
      对不上: { 索引外文件数: 没进账.length, 索引外字节: 没进账字节,
        没文件条数: 没了.length, 没文件字节: 没了字节 },
      盘: { 剩余: 剩 },
      最大, 最旧,
      几条: USAGE_TOP,
    };
  }
  /* 本地文件读取：支持 Range（播放器可拖动进度），带长缓存（同一 id 内容恒定） */
  /* 文件流 → 响应：读流出错（文件被删、被别的进程占用、磁盘读失败）时 pipe 只会抛一个没人接的 error，
     响应停在「200 头已发、正文永远不来」，页面只能干等到超时。这里把连接掐掉，让客户端立刻拿到网络错误。 */
  function pipeFile(src, res) {
    src.on('error', () => { try { res.destroy(); } catch {} });
    src.pipe(res);
  }
  /* 带 Range 的本地文件响应（落盘目录出口 /asset 唯一的出口）。
     headers 由调用方给（Content-Type / 缓存 / 附件名）。 */
  function sendFileWithRange(req, res, file, headers) {
    const st = fs.statSync(file);
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start, end;
      if (!m[1]) {
        /* bytes=-N：最后 N 字节。以前把这种情况当成「从头开始」，播放器探测文件尾部（moov 在尾部的 mp4）
           会拿到开头几百字节、判断出错。 */
        const n = parseInt(m[2], 10);
        if (!Number.isFinite(n) || n <= 0) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
        start = Math.max(0, st.size - n);
        end = st.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      }
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      pipeFile(fs.createReadStream(file, { start, end }), res);
      return;
    }
    headers['Content-Length'] = String(st.size);
    res.writeHead(200, headers);
    pipeFile(fs.createReadStream(file), res);
  }
  /* entry 由调用方给时就不再全量读一遍账：/asset/<id> 这条链手里已经握着 entry，
     以前却在这里又 localIndexRead() 一次 —— 页面上每一张缩略图、每一个 <video> 都打它，
     账攒大之后就是每个媒体请求 2 次全量读盘解析。
     自己找时按**解析后的绝对路径**比，不比 basename：本体现在住在 库根\图片\ 那一层里，
     不同子目录同名是常事（图片\a.png 与 视频\a.png 是两条账）。 */
  function serveLocalFile(req, res, file, q, entry) {
    const base = path.basename(file);
    if (!entry) {
      const want = absKey(file);
      entry = localIndexRead().find(x => {
        if (!x || !x.file) return false;
        const a = entryAbsOf(x);
        return a && absKey(a) === want;
      }) || {};
    }
    const headers = {
      'Content-Type': entry.mime || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (q && q.get('dl')) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(q.get('name') || entry.name || base);
    sendFileWithRange(req, res, file, headers);
  }

  /* 索引唯一的写入口：串行队列包住读-改-写（见 server/index-store.js 的 update(fn)）。
     `localIndexPut` 只是「怎么动这一条」的规则本身，交给 update 的回调同步调用，
     与同步的 upsert/remove 共用 index-store 里那一份，不在调用点再拼一遍。 */
  const localIndexUpdate = fn => indexStore.update(fn);
  const localIndexPut = (list, item) => indexStore.putInto(list, item);
  const localIndexDrop = (list, id) => indexStore.dropFrom(list, id);

  /* 一条账名下**所有的**文件：本体那一条 + 同内容并进来的那几份（localAdopt 挂的 altPaths）。
     删除要走这一份：界面上是一张卡，卡背后可能是两份字节，只删 `file` 那一份的话
     另一份下一轮对账又被补成一条新账 —— 用户看见「删了又回来」。
     每条路径都过一遍存在性检查：altPaths 是磁盘快照那一刻的记录，用户随时可能自己删掉。 */
  function localAssetPaths(ent) {
    if (!ent) return [];
    const out = [];
    const addPath = p => { if (p && !out.includes(p)) out.push(p); };
    const direct = entryAbsOf(ent);
    if (direct && fs.existsSync(direct)) addPath(direct);
    else addPath(localFileFromEntry(ent));
    for (const p of (Array.isArray(ent.altPaths) ? ent.altPaths : [])) {
      const s = String(p || '');
      if (!s) continue;
      const abs = path.isAbsolute(s) ? s : path.join(DIR(), s);
      if (fs.existsSync(abs)) addPath(abs);
    }
    return out;
  }

  /* 一张卡背后**全部的**账：列表把「同一个上游产物号」或「同一个内容签名」的那几条并成一张卡，
     所以删这一张卡也得按同一把尺子删干净。
     为什么必须连着删：同一份产物从另一个中转地址重下一次（换了域名的 CDN、手工拷进来又存回去的那份）
     认不出同一个来源键，落的是新 id、新文件 —— 盘上两份字节、账上两条、界面上还是一张卡。
     只删手里这一条的话，另一条下一轮又单独成为一张卡，或变成「文件已不在」的空条，
     用户看见的就是「删了又回来」。判据与列表那一处同一份（localUpKey 与 sig），不另起一套。 */
  function localAssetSiblings(all, ent) {
    if (!ent || !ent.id) return [];
    const up = localUpKey(ent.upstream);
    const sig = String(ent.sig || '');
    return (Array.isArray(all) ? all : []).filter(x => {
      if (!x || !x.id || x.id === ent.id) return false;
      if (up && localUpKey(x.upstream) === up) return true;
      return !!sig && String(x.sig || '') === sig;
    });
  }

  /* 交出去的是「组合根要用的那些」，一份不多：落点、认回、账、用量与读文件。
     只在层内用的那一些（类型表 MEDIA_KIND_ZH、目录对账快照 dirScan、账本句柄 indexStore、
     单条读账 localIndexEntry、一条账对应的绝对路径 entryAbsOf、文件名去重 saveUniqueName、
     用量那一档的 productKindOfName）
     不挂在这里 —— 挂出去就有人在外面再拼一份落点、再扫一遍盘。 */
  return {
    bodyDirOf, bodyDirNameOf,
    newBodyPlace, mintAssetId, localAdopt, invalidateScan, localSigOf, fileFidOf,
    whyNoSpace, sweepStaleTmp, rebuildBodiesOnce,
    localIndexRead, localIndexUpsert, localIndexUpdate, localIndexPut, localIndexDrop,
    localAssetEntry, localAssetRepair, localAssetPaths, localMediaType, localAssetWhen,
    localEntryByUpstream, localEntryByPlatformId, localAliases, localLocateBatch,
    localUpKey, localFillMissing, localFileFromEntry, localAssetFile, localAssetSiblings,
    localUsageScan, serveLocalFile,
  };
}

module.exports = { createLocalAssetsStore, isMediaExt, isDocExt, identityOf };
