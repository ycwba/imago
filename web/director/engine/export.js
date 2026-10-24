/* 导演台导出域：成片指纹、导出成片（浏览器内逐帧合成）、导出素材、FCPXML / 媒体包、
   送到剪映 / 达芬奇。engine.js 只留状态与接线（AGENTS.md §17：内部保持命令式、按域拆模块）。
   引擎状态一律经 createExport(E) 递进来的访问器读写；这里不放第二份工程数据。 */
import { exportFCPXML as runFcpExport, sendToNle as runSendNle } from '../fcpxml.js';
import { filmEntriesOf, currentOf, styleOf } from '../subtitles.js';
import { round1, round2 } from '../util.js';

export function createExport(E) {
  const {
    $, setStatus, projOf, allShots, tlSyncFromShots, tlClipDur, tlClipSrc, tlDuration, fmtDur,
    clipVoices, voicesEnsure, voiceVolOf, tlCandidateOf, candDur, healStaleUrls,
    filmFrames, filmLayGray, filmSize, saveBlob, scheduleSave, renderAll, filmRowsForSubtitles,
    readJsonSafe,
    BoardAssetsOf,
  } = E;

/* 导出前提醒「@待建:」还没出图的素材（拆分镜建的档还没出预览图）：这些镜头的提示词里
   还是占位符，导出的成片 / 素材包里只带文字不带图。可继续导出，但必须吭声 ——
   静默出一个「带占位符的成片」比导不出来还糟（用户会以为参考图都带上了）。
   返回提醒句（没有待建就空串）；调用方写状态条并把它并进回执。 */
function pendingAssetNote() {
  const BA = (typeof BoardAssetsOf === 'function' && BoardAssetsOf()) || null;
  if (!BA || !BA.pendingIn) return '';
  const seen = new Set();
  let shots = 0;
  (allShots() || []).forEach(sh => {
    const p = BA.pendingIn(String((sh && sh.prompt) || ''));
    if (p.length) {
      shots++;
      p.forEach(n => seen.add(String(n).toLowerCase()));
    }
  });
  if (!seen.size) return '';
  return '还有 ' + seen.size + ' 个素材没出图（引用它们的 ' + shots + ' 镜只带文字不带图）';
}
function warnPendingAssets() {
  const note = pendingAssetNote();
  if (note) setStatus('<span class="warn">⚠ ' + note + ' —— 继续导出，出完图再导一次就能带上图</span>');
  return note;
}

/* 浏览器内导出（web/media-export.js，经典脚本挂 window.MediaExport）按需补载：
   只在点导出时用，但**补载在引擎装好时就预热**（createExport 进来先踢一脚），
   等真点「导出」时它早就就绪 —— 否则那一下的等待会卡在用户手势的正中间。 */
let mediaExportP = null;
function ensureMediaExport() {
  if (window.MediaExport) return Promise.resolve(window.MediaExport);
  if (!mediaExportP) {
    mediaExportP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/web/media-export.js';
      s.onload = () => window.MediaExport ? res(window.MediaExport) : rej(new Error('浏览器内导出模块没有挂上'));
      s.onerror = () => rej(new Error('浏览器内导出模块没加载成（web/media-export.js）'));
      document.head.appendChild(s);
    });
  }
  return mediaExportP;
}
try { ensureMediaExport().catch(() => {}); } catch (e) { /* 预热失败不挡引擎；真导出时会再试一次 */ }

/* 成片的会话内字节缓存（指纹 → Blob）：刚导出过的那一份，同内容再点直接给，不再合成一遍。
   只活在当前会话（刷新后没有）—— 浏览器里没有第二个持久去处（服务端渲染目录已删），
   刷新后第一次导出会重新合成，这比在用户盘上悄悄多存一份要干净。 */
const filmBlobCache = new Map();

/* 时间线 → 送给 MediaExport 的 clips。导出与「合并全片」以前各抄了一份逐字相同的循环
   （连「第 N 段没有可用素材」那句一起），收成这一份。
   `tl` 由调用方递进来（就是它刚 `tlSyncFromShots()` 出来的那一份），
   因为这一页没有一个全局的「当前时间线」可变对象 —— 每次都是现同步。
   循环前先把过期外链**一次批量**换新一轮（healStaleUrls → Api.healMedia 按平台分组，
   声明了 pollVia:'list' 的那一族一次列表请求解出整批）：
   逐段 tlClipSrc → freshUrl 各问一次的话，三十段就是三十次「100 条的列表」，
   而它们问的是同一家平台的同一份数据。 */
