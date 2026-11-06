/* FCPXML 导出：把**当前成片**写成 Final Cut Pro 及支持 FCPXML 的剪辑软件可导入的交换格式。
   只读：不修改任何工程数据，不启动任何剪辑软件。
   三条出口共用同一份拼装（buildFCPXML）：
     ① 单文件 .fcpxml   —— 素材写本机真实 file:// 路径，不带字节
     ② 媒体包 zip       —— project.fcpxml + media/ + subtitles.srt + missing.txt
     ③ 持久工程目录     —— 同一份内容摊开留在本机资产库下的 FCPXML工程/<id>/ 并回目录路径
   ----------------------------------------------------------------------------
   组表人不是这里：这一份读的是 engine/export.js 的 `buildRenderPlan()` —— 与浏览器内导出成片
   **同一张表**（段顺序与起点、进片的配音与字幕、每句在哪一行、素材地址本机优先都已经在它那侧算完）。
   这里只把那张表翻译成 FCPXML 的形状；再自己累加一遍起点或再 pack 一遍行，迟早和成片各说各话。
   转场按 Apple FCPXML 1.10 DTD 写成 spine 里的 `<transition>`，字幕的高亮底色、
   字体与字号写进 `text-style`（`backgroundColor` 是 DTD 里给字幕用的属性），一条都不静默丢。
   素材名与「存回本机」同一个来源（naming.js + 本机索引里的 name）：
   本机索引名 = 库根上那个文件的文件名 = 媒体包里的 media/<名> = `<asset name>`；
   同一份素材在多段里复用只进包一次，XML 引用同一个 `media/<名>`。 */
import { escHTML } from './util.js';
import { TL_FPS } from './film.js';
import { srtSerialize } from './srt.js';
import { candidateBase, voiceBase, clipLabel, shotCtxOf, candidateIndex, stripExt, withExt, uniqueName } from './naming.js';

/* FCP 内置标题效果（Basic Title）与它的「位置」参数键：只有导出器用得到，就住在这里。 */
const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';
const SUB_POSITION_KEY = '9999/999166631/999166633/1/100/101';
/* FCP 内置「交叉叠化」转场的 FxPlug 标识（FCPXML 的 <effect> 资源）：自制转场在交换格式里
   没有对应特效，统一映射成这一枚，且在文件头注释里点名，不假装原样导出。 */
const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
/* 字幕样式默认值：与预览叠层 `.sub-ov` / 烧录那一份同一个数（54/1080、白字、黑底 55%、黑投影）。
   要换字体 / 字号 / 颜色，给 buildFCPXML 的 opts.titleStyle，或在工程上写 `proj.fcpTitle`：
   { font, sizePx | sizeRatio, color, backgroundColor, bold:false, shadow:false }。三档出口共用这一份。 */
const TITLE_DEFAULTS = {
  font: 'PingFang SC', sizeRatio: 54 / 1080,
  color: '1 1 1 1', highlight: '0 0 0 0.55',
};
/* 错误文案只走公共件（web/ui/net.js 的 window.errText）；Node 单测里没有那一层时退回 message。
   以前这里写 `typeof errText === 'function' ? errText(e) : String(e)`：在 Node / 早期装载里
   要么整句变成 "Error: xxx"，要么 catch 自己再抛 ReferenceError，把真错误盖掉了。 */
const fcpErrText = (ctx, e) => {
  const W = typeof window === 'undefined' ? null : window;
  const f = (ctx && typeof ctx.errText === 'function' && ctx.errText)
    || (W && typeof W.errText === 'function' && W.errText);
  if (f) return String(f(e));
  return String(e instanceof Error ? e.message : (e || ''));
};
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function titleStyleOf(ctx, opts, h) {
  const over = (opts && opts.titleStyle) || (ctx && ctx.titleStyle)
    || (ctx && ctx.proj && ctx.proj.fcpTitle) || {};
  const px = numOr(over.sizePx, NaN);
  const size = Number.isFinite(px) ? px : numOr(over.sizeRatio, TITLE_DEFAULTS.sizeRatio) * h;
  return {
    font: String(over.font || TITLE_DEFAULTS.font),
    size: Math.max(12, Math.min(300, Math.round(size))),
    color: String(over.color || TITLE_DEFAULTS.color),
    highlight: String(over.backgroundColor || TITLE_DEFAULTS.highlight),
    bold: over.bold === false ? 0 : 1,
    shadow: over.shadow !== false,
  };
}

