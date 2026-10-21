/* 导演台VoiceLane域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createVoiceLane(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1, pct } from '../util.js';
import { segLen, segsOf, TRACK_LANES_MAX, laneClamp } from '../segments.js';
import { voiceRateOf, voiceFrameOf, roundVoice, voiceRuns, rowSelIn, rowSelOut } from '../voice-layout.js';
import { voiceBlockText } from '../voice-block.js';

export function createVoiceLane(E, document, window) {
  const {
    playSafe,
    projOf,
    allShots,
    candDur,
    filmFrames,
    axisGray,
    frameToSrc,
    shotFrames,
    shotPinT,
    shotAxTotal,
    voiceAxBox,
    voiceFilmSpan,
    voiceAdoptable,
    voiceBlockHTML,
    voicesEnsure,
    shotVoices,
    dragOnWindow,
    voiceSelId,
    picSelOn,
    laneLocked,
    laneHidden,
    rowHidden,
    rowLocked,
    laneNm,
    rowNm,
    rowLockWhy,
    rowUnlockHow,
    laneVol,
    laneRowsFor,
    LANE_ROW_SEL,
    laneMute,
    trackOwnVol,
    tlSyncFromShots,
    voiceVolOf,
    focusVoiceShot,
    trackOne,
    syncTlTools,
    paintTrimRow,
    filmEdited,
    scheduleSave,
    dragGhostShow,
    dragGhostMove,
    dragGhostHide,
    voiceElOf,
    vcTabOf,
    audioDurOf,
    setStatus,
    setVcTab,
    setVoiceEl,
  } = E;

/* 声音轨上的一句：块左沿 = 它锚定那一段的入点 + 段内偏移（与画面行同一根时间基）。
   段被切掉时这句不会跟着消失 —— reanchorVoices 把它挪到后面那段的开头，所以这里永远画得出来。 */
function playVoicePreview(id) {
  const v = voicesEnsure().find(x => x.id === id);
  if (!v) return;
  if (!v.src) { setStatus('<span class="err">这一句没有可用的音频地址（当时没落成本机文件），回语音台重新合成一句</span>'); return; }
  if (!voiceElOf()) {
    setVoiceEl(new Audio());
  }
  try { voiceElOf().pause(); } catch (e) { /* 本来就停着就没有需要停的 */ }
  /* 记住正在试听的是哪一句：改「这一行的基数」时要当场把这一句的新音量按上去（见 setLaneVol），
     靠 src 反查会把两条同源的不同句子混成一句。 */
  voiceElOf().__vid = id;
  voiceElOf().src = Api.mediaSrc(v.src);
  /* 试听也按 off 起播：听到的就是「留在成片里的那一段」，与合成出来的成片一致 */
  try { voiceElOf().currentTime = Math.max(0, Number(v.off) || 0); } catch (e) { /* 起播点设不上就从 0 配，不中断这一句 */ }
  /* 试听按**这一句合成后的音量**播（这一句 × 它所在那一行的基数；Audio 的音量上限是 1，所以 >100% 的那一段只在成片里生效）——
     以前试听永远用 100%，用户拖了音量条听不出区别，看起来就是「音量调不了」。 */
  try { voiceElOf().volume = Math.max(0, Math.min(1, voiceVolOf(v))); } catch (e) { /* 播放器此刻拒设音量就保持原音量，不打断播放 */ }
  /* 试听也按这一句自己那一档倍速放（与 `TlPlay.startVoices`、代理的 atempo 同一份 `voiceRateOf`）——
     只有成片变声而试听还是原速，用户拖完那枚滑块听不出区别，就又变成「调了没反应」那一类。 */
  try { voiceElOf().playbackRate = voiceRateOf(v); } catch (e) { /* 倍速设不上（元素未就绪）就按当前速度播 */ }
  /* 正在响的那一句高亮：一句话在本镜轨与全片轨各有一个块，两处一起亮 ——
     不然一片绿色块里分不出到底在放哪一句（尤其在编排配音的时候）。 */
  const mark = on => document.querySelectorAll('.tl-v[data-vid="' + id + '"]').forEach(x => x.classList.toggle('playing', on));
  document.querySelectorAll('.tl-v.playing').forEach(x => x.classList.remove('playing'));
  mark(true);
  voiceElOf().onended = () => mark(false);
  playSafe(voiceElOf(), () => { mark(false); setStatus('<span class="err">这句音频放不出来：' + (v.name || v.id) + '</span>'); });
}
/* 声音轨波形：解码 / 包络 / SVG 都在 waveform.js，这里只在画完之后后台填。 */
/* 一个声音块里那几样东西（波形盒 / 把手 / 音量数字）都靠它找 ——
   `CSS.escape` 不是标准 API（见全站约定），按 data 属性逐个比，别把 id 拼进选择器。 */
function voiceBlockOf(root, id) {
  if (!root || !root.querySelectorAll) return null;
  for (const el of root.querySelectorAll('.tl-v[data-vid]')) if (el.getAttribute('data-vid') === id) return el;
  return null;
}
/* 音量改了之后块上的那一层颜色与读数（判据不在这里：写数据只有 setCutVol 一个出口）。
   块上不再挂任何可调的东西 —— 以前这里还同步一条 `cursor: ns-resize` 的音量横条的 title，
   鼠标扫过音轨就变成「调整」箭头，而那块地方本来是「挪位置 / 试听」。 */
function paintVoiceVol(root, v) {
  const el = voiceBlockOf(root, v.id);
  if (!el) return;
  const vol = Number(v.vol == null ? 1 : v.vol);
  el.classList.toggle('quiet', vol < 1);
  el.classList.toggle('loud', vol > 1);
  const n = el.querySelector('.vn');
  if (n) { n.textContent = vol === 1 ? '' : Math.round(vol * 100) + '%'; n.hidden = vol === 1; }
}
/* 整个工程里「该进成片却进不了」的那几句（两条轨与右栏都问这一处，不各数各的）。 */
const orphanVoices = () => voicesEnsure().filter(voiceAdoptable);
const orphanVoicesOf = shotId => orphanVoices().filter(v => v.shotId === shotId);
/* 「搬回选用的这一镜」这道闸：返回空串 = 现在点得动，否则就是缺的那一样。
   按钮的 title 与 handler 问同一份（画一颗点了什么也不发生的按钮 = 界面承诺了一件做不到的事）。 */
function adoptWhy(sh) {
  if (!sh) return '这一镜已经不在了';
  if (laneLocked('voice')) return laneNm('voice') + '锁着，先解开「配音」那一行的锁';
  const c = (sh.candidates || []).find(x => x.vid === sh.selId);
  if (!c) return '这一镜还没有「用这条」选中的候选，搬过去没有落点';
  if (!segsOf(c, candDur(c, sh)).length) return '选中的那一条还没有画面段，搬过去没有落点';
  const list = orphanVoicesOf(sh.id);
  if (!list.length) return '这一镜没有被落下的配音';
  /* 行级那道闸（用户点名的第 19 条：加出来的那一行也能锁）：搬一句要改它的锚点与位置，
     锁着的那一行不许被改 —— 与轨道上拖块、剪子、滑块问的是同一份 `rowLocked`。 */
  const badLn = list.map(v => voiceLn(v)).find(ln => rowLocked('voice', ln));
  if (badLn != null && rowLocked('voice', badLn)) {
    return rowNm('voice', badLn) + '锁着，先解开这一行的锁（搬一句要改它挂在第几段、第几秒）';
  }
  return '';
}
/* 把这一镜的孤句搬回**选用的那一条候选**上：只换锚点（`candId` / `seg`），不动音频。
   `at` 按段内偏移原样带过去，超出新段选区的那一截夹回来；`fa/fb`（框）跟着**同量平移** ——
   与画面剪一刀时 `reanchorVoices` 同一个口径，否则搬完一句，框内那两块灰指着的是旧位置。 */
