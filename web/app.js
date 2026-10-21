/* Vue 外壳：hash 路由 + KeepAlive 页面池 + 页面级生命周期。
   每个页面都是 `web/pages/*.js` / `web/director/index.js` 组件（按需加载）；切页只离屏、不销毁，所以搜索词、滚动位置、
   多选、剪辑态与导演台的 DOM 都留在原地。没有 iframe 页面池，也没有「换页 reload」。 */
import {
  createApp, reactive, computed, onMounted, watch, provide, readonly,
  h, ref, onActivated, onDeactivated, defineAsyncComponent,
} from '../vue.runtime.esm-browser.prod.js';
import { render as ViewLoadingRender } from './render/app-loading.js';
import { render as ViewErrorRender } from './render/app-error.js';
import { render as AppShellRender } from './render/app-shell.js';
import { createHooks } from './core/hooks.js';
import { createActivity } from './core/activity.js';
import { preloadModule } from './core/page-css.js';

const R = window.WB_ROUTES;
const LAST = 'sb_last_page';

/* ---------- 路由解析：hash / 旧路径 / 别名 → { file, src, page } ---------- */
function parse(input) {
  let s = String(input || '').split('#').pop();
  try { s = decodeURIComponent(s); } catch (e) {}
  const qi = s.indexOf('?');
  const q = qi >= 0 ? s.slice(qi) : '';
  s = (qi >= 0 ? s.slice(0, qi) : s).replace(/^.*\//, '');
  if (!s) s = R.defaultPage;
  const target = R.alias[s] || s;
  const eq = target.indexOf('?');
  const file = eq >= 0 ? target.slice(0, eq) : target;
  const extra = eq >= 0 ? target.slice(eq) : '';
  const page = R.byFile[file];
  if (!page) return null;
  const query = q || extra;
  return { file, query, src: file + query, page };
}

const state = reactive({
  route: parse(location.hash.slice(1)) || parse(window.LS.get(LAST)) || parse(R.defaultPage),
});

/* 页面 / 标签页可见性与关标签前的 flush+dirty 注册表各只有一份（core/activity.js / core/hooks.js）。
   公共层（轮询器 / 缩略图 / 切片）读 `window.__spaActivity.visible()`，页面用 `__spaActivity` 订阅。
   不再写 `__spaPageVisible` 那个裸布尔 —— 两套判据并存就是「切走了还在轮询」那一类。 */
const hooks = createHooks();
const activity = createActivity({ getRoute: () => state.route });
window.__spaActivity = activity;

/* ---------- 按需加载的页面组件 ---------- */
const ViewLoading = { render: ViewLoadingRender };
const ViewError = {
  props: ['error'],
  render: ViewErrorRender,
};
const lazy = loader => defineAsyncComponent({ loader, loadingComponent: ViewLoading, errorComponent: ViewError, delay: 0, timeout: 30000 });
/* 页面组件映射由路由表现搭：`src` 相对本文件解析，不在这里另抄一份。
   `needs` 里那几份公共件（capabilities / text-ai / asset-picker / datasync）不再常驻 shell.html，
   改成挂载前并发补载 —— 既不给别的页面白下，也让这一页的取数与 ESM 图并行。
   补载之前先把这一页自己的 ESM 图发出去（`src` + 路由表点名的 `chunk`）：
   否则三段是串的 —— 等 needs → 取页面 → 页面再取引擎。modulepreload 只取字节不执行，
   执行时机仍由下面那一次 import() 定，顺序约束一点没动。 */
const VIEWS = {};
for (const p of R.pages || []) {
  if (!p || !p.file || !p.src) continue;
  VIEWS[p.file] = lazy(() => {
    preloadModule(p.src);
    for (const m of p.chunk || []) preloadModule(m);
    return window.__spaNeeds(p.needs).then(() => import(p.src));
  });
}

/* ---------- KeepAlive 里的页面宿主：记 / 还原滚动位置 ---------- */
const PageFrame = {
  props: ['view'],
  setup(props) {
    const host = ref(null);
    const saved = new Map();
    const roots = () => {
      const box = host.value;
      if (!box) return [];
      return [box.firstElementChild, ...box.querySelectorAll('*')].filter(Boolean);
    };
    const save = () => {
      if (!host.value || !host.value.isConnected) return;
      for (const el of roots()) {
        if (el.scrollTop || el.scrollLeft) saved.set(el, { t: el.scrollTop, l: el.scrollLeft });
      }
    };
    onDeactivated(save);
    /* KeepAlive 的 deactivated 可能在 DOM 已移走之后才跑，外壳换页前先发一声。 */
    window.addEventListener('spa:before-leave', save);
    onActivated(() => {
      /* 用 setTimeout，不用 rAF：后台标签页里 rAF 根本不跑。 */
      setTimeout(() => {
        for (const [el, v] of saved) {
          /* 已经脱离文档的容器顺手删掉：Map 强引用 DOM 节点，只增不删的话
             页面每次重画丢掉的那批滚动容器都被这一页一直拽着（KeepAlive 页面不销毁，永远不会回收）。 */
          if (!el.isConnected) { saved.delete(el); continue; }
          el.scrollTop = v.t;
          el.scrollLeft = v.l;
        }
      }, 0);
    });
    return () => h('div', { class: 'spa-page-host', ref: host }, [h(props.view)]);
  },
};

const App = {
  components: { PageFrame },
  setup() {
    const activeView = computed(() => VIEWS[state.route.file] || null);

    function syncChrome(route) {
      document.title = (route.page.title || route.page.label || 'AI 创作工作台') + ' · 拾帧';
      if (typeof window.__sbSetActive === 'function') window.__sbSetActive(route.page.file);
    }

    function apply(route) {
      const prev = state.route;
      if (prev && prev.file !== route.file) {
        /* 先记滚动（KeepAlive 摘 DOM 之后滚到底就归零）。 */
        try { window.dispatchEvent(new CustomEvent('spa:before-leave', { detail: { file: prev.file } })); } catch (e) {}
        /* 弹窗 / 下拉 / 灯箱挂在 body 上，不随页面 DOM 离屏：换页时当场收掉。 */
        try { document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch (err) {} }); } catch (e) {}
        try { if (window.Dropdowns) window.Dropdowns.closeAll(); } catch (e) {}
        try { if (window.Wb && Wb.lightbox && Wb.lightbox.isOpen && Wb.lightbox.isOpen()) Wb.lightbox.close(); } catch (e) {}
        activity.setPageVisible(false);
        try { window.dispatchEvent(new CustomEvent('spa:page', { detail: { visible: false, file: prev.file } })); } catch (e) {}
      }
      state.route = route;
      /* 常驻页面池的轮询器读 activity：`document.hidden` 只说明浏览器标签在不在前台，
         说明不了「这一页是不是被切走了」。两处都看才是真的可见。 */
      activity.setPageVisible(true);
      /* `spa:page` 给公共层（缩略图队列等）与页面自己：谁是前台。 */
      try { window.dispatchEvent(new CustomEvent('spa:page', { detail: { visible: true, file: route.file } })); } catch (e) {}
      syncChrome(route);
      try { localStorage.setItem(LAST, route.src); } catch (e) {}
      /* pushState/replaceState 不发 hashchange，助手与页面靠这一条。 */
      try { window.dispatchEvent(new CustomEvent('spa:navigate', { detail: { file: route.file, src: route.src } })); } catch (e) {}
    }

    function go(target, push) {
      const route = parse(target) || parse(R.defaultPage);
      if (state.route && route.src === state.route.src) { syncChrome(route); return; }
      if (push && location.hash.slice(1) !== route.src) history.pushState(null, '', '#' + route.src);
      apply(route);
    }
    window.appShow = go;
    window.__spaRoute = () => state.route;
    /* 生成工作台在页内切 ?t= 时通知一次：地址栏 / 上次页跟着走，刷新仍落在同一档。 */
    window.__spaStudioType = t => {
      if (t !== 'video' && t !== 'image' && t !== 'audio') return;
      const src = 'studio.html?t=' + t;
      try { localStorage.setItem(LAST, src); } catch (e) {}
      if (state.route && state.route.file === 'studio.html' && location.hash.slice(1) !== src) {
        history.replaceState(null, '', '#' + src);
      }
    };

    provide('spaActiveFile', computed(() => state.route && state.route.file));
    provide('spaRoute', readonly(state));

    watch(() => state.route, route => { if (route) syncChrome(route); });

    onMounted(() => {
      apply(state.route);
      if (location.hash.slice(1) !== state.route.src) history.replaceState(null, '', '#' + state.route.src);
    });

    return { state, activeView };
  },

  render: AppShellRender,
};

