/* 导演台Ref域：镜头提示词的 AI 润色（反问 / 润色 / 按回答再改，状态在 polishUI）、
   候选 blob 地址的回收与重启后的本机导入恢复、选画面 / 参考图槽位（AssetPicker 与取帧落槽）。
   区间内的代码由 engine.js 逐字搬出；REG / WS 走访问器（engine 继续持有这两枚可变状态），
   其余 E 名单在建包这一刻都已就绪；document / window 用参数名遮蔽全局。 */


export function createRef(E, document, window) {
  'use strict';
  const {
    $,
    regOf,
    wsOf,
    ROLE_ZH,
    SLOT_ROLE,
    addRefImage,
    allShots,
    assetStoreId,
    canAddSlot,
    chainSlotOf,
    comboLabel,
    compressImg,
    curDraftCand,
    curShot,
    renderEditor,
    renderScenes,
    resolveChainFrame,
    resolvedModel,
    scheduleSave,
    setStatus,
    shotCombo,
    shotInputCaps,
    shotRefPlanOf,
    shotUsedRoles,
    wsKv,
  } = E;

/* ---------- 润色指令（文字AI）---------- */
/* 润色要附带的素材：编号、顺序与真正发出去的 content[] 完全同源（见 shotRefPlanOf）。
   图片合成「参考图N」的标签，是为了让文字 AI 在正文里写的 @参考图N 与平台收到的第 N 项对得上；
   参考视频 / 参考音频同样带自己的 @视频N / @音频N（能力判定与字节由 TextAI.prepareMedia 管）。 */
function polishImageList(sh) {
  const plan = shotRefPlanOf(sh, shotInputCaps(sh), { chainPending: chainSlotOf(sh) }, id => Api.assetSrc(id));
  return plan.pictures
    .filter(p => p.src || p.assetId)
    .map(p => ({
      label: '参考图' + p.n + (p.label ? ' · ' + p.label : ''),
      src: p.src || Api.assetSrc(p.assetId),
      token: p.token,
      role: p.role,
    }));
}
function polishMediaList(sh) {
  const plan = shotRefPlanOf(sh, shotInputCaps(sh), { chainPending: chainSlotOf(sh) }, id => Api.assetSrc(id));
  const out = polishImageList(sh).map(x => ({ kind: 'image', ...x }));
  plan.videos.forEach(v => {
    const src = v.src || (v.assetId ? Api.assetSrc(v.assetId) : '');
    if (src) out.push({ kind: 'video', label: v.label, src, token: v.token, role: v.role });
  });
  plan.audios.forEach(a => {
    const src = a.src || (a.assetId ? Api.assetSrc(a.assetId) : '');
    if (src) out.push({ kind: 'audio', label: a.label, src, token: a.token, role: a.role });
  });
  return out;
}
/* 润色结果的就地状态：编辑器会被反复重渲染，面板内容存这里才不会丢
   { shotId, text, note, loading, run, follow, answersText, talk }
   `answersText` = 这一版是按哪些回答润的（「重新润色」要照同一份回答重跑，不能重跑成没回答）；
   `talk` = 结果出来之后用户接着说过的那几句（数组存在这里，整栏重画后还能画回来）。 */
let polishUI = null;
/* 这一处润的是「镜头提示词」：那句话的名字只在这一处点一次名，
   发给模型的正文、反问那句、以及输入框的提示语都从它派生（见 TextAI.polishUser / askUser / followPrompt）。 */
const POLISH_SHOT_WORD = '镜头提示词';
/* 按当前状态在 #polishInline 里画润色面板（renderEditor 每次重渲染后都会调）
   两个阶段都从这里画，状态全在 polishUI 里：切镜头再切回来不能丢内容。 */
function renderPolishPanel(sh) {
  const host = $('polishInline');
  if (!host) return;
  if (!polishUI || !sh || polishUI.shotId !== sh.id) { InlinePolish.clear(host); return; }
  if (polishUI.loading) { InlinePolish.loading(host, polishUI.loadingText || '正在润色这一镜的提示词…'); return; }
  /* 阶段一：AI 反问要点（选项 + 每题最后一个自由输入框）。就地展开，不开新弹窗。 */
  if (polishUI.phase === 'ask' && polishUI.questions && polishUI.questions.length) {
    InlinePolish.ask(host, {
      title: 'AI 想先问几个问题',
      intro: '没答的按默认理解走',
      questions: polishUI.questions,
      state: polishUI.answers || [],
      onChange: st => { if (polishUI) polishUI.answers = st; },
      onSubmit: t => polishRun(t),
      onSkip: () => polishRun(''),
    });
    return;
  }
  const ta = $('edPrompt');
  InlinePolish.show(host, {
    after: polishUI.text, note: polishUI.note, before: ta ? ta.value : '',
    onEdit: v => { polishUI.text = v; },                       // 用户改过的版本也存住，重渲染不丢
    onApply: v => {
      const d4 = curDraftCand();
      if (d4) d4.prompt = v; else sh.prompt = v;
      polishUI = null;
      renderEditor(); renderScenes(); scheduleSave();
      setStatus('<span class="ok">✓ 已替换这一镜的提示词</span>');
    },
    /* ctl 一路传给 polishUI.run：有了它，重跑的那一轮是**边写边灌进上面这个结果框**，
       而不是往宿主里再摆一块流式面板 —— 宿主就是这一块面板，摆下去等于把「替换 / 放弃 /
       按这句再改」那一排连按钮一起销毁（旧代码正是这样，重跑一次按钮就没了）。 */
    onRetry: async ctl => {
      if (!polishUI) return { after: '', note: '' };
      const r = await polishUI.run(polishUI.answersText || '', ctl);
      /* 那一句note 重拼一遍，不能只留 `picked.note`：重跑用的还是同一份回答，
         而 picked.note 只有「有没有带上图」那一句 —— 直接盖掉就把「已按你的回答润色」说丢了。 */
      const note = [polishUI.note0, r.note, polishUI.answersText ? '已按你的回答润色' : ''].filter(Boolean).join(' · ');
      polishUI.text = r.after; polishUI.note = note;
      return { after: r.after, note: note };
    },
    /* 「按这句再改」：结果出来之后接着和 AI 说，改的是屏幕上这一版（用户可能刚手改过）。
       第 4 个参数里的 answers 是先前那几题的回答 —— 这一处问答是页面自己画的（不是
       InlinePolish.interactive），所以由 polishUI.answersText 交回公共层，再随 ctx 递回来。 */
    onFollow: polishUI.follow ? (askText, current, ctl) =>
      polishUI.follow(askText, current, ctl, { answers: polishUI.answersText || '' }) : null,
    talk: polishUI.talk,
    followPlaceholder: '还要怎么改？例：运镜写成具体动作 / 光线改成正午 / 只留一句',
    onReask: polishUI.questions && polishUI.questions.length
      ? () => { polishUI.phase = 'ask'; renderPolishPanel(sh); }   // 回到问答改答案
      : null,
    onClose: () => { polishUI = null; },
  });
}
/* 第二段：按回答润色 → 出结果面板（loading → 结果都走 polishUI，重渲染不丢） */
async function polishRun(answers) {
  const sh = curShot();
  if (!polishUI || !sh || polishUI.shotId !== sh.id) return;
  polishUI.loading = true;
  polishUI.loadingText = answers ? '正在按你的回答润色…' : '正在润色这一镜的提示词…';
  renderPolishPanel(sh);
  const btn = $('polishBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await polishUI.run(answers);
    polishUI.loading = false;
    polishUI.phase = 'result';
    polishUI.answersText = answers || '';
    polishUI.text = r.after; polishUI.note = [polishUI.note0, r.note, answers ? '已按你的回答润色' : ''].filter(Boolean).join(' · ');
  } catch (e) {
    polishUI = null;
    InlinePolish.clear($('polishInline'));
    setStatus('<span class="err">润色失败：' + e.message + '</span>');
  } finally {
    window.aiBtnState(btn, false);
    renderPolishPanel(curShot());
  }
}
async function polishPrompt() {
  const ta = $('edPrompt');
  if (!ta) { setStatus('<span class="err">先在左侧选一个镜头</span>'); return; }
  const sh = curShot();
  const original = (ta.value || '').trim();
  if (!original) { setStatus('<span class="err">先写要润色的提示词</span>'); return; }
  if (!TextAI.prov(regOf())) { setStatus('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
  if (!(await TextAI.canRun(regOf()))) { setStatus('<span class="err">请先在「设置」填文字 AI 密钥</span>'); return; }
  let media = [];
  /* 流式有两个落点，取决于这一轮是谁发起的：
     · 带着 ctl（「重新润色」与「按这句再改」—— 结果面板此刻就在屏幕上）→ 片段灌进 ctl.push，
       边写边显示在结果框里。这时**不能**再往 `#polishInline` 摆流式面板：那块宿主就是结果面板本身。
     · 不带 ctl（第一次点「AI 润色」，宿主里只有一句转圈）→ 用 AiStream 的面板，这一轮动辄十几秒，
       看得见它写到哪里比只挂一句「正在润色…」有用得多。 */
  const call = (sys, user, ctl) => ctl
    ? TextAI.chatStream(regOf(), sys, user, { media, signal: ctl.signal }, ctl.push)
    : AiStream.text(regOf(), sys, user, {
        media: media, host: $('polishInline'), title: 'AI 正在润色这一镜的提示词…',
      });
  /* 素材清单：图片之外还有参考视频 / 参考音频 —— 文字型号支持哪一类就附哪一类
     （能力判定与读字节在 TextAI.prepareMedia，附不上的那一类照实说清数量与用途）。 */
  const materials = () => {
    /* 只有真的随消息发出去的那几条才写 sent：能力没开或某一条读不出来时，
       文字 AI 看不到它，不能让它以为看见了。 */
    const sent = new Set(media.map(x => x.kind + '|' + x.label));
    const items = polishMediaList(sh).map(x => ({
      label: x.label, token: x.token, role: x.role, mk: x.kind, kind: TextAI.MEDIA_ZH[x.kind] || '素材',
      sent: sent.has(x.kind + '|' + x.label),
      hint: x.kind === 'video' ? '这一镜沿用它的运镜和节奏'
        : x.kind === 'audio' ? '这一镜沿用它的节奏' : '',
    }));
    /* 接续镜的首帧提交时才取得到，润色这一轮附不上；把它的编号与来源说给文字 AI，
       它才知道这一镜的第 1 张图是上一镜的落幅、正文该从哪里起笔。 */
    const ic = shotInputCaps(sh);
    if (chainSlotOf(sh)) items.unshift({ label: '接上一镜尾帧', token: '@参考图1', role: 'first_frame', kind: '图片', sent: false, hint: '提交时自动取上一镜结尾当首帧' });
    if (ic.refVideo && sh.refVideo && !items.some(x => x.mk === 'video')) {
      items.push({ label: '参考视频', token: '@视频1', role: 'reference_video', kind: '视频', sent: false, hint: '这一镜沿用它的运镜和节奏' });
    }
    if (ic.refAudio && sh.refAudio && !items.some(x => x.mk === 'audio')) {
      items.push({ label: '参考音频', token: '@音频1', role: 'reference_audio', kind: '音频', sent: false, hint: '这一镜沿用它的节奏' });
    }
    return items;
  };
  /* Skill 正文里的 {duration} / {mode} / {model} / {ar} / {assets}：
     这些是**这一次请求的条件**，由程序按当前镜头填好；Skill 只决定把它们摆在哪一段。 */
  const shotVarsNow = () => {
    const rm = resolvedModel(sh) || {};
    const cb = shotCombo(sh);
    const items = materials();
    const mode = (cb && comboLabel(cb)) || (shotUsedRoles(sh).length ? '参考素材' : '纯文字');
    return {
      duration: sh.duration ? sh.duration + ' 秒' : '按型号声明的默认时长',
      mode: mode,
      model: rm.id ? String(rm.id) + (rm.name && rm.name !== rm.id ? '（' + rm.name + '）' : '') : '未选型号',
      ar: sh.ar || '按型号声明的默认画幅',
      assets: items.length ? TextAI.materialNote(items) : '这一镜没有参考素材',
    };
  };
  /* 变量里的「附上了几张」取决于 prep 的结果（识图开没开、有没有读不出来的），
     所以系统提示词在 prep 之后现拼。 */
  const shotSysNow = () => TextAI.prompt('video', undefined, shotVarsNow());
  const prep = async () => {
    // 「随附素材」编号与 @参考图N / @视频N / @音频N 一致
    const picked = await TextAI.prepareMedia(regOf(), polishMediaList(sh));
    media = picked.media;
    return picked;
  };
  /* 一次润色 = 准备素材（能力支持的那几类才带）→ 组装提示词 → 调用文字 AI；返回 { after, note }。
     answers 是用户对「AI 先前的追问」的回答（没有追问时是空串）。
     素材清单与时长已经由 `shotVarsNow` 填进 Skill 正文的 `{}` 变量；`TextAI.polishExtra` 只补
     随附素材怎么用、@标记要保留、用户的回答 —— 这几句与工作台同一套。 */
  const run = async (answers, ctl) => {
    const picked = await prep();
    if (ctl && ctl.note && picked.note) ctl.note(picked.note);
    else if (picked.note) setStatus('<span class="meta">' + window.esc(picked.note) + '</span>');
    const sys = TextAI.polishSys(shotSysNow(), TextAI.polishExtra({
      media: media, text: original, answers: answers,
    }));
    return { after: await call(sys, TextAI.polishUser(POLISH_SHOT_WORD, original), ctl), note: picked.note };
  };
  /* 结果出来之后接着对话：改的是**屏幕上这一版**（用户可能刚在面板里手改过），
     素材与素材清单照旧重算 —— 换的只是用户那一句要求。
     `text: current` 让「@参考图1 这类标记要原样保留」那一句跟着新版走（第一版里可能没有、改完又有了）。 */
  const follow = async (askText, current, ctl, ctx) => {
    const picked = await prep();
    if (ctl && ctl.note && picked.note) ctl.note(picked.note);
    else if (picked.note) setStatus('<span class="meta">' + window.esc(picked.note) + '</span>');
    const p = TextAI.followPrompt({
      what: POLISH_SHOT_WORD, ask: askText, current: current,
      extra: TextAI.polishExtra({
        media: media, text: current, materials: materials(), answers: (ctx && ctx.answers) || '',
      }),
    });
    return { after: await call(p.sys, p.user, ctl), note: picked.note };
  };
  const btn = $('polishBtn');
  const wantAsk = TextAI.shouldAsk();        // 设置选「从不问」时不发起这一轮
  polishUI = { shotId: sh.id, phase: 'ask', loading: true, loadingText: '正在读这一镜，想想到底要先问什么…',
    run: run, follow: follow, answersText: '', talk: [], note0: '', questions: [], answers: [] };
  window.aiBtnState(btn, true);
  /* 先反问：**由 AI 自己判断**值不值得问（need=false 就直接润色）。这一轮同样带素材图与清单 ——
     看过画面再问，问出来的才是画面相关的问题。 */
  let questions = [];
  if (wantAsk) {
    InlinePolish.loading($('polishInline'), '正在读这一镜，判断还缺什么…');
    let r = { need: false, questions: [] };
    try {
      const picked = await prep();
      const askSys = TextAI.polishSys(shotSysNow(), TextAI.polishExtra({
        media: picked.media, stage: 'ask',
      }));
      r = await TextAI.askPolish(regOf(), askSys,
        TextAI.askUser(POLISH_SHOT_WORD, original, { count: '2–4', tail: '这一镜挂了哪些素材见系统提示' }), { media });
    }
    catch (e) { r = { need: false, questions: [] }; }
    questions = (r && r.need) ? (r.questions || []) : [];
  } else {
    InlinePolish.loading($('polishInline'), '正在润色这一镜的提示词…');
  }
  if (!polishUI || polishUI.shotId !== sh.id) return;        // 期间切了镜头：这次润色作废
  if (questions.length) {
    polishUI.phase = 'ask';
    polishUI.loading = false;
    polishUI.questions = questions;
    polishUI.answers = [];
    window.aiBtnState(btn, false);
    renderPolishPanel(curShot());
    return;
  }
  polishUI.note0 = wantAsk ? '这次没能反问，直接润色' : '';
  await polishRun('');
}

/* 回收候选的 blob: URL（只针对本地导入的视频；/asset、blob: 之外的链接不动） */
function releaseCandUrl(c) {
  if (!c || !c._objUrl || !c.url) return;
  try { URL.revokeObjectURL(c.url); } catch { /* blob 忘了释放也会被浏览器回收，不影响功能 */ }
  c._objUrl = false;
}
/* 删镜头 / 删场景时也要回收它们下面所有候选的 blob 地址
   （以前只有「删候选」和「删项目」回收，删整镜/整场景会让 blob 一直留在内存里） */
function releaseShotUrls(sh) {
  if (!sh) return;
  (sh.candidates || []).forEach(releaseCandUrl);
}
function releaseSceneUrls(sc) {
  if (!sc) return;
  (sc.shots || []).forEach(releaseShotUrls);
}

/* 启动时恢复本地导入的视频：用 IndexedDB 里的 Blob 重建 objectURL */
async function restoreLocalBlobs() {
  const jobs = [];
  (wsOf().projects || []).forEach(p => (p.scenes || []).forEach(sc => (sc.shots || []).forEach(sh => (sh.candidates || []).forEach(c => {
    if (c.provider === 'local' && c.blobKey) {
      jobs.push(wsKv.get(c.blobKey).then(b => { if (b) { c.url = URL.createObjectURL(b); c._objUrl = true; } }).catch(() => {}));
    }
  }))));
  await Promise.allSettled(jobs);
}

/* 素材 → dataURL：支持 dataURL 原样返回、/asset/xx 与相对路径先取回再转 */
async function toDataURL(src) {
  if (!src) return src;
  if (String(src).startsWith('data:')) return src;
  const url = Api.assetDlSrc(src);                          // ?dl=1 的写法只有 Api 那一份
  const b = await Net.blob(url, { timeout: 60000 });      // 统一取字节（带超时 + 先判状态）
  return await AssetTransfer.toDataURL(b);
}
async function uploadImageDataUrl(src, name, provId) {
  // 通用跨平台转存：dataURL / /asset/xx / 外部 https → 目标平台的资产
  return await AssetTransfer.toAsset(provId || assetStoreId(), src, { reg: regOf(), name });
}

/* ---------- 选一张画面 / 参考图（统一走 AssetPicker） ----------
   和三个工作台选参考素材是同一份选择器：资产库 / 我的收藏 / 本地上传三个档位，
   生成入口不在这里（要出图去图片台，出完之后这里现成能选）。 */
function openPickDlg(sh, kind) {
  const isFirst = kind === 'first';
  const isRef = kind === 'ref';
  const prev = isFirst ? prevShotTail(sh) : null;
  const role = isFirst ? 'first_frame' : kind === 'last' ? 'last_frame' : 'reference_image';
  const rm = resolvedModel(sh) || {};
  /* 参考图是**能放好几张**的槽位（sh.refImages 是数组，右栏就写着「已有 N / maxRef 张」），
     选择器必须按「本槽位还剩几个位置」开成多选。以前三个槽位一律 multiple:false, limit:1，
     表现就是「槽位写着还能加 9 张，弹窗却说『还能加 1 个』，选一张以后就选不了第二张」。
     首帧 / 尾帧各只有一格，固定单选；参考图只剩一格时也自动退回单选。 */
  const ic = shotInputCaps(sh);
  const room = isRef ? Math.max(0, ic.maxRef - (sh.refImages || []).length) : 1;
  if (isRef && room <= 0) { setStatus('<span class="err">参考图最多 ' + ic.maxRef + ' 张（首帧/尾帧不计入）</span>'); return; }
  AssetPicker.open({
    types: isFirst ? ['图片', '视频'] : ['图片'],
    multiple: room > 1,
    limit: room,
    /* 这个槽位收什么类型、单文件多大、**这一档收几张**：都现读能力声明（首帧槽也收视频，声明里写了就照它显示）。
       combo 必须递进去 —— 「视频换人」里人物图必须恰好 1 张，递型号总表那份 ≤9 就会画出
       「标题说还能加 1 张、弹窗里写着上限 9」的两张口（limit 与 rule 得同一个口径）。 */
    rule: (window.Capabilities && Capabilities.rule) ? Capabilities.rule(rm, role, sh.combo) : null,
    title: isFirst ? '选一张开头画面' : kind === 'last' ? '选一张结尾画面' : '选参考图（还能加 ' + room + ' 张）',
    note: isFirst ? '图片直接用；选视频则取它的<b>最后一帧</b>当开头画面' : '',
    aiSearch: true,
    extraLabel: prev ? prev.label : '',
    extraAction: prev ? () => usePrevTail(sh, prev) : null,
    onPick: e => applyFrameEntry(sh, kind, e),
  });
}
/* 「接上一镜结尾」：上一镜有静态尾帧 / 关键帧就用它，否则从它已选用的视频里截尾帧 */
function prevShotTail(sh) {
  const all = allShots();
  const i = all.indexOf(sh);
  const prev = i > 0 ? all[i - 1] : null;
  if (!prev) return null;
  const lastKf = prev.lastFrame || ((prev.keyframes || []).filter(k => k.assetId).pop() || {}).assetId;
  if (lastKf) return { prev, lastKf, label: '接上一镜结尾（「' + prev.name + '」）' };
  /* 选用的那条不在 / 没成时退到第一条成功候选：与 `hasTailFrame` 同一判据，
     否则「接上一镜」的入口时有时无，用户只能自己去找视频截帧。 */
  const cand = prev.candidates.find(c => c.vid === prev.selId && c.status === 'succeeded' && c.url)
    || prev.candidates.find(c => c.status === 'succeeded' && c.url);
  if (!cand) return null;
  return { prev, cand, label: '截取上一镜视频尾帧（「' + prev.name + '」）' };
}
async function usePrevTail(sh) {
  try {
    setStatus('正在截取上一镜尾帧…');
    /* 与自动接续走同一个解析（静态尾帧 → 画面切片 → 视频末帧），不在这里再写一份顺序。 */
    const f = await resolveChainFrame(sh);
    sh.firstFrame = f.src;
    renderEditor(); scheduleSave();
    setStatus('<span class="ok">✓ 已把' + f.from + '作为开头画面</span>');
  } catch (e) { setStatus('<span class="err">' + e.message + '</span>'); }
}
/* 选中的条目落到槽位：图片转成 dataURL 存着；开头画面这档选中视频时，在本机取它的最后一帧 */
async function applyFrameEntry(sh, kind, e) {
  try {
    if (e.type === '视频') {
      setStatus('正在从视频取最后一帧…');
      sh.firstFrame = await (e.file ? Wb.vframe.dataURLFromFile(e.file, 'last') : Wb.vframe.dataURL(e.dl || e.src, 'last'));
      setStatus('<span class="ok">✓ 已取该视频的最后一帧作为开头画面</span>');
    } else {
      /* 单文件多大由模型对这个槽位的声明决定（rule.maxBytes），不再写死 5 MiB：
         平台允许 20 MiB 时本地多拦一道就是不让用户用好，平台只收 1 MiB 时写死的 5 MiB 又拦不住。
         没声明就不在本地猜，交给平台判。 */
      const role = SLOT_ROLE[kind] || 'first_frame';
      const rule = (window.Capabilities && Capabilities.rule)
        ? Capabilities.rule(resolvedModel(sh), role) : null;
      const mb = Number((rule && rule.maxBytes) || 0);
      if (e.file && mb > 0 && e.file.size > mb) {
        setStatus('<span class="err">' + (ROLE_ZH[role] || '图片') + '超过平台声明的 ' + window.fmtBytes(mb) + ' 上限</span>');
        return;
      }
      const src = e.file ? await AssetTransfer.toDataURL(await compressImg(e.file)) : await toDataURL(e.src);
      if (kind === 'first') sh.firstFrame = src;
      else if (kind === 'last') sh.lastFrame = src;
      else {
        if (!canAddSlot(sh, 'ref')) { setStatus('<span class="err">已选开头/结尾画面，本镜不能再加参考图（清空后才能换）</span>'); return; }
        const lim = shotInputCaps(sh).maxRef;   // 模型声明几张就是几张，不猜 9
        if (sh.refImages.length >= lim) { setStatus('<span class="err">参考图最多 ' + lim + ' 张（首帧/尾帧不计入）</span>'); return; }
        addRefImage(sh, src, (e.fromLocal || e.localFav) ? '收藏' : null);
      }
      setStatus('<span class="ok">✓ 已加入</span>');
    }
    renderEditor(); scheduleSave();
  } catch (err) { setStatus('<span class="err">取用失败：' + errText(err) + '</span>'); }
}

  /* polishUI 是模块自己的可变状态：engine 那边只在整栏重画时经 setPolishUI 清掉它。 */
  function setPolishUI(v) { polishUI = v; }

  return {
    openPickDlg,
    polishPrompt,
    releaseCandUrl,
    releaseSceneUrls,
    releaseShotUrls,
    renderPolishPanel,
    restoreLocalBlobs,
    setPolishUI,
    toDataURL,
    uploadImageDataUrl,
  };
}
