/* FCPXML 媒体包与工程目录：
     POST /fcpxml/bundle   { fcpxml, srt?, assets:[{src,name}] } → zip（同时落一份 bundle 目录）
     POST /fcpxml/project  同样的请求体 → 留在本机资产库下的 FCPXML工程/<id>/ 并回 JSON
     POST /fcpxml/reveal   { id } → 打开该工程目录
   两条写盘出口共用 writeBundle：校验 / 体量闸 / 取素材 / 写 missing.txt 只在这一份里；
   zip 只有 bundle 那条路才生成 —— 工程目录是给用户在本机直接打开的摊开目录，
   再塞一份压缩副本等于把 media/ 里的素材在盘上存两遍（视频压不动，体积直接翻倍）。
   落点分开：媒体包的内部临时目录在 RENDER_DIR，工程目录在「设置 → 本机资产库」的库根下，
   与 图片/ 视频/ 音频/ 平级、用户翻得到；库根由 app.js 注入的现读函数给出，不启动时定死。
   project.fcpxml + media/ + subtitles.srt + missing.txt 就是一份可导入的完整工程，
   不绑定任何剪辑软件，也不替用户启动软件。
   素材名由客户端保证唯一；这里在**建目录之前**再查一遍，重名直接 400 —— 静默改名会让 XML 里的
   `media/<名>` 与盘上的文件对不上，比整单失败更难查。
   字幕只写到固定名字 subtitles.srt，与缺失素材清单分开：字幕写不下去就整单失败（500），
   不允许「用户以为带了字幕、包里却没有」。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { openDir } = require('../open-dir.js');
const { FCPXML_PROJECT_DIR } = require('../user-dirs.js');
const { createZip } = require('../zip.js');
const { renameWithRetry } = require('../data-hub.js');
const { sendJson, noStore } = require('./http');

/* 媒体名怎么洗只有 app.js 注入的那一份 `fileSafe`（与提示词归档、库根落点同一条规则）：
   这里不再写第二份非法字符表。长度档取 120：与导演台把素材存回本机那一份齐平。 */
const ASSET_NAME_MAX = 120;
const ASSETS_MAX = 500;
const MB = 1024 * 1024;
const KEEP_PROJECTS = 20;          // 工程目录只留最近 20 个，更早的连目录一起收
const KEEP_BUNDLES = 20;           // bundle 目录同样只留最近 20 个（与工程目录同口径）
/* 与 local-assets-store.js 的 SKIP_DIR_NAMES 同一枚常量：工程目录在库根下，
   但里面 media/ 的素材副本不该被资产库递归扫描当成新产物登记。 */
const PROJECT_SUBDIR = FCPXML_PROJECT_DIR;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;   // reveal 的输入校验（宽松：只挡分隔符与超长）
/* 清扫只认代理自己造的目录名 = 秒级时间戳 + 随机后缀。
   以前按 `/^fcpxml-/` 与宽松的 PROJECT_ID 扫：用户在 RENDER_DIR 放一个 `fcpxml-我的备份`、
   或在 FCPXML工程/ 里放一个 `my-project`，都会被当成旧导出静默删掉。
   reveal 仍用宽松的 PROJECT_ID，两者用途不同，不要合并。 */
const OWN_NAME = /^\d{8}T\d{6}-[a-z0-9]{1,8}$/;
const fmtMb = b => (b / MB).toFixed(0) + ' MB';
/* 工程目录的根跟着「设置 → 本机资产库」的现读法：用户换了库根，下一次导出就落到新根。
   ctx.localRoot 是 app.js 注入的函数；没注入的调用方退回 RENDER_DIR，不擅自写进用户真机。
   清扫与 reveal 都问这一份，三处不会各拼一个路径。 */
function projectRootOf(ctx) {
  const root = typeof ctx.localRoot === 'function' ? ctx.localRoot() : '';
  return path.join(root || ctx.renderDir, PROJECT_SUBDIR);
}
/* 写不下去时给的出路要对着真正那个根说：媒体包在 RENDER_DIR，工程目录在资产库。 */
function dirHint(needZip) {
  return needZip
    ? '可在 .env 里把 RENDER_DIR 指到别的盘（改完要重启）'
    : '可在「设置 → 本机资产库」换个库根，或在 .env 里改 ASSETS_DIR（改完要重启）';
}
/* 探针口：测试里不真的弹出资源管理器（那是工作区外的副作用）。
   只免掉 spawn，路径校验、目录检查、返回形状都照旧，所以「打开目录」这条链仍是被测的。 */
