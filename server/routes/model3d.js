/* 白膜库路由：模型文件（`<库根>\白膜\<组>\<名>.json` + 同名 `.png` 缩略图）
   与导入的 3D 文件（`<库根>\白膜\_模型文件\<名>.<ext>`）。

   为什么模型是**真文件**而不是浏览器里的一份 KV：它是用户的作品，得能翻到、能拷走、能放进仓库；
   库里那批产物的口径本来就是「本体住在库根，账另记」—— 模型更简单，连账都不用，文件名就是身份。

   身份：`id` = 相对 `白膜/` 的路径（`角色/少女` 或 `少女`）。列表、改名、移组、删除、缩略图
   全部围绕这一个字符串；解码之后必须仍落在 `白膜/` 根内（`absIn()` 一处判），否则 400。

   三个写入口都有闸：JSON 必须能 parse（不然盘上会留一个打不开的模型）、
   缩略图只收 `data:image/png`、导入文件只收 `.fbx/.obj/.glb/.gltf` 且 ≤ 80 MB。
   全部走 `atomicWrite`（tmp → fsync → rename），断电不会留下半个模型。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, fail } = require('./http');
const { atomicWrite, renameWithRetry } = require('../data-hub.js');

const DIR_NAME = '白膜';
const ASSET_DIR = '_模型文件';
const MODEL_EXT = '.json';
const THUMB_EXT = '.png';
const ASSET_EXT = new Set(['.fbx', '.obj', '.glb', '.gltf']);
const ASSET_MIME = {
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};
const MAX_ASSET = 80 * 1024 * 1024;
const NAME_MAX = 40;
const GROUP_MAX = 20;

/* 文件名片段：去掉路径分隔符与控制字符，保留中文（用户在资源管理器里要认得出）。
   与浏览器那一份（web/ui/ui.js 的 fileSafe）同算法 —— 这一份是 Node 侧的登记例外。 */
