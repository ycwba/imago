/* 本机/云端徽标的状态与文案：五页只读这一份，不各拼一套。 */
export function badgeOf(state, show = true) {
  if (!show) return { show: false, label: '', cls: '', why: '' };
  const local = !!(state && state.local);
  const cloud = !!(state && state.cloud);
  if (!local && !cloud) return { show: false, label: '', cls: '', why: '' };
  const cls = local && cloud ? 'both' : local ? 'local' : 'cloud';
  const label = local && cloud ? '本机+云端' : local ? '本机' : '云端';
  const why = local && cloud ? '本机与平台各有一份'
    : local ? '只在本机（本地上传或本机资产库）' : '只有平台地址';
  return { show: true, label, cls, why };
}

/* 字符串渲染那一族（页面 / 工作台 / 资产库 / 素材选择器拼 innerHTML 或 v-html）用的同一颗徽标。
   全站只有这一份拼法：以前 Vue 收藏页另有一个 23 行的 `<LocalBadge>` 组件，命令式那几页各自手写
   label 三元表达式 —— 于是 studio 那一份没有 title（悬停说不出「为什么算云端」），资产库那一份
   连 cls 的拼法都不一样。现在两族都读本文件，页面只用 `badgeHTML`。
   插进去的三段文字都是本文件写死的（不含用户数据），所以不需要转义。 */
export function badgeHTML(state, show = true) {
  const b = badgeOf(state, show);
  return b.show ? `<span class="srcbadge ${b.cls}" title="${b.why}">${b.label}</span>` : '';
}

/* 命令式那一层的入口（经典脚本不能 import，只能取全局）。shell.html 用一条 module script
   把这份模块带进页面，所以任何用户操作发生在这里之前，下面两个名字已经挂好。
   写 `globalThis` 而不是 `window`：这份模块在 node 判据里也要能被 import（tests/core.mjs）。 */
globalThis.badgeOf = badgeOf;
globalThis.badgeHTML = badgeHTML;
