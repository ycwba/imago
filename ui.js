/* ============================================================================
   ui.js —— 自定义下拉组件（与图片工作台完全同一套）
   用法：
     1) 页面 <script src="ui.js"></script>
     2) 静态下拉：DOM 就绪后 Dropdowns.build(document)；
        动态重建的下拉：重建 HTML 之后再 Dropdowns.build(容器)
     3) 页面代码改完 <select> 的 <option> 后调用 sel._ddRebuild?.()
   说明：原生 <select> 仍作为唯一数据源（保留 value / change 事件 / 表单行为），
        只是被隐藏，改用 .dd 组件渲染，观感与图片工作台一致。
   ========================================================================== */
(function () {
  const ARW = '<svg class="arw" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" stroke="#8f97ab" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
  /* 下拉浮层**挂到 body 上用 fixed 定位**，不留在 <select> 原来的位置上。
     以前是原地展开（.dd-list 是 .dd 的子节点），于是任何祖先的 overflow 都会把它裁掉：
     生成工作台的高级设置面板 .adv 是 overflow:hidden、左右两栏是 overflow-y:auto、外层
     .layout 还是 overflow:hidden —— 一个下拉要穿过三层裁剪，表现就是「点开了但只露出一条边」。
     逐个容器去改 overflow 等于把同一个毛病抄 N 份（而且 `overflow:visible` 常常会让布局更难看），
     浮层脱离文档流之后裁剪与层叠都不再受祖先影响。 */
  const DD_LIST_MAXH = 264;      // 与 .dd-list 的 max-height 一致（这里还要用来算「往哪边开」）
  const DD_GAP = 6;              // 浮层与按钮的间距
  const DD_EDGE = 10;            // 离视口边缘留一点，贴着边会被裁

  /* 已挂到 body 的浮层（收起时留着节点，只是不显示 —— 省得每次展开重画一遍） */
  const portals = [];
  let openDd = null;

  function place(dd) {
    const btn = dd._ddBtn, list = dd._ddList;
    if (!btn || !list || !btn.isConnected) return;
    const r = btn.getBoundingClientRect();
    if (!r.width && !r.height) return;              // 还在隐藏的容器里（切页/折叠中）：不乱摆
    const vh = window.innerHeight || 800;
    const below = vh - r.bottom - DD_EDGE;
    const above = r.top - DD_EDGE;
    /* 下方够就用下方（视觉上更符合直觉）；下方不够而上方更宽裕才往上开。
       两者都不够时取较大的一边，并按可用高度压低 max-height（仍然内部滚动）。 */
    const up = below < 160 && above > below;
    const room = Math.max(80, up ? above : below);
    const h = Math.min(DD_LIST_MAXH, room);
    list.style.maxHeight = h + 'px';
    list.style.minWidth = Math.round(r.width) + 'px';
    list.style.maxWidth = Math.min(window.innerWidth - DD_EDGE * 2, Math.max(r.width, 340)) + 'px';
    if (up) {
      list.classList.add('up');
      list.style.top = ''; list.style.bottom = Math.round(vh - r.top + DD_GAP) + 'px';
    } else {
      list.classList.remove('up');
      list.style.bottom = ''; list.style.top = Math.round(r.bottom + DD_GAP) + 'px';
    }
    /* 横向也别顶出视口 */
    const lw = list.offsetWidth || r.width;
    const left = Math.max(DD_EDGE, Math.min(r.left, window.innerWidth - lw - DD_EDGE));
    list.style.left = Math.round(left) + 'px';
  }

  function openDd_(dd) {
    if (openDd && openDd !== dd) closeDd(openDd);
    if (!dd._ddList.isConnected) document.body.appendChild(dd._ddList);
    dd.classList.add('open');
    dd._ddList.classList.add('on');
    openDd = dd;
    place(dd);
    /* 选项多的时候把当前选中项滚到可见处（浮层是独立滚动容器了，这一行走的是它自己的 scrollTop） */
    const cur = dd._ddList.querySelector('.dd-opt.sel');
    if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) { dd._ddList.scrollTop = Math.max(0, cur.offsetTop - 40); } }
  }
  function closeDd(dd) {
    dd.classList.remove('open');
    if (dd._ddList) dd._ddList.classList.remove('on');
    if (openDd === dd) openDd = null;
  }

  /* 页面滚动 / 窗口变化时重新定位：浮层是 fixed，不跟着按钮走，
     不重新摆就会停在原地对着空气（原来靠「在祖先里」才碰巧跟着滚）。 */
  let rafPending = false;
  function onViewportChange() {
    if (!openDd) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; if (openDd) place(openDd); });
  }
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  function buildOne(sel) {
    if (!sel || sel._ddBuilt) return;
    if (sel.closest('.dd')) return;
    const dd = document.createElement('div');
    dd.className = 'dd';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    btn.append(lbl, fromHTML(ARW));
    const list = document.createElement('div');
    list.className = 'dd-list';

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      lbl.textContent = (o && (o.dataset.ddLabel || o.textContent)) || '请选择';
      [...list.children].forEach(it => it.classList.toggle('sel', it.dataset.val === sel.value));
    };
    const buildList = () => {
      list.innerHTML = '';
      const addOpt = o => {
        if (!o || o.tagName !== 'OPTION' || o.hidden) return;
        const item = document.createElement('div');
        item.className = 'dd-opt';
        item.dataset.val = o.value;
        item.innerHTML = `<span class="chk">✓</span><span class="tx"></span>`;
        item.querySelector('.tx').textContent = o.dataset.ddLabel || o.textContent;
        if (o.title) item.title = o.title;
        item.onclick = e => {
          e.stopPropagation();
          if (sel.value !== o.value) {
            sel.value = o.value;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          sync();
          closeDd(dd);
        };
        list.appendChild(item);
      };
      /* optgroup 也要渲染出来（模型列表按 API 来源分组：同一个平台的模型在同一组下）。
         原生 select 仍是数据源，这里只是照着它的结构重画一遍。 */
      [...sel.children].forEach(node => {
        if (node.tagName === 'OPTGROUP') {
          const g = document.createElement('div');
          g.className = 'dd-grp';
          g.textContent = node.label || '';
          list.appendChild(g);
          [...node.children].forEach(addOpt);
        } else addOpt(node);
      });
      sync();
      /* 开着的时候重画了内容（页面改完 option 调 _ddRebuild）→ 重新摆一次，高度可能变了 */
      if (dd.classList.contains('open')) place(dd);
    };
    sel._ddRebuild = () => { buildList(); sync(); };
    buildList();

    btn.onclick = e => {
      e.stopPropagation();
      if (openDd === dd) closeDd(dd);
      else openDd_(dd);
    };
    dd._ddBtn = btn;
    dd._ddList = list;
    dd.append(btn);            // 浮层不进 .dd：它挂在 body 上（见上面的说明）
    sel.before(dd);
    dd.appendChild(sel);   // 原生 select 留在里面并隐藏，作为数据源
    sel._ddBuilt = true;
    portals.push(dd);
  }

  function fromHTML(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  /* ---------- 筛选芯片行（与 Dropdowns 同一类：一排可点的档位按钮） ----------
     四个页面（资产库 / 角色库 / 收藏 / 用量）原先各写一份「拼 innerHTML + querySelectorAll 绑 onclick」，
     连选中态的 class 字符串都是各拼各的（一度还分 ' active' 与 ' on' 两派）。
     真正不同的只有两点，收成参数：标签后面跟不跟一个条数（count）、点完之后各自做什么（onPick）。 */
  window.Chips = {
    /* items: ['值'] 或 ['值', '显示文字']；cur 是当前值（相等就标上 .on）。 */
    render(el, items, cur, onPick, opt) {
      const box = typeof el === 'string' ? document.getElementById(el) : el;
      if (!box) return;
      const o = opt || {};
      /* 选中判据默认是「值 === 当前值」。有一行的判据不一样：资产库的日期预设里，
         手动填了起止日期时 presetDays 还停在 0，但「全部」那颗不该再亮着 ——
         所以那一行自己给 isOn，别为了迁就它把公共那份改松。 */
      const on = v => (o.isOn ? !!o.isOn(v) : v === cur);
      box.innerHTML = items.map(it => {
        const pair = Array.isArray(it);
        const v = pair ? it[0] : it, label = pair ? it[1] : it;
        const n = o.count ? Number(o.count(v)) || 0 : 0;
        /* 值与标签都过一遍 esc：标签里有平台名 / 计量单位这种外来词，
           原先五份里 assets 用 textContent（天然安全）、另几份直接拼进 innerHTML。统一到安全的那一侧。 */
        return '<button class="chip' + (on(v) ? ' on' : '') + '" data-v="' + window.esc(v) + '">'
          + window.esc(label) + (n ? ' ' + n : '') + '</button>';
      }).join('');
      box.querySelectorAll('.chip').forEach(b => { b.onclick = () => onPick(b.dataset.v); });
    },
  };

  window.Dropdowns = {
    build(root) {
      const scope = root && root.querySelectorAll ? root : document;
      if (scope.matches && scope.matches('select')) buildOne(scope);
      scope.querySelectorAll('select').forEach(buildOne);
    },
    /* 页面代码直接改了 select.value / 换了整份 options 之后，同步显示文字并**重画选项列表**。
       root 可以是容器，也可以**直接是那个 select 本身**（与 build 对称）——
       少了这一条就会出现「下拉里空空的」：select 明明已经有选项，浮层那份列表还是页面加载时的快照
       （那时 options 还没填），点开什么都没有。填完 options 一定要调它。 */
    sync(root) {
      const scope = root && root.querySelectorAll ? root : document;
      if (scope.matches && scope.matches('select')) { if (scope._ddBuilt) scope._ddRebuild(); }
      scope.querySelectorAll('select').forEach(sel => { if (sel._ddBuilt) sel._ddRebuild(); });
      if (openDd) place(openDd);
    },
    /* 切页 / 重建那一块 DOM 之后，把已经不连在文档里的浮层节点回收掉 ——
       否则 body 上会攒下一堆孤立的 .dd-list（每个都还带着自己的选项副本）。 */
    sweep() {
      for (let i = portals.length - 1; i >= 0; i--) {
        const dd = portals[i];
        if (dd.isConnected) continue;
        if (dd._ddList && dd._ddList.isConnected) dd._ddList.remove();
        portals.splice(i, 1);
        if (openDd === dd) openDd = null;
      }
    },
  };

  document.addEventListener('click', e => {
    /* 浮层已经不在 .dd 里面了，命中判断要同时看按钮与浮层本身 */
    const hit = e.target && e.target.closest && e.target.closest('.dd, .dd-list');
    if (openDd && hit && (hit === openDd || hit === openDd._ddBtn || (openDd._ddList && openDd._ddList.contains(hit)))) return;
    if (openDd) closeDd(openDd);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openDd) closeDd(openDd);
  });
})();

/* ============================================================================
   PickSel —— 「在一堆卡片里点选多个」那一份判据（只此一份）
   统一选择器（assetlib.js 的 AssetPicker）与素材库挑选（拍短剧「认角色」）共用同一套语义：
     · 普通点 = 选中 / 取消这一张（**不要求按 Ctrl**）
     · Shift 点 = 从上一次点过的那张连选一整段
     · 到上限当场拦下并说明原因（「已选满，先取消一个再选」），不是点下去没反应
     · 可见顺序变了（筛选 / 切档 / 翻页）→ 连选锚点作废，否则 Shift 会选到不相邻的一段
   条目身份用引用（Set），所以调用方要**复用同一批对象**；池子换了就 prune 一次。
   只管「选了哪些」，卡片长什么样、缩略图怎么加载都还是页面 / AssetPicker 自己的事。
   用法：
     const ps = PickSel({ limit: 8, onSync: paintSel, onNote: t => cnt.textContent = t });
     card.onclick = e => ps.click(visibleList, item, e.shiftKey);
     cnt.textContent = ps.countText();
   ========================================================================== */
window.PickSel = function PickSel(o) {
  const opt = o || {};
  const cap = Math.max(0, Number(opt.limit) || 0);        // 本次还能加几个（0 = 不限）
  const total = Math.max(0, Number(opt.total) || 0);      // 这个槽位一共收几个（只为把话说清楚）
  const multiple = opt.multiple !== false;
  const picked = new Set();
  let anchor = -1, sig = '';
  /* 锚点的「那一段顺序」签名：从列表开头一直签到锚点那一张为止。
     keyOf 可选：条目没有稳定 id 时用引用拼串没意义，交给调用方给键。 */
  const keysUpTo = (arr, i) => arr.slice(0, i >= 0 ? i + 1 : arr.length)
    .map((e, j) => (opt.keyOf ? opt.keyOf(e) : j)).join('|');
  const setAnchor = (arr, i) => { anchor = i; sig = keysUpTo(arr, i); };
  const sync = () => { if (opt.onSync) { try { opt.onSync(); } catch {} } };
  const note = t => { if (opt.onNote) { try { opt.onNote(t); } catch {} } };
  /* 外部（本地上传）把条目塞进**同一个** picked：点卡片与传文件必须是同一份选中，
     否则计数只数点过的那一边，「确定」交出去的也只有点过的那一批
     （症状就是「传了本地文件却加不进参考槽」）。上限判据仍只在这里一份。 */
  const addOne = e => {
    if (!e || picked.has(e)) return false;
    if (cap && picked.size >= cap) return false;
    picked.add(e);
    return true;
  };

  return {
    get size() { return picked.size; },
    has: e => picked.has(e),
    list: () => [...picked],
    clear() { picked.clear(); sync(); },
    /* 返回真正加进去的个数，差值就是被上限挡掉的（调用方照实说，别自己再编一套上限） */
    add: addOne,
    addMany(list) { let n = 0; for (const e of list || []) if (addOne(e)) n++; if (n) sync(); return n; },
    /* 列表重画：锚点之前那一段没变就留着，变了才作废。
       「一次画 200 条、滚到底再追加 200 条」时前面顺序一个字没动 —— 作废的表现是
       Shift 连选忽然退成单选，用户以为连选坏了；而真换了筛选 / 档位、或者锚点那一张
       已经不在列表里时，这一串键必然跟着变，照样作废（AGENTS 里那条「顺序变了锚点作废」守的就是这个）。 */
    reflow(order) {
      const arr = order || [];
      if (anchor >= 0 && keysUpTo(arr, anchor) === sig) return;
      setAnchor(arr, -1);
    },
    click(order, e, shift) {
      const arr = order || [];
      const idx = arr.indexOf(e);
      if (!multiple) { picked.clear(); picked.add(e); setAnchor(arr, idx); sync(); return; }
      if (shift && anchor >= 0 && idx >= 0) {
        const a = Math.min(anchor, idx), b = Math.max(anchor, idx);
        let overflow = 0;
        for (let i = a; i <= b; i++) {
          const it = arr[i];
          if (!it || picked.has(it)) continue;
          if (cap && picked.size >= cap) { overflow++; continue; }
          picked.add(it);
        }
        setAnchor(arr, idx);
        sync();
        if (overflow) note('这一段有 ' + (b - a + 1) + ' 个，已选满 ' + cap + ' 个，多的没选中');
        return;
      }
      setAnchor(arr, idx);
      if (picked.has(e)) picked.delete(e);
      else {
        if (cap && picked.size >= cap) { note('最多选 ' + cap + ' 个（已选满，先取消一个再选）'); return; }
        picked.add(e);
      }
      sync();                       // 只改选中态，不重建卡片（否则缩略图又闪一次）
    },
    /* 池子变了（新到的一批把这一条并掉了）→ 选中跟着挪到留任的那一条上。
       没有这一步，「同一份文件换了个来路」就等于把用户已经点中的东西无声丢掉
       （选择器里收藏那一批先画、平台列表几秒后才到，正好撞上）。 */
    replace(oldE, newE) {
      if (!oldE || !picked.has(oldE)) return false;
      picked.delete(oldE);
      if (newE) picked.add(newE);
      sync();
      return true;
    },
    /* 池子变了（换筛选条件、刷新列表）→ 已经不在池里的选择要作废，别把幽灵条目交出去 */
    prune(keep) { [...picked].forEach(e => { if (!keep.has(e)) picked.delete(e); }); },
    countText() {
      const room = total && cap && total > cap ? (' / 还能加 ' + cap) : (cap ? ' / ' + cap : '');
      return cap ? ('已选 ' + picked.size + room + (picked.size >= cap ? '（已选满）' : ''))
        : (picked.size ? '已选 ' + picked.size + ' 个' : '');
    },
  };
};

/* ============================================================================
   esc —— HTML 转义（拼 innerHTML 时统一用它包住用户/接口文本）
   场景名、镜头名、提示词、AI 摘要、平台名这些都可能带 < & " ，直接拼进模板会显示错乱甚至注入。
   用法：`<div>${esc(name)}</div>`
   ========================================================================== */
window.esc = function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

/* ============================================================================
   sanitizeHTML —— 「拼好的 HTML 片段」进 innerHTML 前的统一清洗
   状态行/信息行到处是这种写法：setStatus('<span class="err">失败：' + e.message + '</span>')，
   而 e.message、文件名、平台名、AI 文本都来自上游或用户 —— 里面带一个 <img src=x onerror=…>
   就在工作台本源里执行了（那一页有密钥与设置）。字数阈值、逐点转义都堵不住几十处调用点，
   所以在**进 innerHTML 之前**清洗一次：
     · 只保留白名单标签（排版用的那几个），属性也只留 class/title/href
     · href 只留 http/https/站内相对路径，javascript: 一律丢掉
     · 其它标签整棵子树换成它的纯文本 —— 注入串不会再被解析成元素
   DOMParser 不执行脚本、也不加载资源，解析这一步本身是安全的。
   ========================================================================== */
