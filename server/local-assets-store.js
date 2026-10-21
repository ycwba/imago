/* 本机落盘的存储层：磁盘余量口径 + 按类型另存（/save*）+ 本机资产库那一份索引与读文件。
   2026-10-20 从 server/app.js 原样搬出：这里只有业务助手与落盘口径，
   请求解析与响应在 server/routes/save.js、server/routes/local-assets.js、server/routes/usage.js。
   目录（LOCAL_DIR / RENDER_DIR）、dataDirPath、log、MIME、spawnSync 由 app 组合根注入 ——
   路径口径全站只有那一处（path.resolve，绝对路径要能直接用），这里不重复算。 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const MediaId = require('../web/domain/ident.cjs');
const { createIndexStore } = require('./index-store.js');

function createLocalAssetsStore(deps) {
  const { ROOT, LOCAL_DIR, RENDER_DIR, MIME, dataDirPath, log, spawnSync } = deps;

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
     /save 回 JSON、/render 写进 job.err，让调用方自己决定怎么说）。 */
  function whyNoSpace(dir, need, what) {
    const free = freeBytesOf(dir);
    if (free === null || free >= need + DISK_HEADROOM) return null;
    return (what ? what + ' ' : '') + '要写 ' + mbOf(need) + '，而「' + dir + '」所在的盘只剩 ' + mbOf(free)
      + '（还要留 ' + mbOf(DISK_HEADROOM) + ' 余量给改名与备份）—— 腾点空间或换一个盘再试';
  }
  /* 渲染只能问一个「最低下限」：成片要多少字节取决于段数、时长、码率与配音，
     猜一个具体数会写出假承诺（说「要 200MB」而实际写出 1.2GB）。所以这一档只兜
     「盘明显快满」那种必然失败的情况 —— **在下载素材之前就拦**，而不是等 ffmpeg 跑到
     最后写文件时崩在半个 mp4 上（那时用户已经等了几分钟，而盘上留了一个坏文件）。 */
  const RENDER_MIN_FREE = 256 * 1024 * 1024;
  function whyRenderSpace() {
    const free = freeBytesOf(RENDER_DIR);
    if (free === null || free >= RENDER_MIN_FREE) return null;
    return '导出成片的落盘目录只剩 ' + mbOf(free) + '，而一遍渲染要边解码边写临时文件（至少要留出 '
      + mbOf(RENDER_MIN_FREE) + '）—— 清一清这块盘，或在 .env 里把 RENDER_DIR 指到别的盘（改完要重启）';
  }
  /* ---------- 启动时清掉崩溃残留的临时写入文件 ----------
     两处原子写（`.data/<key>.json` 与 `.assets/index.json`）都是「写 <目标名>.tmp-<pid>-<随机串> → rename」，
     正常路径要么 rename 走、要么 catch 里 unlink 掉，**只有进程被硬杀 / 断电才会留下**。
     留下的害处不是占地方（一份 JSON 几十 KB）：`GET /data` 的清单与设置页「数据与备份」会把它们
     列成来路不明的条目，而资产索引重建时也会扫到多出来的名字。
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
    (dirs || [dataDirPath(), LOCAL_DIR]).forEach(dir => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }        // 目录还没建 = 没有残留可言
      names.forEach(name => {
        if (!TMP_STALE_RE.test(name)) return;
        const f = path.join(dir, name);
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
  /* ---------- 按类型另存到用户指定的文件夹（POST /save 用） ----------
     配置在 `.data/sk_autosave.json`（设置页存进 localStorage 的 `sk_autosave`，由 DataSync 镜像过来，
     所以换机器 / 云同步都跟着走 —— 里面只有目录路径，没有任何密钥）。
     形状：{ image:{on:'on'|'off', dir:'D:\\AI图'}, video:{…}, audio:{…} }。
     **目录不存在时自动建**（用户填 `D:\AI图\短剧` 而 `AI图` 还没有是常事），
     建不出来就照实报错，不静默跳过 —— 静默跳过的话界面上什么痕迹都没有，
     用户会以为「保存了」而文件其实没落盘。 */
  const SAVE_KINDS = ['image', 'video', 'audio'];
  /* 「英文媒体类别 → 中文类型名」在本机代理只这一张表（2026-10-15 从两份逐字相同的表收成一份：
     另存目录那一头叫 `saveKindZh`、本机资产那一头叫 `LOCAL_KIND_ALIAS`，谁改了其中一份另一份不知道，
     表现是「磁盘上的文件夹叫图片、资产库列表里却按另一套名字筛」）。
     ⚠ 这一族的名字是**素材**的名字（音频），与浏览器侧那张「供应商类型」的表（`ui.js` 的 `provKindZh`，
       audio 那一格叫「语音」—— 一型供应方，不是一条素材）差一格，两边不许合并；
       表名也故意不叫 `KIND_ZH`：同名而不同值，迟早被人当成重复实现合并掉。
     与浏览器侧的关系：中文类型名 → `video / audio / image` 那份反查在 `ui.js` 的 `mediaKindOf`，
     Node 里没有 window，所以这张小表必须在本机各留一份（与 `fileSafe` / `dayKey` 同一类登记在案的例外）。 */
  const MEDIA_KIND_ZH = { image: '图片', video: '视频', audio: '音频' };
  const typeLabel = t => MEDIA_KIND_ZH[t] || t;
  /* 内容指纹：另存索引、本机资产扫描与云同步共用（取前 12 位足够区分本机文件）。 */
  const sha1Of = buf => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
  /* 系统默认的「下载」文件夹。**不要**直接用 %USERPROFILE%\Downloads 猜 ——
     用户可以把它搬到别的盘（D:\下载），那件事记在注册表里：
     HKCU\...\Explorer\Shell Folders 的
     {374DE290-123F-4565-9164-39C4925E467B}（Downloads 的 KNOWNFOLDERID 固定 GUID）。
     问一次就缓存：另存这三条路由每个文件都会问一次目录，reg.exe 一次上百毫秒，
     不能每存一份就问一遍。问不到（不是 Windows / 注册表没这一项 / reg 被拦）就退到
     homedir\Downloads —— 那是绝大多数机器上的真实位置。 */
  let systemDownloadsCache = null;
  function systemDownloadsDir() {
    if (systemDownloadsCache) return systemDownloadsCache;
    /* 探针（隔离实例）用 AUTOSAVE_DIR 把整个「下载」基座指走 —— 与 DATA_DIR / ASSETS_DIR /
       RENDER_DIR 同一个理由：默认落盘地现在在用户真实的下载文件夹里，探针不该往那儿写。
       指了就一口价，不再问注册表（否则「隔离」只隔了一半）。 */
    const forced = String(process.env.AUTOSAVE_DIR || '').trim();
    if (forced) { systemDownloadsCache = path.resolve(forced); return systemDownloadsCache; }
    let dir = '';
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('reg', ['query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
          '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
          { encoding: 'utf8', windowsHide: true });
        const m = r && r.stdout && r.stdout.match(/REG_SZ\s+(\S.*)/);
        if (m && m[1].trim()) dir = m[1].trim();
      }
    } catch {}
    if (!dir) dir = path.join(os.homedir(), 'Downloads');
    /* 注册表里可能是 REG_EXPAND_SZ（值里带 %USERPROFILE% 之类）—— reg query 不给展开，自己展开一层 */
    dir = dir.replace(/%([^%]+)%/g, (s, n) => process.env[n] || s);
    systemDownloadsCache = path.resolve(dir);
    return systemDownloadsCache;
  }
  /* 没指定目录时的默认落盘地：**系统下载文件夹**下的 拾帧\<类型>，按类型分子目录。
     为什么是下载文件夹：设置项留空原本的意思是「只存 .assets 资产库、不另存一份」，
     于是用户永远看不到自己生成的成品，得自己去一个点号开头的隐藏目录里翻。
     留空 = 用这个默认，是把「什么都不做」换成「存到看得见的地方」，
     仍然随时能改 —— 逐类型的自定义路径优先级更高（见 autosaveDir）。
     **2026-10-15 之前这里落的是项目下的 文件\ 文件夹**（跟着 DataSync 的仓库走），
     用户点名改成下载文件夹：成品是用户自己的东西，不该长在工具的目录里
     （项目目录还要进版本库，几百 MB 的成片混在里面迟早出事）。
     老目录没有丢：/save-move 的 @default 两支都认（见 autosaveDefaultDirs）。 */
  const AUTOSAVE_TOP_DIR = '拾帧';
  const autosaveDefaultDir = kind => path.join(systemDownloadsDir(), AUTOSAVE_TOP_DIR, typeLabel(kind));
  /* 改默认位置之前的那一版：项目下 文件\<类型>。只为 /save-move 的「旧的也是默认目录」
     这一支留着 —— 这台机器实测里面有 800 多份成品，换默认之后它们还躺在那儿，
     用户下一次把另存目录改到别处时，那一批也得能跟着搬（不然永远留在项目里）。
     探针口 AUTOSAVE_LEGACY_DIR 与 AUTOSAVE_DIR 同一纪律：这台开发机上老默认目录里
     就是真实成品，探针验 @default 搬迁不能真去动它们。指了就一口价（当基座，再拼类型子目录）。 */
  const autosaveLegacyDefaultDir = kind => {
    const forced = String(process.env.AUTOSAVE_LEGACY_DIR || '').trim();
    return forced ? path.join(path.resolve(forced), typeLabel(kind))
                  : path.join(ROOT, '文件', typeLabel(kind));
  };
  /* 「旧的也是默认目录」时的候选源（按序尝试）：新默认、老默认，各自只认真实存在的那些。
     一个都不存在时保留新默认当报错点（ENOENT 那句话里点名的就是新位置）。
     为什么不直接返回单个：过渡期两处都可能还有东西，只搬一处等于另一半永远搬不走。 */
  function autosaveDefaultDirs(kind) {
    const all = [autosaveDefaultDir(kind), autosaveLegacyDefaultDir(kind)];
    const hit = all.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    return hit.length ? hit : [all[0]];
  }
  function autosaveConf() {
    /* 与下面 `dataDirPath()` 同一份表达式：这里**不能**去调它 —— 它是 2339 行的 const，
       本函数在 1400 行，调用它就依赖「模块加载完之前不会被调用」这件事（能跑，但脆）。 */
    const f = path.resolve(ROOT, process.env.DATA_DIR || '.data', 'sk_autosave.json');
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      return (v && typeof v === 'object') ? v : {};
    } catch { return {}; }
  }
  /** 这一类该存到哪个目录（'' = 这一类关了，不另存）。
      留空不再等于「不另存」：那是 2026-10 之前的默认，代价是成品只落在 .assets 这个
      点号开头的目录里，用户看不见。留空 = 用 autosaveDefaultDir（下载\拾帧\<类型>）。 */
  function autosaveDir(kind) {
    const c = (autosaveConf()[kind] || {});
    if (c.on === 'off') return '';
    const d = String(c.dir || '').trim();
    if (!d) return autosaveDefaultDir(kind);
    return path.resolve(d.replace(/[\\/]+$/, ''));
  }
  /* 「图片/视频/音频」反回 image/video/audio。类型判据只有 localMediaType 一处，
     这里只做中英互转，不另写一份扩展名名单（LOCAL_KIND_BY_EXT 已经有一份了）。 */
  const saveKindOf = zh => Object.keys(MEDIA_KIND_ZH).find(k => MEDIA_KIND_ZH[k] === zh) || '';
  /* 文件名：只留 basename 与安全字符（防 ../ 穿越）。三条另存路由共用这一份。 */
  function saveBaseName(name, fallback) {
    return path.basename(String(name == null ? '' : name) || fallback || 'file.bin')
      .replace(/[^\w.\-一-龥]+/g, '_').replace(/^_+/, '').slice(0, 120)
      || (fallback || 'file.bin');
  }
  /* 在 dir 里找一个不撞名的文件名：同名加 -2 / -3 序号，**不覆盖** ——
     覆盖会把用户自己整理过的文件名换掉，而且没有任何提示。
     /save、/save-local、/save-move 三条路由共用这一份：各写一遍就会出现
     「补存那次叫 a-2、下一回生成又叫 a-2」这种同目录里两套编号。
     `skip`（可选）是**本轮已经抢过一次的号码**：existsSync 只是快照，两个并发请求
     同一瞬间都会选中 `a.mp4`，所以撞 EEXIST 的名字要拉黑后重新找位，
     否则序号会原地打转、永远找不出空位。 */
  function saveUniqueName(dir, base, onTooMany, skip) {
    let file = base, n = 2;
    while (fs.existsSync(path.join(dir, file)) || (skip && skip.has(file))) {
      const dot = base.lastIndexOf('.');
      file = (dot > 0 ? base.slice(0, dot) : base) + '-' + n + (dot > 0 ? base.slice(dot) : '');
      n++;
      if (n > 999) return onTooMany();
    }
    return file;
  }
  /* 目标目录里已经有哪些内容：建一张「字节数:摘要 → 文件名」的表。
     为什么必须有这一步：另存是**镜像的附属动作** —— 用户改目录之前新生成的那批，
     早就被 /save 写进旧目录了。不判重就补存的话，同一个视频会在新目录里出现两份：
     一份是补存拷来的 `a.mp4`，一份是搬迁搬过来的 `a-2.mp4`（撞名才加的序号）。
     只比字节数不够 —— 同长度不同内容是常事（改一帧的视频、改过参数的图），所以再比 sha1。
     整条目录只读一遍、由调用方复用，别在循环里每个 id 重扫一次（83 个产物 × 目录里几十个
     文件就是几千次全文件读）。`sha1Of` 定义在 3271 行，这里能安全引用：
     本函数只在**收到请求之后**才被调用，那时模块早已加载完。 */
  /* 这个目录是不是**本机资产库本体**（.assets，或它里面的某个子目录）。
     另存那三条路由都要过这一道。为什么单独拦、而不是靠白名单：
     白名单（sk_autosave_used.json）证明的是「这个目录是本工作台写过的」，
     证明不了「搬走 / 写进去它是安全的」—— 用户把另存目录填成 .assets 是完全合法的操作，
     而那样 /save 写进去的副本会把 .assets 记进白名单，下一次换位置 /save-move 就会
     **真的把资产库里的文件搬走**。.assets 是整个工作台的本体：离线能看、删了能回源、
     缩略图全靠它，搬空了就是「资产库里什么都没有了」。
     判据只有这一份（LOCAL_DIR 同一处），三条路由各调它，不再各写一遍前缀比较。 */
  function insideLocalDir(dir) {
    if (!dir) return false;
    try {
      const base = path.resolve(LOCAL_DIR), s = path.resolve(dir);
      return s === base || s.startsWith(base + path.sep);
    } catch { return false; }
  }
  /* 目录内容指纹表（判重按**内容 sha1 不按文件名**）。
     以前对目录里**每一个**文件都 readFileSync + sha1 —— `文件\视频` 512 个文件 / 788 MB，
     实测外推约 1,848 ms 的**同步**阻塞（全在请求回调里），期间轮询、/asset 取图、/getv 播放
     全部停摆。而判重本来就是「同 size 才可能同内容」，所以改成**按 size 建桶、懒算 sha1**：
       · 目录里 size 只出现一次的那些，一个字节都不用读（不同内容的视频 size 几乎必然不同）；
       · 只有真拿一个 size 来查、且这个 size 在目录里出现过时，才去读那几个同 size 的文件。
     再按目录 mtime 缓存整张表（判据照抄 _customCache 的 mtime 双键，不引入新范式）：
     目录没变就直接复用，连那 512 次 statSync 都省掉。 */
  const dirIndexCache = new Map();          // dir → { mtimeMs, idx }
  function buildDirIndex(dir) {
    const bySize = new Map();               // size → [名字]
    try {
      for (const n of fs.readdirSync(dir)) {
        let st; try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
        if (!st.isFile()) continue;
        const arr = bySize.get(st.size); if (arr) arr.push(n); else bySize.set(st.size, [n]);
      }
    } catch { /* 目录还不存在 = 里面什么都没有 */ }
    const shaCache = new Map();             // 名字 → sha1（同一份文件在一次请求里可能被查多次）
    const shaOfName = n => {
      if (shaCache.has(n)) return shaCache.get(n);
      let h = '';
      try { h = sha1Of(fs.readFileSync(path.join(dir, n))); } catch {}
      shaCache.set(n, h);
      return h;
    };
    return {
      /* 目录里有没有与这段内容完全相同的文件？有就返回它的文件名。 */
      get(size, hash) {
        const cands = bySize.get(size);
        if (!cands) return undefined;
        for (const n of cands) if (shaOfName(n) === hash) return n;
        return undefined;
      },
      /* 本次刚写进去的文件也要能立刻被后面的同内容请求命中（与以前 sums.set 同一个语义）。 */
      add(size, hash, name) {
        const arr = bySize.get(size);
        if (arr) { if (arr.indexOf(name) < 0) arr.push(name); } else bySize.set(size, [name]);
        shaCache.set(name, hash);
      },
    };
  }
  function saveDirIndex(dir) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { mtimeMs = 0; }
    const hit = dirIndexCache.get(dir);
    if (hit && mtimeMs && hit.mtimeMs === mtimeMs) return hit.idx;
    const idx = buildDirIndex(dir);
    dirIndexCache.set(dir, { mtimeMs, idx });
    if (dirIndexCache.size > 16) { const k = dirIndexCache.keys().next().value; dirIndexCache.delete(k); }
    return idx;
  }
  /* ---------- 代理自己写过的目录名单（POST /save-move 的安全闸） ----------
     换下载位置时页面要递「从哪个旧目录搬过来」，而 /save 特意**不接受**客户端递的目录 ——
     认了它，这条路由就等于「任意本机网页往任意路径写/搬文件」。
     所以旧目录必须能被证明是**本工作台自己写出来的**：代理每写一次就把那个目录记进
     `.data/sk_autosave_used.json`，/save-move 只接受名单里的。
     代价是「早于这份名单的旧目录」搬不了 —— 那种情况页面会照实说「那个目录不是本工作台写的」，
     而不是替用户猜。 */
  const autosaveUsedPath = () => path.resolve(ROOT, process.env.DATA_DIR || '.data', 'sk_autosave_used.json');
  function autosaveUsedRead() {
    try { const v = JSON.parse(fs.readFileSync(autosaveUsedPath(), 'utf8')); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
    catch { return []; }
  }
  function autosaveUsedAdd(dir) {
    try {
      if (!dir) return;
      const list = autosaveUsedRead();
      const key = path.resolve(dir);
      if (list.some(x => path.resolve(x) === key)) return;
      list.push(key);
      fs.writeFileSync(autosaveUsedPath(), JSON.stringify(list.slice(-50), null, 0));
    } catch (e) { log('[save] 目录名单写不下去（不影响存文件）：' + e.message); }
  }
  function autosaveUsedHas(dir) {
    if (!dir) return false;
    const key = path.resolve(dir);
    return autosaveUsedRead().some(x => { try { return path.resolve(x) === key; } catch { return false; } });
  }
  /* ---------- 旧目录里还剩多少份没搬（GET /save-stale 用，只读） ----------
     为什么必须有这一条：搬迁那句问话以前**只挂在「刚改完目录的那一刻」**，而实测这一台机器
     一次都没弹出来过 —— 2026-10-15 把默认位置从项目内的 文件\<类型> 换成了 下载\拾帧\<类型>，
     而 `dir` 这个字段一个字都没变（还是空串）。「换没换目录」按字符串比根本比不出来，
     界面上又没有第二个入口：错过了那一句，几百份成品就一直躺在项目目录里
     （还跟着仓库一起被 git 扫，而它们恰恰是最不该进版本库的大文件）。
     所以这一条**不问配置问了磁盘**：把「代理搬得动的地方」逐个点数。
     来源表与 /save-move 能搬的那几处严格同一份（两代默认 + 自己写过的目录名单），
     否则界面上会出现一颗按下去必然失败的按钮。
     安全：不接受任何客户端递进来的路径，也不接查询串 —— 报出去的位置全部来自代理自己的名单。 */
  function saveStaleScan() {
    const out = {};
    const used = autosaveUsedRead();
    for (const kind of SAVE_KINDS) {
      const to = autosaveDir(kind);                 // '' = 这一类现在是关着的
      const toKey = to ? path.resolve(to) : '';
      const label = typeLabel(kind);
      /* 候选来源连「它是第几代默认」一起记：页面搬的时候要递 `@default`
         （那两个默认目录是一起搬的，代理那条分支不需要白名单），
         而自己挑过的旧目录只能逐个点名、并且要过白名单。
         不标这一位的话，页面要么把默认目录当普通路径递过来被白名单拒（搬不动），
         要么统一递 @default（等于把用户自己挑过的目录也当默认的搬 —— 那是越权）。
         默认目录是**按类型**分的（下载\拾帧\图片 vs 文件\图片），所以这一份必须在
          kinds 循环**里面**现取 —— 提到外面拼一份全局名单，类型就对不上了。 */
      const cands = [];
      for (const d of autosaveDefaultDirs(kind)) cands.push({ dir: d, isDefault: true });
      for (const d of used) cands.push({ dir: d, isDefault: false });
      const seen = new Set(), dirs = [];
      for (const cd of cands) {
        let key = '';
        try { key = path.resolve(cd.dir); } catch { continue; }
        if (!key || key === toKey || seen.has(key) || insideLocalDir(key)) continue;
        seen.add(key);
        let names;
        try { names = fs.readdirSync(key); } catch { continue; }   // 目录不存在 = 里面什么都没有
        let count = 0, bytes = 0;
        for (const n of names) {
          if (productKindOfName(n) !== kind) continue;           // 严格判据：与 /save-move 同一份
          let st; try { st = fs.statSync(path.join(key, n)); } catch { continue; }
          if (!st.isFile()) continue;
          count++; bytes += st.size;
        }
        if (count) dirs.push({ dir: key, count, bytes, isDefault: cd.isDefault });
      }
      dirs.sort((a, b) => b.bytes - a.bytes);       // 占盘最多的排最前（用户先搬谁一目了然）
      out[kind] = { on: !!to, to, label, dirs, count: dirs.reduce((s, x) => s + x.count, 0),
        bytes: dirs.reduce((s, x) => s + x.bytes, 0) };
    }
    return out;
  }
  const LOCAL_INDEX_MAX = 20000;
  const indexStore = createIndexStore({ dir: LOCAL_DIR, log, max: LOCAL_INDEX_MAX });
  const localIndexRead = () => indexStore.read();
  const localIndexEntry = id => indexStore.entry(id);
  const localIndexUpsert = item => indexStore.upsert(item);
  const localIndexRemove = id => indexStore.remove(id);

  /* 读路径只查索引，**不在这里补建**：`/asset/<id>` 每张缩略图都要走它，
     一个不存在的 id 被轮询时（页面 3 秒一问）每次都会 readdirSync 整个 .assets 目录。
     要补建的入口单独一个 localAssetRepair（见下），由真正要拿文件的操作显式调用。 */
  function localAssetEntry(id) {
    return localIndexEntry(id);
  }
  /* 本机资产的大类型（图片 / 视频 / 音频）：先看扩展名（落盘文件名就是 <id>.<格式>，最可靠），
     再按 mime，最后按调用方给的 media_type（英文写法认成中文）。缺省过去写死 audio，
     「短剧末帧」这种没传类型的 PNG 就被记成音频，资产库按图片筛永远挑不到它。 */
  const LOCAL_KIND_BY_EXT = {
    png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片', bmp: '图片', avif: '图片',
    mp4: '视频', mov: '视频', webm: '视频', mkv: '视频', m4v: '视频',
    mp3: '音频', wav: '音频', m4a: '音频', aac: '音频', ogg: '音频', oga: '音频', flac: '音频',
    pcm: '音频', pcm16: '音频', opus: '音频',
  };
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
     索引里那条记录有 mime、有调用方给的 media_type，兜底audio 顶多让资产库筛错档（已经修过一轮）；
     而对着一个目录里的文件名，能证明类型的只有扩展名，兜底就是**替用户编一个类型**。
     踩出来的形状：待搬迁那一排把用户自己目录里的 `notes.txt`（105 KB）数成「音频」，
     而 /save-move 用同一句判据于是**真的把它搬进 拾帧\音频 并删掉源文件** ——
     一个「按类型搬成品」的功能把人家文件夹里的非成品扫走了。
     数与搬必须共用这一份严格判据：**数得到的才是搬得动的**，否则界面上那个数字是一次删源的承诺。
     （`LOCAL_KIND_BY_EXT` / `saveKindOf` 都定义在本函数之后，这里只**引用**不**求值** ——
     两个调用点都收到请求之后才跑，那时模块早已加载完；与 `buildDirIndex` 引 `sha1Of` 同一道理。） */
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
     为什么判据要放在代理这一层：镜像键 `sk_local_mirror` 存在浏览器 localStorage 里，而
     localStorage 是**按端口分家**的（5175 / 5199 / 6200 是三个源），换端口、清浏览器数据、开无痕
     都把那份索引一起清零 —— 于是每一次开页面都把**同一份产物**重新下载、重新落盘一份新文件。
     实测这台机器的索引里 290 行只对应 83 份产物（最多的一份重复 15 次，落盘时刻散在七个不同的
     会话里），磁盘 0.45 GB 中真正在用的只有 0.08 GB；而资产库 / 素材选择器看到的就是
     「同一个视频重复出现 N 张卡」。浏览器那一份只能挡同一个源，挡不住换源。
     「剥掉哪些签名参数」这条判据在 ident.js 里只有一份（浏览器那边 assetlib.js require 同一个文件）——
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
  const LOCAL_FILL_FIELDS = ['prompt', 'model', 'voice', 'priceText', 'upstream'];
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
  /* 按文件名补一条索引（文件名就是 <id>.<格式>），并写回索引。
     **明确补建入口**：只有真正要拿文件、而索引里没有时才调（localAssetFile / `/asset/<id>`）。
     盘上确实没有的 id 记 60 秒负缓存 —— 轮询同一个不存在的号时不再每次扫全目录。 */
  const repairMiss = new Map();
  const REPAIR_MISS_TTL = 60 * 1000;
  function localAssetRebuild(id) {
    const clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!clean) return null;
    const missAt = repairMiss.get(clean);
    if (missAt && Date.now() - missAt < REPAIR_MISS_TTL) return null;
    let files = [];
    try { files = fs.readdirSync(LOCAL_DIR); } catch { return null; }
    const f = files.find(x => x.startsWith(clean + '.'));
    if (!f) { repairMiss.set(clean, Date.now()); return null; }
    let st = null;
    try { st = fs.statSync(path.join(LOCAL_DIR, f)); } catch { repairMiss.set(clean, Date.now()); return null; }
    if (!st.isFile()) { repairMiss.set(clean, Date.now()); return null; }
    repairMiss.delete(clean);
    const fmt = (path.extname(f).slice(1) || 'wav').toLowerCase();
    const mime = MIME['.' + fmt] || 'application/octet-stream';
    const item = {
      id: clean, file: f, name: f, mime, format: fmt,
      byte_length: st.size, created_at: st.mtime.toISOString(), media_type: localMediaType({ mime, format: fmt }),
      prompt: '', model: '', voice: '', provider: 'local', duration: null,
      credits: null, priceText: '', chars: null, usage: null, rebuilt: true,
    };
    /* 补建是**读**路径上的一步（文件就在眼前，条目已经拼好了），索引写不成也不该让读操作失败 ——
       真正需要「写不成就要报错」的是落盘那两条路（见 index-store 里 upsert 的说明）。 */
    try { localIndexUpsert(item); }
    catch (e) { log('[local-assets] 补建条目写索引失败（文件仍在，本次按读到的算）：' + e.message); }
    return item;
  }
  function localFileFromEntry(ent) {
    if (!ent || !ent.file) return null;
    const f = path.join(LOCAL_DIR, path.basename(ent.file));
    return fs.existsSync(f) ? f : null;
  }
  /* 明确补建入口：索引里没有（被挤出 20000 条上限）但文件还在盘上时，按文件名补一条。 */
  function localAssetRepair(id) {
    return localAssetRebuild(id);
  }
  function localAssetFile(id) {
    const ent = localFileFromEntry(localAssetEntry(id));
    if (ent) return ent;
    return localFileFromEntry(localAssetRepair(id));
  }
  /* ---------- 本机资产库占了多少地方（GET /assets-usage 用，只读） ----------
     为什么必须有这一条：`.assets` 是这一台机器上唯一**只增不减**的那一堆 ——
     索引封顶 `LOCAL_INDEX_MAX` 条，文件却永远不清（删条目时文件删不掉只报错、不裁索引），
     而「同一份产物被镜像了几次」以前只在 `GET /local-assets` 末尾报一个 `duplicates` 数字，
     界面上没有任何地方把它摊开。于是盘涨到几十 GB 之后，人只知道「C 盘满了」，
     不知道是哪些片子、重复了几份、哪一份最占地方 —— 更没有一条安全的路把它降下来。
     三条口径，缺一条这一格就变成假控件：
     ① **只数、只说，一个字节都不写不删**。删本机产物只有资产库那一页那一条路
       （勾卡片 → 删除 → 二次确认 → `DELETE /local-assets/<id>`，删掉文件才裁索引）。
       在这里放一颗「一键清理」等于让一次统计顺带删掉用户的作品 —— 而统计**永远分不出**
       「多余的重复」与「被挤出索引但还要留着的历史产物」（就是下面 `索引外` 那一段），
       所以这份读数只负责把话说清、把出路指对。
     ② 判重的身份只有 `localUpKey` 一份（host + path，签名参数一律不参与），
       与 `GET /local-assets` 收敛列表、`POST /local-assets` 挡重复镜像用的是同一个键。
       在这一格另写一份「按文件名去重」，界面上就会出现「这里说没重复、列表里同一份卡三张」。
     ③ 内容级判重（来源外链不同、字节却完全相同）先按 size 分桶、只有**同大小**才去读，
       并且一次扫描有**字节预算**：整目录 readFileSync 会把事件循环按住几秒
       （`buildDirIndex` 上面那段注释量的就是这笔账：512 个文件 / 788 MB ≈ 1,848 ms 同步阻塞，
       期间轮询、`/asset` 取图、播放全部停摆）。所以这里 `await fs.promises.readFile`、
       按预算读、读不完的那一些**照实说**「还有 N 份同大小的没验」而不是当它们不存在。
     类型那一档走 `productKindOfName`（只看扩展名表，不吃 `localMediaType` 那句音频兜底）——
     与 `/save-stale`、`/save-move` 同一份严格判据：对着一堆文件名猜不出类型的就归「其它」，
     不替用户编一个类型。 */
  const USAGE_TOP = 6;                         // 「最占地方 / 最旧的」各列几条
  const USAGE_HASH_BUDGET = 96 * 1024 * 1024;  // 一次扫描最多验这么多字节的内容
  const USAGE_LOW_FREE = 1024 * 1024 * 1024;   // 这块盘剩不到这么多就把这一格标黄
  const usageShaCache = new Map();             // 文件名 → { mtimeMs, size, sha }（同大小同修改时间就免再读）
  const usageKindOf = name => { const k = productKindOfName(name); return k ? typeLabel(k) : '其它'; };
  /* 「这一份是什么时候有的」→ 毫秒：优先生成时间（localAssetWhen，见它的注释），
     索引里那条没有 / 补建出来的那条才退到落盘 mtime。取不出时间就回 0（只用于排序，不参与上色）。 */
  function usageWhenMs(ent, mtimeMs) {
    const raw = localAssetWhen(ent);
    if (raw == null || raw === '') return mtimeMs || 0;
    let t = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
    if (!Number.isFinite(t) || t <= 0) return mtimeMs || 0;
    return t;
  }
  async function localUsageScan() {
    const dir = LOCAL_DIR;
    let 目录 = { 路径: dir, 状态: '可写' };
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) 目录 = { 路径: dir, 状态: '路径上有个同名的文件，不是目录 —— 资产库现在读不到任何产物' };
    } catch (e) {
      目录 = { 路径: dir, 状态: (e && e.code === 'ENOENT')
        ? '还没有这个目录（第一次存产物时代理自己会建）'
        : '读不了这个目录：' + ((e && e.code) || (e && e.message) || e) };
    }

    /* 索引读不出来时 localIndexRead 已经把坏文件改名留档、返回空表 —— 那一条本函数不重复处理，
       也不写盘（这里只读）；顶到上限那一档据此照实说。 */
    const idxList = localIndexRead();
    const byFile = new Map();
    for (const x of idxList) { if (x && x.file && !byFile.has(x.file)) byFile.set(x.file, x); }

    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const files = [];
    for (const n of names) {
      /* 产物文件名是 `<id>.<格式>`；索引本体与两类崩溃 / 损坏残留不是（启动清扫已经收过 .tmp-，
         数到这里还剩 .bad- 那份坏索引留档 —— 把它算成一份产物就是把用户的备份说成作品）。 */
      if (!n || n === 'index.json' || n.indexOf('.tmp-') >= 0 || n.indexOf('.bad-') >= 0 || n.indexOf('.bak.') >= 0) continue;
      let st; try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
      if (!st.isFile()) continue;
      files.push({ name: n, size: st.size, mtimeMs: st.mtimeMs, ent: byFile.get(n) || null });
      files[files.length - 1].when = usageWhenMs(files[files.length - 1].ent, st.mtimeMs);
      files[files.length - 1].类型 = usageKindOf(n);
    }
    const 总字节 = files.reduce((s, f) => s + f.size, 0);

    /* ---- 按类型 ---- */
    const kindMap = new Map();
    for (const f of files) {
      const g = kindMap.get(f.类型) || { 类型: f.类型, 条数: 0, 字节: 0 };
      g.条数++; g.字节 += f.size; kindMap.set(f.类型, g);
    }
    const 按类型 = [...kindMap.values()].sort((a, b) => b.字节 - a.字节);

    /* ---- 判重：先并成「同一份产物」的组，再按组算多占 ----
       两种身份并成一族（并查集），因为「同一来源的两次镜像」与「字节完全相同但来源不同」
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
    /* 内容级：只有 size 在目录里出现过 ≥2 次才可能同内容（不同内容的视频 size 几乎必然不同） */
    const sizeMap = new Map();
    for (const f of files) {
      if (f.size <= 0) continue;                       // 空文件不用读也认不出什么，跳过
      const a = sizeMap.get(f.size) || []; a.push(f); sizeMap.set(f.size, a);
    }
    let 读了字节 = 0, 验过文件 = 0, 没验的 = 0, 同内容组 = 0;
    for (const a of sizeMap.values()) {
      if (a.length < 2) continue;
      for (const f of a) {
        if (f.sha) continue;
        const hit = usageShaCache.get(f.name);
        if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) { f.sha = hit.sha; 验过文件++; continue; }
        if (读了字节 + f.size > USAGE_HASH_BUDGET) { f.unchecked = true; 没验的++; continue; }
        try { f.sha = sha1Of(await fs.promises.readFile(path.join(dir, f.name))); }
        catch { f.unchecked = true; 没验的++; continue; }
        读了字节 += f.size; 验过文件++;
        usageShaCache.set(f.name, { mtimeMs: f.mtimeMs, size: f.size, sha: f.sha });
        if (usageShaCache.size > 8000) usageShaCache.clear();   // 缓存本身也要有界（这是长跑进程）
      }
      const shaMap = new Map();
      for (const f of a) {
        if (!f.sha) continue;
        const g = shaMap.get(f.sha) || []; g.push(f); shaMap.set(f.sha, g);
      }
      for (const g of shaMap.values()) {
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

    /* ---- 索引与磁盘对不上的那两批 ---- */
    const diskNames = new Set(files.map(f => f.name));
    const 索引外 = files.filter(f => !f.ent);
    const 索引外字节 = 索引外.reduce((s, f) => s + f.size, 0);
    const 没了 = idxList.filter(x => x && x.file && !diskNames.has(x.file));
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
    if (没了.length) { if (cls === 'ok') cls = 'warn'; 因由.push('有索引没文件的条目'); }
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
      对不上: { 索引外文件数: 索引外.length, 索引外字节, 没文件条数: 没了.length, 没文件字节: 没了字节 },
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
  /* 带 Range 的本地文件响应（两处落盘目录出口 /asset 与 /render/dl 共用一份）。
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
  /* entry 由调用方给时就不再全量读一遍索引：/asset/<id> 这条链手里已经握着 entry，
     以前却在这里又 localIndexRead() 一次 —— 页面上每一张缩略图、每一个 <video> 都打它，
     索引攒大之后就是每个媒体请求 2 次全量读盘解析。 */
  function serveLocalFile(req, res, file, q, entry) {
    const base = path.basename(file);
    if (!entry) entry = localIndexRead().find(x => x && x.file === base) || {};
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

  return {
    MEDIA_KIND_ZH, typeLabel, sha1Of, SAVE_KINDS,
    saveKindOf, saveBaseName, saveUniqueName, insideLocalDir,
    saveDirIndex, autosaveDir, autosaveDefaultDirs, autosaveUsedAdd,
    autosaveUsedHas, saveStaleScan, whyNoSpace, whyRenderSpace,
    sweepStaleTmp, LOCAL_INDEX_MAX, indexStore, localIndexRead,
    localIndexEntry, localIndexUpsert, localIndexRemove,
    localIndexUpdate, localIndexPut, localIndexDrop,
    localAssetEntry, localAssetRepair, localMediaType, productKindOfName, localAssetWhen,
    localUpKey, localFillMissing, localFileFromEntry, localAssetFile,
    localUsageScan, sendFileWithRange, serveLocalFile,
  };
}

module.exports = { createLocalAssetsStore };
