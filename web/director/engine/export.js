/* 导演台导出域：成片指纹、导出成片（/render + ffmpeg）、导出素材、FCPXML / 媒体包、
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
    readJsonSafe, renderPost, renderStatus, pollRenderJob, renderCancel, renderBlob,
  } = E;

/* 时间线 → 送给 /render 的 clips。导出与「合并全片」以前各抄了一份逐字相同的循环
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

/* ---------------- ffmpeg 离线导出 ---------------- */
let rendering = false;

let renderCancelled = false;
let renderJobId = null;      // 当前这一轮渲染的任务号（取消时交给代理去杀进程）
/* 按钮统一走这个入口：渲染中再点一次 = 取消（长任务不再只能干等 15 分钟） */
function exportFilmClick() { if (rendering) { renderCancelled = true; renderCancel(renderJobId); return; } exportFilmFFmpeg(); }

/* ============================================================================
   导出素材：把选定成片里的**视频片段**与**音频片段**分别导出
   ---------------------------------------------------------------------------
   「导出成片」给的是一条接好的片子；这个入口给的是**零件**：每一段画面一个文件、
   每一句配音一个文件。用途是把这批素材搬到别的工具里继续用（做字幕、换配音、
   二次剪辑），也方便只重新做其中一段而不用重跑整片。

   走**同一套** `/render`（不新开一条导出通道）：
     · 视频片段 = N 个单段任务，每段一个 mp4。分辨率/帧率沿用成片那一档（`filmSize`），
       所以导出来的片段直接接回去也是同一个规格。
     · 音频片段 = 每句配音一个任务：一条 `voices` 的 clip（没有画面）+ 只放这一句。
       代理那侧这会渲染成一条 mp4（画面是黑的、只有声音）—— 要真正的音频文件，
       走 `spec.audioOnly`：代理只搭 amix → `-vn` 出 m4a（见 proxy.js 的 renderJob）。
   两类都**逐个**跑而不是一次全交：一次全交的话，一个片段失败整批都没了，
   而用户要的就是「单独再导某一段」。
   ========================================================================== */
let assetsExporting = false;
function clickExportAssets() {
  /* 导出素材期间这颗按钮就是「取消」：先判自己在跑，再去判别的导出占着位子。 */
  if (assetsExporting) { renderCancelled = true; renderCancel(renderJobId); return; }
  if (rendering) { setStatus('已有导出任务在进行中…'); return; }
  exportFilmAssets();
}
/* 一句配音 / 一段画面在成片里的位置（第几段、那一镜叫什么）—— 用在导出后的文件名上，
   免得落盘是一堆 `成片-3f2a.mp4`，过两天谁也认不出是哪一段。 */
/* 00m12.3s：文件名里只用「分 + 秒」，不出现冒号（Windows 文件名不能带冒号）。 */
function clipTimeLabel(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const m = Math.floor(t / 60);
  return String(m).padStart(2, '0') + 'm' + (t - m * 60).toFixed(1).padStart(4, '0') + 's';
}
function clipLabelOf(tl, k, cl, row, extra) {
  if (!cl) return '镜头';
  const sh = allShots().find(x => x.id === cl.shotId);
  const segNo = (Number(cl.seg) || 0) + 1;
  const multi = ((tl && tl.clips) || []).filter(x => x.shotId === cl.shotId && x.candId === cl.candId).length > 1;
  const range = row && Number.isFinite(Number(row.f0))
    ? '-' + clipTimeLabel(row.f0) + '-' + clipTimeLabel(Number(row.f0) + Number(row.fd || 0))
    : '';
  return String(k + 1).padStart(2, '0') + '-' + ((sh && sh.name) || '镜头')
    + (multi ? '-第' + segNo + '段' : '') + range + (extra || '');
}
/* 一句配音在成片秒上的区间：start 是这一句在段内源秒上的起点，spd 是画面倍速，
   句自己的 spd 再乘在音频长度上（与 clipVoices / 代理 atempo 同一把尺子）。 */
