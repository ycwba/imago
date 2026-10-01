/* 工作台外壳的左栏路由：内容区在 iframe 里切页，侧栏（外层）不重建、不闪 */
(function () {
  const frame = document.getElementById('appFrame');
  if (!frame) return;

  const LAST = 'sb_last_page';
  const PAGES = ['index.html', 'image.html', 'video.html', 'audio.html', 'favorites.html', 'assets.html', 'usage.html', 'settings.html'];
  const ALIAS = { 'image-gen.html': 'image.html', 'video-gen.html': 'video.html', 'audio-gen.html': 'audio.html', 'director.html': 'index.html', '': 'index.html', '/': 'index.html' };

  /* 把各种写法（路径 / 带查询 / 别名）拆成「页面名 + 原样查询串」；不是工作台页面返回 null */
  function parse(p) {
    let s = String(p || '').split('#')[0];
    const q = s.includes('?') ? s.slice(s.indexOf('?')) : '';
    s = s.split('?')[0].replace(/^.*\//, '');
    if (s === 'shell.html' || s === 'app.html') return null;
    const file = ALIAS[s] || (PAGES.includes(s) ? s : null);
    return file ? { file: file, src: file + q } : null;
  }

  let cur = null;

  function highlight(file) {
    if (typeof window.__sbSetActive === 'function') window.__sbSetActive(file);
  }

  function show(page, push) {
    const t = parse(page) || parse('index.html');
    if (t.src === cur) { highlight(t.file); return; }
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

  // 页面内部自己跳转（例如「复用」跳到图片工作台）时，同步地址栏与高亮
  frame.addEventListener('load', () => {
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