async function buildRenderClips(tl) {
  await healStaleUrls().catch(() => 0);      // 换不到新地址不是错：下面照旧拿旧地址试一次
  const clips = [];
  /* 这一次组装里「没进画面」的配音句数。它以前是 engine.js 的模块级变量，而唯一的读它的
     那句状态文案早已删掉 —— 现在只在这一个函数里由零累加到最后，就留在这里，不外溢。 */
  let voiceSkip = 0;
  /* 全片灰场表（**成片秒**）算一次给所有段用：一句配音压在灰场上时按它劈成几截
     （见 clipVoices 的 ctx）。逐段各拼一份就会各漂一次（倍速一掺进来更对不上）。 */
  const G = filmFrames(tl);
  const gray = filmLayGray(G);
  let placed = 0;
  for (let i = 0; i < tl.clips.length; i++) {
    const c = tl.clips[i];
    /* 图片段：画面是一张**静态图**，不是可解码的视频段 —— 不去问 tlClipSrc（那会拿回它底下的候选），
       也不带原声。地址走与视频同一个「本机优先」口径，合成那一侧整段只画这一张。 */
    if (c.img) {
      const still = window.EditorMedia ? window.EditorMedia.exportSrc({ src: c.img }) : c.img;
      if (!still) throw new Error(`第 ${i + 1} 段「${c.imgName || c.name || '图片'}」没有可用的图片（本地文件可能已被清理）`);
      const vvImg = clipVoices(c, { start: G.rows[i].f0, gray: gray });
      voiceSkip += vvImg.skip;
      placed += vvImg.placed;
      const oneImg = { src: 'black', still, in: c.in, out: c.out, speed: 1, volume: 0 };
      if (vvImg.list.length) oneImg.voices = vvImg.list;
      clips.push(oneImg);
      continue;
    }
    const src = await tlClipSrc(c);
    if (!src) throw new Error(`第 ${i + 1} 段「${c.name || ''}」没有可用素材（本地文件可能已被清理）`);
    /* 这一段带上它的配音（`at` 相对本段起点，代理那侧按 start 延迟后与原声 amix）。
       放不进来的那些（这一剪把画面切短了、或整段被删）只计数不静默吞 —— 见 voiceSkip 的两句状态。 */
    const vv = clipVoices(c, { start: G.rows[i].f0, gray: gray });
    voiceSkip += vv.skip;
    placed += vv.placed;
    const one = { src, in: c.in, out: c.out, speed: c.speed || 1, volume: c.volume == null ? 1 : c.volume };
    if (vv.list.length) one.voices = vv.list;
    clips.push(one);
  }
  const anchored = voicesEnsure().length;
  voiceSkip += Math.max(0, anchored - placed - voiceSkip);   // 锚在已不存在的段上的那些也算没进画面
  return clips;
}

/* ---------------- 浏览器内离线导出 ---------------- */
let rendering = false;

let renderCancelled = false;
/* 按钮统一走这个入口：渲染中再点一次 = 取消（长任务不再只能干等 15 分钟） */
/* 浏览器侧合成的取消闸：渲染循环每帧都看 signal.aborted（见 media-export.js 的 throwIfAbort）。
   服务端渲染已删 —— 没有代理任务可杀，停就是这个 abort。 */
let renderAbortCtl = null;
function abortRender() {
  renderCancelled = true;
  if (renderAbortCtl) { try { renderAbortCtl.abort(); } catch (e) { /* 收尾清理，失败也要往下走 */ } }
}
function exportFilmClick() { if (rendering) { abortRender(); return; } exportFilm(); }

/* ============================================================================
   导出素材：把选定成片里的**视频片段**与**音频片段**分别导出
   ---------------------------------------------------------------------------
   「导出成片」给的是一条接好的片子；这个入口给的是**零件**：每一段画面一个文件、
   每一句配音一个文件。用途是把这批素材搬到别的工具里继续用（做字幕、换配音、
   二次剪辑），也方便只重新做其中一段而不用重跑整片。

   走**同一套**浏览器内导出（`MediaExport`，不新开一条导出通道）：
     · 视频片段 = N 次单段导出，每段一个 mp4。分辨率/帧率沿用成片那一档（`filmSize`），
       所以导出来的片段直接接回去也是同一个规格。
     · 音频片段 = 每句配音一条：只混这一句、不建画面轨，出 m4a（`MediaExport.exportClip` 的 `audioOnly`）。
   两类都**逐个**跑而不是一次全交：一次全交的话，一个片段失败整批都没了，
   而用户要的就是「单独再导某一段」。
   ========================================================================== */
