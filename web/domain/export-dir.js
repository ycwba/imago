/* ExportDir — 浏览器导出目录：File System Access API 的句柄管理。
   句柄留在浏览器侧（Kv.at('dirs')，键 `export`），产物由浏览器直接写进那个目录；
   没有句柄时退回普通下载（Wb.save）。**不存路径字符串**（浏览器拿不到，存了就是第二份真相）。
   能力退路：File System Access 只在 Chromium 系可用 → 不支持时不报错，走普通下载，
   设置页写清「这个浏览器不支持选目录，产物会进系统下载文件夹」。
   ⚠ showDirectoryPicker() 必须由用户手势直接触发（塞进异步回调里会抛）→ 调用点包在真实 click 里。
   ⚠ 这是**导出目录**（浏览器写）；设置页「本机资产库」那一格是**服务端路径**（代理写，/pick-dir）——
   两个是不同的东西，不许混。 */
(function () {
  const KEY = 'export';

  function supported() {
    try { return typeof window.showDirectoryPicker === 'function'; } catch (e) { return false; }
  }

  /* 用户手势里调；取消 → { ok:false, cancelled:true } */
  async function pick() {
    if (!supported()) return { ok: false, why: '这个浏览器不支持选目录（File System Access 只在 Chromium 系可用）' };
    let h;
    try {
      h = await window.showDirectoryPicker({ id: 'spk-export', mode: 'readwrite' });
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return { ok: false, cancelled: true };
      return { ok: false, why: '选目录没成：' + window.errText(e) };
    }
    try {
      const perm = await h.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return { ok: false, why: '目录授权没通过，换一个目录再试' };
    } catch (e) { /* requestPermission 不存在时当授权已给（老实现） */ }
    try { await window.Kv.at('dirs').put(KEY, h); } catch (e) { return { ok: false, why: '目录选好了但存不住：' + window.errText(e) }; }
    return { ok: true, name: h.name };
  }

  async function get() {
    try {
      const h = await window.Kv.at('dirs').get(KEY);
      return h && typeof h === 'object' ? h : null;
    } catch (e) { return null; }
  }

  async function forget() {
    try { await window.Kv.at('dirs').del(KEY); } catch (e) { /* 清不掉就留着，下次 pick 会覆盖 */ }
    return { ok: true };
  }

  /* 有句柄 → createWritable() 写入；没有 → { ok:false, why:'no-handle' }。
     权限被收回（站点数据被清 / 用户撤销）→ 明写原因，给「重新选一次」的出口。 */
  async function write(name, blob) {
    const h = await get();
    if (!h) return { ok: false, why: 'no-handle' };
    try {
      const perm = await h.queryPermission ? await h.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (perm !== 'granted') {
        const re = await h.requestPermission({ mode: 'readwrite' });
        if (re !== 'granted') return { ok: false, why: '授权被收回，请重新选一次目录' };
      }
      const fh = await h.getFileHandle(String(name || 'untitled'), { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return { ok: true, name: h.name };
    } catch (e) {
      return { ok: false, why: '写入失败：' + window.errText(e) };
    }
  }

  /* 只给界面显示的目录名，不落盘路径 */
  async function name() {
    const h = await get();
    return h ? h.name : '';
  }

  window.ExportDir = { supported, pick, get, forget, write, name };
})();
