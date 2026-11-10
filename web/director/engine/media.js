/* 导演台成片媒体域：签名地址过期刷新（播放 / 导出前）、成片尺寸（画幅唯一算法）、
   素材编号计划（首帧 → 尾帧 → 切片 → 参考图 → 参考视频 → 参考音频）的转发，
   以及「成片下载一律交给浏览器」那一份。区间内的代码由 engine.js 逐字搬出；
   proj 是 engine 继续持有的可变状态，走访问器，document / window 用参数名遮蔽全局。 */

import { shotRefPlanOf, tokenizeRefPrompt, applyProviderRefSyntax } from '../ref-plan.js';

export function createMedia(E, document, window) {
  'use strict';
  const {
    allShots,
    projOf,
    saveScheduleSoft,
    shotReady,
  } = E;

/* ---------- 成片播放 ---------- */
/* 签名 URL 过期刷新：播放/导出前取最新下载地址。
   「过没过期」问 `Api.mediaExpired`、「怎么换新」走 `Api.healMedia` —— 与开机那一趟
   （`healStaleUrls`）同一套，全站只有这一份判据。
   以前这里自己按 `c.expires` 判一次、再自己 `pollTask` 问一次，是同一件事的第二份实现：
   那个字段来自平台列表里的 `output.expires_at`，与地址里那位签名参数**不是同一个口径**，
   两处对不上时就变成「开机那一趟说没过期、播放这一句说过期了」，来回各打一条路；
   而逐条 pollTask 在 `pollVia:'list'` 那一族每次都是一整页 100 条的列表。
   healMedia 换到的新地址还会进那张内存表，`Api.mediaSrc` 认它 ——
   于是缩略图、灯箱、下载链接在同一次会话里一起跟着新鲜，不只这一个调用点。 */
async function freshUrl(c) {
  // 只刷新「任务号来自平台」的候选：local_/tmp_/asset_ 是本机造的号，上游没有这条任务可问
  if (!c || !c.vid || /^(local_|tmp_|asset_)/.test(String(c.vid))) return c && c.url;
  if (!c.url || !Api.mediaExpired(c.url)) return c.url;
  const got = await Api.healMedia([{ provider: c.provider, id: c.vid, url: c.url }], {
    onFresh: (rec, next) => { c.url = next; saveScheduleSoft(); },
  }).catch(() => 0);
  if (!got) {
    /* 平台换不到新地址而本机存过这份产物 → 直接用本机那份（不改 c.url：
       存储里那条平台外链留着，以后仍能再回源）。以前这里只报一句失败，
       播放/导出拿着过期地址去打，表现是「云端失效后直接不能显示」。 */
    const la = (window.AssetLocal && AssetLocal.localAssetIdOf) ? AssetLocal.localAssetIdOf(c.url) : '';
    if (la) {
      Toast.warn('平台地址换不到了，已退回本机副本：' + (c.name || c.vid));
      return Api.assetSrc(la);
    }
    Toast.warn('拿不到这条任务的新下载地址（平台上可能已被清理），播放/导出可能失败：' + (c.name || c.vid));
  }
  return c.url;
}

/* ---------- 成片下载：一律走浏览器默认方式 ---------- */
/* 项目已经没有「下载位置 / 另存为」这一层：无 File System Access 句柄、无 showSaveFilePicker、
   也不许页面自己写一份落点实现 —— 全站只有 Net.save 这一份，存哪由浏览器/系统决定。 */
function saveBlob(name, blob) {
  Net.save(blob, name);
  return { msg: '✓ 已交给浏览器下载：' + name, saved: false };
}
/* 成片尺寸：`proj.composition` 优先（FCPXML 导入写的就是它），没有就按第一个已选用镜头的比例
   计算（长边 1280），保证所有镜头比例一致地居中填充。
   画幅是**一部片子一份**：切片、实时预览、导出成片、FCPXML 都读这里，不在别处再推一次。
   页头那颗比例下拉已按 2026-10 用户要求删掉：新项目跟第一个镜头的比例走，
   FCPXML 导入的工程带上文件里声明的画幅。 */
function compositionOf() {
  const c = projOf() && projOf().composition;
  if (!c) return null;
  const w = Math.round(Number(c.width)), h = Math.round(Number(c.height));
  /* 编码器要偶数宽高；范围按 64–4096 收（导出合成读的就是这一份画幅）。不合法的旧值当作没有。 */
  if (!(w >= 64 && h >= 64 && w <= 4096 && h <= 4096) || w % 2 || h % 2) return null;
  return { w, h };
}
function filmSize() {
  const c = compositionOf();
  if (c) return { w: c.w, h: c.h };
  const first = allShots().filter(shotReady)[0];
  const ar = (first && first.ar) || '16:9';
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar);
  const w = m ? Number(m[1]) : 16, h = m ? Number(m[2]) : 9;
  const long = 1280;
  if (w >= h) return { w: long, h: Math.round(long * h / w / 2) * 2 };
  return { w: Math.round(long * w / h / 2) * 2, h: long };
}
/* 播放区是**固定的标准横屏 16:9**（2026-10 用户点名），不跟成片画幅走 ——
   成片的真实尺寸只由 filmSize() 那一处算（导出与 FCPXML 读它），界面上没有第二个去处。 */

/* ---------- 视频模型与参数：按这一镜的输入推导可用模型 ---------- */
/* 素材编号与发送顺序的唯一计划表：首帧 → 尾帧 → 画面切片 → 手动参考图 → 参考视频 → 参考音频。
   芯片、润色附图、提交前的 @ 替换、真正发出去的 inputEntries 都读这一份（见 ref-plan.js）。 */
function chainSlotOf(sh) {
  return !!(sh && sh.linkPrev === 'tail' && !sh.firstFrame && allShots().indexOf(sh) > 0);
}
/* 规范标记 → 平台声明的引用语法（H3 就是 <Picture N> / <Video N> / <Audio N>）。
   未声明语法的平台原样提交。 */
function applyRefSyntax(prompt, prov) {
  return applyProviderRefSyntax(prompt, prov && prov.refSyntax);
}
/* 提示词里的 `@名字` / `@首帧` → 计划里的 `@参考图N`；编号与真正发出去的顺序同源。
   一次正则替换（名字按长度从长到短排），不做逐名 split：后者会在名字互为前缀时连锁改写。 */
function refTokenize(sh, prompt, ic, o) {
  /* 接续镜的首帧在提交那一刻才解析，但编号现在就得定下来：先按「会接上」占住第 1 张图，
     真正解析失败时整次提交会中止，不会发出一份编号错位的正文。 */
  const opt = o || { chainPending: chainSlotOf(sh) };
  return tokenizeRefPrompt(prompt, shotRefPlanOf(sh, ic, opt, id => Api.assetSrc(id)));
}

  return {
    applyRefSyntax,
    chainSlotOf,
    compositionOf,
    filmSize,
    freshUrl,
    refTokenize,
    saveBlob,
  };
}