function safePart(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function createModel3dRoutes(ctx) {
  const readBody = ctx.readBody;
  const log = ctx.log || (() => {});
  const localRoot = ctx.localRoot;
  const baseDir = () => path.join(localRoot(), DIR_NAME);

  /* id → 绝对路径。带 `..`、绝对路径、空段的直接当非法；解析完必须还在根内。 */
  function absIn(id, opts = {}) {
    const raw = String(id == null ? '' : id).replace(/\\/g, '/');
    /* id 永远是「组/名」这种相对写法：绝对路径与盘符一律不收 */
    if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw)) return null;
    const s = raw;
    if (s.indexOf('\u0000') >= 0 || s.split('/').some(seg => seg === '..' || seg === '.')) return null;
    const parts = s.split('/').filter(Boolean);
    if (parts.length > 2) return null;
    let abs = path.resolve(baseDir(), ...parts);
    const root = path.resolve(baseDir());
    /* `id` 是「组/名」（不带扩展名）：读 / 缩略图 / 删除都按调用方声明的扩展名补齐 */
    if (opts.ext && !abs.toLowerCase().endsWith(opts.ext)) abs += opts.ext;
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    if (opts.modelOnly) {
      if (!abs.toLowerCase().endsWith(MODEL_EXT)) return null;
      if (opts.ext !== MODEL_EXT) return null;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (rel.split('/')[0] === ASSET_DIR) return null;      // `_模型文件/` 只放导入件
    }
    if (opts.assetOnly) {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (rel.split('/')[0] !== ASSET_DIR) return null;
      if (!ASSET_EXT.has(path.extname(abs).toLowerCase())) return null;
    }
    return abs;
  }

  function relIdOf(abs) {
    return path.relative(path.resolve(baseDir()), abs).replace(/\\/g, '/').replace(/\.json$/i, '');
  }

  /* 列表：现读盘（模型文件不多，整趟扫一遍比维护索引简单可靠） */
  function scanLibrary() {
    const root = baseDir();
    const groups = [];
    const models = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { dirs = []; }
    const pushModel = (absJson, group) => {
      let st = null;
      try { st = fs.statSync(absJson); } catch (e) { return; }
      if (!st.isFile()) return;
      const name = path.basename(absJson, MODEL_EXT);
      const thumbAbs = absJson.replace(/\.json$/i, THUMB_EXT);
      models.push({
        id: (group ? group + '/' : '') + name,
        name, group,
        when: st.mtimeMs,
        bytes: st.size,
        thumb: fs.existsSync(thumbAbs),
      });
    };
    for (const ent of dirs) {
      if (!ent.isDirectory()) {
        if (ent.isFile() && ent.name.toLowerCase().endsWith(MODEL_EXT)) pushModel(path.join(root, ent.name), '');
        continue;
      }
      if (ent.name === ASSET_DIR) continue;
      const gdir = path.join(root, ent.name);
      let count = 0;
      for (const f of fs.readdirSync(gdir)) {
        if (!f.toLowerCase().endsWith(MODEL_EXT)) continue;
        pushModel(path.join(gdir, f), ent.name);
        count += 1;
      }
      groups.push({ name: ent.name, count });
    }
    models.sort((a, b) => b.when - a.when);
    return { dir: root, groups: groups.sort((a, b) => a.name.localeCompare(b.name, 'zh')), models };
  }

  function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
  }

  function handleSave(req, res, urlObj) {
    readBody(req, res, 8 * 1024 * 1024).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const name = safePart(spec.name, NAME_MAX);
      const group = safePart(spec.group, GROUP_MAX);
      if (!name) return fail(res, 400, '模型名不能为空');
      if (group && group.startsWith('_')) return fail(res, 400, group + ' 是保留名（下划线开头的目录留给导入的 3D 文件）');
      let model = spec.model;
      if (typeof model === 'string') {
        try { model = JSON.parse(model); } catch (e) { return fail(res, 400, 'model 不是合法 JSON'); }
      }
      if (!model || typeof model !== 'object') return fail(res, 400, '缺少 model');
      /* 落盘前把身份写回文件里：模型自己带着「我是谁」，拷到别的机器上也认得出 */
      model.name = name;
      model.group = group;
      model.ts = Date.now();

      const root = baseDir();
      const dir = group ? path.join(root, group) : root;
      const dst = path.join(dir, name + MODEL_EXT);
      ensureDir(dir);

      const prevId = spec.id ? absIn(spec.id, { modelOnly: true, ext: MODEL_EXT }) : null;
      if (spec.id && !prevId) return fail(res, 400, 'id 非法：' + spec.id);
      if (prevId && path.resolve(prevId) !== path.resolve(dst)) {
        /* 「另存为 / 改名 / 移组」：先把旧文件挪走（挪不动就中止，绝不把两份写成一份） */
        try { renameWithRetry(prevId, dst); } catch (e) {
          return fail(res, 500, '旧文件挪不过去（' + (e.code || '') + '）：' + String(e.message || e));
        }
        /* 缩略图跟着走：改名之后列表里不该突然只剩一个空盒子 */
        const oldThumb = prevId.replace(/\.json$/i, THUMB_EXT);
        const newThumb = dst.replace(/\.json$/i, THUMB_EXT);
        try {
          if (fs.existsSync(oldThumb)) renameWithRetry(oldThumb, newThumb);
        } catch (e) {
          try { fs.rmSync(oldThumb, { force: true }); } catch (err) { /* 挪不动又删不掉：留着不影响新那份 */ }
        }
        /* 旧组目录空了就收掉：用户移走最后一个模型之后，资源管理器里不该留一个空文件夹 */
        const oldDir = path.dirname(prevId);
        if (path.resolve(oldDir) !== path.resolve(baseDir())) {
          try { if (!fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir); } catch (e) { log('[model3d] 空组目录没收掉：' + e.message); }
        }
      }
      atomicWrite(dst, JSON.stringify(model, null, 2));

      const thumb = String(spec.thumb || '');
      const thumbDst = dst.replace(/\.json$/i, THUMB_EXT);
      if (/^data:image\/png;base64,/.test(thumb)) {
        try {
          const buf = Buffer.from(thumb.slice(thumb.indexOf(',') + 1), 'base64');
          if (buf.length && buf.length <= 2 * 1024 * 1024) atomicWrite(thumbDst, buf);
        } catch (e) { log('[model3d] 缩略图没写进去：' + e.message); }
      }
      const id = relIdOf(dst);
      sendJson(res, 200, { ok: true, id, name, group, dir: path.dirname(dst) });
    }).catch(e => fail(res, 500, '保存失败：' + String(e.message || e)));
  }

  function handleAssetUpload(req, res, urlObj) {
    const raw = String(urlObj.searchParams.get('name') || '');
    const name = safePart(path.basename(raw).replace(/\.[^.]+$/, ''), NAME_MAX)
      + path.extname(raw).toLowerCase();
    if (!ASSET_EXT.has(path.extname(name).toLowerCase())) {
      return fail(res, 400, '只收 ' + Array.from(ASSET_EXT).join(' / ') + ' 这几种 3D 文件');
    }
    readBody(req, res, MAX_ASSET).then(buf => {
      if (buf == null) return;
      if (!buf.length) return fail(res, 400, '文件是空的');
      const dir = path.join(baseDir(), ASSET_DIR);
      ensureDir(dir);
      let dst = path.join(dir, name);
      /* 重名不覆盖：加 -2 / -3（用户拖同一份文件两次是常事，覆盖会悄悄改掉别人的模型引用） */
      if (fs.existsSync(dst)) {
        const stem = path.basename(name, path.extname(name));
        let n = 2;
        while (fs.existsSync(dst) && n < 100) { dst = path.join(dir, stem + '-' + n + path.extname(name)); n += 1; }
      }
      try { atomicWrite(dst, buf); } catch (e) { return fail(res, 500, '写盘失败：' + String(e.message || e)); }
      const rel = path.relative(baseDir(), dst).replace(/\\/g, '/');
      sendJson(res, 200, { ok: true, file: rel, bytes: buf.length, name: path.basename(dst) });
    }).catch(e => fail(res, 500, '导入失败：' + String(e.message || e)));
  }

  function handleDelete(req, res) {
    readBody(req, res, 64 * 1024).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const abs = absIn(spec.id, { modelOnly: true, ext: MODEL_EXT });
      if (!abs) return fail(res, 400, 'id 非法：' + spec.id);
      try {
        fs.rmSync(abs, { force: true });
        const th = abs.replace(/\.json$/i, THUMB_EXT);
        if (fs.existsSync(th)) fs.rmSync(th, { force: true });
        /* 组目录空了就一并收掉：用户删掉一组最后一个模型后，不该在资源管理器里看到一个空文件夹 */
        const dir = path.dirname(abs);
        if (path.resolve(dir) !== path.resolve(baseDir())) {
          try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (e) { log('[model3d] 空组目录没删掉：' + e.message); }
        }
      } catch (e) { return fail(res, 500, '删除失败：' + String(e.message || e)); }
      sendJson(res, 200, { ok: true, id: spec.id });
    }).catch(e => fail(res, 500, '删除失败：' + String(e.message || e)));
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

    if (!sub && req.method === 'GET') {
      try { sendJson(res, 200, scanLibrary()); } catch (e) { fail(res, 500, '列不出来：' + String(e.message || e)); }
      return true;
    }
    if (sub === 'file' && req.method === 'GET') {
      const id = String(urlObj.searchParams.get('id') || '');
      const abs = absIn(id, { modelOnly: true, ext: MODEL_EXT });
      if (!abs) { fail(res, 400, 'id 非法'); return true; }
      sendFile(res, abs, 'application/json; charset=utf-8', 'model');
      return true;
    }
    if (sub === 'thumb' && req.method === 'GET') {
      const id = String(urlObj.searchParams.get('id') || '');
      const abs = absIn(id, { modelOnly: true, ext: MODEL_EXT });
      if (!abs) { fail(res, 400, 'id 非法'); return true; }
      sendFile(res, abs.replace(/\.json$/i, THUMB_EXT), 'image/png', 'thumb');
      return true;
    }
    if (sub === 'asset' && req.method === 'GET') {
      const name = String(urlObj.searchParams.get('name') || '');
      const abs = absIn(name, { assetOnly: true });
      if (!abs) { fail(res, 400, '文件名非法'); return true; }
      const mime = ASSET_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      sendFile(res, abs, mime, 'asset');
      return true;
    }
    if (sub === 'asset' && req.method === 'POST') { handleAssetUpload(req, res, urlObj); return true; }
    if (sub === 'save' && req.method === 'POST') { handleSave(req, res, urlObj); return true; }
    if (sub === 'delete' && req.method === 'POST') { handleDelete(req, res); return true; }
    fail(res, 404, '不认识的 model3d 路径：' + p);
    return true;
  }

  return { handleModel3d, scanLibrary };
}

module.exports = { createModel3dRoutes, DIR_NAME: DIR_NAME };
