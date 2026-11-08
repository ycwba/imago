/* 白膜出图 / 出片 —— 把视口里那一格画面变成一份能拿去当参考的资产。
   两条路都只做「取像素 → 落库 → 交回资产条目」，不自己发请求、不自己拼路径：

   · 静帧：`view.shot(w,h)` → PNG → `Api.saveLocalAsset`（本机资产库，全站唯一入口）
   · 短片：`MediaExport.exportCanvas`（浏览器内 mediabunny 直出 mp4，代理侧不跑转码）
     → `Api.saveLocalAsset`；取帧回调里用 `view.grab(w,h,canvas)` 把三维那一帧画进画布

   落库时带上提示词与型号（`3D白膜`），资产库/参考图里看到的就是「这是哪一句话出来的白膜」。 */

const MIME_BY_EXT = { png: 'image/png', mp4: 'video/mp4', webm: 'video/webm' };

function baseName(doc, aspect) {
  const name = (doc && doc.name) || '白膜';
  const stamp = window.fileStamp ? window.fileStamp() : String(Date.now());
  const safe = window.fileSafe ? window.fileSafe(name, 20) : '白膜';
  return '白膜-' + safe + '-' + String(aspect || '16:9').replace(':', 'x') + '-' + stamp;
}

/* 静帧：返回 { assetId, url, name, bytes } —— 与「本机资产库」里那一条同一个身份 */
export async function shoot(view, o = {}) {
  const shortEdge = Math.max(240, Math.min(1440, Math.round(o.shortEdge || 720)));
  const { w, h } = view.sizeOf(shortEdge);
  const blob = await view.shot(w, h, 'image/png');
  if (!blob || !blob.size) throw new Error('这一帧没取到像素');
  return await saveAsset(blob, {
    name: baseName(o.doc, view.aspect) + '.png',
    format: 'png', mediaType: 'image', prompt: o.prompt || '',
  });
}

/* 短片：duration 秒 / fps 帧率 / 画幅与短边同静帧；返回同上 */
export async function record(view, o = {}) {
  const shortEdge = Math.max(240, Math.min(1440, Math.round(o.shortEdge || 720)));
  const { w, h } = view.sizeOf(shortEdge);
  const ME = await loadExport();
  const fps = Math.max(12, Math.min(30, Math.round(o.fps || 24)));
  const duration = Math.max(0.5, Math.min(30, Number(o.duration) || 3));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const doc = o.doc;
  const wasPlaying = view.playing;
  view.playing = false;
  try {
    const r = await ME.exportCanvas({
      canvas, width: w, height: h, fps, duration,
      draw: t => {
        /* 同步：算这一帧的位姿 → 画进画布。中间不许 await（见 media-export 里那段提醒） */
        view.applyTime(t);
        view.grab(w, h, canvas);
      },
      onProgress: o.onProgress,
      signal: o.signal,
      bitrate: Math.max(2e6, Math.round(w * h * fps * 0.12)),
    });
    const ext = r.ext === 'webm' ? 'webm' : 'mp4';
    return await saveAsset(r.blob, {
      name: baseName(doc, view.aspect) + '.' + ext,
      format: ext, mediaType: 'video', prompt: o.prompt || '', duration,
    });
  } finally {
    view.playing = wasPlaying;
    view.applyTime(view.time);
  }
}

/* 落库：base64 直传（`Api.saveLocalAsset` 是全站唯一入口）。
   meta 里的 prompt / model 会跟着资产一起显示，`detail` 里带上画幅与时长方便日后回查。 */
async function saveAsset(blob, o) {
  const b64 = await blobToB64(blob);
  const saved = await window.Api.saveLocalAsset({
    name: o.name,
    mime: blob.type || MIME_BY_EXT[o.format] || 'application/octet-stream',
    format: o.format,
    data: b64,
    media_type: o.mediaType,
    meta: {
      provider: '本机',
      model: '3D白膜',
      prompt: o.prompt || '',
      duration: o.duration || null,
    },
  });
  const id = saved.assetId || saved.id;
  if (!id) throw new Error('存进资产库了，但没拿到资产号');
  return {
    assetId: id,
    src: saved.url || window.Api.assetSrc(id),
    name: o.name,
    type: o.mediaType === 'video' ? '视频' : '图片',
    bytes: blob.size,
  };
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error('读取产物字节失败'));
    r.readAsDataURL(blob);
  });
}

/* 导出模块是经典脚本、按需取（与导演台/资产搬运同一份加载方式） */
let mePromise = null;
function loadExport() {
  if (window.MediaExport) return Promise.resolve(window.MediaExport);
  if (!mePromise) {
    mePromise = window.__spaLoadScript('web/media-export.js', () => !!window.MediaExport)
      .then(() => {
        if (!window.MediaExport) throw new Error('导出模块没有挂上（web/media-export.js）');
        return window.MediaExport;
      });
  }
  return mePromise;
}
