/* 白膜库路由：多库布局。
   <库根>/白膜/<白模库>/
     模型/<模型>.json + .png
     模型/<旧组>/<模型>.json + .png
     场景/<场景组>/<场景>.json + .png
     _模型文件/<file>

   白模库 = 一个系列的实体模板集合；场景是用户使用实体的地方。
   旧布局（白膜/<组>/<模型>.json、白膜/<模型>.json、白膜/_模型文件）在第一次扫描时
   一次性迁进 `默认库/模型/` 与 `默认库/_模型文件/`，组目录原样保留，旧 ref 的 `组/名` 不会断。

   路径只收库内相对 id；`..`、绝对路径、盘符、越界解析一律 400。
   文件名长度、请求体大小不设人为上限：3D 文件边收边写临时文件，长度 / 容量由文件系统与磁盘报错。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, fail } = require('./http');
const { atomicWrite, renameWithRetry } = require('../data-hub.js');

const DIR_NAME = '白膜';
const DEFAULT_LIBRARY = '默认库';
const ASSET_DIR = '_模型文件';
const MODEL_SUB = '模型';
const SCENE_SUB = '场景';
const TRASH_DIR = '.trash';
const MODEL_EXT = '.json';
const THUMB_EXT = '.png';
const ASSET_EXT = new Set(['.fbx', '.obj', '.glb', '.gltf']);
const ASSET_MIME = {
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function safePart(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 请求体按流写到临时文件：3D 文件不设字节上限，也不把整份读进内存。
   用 data / end 事件而不是 stream.pipeline：路由冒烟里的假 req 只是一个 EventEmitter。 */
function streamToFile(req, dst) {
  return new Promise((resolve, reject) => {
    const tmp = dst + '.' + process.pid + '.part';
    const out = fs.createWriteStream(tmp);
    let done = false;
    const abortStream = err => {
      if (done) return;
      done = true;
      try { out.destroy(); } catch (e) { /* 流已经关掉 */ }
      try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 临时文件删不掉不影响主错误 */ }
      reject(err);
    };
    req.on('error', abortStream);
    req.on('aborted', () => abortStream(new Error('上传被中断')));
    out.on('error', abortStream);
    req.on('data', chunk => {
      if (done) return;
      if (!out.write(chunk)) {
        if (typeof req.pause === 'function') req.pause();
        out.once('drain', () => { if (typeof req.resume === 'function') req.resume(); });
      }
    });
    req.on('end', () => {
      if (done) return;
      out.end(() => {
        if (done) return;
        try { renameWithRetry(tmp, dst); done = true; resolve(); } catch (e) { abortStream(e); }
      });
    });
  });
}

