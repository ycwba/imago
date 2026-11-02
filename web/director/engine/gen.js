/* 导演台生成域：分镜的提交、平台任务轮询、自动镜像投递与「生成全部分镜」的
   依赖式批量调度（报价 / 接续等待 / 并发窗口 / 实时进度）。engine.js 只留状态与接线
   （内部保持命令式、按域拆模块）。
   引擎状态一律经 createGen(E) 递进来的访问器读写；短片的身份（proj / WS / REG）每次现读，
   不在这一份里缓存 —— 切换短片、清缓存、导入工程都会换掉它们。 */
import { hasTailFrame, quoteKeyOf, sumQuotes, runWithDeps } from '../chain.js';
import { candidateBase, voiceBase, shotCtxOf, candidateIndex } from '../naming.js';

export function createGen(E) {
  const {
    $, canStatus, uid, mkCandidateBase, allShots, curScene, ensureChainModel, chainWaitWhy,
    resolveChainFrame, scheduleSave, dlStage, assetStoreId, sameAssetSpace, loadCredits,
    updateMidLive, sortCandidates, provById, saveScheduleSoft, renderScenesSoon, curDraftCand,
    applyRefSyntax, refTokenize, resolvedModel, ROLE_ZH, comboLabel, shotUsedRoles, shotCombo,
    shotInputCaps, shotAdvCtx, shotAdvExtras, shotKeyframes, shotInputEntries, NO_PROMPT_WHY,
    shotBlockReason, provOf, needProv, shotQuote, renderAll, updateProjUI,
    updateBanner, setStatus, hasRealCandidate, projOf, wsOf, regOf, setForceMid, videoPlanOf,
    setSelectedCandidate, renderSoft, addKeyframeToRefs, kfModelOf,
    Panel, BoardAssetsOf,
  } = E;
let scenesDirty = false;         // 这一轮轮询里「左栏关心的东西」到底变没变
/* 活儿清单：**所有短片**里带平台任务号、又没到终态的候选（不只是当前这一部）。
   以前只看 allShots()（= 当前短片）：在短片 A 上点了「生成全部分镜」，随手切到 B ——
   A 的镜头就永远停在「● 生成中」加一条不动的进度条，再也不会更新；
   批量收尾的消息还会写进 B 的左栏，看着像是在说 B。
   `mine` = 「这一条属于我现在正看着的那部短片」：只有在途候选属于当前短片时才允许
   触发左栏 / 中栏重画（在别的短片上重画当前短片 = 串台）。落盘是全局的，照旧。
   每条候选配一个 `{ c, sh, mine }` 的壳，是因为轮询器只认「一个任务对象」，
   而这里写回状态之外还要知道它属于哪个镜头、要不要重画。
   **壳要跨轮复用同一个对象**（下面 shells 那张缓存）：公共轮询器按任务对象记「这一条连续失败几次」，
   每轮新建一个壳等于那份计数永远从零开始 —— 坏掉的详情端点就又变成「一直转圈、一声不吭」。 */
let pollShells = new Map();      // 候选对象 → 它的壳（身份稳定；每轮整张换掉，留下的只有这一轮还认得的）
function pollTasks() {
  const next = new Map();
  const out = [];
  for (const p0 of (wsOf().projects || [])) {
    if (!p0 || !Array.isArray(p0.scenes)) continue;
    const mine = p0 === projOf();
    p0.scenes.forEach(sc => (sc.shots || []).forEach(sh => (sh.candidates || []).forEach(c => {
      if (!c || !c.vid) return;
      const t = pollShells.get(c) || {};
      t.c = c; t.sh = sh; t.mine = mine;              // 归属每轮现跟，只有身份是攒下来的
      next.set(c, t);
      out.push(t);
    })));
  }
  pollShells = next;
  return out;
}
/* 「这一条还要不要问」：本机占位号（tmp_）与终局不问。
   'creating' **不在**排除名单里 —— 以前把它也排除了，于是「create 已经回了任务号、
   状态还停在 creating」的候选永远不被问一次。 */
function pollLive(t) {
  const c = t.c;
  return !String(c.vid).startsWith('tmp_') && !['succeeded', 'failed', 'cancelled'].includes(c.status);
}
/* 一个候选出画面后推一次「已生成」：自动镜像不再等某个列表页加载 AssetLib。
   这一处只管两件事：同一个候选不投第二遍、把候选形状翻成公共字段。
   地址有没有、是不是本地导入的候选（la_ 号 / /asset/la_）由 `AssetLocal.announce` 判
   —— 那一道闸四个生产点共用一份（见 local.js 的 announce 说明）。 */
/* 这一条候选的素材名（不带扩展名）：`场景01-雨夜街头_镜头03-推门_候选2`。
   库里的文件名、本机索引名、FCPXML 媒体包名都用它 —— 三处同源才不会出现
   「素材库里叫一个名、包里的 media/ 又叫另一个名」。所属镜头由调用方递进来
   （轮询那两处手里都有 sh）—— 以前在这里按 allShots()（**当前短片**）反查，
   短片 A 的任务在切到 B 之后跑完，名字就回落到提示词前缀，三处同源在这一路上断了。 */
function shotOwnerOf(sh) {
  for (const p of ((wsOf() && wsOf().projects) || [])) {
    if ((p.scenes || []).some(s => (s.shots || []).includes(sh))) return p;
  }
  return null;
}
function candidateAssetBase(c, shRef) {
  let sh = shRef || null;
  let owner = sh ? shotOwnerOf(sh) : null;
  if (!sh) {
    for (const p of ((wsOf() && wsOf().projects) || [])) {
      for (const sc of (p.scenes || [])) {
        const hit = (sc.shots || []).find(x => (x.candidates || []).indexOf(c) >= 0);
        if (hit) { sh = hit; owner = p; break; }
      }
      if (sh) break;
    }
  }
  const ctx = sh && owner ? shotCtxOf(owner, sh) : null;
  return ctx ? candidateBase(ctx, candidateIndex(sh, c)) : '';
}
function voiceAssetBase(v, shRef) {
  let sh = shRef || null;
  let owner = null;
  if (!sh) {
    for (const p of ((wsOf() && wsOf().projects) || [])) {
      for (const sc of (p.scenes || [])) {
        const hit = (sc.shots || []).find(x => x.id === (v && v.shotId));
        if (hit) { sh = hit; owner = p; break; }
      }
      if (sh) break;
    }
  } else owner = shotOwnerOf(sh);
  const ctx = sh && owner ? shotCtxOf(owner, sh) : null;
  return ctx ? voiceBase(ctx) : '';
}
function announceAssetDone(c, shRef) {
  if (!c || c._mirrorAnnounced) return;
  const src = String(c.url || (c.assetId ? Api.assetSrc(c.assetId) : ''));
  if (!src) return;
  c._mirrorAnnounced = true;
  window.AssetLocal.announce([{
    kind: 'asset', provider: c.provider || '', assetId: c.assetId || '', genId: c.vid || '',
    type: '视频', format: c.format || 'mp4', status: 'done', src,
    name: candidateAssetBase(c, shRef),            // base，不带扩展名（见 local.js 的 nameOf）
    prompt: c.prompt || '', model: c.model || '', tier: c.tier || '', res: c.res || '', ar: c.ar || '',
    duration: c.duration ?? null, credits: c.credits ?? null, priceMicros: c.priceMicros ?? null,
    currency: c.currency || '', priceText: c.priceText || '', gstatus: c.gstatus || c.status || '',
    created: c.created || '', completed: c.completed || '',
  }]);
}
function announceDoneCandidates() {
  try {
    /* 起点扫**所有短片**（不只是当前这一部）：切走之后跑完的候选同样要投自动镜像。 */
    ((wsOf() && wsOf().projects) || []).forEach(p => (p.scenes || []).forEach(sc => (sc.shots || []).forEach(sh =>
      (sh.candidates || []).forEach(c => { if (c && c.status === 'succeeded' && c.url) announceAssetDone(c, sh); }))));
  } catch (e) { /* 自动镜像是尽力而为，抛错不该打断这一屏渲染 */ }
}
function pollOne(t) {
  const { c, sh, mine } = t;
  const prov = provById(c.provider);
  /* 认不出平台（换过端口 / 清过缓存 / 那一家被停用）：**当场把话说清**，
     而不是继续轮询一条永远问不到的 URL（`pollTask(null,…)` 每次都失败，
     用户看到的是任务永远停在「生成中」）。
     说清之后仍然标 failed —— 用户能点重试，而重试会重新提交一条新任务。 */
  if (!prov) {
    c.status = 'failed';
    c.error = '这一条属于「' + (c.provider || '?') + '」，但当前平台清单里没有这一家 —— '
      + '到「设置 → 供应商与密钥」重新勾一下它，再点重试';
    c.progress = '';
    return Promise.resolve();
  }
  /* 轮询返回「状态没变、进度没动」是最常见的情况（占比压倒性），以前那种情况照样在
     .finally 里付一整轮 renderScenes()：整块重建左栏、逐镜头重挂十几个监听器。
     左栏实际只看这几样：选中候选的 url、有没有在跑的候选、跑着的那个的进度、状态文案。
     所以进请求前先把这几个值记下来，回来一比，没变就不重画。 */
  const dStatus = c.status, dProgress = c.progress, dUrl = c.url, dSel = sh.selId;
  /* 落盘只看「这一条有没有真的变」：状态 / 进度 / 地址之外，时长、错误、价格、资产号也会被本轮
     回填，它们同样要进盘。以前 `.finally` 里无条件 `saveScheduleSoft()` —— 每 3 秒一次整份工作区
     序列化 + 落盘，而绝大多数轮询什么都没改。 */
  const dSave = [c.status, c.progress, c.url, c.duration, c.error, c.priceText, c.priceMicros, c.assetId, sh.selId].join('|');
  let p2done = false;
  /* 统一走 Api.pollTask：它认 registry 的 pollVia:'list'。以前这里自己按 endpoints.detail 拼请求，
     而 VGENV 的 /v2/videos/{id} 是 404 空壳 —— 在跑的任务会被判成「平台上找不到这条任务」，
     界面裂成假失败卡 + 列表里真实的完成卡，用户重试就是重复扣费（只走 Api.pollTask 这类统一入口）。 */
  return Api.pollTask(prov, c.vid).then(r => {
    const v = (r && r.raw) || null;
    const p = r && r.p;
    // 状态/进度/产出/费用全部按 registry 的 list.map 解析（平台差异不再写在这里）
    if (p) {
      c.status = p.status ? canStatus(p.status) : c.status;
      c.miss = 0;                                     // 这一轮在平台上找到了它
      c.progress = p.progress ?? 0;
      if (p.duration != null) c.duration = p.duration;
      c.error = p.error || null;
      if (v && v.queue_position != null) c.queue_position = v.queue_position;
      if (p.priceMicros != null) c.priceMicros = p.priceMicros;
      const pt = Api.priceText(prov, p);
      if (pt) c.priceText = pt;
      if (p.done && p.assetId) {              // 产出是资产 id → 本地直链，不受签名有效期影响
        c.assetId = p.assetId;
        c.url = Api.assetSrc(p.assetId);
      } else if (p.done && p.url) {           // 产出是可播放 URL
        c.url = p.url;
      }
      if (p.done || p.failed) {
        if (!sh.selId && p.done) { setSelectedCandidate(sh, c); }   // 第一条成功的自动选用
        if (p.done) announceAssetDone(c, sh);            // 自动镜像的入口（见 announceAssetDone）
        p2done = true;                                   // 这一条刚出结果 → 立刻重画中栏
      }
    } else if (r) {
      /* 列表接口通了、但里面已经没有这条任务：多半被清理或过期了，结掉卡片。
         但要**连续几轮**都没有才认 —— 刚提交的任务可能还没同步进列表，游标翻页也可能这一轮没翻到，
         单次落空就把卡片结掉，正是「任务明明在做完的那一刻变成失败」的成因之一。 */
      c.miss = (c.miss || 0) + 1;
      if (c.miss >= 3) {
        c.status = 'failed';
        c.error = '平台上找不到这条任务（可能已被清理或过期），可重新生成';
        p2done = true;
      }
    }
  }).catch(e => {
    /* 平台上查不到这条任务（404：已被清理 / 任务号失效）：结掉这张卡并写明原因，
       以前 .catch(()=>{}) 一律吞掉 —— 卡片永远停在「生成中」，还每 3 秒空打一次接口。
       判定只认 404 与明确的「不存在」措辞：403 多半是限流或鉴权抖一下，任务号还有效，
       当场结掉就是把还能跑的任务说成失败（三个工作台都是这个口径）；
       /40[34]/ 在整条消息里找子串更不行 —— 任务号或金额里带 403/404 的普通错误会被误判。 */
    const gone = e && (e.status === 404 || /不存在|未找到|not\s*found/i.test(String(e.message || '')));
    if (gone && (c.miss = (c.miss || 0) + 1) >= 3) {
      c.status = 'failed';
      c.error = '平台上找不到这条任务（可能已被清理或过期），可重新生成';
      p2done = true;
      return;                       // 这条已经结掉，不必再算成「刷新失败」
    }
    /* 其它错误（超时 / 5xx / 断连）交给公共轮询器：它按「整轮全失败」退避并提示，
       按「同一条连续三次」单独说一句 —— 以前这里只 console.warn，一条坏掉的详情端点
       会让卡片永远转圈、界面一声不吭，而且每 3 秒照打不误。 */
    throw e;
  }).finally(() => {
    sortCandidates(sh);                                  // 生成的往前排、排队的往后排
    /* 这一条刚落定（出画面 / 失败）就叫醒等它尾帧的接续镜：批量执行器挂在 `waitShotDone`
       上，晚一轮就是一个轮询间隔的白等；重复调用无副作用（`settleShot` 只认落定状态）。 */
    settleShot(sh);
    const saveSig = [c.status, c.progress, c.url, c.duration, c.error, c.priceText, c.priceMicros, c.assetId, sh.selId].join('|');
    if (saveSig !== dSave) saveScheduleSoft();
    /* 左栏只在真的变了时才重画（见上面 dStatus 那段）：一次 tick 里 K 条候选最多合并成
       一次渲染（renderScenesSoon 的 350 ms 防抖），而「什么都没变」时一次都不画。 */
    if (mine && (c.status !== dStatus || c.progress !== dProgress || c.url !== dUrl || sh.selId !== dSel)) scenesDirty = true;
    if (mine) {
      if (scenesDirty) { scenesDirty = false; renderScenesSoon(); }
      updateMidLive();                                   // 中栏就地更新（不重建 → 候选缩略图不刷新）
      if (p2done) setForceMid(true);                       // 结构需要变（占位→播放器）时，下一次走完整重画
    }
  });
}
/* 「什么时候问、问多密、连续失败怎么办」交回公共轮询器 Wb.poller（与工作台、资产库同一台）：
   ① 间隔听设置页那一项「任务刷新间隔」（以前这里写死 3 秒 setInterval，那项设置对导演台形同虚设）；
   ② 整轮失败会指数退避、同一条连续三次会单独说一句（以前只 console.warn）；
   ③ 切走标签页自动暂停、回到前台立刻补一次（以前是本页自己抄的一份 visibilitychange）；
   ④ 一轮没跑完不会再起一轮 —— 所以原来那个「这一条正在请求中」的 polling Set 是多余的，删掉。
   切回某一部短片时补一次状态行：靠 onChange（这一轮有任何一条变过就重画横幅）。 */
const poller = Wb.poller({
  label: '分镜', interval: 3000, page: 'director.html',
  tasks: pollTasks,
  isRunning: pollLive,
  sig: t => [t.c.status, t.c.progress, t.c.url, t.c.miss].join('|'),
  pollOne,
  onChange: () => { updateBanner(); updateProjUI(); },
});

/* ---------- 创建视频（可一次生成多条，按注册路由选择提供商）---------- */
/* 一条任务一个提交单元：先建占位候选（界面立刻有反馈），创建失败只标记这一条 */
function pushPlaceholders(sh, count) {
  const phs = [];
  for (let k = 0; k < count; k++) {
    /* 字段清单归 mkCandidateBase 那一份；这里只补「已经提交出去了」才有的三项：
       占位状态、平台回的价格文案、这一镜的时长。 */
    const ph = Object.assign(mkCandidateBase(sh, 'tmp_' + uid()),
      { status: 'creating', priceText: '', duration: sh.duration || undefined });
    phs.push(ph);
    sh.candidates.push(ph);
  }
  renderAll(); scheduleSave();
  return phs;
}
async function submitCandidate(sh, ph) {
  const p = String((ph && ph.prompt != null && String(ph.prompt).trim()) ? ph.prompt : sh.prompt).trim();
  ph.prompt = p;                                 // 记下这条用的描述（方便回看/复用）
  /* 占位符原样发出去 = 模型收到一个它不认识的 token：素材还没出图时提一句，
     别等成片出来才发现画面不对（导出前那道提醒在 export.js，这一道管提交）。 */
  if (/@待建:/.test(p)) Toast.warn('提示词里还有 @待建:… 的占位（素材还没出图）：这次会原样发给平台，出图后建议重生成这一镜');
  ensureChainModel(sh);                          // 接续镜头先落到支持首帧的型号上，再问能力与报价
  const rm = resolvedModel(sh);
  if (!rm) throw new Error('没有支持这一镜素材的型号（当前输入：' +
    (shotUsedRoles(sh).map(r => ROLE_ZH[r] || r).join(' / ') || '纯文字') + '）：换一个支持它的型号，或清空这组素材');
  /* 时长按**真正发请求这一家**再夹一次：落盘那一夹（clampShotDurations）可能发生在
     接续型号落定之前 —— ensureChainModel 换到的另一家 min/max 不同，越界值发出去就是一句 4xx。 */
  const durPlan = videoPlanOf(sh).kinds.duration;
  if (durPlan.list.length && Number(sh.duration) !== Number(durPlan.value)) {
    sh.duration = Number(durPlan.value);
    scheduleSave('时长按型号收正');
  }
  const modelId = rm.id;
  /* 提交这一下必须用 needProv：认不出平台就**停下并说清**，绝不默默发给另一家
     （见 provOf 那段注释 —— 那个兜底正是「model must match …/…」这个看不懂的报错的来源）。 */
  const prov = needProv(rm.provider, (rm.name || modelId));
  const icSub = shotInputCaps(sh);
  /* 这一镜手上的素材与当前输入模式说不通的地方（缺料 / 超料 / 不收 / 互斥），提交前照界面同一份
     判据兜一次：走到这里说明是导入 / 历史数据留下的状态，界面已经拦过一遍了。
     ⚠ 绝不静默丢掉素材 —— 用户传进去的东西要么发出去，要么把原因说出来。 */
  const gapLines = (icSub.gaps && icSub.gaps.lines) || [];
  /* 这一镜手上的素材（提交与归档文案都按同一份数）：画面切片只数真的有资产号的，
     生成失败或被删掉的不能算「已带上」。 */
  const kfs = shotKeyframes(sh);
  /* @名字 → @参考图N → 平台声明的引用语法。归档那一份存的是**原始**描述（还是 @名字，
     人看得懂、复用也方便），只有真正发出去的 body 用转换后的。 */
  const pApi = applyRefSyntax(refTokenize(sh, p, icSub), prov);
  /* 高级设置那一读要**在归档之前**做完：摘要里写的是「这一次真的发出去了哪些顶层开关」，
     先拼好文案才不会出现「归档写着平台润色、提交体里根本没有」这种自相矛盾的存档。 */
  const ex = shotAdvExtras(sh);
  const ctxAdv = shotAdvCtx(sh);
  const cbAdv = shotCombo(sh);
  try {
      // 放在 try 里：抛错时占位候选会被标成「失败」，不会留下一堆排队中的僵尸占位
      if (gapLines.length) throw new Error(gapLines.join('；') + '（' + (rm.name || modelId) + '）');
      /* 越界的形状字段（种子、超分档那种）当场拒掉，不发一个必然被上游驳回的请求：
         界面已经压暗并写了原因，走到这里说明是导入 / 历史数据留下的值。 */
      if (ex.bad.length) throw new Error(ex.bad.join('、'));
      const videoTemplate = Api.inputTemplate(prov, 'reference_video');
      if (icSub.refVideo && sh.refVideo && videoTemplate?.requiresAudio && sh.refVideo.preparedFor !== prov.id) {
        const ref = sh.refVideo;
        const source = ref.src || (sameAssetSpace(ref.provider, assetStoreId()) && ref.asset_id ? Api.assetSrc(ref.asset_id) : '');
        if (!source) throw new Error('这份旧参考视频未检查音轨，请重新选择原视频；上传时会自动补静音音轨');
        ref.asset_id = await AssetTransfer.toAsset(prov.id, source, { reg: regOf(), name: ref.name, role: 'reference_video', onStage: dlStage('参考视频') });
        ref.provider = prov.id;
        ref.preparedFor = prov.id;
        scheduleSave();
      }
      /* 接上一镜尾帧：只在这一刻解析（上一镜可能刚刚跑完），显式首帧优先。
         解析结果只做内存缓存，不写工程、不落盘。失败会落进下面的 catch，把这条占位标成失败。 */
      const chainFrame = (sh.linkPrev === 'tail' && !sh.firstFrame) ? await resolveChainFrame(sh) : null;
      const nFrame = (sh.firstFrame ? 1 : 0) + (sh.lastFrame ? 1 : 0) + (chainFrame ? 1 : 0);
      /* 归档到提示词文件夹时要写在文件头里的信息：存**原始**描述（含 @参考图N 的写法，
         比平台语法更好复用），镜头名 + 时长/画幅等参数一并记下。见 PromptLog
         「输入模式」也要记：同一句提示词在「智能参考」与「视频换人」下发出去的是两种请求、
         两种价，隔一个月回看这个文件的人（往往就是用户自己）得知道当时按哪一种出的。 */
      const log2 = { type: '导演台-分镜', prompt: p, meta: {
        镜头: sh.name || '', 模型档位: sh.tier, 分辨率: sh.res, 画幅: sh.ar, 尺寸: sh.size || '',
        时长: sh.duration ? sh.duration + 's' : '',
        输入模式: cbAdv ? comboLabel(cbAdv) : '',
        顶层参数: ex.summary,
        参考素材: [nFrame ? nFrame + ' 帧' : '', chainFrame ? '接上一镜尾帧' : '',
          kfs.length ? kfs.length + ' 关键帧' : '',
          (sh.refImages || []).length ? sh.refImages.length + ' 参考图' : '',
          sh.refVideo ? '参考视频' : '', sh.refAudio ? '参考音频' : ''].filter(Boolean).join(' / ') } };
      /* 提交体完全交给 `Api.createBody` + registry 声明（与工作台同一条路）：
         标准字段往哪个上游字段名映射、哪些要嵌进 parameters、顶层开关与形状字段怎么过滤、
         素材按什么形状进请求体，全是声明里的事，页面不抄第二份。 */
      const v = await Api.request(prov, 'create', { method: 'POST', log: log2,
        snapTag: 'dir:shot:' + sh.id, snapLabel: sh.name || '',
        body: Api.createBody(prov, {
          model: modelId, prompt: pApi, tier: sh.tier, duration: sh.duration || undefined,
          res: sh.res, ar: sh.ar, size: sh.size,
          note: sh.name || '',                       // 只有声明了 acceptsNote 的那一族会真的带上（见 Api.createBody）
          inputEntries: await shotInputEntries(sh, prov, icSub, chainFrame),
          /* `creation_intent` 是**上游真字段**（省略 = 普通生成，person_replacement = 动作换人）；
             `mode` 不是字段 —— 平台按送上来的素材自己推断，多发一个 mode 必被拒（实测），
             它只当声明里 when / hide 的上下文走 `shape` 递进 createBody，永远不进请求体。
             以前这一路根本不带 intent：换了「视频换人」档，提交体发出的还是普通生成。 */
          creation_intent: ctxAdv.intent,
          shape: { mode: ctxAdv.mode, intent: ctxAdv.intent, caps: ctxAdv.caps }, params: ex.params,
        }) });
      /* 三种「上游说没成」的形状都要认（`Api.request` 返回的是上游原始响应体）：
         `{error:{message}}`（SparkCine 那一族与照它克隆的中转）、
         顶层 `statusCode >= 400`（VGENV 那一族）、
         以及只回一个业务 `code` 而没有任务号（如 MiniMax / 智谱那一族）。
         少认一种就是把一个真失败当成「任务已建」，卡片会一直转圈等一条不存在的任务。 */
      if (v.error) throw new Error(v.error.message || '创建失败');
      if (Number(v.statusCode) >= 400) throw new Error(v.message || v.code || '创建失败');
      if (v.code && !v.id) throw new Error(v.message || v.code || '创建失败');
    Object.assign(ph, {
      vid: v.id, provider: prov.id, status: v.status || 'queued', progress: 0,
      priceText: Api.priceText(prov, Api.parseItem(prov, v)) || '',
      duration: v.duration || ph.duration, error: null, created: ph.created || Date.now(), prompt: p,
    });
    renderAll(); scheduleSave();
  } catch (e) {
    /* 「结果未知」不能写成「失败」：超时 / 断连 / 5xx 时请求多半已经被平台受理，
       显示成失败就会诱导用户重拍 —— 重复建任务、重复扣费。
       判据只用 Api.maybeSubmitted（全站一份，认传输层超时 / 断连的那条消息）：
       以前判的是属性 e.maybeSubmitted —— 它只在 5xx / 408 / 200-读不出 JSON 时被设置，
       **传输层超时**（Net.read 抛的「请求超时」）根本没走到那两行，于是最常见的那一种
       被当成了普通失败，「别急着重拍」那句警告一句不出。 */
    const unknown = !!(window.Api && Api.maybeSubmitted ? Api.maybeSubmitted(e) : (e && e.maybeSubmitted));
    ph.status = 'failed';
    ph.error = (unknown ? '提交结果未知（平台可能已受理，重拍会再扣一次费）：' : '') + errText(e);
    if (unknown) Toast.warn('这条提交结果未知：平台可能已经建好任务，先刷新候选，别急着重拍');
    /* 这一镜可能已经没有任何在跑的候选了：等它尾帧的接续镜不能干等到轮询下一轮
       （提交阶段就失败的那一条根本不会被轮询碰到）。 */
    settleShot(sh);
    renderAll(); scheduleSave();
    throw e;
  }
}
/* 单镜生成：一条条提交（「生成这一镜」按钮用）。
   promptText 缺省读 sh.prompt（这一镜的描述）；按钮那一档传的是提示词框里
   正显示的那一句（promptTextOf —— 翻看候选时框里是那条候选当年的描述），
   屏幕、预览、发出的请求体三处说的必须是同一句话。 */
async function drawShot(sh, count, promptText) {
  const p = String(promptText != null ? promptText : sh.prompt).trim();
  if (!p) throw new Error(NO_PROMPT_WHY);
  const phs = pushPlaceholders(sh, count);
  phs.forEach(x => { x.prompt = p; });
  for (let k = 0; k < count; k++) {
    try { await submitCandidate(sh, phs[k]); }
    catch (e) {
      /* 这一条失败就停手（不接着花后面的钱），但**把剩下的占位也结掉**：
         它们从没提交出去，留成「创建中」永远不会动（轮询按 tmp_ 号跳过），卡片会一直挂着。 */
      for (let j = k + 1; j < count; j++) {
        phs[j].status = 'failed';
        phs[j].error = '这一批在前一条失败后没有提交（删掉即可重试）';
      }
      renderAll(); scheduleSave();
      throw e;
    }
  }
}
/* 「这一镜已经有视频（在跑或已成）」：再点一次生成 = 要又一版，不是在原镜里越攒越多候选。
   失败 / 取消不算 —— 那种情况在原镜上再点一次就是「重试」，不该开新镜头。
   （与 `hasRealCandidate` 不是一回事：那个连 failed 也算「真候选」，判的是批量生成要跳过谁。） */
const shotHasVideo = sh => (sh.candidates || []).some(c => c && !['draft', 'failed', 'cancelled'].includes(c.status));
/* 「生成」那颗按钮这一刻会做什么，文案与 #genOne 的分支同一判据（shotHasVideo）：
   已经有视频时点它是「开一条新镜头再来一版」，不再说「生成这一镜」。 */
const genBtnLabel = sh => shotHasVideo(sh)
  ? '生成新候选镜头（' + (sh.draw || 1) + ' 条）'
  : curDraftCand() ? '生成这条（1 条）' : '生成这一镜（' + (sh.draw || 1) + ' 条）';
/* 在当前场景这一镜之后原地开一条新镜头（「选中了有视频的镜头再点生成」用它）：
   整套配置照「复制镜头」那套深拷贝跟着走（提示词 / 画幅 / 模型 / 素材 / 画面切片，
   日后新加的字段也不会漏），候选与选用清空 —— 它是一条全新的提交，
   出来的片子就是这一镜的又一条候选。 */
function spawnCandidateShot(sh) {
  const sc = curScene();
  const ns = JSON.parse(JSON.stringify(sh));
  ns.id = uid();
  ns.name = sh.name + ' · 新候选';
  ns.candidates = [];
  ns.selId = null;
  const at = sc.shots.indexOf(sh);
  sc.shots.splice(at < 0 ? sc.shots.length : at + 1, 0, ns);
  projOf().curShot = at < 0 ? sc.shots.length - 1 : at + 1;
  projOf().curCand = 0;
  return ns;
}

/* 「这一镜试过、但一条都没成」—— failed / cancelled 也算「没出画面」。
   为什么必须单独判一次：批量提交失败（余额不足、上游 5xx、提示词被安全策略拦下）之后，
   那一镜留下的是一条 failed 候选；只按「有没有非草稿候选」筛的话，这些镜头**永远**进不了 todo ——
   补好额度再点「生成全部分镜」，得到的还是「所有镜头都已有生成结果，无需重复生成」，
   而失败提示明明写着「可单独重试这些镜头」。想重来只剩一条路：逐个进镜头、手动删掉那批失败候选。
   （有 succeeded 的镜头**不**算「试过没成」—— 想重跑是另一回事，那是「再生成一条」，不是补失败。） */
const shotAllFailed = sh => {
  /* 新建镜头默认有一条 draft 占位；把它算进来 every 恒 false，批量失败的镜头就永远进不了
     todo（重试入口报「都已有生成结果」）。先滤掉 draft，再要求至少真提交过一次。 */
  const real = (sh.candidates || []).filter(c => c && c.status !== 'draft');
  return real.length > 0 && real.every(c => ['failed', 'cancelled'].includes(c.status));
};
const GEN_CONCUR = 3;            // 同时在飞的提交窗口数（等待上一镜的时间不占名额）

/* ---------------- 生成全部镜头：依赖 + 生成前报价 ----------------
   两件事共用同一份 `genAllPlan()`：按钮下那行估价与点下去之后真正提交的必须是同一批镜头，
   否则「可生成 12 镜 / 预计 30 元」与真提交的 9 镜是两本账。
   接续镜（`linkPrev === 'tail'`）先等上一镜出画面再提交；等待不占并发名额（`runWithDeps` 的
   `limit` 只包住提交窗口）。 */

/* 一个镜头此刻在链条上的状态：done = 已有能当尾帧的画面 / failed = 试过但一条都没成 /
   running = 还有任务在跑 / todo = 还没提交过。等待与报价都读这一份。 */
function chainStateOf(sh) {
  if (hasTailFrame(sh)) return 'done';
  if (shotAllFailed(sh)) return 'failed';
  return ((sh && sh.candidates) || []).some(c => c && ['creating', 'queued', 'running'].includes(c.status))
    ? 'running' : 'todo';
}
/* 等一个镜头出画面 / 失败的 deferred：同一条只开一枚。
   ⚠ 只有「正在跑」或「排进了这一批、马上要提交」的镜头才许等：等一个 todo 且不在批的镜头
   永远不会醒（`genAllPlan` 已经把它判进 bad，不会走到这里）。 */
const chainWaits = new Map();
function armChainWait(sh) {
  let w = chainWaits.get(sh);
  if (!w) {
    w = {};
    w.p = new Promise(res => { w.resolve = res; });
    chainWaits.set(sh, w);
  }
  return w.p;
}
function waitShotDone(sh) {
  const st = chainStateOf(sh);
  if (st === 'done' || st === 'failed') return Promise.resolve(st === 'done');
  if (st === 'todo' && !chainWaits.has(sh)) return Promise.resolve(false);
  return armChainWait(sh);
}
/* 状态落定（成功 / 全部失败 / 根本没提交）时唤醒所有在等它的镜头。
   `pollOne` 的 finally、`submitCandidate` 的 catch、批量执行器都会调；重复调用无副作用。 */
function settleShot(sh) {
  if (!sh) return '';
  const st = chainStateOf(sh);
  if (st !== 'done' && st !== 'failed' && st !== 'todo') return st;
  const w = chainWaits.get(sh);
  if (w) { chainWaits.delete(sh); w.resolve(st === 'done'); }
  return st;
}

/* 这一批到底要提交哪些镜头、谁在等谁、哪些现在就不能生成。纯读（只顺带把接续型号落到镜头上）。 */
function genAllPlan() {
  const all = allShots();
  all.forEach(sh => ensureChainModel(sh));
  const todo = all.filter(sh => !hasRealCandidate(sh) || shotAllFailed(sh));
  const inBatch = new Set(todo);
  const prevOf = sh => { const i = all.indexOf(sh); return i > 0 ? all[i - 1] : null; };
  const ok = [], wait = [], bad = [];
  const deps = new Map(), badWhy = new Map();
  /* 计划时的上一镜：执行到某一镜时拿它和「现在的顺序」再比一次（用户中途改顺序 / 删镜头）。 */
  const prevMap = new Map();
  todo.forEach(sh => {
    prevMap.set(sh, prevOf(sh));
    const why = shotBlockReason(sh);
    if (!why) { ok.push(sh); return; }
    /* 只有「纯等待」能进 wait：上一镜在本批、或正在跑。别的都是现在真的不能生成
       （提示词空 / 素材冲突 / 型号接不了首帧 / 上一镜失败…）。 */
    const cw = chainWaitWhy(sh);
    const prev = prevOf(sh);
    if (cw && why === cw && prev && (inBatch.has(prev) || chainStateOf(prev) === 'running')) {
      wait.push(sh); deps.set(sh, prev); return;
    }
    bad.push(sh); badWhy.set(sh, why);
  });
  /* 上一镜不能生成 → 等它的那些也一样不能：先级联完，别让用户点下去之后才看见一片「等待失败」。 */
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = wait.length - 1; i >= 0; i--) {
      const sh = wait[i], p = deps.get(sh);
      if (!bad.includes(p)) continue;
      wait.splice(i, 1); deps.delete(sh);
      bad.push(sh);
      badWhy.set(sh, '上一镜不能生成（' + (p.name || '未命名镜头') + '：' + badWhy.get(p) + '）');
      changed = true;
    }
  }
  /* `ok` 里接续镜的上一镜按定义已经有尾帧（否则 `shotBlockReason` 会拦），这里再按现状态兜一次：
     刚好在这一刻被删掉 / 候选被清空的，执行时仍要等它。 */
  ok.forEach(sh => {
    if (sh.linkPrev !== 'tail' || sh.firstFrame) return;
    const prev = prevOf(sh);
    if (prev && chainStateOf(prev) !== 'done') deps.set(sh, prev);
  });
  return { todo, ok, wait, bad, badWhy, deps, prevMap };
}