async function exportFilm(opts) {
  const o = opts || {};
  if (rendering) { setStatus('已有导出任务在进行中…'); return { ok: false, busy: true, err: '已有导出任务在进行中' }; }
  const pendNote = warnPendingAssets();
  /* 时间线**先建**，再判空。
     以前这里是 `tlEnsure()`：它只在 `projOf().timeline` 缺失时补一个空壳，不从镜头建内容 ——
     而 `tlSyncFromShots`（能从镜头建出时间线的那一份）只在合并那一条路里被调。
     于是「剪辑 → 全片」那一排的实时预览把时间线建好了（它经过 tlSyncFromShots），
     而「导出成片」不会：生成了 5 个镜头但没打开过「剪辑 → 全片」时点导出被拦，
     报的是「先在候选卡上点『用这条』选用镜头」—— **而镜头全都已选用**。
     判据与理由都换成同一句：先把时间线同步出来，真的空了才是「没有可用镜头」。 */
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    setStatus('<span class="err">现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面</span>');
    return { ok: false, err: '现在一个可用镜头都没有' };
  }
  /* 已经有一份**当前**的成片（导出过、内容没变、字节还在本次会话里）：直接给它，不再合成一遍。
     会话缓存没有（刷新过 / 换了工程）就落进下面的正常导出 —— 重新合成一份，不报「盘上那份没了」。 */
  const prevFp = projOf().merged && filmIsCurrent(projOf().merged) ? projOf().merged.name : '';
  const cached = prevFp ? filmBlobCache.get(prevFp) : null;
  if (cached) {
    const saved = await saveBlob(prevFp, cached);
    setStatus('<span class="ok">' + saved.msg + '（' + window.fmtBytes(cached.size) + ' · 这一轮刚合成的那份）</span>');
    return { ok: true, shortcut: true, out: prevFp, clips: tl.clips.length };
  }
  const size = filmSize();
  const btn = $('exportFilm');   // 主栏那个「导出成片」
  const ff = ExportFormats.of('film');
  rendering = true; renderCancelled = false;
  if (btn) { btn.disabled = false; btn.textContent = ff.cancelLabel; }
  const abortCtl = new AbortController();
  renderAbortCtl = abortCtl;
  try {
    setStatus('正在准备素材地址…');
    const ME = await ensureMediaExport();
    const clips = await buildRenderClips(tl);
    /* 段在成片里的起点秒（浏览器合成按它落帧）：与 filmFrames 的行起点同口径。 */
    let f0 = 0;
    clips.forEach(c => { c.filmStart = f0; f0 += Math.max(0, (Number(c.out) - Number(c.in)) / (Number(c.speed) || 1)); });
    /* 字幕跟着这一条导出一起烧：每条栅格化成与成片同宽高的 PNG（dataURL，不落资产库），
       合成循环里在 [start,end) 画上去。栅格化失败就**当场停**（不导出一份没有字幕的成片假装成功）。 */
    let subs = null;
    try {
      subs = await subtitleBurnItems(size);
    } catch (e) {
      throw new Error('字幕烧录准备失败：' + errText(e));
    }
    if (o.onStarted) { try { o.onStarted({ clips: tl.clips.length, subtitles: subs ? subs.items.length : 0 }); } catch (e) { /* 回调是调用方给的，它抛错不该把已经提交的导出带崩 */ } }
    const r = await ME.exportFilm({
      clips, width: size.w, height: size.h, fps: 30, duration: f0,
      subtitles: (subs && subs.items) || [],
      signal: abortCtl.signal,
      onProgress: j => {
        if (btn) btn.textContent = ff.cancelLabel + ' ' + (j.progress || 0) + '%';
        if (o.onProgress) { try { o.onProgress(j); } catch (e) { /* 进度回调抛错不影响任务本身 */ } }
      },
    });
    const blob = r.blob;
    /* 扩展名跟导出回来的走：没有 H.264 的浏览器出的是 .webm（选容器在 MediaExport.pickCodec），
       名字写成 .mp4 的话资产库与系统都会认错类型。 */
    const outName = stampName(r.ext || 'mp4');
    const saved = await saveBlob(outName, blob);
    filmBlobCache.set(outName, blob);          // 同内容再点直接给
    /* 导出也是一份成片：记进 proj.merged（带内容指纹，判据就是 filmIsCurrent 那一句）。
       指纹的字段名就叫 `fp`：`filmIsCurrent` 认不出别的名字，
       少了它会被当成「没有指纹的老成片」而退回只比段数（换候选、改入出点就判不出来了）。 */
    projOf().merged = { name: outName, duration: round1(tlDuration()), ts: Date.now(),
      clips: tl.clips.length, fp: filmFingerprint(tl.clips), size: blob.size || 0 };
    scheduleSave();
    const subN = subs ? subs.items.length : 0;
    setStatus('<span class="ok">' + saved.msg + `（${tl.clips.length} 段 · ${fmtDur(tlDuration())} · ${window.fmtBytes(blob.size)}`
      + (subN ? ' · 烧录字幕 ' + subN + ' 条' : ' · 没有字幕') + '）</span>'
      + (r.diag && r.diag.decodeModes && r.diag.decodeModes.length
        ? '<span class="meta"> · 取帧：' + r.diag.decodeModes.map(m => ({ 'sequential-webcodecs': '顺序解', 'precise-seek': '逐格定位', 'static-image': '静态图' }[m] || m)).join(' / ') + '</span>' : '')
      + (subs && subs.missing.length ? '<span class="warn"> · 有 ' + subs.missing.length + ' 个镜头的字幕没进成片（没有选用候选）</span>' : '')
      + (pendNote ? '<span class="warn"> · ⚠ ' + pendNote + '</span>' : ''));
    return { ok: true, out: outName, bytes: blob.size, clips: tl.clips.length,
      duration: round1(tlDuration()), subtitles: subN, missingSubtitles: subs ? subs.missing.length : 0, pendingNote: pendNote };
  } catch (e) {
    setStatus(e.message === '已取消'
      ? '已取消：这一轮合成已停下，没写任何文件'
      : '<span class="err">导出失败：' + e.message + '</span>');
    return { ok: false, err: e.message, cancelled: e.message === '已取消' };
  } finally {
    rendering = false; renderCancelled = false; renderAbortCtl = null;
    if (btn) { btn.disabled = false; btn.innerHTML = icon(ff.icon, 13) + ' ' + ff.label; }
  }
}

