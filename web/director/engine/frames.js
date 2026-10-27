/* 导演台Frames域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createFrames(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { frameIndexTimes, FRAME_INDEX_MAX } from '../slice.js';
import { packFrames, unpackFrames } from '../slice-pack.js';

/* 切片帧的持久层走代理的 /cache/slices（与浏览器 origin 无关的一份；换端口不再各攒一份）。
   一条素材一条记录，打包 / 解包的排布只在 `web/director/slice-pack.js` 一份
   （判据也从那一份读，不会出现「写的与读的各记一套」）。
   上限与容量闸在代理那边（3000 张 / 40MB，LRU）；这里只管取放。
   ⚠ 一屏的帧是**分几块**解出来的，每块都会写一次；直接 PUT 会把上一条记录整份覆盖掉，
   最后盘上只剩最后一块那几张。所以这里按素材合并（新帧覆盖同一时刻）再整份写，
   同一素材的写入排队 —— 并发 PUT 还会让索引与 .bin 互相错位。 */
const sliceCacheLoad = async key => {
  if (!window.Api || !Api.cacheGet) return [];
  const b = await Api.cacheGet('slices', key);
  if (!b) return [];
  try { return await unpackFrames(b); } catch (e) { return []; }
};
export function createFrames(E, document, window) {
  const {
    REGOf,
    allShots,
    tlCandidateOf,
    scheduleSave,
    assetStoreId,
    sameAssetSpace,
    freshUrl,
    healStaleUrls,
    mediaSrc,
    stripRepaint,
  } = E;

/* ---------------- 轨道上的切片图 ----------------
   一条素材一份帧表（「稳定键 → {时刻: 图片}」），主链是 mediabunny 的批量取帧
   （`MediaBackend.frames`：一趟解出一条**稠密帧索引**，密度口径在 slice.js 的
   frameIndexPlan），兜底才是 <video> 池逐块 seek。取到的帧全进同一张表：剪辑每拖一下
   块每次重画都按格序问一遍（strip.js），命中（或就近顶上）就不再解码。
   取不到帧不算错（格子里留占位，画面照样能剪）。
   主链兜底共用同一条流水线（slicePump）：同一条素材一次只有一趟活，全页同时在解的
   不超过 SLICE_GLOBAL 趟 —— 十几条候选各开各的解码器，只会把中栏正在播的那条拖慢。 */
const frameCache = new Map();
const EMPTY_HITS = new Map();         // 这一条素材还没建缓存表时给读数用的空表（免得每处各 new 一份）
const slicePending = new Map();       // 稳定键 → 已排进队列、还没出图的格子
const sliceFailed = new Map();        // 稳定键 → Map(时刻 → { 失败时间, 连着失败几次 })：退避一阵后要自己再试
const sliceJobs = [];                 // 全页共用的一条解码流水线上的活：{ key, src, times, hit, res, prio, hot, onFrame }
let sliceBusy = 0;
/* 并发与出图宽度别写死。4 核机器上开 4 路解码会把中栏播放一起拖住，
   8 核以上又用不满；出图宽度按 dpr —— 1x 屏上 160 宽是白给，2x 屏上 120 又糊。 */
const SLICE_DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
const SLICE_W = SLICE_DPR >= 1.5 ? 160 : 120;
const SLICE_CPUS = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
const SLICE_GLOBAL = Math.max(2, Math.min(6, SLICE_CPUS - 2));
/* 旧并发行为保留一个版本：「并发单位」已从块改成素材，出问题可以用 ?slice=v1 退回。
   这一档只影响调度（块并行 / 一素材一解码器），采样与缓存仍是同一份。 */
const SLICE_V1 = /(?:[?&])slice=v1(?:&|$)/.test(typeof location !== 'undefined' ? location.search : '');
/* 一个素材只开一只 <video>。以前一块一只，同一素材四块就解析四遍元数据、四份缓冲，
   `release` 时还要 `load()` 主动丢弃。现在按素材键池化，块在素材内部排队，闲置 5 秒释放。 */
const SLICE_IDLE = 5000;
const sliceVideos = new Map();        // 素材键 → { v, src, timer }（忙闲由 sliceActive 把关，不另记）
const sliceActive = new Set();        // 正在解码的素材键（同一条素材一次只有一趟活）
const FRAME_SRC_MAX = 48;             // 缓存里最多留几条素材的帧：满了逐条淘汰最久没摸到的那一条
const SLICE_FAIL_TTL = 5 * 60e3;      // 取不到的时刻最久 5 分钟后允许再试（签名换新 / 本机文件补回来）
const SLICE_FAIL_FIRST = 8e3;         // 第一次失败只压 8 秒：解码超时多半是「这会儿忙」，不是「取不到」
const SLICE_FRAME_MAX = 1200;         // 单条素材最多留多少张切片（长时间来回缩放也不无限涨）
let slicePaused = false;              // 导演台切走时暂停解码队列，别和正在看的下一页抢解码器
/* 迁移岛在 onActivated / onDeactivated 里直接调这个（spa:page 那条监听在组件未激活时会被事件门控挡住）。 */
window.__directorSlicePause = v => { slicePaused = !!v; if (!slicePaused) sliceResume(); };
window.__directorSlicePaused = () => slicePaused;
/* 同一份素材在页面里可能有三张地址：/asset/<本机号>、/getv?url=<签名外链>、原始落地地址。
   用原始地址当缓存的键，签名一换就整排切片重新解码 —— 这正是「每次都重新加载」的另一半。
   Wb.thumbs.keyOf 已经把这三类归成同一个身份（视频首帧缓存用的也是它），切片直接复用。 */
function sliceKey(src) {
  const s = String(src || '');
  try { if (window.Wb && Wb.thumbs && Wb.thumbs.keyOf) return Wb.thumbs.keyOf(s); } catch (e) { /* 公共缓存键拿不到就退回用地址本身当键 */ }
  return s;
}
function sliceBackoff(n) {
  return Math.min(SLICE_FAIL_TTL, SLICE_FAIL_FIRST * Math.pow(2, Math.max(0, Number(n) || 0)));
}
function sliceBadFresh(key, t) {
  const m = sliceFailed.get(key);
  const r = m && m.get(t);
  return !!r && Date.now() - r.at < sliceBackoff(r.n);
}
/* 退避到点自己再排一遍活：块只有等下一次重画（切镜头、剪一刀、缩放落定）才会被再问一遍，
   页面静静摊着时一次解码超时（元数据 20 秒 / 定位 15 秒）就把整条带子钉成斜纹五分钟。
   到点那一次不再走重画整板，只把胶片格重新问一遍帧（strip 那条路：paint → ensureFrames，
   退避已过期的时刻当场重新排活），已解到的帧一格都不重解。 */
let sliceRetryTick = 0, sliceRetryAt = 0;
function sliceRetryIn(ms) {
  const at = Date.now() + Math.max(0, Math.round(Number(ms) || 0));
  if (sliceRetryAt && at >= sliceRetryAt) return;             // 已经有更早的一次在等，不另开定时器
  sliceRetryAt = at;
  if (sliceRetryTick) clearTimeout(sliceRetryTick);
  sliceRetryTick = setTimeout(() => { sliceRetryTick = 0; if (!slicePaused) sliceRetryRun(); }, at - Date.now());
}
function sliceResume() { slicePump(); if (sliceRetryAt) sliceRetryRun(); }
function sliceRetryRun() {
  if (sliceRetryTick) { clearTimeout(sliceRetryTick); sliceRetryTick = 0; }
  sliceRetryAt = 0;
  if (stripRepaint) stripRepaint();
}
/* 取帧失败 ⇒ 先怀疑「地址过期了」：平台产物多是签名外链（只管一天），过期后取帧必然失败，
   而格子上只剩一道斜纹 —— 看着像「这一段没有画面」，其实是**地址不新鲜了**。
   这里当场换一轮新地址（`healStaleUrls` 走 `Api.healMedia` 按平台批量回源 ✓），
   退避到点再取就是新的了 —— 格子留着，画面回来（用户点名：有镜头就修取帧，别撤画面段）。
   换地址要发请求，节流一次（十秒一趟）：失败往往成片地来（整条素材的每个时刻都失败）。 */
let sliceHealAt = 0;
function noteSliceFail(key, times) {
  let wait = SLICE_FAIL_TTL;
  times.forEach(t => { const w = sliceFail(key, t); if (w < wait) wait = w; });
  sliceRetryIn(wait);
  const now = Date.now();
  if (now - sliceHealAt > 10000) {
    sliceHealAt = now;
    try { const p = healStaleUrls(); if (p && p.catch) p.catch(() => 0); } catch (e) { /* 换不到新地址就照旧退避重试 */ }
  }
}
/* 退避只拦「没人动」的自动轮询。用户 seek / 缩放 / 切段就是明确的重试信号 --
   放行一次：整表清掉，下一次 ensureFrames 把刚才失败的几个时刻照常重新排活
   （退避表本来就只记「几秒内别再试」，没有别的状态可丢）。 */
function sliceForgetFail() { sliceFailed.clear(); }
/* seeked 之后画面未必已经换（解码器还没把这一帧画出来），不等就抓可能抓到上一格。
   有 requestVideoFrameCallback 就等一帧真画面；没有（老浏览器）或超时就照旧抓，
   宁可偶尔旧一帧，也不能把整排格子卡死。
   ⚠ 连续两次等不到就别再等了：切片的解码器是**游离且暂停**的 `<video>`，没有合成器给它出帧，
   rVFC 在 GPU 被关掉的环境（headless / 省电模式）里不回调 —— 每格都等就等于把整排拖慢。
   真浏览器里回调一两帧内就来，60ms 足够；连续两次超时才判定这个环境不回帧，后面改用 seeked 直接抓。
   旧帧的风险由 e2e 的「一排二十格的画面指纹互不相同」守着，不靠无限等待。 */
let sliceRvfcMiss = 0;
function sliceNextFrame(v) {
  if (sliceRvfcMiss >= 2 || typeof v.requestVideoFrameCallback !== 'function') return Promise.resolve();
  return new Promise(res => {
    let done = false, to = 0;
    const fin = live => {
      if (done) return; done = true;
      clearTimeout(to);
      sliceRvfcMiss = live ? 0 : sliceRvfcMiss + 1;
      res();
    };
    try { v.requestVideoFrameCallback(() => fin(true)); } catch (e) { fin(false); return; }
    /* 回得来回得很快（一帧 16-33ms），60ms 还没回就是一帧都没出：别把首格压在探测上。 */
    to = setTimeout(() => fin(false), 60);
  });
}
/* 一块时刻：一个 <video> 从头到尾顺序取完。返回值是**没能出图**的那些时刻 —— 调用方把它们记进
   sliceFailed，别让下一次重画再把同一批取不到的帧重解一遍（外链过期时原本是每 3 秒白跑一趟解码器）。 */
/* JPEG 编码搬到 worker。主线程只把这一帧取成 ImageBitmap（可转移），缩放/编码都在 worker。
   ⚠ 不能直接 `new VideoFrame(video)`：游离且暂停的 <video> 在 GPU 被关掉的环境（headless / 省电模式）
   里拿到的是一张**黑帧**（2026-10-21 实测：每个时刻编码出来的 JPEG 字节完全相同），
   而 `createImageBitmap(video)` 拿到的是 seek 后的真实画面（同一份探针里三个时刻的指纹互不相同）。
   取帧时顺手按目标宽度缩放，别把 1080p 整帧复制一份再让 worker 缩。 */
let sliceWorker = null, sliceWorkerSeq = 0;
const sliceWorkerWait = new Map();
function sliceWorkerOf() {
  if (sliceWorker !== null) return sliceWorker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null;
  try {
    const w = new Worker('/web/director/slice-worker.js');
    w.onmessage = e => {
      const d = e.data || {}, p = sliceWorkerWait.get(d.id);
      if (!p) return;
      sliceWorkerWait.delete(d.id);
      clearTimeout(p.to);
      d.error ? p.rej(new Error(d.error)) : p.res(d.blob);
    };
    w.onerror = () => {
      /* 一条 worker 起不来就整页退回主线程：把等着的那几格放掉，别让它们挂到超时。 */
      const err = new Error('slice worker 不可用');
      sliceWorkerWait.forEach(p => { clearTimeout(p.to); p.rej(err); });
      sliceWorkerWait.clear();
      try { w.terminate(); } catch (e) { /* 已经炸掉的 worker：terminate 再失败也没有别的路 */ }
      sliceWorker = false;
    };
    sliceWorker = w;
  } catch (e) { sliceWorker = false; }
  return sliceWorker;
}
function sliceEncodeInWorker(v, cw, ch) {
  const w = sliceWorkerOf();
  if (!w) return Promise.reject(new Error('没有 worker'));
  return createImageBitmap(v, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'low' }).then(bmp => new Promise((res, rej) => {
    const id = ++sliceWorkerSeq;
    const to = setTimeout(() => { sliceWorkerWait.delete(id); try { bmp.close(); } catch (e) { /* 超时后释放解码位：失败也要把「超时」报出去 */ } rej(new Error('worker 编码超时')); }, 5000);
    sliceWorkerWait.set(id, { res, rej, to });
    try { w.postMessage({ id, frame: bmp, w: cw, h: ch }, [bmp]); }
    catch (e) { clearTimeout(to); sliceWorkerWait.delete(id); try { bmp.close(); } catch (e2) { /* 位图已转移/已关：close 再失败可忽略 */ } rej(e); }
  }));
}
/* 出图：worker 优先，失败就主线程 toBlob。返回 Blob（拿不到返回 null）。 */
async function sliceEncode(v, c, ctx, cw, ch) {
  try {
    const blob = await sliceEncodeInWorker(v, cw, ch);
    if (blob) return blob;
  } catch (e) { /* 退回主线程 */ }
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  try { ctx.drawImage(v, 0, 0, cw, ch); } catch (e) { return null; }
  return new Promise(r => { try { c.toBlob(b => r(b || null), 'image/jpeg', 0.6); } catch (e) { r(null); } });
}
/* 取一块时刻：调用的那只 <video> 由池子（一素材一只）传进来，这里不再新建/释放。
   `onFrame`（可省）= 每出一张就报一声（栏上要**边解边上屏**：整块七格一起等，
    首格就被压到「最慢那一格」的耗时上）。调用方自己合并重画。
   返回值 `{ miss, dead }`：dead 表示元数据都拿不到（地址过期/格式不支持），调用方要把这只 video 丢掉。 */
