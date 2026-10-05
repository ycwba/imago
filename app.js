/* 工作台外壳的左栏路由：内容区在 iframe 里切页，侧栏（外层）不重建、不闪 */
(function () {
  const frame = document.getElementById('appFrame');
  if (!frame) return;

  const LAST = 'sb_last_page';
  const PAGES = ['index.html', 'drama.html', 'chars.html', 'studio.html', 'favorites.html', 'assets.html', 'usage.html', 'settings.html'];
  /* 三个工作台合并成一个 studio.html 之后，旧的页面名与别名都还指向它，并带上 ?t=<类型>：
     收藏进来的旧书签、别处的链接、AI 助手跳过来的落点都还能落在原来那一栏上。
     别名值里可以自带 ?t=…（下面 parse 会把它拆出来，file 仍是 studio.html，侧栏高亮才对得上）。 */
  const ALIAS = {
    'studio.html': 'studio.html',
    'image.html': 'studio.html?t=image', 'image-gen.html': 'studio.html?t=image',
    'video.html': 'studio.html?t=video', 'video-gen.html': 'studio.html?t=video',
    'audio.html': 'studio.html?t=audio', 'audio-gen.html': 'studio.html?t=audio',
    'director.html': 'index.html', '': 'index.html', '/': 'index.html',
  };

  /* 把各种写法（路径 / 带查询 / 别名）拆成「页面名 + 原样查询串」；不是工作台页面返回 null */
  function parse(p) {
    let s = String(p || '').split('#')[0];
    const q = s.includes('?') ? s.slice(s.indexOf('?')) : '';
    s = s.split('?')[0].replace(/^.*\//, '');
    if (s === 'shell.html' || s === 'app.html') return null;
    const file = ALIAS[s] || (PAGES.includes(s) ? s : null);
    if (!file) return null;
    const eq = file.indexOf('?');                 // 别名自带查询（?t=video）时：文件名与查询分开
    const base = eq >= 0 ? file.slice(0, eq) : file;
    const extra = eq >= 0 ? file.slice(eq) : '';
    return { file: base, src: base + (q || extra) };
  }

  let cur = null;

  function highlight(file) {
    if (typeof window.__sbSetActive === 'function') window.__sbSetActive(file);
  }

  /* ---------- 离开前那道「还没保存」的闸 ----------
     设置页是「点保存才生效」的：侧栏一点，iframe 整个换掉，那一份没落盘的表单就无声丢了。
     外壳不认识设置页的字段，所以判据由页面自己给（`window.__skDirty()` 返回一句人话或空）；
     外壳只负责问一句、以及人留下时把 hash 摆回去。别的页面没挂这个函数 = 一律放行。 */
  function leaveWhy() {
    try {
      const w = frame.contentWindow;
      const d = w && typeof w.__skDirty === 'function' ? w.__skDirty() : '';
      return typeof d === 'string' ? d : '';
    } catch (e) { return ''; }      // 跨文档取不到就当没有改动，别把路由卡死
  }
  let navigating = false;           // 确认框挂着时再点一次侧栏，不该问第二遍

  async function show(page, push) {
    const t = parse(page) || parse('index.html');
    if (t.src === cur) { highlight(t.file); return; }
    if (navigating) return;
    const why = leaveWhy();
    if (why) {
      if (!window.Confirm) { /* 没有确认组件就放行：宁可丢改动，也不能点不动侧栏 */ }
      else {
        navigating = true;
        let go = false;
        try {
          go = await Confirm.ask({ title: '这一页还有没保存的改动', body: why, okLabel: '不保存，离开', cancelLabel: '留下继续改', danger: true });
        } finally { navigating = false; }
        if (!go) {
          /* 浏览器后退进来的那一跳，hash 已经先变了；不摆回去就会「地址在 A、页面是 B」 */
          if (location.hash.slice(1) !== cur) history.replaceState(null, '', '#' + cur);
          highlight((parse(cur) || { file: '' }).file);
          return;
        }
        /* 答应了离开就作废判据：iframe 卸载前那一页还可能自己问一次（beforeunload），
           同一次离开不该问两遍。 */
        try { const w = frame.contentWindow; if (typeof w.__skLeaving === 'function') w.__skLeaving(); } catch (e) {}
      }
    }
    cur = t.src;
    try { localStorage.setItem(LAST, t.src); } catch (e) {}
    frame.src = t.src;
    if (push && location.hash.slice(1) !== t.src) history.pushState(null, '', '#' + t.src);
    highlight(t.file);
  }

  // 初始页：地址栏 hash > 上次打开 > 导演台
  const initial = (parse(location.hash.slice(1)) || parse(localStorage.getItem(LAST)) || parse('index.html')).src;
  show(initial, true);

  // 浏览器前进 / 后退
  window.addEventListener('hashchange', () => {
    const t = parse(location.hash.slice(1));
    if (t && t.src !== cur) show(t.src, false);
  });

  /* ---------- 窄窗口里侧栏是浮层：点内容区就该收起 ----------
     iframe 里的点击**不会冒泡到外壳**（不同文档树，外壳的 click 监听器收不到），
     所以这里在 iframe 的文档上挂一个监听，让内容页主动 postMessage 通知外壳。
     这是唯一需要「内容页 → 外壳」反向通道的地方，别再在 iframe 里各写一套。 */
  const CLOSE_OVERLAY = 'wb:close-sb-overlay';
  function wireFrame() {
    let doc = null;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || doc.__sbOverlayWired) return;
    doc.__sbOverlayWired = 1;
    doc.addEventListener('click', e => {
      const t = e.target;
      // 弹窗（统一选择器 / 灯箱）与显式保留的元素不算「点内容区」
      if (t && t.closest && t.closest('dialog[open], #lbStage, #apDlg, [data-sb-keep]')) return;
      /* 注意是**外壳自己的** window.postMessage：写成 frame.contentWindow.postMessage 的话，
         消息是投给 iframe 自己的窗口（那里面没人监听），外壳永远收不到。 */
      try { window.postMessage({ type: CLOSE_OVERLAY }, location.origin); } catch (err) {}
    }, true);
  }
  window.addEventListener('message', e => {
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== CLOSE_OVERLAY) return;
    if (typeof window.__sbCloseOverlay === 'function') window.__sbCloseOverlay();
  });

  // 页面内部自己跳转（例如「复用」跳到图片工作台）时，同步地址栏与高亮
  frame.addEventListener('load', () => {
    wireFrame();
    try {
      const w = frame.contentWindow;
      const t = parse(w.location.pathname + w.location.search);
      if (!t || t.src === cur) return;
      cur = t.src;
      try { localStorage.setItem(LAST, t.src); } catch (e) {}
      history.replaceState(null, '', '#' + t.src);
      highlight(t.file);
    } catch (e) { /* 页面还没就绪，忽略 */ }
  });

  window.appShow = show;          // 供侧栏调用
})();
