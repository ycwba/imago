/* 导演台：把原先那份独立文档装进 Vue 页面池里的一个「作用域岛」。
   目标不是重写那 600 KB 的剪辑/时间线逻辑（它已经被大量行为判据钉住），而是：
     · 不再用 iframe —— 页面与外壳同一份文档，切换只靠 KeepAlive；
     · 导演台对 DOM 的读写全部落在自己的 `.director-page` 根里（document 代理），
       不会去碰别的页面；键盘 / 指针这类 document/window 监听在页面不可见时直接放行；
     · 页面样式只在可见时挂上，并用 `@scope` 圈在自己的根里，不会染到侧栏与其它页。
   等这一岛的边界稳定下来，再把内部一块块换成 Vue 组件（见 AGENTS §10）。 */
import { ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { createEditorMedia } from './media.js';
import { render } from '../render/director.js';

function extractTemplate(html) {
  const bodyAt = html.indexOf('<body>');
  const body = html.slice(bodyAt + 6, html.indexOf('</body>'));
  const sm = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html);
  return { body, style: sm ? sm[1] : '' };
}

export default {
  name: 'DirectorView',
  setup() {
    const host = ref(null);
    const failed = ref('');
    const loading = ref(true);
    let styleEl = null;
    let active = { value: true };
    let installed = false;
    let engineApi = null;   // 挂载后才有：生成工作台递过来的那张图要在 mount 之后才取得走
    const listeners = [];   // { target, type, fn, wrapped }

    function add(target, type, fn, opts) {
      if (typeof fn !== 'function') return;
      const wrapped = e => { if (active.value) fn.call(target, e); };
      target.addEventListener(type, wrapped, opts);
      listeners.push({ target, type, fn, wrapped, opts });
    }
    function remove(target, type, fn, opts) {
      const i = listeners.findIndex(x => x.target === target && x.type === type && x.fn === fn);
      if (i < 0) return;
      target.removeEventListener(type, listeners[i].wrapped, opts);
      listeners.splice(i, 1);
    }

    function makeEnv() {
      const doc = document, win = window;
      const bodyProxy = new Proxy(doc.body, {
        get(t, p) {
          /* 导演台会往 body 上挂拖拽示意 / @ 浮层 / 对话框：把它们收进页面根里，
             切走时随 KeepAlive 一起离屏，不会盖住别的页。 */
          if (p === 'appendChild') return node => host.value.appendChild(node);
          if (p === 'contains') return node => host.value.contains(node);
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const docProxy = new Proxy(doc, {
        get(t, p) {
          if (p === 'getElementById') return id => host.value.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
          if (p === 'querySelector') return sel => host.value.querySelector(sel);
          if (p === 'querySelectorAll') return sel => host.value.querySelectorAll(sel);
          if (p === 'addEventListener') return (type, fn, opts) => add(doc, type, fn, opts);
          if (p === 'removeEventListener') return (type, fn, opts) => remove(doc, type, fn, opts);
          if (p === 'body') return bodyProxy;
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const winProxy = new Proxy(win, {
        get(t, p) {
          if (p === 'addEventListener') return (type, fn, opts) => add(win, type, fn, opts);
          if (p === 'removeEventListener') return (type, fn, opts) => remove(win, type, fn, opts);
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, p, v) { t[p] = v; return true; },
      });
      return { docProxy, winProxy };
    }

    async function boot() {
      if (installed) return;
      installed = true;
      try {
        /* 这几件事一起要：五份公共经典脚本、模板 HTML、engine 那条模块链。
           以前一份一份 await，进这一页要串行等四次往返。并起来的前提都查过：
             · workbench.js / chars.js / export-formats.js 在求值期都不读对方（chars.js 只在函数里用
               `Wb.Blobs`，export-formats 只挂 window.ExportFormats），互不依赖才敢同时插；
             · engine.js 顶层只有 import，整个函数体在 `mount()` 里（`Wb.ST` 那一行也在里面），
               而 mount 照旧等到模板上完 DOM 才调 —— 提前取模块只是提前取字节。
           no-cache = 每次向本地代理复验 ETag（304 就不重下），改了模板也能立刻生效。
           媒体后端也要在 mount 之前到位：切片的 <video> 只在 media-backend.js 里造
           （AGENTS §7），那一条链没有自己的兜底可退。 */
        const scriptsP = Promise.all([
          window.__spaLoadScript('web/ui/workbench.js', () => window.Wb),
          window.__spaLoadScript('web/media-backend.js', () => window.MediaBackend),
          window.__spaLoadScript('web/domain/chars.js', () => window.Chars),
          window.__spaLoadScript('web/domain/export-formats.js', () => window.ExportFormats),
          /* 原始请求面板（不常驻在 shell.html —— 别处打开它就是白下一次）。 */
          window.__spaLoadScript('web/ui/raw-request.js', () => window.RawRequest),
        ]);
        const templateP = fetch('web/director/template.html', { cache: 'no-cache' }).then(r => r.text());
        const engineP = import('./engine.js');
        await Promise.all([scriptsP, templateP, engineP]);
        if (!window.Wb || !window.Api || !window.AssetLib || !window.Chars || !window.ExportFormats) {
          throw new Error('公共模块没有就绪（web/ui/workbench.js / web/domain/chars.js / web/domain/export-formats.js / assetlib.js）');
        }
        const html = await templateP;
        const page = extractTemplate(html);
        if (!page.body) throw new Error('导演台模板取不出来');
        host.value.innerHTML = page.body;
        /* 样式只在可见时挂；@scope 把选择器圈在页面根里（body/html 那几条由 spa-director.css 接住）。 */
        styleEl = document.createElement('style');
        styleEl.textContent = '@scope (.director-page) {\n' + page.style + '\n}';
        styleEl.setAttribute('data-spa-director', '1');
        document.head.appendChild(styleEl);
        if (window.fillIcons) window.fillIcons(host.value);
        const env = makeEnv();
        /* 剪辑页的预览/导出/配音共用一个本机优先解析器；引擎通过 window 取它。 */
        env.winProxy.EditorMedia = createEditorMedia({ assetLocal: window.AssetLocal, api: window.Api });
        /* 引擎是真正的 ES 模块（可被 node --check 静态检查），document / window 两份代理按参数传进去；
           不再用 new Function 执行字符串；Vue 模板已在开发期预编译（严格 CSP 不需要 unsafe-eval）。 */
        engineApi = await engineP;
        engineApi.mount(env.docProxy, env.winProxy);
        if (window.fillIcons) window.fillIcons(host.value);
        if (window.Dropdowns) window.Dropdowns.build(host.value);
      } catch (e) {
        console.error('[director] 启动失败：', e);
        failed.value = String(errText(e));
        if (window.PageReport) PageReport.pageFail('导演台', failed.value, e);
        installed = false;
        if (styleEl) { try { styleEl.remove(); } catch (err) {} styleEl = null; }
      } finally {
        loading.value = false;
      }
    }

    onMounted(async () => { await boot(); });
    onActivated(() => {
      active.value = true;
      try { if (window.__directorSlicePause) window.__directorSlicePause(false); } catch (e) {}
      if (styleEl && !styleEl.isConnected) document.head.appendChild(styleEl);
      /* 隐藏期间可能改过窗口尺寸；放回文档后让导演台自己重排一次（它的 resize 监听在隐藏时是放行的）。 */
      setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 0);
    });
    onDeactivated(() => {
      active.value = false;
      try { if (window.__directorSlicePause) window.__directorSlicePause(true); } catch (e) {}
      if (styleEl && styleEl.isConnected) styleEl.remove();
      try { if (window.Dropdowns) window.Dropdowns.closeAll(); } catch (e) {}
      try { if (window.Wb && Wb.lightbox && Wb.lightbox.isOpen && Wb.lightbox.isOpen()) Wb.lightbox.close(); } catch (e) {}
    });
    onBeforeUnmount(() => {
      active.value = false;
      for (const x of listeners.splice(0)) {
        try { x.target.removeEventListener(x.type, x.wrapped, x.opts); } catch (e) {}
      }
      if (styleEl) { try { styleEl.remove(); } catch (e) {} styleEl = null; }
    });

    return { host, failed, loading, retryLoad: () => { if (window.__spaReload) window.__spaReload(); } };
  },
  render,
};
