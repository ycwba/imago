/* 导演台白膜回传域：建模台送来的一次性口袋由 `window.Model3D` 写、这里消费一次。
   图走「参考图」那一条（addRefImage），视频走 pickRefMedia 的 preset 形参（同一段上传 / 登记，
   只是不弹选择器）—— 两条都是这一页原有的唯一写入口，不新造第三条。
   区间内的代码由 engine.js 逐字搬出；proj 走访问器，document / window 用参数名遮蔽全局。 */

export function createModelHandoff(E, document, window) {
  'use strict';
  const {
    addRefImage,
    curShot,
    pickRefMedia,
    projOf,
    renderEditor,
    scheduleSave,
    setStatus,
  } = E;

/* ---------- 建模台送回来的白膜 ----------
   一次性口袋由 `window.Model3D` 写、这里消费一次。图走「参考图」那一条（addRefImage），
   视频走 pickRefMedia 的 preset 形参（同一段上传 / 登记，只是不弹选择器）——
   两条都是这一页原有的唯一写入口，不新造第三条。 */
async function consumeModelHandoff() {
  const M = window.Model3D;
  if (!M || !M.consume) return;
  let box = null;
  try { box = M.consume('director'); } catch (e) { return; }
  if (!box || !Array.isArray(box.assets) || !box.assets.length) return;
  const sh = (box.shot && (projOf().shots || []).find(x => x.id === box.shot)) || curShot();
  if (!sh) { setStatus('<span class="err">白膜送到了，但这一部还没有镜头可挂</span>'); return; }
  let images = 0;
  let videos = 0;
  for (const a of box.assets) {
    const label = String(a.name || '白膜').replace(/\.[^.]+$/, '');
    const src = a.url || a.src;
    if (a.type === 'video') {
      await pickRefMedia(sh, 'refvideo', {
        assetId: a.assetId, src, dl: src, name: a.name, prompt: label,
        type: '视频', duration: null,
      });
      videos += 1;
    } else {
      addRefImage(sh, Api.mediaSrc(src), label, a.assetId || null);
      images += 1;
    }
  }
  renderEditor();
  scheduleSave();
  setStatus('<span class="ok">✓ 白膜已加入这一镜：' + images + ' 张参考图' + (videos ? '、' + videos + ' 段参考视频' : '') + '</span>');
}

/* 外壳的 onActivated 从这里接口袋（这一页在页面池里常驻：引擎只启动一次，
   第二次从建模台回来时不能再指望启动那一段里的 setTimeout）。 */
if (typeof window !== 'undefined') window.__directorModelHandoff = consumeModelHandoff;

  return {
    consumeModelHandoff,
  };
}
