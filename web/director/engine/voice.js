/* 导演台Voice域：由 engine.js 按域机械搬出（AGENTS.md §17：内部保持命令式、按域拆模块，
   engine.js 只留状态与接线）。区间内的代码逐字保留，只有点名的几处引擎可变状态改经访问器读，
   区间外的名字一律由 createVoice(E) 递进来 —— 这一份里不留第二套工程数据。
   document / window 用参数名遮蔽全局：页面作用域岛递进来的那两份代理继续生效，
   弹层、拖拽示意与键盘监听不会挂到别的常驻页面上。 */
import { round1, spdTxt } from '../util.js';
import { voiceBase, shotCtxOf } from '../naming.js';
import { SEG_MIN, segLen, segFilmLen, segsOf } from '../segments.js';
import { VOICE_SPD_MIN, VOICE_SPD_MAX } from '../voice-layout.js';
import { styleOf } from '../subtitles.js';
import { linePointOf } from '../line-point.js';

export function createVoice(E, document, window) {
  const {
    projOf,
    REGOf,
    uid,
    allShots,
    curShot,
    fmtDur,
    candDur,
    voiceFilmWhy,
    cutSegIdx,
    candSelected,
    voicesEnsure,
    shotVoices,
    voiceLn,
    voiceLanePlan,
    addLaneRow,
    tlVoiceHit,
    voiceVolOf,
    setLaneVol,
    setCutVol,
    setCutLane,
    voiceSplitByMaterial,
    voiceMergeAll,
    cutSpdSeg,
    setCutSpd,
    segLenText,
    voiceLenText,
    setVoiceSpd,
    setTrackSpd,
    setTrackVoiceSpd,
    setTrackVol,
    paintTlGroups,
    syncTlTools,
    filmEdited,
    subAsrBusyOf,
    shotFilmAt,
    subCurrent,
    subStyleWrite,
    subGenerate,
    subResegment,
    subExportSrt,
    subImportSrt,
    subAsr,
    subAddAtPin,
    subDelete,
    subSetText,
    subRowsHTML,
    subSetTime,
    scheduleSave,
    midEditTrimOf,
    voiceElOf,
    playVoicePreview,
    orphanVoicesOf,
    adoptWhy,
    adoptOrphanVoices,
    selectVoice,
    voiceDraftOf,
    vcTabOf,
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
    setVcTab,
  } = E;


/* ============================================================================
   剪辑模式的右栏 = 声音栏（形状照着生成工作台的语音那一栏）
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
   点空白 / 待生成占位换成「生成配音」（三个落点各写一次，见 selectVoice / bindPinZone / bindPendingLane）。 */
/* 「这一家刚刚报过余额/额度不够」：合成失败那一次记下来，十分钟内再点不再白等一整轮 ——
   但**不禁用按钮**：用户可能已经充好了，所以给一句说明加一颗「仍然再试」。
   判据与那笔账都在 Api.balOut / Api.isBalanceErr（api.js），这里只记「这一栏要不要挂那张牌」。 */
let voiceBalOut = '';
/* 量一句音频的真实时长（块宽与 /render 的 dur 都靠它）。量不出来不按 0 记 ——
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
/* 这一句落在哪：段号 + 段内偏移。**先读这一句自己的落点**（点 / 拖轨道上那个「待生成」占位
   写下的 `sh.lineAt` / `sh.lineSeg`），没有落点的镜头才按插针现算 —— 老工程（从没点过占位符）
   「点空白轨道、在针处合成」那一条工作流逐字不变。
   两条都是源秒口径；`v.at` 记的是**相对段起点**的偏移，所以落点要减掉 `s.in`。 */
function voiceTarget(sh, c) {
  if (!c) return null;
  const total = candDur(c, sh);
  const segs = segsOf(c, total);
  if (!segs.length) return null;
  const hasPt = !!sh && sh.lineAt != null && sh.lineAt !== '' && isFinite(Number(sh.lineAt));
  const pt = hasPt ? linePointOf(sh, segs) : null;
  const si = pt ? pt.seg : Math.min(segs.length - 1, cutSegIdx());
  const s = segs[si];
  const src = pt ? pt.at : (Number(projOf().cutAt) || 0);
  const at = round1(Math.max(0, Math.min(Math.max(0, segLen(s) - SEG_MIN), src - s.in)));
  return { si, s, at, segs, total };
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
   各写一遍就会出现「右栏写着 +1.5 秒，真发出去落在插针现在的 0 秒」——
   而按钮上写着的就是「合成并加到这一轨」，落点说明是它唯一的依据。 */
function voicePosLine(sh, c) {
  const t = voiceTarget(sh, c);
  if (t) return '这一句的落点：第 ' + (t.si + 1) + '/' + t.segs.length + ' 段的 +' + t.at + ' 秒（源里 ' + round1(t.s.in + t.at) + ' 秒）'
    + '。要换地方就点 / 拖轨道上那个「待生成」占位 —— 它的位置、插针与合成落点读的是同一个数。';
  return '落点：' + (c ? '这一镜一段画面都没留：按 Ctrl+Z 退回剪切之前'
    : '这一镜还没有候选：先生成或导入一条视频');
}
/* 插针一动就只换这一行，不重画整栏 —— 整栏重画会把正在敲的配音文本换掉、焦点也跟着跳。
   挂在 paintSegFocus 那一串联动里（点轨道 / 拖播放进度都走 setPin）。 */
/* 这一镜有没有「该进成片却进不了」的配音，说出来的一句话（空串 = 没有，那块整个不画）。
   原因只问 `voiceFilmWhy` 那一份判据，不在这里复述是哪一种（换候选 / 候选没了 / 段被剪了）。 */
function voiceOrphanNote(sh) {
  const list = sh ? orphanVoicesOf(sh.id) : [];
  if (!list.length) return '';
  return '这一镜有 ' + list.length + ' 句配音没进成片：' + voiceFilmWhy(list[0])
    + (list.length > 1 ? '（其余 ' + (list.length - 1) + ' 句同理）' : '') + '。';
}
/* 与 `voicePos` 同一批就地重画：插针一动、拖完一块、锁一轨，都只换这一格的文案与按钮的暗，
   不重画整栏（整栏重画会把正在敲的「要念的话」换掉）。 */
function paintVoiceOrphan() {
  const box = document.getElementById('voiceOrphan');
  if (!box) return;
  const sh = curShot();
  const txt = voiceOrphanNote(sh);
  box.hidden = !txt;
  const t = document.getElementById('voiceOrphanTxt');
  if (t) t.textContent = txt;
  const btn = document.getElementById('voiceAdopt');
  if (btn) {
    const why = adoptWhy(sh);
    btn.disabled = !!why;
    btn.title = why ? '搬不了：' + why
      : '把这些句子的锚点换到「用这条」选中的那一镜候选上（只换锚点，音频与时长都不动，改完成片跟着变）';
  }
}
function paintVoicePos() {
  const el = document.getElementById('voicePos');
  if (!el) return;
  const sh = curShot();
  if (!sh) return;
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  el.textContent = voicePosLine(sh, c);
  paintVoiceOrphan();
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
function renderVoiceCol(col, sh) {
  const idx = allShots().indexOf(sh) + 1;
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  const t = voiceTarget(sh, c);
  /* 平台与型号走「注册声明 + 各家 /models 现拉」这一份（voiceReg），与语音工作台同一判据；
     取回后它会自己重画一次这一栏（见 loadVoiceModels 末尾） */
  const VREG = voiceReg();
  loadVoiceModels();
  const way = voiceWayOf(VREG, projOf().voiceModel || '');
  const preset = way.mode === 'preset' ? Chars.Pipe.voices(VREG, { ttsModel: way.chosen.key }, 'preset') : [];
  if (way.mode === 'preset' && !preset.some(v => v.id === voiceDraftOf().voice)) voiceDraftOf().voice = preset.length ? preset[0].id : '';
  const tts = (way.chosen && way.chosen.prov && way.chosen.prov.tts) || {};
  const n = shotVoices(sh.id, c && c.vid).length;
  /* 分轨 / 合轨是**全片**动作：句数按整条配音轨数，不是这一镜的 n（那一镜空着也要能合轨）。 */
  const nAll = voicesEnsure().length;
  /* 字幕那一格：数据从 currentOf 来（唯一出口），显示时间经 mapToFilm；
     这一镜没进成片时退回源秒并把原因写在时间旁边（不拿 0 冒充成片起点）。 */
  const subCur = subCurrent(sh);
  const subSt = styleOf(sh);
  const subAt = shotFilmAt(sh);
  const subSpan = c ? segsOf(c, candDur(c, sh)).reduce((a, s) => a + segFilmLen(s), 0) : 0;
  const subWhere = subAt == null
    ? '这一镜还没进成片：显示的是源秒（选用候选并留在成片里之后，时间会折成成片秒）'
    : '这一镜在成片里从 ' + fmtDur(subAt) + ' 开始，长 ' + fmtDur(subSpan) + '；下面显示的是成片秒';
  const subStaleTxt = subCur.stale
    ? (subCur.staleWhy === 'cand' ? '字幕是按旧候选的源时间做的，换成现在这条候选后没有重映射'
      : subCur.staleWhy === 'nocand' ? '这一镜现在没有选用候选，字幕没有可映射的成片时间'
        : '台词 / 配音已经变过，字幕是按上一版生成的（手改 / 识别结果不会被覆盖）')
    : '';
  const subRows = subRowsHTML(sh, subCur, c);
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
  col.innerHTML = `
    <div class="ed-head"><b id="edTitle">加一句配音</b><span class="no">第 ${idx} 镜 · <span id="edLane">配音轨</span></span></div>
    <div class="ed-body">
      <!-- 「这一镜上的配音 / 音量与倍速 / 台词 / 生成配音 / 字幕」五档：一排分段按钮，
           一次只露一格。点中轨上一句 → 音量与倍速；点台词 / 待生成占位 → 生成配音；
           点字幕块 → 字幕；谁都没点过 → 这一镜上的配音。显隐由 paintTlGroups 一处翻 hidden。 -->
      <div class="ui-seg vc-tabs" id="vcTabs" role="tablist">
        <button type="button" data-vctab="list" role="tab">这一镜上的配音${n ? ' ' + n : ''}</button>
        <button type="button" data-vctab="adj" role="tab">音量与倍速</button>
        <button type="button" data-vctab="lines" role="tab">台词</button>
        <button type="button" data-vctab="gen" role="tab">生成配音</button>
        <button type="button" data-vctab="sub" role="tab">字幕</button>
      </div>
      <!-- 「指着哪一段 / 哪一句，就改它的参数」这一张卡：音量与倍速两枚无级滑块，
           再加画面轨 / 配音轨两枚「行」音量（与段上那枚是乘算：那一行压到 60% 时，那一段调到 100% 进成片仍是 60%）
           与一颗把芯片指着的那一段（或那一句）挪上/挪下一行的出口（行只决定画在哪一条横带里，时间与顺序一个字不动）。
           判据不在这里 —— 目标、取值、锁定与读数全部由 syncTlTools() 一处写（与轨道上面那排剪子同一个出口），
           写点的唯一性见 setCutVol / setCutSpd / setLaneVol / setVoiceSpd。 -->
      <div class="tl-adj" id="tlAdj">
        <div class="adj-row">
          <span class="lab" id="tlVolLab">这一段音量</span>
          <span class="tl-vol" id="tlVolBox" title="这一段 / 这一句自己的音量（0–200%，无级）：进成片还要乘所在那一行的基数">
            ${icon('speaker', 12)}
            <input type="range" id="tlVol" min="0" max="200" step="0.1" value="100" aria-label="音量">
            <span class="vv" id="tlVolVal">100%</span>
          </span>
        </div>
        <!-- 「整轨音量」与上面那枚各调各的（用户点名要分开的两件事之一）：上面那枚只管芯片指着的那一个，
             这一枚一次把这一排此刻画出来的每一段 / 每一句自己的音量都设成这一档。
             它不是「那一行的基数」（基数是乘在每一份之上的那一个数，这一枚改的是那一些数本身），
             跟着目标走：指着配音就改句，指着画面就改段。 -->
        <div class="adj-row">
          <span class="lab">整轨音量</span>
          <span class="tl-vol" id="tlVolTrackBox" title="把这一排每一段 / 每一句自己的音量都设成这一档（0–200%，无级）：与上面那枚各调各的，进成片照样乘所在那一行的基数">
            ${icon('layers', 12)}
            <input type="range" id="tlVolTrack" min="0" max="200" step="0.1" value="100" aria-label="整轨音量">
            <span class="vv" id="tlVolTrackVal">100%</span>
          </span>
        </div>
        <!-- 下面这几块按「此刻指着哪一轨」分组显隐（syncTlTools → paintTlGroups 一处翻 hidden）：
             点画面轨只看见倍速 / 画面轨行，点配音轨只看见配音轨行与加一句配音。
             grpVoiceAdd 那一块在「这一镜还没有配音」时不收 —— 音轨上没有一个块可点，收掉就等于第一句永远加不上。 -->
        <div class="grp" id="grpPic">
        <div class="adj-row">
          <span class="lab" id="tlSpdLab">这一段倍速</span>
          <span class="tl-vol" id="tlSpdBox" title="这一段画面的倍速（0.25–4，无级）：改的是它在轨道上占多宽，源秒与入出点不动">
            ${icon('chart', 12)}
            <input type="range" id="tlSpd" min="0.25" max="4" step="0.05" value="1" aria-label="这一段倍速">
            <span class="vv" id="tlSpdVal">×1</span>
          </span>
        </div>
        <!-- 「整轨倍速」是一枚自己独立的滑块（以前它只是「把上面那枚此刻的档对着清单各调一遍」的一颗按钮，
             于是想「整排 ×2、这一句仍 ×1」就做不到：先把拇指拖到 ×2 那一步已经把指着的那一句改成 ×2 了）。
             两枚各读各的、各写各的；这一枚写完之后上面那枚跟着现算（syncTlTools），不会各说一件事。
             ⚠ 这段注释里的函数名一律不加反引号：它在一个模板字符串里面，加反引号就是把字符串当场截断。 -->
        <div class="adj-row">
          <span class="lab">整轨倍速</span>
          <span class="tl-vol" id="tlSpdTrackBox" title="把这一排每一段的倍速都设成这一档：整排一起缩 / 放，源秒与入出点不动（与上面那枚各调各的）">
            ${icon('layers', 12)}
            <input type="range" id="tlSpdTrack" min="0.25" max="4" step="0.05" value="1" aria-label="整轨倍速">
            <span class="vv" id="tlSpdTrackVal">×1</span>
          </span>
        </div>
        <div class="adj-row">
          <span class="lab">画面轨这一行</span>
          <span class="tl-vol" id="lanePicBox" title="画面轨这一行的基数音量（0–200%，无级）：这一行每一段的原声跟着变，段上那一枚在它之上再乘">
            ${icon('film', 12)}
            <input type="range" id="laneVolPic" min="0" max="200" step="0.1" value="100" aria-label="画面轨这一行的音量">
            <span class="vv" id="laneVolPicVal">100%</span>
          </span>
          <span class="cnt" id="lanePicRow">第 1 行</span>
        </div>
        </div>
        <div class="grp" id="grpVoice">
        <div class="adj-row">
          <span class="lab">配音轨这一行</span>
          <span class="tl-vol" id="laneVoiceBox" title="配音轨这一行的基数音量（0–200%，无级）：这一行每一句配音跟着变，句上那一枚在它之上再乘">
            ${icon('speaker', 12)}
            <input type="range" id="laneVolVoice" min="0" max="200" step="0.1" value="100" aria-label="配音轨这一行的音量">
            <span class="vv" id="laneVolVoiceVal">100%</span>
          </span>
          <span class="cnt" id="laneVoiceRow">第 1 行</span>
        </div>
        <div class="adj-row">
          <span class="lab" id="tlVoiceSpdLab">这一句倍速</span>
          <!-- 这一枚是「配音自己」的倍速：它乘在「那一段画面的倍速」之上，
               1 = 就跟画面一起变。放在 grpVoice 里而不是 grpPic，是因为 grpPic/grpVoice 互斥 ——
               指着配音时画面那枚整块收起，这里不留第二枚「看着都在调速度」的滑块。 -->
          <span class="tl-vol" id="tlVoiceSpdBox" title="这一句配音的倍速（0.25–4，无级）：只改这一句念多快，起点与时长不动">
            ${icon('chart', 12)}
            <input type="range" id="tlVoiceSpd" min="0.25" max="4" step="0.05" value="1" aria-label="这一句配音倍速">
            <span class="vv" id="tlVoiceSpdVal">×1</span>
          </span>
        </div>
        <div class="adj-row">
          <span class="lab">整轨倍速</span>
          <span class="tl-vol" id="tlVoiceSpdTrackBox" title="把这一排每一句的倍速都设成这一档：每一块一起缩 / 放，各句起点与时长不动（与上面那枚各调各的）">
            ${icon('layers', 12)}
            <input type="range" id="tlVoiceSpdTrack" min="0.25" max="4" step="0.05" value="1" aria-label="整轨倍速">
            <span class="vv" id="tlVoiceSpdTrackVal">×1</span>
          </span>
        </div>
        <!-- 换行：管的还是芯片指着的那一个东西（配音句 / 画面段），与上面两枚滑块「按行」是同一份行号。
             轨道上直接上下拖也能换行（手势在 bindSegDrag / bindVoiceLane 里），这两颗是给拖不准的人的出口。 -->
        <div class="adj-row">
          <span class="lab">所在行</span>
          <span class="cnt" id="cutLaneRow">第 1 行</span>
          <button class="tool mini" id="laneUp" title="把芯片指着的这一段 / 这一句挪到上一行（只改画在哪一行，进成片的时间与顺序一个字不变）">${icon('arrowUp', 12)} 上一行</button>
          <button class="tool mini" id="laneDown" title="把芯片指着的这一段 / 这一句挪到下一行（只改画在哪一行，进成片的时间与顺序一个字不变）">${icon('arrowDown', 12)} 下一行</button>
        </div>
        <div class="hint" id="tlAdjLen"></div>
      </div>
      </div>
      <div class="grp" id="grpLines">
      <!-- 台词：全站唯一的台词面板（镜头编辑右栏那一份已删）。写的仍是 sh.line / sh.lineWho 那一份数据，
           AI 拆分镜时按画面带回来的那一句也落在同一字段上；它与提示词各改各的，互不带动。
           写完它自己就上本镜 / 全片那两条「待生成配音」轨（判据只有 pendingLineOf 一份）：
           点这一行左边的头像或轨道上的斜纹占位，都把这一句填进「生成配音」，一个计费请求都不发。 -->
      <div class="ed-label" style="margin-top:14px"><span>本镜台词</span><span class="cnt" id="lineCntMine">${esc(lCnt.mine)}</span></div>
      <div class="line-list one" id="lineListMine">${lineRowsHTML(lMine)}</div>
      <div class="ed-label" style="margin-top:14px"><span>全片台词</span><span class="cnt" id="lineCntAll">${esc(lCnt.all)}</span></div>
      <div class="hint">每一行左边是说话人在素材库里的样子（对不上画占位图，名字照留），右边那两个数是这一句在本镜轨与全片轨上的位置。</div>
      <div class="line-list" id="lineListAll">${lAll.length ? lineRowsHTML(lAll) : '<div class="hint">除本镜以外还没有别的台词。</div>'}</div>
      ${lineWhoDatalistHTML()}
      </div>
      <div class="grp" id="grpVoiceAdd">
      <div class="ed-label" style="margin-top:14px"><span>落在哪</span><span class="cnt">${n ? '这一镜已有 ' + n + ' 句' : '这一镜还没有配音'}</span></div>
      <div class="hint" id="voicePos">${esc(voicePosLine(sh, c))}</div>
      <!-- 本镜有配音而全片那一轨空着时，原因说在这一格（两条轨问的是同一份 voiceFilmGap）。
           节点固定在这一处、由 paintVoiceOrphan 就地换文案与暗，不随整栏重画销毁。 -->
      <div class="ui-note" id="voiceOrphan"${voiceOrphanNote(sh) ? '' : ' hidden'} style="margin-top:8px">
        <span id="voiceOrphanTxt">${esc(voiceOrphanNote(sh))}</span>
        <button class="tool mini" id="voiceAdopt" style="margin-left:6px">搬回选用的这一镜</button>
      </div>
      <div class="ed-label" style="margin-top:14px"><span>语音平台与型号</span><span class="cnt">${way.chosen ? esc(String((way.chosen.prov.displayName || way.chosen.prov.id || ''))) : ''}</span></div>
      ${Chars.Pipe.modelSelectHTML(VREG, { kind: 'audio', mode: 'text_to_speech', id: 'voiceModel', value: way.chosen ? way.chosen.key : '',
        emptyText: '注册表里没有配好密钥的语音平台 —— 到设置页「语音」那一档填一家' })}
      ${way.mode === 'preset' ? `
        <div class="ed-label" style="margin-top:14px"><span>音色</span><span class="cnt">${preset.length} 个可选（现读这一家的声明）</span></div>
        <select id="voicePick">${window.TtsAdv.voiceOptionsHTML(preset, voiceDraftOf().voice)}</select>` : ''}
      ${way.mode === 'design' ? `
        <div class="ed-label" style="margin-top:14px"><span>声音描述</span><span class="cnt">这一家按描述定音色</span></div>
        <!-- 与下面「要念的话」同一只公共类（ui.css 的 .ui-ta）：裸 textarea 吃的是本页那条
             dialog.script textarea 的边框，四个页面四种边框就是这么来的（复用公共件）。 -->
        <textarea id="voiceDesign" class="ui-ta" rows="2" placeholder="例：年轻女声，语速偏慢，带一点沙哑">${esc(voiceDraftOf().design)}</textarea>
        <!-- 素材库里那些位写过音色描述，这里是「取过来」而不是「再抄一遍」：
             同一个人的声音在两页各写一句，迟早两种说法。 -->
        <div class="btn-row" style="margin-top:4px">
          <button class="ghost" id="voiceDesignPick" title="从素材库挑一位，把它身上写的那段音色描述填到这里">${icon('users', 14)} 取一位素材的音色描述</button>
          <!-- 写回素材库：这一格填的描述只在这一次配音里，下一集还要再写一遍 ——
               写回去之后，素材库那一位就有了它（下一集/下一镜自动能取到）。
               判据与落点都在 Chars.Pipe.saveVoiceNote（按名字找人；已有描述不覆盖）。
               ⚠ 这段注释里不要用反引号：它在一个模板字符串里面，加反引号就是把字符串当场截断。 -->
          <button class="ghost" id="voiceDesignSave" title="把这一格的声音描述写回素材库里同名的那一位（以后这一位都用它）"${voiceDraftOf().who ? '' : ' disabled'}>${icon('check', 14)} 存回素材库</button>
        </div>` : ''}
      ${way.mode === 'clone' ? `
        <div class="ed-label" style="margin-top:14px"><span>音色素材（参考音频）</span><span class="cnt">这一家按参考音频复刻音色</span></div>
        <div class="btn-row">
          <button class="tool" id="voiceRefPick">${icon('mic', 14)} ${voiceDraftOf().ref ? '换一条参考音频' : '选参考音频'}</button>
          <button class="tool" id="voiceRefFromLib" title="拿素材库里另一位挂着的参考音频当这一句的嗓子（走公共层 VoiceNote.runClone，与素材库页那一条同一条链）">${icon('users', 14)} 用素材的声音克隆</button>
          ${voiceDraftOf().ref ? `<button class="ghost" id="voiceRefDel">去掉这一条</button>` : ''}
        </div>
        <div class="hint" id="voiceRefName" style="margin-top:4px">${voiceDraftOf().ref
          ? '已选：' + esc(voiceDraftOf().ref.name || voiceDraftOf().ref.assetId || '这一条')
          : '还没选：从素材库 / 资产库 / 我的收藏 / 本机文件里挑一条（要几秒到几十秒的干净人声）'}</div>` : ''}
      <div class="hint err" id="voiceWayWhy" style="margin-top:10px"${wayWhy ? '' : ' hidden'}>${esc(wayWhy)}</div>
      ${advBits.length ? `
        <div class="ed-label" style="margin-top:14px"><span>合成设置</span><span class="cnt">${tb.count ? '格式与平台开关现读声明（与工作台同一份）' : '现读这一家的声明'}</span></div>
        <div class="adv-grid" id="voiceAdv">${advBits.join('')}</div>` : ''}
      <div class="ed-label" style="margin-top:14px"><span>要念的话</span><span class="cnt" id="voiceCnt">${esc(window.CharLimits.cntLine(voiceDraftOf().text, vB))}</span></div>
      <!-- 输入框用公共 ui.css 的 .ui-ta（与工作台、素材库那些多行输入同一套边框与圆角），
           不再在这一页另写一条 textarea 规则 —— 四个页面四种边框就是这么来的。 -->
      <textarea id="voiceText" class="ui-ta" rows="3" placeholder="这一句配音要念出来的内容">${esc(voiceDraftOf().text)}</textarea>
      <div class="hint err" id="voiceLenWhy" style="margin-top:4px"${vLenWhy ? '' : ' hidden'}>${esc(vLenWhy)}</div>
      <div class="btn-row">
        <button class="tool acc" id="voiceAdd" ${voiceCanSynth && !vLenWhy ? '' : 'disabled'} title="${esc(wayWhy || vLenWhy || '合成这一句并加到轨道上（会真发一次请求并计费，点第二下确认）')}">${icon('sparkles', 14)} 合成并加到这一轨</button>
        <button class="tool" id="voiceFile" title="打开统一资源选择器：从资产库 / 我的收藏里挑一条现成的音频，或在这里上传本机文件（不发请求、不计费）">${icon('upload', 14)} 放一条音频（库里 / 本机）</button>
      </div>
      <!-- AI 润色「要念的话」：与工作台语音栏是同一个公共面板（InlinePolish），
           文案走 TextAI.prompt('audio') 那一套（朗读稿，全站同一份提示词）。
           润色只是改这一句的字，不合成、不计费，所以不用二次确认。 -->
      <div class="btn-row">
        <button class="tool" id="voicePolishBtn" title="调用文字 AI 改写这一句配音（密钥在「设置」配置；只改字，不合成）">${icon('sparkles', 14)} AI 润色这一句</button>
      </div>
      <div id="voicePolish" hidden></div>
      ${voiceBalOut && boolProv && voiceBalOut === boolProv.id ? `
      <div class="ui-note err" style="margin-top:8px">上一次合成这一家回了「余额 / 额度不够」（这只是上一轮的回执，<b>不会拦你</b> —— 再点一次照样真发请求）
        <button class="tool mini" id="voiceBalGo" style="margin-left:6px">去「用量与余额」</button></div>` : ''}
      <div class="hint">合成会真的发一次请求（按这一家的计费走），所以点第二下才确认。合成后它是轨道上的块：点它选中，切头尾与删掉都在那根剪辑条上，音量在那张卡的滑块上。</div>
      ${window.RawRequest ? RawRequest.liveHTML('dir:voice:' + sh.id) : ''}
      </div>
      <div class="grp" id="grpSub">
      <!-- 「字幕」：entries 是候选源秒，显示与导出都走 mapToFilm。
           台词仍是唯一来源（sh.line）；手改 / 导入 / 识别出来的字幕是快照，不会反写台词。 -->
      <div class="ed-label" style="margin-top:14px"><span>字幕</span><span class="cnt">${subCur.entries.length} 条 · ${subCur.derived ? '按台词/配音现派生' : subCur.source === 'asr' ? '自动识别' : subCur.source === 'manual' ? '手改/导入' : '按台词/配音'}</span></div>
      <div class="hint">${esc(subWhere)}</div>
      ${subStaleTxt ? `<div class="ui-note warn" style="margin-top:6px">${esc(subStaleTxt)}</div>` : ''}
      ${subCur.lineMismatch ? '<div class="ui-note warn" style="margin-top:6px">配音文本与台词不是同一句：字幕目前按配音来（要按台词重新生成，点下面「从台词生成字幕」）</div>' : ''}
      ${subRows.length ? subRows : '<div class="hint">这一镜还没有字幕。可以从台词 / 配音生成，导入一段 SRT，或对这条素材自动识别。</div>'}
      <div class="btn-row" style="margin-top:8px">
        <button class="tool acc" id="subGen" title="按这一镜的台词与已合成配音重新派生字幕（会替换现在这一份，可 Ctrl+Z 退回）">${icon('sparkles', 14)} 从台词生成字幕</button>
        <button class="tool" id="subAdd" title="在插针指着的那一秒加一条手写字幕（2 秒，右栏里改字）">${icon('plus', 14)} 在插针处加一条</button>
      </div>
      <div class="btn-row">
        <button class="tool" id="subImport" title="导入 .srt：文件里的时间按成片秒解释，落在本镜的那几条会折回源秒">${icon('upload', 14)} 导入 SRT</button>
        <button class="tool" id="subExport" title="把全片字幕导出成 .srt（时间是成片秒；这一步不依赖渲染）">${icon('download', 14)} 导出 SRT</button>
        <button class="tool" id="subAsr" ${subAsrBusyOf() ? 'disabled' : ''} title="用语音识别把这条素材里的话变成字幕（会真跑一次识别；结果不会反改台词与配音）">${icon('mic', 14)} ${subAsrBusyOf() ? '识别中…' : '自动识别'}</button>
      </div>
      <div class="ed-label" style="margin-top:14px"><span>样式</span><span class="cnt">预览 / 烧录 / FCPXML 共用这一份</span></div>
      <div class="adv-grid" id="subStyle">
        <div><label>字号（1080p 设计）</label><input type="number" id="subFontSize" min="12" max="300" step="1" value="${subSt.fontSize}"></div>
        <div><label>颜色</label><input type="color" id="subColor" value="${subSt.color}"></div>
        <div><label>位置</label><select id="subPos">
          <option value="bottom"${subSt.position === 'bottom' ? ' selected' : ''}>底部</option>
          <option value="middle"${subSt.position === 'middle' ? ' selected' : ''}>居中</option>
          <option value="top"${subSt.position === 'top' ? ' selected' : ''}>顶部</option>
        </select></div>
        <div><label>每行字数</label><input type="number" id="subMaxChars" min="8" max="120" step="1" value="${subSt.maxCharsPerEntry}"></div>
      </div>
      <label class="hint" style="display:flex;align-items:center;gap:6px;margin-top:6px">
        <input type="checkbox" id="subHl"${subSt.highlight ? ' checked' : ''}> 高亮背景（只在预览与烧录里生效；FCPXML 标题不写这个样式）
      </label>
      <div class="btn-row" style="margin-top:8px">
        <button class="tool" id="subReseg" title="按「每行字数」把长字幕切成几条：内容不变，时间按字数比例分">${icon('rows', 14)} 按每行字数重切</button>
      </div>
      <div class="hint">导出成片时会自动烧录字幕（每条栅格化成与成片同宽高的 PNG）；FCPXML 里写成标题，媒体包另带 subtitles.srt。这些样式在 FCP 标题里只能表达字号 / 颜色 / 位置，背景与高亮只在预览和烧录里生效。</div>
      </div>
      <div class="grp" id="grpVoiceList">
      <!-- 分轨 / 合轨是**全片**动作，所以按钮放在 n ? … : … 三元之外：
           这一镜一句配音都没有时，两颗按钮照样看得见（禁用并写明原因，而不是整块消失）。
           nAll 是整条配音轨的句数，不是这一镜的 n。 -->
      <div class="btn-row" style="margin-top:14px">
        <button class="tool mini" id="voiceSplit"${nAll ? '' : ' disabled'} title="按声音来源（谁在说、音色、素材）把全片的配音分到各自的轨道上（只改排版，时间、时长、音量一个字不动；成片里的声音完全一样）${nAll ? '' : ' —— 全片还没有配音，先合成一句'}">${icon('layers', 14)} 分轨${nAll ? ' ' + nAll + ' 句' : ''}</button>
        <button class="tool mini" id="voiceMerge"${nAll ? '' : ' disabled'} title="把全片所有配音合到第 1 条轨道（只改排版，不改成片；同一轨里可能有重叠，成片里会一起响）${nAll ? '' : ' —— 全片还没有配音，先合成一句'}">${icon('merge', 14)} 合轨</button>
      </div>
      ${n ? `
      <div class="ed-label" style="margin-top:14px"><span>这一镜上的配音</span><span class="cnt">${n} 句</span></div>
      <div class="vc-list">${shotVoices(sh.id, c && c.vid).map(v => {
        const s = t ? t.segs[Math.min(t.segs.length - 1, Math.max(0, Number(v.seg) || 0))] : null;
        return `<div class="vc-row" data-vid="${esc(v.id)}" title="点这一行选中它（右栏换到音量与倍速那一格）">
          <b>${esc(String(v.name || v.text || '配音').slice(0, 14))}</b>
          <span>${s ? '第 ' + (t.segs.indexOf(s) + 1) + ' 段 +' + round1(v.at) + 's' : '段不在了'} · ${round1(Number(v.dur) || 0)}s${Number(v.vol == null ? 1 : v.vol) !== 1 ? ' · 音量 ' + Math.round(Number(v.vol) * 100) + '%' : ''}${Number(v.spd) === 1 ? '' : Number(v.spd) ? ' · 倍速 ' + spdTxt(Number(v.spd)) : ''}</span>
          <button class="ghost mini" data-vplay="${esc(v.id)}" title="试听这一句">${icon('play', 11)}</button>
          <button class="ghost mini" data-vdel="${esc(v.id)}" title="删掉这一句配音">${icon('trash', 11)}</button>
        </div>`;
      }).join('')}</div>` : `
      <div class="ed-label" style="margin-top:14px"><span>这一镜上的配音</span><span class="cnt">还没有</span></div>
      <div class="hint">这一镜还没有配音。切到「生成配音」自己写一句（或从台词那一轨点一个待生成的占位），合成后它会作为块出现在这一条配音轨上。</div>`}
      </div>
    </div>`;
  /* 这一段音量 / 画面倍速 / 配音倍速 / 两条轨按行的音量这几枚滑块：每一枚都是它那个值的唯一出口
     （0–200% / 0.25–4，步进 0.1 与 0.05 = 无级）。`input` 里只改读数与正在响的声音，松手（`change`）
     才写数据 + 落盘 —— 逐像素写盘会把 filmEdited 的那一串重渲染打成一片，而正在拖的那只手底下的节点会被换掉。 */
  const sv = col.querySelector('#tlVol');
  if (sv) {
    sv.addEventListener('input', () => {
      const rd = col.querySelector('#tlVolVal');
      if (rd) rd.textContent = Math.round(Number(sv.value) || 0) + '%';
      const vv = tlVoiceHit();
      /* 拖动预览也走 `voiceVolOf`（句音量 × 行基数）：以前这里用滑块裸值，
         这一行压到 60% 时拖到 100% 会当场听到 100%，松手又跳回 60% —— 听感在松手那一刻变一次。 */
      if (vv && voiceElOf() && !voiceElOf().paused) {
        try { voiceElOf().volume = Math.max(0, Math.min(1, voiceVolOf(Object.assign({}, vv, { vol: Number(sv.value) / 100 })))); } catch (e) { /* 播放器此刻拒设音量就保持原音量，不打断播放 */ }
      }
    });
    sv.addEventListener('change', () => setCutVol(Math.max(0, Math.min(2, Number(sv.value) / 100))));
  }
  const spSl = col.querySelector('#tlSpd');
  if (spSl) {
    spSl.addEventListener('input', () => {
      /* 主读数与最下面那句「源 X 秒 → 成片 Y 秒」跟着手一起走（问的是同一份 `segLenText`）：
         只改主读数就是「拇指已经拖过去，那一格在成片里占多久还在说旧数」。 */
      const r = Number(spSl.value) || 1;
      const rd2 = col.querySelector('#tlSpdVal');
      if (rd2) rd2.textContent = spdTxt(r);
      const w = cutSpdSeg();
      const ln2 = col.querySelector('#tlAdjLen');
      if (w && ln2) ln2.textContent = segLenText(w.segs[w.i], r);
    });
    spSl.addEventListener('change', () => setCutSpd(Number(spSl.value)));
  }
  /* 配音那一枚倍速：与画面那枚同一套两拍（`input` 只改读数与正在响的那一句，`change` 才写数据 + 落盘）。
     正在试听的那一句当场跟着变 —— 拖完听不出区别就又回到「调了没反应」那一类。 */
  const vspSl = col.querySelector('#tlVoiceSpd');
  if (vspSl) {
    vspSl.addEventListener('input', () => {
      const r = Number(vspSl.value) || 1;
      const vv = tlVoiceHit();
      /* 两处读数一起跟着手走：主读数、最下面那句「这一句念几秒」。
         从前 `input` 只改主读数，界面上就是「×1.5」配一句还写着 ×1 / 念 1 秒的旧账（用户点名的
         配音倍速显示错误），非要松手、整栏重画才改口 —— 同一个组件里两个数互相打架。 */
      const rd3 = col.querySelector('#tlVoiceSpdVal');
      if (rd3) rd3.textContent = spdTxt(r);
      const ln3 = col.querySelector('#tlAdjLen');
      if (vv && ln3) ln3.textContent = voiceLenText(vv, r);
      if (vv && voiceElOf() && !voiceElOf().paused && voiceElOf().__vid === vv.id) {
        try { voiceElOf().playbackRate = Math.max(VOICE_SPD_MIN, Math.min(VOICE_SPD_MAX, r)); } catch (e) { /* 倍速设不上（元素未就绪）就按当前速度播 */ }
      }
    });
    vspSl.addEventListener('change', () => setVoiceSpd(Number(vspSl.value)));
  }
  /* 三枚「整轨」滑块：与段 / 句那几枚各调各的，同一套两拍（`input` 只改**自己这一格**的读数、
     `change` 才对着清单批量写数据 + 落盘）。拖动中途不改指着那一段的读数 —— 它管的是整排，
     把手底下的那一枚数值算进某一段就是「一句读数同时说两件事」。 */
  const trackSlOn = (id, rdId, fmt, write) => {
    const el = col.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => {
      const rd = col.querySelector('#' + rdId);
      if (rd) rd.textContent = fmt(el.value);
    });
    el.addEventListener('change', () => write(el.value));
  };
  trackSlOn('tlSpdTrack', 'tlSpdTrackVal', x => spdTxt(Number(x) || 1), val => setTrackSpd(Number(val)));
  trackSlOn('tlVoiceSpdTrack', 'tlVoiceSpdTrackVal', x => spdTxt(Number(x) || 1), val => setTrackVoiceSpd(Number(val)));
  trackSlOn('tlVolTrack', 'tlVolTrackVal', x => Math.round(Number(x) || 0) + '%', val => setTrackVol(Number(val) / 100));
  /* 那两枚「按行的音量」（画面轨 / 配音轨）：同一套 `input` 只改读数、`change` 才写数据。
     调的是**芯片所指那一段/那一句所在那一行**的基数（`paintTlAdjust` 每次重画都把行号写进 `data-ln`），
     不是整条轨 —— 多行之后「整轨」那一个数会把用户刚在第二行调好的音量盖掉。 */
  const laneSl = (id, rdId, k) => {
    const el = col.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => {
      const rd = col.querySelector('#' + rdId);
      if (rd) rd.textContent = Math.round(Number(el.value) || 0) + '%';
    });
    el.addEventListener('change', () => setLaneVol(k, Number(el.value) / 100, Number(el.dataset.ln) || 0));
  };
  laneSl('laneVolPic', 'laneVolPicVal', 'pic');
  laneSl('laneVolVoice', 'laneVolVoiceVal', 'voice');
  const lUp = col.querySelector('#laneUp'); if (lUp) lUp.onclick = () => setCutLane(-1);
  const lDn = col.querySelector('#laneDown'); if (lDn) lDn.onclick = () => setCutLane(1);
  /* 卡片建好之后立刻跟着现算一次：中栏那一排在**这一栏之前**就调过 syncTlTools，
     那时这张卡还不存在（那里全部是 getElementById 的守卫，所以它什么都不写也不报错）。
     不补这一句就是「滑块画在 100%，而芯片指着的那一段其实调到了 30%」。 */
  syncTlTools();
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
  const vd = col.querySelector('#voiceDesign');
  if (vd) vd.oninput = () => { voiceDraftOf().design = vd.value; paintVoiceGate(); refreshVoicePreview(sh); };
  /* 取一位素材身上写好的音色描述填进这一格。整链（开哪一档、空描述怎么说、覆盖前先问一句）
     在公共层 `VoiceNote.run` —— 生成工作台那一格走的是同一条链，两处各拼一份迟早有一种说法在骗人。 */
  const vdp = col.querySelector('#voiceDesignPick');
  if (vdp) vdp.onclick = () => window.VoiceNote.run({
    value: () => vd.value,
    write: t => { vd.value = t; voiceDraftOf().design = t; paintVoiceGate(); },
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
      rule: rule, note: '这一条只用来让平台复刻音色，不会被铺到轨道上；要铺一句成品请用下面的「放一条音频」。',
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
  /* 孤句搬回选用的那一条：只换锚点，不动音频文件本身，所以不重复计费、也不新建任务。
     拒绝的那几条（锁着 / 没有选用候选 / 没有画面段）由 `adoptWhy` 说清，按钮一开始就压暗。 */
  const vop = col.querySelector('#voiceAdopt');
  if (vop) vop.onclick = () => {
    const r = adoptOrphanVoices(curShot());
    if (!r.ok) { setStatus('<span class="err">搬不了：' + esc(r.why) + '</span>'); paintVoiceOrphan(); return; }
    setStatus('<span class="ok">已把 ' + r.n + ' 句配音搬到「用这条」选中的那一条上，全片那一轨跟着有了</span>');
    filmEdited();
  };
  paintVoiceOrphan();
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
      note: '这一条会作为配音铺在插针指着的那一秒（不发请求、不计费）；本机文件也可以，选择器里会先把它存成本机素材。',
    });
    if (!got || !got.length) return;
    const it = got[0];
    let src = String(it.src || it.url || '');
    if (it.fromLocal && it.file) {
      /* blob: 不是「记得住的」地址（刷新即没，而这一条 src 要活到下一次导出成片）→ 先转存本机资产。
         与语音台那条同一立场：写进 proj.voices 的地址必须下次还能取到字节。 */
      try { src = await localAudioAsset(it.file); }
      catch (e) { setStatus('<span class="err">这条本机音频没能存进本机：' + esc(e.message) + '（轨道上不留它）</span>'); return; }
    }
    if (!src || /^blob:/.test(src)) { setStatus('<span class="err">这一条没有能长期记住的地址：换一条，或先把它「存回本机」</span>'); return; }
    await addVoiceEntry(src, sh, c, { name: it.name || it.prompt || '', text: '', provider: '本机', model: '', voice: '' });
  };
  /* 分轨 / 合轨：批量改几十行，误点一次不轻，所以两枚都要二次确认。
     真正的判据、回执与「一步可撤销」在 track.js 的同名函数里（这里只转发）。 */
  const vsp = col.querySelector('#voiceSplit');
  if (vsp) vsp.onclick = () => {
    if (Confirm.arm(vsp, '确认把全片配音分轨？', { note: '只改画在第几行，时间、时长、音量一个字不动；一步可撤销' })) return;
    voiceSplitByMaterial();
  };
  const vmg = col.querySelector('#voiceMerge');
  if (vmg) vmg.onclick = () => {
    if (Confirm.arm(vmg, '确认把全片配音合到一条轨？', { note: '只改排版，不改成片；同一行里重叠的几句会一起响；一步可撤销' })) return;
    voiceMergeAll();
  };
  col.querySelectorAll('[data-vplay]').forEach(b => b.onclick = () => playVoicePreview(b.dataset.vplay));
  /* 三档小选项：只翻 hidden（paintTlGroups 一处），不重建这一栏 —— 重建会把正在敲的那格换掉、光标跳走。 */
  col.querySelectorAll('#vcTabs [data-vctab]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.vctab;
      if (!k || k === vcTabOf()) return;
      setVcTab(k);
      paintTlGroups();
    };
  });
  /* 「台词」那一档两段：改字直接写 sh.line / sh.lineWho（松手后成片标脏、待生成轨跟着重画）；
     点缩略图 / 标题 = 切到那一镜、把这一句填进合成框（与轨道占位同一个出口）。 */
  bindLineEditors(col, sh);
  /* 清单里点一行 = 选中这一句（与轨道上点这一块同一个出口 `selectVoice`，右栏跟着换到音量与倍速）。 */
  col.querySelectorAll('.vc-row').forEach(r => {
    r.onclick = e => {
      if (e.target.closest('[data-vplay]') || e.target.closest('[data-vdel]')) return;
      selectVoice(r.dataset.vid);
    };
  });
  col.querySelectorAll('.vc-row [data-vdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (Confirm.arm(b, '确认删掉？', { note: '只删这一句配音，画面不动' })) return;
    projOf().voices = voicesEnsure().filter(v => v.id !== b.dataset.vdel);
    if (projOf().curVoice === b.dataset.vdel) projOf().curVoice = '';
    setStatus('<span class="ok">✓ 已删掉那一句配音（画面没动，成片时长不变）</span>');
    filmEdited();
  });
  /* 字幕那一格：每个入口都先 beginEdit（可撤销）再写，写完全走 filmEdited。 */
  const sg = col.querySelector('#subGen');
  if (sg) sg.onclick = () => subGenerate(sh);
  const sAdd = col.querySelector('#subAdd');
  if (sAdd) sAdd.onclick = () => subAddAtPin(sh);
  const sImp = col.querySelector('#subImport');
  if (sImp) sImp.onclick = () => subImportSrt(sh);
  const sExp = col.querySelector('#subExport');
  if (sExp) sExp.onclick = () => subExportSrt();
  const sAsr = col.querySelector('#subAsr');
  if (sAsr) sAsr.onclick = () => subAsr(sh);
  const sRes = col.querySelector('#subReseg');
  if (sRes) sRes.onclick = () => subResegment(sh);
  col.querySelectorAll('[data-subtext]').forEach(ta => {
    ta.onchange = () => subSetText(sh, Number(ta.dataset.subtext), ta.value);
  });
  /* 每条字幕的起止两框（subRowsHTML 画的）：输入的秒数按**右栏自己那把尺子**落回源秒 ——
     已进成片的一镜走 mapFromFilm（成片秒 → 源秒），还没进成片的按源秒直写；
     换算只有一个出口（subSetTime），这里不另拼一份折算。 */
  col.querySelectorAll('[data-subt]').forEach(inp => {
    inp.onchange = () => subSetTime(sh, Number(inp.dataset.subi), inp.dataset.subt, parseFloat(inp.value));
  });
  col.querySelectorAll('[data-subdel]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    subDelete(sh, Number(b.dataset.subdel));
  });
  const sfs = col.querySelector('#subFontSize');
  if (sfs) sfs.onchange = () => subStyleWrite(sh, { fontSize: Number(sfs.value) || 54 }, '改字幕字号');
  const sCol = col.querySelector('#subColor');
  if (sCol) sCol.onchange = () => subStyleWrite(sh, { color: sCol.value }, '改字幕颜色');
  const sPos = col.querySelector('#subPos');
  if (sPos) sPos.onchange = () => subStyleWrite(sh, { position: sPos.value }, '改字幕位置');
  const sMc = col.querySelector('#subMaxChars');
  if (sMc) sMc.onchange = () => subStyleWrite(sh, { maxCharsPerEntry: Number(sMc.value) || 24 }, '改字幕每行字数');
  const sHl = col.querySelector('#subHl');
  if (sHl) sHl.onchange = () => subStyleWrite(sh, { highlight: !!sHl.checked }, '改字幕高亮');
  if (window.RawRequest) RawRequest.bind(col);
  /* 声音栏画完算一次「这一句将要发出什么」：用户还没点合成就能看到实际会发什么。 */
  refreshVoicePreview(sh);
  if (window.Dropdowns) Dropdowns.build(col);
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