function voiceFilmRange(cl, row, v) {
  const sp = Math.max(0.25, Math.min(4, Number(cl.speed) || 1));
  const vs = Math.max(0.25, Math.min(4, Number(v.spd) || 1));
  const st = (Number(row && row.f0) || 0) + (Number(v.start) || 0) / sp;
  const du = Math.max(0.05, (Number(v.dur) || 0) / (sp * vs));
  return [st, st + du];
}
async function exportFilmAssets(opts) {
  const o = opts || {};
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    setStatus('<span class="err">现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面</span>');
    return { ok: false, err: '现在一个可用镜头都没有' };
  }
  /* 先把地址备齐（批量换一轮过期外链，别逐段各问一次 —— 见 buildRenderClips 那段说明） */
  await healStaleUrls().catch(() => 0);
  const jobs = [];                       // { name, clips, kind }
  let skipVoice = 0;
  /* 灰场表（成片秒）与 buildRenderClips 同一份取法：一句压在灰场上的配音要劈成几截导出，
     口径与「导出成片」那一趟必须一致（否则导出的素材与成片里听到的不是同一种切法）。 */
  const G = filmFrames(tl);
  const gray = filmLayGray(G);
  for (let k = 0; k < tl.clips.length; k++) {
    const cl = tl.clips[k];
    const dur = tlClipDur(cl);
    /* 与导出成片走**同一个**取源口径（`tlClipSrc`：本机优先、过期外链当场转存）：
       以前这里用预览口径的 `candTrackSrc`，同一条素材在「导出成片」里是本地文件、
       在「导出素材」里却还是外链，链接一过期这一份就导不出来。 */
    const realSrc = await tlClipSrc(cl);
    if (realSrc && dur > 0.05) {
      jobs.push({ kind: 'video', name: clipLabelOf(tl, k, cl, G.rows[k]),
        clips: [{ src: realSrc, in: Math.max(0, Number(cl.in) || 0), out: Math.max(0, Number(cl.out) || 0), speed: cl.speed || 1 }] });
    }
    /* 声音：这一段上的每一句各出一个文件（clipVoices 已经按「放不进这一段的不静默丢」算过）。
       这一条黑场是**这一句自己的文件**，所以 `start` 传 0 —— `v.start` 是「它在原来那一格里第几秒起」，
       跟这个文件没有半点关系；照原样递过去会被代理按 `room = 段长 - start` 再截一刀，
       于是「第 2 秒起、念 3 秒」的那一句导出来只剩 1 秒。
       `speed` 跟着那一段走：素材导出的目的是「拿到的就是成片里的那一份」，
       而上过倍速之后，成片里这一句本来就被同一条 atempo 变过速。 */
    const vv = clipVoices(cl, { start: G.rows[k].f0, gray: gray });
    skipVoice += vv.skip;
    vv.list.forEach((v, i) => {
      const [v0, v1] = voiceFilmRange(cl, G.rows[k], v);
      /* 这一格的源长度 = 这一句的音频时长 ÷ **它自己的倍速**：代理按 `speed × v.spd` 的 atempo
         把它变快之后才得到成片里的那一段；照原样递 `v.dur` 的话，句倍速 < 1 时导出会被截短
         （与 `voiceFilmRange` 那把尺子逐字对齐）。 */
      const vs = Math.max(0.25, Math.min(4, Number(v.spd) || 1));
      jobs.push({ kind: 'audio', name: clipLabelOf(tl, k, cl, G.rows[k], '-配音' + (i + 1))
        + '-' + clipTimeLabel(v0) + '-' + clipTimeLabel(v1),
        clips: [{ src: 'black', in: 0, out: Math.max(0.2, v.dur / vs), speed: cl.speed || 1, voices: [Object.assign({}, v, { start: 0 })] }] });
    });
  }
  if (!jobs.length) {
    setStatus('<span class="err">这一版成片里没有可导出的素材：画面段都取不到可用地址，配音一句都没有</span>');
    return { ok: false, err: '这一版成片里没有可导出的素材' };
  }
  const nV = jobs.filter(j => j.kind === 'video').length;
  const nA = jobs.length - nV;
  const go = o.skipConfirm ? true : await Confirm.ask({
    title: '导出全片素材',
    sub: '画面与配音分开出文件，一段一个、一句一个。',
    body: '要导出的素材：\n· 视频片段 ' + nV + ' 个（每段一个 mp4）\n· 音频片段 ' + nA + ' 个（每句一个音频）'
      + (skipVoice ? '\n（另有 ' + skipVoice + ' 句配音落在剪不到画面的位置上，这次不带）' : '')
      + '\n\n逐个渲染，段数多时可能要等一会儿。',
    okLabel: '开始导出', cancelLabel: '先不导',
  });
  if (!go) return { ok: false, cancelled: true, err: '用户没有确认导出' };
  rendering = true; renderCancelled = false; assetsExporting = true;
  const btn = $('exportAssets');
  const ff = ExportFormats.of('assets');
  if (btn) btn.textContent = ff.cancelLabel;
  const size = filmSize();
  let done = 0, okN = 0, failed = [], cancelled = false;
  try {
    for (const j of jobs) {
      if (renderCancelled) break;
      done++;
      if (btn) btn.textContent = ff.cancelLabel + ' ' + done + '/' + jobs.length;
      setStatus('正在导出第 ' + done + '/' + jobs.length + ' 个：' + j.name + (j.kind === 'audio' ? '（音频）' : '（画面）'));
      try {
        if (o.onProgress) o.onProgress({ done, total: jobs.length, name: j.name, kind: j.kind });
        const r = await renderPost({
          name: (projOf().name || '短片') + '-' + j.name,
          width: size.w, height: size.h, fps: 30, crf: 20,
          audioOnly: j.kind === 'audio',
          clips: j.clips,
        });
        renderJobId = r.id;
        const job = await pollRenderJob(r.id, () => renderCancelled);
        if (!job || job.state !== 'done') throw new Error((job && (job.err || job.error)) || '未完成');
        const ext = j.kind === 'audio' ? 'm4a' : 'mp4';
        const blob = await renderBlob(job.out, '导出素材 ' + j.name);
        const saved = await saveBlob(window.fileSafe(j.name, 120) + '.' + ext, blob);
        okN++;
        /* 一段一存，别攒到最后一次性写 —— 中途失败时已经落盘的那几个还在，
           而攒着的话失败就全丢了（用户会以为「一个都没导出来」）。 */
        setStatus('<span class="ok">✓ ' + saved.msg + '（' + done + '/' + jobs.length + '）</span>');
      } catch (e) {
        if (String(e && e.message) === '已取消') break;
        failed.push(j.name + '：' + errText(e));
      }
    }
  } finally {
    /* 先把「用户取消过」捞出来：finally 清 renderCancelled 之后才判的话，
       下面的取消分支永远不成立，取消会被报成「素材导完了」。 */
    cancelled = renderCancelled;
    rendering = false; renderCancelled = false; renderJobId = null; assetsExporting = false;
    if (btn) { btn.disabled = false; btn.innerHTML = icon(ff.icon, 13) + ' ' + ff.label; }
  }
  if (cancelled) {
    setStatus('已取消：已导出的 ' + okN + ' 个都留在盘上');
    return { ok: false, cancelled: true, okN, nV, nA, failed, jobs: jobs.length };
  }
  setStatus(failed.length
    ? '<span class="err">导出完了，但有 ' + failed.length + ' 个没成功：' + esc(failed.slice(0, 3).join('；'))
      + (failed.length > 3 ? ' …' : '') + '。成功的 ' + okN + ' 个已存好。</span>'
    : '<span class="ok">✓ 素材导完了：' + okN + ' 个文件已存到本机（画面 ' + nV + ' · 配音 ' + nA + '）</span>');
  return { ok: true, okN, nV, nA, failed, jobs: jobs.length };
}
/* 导出素材的文件名只洗一次字符：`web/ui/ui.js` 的 `fileSafe`（§J ⑲ 守着）。
   片段名来自镜头名，用户什么都可能打 —— 这一页以前自己写了第二份非法字符正则与截断长度，
   与资产库 / 生成工作台那两处的口径各不相同（同一部片子的素材从不同页导出，名字规则就不一样）。 */