/* 整批报价：同一份「影响价钱的输入」合并成一次询价（`quoteKeyOf` 不含 count，
   条数当 `count` 递进去）。缺金额 / 只报最低消费 / 询价失败 → 计入 unpriced，**绝不当 0**；
   币种不同不合计（`sumQuotes` 那一份判据）。 */
const gaQuoteCache = new Map();
const GA_QUOTE_TTL = 60 * 1000;
/* 键里有型号 / 参数 / 条数，导演台每改一次时长就是一项新键 —— 只增不删的 Map 会一直长。
   写之前清掉过期项，再按插入序把最老的清到上限内（与 `web/domain/assetlib.js` 的 sweepQuoteCache 同一口径）。 */
const GA_QUOTE_MAX = 200;
function sweepGaQuoteCache() {
  const now = Date.now();
  for (const [k, v] of gaQuoteCache) if (now - v.at >= GA_QUOTE_TTL) gaQuoteCache.delete(k);
  while (gaQuoteCache.size > GA_QUOTE_MAX) gaQuoteCache.delete(gaQuoteCache.keys().next().value);
}
async function genAllQuote(plan, opts) {
  const fresh = !!(opts && opts.fresh);
  const groups = new Map();
  plan.ok.concat(plan.wait).forEach(sh => {
    ensureChainModel(sh);
    const rm = resolvedModel(sh) || {};
    const prov = provOf(rm.provider);
    const ex = shotAdvExtras(sh);
    const ctx = shotAdvCtx(sh);
    const key = quoteKeyOf(sh, { provider: prov && prov.id, model: rm.id,
      intent: ctx.intent, mode: ctx.mode, topBools: ex.topBools, shapeFields: ex.shapeFields,
      caps: ctx.caps, combo: sh.combo });
    let g = groups.get(key);
    if (!g) { g = { sh, n: 0, key }; groups.set(key, g); }
    g.n += Math.max(1, Number(sh.draw) || 1);
  });
  const rows = [];
  for (const g of groups.values()) {
    const ck = g.key + '|' + g.n;
    const hit = gaQuoteCache.get(ck);
    if (!fresh && hit && Date.now() - hit.at < GA_QUOTE_TTL) { rows.push(Object.assign({ n: g.n }, hit.r)); continue; }
    let r;
    try {
      const q = await shotQuote(g.sh, { count: g.n });
      const raw = q.r || {};
      r = { ok: !!(raw.ok && typeof raw.amount === 'number'),
        reason: String(raw.reason || (raw.ok ? '平台没有给出可相加的金额' : '平台没有报出这一档的价')),
        amount: raw.amount,
        currency: (q.prov && q.prov.pricing && q.prov.pricing.currency) || '' };
    } catch (e) { r = { ok: false, reason: errText(e, '询价失败') }; }
    sweepGaQuoteCache();
    gaQuoteCache.set(ck, { at: Date.now(), r });
    rows.push(Object.assign({ n: g.n }, r));
  }
  const sum = sumQuotes(rows.map(r => ({ ok: r.ok, amount: r.amount, currency: r.currency })));
  return {
    sum,
    unpriced: rows.filter(r => !r.ok).reduce((n, r) => n + r.n, 0),
    firstWhy: (rows.find(r => !r.ok) || {}).reason || '',
    groups: groups.size,
  };
}
/* 「生成全部分镜」按钮的文案与可用状态跟生成计划**同一份**（genAllPlan）：计划一变，两处一起变，
   不会出现「写着可生成 2 镜，按钮却说是全部」。600ms 去抖、只在前台改。
   状态区只有进度条，不写文案：不能生成的原因与条数都放进按钮的 title。 */
