/* Kv — IndexedDB 的唯一开库 / 事务实现与登记表。
   从 web/ui/ui.js 拆出；加载顺序在 ui.js 之后、页面脚本之前。 */
(function () {
const conns = new Map();                     // 库名 -> Promise<IDBDatabase>（一个库只有一个连接，同页多处共用）

  /* ver == null：库不存在时浏览器建 v1 并触发 onupgradeneeded（这里顺手把仓库建上） */
  function connect(name, store, ver) {
    return new Promise((res, rej) => {
      let r;
      try { r = ver == null ? indexedDB.open(name) : indexedDB.open(name, ver); }
      catch (e) { rej(e); return; }
      r.onupgradeneeded = () => { if (store && !r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error(name + ' 被其它标签页占用，关掉其它页面后刷新即可'));
      r.onsuccess = () => res(r.result);
    });
  }

  /* 打开并确认仓库在。不在就用 version+1 重开一次补建；补建后还是没有则如实抛错
     （绝不写死版本号：写死 1 会在补建之后（v2）永远打不开） */
  async function ensure(name, store) {
    let db = await connect(name, store, null);
    if (!store || db.objectStoreNames.contains(store)) return db;
    const next = db.version + 1;
    try { db.close(); } catch {}
    db = await connect(name, store, next);
    if (db.objectStoreNames.contains(store)) return db;
    try { db.close(); } catch {}
    throw new Error(name + ' 缺少 ' + store + ' 仓库，且无法补建：请关闭其它标签页后刷新');
  }

  function open(name, store) {
    const c = conns.get(name);
    if (c) return c;
    const p = ensure(name, store);
    conns.set(name, p);
    p.then(db => {
      const release = () => { if (conns.get(name) === p) conns.delete(name); };
      db.onversionchange = () => { release(); try { db.close(); } catch {} };   // 别的标签页要升级：让路
      db.onclose = release;
    }, () => { if (conns.get(name) === p) conns.delete(name); });               // 失败不缓存，下次重试（隐私模式 / 占用）
    return p;
  }

  /* fn 里同步发出的请求都算同一个事务；返回该事务最后一个请求的 result */
  function tx(name, store, mode, fn) {
    return open(name, store).then(db => new Promise((res, rej) => {
      let t, req;
      try {
        t = db.transaction(store, mode);
        req = fn(t.objectStore(store));
      } catch (e) { rej(e); return; }
      t.oncomplete = () => res(req && req.result);
      t.onerror = t.onabort = () => rej(t.error || new Error(name + ' 事务中断'));
    }));
  }

  const get = (name, store, key) => tx(name, store, 'readonly', st => st.get(key));
  const put = (name, store, key, val) => tx(name, store, 'readwrite', st => st.put(val, key));
  const del = (name, store, key) => tx(name, store, 'readwrite', st => st.delete(key));
  const all = (name, store) => tx(name, store, 'readonly', st => st.getAll());
  const clearAll = (name, store) => tx(name, store, 'readwrite', st => st.clear());
  /* 整表键值对：keys 与 values 在同一次只读事务里取，配对不会错行 */
  const entries = (name, store) => open(name, store).then(db => new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly');
    const kq = t.objectStore(store).getAllKeys();
    const vq = t.objectStore(store).getAll();
    let err = null;
    t.onerror = t.onabort = () => { err = t.error || new Error(name + ' 事务中断'); };
    t.oncomplete = () => {
      if (err) return rej(err);
      const keys = kq.result || [], vals = vq.result || [];
      res(keys.map((k, i) => [k, vals[i]]));
    };
  }));

  /* 本项目用到的库/表在这里**点名一次**：页面与模块都写 Kv.at('ws'|'fav'|…).get(k)，
     不要再各处抄 'fav_db' / 'files' 这两个字符串（抄错一个字母就是打到别的库上）。
     backup:true 的几项同时是「导出整包备份」的清单（DataSync.IDB_TARGETS 由它现算）。 */
  const TARGETS = {
    ws: { db: 'director_db', store: 'kv', label: '导演台工作区与本地视频', backup: true },
    fav: { db: 'fav_db', store: 'files', label: '收藏的本地文件', backup: true },
    blobs: { db: 'wb_blobs', store: 'blobs', label: '音色复刻的参考音频', backup: true },
    thumbs: { db: 'wb_thumbs', store: 'thumbs', label: '缩略图缓存（丢了能重建）', backup: false },
    /* 本机镜像指针（哪条产物存在 .assets）。20k 条放进 localStorage 会顶到 5MB 配额，
       把设置/素材库一起挤掉；本体放 IndexedDB，localStorage 只留最近 2000 条的暖启动缓存。
       它不是用户作品，丢了能从代理的 /local-assets 重建，所以不进整包备份。 */
    mirror: { db: 'mirror_db', store: 'kv', label: '本机镜像指针（能从资产库重建）', backup: false },
    /* 助手长结果：turn 里只留 resultId/size/preview，正文按 offset 分页读；随会话备份，
       否则整包备份恢复后 turn 里的 resultId 会悬空。清理在写入新结果时按会话/时间做。 */
    chatResults: { db: 'chat_db', store: 'results', label: '助手长结果（随会话）', backup: true },
    /* 画布工程：整份文档按项目 id 存；项目索引仍走 Store（canvas_index）。 */
    canvasDocs: { db: 'canvas_db', store: 'docs', label: '画布工程', backup: true },
    /* 导演台切片帧（导演台/slice-cache.js）：丢了能重建，不进整包备份。 */
    slices: { db: 'wb_slices', store: 'slices', label: '导演台切片缓存（丢了能重建）', backup: false },
  };
  const bound = new Map();
  function at(name) {
    if (bound.has(name)) return bound.get(name);
    const t = TARGETS[name];
    if (!t) throw new Error('IndexedDB 目标没登记过：' + name);
    const o = {
      db: t.db, store: t.store,
      get: k => get(t.db, t.store, k),
      put: (k, v) => put(t.db, t.store, k, v),
      del: k => del(t.db, t.store, k),
      all: () => all(t.db, t.store),
      entries: () => entries(t.db, t.store),
      tx: (mode, fn) => tx(t.db, t.store, mode, fn),
    };
    bound.set(name, o);
    return o;
  }

  window.Kv = { open, tx, get, put, del, all, clear: clearAll, entries, TARGETS, at };
})();