const noSpawn = () => String(process.env.WB_FCPXML_DRY || '') === '1';

/* 非 JSON 的写出（zip）也走同一份缓存头口径：no-store 由 ./http 补。 */
function send(res, code, type, body, extra = {}) {
  noStore(res);
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(body);
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function assetNameOf(fileSafe, raw, i) {
  const fallback = 'asset-' + (i + 1);
  return String(fileSafe(raw || fallback, ASSET_NAME_MAX) || fallback);
}

/* 请求体 → 已校验的这份数据。所有 400 都在这里抛，**一个目录都不建**：
   字幕体量 / 条数、一单条数、素材重名。 */
function parsePayload(ctx, body) {
  const xml = String((body && body.fcpxml) || '');
  if (!xml.trim()) throw httpError(400, '缺少 fcpxml');
  /* 一单几条：超出上限的那部分以前是被 slice 静默切掉的 —— zip 里没有、missing.txt 里也没有，
     用户以为素材齐了。现在照实记数：一条不落、一条不闷。 */
  const wantAssets = Array.isArray(body.assets) ? body.assets : [];
  const assets = wantAssets.slice(0, ASSETS_MAX);
  /* 字幕：与客户端 SRT 导出同一份文本（BOM + CRLF 由客户端决定），这里只验体量与条数。 */
  const srt = typeof (body && body.srt) === 'string' ? body.srt : '';
  const srtUsed = !!srt.trim();
  if (srtUsed) {
    const bytes = Buffer.byteLength(srt, 'utf8');
    if (bytes > 5 * 1024 * 1024) {
      throw httpError(400, '字幕超过 5 MB，这一单没有生成（' + (bytes / 1048576).toFixed(1) + ' MB）');
    }
    const n = srt.trim().split(/\r?\n\r?\n/).filter(b => b.includes('-->')).length;
    if (n > 5000) throw httpError(400, '字幕 ' + n + ' 条，超过上限 5000 条，没有生成');
  }
  const names = assets.map((a, i) => assetNameOf(ctx.fileSafe, a && a.name, i));
  const seen = new Set(), dup = new Set();
  names.forEach(n => { if (seen.has(n)) dup.add(n); else seen.add(n); });
  if (dup.size) {
    const list = Array.from(dup);
    throw httpError(400, '素材名重复：' + list.slice(0, 10).join('、')
      + (list.length > 10 ? ' 等 ' + list.length + ' 个' : '')
      + '。同名会让包内文件互相覆盖、XML 也分不清引用哪一份，请先在导出端保证名字唯一');
  }
  return { xml, wantAssets, assets, names, srt, srtUsed };
}

/* 找一个这一单独占的目录。目录名带随机后缀：两个请求落在同一秒里导出，光按时间戳算会得出同一个
   名字，于是第二单往第一单已经写好的目录里盖 —— 两个包各混着另一半，而界面会说两次「导出成功」。 */
function makeDir(ctx, spec) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  /* parent 是调用方算好的绝对目录：媒体包 = RENDER_DIR，工程目录 = 资产库根/FCPXML工程。
     目录名前缀只给 bundle 用，清扫认的就是它（工程目录在自己的子目录里，不与素材混）。 */
  const parent = spec.parent;
  const prefix = spec.needZip ? 'fcpxml-' : '';
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (e) {
    throw httpError(500, '导出目录建不起来（' + ((e && e.message) || e) + '）：'
      + parent + ' 所在磁盘满或被占用，' + dirHint(spec.needZip));
  }
  for (let i = 0; i < 20; i++) {
    const suffix = Math.random().toString(36).slice(2, 8) || '0';  // random=0 时会切出空串，兜一下保证名字可清扫
    const name = prefix + stamp + '-' + suffix;
    const cand = path.join(parent, name);
    if (!fs.existsSync(cand)) return cand;
  }
  throw httpError(409, '同一秒里导出目录名撞满了，稍后再导一次');
}

/* 写工程 / 媒体 / 字幕 / missing.txt 的唯一实现（zip 只在 needZip 时追加）。
   返回这次落盘的全部事实；任何一步失败都把刚建的目录整个删掉再抛
   （半截目录不该留给用户以为是成品）。 */
