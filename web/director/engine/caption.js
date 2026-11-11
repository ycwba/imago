/* 导演台Caption域：全片字幕的数据动作（按配音补字幕 / 重切 / SRT 导入导出 / 语音识别 / 单条编辑）
   与右栏「字幕」那一格。
   字幕只有一份：`proj.film.captions`，`start`/`end` **就是成片秒** —— 与播放器、烧录、SRT、FCPXML
   同一把尺子，所以这一域里没有任何秒制折算。唯一的例外是语音识别：识别结果落在**那一条素材自己的源秒**上，
   进字幕轨之前先按 `deriveTimeline` 的那一行折成成片秒（折法只在这里出现一次）。
   写入只有一个出口 `Edit.patch`（beginEdit → 落盘 → filmEdited），点名写法只有一个出口 `Edit.describeItem`。 */
import {
  deriveTimeline, createCaption, captionForTimed, captionPosition, captionHighlighted, captionStyleOf,
  visibleCaptions, MIN_CAPTION_SECONDS,
} from '../film.js';
import { num, round1, round2, ctxClip } from '../util.js';
import { srtParse, srtSerialize, resegment, RESEGMENT_DEFAULT_CHARS } from '../srt.js';

/* 在播放头处手写一条的默认长度。 */
const CAP_ADD_SECONDS = 2;

