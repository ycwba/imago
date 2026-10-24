/* 全站页面路由表（唯一一份）：侧栏、外壳、旧地址别名、页面标题、组件地址 `src`、页面根类 `root`、
   这一页挂载前必须就位的公共件 `needs`、这一页挂载后还要再 import 一层的 `chunk` 都从这里读。
   `src` 与 `chunk` 都相对 web/app.js 解析（外壳的 import() 与预取同一个基准，不另抄路径）。 */
(function () {
  /* `needs`：外壳在 import 页面组件之前并发补载（app.js）。这四份不能等「用户点到才补」——
     `Capabilities` 在 engine/panel.js 求值期就被读，`TextAI` 建包时被当对象递进 split-assets，
     `AssetPicker` 由常驻的 gen-forms 直接开弹窗，`DataSync` 第一次落盘镜像就要用。
     收藏 / 用量 / 资产库用不到的那几份整份不下。
     `chunk`：modulepreload 只走静态 import 图，看不见 director/index.js 挂载时才发的那一次动态 import
     （engine.js 那一层）—— 不点名它就是三段串（needs → 页面 → 引擎）。 */
  const C = 'web/domain/capabilities.js', T = 'web/domain/text-ai.js',
    P = 'web/domain/asset-picker.js', D = 'web/ui/datasync.js';
  const pages = [
    { file: 'director.html', id: 'director', label: '导演台', ic: 'film', title: '导演台', src: './director/index.js', root: '.director-page',
      chunk: ['./director/engine.js'],
      needs: [C, T, P, D] },
    { file: 'chars.html', id: 'chars', label: '素材库', ic: 'users', title: '素材库', src: './pages/chars.js', root: '.chars-page',
      needs: [C, T, P, D] },
    { file: 'studio.html', id: 'studio', label: '生成工作台', ic: 'sparkles', title: '生成工作台', aiLabel: '生成工作台（视频 / 图像 / 音频）', src: './pages/studio.js', root: '.studio-page',
      needs: [C, T, P, D] },
    { file: 'favorites.html', id: 'favorites', label: '我的收藏', ic: 'star', title: '我的收藏', src: './pages/favorites.js', root: '.fav-page',
      needs: [D] },
    { file: 'assets.html', id: 'assets', label: '资产库', ic: 'box', title: '资产库', src: './pages/assets.js', root: '.assets-page',
      needs: [T, D] },
    { file: 'usage.html', id: 'usage', label: '用量与余额', ic: 'chart', title: '用量与余额', src: './pages/usage.js', root: '.usage-page',
      needs: [T, D] },
    { file: 'settings.html', id: 'settings', label: '设置', ic: 'gear', title: '设置', nav: false, src: './pages/settings.js', root: '.settings-page',
      needs: [C, T, P, D] }
  ];

  /* 旧地址 / 别名。值可以是带查询的地址（剧集工作台合并成 studio 后的三类入口）。 */
  const alias = {
    '': 'director.html',
    '/': 'director.html',
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
     已经由别的路径插进来的标签也能被认出来（不会重复执行第二遍）。 */
  const pending = window.__spaScriptPromises || (window.__spaScriptPromises = new Map());
  window.__spaLoadScript = function (src, test) {

    if (pending.has(src)) return pending.get(src);
    const ok = () => { try { return !test || !!test(); } catch (e) { return false; } };
    if (ok()) return Promise.resolve(true);
    const p = new Promise((resolve, reject) => {
      const done = () => resolve(true);
      const fail = () => reject(new Error('脚本加载失败：' + src));
      const old = document.querySelector('script[src="' + src + '"]');
      if (old) {
        old.addEventListener('load', done, { once: true });
        old.addEventListener('error', fail, { once: true });
        let n = 0;
        const t = setInterval(() => {
          if (ok()) { clearInterval(t); resolve(true); }
          else if (++n > 40) { clearInterval(t); reject(new Error('脚本没有就绪：' + src)); }
        }, 50);
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = done;
      s.onerror = fail;
      document.head.appendChild(s);
    });
    pending.set(src, p);
    return p;
  };

  /* 路由级按需补载（`needs`）：外壳在 import 页面组件之前先并发把这一页欠的那几份取回来，
     认「装完应该出现的那个全局」的对照表只在这里一份。
     四份里唯一在求值期就要读的是 capabilities（engine/panel.js 顶层取 `Capabilities.ROLE_ZH`），
     所以它必须在 `import()` 之前落地，不能等空闲。 */
  const NEED_GLOBAL = {
    'web/domain/capabilities.js': 'Capabilities',
    'web/domain/text-ai.js': 'TextAI',
    'web/domain/asset-picker.js': 'AssetPicker',
    'web/ui/datasync.js': 'DataSync',
  };
  window.__spaNeeds = function (list) {
    return Promise.all((list || []).map(src => {
      const g = NEED_GLOBAL[src];
      return window.__spaLoadScript(src, g ? () => !!window[g] : null);
    }));
  };
})();