async function writeBundle(ctx, spec) {
  const { xml, wantAssets, assets, names, srt, srtUsed, parent, needZip } = spec;
  const log = ctx.log || (() => {});
  const dir = makeDir(ctx, spec);
  const mediaDir = path.join(dir, 'media');
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.fcpxml'), xml);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw httpError(500, '导出目录写不下去（' + (e && e.code ? e.code + ' ' : '') + ((e && e.message) || e) + '）：'
      + parent + ' 所在磁盘满或被占用，' + dirHint(needZip));
  }
  /* files 只给 createZip 用。工程目录不打包，就不该把每份素材的 Buffer 全攒在内存里等函数返回
     （media/ 已经落盘，再攒一份等于「不写 zip 却照样吃两份内存」）。
     素材数单独计，不靠 files 反推 —— 否则不打包时回执会谎报「0 份进包」。 */
  const files = needZip ? [{ name: 'project.fcpxml', data: Buffer.from(xml) }] : [];
  let assetsInBundle = 0;
  const srtBytes = srtUsed ? Buffer.byteLength(srt, 'utf8') : 0;
  if (srtUsed) {
    try { fs.writeFileSync(path.join(dir, 'subtitles.srt'), srt, 'utf8'); }
    catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw httpError(500, '字幕写入失败：' + ((e && e.message) || e));
    }
    if (needZip) files.push({ name: 'subtitles.srt', data: Buffer.from(srt, 'utf8') });
  }
  const missing = [];
  /* 体量闸：单条素材与整单各一道。两档理由不同、但都需要这道闸：
     媒体包的 zip 写入器不支持 ZIP64（条目长度与偏移都是 32 位），且 createZip 一次拼进内存；
     工程目录虽不打包，也不能让一单导出把库盘写满或把代理内存吃光。
     「500 条 4K 片段」这一单不限量时，用户看到的是「程序没了」而不是「这一单太大」。
     默认单条 512 MB / 整单 2 GB，可由 .env 的 FCPXML_MAX_ASSET_MB、FCPXML_MAX_BUNDLE_MB 调。 */
  const maxFileBytes = Math.max(MB, Number(ctx.maxAssetBytes) || 512 * MB);
  const maxTotalBytes = Math.max(maxFileBytes, Number(ctx.maxBundleBytes) || 2048 * MB);
  let packed = Buffer.byteLength(xml) + srtBytes;
  let budgetOut = false;      // 整包预算用尽：此后每一条都照实记进 missing.txt，绝不静默跳过
  /* 先量后读：判据是盘上/上游报的字节数，不是读进内存之后的长度 ——
     后者要真读完才知道超标，撑爆内存的那一下已经发生了。 */
  const overBudget = size => {
    if (!(size > 0)) return '素材读出来是空的（0 字节），没有写入';
    if (size > maxFileBytes) return '单条素材 ' + fmtMb(size) + '，超过上限 ' + fmtMb(maxFileBytes) + '，没有取';
    if (packed + size > maxTotalBytes) {
      budgetOut = true;
      return '这一单已达上限 ' + fmtMb(maxTotalBytes) + '，从这一条起后面的素材都没有取';
    }
    return '';
  };
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i] || {};
    const name = names[i];
    if (budgetOut) {
      missing.push(name + '\t' + (a.src || '')
        + '\t这一单已达上限 ' + fmtMb(maxTotalBytes) + '，这一条没有取（可分两单导出，或在 .env 里调大 FCPXML_MAX_BUNDLE_MB）');
      continue;
    }
    let tmp = '';
    try {
      let data = null;
      let size = 0;
      let srcPath = '';
      const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(String(a.src || ''));
      if (m && ctx.localAssetFile) srcPath = ctx.localAssetFile(m[1]) || '';
      if (srcPath && fs.existsSync(srcPath)) {
        const st = fs.statSync(srcPath);
        if (!st.isFile()) throw new Error('本机素材不是一个普通文件');
        const why = overBudget(st.size); if (why) throw new Error(why);
        const dest = path.join(mediaDir, name);
        size = st.size;
        /* 只有要打 zip 时才把整份素材读进内存；否则直接拷盘，
           一条 500 MB 的片段不该让代理进程白吃 500 MB。 */
        if (needZip) { data = fs.readFileSync(srcPath); fs.writeFileSync(dest, data); }
        else fs.copyFileSync(srcPath, dest);
      } else {
        const url = await ctx.resolveSrc(a.src || '');
        tmp = path.join(mediaDir, name + '.part-' + process.pid);
        const reported = Number(await ctx.downloadTo(url, tmp)) || fs.statSync(tmp).size;
        const why = overBudget(reported);
        if (why) { try { fs.unlinkSync(tmp); } catch {} throw new Error(why); }
        const dest = path.join(mediaDir, name);
        renameWithRetry(tmp, dest);   // 刚下完的文件正被杀软扫着时 EPERM 一次，重试就好（与 fs-atomic 同一份脾气）
        tmp = '';
        size = fs.statSync(dest).size;   // 以盘上真实字节数记账，不以上游报的数为准
        if (needZip) data = fs.readFileSync(dest);
      }
      packed += size;
      assetsInBundle++;
      if (needZip) files.push({ name: 'media/' + name, data });
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }   // 半截 .part 不留在包里
      missing.push(name + '\t' + (a.src || '') + '\t' + ((e && e.message) || e));
    }
  }
  /* 一单条数封顶之外多递的那几条：以前 slice 一刀切掉，包里 / 工程里没有、missing.txt 里也没有，
     用户以为齐了 —— 按「缺失一律报数」在这里补一行总数与名单（名单只列前 20 条）。 */
  if (wantAssets.length > assets.length) {
    const dropped = wantAssets.slice(ASSETS_MAX);
    const shown = dropped.slice(0, 20).map((a, j) => assetNameOf(ctx.fileSafe, a && a.name, ASSETS_MAX + j)).join('、');
    missing.push('(一单 ' + ASSETS_MAX + ' 条封顶)\t\t这一单递了 ' + wantAssets.length + ' 条，从第 ' + (ASSETS_MAX + 1)
      + ' 条起共 ' + dropped.length + ' 条没有写入：' + shown + (dropped.length > 20 ? ' 等' : '') + '（分两单导出）');
  }
  if (missing.length) {
    const missingBuf = Buffer.from(missing.join('\n'), 'utf8');
    try { fs.writeFileSync(path.join(dir, 'missing.txt'), missingBuf); }
    catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw httpError(500, '缺失素材清单写不下去：' + ((e && e.message) || e));
    }
    if (needZip) files.push({ name: 'missing.txt', data: missingBuf });
  }
  /* 打包与落盘也是一次可能失败的写入：createZip 全在内存里拼，
     ENOENT/ENOSPC/EPERM 抛出去只会变成最外层那句泛泛的 500，
     而这儿知道是哪个目录、包已经吃进多少字节 —— 报错要说得出「少勾几条」这句话。
     工程目录那一档 needZip=false：不生成 zip，也就没有这一次全量内存拷贝与双倍落盘。 */
  let zip = null;
  if (needZip) {
    try {
      zip = createZip(files);
      fs.writeFileSync(path.join(dir, 'bundle.zip'), zip);
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      log('[fcpxml] 打包失败：' + ((e && e.message) || e));
      throw httpError(500, '媒体包打包/写入失败（' + (e && e.code ? e.code + ' ' : '') + ((e && e.message) || e) + '）：'
        + '这一单已经吃掉 ' + fmtMb(packed) + '，减少勾选的素材，'
        + '或在 .env 里把 RENDER_DIR 指到空间充足的盘（改完要重启）');
    }
  }
  log('[fcpxml] ' + (needZip ? '媒体包' : '工程目录') + '：' + dir + '（'
    + (wantAssets.length === assets.length ? assets.length : wantAssets.length + ' 递来 / 只收 ' + assets.length)
    + ' 条，落盘 ' + assetsInBundle + ' 条，缺 ' + missing.length + ' 条，'
    + fmtMb(packed) + ' / 上限 ' + fmtMb(maxTotalBytes)
    + (srtUsed ? '，字幕 ' + srtBytes + ' 字节' : '，无字幕') + '）');
  return {
    dir, id: path.basename(dir), zip, files,
    assetsInBundle, missingCount: missing.length, packed,
  };
}