/* ============================================================================
   FCPXML 导出（Final Cut Pro / 达芬奇可导入的交换格式）
   ----------------------------------------------------------------------------
   导的是**当前时间线**：镜头顺序、每段的入出点、倍速、配音位置都保留。
   素材引用优先用本机资产库里的真实文件（`/sys-status` 的资产目录 + la_ 号 + 格式）；
   本机没有落盘的那几条仍然建一个离线 asset（名字 + 原地址写进文件开头的注释），
   FCP 导入后会显示离线，用户按名单补文件 / 重新链接即可 —— 不静默丢段。
   **不改变任何工程数据**：只读 tlSyncFromShots() 的结果与 proj.voices。 */
/* FCPXML 的上下文：单文件 / 媒体包 / 送到 NLE 三条出口传的是同一份。
   只读 tlSyncFromShots() 的结果与 projOf().voices，不改变任何工程数据。 */
function fcpCtx() {
  return {
    proj: projOf(),
    tlSyncFromShots, healStaleUrls, filmSize, setStatus,
    el: id => $(id),
    tlClipDur, tlClipSrc, allShots, tlCandidateOf, candDur, voicesEnsure, voiceVolOf, styleOf,
    AssetLocal: window.AssetLocal, Api: window.Api, Net: window.Net,
  };
}
async function exportFCPXML(opts) {
  warnPendingAssets();
  return runFcpExport(fcpCtx(), opts || {});
}

/* 送到达芬奇 / 剪映：两个独立目标各走各的（拆成两行后不再弹选择框）。
   「一键」到启动软件为止；最后那一步导入只能由用户在软件里点
   （两家都没有可靠的命令行「打开并导入这个文件」协议，不假装能替他点）。 */
