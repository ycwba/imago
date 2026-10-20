/* FCPXML 导出：把当前时间线写成 Final Cut Pro / 达芬奇可导入的 XML，或 project.fcpxml + media/ 和
   subtitles.srt 的媒体包。只读：不修改任何工程数据。时间线相关的函数与状态由引擎按 ctx 传进来。 */
import { fcpxmlTitles, BASIC_TITLE_UID } from './subtitles.js';
import { escHTML } from './util.js';

export async function exportFCPXML(ctx, opts) {
  const bundle = !!(opts && opts.bundle);
  const { tlSyncFromShots, healStaleUrls, filmSize, setStatus, el, tlClipDur, tlClipSrc, allShots, tlCandidateOf, candDur, voicesEnsure, voiceVolOf, styleOf, AssetLocal, Api, Net } = ctx;
  const proj = ctx.proj;
  const tl = tlSyncFromShots();
  if (!tl.clips.length) {
    setStatus('<span class="err">现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面</span>');
    return;
  }
  const btn = el(bundle ? 'exportFcpBundle' : 'exportFcp');
  const btn2 = el(bundle ? 'exportFcp' : 'exportFcpBundle');
  if (btn) btn.disabled = true;
  if (btn2) btn2.disabled = true;
  try {
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
    const fileUrl = p => {
      const s = String(p || '').replace(/\\/g, '/');
      if (!s) return '';
      if (/^file:/i.test(s)) return s;
      if (/^[A-Za-z]:\//.test(s) || s.startsWith('/')) {
        const tail = encodeURI(s.replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F');
        return 'file:///' + tail;
      }
      return s;
    };
    const missing = [], grayVoices = [], bundleAssets = [];
    const assets = new Map();
    let nextRid = 2;
    function mediaOf(src, kind, c, idx) {
      const isAudio = kind === 'audio';
      const fallback = isAudio
        ? ((String(src || '').match(/\.(wav|mp3|m4a|aac|ogg|flac)(?:\?|$)/i) || [])[1] || 'wav')
        : ((String((c && c.format) || '').match(/^(mp4|mov|webm|mkv)$/i) || [])[1] || 'mp4');
      const f = window.AssetLocal && AssetLocal.localFileOf ? AssetLocal.localFileOf(src) : null;
      const la = (f && f.id) || ((/^\/asset\/(la_[A-Za-z0-9_-]+)/.exec(String(src || '')) || [])[1]);
      if (la && assetsDir) {
        const ext = String((f && f.format) || fallback).toLowerCase();
        if (bundle) {
          /* 媒体包里的 XML 只写相对路径：整包换一台机器也能直接导入，不用重新链接。 */
          const bn = (window.fileSafe((f && f.name) || (c && c.name) || '素材', 48) || '素材') + '-' + (idx + 1) + '.' + ext;
          bundleAssets.push({ src: Api.assetSrc(la), name: bn });
          return { key: kind + ':la:' + la, name: bn, local: false,
            href: 'media/' + encodeURI(bn).replace(/#/g, '%23').replace(/\?/g, '%3F') };
        }
        const path = assetsDir.replace(/[\\/]+$/, '') + '/' + la + '.' + ext;
        return { key: kind + ':la:' + la, name: window.fileSafe((f && f.name) || (c && c.name) || '素材', 48) || (la + '.' + ext),
          local: true, href: fileUrl(path) };
      }
      const nm = window.fileSafe(((c && c.name) || (isAudio ? '配音' : '素材')) + '-' + (idx + 1), 48) + '.' + fallback;
      if (!/^https?:/i.test(String(src || ''))) missing.push({ name: nm, src: String(src || '') });
      else missing.push({ name: nm, src: String(src || '') });
      if (bundle && /^(?:https?:|\/(?:asset|getv|fetch)\b)/i.test(String(src || ''))) bundleAssets.push({ src: String(src || ''), name: nm });
      return { key: kind + ':u:' + (src || nm), name: nm, local: false,
        href: 'media/' + encodeURI(nm).replace(/#/g, '%23').replace(/\?/g, '%3F') };
    }
    function assetFor(media, dur, kind) {
      const prev = assets.get(media.key);
      if (prev) { prev.duration = Math.max(prev.duration, dur); return prev.id; }
      const id = 'r' + (nextRid++);
      assets.set(media.key, { id, media, kind, duration: Math.max(0.1, dur) });
      return id;
    }
    const rows = [];
    let at = 0;
    for (let i = 0; i < tl.clips.length; i++) {
      const c = tl.clips[i];
      const dur = tlClipDur(c);
      const row = { c, at, dur, voices: [] };
      if (!c.gray) {
        const src = await tlClipSrc(c);
        if (src) {
          const sh = allShots().find(x => x.id === c.shotId);
          const cand = sh ? tlCandidateOf(sh, c.candId) : null;
          const srcDur = cand ? candDur(cand, sh) : Math.max(Number(c.out) || 0, 0.1);
          const media = mediaOf(src, 'video', c, i);
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
        if (!row.ref) { grayVoices.push(v); continue; }
        const sp = Math.max(0.25, Math.min(4, Number(c.speed) || 1));
        const own = Math.max(0.25, Math.min(4, Number(v.spd) || 1));
        const vr = sp * own;
        const media = mediaOf(v.src, 'audio', { name: v.name || v.text || '配音', format: '' }, rows.length * 10 + row.voices.length);
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
    const sub = fcpxmlTitles({ rows, shots: allShots(), styleOf, size, t, xe, voices: voicesEnsure() });
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
    if (grayVoices.length) out.push('<!-- 有 ' + grayVoices.length + ' 句配音压在黑场上：黑场在 FCPXML 里是 gap，音频无法挂到 gap 上，这几句没有导出 -->');
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
      const attrs = a.kind === 'video'
        ? ' hasVideo="1" hasAudio="1" format="r1"'
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
      out.push('            <asset-clip ref="' + row.ref + '" name="' + xe(c.name || ('镜头 ' + (i + 1)))
        + '" offset="' + t(row.at) + '" start="' + t(c.in) + '" duration="' + t(row.dur) + '" tcFormat="NDF">');
      if (Math.abs(sp - 1) > 0.001) {
        out.push('              <timeMap>');
        out.push('                <timept time="0s" value="0s" interp="linear"/>');
        out.push('                <timept time="' + t(row.dur) + '" value="' + t(srcDur) + '" interp="linear"/>');
        out.push('              </timeMap>');
      }
      const pv = Number(c.volume == null ? 1 : c.volume);
      if (Math.abs(pv - 1) > 0.001) out.push('              <adjust-volume amount="' + dbOf(pv) + '"/>');
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
    out.push('          </spine>');
    out.push('        </sequence>');
    out.push('      </project>');
    out.push('    </event>');
    out.push('  </library>');
    out.push('</fcpxml>');
    const xml = out.join('\n');
    const baseName = window.fileSafe((proj && proj.name) || '时间线', 60) + '-FCPXML-' + window.fileStamp();
    const vCount = rows.reduce((a, r) => a + r.voices.length, 0);
    if (bundle) {
      setStatus('<span class="hint">正在打包 FCPXML 与素材…</span>');
      const zip = await Net.blob('/fcpxml/bundle', {
        method: 'POST', timeout: 10 * 60 * 1000, retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fcpxml: xml, srt: sub.counts.titles ? sub.srt : '', assets: bundleAssets }),
      });
      await window.Net.save(zip, baseName + '-媒体包.zip');
      setStatus('<span class="ok">✓ 已导出媒体包：' + rows.length + ' 段画面 · ' + vCount + ' 句配音 · '
        + bundleAssets.length + ' 份素材（zip 里是 project.fcpxml + media/，换台机器直接导入）'
        + (sub.counts.titles ? ' · 字幕 ' + sub.counts.titles + ' 条（时间线标题 + subtitles.srt）' : '')
        + (missing.length ? ' · ' + missing.length + ' 处取不到文件，名单在 missing.txt' : '')
        + (grayVoices.length ? ' · ' + grayVoices.length + ' 句压在黑场上的配音没带' : '')
        + (sub.warnings.length ? ' · 字幕提醒 ' + sub.warnings.length + ' 条（文件开头有注释）' : '')
        + '</span>');
      return { ok: true, bundle: true, rows: rows.length, voices: vCount,
        subtitles: sub.counts.titles, assets: bundleAssets.length,
        missing: missing.length, grayVoices: grayVoices.length, warnings: sub.warnings };
    } else {
      await window.Net.save(new Blob([xml], { type: 'application/xml' }), baseName + '.fcpxml');
      setStatus('<span class="ok">✓ 已导出 FCPXML：' + rows.length + ' 段画面 · ' + vCount + ' 句配音'
        + (sub.counts.titles ? ' · 字幕 ' + sub.counts.titles + ' 条' : '')
        + (missing.length ? ' · ' + missing.length + ' 处本机没有文件（清单在文件开头，补到 media/ 或重新链接）' : '')
        + (grayVoices.length ? ' · ' + grayVoices.length + ' 句压在黑场上的配音没带（gap 挂不了音频）' : '')
        + (sub.warnings.length ? ' · 字幕提醒 ' + sub.warnings.length + ' 条（文件开头有注释）' : '')
        + '</span>');
      return { ok: true, bundle: false, rows: rows.length, voices: vCount,
        subtitles: sub.counts.titles, missing: missing.length,
        grayVoices: grayVoices.length, warnings: sub.warnings };
    }
  } catch (e) {
    setStatus('<span class="err">导出 FCPXML 失败：' + errText(e) + '</span>');
    return { ok: false, err: errText(e)};
  } finally {
    if (btn) btn.disabled = false;
    if (btn2) btn2.disabled = false;
  }
}
