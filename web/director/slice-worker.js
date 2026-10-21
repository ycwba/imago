/* 切片帧的 JPEG 编码（P4）：主线程把 seek 后的 ImageBitmap 传进来，
   缩放 + convertToBlob 都在这里做，主线程只等一个 Blob。
   ⚠ 仅做编码：解码仍由主线程的 <video> 完成（worker 里没有 HTMLVideoElement），
   所以这里不碰播放器、也不做 seek —— 传进来的就是已经定位好的那一帧。
   为什么是 ImageBitmap 而不是 VideoFrame：游离且暂停的 <video> 在 GPU 被关掉的环境里
   `new VideoFrame(video)` 是一张黑帧，`createImageBitmap(video)` 才是真实画面（见 engine 同名注释）。 */
self.onmessage = async e => {
  const d = e.data || {};
  let frame = d.frame;
  try {
    const w = Math.max(1, d.w | 0), h = Math.max(1, d.h | 0);
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(frame, 0, 0, w, h);
    if (frame && frame.close) frame.close();
    frame = null;
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    self.postMessage({ id: d.id, blob });
  } catch (err) {
    try { if (frame && frame.close) frame.close(); } catch (e2) { /* 帧已关：这条消息的错误照样回给主线程 */ }
    self.postMessage({ id: d.id, error: String((err && err.message) || err) });
  }
};