function adoptOrphanVoices(sh) {
  const why = adoptWhy(sh);
  if (why) return { ok: false, why };
  const c = (sh.candidates || []).find(x => x.vid === sh.selId);
  const segs = segsOf(c, candDur(c, sh));
  const list = orphanVoicesOf(sh.id);
  list.forEach(v => {
    const si = Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0));
    const at0 = Math.max(0, Number(v.at) || 0);
    const at = round1(Math.min(at0, Math.max(0, segLen(segs[si]) - VOICE_MIN)));
    const d = at - at0;
    const fr = voiceFrameOf(v);
    v.candId = c.vid; v.seg = si; v.at = at;
    v.fa = round1(fr.fa + d); v.fb = round1(fr.fb + d);
  });
  return { ok: true, n: list.length };
}
/* ---------------- 配音的「无限多行」（用户点名「配音应该能有无限多条轨道」）----------------
   `v.ln` = 这一句在第几行（默认 0 —— 老数据一个键都没有，与从前一模一样，不用迁移）。
   **不自动挤开**：块落在哪一行只由这个数说。自动排行的话，同一句在「本镜」那一排与「全片」
   那一排的重叠集合不是同一个（本镜只看这条候选的段，全片看所有镜），切一次页就跳一次行，
   而用户刚刚亲手把它拖到第二行等于白拖。换行的手势 = 上下拖块体（见 bindVoiceLane ②）。
   行数只数「画出来的块」：轨道行**按数据长**，不是按时间挤 —— 空着的中间行照样画，
   抽掉空行会把它上面那一行往下一格，而那一格正好是插针与刻度尺对齐的地方。 */
const voiceLn = v => laneClamp(Number(v && v.ln) || 0);
/* 按轨号把 HTML 分桶（`per` 是稀疏数组：只有真画了块的行占位，长度 = 最高那一行 + 1）。 */
function lanePut(per, v, html) {
  if (!html) return;
  const ln = voiceLn(v);
  per[ln] = (per[ln] || '') + html;
}
function voiceLanesHTML(per, rows, hint) {
  let out = '';
  const any = per.some(x => !!x);
  for (let i = 0; i < rows; i++) {
    const body = per[i] || '';
    /* 那句说明只在**整条轨都空着**时出现在第一行（用户自己加了轨道、一句还没摆，
       那一行正该告诉他去哪儿加）；一旦有块，空行就是空行，不要每条都喊一遍。
       `hid` = 只收起**这一行**（左列那一格与这一条必须同高，见 CSS 那两条 `--tlh-min`）。 */
    out += `<div class="tl-lane${rowHidden('voice', i) ? ' hid' : ''}" data-ln="${i}">` + (body
      || (i === 0 && !any ? '<span class="lane-hint">' + hint + '</span>' : '')) + '</div>';
  }
  return out;
}
/* 左边那一列的轨名行要跟着右边几行一起长（两列一张网格，行高由同一批变量决定）。
   数的是**已经画出来的行**，所以这里读 DOM 而不是重算一遍数据 —— 重算就是第二份口径，
   两排（本镜 / 全片）各自的分桶规则一旦漂开，标签就会指着错的那一行。
   多出来的标签行是 `.tl-side` 的**直接子节点**（不是把一行 div 撑高）：
   网格的行距只由 `.tl-side` 的 gap 决定，撑高那一个 div 会让下面的行整体错位。 */
/* 一行标签上的四件套（用户点名的第 19 条：加出来的那一行也要有收起 / 锁定 / 添加 / 音量）：
   眼睛（收起**这一行**）· 锁（只锁**这一行**）· ＋（在**这一行**下面插一行）· 音量滑块 + 读数。
   第 1 行是锚行，它那两颗走的是轨级 act（`hide` / `lock`）—— 不是给它单开一套判据：
   `rowHidden` / `rowLocked` 在 `ln<=0` 本来回退到轨级，锁与收起都管整条轨（与 ⑰f/⑰g 量的那颗是同一个东西）。
   `disabled` 与 title 里「为什么按不动」不在这里定：拼模板那一刻量到的是上一次渲染留下的行数，
   刚把一块拖到第 2 行、按钮却还按第 1 行点亮 —— 交给画完之后的 `syncLaneSide` 现量现写。 */
function laneRowCtlHTML(k, ln) {
  const nm = k === 'voice' ? '配音' : '画面';
  const hid = rowHidden(k, ln), lock = rowLocked(k, ln);
  const vol = laneVol(k, ln);
  const who = ln > 0 ? nm + '轨第 ' + (ln + 1) + ' 行' : nm + '轨第 1 行（整条轨）';
  const one = k === 'voice' ? '句' : '段';
  /* 第 1 行那枚滑块 = **整轨音量**（用户点名的第 ② 条）：与右栏「整轨音量」同一批字段
     （段 / 句自己的 vol），不是行基数 —— 初值取这一排此刻都同一档时的那一个数，
     不一致时由 syncLaneSide 写「不一」并把拇指停在第一个数上。 */
  const tv = ln > 0 ? null : trackOne(trackOwnVol(k));
  const shown = ln > 0 ? vol : (tv.one != null ? tv.one : (tv.first != null ? tv.first : 1));
  const rdTxt = ln > 0 ? Math.round(vol * 100) + '%' : (tv.one != null ? Math.round(tv.one * 100) + '%' : '不一');
  return `<button type="button" class="tl-hbtn" data-lane="${k}" data-ln="${ln}" data-lane-act="${ln > 0 ? 'rhide' : 'hide'}"`
    + ` title="${hid ? '展开' : '收起'}${who}（${hid ? '这一行重新长出来，块还挂在原来的行号上' : '只收这一行：块与把手都不画，别的行与另一轨不受影响'}）">${icon(hid ? 'eyeOff' : 'eye', 12)}</button>`
    + `<button type="button" class="tl-hbtn${lock ? ' on' : ''}" data-lane="${k}" data-ln="${ln}" data-lane-act="${ln > 0 ? 'rlock' : 'lock'}"`
    + ` title="${lock ? who + '已锁定：这一行上的块拖不动、剪不了，音量也不调（点一下解锁）' : '锁定' + who + '：锁上之后拖不动、剪不了，免得调隔壁时误改这一行'}">${icon('lock', 12)}</button>`
    + `<button type="button" class="tl-hbtn" data-lane="${k}" data-ln="${ln}" data-lane-act="row+"`
    + ` title="在${who}下面加一行：下面那些行整体往下挪一格，块上的时间与倍速一个字不动">${icon('plus', 11)}</button>`
    + `<input type="range" class="tl-hvol-sl" data-lane="${k}" data-ln="${ln}" min="0" max="200" step="0.1"`
    + ` value="${Math.round(shown * 1000) / 10}" aria-label="${ln > 0 ? nm + '轨第 ' + (ln + 1) + ' 行的音量' : '整条' + nm + '轨的音量'}">`
    + (ln > 0
      ? `<i class="tl-hvol" title="${who}的基数 ${Math.round(vol * 100)}%：这一行上每一${one}都跟着一起${vol < 1 ? '变轻' : vol > 1 ? '变响' : '不变'}，段 / 句自己那枚音量在它之上再乘">${icon('speaker', 10)}<b class="tl-hvol-n">${rdTxt}</b></i>`
      : `<button type="button" class="tl-hvol${laneMute(k) ? ' mut' : ''}" data-lane-mute="${k}"`
        + ` title="点一下把整条${nm}轨${laneMute(k) ? '取消静音' : '静音'}：${laneMute(k) ? '恢复之后每一段 / 每一句回到原来的音量' : '预览与成片这一轨都不出声，每一段 / 每一句的音量原样留着'}；旁边的滑块调整轨音量（现在 ${rdTxt}）">`
        + `${icon(laneMute(k) ? 'speakerOff' : 'speaker', 10)}<b class="tl-hvol-n">${rdTxt}</b></button>`);
}
function laneSideRowHTML(k, ln, blocks) {
  const nm = k === 'voice' ? '配音' : '画面';
  const hid = rowHidden(k, ln);
  const tip = laneNm(k) + '第 ' + (ln + 1) + ' 行：这一行上的块上下拖就能换行；'
    + '眼睛收这一行、锁只锁这一行、＋ 在这一行下面插一行、滑块调这一行的基数音量（与右栏那两枚滑块同一个数）。';
  /* 收起的那一行照样要有这一格（左边窄条 + 右边窄条同高，行号才不会与刻度尺错开）：
     `.hid` 只把滑块、读数、＋、× 藏掉（见 CSS 那一条），名与眼睛、锁留着 —— 否则收起的行再也展不开。 */
  return `<div class="tl-hrow ${k} extra${hid ? ' hid' : ''}" data-ln="${ln}" title="${esc(tip)}">`
    + `<span class="tl-hname">${nm} ${ln + 1}</span>` + laneRowCtlHTML(k, ln)
    /* 每一行（第 2 行往上）各有一颗自己的「×」（用户点名的第 ⑤ 条：多添加出来的轨道要能独立删除）。
       从前这一颗只挂在**空的最后一行**上，于是摆过东西的第 2、3 行永远删不掉。
       删一行不吞内容：这一行的块并到上面那一行，再往下的行补位（判据与回执都在 `dropLaneRow`）。
       第 1 行不画 —— 它是锚行，整条轨至少留一行，收整条轨用轨名旁那颗眼睛。 */
    + `<button type="button" class="tl-hbtn" data-lane="${k}" data-ln="${ln}" data-lane-act="row-"`
    + ` title="删掉${nm}轨第 ${ln + 1} 行${blocks ? '（这一行上有 ' + blocks + ' 个块：它们并到第 ' + ln + ' 行，'
      + '再往下的行往上补一格；入出点、时长、倍速与配音都不动）' : '（这一行是空的，入出点、音量与配音都不动）'}">${icon('minus', 11)}</button>`
    + '</div>';
}
/* 轨名那一格的名字（第 1 行）：四件套由 `laneRowCtlHTML` 出，这里只给名字。
   收行不在锚行这一格 —— 它画在**要收掉的那一行**的标签上（见 laneSideRowHTML 的 `row-`）：
   「−」挂在锚行上指的是最后那一行，而最后那一行离按钮隔着好几行，点的人得先在脑子里换算一次。 */
