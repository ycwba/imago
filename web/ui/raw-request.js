/* 原始请求面板：把「本次将要发给供应商的请求体」摊开给用户看。
   只有一栏——**发出前的预览**：页面用 `RawRequest.schedule` 算（`Api.preview` 与 `Api.create`
   同源，素材槽位用占位说明：真正要上传的那张图在提交那一刻才传，预览不能触发上传），
   改了提示词 / 参数它就跟着变；按钮收成一小颗药丸，正文吃满整宽。
   发出去的那一份**不另存、不回看**：归档里的完整提示词（PromptLog）是事后查证的入口。
   为什么是一个经典脚本而不是 domain 模块：Api 是经典脚本，页面与纯模块都要在任意时刻画这块，
   而它只用 `esc` 与 DOM。判据：ui 层不 import domain，也不反向依赖页面。

   预览快照只活在页面会话内存里，不落盘、不进工程、不跟云同步走。 */
(function () {
  'use strict';
  const previews = new Map();     // tag → 最新一份**预览**快照
  const openTags = new Set();     // 用户手动展开过的宿主：导演台整栏每 3 秒重画也不收回
  /* 预览的防抖 + 防乱序：打字快时旧结果后到会把新结果盖掉（预览是纯算，但算的是大对象）。
     每个 tag 一个定时器 + 一个单调递增的号；回包号不是当前号就丢掉。 */
  const timers = new Map();
  const seqOf = new Map();
  let seq = 0;

  const E = s => (window.esc ? window.esc(s) : String(s == null ? '' : s));
  const nameOf = snap => (snap && (snap.providerName || snap.provider)) || '平台';
  /* 一份快照的正文（方法 + 路径 + JSON 体）。 */
  const bodyText = snap => {
    if (!snap) return '';
    let body;
    try { body = JSON.stringify(snap.body, null, 2); }
    catch (e) { body = String(snap.body); }
    return (snap.method || 'POST') + ' ' + (snap.path || '') + '\n\n' + (body == null ? '' : body);
  };
  const attrs = (tag, o) => ' data-raw-tag="' + E(tag) + '"'
    + (o && o.title ? ' data-raw-title="' + E(o.title) + '"' : '')
    + (o && o.className ? ' class="' + E(o.className) + '"' : '');

  /* 预览这一块只显示**本次输入将要发出的那一份**：改了提示词 / 参数它就跟着变。
     标题行只说「这是按当前输入算出来的、会发给哪一家」——不写「已发送」，因为正文始终是
     将要发的那一份，不是发出去的那一份。 */
  function pvHeadHTML(tag) {
    const pv = previews.get(String(tag == null ? '' : tag)) || null;
    return '<b class="raw-title">原始请求</b>'
      + '<span class="raw-chip' + (pv ? ' ok' : '') + '">' + E(pv ? ('预览 · ' + nameOf(pv)) : '尚未算出') + '</span>';
  }

  function liveHTML(tag, opts) {
    const t = String(tag == null ? '' : tag);
    const pv = previews.get(t) || null;
    const open = openTags.has('live:' + t) ? ' open' : '';
    return '<details class="raw-req live' + (pv ? ' has-snap' : ' waiting') + '"'
      + attrs(t, opts) + ' data-raw-live="1" data-raw-livetag="' + E(t) + '"' + open + '>'
      + '<summary>' + pvHeadHTML(t) + '</summary>'
      + '<pre>' + E(pv ? bodyText(pv) : '（还没有可预览的内容）') + '</pre>'
      + '</details>';
  }

  function bind(root) {
    const els = [];
    if (root && root.matches && root.matches('details.raw-req')) els.push(root);
    if (root && root.querySelectorAll) root.querySelectorAll('details.raw-req[data-raw-tag]').forEach(x => els.push(x));
    els.forEach(el => {
      el.ontoggle = () => {
        /* live 块记住的是「live:tag」：导演台整栏每 3 秒重画也不收回展开状态。 */
        if (el.dataset.rawLivetag) {
          const k = 'live:' + el.dataset.rawLivetag;
          if (el.open) openTags.add(k); else openTags.delete(k);
        }
      };
    });
  }

  /* 页面把「这一格将要发什么」交给它：去抖 300ms + 防乱序。
     `fn` 返回一份预览快照（或抛错 —— 抛错就当「暂时算不出来」，面板保持上一份，
     不显示空 JSON）。 */
  function schedule(tag, fn, delay) {
    const t = String(tag == null ? '' : tag);
    const my = ++seq;
    seqOf.set(t, my);
    const old = timers.get(t);
    if (old) clearTimeout(old);
    const wait = delay == null ? 300 : Math.max(0, delay);
    timers.set(t, setTimeout(() => {
      timers.delete(t);
      if (seqOf.get(t) !== my) return;                 // 已经有更新的了，丢掉这一份
      let snap = null;
      try { snap = fn(); } catch (e) { snap = null; }  // 算不出来就保持上一份
      if (seqOf.get(t) !== my) return;
      if (snap) {
        /* 走 setPreview 那一处（快照长什么样只有一份定义） */
        setPreview(t, snap);
      }
    }, wait));
  }

  /* 预览变了：把标题那一行与预览正文一起更新（导演台整栏每 3 秒重画，不必回读 DOM）。 */
  function paintPreviewsOf(tag, snap) {
    try {
      document.querySelectorAll('details.raw-req[data-raw-tag]').forEach(el => {
        const t = el.dataset.rawTag || '';
        if (t !== tag) return;
        if (!el.dataset.rawLive) return;
        const sum = el.querySelector('summary');
        if (sum) sum.innerHTML = pvHeadHTML(t);
        const pre = el.querySelector('pre');
        if (pre) pre.textContent = snap ? bodyText(snap) : '（还没有可预览的内容）';
        el.classList.toggle('has-snap', !!snap);
        el.classList.toggle('waiting', !snap);
      });
    } catch (err) { /* document 已卸载时查不到宿主；快照仍留在内存，下一次渲染会带上 */ }
  }

  /* 页面把「这一格将要发什么」交给它（**主动投递**）：
     `setPreview(tag, { label, provider, providerName, endpoint, method, path, body })`。
     body 已经是 `Api.snapOf` 压过的形状（页面用 `Api.preview` 算出来的那一份）。
     走一个函数而不是让每个页面各自拼一份快照对象 —— 多处各拼一次迟早字段名对不上。
     预览**只**走这一个入口：再开一条事件通道就多一种投递方式，两种写法迟早对不上。 */
  function setPreview(tag, snap) {
    const t = String(tag == null ? '' : tag);
    if (!snap) { previews.delete(t); paintPreviewsOf(t, null); return null; }
    const s = Object.assign({ at: Date.now() }, snap, { tag: t });
    previews.set(t, s);
    paintPreviewsOf(t, s);
    return s;
  }

  window.RawRequest = {
    schedule,
    setPreview,
    liveHTML,
    bind,
  };
})();