async function exportFilmFFmpeg(opts) {
  const o = opts || {};
  if (rendering) { setStatus('已有导出任务在进行中…'); return { ok: false, busy: true, err: '已有导出任务在进行中' }; }
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
  /* 已经有一份**当前**的成片（导出过、内容没变）：直接存它，不再跑一遍 ffmpeg。
     以前「导出成片」无条件重渲染 —— 刚导出过一次、中间什么都没改，点第二次又等一遍同样的几十秒，
     而盘上那一份就是他要的东西。（下载成片按钮已删，这条路就是它的归宿。） */
  if (projOf().merged && filmIsCurrent(projOf().merged)) {
    const out = projOf().merged.name;
    const got = await downloadMergedFilm();
    /* 快捷路径也要照实报结果：盘上那一份取不到时 `downloadMergedFilm` 会作废 `proj.merged`
       并给出一句「再点一次会重新合成」；这里再回 ok:true 等于把失败说成导出成功。 */
    if (!got || !got.ok) return { ok: false, shortcut: true, out, err: (got && got.err) || '下载成片失败' };
    return { ok: true, shortcut: true, out, clips: tl.clips.length };
  }
  const size = filmSize();
  const btn = $('exportFilm');   // 主栏那个「导出成片（ffmpeg）」
  const ff = ExportFormats.of('film');
  rendering = true; renderCancelled = false;
  if (btn) { btn.disabled = false; btn.textContent = ff.cancelLabel; }
  try {
    setStatus('正在准备素材地址…');
    const clips = await buildRenderClips(tl);
    /* 字幕烧录跟着这一条导出一起做：每条栅格化成与成片同宽高的 PNG，再交给 /render 叠上去。
       栅格化失败就**当场停**（不导出一份没有字幕的成片假装成功）；没有字幕时一个字段都不发。 */
    let subs = null;
    try {
      subs = await subtitleBurnItems(size);
    } catch (e) {
      throw new Error('字幕烧录准备失败：' + errText(e));
    }
    const r = await renderPost({
      name: stampName('mp4').replace(/\.mp4$/, ''), width: size.w, height: size.h, fps: 30, crf: 20, clips,
      ...(subs && subs.items.length ? { subtitles: subs.items } : {}),
    });
    renderJobId = r.id;
    if (o.onStarted) { try { o.onStarted({ renderId: r.id, clips: tl.clips.length, subtitles: subs ? subs.items.length : 0 }); } catch (e) { /* 回调是调用方给的，它抛错不该把已经提交的渲染带崩 */ } }
    const job = await pollRenderJob(r.id, () => renderCancelled,
      j => {
        if (btn) btn.textContent = ff.cancelLabel + ' ' + (j.progress || 0) + '%';
        if (o.onProgress) { try { o.onProgress(j); } catch (e) { /* 同上：进度回调抛错不影响任务本身 */ } }
      });   // 进度显示在按钮上（顶部横幅不再播报进度）
    if (!job || job.state !== 'done') throw new Error((job && (job.err || job.error)) || '渲染未完成');
    const blob = await renderBlob(job.out, '下载成片');
    const saved = await saveBlob(job.out, blob);
    /* 导出也是一份成片：记进 proj.merged（带内容指纹，判据就是 filmIsCurrent 那一句）。
       以前不记，于是导出之后再点导出会把刚导出那一份**再合成一遍** ——
       用户刚导出的东西没被认下来，白等一次几十秒的合成。
       指纹的字段名就叫 `fp`：`filmIsCurrent` 认不出别的名字，
       少了它会被当成「没有指纹的老成片」而退回只比段数（换候选、改入出点就判不出来了）。 */
    projOf().merged = { name: job.out, duration: round1(tlDuration()), ts: Date.now(),
      clips: tl.clips.length, fp: filmFingerprint(tl.clips), size: job.size || blob.size || 0 };
    scheduleSave();
    const subN = subs ? subs.items.length : 0;
    setStatus('<span class="ok">' + saved.msg + `（${tl.clips.length} 段 · ${fmtDur(tlDuration())} · ${window.fmtBytes(blob.size)}`
      + (subN ? ' · 烧录字幕 ' + subN + ' 条' : ' · 没有字幕') + '）</span>'
      + (subs && subs.missing.length ? '<span class="warn"> · 有 ' + subs.missing.length + ' 个镜头的字幕没进成片（没有选用候选）</span>' : ''));
    return { ok: true, out: job.out, bytes: blob.size, clips: tl.clips.length,
      duration: round1(tlDuration()), subtitles: subN, missingSubtitles: subs ? subs.missing.length : 0 };
  } catch (e) {
    setStatus(e.message === '已取消'
      ? '已取消：本地停止等待，这一轮渲染也已通知代理中止'
      : '<span class="err">导出失败：' + e.message + '</span>');
    return { ok: false, err: e.message, cancelled: e.message === '已取消' };
  } finally {
    rendering = false; renderCancelled = false; renderJobId = null;
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
  return runFcpExport(fcpCtx(), opts || {});
}

/* 送到剪映 / 达芬奇：确认目标 → 生成持久工程 → 尽力启动软件 → 弹窗给目录与导入路径。
   「一键」到启动软件为止；最后那一步导入只能由用户在软件里点
   （两家都没有可靠的命令行「打开并导入这个文件」协议，不假装能替他点）。 */
async function exportNle(opts) {
  opts = opts || {};
  let app = opts.app === 'jianying' || opts.app === 'resolve' ? opts.app : '';
  if (!app) {
    app = await Confirm.choose({
      title: '送到剪映 / 达芬奇',
      sub: '生成一份持久工程（project.fcpxml + media/ + subtitles.srt），并尽量启动软件；最后在软件里点一次导入。',
      options: [
        { value: 'jianying', label: '剪映专业版', hint: '工程目录会打开在资源管理器里；若菜单里没有 FCPXML 导入，到 全局设置 打开这一项' },
        { value: 'resolve', label: 'DaVinci Resolve', hint: '启动后到 文件 → 导入 → 时间线（FCPXML）选目录里的 project.fcpxml' },
      ],
      cancelLabel: '取消',
    });
  }
  if (!app) return { ok: false, cancelled: true };
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
   （播放器那一排的 `#pbBtn` → `TlPlay.play()`），它按时间线直接播，**绝不为播放跑 ffmpeg**。
   合成只发生在「导出成片」那一下（exportFilmFFmpeg 自己 renderPost，把结果记进 projOf().merged）。
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
   那会把「内容没变」误判成旧片而白跑一遍 ffmpeg。这里只认真正印在画面上的东西：
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
   存进本机资产后交给 /render 的 subtitles[]；服务端用 overlay + enable='between(t,a,b)' 叠上去。 */
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
    const saved = await Api.saveLocalAsset({
      name: 'subtitle-' + (i + 1) + '.png', mime: 'image/png', format: 'png', data: b64,
      meta: { provider: '字幕', prompt: String(e.text || '').slice(0, 80) },
    });
    const src = saved.url || Api.assetSrc(saved.assetId || saved.id);
    items.push({ src, start: round2(e.filmStart), end: round2(e.filmEnd) });
    if (i % 5 === 4) setStatus('<span class="meta">正在栅格化字幕 ' + (i + 1) + '/' + got.entries.length + '…</span>');
  }
  return { items, count: items.length, missing: got.missing };
}