/* 工程目录只留最近 20 个：目录名以秒级时间戳开头，按名字倒序就是新旧顺序。
   删除失败只记日志，不影响这一次导出的结果。 */
function pruneProjects(ctx) {
  const root = projectRootOf(ctx);
  let entries = [];
  /* 先按「自己造的名字」过滤再排序：把用户自己放的文件夹算进前 20 会少删几个真工程目录。 */
  try { entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && OWN_NAME.test(d.name)).map(d => d.name); }
  catch (e) { return; }
  entries.sort().reverse().slice(KEEP_PROJECTS).forEach(name => {
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); }
    catch (e) { (ctx.log || (() => {}))('[fcpxml] 旧工程目录没删掉（下次再试）：' + name + '：' + ((e && e.message) || e)); }
  });
}
/* bundle 目录（fcpxml-<stamp>-<random>/）也纳入保留策略：保留最近 20 个，与工程目录同口径。
   以前只裁工程那 20 个，bundle 目录从不清理 → .renders 无限膨胀。 */
function pruneBundles(ctx) {
  let entries = [];
  try { entries = fs.readdirSync(ctx.renderDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^fcpxml-/.test(d.name) && OWN_NAME.test(d.name.slice('fcpxml-'.length))).map(d => d.name); }
  catch (e) { return; }
  entries.sort().reverse().slice(KEEP_BUNDLES).forEach(name => {
    try { fs.rmSync(path.join(ctx.renderDir, name), { recursive: true, force: true }); }
    catch (e) { (ctx.log || (() => {}))('[fcpxml] 旧 bundle 目录没删掉（下次再试）：' + name + '：' + ((e && e.message) || e)); }
  });
}

