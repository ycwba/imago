/* Store — localStorage 信封 { data, ts } 的唯一读写。
   从 web/ui/ui.js 拆出；加载顺序在 ui.js 之后、页面脚本之前。 */
(function () {
const ok = () => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch { return false; } };
  const isEnvelope = p => p && typeof p === 'object' && !Array.isArray(p) && Object.prototype.hasOwnProperty.call(p, 'data');
  window.Store = {
    available: ok(),
    read(key, def) {
      let raw = null;
      try { raw = localStorage.getItem(key); } catch { return def; }
      if (raw == null) return def;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { return def; }        // 坏值：当空处理，别让一条脏数据卡死整页
      if (isEnvelope(parsed)) return parsed.data;
      /* 不是信封 = 这份数据还没转换（历史上裸值也存过）。转换是一次性脚本的活（升级历史数据.cjs），
         读这里不再自动兜旧格式；只说一声，免得界面凭空少了一批记录。 */
      console.warn('[Store] ' + key + ' 不是信封格式，已按空处理；请运行一次「升级历史数据.cjs」');
      return def;
    },
    /* 返回 { ok, bytes, truncated?, dropped? }；cap 会对数组自动截断（总量控制，避免写爆配额）。
       **截断要报出来**：以前截断与写成功是同一个返回值（ok:true），
       于是「存满了 40 部，第 41 部把最旧那一部挤掉了」在界面上完全看不出来 ——
       刷新后那一集凭空消失，而用户刚点过「新建」。调用方照 `{ok}` 判就永远不知道发生了这件事。 */
    write(key, val, opts = {}) {
      let v = val;
      let dropped = 0;
      if (opts.cap && Array.isArray(v) && v.length > opts.cap) {
        dropped = v.length - opts.cap;
        v = v.slice(0, opts.cap);
      }
      /* 序列化也要包在 try 里：数据里混进 BigInt / 循环引用时 JSON.stringify 会直接抛，
         以前它在 try 之外 —— 一次脏数据就把整个保存流程打断（页面后续逻辑全不执行）。 */
      let body;
      try {
        body = JSON.stringify({ data: v, ts: Date.now() });
      } catch (e) {
        const msg = `${opts.label || '本地记录'}保存失败：数据里有无法序列化的内容（${e.message}）`;
        if (window.Toast) window.Toast.err(msg);
        console.warn('[Store] 序列化失败 ' + key + '：', e);
        return { ok: false, error: e };
      }
      try {
        localStorage.setItem(key, body);
        /* 截断过就在返回值里说明（同时 console 一句，便于事后查盘上的数据对不上） */
        if (dropped) console.warn('[Store] ' + key + ' 超出上限 ' + opts.cap + '，截掉了 ' + dropped + ' 条（' + (opts.label || key) + '）');
        return { ok: true, bytes: body.length, truncated: dropped ? opts.cap : 0, dropped };
      } catch (e) {
        const quota = /quota|exceed|full/i.test(String(e && e.name) + String(e && e.message));
        const msg = quota
          ? `${opts.label || '本地记录'}已占满浏览器存储（上限约 5MB），本次没能保存：请到「资产库」清理，或先下载到本地再清`
          : `${opts.label || '本地记录'}保存失败：${e.message}`;
        if (window.Toast) window.Toast.err(msg);
        console.warn('[Store] 写入失败 ' + key + '：', e);
        return { ok: false, error: e, quota };
      }
    },
    /* 信封里的写入时间（同步时比新旧用；老数据没有这个字段当 0） */
    tsOf(key) {
      try {
        const p = JSON.parse(localStorage.getItem(key) || 'null');
        return (p && typeof p === 'object' && !Array.isArray(p) && p.ts) ? Number(p.ts) : 0;
      } catch { return 0; }
    },
    /* 按判据清掉一批键，回个数。「倒着扫 + 就地删」这一步全站只此一份：
       以前 TextAI.clearMeta 与设置页「恢复默认」各抄一遍同样的循环，抄错的方向是正着扫 ——
       removeItem 会让后面的键整体往前挪一格，正着扫就跳过一半，「恢复默认」清完还剩一堆。
       判据（哪些键归我管）留在调用方：一张表是 `sk_model_meta_` 前缀，另一张是
       EXPORTABLE 前缀减 RESET_KEEP，两边本来就不同，只有那趟扫描是同一件事。 */
    sweep(pred) {
      let n = 0;
      for (const k of window.LS.keys()) {
        if (!k) continue;
        if (pred(k)) { window.LS.del(k); n++; }
      }
      return n;
    },
  };
})();
