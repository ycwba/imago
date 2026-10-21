/* 画布操作：一条 op 只做一件事，先验后写；一批 op 要么全做，要么整批不动。
   文档是不可变入参、新对象出参 —— 撤销/重做因此可以直接换整份，不用反向打补丁。 */
import { newNode, newConnection, cleanMeta, findNode, findConnection, inputCount, uid, LIMITS, errOf } from './doc.js';
import { typeOf, labelOf, whyConnect, wouldCycle, minSize } from './registry.js';

export const OPS = ['add_node', 'update_node', 'delete_nodes', 'connect_nodes', 'delete_connections',
  'set_viewport', 'select_nodes', 'run_generation'];
/* 视图类操作不动内容：不涨 revision、不进撤销栈。否则每滚一次滚轮，
   助手那边的修订号就变一次，Ctrl+Z 也会撤出一堆「缩放」。 */
export const VIEW_OPS = ['set_viewport', 'select_nodes'];

class BadOp extends Error {}
const bad = m => { throw new BadOp(m); };
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function needNode(doc, id) {
  const n = findNode(doc, id);
  if (!n) bad('没有这个节点：' + (id == null ? '(空)' : String(id).slice(0, 64)));
  return n;
}
function idsOf(list, what) {
  const a = (Array.isArray(list) ? list : (list == null ? [] : [list])).map(String).filter(Boolean);
  if (!a.length) bad(what + '：至少要一个 id');
  if (a.length > LIMITS.nodes) bad(what + '：一次最多 ' + LIMITS.nodes + ' 个');
  return [...new Set(a)];
}

/* applyOperation(doc, op) → { doc, changed }；不合法就抛（由 applyOperations 收成为 reason）。
   changed = { nodes:[id], connections:[id] }，界面按它高亮，历史按它取快照。 */
export function applyOperation(doc, op) {
  if (!op || typeof op !== 'object') bad('操作不是对象');
  const kind = String(op.op || op.kind || '');
  if (!OPS.includes(kind)) bad('不认识的操作：' + kind);
  const nodes = (doc.nodes || []).slice();
  const connections = (doc.connections || []).slice();
  const changed = { nodes: [], connections: [] };
  const view = { ...doc.viewport };
  let selection = doc.selection ? doc.selection.slice() : [];

  if (kind === 'add_node') {
    const a = op.node || op;
    if (!typeOf(a.type)) bad('没有这种节点类型：' + a.type);
    if (nodes.length >= LIMITS.nodes) bad('节点已经到了 ' + LIMITS.nodes + ' 个上限');
    let id = String(a.id || '') || uid('nd_');
    if (nodes.some(n => n.id === id)) id = uid('nd_');
    const n = newNode({ ...a, id });
    nodes.push(n);
    changed.nodes.push(n.id);
    return { doc: { ...doc, nodes, connections, selection: [...selection, n.id] }, changed, node: n };
  }

  if (kind === 'update_node') {
    const n = needNode(doc, op.id);
    const p = (op.patch && typeof op.patch === 'object') ? op.patch : {};
    const next = { ...n };
    if ('title' in p) next.title = String(p.title == null ? '' : p.title).slice(0, LIMITS.title);
    if ('x' in p) next.x = Math.max(-LIMITS.side, Math.min(LIMITS.side, num(p.x, n.x)));
    if ('y' in p) next.y = Math.max(-LIMITS.side, Math.min(LIMITS.side, num(p.y, n.y)));
    if ('width' in p || 'height' in p) {
      /* 下限听注册表的：newNode 按 minSize 夹过，这里不夹的话，助手或把手能把节点
         压到比它自己那个图标还小 —— 画面上就再也点不回来了。 */
      const m = minSize(n.type);
      next.width = Math.max(m.width, Math.min(LIMITS.side, num(p.width, n.width)));
      next.height = Math.max(m.height, Math.min(LIMITS.side, num(p.height, n.height)));
    }
    if ('metadata' in p) {
      const merged = cleanMeta({ ...(n.metadata || {}), ...(p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) }, n.type);
      next.metadata = merged;
    }
    next.updatedAt = Date.now();
    nodes[nodes.findIndex(x => x.id === n.id)] = next;
    changed.nodes.push(n.id);
    return { doc: { ...doc, nodes, connections }, changed, node: next };
  }

  if (kind === 'delete_nodes') {
    const ids = idsOf(op.ids, '删节点');
    ids.forEach(id => needNode(doc, id));
    const drop = new Set(ids);
    const keptNodes = nodes.filter(n => !drop.has(n.id));
    const keptConns = connections.filter(c => !drop.has(c.fromNodeId) && !drop.has(c.toNodeId));
    /* 连带删掉的连线必须照实报出来：它们也是「刚才那一刀改的东西」，
       否则界面上的线没了，用户以为画布坏了。 */
    const casc = connections.filter(c => drop.has(c.fromNodeId) || drop.has(c.toNodeId)).map(c => c.id);
    changed.nodes = ids.slice();
    changed.connections = [...new Set(casc)];
    if (!keptNodes.length && nodes.length) bad('不能把最后一个节点删掉：要清空就新建一份画布');
    /* 选择集里不能留着刚删掉的号：拖动按选择集算起点，读到不存在的节点会当场抛。 */
    const selection = (doc.selection || []).filter(id => !drop.has(id));
    return { doc: { ...doc, nodes: keptNodes, connections: keptConns, selection }, changed, 连带连线数: casc.length };
  }

  if (kind === 'connect_nodes') {
    const a = needNode(doc, op.from || op.fromNodeId);
    const b = needNode(doc, op.to || op.toNodeId);
    if (a.id === b.id) bad('连线不能自己连自己');
    const key = a.id + '>' + b.id;
    if (connections.some(c => c.fromNodeId + '>' + c.toNodeId === key)) bad('这一对节点已经有连线了');
    const why = whyConnect(a.type, b.type, inputCount(doc, b.id));
    if (why) bad(why + '（' + labelOf(a.type) + ' → ' + labelOf(b.type) + '）');
    if (wouldCycle(connections, a.id, b.id)) bad('这条线会让生成顺序成环');
    const c = newConnection({ fromNodeId: a.id, toNodeId: b.id, fromHandle: op.fromHandle, toHandle: op.toHandle });
    connections.push(c);
    changed.connections.push(c.id);
    return { doc: { ...doc, connections }, changed, connection: c };
  }

  if (kind === 'delete_connections') {
    const ids = idsOf(op.ids, '删连线').map(id => {
      const c = findConnection(doc, id);
      if (!c) bad('没有这条连线：' + id);
      return c.id;
    });
    const drop = new Set(ids);
    changed.connections = ids;
    return { doc: { ...doc, connections: connections.filter(c => !drop.has(c.id)) }, changed };
  }

  if (kind === 'set_viewport') {
    const v = (op.viewport && typeof op.viewport === 'object') ? op.viewport : op;
    view.x = Math.max(-LIMITS.side * 4, Math.min(LIMITS.side * 4, num(v.x, view.x)));
    view.y = Math.max(-LIMITS.side * 4, Math.min(LIMITS.side * 4, num(v.y, view.y)));
    view.scale = Math.max(LIMITS.scaleMin, Math.min(LIMITS.scaleMax, num(v.scale, view.scale)));
    return { doc: { ...doc, viewport: view }, changed, view: true };
  }

  if (kind === 'select_nodes') {
    const ids = (Array.isArray(op.ids) ? op.ids : []).map(String).filter(id => findNode(doc, id));
    return { doc: { ...doc, selection: ids }, changed, selection: ids, view: true };
  }

  /* run_generation 只登记任务与状态：字节与轮询在页面那一侧，这里只负责把结果落到节点上。 */
  const n = needNode(doc, op.id);
  const p = (op.patch && typeof op.patch === 'object') ? op.patch : {};
  const meta = cleanMeta({ ...(n.metadata || {}), ...p }, n.type);
  const next = { ...n, metadata: meta, updatedAt: Date.now() };
  nodes[nodes.findIndex(x => x.id === n.id)] = next;
  changed.nodes.push(n.id);
  return { doc: { ...doc, nodes }, changed, node: next };
}

