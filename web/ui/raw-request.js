/* 原始请求折叠条：把「真正发给供应商的请求体」摊开给用户看。
   两态并存：
     · 预览（`wb:raw-preview`）—— **还没发**，由 `Api.emitPreview` 算出来；
       素材槽位用占位符（真正要上传的那张图在提交那一刻才传，预览不能触发上传）。
     · 已发送（`wb:raw-request`）—— 真的发出去了的那一次，采集在 `Api.request` 那一处
       （全站唯一出口，见 api.js）。
   两者并排摆着：用户要确认的是「实际发出的提示词和配置是怎样的」，
   而「我以为要发的」与「真发出去的」不一致时，正是最该被看见的那种情况。

   为什么是一个经典脚本而不是 domain 模块：Api 是经典脚本，页面与纯模块都要在任意时刻画这块，
   而它只用 `esc` 与 DOM。判据：ui 层不 import domain，也不反向依赖页面。

   快照只活在页面会话内存里，不落盘、不进工程、不跟云同步走 ——
   完整提示词本来就有 PromptLog 归档，请求体（含首帧图摘要）没有第二份必要。 */
(function () {
  'use strict';
  const MAX_KEEP = 50;
  const snaps = new Map();        // tag → 最新一份**已发送**快照（'' 也留一份，给没有标签的调用方）
  const previews = new Map();     // tag → 最新一份**预览**快照
  const ring = [];                // 会话内最近 50 条（只在调试 / 以后做「请求记录」时用）
  const openTags = new Set();     // 用户手动展开过的宿主：导演台整栏每 3 秒重画也不收回
  /* 预览的防抖 + 防乱序：打字快时旧结果后到会把新结果盖掉（预览是纯算，但算的是大对象）。
     每个 tag 一个定时器 + 一个单调递增的号；回包号不是当前号就丢掉。 */
  const timers = new Map();
  const seqOf = new Map();
  let seq = 0;

  const E = s => (window.esc ? window.esc(s) : String(s == null ? '' : s));
  const timeOf = ts => {
    try {
      return new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) { return ''; }
  };
  const nameOf = snap => (snap && (snap.providerName || snap.provider)) || '平台';
  const summaryOf = snap => snap
    ? '原始请求 · ' + nameOf(snap) + ' · ' + timeOf(snap.at)
    : '原始请求（尚未发送）';
  const bodyText = snap => {
    if (!snap) return '生成一次后，这里会显示实际发给供应商的请求体（不含密钥 / Cookie）。';
    let body;
    try { body = JSON.stringify(snap.body, null, 2); }
    catch (e) { body = String(snap.body); }
    return (snap.method || 'POST') + ' ' + (snap.path || '') + '\n\n' + (body == null ? '' : body);
  };
  const attrs = (tag, o) => ' data-raw-tag="' + E(tag) + '"'
    + (o && o.className ? ' class="' + E(o.className) + '"' : '');

  function paint(el, snap) {
    if (!el || !el.isConnected) return;
    el.classList.toggle('waiting', !snap);
    el.classList.toggle('has-snap', !!snap);
    const sum = el.querySelector('summary');
    if (sum) sum.textContent = summaryOf(snap);
    const pre = el.querySelector('pre');
    if (pre) pre.textContent = bodyText(snap);
    if (snap && snap.label) el.title = snap.label;
  }

  function previewBodyText(pv) {
    let body;
    try { body = JSON.stringify(pv.body, null, 2); } catch (e) { body = String(pv.body); }
    return (pv.method || 'POST') + ' ' + (pv.path || '') + '\n\n' + (body == null ? '' : body);
  }

  /* 并排：预览 + 已发送。发出去之后用户能直接对比两份。 */
  function liveHTML(tag, opts) {
    const t = String(tag == null ? '' : tag);
    const pv = previews.get(t) || null;
    const sent = snaps.get(t) || null;
    const open = openTags.has('live:' + t) ? ' open' : '';
    const head = '<summary>' + E(sent
      ? '原始请求（已发送 · ' + nameOf(sent) + ' · ' + timeOf(sent.at) + '）'
      : (pv ? '原始请求（将要发送 · ' + nameOf(pv) + '）' : '原始请求（尚未发送）')) + '</summary>';
    const parts = [];
    parts.push('<div class="raw-half"><i>将要发出</i><pre>' + E(pv ? previewBodyText(pv) : '（还没有可预览的内容）') + '</pre></div>');
    parts.push('<div class="raw-half"><i>已发送</i><pre>' + E(sent ? bodyText(sent) : '（还没发过）') + '</pre></div>');
    return '<details class="raw-req live raw-both' + (sent || pv ? ' has-snap' : ' waiting') + '"'
      + attrs(t, opts) + ' data-raw-live="1" data-raw-livetag="' + E(t) + '"' + open + '>'
      + head + parts.join('') + '</details>';
  }

  function html(tag, opts) {
    const t = String(tag == null ? '' : tag);
    const snap = snaps.get(t) || null;
    const open = openTags.has(t) ? ' open' : '';
    return '<details class="raw-req' + (snap ? ' has-snap' : ' waiting') + '"'
      + attrs(t, opts) + open + '>'
      + '<summary' + (snap && snap.label ? ' title="' + E(snap.label) + '"' : '') + '>' + E(summaryOf(snap)) + '</summary>'
      + '<pre>' + E(bodyText(snap)) + '</pre>'
      + '</details>';
  }
  function htmlList(tags, opts) {
    const seen = new Set();
    const list = (tags || []).map(x => String(x || '')).filter(t => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    if (!list.length) return '';
    return '<div class="raw-req-list">' + list.map(t => html(t, opts)).join('') + '</div>';
  }
  function bind(root) {
    const els = [];
    if (root && root.matches && root.matches('details.raw-req')) els.push(root);
    if (root && root.querySelectorAll) root.querySelectorAll('details.raw-req[data-raw-tag]').forEach(x => els.push(x));
    els.forEach(el => {
      el.ontoggle = () => {
        const t = el.dataset.rawTag || '';
        /* 并排那一块（live）记住的是「live:tag」，别的（批量生成那一条）记「tag」——
           两套键分开，免得同一段文字在两处互相把对方的展开状态改了。 */
        if (el.dataset.rawLivetag) {
          const k = 'live:' + el.dataset.rawLivetag;
          if (el.open) openTags.add(k); else openTags.delete(k);
          return;
        }
        if (el.open) openTags.add(t); else openTags.delete(t);
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
  function paintPreviewsOf(tag, snap) {
    try {
      document.querySelectorAll('details.raw-req[data-raw-tag]').forEach(el => {
        const t = el.dataset.rawTag || '';
        if (t !== tag) return;
        if (!el.dataset.rawLive) return;
        const sent = snaps.get(t) || null;
        const sum = el.querySelector('summary');
        if (sum) sum.textContent = sent
          ? '原始请求（已发送 · ' + nameOf(sent) + ' · ' + timeOf(sent.at) + '）'
          : '原始请求（将要发送 · ' + nameOf(snap) + '）';
        const halves = el.querySelectorAll('.raw-half pre');
        if (halves && halves[0]) halves[0].textContent = previewBodyText(snap);
      });
    } catch (err) { /* document 已卸载时查不到宿主；快照仍留在内存，下一次渲染会带上 */ }
  }

  window.addEventListener('wb:raw-request', e => {
    const snap = e && e.detail;
    if (!snap) return;
    const tag = String(snap.tag || '');
    snaps.set(tag, snap);
    ring.push(snap);
    if (ring.length > MAX_KEEP) ring.shift();
    try {
      document.querySelectorAll('details.raw-req[data-raw-tag]').forEach(el => {
        if (el.dataset.rawTag !== tag) return;
        if (el.dataset.rawLive) {
          const sum = el.querySelector('summary');
          if (sum) sum.textContent = '原始请求（已发送 · ' + nameOf(snap) + ' · ' + timeOf(snap.at) + '）';
          const halves = el.querySelectorAll('.raw-half pre');
          if (halves && halves[1]) halves[1].textContent = bodyText(snap);
          el.classList.add('has-snap');
        } else {
          paint(el, snap);
        }
      });
    } catch (err) { /* document 已卸载时查不到宿主；快照仍留在内存，下一次渲染会带上 */ }
  });

  /* 页面把「这一格将要发什么」交给它（**主动投递**）：
     `setPreview(tag, { label, provider, providerName, endpoint, method, path, body })`。
     body 已经是 `Api.snapOf` 压过的形状（页面用 `Api.preview` 算出来的那一份）。
     走一个函数而不是让每个页面各自拼一份快照对象 —— 三处各拼一次迟早字段名对不上。
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
    html,
    htmlList,
    liveHTML,
    bind,
    schedule,
    setPreview,
    last: tag => snaps.get(String(tag || '')) || null,
    lastPreview: tag => previews.get(String(tag || '')) || null,
    isOpen: tag => openTags.has(String(tag || '')),
    open: tag => { openTags.add(String(tag || '')); },
    close: tag => { openTags.delete(String(tag || '')); },
    all: () => ring.slice(),
    bodyText,
    summaryOf,
  };
})();