(function () {
  const OK = {
    SPAN: ['class'], DIV: ['class'], P: ['class'], B: [], STRONG: [], I: [], EM: [], SMALL: [],
    CODE: [], PRE: [], BR: [], UL: [], OL: [], LI: [], DEL: [], S: [],
    /* 下面这批是 Md（markdown 渲染，见下）要用的排版标签：标题、引用、分隔线、表格。
       仍然只放行标签本身、一个属性都不给 —— 表格能显示就够，
       对齐、宽度、背景色那些属性带来的风险不值得。 */
    H1: [], H2: [], H3: [], H4: [], H5: [], H6: [], BLOCKQUOTE: [], HR: [],
    TABLE: [], THEAD: [], TBODY: [], TR: [], TH: [], TD: [],
    A: ['href', 'title', 'class'],
  };
  const safeHref = v => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (s.startsWith('/') || s.startsWith('#')) return s;                  // 站内相对路径
    if (/^https?:\/\//i.test(s)) return s;
    return '';                                                            // javascript:/data:/… 丢掉
  };
  const attrsOf = (el, names) => names.map(n => {
    let v = el.getAttribute(n);
    if (!v) return '';
    if (n === 'href') v = safeHref(v);
    if (!v) return '';
    return ' ' + n + '="' + window.esc(v) + '"';
  }).join('');
  function walk(node, out) {
    node.childNodes.forEach(child => {
      if (child.nodeType === 3) { out.push(window.esc(child.nodeValue)); return; }
      if (child.nodeType !== 1) return;
      const allow = OK[child.tagName];
      if (!allow) { out.push(window.esc(child.textContent)); return; }     // 非白名单 → 纯文本
      const tag = child.tagName.toLowerCase();
      if (tag === 'br' || tag === 'hr') { out.push('<' + tag + '>'); return; }   // 这两个没有内容，也没有结束标签
      out.push('<' + tag + attrsOf(child, allow) + '>');
      walk(child, out);
      out.push('</' + tag + '>');
    });
  }
  window.sanitizeHTML = function sanitizeHTML(html) {
    const s = String(html == null ? '' : html);
    if (s.indexOf('<') < 0) return window.esc(s);                          // 纯文本：直接转义
    const doc = new DOMParser().parseFromString(s, 'text/html');
    const out = [];
    walk(doc.body, out);
    return out.join('');
  };
})();

/* ============================================================================
   Md —— markdown → HTML（模型写给人看的正文；全站只此一份实现）
   ============================================================================
   给「一整段散文」用：AI 助手的回答、任务结果通知。以后别处要显示 AI 输出也从这儿走，
   别再各写一个正则渲染器。

   为什么不引第三方库：这是个纯本地工具，AI 正文里会带提示词、JSON、代码与外链，
   而项目已经有一套成型的安全口径（sanitizeHTML 的标签白名单 + href 协议过滤，
   以及「页面不直连外部域名」那条硬性路由约定）。换成一个黑箱库等于把这套口径退回去。
   所以这里照着那套口径手写，产出**再过一遍 sanitizeHTML**：
   解析器只可能漏、不会「多放行」，这一遍就是最后一道闸。

   三条硬约定：
     ① 转义只发生在 inline() 一处、且发生在最前面，所以不存在「某个分支忘了转义」。
        块级判定跑在**原文**上，所以 `>` / `-` 这些标记在代码里照写，不用变成转义后的样子。
        本模块不认原始 HTML —— 用户要贴一段 HTML，出来就是字面量，本地工具该是这个行为。
     ② 图片降级成一行文字、不出 <img>：本项目的字节一律走本机代理，
        一个外链 <img> 就是页面自己在直连外部域名（见 AGENTS.md「统一路由」）。
     ③ 单换行当换行。聊天里另起一行通常是作者刻意的（列步骤、列参数），折成一段就丢了。
   用法：Md.html(text) → HTML 字符串；Md.mount(el, text) → 写进元素（流式时用这个）。
   ========================================================================== */
(function () {
  const E = s => window.esc(s);
  /* 解析过程用两个私用区字符占位：围栏代码块与行内代码。
     先占位、解析完再还原 —— 代码内容就不会在解析阶段被当成强调、链接或标题。
     用私用区是因为正常正文里见不到这两个字符。占位符在下面各处都写成字面量，
     改的时候要一起改（isBlk、blocks、inline、html 四处）。 */
  const BUL = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isBlk = l => /^\s*(?:\u0000\d+\u0000|```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||-{3,}\s*$)/.test(String(l));
  const isSep = l => {                       // 表格的表头分隔行：|---|---| 或 --- | ---
    const s = String(l == null ? '' : l).trim();
    if (s.indexOf('-') < 0) return false;
    return s.replace(/^\||\|$/g, '').split('|').every(c => /^:?-+:?$/.test(c.trim()));
  };
  const cells = l => {
    let s = String(l == null ? '' : l).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(x => x.trim());
  };
  /* 行内：代码 → 图片 → 链接 → 强调 → 删除线 → 换行。顺序不能换 ——
     行内代码摘出来之后，里面那些 * _ [ ] 才不会被当成别的标记。 */
  function inline(t) {
    const codes = [];
    let s = E(t);
        /* 行内代码最多认两个反引号：三个及以上的是围栏，已经在上面摘走了；
       没摘走的说明围栏没闭合（模型忘了写结尾、或流式正写到一半）——
       那串反引号就该照字面显示，而不是被当成一段空代码（内容用 +? 而不是 *?：
       内容还要求**不以反引号开头**（上面那个 [^`]）：否则「```」会被配成
       「一个反引号 + 内容是另一个反引号」，界面上就出现一个莫名其妙的空代码块）。 */
    s = s.replace(/(`{1,2})([^`][\s\S]*?)\1/g, (m, f, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001'; });
    /* 图片降级成文字（约定②）。alt 与地址都随整段一起转义过了，这里直接拼 ——
       再 E() 一次会把 & 变成 &amp;amp;，点开链接就带着一串转义符。 */
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]*)\)/g, (m, alt, u) => '［图：' + (alt || u) + '］');
    s = s.replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (m, txt, u) =>
      '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + (txt || u) + '</a>');
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(（*])_([^_\n]+)_(?=$|[\s)）。,，!！?？:：])/g, '$1<em>$2</em>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\n/g, '<br>');                                       // 约定③
    return s.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[+i] + '</code>');
  }
  function table(ls, i) {
    const h = ['<table><thead><tr>' + cells(ls[i]).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'];
    i += 2;
    while (i < ls.length && ls[i].trim() && ls[i].indexOf('|') >= 0) {
      h.push('<tr>' + cells(ls[i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      i++;
    }
    h.push('</tbody></table>');
    return { h: h.join(''), i: i };
  }
  /* 列表按缩进递归。一层最常见，两层（子项）也认；再深就当一层 ——
     聊天里的回答用不到更深，认不出来反而会把缩进当正文显示出来。 */
  function list(ls, i, base, ord) {
    let h = ord ? '<ol>' : '<ul>', any = false;
    while (i < ls.length) {
      const m = BUL.exec(ls[i]);
      if (!m) {
        if (any && ls[i].trim() && !isBlk(ls[i])) { h += '<br>' + inline(ls[i]); i++; continue; }   // 列表项的续行
        break;
      }
      const ind = m[1].length;
      if (ind > base) { const c = list(ls, i, ind, /\d/.test(m[2])); h += '<li>' + c.h + '</li>'; i = c.i; continue; }
      if (ind < base) break;
      h += '<li>' + inline(m[3]);
      i++;
      while (i < ls.length && ls[i].trim() && !BUL.test(ls[i]) && !isBlk(ls[i])) { h += '<br>' + inline(ls[i]); i++; }
      h += '</li>';
      any = true;
    }
    return { h: h + (ord ? '</ol>' : '</ul>'), i: i };
  }
  function blocks(raw) {
    const ls = String(raw == null ? '' : raw).split('\n');
    const out = [];
    let i = 0;
    while (i < ls.length) {
      const L = ls[i];
      if (!L.trim()) { i++; continue; }
      /* 整行就是一个围栏代码块占位：留给最后一步还原，别裹进 <p>（<p> 里不能放 <pre>） */
      if (/^\u0000\d+\u0000$/.test(L.trim())) { out.push(L.trim()); i++; continue; }
      const hd = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(L);
      if (hd) { const n = hd[1].length; out.push('<h' + n + '>' + inline(hd[2]) + '</h' + n + '>'); i++; continue; }
      if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(L)) { out.push('<hr>'); i++; continue; }
      if (/^\s{0,3}>/.test(L)) {
        const buf = [];
        while (i < ls.length && /^\s{0,3}>/.test(ls[i])) { buf.push(ls[i].replace(/^\s{0,3}>\s?/, '')); i++; }
        out.push('<blockquote>' + blocks(buf.join('\n')) + '</blockquote>');
        continue;
      }
      if (L.indexOf('|') >= 0 && i + 1 < ls.length && isSep(ls[i + 1])) { const t = table(ls, i); out.push(t.h); i = t.i; continue; }
      const b = BUL.exec(L);
      if (b) { const l = list(ls, i, b[1].length, /\d/.test(b[2])); out.push(l.h); i = l.i; continue; }
      const buf = [];
      while (i < ls.length && ls[i].trim() && !isBlk(ls[i]) && !BUL.test(ls[i])) { buf.push(ls[i]); i++; }
      /* 兜底：这一行既不构成块、也不是段落起点（以 | 开头而下一行不是表分隔线那种）。
         必须自己吃掉它 —— 不吃的话上面那个 while 一次都不进，就是原地打转。 */
      if (buf.length) out.push('<p>' + inline(buf.join('\n')) + '</p>');
      else { out.push('<p>' + inline(L) + '</p>'); i++; }
    }
    return out.join('');
  }
  function html(text) {
    const fences = [];
    /* 围栏代码块先摘出来：里面的 * _ # | 都只是代码，不能当 markdown 标记 */
    const src = String(text == null ? '' : text)
      .replace(/```[\w+#.-]*[ \t]*\r?\n?([\s\S]*?)```/g, (m, code) => {
        fences.push(String(code).replace(/[\s\n]+$/, ''));
        return '\u0000' + (fences.length - 1) + '\u0000';
      });
    const out = blocks(src).replace(/\u0000(\d+)\u0000/g, (m, i) =>
      fences[+i] == null ? m : '<pre><code>' + E(fences[+i]) + '</code></pre>');
    return window.sanitizeHTML(out);
  }
  /* 代码块上的「复制」按钮。复制的是 code 的 textContent —— 不是 pre 的：
     按钮自己就挂在 pre 里，取 pre 会把「复制」两个字一起复制走。 */
  function wire(root) {
    if (!root || !root.querySelectorAll) return;
    const ps = root.querySelectorAll('pre');
    for (let i = 0; i < ps.length; i++) {
      const pre = ps[i], code = pre.querySelector('code');
      if (!code || pre.querySelector('.md-copy')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-copy';
      btn.textContent = '复制';
      btn.addEventListener('click', () => {
        (navigator.clipboard ? navigator.clipboard.writeText(code.textContent) : Promise.reject()).then(
          () => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1400); },
          () => toast('浏览器不让直接复制，选中代码手动复制吧', 'warn'));
      });
      pre.appendChild(btn);
    }
  }
  window.Md = {
    html: html,
    /* 流式时用这个：一次流里要重画几十次，代码块按钮每次重挂一遍
       （wire 里有幂等判断，不会堆出第二个「复制」）。 */
    mount(el, text) {
      if (!el) return;
      el.innerHTML = html(text);
      wire(el);
    },
  };
})();

/* ============================================================================
   ICONS —— 线性 SVG 图标集（统一 1.5 描边、跟随文字颜色，替代 emoji）
   icon('trash')            → 默认 14px
   icon('film', 18)         → 指定尺寸
   <span class="ic">${icon('coin')}</span>
   ========================================================================== */
window.ICONS = {
  film: '<rect x="1.9" y="3" width="12.2" height="10" rx="1.5"/><path d="M4.7 3v10M11.3 3v10M1.9 8h12.2"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.6" r="1.1"/><path d="M3 11.6l3.2-3 2.6 2.4 2.2-2 2 1.9"/>',
  video: '<rect x="1.9" y="3.4" width="8.7" height="9.2" rx="1.5"/><path d="M10.6 8l3.5-2.2v4.4L10.6 8z"/>',
  mic: '<rect x="6.2" y="2.3" width="3.6" height="6.6" rx="1.8"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14M5.9 14h4.2"/>',
  box: '<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z"/><path d="M2.5 5L8 8l5.5-3M8 8v6"/>',
  chart: '<path d="M2.6 13.4V2.6M2.6 13.4h10.8"/><path d="M5.6 11V7.4M8.2 11V4.8M10.8 11V8.8"/>',
  gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/>',
  moon: '<path d="M13 9.6A5.2 5.2 0 0 1 6.4 3 5.4 5.4 0 1 0 13 9.6z"/>',
  coin: '<circle cx="8" cy="8" r="5.4"/><path d="M10 6.2c-.4-.7-1.1-1-2-1-1.1 0-1.9.5-1.9 1.3 0 .9.8 1.2 1.9 1.4 1.2.2 2 .6 2 1.5s-.9 1.4-2 1.4c-1 0-1.7-.4-2.1-1.1M8 3.8v8.4"/>',
  sparkles: '<path d="M6.3 2.2l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z"/><path d="M11.8 8.6l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/>',
  upload: '<path d="M8 10.6V3.2M5.2 6L8 3.2 10.8 6M3.4 12.4h9.2"/>',
  download: '<path d="M8 2.6v7.4M5.2 7.2L8 10l2.8-2.8M3.4 12.6h9.2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.7-3.8"/><path d="M13 2.6V6h-3.4"/>',
  trash: '<path d="M2.7 4.4h10.6M6.2 4.4V2.9h3.6v1.5M4.5 4.4l.5 8.1c0 .6.5 1 1 1h4c.6 0 1-.4 1-1l.5-8.1"/><path d="M6.7 7.1v3.9M9.3 7.1v3.9"/>',
  lock: '<rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.7 7V5.4a2.3 2.3 0 0 1 4.6 0V7"/>',
  scissors: '<circle cx="4.4" cy="12" r="1.8"/><circle cx="11.6" cy="12" r="1.8"/><path d="M5.7 10.7L12 2.6M10.3 10.7L4 2.6"/>',
  list: '<path d="M5.6 4h8M5.6 8h8M5.6 12h8"/><path d="M2.8 4h.01M2.8 8h.01M2.8 12h.01"/>',
  play: '<path d="M4.8 3.4l7.6 4.6-7.6 4.6z"/>',
  pause: '<rect x="5.1" y="3.4" width="2.3" height="9.2" rx="0.7"/><rect x="8.6" y="3.4" width="2.3" height="9.2" rx="0.7"/>',
  eye: '<path d="M1.8 8S4.1 4.3 8 4.3 14.2 8 14.2 8 11.9 11.7 8 11.7 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
  eyeOff: '<path d="M3.3 5.5C2.3 6.4 1.8 8 1.8 8s2.3 3.7 6.2 3.7c.9 0 1.7-.2 2.4-.6M6.7 4.6c.4-.1.9-.2 1.3-.2 3.9 0 6.2 3.6 6.2 3.6s-.5 1-1.5 1.9"/><path d="M2.8 2.8l10.4 10.4"/>',
  key: '<circle cx="5.4" cy="10.6" r="2.6"/><path d="M7.5 8.5l4.9-4.9M10 5.9l1.6 1.6 1.7-1.7-1.6-1.6"/>',
  brain: '<path d="M8 2.6v10.8"/><path d="M5.4 3.9A2.6 2.6 0 0 0 3.9 8.4 2.6 2.6 0 0 0 5.4 13M10.6 3.9a2.6 2.6 0 0 1 1.5 4.5A2.6 2.6 0 0 1 10.6 13"/>',
  speaker: '<path d="M3 6.4h2.2L8.3 3.6v8.8L5.2 9.6H3z"/><path d="M10.6 6.1a2.8 2.8 0 0 1 0 3.8M12.2 4.5a5 5 0 0 1 0 7"/>',
  speakerOff: '<path d="M3 6.4h2.2L8.3 3.6v8.8L5.2 9.6H3z"/><path d="M11 6.5l3 3M14 6.5l-3 3"/>',
  pencil: '<path d="M11.4 2.7l1.9 1.9L6 12l-2.6.6L4 10z"/>',
  reuse: '<path d="M12.8 6.6A5.1 5.1 0 0 0 4 4.8"/><path d="M12.8 2.8v3.8H9"/><rect x="4.4" y="9" width="5.6" height="4.4" rx="1.1"/>',
  plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
  star: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z"/>',
  starFill: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z" fill="currentColor"/>',
  /* 以下 11 个是页面里已经在用、但这里原先漏掉的几何：写不出来的格子会渲染成空方块 */
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>',
  link: '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-1 1"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l1-1"/>',
  clock: '<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2V8l2 1.4"/>',
  folder: '<path d="M2.4 12.6V4.2a1 1 0 0 1 1-1h2.9l1.3 1.7h4.9a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/>',
  folderDoc: '<path d="M2.4 12.6V4.2a1 1 0 0 1 1-1h2.9l1.3 1.7h4.9a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/><path d="M6 8.6h4M6 10.6h3"/>',
  robot: '<rect x="3.2" y="5.6" width="9.6" height="7.2" rx="1.8"/><path d="M8 2.4v3.2M1.8 9.2v1.6M14.2 9.2v1.6M5.6 9.2h1.2M9.2 9.2h1.2M6.4 11.4h3.2"/>',
  layers: '<path d="M8 2.4 14 5.6 8 8.8 2 5.6z"/><path d="M2 8.6 8 11.8l6-3.2"/><path d="M2 11.4 8 14.6l6-3.2"/>',
  docTab: '<path d="M3.4 2.6h6l3.2 3.2v7.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z"/><path d="M9.4 2.6v3.2h3.2M5.4 9.4h5.2M5.4 11.6h3.4"/>',
  checkBox: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2"/><path d="M5.6 8.2 7.2 9.8l3.2-3.4"/>',
  stop: '<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.4"/>',
  wand: '<path d="M3 13 10.6 5.4"/><path d="M12 2.2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/><path d="M4.6 2.4l.3 1 1 .3-1 .3-.3 1-.3-1-1-.3 1-.3z"/>',
  users: '<circle cx="6.1" cy="5.5" r="2.4"/><path d="M2.2 13.1c0-2.2 1.8-3.7 3.9-3.7s3.9 1.5 3.9 3.7"/><path d="M10.6 3.4a2.3 2.3 0 0 1 0 4.3"/><path d="M11.7 9.8c1.6.5 2.7 1.8 2.7 3.3"/>',
  /* ---- 以下是「把 emoji 换成 SVG」那轮补的（原来各页手打 🗑 ▶ ⏮ ⬇ ✧ ⧉ 📷 ♪ ━ 这些字符）----
     方向、chevron、关闭、复制、上下箭头这些「操作类」符号以前没有几何可复用，
     写不出来的格子会渲染成空方块（比 emoji 更糟 —— 看着像图标坏了）。 */
  close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  check: '<path d="M3.4 8.4 6.4 11.4l6.2-6.6"/>',
  chevronDown: '<path d="M4.2 6.4 8 10.2l3.8-3.8"/>',
  chevronUp: '<path d="M4.2 9.6 8 5.8l3.8 3.8"/>',
  arrowLeft: '<path d="M12.8 8H3.4"/><path d="M7 3.8 3.2 8 7 12.2"/>',
  arrowUp: '<path d="M8 12.8V3.6"/><path d="M4.4 7.2 8 3.6l3.6 3.6"/>',
  arrowDown: '<path d="M8 3.2v9.2"/><path d="M11.6 8.8 8 12.4 4.4 8.8"/>',
  copy: '<rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.4"/><path d="M10.6 5.4V4a1.4 1.4 0 0 0-1.4-1.4H4a1.4 1.4 0 0 0-1.4 1.4v5.2A1.4 1.4 0 0 0 4 10.6h1.4"/>',
  camera: '<path d="M2.2 5.4h2.3l1-1.6h5l1 1.6h2.3v7.4H2.2z"/><circle cx="8" cy="9.1" r="2.4"/>',
  music: '<path d="M6.2 12.3V3.7l7.4-1.2v8.4"/><circle cx="4.4" cy="12.4" r="1.7"/><circle cx="11.8" cy="11" r="1.7"/>',
  /* 「整组加入这一集」：箭头落进一个托盘里，与 upload（出）/ download（入文件）分得开 */
  importInto: '<path d="M8 2.6v5.8M5.4 5.8 8 8.4l2.6-2.6"/><path d="M2.8 11.2v2.4h10.4v-2.4"/>',
  /* 上一段 / 下一段：左边一根竖条 + 三角形，和 play 区分得开（用户要看得出是「切段」不是「播」） */
  stepBack: '<path d="M3.4 3.6v8.8"/><path d="M12.8 4 6.4 8l6.4 4z"/>',
  stepNext: '<path d="M12.6 3.6v8.8"/><path d="M3.2 4 9.6 8l-6.4 4z"/>',
};
window.icon = function icon(name, size) {
  const b = window.ICONS[name];
  if (!b) return '';
  const s = size || 14;
  return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto">' + b + '</svg>';
};