async function grabChunk(v, times, hit, key, onFrame) {
  const miss = new Set();
  const made = [];
  const markMiss = from => { for (const t of times) if (t >= from && !hit.has(t)) miss.add(t); };
  try {
    await Wb.vframe.meta(v);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    for (const t of times) {
      if (hit.has(t)) continue;                        // 别的那一块已经取到了
      try { await Wb.vframe.seek(v, t); } catch (e) { markMiss(t); break; }
      await sliceNextFrame(v);
      const w = v.videoWidth || 160, h = v.videoHeight || 90;
      /* 缩到 SLICE_W 宽再出图：1920×1080 的 JPEG 一格几百 KB，二十格就把内存吃掉一大块，
         而缩过之后一张只有几 KB —— 出图更快，缓存也放得下更多条素材。 */
      const cw = Math.min(SLICE_W, w), ch = Math.max(1, Math.round(h * (cw / w)));
      const blob = await sliceEncode(v, c, ctx, cw, ch);
      const url = blob ? URL.createObjectURL(blob) : '';
      if (url) {
        hit.set(t, url);
        made.push({ t, blob });
        if (onFrame) { try { onFrame(); } catch (e) { /* 上屏那一遍自己出错，不该打断解码 */ } }
        /* 单条素材的帧表也要有界：来回缩放会把每个采样时刻都留一份。
           淘汰最久没写入的那几张；1200 张远高于一屏（最多 512 格），不会动到当前这排。 */
        while (hit.size > SLICE_FRAME_MAX) {
          const first = hit.keys().next().value;
          const oldUrl = hit.get(first);
          hit.delete(first);
          try { URL.revokeObjectURL(oldUrl); } catch (e) { /* 地址已失效：不挡新的帧入表 */ }
        }
      } else miss.add(t);
    }
  } catch (e) {
    markMiss(0); /* 元数据都拿不到（外链过期 / 格式不支持）：这一排留占位 */
    return { miss, dead: true };
  }
  if (made.length) sliceCachePut(key, made);   // 落代理缓存是后台事：不 await，不挡下一块
  return { miss, dead: false };
}
const chunkAsc = (list, n) => {
  const k = Math.max(1, Math.min(n, list.length));
  const size = Math.ceil(list.length / k);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
/* 丢一条素材的帧表时要**主动释放**那些 blob URL：只丢 Map 的话对象 URL 还挂着图（一排就是几十 MB）。
   「超过 48 条就整表清空」是错的 —— 五十几条候选的工程里每剪十几刀就把全部切片作废一次，
   界面表现正是用户点名的「画面轨每次都重新加载」。现在按最久没被摸到的那一条逐条淘汰。 */
function dropFrameSrc(key) {
  const m = frameCache.get(key);
  if (m) m.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* blob 忘了释放也会被浏览器回收，不影响功能 */ } });
  frameCache.delete(key);
  /* 退避表不再跟着帧表一起删：缓存被 LRU 挤掉只说明「这一条最近没人看」，
     不代表「这些时刻取不到」。以前一起删，下一轮又立刻重解同一批必败的帧。 */
}
function evictFrameSrc() {
  for (const src of frameCache.keys()) {
    if (slicePending.has(src)) continue;               // 正在取的这一条不能清（帧还在往那张表里写）
    dropFrameSrc(src);
    return true;
  }
  return false;
}
/* 只是「读」也要刷 LRU：重画时贴的是已有帧，以前只有写入才重排，
   于是一屏正在看的素材因为「没写过」被判成最久没摸到，下次别处写入就被淘汰。 */
