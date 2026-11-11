/* 导演台导出域：成片计划（`proj.film` → 浏览器内导出那一份契约）、成片指纹、导出成片、
   FCPXML 三档（单文件 / 媒体包 zip / 持久工程目录）。engine.js 只留状态与接线
   （内部保持命令式、按域拆模块）。
   引擎状态一律经 createExport(E) 递进来的访问器读写；这里不放第二份工程数据。 */
import { exportFCPXML as runFcpExport, exportProject as runExportProject } from '../fcpxml.js';
import {
  deriveTimeline, transitionWindow, audibleVoices, visibleCaptions, captionPosition, captionHighlighted,
  clipDurationOf, rateOf, gainOf, TL_FPS, voiceLaneMap, captionLaneMap,
} from '../film.js';
import { round2 } from '../util.js';

export function createExport(E) {
  const {
    $, setStatus, projOf, allShots, filmOf, clipNameOf, fmtDur, filmSize, saveBlob, scheduleSave,
    healStaleUrls, BoardAssetsOf,
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

/* 成片的会话内字节缓存（文件名 → Blob）：刚导出过的那一份，同内容再点直接给，不再合成一遍。
   只留最近那一份 —— 一整片是几十到几百 MB 的 Blob，逐份攒着会把标签页吃到内存墙，
   而「同内容再点」要的从来只有刚合成那一份。
   只活在当前会话（刷新后没有）—— 浏览器里没有第二个持久去处，
   刷新后第一次导出会重新合成，这比在用户盘上悄悄多存一份要干净。 */
const filmBlobCache = new Map();

/* ---------------- 素材地址（本机优先，口径只在 media.js 那一份里） ---------------- */
/* clip.src 是提升那一刻从候选身上**抄下来的副本**，而平台那条签名外链会过期：
   `healStaleUrls` 换的是候选身上的 url，所以取址先问候选要新鲜那一份，抄的副本只当兜底。 */
function shotMap() {
  return new Map((allShots() || []).map(sh => [sh.id, sh]));
}
function candidateOfClip(clip, byId) {
  const sh = clip && clip.shotId ? byId.get(clip.shotId) : null;
  if (!sh) return null;
  return (sh.candidates || []).find(c => c && c.vid === clip.candId) || null;
}
/* 一条地址 → 导出用那一份（本机有副本就是本机，没有才是外链）。 */
function outSrcOf(raw) {
  const s = String(raw || '');
  if (!s) return '';
  return window.EditorMedia ? window.EditorMedia.exportSrc({ src: s }) : s;
}

/* ============================================================================
   成片计划：`proj.film` → 浏览器内导出（web/media-export.js）那一份契约
   ---------------------------------------------------------------------------
   组表人只有这一处。三件事必须与实时预览（engine/play.js）是同一本账 ——
   屏幕上看到与听到的那一条片子，导出必须合成出同一条：
     · 段与段之间那一窗转场 → `transitionWindow`（预览每帧问的就是同一枚函数，夹算只在那一处）；
     · 哪几句配音、哪几条字幕进片 → `audibleVoices` / `visibleCaptions`
       （眼睛关掉的那一行既不出声也不露字，被闸掉的按项计数，回执要点名）；
     · 起点与行长 → `deriveTimeline`（顺序派生，这一层不再自己累加一遍起点）。
   **画面轨的眼睛不管导出**：编辑视图里压暗某一格不等于那一格不在片子里（预览也照常播它）。
   一行素材**地址取不到**不当场抛错：这条计划同时是 FCPXML 那一份表，媒体包要能带着「这一段没字节」
   继续导出并在文件头上点名 —— 「合成成片」那一步才真的拒（见 exportFilm 里的 missingNote）。
   开头把过期外链**一次批量**换新（healStaleUrls → Api.healMedia 按平台分组，
   声明了 pollVia:'list' 的那一族一次列表请求解出整批）：逐段各问一次的话，
   三十段就是三十次「100 条的列表」，而它们问的是同一家平台的同一份数据。 */
async function buildRenderPlan() {
  const film = filmOf();
  const tl = deriveTimeline(film.clips);
  await healStaleUrls().catch(() => 0);      // 换不到新地址不是错：下面照旧拿旧地址试一次
  const byId = shotMap();
  const missing = [];
  const items = tl.rows.map((row, i) => {
    const clip = row.clip;
    const shot = clip.shotId ? (byId.get(clip.shotId) || null) : null;
    const cand = candidateOfClip(clip, byId);
    const raw = (cand && cand.url) || clip.src || (clip.assetId ? '/asset/' + clip.assetId : '');
    const src = outSrcOf(raw);
    if (!src) missing.push({ index: i, name: clipNameOf(clip), clip, shot, start: round2(row.start), duration: round2(clipDurationOf(clip)) });
    return {
      index: i, clip, shot, cand, src,
      start: round2(row.start), end: round2(row.end), duration: round2(clipDurationOf(clip)),
      payload: {
        kind: clip.kind, src, name: clip.name || clipNameOf(clip),
        start: round2(row.start), duration: round2(clipDurationOf(clip)),
        sourceStart: round2(clip.sourceStart),
        sourceDuration: round2(clip.kind === 'image' ? 0 : clip.sourceDuration),
        playbackRate: rateOf(clip), volume: gainOf(clip),
      },
    };
  });
  /* 转场窗口：每一段与**它的下一段**之间至多一窗（`transition` 挂在前一段身上）。
     `to` 是下一段在表里的下标 —— 合成那一侧按它去取「正在淡进来的那一段」的画面。 */
  const transitions = [];
  tl.rows.forEach((row, i) => {
    const w = transitionWindow(row, tl.rows[i + 1] || null);
    if (w) transitions.push({ id: w.id, start: round2(w.start), end: round2(w.end), duration: round2(w.duration), to: i + 1 });
  });
  const vv = audibleVoices(film);
  const vLane = voiceLaneMap(film);
  /* `lane` = 打包后的行号（预览与轨道画的是同一张表）：FCPXML 把配音写成 spine 上的独立
     asset-clip，lane 由它定 —— 在这里再 pack 一遍就会与轨道上那一行错开。
     `shotId` 只给导出侧取名字用（配音文件名与本机素材同一个场景镜头口径）。 */
  const voices = vv.list.map(v => ({
    src: outSrcOf(v.src), name: v.text || '配音',
    start: round2(v.start), duration: round2(v.duration),
    sourceStart: round2(v.sourceStart), sourceDuration: round2(v.sourceDuration),
    playbackRate: rateOf(v), volume: gainOf(v), fadeIn: round2(v.fadeIn), fadeOut: round2(v.fadeOut),
    lane: vLane.get(v.id) || 0, shotId: v.shotId || '',
  }));
  const cc = visibleCaptions(film);
  const cLane = captionLaneMap(film);
  const captions = cc.list.map(c => ({
    text: String(c.text || ''), start: round2(c.start), end: round2(c.end),
    position: captionPosition(c), highlight: captionHighlighted(c),
    lane: cLane.get(c.id) || 0,
  }));
  return {
    clips: items.map(x => x.payload), rows: items, transitions, voices, captions,
    duration: round2(tl.total),
    missing,
    skipped: { voices: vv.skipped, captions: cc.skipped },
  };
}

/* ---------------- 浏览器内离线导出 ---------------- */
let rendering = false;
/* 取消闸：渲染循环每帧都看 signal.aborted（见 media-export.js 的 throwIfAbort）。
   服务端没有渲染任务可杀 —— 停就是这个 abort。按钮统一走 exportFilmClick：渲染中再点一次 = 取消。 */
let renderAbortCtl = null;
function abortRender() {
  if (renderAbortCtl) { try { renderAbortCtl.abort(); } catch (e) { /* 收尾清理，失败也要往下走 */ } }
}
function exportFilmClick() { if (rendering) { abortRender(); return; } exportFilm(); }

async function exportFilm(opts) {
  const o = opts || {};
  if (rendering) { setStatus('已有导出任务在进行中…'); return { ok: false, busy: true, err: '已有导出任务在进行中' }; }
  const pendNote = warnPendingAssets();
  const film = filmOf();
  if (!film.clips.length) {
    setStatus('<span class="err">现在成片里一段画面都没有：先回生成态在候选卡上点「选用」，或者先生成画面</span>');
    return { ok: false, err: '成片里一段画面都没有' };
  }
  /* 没有选用候选的镜头**不进成片**：不在这里数一遍说出来，
     用户看到的回执就是「6 段 · 24.5 秒」，要到看片那一刻才发现少了 4 镜。 */
  const notInFilm = (allShots() || []).filter(sh => !film.clips.some(c => c && c.shotId === sh.id));
  const notInFilmNote = notInFilm.length
    ? '有 ' + notInFilm.length + ' 个镜头没进成片（没有选用候选）：' + notInFilm.slice(0, 6).map(sh => sh.name || '未命名').join('、')
      + (notInFilm.length > 6 ? ' 等' : '')
    : '';
  /* 已经有一份**当前**的成片（导出过、内容没变、字节还在本次会话里）：直接给它，不再合成一遍。
     会话缓存没有（刷新过 / 换了工程）就落进下面的正常导出 —— 重新合成一份，不报「盘上那份没了」。 */
  const prev = projOf() ? projOf().merged : null;
  const cached = prev && filmIsCurrent(prev) ? filmBlobCache.get(prev.name) : null;
  if (cached) {
    const saved = saveBlob(prev.name, cached);
    setStatus('<span class="ok">' + saved.msg + '（' + window.fmtBytes(cached.size) + ' · 这一轮刚合成的那份）</span>');
    return { ok: true, out: prev.name, clips: film.clips.length };
  }
  const size = filmSize();
  const btn = $('exportFilm');   // 页头那颗「导出成片」
  const ff = ExportFormats.of('film');
  rendering = true;
  if (btn) { btn.disabled = false; btn.textContent = ff.cancelLabel; }
  const abortCtl = new AbortController();
  renderAbortCtl = abortCtl;
  try {
    setStatus('正在准备素材地址…');
    const ME = await ensureMediaExport();
    const plan = await buildRenderPlan();
    /* 合成成片这一段字节都不能少：地址取不到的那一段点名报出来，不拿黑场蒙过去。
       （媒体包 / FCPXML 那边同一份计划继续走 —— 那里写得出 `<gap>`，导入后照实显示离线。） */
    if (plan.missing.length) {
      const who = plan.missing.slice(0, 6).map(m => '第 ' + (m.index + 1) + ' 段「' + m.name + '」').join('、')
        + (plan.missing.length > 6 ? ' 等 ' + plan.missing.length + ' 段' : '');
      setStatus('<span class="err">导出停下：' + who + ' 没有可用素材（本地文件可能已被清理）——'
        + '补回素材或换一条候选再导；导出媒体包不受影响</span>');
      return { ok: false, err: who + ' 没有可用素材', missing: plan.missing.length };
    }
    if (o.onStarted) { try { o.onStarted({ clips: plan.clips.length, subtitles: plan.captions.length }); } catch (e) { /* 回调是调用方给的，它抛错不该把已经提交的导出带崩 */ } }
    const r = await ME.exportFilm({
      clips: plan.clips, transitions: plan.transitions, voices: plan.voices, captions: plan.captions,
      stickers: (filmOf().stickers || []),
      width: size.w, height: size.h, fps: TL_FPS, duration: plan.duration,
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
    const saved = saveBlob(outName, blob);
    /* 同内容再点直接给 —— 只给最近这一份，上一份的字节当场放掉。 */
    filmBlobCache.clear();
    filmBlobCache.set(outName, blob);
    /* 导出也是一份成片：记进 proj.merged（带内容指纹，判据就是 filmIsCurrent 那一句）。 */
    projOf().merged = { name: outName, duration: round2(plan.duration), ts: Date.now(),
      clips: plan.clips.length, fp: filmFingerprint(), size: blob.size || 0 };
    scheduleSave();
    const skipV = plan.skipped.voices;
    const skipC = plan.skipped.captions;
    const diagModes = (r.diag && r.diag.decodeModes) || [];
    setStatus('<span class="ok">' + saved.msg + `（${plan.clips.length} 段 · ${fmtDur(plan.duration)} · ${window.fmtBytes(blob.size)}`
      + (plan.captions.length ? ' · 烧录字幕 ' + plan.captions.length + ' 条' : ' · 没有字幕')
      + (plan.voices.length ? ' · 配音 ' + plan.voices.length + ' 句' : '')
      + (r.diag && r.diag.transitions ? ' · 转场 ' + r.diag.transitions + ' 处' : '') + '）</span>'
      + (notInFilmNote ? '<span class="warn"> · ⚠ ' + notInFilmNote + '</span>' : '')
      + (diagModes.length
        ? '<span class="meta"> · 取帧：' + diagModes.map(m => ({ 'sequential-webcodecs': '顺序解', 'precise-seek': '逐格定位', 'static-image': '静态图' }[m] || m)).join(' / ') + '</span>' : '')
      + (skipV.hidden || skipC.hidden
        ? '<span class="warn"> · 眼睛关掉了 ' + (skipV.hidden ? skipV.hidden + ' 句配音' : '') + (skipV.hidden && skipC.hidden ? ' · ' : '') + (skipC.hidden ? skipC.hidden + ' 条字幕' : '') + '，它们没进成片</span>' : '')
      + (skipV.noSrc ? '<span class="warn"> · 有 ' + skipV.noSrc + ' 句配音还没有音频（没合成或字节没了），没进成片</span>' : '')
      + (skipC.empty ? '<span class="meta"> · 有 ' + skipC.empty + ' 条字幕没有字或没有时长，没印出来</span>' : '')
      + (pendNote ? '<span class="warn"> · ⚠ ' + pendNote + '</span>' : ''));
    return { ok: true, out: outName, bytes: blob.size, clips: plan.clips.length, duration: round2(plan.duration),
      subtitles: plan.captions.length, voices: plan.voices.length, transitions: plan.transitions.length,
      hiddenVoices: skipV.hidden, hiddenCaptions: skipC.hidden, noSrcVoices: skipV.noSrc,
      notInFilm: notInFilm.length, pendingNote: pendNote };
  } catch (e) {
    setStatus(e.message === '已取消'
      ? '已取消：这一轮合成已停下，没写任何文件'
      : '<span class="err">导出失败：' + e.message + '</span>');
    return { ok: false, err: e.message, cancelled: e.message === '已取消' };
  } finally {
    rendering = false; renderAbortCtl = null;
    if (btn) { btn.disabled = false; btn.innerHTML = icon(ff.icon, 13) + ' ' + ff.label; }
  }
}

/* ============================================================================
   FCPXML 导出（Final Cut Pro 及支持 FCPXML 的剪辑软件可导入的交换格式）
   ----------------------------------------------------------------------------
   导的是**当前成片**：段顺序、源窗口、倍速、转场、配音位置、字幕位置都保留。
   素材引用优先用本机资产库里的真实文件（`/sys-status` 的资产目录 + la_ 号 + 格式）；
   本机没有落盘的那几条仍然建一个离线 asset（名字 + 原地址写进文件开头的注释），
   FCP 导入后会显示离线，用户按名单补文件 / 重新链接即可 —— 不静默丢段。
   **不改变任何工程数据**：只读 buildRenderPlan()（与导出成片同一张表）与镜头表。 */
/* 错误文案只有公共件那一份（web/ui/net.js 的 window.errText）；ESM 模块在 Node 里被直接
   import 时没有那一层，退回 message —— 不让「报错文案自己又抛一次」盖住真错误。 */
const exportErrText = e => {
  const W = typeof window === 'undefined' ? null : window;
  const f = W && typeof W.errText === 'function' ? W.errText : null;
  return f ? String(f(e)) : String(e instanceof Error ? e.message : (e || ''));
};
/* FCPXML 的上下文：单文件 / 媒体包 / 工程目录三条出口传的是同一份。 */
function fcpCtx() {
  return {
    proj: projOf(), filmOf, allShots, clipNameOf, buildRenderPlan, outSrcOf,
    healStaleUrls, filmSize, setStatus, el: id => $(id),
    AssetLocal: window.AssetLocal, Api: window.Api, Net: window.Net,
  };
}
async function exportFCPXML(opts) {
  warnPendingAssets();
  return runFcpExport(fcpCtx(), opts || {});
}

/* 持久工程目录：FCPXML 三档里唯一往本机资产库落盘的一档（FCPXML工程/，与素材同根）。
   与「导出媒体包」共用 buildFCPXML 与服务端 writeBundle，只是不下载 zip、也不写 bundle.zip，
   而是把 project.fcpxml + media/ + subtitles.srt + missing.txt 摊开留成一个目录并回路径。
   不启动任何剪辑软件：导入那一步由用户在自己的软件里做，界面只把路径与缺失数说清。 */
async function exportProject(opts) {
  opts = opts || {};
  warnPendingAssets();
  let r;
  try { r = await runExportProject(fcpCtx()); }
  catch (e) {
    const msg = exportErrText(e);
    setStatus('<span class="err">导出工程目录失败：' + esc(msg) + '</span>');
    return { ok: false, err: msg };
  }
  if (r && r.ok && !opts.silent) projectDialog(r);
  return r;
}
/* 工程已经写好了才有这一步：目录、素材数、缺失数与导入路径一次说清；
   「打开文件夹」与「复制路径」都是可用的退路（软件没装 / 装在别处也不影响导入）。 */
function projectDialog(r) {
  UiDialog.open({
    title: '已导出 FCPXML 工程目录',
    sub: '工程与素材都留在本机资产库；不启动任何剪辑软件',
    body(el) {
      el.innerHTML = '<div class="dlg-line">工程目录：<b>' + esc(r.dir) + '</b></div>'
        + '<div class="dlg-line">时间线：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音'
        + (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
        + (r.transitions ? ' · 转场 ' + r.transitions + ' 处' : '') + '</div>'
        + '<div class="dlg-line">素材：' + r.assets + ' 份进包'
        + (r.missingCount ? ' · ' + r.missingCount + ' 份没取到' : ' · 没有缺失') + '</div>'
        + (r.missingCount ? '<div class="dlg-warn">取不到的素材名单在同目录的 missing.txt；导入后会显示离线，补齐文件再重新链接</div>' : '')
        + '<div class="dlg-hint">在 Final Cut Pro 或支持 FCPXML 的剪辑软件里用「文件 → 导入 → XML / 时间线」打开目录里的 project.fcpxml；素材会自动从 media/ 链接，字幕另存为 subtitles.srt。</div>'
        + '<div class="dlg-hint">要发给别人或换机器，请用「导出媒体包」拿 zip。</div>';
    },
    actions: [
      { label: '打开文件夹', value: 'open', primary: true,
        onClick: () => { revealProject(r.id); return false; } },
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
async function revealProject(id) {
  try {
    await window.Net.json('/fcpxml/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
  } catch (e) { Toast.warn('打不开文件夹：' + exportErrText(e)); }
}

/* ============================================================================
   成片新旧：`projOf().merged = { name, duration, ts, clips, size, fp }`
   ---------------------------------------------------------------------------
   合成只发生在「导出成片」那一下；看整片走剪辑态那条轨的实时预览，**绝不为播放合成**。
   `filmIsCurrent()` 是导出这一条路自己用的快捷闸：这一轮刚合成的那份还能不能直接给。 */
/* 这一份成片对应**哪一串内容**：逐段一项（顺序就体现在下标里），加上进片的配音与字幕与画幅。
   只认真正印在画面与声音上的东西 —— 标记、撤销、光标位置、段在第几行都不进来：
   它们改了而指纹变了，只会让下一次导出白跑一遍合成；反过来（改了不入片的东西却判成旧片）
   与（改了入片的东西却判成新片）都是假话。
   切口必须逐段一项，不能塌成「这一镜的首末源秒」：切开**不改**首段的入点、也不改末段的出点，
   只是中间多了一个接缝，塌成那一对数的话「切成两段」会被读成没变。 */
function filmFingerprint() {
  const film = filmOf();
  const tl = deriveTimeline(film.clips);
  const size = filmSize();
  const clipPart = tl.rows.map((row, i) => {
    const c = row.clip;
    const tr = c.transition && c.transition.id && c.transition.id !== 'none'
      ? c.transition.id + ':' + round2(c.transition.duration) : '';
    return [i, c.kind, c.shotId || '', c.candId || '', c.assetId || '', c.src || '',
      round2(row.start), round2(clipDurationOf(c)), round2(c.sourceStart), round2(c.sourceDuration),
      rateOf(c), round2(gainOf(c)), tr].join('~');
  }).join('|');
  const voicePart = audibleVoices(film).list.map(v => [round2(v.start), round2(v.duration),
    round2(v.sourceStart), round2(v.sourceDuration), rateOf(v), round2(gainOf(v)),
    round2(v.fadeIn), round2(v.fadeOut), v.src || '', String(v.text || '')].join('~')).join('|');
  const capPart = visibleCaptions(film).list.map(c => [round2(c.start), round2(c.end),
    captionPosition(c), captionHighlighted(c) ? 'hl' : '', String(c.text || '')].join('~')).join('|');
  return ['film2', size.w + 'x' + size.h, clipPart, 'v:' + voicePart, 'c:' + capPart].join('||');
}
/* 「这一份成片是不是当前的」—— 「导出能不能走快捷路径」只问这一句。 */
function filmIsCurrent(m) {
  return !!(m && m.fp && m.fp === filmFingerprint());
}

function stampName(ext) {
  /* 时间戳与非法字符各归公共一份（`web/ui/ui.js` 的 `fileStamp` / `fileSafe`）；
     这一页只管形状：「项目名-成片-年月日-时分秒.扩展名」。
     项目名跟着 fileSafe 收到 60 个字：Windows 的整条路径有上限。 */
  return window.fileSafe((projOf() && projOf().name) || '成片', 60) + '-成片-' + window.fileStamp() + '.' + ext;
}

  return {
    filmClick: exportFilmClick,
    exportFilm: exportFilm,
    fcp: exportFCPXML,
    /* 页面按钮与助手 export_start 都走这一枚：silent = 不弹 projectDialog，
       结果走助手自己的回执。 */
    project: opts => exportProject(Object.assign({}, opts)),
    isRendering: () => rendering,
    cancelJob: () => abortRender(),
    /* 助手「把刚导出的成片存进资产库」读这一枚：它只看成片字节缓存（同内容再点直接给的那份），
       与已撤的「最近导出」弹窗无关。 */
    filmBlobOf: name => filmBlobCache.get(String(name || '')) || null,
  };
}
