/* 导演台Voice域：由 engine.js 按域机械搬出（内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createVoice(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1, spdTxt, num } from '../util.js';
import { voiceBase, shotCtxOf } from '../naming.js';
import { createVoiceClip, deriveTimeline, packVoiceLanes, filmTotal, filmId, withPlaybackRate, rateOf, pos, clamp, gainOf, fadeGain, srcHeadOf, srcUsedOf, srcLenOf, LANE_MAX, MIN_CLIP_SECONDS, estimateSpeechSeconds } from '../film.js';
import { trimVoiceLeft, trimVoiceRight, trimClipLeft, trimClipRight, followCaptions } from '../tl-resize.js';
import { moveClipToLane, moveTimedToLane, compactLanes } from '../tl-reorder.js';

export function createVoice(E, document, window) {
  const {
    projOf,
    REGOf,
    allShots,
    curShot,
    fmtDur,
    candDur,
    filmOf,
    Timeline,
    Edit,
    capPanelHTML,
    bindCapPanel,
    scheduleSave,
    filmEdited,
    lineVoicesOf,
    midEditTrimOf,
    voiceDraftOf,
    vcTabOf,
    setVcTab,
    polishVoiceText,
    linePanelRows,
    lineWhoDatalistHTML,
    lineRowsHTML,
    bindLineEditors,
    lineCntTexts,
    renderEditor,
    needsLocal,
    autoLocalize,
    setStatus,
    GenOf,
  } = E;


/* ============================================================================
   剪辑模式的右栏 = 声音栏（形状照着工作台的语音那一栏）
   ----------------------------------------------------------------------------
   用户点名的是「打开剪辑功能后右栏变成工作台的声音栏那样，并添加剪辑相应功能」：
   平台与型号、音色、格式、高级设置全部**现读能力声明**（判据在 Chars.Pipe 那一份，不在这里抄第二遍），
   合成走公共层 `AiGen.synthTts`（与语音台同一条链：同步合成 → 字节落本机 → 记归档），
   「剪辑相应功能」= 这一句锚在**插针指着的那一段**上，位置由轨道决定，不额外要用户填秒数。
   草稿只活在内存（voiceDraft）：整栏重画不该丢掉正在打的字，换出剪辑模式自然清。
   与语音工作台对齐的两件事：① 平台与型号下拉列**全部**配了密钥的语音供应商（Chars.Pipe.modelSelectHTML）；
   ② 「合成设置」那一块 = 输出格式 + 平台在 create.topBools 里声明的顶层开关 + 字数区间
   （tts.minChars/maxChars，不够长时按钮当场禁用并写明，不等着平台回一句拒）。 */
/* `ref` = 复刻（clone）用的那条参考音频（资产库 / 收藏 / 本机文件挑来的那一条）。
   它和 `voiceFile`（「放一条本机音频」）不是一回事：那一个把**成品音频**铺到轨上当配音，
   这一个把音色**素材**发给平台，让平台按它现造一把嗓子。 */
/* `who` = 这一句的说话人（从台词那一份拿的）——
   「把这一格的声音描述存回素材库」靠它找人（素材库那一位与说话人同名）。
   没有说话人时那颗按钮是禁用的（存回去也存不到谁身上）。 */
/* 右栏配音区那四个小选项（用户点名的第 ③ 条）：一次只露一格内容，节点不销毁。
   默认「这一镜上的配音」；点中轨上一句换成「音量与倍速」，点台词那一档换成「台词」，
   点空白换成「生成配音」（三个落点各写一次，见 selectVoice / bindPinZone）。 */
/* 「这一家刚刚报过余额/额度不够」：合成失败那一次记下来，十分钟内再点不再白等一整轮 ——
   但**不禁用按钮**：用户可能已经充好了，所以给一句说明加一颗「仍然再试」。
   判据与那笔账都在 Api.balOut / Api.isBalanceErr（api.js），这里只记「这一栏要不要挂那张牌」。 */
let voiceBalOut = '';
/* 量一句音频的真实时长（块宽与导出合成的 dur 都靠它）。量不出来不按 0 记 ——
   0 会让这一句在轨上塌成一条线，等于「加了但看不见」。 */
function audioDurOf(src) {
  return new Promise(res => {
    let done = false;
    const a = new Audio();
    const fin = () => { if (done) return; done = true; try { a.pause(); a.removeAttribute('src'); } catch (e) { /* 临时 audio 收尾：释放失败也不影响已经算出来的结果 */ } res(0.5); };
    a.preload = 'metadata';
    a.src = Api.mediaSrc(src);
    a.addEventListener('loadedmetadata', () => {
      if (done) return;
      done = true;
      const d = isFinite(a.duration) && a.duration > 0 ? a.duration : 0.5;
      try { a.pause(); a.removeAttribute('src'); } catch (e) { /* 临时 audio 收尾：释放失败也不影响已经算出来的结果 */ }
      res(Math.max(0.1, round1(d)));
    });
    a.addEventListener('error', fin);
    setTimeout(fin, 8000);
  });
}
/* 这一句落在成片第几秒：**这一镜在成片里的起点**（与画面段同一把尺子）。
   这一镜还没进成片时才退到播放头（夹进成片长度内）—— 生成台词语音前会先拦下「还没进成片」。 */
function voicePlaceOf(sh) {
  const f = filmOf();
  const rows = deriveTimeline(f.clips || []).rows;
  const row = rows.find(r => r && r.clip && r.clip.shotId === sh.id);
  if (row) return { start: Math.max(0, Number(row.start) || 0), hasClip: true };
  return { start: clamp(Number(Timeline.playhead()) || 0, 0, filmTotal(f.clips || [])), hasClip: false };
}
const LANE_PROBE = '__lane_probe__';
/* 落在第几行：问的是轨道打包那同一把尺子（`packVoiceLanes` 按 start/duration 找第一条不重叠的行，
   放不下就新开一行，超过 LANE_MAX 那一行不在返回的 lanes 里 → 报「放不下」，不静默挤进最后一行）。
   `dropIds` = 这一句要替换掉的旧配音；`lane` = 旧配音原来那一行（放得下就还放回去）。 */
function voiceLaneOf({ start, duration, dropIds = [], lane }) {
  const f = filmOf();
  const others = (f.voices || []).filter(x => x && x.id && dropIds.indexOf(x.id) < 0);
  const probe = { id: LANE_PROBE, start, duration };
  if (Number.isInteger(lane)) probe.lane = Math.max(0, lane);
  const { lanes } = packVoiceLanes(others.concat(probe));
  const hit = lanes.find(l => l.items.some(x => x.id === LANE_PROBE));
  return { lane: hit ? hit.lane : -1, rows: LANE_MAX };
}
/* 这一镜在成片里的那几句配音（按成片秒排）：轨道画块、清单列行、删与试听读的都是这一份。
   排序按 `start` 而不是按数组下标 —— 清单要说「这一镜第 1 句、第 2 句」，那一句在前由它落在第几秒定。 */
const shotFilmVoices = shotId => (filmOf().voices || []).filter(v => v && v.shotId === shotId)
  .slice().sort((a, b) => pos(a.start) - pos(b.start));
/* 这一句**画在第几行**：行号存的是「首选行」，真正画在哪一行由打包函数按时间重叠现算 ——
   所以卡片与清单那一行不能直接念 `v.lane`（压着别的句子时它自己会挪到下一条空行，念首选就是假话）。
   与轨道那一排（engine/timeline.js 的行表）问的是同一个函数、同一批条目。 */
function drawnLaneOf(id) {
  const f = filmOf();
  const timed = (f.voices || []);
  const { lanes } = packVoiceLanes(timed);
  const hit = lanes.find(l => l.items.some(x => x.id === id));
  const self = timed.find(x => x && x.id === id);
  return hit ? hit.lane : Math.max(0, Math.round(self ? pos(self.lane) : 0));
}
/* ---------------- 右栏那张「指着谁就改谁」的卡 ----------------
   目标只有一个来源：`Edit.focusOf()`（轨道上点/拖出来的那一条）。卡片不留第二份「我在改哪一段」，
   否则轨道与卡片迟早各说一件事。所有写入都经 `Edit.patch` —— 于是撤销、波纹、落盘、重画与手势同一套，
   历史里那句描述由 `Edit.describeItem` 点名（「镜头一」第 2 段（3.2–8.0 秒））。 */
const FOCUS_LABEL = { clip: '这一段画面', voice: '这一句配音', cap: '那一条字幕', marker: '那一枚标记' };
/* 焦点 → 卡片读数：kind / id / 那一条本身 / 它在成片里的区间 / 所在行。 */
function cardTarget() {
  const f = Edit.focusOf();
  const kind = f.kind === 'marker' ? '' : f.kind;
  const it = kind ? (filmOf()[kind === 'clip' ? 'clips' : kind === 'voice' ? 'voices' : 'captions'] || [])
    .find(x => x && x.id === f.id) : null;
  if (!it) return { kind: '', id: '', it: null, start: 0, end: 0, lane: 0 };
  if (kind === 'clip') {
    const clips = filmOf().clips || [];
    const row = deriveTimeline(clips).rows[clips.findIndex(c => c.id === it.id)] || {};
    return { kind, id: it.id, it, start: pos(row.start), end: pos(row.end), lane: Math.max(0, Math.round(pos(it.ln))) };
  }
  return { kind, id: it.id, it, start: pos(it.start), end: kind === 'cap' ? pos(it.end) : pos(it.start) + pos(it.duration),
    lane: kind === 'cap' ? 0 : drawnLaneOf(it.id) };
}
/* 档位由焦点定：画面段 / 配音句 → 「这一段」，字幕 → 「字幕」。
   用户自己挑过的档不被同一份焦点抢走 —— 判据是「焦点目标换没换」（`lastFocusKey`）而不是
   「指着哪一类」：片段亮着时右栏每 3 秒重画一次，按类判会把人点开的档硬拽回去。 */
const VOICE_TABS = ['clip', 'voice', 'sub'];
let lastFocusKey = '';
function tabForFocus(t) {
  const cur = vcTabOf();
  t = t || cardTarget();
  const key = t.kind ? t.kind + ':' + t.id : '';
  if (key === lastFocusKey) return cur;
  lastFocusKey = key;
  if (t.kind === 'clip' || t.kind === 'voice') return 'clip';
  if (t.kind === 'cap') return 'sub';
  return VOICE_TABS.indexOf(cur) >= 0 ? cur : 'voice';
}
/* 「这一句念多久」与「这一段占多久」：都写成 成片秒 = 源秒 ÷ 倍速 那一条等式的两边，
   用户调倍速时看得见它把哪一头换了（改倍速不动源窗口，动的是它在成片里占多宽）。
   `rateOv` 只给拖动中的那一枚滑块用：手已经拖过去了，这句还在念旧倍速就是两个数互相打架。 */
function durationLine(t, rateOv) {
  if (t.kind === 'clip') {
    if (t.it.kind === 'image') return '这一张图在成片里占 ' + round1(t.end - t.start) + ' 秒';
    const r = rateOv || rateOf(t.it);
    const used = srcUsedOf(t.it);
    return '这一段在成片里占 ' + round1(used / r) + ' 秒 ＝ 素材里 ' + round1(used) + ' 秒 ÷ ' + spdTxt(r);
  }
  const r = rateOv || rateOf(t.it);
  const used = srcUsedOf(t.it);
  return '这一句在成片里念 ' + round1(used / r) + ' 秒 ＝ 音频里 ' + round1(used) + ' 秒 ÷ ' + spdTxt(r);
}
/* 入出点那两框的说明：两框填的是素材秒，与轨道上的成片秒差一枚倍速 —— 这句就是把那枚倍数念出来。 */
function trimHint(used, rate, srcLen) {
  const r = rate || 1;
  return '两框是素材秒，现在成片里占 ' + round1(used / r) + ' 秒'
    + (srcLen > 0 ? '，素材原长 ' + round1(srcLen) + ' 秒' : '，素材原长未知：只能往里裁');
}
/* 卡片就地刷（不重建这一栏：正在敲的「要念的话」不能因为拖了一下滑块就被换掉）。
   画与不画由这唯一一处决定：档位条上哪枚亮、六格里哪格 hidden、卡上那几个数是多少。 */