/* ---------------------------------------------------------------------------
   三条路由
   ------------------------------------------------------------------------- */

async function handleBundle(req, res, ctx) {
  const parsed = parsePayload(ctx, await ctx.readJson(req, 32 * 1024 * 1024));
  const out = await writeBundle(ctx, { ...parsed, parent: ctx.renderDir, needZip: true });
  pruneBundles(ctx);
  send(res, 200, 'application/zip', out.zip,
    { 'Content-Disposition': 'attachment; filename="' + out.id + '.zip"' });
}

/* 持久工程目录：与 bundle 同一份 writeBundle，落到本机资产库下的 FCPXML工程/ 并回目录信息，
   不写 bundle.zip。回的是「盘上真的写好了什么」，客户端据此给路径、报缺失、开文件夹；
   不启动任何剪辑软件。 */
async function handleProject(req, res, ctx) {
  const parsed = parsePayload(ctx, await ctx.readJson(req, 32 * 1024 * 1024));
  const out = await writeBundle(ctx, { ...parsed, parent: projectRootOf(ctx), needZip: false });
  pruneProjects(ctx);
  sendJson(res, 200, {
    ok: true, id: out.id, dir: out.dir,
    project: path.join(out.dir, 'project.fcpxml'),
    missing: path.join(out.dir, 'missing.txt'),
    missingCount: out.missingCount,
    assets: out.assetsInBundle,
    packed: out.packed,
  });
}

async function handleReveal(req, res, ctx) {
  const body = await ctx.readJson(req, 64 * 1024);
  const id = String((body && body.id) || '');
  if (!PROJECT_ID.test(id)) throw httpError(400, 'id 不合法（只接受字母 / 数字 / _ / -，最长 64）');
  const root = projectRootOf(ctx);
  const dir = path.join(root, id);
  /* 只按目录名拼，不读客户端传来的绝对路径；path.relative 再兜一次穿越。
     （id 的字符集里本来就没有 . 与分隔符，这一道是给将来放宽字符集时留的判据。） */
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw httpError(400, 'id 不合法（越出了工程目录）');
  let st = null;
  try { st = fs.statSync(dir); } catch (e) {}
  /* 库根是现读的：导出之后用户改了「设置 → 本机资产库」，老 id 就会在新根下找不到。
     只说「已被清理」会把人往错方向带，这里把两种原因一起点名。 */
  if (!st || !st.isDirectory()) throw httpError(404, '工程目录不在了：可能已被清理，或本机资产库位置改过；重新导出一次工程目录');
  if (noSpawn()) { sendJson(res, 200, { ok: true, dir, dry: true }); return; }
  /* 打开目录走公共件（与提示词归档同一条路）：Windows 上由后台进程拉起的 explorer 会被
     前台锁压在应用窗口后面 —— 那一层「再拽到前台」只在 server/open-dir.js 一处。 */
  openDir(dir);
  sendJson(res, 200, { ok: true, dir });
}

async function handleFcpxml(req, res, ctx) {
  const p = String(req.url || '').split('?')[0];
  try {
    if (p === '/fcpxml/bundle') { await handleBundle(req, res, ctx); return true; }
    if (p === '/fcpxml/project') { await handleProject(req, res, ctx); return true; }
    if (p === '/fcpxml/reveal') { await handleReveal(req, res, ctx); return true; }
    sendJson(res, 404, { error: '未知的 FCPXML 路由：' + p });
  } catch (e) {
    if (!res.headersSent) sendJson(res, Number(e && e.status) || 500, { error: (e && e.message) || '导出失败' });
  }
  return true;
}
module.exports = { handleFcpxml, PROJECT_SUBDIR, PROJECT_ID, projectRootOf };
