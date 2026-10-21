/* Search — 联网搜索（设置 / 查询 / 读网页）。只走 Net，不裸 fetch。
   shell 不常驻加载；设置页与助手首次使用时 __spaLoadScript('web/domain/search.js', () => window.Search)。 */
(function () {
  let cached = null;
  const errOf = (e, fallback) => window.Api.errOf(e, fallback || '搜索请求失败');
  async function settings() {
    try {
      const d = await window.Net.json('/search/settings', { retry: 0 });
      cached = d.settings || null;
      return d;
    } catch (e) { throw errOf(e, '读不到联网搜索设置'); }
  }
  async function save(patch) {
    try {
      const d = await window.Net.json('/search/settings', {
        method: 'PUT', retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      });
      cached = d.settings || null;
      return d;
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
  window.Search = {
    settings, save, search, read,
    cache: () => cached,
  };
})();