function touchFrameSrc(src) {
  const old = frameCache.get(src);
  if (!old) return false;
  frameCache.delete(src); frameCache.set(src, old);
  return true;
}
function frameCacheOf(src) {
  const old = frameCache.get(src);
  if (old) { frameCache.delete(src); frameCache.set(src, old); return old; }
  while (frameCache.size >= FRAME_SRC_MAX) { if (!evictFrameSrc()) break; }
  const m = new Map();
  frameCache.set(src, m);
  return m;
}
function sliceFail(key, t) {
  let m = sliceFailed.get(key);
  if (!m) { m = new Map(); sliceFailed.set(key, m); }
  const prev = m.get(t);
  const n = prev ? (prev.n || 0) + 1 : 0;
  const ttl = sliceBackoff(n);
  m.set(t, { at: Date.now(), n });
  return ttl;
}
/* 这条素材**已经写进代理**的那一批（时刻 → 字节）：合并写盘的底座，也是「别再整份 GET 一次」的依据。
   注意它比 frameCache 活得久：内存里的帧表被 LRU 淘汰不代表盘上那份也要跟着少。 */
const slicePersist = new Map();
const sliceCacheQ = new Map();        // 素材键 → 队尾 Promise（同一素材的 PUT 串行）
/* 写不进缓存不挡取帧，但也不能静默吞掉：打包格式与代理的 32MB 上限任一处对不上，
   界面看起来只是「下次打开又解码一遍」，没有第二处能看出来。同一次会话只报一声。 */
