/* 提示词归档：目录校验、front matter、索引重建、/prompts 路由、云端文件清单。
   目录 root 注入；fileSafe / dirStamp / timeText / readBody / localAssetEntry 由 app 注入。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fs-atomic');
const userDirs = require('./user-dirs.js');

function createPromptsStore(opts) {
  const root = opts.root;
  const log = opts.log || (() => {});
  const readBody = opts.readBody;
  const localAssetEntry = opts.localAssetEntry;
  const fileSafe = opts.fileSafe;
  const dirStamp = opts.dirStamp;
  const timeText = opts.timeText;
  const PROMPT_INDEX = '_index.json';
  const PROMPT_PACK_MAX_FILES = 20000, PROMPT_PACK_MAX_BYTES = 64 * 1024 * 1024;

  /* 归档默认目录 = 下载\成像\提示词（与产物本体共用「下载\成像」这一个根，根下按类别分子目录）。
     PROMPTS_DIR 环境变量仍优先（部署口子，不是版本兼容）。
     ⚠ 只认这一个目录 —— 项目内的老 prompts/ 已经搬走并且不存在了，不做双读。 */
  const promptsDefaultDir = () => process.env.PROMPTS_DIR
    ? path.resolve(root, process.env.PROMPTS_DIR)
    : path.resolve(userDirs.promptsRoot());
  function promptsDir(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return promptsDefaultDir();
    if (s.indexOf(String.fromCharCode(0)) >= 0) throw new Error('目录里有非法字符');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const p = (/^~($|[\\/])/.test(s) && home) ? path.join(home, s.slice(1)) : s;
    const abs = path.resolve(p);
    /* 白名单：项目目录 / 用户目录 / 下载根（成像那一族的家）——
       下载被搬到 D:\下载 时不在 home 之下，不加这一支默认目录自己都进不了白名单。 */
    const roots = [path.resolve(root), path.resolve(userDirs.downloadsRoot())];
    if (home) roots.push(path.resolve(home));
    const inside = roots.some(r => abs === r || abs.startsWith(r + path.sep));
    if (!inside) throw new Error('提示词目录只能在项目目录、下载目录或用户目录之下：' + abs);
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
        json(200, { ok: true, id, matched: 1, local: true, provider: (it && it.provider) || '',
          file: (it && it.file) || '', title: (it && it.name) || '', type: 'local', prompt: (it && it.prompt) || '', all: [] });
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
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      try {
        fs.mkdirSync(dir, { recursive: true });
        require('child_process').spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
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
  return { promptsDefaultDir, promptsDir, promptCloudDir, promptFileList, promptRows, handlePrompts, parseFrontMatter };
}
module.exports = { createPromptsStore };
