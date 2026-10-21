/* FCPXML 媒体包与「一键送到剪映 / 达芬奇」：
     POST /fcpxml/bundle  { fcpxml, srt?, assets:[{src,name}] } → zip
     POST /fcpxml/import  同样的请求体 → 留在 RENDER_DIR/fcpxml-import/<id>/ 并回 JSON
     POST /fcpxml/reveal  { id } → 打开该导入目录
     POST /fcpxml/launch  { app:'jianying'|'resolve' } → 尽力启动软件（只从固定候选路径找）
   三条写盘出口共用 writeBundle：校验 / 体量闸 / 取素材 / 写 missing.txt / 打包只在这一份里。
   素材名由客户端保证唯一；这里在**建目录之前**再查一遍，重名直接 400 —— 静默改名会让 XML 里的
   `media/<名>` 与盘上的文件对不上，比整单失败更难查。
   字幕只写到固定名字 subtitles.srt，与缺失素材清单分开：字幕写不下去就整单失败（500），
   不允许「用户以为带了字幕、包里却没有」。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createZip } = require('../zip.js');
const { renameWithRetry } = require('../fs-atomic.js');
const { sendJson, noStore } = require('./http');

/* 媒体名怎么洗只有 app.js 注入的那一份 `fileSafe`（与 /save、/render、提示词归档同一条规则）：
   这里不再写第二份非法字符表。长度档取 120：与导演台把素材存回本机那一份齐平。 */
const ASSET_NAME_MAX = 120;
const ASSETS_MAX = 500;
const MB = 1024 * 1024;
const KEEP_IMPORTS = 20;           // 一键导入的工程目录只留最近 20 个，更早的连目录一起收
const IMPORT_ROOT = 'fcpxml-import';
const IMPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const fmtMb = b => (b / MB).toFixed(0) + ' MB';
/* 探针口：测试里不真的拉起用户的剪映 / 达芬奇或资源管理器（那是工作区外的副作用）。
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
     用户以为素材齐了。现在照 AGENTS §14.5 记数：一条不落、一条不闷。 */
  const wantAssets = Array.isArray(body.assets) ? body.assets : [];
  const assets = wantAssets.slice(0, ASSETS_MAX);
  /* 字幕：与客户端 SRT 导出同一份文本（BOM + CRLF 由客户端决定），这里只验体量与条数。 */
  const srt = typeof (body && body.srt) === 'string' ? body.srt : '';
  const srtUsed = !!srt.trim();
  if (srtUsed) {
    const bytes = Buffer.byteLength(srt, 'utf8');
    if (bytes > 5 * 1024 * 1024) {
      throw httpError(400, '字幕超过 5 MB，媒体包没有生成（' + (bytes / 1048576).toFixed(1) + ' MB）');
    }
    const n = srt.trim().split(/\r?\n\r?\n/).filter(b => b.includes('-->')).length;
    if (n > 5000) throw httpError(400, '字幕 ' + n + ' 条，超过媒体包上限 5000 条，没有生成');
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
function makeDir(ctx, root) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const parent = root ? path.join(ctx.renderDir, root) : ctx.renderDir;
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (e) {
    throw httpError(500, '媒体包目录建不起来（' + ((e && e.message) || e) + '）：'
      + ctx.renderDir + ' 所在磁盘满或被占用，可在 .env 里把 RENDER_DIR 指到别的盘（改完要重启）');
  }
  for (let i = 0; i < 20; i++) {
    const name = (root ? '' : 'fcpxml-') + stamp + '-' + Math.random().toString(36).slice(2, 8);
    const cand = path.join(parent, name);
    if (!fs.existsSync(cand)) return cand;
  }
  throw httpError(409, '同一秒里媒体包目录名撞满了，稍后再导一次');
}

/* 写工程 / 媒体 / 字幕 / missing.txt / bundle.zip 的唯一实现。返回这次落盘的全部事实；
   任何一步失败都把刚建的目录整个删掉再抛（半截目录不该留给用户以为是成品）。 */