let sliceCacheWarned = false;
/* 落盘之前必须先等这一条的 GET 回来（`hydrateFrameSrc`）：否则第一块解完就 PUT，
   会把盘上原有的那几张整份覆盖成「只有这一块」—— 合并底座就是空的。 */
function sliceCachePut(key, made) {
  if (!window.Api || !Api.cachePut || !made || !made.length) return;
  let m = slicePersist.get(key);
  if (!m) { m = new Map(); slicePersist.set(key, m); }
  made.forEach(f => { const t = Number(f && f.t); if (f && f.blob && Number.isFinite(t)) m.set(t, f.blob); });
  /* 盘上那一份只留最近的 SLICE_FRAME_MAX 张：同一条素材来回缩放会把每个采样点都留一份，
     不封顶的话每写一次都要整份重传一遍越滚越大的记录。 */
  while (m.size > SLICE_FRAME_MAX) m.delete(m.keys().next().value);
  const prev = sliceCacheQ.get(key) || hydrateFrameSrc(key);
  const run = prev.catch(() => {}).then(() => {
    const list = Array.from(m, ([t, blob]) => ({ t, blob }));
    return Api.cachePut('slices', key, packFrames(list));
  }).then(ok => {
    if (ok || sliceCacheWarned) return;
    sliceCacheWarned = true;
    try { console.warn('[slices] 切片缓存没写进代理：下次重画这一条要重新解码'); } catch (e) { /* 控制台不可用就算了 */ }
  }, () => {});
  sliceCacheQ.set(key, run);
}
/* 持久缓存只在一张素材第一次出现在这一页时问一次代理。
   命中的帧直接变成本页的 blob URL 塞进 frameCache —— 后面重画走的仍是同一条同步贴帧路径，
   不给「从磁盘来的帧」另开一套画法。 */