/* HTML 静态标记里的图标：写 <span class="ic" data-icon="sparkles" data-size="17"></span>，
   由这里一次性填成 SVG。图标几何只允许有 ICONS 一份 —— 之前三台各自手抄 sparkles/trash
   的 path，改一套漏两套。 */
window.fillIcons = function fillIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = window.icon(el.getAttribute('data-icon'), +el.getAttribute('data-size') || 14);
    el.removeAttribute('data-icon');
  });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.fillIcons());
else window.fillIcons();

/* ---------------------------------------------------------------------------
   带图标的按钮有两个改法，别用 textContent：
   iconSet(btn, 'play') —— 就地换**那一颗图标**，按钮上的字一个字不动
   btnText(btn, '下载中…') —— 只改**那行字**，图标原样留着
   以前这些按钮是纯文本（'⬇ 下载成片' / '▶'），textContent 还原没问题；
   换成 SVG 之后 `btn.textContent = '⬇ 下载成片'` 会把图标一起抹掉 ——
   不报错，只是「图标忽然不见了」，按钮从此变成一个没图标的口袋按钮。
   写成 `<span class="ic">…</span><span class="tx">…</span>` 后两个入口各管一头。
   iconSet 找不到 .ic 时整个换掉（那种按钮本来就只有一颗图标，比如舞台上的 ⏸）。
   --------------------------------------------------------------------------- */
window.iconSet = function iconSet(el, name, size) {
  if (!el) return;
  const box = (el.querySelector ? el.querySelector('.ic') : null) || el;
  box.innerHTML = window.icon(name, size || 14);
};
window.btnText = function btnText(el, txt) {
  if (!el) return;
  const tx = el.querySelector ? el.querySelector('.tx') : null;
  if (tx) { tx.textContent = txt; return; }
  el.textContent = txt;
};

/* ============================================================================
   copyText —— 复制文本到剪贴板（统一入口）
   优先用 Clipboard API；被浏览器策略拒绝时回退到临时 textarea + execCommand，
   保证在 http 本地环境 / 各种内嵌浏览器里也能复制成功。
   用法：const ok = await copyText('要复制的文本')
   ========================================================================== */
window.copyText = async function copyText(txt) {
  const s = String(txt == null ? '' : txt);
  if (!s) return false;
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
};

/* ============================================================================
   uploadStageText —— 素材上传的阶段文案（AssetTransfer 的 onStage 回调 → 页面状态行）
   阶段由 assetlib.js 的 AssetTransfer 报出：
     fetch     正在取回素材（外部链接经代理 /getfile 取回；同源地址直接读）
     intent    正在向平台申请上传地址（POST uploads）
     put       拿到地址，开始上传字节
     progress  真实进度（{sent,total,pct}）—— 由本地代理按「本机 → 对象存储」那一段回传，
               不是浏览器 → 本机的回环那一段（后者通常一两秒就完了，量它没有意义）
   用法：onStage: (st, info) => { const t = uploadStageText(st, info, '参考图'); if (t) setStatus(t); }
   ========================================================================== */
(function () {
  function fmtBytes(b) {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : v) + ' ' + u[i];
  }
  window.fmtBytes = fmtBytes;      // 界面各处「≤ 10 MB」这类文案共用一份
  /* base64 → Uint8Array → Blob 的那段循环以前在 4 个地方各抄一份（导演台导出、拍短剧音色试听、
     资产库字节转存、ui.js 自己的 DataSync 还原 Blob 行）。放在 ui.js 是因为它是唯一
     每个页面都先加载的那一层 —— 放 assetlib.js 的话 ui.js 内部要用它就多一个加载顺序前提。 */
  function b64Bytes(b64) {
    const bin = atob(String(b64 || ''));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  window.b64Bytes = b64Bytes;
  window.uploadStageText = function uploadStageText(stage, info, label) {
    const who = label || '素材';
    if (stage === 'fetch') return '正在取回' + who + '…';
    if (stage === 'prepare') return '正在检查' + who + '音轨；无音轨时自动补静音，不改变画面…';
    if (stage === 'prepared') return info ? who + '已补静音音轨，准备上传…' : who + '已有音轨，保持原文件上传…';
    if (stage === 'intent') return '正在申请' + who + '上传地址…';
    if (stage === 'put') return '正在上传' + who + '…';
  if (stage === 'transfer') return '正在转存' + who + '…';
    if (stage === 'progress') {
      const i = info || {};
      const fmt = (window.Wb && window.Wb.fmtSize) ? window.Wb.fmtSize : fmtBytes;
      const sent = i.sent ? fmt(i.sent) : '';
      const total = i.total ? fmt(i.total) : '';
      const size = (sent && total) ? sent + ' / ' + total : (sent || total || '');
      /* 100% 只说明「字节发完了」：对象存储还要处理一会儿才回结果（大文件可能要等几秒），
         所以这里换成「等待确认」，别让界面看着像卡住了。 */
      if (i.pct != null && i.pct >= 100) return '正在上传' + who + '… 已发完' + (size ? ' ' + size : '') + '，等待服务器确认';
      const pct = (i.pct != null && i.pct >= 0) ? i.pct + '%' : '';
      const tail = [pct, size].filter(Boolean).join(' ');
      return '正在上传' + who + '…' + (tail ? ' ' + tail : '');
    }
    return '';
  };
})();

