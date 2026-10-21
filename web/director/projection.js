/* 工程 → 时间线：镜头顺序（含用户拖出来的覆盖）与「从已选用候选派生 clips」。
   纯数据投影；播放计划、导出、FCPXML 都读这一份。 */
import { segsOf } from './segments.js';

export function createProjection({ getProj, allShots, shotReady, tlCandidateOf, candDur, segSpd, picVolOf, uid }) {
  /* 全片那一排的镜头先后 = 分镜表的先后 + 用户在轨道上拖出来的那一份**覆盖**（`proj.filmOrder`）。
     只改「拼成片的顺序」，不改分镜表本身：那一串顺序是写脚本的账（AI 分镜、场景归属、左栏列表都读它），
     把它们跟着剪辑一起重排等于替用户改了剧本。没在覆盖清单里的镜头照分镜表补在后面，
     所以「先拖一次、后来又新加两镜」不会出现新镜头凭空插到中间。 */
  function filmShotsOrdered(list) {
    const ord = (getProj() && getProj().filmOrder) || [];
    if (!ord.length) return list;
    const byId = {};
    list.forEach(sh => { byId[sh.id] = sh; });
    const out = ord.map(id => byId[id]).filter(Boolean);
    const seen = {};
    out.forEach(sh => { seen[sh.id] = 1; });
    list.forEach(sh => { if (!seen[sh.id]) out.push(sh); });
    return out;
  }
  const filmOrderNow = () => filmShotsOrdered(allShots().filter(shotReady));

  /* 把某一镜挪到「目标那一镜的前面 / 后面」。返回顺序真的变了没有（没变就不必让整栏重画一遍）。 */
  function moveShotInFilmOrder(shotId, beforeId, after) {
    const now = filmOrderNow().map(x => x.id);
    const list = now.slice();
    const from = list.indexOf(shotId);
    if (from < 0) return false;
    list.splice(from, 1);
    let to = beforeId ? list.indexOf(beforeId) : -1;
    if (to < 0) to = list.length; else if (after) to += 1;
    list.splice(to, 0, shotId);
    const changed = list.join('|') !== now.join('|');
    if (changed) { getProj().filmOrder = list; }
    return changed;
  }

  /* 从已选用镜头派生时间线（会覆盖现有 clips）：
     **一条候选出 N 段**（N = 这一条剪出来的段数），段存 `seg` 下标给配音当锚点。 */
  function tlFromShots() {
    const clips = [];
    filmShotsOrdered(allShots().filter(shotReady)).forEach(sh => {
      const c = tlCandidateOf(sh, sh.selId);
      if (!c) return;
      const total = candDur(c, sh);
      segsOf(c, total).forEach((s, i) => {
        clips.push({ id: uid(), kind: 'shot', shotId: sh.id, candId: c.vid, seg: i,
          name: sh.name || '镜头', in: s.in, out: s.out, speed: segSpd(s), volume: picVolOf(s),
          /* 灰掉的那一段**仍然占这一段的时间**（kind 还是 shot、in/out 没动），只是画面换成黑场：
             于是「删一段」不改总时长，后面每段与每句配音落在原来那一秒上（时间统一）。 */
          gray: s.off ? 1 : 0 });
      });
    });
    return { clips };
  }

  /* 按当前镜头顺序（拖动后的顺序）同步成片时间线：
     段落顺序 = 场景/镜头顺序；入点/出点、倍速、音量、灰块一律**现算**（全部从候选的 `c.segs` 派生）。
     **内容没变就返回上一份对象**：播放跟随每帧都会调它，每次都造新 clips 会让 `timeline.js`
     的 `filmFrames`（按 tl 对象引用缓存）每帧失效，一帧遍历所有镜头重算几何。
     指纹只收会改变 clips 的字段（顺序 / 候选 / 段值与倍速 / 音量 / 行号 / 镜头名）。 */
  let lastSync = { proj: null, sig: '', tl: null };
  function syncSig(list) {
    return list.map(sh => {
      const c = tlCandidateOf(sh, sh.selId);
      if (!c) return sh.id + '~';
      const total = candDur(c, sh);
      return sh.id + '~' + (sh.name || '') + '~' + (c.vid || '') + '~'
        + segsOf(c, total).map(s => [s.in || 0, s.out || 0, s.a || 0, s.b || 0, s.off ? 1 : 0,
          segSpd(s), picVolOf(s), s.ln == null ? 0 : s.ln].join(',')).join(';');
    }).join('|');
  }
  function tlSyncFromShots() {
    const P = getProj();
    const sig = syncSig(filmShotsOrdered(allShots().filter(shotReady)));
    if (lastSync.tl && lastSync.proj === P && lastSync.sig === sig && P.timeline === lastSync.tl) return lastSync.tl;
    const synced = tlFromShots().clips;
    P.timeline = { clips: synced };
    lastSync = { proj: P, sig: sig, tl: P.timeline };
    return P.timeline;
  }

  return { filmShotsOrdered, filmOrderNow, moveShotInFilmOrder, tlFromShots, tlSyncFromShots };
}
