/* web/core/scroll-guard.js —— 全站一份：**整片重画不许吃掉滚动位**。

   毛病（用户报过：「有的页面点击按钮等组件后视角会移动到页面最上方」）：
   某块面板被整片重画（`el.innerHTML = …`）时，里面那个**滚动容器**是连同它的内容一起被换掉的 ——
   新节点的 scrollTop 从 0 起。用户正在那一栏的下半截看着东西，点一颗按钮（哪怕那颗按钮与滚动
   毫无关系，比如「提示词优化」那颗开关）就把视口甩回栏顶。

   导演台右栏实测（headless Chrome + 真实数据）：
     点「提示词优化」开关 → panel.js:395 → `renderEditor()` → panel.js:1627 `col.innerHTML = …`
     → `.ed-body` 被换掉 → scrollTop 400 → 0。
   同一族还有配音右栏（engine/voice.js:368 的 `col.innerHTML =`）。

   这里只做一件事：**重画前后把滚动位还回去**。
   · 不猜用户想看哪一段，只把原来那个位置放回去（内容变矮时浏览器自己夹到上限）。
   · 不拦任何**故意**的滚动：设置页目录轨的跳转、素材库的「定位到这一条」走的是
     `scrollIntoView` / `scrollTo`，那条路不经过这里（scrollIntoView 也不换节点，位置不丢）。
   · 只记**用户真的滚过**的容器（scroll 事件里登记）—— 没滚过的容器本来就不该被还原。

   为什么放在外壳（web/core）而不是导演台里就地补：
   「重画把滚动位吃掉」是全站一族的毛病（哪一页的哪一块被整片重画都算），
   在每个重画点各写一遍就是第二份实现；这里一份补丁罩住所有 `innerHTML` / `outerHTML` 的整片重画。 */

/* 低于这个像素数不算「滚过」：免得把 1px 的抖动也当成滚动记下来。 */
const MIN_SCROLL = 4;

export function createScrollGuard() {
  /* 滚过的容器。Set 里可能留着已经离开文档的节点（KeepAlive 的页面池不销毁节点），
     每次 grab 时顺手清一遍；否则这一份会一直拽着旧页面。 */
  const scrolled = new Set();

  function onScroll(e) {
    const t = e.target;
    if (t && t.nodeType === 1 && t.scrollTop > MIN_SCROLL) scrolled.add(t);
  }
  document.addEventListener('scroll', onScroll, true);

  /* 容器在 root 底下的相对位置（ child 下标链，不是 CSS 路径）：
     重画之后按同一条链找回**新**节点 —— 用下标链而不是选择器，是因为
     「*:nth-child(2)」这种写法会命中文档里第一个「第 2 个孩子」，认错人。 */
  function chainOf(el, root) {
    const idx = [];
    let n = el;
    while (n && n !== root) {
      const p = n.parentElement;
      if (!p) return null;               // 不在 root 底下
      let i = 0;
      const kids = p.children;
      for (let k = 0; k < kids.length; k++) { if (kids[k] === n) { i = k + 1; break; } }
      if (!i) return null;
      idx.unshift(i);
      n = p;
    }
    if (n !== root) return null;
    return idx;
  }

  function byChain(root, idx) {
    let n = root;
    for (const i of idx) {
      n = n.children[i - 1];
      if (!n) return null;
    }
    return n;
  }

  /* 重画之前：把 root 底下正在滚的容器的位置收起来。 */
  function grabScroll(root) {
    const keep = [];
    if (!root || root.nodeType !== 1) return keep;
    for (const el of scrolled) if (!el.isConnected) scrolled.delete(el);
    const list = [];
    if (root.scrollTop > MIN_SCROLL) list.push({ el: root, chain: null });
    for (const el of scrolled) {
      if (el === root) continue;
      if (!root.contains(el)) continue;
      const chain = chainOf(el, root);
      if (chain) list.push({ el, chain });
    }
    for (const it of list) {
      const top = Math.round(it.el.scrollTop);
      if (top <= MIN_SCROLL) continue;
      keep.push({ chain: it.chain, top });
    }
    return keep;
  }

  /* 重画之后：按同一条链把位置放回去。
     只在「现在确实停在顶上」时放（本来就没动过的不碰）；内容变矮时浏览器自己会夹到上限。 */
  function putScroll(keep, root) {
    if (!keep || !keep.length || !root) return;
    for (const k of keep) {
      const el = k.chain ? byChain(root, k.chain) : root;
      if (!el || !el.isConnected) continue;
      if (el.scrollTop > MIN_SCROLL) continue;
      try { el.scrollTop = k.top; } catch (e) { /* 那一格已经不可滚了就算了 */ }
    }
  }

  /* 罩住「整片换掉」的那几种写法：innerHTML / outerHTML / replaceChildren。
     换完之后立刻把位置放回去 —— 放在同一帧里做，看不到「先跳顶再回来」那一闪。 */
  function patchSetter(proto, prop) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      get: d.get,
      set(v) {
        let keep = null;
        try { keep = grabScroll(this); } catch (e) { keep = null; }
        const r = d.set.call(this, v);
        try { if (keep && keep.length) putScroll(keep, this); } catch (e) { /* 放不回去也不许把重画带崩 */ }
        return r;
      },
      configurable: true,
      enumerable: d.enumerable,
    });
  }

  patchSetter(Element.prototype, 'innerHTML');
  patchSetter(Element.prototype, 'outerHTML');
  if (typeof Element.prototype.replaceChildren === 'function') {
    const rc = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...kids) {
      const keep = grabScroll(this);
      const r = rc.apply(this, kids);
      if (keep && keep.length) putScroll(keep, this);
      return r;
    };
  }

  return { grabScroll, putScroll };
}

/* 装上这一份（全站唯一入口）。返回的 API 也挂到 window.ScrollGuard：
   页面若要保护**不是** innerHTML 的那种换法（例如自己 removeChild），自己 grab / put 一把。 */
export function installScrollGuard() {
  if (window.ScrollGuard) return window.ScrollGuard;
  const api = createScrollGuard();
  window.ScrollGuard = api;
  return api;
}