const sliceHydrated = new Set();
const sliceHydrating = new Map();
function hydrateFrameSrc(key) {
  if (sliceHydrated.has(key)) return Promise.resolve();
  const run = sliceHydrating.get(key);
  if (run) return run;
  const p = sliceCacheLoad(key).then(list => {
    if (!list || !list.length) return;
    /* 盘上那一份是「合并写盘」的底座：先把它记下来（新解出来的同刻帧优先留着），
       后面每一块解完只在这个基础上加，不会把别的块写掉。 */
    let saved = slicePersist.get(key);
    if (!saved) { saved = new Map(); slicePersist.set(key, saved); }
    const hit = frameCacheOf(key);
    touchFrameSrc(key);
    for (const f of list) {
      if (!f || !f.blob) continue;
      const t = Number(f.t);
      if (!Number.isFinite(t)) continue;
      if (!saved.has(t)) saved.set(t, f.blob);
      if (hit.has(t)) continue;
      try { hit.set(t, URL.createObjectURL(f.blob)); } catch (e) { /* 缓存里的 blob 坏了：跳过这一张，实时解码会补 */ }
    }
  }).catch(() => {}).then(() => {
    sliceHydrated.add(key);
    sliceHydrating.delete(key);
  });
  sliceHydrating.set(key, p);
  return p;
}
/* 全页共用的那一条解码流水线：排队、认领、松手只在这一处。
   以前是「每条素材各自开 4 个解码器，素材之间再 Promise.all 全开」—— 十几条候选就是五六十个
   <video> 同时抢那几个硬件解码器，切片没变快、中栏正在播的那一条先卡。 */
/* 下一趟活：**看得见**的优先，不按入队先后。
   跨素材时如果仍 FIFO，屏幕外先入队的几条素材会把用户正盯着的那一条挤到后面。 */
function sliceNextJob() {
  if (!sliceJobs.length) return null;
  let best = -1;
  for (let i = 0; i < sliceJobs.length; i++) {
    if (sliceActive.has(sliceJobs[i].key)) continue;    // 同一条素材一次只有一趟活（两条链都不并发）
    if (best < 0 || (sliceJobs[i].prio || 0) < (sliceJobs[best].prio || 0)) best = i;
  }
  return best < 0 ? null : sliceJobs.splice(best, 1)[0];
}
/* 一素材一只 video：池子按稳定键（sliceKey）取。地址从 /getv 换成 /asset 时要换源，
   但忙着的这一只不能在中途换（这一趟的时刻还要接着 seek）—— 等它闲下来。
   忙闲不再另记一份：同一条素材一次只有一趟活由 sliceActive 把关（以前这里还记了个
   busy 计数，只加不减，闲置释放那一路被它永远短路）。 */
