/* 一镜素材的编号与发送顺序只由这一份决定：界面芯片、提示词里的 @ 标记、真正发出去的
   inputEntries 三处共用同一份顺序。顺序 = 首帧 → 尾帧 → 画面切片 → 手动参考图
   （切片与手动参考图合并受 maxRef 截断）→ 参考视频 → 参考音频。
   画面切片的图同时也会被加进 refImages（生成画面时那一步），这里按地址去重，
   避免同一张图被当成两张参考图发出去。

   为什么编号必须和发送顺序同源：H3 提示词用 <Picture N> / <Video N> / <Audio N>
   指向内容数组里的第 N 项；编号一旦按另一份清单算，正文里说的「第 2 张」与平台收到的
   第 2 项就不是同一张图。 */

export const REF_TOKEN = {
  picture: n => '@参考图' + n,
  video: n => '@视频' + n,
  audio: n => '@音频' + n,
};

const str = v => String(v == null ? '' : v);
const metaLabel = (meta, i) => str(meta && meta[i] && meta[i].label).trim();
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function shotRefPlan(input) {
  const o = input || {};
  const assetSrcOf = typeof o.assetSrcOf === 'function' ? o.assetSrcOf : id => '/asset/' + str(id);
  const maxRef = Math.max(1, Number(o.maxRef) || 1);
  const refOn = o.refOn !== false;
  const pictures = [];
  let n = 0;
  const push = x => {
    n += 1;
    pictures.push(Object.assign({ n, token: REF_TOKEN.picture(n) }, x));
  };

  if (o.firstFrame) push({ kind: 'first_frame', role: 'first_frame', src: str(o.firstFrame), label: '首帧' });
  else if (o.chainPending) push({ kind: 'chain', role: 'first_frame', src: '', label: '接上一镜尾帧', pending: true });
  if (o.lastFrame) push({ kind: 'last_frame', role: 'last_frame', src: str(o.lastFrame), label: '尾帧' });

  let refUsed = 0;
  let refOver = 0;
  let refDup = 0;
  const usedSrc = new Set();
  const kfs = refOn ? (o.keyframes || []).filter(k => k && k.assetId && !k.deleted) : [];
  const refs = refOn ? (o.refs || []).filter(Boolean) : [];
  const meta = Array.isArray(o.refMeta) ? o.refMeta : [];
  for (const k of kfs) {
    if (refUsed >= maxRef) { refOver += 1; continue; }
    const src = str(k.src) || assetSrcOf(k.assetId);
    usedSrc.add(src);
    const t = Number(k.t);
    push({
      kind: 'keyframe', role: 'reference_image', assetId: k.assetId, src,
      label: '画面切片' + (Number.isFinite(t) ? '（第 ' + t + ' 秒）' : ''),
    });
    refUsed += 1;
  }
  refs.forEach((src, i) => {
    const s = str(src);
    if (usedSrc.has(s)) { refDup += 1; return; }
    if (refUsed >= maxRef) { refOver += 1; return; }
    usedSrc.add(s);
    push({ kind: 'ref', role: 'reference_image', src: s, label: metaLabel(meta, i) });
    refUsed += 1;
  });

  const videos = o.refVideo ? [{
    n: 1, token: REF_TOKEN.video(1), role: 'reference_video', label: '参考视频',
    src: str(o.refVideo.src), assetId: str(o.refVideo.asset_id || o.refVideo.assetId),
  }] : [];
  const audios = o.refAudio ? [{
    n: 1, token: REF_TOKEN.audio(1), role: 'reference_audio', label: '参考音频',
    src: str(o.refAudio.src), assetId: str(o.refAudio.asset_id || o.refAudio.assetId),
  }] : [];

  return { pictures, videos, audios, refUsed, refOver, refDup, maxRef };
}

/* 一镜 + 能力声明 → 计划。`assetSrcOf` 由调用方给（浏览器里是 Api.assetSrc），
   纯算法层不持有页面地址规则。 */
export function shotRefPlanOf(sh, ic, o, assetSrcOf) {
  const opt = o || {};
  return shotRefPlan({
    firstFrame: opt.firstFrame !== undefined ? opt.firstFrame : (sh.firstFrame || ''),
    lastFrame: opt.lastFrame !== undefined ? opt.lastFrame : (sh.lastFrame || ''),
    chainPending: !!opt.chainPending,
    keyframes: sh.keyframes,
    refs: sh.refImages,
    refMeta: sh.refMeta,
    refVideo: (ic ? !!ic.refVideo : true) ? sh.refVideo : null,
    refAudio: (ic ? !!ic.refAudio : true) ? sh.refAudio : null,
    maxRef: ic ? ic.maxRef : 1,
    refOn: ic ? !!ic.ref : true,
    assetSrcOf: assetSrcOf || (id => '/asset/' + str(id)),
  });
}

/* 提示词里的 `@名字` / `@首帧` / `@参考视频` 等写法 → 计划里的规范标记。
   名字按长度从长到短替换（一次正则），避免 `@小雅` 抢先改掉 `@小雅·三视图`。 */
export function tokenizeRefPrompt(prompt, plan) {
  const out = str(prompt);
  if (out.indexOf('@') < 0) return out;
  const map = new Map();
  const aliasOf = (name, token) => {
    const k = str(name).trim();
    if (k && !map.has(k)) map.set(k, token);
  };
  for (const p of (plan && plan.pictures) || []) {
    if (p.label) aliasOf(p.label, p.token);
    if (p.n) aliasOf('图片' + p.n, p.token);
    if (p.kind === 'first_frame') aliasOf('首帧', p.token);
    if (p.kind === 'last_frame') aliasOf('尾帧', p.token);
    if (p.kind === 'chain') aliasOf('接上一镜尾帧', p.token);
    if (p.kind === 'first_frame') aliasOf('开头画面', p.token);
    if (p.kind === 'last_frame') aliasOf('结尾画面', p.token);
  }
  for (const v of (plan && plan.videos) || []) {
    aliasOf('参考视频', v.token);
    aliasOf('参考视频' + v.n, v.token);
    aliasOf('视频' + v.n, v.token);
  }
  for (const a of (plan && plan.audios) || []) {
    aliasOf('参考音频', a.token);
    aliasOf('参考音频' + a.n, a.token);
    aliasOf('音频' + a.n, a.token);
  }
  if (!map.size) return out;
  const names = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  /* `@小雅·三视图` 是另一条资产：名字后面紧跟 `·` 时不算命中 `@小雅`。 */
  return out.replace(new RegExp('@(' + names.join('|') + ')(?!·)', 'g'), (m, name) => map.get(name) || m);
}

/* 规范标记 → 平台声明的引用语法。未声明语法的平台原样留着（与以前的行为一致）。 */
export function applyProviderRefSyntax(prompt, syntax) {
  let out = str(prompt);
  if (!syntax) return out;
  const map = typeof syntax === 'string' ? { picture: syntax } : (syntax || {});
  const swapToken = (re, tpl) => {
    if (!tpl) return;
    out = out.replace(re, (_, n) => String(tpl).replace(/\{n\}/g, n));
  };
  swapToken(/@(?:参考图|图片|图)\s*(\d+)/g, map.picture);
  swapToken(/@(?:参考视频|视频)\s*(\d+)/g, map.video);
  swapToken(/@(?:参考音频|音频)\s*(\d+)/g, map.audio);
  return out;
}
