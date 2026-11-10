/* 导演台Import域：素材进来的四条路 —— 本机视频（拖 / 选）→ 本机资产 → 本镜候选、
   第三方素材自动存本机、资产库 / 收藏导入（AssetPicker）、参考视频 / 参考音频槽位。
   区间内的代码由 engine.js 逐字搬出；REG / proj 走访问器（engine 继续持有这两枚可变状态），
   其余 E 名单在建包这一刻都已就绪；document / window 用参数名遮蔽全局。 */


export function createImport(E, document, window) {
  'use strict';
  const {
    projOf,
    regOf,
    assetProvFor,
    assetStoreId,
    curShot,
    dlStage,
    filmEdited,
    mkImportedCandidate,
    provOf,
    renderAll,
    renderEditor,
    resolvedModel,
    sameAssetSpace,
    scheduleSave,
    setSelectedCandidate,
    setStatus,
    shotInputCaps,
    uid,
  } = E;

/* ---------- 导入本机视频 → 本机资产 → 本镜候选 ----------
   落点和语音台的「本机音频」同一条：`Api.saveLocalAsset` 写进本机资产库并登记索引。
   候选只记 `/asset/<id>`，不记 `blob:`（刷新即失效）也不记文件路径（页面拿不到）。
   去重凭据 `importOp` 由「名字 + 字节数 + 修改时间」算成，服务端不需要认识它：
   同一份文件再导一次只把视口移到已有那条，不再追加第二条候选。 */
const IMPORT_MAX_BYTES = 200 * 1024 * 1024;
function importHitOf(op) {
  if (!op || !projOf()) return null;
  for (const sc of projOf().scenes) {
    for (const sh of (sc.shots || [])) {
      const i = (sh.candidates || []).findIndex(c => c && c.importOp === op);
      if (i >= 0) return { sc, sh, i, c: sh.candidates[i] };
    }
  }
  return null;
}
function focusImported(hit, why) {
  projOf().curScene = Math.max(0, projOf().scenes.indexOf(hit.sc));
  projOf().curShot = Math.max(0, (hit.sc.shots || []).indexOf(hit.sh));
  projOf().curCand = hit.i;
  renderAll();
  setStatus('<span class="ok">' + why + '：在「' + esc(hit.sh.name || '未命名镜头') + '」第 '
    + (hit.i + 1) + ' 条候选里' + (hit.sh.selId === hit.c.vid ? '（已选用）' : '') + '</span>');
}
/* 真实时长 / 尺寸 / 音轨：走 MediaBackend.info（浏览器内 mediabunny 元数据 + <video> 兜底），
   服务端不提供媒体探测。
   失败不要挡住导入本身：拿不到时长就交回 null，播放器会自己量。 */
/* 候选 → 同源媒体地址：候选的 url 常是上游签名外链，必须先过 Api.mediaSrc 换成同源回环；
   本机已镜像的走 EditorMedia（本机优先）。轨道取帧与助手的媒体检查共用这一份。 */
const candTrackSrc = c => {
  const src = c && (c.src || c.url);
  if (!src) return '';
  const EM = window.EditorMedia;
  return EM ? EM.previewSrc(c) : Api.mediaSrc(src);
};
async function mediaInfo(body) {
  const src = (body && (body.src || body.url))
    || (body && body.assetId ? Api.assetSrc(body.assetId) : '');
  if (!src) return null;
  const mb = (window.MediaBackend) || (window.Wb && Wb.vframe && await Wb.vframe._mbReady());
  if (!mb) return null;
  const info = await mb.info(src);
  return info ? {
    duration: info.duration, width: info.width, height: info.height,
    hasAudio: info.hasAudio,
  } : null;
}
function readFileB64(file) {
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => res(String(rd.result).split(',')[1] || '');
    rd.onerror = () => rej(new Error('读这个文件失败（可能被占用或被移动）'));
    rd.readAsDataURL(file);
  });
}
async function importMediaFile(file) {
  if (!file) return;
  const name = String(file.name || '导入视频.mp4');
  const ext = (name.split('.').pop() || 'mp4').toLowerCase();
  const mime = file.type || ({ mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' }[ext] || 'video/mp4');
  if (!/^video\//.test(mime) && !['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) {
    setStatus('<span class="err">「' + esc(name) + '」不是视频文件：这里只收 mp4 / mov / webm / mkv 的画面</span>');
    return;
  }
  if (file.size > IMPORT_MAX_BYTES) {
    setStatus('<span class="err">「' + esc(name) + '」' + window.fmtBytes(file.size)
      + '，超过单文件导入上限 ' + window.fmtBytes(IMPORT_MAX_BYTES) + '</span>');
    return;
  }
  const sh = curShot();
  if (!sh) { setStatus('<span class="err">先在左侧选一个镜头，再把视频导进来</span>'); return; }
  const op = 'file:' + name + ':' + file.size + ':' + (Number(file.lastModified) || 0);
  const dup = importHitOf(op);
  if (dup) { focusImported(dup, '这份文件已经导入过，没有重复追加'); return; }
  setStatus('正在导入「' + esc(name) + '」…');
  try {
    const b64 = await readFileB64(file);
    const saved = await Api.saveLocalAsset({
      name, mime, format: ext || 'mp4', data: b64, media_type: 'video',
      meta: { provider: '本机', prompt: '', importedFrom: 'director' },
    });
    const aid = saved.assetId || saved.id;
    const url = saved.url || Api.assetSrc(aid);
    let info = null;
    try { info = await mediaInfo({ assetId: aid }); } catch (e) {
      console.warn('[director] 媒体检查失败（导入照常）：', e.message);
    }
    const cand = mkImportedCandidate({
      vid: 'local_' + uid(), provider: 'local', url, local: true,
      duration: info && Number(info.duration) > 0 ? Math.round(Number(info.duration) * 10) / 10 : null,
      importOp: op,
    });
    sh.candidates.push(cand);
    const autoSel = !sh.selId;
    if (autoSel) setSelectedCandidate(sh, cand);
    filmEdited();
    setStatus('<span class="ok">✓ 已导入「' + esc(name) + '」为本镜候选'
      + (autoSel ? '，并已选用为这一镜的画面' : '')
      + (info ? '（' + (Number(info.duration) > 0 ? Math.round(Number(info.duration) * 10) / 10 + ' 秒' : '时长未知')
        + (info.width && info.height ? ' · ' + info.width + '×' + info.height : '') + '）' : '')
      + '；文件已存进本机资产库</span>');
  } catch (e) {
    setStatus('<span class="err">导入失败：' + esc(errText(e)) + '</span>');
  }
}

/* ---------- 导入的第三方素材 → 本机 ----------
   用户点名的行为：资产进导演台就自动存一份到本机 —— 剪辑切片取帧与导出都读得到字节，
   不靠一天就过期的签名外链。落点就是 `AssetLocal.pullMany`（与四页的「存回本机」同一条队列、
   同一份去重与回执；它的 force 由内部自带 —— 用户这一次导入就是「当下点下去的」）。
   排队与失败都不挡导入：外链过期前照旧能预览，没能存的只在 Toast 里照实说一句。
   jobs: [{ entry（pull 认的那一份：provider/assetId/genId/src）, name, apply(url) }] */
const needsLocal = s => /^https?:\/\//i.test(String(s || '')) || /^\/(?:getv|fetch)\?/i.test(String(s || ''));
function autoLocalize(jobs) {
  const list = (jobs || []).filter(j => j && j.entry && needsLocal(j.entry.src || j.entry.rawSrc));
  if (!list.length || !window.AssetLocal || !AssetLocal.pullMany) return;
  AssetLocal.pullMany(list, {}).then(s => {
    const txt = AssetLocal.pullSummaryText ? AssetLocal.pullSummaryText(s) : '';
    if (!txt) return;
    if (s.ok && !(s.fails || []).length && !s.cant && !s.skip) Toast.receipt('第三方素材已自动存一份到本机：' + txt);
    else Toast.warn('第三方素材自动存本机：' + txt);
  }).catch(e => console.warn('[director] 自动存本机失败：', errText(e)));
}

/* ---------- 从资产库 / 收藏导入（统一走 AssetPicker） ----------
   中栏「导入」= 只挑视频，作为这一镜的候选画面。
   界面和工作台选参考素材是同一份选择器，本地文件也在那同一个弹窗里选（顶部「本地上传」档位）。
   槽位规则只取 reference_video 那一条：右栏那个「图片/视频一起塞」的入口已经去掉，
   参考图从各槽位进（openPickDlg），这里不再需要「取两个槽位里更严的一条」。 */
function openLibDlg(sh) {
  if (!sh) { setStatus('<span class="err">先在左侧选一个镜头，再从资产库导入</span>'); return; }
  const rm = resolvedModel(sh) || {};
  const rVid = (window.Capabilities && Capabilities.rule) ? Capabilities.rule(rm, 'reference_video') : null;
  AssetPicker.open({
    types: ['视频'],
    multiple: false, limit: 1,
    rule: rVid,
    title: '导入视频作为本镜画面',
    aiSearch: true,
    onPick: e => useLibEntry(sh, e),
  });
}
/* 选中的资产落到这一镜：视频→本镜候选画面（本地收藏先转存成资产，地址才长期有效） */
async function useLibEntry(sh, it) {
  if (!sh) return;
  if (it.type === '视频') {
    // 本地收藏（上传的文件）：先转存成资产，地址才长期有效
    if (it.localFav || it.fromLocal || /^blob:/.test(it.src || '')) {
      try {
        setStatus('正在把本地收藏的视频转存为资产…');
        const aid2 = await libEntryToAssetId(it, (it.prompt || it.name || '收藏视频').replace(/\s+/g, ' ').slice(0, 20) + '.mp4', 'video/mp4');
        /* 转存之后才拿得到资产号；同一条收藏再导一次不该多一条候选。 */
        const opA = 'asset:' + aid2;
        const dupA = importHitOf(opA);
        if (dupA) { focusImported(dupA, '这条视频已经导入过，没有重复追加'); return; }
        const cand2 = mkImportedCandidate({ vid: 'local_' + uid(), provider: assetStoreId(),
          url: Api.assetSrc(aid2), duration: it.duration, importOp: opA });
        sh.candidates.push(cand2);
        if (!sh.selId) setSelectedCandidate(sh, cand2);
        filmEdited();
        setStatus('<span class="ok">✓ 已把收藏的视频导入为这一镜的候选</span>');
        return;
      } catch (e) { setStatus('<span class="err">导入失败：' + e.message + '</span>'); return; }
    }
    // 中栏导入：作为本镜候选画面（来自平台视频接口的保留 vid/provider，签名 URL 过期后可用 freshUrl 重新拉取；
    //            判断依据是注册表里有没有这一家视频平台，而不是写死某个平台名）
    const isPlat = ((regOf() && regOf().providers) || []).some(p => p.kind === 'video' && p.id === it.provider) && it.id
      && !/^(local_|tmp_|asset_)/.test(String(it.id));
    /* 稳定身份优先资产号，其次 `/asset/<id>`，再次平台任务号；签名外链不当身份（天天变）。 */
    const akey = it.assetId
      || (String(it.src || '').match(/\/asset\/([A-Za-z0-9_-]+)/) || [])[1]
      || (isPlat ? it.id : '');
    const op = akey ? 'asset:' + akey : '';
    const dup = importHitOf(op);
    if (dup) { focusImported(dup, '这条资产已经导入过，没有重复追加'); return; }
    const cand = mkImportedCandidate({ vid: isPlat ? it.id : 'local_' + uid(),
      provider: isPlat ? it.provider : 'local', url: it.src, local: !isPlat, duration: it.duration,
      importOp: op || undefined });
    sh.candidates.push(cand);
    if (!sh.selId) setSelectedCandidate(sh, cand);
    /* 第三方供应商的文件：导入这一下就排进本机镜像（剪辑取帧与导出都读得到字节）。 */
    if (needsLocal(cand.url)) {
      autoLocalize([{
        entry: { kind: 'asset', provider: cand.provider, assetId: it.assetId, genId: it.id, src: cand.url, name: it.name || it.prompt },
        name: it.name || it.prompt || '素材',
        apply: url => { cand.url = url; cand.local = true; scheduleSave(); },
      }]);
    }
  }
  filmEdited();
  setStatus('<span class="ok">✓ 已从资产库导入到当前镜头</span>');
}

/* ---------- 参考视频 / 参考音频：从资产库选（也可本地上传） ----------
   参考图那一排槽位点开就是一个选择弹窗，参考视频/音频以前只能本地上传，现在对齐成一样的体验。 */
async function libEntryToAssetId(it, name, contentType, provId, role) {
  const to = provId || assetStoreId();
  const aid = it.assetId || (String(it.src || '').match(/\/asset\/([A-Za-z0-9_-]+)/) || [])[1];
  const template = Api.inputTemplate(provOf(to), role);
  if (aid && sameAssetSpace(it.provider, to) && !(template && template.requiresAudio)) return aid;
  return await AssetTransfer.toAsset(to, it.dl || it.src, { reg: regOf(), name, contentType, role, onStage: dlStage('素材') });
}
/* `preset`：从别处（建模台回传）已经定好的那一条，有了就不弹选择器、直接走下面的上传 / 登记。 */
async function pickRefMedia(sh, kind, preset) {
  const isAudio = kind === 'refaudio';
  const role = isAudio ? 'reference_audio' : 'reference_video';
  const label = isAudio ? '参考音频' : '参考视频';
  const rm = resolvedModel(sh) || {};
  /* 选择器收哪几类、能选几个、本地上传的 accept 全部现读这个槽位的能力声明；
     体积上限在上传那一步统一校验（AssetTransfer → Capabilities.providerLimit）。 */
  const cap = shotInputCaps(sh);
  const rule = (window.Capabilities && Capabilities.rule)
    ? Capabilities.rule(rm, role, sh.combo) : { max: 1, accept: '' };
  const types = (window.Capabilities && Capabilities.slotTypes) ? Capabilities.slotTypes(rm, role) : (isAudio ? ['音乐', '音频'] : ['视频']);
  const note = cap.slotNote(role);
  const list = preset ? [preset] : await AssetPicker.open({
    types, multiple: false, limit: 1,
    /* 这一镜的参考视频 / 参考音频**各只有一格**（提交体是 body.reference_video = { asset_id }），
       所以规则里的数量按 1 显示 —— 平台声明的 max 再大也没地方放，照抄会出现
       「弹窗写『还能加 1 个』、却又只能点一张」。类型与体积上限仍照平台声明走。 */
    rule: Object.assign({}, rule, { max: 1 }),
    title: '选择' + label + (note ? '（' + note + '）' : ''),
    upload: rule.accept ? { accept: rule.accept } : undefined,
  });
  if (!list || !list.length) return;
  const it = list[0];
  try {
    setStatus('处理' + label + '…');
    const ext = isAudio ? ((it.format || 'wav') === 'wav' ? '.wav' : '.mp3') : '.mp4';
    const name = ((it.prompt || label).replace(/\s+/g, ' ').trim().slice(0, 20) || 'ref') + ext;
    const aid = await libEntryToAssetId(it, name, isAudio ? ((it.format || 'wav') === 'wav' ? 'audio/wav' : 'audio/mpeg') : 'video/mp4', assetProvFor(sh), isAudio ? 'reference_audio' : 'reference_video');
    if (isAudio) sh.refAudio = { asset_id: aid, name, src: it.src };
    else {
      const ref = { asset_id: aid, name, src: it.src, duration: it.duration || null, provider: assetProvFor(sh), preparedFor: assetProvFor(sh) };
      /* 本地上传的文件没有长期地址（blob: 刷新即失效）：顺手在本机取一帧小图存进镜头，
         否则刷新后这个槽位只剩一个文件名。 */
      if (it.file) { try { ref.thumb = await Wb.vframe.dataURLFromFile(it.file, 'first', 320); } catch { /* 抽帧失败就没有缩略图，素材照样挂得上 */ } }
      sh.refVideo = ref;
    }
    renderEditor(); scheduleSave();
    setStatus('<span class="ok">✓ 已设为这一镜的' + label + '</span>');
  } catch (e) {
    setStatus('<span class="err">加入' + label + '失败：' + e.message + '</span>');
  }
}

  return {
    autoLocalize,
    candTrackSrc,
    importMediaFile,
    mediaInfo,
    needsLocal,
    openLibDlg,
    pickRefMedia,
  };
}
