/* FCPXML 媒体包：POST /fcpxml/bundle { fcpxml, srt?, assets:[{src,name}] }
   写 RENDER_DIR/fcpxml-<stamp>-<随机后缀>/project.fcpxml + media/* + subtitles.srt（有字幕时）+ missing.txt，并回 zip。
   素材只按 /asset/<id>、/getv?url=<公网 https> 或本机静态文件解析；取不到写清单，不静默丢段。
   体量闸：单条 FCPXML_MAX_ASSET_MB（默认 512）、整包 FCPXML_MAX_BUNDLE_MB（默认 2048），
   超出的进 missing.txt 并写明是哪一条 —— zip 写入器不支持 ZIP64，且打包全在内存里。
   字幕只写到固定名字 subtitles.srt，与缺失素材清单分开：字幕写不下去就整包失败（500），
   不允许「用户以为带了字幕、包里却没有」。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createZip } = require('../zip.js');
const { renameWithRetry } = require('../fs-atomic.js');

/* 媒体名怎么洗只有 app.js 注入的那一份 `fileSafe`（与 /save、/render、提示词归档同一条规则）：
   这里不再写第二份非法字符表 —— 以前包内用 safeName、归档用 fileSafe，
   同一份产物在两处名字不一样，对着 missing.txt 找素材时对不上。
   长度档取 120：与导演台把素材存回本机那一份（engine.js 的 fileSafe(name, 120)）齐平，
   又留得下「-2」这类撞名后缀，不至于把 RENDER_DIR 下的整条路径顶到 Windows 上限。 */
const ASSET_NAME_MAX = 120;
function assetNameOf(fileSafe, raw, i) {
  const fallback = 'asset-' + (i + 1);
  return String(fileSafe(raw || fallback, ASSET_NAME_MAX) || fallback);
}
/* 素材在包里的唯一文件名。两条素材同名（从两个平台各导一份、或同一 id 递了两次）时，
   原来那句 copyFileSync 会**静默盖掉**前一条：zip 里少一段、missing.txt 也不记，
   而就算两个同名条目都进了 zip，解压出来是哪一段全看解压程序的脾气。 */
