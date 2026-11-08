/* 白膜库（客户端）—— 模型文件在库根下的读写都走这一份：列表 / 读 / 存 / 改名移组 / 删 /
   缩略图地址 / 导入 3D 文件 / 导出导入 .json。

   身份是 `组/名`（没有组就是 `名`），与磁盘上的相对路径同形；页面里一切引用都用它。
   名字的夹取与代理侧同规则（`NAME_MAX` / `GROUP_MAX` / `_` 前缀保留），这里先判一次只是为了
   早点给出人话原因 —— 真正的闸在路由里。

   网络只走 `Net`（全站唯一实现）：JSON 与二进制上传都是 `Net.json`，后者带一个
   `application/octet-stream` 的 body。 */

const NAME_MAX = 40;
const GROUP_MAX = 20;
const ASSET_EXT = ['.fbx', '.obj', '.glb', '.gltf'];

const net = () => window.Net;

export function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}
export function cleanGroup(raw) {
  return cleanName(raw).slice(0, GROUP_MAX);
}
export function idOf(group, name) {
  return (group ? cleanGroup(group) + '/' : '') + cleanName(name);
}
export function splitId(id) {
  const s = String(id || '');
  const i = s.indexOf('/');
  return i < 0 ? { group: '', name: s } : { group: s.slice(0, i), name: s.slice(i + 1) };
}

export async function list() {
  const d = await net().json('/model3d', { cache: 'no-store' });
  return d || { dir: '', groups: [], models: [] };
}

export async function read(id) {
  return await net().json('/model3d/file?id=' + encodeURIComponent(id), { cache: 'no-store' });
}

export async function save({ id, name, group, model, thumb }) {
  return await net().json('/model3d/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id || '', name, group: group || '', model, thumb: thumb || '' }),
    timeout: 30,
  });
}

export async function remove(id) {
  return await net().json('/model3d/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    timeout: 20,
  });
}

/* 缩略图：带上 mtime 当版本，换过图之后列表不会继续显示旧的那一张 */
export function thumbUrl(rec) {
  if (!rec || !rec.thumb) return '';
  return '/model3d/thumb?id=' + encodeURIComponent(rec.id) + '&v=' + Math.round(rec.when || 0);
}
export function modelFileUrl(id) {
  return '/model3d/file?id=' + encodeURIComponent(id);
}
export function assetUrl(file) {
  return '/model3d/asset?name=' + encodeURIComponent(file);
}

/* 导入一个 3D 文件：字节直传，落 `_模型文件/`，返回 `{ file, bytes }`（file 是相对 `白膜/` 的路径） */
export async function upload(file) {
  const ext = '.' + String(file.name || '').split('.').pop().toLowerCase();
  if (!ASSET_EXT.includes(ext)) throw new Error('只收 ' + ASSET_EXT.join(' / ') + ' 这几种 3D 文件');
  if (file.size > 80 * 1024 * 1024) throw new Error('这个文件 ' + window.fmtBytes(file.size) + '，超过 80 MB 上限');
  const buf = new Uint8Array(await file.arrayBuffer());
  return await net().json('/model3d/asset?name=' + encodeURIComponent(file.name || ('model' + ext)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
    timeout: 0,
  });
}

/* 导出成一份能带走、也能再导回来的 .json（模型本身不认识库，拷到别的机器上照样能读） */
export function exportDoc(doc) {
  const body = JSON.stringify(doc, null, 2);
  const blob = new Blob([body], { type: 'application/json' });
  net().save(blob, '白膜-' + (doc.name || 'model') + '.json');
  return body.length;
}

/* 读一个 .json 文件回来（导入）：不落盘，交给页面决定存成哪个组 / 叫什么 */
export async function readJsonFile(file) {
  const txt = await file.text();
  let raw = null;
  try { raw = JSON.parse(txt); } catch (e) { throw new Error('这个文件不是 JSON：' + window.errText(e)); }
  if (!raw || typeof raw !== 'object') throw new Error('这份 json 里没有模型');
  return raw;
}