/* 成片已经在盘上且是最新的：直接下载，不再跑一遍 ffmpeg（「导出成片」的快捷路径）。 */
async function downloadMergedFilm() {
  const m = projOf().merged;          // 调用那条路的 exportFilmFFmpeg 先判过 filmIsCurrent
  /* 盘上那一份取不到（手动删过 `.renders`、渲染目录换过地方、上一次没写完）或是空的：把记着的成片作废，
     下一次点「导出成片」才会真跑一遍 ffmpeg 重新合成。
     以前这里只回一句「请重新合并」—— 那颗按钮早删了，等于指着一颗不存在的按钮；
     而且再点「导出成片」，`filmIsCurrent` 照旧说「这一份是当前的」，又走回同一条快捷路径、
     拿到同一个 404 —— 死循环，界面一条出路都不给。 */
  const lost = t => {
    projOf().merged = null;
    renderAll(); scheduleSave();
    setStatus('<span class="err">' + t + '；已记下「盘上那一份没了」，素材都还在 —— 再点一次右上角「导出成片」会重新合成一份</span>');
  };
  try {
    const blob = await renderBlob(m.name, '下载成片');
    if (!blob.size) { lost('下载成片：文件是空的'); return { ok: false, err: '盘上那一份成片是空文件' }; }
    const saved = await saveBlob(m.name, blob);
    setStatus('<span class="ok">' + saved.msg + '（' + window.fmtBytes(blob.size) + '）</span>');
    return { ok: true, out: m.name, bytes: blob.size };
  } catch (e) {
    if (e && e.gone) { lost(e.message); return { ok: false, err: e.message }; }
    setStatus('<span class="err">下载失败：' + e.message + '</span>');
    return { ok: false, err: e.message };
  }
}

