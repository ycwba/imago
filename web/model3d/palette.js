/* 白膜的取色表 —— 全站唯一一处。
   为什么这些值不放在 tokens.css：它们不进 CSS，进的是 three 的材质与场景背景，
   而 `MeshStandardMaterial` 读不到 `var(--x)`（tokens 里还有 oklch 与 color-mix，
   解析成本比这份表的收益高得多）。白膜是**画面里的像素**，和导出成片一样不跟主题走：
   同一个模型在浅色与深色主题下必须渲出同一张参考图，否则拿去生成时构图会变。
   判据 G4（裸色值）为这一份登记了一行，理由就是上面这句。 */

/* 灰阶三档：主体（亮）/ 次要（中）/ 深色点缀（暗）。白膜只收这三档，不收十六进制色，
   AI 写模型时也只能在这三档里挑 —— 这才是「白膜」而不是「带贴图的模型」。 */
export const CLAY = { hi: 0xf1efeb, mid: 0xd8d3cb, lo: 0xb2aba1 };
/* 眼睛 / 嘴这类细部：比 lo 再深一档，靠明暗差读出来，不靠颜色。 */
export const CLAY_DETAIL = 0x3a3733;
/* 地台：白膜的底。取很浅的中性灰，压住白模不飘。 */
export const GROUND = 0xe8e5e0;
/* 场景背景（没有全景图时的摄影棚底）：上浅下深的竖向渐变由 fog + 背景色近似。 */
export const SKY = 0xf6f5f2;
export const FOG = 0xecebe7;
/* 网格线：细线走 GRID，五格加粗走 GRID_BOLD。 */
export const GRID = 0xc9c3ba;
export const GRID_BOLD = 0xa8a199;
/* 选中框与三轴（进 GL 的那一份；界面上那颗按钮的颜色仍走令牌）。 */
export const SELECT = 0x6d5cf5;

/* 轨道色：只用于视口里的路径线与轨道行的色点，是画面像素，不跟主题走。
   索引不设上限，取模落到这六档。 */
export const TRACK_COLORS = [0x6d5cf5, 0x2f9e8f, 0xd08a2e, 0xc0504d, 0x3f72c4, 0x5c8f3a];

export function toneOf(tone) {
  return CLAY[tone] != null ? CLAY[tone] : CLAY.hi;
}
/* 节点自己的颜色：只收 `#rgb` / `#rrggbb`，写错就当没写（白模灰阶）。
   颜色会沿父子树继承：给实体根 group 上色，整件的零件都换色。 */
export function nodeColorOf(node) {
  const raw = node && node.color;
  if (!raw) return null;
  const s = String(raw).trim();
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s) ? s : null;
}
/* 涂鸦标注的颜色是语义（给 AI 的结构化输入），不是装饰：
   蓝 = 相机路径 / 黄 = 主体运动 / 红 = 避开 / 绿 = 保留 / 白 = 说明 / 灰与黑 = 背景参考。
   这些是画在三维里的像素，不跟主题走（与白膜同一份理由）。 */
export const SKETCH = {
  blue: 0x2f6fd0,
  yellow: 0xe0a52e,
  red: 0xc0392b,
  green: 0x2f9e44,
  white: 0xf5f5f2,
  gray: 0x8a8a86,
  black: 0x24242a,
};

export function trackColorOf(i) {
  const n = Math.abs(Math.round(Number(i) || 0));
  return TRACK_COLORS[n % TRACK_COLORS.length];
}

/* 布光预设：一组 `lights[]` + `light` 装置的整套替换，面板上点一下换一套。
   `null` = 用内置默认（schema 的 defaultLights / defaultLightDev，与旧画面逐字节一致）。
   这些是「打光方案」而不是取色，放在这里是因为它们同样属于画面常量、不跟主题走。 */
export const LIGHT_PRESETS = [
  { id: 'default', name: '默认白膜', lights: null, light: null },
  {
    id: 'three', name: '三点布光',
    lights: [
      { id: 'l-key', name: '主光', shape: 'sun', at: [3.6, 4.6, 4.0], target: [0, 0.9, 0], energy: 2.4, color: '#ffffff', shadow: { on: true, mapSize: 2048, bias: -0.0005, normalBias: 0.02 } },
      { id: 'l-fill', name: '补光', shape: 'sun', at: [-4.2, 2.6, 3.2], target: [0, 0.9, 0], energy: 0.7, color: '#ffffff' },
      { id: 'l-rim', name: '轮廓光', shape: 'sun', at: [0.8, 3.4, -4.6], target: [0, 1.2, 0], energy: 1.1, color: '#dfe8ff' },
    ],
    light: { hemi: { sky: '#ffffff', ground: '#d9d4cc', energy: 1.1 }, ground: { color: '#1a1a1a', opacity: 0.16 }, exposure: 1 },
  },
  {
    id: 'rim', name: '侧逆光',
    lights: [
      { id: 'l-key', name: '侧逆光', shape: 'sun', at: [-4.4, 3.2, -3.6], target: [0, 1, 0], energy: 1.8, color: '#fff4e6', shadow: { on: true, mapSize: 2048, bias: -0.0005, normalBias: 0.02 } },
      { id: 'l-fill', name: '正面补光', shape: 'sun', at: [2.8, 1.6, 4.2], target: [0, 0.8, 0], energy: 0.35, color: '#ffffff' },
    ],
    light: { hemi: { sky: '#ffffff', ground: '#d9d4cc', energy: 0.9 }, ground: { color: '#1a1a1a', opacity: 0.16 }, exposure: 1 },
  },
  {
    id: 'flat', name: '无影平光',
    lights: [],
    light: { hemi: { sky: '#ffffff', ground: '#e9e6e0', energy: 2.2 }, ground: { color: '#1a1a1a', opacity: 0.08 }, exposure: 1 },
  },
];
