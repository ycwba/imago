/* 画布文档：结构、校验、导入导出与项目索引条目。
   文档只存引用与元数据 —— 媒体字节在本机资产库里，这里最多是一个资产号。 */
import { NODE_TYPES, typeOf, defaultSize, minSize, MEDIA_KINDS } from './registry.js';

export const DOC_V = 1;
export const LIMITS = {
  nodes: 720, connections: 5000, title: 120, content: 200000,
  side: 8000, scaleMin: 0.2, scaleMax: 3, importBytes: 8 * 1024 * 1024,
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, num(v, d)));
const str = (v, max) => String(v == null ? '' : v).slice(0, max || LIMITS.title);
const idOf = p => String(p || '').slice(0, 64);
const nowMs = at => (at == null ? Date.now() : Number(at)) || Date.now();

export function uid(prefix, salt) {
  return (prefix || 'n_') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + (salt || '');
}

/* 错误文案在浏览器侧只有一份（net.js 挂的 window.errText），但画布这几份是纯模块：
   测试在 Node 里直接 import，那边没有任何 window 面。所以能拿到就用、拿不到就地取，
   不为了统一文案把纯模块绑到某个全局上。 */
export const errOf = e => (globalThis.errText ? globalThis.errText(e) : String((e && e.message) || e || '未知错误'));

export function newDoc(a = {}) {
  const at = nowMs(a.at);
  return {
    v: DOC_V, id: idOf(a.id) || uid('cv_'), title: str(a.title, LIMITS.title) || '未命名画布',
    folderId: idOf(a.folderId), nodes: [], connections: [],
    viewport: { x: 0, y: 0, scale: 1 }, revision: 0, createdAt: at, updatedAt: at,
  };
}

export function newNode(a = {}) {
  const t = typeOf(a.type) ? a.type : 'text';
  const d = defaultSize(t), m = minSize(t);
  const at = nowMs(a.at);
  return {
    id: idOf(a.id) || uid('nd_'), type: t, title: str(a.title),
    x: clamp(a.x, -LIMITS.side, LIMITS.side, 0), y: clamp(a.y, -LIMITS.side, LIMITS.side, 0),
    width: clamp(a.width, m.width, LIMITS.side, d.width),
    height: clamp(a.height, m.height, LIMITS.side, d.height),
    metadata: cleanMeta(a.metadata, t), createdAt: at, updatedAt: at,
  };
}

export function newConnection(a = {}) {
  return {
    id: idOf(a.id) || uid('cn_'), fromNodeId: idOf(a.fromNodeId), toNodeId: idOf(a.toNodeId),
    fromHandle: str(a.fromHandle, 24), toHandle: str(a.toHandle, 24),
  };
}

/* metadata 只放行已知字段：密钥形状（token / key / secret）与未知字段一律不进文档，
   导出件因此可以安全地发给别人。 */
const META_KEYS = ['content', 'storageKey', 'sourceAssetId', 'prov', 'model', 'prompt', 'params', 'status', 'taskId', 'assetId', 'assetKind', 'error', 'folderId'];
const STATUS = ['idle', 'loading', 'success', 'error', 'uncertain'];

export function cleanMeta(m, type) {
  const src = (m && typeof m === 'object') ? m : {};
  const out = {};
  for (const k of META_KEYS) {
    if (!(k in src)) continue;
    const v = src[k];
    if (k === 'content') out.content = str(v, LIMITS.content);
    else if (k === 'status') out.status = STATUS.includes(v) ? v : 'idle';
    else if (k === 'params') out.params = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...v } : {};
    else if (k === 'storageKey' || k === 'sourceAssetId' || k === 'assetId' || k === 'taskId' || k === 'model' || k === 'prov' || k === 'assetKind') out[k] = str(v, 2000);
    else if (k === 'error') out.error = str(v, 400);
    else if (k === 'prompt') out.prompt = str(v, 20000);
    else if (k === 'folderId') out[k] = idOf(v);
  }
  if (!('status' in out)) out.status = 'idle';
  /* 产物号只对「能装素材的那几档」有意义：media 三档与资产引用；文本与配置节点存它只会误导导出件。 */
  if (type && !MEDIA_KINDS.includes(type) && type !== 'asset-ref' && out.assetId) delete out.assetId;
  return out;
}

/* 收到什么就收敛成什么：坏元素丢掉，字段夹到已知取值。
   画布的导入件与助手写入都先过这一道，后面所有算法才不用再防。 */
export function sanitizeDoc(d) {
  const src = (d && typeof d === 'object') ? d : {};
  const seen = new Set();
  const nodes = [];
  for (const raw of Array.isArray(src.nodes) ? src.nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const t = typeOf(raw.type) ? raw.type : 'text';
    const n = newNode({ ...raw, type: t });
    if (seen.has(n.id)) { n.id = uid('nd_'); }
    seen.add(n.id);
    nodes.push(n);
    if (nodes.length >= LIMITS.nodes) break;
  }
  const byId = new Set(nodes.map(n => n.id));
  const used = new Map();
  const connections = [];
  const cseen = new Set();
  for (const raw of Array.isArray(src.connections) ? src.connections : []) {
    if (!raw || typeof raw !== 'object') continue;
    const c = newConnection(raw);
    if (!byId.has(c.fromNodeId) || !byId.has(c.toNodeId) || c.fromNodeId === c.toNodeId) continue;
    if (cseen.has(c.fromNodeId + '>' + c.toNodeId)) continue;
    cseen.add(c.fromNodeId + '>' + c.toNodeId);
    connections.push(c);
    used.set(c.toNodeId, (used.get(c.toNodeId) || 0) + 1);
    if (connections.length >= LIMITS.connections) break;
  }
  const vp = (src.viewport && typeof src.viewport === 'object') ? src.viewport : {};
  const at = nowMs(src.updatedAt);
  return {
    v: DOC_V, id: idOf(src.id) || uid('cv_'), title: str(src.title, LIMITS.title) || '未命名画布',
    folderId: idOf(src.folderId), nodes, connections,
    viewport: { x: clamp(vp.x, -LIMITS.side * 4, LIMITS.side * 4, 0), y: clamp(vp.y, -LIMITS.side * 4, LIMITS.side * 4, 0),
      scale: clamp(vp.scale, LIMITS.scaleMin, LIMITS.scaleMax, 1) },
    revision: Math.max(0, Math.floor(num(src.revision, 0))), createdAt: nowMs(src.createdAt) || at, updatedAt: at,
  };
}