async function exportNle(opts) {
  opts = opts || {};
  warnPendingAssets();
  const app = opts.app === 'jianying' ? 'jianying' : 'resolve';
  let r;
  try { r = await runSendNle(fcpCtx(), { app }); }
  catch (e) {
    const msg = errText(e);
    setStatus('<span class="err">送到 ' + (app === 'jianying' ? '剪映' : '达芬奇') + ' 失败：' + esc(msg) + '</span>');
    return { ok: false, err: msg };
  }
  if (r && r.ok && !opts.silent) nleDialog(r);
  return r;
}
/* 工程已经生成好了才有这一步：目录、缺失数与导入路径一次说清；
   「打开文件夹」与「复制路径」都是可用的退路（软件没装 / 装在别处也不影响导入）。 */
function nleDialog(r) {
  const isJY = r.app === 'jianying';
  UiDialog.open({
    title: '已生成' + r.appName + '导入工程',
    sub: r.launch && r.launch.ok ? '软件已启动；最后一步在软件里点一次导入' : '工程已生成；软件没启动也不影响导入',
    body(el) {
      el.innerHTML = '<div class="dlg-line">工程目录：<b>' + esc(r.dir) + '</b></div>'
        + '<div class="dlg-line">时间线：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音'
        + (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '') + '</div>'
        + (r.missingCount ? '<div class="dlg-warn">有 ' + r.missingCount + ' 份素材没取到：名单在同目录的 missing.txt（导入后显示离线，补齐文件再重新链接）</div>' : '')
        + '<div class="dlg-hint">' + (isJY
          ? '剪映：菜单 → 导入 → 时间线 / FCPXML，选目录里的 project.fcpxml。若找不到这一项，先到 全局设置 打开 FCPXML 导入；素材在 media/ 里。'
          : '达芬奇：文件 → 导入 → 时间线（FCPXML），选目录里的 project.fcpxml；素材会自动从 media/ 链接。') + '</div>'
        + (r.launch && !r.launch.ok ? '<div class="dlg-warn">没有自动启动软件：' + esc(r.launch.reason || '') + ' 请手动打开。</div>' : '');
    },
    actions: [
      { label: '打开文件夹', value: 'open', primary: true,
        onClick: () => { revealNle(r.id); return false; } },
      { label: '复制路径', value: 'copy',
        onClick: async () => {
          const ok = window.copyText ? await window.copyText(r.dir) : false;
          if (ok) Toast.ok('路径已复制'); else Toast.warn('复制失败：请手动选中上面的路径');
          return false;
        } },
      { label: '关闭', value: null },
    ],
  });
}
async function revealNle(id) {
  try {
    await window.Net.json('/fcpxml/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
  } catch (e) { Toast.warn('打不开文件夹：' + errText(e)); }
}

/* ============================================================================
   剪辑 → 全片：成片的出口只有**导出**这一条
   合并结果记在 projOf().merged = { name, duration, ts, clips, size, fp }。
   顶部那颗「播放成片」已删（2026-10 用户点名）：看整片走「剪辑 → 全片」那一排的实时预览
   （播放器那一排的 `#pbBtn` → `TlPlay.play()`），它按时间线直接播，**绝不为播放整片合成**。
   合成只发生在「导出成片」那一下（exportFilm 自己 renderPost，把结果记进 projOf().merged）。
   `filmIsCurrent(projOf().merged)` 是「导出」这一条路自己用的快捷闸：盘上那份还能不能直接用。
   ========================================================================== */
/* 这一份成片对应的是**哪一串内容**：每段的 [镜头 id, 选用的候选, 第几段, 入点, 出点, 速度, 音量,
   这一段带哪几句配音]，按顺序。
   取址与合成一致（顺序取 tlSyncFromShots 的结果 —— 拖动顺序就体现在这里），
   所以「换候选 / 改入出点 / 切开或删段 / 拖顺序 / 加删配音」任何一件都会让指纹变。
   切口必须是「逐段一项」，不能塌成「候选的首末入出点」：切开**不改**首段的入点、
   也不改末段的出点（只是中间多了一个接缝），塌成那一对数的话「切成两段」会被读成没变，
   于是播的/导出还是上一版画面（旧模型只有 trimS/trimE，那一版就是用这两个数当指纹的）。 */
function filmFingerprint(clips) {
  const list = clips || [];
  /* 配音的跳过判定（voiceFp 的 ctx）要两样东西：这一段的**成片起点**与**全片灰场表**，
     两个都按「Σ 前面每一格的 tlClipDur」现累一遍 —— 与 buildRenderClips 收到的 ctx 同一本账，
     所以「剪辑改了、指纹没变」这类事不会在多出来的这一遍换算里重生。
     灰场那几秒本身也进指纹（`c.gray` 那一位）：删一段画面 → 灰场表变 → 压在上面的那几句跟着劈。 */
  const f0s = []; const gray = []; let film = 0;
  list.forEach(c => {
    const fd = tlClipDur(c);
    f0s.push(film);
    if (c.gray) gray.push([film, film + fd]);
    film += fd;
  });
  return list.map((c, i) => [c.shotId || '', c.candId || c.vid || c.cand || '',
    c.seg == null ? 0 : c.seg, c.in || 0, c.out || 0,
    c.speed || 1, c.volume == null ? 1 : c.volume, c.gray ? 'g' : '',
    voiceFp(c, { start: f0s[i], gray: gray })].join('~')).join('|')
    + '||sub:' + subtitleFingerprint();
}
/* 字幕也进成片指纹：改一句字幕、换字号颜色，盘上那份成片就旧了。
   不把 `projOf().rev` 直接塞进指纹 —— 撤销 / 改一个不入片的字段也会让 rev 变，
   那会把「内容没变」误判成旧片而白跑一遍合成。这里只认真正印在画面上的东西：
   每一镜的条目（起止、文字、来源）与样式，按镜头顺序。 */
function subtitleFingerprint() {
  const parts = [];
  allShots().forEach(sh => {
    const cur = currentOf(sh, voicesEnsure());
    if (!cur.entries.length) return;
    parts.push(sh.id + '~' + cur.source + '~' + JSON.stringify(cur.entries) + '~' + JSON.stringify(styleOf(sh)));
  });
  return parts.join('|');
}
/* 「盘上那一份成片是不是当前的」—— 「导出能不能走快捷路径」只问这一句。
   旧数据（合并时还没存指纹的）没有 fp：那时候只按段数判，与原行为一致，不把它当陈旧。 */
function filmIsCurrent(m) {
  if (!m) return false;
  const tl = tlSyncFromShots();
  if (m.fp == null) return m.clips === tl.clips.length;      // 老成片：退回段数（与从前一致）
  return m.fp === filmFingerprint(tl.clips);
}

/* 烧录：每条字幕栅格化成与成片同宽高的透明 PNG（预览与 SRT 之外的第二条保底），
   导出合成时在 [start,end) 逐帧画上去；只在导出这一趟的会话内存里，不进资产库也不落盘。 */
function subCanvasB64(entry, style, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('这台机器的浏览器给不出 2D 画布，烧录字幕做不了（导出 SRT 或 FCPXML 不受影响）');
  const scale = h / 1080;
  const fs = Math.max(12, Math.round(style.fontSize * scale));
  ctx.font = '600 ' + fs + 'px "' + String(style.fontFamily || 'PingFang SC').replace(/"/g, '') + '", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = String(entry.text || '').replace(/\r\n?/g, '\n').split('\n');
  const lh = fs * 1.25;
  const y0 = style.position === 'top' ? h * 0.14 : style.position === 'middle' ? h / 2 : h * 0.86;
  if (style.highlight) {
    let mw = 0;
    lines.forEach(ln => { mw = Math.max(mw, ctx.measureText(ln).width); });
    const pad = fs * 0.45;
    const bh = lh * lines.length + pad * 2;
    const bw = mw + pad * 2;
    const x = w / 2 - bw / 2;
    const y = y0 - (lh * (lines.length - 1)) / 2 - lh / 2 - pad;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const r0 = Math.min(12, bh / 2);
    ctx.beginPath();
    ctx.moveTo(x + r0, y);
    ctx.lineTo(x + bw - r0, y); ctx.quadraticCurveTo(x + bw, y, x + bw, y + r0);
    ctx.lineTo(x + bw, y + bh - r0); ctx.quadraticCurveTo(x + bw, y + bh, x + bw - r0, y + bh);
    ctx.lineTo(x + r0, y + bh); ctx.quadraticCurveTo(x, y + bh, x, y + bh - r0);
    ctx.lineTo(x, y + r0); ctx.quadraticCurveTo(x, y, x + r0, y);
    ctx.closePath(); ctx.fill();
  }
  ctx.shadowColor = 'rgba(0,0,0,.9)';
  ctx.shadowBlur = Math.max(2, fs * 0.12);
  ctx.fillStyle = style.color;
  lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + (i - (lines.length - 1) / 2) * lh));
  return cv.toDataURL('image/png').split(',')[1] || '';
}
async function subtitleBurnItems(size) {
  const { rows } = filmRowsForSubtitles();
  const got = filmEntriesOf(rows, allShots(), voicesEnsure());
  if (!got.entries.length) return { items: [], count: 0, missing: got.missing };
  const items = [];
  for (let i = 0; i < got.entries.length; i++) {
    const e = got.entries[i];
    const sh = allShots().find(x => x.id === e.shotId);
    const b64 = subCanvasB64(e, styleOf(sh), size.w, size.h);
    /* 栅格化出来的 PNG 直接当 dataURL 交给合成（浏览器内导出自己画）——
       不再落本机资产库：字幕是**这一条成片的中间产物**，不是用户的素材，
       以前每导一次就在资产库攒几十张 subtitle-N.png，占磁盘还没人会去用它。 */
    items.push({ src: 'data:image/png;base64,' + b64, start: round2(e.filmStart), end: round2(e.filmEnd) });
    if (i % 5 === 4) setStatus('<span class="meta">正在栅格化字幕 ' + (i + 1) + '/' + got.entries.length + '…</span>');
  }
  return { items, count: items.length, missing: got.missing };
}