/* ============================================================================
   InlinePolish —— 就地润色面板（不弹窗，展开在提示词输入框下方）
     · InlinePolish.loading(host, text)          占位：显示「正在润色…」
     · InlinePolish.show(host, o)                结果面板（结果可编辑，用户决定是否替换）
         o.after      润色后的文本
         o.note       小字说明（附带了几张素材图 / 为什么没带图…）
         o.before     原文（只用于显示字数对比）
         o.applyLabel 「替换」按钮文案，默认「替换原提示词」
         o.onEdit(v)  用户改动结果文本时回调（页面可把值存进自己的状态，重渲染不丢）
         o.onApply(v) 点「替换」时回调（页面在这里写回输入框）
         o.onRetry()  点「重新润色」时回调 → Promise<{after, note}|string>
         o.onReask()  点「改回答」时回调（两段式润色才给这个按钮，见下）
         o.onClose()  点「放弃」时回调
     · InlinePolish.ask(host, o)                 问答面板（就地反问，每题 = 候选 + 最后一个自由输入框）
     · InlinePolish.live(host, o)                流式面板（边收边画；返回 { push, note, fail, text }）
     · InlinePolish.interactive(host, o)         两段式润色：先反问 → 按回答润色 → 结果面板（同一块面板内换内容）
         · o.run(answersText, ctl)：ctl 是流式接口（ctl.push(片段, 种类) + ctl.signal）——
           页面愿意流式就把 ctl.push 接到 TextAI.chatStream 的 onDelta、把 ctl.signal 传进 opts，
           不接也完全可以（面板照旧显示「正在润色…」）。
     · InlinePolish.clear(host)                  收起面板（纯 DOM 清理，不触发 onClose）
   ========================================================================== */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  window.InlinePolish = {
    clear(host) {
      if (!host) return;
      host.innerHTML = '';
      host.hidden = true;
    },
    loading(host, text) {
      if (!host) return;
      host.hidden = false;
      host.innerHTML = `<div class="pinl"><div class="pinl-load"><span class="spin-dot"></span>${esc(text || '正在润色…')}</div></div>`;
    },
    /* ---------- 流式面板：AI 一边写一边画出来（不弹窗、不换界面）----------
       「正在润色…／正在写剧本」这种干等的占位有个实打实的毛病：长文本十几秒，
       人看不到 AI 往哪个方向写，也就无从判断要不要中途停。这一版把收到的每一段就地画出来。
         o = { title, onStop() }
       返回控制器：push(片段, 'content'|'reasoning') / note(文字) / fail(文字) / text()
       · 'content' 进正文（滚动跟随最新一行），'reasoning' 进上面那行「思考」小字 ——
         那是模型的草稿，不是给人抄进提示词的正文，混在一起会毁掉结果。
       · 收尾不用调它：调用方紧接着用 show() 把同一块换成可编辑的结果面板（正文一模一样，不跳）。 */
    live(host, o) {
      o = o || {};
      const noop = { push() {}, note() {}, fail() {}, text: () => '' };
      if (!host) return noop;
      host.hidden = false;
      host.innerHTML = `<div class="pinl pinl-live">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)}<span data-tt>${esc(o.title || 'AI 正在写…')}</span></span>
          <span class="pinl-note"></span>
        </div>
        <div class="pinl-think" hidden></div>
        <pre class="pinl-out" spellcheck="false"></pre>
        <div class="pinl-ft">
          ${o.onStop ? '<button class="ghost" data-act="stop">停止（已经写出来的会留着）</button>' : '<span class="pinl-load"><span class="spin-dot"></span>正在接收…</span>'}
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const out = el.querySelector('.pinl-out');
      const think = el.querySelector('.pinl-think');
      const lenEl = el.querySelector('.pinl-len');
      let text = '', thinkTxt = '', over = false;
      return {
        push(piece, kind) {
          if (over || !piece) return;
          if (kind === 'reasoning') {
            thinkTxt += piece;
            think.hidden = false;
            think.textContent = '思考：' + thinkTxt;
            think.scrollTop = think.scrollHeight;
            return;
          }
          text += piece;
          out.textContent = text;
          /* 只在自己真的滚到底时才跟：中途往上翻看前面的内容，不该被下一帧拽回底部 */
          if (out.scrollTop + out.clientHeight >= out.scrollHeight - 24) out.scrollTop = out.scrollHeight;
          lenEl.textContent = text.trim().length + ' 字';
        },
        note(t) { el.querySelector('.pinl-note').textContent = t || ''; },
        text: () => text,
        /* 失败（含中途停止）时把已经写出来的字留在原地，只在顶上补一句原因 ——
           面板里明明有内容却整块清掉，用户看到的就是一次凭空消失的生成。 */
        fail(msg) {
          over = true;
          const sp = el.querySelector('.pinl-load');
          if (sp) sp.remove();
          el.querySelector('[data-tt]').textContent = '这次没写完';
          el.insertAdjacentHTML('afterbegin', `<div class="pinl-err">${esc(msg || '生成失败')}</div>`);
        },
      };
    },
    show(host, o) {
      if (!host) return null;
      o = o || {};
      host.hidden = false;
      host.innerHTML = `<div class="pinl">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)} AI 润色结果</span>
          <span class="pinl-note">${esc(o.note || '')}</span>
        </div>
        <textarea class="pinl-ta" spellcheck="false" placeholder="润色结果（可直接改）"></textarea>
        <div class="pinl-ft">
          <button class="pri" data-act="apply">${esc(o.applyLabel || '替换原提示词')}</button>
          ${o.onReask ? '<button class="ghost" data-act="reask">' + icon('sparkles', 13) + ' 改回答</button>' : ''}
          <button class="ghost" data-act="retry">${icon('refresh', 13)} 重新润色</button>
          <button class="ghost" data-act="close">放弃</button>
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const ta = el.querySelector('.pinl-ta');
      const lenEl = el.querySelector('.pinl-len');
      const before = String(o.before == null ? '' : o.before);
      const paintLen = () => {
        lenEl.textContent = (before ? '原文 ' + before.trim().length + ' 字 → ' : '') + '润色后 ' + ta.value.trim().length + ' 字';
      };
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 92), Math.round(window.innerHeight * 0.4)) + 'px'; };
      ta.value = o.after || '';
      paintLen(); grow();
      ta.oninput = () => { paintLen(); grow(); if (o.onEdit) o.onEdit(ta.value); };
      ta.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } };
      const applyBtn = el.querySelector('[data-act="apply"]');
      function apply() {
        const v = ta.value.trim();
        if (!v) return;
        if (o.onApply) o.onApply(v);
        window.InlinePolish.clear(host);
      }
      applyBtn.onclick = apply;
      el.querySelector('[data-act="close"]').onclick = () => { if (o.onClose) o.onClose(); window.InlinePolish.clear(host); };
      const reask = el.querySelector('[data-act="reask"]');
      if (reask) reask.onclick = () => { if (o.onReask) o.onReask(); };
      const retry = el.querySelector('[data-act="retry"]');
      retry.onclick = async () => {
        if (!o.onRetry) return;
        const keep = ta.value;
        retry.disabled = true; applyBtn.disabled = true;
        el.querySelector('.pinl-note').textContent = '正在重新润色…';
        try {
          const r = await o.onRetry();
          const next = (r && typeof r === 'object') ? r : { after: r };
          ta.value = next.after || '';
          el.querySelector('.pinl-note').textContent = next.note || '';
          paintLen(); grow();
          if (o.onEdit) o.onEdit(ta.value);
        } catch (e) {
          ta.value = keep;
          el.insertAdjacentHTML('afterbegin', `<div class="pinl-err">重新润色失败：${esc(e.message || e)}</div>`);
          el.querySelector('.pinl-note').textContent = o.note || '';
        }
        retry.disabled = false; applyBtn.disabled = false;
      };
      return el;
    },
    /* ---------- 问答面板（两段式润色的第一段，就地问，不弹窗）----------
       每题 = 若干候选（点一下选中）+ **最后一个组件是自由输入框**：
       候选永远覆盖不到的写法，就靠那个输入框兜住（用户可以两个都不选、自己写）。
         o = { title, intro, questions:[{q, options:[]}], submitLabel, skipLabel,
                onSubmit(answersText) → void|Promise, onSkip() → void|Promise }
       answersText 交给 run() 拼进第二段提示词，所以问答和润色之间不用页面自己转格式。 */
    ask(host, o) {
      if (!host) return null;
      o = o || {};
      const qs = (o.questions || []).filter(q => q && String(q.q || '').trim());
      host.hidden = false;
      host.innerHTML = `<div class="pinl pinl-qa">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)} ${esc(o.title || 'AI 想先问几个问题')}</span>
        </div>
        ${o.intro ? `<div class="pinl-note" style="display:block">${esc(o.intro)}</div>` : ''}
        <div class="pinl-qs"></div>
        <div class="pinl-ft">
          <button class="pri" data-act="go">${esc(o.submitLabel || '按这些回答继续润色')}</button>
          <button class="ghost" data-act="skip">${esc(o.skipLabel || '跳过，直接润色')}</button>
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const box = el.querySelector('.pinl-qs');
      /* state 可由调用方给（导演台每次重渲染编辑器都要把已选中的答案画回来，不能丢）；
         选/写任何一处都经 onChange 回传，调用方存进自己的状态里。 */
      const state = qs.map((q, i) => {
        const s = (o.state || [])[i] || {};
        return { pick: s.pick == null ? '' : String(s.pick), own: String(s.own || '') };
      });
      qs.forEach((q, i) => {
        const wrapEl = document.createElement('div');
        wrapEl.className = 'pinl-q';
        const opts = Array.isArray(q.options) ? q.options.filter(x => String(x || '').trim()) : [];
        wrapEl.innerHTML = `<div class="pinl-qt"></div>`
          + (opts.length ? `<div class="pinl-opts">${opts.map((t, j) => `<button class="pinl-opt" data-i="${i}" data-j="${j}"></button>`).join('')}`
            /* 「其他」永远是最后一个候选：点了就进自由输入 —— 候选覆盖不到的写法有个明确的入口，
               不必自己去找那个输入框（找不到就等于没有这个功能）。 */
            + `<button class="pinl-opt pinl-other" data-i="${i}" data-j="other" title="这些都不合适？点这里自己写"><span class="ic">${icon('pencil', 12)}</span>其他</button></div>` : '')
          /* 自由输入永远是每题的最后一块 —— 候选里没有的写法靠它 */
          + `<div class="pinl-own"><input type="text" data-i="${i}" placeholder="或者自己写…（也可以先点上面的「其他」）"></div>`;
        wrapEl.querySelector('.pinl-qt').textContent = q.q;
        const inp = wrapEl.querySelector('.pinl-own input');
        const chips = [...wrapEl.querySelectorAll('.pinl-opt')].filter(c => c.dataset.j !== 'other');
        const otherChip = wrapEl.querySelector('.pinl-other');
        opts.forEach((t, j) => { chips[j].textContent = t; chips[j].title = t; });
        const sync = () => {
          chips.forEach(c => c.classList.toggle('on', state[i].pick !== '' && state[i].pick === c.dataset.j));
          const onOther = state[i].own.trim().length > 0;
          if (otherChip) otherChip.classList.toggle('on', onOther);
          inp.classList.toggle('on', onOther);
          inp.placeholder = onOther ? '在这里写你要的答案…（会原样发给 AI）' : '或者自己写…（也可以先点上面的「其他」）';
        };
        chips.forEach(c => c.onclick = () => {
          const j = c.dataset.j;
          state[i].pick = (state[i].pick !== '' && state[i].pick === j) ? '' : j;
          if (state[i].pick) state[i].own = '';
          inp.value = state[i].own;
          sync(); count();
        });
        if (otherChip) otherChip.onclick = () => {
          state[i].pick = '';
          sync();
          inp.focus();                 // 「其他」= 就地打字，焦点直接送过去；打了字这个芯片就高亮
        };
        inp.oninput = () => { state[i].own = inp.value; if (state[i].own) state[i].pick = ''; sync(); count(); };
        inp.value = state[i].own;
        box.appendChild(wrapEl);
        sync();
      });
      const lenEl = el.querySelector('.pinl-len');
      const count = () => {
        const n = state.filter(s => s.pick !== '' || s.own.trim()).length;
        lenEl.textContent = qs.length ? '已回答 ' + n + ' / ' + qs.length + ' 题（没答的按默认理解走）' : '';
        if (o.onChange) o.onChange(state.map(s => ({ pick: s.pick, own: s.own })));
      };
      const goBtn = el.querySelector('[data-act="go"]');
      const text = () => qs.map((q, i) => {
        const s = state[i];
        const v = s.own.trim() || (s.pick !== '' ? String((q.options || [])[+s.pick] || '') : '');
        return v ? (q.q + ' → ' + v) : (q.q + ' → （未回答）');
      }).join('\n');
      goBtn.onclick = () => { goBtn.disabled = true; const t = text(); if (o.onSubmit) o.onSubmit(t); };
      el.querySelector('[data-act="skip"]').onclick = () => { if (o.onSkip) o.onSkip(); };
      el.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); goBtn.onclick(); }
      });
      count();
      return el;
    },
    /* 两段式润色：先反问要点 → 按回答润色 → 出结果面板。全程在同一块面板里换内容，不开新弹窗。
       o = { ask(): Promise<[{q,options}]>, run(answersText): Promise<{after,note}|string>,
              before, applyLabel, onEdit, onApply, onStatus(text, isErr), note }
       问不出来（模型没按格式回 / 调用失败）就跳过问答直接润色，不把用户卡在这一步。 */
    async interactive(host, o) {
      if (!host || !o) return null;
      const self = this;
      let questions = [];
      let asked = false;
      let lastState = o.state || null;
      /* 问不问问交给 AI：它读完内容自己决定（o.ask() 返回 {need, questions}）。
         程序不按字数拍板 —— 一句 30 字可能很清楚，一段 200 字也可能全是废话。
         设置里选「从不问」时 o.ask 干脆不传，直接进润色。 */
      if (o.ask) {
        asked = true;
        this.loading(host, '正在读你的描述，判断还缺什么…');
        let r = [];
        try { r = (await o.ask()) || []; } catch (e) { r = []; }
        questions = Array.isArray(r) ? r : (r.need ? (r.questions || []) : []);
      }
      const run2 = async (answers, noAskNote) => {
        self.loading(host, answers ? '正在按你的回答润色…' : '正在润色…');
        /* 流式：面板**在第一个片段到达时**才建 —— 页面不支持流式（还是一次性 chat）时
           一个字节都收不到，看到的和以前完全一样，不会先摆出一个空面板。
           signal 交给页面转发给 TextAI.chatStream，「停止」要真能把请求断掉（不是把面板藏起来）。 */
        let lv = null, ab = null;
        const push = (piece, kind) => {
          if (!lv) { ab = new AbortController(); lv = self.live(host, { title: 'AI 正在写…', onStop: () => ab.abort() }); }
          lv.push(piece, kind);
        };
        const ctl = { push, get signal() { return ab && ab.signal; } };
        let r;
        try {
          r = await o.run(answers || '', ctl);
        } catch (e) {
          const msg = e && e.message || String(e);
          if (ab && ab.signal.aborted) {
            self.clear(host);
            if (o.onStatus) o.onStatus('已经停下（这次没写完，原文没动）', false);
            return null;
          }
          if (lv) { lv.fail(msg); return null; }   // 写出来的字留着，原因补在顶上
          self.clear(host);
          if (o.onStatus) o.onStatus('润色失败：' + msg, true);
          return null;
        }
        const next = (r && typeof r === 'object') ? r : { after: r };
        const note = [o.note, next.note, answers ? '已按你的回答润色' : (noAskNote || '')].filter(Boolean).join(' · ');
        const el = self.show(host, {
          after: next.after, note, before: o.before, applyLabel: o.applyLabel,
          onEdit: o.onEdit, onApply: o.onApply,
          /* 「重新润色」用同一份回答重跑；问答在前面（「改回答」按钮），所以不会把回答问丢 */
          onRetry: async () => o.run(answers || ''),
          /* 「改回答」重画**同一批问题**（已选的答案带回去），不重新问一遍模型 ——
             再问一次模型多半会直接回润色结果，问题就丢了。 */
          onReask: questions.length ? () => renderAsk() : null,
        });
        if (o.onStatus) o.onStatus('', false);
        return el;
      };
      const renderAsk = () => self.ask(host, {
        title: o.askTitle, intro: o.askIntro, questions,
        state: lastState,
        onChange: st => { lastState = st; },
        onSubmit: t => run2(t, ''),
        onSkip: () => run2('', ''),
      });
      if (!questions.length) return run2('', asked ? '这次没能反问，直接润色' : '');
      return renderAsk();
    },
  };
})();

/* ============================================================================
   PromptReview —— AI 结果确认弹窗（多条规划结果用；单段润色走 InlinePolish 就地面板）
     · PromptReview.open({ title, sub, before, after, hint, applyLabel, retry })
         → 单段文本：左原文 / 右可编辑结果；resolve(编辑后的文本) 或 null（取消）
         · retry: async () => newText   「重新润色」按钮用
     · PromptReview.openList({ title, sub, items:[{label,text}], hint, applyLabel, retry })
         → 多段（如分镜切片）：逐条可编辑 / 可删除；resolve([{label,text}]) 或 null
   ========================================================================== */
(function () {
  function mount(title, sub) {
    const dlg = document.createElement('dialog');
    dlg.id = 'prDlg';
    dlg.innerHTML = `<div class="pr-head"><b>${window.esc(title)}</b>${sub ? `<div class="sub">${window.esc(sub)}</div>` : ''}</div>
      <div class="pr-body" id="prBody"></div>
      <div class="pr-foot"><button class="ghost" id="prRetry">${icon('refresh', 13)} 重新润色</button>
        <span class="hint" id="prHint"></span><span class="sp"></span>
        <button class="ghost" id="prCancel">取消</button>
        <button class="pri" id="prOk"></button></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
  }
  function close(dlg, out, resolve) { try { dlg.close(); } catch {} dlg.remove(); resolve(out); }

  window.PromptReview = {
    open(o) {
      return new Promise(resolve => {
        const dlg = mount(o.title || 'AI 润色结果（确认后再采用）', o.sub);
        const body = dlg.querySelector('#prBody');
        const okBtn = dlg.querySelector('#prOk');
        okBtn.textContent = o.applyLabel || '采用这段提示词';
        dlg.querySelector('#prHint').textContent = o.hint || '右侧内容可以直接编辑';
        const paint = after => {
          body.innerHTML = `<div class="pr-cols">
            <div class="pr-col"><h4>原始内容</h4><div class="ro" id="prBefore"></div></div>
            <div class="pr-col"><h4>AI 润色后（可编辑）</h4><textarea id="prAfter"></textarea></div>
          </div>`;
          body.querySelector('#prBefore').textContent = o.before || '(空)';
          body.querySelector('#prAfter').value = after;
          body.querySelector('#prAfter').focus();
        };
        paint(o.after || '');
        okBtn.onclick = () => close(dlg, (body.querySelector('#prAfter').value || '').trim() || null, resolve);
        dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
        const retry = dlg.querySelector('#prRetry');
        if (o.retry) {
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = '润色中…';
            body.innerHTML = '<div class="pr-loading"><span class="spin-dot"></span>正在重新润色…</div>';
            try { paint(await o.retry()); } catch (e) { paint(''); body.insertAdjacentHTML('afterbegin', `<div style="color:var(--err,#dc2626);font-size:12px;margin-bottom:8px">重新润色失败：${esc(e.message)}</div>`); }
            retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新润色';
          };
        } else retry.style.display = 'none';
      });
    },

    openList(o) {
      return new Promise(resolve => {
        const dlg = mount(o.title || 'AI 规划结果（确认后再生成）', o.sub);
        const body = dlg.querySelector('#prBody');
        const okBtn = dlg.querySelector('#prOk');
        okBtn.textContent = o.applyLabel || '采用并开始生成';
        dlg.querySelector('#prHint').textContent = o.hint || '可以逐条修改或删掉不想生成的画面';
        let items = (o.items || []).map(x => ({ label: x.label, text: x.text }));
        const paint = () => {
          body.innerHTML = items.length ? items.map((it, i) => `<div class="pr-row" data-i="${i}">
              <span class="tt">${esc(it.label)}</span>
              <textarea data-i="${i}">${esc(it.text || '')}</textarea>
              <button class="x iconbtn" data-del="${i}" title="删掉这一张">${window.icon('close', 11)}</button>
            </div>`).join('') : '<div class="pr-loading">没有可用的画面，请点「重新润色」或取消</div>';
          okBtn.disabled = !items.length;
          body.querySelectorAll('textarea').forEach(ta => ta.oninput = () => { items[+ta.dataset.i].text = ta.value; });
          body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { items.splice(+b.dataset.del, 1); paint(); });
        };
        paint();
        okBtn.onclick = () => close(dlg, items.filter(x => (x.text || '').trim()), resolve);
        dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
        const retry = dlg.querySelector('#prRetry');
        if (o.retry) {
          retry.innerHTML = icon('refresh', 13) + ' 重新规划';
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = '规划中…';
            body.innerHTML = '<div class="pr-loading"><span class="spin-dot"></span>正在重新规划…</div>';
            try { items = (await o.retry()).map(x => ({ label: x.label, text: x.text })); }
            catch (e) { items = []; body.insertAdjacentHTML('afterbegin', `<div style="color:var(--err,#dc2626);font-size:12px;margin-bottom:8px">重新规划失败：${esc(e.message)}</div>`); }
            retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新规划';
            paint();
          };
        } else retry.style.display = 'none';
      });
    },
  };
})();

/* ============================================================================
   Confirm —— 页内确认 / 选择弹窗（替代浏览器原生 confirm；样式与润色弹窗同一套）
   const ok = await Confirm.ask({ title, body, okLabel, cancelLabel, danger, sub });
   const v  = await Confirm.choose({ title, body, options: [{ value, label, hint }] });  // 取消返回 null
   ========================================================================== */
