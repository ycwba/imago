/* 页面样式表按需挂进 head —— 全站只有这一处 createElement('link')。
   href 是相对外壳文档的路径；tag 是 data-* 键（`spa-assets` → `data-spa-assets="1"`），
   同一份表按 data 键或 href 文件名已经挂过就不再插第二张（两页共用一份表是正常情况）。
   modulepreload 走的是同一个出口：同一件事（往 head 挂一枚 <link>）
   只留一处创建点，加一种 rel 只是在下面多一个包装，不是第二条注入口。 */
function mountLink(rel, href, key) {
  const l = document.createElement('link');
  l.rel = rel;
  l.href = href;
  if (key) l.setAttribute('data-' + key, '1');
  document.head.appendChild(l);
}

export function ensureCss(href, tag) {
  if (typeof document === 'undefined') return;
  const file = String(href || '').split('/').pop();
  const key = String(tag || '');
  const sel = (key ? 'link[data-' + key + '], ' : '') + 'link[href$="' + file + '"]';
  try {
    if (document.querySelector(sel)) return;
    mountLink('stylesheet', href, key);
  } catch (e) { /* 只是补一张样式表：重复 / 被 CSP 拦都退化成没有这一页的私有样式，不该让页面挂不上 */ }
}

/* 已发过预取的地址（绝对 URL）。href 属性会被浏览器归一成绝对地址，选择器比不回来时的相对写法，
   所以这一份只按「实际发出去的 URL」去重。 */
const preloaded = new Set();
/* 让这一份模块与它的静态依赖图现在就下载、解析，但不执行 —— 执行时机仍由真正的 import() 决定。 */
export function preloadModule(href) {
  if (typeof document === 'undefined' || !href) return;
  let url = String(href);
  try { url = new URL(url, document.baseURI).href; } catch (e) { return; }
  if (preloaded.has(url)) return;
  preloaded.add(url);
  try {
    mountLink('modulepreload', url, '');
  } catch (e) { /* 预取只是让后面那一次 import 更早开始：挂不上就照原样走 waterfall，不影响正确性 */ }
}
