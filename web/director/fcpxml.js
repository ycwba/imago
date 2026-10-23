/* FCPXML 导出：把当前时间线写成 Final Cut Pro / 达芬奇可导入的 XML，或 project.fcpxml + media/ 和
   subtitles.srt 的媒体包。只读：不修改任何工程数据。时间线相关的函数与状态由引擎按 ctx 传进来。
   三条出口共用同一份拼装（buildFCPXML）：下载 .fcpxml、下载媒体包 zip、送到剪映 / 达芬奇。
   素材名与「存回本机」同一个来源（web/director/naming.js + 本机索引里的 name）：
   素材名与本机索引里的 name 同一个来源（web/director/naming.js + 库根落点用的那一份）：
   本机索引名 = 库根上那个文件的文件名 = 媒体包里的 media/<名> = `<asset name>`；
   同一份素材在多段里复用只进包一次，XML 引用同一个 `media/<名>`。 */
import { fcpxmlTitles, BASIC_TITLE_UID } from './subtitles.js';
import { escHTML } from './util.js';
import { candidateBase, voiceBase, clipLabel, shotCtxOf, candidateIndex, voiceIndex, stripExt, withExt, uniqueName } from './naming.js';

/* 只拼装、不落盘：导出文件 / 媒体包 / 送到 NLE 三条出口都读这一份结果。
   `opts.bundle` 决定媒体引用写相对路径（media/<名>）还是本机真实文件路径。
   返回 ok:false 只表示「现在没有可导出的东西」；其余失败照常抛给调用方。 */
