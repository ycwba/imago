/* Search — 联网搜索（设置 / 查询 / 读网页）。只走 Net，不裸 fetch。
   「要不要搜、搜什么」不在这里判：TextAI 的联网工具循环让模型自己发 CALL，
   本模块只执行「按给定词查询 / 读网页」。
   shell 不常驻加载：三张生成页经路由表 needs（routes.js 的 NEED_GLOBAL）先补齐，
   其余场合（设置页 / 助手首次使用 / TextAI 工具循环首次需要）按需补载。 */
(function () {
  const errOf = (e, fallback) => window.Api.errOf(e, fallback || '搜索请求失败');
  async function settings() {
    try {
      return await window.Net.json('/search/settings', { retry: 0 });
    } catch (e) { throw errOf(e, '读不到联网搜索设置'); }
  }
  async function save(patch) {
    try {
      return await window.Net.json('/search/settings', {
        method: 'PUT', retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      });
    } catch (e) { throw errOf(e, '保存联网搜索设置失败'); }
  }
  /* 查询会真的产生一次上游调用（可能计费）：不自动重试 */
  async function search(arg) {
    try {
      return await window.Net.json('/search/query', {
        method: 'POST', retry: 0, timeout: 60000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arg || {}),
      });
    } catch (e) { throw errOf(e, '搜索失败'); }
  }
  async function read(url) {
    try {
      return await window.Net.json('/search/read', {
        method: 'POST', retry: 0, timeout: 25000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url || '' }),
      });
    } catch (e) { throw errOf(e, '读网页失败'); }
  }
  /* 联网搜索的总开关状态。读不到设置就当没开（宁可不搜，也不让一次失败的设置请求
     把主任务挡下来）。 */
  async function state() {
    /* 每次都现读：设置可能在别的标签页 / 设置页刚改过，缓存一份开关会让「刚打开搜索却还是没搜」
       变成一条查不出来的假故障。 */
    let s = null;
    try { s = (await settings()).settings; }
    catch (e) { return { enabled: false, maxResults: 5, why: errOf(e, '读不到联网搜索设置').message }; }
    return { enabled: !!(s && s.enabled), maxResults: Math.max(1, Math.min(10, Number(s && s.maxResults) || 5)) };
  }
  window.Search = {
    settings, save, search, read, state,
  };
})();
