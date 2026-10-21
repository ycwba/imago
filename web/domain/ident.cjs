/* 素材身份 —— 全项目**只有这一份**「两个地址是不是同一份素材」的底层判据。
 *
 * 为什么单独一个文件：这条判据同时被两个运行环境用 ——
 *   · 浏览器（api.js / workbench.js 靠它算缩略图缓存键、跨页去重、签名过期回源）
 *   · Node（proxy.js 的 /local-assets 落盘闸靠它判断「这份产物本机有没有存过」）
 * 两边各写一份正则就一定会漂：哪天有人给签名参数加一个 x-custom-* 而只改了一边，
 * 就会出现「客户端认为是新产物、代理认为已存过」那种对不上的组合 ——
 * 同一份产物被反复下载落盘（实测过：290 行索引只对应 83 份产物，
 * 磁盘 0.45GB 里真正在用的只有 0.08GB），资产库里同一张卡重复出现 N 次。
 *
 * 没有构建步骤（页面是纯前端 + 一个 Node 代理，两边没有 bundler），
 * 所以写成双模式：浏览器当普通 <script> 引（挂 window.MediaId），Node 侧 require('./ident.cjs')。
 * 必须是 .cjs：type:module 下 .js 会被当 ESM，require(esm) 把 UMD 的 module.exports 赋值悄悄吞掉；.cjs 强制 CJS。
 *
 * 硬约定：**不要在这里再加第二份，也不要在调用方就地兜底一份**。
 * ident.cjs 没加载就让 api.js 在解构那一行当场炸 —— 早崩比悄悄退回第二份判据好得多。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.MediaId = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 内层地址里「每次签名都会变」的参数：剥掉它们，同一份素材才认得出是同一份
     （缓存键、回源结果、去重全靠这个身份；其余 query 保留并排序 —— 有的平台把区分素材的
     id 放在 query 里，只留 host+path 会让不同素材撞成同一个）。 */
  const VOLATILE_Q = /^(expires|signature|ossaccesskeyid|x-oss-[a-z-]+|key-pair-id|x-amz-[a-z0-9-]+|auth_key|policy|token|nonce|cachebust|r|v)$/i;

  /* /getv?url=<内层> 与 /fetch?url=<内层>&dl=1 都包着签名外链，取内层时两种都认。
     纯字符串处理、不碰 DOM / 不碰 location，所以代理那边 require 同一份也安全。 */
  function innerMedia(u) {
    const s = String(u == null ? '' : u);
    if (!s) return '';
    const m = /^\/(?:getv|fetch)\?[^#]*?\burl=([^&]+)/i.exec(s);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return /^https?:\/\//i.test(s) ? s : '';
  }

  /* 一个**已经 new URL 解析过**的地址 → 素材身份：host + path + 去掉易变参数后的 query（按 key 排序）。
     解析留给调用方（浏览器有相对地址、要拿 location.href 当 base；代理那边只吃绝对外链），
     这里只管「剥哪些参数、怎么拼」—— 那才是会漂的那一部分。
     host 直接用 x.host，不再 toLowerCase()：WHATWG URL 规范已经把 host 规范成小写了
     （实测 new URL('https://EXAMPLE.COM/x').host === 'example.com'），多写一次只是看着像在防什么。 */
  function upKeyOf(x) {
    const keep = [...x.searchParams.entries()]
      .filter(([k]) => !VOLATILE_Q.test(k))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => k + '=' + v);
    return x.host + x.pathname + (keep.length ? '?' + keep.join('&') : '');
  }

  return { VOLATILE_Q, innerMedia, upKeyOf };
});