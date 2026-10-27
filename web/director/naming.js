/* 场景 / 镜头 → 素材名的唯一一份算法。
   库里的文件名与本机索引名、FCPXML 媒体包里的 `media/<名>` 与 `<asset-clip name>`
   都从这里出 —— 以前三处各拼一份，于是同一个视频在素材库叫「提示词前 24 字.mp4」、
   在媒体包里叫「镜头 3-7.mp4」、而底下的文件又是 `la_xxx.mp4`，对着 missing.txt 根本对不上。
   规则：`场景01-雨夜街头_镜头03-推门_候选2.mp4`；空名只留序号（`场景01_镜头03`），
   场景名与镜头名各自先截 24 字，扩展名由 withExt 拼回**恰好一个**。
   纯函数、不碰 DOM；字符清洗仍归 ui.js 的 `fileSafe`（浏览器里直接用），Node 单测没有它就按原样。 */

/* 补零取公共层那一份（ui.js 的 `window.pad2`）；Node 单测里由测试补同规则桩。 */
const pad2 = n => window.pad2(n);
/* 按字符截断（不用 slice 拆开代理对）：中文名超过 24 字时只影响文件名，不影响工程里的名字。 */
const clipText = (s, max) => Array.from(String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim())
  .slice(0, max || 24).join('');
const safe = (s, max) => {
  const t = String(s == null ? '' : s);
  try {
    if (typeof window !== 'undefined' && typeof window.fileSafe === 'function') return window.fileSafe(t, max || 80);
  } catch (e) { /* 取不到公共清洗就原样返回：它只影响文件名里的非法字符，不影响时间线 */ }
  return t.slice(0, max || 80);
};
const num = v => Math.max(0, Math.floor(Number(v) || 0));

/* 场景与镜头的共同底座：序号补零、名字截断、空名只留序号。
   `tag` 是后缀（`候选2` / `配音1`）：先洗底座再拼，保证截断吃不掉后缀。 */
export function sceneShotBase(parts) {
  const p = parts || {};
  const sn = pad2(num(p.sceneIndex) + 1);
  const tn = pad2(num(p.shotIndex) + 1);
  const sName = clipText(p.sceneName, 24);
  const tName = clipText(p.shotName, 24);
  const scenePart = sName ? '场景' + sn + '-' + sName : '场景' + sn;
  const shotPart = tName ? '镜头' + tn + '-' + tName : '镜头' + tn;
  const core = safe(scenePart + '_' + shotPart, 80);
  const tag = String(p.tag == null ? '' : p.tag).trim();
  return tag ? core + '_' + safe(tag, 16) : core;
}
/* 候选 / 配音的本体名：第二条起带「候选N」后缀（头注与 local.js 的口径都写着
   `…_候选2`），第一条不带 —— 同一镜只出一条时名字保持干净；多条时盘上不再靠
   服务端的 `-2` 各自编号（那与 FCPXML 媒体包 uniqueName 的编号是两套，对不上号）。 */
export function candidateBase(ctx, n) {
  const k = num(n) || 1;
  return sceneShotBase(Object.assign({}, ctx || {}, k > 1 ? { tag: '候选' + k } : null));
}
/* 配音的本体名：与它所属镜头同名（不带「配音N」—— 一句配音对应一镜，序号在那条镜头的名字里已经够了）。 */
export function voiceBase(ctx) {
  return sceneShotBase(ctx || {});
}
/* 时间线里一段画面的显示名（写进 `<asset-clip name>`）：场景与镜头都在，片段序号也在。 */
export function clipLabel(ctx, segNo) {
  const p = ctx || {};
  const sn = pad2(num(p.sceneIndex) + 1);
  const tn = pad2(num(p.shotIndex) + 1);
  const sName = clipText(p.sceneName, 24);
  const tName = clipText(p.shotName, 24);
  const seg = num(segNo);
  return '场景' + sn + (sName ? ' ' + sName : '')
    + ' · 镜头' + tn + (tName ? ' ' + tName : '')
    + (seg ? ' · 片段' + seg : '');
}

/* 只认**最后一个**扩展名：`foo.mp4` → `foo`，`foo` → `foo`。
   以前拼成 `foo.mp4-1.mp4` 就是因为把带扩展名的名字当 base 又接了一次 ext。 */
export function stripExt(name) {
  const s = String(name == null ? '' : name);
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return s;
  return /^[A-Za-z0-9]{1,8}$/.test(s.slice(dot + 1)) ? s.slice(0, dot) : s;
}
export function withExt(base, ext) {
  const e = String(ext == null ? '' : ext).replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const b = stripExt(String(base == null ? '' : base).trim()) || '素材';
  return e ? b + '.' + e : b;
}
/* 在一组已用名里挑一个不撞的：撞了就 `-2`、`-3`…（后缀插在扩展名之前）。
   `used` 传同一个 Set 就能跨多条素材保证唯一；撞满 999 个返回空串，由调用方照实报。 */
