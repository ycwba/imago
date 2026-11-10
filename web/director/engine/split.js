/* 导演台Split域：接续生成（上一镜尾帧当首帧）与拆分镜之前「这一次带哪些素材进来」——
   接续型号清单 / 重选判据 / 尾帧取法、分镜清单快照（BoardTools）、素材范围与两段式清单（SplitAssets）。
   区间内的代码由 engine.js 逐字搬出；E 只递 engine 那一层的函数（Panel 那四位包成箭头避开 TDZ），
   document / window 用参数名遮蔽全局。 */

import { createBoardTools } from '../board.js';
import { createSplitAssets } from '../split-assets.js';
import { chainModelRepick, hasTailFrame, isRunning } from '../chain.js';
import { BOARD_CTX_PROMPT, BOARD_CTX_SHORT } from '../util.js';

export function createSplit(E, document, window) {
  'use strict';
  const {
    PENDING_PREFIX,
    addLibPicToShot,
    allShots,
    assetToDataURL,
    clampShotDurations,
    durWritable,
    feedScenePics,
    freshUrl,
    libPicChoices,
    newShot,
    removeShot,
    resolvedModel,
    setShotDur,
    shotModels,
    uid,
  } = E;

/* ---------------- 接续生成：上一镜尾帧当首帧 ----------------
   两个判据各只有一处：
     chainModelList()  把可用视频型号摊平成「能不能接首帧 / 能不能接尾帧 / 时长区间」，
                       拆分镜（chain.js 的 pickChainModel）与 ensureChainModel 都读这一份；
     ensureChainModel()  接续挂着、又没显式首帧时，确保这一镜落在一个支持首帧的型号上。
   `modelAuto` 只为界面那句「已自动切到 X」服务，不是第二种模型来源。 */
function chainModelList() {
  const out = [];
  (shotModels(null) || []).forEach(g => (g.models || []).forEach(m => {
    const op = (m && m.options) || g.options || {};
    const roles = new Set((window.Capabilities ? Capabilities.specs(m) : (op.inputSpecs || [])).map(x => x.role));
    const d = op.durations;
    const span = Array.isArray(d) && d.length === 2 && Number(d[0]) > 0 && Number(d[1]) >= Number(d[0])
      ? [Number(d[0]), Number(d[1])] : null;
    out.push({ id: m.id, provider: g.id, name: m.name || m.id,
      min: span ? span[0] : 0, max: span ? span[1] : 0,
      first: roles.has('first_frame'), last: roles.has('last_frame') });
  }));
  return out;
}
function ensureChainModel(sh) {
  if (!sh) return null;
  if (sh.linkPrev !== 'tail' || sh.firstFrame) return resolvedModel(sh);
  /* 动不动、换成谁都在 chain.js 的 chainModelRepick（纯判定，判据 tests/director-chain.mjs）；
     这里只照判定落盘。Capabilities 缺位时清单只剩 registry 声明那一份静态的，
     没有「还没到货」可言，按落定算。 */
  const settled = !window.Capabilities || window.Capabilities.settled !== false;
  const pick = chainModelRepick(sh, chainModelList(), settled);
  if (pick && pick.id !== sh.model) { sh.model = pick.id; sh.modelAuto = 'chain'; }
  return resolvedModel(sh);
}
/* 手选型号接不了首帧时那一句（空串 = 没有这回事）。
   与 `ensureChainModel` 配对：程序只替「没得选」的镜头挑型号，用户明确挑过的那一型只拦不改。 */
function chainModelWhy(sh) {
  if (!sh || sh.linkPrev !== 'tail' || sh.firstFrame) return '';
  if (!sh.model || sh.model === 'auto' || sh.modelAuto === 'chain') return '';
  const m = chainModelList().find(x => x.id === sh.model);
  return m && !m.first
    ? '「' + (m.name || m.id) + '」不支持首帧，接不了上一镜的尾帧；换一个支持首帧的型号，或取消「接上一镜」'
    : '';
}
/* 这一镜为什么还不能生成里「等上一镜」那一句。能接就是空串。
   与 chain.js 的 chainDeps 返回同一套原因码，只是这里说给人听。 */
function chainWaitWhy(sh) {
  if (!sh || sh.linkPrev !== 'tail' || sh.firstFrame) return '';
  const all = allShots();
  const i = all.indexOf(sh);
  if (i <= 0) return '这是第一个镜头，没有上一镜可接';
  const prev = all[i - 1];
  if (hasTailFrame(prev)) return '';
  return isRunning(prev) ? '等上一镜出画面后才能接它的尾帧' : '上一镜还没有可用画面，先单独生成它';
}
/* 上一镜的尾帧（dataURL）+ 它从哪来。顺序固定：
   静态尾帧 → 最后一个画面切片 → 选用的候选（没有就第一条成功候选）的视频末帧。
   缓存只在内存里、键跟着候选与裁剪点走：候选换了 / 重新生成过，缓存自然命不中。
   ⚠ 不把 dataURL 写进工程、不落盘 —— 它可能是一张几 MB 的图，而完整提示词已有 PromptLog 归档。 */
const chainFrameCache = new Map();
const CHAIN_FRAME_CACHE_MAX = 8;
async function resolveChainFrame(sh) {
  const all = allShots();
  const i = all.indexOf(sh);
  if (i <= 0) throw new Error('这是第一个镜头，没有上一镜可接');
  const prev = all[i - 1];
  if (prev.lastFrame) return { src: prev.lastFrame, from: '上一镜的结尾画面' };
  const kf = (prev.keyframes || []).filter(k => k && k.assetId).pop();
  if (kf) return { src: await assetToDataURL(kf.assetId), from: '上一镜的画面切片' };
  const cand = (prev.candidates || []).find(c => c && c.vid === prev.selId && c.status === 'succeeded' && c.url)
    || (prev.candidates || []).find(c => c && c.status === 'succeeded' && c.url);
  if (!cand) {
    throw new Error(isRunning(prev) ? '上一镜还在生成，等它出画面后才能接它的尾帧'
      : '上一镜还没有可用画面，先单独生成它');
  }
  const key = prev.id + '|' + (cand.vid || cand.url) + '|' + (cand.trimE != null ? cand.trimE : '');
  if (!chainFrameCache.has(key)) {
    const p = (async () => {
      const u = await freshUrl(cand);
      return await Wb.vframe.dataURL(u, 'end', cand.trimE != null ? cand.trimE : null);
    })();
    chainFrameCache.set(key, p);
    if (chainFrameCache.size > CHAIN_FRAME_CACHE_MAX) {
      chainFrameCache.delete(chainFrameCache.keys().next().value);
    }
  }
  try { return { src: await chainFrameCache.get(key), from: '上一镜视频的尾帧' }; }
  catch (e) { chainFrameCache.delete(key); throw e; }
}
/* 当前分镜的清单快照：场景与镜头都按**从 1 开始**的序号编，时长没填就是 0。
   单独留 `sh` / `sc` 两个引用 —— 账（boardPlanOf）要靠它把序号当场翻成 id；
   只编数字的话，等用户对着弹窗删了几条，序号就指错人了。 */
const BoardTools = createBoardTools({
  durWritable: () => durWritable(), nameKey: window.nameKey,
  newShot, setShotDur, removeShot, uid, Wb, feedScenePics, clampShotDurations,
});
const { snapBoard, boardListText, boardPlanOf, applyBoardPlan } = BoardTools;

/* ============================ 拆分镜之前：这一次带哪些素材进来 ============================
   三件事各只有一处落点，页面不另写第二份：
   ① 范围（`scopes` / `resolve` / `scopeText`）—— 表单「素材范围」那一项的名单。
      选项上的条数与 `resolve` 用同一个过滤器现算，否则下拉写「角色（12 条）」而实际喂过去 11 条。
      「算不算这一组」的判据在 web/domain/chars.js 的 `Lib.groupMatch`（按 `window.nameKey` 合并近名），这里不重写。
   ② 两段式（`catalog` → `pick` → `fullText`）—— 第一段只给「谁是谁」的目录（每条 30 字），
      第二段只喂被挑中那几条的完整描述（每条截到 300 字）。整库直接倒过去会把上下文撑爆，
      一条都不喂又让 AI 认不出用户库里的角色名 —— 拆出来的镜头与素材对不上号正是这一条要治的。
   ③ 落盘（`bind`）—— 按提示词里的 `@名字` 把素材库那一张挂进 `sh.refImages`，
      判据全走 `addLibPicToShot`（能力声明 / 互斥 / 上限 / 去重 全站只那一份），这里不重写。
      **不改写提示词**：`@名字` 原样留着 —— 归档、`refTokenize`、芯片读的都是这一份原始写法，
      在这里换成 `@参考图1` 等于把同一件事拆成两份账，还会把「第几张」数错。
   选中的范围记在 `dir_asset_scope`（只存本机、不进项目文件）：分组下一次可能就被删掉，
   所以读回来先验一遍它还在不在名单里，认不出落回「不导入」。 */
const PICK_SOFT_MAX = 12;     // 只写在给 AI 的那句话里当软引导，不是硬闸：超了由参考图上限按型号夹并报数
/* 喂给 AI 的「引用写法」那句话（兜底那一份）。
   引用写法**不**由 Skill 声明 —— 那是程序的事：`@名字` 是给**生成模型**的引用
   （挂参考图，提交前换成 `@参考图N`），而 Skill 正文里的 `{变量}` 是给**写稿的 AI** 的
   项目资料（这一份角色名单长什么样）。两件事各走各的，别混成一件。
   Skill 想自己决定这些料摆哪儿 —— 写 `{assets}` 变量就行（见 board-vars.js）。 */
const RULE_WITH = '\n\n可以把下面这些素材用进镜头：在某一条的 prompt 里**原样写 @名字**'
  + '（例如「@小雅 撑伞走过河岸」），程序按名字把它的图挂成参考图。只引用下面这份清单里的名字，'
  + '不要自己编名字，也不要写成 @参考图1。\n';
const RULE_WITHOUT = '\n\n这次没有可用的素材（没选范围，或清单里挑不出相关的）：'
  + 'prompt 里**不要**写 @名字 这类引用，主体长什么样直接用文字写清楚。';
/* 「归一名字 → 库条目」那张表：挑素材（`pick`）与挂图（`bind`）问的是同一件事
   （AI 回的那个名字对得上清单里的哪一条）。
   同名多条各存各的（数组）：AI 报名字时取第一条（解析兜底），用户从挑选浮层选的按 id 精确落 refMeta。 */
function libIdx(list) {
  const m = new Map();
  (list || []).forEach(x => {
    const k = nameKey(x && x.name);
    if (!k) return;
    const arr = m.get(k) || [];
    arr.push(x);
    m.set(k, arr);
  });
  return m;
}
/* `@名字` 后面紧跟的标点不是名字的一部分（「@小雅，走进雨中」）；名字与资产名两头各洗一次，用同一份。
   没有 g flag 的非全局正则用在 replace 上不带状态，可以共享。 */
const AT_TAIL = /[，,。.、；;：:！!？?()（）\[\]【】"'“””《》]+$/;
const SplitAssets = createSplitAssets({
  BOARD_CTX_SHORT, BOARD_CTX_PROMPT, PICK_SOFT_MAX, RULE_WITHOUT, RULE_WITH, AT_TAIL,
  libIdx, nameKey: window.nameKey, TextAI: window.TextAI,
  /* 这两位搬进了 panel.js，本层要到 6504 行才把名字接回来；这里直接引用会在建包那一下撞 TDZ
     （导演台整页挂不起来），所以照别处一样包成箭头，等真被调用时再读。 */
  libPicChoices: (...a) => libPicChoices(...a),
  addLibPicToShot: (...a) => addLibPicToShot(...a),
  PLACEHOLDER_PREFIX: PENDING_PREFIX,
});
window.SplitAssets = SplitAssets;

  return {
    SplitAssets,
    applyBoardPlan,
    boardListText,
    boardPlanOf,
    chainModelList,
    chainModelWhy,
    chainWaitWhy,
    ensureChainModel,
    resolveChainFrame,
    snapBoard,
  };
}