/* 整批：先在快照上把所有 op 验一遍，全过了才写。
   任一条不合法就整批拒绝 —— 不做「前三条成功、第四条失败」的半截画布。 */
export function applyOperations(doc, ops, opt = {}) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return { ok: false, reason: '至少要有一条操作' };
  const rev = Number(doc.revision) || 0;
  if (opt.expectedRevision != null && Number(opt.expectedRevision) !== rev) {
    return { ok: false, code: 'revision_mismatch', reason: '这份画布在你看期间被改过（当前 ' + rev + '，你读到的是 ' + opt.expectedRevision + '）：重新读一次再改', revision: rev };
  }
  let cur = doc;
  const changed = { nodes: [], connections: [] };
  const applied = [];
  for (let i = 0; i < list.length; i++) {
    let r;
    try { r = applyOperation(cur, list[i]); } catch (e) {
      const msg = errOf(e);
      return { ok: false, at: i, reason: list[i] && list[i].op ? ('第 ' + (i + 1) + ' 条（' + list[i].op + '）：' + msg) : ('第 ' + (i + 1) + ' 条：' + msg) };
    }
    cur = r.doc; applied.push(r);
    for (const id of r.changed.nodes) if (!changed.nodes.includes(id)) changed.nodes.push(id);
    for (const id of r.changed.connections) if (!changed.connections.includes(id)) changed.connections.push(id);
  }
  const real = applied.filter(r => !r.view);
  const viewOnly = real.length === 0;
  const at = Date.now();
  const out = {
    ...cur,
    revision: viewOnly ? rev : rev + 1,
    updatedAt: viewOnly ? (doc.updatedAt || at) : at,
  };
  return { ok: true, doc: out, changed, revision: out.revision, viewOnly,
    node: applied.find(r => r.node) && applied.find(r => r.node).node,
    connection: applied.find(r => r.connection) && applied.find(r => r.connection).connection,
    连带连线数: applied.reduce((s, r) => s + (r.连带连线数 || 0), 0) };
}

export { BadOp };
