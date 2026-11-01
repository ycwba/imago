/* 全站页面路由表（唯一一份）：侧栏、外壳、旧地址别名、页面标题、组件地址 `src`、页面根类 `root`、
   这一页自己的样式表 `css`、这一页挂载前必须就位的公共件 `needs`、这一页挂载后还要再 import 一层的
   `chunk` 都从这里读。
   `src` 与 `chunk` 都相对 web/app.js 解析（外壳的 import() 与预取同一个基准，不另抄路径）。 */
(function () {
  /* `needs`：外壳切页时与页面模块一起并发补载（app.js），页面代码一运行就要在的全局
     不能等「用户点到才补」—— `TextAI` 建包时被当对象递进 split-assets，
     `AssetPicker` 由常驻的 gen-forms 直接开弹窗，`DataSync` 第一次落盘镜像就要用，
     `Search` 给 text-ai 的联网搜索供结果（`TextAI.searchBlock` 现查 `window.Search`，
     缺了它联网搜索就静默不搜）。capabilities 也在这份名单里：它自己有在途并船与 30 秒 TTL，
     晚到只会让首帧下拉空一拍，`wb:cap-ready` 会补画。
     收藏 / 用量 / 资产库用不到的那几份整份不下。
     `css`：这一页私有的那份样式表（挂载与预取都只读这一格；导演台没有 ——
     它的样式跟着 template.html 一起走作用域岛，spa-director.css 是外壳常驻件）。
     `chunk`：modulepreload 只走静态 import 图，看不见 director/index.js 挂载时才发的那一次动态 import
     （engine.js 那一层）—— 不点名它就是三段串（needs → 页面 → 引擎）。 */
  const C = 'web/domain/capabilities.js', T = 'web/domain/text-ai.js',
    P = 'web/domain/asset-picker.js', D = 'web/ui/datasync.js', S = 'web/domain/search.js';
  /* `short`：窄形态（56px）下压在图标下面的**两字短标签**。
     窄形态里也要认得出每一项，所以短标签常驻、不靠悬停才知道这一项是什么。
     它必须和 `label` 放在同一张表里 —— 侧栏不许另抄一份（改了页面名忘了改短标签，
     侧栏上就会出现两个名字）。`label` 是全名（悬停名牌、读屏 aria-label 用它）。
     不进侧栏的那一行（设置）没有 `short`：它在左下角是一整行横排的「图标 + 全名」，窄形态只留图标。 */
  const pages = [
    { file: 'director.html', id: 'director', label: '导演台', short: '导演', ic: 'film', title: '导演台', src: './director/index.js', root: '.director-page',
      chunk: ['./director/engine.js'],
      needs: [C, T, P, D, S] },
    { file: 'chars.html', id: 'chars', label: '素材库', short: '素材', ic: 'users', title: '素材库', src: './pages/chars.js', root: '.chars-page',
      css: 'web/styles/spa-chars.css',
      needs: [C, T, P, D, S] },
    { file: 'studio.html', id: 'studio', label: '工作台', short: '工作', ic: 'sparkles', title: '工作台', aiLabel: '工作台（视频 / 图像 / 音频）', src: './pages/studio.js', root: '.studio-page',
      css: 'web/styles/spa-studio.css',
      needs: [C, T, P, D, S] },
    { file: 'favorites.html', id: 'favorites', label: '我的收藏', short: '收藏', ic: 'star', title: '我的收藏', src: './pages/favorites.js', root: '.fav-page',
      css: 'web/styles/spa-pages.css',
      needs: [D] },
    { file: 'assets.html', id: 'assets', label: '资产库', short: '资产', ic: 'box', title: '资产库', src: './pages/assets.js', root: '.assets-page',
      css: 'web/styles/spa-assets.css',
      needs: [T, D] },
    { file: 'usage.html', id: 'usage', label: '用量与余额', short: '用量', ic: 'chart', title: '用量与余额', src: './pages/usage.js', root: '.usage-page',
      css: 'web/styles/spa-usage.css',
      needs: [T, D] },
    { file: 'settings.html', id: 'settings', label: '设置', ic: 'gear', title: '设置', nav: false, src: './pages/settings.js', root: '.settings-page',
      css: 'web/styles/spa-settings.css',
      needs: [C, T, P, D] }
  ];

  /* 旧地址 / 别名。值可以是带查询的地址（剧集工作台合并成 studio 后的三类入口）。
     空地址（直接打开 / 或 hash 只有 '#'）不在这里映射 —— parse() 对空返回 null，
     外壳拿它回退到「上次页」（见 web/app.js）。 */
  const alias = {
    'app.html': 'director.html',
    'image.html': 'studio.html?t=image',
    'image-gen.html': 'studio.html?t=image',
    'video.html': 'studio.html?t=video',
    'video-gen.html': 'studio.html?t=video',
    'audio.html': 'studio.html?t=audio',
    'audio-gen.html': 'studio.html?t=audio',
    'roles.html': 'favorites.html',
    'skills.html': 'settings.html',
    'usage': 'usage.html'
  };

  const byFile = {};
  for (const p of pages) byFile[p.file] = p;
  /* 全站 `needs` 的并集，从上面那张表现算（不另写一份清单）：空闲兜底（boot-assistant.js）
     要把助手在任何一页都可能用到的那几份一次补齐，点名名单只能从这里取。 */
  const needAll = [];
  for (const p of pages) for (const n of p.needs || []) if (needAll.indexOf(n) < 0) needAll.push(n);
  window.WB_ROUTES = { pages, alias, byFile, needAll, defaultPage: 'director.html' };

  /* 脚本按需加载只走这一份：外壳空闲加载、Vue 页面首次挂载、助手依赖都从这里取，
     同一份脚本在整份文档里只会执行一次。test 传「加载完应该出现的那个全局」，
     已经由别的路径插进来的标签也能被认出来（不会重复执行第二遍）。
     失败的那一次**不许留在 pending 里**：留了的话，被拒绝的 Promise 永久占着键，
     之后每次进这一页都拿到同一个已拒绝的 Promise —— 一次网络抖动 = 这一页整个会话起不来，
     只有整页刷新才救得回来。失败就删键（成功才留缓存），下一次进来自然重试。 */
  const pending = window.__spaScriptPromises || (window.__spaScriptPromises = new Map());
  window.__spaLoadScript = function (src, test) {

    if (pending.has(src)) return pending.get(src);
    const ok = () => { try { return !test || !!test(); } catch (e) { return false; } };
    if (ok()) return Promise.resolve(true);
    let settle = null;
    const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const done = () => settle.resolve(true);
    const purgePending = () => {
      pending.delete(src);
      settle.reject(new Error('脚本加载失败：' + src));
    };
    const old = document.querySelector('script[src="' + src + '"]');
    if (old) {
      let t = null;
      const stopPoll = () => { if (t) { clearInterval(t); t = null; } };
      old.addEventListener('load', () => { stopPoll(); done(); }, { once: true });
      old.addEventListener('error', () => { stopPoll(); purgePending(); }, { once: true });
      let n = 0;
      t = setInterval(() => {
        if (ok()) { stopPoll(); done(); }
        else if (++n > 40) { stopPoll(); purgePending(); }
      }, 50);
      /* load/error 事件与轮询哪个先到都以先到的为准：到了就把定时器停掉，
         不让 resolve 之后轮询还在跑、甚至再 reject 一次。 */
    } else {
      const s = document.createElement('script');
      s.src = src;
      s.onload = done;
      s.onerror = () => { s.remove(); purgePending(); };
      document.head.appendChild(s);
    }
    pending.set(src, p);
    return p;
  };

  /* 路由级按需补载（`needs`）：外壳切页时把这一页欠的那几份与页面模块一起并发取回，
     认「装完应该出现的那个全局」的对照表只在这里一份。
     search.js 是经典脚本（IIFE 挂 `window.Search`）：没这份对照表时 test 为空，
     `__spaLoadScript` 会当成「已经在了」直接返回 —— 脚本根本不发。 */
  const NEED_GLOBAL = {
    'web/domain/capabilities.js': 'Capabilities',
    'web/domain/text-ai.js': 'TextAI',
    'web/domain/asset-picker.js': 'AssetPicker',
    'web/ui/datasync.js': 'DataSync',
    'web/domain/search.js': 'Search',
  };
  window.__spaNeeds = function (list) {
    return Promise.all((list || []).map(src => {
      const g = NEED_GLOBAL[src];
      return window.__spaLoadScript(src, g ? () => !!window[g] : null);
    }));
  };
})();
