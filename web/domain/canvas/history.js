/* 画布历史：补丁栈（before/after 只存被改到的节点与连线），最多 50 层。
   外部写入（助手）会推进基线，所以 Ctrl+Z 撤不到助手那一步 —— 助手自己按 operationId 退。 */

export const MAX_LEVELS = 50;

const ids = list => (Array.isArray(list) ? list : []).map(String).filter(Boolean);
const byId = (list, id) => (list || []).find(x => x && x.id === id) || null;

/* changed = {nodes:[id], connections:[id]}（来自 applyOperations）。
   新增的东西 before 是 null，删除的东西 after 是 null —— 反向恢复就照这两个方向写回。 */
export function patchFrom(prevDoc, nextDoc, changed) {
  const c = changed || {};
  const pick = (doc, id, kind) => {
    const list = (kind === 'connections' ? doc.connections : doc.nodes) || [];
    return byId(list, id);
  };
  const before = { nodes: [], connections: [] };
  const after = { nodes: [], connections: [] };
  for (const id of ids(c.nodes)) { before.nodes.push(pick(prevDoc, id, 'nodes')); after.nodes.push(pick(nextDoc, id, 'nodes')); }
  for (const id of ids(c.connections)) { before.connections.push(pick(prevDoc, id, 'connections')); after.connections.push(pick(nextDoc, id, 'connections')); }
  if (!before.nodes.length && !before.connections.length) return null;
  return { before, after, ids: { nodes: ids(c.nodes), connections: ids(c.connections) } };
}

/* 打一次补丁：把 after 侧写回（重做）或把 before 侧写回（撤销）。
   一次历史动作就是一次写：revision 照实 +1，别让它跟内容脱节。 */
export function applyPatch(doc, patch, side, at) {
  if (!patch || !patch[side]) return { doc, changed: { nodes: [], connections: [] } };
  const s = patch[side];
  const nodes = (doc.nodes || []).slice();
  const connections = (doc.connections || []).slice();
  const write = (list, item, removed) => {
    const i = list.findIndex(x => x.id === item.id);
    if (removed) { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) list[i] = item; else list.push(item);
  };
  patch.ids.nodes.forEach((id, k) => {
    const item = s.nodes[k];
    if (item) { item.id = id; write(nodes, item, false); return; }
    const gone = byId(nodes, id);
    if (gone) write(nodes, gone, true);
  });
  patch.ids.connections.forEach((id, k) => {
    const item = s.connections[k];
    if (item) { item.id = id; write(connections, item, false); return; }
    const gone = byId(connections, id);
    if (gone) write(connections, gone, true);
  });
  return { doc: { ...doc, nodes, connections, revision: (Number(doc.revision) || 0) + 1, updatedAt: at || Date.now() },
    changed: { nodes: patch.ids.nodes.slice(), connections: patch.ids.connections.slice() } };
}

export function createHistory(opts = {}) {
  const max = Number(opts.max) > 0 ? Math.min(Number(opts.max), MAX_LEVELS) : MAX_LEVELS;
  const trace = typeof opts.trace === 'function' ? opts.trace : () => {};
  let entries = [];        // [{ patch, label, operationId, source }]
  let cursor = 0;          // 前 cursor 条已生效
  let baseline = 0;        // cursor 不得低于这一层（键盘撤不到基线以下）
  let seq = 0;

  function trim() {
    if (entries.length <= max) return;
    const drop = entries.length - max;
    entries.splice(0, drop);
    cursor = Math.max(0, cursor - drop);
    baseline = Math.max(0, baseline - drop);
    trace('挤出最老的一层：' + drop);
  }

  /* push(prevDoc, nextDoc, changed, meta) → 条目或 null（没实际改动就不进栈）。
     meta.source === 'external' 表示这一次不是用户亲手做的（助手写入）。 */
  function push(prevDoc, nextDoc, changed, meta = {}) {
    const patch = meta.patch || patchFrom(prevDoc, nextDoc, changed);
    if (!patch) return null;
    entries = entries.slice(0, cursor);      // 新的写动作作废掉撤销掉的那一段
    const item = { id: 'h' + (++seq), patch,
      label: String(meta.label || '').slice(0, 80),
      operationId: String(meta.operationId || '').slice(0, 64),
      source: meta.source === 'external' ? 'external' : 'local',
      at: Number(meta.at) || Date.now() };
    entries.push(item);
    cursor = entries.length;
    if (item.source === 'external') baseline = cursor;   // 助手写的这一层，Ctrl+Z 撤不到
    trim();
    return item;
  }

  /* 基线单独推进：用于「外部写入没走 push」的场合（助手一次改完直接对齐到当前文档）。 */
  function advanceBaseline() { baseline = cursor = entries.length; }

  function entryAt(i) { return entries[i] || null; }

  /* 键盘撤销只撤用户自己那一段：canUndo() 为假时 UI 的撤销按钮就该是灰的。 */
  function canUndo() { return cursor > baseline; }
  function canRedo() { return cursor < entries.length; }
  function undoLabel() { return canUndo() ? (entries[cursor - 1].label || '上一步') : ''; }
  function redoLabel() { return canRedo() ? (entries[cursor].label || '下一步') : ''; }

  function undo(doc) {
    if (!canUndo()) return { ok: false, reason: cursor > baseline ? '' : '这一步之外已经没有可撤销的人工改动了' };
    cursor--;
    const r = applyPatch(doc, entries[cursor].patch, 'before');
    return { ok: true, ...r, label: entries[cursor].label, id: entries[cursor].id };
  }
  function redo(doc) {
    if (!canRedo()) return { ok: false, reason: '没有可重做的一步' };
    const item = entries[cursor];
    cursor++;
    const r = applyPatch(doc, item.patch, 'after');
    return { ok: true, ...r, label: item.label, id: item.id };
  }

  function positionOf(operationId) {
    const id = String(operationId || '');
    if (!id) return -1;
    return entries.findIndex(e => e.operationId === id);
  }

  /* 助手退自己那一条：必须是当前生效的最上层，否则它后面已经压了人工改动，
     硬退会把用户做的东西一起抹掉 —— 这时照实说明还有几步，让用户自己决定。 */
  function undoOperation(doc, operationId) {
    const i = positionOf(operationId);
    if (i < 0) return { ok: false, reason: '历史里没有这一步（可能已经被更整的撤销挤掉了）' };
    if (i !== cursor - 1) {
      return { ok: false, code: 'not_top', reason: '我这一步之后已经有 ' + (cursor - 1 - i) + ' 步改动，先撤销它们再退这一条',
        steps: cursor - 1 - i };
    }
    const item = entries[i];
    entries = entries.slice(0, i);
    cursor = i;
    baseline = Math.min(baseline, i);
    const r = applyPatch(doc, item.patch, 'before');
    return { ok: true, ...r, label: item.label, external: item.source === 'external' };
  }

  function depth() { return { levels: entries.length, cursor, baseline, max }; }
  function list() {
    return entries.map((e, i) => ({ i, applied: i < cursor, label: e.label, source: e.source,
      operationId: e.operationId, 节点数: e.patch.ids.nodes.length, 连线数: e.patch.ids.connections.length }));
  }
  function clear() { entries = []; cursor = 0; baseline = 0; }

  return { push, undo, redo, canUndo, canRedo, undoLabel, redoLabel, applyPatch,
    positionOf, undoOperation, advanceBaseline, depth, list, entryAt, clear };
}