function sliceVideoTake(key, src) {
  let rec = sliceVideos.get(key);
  if (rec && rec.src !== src) { sliceVideoDrop(key); rec = null; }
  if (!rec) {
    rec = { v: Wb.vframe.el(src), src, timer: 0 };
    sliceVideos.set(key, rec);
  }
  if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
  return rec.v;
}
function sliceVideoDrop(key) {
  const rec = sliceVideos.get(key);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  sliceVideos.delete(key);
  Wb.vframe.release(rec.v);
}
/* 闲置 5 秒就把解码器交出去：切走镜头后池子里不该留着十几只 <video> 解着上一场的画面。 */
function sliceVideoIdle(key) {
  const rec = sliceVideos.get(key);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => { rec.timer = 0; if (!sliceActive.has(key)) sliceVideoDrop(key); }, SLICE_IDLE);
}
let sliceMbWait = false;
function slicePump() {
  if (slicePaused) return;
  /* 切片的解码器只在 media-backend.js 里造（AGENTS §7），这一层没有第二份可退。
     那一份还没到位就先不排活，等它加载完自己再来一遍；加载不起来就停在这里（格子保持占位）。 */
  if (!(window.MediaBackend && window.MediaBackend._video)) {
    if (!sliceMbWait && Wb.vframe) {
      sliceMbWait = true;
      Wb.vframe._mbReady().then(mb => {
        sliceMbWait = false;
        if (mb && !slicePaused) slicePump();
      }, () => { sliceMbWait = false; });
    }
    return;
  }
  const limit = SLICE_V1 ? 4 : SLICE_GLOBAL;
  while (sliceBusy < limit) {
    const job = sliceNextJob();
    if (!job) return;
    sliceBusy++;
    sliceActive.add(job.key);
    /* 主链先接：mediabunny 能解就一趟索引解完；退下来才轮到 <video> 池逐块 seek。
       两链只跑其一 —— 同一素材不并发两路解码。 */
    indexPass(job)
      .then(ok => (ok ? null : videoPass(job)), () => noteSliceFail(job.key, job.times))
      .then(() => {}, () => {})
      .then(() => {
        sliceActive.delete(job.key);
        sliceBusy--;
        const p = slicePending.get(job.key);
        if (p) { job.times.forEach(t => p.delete(t)); if (!p.size) slicePending.delete(job.key); }
        slicePump();
        job.res();
      });
  }
}
/* 把「缓存没有、也没人在取」的这些时刻排进流水线：**一条素材一趟活**（不是一块一个 <video>）。
   解码主链（indexPass）一趟把整张稠密帧索引铺满；只有兜底链（videoPass）才把时刻切块。
   `hot`（可省）= 这一条素材上插针指着的那一**源秒**：主链按时间升序解（顺序解码比来回跳
   快得多，不为了优先级破坏），兜底链拿它排块序（见 chunkHot）。
   `vis` = 这一栏此刻看得见：看不见的活让位给正盯着的那一条，但一格都不丢。 */
function sliceAsk(key, src, times, hit, hot, vis, onFrame) {
  const pend = slicePending.get(key);                     // 这一条素材上已经有人在取的格子，不再排第二遍
  const run = times.filter(t => !pend || !pend.has(t));
  if (!run.length) return [];
  const set = pend || new Set();
  slicePending.set(key, set);
  return [new Promise(res => {
    run.forEach(t => set.add(t));
    sliceJobs.push({ key, src, times: run.slice().sort((x, y) => x - y), hit, res, prio: vis ? 0 : 1000, hot: hot >= 0 ? hot : -1, onFrame });
    slicePump();
  })];
}
/* 把「这一格要画的 n 个时刻」和缓存里已有的帧配一次对，返回与 `ts` 等长的地址表（缺的留空）。
   正好那个时刻命中最好；命不中退到**同一张磁贴里离它最近**的那一张（tol = 一张磁贴跨的源秒）——
   这是「缩放不重新加载」的另一半：磁贴定宽之后每次缩放采样点都会挪，旧帧还在缓存里，
   与其先留一排斜纹等解码，不如当场把最近的那张贴上（画面立刻是新的那套排法），缺的再补。
   跨度问的是 `step`（渲染那一遍与采样同一份），不是 `(b-a)/张数`：定宽磁贴摊不满整格时
   `n×step > b-a`（右边那一截是被裁掉的），按后者落格会把每一张都算歪一点、就近顶上那条也就失效了。
   按 `k = round((t-a)/step)` 直接落格，整条素材的帧表只扫一遍（O(缓存大小)，不是 O(帧数×格子数)）。
   ⚠ 但「同一格内」这一条只够应付**缩下去**（格子变少、旧帧更密）。**放大**时正相反：
   一格跨的源秒变短，旧帧的采样点比新格子稀，多数新格子里一张旧帧都落不进 —— 只有 1/4 有画面、
   其余全是斜纹，而解码排在队上要一两秒，界面上看到的仍是「放大一下画面轨又转一遍」。
   所以还空着的格子再退**一档**：拿整段里离它最近的那一张，容差放宽到两格（`tol2`）。
   这一档宁可贴一张「差半秒」的画面，也不留一排斜纹骗眼睛；真帧回来时逐张换掉，不改张数与宽度。 */
/* 哪一块先解：离**插针**近的那一块先（用户盯的就是那一秒附近的画面），其余按块序补。
   块内仍然时间递增 —— 顺序 seek 比来回跳快得多，这一条不为了优先级破坏。 */
function chunkHot(chunks, hot) {
  if (!(hot >= 0) || chunks.length < 2) return chunks;
  const near = ts => (hot < ts[0] ? ts[0] - hot : hot > ts[ts.length - 1] ? hot - ts[ts.length - 1] : 0);
  return chunks.slice().sort((x, y) => near(x) - near(y));
}
/* 主链：mediabunny 批量取帧。一次向它要一个**稠密帧索引**（按素材时长分档、上限 480 张，
   口径在 slice.js 的 frameIndexPlan/frameIndexTimes），外加这一排格子真正要的那几个时刻 ——
   出来的帧全部进同一张帧表，往后无论怎么缩放重画，用的都是这一份
   （格子对帧的落点由 strip 就近顶上，新格子不用等自己的那一帧解回来）。
   返回 true = 主链接住了活（它判「没有缺的」或解完都算）；false = 退 videoPass。
   调用方（slicePump）保证同一素材一次只有一趟活，job.hit 只归这一趟写。 */