function stampName(ext) {
  /* 时间戳与非法字符各归公共一份（`web/ui/ui.js` 的 `fileStamp` / `fileSafe`，§J ⑲ 守着）；
     这一页只管形状：「项目名-成片-年月日-时分秒.扩展名」。
     项目名以前不截断，而 Windows 的整条路径有上限 —— 现在跟着 fileSafe 收到 60 个字。 */
  return window.fileSafe((projOf() && projOf().name) || '成片', 60) + '-成片-' + window.fileStamp() + '.' + ext;
}

/* 一句配音在指纹里的样子：落在哪一秒、念多长、从音频第几秒取、**多大声**、**多快**。
   以前少了最后那一位 —— 于是「拖底边那条调音量」（或剪辑条上的音量 ±）改完，
   `filmFingerprint` 一个字不变 → `filmIsCurrent` 说盘上那份还是新的 → 连「导出成片」都走
   快捷路径直接把旧的那份递出去（downloadMergedFilm），
   界面上没有任何一句「成片是旧的」，用户听到的还是上一版的音量
   （用户点名的「音轨现在好像不能正确调整音量」：数据存对了、`/render` 也照那份混音，只是没人去重合成）。
   `off` 那一位以前同样没有，只是它总与 `at` 一起变（拖左把手两头同时走），所以没露过馅 —— 
   留着：任何一个数改了而指纹不变，都是同一类错。
   每一句一行、写成表达式而不是拼串：变异对照的锚点只能取单行（这份源码是 CRLF）。 */
const voiceFpOne = v => [Math.round(v.start * 10) / 10, v.dur, Math.round((v.off || 0) * 10) / 10, Math.round(Number(v.vol == null ? 1 : v.vol) * 100) / 100, Math.round(Number(v.spd || 1) * 100) / 100].join('~');
const voiceFp = (c, ctx) => clipVoices(c, ctx).list.map(voiceFpOne).join(',');
  return {
    filmClick: exportFilmClick,
    assetsClick: clickExportAssets,
    filmFFmpeg: exportFilmFFmpeg,
    assets: exportFilmAssets,
    fcp: exportFCPXML,
    nle: exportNle,
    isRendering: () => rendering,
    currentJobId: () => renderJobId,
    cancelJob: id => { renderCancelled = true; renderCancel(id); },
    buildRenderClips,
    clipTimeLabel,
    voiceFilmRange,
    filmFingerprint,
    filmIsCurrent,
  };
}
