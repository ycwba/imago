/* 导演台Bridge域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createBridge(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1, spdTxt } from '../util.js';
import { segLen, segVol, segSpd, segFilmLen, segsOf, segsWrite, picLnOf } from '../segments.js';
import { chosenCandOf, currentOf, entriesFromShot, setStyle, srtParse, srtSerialize, resegment, filmOf, mapToFilm, mapToShot, mapFromFilm, filmEntriesOf, filmSpanOf } from '../subtitles.js';

export function createBridge(E, document, window) {
  const {
    ExportFormats,
    TlPlay,
    projOf,
    allShots,
    curScene,
    curShot,
    fmtDur,
    undoStack,
    redoStack,
    UNDO_MAX_BYTES,
    UNDO_MAX_COUNT,
    undoBytesOf,
    undoSkipWhyOf,
    lastUndoLabelOf,
    beginEdit,
    undo,
    redo,
    candDur,
    voicesEnsure,
    reanchorVoices,
    cutSegs,
    rowLockWhy,
    tlSyncFromShots,
    renderStatus,
    filmEdited,
    shotFilmAt,
    filmRowsForSubtitles,
    subWriteData,
    candTrackSrc,
    mediaInfo,
    renderAll,
    setStatus,
    Export,
  } = E;

(function () {
  const READY = () => { try { return !!(projOf() && projOf().scenes && allShots().length); } catch (e) { return false; } };
  /* 前台判据只有公共层那一份（core/activity.js，外壳挂在 window.__spaActivity）。
     这里原来只看路由：整个标签页切到后台时照样为真，助手就能在用户看不见的时候动时间线。 */
  const ACTIVE = () => {
    try { return window.__spaActivity.visible('director.html'); }
    catch (e) { return true; }
  };
  const capTxt = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const loose = msg => ({ ok: false, err: msg });
  const dirLockOf = seg => {
    try {
      const why = rowLockWhy('pic', picLnOf(seg));
      return why ? (why + '：这一段所在的行锁着，助手不改。先在导演台解锁再试。') : '';
    } catch (e) { return ''; }
  };
  function shotOf(a) {
    a = a || {};
    if (a.shotId != null && a.shotId !== '') {
      for (const sc of projOf().scenes) {
        const hit = (sc.shots || []).find(x => String(x.id) === String(a.shotId));
        if (hit) return { sc, sh: hit };
      }
      return loose('找不到镜头 id「' + a.shotId + '」——先用 page_state / 当前界面快照看这一镜的 id');
    }
    if (a.shot != null) {
      const sc = (a.scene != null) ? projOf().scenes[Number(a.scene) - 1] : (projOf().scenes[projOf().curScene] || projOf().scenes[0]);
      if (!sc) return loose('找不到第 ' + a.scene + ' 个场景');
      const n = Number(a.shot);
      if (!Number.isInteger(n) || n < 1 || n > (sc.shots || []).length) {
        return loose('「' + sc.name + '」里没有第 ' + a.shot + ' 镜（一共 ' + (sc.shots || []).length + ' 镜）');
      }
      return { sc, sh: sc.shots[n - 1] };
    }
    const sc = curScene(), sh = curShot();
    return sh ? { sc, sh } : loose('当前没有镜头');
  }
  function candOf(sh, a, mode) {
    a = a || {};
    const list = sh.candidates || [];
    if (!list.length) return loose('「' + sh.name + '」还没有候选：先生成或导入一条视频');
    let i = -1;
    if (a.take != null) {
      const n = Number(a.take);
      if (!Number.isInteger(n) || n < 1 || n > list.length) {
        return loose('take 是第几条候选（1–' + list.length + '），给的是「' + a.take + '」');
      }
      i = n - 1;
    } else if (a.candId != null && a.candId !== '') {
      i = list.findIndex(c => String(c.vid) === String(a.candId));
      if (i < 0) {
        return loose('这一镜没有候选 id「' + a.candId + '」。现有：'
          + list.map((c, k) => '第' + (k + 1) + '条 ' + c.vid).join(' / '));
      }
    } else if (mode === 'selected') {
      i = list.findIndex(c => c.vid === sh.selId);
    }
    if (i < 0) i = Math.max(0, Math.min(list.length - 1, Number(projOf().curCand) || 0));
    return { i, c: list[i], list };
  }
  const hasPic = c => !!(c && c.status === 'succeeded' && c.url);
  function focus(sc, sh, ci) {
    const si = projOf().scenes.indexOf(sc), xi = (sc.shots || []).indexOf(sh);
    if (si >= 0) projOf().curScene = si;
    if (xi >= 0) projOf().curShot = xi;
    if (ci != null) projOf().curCand = Math.max(0, Math.min(ci, (sh.candidates || []).length - 1));
  }
  function selectPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) {
      return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条现在还不能选用（状态：'
        + (q.c.status || '未知') + '，没有可播放地址）。等它出了画面再选');
    }
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, already: s.sh.selId === q.c.vid };
  }
  const WAY_ZH = { split: '切开', left: '切掉插针左边', right: '切掉插针右边', drop: '删成黑场', merge: '融合相邻两段' };
  function cutPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条还没出画面（状态：' + (q.c.status || '未知') + '），剪不了');
    const total = candDur(q.c, s.sh);
    const segs = segsOf(q.c, total);
    if (!segs.length) return loose('这一条现在一段画面都没有：先在导演台按 Ctrl+Z 退回剪切之前，或换一条候选');
    const way = String(a.way || '').trim();
    if (!WAY_ZH[way]) return loose('way 只能是 split / left / right / drop / merge');
    let at = null, segNo = null;
    if (a.seg != null) {
      const n = Number(a.seg);
      if (!Number.isInteger(n) || n < 1 || n > segs.length) return loose('seg 是第几段（1–' + segs.length + '），给的是「' + a.seg + '」');
      segNo = n; at = (Number(segs[n - 1].in) + Number(segs[n - 1].out)) / 2;
    } else if (a.at != null) {
      at = Number(a.at);
      if (!Number.isFinite(at)) return loose('at 要是秒数（源视频的第几秒）');
    } else if (way === 'drop' || way === 'merge') {
      const n = Math.min(segs.length, Math.max(1, (Number(projOf().cutSeg) || 0) + 1));
      segNo = n; at = (Number(segs[n - 1].in) + Number(segs[n - 1].out)) / 2;
    } else {
      return loose('切哪一秒要说清：给 at（源视频的第几秒）或 seg（第几段）');
    }
    /* 尺子的右端不是 `total`：图片段与图片区空段排在视频源秒之后，各占自己的虚拟秒
       （见 image-seg.js）。拿 `total` 去夹，落在图片段上的那几秒会被推回视频末尾 ——
       `seg` 取中点的那条路（图片段的中点必然 > total）会直接报「at 要在 0–N 秒之间」，
       于是助手永远剪不到图片段。与 `cutPin` 的夹法同一份边界。 */
    const pan = round1(segs.reduce((m, s) => Math.max(m, Number(s.b) || 0), total));
    if (at < 0 || at > pan) return loose('at 要在 0–' + pan + ' 秒之间（这一条视频 ' + round1(total) + ' 秒'
      + (pan > total + 0.05 ? '，图片段 / 空段另占虚拟秒' : '') + '）');
    at = round1(Math.max(0, Math.min(pan, at)));
    let i = segs.findIndex(x => at >= x.in && at < x.out);
    if (i < 0) i = segs.reduce((b, x, k) => (Math.abs(x.in - at) < Math.abs(segs[b].in - at) ? k : b), 0);
    const lock = dirLockOf(segs[i]);
    if (lock) return loose(lock);
    const r = cutSegs(q.c, total, at, way);
    if (r.err) return loose(r.err);
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, segNo, seg: segs[i], segs, at, way, total, out: r };
  }
  function cutResultText(p, newSegs, moved) {
    const after = newSegs.reduce((a, s) => a + segFilmLen(s), 0);
    const inFilm = p.sh.selId === p.c.vid;
    const what = p.way === 'split' ? '在 ' + p.at + ' 秒处切开'
      : p.way === 'left' ? '把插针左边切掉'
      : p.way === 'right' ? '把插针右边切掉'
      : p.way === 'drop' ? (p.out.back ? '把这一段画面放回来' : '把这一段画面删成黑场（格子留在原位）')
      : '把相邻两段融合回一段';
    return '已在「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选上' + what
      + '：现在 ' + newSegs.length + ' 段、这一条共 ' + round1(after) + ' 秒'
      + (inFilm ? '（这一条正被选用，成片跟着变）' : '（这一条还没被选用，成片仍按选用的那条算）')
      + (moved ? '；有 ' + moved + ' 句配音正好被切掉，已挪到紧随其后的那段开头' : '')
      + '。要退回就说「撤销最近一步」。';
  }
  function setPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const q = candOf(s.sh, a, 'selected'); if (q.err) return q;
    if (!hasPic(q.c)) return loose('「' + s.sh.name + '」第 ' + (q.i + 1) + ' 条还没出画面，改不了');
    const total = candDur(q.c, s.sh);
    const segs = segsOf(q.c, total);
    if (!segs.length) return loose('这一条现在一段画面都没有，改不了');
    let i;
    if (a.seg != null) {
      const n = Number(a.seg);
      if (!Number.isInteger(n) || n < 1 || n > segs.length) return loose('seg 是第几段（1–' + segs.length + '）');
      i = n - 1;
    } else if (a.at != null) {
      const at = Number(a.at);
      i = segs.findIndex(x => at >= x.in && at < x.out);
      if (i < 0) return loose('at 不在任何一段里（这一条 0–' + round1(total) + ' 秒）');
    } else {
      i = Math.max(0, Math.min(segs.length - 1, Number(projOf().cutSeg) || 0));
    }
    const lock = dirLockOf(segs[i]);
    if (lock) return loose(lock);
    const next = {};
    if (a.speed != null) {
      const v = Number(a.speed);
      if (!Number.isFinite(v) || v < 0.25 || v > 4) return loose('speed 要在 0.25–4 之间（1 = 原速）');
      next.speed = Math.round(v * 100) / 100;
    }
    if (a.volume != null) {
      const v = Number(a.volume);
      if (!Number.isFinite(v) || v < 0 || v > 2) return loose('volume 要在 0–2 之间（1 = 原声，百分比请除以 100）');
      next.volume = Math.round(v * 100) / 100;
    }
    if (a.gray != null) next.gray = !!a.gray;
    if (!Object.keys(next).length) return loose('要改什么没说：speed（0.25–4）/ volume（0–2）/ gray（true=黑场）至少给一项');
    return { sc: s.sc, sh: s.sh, c: q.c, i: q.i, segs, seg: segs[i], total, next };
  }
  function setResultText(p, segNo, seg) {
    const bits = [];
    if (p.next.speed != null) bits.push('倍速 ' + spdTxt(segSpd(seg)));
    if (p.next.volume != null) bits.push('原声 ' + Math.round(segVol(seg) * 100) + '%');
    if (p.next.gray != null) bits.push(seg.off ? '这一段是黑场' : '这一段有画面');
    return '已改「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选的第 ' + segNo
      + ' 段：' + bits.join(' · ') + '（这一条现在 ' + p.segs.length + ' 段）。要退回就说「撤销最近一步」。';
  }
  function undoPlan(a) {
    a = a || {};
    const mode = String(a.mode || 'undo') === 'redo' ? 'redo' : 'undo';
    const steps = Math.max(1, Math.min(5, Number(a.steps) || 1));
    const n = mode === 'redo' ? redoStack.length : undoStack.length;
    if (!n) {
      return loose(mode === 'redo' ? '没有可重做的操作' : ('可撤销的已经用完了' + (undoSkipWhyOf() ? '（' + undoSkipWhyOf() + '）' : '')));
    }
    return { mode, steps: Math.min(steps, n), n };
  }

  /* ---------- 字幕：桥这一侧的 check / run（数据层仍是 sh.subtitle 那一份源秒） ----------
     `set {kind:'subtitle'}` 三个内容档互斥：entries（源秒条目）/ text（SRT 成片秒）/
     maxChars（按字数重切）；style 可以与其中任意一档同时给。所有入口都落回
     `subWriteData` → `filmEdited`，不另写一份字幕账。 */
  const SUB_STYLE_KEYS = ['fontFamily', 'fontSize', 'color', 'position', 'maxCharsPerEntry', 'highlight'];
  const SUB_POS = ['bottom', 'middle', 'top'];
  const HEX6 = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  function stylePatchOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: 'style 要是一个对象：{fontSize, color, position, maxCharsPerEntry, highlight, fontFamily}' };
    }
    const patch = {};
    for (const k of Object.keys(raw)) {
      if (!SUB_STYLE_KEYS.includes(k)) return { err: 'style 里不认识「' + k + '」；能改的只有 ' + SUB_STYLE_KEYS.join(' / ') };
    }
    if (raw.fontSize != null) {
      const v = Number(raw.fontSize);
      if (!Number.isFinite(v) || v < 12 || v > 300) return { err: 'fontSize 要在 12–300 之间（1080p 下的像素）' };
      patch.fontSize = Math.round(v);
    }
    if (raw.color != null) {
      if (!HEX6.test(String(raw.color).trim())) return { err: 'color 要是 #RRGGBB 或 #RGB' };
      patch.color = String(raw.color).trim().toUpperCase();
    }
    if (raw.position != null) {
      if (!SUB_POS.includes(raw.position)) return { err: 'position 只能是 bottom / middle / top' };
      patch.position = raw.position;
    }
    if (raw.maxCharsPerEntry != null) {
      const v = Number(raw.maxCharsPerEntry);
      if (!Number.isInteger(v) || v < 8 || v > 120) return { err: 'maxCharsPerEntry 要在 8–120 之间（整数）' };
      patch.maxCharsPerEntry = v;
    }
    if (raw.highlight != null) patch.highlight = !!raw.highlight;
    if (raw.fontFamily != null) {
      const v = String(raw.fontFamily).replace(/\s+/g, ' ').trim();
      if (!v) return { err: 'fontFamily 不能是空串' };
      patch.fontFamily = v.slice(0, 60);
    }
    return { patch };
  }
  /* 助手给的 entries 一律是**候选源秒**（startMs/endMs）；也接受 start/end 秒数写法，
     但只在这两个字段缺省时兜底 —— 不拿「看起来像秒」去猜毫秒。 */
  function subEntriesIn(list, total) {
    if (!Array.isArray(list)) return { err: 'entries 要是数组：[{startMs,endMs,text}]，时间是候选源秒' };
    if (list.length > 5000) return { err: '字幕一次最多 5000 条' };
    const out = [];
    let last = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { err: '第 ' + (i + 1) + ' 条字幕不是对象' };
      const text = String(e.text == null ? '' : e.text).replace(/\r\n?/g, '\n').trim();
      if (!text) return { err: '第 ' + (i + 1) + ' 条字幕没有文字' };
      if (text.length > 2000) return { err: '第 ' + (i + 1) + ' 条字幕超过 2000 字（这么长的一行在画面上放不下）' };
      let a = e.startMs, b = e.endMs;
      if (a == null && e.start != null) a = Number(e.start) * 1000;
      if (b == null && e.end != null) b = Number(e.end) * 1000;
      a = Number(a); b = Number(b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { err: '第 ' + (i + 1) + ' 条字幕的 startMs/endMs 不是数字' };
      if (b <= a) return { err: '第 ' + (i + 1) + ' 条字幕的 endMs 必须大于 startMs' };
      if (a < 0 || b > total * 1000 + 1) {
        return { err: '第 ' + (i + 1) + ' 条字幕落在候选源时间轴之外（这一条 0–' + round1(total) + ' 秒，源秒不是成片秒）' };
      }
      if (a < last) return { err: '字幕要按 startMs 从小到大排（第 ' + (i + 1) + ' 条比上一条更早）' };
      last = a;
      const rec = { startMs: Math.round(a), endMs: Math.round(b), text, src: e.src === 'asr' ? 'asr' : 'manual' };
      if (e.seg != null) {
        const sg = Number(e.seg);
        if (Number.isInteger(sg) && sg >= 1) rec.seg = sg - 1;
      }
      if (e.voiceKey != null) rec.voiceKey = String(e.voiceKey).slice(0, 120);
      out.push(rec);
    }
    return { entries: out };
  }
  function subClampWarn(sh, c, total, entries) {
    const segs = segsOf(c, total);
    const inSeg = sec => segs.some(s => sec >= (Number(s.in) || 0) - 0.001 && sec <= (Number(s.out) || 0) + 0.001);
    let n = 0;
    entries.forEach(e => {
      if (!inSeg((Number(e.startMs) || 0) / 1000) || !inSeg((Number(e.endMs) || 0) / 1000)) n++;
    });
    return n ? ['有 ' + n + ' 条字幕落在已经剪掉的源区间上，预览/导出时会夹到最近的画面边界'] : [];
  }
  function subPlan(a) {
    a = a || {};
    const s = shotOf(a); if (s.err) return s;
    const sh = s.sh;
    if (a.take != null) {
      const q = candOf(sh, a, 'selected'); if (q.err) return q;
      if (q.c.vid !== sh.selId) {
        return loose('字幕跟着「选用」的那条候选走：先把「' + capTxt(sh.name, 30) + '」第 ' + (q.i + 1) + ' 条设为选用，再改字幕');
      }
    }
    const c = chosenCandOf(sh);
    if (!c) return loose('「' + capTxt(sh.name, 30) + '」还没有选用候选：字幕的源秒/成片秒都要按选用那条换算，先在导演台选一条');
    const total = candDur(c, sh);
    const cur = currentOf(sh, voicesRead());
    const wantEntries = a.entries !== undefined;
    const wantText = typeof a.text === 'string' && !!a.text.trim();
    const wantReseg = a.maxChars !== undefined;
    if ((wantEntries ? 1 : 0) + (wantText ? 1 : 0) + (wantReseg ? 1 : 0) > 1) {
      return loose('一次只做一件内容改动：entries / text（SRT）/ maxChars 三选一（style 可以同时给）');
    }
    let stylePatch = null;
    if (a.style !== undefined) {
      const r = stylePatchOf(a.style);
      if (r.err) return loose(r.err);
      stylePatch = r.patch;
    }
    let entries = null, source = '', mode = '', warnings = [], maxChars = null;
    if (wantText) {
      const parsed = srtParse(a.text);
      if (!parsed.length) return loose('这段 SRT 没解析出字幕（检查时间行是不是 00:00:00,000 --> 00:00:02,000）');
      if (parsed.length > 5000) return loose('这段 SRT 有 ' + parsed.length + ' 条，超过 5000 条上限');
      const shotAt = shotFilmAt(sh);
      if (shotAt == null) return loose('「' + capTxt(sh.name, 30) + '」还没进成片（没有选用候选 / 画面全被剪掉），SRT 的成片秒折不回源秒');
      const span = filmSpanOf(sh, shotAt, c);
      const inSpan = parsed.filter(e => {
        const at = (Number(e.startMs) || 0) / 1000;
        return at >= shotAt - 0.001 && at < shotAt + span + 0.001;
      });
      if (!inSpan.length) {
        return loose('这段 SRT 里没有落在本镜的字幕（本镜在成片里是 ' + fmtDur(shotAt) + '–' + fmtDur(shotAt + span) + '）');
      }
      const mapped = mapFromFilm(sh, shotAt, inSpan, { cand: c });
      if (!mapped.length) return loose('落在本镜的那 ' + inSpan.length + ' 条折回源秒后是空的');
      entries = mapped; source = 'manual'; mode = 'import_srt';
      if (inSpan.length < parsed.length) warnings.push((parsed.length - inSpan.length) + ' 条不在本镜，没有导入');
      if (parsed.skipped) warnings.push(parsed.skipped + ' 块格式不对，已跳过');
    } else if (wantEntries) {
      const r = subEntriesIn(a.entries, total);
      if (r.err) return loose(r.err);
      entries = r.entries;
      if (a.source === 'asr') source = 'asr';
      else if (a.source != null && a.source !== 'manual') return loose('source 只能是 manual / asr（line+voice 用 source:"line+voice" 且不要给 entries，让编辑器按台词重新派生）');
      else source = 'manual';
      mode = 'update';
    } else if (wantReseg) {
      const lim = Number(a.maxChars);
      if (!Number.isInteger(lim) || lim < 1 || lim > 500) return loose('maxChars 是每行最多几个字（1–500 的整数）');
      const base = a.source === 'line+voice' ? entriesFromShot(sh, voicesRead(), c) : cur.entries;
      if (!base.length) return loose('「' + capTxt(sh.name, 30) + '」现在没有字幕可重切：先用 entries 更新或导入 SRT');
      entries = resegment(base, lim).map(e => Object.assign({}, e, { src: 'manual' }));
      source = 'manual'; mode = 'resegment'; maxChars = lim;
    } else if (a.source === 'line+voice') {
      entries = entriesFromShot(sh, voicesRead(), c);
      if (!entries.length) return loose('这一镜没有可派生字幕的台词或配音：先写台词，或在配音轨上合成一句');
      source = 'line+voice'; mode = 'generate';
    } else if (!stylePatch) {
      return loose('要改字幕的什么没说：entries（源秒条目）/ style（样式）/ maxChars（按字数重切）/ text（SRT），或 source:"line+voice" 重新生成');
    } else {
      mode = 'style';
    }
    if (entries) warnings = warnings.concat(subClampWarn(sh, c, total, entries));
    if (cur.stale && (mode === 'update' || mode === 'import_srt')) {
      warnings.push('这一镜的台词/配音或选用候选已经变过（旧字幕标着 stale），这次写入会以你给的这一份为准');
    }
    return { sc: s.sc, sh, c, total, cur, entries, stylePatch, source, mode, warnings, maxChars };
  }
  function subResultText(p, sub) {
    const n = p.entries ? p.entries.length : p.cur.entries.length;
    let text = '';
    if (p.mode === 'import_srt') text = '已把 SRT 导入「' + capTxt(p.sh.name, 30) + '」：' + n + ' 条（成片秒已折回候选源秒）';
    else if (p.mode === 'resegment') text = '已把「' + capTxt(p.sh.name, 30) + '」的字幕按每行 ' + p.maxChars + ' 字重切成 ' + n + ' 条';
    else if (p.mode === 'generate') text = '已按台词/配音在「' + capTxt(p.sh.name, 30) + '」重新生成 ' + n + ' 条字幕';
    else if (p.mode === 'update') text = '已更新「' + capTxt(p.sh.name, 30) + '」的字幕：现在 ' + n + ' 条';
    else text = '已改「' + capTxt(p.sh.name, 30) + '」的字幕样式';
    if (p.stylePatch) text += '（样式：' + Object.keys(p.stylePatch).join(' / ') + '）';
    text += '，数据层是候选源秒';
    if (sub && sub.source === 'line+voice') text += '；这一份跟台词/配音走，之后它们变了会自动跟着重派生';
    text += '。要退回就说「撤销最近一步」。';
    return text;
  }

  /* 修订号 CAS：写动作必须带 expectedRevision（助手在计划生成时冻结的那一份），
     run 时再验一次 —— 用户在两颗按钮之间改了工程就当场拒掉，不拿旧计划去盖。
     同一次批量里后续 op 不验（revision 由引擎自己推进），只验第一条。 */
  function subBatch(a) {
    const b = a && a._batch;
    return b && typeof b === 'object' ? b : null;
  }
  function batchOf(a) {
    const b = subBatch(a);
    return { inBatch: !!b, first: !!(b && b.first), last: !!(b && b.last) };
  }
  /* 批量只在第一条前压一次撤销快照、最后一条后重画一次；中间每一步照常改内存，
     后一条的 `*Plan` 读得到前一条的结果。任一条失败由助手侧调 undo（带 `_rollback`）回滚整批。 */
  function editBegin(a, label) {
    const b = batchOf(a);
    if (!b.inBatch || b.first) beginEdit(label);
    return b;
  }
  function editEnd(a, b) {
    if (!b.inBatch || b.last) filmEdited();
  }
  function revNow() { return Number(projOf() && projOf().rev) || 0; }
  /* 只读路径用的配音清单：不建 proj.voices 字段（voicesEnsure 会往工程里写一个空数组，
     桥上的纯读也就改了工程 —— 快照变、下一次保存多压一步撤销）。 */
  const voicesRead = () => (Array.isArray(projOf().voices) ? projOf().voices : []);
  function revGate(a, op) {
    /* `_rollback` 只认 undo 那一条（批量失败时助手侧的整批回滚，chat-tools.js 的
       timelineApplyRun）：模型往 select / cut / set 的参数里塞一个 _rollback:true
       就能把 revision 校验整个绕过去 —— 参数对象是原样递进来的，得在这里按 op 收口。 */
    if (a && a._rollback && op === 'undo') return null;
    const b = subBatch(a);
    if (b && !b.first) return null;
    const exp = a && a.expectedRevision;
    if (exp == null || exp === '') {
      return loose('写动作缺少 expectedRevision：先用 timeline_get 读一次当前 revision，再原样带上');
    }
    if (Number(exp) !== revNow()) {
      return { ok: false, code: 'revision_mismatch',
        err: '工程在你读取之后又改过（你拿的是 revision ' + Number(exp) + '，现在是 ' + revNow()
          + '）。为避免盖掉你刚做的编辑，这次没有执行：先重新读 timeline_get，再按新状态来一次' };
    }
    return null;
  }
  /* 只读：某一镜的字幕账（源秒 + 成片秒 + 样式 + stale）。`subtitle.list` 与
     `context().字幕` 都读它，不在助手侧另算一套。 */
  function subtitleInfo(a) {
    const s = shotOf(a || {}); if (s.err) return s;
    const sh = s.sh, c = chosenCandOf(sh);
    const cur = currentOf(sh, voicesRead());
    const shotAt = shotFilmAt(sh);
    const list = (sh.candidates || []);
    const ci = c ? list.findIndex(x => x.vid === c.vid) : -1;
    const rows = cur.entries.map(e => {
      const m = shotAt != null ? filmOf(sh, shotAt, e) : null;
      return {
        index: e.index, startMs: e.startMs, endMs: e.endMs, text: e.text, src: e.src,
        段: (Number(e.seg) || 0) + 1,
        成片起: m ? Math.round(m.filmStart * 1000) / 1000 : null,
        成片止: m ? Math.round(m.filmEnd * 1000) / 1000 : null,
        夹过: m ? !!(m.clampedStart || m.clampedEnd) : false,
      };
    });
    const out = {
      镜头: capTxt(sh.name, 30), 镜头id: sh.id,
      候选: ci >= 0 ? ('第 ' + (ci + 1) + ' / ' + list.length + ' 条') : '未选用',
      时间基准: 'source',  // startMs/endMs 是候选源秒；成片起/成片止 是成片秒
      来源: cur.source, 条数: rows.length, 过时: cur.stale, 过时原因: cur.staleWhy || '',
      样式: cur.style, 源指纹: cur.sourceHash,
      在成片里: shotAt != null,
      成片起点: shotAt != null ? round1(shotAt) : null,
      条目: rows.slice(0, 200),
      revision: revNow(),
    };
    if (rows.length > 200) out.说明 = '只列出前 200 条（共 ' + rows.length + ' 条）';
    return out;
  }
  /* 只读：字幕 → SRT 文本。不给 shotId 就是全片（成片秒）；给了就只出那一镜
     （进了成片用成片秒，没进成片用本镜甲板秒，`时间基准` 里写明）。下载仍由页面/助手 UI 完成。 */
  function subtitleSrt(a) {
    const sid = a && a.shotId;
    if (sid != null && sid !== '') {
      const sh = allShots().find(x => String(x.id) === String(sid));
      if (!sh) return loose('没有这个镜头：' + sid);
      const cur = currentOf(sh, voicesRead());
      const shotAt = shotFilmAt(sh);
      const mapped = shotAt != null ? mapToFilm(sh, shotAt, cur.entries) : mapToShot(sh, cur.entries);
      const entries = mapped.map(e => {
        const a0 = e.filmStart != null ? e.filmStart : e.shotStart;
        const b0 = e.filmEnd != null ? e.filmEnd : e.shotEnd;
        return Object.assign({}, e, { startMs: Math.round(a0 * 1000), endMs: Math.round(b0 * 1000) });
      });
      return { ok: true, 镜头: capTxt(sh.name, 30), 条数: entries.length,
        时间基准: shotAt != null ? 'film' : 'shot', 在成片里: shotAt != null,
        text: srtSerialize(entries, { bom: false, crlf: false }), revision: revNow() };
    }
    const { rows } = filmRowsForSubtitles();
    const got = filmEntriesOf(rows, allShots(), voicesRead());
    return {
      ok: true,
      条数: got.entries.length,
      未进成片的镜头: got.missing.map(x => ({ 镜头: capTxt(x.shot.name, 30), 条数: x.count, 原因: x.why === 'nocand' ? '没有选用候选' : '没进成片' })),
      时间基准: 'film', text: srtSerialize(got.entries, { bom: false, crlf: false }), revision: revNow(),
    };
  }

  /* ---------- 媒体 / 转写 / 导出：助手入口（都复用页面已有的那一条实现） ---------- */
  function candSrcOf(a) {
    a = a || {};
    const assetId = String(a.assetId || '').trim();
    if (assetId && !a.take && a.shotId == null && a.shot == null && !a.src) {
      return { src: Api.assetSrc(assetId), sh: null, c: null };
    }
    let sh = null, c = null;
    if (a.take != null || a.shotId != null || a.shot != null || a.shotIndex != null) {
      const s = shotOf(a); if (s.err) return s;
      sh = s.sh;
      const q = candOf(sh, a, 'selected'); if (q.err) return q;
      c = q.c;
    }
    const src = String(a.src || '').trim()
      || (a.assetId ? Api.assetSrc(a.assetId) : '')
      || (c ? candTrackSrc(c) : '');
    if (!src) return loose('要检查哪一条没说：给 take（第几条候选）/ shotId，或 src / assetId');
    return { sh, c, src };
  }
  async function mediaCheck(a) {
    a = a || {};
    const assetId = String(a.assetId || '').trim();
    const q = candSrcOf(a); if (q.err) return q;
    try {
      const info = await mediaInfo(assetId && !a.take && a.shotId == null && a.shot == null && !a.src
        ? { assetId } : { src: q.src });
      return Object.assign({ ok: true, 源: q.src.slice(0, 160),
        镜头: q.sh ? capTxt(q.sh.name, 30) : '', 候选: q.c ? String(q.c.vid).slice(0, 60) : '' }, info);
    } catch (e) { return loose('媒体检查失败：' + errText(e)); }
  }
  /* 帧是给用户看的（助手 UI 画成卡片）；返回值里带 dataURL，工具层负责剥掉再给模型。 */
  async function mediaFrames(a) {
    a = a || {};
    const q = candSrcOf(a); if (q.err) return q;
    let times = Array.isArray(a.times) ? a.times.map(Number).filter(Number.isFinite) : [];
    if (!times.length) {
      const total = q.c ? candDur(q.c, q.sh) : 0;
      if (!(total > 0)) return loose('这一条读不到时长：给 times（秒数组，1–8 个）再取帧');
      const n = Math.max(1, Math.min(8, Number(a.count) || 3));
      times = Array.from({ length: n }, (_, i) => Math.round((total * (i + 0.5) / n) * 100) / 100);
    }
    times = times.map(t => Math.max(0, Math.round(Number(t) * 1000) / 1000));
    if (times.length > 8) return loose('一次最多取 8 帧');
    const out = [];
    for (const sec of times) {
      try {
        out.push({ 秒: sec, dataURL: await Wb.vframe.dataURL(q.src, null, sec, 1280) });
      } catch (e) { out.push({ 秒: sec, 错误: errText(e)}); }
    }
    return { ok: out.some(x => x.dataURL), 镜头: q.sh ? capTxt(q.sh.name, 30) : '',
      候选: q.c ? String(q.c.vid).slice(0, 60) : '', 帧: out };
  }
  async function asrStart(a) {
    a = a || {};
    const q = candSrcOf(a); if (q.err) return q;
    /* dryRun：助手在画确认卡片之前要先把「查哪一份、走哪条路、扣不扣费」说清楚，
       但那一步**不许提交任务**（提交了就是一次真实转写，远程还按次计费）。 */
    if (a.dryRun) {
      /* 路线判定只有 `Asr.pickRoute` 一份（浏览器模型就绪 → 本地运行包 → 在线）：
         在这儿再算一套，就会出现「卡片说在线按次计费、实际在浏览器里免费跑」那种假话。 */
      let st = null; let route = '';
      const want = String(a.route || '');
      try {
        if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
        st = await window.Asr.settings();
        route = await window.Asr.pickRoute(want);
      } catch (e) { /* 读不到转写设置就按「没配」那一档报，dryRun 不是错 */ }
      const s = (st && st.settings) || {};
      const svc = s.service || {};
      const local = !!(st && st.local && st.local.available);
      if (!route) route = ['local', 'service', 'browser'].includes(want || s.route) ? (want || s.route) : (local ? 'local' : 'service');
      const routeZh = (window.Asr && window.Asr.routeLabel) ? window.Asr.routeLabel(route) : route;
      let why = routeZh;
      if (route === 'browser') {
        let ready = false;
        try { const bs = await window.Asr.browserStatus(); ready = !!(bs && bs.complete); }
        catch (e) { /* 问不到模型状态就按没就绪说 */ }
        why += ready ? '；模型已就绪' : '；模型还没下全：首次要先经代理下几百 MB，可能等几分钟，关页就停';
      } else if (route === 'local') {
        why = local ? routeZh + '；本机运行包可用'
          : '路线定在本地，但本地模型不可用：' + ((st && st.local && st.local.why) || '缺少运行包') + '（提交会当场被拒）';
      } else {
        why = routeZh + '：供应商 ' + (svc.providerId || '没选') + ' · 模型 ' + (svc.model || 'whisper-1')
          + (svc.hasKey ? '' : '（这一家还没配密钥时提交会被拒）');
      }
      return { ok: true, 镜头: q.sh ? capTxt(q.sh.name, 30) : '', 源: q.src.slice(0, 160),
        route, routeZh, language: String(a.language || s.language || ''), 会扣费: route === 'service', 说明: why };
    }
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      const r = await window.Asr.transcribe({ src: q.src, language: String(a.language || ''), route: String(a.route || '') });
      const routeZh = (window.Asr && window.Asr.routeLabel) ? window.Asr.routeLabel(r && r.route) : '';
      return Object.assign({ ok: true, 镜头: q.sh ? capTxt(q.sh.name, 30) : '', routeZh,
        源: q.src.slice(0, 160), 说明: '转写路线：' + routeZh + '；用 media_transcription 读结果，不会自动改写台词或字幕' }, r);
    } catch (e) {
      /* 「结果未知」不能写成「提交失败」：maybeSubmitted 标记在这个异常上
         （Net 打的），loose 把它压成纯字符串就丢了 —— 助手与用户都以为没提交，
         重试一次就是第二次扣费（在线转写按次计费）。 */
      const unknown = !!(window.Api && Api.maybeSubmitted && Api.maybeSubmitted(e));
      return loose((unknown ? '提交结果未知（平台可能已受理并计费，先读 asrJob 确认，别急着重提）：' : '提交转写失败：') + errText(e));
    }
  }
  async function asrJob(a) {
    const id = String((a && a.jobId) || '').trim();
    if (!id) return loose('要给 jobId');
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      const j = await window.Asr.job(id);
      return Object.assign({ ok: true }, j);
    } catch (e) { return loose('读不到转写任务：' + errText(e)); }
  }

  /* 助手发起的导出：仍调用页面同一套导出函数（不另写渲染管线），这里只做记录与状态查询。 */
  const expJobs = new Map();
  let expSeq = 0;
  function expNew(format) {
    const id = 'ex_' + Date.now().toString(36) + '_' + (++expSeq);
    const rec = { id, format, state: 'running', at: Date.now(), endedAt: 0,
      progress: 0, renderId: '', out: '', err: '', text: '', counts: null };
    expJobs.set(id, rec);
    while (expJobs.size > 20) expJobs.delete(expJobs.keys().next().value);
    return rec;
  }
  function expView(r) {
    return { id: r.id, format: r.format, state: r.state, progress: Math.round(Number(r.progress) || 0),
      开始: r.at, 结束: r.endedAt || null, 渲染任务: r.renderId || '',
      文件: r.out || '', 说明: r.text || '', 错误: r.err || '',
      ...(r.counts ? { 条数: r.counts } : {}),
      可取消: r.state === 'running' && !!(ExportFormats.of(r.format) || {}).cancelable && !!r.renderId };
  }
  function expSettle(rec, ok, extra) {
    rec.state = ok ? 'done' : (extra && extra.cancelled ? 'canceled' : 'error');
    rec.endedAt = Date.now();
    if (extra) {
      if (extra.err) rec.err = String(extra.err);
      if (extra.text) rec.text = String(extra.text);
      if (extra.out) rec.out = String(extra.out);
      if (extra.renderId) rec.renderId = String(extra.renderId);
    }
    if (!rec.text) rec.text = ok ? '导出完成' : (rec.err || '导出失败');
  }
  function expOf(id) {
    if (!id) return [...expJobs.values()].sort((a, b) => b.at - a.at)[0] || null;
    return expJobs.get(String(id)) || null;
  }
  function exportStart(a) {
    a = a || {};
    const fmt = String(a.format || ExportFormats.ids()[0]);
    const f = ExportFormats.of(fmt);
    if (!f) return loose('format 只能是 ' + ExportFormats.hint());
    const tl = tlSyncFromShots();
    if (!tl.clips.length) return loose('现在一个可用镜头都没有：先在候选卡上点「用这条」选用，或者先生成画面');
    if (f.renders && Export.isRendering()) return loose('已有导出任务在进行中，等这一轮结束或先取消');
    const rec = expNew(fmt);
    const settle = r => expSettle(rec, !!(r && r.ok), r);
    if (f.kind === 'film') {
      Export.exportFilm({
        onStarted: x => {
          rec.renderId = x.renderId;
          rec.progress = 1;
          rec.text = '正在合成成片（' + x.clips + ' 段' + (x.subtitles ? ' · 字幕 ' + x.subtitles + ' 条' : '') + '）';
        },
        onProgress: j => { rec.progress = Number(j && j.progress) || rec.progress; },
      }).then(r => {
        settle(r);
        if (r && r.ok) rec.counts = { 段: r.clips, 秒: r.duration, 字幕: r.subtitles };
      }).catch(e => settle({ ok: false, err: errText(e)}));
      return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
    }
    /* 送到 NLE 要指定是哪一家：助手不弹选择框（那是用户界面），由动作参数给。 */
    if (f.nle) {
      const app = (a && (a.app === 'jianying' || a.app === 'resolve')) ? a.app : '';
      if (!app) return loose('送到剪映 / 达芬奇要在 format 之外给 app：jianying 或 resolve');
      Export.nle({ app, silent: true }).then(r => {
        settle(r);
        if (r && r.ok) rec.counts = { 画面段: r.rows, 配音句: r.voices, 字幕条: r.subtitles };
      }).catch(e => settle({ ok: false, err: errText(e)}));
      return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
    }
    Export.fcp({ bundle: !!f.bundle }).then(r => {
      settle(r);
      if (r && r.ok) rec.counts = { 画面段: r.rows, 配音句: r.voices, 字幕条: r.subtitles };
    }).catch(e => settle({ ok: false, err: errText(e)}));
    return { ok: true, jobId: rec.id, format: fmt, state: 'running', 说明: f.startNote };
  }
  async function exportStatus(a) {
    const rec = expOf(a && a.jobId);
    if (!rec) return loose('没有这次导出记录（助手发起的导出只在本次页面会话里记账；最近的导出用 export_list 读）');
    /* 进度由导出回调实时写在 rec 上（浏览器内合成，没有代理任务可问）。 */
    return Object.assign({ ok: true }, expView(rec));
  }
  function exportList() {
    return { ok: true, jobs: [...expJobs.values()].sort((a, b) => b.at - a.at).map(expView) };
  }
  /* 助手侧「最近导出」：本次页面会话里发起的那几笔。
     服务端的导出记录随渲染管线一起删了（浏览器内合成没有代理账本）——
     刷新之后就没有「最近导出」可查，要文件就再导一次或去下载目录找。 */
  async function exportRecent(a) {
    return { ok: true, 助手发起的: exportList().jobs, 说明: '只有本次页面会话里的记录（导出在浏览器内合成，代理不留账本）' };
  }
  async function exportCancel(a) {
    const rec = expOf(a && a.jobId);
    if (!rec) return loose('没有这次导出记录');
    if (rec.state !== 'running') return loose('这次导出已经不在跑（可能已经结束）');
    Export.cancelJob();
    expSettle(rec, false, { cancelled: true, err: '已取消' });
    return { ok: true, text: '已取消这次导出（已经落盘的部分不受影响）' };
  }
  async function exportSaveToAssets(a) {
    a = a || {};
    const name = String(a.name || (projOf().merged && projOf().merged.name) || '').trim();
    if (!name) return loose('没说要存哪一份：给 name（最近导出里的文件名），或先导出一份成片');
    try {
      /* 成片字节在会话缓存里（这一轮刚合成的那份）—— 直接把字节交给资产库，
         不再走「服务端渲染目录里复制一份」那条路（渲染目录已经删了）。 */
      const blob = Export.filmBlobOf ? Export.filmBlobOf(name) : null;
      if (!blob) return loose('这一份字节不在本次会话里（刷新过就没了）：再点一次「导出成片」，导完立刻存');
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1] || '');
        fr.onerror = () => rej(new Error('读不出字节'));
        fr.readAsDataURL(blob);
      });
      /* 类型跟文件名 / 字节走：成片没有 H.264 时导出来的是 .webm（选容器在 MediaExport.pickCodec）。 */
      const fmt = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4';
      const d = await window.Api.saveLocalAsset({
        name: name, mime: blob.type || (fmt === 'webm' ? 'video/webm' : 'video/mp4'), format: fmt, data: b64,
        meta: { provider: 'local', prompt: String(a.title || projOf().name || '').slice(0, 200) },
      });
      return Object.assign({ ok: true, text: (d && d.reused ? '资产库里已经有这一份：' : '已存进本机资产库：') + (name) }, d || {});
    } catch (e) { return loose('存进资产库失败：' + errText(e)); }
  }

  function dirCheck(op, a) {
    if (!ACTIVE()) return loose('当前不在导演台：切到导演台再让我动时间线（别切走之后让我盲改）');
    if (!READY()) return loose('导演台还没加载完，等这一页画出来再说');
    try {
      if (op === 'select' || op === 'cut' || op === 'set' || op === 'undo') {
        const gate = revGate(a, op);
        if (gate) return gate;
      }
      if (op === 'select') {
        const p = selectPlan(a); if (p.err) return p;
        /* pid/vid = 这一次读到的**身份**（哪一部短片、哪一条候选）：check 与 run 之间
           用户可能切了短片、候选可能被轮询重排（「已出片」的往前排）——
           run 时身份对不上就拒掉，让模型按新状态重读；下标是活的，身份才是用户批准的那一条。 */
        return { ok: true, pid: projOf().id, vid: p.c.vid,
          text: '把「' + capTxt(p.sh.name, 30) + '」第 ' + (p.i + 1) + ' 条候选设为选用' + (p.already ? '（现在已经是）' : ''),
          lines: ['镜头：' + capTxt(p.sh.name, 40) + (p.sc ? '（' + capTxt(p.sc.name, 20) + '）' : ''),
            '候选：第 ' + (p.i + 1) + ' / ' + (p.sh.candidates || []).length + ' 条 · ' + capTxt(p.c.vid, 40),
            '状态：' + (p.c.status || '未知') + ' · ' + round1(candDur(p.c, p.sh)) + ' 秒',
            '动作：设为选用 —— 成片这一镜按这一条算' + (p.already ? '（已经是，执行不会改任何东西）' : '')] };
      }
      if (op === 'cut') {
        const p = cutPlan(a); if (p.err) return p;
        const after = p.out.segs.reduce((x, s) => x + segFilmLen(s), 0);
        return { ok: true, pid: projOf().id, vid: p.c.vid,
          text: WAY_ZH[p.way] + '：' + capTxt(p.sh.name, 30) + ' 第 ' + (p.i + 1) + ' 条',
          lines: ['镜头：' + capTxt(p.sh.name, 40),
            '候选：第 ' + (p.i + 1) + ' 条 · ' + round1(p.total) + ' 秒',
            '剪法：' + WAY_ZH[p.way] + (p.way === 'split' || p.way === 'left' || p.way === 'right' ? '（插针 ' + p.at + ' 秒）' : ''),
            '剪完：' + p.out.segs.length + ' 段 · 这一条共 ' + round1(after) + ' 秒',
            '这一条' + (p.sh.selId === p.c.vid ? '正被选用，成片跟着变' : '还没被选用，成片仍按选用的那条算')] };
      }
      if (op === 'set') {
        if (a && a.kind === 'subtitle') {
          const p = subPlan(a); if (p.err) return p;
          const n = p.entries ? p.entries.length : p.cur.entries.length;
          const what = p.mode === 'import_srt' ? '把 SRT 里的 ' + n + ' 条导入「' + capTxt(p.sh.name, 30) + '」（成片秒折回候选源秒）'
            : p.mode === 'resegment' ? '把「' + capTxt(p.sh.name, 30) + '」的字幕按每行 ' + p.maxChars + ' 字重切成 ' + n + ' 条'
            : p.mode === 'generate' ? '按台词/配音给「' + capTxt(p.sh.name, 30) + '」重新生成 ' + n + ' 条字幕'
            : p.mode === 'update' ? '把「' + capTxt(p.sh.name, 30) + '」的字幕改成 ' + n + ' 条（源秒）'
            : '改「' + capTxt(p.sh.name, 30) + '」的字幕样式（条目不动）';
          const lines = ['镜头：' + capTxt(p.sh.name, 40),
            '候选：第 ' + ((p.sh.candidates || []).findIndex(x => x.vid === p.c.vid) + 1) + ' 条 · ' + round1(p.total) + ' 秒',
            '时间基准：候选源秒（' + (p.mode === 'import_srt' ? '导入的 SRT 按成片秒解释' : '预览/导出再折成成片秒') + '）',
            '字幕：' + n + ' 条' + (p.mode === 'style' ? '（只改样式）' : '')]
            .concat(p.stylePatch ? ['样式：' + Object.keys(p.stylePatch).join(' / ')] : [])
            .concat(p.warnings.map(w => '注意：' + w));
          return { ok: true, pid: projOf().id, vid: p.c.vid, text: what, lines, subtitleCount: n, stale: p.cur.stale };
        }
        const p = setPlan(a); if (p.err) return p;
        const bits = [];
        if (p.next.speed != null) bits.push('倍速 → ' + spdTxt(p.next.speed));
        if (p.next.volume != null) bits.push('原声 → ' + Math.round(p.next.volume * 100) + '%');
        if (p.next.gray != null) bits.push(p.next.gray ? '删成黑场' : '恢复画面');
        return { ok: true, pid: projOf().id, vid: p.c.vid,
          text: '改第 ' + (p.i + 1) + ' 条候选的第 ' + (p.segs.indexOf(p.seg) + 1) + ' 段：' + bits.join(' · '),
          lines: ['镜头：' + capTxt(p.sh.name, 40),
            '候选：第 ' + (p.i + 1) + ' 条（共 ' + p.segs.length + ' 段）',
            '这一段的现在：' + round1(segLen(p.seg)) + ' 秒源 · 倍速 ' + spdTxt(segSpd(p.seg)) + ' · 原声 ' + Math.round(segVol(p.seg) * 100) + '%',
            '改成：' + bits.join(' · ')] };
      }
      if (op === 'undo') {
        if (subBatch(a)) return loose('撤销不能放进批量：它是整批失败时的回滚方式');
        const p = undoPlan(a); if (p.err) return p;
        return { ok: true, text: (p.mode === 'redo' ? '重做 ' : '撤销 ') + p.steps + ' 步',
          lines: [(p.mode === 'redo' ? '可重做：' : '可撤销：') + p.n + ' 步', '这次做 ' + p.steps + ' 步'] };
      }
      return loose('不认识的时间线动作：' + op);
    } catch (e) { return loose(errText(e)); }
  }
  function dirRun(op, a) {
    const chk = dirCheck(op, a);
    if (!chk.ok) return chk;
    /* check 与 run 是两次独立的纯读：中间状态没变时结果一致；万一变了（用户在等确认时
       自己又点了一下轨道），run 照**当下**这份重算，不拿卡片上那份旧计划去写。
       但「重算」只对**纯计算的参数**成立 —— 用户批准的是那一条候选 / 那一部短片（身份），
       不是那个下标：候选重排（轮询把已出片的往前挪）或切了短片之后照下标执行，
       改的就是另一条 / 另一部。pid 在这里一次判完；vid 由各 op 分支在重算出 plan 之后
       与 chk.vid 比（plan 认镜认候选用的是同一份参数，跨镜 / 跨候选都不会比错对象）。 */
    if (op === 'select' || op === 'cut' || op === 'set') {
      if (chk.pid && projOf().id && chk.pid !== projOf().id) {
        return loose('工程在你读取之后换了一部短片（读取时是 ' + chk.pid + '，现在是 ' + projOf().id
          + '）。这次没有执行：重新读 timeline_get，确认短片后再来一次');
      }
    }
    const vidGate = p => {
      if (chk.vid && p && p.c && p.c.vid && p.c.vid !== chk.vid) {
        return loose('候选在你读取之后重排过（你批准的是 ' + chk.vid + '，现在解析到的是 ' + p.c.vid
          + '）。这次没有执行：重新读 timeline_get，按候选 id（candId）再来一次');
      }
      return null;
    };
    if (op === 'select') {
      const p = selectPlan(a); if (p.err) return p;
      const vg = vidGate(p); if (vg) return vg;
      if (p.already && !batchOf(a).inBatch) {
        renderAll();
        setStatus('这一条<b>已经是</b>选用的那条了；没有改任何数据');
        return { ok: true, text: chk.text + '。它本来就是选用的那条，数据没动',
          revision: revNow(), changedIds: [], warnings: [] };
      }
      const b = editBegin(a, 'AI 选片');
      focus(p.sc, p.sh, p.i);
      if (!p.already) p.sh.selId = p.c.vid;
      editEnd(a, b);
      setStatus('<span class="ok">✓ ' + esc(chk.text) + '（成片按这一条算）</span>');
      return { ok: true, text: chk.text + (p.already ? '。它本来就是选用的那条，数据没动' : '。已保存到本地工作区'),
        revision: revNow(), changedIds: p.already ? [] : [p.sh.id], warnings: [] };
    }
    if (op === 'cut') {
      const p = cutPlan(a); if (p.err) return p;
      const vg = vidGate(p); if (vg) return vg;
      const b = editBegin(a, 'AI 切段');
      const newSegs = segsWrite(p.c, p.total, p.out.segs);
      projOf().cutSeg = Math.max(0, Math.min(newSegs.length - 1, Number(p.out.at) || 0));
      projOf().cutAt = p.at;
      focus(p.sc, p.sh, p.i);
      const moved = reanchorVoices(p.sh, p.c, p.segs, newSegs);
      editEnd(a, b);
      const text = cutResultText(p, newSegs, moved);
      setStatus('<span class="ok">✓ ' + esc(text) + '</span>');
      return { ok: true, text, revision: revNow(), changedIds: [p.sh.id], warnings: [] };
    }
    if (op === 'set') {
      if (a && a.kind === 'subtitle') {
        const p = subPlan(a); if (p.err) return p;
        const vg = vidGate(p); if (vg) return vg;
        const b = editBegin(a, 'AI 改字幕');
        if (p.stylePatch) {
          if (!p.sh.subtitle || typeof p.sh.subtitle !== 'object') p.sh.subtitle = {};
          setStyle(p.sh, p.stylePatch);
        }
        /* 只改样式时不动条目：`sh.subtitle` 里只有 style，currentOf 仍按台词/配音现派生。 */
        if (p.entries) subWriteData(p.sh, p.entries, p.source);
        const ci = (p.sh.candidates || []).findIndex(x => x.vid === p.c.vid);
        focus(p.sc, p.sh, Math.max(0, ci));
        editEnd(a, b);
        const cur = currentOf(p.sh, voicesRead());
        const text = subResultText(p, cur);
        setStatus('<span class="ok">✓ ' + esc(text) + '</span>');
        return { ok: true, text, revision: revNow(), changedIds: [p.sh.id], warnings: p.warnings,
          subtitleCount: cur.entries.length, stale: cur.stale,
          unexported: !projOf().merged || !Export.filmIsCurrent(projOf().merged) };
      }
      const p = setPlan(a); if (p.err) return p;
      const vg0 = vidGate(p); if (vg0) return vg0;
      const segNo = p.segs.indexOf(p.seg) + 1;
      const seg = p.segs[segNo - 1];
      const b = editBegin(a, 'AI 改片段');
      if (p.next.speed != null) { if (p.next.speed === 1) delete seg.spd; else seg.spd = p.next.speed; }
      if (p.next.volume != null) { if (p.next.volume === 1) delete seg.vol; else seg.vol = p.next.volume; }
      if (p.next.gray != null) { if (p.next.gray) seg.off = 1; else delete seg.off; }
      const newSegs = segsWrite(p.c, p.total, p.segs);
      projOf().cutSeg = Math.max(0, Math.min(newSegs.length - 1, segNo - 1));
      focus(p.sc, p.sh, p.i);
      editEnd(a, b);
      const text = setResultText(p, segNo, newSegs[segNo - 1] || seg);
      setStatus('<span class="ok">✓ ' + esc(text) + '</span>');
      return { ok: true, text, revision: revNow(), changedIds: [p.sh.id], warnings: [] };
    }
    if (op === 'undo') {
      const p = undoPlan(a); if (p.err) return p;
      let done = 0;
      for (let k = 0; k < p.steps; k++) {
        if (p.mode === 'redo') { if (!redoStack.length) break; redo(); }
        else { if (!undoStack.length) break; undo(); }
        done++;
      }
      return { ok: true, text: (p.mode === 'redo' ? '已重做 ' : '已撤销 ') + done + ' 步（还能撤销 '
        + undoStack.length + ' 步 · 可重做 ' + redoStack.length + ' 步）',
        revision: revNow(), changedIds: [], warnings: [] };
    }
    return loose('不认识的时间线动作：' + op);
  }
  /* 结果定位（助手回执里的 changedIds 都是镜头 id）：显式点「定位」才切镜头并滚到那一格；
     执行完那一下只闪、不切视图。页不在前台就拒绝 —— 不做自动跳页，免得抢走用户当前的视图。 */
  function locateShots(ids, opts) {
    if (!READY()) return { ok: false, reason: '导演台还没加载完' };
    if (!ACTIVE()) return { ok: false, reason: '导演台现在不在前台：切回导演台再点「定位」' };
    const o = opts || {};
    const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
    const hits = [];
    projOf().scenes.forEach(sc => (sc.shots || []).forEach(sh => {
      if (list.includes(String(sh.id))) hits.push({ sc, sh });
    }));
    if (!hits.length) return { ok: false, reason: '这份工程里已经没有这几镜了（可能刚被删掉）' };
    const flash = () => hits.forEach(h => {
      const el = document.querySelector('.shot-item[data-sid="' + h.sh.id + '"]');
      if (!el) return;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2400);
    });
    if (o.focus !== false) {
      focus(hits[0].sc, hits[0].sh);
      renderAll();
      const el = document.querySelector('.shot-item[data-sid="' + hits[0].sh.id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      requestAnimationFrame(() => requestAnimationFrame(flash));
    } else flash();
    return { ok: true, found: hits.length,
      label: hits.length === 1 ? (hits[0].sh.name || '这一镜') : hits.length + ' 个镜头' };
  }
  /* 唯一写入桥：只读快照 + check + run，装进 `WBBridge`（web/core/bridges.js）。
     助手侧只认这一个名字，不再往 window 上挂页面专用全局。 */
  if (window.WBBridge && typeof window.WBBridge.install === 'function') window.WBBridge.install('director', {
    version: 2,
    ready: () => ACTIVE() && READY(),
    /* 只读历史摘要（首期）：条数 + 最近一次编辑的标签。
       不给「撤销到第 N 步」这类入口 —— 快照栈没有条目 id，按位置回退会在中间插入新编辑后错位。 */
    history: () => ({
      可撤销: undoStack.length,
      可重做: redoStack.length,
      上限: UNDO_MAX_COUNT,
      最近: undoStack.length ? (lastUndoLabelOf() || '编辑') : '',
      占内存: window.fmtBytes(undoBytesOf()) + ' / ' + window.fmtBytes(UNDO_MAX_BYTES),
    }),
    locate: (ids, opts) => locateShots(ids, opts),
    context: () => {
      if (!READY()) return { 导演台: '还没加载完' };
      const sc = curScene(), sh = curShot();
      if (!sh) return {};
      const list = sh.candidates || [];
      const ci = Math.max(0, Math.min(list.length - 1, Number(projOf().curCand) || 0));
      const c = list[ci] || null;
      const total = c ? candDur(c, sh) : 0;
      const segs = c ? segsOf(c, total) : [];
      return {
        项目: capTxt(projOf().name, 40),
        场景: sc ? capTxt(sc.name, 30) : '',
        镜头: capTxt(sh.name, 30),
        镜头id: sh.id,
        选用: (() => { const k = list.findIndex(x => x.vid === sh.selId); return k >= 0 ? ('第 ' + (k + 1) + ' 条') : '未选用'; })(),
        当前候选: list.length ? ('第 ' + (ci + 1) + ' / ' + list.length + ' 条') : '还没有候选',
        候选: list.slice(0, 12).map((x, k) => ({ 序号: k + 1, id: x.vid, 状态: x.status || '', 秒: round1(candDur(x, sh)), 选用: x.vid === sh.selId, 当前: k === ci })),
        这一条: c ? { 总秒: round1(total), 段数: segs.length,
          成片秒: round1(segs.reduce((a, s) => a + segFilmLen(s), 0)),
          段: segs.slice(0, 12).map((s, k) => ({ 第: k + 1, in: s.in, out: s.out, 倍速: segSpd(s), 音量: Math.round(segVol(s) * 100) + '%', 黑场: !!s.off })) } : null,
        插针: round1(Number(projOf().cutAt) || 0),
        选中段: segs.length ? Math.min(segs.length, Math.max(1, (Number(projOf().cutSeg) || 0) + 1)) : 0,
        播放头: TlPlay.plan.length ? round1(TlPlay.t) : null,
        字幕: (() => {
          const cur = currentOf(sh, voicesRead());
          return { 条数: cur.entries.length, 来源: cur.source, 过时: cur.stale,
            过时原因: cur.staleWhy || '', 在成片里: shotFilmAt(sh) != null };
        })(),
        成片: projOf().merged ? (Export.filmIsCurrent(projOf().merged) ? '已导出（当前）' : '已导出（旧）') : '未导出',
        revision: revNow(),
        可撤销: undoStack.length,
        可重做: redoStack.length,
      };
    },
    subtitle: a => subtitleInfo(a),
    srt: a => subtitleSrt(a),
    mediaInfo: a => mediaCheck(a),
    mediaFrames: a => mediaFrames(a),
    asrStart: a => asrStart(a),
    asrJob: a => asrJob(a),
    exportNow: a => exportStart(a),
    exportStatus: a => exportStatus(a),
    exportList: a => exportRecent(a),
    exportCancel: a => exportCancel(a),
    saveToAssets: a => exportSaveToAssets(a),
    check: (op, a) => dirCheck(op, a),
    run: (op, a) => dirRun(op, a),
  });
})();

  /* 这一域没有要交回 engine 的名字：它在模块自己那一段里就把活干完了（装桥、挂钩子）。 */
}