async function indexPass(job) {
  const mb = window.MediaBackend;
  if (!mb || !mb.frames || SLICE_V1) return false;
  const made = [];
  let saved = 0, planned = null;
  const putMade = () => {
    if (made.length <= saved) return;
    sliceCachePut(job.key, made.slice(saved));
    saved = made.length;
  };
  const r = await mb.frames(job.src, {
    cap: FRAME_INDEX_MAX, w: SLICE_W,
    has: t => job.hit.has(t),
    plan: (dur, has) => {
      /* 索引栅格 + 本趟要画的时刻合起来是这一次要解的集合：栅格让整条素材先有全套采样
         （缩放不再触发新解码），时刻表兜住栅格盖不到的取整误差。已在退避里的不重问。 */
      const grid = frameIndexTimes(dur).filter(t => !has(t) && !sliceBadFresh(job.key, t));
      const tiles = job.times.filter(t => !has(t) && !sliceBadFresh(job.key, t));
      planned = Array.from(new Set(grid.concat(tiles))).sort((x, y) => x - y);
      return planned;
    },
    onFrame: f => {
      if (!f || !f.blob) return;
      const t = Number(f.t);
      if (!Number.isFinite(t)) return;
      const url = URL.createObjectURL(f.blob);
      job.hit.set(t, url);
      made.push({ t, blob: f.blob });
      while (job.hit.size > SLICE_FRAME_MAX) {
        const first = job.hit.keys().next().value;
        const oldUrl = job.hit.get(first);
        job.hit.delete(first);
        try { URL.revokeObjectURL(oldUrl); } catch (e) { /* 地址已失效：不挡新的帧入表 */ }
      }
      if (job.onFrame) { try { job.onFrame(); } catch (e) { /* 上屏那一遍自己出错，不该打断解码 */ } }
      if (made.length - saved >= 150) putMade();   // 长趟中途落盘：别攒几百张才写，一断全丢
    },
  });
  if (!r || r.mode === 'fallback') return false;
  /* 主链接了活却一帧都没交出来（迭代器空转 / 定点全 null）：退兜底，别把整排钉死在主链上 ——
     兜底那条是另一套解码路径，同一个文件它经常解得动。出了一部分帧就照旧收下：
     缺的时刻记退避，就近顶上先画着大头。 */
  if (!made.length && (r.mode === 'stream' || (planned && planned.length))) {
    noteSliceFail(job.key, r.mode === 'stream' ? job.times : planned.filter(t => !job.hit.has(t)));
    return false;
  }
  if (r.mode === 'stream') {
    /* 整段流式出来的是真实包时刻，与栅格时刻对不齐（差零点几秒是常态），
       靠 strip 的就近顶上。 */
  } else if (planned) {
    noteSliceFail(job.key, planned.filter(t => !job.hit.has(t)));
  }
  putMade();
  return true;
}
/* 兜底链：<video> 池逐块 seek（mediabunny 解不动的容器 / 远程且包数装不下的走这条）。
   块序按「离插针近的先」排（chunkHot），块内时间递增 —— 顺序 seek 比来回跳快得多。 */
async function videoPass(job) {
  const v1 = SLICE_V1;
  const asc = job.times.slice().sort((x, y) => x - y);
  const chunks = chunkHot(chunkAsc(asc, Math.max(1, Math.min(SLICE_GLOBAL, Math.ceil(asc.length / 3)))), job.hot);
  const v = v1 ? Wb.vframe.el(job.src) : sliceVideoTake(job.key, job.src);
  try {
    const left = chunks.slice();
    while (left.length) {
      const ts = left.shift();
      const r = await grabChunk(v, ts, job.hit, job.key, job.onFrame);
      noteSliceFail(job.key, r.miss);
      if (r.dead) {
        if (!v1) sliceVideoDrop(job.key);            // 元数据都拿不到：这只解码器别再留着
        left.forEach(rest => noteSliceFail(job.key, rest));
        break;
      }
    }
  } catch (e) { noteSliceFail(job.key, job.times); }
  finally { if (v1) Wb.vframe.release(v); else sliceVideoIdle(job.key); }
}
/* 导演台切走时停掉切片解码；切回来再从原队列继续（已经取到的帧都在 frameCache 里）。 */
window.addEventListener('spa:page', e => {
  const d = e && e.detail;
  if (!d || (d.file && d.file !== 'director.html')) return;
  const paused = d.visible === false;
  if (paused === slicePaused) return;
  slicePaused = paused;
  if (!paused) sliceResume();
});

