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
export function trackColorOf(i) {
  const n = Math.abs(Math.round(Number(i) || 0));
  return TRACK_COLORS[n % TRACK_COLORS.length];
}