async function writeBundle(ctx, spec) {
  const { xml, wantAssets, assets, names, srt, srtUsed, root } = spec;
  const log = ctx.log || (() => {});
  const dir = makeDir(ctx, root);
  const mediaDir = path.join(dir, 'media');
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.fcpxml'), xml);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw httpError(500, '媒体包目录写不下去（' + (e && e.code ? e.code + ' ' : '') + ((e && e.message) || e) + '）：'
      + ctx.renderDir + ' 所在磁盘满或被占用，可在 .env 里把 RENDER_DIR 指到别的盘（改完要重启）');
  }
  const files = [{ name: 'project.fcpxml', data: Buffer.from(xml) }];
  let srtBuf = null;
  if (srtUsed) {
    try {
      fs.writeFileSync(path.join(dir, 'subtitles.srt'), srt, 'utf8');
      srtBuf = Buffer.from(srt, 'utf8');
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw httpError(500, '字幕写入失败：' + ((e && e.message) || e));
    }
    files.push({ name: 'subtitles.srt', data: srtBuf });
  }
  const missing = [];
  /* 体量闸：单条素材与整包各一道。必须有的理由 —— zip 写入器不支持 ZIP64
     （条目长度与偏移都是 32 位），而 createZip 把所有素材一次性读进内存再 Buffer.concat：
     「500 条 4K 片段」这一单不限量时，代理进程会先被撑爆，
     用户看到的是「程序没了」而不是「这个包太大」。
     默认单条 512 MB / 整包 2 GB，可由 .env 的 FCPXML_MAX_ASSET_MB、FCPXML_MAX_BUNDLE_MB 调。 */
  const maxFileBytes = Math.max(MB, Number(ctx.maxAssetBytes) || 512 * MB);
  const maxTotalBytes = Math.max(maxFileBytes, Number(ctx.maxBundleBytes) || 2048 * MB);
  let packed = Buffer.byteLength(xml) + (srtBuf ? srtBuf.length : 0);
  let budgetOut = false;      // 整包预算用尽：此后每一条都照实记进 missing.txt，绝不静默跳过
  /* 先量后读：判据是盘上/上游报的字节数，不是读进内存之后的长度 ——
     后者要真读完才知道超标，撑爆内存的那一下已经发生了。 */
  const overBudget = size => {
    if (!(size > 0)) return '素材读出来是空的（0 字节），没有进包';
    if (size > maxFileBytes) return '单条素材 ' + fmtMb(size) + '，超过上限 ' + fmtMb(maxFileBytes) + '，没有取';
    if (packed + size > maxTotalBytes) {
      budgetOut = true;
      return '整包已达上限 ' + fmtMb(maxTotalBytes) + '，从这一条起后面的素材都没有取';
    }
    return '';
  };
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i] || {};
    const name = names[i];
    if (budgetOut) {
      missing.push(name + '\t' + (a.src || '')
        + '\t整包已达上限 ' + fmtMb(maxTotalBytes) + '，这一条没有取（可分两单导出，或在 .env 里调大 FCPXML_MAX_BUNDLE_MB）');
      continue;
    }
    let tmp = '';
    try {
      let data = null;
      let srcPath = '';
      const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(String(a.src || ''));
      if (m && ctx.localAssetFile) srcPath = ctx.localAssetFile(m[1]) || '';
      if (srcPath && fs.existsSync(srcPath)) {
        const st = fs.statSync(srcPath);
        if (!st.isFile()) throw new Error('本机素材不是一个普通文件');
        const why = overBudget(st.size); if (why) throw new Error(why);
        data = fs.readFileSync(srcPath);
        fs.writeFileSync(path.join(mediaDir, name), data);
      } else {
        const url = await ctx.resolveSrc(a.src || '');
        tmp = path.join(mediaDir, name + '.part-' + process.pid);
        const size = Number(await ctx.downloadTo(url, tmp)) || fs.statSync(tmp).size;
        const why = overBudget(size);
        if (why) { try { fs.unlinkSync(tmp); } catch {} throw new Error(why); }
        const dest = path.join(mediaDir, name);
        renameWithRetry(tmp, dest);   // 刚下完的文件正被杀软扫着时 EPERM 一次，重试就好（与 fs-atomic 同一份脾气）
        tmp = '';
        data = fs.readFileSync(dest);
      }
      packed += data.length;
      files.push({ name: 'media/' + name, data });
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }   // 半截 .part 不留在包里
      missing.push(name + '\t' + (a.src || '') + '\t' + ((e && e.message) || e));
    }
  }
  /* 一单条数封顶之外多递的那几条：以前 slice 一刀切掉，zip 里没有、missing.txt 里也没有，
     用户以为齐了 —— 按 AGENTS §14.5「缺失一律报数」在这里补一行总数与名单（名单只列前 20 条）。 */
  if (wantAssets.length > assets.length) {
    const dropped = wantAssets.slice(ASSETS_MAX);
    const shown = dropped.slice(0, 20).map((a, j) => assetNameOf(ctx.fileSafe, a && a.name, ASSETS_MAX + j)).join('、');
    missing.push('(一单 ' + ASSETS_MAX + ' 条封顶)\t\t这一单递了 ' + wantAssets.length + ' 条，从第 ' + (ASSETS_MAX + 1)
      + ' 条起共 ' + dropped.length + ' 条没有打包：' + shown + (dropped.length > 20 ? ' 等' : '') + '（分两单导出）');
  }
  if (missing.length) {
    const missingBuf = Buffer.from(missing.join('\n'), 'utf8');
    try { fs.writeFileSync(path.join(dir, 'missing.txt'), missingBuf); }
    catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw httpError(500, '缺失素材清单写不下去：' + ((e && e.message) || e));
    }
    files.push({ name: 'missing.txt', data: missingBuf });
  }
  /* 打包与落盘也是一次可能失败的写入：createZip 全在内存里拼，
     ENOENT/ENOSPC/EPERM 抛出去只会变成最外层那句泛泛的 500，
     而这儿知道是哪个目录、包已经吃进多少字节 —— 报错要说得出「少勾几条」这句话。 */
  let zip;
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
  log('[fcpxml] 媒体包：' + dir + '（'
    + (wantAssets.length === assets.length ? assets.length : wantAssets.length + ' 递来 / 只收 ' + assets.length)
    + ' 条，缺 ' + missing.length + ' 条，'
    + fmtMb(packed) + ' / 上限 ' + fmtMb(maxTotalBytes)
    + (srtBuf ? '，字幕 ' + Buffer.byteLength(srt, 'utf8') + ' 字节' : '，无字幕') + '）');
  return {
    dir, id: path.basename(dir), zip, files,
    assetsInBundle: files.filter(f => f.name.startsWith('media/')).length,
    missingCount: missing.length, packed,
  };
}