export function validDoc(d) {
  if (!d || typeof d !== 'object') return { ok: false, why: '不是对象' };
  if (!Array.isArray(d.nodes)) return { ok: false, why: '缺少 nodes 数组' };
  if (!Array.isArray(d.connections)) return { ok: false, why: '缺少 connections 数组' };
  if (d.nodes.length > LIMITS.nodes) return { ok: false, why: '节点过多（上限 ' + LIMITS.nodes + '）' };
  if (d.connections.length > LIMITS.connections) return { ok: false, why: '连线过多（上限 ' + LIMITS.connections + '）' };
  const ids = new Set();
  for (const n of d.nodes) {
    if (!n || typeof n !== 'object') return { ok: false, why: '节点不是对象' };
    if (!typeOf(n.type)) return { ok: false, why: '没有这种节点类型：' + n.type };
    if (!n.id || ids.has(n.id)) return { ok: false, why: n.id ? '节点 id 重复：' + n.id : '节点缺少 id' };
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return { ok: false, why: '节点坐标不是数字' };
    if (!(n.width > 0) || !(n.height > 0)) return { ok: false, why: '节点尺寸必须为正' };
    ids.add(n.id);
  }
  const pair = new Set();
  for (const c of d.connections) {
    if (!c || typeof c !== 'object') return { ok: false, why: '连线不是对象' };
    if (!ids.has(c.fromNodeId) || !ids.has(c.toNodeId)) return { ok: false, why: '连线两端有已经不存在的节点' };
    if (c.fromNodeId === c.toNodeId) return { ok: false, why: '连线不能自己连自己' };
    const k = c.fromNodeId + '>' + c.toNodeId;
    if (pair.has(k)) return { ok: false, why: '同一对节点已有连线' };
    pair.add(k);
  }
  return { ok: true };
}

export function exportDoc(doc) {
  const v = validDoc(doc);
  if (!v.ok) return { ok: false, why: v.why };
  return { ok: true, text: JSON.stringify({ kind: 'wb-canvas', v: DOC_V, doc }, null, 2) };
}

export function importDoc(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return { ok: false, why: '空的' };
  if (s.length > LIMITS.importBytes) return { ok: false, why: '这份画布文件太大（' + (globalThis.fmtBytes ? globalThis.fmtBytes(s.length) : s.length + ' 字节') + '）' };
  let raw;
  try { raw = JSON.parse(s); } catch (e) { return { ok: false, why: '不是合法的 JSON：' + errOf(e) }; }
  const body = raw && raw.kind === 'wb-canvas' ? raw.doc : raw;
  if (!body || typeof body !== 'object') return { ok: false, why: '文件里没有画布文档' };
  const v = validDoc(body);
  if (!v.ok) return { ok: false, why: v.why };
  return { ok: true, doc: sanitizeDoc(body) };
}

export function indexRecord(doc, old) {
  const cover = (doc.nodes || []).find(n => n.metadata && n.metadata.assetId)
    || (doc.nodes || []).find(n => MEDIA_KINDS.includes(n.type)) || doc.nodes[0];
  return {
    id: doc.id, title: doc.title, folderId: doc.folderId || '',
    createdAt: (old && old.createdAt) || doc.createdAt || Date.now(),
    updatedAt: doc.updatedAt || Date.now(),
    nodeCount: (doc.nodes || []).length, coverNodeId: cover ? cover.id : '',
  };
}

/* 助手与项目库都读这一份摘要：字段名与预算在这里定，别在调用方各拼一套。 */
export function docSummary(doc, max) {
  const nodes = (doc.nodes || []).slice(0, max || 200);
  return {
    id: doc.id, title: doc.title, revision: doc.revision,
    节点数: (doc.nodes || []).length, 连线数: (doc.connections || []).length,
    截断: (doc.nodes || []).length > nodes.length,
    视口: { ...doc.viewport },
    节点: nodes.map(n => ({
      id: n.id, type: n.type, 标题: n.title, x: n.x, y: n.y, width: n.width, height: n.height,
      状态: (n.metadata || {}).status || 'idle',
      有产物: !!(n.metadata && n.metadata.assetId),
      摘要: str((n.metadata || {}).content || (n.metadata || {}).prompt || '', 120),
    })),
  };
}

export function findNode(doc, id) { return (doc.nodes || []).find(n => n.id === idOf(id)) || null; }
export function findConnection(doc, id) { return (doc.connections || []).find(c => c.id === idOf(id)) || null; }
export function inputCount(doc, nodeId) { return (doc.connections || []).filter(c => c.toNodeId === nodeId).length; }
export function typesInUse(doc) {
  const t = {};
  for (const n of doc.nodes || []) t[n.type] = (t[n.type] || 0) + 1;
  return t;
}
export { NODE_TYPES };
