/* ============================================================================
   PageReport —— 页面侧错误唯一的出口
   以前三条通道互不相通：`Toast` 只管用户动作的回执、`ErrBanner` 只接 window.error、
   服务端那本健康账（`server/health.js`）只记代理自己的事。于是页面 boot 挂了
   只写进那一页的局部状态，用户看见一张空页，「设置 → 本机环境 → 代理健康」里一无所知。
   现在两类都从这一个口子出去（对外只有这两个方法，别在页面里再拼一份 fetch）：
     fatal(message)     → 顶部横幅（`ErrBanner`，显示仍只有那一份）+ POST /client-error 进代理的账
     pageFail(页, 那一句) → 只进账，不吵横幅：页面自己会画失败块或已经用 Toast 念过
   两个 window 监听器也只在这一处装（ui.js 那一份已经搬过来，页面里不要再写第三个）。
   资源加载失败（图片 / 视频 404）故意不报：那多半是过期签名外链，公共层有回退与
   「已丢失」角标（assetlib.js 的 AssetLocal），混进来只会把真错误淹掉。
   上报本身绝不许再抛错 —— 这条是错误通道，它自己出事时最不该又变成一个错误。
   ========================================================================== */
(function () {
  'use strict';
  const sent = new Map();                 // 归一化消息 → 上次发出时间（本地这一道先挡一层）
  const DEDUP_MS = 5000;
  const MAX_LEN = 160;
  let dropped = 0;                        // 被本地去重吃掉多少条（doctor 里念得出来）
  const cut = s => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > MAX_LEN ? t.slice(0, MAX_LEN) + '…' : t; };
  const pageId = () => {
    try {
      const h = String(location.hash || '').replace(/^#\/?/, '').split(/[?/]/)[0];
      return h || (document.body && document.body.dataset ? document.body.dataset.page : '') || 'shell';
    } catch (e) { return 'shell'; }
  };
  function stackAt(err) {
    const lines = String((err && err.stack) || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^at\s/.test(l)) return cut(l.replace(/^at\s+/, ''));
    }
    return '';
  }
  /* fetch 用原生那条：这一层在 net.js 之前也可能被装上（boot 早期），
     而且它要的只是「尽力送到」，重试 / 超时那一套在这里反而是负担。 */
  function post(body) {
    try {
      const p = fetch('/client-error', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), credentials: 'same-origin', keepalive: true,
      });
      if (p && p.catch) p.catch(() => {});        // 代理没起 / 被限流：都不许变成一个新的未处理 Promise
    } catch (e) { /* 发送失败不再自己报错：这就是那条错误通道本身 */ }
  }
  function emit(kind, message, where) {
    const msg = cut(message);
    if (!msg) return;
    const key = kind + '|' + msg;
    const now = Date.now();
    const last = sent.get(key) || 0;
    if (now - last < DEDUP_MS) { dropped++; return; }
    sent.set(key, now);
    if (sent.size > 60) { for (const [k, v] of sent) { if (now - v > DEDUP_MS) sent.delete(k); } }
    post({ kind, message: msg, where: cut(where || ''), page: pageId(), at: now });
  }
  window.PageReport = {
    fatal(message, where, err) {
      const msg = cut(message) || '未知错误';
      if (window.ErrBanner) window.ErrBanner.show(window.esc ? window.esc('出错了：' + msg) : msg, 'err');
      emit('fatal', msg, where || stackAt(err));
      return msg;
    },
    /* 页面 boot 那一趟没跑起来（也包括 Vue 的 errorHandler）：页面自己会画失败块或已经用 Toast
       念过那一句，所以这里**只进账、不再弹第二次** —— 不然「打开就是空的」在
       「设置 → 本机环境 → 代理健康」里查不到任何痕迹。 */
    pageFail(page, message, err) {
      emit('warn', '[' + cut(page, 20) + '] ' + cut(message), stackAt(err));
    },
    doctor() {
      return { 已报条数: sent.size, 本地去重掉: dropped, 最近几条: [...sent.keys()].slice(-4).join(' / ') };
    },
  };
  window.addEventListener('error', e => {
    if (!e || !e.message) return;                 // 资源加载失败那一种没有 message，正好不管
    const at = e.filename ? '（' + String(e.filename).split('/').pop() + ':' + e.lineno + '）' : '';
    const msg = '脚本错误：' + e.message + at;
    if (window.ErrBanner) window.ErrBanner.show(window.esc ? window.esc(msg) : msg, 'err');
    emit('fatal', msg, stackAt(e.error));
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    const t = (window.errText ? errText(r) : String((r && r.message) || r || ''));
    const msg = '未处理错误：' + cut(t);
    if (window.ErrBanner) window.ErrBanner.show(window.esc ? window.esc(msg) : msg, 'err');
    emit('fatal', msg, stackAt(r));
    console.error(r);
  });
})();