function paintVcCard() {
  const adj = document.getElementById('tlAdj');
  if (!adj) return;
  /* 焦点只取一次：档位与六格的显隐读的是同一份目标，两处各取一次会在两次调用之间错位
     （轨道手势刚好落在中间时，档位写着「这一段画面」、卡里画的却是上一句配音）。 */
  const t = cardTarget();
  const tab = tabForFocus(t);
  setVcTab(tab);
  /* 三档都是用户自己挑的按钮，`.on` 只由这一处写；`aria-selected` 跟着同一枚判据走。 */
  document.querySelectorAll('#vcTabs [data-vctab]').forEach(b => {
    const on = b.dataset.vctab === tab;
    b.classList.toggle('on', on);
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const showGrp = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  showGrp('tlAdj', tab === 'clip');
  showGrp('grpVoiceList', tab === 'clip');
  showGrp('grpLines', tab === 'voice');
  showGrp('grpVoiceAdd', tab === 'voice');
  showGrp('grpSub', tab === 'sub');
  const isClip = t.kind === 'clip';
  const isVoice = t.kind === 'voice';
  const lab = document.getElementById('adjTarget');
  if (lab) lab.textContent = t.kind ? (FOCUS_LABEL[t.kind] + ' · 成片 ' + round1(t.start) + '–' + round1(t.end) + ' 秒') : '未选中';
  const row = id => adj.querySelector('#' + id);
  const has = t.kind !== '';
  const isCap = t.kind === 'cap';
  const isImage = isClip && t.it.kind === 'image';
  /* 六行只在「指着的那一类用得上」时画：字幕只有一条时间区间（没有增益、没有倍速、行由重叠现算），
     字幕只有成片区间。 */
  const gain = has && !isCap;
  showGrp('rowVol', gain);
  showGrp('rowVolTrack', gain);
  showGrp('rowSpd', gain && !isImage);
  showGrp('rowSpdTrack', gain && !isImage);
  showGrp('rowFade', t.kind === 'voice');
  showGrp('rowMute', isClip && !isImage);
  showGrp('rowLane', isClip || isVoice);
  /* 入出点那一行只对**有素材窗口**的那一类画：图片段没有源可裁，字幕只有成片区间。 */
  showGrp('tlTrimRow', (isClip && !isImage) || t.kind === 'voice');
  const setVal = (id, v) => { const el = row(id); if (el) el.value = v; };
  const setTextVal = (id, v) => { const el = row(id); if (el) el.textContent = v; };
  const volPct = t.it ? Math.round(pos(t.it.volume) * 100) : 100;
  setVal('adjVol', String(volPct)); setTextVal('adjVolVal', volPct + '%');
  setTextVal('adjVolLab', isClip ? '这一段音量' : '这一句音量');
  const trackVol = () => {
    const list = (isClip ? filmOf().clips : (filmOf().voices || [])).filter(x => !isClip || x.kind !== 'image');
    if (!list.length) return 100;
    return Math.round(list.reduce((a, x) => a + pos(x.volume), 0) / list.length * 100);
  };
  const volTrack = trackVol();
  setVal('adjVolTrack', String(volTrack)); setTextVal('adjVolTrackVal', volTrack + '%');
  const rate = t.it ? rateOf(t.it) : 1;
  setVal('adjSpd', String(rate)); setTextVal('adjSpdVal', spdTxt(rate));
  setTextVal('adjSpdLab', isClip ? '这一段倍速' : '这一句倍速');
  const trackSpd = () => {
    const list = (isClip ? filmOf().clips : (filmOf().voices || [])).filter(x => isClip ? x.kind !== 'image' : true);
    if (!list.length) return 1;
    return list.reduce((a, x) => a + rateOf(x), 0) / list.length;
  };
  const spdTrack = trackSpd();
  setVal('adjSpdTrack', String(Math.round(spdTrack * 100) / 100)); setTextVal('adjSpdTrackVal', spdTxt(spdTrack));
  const mb = row('adjMute'); if (mb && isClip) mb.checked = !!t.it.muted;
  /* 渐变的天花板是这一句自己的长度：淡入 5 秒的一句填 8 秒，播起来等于整句都在斜坡里（听感是「没有声音」）。
     min/max 由这一处写，控件不自己猜。 */
  const len = Math.max(0, round1(t.end - t.start));
  ['adjFadeIn', 'adjFadeOut'].forEach(id => { const el = row(id); if (el) el.max = String(len); });
  setVal('adjFadeIn', String(round1(t.it ? t.it.fadeIn : 0)));
  setVal('adjFadeOut', String(round1(t.it ? t.it.fadeOut : 0)));
  setTextVal('cutLaneRow', '第 ' + (t.lane + 1) + ' 行');
  setTextVal('tlAdjLen', has ? durationLine(t) : '');
  const sEl = row('trimS'); const eEl = row('trimE');
  const head = t.it ? srcHeadOf(t.it) : 0;
  const used = t.it ? srcUsedOf(t.it) : 0;
  const srcLen = t.it ? srcLenOf(t.it) : 0;
  const rateNow = t.it ? rateOf(t.it) : 1;
  const minSrc = MIN_CLIP_SECONDS * rateNow;
  if (sEl) {
    sEl.value = String(round1(head));
    /* 素材原长知道才给边界：不知道时 max 会算成 0，反而把正常的那个数标成越界。
       「应用」那一刀自己夹，界外填法兜不住它。 */
    if (srcLen > 0) sEl.max = String(round1(Math.max(0, srcLen - minSrc))); else sEl.removeAttribute('max');
  }
  if (eEl) {
    eEl.value = String(round1(head + used));
    if (srcLen > 0) { eEl.min = String(round1(Math.min(srcLen, head + minSrc))); eEl.max = String(round1(srcLen)); }
    else eEl.removeAttribute('min');
  }
  const tl = row('trimT'); if (tl) tl.textContent = FOCUS_LABEL[t.kind] || '入出点';
  const note = row('trimNote');
  if (note) note.textContent = trimHint(used, rateNow, srcLen);
}
/* ---------------- 卡片那几枚控件的写入 ----------------
   唯一出口是 `Edit.patch`：波纹、快照、落盘、重画与轨道上的手势同一套（同一个 commit），
   卡片这里不留第二份改法，也不留第二份「我在改哪一段」的状态（焦点只从 Edit.focusOf 读）。
   历史里那句描述走 `Edit.describeItem` 点名 —— 与轨道上拖把手写进历史的同一把尺子。 */
const LIST_KEY = { clip: 'clips', voice: 'voices', cap: 'captions' };
/* 卡片能指着改的两类：画面段与配音句（字幕只有成片区间）。
   行号、整轨写入的清单名都跟着它走，判据只在这一处。 */
const cardKind = t => (t.kind === 'clip' ? 'clip' : t.kind === 'voice' ? 'voice' : '');
const volOf = v => clamp(num(v) / 100, 0, 4);                     // 滑杆上是百分数（0–400%），数据里是线性增益
const rateOfSlider = v => clamp(Math.round(num(v) * 100) / 100, 0.25, 4);

/* 改一条块身上的几个数（别的清单一个字节不动）。填进去的数与现在完全一样 = 什么都没改：不打快照。 */
function patchItem(kind, id, fields, label) {
  const key = LIST_KEY[kind];
  const list = filmOf()[key] || [];
  const cur = list.find(x => x && x.id === id);
  if (!cur) return false;
  if (Object.keys(fields).every(k => (typeof fields[k] === 'number' ? pos(cur[k]) === pos(fields[k]) : cur[k] === fields[k]))) return false;
  return Edit.patch({ [key]: list.map(x => (x && x.id === id ? { ...x, ...fields } : x)) }, label);
}
/* 改倍速只走 `withPlaybackRate`（源窗口不动、只换它在成片里占多宽）—— 全站只有这一处折算口。 */
function writeRate(kind, id, rate) {
  const key = LIST_KEY[kind];
  const list = filmOf()[key] || [];
  const cur = list.find(x => x && x.id === id);
  if (!cur || rateOf(cur) === rate) return false;
  const label = '把 ' + Edit.describeItem(kind, id) + ' 的倍速设成 ' + spdTxt(rate)
    + '（素材窗口不动，折回成片里占 ' + round1(srcUsedOf(cur) / rate) + ' 秒）';
  return Edit.patch({ [key]: list.map(x => (x && x.id === id ? withPlaybackRate(x, rate) : x)) }, label);
}
/* 「整轨」那两枚：一次改这一排每一条。图片段不吃倍速（没有源窗口），也不该被整排盖掉，所以剔出写入名单。
   `map` 原样交回表示这一条不用改；一条都没变就不打快照（拖到同一档又松手，不该多一条记录）。 */
function writeTrack(kind, map, label) {
  const key = LIST_KEY[kind];
  const list = filmOf()[key] || [];
  let n = 0;
  const out = list.map(x => {
    if (!x || (kind === 'clip' && x.kind === 'image')) return x;
    const w = map(x);
    if (w !== x) n++;
    return w;
  });
  if (!n) return false;
  return Edit.patch({ [key]: out }, label(n));
}
/* 换行：与轨道上「竖着拖到新行」走同一对纯件（tl-reorder 的 moveClipToLane / moveTimedToLane + compactLanes）——
   中间行的收缩与空行重编号只在那一处算，卡片这里只把「上一行 / 下一行」折成目标行号。
   只改画在哪一行：进成片的时间与顺序一个字不动。 */
function moveRow(dir) {
  const t = cardTarget();
  const wanted = clamp(Math.round(t.lane) + dir, 0, LANE_MAX - 1);
  if (t.kind === 'clip') {
    const r = moveClipToLane(filmOf().clips || [], t.id, wanted);
    if (!r.moved) { setStatus(dir < 0 ? '这一格已经在第 1 行' : '下面没有更多行（一屏最多 ' + LANE_MAX + ' 行）'); return; }
    Edit.patch({ clips: r.clips }, '把 ' + Edit.describeItem('clip', t.id) + ' 挪到第 ' + (wanted + 1) + ' 行');
    return;
  }
  if (t.kind !== 'voice') return;
  const f = filmOf();
  const moved = moveTimedToLane((f.voices || []), t.id, wanted);
  if (!moved.moved) { setStatus(dir < 0 ? '这一句已经在第 1 行' : '下面没有更多行（一屏最多 ' + LANE_MAX + ' 行）'); return; }
  const byId = new Map(compactLanes(moved.items).items.map(x => [x.id, Math.max(0, Math.round(pos(x.lane)))]));
  const back = key => (f[key] || []).map(x => (x && byId.has(x.id) ? { ...x, lane: byId.get(x.id) } : x));
  const rows = Math.max(...[...byId.values()]) + 1;
  Edit.patch({ voices: back('voices') }, '把 ' + Edit.describeItem(t.kind, t.id)
    + ' 挪到第 ' + ((byId.get(t.id) || 0) + 1) + ' 行' + (wanted >= rows - 1 ? '（新开的一行，现在一共 ' + rows + ' 行）' : ''));
}
/* 入出点那两框的「应用」：两框是**素材秒**（这一条素材窗口的头 → 尾），落回 tl-resize 那四把剪子。
   先把两个数夹进这一条素材能用的范围（头最多退到 0、尾最多拉到素材原长；原长未知就只许往里裁），
   再把「头、尾各自的位移」按**左缘先、右缘后**交出去 —— 左缘那一刀不动右缘在源里的位置，
   所以两笔增量都能按改之前那一份算，不用折第二遍。
   配音句改保留片段会挪它在成片里的起点，挂在它身上的字幕跟着走（`followCaptions` 与轨道拖动同一份）。
   夹完四个数一个都没变 = 这一下什么都没改：不打快照，只把两框重画回夹取后的值。 */
function applyTrimCard() {
  const t = cardTarget();
  const kind = cardKind(t);
  if (!kind) return;
  const adj = document.getElementById('tlAdj');
  if (!adj) return;
  const it = t.it;
  const rate = rateOf(it);
  const head = srcHeadOf(it);
  const used = srcUsedOf(it);
  const srcLen = srcLenOf(it);
  const hi = srcLen > 0 ? srcLen : head + used;
  const minSrc = MIN_CLIP_SECONDS * rate;          // 最短保留（成片秒）折回素材秒
  let na = parseFloat(adj.querySelector('#trimS').value);
  let nb = parseFloat(adj.querySelector('#trimE').value);
  if (!isFinite(na)) na = head;
  if (!isFinite(nb)) nb = head + used;
  const clamped = na < 0 || nb > hi || nb - na < minSrc;
  na = clamp(na, 0, Math.max(0, hi - minSrc));
  nb = clamp(nb, na + minSrc, hi);
  const mid = (kind === 'clip' ? trimClipLeft(it, (na - head) / rate) : trimVoiceLeft(it, (na - head) / rate)) || it;
  const out = (kind === 'clip' ? trimClipRight(mid, (nb - srcHeadOf(mid) - srcUsedOf(mid)) / rate)
    : trimVoiceRight(mid, (nb - srcHeadOf(mid) - srcUsedOf(mid)) / rate)) || mid;
  if (pos(out.sourceStart) === pos(it.sourceStart) && pos(out.sourceDuration) === pos(it.sourceDuration)
      && pos(out.start) === pos(it.start)) { paintVcCard(); return; }
  const key = LIST_KEY[kind];
  const patchData = { [key]: (filmOf()[key] || []).map(x => (x && x.id === it.id ? out : x)) };
  let label = '把 ' + Edit.describeItem(kind, it.id) + ' 的保留片段改成素材 ' + round1(pos(out.sourceStart)) + '–'
    + round1(pos(out.sourceStart) + pos(out.sourceDuration)) + ' 秒';
  if (clamped) label += '（已按这一条素材能用的范围 0–' + round1(hi) + ' 秒截断）';
  if (kind === 'voice') {
    const caps = filmOf().captions || [];
    patchData.captions = followCaptions(caps, it.id, it, out);
    if (patchData.captions.some((c, i) => c !== caps[i])) label += '；挂在它上面的字幕跟着挪';
  }
  Edit.patch(patchData, label);
}
/* 本机字节回来了 → 把这一句的 `src` 换成本机地址。这是一次「同一份声音的更好读法」，不是用户的一步编辑：
   不压快照、不追历史行、不标脏（换地址不改成片里任何一秒的声音）。
   写的是轨道此刻真正拿着的那一条 —— 每次写入都过 `normalizeFilm` 重造对象，所以按 id 找，不认引用。 */
function adoptLocalVoiceSrc(id, url) {
  const f = filmOf();
  const at = (f.voices || []).findIndex(x => x && x.id === id);
  if (at < 0 || !url || f.voices[at].src === url) return;
  f.voices[at] = { ...f.voices[at], src: url };
  scheduleSave();
}
/* 试听：只放这一句自己那一条音频（不发请求、不计费），从它保留片段的头播起 ——
   听到的就是留在成片里的那一段。播放核（engine/play.js）管的是成片，不是「单句试听」，
   所以这一份留在本模块；再点同一句 = 停。 */
let prevEl = null;
let prevId = '';
let prevTimer = 0;
function stopPrev() {
  if (prevTimer) { clearInterval(prevTimer); prevTimer = 0; }
  if (!prevEl) { prevId = ''; return; }
  try { prevEl.pause(); } catch (e) { /* 本来就停着，没有需要停的 */ }
  prevEl = null; prevId = '';
}
function playPrev(id) {
  const v = (filmOf().voices || []).find(x => x && x.id === id);
  if (prevId === id) { stopPrev(); setStatus('试听停了'); return; }
  if (!v) return;
  if (!v.src) { setStatus('<span class="err">这一句没有可用的音频地址（当时没落成本机文件），回「生成配音」重新合成一句</span>'); return; }
  stopPrev();
  const el = new Audio();
  prevEl = el; prevId = id;
  const head = srcHeadOf(v);
  const used = srcUsedOf(v);
  const rate = rateOf(v);
  const gain = gainOf(v);
  /* 采集这一句此刻该有的增益：淡入淡出是按**成片秒**记的，源里走过的秒数要先 ÷ 倍速折回去。
     Audio 元素音量封顶 1，>100% 的那一截只在成片 / 导出里生效 —— 试听按现值放，
     否则拖完滑块听不出区别，又回到「调了没反应」那一类。 */
  const applyGain = () => {
    const rel = Math.max(0, (num(el.currentTime) - head) / rate);
    let g = gain * fadeGain(v, rel);
    if (g > 1) g = 1;
    try { el.volume = g; } catch (e) { /* 拒设音量就保持原音量，不打断播放 */ }
  };
  el.src = Api.mediaSrc(v.src);
  /* 起播点等元数据回来再设：src 刚设上时 currentTime 还写不进去，写不进就从 0 播起 ——
     源窗口不是从头开始的那一句会放出「已经剪掉的那一段」。出点也停在这里（head + used）。 */
  const out = head + used;
  const startFromHead = () => {
    if (prevEl !== el) return;
    try { if (head > 0.01) el.currentTime = head; } catch (e) { /* 起播点设不上就从头配，不中断这一句 */ }
    try { el.playbackRate = rate; } catch (e) { /* 元素未就绪就按当前速度播 */ }
    applyGain();
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* 浏览器拦住自动播放：没响不算错，用户就在试听这一行的旁边 */ });
  };
  if (el.readyState >= 1) startFromHead();
  else el.addEventListener('loadedmetadata', startFromHead, { once: true });
  prevTimer = setInterval(() => {
    if (prevEl !== el) return;
    if (num(el.currentTime) >= out - 0.02) { stopPrev(); setStatus('试听停在出点：只放这一句保留的那一段'); return; }
    applyGain();
  }, 40);
  el.onended = () => { if (prevEl === el) stopPrev(); };
  el.onerror = () => { stopPrev(); setStatus('<span class="err">这一句的字节取不到：先把它「存回本机」或回语音台重新合成</span>'); };
  setStatus('试听「' + esc(String(v.who || v.text || '这一句').slice(0, 14)) + '」：'
    + round1(used) + ' 秒音频 ÷ ' + spdTxt(rate) + '，增益 ' + Math.round(gain * 100) + '%'
    + ((pos(v.fadeIn) || pos(v.fadeOut)) ? '，按淡入淡出走' : ''));
}
function voiceWayOf(REG, key) {
  /* 「这一句按哪种方式定音色」的判据在公共层（`Chars.Pipe.ttsWayOfChosen`），和工作台语音栏同一份：
     **跟着下拉里选中的那一个型号走**。以前这里按「这一家有没有预设音色」排优先级
     （preset > design > clone），于是用户选了「音色设计」型号而画的还是预设音色下拉、
     选了「音色复刻」型号时连「选参考音频」那张卡都不出现 —— 而那三个型号挂在同一家平台上，
     下拉里全都列得出来（用户原话：应该像工作台一样按选中的模型动态加载）。 */
  const w = Chars.Pipe.ttsWayOfChosen(REG, { ttsModel: key });
  if (!w.chosen) return { chosen: null, target: null, mode: 'none', why: w.why };
  const ways = Chars.Pipe.ttsWays(REG, { ttsModel: w.chosen.key });
  return { chosen: w.chosen, ways: ways, target: w.target, mode: w.mode,
    why: w.why || ways.why || '这个语音平台没有能直接合成的型号' };
}
/* 「这一句现在能不能合成」的两条闸，全站只在这一处算（右栏初次渲染、就地重画那一颗按钮、
   提交前最后一道，三个入口问的是下面这三个函数）：
     ① voiceWayWhy —— 这一档定音色**必填的那样东西**缺了没有（设计缺一段声音描述、复刻缺一条参考音频、
        这一家没有能用的型号）；判据与工作台 `submitBlockReason` 的语音分支同一套。
        以前设计档什么都不查，描述空着也照样发：`{{style}}` 空值在模板里被整项省略，
        等于发一个不带描述的请求，而界面上写着「按描述定音色」。
     ② voiceLenWhy —— 要念的话在不在这一家声明的字数区间里（tts.minChars / maxChars，页面不自己编数）。
   合成这一句要计费，所以拦住的那一句必须说清缺的是哪一格，不能只把按钮压暗。 */
