/* 导演台项目文件域：完整工程的导出（当前短片 / 当前项目组 / 全部）与导入（格式闸门、
   重复内容与重名组两问、追加为新短片、按旧 la_ 号重绑本机素材、按组名认领项目组）。
   区间内的代码由 engine.js 逐字搬出；proj / WS / Gen / wsLoaded 走访问器
   （engine 继续持有这几枚可变状态），document / window 用参数名遮蔽全局。 */

import { buildProjectPack, assertProjectPack, describeProjectPack, prepareProjectPackImport,
  scanProjectPackConflicts } from '../project-pack.js';

export function createProjectFile(E, document, window) {
  'use strict';
  const {
    $,
    GenOf,
    Groups,
    clearProjMenuStates,
    projOf,
    renderProjMenu,
    sanitize,
    scheduleSave,
    setStatus,
    switchProject,
    uid,
    wsLoadedOf,
    wsOf,
  } = E;

/* ---------- 项目文件：导出 / 导入完整工程 ----------
   页头那四种导出只带「选中的画面」，是成片或给剪辑软件的交换文件；这里带的是作品本身：
   每一镜的全部候选、提示词与台词、参考图、选用 / 裁剪 / 锁定、成片轨、画幅、项目组名。
   格式闸门与清洗在 web/director/project-pack.js（纯件），下面三个函数只管取文件与放回工作区。 */
/* scope：'current' 当前短片 / 'all' 工作区全部 / 'group' 当前短片所在的项目组。
   早先这里是布尔（true = 全部），留着兼容老调用点。 */
function exportProjectPack(scope) {
  const mode = scope === true ? 'all' : (scope || 'current');
  try {
    const grp = Groups.groupOf(wsOf(), projOf());
    if (mode === 'group' && !grp) throw new Error('当前短片还没归入项目组，按组导出没有范围可用');
    const list = mode === 'all' ? wsOf().projects
      : mode === 'group' ? wsOf().projects.filter(p => p && p.groupId === grp.id)
        : [projOf()];
    if (!list.length) throw new Error('这个范围里没有短片可导出');
    const pack = buildProjectPack({
      projects: list,
      groupNameOf: p => Groups.assetGroupName(wsOf(), p),
      /* 每一枚 `/asset/la_xxx` 随包带上落点 / 体积 / 平台身份：新机器只拷视频文件、
         不搬索引时，导入端按它把旧号认回盘上那一份（项目文件纯件只收不管网络）。 */
      hintOf: u => (window.AssetLocal && AssetLocal.exportHintOf ? AssetLocal.exportHintOf(u) : null),
    });
    /* buildProjectPack 已经按形状校验过、并算好了 checksum —— 这里不再对着刚造出来的
       包重跑一遍 assert（那等于把几 MB 的 projects 再 stringify + 散列一次，纯白费）。 */
    const s = pack.stats;
    const base = mode === 'all' ? '全部短片'
      : mode === 'group' ? grp.name
        : (projOf().name || '未命名短片');
    const name = window.fileSafe(base, 60) + '-项目-' + window.fileStamp() + '.json';
    Net.save(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }), name);
    const media = s.localAssets + s.remoteUrls;
    const carried = media
      ? '；视频字节不在包里（' + (s.localAssets ? s.localAssets + ' 条本机素材' : '')
        + (s.localAssets && s.remoteUrls ? ' / ' : '') + (s.remoteUrls ? s.remoteUrls + ' 条平台地址' : '')
        + '，本机素材把视频文件放进新机器的资产库即可认回）'
      : '';
    const hinted = pack.media.length
      ? '；随包带了 ' + pack.media.length + ' 条本机素材线索，只拷视频文件也能认回旧本机号' : '';
    setStatus('<span class="ok">✓ 已交给浏览器下载：' + esc(name) + '（' + s.projects + ' 部短片'
      + (s.groups ? ' / ' + s.groups + ' 个项目组' : '') + ' / '
      + s.shots + ' 镜 / ' + s.candidates + ' 条候选 / '
      + (s.promptShots + s.promptCandidates + s.lines + s.notes) + ' 段提示词 / '
      + (s.clips + s.voices + s.captions + s.markers) + ' 段剪辑）' + carried + hinted + '</span>');
  } catch (e) {
    setStatus('<span class="err">导出项目文件没能完成：' + esc(errText(e)) + '</span>');
  } finally {
    $('projMenu').hidden = true;
  }
}
function pickProjectPack() {
  const input = $('projPackFile');
  $('projMenu').hidden = true;
  if (!input) { setStatus('<span class="err">项目文件选择器不在页面上</span>'); return; }
  input.value = '';                 // 同一份文件连选两次也要触发 change
  input.click();
}
$('projPackFile').onchange = async e => {
  const input = e.target;
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  if (!wsLoadedOf()) {
    setStatus('<span class="err">工作区还没装载完，稍等一下再导入项目文件</span>');
    return;
  }
  let pack, desc;
  try {
    pack = JSON.parse(await file.text());
    assertProjectPack(pack);        // 零写入闸门：任何一项不过，工作区一个字节都不动
    desc = describeProjectPack(pack);
  } catch (err) {
    setStatus('<span class="err">项目文件没能导入：' + esc(errText(err)) + '</span>');
    return;
  }
  /* ---- 两处冲突先问清楚，再走「追加为新短片」那一道确认 ----
     先问「重复的要不要再来一份」：全跳过的话就没有「落在哪个组」的问题了，
     组名那一问要按**真正会导进来**的那几部重新扫一遍。
     两件事都不能不问就替用户定：前者决定工作区里多不多一份，
     后者决定短片落在哪个组 —— 尤其「同一个包导了两遍」是最常见的那一种。 */
  const scanOpts = {
    nameKey: window.nameKey,
    localProjects: wsOf().projects,
    groupTaken: n => !!Groups.find(wsOf(), n),
  };
  let conflict;
  try {
    conflict = scanProjectPackConflicts(pack, scanOpts);
  } catch (err) {
    setStatus('<span class="err">项目文件没能导入：' + esc(errText(err)) + '</span>');
    return;
  }
  let skipIndexes = [];
  if (conflict.duplicates.length) {
    const n = conflict.duplicates.length;
    const sample = conflict.duplicates.slice(0, 3)
      .map(d => '《' + d.name + '》= 本机《' + d.sameAs + '》').join('；') + (n > 3 ? ' 等' : '');
    const pick = await Confirm.choose({
      title: '有内容完全一致的短片',
      sub: '按作品内容比对（不看名字与 id），包里这 ' + n + ' 部本机已经有了：' + sample,
      options: [
        { label: '跳过这 ' + n + ' 部', hint: '本机已经有一份，不再重复导入', value: 'skip' },
        { label: '仍然导入并重命名', hint: '包里这份照收，名字加「（导入）」后缀和本机那部分开', value: 'rename' },
      ],
    });
    if (pick == null) return;
    if (pick === 'skip') skipIndexes = conflict.duplicates.map(d => d.index);
  }
  if (skipIndexes.length && skipIndexes.length === pack.projects.length) {
    setStatus('<span class="ok">✓ 包里 ' + skipIndexes.length
      + ' 部短片与本机已有作品内容一致，按你的选择一部都没重复导入</span>');
    return;
  }
  let groupPolicy = 'merge';
  let groupHits = [];
  try {
    groupHits = scanProjectPackConflicts(pack, { ...scanOpts, skipIndexes }).groups;
  } catch (err) {
    setStatus('<span class="err">项目文件没能导入：' + esc(errText(err)) + '</span>');
    return;
  }
  if (groupHits.length) {
    const names = groupHits.map(g => '「' + g.name + '」（' + g.count + ' 部）').join('、');
    const pick = await Confirm.choose({
      title: '项目组重名：怎么落位？',
      sub: '包里这些组名本机已经有了：' + names,
      options: [
        { label: '并入现有同名组', hint: '短片直接放进本机那个组，不会新建组', value: 'merge' },
        { label: '给导入的组改名', hint: '导入的组加「（导入）」后缀，本机原有的组一个字节都不动', value: 'rename' },
      ],
    });
    if (pick == null) return;
    groupPolicy = pick === 'rename' ? 'rename' : 'merge';
  }
  const go = await Confirm.ask({
    title: '导入项目文件？', okLabel: '追加为新短片', cancelLabel: '取消',
    body: desc.text + (skipIndexes.length
      ? ' 其中 ' + skipIndexes.length + ' 部内容与本机一致，按你的选择跳过。' : ''),
  });
  if (!go) return;
  /* 追加，不覆盖：与本机已有短片撞 id 就换一枚、撞名字就加后缀，
     导入的每一部都是新的那一条，现有作品一部都不动。 */
  const prep = prepareProjectPackImport(pack, {
    uid,
    existingIds: wsOf().projects.map(p => p.id),
    nameTaken: n => wsOf().projects.some(p => p.name === n),
    nameKey: window.nameKey,
    groupTaken: n => !!Groups.find(wsOf(), n),
    groupPolicy,
    skipIndexes,
  });
  /* ---- 换机器只拷视频文件、不搬索引时：按包里的旧 la_ 号把盘上那一份认回来 ----
     代理这一跳只写账（一个字节都不下载）：按可移植尾标 / 相对落点 / 文件名+体积找文件，
     找到就把旧号与平台身份补进账。重绑失败不拦导入 —— 素材可能还没拷过来，
     之后开机磁盘对账与 `/asset/<旧号>` 那一问也会把它认回来。 */
  let rebound = 0, rebindOmitted = 0, rebindErr = '';
  if (prep.media.length) {
    try {
      const d = await Net.json('/local-assets/rebind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: prep.media }),
      });
      const got = (d && Array.isArray(d.rows)) ? d.rows.filter(Boolean) : [];
      /* learn 只把一行收进当前会话的别名表（行形状不对时自己返回 null），不必再吞一层异常。 */
      got.forEach(r => { if (window.AssetLocal && AssetLocal.learn) AssetLocal.learn(r); });
      rebound = got.length;
      /* 代理一次只处理有限条（见 local-assets-store 的 rebindBodies）：超出的照实报出来，
         不能让用户以为「全都认回了」。 */
      rebindOmitted = Math.max(0, Number(d && d.omitted) || 0);
      if (d && d.error) rebindErr = '索引没写成：' + d.error;
    } catch (e) { rebindErr = errText(e); }
  }
  /* 项目组跟着包一起回来，而且**只按组名认**（见 groups.js）：本机已有同名组就并进去，
     没有才新建 —— 同一份包导入两次不会得到两个「默认组」。组名同时是素材组名，
     并进现有组正是「同名就在那个组下添加」。
     分类用的「导入前有哪些组」要在 push 之前拍下来：循环里 ensure 会现建新组，
     事后再查就分不出哪个是本机原有的、哪个是这一趟建的。 */
  const hadGroups = new Set(Groups.list(wsOf()).map(g => window.nameKey(g.name)));
  const newGroups = new Set(), joinGroups = new Set();
  for (const it of prep.items) {
    wsOf().projects.push(it.project);
    if (!it.groupName) continue;
    const g = Groups.ensure(wsOf(), it.groupName);
    if (!g) continue;
    Groups.assign(wsOf(), it.project.id, g.id);
    (hadGroups.has(window.nameKey(g.name)) ? joinGroups : newGroups).add(g.name);
  }
  wsOf().curId = prep.items[0].project.id;
  /* 走页面自己的数据消毒（成片轨、游标、参考图地址都在那儿统一规整），不另写一份。 */
  sanitize();
  renderProjMenu();
  switchProject(wsOf().curId);
  scheduleSave('导入项目文件');
  /* 导入的短片里的候选此刻才进工作区：投一次自动镜像。开关关着时这一趟是空转
     （历史补扫不带 mustSave），开着才补齐 —— 与开机那一趟同一条路。 */
  try { GenOf().announceDoneCandidates(); } catch (e) { /* 补齐失败不拦导入回执 */ }
  const n = prep.notes;
  const tail = (newGroups.size ? '；新建 ' + newGroups.size + ' 个项目组（'
    + Array.from(newGroups).map(g => esc(g)).join('、') + '）' : '')
    + (joinGroups.size ? '；' + joinGroups.size + ' 个项目组并入了现有同名组' : '')
    + (n.renamedGroups ? '；' + n.renamedGroups + ' 个重名组改了名（'
      + n.groupRenames.map(r => esc(r.from) + ' → ' + esc(r.to)).join('、') + '）' : '')
    + (n.inFlight ? '；' + n.inFlight + ' 条在途生成已标为可重试' : '')
    + (n.deadUrls ? '；' + n.deadUrls + ' 条临时视频地址已清空' : '')
    + (rebound ? '；' + rebound + ' 份本机素材已按旧号认回，不用重新导入' : '')
    + (rebindOmitted ? '；另有 ' + rebindOmitted + ' 条素材线索超出单次重绑上限，再导入一次或刷新后可继续认回' : '')
    + (rebindErr ? '；本机素材重绑没成（' + esc(rebindErr) + '），视频拷进资产库后刷新一次' : '')
    + (n.mediaDropped ? '；' + esc(n.mediaDropped) : '')
    + (n.skipped ? '；' + n.skipped + ' 部内容与本机一致已跳过（'
      + esc(n.skippedNames.join('、')) + '）' : '')
    + (n.renamed ? '；' + n.renamed + ' 部短片因重名加了「（导入）」后缀' : '');
  setStatus('<span class="ok">✓ 已导入 ' + prep.items.length + ' 部短片（' + desc.shots + ' 镜 / '
    + desc.candidates + ' 条候选 / ' + desc.prompts + ' 段提示词），现有项目一部都没动' + tail + '</span>');
};
$('projSwitch').onclick = e => {
  e.stopPropagation();
  const menu = $('projMenu');
  const willHide = !menu.hidden;
  /* 收与开都从干净的一屏开始：编辑中的那一格、摊开的移组与追问都跟着菜单一起消失。 */
  clearProjMenuStates();
  if (window.Dropdowns) window.Dropdowns.closeAll();
  if (!willHide) renderProjMenu();
  menu.hidden = willHide;
};
document.addEventListener('click', e => {
  /* 判内外不能看 `e.target`：菜单里的每一步都会整栏重画，事件派发到 document 时那个目标
     多半已经从文档上摘下来了，`menu.contains(target)` 于是答「在外面」—— 点「新建项目组」
     会连菜单一起收掉（草稿行画了、人却看不见，更没法输入）。
     用派发时算好的整条路径判：它不随节点被摘而变，点在哪就是哪。
     开着的下拉浮层算它自己那一格（它挂在 body 上，只是借个位置画）。 */
  const path = e.composedPath ? e.composedPath() : [];
  const inMenu = path.includes($('projMenu')) || path.includes($('projSwitch'))
    || path.some(n => n && n.classList && n.classList.contains('dd-list') && n.classList.contains('on'));
  if (inMenu) return;
  $('projMenu').hidden = true;
  clearProjMenuStates();
});

  return {
    exportProjectPack,
    pickProjectPack,
  };
}
