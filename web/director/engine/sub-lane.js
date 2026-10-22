/* 导演台SubLane域：字幕的三个画点（右栏清单 / 本镜轨 / 全片轨）与它们的拖动、精确起止输入。
   由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间外的名字一律由 createSubLane(E) 递进来 ——
   这一份里不留第二套工程数据；写盘只有一个出口 `subWrite`（engine 那一份）。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效。 */
import { round1, pct } from '../util.js';
import { tlClipDur, segsOf } from '../segments.js';
import { mapToShot, mapFromFilm, filmOf, filmEntriesOf } from '../subtitles.js';

export function createSubLane(E, document, window) {
  const {
    projOf,
    allShots,
    candDur,
    chosenCandOf,
    fmtDur,
    subCurrent,
    subWrite,
    voicesEnsure,
    shotFrames,
    shotPinT,
    shotAxTotal,
    shotRowAt,
    frameToSrc,
    srcToFrame,
    filmFrames,
    tlSyncFromShots,
    shotFilmAt,
    setStatus,
    dragOnWindow,
    dragGhostShow,
    dragGhostMove,
    dragGhostHide,
    setVcTab,
  } = E;

  /* 「刚拖过」的余波判据：拖动松手后浏览器还会补一次 click，
     不压住就是「拖完顺手跳了一次焦点」。与配音块 markVoiceDrag 同一套（600ms 内算余波）。 */
  let subDragged = false, subDragId = '', subDragT = 0;
  const SUB_DRAG_MS = 600;
  const markSubDrag = id => { subDragged = true; subDragId = id || ''; subDragT = Date.now(); };
  const subWasDragged = id => !!(subDragged && subDragId === (id || '') && (Date.now() - subDragT) <= SUB_DRAG_MS);

  /* 拖动期间的几何，两排各一份。差的是**折算**与**活动范围**，骨架（按下 → 抄上下文 →
     拖动只改样式 → 松手折回源秒写盘）是同一套 —— 与配音块 bindDrag 同一个手势语言。
     本镜 = 候选自己的框轴（shotFrames，与画面格 / 插针同一把尺子）；
     全片 = 这一镜在成片几何里的那几行（一个镜头剪成几格，块要能跨在自己那几格上）。
     块拖不出自己那一镜：字幕锚在一条候选的源秒上，越界等于挂到别的镜 —— 那要回右栏重新来。 */
  function axCtxOf(sh, c) {
    const total = candDur(c, sh);
    const G = shotFrames(segsOf(c, total));
    const ax = shotAxTotal(G, total);
    return {
      ax: ax,
      zone: [0, ax],
      axOfSrc: src => shotPinT(G, src),
      axToSrc: t => { const r = shotRowAt(G, t); return r ? frameToSrc(r, t) : 0; },
    };
  }
  function filmCtxOf(G, shotId) {
    const rs = ((G && G.rows) || []).filter(r => r.cl && r.cl.kind === 'shot' && r.cl.shotId === shotId);
    if (!rs.length) return null;
    const ax = Math.max(0.05, G.total);
    const last = rs[rs.length - 1];
    const rowAt = t => { let r = last; for (const q of rs) { if (t < q.start + q.w) { r = q; break; } } return r; };
    return {
      ax: ax,
      zone: [rs[0].start, last.start + last.w],
      axOfSrc: src => { const x = Math.max(rs[0].a, Math.min(last.b, Number(src) || 0)); return srcToFrame(rowAt(x), x); },
      axToSrc: t => frameToSrc(rowAt(t), t),
    };
  }

  /* 一条字幕的两个手势（一个判据、一个位置 —— 按下点落在把手上就是改那一端，落在块体上就是整块挪）：
     块体 = 出现时间整体挪（长度不变）；左右把手 = 直接改起止（字幕没有「黑场」，
     拖出来的每一秒就是它真会在成片里出现的区间，不画遮罩）。拖动中只改这一块自己的
     left/width，别的块、别的行、数据一个字节都不动；松手才折回源秒、走 subWrite 唯一落点。 */
  function bindSubDrag(el, col, film) {
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const shotId = el.dataset.shot || '';
      const sh = allShots().find(x => x.id === shotId);
      if (!sh) return;
      const subi = Number(el.dataset.subi) || 0;
      const cur = subCurrent(sh);
      const e0 = cur.entries[subi];
      if (!e0) return;
      const ctx = film ? filmCtxOf(filmFrames(tlSyncFromShots()), shotId) : (() => {
        const c = chosenCandOf(sh);
        return c ? axCtxOf(sh, c) : null;
      })();
      if (!ctx) return;
      const lane = el.closest('.tl-sub-lane') || el.parentElement;
      const laneW = Math.max(1, (lane && lane.getBoundingClientRect().width) || 0);
      const secPerPx = ctx.ax / laneW;
      const left0 = ctx.axOfSrc((Number(e0.startMs) || 0) / 1000);
      const right0 = Math.max(left0, ctx.axOfSrc((Number(e0.endMs) || 0) / 1000));
      const cutEl = e.target.closest && e.target.closest('.sub-cut');
      const edge = cutEl ? (cutEl.dataset.edge || 'l') : '';
      if (cutEl) cutEl.classList.add('act');
      const x0 = e.clientX;
      let moved = 0, curL = left0, curR = right0;
      const paintBox = (l, r) => {
        el.style.left = pct(l, ctx.ax) + '%';
        el.style.width = pct(Math.max(0.03, r - l), ctx.ax) + '%';
      };
      const move = ev => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) <= 3) return;
        if (!moved) { moved = 1; markSubDrag(shotId + '#' + subi); dragGhostShow(ev, el, String(e0.text || '').slice(0, 24)); }
        else dragGhostMove(ev);
        const d = dx * secPerPx;
        if (!edge) {
          const nl = Math.max(ctx.zone[0], Math.min(ctx.zone[1] - (right0 - left0), left0 + d));
          curL = nl; curR = nl + (right0 - left0);
        } else if (edge === 'l') {
          curL = Math.max(ctx.zone[0], Math.min(right0 - 0.1, left0 + d));
          curR = right0;
        } else {
          curL = left0;
          curR = Math.max(left0 + 0.1, Math.min(ctx.zone[1], right0 + d));
        }
        paintBox(curL, curR);
      };
      const up = () => {
        if (cutEl) cutEl.classList.remove('act');
        dragGhostHide();
        if (!moved) return;
        /* 轴秒折回**源秒**（数据层一律源秒），写回走 subWrite：beginEdit（可撤销）+ filmEdited
           （轨道、右栏、预览叠层一次跟上）。最短留 0.1 秒 —— 比这还短的字幕谁也读不完。 */
        let aSrc = Math.max(0, ctx.axToSrc(curL));
        let bSrc = Math.max(0, ctx.axToSrc(curR));
        if (bSrc - aSrc < 0.1) { if (edge === 'l') aSrc = Math.max(0, bSrc - 0.1); else bSrc = aSrc + 0.1; }
        const startMs = Math.round(aSrc * 1000), endMs = Math.round(bSrc * 1000);
        if (startMs === (Number(e0.startMs) || 0) && endMs === (Number(e0.endMs) || 0)) {
          paintBox(left0, right0);
          setStatus('<span class="info">这一条字幕拖回了原位，起止都没变</span>');
          return;
        }
        const entries = cur.entries.map((x, k) => (k === subi
          ? Object.assign({}, x, { startMs, endMs, src: x.src === 'voice' || x.src === 'line' ? x.src : 'manual' })
          : x));
        subWrite(sh, entries, cur.source === 'asr' ? 'asr' : 'manual',
          edge === 'l' ? '改字幕起点' : edge === 'r' ? '改字幕终点' : '挪动字幕');
        /* 回执按**右栏那一把尺子**报（已进成片 = 成片秒，没进 = 源秒）—— 与两个输入框里的数是同一对。 */
        const shotAt = shotFilmAt(sh);
        const m = shotAt != null ? filmOf(sh, shotAt, entries[subi], { cand: chosenCandOf(sh) }) : null;
        setStatus('<span class="ok">✓ 这一条字幕改为 ' + round1(m ? m.filmStart : startMs / 1000) + ' – '
          + round1(m ? m.filmEnd : endMs / 1000) + ' 秒' + (m ? '（成片秒）' : '（源秒）') + '</span>');
      };
      dragOnWindow(move, up);
    });
  }

  /* 右栏那一列：每条的来源、可改的起止、可改的字。
     两个秒数与轨道块读的是同一份映射：这一镜已进成片报**成片秒**（SRT / 烧录 / 导出同一把尺子），
     没进成片报**源秒** —— 输入框收的就是它报的那种秒（subSetTime 按同一把尺子折回数据层）。 */
  function subRowsHTML(sh, cur, c) {
    const shotAt = shotFilmAt(sh);
    if (!cur.entries.length) return '';
    return '<div class="sub-list">' + cur.entries.map((e, i) => {
      const m = shotAt != null ? filmOf(sh, shotAt, e, { cand: c }) : null;
      const a = m ? m.filmStart : (Number(e.startMs) || 0) / 1000;
      const b = m ? m.filmEnd : (Number(e.endMs) || 0) / 1000;
      const tag = e.src === 'voice' ? '配音' : e.src === 'line' ? '台词' : e.src === 'asr' ? '识别' : '手改';
      const axisTip = m ? '成片秒：这一镜在成片里的绝对时间（导出与播放器同一把尺子）'
        : '源秒：这一镜还没进成片，按这条候选自己的时间算';
      return `<div class="sub-row" data-subi="${i}">
      <div class="sub-meta">
        <span class="sub-tag">${tag}</span>
        <input class="sub-t" type="number" step="0.1" min="0" data-subt="start" data-subi="${i}" value="${round1(a)}"
          title="${esc(axisTip + '。输入起点，回车或点别处生效')}">
        <span>–</span>
        <input class="sub-t" type="number" step="0.1" min="0" data-subt="end" data-subi="${i}" value="${round1(b)}"
          title="${esc(axisTip + '。输入终点，回车或点别处生效')}">
        <span class="sub-unit">秒</span>
        <button class="ghost mini" data-subdel="${i}" title="删掉这条字幕（只删字幕，台词与配音不动）">${icon('trash', 11)}</button>
      </div>
      <textarea class="ui-ta sub-ta" rows="1" data-subtext="${i}" title="改这一条字幕的字：不会反写台词；改完这一份算手改，台词再变也不会被悄悄覆盖">${esc(e.text)}</textarea>
    </div>`;
    }).join('') + '</div>';
  }
  /* 右栏起止输入的写回（用户点名「x 秒到 x 秒那里应该可以输入」）：
     `sec` 是**右栏读的那把尺子**上的秒 —— 已进成片 = 成片秒（与输入框显示的同一把尺子），
     折回源秒只有 mapFromFilm 一份口径（SRT 导入同一条路）；没进成片 = 源秒，直接用。
     起点退不出 0，终点不越过这一镜片尾，两头最短留 0.1 秒；写回走 subWrite 唯一落点。 */
  function subSetTime(sh, i, which, sec) {
    if (!sh) return;
    const cur = subCurrent(sh);
    const e0 = cur.entries[i];
    if (!e0) return;
    const v = Number(sec);
    if (!isFinite(v) || v < 0) return;
    const c = chosenCandOf(sh);
    const total = c ? candDur(c, sh) : 0;
    const shotAt = shotFilmAt(sh);
    let aSrc = (Number(e0.startMs) || 0) / 1000, bSrc = (Number(e0.endMs) || 0) / 1000;
    if (shotAt != null) {
      /* 零长探针只借 mapFromFilm 的折算，text 必须非空 —— normalizeEntries 会丢没字的条目。 */
      const probe = mapFromFilm(sh, shotAt,
        [{ text: '·', startMs: Math.round(v * 1000), endMs: Math.round(v * 1000) + 1 }], { cand: c });
      if (!probe.length) { setStatus('<span class="err">这一镜还没有可用的画面段，时间改不了</span>'); return; }
      if (which === 'start') aSrc = probe[0].startMs / 1000; else bSrc = probe[0].startMs / 1000;
    } else {
      if (which === 'start') aSrc = v; else bSrc = v;
    }
    aSrc = Math.max(0, Math.min(aSrc, total));
    bSrc = Math.max(0, Math.min(bSrc, total));
    if (bSrc - aSrc < 0.1) {
      if (which === 'start') aSrc = Math.max(0, bSrc - 0.1); else bSrc = Math.min(total, aSrc + 0.1);
    }
    const startMs = Math.round(aSrc * 1000), endMs = Math.round(bSrc * 1000);
    if (startMs === (Number(e0.startMs) || 0) && endMs === (Number(e0.endMs) || 0)) return;
    const entries = cur.entries.map((x, k) => (k === i
      ? Object.assign({}, x, { startMs, endMs, src: x.src === 'voice' || x.src === 'line' ? x.src : 'manual' })
      : x));
    subWrite(sh, entries, cur.source === 'asr' ? 'asr' : 'manual', '改字幕时间');
    const m = shotAt != null ? filmOf(sh, shotAt, entries[i], { cand: c }) : null;
    setStatus('<span class="ok">✓ 这一条字幕改为 ' + round1(m ? m.filmStart : startMs / 1000) + ' – '
      + round1(m ? m.filmEnd : endMs / 1000) + ' 秒' + (m ? '（成片秒）' : '（源秒）') + '</span>');
  }
  /* 本镜那一排的字幕块：按**这一排的框轴**摆（与画面格、插针、配音块同一把尺子 ——
     以前拿 mapToShot 的甲板轴直接当视觉位置，割过 / 倍速 ≠ 1 时块就漂出画面格；
     甲板秒只留在 data-axis 上给「点一下跳到这里」的 seek 用）。
     读数（title）与右栏输入框同一把尺子：已进成片 = 成片秒，没进 = 源秒。 */
  function subLaneHTML(sh, c, g, ax) {
    const cur = subCurrent(sh);
    const list = mapToShot(sh, cur.entries, { cand: c });
    if (!list.length) return '';
    const G = g || shotFrames(segsOf(c, candDur(c, sh)));
    const shotAt = shotFilmAt(sh);
    return '<div class="tl-sub-lane">' + list.map((e, i) => {
      const left = Math.max(0, Math.min(ax, shotPinT(G, (Number(e.startMs) || 0) / 1000)));
      const right = Math.max(left + 0.03, Math.min(ax, shotPinT(G, (Number(e.endMs) || 0) / 1000)));
      const m = shotAt != null ? filmOf(sh, shotAt, e, { cand: c }) : null;
      return `<span class="tl-sub" data-shot="${esc(sh.id)}" data-src="${(Number(e.startMs) || 0) / 1000}" data-axis="${e.shotStart}" data-subi="${i}"
      style="left:${pct(left, ax)}%;width:${pct(right - left, ax)}%"
      title="${esc(e.text + ' · ' + round1(m ? m.filmStart : (Number(e.startMs) || 0) / 1000) + '–' + round1(m ? m.filmEnd : (Number(e.endMs) || 0) / 1000) + ' 秒' + (m ? '（成片秒）' : '（源秒）') + '。拖动挪出现时间，两端把手改起止；点一下跳到这里；改字在右栏「字幕」')}">
      <span class="sub-cut l" data-edge="l"></span><span class="sub-txt">${esc(e.text)}</span><span class="sub-cut r" data-edge="r"></span></span>`;
    }).join('') + '</div>';
  }
  /* 全片那一排的字幕块：视觉位置同样按**这一排的框轴**（把源秒折进它自己那一镜的那几行）——
     以前拿成片秒直接当轴秒用，割过 / 倍速 ≠ 1 就漂。成片秒读数留在 title（与 SRT / 导出同一把尺子）。
     data-subi 是这一镜自己那份 entries 的 **0 基下标**（filmEntriesOf 保留每镜自己的 index，1 基），
     松手按 shotId + 它找回条目写回 —— 拖动不改镜属。 */
  function filmSubLaneHTML(tl, g) {
    const G = g || filmFrames(tl);
    const rows = [];
    let at = 0;
    tl.clips.forEach(c => { const dur = tlClipDur(c); rows.push({ c, at, dur }); at += dur; });
    const got = filmEntriesOf(rows, allShots(), voicesEnsure());
    if (!got.entries.length) return '';
    const ax = Math.max(0.05, Number(G.total) || at);
    const rowsOf = id => ((G && G.rows) || []).filter(r => r.cl && r.cl.kind === 'shot' && r.cl.shotId === id);
    return '<div class="tl-sub-lane">' + got.entries.map(e => {
      const rs = rowsOf(e.shotId);
      if (!rs.length) return '';
      const last = rs[rs.length - 1];
      const axOfSrc = src => {
        const x = Math.max(rs[0].a, Math.min(last.b, Number(src) || 0));
        let r = last;
        for (const q of rs) { if (x < q.b) { r = q; break; } }
        return srcToFrame(r, x);
      };
      const left = Math.max(0, Math.min(ax, axOfSrc((Number(e.startMs) || 0) / 1000)));
      const right = Math.max(left + 0.03, Math.min(ax, axOfSrc((Number(e.endMs) || 0) / 1000)));
      return `<span class="tl-sub" data-shot="${esc(e.shotId)}" data-axis="${left}" data-subi="${Math.max(0, (Number(e.index) || 1) - 1)}"
      style="left:${pct(left, ax)}%;width:${pct(right - left, ax)}%"
      title="${esc(e.text + ' · 成片 ' + round1(e.filmStart) + '–' + round1(e.filmEnd) + ' 秒。拖动挪出现时间，两端把手改起止；点一下跳到这里；改字在右栏「字幕」')}">
      <span class="sub-cut l" data-edge="l"></span><span class="sub-txt">${esc(e.text)}</span><span class="sub-cut r" data-edge="r"></span></span>`;
    }).join('') + '</div>';
  }
  function bindSubLanes(bar, col, filmMode) {
    bar.querySelectorAll('.tl-sub-lane .tl-sub').forEach(el => {
      bindSubDrag(el, col, filmMode);
      el.addEventListener('click', e => {
        const key = (el.dataset.shot || '') + '#' + (el.dataset.subi || '');
        /* 拖完浏览器补发的那一下、以及两端把手：都不放针、也不翻右栏 ——
           拦住冒泡，免得整张网格的放针点击接着跑。 */
        if (subWasDragged(key)) { e.stopPropagation(); return; }
        if (e.target.closest && e.target.closest('.sub-cut')) { e.stopPropagation(); return; }
        /* 正常点一下：右栏翻到「字幕」，针交给整张网格那一份落点（按**点击处**放针）——
           这里不 stopPropagation，拦住的话针只会停在上一次的位置。 */
        projOf().tlLane = 'voice';
        setVcTab('sub');
      });
    });
  }

  return { subRowsHTML, subSetTime, subLaneHTML, filmSubLaneHTML, bindSubLanes };
}