/* 只拼装、不落盘：单文件 / 媒体包 / 工程目录三条出口都读这一份结果。
   `opts.bundle` 决定媒体引用写相对路径（media/<名>）还是本机真实文件路径。
   返回 ok:false 只表示「现在没有可导出的东西」；其余失败照常抛给调用方。 */
export async function buildFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { proj, buildRenderPlan, clipNameOf, filmSize, setStatus } = ctx;
  const W = typeof window === 'undefined' ? null : window;
  /* 本机别名表 / 系统目录 / 网络层都只认 ctx 递来的那一份（浏览器里 ctx 指向 window 上的公共件，
     Node 单测里是桩）—— 以前条件写 `window.AssetLocal` 却去调 `AssetLocal.ready()`，
     两边不是同一份时要么白等、要么直接抛。 */
  const AL = (ctx && ctx.AssetLocal) || (W && W.AssetLocal) || null;
  const API = (ctx && ctx.Api) || (W && W.Api) || null;
  const Net = (ctx && ctx.Net) || (W && W.Net) || null;
  if (!proj) { setStatus('<span class="err">还没有打开的短片：先建一份工程再导出</span>'); return { ok: false, quiet: true, err: '没有打开的短片' }; }
  /* 本机别名表要等一次代理的取表往返（资产库首屏也是同一份）：
     FCPXML 要把本地素材写成真实文件路径，先等它一下，别把明明有的文件标成缺失。 */
  if (AL && AL.ready) {
    try { await Promise.race([AL.ready(), new Promise(r => setTimeout(r, 1200))]); } catch (e) { /* 等不到就按「本机没有」记，不卡住导出 */ }
  }
  const plan = await buildRenderPlan();
  if (!plan.rows.length) {
    setStatus('<span class="err">成片还没有画面</span>');
    return { ok: false, quiet: true, err: '成片里一段画面都没有' };
  }
  const sys = API && API.sysStatus ? await API.sysStatus().catch(() => null) : null;
  const assetsDir = String((sys && sys.目录 && sys.目录.资产 && sys.目录.资产.路径) || '');
  const size = filmSize();
  const FR = TL_FPS;
  const t = sec => { const n = Math.max(0, Math.round((Number(sec) || 0) * FR)); return n ? n + '/' + FR + 's' : '0s'; };
  const xe = escHTML;      // 转义只有 util.js 那一份（字符表与页面的 window.esc 逐字相同）
  const noteSafe = s => String(s || '').replace(/--/g, '—');
  /* 路径编码只有这一份：encodeURI + `#`/`?` 两处替换（实测 encodeURI 已正确转义 `%` → `%25`）。
     `fileUrl()` 与 `mediaHref()` 共用它 —— 以前两处各写一遍，改一处漏一处。 */
  const encodePath = s => encodeURI(String(s || '')).replace(/#/g, '%23').replace(/\?/g, '%3F');
  const fileUrl = p => {
    const s = String(p || '').replace(/\\/g, '/');
    if (!s) return '';
    if (/^file:/i.test(s)) return s;
    if (/^[A-Za-z]:\//.test(s) || s.startsWith('/')) {
      return 'file:///' + encodePath(s.replace(/^\/+/, ''));
    }
    return s;
  };
  const mediaHref = name => 'media/' + encodePath(name);

  const missing = [];
  const bundleAssets = [];
  const assets = new Map();
  /* 名字按 media.key 只定一次：同一条素材在后面几段里重用时，`<asset name>` 与 `media/` 里的
     文件名必须还是第一次那个；撞名由 naming.uniqueName 插 `-2` 解决，不再交给服务端静默改名
     （服务端改名会让 XML 引用的名字对不上盘上的文件）。 */
  const usedNames = new Set();
  const nameByKey = new Map();
  function mediaNameOf(key, base, ext) {
    if (nameByKey.has(key)) return nameByKey.get(key);
    const nm = uniqueName(base, ext, usedNames) || withExt(base, ext);
    nameByKey.set(key, nm);
    return nm;
  }
  let nextRid = 2;
  /* 一条地址 → 资源（asset）那一份描述：`kind` 只认 video / image / audio，
     名字四级优先（本机索引名 > 图片自带的名字 > 场景镜头名 > 段名），与原地址的取法同源。 */
  function mediaOf(src, kind, info) {
    const it = info || {};
    const isAudio = kind === 'audio';
    const isImage = kind === 'image';
    const sh = it.shot || null;
    const cand = it.cand || null;
    const clip = it.clip || null;
    const sctx = sh ? shotCtxOf(proj, sh) : null;
    const fallback = isAudio
      ? ((String(src || '').match(/\.(wav|mp3|m4a|aac|ogg|flac)(?:\?|$)/i) || [])[1] || 'wav')
      : isImage
        ? (((String(src || '').match(/\.(png|jpe?g|webp|gif|bmp|avif|heic)(?:\?|$)/i) || [])[1] || 'png').toLowerCase())
        : ((String((cand && cand.format) || '').match(/^(mp4|mov|webm|mkv)$/i) || [])[1] || 'mp4');
    const f = AL && AL.localFileOf ? AL.localFileOf(src) : null;
    const la = (f && f.id) || ((/^\/asset\/(la_[A-Za-z0-9_-]+)/.exec(String(src || '')) || [])[1]);
    /* 本机索引里的名字就是「存回本机」写下的文件名，优先于场景镜头名：两边必须是同一个名字。
       旧素材的名字可能带扩展名，stripExt + withExt 保证只留恰好一个。 */
    const idxBase = f && f.name ? stripExt(f.name) : '';
    const sceneBase = sctx
      ? (isAudio ? voiceBase(sctx) : candidateBase(sctx, candidateIndex(sh, cand)))
      : '';
    /* 图片段的名字对它没意义（它不在那条候选的源时间轴上）：拖进来的那张图叫什么就叫什么。 */
    const stillName = isImage && clip && clip.name ? ((W && W.fileSafe ? W.fileSafe(clip.name, 48) : String(clip.name).slice(0, 48)) || '') : '';
    const safeName = W && W.fileSafe ? W.fileSafe : (s => String(s || ''));
    const base = idxBase || stillName || sceneBase
      || (safeName((clip && clip.name) || ((isAudio ? '配音' : '素材') + '-' + ((Number(it.idx) || 0) + 1)), 48) || '素材');
    if (la && assetsDir) {
      const ext = String((f && f.format) || fallback).toLowerCase();
      const key = kind + ':la:' + la;
      const name = mediaNameOf(key, base, ext);
      if (bundle) return { key, name, local: false, bundleSrc: API.assetSrc(la), href: mediaHref(name) };
      /* 单文件那一档给 FCP 的是 file:// 绝对路径：本体的真实落点是
         <库根>\<类型>\<规范名>.<ext>（账里的 file 字段，localFileOf 递过来的 path）。
         path 没学到（老索引还没刷新）就照实记「本机没有」，不编一个必然断链的地址。 */
      const rel = String((f && f.path) || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (rel) return { key, name, local: true, href: fileUrl(assetsDir.replace(/[\\/]+$/, '') + '/' + rel) };
      missing.push({ name, src: String(src || '') });
      return { key, name, local: false, bundleSrc: '', href: mediaHref(name) };
    }
    const key = kind + ':u:' + (src || base);
    const name = mediaNameOf(key, base, fallback);
    const canFetch = /^(?:https?:|\/(?:asset|getv|fetch)\b)/i.test(String(src || ''));
    /* 不在本机索引里的素材：单文件 FCPXML 导入后是离线素材，媒体包里由代理按地址取；
       取不到时服务端会写 missing.txt —— 这里先按「本机没有」记一条，界面照实报数。 */
    missing.push({ name, src: String(src || '') });
    return { key, name, local: false, bundleSrc: bundle && canFetch ? String(src || '') : '', href: mediaHref(name) };
  }
  function assetFor(media, dur, kind) {
    const prev = assets.get(media.key);
    if (prev) { prev.duration = Math.max(prev.duration, dur); return prev.id; }
    const id = 'r' + (nextRid++);
    assets.set(media.key, { id, media, kind, duration: Math.max(0.1, dur) });
    /* 同一份素材多段复用只进包一次：以前 mediaOf 每叫一次就 push 一条，
       zip 里会出现同名但来源不同的重复条目，解压出来是哪一条全看解压程序。 */
    if (bundle && media.bundleSrc) bundleAssets.push({ src: media.bundleSrc, name: media.name });
    return id;
  }

  /* ---------------- 转场：FCPXML 的 <transition> 是 spine 里的一段重叠 ----------------
     Apple FCPXML 1.10 DTD：`<!ELEMENT transition (filter-video?, filter-audio?, …)>`，
     `duration` 必填、`offset` 可选；它是夹在两条相邻 story element 之间的 spine 子元素，
     「overlaps the last N seconds of the previous video and the first N of the next」。
     成片里这一窗是「切点前 d 秒淡入下一段」，**不吃时长**；FCP 要求转场大致以切点为中心
     （偏一侧的导入后会被缩短），所以这里写成 [切点 - h, 切点 + h]，h = d/2：
     两段的 offset / start / duration 一个都不动 → 总时长与配音、字幕的绝对时间保持不变，
     代价只是溶解窗口从「切点前」变成「跨切点各半窗」，文件头注释照实说明。
     FCPXML 里没有我们自制的 wipe / zoom / glitch 特效，统一映射成内置 Cross Dissolve 并逐条点名。
     两侧有一段没素材地址（写成 <gap>）或中间留了空隙时，这一窗写不出来，也照实报数。 */
  const transitionByLeft = new Map();
  const transitionSkips = [];
  (plan.transitions || []).forEach(tr => {
    const ri = Number(tr && tr.to);
    const L = plan.rows[ri - 1], R = plan.rows[ri];
    const why = !L || !R ? '下标越界'
      : (!L.src || !R.src) ? '有一侧没取到素材地址（写成 gap）'
        : Math.abs(Number(L.end) - Number(R.start)) > 1 / FR + 0.0005 ? '两段之间有空隙'
          : '';
    if (why) { transitionSkips.push(t2s(L ? L.start : 0) + '：' + why); return; }
    const half = Math.round((Number(tr.duration) || 0) * FR / 2);
    const room = Math.min(half, Math.floor(Number(L.duration) * FR / 2), Math.floor(Number(R.duration) * FR / 2));
    if (room < 1) { transitionSkips.push(t2s(R.start) + '：窗口短于一帧'); return; }
    const h = room / FR;
    transitionByLeft.set(ri - 1, { at: Number(R.start) - h, duration: 2 * h, id: String((tr && tr.id) || '') });
  });

  /* ---------------- 画面段 ----------------
     起点与行长直接拿 plan 里那一列（deriveTimeline 摊出来的，不再自己累加）。 */
  const rows = plan.rows.map(row => {
    const clip = row.clip;
    const out = { index: row.index, row, clip, ref: '', media: null, still: clip.kind === 'image', label: clipNameOf(clip) };
    if (!row.src) { out.noSrc = true; return out; }
    out.media = mediaOf(row.src, out.still ? 'image' : 'video', { shot: row.shot, cand: row.cand, clip, idx: row.index });
    /* asset 的时长 = 素材原长（源秒）：`start` 是这一段的入点，FCP 要能在素材里走到出点之后。
       静态图没有源时长，给「本段时长 + 4 秒」：转场要从片段外侧借用半个窗时，静帧可以任意延长。 */
    const srcDur = out.still ? Math.max(0.1, row.duration + 4)
      : Math.max(Number(clip.sourceDuration) || 0.1, Number(clip.mediaDuration) || 0);
    out.ref = assetFor(out.media, srcDur, out.still ? 'image' : 'video');
    return out;
  });
  /* 地址没取到的那几段：写 `<gap>` 保持时间线连续（时长照旧），并在名单里点名 —— 不静默丢段。 */
  plan.missing.forEach(m => missing.push({
    name: '第 ' + (m.index + 1) + ' 段「' + (m.name || '画面段') + '」（没有可用素材地址）', src: '',
  }));

  /* ---------------- 配音：spine 上的独立 asset-clip ----------------
     新模型里配音是**定时条目**（绝对成片秒 + 打包行号），不挂在某一段画面底下 ——
     所以它们不再嵌套进 asset-clip，而是各自占一条 lane，offset 用它自己的成片秒。 */
  const voices = plan.voices.map((v, i) => {
    const sh = v.shotId ? (plan.rows.find(r => r.shot && r.shot.id === v.shotId) || {}).shot : null;
    const media = mediaOf(v.src, 'audio', { shot: sh, idx: i });
    return {
      ...v, media,
      ref: assetFor(media, Math.max(0.1, Number(v.sourceStart) + Number(v.duration) + 1), 'audio'),
      label: String(v.name || '配音'),
    };
  });
  const voiceLanes = voices.reduce((a, v) => Math.max(a, v.lane + 1), 0);

  /* ---------------- 字幕：spine 上的 title ----------------
     一条字幕就是一条绝对成片秒的窗（旧那套「按镜折算 / 挂到那一格的 offset」没了），
     lane 排在所有配音行之上。 */
  const titles = plan.captions.map((c, i) => ({ ...c, order: i, name: '字幕 ' + (i + 1) }));
  const titleStyle = titleStyleOf(ctx, opts, Number(size && size.h) || 1080);

  const dbOf = vol => {
    const v = Math.max(0, Number(vol) || 0);
    return v <= 0 ? '-96dB' : (20 * Math.log10(v)).toFixed(1) + 'dB';
  };
  const warnings = [];
  if (transitionByLeft.size) {
    warnings.push(transitionByLeft.size + ' 处转场已写进 XML：按 FCPXML 语义以切点为中心做重叠'
      + '（Cross Dissolve）；成片里是切点前淡入，导入后是切点两侧各半窗，时长与配音/字幕时间都不变');
    const custom = Array.from(new Set(Array.from(transitionByLeft.values()).map(x => x.id).filter(id => id && id !== 'fade')));
    if (custom.length) warnings.push('自制转场 ' + custom.join(' / ') + ' 在 FCPXML 里统一映射成 Cross Dissolve（交换格式没有对应特效）');
  }
  if (transitionSkips.length) {
    warnings.push(transitionSkips.length + ' 处转场没写进 XML（导入后是硬切）：'
      + transitionSkips.slice(0, 8).join('、') + (transitionSkips.length > 8 ? ' 等' : ''));
  }
  if (titles.length) {
    warnings.push('字幕按 ' + titleStyle.font + ' / ' + titleStyle.size + ' px 写出；高亮底色写 text-style 的 backgroundColor；本机没这个字体会被替换');
  }
  /* SRT 与 XML 同一份表：包里的 subtitles.srt 就是 plan.captions 那几条。 */
  const srt = srtSerialize(titles, { bom: true, crlf: true });
  function t2s(sec) { return Math.round((Number(sec) || 0) * 10) / 10 + ' 秒'; }

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE fcpxml>');
  out.push('<!-- 导出成像「' + noteSafe(proj.name || '未命名短片') + '」成片 · '
    + new Date().toLocaleString('zh-CN') + ' -->');
  if (missing.length) {
    out.push('<!-- 本机没有可用文件的素材（导入 FCP 后会显示离线；请补到与 FCPXML 同级的 media/ 目录，或重新链接）：');
    missing.slice(0, 60).forEach(x => out.push('     - ' + noteSafe(x.name) + (x.src ? '：' + noteSafe(x.src) : '')));
    if (missing.length > 60) out.push('     …另有 ' + (missing.length - 60) + ' 条');
    out.push('-->');
  }
  if (warnings.length) {
    out.push('<!-- 导出提醒（一条都没有静默丢：下面逐条写明原因）：');
    warnings.forEach(w => out.push('     - ' + noteSafe(w)));
    out.push('-->');
  }
  out.push('<fcpxml version="1.10">');
  out.push('  <resources>');
  out.push('    <format id="r1" name="FFVideoFormat' + size.w + 'x' + size.h + 'p' + FR + '" frameDuration="1/' + FR
    + 's" width="' + size.w + '" height="' + size.h + '"/>');
  if (titles.length) out.push('    <effect id="r_title" name="Basic Title" uid="' + BASIC_TITLE_UID + '"/>');
  if (transitionByLeft.size) {
    out.push('    <effect id="r_trans" name="Cross Dissolve" uid="' + CROSS_DISSOLVE_UID + '"/>');
  }
  assets.forEach(a => {
    const m = a.media;
    /* 静态图也走视频轨（still）：hasVideo 有、hasAudio 没有，时长由 asset-clip 决定。 */
    const attrs = a.kind === 'video'
      ? ' hasVideo="1" hasAudio="1" format="r1"'
      : a.kind === 'image'
        ? ' hasVideo="1" format="r1"'
        : ' hasAudio="1" audioSources="1" audioChannels="1" audioRate="48000"';
    out.push('    <asset id="' + a.id + '" name="' + xe(m.name) + '" duration="' + t(a.duration) + '"' + attrs + '>');
    out.push('      <media-rep kind="original-media" src="' + xe(m.href) + '"/>');
    out.push('    </asset>');
  });
  out.push('  </resources>');
  out.push('  <library>');
  out.push('    <event name="成像导出">');
  out.push('      <project name="' + xe(proj.name || '未命名短片') + '">');
  out.push('        <sequence format="r1" duration="' + t(plan.duration) + '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">');
  out.push('          <spine>');
  /* 片段之间允许留空（clip.gap）：spine 要连续，空出来的那几秒写成 <gap>。 */
  let cursor = 0;
  rows.forEach(r => {
    if (r.row.start > cursor + 0.0005) {
      out.push('            <gap name="空隙" offset="' + t(cursor) + '" duration="' + t(r.row.start - cursor) + '"/>');
    }
    cursor = Math.max(cursor, r.row.end);
    if (!r.ref) {
      const gname = (r.noSrc ? '素材没取到' : '画面段') + ' · 第 ' + (r.index + 1) + ' 段'
        + (r.label ? '「' + r.label + '」' : '');
      out.push('            <gap name="' + xe(gname) + '" offset="' + t(r.row.start) + '" duration="' + t(r.row.duration) + '"/>');
      return;
    }
    const clip = r.clip;
    /* 段显示名带场景与镜头（与素材文件名同源）：FCP 的时间线里一眼看得出是哪一镜。 */
    const sctx = r.row.shot ? shotCtxOf(proj, r.row.shot) : null;
    const label = sctx ? clipLabel(sctx, r.index + 1) : (clip.name || ('第 ' + (r.index + 1) + ' 段'));
    const rate = Math.max(0.25, Math.min(4, Number(r.row.payload.playbackRate) || 1));
    out.push('            <asset-clip ref="' + r.ref + '" name="' + xe(label)
      + '" offset="' + t(r.row.start) + '" start="' + t(r.still ? 0 : clip.sourceStart) + '" duration="' + t(r.row.duration) + '" tcFormat="NDF">');
    /* 图片段：起点恒为 0、整段就是这一张图，也就没有倍速（没有 timeMap）与原声音量。 */
    if (!r.still && Math.abs(rate - 1) > 0.001) {
      out.push('              <timeMap>');
      out.push('                <timept time="0s" value="0s" interp="linear"/>');
      out.push('                <timept time="' + t(r.row.duration) + '" value="' + t(clip.sourceDuration) + '" interp="linear"/>');
      out.push('              </timeMap>');
    }
    if (!r.still) {
      const pv = Number(r.row.payload.volume);
      if (Math.abs(pv - 1) > 0.001) out.push('              <adjust-volume amount="' + dbOf(pv) + '"/>');
    }
    out.push('            </asset-clip>');
    /* 转场必须紧跟在左片段之后、右片段之前（spine 里的顺序就是时间顺序）。
       offset 用绝对成片秒，所有片段也都写了 offset，所以重叠不会把后面的片段往前推。 */
    const tr = transitionByLeft.get(r.index);
    if (tr && rows[r.index + 1] && rows[r.index + 1].ref) {
      out.push('            <transition name="Cross Dissolve" offset="' + t(tr.at) + '" duration="' + t(tr.duration) + '">');
      out.push('              <filter-video ref="r_trans" name="Cross Dissolve"/>');
      out.push('            </transition>');
    }
  });
  voices.forEach(v => {
    out.push('            <asset-clip ref="' + v.ref + '" lane="' + (1 + v.lane) + '" name="' + xe(v.label)
      + '" offset="' + t(v.start) + '" start="' + t(v.sourceStart) + '" duration="' + t(v.duration)
      + '" audioRole="dialogue" tcFormat="NDF">');
    const srcDur = Math.max(0.1, Number(v.sourceDuration) || Number(v.duration) || 0.1);
    if (Math.abs(srcDur - v.duration) > 0.01) {
      out.push('              <timeMap>');
      out.push('                <timept time="0s" value="0s" interp="linear"/>');
      out.push('                <timept time="' + t(v.duration) + '" value="' + t(srcDur) + '" interp="linear"/>');
      out.push('              </timeMap>');
    }
    if (Math.abs(Number(v.volume) - 1) > 0.001) out.push('              <adjust-volume amount="' + dbOf(v.volume) + '"/>');
    if (Number(v.fadeIn) > 0 || Number(v.fadeOut) > 0) {
      out.push('              <adjust-fades fadeInDuration="' + t(v.fadeIn) + '" fadeOutDuration="' + t(v.fadeOut) + '"/>');
    }
    out.push('            </asset-clip>');
  });
  titles.forEach((x, n) => {
    const py = x.position === 'top' ? 420 : x.position === 'middle' ? 0 : -420;
    const yy = Math.round(py * (Number(size && size.h) || 1080) / 1080);
    const dur = Math.max(1 / FR, Number(x.end) - Number(x.start));
    /* 高亮底色、字体、字号、字色、粗体与投影都是 DTD 1.10 的 text-style 属性（非 CSS）：
       backgroundColor 是专门给字幕的那一枚，黑 55% 与预览/烧录的 rgba(0,0,0,.55) 同源。 */
    const styleAttrs = 'font="' + xe(titleStyle.font) + '" fontSize="' + titleStyle.size
      + '" fontColor="' + xe(titleStyle.color) + '" bold="' + titleStyle.bold + '" alignment="center"'
      + (titleStyle.shadow
        ? ' shadowColor="0 0 0 0.9" shadowBlurRadius="' + Math.round(titleStyle.size * 6 / 54)
          + '" shadowOffset="0 ' + Math.round(titleStyle.size * 2 / 54) + '"'
        : '')
      + (x.highlight ? ' backgroundColor="' + xe(titleStyle.highlight) + '"' : '');
    out.push('            <title ref="r_title" lane="' + (1 + voiceLanes + x.lane) + '" name="' + xe(x.name)
      + '" offset="' + t(x.start) + '" duration="' + t(dur) + '">');
    out.push('              <param name="Position" key="' + SUB_POSITION_KEY + '" value="0 ' + yy + '"/>');
    out.push('              <text><text-style ref="ts' + (n + 1) + '">' + xe(x.text) + '</text-style></text>');
    out.push('              <text-style-def id="ts' + (n + 1) + '">');
    out.push('                <text-style ' + styleAttrs + '/>');
    out.push('              </text-style-def>');
    out.push('            </title>');
  });
  out.push('          </spine>');
  out.push('        </sequence>');
  out.push('      </project>');
  out.push('    </event>');
  out.push('  </library>');
  out.push('</fcpxml>');
  const xml = out.join('\n');
  const gapRows = rows.filter(r => !r.ref).length;
  return {
    ok: true, xml, srt, subtitles: titles.length, warnings, bundleAssets, missing,
    rows: rows.length, gapRows, voices: voices.length,
    transitions: (plan.transitions || []).length,
    transitionsWritten: transitionByLeft.size, transitionsSkipped: transitionSkips.length,
    titleStyle, duration: plan.duration,
  };
}

/* 下载 .fcpxml 或媒体包 zip。按钮禁用与状态行都在这一层收口。 */
export async function exportFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { setStatus, el } = ctx;
  const W = typeof window === 'undefined' ? null : window;
  const Net = (ctx && ctx.Net) || (W && W.Net) || null;
  const btn = el(bundle ? 'exportFcpBundle' : 'exportFcp');
  const btn2 = el(bundle ? 'exportFcp' : 'exportFcpBundle');
  if (btn) btn.disabled = true;
  if (btn2) btn2.disabled = true;
  try {
    const r = await buildFCPXML(ctx, opts);
    if (!r || !r.ok) return r;
    const safe = (W && W.fileSafe) || (s => String(s || ''));
    const stamp = (W && W.fileStamp) || (() => 'export');
    const baseName = safe((ctx.proj && ctx.proj.name) || '成片', 60) + '-FCPXML-' + stamp();
    const extra = (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
      + (r.transitionsWritten ? ' · 转场 ' + r.transitionsWritten + ' 处（已写进 XML）' : '')
      + (r.transitionsSkipped ? ' · ' + r.transitionsSkipped + ' 处转场写不进 XML（文件头有说明）' : '')
      + (r.gapRows ? ' · ' + r.gapRows + ' 段没有素材地址，写成 gap' : '')
      + (r.warnings.length ? ' · 提醒 ' + r.warnings.length + ' 条（文件开头有注释）' : '');
    if (bundle) {
      setStatus('<span class="hint">正在打包 FCPXML 与素材…</span>');
      const zip = await Net.blob('/fcpxml/bundle', {
        method: 'POST', timeout: 10 * 60 * 1000, retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fcpxml: r.xml, srt: r.subtitles ? r.srt : '', assets: r.bundleAssets }),
      });
      await Net.save(zip, baseName + '-媒体包.zip');
      /* 这里的 missing 是**客户端预测**（不在本机索引里的那些），不是服务端实数：
         代理会按原地址回源取，真取不到才往包里写 missing.txt —— 包里没有这个文件就是全取到了。
         按预测数写「N 处取不到，名单在 missing.txt」是假话：包其实是齐的，名单根本不存在。 */
      setStatus('<span class="ok">✓ 已导出媒体包：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音 · '
        + r.bundleAssets.length + ' 份素材'
        + (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
        + (r.missing.length ? ' · ' + r.missing.length + ' 处素材由代理回源取' : '')
        + extra + '</span>');
      return { ok: true, bundle: true, rows: r.rows, voices: r.voices, gapRows: r.gapRows,
        subtitles: r.subtitles, transitions: r.transitions, transitionsWritten: r.transitionsWritten,
        transitionsSkipped: r.transitionsSkipped, assets: r.bundleAssets.length,
        missing: r.missing.length, duration: r.duration, warnings: r.warnings };
    }
    await Net.save(new Blob([r.xml], { type: 'application/xml' }), baseName + '.fcpxml');
    setStatus('<span class="ok">✓ 已导出 FCPXML：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音 · '
      + ((W && W.fmtDur) ? W.fmtDur(r.duration) : r.duration + ' 秒')
      + (r.missing.length ? ' · ' + r.missing.length + ' 处本机没有文件（清单在文件开头，补到 media/ 或重新链接）' : '')
      + extra + '</span>');
    return { ok: true, bundle: false, rows: r.rows, voices: r.voices, gapRows: r.gapRows,
      subtitles: r.subtitles, transitions: r.transitions, transitionsWritten: r.transitionsWritten,
      transitionsSkipped: r.transitionsSkipped, missing: r.missing.length,
      duration: r.duration, warnings: r.warnings };
  } catch (e) {
    const msg = fcpErrText(ctx, e);
    setStatus('<span class="err">导出 FCPXML 失败：' + escHTML(msg) + '</span>');
    return { ok: false, err: msg };
  } finally {
    if (btn) btn.disabled = false;
    if (btn2) btn2.disabled = false;
  }
}