export function createCaptionDomain(E, document, window) {
  const {
    filmOf, projOf, Edit, Timeline, Play, setStatus, esc, icon, mediaSrc, saveBlob, renderEditor,
  } = E;

  let asrBusy = '';       // 正在识别的那一段画面 id（按钮文案现读它）
  let asrCtl = null;      // 在途识别的中止信号（浏览器 worker 与等待循环都听它）
  let asrJob = '';        // 已经建出的代理任务号：取消时补一次 cancel，别让它在后台跑完

  const captionList = () => (filmOf().captions || []).slice().sort((a, b) => num(a.start) - num(b.start));
  const captionOf = id => (filmOf().captions || []).find(c => c && c.id === id) || null;
  const sortByStart = list => list.slice().sort((a, b) => num(a.start) - num(b.start));
  /* 读数与历史一律带零点一秒：12 秒还是 12.4 秒，用户判断的是同一件事。 */
  const tenth = v => (Math.round(Math.max(0, num(v)) * 10) / 10).toFixed(1);
  /* 这一条字幕挂在谁身上：连着定时块 / 曾经连着（记忆位还在）/ 独立一条（手写、导入或识别）。 */
  const capTagOf = c => (c && c.voiceId ? '配音' : (c && c.detachedVoiceId ? '已断开' : '独立'));

  function patchCaps(list, label) {
    return Edit.patch({ captions: sortByStart(list) }, label);
  }

  /* ---------------- 单条编辑（右栏那三处输入） ---------------- */
  function capSetText(id, text) {
    const c = captionOf(id);
    if (!c) { if (setStatus) setStatus('这一条字幕已经不在了'); return false; }
    const v = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    if (v === c.text) return false;
    const name = Edit.describeItem('cap', id);
    return patchCaps((filmOf().captions || []).map(x => (x.id === id ? { ...x, text: v } : x)),
      `把字幕${name}的字改成「${ctxClip(v, 20)}」`);
  }

  /* 起或止改一个数：另一端不动，两头最短夹到 `MIN_CAPTION_SECONDS`（比这还短的字幕谁也读不完）。 */
  function capSetTime(id, which, sec) {
    const c = captionOf(id);
    if (!c) { if (setStatus) setStatus('这一条字幕已经不在了'); return false; }
    const v = Number(sec);
    if (!isFinite(v) || v < 0) return false;
    let start = round2(num(c.start)), end = round2(num(c.end));
    if (which === 'start') start = round2(Math.min(Math.max(0, v), end - MIN_CAPTION_SECONDS));
    else end = round2(Math.max(v, start + MIN_CAPTION_SECONDS));
    if (start === round2(num(c.start)) && end === round2(num(c.end))) return false;
    const name = Edit.describeItem('cap', id);
    return patchCaps((filmOf().captions || []).map(x => (x.id === id ? { ...x, start, end } : x)),
      `把字幕${name}改成 ${tenth(start)}–${tenth(end)} 秒`);
  }

  /* 位置与高亮都挂在字幕自己身上（不再有「每一镜一套样式」那份第二数据）。
     高亮只在预览与烧录里生效 —— FCPXML 的标题表达不了背景，那里照实写进 warnings。 */
  function capSetStyle(id, patch, what) {
    const c = captionOf(id);
    if (!c) return false;
    return patchCaps((filmOf().captions || []).map(x => (x.id === id ? { ...x, ...patch } : x)),
      `把字幕${Edit.describeItem('cap', id)}的${what}`);
  }

  function capDelete(id) {
    const c = captionOf(id);
    if (!c) { if (setStatus) setStatus('这一条字幕已经不在了'); return false; }
    return patchCaps((filmOf().captions || []).filter(x => x.id !== id), `删掉字幕${Edit.describeItem('cap', id)}`);
  }

  function capAddAtPin() {
    const t = Math.max(0, num(Timeline.playhead()));
    const cap = createCaption({ text: '新的字幕', start: t, end: t + CAP_ADD_SECONDS });
    const ok = patchCaps([...(filmOf().captions || []), cap],
      `在 ${tenth(cap.start)} 秒处新增一条字幕（长 ${tenth(CAP_ADD_SECONDS)} 秒）`);
    if (ok) Edit.selectItem('cap', cap.id);
    return ok;
  }

  /* ---------------- 批量：按配音补字幕 / 重切 ---------------- */
  /* 只补「还没有字幕挂着」的那些配音块 —— 已经存在的字幕一条都不覆盖：
     用户手改过的字、导入的 SRT、识别出来的结果都是他的数据。整条重做走 Ctrl+Z 或先删。 */
  function capGenerate() {
    const f = filmOf();
    const timed = (f.voices || []).filter(x => x && String(x.text || '').trim());
    if (!timed.length) {
      if (setStatus) setStatus('<span class="err">配音轨上还没有带字的块：先在「台词」里写一句，或切到「生成配音」合成一句</span>');
      return false;
    }
    const linked = new Set((f.captions || []).map(c => c && c.voiceId).filter(Boolean));
    const fresh = timed.filter(x => !linked.has(x.id)).map(captionForTimed).filter(c => c.text);
    if (!fresh.length) {
      if (setStatus) setStatus(`<span class="meta">这 ${timed.length} 句配音都已经各有字幕挂着（全片 ${(f.captions || []).length} 条）——要改字在上面的清单里改</span>`);
      return false;
    }
    const before = (f.captions || []).length;
    const ok = patchCaps([...(f.captions || []), ...fresh],
      `按配音补出 ${fresh.length} 条字幕`);
    if (ok && setStatus) setStatus(`<span class="ok">✓ 新增 ${fresh.length} 条字幕（全片现在 ${before + fresh.length} 条）：每条接在自己那句配音上</span>`);
    return ok;
  }

  /* 按每行字数把长字幕切开：内容不变，时间按字数比例分（算法在 `srt.js` 那一份）。 */
  function capResegment(maxChars) {
    const list = captionList();
    if (!list.length) {
      if (setStatus) setStatus('<span class="err">字幕轨是空的：先按配音补字幕、导入 SRT 或自动识别</span>');
      return false;
    }
    const n = Math.max(8, Math.min(120, Math.round(Number(maxChars) || RESEGMENT_DEFAULT_CHARS)));
    const next = resegment(list, n);
    if (next.length === list.length) {
      if (setStatus) setStatus(`<span class="meta">已经是每行不超过 ${n} 个字，没有可再切的字幕</span>`);
      return false;
    }
    const ok = patchCaps(next, `按每行 ${n} 字把长字幕重切成 ${next.length} 条（内容不变，时间按字数比例分）`);
    if (ok && setStatus) setStatus(`<span class="ok">✓ 已重切：${list.length} 条 → ${next.length} 条（每行不超过 ${n} 字）</span>`);
    return ok;
  }

  /* ---------------- SRT 出 / 入 ---------------- */
  function pickTextFile(accept) {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accept || '';
      inp.style.display = 'none';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        try { inp.remove(); } catch (e) { /* 临时输入框已经不在 DOM 里就没有可移除的 */ }
        resolve(f || null);
      };
      document.body.appendChild(inp);
      inp.click();
    });
  }

  /* 导出的是**看得见、且有字的那些**（字幕行被眼睛收掉的不进文件）：判据只有 `visibleCaptions` 一份，
     与播放器、烧录、SRT、FCPXML 同一把尺子。被跳过的数量照实报 —— 少几条却不说是哪一类，就是假账。
     取文本这一份同时给「下载文件」和助手读 SRT 用：两处各拼一遍时间格式，迟早一份对不上另一份。 */
  function capSrtText(opts) {
    const got = visibleCaptions(filmOf());
    return {
      list: got.list,
      条数: got.list.length,
      跳过: got.skipped || {},
      text: srtSerialize(got.list.map(c => ({ text: c.text, start: c.start, end: c.end })), opts || {}),
    };
  }

  function capExportSrt() {
    const got = capSrtText({ bom: true, crlf: true });
    if (!got.list.length) {
      const sk = got.跳过;
      if (setStatus) setStatus('<span class="err">现在没有一条可导出的字幕'
        + (sk.hidden ? `：${sk.hidden} 条挂在被收起的字幕行上（把那一行的眼睛打开）` : '')
        + (sk.empty ? `${sk.hidden ? ' · ' : '：'}${sk.empty} 条没有字` : '')
        + '</span>');
      return false;
    }
    const name = window.fileSafe((projOf() && projOf().name) || '成片', 60) + '-字幕-' + window.fileStamp() + '.srt';
    const saved = saveBlob(name, new Blob([got.text], { type: 'application/x-subrip;charset=utf-8' }));
    const sk = got.跳过;
    if (setStatus) setStatus('<span class="ok">' + saved.msg + '（' + got.条数 + ' 条字幕，时间是成片秒）</span>'
      + (sk.hidden ? `<span class="warn"> · 有 ${sk.hidden} 条挂在被收起的字幕行上，没有导出</span>` : '')
      + (sk.empty ? `<span class="warn"> · 有 ${sk.empty} 条没有字，没有导出</span>` : ''));
    return saved;
  }

  /* 导入 = **并进全片这一份**（SRT 的时间本来就是成片秒，一步折算都不需要）：不覆盖现有字幕。
     落盘与计数只在 `capImportSrtText` 这一处：文件选择那一层（`capImportSrt`）与助手
     （桥的 `subtitle_write`）都走它，两边各写一份就会一份并一份覆盖。 */
  function capImportSrtText(text, name) {
    const parsed = srtParse(text);
    if (!parsed.length) return { ok: false, why: '这份 SRT 里没有解析出字幕（时间行要写成 00:00:00,000 --> 00:00:02,000）' };
    const list = parsed.map(e => createCaption({ text: e.text, start: e.start, end: e.end }));
    const before = (filmOf().captions || []).length;
    const label = `导入 ${String(name || 'SRT').slice(0, 24)}：并进 ${list.length} 条字幕（文件里的时间按成片秒直接用）`;
    const ok = patchCaps([...(filmOf().captions || []), ...list], label);
    return { ok, count: list.length, total: before + (ok ? list.length : 0), skipped: parsed.skipped || 0, label };
  }

  async function capImportSrt() {
    const file = await pickTextFile('.srt,.txt,text/plain,application/x-subrip');
    if (!file) return false;
    let text = '';
    try { text = await file.text(); } catch (e) {
      if (setStatus) setStatus('<span class="err">读这个文件失败：' + esc(String(window.errText(e))) + '</span>');
      return false;
    }
    const r = capImportSrtText(text, file.name);
    if (!r.ok && r.why) {
      if (setStatus) setStatus('<span class="err">' + esc(r.why) + '</span>');
      return false;
    }
    if (r.ok && setStatus) setStatus(`<span class="ok">✓ 已导入 ${r.count} 条字幕（全片现在 ${r.total} 条；时间就是这条 SRT 里的成片秒`
      + `${r.skipped ? '；' + r.skipped + ' 块格式不对已跳过' : ''}）</span>`);
    return r.ok;
  }

  /* 直接交一批条目进来（助手按用户给的文本补字幕）：与 SRT 导入同一个并入口径，不覆盖现有。 */
  function capAddEntries(rows) {
    const list = (Array.isArray(rows) ? rows : [])
      .map(r => createCaption({ text: String((r && r.text) || ''), start: num(r && r.start), end: num(r && r.end),
        position: (r && r.position) || undefined }))
      .filter(c => c.text);
    if (!list.length) return { ok: false, why: '这批条目里没有一个有字：每条都要有 text（且 start/end 之间不短于 ' + MIN_CAPTION_SECONDS + ' 秒）' };
    const before = (filmOf().captions || []).length;
    const ok = patchCaps([...(filmOf().captions || []), ...list],
      `新增 ${list.length} 条字幕（时间是成片秒；全片现在 ${before + list.length} 条）`);
    return { ok, count: list.length, total: before + (ok ? list.length : 0) };
  }

  /* ---------------- 语音识别：播放头那一段画面 → 字幕 ---------------- */
  /* 识别给的是**素材自己的源秒**，落进字幕轨按这一行折成片秒：
     成片秒 = 行起点 +（源秒 − 这一段从素材第几秒开始）÷ 倍速，夹在这一行的窗口里。
     整句落在被剪掉的那一截就折成行尾那一瞬，短到不足最短时长就不进（照实计数，不静默吞）。 */
  function srcToFilm(row, clip, srcSec) {
    const rate = Math.max(0.25, num(clip.playbackRate, 1) || 1);
    const t = num(row.start) + (Math.max(0, num(srcSec)) - num(clip.sourceStart)) / rate;
    return Math.max(num(row.start), Math.min(num(row.end), t));
  }

  function asrTarget() {
    const f = filmOf();
    const tl = deriveTimeline(f.clips || []);
    const row = tl.rows[tl.indexAtTime(Timeline.playhead())];
    if (!row) return { why: '成片里还没有画面段：先导一条素材进画面轨' };
    if (row.clip.kind === 'image') return { why: '播放头指着的那一段是一张静态图，没有声音可识别' };
    if (!row.clip.src) return { why: '播放头指着的那一段没有素材地址' };
    return { row, clip: row.clip };
  }

  async function asrAbort() {
    const id = asrJob;
    asrJob = '';
    try { if (asrCtl) asrCtl.abort(); } catch (e) { /* 已经断了 */ }
    if (id) {
      try { await window.Asr.cancel(id); } catch (e) { /* 已经跑完或取消不掉：状态由那一单自己报 */ }
    }
  }

  async function capAsr() {
    /* 第二下就是「不等了」：浏览器内那一路线首次要先经代理下几百 MB 模型，
       没有出口的话用户只能刷新页面。 */
    if (asrBusy) { await asrAbort(); return false; }
    const t = asrTarget();
    if (t.why) { if (setStatus) setStatus('<span class="err">' + esc(t.why) + '</span>'); return false; }
    const { row, clip } = t;
    asrBusy = clip.id;
    const ctl = new AbortController();
    asrCtl = ctl;
    /* 立刻重画一次右栏：按钮要马上翻成「不等了」的样子，不然模型下载那几分钟里它还写「自动识别」，
       第二下其实是取消 —— 用户以为在再识一次。 */
    renderEditor();
    try {
      if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
      if (setStatus) setStatus('<span class="meta">正在提交语音识别…</span>');
      const r = await window.Asr.transcribe({
        src: mediaSrc(clip.src || ''),
        signal: ctl.signal,
        onStage: s => { if (!ctl.signal.aborted && setStatus) setStatus('<span class="meta">' + esc(window.Asr.stageText(s)) + '</span>'); },
      });
      asrJob = r.jobId || '';
      renderEditor();
      const job = await window.Asr.wait(r.jobId, j => {
        if (!ctl.signal.aborted && setStatus) setStatus('<span class="meta">正在识别这一段素材的语音… ' + Math.round((j.progress || 0) * 100) + '%</span>');
      }, { signal: ctl.signal });
      if (job.state !== 'done') throw new Error(job.error || ('识别任务 ' + job.state));
      const list = [];
      let dropped = 0;
      (job.segments || []).forEach(s0 => {
        const tx = String(s0.text == null ? '' : s0.text).trim();
        if (!tx) return;
        const a = srcToFilm(row, clip, s0.start), b = srcToFilm(row, clip, s0.end);
        if (b - a < MIN_CAPTION_SECONDS) { dropped++; return; }
        list.push(createCaption({ text: tx, start: a, end: b }));
      });
      if (!list.length) throw new Error('识别完成，但结果一条都落不进这一段保留的画面（看看是不是把有说话的片段剪掉了）');
      const before = (filmOf().captions || []).length;
      const ok = patchCaps([...(filmOf().captions || []), ...list],
        `识别第 ${row.index + 1} 段画面「${ctxClip(clip.name || '素材', 14)}」的语音，补出 ${list.length} 条字幕`);
      /* 服务端把「文本可疑」并进 engine 那串文案（server/routes/asr.js），没有单独的布尔字段 ——
         这里按那句话认；认不出就当不可疑，宁可少说一句不多说。 */
      const sus = /文本可疑/.test(String(job.engine || ''));
      if (ok && setStatus) setStatus('<span class="ok">✓ 识别完成：新增 ' + list.length + ' 条字幕（全片现在 '
        + (before + list.length) + ' 条；时间是这一段的成片秒）</span>'
        + (dropped ? `<span class="warn"> · 有 ${dropped} 条太短或整句落在被剪掉的区间里，没有写入</span>` : '')
        + (sus ? '<span class="warn"> · 这段音的识别结果可疑（中文占比偏低 / 夹着长串外文），建议人工复核一遍再烧录</span>' : ''));
      return ok;
    } catch (e) {
      if (ctl.signal.aborted) {
        if (setStatus) setStatus('<span class="err">已取消识别：字幕一条都没有改动</span>');
      } else if (setStatus) {
        setStatus('<span class="err">自动识别失败：' + esc(String(window.errText(e))) + '</span>');
      }
      return false;
    } finally {
      asrBusy = '';
      asrCtl = null;
      asrJob = '';
      renderEditor();
    }
  }

  /* ---------------- 右栏那一格 ---------------- */
  function captionRowHTML(c, isNow) {
    return `<div class="sub-row${isNow ? ' is-now' : ''}" data-cap-row="${esc(c.id)}">
      <div class="sub-meta">
        <span class="sub-tag">${esc(capTagOf(c))}</span>
        <input class="sub-t" type="number" step="0.1" min="0" data-cap-t="start" data-cap="${esc(c.id)}" value="${round1(num(c.start))}"
          title="成片秒起点">
        <span>–</span>
        <input class="sub-t" type="number" step="0.1" min="0" data-cap-t="end" data-cap="${esc(c.id)}" value="${round1(num(c.end))}"
          title="成片秒终点（最短 ${MIN_CAPTION_SECONDS} 秒）">
        <span class="sub-unit">秒</span>
        <select class="sub-pos" data-cap="${esc(c.id)}" title="出现在画面的哪一处">
          ${[['bottom', '底部'], ['middle', '居中'], ['top', '顶部']].map(o => `<option value="${o[0]}"${captionPosition(c) === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}
        </select>
        <label class="sub-hl" title="高亮底只在预览与烧录里生效">
          <input type="checkbox" data-cap-hl="${esc(c.id)}"${captionHighlighted(c) ? ' checked' : ''}> 高亮
        </label>
        <button type="button" class="ghost mini" data-cap-del="${esc(c.id)}" title="删掉这一条字幕">${icon('trash', 11)}</button>
      </div>
      <textarea class="ui-ta sub-ta" rows="1" data-cap-text="${esc(c.id)}">${esc(c.text)}</textarea>
    </div>`;
  }

  /* 清单是**全片**一份（按成片秒排）：字幕不再属于某一镜，它属于成片时间线。
     播放头正压着的那一条点亮 —— 与轨道上那一排的高亮读同一段时间覆盖。 */
  function capPanelHTML() {
    const f = filmOf();
    const list = captionList();
    const vis = visibleCaptions(f);
    const sk = vis.skipped || {};
    const t = Math.max(0, num(Timeline.playhead()));
    const note = (sk.hidden || sk.empty)
      ? `<div class="ui-note warn">有 ${(sk.hidden || 0) + (sk.empty || 0)} 条不进成片：${sk.hidden ? sk.hidden + ' 条挂在被收起的字幕行上；' : ''}${sk.empty ? sk.empty + ' 条没有字（把字填上就进）' : ''}</div>`
      : '';
    const rows = list.length
      ? '<div class="sub-list">' + list.map(c => captionRowHTML(c, t >= num(c.start) && t < num(c.end))).join('') + '</div>'
      : '<div class="hint">还没有字幕</div>';
    const busy = !!asrBusy;
    return `<div class="ed-label"><span>字幕</span><span class="cnt">全片 ${list.length} 条 · 成片秒</span></div>
      ${note}
      ${rows}
      <div class="btn-row">
        ${window.aiBtnHTML({ id: 'capGen', label: '按配音补字幕', title: '给还没有字幕挂着的那几句配音各补一条（已有的不覆盖）' })}
        <button type="button" class="tool" id="capAdd" title="在播放头那一秒加一条（${CAP_ADD_SECONDS} 秒）">${icon('plus', 14)} 在播放头加一条</button>
      </div>
      <div class="btn-row">
        <button type="button" class="tool" id="capImport" title="导入 .srt（时间就是成片秒，不覆盖）">${icon('upload', 14)} 导入 SRT</button>
        <button type="button" class="tool" id="capExport" title="把全片字幕导出成 .srt">${icon('download', 14)} 导出 SRT</button>
        <button type="button" class="tool" id="capAsr" title="${busy ? '' : '识别播放头指着那一段素材里的话（首次可能等几分钟）'}">${icon('mic', 14)} ${busy ? '取消识别' : '自动识别'}</button>
      </div>
      <div class="adv-grid">
        <div><label>每行字数</label><input type="number" id="capMaxChars" min="8" max="120" step="1" value="${RESEGMENT_DEFAULT_CHARS}"></div>
      </div>
      <div class="btn-row">
        <button type="button" class="tool" id="capReseg" title="按「每行字数」把长字幕切成几条，时间按字数比例分">${icon('rows', 14)} 按每行字数重切</button>
      </div>`;
  }

  function bindCapPanel(col) {
    const q = s => col.querySelector(s);
    const gen = q('#capGen');
    if (gen) gen.onclick = () => capGenerate();
    const add = q('#capAdd');
    if (add) add.onclick = () => capAddAtPin();
    const imp = q('#capImport');
    if (imp) imp.onclick = () => capImportSrt();
    const exp = q('#capExport');
    if (exp) exp.onclick = () => capExportSrt();
    const asr = q('#capAsr');
    if (asr) asr.onclick = () => capAsr();
    const reseg = q('#capReseg');
    if (reseg) reseg.onclick = () => capResegment((q('#capMaxChars') || {}).value);
    col.querySelectorAll('[data-cap-text]').forEach(ta => {
      ta.onchange = () => capSetText(ta.dataset.capText, ta.value);
    });
    col.querySelectorAll('[data-cap-t]').forEach(inp => {
      inp.onchange = () => capSetTime(inp.dataset.cap, inp.dataset.capT, parseFloat(inp.value));
    });
    col.querySelectorAll('.sub-pos[data-cap]').forEach(sel => {
      sel.onchange = () => capSetStyle(sel.dataset.cap, { position: sel.value }, '位置改成「' + sel.options[sel.selectedIndex].text + '」');
    });
    col.querySelectorAll('[data-cap-hl]').forEach(ck => {
      ck.onchange = () => capSetStyle(ck.dataset.capHl, { style: captionStyleOf(ck.checked) }, (ck.checked ? '加上' : '去掉') + '高亮底');
    });
    col.querySelectorAll('[data-cap-del]').forEach(b => {
      b.onclick = e => { e.stopPropagation(); capDelete(b.dataset.capDel); };
    });
    /* 点一行的空白处 = 把播放头挪到那一条的起点（轨道与这一行的高亮跟着一起走）；
       落在输入框 / 下拉 / 按钮上不动针 —— 那是用户在改值，不是在看片。 */
    col.querySelectorAll('[data-cap-row]').forEach(row => {
      row.addEventListener('pointerdown', e => {
        if (e.target.closest('input,textarea,select,button,label')) return;
        const c = captionOf(row.dataset.capRow);
        if (c && Play) Play.seek(num(c.start));
      });
    });
  }

  return {
    capPanelHTML, bindCapPanel, capGenerate, capResegment, capAddAtPin, capExportSrt, capImportSrt,
    capSrtText, capImportSrtText, capAddEntries,
    capAsr, capSetText, capSetTime, capSetStyle, capDelete, list: captionList,
  };
}
