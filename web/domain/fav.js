/* Fav — 收藏（localStorage 记录 + IndexedDB 文件本体、blob URL LRU、跨页事件）。
   从 web/domain/assetlib.js 拆出；开库与连接复用只走 window.Kv。 */
(function () {
  const KEY = 'fav_items';
  /* 开库、连接复用、失败不缓存（隐私模式 / 别的标签页占用）全在 ui.js 的 Kv 里，
     库/表名也只在那边的登记表里写一次（fav = fav_db/files）。
     本页可能在 ui.js 之前加载，所以取 window.Kv，而且只在函数里取（调用时才解析）。 */
  const favKv = () => window.Kv.at('fav');
  function idbPut(k, v) { return favKv().put(k, v); }
  function idbGet(k) { return favKv().get(k); }
  function idbDel(k) { return favKv().del(k).catch(() => {}); }

  /* blob URL 缓存：**有上限 + 可回收 + 按最近使用淘汰（LRU）**
     （以前只增不减，翻收藏列表会一直吃内存；只按插入顺序淘汰时，
       反复打开的同一个收藏项会因为被「续期」而把其它项挤掉 —— 命中时重新插入即可） */
  const urlCache = new Map();                  // fileKey → blobURL
  const URL_CACHE_MAX = 60;
  function cacheUrl(fileKey, url) {
    if (urlCache.has(fileKey)) urlCache.delete(fileKey);
    while (urlCache.size >= URL_CACHE_MAX) {
      const [k, u] = urlCache.entries().next().value;
      try { URL.revokeObjectURL(u); } catch {}
      urlCache.delete(k);
    }
    urlCache.set(fileKey, url);
  }
  /* 命中即续期（LRU）：返回地址的同时把它挪到队尾 */
  function touchUrl(fileKey) {
    const u = urlCache.get(fileKey);
    if (u === undefined) return '';
    urlCache.delete(fileKey);
    urlCache.set(fileKey, u);
    return u;
  }
  function releaseUrl(fileKey) {
    const u = urlCache.get(fileKey);
    if (u) { try { URL.revokeObjectURL(u); } catch {} urlCache.delete(fileKey); }
  }
  // 页面卸载时统一回收
  window.addEventListener('beforeunload', () => { urlCache.forEach(u => { try { URL.revokeObjectURL(u); } catch {} }); urlCache.clear(); });
  /* 别的标签页改了收藏 → 本页那份缓存作废（失效判据之一；另一处是 write 自己） */
  window.addEventListener('storage', e => { if (e && e.key === KEY) { _fav = null; _favKeys = null; } });
  /* 收藏项变了：只更新本地缓存，不主动重画（页面自己决定怎么刷新，避免打字时被重绘打断） */
  /* 读写都走 ui.js 的 Store：信封里的 ts 让「浏览器 ↔ .data/」能判出谁新（裸数组那份做不到） */
  /* 缓存：`list()` 每次都是 `getItem` + `JSON.parse` **整份**收藏，而 `has(key)` 是
     **每张卡片**调一次（结构是 O(卡片数 × 收藏数 × 单条大小)）。今天实测只有 582 B，
     绝对开销接近 0，但结构会随收藏数长大 —— 这里缓存一份，写盘与 storage 事件（别的标签页
     改过）时失效，`has` 走键集合变 O(1)。
     ⚠ 返回的是**同一份引用**：查过全部调用方（favorites / assets / ai-chat），都是只读；
     本文件里直接改元素的（fillFavPrompt / writeUrlBack / refillPrompts）都是「改了立刻 write 回去」，
     不依赖「每次拿到新对象」。 */
  let _fav = null, _favKeys = null, _favAt = 0;
  /* 3 秒软过期：够覆盖「一次渲染里几百次 has()」（它们全在同一瞬间），
     又不会在「别处直写 fav_items」（云同步把远端那份写回 localStorage 时走的是
     ui.js 里那条 setItem 钩子，不会触发本标签页的 storage 事件）之后长期读到旧值。 */
  const FAV_TTL = 3000;
  const list = () => {
    if (_fav && Date.now() - _favAt < FAV_TTL) return _fav;
    const a = window.Store && Store.read(KEY, []);
    _fav = Array.isArray(a) ? a : [];
    _favAt = Date.now();
    _favKeys = null;
    return _fav;
  };
  const favKeys = () => { if (!_favKeys) _favKeys = new Set(list().map(x => x && x.key)); return _favKeys; };
  function write(arr, opts) {
    const r = window.Store && Store.write(KEY, Array.isArray(arr) ? arr : [], { label: '收藏' });
    const ok = !!(r && r.ok);
    /* 只在**真的写进去了**才把这份当缓存：配额撞满时 Store.write 会失败，那时若把 arr 当最新一份，
       后续 `list()` 会读出一个「其实没存下来」的收藏（页面据此画成已收藏，刷新后又没了）。
       写失败就作废缓存，下一次老实重读盘上那份。 */
    _fav = ok && Array.isArray(arr) ? arr : null;
    _favAt = Date.now();
    _favKeys = null;
    if (opts && opts.silent) return ok;      // 静默写：不广播事件（编辑备注时用，免得页面重画打断输入）
    /* 事件里带上 failed：写不进去时页面重画出来的就是**真实**状态（未收藏），
       不能按「已收藏」渲染然后刷新后消失。 */
    try { window.dispatchEvent(new CustomEvent('fav-change', { detail: { local: true, failed: !ok } })); } catch (e) {}
    return ok;
  }
  const typeOfName = n => (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(n) ? '图片'
    : (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(n) ? '视频'
    : (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(n) ? '音频' : '文件')));

  /* 收藏一条「接口不返回提示词」的资产时，如果这条的提示词还没补上（列表那一轮回源没赶上），
     后台按任务号从本机归档补一次再写回 —— 否则「先收藏、提示词后到」的记录会永远空着，
     收藏页的卡片、搜索和导出 CSV 都跟着缺。只问声明了 noPromptField 的平台，别白跑请求。
     要问的号按 PromptLog.askId 那一份判据取（收藏项常常只有产物号）。 */
  function fillFavPrompt(item) {
    const P = window.PromptLog;
    if (!P || !item || item.prompt || !P.askId) return;
    const id = P.askId(item);
    if (!id) return;
    const prov = window.Api && Api.prov ? Api.prov(item.provider) : null;
    if (!prov || !prov.noPromptField) return;
    P.findByTask(item.provider, id).then(p => {
      if (!p) return;
      const arr = list();
      const hit = arr.find(x => x.key === item.key);
      if (!hit || hit.prompt) return;
      hit.prompt = p;
      write(arr, { silent: true });      // 静默写：不广播 fav-change，免得打断正在输入的备注（下次渲染自然带上）
    }).catch(() => {});
  }

  /* 打开收藏页时把「归档里有、存着的这一条却空着」的提示词补回来并写盘 —— 判据与回源都走
     PromptLog.refill 那一份（资产库/生成工作台的列表那一轮用的是同一个）。
     为什么收藏页要单独补一次：归档是**本机创作历史**，收藏项存的却是当初建卡那一刻的快照；
     那时补晚了（或者那条只留了产物号、判据还没认它）就永远空着，卡片显示「(无描述)」、
     搜索与导出 CSV 也跟着缺，而同一份东西在资产库里是有提示词的。
     查到了才写盘（写一次就够，下次打开直接就有），并且**静默写**：整块重画会把正在敲的备注框换掉。 */
  function refillPrompts(cb) {
    const P = window.PromptLog;
    if (!P || !P.refill) return Promise.resolve(0);
    const items = list();
    return P.refill(items, { limit: 80, onDone: n => {
      if (!n) return;
      const byKey = new Map(items.map(x => [x.key, x]));
      const arr = list();
      let hit = 0;
      arr.forEach(x => {
        const f = byKey.get(x.key);
        if (!x.prompt && f && f.prompt) { x.prompt = f.prompt; x.promptLocal = true; hit++; }
      });
      if (hit) write(arr, { silent: true });
      if (cb) { try { cb(hit); } catch (e) { console.warn('[Fav] 提示词补齐后重画出错：', e); } }
    } });
  }

  /* 签名外链的过期判定与回源都改用模块作用域那一份（mediaExpired / healMedia）：
     收藏、导演台工作区、缩略图抽帧要判的是同一件事，写两份就会有一份漏掉。
     这里只留「换到的新地址怎么落盘」——那是收藏自己的存储。 */
  let pendingUrls = null, urlWriteTimer = 0;
  function writeUrlBack(key, url) {
    pendingUrls = pendingUrls || new Map();
    pendingUrls.set(key, url);
    clearTimeout(urlWriteTimer);
    urlWriteTimer = setTimeout(() => {
      const todo = pendingUrls; pendingUrls = null;
      if (!todo || !todo.size) return;
      const arr = list();
      let hit = 0;
      arr.forEach(x => { const u = todo.get(x.key); if (u) { x.src = u; x.dl = u; hit++; } });
      if (hit) write(arr, { silent: true });      // 静默：换地址不该把正在渲染的列表打断
    }, 600);
  }
  /* 收藏项 → healMedia 认识的记录（任务号优先，没有就退到资产号） */
  const healRec = item => ({ ...item, url: item.src || item.dl || '',
    id: item.genId || item.assetId || '' });

  window.Fav = {
    list,
    refillPrompts,
    has(key) { return favKeys().has(key); },
    assetKey(e) { return 'a:' + (e.provider || '') + ':' + (e.assetId || e.id || ''); },
    /* 把一条资产条目变成收藏项 */
    fromEntry(e) {
      const it = { key: this.assetKey(e), kind: 'asset', provider: e.provider, providerName: e.providerName,
        assetId: e.assetId || e.id, genId: e.genId || '', taskId: e.taskId || '', type: e.type, prompt: e.prompt || '',
        src: mediaSrc(e.src || ''), dl: e.dl || '', rawSrc: e.rawSrc || '',
        format: e.format || '', duration: e.duration || null, ts: Date.now() };
      fillFavPrompt(it);
      return it;
    },
    /* add 返回收藏项（落盘失败返回 null）；remove 返回是否删成功（写不进去 = false） */
    add(item) { return write([item].concat(list().filter(x => x.key !== item.key))) ? item : null; },
    remove(key) {
      const hit = list().find(x => x.key === key);
      if (hit && hit.kind === 'local' && hit.fileKey) { idbDel(hit.fileKey); releaseUrl(hit.fileKey); }
      return write(list().filter(x => x.key !== key));
    },
    /* 返回「这条现在在不在收藏里」。落盘失败时返回**真实状态**：
       以前无条件返回 true/false，页面按「已收藏」渲染，刷新后又消失。 */
    toggle(item) {
      if (this.has(item.key)) { this.remove(item.key); return this.has(item.key); }
      this.add(item);
      return this.has(item.key);
    },
    /* 备注：收藏的用途说明，搜索和文字 AI 都会用 */
    note(key) { const hit = list().find(x => x.key === key); return (hit && hit.note) || ''; },
    /* opts.silent：只落盘不广播 fav-change（页面正在编辑备注时用，避免整列表重画把输入打断） */
    setNote(key, note, opts) {
      const arr = list();
      const hit = arr.find(x => x.key === key);
      if (!hit) return;
      hit.note = String(note || '').trim().slice(0, 300);
      write(arr, opts);
      return hit.note;
    },
    /* 命中备注的搜索（页面搜索框用） */
    search(q) {
      const s2 = String(q || '').trim().toLowerCase();
      if (!s2) return list();
      return list().filter(x => ((x.note || '') + ' ' + (x.prompt || '') + ' ' + (x.name || '') + ' ' + (x.providerName || '') + ' ' + (x.type || '')).toLowerCase().includes(s2));
    },
    /* 给文字 AI 看的清单：名称 / 类型 / 备注（备注是重点，AI 据此判断用途） */
    text(limit) {
      return list().slice(0, limit || 80).map((x, i) => ({
        序号: i + 1, 名称: (x.prompt || x.name || '').slice(0, 80) || '(无名称)', 类型: x.type,
        来源: x.kind === 'local' ? '本地上传' : (x.providerName || '资产库'),
        备注: x.note || '', 收藏ID: x.key,
      }));
    },
    /* 上传本地文件到收藏（本体进 IndexedDB）。失败会让调用方拿到异常，不再静默 */
    async addLocalFile(file) {
      if (!file || !file.size) throw new Error('文件是空的');
      const fileKey = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        await idbPut(fileKey, file);
      } catch (e) {
        throw new Error('存不进浏览器本地库（' + errText(e, '可能是隐私模式或空间不足') + '）');
      }
      return this.add({ key: 'l:' + fileKey, kind: 'local', fileKey, name: file.name || '未命名文件',
        mime: file.type || '', type: typeOfName(file.name || ''), size: file.size || 0, ts: Date.now() });
    },
    async localUrl(fileKey) {
      const hit = touchUrl(fileKey);
      if (hit) return hit;
      const b = await idbGet(fileKey).catch(() => null);
      if (!b) return '';
      const u = URL.createObjectURL(b);
      cacheUrl(fileKey, u);
      return u;
    },
    /* 显示地址：本地文件取 blob，远程用资产地址
       （过期签名由 mediaSrc 换成会话内回源到的新鲜地址，这里不用再判） */
    async urlOf(item) {
      if (!item) return '';
      if (item.kind === 'local') return await this.localUrl(item.fileKey);
      // 老收藏里可能存着外链 src：这里统一换成 /getv 本地路由（显示与取字节都同源）
      return mediaSrc(item.src || item.dl || '');
    },
    /* 这条地址是不是「签名已过期」的外链（只看地址里的 Expires，不发请求）。
       页面首屏一律先给旧地址画出来，过期的那份放后台按任务号回源换新再局部重画 ——
       urlOf 里直接 await 回源的话，收藏一多首屏就被几个平台的慢接口拖住。 */
    expired(u) { return mediaExpired(u); },
    /* 这一条的字节已经落到本机资产库里了 → 把收藏里的地址换成本机那一份。
       落盘走 `writeUrlBack` 那一份 debounce（与过期回源同一条，静默写、绝不打断正在敲的备注），
       页面不要再 list()→改→write() 一遍。`laUrl` 只收 `/asset/…`，别把签名外链当本机地址存回去。 */
    localize(item, laUrl) {
      if (!item || !/^\/asset\//.test(String(laUrl || ''))) return false;
      writeUrlBack(item.key, laUrl);
      return true;
    },
    /* 按任务号换一条新鲜的产物地址；不是签名外链 / 没有任务号 / 平台接口失败 → 空串 */
    async refreshUrl(item, cur) {
      if (!item || item.kind === 'local') return '';
      const s = cur || mediaSrc(item.src || item.dl || '');
      if (!mediaExpired(s)) return '';
      let out = '';
      await healMedia([healRec(item)], { limit: 1,
        onFresh: (rec, next) => { out = next; writeUrlBack(rec.key, next); } });
      return out;
    },
    /* 一批收藏的后台回源：收藏可能有好几百条，全放出去就是同时打几百次平台列表接口
       （一次动辄 6~14 秒），既拖死浏览器也把上游打爆 —— 限量在 healMedia 里，
       并且同一平台整批只问一次（Api.pollMany 认 registry 的 pollVia:'list'）。
       onDone(收藏项, 新地址) 由页面决定怎么局部重画。返回真换到的条数。 */
    async resignSome(recs, onDone, opts) {
      const stale = (recs || []).filter(r => r && r.kind !== 'local'
        && (r.genId || r.assetId) && mediaExpired(r.src || r.dl || ''));
      return healMedia(stale.map(healRec), { limit: (opts && opts.limit) || 12,
        onFresh: (rec, next) => { writeUrlBack(rec.key, next); try { onDone && onDone(rec, next); } catch (e) {} } });
    },
    /* 取回文件本体（交给上传/转存流程用）：先判 HTTP 状态，别把 404 页面当素材 */
    async blobOf(item) {
      if (!item) return null;
      let u = await this.urlOf(item);
      /* 这里是真要拿字节的，跟渲染不一样：地址过期就先回源换新的，
         否则请求过去只会收到 403（签名外链放几天必然如此）。 */
      if (u && this.expired(u)) u = (await this.refreshUrl(item, u)) || u;
      if (!u) return null;
      const b = await window.Net.blob(u, { timeout: 120000 });
      return b;
    },
    /* 收藏里的本地文件 → File 本体。少了它，调用方（studio 的槽位、导演台的画面槽）
       只能按「资产库素材」去转存，转存失败又被 catch 吞掉，槽里留下一个只有会话内
       blob 地址、assetId 为空的条目 —— 看着加进去了，刷新就没了。 */
    async fileOf(item) {
      if (!item || item.kind !== 'local' || !item.fileKey) return null;
      const b = await idbGet(item.fileKey).catch(() => null);
      return (b && typeof b === 'object' && b.size != null) ? b : null;
    },
    /* 收藏项 → 选择器里那种"条目"（localFav 标记让调用方知道要转 dataURL/上传） */
    async asEntry(item) {
      const u = await this.urlOf(item);
      return { kind: 'asset', id: item.key, assetId: item.assetId || '', provider: item.provider || 'fav-local',
        providerName: item.kind === 'local' ? '我的收藏（本地）' : (item.providerName || '我的收藏'),
        type: item.type, prompt: item.prompt || item.name || '', src: u, dl: u,
        format: item.format || ((item.name || '').split('.').pop() || ''), duration: item.duration || null,
        localFav: true, favItem: item, localAsset: item.kind === 'local',
        file: await this.fileOf(item) };
    },
  };
})()
