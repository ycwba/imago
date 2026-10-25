/* ============================================================================
   AssetRef —— 素材引用的拖动载荷（唯一出口）
   ----------------------------------------------------------------------------
   拖动源（素材库 / 资产库 / 收藏 / 生成工作台）与落点（助手球 / 助手面板 / 工作台槽位）
   都只认这一份：写和读各一处，MIME 名与字段形状就不会在四个拖动源之间漂开。

   **必须是 .cjs + UMD**（AGENTS §7「素材身份」那条记的是同一个坑）：web/package.json 是
   `"type":"module"`，写成 .js 的话 Node 会把它当 ESM、浏览器又只能按经典脚本引；
   而这一份既要给经典脚本 chat.js 用，也要给 tests/asset-ref.mjs 用 —— 只有 UMD 两头成立。
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.AssetRef = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MIME = 'application/x-studio-ref';
  const MIME_ID = 'application/x-asset-id';
  /* 载荷里只留这几个字段：助手标签 / 工作台槽位 / 按需取图各读自己那一半，
     多出来的临时字段（DOM 节点、函数）一律不写进 dataTransfer —— 它只能过字符串。 */
  const FIELDS = [
    'kind', 'id', 'name', 'type', 'mtype', 'format', 'assetId', 'src', 'dl', 'fileKey',
    'prompt', 'from', 'taskId', 'genId', 'status', 'model', 'provider', 'providerName',
    'ts', 'localAsset', 'size', 'error', 'credits', 'tier', 'res', 'ar', 'dur', 'quality',
  ];
  const LOCAL_ID = /^la_/;

  function clean(src) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const k of FIELDS) {
      const v = src[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'string') { if (v) out[k] = v; continue; }
      if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
      if (k === 'credits' && typeof v === 'object') {
        const n = v.charged ?? v.held;
        if (n != null && n !== '') out[k] = n;
      }
    }
    return out;
  }

  /* 拖到地址栏 / 编辑器时的那一档：写地址或名字，**不写 JSON**（那不是给人看的） */
  function plainOf(o) {
    return String(o.src || o.dl || o.name || o.assetId || o.id || '');
  }

  /* 写一次引用拖动。返回实际写进去的那份对象（字段已按白名单收过），
     调用方可拿它去补输入框 / 队列，两边看到的是同一份。 */
  function set(dt, obj) {
    if (!dt || !obj) return null;
    const o = clean(obj);
    const json = JSON.stringify(o);
    /* setData 在个别引擎里对合成拖动会抛（受保护模式 / 非可信事件）：一种格式写不上
       就少一种接收端读法，text/plain 与 MIME 两份互不拖累。 */
    try { dt.setData('text/plain', plainOf(o)); } catch (e) { /* 丢了纯文本兜底：落点只剩引用读法 */ }
    try { dt.setData(MIME, json); } catch (e) { /* 丢了引用载荷：这次拖动当外部文本 */ }
    const aid = String(o.assetId || '');
    if (aid) { try { dt.setData(MIME_ID, aid); } catch (e) { /* 丢了产物号直读档：接收端退回完整 JSON */ } }
    try { dt.effectAllowed = 'copy'; } catch (e) { /* 设不上就按引擎默认效果走，落点自己判收不收 */ }
    return o;
  }

  /* 读一次引用拖动；没有引用（或那一段 JSON 坏了）返回 null，绝不抛。
     只剩 `application/x-asset-id` 的那种老载荷也认：本机号能直接换成 /asset/ 地址。 */
  function read(dt) {
    if (!dt) return null;
    const grab = t => { try { return String(dt.getData(t) || ''); } catch (e) { return ''; } };
    const json = grab(MIME);
    if (json) {
      try {
        const o = JSON.parse(json);
        if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
        return o;
      } catch (e) { return null; }
    }
    const aid = grab(MIME_ID).trim();
    if (!aid) return null;
    return { assetId: aid, id: aid, src: LOCAL_ID.test(aid) ? '/asset/' + aid : '' };
  }

  function isRef(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.indexOf(MIME) >= 0 || types.indexOf(MIME_ID) >= 0;
  }

  /* 人话标签：助手输入框里那行 `[引用素材：…]` 与提示词清单共用同一份拼装。
     主次与旧载荷一致（提示词优先、名字兜底），只截显示用的那一截 ——
     载荷里的 prompt 是完整的，截断只发生在这里。 */
  function label(o) {
    if (!o || typeof o !== 'object') return '';
    let main = String(o.prompt || o.name || o.assetId || o.id || '').replace(/\s+/g, ' ').trim();
    if (main.length > 48) main = main.slice(0, 48) + '…';
    const type = String(o.type || o.mtype || o.kind || '').trim();
    let s = [main, type].filter(Boolean).join(' · ');
    const aid = String(o.assetId || '').trim();
    const task = String(o.taskId || o.genId || '').trim();
    const file = String(o.fileKey || '').trim();
    if (aid) s += '（资产 ' + aid + '）';
    else if (file) s += '（本机文件 ' + file + '）';
    else if (task) s += '（任务 ' + task + '）';
    return s;
  }

  /* 标记里用的**短名**：只有「这是哪一条」的那部分（提示词优先，其次名字）。
     号与类型**不进标记** —— 标记是正文里的一行字，拖着「（资产 la_xxx）」既长又难看，
     而用户要认的是「哪一条」，不是它的内部号。
     号留给两处：悬停浮层（`.ac-ref-tip`）与发给模型的那份清单（`refBlock`）——
     那两处才真的需要它。这一份是 `label()` 的兄弟，不是它的替代。 */
  function shortLabel(o) {
    if (!o || typeof o !== 'object') return '';
    let main = String(o.prompt || o.name || '').replace(/\s+/g, ' ').trim();
    if (!main) main = String(o.assetId || o.id || '').trim();
    if (main.length > 48) main = main.slice(0, 48) + '…';
    return main;
  }

  return { MIME, MIME_ID, set, read, isRef, label, shortLabel };
});
