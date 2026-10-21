/* 公共 UI 目录（页面唯一入口）。当前已迁移的公共组件从这里导出；
   其余组件继续逐个迁入后加到这里，页面不允许深路径引用。 */
export { badgeOf, badgeHTML } from './badge-state.js';