/* 片段 → 导出来源地址（本地导入 / 链接已过期的候选会先转存成一条长期有效的资产） */
async function tlClipSrc(c) {
  /* 灰掉那一段的素材就是黑场本身：不再去取候选的地址、也不做转存（那一段画面用户已经说了不要）。
     代理那边 `src === 'black'` 走 lavfi 生成，段长由 in/out 决定 —— 所以时长还是那几秒。 */
  if (c.gray) return 'black';
  const EM = window.EditorMedia;
  if (c.kind === 'asset') {
    const s = EM ? EM.exportSrc(c) : (c.src || (c.assetId ? Api.assetSrc(c.assetId) : ''));
    return s || null;
  }
  const sh = allShots().find(s => s.id === c.shotId);
  const cand = sh && tlCandidateOf(sh, c.candId);
  if (!cand) return null;
  /* 导出永远本机优先：有镜像就用 /asset/<la>，不受「优先用本机」显示开关影响。 */
  if (EM && EM.localIdOf(cand)) return EM.exportSrc(cand);
  const isRemote = cand.url && /^https?:\/\//.test(cand.url);
  if (isRemote) return EM ? EM.exportSrc(cand) : null;   // 没有本机副本时仍回平台
  if (cand.url && cand.url.startsWith('/asset/')) return EM ? EM.exportSrc(cand) : cand.url;
  // 没带地址、但任务号本身就是本家资产：直接引用（不区分图/视频台，按 relay 判同一套资产库）
  if (!cand.url && cand.vid && sameAssetSpace(cand.provider, assetStoreId())) return Api.assetSrc(cand.vid);
  // 本地导入 / 过期链接：转存成资产（走通用跨平台转存通道；/asset/ 只认资产库那一家的资产号，见 assetStoreId 注释）
  if (c.assetId) return Api.assetSrc(c.assetId);
  /* 原来这里还先取`cand.blobKey` 指向的 IndexedDB 字节 —— 而 blobKey 从没有一处赋值，
     那一支恒为null，等于多一次查库却从不生效（IndexedDB 里没有 blobKey 的索引）。删掉。
     真正在用的是下面这条：本地导入 / 过期链接当场转存成本机资产（toAsset）。 */
  const fresh = await freshUrl(cand).catch(() => null);
  const source = fresh;
  if (!source) return null;
  if (EM && EM.localIdOf({ src: source })) return EM.exportSrc({ src: source });
  const aid = await AssetTransfer.toAsset(assetStoreId(), source, { reg: REGOf(), name: (cand.name || 'clip') + '.mp4', contentType: 'video/mp4' });
  c.assetId = aid; scheduleSave();
  return Api.assetSrc(aid);
}

/* ---------------- 新时间线的胶片格：按源秒要帧 ----------------
   clip.src 存的是平台原地址（可能带过期签名），解码前过一道 mediaSrc —— 与页面别处同一条出口，
   本机有副本就用本机那份，缓存键也跟着稳定（sliceKey 认的就是归一化之后的身份）。
   `ensureFrames` 返回与入参**等长**的地址表：取不到的那一格给空串，调用方照旧按格序贴
   （缺的由 strip 就近顶上），不会因为中间一帧失败把后面的画面整体错位。 */
  const frameSrcOf = clip => {
    const raw = String((clip && clip.src) || '');
    if (!raw) return '';
    try { return (mediaSrc ? mediaSrc(raw) : raw) || raw; } catch (e) { return raw; }
  };
  function framePeek(clip, times, tol = 0.4) {
    const list = (Array.isArray(times) ? times : []).map(Number).filter(Number.isFinite);
    const src = frameSrcOf(clip);
    if (!src || !list.length) return list.map(t => ({ t, url: '' }));
    const hit = frameCache.get(sliceKey(src));
    if (!hit || !hit.size) return list.map(t => ({ t, url: '' }));
    const keys = Array.from(hit.keys()).filter(Number.isFinite).sort((a, b) => a - b);
    const limit = Math.max(0.04, Number(tol) || 0.4);
    return list.map(t => {
      if (hit.has(t)) return { t, url: hit.get(t) };
      let lo = 0, hi = keys.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < t) lo = m + 1; else hi = m; }
      let best = '', bd = Infinity;
      for (const k of [keys[lo - 1], keys[lo]]) {
        if (!Number.isFinite(k)) continue;
        const d = Math.abs(k - t);
        if (d < bd && d <= limit) { bd = d; best = hit.get(k) || ''; }
      }
      return { t, url: best };
    });
  }
  async function ensureFrames(clip, times) {
    const list = (Array.isArray(times) ? times : []).map(Number).filter(Number.isFinite);
    const src = frameSrcOf(clip);
    if (!src || !list.length || (clip && clip.kind === 'image')) return list.map(t => ({ t, url: '' }));
    const key = sliceKey(src);
    await hydrateFrameSrc(key);
    touchFrameSrc(key);
    const hit = frameCacheOf(key);
    const need = Array.from(new Set(list.filter(t => !hit.has(t) && !sliceBadFresh(key, t))));
    if (need.length) await Promise.all(sliceAsk(key, src, need, hit, -1, true, () => {}));
    /* 回来的是**整个文件里真实存在的帧时刻**（流式那条路给的是包时刻，与请求的栅格差零点几秒是常态），
       所以按「相邻两格跨多远」定容差取最近的一张 —— 按 0.04 秒死抠的话，一张都对不上，
       整条带子会一直停在占位斜纹上。 */
    const span = list.length > 1
      ? (list[list.length - 1] - list[0]) / (list.length - 1)
      : 0.5;
    return framePeek(clip, list, Math.max(0.041, span * 0.55));
  }

  return {
    sliceForgetFail,
    tlClipSrc,
    ensureFrames,
    framePeek,
  };
}
