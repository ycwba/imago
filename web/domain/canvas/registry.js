/* 画布节点注册表：这一页只认这里列出的类型（尺寸、能接什么、怎么生成）。
   纯数据 + 纯函数，不 import 页面、不挂 window。 */

export const NODE_TYPES = {
  text: {
    type: 'text', label: '文本', icon: 'list',
    defaultSize: { width: 260, height: 160 }, minSize: { width: 140, height: 80 },
    keepAspectRatio: false, showInCreateMenu: true,
    resourceKind: 'text', generationMode: 'none',
    acceptsInputKind: [], maxInputCount: 0,
  },
  image: {
    type: 'image', label: '图片', icon: 'image',
    defaultSize: { width: 288, height: 162 }, minSize: { width: 96, height: 54 },
    keepAspectRatio: true, showInCreateMenu: true,
    resourceKind: 'image', generationMode: 'asset',
    acceptsInputKind: ['text', 'image', 'config', 'asset-ref'], maxInputCount: 8,
  },
  video: {
    type: 'video', label: '视频', icon: 'video',
    defaultSize: { width: 320, height: 180 }, minSize: { width: 120, height: 68 },
    keepAspectRatio: true, showInCreateMenu: true,
    resourceKind: 'video', generationMode: 'asset',
    acceptsInputKind: ['text', 'image', 'config', 'asset-ref'], maxInputCount: 8,
  },
  audio: {
    type: 'audio', label: '音频', icon: 'mic',
    defaultSize: { width: 260, height: 96 }, minSize: { width: 160, height: 64 },
    keepAspectRatio: false, showInCreateMenu: true,
    resourceKind: 'audio', generationMode: 'asset',
    acceptsInputKind: ['text', 'config', 'asset-ref'], maxInputCount: 4,
  },
  config: {
    type: 'config', label: '生成配置', icon: 'gear',
    defaultSize: { width: 260, height: 180 }, minSize: { width: 200, height: 120 },
    keepAspectRatio: false, showInCreateMenu: true,
    /* 配置节点不参与素材计数：它是「用什么型号、什么提示词」这份参数，不是产物。 */
    resourceKind: 'config', generationMode: 'none',
    acceptsInputKind: [], maxInputCount: 0,
  },
  'asset-ref': {
    type: 'asset-ref', label: '资产引用', icon: 'box',
    defaultSize: { width: 220, height: 150 }, minSize: { width: 96, height: 96 },
    keepAspectRatio: false, showInCreateMenu: true,
    resourceKind: 'ref', generationMode: 'none',
    acceptsInputKind: [], maxInputCount: 0,
  },
};

/* 「哪几类节点会跑出产物」只有 generationMode 这一句：MEDIA_KINDS、节点上的生成按钮、
   生成桥的产物类型都从它派生。原来这里手写字面量，界面加一档就得记得改三处。 */
export const MEDIA_KINDS = Object.values(NODE_TYPES)
  .filter(d => d.generationMode === 'asset').map(d => d.type);

export function typeOf(t) { return NODE_TYPES[String(t || '')] || null; }
export function hasType(t) { return !!typeOf(t); }
export function labelOf(t) { const d = typeOf(t); return d ? d.label : String(t || '节点'); }
export function createMenu() { return Object.values(NODE_TYPES).filter(d => d.showInCreateMenu); }
export function defaultSize(t) { const d = typeOf(t); return d ? { ...d.defaultSize } : { width: 240, height: 160 }; }
export function minSize(t) { const d = typeOf(t); return d ? { ...d.minSize } : { width: 80, height: 60 }; }

/* 连线合法性只有这一处：两端类型、容量、是否成环、是否重复。ops 与画布页都问它，不再各写一份判据。 */
export function whyConnect(fromType, toType, existing, opts = {}) {
  const a = typeOf(fromType), b = typeOf(toType);
  if (!a || !b) return '这一端不是注册表里的节点类型';
  if (a.type === b.type && a.resourceKind === 'config') return '两个配置节点之间不连线';
  const list = b.acceptsInputKind || [];
  if (!list.includes(a.type)) return labelOf(b.type) + ' 不接受 ' + labelOf(a.type) + ' 作为输入';
  if (!opts.ignoreCount) {
    const max = b.maxInputCount || 0;
    if (max && (existing || 0) >= max) return labelOf(b.type) + ' 最多接 ' + max + ' 路输入（已经满了）';
  }
  return '';
}

/* 成环检测：新边 from→to 若让 to 又能回到 from 就是环，画布上的「生成」会变成永远等不完。 */
export function wouldCycle(connections, fromId, toId) {
  if (fromId === toId) return true;
  const next = new Map();
  for (const c of connections || []) {
    if (!next.has(c.fromNodeId)) next.set(c.fromNodeId, []);
    next.get(c.fromNodeId).push(c.toNodeId);
  }
  const seen = new Set();
  const stack = [toId];
  while (stack.length) {
    const id = stack.pop();
    if (id === fromId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of (next.get(id) || [])) stack.push(n);
  }
  return false;
}