function voiceWayWhy(way, draft) {
  /* 措辞与工作台同一份（`TtsAdv.wayWhy`）：以前两页各写一句「音色设计缺描述」，
     一边说「要先写一段声音描述」、一边说「必须填写风格 / 音色描述」，同一个缺陷两种说法。
     `ref` 在这里折算成「有没有一条真拿得到字节的参考音频」—— 导演台存的是一句对象，
     工作台存的是槽位数组，两边形状不同但「缺不缺」是同一件事。 */
  const ref = draft.ref && (draft.ref.src || draft.ref.file || draft.ref.assetId);
  return window.TtsAdv.wayWhy(way, { design: draft.design, ref: ref });
}
function voiceLenWhy(way, draft, tts) {
  /* 字数只按预设 / 设计这两档判（与上游那两档的请求同一份），复刻档本来就不看这一段字。
     上下限与那句措辞都在 `CharLimits` 一份（工作台就绪判定、提示行、提交前那一路问的是同一个）。 */
  if (!way || (way.mode !== 'preset' && way.mode !== 'design')) return '';
  return window.CharLimits.why(draft.text, window.CharLimits.tts(tts));
}
function voiceSynthWhy(way, draft, tts) { return voiceWayWhy(way, draft) || voiceLenWhy(way, draft, tts); }
/* 右栏那句「这一句会落在哪」：**只此一份**（整栏渲染与插针挪动后的就地刷新都读它）。
   各写一遍就会出现「右栏写着 12.5 秒，真发出去落在插针现在的 9 秒」——
   而按钮上写着的就是「合成并加到这一轨」，落点说明是它唯一的依据。 */
function voicePosLine(sh) {
  const p = voicePlaceOf(sh);
  return '落点 成片 ' + round1(p.start) + ' 秒' + (p.hasClip ? '（这一镜画面段起点）' : '（播放头，这一镜还没进成片）');
}
/* 插针一动就只换这一行，不重画整栏 —— 整栏重画会把正在敲的文本换掉、焦点也跟着跳。
   播放中每帧都算 `deriveTimeline` 只会白热机器：按 120ms 一拍，留一拍尾随补最后一次。 */
let voicePosAt = 0, voicePosTimer = 0;
function paintVoicePos() {
  const grp = document.getElementById('grpVoiceAdd'), el = document.getElementById('voicePos');
  if (!grp || grp.hidden || !el) return;
  const now = Date.now(), wait = 120 - (now - voicePosAt);
  if (wait > 0) {
    if (!voicePosTimer) voicePosTimer = setTimeout(() => { voicePosTimer = 0; paintVoicePos(); }, wait);
    return;
  }
  voicePosAt = now;
  const sh = curShot(); if (!sh) return;
  const txt = voicePosLine(sh);
  if (el.textContent !== txt) el.textContent = txt;
}
/* 语音平台与型号：与语音工作台**同一份判据** —— 注册声明兜底，各家的 /models 现拉
   （MiMo 声明的 modelsFilter:'-tts' 也照它走），拉到的按 id 与声明合并能力。
   为什么要现拉：v13 起 `p.models` 只装「用户自己在设置页填过的 id」，而用户常用的就是
   官方那一两个型号 —— 不拉一次的话，没手填过的家在下拉里**一个型号都没有**，
   「全部供应商选择」也就无从谈起。拉回来的并进本页这一份 REG 副本再交给 Chars.Pipe
   （那一份 REG 是素材库共用的，不在这儿改它的语义）。一家失败只用声明兜底，不连坐别家。 */
let voiceLive = {};        // { 平台id: [型号id] }
let voiceLiveKey = '';
async function loadVoiceModels() {
  const withEp = Api.pickable((REGOf().providers || []).filter(p => p.kind === 'audio'))
    .filter(p => p.endpoints && p.endpoints.models);
  const key = withEp.map(p => p.id).join(',');
  if (key === voiceLiveKey) return;                 // 同一批平台只取一次（设置页补了密钥会换 key）
  voiceLiveKey = key;
  if (!withEp.length) return;
  const got = await Promise.all(withEp.map(async p => {
    try {
      const d = await Api.request(p, 'models');
      const list = Api.modelRows(d).map(m => (m && (m.id || m.name)) || '').filter(Boolean);
      const re = p.modelsFilter ? new RegExp(p.modelsFilter) : null;
      const hidden = id => !!(window.ModelPrefs && window.ModelPrefs.isOff(p, id));   // 设置页藏掉的照样藏
      return [p.id, list.filter(id => (!re || re.test(id)) && !hidden(id))];
    } catch (e) { console.warn('[director] ' + (p.name || p.id) + ' 的型号接口不可用，用注册声明：', e.message); return null; }
  }));
  const ok2 = got.filter(Boolean);
  if (!ok2.length) { voiceLiveKey = ''; return; }   // 一家都没取到：不记死签名，下次还能再试
  voiceLive = {};
  ok2.forEach(pair => { voiceLive[pair[0]] = pair[1]; });
  /* 取回来了：还在剪辑模式就重画一次右栏（下拉这才有东西可选） */
  if (midEditTrimOf() && curShot()) renderEditor();
}
/* 本页语音栏用的 REG：把「现拉的型号清单」与「声明的能力」并成一份再交给 Chars.Pipe。
   合并口径逐字照工作台（`studio.html` 的 `audioModels()`）：**声明兜底、现拉/手填那一份优先，
   options 深合一次**。为什么必须查 `modelDocs`：v13 起注册表不再下发型号清单，
   MiMo 那三个 id 的 `modes` / `ttsMode` / `inputRoles`（音色设计、音色复刻、参考音频槽）全在
   `modelDocs` 那张表里，而能力刷新后 `p.models` 里可能只剩一个带 id 的空壳 ——
   只读 `p.models` 的话「这一句怎么定音色」整块掉回预设那一档，
   界面上「声音描述」输入框与「音色素材（参考音频）」那张卡一起消失
   （用户报的两条「模仿音色没有卡片了 / 生成音色没有描述框了」，工作台早就这么修过）。
   清单本身仍然只用「现拉的 ∪ 手填的」，`modelDocs` 不冒充清单（它只是「文档写过这个 id 支持什么」）。 */