export async function buildFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { tlSyncFromShots, healStaleUrls, filmSize, setStatus, tlClipDur, tlClipSrc, allShots, tlCandidateOf, candDur, voicesEnsure, voiceVolOf, styleOf, AssetLocal, Api } = ctx;
  const proj = ctx.proj;
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    setStatus('<span class="err">现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面</span>');
    return { ok: false, quiet: true, err: '没有可用镜头' };
  }
  await healStaleUrls().catch(() => 0);
  /* 镜像指针可能还在 IndexedDB 里读回来（localStorage 只是暖缓存）：
     FCPXML 要把本地素材写成真实文件路径，先等它一下，别把明明有的文件标成缺失。 */
  if (window.AssetLocal && AssetLocal.ready) {
    try { await Promise.race([AssetLocal.ready(), new Promise(r => setTimeout(r, 1200))]); } catch (e) {}
  }
  const sys = window.Api && Api.sysStatus ? await Api.sysStatus().catch(() => null) : null;
  const assetsDir = String((sys && sys.目录 && sys.目录.资产 && sys.目录.资产.路径) || '');
  const size = filmSize();
  const FR = 30;
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
  const missing = [], grayVoices = [], bundleAssets = [];
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
  function mediaOf(src, kind, info) {
    const it = info || {};
    const isAudio = kind === 'audio';
    const isImage = kind === 'image';
    const sh = it.shot || null;
    const cand = it.cand || null;
    const clip = it.clip || null;
    const voice = it.voice || null;
    const sctx = sh ? shotCtxOf(proj, sh) : null;
    const fallback = isAudio
      ? ((String(src || '').match(/\.(wav|mp3|m4a|aac|ogg|flac)(?:\?|$)/i) || [])[1] || 'wav')
      : isImage
        ? (((String(src || '').match(/\.(png|jpe?g|webp|gif|bmp|avif|heic)(?:\?|$)/i) || [])[1] || 'png').toLowerCase())
        : ((String((cand && cand.format) || (clip && clip.format) || '').match(/^(mp4|mov|webm|mkv)$/i) || [])[1] || 'mp4');
    const f = window.AssetLocal && AssetLocal.localFileOf ? AssetLocal.localFileOf(src) : null;
    const la = (f && f.id) || ((/^\/asset\/(la_[A-Za-z0-9_-]+)/.exec(String(src || '')) || [])[1]);
    /* 本机索引里的名字就是「存回本机」写下的文件名，优先于场景镜头名：两边必须是同一个名字。
       旧素材的名字可能带扩展名，stripExt + withExt 保证只留恰好一个。 */
    const idxBase = f && f.name ? stripExt(f.name) : '';
    const sceneBase = sctx
      ? (isAudio ? voiceBase(sctx, voiceIndex(proj, voice)) : candidateBase(sctx, candidateIndex(sh, cand)))
      : '';
    /* 图片段的场景镜头名对它没意义（它不在那条候选的源时间轴上），素材自己的名字优先：
       拖进来的那张图叫什么，包里就叫什么。 */
    const stillName = isImage && clip && clip.imgName ? (window.fileSafe(clip.imgName, 48) || '') : '';
    const base = idxBase || stillName || sceneBase
      || (window.fileSafe((clip && clip.name) || ((isAudio ? '配音' : '素材') + '-' + ((Number(it.idx) || 0) + 1)), 48) || '素材');
    if (la && assetsDir) {
      const ext = String((f && f.format) || fallback).toLowerCase();
      const key = kind + ':la:' + la;
      const name = mediaNameOf(key, base, ext);
      if (bundle) return { key, name, local: false, bundleSrc: Api.assetSrc(la), href: mediaHref(name) };
      const p = assetsDir.replace(/[\\/]+$/, '') + '/' + la + '.' + ext;
      return { key, name, local: true, href: fileUrl(p) };
    }
    const key = kind + ':u:' + (src || base);
    const name = mediaNameOf(key, base, fallback);
    const canFetch = /^(?:https?:|\/(?:asset|getv|fetch)\b)/i.test(String(src || ''));
    /* 不在本机索引里的素材：单文件 FCPXML 导入后是离线素材，媒体包里由代理按地址取；
       取不到时服务端会写进 missing.txt —— 这里先按「本机没有」记一条，界面照实报数。 */
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
  const shots = allShots();
  const rows = [];
  let at = 0;
  for (let i = 0; i < tl.clips.length; i++) {
    const c = tl.clips[i];
    const dur = tlClipDur(c);
    const sh = shots.find(x => x.id === c.shotId) || null;
    const row = { c, at, dur, voices: [], sctx: sh ? shotCtxOf(proj, sh) : null };
    if (!c.gray && c.img) {
      /* 图片段：素材是那一张静态图本身，不是它底下的候选视频。地址同样走导出本机优先口径，
         写进 FCPXML 的仍是一条 still 引用（`<asset hasVideo>` + `start="0s"`、没有 timeMap）。 */
      const still = window.EditorMedia ? window.EditorMedia.exportSrc({ src: c.img }) : c.img;
      if (still) {
        const media = mediaOf(still, 'image', { shot: sh, clip: c, idx: i });
        row.ref = assetFor(media, Math.max(0.1, dur), 'image');
        row.media = media;
        row.still = 1;
      } else {
        missing.push({ name: (c.imgName || c.name || ('第 ' + (i + 1) + ' 段')) + '（没有可用的图片）', src: c.img || '' });
      }
    } else if (!c.gray) {
      const src = await tlClipSrc(c);
      if (src) {
        const cand = sh ? tlCandidateOf(sh, c.candId) : null;
        const srcDur = cand ? candDur(cand, sh) : Math.max(Number(c.out) || 0, 0.1);
        const media = mediaOf(src, 'video', { shot: sh, cand, clip: c, idx: i });
        row.ref = assetFor(media, srcDur, 'video');
        row.media = media;
      } else {
        missing.push({ name: (c.name || ('第 ' + (i + 1) + ' 段')) + '（没有可用素材）', src: '' });
      }
    }
    proj.voices = voicesEnsure();
    for (const v of proj.voices) {
      if (v.shotId !== c.shotId || v.candId !== c.candId || (v.seg == null ? 0 : v.seg) !== (c.seg == null ? 0 : c.seg)) continue;
      const span = Math.max(0.1, (Number(c.out) || 0) - (Number(c.in) || 0));
      const start = Math.max(0, Number(v.at) || 0);
      if (!v.src || start >= span) continue;
      const sp = Math.max(0.25, Math.min(4, Number(c.speed) || 1));
      const own = Math.max(0.25, Math.min(4, Number(v.spd) || 1));
      const vr = sp * own;
      if (!row.ref) { grayVoices.push({ v: v, absAt: row.at + start / sp, sp: sp, own: own, vr: vr }); continue; }
      const media = mediaOf(v.src, 'audio', { shot: sh, voice: v, idx: rows.length * 10 + row.voices.length });
      const ref = assetFor(media, (Number(v.off) || 0) + (Number(v.dur) || 0) + 1, 'audio');
      row.voices.push({
        ref, media,
        offset: start / sp,
        start: Math.max(0, Number(v.off) || 0),
        srcDur: Math.max(0.1, Number(v.dur) || 0),
        dur: Math.max(0.1, (Number(v.dur) || 0) / vr),
        vol: voiceVolOf(v),
        name: v.text || v.name || '配音',
      });
    }
    rows.push(row);
    at += dur;
  }
  /* 字幕与画面共用同一份 rows（每镜第一格的 `at` 就是这一镜的成片起点）；
     黑场行也挂在 gap 里 —— 黑场只是没有画面，字幕照样要出现。 */
  const sub = fcpxmlTitles({ rows, shots, styleOf, size, t, xe, voices: voicesEnsure() });
  const dbOf = vol => {
    const v = Math.max(0, Number(vol) || 0);
    return v <= 0 ? '-96dB' : (20 * Math.log10(v)).toFixed(1) + 'dB';
  };
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE fcpxml>');
  out.push('<!-- 导出拾帧「' + noteSafe((proj && proj.name) || '未命名短片') + '」时间线 · '
    + new Date().toLocaleString('zh-CN') + ' -->');
  if (missing.length) {
    out.push('<!-- 本机没有可用文件的素材（导入 FCP 后会显示离线；请补到与 FCPXML 同级的 media/ 目录，或重新链接）：');
    missing.slice(0, 60).forEach(x => out.push('     - ' + noteSafe(x.name) + (x.src ? '：' + noteSafe(x.src) : '')));
    if (missing.length > 60) out.push('     …另有 ' + (missing.length - 60) + ' 条');
    out.push('-->');
  }
  /* 黑场上的配音：FCPXML 的 gap 不能挂子元素 → 把每句写成独立的 <asset-clip lane="1">，
     offset 用它在成片时间线上的绝对秒，落在 gap 上方（导入后位置不变）。 */
  const grayClips = [];
  grayVoices.forEach(gv => {
    const v = gv.v;
    const media = mediaOf(v.src, 'audio', { shot: null, voice: v, idx: grayClips.length });
    const ref = assetFor(media, (Number(v.off) || 0) + (Number(v.dur) || 0) + 1, 'audio');
    const dur = Math.max(0.1, (Number(v.dur) || 0) / (gv.vr || 1));
    grayClips.push({ ref, media, absAt: gv.absAt, start: Math.max(0, Number(v.off) || 0),
      srcDur: Math.max(0.1, Number(v.dur) || 0), dur, vol: voiceVolOf(v), name: v.text || v.name || '配音' });
  });
  if (sub.warnings.length) {
    out.push('<!-- 字幕提醒（一条都没有静默丢：下面逐条写明原因）：');
    sub.warnings.forEach(w => out.push('     - ' + noteSafe(w)));
    out.push('-->');
  }
  out.push('<fcpxml version="1.10">');
  out.push('  <resources>');
  out.push('    <format id="r1" name="FFVideoFormat' + size.w + 'x' + size.h + 'p' + FR + '" frameDuration="1/' + FR
    + 's" width="' + size.w + '" height="' + size.h + '"/>');
  if (sub.counts.titles) out.push('    <effect id="r_title" name="Basic Title" uid="' + BASIC_TITLE_UID + '"/>');
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
  out.push('      <project name="' + xe((proj && proj.name) || '未命名短片') + '">');
  out.push('        <sequence format="r1" duration="' + t(at) + '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">');
  out.push('          <spine>');
  rows.forEach((row, i) => {
    const c = row.c;
    const titles = sub.byRow.get(i) || [];
    if (!row.ref) {
      const gname = '黑场' + (c.name ? ' · ' + xe(c.name) : '');
      if (!titles.length) {
        out.push('            <gap name="' + gname + '" offset="' + t(row.at) + '" duration="' + t(row.dur) + '"/>');
      } else {
        out.push('            <gap name="' + gname + '" offset="' + t(row.at) + '" duration="' + t(row.dur) + '">');
        titles.forEach(x => out.push(x));
        out.push('            </gap>');
      }
      return;
    }
    const srcDur = Math.max(0.1, (Number(c.out) || 0) - (Number(c.in) || 0));
    const sp = Math.max(0.25, Math.min(4, Number(c.speed) || 1));
    /* 图片段：`in/out` 是虚拟坐标，写进 FCPXML 没有意义 —— still 的起点恒为 0、整段就是这一张图，
       也就没有倍速（没有 timeMap）与原声音量。 */
    const still = !!row.still;
    /* 片段显示名带场景与镜头（与素材文件名同源）：FCP / 达芬奇的时间线里一眼看得出是哪一镜。 */
    const label = row.sctx ? clipLabel(row.sctx, (Number(c.seg) || 0) + 1) : (c.name || ('镜头 ' + (i + 1)));
    out.push('            <asset-clip ref="' + row.ref + '" name="' + xe(still && c.imgName ? c.imgName : label)
      + '" offset="' + t(row.at) + '" start="' + t(still ? 0 : c.in) + '" duration="' + t(row.dur) + '" tcFormat="NDF">');
    if (!still && Math.abs(sp - 1) > 0.001) {
      out.push('              <timeMap>');
      out.push('                <timept time="0s" value="0s" interp="linear"/>');
      out.push('                <timept time="' + t(row.dur) + '" value="' + t(srcDur) + '" interp="linear"/>');
      out.push('              </timeMap>');
    }
    const pv = Number(c.volume == null ? 1 : c.volume);
    if (!still && Math.abs(pv - 1) > 0.001) out.push('              <adjust-volume amount="' + dbOf(pv) + '"/>');
    row.voices.forEach((v, k) => {
      out.push('              <asset-clip ref="' + v.ref + '" lane="-' + (1 + (k % 4)) + '" name="' + xe(v.name)
        + '" offset="' + t(v.offset) + '" start="' + t(v.start) + '" duration="' + t(v.dur)
        + '" audioRole="dialogue" tcFormat="NDF">');
      if (Math.abs(v.srcDur - v.dur) > 0.01) {
        out.push('                <timeMap>');
        out.push('                  <timept time="0s" value="0s" interp="linear"/>');
        out.push('                  <timept time="' + t(v.dur) + '" value="' + t(v.srcDur) + '" interp="linear"/>');
        out.push('                </timeMap>');
      }
      if (Math.abs(Number(v.vol) - 1) > 0.001) out.push('                <adjust-volume amount="' + dbOf(v.vol) + '"/>');
      out.push('              </asset-clip>');
    });
    /* 字幕挂在这一镜的 asset-clip 里：offset 相对这一格的起点，lane 从正 1 起算 */
    titles.forEach(x => out.push(x));
    out.push('            </asset-clip>');
  });
  /* 黑场上的配音作为独立 asset-clip 挂在 lane="1"（正数 lane = 在主轨上方）：
     FCPXML 的 gap 不能挂子元素，这样写导入后位置不变。 */
  grayClips.forEach((gv, gi) => {
    out.push('            <asset-clip ref="' + gv.ref + '" lane="1" name="' + xe(gv.name)
      + '" offset="' + t(gv.absAt) + '" start="' + t(gv.start) + '" duration="' + t(gv.dur)
      + '" audioRole="dialogue" tcFormat="NDF">');
    if (Math.abs(gv.srcDur - gv.dur) > 0.01) {
      out.push('              <timeMap>');
      out.push('                <timept time="0s" value="0s" interp="linear"/>');
      out.push('                <timept time="' + t(gv.dur) + '" value="' + t(gv.srcDur) + '" interp="linear"/>');
      out.push('              </timeMap>');
    }
    if (Math.abs(Number(gv.vol) - 1) > 0.001) out.push('              <adjust-volume amount="' + dbOf(gv.vol) + '"/>');
    out.push('            </asset-clip>');
  });
  out.push('          </spine>');
  out.push('        </sequence>');
  out.push('      </project>');
  out.push('    </event>');
  out.push('  </library>');
  out.push('</fcpxml>');
  const xml = out.join('\n');
  const vCount = rows.reduce((a, r) => a + r.voices.length, 0);
  return { ok: true, xml, srt: sub.srt, subtitles: sub.counts.titles, warnings: sub.warnings,
    bundleAssets, missing, grayVoices, rows: rows.length, voices: vCount };
}

