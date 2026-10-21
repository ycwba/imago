/* 均匀网格空间索引：把「哪些节点在这个矩形里」从 O(节点数) 变成 O(覆盖格数)。
   画布要 720 个节点还能跟手，靠的是每帧只问视口，不把整份节点表扫一遍。 */
import { LIMITS } from './doc.js';

export const CELL = 1024;

const key = (cx, cy) => cx + ',' + cy;

export function createIndex(opts = {}) {
  const cell = Number(opts.cell) > 0 ? Number(opts.cell) : CELL;
  const cells = new Map();        // "cx,cy" → Set<nodeId>
  const rects = new Map();        // nodeId → {x,y,w,h}
  const range = (x0, y0, x1, y1) => [Math.floor(x0 / cell), Math.floor(y0 / cell), Math.floor(x1 / cell), Math.floor(y1 / cell)];

  function unlink(id, r) {
    const [cx0, cy0, cx1, cy1] = range(r.x, r.y, r.x + r.w, r.y + r.h);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = key(cx, cy);
      const set = cells.get(k);
      if (!set) continue;
      set.delete(id);
      if (!set.size) cells.delete(k);
    }
  }

  /* 位置变了就整块重挂：节点跨格时「先摘旧的再挂新的」比增量迁移简单，
     而且一次拖动只改一个节点，代价恒定。 */
  function insert(id, node) {
    remove(id);
    const r = { x: Number(node.x) || 0, y: Number(node.y) || 0,
      w: Math.max(0, Number(node.width) || 0), h: Math.max(0, Number(node.height) || 0) };
    rects.set(id, r);
    const [cx0, cy0, cx1, cy1] = range(r.x, r.y, r.x + r.w, r.y + r.h);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = key(cx, cy);
      let set = cells.get(k);
      if (!set) { set = new Set(); cells.set(k, set); }
      set.add(id);
    }
    return r;
  }

  function remove(id) {
    const r = rects.get(id);
    if (!r) return false;
    unlink(id, r);
    rects.delete(id);
    return true;
  }

  function update(id, node) { return rects.has(id) ? insert(id, node) : null; }

  /* 相交测试留在查询里做：格子里可能只有边擦进来，节点本身不在矩形内。 */
  function queryRect(x0, y0, x1, y1) {
    if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) return [];
    const a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
    const [cx0, cy0, cx1, cy1] = range(a, b, c, d);
    const hit = [];
    const seen = new Set();
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      for (const id of cells.get(key(cx, cy)) || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const r = rects.get(id);
        if (!r) continue;
        if (r.x < c && r.x + r.w > a && r.y < d && r.y + r.h > b) hit.push(id);
      }
    }
    return hit;
  }

  /* 视口 → 文档坐标：画布用 translate(x,y) scale(s)，所以文档坐标 = (屏幕 - 平移) / 缩放。
     多出 25% 余量：滚动到边缘时不至于下一帧才补挂载，媒体懒加载也需要提前量。 */
  function queryViewport(vp, vw, vh, pad) {
    /* 倍率必须是个正数：坏值兜回 1:1。0 会把后面整段除法变成 Infinity，
       负数会把可视区算到屏幕另一侧 —— 两种表现都是「节点莫名空白一片」。 */
    const raw = Number(vp && vp.scale);
    const scale = Math.max(0.01, Number.isFinite(raw) && raw > 0 ? raw : 1);
    const over = Number(pad) >= 0 ? Number(pad) : 0.25;
    const pw = (Number(vw) || 0) / scale, ph = (Number(vh) || 0) / scale;
    /* 屏幕坐标 → 文档坐标：screen = doc*scale + 平移，所以 doc = (screen - 平移) / scale。
       余量按**四条边各多出 over/2** 摊开 —— 以前是往右多算一倍、往左只算一半，
       缩得很大时左侧先出现空白，而那才是人眼正对着的地方。 */
    const x = -(Number(vp && vp.x) || 0) / scale, y = -(Number(vp && vp.y) || 0) / scale;
    const ex = pw * over / 2, ey = ph * over / 2;
    return queryRect(x - ex, y - ey, x + pw + ex, y + ph + ey);
  }

  function rectOf(id) { const r = rects.get(id); return r ? { ...r } : null; }
  function size() { return rects.size; }
  function stats() { return { nodes: rects.size, cells: cells.size }; }

  /* 整份重建只在「打开文档 / 撤销换整份」时跑一次；拖动走 update，不重排。 */
  function rebuild(nodes) {
    cells.clear(); rects.clear();
    for (const n of nodes || []) if (n && n.id) insert(n.id, n);
    return rects.size;
  }

  return { insert, remove, update, queryRect, queryViewport, rectOf, size, stats, rebuild };
}

/* 不建索引的一次性查询：文档小、或刚导入还没建索引时用。 */
export function rectHits(nodes, x0, y0, x1, y1) {
  const a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
  return (nodes || []).filter(n => n && n.x < c && n.x + (n.width || 0) > a && n.y < d && n.y + (n.height || 0) > b).map(n => n.id);
}

/* 框选：节点要整框在里面才算选中（和剪映、Figma 一致）——
   擦到边就选上会让「拖一个框」变成误伤。 */
export function containedIds(nodes, x0, y0, x1, y1) {
  const a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
  return (nodes || []).filter(n => n && n.x >= a && n.y >= b
    && n.x + (n.width || 0) <= c && n.y + (n.height || 0) <= d).map(n => n.id);
}

/* 网格吸附：把手所在格的下边界当吸附线。格子大小从外面给，页面按当前缩放决定是否吸附。 */
export function snap(v, step) {
  const s = Number(step) || 0;
  return s > 0 ? Math.round(v / s) * s : v;
}

/* 把一组节点整体挪到视口中央（助手插节点、「查看全部」用）：
   纯几何，不碰 DOM，页面拿到结果自己写 viewport。 */
export function fitViewport(nodes, ids, vp, vw, vh, margin = 64, maxScale = 1) {
  const list = (Array.isArray(ids) && ids.length ? (nodes || []).filter(n => ids.includes(n.id)) : (nodes || []));
  if (!list.length) return { ...vp };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of list) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + (n.width || 0)); y1 = Math.max(y1, n.y + (n.height || 0));
  }
  const w = Math.max(1, vw - margin * 2), h = Math.max(1, vh - margin * 2);
  /* 下限跟文档那一档（view.js 的 MIN_SCALE 读的是同一个 LIMITS）：
     两处各写一个 0.2 的话，缩到「算出来能放但界面不允许」的倍率就白算。 */
  const scale = Math.max(LIMITS.scaleMin, Math.min(maxScale || 1, Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0))));
  return { x: w / 2 + margin - ((x0 + x1) / 2) * scale, y: h / 2 + margin - ((y0 + y1) / 2) * scale, scale };
}