function voiceReg() {
  return { providers: (REGOf().providers || []).map(p => {
    if (p.kind !== 'audio') return p;
    const live = voiceLive[p.id] || [];
    const typed = (p.models || []).filter(Boolean);
    if (!live.length && !typed.length) return p;                    // 清单还没有：照原样，别自己造型号
    const declared = new Map((typed.concat(p.modelDocs || [])).map(m => [m.id || m.name, m]));
    const byId = new Map(typed.map(m => [m.id || m.name, m]));
    const ids = [];
    live.forEach(id => { if (id && !ids.includes(id)) ids.push(id); });
    typed.forEach(m => { const id = m.id || m.name; if (id && !ids.includes(id)) ids.push(id); });   // 手填的别丢
    const models = ids.map(id => {
      const d2 = declared.get(id) || p.newModelDefaults || {};       // 声明（含 modelDocs）兜底
      const cur2 = byId.get(id) || {};                              // 现拉/手填那一份优先
      const out = Object.assign({}, d2, cur2, { id: id, name: cur2.name || d2.name || id });
      out.options = Object.assign({}, d2.options || {}, cur2.options || {});
      return out;
    });
    return Object.assign({}, p, { models: models });
  }) };
}
/* 「AI 生成台词」：按这一镜的画面提示词与时长写一句能念完的台词。
   结果落在 sh.line / sh.lineWho（与拆分镜回来那一句同一份数据），不合成、不计费以外的动作。 */