let gaEstTimer = null;
function dirForeground() {
  try { return window.__spaActivity.visible('director.html'); } catch (e) { return true; }
}
function refreshGenAllBtn() {
  if (genAllRun) return;
  clearTimeout(gaEstTimer);
  gaEstTimer = setTimeout(() => {
    gaEstTimer = null;
    const btn = $('genAll');
    if (!btn || !dirForeground()) return;
    const plan = genAllPlan();
    const can = plan.ok.length + plan.wait.length;
    btn.textContent = can ? ('生成 ' + can + ' 个分镜') : '生成全部分镜';
    btn.disabled = !can;
    btn.title = can
      ? ('这一轮会提交 ' + can + ' 个分镜' + (plan.bad.length ? '，另有 ' + plan.bad.length + ' 镜现在不能生成' : ''))
      : !allShots().length ? '还没有分镜'
      : !plan.bad.length ? '全部镜头已生成，要重跑先删掉那一镜的候选'
      : (plan.bad.length + ' 镜不能生成：'
        + (plan.bad[0].name || '未命名镜头') + '：' + plan.badWhy.get(plan.bad[0]));
  }, 600);
}
let genAllRun = null;            // 正在跑的那一批（切换短片 / 收尾时读它）
function abortGenAll(why) {
  if (!genAllRun) return;
  genAllRun.abort = why;
  /* 唤醒所有等待：执行器会按「上一镜没成」把等它的那些标成 blocked，然后收尾。 */
  /* w.resolve 是 Promise 的 resolve：已结算再唤醒不会抛；这里只是防止一枚坏掉的等待
     拖住「停止」这一步，它后面的收尾仍要继续。 */
  chainWaits.forEach(w => { try { w.resolve(false); } catch (e) { /* resolve 本身不会失败，见上 */ } });
  chainWaits.clear();
}
async function runGenAll(plan) {
  const runProj = projOf();
  const run = { runProj, abort: '', waitSince: new Map(), targets: plan.ok.concat(plan.wait) };
  genAllRun = run;
  const alive = () => !run.abort && projOf() === runProj && wsOf().curId === runProj.id;
  const submitted = new Set();
  /* 本批里的依赖目标先挂好 deferred：依赖方开始等的时候，它可能还没轮到提交（状态是 todo）。 */
  plan.deps.forEach(prev => armChainWait(prev));
  let outs = [];
  try {
    outs = await runWithDeps({
      items: run.targets,
      deps: plan.deps,
      limit: GEN_CONCUR,
      stateOf: sh => chainStateOf(sh),
      wait: dep => {
        if (!alive()) return Promise.resolve(false);
        if (!run.waitSince.has(dep)) run.waitSince.set(dep, Date.now());
        return waitShotDone(dep).finally(() => run.waitSince.delete(dep));
      },
      onBlocked: sh => { settleShot(sh); },
      run: async sh => {
        if (!alive()) throw new Error('已停止（切换了短片）');
        /* 计划是一分钟前算的：真轮到这一镜时按**现在**的顺序再认一次上一镜。
           用户改了顺序 / 删了镜头就宁可不生成，也不能把 A 的尾帧接到 B 上。 */
        if (sh.linkPrev === 'tail' && !sh.firstFrame) {
          const live = allShots();
          const li = live.indexOf(sh);
          const livePrev = li > 0 ? live[li - 1] : null;
          if (livePrev !== (plan.prevMap.get(sh) || null)) {
            throw new Error('镜头顺序在生成期间变了，这一镜没有提交；请重新点「生成全部分镜」');
          }
        }
        /* 占位只在真正轮到这一镜时才建：等待中的镜头提前冒出「创建中」，用户会以为已经在花钱了。 */
        const n = Math.max(1, Number(sh.draw) || 1);
        const phs = pushPlaceholders(sh, n);
        const stopErr = new Error('已停止（切换了短片）');
        let okN = 0, firstErr = null;
        try {
          for (let i = 0; i < phs.length; i++) {
            if (!alive()) {
              /* 没提交的那几条不能留着「创建中」：它们永远拿不到任务号。 */
              for (let j = i; j < phs.length; j++) {
                phs[j].status = 'cancelled';
                phs[j].error = '已停止（切换了短片），这一条没有提交';
              }
              throw stopErr;
            }
            try { await submitCandidate(sh, phs[i]); okN++; submitted.add(sh); }
            catch (e) { firstErr = firstErr || e; }
          }
          if (!okN) throw firstErr || new Error('没有提交成功任何一条');
          return okN;
        } finally {
          settleShot(sh);           // 提交失败 / 全部失败的那一镜立刻唤醒等它的镜头
        }
      },
    });
  } finally {
    chainWaits.clear();
    genAllRun = null;
  }
  const aborted = !!run.abort || projOf() !== runProj;
  if (aborted) {
    Toast.warn('生成全部分镜已停止：' + (run.abort || '切换了短片'));
    return;
  }
  const failedShots = outs.filter(r => r && !r.ok && !r.blocked).length;
  loadCredits();
  /* 这一批真发出去的请求体：按镜头逐条折叠列在结果下面（RawRequest 那一条会话内存快照）。 */
  const raw = $('genAllRaw');
  if (raw) {
    const tags = [...submitted].map(sh => 'dir:shot:' + sh.id);
    raw.hidden = !(window.RawRequest && tags.length);
    raw.innerHTML = raw.hidden ? '' : RawRequest.htmlList(tags, { className: 'gen-all-raw' });
    if (!raw.hidden) RawRequest.bind(raw);
  }
  renderAll();
  if (failedShots) {
    setStatus('<span class="err">有 ' + failedShots + ' 镜提交失败：它们现在算「一条都没成」，'
      + '再点「生成全部分镜」只会补它们（已成功的镜头不会重投）</span>');
  }
}
/* 点「生成全部分镜」：先按**眼下**的镜头重算计划、现问一次价，再让用户确认。
   取消时一个占位都不建、一个请求都不发。 */