export function uniqueName(base, ext, used) {
  const e = String(ext == null ? '' : ext).replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const b = stripExt(String(base == null ? '' : base).trim()) || '素材';
  const set = used || new Set();
  let name = e ? b + '.' + e : b;
  let n = 2;
  while (set.has(name)) {
    if (n > 999) return '';
    name = (e ? b + '-' + n + '.' + e : b + '-' + n);
    n++;
  }
  set.add(name);
  return name;
}

/* 这一镜在全片里的位置（跨场景连续）：场景 / 镜头都从 0 起，名字用工程里的原文。
   找不到时返回 null —— 调用方回落到自己手里的显示名，不凭空编一个序号。 */
export function shotCtxOf(proj, shot) {
  if (!shot) return null;
  const scenes = (proj && proj.scenes) || [];
  for (let si = 0; si < scenes.length; si++) {
    const sc = scenes[si] || {};
    const shots = sc.shots || [];
    for (let ti = 0; ti < shots.length; ti++) {
      const sh = shots[ti];
      if (sh === shot || (sh && shot.id && sh.id === shot.id)) {
        return { sceneIndex: si, shotIndex: ti, sceneName: sc.name || '', shotName: sh.name || '',
          scene: sc, shot: sh };
      }
    }
  }
  return null;
}
/* 候选在这条镜头里的序号（1 起）：界面上的「第 N 条」，也是 `_候选N` 的 N。 */
export function candidateIndex(sh, cand) {
  const list = (sh && sh.candidates) || [];
  const i = list.indexOf(cand);
  return i >= 0 ? i + 1 : 1;
}

/* ── §0.5 统一命名规范：产物本体的盘上文件名 ──────────────────────────────
   段序固定：定位 → 语义 → 时间 → 来源。有就写，没有就省，绝不编。
   例：`场景01-镜头03-（王八在水中缓慢移动）_20261019-104213_sparkcine.mp4`
   各段取自：
     定位 = meta.sceneIndex / meta.shotIndex（只有导演台镜像带得上；手传素材用「手传-」）
     语义 = meta.prompt 前 20 字（为空整段省掉，不出现「（）」）
     时间 = meta.detail.created（平台给的出结果时刻，格式 YYYYMMDD-HHmmss；落盘时刻每重镜像就变，不许用）
     来源 = meta.provider（用 id 不用显示名 —— 显示名会改，id 不会）
   身份与名字分开：id 永远是 la_xxx（/asset/<id> 路由、索引主键、去重都靠它），只有盘上文件名变。
   ⚠ 清洗只许 fileSafe 一份（换 `-`）；saveBaseName 那套「换 _」已废。 */
const assetStamp = d => {
  const dt = (d instanceof Date) ? d : new Date(Number(d) || Date.now());
  if (isNaN(dt.getTime())) return '';
  const padNum = n => String(n).padStart(2, '0');
  return dt.getFullYear() + padNum(dt.getMonth() + 1) + padNum(dt.getDate())
    + '-' + padNum(dt.getHours()) + padNum(dt.getMinutes()) + padNum(dt.getSeconds());
};
export function assetBase(meta) {
  const m = meta || {};
  const parts = [];
  /* 定位段：场景 / 镜头序号（只有导演台镜像带上）；都没有时看手传标志 */
  const sn = m.sceneIndex != null ? pad2(num(m.sceneIndex) + 1) : '';
  const tn = m.shotIndex != null ? pad2(num(m.shotIndex) + 1) : '';
  if (sn && tn) parts.push('场景' + sn + '-镜头' + tn);
  else if (sn) parts.push('场景' + sn);
  else if (tn) parts.push('镜头' + tn);
  else if (m.importedFrom || m.provider === '本机' || m.provider === 'local') parts.push('手传');
  /* 语义段：提示词前 20 字，为空整段省掉 */
  const sem = clipText(m.prompt, 20);
  if (sem) parts.push('（' + sem + '）');
  /* 时间段：平台给的出结果时刻（没有就不写，不用落盘时刻 —— 落盘时刻每重镜像就变） */
  const created = m.detail && m.detail.created ? m.detail.created : m.createdAt;
  const ts = created ? assetStamp(created) : '';
  /* 来源段：平台 id（不是显示名） */
  const src = String(m.provider || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  const segs = [];
  if (parts.length) segs.push(parts.join('-'));
  if (ts) segs.push(ts);
  if (src && src !== 'local' && src !== '本机') segs.push(src);
  return safe(segs.join('_') || '素材', 120);
}
