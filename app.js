/* 工作台外壳的左栏路由：内容区在 iframe 里切页，侧栏（外层）不重建、不闪。
   「不闪」是怎么做到的：换页时**不**直接改当前 iframe 的 src，而是另起一个同样式的 iframe
   在它下面加载，等它 load 了再换上位、把旧的卸掉 —— 屏幕上一直有内容（见下面的 loadFrame）。 */
(function () {
  const frame = document.getElementById('appFrame');
  if (!frame) return;

  const LAST = 'sb_last_page';
  const PAGES = ['director.html', 'chars.html', 'studio.html', 'favorites.html', 'assets.html', 'usage.html', 'settings.html'];
  /* 三个工作台合并成一个 studio.html 之后，旧的页面名与别名都还指向它，并带上 ?t=<类型>：
     收藏进来的旧书签、别处的链接、AI 助手跳过来的落点都还能落在原来那一栏上。
     别名值里可以自带 ?t=…（下面 parse 会把它拆出来，file 仍是 studio.html，侧栏高亮才对得上）。 */
  const ALIAS = {
    'studio.html': 'studio.html',
    'image.html': 'studio.html?t=image', 'image-gen.html': 'studio.html?t=image',
    'video.html': 'studio.html?t=video', 'video-gen.html': 'studio.html?t=video',
    'audio.html': 'studio.html?t=audio', 'audio-gen.html': 'studio.html?t=audio',
    '': 'director.html', '/': 'director.html',
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
     设置页改完要等一小段自动保存的合并窗口才落盘：侧栏一点，iframe 整个换掉，那半秒里的改动就无声丢了。
     外壳不认识设置页的字段，所以判据由页面自己给（`window.__skDirty()` 返回一句人话或空）；
     外壳只负责问一句、以及人留下时把 hash 摆回去。别的页面没挂这个函数 = 一律放行。 */
  function liveFrame() { return document.getElementById('appFrame'); }
  function leaveWhy() {
    try {
      const w = (liveFrame() || {}).contentWindow;
      const d = w && typeof w.__skDirty === 'function' ? w.__skDirty() : '';
      return typeof d === 'string' ? d : '';
    } catch (e) { return ''; }      // 跨文档取不到就当没有改动，别把路由卡死
  }
  let navigating = false;           // 确认框挂着时再点一次侧栏，不该问第二遍
  let swapSeq = 0;                  // 换页序号：连点两个侧栏时，只有最后一次的 load 算数

  /* ---------- 换 iframe：新页面在**另一个**同样式的 iframe 里加载好，再与当前的换位 ----------
     以前是 `frame.src = t.src`：赋值的瞬间旧文档就被拆掉，那块地方在新页面第一帧画出来之前
     是一片底色 —— 也就是「切过去先闪一下、再出来内容」。那个闪是**结构性的**，
     再怎么调页面的渲染都躲不掉：只要旧内容在新内容之前被拆掉，中间必然有一段空白。
     现在两份 iframe 叠在同一处、同一套尺寸（.appframe，加载中的那份再压低一层）：
       · 新页面在下面加载，上面那份旧内容一直显示着；
       · 它的 load 一到就升到上面并把旧的卸掉 —— 这一步是同一帧内完成的，看不出换页。
     id 是「当前可见的那一份」，换位时才交班：所以外壳别处按 id 找的（主题同步等）拿到的
     前后是同一个元素，只是里面的内容页换了；加载中的那一份没有 id，尺寸靠类名走。 */
  function loadFrame(src) {
    const old = document.getElementById('appFrame');
    const nf = document.createElement('iframe');
    nf.className = 'appframe staging';
    nf.setAttribute('title', '工作区');
    nf.src = src;
    document.body.appendChild(nf);
    const mine = ++swapSeq;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      nf.classList.remove('staging');
      /* 旧的那份**先不删**：换位这一刻新文档可能一个子元素都还没有（readyState 刚离开 loading），
         直接删就等于让底色露一两帧 —— 那正是这一版要消掉的东西。它压在新的一层底下继续顶着，
         新的一层是透明的，于是那几帧看到的仍是上一页，不是空白。
         等新页面真的画出东西了再收；万一它一直空着，400ms 后照样收，不能把两页一直摞着。 */
      nf.classList.add('behind');
      nf.id = 'appFrame';
      nf.name = 'appFrame';
      wireFrame(nf);
      watchFrame(nf);
      const t0 = Date.now();
      const dropOld = () => {
        nf.classList.remove('behind');
        if (old && old.parentNode) old.parentNode.removeChild(old);
      };
      const tryDrop = () => {
        let kids = -1;
        try { const d = nf.contentDocument; kids = d && d.body ? d.body.childElementCount : -1; } catch (e) {}
        if (kids > 0 || Date.now() - t0 > 400) { dropOld(); return; }
        requestAnimationFrame(tryDrop);
      };
      requestAnimationFrame(tryDrop);
      /* 这一次换页如果被页面自己改掉了地址（页面内部跳转），同步地址栏与高亮 */
      try {
        const w = nf.contentWindow;
        const t = parse(w.location.pathname + w.location.search);
        if (!t || t.src === cur) return;
        cur = t.src;
        try { localStorage.setItem(LAST, t.src); } catch (e) {}
        history.replaceState(null, '', '#' + t.src);
        highlight(t.file);
      } catch (e) { /* 页面还没就绪，忽略 */ }
    };
    /* 换位时机 = 新文档**开始成形**（readyState 离开 loading，约等于 DOMContentLoaded），
       不是 load —— load 要等图片与全部子资源。资产库 / 收藏 / 生成工作台那种一屏几十张
       缩略图的页面，等 load 等于让用户盯着上一页干等一两秒，那正是「切换要等一会才过去」。
       换位之后新页面照常把它的图陆续画上去，那是它自己的渐进渲染，不是空白。
       （上面那一层「旧内容一直顶着」保证的是换页过程中没有空白，与换得多早是两件事。） */
    const watch = () => {
      if (done) return;
      /* 换页期间又点了一次别的：这一份已经过期，直接卸掉。
         不卸的话它自己会顶上来，把用户刚点的那一页换掉 —— 症状是「点了 A、又跳回 B」。 */
      if (mine !== swapSeq) { done = true; nf.remove(); return; }
      let rs = '';
      try { rs = (nf.contentDocument || {}).readyState || ''; } catch (e) { done = true; nf.remove(); return; }
      if (rs && rs !== 'loading') { finish(); return; }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    /* 两道兜底：标签页切到后台时 rAF 会停（那时没人看着，不换也行，但别卡住下一次切页）；
       以及文档压根没起来时不要留一份空白 iframe 在下面。 */
    nf.addEventListener('load', finish);
    nf.addEventListener('error', () => { if (mine === swapSeq) { done = true; nf.remove(); } });
  }

  async function show(page, push) {
    const t = parse(page) || parse('director.html');
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
        try { const w = (liveFrame() || {}).contentWindow; if (typeof w.__skLeaving === 'function') w.__skLeaving(); } catch (e) {}
      }
    }
    cur = t.src;
    try { localStorage.setItem(LAST, t.src); } catch (e) {}
    if (push && location.hash.slice(1) !== t.src) history.pushState(null, '', '#' + t.src);
    highlight(t.file);
    loadFrame(t.src);
  }

  // 初始页：地址栏 hash > 上次打开 > 导演台
  const initial = (parse(location.hash.slice(1)) || parse(localStorage.getItem(LAST)) || parse('director.html')).src;
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
  /* 判据跟着**元素**走，不跟着初始那个 iframe 走：换页之后初始那个已经被卸掉了，
     再从它身上取 contentDocument 只会拿到 null —— 侧栏浮层从此再也收不起来。 */
  function wireFrame(el) {
    const f = el || document.getElementById('appFrame');
    let doc = null;
    try { doc = f && f.contentDocument; } catch (e) { return; }
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

  /* 页面内部自己跳转时，同步地址栏与高亮。
     换位之后新 iframe 也要接上：它后面发生的内部跳转不经过 loadFrame，
     只在这一个监听里被看见 —— 以前这个监听是绑在那个「一直存在」的 iframe 上的，
     换成双 iframe 之后那个元素会被卸掉，所以判据跟着元素走而不是绑死在初始那个上。 */
  function watchFrame(el) {
    if (!el || el.__sbWatched) return;
    el.__sbWatched = 1;
    el.addEventListener('load', () => {
      try {
        const w = el.contentWindow;
        const t = parse(w.location.pathname + w.location.search);
        if (!t || t.src === cur) return;
        cur = t.src;
        try { localStorage.setItem(LAST, t.src); } catch (e) {}
        history.replaceState(null, '', '#' + t.src);
        highlight(t.file);
      } catch (e) { /* 页面还没就绪，忽略 */ }
    });
  }

  window.appShow = show;          // 供侧栏调用
})();
