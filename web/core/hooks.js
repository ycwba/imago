/* 关标签 / 换页前的 flush + dirty 注册表。web/app.js 调 runAll；页面只 register。 */
export function createHooks() {
  const entries = new Set();
  return {
    register(flush, dirty) {
      const e = { flush: typeof flush === 'function' ? flush : () => {}, dirty: typeof dirty === 'function' ? dirty : () => '' };
      entries.add(e);
      return () => entries.delete(e);
    },
    runAll() {
      let dirty = '';
      for (const e of entries) {
        try { e.flush(); } catch (err) {}
        try { const d = e.dirty(); if (!dirty && d) dirty = d; } catch (err) {}
      }
      return dirty;
    },
    size: () => entries.size,
  };
}