(function () {
  function shell(title, sub) {
    const dlg = document.createElement('dialog');
    dlg.id = 'cfDlg';
    dlg.innerHTML = `<div class="pr-head"><b>${window.esc(title)}</b>${sub ? `<div class="sub">${window.esc(sub)}</div>` : ''}</div>
      <div class="pr-body" id="cfBody"></div>
      <div class="pr-foot" id="cfFoot"></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    return { dlg, body: dlg.querySelector('#cfBody'), foot: dlg.querySelector('#cfFoot') };
  }
  const shut = (dlg, resolve, v) => { try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
  /* 就地二次确认（Confirm.arm）当前那个「确认中」的按钮。
     整页**同时只有一个**：点别的地方、或点另一个删除按钮，上一个自动还原 ——
     界面上同时挂着两个「确认？再点一下」只会让人不知道哪一个是真的。
     状态记的是**按钮 + key**，不只是那个 DOM 节点：拍片记录那一列每次进度回调都整块
     innerHTML 重画，节点换人之后武装态必须能按 key 找回来（restoreArmed）。 */
  let armed = null;
  function paintArmed(el, a) {
    el.classList.add('armed');
    /* badge 模式（opts.badge）：**一个字都不动 el 的内容**，只在角上挂一枚小标签。
       默认画法是 textContent —— 那对按钮是对的（按钮只有一行字），可拿来武装**一张脸 /
       一张缩略图**就会把图整个冲掉：武装的那 5 秒里用户看到的是一块红底空白，
       而「等的就是再点一下」必须让他看清**是哪一张**才成立。
       还原走 disarm 里的 `el.innerHTML = a.html`（快照取自挂标签之前），所以下面
       不用另外记状态；只要别忘了把 armed-badge 这个 class 也摘掉。 */
    if (a.badge) {
      el.classList.add('armed-badge');
      const b = document.createElement('i');
      b.className = 'arm-badge';
      b.textContent = a.label || '确认';
      el.appendChild(b);
    }
    else el.textContent = a.label || '确认';
    /* 默认提示**不许写死「真删了」**：arm() 是通用的就地二次确认，不只删除在用 ——
       「重新拆剧本」这种**不删任何东西**、但要花钱的动作也走它，不传 hint 就会显示
       「再点一次就真删了」，等于在告诉用户一件根本没发生的事。
       所以默认说法从 label 里取动词：删除的地方照旧读成「真删了」，
       不删的地方读成它自己那个动词，一处判据、不用每个调用方各写一句。 */
    el.setAttribute('title', a.hint || ('再点一次就「' + (a.label || '执行') + '」 · 点别处或过一会儿自动取消'));
  }
  function disarm() {
    const a = armed; if (!a) return;
    armed = null;
    clearTimeout(a.timer);
    const el = a.el;
    if (!el) return;
    el.classList.remove('armed');
    el.classList.remove('armed-badge');
    /* 按钮可能已经被整块重画换掉了（内联脚本换过 innerHTML）—— 那就没什么可还原的 */
    if (el.isConnected) {
      el.innerHTML = a.html;
      if (a.title == null) el.removeAttribute('title'); else el.setAttribute('title', a.title);
    }
  }
  window.Confirm = {
    ask(o) {
      return new Promise(resolve => {
        const { dlg, body, foot } = shell(o.title || '确认操作', o.sub);
        body.innerHTML = '<div class="cf-msg"></div>';
        body.querySelector('.cf-msg').textContent = o.body || '';
        const no = document.createElement('button');
        no.className = 'ghost'; no.textContent = o.cancelLabel || '取消';
        const yes = document.createElement('button');
        yes.className = 'pri' + (o.danger ? ' danger' : ''); yes.textContent = o.okLabel || '确定';
        foot.appendChild(Object.assign(document.createElement('span'), { className: 'sp' }));
        foot.appendChild(no); foot.appendChild(yes);
        no.onclick = () => shut(dlg, resolve, false);
        yes.onclick = () => shut(dlg, resolve, true);
        dlg.addEventListener('cancel', e => { e.preventDefault(); shut(dlg, resolve, false); });
        yes.focus();
      });
    },
    choose(o) {
      return new Promise(resolve => {
        const { dlg, body, foot } = shell(o.title || '请选择', o.sub);
        if (o.body) { body.innerHTML = '<div class="cf-msg" style="margin-bottom:12px"></div>'; body.querySelector('.cf-msg').textContent = o.body; }
        const box = document.createElement('div');
        box.className = 'cf-opts';
        (o.options || []).forEach(op => {
          const b = document.createElement('button');
          b.className = 'cf-opt';
          b.innerHTML = '<b></b><span></span>';
          b.querySelector('b').textContent = op.label || '';
          b.querySelector('span').textContent = op.hint || '';
          if (!op.hint) b.querySelector('span').remove();
          b.onclick = () => shut(dlg, resolve, op.value);
          box.appendChild(b);
        });
        body.appendChild(box);
        const no = document.createElement('button');
        no.className = 'ghost'; no.textContent = o.cancelLabel || '取消';
        foot.appendChild(Object.assign(document.createElement('span'), { className: 'sp' }));
        foot.appendChild(no);
        no.onclick = () => shut(dlg, resolve, null);
        dlg.addEventListener('cancel', e => { e.preventDefault(); shut(dlg, resolve, null); });
        const first = box.querySelector('.cf-opt');
        if (first) first.focus();
      });
    },

    /* ---------- 就地二次确认：删除这类动作不弹窗，改为按钮自己变成「确认」 ----------
       为什么不用上面那个 ask()：删一段、删一次拍摄、删一个角色是**连着点**的动作，
       每点一下弹一次模态框，页面节奏就被打断一次 —— 而且模态框一关，焦点、滚动位置、
       正在看的那一段全得重新找回来（用户往往就是删完一条接着看下一条）。
       「再点一下就真删」放在原地，代价最低，也不会把人从当前这一屏挪走。
       返回 true = 刚武装（调用方就此停下，别做那件事）；false = 这是第二次点，请往下执行。

       opts: { ms, hint, note, key }
         ms   武装多久自动还原（默认 5 秒）
         hint 武装态的 title（默认「再点一次就真删了 · 点别处自动取消」）
         key  这一次动作的**稳定身份**（例如 takeId）。给了它，整块 innerHTML 重画之后
              能靠 restoreArmed 把武装态找回来 —— 拍片记录每次进度回调都重画，
              没有这一步就是「点一下变确认、进度一来又变回 ✕、再点一下又变确认」。
         note 后果说明 —— 弹窗没了，原来写在确认框正文里的那几句话要**留在眼前**，
              用 toast（它就响在这一秒、人正在看这个按钮）。**只写与这次删除直接相关的后果**：
              「还会连带 N 条拍摄」「N 次还在平台上跑着」这种；不影响这次操作的话一句都别写。 */
    arm(el, label, opts) {
      if (!el) return true;
      opts = opts || {};
      if (armed && armed.el === el) { disarm(); return false; }   // 第二次点：先还原，再放行
      disarm();                                                    // 整页同时只有一个「确认中」
      const ms = opts.ms || 5000;
      armed = { el: el, key: opts.key || '', label: label, hint: opts.hint || '', badge: !!opts.badge,
        html: el.innerHTML, title: el.getAttribute('title'), timer: 0, deadline: Date.now() + ms };
      paintArmed(el, armed);                                        // 按钮走文字、badge 模式走角标（见上）
      armed.timer = setTimeout(disarm, ms);
      if (opts.note && window.Toast) window.Toast.err(opts.note, ms);
      return true;
    },
    /* 只读判据：调用方要自己拼 label / note 时用它（绝大多数地方直接用 arm 即可） */
    isArmed(el) { return !!(armed && armed.el === el); },
    /* 重画之后把武装态按 key 挂回新节点（**必须带 key 的 arm 才有效**）。
       传 `find(key) → 按钮`。找不到就不动 —— 那一行多半真被删了，
       让 disarm 按原来的时限自己收尾就行。 */
    restoreArmed(find) {
      if (!armed || !armed.key || !find) return;
      const el = find(armed.key);
      if (!el || el === armed.el) return;
      const a = armed;
      clearTimeout(a.timer);
      a.el = el; a.html = el.innerHTML; a.title = el.getAttribute('title');
      paintArmed(el, a);
      const left = Math.max(1200, a.deadline - Date.now());
      a.timer = setTimeout(disarm, left);
    },
    /* 还原（页面整块重画后不需要 —— 那个按钮已经不在文档里了） */
    disarm,
  };

  /* 「再点一下就真删」这句话只在原地成立：人一挪开注意力就该自动撤销，
     不能隔着一个仍然点得中的按钮等着下一次误触（点别处 / Esc 都还原）。
     监听装一次，用捕获阶段 —— 目标在**武装着的那一个**里就放过（那是第二次点击，由 arm 自己处理）。
     判别式是 `.armed` 而不是 `button.armed`：badge 模式武装的是一个 div（带脸的格子），
     写成 button.armed 的话，第二次点它自己反而会先把自己还原掉 ——
     arm 只看「armed 里是不是同一个 el」，还原完 armed 成了 null，于是又重新武装一遍，
     那个动作永远执行不到（看上去就是「点了没反应」）。 */
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', e => {
      if (!armed) return;
      const t = e.target;
      if (t && t.closest && t.closest('.armed')) return;
      disarm();
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && armed) disarm(); }, true);
  }
})();

/* ============================================================================
   UiDialog —— 自定义内容的弹窗（复用 Confirm 那一套 .pr-* 外壳，全站只有一个弹窗外壳）
   ---------------------------------------------------------------------------
   Confirm 只能「一段文字 + 确定/取消」，PromptForm 只能「若干字段 + 一个确定」。
   碰上「要放一个 <audio> 让用户试听，还要三个按钮」这类，页面就只能自己手搓 <dialog> ——
   结果每个页面各写一份 .dr-head/.dr-foot，样式慢慢走样。所以把外壳提到这里：
     const v = await UiDialog.open({
       title, sub,
       body(el) { el.innerHTML = '…'; },          // 自定义内容（音频、预览、列表…）
       actions: [{ label:'不用配乐', value:'off' }, { label:'换一段', value:'change' }, { label:'取消', value:null }],
       onOpen(el, close) { … },                    // 需要自己接管关闭时用
     });   // 返回被点按钮的 value；Esc / 取消返回 null
   ========================================================================== */
(function () {
  window.UiDialog = {
    open(o) {
      o = o || {};
      /* 开口前先清掉上一次的残留：直接调 dlg.close() 不会 remove 节点，
         留着就会撞 id（下一次 getElementById 拿到的是上一个的空壳，看着像「弹窗没换内容」）。 */
      document.querySelectorAll('dialog.ui-dlg').forEach(d => { try { d.close(); } catch (e) {} d.remove(); });
      return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.id = o.id || 'uiDlg';
        dlg.className = 'ui-dlg';
        const head = document.createElement('div');
        head.className = 'pr-head';
        const b = document.createElement('b'); b.textContent = o.title || '';
        head.appendChild(b);
        if (o.sub) { const s = document.createElement('div'); s.className = 'sub'; s.textContent = o.sub; head.appendChild(s); }
        const body = document.createElement('div'); body.className = 'pr-body';
        const foot = document.createElement('div'); foot.className = 'pr-foot';
        dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
        document.body.appendChild(dlg);
        const close = v => { try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
        if (typeof o.body === 'function') o.body(body, close); else if (o.html) body.innerHTML = o.html;
        const acts = o.actions || [{ label: '取消', value: null }];
        if (o.dangerFirst) acts.forEach(a => { if (a.danger) foot.appendChild(aBtn(a, close)); });
        acts.forEach(a => { if (!o.dangerFirst || !a.danger) foot.appendChild(aBtn(a, close)); });
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });
        dlg.showModal();
        if (typeof o.onOpen === 'function') o.onOpen(body, close);
        const first = foot.querySelector('button');
        if (first) first.focus();
      });
    },
  };
  function aBtn(a, close) {
    const b = document.createElement('button');
    b.className = (a.cls || (a.primary ? 'pri' : 'ghost')) + (a.danger ? ' danger' : '');
    b.textContent = a.label || '';
    b.onclick = async () => {
      if (typeof a.onClick === 'function') {
        /* onClick 可以是 async（先弹表单再决定关不关窗）：同步版直接判返回值，
           返回 Promise 就 await —— 以前不 await，`Promise() === false` 永远不成立，
           async onClick 想「不关窗就地刷新」根本拦不住关闭。 */
        const r = a.onClick();
        if (r === false || (r && typeof r.then === 'function' && await r === false)) return;
      }
      close(a.value === undefined ? null : a.value);
    };
    return b;
  }
})();

/* ============================================================================
   PromptForm —— 通用表单弹窗（AI 剪辑指令 / 剧本分镜 / 素材检索 共用）
   const v = await PromptForm.open({
     title, sub, okLabel,
     fields: [{ key, label, type:'textarea'|'text'|'number'|'select', value, placeholder, hint, options:[{v,t}] }],
   });   // 取消返回 null
   ========================================================================== */
(function () {
  window.PromptForm = {
    open(o) {
      return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.id = 'pfDlg';
        const fields = o.fields || [];
        dlg.innerHTML = `<div class="pf-head"><b>${esc(o.title || '输入')}</b>${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ''}</div>
          <div class="pf-body">${fields.map((f, i) => {
            const id = 'pf_' + i;
            let ctl;
            if (f.type === 'textarea') ctl = `<textarea id="${id}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
            else if (f.type === 'select') ctl = `<select id="${id}">${(f.options || []).map(x => `<option value="${esc(x.v)}"${String(x.v) === String(f.value) ? ' selected' : ''}>${esc(x.t)}</option>`).join('')}</select>`;
            else ctl = `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : String(f.value))}" placeholder="${esc(f.placeholder || '')}">`;
            return `<div class="pf-field" data-key="${esc(f.key)}"><label>${esc(f.label || '')}</label>${ctl}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
          }).join('')}</div>
          <div class="pf-foot"><span class="hint" id="pfMsg"></span><span class="sp"></span>
            <button class="ghost" id="pfCancel">取消</button><button class="pri" id="pfOk">${esc(o.okLabel || '确定')}</button></div>`;
        document.body.appendChild(dlg);
        dlg.showModal();
        /* select 字段也过公共下拉组件（原生留在 DOM 里当数据源，读取仍走 .value） */
        if (window.Dropdowns) Dropdowns.build(dlg);
        const done = out => { try { dlg.close(); } catch {} dlg.remove(); resolve(out); };
        dlg.querySelector('#pfCancel').onclick = () => done(null);
        dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
        dlg.querySelector('#pfOk').onclick = () => {
          const out = {};
          dlg.querySelectorAll('.pf-field').forEach(el => {
            const k = el.dataset.key, ctl = el.querySelector('textarea,input,select');
            out[k] = ctl.value.trim();
          });
          if (o.validate) {
            const err = o.validate(out);
            if (err) { dlg.querySelector('#pfMsg').textContent = err; return; }
          }
          done(out);
        };
        const first = dlg.querySelector('textarea,input,select');
        if (first) setTimeout(() => first.focus(), 60);
      });
    },
  };
})();

/* ============================================================================
   Net —— 统一网络层（全站唯一的 fetch 出口）
     · 默认带超时（AbortController）：不会再有「按钮永久禁用、请求还挂着」的状态
     · 网络错误 / 5xx / 429 自动重试（退避）；4xx 不重试（参数错，重试也没用）
     · 非 JSON 响应给可读错误，而不是把 HTML 错误页当数据用
     · blob() 先判 r.ok —— 下载/取素材统一走它，不再把 404 页面存成 .mp4
   用法：
     await Net.json(url, { timeout: 8000, retry: 2 })
     const b = await Net.blob(url, { timeout: 120000 })
     await Net.save(b, 'xxx.mp4')          // 触发浏览器下载（自动回收 blob URL）
   ========================================================================== */
(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const DEFAULT_TIMEOUT = 30000;
  const RETRY_DELAY = 600;
  /* 超时 / 重试次数可在「设置 → 网络与刷新」里改（存 localStorage，改完立即生效） */
  const cfg = { timeout: DEFAULT_TIMEOUT, retry: 1 };
  /* 读数字配置：没存过（null）不能当成 0 —— 那会把「重试 1 次」的默认值悄悄变成「不重试」，
     网络一抖动就不重试了，很难查。 */
  function readNum(key, def, min, max) {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  }
  function reloadConfig() {
    cfg.timeout = readNum('sk_net_timeout', DEFAULT_TIMEOUT / 1000, 5, 300) * 1000;
    cfg.retry = readNum('sk_net_retry', 1, 0, 5);
  }
  try { reloadConfig(); } catch {}
  window.addEventListener('storage', e => { if (!e.key || String(e.key).startsWith('sk_net_')) reloadConfig(); });

  function readable(e, timeout) {
    if (!e) return new Error('请求失败');
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return new Error(timeout ? `请求超时（${Math.max(1, Math.round(timeout / 1000))} 秒没有响应）` : '请求已取消');
    }
    const m = String(e.message || e);
    if (/Failed to fetch|NetworkError|ERR_|fetch failed/i.test(m)) {
      const err = new Error('连不上本地代理（proxy.js 没启动？改完 proxy.js 要重启）');
      err.__net = true;                       // 网络层失败：交给 fetch 判断代理到底活没活着（见下）
      return err;
    }
    return e instanceof Error ? e : new Error(m);
  }
  /* 代理是否活着 —— 只在「网络层失败」时探一次，用来区分两件完全不同的事：
       · 代理真没起来 / 端口不通  → 提示重启 proxy.js 是对的；
       · 代理活着，只是这次连接被掐断（代理刚重启、上游把连接 RST、系统掐了长连接）→ 让人去重启是误导。
     这个区分在提交类请求上尤其要紧：POST 被掐断时平台很可能已经受理了，
     提示成「失败」会诱导用户再点一次 → 平台上出现两条重复任务。 */
  let aliveAt = 0, aliveOk = false, aliveProbe = null;
  function proxyAlive() {
    if (Date.now() - aliveAt < 3000) return Promise.resolve(aliveOk);
    if (aliveProbe) return aliveProbe;
    /* 探测也要有超时：端口被丢弃包（而非拒绝）时 fetch 会挂很久，错误就迟迟不显示 */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    aliveProbe = fetch('/registry', { method: 'GET', cache: 'no-store', signal: ctl.signal })
      .then(r => { aliveOk = !!r && r.ok; return aliveOk; })
      .catch(() => { aliveOk = false; return false; })
      .then(v => { clearTimeout(timer); return v; })
      .then(v => { aliveAt = Date.now(); aliveProbe = null; return v; });
    return aliveProbe;
  }

  window.Net = {
    reloadConfig,        // 设置页改完超时/重试后调用
    /* 返回原始 Response（已判超时与重试；状态码交给调用方处理） */
    async fetch(url, opts = {}) {
      const method = String(opts.method || 'GET').toUpperCase();
      const timeout = opts.timeout === undefined ? cfg.timeout : opts.timeout;
      /* 重试策略：网络抖动 / 5xx / 429 才重试，且**默认只重试幂等方法**（GET/HEAD/PUT/DELETE/OPTIONS）。
         POST 只有在带幂等键时才允许重试 —— 服务端按键去重，重试不会建出第二条任务；
         没带键的 POST 一律不重试：请求已发出但响应超时的情况下，重试会重复建任务、重复扣费。
         （哪些平台支持幂等键由 registry 的 create.idempotencyKey 声明，见 proxy.js / assetlib.js） */
      const hdr = opts.headers;
      const hasIdem = !!(hdr && (typeof hdr.get === 'function'
        ? hdr.get('Idempotency-Key')
        : (hdr['Idempotency-Key'] || hdr['idempotency-key'])));
      const idempotent = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method);
      const retryCfg = opts.retry === undefined ? cfg.retry : opts.retry;
      const retry = (idempotent || hasIdem) ? retryCfg : 0;
      let lastErr = null;
      for (let attempt = 0; attempt <= retry; attempt++) {
        const ctl = new AbortController();
        const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
        const ext = opts.signal;
        /* 区分「自己超时」与「调用方主动取消」：两者都是 AbortError，
           不记下来会把用户点的取消报成「请求超时」。 */
        let cancelled = false;
        const onExt = () => { cancelled = true; ctl.abort(); };
        if (ext) { if (ext.aborted) { cancelled = true; ctl.abort(); } else ext.addEventListener('abort', onExt, { once: true }); }
        try {
          const r = await fetch(url, { ...opts, signal: ctl.signal });
          // 5xx / 429 才重试：4xx 是请求本身的问题
          if (!r.ok && (r.status >= 500 || r.status === 429) && attempt < retry) {
            lastErr = new Error('HTTP ' + r.status);
            await sleep(RETRY_DELAY * (attempt + 1));
            continue;
          }
          return r;
        } catch (e) {
          lastErr = cancelled ? new Error('请求已取消') : readable(e, timeout);
          if (attempt < retry) { await sleep(RETRY_DELAY * (attempt + 1)); continue; }
          break;      // 重试也用完了：跳出循环，交给循环外的统一收尾（在那里判断「代理是否还活着」并富化文案）
        } finally {
          if (timer) clearTimeout(timer);
          if (ext) ext.removeEventListener('abort', onExt);
        }
      }
      /* 走到这里说明重试也用完了。若是网络层失败，先探一下代理：
         活着 → 说清是「连接中断」而不是「没启动」；提交类再补一句「可能已受理」，
         免得用户把一次已经成功的提交当成失败、重复点。 */
      if (lastErr && lastErr.__net) {
        const alive = await proxyAlive();
        if (alive) {
          const writing = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
          lastErr = new Error(writing
            ? '与本地代理的连接在提交过程中中断了（代理可能刚重启，或长连接被掐断）。'
              + '「这次提交可能已经到达平台」：先刷新列表核对有没有这条任务，确认没有再用「重试」，避免重复提交／重复扣费。'
            : '与本地代理的连接中断了（代理可能刚重启，或长连接被掐断）：重试一次通常就好。');
          lastErr.maybeSubmitted = writing;
        }
      }
      throw lastErr || new Error('请求失败');
    },
    /* 取 JSON：非 2xx 抛带 status 的错误（错误文案优先用上游给的 message） */
    async json(url, opts = {}) {
      const r = await this.fetch(url, opts);
      const txt = await r.text();
      let d = null, parseErr = null;
      try { d = txt ? JSON.parse(txt) : null; } catch (e) { parseErr = e; }
      if (!r.ok) {
        const e = new Error(upstreamMsg(d) || ('HTTP ' + r.status));
        e.status = r.status;
        e.data = d;
        throw e;
      }
      if (d === null && parseErr) throw new Error('返回了非 JSON 内容（HTTP ' + r.status + '）');
      return d;
    },
    /* 取二进制：**先判 HTTP 状态**再转 blob，避免把错误页当成品存盘 */
    async blob(url, opts = {}) {
      const r = await this.fetch(url, opts);
      if (!r.ok) { const e = new Error('下载失败 HTTP ' + r.status); e.status = r.status; throw e; }
      const b = await r.blob();
      if (!b.size) throw new Error('下载到的内容是空的');
      return b;
    },
    /* 触发下载（统一回收 blob URL，避免内存泄漏） */
    save(blob, filename) {
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
    },
    errorText(e) { return (e && e.message) ? e.message : String(e || '未知错误'); },
  };
  function upstreamMsg(d) {
    if (!d) return '';
    return (d.error && (d.error.message || d.error.code)) || d.message || d.error || '';
  }
})();

/* ============================================================================
   Toast —— 全站统一的轻提示（替代「只 console.log」与「中性消息被丢弃」）
     Toast.ok('已保存') / Toast.err(e) / Toast.warn('…') / Toast.info('…')
     toast('一句话', 'ok')    ← 简写
     堆叠在内容区右上角，几秒后自动消失；同一句话短时间内不重复弹。
   ========================================================================== */