/* 本机音频 → 一条长期可用的本机资产（与语音台产物同一个落点，/render 才取得到）。 */
async function localAudioAsset(file) {
  const b64 = await new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => res(String(rd.result).split(',')[1] || '');
    rd.onerror = () => rej(new Error('读这个文件失败'));
    rd.readAsDataURL(file);
  });
  const fmt = String((String(file.name).split('.').pop() || 'mp3')).toLowerCase();
  const saved = await Api.saveLocalAsset({ name: file.name, mime: file.type || ('audio/' + fmt), format: fmt, data: b64,
    meta: { provider: '本机', prompt: '' } });
  return saved.url || Api.assetSrc(saved.assetId || saved.id);
}
/* 合成一句 → 量时长 → 存进 proj.voices（锚在插针那一段）→ 重画。
   三个入口（ preset 合成 / design 合成 / 本机音频）都从这里进，所以「加了但没进轨」不可能出现。 */
async function addVoiceEntry(src, sh, c, extra) {
  /* 落点与写入的 `shotId` 用**同一个** sh：以前落点问 `curShot()`、写的是传进来的 sh，
     两者在「切镜头的那一瞬间又落了音」时不是同一个镜头，配音会挂到别人身上。 */
  const t = voiceTarget(sh, c);
  if (!t) { setStatus('<span class="err">现在没有可放的位置：这一镜还没有候选（或这一条一段画面都没留）</span>'); return; }
  const dur = await audioDurOf(src);
  const v = Object.assign({ id: uid(), shotId: sh.id, candId: c.vid, seg: t.si, at: t.at, dur, vol: 1, src }, extra || {});
  v.name = v.name || String(v.text || '配音').replace(/\s+/g, ' ').trim().slice(0, 12);
  /* 说话人跟着这一镜的台词走（`sh.lineWho`）：分轨时「同一角色归一行」靠它。
     空串不占键 —— 老工程没有这个字段，读的一侧照样落到音色 / 素材那一级。 */
  const who = String((sh && sh.lineWho) || v.who || '').trim();
  if (who) v.who = who;
  /* 落哪一行：目标时间窗内没被占的行里取行号最小的；全被占就新开一行。
     行满 12 / 轨收着时 `addLaneRow` 自己给出拒绝的那一句 —— 拿到 -1 就一个字节都不落，
     但声音已经生成出来了，落不下必须说清音频在哪（不静默吞）。 */
  const plan = voiceLanePlan(v);
  let newRow = false;
  if (plan.ln < 0) {
    setStatus('<span class="err">配音轨的 ' + plan.rows + ' 行在这个位置都被占了（已到上限），这一句放不下：'
      + '先收掉一行、或把这一句换个落点再合成。音频已经生成：' + esc(src) + '</span>');
    return;
  }
  if (plan.needNewRow) {
    const got = addLaneRow('voice', document.getElementById('midCol') || document);
    if (got < 0) return;
    v.ln = got;
    newRow = true;
  } else if (plan.ln > 0) {
    v.ln = plan.ln;
  }
  voicesEnsure().push(v);
  /* 这一条音频若还是第三方外链（导入的 FCPXML / 平台返回的临时地址），顺手存一份到本机：
     配音导出与 waveform 解码都读得到字节，不靠会过期的链接。 */
  if (needsLocal(v.src)) {
    const nm = GenOf().voiceAssetBase(v) || v.name || '配音';
    autoLocalize([{
      entry: { kind: 'asset', provider: v.provider || 'remote', src: v.src, name: nm },
      name: nm,
      apply: url => { v.src = url; scheduleSave(); },
    }]);
  }
  /* 走 selectVoice 而不是裸写 `proj.curVoice`：加完这一句，上面那一排剪子与滑块就该指着它
     （目标是「最后点的那一轨」，而「刚加了一句」正是最后碰的是声音轨）。 */
  selectVoice(v.id);
  setStatus('<span class="ok">✓ 已加到第 ' + (t.si + 1) + '/' + t.segs.length + ' 段的 +' + t.at + ' 秒处，长 ' + dur + ' 秒'
    + '；落在' + (newRow ? '新开的' : '') + '第 ' + (voiceLn(v) + 1) + ' 条配音轨（'
    + (newRow ? '原来那些行在这个时间窗里已经有别的语音' : '这一行在这个时间窗里是空的') + '）'
    + (candSelected(sh, c) ? '；这一条已选用，合并成片会带上' : '；这一条还没被选用，换成它或点「用这条」才进成片') + '</span>');
  filmEdited();
}
async function addVoiceAtPin() {
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先挑一个镜头</span>'); return; }
  const cands = sh.candidates || [];
  const c = cands[projOf().curCand] || cands.find(x => x.vid === sh.selId);
  const t = voiceTarget(sh, c);
  if (!t) { setStatus('<span class="err">没有可放的位置：这一镜还没有候选（或这一条一段画面都没留，按 Ctrl+Z 退回剪切之前）</span>'); return; }
  /* 花钱之前先问一句「放得下吗」：还不知道这一句多长，所以只问目标左沿那一秒 ——
     12 行都占着这一秒就当场拒绝，一个请求都不发。长度已知之后 `addVoiceEntry` 会再判一次
     （同一份 `voiceLanePlan`），那次更准，两次不冲突。 */
  const plan0 = voiceLanePlan({ shotId: sh.id, candId: c.vid, seg: t.si, at: t.at, dur: 0 }, true);
  if (plan0.ln < 0) {
    setStatus('<span class="err">配音轨 ' + plan0.rows + ' 行都占着这个位置了：先收掉一行（或把这句换个落点）再合成'
      + ' —— 这一次没有发请求、没有计费</span>');
    return;
  }
  const text = String(voiceDraftOf().text || '').trim();
  if (!text) { setStatus('<span class="err">先写上要念的话</span>'); return; }
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
        model: target.model.id || target.model.name, text,
        snapTag: 'dir:voice:' + sh.id, snapLabel: sh.name || '',
        /* 落盘名与画面素材同一套（场景 + 镜头），`synthTts` 只补扩展名：
           FCPXML 媒体包里的配音文件因此与本机素材库里的是同一个名字。 */
        name: (() => {
          const vctx = shotCtxOf(projOf(), sh);
          return vctx ? voiceBase(vctx, ((projOf().voices || []).length + 1)) : '';
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
        + ' · ' + esc(target.model.id || target.model.name || '?') + '）</span>'
        + (bal ? ' —— 声音栏里有「去用量与余额」的入口' : ''));
      if (bal) renderEditor();
      return;
    }
    /* 合成成了：把「这一家刚报过余额不足」那笔账清掉，声音栏那张牌也收起来 */
    if (pid && window.Api) Api.balOut.clear(pid);
    if (voiceBalOut) { voiceBalOut = ''; }
    await addVoiceEntry(r.url, sh, c, {
      text, provider: target.prov.id, model: target.model.id || target.model.name,
      voice: way.mode === 'preset' ? voiceDraftOf().voice
        : (way.mode === 'clone' ? '按参考音频复刻' : '按描述定音色'),
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
  const text = String(voiceDraftOf().text || '').trim();
  if (!text) return null;
  /* 复刻那一档的参考音频是 base64（几百 KB）：预览里换一句占位说明，
     否则整段塞进 DOM 会把页面拖死（`Api.snapOf` 也会压，但先压一次更省）。 */
  const voiceValue = way.mode === 'preset' ? (voiceDraftOf().voice || '')
    : (way.mode === 'clone' ? '<参考音频（发送时才交给平台）>' : '');
  const pv = AiGen.previewTts(target.prov, {
    model: target.model.id || target.model.name, text,
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
    voiceReg,
    renderVoiceCol,
  };
}
