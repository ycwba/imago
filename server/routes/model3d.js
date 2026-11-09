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
   文件名长度、请求体大小不设人为上限：3D 文件边收边写临时文件，长度 / 容量由文件系统与磁盘报错。

   写盘只写非默认字段（`web/model3d/schema.js` 的 `sparseDoc`），读盘一律 `normalizeDoc` 补全；
   稀疏化模块是 ESM，这里按需动态取一次，取不到就退回完整形态，不挡保存。

   白模库索引（`.data/model-index/`）：归一化条目 + 增量维护，供 AI 按一句话检索要复用的模型。
   保存 / 删除各自增量改一条，改组 / 改库名 / 删组 / 删库后整表重扫；条目里的 outline 由
   `outlineOf(doc)` 现生成，prompt 取模型文件自己的 `src.prompt`（AI 生成时写入，与提示词归档同源）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { sendJson, fail } = require('./http');
const { atomicWrite, renameWithRetry } = require('../data-hub.js');
const { createIndexStore } = require('../index-store.js');

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
/* 索引重扫的冷却：目录级操作之后是强制重扫，平时的列目录 / 检索只按这一档刷新。 */
const INDEX_TTL_MS = 30 * 1000;
const INDEX_RETRY_MAX = 4;

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
  const schemaUrl = pathToFileURL(path.resolve(__dirname, '../../web/model3d/schema.js')).href;
  let schemaReady = null;
  let schemaMod = null;

  /* 形状模块（ESM）取一次，稀疏化与索引共用同一份。取不到时保存退回完整形态，索引少 outline。 */
  function schemaOf() {
    if (!schemaReady) {
      schemaReady = import(schemaUrl).then(m => { schemaMod = m; return m; }).catch(e => {
        log('[model3d] 形状模块取不到，写盘退回完整形态、索引只按名字与提示词检索：' + String(e.message || e));
        return null;
      });
    }
    return schemaReady;
  }

  /* 写盘前的稀疏化。 */
  function sparseOf(doc) {
    return schemaOf().then(m => {
      if (!m || typeof m.sparseDoc !== 'function') return doc;
      try { return m.sparseDoc(doc); } catch (e) {
        log('[model3d] 稀疏化失败，这一份按完整形态写：' + String(e.message || e));
        return doc;
      }
    });
  }

  /* ---------- 白模库索引 ---------- */

  const dataDirPath = typeof ctx.dataDirPath === 'function'
    ? ctx.dataDirPath
    : () => path.resolve(__dirname, '../../.data');
  let indexStore = null;
  let indexScan = null;
  let indexScannedAt = 0;
  /* 增量改表的次数：扫描开始时记一份，写回前对一次 —— 对不上说明扫描期间又有保存 / 删除落地，
     这一趟按过期处理，重扫。 */
  let indexWrites = 0;

  function modelIndex() {
    if (!indexStore) {
      indexStore = createIndexStore({
        dir: path.join(dataDirPath(), 'model-index'),
        log,
        max: Number.MAX_SAFE_INTEGER,
      });
    }
    return indexStore;
  }

  const flatText = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const cleanPrompt = v => String(v == null ? '' : v).replace(/\u0000/g, '').trim();
  const promptOfDoc = doc => flatText(doc && doc.src && doc.src.prompt);

  function partRowsOf(doc) {
    const roots = doc && doc.scene && Array.isArray(doc.scene.nodes) ? doc.scene.nodes : [];
    const out = [];
    for (const n of roots) {
      if (!n || typeof n !== 'object') continue;
      const label = flatText(n.name) || (n.kind === 'prim' ? flatText(n.shape) : flatText(n.kind));
      if (!label) continue;
      const shape = n.kind === 'prim' ? flatText(n.shape) : flatText(n.kind);
      const n2 = n.kind === 'prim' && n.repeat && Number(n.repeat.n) > 1 ? Math.round(Number(n.repeat.n)) : 0;
      out.push({ label, shape, count: n2 });
    }
    return out;
  }

  function topPartsOf(doc) {
    return partRowsOf(doc).map(r => r.label + (r.count > 1 ? '×' + r.count : ''));
  }

  /* 结构摘要：给 AI 判断「库里那个能不能用」时除名字之外的第二眼 ——
     顶层每个零件的名字 + 形状 / 种类 + 阵列份数，例：`桌面 box / 桌腿 box×4`。 */
  function briefOf(doc) {
    return partRowsOf(doc).map(r => r.label
      + (r.shape && r.shape !== r.label ? ' ' + r.shape : '')
      + (r.count > 1 ? '×' + r.count : ''));
  }

  function entryOfModel(library, abs, doc, raw, st, mod, prompt) {
    const root = kindRoot(library, 'model');
    const modelId = root ? path.relative(root, abs).replace(/\\/g, '/').replace(/\.json$/i, '') : path.basename(abs, MODEL_EXT);
    const dirGroup = root && path.resolve(path.dirname(abs)) !== path.resolve(root) ? path.basename(path.dirname(abs)) : '';
    return {
      id: library + ' :: ' + modelId,
      library,
      model: modelId,
      name: flatText(raw && raw.name) || path.basename(abs, MODEL_EXT),
      group: dirGroup || flatText(doc && doc.group),
      path: abs,
      ts: Number(doc && doc.ts) || Number(st && st.mtimeMs) || 0,
      when: Number(st && st.mtimeMs) || 0,
      bytes: Number(st && st.size) || 0,
      nodes: mod && typeof mod.countNodes === 'function' ? mod.countNodes(doc) : 0,
      outline: mod && typeof mod.outlineOf === 'function' ? mod.outlineOf(doc) : [],
      parts: topPartsOf(doc),
      brief: briefOf(doc),
      thumb: !!(st && st.thumb),
      prompt: prompt || '',
    };
  }

  function allModelFiles() {
    const root = baseDir();
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { dirs = []; }
    for (const ent of dirs) {
      if (!ent.isDirectory() || ent.name === TRASH_DIR || ent.name.startsWith('_')) continue;
      const library = safeLibrary(ent.name);
      if (!library) continue;
      const modelsRoot = path.join(root, library, MODEL_SUB);
      const scanned = scanKind(modelsRoot, MODEL_EXT);
      for (const row of scanned.rows) {
        out.push({
          library,
          abs: path.join(modelsRoot, row.group || '', row.name + MODEL_EXT),
          st: { mtimeMs: row.when, size: row.bytes, thumb: row.thumb },
        });
      }
    }
    return out;
  }

  /* 全库重扫：文件没变的条目直接沿用（不重读、不重算 outline），变了的重新解析。 */
  async function collectEntries() {
    const mod = await schemaOf();
    let prev = [];
    try { prev = modelIndex().read(); } catch (e) { prev = []; }
    const reuse = new Map(prev.filter(x => x && x.path).map(x => [x.path, x]));
    const entries = [];
    for (const f of allModelFiles()) {
      const hit = reuse.get(f.abs);
      /* 旧索引条目没有 `brief`（结构摘要）时就重解析一份，改版后第一次列目录会补全。 */
      if (hit && hit.library === f.library && hit.when === f.st.mtimeMs && hit.bytes === f.st.size
        && Array.isArray(hit.brief)) {
        entries.push(hit);
        continue;
      }
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(f.abs, 'utf8')); } catch (e) { continue; }
      let doc = raw;
      if (mod && typeof mod.normalizeDoc === 'function') {
        try { doc = mod.normalizeDoc(raw).doc; } catch (e) { doc = raw; }
      }
      entries.push(entryOfModel(f.library, f.abs, doc, raw, f.st, mod, promptOfDoc(raw)));
    }
    return entries;
  }

  /* 整表重扫（目录级操作后用 force，平时列目录 / 检索按 TTL 节流）。
     单飞：同时来几路时共用同一趟；扫描期间有增量写落地就重扫，最多 INDEX_RETRY_MAX 次。 */
  function reconcile(force) {
    if (!force && Date.now() - indexScannedAt < INDEX_TTL_MS) return Promise.resolve(false);
    if (indexScan) {
      /* 强扫撞上在途那趟：等它收尾再扫一次 —— 直接挂上去会拿扫描开始前的目录结果
         顶住改过名的库 / 组，直到下一个 TTL。 */
      return force ? indexScan.then(() => reconcile(true), () => reconcile(true)) : indexScan;
    }
    indexScan = (async () => {
      const startedAt = indexWrites;
      const startedMs = Date.now();
      try {
        for (let attempt = 0; attempt < INDEX_RETRY_MAX; attempt += 1) {
          const entries = await collectEntries();
          const byId = new Map(entries.map(e => [e.id, e]));
          let raced = false;
          try {
            await modelIndex().update(list => {
              if (indexWrites !== startedAt) { raced = true; return false; }
              /* 扫描开始之后刚存进来、readdir 还没看到的那几条留着；其余以磁盘为准。 */
              const keep = list.filter(x => x && x.id && !byId.has(x.id) && Number(x.when) >= startedMs);
              const next = keep.concat(entries);
              list.length = 0;
              for (const item of next) list.push(item);
              return true;
            });
          } catch (e) {
            log('[model3d] 索引写盘失败，下一趟再对齐：' + String(e.message || e));
            return false;
          }
          if (raced) continue;
          indexScannedAt = Date.now();
          return true;
        }
        log('[model3d] 索引连扫 ' + INDEX_RETRY_MAX + ' 次都撞上并发写入，本轮先放弃');
        return false;
      } finally {
        indexScan = null;
      }
    })();
    return indexScan;
  }

  /* 检索：CJK 按「单字 + 相邻两字」两种 token，拉丁按词；名字 / 模型 id 权重最高，
     大纲与提示词兜底。不做条数截断 —— 匹配的在前，其余按新到旧跟在后面。 */
  const QUERY_FILLERS = /(库里|库中|有没有|是否有|能不能|可以当|可以用来|能当|能作|当作|作为|一个|一些|几个|这个|那个|哪些|什么|怎么|请问|帮我|我想|我要|想要|需要|找一下|找一个|看看)/g;
  const STOP_CHARS = new Set(Array.from('的了是在和与及或这那有能可以我要把被给让对从到为做吗呢吧啊些请帮我想要个一里没当作用来'));

  function tokensOf(q) {
    const text = String(q || '').toLowerCase().replace(QUERY_FILLERS, ' ');
    const out = new Map();
    for (const w of (text.match(/[a-z0-9]+/g) || [])) {
      if (w.length >= 2) out.set(w, 3);
    }
    for (const run of (text.match(/[\u3400-\u9fff]+/g) || [])) {
      const chars = Array.from(run);
      for (let i = 0; i < chars.length; i += 1) {
        if (!STOP_CHARS.has(chars[i]) && !out.has(chars[i])) out.set(chars[i], 1);
        if (i + 1 < chars.length && !STOP_CHARS.has(chars[i]) && !STOP_CHARS.has(chars[i + 1])) {
          out.set(chars[i] + chars[i + 1], 4);
        }
      }
    }
    return Array.from(out, ([t, w]) => ({ t, w }));
  }

  const FIELD_WEIGHTS = [
    ['name', 6], ['model', 6], ['group', 3], ['parts', 3], ['outline', 2], ['prompt', 1],
  ];

  function scoreOf(entry, tokens) {
    if (!tokens.length) return 0;
    const hay = {
      name: flatText(entry.name).toLowerCase(),
      model: flatText(entry.model).toLowerCase(),
      group: flatText(entry.group).toLowerCase(),
      parts: (Array.isArray(entry.parts) ? entry.parts.join('、') : flatText(entry.parts)).toLowerCase(),
      outline: (Array.isArray(entry.outline) ? entry.outline.join('\n') : String(entry.outline || '')).toLowerCase(),
      prompt: String(entry.prompt || '').toLowerCase(),
    };
    let score = 0;
    for (const t of tokens) {
      for (const [key, w] of FIELD_WEIGHTS) {
        if (hay[key].indexOf(t.t) >= 0) score += w * t.w;
      }
    }
    const inName = tokens.every(t => hay.name.indexOf(t.t) >= 0 || hay.model.indexOf(t.t) >= 0);
    if (inName) score += 40;
    else if (tokens.every(t => hay.prompt.indexOf(t.t) >= 0)) score += 20;
    return score;
  }

  function catalogRows(q) {
    const list = modelIndex().read();
    const tokens = tokensOf(q);
    const scored = [];
    for (const it of list) {
      if (!it || !it.id) continue;
      scored.push({ it, score: scoreOf(it, tokens) });
    }
    scored.sort((a, b) => (b.score - a.score) || (Number(b.it.when) - Number(a.it.when)));
    return {
      total: scored.length,
      matched: scored.filter(x => x.score > 0).length,
      rows: scored.map(x => ({
        id: x.it.id,
        library: x.it.library,
        model: x.it.model,
        name: x.it.name,
        group: x.it.group,
        nodes: x.it.nodes,
        parts: x.it.parts || [],
        brief: x.it.brief || [],
        score: x.score,
      })),
    };
  }

  function handleCatalog(res, q) {
    reconcile(false).then(() => {
      try {
        const out = catalogRows(q);
        sendJson(res, 200, { ok: true, q: String(q || ''), total: out.total, matched: out.matched, rows: out.rows });
      } catch (e) { fail(res, 500, '检索失败：' + String(e.message || e)); }
    }).catch(e => fail(res, 500, '白模库索引读不出来：' + String(e.message || e)));
  }

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
    readBody(req, res, Infinity).then(async raw => {
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
      /* 提示词的写入口只有这一次：客户端带上来就用它，没带就沿用旧文件里那一句
         （`modelFromEntity` 造新文档时不会带 `src`）。 */
      let prevPrompt = '';
      if (prev) {
        try { prevPrompt = promptOfDoc(JSON.parse(fs.readFileSync(prev, 'utf8'))); }
        catch (e) { prevPrompt = ''; }
      }
      const prompt = cleanPrompt(spec.prompt) || prevPrompt;
      if (prompt) {
        if (!doc.src || typeof doc.src !== 'object') doc.src = {};
        doc.src.prompt = prompt;
      }
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
      atomicWrite(dst, JSON.stringify(await sparseOf(doc), null, 2));
      const thumb = String(spec.thumb || '');
      const thumbDst = dst.replace(/\.json$/i, THUMB_EXT);
      if (/^data:image\/png;base64,/.test(thumb)) {
        try {
          const buf = Buffer.from(thumb.slice(thumb.indexOf(',') + 1), 'base64');
          if (buf.length) atomicWrite(thumbDst, buf);
        } catch (e) { log('[model3d] 缩略图没写进去：' + e.message); }
      }
      if (kind === 'model') {
        try {
          const mod = await schemaOf();
          let st = null;
          try {
            const s = fs.statSync(dst);
            st = { mtimeMs: s.mtimeMs, size: s.size, thumb: fs.existsSync(thumbDst) };
          } catch (e) { st = null; }
          const entry = entryOfModel(library, dst, doc, doc, st, mod, prompt);
          const oldKey = prevId ? library + ' :: ' + prevId : '';
          await modelIndex().update(list => {
            if (oldKey && oldKey !== entry.id) modelIndex().dropFrom(list, oldKey);
            modelIndex().putInto(list, entry);
            indexWrites += 1;
            return true;
          });
        } catch (e) {
          log('[model3d] 索引没记上（' + relIdOf(library, kind, dst) + '），下一次重扫会补：' + String(e.message || e));
        }
      }
      sendJson(res, 200, {
        ok: true, library, kind, id: relIdOf(library, kind, dst), name, group, dir: path.dirname(dst),
      });
    }).catch(e => fail(res, 500, '保存失败：' + String(e.message || e)));
  }

  function handleDelete(req, res) {
    readBody(req, res, Infinity).then(async raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, '请求体不是 JSON'); }
      const library = safeLibrary(spec.library);
      const kind = spec.kind === 'scene' ? 'scene' : 'model';
      const abs = absIn(library, kind, spec.id, { ext: MODEL_EXT });
      if (!abs) return fail(res, 400, 'id 非法：' + spec.id);
      const relId = relIdOf(library, kind, abs);
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
      if (kind === 'model') {
        try {
          await modelIndex().update(list => {
            if (!modelIndex().dropFrom(list, library + ' :: ' + relId)) return false;
            indexWrites += 1;
            return true;
          });
        } catch (e) {
          log('[model3d] 索引没摘掉（' + relId + '），下一次重扫会补：' + String(e.message || e));
        }
      }
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
    readBody(req, res, Infinity).then(async raw => {
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
        /* 库名是索引条目的前缀，改完必须整表重扫一遍。 */
        await reconcile(true);
      } else {
        if (fs.existsSync(dst)) return fail(res, 409, '白模库已存在：' + name);
        ensureDir(path.join(dst, MODEL_SUB));
        ensureDir(path.join(dst, SCENE_SUB));
      }
      sendJson(res, 200, { ok: true, id: name, name });
    }).catch(e => fail(res, 500, '白模库保存失败：' + String(e.message || e)));
  }

  function handleLibraryDelete(req, res) {
    readBody(req, res, Infinity).then(async raw => {
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
      /* 整个库搬进暂存目录，索引里属于这个库的条目要跟着消失。 */
      await reconcile(true);
      sendJson(res, 200, { ok: true, id, movedTo: dst });
    }).catch(e => fail(res, 500, '删除失败：' + String(e.message || e)));
  }

  /* 场景组 / 模型组共用一份：建目录、整组改名（回写每份 doc.group）、
     删组（组里的文件退回未分组，真正删掉组目录）。 */
  function handleGroup(req, res, mode, kind) {
    readBody(req, res, Infinity).then(async raw => {
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
            atomicWrite(abs, JSON.stringify(await sparseOf(doc), null, 2));
          } catch (e) { log('[model3d] ' + label + '改名后回写失败：' + f); }
        }
        /* 组名是索引条目 id 的一段，改完整表重扫。场景不建索引，跳过。 */
        if (!isScene) await reconcile(true);
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
          atomicWrite(dst, JSON.stringify(await sparseOf(doc), null, 2));
        } catch (e) { log('[model3d] ' + label + '删除后回写失败：' + f); }
      }
      try { if (!fs.readdirSync(src).length) fs.rmdirSync(src); } catch (e) { /* 空组目录收不掉不影响 */ }
      /* 组里的模型全退回未分组，条目 id 变了，整表重扫。 */
      if (!isScene) await reconcile(true);
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
      /* 列目录顺手把索引暖一轮（TTL 内不重复扫）；失败不影响这次列目录。 */
      reconcile(false).catch(() => {});
      return true;
    }
    if (sub === 'catalog' && req.method === 'GET') { handleCatalog(res, q.get('q')); return true; }
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