function uniqueAssetName(fileSafe, raw, i, used) {
  const base = assetNameOf(fileSafe, raw, i);
  const dot = base.lastIndexOf('.');
  let name = base, n = 2;
  while (used.has(name)) {
    name = (dot > 0 ? base.slice(0, dot) : base) + '-' + n + (dot > 0 ? base.slice(dot) : '');
    if (++n > 999) return '';
  }
  used.add(name);
  return name;
}
const MB = 1024 * 1024;
const fmtMb = b => (b / MB).toFixed(0) + ' MB';
function send(res, code, type, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
async function handleFcpxml(req, res, ctx) {
  const readJson = ctx.readJson;
  const fileSafe = ctx.fileSafe;          // 文件名清洗只有 app.js 那一份
  const log = ctx.log || (() => {});
  let body;
  try { body = await readJson(req, 32 * 1024 * 1024); }
  catch (e) { send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: (e && e.message) || '请求体读取失败' })); return true; }
  const xml = String((body && body.fcpxml) || '');
  if (!xml.trim()) { send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: '缺少 fcpxml' })); return true; }
  /* 一单几条：超出上限的那部分以前是被 slice 静默切掉的 —— zip 里没有、missing.txt 里也没有，
     用户以为素材齐了。现在照 §14.5 记数：一条不落、一条不闷。（体量闸在循环里那条判。） */
  const ASSETS_MAX = 500;
  const wantAssets = Array.isArray(body.assets) ? body.assets : [];
  const assets = wantAssets.slice(0, ASSETS_MAX);
  /* 字幕：与客户端 SRT 导出同一份文本（BOM + CRLF 由客户端决定），这里只验体量与条数。
     上限 5 MB / 5000 条在写盘之前判 —— 超了当场 400，一个目录都不建。 */
  const srt = typeof (body && body.srt) === 'string' ? body.srt : '';
  const srtUsed = !!srt.trim();
  if (srtUsed) {
    const bytes = Buffer.byteLength(srt, 'utf8');
    if (bytes > 5 * 1024 * 1024) {
      send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: '字幕超过 5 MB，媒体包没有生成（' + (bytes / 1048576).toFixed(1) + ' MB）' }));
      return true;
    }
    const n = srt.trim().split(/\r?\n\r?\n/).filter(b => b.includes('-->')).length;
    if (n > 5000) {
      send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: '字幕 ' + n + ' 条，超过媒体包上限 5000 条，没有生成' }));
      return true;
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  /* 目录名带随机后缀：两个请求落在同一秒里点「导出媒体包」，光按时间戳算会得出同一个
     `fcpxml-<stamp>`，于是第二单**往第一单已经写好的目录里盖** project.fcpxml，
     第一单的 zip 还没发完素材就被换掉 —— 两个包各混着另一半，而界面会说两次「导出成功」。
     撞了（同一秒 + 同一随机数，概率极低）就换一个再试，绝不复用已有目录。 */
  let dir = '';
  for (let i = 0; i < 20; i++) {
    const cand = path.join(ctx.renderDir, 'fcpxml-' + stamp + '-' + Math.random().toString(36).slice(2, 8));
    if (!fs.existsSync(cand)) { dir = cand; break; }
  }
  if (!dir) {
    send(res, 409, 'application/json; charset=utf-8', JSON.stringify({ error: '同一秒里媒体包目录名撞满了，稍后再导一次' }));
    return true;
  }
  const mediaDir = path.join(dir, 'media');
  /* 建目录 / 写工程文件失败要照实回一句，而不是让异常冒到最外层：
     RENDER_DIR 满盘（ENOSPC）或被别的程序占着（EBUSY/EPERM）时，
     用户需要的是「.renders 在哪、清一清或换到别的盘」，不是「导出失败」。 */
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.fcpxml'), xml);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    send(res, 500, 'application/json; charset=utf-8', JSON.stringify({
      error: '媒体包目录写不下去（' + (e && e.code ? e.code + ' ' : '') + ((e && e.message) || e) + '）：'
        + ctx.renderDir + ' 所在磁盘满或被占用，可在 .env 里把 RENDER_DIR 指到别的盘（改完要重启）',
    }));
    return true;
  }
  const files = [{ name: 'project.fcpxml', data: Buffer.from(xml) }];
  let srtBuf = null;
  if (srtUsed) {
    try {
      fs.writeFileSync(path.join(dir, 'subtitles.srt'), srt, 'utf8');
      srtBuf = Buffer.from(srt, 'utf8');
    } catch (e) {
      /* 字幕带不进包 = 这一单不成立：把刚建的目录整个删掉，
         而不是留下一个「用户以为带了字幕」的半截目录等着 pruneRenders 收。 */
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: '字幕写入失败：' + ((e && e.message) || e) }));
      return true;
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
  /* 已经落进包的字节：工程与字幕也占地方，从 0 起算会把上限整体让出这两块 */
  let packed = Buffer.byteLength(xml) + (srtBuf ? srtBuf.length : 0);
  let usedNames = new Set();
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
    if (budgetOut) {
      missing.push(assetNameOf(fileSafe, a.name, i) + '\t' + (a.src || '')
        + '\t整包已达上限 ' + fmtMb(maxTotalBytes) + '，这一条没有取（可分两单导出，或在 .env 里调大 FCPXML_MAX_BUNDLE_MB）');
      continue;
    }
    const name = uniqueAssetName(fileSafe, a.name, i, usedNames);
    if (!name) { missing.push('(同名超过 999 个)\t' + (a.src || '') + '\t素材名撞满，这一条没有取'); continue; }
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
     用户以为齐了 —— 按 §14.5「缺失一律报数」在这里补一行总数与名单（名单只列前 20 条，清单本身别撑爆）。 */
  if (wantAssets.length > assets.length) {
    const dropped = wantAssets.slice(ASSETS_MAX);
    const shown = dropped.slice(0, 20).map((a, j) => assetNameOf(fileSafe, a && a.name, ASSETS_MAX + j)).join('、');
    missing.push('(一单 ' + ASSETS_MAX + ' 条封顶)\t\t这一单递了 ' + wantAssets.length + ' 条，从第 ' + (ASSETS_MAX + 1)
      + ' 条起共 ' + dropped.length + ' 条没有打包：' + shown + (dropped.length > 20 ? ' 等' : '') + '（分两单导出）');
  }
  if (missing.length) files.push({ name: 'missing.txt', data: Buffer.from(missing.join('\n'), 'utf8') });
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
    send(res, 500, 'application/json; charset=utf-8', JSON.stringify({
      error: '媒体包打包/写入失败（' + (e && e.code ? e.code + ' ' : '') + ((e && e.message) || e) + '）：'
        + '这一单已经吃掉 ' + fmtMb(packed) + '，减少勾选的素材，'
        + '或在 .env 里把 RENDER_DIR 指到空间充足的盘（改完要重启）',
    }));
    return true;
  }
  log('[fcpxml] 媒体包：' + dir + '（'
    + (wantAssets.length === assets.length ? assets.length : wantAssets.length + ' 递来 / 只收 ' + assets.length)
    + ' 条，缺 ' + missing.length + ' 条，'
    + fmtMb(packed) + ' / 上限 ' + fmtMb(maxTotalBytes)
    + (srtBuf ? '，字幕 ' + Buffer.byteLength(srt, 'utf8') + ' 字节' : '，无字幕') + '）');
  send(res, 200, 'application/zip', zip, { 'Content-Disposition': 'attachment; filename="' + path.basename(dir) + '.zip"' });
  return true;
}
module.exports = { handleFcpxml };