/* 持久工程目录：与媒体包同一份 buildFCPXML + 服务端 writeBundle，只是不下载 zip、也不再写一份
   bundle.zip，而是把 project.fcpxml + media/ + subtitles.srt + missing.txt 摊开留成一个目录并回路径。
   落点是本机资产库下的 FCPXML工程/（服务端现读库根），与「存回本机」的素材放在一起。
   不启动任何剪辑软件：导入那一步由用户在自己的软件里做；界面（engine/export.js）给目录、
   缺失数、「打开文件夹」与「复制路径」。 */
export async function exportProject(ctx) {
  const { setStatus, el } = ctx;
  const W = typeof window === 'undefined' ? null : window;
  const Net = (ctx && ctx.Net) || (W && W.Net) || null;
  const btn = el('exportProject');
  if (btn) btn.disabled = true;
  try {
    setStatus('<span class="hint">正在生成 FCPXML 工程目录…</span>');
    const r = await buildFCPXML(ctx, { bundle: true });
    if (!r || !r.ok) return r;
    const p = await Net.json('/fcpxml/project', {
      method: 'POST', timeout: 10 * 60 * 1000, retry: 0,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fcpxml: r.xml, srt: r.subtitles ? r.srt : '', assets: r.bundleAssets }),
    });
    if (!p || !p.ok || !p.id) throw new Error((p && p.error) || '代理没有返回工程目录');
    const missingCount = Number(p.missingCount) || 0;
    setStatus('<span class="ok">✓ 已导出 FCPXML 工程目录：' + escHTML(String(p.dir || ''))
      + ' · ' + r.rows + ' 段画面 · ' + r.voices + ' 句配音'
      + (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
      + ' · 素材 ' + (Number(p.assets) || 0) + ' 份'
      + (missingCount ? ' · ' + missingCount + ' 份没取到（名单在 missing.txt）' : '')
      + (r.transitionsWritten ? ' · 转场 ' + r.transitionsWritten + ' 处' : '') + '</span>');
    return { ok: true, id: p.id, dir: p.dir || '', project: p.project || '',
      rows: r.rows, voices: r.voices, subtitles: r.subtitles,
      transitions: r.transitions, transitionsWritten: r.transitionsWritten,
      transitionsSkipped: r.transitionsSkipped,
      assets: Number(p.assets) || 0, missing: r.missing.length, missingCount,
      duration: r.duration, warnings: r.warnings };
  } catch (e) {
    const msg = fcpErrText(ctx, e);
    setStatus('<span class="err">导出工程目录失败：' + escHTML(msg) + '</span>');
    return { ok: false, err: msg };
  } finally {
    if (btn) btn.disabled = false;
  }
}
