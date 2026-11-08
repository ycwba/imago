/* 群众阵列 —— 纯布局：把「行列 / 间距 / 抖动」算成一串实例变换。
   为什么要确定性抖动：AI 流式生成时每收全一个节点就整场重建一次，
   抖动若是 Math.random，群众会在每一次重建时整体跳一下（看起来像坏了）。
   所以抖动只由「第几行第几列」的散列决定，同一份模型每次算出来一模一样。

   行列、间距、抖动都不设上限：要排多少人、排多开，由用户与机器自己承担。 */

/* 一个稳定的 0..1 散列：输入是整数下标，输出落在 [0,1)。 */
function hash01(i, salt) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

const finite = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* node: { rows, cols, gapX, gapZ, jitter, at, rot }
   返回 [{ at:[x,y,z], yaw, scale }]，按行优先排列（第 0 行在最远，朝 +Z 排）。 */
export function crowdLayout(node = {}) {
  const rows = Math.max(1, Math.round(finite(node.rows, 1)));
  const cols = Math.max(1, Math.round(finite(node.cols, 1)));
  const gapX = Math.max(0, finite(node.gapX, 0.9));
  const gapZ = Math.max(0, finite(node.gapZ, 0.9));
  const jitter = Math.max(0, finite(node.jitter, 0));
  const want = rows * cols;
  const baseAt = Array.isArray(node.at) ? node.at : [0, 0, 0];
  const out = [];
  for (let i = 0; i < want; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const jx = jitter ? (hash01(i, 1) - 0.5) * jitter : 0;
    const jz = jitter ? (hash01(i, 2) - 0.5) * jitter : 0;
    const yaw = jitter ? (hash01(i, 3) - 0.5) * 24 : 0;         // 度：小幅站姿差异
    const sx = jitter ? 0.94 + hash01(i, 4) * 0.12 : 1;
    out.push({
      /* 行从后往前排：第 0 行在 -Z 那一侧（远处），最后一排贴着阵列原点前方 */
      at: [
        baseAt[0] + (c - (cols - 1) / 2) * gapX + jx,
        baseAt[1],
        baseAt[2] + (r - (rows - 1) / 2) * gapZ + jz,
      ],
      yaw,
      scale: sx,
      // 供判据与「第几个」显示：行列下标原样带出去
      row: r, col: c,
    });
  }
  return { people: out, total: want };
}