function stampName(ext) {
  /* 时间戳与非法字符各归公共一份（`web/ui/ui.js` 的 `fileStamp` / `fileSafe`）；
     这一页只管形状：「项目名-成片-年月日-时分秒.扩展名」。
     项目名以前不截断，而 Windows 的整条路径有上限 —— 现在跟着 fileSafe 收到 60 个字。 */
  return window.fileSafe((projOf() && projOf().name) || '成片', 60) + '-成片-' + window.fileStamp() + '.' + ext;
}

/* 一句配音在指纹里的样子：落在哪一秒、念多长、从音频第几秒取、**多大声**、**多快**。
   以前少了最后那一位 —— 于是「拖底边那条调音量」（或剪辑条上的音量 ±）改完，
   `filmFingerprint` 一个字不变 → `filmIsCurrent` 说盘上那份还是新的 → 连「导出成片」都走
   快捷路径直接把旧的那份递出去（downloadMergedFilm），
   界面上没有任何一句「成片是旧的」，用户听到的还是上一版的音量
   （用户点名的「音轨现在好像不能正确调整音量」：数据存对了、合成也照那份混音，只是没人去重合成）。
   `off` 那一位以前同样没有，只是它总与 `at` 一起变（拖左把手两头同时走），所以没露过馅 —— 
   留着：任何一个数改了而指纹不变，都是同一类错。
   每一句一行、写成表达式而不是拼串：变异对照的锚点只能取单行（这份源码是 CRLF）。 */
