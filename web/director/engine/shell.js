/* 导演台Shell域：整屏重画的三个入口（renderSoft 让路打字中的栏、renderAll 立刻、updateProjUI 只刷页头）
   与页头那份项目菜单（按项目组分树、就地改名 / 移组 / 新建组 / 删短片 / 展开折叠 / 项目文件那一组）。
   区间内的代码由 engine.js 逐字搬出；proj / WS / Gen 走访问器（engine 继续持有这几枚可变状态），
   渲染 / 保存那几个入口在建包这一刻都已就绪；document / window 用参数名遮蔽全局。 */


export function createShell(E, document, window) {
  'use strict';
  const {
    $,
    GenOf,
    Groups,
    exportProjectPack,
    newShot,
    pickProjectPack,
    projOf,
    wsOf,
    setProj,
    refreshEst,
    releaseCandUrl,
    renderEditor,
    renderMid,
    renderScenes,
    scheduleSave,
    setStatus,
    uid,
    updateBanner,
    wsKv,
  } = E;

/* ---------- 全局渲染 ---------- */
/* 轮询 / 长任务的后台刷新走 renderSoft：正在编辑的栏先跳过（重建会把输入框换掉，焦点和光标全丢），
   焦点离开后再补一次渲染，避免内容长期不更新。用户主动操作仍用 renderAll，立刻生效。 */
let renderPending = false;
function editingIn(sel) {
  const ae = document.activeElement;
  return !!(ae && ae !== document.body && ae.closest && ae.closest(sel));
}
/* 「正在打字」比「焦点在这一栏」窄一档：textarea 与文本类输入（输入法可能正在拼字）。
   滑块 / 复选 / 下拉那些离散控件不算 —— 它们要的是立刻重画，等失焦反而像没生效。 */
function typingIn(sel) {
  const ae = document.activeElement;
  if (!ae || !ae.closest || !ae.closest(sel)) return false;
  if (ae.tagName === 'TEXTAREA' || ae.isContentEditable) return true;
  if (ae.tagName !== 'INPUT') return false;
  const t = String(ae.type || 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t);
}
let forceMid = false;
function renderSoft(what) {
  const cols = what || ['scenes', 'mid', 'edit'];
  if (cols.includes('scenes')) { if (editingIn('.col-left')) renderPending = true; else renderScenes(); }
  if (cols.includes('mid')) {
    if (forceMid) { forceMid = false; renderMid(); }          // 刚有候选出结果：立刻显示，不等失焦
    else if (editingIn('#midCol')) renderPending = true;
    else renderMid();
  }
  if (cols.includes('edit')) { if (editingIn('#edCol')) renderPending = true; else renderEditor(); }
  updateBanner(); updateProjUI();
}
document.addEventListener('focusout', () => {
  if (!renderPending) return;
  setTimeout(() => {
    if (!renderPending) return;
    if (!editingIn('.col-left') && !editingIn('#midCol') && !editingIn('#edCol')) { renderPending = false; renderAll(); }
  }, 150);
});
function renderAll() { renderPending = false; renderScenes(); renderMid(); renderEditor(); updateBanner(); updateProjUI(); }
function updateProjUI() {
  /* 页头那一格只报「现在是哪一部」；改名走这颗按钮点开的那份菜单里的就地编辑。 */
  $('projLabel').textContent = projOf().name || '未命名短片';
  $('projSwitch').title = (projOf().name || '未命名短片') + ' · 切换短片 / 分组与改名';
  refreshEst();
  /* 「生成全部分镜」的文案与可用状态跟镜头增删、型号、条数一起变：去抖在它自己那一份里，
     重复调用只是排一次定时器。 */
  GenOf().refreshGenAllBtn();
}
/* 项目菜单：按**项目组**分树（组 → 组内的短片 → 未分组）。
   组名即素材组名（见 web/director/groups.js）。组的判据全在那个模块里，这里只画。
   这一份菜单里每一步都在原地做完：改名把名称那一格换成输入框、移组在那一行下面摊开一个下拉、
   删除走公共的 `Confirm.arm` 就地二次确认 —— 不弹表单窗，也不弹确认框。 */
/* 就地编辑态（界面状态，不写进工程数据，菜单一收就清）：
   pmEdit  'p:<id>' | 'g:<id>' —— 哪一格正在改名
   pmMove  短片 id —— 哪一行摊开了移组下拉
   pmNew   新建项目组的草稿开没开
   pmSync  { key, oldName, newName, n } —— 改组名之后对素材库那一组的追问挂在哪个组下面
   pmIOOpen —— 底部「项目文件」那一组是不是摊开了。
   pmIOSplitOpen —— 导出拆分按钮的尾钮摊开没（当前项目组短片 / 全部短片）。
   跟着菜单一起复位：每次重新打开短片菜单都是**默认折叠**的那一屏。 */
let pmEdit = '', pmMove = '', pmNew = false, pmSync = null;
let pmIOOpen = false, pmIOSplitOpen = false;
function clearProjMenuStates() {
  pmEdit = ''; pmMove = ''; pmNew = false; pmSync = null;
  pmIOOpen = false; pmIOSplitOpen = false;
}
function findProj(id) { return wsOf().projects.find(x => x && x.id === id); }
/* 改组名之后素材库那一组要不要一起改？
   **不自动改**：素材库是用户数据，那一组可能还有别的来源（同名的组在别的短片里也在用）。
   原位问一次，点了才动；改素材组的落点只有 `Chars.Lib.renameGroup` 一处。 */
function assetGroupCountOf(oldName) {
  const D = window.Chars;
  if (!D || !D.Lib || !D.Lib.renameGroup || !D.Lib.groupMatch) return 0;
  return (D.Lib.list() || []).filter(c => c && D.Lib.groupMatch(c, oldName)).length;
}
function resolveAssetGroupSync(apply) {
  const s = pmSync; pmSync = null;
  if (!s) return;
  if (!apply) {
    setStatus('<span class="ok">✓ 项目组已改名为「' + esc(s.newName) + '」；素材库那一组还叫「' + esc(s.oldName) + '」</span>');
    renderProjMenu(); return;
  }
  const D = window.Chars;
  const r = D && D.Lib ? D.Lib.renameGroup(s.oldName, s.newName) : null;
  renderProjMenu();
  if (r && r.why) { Toast.warn(r.why); return; }
  setStatus('<span class="ok">✓ 项目组已改名为「' + esc(s.newName) + '」，素材库那一组 ' + ((r && r.n) || 0) + ' 条也改了</span>');
}
/* 项目组的展开 / 收起是界面状态，不写进工程数据：按组 id 记在本机，
   组名改掉、短片移走都不影响它。未分组用 __none 这个键。 */
const K_PROJ_FOLD = 'dir_proj_fold';
let foldedProjGroups = new Set();
try {
  const saved = window.LS.json(K_PROJ_FOLD, []);
  if (Array.isArray(saved)) foldedProjGroups = new Set(saved.map(String));
} catch (e) { /* 读不到就全部展开 */ }
function saveProjFold() {
  try { window.LS.setJson(K_PROJ_FOLD, [...foldedProjGroups]); } catch (e) { /* 写不进去，本次会话仍然有效 */ }
}
function toggleProjFold(key) {
  if (foldedProjGroups.has(key)) foldedProjGroups.delete(key); else foldedProjGroups.add(key);
  saveProjFold();
  renderProjMenu();
}
function renderProjMenu() {
  const menu = $('projMenu');
  const tree = Groups.tree(wsOf());
  const gCount = Groups.list(wsOf()).length;
  /* 重画前先把开着的下拉收掉：浮层挂在 body 上、不跟着这次 innerHTML 一起消失，
     留着就会对着一个已经不在的按钮浮在半空（折叠、换一行、删掉那一行都会走到这里）。 */
  if (window.Dropdowns) window.Dropdowns.closeAll();
  /* 整栏重建罩在公共件里：`#projMenu` 自己就是那只 `max-height:60vh` 的滚动容器，`innerHTML =`
     之后一路 appendChild 把行重新造一遍，滚动位在清空那一刻夹回 0 —— 表现是「滚到列表底下挑短片，
     一次改名 / 移组 / 删除之后弹回栏顶」。 */
  Wb.viewport.keep(menu, () => {
    menu.innerHTML = '<div class="pm-head">共 ' + wsOf().projects.length + ' 个短片'
      + (gCount ? ' · ' + gCount + ' 个项目组' : '') + '</div>';
    /* 就地改名的一格：输入框 + 保存 / 取消，画在名称那一格原来的位置上（行本身不换）。
       Enter 保存、Esc 收回；焦点给公共件（focusQuiet 不抢视口），选中整名方便直接改。 */
    const editCells = (cur, commit) => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'pm-edit'; inp.value = cur; inp.autocomplete = 'off';
      inp.title = '改完按回车保存 · Esc 取消';
      const back = () => { pmEdit = ''; renderProjMenu(); };
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'ghost mini'; ok.textContent = '保存';
      ok.onclick = e => { e.stopPropagation(); pmEdit = ''; commit(inp.value); };
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ghost mini'; no.textContent = '取消';
      no.onclick = e => { e.stopPropagation(); back(); };
      inp.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pmEdit = ''; commit(inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); }
      };
      /* 点击不许冒到行上：那一行点下去是「切到这部短片」，编辑时点它等于顺手切走。 */
      inp.onclick = e => e.stopPropagation();
      requestAnimationFrame(() => { window.focusQuiet(inp); inp.select(); });
      return [inp, ok, no];
    };
    /* 摊在短片那一行下面的移组下拉：选一处就归位（当前那一组是预选值），不另写标签行。
       原生 <select> 只当数据源，外观与浮层交给公共件 Dropdowns —— 这一排不另画一串去处按钮。
       这一格的稳定键另起一个前缀：与它上面那一行共用 `data-id` 会让还位认不清该还哪一格。 */
    const moveBox = p => {
      const box = document.createElement('div');
      box.className = 'pm-move';
      box.setAttribute('data-key', 'mv:' + p.id);
      const sel = document.createElement('select');
      sel.className = 'pm-gsel';
      sel.title = '选一个项目组，这部短片就移过去';
      const add = (id, name) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = name;
        sel.appendChild(o);
      };
      add('', '未分组');
      Groups.list(wsOf()).forEach(g => add(g.id, g.name));
      sel.value = p.groupId || '';
      sel.onchange = () => {
        const id = sel.value;
        const hit = id ? Groups.list(wsOf()).find(g => g.id === id) : null;
        const name = id ? ((hit && hit.name) || '') : '未分组';
        pmMove = '';
        if ((p.groupId || '') === id) { renderProjMenu(); return; }
        Groups.assign(wsOf(), p.id, id);
        renderProjMenu(); renderAll(); scheduleSave();
        setStatus('<span class="ok">✓ 已把「' + esc(p.name) + '」移到「' + esc(name) + '」</span>');
      };
      box.appendChild(sel);
      if (window.Dropdowns) { window.Dropdowns.build(box); window.Dropdowns.sync(sel); }
      /* 原生 select 是 display:none，那句话挂在它上面永远露不出来；没有可见标签之后，
         说明挂到真正被点的 `.dd-btn` 上。 */
      const btn = box.querySelector('.dd-btn');
      if (btn) btn.title = sel.title;
      return box;
    };
    /* 改组名之后挂在组头下面的追问：素材库那一组要不要一起改名。 */
    const syncBox = () => {
      const box = document.createElement('div');
      box.className = 'pm-note';
      const t = document.createElement('span');
      t.textContent = '素材库里 ' + pmSync.n + ' 条还挂在旧组名「' + pmSync.oldName + '」，要一起改吗？';
      box.appendChild(t);
      const yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'ghost mini'; yes.textContent = '一起改';
      yes.onclick = e => { e.stopPropagation(); resolveAssetGroupSync(true); };
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ghost mini'; no.textContent = '不用';
      no.onclick = e => { e.stopPropagation(); resolveAssetGroupSync(false); };
      box.appendChild(yes); box.appendChild(no);
      return box;
    };
    const projRow = (p, inGroup) => {
      const row = document.createElement('div');
      row.className = 'pm-row' + (p.id === wsOf().curId ? ' sel' : '') + (inGroup ? ' pm-in-group' : '');
      /* 行身份给公共件：折叠 / 移组 / 删除会让「第 i 格」换人，只按下标还位会把视野还到别的短片上。 */
      row.setAttribute('data-id', p.id);
      if (pmEdit === 'p:' + p.id) {
        editCells(p.name, v => commitProjName(p, v)).forEach(el => row.appendChild(el));
        return row;
      }
      const n = (p.scenes || []).reduce((a, s) => a + (s.shots || []).length, 0);
      row.innerHTML = `<span class="pm-name">${esc(p.name)} <span class="pm-cnt">· ${n} 镜</span></span>
        <span class="pm-ops">
          <button type="button" class="pm-btn" data-move="${p.id}" title="移到别的项目组">${icon('folder', 13)}</button>
          <button type="button" class="pm-btn" data-rename="${p.id}" title="重命名这个短片">${icon('pencil', 13)}</button>
          <button type="button" class="pm-btn danger" data-del="${p.id}" title="删除这个短片">${icon('trash', 13)}</button>
        </span>`;
      row.onclick = e => { if (e.target.closest('.pm-btn')) return; switchProject(p.id); menu.hidden = true; };
      return row;
    };
    tree.forEach(g => {
      /* 组头：折叠 + 组名 + 几部短片 + 改名 / 删组。
         删组只把组内的短片退回未分组，**不删短片** —— 删组是整理，不是删作品。 */
      const key = g.kind === 'none' ? '__none' : g.id;
      const folded = foldedProjGroups.has(key);
      const editing = g.kind !== 'none' && pmEdit === 'g:' + g.id;
      const head = document.createElement('div');
      head.className = 'pm-group' + (g.kind === 'none' ? ' none' : '') + (folded ? ' folded' : '');
      head.setAttribute('data-gid', key);
      head.innerHTML = (g.items.length
        ? `<button class="pm-gfold" type="button" data-gfold="${esc(key)}" aria-expanded="${!folded}" title="${folded ? '展开这个项目组' : '收起这个项目组'}">${icon(folded ? 'chevronDown' : 'chevronUp', 12)}</button>`
        : '<span class="pm-gfold" aria-hidden="true"></span>')
        + (editing ? '' : `<span class="pm-gname">${esc(g.name)}</span>
        <span class="pm-cnt">· ${g.items.length} 部</span>
        <span class="pm-ops">
          ${g.kind === 'none' ? '' : `<button type="button" class="pm-btn" data-grename="${g.id}" title="重命名这个项目组">${icon('pencil', 13)}</button>
          <button type="button" class="pm-btn danger" data-gdel="${g.id}" title="删掉这个项目组（组里的短片退回未分组，不会被删）">${icon('trash', 13)}</button>`}
        </span>`);
      if (editing) editCells(g.name, v => commitGroupName(g, v)).forEach(el => head.appendChild(el));
      head.onclick = e => {
        if (!g.items.length || e.target.closest('.pm-btn') || e.target.closest('[data-gfold]')) return;
        toggleProjFold(key);
      };
      const fold = head.querySelector('[data-gfold]');
      if (fold) fold.onclick = e => { e.stopPropagation(); toggleProjFold(key); };
      menu.appendChild(head);
      if (pmSync && pmSync.key === key) menu.appendChild(syncBox());
      if (!folded) g.items.forEach(it => {
        menu.appendChild(projRow(it.p, g.kind !== 'none'));
        if (pmMove === it.p.id) menu.appendChild(moveBox(it.p));
      });
    });
    /* 底部两行（新建组 / 新建短片）也在这趟里长出来：keep 还位发生在回调返回那一刻，
       拖到外面 append 的话还位量到的是「还没有这两行」的高度，夹算就矮了一截。 */
    const gAdd = document.createElement('div');
    if (pmNew) {
      /* 新建项目组 = 菜单里的一行草稿，不弹表单窗。 */
      gAdd.className = 'pm-newg';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'pm-edit'; inp.autocomplete = 'off'; inp.placeholder = '新项目组名称';
      inp.title = '组名同时是素材库里的分组名，拆分镜的新素材会落进同名组\n改完按回车建组 · Esc 取消';
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'ghost mini'; ok.textContent = '建组';
      ok.onclick = e => { e.stopPropagation(); createProjGroup(inp.value); };
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ghost mini'; no.textContent = '取消';
      no.onclick = e => { e.stopPropagation(); pmNew = false; renderProjMenu(); };
      inp.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); createProjGroup(inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pmNew = false; renderProjMenu(); }
      };
      gAdd.appendChild(inp); gAdd.appendChild(ok); gAdd.appendChild(no);
      requestAnimationFrame(() => window.focusQuiet(inp));
    } else {
      gAdd.className = 'pm-add';
      gAdd.textContent = '＋ 新建项目组';
      gAdd.onclick = () => { pmNew = true; renderProjMenu(); };
    }
    menu.appendChild(gAdd);
    const addRow = document.createElement('div');
    addRow.className = 'pm-add';
    addRow.textContent = '＋ 新建短片';
    addRow.onclick = () => {
      /* 名字按**同组**里的序号往下排：一组里连点几次「新建短片」不会得到一排同名的
         「未命名短片」，菜单里分得出谁是谁。序号判据在 groups.js（纯件）。 */
      const gid = (projOf() && projOf().groupId) || '';
      const p = { id: uid(), name: Groups.nextProjectName(wsOf(), gid, Groups.DEFAULT_PROJECT_NAME),
        scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] };
      /* 新短片默认落在**当前短片所在的组**里 —— 同一组的短片才共享素材。 */
      if (gid) p.groupId = gid;
      wsOf().projects.push(p);
      switchProject(p.id);
      menu.hidden = true;
    };
    menu.appendChild(addRow);
    /* 项目文件那一组也长在这一趟重画里：放到 keep 回调外面 append 的话，
       视口还位量到的是「还没有这几行」的高度，菜单滚到底时会被夹回去。
       **默认折叠**：底部只留一行开关，摊开是两颗**同级**入口 ——
       导出（拆分按钮）与导入项目文件，同一套 .pm-io 行、同样的图标位与右对齐 hint。
       拆分按钮：左半就是「导出当前短片」，行尾那枚 chevron 是**独立一格热区**，摊开范围更大的
       「导出当前项目组短片 / 导出全部短片」—— 它们才是导出的次级，所以缩进在左侧细线里，
       窄范围在前、全量在后；导入不是导出的子项，留在同一级，别让它看起来低一级。
       用自家的 .pm-io* 一类而不是 .pm-add —— 那边「＋ 新建项目组」是按 pm-add 数出来点的。 */
    const ioBox = document.createElement('div');
    ioBox.className = 'pm-io-box';
    const ioToggle = document.createElement('div');
    ioToggle.className = 'pm-io-toggle';
    ioToggle.setAttribute('role', 'button');
    ioToggle.tabIndex = 0;
    ioToggle.setAttribute('aria-expanded', pmIOOpen ? 'true' : 'false');
    ioToggle.title = '项目文件：展开 / 收起导入导出';
    ioToggle.innerHTML = icon('box', 13) + '<span class="pm-io-name">项目文件 · 导入 / 导出</span>'
      + icon(pmIOOpen ? 'chevronUp' : 'chevronDown', 12);
    const toggleIO = e => {
      if (e) e.stopPropagation();
      pmIOOpen = !pmIOOpen;
      pmIOSplitOpen = false;          // 收起这一组，尾钮也跟着收回到默认那一屏
      renderProjMenu();
    };
    ioToggle.onclick = toggleIO;
    ioToggle.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleIO(e); } };
    ioBox.appendChild(ioToggle);
    if (pmIOOpen) {
      /* 摊开的内容整组缩进一条竖线里（`.pm-io-body`）：这几行长在「项目文件 · 导入 / 导出」
         下面，不是与上面那串短片行同级 —— 光靠缩进还不够，竖线才是层级的那条边。 */
      const ioBody = document.createElement('div');
      ioBody.className = 'pm-io-body';
      /* 两套行：`.pm-io` 是同级入口（导出主钮 / 导入），`.pm-io-sub .pm-io` 是拆分按钮摊开的次级。
         两者字型、行高、内边距一致；次级只多一条缩进细线，因此导入与导出看起来仍是一级。 */
      const ioRow = (label, hint, glyph, act, off) => {
        const row = document.createElement('div');
        row.className = 'pm-io' + (off ? ' pm-io-off' : '');
        row.innerHTML = icon(glyph, 13) + '<span class="pm-io-name">' + esc(label) + '</span>'
          + '<span class="pm-io-hint">' + esc(hint) + '</span>';
        row.title = label + '（' + hint + '）';
        if (off) {
          /* 当前短片没归组时「按项目组导出」没有范围：留着这一格（位置稳定、人也知道少了什么），
             但标成不可用，点一下把原因说清楚。 */
          row.setAttribute('aria-disabled', 'true');
          row.title = label + '：当前短片还没归入项目组';
          row.onclick = e => {
            e.stopPropagation();
            $('projMenu').hidden = true;
            setStatus('<span class="err">当前短片还没归入项目组：先把它归到一个组，才能按组导出</span>');
          };
          return row;
        }
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.onclick = e => { e.stopPropagation(); act(); };
        row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } };
        return row;
      };
      /* 当前短片所在的项目组 —— 范围就是同组的那些短片（组名即素材组名，见 groups.js）。 */
      const grp = Groups.groupOf(wsOf(), projOf());
      const grpN = grp ? wsOf().projects.filter(p => p && p.groupId === grp.id).length : 0;
      const split = document.createElement('div');
      split.className = 'pm-io pm-io-split';
      const main = document.createElement('div');
      main.className = 'pm-io-main';
      main.setAttribute('role', 'button');
      main.tabIndex = 0;
      main.title = '导出当前短片的完整工程（.json）';
      main.innerHTML = icon('download', 13) + '<span class="pm-io-name">导出当前短片</span>'
        + '<span class="pm-io-hint">.json</span>';
      const doCurrent = e => { if (e) e.stopPropagation(); exportProjectPack('current'); };
      main.onclick = doCurrent;
      main.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCurrent(e); } };
      const more = document.createElement('div');
      more.className = 'pm-io-more';
      more.setAttribute('role', 'button');
      more.tabIndex = 0;
      more.setAttribute('aria-expanded', pmIOSplitOpen ? 'true' : 'false');
      more.setAttribute('aria-label', '更多导出范围');
      more.title = '更多导出范围：当前项目组短片 / 全部短片';
      more.innerHTML = icon('chevronDown', 12);
      const toggleMore = e => {
        if (e) e.stopPropagation();
        pmIOSplitOpen = !pmIOSplitOpen;
        renderProjMenu();
      };
      more.onclick = toggleMore;
      more.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMore(e); } };
      split.appendChild(main); split.appendChild(more);
      ioBody.appendChild(split);
      if (pmIOSplitOpen) {
        const sub = document.createElement('div');
        sub.className = 'pm-io-sub';
        sub.appendChild(ioRow('导出当前项目组短片', grp ? grp.name + ' · ' + grpN + ' 部' : '当前短片未归组', 'folder',
          () => exportProjectPack('group'), !grp));
        sub.appendChild(ioRow('导出全部短片', wsOf().projects.length + ' 部', 'box',
          () => exportProjectPack('all')));
        ioBody.appendChild(sub);
      }
      ioBody.appendChild(ioRow('导入项目文件', '追加为新短片', 'upload', () => pickProjectPack()));
      ioBox.appendChild(ioBody);
    }
    menu.appendChild(ioBox);
  });
  /* 摊开的移组下拉在视口还位之后再打开：浮层按按钮的视口坐标定点，
     重画中途就打开会摆到「还没还位」的那一版位置上。点「文件夹」就是来看去哪一组的，
     所以这里替用户多点一下，不必再点开下拉本身。 */
  if (pmMove) {
    const gsel = menu.querySelector('.pm-move select');
    if (gsel && window.Dropdowns) window.Dropdowns.open(gsel);
  }
  /* 就地移组：点「文件夹」在那一行下面摊开下拉，再点一次收回。 */
  menu.querySelectorAll('[data-move]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (!findProj(b.dataset.move)) return;
    pmMove = pmMove === b.dataset.move ? '' : b.dataset.move;
    renderProjMenu();
  });
  /* 就地改名：把名称那一格换成输入框，焦点直接进去。 */
  menu.querySelectorAll('[data-rename]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (!findProj(b.dataset.rename)) return;
    pmEdit = 'p:' + b.dataset.rename;
    renderProjMenu();
  });
  menu.querySelectorAll('[data-grename]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    pmEdit = 'g:' + b.dataset.grename;
    renderProjMenu();
  });
  /* 删组：就地二次确认（公共 `Confirm.arm`）—— 第一下把按钮变成「确认删除？」，第二下才真删。
     删组只把组内短片退回未分组，一条作品都不动。 */
  menu.querySelectorAll('[data-gdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const g = Groups.list(wsOf()).find(x => x.id === b.dataset.gdel);
    if (!g) return;
    const n = (wsOf().projects || []).filter(p => p && p.groupId === g.id).length;
    if (Confirm.arm(b, '确认删除？', { note: n ? `组里的 ${n} 部短片退回未分组，不会被删掉` : '这个组里没有短片' })) return;
    Groups.remove(wsOf(), g.id);
    if (pmSync && pmSync.key === g.id) pmSync = null;
    renderProjMenu(); renderAll(); scheduleSave();
    setStatus('<span class="ok">✓ 已删掉项目组「' + esc(g.name) + '」（' + n + ' 部短片退回未分组）</span>');
  });
  /* 删短片：同样是就地二次确认，第二下才走 deleteProject。 */
  menu.querySelectorAll('[data-del]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const pp = findProj(b.dataset.del);
    if (!pp) return;
    const shots = (pp.scenes || []).reduce((a, s) => a + (s.shots || []).length, 0);
    if (Confirm.arm(b, '确认删除？', { note: `这部短片的 ${shots} 个镜头一起删掉，无法恢复`, key: 'p:' + pp.id })) return;
    deleteProject(pp.id);
  });
}
/* 改短片名：空名不改（保持原样），改完把页头那一格与右栏一起刷过去。 */
function commitProjName(p, v) {
  const nm = String(v || '').trim();
  if (nm) p.name = nm;
  renderProjMenu(); renderAll(); scheduleSave('改短片名');
}
/* 改组名：组名就是素材组名，所以素材库那边同名的一组会被牵动。
   改完当场在原位问一次（`pmSync`），问了才动 —— 素材库是用户数据。 */