async function generateShotLine(sh) {
  if (!sh) return;
  const host = document.getElementById('lineInline');
  if (!host) return;
  const prompt = String(sh.prompt || '').trim();
  if (!prompt) { setStatus('<span class="err">先写这一镜的画面提示词</span>'); return; }
  if (!window.TextAI || !TextAI.prov(REGOf())) { setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(REGOf()))) { setStatus('<span class="err">请先在「设置」填文字 AI 密钥</span>'); return; }
  const cast = ((window.Chars && Chars.Lib && Chars.Lib.list()) || [])
    .slice(0, 60).map(c => '- ' + String((c && c.name) || '').trim()
      + (c && (c.look || c.desc) ? '：' + String(c.look || c.desc).slice(0, 80) : '')).filter(x => x !== '- ').join('\n')
    || '（素材库还没有角色）';
  const sys = TextAI.prompt('line_write', undefined, {
    prompt: prompt,
    duration: sh.duration ? sh.duration + ' 秒' : '未声明（按内容估，宁短勿长）',
    cast: cast,
    line: String(sh.line || ''),
  });
  host.hidden = false;
  try {
    const txt = await AiStream.text(REGOf(), sys, '请给这一镜写一句台词。', {
      host: host, title: 'AI 正在按这一镜的提示词写台词…',
    });
    const j = TextAI.parseJson(txt) || {};
    const line = String(j.line != null ? j.line : txt).trim().replace(/^["'「]|["'」]$/g, '');
    const speaker = j.speaker != null ? String(j.speaker).trim() : '';
    if (!line) { setStatus('这一镜没有写出台词（可能本来不该有人说话）'); return; }
    sh.line = line;
    if (speaker) sh.lineWho = speaker;
    filmEdited();
    const over = sh.duration && estimateSpeechSeconds(line) > Number(sh.duration) + 0.05;
    setStatus(over
      ? '<span class="warn">✓ 已写上台词；这句比镜头时长略长，生成语音后可能要挪一下</span>'
      : '<span class="ok">✓ 已按这一镜的提示词写上台词</span>');
  } catch (e) {
    setStatus('<span class="err">写台词失败：' + esc(String(errText(e))) + '</span>');
  }
}

/* 「生成语音」：台词 + 说话人素材 → 该用克隆 / 声音描述 / 预设哪一种，由角色身上已有的料决定。
   合成落在这一镜画面段起点；同一句台词已经有配音时替换掉（保留第一条的 id，字幕链接不断）。 */
async function generateLineVoice(sh) {
  if (!sh) return;
  const text = String(sh.line || '').trim();
  if (!text) { setStatus('<span class="err">先写一句台词</span>'); return; }
  const who = String(sh.lineWho || '').trim();
  if (!who) { setStatus('<span class="err">先写说话人（素材库里同名的那一位）</span>'); return; }
  if (!window.Chars || !Chars.Pipe || !Chars.Pipe.voicePlanOf) { setStatus('<span class="err">素材库模块没加载，读不到角色的音色料</span>'); return; }
  let plan;
  try { plan = await Chars.Pipe.voicePlanOf(voiceReg(), { ttsModel: projOf().voiceModel || '' }, who); }
  catch (e) { setStatus('<span class="err">读角色音色失败：' + esc(String(errText(e))) + '</span>'); return; }
  if (!plan || !plan.ok) { setStatus('<span class="err">' + esc(String((plan && plan.why) || '这位没有可用的音色料')) + '</span>'); return; }
  const place = voicePlaceOf(sh);
  if (!place.hasClip) { setStatus('<span class="err">这一镜还没进成片：先在时间线里用一条候选，再生成语音</span>'); return; }
  const old = (lineVoicesOf(sh) || []);
  const modeZh = plan.mode === 'clone' ? '参考音频复刻' : plan.mode === 'design' ? '声音描述' : '预设音色';
  const modelTxt = (plan.target.model.id || plan.target.model.name || '') + '（' + (plan.target.prov.displayName || plan.target.prov.id || '') + '）';
  const ok = await Confirm.ask({
    title: '生成这一句的语音？',
    body: '「' + text.slice(0, 36) + (text.length > 36 ? '…' : '') + '」用「' + (plan.char.name || who) + '」的' + modeZh
      + '，型号 ' + modelTxt + '。落点：成片 ' + round1(place.start) + ' 秒（这一镜画面段起点）。'
      + (plan.fellback ? '（角色原来选的方式这一家没有，改用' + modeZh + '。）' : '')
      + (old.length ? '会替换这一句已有的 ' + old.length + ' 条配音。' : '')
      + '会真发一次请求并计费。',
    okLabel: '生成', cancelLabel: '取消',
  });
  if (!ok) return;
  const vd = voiceDraftOf();
  vd.shotId = sh.id;
  vd.text = text;
  vd.who = who;
  vd.design = plan.mode === 'design' ? String(plan.note || '') : '';
  vd.ref = plan.mode === 'clone'
    ? { assetId: '', src: '', name: (plan.char.name || who) + ' · 参考音频', file: plan.blob }
    : null;
  vd.voice = plan.mode === 'preset' ? String(plan.voice || '') : '';
  const fmts = (window.TtsAdv && window.TtsAdv.formats) ? window.TtsAdv.formats(plan.target.prov, plan.target.model) : [];
  vd.format = String(fmts[0] || (plan.target.prov.tts && plan.target.prov.tts.defFormat) || '');
  vd.tb = {};
  projOf().voiceModel = plan.target.key;
  renderEditor();
  await addVoiceAtPin({ replaceIds: old.map(v => v.id) });
  setVcTab('clip');
  renderEditor();
}

function renderVoiceCol(col, sh) {
  const idx = allShots().indexOf(sh) + 1;
  /* 配音草稿跟镜走（draft.shotId 记它属于哪一镜）：草稿对象是全局一份，
     不清的话切到 B 镜点「合成」会把 A 镜那句台词（连音色 / 参考音频）合到 B 镜上 —— 真发请求、真扣费。
     留一个空草稿远比带着上一镜的句子诚实；从台词那一行点进来会重新按那句填。 */
  const vd = voiceDraftOf();
  if (vd.shotId !== sh.id) {
    vd.shotId = sh.id;
    vd.text = ''; vd.who = ''; vd.design = ''; vd.ref = null;
  }
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  /* 平台与型号走「注册声明 + 各家 /models 现拉」这一份（voiceReg），与语音工作台同一判据；
     取回后它会自己重画一次这一栏（见 loadVoiceModels 末尾） */
  const VREG = voiceReg();
  loadVoiceModels();
  const way = voiceWayOf(VREG, projOf().voiceModel || '');
  const preset = way.mode === 'preset' ? Chars.Pipe.voices(VREG, { ttsModel: way.chosen.key }, 'preset') : [];
  if (way.mode === 'preset' && !preset.some(v => v.id === voiceDraftOf().voice)) voiceDraftOf().voice = preset.length ? preset[0].id : '';
  const tts = (way.chosen && way.chosen.prov && way.chosen.prov.tts) || {};
  const mine = shotFilmVoices(sh.id);
  const n = mine.length;
  /* 分轨 / 合轨是**全片**动作：句数按整条配音轨数，不是这一镜的 n（那一镜空着也要能合轨）。 */
  const nAll = (filmOf().voices || []).length;
  /* 字幕那一格：全片一份数据（`proj.film.captions`，时间就是成片秒），
     清单与那些动作都在 Caption 域里画 / 绑 —— 这一栏只把那一格放进卡里。 */
  /* 「台词」那一档两段的数据：本镜那一句（还没写也留一行，那是写作入口）与其余每一句。
     一行只出现一次 —— 本镜那一行不在「全片」里重复一遍，否则同一个字段两格输入框，
     敲其中一格另一格还是旧字（本项目反复要拦的那一类）。 */
  const lRows = linePanelRows(sh, { includeEmptyMine: true });
  const lMine = lRows.filter(r => r.mine);
  const lAll = lRows.filter(r => !r.mine);
  const lCnt = lineCntTexts(sh);
  /* 合成设置：**与语音工作台同一份**（公共层 `TtsAdv`）—— 格式清单按「型号声明优先、平台声明兜底」，
     顶层开关就是工作台高级设置里那一排磁贴（AdvExtras.html.topBools），连点法都是同一个函数。
     以前这一栏自己拼了一套 `<select data-vbool>`，同一家平台在工作台上能勾的开关在这里是另一套控件，
     改一处漏一处（本项目反复要拦的那一类）。 */
  const boolProv = (way.target && way.target.prov) || (way.chosen && way.chosen.prov) || null;
  const boolModel = (way.target && way.target.model) || (way.chosen && way.chosen.model) || null;
  const fmts = window.TtsAdv.formats(boolProv, boolModel);
  if (fmts.length && !fmts.includes(voiceDraftOf().format)) voiceDraftOf().format = String(tts.defFormat || fmts[0] || '');
  /* 顶层开关的上下文：语音这种「一次请求只发一句话」的用法没有输入模式与画质档，
     所以 mode / intent 是空串、caps 为 null —— 与工作台语音栏同一份（那里 shapeCaps 在 audio 下也返回 null）。 */
  const tbCtx = { mode: '', intent: '', caps: null };
  const tb = boolProv ? window.TtsAdv.topBoolsHTML(boolProv, boolModel, tbCtx, voiceDraftOf().tb) : { html: '', count: 0 };
  /* 两道闸（这一档缺什么 / 字数在不在区间里）与提交前问的是同三个函数，见 `voiceWayWhy` 那一段。
     上下限的数仍然只从声明读（tts.minChars / maxChars），页面不自己编 —— 读法与措辞在 `CharLimits` 一份。 */
  const vB = window.CharLimits.tts(tts);
  const wayWhy = voiceWayWhy(way, voiceDraftOf());
  const vLenWhy = voiceLenWhy(way, voiceDraftOf(), tts);
  const voiceCanSynth = !wayWhy;
  const advBits = [];
  if (fmts.length) advBits.push('<div><label>输出格式</label><select id="voiceFmt">'
    + window.TtsAdv.formatOptionsHTML(fmts, voiceDraftOf().format) + '</select></div>');
  if (tb.count) advBits.push(tb.html);
  /* 这一栏整片重画：里面 .ed-body 是滚动容器，重画会把它连同位置一起换掉
     （以前靠外壳那份全局猴补兜着，现已撤掉）→ 走公共件 Wb.viewport.keep，按锚点还视口。 */
  const voiceHtml = `
    <div class="ed-head"><b id="edTitle">${esc(sh.name || '这一镜')}</b><span class="no">第 ${idx} 镜</span></div>
    <div class="ed-body">
      <!-- 「这一段 / 配音 / 字幕」三档，一次只露对应的那几格。点中轨上一段或一句 → 这一段
           （参数卡 + 这一镜上的配音清单）；台词与生成配音合在「配音」；字幕独立。
           显隐由 paintVcCard 一处翻 hidden。档位条常驻，右栏任何时候都有导航。 -->
      <div class="ui-seg vc-tabs" id="vcTabs" role="tablist">
        <button type="button" data-vctab="clip" role="tab">这一段</button>
        <button type="button" data-vctab="voice" role="tab">配音</button>
        <button type="button" data-vctab="sub" role="tab">字幕</button>
      </div>
      <!-- 「指着哪一段 / 哪一句，就改它的参数」这一张卡：目标、读数、哪一行该画出来，
           全部由 paintVcCard() 一处写 —— 它和轨道上的手势读同一个焦点（Edit.focusOf()），
           卡片自己不留第二份「我在改哪一段」。写入只有一个出口（Edit.patch），
           于是撤销、波纹、落盘与重画和拖把手那一路完全同一套。
           音量是 0–400%（模型里 volume 就是 0–4 的线性增益，200% = 两倍振幅）；
           倍速 0.25–4；淡入淡出只对配音（画面段的渐变归转场那枚 ◇）；静音只对画面段的原声。
           ⚠ 这段注释里的函数名一律不加反引号：它在一个模板字符串里面，加反引号就是把字符串当场截断。 -->
      <div class="tl-adj" id="tlAdj">
        <div class="adj-row">
          <span class="lab">改谁</span>
          <span class="cnt" id="adjTarget">未选中</span>
        </div>
        <!-- 入出点那两框住在这张卡里（剪辑软件里入出点归片段检视器，不该压在时间线底下）：
             两框是**素材里的秒数**（源窗口的头 → 尾），不是轨道上那块有多宽 —— 中间差一枚倍速，
             下面那句说明把这笔账念出来。「应用」把两个数折成左缘与右缘各自的增量，
             落回 tl-resize 那四把剪子 —— 边界能推多少由素材窗口与最短时长定，这里不自己判。 -->
        <div class="trim-editor" id="tlTrimRow">
          <span id="trimT"></span>
          从 <input type="number" id="trimS" step="0.1" min="0">
          到 <input type="number" id="trimE" step="0.1" min="0">
          秒 <button type="button" class="ghost mini" id="trimApply">应用</button>
          <span id="trimNote"></span>
        </div>
        <div class="adj-row" id="rowVol">
          <span class="lab" id="adjVolLab">这一段音量</span>
          <span class="tl-vol" title="0–400%">
            ${icon('speaker', 12)}
            <input type="range" id="adjVol" min="0" max="400" step="1" value="100" aria-label="音量">
            <span class="vv" id="adjVolVal">100%</span>
          </span>
        </div>
        <!-- 「整轨音量」与上面那枚各调各的（用户点名要分开的两件事）：上面那枚只管指着的那一个，
             这一枚一次把这一排每一段 / 每一句的增益都设成这一档。跟着目标走：指着配音改句，指着画面改段。 -->
        <div class="adj-row" id="rowVolTrack">
          <span class="lab">整轨音量</span>
          <span class="tl-vol" title="一次把这一排每一段 / 每一句都设成这一档">
            ${icon('layers', 12)}
            <input type="range" id="adjVolTrack" min="0" max="400" step="1" value="100" aria-label="整轨音量">
            <span class="vv" id="adjVolTrackVal">100%</span>
          </span>
        </div>
        <!-- 下面几行按「此刻指着哪一类」显隐（paintVcCard 一处翻 hidden，判据只在那一处）：
             字幕与标记没有增益与倍速；淡入淡出只对配音一句，
             静音只对画面段的原声。 grpVoiceAdd 那一块在「这一镜还没有配音」时不收 ——
             音轨上没有一个块可点，收掉就等于第一句永远加不上。 -->
        <div class="adj-row" id="rowSpd">
          <span class="lab" id="adjSpdLab">这一段倍速</span>
          <span class="tl-vol" title="0.25–4，素材窗口不动">
            ${icon('chart', 12)}
            <input type="range" id="adjSpd" min="0.25" max="4" step="0.05" value="1" aria-label="倍速">
            <span class="vv" id="adjSpdVal">×1</span>
          </span>
        </div>
        <!-- 「整轨倍速」是一枚自己独立的滑块：它读的是此刻这一排每一条的平均档、写的是这一排每一条。
             与上面那枚各调各的 —— 想「整排 ×2、这一句仍 ×1」就先把整排拖到 ×2，再把这一句拖回 ×1。 -->
        <div class="adj-row" id="rowSpdTrack">
          <span class="lab">整轨倍速</span>
          <span class="tl-vol" title="一次把这一排每一段 / 每一句都设成这一档">
            ${icon('layers', 12)}
            <input type="range" id="adjSpdTrack" min="0.25" max="4" step="0.05" value="1" aria-label="整轨倍速">
            <span class="vv" id="adjSpdTrackVal">×1</span>
          </span>
        </div>
        <!-- 渐变只对配音一句（画面段的入出渐变归块之间那一枚 ◇ 转场，段上没有第二份 fade 字段）：
             两枚都是「秒」，上限由卡片按这一句有多长当场写进 max。 -->
        <div class="adj-row" id="rowFade">
          <span class="lab">淡入 / 淡出</span>
          <span class="tl-vol" title="开头淡入的秒数（0 – 这一句的长度）">
            <input type="number" id="adjFadeIn" min="0" step="0.1" value="0" aria-label="淡入秒数">
            <span class="vv">秒淡入</span>
          </span>
          <span class="tl-vol" title="结尾淡出的秒数（0 – 这一句的长度）">
            <input type="number" id="adjFadeOut" min="0" step="0.1" value="0" aria-label="淡出秒数">
            <span class="vv">秒淡出</span>
          </span>
        </div>
        <!-- 静音与音量是两个字段：这一枚只切「这一段的原声进不进成片」，
             上面那枚调好的数一个字节不动 —— 压进同一个数就恢复不了用户原来调好的那一档。 -->
        <div class="adj-row" id="rowMute">
          <span class="lab">这一段原声</span>
          <label class="tl-vol" title="只切进不进成片，音量数值不动">
            <input type="checkbox" id="adjMute" aria-label="静音这一段原声"> 静音
          </label>
        </div>
        <!-- 换行：管的还是此刻指着的那一个东西（配音句 / 画面段）。画面段的行号是真的画在第几行
             （行表按 clip.ln 排行），配音那句的 lane 是**首选行** —— 行表由打包函数按时间重叠现算，
             压着别的句子时它会自己找第一条空行。两颗按钮只改画在哪一行，进成片的时间与顺序一个字不动；
             轨道上直接上下拖也能换行，这两颗是给拖不准的人的出口。 -->
        <div class="adj-row" id="rowLane">
          <span class="lab">所在行</span>
          <span class="cnt" id="cutLaneRow">第 1 行</span>
          <button type="button" class="tool mini" id="laneUp" title="挪到上一行（只改画在哪一行，时间与顺序不变）">${icon('arrowUp', 12)} 上一行</button>
          <button type="button" class="tool mini" id="laneDown" title="挪到下一行（只改画在哪一行，时间与顺序不变）">${icon('arrowDown', 12)} 下一行</button>
        </div>
        <div class="hint" id="tlAdjLen"></div>
      </div>
      <div class="grp" id="grpLines">
      <!-- 台词：全站唯一的台词面板（镜头编辑右栏那一份已删）。写的仍是 sh.line / sh.lineWho 那一份数据，
           AI 拆分镜时按画面带回来的那一句也落在同一字段上；它与提示词各改各的，互不带动。
           点这一行左边的头像把它填进「生成配音」，一个计费请求都不发。 -->
      <div class="ed-label"><span>本镜台词</span><span class="cnt" id="lineCntMine">${esc(lCnt.mine)}</span></div>
      <div class="btn-row">
        ${window.aiBtnHTML({ id: 'lineGenAi', label: 'AI 生成台词', mini: true,
          title: '按这一镜的画面提示词与时长写一句能念完的台词' })}
        <button type="button" class="tool mini" id="lineGenVoice" ${String(sh.line || '').trim() && String(sh.lineWho || '').trim() ? '' : 'disabled'} data-tip-no-line="先写一句台词" data-tip-no-who="先在台词里写说话人" data-tip-ok="按这句台词和说话人的素材直接合成语音">${icon('mic', 13)} 生成语音</button>
      </div>
      <div id="lineInline" hidden></div>
      <div class="line-list one">${lineRowsHTML(lMine)}</div>
      <div class="ed-label"><span>全片台词</span><span class="cnt" id="lineCntAll">${esc(lCnt.all)}</span></div>
      <div class="line-list">${lAll.length ? lineRowsHTML(lAll) : '<div class="hint">还没有别的台词</div>'}</div>
      ${lineWhoDatalistHTML()}
      </div>
      <div class="grp" id="grpVoiceAdd">
      <div class="ed-label"><span>落在哪</span><span class="cnt">${n ? '这一镜已有 ' + n + ' 句' : '这一镜还没有配音'}</span></div>
      <div class="hint" id="voicePos">${esc(voicePosLine(sh))}</div>
      <div class="ed-label"><span>语音平台与型号</span><span class="cnt">${way.chosen ? esc(String((way.chosen.prov.displayName || way.chosen.prov.id || ''))) : ''}</span></div>
      ${Chars.Pipe.modelSelectHTML(VREG, { kind: 'audio', mode: 'text_to_speech', id: 'voiceModel', value: way.chosen ? way.chosen.key : '',
        emptyText: '还没有配好密钥的语音平台 —— 到设置页「语音」那一档填一家' })}
      ${way.mode === 'preset' ? `
        <div class="ed-label"><span>音色</span><span class="cnt">${preset.length} 个可选</span></div>
        <select id="voicePick">${window.TtsAdv.voiceOptionsHTML(preset, voiceDraftOf().voice)}</select>` : ''}
      ${way.mode === 'design' ? `
        <div class="ed-label"><span>声音描述</span></div>
        <!-- 与下面「要念的话」同一只公共类（ui.css 的 .ui-ta）：裸 textarea 吃的是本页那条
             dialog.script textarea 的边框，四个页面四种边框就是这么来的（复用公共件）。 -->
        <textarea id="voiceDesign" class="ui-ta" rows="2" placeholder="例：年轻女声，语速偏慢，带一点沙哑">${esc(voiceDraftOf().design)}</textarea>
        <div class="btn-row">
          <button type="button" class="ghost" id="voiceDesignPick" title="从素材库挑一位，把它身上写的那段音色描述填到这里">${icon('users', 14)} 取一位素材的音色描述</button>
          <button type="button" class="ghost" id="voiceDesignSave" title="把这一格的声音描述写回素材库里同名的那一位"${voiceDraftOf().who ? '' : ' disabled'}>${icon('check', 14)} 存回素材库</button>
        </div>` : ''}
      ${way.mode === 'clone' ? `
        <div class="ed-label"><span>音色素材（参考音频）</span></div>
        <div class="btn-row">
          <button type="button" class="tool" id="voiceRefPick">${icon('mic', 14)} ${voiceDraftOf().ref ? '换一条参考音频' : '选参考音频'}</button>
          <button type="button" class="tool" id="voiceRefFromLib" title="拿素材库里另一位挂着的参考音频当这一句的嗓子">${icon('users', 14)} 用素材的声音克隆</button>
          ${voiceDraftOf().ref ? `<button type="button" class="ghost" id="voiceRefDel">去掉这一条</button>` : ''}
        </div>
        <div class="hint" id="voiceRefName">${voiceDraftOf().ref
          ? '已选：' + esc(voiceDraftOf().ref.name || voiceDraftOf().ref.assetId || '这一条')
          : '还没选参考音频（几秒到几十秒的干净人声）'}</div>` : ''}
      <div class="hint err" id="voiceWayWhy"${wayWhy ? '' : ' hidden'}>${esc(wayWhy)}</div>
      ${advBits.length ? `
        <div class="ed-label"><span>合成设置</span></div>
        <div class="adv-grid" id="voiceAdv">${advBits.join('')}</div>` : ''}
      <div class="ed-label"><span>要念的话</span><span class="cnt" id="voiceCnt">${esc(window.CharLimits.cntLine(voiceDraftOf().text, vB))}</span></div>
      <textarea id="voiceText" class="ui-ta" rows="3" placeholder="这一句配音要念出来的内容">${esc(voiceDraftOf().text)}</textarea>
      <div class="hint err" id="voiceLenWhy"${vLenWhy ? '' : ' hidden'}>${esc(vLenWhy)}</div>
      <div class="btn-row">
        ${window.aiBtnHTML({ id: 'voiceAdd', label: '合成并加到这一轨',
          disabled: !(voiceCanSynth && !vLenWhy),
          title: wayWhy || vLenWhy || '会真发一次请求并计费，点第二下确认' })}
        <button type="button" class="tool" id="voiceFile" title="不发请求、不计费"><span class="ic">${icon('upload', 14)}</span><span class="tx">放一条音频（库里 / 本机）</span></button>
      </div>
      <!-- AI 润色「要念的话」：那颗按钮与工作台、镜头编辑器那一颗是同一副画法、同一个名字（公共层
           InlinePolish.btnHTML，作用域只写进说明句），面板也是同一个（InlinePolish）。
           文案走 TextAI.prompt('audio') 那一套（朗读稿，全站同一份提示词）。
           润色只是改这一句的字，不合成、不计费，所以不用二次确认。 -->
      <div class="btn-row">
        ${InlinePolish.btnHTML({ id: 'voicePolishBtn', scope: '这一句配音', extra: '只改字，不合成' })}
      </div>
      <div id="voicePolish" hidden></div>
      ${voiceBalOut && boolProv && voiceBalOut === boolProv.id ? `
      <div class="ui-note err">上一次合成这一家回了「余额 / 额度不够」（<b>不会拦你</b>，再点一次照样真发请求）
        <button type="button" class="tool mini" id="voiceBalGo" style="margin-left: var(--sp-8)">去「用量与余额」</button></div>` : ''}
      ${window.RawRequest ? RawRequest.liveHTML('dir:voice:' + sh.id) : ''}
      </div>
      <div class="grp" id="grpSub">
      ${capPanelHTML()}
      </div>
      <div class="grp" id="grpVoiceList">
      <!-- 分轨 / 合轨是**全片**动作，所以按钮放在 n ? … : … 三元之外：
           这一镜一句配音都没有时，两颗按钮照样看得见（禁用并写明原因，而不是整块消失）。
           nAll 是整条配音轨的句数，不是这一镜的 n。 -->
      <div class="btn-row">
        <button type="button" class="tool mini" id="voiceSplit"${nAll ? '' : ' disabled'} title="按声音来源把全片配音分到各自的轨道（只改排版，不改成片）${nAll ? '' : ' —— 全片还没有配音'}">${icon('layers', 14)} 分轨${nAll ? ' ' + nAll + ' 句' : ''}</button>
        <button type="button" class="tool mini" id="voiceMerge"${nAll ? '' : ' disabled'} title="把全片配音合到第 1 条轨道（只改排版，不改成片）${nAll ? '' : ' —— 全片还没有配音'}">${icon('merge', 14)} 合轨</button>
      </div>
      ${n ? `
      <div class="vc-list">${mine.map(v => {
        const vol = Math.round(pos(v.volume) * 100);
        const rate = rateOf(v);
        return `<div class="vc-row" data-vid="${esc(v.id)}" title="点这一行选中它，改的就是这一句">
          <b>${esc(String(v.who || v.text || '配音').slice(0, 14))}</b>
          <span>成片 ${round1(pos(v.start))} 秒起 · 念 ${round1(pos(v.duration))} 秒 · 第 ${drawnLaneOf(v.id) + 1} 行${vol === 100 ? '' : ' · 音量 ' + vol + '%'}${rate === 1 ? '' : ' · 倍速 ' + spdTxt(rate)}</span>
          <button type="button" class="ghost mini" data-vplay="${esc(v.id)}" title="本机试听（不发请求、不计费）">${icon('play', 11)}</button>
          <button type="button" class="ghost mini" data-vdel="${esc(v.id)}" title="删掉这一句配音（可 Ctrl+Z 退回）">${icon('trash', 11)}</button>
        </div>`;
      }).join('')}</div>` : `
      <div class="ed-label"><span>这一镜上的配音</span><span class="cnt">还没有</span></div>
      <div class="hint">在台词里点「生成语音」，或到「配音」自己写一句</div>`}
      </div>
    </div>`;
  /* keep 要罩住**所有改这一块高度的画法**，不只是 innerHTML：三档的显隐由 paintVcCard 一处翻
     hidden（拼串时三档全露着），公共件的下拉包装又把原生 select 换成 32px 的 `.dd-btn`。
     这两步留到还视口之后再画，还位时内容与最终那一屏差一截，靠底部的读数会被浏览器夹掉。 */
  Wb.viewport.keep(col, () => {
    col.innerHTML = voiceHtml;
    /* 卡片建好之后立刻跟着现算一次：中栏那一排在**这一栏之前**就画完了，那时这张卡还不存在
       （那里全部是 getElementById 的守卫，所以它什么都不写也不报错）。
       不补这一句就是「滑块画在 100%，而芯片指着的那一段其实调到了 30%」。 */
    paintVcCard();
    if (window.Dropdowns) Dropdowns.build(col);
  });
  /* 卡片那几枚滑块：`input` 只改读数，松手（`change`）才写数据 + 落盘 —— 逐像素写盘会把 filmEdited
     那一串重渲染打成一片，而正在拖的那只手底下的节点会被换掉。目标只从 `Edit.focusOf` 现读（卡片不留
     第二份「我在改哪一段」），写入全部走 Edit.patch 那一对出口。 */
  const tgt = () => cardTarget();
  const slOn = (id, rdId, fmt, write, followLen) => {
    const el = col.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => {
      const rd = col.querySelector('#' + rdId);
      if (rd) rd.textContent = fmt(el.value);
      /* 单条那枚倍速：最下面那句「在成片里占多久」跟着手一起走（同一份 durationLine，
         只是把倍速换成手里的数）。「整轨」两枚在拖动中途**不改**指着那一条的读数 ——
         它管的是整排，把手底下那一枚算进某一段就是「一句读数同时说两件事」。 */
      if (!followLen) return;
      const ln = col.querySelector('#tlAdjLen');
      if (ln && cardKind(tgt())) ln.textContent = durationLine(tgt(), rateOfSlider(el.value));
    });
    el.addEventListener('change', () => { write(el.value); paintVcCard(); });
  };
  slOn('adjVol', 'adjVolVal', v => Math.round(num(v) || 0) + '%', v => {
    const t = tgt(); const kind = cardKind(t);
    if (!kind) return;
    patchItem(kind, t.id, { volume: volOf(v) },
      '把 ' + Edit.describeItem(kind, t.id) + ' 的音量调到 ' + Math.round(volOf(v) * 100) + '%');
  }, false);
  slOn('adjVolTrack', 'adjVolTrackVal', v => Math.round(num(v) || 0) + '%', v => {
    const t = tgt(); const kind = cardKind(t);
    if (!kind) return;
    const gain = volOf(v);
    writeTrack(kind, x => (pos(x.volume) === gain ? x : { ...x, volume: gain }),
      n => '把' + (kind === 'clip' ? '画面' : '配音') + '轨 ' + n + ' 条的音量都调到 ' + Math.round(gain * 100) + '%');
  }, false);
  slOn('adjSpd', 'adjSpdVal', v => spdTxt(rateOfSlider(v)), v => {
    const t = tgt(); const kind = cardKind(t);
    if (kind) writeRate(kind, t.id, rateOfSlider(v));
  }, true);
  slOn('adjSpdTrack', 'adjSpdTrackVal', v => spdTxt(rateOfSlider(v)), v => {
    const t = tgt(); const kind = cardKind(t);
    if (!kind) return;
    const r = rateOfSlider(v);
    writeTrack(kind, x => (rateOf(x) === r ? x : withPlaybackRate(x, r)),
      n => '把' + (kind === 'clip' ? '画面' : '配音') + '轨 ' + n + ' 条的倍速都设成 ' + spdTxt(r));
  }, false);
  /* 渐变只对配音那一句（画面段的入出渐变归块之间那一枚 ◇ 转场）：上限是它自己的长度 ——
     淡入 5 秒的一句填 8 秒，播起来等于整句都在斜坡里（听感是「没有声音」）。 */
  [['fadeIn', '#adjFadeIn', '淡入'], ['fadeOut', '#adjFadeOut', '淡出']].forEach(pair => {
    const el = col.querySelector(pair[1]);
    if (!el) return;
    el.addEventListener('change', () => {
      const t = tgt();
      if (t.kind !== 'voice') return;
      const v = clamp(round1(num(el.value)), 0, Math.max(0, round1(t.end - t.start)));
      patchItem('voice', t.id, { [pair[0]]: v },
        '把 ' + Edit.describeItem('voice', t.id) + ' 的' + pair[2] + '改成 ' + round1(v) + ' 秒');
      paintVcCard();
    });
  });
  /* 静音与音量是两个字段：这一枚只切「这一段的原声进不进成片」，上面那枚调好的数一个字节不动 ——
     压进同一个数就恢复不了用户原来调好的那一档。 */
  const mb = col.querySelector('#adjMute');
  if (mb) mb.onchange = () => { const t = tgt(); if (t.kind === 'clip') Edit.toggleMute(t.id); };
  const lUp = col.querySelector('#laneUp'); if (lUp) lUp.onclick = () => moveRow(-1);
  const lDn = col.querySelector('#laneDown'); if (lDn) lDn.onclick = () => moveRow(1);
  /* 入出点那两框：点「应用」、按回车、改完移开焦点三条路都算（同一出口，值没变就什么都不写）。
     这一栏每次重画都换新节点，所以接线跟着重画重绑。 */
  const trApply = col.querySelector('#trimApply');
  if (trApply) trApply.onclick = applyTrimCard;
  ['#trimS', '#trimE'].forEach(q => {
    const el = col.querySelector(q);
    if (!el) return;
    el.addEventListener('change', applyTrimCard);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyTrimCard(); } });
  });
  const sync = el => { if (window.Dropdowns) Dropdowns.sync(el); };
  const vm = col.querySelector('#voiceModel');
  if (vm) vm.onchange = () => {
    projOf().voiceModel = vm.value;
    /* 顶层开关那一排也跟着清：换到别家之后，上一家那些开关的名字多半根本不存在，
       留着会被带进提交体（那一族的判据是「没声明的字段照发」）。 */
    voiceDraftOf().voice = ''; voiceDraftOf().format = ''; voiceDraftOf().tb = {};
    renderEditor(); scheduleSave();
  };
  const vp = col.querySelector('#voicePick');
  if (vp) { vp.onchange = () => { voiceDraftOf().voice = vp.value; }; sync(vp); }
  const vf = col.querySelector('#voiceFmt');
  if (vf) { vf.onchange = () => { voiceDraftOf().format = vf.value; }; sync(vf); }
  /* 顶层开关（create.topBools）：与工作台同一颗磁贴、同一个点法（TtsAdv.bindTopBools）。
     状态存在 voiceDraft.tb 上，换平台/型号时跟着 voice/format 一起清（见 voiceModel 的 onchange）。 */
  const advBox = col.querySelector('#voiceAdv');
  if (advBox) {
    if (window.fillIcons) fillIcons(advBox);
    window.TtsAdv.bindTopBools(advBox, voiceDraftOf().tb, () => scheduleSave());
  }
  /* 就地重画那一颗按钮与两行红字（不重画整栏：整栏重画会把正在敲的描述框换掉、光标跳走）。
     以前这里只在预设 / 设计两档按字数点亮按钮 —— 复刻档选完参考音频按钮还是灰的，
     而「描述空着」这一条压根没人判（判据在 `voiceWayWhy` 那一份，这里只是把它写回 DOM）。 */
  const paintVoiceGate = () => {
    const ww = voiceWayWhy(way, voiceDraftOf()), lw = voiceLenWhy(way, voiceDraftOf(), tts);
    const w1 = col.querySelector('#voiceWayWhy');
    if (w1) { w1.textContent = ww; w1.hidden = !ww; }
    const w2 = col.querySelector('#voiceLenWhy');
    if (w2) { w2.textContent = lw; w2.hidden = !lw; }
    const btn = col.querySelector('#voiceAdd');
    if (btn) {
      btn.disabled = !!(ww || lw);
      btn.title = ww || lw || '合成这一句并加到轨道上（会真发一次请求并计费，点第二下确认）';
    }
  };
  const vt = col.querySelector('#voiceText');
  if (vt) vt.oninput = () => {
    voiceDraftOf().text = vt.value;
    const cnt = col.querySelector('#voiceCnt');
    /* 就地那一下写的必须还是整句（`N 字 · 这一家 5–5000 字`）：以前这里只写 `N 字`，
       于是敲第一个字就把声明的区间从界面上抹掉了 —— 初像里有、打一个字就没有的读数等于没说。 */
    if (cnt) cnt.textContent = window.CharLimits.cntLine(vt.value, vB);
    paintVoiceGate();
    /* 「将要发出的请求」跟着改：这句话是要真发出去的那段文字。 */
    refreshVoicePreview(sh);
  };
  /* 这一格是**输入框**（上面的 `vd` 是草稿对象，两件事别共用一个名字）：
     同名会撞成「重复声明」，整个模块直接解析失败 —— 这一页当场白屏。 */
  const vdIn = col.querySelector('#voiceDesign');
  if (vdIn) vdIn.oninput = () => { voiceDraftOf().design = vdIn.value; paintVoiceGate(); refreshVoicePreview(sh); };
  /* 取一位素材身上写好的音色描述填进这一格。整链（开哪一档、空描述怎么说、覆盖前先问一句）
     在公共层 `VoiceNote.run` —— 工作台那一格走的是同一条链，两处各拼一份迟早有一种说法在骗人。 */
  const vdp = col.querySelector('#voiceDesignPick');
  if (vdp) vdp.onclick = () => window.VoiceNote.run({
    value: () => vdIn.value,
    write: t => { vdIn.value = t; voiceDraftOf().design = t; paintVoiceGate(); },
    say: setStatus,
  });
  /* 「存回素材库」：把这一格的声音描述写回素材库里同名的那一位 ——
     以后这一位（以及下一集、下一镜）都用它，不用每处重写一遍。
     判据与落点都在 `Chars.Pipe.saveVoiceNote`（按名字找人；已有描述不覆盖 —— 说得清为什么没写）。 */
  const vds = col.querySelector('#voiceDesignSave');
  if (vds) vds.onclick = () => {
    const r = Chars.Pipe.saveVoiceNote(voiceDraftOf().who, voiceDraftOf().design);
    if (!r.ok) { setStatus('<span class="err">' + esc(r.why) + '</span>'); return; }
    setStatus('<span class="ok">✓ 已把这段声音描述存回素材库「' + esc(r.name) + '」（以后这一位都用它）</span>');
    renderEditor();
  };
  const vpb = col.querySelector('#voicePolishBtn');
  if (vpb) vpb.onclick = () => polishVoiceText(col);
  const vrp = col.querySelector('#voiceRefPick');
  if (vrp) vrp.onclick = async () => {
    const rule = (boolProv && window.Capabilities && Capabilities.rule)
      ? Capabilities.rule(boolModel, 'reference_audio', '') : {};
    const got = await AssetPicker.open({
      types: ['音频', '音乐'], multiple: false, limit: 1, title: '选择音色素材（参考音频）',
      /* 第四个来源「素材库」：那位身上挂着的参考音频就是它的音色复刻材料，
         字节由选择器在点「确定」那一刻现取（开弹窗时不读几十 MB）。 */
      chars: 'audio',
      rule: rule, note: '这一条只用来复刻音色，不铺到轨道上；要铺成品用「放一条音频」。',
    });
    if (!got || !got.length) return;
    const it = got[0];
    /* 素材库那一段在本机取不到字节（换过机器、IndexedDB 被清）：当场说清、槽位原地不动。
       递一条没有字节的进去等于「已选：小雅 · 参考音频」配一句「合成时要有参考音频」的自相矛盾。 */
    if (it.dead) { setStatus('<span class="err">' + esc(it.dead) + '</span>'); return; }
    /* 体积先按这一家声明的上限拦一次：发到平台再被拒，用户白等一轮还看不懂原因。 */
    const cap = Number((rule && rule.maxBytes) || 0);
    if (cap) {
      const b = it.file || null;
      const size = b ? b.size : Number(it.byteLength || it.bytes || 0);
      if (size && size > cap) { setStatus('<span class="err">这条参考音频 ' + window.fmtBytes(size) + '，超过这一家的上限 ' + window.fmtBytes(cap) + '（换短一点的片段）</span>'); return; }
    }
    voiceDraftOf().ref = { assetId: it.assetId || '', src: it.src || it.url || '', name: it.name || it.prompt || '', file: it.file || null };
    setStatus('<span class="ok">✓ 已选音色素材：' + esc(voiceDraftOf().ref.name || '这一条') + '（点「合成并加到这一轨」才会真发请求）</span>');
    renderEditor(); scheduleSave();
  };
  const vrd = col.querySelector('#voiceRefDel');
  if (vrd) vrd.onclick = () => { voiceDraftOf().ref = null; renderEditor(); };
  /* 「用素材的声音克隆」：拿素材库里**另一位**挂着的参考音频当这一句的嗓子。
     走公共层 `window.VoiceNote.runClone`（与素材库页那一条同一条链：选择器、措辞、名单都一份）。
     落点仍是 `voiceDraft.ref` —— 与上面「选参考音频」同一个槽位，所以下游（合成那一下）
     一行都不用改。 */
  const vrl = col.querySelector('#voiceRefFromLib');
  if (vrl) vrl.onclick = async () => {
    await window.VoiceNote.runClone({
      apply: (entry) => {
        const src = String((entry && entry.refAudio) || '').trim();
        if (!src) { setStatus('<span class="err">那一位没有挂参考音频 —— 先到素材库给她挂一段</span>'); return; }
        voiceDraftOf().ref = { assetId: src, src: src, name: (entry.name || '那一位') + ' · ' + (entry.refAudioName || '参考音频'), file: null };
        setStatus('<span class="ok">✓ 已用「' + esc(voiceDraftOf().ref.name) + '」当这一句的嗓子（点「合成并加到这一轨」才会真发请求）</span>');
        renderEditor(); scheduleSave();
      },
      say: html => setStatus(html),
    });
  };
  const vbg = col.querySelector('#voiceBalGo');
  if (vbg) vbg.onclick = () => (window.GoPage ? GoPage.go('usage.html') : (location.href = 'usage.html'));
  /* 那张牌上原来的「仍然再试一次」撤了：拦截本身已经取消，再摆一颗「再试」只会让人以为默认不给试。 */
  const add = col.querySelector('#voiceAdd');
  if (add) add.onclick = () => {
    if (Confirm.arm(add, '确认合成？', { note: '这一句会发一次真请求并计费' })) return;
    addVoiceAtPin();
  };
  const fin = col.querySelector('#voiceFile');
  if (fin) fin.onclick = async () => {
    /* 统一资源选择器（与上面「选参考音频」同一个组件、同一套来源）：资产库 / 我的收藏 / 本机文件，
       上传也在弹窗里做。原来这里只挂一个系统文件框，库里那条现成的音频反而选不到 ——
       而「先攒几条别的配音 / 音效，再挑一条铺上来」才是这条路的常用形状。 */
    const got = await AssetPicker.open({
      types: ['音频', '音乐'], multiple: false, limit: 1,
      title: '挑一条音频铺到这一轨上',
      note: '这一条会作为配音铺在插针指着的那一秒（不发请求、不计费）。',
    });
    if (!got || !got.length) return;
    const it = got[0];
    let src = String(it.src || it.url || '');
    if (it.fromLocal && it.file) {
      /* blob: 不是「记得住的」地址（刷新即没，而这一条 src 要活到下一次导出成片）→ 先转存本机资产。
         与语音台那条同一立场：写进 film.voices 的地址必须下次还能取到字节。 */
      try { src = await localAudioAsset(it.file); }
      catch (e) { setStatus('<span class="err">这条本机音频没能存进本机：' + esc(e.message) + '（轨道上不留它）</span>'); return; }
    }
    if (!src || /^blob:/.test(src)) { setStatus('<span class="err">这一条没有能长期记住的地址：换一条，或先把它「存回本机」</span>'); return; }
    await addVoiceEntry(src, sh, { provider: '本机' });
  };
  /* 分轨 / 合轨：批量改几十行，误点一次不轻，所以两枚都要二次确认（点第二下才执行）。
     两枚改的只有「画在第几行」这一件事：进成片的时间、时长、音量一个字节不动，所以成片听起来一模一样。
     分轨按声音来源分组（谁在说 → 音色 → 那条音频的地址），同一组的首选同一行；
     压住了由 packVoiceLanes 自己找空行，超上限的句数照实报，不静默挤进最后一行。 */
  const vsp = col.querySelector('#voiceSplit');
  if (vsp) vsp.onclick = () => {
    if (Confirm.arm(vsp, '确认把全片配音分轨？', { note: '只改画在第几行，时间、时长、音量一个字不动；一步可撤销' })) return;
    const f = filmOf();
    const list = (f.voices || []).filter(v => v && typeof v === 'object');
    if (!list.length) { setStatus('全片还没有配音：先合成一句再分轨'); return; }
    /* 「同一组」的判据只在这一处：先认说话人，其次认这一句用的音色，最后认那条音频本身
       （同一份字节的两句是同一个嗓子，即使谁在说那一栏没填）。 */
    const groupKeyOf = v => String(v.who || '').trim() || String(v.voice || '').trim()
      || (window.Api && Api.mediaKey ? Api.mediaKey(String(v.src || '')) : String(v.src || '')) || v.id;
    const order = [];
    list.forEach(v => { const k = groupKeyOf(v); if (order.indexOf(k) < 0) order.push(k); });
    const groups = Math.min(order.length, LANE_MAX);
    const next = (f.voices || []).map(v => (v ? { ...v, lane: Math.min(order.indexOf(groupKeyOf(v)), LANE_MAX - 1) } : v));
    const plan = packVoiceLanes(next);
    const same = next.every((v, i) => v === (f.voices || [])[i]);
    if (same) { setStatus('已经按声音来源分好了：' + groups + ' 组 · ' + plan.lanes.length + ' 行'); return; }
    Edit.patch({ voices: next }, '把全片 ' + list.length + ' 句配音按声音来源分到 ' + plan.lanes.length + ' 行（'
      + groups + ' 组' + (plan.overflow ? ' · ' + plan.overflow + ' 句放不下，一屏最多 ' + LANE_MAX + ' 行' : '') + '）');
  };
  const vmg = col.querySelector('#voiceMerge');
  if (vmg) vmg.onclick = () => {
    if (Confirm.arm(vmg, '确认把全片配音合到一条轨？', { note: '只改排版，不改成片；同一行里重叠的几句会一起响；一步可撤销' })) return;
    const f = filmOf();
    const timed = (f.voices || []).filter(x => x && typeof x === 'object');
    if (!timed.length) { setStatus('全片还没有配音'); return; }
    if (!timed.some(x => Math.round(pos(x.lane)) !== 0)) { setStatus('已经都在第 1 行'); return; }
    /* 首选全写回第 1 行；时间上真的重叠的那几句由打包函数自己找空行 —— 回执按画出来的行数说。 */
    const plan = packVoiceLanes(timed.map(x => ({ ...x, lane: 0 })));
    Edit.patch({
      voices: (f.voices || []).map(v => (v ? { ...v, lane: 0 } : v)),
    }, '把全片 ' + timed.length + ' 条定时块合到第 1 行'
      + (plan.lanes.length > 1 ? '（时间重叠的几句仍占 ' + plan.lanes.length + ' 行，成片里一起响）' : ''));
  };
  /* 试听：放这一句自己那一条音频（不发请求、不计费），再点同一句 = 停。 */
  col.querySelectorAll('[data-vplay]').forEach(b => b.onclick = () => playPrev(b.dataset.vplay));
  /* 档位条：只翻 hidden（paintVcCard 一处），不重建这一栏 —— 重建会把正在敲的那格换掉、光标跳走。
     「这一段画面」那枚是亮灯（role="presentation"），只有按钮换档。 */
  col.querySelectorAll('#vcTabs button[data-vctab]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.vctab;
      if (!k || k === vcTabOf()) return;
      setVcTab(k);
      paintVcCard();
    };
  });
  /* 「台词」那一档两段：改字直接写 sh.line / sh.lineWho（松手后成片标脏、右栏读数跟着重画）；
     点缩略图 / 标题 = 切到那一镜、把这一句填进合成框（与轨道占位同一个出口）。 */
  bindLineEditors(col, sh);
  const lineGenAi = col.querySelector('#lineGenAi');
  if (lineGenAi) lineGenAi.onclick = () => generateShotLine(sh);
  const lineGenVoice = col.querySelector('#lineGenVoice');
  if (lineGenVoice) lineGenVoice.onclick = () => generateLineVoice(sh);
  /* 清单里点一行 = 选中这一句：与轨道上点那一块**同一个出口**（Edit.selectItem），
     于是焦点、高亮、卡片读数只有一套 —— 卡片跟着换到「音量与倍速」那一档，改的就是这一句。 */
  col.querySelectorAll('.vc-row').forEach(r => {
    r.onclick = e => {
      if (e.target.closest('[data-vplay]') || e.target.closest('[data-vdel]')) return;
      Edit.selectItem('voice', r.dataset.vid);
    };
  });
  /* 删这一句：先选中它，再走工具条那一颗「删除」—— 挂在它身上的字幕、多选时的整组
     都由那一份账处理，这里不写第二遍。 */
  col.querySelectorAll('.vc-row [data-vdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (Confirm.arm(b, '确认删掉？', { note: '只删这一句配音，画面不动；可 Ctrl+Z 退回' })) return;
    if (!Edit.selectItem('voice', b.dataset.vdel)) { setStatus('这一句已经不在轨道上了'); return; }
    Edit.toolAction('delete');
  });
  /* 字幕那一格（清单 + 那几颗按钮）由 Caption 域自己画、自己绑：
     写入走 Edit.patch、点名走 Edit.describeItem，这一边不碰字幕数据。 */
  bindCapPanel(col);
  if (window.RawRequest) RawRequest.bind(col);
  /* 声音栏画完算一次「这一句将要发出什么」：用户还没点合成就能看到实际会发什么。 */
  refreshVoicePreview(sh);
}
/* 复刻用的参考音频 → base64 data URL（接口收的就是它，不是地址）。
   取字节只有一条通道：`AssetTransfer.blobOf` 认得本机资产 / 本机文件 / 平台资产 / 外链，
   与语音台 `audioRefBase64` 是同一套判据 —— 各写一份就会出现「工作台能复刻、导演台同一张图取不到」。 */