/* ---------- 浏览器前进 / 后退 ---------- */
window.addEventListener('hashchange', () => {
  const r = parse(location.hash.slice(1));
  if (!r) {
    if (state.route) history.replaceState(null, '', '#' + state.route.src);
    return;
  }
  if (!state.route || r.src !== state.route.src) window.appShow(r.src, false);
});

/* 窄窗口里侧栏是浮层：点内容区要能收回去（页面与外壳同一份文档）。 */
document.addEventListener('click', e => {
  const t = e.target;
  if (t && t.closest && t.closest('.sidebar, dialog[open], #lbStage, #apDlg, [data-sb-keep]')) return;
  if (typeof window.__sbCloseOverlay === 'function') window.__sbCloseOverlay();
}, true);

/* 关标签 / 刷新前：多个常驻页面都要能交保存与未落盘状态。
   注册表只有 core/hooks.js 一份；`__spaFlush`/`__spaDirty` 是旧页面留下的单函数钩子，
   只给「没注册进注册表」的那几页兜底（裸页面 / 探针）——同一枚函数两边都挂时只跑注册表那遍。 */
window.__spaRegister = (flush, dirty) => hooks.register(flush, dirty);
/* 「重新加载本页」的唯一出口：模块没起来 / 初始化失败的那几页，失败块里只写过一句
   「刷新页面重试」却没有可点的按钮 —— 键盘用户与移动端就此没有出路。
   刷新前照 beforeunload 那样先把各页的保存交出去，reload 也会走那一趟，这里是双保险。 */
