/* 导演台数据消毒域：修复中途写入 / 老版本留下的不完整工作区（项目、项目组、场景、
   镜头、候选、成片模型、画幅与接续字段）。区间内的代码由 engine.js 逐字搬出；
   WS / proj 是 engine 继续持有的可变状态，经访问器读写，document / window 用参数名遮蔽全局。 */

import { normalizeFilm } from '../film.js';

export function createSanitize(E, document, window) {
  'use strict';
  const {
    newShot,
    projOf,
    setProj,
    uid,
    wsOf,
  } = E;

/* ---------- 数据消毒：修复中途写入的不完整工作区 ---------- */
function sanitize() {
  wsOf().projects = (wsOf().projects || []).filter(p => p && typeof p === 'object');
  if (!wsOf().projects.length) {
    wsOf().projects.push({ id: uid(), name: '未命名短片', scenes: [{ id: uid(), name: '场景 1', shots: [newShot()] }] });
  }
  /* 项目组：老工作区没有这一项 → 空表；组 id 重复 / 项目指向不存在的组 → 归未分组。
     归未分组而不是删项目：组没了不该连作品一起没。 */
  if (!Array.isArray(wsOf().groups)) wsOf().groups = [];
  wsOf().groups = wsOf().groups.filter(g => g && g.id && String(g.name || '').trim());
  const gids = new Set(wsOf().groups.map(g => g.id));
  wsOf().projects.forEach(p => { if (p.groupId && !gids.has(p.groupId)) p.groupId = ''; });
  wsOf().projects.forEach(p => {
    p.id = p.id || uid();
    p.name = p.name || '未命名短片';
    /* 成片模型（新剪辑核）：旧工程没有这一项就是一张空片 —— 没有迁移、没有版本号，
       旧键（c.segs / proj.timeline / proj.voices…）任何一个字节都不读。 */
    p.film = normalizeFilm(p.film);
    /* `tlTab` 是「本镜 / 全片」两个页签留下的字段：剪辑态只剩成片那一轨，再没有任何一处读它。
       留着的话下一次编辑的快照里还带着这一枚死值（`sanitize` 之后没人清它），所以在这里抹掉 ——
       与上面 `composition` 坏值「直接删掉」同一族处理。 */
    delete p.tlTab;
    /* 画面比例是**一个项目一份**：只认偶数、64–4096 的宽高（编码器要偶数）；
       坏值直接删掉，回落到「按第一条成片的画幅」的旧行为，而不是让编码器到导出时才报错。 */
    if (p.composition) {
      const w = Math.round(Number(p.composition.width)), h = Math.round(Number(p.composition.height));
      if (w >= 64 && h >= 64 && w <= 4096 && h <= 4096 && !(w % 2) && !(h % 2)) p.composition = { width: w, height: h };
      else delete p.composition;
    }
    p.scenes = Array.isArray(p.scenes) ? p.scenes : [];
    if (!p.scenes.length) p.scenes.push({ id: uid(), name: '场景 1', shots: [newShot()] });
    p.scenes.forEach(sc => {
      sc.id = sc.id || uid(); sc.name = sc.name || '场景';
      /* 场景图只认「记得住的」两种写法：本机 dataURL 与 `/asset/<id>`。
         blob:（刷新即失效）与 /getv?url=<签名外链>（一天就 403）都算坏值，直接抹掉 ——
         留着的话这一格画得出来，第二天变一张破图，而新镜头带进参考图的也是那条永远取不回的字串。 */
      const im = typeof sc.img === 'string' ? sc.img : '';
      sc.img = /^(data:|\/asset\/)/.test(im) ? im : '';
      sc.noPic = !!sc.noPic;
      sc.shots = Array.isArray(sc.shots) ? sc.shots : [];
      if (!sc.shots.length) sc.shots.push(newShot());
      sc.shots.forEach(sh => {
        sh.id = sh.id || uid();
        sh.name = sh.name || '新镜头';
        sh.prompt = sh.prompt || '';
        sh.ar = sh.ar || '16:9'; sh.res = sh.res || '768p'; sh.tier = sh.tier || 'fast'; sh.draw = sh.draw || 1;
        sh.refImages = Array.isArray(sh.refImages) ? sh.refImages : [];
        sh.refMeta = Array.isArray(sh.refMeta) ? sh.refMeta : [];
        while (sh.refMeta.length < sh.refImages.length) sh.refMeta.push({ label: null });
        sh.refMeta.length = sh.refImages.length;   // 素材标签与素材图一一对应
        sh.candidates = Array.isArray(sh.candidates) ? sh.candidates : [];
        /* 提交中途刷新页面：占位候选（tmp_*）拿不到任务号、轮询也明确跳过它，
           以前会永远显示「创建中」（video-gen 有对应自愈，导演台没有）。这里按中断结掉，卡上写明可重试。 */
        sh.candidates.forEach(c => {
          if (!c) return;
          /* 旧工程把「这条投过自动镜像」写在候选上（现在改成内存里的 WeakSet）：
             载入时抹掉，别让它继续随工作区与项目文件漂到别的机器上。 */
          delete c._mirrorAnnounced;
          if (c.status === 'creating' && (!c.vid || String(c.vid).startsWith('tmp_'))) {
            c.status = 'failed';
            c.error = c.error || '页面刷新导致创建中断（未拿到任务号），可重新生成这一镜';
          }
        });
        if (sh.model === 'auto') delete sh.model;   // 「自动」模型已下线，回落到默认模型
        /* 接续两个字段只认这两种值：旧工程没有就现算成空串，不迁移、也不留第三种状态。
           `modelAuto` 只在接续还挂着时才有意义（用户取消接续后那一枚自动选的型号照旧留着，
           只是不再需要标「这是程序挑的」）。 */
        sh.linkPrev = sh.linkPrev === 'tail' ? 'tail' : '';
        sh.modelAuto = sh.linkPrev === 'tail' && sh.modelAuto === 'chain' ? 'chain' : '';
      });
    });
  });
  if (!wsOf().projects.some(p => p.id === wsOf().curId)) wsOf().curId = wsOf().projects[0].id;
  setProj(wsOf().projects.find(p => p.id === wsOf().curId));
  // 索引兜底到合法范围（老存档里可能是 -1 / 越界：以前删空场景会写坏，这里自愈而不是崩）
  projOf().curScene = Math.max(0, Math.min(projOf().curScene || 0, projOf().scenes.length - 1));
  projOf().curShot = Math.max(0, Math.min(projOf().curShot || 0, projOf().scenes[projOf().curScene].shots.length - 1));
  projOf().curCand = 0;
}

  return {
    sanitize,
  };
}