function createModel3dRoutes(ctx) {
  const readBody = ctx.readBody;
  const log = ctx.log || (() => {});
  const localRoot = ctx.localRoot;
  const baseDir = () => path.join(localRoot(), DIR_NAME);
  const trashDir = () => path.join(baseDir(), TRASH_DIR);

  function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
  }

  function safeLibrary(raw) {
    const id = safePart(raw);
    if (!id || id === TRASH_DIR || id.startsWith('_')) return '';
    return id;
  }

  function libraryDir(raw) {
    const id = safeLibrary(raw);
    if (!id) return null;
    return path.join(baseDir(), id);
  }

  function kindRoot(library, kind) {
    const dir = libraryDir(library);
    if (!dir) return null;
    return path.join(dir, kind === 'scene' ? SCENE_SUB : MODEL_SUB);
  }

  function assetsRoot(library) {
    const dir = libraryDir(library);
    return dir ? path.join(dir, ASSET_DIR) : null;
  }

  function moveInto(src, dstDir) {
    ensureDir(dstDir);
    let dst = path.join(dstDir, path.basename(src));
    let n = 2;
    while (fs.existsSync(dst)) {
      const ext = path.extname(dst);
      const stem = path.basename(dst, ext);
      dst = path.join(dstDir, stem + '-' + n + ext);
      n += 1;
    }
    renameWithRetry(src, dst);
  }

  /* 旧布局 → 默认库。只在默认库还不存在时跑一次。 */
  function ensureLayout() {
    const root = baseDir();
    ensureDir(root);
    if (fs.existsSync(path.join(root, DEFAULT_LIBRARY))) return;
    const lib = path.join(root, DEFAULT_LIBRARY);
    ensureDir(path.join(lib, MODEL_SUB));
    ensureDir(path.join(lib, SCENE_SUB));
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { entries = []; }
    for (const ent of entries) {
      if (ent.name === DEFAULT_LIBRARY || ent.name === TRASH_DIR) continue;
      const src = path.join(root, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ASSET_DIR) moveInto(src, lib);
        else moveInto(src, path.join(lib, MODEL_SUB));
      } else if (ent.isFile()) {
        moveInto(src, path.join(lib, MODEL_SUB));
      }
    }
  }

  function scenarioDirs(library) {
    const models = kindRoot(library, 'model');
    const scenes = kindRoot(library, 'scene');
    if (!models || !scenes) return null;
    ensureDir(models);
    ensureDir(scenes);
    return { models, scenes, assets: assetsRoot(library) };
  }

  /* id → 绝对路径。id 只收「名」或「组/名」。 */
  function absIn(library, kind, id, opts = {}) {
    const dirs = scenarioDirs(library);
    if (!dirs) return null;
    const raw = String(id == null ? '' : id).replace(/\\/g, '/');
    if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw)) return null;
    if (raw.indexOf('\u0000') >= 0 || raw.split('/').some(seg => seg === '..' || seg === '.')) return null;
    const parts = raw.split('/').filter(Boolean);
    if (parts.length > 2) return null;
    const root = kind === 'scene' ? dirs.scenes : dirs.models;
    let abs = path.resolve(root, ...parts);
    if (opts.ext && !abs.toLowerCase().endsWith(opts.ext)) abs += opts.ext;
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  function absAsset(library, name) {
    const dirs = scenarioDirs(library);
    if (!dirs) return null;
    const raw = String(name == null ? '' : name).replace(/\\/g, '/');
    if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw)) return null;
    if (raw.indexOf('\u0000') >= 0 || raw.split('/').some(seg => seg === '..' || seg === '.')) return null;
    const parts = raw.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== ASSET_DIR) return null;
    const abs = path.resolve(dirs.assets, parts[1]);
    if (!abs.startsWith(path.resolve(dirs.assets) + path.sep)) return null;
    if (!ASSET_EXT.has(path.extname(abs).toLowerCase())) return null;
    return abs;
  }

  function relIdOf(library, kind, abs) {
    const root = kindRoot(library, kind);
    return root ? path.relative(root, abs).replace(/\\/g, '/').replace(/\.json$/i, '') : '';
  }

  function scanKind(root, ext) {
    const rows = [];
    const groups = new Map();
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { dirs = []; }
    const pushRow = (absJson, group) => {
      let st = null;
      try { st = fs.statSync(absJson); } catch (e) { return; }
      if (!st.isFile()) return;
      const name = path.basename(absJson, ext);
      rows.push({
        id: (group ? group + '/' : '') + name,
        name, group,
        when: st.mtimeMs,
        bytes: st.size,
        thumb: fs.existsSync(absJson.replace(/\.json$/i, THUMB_EXT)),
      });
    };
    for (const ent of dirs) {
      if (!ent.isDirectory()) {
        if (ent.isFile() && ent.name.toLowerCase().endsWith(MODEL_EXT)) pushRow(path.join(root, ent.name), '');
        continue;
      }
      const gdir = path.join(root, ent.name);
      let count = 0;
      let files = [];
      try { files = fs.readdirSync(gdir); } catch (e) { files = []; }
      for (const f of files) {
        if (!f.toLowerCase().endsWith(MODEL_EXT)) continue;
        pushRow(path.join(gdir, f), ent.name);
        count += 1;
      }
      groups.set(ent.name, count);
    }
    rows.sort((a, b) => b.when - a.when);
    return {
      rows,
      groups: Array.from(groups, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    };
  }

  function scanLibrary(libraryId) {
    ensureLayout();
    const root = baseDir();
    const libraries = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { dirs = []; }
    for (const ent of dirs) {
      if (!ent.isDirectory() || ent.name === TRASH_DIR || ent.name.startsWith('_')) continue;
      const id = safeLibrary(ent.name);
      if (!id) continue;
      const m = scanKind(path.join(root, id, MODEL_SUB), MODEL_EXT);
      const s = scanKind(path.join(root, id, SCENE_SUB), MODEL_EXT);
      libraries.push({ id, name: id, models: m.rows.length, scenes: s.rows.length });
    }
    libraries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const id = safeLibrary(libraryId) || (libraries[0] && libraries[0].id) || '';
    if (!id) {
      return { dir: root, library: '', libraries, groups: [], models: [], sceneGroups: [], scenes: [] };
    }
    const models = scanKind(path.join(root, id, MODEL_SUB), MODEL_EXT);
    const scenes = scanKind(path.join(root, id, SCENE_SUB), MODEL_EXT);
    return {
      dir: path.join(root, id),
      library: id,
      libraries,
      groups: models.groups,
      models: models.rows,
      sceneGroups: scenes.groups,
      scenes: scenes.rows,
    };
  }

  function handleSave(req, res) {
    readBody(req, res, Infinity).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const library = safeLibrary(spec.library);
      const kind = spec.kind === 'scene' ? 'scene' : 'model';
      if (!library) return fail(res, 400, '缺少白模库');
      const dirs = scenarioDirs(library);
      if (!dirs) return fail(res, 400, '白模库不存在：' + library);
      const name = safePart(spec.name);
      const group = safePart(spec.group);
      if (!name) return fail(res, 400, '名字不能为空');
      if (group && group.startsWith('_')) return fail(res, 400, group + ' 是保留名');
      let doc = spec.model;
      if (typeof doc === 'string') {
        try { doc = JSON.parse(doc); } catch (e) { return fail(res, 400, 'model 不是合法 JSON'); }
      }
      if (!doc || typeof doc !== 'object') return fail(res, 400, '缺少 model');
      doc.kind = kind;
      doc.name = name;
      doc.group = group;
      doc.ts = Date.now();
      const root = kind === 'scene' ? dirs.scenes : dirs.models;
      const dir = group ? path.join(root, group) : root;
      const dst = path.join(dir, name + MODEL_EXT);
      ensureDir(dir);
      const prevId = spec.id ? String(spec.id) : '';
      const prev = prevId ? absIn(library, kind, prevId, { ext: MODEL_EXT }) : null;
      if (prevId && !prev) return fail(res, 400, 'id 非法：' + prevId);
      if (prev && path.resolve(prev) !== path.resolve(dst)) {
        try { renameWithRetry(prev, dst); } catch (e) {
          return fail(res, 500, '旧文件挪不过去（' + (e.code || '') + '）：' + String(e.message || e));
        }
        const oldThumb = prev.replace(/\.json$/i, THUMB_EXT);
        const newThumb = dst.replace(/\.json$/i, THUMB_EXT);
        try { if (fs.existsSync(oldThumb)) renameWithRetry(oldThumb, newThumb); } catch (e) {
          try { fs.rmSync(oldThumb, { force: true }); } catch (err) { /* 旧缩略图挪不动就删掉 */ }
        }
        const oldDir = path.dirname(prev);
        if (path.resolve(oldDir) !== path.resolve(root)) {
          try { if (!fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir); } catch (e) { /* 空组目录收不掉不影响保存 */ }
        }
      }
      atomicWrite(dst, JSON.stringify(doc, null, 2));
      const thumb = String(spec.thumb || '');
      const thumbDst = dst.replace(/\.json$/i, THUMB_EXT);
      if (/^data:image\/png;base64,/.test(thumb)) {
        try {
          const buf = Buffer.from(thumb.slice(thumb.indexOf(',') + 1), 'base64');
          if (buf.length) atomicWrite(thumbDst, buf);
        } catch (e) { log('[model3d] 缩略图没写进去：' + e.message); }
      }
      sendJson(res, 200, {
        ok: true, library, kind, id: relIdOf(library, kind, dst), name, group, dir: path.dirname(dst),
      });
    }).catch(e => fail(res, 500, '保存失败：' + String(e.message || e)));
  }

  function handleDelete(req, res) {
    readBody(req, res, Infinity).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const library = safeLibrary(spec.library);
      const kind = spec.kind === 'scene' ? 'scene' : 'model';
      const abs = absIn(library, kind, spec.id, { ext: MODEL_EXT });
      if (!abs) return fail(res, 400, 'id 非法：' + spec.id);
      try {
        fs.rmSync(abs, { force: true });
        const th = abs.replace(/\.json$/i, THUMB_EXT);
        if (fs.existsSync(th)) fs.rmSync(th, { force: true });
        const root = kindRoot(library, kind);
        const dir = path.dirname(abs);
        if (root && path.resolve(dir) !== path.resolve(root)) {
          try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (e) { /* 空组目录删不掉不影响 */ }
        }
      } catch (e) { return fail(res, 500, '删除失败：' + String(e.message || e)); }
      sendJson(res, 200, { ok: true, library, kind, id: spec.id });
    }).catch(e => fail(res, 500, '删除失败：' + String(e.message || e)));
  }

  function handleAssetUpload(req, res, urlObj) {
    const library = safeLibrary(urlObj.searchParams.get('library'));
    const dirs = scenarioDirs(library);
    if (!dirs) return fail(res, 400, '白模库不存在');
    const raw = String(urlObj.searchParams.get('name') || '');
    const name = safePart(path.basename(raw).replace(/\.[^.]+$/, '')) + path.extname(raw).toLowerCase();
    if (!ASSET_EXT.has(path.extname(name).toLowerCase())) {
      return fail(res, 400, '只收 ' + Array.from(ASSET_EXT).join(' / ') + ' 这几种 3D 文件');
    }
    ensureDir(dirs.assets);
    let dst = path.join(dirs.assets, name);
    if (fs.existsSync(dst)) {
      const stem = path.basename(name, path.extname(name));
      let n = 2;
      while (fs.existsSync(dst)) { dst = path.join(dirs.assets, stem + '-' + n + path.extname(name)); n += 1; }
    }
    streamToFile(req, dst).then(() => {
      let bytes = 0;
      try { bytes = fs.statSync(dst).size; } catch (e) { bytes = 0; }
      if (!bytes) {
        try { fs.rmSync(dst, { force: true }); } catch (e) { /* 空文件删不掉 */ }
        return fail(res, 400, '文件是空的');
      }
      const rel = path.relative(dirs.assets, dst).replace(/\\/g, '/');
      sendJson(res, 200, { ok: true, library, file: ASSET_DIR + '/' + rel, bytes, name: path.basename(dst) });
    }).catch(e => fail(res, 500, '导入失败：' + String(e.message || e)));
  }

  function handleLibrarySave(req, res) {
    readBody(req, res, Infinity).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const name = safeLibrary(spec.name);
      if (!name) return fail(res, 400, '白模库名不能为空');
      const from = spec.id ? safeLibrary(spec.id) : '';
      if (spec.id && !from) return fail(res, 400, '旧白模库名非法');
      const dst = path.join(baseDir(), name);
      if (from) {
        const src = path.join(baseDir(), from);
        if (!fs.existsSync(src)) return fail(res, 404, '白模库不存在：' + from);
        if (path.resolve(src) === path.resolve(dst)) return sendJson(res, 200, { ok: true, id: name, name });
        if (fs.existsSync(dst)) return fail(res, 409, '白模库已存在：' + name);
        try { renameWithRetry(src, dst); } catch (e) { return fail(res, 500, '改名失败：' + String(e.message || e)); }
      } else {
        if (fs.existsSync(dst)) return fail(res, 409, '白模库已存在：' + name);
        ensureDir(path.join(dst, MODEL_SUB));
        ensureDir(path.join(dst, SCENE_SUB));
      }
      sendJson(res, 200, { ok: true, id: name, name });
    }).catch(e => fail(res, 500, '白模库保存失败：' + String(e.message || e)));
  }

  function handleLibraryDelete(req, res) {
    readBody(req, res, Infinity).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const id = safeLibrary(spec.id);
      if (!id) return fail(res, 400, '白模库名非法');
      const src = path.join(baseDir(), id);
      if (!fs.existsSync(src)) return fail(res, 404, '白模库不存在：' + id);
      const trash = trashDir();
      ensureDir(trash);
      let dst = path.join(trash, id + '-' + Date.now());
      try { renameWithRetry(src, dst); } catch (e) { return fail(res, 500, '删除失败：' + String(e.message || e)); }
      sendJson(res, 200, { ok: true, id, movedTo: dst });
    }).catch(e => fail(res, 500, '删除失败：' + String(e.message || e)));
  }

  /* 场景组 / 模型组共用一份：建目录、整组改名（回写每份 doc.group）、
     删组（组里的文件退回未分组，真正删掉组目录）。 */
  function handleGroup(req, res, mode, kind) {
    readBody(req, res, Infinity).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const library = safeLibrary(spec.library);
      const dirs = scenarioDirs(library);
      if (!dirs) return fail(res, 400, '白模库不存在');
      const isScene = kind === 'scene';
      const root = isScene ? dirs.scenes : dirs.models;
      const label = isScene ? '场景组' : '模型组';
      if (mode === 'create') {
        const name = safePart(spec.name);
        if (!name) return fail(res, 400, label + '名不能为空');
        const dir = path.join(root, name);
        if (!dir.startsWith(root + path.sep)) return fail(res, 400, label + '名非法');
        if (fs.existsSync(dir)) return fail(res, 409, label + '已存在：' + name);
        ensureDir(dir);
        return sendJson(res, 200, { ok: true, library, name });
      }
      const from = safePart(spec.from);
      const to = safePart(spec.to);
      if (!from) return fail(res, 400, '缺少' + label + '名');
      const src = path.join(root, from);
      if (!src.startsWith(root + path.sep) || !fs.existsSync(src)) return fail(res, 404, label + '不存在：' + from);
      if (mode === 'rename') {
        if (!to) return fail(res, 400, '新' + label + '名不能为空');
        const dst = path.join(root, to);
        if (fs.existsSync(dst)) return fail(res, 409, label + '已存在：' + to);
        try { renameWithRetry(src, dst); } catch (e) { return fail(res, 500, '改名失败：' + String(e.message || e)); }
        for (const f of fs.readdirSync(dst)) {
          if (!f.toLowerCase().endsWith(MODEL_EXT)) continue;
          const abs = path.join(dst, f);
          try {
            const doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
            doc.group = to;
            atomicWrite(abs, JSON.stringify(doc, null, 2));
          } catch (e) { log('[model3d] ' + label + '改名后回写失败：' + f); }
        }
        return sendJson(res, 200, { ok: true, library, from, to });
      }
      /* 删组：组里的文件不删，全部落到未分组。 */
      ensureDir(root);
      for (const f of fs.readdirSync(src)) {
        if (!f.toLowerCase().endsWith(MODEL_EXT)) continue;
        let dst = path.join(root, f);
        let n = 2;
        while (fs.existsSync(dst)) {
          const ext = path.extname(dst);
          dst = path.join(root, path.basename(f, ext) + '-' + n + ext);
          n += 1;
        }
        renameWithRetry(path.join(src, f), dst);
        const th = path.join(src, f.replace(/\.json$/i, THUMB_EXT));
        if (fs.existsSync(th)) {
          try { renameWithRetry(th, dst.replace(/\.json$/i, THUMB_EXT)); } catch (e) { /* 缩略图丢了不影响正文 */ }
        }
        try {
          const doc = JSON.parse(fs.readFileSync(dst, 'utf8'));
          doc.group = '';
          atomicWrite(dst, JSON.stringify(doc, null, 2));
        } catch (e) { log('[model3d] ' + label + '删除后回写失败：' + f); }
      }
      try { if (!fs.readdirSync(src).length) fs.rmdirSync(src); } catch (e) { /* 空组目录收不掉不影响 */ }
      sendJson(res, 200, { ok: true, library, from, moved: true });
    }).catch(e => fail(res, 500, (kind === 'scene' ? '场景组' : '模型组') + '操作失败：' + String(e.message || e)));
  }

  function sendFile(res, abs, mime, tag) {
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { return fail(res, 404, '没有这个文件'); }
    if (!st.isFile()) return fail(res, 404, '不是一个文件');
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '-' + tag + '"';
    if (res.req && res.req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  }

  function handleModel3d(req, res, urlObj) {
    const p = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (p !== '/model3d' && !p.startsWith('/model3d/')) return false;
    const sub = p === '/model3d' ? '' : p.slice('/model3d/'.length);
    const q = urlObj.searchParams;

    if (!sub && req.method === 'GET') {
      try { sendJson(res, 200, scanLibrary(q.get('library'))); } catch (e) { fail(res, 500, '列不出来：' + String(e.message || e)); }
      return true;
    }
    if (sub === 'file' && req.method === 'GET') {
      const library = q.get('library');
      const kind = q.get('kind') === 'scene' ? 'scene' : 'model';
      const abs = absIn(library, kind, q.get('id'), { ext: MODEL_EXT });
      if (!abs) { fail(res, 400, 'id 非法'); return true; }
      sendFile(res, abs, 'application/json; charset=utf-8', kind);
      return true;
    }
    if (sub === 'thumb' && req.method === 'GET') {
      const library = q.get('library');
      const kind = q.get('kind') === 'scene' ? 'scene' : 'model';
      const abs = absIn(library, kind, q.get('id'), { ext: MODEL_EXT });
      if (!abs) { fail(res, 400, 'id 非法'); return true; }
      sendFile(res, abs.replace(/\.json$/i, THUMB_EXT), 'image/png', 'thumb-' + kind);
      return true;
    }
    if (sub === 'asset' && req.method === 'GET') {
      const abs = absAsset(q.get('library'), q.get('name'));
      if (!abs) { fail(res, 400, '文件名非法'); return true; }
      const mime = ASSET_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      sendFile(res, abs, mime, 'asset');
      return true;
    }
    if (sub === 'asset' && req.method === 'POST') { handleAssetUpload(req, res, urlObj); return true; }
    if (sub === 'save' && req.method === 'POST') { handleSave(req, res); return true; }
    if (sub === 'delete' && req.method === 'POST') { handleDelete(req, res); return true; }
    if (sub === 'library/save' && req.method === 'POST') { handleLibrarySave(req, res); return true; }
    if (sub === 'library/delete' && req.method === 'POST') { handleLibraryDelete(req, res); return true; }
    if (sub === 'scene-group/create' && req.method === 'POST') { handleGroup(req, res, 'create', 'scene'); return true; }
    if (sub === 'scene-group/rename' && req.method === 'POST') { handleGroup(req, res, 'rename', 'scene'); return true; }
    if (sub === 'scene-group/delete' && req.method === 'POST') { handleGroup(req, res, 'delete', 'scene'); return true; }
    if (sub === 'model-group/create' && req.method === 'POST') { handleGroup(req, res, 'create', 'model'); return true; }
    if (sub === 'model-group/rename' && req.method === 'POST') { handleGroup(req, res, 'rename', 'model'); return true; }
    if (sub === 'model-group/delete' && req.method === 'POST') { handleGroup(req, res, 'delete', 'model'); return true; }
    fail(res, 404, '不认识的 model3d 路径：' + p);
    return true;
  }

  try { ensureLayout(); } catch (e) { log('[model3d] 旧布局迁移失败：' + String(e.message || e)); }

  return { handleModel3d, scanLibrary, ensureLayout };
}

module.exports = { createModel3dRoutes, DIR_NAME, DEFAULT_LIBRARY };
