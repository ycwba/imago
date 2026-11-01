/* ============================================================================
   ui.js —— 公共面：下拉 / 芯片 / 多选 / 格式 / 视图档 / 界面偏好 / 侧栏余额
   弹窗与表单族（InlinePolish / PromptReview / Confirm / UiDialog / PromptForm / DatePicker）
   在 forms.js，加载顺序 ui.js → forms.js，调用点不变。
   ----------------------------------------------------------------------------
   其中 Dropdowns 是自定义下拉组件（与图片工作台完全同一套）
   用法：
     1) 页面 <script src="ui.js"></script>
     2) 静态下拉：DOM 就绪后 Dropdowns.build(document)；
        动态重建的下拉：重建 HTML 之后再 Dropdowns.build(容器)
     3) 页面代码改完 <select> 的 <option> 后调用 Dropdowns.sync(sel)
        （`sel._ddRebuild` 是组件内部的事，页面不碰： 只认 Dropdowns 这一个面）
   说明：原生 <select> 仍作为唯一数据源（保留 value / change 事件 / 表单行为），
        只是被隐藏，改用 .dd 组件渲染，观感与图片工作台一致。
   ========================================================================== */
(function () {
  /* 下拉浮层**挂到容器外面用 fixed 定位**（挂在哪一个容器见下面的 `hostFor`），不留在 <select> 原来的位置上。
     以前是原地展开（.dd-list 是 .dd 的子节点），于是任何祖先的 overflow 都会把它裁掉：
     工作台的高级设置面板 .adv 是 overflow:hidden、左右两栏是 overflow-y:auto、外层
     .layout 还是 overflow:hidden —— 一个下拉要穿过三层裁剪，表现就是「点开了但只露出一条边」。
     逐个容器去改 overflow 等于把同一个毛病抄 N 份（而且 `overflow:visible` 常常会让布局更难看），
     浮层脱离文档流之后裁剪与层叠都不再受祖先影响。 */
  const DD_LIST_MAXH = 264;      // 与 .dd-list 的 max-height 一致（这里还要用来算「往哪边开」）
  const DD_GAP = 6;              // 浮层与按钮的间距
  const DD_EDGE = 10;            // 离视口边缘留一点，贴着边会被裁

  /* 已挂出去的浮层（收起时留着节点，只是不显示 —— 省得每次展开重画一遍） */
  const portals = [];
  let openDd = null;

  /* 浮层挂在**哪一个**容器里：默认 body，但 select 在 `<dialog>` 里时必须挂进那一个 dialog。
     `showModal()` 的弹窗在 top layer 上，那一层盖过任何 z-index —— 浮层挂 body 就被整块压在弹窗底下，
     看不见也点不着，表现是「下拉里只有当前这一项、换不了」，而界面上一处报错都没有
     （新建素材那个「类型」下拉就是这么只剩「角色」的：三个选项一直在，列表开在弹窗背面）。
     挂进 dialog 自己里面就跟着进 top layer；fixed 定位仍按视口摆（dialog 没有 transform，不成为固定元素的包含块）。 */
  function hostFor(dd) {
    const dlg = dd.closest && dd.closest('dialog');
    return dlg && dlg.isConnected ? dlg : document.body;
  }

  /* 把已经不连在文档里的浮层回收掉。为什么排在 `build` 的最前面：页面每次重画一块区域都会再调一次
     build，那正是「上一批 .dd 刚被 innerHTML 换掉」的时刻 —— 那些浮层节点还在 host 上挂着
     （每个都带着自己的一份选项副本），不收就是每重画一次攒一串。
     弹窗里的那一类更明显：`.dd` 跟着 dialog 一起 remove 了，`portals` 数组里那条引用却留着，
     开一次收一次就攒一条，永远不清。 */
  function sweepPortals() {
    for (let i = portals.length - 1; i >= 0; i--) {
      const dd = portals[i];
      if (dd.isConnected) continue;
      if (dd._ddList && dd._ddList.isConnected) dd._ddList.remove();
      portals.splice(i, 1);
      if (openDd === dd) openDd = null;
    }
  }

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
      /* 必须显式写 `auto`，不能只 `= ''`：清空的是**内联**的 top，而 `ui.css` 的 `.dd-list` 自己带着 `top: 0`。
         固定定位 + 高度确定（内容撑到 max-height 就是确定的）时，`top` 与 `bottom` 同时有值属于「过约束」，
         按 CSS 2.1 规矩**丢弃 bottom** —— 于是往上开的面板整块钉在视口顶上，离按钮差几百 px。
         这就是「时段那一栏点开，选项跑到屏幕最上面」的根因：时段行在表单底部，下方不够才走这一支。
         往下开那支看不出问题，只是因为内联的 top 正好把样式表的 0 盖掉了。 */
      list.style.top = 'auto'; list.style.bottom = Math.round(vh - r.top + DD_GAP) + 'px';
    } else {
      list.classList.remove('up');
      list.style.top = Math.round(r.bottom + DD_GAP) + 'px'; list.style.bottom = 'auto';
    }
    /* 横向也别顶出视口 */
    const lw = list.offsetWidth || r.width;
    const left = Math.max(DD_EDGE, Math.min(r.left, window.innerWidth - lw - DD_EDGE));
    list.style.left = Math.round(left) + 'px';
  }

  function openDd_(dd) {
    if (openDd && openDd !== dd) closeDd(openDd);
    if (!dd._ddList.isConnected) hostFor(dd).appendChild(dd._ddList);
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
    btn.append(lbl, fromHTML('<span class="arw">' + window.icon('chevronDown', 14) + '</span>'));
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
    dd.append(btn);            // 浮层不进 .dd：它挂到 hostFor 选出的容器上（弹窗里就进那一个 dialog）
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
        const ti = o.title ? ' title="' + window.esc(o.title(v)) + '"' : '';
        return '<button class="chip' + (o.cls ? ' ' + o.cls : '') + (on(v) ? ' on' : '') + '" data-v="' + window.esc(v) + '"' + ti + '>'
          + window.esc(label) + (n ? ' ' + n : '') + '</button>';
      }).join('');
      box.querySelectorAll('.chip').forEach(b => { b.onclick = () => onPick(b.dataset.v); });
    },
  };

  /* ---------- AI 芯片：那一颗写着「AI 挑了哪几条 / 按什么筛」并带 ✕ 的东西 ----------
     原先四处各拼一份 innerHTML（资产库 / 素材库 / 收藏 / 统一选择器），文案与尺寸各漂各的：
     清除按钮的 title 分「回到完整名单」与「回到完整列表」两句话，✕ 的图标一颗 10 另一颗 11。
     各页真正不同的只有**芯片上写几段话**（那是它自己的数据）与**清掉之后各自重画什么**，
     所以公共层只收两件事：拼一颗带 ✕ 的芯片、把 ✕ 绑回调用方给的函数。 */
  const AiChip = {
    CLEAR_TITLE: '清除 AI 结果，回到完整列表',
    /* 若干段话用「 · 」连起来；空串 / null / undefined 丢掉，不留下悬空的分隔符。 */
    text(bits) { return (bits || []).filter(Boolean).join(' · '); },
    /* 「AI 挑的 N 条（+ 它说的那句话）」—— 素材库与收藏这两页以前逐字抄过同一段。 */
    picked(n, why) { return AiChip.text(['AI 挑的 ' + (Number(n) || 0) + ' 条', why]); },
    /* 页面那一层「把这一屏的 AI 结果画成一颗芯片」也只有这一份：
       o: { on, picked, why, text, desc, summary, asc, scope[], tip, cls, iconSize, clearId, clearTitle, onClear }
       给了 text 就用它；否则按 picked / why / desc / summary / asc / scope 拼。
       on === false 或最终文本为空 → 收掉（与 paint 的空串一致）。 */
    show(el, o) {
      const oo = o || {};
      const text = oo.text != null ? String(oo.text)
        : (oo.on === false ? '' : AiChip.text([oo.picked != null ? AiChip.picked(oo.picked, oo.why) : oo.why,
          oo.desc, oo.summary, oo.asc].concat(oo.scope || [])));
      AiChip.paint(el, { text, clearId: oo.clearId, clearTitle: oo.clearTitle, cls: oo.cls,
        iconSize: oo.iconSize, tip: oo.tip, onClear: oo.onClear });
      return text;
    },
    /* o: { text 空串=整颗收掉, clearTitle, clearId(默认 aiClear), cls(默认 ai-chip), tip, onClear }
       text / tip / clearTitle 都传**纯文本**，转义只在这一处做。 */
    paint(el, o) {
      const box = typeof el === 'string' ? document.getElementById(el) : el;
      if (!box) return;
      const oo = o || {};
      const t = String(oo.text || '');
      if (!t) { box.innerHTML = ''; return; }
      const cid = oo.clearId || 'aiClear';
      box.innerHTML = '<span class="' + (oo.cls || 'ai-chip') + '"'
        + (oo.tip ? ' title="' + window.esc(oo.tip) + '"' : '') + '>'
        + window.icon('sparkles', oo.iconSize || 12) + ' ' + window.esc(t)
        + '<button id="' + window.esc(cid) + '" title="' + window.esc(oo.clearTitle || AiChip.CLEAR_TITLE) + '>'
        + window.icon('close', 10) + '</button></span>';
      const c = document.getElementById(cid);
      if (c) c.onclick = oo.onClear;
    },
  };
  window.AiChip = AiChip;

  window.Dropdowns = {
    build(root) {
      sweepPortals();
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
    /* 没有对外的 `sweep()`：回收浮层是 `build` 自己开头做的一件事（见 `sweepPortals`）。
       以前它是一个导出的方法而**全站零调用** —— 于是「重画一块区域就攒一串孤立 .dd-list」
       这件事从来没被解决过，只是没人看见。接在唯一那个自然的时机上，比留一颗等人记得按的按钮可靠。 */
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
  /* 页面池切走这一页时，浮层挂在 body 上、不属于任何会被藏起来的容器 ——
     不主动收掉就会飘在下一页上（旧架构里整份文档销毁，没有这一态）。 */
  window.addEventListener('spa:page', e => {
    if (openDd && e && e.detail && e.detail.visible === false) closeDd(openDd);
  });
  window.Dropdowns.closeAll = () => { if (openDd) closeDd(openDd); };

  /* DOM 就绪时自动包一遍全页的 <select>（不等到异步数据回来）。
     以前只有各页在自己的渲染链路里调 Dropdowns.build —— 而那条链要等 /registry、
     能力声明回来才跑（工作台首屏几百毫秒到几秒），于是每次切页都先画出
     一排**原生控件**、等数据回来才整批换成公共样式（「基础组件闪一下再变样」）。
     build 本身幂等（_ddBuilt），页面后来的 build/sync 只剩「补增量新节点」一件事。
     包早了不怕选项没填：lbl 退回「请选择」，页面填完 options 照旧要调 sync。 */
  const autoBuild = () => { try { window.Dropdowns.build(document); } catch (e) { /* Dropdowns 那一层还没加载就跳过这一次自动包装 */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoBuild);
  else autoBuild();
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
  const sync = () => { if (opt.onSync) { try { opt.onSync(); } catch { /* 回调是调用方给的，抛错不该把下拉的交互带崩 */ } } };
  const note = t => { if (opt.onNote) { try { opt.onNote(t); } catch { /* 同上：提示回调抛错不影响浮层本身 */ } } };
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
       已经不在列表里时，这一串键必然跟着变，照样作废（那条「顺序变了锚点作废」守的就是这个）。 */
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
   导演台那几个「node 判据也要跑」的纯模块（subtitles / fcpxml）拿不到 window，用
   `web/director/util.js` 的 `escHTML` —— 那是登记在案的浏览器/Node 两份例外（同 `fileSafe`），
   字符表必须与这里逐字一致，改一边就改另一边。
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
        一个外链 <img> 就是页面自己在直连外部域名（「统一路由」）。
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
      btn.addEventListener('click', async () => {
        /* 走 window.copyText 这一个出口：它带 textarea + execCommand 降级，
           而 http 本机环境下 navigator.clipboard 本身就是 undefined（只判它等于「复制不了」）。 */
        if (await window.copyText(code.textContent)) {
          btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1400);
        } else Toast.show('浏览器不让直接复制，选中代码手动复制吧', 'warn');
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

window.ICONS = {
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="3" y="5" width="12" height="14" rx="2"/><path d="m15 10 6-4v12l-6-4"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  box: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
  chart: '<path d="M3 3v18h18M8 16v-5M13 16V6M18 16v-8"/>',
  gear: '<path d="m10 3-.6 2.4-2.1 1.2L5 6l-2 3.5 1.7 1.8v2.4L3 15.5 5 19l2.3-.6 2.1 1.2L10 22h4l.6-2.4 2.1-1.2 2.3.6 2-3.5-1.7-1.8v-2.4L21 9.5 19 6l-2.3.6-2.1-1.2L14 3z"/><circle cx="12" cy="12.5" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M15 8.5H10.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H9M12 6v13"/>',
  sparkles: '<path d="m10 3 2.5 6.5L19 12l-6.5 2.5L10 21l-2.5-6.5L1 12l6.5-2.5zM19 2v4M17 4h4M20 17v4M18 19h4"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 13 13M8 16 21 3"/>',
  list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  // 播放控制保留实心主体，缩到按钮尺寸仍能辨认。
  play: '<path d="m8 4 13 8-13 8z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="5" y="4" width="5" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="5" height="16" rx="1" fill="currentColor" stroke="none"/>',
  speaker: '<path d="M3 9h4l5-5v16l-5-5H3z" fill="currentColor" stroke="none"/><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>',
  speakerOff: '<path d="M3 9h4l5-5v16l-5-5H3z" fill="currentColor" stroke="none"/><path d="m16 9 6 6M22 9l-6 6"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3 3 18 18M10.5 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 4M6 6a22 22 0 0 0-4 6s3.5 7 10 7c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  key: '<circle cx="8" cy="15" r="5"/><path d="m11.5 11.5 9-9M16 7l3 3 3-3-3-3"/>',
  brain: '<path d="M12 5a3 3 0 0 0-5.8-1A4 4 0 0 0 4 11a4 4 0 0 0 1 7 3.5 3.5 0 0 0 7 0V5Zm0 0a3 3 0 0 1 5.8-1A4 4 0 0 1 20 11a4 4 0 0 1-1 7 3.5 3.5 0 0 1-7 0M8 9l4 3 4-3M8 16l4-2 4 2"/>',
  pencil: '<path d="m16 3 5 5L8 21H3v-5zM13 6l5 5"/>',
  reuse: '<path d="M7 7h10a4 4 0 0 1 4 4v2M17 3l4 4-4 4M17 17H7a4 4 0 0 1-4-4v-2M7 13l-4 4 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  starFill: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0M13 8l1-1a4.2 4.2 0 0 1 6 6l-4 4a4.2 4.2 0 0 1-6 0" transform="translate(1 0)"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h2M15 15h2"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderDoc: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 12h8M8 16h5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  docTab: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  checkBox: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
  wand: '<path d="m3 17 14-14 4 4L7 21zM12 8l4 4M5 3v4M3 5h4M19 17v4M17 19h4"/>',
  users: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 3a4 4 0 0 1 0 8M22 21v-2a7 7 0 0 0-4-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  arrowLeft: '<path d="M20 12H4m7-7-7 7 7 7"/>',
  undo: '<path d="M3 9h11a7 7 0 0 1 0 14M8 4 3 9l5 5" transform="translate(0 -1)"/>',
  arrowUp: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  arrowDown: '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  stepBack: '<path d="M4 4v16M20 4 8 12l12 8z"/>',
  stepNext: '<path d="M20 4v16M4 4l12 8-12 8z"/>',
  merge: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M12 6v3M12 15v3M7 12h10"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  flag: '<path d="M4 22V3h15l-3 5 3 5H4"/>',
  chapter: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3v18M13 8h3M13 12h3"/>',
  note: '<path d="M3 3h18v12l-6 6H3zM15 21v-6h6M7 8h10M7 12h6"/>',
  redo: '<path d="M21 9H10a7 7 0 0 0 0 14M16 4l5 5-5 5" transform="translate(0 -1)"/>',
  magnet: '<path d="M4 3h5v10a3 3 0 0 0 6 0V3h5v10a8 8 0 0 1-16 0zM4 8h5M15 8h5"/>',
  ripple: '<path d="M12 5v14M8 8a5 5 0 0 0 0 8M16 8a5 5 0 0 1 0 8M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
  select: '<path d="m4 3 16 10-7 1 4 6-3 2-4-7-5 5z"/>',
  selectEdge: '<path d="M3 3v18M7 3l14 9-6 1 3 5-3 2-3-6-4 4z"/>',
  slip: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h10M9 9l-3 3 3 3M15 9l3 3-3 3"/>',
  slide: '<rect x="3" y="5" width="10" height="14" rx="2"/><path d="M16 12h6M19 9l3 3-3 3"/>',
  skipBack: '<path d="M4 4v16"/><path d="m20 4-12 8 12 8z" fill="currentColor" stroke="none"/>',
  segAdd: '<rect x="2" y="6" width="11" height="12" rx="2"/><path d="M16 12h6M19 9v6"/>',
  segRemove: '<rect x="2" y="6" width="11" height="12" rx="2"/><path d="M16 12h6"/>',
  shorten: '<rect x="9" y="6" width="6" height="12" rx="1"/><path d="M2 12h5M4 9l3 3-3 3M22 12h-5M20 9l-3 3 3 3"/>',
  lengthen: '<rect x="9" y="6" width="6" height="12" rx="1"/><path d="M7 12H2M5 9l-3 3 3 3M17 12h5M19 9l3 3-3 3"/>',
};
window.icon = function icon(name, size) {
  const b = window.ICONS[name];
  if (!b) return '';
  const s = size || 14;
  return '<svg class="ui-icon" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + b + '</svg>';
};

/* HTML 静态标记里的图标：写 <span class="ic" data-icon="sparkles" data-size="17"></span>，
   由这里一次性填成 SVG。图标几何只允许有 ICONS 一份 —— 之前三台各自手抄 sparkles/trash
   的 path，改一套漏两套。
   页面挂载后各调一次（外壳只在启动时填过一次全表）。这一层自己兜住两种「没什么可填」：
   传进来的根节点还没挂上（ref 是 null）、或某一颗图标画不出来 —— 调用点因此不需要
   再包一层 `try { fillIcons(...) } catch {}`（全站原来有七处那么写，把真错误一起吞了）。 */
window.fillIcons = function fillIcons(root) {
  const box = (root === null || root === undefined) ? document : root;
  if (!box || typeof box.querySelectorAll !== 'function') return;
  box.querySelectorAll('[data-icon]').forEach(el => {
    try {
      el.innerHTML = window.icon(el.getAttribute('data-icon'), +el.getAttribute('data-size') || 14);
      el.removeAttribute('data-icon');
    } catch (e) { /* 一颗图标画不出来不许拖垮整页：宁可空着，下面的内容照常出来 */ }
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

/* ---------------------------------------------------------------------------
   AI 动作按钮的唯一一副画法：`.tool.acc` + sparkles 14（mini 那一档 13）+ `.tx` 那一行字。
   「让 AI 干一件事」这颗按钮以前在七处是七副样子：图标各挑 12 / 13 / 14 / 17，外壳是 .chip、
   是没有图标的 .ghost、是 .tool、是导演台自己写的 .polish；忙的时候把整副 innerHTML 重写一遍 ——
   于是一会儿有 .ic 包一层一会儿没有，图标一会儿是强调色一会儿跟字同色，
   而「闲时那句话」在页面里另存了一份副本，可以各自漂开。
   现在两句话都只写在画的那一刻（`data-idle` / `data-busy` 跟着节点走，整栏重画也不丢），
   页面上线后只切状态：`aiBtnState(btn, true|false)`。
   o = { label（必填）, busy（忙时那一句话）, busyOn（当前是不是忙）, title, id, mini, disabled }
   --------------------------------------------------------------------------- */
window.aiBtnHTML = function aiBtnHTML(o) {
  const oo = o || {};
  const label = String(oo.label || '');
  const busy = String(oo.busy || '');
  const on = !!oo.busyOn && !!busy;
  return '<button class="tool acc' + (oo.mini ? ' mini' : '') + '" type="button"'
    + (oo.id ? ' id="' + window.esc(oo.id) + '"' : '')
    + (oo.title ? ' title="' + window.esc(oo.title) + '"' : '')
    + ' data-idle="' + window.esc(label) + '"' + (busy ? ' data-busy="' + window.esc(busy) + '"' : '')
    + ((oo.disabled || on) ? ' disabled' : '')
    + '><span class="ic">' + window.icon('sparkles', oo.mini ? 13 : 14) + '</span>'
    + '<span class="tx">' + window.esc(on ? busy : label) + '</span></button>';
};
/* 忙 / 闲只换 `.tx` 那一行字，顺带把 disabled 一起切了（一颗写着「正在跑」却能连点的按钮，
   双击就是两轮并行请求、双倍扣费）。取不到 `.tx`（那颗按钮本来只有图标没有字）时一个字都不动 ——
   不许把图标抹掉。没有 `data-busy`（画的时候没登记忙话）就只切 disabled。 */
window.aiBtnState = function aiBtnState(el, on) {
  if (!el || !el.querySelector) return;
  el.disabled = !!on;
  const tx = el.querySelector('.tx');
  if (!tx) return;
  const idle = el.getAttribute('data-idle');
  if (idle == null) return;
  const busy = el.getAttribute('data-busy');
  tx.textContent = (on && busy) ? busy : idle;
};

/* ============================================================================
   GoPage —— 「跳到另一页」只有这一份
   页面都住在同一份文档里（web/app.js 的 hash 路由 + KeepAlive 页面池），所以换页必须
   交给外壳的 appShow：侧栏高亮跟着动、地址栏跟着变、已建过的页面只切可见性不重建。
   页面自己 `location.href = 'usage.html'` 会把整份 SPA 重新加载一遍。
   只有「这一份页面是独立打开的、没有外壳」时才回退到 href（旧地址别名也走这条）。
   带查询串的写法由路由解析：GoPage.go('assets.html?q=…') / ('studio.html?t=video')。
   用法：GoPage.btn('usage.html', '用量与余额') 出标记 → GoPage.bind(root) 接点击。
   ========================================================================== */
window.GoPage = {
  go(file) {
    const f = String(file || '');
    if (!f) return;
    try {
      /* 外壳里（iframe）交给 parent；已经迁到 Vue、与路由同文档的页面交给 window.appShow。
         少了后面那一半，Vue 页面点「去用量」会走 location.href —— 整份 SPA 重新加载。 */
      const host = (window.parent && window.parent !== window) ? window.parent : window;
      if (typeof host.appShow === 'function') { host.appShow(f, true); return; }
    } catch (e) { /* 跨域 / 没有外壳：走下面那条 */ }
    location.href = f;
  },
  btn(file, label) {
    return '<button class="tool mini" data-go="' + String(file || '').replace(/"/g, '') + '">'
      + String(label || '去看看') + '</button>';
  },
  /* 用一个委托接住整个容器里的所有入口：`setStatus` 写进去的按钮是后来才出现的，
     逐个找 id 绑定会在重画之后漏掉。 */
  bind(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-go]').forEach(b => {
      if (b._goBound) return;
      b._goBound = 1;
      b.onclick = e => { e.stopPropagation(); this.go(b.getAttribute('data-go')); };
    });
  },
};

/* 只有「从窗口外拖进来的文件」才算上传。在页面里拖一张图，浏览器也会把它塞进
   dataTransfer.files，但它同时带 text/html / text/uri-list —— 拿它当上传，
   收藏页拖一下卡片就多出一条收藏，画布上拖一下节点就多出一个节点。 */
window.isExternalFileDrag = function isExternalFileDrag(e) {
  const dt = e && e.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  if (!types.includes('Files')) return false;
  return !types.includes('text/html') && !types.includes('text/uri-list');
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
  try { await navigator.clipboard.writeText(s); return true; } catch { /* Clipboard API 被拒就退回下面那份临时 textarea 兜底 */ }
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
  /* ---------- 日期与时刻文案（全站一份） ----------
     改这一族之前全站有六种抄法：裸 `toLocaleString()`、`'zh-CN' + hour12:false`、
     `toLocaleDateString()` 拼 `toLocaleTimeString([], {2-digit})`、手拼 padStart……
     差别都落在「带不带秒」「显不显示年份」「跟不跟着浏览器 locale 漂」上 ——
     同一条记录在详情面板写「2026/10/15 下午10:59:07」，在资产库写「10/15/2026, 10:59 PM」，
     在用量页写「10/15 22:59」，在收藏页又不带秒。裸调那几个 locale API 更是换台机器就换一种写法。
     统一成手拼的 ASCII 数字：dayKey `2026-10-15` / fmtHM `22:59` / fmtHMS `22:59:07` / fmtWhen `2026-10-15 22:59`
     / fmtWhenSec `2026-10-15 22:59:07`。
     **放在 ui.js 而不是 workbench.js**：用量页与外壳不加载 workbench.js，而每一页都加载 ui.js
     （与上面 fmtBytes 同一层的理由一模一样）。
     ⚠ 这一族不许写成 `String(…).padStart(2, '0') + ':' + String(…).padStart(2, '0')` 那个形状 ——
       播放器读数那一份（workbench.js 的 Wb.fmtClock）是全站唯一的手拼 mm:ss，
       所以这里走 pad2。
     「没值显示什么」（空串 / '—' / 「还没同步过」）是各个界面自己的事，这一族只管有值时怎么拼。 */
  const pad2 = n => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(2, '0');
  window.pad2 = pad2;               // 导演台命名（naming.js）与全站日期读数共用这一份
  /* null / 空串 / 0 一律当「没有这个时间」，不当 1970 年 —— 调用点普遍写 `ts ? fmtWhen(ts) : '—'`，
     但 `new Date(null)` 是 1970-01-01，漏一层判空就会把「没有时间」显示成一个日期。 */
  const asDate = t => (t instanceof Date ? t : (t == null || t === '' || t === 0 ? new Date(NaN) : new Date(t)));
  function dayKey(t) {
    const d = asDate(t);
    if (!isFinite(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtHM(t) {
    const d = asDate(t);
    return isFinite(d.getTime()) ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '';
  }
  function fmtHMS(t) {
    const d = asDate(t);
    return isFinite(d.getTime()) ? fmtHM(d) + ':' + pad2(d.getSeconds()) : '';
  }
  function fmtWhen(t) {
    const k = dayKey(t);
    return k ? k + ' ' + fmtHM(t) : '';
  }
  /* 带秒那两种是给「同一分钟里会有好几条」的地方：账单 CSV 导出、设置页那两张清单（云同步结果 /
     备份 / 提示词归档）用 fmtWhenSec（导出与清单要能对得上是哪一次），只到时分的那一列旁边另有
     「已耗时」的用 fmtHMS（导演台任务卡片的提交时间、用量页「更新于」）。
     界面上一行一个时间默认一律 fmtWhen —— 别为了「看着更精确」到处换成带秒的那两支。 */
  function fmtWhenSec(t) {
    const k = dayKey(t);
    return k ? k + ' ' + fmtHMS(t) : '';
  }
  window.dayKey = dayKey; window.fmtHM = fmtHM; window.fmtHMS = fmtHMS;
  window.fmtWhen = fmtWhen; window.fmtWhenSec = fmtWhenSec;
  /* ---------- 下载文件名（全站一份） ----------
     收拢前有八处各写一遍，而且**四种口径各不相同**：
       · 非法字符名单：有的带控制字符（页面那三处写 \x00-\x1f）、有的不带（assetlib 那两处、代理那份带）；
       · 换法：换成 -（资产库 / 工作台 / 导演台成片）、换成 _（素材库 / 转存本机）、直接删掉（assetlib 的 nameOf）；
       · 截断：20 / 24 / 60 / 80 各一份；兜底名：file / asset / 素材 / merged / 未命名 各一份。
     于是同一张图从资产库下载与从工作台下载出来的文件名不一样，而「结尾的点与空格会被 Windows
     悄悄去掉」「名字里有换行会被截断成两半」这两条只有素材库那一份处理过。
     收成两块**读法**：`fileSafe` 洗一个字、`fileStamp` 拼一个「年月日-时分秒」。
     **各页那个 `fileNameOf` 留着** —— 它决定「这一页的文件名长什么样」（前缀、标签、扩展名从哪个字段取），
     那是页面自己的事；但它只能用这两块拼，不许再自己写一遍字符名单或 padStart 那一串。
     ⚠ 代理（Node 进程）够不着这里，`proxy.js` 另留一份同名 `fileSafe`，与上面 dayKey / dayPart 同一安排：
       浏览器一份、Node 一份，各自是那一侧的唯一落点。 */
  function fileSafe(s, max) {
    const t = String(s == null ? '' : s)
      .replace(/[\r\n\t]+/g, ' ')        // 换行与制表留着会被文件系统截断成两半
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')            // 结尾的点与空格：Windows 保存时悄悄去掉，名字就对不上账
      .trim();
    return (t || '素材').slice(0, max || 24);
  }
  /* 没给时间 = 「现在」；给了但读不出 = 也当现在（`new Date(坏值)` 是 Invalid Date，
     直接拼会出来一串 NaN —— 文件名里出现 NaN 是本项目见过的那种「看着像代码坏」的产物）。 */
  function fileStamp(ts) {
    const raw = (ts == null || ts === '' || ts === 0) ? new Date() : new Date(ts);
    const d = isFinite(raw.getTime()) ? raw : new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  window.fileSafe = fileSafe; window.fileStamp = fileStamp;
  /* 「这一条素材是不是声音」全站只在这里点一次名：同一类有两种写法 —— 本机产物按字节判出来是
     「音频」，平台声明里写的是「音乐」（`assetlib.js` 的 `slotTypes` 两种都给），所以任何判据都得两个名字一起认。
     收拢前它抄了十几遍，其中资产库那份下载名**只认「视频」**，于是一条没有 format 字段的音频
     下载回来叫 `.png`（存进下载文件夹的是一张打不开的图）。
     ⚠ 数组形状不算这一条判据：`types: ['音频', '音乐']`（素材选择器的槽位过滤）是一张给人看的数据表，
        不是「是不是声音」的判断。 */
  function isAudioType(t) { return t === '音频' || t === '音乐'; }
  window.isAudioType = isAudioType;
  /* 「这一条素材按哪种媒体来放」只有三个取值（video / audio / image），而它也是按类型名推的：
     四处各写了一遍（资产库与收藏的灯箱 kindOf 适配器、工作台的 kindOf、`Wb.reuse.kindOf`）。
     这四份**今天恰好还一致**（都认「音频」与「音乐」两个名字），所以这一条不是修 bug，
     是修「平台再多一种类型名时要改四个地方」—— 与上面 isAudioType 同一件事，只留一份读法。 */
  function mediaKindOf(t) {
    const s = String(t || '');
    return s === '视频' ? 'video' : isAudioType(s) ? 'audio' : 'image';
  }
  window.mediaKindOf = mediaKindOf;
  /* 「文件类型筛选」那一排的档位与顺序全站只有这一份：全部 → 视频 → 图片 → 音频。
     以前四个入口各排各的：收藏与资产库写「图片 视频 音频」，工作台按「这一屏出现过的类型」现攒 ——
     于是音频那一档要等第一条音频到账才冒出来，整排跟着左右挪；同一排 chips 在四页顺序还不一样。
     档位与顺序是用户看着记的东西，不跟着数据到达顺序漂。 */
  const MEDIA_KIND_ORDER = ['视频', '图片', '音频'];
  /* 「全部」那一颗的内部键两页不同（工作台与收藏用 all，资产库用 全部），都算档首。
     三档之外的档名排在末尾，靠稳定排序保持页面自己给它们的相对顺序 —— 不硬塞进三档里的哪一档。 */
  const MEDIA_ALL_KEYS = ['all', '全部'];
  function mediaKindRank(t) {
    const s = String(t || '');
    if (MEDIA_ALL_KEYS.includes(s)) return -1;
    const i = MEDIA_KIND_ORDER.indexOf(s);
    return i < 0 ? MEDIA_KIND_ORDER.length : i;
  }
  /* 一整排档位表：`[内部键, 显示名]` 的数组，直接交给 Wb.kindFilter 的 kinds。
     四档一次给全 —— 「这一档现在 0 条」不是少画一颗的理由。 */
  function mediaKindTabs(allKey) {
    const all = allKey != null ? String(allKey) : 'all';
    return [[all, '全部']].concat(MEDIA_KIND_ORDER.map(k => [k, k]));
  }
  window.mediaKindRank = mediaKindRank; window.mediaKindTabs = mediaKindTabs;
  /* 一份「东西」属于哪一类媒体（image / video / audio），认不出给空串。
     与 mediaKindOf 的分工：那个按**素材条目的类型名**决定画哪种播放器，认不出按图片；
     这个按**来源**判（扩展名 / MIME / 类型名 / 上传的 File），认不出就是认不出 ——
     不能把一份 txt 当图片去存、也不能把一条任务当图片去画。
     以前本机镜像、助手附件、画布生成各写一份 kindOf，扩展名与 MIME 的优先级还不同。 */
  const MEDIA_KIND_EXTS = {
    image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'],
    video: ['mp4', 'webm', 'mov', 'mkv'],
    audio: ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus'],
  };
  function mediaKindFrom(v) {
    const kindOfName = s => {
      const t = String(s || '').trim().toLowerCase();
      if (t === 'image' || t === '图片' || t === '图像') return 'image';
      if (t === 'video' || t === '视频') return 'video';
      if (t === 'audio' || t === '音频' || t === '音乐') return 'audio';
      return '';
    };
    const kindOfExt = e => {
      const x = String(e || '').toLowerCase().replace(/^\./, '');
      if (!x) return '';
      return Object.keys(MEDIA_KIND_EXTS).find(k => MEDIA_KIND_EXTS[k].indexOf(x) >= 0) || '';
    };
    if (typeof v === 'string') {
      const byName = kindOfName(v);
      if (byName) return byName;
      const byExt = kindOfExt(v.replace(/^.*[\\/]/, '').replace(/^.*\./, ''));
      if (byExt) return byExt;
      return String(v).indexOf('image/') === 0 ? 'image'
        : String(v).indexOf('video/') === 0 ? 'video'
          : String(v).indexOf('audio/') === 0 ? 'audio' : '';
    }
    if (!v || typeof v !== 'object') return '';
    const byExt = kindOfExt(v.ext || v.format);
    if (byExt) return byExt;
    const byName = kindOfName(v.type || v.kind);
    if (byName) return byName;
    const mime = String(v.mime || v.type || '').toLowerCase();
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('video/') === 0) return 'video';
    if (mime.indexOf('audio/') === 0) return 'audio';
    const m = /\.([a-z0-9]{2,5})$/i.exec(String(v.name || ''));
    return m ? kindOfExt(m[1]) : '';
  }
  window.mediaKindFrom = mediaKindFrom;
  /* 一条素材的下载扩展名（`fileSafe` 那一族的一块读法，2026-10 从四处收成一份）。
     收成之前四份口径互不相同，同一个条目从哪一页下载决定它叫什么：
       · 资产库 `format || (视频?mp4:png)` —— 音频漏了，落到 png；
       · 工作台 `视频?mp4:图片?png:(format||wav)` —— 图片/视频**不看 format**，一张 jpeg 下回来是 .png；
       · AI 助手 `format || (音频?mp3:…)` —— 音频兜底 mp3，与语音台的默认档 wav 不同；
       · 收藏 `format ? '.'+format : ''` —— 没有 format 就没有扩展名，双击打不开。
     口径只有一条：**先认条目自己带的 `format`**（平台列表与本机资产都会填，它就是产物真正的尾缀），
     认不出来（空、带空格、带斜杠）才按类型猜 —— 图片 png / 视频 mp4 / 音频 wav（无损兜底，与语音台默认档一致）。
     类型字段两页不同名（资产库与收藏写 `type`、工作台写 `mtype`），这里两个都认。 */
  function fileExtOf(it) {
    const t = String((it && (it.mtype || it.type)) || '');
    const fmt = String((it && it.format) || '').toLowerCase().replace(/^[.\s]+|[.\s]+$/g, '');
    if (/^[a-z0-9]+$/.test(fmt)) return fmt === 'jpeg' ? 'jpg' : fmt;
    return t === '视频' ? 'mp4' : isAudioType(t) ? 'wav' : 'png';
  }
  window.fileExtOf = fileExtOf;
  /* 一个**上传文件 / Blob** 的扩展名（不带点）。与上面 fileExtOf 的区别是输入不是素材条目：
     先认调用方给的 format（导演台镜像：条目上声明的产物尾缀），再认文件名里的尾缀，
     最后按 MIME 查表；都没有给 bin（素材转存与助手附件以前各写一份，口径还不一样）。 */
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac' };
  function blobExtOf(blob, format) {
    const fmt = String(format || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (fmt) return fmt;
    const m = /\.([a-z0-9]{2,5})$/i.exec(String((blob && blob.name) || ''));
    if (m) return m[1].toLowerCase();
    const full = String((blob && blob.type) || '').toLowerCase();
    if (MIME_EXT[full]) return MIME_EXT[full];
    const sub = (full.split('/')[1] || '').replace(/[^a-z0-9]/g, '');
    return sub ? sub.slice(0, 5) : 'bin';
  }
  window.blobExtOf = blobExtOf;
  /* 「这两个名字算不算同一个」全站只有一把尺子（2026-10-17 从 director.html 的场景名归一收成公共层）。
     它管三件事：导演台判「同一个场景」（AI 分镜追加时并场、手动 `#` 换场、素材库里同名那条认领场景图）、
     素材库判「同一个分组」（`Chars.Lib.groups()` 把「校园篇」与「校园篇 」与「校园 篇」算成一组）、
     以及拆分镜落盘时把 AI 写的 `@名字` 对回库里那一条。
     以前它是 director.html 里一个页面私有函数，于是素材库那三份组名判据各按字面 trim ——
     下拉写着「校园篇（12）」而筛出来只有 10 条，正是「界面上的数字与真筛得动的东西分家」。
     ⚠ 它只抹空白与大小写，**不做近似匹配**（「小雅」与「小雅雅」仍是两个名字）：
       归一判据一旦开始"顺手猜"，并场与筛组就会把不该合的东西合掉，而合掉的东西拿不回来。 */
  function nameKey(t) { return String(t == null ? '' : t).replace(/\s+/g, '').toLowerCase(); }
  window.nameKey = nameKey;
  /* 「供应商类型」那一族的名字与顺序全站只有一份（2026-10-15 从 settings.html 与 ai-chat.js 两份逐字相同的表、
     外加两处手抄的键序收成一份）。
     ⚠ 这一族说的是**一型供应方**，与上面 `isAudioType` / `mediaKindOf` 那一族（**一条素材**）不是同一张表：
       `audio` 在这里叫「语音」（设置页那一排档名、助手报告里的类型），在素材那一族叫「音频」。
       合成一张表会让设置页的档名变成「音频类」、资产库的筛选项变成「语音」—— 差的就是这两句话。
     `PROV_KINDS` 以前页面写一份、助手再抄一份：注册表加了第五类时那一排 tab 不会跟着长。 */
  const PROV_KIND_ZH = { image: '图片', video: '视频', audio: '语音', text: '文字' };
  function provKindZh(k) { return PROV_KIND_ZH[k] || String(k || ''); }
  /* 四档的顺序 = 设置页那一排 tab 的顺序 = 助手报告里分档的顺序 */
  function provKinds() { return Object.keys(PROV_KIND_ZH); }
  window.provKindZh = provKindZh; window.provKinds = provKinds;
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


/* ============================================================================
   Toast —— 全站统一的轻提示（实现只在 web/ui/toast.js 那一份）
     Toast.receipt('已删掉 3 条')  数据真的变了：必定显示（安静档不能吞）
     Toast.ok('已保存') / Toast.err(e) / Toast.warn('…') / Toast.info('…')
     ok / info 归安静档（默认只复述状态的那种不弹），warn / err 与回执一律显示。
   ========================================================================== */


/* ============================================================================
   ErrBanner —— 顶部那条「出错了」横幅，全站只有一份（样式在 ui.css 的 #banner）
     ErrBanner.show(那句话的 html, 'err' | 'warn')
   为什么要收成公共这一份：以前只有导演台接了（<head> 里内联的 window.onerror +
   unhandledrejection 两段），工作台另写一份（把错误打进 #status 那一行小字），
   **其余八页什么都没接** —— 页面初始化是一条长链（注册表 → 能力 → 列表 → 渲染），
   任何一步抛错后面全都不跑，而界面上只剩「空白」；页面脚本的错误又只落在浏览器控制台，
   于是「打开就是空的」根本查不动。
   干净 profile 第一次进导演台就是撞上这一类（加载期竞态抛 TypeError），
   当时能看出来正是因为导演台有这条横幅。现在引了 ui.js 的页面自动都有，
   全局那两个错误监听器在 web/core/report.js（全站只装一次，页面里不要再写第二份），
   这一层只留 show()：谁都可以调它，横幅本身仍然只有这一处。
   资源加载失败（图片 / 视频 404）故意**不**报：那多半是过期签名外链，
   公共层为它准备了回退与「已丢失」角标（assetlib.js 的 AssetLocal），
   混进这条横幅只会把真错误淹掉。
   ========================================================================== */
(function () {
  const pending = [];
  function hostEl() {
    const old = document.getElementById('banner');
    if (old) return old;                     // 页面自己写了标记就用那一个（导演台）
    const d = document.createElement('div');
    d.id = 'banner';
    d.hidden = true;
    document.body.insertBefore(d, document.body.firstChild);
    return d;
  }
  window.ErrBanner = {
    show(html, kind) {
      const msg = String(html == null ? '' : html).trim();
      if (!msg) return;                       // 空调用不许顺手收起已经在亮着的错误
      const put = () => {
        const b = hostEl();
        b.hidden = false;
        b.className = kind === 'warn' ? 'warn' : 'err';
        b.innerHTML = '<span class="msg"></span><button class="bx" title="关闭">' + window.icon('close', 11) + '</button>';
        b.querySelector('.msg').innerHTML = window.sanitizeHTML(msg);
        b.querySelector('.bx').onclick = () => { b.hidden = true; b.innerHTML = ''; };
      };
      if (document.body) put(); else pending.push(put);   // body 还没开始排时就先攒着
    },
  };
  if (document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => { while (pending.length) pending.shift()(); }, { once: true });
  }
  /* window.error / unhandledrejection 这两个监听器不在这里了：
     横幅只负责「显示」，「显示 + 进代理那本账」由 web/core/report.js 那一份统一装。
     这一层只留 show()，谁都可以调，但它自己不再听全局错误。 */
})();

/* ============================================================================
   Store —— 带上限的本地存储（各页面历史记录统一走它）
     · 唯一格式：信封 { data: 值, ts: 写入时间 }（ts 给数据文件对账比新旧用）
     · 写入失败（配额满 / 隐私模式）会**返回错误并提示**，不再静默丢数据
   用法：
     const list = Store.read('img_hist', []);
     Store.write('img_hist', list, { cap: 200, label: '图片历史' });
   ========================================================================== */


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
    /* 一次写整份名单（设置页那一排「侧栏余额」勾选走这里：勾一次就把整份名单落盘）
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
   新增页面时把它加进来（和 web/core/routes.js 的 pages 一起改）。 */
window.PAGE_TARGETS = {
  rows: [
    /* 三个工作台合并成 studio.html 之后只有一行：类型在页面里切，分页是整个右栏一起翻 */
    { key: 'studio', name: '工作台', defMode: 'more', defSize: 24 },
    { key: 'assets', name: '资产库', defMode: 'more', defSize: 24 },
    { key: 'favorites', name: '我的收藏', defMode: 'page', defSize: 24 },
    { key: 'chars', name: '素材库', defMode: 'page', defSize: 18 },
  ],
  /* 每页条数的可填区间与「显示方式」的取值：设置页的输入框与助手的校验共用这一组数 */
  size: { min: 1, max: 100 },
  modes: ['page', 'more'],
};

/* 「这一页现在到底怎么翻 / 一页几条」的读法只在这一处。
   以前四个工作台页面各抄一遍「取存储 || 退回默认档」，兜底那个数还各自写死（24 / 18 / 12），
   设置页那张表与 AI 助手的读数又各抄一遍 —— 于是「素材库默认 18 条」这件事在六个地方有六种说法，
   改哪一页的默认档都得挨个文件找。默认档一律现读上面那张表；存储里是坏值就退回默认档。 */
function pageRowOf(k) {
  const t = window.PAGE_TARGETS || { rows: [] };
  return (t.rows || []).find(r => r.key === k) || {};
}
function pageLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
window.pageModeOf = k => {
  const t = window.PAGE_TARGETS || {};
  const md = t.modes || ['page', 'more'], v = pageLS('page_mode_' + k);
  return md.indexOf(v) >= 0 ? v : (pageRowOf(k).defMode || md[0]);
};
window.pageSizeOf = k => {
  const sz = (window.PAGE_TARGETS || {}).size || { min: 1, max: 100 };
  const n = Number(pageLS('page_size_' + k));
  /* 上下都要夹：以前只夹下限，localStorage 里一个 9999（手改 / 旧版本写坏）
     会让一页画几千张卡片；设置页的输入框本来也只许填到 max。 */
  const v = Math.floor(Math.max(sz.min || 1, n || pageRowOf(k).defSize || sz.min || 1));
  return sz.max ? Math.min(sz.max, v) : v;
};

/* 「界面偏好有哪几项」只这一份：设置页按它渲染那两张卡，AI 助手按它列可改白名单，
   侧栏 / 资产库 / 收藏页读写的是同一批键。取值也写在这里 —— 每一页的档位名不一样
   （资产库 card/compact，收藏 list/compact），让页面自己猜就会写进那一页根本不认的值。
   `group` 点名一项归哪张卡（以前全画进「外观与界面」，「产物自动存本机」也混在里面）；
   `keep:1` = 「恢复默认」不清这一项。这张表同时是「跟着 .data 走」与「进设置导出」两份名单的出处
   （见 datasync.js 与设置页），以前那两份各抄一遍，抄漏的是 sb_open 与 sk_media_badge 不同步。 */
/* 展示样式的档位名只在这里点一次名（2026-10 从 7 处收成 1 处）：这一对名字以前散在
   三页各自的 `views:`、这里三行 `opts:` 与 workbench.js 的兜底默认档里，漏改哪一处都不报错，
   而 `opts` 与页面认的取值不一致时，助手按设置页写进去的值那一页根本不认。
   图标几何不进这里（那是 workbench.js 那一层的事），这里只管「有几档、每档叫什么」。 */
window.VIEW_MODES = [['list', '列表'], ['compact', '紧凑']];

window.UI_PREFS = {
  /* 卡内的小节。设置页按它分小节渲染，助手那边拿同一个词当前缀。 */
  groups: [
    { id: 'look', name: '界面本身' },
    { id: 'list', name: '列表默认摆法' },
    { id: 'store', name: '产物存哪、读哪' },
  ],
  rows: [
    { key: 'dir_palette', group: 'look', name: '主题配色', kind: 'seg', def: 'ocean', keep: 1,
      opts: [['ocean', '海洋'], ['violet', '紫罗兰'], ['teal', '青碧'], ['berry', '莓果'], ['amber', '琥珀']],
      hint: '只换强调色。' },
    { key: 'dir_theme', group: 'look', name: '日间 / 夜间', kind: 'seg', def: 'light', keep: 1,
      opts: [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']],
      hint: '跟随系统 = 按系统的深色设置。' },
    { key: 'sb_open', group: 'look', name: '侧栏默认展开', kind: 'bool', keep: 1,
      hint: '勾上 = 进页面就带出「图标 + 文字」那一列；点 logo 随时能收展。' },
    { key: 'sk_quiet_ok', group: 'look', name: '操作成功也给一声提示', kind: 'bool',
      hint: '默认关（安静）：右上角只在出错与警告时弹。「已经做完了」「这里没有东西可做」这类不弹 —— ' +
        '做完的事界面上看得见，一排绿色对勾会把真正该看的错误淹掉。' },
    { key: 'dir_asset_view', group: 'list', name: '资产库', kind: 'seg', def: 'list', keep: 1,
      opts: window.VIEW_MODES,
      hint: '只管默认摆法，页内还能换。' },
    { key: 'dir_fav_view', group: 'list', name: '我的收藏', kind: 'seg', def: 'list', keep: 1,
      opts: window.VIEW_MODES },
    { key: 'sk_media_local', group: 'store', name: '产物自动存本机', kind: 'seg', def: 'on', keep: 1,
      opts: [['on', '开'], ['off', '关']],
      hint: '生成完存进本机资产库；各页产物也会自动存回。关掉只留平台外链，过期会裂图。' },
    { key: 'sk_media_prefer', group: 'store', name: '优先用本机文件', kind: 'seg', def: 'on', keep: 1,
      opts: [['on', '开'], ['off', '关']],
      hint: '开 = 读本机副本；关 = 直连平台地址。文件没了会回源。' },
    /* 第三档依附前两档：不存本机就永远没有本机副本，不优先读本机就谈不上「只看本机」，
       所以它只在两者都开着时才画出来（`needs` 由 settings.html 的渲染处现判），
       而**真生效**的判据在 assetlib.js 的 AssetLocal.localOnly —— 页面不许自己再拼一次「三个开关都开着」。
       键名刻意不叫 sk_media_local_only：SYNCABLE / EXPORTABLE 里有 'sk_media_local' 这一条**前缀**，
       那样起名会被它顺带命中（同一类的坑在下面的 NOT_SYNC 注释里点名过）。 */
    { key: 'sk_media_badge', group: 'store', name: '卡片显示「本机 / 云端」标识', kind: 'seg', def: 'on', keep: 1,
      opts: [['on', '显示'], ['off', '不显示']],
      hint: '卡上标出本机 / 云端，只影响显示。' },
    { key: 'sk_media_cloud_hide', group: 'store', name: '不显示云端任务', kind: 'bool', keep: 1,
      needs: ['sk_media_local', 'sk_media_prefer'],
      hint: '列表只留本机有的。在跑的与失败的不藏。要上面两项都开着。' },
  ],
  /* 这一项现在是不是「开着」：seg 的关档存的是 'off'，bool 的关是根本没这个键（或空值）。
     只有这一份读法，设置页判「该不该画」与别处判「生效没」都走它，别各自 getItem 一遍。 */
  isOn(k) {
    const r = (this.rows || []).find(x => x.key === k);
    if (!r) return false;
    let v = null;
    try { v = localStorage.getItem(k); } catch (e) { return r.kind === 'bool' ? !!r.def : r.def !== 'off'; }
    if (r.kind === 'bool') return v == null ? (r.def === true || r.def === '1') : (v !== '' && v !== '0');
    return (v == null ? (r.def != null ? r.def : '') : v) !== 'off';
  },
  /* 这一行现在画不画（needs 点名的那几项全开着才画）。 */
  visible(r) {
    const need = (r && r.needs) || [];
    return !need.length || need.every(k => this.isOn(k));
  },
  /* 某一组的显示名（助手取名时用）。认不出 group 的一律算「界面」，与旧口径一致。 */
  groupName(id) {
    const g = (this.groups || []).find(x => x.id === id);
    return (g && g.name) || '界面';
  },
  /* 这一张表在「跟着 .data 同步」与「进设置导出」两份名单里的键名出处；keepKeys() 是「恢复默认不清」那份。 */
  keys() { return (this.rows || []).map(r => r.key); },
  keepKeys() { return (this.rows || []).filter(r => r.keep).map(r => r.key); },
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


/* ============================================================================
   键改名 —— 一次性，把「功能改了、键名还留着旧前缀」的那批搬过去
   ---------------------------------------------------------------------------
   2026-10 拍短剧页删除之后，素材库那一族键名里的 drama_ / dr_ 已经名不副实：
   短剧没了，键还在（而且是**用户本机已有的数据** —— 几百条素材、改过的提示词）。
   这里把它们搬成 char_ 前缀。

   三条纪律（每一条都对应踩过或预判过的坑）：
     ① **按原始字符串搬，不重新序列化**。这一族键的形状**不统一**：
        char_lib / char_* 走 `Store`，存的是 `{data, ts}` 信封；
        `sk_polish_*` 是设置页直接 setItem 的**裸值**。
        getItem → setItem(同一个串) 两种都原样过去；重新 JSON.stringify 一遍，
        裸值那份必被包成信封，于是 `prompt()` 读出来是 `{"data":"……"}` 这种源码。
     ② **新键已经有值就不搬**（以新键为准）。万一是另一台机器同步回来的陈旧值，
        拿它覆盖本机刚填的那份就是倒退 —— 与 `ModelPrefs.migrate()` 同一立场。
     ③ **`.data/` 里那份镜像要显式删**，不能只 removeItem：旧键已经不在 SYNCABLE 里了，
        存储钩子不认它，服务器上那份会留下来；下一次 boot 看见「服务器有、本地没有」
        就把它拉回 localStorage，于是每次开页面重复一遍「拉回来 / 删掉」。
        这就是下面 DELETE 用 `?nobak=1` 的原因（同 sweepLegacyKeys）：
        这几个键是「已经换过名、宣告作废」的，留 .bak 只会让备份清单里永远挂着旧键名。

   排在 `DataSync.boot()` **之后** —— 理由见上面 afterSynced 那段注释。
   ========================================================================== */
const KEY_RENAME = {
  /* 素材库本体（几百条角色 / 场景 / 道具）—— 唯一一份不能丢的 */
  'drama_chars': 'char_lib',
  /* 素材库那一页的设置项 */
  'dr_tts_mode': 'char_tts_mode',
  'dr_cand_n': 'char_cand_n',
};
async function migrateRenamedKeys() {
  if (!window.Store || !Store.available) return [];
  const moved = [];
  for (const [from, to] of Object.entries(KEY_RENAME)) {
    let raw = null;
    try { raw = localStorage.getItem(from); } catch { continue; }
    if (raw == null) continue;
    /* ② 新键已有值 → 以新键为准，不搬 */
    let cur = null;
    cur = window.LS.get(to);   // LS 把「读不到」统一变成 null，这一层不需要 try
    if (cur == null) {
      try { localStorage.setItem(to, raw); } catch (e) { console.warn('[Store] 键改名失败 ' + from + ' → ' + to, e); continue; }
    }
    /* ① 搬的是原始字符串，形状原样过去；搬过就删旧键（搬失败上面已经 continue 了） */
    window.LS.del(from);
    /* ③ 服务器上那份也要删（见上面那段注释：旧键已不在 SYNCABLE，钩子不会替你发） */
    try { await Net.fetch('/data/' + encodeURIComponent(from) + '?nobak=1', { method: 'DELETE', timeout: 8000, retry: 0 }); } catch (e) { /* 服务器上那份删不掉只留一份旧数据，本机改名照旧生效 */ }
    moved.push(from + ' → ' + to);
  }
  if (moved.length) console.info('[Store] 改了几个键名：' + moved.join('、'));
  return moved;
}

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
     · dir_studio_sort / dir_asset_sort / dir_fav_sort / dir_char_sort —— 2026-10 把四页
       （工作台右栏 / 资产库 / 收藏 / 素材库）那一排排序芯片全去掉了，公共的 window.SortBy
       也整块删除：那是个纯显示偏好，换台机器要重配，而「找最早的那一张」在资产库有日期筛选、
       在收藏与素材库有「AI 搜索」（AI 给的名次照样生效，只是不再是可挑的档位）。
       那份「档位:方向」从此再没有读者。
     · drama_ 那一族（2026-10 拍短剧页删除）——
       `dramas` / `drama_active` 是短剧本体（剧本、每一段的每一次拍摄）；
       `dr_adv_open` / `dr_story_open` 是那个页两个折叠面板的开合偏好。
       素材库那一侧（`drama_chars` 与 `dr_ai_voice` / `dr_tts_mode` / `dr_cand_n`）**不在这里** ——
       那几份数据还要用，`migrateRenamedKeys()` 搬到 char_ 前缀的新键。
       提示词正文那一族（`sk_polish_*`，含改名前的 sk_polish_drama_image / _voice）也不再读：
       正文现在只来自启用的 Skill 与 TextAI.DEF，盘上残留由 tools/migrate-skills.cjs 备份后删除。
     · sk_polish_drama_story / _split / _prop / _video / _open / _subshot / _retouch /
       _camera / _look / _scenedesc / _propdesc —— 那 11 条是拍短剧页的 AI 指令，
       页面删了之后指令本身也从 TextAI.DEF 里删了，设置页那一张卡不再列它们。
       用户改过的文案留着也没人读，跟着云同步整包带走还是一份死数据。
   两处都要清：localStorage 里的本体，和 `.data/` 里那份镜像。
   镜像走 `DELETE /data/<键>?nobak=1`（代理删东西默认留一份 .bak，这条路**特意绕开**）：
   这几个键是「已经宣告作废」的，为它们留后悔药只会让设置页的「备份清单」里永远挂着
   几行用户认不出、也永远不会去恢复的键名。
   本机一个都没有就什么都不做 —— 不为了「可能有」去打扰代理。
   ========================================================================== */
const LEGACY_KEYS = [
  'page_mode_image', 'page_size_image', 'page_mode_video', 'page_size_video',
  'page_mode_audio', 'page_size_audio', 'sk_text_provider', 'video_tasks',
  'dir_studio_sort', 'dir_asset_sort', 'dir_fav_sort', 'dir_char_sort',
  /* 拍短剧页删除（2026-10）：短剧本体与那个页的界面偏好。素材库那一侧另有搬运用，见上。 */
  'dramas', 'drama_active', 'dr_adv_open', 'dr_story_open',
  /* 拍短剧页的 11 条 AI 指令 —— 指令条目已随页面从 TextAI.DEF 删除，设置页也不再列它们。 */
  'sk_polish_drama_story', 'sk_polish_drama_split', 'sk_polish_drama_prop', 'sk_polish_drama_video',
  'sk_polish_drama_open', 'sk_polish_drama_subshot', 'sk_polish_drama_retouch', 'sk_polish_drama_camera',
  'sk_polish_drama_look', 'sk_polish_drama_scenedesc', 'sk_polish_drama_propdesc',
  /* 任意脚本注入整族删除（2026-10）：权限模型只留 ActionRegistry，不再给模型执行代码的入口。 */
  'ai_chat_inject', 'ai_chat_inject_auto',
  /* 提示词编辑器整块删除（2026-10）：折叠状态已经没有对应的卡。 */
  'set_fold_polish',
  /* 「按类型另存一份到指定文件夹」整族撤销（2026-10-23）：产物只有一份，就住在资产库根的类型子目录里，
     而那个根默认就是用户翻得到的 下载\成像。`sk_autosave` 是那三档的开关与目录，`sk_autosave_log`
     是「上一趟另存没成的原因」，两者都再没有读者。库根本身改由 `sk_local_dir` 那**一个**目录承担，
     它是代理要读的那份（localStorage → .data/sk_local_dir.json），不在这里。 */
  'sk_autosave', 'sk_autosave_log',
  /* 画布页删除（2026-10-24）：`canvas_index` 是画布的项目索引（标题 / 节点数 / 时间），
     画布的文档本体在 IndexedDB（canvas_db），那边跟着「清站点数据」走，不在这里清。
     索引键要在这里点名的原因和其它旧键一样：不删的话下次 boot 会从服务器镜像恢复回来。 */
  'canvas_index',
  /* 供应商那一排「按类型分档」的分段开关撤掉（2026-10-27）：一家账号一张卡，卡里列着它能开的每一档，
     所以「当前哪一档」这个状态本身没有了。不在这里点掉的话，那份镜像会在下次 boot 把它恢复回来。 */
  'sk_prov_tab',
  /* 浮窗「被拖走、此后不再跟球」的标记作废：浮窗只能随球挪，没有「拖走就不再跟」这一档。
     它要在这一张表里点名，而不是谁开机顺手 removeItem 一下：`ai_chat` 那一条前缀在 SYNCABLE 名单里，
     服务器上那份镜像不会被一次 localStorage 删除带走，下次对账又把它拉回来。 */
  'ai_chat_fxy',
  /* 「让 AI 给角色定音色」那一枚设置项整族作废（2026-10-27）：这一条从来没有被任何一处生成
     路径读过 —— 界面上画了一颗能点的勾选框，扣下去什么也不会变（正是 chars.js 顶部注释
     「提示说会、其实没发」那一条禁令所禁止的形状）。
     `dr_ai_voice` 是 2026-10 换前缀之前的旧名，`char_ai_voice` 是换到前缀之后的名字，两份都清。 */
  'dr_ai_voice', 'char_ai_voice',
  /* 素材库的「紧凑 / 列表」视图开关撤掉（2026-10-28）：这一页只剩紧凑网格。
     `dir_char_view` 是那个开关的偏好，不再有人读；镜像里那份也要一起清。 */
  'dir_char_view',
  /* 余额卡「就地展开」那一档偏好撤掉（2026-10-29）：卡列表现在恒为全量、定高三张自己滚，
     不再有「展开 / 收起」这个状态。`sb_bal_exp` 不再有人读，留着只会在盘上攒一串死数据。 */
  'sb_bal_exp',
  /* 浏览器那份「本机镜像指针」撤掉（2026-10-30）：哪条产物在本机改由代理的别名表说了算
     （`/local-assets/aliases` / `/local-assets/locate`），页面只留一份内存表。
     `sk_local_mirror` 是那张表在 localStorage 的暖缓存，盘上那份留着没人读；
     库本体 `mirror_db` 由 LEGACY_IDB 整库删。 */
  'sk_local_mirror',
];
async function sweepLegacyKeys() {
  if (!window.Store || !Store.available) return;
  const hit = LEGACY_KEYS.filter(k => { try { return localStorage.getItem(k) != null; } catch { return false; } });
  if (!hit.length) return;
  for (const k of hit) window.LS.del(k);
  /* 镜像那份也删：留着的话下次 boot 会把它当「服务器上有更新的数据」恢复回 localStorage。 */
  for (const k of hit) {
    try { await Net.fetch('/data/' + encodeURIComponent(k) + '?nobak=1', { method: 'DELETE', timeout: 8000, retry: 0 }); } catch (e) { /* 镜像删不掉下次 boot 顶多再清一遍，不拦本机这次的清理 */ }
  }
  console.info('[Store] 清掉了几个不再使用的旧键：' + hit.join('、'));
}

/* IndexedDB 里的同一类残留：整库随页作废的（画布页删除后的 canvas_db），不再进 Kv 登记表，
   登记表读不到它，只能在这里点名 deleteDatabase。库没有活跃连接时立即删掉，
   有连接时浏览器等连接关了再删（画布页已删，不会再有连接）；删不掉就下次 boot 再来一遍，幂等。
   `mirror_db` 是同一类：本机镜像指针改由代理别名表承担，浏览器这一份整库作废。 */
const LEGACY_IDB = ['canvas_db', 'mirror_db'];
function sweepLegacyDbs() {
  if (typeof indexedDB === 'undefined') return;
  for (const name of LEGACY_IDB) {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => console.info('[Store] 清掉了不再使用的旧库：' + name);
      req.onerror = () => { /* 删不掉不拦 boot：下次开机再清一遍 */ };
    } catch (e) { /* 隐私模式拿不到 indexedDB：那份残留本来也存不下 */ }
  }
}

/* ---------- 本机存储：裸 localStorage 的唯一包装 ----------
   `Store` 管的是「带信封、有上限、会同步」的那一份；这里只收字符串 / JSON 的读写，
   并把「隐私模式 / 配额满 / 读坏了」统一变成返回值，页面不再各写一层 try。
   静态判据（tests/static-guards.cjs）要求 web/ 里的 localStorage 读写都在 try 里或经这一份。 */
window.LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? (d === undefined ? null : d) : v; } catch (e) { return d === undefined ? null : d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } },
  json(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  /* 键清单也走这一份：隐私模式下 `localStorage` 一读就抛，遍历要能退化成空表。
     拿到的是一次快照，边遍历边删不受影响（遍历 `localStorage.key(i)` 会因下标前移漏键）。 */
  keys() { try { return Object.keys(localStorage); } catch (e) { return []; } },
};

/* ---------- 跨标签页广播：storage 事件的唯一入口 ----------
   keys 为 null = 任意键；fn 抛错不影响别的订阅者。返回退订函数（页面卸载时调用）。 */
window.StorageBus = {
  on(keys, fn) {
    const set = keys ? new Set(keys) : null;
    const h = e => {
      if (!e || !e.key) return;
      if (set && !set.has(e.key)) return;
      try { fn(e); } catch (err) { console.warn('[StorageBus]', err); }
    };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  },
};

/* ---------- 程序性 focus 不许抢视口（全站只此一份） ----------
   拿 focus() 只是为了「把光标续上」时，浏览器会把那一格**滚进视野** ——
   用户明明在看别处，视角却被拽走（用户报过：点一颗按钮，页面就跳回最上面）。
   规矩：一律带 { preventScroll: true }；
   真要「把某处滚过来」走滚动那一族（scrollIntoView），别拿 focus 当滚动用。
   页面与公共件都调它，不各写一遍 try/catch。 */
window.focusQuiet = function focusQuiet(el) {
  if (!el || typeof el.focus !== 'function') return false;
  try { el.focus({ preventScroll: true }); return true; }
  catch (e) {
    /* 老浏览器不认 preventScroll：这时宁可别抢视口，也别把整页拽走 */
    try { el.focus(); return true; } catch (e2) { return false; }
  }
};
