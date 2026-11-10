/* 导演台Api域：平台调用的小件 —— 图片压缩、上传阶段文案、素材转存落点、资产空间判据、
   余额刷新、这一镜的任务详情面板、缩略图缓存键。区间内的代码由 engine.js 逐字搬出；
   REG / proj 两枚可变状态走 E 的访问器（engine 继续持有），resolvedModel 是 Panel 的解构结果，
   建包时还没初始化，包成箭头避开 TDZ；document / window 用参数名遮蔽全局。 */

export function createApi(E, document, window) {
  'use strict';
  const {
    ST_ZH,
    projOf,
    regOf,
    resolvedModel,
    setStatus,
  } = E;

/* ---------- API ---------- */
/* 上传图片前压缩：最长边 1600、JPEG 0.88，显著降低 IndexedDB 体积 */
function compressImg(file) {
  return new Promise(res => {
    if (file.size < 600 * 1024) return res(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      if (scale >= 1) return res(file);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => res(b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.88);
    };
    img.onerror = () => res(file);
    img.src = URL.createObjectURL(file);
  });
}
/* 上传阶段文案（web/ui/ui.js 的 uploadStageText，导演台没加载 workbench.js 也能用）：
   取回素材 / 申请上传地址 / 上传字节（带真实进度）三态由它统一成一句话 */
const dlStage = label => (stage, info) => {
  const t = uploadStageText(stage, info, label);
  if (t) setStatus(t);
};
/* 素材转存有**两个不同落点**，不要混成一个：
   · assetStoreId()：给「时间线 / 预览 / 长期可取回地址」用。代理的 /asset/<id> 只按注册表顶层
     `assetStore` 声明点名的那一家换签名地址（server/registry-config.js 的 resolveAssetStore），
     所以这一类素材只能传它 —— 换平台时改声明即可，这里不再写死名字。
   · assetProvFor(sh)：这一镜的**参考素材**要传到它真正所属的平台 —— VGENV 只认自家 asset_id
     （registry 里 needsUpload 的 role），以前这里一律传 SparkCine，VGENV 镜头挂参考视频/音频必被上游拒。 */
function assetStoreId() {
  const d = (regOf() && regOf().assetStore) || null;
  return (d && d.provider) || 'sparkcine';   // 与 resolveAssetStore 同一条口径：没声明才退回内置那家
}
/* 两个平台的资产是否互通：同一 relay = 同一套账号下的资产库（SparkCine 的图/视频台共用） */
function sameAssetSpace(provIdA, provIdB) {
  const list = (regOf() && regOf().providers) || [];
  const hit = id => list.find(p => p.id === id || (p.keyId || p.id) === id);
  const a = hit(provIdA), b = hit(provIdB);
  if (!a || !b) return false;
  return (a.relay || a.id) === (b.relay || b.id);
}
/* 这一镜的参考素材该传给谁（没选到模型时退回资产库平台） */
function assetProvFor(sh) {
  const rm = resolvedModel(sh) || {};
  return rm.provider || assetStoreId();
}
/* 余额格式化与卡片都在 web/ui/sidebar.js（侧边栏底部）；这里只负责触发它刷新 */
async function loadCredits() { window.dispatchEvent(new Event('sb-balance-refresh')); }

/* 生成中：空态下方显示这一镜的任务详情（模型 / 参数 / 提交时间 / 已耗时 / 队列位置 / 进度） */
function playerTaskDetails(sh) {
  const list = sh.candidates || [];
  if (!list.length) return '';                                  // 没有候选（占位状态）：不显示任务详情
  const c = list[projOf().curCand] || list[0];                       // 只显示当前查看的这一条
  if (!c || !['creating', 'queued', 'running'].includes(c.status)) return '';
  const rm = resolvedModel(sh) || {};
  const now = Date.now();
  const rows = [c].map((c2, i) => {
    const waited = c2.created ? Math.max(0, Math.round((now - c2.created) / 1000)) : null;
    const bits = [
      ['候选', '第 ' + (projOf().curCand + 1) + ' / ' + list.length + ' 条'],
      ['型号', (rm.name || rm.id || '') + (sh.res ? ' · ' + sh.res : '') + (sh.ar ? ' · ' + sh.ar : '') + (sh.duration ? ' · ' + sh.duration + '秒' : '')],
      ['状态', ST_ZH[c2.status] || c2.status],
      c2.queue_position ? ['队列位置', '第 ' + c2.queue_position + ' 位'] : null,
      c2.status === 'running' && c2.progress ? ['进度', c2.progress + '%'] : null,
      c2.created ? ['提交时间', window.fmtHMS(c2.created)] : null,
      waited != null ? ['已耗时', Wb.fmtSec(waited)] : null,
      c2.priceText ? ['费用', c2.priceText] : null,
    ].filter(Boolean);
    return `<div class="pe-row">${bits.map(([k2, v2]) => `<span class="k">${k2}</span><span class="v">${esc(String(v2))}</span>`).join('')}</div>`;
  }).join('');
  return `<div class="pe-task">${rows}</div>`;
}

/* 本地导入的候选（以及重启后按 blobKey 重建的 blob: 地址）每次地址都不一样 —— 拿它当缩略图缓存键
   等于「首帧白抽一次，下次又重新加载」。这类素材改用**候选号**当稳定键，地址只用于取字节。 */
function thumbKey(c) {
  const s = String((c && c.url) || '');
  if (/^blob:/i.test(s)) return c.vid ? 'local:' + c.vid : s;
  /* 其余地址一律交给公共层归一化（签名参数剥掉才算得出同一个身份）：
     自己拼原始签名地址当键，每轮刷新就换一个键，缓存永远命不中。 */
  return Wb.thumbs.keyOf(s);
}

  return {
    assetProvFor,
    assetStoreId,
    compressImg,
    dlStage,
    loadCredits,
    playerTaskDetails,
    sameAssetSpace,
    thumbKey,
  };
}