/* 一键导入目录只留最近 20 个：目录名以秒级时间戳开头，按名字倒序就是新旧顺序。
   删除失败只记日志，不影响这一次导入的结果。 */
function pruneImports(ctx) {
  const root = path.join(ctx.renderDir, IMPORT_ROOT);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch (e) { return; }
  entries.sort().reverse().slice(KEEP_IMPORTS).forEach(name => {
    if (!IMPORT_ID.test(name)) return;
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); }
    catch (e) { (ctx.log || (() => {}))('[fcpxml] 旧导入目录没删掉（下次再试）：' + name + '：' + ((e && e.message) || e)); }
  });
}

/* ---------------------------------------------------------------------------
   四条路由
   ------------------------------------------------------------------------- */

async function handleBundle(req, res, ctx) {
  const parsed = parsePayload(ctx, await ctx.readJson(req, 32 * 1024 * 1024));
  const out = await writeBundle(ctx, { ...parsed, root: '' });
  send(res, 200, 'application/zip', out.zip,
    { 'Content-Disposition': 'attachment; filename="' + out.id + '.zip"' });
}

async function handleImport(req, res, ctx) {
  const parsed = parsePayload(ctx, await ctx.readJson(req, 32 * 1024 * 1024));
  const out = await writeBundle(ctx, { ...parsed, root: IMPORT_ROOT });
  pruneImports(ctx);
  sendJson(res, 200, {
    ok: true, id: out.id, dir: out.dir,
    project: path.join(out.dir, 'project.fcpxml'),
    missing: path.join(out.dir, 'missing.txt'),
    missingCount: out.missingCount,
    assets: out.assetsInBundle,
  });
}