window.__spaReload = () => { try { hooks.runAll(); } catch (e) {} location.reload(); };
window.addEventListener('beforeunload', e => {
  const dirty = hooks.runAll();
  /* 旧单函数钩子只给「没进注册表」的那几页兜底（裸页面 / 探针）；同一枚函数已经注册过
     就不再补跑 —— 不然导演台与设置页的 flush 每次关标签各跑两遍。 */
  let legacy = '';
  try { if (typeof window.__spaFlush === 'function' && !hooks.has(window.__spaFlush)) window.__spaFlush(); } catch (err) {}
  try { if (typeof window.__spaDirty === 'function' && !hooks.has(window.__spaDirty) && window.__spaDirty()) legacy = '1'; } catch (err) {}
  if (dirty || legacy) { e.preventDefault(); e.returnValue = ''; }
});

const app = createApp(App);
app.config.errorHandler = (err, instance, info) => {
  console.error('[spa]', info, err);
  try { if (window.Toast) Toast.err('页面出错：' + String(errText(err))); } catch (e) {}
  /* 以前这一句只进 Toast 与控制台，代理那本健康账里一点痕迹都没有：
     用户过一会儿就忘了、复述不准，而「设置 → 本机环境 → 代理健康」翻不出这一条。
     横幅这里不再重复弹（Toast 已经念过那一句了），只补一条进账。 */
  try { if (window.PageReport) PageReport.pageFail('外壳', 'Vue 出错（' + String(info || '') + '）：' + errText(err), err); } catch (e) { /* 上报层自己坏了不许再抛：横幅与 Toast 上面已经念过 */ }
};
app.mount('#app');