function commitGroupName(g, v) {
  const nm = String(v || '').trim();
  const r = nm && nm !== g.name ? Groups.rename(wsOf(), g.id, nm) : null;
  if (r) {
    const n = assetGroupCountOf(r.old);
    if (n) pmSync = { key: r.id, oldName: r.old, newName: r.name, n };
    renderAll(); scheduleSave();
  }
  renderProjMenu();
}
/* 新建项目组：建完把当前短片归进去 —— 用户「建一个组」多半就是为了归这一部。 */
function createProjGroup(v) {
  const nm = String(v || '').trim();
  if (!nm) { renderProjMenu(); Toast.warn('先给这个组起个名字'); return; }
  pmNew = false;
  const g = Groups.ensure(wsOf(), nm);
  if (!g) { renderProjMenu(); return; }
  if (projOf() && projOf().id) Groups.assign(wsOf(), projOf().id, g.id);
  renderProjMenu(); renderAll(); scheduleSave();
  setStatus('<span class="ok">✓ 已建项目组「' + esc(g.name) + '」' + (projOf() ? '，当前短片已放进去' : '') + '</span>');
}
/* 删掉一部短片：连带清掉它引用的本地视频 blob，最后一部删完补一条空白短片。 */
function deleteProject(id) {
  const pp = findProj(id);
  if (!pp) return;
  try {
    (pp.scenes || []).forEach(sc2 => (sc2.shots || []).forEach(sh2 => (sh2.candidates || []).forEach(c => {
      if (c && c.provider === 'local' && c.blobKey) { releaseCandUrl(c); wsKv.del(c.blobKey).catch(() => {}); }
    })));
  } catch { /* 清不动 blob 不拦删短片：键留在 IndexedDB 里由 sweep 收 */ }
  wsOf().projects = wsOf().projects.filter(x => x.id !== id);
  if (!wsOf().projects.length) {
    wsOf().projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  if (wsOf().curId === id) wsOf().curId = wsOf().projects[0].id;
  if (pmMove === id) pmMove = '';
  if (pmEdit === 'p:' + id) pmEdit = '';
  switchProject(wsOf().curId);
  renderProjMenu();
  setStatus('<span class="ok">✓ 已删除短片「' + esc(pp.name) + '」</span>');
}
function switchProject(id) {
  /* 切走短片 = 这一批不该再往下投：还没开始的镜头直接停，正在提交的那一条按它自己的回包落定。
     `runGenAll` 里还会比对 `proj` 与 `WS.curId` 兜一次（双保险，不靠调用顺序）。 */
  if (GenOf().genAllRunning()) GenOf().abortGenAll('切换了短片');
  wsOf().curId = id;
  setProj(wsOf().projects.find(p => p.id === id) || wsOf().projects[0]);   // id 失效（导入/删除后）时回落到第一个，别直接抛错
  if (!projOf()) { wsOf().projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] }); setProj(wsOf().projects[0]); wsOf().curId = projOf().id; }
  projOf().curScene = 0; projOf().curShot = 0; projOf().curCand = 0;
  renderAll(); scheduleSave();
}

  /* 这两枚是模块自己的界面状态；engine 那边（filmEdited / 生成回执与失焦补画）只经 setter 改它。 */
  function setRenderPending(v) { renderPending = !!v; }
  function setForceMid(v) { forceMid = !!v; }

  return {
    clearProjMenuStates,
    renderAll,
    renderProjMenu,
    renderSoft,
    setForceMid,
    setRenderPending,
    switchProject,
    typingIn,
    updateProjUI,
  };
}