(function () {
  let box = null, last = { t: '', ts: 0 };
  function host() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.className = 'toast-box';
    document.body.appendChild(box);
    return box;
  }
  const ICON = { ok: '✓', err: '!', warn: '!', info: 'i' };
  window.Toast = {
    show(text, type, ms) {
      const msg = String(text == null ? '' : text).trim();
      if (!msg) return;
      const kind = ICON[type] ? type : 'info';
      const now = Date.now();
      if (msg === last.t && now - last.ts < 1500) return;    // 去重：同一句话不连弹
      last = { t: msg, ts: now };
      const el = document.createElement('div');
      el.className = 'toast ' + kind;
      el.innerHTML = `<span class="ic"></span><span class="tx"></span>`;
      el.querySelector('.ic').textContent = ICON[kind];
      el.querySelector('.tx').textContent = msg;
      const h = host();
      h.appendChild(el);
      while (h.children.length > 4) h.firstElementChild.remove();
      const life = ms || (kind === 'err' ? 6000 : 3200);
      const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
      el.onclick = kill;
      setTimeout(kill, life);
    },
    ok(t, ms) { this.show(t, 'ok', ms); },
    err(t, ms) { this.show(typeof t === 'object' ? Net.errorText(t) : t, 'err', ms); },
    warn(t, ms) { this.show(t, 'warn', ms); },
    info(t, ms) { this.show(t, 'info', ms); },
  };
  window.toast = (t, type, ms) => window.Toast.show(t, type, ms);
})();

/* ============================================================================
   Store —— 带上限的本地存储（各页面历史记录统一走它）
     · 唯一格式：信封 { data: 值, ts: 写入时间 }（ts 给数据文件对账比新旧用）
     · 写入失败（配额满 / 隐私模式）会**返回错误并提示**，不再静默丢数据
   用法：
     const list = Store.read('img_hist', []);
     Store.write('img_hist', list, { cap: 200, label: '图片历史' });
   ========================================================================== */
(function () {
  const ok = () => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch { return false; } };
  const isEnvelope = p => p && typeof p === 'object' && !Array.isArray(p) && Object.prototype.hasOwnProperty.call(p, 'data');
  window.Store = {
    available: ok(),
    read(key, def) {
      let raw = null;
      try { raw = localStorage.getItem(key); } catch { return def; }
      if (raw == null) return def;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { return def; }        // 坏值：当空处理，别让一条脏数据卡死整页
      if (isEnvelope(parsed)) return parsed.data;
      /* 不是信封 = 这份数据还没转换（历史上裸值也存过）。转换是一次性脚本的活（升级历史数据.cjs），
         读这里不再自动兜旧格式；只说一声，免得界面凭空少了一批记录。 */
      console.warn('[Store] ' + key + ' 不是信封格式，已按空处理；请运行一次「升级历史数据.cjs」');
      return def;
    },
    /* 返回 { ok, error }；cap 会对数组自动截断（总量控制，避免写爆配额） */
    write(key, val, opts = {}) {
      let v = val;
      if (opts.cap && Array.isArray(v) && v.length > opts.cap) v = v.slice(0, opts.cap);
      /* 序列化也要包在 try 里：数据里混进 BigInt / 循环引用时 JSON.stringify 会直接抛，
         以前它在 try 之外 —— 一次脏数据就把整个保存流程打断（页面后续逻辑全不执行）。 */
      let body;
      try {
        body = JSON.stringify({ data: v, ts: Date.now() });
      } catch (e) {
        const msg = `${opts.label || '本地记录'}保存失败：数据里有无法序列化的内容（${e.message}）`;
        if (window.Toast) window.Toast.err(msg);
        console.warn('[Store] 序列化失败 ' + key + '：', e);
        return { ok: false, error: e, serialize: true };
      }
      try {
        localStorage.setItem(key, body);
        return { ok: true, bytes: body.length };
      } catch (e) {
        const quota = /quota|exceed|full/i.test(String(e && e.name) + String(e && e.message));
        const msg = quota
          ? `${opts.label || '本地记录'}已占满浏览器存储（上限约 5MB），本次没能保存：请到「资产库」清理，或先下载到本地再清`
          : `${opts.label || '本地记录'}保存失败：${e.message}`;
        if (window.Toast) window.Toast.err(msg);
        console.warn('[Store] 写入失败 ' + key + '：', e);
        return { ok: false, error: e, quota };
      }
    },
    /* 信封里的写入时间（同步时比新旧用；老数据没有这个字段当 0） */
    tsOf(key) {
      try {
        const p = JSON.parse(localStorage.getItem(key) || 'null');
        return (p && typeof p === 'object' && !Array.isArray(p) && p.ts) ? Number(p.ts) : 0;
      } catch { return 0; }
    },
  };
})();

/* ============================================================================
   Kv —— IndexedDB 的唯一一份「开库 + 事务」实现
   ---------------------------------------------------------------------------
   以前每个用 IndexedDB 的地方各写一份：导演台一份（最完整，带缺仓库补建与版本让路）、
   设置页、资产库页、收藏与缩略图缓存各各写了一份。
   重复的代价不只是长：
     · 连接不共用 —— 导演台每 3 秒存一次工作区，自己那份连接池一路堆积；
     · 「库存在但没有仓库」的补建只有导演台那份有，别的库一旦被不带版本的
       open 凭空建成 v1 空壳，任何 transaction 都抛 "object stores was not found"；
     · 失败缓存不一致 —— 有的把失败的 Promise 缓存住，隐私模式下永远写不进去。
   所以：连接按库名缓存在这里，读写只有这一套。
   用法：页面与模块都走登记表 —— Kv.at('ws').get(key)、Kv.at('blobs').put(key, val)，
   名字见下面的 TARGETS（ws / fav / blobs / thumbs）；一次事务里混着写多条用
   Kv.at(名字).tx(mode, fn)，整表键值对（备份/恢复）用 Kv.at(名字).entries()。
   底层的 Kv.get/put/del/entries(db, store, …) 只留给登记表自己与 DataSync 遍历用，
   别在页面里抄库/表字符串。
   ========================================================================== */
(function () {
  const conns = new Map();                     // 库名 -> Promise<IDBDatabase>（一个库只有一个连接，同页多处共用）

  /* ver == null：库不存在时浏览器建 v1 并触发 onupgradeneeded（这里顺手把仓库建上） */
  function connect(name, store, ver) {
    return new Promise((res, rej) => {
      let r;
      try { r = ver == null ? indexedDB.open(name) : indexedDB.open(name, ver); }
      catch (e) { rej(e); return; }
      r.onupgradeneeded = () => { if (store && !r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error(name + ' 被其它标签页占用，关掉其它页面后刷新即可'));
      r.onsuccess = () => res(r.result);
    });
  }

  /* 打开并确认仓库在。不在就用 version+1 重开一次补建；补建后还是没有则如实抛错
     （绝不写死版本号：写死 1 会在补建之后（v2）永远打不开） */
  async function ensure(name, store) {
    let db = await connect(name, store, null);
    if (!store || db.objectStoreNames.contains(store)) return db;
    const next = db.version + 1;
    try { db.close(); } catch {}
    db = await connect(name, store, next);
    if (db.objectStoreNames.contains(store)) return db;
    try { db.close(); } catch {}
    throw new Error(name + ' 缺少 ' + store + ' 仓库，且无法补建：请关闭其它标签页后刷新');
  }

  function open(name, store) {
    const c = conns.get(name);
    if (c) return c;
    const p = ensure(name, store);
    conns.set(name, p);
    p.then(db => {
      const release = () => { if (conns.get(name) === p) conns.delete(name); };
      db.onversionchange = () => { release(); try { db.close(); } catch {} };   // 别的标签页要升级：让路
      db.onclose = release;
    }, () => { if (conns.get(name) === p) conns.delete(name); });               // 失败不缓存，下次重试（隐私模式 / 占用）
    return p;
  }

  /* fn 里同步发出的请求都算同一个事务；返回该事务最后一个请求的 result */
  function tx(name, store, mode, fn) {
    return open(name, store).then(db => new Promise((res, rej) => {
      let t, req;
      try {
        t = db.transaction(store, mode);
        req = fn(t.objectStore(store));
      } catch (e) { rej(e); return; }
      t.oncomplete = () => res(req && req.result);
      t.onerror = t.onabort = () => rej(t.error || new Error(name + ' 事务中断'));
    }));
  }

  const get = (name, store, key) => tx(name, store, 'readonly', st => st.get(key));
  const put = (name, store, key, val) => tx(name, store, 'readwrite', st => st.put(val, key));
  const del = (name, store, key) => tx(name, store, 'readwrite', st => st.delete(key));
  const all = (name, store) => tx(name, store, 'readonly', st => st.getAll());
  const clearAll = (name, store) => tx(name, store, 'readwrite', st => st.clear());
  /* 整表键值对：keys 与 values 在同一次只读事务里取，配对不会错行 */
  const entries = (name, store) => open(name, store).then(db => new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly');
    const kq = t.objectStore(store).getAllKeys();
    const vq = t.objectStore(store).getAll();
    let err = null;
    t.onerror = t.onabort = () => { err = t.error || new Error(name + ' 事务中断'); };
    t.oncomplete = () => {
      if (err) return rej(err);
      const keys = kq.result || [], vals = vq.result || [];
      res(keys.map((k, i) => [k, vals[i]]));
    };
  }));

  /* 本项目用到的库/表在这里**点名一次**：页面与模块都写 Kv.at('ws'|'fav'|…).get(k)，
     不要再各处抄 'fav_db' / 'files' 这两个字符串（抄错一个字母就是打到别的库上）。
     backup:true 的几项同时是「导出整包备份」的清单（DataSync.IDB_TARGETS 由它现算）。 */
  const TARGETS = {
    ws: { db: 'director_db', store: 'kv', label: '导演台工作区与本地视频', backup: true },
    fav: { db: 'fav_db', store: 'files', label: '收藏的本地文件', backup: true },
    blobs: { db: 'wb_blobs', store: 'blobs', label: '音色复刻的参考音频', backup: true },
    thumbs: { db: 'wb_thumbs', store: 'thumbs', label: '缩略图缓存（丢了能重建）', backup: false },
  };
  const bound = new Map();
  function at(name) {
    if (bound.has(name)) return bound.get(name);
    const t = TARGETS[name];
    if (!t) throw new Error('IndexedDB 目标没登记过：' + name);
    const o = {
      db: t.db, store: t.store,
      get: k => get(t.db, t.store, k),
      put: (k, v) => put(t.db, t.store, k, v),
      del: k => del(t.db, t.store, k),
      all: () => all(t.db, t.store),
      entries: () => entries(t.db, t.store),
      tx: (mode, fn) => tx(t.db, t.store, mode, fn),
    };
    bound.set(name, o);
    return o;
  }

  window.Kv = { open, tx, get, put, del, all, clear: clearAll, entries, TARGETS, at };
})();

/* ============================================================================
   SbBal —— 侧栏「账户余额」显示哪几个接口的余额（设置页勾选，侧栏现读）
   ---------------------------------------------------------------------------
   存的是**隐藏**名单而不是显示名单：这样新接入的平台默认就会出现在侧栏，
   不用回到设置页再勾一次。读写只有这一份实现（设置页跑在 iframe 里、侧栏在外壳里，
   两边靠 storage 事件联动，所以必须共用键名与结构）。
   ========================================================================== */
(function () {
  const KEY = 'sb_bal_show';
  const LABEL = '侧栏余额显示设置';
  window.SbBal = {
    KEY,
    off() { return (window.Store && Store.read(KEY, {}, { label: LABEL }) || {}).off || []; },
    isOff(kid) { return this.off().indexOf(kid) >= 0; },
    /* 一次写整份名单（设置页「保存全部设置」用：勾选攒起来一起落盘）
       —— 没有「单个切一下」的入口，勾选一律走这份名单，避免两条写入路径打架。 */
    setList(list) {
      const off = [...new Set((list || []).map(String).filter(Boolean))];
      Store.write(KEY, { off }, { label: LABEL });
      return off;
    },
    /* 名单里会攒下**已经不存在**的 kid：平台下架、registry 改名、keyId 改了，
       或者当初手动改过 localStorage。清掉它们，名单才不会越滚越长、也免得以后
       「同 id 复现」时莫名其妙被藏起来。只有真有陈旧项时才写盘（避免每次刷新都动 .data/）。 */
    prune(kids) {
      const keep = new Set((kids || []).map(String));
      const cur = this.off().map(String);
      const next = cur.filter(k => keep.has(k));
      if (next.length === cur.length) return 0;
      Store.write(KEY, { off: next }, { label: LABEL });
      return cur.length - next.length;
    },
    /* 按勾选过滤余额行（rows 里每条要带 kid = registry 的 keyId） */
    filter(rows) { const s = new Set(this.off()); return (rows || []).filter(r => !s.has(r.kid)); },
  };
})();

/* 「哪几个页面有列表分页设置」只这一份：设置页渲染那张表，AI 助手校验 page_mode_ / page_size_ 的页面名
   都从这里现取。以前它在 settings.html 的闭包里，助手那一侧要拦一个错键名就只能再抄一份键名表。
   新增页面时把它加进来（和 app.js 的 PAGES、sidebar.js 的 items 一起改）。 */
window.PAGE_TARGETS = {
  rows: [
    /* 三个工作台合并成 studio.html 之后只有一行：类型在页面里切，分页是整个右栏一起翻 */
    { key: 'studio', name: '生成工作台', defMode: 'more', defSize: 24 },
    { key: 'assets', name: '资产库', defMode: 'more', defSize: 24 },
    { key: 'favorites', name: '我的收藏', defMode: 'page', defSize: 24 },
    { key: 'chars', name: '素材库', defMode: 'page', defSize: 18 },
  ],
  /* 每页条数的可填区间与「显示方式」的取值：设置页的输入框与助手的校验共用这一组数 */
  size: { min: 1, max: 100 },
  modes: ['page', 'more'],
};

/* 「界面偏好（外观）有哪几项」只这一份：设置页按它渲染「外观与界面」那一栏，AI 助手按它列可改白名单，
   侧栏 / 资产库 / 收藏页读写的是同一批键。
   为什么要把这张表挪到公共层：主题以前只能点左下角那颗太阳、视图档位只能进那一页右上角换，
   设置页里根本看不见这几项 —— 于是助手也改不了（用户在设置页看得见、助手回一句「不让改这一项」，
   和 Drama.SET 那一条是同一个病）。取值写进表里而不是让页面自己猜，是因为**每一页的档位名不一样**
   （资产库 card/compact，收藏 list/compact）：在这里统一成一个词，写进去的就是那一页根本不认的值。 */
window.UI_PREFS = {
  rows: [
    { key: 'dir_theme', name: '界面主题', kind: 'seg', def: 'light',
      opts: [['light', '浅色'], ['dark', '深色']],
      hint: '左下角那颗太阳 / 月亮是同一个开关的快捷入口。' },
    { key: 'sb_open', name: '侧栏默认展开', kind: 'bool',
      hint: '勾上 = 进页面就带出「图标 + 文字」那一列；点 logo 随时能收展，两边写的是同一个键。' },
    { key: 'dir_asset_view', name: '资产库', kind: 'seg', def: 'list',
      opts: [['list', '列表'], ['compact', '紧凑']],
      hint: '只是默认摆法：进了那一页还能用右上角的图标随时换。' },
    { key: 'dir_char_view', name: '素材库', kind: 'seg', def: 'list',
      opts: [['list', '列表'], ['compact', '紧凑']],
      hint: '与资产库、收藏同一套档位名。这一项以前漏在这一张表外（页面自己能换、设置页里看不见，助手也改不了）。' },
    { key: 'dir_fav_view', name: '我的收藏', kind: 'seg', def: 'list',
      opts: [['list', '列表'], ['compact', '紧凑']],
      hint: '同上（三页的档位名现在完全一致）。' },
    { key: 'sk_media_local', name: '产物自动存本机', kind: 'seg', def: 'on',
      opts: [['on', '开'], ['off', '关']],
      hint: '生成完的图像 / 视频 / 语音当场把字节存进本机资产库，任务详情（参数、费用、耗时、状态）一并留底。'
        + '关掉就退回到只留平台外链 —— 那些地址过期后卡片会变成裂图。已存的文件不会被删，只是不再新增。' },
    { key: 'sk_media_prefer', name: '优先用本机文件', kind: 'seg', def: 'on',
      opts: [['on', '开'], ['off', '关']],
      hint: '开 = 卡片直接读本机副本（平台挂了也照样能看、用、传给别人）；'
        + '关 = 仍然直连平台地址（平台 CDN 更快，代价是地址一过期就什么都没有）。'
        + '本机文件被删了会自动回源平台，平台那边也没了会明写「已丢失」。' },
  ],
};

/* ============================================================================
   DataSync —— 与本地代理的数据文件同步（方案 A：把浏览器私有数据变成磁盘上的普通文件）
   ---------------------------------------------------------------------------
   为什么要有它：localStorage / IndexedDB 是「浏览器私有且随时可能被清掉」的 —— 清一次浏览器数据、
   换浏览器、开无痕，工作区和设置就没了。这里把业务数据同时写一份到项目目录 .data/ 下的 JSON 文件，
   于是它看得见、能备份、也能被云盘或 /cloud 同步。
     · mirror(key, body)  写完 localStorage 后顺带写一份到服务器（提前 800ms 合并突发写）
     · boot()             启动时和服务器比时间戳：谁新用谁（服务器新 → 覆盖本地并刷新一次）；
                          本地有而服务器没有（首次启用）也会补传上去
     · pushAll()/pullAll()  手动全量推/拉（设置页按钮与云同步前用）
   ========================================================================== */