function laneRowBtnsHTML(k) {
  return `<span class="tl-hname">${k === 'voice' ? '配音' : '画面'}</span>`;
}
function syncLaneSide(col, bar) {
  const side = col && col.querySelector('.tl-side');
  if (!side || !bar) return;
  /* 待生成配音那一行标签是**画完轨道之后**才补的（与 extra 行同一个时机）：
     先摘掉上一趟那一枚，否则每 3 秒整栏重画一次就叠一层。 */
  side.querySelectorAll('.tl-hrow.pend').forEach(x => x.remove());
  ['pic', 'voice'].forEach(k => {
    const anchor = side.querySelector('.tl-hrow.' + k);
    if (!anchor) return;
    const rows = [...bar.querySelectorAll(LANE_ROW_SEL[k])];
    const n = Math.max(1, rows.length);
    /* 每一行上摆了几个块要**现在量**（右栏那一排的节点，不是重算一遍数据 —— 与标签行同一口径）：
       它只进那颗「×」的 title，删行的动作本身不读它（`dropLaneRow` 把块并到上面那一行）。 */
    side.querySelectorAll('.tl-hrow.' + k + '.extra').forEach(x => x.remove());
    let extra = '';
    for (let i = 1; i < n; i++) {
      const el = rows[i];
      extra += laneSideRowHTML(k, i, el ? el.querySelectorAll('.tl-seg, .tl-v').length : 0);
    }
    anchor.insertAdjacentHTML('afterend', extra);
    /* 每一格的「＋/×/眼睛/锁/滑块/读数」在这里**逐行**现量现写（用户点名的第 19 条：
       加出来的那一行也要有这四件事）。标记里那份是画出来那一刻按同一份数据填的初值，
       这里只补两件事：① 按**这一行**的收起/锁定/上限算 disabled 与「为什么按不动」，
       ② 把滑块与读数对齐 `laneVol(k, 这一行)` —— 刚拖完一块到新行、整栏还没重画时，
       那一格的读数要指着它自己那一行的基数，不能还挂着上一次渲染留下的数。
       `addLaneRow` / `dropLaneRow` / `rowFlagToggle` / `setLaneVol` 是同一份判据的落地方，
       按钮只是把它们的拒绝提前显示出来，这里不另判一份。 */
    const nm = laneNm(k);
    side.querySelectorAll('.tl-hrow.' + k).forEach(cell => {
      const ln = cell === anchor ? 0 : laneClamp(cell.dataset.ln);
      const full = n >= TRACK_LANES_MAX, hid = rowHidden(k, ln), lock = rowLocked(k, ln);
      const plus = cell.querySelector('[data-lane-act="row+"]');
      if (plus) {
        plus.disabled = full || hid;
        plus.title = hid ? (ln > 0 ? rowNm(k, ln) + '此刻是收起的，加了也看不见：先点这一行上那颗眼睛展开'
            : nm + '此刻是收起的，加了也看不见：先点旁边那颗眼睛展开')
          : full ? nm + '已经到 ' + n + ' 行，这是上限（再多左边那一列标签自己就要滚起来了）'
            : (ln > 0 ? '在' + rowNm(k, ln) + '下面插一行：下面那些行整体往下挪一格，块上的入出点、倍速、配音与三张按行的表（音量 / 收起 / 锁定）跟着一起挪'
              : '给' + nm + '加一行（挂在最下面）：现在 ' + n + ' 行，块上下拖就能挪过去');
      }
      /* 「×」只有第 1 行不画，其余都能点；只剩一行时（n<=1）压根没有 extra 行。
         收起的那一行删不了（行高 18px，删了看不见）—— 问的是**这一行**收没收，不是整条轨。 */
      const minus = cell.querySelector('[data-lane-act="row-"]');
      if (minus) {
        minus.disabled = hid;
        if (hid) minus.title = rowNm(k, ln) + '是收起的，删了看不见：先点这一行上那颗眼睛展开';
      }
      /* 眼睛与锁**永不 disabled** —— 它们正是「让这一行重新能动、能看见」的那颗出口。 */
      const eye = cell.querySelector('[data-lane-act="rhide"], [data-lane-act="hide"]');
      if (eye) eye.disabled = false;
      const lk = cell.querySelector('[data-lane-act="rlock"], [data-lane-act="lock"]');
      if (lk) {
        lk.disabled = false;
        lk.classList.toggle('on', lock);
        lk.title = lock ? rowLockWhy(k, ln) + '：' + rowUnlockHow(k, ln) + '（点一下解锁）'
          : '锁定' + rowNm(k, ln) + '：锁上之后这一行上的块拖不动、剪不了，这一行的基数音量也不调，'
            + (ln > 0 ? '免得调隔壁时误改这一行（别的行与另一轨不受影响）' : '整条轨每一行都跟着锁');
      }
      const sl = cell.querySelector('.tl-hvol-sl');
      const rd = cell.querySelector('.tl-hvol-n');
      const box = cell.querySelector('.tl-hvol');
      /* 锚行（第 1 行）= **整轨音量**：读数取这一排此刻都同一档时的那一个数，不一致写「不一」；
         extra 行仍是这一行的基数（用户点名的第 19 条，四件套那一半保持原样）。 */
      const tv = ln > 0 ? null : trackOne(trackOwnVol(k));
      const val = ln > 0 ? laneVol(k, ln) : (tv.one != null ? tv.one : (tv.first != null ? tv.first : 1));
      const rdTxt = ln > 0 ? Math.round(val * 100) + '%'
        : (tv.one != null ? Math.round(tv.one * 100) + '%' : '不一');
      if (sl) {
        sl.disabled = lock;
        sl.value = String(Math.round(val * 1000) / 10);
        sl.title = (lock ? rowLockWhy(k, ln) + '：' + rowUnlockHow(k, ln) + '之后才能调。' : '')
          + (ln > 0
            ? rowNm(k, ln) + '的基数音量：与右栏那一枚是同一个数，这一行上每一' + (k === 'voice' ? '句' : '段') + '都跟着一起变'
            : '整条' + nm + '轨的音量：把这一排每一' + (k === 'voice' ? '句' : '段') + '自己的音量都设成这一档'
              + (tv.one == null && tv.kinds > 0 ? '（此刻有 ' + tv.kinds + ' 档，拇指停在第一档上）' : '')
              + '；与右栏那枚「整轨音量」同一个数，段 / 句自己那枚在下面各调各的');
      }
      if (rd) rd.textContent = rdTxt;
      if (box) {
        if (ln > 0) {
          box.title = rowNm(k, ln) + '的基数 ' + Math.round(val * 100) + '%：这一行上每一'
            + (k === 'voice' ? '句' : '段') + '都跟着一起' + (val < 1 ? '变轻' : val > 1 ? '变响' : '不变')
            + '，段 / 句自己那枚音量在它之上再乘';
        } else {
          const mut = laneMute(k);
          box.classList.toggle('mut', mut);
          box.innerHTML = icon(mut ? 'speakerOff' : 'speaker', 10) + '<b class="tl-hvol-n">' + rdTxt + '</b>';
          box.title = '点一下把整条' + nm + '轨' + (mut ? '取消静音' : '静音') + '：'
            + (mut ? '恢复之后每一段 / 每一句回到原来的音量' : '预览与成片这一轨都不出声，每一段 / 每一句的音量原样留着')
            + '；旁边的滑块调整轨音量（现在 ' + rdTxt + '）';
        }
      }
    });
  });
  /* 待生成配音那一行标签排在**配音轨所有行之后**（用户点名：它应该在默认配音轨下方）：
     右边那一排斜纹占位（`.tl-vp-lane`）画了几条，这里就补一行同高的标签，
     两列的插针与刻度尺才不会错开一格。配音轨收起时两边一起不画。 */
  if (!laneHidden('voice')) {
    const pend = bar.querySelectorAll('.tl-vp-lane .tl-vp');
    const last = [].slice.call(side.querySelectorAll('.tl-hrow.voice')).pop();
    if (pend.length && last) last.insertAdjacentHTML('afterend',
      '<div class="tl-hrow pend" title="' + esc(pend.length + ' 句台词还没有合成：轨道上那些斜纹占位就是它们 —— 点一下把那一句填进右栏「生成配音」，并按说话人去素材库取音色描述 / 参考音频') + '">'
      + icon('mic', 10) + '<span class="tl-hname">待生成 ' + pend.length + '</span></div>');
  }
  /* 字幕行标签排在所有行之后（右列画了几条 `.tl-sub-lane`，这里就补一行同高的标签）。 */
  side.querySelectorAll('.tl-hrow.sub').forEach(x => x.remove());
  const subLane = bar.querySelector('.tl-sub-lane');
  if (subLane) {
    const last = [].slice.call(side.querySelectorAll('.tl-hrow')).pop();
    if (last) last.insertAdjacentHTML('afterend',
      '<div class="tl-hrow sub" title="字幕行：块按成片 / 本镜的时间摆，点一下跳到这里；改字在右栏「字幕」">'
      + icon('docTab', 10) + '<span class="tl-hname">字幕</span></div>');
  }
}
function voiceLaneHTML(sh, c, total, g) {
  const segs = c ? segsOf(c, total) : [];
  const G = g || shotFrames(segs);
  const ax = shotAxTotal(G, total);
  const mine = c ? shotVoices(sh.id, c.vid) : [];
  /* 这一排时间基（**轴秒**）上的灰场区间：一句配音压在灰场上时，那几秒**跳过**
     （音频在灰场起点停住、越过整段之后接着放，内容一秒不丢），块顺延拉长、重合处画灰带。
     `voiceRuns` 是唯一的算法；取法收在 `axisGray` 一份（两条轨共用）——
     首屏（这里）与拖动中的重画（bindVoiceLane 的 paintVoice）读同一个数。 */
  const gray = axisGray(G);
  const per = [];
  mine.forEach(v => {
    const si = Math.min(segs.length - 1, Math.max(0, Number(v.seg) || 0));
    const s = segs[si], r = G.rows[si];
    if (!s || !r) return;
    /* 与 `filmVoiceHTML` 走同一份折算（`voiceAxBox`）：这一排的格子来自这条候选自己的段。 */
    const bx = voiceAxBox(r, v);
    lanePut(per, v, voiceBlockHTML(v, bx.box, bx.sel, ax,
      '第 ' + (si + 1) + ' 段 +' + round1(bx.fr.fa / bx.spd) + ' 秒起，长 ' + round1(bx.dur) + ' 秒'
        + (bx.fr.fb - bx.fr.fa > bx.dur * bx.spd + 0.02 ? '（这一句共 ' + round1((bx.fr.fb - bx.fr.fa) / bx.spd) + ' 秒，灰掉的不进成片）' : ''),
      { gray }));
  });
  /* 别的镜上锚的、但压进本镜这一段时间里的那些：换算成本镜**轴秒**后画成半透明的只读块。
     取不取得到取决于这一镜在不在成片里（不在成片里的镜头没有框基位置，也就画不出来 ——
     那种情况下界面上不该凭空多一块，画不出来是对的）。
     判据只有两问：**有没有重叠**、**它自己有没有已经在上面画过**（本镜自己的那一句
     在这里会整段落在本镜里，重复画就变成两块叠着）。不再绕第三问。 */
  if (c) {
    const FG = filmFrames(tlSyncFromShots());
    const hereRows = FG.rows.filter(r => r.cl.kind === 'shot' && r.cl.shotId === sh.id);
    if (hereRows.length) {
      const hereFrom = Math.min(...hereRows.map(r => r.start));
      const hereTo = Math.max(...hereRows.map(r => r.start + r.w));
      const drawn = new Set(mine.map(v => v.id));
      voicesEnsure().forEach(v => {
        if (v.shotId === sh.id && v.candId === c.vid) return;        // 本镜自己的，上面画过了
        if (drawn.has(v.id)) return;
        const span = voiceFilmSpan(v);
        if (!span || span.to <= hereFrom + 0.03 || span.from >= hereTo - 0.03) return;
        drawn.add(v.id);
        /* 与本镜那一段重叠的那部分：成片轴秒 → 本镜源秒（frameToSrc），
           再由本镜那一排的 `shotPinT` 换成**本镜轴秒**（两个口径的倍速各折算一次）。 */
        let srcLo = null, srcHi = null;
        for (const r of hereRows) {
          const a = Math.max(span.from, r.start), b = Math.min(span.to, r.start + r.w);
          if (b - a <= 0.03) continue;
          const s1 = frameToSrc(r, a), s2 = frameToSrc(r, b);
          srcLo = srcLo == null ? s1 : Math.min(srcLo, s1);
          srcHi = srcHi == null ? s2 : Math.max(srcHi, s2);
        }
        if (srcLo == null) return;
        const axLo = shotPinT(G, srcLo), axHi = shotPinT(G, srcHi);
        if (axHi - axLo <= 0.03) return;
        const other = allShots().find(x => x.id === v.shotId);
        /* 只读的那一截：框与选区都取「压进本镜的这一片」—— 它在自己那一镜才有真正的框，
           在这里凭空画出一个更宽的框会让人以为能拖。 */
        const w = round1(axHi - axLo);
        lanePut(per, v, voiceBlockHTML(v, { l: round1(axLo), w: w }, { l: round1(axLo), w: w }, ax,
          '这一句锚在「' + ((other && other.name) || '别的镜头') + '」，压到本镜这一排的第 '
          + round1(axLo) + '–' + round1(axHi) + ' 秒 —— 在这里只能试听，要改它请切到它自己那一镜', { spill: true, gray }));
      });
    }
  }
  /* 行数按数据长（最高那一行 + 1），这一轨收起来时只留一行。
     这一镜被落下的孤句在这一排**不画块**（它们锚的是没选用的那条候选，在成片里没有位置 ——
     凭空画一块会让人以为剪完能进成片），但空着的那一行要说清为什么空。 */
  const orph = orphanVoicesOf(sh.id).length;
  return voiceLanesHTML(per, laneHidden('voice') ? 1 : laneRowsFor('voice', per.length),
    orph ? laneNm('voice') + '：这一镜有 ' + orph + ' 句配音挂在没被选用的候选上，进不了成片 —— 右栏点「搬回选用的这一镜」'
      : laneNm('voice') + '：在右栏合成一句配音，它会落在插针指着的那一段');
}
/* 这一条声音行上的交互。`o = { total, film, G }`：
     · total —— 这一排的**时间基总长（轴秒）**。像素↔秒全靠它，
       而它跟画面上那一排是同一个数，所以声音块永远与它所属的那一格对齐；
     · film —— 这一排是全片那一排（按成片秒、格子来自时间线）；不给 = 本镜那一排（格子来自
       这一条候选自己的 `segs`，来自 `G`）；
     · G —— 本镜那一排的轴行表（`shotFrames` 现算的那一份，画格子用的就是它，必须与块同源）。
   两排**只剩「格子从哪来」这一个差别**：倍速折算、灰场、拖动落点、就地重画全走同一份
   （`voiceAxBox` / `axisGray` / `moveVoiceTo`）。以前本镜那一排按候选**源秒**摆、系数恒 1，
   于是拖倍速滑块时画面格缩了而配音块一动不动 —— 用户点名的正是这一件。
   ⚠ 落点那一步只管「**起点**落在哪一格」，**不管尾巴**：配音的尾巴从来不必留在起点那一格内，
     它可以越过格子右沿进后面那一段、下一镜（合成与预览两边都按整句放）。
   三个手势各占一个位置，互不打架：块体 = 移动、左右两条边 = 剪切；
   **单击**（没位移）= 选中 + 试听。删掉这一句不在块上 —— 它在点中之后出现的那根剪辑条上，
   与画面轨一样（块里塞按钮会被 34px 高的行挤成一团，也是「找不到删除按钮」的由来）。 */
