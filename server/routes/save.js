/* 另存 / 补存 / 搬迁到用户指定文件夹（POST /save、GET /save-stale、POST /save-local、POST /save-move）。
   目录只从服务端配置读；请求体里的 dir 一律忽略；文件名 basename + 白名单。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('./http');

/* 本文件的错误体是 `{error:{message}}`（domain/local.js 与设置页读的是 error.message），
   与公共 fail 的扁平 `{error}` 不同：这里只做形状适配，头字段仍交给 ./http。 */
const failJson = (res, code, msg) => sendJson(res, code, { error: { message: msg } });

function createSaveRoutes(ctx) {
  const {
    readBody, log, autosaveDir, autosaveDefaultDirs, autosaveUsedAdd, autosaveUsedHas,
    saveBaseName, saveDirIndex, saveKindOf, saveUniqueName, saveStaleScan, typeLabel,
    productKindOfName, whyNoSpace, insideLocalDir, localFileFromEntry, localIndexRead,
    localMediaType, sha1Of, SAVE_KINDS,
  } = ctx;

  /* 独占创建式写入（wx）：同名并发另存的胜负交给文件系统判，输的那个换下一个号码重试。
     为什么不能只靠 saveUniqueName 里的 existsSync —— 先判后写之间有窗口：
     两个请求同一瞬间都选中 `a.mp4` 这个空位，后落笔的把先落笔的字节**盖掉**，
     而两边都回 200、都报「存好了 a.mp4 / a-2.mp4」，用户以为自己有两份，盘上只有一份。
     `taken` 把抢过一次的号码拉黑，否则 saveUniqueName 会一直返回同一个名字、原地打转。
     上限与「一千个同名」是两条不同的轴：那条是目录真被同名堆满，这条是竞争太凶。 */
  const SAVE_WX_MAX = 40;
  function writeFresh(dir, base, buf) {
    const taken = new Set();
    for (let i = 0; i < SAVE_WX_MAX; i++) {
      const file = saveUniqueName(dir, base, () => null, taken);
      if (!file) return { tooMany: true };
      const target = path.join(dir, file);
      try {
        fs.writeFileSync(target, buf, { flag: 'wx' });
        return { file, target };
      } catch (e) {
        if (e && e.code === 'EEXIST') { taken.add(file); continue; }
        throw e;   // ENOSPC/EACCES 等照原样上抛：调用方那一段会说清是哪个目录、什么码
      }
    }
    return { busy: true };
  }

  function handleSave(req, res, dataPath) {
    if (dataPath === '/save' && req.method === 'POST') {
      readBody(req, res, 288 * 1024 * 1024).then(raw => {      // base64 媒体较大，给足
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        if (!spec || !spec.data) return failJson(res, 400, '缺少 data(base64)');
        const type = String(spec.type || '').toLowerCase();
        if (!SAVE_KINDS.includes(type)) return failJson(res, 400, 'type 只能是 ' + SAVE_KINDS.join(' / '));
        /* ⚠ 目录**只从配置读**。请求体里就算递了 dir 也一视同仁地丢掉：
           一旦认客户端递的目录，这条路由就等于「任意本机网页往任意路径写文件」。 */
        const dir = autosaveDir(type);
        /* '' 现在只有一个来源：这一类的开关被关掉了（留空 = 用默认目录，不再是「不存」）——
           这句话照旧写「没指定文件夹」的话，用户翻遍设置页也找不到那个该填的格子。 */
        if (!dir) return failJson(res, 409, typeLabel(type) + '这一类现在是关着的（设置页里打开「自动保存」才会另存）');
        if (insideLocalDir(dir)) return failJson(res, 409, '另存目录不能设成本机资产库本体（.assets）—— 产物本来就存在那儿了，请换一个普通文件夹');
        const fmt = String(spec.format || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        const base = saveBaseName(spec.name, 'file.' + (fmt || 'bin'));
        try {
          fs.mkdirSync(dir, { recursive: true });
          const buf = Buffer.from(String(spec.data), 'base64');
          /* 写之前先问一句：ENOSPC 抛出来的是「no space left on device」，而用户需要知道的是
             「哪一个盘、要多少、还剩多少」。回 409 不回 5xx —— 这条路由上没成就是没成，
             而页面把 5xx 的 POST 记成「可能已经受理」，那是给平台任务用的，这里只会误导。 */
          const whySpace = whyNoSpace(dir, buf.length, '另存这一个文件');
          if (whySpace) { log('[save] ' + whySpace); return failJson(res, 409, whySpace); }
          const w = writeFresh(dir, base, buf);
          if (w.tooMany) return failJson(res, 409, '那个目录里已经有一千个同名文件了');
          if (w.busy) return failJson(res, 409, '那个目录里同名文件正被同时写入，抢了 ' + SAVE_WX_MAX + ' 次都没到位 —— 稍后再存一次');
          const file = w.file, full = w.target;
          autosaveUsedAdd(dir);          // 这个目录从此可以当「旧目录」被搬走（见 /save-move）
          log(`[save] ${type} → ${dir}${path.sep}${file}（${(buf.length / 1024).toFixed(0)} KB）`);
          sendJson(res, 200, { ok: true, type, dir, file, bytes: buf.length, path: full });
        } catch (e) {
          /* 目录写不进去**照实说**：路径不存在 / 没权限 / 盘满 / 别的程序占着。
             页面照原样显示这一句，用户才知道要去改设置，而不是看到「保存失败」然后猜。 */
          log('[save] 写入失败：' + e.message);
          failJson(res, 500, '写不进 ' + dir + '：' + (e && e.code ? e.code + ' ' : '') + e.message);
        }
      });
      return;
    }
    /* ============================================================================
       旧目录里还剩多少份没搬（GET /save-stale，只读）
       ---------------------------------------------------------------------------
       设置页「另存到指定文件夹」那张卡下面的「待搬迁」那一排读它。
       只报代理自己搬得动的那几处（两代默认 + 写过的目录名单），不接任何客户端递的路径，
       也不写盘、不删文件 —— 搬与补仍然只有 /save-move 与 /save-local 两个出口。
       ========================================================================== */
    if (dataPath === '/save-stale' && req.method === 'GET') {
      try {
        const kinds = saveStaleScan();
        sendJson(res, 200, { ok: true, kinds, at: Date.now() });
      } catch (e) {
        failJson(res, 500, '数不出旧目录：' + ((e && e.message) || e));
      }
      return;
    }
    /* ============================================================================
       本机资产库占了多少地方（GET /assets-usage，只读）
       ---------------------------------------------------------------------------
       设置页「资产库磁盘用量」那一栏读它（口径与安全立场的全文在 `localUsageScan` 上面那段）。
       只数盘上的字节与索引里的条目，**不写、不删、不搬家** —— 删产物仍然只有资产库那一条路，
       补存与搬迁仍然只有 /save-local 与 /save-move 两个出口。
       不接受任何客户端递进来的路径或查询串：要数的那个目录只能是代理自己的 LOCAL_DIR，
       认了客户端地址就等于「任意本机网页可以让代理去数任意一个目录里有什么」。
       ========================================================================== */

    /* ============================================================================
       把**已经存在本机资产库里的成品**补一份到用户指定的文件夹（POST /save-local）
       ---------------------------------------------------------------------------
       为什么需要这一条：`/save` 只挂在**镜像流程内部**（assetlib.js 的 runOne），
       而镜像那一步先被 `offer()` 的「这份产物已经存过了就跳过」挡在前面。
       于是功能加上之前下载的那批永远不会被补写 ——
       用户打开开关、目录也填对了，`文件\` 里还是空的，而界面上看不出任何异常。
       这里补的就是那条缺口：**字节已经在 .assets 里，不重新下载、不重新回源，直接拷一份。**
       `.assets` 里那份**一律不动** —— 它是资产库的本体（离线能看、删了能回源、
       缩略图全靠它），移走了等于把工作台弄坏。
    
       安全与 /save 同款：LOCAL_ONLY 同源、目录只从配置读（请求体里的 dir 一律忽略）、
       文件名只认索引里已登记的本机号（不接受调用方自造路径或文件名）。
       ========================================================================== */
    if (dataPath === '/save-local' && req.method === 'POST') {
      readBody(req, res, 8 * 1024 * 1024).then(raw => {
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        const ids = Array.isArray(spec && spec.ids) ? spec.ids.filter(x => typeof x === 'string') : [];
        if (!ids.length) return failJson(res, 400, '没有要补存的产物');
        if (ids.length > 2000) return failJson(res, 400, '一次最多补存 2000 个');
        const index = localIndexRead();
        const saved = [], missing = [], noKind = [], full = [], dup = [];
        let bytes = 0;
        /* 目标目录的内容表按目录缓存：ids 里三种类型会各写各的目录，
           目录一变就重扫一次（saveDirIndex 按 mtime 缓存整张表，目录没变就直接复用）。 */
        let sumsDir = '', sums = null;
        for (const id of ids) {
          const ent = index.find(x => x && x.id === id);
          if (!ent) { missing.push(id); continue; }
          /* 类型判据复用 localMediaType（扩展名 → mime → media_type），不另写一份名单 */
          const kind = saveKindOf(localMediaType(ent));
          if (!kind) { noKind.push(id); continue; }
          const dir = autosaveDir(kind);
          if (!dir) { full.push({ id, kind, why: typeLabel(kind) + '这一类现在是关着的' }); continue; }
          if (insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }
          const src = localFileFromEntry(ent);
          if (!src) { missing.push(id); continue; }
          try {
            fs.mkdirSync(dir, { recursive: true });
            const buf = fs.readFileSync(src);
            /* 已经有同一份内容就别再拷 —— 用户改目录之前新生成的那批早就躺在旧目录里，
               不挡这一下就会在新目录里出现两份同一个视频（见 saveDirIndex 的注释）。 */
            if (sumsDir !== dir) { sumsDir = dir; sums = saveDirIndex(dir); }
            const hash = sha1Of(buf);
            const hit = sums.get(buf.length, hash);
            if (hit) { autosaveUsedAdd(dir); dup.push({ id, kind, file: hit, dir }); continue; }
            const base = saveBaseName(ent.name || ent.file || (id + '.' + (ent.format || 'bin')),
              id + '.' + (ent.format || 'bin'));
            /* 盘不够 → 这一条记进「没存成」并把差多少说出来，而不是抛出去让整单补存中断：
               一次补存几百条，第一条撞满盘就把后面全部丢掉，界面只会说「失败」。 */
            const whySpace = whyNoSpace(dir, buf.length, '补存这一个文件');
            if (whySpace) { full.push({ id, kind, why: whySpace }); continue; }
            const w = writeFresh(dir, base, buf);
            if (w.tooMany) { full.push({ id, kind, why: '那个目录里已经有一千个同名文件了' }); continue; }
            if (w.busy) { full.push({ id, kind, why: '同名文件正被同时写入，抢不到位 —— 这一个没补存，稍后再补一次' }); continue; }
            autosaveUsedAdd(dir);
            sums.add(buf.length, hash, w.file);   // 本次刚写的也要进表，后面那个同内容的 id 就不会再拷一遍
            bytes += buf.length;
            saved.push({ id, kind, file: w.file, dir });
          } catch (e) { full.push({ id, kind, why: '写不进 ' + dir + '：' + (e && e.code ? e.code + ' ' : '') + e.message }); }
        }
        log('[save-local] 补存：存了 ' + saved.length + ' 个（' + (bytes / 1048576).toFixed(1) + ' MB）'
          + (dup.length ? '，那边已经有了 ' + dup.length + ' 个' : '')
          + (missing.length ? '，索引/文件已不在 ' + missing.length + ' 个' : '')
          + (noKind.length ? '，不归任何一类 ' + noKind.length + ' 个' : '')
          + (full.length ? '，没存成 ' + full.length + ' 个' : ''));
        sendJson(res, 200, { ok: true, saved, dup, missing, noKind, full, bytes });
      });
      return;
    }
    /* ============================================================================
       换下载位置时把**旧目录里那些副本**搬过去（POST /save-move）
       ---------------------------------------------------------------------------
       为什么不合并进 /save-local：搬走会**删掉源文件**，性质与「再拷一份」不同，
       走两条路由、两种返回，页面才能分别告诉用户「哪些是复制、哪些是搬走」。
       目录：目标**只从配置读**（同 /save）；来源必须过 `autosaveUsedHas` ——
       证明它是本工作台自己写出来的目录，否则这条路由就成了「搬任意路径的文件」。
       顺序：先写目标、写成功才删源（写失败源文件留在原地，绝不反过来）。
       ========================================================================== */
    if (dataPath === '/save-move' && req.method === 'POST') {
      readBody(req, res, 1024 * 1024).then(raw => {
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        const kind = String((spec && spec.kind) || '').toLowerCase();
        if (!SAVE_KINDS.includes(kind)) return failJson(res, 400, 'kind 只能是 ' + SAVE_KINDS.join(' / '));
        const fromRaw = String((spec && spec.from) || '').trim();
        if (!fromRaw) return failJson(res, 400, '没有要搬的旧目录');
        /* from 传空串 / '@default' = 「旧的也是默认目录」。这一支**不需要**白名单：
           路径是代理自己算的，不是客户端递进来的 ——
           白名单是拿来挡「客户端指定源目录」的，这一支压根没有客户端指定的路径。
           默认目录有**两代**（2026-10-15 起 = 下载\拾帧\<类型>，之前 = 项目下 文件\<类型>）：
           过渡期两处都可能还有东西，所以这一支拿到的是候选表，只搬真实存在的那些。 */
        const srcIsDefault = (fromRaw === '@default' || fromRaw === '');
        const to = autosaveDir(kind);                       // 目标只由配置决定，请求体里的 dir 一律忽略
        if (!to) return failJson(res, 409, typeLabel(kind) + '这一类现在是关着的');
        let srcDirs;
        try { srcDirs = srcIsDefault ? autosaveDefaultDirs(kind) : [path.resolve(fromRaw)]; }
        catch { return failJson(res, 400, '旧目录不是一个有效路径'); }
        /* 白名单挡不住一种情况：用户把「另存目录」**填成 .assets 或它的某个子目录**。
           那样 /save 写进去的副本会让那个目录进白名单（autosaveUsedAdd），
           之后这条路由就会**真的从资产库里把文件搬走** —— 而 .assets 是整个工作台的本体：
           离线能看、删了能回源、缩略图全靠它，搬空了资产库就空了。
           白名单证明的是「这个目录是本工作台写的」，证明不了「搬走它是安全的」，
           所以资产库本体要单独拦 —— 判据是 insideLocalDir 那一份，三条路由共用。 */
        for (const d of srcDirs) if (insideLocalDir(d)) return failJson(res, 403, '那个目录是本机资产库本体（.assets），不从那里搬 —— 资产库一空，工作台就看不到东西了');
        if (insideLocalDir(to)) return failJson(res, 403, '另存目录不能设成本机资产库本体（.assets）—— 请换一个普通文件夹');
        /* 「新旧目录是同一个」要**每一个来源都等于目标**才算整单没事可做：
           候选表里只有其中一个是目标时，另一个还有东西要搬，不能一起跳过。 */
        if (srcDirs.every(d => d === to)) return sendJson(res, 200,
          { ok: true, moved: [], bytes: 0, note: '新旧目录是同一个，没什么可搬' });
        if (!srcIsDefault && !autosaveUsedHas(srcDirs[0])) return failJson(res, 403, '那个目录不是本工作台写出去的，不搬（只搬自动存到过的目录）');
        const moved = [], skipped = [], failed = [], dup = [];
        let bytes = 0;
        try { fs.mkdirSync(to, { recursive: true }); } catch (e) { return failJson(res, 500, '建不出 ' + to + '：' + e.message); }
        const sums = saveDirIndex(to);     // 目标里已有的内容，搬之前先看一眼，避免搬出 xxx-2 这种重复
        const attempted = srcDirs.filter(d => d !== to);
        let readErr = null, readOk = 0;
        for (const srcDir of attempted) {
          let names = [];
          try { names = fs.readdirSync(srcDir); readOk++; } catch (e) { readErr = readErr || e; continue; }
          for (const name of names) {
            const src = path.join(srcDir, name);
            let st; try { st = fs.statSync(src); } catch { continue; }
            if (!st.isFile()) continue;
            /* 属不属于这一类：**只按扩展名表判**（productKindOfName），与 GET /save-stale 同一份。
               以前这里用 localMediaType，而那句对「只剩一个文件名」的情况兜底成音频 ——
               于是界面上数出来的「音频 N 个」里混着用户自己的 notes.txt，而这一行**真的把它搬走并删源**。 */
            if (productKindOfName(name) !== kind) { skipped.push(name); continue; }
            try {
              const buf = fs.readFileSync(src);
              const hash = sha1Of(buf);
              /* 目标里已经有同一份内容：**不重写**，只把源文件删掉 —— 这仍然是「搬」，
                 内容在新目录里好好的一份；不这么做的话，用户补存过的那批会被搬成第二份。
                 删源之前已经确认过内容一致，所以这一步不会丢东西。 */
              const hit = sums.get(buf.length, hash);
              if (hit) { fs.unlinkSync(src); autosaveUsedAdd(to); dup.push({ from: name, to: hit }); continue; }
              const base = saveBaseName(name, name);
              /* 搬是「先写新副本、写成才删源」，所以**源和目标在同一个盘时也需要这一份空间** ——
                 不许因为「反正要删源」就跳过预检：真满了 writeFileSync 会崩在半个文件上，
                 而那半个文件已经不算「源还在原地」了。 */
              const whySpace = whyNoSpace(to, buf.length, '搬这一个文件');
              if (whySpace) { failed.push({ name, why: whySpace }); continue; }
              const w = writeFresh(to, base, buf);
              if (w.tooMany) { failed.push({ name, why: '新目录里已经有一千个同名文件了' }); continue; }
              if (w.busy) { failed.push({ name, why: '新目录里同名文件正被同时写入，抢不到位 —— 源文件留在原地没动' }); continue; }
              fs.unlinkSync(src);                            // 写成功了才删源
              autosaveUsedAdd(to);
              /* 记账**先于**任何可能抛异常的缓存写入** —— 这一段早先写成 sums.set(sig, file)，
                 sig 从未声明，于是每搬一个文件都在记账那一行抛 ReferenceError：
                 文件已经搬成功了，界面却报「没搬成」，还顺手造出 a.mp4 与 a-2.mp4 两份。
                 位置刻意放在 fs.unlinkSync 之后 —— 字节已经落地才算搬成。 */
              bytes += buf.length;
              moved.push({ from: name, to: w.file });
              /* 本次刚写进去的文件要能立刻被后面同内容的请求命中 —— 与 /save-local 同一句 */
              sums.add(buf.length, hash, w.file);
            } catch (e) {
              /* 内部标识符不原样甩给用户：ReferenceError 是我们的错，不是他目录的错 */
              const why = (e instanceof ReferenceError)
                ? '内部错误（记账那一步出错），文件其实已经搬好了 —— 请把这份日志给作者'
                : ((e && e.code ? e.code + ' ' : '') + (e && e.message));
              failed.push({ name, why });
            }
          }
        }
        /* 一个来源都读不出来才算「读不出旧目录」：多来源时只要有一处能读就照常搬，
           读不出的那一处照实留在日志里，不把整单拦掉。 */
        if (!readOk && readErr) return failJson(res, 404, '读不出旧目录：' + readErr.message);
        log('[save-move] ' + kind + ' ' + attempted.join(' + ') + ' → ' + to + '：搬走 ' + moved.length
          + ' 个（' + (bytes / 1048576).toFixed(1) + ' MB）'
          + (dup.length ? '，那边已有同样内容、只删了源 ' + dup.length + ' 个' : '')
          + '，不是这一类 ' + skipped.length + ' 个'
          + (failed.length ? '，没搬成 ' + failed.length + ' 个' : ''));
        sendJson(res, 200, { ok: true, from: srcDirs.length === 1 ? srcDirs[0] : srcDirs, to, moved, dup, skipped, failed, bytes });
      });
      return;
    }
    return false;
  }

  return { handleSave };
}

module.exports = { createSaveRoutes };