/* 下载 .fcpxml 或媒体包 zip。按钮禁用与状态行都在这一层收口。 */
export async function exportFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { setStatus, el, Net } = ctx;
  const btn = el(bundle ? 'exportFcpBundle' : 'exportFcp');
  const btn2 = el(bundle ? 'exportFcp' : 'exportFcpBundle');
  if (btn) btn.disabled = true;
  if (btn2) btn2.disabled = true;
  try {
    const r = await buildFCPXML(ctx, { bundle });
    if (!r || !r.ok) return r;
    const baseName = window.fileSafe((ctx.proj && ctx.proj.name) || '时间线', 60) + '-FCPXML-' + window.fileStamp();
    const extra = (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条' : '')
      + (r.grayVoices.length ? ' · ' + r.grayVoices.length + ' 句压在黑场上的配音没带（gap 挂不了音频）' : '')
      + (r.warnings.length ? ' · 字幕提醒 ' + r.warnings.length + ' 条（文件开头有注释）' : '');
    if (bundle) {
      setStatus('<span class="hint">正在打包 FCPXML 与素材…</span>');
      const zip = await Net.blob('/fcpxml/bundle', {
        method: 'POST', timeout: 10 * 60 * 1000, retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fcpxml: r.xml, srt: r.subtitles ? r.srt : '', assets: r.bundleAssets }),
      });
      await window.Net.save(zip, baseName + '-媒体包.zip');
      setStatus('<span class="ok">✓ 已导出媒体包：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音 · '
        + r.bundleAssets.length + ' 份素材（zip 里是 project.fcpxml + media/，换台机器直接导入）'
        + (r.subtitles ? ' · 字幕 ' + r.subtitles + ' 条（时间线标题 + subtitles.srt）' : '')
        + (r.missing.length ? ' · ' + r.missing.length + ' 处取不到本机文件，名单在 missing.txt' : '')
        + extra + '</span>');
      return { ok: true, bundle: true, rows: r.rows, voices: r.voices,
        subtitles: r.subtitles, assets: r.bundleAssets.length,
        missing: r.missing.length, grayVoices: r.grayVoices.length, warnings: r.warnings };
    }
    await window.Net.save(new Blob([r.xml], { type: 'application/xml' }), baseName + '.fcpxml');
    setStatus('<span class="ok">✓ 已导出 FCPXML：' + r.rows + ' 段画面 · ' + r.voices + ' 句配音'
      + (r.missing.length ? ' · ' + r.missing.length + ' 处本机没有文件（清单在文件开头，补到 media/ 或重新链接）' : '')
      + extra + '</span>');
    return { ok: true, bundle: false, rows: r.rows, voices: r.voices,
      subtitles: r.subtitles, missing: r.missing.length,
      grayVoices: r.grayVoices.length, warnings: r.warnings };
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
