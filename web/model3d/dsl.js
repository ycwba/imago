/* DSL 展开 —— 把「镜像 / 阵列 / 引用另一个模型」这三件事在**进场景之前**做掉。
   为什么放在建模之前而不是渲染时：坏数据必须在这里被数出来（丢了多少个、撞了几层环），
   场景层只该看到一棵干净的、可以直接建网格的树。

   唯一的硬规则是**同一条引用链上不许出现同一个模型**（防环）——环会让流式重建直接卡死。
   引用层数、展开后的节点数都不设上限：用户要引用多深就多深，规模由机器自己承担。 */

import { walkNodes } from './schema.js';
import { arrayLayout } from './crowd.js';

/* 一个节点要额外复制几份、各自带什么偏移。
   `array` 是通用阵列（rows × cols，第一格落在节点自己的 at 上）；
   `repeat` 在每个阵列格上再排一列；`mirror` 把前面展开出来的全部再镜像一份。
   jitter 的位置 / 朝向 / 缩放微差由 arrayLayout 给（确定性，重建不跳）。 */
export function variantsOf(node) {
  const cells = (node && node.array) ? arrayLayout(node.array).cells : [{ at: [0, 0, 0], yaw: 0, scale: 1 }];
  const rep = node && node.repeat;
  const n = rep && rep.n > 1 ? Math.max(1, Math.round(rep.n)) : 1;
  const out = [];
  for (const cell of cells) {
    for (let i = 0; i < n; i++) {
      out.push({
        at: [
          cell.at[0] + (i ? rep.dx * i : 0),
          cell.at[1] + (i ? rep.dy * i : 0),
          cell.at[2] + (i ? rep.dz * i : 0),
        ],
        mirrorX: false,
        yaw: cell.yaw || 0,
        scale: cell.scale == null ? 1 : cell.scale,
      });
    }
  }
  if (node && node.mirror === true) {
    const base = out.slice();
    for (const v of base) out.push({ at: [v.at[0], v.at[1], v.at[2]], mirrorX: true, yaw: v.yaw, scale: v.scale });
  }
  return out;
}

export function cloneNodeForVariant(node, variant) {
  const copy = JSON.parse(JSON.stringify(node));
  /* 镜像要连位置一起翻：只把 scale.x 取负会把几何镜像、位置留在原处（左右就不对称了）。
     翻转与 scale.x=-1 是一对，缺一半就是「镜像到旁边去了」。 */
  const x = copy.at[0] + variant.at[0];
  copy.at = [variant.mirrorX ? -x : x, copy.at[1] + variant.at[1], copy.at[2] + variant.at[2]];
  const yaw = Number(variant.yaw) || 0;
  if (yaw) copy.rot = [copy.rot[0], copy.rot[1] + yaw, copy.rot[2]];
  const s = variant.scale == null ? 1 : Number(variant.scale);
  if (Number.isFinite(s) && s !== 1) {
    copy.scale = [copy.scale[0] * s, copy.scale[1] * s, copy.scale[2] * s];
  }
  delete copy.mirror;
  delete copy.repeat;
  delete copy.array;
  return { node: copy, mirrorX: !!variant.mirrorX };
}

/* 引用解析：把 `{kind:'ref', model:'组/名'}` 换成那个模型的根节点（包在一个 group 里，
   位置 / 旋转 / 缩放照引用节点自己身上的值）。`load(id)` 由调用方给（页面给 vault.load，
   判据给一个假 loader）—— 这一层不认识网络也不认识磁盘。

   返回 { nodes, dropped: { ref: 0, cycle: 0, missing: 0 }, notes: [] } */
export async function resolveRefs(nodes, load, opts = {}) {
  const dropped = { ref: 0, cycle: 0, missing: 0 };
  const notes = [];
  const chain = opts.chain || [];

  async function walk(list) {
    const out = [];
    for (const node of list || []) {
      if (node.kind !== 'ref') {
        if (node.children && node.children.length) {
          node.children = await walk(node.children);
        }
        out.push(node);
        continue;
      }
      const id = String(node.model || '');
      if (!id) { dropped.ref += 1; continue; }
      if (chain.indexOf(id) >= 0) {
        dropped.cycle += 1;
        notes.push('引用了自己（' + id + '），这一处已跳过');
        continue;
      }
      let doc = null;
      try {
        doc = await load(id);
      } catch (e) {
        doc = null;
      }
      if (!doc || !doc.scene || !Array.isArray(doc.scene.nodes)) {
        dropped.missing += 1;
        notes.push('找不到被引用的模型：' + id);
        continue;
      }
      const inner = await resolveRefs(JSON.parse(JSON.stringify(doc.scene.nodes)), load,
        { chain: chain.concat([id]) });
      dropped.ref += inner.dropped.ref;
      dropped.cycle += inner.dropped.cycle;
      dropped.missing += inner.dropped.missing;
      for (const n of inner.notes) notes.push(n);
      out.push({
        kind: 'group',
        id: node.id,
        name: node.name || ('引用 ' + id),
        at: node.at, rot: node.rot, scale: node.scale,
        visible: node.visible, locked: node.locked,
        children: inner.nodes,
        _refOf: id,
      });
    }
    return out;
  }

  const out = await walk(nodes);
  return { nodes: out, dropped, notes };
}

/* 展开后清点节点数（页面与 scene 都读这一份，别各数一遍）。 */
export function countExpanded(nodes) {
  let n = 0;
  walkNodes(nodes, () => { n += 1; });
  return n;
}