const voiceFpOne = v => [Math.round(v.start * 10) / 10, v.dur, Math.round((v.off || 0) * 10) / 10, Math.round(Number(v.vol == null ? 1 : v.vol) * 100) / 100, Math.round(Number(v.spd || 1) * 100) / 100].join('~');
const voiceFp = (c, ctx) => clipVoices(c, ctx).list.map(voiceFpOne).join(',');
  return {
    filmClick: exportFilmClick,
    exportFilm: exportFilm,
    fcp: exportFCPXML,
    resolve: () => exportNle({ app: 'resolve' }),
    jianying: () => exportNle({ app: 'jianying' }),
    /* 助手的 export_start 分派只认这一枚（bridge 按 formats 行的 nle 标记给 app）：
       silent = 不弹 nleDialog，结果走助手自己的回执。 */
    nle: opts => exportNle(Object.assign({}, opts)),
    isRendering: () => rendering,
    cancelJob: () => abortRender(),
    /* 助手「把刚导出的成片存进资产库」读这一枚：它只看成片字节缓存（同内容再点直接给的那份），
       与已撤的「最近导出」弹窗无关。 */
    filmBlobOf: name => filmBlobCache.get(String(name || '')) || null,
    buildRenderClips,
    filmFingerprint,
    filmIsCurrent,
  };
}