(function () {
  /* 参与同步的键（前缀或全名）。刻意**不含**首屏缓存（*_cache_v1，可随时重建）与一次性的 sk_reuse */
  const SYNCABLE = [
    'sk_key_', 'sk_base_', 'sk_model_', 'sk_off_', 'sk_text_vision', 'sk_polish_', 'sk_net_', 'sk_poll_sec',
    /* 文字 AI 的供应方选择与「自己填的型号」也属于「换个地方要重弄一遍」的东西，跟着数据文件走 */
    'sk_text_prov', 'sk_text_models_',
    /* 设置页「添加自定义供应商」登记的接口（图片 / 视频 / 语音 / 文字 AI 四类都能加）：一份 JSON 数组，
       代理读它的镜像 `.data/sk_custom.json` 合并进 /registry —— 跟着数据文件走才能换机器还在。
       清单里只有「照哪一家的形状 + 地址 + 型号 id」，密钥仍按 keyId 存 `sk_key_<id>`，
       所以同步这一份不会把凭据带出去。 */
    'sk_custom',
    /* 「自动保存：按类型分别存到哪个文件夹」的配置（`sk_autosave` 是一份 JSON：
       每一类开不开、另存到哪）。**必须跟着数据文件走** —— 代理的 `POST /save`
       只认它自己读到的这份配置（请求体里带目录会被丢掉，那是安全要求），
       换个机器 / 清过浏览器缓存时不跟着走，界面上填着目录、代理却一份都没有，
       表现是「配了保存位置，一张都没存进去」而且没有任何报错。 */
    'sk_autosave',
    /* 设置页「供应商与密钥」开的是哪一类（图片 / 视频 / 语音）。和 dir_theme、视图档位同一档：
       用户调出来的界面，换台机器不该回到第一类重开一次。恢复默认不清它（见设置页 RESET_KEEP）。 */
    'sk_prov_tab',
    'ai_usage', 'sparkcine_gallery', 'audio_tasks', 'fav_items',   // 视频台不再有本地任务（卡片来自接口）
    'page_mode_', 'page_size_', 'dir_theme',
    /* 界面布局偏好：分栏比例（三个工作台 + 语音台共用 wb_split、导演台 dir_split）、
       资产库/收藏的视图档位、侧栏开合与余额勾选、导演台的候选展开与静音。
       以前只存浏览器本地 → 换台机器（或清一次浏览器数据）栏宽和视图全丢，
       而它们和 dir_theme 一样属于「用户调出来的界面」，该跟着数据文件走。
       刻意不写整个 'dir_' 前缀：dir_img / dir_video / dir_audio / dir_render 是**本机磁盘路径**，
       换台机器就不成立（和 prompt_dir 同理，见下面的注释）。 */
    'wb_split', 'dir_split', 'dir_asset_view', 'dir_char_view', 'dir_fav_view', 'dir_cand_expand', 'dir_muted', 'sb_open', 'sb_bal_show',
    /* 产物镜像的两个开关：属于「用户调出来的界面/习惯」，跟着数据文件走。
       **只同步开关，不同步 sk_local_mirror 那份索引**（见 NOT_SYNC）——
       索引里记的是本机资产号 la_xxx，另一台机器上那些文件压根不存在。 */
    'sk_media_local', 'sk_media_prefer',
    /* 拍短剧：短剧本体（剧本 / 角色 / 场景 / 每一段的每一次拍摄）与**素材库**。
       素材库要跨剧复用（同一个角色在好几部剧里出现），所以单独一个键、跟着云同步走。 */
    'dramas', 'drama_chars', 'drama_active',
    /* 拍短剧那一页的设置（dr_ 前缀：整集时长目标、两个 AI 自主权开关、做下一集的沿用范围，
       以及两个折叠面板的开合）。它们和 page_mode_ / sk_polish_ 一样属于「换台机器要重配一遍」的东西。 */
    'dr_',
    /* AI 助手的对话记录：换浏览器 / 换机器还想接着上次问，所以和数据文件走。
       只存问答正文（上限 60 条），工具查出来的东西不落盘 —— 那是随时能重查的。 */
    'ai_chat',
    /* 注意：提示词不再进 localStorage，改存归档文件夹（PromptLog → /prompts），
       归档目录 prompt_dir 也刻意不在这里 —— 换台机器路径就不一样，跟着云同步反而添乱 */
  ];
  /* 前缀匹配会把「缓存」也算进来（audio_tasks_cache_v1 会被 audio_tasks 命中），所以再排一次。
     ai_chat_* 这几条是「'ai_chat' 这一条前缀顺带命中」的，必须在这里逐条点名排除（踩过：附件身份整包同步出网）：
     · ai_chat_files —— 存的是附件的名字 / 本机资产地址 / 文本快照。换到另一台机器那些 la_xxx 根本不在，
       等于把「你往助手递过哪些文件、文件里写了什么」上传到坚果云，而它一点用都没有。
     · ai_chat_auto  —— 「执行前不用我点确认」。这是**本机**的安全开关，跟着云走会变成
       「换台机器一开机，助手就已经在自动提交任务了」。
     · ai_chat_xy    —— 悬浮球坐标，窗口尺寸各台机器不一样，同步过去只会把球摆到看不见的地方。
     · ai_chat_snap  —— 「拖到边上吸住」的开关，跟着上一条走：它是本机窗口几何的事，不是用户的偏好数据。
     · ai_chat_watch —— 「助手提交、还在等结果的任务」清单 + 球上没看的条数。任务号跟着机器走：
       同步到另一台，那边会去轮这一台提交的任务、并把提醒弹在错的人面前。
     · ai_chat_notice —— 「出结果弹系统通知」的开关。浏览器的授权状态本来就不在 localStorage 里、
       同步不过去；把开关同步过去等于在没授权的机器上许诺「会弹」，而它一定弹不出来。
     · ai_chat_off —— 「这个浏览器上干脆不装 AI 助手」。和 ai_chat_auto 同理是**本机**的选择：
       在一台机器上关掉它，不该顺手把另一台也关了。
     对话记录 ai_chat 与助手的供应方/型号选择 ai_chat_pick 照旧同步。 */
  const NOT_SYNC = ['_cache_v1', 'sk_reuse', 'sk_model_meta_', 'ai_chat_files', 'ai_chat_auto', 'ai_chat_xy', 'ai_chat_snap', 'ai_chat_watch', 'ai_chat_notice', 'ai_chat_off',
    /* sk_local_mirror —— 「哪条产物存在本机、对应哪个本机资产号」的指针表。
       本体是 .assets/ 下的文件（另一台机器上没有），而 la_xxx 这种号在那边也取不到东西：
       同步过去的结果是界面上以为有本机副本、点开全挂（比没有更坏）。 */
    'sk_local_mirror'];

  const TOL = 3000;                          // 容忍 3 秒的时钟/写入误差，避免两边来回覆盖
  const pending = new Map();                 // key → { t: 定时器, body: 待发内容（null = 删除） }
  const sanitize = k => k.replace(/[^A-Za-z0-9_-]/g, '_');
  /* 不进 localStorage 的镜像键：本体在 IndexedDB（导演台工作区），页面把快照单独递给我们。
     下面 queue 里那道「发送前再比一眼本机当前值」的闸门对它们没有意义 —— 本机根本没有这个值，
     一比就永远「不一致」，镜像静默不落地（踩过：.data/workspace.json 停在两天前，
     换机器 / 清过浏览器缓存时恢复出来的是旧工作区，签名外链的换新也白做）。 */
  const NO_LOCAL = new Set(['workspace']);

  const syncable = key => !!key
    && !NOT_SYNC.some(x => key === x || key.endsWith(x) || key.startsWith(x))
    && SYNCABLE.some(p => key === p || key.startsWith(p));

  async function putData(key, body) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, timeout: 15000, retry: 0,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }
  async function delData(key) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), { method: 'DELETE', timeout: 15000, retry: 0 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  }
  /* 读回某个数据文件的内容，**返回原始文本**。
     不能假设是 JSON：同步的键里有一半存的是普通字符串
     （dir_theme=dark、sk_polish_*=提示词文本、sk_key_*=密钥、page_mode_=page…），
     JSON.parse 会直接抛错。需要对象的地方由调用方自己 JSON.parse。 */
  async function getData(key) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), { timeout: 15000, retry: 0 });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  let mirrorBroken = false;                  // 已经提示过一次就别刷屏
  /* 突发写合并：同一个键 800ms 内只发最后一次（导演台每 500ms 就去抖保存，直接发会把代理刷爆）。
     队列里连**内容**一起记下来：body 为 null 表示「本地删了」，flush 时必须走删除接口 ——
     以前队列只记定时器、flush 时再去读 localStorage，删除任务就被丢掉了
     （服务器文件没删 → 下次 boot 把已删数据又拉回本地）。
     tries = 已经失败几次：失败**不能把任务丢掉**（以前一失败就只剩一句 Toast，
     那份修改永远停在浏览器里，代理重启/网络抖一下就算白写），
     按 800ms×3 的退避重试，最多 4 次；本地 localStorage 始终是写成功的，所以只是「晚一点落盘」。 */
  const RETRY_MAX = 4;
  /* 对账（boot）跑完之前，本地写入先进暂存表，不立刻镜像到 .data/。
     boot 的拉取是异步的：一个刚打开的页面 —— 尤其是一个全新的浏览器上下文
     （自动化验证、换机器、清过浏览器数据）—— 完全可能在读到数据文件之前就写了一次
     「它以为的内容」。那次写走的是「最后写入者赢」，会把还没读到的真实数据整个顶掉
     （收藏就是这么被清空的）。
     对账结束后统一补发：queue 本来就会比对本机当前值，
     已经被 boot 覆盖掉的过期暂存自然丢弃，真正属于本机的修改照常落盘。 */
  let booting = false;
  const held = new Map();                        // key → 待发内容（null = 删除）
  function releaseHeld() {
    const jobs = [...held.entries()];
    held.clear();
    for (const [k, body] of jobs) queue(k, body);
  }
  function queue(key, body, tries) {
    const k = sanitize(key);
    const payload = body == null ? null : String(body);
    if (booting && !tries) { held.set(k, payload); return; }
    const prev = pending.get(k);
    if (prev) clearTimeout(prev.t);
    const n = tries || 0;
    const t = setTimeout(async () => {
      pending.delete(k);
      /* 发之前再看一眼本机当前值：合并窗口里如果值被别处改写（例如 boot 刚从服务器拉回更新的一份），
         这条任务就已经过期，发出去会把旧的盖给新的。（NO_LOCAL 那些键本机没有值，不比。） */
      const cur = localStorage.getItem(k);
      const diverged = payload == null ? (cur != null && cur !== '') : cur !== payload;
      if (diverged && !NO_LOCAL.has(k)) return;
      try {
        if (payload == null) await delData(k);
        else await putData(k, payload);
      } catch (e) {
        if (n < RETRY_MAX) {
          queue(k, payload, n + 1);
        } else {
          /* 重试也用完：把任务**留在队列里**（没有定时器的死信），
             下次开页面（boot 里的 flush）或去设置页点同步时还会再试一次。
             以前这里是直接丢弃 + 一句 Toast，删除类任务一丢就永远丢了 ——
             服务器那份还在，之后每次启动都被它把已删的数据拉回浏览器。 */
          pending.set(k, { t: 0, body: payload, tries: n, failed: e.message });
          if (!mirrorBroken) {
            mirrorBroken = true;
            if (window.Toast) window.Toast.warn('本机已保存，但数据文件（.data/）没写成功：' + e.message + '（不影响使用，可稍后到「设置 → 数据与同步」重试）');
          }
        }
      }
    }, n ? Math.min(20000, 800 * Math.pow(3, n)) : 800);
    pending.set(k, { t, body: payload, tries: n });
  }
  /* 关页面 / 切到后台时把还没发出去的写送出去：
     800ms 合并窗口 + 网络往返经常来不及，「改完就关标签页」那一次修改会丢。
     keepalive 让浏览器在页面卸载后仍把请求发完（单请求上限约 64KB，超了只能尽力而为 ——
     真正的兜底是 boot() 里「本地比服务器新就补传」那段）。 */
  function flushKeepalive() {
    const jobs = [...pending.entries()];
    if (!jobs.length) return;
    for (const [key, job] of jobs) {
      clearTimeout(job.t);
      /* 和 queue 的定时器、flush 一样先看本机当前值：boot 对账期间暂存的写补发之后，
         页面经常马上被刷新一次（changed→reload），这条任务很可能已经被服务器那份覆盖，
         不做这一步就会把「拉回真实数据之前那份误写」用 keepalive 送出去，用户数据又被顶掉。 */
      const cur = localStorage.getItem(key);
      if (job.body == null ? (cur != null && cur !== '') : cur !== job.body) continue;
      const url = '/data/' + encodeURIComponent(key);
      const keep = job.body == null || job.body.length < 60000;
      try {
        fetch(url, job.body == null
          ? { method: 'DELETE', keepalive: keep }
          : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: job.body, keepalive: keep });
      } catch {}
    }
    pending.clear();
  }
  window.addEventListener('pagehide', flushKeepalive);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushKeepalive(); });
  /* 从服务器写回本地的值不要再镜像一次：钩子会把刚拉下来的内容又 PUT 回服务器，
     于是「只是拉了一份一样的数据」也把服务器文件的 mtime 顶新 ——
     另一台机器据此以为云端更新，两边的新旧关系被自己搅乱，还会白白多发 N 个请求。 */
  let selfWrite = false;
  function localSet(key, value) {
    selfWrite = true;
    try { localStorage.setItem(key, value); } finally { selfWrite = false; }
  }
  /* 统一钩子：把 localStorage 的写入/删除接到镜像上。
     为什么不在各调用点手动调 mirror：全站有几十处直接 localStorage.setItem（任务提示词记录、
     文字 AI 用量、收藏、设置项…），漏一处那份数据就不会落盘。挂钩子能一次覆盖所有现存与将来的写入。 */
  (function hookStorage() {
    try {
      const proto = window.Storage && window.Storage.prototype;
      if (!proto || proto.__scHooked) return;
      const rawSet = proto.setItem, rawDel = proto.removeItem;
      proto.setItem = function (k, v) {
        rawSet.call(this, k, v);
        try { if (this === localStorage && !selfWrite && syncable(k)) queue(k, String(v)); } catch {}
      };
      proto.removeItem = function (k) {
        rawDel.call(this, k);
        try { if (this === localStorage && syncable(k)) queue(k, null); } catch {}
      };
      proto.__scHooked = true;
    } catch (e) { console.warn('[DataSync] 存储钩子安装失败（数据仍可用，只是不自动落盘）：', e.message); }
  })();
  window.DataSync = {
    /* 本地 → 服务器（突发写合并：同一键 800ms 内只发最后一次） */
    mirror(key, body) {
      if (!syncable(key)) return;
      queue(key, body);
    },
    /* 导演台的工作区存在 IndexedDB（不是 localStorage 键），走同一条发送管道单独镜像 */
    mirrorWs(body) { queue('workspace', body); },
    /* 取服务器上的工作区；比本地新才返回（否则 null，让页面继续用本地的） */
    async workspaceFromServer(localTs) {
      try {
        const r = await window.Net.fetch('/data', { timeout: 10000, retry: 0 });
        if (!r.ok) return null;
        const f = ((await r.json()).files || []).find(x => x.key === 'workspace');
        if (!f || f.mtime <= (Number(localTs) || 0) + TOL) return null;
        const txt = await getData('workspace');
        if (!txt) return null;
        const d = JSON.parse(txt);
        return (d && d.data) ? d.data : null;
      } catch { return null; }
    },
    /* 云端拉取之后必须让 boot() 再跑一次：它按「每页每会话只跑一次」防循环，
       而「从云端下载 → 刷新页面」正是在同一会话里发生的 —— 不清这个标记，
       刚拉下来的数据不会进浏览器（页面看起来像没同步）。 */
    resetBootFlags() {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('__synced_')) sessionStorage.removeItem(k);
        }
      } catch {}
    },
    /* 立即把所有待发送的写推上去（设置页/云同步前调用） */
    async flush() {
      const jobs = [...pending.entries()];
      pending.clear();
      let n = 0;
      for (const [key, job] of jobs) {
        if (job.t) clearTimeout(job.t);
        /* 队列里的内容已经不是本机当前值了（期间用户又写过，或者 boot 刚从服务器拉回更新的一份）
           → 这条任务过期，直接丢掉：再发会把较旧的内容盖到较新的上面（云端那份还会被顶掉）。 */
        const cur = localStorage.getItem(key);
        if (job.body == null ? (cur != null && cur !== '') : cur !== job.body) continue;
        try {
          /* 待删除的键走删除接口：以前只对有值的键 put，删除任务被静默丢弃，
             服务器上的文件还在，下次 boot 会把已经删掉的数据拉回来。 */
          if (job.body == null) { await delData(key); n++; }
          else { await putData(key, job.body); n++; }
        } catch (e) {
          /* 还是没送出去：重新入队（再走一遍退避重试），不要只留一句注释「交给 pushAll」。
             pushAll 只推「本地有值」的键，删除类任务它不会补，于是那条删除永远停在内存里。 */
          queue(key, job.body);
        }
      }
      return n;
    },
    /* 本地已有的可同步键 */
    localKeys() {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (syncable(k)) out.push(k);
        }
      } catch {}
      return out;
    },
    /* 启用功能时的一次性补传：本地有、服务器没有的，全部推上去 */
    async pushAll() {
      const r = await window.Net.fetch('/data', { timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('读不到数据目录清单（HTTP ' + r.status + '）');
      const files = (await r.json()).files || [];
      let n = 0;
      for (const key of this.localKeys()) {
        const body = localStorage.getItem(key);
        if (!body) continue;
        const srv = files.find(f => f.key === sanitize(key));
        const localTs = window.Store.tsOf(key);
        if (srv && localTs <= srv.mtime + TOL) continue;        // 服务器不旧 → 不用传
        try { await putData(key, body); n++; } catch (e) { console.warn('[DataSync] 上传 ' + key + ' 失败：', e.message); }
      }
      return n;
    },
    /* 服务器 → 本地，返回被覆盖的键数 */
    async pullAll() {
      const r = await window.Net.fetch('/data', { timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('读不到数据目录清单（HTTP ' + r.status + '）');
      const files = (await r.json()).files || [];
      let n = 0;
      for (const f of files) {
        const key = f.key;
        if (!syncable(key)) continue;
        const localTs = window.Store.tsOf(key);
        if (localTs && localTs >= f.mtime - TOL) continue;      // 本地不旧 → 不覆盖
        try {
          const txt = await getData(key);
          if (txt == null) continue;
          const cur = localStorage.getItem(key);
          if (cur === txt) continue;                       // 内容一样 → 不用写
          localSet(key, txt);
          n++;
        } catch (e) { console.warn('[DataSync] 拉取 ' + key + ' 失败：', e.message); }
      }
      return n;
    },
    /* 启动时自动对账：服务器有更新就覆盖本地并刷新一次（每页每次会话只刷一次，避免循环） */
    async boot() {
      if (!window.Store.available) return;
      const page = (location.pathname.split('/').pop() || 'index.html');
      const flag = '__synced_' + page;
      try {
        if (sessionStorage.getItem(flag)) return;              // 本次会话已经同步过
        booting = true;                                        // 对账期间本地写入先暂存（见 queue 里的说明）
        const r = await window.Net.fetch('/data', { timeout: 8000, retry: 0 });
        if (!r.ok) return;
        const files = (await r.json()).files || [];
        const byKey = new Map(files.map(f => [f.key, f]));
        const localKeys = this.localKeys();
        if (!files.length && !localKeys.length) return;        // 全新环境，没什么可同步
        let changed = 0, seeded = 0, repaired = 0;
        const byteLen = s => { try { return new TextEncoder().encode(s).length; } catch { return s.length; } };
        /* 遍历「本地 ∪ 数据文件」而不是只遍历本地：
           只遍历本地的话，清掉浏览器数据后（localStorage 为空）反而什么都不会恢复 ——
           而「清缓存后自动恢复」正是这个功能的目的。 */
        for (const key of new Set([...localKeys, ...byKey.keys()])) {
          if (!syncable(key)) continue;                        // 数据文件里还有 workspace 这类非 localStorage 键
          const srv = byKey.get(sanitize(key));
          byKey.delete(sanitize(key));                         // 处理过就出队（下面只按本轮的键判断，不重复处理）
          const localRaw = localStorage.getItem(key);           // 注意：空字符串也算「本地没有」（老数据可能是空值）
          if (!localRaw) {
            /* 本地没有、数据文件里有 → 「浏览器数据被清过 / 换了台机器」：拉回来。
               以前这个情况在下面会命中两处分支：多发一次请求、changed 计数翻倍。 */
            if (!srv) continue;
            try {
              const remoteRaw = await getData(key);
              if (remoteRaw != null && remoteRaw !== '') { localSet(key, remoteRaw); changed++; }
            } catch (e) { console.warn('[DataSync] 恢复 ' + key + ' 失败：', e.message); }
            continue;
          }
          if (!srv) {                                          // 数据文件里没有 → 先把本机已有数据补传上去
            try { await putData(key, localRaw); seeded++; } catch (e) {}
            continue;
          }
          /* 两边都有：先比体积（便宜的启发式），体积相同**不能直接跳过** ——
             等长修改（grid→list、换一个等长的密钥 / 模型名）体积一模一样，
             只看体积的话另一台机器的更新永远拉不回来，两边状态静默分叉。
             体积相同但服务器文件更新时，照样取回来逐字节比对。 */
          const localTs = window.Store.tsOf(key);
          const sameSize = Math.abs(srv.size - byteLen(localRaw)) <= 1;
          /* 本地明确比数据文件新 → 这是**上次没发出去的写**（代理当时没启动 / 关页面时来不及 /
             重试也用完了）。以前这里只是「保留本地的」然后什么都不做，于是 .data/ 永远停在旧内容，
             云同步、换机器、备份拿到的都是那份旧的 —— 现在顺手补传一次。
             （只有带 ts 的信封格式能判出来；纯字符串的值 ts=0，不参与这条，交给写钩子。） */
          if (localTs && localTs > srv.mtime + TOL) {
            try { await putData(key, localRaw); repaired++; } catch (e) {}
            continue;
          }
          if (sameSize && srv.mtime <= localTs + TOL) continue;         // 体积相同且服务器不新 → 不用管
          if (localTs && srv.mtime <= localTs + TOL) continue;          // 本地不旧 → 保留本地的
          let remoteRaw = null;
          try { remoteRaw = await getData(key); } catch (e) { console.warn('[DataSync] 拉取 ' + key + ' 失败：', e.message); continue; }
          if (remoteRaw == null || remoteRaw === localRaw) continue;    // 内容一样 → 不动，也不刷新
          try { localSet(key, remoteRaw); changed++; } catch {}
        }
        /* 上面那些「上次没送出去」的任务（代理当时没启动 / 重试次数用完）在这里补一次。
           flush 会自己判过期，不会把旧内容盖到新内容上。 */
        if (pending.size) { try { await this.flush(); } catch (e) {} }
        sessionStorage.setItem(flag, '1');
        if (changed) {
          if (window.Toast) window.Toast.info('已从本机数据文件同步 ' + changed + ' 项，正在刷新…');
          setTimeout(() => location.reload(), 600);
        } else if (repaired) {
          console.log('[DataSync] 补传 ' + repaired + ' 项没落盘的本地修改到 .data/');
        } else if (seeded) {
          console.log('[DataSync] 首次启用：已把 ' + seeded + ' 项本机数据写入 .data/');
        }
      } catch (e) { console.warn('[DataSync] 启动同步跳过：', e.message); }
      finally { booting = false; releaseHeld(); }               // 不管对账成不成功，暂存的本地写入都要补发
    },
    /* ---------- 浏览器持久化存储（方案 B）----------
       让浏览器不因磁盘紧张自动回收 IndexedDB/localStorage（不防用户手动清理）。
       返回 { supported, granted }；设置页会显示状态。 */
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return { supported: false, granted: false };
      try {
        if (navigator.storage.persisted && await navigator.storage.persisted()) return { supported: true, granted: true };
        const granted = await navigator.storage.persist();
        return { supported: true, granted };
      } catch { return { supported: true, granted: false }; }
    },
    async persistState() {
      if (!navigator.storage || !navigator.storage.persisted) return { supported: false };
      try {
        const granted = await navigator.storage.persisted();
        let usage = null;
        if (navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          usage = { usedMB: +(e.usage / 1048576).toFixed(1), quotaMB: Math.round(e.quota / 1048576) };
        }
        return { supported: true, granted, usage };
      } catch { return { supported: true, granted: false }; }
    },

    /* ---------- 整包备份 / 恢复（方案 C）----------
       把「浏览器里的全部数据」打成一个 JSON：
         · localStorage 里参与同步的业务键（含密钥，导出时会明确提示）
         · IndexedDB：导演台工作区、本地导入的视频、收藏的本地文件、音色复刻的参考音频
       本地文件（Blob）按需打包：只导出数据时跳过，打包文件时转成 base64。
       要带哪几个库来自 Kv 的登记表（backup:true 的那些），这里不再抄一遍库/表名。 */
    get IDB_TARGETS() {
      return Object.entries(window.Kv.TARGETS)
        .filter(([, t]) => t.backup)
        .map(([key, t]) => ({ key, db: t.db, store: t.store, label: t.label }));
    },
    async _idbDump(dbName, storeName, withBlobs) {
      /* 走 Kv（连接按库名复用、缺仓库会补建）。以前这里自己 open(dbName, 1)：
         导演台把库补建到 v2 之后，写死版本 1 会抛 VersionError → 整份库在备份里静默消失。 */
      const rows = await Kv.entries(dbName, storeName).catch(() => []);
      const enc = [];
      for (const [k, v] of rows) {
        if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number') {
          if (!withBlobs) continue;                                  // 跳过大文件
          try {
            const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(v); });
            enc.push([k, { __blob: true, type: v.type || '', b64 }]);
          } catch (e) { console.warn('[DataSync] 打包文件失败 ' + k + '：', e.message); }
        } else enc.push([k, v]);
      }
      return enc;
    },
    async _idbRestore(dbName, storeName, rows) {
      if (!await Kv.open(dbName, storeName).catch(() => null)) return 0;
      if (!rows || !rows.length) return 0;
      let n = 0;
      for (const [k, v] of rows) {
        let val = v;
        if (v && v.__blob) {
          try {
            val = new Blob([window.b64Bytes(v.b64)], { type: v.type || 'application/octet-stream' });
          } catch { continue; }
        }
        try {
          await Kv.put(dbName, storeName, k, val);
          n++;
        } catch (e) { console.warn('[DataSync] 写入 ' + k + ' 失败：', e.message); }
      }
      return n;
    },
    /* 导出整包。includeBlobs=false 时只带数据（体积小、够恢复设置与工作区）。
       includePrompts=true 时连提示词归档一起带 —— 归档是磁盘上的一堆 .md，
       既不在 .data/ 也进不了 localStorage/IndexedDB，不显式带就永远带不走。 */
    async exportAll(includeBlobs, includePrompts) {
      const ls = {};
      for (const k of this.localKeys()) {
        const v = localStorage.getItem(k);
        if (v != null) ls[k] = v;
      }
      const idb = {};
      for (const t of this.IDB_TARGETS) {
        const rows = await this._idbDump(t.db, t.store, includeBlobs);
        if (rows.length) idb[t.db + '/' + t.store] = rows;
      }
      const pack = {
        type: 'ai-workbench-backup', version: 1,
        ts: new Date().toISOString(), includeBlobs: !!includeBlobs,
        localStorage: ls, indexedDB: idb,
      };
      if (includePrompts && window.PromptLog) {
        try {
          const r = await PromptLog.exportAll();
          pack.prompts = { dir: r.dir, total: r.total, skipped: r.skipped || 0, files: r.files || [] };
        } catch (e) {
          /* 归档带不上要说出来，不能悄悄导出一个「少了提示词」的备份还报成功 ——
             那正是用户最需要它的时候。塞进 note，导出后显示。 */
          pack.promptsError = e.message;
        }
      }
      return pack;
    },
    /* 导入整包：localStorage 全量写回，IndexedDB 逐条写回。返回计数。 */
    async importAll(pack) {
      if (!pack || pack.type !== 'ai-workbench-backup') throw new Error('不是本工具导出的备份文件');
      let nLs = 0, nIdb = 0;
      for (const [k, v] of Object.entries(pack.localStorage || {})) {
        try { localStorage.setItem(k, v); nLs++; } catch (e) { console.warn('[DataSync] 恢复 ' + k + ' 失败：', e.message); }
      }
      for (const [path, rows] of Object.entries(pack.indexedDB || {})) {
        const [dbName, storeName] = path.split('/');
        nIdb += await this._idbRestore(dbName, storeName, rows);
      }
      /* 归档恢复走代理写盘（浏览器写不了那个目录）。**一份也不覆盖**同名文件，
         代理那边会返回「本机已有同名」的数量 —— 报出来，让人知道少了几份。 */
      let nPrompt = 0, promptNote = '';
      if (pack.prompts && Array.isArray(pack.prompts.files) && pack.prompts.files.length && window.PromptLog) {
        try {
          const r = await PromptLog.importAll(pack.prompts.files);
          nPrompt = r.restored || 0;
          promptNote = r.message || ('恢复归档 ' + nPrompt + ' 份');
        } catch (e) { promptNote = '归档没恢复成：' + e.message; }
      }
      return { localStorage: nLs, indexedDB: nIdb, prompts: nPrompt, promptNote };
    },
  };
  /* 页面加载后自动对账一次；并顺手申请持久化存储（不需要用户手势）。
     旧键清理**排在 boot 之后**：boot 会拿 `.data/` 里的文件去补 localStorage（清过浏览器数据后靠它恢复），
     先清本地再对账的话，那几份死文件会被「恢复」回来 —— 顺序反了就等于没清。 */
  const afterBoot = () => { window.DataSync.boot().then(sweepLegacyKeys, sweepLegacyKeys); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterBoot);
  else afterBoot();
  setTimeout(() => { try { window.DataSync.persist(); } catch {} }, 1500);
})();

