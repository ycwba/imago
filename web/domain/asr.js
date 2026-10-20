/* Asr — 语音识别（设置 / 提交 / 轮询 / 取消）。只走 Net，不裸 fetch。
   shell 不常驻加载；设置页与导演台首次使用时 __spaLoadScript('web/domain/asr.js', () => window.Asr)。 */
(function () {
  let cached = null;
  let localState = null;

  function errOf(e, fallback) {
    return new Error(errText(e, fallback || '语音识别请求失败'));
  }
  async function settings() {
    try {
      const d = await window.Net.json('/asr/settings', { retry: 0 });
      cached = d.settings || null;
      localState = d.local || null;
      return { settings: cached, local: localState, revision: d.revision };
    } catch (e) { throw errOf(e, '读不到语音识别设置'); }
  }
  async function save(patch) {
    try {
      const d = await window.Net.json('/asr/settings', {
        method: 'PUT', retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      });
      cached = d.settings || null;
      localState = d.local || null;
      return { settings: cached, local: localState, revision: d.revision };
    } catch (e) { throw errOf(e, '保存语音识别设置失败'); }
  }
  async function transcribe(arg) {
    try {
      return await window.Net.json('/asr/transcribe', {
        method: 'POST', retry: 0,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arg || {}),
      });
    } catch (e) { throw errOf(e, '提交转写失败'); }
  }
  async function job(id) {
    try { return await window.Net.json('/asr/jobs/' + encodeURIComponent(id), { retry: 0 }); }
    catch (e) { throw errOf(e, '读不到转写任务'); }
  }
  async function cancel(id) {
    try {
      return await window.Net.json('/asr/jobs/' + encodeURIComponent(id), { method: 'DELETE', retry: 0 });
    } catch (e) { throw errOf(e, '取消转写失败'); }
  }
  /* 轮询到 done / error / canceled / interrupted 为止；onTick 拿到每一次的任务对象。
     opts.signal 用来在页面切走 / 用户放弃时停掉轮询（任务本身仍由 cancel 负责杀进程）。 */
  async function wait(id, onTick, opts) {
    const o = opts || {};
    const every = Math.max(600, Math.min(5000, Number(o.every) || 1200));
    const deadline = Date.now() + (Number(o.timeoutMs) || 2 * 60 * 60 * 1000);
    for (;;) {
      if (o.signal && o.signal.aborted) throw new Error('已停止等待');
      const j = await job(id);
      if (typeof onTick === 'function') { try { onTick(j); } catch (e) {} }
      if (['done', 'error', 'canceled', 'interrupted'].includes(j.state)) return j;
      if (Date.now() > deadline) throw new Error('等了太久还没转写完（任务可能还在跑，可以稍后回来查看）');
      await new Promise(r => setTimeout(r, every));
    }
  }
  window.Asr = {
    settings, save, transcribe, job, cancel, wait,
    /* 同步读上一次 settings() 的缓存：本地运行包可不可用不该让界面再等一次网络 */
    cache: () => cached,
    local: () => localState,
    available: () => !!(localState && localState.available),
    srtOf: j => String((j && j.srt) || ''),
  };
})();