async function handleReveal(req, res, ctx) {
  const body = await ctx.readJson(req, 64 * 1024);
  const id = String((body && body.id) || '');
  if (!IMPORT_ID.test(id)) throw httpError(400, 'id 不合法（只接受字母 / 数字 / _ / -，最长 64）');
  const root = path.join(ctx.renderDir, IMPORT_ROOT);
  const dir = path.join(root, id);
  /* 只按目录名拼，不读客户端传来的绝对路径；path.relative 再兜一次穿越。
     （id 的字符集里本来就没有 . 与分隔符，这一道是给将来放宽字符集时留的判据。） */
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw httpError(400, 'id 不合法（越出了导入目录）');
  let st = null;
  try { st = fs.statSync(dir); } catch (e) {}
  if (!st || !st.isDirectory()) throw httpError(404, '导入目录不在了：可能已被清理，重新「送到剪映 / 达芬奇」一次');
  const cmd = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (noSpawn()) { sendJson(res, 200, { ok: true, dir, dry: true }); return; }
  try {
    const p = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {
    throw httpError(500, '打不开文件夹（' + ((e && e.message) || e) + '）：' + dir);
  }
  sendJson(res, 200, { ok: true, dir });
}

/* 只从固定候选路径找 —— 不接受客户端给路径或命令：
   否则「送到剪映」就成了一个任意程序启动口。 */
function launchCandidates(app) {
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  if (app === 'resolve') {
    return [
      path.join(pf, 'Blackmagic Design', 'DaVinci Resolve', 'Resolve.exe'),
      path.join(pf86, 'Blackmagic Design', 'DaVinci Resolve', 'Resolve.exe'),
    ];
  }
  const list = [];
  if (local) {
    list.push(path.join(local, 'JianyingPro', 'Apps', 'JianyingPro.exe'));
    list.push(path.join(local, 'JianyingPro', 'JianyingPro.exe'));
    /* 剪映专业版实际装在 `%LOCALAPPDATA%\\JianyingPro\\Apps\\<版本号>\\JianyingPro.exe`，
       版本目录名每次更新都变，所以这一层按目录扫描（只扫一层，不递归）。 */
    try {
      const base = path.join(local, 'JianyingPro', 'Apps');
      fs.readdirSync(base).forEach(d => list.push(path.join(base, d, 'JianyingPro.exe')));
    } catch (e) {}
  }
  list.push(path.join(pf, 'JianyingPro', 'JianyingPro.exe'));
  list.push(path.join(pf86, 'JianyingPro', 'JianyingPro.exe'));
  return list;
}
const APP_NAME = { jianying: '剪映专业版', resolve: 'DaVinci Resolve' };

async function handleLaunch(req, res, ctx) {
  const body = await ctx.readJson(req, 64 * 1024);
  const app = String((body && body.app) || '');
  if (!APP_NAME[app]) throw httpError(400, 'app 只接受 jianying / resolve');
  const hit = launchCandidates(app).find(f => {
    try { return fs.statSync(f).isFile(); } catch (e) { return false; }
  });
  if (!hit) {
    sendJson(res, 200, { ok: false, app, reason: '没有找到 ' + APP_NAME[app] + ' 的安装位置，请手动打开它' });
    return;
  }
  if (noSpawn()) { sendJson(res, 200, { ok: true, app, dry: true }); return; }
  try {
    const p = spawn(hit, [], { detached: true, stdio: 'ignore', cwd: path.dirname(hit) });
    p.on('error', () => {});
    p.unref();
  } catch (e) {
    sendJson(res, 200, { ok: false, app, reason: '启动 ' + APP_NAME[app] + ' 失败（' + ((e && e.message) || e) + '），请手动打开它' });
    return;
  }
  sendJson(res, 200, { ok: true, app });
}

async function handleFcpxml(req, res, ctx) {
  const p = String(req.url || '').split('?')[0];
  try {
    if (p === '/fcpxml/bundle') { await handleBundle(req, res, ctx); return true; }
    if (p === '/fcpxml/import') { await handleImport(req, res, ctx); return true; }
    if (p === '/fcpxml/reveal') { await handleReveal(req, res, ctx); return true; }
    if (p === '/fcpxml/launch') { await handleLaunch(req, res, ctx); return true; }
    sendJson(res, 404, { error: '未知的 FCPXML 路由：' + p });
  } catch (e) {
    if (!res.headersSent) sendJson(res, Number(e && e.status) || 500, { error: (e && e.message) || '导出失败' });
  }
  return true;
}
module.exports = { handleFcpxml, IMPORT_ROOT, IMPORT_ID };
