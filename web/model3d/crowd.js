/* 群众阵列 / 通用阵列 —— 纯布局：把「行列 / 间距 / 抖动」算成一串实例变换。
   为什么要确定性抖动：AI 流式生成时每收全一个节点就整场重建一次，
   抖动若是 Math.random，群众会在每一次重建时整体跳一下（看起来像坏了）。
   所以抖动只由「第几行第几列」的散列决定，同一份模型每次算出来一模一样。

   行列、间距、抖动都不设上限：要排多少人、排多开，由用户与机器自己承担。 */

import { num } from './schema.js';

/* 一个稳定的 0..1 散列：输入是整数下标，输出落在 [0,1)。 */
function hash01(i, salt) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}


/* 通用阵列：rows × cols 的网格，第一格的中心 = 节点自己的 at（偏移相对它算，不居中）。
   jitter 是确定性的位置 / 朝向 / 缩放微差；间距可负（允许重叠与反向排）。
   `opts.center` 让群众那种「整组居中」的旧语义复用同一份布局；
   `opts.clampGaps` 保留群众对负间距的夹取（通用阵列按文档「可负」不夹）。
   返回 { cells:[{at:[dx,0,dz], yaw, scale, row, col}], total }。 */
export function arrayLayout(node = {}, opts = {}) {
  const rows = Math.max(1, Math.round(num(node.rows, 1)));
  const cols = Math.max(1, Math.round(num(node.cols, 1)));
  const gapX0 = num(node.gapX, 1);
  const gapZ0 = num(node.gapZ, 1);
  const gapX = opts.clampGaps ? Math.max(0, gapX0) : gapX0;
  const gapZ = opts.clampGaps ? Math.max(0, gapZ0) : gapZ0;
  const jitter = Math.max(0, num(node.jitter, 0));
  const ox = opts.center ? -((cols - 1) / 2) * gapX : 0;
  const oz = opts.center ? -((rows - 1) / 2) * gapZ : 0;
  const want = rows * cols;
  const out = [];
  for (let i = 0; i < want; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const jx = jitter ? (hash01(i, 1) - 0.5) * jitter : 0;
    const jz = jitter ? (hash01(i, 2) - 0.5) * jitter : 0;
    const yaw = jitter ? (hash01(i, 3) - 0.5) * 24 : 0;         // 度：小幅站姿差异
    const scale = jitter ? 0.94 + hash01(i, 4) * 0.12 : 1;
    out.push({
      /* 行向 +Z、列向 +X；第 0 格在 at 上（居中时整组绕 at 摊开） */
      at: [ox + c * gapX + jx, 0, oz + r * gapZ + jz],
      yaw,
      scale,
      row: r, col: c,
    });
  }
  return { cells: out, total: want };
}

/* node: { rows, cols, gapX, gapZ, jitter, at, rot }
   返回 [{ at:[x,y,z], yaw, scale }]，按行优先排列（第 0 行在最远，朝 +Z 排）。
   群众的间距沿用旧语义：负间距夹到 0、默认 0.9、整组绕 at 居中。 */
export function crowdLayout(node = {}) {
  const view = Object.assign({}, node, {
    gapX: num(node.gapX, 0.9),
    gapZ: num(node.gapZ, 0.9),
  });
  const layout = arrayLayout(view, { center: true, clampGaps: true });
  const baseAt = Array.isArray(node.at) ? node.at : [0, 0, 0];
  return {
    people: layout.cells.map(c => ({
      at: [baseAt[0] + c.at[0], baseAt[1], baseAt[2] + c.at[2]],
      yaw: c.yaw,
      scale: c.scale,
      // 供判据与「第几个」显示：行列下标原样带出去
      row: c.row, col: c.col,
    })),
    total: layout.total,
  };
}
