/* 场景 / 镜头 → 素材名的唯一一份算法。
   本机镜像的索引名、另存到用户文件夹的文件名、FCPXML 媒体包里的 `media/<名>` 与 `<asset-clip name>`
   都从这里出 —— 以前三处各拼一份，于是同一个视频在素材库叫「提示词前 24 字.mp4」、
   在媒体包里叫「镜头 3-7.mp4」、而底下的文件又是 `la_xxx.mp4`，对着 missing.txt 根本对不上。
   规则：`场景01-雨夜街头_镜头03-推门_候选2.mp4`；空名只留序号（`场景01_镜头03`），
   场景名与镜头名各自先截 24 字，扩展名由 withExt 拼回**恰好一个**。
   纯函数、不碰 DOM；字符清洗仍归 ui.js 的 `fileSafe`（浏览器里直接用），Node 单测没有它就按原样。 */

const pad2 = n => {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v < 10 ? '0' + v : String(v);
};
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
export function candidateBase(ctx, n) {
  return sceneShotBase(Object.assign({}, ctx || {}, { tag: '候选' + Math.max(1, Math.floor(Number(n) || 1)) }));
}
export function voiceBase(ctx, n) {
  return sceneShotBase(Object.assign({}, ctx || {}, { tag: '配音' + Math.max(1, Math.floor(Number(n) || 1)) }));
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
/* 配音在全片配音表里的序号（1 起）；同一句同时出现多次时取第一条。 */
export function voiceIndex(proj, voice) {
  const list = (proj && proj.voices) || [];
  const i = list.indexOf(voice);
  return i >= 0 ? i + 1 : 1;
}