async function genAllConfirm(plan, q) {
  const n = plan.ok.length + plan.wait.length;
  const cands = plan.ok.concat(plan.wait).reduce((a, sh) => a + Math.max(1, Number(sh.draw) || 1), 0);
  const price = q.sum.mixed
    ? '<span class="dlg-warn">多币种，无法合计：' + q.sum.byCurrency.map(x => esc((x.currency || '?') + ' ' + x.amount)).join(' / ') + '</span>'
    : q.sum.priced
      ? '预计 <b>' + q.sum.total + '</b> ' + esc(q.sum.currencies[0] || '')
      : '<span class="dlg-warn">报价不可用' + (q.firstWhy ? '：' + esc(q.firstWhy) : '') + '</span>';
  const badHTML = plan.bad.length
    ? '<div class="dlg-warn">不能生成 ' + plan.bad.length + ' 镜：'
      + plan.bad.slice(0, 5).map(sh => esc((sh.name || '未命名') + '（' + plan.badWhy.get(sh) + '）')).join('；')
      + (plan.bad.length > 5 ? '；等共 ' + plan.bad.length + ' 镜' : '') + '</div>'
    : '';
  const v = await UiDialog.open({
    title: '生成全部分镜',
    sub: '先看清这一次要提交多少、花多少；取消不会建占位、也不会发请求。',
    body(el) {
      el.innerHTML = '<div class="dlg-line">将生成 <b>' + n + '</b> 镜'
        + (cands > n ? '（共 ' + cands + ' 条）' : '') + '。' + price + '</div>'
        + (plan.wait.length ? '<div class="dlg-line">其中 <b>' + plan.wait.length + '</b> 镜要等上一镜出画面后才提交（等待不占并发名额）。</div>' : '')
        + (q.unpriced ? '<div class="dlg-warn">另有 ' + q.unpriced + ' 镜报价不可用' + (q.firstWhy ? '（' + esc(q.firstWhy) + '）' : '') + '；它们照常生成，按平台实际结算。</div>' : '')
        + badHTML
        + '<div class="dlg-hint">报价为平台参数询价，不等于最终结算。</div>';
    },
    actions: [{ label: '取消', value: null }, { label: '开始生成', value: 'go', primary: true }],
  });
  return v === 'go';
}
  /* 上次没跑完的画面切片：任务号在创建那一刻就落在关键帧上（kfGenOpts 的 onTask），
     开机时把「还在排队 / 生成中」的那几张认回来（AI 生成要几十秒，关页 / 换设备很常见）。
     没有任务号的几张是「提交还没发出去页面就关了」—— 如实标成失败（右栏可重试），
     不让它们永远转圈：占位卡不能自动变的那一类，一半就出在这里。 */
  async function resumeKeyframes() {
    const jobs = [];
    let dirty = false;
    for (const p0 of (wsOf().projects || [])) {
      for (const sc of (p0.scenes || [])) for (const sh of (sc.shots || [])) {
        (sh.keyframes || []).forEach((kf, i) => {
          if (!kf || kf.deleted) return;
          if (kf.status !== 'queued' && kf.status !== 'generating') return;
          if (!kf.taskId) { kf.status = 'failed'; kf.err = '上次生成被中断（页面关掉了），可以重试'; dirty = true; return; }
          jobs.push({ sh: sh, kf: kf, i: i });
        });
      }
    }
    if (!jobs.length) { if (dirty) { renderSoft(['edit']); scheduleSave(); } return; }
    if (!window.AiGen || !window.AiGen.adopt) return;
    let done = 0, failed = 0;
    for (const job of jobs) {
      const kf = job.kf;
      kf.status = 'generating';
      try {
        const pick = kfModelOf();
        const provId = kf.provider || (pick.prov && pick.prov.id) || '';
        const e = await window.AiGen.adopt(provId, kf.taskId, { want: 1, prompt: kf.imgPrompt || '' });
        const aid = e && e.assetId;
        if (!aid) throw new Error('平台没有返回产物号');
        kf.assetId = aid; kf.status = 'done'; kf.err = null;
        addKeyframeToRefs(job.sh, aid, kf, job.i);
        done++;
      } catch (err) {
        kf.status = 'failed';
        kf.err = '上次没等完：' + (window.errText ? window.errText(err) : ((err && err.message) || err));
        failed++;
      }
      renderSoft(['edit']); scheduleSave();
    }
    loadCredits();
    setStatus('<span class="ok">✓ 认回了上次的画面切片 ' + done + ' 张</span>'
      + (failed ? '<span class="err"> · ' + failed + ' 张没认回来（右栏可重试）</span>' : ''));
  }

  /* 开机核对「待建素材」占位符：`@待建:名字` 的回填靠 `wb:char-pic` 事件，而那个监听住在
     导演台模块里 —— 一次会话里从没打开过导演台、先去素材库把素材图出好了，事件就没人接，
     提示词里的占位符与「图挂进参考图」都不会发生。这里把「占位符还在、库里那条已经有图」
     的补一遍；判据全走 Panel.addLibPicToShot（能力声明 / 互斥 / 上限 / 去重一处都不重写）。
     幂等：换成真名之后 pendingIn 就找不到它，下一次开机不再碰。 */
  function reconcilePendingPics() {
    if (!window.Chars || !window.Chars.Lib || !Panel || !Panel.addLibPicToShot) return;
    const B = BoardAssetsOf();
    if (!B) return;
    const lib = window.Chars.Lib.list() || [];
    if (!lib.length) return;
    let touched = 0, pics = 0;
    lib.forEach(entry => {
      const nm = String((entry && entry.name) || '').trim();
      if (!nm) return;
      const pic = (window.Chars.refPicOf ? window.Chars.refPicOf(entry)
        : (window.Chars.picOf ? window.Chars.picOf(entry) : '')) || '';
      if (!pic) return;                    // 还没出图：占位符照旧留着，等出图那次再补
      const shots = B.shotsPending(allShots(), nm);
      shots.forEach(sh => {
        const resolved = B.resolve(String(sh.prompt || ''), nm, nm);
        sh.prompt = resolved;
        /* 与 char-pic 那一路同一条：候选里的提示词也是给生成用的（框里显示的就是它），
           含占位符的每一条都换 */
        (sh.candidates || []).forEach(c => {
          if (c && c.prompt && B.isToken(c.prompt)) c.prompt = B.resolve(String(c.prompt), nm, nm);
        });
        touched++;
        const one = Panel.addLibPicToShot(sh, entry, null);
        if (one && one.ok && !one.dup) pics++;
      });
    });
    if (!touched) return;
    renderAll(); scheduleSave();
    setStatus('<span class="ok">✓ 素材图已就位：' + touched + ' 镜的待建占位已换成真名'
      + (pics ? '，并补进 ' + pics + ' 个镜头的参考图' : '') + '</span>');
  }

  return {
    /* 轮询与提交 */
    voiceAssetBase, announceDoneCandidates, submitCandidate, drawShot, shotHasVideo, genBtnLabel,
    spawnCandidateShot, pollKick: () => poller.kick(), resumeKeyframes, reconcilePendingPics,
    /* 接续与批量：状态、计划、报价、执行与停止；genAllRun 只以「有没有在跑」出去，批次对象不外泄 */
    chainStateOf, genAllPlan, genAllQuote, genAllConfirm, runGenAll, refreshGenAllBtn,
    abortGenAll, genAllRunning: () => !!genAllRun,
  };
}
