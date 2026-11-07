/* 原始请求面板：把「真正发给供应商的请求体」摊开给用户看。
   两种用法、同一套快照：
     · `liveHTML`（工作台 / 导演台常驻）—— 只显示**本次输入将要发出的那一份请求**：
       页面用 `RawRequest.schedule` 算（`Api.preview` 与 `Api.create` 同源，
       素材槽位用占位说明：真正要上传的那张图在提交那一刻才传，预览不能触发上传）。
       改了提示词 / 参数它就跟着变；按钮收成一小颗药丸，正文吃满整宽。
     · `html` / `htmlList`（素材库与批量生成的结果）—— 显示**真发出去的那一次**，
       采集在 `Api.request` 那一处（全站唯一出口，见 api.js），供事后回看。

   为什么是一个经典脚本而不是 domain 模块：Api 是经典脚本，页面与纯模块都要在任意时刻画这块，
   而它只用 `esc` 与 DOM。判据：ui 层不 import domain，也不反向依赖页面。

   快照只活在页面会话内存里，不落盘、不进工程、不跟云同步走 ——
   完整提示词本来就有 PromptLog 归档，请求体（含首帧图摘要）没有第二份必要。 */
(function () {
  'use strict';
  const snaps = new Map();        // tag → 最新一份**实发**快照
  const previews = new Map();     // tag → 最新一份**预览**快照
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
  /* 一份快照的正文（方法 + 路径 + JSON 体）：预览与实发走的是同一份排版。 */
  const bodyText = snap => {
    if (!snap) return '';
    let body;
    try { body = JSON.stringify(snap.body, null, 2); }
    catch (e) { body = String(snap.body); }
    return (snap.method || 'POST') + ' ' + (snap.path || '') + '\n\n' + (body == null ? '' : body);
  };
  /* 逐字比两份正文：只比 body（方法与路径是同一份生成逻辑，比了也是自己跟自己比）。 */
  const sameBody = (a, b) => {
    if (!a || !b) return true;
    try { return JSON.stringify(a.body) === JSON.stringify(b.body); }
    catch (e) { return true; }
  };
  const attrs = (tag, o) => ' data-raw-tag="' + E(tag) + '"'
    + (o && o.className ? ' class="' + E(o.className) + '"' : '');

  /* ---------- 标题那一行：统一的说法 ----------
     标题永远是「原始请求」；右边一枚状态标说清现在是什么状态：
       尚未发送（什么都没算出来）/ 预览中（算出来了，还没发）/ 已发送 · 平台 · 时间。
     实发那一栏与发出去当时的预览对不上时，标题后面再挂一句提醒。 */
  function reqStateOf(tag) {
    const t = String(tag == null ? '' : tag);
    const sent = snaps.get(t) || null;
    const pv = previews.get(t) || null;
    if (sent) {
      return {
        kind: 'sent',
        chip: '已发送 · ' + nameOf(sent) + ' · ' + timeOf(sent.at),
        diff: sent.previewAtSend ? !sameBody(sent.previewAtSend, sent) : false,
      };
    }
    if (pv) return { kind: 'preview', chip: '预览中 · ' + nameOf(pv), diff: false };
    return { kind: 'none', chip: '尚未发送', diff: false };
  }
  function headHTML(tag) {
    const st = reqStateOf(tag);
    return '<b class="raw-title">原始请求</b>'
      + '<span class="raw-chip ' + (st.kind === 'sent' ? 'ok' : '') + '">' + E(st.chip) + '</span>'
      + (st.diff ? '<span class="raw-warn" title="平台改写了请求体，或预览算得不准">这次发出去的与当时的预览不一致</span>' : '');
  }

  /* 预览这一块只显示**本次输入将要发出的那一份**：改了提示词 / 参数它就跟着变。
     以前这里并排摆两栏（预览 + 实发最近一次），预览被挤成半宽、正文更容易看串行；
     「真发出去的那一份」只在少数需要回看的落点用单栏快照（`html` / `htmlList`）。 */
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

  /* 预览块的标题：状态标只说「这是按当前输入算出来的、会发给哪一家」——
     不写「已发送」，因为正文始终是**将要发**的那一份，不是发出去的那一份。 */
  function pvHeadHTML(tag) {
    const pv = previews.get(String(tag == null ? '' : tag)) || null;
    return '<b class="raw-title">原始请求</b>'
      + '<span class="raw-chip' + (pv ? ' ok' : '') + '">' + E(pv ? ('预览 · ' + nameOf(pv)) : '尚未算出') + '</span>';
  }

  /* 单栏（素材库那一处：那一格只有「发出去的那一次」可看，没有实时预览） */
  function html(tag, opts) {
    const t = String(tag == null ? '' : tag);
    const snap = snaps.get(t) || null;
    const open = openTags.has(t) ? ' open' : '';
    return '<details class="raw-req' + (snap ? ' has-snap' : ' waiting') + '"'
      + attrs(t, opts) + open + '>'
      + '<summary' + (snap && snap.label ? ' title="' + E(snap.label) + '"' : '') + '>' + headHTML(t) + '</summary>'
      + '<pre>' + E(snap ? bodyText(snap) : '还没发过；生成一次后这里显示实际发出的请求体。') + '</pre>'
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

  window.addEventListener('wb:raw-request', e => {
    const snap = e && e.detail;
    if (!snap) return;
    const tag = String(snap.tag || '');
    /* 把**发出去当时的预览**一起存下来：只有那一份能回答「我看到的预览和真发出去的是不是同一份」。
       预览是纯算的，随输入变 —— 拿现在的预览去比发出去的那次，比的是两件事。 */
    const pv = previews.get(tag) || null;
    if (pv) snap.previewAtSend = pv;
    snaps.set(tag, snap);
    try {
      document.querySelectorAll('details.raw-req[data-raw-tag]').forEach(el => {
        if (el.dataset.rawTag !== tag) return;
        /* 预览块（live）显示的是**将要发**的那一份，发出去不改它 —— 只有单栏快照那一族要写正文。 */
        if (el.dataset.rawLive) return;
        const sum = el.querySelector('summary');
        if (sum) sum.innerHTML = headHTML(tag);
        const pre = el.querySelector('pre');
        if (pre) pre.textContent = bodyText(snap);
        el.classList.add('has-snap');
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
  };
})();
