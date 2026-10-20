/* 剪辑页媒资解析器：候选身份 → 预览地址 / 导出地址。
   - 身份只走 AssetLocal.localAssetIdOf（不看「优先用本机」开关）
   - 预览走 Api.mediaSrc（遵守开关）
   - 导出只要本机有副本就用 `api.assetSrc(la)`（本机地址的唯一拼法）；没有才回新鲜平台地址
   画面段、配音、切片、FCPXML 以后都只读这一份；页面不直接拼 cand.url。 */
export function createEditorMedia({ assetLocal, api, freshUrl } = {}) {
  function entryOf(cand) {
    if (!cand) return null;
    return {
      kind: 'asset',
      provider: cand.provider || '',
      assetId: cand.assetId || cand.vid || cand.id || '',
      genId: cand.genId || cand.taskId || '',
      src: cand.src || cand.url || '',
      rawSrc: cand.rawSrc || '',
      status: cand.status || '',
      name: cand.name || cand.prompt || '',
      format: cand.format || '',
    };
  }
  function localIdOf(entry) {
    const e = typeof entry === 'string' ? { src: entry } : (entry || {});
    const src = e.src || e.url || '';
    if (!assetLocal || typeof assetLocal.localAssetIdOf !== 'function') return '';
    return assetLocal.localAssetIdOf(src) || '';
  }
  function previewSrc(entry) {
    const e = typeof entry === 'string' ? { src: entry } : (entry || {});
    return api && api.mediaSrc ? api.mediaSrc(e.src || e.url || '') : (e.src || e.url || '');
  }
  function exportSrc(entry, opts = {}) {
    const e = typeof entry === 'string' ? { src: entry } : (entry || {});
    const la = localIdOf(e);
    if (la) return api.assetSrc(la);
    const src = String(e.src || e.url || '');
    if (/^\/asset\//.test(src)) return src;
    if (src && /^https?:\/\//i.test(src)) return opts.fresh || src;
    if (src && /^\/(?:getv|fetch)\?/i.test(src)) {
      if (opts.fresh) return opts.fresh;
      return src;
    }
    return src;
  }
  function canUse(entry) {
    return !!(localIdOf(entry) || (entry && (entry.src || entry.url)));
  }
  return { entryOf, localIdOf, previewSrc, exportSrc, canUse };
}