const VOICE_MIN = 0.2;                       // 一句配音最短留 0.2 秒
/* 这一次指针动作是「拖动」还是「单击」：**按下时清零、拖过记下是哪一块**，click 读一次就清掉。
   ⚠ 原来是「拖动置位、click 里复位」，那个写法有一个必然卡死的洞：拖**把手**时手指会离开块体，
     松手落在块外，浏览器**不派发 click**（drag 之后 click 只在起落同一个元素上才有），
     于是标志位永远停在 true，接下来真正的单击被当成「刚拖完」吞掉：点块不选中、不试听，
     看着像「点不动了」。
   为什么还要记**是哪一块 + 什么时候**：一个不分归属的布尔值会把「拖了 A 块之后去点 B 块」
   也一起吞掉（那时 B 根本没被拖过）。所以记 vid 与时刻，click 时两样都要对得上才算「刚拖完」。 */
let voiceDragged = false, voiceDragId = '', voiceDragT = 0;
const VOICE_DRAG_MS = 600;                    // 超过这么久还不算「同一次动作的余波」
/* 记下「刚拖过的是哪一块、什么时候」——判据只此一处，块体拖动与两个把手剪切都走它。 */
function markVoiceDrag(id) { voiceDragged = true; voiceDragId = id || ''; voiceDragT = Date.now(); }
/* 「这一下 click 是不是刚才那次拖动的余波」：同一块 + 时限内才算。 */
function voiceWasDragged(id) {
  if (!voiceDragged) return false;
  const same = voiceDragId === id;
  const fresh = (Date.now() - voiceDragT) <= VOICE_DRAG_MS;
  voiceDragged = false; voiceDragId = '';
  return same && fresh;
}
function bindVoiceLane(row, o) {
  const opt = o || {};
  const total = Math.max(0.1, Number(opt.total) || 0);
  /* 这一排的轴行表：全片来自时间线（现算，格子可能刚被别的镜改过），本镜来自画格子那一份 `G`。
     两者必须与首屏渲染用的是同一套行 —— 否则「首屏按轴、拖动中按源」，倍速那一格上拖一下块会跳。 */
  const shotG = opt.film ? null : (opt.G || { rows: [], total: Math.max(0.05, total) });
  const frames = () => (opt.film ? filmFrames(tlSyncFromShots()) : shotG);
  /* 拖动中的重画只改这一个块：框的 left/width（只有挪位置才变）+ 框内那两块灰的宽度
     （剪切变的是它们，块的左右沿一个字都不动）。
     不重画整栏 —— 那会把手指底下的节点销毁，也会连带把整排切片重贴一遍。 */
  /* 这一句所属的那一格：本镜按段号取行，全片按「镜头 + 候选 + 段」三样取行。
     ⚠ 首屏渲染与拖动中的重画必须同源：本镜这一支以前直接返回 `v.at`，而渲染用的是 `s.in + v.at`，
     段被向左切过（s.in > 0）之后两个算式差一个 `s.in`，拖把手时的重画位置与首屏对不上 ——
     看着就成了「左边也在动、长度也在变」（用户报的「不是覆盖左右而是整体缩放」）。
     现在两排都只走 `voiceAxBox` 那一份算式（它的 base 就是「那一格的轴起点 + 画面选区左沿」），
     所以这里只负责**找对那一行**，不再各拼一份位置。 */
  const voiceRowOf = v => {
    const si = Math.max(0, Number(v.seg) || 0);
    const rows = frames().rows || [];
    return (opt.film
      ? rows.find(x => x.cl && x.cl.kind === 'shot' && x.cl.shotId === v.shotId && x.cl.candId === v.candId
        && (Number(x.cl.seg) || 0) === si)
      : rows.find(x => Number(x.i) === si)) || null;
  };
  /* 块上量的那几样（`fa/fb/at/dur`）都是**音频 / 源秒**，摆到轴上要按所属那一格的倍速折算；
     两个方向都要：摆上去除（`voiceAxBox`），从像素位移回到数据要乘（把手那边用 `voiceSpdOf`）。 */
  const voiceSpdOf = v => { const r = voiceRowOf(v); return r ? r.spd : 1; };
  /* 全片那一排：位移到别的格子上时连镜头/候选/段一起换掉 ——
     于是可以把一句话从这一镜挪到那一镜（数据里 voice 本来就带 shotId/candId/seg，
     与剪映在同一条时间线上拖音频是一回事）。落在黑场格（或插入的素材格）上就原地不动、返回 false。
     本镜那一排同一份代码：那里换不到别的镜，只是换段（同一条候选切出来的几段）。
     `tAx` = 拖动手势的落点，按**框左沿**在这一排的轴上量（块体按住的正是框左沿那一带）。 */
  const moveVoiceTo = (v, tAx) => {
    const rows = frames().rows || [];
    if (!rows.length) return false;
    let hit = rows[rows.length - 1];
    for (const r of rows) { if (tAx < r.start + r.w) { hit = r; break; } }
    if (opt.film && (!hit.cl || hit.cl.kind !== 'shot')) return false;
    const fr = voiceFrameOf(v), selOff = Math.max(0, Number(v.at) || 0) - fr.fa;   // 选区相对框左沿，拖动中不变
    /* 落点 → 源秒走 frameToSrc（轴秒 × 这一格的倍速）：以前本镜那一排没有这一道（源秒当轴秒用），
       全片那一排写的是 `hit.a + (tFrame - hit.start)`，都只在「一格 1 倍速」时对得上 ——
       2 倍速时块会停在指针左边一截。 */
    const tSrc = frameToSrc(hit, tAx);
    const segIn = rowSelIn(hit), keep = Math.max(0.05, rowSelOut(hit) - segIn);
    if (opt.film) { v.shotId = hit.cl.shotId; v.candId = hit.cl.candId; v.seg = Number(hit.cl.seg) || 0; }
    else v.seg = Number(hit.i) || 0;
    /* 只夹**选区起点**（它必须留在这一格里 —— `seg` 的归属凭据就是这一个数，`clipVoices` 按
       「起点还在不在这一段」判孤儿），**尾巴放开**：可以越到后面那一格、下一镜（用户点名的
       「音频不能跨越不同视频片段」）。以前上界是 `keep - selOff - dur`，于是「3 秒的格子配一句
       6 秒的台词」被硬按在段首附近，往右一拖就停 —— 而合成那一边现在也按这个口径放开了
       （代理 `room` = 本句时长并夹到片尾），预览与成片听的是同一句。
       拖动中途不量化，见 `roundVoice`。 */
    v.fa = Math.max(0, Math.min(tSrc - segIn, Math.max(0, keep - selOff)));
    v.fb = v.fa + (fr.fb - fr.fa);
    v.at = v.fa + selOff;
    return true;
  };
  /* 就地重画一块：框的 left/width + 框内两块灰的宽度 + 灰带 + 顺延后的标签。
     `put` 只在「这一截有宽度」时才补节点，没有就把已有的压成 0%（摘掉节点会让下一次
     又要插入，而插入位置靠 afterbegin —— 两块灰的先后顺序会翻）。 */
  const paintVoice = v => {
    const el = row.querySelector('.tl-v[data-vid="' + v.id + '"]');
    const r = voiceRowOf(v);
    if (!el || !r) return;
    /* 与首屏（`voiceLaneHTML` / `filmVoiceHTML`）同一个 `voiceAxBox`：块、选区、灰场
       全在这一排的轴秒上量 —— 拖动中若退回源秒，倍速那一格里松手会跳位。 */
    const bx = voiceAxBox(r, v);
    /* 灰场按**这一排自己的尺子**取（与首屏 voiceBlockHTML 的 `opt.gray` 同源）：
       拖块 / 拖把手改的正是「它压不压在灰场上」，拉长与灰带要跟着手指当场重画 ——
       少了这一段，拖动中块不加长、不画带，松手一整栏重画才跳到位。 */
    const gray = axisGray(frames());
    const lay = voiceRuns(bx.sel.l, bx.sel.w, gray);
    const boxL = bx.box.l;
    const right = Math.max(boxL + bx.box.w, lay.end);
    const w = Math.max(0.05, right - boxL);
    el.style.left = pct(boxL, total) + '%';
    /* 左沿与宽度都摆到这一排的尺子上（`bx` 已经除过倍速），而框内两块灰 / 灰带算的是**块内比例**
       （分子分母同为这一排的秒，倍速约掉了）—— 两处不同尺子，漏一处就是
       「首屏按轴、拖动中按源」，2 倍速那一格上拖一下块会跳。 */
    el.style.width = pct(w, total) + '%';
    /* 两块灰与灰带共用这一个 `put`，分母是**拉长后**的块宽 `w`（与 voiceBlockHTML 同一算式）——
       用拉长前的框宽当分母会把它们画错宽度（块越长错得越多）。 */
    const put = (sel, sec, cls) => {
      const wp = pct(sec, w) + '%';
      const n = el.querySelector(sel);
      if (n) n.style.width = wp;
      else if (sec > 0.02) el.insertAdjacentHTML('afterbegin', '<span class="' + cls + '" style="width:' + wp + '"></span>');
    };
    put('.vo-off:not(.r)', bx.sel.l - boxL, 'vo-off');
    put('.vo-off.r', Math.max(0, right - Math.max(bx.sel.l + bx.sel.w, lay.end)), 'vo-off r');
    /* 灰带整批重建：拖动中压上的灰场条数会变（挪一下可能就压上了、再挪又不压），
       逐条对号入座不如推倒重来；`pointer-events:none`，不碍下面那两颗把手。 */
    el.querySelectorAll('.vo-skip').forEach(n => n.remove());
    (lay.skips || []).forEach(b => {
      if (b[1] - b[0] <= 0.02) return;
      el.insertAdjacentHTML('afterbegin', '<span class="vo-skip" style="left:' + pct(b[0] - boxL, w)
        + '%;width:' + pct(b[1] - b[0], w) + '%"></span>');
    });
    el.classList.toggle('over', (lay.skips || []).length > 0);
    /* 块上那行小字的秒数也跟着走：以前拖动中只改位置与两块灰，那句「· 3.2s」还是加进来时的数 ——
       剪完长度那行字不认，看着像「改了个样子，其实什么都没改」。
       数的是「这一句在**成片里**念几秒」（`voiceRuns` 的 `filmSec`，与 voiceBlockHTML 的 `shownSec` 同源）：
       块在轨道上拉长的是占位，压到剪掉的头 / 尾那几秒并不进成片，读数不能跟着涨。 */
    const lab = el.querySelector('.vt');
    if (lab) lab.textContent = voiceBlockText(v, lay.filmSec);
  };
  /* 拖动的统一骨架：按下 → 记起点与「拖动前的那一份数据」→ 移动按位移改数据并只重画这一块 →
     松手才落盘。三个手势（移动 / 左剪切 / 右剪切）共用它，区别只在 move 里怎么改。
     `skipHandles` 只有「拖块体」那一路才传 true：落在把手 / 音量条上的按下不算拖块体。
     以前这一层判定写在别处（一个空的 pointerdown 监听 + 回调里再判一次），而把手那边虽然
     `stopPropagation` 过，判定位置与事件传播并不一致 —— 于是拖把手时块体那一路也跟着跑。
     现在**只有一个判据、一个位置**（就在这里），与事件怎么冒泡无关。 */
  const bindDrag = (el, start, skipHandles) => {
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      /* `.spill` = 别的镜上溢出进来、只读的那一截：不给它拖/剪/调音量（它锚在别的镜的候选上，
         本镜这一排的行表里没有它那一行，拖了会拿错段长与上界）。只留试听。 */
      if (el.classList.contains('spill')) return;
      /* 锁问的是**这一块自己那一行**（整条轨锁着时每一行都锁）：锁了第 2 行，第 1 行的句子照样能拖。 */
      const dLn = laneClamp(Number((el.closest('.tl-lane') || row).dataset.ln) || 0);
      if (rowLocked('voice', dLn)) {
        /* 锁住这一行：手势一个都不接，但要说清为什么接不上（否则看着像「拖不动」的 bug） */
        e.preventDefault(); e.stopPropagation();
        setStatus('<span class="err">' + rowLockWhy('voice', dLn) + '：' + rowUnlockHow('voice', dLn)
          + '后才能拖、能剪（点一下仍可选中，不会自动播放）</span>');
        return;
      }
      if (skipHandles && e.target && e.target.closest && e.target.closest('.vo-cut')) return;
      /* 每一次按下都是「一次新动作」：先把「拖过」清掉（见上面 voiceDragged 那段的理由 ——
         复位挂在 click 上会漏掉「拖把手后在块外松手」那一种，那时浏览器不派发 click）。 */
      voiceDragged = false; voiceDragId = '';
      e.preventDefault(); e.stopPropagation();
      const lane = el.closest('.tl-lane') || row;
      const laneW = Math.max(1, lane.getBoundingClientRect().width);
      const secPerPx = total / laneW;
      start(e, secPerPx);
    });
  };

  /* ① 单击 = 选中。**拖过的那一下不算单击**（余波判据见 voiceWasDragged）——
     选中这一下是**三件事同一入口**：块高亮（`.sel`）、上面那排剪辑条换到这一句、
     条上的音量读数跟着变。三件事各做各的就会出现「按钮出现了但删的是另一句」
     —— 所以统一走 selectVoice。**不自动试听**（用户点名的第 ⑤ 条）：点一下块只是选中，
     要听走剪辑条那颗「试听」—— 否则每次点中一句都从它自己的 off 起播，用户还以为在播画面。 */
  row.querySelectorAll('.tl-v').forEach(el => {
    el.addEventListener('click', e => {
      if (voiceWasDragged(el.dataset.vid)) return;
      if (e.target.closest('.vo-cut')) return;
      /* 只读的那一截（别的镜溢出进来的）：不抢选中 —— 它在自己那一镜里才是可编辑的，
         这里选中会出现「剪辑条明明在、点删掉却删了别的镜上那一句」。
         但点它**不是死路**：把焦点跳到它自己那一镜，跳过去之后这一句就能拖能剪了
         （用户点名的「音轨无法跨越不同镜头」，缺的就是这一条出路）。 */
      if (el.classList.contains('spill')) {
        const vv = voicesEnsure().find(x => x.id === el.dataset.vid);
        if (vv) focusVoiceShot(vv);
        return;
      }
      selectVoice(el.dataset.vid);
    });
  });
  /* ② 拖块体 = 挪位置（**整框**平移，框与选区的相对关系不变）。
     两排同一份 `moveVoiceTo`：本镜那一排按落点换段（同一条候选切出来的），
     全片那一排按落点换镜/换候选/换段。两边都只夹「起点」，
     尾巴越到后面那一格不算挪动失败 —— 见上面 `o = { total, film, G }` 那一段。 */
  row.querySelectorAll('.tl-v').forEach(el => {
    /* 第三参 true = 落在把手 / 音量条上的按下不启动「拖块体」（判据只此一处，见 bindDrag） */
    bindDrag(el, (e, secPerPx) => {
      const v = voicesEnsure().find(x => x.id === el.dataset.vid);
      const r0 = v && voiceRowOf(v);
      if (!v || !r0) return;
      const x0 = e.clientX;
      /* 框左沿在**这一排的轴**上的位置（拖动前）：位移按像素×秒/px 直接加在它上面，
         落点再由 `moveVoiceTo` 折回源秒 —— 倍速在两处各折算一次，中途不碰数据以外的尺子。 */
      const tAx0 = voiceAxBox(r0, v).box.l;
      let moved = 0;
      /* 上下拖 = 换行（`v.ln`）。行距不能写死 38：轨道收起时那一行是 18px，
         写死的话在收起的状态下拖一下会跳两行。量的是**这一行自己的高度 + 行间距**。 */
      const y0 = e.clientY;
      const laneStep = (() => {
        const h = row.getBoundingClientRect().height || 38;
        const cs = row.parentElement ? getComputedStyle(row.parentElement) : null;
        const gap = Number.parseFloat((cs && cs.rowGap) || '20') || 20;
        return Math.max(12, h + gap);
      })();
      const ln0 = voiceLn(v);
      let lnWant = ln0;
      /* 松手那句回执要说真话：按下前把「这一趟可能改的那几个数」抄一份，并记下落点有没有被挡回去。
         两种「一个数都没改」：① 落点那一格压根不是镜头的一段（片头黑场 / 插入的素材 —— 配音的锚点是
         shotId/candId/seg 三样，那一格没有这三样，`moveVoiceTo` 只能返回 false）；② 绕了一圈回到原位。
         原来 `up` 两种都照样打一句「✓ 这一句挪到了「甲镜」第 1 段的 +0.4 秒」—— 那句 ✓ 指着的是**原地**，
         于是界面承诺了一件没发生的事（本项目反复拦的那一类：要么实现、要么改文案）。
         ⚠ 「画面被删掉的那一格」（段上的 `off:1` → clip `gray:1`）**不在被拒之列**：它的 kind 仍是 shot、
         in/out 与时长一个字没动，所以配音照样挂得住 —— 那正是「黑屏配旁白」，也是 `underGray` 那句
         「这一段画面删掉了…成片里出 X 秒黑场」默认的组合。 */
      const snapVoice = () => JSON.stringify([v.shotId, v.candId, v.seg == null ? 0 : v.seg, v.at, v.fa, v.dur, voiceLn(v)]);
      const snap0 = snapVoice();
      let blocked = '';
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        /* 第一位移出阈值就出那张跟手的小卡（与画面格那一路同一个手势语言，第 ⑧ 条）：
           配音块上放的是它自己的波形，横拖挪位置与竖拖换行都算「正在拖这一句」。 */
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          if (!moved) dragGhostShow(ev, el, (el.querySelector('.vt') || {}).textContent);
          else dragGhostMove(ev);
          moved = 1; markVoiceDrag(el.dataset.vid);
        }
        /* 换行的意图只在**竖直位移更大**时成立：横向拖动时手指难免上下偏一点，
           那时按横向为准（否则挪一下位置就串到别的行上去了）。 */
        if (Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx)) {
          lnWant = laneClamp(ln0 + Math.round(dy / laneStep));
          el.style.transform = 'translateY(' + round1((lnWant - ln0) * laneStep) + 'px)';
        }
        if (dy && Math.abs(dy) >= Math.abs(dx)) { paintVoice(v); return; }
        /* 位移与落点都在**这一排的轴秒**上量，源秒、段归属、夹取全在 `moveVoiceTo` 一份里 */
        blocked = moveVoiceTo(v, tAx0 + dx * secPerPx) ? '' : 'black';
        if (blocked) return;
        paintVoice(v);
      };
      const up = () => {
        dragGhostHide();
        if (!moved) { el.style.transform = ''; return; }
        const lnChanged = lnWant !== ln0;
        if (lnChanged) v.ln = lnWant;
        el.style.transform = '';
        roundVoice(v);
        /* 一个数都没改 → 不许打「✓ 挪到了」：要么落点是黑场格（那里挂不住配音），要么绕回原位。
           两种都照实说一句，并把重画存档那一步跳过去（一个数都没变，凭什么惊动界面与存盘）。 */
        if (snapVoice() === snap0) {
          setStatus(blocked
            ? '<span class="warn">那一格不是镜头画面（黑场或插入的素材），一句配音只能挂在镜头的某一段上 —— 拖到有画面的那一格再松手</span>'
            : '<span class="info">这一句拖回了原位，位置和归属都没变</span>');
          return;
        }
        const sh2 = allShots().find(x => x.id === v.shotId);
        setStatus('<span class="ok">✓ 这一句挪到了「' + esc((sh2 && sh2.name) || '镜头') + '」第 '
          + ((Number(v.seg) || 0) + 1) + ' 段的 +' + round1(v.at) + ' 秒'
          + (lnChanged ? '（' + laneNm('voice') + '第 ' + (lnWant + 1) + ' 行）' : '') + '</span>');
        filmEdited();
      };
      dragOnWindow(move, up);
    }, true);
  });
  /* ③ 拖左边缘 = 把这一句的**开头**盖掉，④ 拖右边缘 = 盖掉**结尾**。
     与画面轨同一套几何：**框 [fa,fb] 不动**（块在轨道上不缩不挪），拖的是框内那两块灰 ——
     左边那块变宽就是「这一段音频不进成片」，右边那块同理。
     以前这两个把手直接把块缩窄/平移（`v.at` 与 `v.dur` 一起改、框不存在），
     于是看起来是「整块被压扁」而不是「左边/右边被盖掉」（用户点名的那一条）。
     ⚠ `off`（音频文件内部的起点）跟着选区起点走：合成时它是配音输入的 -ss，
       播放时它是 Audio.currentTime 的起点 —— 三处口径必须一致，见 clipVoices / renderJob / TlPlay。 */
  row.querySelectorAll('[data-vcut]').forEach(g => {
    bindDrag(g, (e, secPerPx) => {
      const v = voicesEnsure().find(x => x.id === g.getAttribute('data-vcut'));
      const r0 = v && voiceRowOf(v);
      if (!v || !r0) return;
      /* 音频本身有多长：右把手不能拖到音频没有内容的地方。没量过就先量一次（异步，
         量到就存在这一句上，下次直接用） */
      if (!(Number(v.srcDur) > 0) && v.src && !v._measuring) {
        v._measuring = 1;
        audioDurOf(v.src).then(d => { if (d > 0) v.srcDur = d; }).catch(() => {});
      }
      const x0 = e.clientX;
      const edge = g.getAttribute('data-edge');
      const fr = voiceFrameOf(v);
      /* `v.at / fr` 在源秒上量，`v.dur / v.off` 在音频文件秒上量 —— 把手上每一处
         夹取与换算都要先统一：内容秒差 Δ 源秒 ↔ 音频秒差 Δ×own（自己那一档）。
         忘了这一道，×1.5 的那一句左把手拖到料头就顶住、右把手拖着的量与写下的数差一半。 */
      const own = voiceRateOf(v);
      const at0 = Math.max(0, Number(v.at) || 0);
      const dur0 = Math.max(VOICE_MIN, Number(v.dur) || 0);
      const off0 = Math.max(0, Number(v.off) || 0);
      let moved = 0;
      /* 手里握着哪一根，那一根就加粗发光（与画面轨那两根同一个 `.act`）。
         排在 `if (!v || !r0) return` 之后：认不出这一句时 `dragOnWindow` 根本不会跑，
         起手就加粗会留下一根永远亮着的把手。 */
      g.classList.add('act');
      const move = ev => {
        const dx = ev.clientX - x0;
        if (Math.abs(dx) > 3) { moved = 1; markVoiceDrag(v.id); }
        const raw = dx * secPerPx * voiceSpdOf(v);
        if (edge === 'l') {
          /* 选区起点 = 框左沿 + 已切掉的秒数，两头夹住：
             · 往左退不出框（`fa`），也退不到音频第 0 秒之前（`off` 不能变负）；
             · 往右不能把选区压到 VOICE_MIN 以下。
             框、块的左右沿、别的块 —— 一个字节都不动。 */
          const na = Math.max(Math.max(fr.fa, at0 - off0 / own), Math.min(at0 + raw, at0 + (dur0 - VOICE_MIN) / own));
          const d = (na - at0) * own;
          v.at = na;
          v.dur = dur0 - d;
          v.off = off0 + d;
        } else {
          /* 选区终点：往左拖 = 把结尾盖掉（框不动，右边那块灰变宽）；往右拖 = 放回来。
             上界取「框右沿」与「音频尽头」里更宽的那一头 —— 正常一句配音在加进来时
             框就等于整条音频，两者相同；只有老数据 / 导入时按更短的长度截过，
             才允许把框向右推一推（音频块不像画面格，它没有邻居要避让）。
             ⚠ 这一头**不受所在那一段的长度限制**：尾巴越过格子右沿就是「跨到后面那一段/那一镜」，
               合成侧（代理 `room`）与预览（`TlPlay.startVoices`）现在都按整句放。 */
          const content = Number(v.srcDur) > 0 ? Math.max(VOICE_MIN, Number(v.srcDur) - off0) : dur0;
          const lim = Math.max(fr.fb, at0 + content / own);
          const ne = Math.max(at0 + VOICE_MIN / own, Math.min(at0 + dur0 / own + raw, lim));
          v.dur = (ne - at0) * own;
          if (ne > fr.fb) v.fb = ne;
        }
        paintVoice(v);
      };
      const up = () => {
        g.classList.remove('act');
        if (!moved) return;
        roundVoice(v);
        const cut = Math.max(0, (Number(v.at) || 0) - fr.fa) + Math.max(0, fr.fb - ((Number(v.at) || 0) + Number(v.dur || 0) / own));
        setStatus('<span class="ok">✓ 这一句现在从音频第 ' + round1(v.off || 0) + ' 秒起、长 ' + round1(v.dur || 0) + ' 秒'
          + (cut > 0.05 ? '（这一段里有 ' + round1(cut) + ' 秒被盖掉，不进成片）' : '') + '</span>');
        filmEdited();
      };
      dragOnWindow(move, up);
    });
  });
  /* 音量不在块上、删除也不在块上：那一排剪子共用轨道**上面**一根，音量共用右栏那张卡（见 setCutVol / runCut）。
     块底那条可拖的横条已删 —— 它是音量的第二个出口，还把鼠标扫过音轨变成「调整」光标，
     而那块地方本来是「挪位置 / 试听」。 */
}

