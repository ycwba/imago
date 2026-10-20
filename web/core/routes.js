/* 全站页面路由表（唯一一份）：侧栏、外壳、旧地址别名、页面标题、组件地址 `src`、页面根类 `root` 都从这里读。
   `src` 相对 web/app.js 解析，外壳的页面映射也从这里现搭。 */
(function () {
  const pages = [
    { file: 'director.html',  id: 'director',  label: '导演台',     ic: 'film',     title: '导演台',     src: './director/index.js', root: '.director-page' },
    { file: 'chars.html',     id: 'chars',     label: '素材库',     ic: 'users',    title: '素材库',     src: './pages/chars.js', root: '.chars-page' },
    { file: 'studio.html',    id: 'studio',    label: '生成工作台', ic: 'sparkles', title: '生成工作台', aiLabel: '生成工作台（视频 / 图像 / 音频）', src: './pages/studio.js', root: '.studio-page' },
    { file: 'canvas.html',    id: 'canvas',    label: '画布',       ic: 'layers',   title: '画布',       src: './pages/canvas.js', root: '.canvas-page' },
    { file: 'favorites.html', id: 'favorites', label: '我的收藏',   ic: 'star',     title: '我的收藏',   src: './pages/favorites.js', root: '.fav-page' },
    { file: 'assets.html',    id: 'assets',    label: '资产库',     ic: 'box',      title: '资产库',     src: './pages/assets.js', root: '.assets-page' },
    { file: 'usage.html',     id: 'usage',     label: '用量与余额', ic: 'chart',    title: '用量与余额', src: './pages/usage.js', root: '.usage-page' },
    { file: 'settings.html',  id: 'settings',  label: '设置',       ic: 'gear',     title: '设置', nav: false, src: './pages/settings.js', root: '.settings-page' }
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
    'usage': 'usage.html',
    'canvas': 'canvas.html'
  };

  const byFile = {};
  for (const p of pages) byFile[p.file] = p;
  window.WB_ROUTES = { pages, alias, byFile, defaultPage: 'director.html' };

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
})();