async function refAudioBase64(ref) {
  if (!ref) throw new Error('没有选参考音频');
  const blob = ref.file || await AssetTransfer.blobOf(ref.src || ref.assetId);
  if (!blob) throw new Error('这条音频取不到字节（外链可能已经过期）');
  return await AssetTransfer.toDataURL(blob);
}

/* 本机音频 → 一条长期可用的本机资产（与语音台产物同一个落点；预览、导出合成与 FCPXML
   都按本机地址取它，不认临时 blob 地址）。 */
async function localAudioAsset(file) {
  const fmt = String((String(file.name).split('.').pop() || 'mp3')).toLowerCase();
  /* 入口先验扩展名：文件选择器的 accept=audio/* 挡不住 Windows 文件框里切「所有文件」，
     选进来一个 .srt/.txt 会被当音频入账（服务端那道闸会拒，但这里先说清是谁的问题）。 */
  if (!/^(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/.test(fmt)) {
    throw new Error('「' + file.name + '」不是音频文件（.' + fmt + '）—— 本机音频只收 mp3 / wav / m4a / aac / ogg / flac');
  }
  const b64 = await window.AssetTransfer.toB64(file);
  const saved = await Api.saveLocalAsset({ name: file.name, mime: file.type || ('audio/' + fmt), format: fmt, data: b64,
    meta: { provider: '本机', prompt: '' } });
  return saved.url || Api.assetSrc(saved.assetId || saved.id);
}
/* 一句声音 → 一条 VoiceClip 落进 `film.voices` → 写盘 + 重画。
   两个入口（平台合成 / 铺一条本机音频）都从这里进，所以「加了但没进轨」不可能出现。
   落点与行号问的都是轨道那同一把尺子：**成片秒直接定位**（配音不再跟着镜头剪辑自动重锚 ——
   这一句落在哪一秒由这块占位说了算，以后再把画面剪两刀，它还在那一秒）。
   新生成的一句配音按这一镜的画面段起点落位；同一句台词的旧配音会一起换掉。 */
async function addVoiceEntry(src, sh, extra) {
  /* 落点与写入的 `shotId` 用同一个 sh：以前落点问 `curShot()`、写的是传进来的 sh，
     两者在「切镜头的那一瞬间又落了音」时不是同一个镜头，配音会挂到别人身上。 */
  const p = voicePlaceOf(sh);
  const dur = await audioDurOf(src);                       // 音频真实秒数 = 这一句的源窗口
  const f0 = filmOf();
  const replaceIds = (extra && extra.replaceIds) || [];
  const old = replaceIds.length ? (f0.voices || []).filter(v => v && replaceIds.includes(v.id)) : [];
  const place = voiceLaneOf({ start: p.start, duration: dur,
    dropIds: replaceIds, lane: old.length ? Math.round(pos(old[0].lane)) : null });
  /* 12 行在这个时间窗里全被占了：一个字节都不落 —— 但声音已经生成出来了，
     落不下必须说清音频在哪（那条地址就是这一句的全部），不静默吞。 */
  if (place.lane < 0) {
    setStatus('<span class="err">配音轨的 ' + LANE_MAX + ' 行在成片 ' + round1(p.start) + ' 秒这一处都被占了（已到上限），这一句放不下：'
      + '先把别处收掉一行、或把落点换个位置再合成。音频已经生成：' + esc(src) + '</span>');
    return null;
  }
  const f = filmOf();
  /* 替换时沿用第一条旧配音的 id：挂在它身上的字幕链接一条都不用改。 */
  const id = replaceIds.length ? replaceIds[0] : filmId('voice');
  const v = createVoiceClip({
    id, start: p.start, sourceDuration: dur, lane: place.lane,
    /* 要念的话：这一句是自己写的（本机音频没有词）还是从占位继承的（那块占位就是这句台词）。 */
    text: String((extra && extra.text) || (sh && sh.line) || '').trim(),
    /* 说话人跟着这一镜的台词走：分轨时「同一角色归一行」靠它。空串不占键。 */
    who: String((extra && extra.who) || (sh && sh.lineWho) || '').trim(),
    shotId: sh.id, src,
    provider: (extra && extra.provider) || '', model: (extra && extra.model) || '',
    voice: (extra && extra.voice) || '',
  });
  const replaced = replaceIds.length > 0 || (f.voices || []).some(x => x && x.id === id);
  const label = (replaced ? '换掉「' + (sh.name || '这一镜') + '」的旧配音：成片 '
    : '给「' + (sh.name || '这一镜') + '」加一句配音：成片 ')
    + round1(v.start) + '–' + round1(v.start + v.duration) + ' 秒（长 ' + round1(v.duration)
    + ' 秒，第 ' + (place.lane + 1) + ' 行）';
  const voices = (f.voices || []).filter(x => !x || !replaceIds.includes(x.id)).concat([v]);
  Edit.patch({ voices }, label);
  /* 这一条音频若还是会过期的第三方地址（平台临时链接 / 导入的外链）：顺手存一份到本机 ——
     试听与导出合成都读得到字节，不靠明天就失效的地址。 */
  if (needsLocal(v.src)) {
    const nm = GenOf().voiceAssetBase(v) || '配音';
    autoLocalize([{
      entry: { kind: 'asset', provider: v.provider || 'remote', src: v.src, name: nm },
      name: nm,
      apply: url => adoptLocalVoiceSrc(id, url),
    }]);
  }
  /* 加完这一句，右栏那张卡就该指着它：走 Edit.selectItem（与轨道上点那一块同一个出口），
     于是焦点、高亮、卡片读数只有一套。 */
  Edit.selectItem('voice', id);
  return v;
}
async function addVoiceAtPin(opts) {
  const replaceIds = (opts && opts.replaceIds) || [];
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先挑一个镜头</span>'); return; }
  const p = voicePlaceOf(sh);
  /* 花钱之前先问一句「放得下吗」：还不知道这一句多长，所以只问落点那一秒 ——
     12 行都占着这一秒就当场拒绝，一个请求都不发。长度已知之后 `addVoiceEntry` 会再判一次
     （同一份 `voiceLaneOf`），那次更准，两次不冲突。 */
  const myOld = replaceIds.length ? (filmOf().voices || []).filter(v => v && replaceIds.includes(v.id)) : [];
  const try0 = voiceLaneOf({ start: p.start, duration: 0, dropIds: replaceIds,
    lane: myOld.length ? Math.round(pos(myOld[0].lane)) : null });
  if (try0.lane < 0) {
    setStatus('<span class="err">配音轨 ' + LANE_MAX + ' 行都占着成片 ' + round1(p.start) + ' 秒这一处了：'
      + '先把别处收掉一行（或把这句换个落点）再合成 —— 这一次没有发请求、没有计费</span>');
    return;
  }
  const sayText = String(voiceDraftOf().text || '').trim();
  if (!sayText) { setStatus('<span class="err">先写上要念的话</span>'); return; }
  const way = voiceWayOf(voiceReg(), projOf().voiceModel || '');
  const tts2 = (way.target && way.target.prov && way.target.prov.tts) || {};
  /* 花钱前的最后一道闸：与右栏那颗按钮同三个函数（`voiceSynthWhy` = 这一档缺必填 + 字数区间）。
     按钮禁用管的是「点不下去」，这里管的是「导入的旧草稿 / 别处改了的字」—— 两道同一份数。
     以前这里只查字数，于是「音色设计型号没写描述」也照样发出去（`{{style}}` 空值被模板整项省略），
     而界面上写着「这一家按描述定音色」。 */
  const why0 = voiceSynthWhy(way, voiceDraftOf(), tts2);
  if (why0) { setStatus('<span class="err">' + esc(why0) + ' —— 补好再合成</span>'); return; }
  if (way.mode === 'preset' || way.mode === 'design' || way.mode === 'clone') {
    const target = way.target;
    const pid = (target && target.prov && target.prov.id) || '';
    /* **不再拦**（2026-10 用户要求）：以前这里会查「这一家十分钟内报过余额不足吗」，
       报过就先不发、只在声音栏挂一句提示 —— 可用户充完值时它照样拦着，看起来就是
       「充值后还一直报余额不足」。现在的规矩是：**用户点一次就真发一次请求**，
       平台说不够就不够（照实报出来，并把出口给到），我们不再替他省这一轮。 */
    setStatus('<span class="meta">正在合成这一句…</span>');
    let r;
    try {
      /* 「音色怎么给」三档各有各的给法（与语音台同一套约定，收口在 AiGen.synthTts 的 voice 参数）：
         预设递音色 id、设计递空串（描述另走 style）、**复刻递参考音频的 base64**。
         以前这里只有前两种，复刻档压根没入口 —— 现在补齐（取字节走公共通道 AssetTransfer）。 */
      let voiceValue = '';
      if (way.mode === 'preset') voiceValue = voiceDraftOf().voice;
      else if (way.mode === 'clone') {
        setStatus('<span class="meta">正在把参考音频交给平台…</span>');
        try { voiceValue = await refAudioBase64(voiceDraftOf().ref); }
        catch (e) { setStatus('<span class="err">这条参考音频取不到字节：' + esc(String(errText(e))) + '（换一条或先在资产库里把它存回本机）</span>'); return; }
      }
      r = await AiGen.synthTts(target.prov, {
        model: target.model.id || target.model.name, text: sayText,
        snapTag: 'dir:voice:' + sh.id, snapLabel: sh.name || '',
        /* 落盘名与画面素材同一套（场景 + 镜头），`synthTts` 只补扩展名：
           FCPXML 媒体包里的配音文件因此与本机素材库里的是同一个名字。 */
        name: (() => {
          const vctx = shotCtxOf(projOf(), sh);
          return vctx ? voiceBase(vctx) : '';
        })(),
        style: way.mode === 'design' ? String(voiceDraftOf().design || '').trim() : '',
        voice: voiceValue, format: voiceDraftOf().format,
        /* 合成设置里的顶层开关（create.topBools）：与工作台语音栏同一个读法（TtsAdv.read），
           只取这一家声明里「这一次没被藏掉」的那几项 —— 界面上没画的自然不该出现在请求体里。 */
        bools: window.TtsAdv.read(target.prov, { mode: '', intent: '', caps: null }, voiceDraftOf().tb).topBools,
      });
    } catch (e) {
      /* 余额 / 额度不够：除了那句人话（Api 的 ERROR_HINT 已经补了），
         再把「去用量与余额」那个出口挂到声音栏上 —— 状态行过 sanitizeHTML，
         button 会被抹成纯文本，所以能点的东西只能画在这一栏里。 */
      const bal = !!(window.Api && Api.isBalanceErr(e));
      if (bal && pid) { Api.balOut.mark(pid); voiceBalOut = pid; }
      /* 报错里补上「这一次真正发给谁 · 哪个型号」：余额不足这句话是平台自己的原话，
         但它不说是哪一家的余额（用户可能同时配了三家语音），而没有型号时也看不出
         「是不是发错了型号」—— 上一轮「模仿音色用不了」就是因为能力刷新把型号声明抹掉之后
         选中的型号与真正发出去的那一个对不上。这两条都在这一句里给出来，下次一眼能断。 */
      setStatus('<span class="err">合成失败：' + esc(String(errText(e))) + '</span>'
        + '<span class="meta">（发给 ' + esc((target.prov.displayName || target.prov.id || '?'))
        + ' · ' + esc(target.model.id || target.model.name || '?') + '）</span>');
      if (bal) renderEditor();
      return;
    }
    /* 合成成了：把「这一家刚报过余额不足」那笔账清掉，声音栏那张牌也收起来 */
    if (pid && window.Api) Api.balOut.clear(pid);
    if (voiceBalOut) { voiceBalOut = ''; }
    await addVoiceEntry(r.url, sh, {
      text: sayText, provider: target.prov.id, model: target.model.id || target.model.name,
      voice: way.mode === 'preset' ? voiceDraftOf().voice
        : (way.mode === 'clone' ? '按参考音频复刻' : '按描述定音色'),
      who: String(voiceDraftOf().who || '').trim(), replaceIds: replaceIds,
    });
    return;
  }
  setStatus('<span class="err">' + esc(way.why) + '</span>');
}


/* 这一句配音**将要发出**的请求体（dry-run：一个网络请求都不发）。
   字段与 `addVoiceAtPin` 里那一句**同一份**（同一个 `voiceDraft` + 同一个 `way`），
   参考音频那一档用占位说明（真发时才会把那段 base64 交给平台）。
   算不出来就抛 —— 原因照实说，不显示空 JSON。 */
function voicePreviewBody() {
  const way = voiceWayOf(voiceReg(), projOf().voiceModel || '');
  if (!way || !way.target || !way.target.prov) return null;
  const target = way.target;
  const sayText = String(voiceDraftOf().text || '').trim();
  if (!sayText) return null;
  /* 复刻那一档的参考音频是 base64（几百 KB）：预览里换一句占位说明，
     否则整段塞进 DOM 会把页面拖死（`Api.snapOf` 也会压，但先压一次更省）。 */
  const voiceValue = way.mode === 'preset' ? (voiceDraftOf().voice || '')
    : (way.mode === 'clone' ? '<参考音频（发送时才交给平台）>' : '');
  const pv = AiGen.previewTts(target.prov, {
    model: target.model.id || target.model.name, text: sayText,
    style: way.mode === 'design' ? String(voiceDraftOf().design || '').trim() : '',
    voice: voiceValue, format: voiceDraftOf().format,
    bools: window.TtsAdv.read(target.prov, { mode: '', intent: '', caps: null }, voiceDraftOf().tb).topBools,
  });
  return { label: '', provider: target.prov.id || '',
    providerName: target.prov.displayName || target.prov.name || '',
    endpoint: 'create', method: pv.method, path: pv.path, body: pv.body };
}
/* 刷新声音栏的预览（去抖 + 防乱序由 RawRequest.schedule 管）。
   算不出来（还没写要念的话 / 还没选型号）就保持上一份，**不显示空 JSON**。 */
function refreshVoicePreview(sh) {
  if (!sh || !window.RawRequest || !RawRequest.schedule) return;
  const tag = 'dir:voice:' + sh.id;
  RawRequest.schedule(tag, () => {
    const v = voicePreviewBody();
    return v || null;
  });
}

  return {
    audioDurOf,
    voiceWayOf,
    paintVoicePos,
    paintVcCard,
    voiceReg,
    renderVoiceCol,
  };
}