/* 选中一句配音：块高亮 + 上面那排剪辑条换到这一句（本镜与全片两排的块一起高亮，
   否则同一句话在两处都看得到、却只有一处亮着）。
   这里同时把**目标**换成配音 —— 目标是「最后点的那一轨」，不是「有没有还留着选中的配音」，
   否则点了画面格之后剪刀与滑块仍会落到上一句配音上（用户报的「优先删除语音」）。 */
/* 把「现在哪一句该亮」就地写回两排的所有块上 —— 判据只有 `voiceSelId()` 一份。
   换目标的三条路（点一格画面 / 点轨道空白 / 删掉这一句）都要走它：整栏重画只是其中一条，
   就地那一下不重画，于是留着上一句的亮环对着一个已经指向画面的剪子。 */
function paintVoiceSel() {
  const id = voiceSelId();
  document.querySelectorAll('.tl-v[data-vid]').forEach(x => x.classList.toggle('sel',
    x.dataset.vid === id && !x.classList.contains('spill')));
}
/* 画面那一排的亮环就地收掉 —— 只在「目标已经不是画面轨」时起作用，所以它是**只收不画**：
   该亮哪一格要问段清单（本镜那一排）或行号（全片那一排），那是 `paintSegFocus` / 两处 cellHTML /
   `filmApplyAt` 各自的路；而「点了一句配音」这一一下只需要一件事 —— 上面那一格也别亮。
   两排同时高亮 = 看不出剪子究竟在哪一轨（用户点名的「上下的画面片段和配音片段都高光」）。 */
function dropPicSel() {
  if (picSelOn()) return;
  document.querySelectorAll('#tlBar .tl-seg.sel').forEach(x => x.classList.remove('sel'));
}
function selectVoice(id) {
  projOf().curVoice = id || '';
  projOf().tlLane = id ? 'voice' : 'pic';
  /* 点中轨上一句 = 用户要看/调这一句（用户点名的第 ③ 条那三格里最直接的一格）；
     显隐仍由 paintTlGroups 一处翻，这里只落一个状态。 */
  if (id) {
    setVcTab('adj');
  }
  paintVoiceSel();
  dropPicSel();
  syncTlTools();
  scheduleSave();
}

  return {
    playVoicePreview,
    paintVoiceVol,
    orphanVoices,
    orphanVoicesOf,
    adoptWhy,
    adoptOrphanVoices,
    voiceLn,
    lanePut,
    voiceLanesHTML,
    laneRowCtlHTML,
    laneRowBtnsHTML,
    syncLaneSide,
    voiceLaneHTML,
    VOICE_MIN,
    bindVoiceLane,
    paintVoiceSel,
    dropPicSel,
    selectVoice,
  };
}
