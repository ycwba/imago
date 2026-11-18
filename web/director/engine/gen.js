/* 导演台生成域：分镜的提交、平台任务轮询、自动镜像投递与「生成全部分镜」的
   依赖式批量调度（报价 / 接续等待 / 并发窗口 / 实时进度）。engine.js 只留状态与接线
   （内部保持命令式、按域拆模块）。
   引擎状态一律经 createGen(E) 递进来的访问器读写；短片的身份（proj / WS / REG）每次现读，
   不在这一份里缓存 —— 切换短片、清缓存、导入工程都会换掉它们。 */
import { hasTailFrame, quoteKeyOf, sumQuotes, runWithDeps } from '../chain.js';
import { candidateBase, voiceBase, shotCtxOf, candidateIndex } from '../naming.js';
import {
  cloneTakeOf, defaultTakeOf, originOf, setTakePrompt, shotHasVideo, shotVideoDone, shotPromptOf,
  takeBatchOf, takePromptOf, takeStatusZh,
} from '../takes.js';

export function createGen(E) {
  const {
  cfg,
    $, canStatus, uid, mkCandidateBase, allShots, curScene, ensureChainModel, chainWaitWhy,
    resolveChainFrame, scheduleSave, dlStage, assetStoreId, sameAssetSpace, loadCredits,
    updateMidLive, sortCandidates, provById, saveScheduleSoft, saveScheduleSlow, renderScenesLive, curDraftCand,
    applyRefSyntax, refTokenize, resolvedModel, ROLE_ZH, comboLabel, shotUsedRoles, shotCombo,
    shotInputCaps, shotAdvCtx, shotAdvExtras, shotKeyframes, shotInputEntries, NO_PROMPT_WHY,
    shotBlockReason, provOf, needProv, shotQuote, renderAll, updateProjUI,
    shotPolishOf,
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
/* 这一批候选已经投过自动镜像。**只在内存里**（WeakSet，不写进候选对象）：
   以前是 `c._mirrorAnnounced`，会跟着 .data/workspace.json 与项目文件一起序列化出去 ——
   换机器导入后每一条都带着「已投过」，历史补扫整批跳过，候选永远不落盘。 */
const announcementSent = new WeakSet();
/* fresh = 这一条是**这一轮刚生成出来的**（只有 pollOne 那一处传 true）。
   它决定要不要打 mustSave：导演台刚生成的作品不受「历史产物自动存本机」开关管；
   而开机 / 导入后的历史补扫只是「补齐以前没存的」，必须听开关的，否则关掉开关的人
   一打开老工程就会被强制下载几十上百条历史候选。 */
function announceAssetDone(c, shRef, fresh) {
  if (!c || typeof c !== 'object' || announcementSent.has(c)) return;
  const src = String(c.url || (c.assetId ? Api.assetSrc(c.assetId) : ''));
  if (!src) return;
  announcementSent.add(c);
  window.AssetLocal.announce([{
    /* 导演台自己刚生成的候选：不受设置页「历史产物自动存本机」开关管（那个开关只管历史补齐）。
       作品没落到本机，项目文件导出 / 换设备 / 离线回看就全靠不住 —— mustSave 见 local.js。 */
    mustSave: !!fresh,
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
    /* 起点扫**所有短片**（不只是当前这一部）：切走之后跑完的候选同样要投自动镜像。
       这一趟是**历史补扫**，不传 fresh —— 关掉「历史产物自动存本机」的人不该因为
       打开老工程就被强制下载一批旧候选（只有真正刚生成的那一条才 mustSave）。 */
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
  /* 落盘分两档：**硬信号**（状态 / 地址 / 时长 / 错误 / 价格 / 资产号 / 选用 / 队列位）任一变了
     走 300ms 软保存；只有 progress 在动时走 10s 慢保存 —— 以前 progress 每轮都变，
     每 3 秒一次整份工作区序列化 + IndexedDB + 镜像 POST，正是生成期卡顿的主要来源之一。
     任务号一落盘就等于已付的钱：拿任务号属于硬信号（assetId 变了必走快保存）。 */
  const dHard = [c.status, c.url, c.duration, c.error, c.priceText, c.priceMicros, c.assetId, c.queue_position, sh.selId].join('|');
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
        if (p.done) announceAssetDone(c, sh, true);      // 真·刚生成：mustSave，见 announceAssetDone
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
    sortCandidates(sh);                                  // 生成的往前排、排队/生成中的往后排
    /* 这一条刚落定（出画面 / 失败）就叫醒等它尾帧的接续镜：批量执行器挂在 `waitShotDone`
       上，晚一轮就是一个轮询间隔的白等；重复调用无副作用（`settleShot` 只认落定状态）。 */
    settleShot(sh);
    const hardSig = [c.status, c.url, c.duration, c.error, c.priceText, c.priceMicros, c.assetId, c.queue_position, sh.selId].join('|');
    if (hardSig !== dHard) saveScheduleSoft();
    else if (c.progress !== dProgress) saveScheduleSlow();
    /* 左栏只在真的变了时才重画（见上面 dStatus 那段）：走 scenesLive —— 结构签名没变时
       只就地改进度条，整列重建留给真正的结构变化（完成 / 失败 / 顺序变动）。 */
    if (mine && (c.status !== dStatus || c.progress !== dProgress || c.url !== dUrl || sh.selId !== dSel)) scenesDirty = true;
    if (mine) {
      if (scenesDirty) { scenesDirty = false; renderScenesLive(); }
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
/* 建一条**新的候选镜头**：从源候选（默认那条）克隆提示词与全套配置 ——
   它不是「空壳占位」，是一条**完整可用**的候选镜头（自己的描述、自己的型号与素材）。
   批量生成只在这一镜张数不够时才建它；已有的待生成候选一律**就地更新状态**，不另建替代品。 */
function pushPlaceholders(sh, count, origin = 'auto', text = null) {
  const phs = [];
  const src = defaultTakeOf(sh) || (sh.candidates || [])[0] || null;
  for (let k = 0; k < count; k++) {
    /* 字段清单归 mkCandidateBase / cloneTakeOf 那一份；这里只补「已经提交出去了」才有的两项：
       占位状态、平台回的价格文案。请求时长在 `dur`，产物时长在 `duration`（两件事）。 */
    const ph = cloneTakeOf(sh, src, uid);
    ph.origin = origin;
    ph.status = 'creating';
    ph.priceText = '';
    ph.duration = undefined;
    if (text != null) ph.prompt = text;
    phs.push(ph);
    sh.candidates.push(ph);
  }
  renderAll(); scheduleSave();
  return phs;
}
async function submitCandidate(sh, ph) {
  const p = String(takePromptOf(sh, ph)).trim();
  ph.origin = originOf(ph);
  /* 这一条的描述就是它自己的：没有「沿用画面」那一层了 —— 提交时发出去的就是这句。 */
  /* 占位符原样发出去 = 模型收到一个它不认识的 token：素材还没出图时提一句，
     别等成片出来才发现画面不对（导出前那道提醒在 export.js，这一道管提交）。 */
  if (/@待建:/.test(p)) Toast.warn('提示词里还有 @待建:… 的占位（素材还没出图）：这次会原样发给平台，出图后建议重生成这一镜');
  ensureChainModel(sh, ph);                     // 接续镜头先落到支持首帧的型号上，再问能力与报价
  const rm = resolvedModel(ph);
  if (!rm) throw new Error('没有支持这一镜素材的型号（当前输入：' +
    (shotUsedRoles(ph).map(r => ROLE_ZH[r] || r).join(' / ') || '纯文字') + '）：换一个支持它的型号，或清空这组素材');
  /* 时长按**真正发请求这一家**再夹一次：落盘那一夹（clampShotDurations）可能发生在
     接续型号落定之前 —— ensureChainModel 换到的另一家 min/max 不同，越界值发出去就是一句 4xx。 */
  const durPlan = videoPlanOf(sh, ph).kinds.duration;
  if (durPlan.list.length && Number(ph.dur) !== Number(durPlan.value)) {
    ph.dur = Number(durPlan.value);
    scheduleSave('时长按型号收正');
  }
  const modelId = rm.id;
  /* 提交这一下必须用 needProv：认不出平台就**停下并说清**，绝不默默发给另一家
     （见 provOf 那段注释 —— 那个兜底正是「model must match …/…」这个看不懂的报错的来源）。 */
  const prov = needProv(rm.provider, (rm.name || modelId));
  const icSub = shotInputCaps(ph);
  /* 这一镜手上的素材与当前输入模式说不通的地方（缺料 / 超料 / 不收 / 互斥），提交前照界面同一份
     判据兜一次：走到这里说明是导入 / 历史数据留下的状态，界面已经拦过一遍了。
     ⚠ 绝不静默丢掉素材 —— 用户传进去的东西要么发出去，要么把原因说出来。 */
  const gapLines = (icSub.gaps && icSub.gaps.lines) || [];
  /* 这一镜手上的素材（提交与归档文案都按同一份数）：画面切片只数真的有资产号的，
     生成失败或被删掉的不能算「已带上」。 */
  const kfs = shotKeyframes(ph);
  /* @名字 → @参考图N → 平台声明的引用语法。归档那一份存的是**原始**描述（还是 @名字，
     人看得懂、复用也方便），只有真正发出去的 body 用转换后的。 */
  const pApi = applyRefSyntax(refTokenize(ph, p, icSub), prov);
  /* 高级设置那一读要**在归档之前**做完：摘要里写的是「这一次真的发出去了哪些顶层开关」，
     先拼好文案才不会出现「归档写着平台润色、提交体里根本没有」这种自相矛盾的存档。 */
  const ex = shotAdvExtras(ph);
  const ctxAdv = shotAdvCtx(ph);
  const cbAdv = shotCombo(ph);
  try {
      // 放在 try 里：抛错时占位候选会被标成「失败」，不会留下一堆排队中的僵尸占位
      if (gapLines.length) throw new Error(gapLines.join('；') + '（' + (rm.name || modelId) + '）');
      /* 越界的形状字段（种子、超分档那种）当场拒掉，不发一个必然被上游驳回的请求：
         界面已经压暗并写了原因，走到这里说明是导入 / 历史数据留下的值。 */
      if (ex.bad.length) throw new Error(ex.bad.join('、'));
      const videoTemplate = Api.inputTemplate(prov, 'reference_video');
      if (icSub.refVideo && ph.refVideo && videoTemplate?.requiresAudio && ph.refVideo.preparedFor !== prov.id) {
        const ref = ph.refVideo;
        const source = ref.src || (sameAssetSpace(ref.provider, assetStoreId()) && ref.asset_id ? Api.assetSrc(ref.asset_id) : '');
        if (!source) throw new Error('这份旧参考视频未检查音轨，请重新选择原视频；上传时会自动补静音音轨');
        ref.asset_id = await AssetTransfer.toAsset(prov.id, source, { reg: regOf(), name: ref.name, role: 'reference_video', onStage: dlStage('参考视频') });
        ref.provider = prov.id;
        ref.preparedFor = prov.id;
        scheduleSave();
      }
      /* 接上一镜尾帧：只在这一刻解析（上一镜可能刚刚跑完），显式首帧优先。
         解析结果只做内存缓存，不写工程、不落盘。失败会落进下面的 catch，把这条占位标成失败。 */
      const chainFrame = (ph.linkPrev === 'tail' && !ph.firstFrame) ? await resolveChainFrame(sh, ph) : null;
      const nFrame = (ph.firstFrame ? 1 : 0) + (ph.lastFrame ? 1 : 0) + (chainFrame ? 1 : 0);
      /* 归档到提示词文件夹时要写在文件头里的信息：存**原始**描述（含 @参考图N 的写法，
         比平台语法更好复用），镜头名 + 时长/画幅等参数一并记下。见 PromptLog
         「输入模式」也要记：同一句提示词在「智能参考」与「视频换人」下发出去的是两种请求、
         两种价，隔一个月回看这个文件的人（往往就是用户自己）得知道当时按哪一种出的。 */
      const log2 = { type: '导演台-分镜', prompt: p, meta: {
        镜头: sh.name || '', 模型档位: ph.tier, 分辨率: ph.res, 画幅: ph.ar, 尺寸: ph.size || '',
        时长: ph.dur ? ph.dur + 's' : '',
        输入模式: cbAdv ? comboLabel(cbAdv) : '',
        顶层参数: ex.summary,
        参考素材: [nFrame ? nFrame + ' 帧' : '', chainFrame ? '接上一镜尾帧' : '',
          kfs.length ? kfs.length + ' 关键帧' : '',
          (ph.refImages || []).length ? ph.refImages.length + ' 参考图' : '',
          ph.refVideo ? '参考视频' : '', ph.refAudio ? '参考音频' : ''].filter(Boolean).join(' / ') } };
      /* 提交体完全交给 `Api.createBody` + registry 声明（与工作台同一条路）：
         标准字段往哪个上游字段名映射、哪些要嵌进 parameters、顶层开关与形状字段怎么过滤、
         素材按什么形状进请求体，全是声明里的事，页面不抄第二份。 */
      const v = await Api.request(prov, 'create', { method: 'POST', log: log2,
        body: Api.createBody(prov, {
          model: modelId, prompt: pApi, tier: ph.tier, duration: ph.dur || undefined,
          res: ph.res, ar: ph.ar, size: ph.size,
          note: sh.name || '',                       // 只有声明了 acceptsNote 的那一族会真的带上（见 Api.createBody）
          inputEntries: await shotInputEntries(ph, prov, icSub, chainFrame),
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
      duration: v.duration || null, error: null, created: ph.created || Date.now(), prompt: ph.prompt,
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
   promptText 缺省读当前候选的有效描述（按钮那一档传提示词框里正显示的那一句）。
   每条候选都带自己那一句描述（没有「沿用画面」那一层了）：
   张数不够时补建的那几条克隆自默认候选。 */
async function drawShot(sh, count, promptText) {
  const p = String(promptText != null ? promptText : takePromptOf(sh, null)).trim();
  if (!p) throw new Error(NO_PROMPT_WHY);
  /* 新建的候选克隆自默认候选（提示词与全套配置一起克隆），描述就是这一句 ——
     没有「沿用画面」那一层了，每条候选只管自己那份。 */
  const phs = pushPlaceholders(sh, count, 'manual', p);
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
/* 「生成」那颗按钮这一刻会做什么，文案与 #genOne 的分支同一判据（shotHasVideo）：
   已经有视频时点它是「开一条新镜头再来一版」，不再说「生成这一镜」。 */
const genBtnLabel = sh => shotHasVideo(sh)
  ? '生成新候选镜头（' + (sh.draw || 1) + ' 条）'
  : curDraftCand() ? '生成这条' : '生成这一镜（' + (sh.draw || 1) + ' 条）';
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

/* 这一批到底要提交哪些镜头、每镜提交哪几条候选、谁在等谁、哪些现在就不能生成。
   纯读（只顺带把接续型号落到候选上）。
   `takes` / `fresh` / `counts` 是同一张计划里的三份：
     · takes  = 这一镜**就地更新**的那几条已有候选（草稿 + 描述非空）—— 不另建替代品；
     · fresh  = 还差多少张数才补建的克隆（克隆自带提示词与配置，是这一镜本来就该有的张数）；
     · counts = 这一镜这次一共提交几条（报价、确认、执行共用同一份快照）。 */
function genAllPlan() {
  const all = allShots();
  all.forEach(sh => (sh.candidates || []).forEach(c => ensureChainModel(sh, c)));
  const todo = all.filter(sh => !hasRealCandidate(sh) || shotAllFailed(sh));
  const inBatch = new Set(todo);
  const prevOf = sh => { const i = all.indexOf(sh); return i > 0 ? all[i - 1] : null; };
  const ok = [], wait = [], bad = [];
  const deps = new Map(), badWhy = new Map();
  const takes = new Map(), fresh = new Map(), counts = new Map();
  /* 计划时的上一镜：执行到某一镜时拿它和「现在的顺序」再比一次（用户中途改顺序 / 删镜头）。 */
  const prevMap = new Map();
  todo.forEach(sh => {
    prevMap.set(sh, prevOf(sh));
    /* 这一镜这次提交哪几条：已有的待生成候选（就地更新状态）+ 还差张数才补建的克隆。 */
    const b = takeBatchOf(sh);
    const list = b.usable;
    takes.set(sh, list);
    fresh.set(sh, b.need);
    counts.set(sh, list.length + b.need);
    /* 可生成性按这一镜**会真的发出去的第一句**判（提示词字数上限、空提示词都是逐句的事）。 */
    const firstText = list.length ? takePromptOf(sh, list[0]) : '';
    const why = list.length
      ? shotBlockReason(sh, null, firstText, list[0])
      : shotBlockReason(sh, null, '', cfg(sh));
    if (!why) { ok.push(sh); return; }
    /* 只有「纯等待」能进 wait：上一镜在本批、或正在跑。别的都是现在真的不能生成
       （提示词空 / 素材冲突 / 型号接不了首帧 / 上一镜失败…）。
       接续标记在候选身上：这一镜里只要有一条候选挂着接续，就等上一镜出画面。 */
    const chained = list.filter(c => c.linkPrev === 'tail' && !c.firstFrame);
    const cw = chained.length ? chainWaitWhy(sh, chained[0]) : '';
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
    const list = takes.get(sh) || [];
    if (!list.some(c => c.linkPrev === 'tail' && !c.firstFrame)) return;
    const prev = prevOf(sh);
    if (prev && chainStateOf(prev) !== 'done') deps.set(sh, prev);
  });
  return { todo, ok, wait, bad, badWhy, deps, prevMap, takes, fresh, counts };
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
    /* 报价按**候选**算：这一镜的几条候选各有各的型号 / 时长 / 形状，
       键一样的那几条并成一次询价（条数递 count）。 */
    const units = (plan.takes.get(sh) || []).slice();
    /* 补建的克隆还没建出来：它们克隆自默认候选，配置一模一样 —— 用默认候选那份键。 */
    const def = defaultTakeOf(sh);
    const freshN = (plan.fresh && plan.fresh.get(sh)) || 0;
    if (freshN && def) for (let k = 0; k < freshN; k++) units.push(def);
    units.forEach(u => {
      ensureChainModel(sh, u);
      const rm = resolvedModel(u) || {};
      const prov = provOf(rm.provider);
      const ex = shotAdvExtras(u);
      const ctx = shotAdvCtx(u);
      const key = quoteKeyOf(u, { provider: prov && prov.id, model: rm.id,
        intent: ctx.intent, mode: ctx.mode, topBools: ex.topBools, shapeFields: ex.shapeFields,
        caps: ctx.caps, combo: u.combo });
      let g = groups.get(key);
      if (!g) { g = { sh, u, n: 0, key }; groups.set(key, g); }
      g.n += 1;
    });
  });
  const rows = [];
  for (const g of groups.values()) {
    const ck = g.key + '|' + g.n;
    const hit = gaQuoteCache.get(ck);
    if (!fresh && hit && Date.now() - hit.at < GA_QUOTE_TTL) { rows.push(Object.assign({ n: g.n }, hit.r)); continue; }
    let r;
    try {
      const q = await shotQuote(g.u || g.sh, { count: g.n });
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
   不会出现「写着可生成 2 镜，按钮却说是全部」。1.5s 去抖、只在前台改 —— 计划本身不便宜
   （逐候选收正接续型号），updateProjUI 在每一轮轮询与每次重画后都会被叫。
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
    const reuseN = plan.ok.concat(plan.wait).reduce((a, sh) => a + ((plan.takes.get(sh)) || []).length, 0);
    const freshN = plan.ok.concat(plan.wait).reduce((a, sh) => a + ((plan.fresh.get(sh)) || 0), 0);
    btn.textContent = can ? ('生成 ' + can + ' 个分镜') : '生成全部分镜';
    btn.disabled = !can;
    btn.title = can
      ? ('这一轮会提交 ' + can + ' 个分镜' + (reuseN || freshN
        ? '（共 ' + (reuseN + freshN) + ' 条候选镜头：' + (reuseN ? reuseN + ' 条就地更新已有候选' : '')
          + (reuseN && freshN ? '，' : '') + (freshN ? freshN + ' 条按张数补建' : '') + '）' : '')
        + (plan.bad.length ? '，另有 ' + plan.bad.length + ' 镜现在不能生成' : ''))
      : !allShots().length ? '还没有分镜'
      : !plan.bad.length ? '全部镜头已生成，要重跑先删掉那一镜的候选'
      : (plan.bad.length + ' 镜不能生成：'
        + (plan.bad[0].name || '未命名镜头') + '：' + plan.badWhy.get(plan.bad[0]));
    /* 润色那颗与它同一时机刷（同一帧读数）：文案/镜头一变，两颗按钮一起说真话。 */
    refreshPolishAllBtn();
  }, 1500);
}
let genAllRun = null;            // 正在跑的那一批（切换短片 / 收尾时读它）
/* 本次批量里「正在等上一镜」的镜头（计划里带依赖的那些）：左栏行、顺序条、候选占位与
   中栏空态都读这一句。点按钮之后新加的镜头不在这一份里 —— 它们没被这次批量排进计划，
   也就不该说「在等」。这一镜自己的候选已经提交出去（创建中 / 排队 / 在跑）就不算等：
   那时的说法是「生成中」，不是「等上一镜」。 */
let genWaitIds = new Set();
function genAllWaitOf(sh) {
  if (!sh || !genWaitIds.has(sh.id)) return '';
  const c = (sh.candidates || []).find(x => x && x.linkPrev === 'tail' && !x.firstFrame);
  if (!c || ['creating', 'queued', 'running'].includes(c.status)) return '';
  const all = allShots();
  const i = all.indexOf(sh);
  const prev = i > 0 ? all[i - 1] : null;
  return '等待上一镜生成中' + (prev && prev.name ? '（等「' + prev.name + '」出画面再接尾帧）' : '');
}

/* ---------------- 生成全部分镜的范围选择 ----------------
   与「润色全部文案」的范围弹窗同一副骨架（芯片切显示、勾选跨芯片保留），也是**两级**：
   镜头行管它名下所有候选（头上的勾一按全开 / 全关），候选行各自可勾 ——
   已有的待生成候选一条一行；「按张数补建 N 条」也是一行（整行开关，克隆自默认候选）。
   不能生成的镜头整组置灰并写明原因（不列候选行 —— 它们这一轮发不出去）。
   返回 Map（镜头 → { takes: [候选], fresh: n }，只含勾了东西的镜头）；null = 取消。
   勾完还有报价与确认两道闸，这里不发任何请求。 */
async function genAllScopeDialog(plan) {
  const kindOf = new Map();
  plan.ok.forEach(sh => kindOf.set(sh, 'ok'));
  plan.wait.forEach(sh => kindOf.set(sh, 'wait'));
  plan.bad.forEach(sh => kindOf.set(sh, 'bad'));
  const zhKind = k => k === 'wait' ? '等上一镜' : k === 'bad' ? '不能生成' : '可生成';
  const rows = (plan.todo || []).map(sh => {
    const kind = kindOf.get(sh) || 'ok';
    const on = kind !== 'bad';
    return {
      sh, kind,
      takes: (plan.takes.get(sh) || []).map(c => ({ c, on })),
      fresh: (plan.fresh.get(sh) || 0),
      freshOn: on && (plan.fresh.get(sh) || 0) > 0,
    };
  });
  const byId = new Map(rows.map(r => [r.sh.id, r]));
  const onCount = () => rows.reduce((n, r) => n + r.takes.filter(x => x.on).length
    + ((r.kind !== 'bad' && r.freshOn && r.fresh) ? r.fresh : 0), 0);
  const totalCount = () => rows.reduce((n, r) => n + r.takes.length + r.fresh, 0);
  let listEl = null, sumEl = null, syncGo = () => {};
  const paintScopeSum = () => {
    sumEl.textContent = '已勾选 ' + onCount() + ' / ' + totalCount() + ' 条候选'
      + (onCount() ? '' : '（至少勾一条才能开始）');
    syncGo();
  };
  const v = await window.UiDialog.open({
    title: '生成全部分镜',
    sub: '先勾这一轮要生成哪些候选镜头（镜头行上的勾一键全开 / 全关；不能生成的写明原因）；'
      + '勾完还要报价与确认两步，确认之前不发任何请求。',
    body(el) {
      el.innerHTML = '<div class="pl-scope">'
        + '<div class="pl-scope-chips">'
        + '<button type="button" class="ui-seg on" data-f="all">全部</button>'
        + '<button type="button" class="ui-seg" data-f="can">可生成</button>'
        + '<button type="button" class="ui-seg" data-f="bad">不能生成</button>'
        + '</div>'
        + '<div class="pl-scope-list"></div>'
        + '<div class="dlg-hint pl-scope-sum"></div>'
        + '</div>';
      listEl = el.querySelector('.pl-scope-list');
      sumEl = el.querySelector('.pl-scope-sum');
      const chips = el.querySelectorAll('.pl-scope-chips .ui-seg');
      let filter = 'all';
      const paint = () => {
        const vis = rows.filter(r => filter === 'all'
          || (filter === 'can' ? r.kind !== 'bad' : r.kind === 'bad'));
        listEl.innerHTML = vis.length ? vis.map(r => {
          const sh = r.sh;
          const why = r.kind === 'bad' ? (plan.badWhy.get(sh) || '现在不能生成') : '';
          const waitTag = r.kind === 'wait' ? ' · 等上一镜出画面后提交' : '';
          /* 镜头头的勾 = 全开；一半开一半关摆半选态（与润色范围弹窗同一画法）。 */
          const allOn = r.takes.every(t => t.on) && (r.fresh === 0 || r.freshOn);
          const anyOn = r.takes.some(t => t.on) || (r.freshOn && r.fresh > 0);
          const head = '<label class="pl-shot-head">'
            + '<input type="checkbox" data-role="shot" data-sh="' + esc(sh.id) + '"'
            + (allOn ? ' checked' : '') + (r.kind === 'bad' ? ' disabled' : '') + '>'
            + '<b>' + esc(sh.name || '未命名镜头') + '</b>'
            + '<span class="meta">' + zhKind(r.kind) + ' · ' + (r.takes.length + r.fresh) + ' 条' + waitTag
            + (why ? ' · ' + esc(why) : '') + '</span>'
            + '</label>';
          if (r.kind === 'bad') {
            return '<div class="pl-shot" data-shot="' + esc(sh.id) + '" style="opacity:.6">' + head + '</div>';
          }
          const takeRows = r.takes.map((t, i) => '<label class="pl-take">'
            + '<input type="checkbox" data-role="take" data-sh="' + esc(sh.id) + '" data-i="' + i + '"'
            + (t.on ? ' checked' : '') + '>候选 ' + (i + 1) + '（草稿）'
            + '<span class="meta">' + esc(String((t.c && t.c.prompt) || '').slice(0, 40)) + '</span>'
            + '</label>').join('');
          const freshRow = r.fresh > 0 ? '<label class="pl-take">'
            + '<input type="checkbox" data-role="fresh" data-sh="' + esc(sh.id) + '"'
            + (r.freshOn ? ' checked' : '') + '>按张数补建 ' + r.fresh + ' 条'
            + '<span class="meta">克隆这一镜的默认候选（带全套配置）</span>'
            + '</label>' : '';
          return '<div class="pl-shot" data-shot="' + esc(sh.id) + '" data-any="' + (anyOn ? '1' : '') + '"'
            + ' data-all="' + (allOn ? '1' : '') + '">' + head
            + '<div class="pl-takes">' + takeRows + freshRow + '</div></div>';
        }).join('') : '<div class="empty">这一档没有镜头</div>';
        /* 半选态在重建后补：indeterminate 是属性，进不了 innerHTML 字符串。 */
        [...listEl.querySelectorAll('.pl-shot[data-any]')].forEach(g => {
          const inp = g.querySelector('input[data-role="shot"]');
          if (inp && !inp.disabled && g.dataset.any && !g.dataset.all) inp.indeterminate = true;
        });
        paintScopeSum();
      };
      el.querySelector('.pl-scope-chips').addEventListener('click', e => {
        const b = e.target.closest('button[data-f]');
        if (!b) return;
        filter = b.dataset.f;
        [...chips].forEach(x => x.classList.toggle('on', x === b));
        paint();
      });
      listEl.addEventListener('change', e => {
        const inp = e.target;
        if (!inp || inp.tagName !== 'INPUT' || inp.disabled) return;
        const r = byId.get(inp.dataset.sh);
        if (!r || r.kind === 'bad') return;
        if (inp.dataset.role === 'shot') {
          const on = inp.checked;
          r.takes.forEach(t => { t.on = on; });
          r.freshOn = on && r.fresh > 0;
          paint();
          return;
        }
        if (inp.dataset.role === 'take') {
          const t = r.takes[+inp.dataset.i];
          if (t) t.on = inp.checked;
        } else if (inp.dataset.role === 'fresh') {
          r.freshOn = inp.checked;
        }
        /* 候选行的勾选也要整列重画：镜头头上的勾（全开 / 半选）跟着这一变化走。 */
        paint();
      });
      paint();
    },
    onOpen(el) {
      const dlg = el.closest('dialog');
      const go = dlg && dlg.querySelector('.pr-foot .pri');
      syncGo = () => { if (go) go.disabled = !onCount(); };
      syncGo();
    },
    actions: [{ label: '取消', value: null }, { label: '下一步（报价）', value: 'go', primary: true }],
  });
  if (v !== 'go') return null;
  const sel = new Map();
  rows.forEach(r => {
    const takes = r.takes.filter(t => t.on).map(t => t.c);
    const fresh = (r.kind !== 'bad' && r.freshOn) ? r.fresh : 0;
    if (takes.length + fresh > 0) sel.set(r.sh, { takes, fresh });
  });
  return sel;
}
/* 按勾选收窄计划：ok / wait 只留「勾了东西」的镜头；takes / fresh / counts 按勾选重建
   （原计划的三份账不动）。依赖里上一镜没进批、又不在跑 / 没画面的，等它的那些级联进 bad
   （不然会干等一个永远不会提交的镜头）。返回与 genAllPlan 同形状的一份新计划。 */
function planForSelection(plan, sel) {
  const selMap = sel instanceof Map ? sel : new Map();
  const inBatch = sh => {
    const e = selMap.get(sh);
    return !!e && (e.takes.length + (e.fresh || 0)) > 0;
  };
  const ok = plan.ok.filter(inBatch);
  const deps = new Map();
  const wait = [];
  const bad = plan.bad.slice();
  const badWhy = new Map(plan.badWhy);
  plan.wait.forEach(sh => {
    if (!inBatch(sh)) return;
    const prev = plan.deps.get(sh) || null;
    if (prev && !inBatch(prev) && chainStateOf(prev) !== 'done' && chainStateOf(prev) !== 'running') {
      bad.push(sh);
      badWhy.set(sh, '上一镜「' + (prev.name || '未命名镜头') + '」这一轮没有勾选，接不了它的尾帧');
      return;
    }
    wait.push(sh);
    if (prev) deps.set(sh, prev);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = wait.length - 1; i >= 0; i--) {
      const sh = wait[i], p = deps.get(sh);
      if (!bad.includes(p)) continue;
      wait.splice(i, 1); deps.delete(sh);
      bad.push(sh);
      badWhy.set(sh, '上一镜不能生成（' + (p.name || '未命名镜头') + '：' + (badWhy.get(p) || '') + '）');
      changed = true;
    }
  }
  const takes = new Map(), fresh = new Map(), counts = new Map();
  ok.concat(wait).forEach(sh => {
    const e = selMap.get(sh) || { takes: [], fresh: 0 };
    takes.set(sh, e.takes.slice());
    fresh.set(sh, e.fresh || 0);
    counts.set(sh, e.takes.length + (e.fresh || 0));
  });
  return { todo: plan.todo, ok, wait, bad, badWhy, deps, prevMap: plan.prevMap, takes, fresh, counts };
}
/* ---------------- 润色全部文案 ----------------
   「生成全部分镜」分裂按钮的尾项：对选中的每一条描述各润一遍（**不反问** —— 批量
   没有一排人等着答题，固定走「跳过问答直接润」）。
   范围弹窗按镜头勾选（每条候选各自成条），过程 4 路并发、逐行流式，
   结束后同一张弹窗换成审阅清单，确认才写回。
   每条的素材附带与系统提示词和单镜润色是同一份（ref.js 的 shotPolishOf），这里不拼第二套。
   与 genAll 并行无害：它只发文字 AI 的请求，不建占位、不发生成任务、不碰 genAllRun。 */
const POLISH_CONCUR = 4;
let polishAllRun = null;         // { ab, runProj, results, failed }
/* 目标集合：每条有描述的候选一条（默认候选也是一条普通目标）。
   auto 候选就是基准本身，不单列；没有文字的目标也不进（没有可润的）。
   key 是写回时的稳定身份（b:<shotId> / t:<shotId>:<vid>），seq 决定结果排序。 */
function polishAllTargets() {
  const all = allShots();
  const targets = [];
  let seq = 0;
  all.forEach(sh => {
    /* 「画面」这一类没有了：每条候选就是一条候选镜头，各带自己那句描述。
       默认候选（这一镜的主描述）也是一条普通目标 —— 它同样可以单独润。 */
    (sh.candidates || []).forEach((c, i) => {
      if (!c) return;
      const own = String(c.prompt == null ? '' : c.prompt).trim();
      if (!own) return;
      const short = '候选 ' + (i + 1) + '（' + takeStatusZh(c) + '）';
      targets.push({ key: 't:' + sh.id + ':' + c.vid, kind: 'take', shot: sh, cand: c, vid: c.vid,
        text: own, short, label: (sh.name || '未命名镜头') + ' · ' + short, seq: seq++ });
    });
  });
  return { targets, skipped: all.length - new Set(targets.map(t => t.shot)).size };
}
function refreshPolishAllBtn() {
  const btn = $('polishAll');
  if (!btn) return;
  if (polishAllRun) {
    btn.textContent = '停止润色';
    btn.disabled = false;
    btn.title = '正在润色；停下后已润好的那几条仍会摆出来确认';
    return;
  }
  const { targets } = polishAllTargets();
  const baseN = targets.filter(t => t.kind === 'base').length;
  const takeN = targets.length - baseN;
  /* 同步近似「能不能润」：选中一家 + 本机有它的密钥（或环境密钥探到过）。
     环境密钥档在点击后还会被 TextAI.canRun 真判一次 —— 这里的闸只管把按钮的话说准。 */
  const pv = window.TextAI ? TextAI.prov(regOf()) : null;
  const hasAI = !!(pv && (TextAI.key(pv)
    || (TextAI._envIds && TextAI._envIds[TextAI.keyId(pv)])));
  btn.textContent = '润色全部文案';
  btn.disabled = !targets.length || !hasAI;
  btn.title = !targets.length ? '还没有写好描述的镜头'
    : !window.TextAI || !pv ? '没有可用的文字 AI 供应商'
    : !hasAI ? '请先在「设置」填文字 AI 密钥'
    : '对 ' + targets.length + ' 条描述各润一遍（画面 ' + baseN + ' 条 / 候选 ' + takeN
      + ' 条；不反问；润完先审阅，确认才写回）';
}
/* 范围弹窗：芯片只切镜头列表的显示（勾选集合跨芯片保留）；镜头行管它名下所有目标，
   目标行各自可勾。底部那格「发给 AI 的备注」整批共用（与拆分镜同一句式，只进这一次请求）。
   一条都没勾时「开始润色」禁用 —— 主按钮在 body 画完之后才建，所以那道闸接在 onOpen 里。 */
async function polishAllScope(targets, skipped) {
  const groups = [];
  const byShot = new Map();
  targets.forEach(t => {
    let g = byShot.get(t.shot.id);
    if (!g) {
      g = { shot: t.shot, items: [], done: shotVideoDone(t.shot) };
      byShot.set(t.shot.id, g);
      groups.push(g);
    }
    g.items.push(t);
  });
  const picked = new Set(targets.map(t => t.key));
  let sumEl = null, listEl = null, noteEl = null, syncGo = () => {};
  const v = await window.UiDialog.open({
    title: '润色全部文案',
    sub: '逐条请 AI 润一遍；先按状态筛选、再逐条勾选。可以备注整批的取向，'
      + 'AI 也可能先问几句整体风格（可在设置里关掉），润完先审阅再写回。'
      + (skipped ? '另有 ' + skipped + ' 镜没有可润的描述，跳过。' : ''),
    body(el) {
      el.innerHTML = '<div class="pl-scope">'
        + '<div class="pl-scope-chips">'
        + '<button type="button" class="ui-seg on" data-f="all">全部</button>'
        + '<button type="button" class="ui-seg" data-f="done">视频已生成</button>'
        + '<button type="button" class="ui-seg" data-f="todo">还没视频</button>'
        + '</div>'
        + '<div class="pl-scope-list"></div>'
        + '<textarea class="pl-note" placeholder="发给 AI 的备注（可选）—— 例：整体偏写实 · 光偏黄昏 · 镜头别太晃"></textarea>'
        + '<div class="dlg-hint pl-scope-sum"></div>'
        + '</div>';
      listEl = el.querySelector('.pl-scope-list');
      sumEl = el.querySelector('.pl-scope-sum');
      noteEl = el.querySelector('.pl-note');
      const chips = el.querySelectorAll('.pl-scope-chips .ui-seg');
      let filter = 'all';
      const paint = () => {
        const vis = groups.filter(g => filter === 'all' || (filter === 'done' ? g.done : !g.done));
        listEl.innerHTML = vis.length ? vis.map(g => {
          const allOn = g.items.every(t => picked.has(t.key));
          return '<div class="pl-shot" data-shot="' + esc(g.shot.id) + '">'
            + '<label class="pl-shot-head"><input type="checkbox" data-role="shot"'
            + (allOn ? ' checked' : '') + '>'
            + '<b>' + esc(g.shot.name || '未命名镜头') + '</b>'
            + '<span class="meta">' + g.items.length + ' 条 · ' + (g.done ? '视频已生成' : '还没视频') + '</span>'
            + '</label>'
            + '<div class="pl-takes">' + g.items.map(t =>
              '<label class="pl-take"><input type="checkbox" data-role="take" data-key="' + esc(t.key) + '"'
              + (picked.has(t.key) ? ' checked' : '') + '>' + esc(t.short) + '</label>').join('')
            + '</div></div>';
        }).join('') : '<div class="empty">这一档没有可润色的条目</div>';
        [...listEl.querySelectorAll('input[data-role="shot"]')].forEach(inp => {
          const g = byShot.get(inp.closest('.pl-shot').dataset.shot);
          inp.indeterminate = !!(g && !inp.checked && g.items.some(t => picked.has(t.key)));
        });
        sumEl.textContent = '已勾选 ' + picked.size + ' / ' + targets.length + ' 条'
          + (picked.size ? '' : '（至少勾一条才能开始）');
        syncGo();
      };
      el.querySelector('.pl-scope-chips').addEventListener('click', e => {
        const b = e.target.closest('button[data-f]');
        if (!b) return;
        filter = b.dataset.f;
        [...chips].forEach(x => x.classList.toggle('on', x === b));
        paint();
      });
      listEl.addEventListener('change', e => {
        const inp = e.target;
        if (!inp || inp.tagName !== 'INPUT') return;
        const g = byShot.get(inp.closest('.pl-shot').dataset.shot);
        if (!g) return;
        if (inp.dataset.role === 'shot') {
          g.items.forEach(t => { if (inp.checked) picked.add(t.key); else picked.delete(t.key); });
        } else if (inp.checked) picked.add(inp.dataset.key);
        else picked.delete(inp.dataset.key);
        paint();
      });
      paint();
    },
    onOpen(el) {
      const dlg = el.closest('dialog');
      const go = dlg && dlg.querySelector('.pr-foot .pri');
      syncGo = () => { if (go) go.disabled = !picked.size; };
      syncGo();
    },
    actions: [{ label: '取消', value: null }, { label: '开始润色', value: 'go', primary: true }],
  });
  return v === 'go'
    ? { targets: targets.filter(t => picked.has(t.key)), note: noteEl ? noteEl.value.trim() : '' }
    : null;
}
/* 润色前那一轮**整体**问答（与拆分镜同一套两段式）：问的是影响整批的取向
   （画风 / 光线 / 镜头语言），AI 自己判断要不要问；设置里选「从不问」整轮跳过。
   返回回答正文（'' = 没问出来 / 跳过）。独立的流程弹窗，问答完就收（批量的过程弹窗随后开）。 */
async function polishAskRound(chosen) {
  if (!TextAI.shouldAsk()) return '';
  const ask = { dead: false, resolve: null };
  const dlg = window.PromptReview.openProcess({
    title: 'AI 正在准备润色…',
    sub: '先判断要不要问几个整体取向的问题；跳过就直接开始润色。',
    onAbort() {
      ask.dead = true;
      const u = ask.resolve; ask.resolve = null;
      if (u) u(null);              // null = 取消（区别于「跳过」的空串）：整批不开跑
    },
  });
  const body = dlg.querySelector('#prBody');
  InlinePolish.loading(body, '正在读这一批镜头的提示词，判断要不要先问几个问题…');
  const sys = '你是专业视频提示词指导。用户即将对一批镜头的画面提示词做整体润色（每条各润一遍）。'
    + '请先判断要不要先问几个问题 —— 只问影响**整批**的问题（画风与视觉基调、光线与时段、'
    + '镜头语言取向、要不要统一的氛围词）；单条镜头自己的细节不用问。';
  const user = '这一批要润色的镜头提示词（共 ' + chosen.length + ' 条）：\n'
    + chosen.slice(0, 40).map(t => '- ' + t.label + '：' + String(t.text || '').slice(0, 80)).join('\n')
    + (chosen.length > 40 ? '\n（另有 ' + (chosen.length - 40) + ' 条未列）' : '');
  let r = { need: false, questions: [] };
  try { r = await TextAI.askPolish(regOf(), sys, user, { focus: POLISH_ASK_FOCUS }); }
  catch (e) { /* 问不成不拦这一趟：照旧直接润 */ }
  if (ask.dead) return null;
  const qs = (r && r.need && Array.isArray(r.questions)) ? r.questions : [];
  if (!qs.length) { window.PromptReview.closeProcess(dlg); return ''; }
  InlinePolish.ask(body, {
    title: '润色前，AI 想先问几个问题',
    intro: '点一个候选，或在输入框里自己写；没答的题按 AI 的默认理解走。'
      + '回答对**这一批每一条**都生效。',
    questions: qs,
    state: [],
    onChange: st => {},
    submitLabel: '按这些回答开始润色',
    skipLabel: '跳过，直接润色',
    onSubmit: t => { if (!ask.dead && ask.resolve) { const u = ask.resolve; ask.resolve = null; u(t || ''); } },
    onSkip: () => { if (!ask.dead && ask.resolve) { const u = ask.resolve; ask.resolve = null; u(''); } },
  });
  const t = await new Promise(res => { ask.resolve = res; });
  window.PromptReview.closeProcess(dlg);
  return t || '';
}
/* 整批问答的 focus：只问影响整批的取向（每条自己的细节不问）。 */
const POLISH_ASK_FOCUS = '整批镜头共同的画风与视觉基调、光线与时段、'
  + '镜头语言（景别与运镜）取向、要不要统一的氛围词';
async function runPolishAll() {
  /* 运行中再点 = 停止（按钮文案已换成「停止润色」） */
  if (polishAllRun) { polishAllRun.ab.abort(); return; }
  const { targets, skipped } = polishAllTargets();
  if (!targets.length) { setStatus('<span class="err">没有可润色的描述</span>'); return; }
  /* 真判一次：供应商选没选、密钥（本机 / 服务端 .env）有没有 —— 与单镜润色同一把尺。 */
  if (!(window.TextAI && await TextAI.canRun(regOf()))) {
    setStatus('<span class="err">没有可用的文字 AI（先在「设置」配好供应商与密钥）</span>');
    return;
  }
  const scope = await polishAllScope(targets, skipped);
  if (!scope || !scope.targets.length) return;
  const chosen = scope.targets;
  const batchNote = scope.note || '';
  /* 润前一轮整体问答：回答对整批生效（polishExtra 把它拼成硬约束）；null = 取消，整批不开跑。 */
  const batchAnswers = await polishAskRound(chosen);
  if (batchAnswers === null) { setStatus('已取消'); return; }
  const runProj = projOf();
  const ab = new AbortController();
  const run = { ab, runProj, results: [], failed: [] };
  polishAllRun = run;
  refreshPolishAllBtn();
  /* 过程弹窗与随后的审阅是同一张：结束后把 dlg 交给 openList 就地换内容。
     停止只掐在途请求、不关弹窗（keepOpenOnAbort）—— 已经润好的那几条还要摆出来审阅。 */
  const dlg = window.PromptReview.openProcess({
    title: '润色全部文案',
    sub: '共 ' + chosen.length + ' 条；' + POLISH_CONCUR + ' 路并发，可随时停止；润完先审阅再写回。',
    keepOpenOnAbort: true,
    cancelLabel: '停止',
    onAbort: () => { ab.abort(); },
  });
  const body = dlg.querySelector('#prBody');
  body.innerHTML = '<div class="pr-proc">' + chosen.map(t =>
    '<div class="pr-proc-row"><div class="pr-proc-h"><span class="nm">' + esc(t.label)
    + '</span><span class="st">等待</span></div><div class="pr-proc-tx"></div></div>').join('') + '</div>';
  const rows = [...body.querySelectorAll('.pr-proc-row')];
  const bufs = chosen.map(() => '');
  const dirty = new Set();
  let flushTimer = 0;
  const flushRows = () => {
    flushTimer = 0;
    dirty.forEach(i => {
      const tx = rows[i] && rows[i].querySelector('.pr-proc-tx');
      if (tx && tx.textContent !== bufs[i]) tx.textContent = bufs[i];
    });
    dirty.clear();
  };
  const touchRow = i => {
    dirty.add(i);
    if (!flushTimer) flushTimer = setTimeout(flushRows, 80);
  };
  const setRowState = (i, st, bad) => {
    const s = rows[i] && rows[i].querySelector('.st');
    if (!s) return;
    s.textContent = st;
    s.classList.toggle('bad', !!bad);
  };
  let at = 0;
  /* 4 路并发：逐条是独立的文字 AI 调用，代理的在途闸按平台算，再开多也只是排队。
     每条结果按自己的 seq 进结果表，与完成先后无关。 */
  const worker = async () => {
    while (at < chosen.length && !ab.signal.aborted) {
      const i = at++;
      const t = chosen[i];
      setRowState(i, '润色中…');
      try {
        const P = shotPolishOf(t.shot, t.text);
        const ctl = {
          push(piece, kind) { if (kind === 'reasoning' || !piece) return; bufs[i] += piece; touchRow(i); },
          note() { /* 素材附带的说明只进单镜面板，这一栏只看正文 */ },
          get signal() { return ab.signal; },
        };
        const r = await P.callFor(t.text, { ctl, answers: batchAnswers, note: batchNote });
        if (ab.signal.aborted) { setRowState(i, '已停止'); continue; }
        const after = String((r && r.after) || bufs[i]).trim();
        if (!after) {
          run.failed.push({ label: t.label, why: '文字 AI 没有返回内容' });
          setRowState(i, '失败：没有返回内容', true);
          continue;
        }
        bufs[i] = after;
        flushRows();
        run.results.push({ key: t.key, kind: t.kind, shotId: t.shot.id, vid: t.vid,
          label: t.label, text: after, seq: t.seq });
        setRowState(i, '完成');
      } catch (e) {
        if (ab.signal.aborted) { setRowState(i, '已停止'); continue; }
        run.failed.push({ label: t.label, why: errText(e) });
        setRowState(i, '失败：' + errText(e), true);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(POLISH_CONCUR, chosen.length) }, worker));
  } finally {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    flushRows();
    /* 停在排队里的那些不会再开始了：逐行标清，免得留着「等待」让人以为还在跑。 */
    rows.forEach((row, i) => {
      const s = row.querySelector('.st');
      if (s && s.textContent === '等待') setRowState(i, '已停止');
    });
    polishAllRun = null;
    refreshPolishAllBtn();
  }
  run.results.sort((a, b) => a.seq - b.seq);
  if (!run.results.length) {
    window.PromptReview.closeProcess(dlg);
    const why = run.failed.length ? ('：' + run.failed[0].why) : '';
    setStatus(ab.signal.aborted
      ? '已停止，文案没有动'
      : '<span class="err">' + chosen.length + ' 条都没润出来' + esc(why) + '，文案没有动</span>');
    return;
  }
  /* 审阅清单：同一张弹窗就地换标题与内容；取消一个字不动。 */
  const reviewed = await window.PromptReview.openList({
    shell: dlg,
    title: '润色结果（确认后写回）',
    sub: (ab.signal.aborted ? '已停止；' : '') + '润好 ' + run.results.length + ' 条'
      + (run.failed.length ? '；有 ' + run.failed.length + ' 条没润出来，保持原文' : '')
      + (skipped ? '；' + skipped + ' 镜没有可润的描述，跳过' : '')
      + '；可就地改，写入后每条仍能在右栏单独再改',
    items: run.results.map(r => ({ key: r.key, kind: r.kind, shotId: r.shotId, vid: r.vid,
      label: r.label, text: r.text })),
    applyLabel: '写回这些条目',
    hint: '画面写回这一镜的基准描述；候选只改那一条自己的描述，别的候选不受影响；生成仍按「生成全部分镜」来',
  });
  if (!reviewed || !reviewed.length) { setStatus('已取消，文案没有动'); return; }
  if (projOf() !== runProj) {
    setStatus('<span class="err">已切换短片，润色结果没有写回</span>');
    return;
  }
  const live = [];
  ((runProj && runProj.scenes) || []).forEach(sc => (sc.shots || []).forEach(sh => live.push(sh)));
  let n = 0, gone = 0;
  reviewed.forEach(row => {
    const text = String(row.text || '').trim();
    if (!text) return;
    const sh = live.find(x => x.id === row.shotId);
    if (!sh) { gone++; return; }
    const c = (sh.candidates || []).find(x => x && x.vid === row.vid);
    if (!c) { gone++; return; }
    setTakePrompt(sh, c, text);
    n++;
  });
  renderAll(); scheduleSave();
  setStatus('<span class="ok">✓ 已写回 ' + n + ' 条描述</span>'
    + (gone ? '<span class="meta"> · ' + gone + ' 条在润色期间被删掉，没有写</span>' : '')
    + (run.failed.length ? '<span class="meta"> · ' + run.failed.length + ' 条没润出来，保持原文</span>' : ''));
}
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
  /* 计划里带依赖的镜头开始「等上一镜」：中栏空态从这一刻起按等待文案说话。
     集合在收尾时清空，下一轮按新计划重算。 */
  genWaitIds = new Set([...plan.deps.keys()].map(sh => sh.id));
  renderAll();
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
        /* 计划里带候选的那一镜**就地更新**那几条（各自带上自己那句描述）；
           候选是计划时刻的快照，真轮到时要逐条核对还在不在、还是不是草稿 ——
           用户刚删过 / 改空过就这一镜不提交，不拿别的候选顶替。 */
        const planned = plan.takes.get(sh) || [];
        if (planned.length) {
          const live = sh.candidates || [];
          const still = planned.every(c => live.includes(c) && c.status === 'draft'
            && String(takePromptOf(sh, c)).trim());
          if (!still) {
            throw new Error('候选镜头在生成期间被删掉或改空了，这一镜没有提交；请重新点「生成全部分镜」');
          }
          planned.forEach(c => { c.status = 'creating'; c.error = null; c.progress = null; });
          renderAll(); scheduleSave();
        }
        /* 还差张数才补建的克隆：占位只在真正轮到这一镜时才建（等待中的镜头提前冒出「创建中」，
           用户会以为已经在花钱了）。克隆自带提示词与配置，不是空壳。 */
        const freshN = (plan.fresh && plan.fresh.get(sh)) || 0;
        const fresh = freshN ? pushPlaceholders(sh, freshN) : [];
        const phs = planned.concat(fresh);
        /* 计划是一分钟前算的：真轮到这一镜时按**现在**的顺序再认一次上一镜。
           用户改了顺序 / 删了镜头就宁可不生成，也不能把 A 的尾帧接到 B 上。 */
        if (phs.some(c => c.linkPrev === 'tail' && !c.firstFrame)) {
          const live = allShots();
          const li = live.indexOf(sh);
          const livePrev = li > 0 ? live[li - 1] : null;
          if (livePrev !== (plan.prevMap.get(sh) || null)) {
            throw new Error('镜头顺序在生成期间变了，这一镜没有提交；请重新点「生成全部分镜」');
          }
        }
        const stopErr = new Error('已停止（切换了短片）');
        let okN = 0, firstErr = null;
        try {
          for (let i = 0; i < phs.length; i++) {
            if (!alive()) {
              /* 没提交的那几条不能留着「创建中」：它们永远拿不到任务号。
                 计划里的候选退回草稿（文字还在），新建占位直接取消。 */
              for (let j = i; j < phs.length; j++) {
                if (j < planned.length) {
                  phs[j].status = 'draft';
                  phs[j].error = null;
                  phs[j].progress = null;
                } else {
                  phs[j].status = 'cancelled';
                  phs[j].error = '已停止（切换了短片），这一条没有提交';
                }
              }
              throw stopErr;
            }
            try { await submitCandidate(sh, phs[i]); okN++; }
            catch (e) {
              /* 与 drawShot 同一口径：这一条失败就停手（不接着花后面的钱），
                 剩下的占位也结掉（它们从没提交出去，留成「创建中」永远不动）。
                 计划里的候选退回草稿 —— 文字还在，删掉它或重新点都能再来。 */
              for (let j = i + 1; j < phs.length; j++) {
                if (j < planned.length) {
                  phs[j].status = 'draft';
                  phs[j].error = null;
                  phs[j].progress = null;
                } else {
                  phs[j].status = 'failed';
                  phs[j].error = '这一批在前一条失败后没有提交（删掉即可重试）';
                }
              }
              firstErr = firstErr || e;
              break;
            }
          }
          renderAll(); scheduleSave();
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
    genWaitIds = new Set();
  }
  const aborted = !!run.abort || projOf() !== runProj;
  if (aborted) {
    Toast.warn('生成全部分镜已停止：' + (run.abort || '切换了短片'));
    return;
  }
  const failedShots = outs.filter(r => r && !r.ok && !r.blocked).length;
  /* 级联 blocked 的那几镜（上一镜失败，等它尾帧的没提交）：以前一声不吭 —— 界面上
     那两镜像什么都没发生过，用户只能猜「为什么生成全部分镜跳过了它们」。
     一个占位都不建（没提交的镜头没有任务号，建占位等于假装排队），但回执必须说清。 */
  const blockedShots = outs.filter(r => r && r.blocked).length;
  loadCredits();
  renderAll();
  if (failedShots) {
    setStatus('<span class="err">有 ' + failedShots + ' 镜提交失败：它们现在算「一条都没成」，'
      + '再点「生成全部分镜」只会补它们（已成功的镜头不会重投）</span>'
      + (blockedShots ? '<br>另有 ' + blockedShots + ' 镜等着接上一镜的尾帧 —— 上一镜失败了，这一次没有提交；上一镜补好后再点一次' : ''));
  } else if (blockedShots) {
    setStatus('<span class="meta">另有 ' + blockedShots + ' 镜等着接上一镜的尾帧，这一次没有提交</span>');
  }
}
/* 点「生成全部分镜」：先按**眼下**的镜头重算计划、现问一次价，再让用户确认。
   取消时一个占位都不建、一个请求都不发。 */
async function genAllConfirm(plan, q) {
  const n = plan.ok.length + plan.wait.length;
  const runList = plan.ok.concat(plan.wait);
  const cands = runList.reduce((a, sh) => a + (Number(plan.counts.get(sh)) || 0), 0);
  const reuseN = runList.reduce((a, sh) => a + ((plan.takes.get(sh)) || []).length, 0);
  const freshN = runList.reduce((a, sh) => a + ((plan.fresh.get(sh)) || 0), 0);
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
        + (cands > n ? '（共 ' + cands + ' 条候选镜头）' : '') + '。' + price + '</div>'
        + (reuseN ? '<div class="dlg-line">其中 <b>' + reuseN + '</b> 条是**已有候选就地更新**'
          + '（各自带自己那句描述与配置）。</div>' : '')
        + (freshN ? '<div class="dlg-line">另有 <b>' + freshN + '</b> 条按这一镜的张数补建'
          + '（克隆自默认候选，带全套配置）。</div>' : '')
        + (plan.wait.length ? '<div class="dlg-line">其中 <b>' + plan.wait.length + '</b> 镜要等上一镜出画面后才提交：'
          + plan.wait.slice(0, 4).map(sh => esc((sh.name || '未命名') + ' ← ' + ((plan.deps.get(sh) || {}).name || '上一镜'))).join('；')
          + (plan.wait.length > 4 ? '；等 ' + plan.wait.length + ' 镜' : '') + '。</div>' : '')
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
        (cfg(sh).keyframes || []).forEach((kf, i) => {
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
        const resolved = B.resolve(String(cfg(sh).prompt || ''), nm, nm);
        cfg(sh).prompt = resolved;
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
    chainStateOf, genAllPlan, genAllScopeDialog, planForSelection, genAllQuote, genAllConfirm, runGenAll, refreshGenAllBtn,
    abortGenAll, genAllRunning: () => !!genAllRun, genAllWaitOf,
    /* 润色全部文案：批量入口与按钮刷新（挂在 genAll 同一帧，同一处读数） */
    runPolishAll, refreshPolishAllBtn,
  };
}
