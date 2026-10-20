/* 页面 / 标签页可见性唯一判据。路由与 visibilitychange 都只更新这里，轮询/切片订阅它。 */
export function createActivity({ getRoute, doc = globalThis.document, win = globalThis } = {}) {
  const listeners = new Set();
  let pageVisible = true;
  let last = null;
  const visible = pageFile => {
    const route = typeof getRoute === 'function' ? getRoute() : getRoute;
    const file = route && (route.file || route);
    return !(doc && doc.hidden) && pageVisible !== false && (!pageFile || file === pageFile);
  };
  const notify = () => {
    const now = { pageVisible };
    last = now;
    for (const fn of listeners) { try { fn(now); } catch (e) {} }
  };
  const setPageVisible = v => { if (pageVisible !== v) { pageVisible = !!v; notify(); } };
  const onVisibility = () => notify();
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
  return {
    visible,
    /* 当前前台页的文件名（公共件按页登记配置时用它当键，例如灯箱那一份）。
       页面自己不该再去读 location.hash 猜——判据只有这一份。 */
    file: () => {
      const route = typeof getRoute === 'function' ? getRoute() : getRoute;
      return (route && (route.file || route)) || null;
    },
    setPageVisible,
    last: () => last,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      listeners.clear();
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
