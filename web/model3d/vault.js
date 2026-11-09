/* 白模库（客户端）—— 多库 + 模型 / 场景 的读写都走这一份。
   库目录：白膜/<库>/模型|场景|_模型文件；库 id 与文件夹同名。
   网络只走 Net（全站唯一实现）：JSON 与二进制上传都是 Net.json。 */

const ASSET_EXT = ['.fbx', '.obj', '.glb', '.gltf'];
const net = () => window.Net;

export function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export function cleanGroup(raw) {
  return cleanName(raw);
}
export function splitId(id) {
  const s = String(id || '');
  const i = s.indexOf('/');
  return i < 0 ? { group: '', name: s } : { group: s.slice(0, i), name: s.slice(i + 1) };
}

export async function list(library = '') {
  const q = library ? '?library=' + encodeURIComponent(library) : '';
  const d = await net().json('/model3d' + q, { cache: 'no-store', timeout: 0 });
  return d || { dir: '', library: '', libraries: [], groups: [], models: [], sceneGroups: [], scenes: [] };
}

/* 全部白模库的检索：`q` 就是用户对 AI 说的那一句，服务端在名字 / 组 / 零件 / 大纲 /
   建模提示词上匹配。返回 `{ total, matched, rows }`，rows 按匹配度再按新到旧排好。 */
export async function catalog(q = '') {
  const d = await net().json('/model3d/catalog?q=' + encodeURIComponent(String(q || '')), { cache: 'no-store', timeout: 0 });
  return d || { ok: false, q: '', total: 0, matched: 0, rows: [] };
}

export async function readModel(library, id) {
  return await net().json('/model3d/file?library=' + encodeURIComponent(library)
    + '&kind=model&id=' + encodeURIComponent(id), { cache: 'no-store', timeout: 0 });
}
export async function readScene(library, id) {
  return await net().json('/model3d/file?library=' + encodeURIComponent(library)
    + '&kind=scene&id=' + encodeURIComponent(id), { cache: 'no-store', timeout: 0 });
}

export async function saveModel({ library, id, name, group, model, thumb, prompt }) {
  return await net().json('/model3d/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, kind: 'model', id: id || '', name, group: group || '', model, thumb: thumb || '', prompt: prompt || '' }),
    timeout: 0,
  });
}
export async function saveScene({ library, id, name, group, model, thumb }) {
  return await net().json('/model3d/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, kind: 'scene', id: id || '', name, group: group || '', model, thumb: thumb || '' }),
    timeout: 0,
  });
}

export async function removeModel(library, id) {
  return await net().json('/model3d/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, kind: 'model', id }),
    timeout: 0,
  });
}
export async function removeScene(library, id) {
  return await net().json('/model3d/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, kind: 'scene', id }),
    timeout: 0,
  });
}

export async function saveLibrary({ id, name }) {
  return await net().json('/model3d/library/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id || '', name }),
    timeout: 0,
  });
}
export async function removeLibrary(id) {
  return await net().json('/model3d/library/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    timeout: 0,
  });
}

export async function createSceneGroup(library, name) {
  return await net().json('/model3d/scene-group/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, name }),
    timeout: 0,
  });
}
export async function renameSceneGroup(library, from, to) {
  return await net().json('/model3d/scene-group/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, from, to }),
    timeout: 0,
  });
}
export async function removeSceneGroup(library, from) {
  return await net().json('/model3d/scene-group/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, from }),
    timeout: 0,
  });
}

export async function createModelGroup(library, name) {
  return await net().json('/model3d/model-group/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, name }),
    timeout: 0,
  });
}
export async function renameModelGroup(library, from, to) {
  return await net().json('/model3d/model-group/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, from, to }),
    timeout: 0,
  });
}
export async function removeModelGroup(library, from) {
  return await net().json('/model3d/model-group/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library, from }),
    timeout: 0,
  });
}

export function thumbUrl(rec, library, kind) {
  if (!rec || !rec.thumb) return '';
  return '/model3d/thumb?library=' + encodeURIComponent(library || '')
    + '&kind=' + encodeURIComponent(kind || 'model')
    + '&id=' + encodeURIComponent(rec.id) + '&v=' + Math.round(rec.when || 0);
}
export async function upload(file, library) {
  const ext = '.' + String(file.name || '').split('.').pop().toLowerCase();
  if (!ASSET_EXT.includes(ext)) throw new Error('只收 ' + ASSET_EXT.join(' / ') + ' 这几种 3D 文件');
  return await net().json('/model3d/asset?library=' + encodeURIComponent(library)
    + '&name=' + encodeURIComponent(file.name || ('model' + ext)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    timeout: 0,
  });
}

export function exportDoc(doc, filename) {
  const body = JSON.stringify(doc, null, 2);
  const blob = new Blob([body], { type: 'application/json' });
  net().save(blob, filename || ((doc && doc.name) || 'model') + '.json');
  return body.length;
}

export async function readJsonFile(file) {
  const txt = await file.text();
  let raw = null;
  try { raw = JSON.parse(txt); } catch (e) { throw new Error('这个文件不是 JSON：' + window.errText(e)); }
  if (!raw || typeof raw !== 'object') throw new Error('这份 json 里没有模型');
  return raw;
}
