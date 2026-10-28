/* FCPXML 导出：把**当前成片**写成 Final Cut Pro / 达芬奇可导入的 XML，或 project.fcpxml + media/ +
   subtitles.srt 的媒体包。只读：不修改任何工程数据。
   三条出口共用同一份拼装（buildFCPXML）：下载 .fcpxml、下载媒体包 zip、送到剪映 / 达芬奇。
   ----------------------------------------------------------------------------
   组表人不是这里：这一份读的是 engine/export.js 的 `buildRenderPlan()` —— 与浏览器内导出成片
   **同一张表**（段顺序与起点、进片的配音与字幕、每句在哪一行、素材地址本机优先都已经在它那侧算完）。
   这里只把那张表翻译成 FCPXML 的形状；再自己累加一遍起点或再 pack 一遍行，迟早和成片各说各话。
   段与段之间那一窗转场**不写进 XML**：FCPXML 的 `<transition>` 会把两帖叠起来（导入后的时间线
   比这一条片子短 dur 秒），而我们的转场不吃时长 —— 两边对不上。文件开头的注释与回执都点名报数，
   不假装导出了转场，也不静默丢。
   素材名与「存回本机」同一个来源（naming.js + 本机索引里的 name）：
   本机索引名 = 库根上那个文件的文件名 = 媒体包里的 media/<名> = `<asset name>`；
   同一份素材在多段里复用只进包一次，XML 引用同一个 `media/<名>`。 */
import { escHTML } from './util.js';
import { TL_FPS } from './film.js';
import { srtSerialize } from './srt.js';
import { candidateBase, voiceBase, clipLabel, shotCtxOf, candidateIndex, stripExt, withExt, uniqueName } from './naming.js';

/* FCP 内置标题效果（Basic Title）与它的「位置」参数键：只有导出器用得到，就住在这里。 */
const BASIC_TITLE_UID = '.../Titles.localized/Basic Title.localized/Basic Title.moti';
const SUB_POSITION_KEY = '9999/999166631/999166633/1/100/101';
/* 字幕的字号与画幅比例：与预览叠层 `.sub-ov` / 烧录那一份同一个数（54/1080）。 */
const TITLE_FONT = 'PingFang SC';
const TITLE_SIZE_RATIO = 54 / 1080;

/* 只拼装、不落盘：导出文件 / 媒体包 / 送到 NLE 三条出口都读这一份结果。
   `opts.bundle` 决定媒体引用写相对路径（media/<名>）还是本机真实文件路径。
   返回 ok:false 只表示「现在没有可导出的东西」；其余失败照常抛给调用方。 */