/* ============================================================================
   旧键清理 —— 一次性，删掉「功能已经改了、键却还留着」的那批
   ---------------------------------------------------------------------------
   这些键**现在没有任何一处代码在读**了。留着不只是占地方：① 每次同步都要带着它们跑一趟；
   ② 整包备份 / 云同步会把它们一起带走，换台机器又是一份死数据；③ 让人以为
   「这些设置还在管用」，去改一个改了也没人看的地方。
   每一项为什么作废都写在后面 —— 以后再删掉一个功能，照着加一行，别让它再攒起来：
     · page_mode_image / page_mode_video / page_mode_audio 与 page_size_ 同名三项 ——
       2026-10 三个工作台合并进 studio.html，分页只剩 page_mode_studio / page_size_studio
       （一张表在 window.PAGE_TARGETS，studio.html 那句注释写的就是「不再沿用其中任何一份」）。
     · sk_text_provider —— 2026-10 独立的「文字 AI 模型与识图」那张卡删了，
       供应方 / 型号 / 识图并进了「文字」那一档的每一家卡里。
     · video_tasks —— 视频台的卡片改成从接口取，本机不再留任务副本。
       **audio_tasks 还在用**（workbench.js 的历史仓），别顺手一起删。
   两处都要清：localStorage 里的本体，和 `.data/` 里那份镜像。
   镜像走 `DELETE /data/<键>?nobak=1`（代理删东西默认留一份 .bak，这条路**特意绕开**）：
   这几个键是「已经宣告作废」的，为它们留后悔药只会让设置页的「备份清单」里永远挂着
   几行用户认不出、也永远不会去恢复的键名。
   本机一个都没有就什么都不做 —— 不为了「可能有」去打扰代理。
   ========================================================================== */
const LEGACY_KEYS = [
  'page_mode_image', 'page_size_image', 'page_mode_video', 'page_size_video',
  'page_mode_audio', 'page_size_audio', 'sk_text_provider', 'video_tasks',
];
async function sweepLegacyKeys() {
  if (!window.Store || !Store.available) return;
  const hit = LEGACY_KEYS.filter(k => { try { return localStorage.getItem(k) != null; } catch { return false; } });
  if (!hit.length) return;
  for (const k of hit) { try { localStorage.removeItem(k); } catch (e) {} }
  /* 镜像那份也删：留着的话下次 boot 会把它当「服务器上有更新的数据」恢复回 localStorage。 */
  for (const k of hit) {
    try { await Net.fetch('/data/' + encodeURIComponent(k) + '?nobak=1', { method: 'DELETE', timeout: 8000, retry: 0 }); } catch (e) {}
  }
  console.info('[Store] 清掉了几个不再使用的旧键：' + hit.join('、'));
}

/* ============================================================================
   DatePicker —— 自定义日期选择弹层（替换浏览器原生日历，与全站样式统一）
   用法：DatePicker.open(holderEl, inputEl, { onPick })   holder 需 position:relative
   ========================================================================== */
(function () {
  let openPop = null;
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

  function close() {
    if (!openPop) return;
    openPop.pop.remove();
    openPop = null;
  }
  document.addEventListener('click', e => {
    if (openPop && !e.target.closest('.dp-pop') && !e.target.closest('.datepick')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function paint() {
    const { pop, input, opts, view } = openPop;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cur = input.value ? new Date(input.value + 'T00:00:00') : null;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const startIdx = (first.getDay() + 6) % 7;            // 周一为第一列
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const prevDays = new Date(view.getFullYear(), view.getMonth(), 0).getDate();
    const cells = [];
    for (let i = startIdx - 1; i >= 0; i--) cells.push({ d: new Date(view.getFullYear(), view.getMonth() - 1, prevDays - i), out: true });
    for (let i = 1; i <= daysInMonth; i++) cells.push({ d: new Date(view.getFullYear(), view.getMonth(), i), out: false });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const last = cells[cells.length - 1].d;
      cells.push({ d: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), out: true });
      if (cells.length >= 42) break;
    }
    pop.innerHTML = `<div class="dp-head">
        <button class="dp-nav" data-nav="-1" title="上个月">‹</button>
        <b>${view.getFullYear()} 年 ${view.getMonth() + 1} 月</b>
        <button class="dp-nav" data-nav="1" title="下个月">›</button>
      </div>
      <div class="dp-week">${WEEK.map(w => `<span>${w}</span>`).join('')}</div>
      <div class="dp-grid">${cells.map(c => {
        const t = c.d.getTime();
        const cls = ['dp-day'];
        if (c.out) cls.push('out');
        if (t === today.getTime()) cls.push('today');
        if (cur && iso(c.d) === iso(cur)) cls.push('sel');
        return `<button class="${cls.join(' ')}" data-d="${iso(c.d)}">${c.d.getDate()}</button>`;
      }).join('')}</div>
      <div class="dp-foot">
        <button class="ghost mini" data-act="today">今天</button>
        <button class="ghost mini" data-act="clear">清除</button>
        <span style="flex:1"></span>
        <button class="ghost mini" data-act="close">关闭</button>
      </div>`;
    pop.querySelectorAll('[data-nav]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      view.setMonth(view.getMonth() + Number(b.dataset.nav));
      paint();
    });
    pop.querySelectorAll('[data-d]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      input.value = b.dataset.d;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick(b.dataset.d);
      close();
    });
    pop.querySelector('[data-act="today"]').onclick = e => {
      e.stopPropagation();
      input.value = iso(new Date());
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick(input.value);
      close();
    };
    pop.querySelector('[data-act="clear"]').onclick = e => {
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick('');
      close();
    };
    pop.querySelector('[data-act="close"]').onclick = e => { e.stopPropagation(); close(); };
  }

  window.DatePicker = {
    open(holder, input, opts) {
      if (openPop && openPop.input === input) { close(); return; }
      close();
      const pop = document.createElement('div');
      pop.className = 'dp-pop';
      holder.appendChild(pop);
      const base = input.value ? new Date(input.value + 'T00:00:00') : new Date();
      openPop = { pop, input, opts: opts || {}, view: new Date(base.getFullYear(), base.getMonth(), 1) };
      paint();
    },
    close,
  };
})();
