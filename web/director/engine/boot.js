/* 导演台启动域：三栏比例把手、注册表与本地工作区读回（IndexedDB + 关标签兜底 + 数据文件对账）、
   首屏渲染与首屏之后的后台补齐（能力重画 / 本机视频 blob / 余额 / 轮询 / 白膜回传）。
   区间内的代码由 engine.js 逐字搬出；REG / WS / proj / lastSavedJson / wsLoaded 是 engine
   继续持有的可变状态，经访问器读写，document / window 用参数名遮蔽全局。 */


export function createBoot(E, document, window) {
  'use strict';
  const {
    Gen,
    K_WS_UNLOAD,
    Panel,
    allShots,
    consumeModelHandoff,
    healStaleUrls,
    hydrateThumbFrames,
    loadCredits,
    newShot,
    projOf,
    regOf,
    renderAll,
    restoreLocalBlobs,
    sanitize,
    setLastSavedJson,
    setProj,
    setReg,
    setStatus,
    setWs,
    setWsLoaded,
    snapOf,
    uid,
    wsKv,
    wsOf,
  } = E;

/* ---------- 启动 ----------
   首屏只等「注册路由 + 本地工作区」（都很快），其余全部后台补齐：
     · 模型能力接口（/models 实测 ~1.2s）→ 到了再刷新右栏参数可选值
     · 本地导入视频的 blob 地址重建      → 完了再重画一次
     · 余额查询、任务轮询                → 各自异步
   以前这些 await 串在首屏之前，导致打开页面有 1~2 秒空白。 */
/* 三栏占比可拖（拖拽条 DOM 与 localStorage 读写都在 workbench.js 的 Wb.split 里）：
   两条拖拽条分别改左栏和右栏，中栏永远吃掉剩下的空间。
   box 传**元素**而不是选择器串：Wb.split 在公共件里用的是真 document，
   文档级 '.layout' 在 KeepAlive 页面池里会命中别的页（工作台也有 .layout）。
   这里 document 是导演台自己的代理 → querySelector 只会落在本页这一块。 */
const dirLayout = document.querySelector('.layout');
if (dirLayout) Wb.split.enable({
  box: dirLayout, key: 'dir_split',
  cols: [{ el: '.col-left' }, { el: '.col-mid' }, { el: '.col-right' }],
  handles: [
    { left: 0, right: 1, resize: 0, varName: 'sp0', min: 198, max: 520 },
    { left: 1, right: 2, resize: 2, varName: 'sp1', min: 298, max: 700 },
  ],
});
(async () => {
  // 注册路由：提供商与模型能力
  try { setReg(await Api.registry()); } catch { setReg({ providers: [] }); }
  if (window.Api) Api.setRegistry(regOf());   // 统一接口层复用同一份注册表
  if (window.Dropdowns) Dropdowns.build(document);   // 弹窗里的静态下拉一次性包装
  // 工作区：多短片
  let ws = await wsKv.get('workspace');
  /* 上一次关标签/刷新时留下的「最后 500ms」同步兜底（见 __spaFlush）：比 IDB 新就用它。 */
  try {
    const u = window.LS.json(K_WS_UNLOAD, null);   // 读坏 / 没有都当没有
    if (u && u.data && Array.isArray(u.data.projects) && u.data.projects.length
      && (!ws || (Number(u.ts) || 0) > (Number(ws.ts) || 0))) {
      ws = u.data;
      await wsKv.put('workspace', ws);
    }
    window.LS.del(K_WS_UNLOAD);
  } catch (e) { /* 写回 IndexedDB 抛错就用内存里那一份继续装配 */ }
  /* 和数据文件（.data/workspace.json）对账：服务器上的更新就用它（换机器 / 清过浏览器缓存时靠这条恢复）*/
  if (window.DataSync) {
    try {
      const srvWs = await DataSync.workspaceFromServer(ws && ws.ts);
      if (srvWs && Array.isArray(srvWs.projects) && srvWs.projects.length) {
        ws = srvWs;
        await wsKv.put('workspace', srvWs);
        setStatus('<span class="ok">✓ 已从本机数据文件恢复工作区</span>');
      }
    } catch (e) { console.warn('[workspace] 数据文件对账失败：', e.message); }
  }
  if (!ws || !Array.isArray(ws.projects)) ws = { projects: [], curId: null, roles: [], groups: [] };
  if (!ws.projects.length) {
    ws.projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  /* 项目组：老工作区没有这一项 → 补空表（**零迁移**：现有工程全落未分组）。 */
  if (!Array.isArray(ws.groups)) ws.groups = [];
  setWs({ projects: ws.projects, curId: ws.curId && ws.projects.some(p => p.id === ws.curId) ? ws.curId : ws.projects[0].id,
    roles: ws.roles || [], groups: ws.groups });
  setProj(wsOf().projects.find(p => p.id === wsOf().curId));
  sanitize();
  setLastSavedJson(snapOf());    // 撤销栈基线
  setWsLoaded(true);             // 从现在起才允许落盘（见 wsLoaded 那段）
  renderAll();                 // 首屏：不等能力接口、不等本地视频、不等余额（页头那一格也跟着刷）
  /* 14.1-6：老工程 refMeta 没 id 的条目按 label 反查库里补 id（幂等，已有 id 的不动）。 */
  try { Panel.backfillRefMetaIds && Panel.backfillRefMetaIds(allShots()); } catch (e) { /* 补不上不影响启动 */ }
  setTimeout(() => Gen.announceDoneCandidates(), 0);   // 已经出画面但还没镜像的候选：投一次事件（不阻塞首屏）
  Gen.pollKick();             // 首屏立刻问一次在途候选，不等第一轮间隔
  Gen.resumeKeyframes().catch(() => {});   // 上次没跑完的画面切片：认回任务或如实标失败
  try { Gen.reconcilePendingPics(); } catch (e) { /* 待建占位补不上不影响启动 */ }
  loadCredits();
  // 后台补齐（都不阻塞首屏）
  Panel.installCapRepaint();   // 一家能力落定就补画一次右栏（实现在 engine/panel.js）
  restoreLocalBlobs().then(() => { try { renderAll(); } catch { /* 首屏重画抛错不打断后面的恢复流程 */ } }).catch(() => {});
  hydrateThumbFrames();        // 上次抽好的缩略图首帧：读出来直接当图片用，不再等视频出画
  healStaleUrls();             // 存过期的签名外链：后台按任务号换新地址并写回工作区
  setTimeout(() => { consumeModelHandoff().catch(() => {}); }, 0);   // 建模台送回来的白膜
})();

  return {
  };
}