export async function buildFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { proj, buildRenderPlan, clipNameOf, filmSize, setStatus, AssetLocal, Api } = ctx;
  if (!proj) { setStatus('<span class="err">还没有打开的短片：先建一份工程再导出</span>'); return { ok: false, quiet: true, err: '没有打开的短片' }; }
  /* 镜像指针可能还在 IndexedDB 里读回来（localStorage 只是暖缓存）：
     FCPXML 要把本地素材写成真实文件路径，先等它一下，别把明明有的文件标成缺失。 */
  if (window.AssetLocal && AssetLocal.ready) {
    try { await Promise.race([AssetLocal.ready(), new Promise(r => setTimeout(r, 1200))]); } catch (e) { /* 等不到就按「本机没有」记，不卡住导出 */ }
  }
  const plan = await buildRenderPlan();
  if (!plan.rows.length) {
    setStatus('<span class="err">成片还没有画面</span>');
    return { ok: false, quiet: true, err: '成片里一段画面都没有' };
  }
  const sys = window.Api && Api.sysStatus ? await Api.sysStatus().catch(() => null) : null;
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
    const f = window.AssetLocal && AssetLocal.localFileOf ? AssetLocal.localFileOf(src) : null;
    const la = (f && f.id) || ((/^\/asset\/(la_[A-Za-z0-9_-]+)/.exec(String(src || '')) || [])[1]);
    /* 本机索引里的名字就是「存回本机」写下的文件名，优先于场景镜头名：两边必须是同一个名字。
       旧素材的名字可能带扩展名，stripExt + withExt 保证只留恰好一个。 */
    const idxBase = f && f.name ? stripExt(f.name) : '';
    const sceneBase = sctx
      ? (isAudio ? voiceBase(sctx) : candidateBase(sctx, candidateIndex(sh, cand)))
      : '';
    /* 图片段的名字对它没意义（它不在那条候选的源时间轴上）：拖进来的那张图叫什么就叫什么。 */
    const stillName = isImage && clip && clip.name ? (window.fileSafe(clip.name, 48) || '') : '';
    const base = idxBase || stillName || sceneBase
      || (window.fileSafe((clip && clip.name) || ((isAudio ? '配音' : '素材') + '-' + ((Number(it.idx) || 0) + 1)), 48) || '素材');
    if (la && assetsDir) {
      const ext = String((f && f.format) || fallback).toLowerCase();
      const key = kind + ':la:' + la;
      const name = mediaNameOf(key, base, ext);
      if (bundle) return { key, name, local: false, bundleSrc: Api.assetSrc(la), href: mediaHref(name) };
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

  /* ---------------- 画面段 ----------------
     起点与行长直接拿 plan 里那一列（deriveTimeline 摊出来的，不再自己累加）。 */
  const rows = plan.rows.map(row => {
    const clip = row.clip;
    const out = { index: row.index, row, clip, ref: '', media: null, still: clip.kind === 'image', label: clipNameOf(clip) };
    if (!row.src) { out.noSrc = true; return out; }
    out.media = mediaOf(row.src, out.still ? 'image' : 'video', { shot: row.shot, cand: row.cand, clip, idx: row.index });
    /* asset 的时长 = 素材原长（源秒）：`start` 是这一段的入点，FCP 要能在素材里走到出点之后。 */
    const srcDur = out.still ? Math.max(0.1, row.duration)
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

  const dbOf = vol => {
    const v = Math.max(0, Number(vol) || 0);
    return v <= 0 ? '-96dB' : (20 * Math.log10(v)).toFixed(1) + 'dB';
  };
  const warnings = [];
  if (plan.transitions.length) {
    warnings.push(plan.transitions.length + ' 处转场没写进 XML（导入后硬切）。位置：'
      + plan.transitions.slice(0, 8).map(x => t2s(x.start) + ' → ' + x.id).join('、')
      + (plan.transitions.length > 8 ? ' 等' : ''));
  }
  if (titles.some(x => x.highlight)) warnings.push('高亮底色不进 FCPXML。');
  if (titles.length) warnings.push('字幕一律按 ' + TITLE_FONT + ' 与画幅等比字号写出；本机没这个字体会被替换');
  /* SRT 与 XML 同一份表：包里的 subtitles.srt 就是 plan.captions 那几条。 */
  const srt = srtSerialize(titles, { bom: true, crlf: true });
  function t2s(sec) { return Math.round((Number(sec) || 0) * 10) / 10 + ' 秒'; }

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE fcpxml>');
  out.push('<!-- 导出拾帧「' + noteSafe(proj.name || '未命名短片') + '」成片 · '
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
  out.push('    <event name="拾帧导出">');
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
    /* 段显示名带场景与镜头（与素材文件名同源）：FCP / 达芬奇的时间线里一眼看得出是哪一镜。 */
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
    const fs = Math.max(12, Math.min(300, Math.round(TITLE_SIZE_RATIO * (Number(size && size.h) || 1080))));
    const py = x.position === 'top' ? 420 : x.position === 'middle' ? 0 : -420;
    const yy = Math.round(py * (Number(size && size.h) || 1080) / 1080);
    const dur = Math.max(1 / FR, Number(x.end) - Number(x.start));
    out.push('            <title ref="r_title" lane="' + (1 + voiceLanes + x.lane) + '" name="' + xe(x.name)
      + '" offset="' + t(x.start) + '" duration="' + t(dur) + '">');
    out.push('              <param name="Position" key="' + SUB_POSITION_KEY + '" value="0 ' + yy + '"/>');
    out.push('              <text><text-style ref="ts' + (n + 1) + '">' + xe(x.text) + '</text-style></text>');
    out.push('              <text-style-def id="ts' + (n + 1) + '">');
    out.push('                <text-style font="' + xe(TITLE_FONT) + '" fontSize="' + fs
      + '" fontColor="1.0000 1.0000 1.0000 1.0000" alignment="center"/>');
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
    rows: rows.length, gapRows, voices: voices.length, transitions: plan.transitions.length,
    duration: plan.duration,
  };
}

/* 下载 .fcpxml 或媒体包 zip。按钮禁用与状态行都在这一层收口。 */
export async function exportFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { setStatus, el } = ctx;
  const btn = el(bundle ? 'exportFcpBundle' : 'exportFcp');
  const btn2 = el(bundle ? 'exportFcp' : 'exportFcpBundle');
  if (btn) btn.disabled = true;
  if (btn2) btn2.disabled = true;
  try {
    const r = await buildFCPXML(ctx, { bundle });
    if (!r || !r.ok) return r;
    const baseName = window.fileSafe((ctx.proj && ctx.proj.name) || '成片', 60) + '-FCPXML-' + window.fileStamp();
    const extra = (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
      + (r.transitions ? ' · 转场 ' + r.transitions + ' 处（XML 里不写，文件头有说明）' : '')
      + (r.gapRows ? ' · ' + r.gapRows + ' 段没有素材地址，写成 gap' : '')
      + (r.warnings.length ? ' · 提醒 ' + r.warnings.length + ' 条（文件开头有注释）' : '');
    if (bundle) {
      setStatus('<span class="hint">正在打包 FCPXML 与素材…</span>');
      const zip = await ctx.Net.blob('/fcpxml/bundle', {
        method: 'POST', timeout: 10 * 60 * 1000, retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fcpxml: r.xml, srt: r.subtitles ? r.srt : '', assets: r.bundleAssets }),
      });
      await window.Net.save(zip, baseName + '-媒体包.zip');
      /* 这里的 missing 是**客户端预测**（不在本机索引里的那些），不是服务端实数：
         代理会按原地址回源取，真取不到才往包里写 missing.txt —— 包里没有这个文件就是全取到了。
         按预测数写「N 处取不到，名单在 missing.txt」是假话：包其实是齐的，名单根本不存在。 */
      setStatus('<span class="ok">✓ 已导出媒体包：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音 · '
        + r.bundleAssets.length + ' 份素材'
        + (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
        + (r.missing.length ? ' · ' + r.missing.length + ' 处素材由代理回源取' : '')
        + extra + '</span>');
      return { ok: true, bundle: true, rows: r.rows, voices: r.voices, gapRows: r.gapRows,
        subtitles: r.subtitles, transitions: r.transitions, assets: r.bundleAssets.length,
        missing: r.missing.length, duration: r.duration, warnings: r.warnings };
    }
    await window.Net.save(new Blob([r.xml], { type: 'application/xml' }), baseName + '.fcpxml');
    setStatus('<span class="ok">✓ 已导出 FCPXML：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音 · '
      + window.fmtDur(r.duration)
      + (r.missing.length ? ' · ' + r.missing.length + ' 处本机没有文件（清单在文件开头，补到 media/ 或重新链接）' : '')
      + extra + '</span>');
    return { ok: true, bundle: false, rows: r.rows, voices: r.voices, gapRows: r.gapRows,
      subtitles: r.subtitles, transitions: r.transitions, missing: r.missing.length,
      duration: r.duration, warnings: r.warnings };
  } catch (e) {
    const msg = typeof errText === 'function' ? errText(e) : String(e);
    setStatus('<span class="err">导出 FCPXML 失败：' + msg + '</span>');
    return { ok: false, err: msg };
  } finally {
    if (btn) btn.disabled = false;
    if (btn2) btn2.disabled = false;
  }
}

/* 一键送到剪映 / 达芬奇：生成持久媒体包目录 → 尽力启动软件。
   两家都没有可靠的命令行「导入这个文件」协议，所以最后一步仍由用户在软件里点导入 ——
   这里不假装能替他点；界面会把目录、缺失数与导入路径一起说清楚。 */
export async function sendToNle(ctx, opts) {
  const app = opts && opts.app === 'jianying' ? 'jianying' : 'resolve';
  const appName = app === 'jianying' ? '剪映专业版' : 'DaVinci Resolve';
  const { setStatus, Net } = ctx;
  setStatus('<span class="hint">正在准备 ' + appName + ' 的导入工程…</span>');
  const r = await buildFCPXML(ctx, { bundle: true });
  if (!r || !r.ok) return r;
  const body = JSON.stringify({ fcpxml: r.xml, srt: r.subtitles ? r.srt : '', assets: r.bundleAssets });
  const imp = await Net.json('/fcpxml/import', {
    method: 'POST', timeout: 10 * 60 * 1000, retry: 0,
    headers: { 'Content-Type': 'application/json' }, body,
  });
  if (!imp || !imp.ok || !imp.id) throw new Error((imp && imp.error) || '代理没有返回导入目录');
  /* 启动软件是尽力而为：没装 / 装在别处都不该让「工程已经生成好了」变成失败。 */
  let launch = null;
  try {
    launch = await Net.json('/fcpxml/launch', {
      method: 'POST', retry: 0,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app }),
    });
  } catch (e) { launch = { ok: false, reason: typeof errText === 'function' ? errText(e) : String(e) }; }
  const missingCount = Number(imp.missingCount) || 0;
  setStatus('<span class="ok">✓ 已生成 ' + appName + ' 导入工程：' + imp.dir
    + (missingCount ? ' · ' + missingCount + ' 份素材没取到（missing.txt）' : '')
    + (launch && launch.ok ? ' · 已启动 ' + appName : '') + '</span>');
  return { ok: true, id: imp.id, dir: imp.dir, project: imp.project || '', app, appName,
    missing: r.missing.length, missingCount, assets: Number(imp.assets) || 0,
    rows: r.rows, voices: r.voices, subtitles: r.subtitles, warnings: r.warnings, launch };
}
