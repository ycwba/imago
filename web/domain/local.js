/* AssetLocal — 本机镜像：落盘身份、待存队列、自动存本机、状态判据（stateOf / hasLocal / hideAsCloud）。
   从 web/domain/assetlib.js 拆出；mediaKey / mediaSrc / classifyStatus 是 api.js 顶层的全局函数。 */
(function () {
  const K_SAVE = 'sk_media_local', K_PREFER = 'sk_media_prefer', K_IDX = 'sk_local_mirror';
  const K_BADGE = 'sk_media_badge';   // 卡片上是否显示「本机 / 云端」标识（默认开）
  const K_HIDE_CLOUD = 'sk_media_cloud_hide';
  /* 「补不补历史产物」—— 自动存本机分两档：
       'all'（默认，与原来的行为一致）：扫到什么存什么，所以开启之后**历史产物也会被补齐**；
       'new'：只存开启之后新生成的那些。
     为什么要分：'all' 在攒了三百条产物之后第一次打开这一档，会**当场开始下载几百个文件**
     （带宽、磁盘、时间都不小，而用户可能只是想「以后生成的就顺手存下来」）。
     但反过来，把默认设成 'new' 又是**静默的损失** —— 已经生成的那些永远存不下来。
     所以默认给 'all'（行为与从前一致，不制造意外），把 'new' 作为明确的选择摆出来。
     判据只有 `wantSave(e)` 一处：scan 每一批都问它一次。 */
  const K_SAVE_SCOPE = 'sk_media_local_scope';
  /* 开启的时刻：'new' 那一档靠它判断「这条是不是开启之后生成的」。
     第一次用（这个键不存在）时**当作一直是开的** —— 否则 'new' 在第一次用时等于什么都不存，
     而用户看到的是「我明明开了，一份也没存」。 */
  const K_SAVE_SINCE = 'sk_media_local_since';
  function saveSince() { return Number(on(K_SAVE_SINCE, '0')) || 0; }
  /* 记下「本次开启的时刻」。由设置页在**从关到开**的那一刻调一次（不是每次保存都调，
     否则用户中途关一次再开，历史补齐的边界就跟着往后挪，看起来像「存不下来」）。 */
  function markSaveOn(at) {
    const t = Number(at) || Date.now();
    try { localStorage.setItem(K_SAVE_SINCE, String(t)); } catch (e) {}
    return t;
  }
  /* 「这一条该不该存」—— scan / 手动补存 / 页面那条按钮都读它。
     `mode` 缺省读设置；传字符串是为了测试与「按类型另存」那一档复用。 */
  function saveScope() { return on(K_SAVE_SCOPE, 'all') === 'new' ? 'new' : 'all'; }
  function wantSave(e, mode) {
    if (!e || e.kind !== 'asset' || e.localAsset) return false;
    if ((mode || saveScope()) !== 'new') return true;
    const since = saveSince();
    if (!since) return true;                                   // 从来没记过开启时刻 → 当作一直是开的
    /* 用 `completed` / `created`（平台给的实际出结果时刻）比，没有就用 `ts`（本机记的创建时刻）。
       没有任何一个时刻的条目**一律放行**：判成「旧的」而不存，用户看到的就是凭空少了一份，
       而「多存一份」的代价只是磁盘。 */
    const t = Number(e.completed || e.created || e.ts || 0);
    return !t || t >= since;
  }
  /* 侧栏那两块各自能不能显示（设置页勾）。默认都开着 —— 与从前一致。 */
  const K_SB_BAL = 'sb_bal_on', K_SB_MIRROR = 'sb_mirror_on';
  const sbBalOn = () => on(K_SB_BAL, '1') !== '0';
  const sbMirrorOn = () => on(K_SB_MIRROR, '1') !== '0';
  const IDX_MAX = 20000;                 // 与代理的 LOCAL_INDEX_MAX 对齐：两边都截一半就会出现「存过却取不回」
  /* 单个文件的大小闸。**不是随便定的一个数**：本机镜像走的是 base64 上传
     （`POST /local-assets`），代理那侧的请求体上限是 288 MiB，而 base64 会把字节放大 4/3 ——
     288 × 3/4 = 216 MiB 才是这条链真正传得动的最大值。
     以前这里写 200 MiB，于是「200–216 MiB 这一档本来能存」也被挡在门外，且理由是编的。
     再往上不是改一个数字的事：base64 链路本身有 5× 内存放大（raw / utf8 串 / data / 解码结果），
     真要传 GB 级的文件得把这条链改成代理自己去取字节（流式），风险与改动面都大得多。 */
  const MIRROR_MAX = 216 * 1024 * 1024;
  const CONCURRENCY = 2;                 // 同时最多镜像几个：一次性下十几个视频会把上行和磁盘都占满
  const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac' };

  const on = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } };
  const saveOn = () => on(K_SAVE, 'on') !== 'off';
  const preferLocal = () => on(K_PREFER, 'on') !== 'off';
  const showBadge = () => on(K_BADGE, 'on') !== 'off';
  /* 「只看本机有的」真生效的条件是三条都开着：没存本机就永远没有本机副本，
     不优先读本机就谈不上「只看本机」—— 只勾第三档时它**等于没勾**（设置页那一项也就不画）。 */
  const localOnly = () => saveOn() && preferLocal() && on(K_HIDE_CLOUD, '') === '1';

  /* ---------- 按类型分别决定「存不存 / 存到哪个文件夹」（设置页「自动保存」那一卡）----------
     键 `sk_autosave`（前缀 sk_ 已跟着设置导出/云同步走），形状：
       { image:{on:'on'|'off', dir:'D:\\AI图'}, video:{…}, audio:{…} }
     **三档的默认值全是 on** —— 与以前那个总开关一致（原来就是全存），
     所以第一次打开这一项，行为一个字都没变，只是多了「按类型分开」和「另存到指定目录」两件事。
     判据只有这一份：设置页渲染、这里分流、代理读盘，三边各写一份就一定对不上。 */
  const K_AUTOSAVE = 'sk_autosave';
  /* 「这一类上一次另存**没成**的原因」：只在写失败时记一笔，写成功就把这一档清掉。
     （成功不再记整条路径 —— 设置页那一格「上次存成：D:\…」早就没人看了，
     而失败必须留着，否则「用户以为存上了、其实一次都没落盘」又会回来。）
     不进同步白名单 —— 那是「刚才发生了什么」，不是「我想要什么」，跟着云同步会把
     另一台机器上的旧路径带过来，而那台机器上那个盘符多半不存在。 */
  const K_AUTOSAVE_LOG = 'sk_autosave_log';
  function noteSaveFail(kind, why) {
    try {
      const d = JSON.parse(localStorage.getItem(K_AUTOSAVE_LOG) || '{}') || {};
      if (why) d[kind] = { why: String(why), at: Date.now() }; else delete d[kind];
      localStorage.setItem(K_AUTOSAVE_LOG, JSON.stringify(d));
    } catch (e) {}
  }
  function saveFails() { try { return JSON.parse(localStorage.getItem(K_AUTOSAVE_LOG) || '{}') || {}; } catch (e) { return {}; } }
  const SAVE_KINDS = [
    { id: 'image', zh: '图片', exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
    { id: 'video', zh: '视频', exts: ['mp4', 'webm', 'mov', 'mkv'] },
    { id: 'audio', zh: '音频', exts: ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus'] },
  ];
  function autosaveConf() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(K_AUTOSAVE) || 'null'); } catch (e) {}
    const c = (d && typeof d === 'object') ? d : {};
    const out = {};
    for (const k of SAVE_KINDS) {
      const row = (c[k.id] && typeof c[k.id] === 'object') ? c[k.id] : {};
      out[k.id] = { on: row.on !== 'off', dir: String(row.dir || '').trim() };
    }
    return out;
  }
  function setAutosaveConf(c) { try { localStorage.setItem(K_AUTOSAVE, JSON.stringify(c || {})); } catch (e) {} }
  /* 这一份产物属于哪一类：先看扩展名（落盘名就是 <id>.<格式>，最可靠），再按 mime。 */
  const kindOf = (ext, mime) => {
    const e = String(ext || '').toLowerCase();
    const hit = SAVE_KINDS.find(k => k.exts.indexOf(e) >= 0);
    if (hit) return hit.id;
    const m = String(mime || '').toLowerCase();
    if (m.indexOf('image/') === 0) return 'image';
    if (m.indexOf('video/') === 0) return 'video';
    if (m.indexOf('audio/') === 0) return 'audio';
    return '';
  };

  let idx = null;
  let idxMaps = null;   // 镜像索引的反查表（{ up, la, aid, gid }）；write() 时作废
  /* 记录对象 → 它在索引里的键（内存里那张 WeakMap，不落盘）。
     `maps()` 与 `learn()` 都会顺手打标：反查表里只存记录对象，而 decorate /
     forgetMirror 需要知道「这条记录是哪一个键」，否则同一个本机号挂在两个键上时改错一个。 */
  const recKeys = new WeakMap();
  function tagRec(rec, k) { if (rec && k) { try { recKeys.set(rec, k); } catch (e) {} } return rec; }
  /* 反查表的**增量**补写（learn 每认回一行都要用）：整表作废会让一屏几百行变成 O(n²)。
     产物号 / 任务号优先读记录上的 `p` / `g`，老记录从键上认（与 maps 同一条正则）。 */
  function noteRecMaps(rec, k) {
    if (!idxMaps || !rec || !k) return tagRec(rec, k);
    tagRec(rec, k);
    if (rec.a) idxMaps.la[rec.a] = k;
    const u = rec.up ? mediaKey(String(rec.up)) : '';
    if (u) idxMaps.up[u] = rec;
    const am = /\|a:(.+)$/.exec(k);
    const aidv = String(rec.p || (am && am[1]) || '');
    if (aidv) idxMaps.aid[aidv] = rec;
    const gm = /\|g:(.+)$/.exec(k);
    const gidv = String(rec.g || (gm && gm[1]) || '');
    if (gidv) {
      const list = idxMaps.gid[gidv] || (idxMaps.gid[gidv] = []);
      if (list.indexOf(rec) < 0) list.push(rec);
    }
    return rec;
  }
  let writeQueued = false;   // 同一微任务里的多次改动合并成一次落盘（见 queueWrite）
  /* 镜像指针本体放 IndexedDB（20k 条塞 localStorage 会顶到 5MB 配额，把设置/素材库一起挤掉）。
     localStorage 只留最近 2000 条的**暖启动缓存**；IndexedDB 读回来之前先用它，
     读回来之后合并（旧键不丢），随后以 IDB 为准。 */
  const LOCAL_CACHE_MAX = 2000;
  let idxBoot = null;
  function rawIndex() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(K_IDX) || 'null'); } catch (e) {}
    const out = (d && typeof d === 'object' && d.m) ? d : { v: 1, m: {} };
    if (!out.a || typeof out.a !== 'object') out.a = {};
    return out;
  }
  function writeLocalCache(d) {
    /* 不做全表排序（20k 条 × 每次镜像都排一次 = 主线程抖动）；对象插入顺序就是索引顺序，
       取前 2000 条当暖启动缓存，完整表由 IndexedDB 在 1 秒内接上。 */
    const cache = { v: 1, m: {}, a: {} };
    const keys = Object.keys(d.m || {});
    /* 取**最后** 2000 条（对象插入顺序：旧 → 新），首屏最可能看到的是最近的产物。 */
    for (let i = Math.max(0, keys.length - LOCAL_CACHE_MAX); i < keys.length; i++) {
      const k = keys[i], rec = d.m[k];
      if (!rec) continue;
      cache.m[k] = rec;
      if (rec.a) cache.a[rec.a] = k;
    }
    try { localStorage.setItem(K_IDX, JSON.stringify(cache)); } catch (e) {}
  }
  function mergeIndex(dst, src) {
    if (!dst || !src) return dst;
    const m = dst.m || (dst.m = {});
    Object.keys(src.m || {}).forEach(k => {
      const a = src.m[k], b = m[k];
      if (!b || (Number(a && a.t) || 0) > (Number(b && b.t) || 0)) m[k] = a;
    });
    const a = {};
    Object.keys(m).forEach(k => { const rec = m[k]; if (rec && rec.a) a[rec.a] = k; });
    Object.keys(src.a || {}).forEach(id => { if (!a[id]) a[id] = src.a[id]; });
    dst.a = a;
    return dst;
  }
  function bootMirrorIndex() {
    if (idxBoot) return idxBoot;
    const K = window.Kv;
    if (!K || typeof K.at !== 'function') { idxBoot = Promise.resolve(); return idxBoot; }
    idxBoot = (async () => {
      let stored = null;
      try { stored = await K.at('mirror').get('idx'); } catch (e) {}
      const mem = idx || rawIndex();
      if (stored && stored.m && typeof stored.m === 'object') {
        idx = mergeIndex(stored, mem);
      } else {
        idx = mem;
        try { await K.at('mirror').put('idx', mem); } catch (e) {}
      }
      idxMaps = null;
      writeLocalCache(idx);
      try { window.dispatchEvent(new CustomEvent('wb:mirror-ready', { detail: { count: Object.keys(idx.m).length } })); } catch (e) {}
    })();
    return idxBoot;
  }
  let idxQueued = false;
  function queueIdxWrite(d) {
    const K = window.Kv;
    if (!K || typeof K.at !== 'function' || idxQueued) return;
    idxQueued = true;
    Promise.resolve().then(async () => {
      idxQueued = false;
      try { await K.at('mirror').put('idx', d); } catch (e) {}
    });
  }
  function read() {
    if (!idx) idx = rawIndex();
    bootMirrorIndex();
    return idx;
  }
  function write() {
    const d = read();
    const keys = Object.keys(d.m);
    if (keys.length > IDX_MAX) for (const k of keys.slice(IDX_MAX)) { delete d.a[d.m[k].a]; delete d.m[k]; }
    idxMaps = null;                    // 反查表跟着索引作废（下一次用再一次建）
    writeLocalCache(d);
    queueIdxWrite(d);
  }
  /* 微任务合并落盘（A2）。learn() 一直是这么做的，而 runOne / offer 这两条**更频繁**的路径
     以前每成功一条就独立 write() 一次：批量镜像 N 条新产物 = N 次整表 JSON.stringify + N 次整表
     写盘，全同步在主线程上（镜像队列并发是 2，一次批量操作很容易攒出几十条）。
     合并窗口只有一个微任务，所以「合并期内进程被关」的丢数据风险并不存在 —— 同一个任务里就跑完了。 */
  function queueWrite() {
    if (writeQueued) return;
    writeQueued = true;
    Promise.resolve().then(() => { writeQueued = false; write(); });
  }

  /* 一条产物的稳定身份。**优先用平台给的 id（assetId / 任务号），最后才退到地址** ——
     签名地址每次列表刷新都换一串，keyed by 地址等于每次都重新镜像一遍。 */
  function keyOf(provId, o) {
    const p = provId || (o && o.provider) || '';
    if (o && o.assetId) return p + '|a:' + o.assetId;
    if (o && o.genId) return p + '|g:' + o.genId;
    const u = o && (o.upstream || o.rawSrc || o.raw || o.url);
    return u ? p + '|u:' + mediaKey(String(u)) : '';
  }

  /* ---------- 「这份外链在本机有没有副本」的反查表 ----------
     镜像记录按**产物身份**存（provider|a:/g:/u:），可页面手上常常只有一个签名外链：
     收藏（fav_items）、导演台工作区（workspace）、素材库存的都是**当时**那个地址。
     以前只有 AssetLib.decorate 会按身份去查（它只服务列表条目），所以「优先用本机文件」
     这个开关只管得着资产库那一张列表 —— 别的页面第二天照旧打过期外链，
     表现就是「视频没有预览图、点开只回一句 Format error」。
     按地址查要扫一遍记录（原来 onMediaError 就是 Object.values 扫的），而这些查询现在
     每次算地址都要跑（一屏几百条），所以一次遍历建两张反查表、索引写入时作废：
       · up：外链素材身份 → 记录（地址层用，见 localCopyOf）
       · la：本机资产号 → 镜像键（列表层用，见 twinOf；不靠索引里那份 a 表，
              老记录里 a 表缺失也能自洽 —— 键与本机号本来就成对存在 m 里） */
  function maps() {
    if (idxMaps) return idxMaps;
    const d = read();
    const up = {}, la = {}, aid = {}, gid = {};
    Object.keys(d.m).forEach(k => {
      const rec = d.m[k];
      if (!rec || !rec.a) return;
      tagRec(rec, k);
      la[rec.a] = k;
      const u = rec.up ? mediaKey(String(rec.up)) : '';
      if (u) up[u] = rec;
      /* 平台产物号 → 记录（第三张表，见 localAssetIdOf 里 /asset/<产物号> 那一路）。
         产物号优先读记录上的 `p`（新镜像直接写），老记录只能从键上认回来
         —— 这也是为什么这第三张表必须由 maps 现算而不是落盘。 */
      const am = /\|a:(.+)$/.exec(k);
      const aidv = String(rec.p || (am && am[1]) || '');
      if (aidv) aid[aidv] = rec;
      /* 任务号 → 记录**列表**：同一任务可能出多张图，一个任务号对应多份文件。
         列表长度 ≥2 时谁也不能拿它认身份（见 mirrorOf 的用法），只留作「查询」用。 */
      const gm = /\|g:(.+)$/.exec(k);
      const gidv = String(rec.g || (gm && gm[1]) || '');
      if (gidv) (gid[gidv] = gid[gidv] || []).push(rec);
    });
    idxMaps = { up, la, aid, gid };
    return idxMaps;
  }
  /* 「这一条对应索引里的哪一条镜像记录」—— **全项目只有这一份身份判据**。
     decorate / twinOf / hasLocal 都走它，页面不许自己拼 provider+id。
     按可靠度依次试：主键（平台产物号 > 任务号 > 来源地址） → 平台产物号（跨 provider
     前缀也认：SparkCine 生图与视频共用一把钥匙、注册表里却是两个 id） → 任务号
     （**只有整条列表里这个任务只有一份产物时才许用**，多图任务按任务号合会把四张并成一张）
     → 本机资产号 → 地址反查（镜像索引里记着的上游地址 / 本机号）。
     `allowGen` 由调用方给：decorate 在整表里数过「这个任务只出了一条」之后才传 true，
     twinOf / hasLocal 一律不传 ——「合卡」比「换地址」更需要保守。 */
  function mirrorOf(e, allowGen) {
    if (!e) return null;
    const d = read();
    const p = String(e.provider || '');
    const up0 = e.rawSrc || e.upstreamSrc || e.raw || e.url;
    const k0 = keyOf(p, { assetId: e.assetId, genId: e.genId, upstream: up0 });
    if (k0 && d.m[k0]) return { k: k0, rec: d.m[k0] };
    const mp = maps();
    const aid = String(e.assetId || '');
    if (aid && mp.aid[aid]) {
      const rec = mp.aid[aid], k = recKeys.get(rec);
      if (k) return { k, rec };
    }
    if (allowGen && e.genId) {
      const list = mp.gid[String(e.genId)] || [];
      if (list.length === 1) {
        const rec = list[0], k = recKeys.get(rec);
        if (k) return { k, rec };
      }
    }
    const selfId = String(e.assetId || e.id || '');
    if (selfId && mp.la[selfId]) {
      const k = mp.la[selfId], rec = d.m[k];
      if (rec) return { k, rec };
    }
    for (const u of [e.rawSrc, e.upstreamSrc, e.raw, e.url, e.dl, e.src, e.media]) {
      const la = localAssetIdOf(u);
      if (la && mp.la[la]) {
        const k = mp.la[la], rec = d.m[k];
        if (rec) return { k, rec };
      }
      const uu = mediaKey(u);
      if (uu && mp.up[uu]) {
        const rec = mp.up[uu], k = recKeys.get(rec);
        if (k) return { k, rec };
      }
    }
    return null;
  }
  /* 有本机镜像时给本机地址（没开「优先用本机文件」/ 查不到都返回空串）。
     **不去问磁盘上文件还在不在** —— 那是每条地址一个请求。真被删了，代理那一级的
     回退会按索引里的 upstream 302 回外链，界面上的 error 监听再兜一层（见 onMediaError）。 */
  function localCopyOf(u) {
    if (!preferLocal()) return '';
    const la = localAssetIdOf(u);
    return la ? Api.assetSrc(la) : '';
  }
  /* 这条地址对应**本机镜像的那个资产号**，不看「优先用本机文件」开关。
     开关决定的是「画面上用哪个地址」，不是「这是哪一份东西」—— 所以凡是「同一份产物」的判据
     （缩略图缓存键、列表合并、跨页去重）都必须走这一份而不是上面那个。
     踩过：键跟着开关走，关掉开关之后同一个视频在缓存里成了两份 —— 抽两次帧、存两份小图，
     而平台那一份外链一过期就永远抽不出来，表现是「开关一关，预览图全没了、滚回去又闪一次」。 */
  function localAssetIdOf(u) {
    const s = String(u == null ? '' : u);
    const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(s);          // 已经是本机地址：资产号就在路上
    if (m) {
      if (/^la_/.test(m[1])) return m[1];                   // la_ 开头 = 本机文件号，代理按文件名就能取到
      /* 平台产物号（/asset/<产物号>，代理会用密钥去上游换最新签名地址）：
         这一路以前**认不出身份** —— 正则只放行 la_ 前缀，up 表又只按签名外链建键，
         于是「本机明明存过镜像」也查不到 → 同一个产物算两个键 → 抽两次帧，
         其中一次走公网回源（顺带把一份大文件再下一遍）。产物号在键里（|a:），
         所以查第三张表 aids（见 maps）。 */
      const rec = maps().aid[m[1]]
        || ((maps().gid[m[1]] && maps().gid[m[1]].length === 1) ? maps().gid[m[1]][0] : null);
      if (rec && rec.a) return String(rec.a);
    }
    const k = mediaKey(s);                     // mediaKey 自己会拆 /getv 包装（判据只有一份）
    if (!k) return '';
    const rec = maps().up[k];
    return rec && rec.a ? String(rec.a) : '';
  }
  /* 「这一条地址对应的本机文件长什么样」：给 FCPXML 这种要**磁盘路径**的出口用。
     只返回 id / 格式 / 名字 / 字节数，不给路径 —— 路径由代理的资产目录与页面拼（见导演台导出）。
     索引丢了但地址就是 `/asset/la_x` 时 id 仍认得出，格式给空串（调用方按产物类型兜底）。 */
  function localFileOf(u) {
    const id = localAssetIdOf(u);
    if (!id) return null;
    const d = read(), k = maps().la[id], rec = k ? d.m[k] : null;
    return { id, format: String((rec && rec.f) || ''), name: String((rec && rec.n) || ''), bytes: Number((rec && rec.b) || 0) };
  }
  /* 一条产物在镜像索引里的身份。**平台列表那一条**由 decorate 挂上 mirrorKey；
     **本机资产库那一条**（条目即资产，id 就是 la_xxx）只能按本机号反查。
     这两条其实是同一个东西 —— 「同一个任务重复出现」与「提示词只有一半卡片上有」
     都是它造成的，而判据只许有这一处。
     第三种形状也要认：**收藏 / 工作区里那条既没有 mirrorKey、又不是 la_xxx**
     （它存的是当初那个平台产物号，或者就是当初那个地址）。只认前两种的话，选择器里
     「资产库那一条 + 我的收藏那一条」就是同一份文件的两个格子（用户看到的正是「视频任务重复」），
     所以按产物号 / 按地址各现算一次身份，**只在索引里确有这条镜像时**才算数 ——
     没有副本的产物各按各的 id 判，不多合并任何东西。
     产物号那一路只认**带 assetId 的**（`|a:`）：任务号与地址那两种身份对多图任务不唯一 ——
     同一次生成出来的四张图共用一个任务号，按任务号合一次就把四张并成一张。
     地址那一路（`localAssetIdOf`）是逐个字节的，天生一份文件一个键，所以两种行都能走，
     并且它**不看「优先用本机文件」开关** —— 开关管的是取哪个字节，不是「这是哪一份东西」。 */
  function twinOf(e) {
    if (!e) return '';
    if (e.mirrorKey) return e.mirrorKey;
    /* 判据只有 mirrorOf 一处（见它上面的说明）。这里刻意**不**允许按任务号认：
       多图任务的一张产物被当成整条任务的镜像，四张卡上的「本机」就会指向同一个文件。 */
    const hit = mirrorOf(e, false);
    return hit && hit.k ? hit.k : '';
  }

  /* 一条东西在镜像键上的身份，**条目与卡片两种形状算得出同一个**（卡片的 `taskId` = 条目的 `genId`，
     卡片还多一个 `raw`）。与 offer / decorate / learn 那三处同一个表达式 —— 换一套就会出现
     「卡片说在队列里、索引说没存过」，藏与不藏就全凭运气。 */
  function keyFor(o) {
    return keyOf(o.provider, {
      assetId: o.assetId,
      genId: o.genId || o.taskId || '',
      upstream: o.rawSrc || o.upstreamSrc || o.raw || o.url,
    });
  }
  /* 这一条在本机到底有没有字节。**判据只在这一处**，页面不许自己拼 `localAsset` / `mirrorKey` /
     `/asset/` 前缀 —— 那几样分属「decorate 挂上的」「本机资产库那条」「平台列表那一条」三种形状，
     自己拼一定会漏一种。 */
  function hasLocal(o) {
    if (!o) return false;
    if (o.local || o.localAsset || o.fromLocal || o.kind === 'local' || o.mirrorKey || o.mirror) return true;
    if (twinOf(o)) return true;
    /* 地址本身就写着本机文件号（`/asset/la_xxx`）也算 —— 这一路不查索引，所以
       「learn 刚把身份补上、反查表还没作废」的那一轮也不会把用户自己库里的东西当云端藏掉。
       `media` 是生成工作台卡片上的地址字段（同一个东西的另一个名字）。 */
    return !!(localAssetIdOf(o.src) || localAssetIdOf(o.rawSrc) || localAssetIdOf(o.dl) || localAssetIdOf(o.media));
  }
  /* 这一条在平台那边存不存在（能不能再从云端取回来）。
     与 hasLocal 分开：本机自产（MiMo 语音、本地上传）只有本机这一份，平台没有可回源的产物；
     而「平台列表那一条 + 本机镜像」两边都有 —— 徽标要写「本机+云端」而不是任选一个。 */
  const LA_ID = s => /^la_/.test(String(s || ''));
  function hasCloud(o) {
    if (!o || o.kind === 'local' || o.fromLocal) return false;
    if (o.mirrorKey || o.mirror) return true;       // 来自平台列表、且有本机副本
    if (o.kind === 'task') return true;             // 还在平台侧跑
    if (o.upstreamSrc || o.rawSrc) return true;
    if (/^\/(?:getv|fetch)\?/.test(String(o.src || o.media || ''))) return true;
    if (/^https?:/i.test(String(o.src || o.media || ''))) return true;
    /* 收藏 / 工作区里只存了地址、没有 assetId 的那一族：`/asset/<平台产物号>` 也是云端那条
       （`/asset/la_…` 是本机文件，不算）。 */
    if (o.provider && !/^(?:local|本机)$/i.test(o.provider) && /^\/asset\/(?!la_)/.test(String(o.src || ''))) return true;
    if (o.assetId && !LA_ID(o.assetId)) return true;
    if (o.genId && !LA_ID(o.genId)) return true;
    if (o.taskId && !LA_ID(o.taskId)) return true;
    return false;
  }
  /* 卡片上「本机 / 云端」那一颗与「存回本机」的范围都读这一份 —— 以前两处各拼一套
     （徽标看 localAsset、范围看地址），于是同一张卡上写着「本机」、按钮却把它算进「还没存」的 N 条里。 */
  function stateOf(o) {
    const local = hasLocal(o);
    const cloud = hasCloud(o);
    return { local, cloud, state: local && cloud ? 'both' : local ? 'local' : cloud ? 'cloud' : '' };
  }
  /* 这个**地址**在本机有没有凭据：收藏 / 素材库存的是一串地址，不是条目对象，只能按地址问。
     `blob:` 是当场上传的那一份，换页就没了，**绝不算**本机副本（把它算进去等于
     「开关开着、库里的图却被当成已经有了」，列表一藏就什么都找不到）。 */
  function hasLocalAddr(u) {
    const s = String(u || '');
    return /^blob:/.test(s) ? false : !!localAssetIdOf(s);
  }
  /* 「不显示云端任务」藏的是**已经出了产物、可本机没有这份字节**的那一条。
     三种情况刻意不藏，每一种都对应一种「看着像坏了」的表现：
       · 还没出结果的（在跑 / 排队 / 状态没给）—— 卡片刚建时本机必然还没有副本，藏了就是
         「点了生成，什么都没发生」；
       · 失败的 —— 卡片上那句失败原因是唯一的凭据，藏起来人就再也看不到为什么没成；
       · 正在往本机存的那一条 —— 否则刚生成的结果闪一下就没了，落盘完才回来，
         而那一闪的时间正好是人去看结果的时间。
     本机资产库那种「条目本身就是资产」的行（kind:'asset'）没有 status，有没有字节只看身份。 */
  function hideAsCloud(o) {
    if (!localOnly() || !o || hasLocal(o)) return false;
    const k = keyFor(o);
    if (k && queued.has(k)) return false;
    if (o.kind === 'asset') return true;
    const st = String(o.status || '');
    return !!st && classifyStatus(null, st) === 'done';
  }

  function blobToB64(blob) {
    return new Promise((ok, bad) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ''); const i = s.indexOf(','); ok(i >= 0 ? s.slice(i + 1) : s); };
      r.onerror = () => bad(new Error('读文件失败'));
      r.readAsDataURL(blob);
    });
  }
  const extOf = (blob, e) => String(e || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
    || EXT_BY_MIME[String((blob && blob.type) || '').toLowerCase()] || 'bin';
  /* 名字怎么洗归公共那一份（`ui.js` 的 `fileSafe`，§J ⑲ 守着）。这一处以前自己写了第二份非法字符正则，
     而且是**直接删掉**那些字符（别的页换成 -），于是同一条素材从本机另存与从资产库下载，名字对不上；
     截断也各是一份（这里 20、页面那两处 24）。本函数只管「提示词当前缀 + 扩展名」。 */
  /* `e.name` 是调用方给的人类可读名（导演台：场景 + 镜头 + 候选号），**不带扩展名**；
     没有就退回提示词前缀。截断从 24 放宽到 80：场景镜头名要留得下「场景01-…_镜头03-…_候选2」，
     而旧素材不重命名，只有新镜像才走这一条。 */
  const nameOf = (e, ext) => window.fileSafe((e && e.name) || (e && e.prompt) || '素材', 80) + '.' + ext;

  const queue = [];
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, CONCURRENCY);
        /* 开关中途关掉：排队中的只留 force（用户亲手点「存回本机」的那批），
           其余当场从在途账上摘掉，不再发新请求。 */
        const live = batch.filter(j => saveOn() || j.force);
        if (live.length !== batch.length) {
          batch.forEach(j => { if (live.indexOf(j) < 0) { queued.delete(j.k); INFOS.inFlight = Math.max(0, INFOS.inFlight - 1); } });
          infoChanged();
        }
        if (live.length) await Promise.all(live.map(runOne));
      }
    } finally { pumping = false; }
  }
  /* 一条队列任务的回执。只有「用户亲手点『自动下载』」那一批会传 cb ——
     后台自动镜像是静默的（产物该显示还是显示），没人等它的结果。 */
  /* 「正在往本机存」的状态观察口——**判据只有这一处**。
     没有它的时候这个功能的表现是「开了没反应」：一份产物从列表出现到字节落盘要好几秒
     （视频更大），这段时间界面上**一个字都没有**，用户以为开关没生效；
     真失败时（超上限 / 网络断 / 代理没回资产号）更是静默 —— 后台镜像的 tell 明确不回执。
     这不是加一个装饰，是把这个功能唯一的说得清的地方补上。
     onChange 订阅者只用来刷新那一行文案，不参与任何写盘决策。 */
  /* `dlName/dlTotal/dlSent` 是**当前正在下载的那一份**（用户要看到的不只是「N 份在途」，
     还要看到「这一份下到多少」—— 一个 200MB 的视频在界面上从 0% 到 100% 长得一模一样时，
     人只能干等）。三个字段都由 runOne 那一处写，这里只声明（判据不散在别处）。
     `dlot` 是**占着这条进度的是哪一份**（runOne 里那个 k）：并发两份时只摆一份，
     不写它就会出现两个文件抢同一条进度、两个数字互相覆盖。 */
  const INFOS = { inFlight: 0, ok: 0, fail: 0, lastErr: '', lastAt: 0,
    dlot: '', dlName: '', dlTotal: 0, dlSent: 0, listeners: new Set() };
function infoChanged() {
  for (const f of INFOS.listeners) { try { f(INFOS); } catch (e) { /* 订阅者出错不许影响落盘 */ } }
}
function infoNote(ok, err) {
  if (ok) { INFOS.ok++; INFOS.lastAt = Date.now(); INFOS.lastErr = ''; }
  else { INFOS.fail++; INFOS.lastAt = Date.now(); INFOS.lastErr = String(errText(err)|| '未知原因'); }
  infoChanged();
}
/* 订阅：返回退订函数。页面用它刷新那一行实况（设置页 / 资产库底部）。 */
function onInfo(fn) {
  if (typeof fn !== 'function') return () => {};
  INFOS.listeners.add(fn);
  try { fn(INFOS); } catch (e) {}
  return () => INFOS.listeners.delete(fn);
}
function info() {
  const s = read();
  return { inFlight: INFOS.inFlight + queued.size, ok: INFOS.ok, fail: INFOS.fail,
    lastErr: INFOS.lastErr, lastAt: INFOS.lastAt,
      dlName: INFOS.dlName, dlTotal: INFOS.dlTotal, dlSent: INFOS.dlSent,
    count: Object.keys(s.m || {}).length, bytes: Object.values(s.m || {}).reduce((a, r) => a + (Number(r && r.b) || 0), 0),
    on: saveOn() };
}

  async function runOne(job) {
    const { k, url, ent } = job;
    if (!saveOn() && !job.force) {
      queued.delete(k);
      INFOS.inFlight = Math.max(0, INFOS.inFlight - 1);
      infoChanged();
      return;
    }
    const tell = (err, res) => {
      if (!job.cb) return;
      try { job.cb(err || null, res || {}); } catch (e) { console.warn('[AssetLocal] 落盘回执出错：', e); }
    };
    try {
      /* ---- 这一份的下载进度：侧栏那行「正在下这一份 N%」的全部数据来源 ----
         ⚠ 这里以前**根本没接**：`blobOf` 是支持 onStage 的（流式读响应体，每 200ms / 每 1% 报一次，
         总量取 Content-Length，代理在 /getfile 那一支把上游的长度原样透出），
         这一行却只调了 `blobOf(url)` —— 于是 `INFOS.dlSent/dlTotal/dlName` 三个字段
         **全项目没有任何一处给它们赋值**，侧栏那段进度条的 HTML 画得挺好，条件却永远不成立
         （`busy && dlTotal > 0` 里 dlTotal 恒为 0）。用户看到的就是「正在存 N 份」一直不动，
         一个 200MB 的视频从 0 到 100% 全程没有第二个字。
         CONCURRENCY=2 时两份同时在下，dl* 只摆一份：**先抢到的那份占着**，直到它下完，
         免得那条进度在两个文件之间来回跳（比不显示更难读）；它下完后另一份接手。 */
      const dlName = String((ent && (ent.prompt || ent.title)) || '').trim().slice(0, 24);
      const claimDl = () => {
        if (INFOS.dlot === k) return true;
        if (INFOS.dlot) return false;                 // 另一份正占着位置
        INFOS.dlot = k; INFOS.dlName = dlName; INFOS.dlSent = 0; INFOS.dlTotal = 0;
        return true;
      };
      if (claimDl()) infoChanged();                   // 先把「正在存这一份（名字）」摆出来
      const detailOf = size => ent ? {
        /* 平台产物号逐条落盘（多图任务里一份产物一行，任务号相同、产物号不同）。
           没有它，本机列表认回来的身份只有 `g:<任务号>`，多图任务就会把四张并成一张；
           平台列表那边按产物号来认时也永远对不上。 */
        asset: (ent && ent.assetId) || '',
        task: (ent && ent.genId) || (ent && ent.taskId) || '',
        model: (ent && ent.model) || '', tier: (ent && ent.tier) || '', res: (ent && ent.res) || '',
        ar: (ent && ent.ar) || '', duration: (ent && ent.duration) ?? null, count: (ent && ent.count) ?? null,
        quality: (ent && ent.quality) || '', format: (ent && ent.format) || '',
        credits: (ent && ent.credits) ?? null, priceMicros: (ent && ent.priceMicros) ?? null,
        currency: (ent && ent.currency) || '', gstatus: (ent && ent.gstatus) || '',
        created: (ent && ent.created) || '', completed: (ent && ent.completed) || '',
        promptLocal: !!(ent && ent.promptLocal), bytes: size,
      } : null;
      const metaBase = {
        prompt: (ent && ent.prompt) || '', model: (ent && ent.model) || '',
        provider: (ent && ent.provider) || '', credits: (ent && ent.credits) ?? null,
        priceText: (ent && ent.priceText) || '', duration: (ent && ent.duration) ?? null,
        upstream: url,
      };
      /* 新通道：代理按地址流式落盘，浏览器不再把整段字节读进内存再 base64。
         旧代理没有 `/local-assets/from-url`（404）才退回 blob + base64；这条回退只服务
         blob:/data: 与旧代理，日常的 http / /asset / /getv 都走新通道。 */
      const guessExt = String((ent && ent.format) || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
        || (ent && window.isAudioType && isAudioType(ent.type) ? 'wav' : '')
        || (/\.(wav|mp3|m4a|aac|ogg|flac)(?:\?|$)/i.exec(String(url || '')) || [])[1]
        || 'mp4';
      let r = null, blob = null, ext = guessExt, b64 = '';
      const direct = /^(?:https?:|\/(?:asset|getv|fetch)(?:\/|\?|$))/i.test(String(url || ''));
      if (direct) {
        try {
          r = await Api.saveLocalFromUrl({
            url, name: nameOf(ent, guessExt), mime: '', format: (ent && ent.format) || '',
            meta: Object.assign({}, metaBase, { detail: detailOf(0) }),
          });
        } catch (e) {
          if (!(e && e.status === 404)) throw e;      // 404 = 旧代理没有这条路由，退回旧链
        } finally {
          /* 新通道由代理下载，浏览器这一侧没有百分比；把「正在下」收掉，
             否则侧栏会一直停在上一份（另一个任务也抢不到这个位置）。 */
          if (INFOS.dlot === k) {
            INFOS.dlot = ''; INFOS.dlName = ''; INFOS.dlSent = 0; INFOS.dlTotal = 0;
            infoChanged();
          }
        }
      }
      if (!r) {
        try {
          blob = await AssetTransfer.blobOf(url, (stage, p) => {
            if (stage !== 'fetch' || !p || !claimDl()) return;
            INFOS.dlSent = Number(p.sent) || 0;
            INFOS.dlTotal = Number(p.total) || 0;      // total 为 0 = 上游没给长度，侧栏只显示名字不摆条
            infoChanged();
          });
        } finally {
          /* 下载这一段一结束就把进度收掉：后面还有转 base64 与写盘，那几秒里挂着一条 100% 的条、
             还写着「正在下这一份」，是在说一件已经不成立的事。 */
          if (INFOS.dlot === k) {
            INFOS.dlot = ''; INFOS.dlName = ''; INFOS.dlSent = 0; INFOS.dlTotal = 0;
            infoChanged();
          }
        }
        if (!blob || !blob.size) throw new Error('取回字节为空');
        if (blob.size > MIRROR_MAX) {
          /* 超上限的这份**放弃自动重试**（记进 SKIPPED），同时把它从在途表里摘掉。
             「本机镜像的上限」只在 base64 这条旧链上还有意义：新通道由代理流式落盘，
             不受 288MB 请求体与 5× 内存放大的约束。 */
          SKIPPED.add(k);
          queued.delete(k);
          pendBump(k, true);
          const tooBig = new Error('这份比本机镜像的上限（' + window.fmtBytes(MIRROR_MAX) + '）还大，没有存');
          infoNote(false, tooBig);
          tell(tooBig, { skip: true });
          return;
        }
        ext = extOf(blob, ent && ent.format);
        b64 = await blobToB64(blob);
        r = await Api.saveLocalAsset({
          name: nameOf(ent, ext), mime: blob.type || '', format: ext,
          data: b64,
          meta: Object.assign({}, metaBase, { detail: detailOf(blob.size) }),
        });
      }
      if (r && r.id) {
        const size = Number(r.byte_length) || (blob && blob.size) || 0;
        ext = r.format || ext;
        const d = read();
        /* 一个本机号只许有一个键。代理返回 `reused` 时它已经有旧键了 ——
           这时必须沿用旧键，不能拿本次算出来的 k 再建一个（那会让同一个 la 挂在两个键上，
           twinOf 合不到一起，下一次又出现重复卡）。 */
        const oldKey = d.a[r.id];
        const key = oldKey || k;
        const prev = d.m[key] || {};
        d.m[key] = Object.assign({}, prev, {
          a: r.id, f: r.format || ext, n: r.name || prev.n, t: Date.now(),
          b: size || prev.b, up: url,
          p: String((ent && ent.assetId) || prev.p || ''),
          g: String((ent && (ent.genId || ent.taskId)) || prev.g || ''),
        });
        if (k !== key && d.m[k] && d.m[k].a === r.id) delete d.m[k];
        d.a[r.id] = key;
        tagRec(d.m[key], key);
        queueWrite();
        queued.delete(k);          // 成功也要摘：留在在途表里下一轮就不会再 offer（那份已经存过了）
        queued.delete(key);
        pendDone(k);
        infoNote(true);
        /* 本机多了一份产物就说一声：别的页面那一张卡还挂在平台外链上（「已存本机」的标记、
           与本机那一条合成一张卡都靠重拉列表时的 decorate / 合表），不重拉就一直停在云端形态。 */
        try { if (window.Wb && Wb.busEmit) Wb.busEmit('local', { id: r.id, key: key }); } catch (e) {}
        tell(null, { id: r.id, size: size });
      } else {
        /* 代理收了请求却没给资产号 = 这份字节其实没落地，回执必须报失败，
           不然按钮说「已存好 N 条」而索引里一条都没有。 */
        throw new Error('代理没有返回资产号');
      }
      /* ---------- 按类型另存一份到用户指定的文件夹 ----------
         存进 .assets 资产库是**应用自己的那份**（离线能看、删了能回源），不能因为用户
         想在「D:\AI图」里看到产物就不存 —— 那是两件事。所以这里是**额外再写一份**。
         镜像成功之后用 `/save-local` **按资产号拷贝**（代理从 .assets 读），不再把同一段
         base64 第二次递过去：大文件那一下会再把内存与请求体放大一遍。 */
      const kind = kindOf(ext, (blob && blob.type) || r.mime || '');
      const conf = autosaveConf()[kind] || null;
      if (kind && conf && conf.on) {
        let done = false;
        if (Api.saveLocal) {
          try {
            const s = await Api.saveLocal({ ids: [r.id] });
            const bad = (s && s.full && s.full[0] && s.full[0].why)
              || (s && s.missing && s.missing.length ? '资产索引里没有这一条' : '');
            const good = !!(s && ((s.saved && s.saved.length) || (s.dup && s.dup.length)));
            noteSaveFail(kind, good ? '' : (bad || '代理没有确认写入'));
            done = true;
          } catch (e) {
            if (!(e && e.status === 404)) { noteSaveFail(kind, errText(e)); done = true; }
          }
        }
        /* 旧代理没有 /save-local：只有手里还有 b64 时才退回 /save */
        if (!done && b64) {
          try {
            const s = await Api.saveToDir({ type: kind, name: r && r.name ? r.name : nameOf(ent, ext),
              mime: (blob && blob.type) || '', format: r && r.format ? r.format : ext, data: b64 });
            noteSaveFail(kind, s && s.ok ? '' : (s && s.error && s.error.message) || '代理没有确认写入');
          } catch (e) {
            noteSaveFail(kind, errText(e));
          }
        }
      }
    } catch (e) {
      /* 镜像失败**不打扰界面**：它是锦上添花，产物该显示还是显示。
         也不把失败写进索引 —— 下一轮列表刷新还会再 offer 一次（成功为止）。
         所以要把这一条从在途表里摘掉：以前失败的那一条永远留在表里，
         「再 offer 一次」根本不会发生，用户再点一次「自动下载」也是一颗死按钮。 */
      queued.delete(k);
      pendBump(k, false);
      const err = e instanceof Error ? e : new Error(String(errText(e)|| '存不进本机'));
      infoNote(false, err);
      tell(err);
    } finally {
      /* 在途计数在 finally 里减：runOne 里的每一条出口（成功 / 超上限 / 抛错）
         都要走它一次，而在这些出口上分别写一遍减法就会漏。 */
      INFOS.inFlight = Math.max(0, INFOS.inFlight - 1);
      infoChanged();
    }
  }

  const queued = new Set();
  /* 「试过、超出本机镜像上限、放弃自动重试」的那几个键。
     以前这条意图只留了一句 `read().skip = String(read().skip || '')` —— 写回同一个值，
     全项目没有任何一处读它，于是「别再自动重下」实际上靠的是「永远挂在 queued 里」，
     代价是在途数与「只看本机」从此失真（一份没存下来的东西永远显示「正在存」）。 */
  const SKIPPED = new Set();
  /* ---------- 待镜像清单（跨页面 / 刷新仍在）----------
     自动镜像过去只在「某个页面加载了列表」时才开始；导演台单独开着时不触发。
     现在生成完成会投 `wb:asset-done`，同时把还没存完的条目写进 localStorage：
     刷新之后、或者当时没有列表页在跑，也会在壳里接着存。条目只留身份与元数据，
     不带大字段；同一 k 只留一条。 */
  const K_PENDING = 'sk_local_pending';
  const pendSkip = new Map();      // k → 下次允许重试的时刻（内存，启动时从清单恢复）
  let pendCache = null, pendWriteT = 0;
  function pendRead() {
    if (pendCache) return pendCache;
    try { const a = JSON.parse(localStorage.getItem(K_PENDING) || '[]'); pendCache = Array.isArray(a) ? a.filter(x => x && x.k && x.url) : []; }
    catch (e) { pendCache = []; }
    return pendCache;
  }
  function pendWrite(list) {
    pendCache = (list || []).slice(-200);
    clearTimeout(pendWriteT);
    pendWriteT = setTimeout(() => {
      pendWriteT = 0;
      try { localStorage.setItem(K_PENDING, JSON.stringify(pendCache)); } catch (e) {}
    }, 50);
  }
  const liteEnt = ent => {
    if (!ent) return {};
    const out = {};
    ['provider', 'providerName', 'assetId', 'genId', 'taskId', 'id', 'type', 'format', 'prompt', 'model',
      'tier', 'res', 'ar', 'quality', 'count', 'duration', 'credits', 'creditsRaw', 'priceMicros', 'currency',
      'priceText', 'chars', 'tokens', 'usage', 'gstatus', 'created', 'completed', 'promptLocal', 'byteLength']
      .forEach(k => { if (ent[k] != null) out[k] = ent[k]; });
    return Object.assign(out, { kind: 'asset', status: 'done' });
  };
  function pendPut(k, url, ent, force) {
    if (!k || !url) return;
    const list = pendRead();
    const at = list.findIndex(x => x.k === k);
    const prev = at >= 0 ? list[at] : null;
    const rec = { k, url, ent: liteEnt(ent), tries: force ? 0 : (prev && prev.tries || 0), nextAt: force ? 0 : (prev && prev.nextAt || 0) };
    if (at >= 0) list[at] = rec; else list.push(rec);
    pendWrite(list);
    if (rec.nextAt > Date.now()) pendSkip.set(k, rec.nextAt);
  }
  function pendDone(k) {
    if (!k) return;
    pendSkip.delete(k);
    const list = pendRead();
    const next = list.filter(x => x.k !== k);
    if (next.length !== list.length) pendWrite(next);
  }
  function pendBump(k, permanent) {
    if (!k) return;
    const list = pendRead();
    const i = list.findIndex(x => x.k === k);
    if (i < 0) return;
    if (permanent) { list.splice(i, 1); pendWrite(list); pendSkip.delete(k); return; }
    const rec = list[i];
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= 6) { list.splice(i, 1); pendWrite(list); pendSkip.delete(k); return; }
    rec.nextAt = Date.now() + Math.min(10 * 60 * 1000, 15000 * Math.pow(2, rec.tries));
    pendSkip.set(k, rec.nextAt);
    pendWrite(list);
  }
  let pendReplayT = 0;
  function replayPending() {
    if (pendReplayT) return;
    pendReplayT = setTimeout(() => {
      pendReplayT = 0;
      if (!saveOn()) return;
      const now = Date.now();
      const list = pendRead();
      list.forEach(x => { if (x.nextAt > now) pendSkip.set(x.k, x.nextAt); });
      list.forEach(x => {
        if (x.nextAt && x.nextAt > now) return;
        offer(x.ent && x.ent.provider, x.ent, x.url, { fromPending: true });
      });
    }, 1200);
  }
  /* 抹掉「这一条本机镜像」的记录 —— 用户刚在资产库点「删除本机文件」之后调它。
     与 learn / decorate 共用同一张表和同一套反查表（否则删掉了却还有指针指着一个死号，
     卡片会一直去问一个查无此号的 /asset/<本机号>，拿到 422 之后又重新下载一遍）。
     **只抹本机索引，不碰平台那份素材，也不把这条从列表里摘掉** —— 那是资产库页的事。 */
  function forgetMirror(ent) {
    const k = ent && ent.mirrorKey;
    if (!k) return false;
    const d = read();
    const rec = d.m[k];
    if (!rec) return false;
    delete d.m[k];
    if (rec.a && d.a[rec.a] === k) delete d.a[rec.a];
    const im = idxMaps;
    if (im) {
      if (rec.a) delete im.la[rec.a];
      for (const u in im.up) { if (im.up[u] === rec || im.up[u] && im.up[u].a === rec.a) delete im.up[u]; }
      for (const aid in im.aid) { if (im.aid[aid] === rec || im.aid[aid] && im.aid[aid].a === rec.a) delete im.aid[aid]; }
      for (const g in im.gid) {
        im.gid[g] = (im.gid[g] || []).filter(x => x !== rec && x && x.a !== rec.a);
        if (!im.gid[g].length) delete im.gid[g];
      }
    }
    liveSeen.delete(rec.a);
    queueWrite();
    return true;
  }
  /* 提交一条产物去存本机（幂等：已存过 / 正在存 / 关掉了开关都直接跳过）。
     返回这一条的去向，页面据此说话：
       'saved' 索引里已经有了（或按来源地址认出同一条）· 'busy' 后台那一轮正在存
       'queued' 排上了 · '' 这一条存不了（开关没开、或手里根本没有一条外链）。
     opts.force：绕过「自动存本机」开关 —— 收藏与素材库那两颗「自动下载」是用户**当下点下去**的，
       开关没开就什么都不做等于一颗死按钮（AGENTS.md：别让一个「看着能点、其实什么都不做」的控件留在界面上）。
     opts.cb(err, {id})：只对 force 那一批有意义（见 runOne 上的 tell），后台自动镜像照旧静默。 */
  function offer(provId, ent, upstream, opts) {
    const o = opts || {};
    if (!saveOn() && !o.force) return '';
    const raw0 = String(upstream || (ent && (ent.rawSrc || ent.raw)) || byteSrcOf(ent));
    /* 剥出内层外链再判协议：以前只收 https，于是「从收藏点自动下载」一条都排不上，
       而界面上一句回执都没有。
       **同源路由也要收**（/asset/<id>、/getv?url=…、/fetch?url=…&dl=1）：代理自己就能下这些，
       而「平台返回产物 id」那一族只有它们（见 byteSrcOf 的注释）——
       只收 https 时这一族永远排不上队列，「自动存本机」看起来就是没开张。 */
    const isHttp = /^https?:/i.test(raw0);
    const isSameOrigin = /^\/(?:asset|getv|fetch|local-assets)\b/.test(raw0);
    if (!isHttp && !isSameOrigin) return '';
    const url = isHttp ? raw0 : String(window.MediaId.innerMedia(raw0) || raw0);
    if (!/^https?:/i.test(url) && !/^\/(?:asset|getv|fetch|local-assets)\b/.test(url)) return '';
    const k = keyOf(provId, { assetId: ent && ent.assetId, genId: (ent && (ent.genId || ent.taskId)) || '', upstream: url });
    if (!k) return '';
    const platAsset = String((ent && ent.assetId) || '');
    const taskId = String((ent && (ent.genId || ent.taskId)) || '');
    /* 记录上补产物号 / 任务号：身份键可能是当初按地址算的（`|u:`），
       后来的列表带着产物号回来时必须能按产物号认回这一条，否则同一份东西会再下一遍。 */
    const noteIdentity = rec => {
      let ch = false;
      if (platAsset && String(rec.p || '') !== platAsset) { rec.p = platAsset; ch = true; }
      if (taskId && String(rec.g || '') !== taskId) { rec.g = taskId; ch = true; }
      if (ch) { tagRec(rec, k); queueWrite(); }
      return ch;
    };
    if (read().m[k]) { noteIdentity(read().m[k]); pendDone(k); if (o.cb) o.cb(null, { id: read().m[k].a, kept: true }); return 'saved'; }
    /* 试过、太大下不动的那一份不再自动重试（它连字节都没取回来，重来一次还是超大）。
       判据见 SKIPPED 的声明；手动那一路（force）不受影响，用户点了还是要照实回执。 */
    if (SKIPPED.has(k)) { pendBump(k, true); return o.force ? '' : 'skip'; }
    if (!o.force && (pendSkip.get(k) || 0) > Date.now()) return 'skip';
    if (queued.has(k)) return 'busy';
    /* 产物身份换了写法也要认得同一个文件：键优先按平台产物号（`|a:`），但平台并不每次都给 ——
       上一次按地址存的那条，这次按任务号算出来是另一个键，于是同一份文件再下一遍。
       按**来源地址**再查一次反查表，命中就照搬那条记录（本机号 / 字节 / 时间都不用重取）。
       代理那一道同身份的闸（`POST /local-assets` 的 localUpKey）是最终兜底，这一层只是省一趟下载。
       **不要**给同一个本机号再建一个键（`d.a` 只允许一号码一键，见 learn 的说明）：
       命中时把新知道的产物号补到原来那条记录上，下次按产物号就认得到了。 */
    const byUp = maps().up[mediaKey(url)];
    if (byUp && byUp.a) {
      const bk = maps().la[byUp.a];
      if (bk && read().m[bk]) {
        const rec = read().m[bk];
        if (platAsset || taskId) { rec.p = rec.p || platAsset; rec.g = rec.g || taskId; tagRec(rec, bk); queueWrite(); }
      } else {
        read().m[k] = { ...byUp };
        read().a[byUp.a] = k;
        tagRec(read().m[k], k);
        queueWrite();
      }
      if (o.cb) o.cb(null, { id: byUp.a, kept: true });
      pendDone(k);
      return 'saved';
    }
    queued.add(k);
    pendPut(k, url, ent, o.force);
    INFOS.inFlight++;
    infoChanged();
    queue.push({ k, url, ent: ent || {}, cb: o.cb, force: !!o.force });
    pump();
    return 'queued';
  }
  /* 页面手上只有一条「收藏项 / 工作台卡片」那样的东西，没有 provider + 三条上限那套参数：
     来源地址与平台身份都从这一份对象上现取，页面不许自己拼键（那是第二份身份判据）。
     与 hideAsCloud 用的是同一个 `keyFor` —— 「有没有」与「要不要下」必须是同一件事。 */
  function pull(o, opts) {
    if (!o) return '';
    const up = String(o.upstreamSrc || o.rawSrc || o.raw || o.url || byteSrcOf(o) || o.src || o.dl || '');
    return offer(String(o.provider || ''), o, up, opts);
  }

  /* ---------- 「把一批取回本机」只有这一份 ----------
     收藏、素材库、资产库三处都要「把云端那份字节取回本机」，循环与计数以前各写一遍
     （收藏那一份还多一个 skip 分支、素材库那一份要顺手把地址写回库里那一格），
     改一处就漏两处 —— 比如「太大下不动」这一档，只有收藏会照实报，别处是静默。
     jobs: [{ entry（交给 pull 的那一条，通常是那条条目自己）,
              name（回执里怎么称呼它）,
              apply(url)（存好了把本机地址写回去；不需要写回就省略） }]
     opts.onProgress(done, total)：逐条进度（三处都要在按钮上写「第几条 / 共几条」）。
     返回 { ok, kept, busy, cant, skip, fails, total }；回执文案交给 pullSummaryText。 */
  async function pullMany(jobs, opts) {
    const o = opts || {};
    const list = Array.isArray(jobs) ? jobs : [];
    const total = list.length;
    let ok = 0, kept = 0, busy = 0, cant = 0, skip = 0, done = 0;
    const fails = [];
    const wait = [];
    if (!total) return { ok, kept, busy, cant, skip, fails, total: 0 };
    for (const j of list) {
      let out = null;
      const st = pull(j.entry || j, {
        force: true,                 // 「自动存本机」没开也照存：这是用户当下点下去的
        cb: (err, r) => {
          done++;
          /* r.skip = 试过、超出本机镜像上限（连字节都没取回来），与真失败分开报 ——
             混成一堆「没成」的话，用户会以为该重试，而重来一次还是超大。 */
          if (err) { if (r && r.skip) skip++; else fails.push(String(j.name || '这一条') + '：' + err.message); }
          else if (r && r.kept) kept++;
          else if (r && r.id) {
            ok++;
            if (typeof j.apply === 'function') {
              try { j.apply(Api.assetSrc(r.id)); } catch (e) {}
            }
          }
          if (o.onProgress) o.onProgress(done, total);
          if (out) out();
        },
      });
      /* pull 的返回值只说「这一条排上了没有」；排上了之后成没成要等 cb。
         'saved' 那一路的 cb 是同步回来的，所以 done/kept 已经加过，这里不再补。 */
      if (st === 'queued') wait.push(new Promise(rz => { out = rz; }));
      else if (st === 'busy') { busy++; done++; if (o.onProgress) o.onProgress(done, total); }
      else if (!st) { cant++; done++; if (o.onProgress) o.onProgress(done, total); }
    }
    await Promise.all(wait);
    return { ok, kept, busy, cant, skip, fails, total };
  }
  /* 那一句回执也只有一份：三处以前各拼一遍，措辞与顺序都不一样
     （收藏写「已存回本机 N 条」、素材库写「N 个已存回本机」），
     而它们说的是同一件事。 */
  function pullSummaryText(s) {
    const r = s || {};
    const bits = [];
    if (r.ok) bits.push('已存回本机 ' + r.ok + ' 条');
    if (r.kept) bits.push('本机早就有 ' + r.kept + ' 条');
    if (r.busy) bits.push('后台那一轮正在存 ' + r.busy + ' 条，没重复排');
    if (r.skip) bits.push('有 ' + r.skip + ' 条比本机镜像的上限还大，没存');
    if (r.cant) bits.push('有 ' + r.cant + ' 条手上只剩转发地址、取不到原始外链，没法存');
    if (r.fails && r.fails.length) bits.push('有 ' + r.fails.length + ' 条没成：' + r.fails.slice(0, 2).join('；') + (r.fails.length > 2 ? ' 等' : ''));
    return bits.join(' · ');
  }
  /* ---------- 那颗「存回本机」按钮：在途旗标、画法、回执各只有一份 ----------
     四页（生成工作台 / 资产库 / 收藏 / 素材库）以前各抄一遍这三件事，抄出两处真缺陷：
       · 生成工作台的守卫只看了 dataset.busy、没看成「在途时整颗不要重画」，
         而右栏每 3 秒随整列重建一次 —— 按钮上「存回本机 7 / 20」会被冲回没有进度那一版，看着像没在动；
       · 收藏那一句回执少判 `s.skip` —— 全是「比本机镜像上限还大」时 ok 为 0 也照样走绿档。
     在途旗标只记在按钮自己身上：素材库那颗以前另立一个局部变量记同一件事，
     于是重画守卫与「再点一次」的闸门读的不是同一个数。 */
  function pullBusy(b) { return !!b && b.dataset.busy === '1'; }
  function pullStart(b) { if (b) { b.disabled = true; b.dataset.busy = '1'; } }
  function pullEnd(b) { if (b) { b.disabled = false; b.dataset.busy = ''; } }
  /* 按「此刻这一屏还差几条」现画。数字与图标都是现算的 —— 初始化时写死一次的版本
     筛完、搜完、存完都还挂着最初那个数（表现正是「按钮没反应」）。
     `o.icon === false` 给素材库那种纯文字磁贴；`o.busyText` 给「进度写到底栏」的那一页。 */
  function pullBtn(b, n, o) {
    if (!b) return;
    const opts = o || {};
    const cnt = Math.max(0, Number(n) || 0);
    if (pullBusy(b)) {
      b.disabled = true;
      if (opts.busyText) b.textContent = opts.busyText;
      return;
    }
    const txt = (opts.label || '存回本机') + (cnt ? '（' + cnt + '）' : '');
    if (opts.icon === false) b.textContent = txt;
    else b.innerHTML = '<span class="ic">' + (window.icon ? window.icon('box', 13) : '')
      + '</span> <span class="tx">' + txt + '</span>';
    if (opts.disableEmpty) b.disabled = !cnt;
    b.title = pullBtnTitle(cnt, opts);
  }
  /* title 那两句也只有一份说法：范围（这一屏 / 这一档）、名词（产物 / 收藏 / 素材）、
     量词由页面给，其余不改 —— 四页以前把「外链一过期就是破图」写成了四种。 */
  function pullBtnTitle(n, o) {
    const opts = o || {};
    const zone = opts.zone || '这一屏';
    const what = opts.what || '产物';
    if (!n) return opts.empty || (zone + '的' + what + '本机都已经有了，不用再存');
    return zone + '有 ' + n + ' ' + (opts.unit || '条') + what
      + '的字节还不在本机（外链一过期就是破图，预览也取不到帧）：逐条取回本机资产库，'
      + '过了这一趟「优先用本机文件」就有东西可用。已经在本机的一条都不会重下。'
      + (opts.more || '');
  }
  /* 三档回执（红 / 绿 / 灰）同一把尺子：一条都没落地就不能报绿。
     `o.extra` 是页面自己那一笔（素材库「有 N 条没写进库」），`o.failed` 是它对应的计数。 */
  function pullReceipt(s, o) {
    const opts = o || {};
    const text = [pullSummaryText(s)].concat(opts.extra || []).filter(Boolean).join(' · ');
    if (window.Toast) {
      if (s.fails.length || s.cant || s.skip || opts.failed) Toast.err(text || (opts.none || '一条都没存进本机'));
      /* 存成功 = 数据真的变了，走回执档（安静档不能把它吞掉：那样这颗按钮看着就是「点了没反应」）；
         一条都没动 = 「你点了但事实没发生」，走必定显示的 warn。 */
      else if (s.ok) Toast.receipt(text);
      else Toast.warn(text || (opts.nothing || '这一屏没有需要存的'));
    }
    return text;
  }
  /* 扫一批条目（列表加载、增量加载都走它） */
  /* 「这一条能从哪儿取到字节」—— **地址来源只有这一份**。
     以前 scan 只认 `e.rawSrc`，于是只有「外链产物」那一族排得上镜像；
     「平台返回产物 id」那一族（src=/asset/<id>、dl=/asset/<id>?dl=1）没有 rawSrc，
     表现为「自动存本机开了也没用」—— 这是这一整个功能最常见的失效形态。
     认全四种（外链 / 上游 / url / dl），dl 排在最后：它是「取字节」那一路，
     外链那一路更适合认身份（keyOf 用的是 upstream，不是 dl）。 */
  function byteSrcOf(e) {
    if (!e) return '';
    for (const u of [e.rawSrc, e.upstreamSrc, e.url, e.dl, e.src]) {
      const s = String(u || '');
      /* 本机资产库那一份自己有字节了，别再存一遍（decorate 会打 localAsset，
         但它可能在 scan 之后才跑 —— 这里再判一次 `queued`，两头都挡住）。 */
      if (/^https?:/i.test(s)) return s;
      if (/^\/(?:asset|getv|fetch|local-assets)\b/.test(s) && s.indexOf('?dl=1') >= 0) return s;
      if (/^\/asset\//.test(s)) return s.replace(/\?.*$/, '') + '?dl=1';
    }
    return '';
  }
  function scan(entries) {
    if (!saveOn()) return;
    (Array.isArray(entries) ? entries : [entries]).forEach(e => {
      if (!e) return;
      /* 状态：列表接口的产物行常不带 status（按成事处理），任务行缺 status 是「还不知道」
         —— 后者由 kind 那一关挡掉了（kind!=='asset'）。所以 status 为空即可视为已完成。 */
      const st = String(e.status || '');
      if (st && st !== 'done' && st !== 'succeeded') return;
      /* 「该不该存」只问wantSave 一处（它管着「补不补历史」那一档），
         这一页不要自己再判一遍「是不是历史产物」。 */
      if (!wantSave(e)) return;
      offer(e.provider, e, byteSrcOf(e));
    });
  }

  /* ---------- 「生成完成」这条事件的唯一生产处（报告 §6.2「事件契约靠字符串」） ----------
     以前 engine.js / studio.js / assetlib._announce / canvas/gen.announce 四处各自 dispatch，四份
     字段集合互不相同（导演台带 priceMicros、工作台不带；一家写 `src`、一家写 `url`），消费方只能
     逐字段可选容错，加一个字段就要改四个地方。现在四个生产点都只调 announce()，四条归一化规则
     各写在它自己那一行上（补齐但不凭空造 / 六个派生字段一条规则 / 本机导入与没地址的不投 /
     同一批按 keyOf 折一次）。三种生产者形状的对拍与「缺 kind 就不许下单」判在
     tests/e2e/ui-contract.cjs ③ —— 纯 Node 那半边只能判委托，归一化对不对要有真 AssetLocal 才验得到。 */
  /* 补的只许是「空」，一个都不许造：`kind` 留空 = wantSave 把这一条挡在下载之外（替它填 'asset'
     等于替用户决定「这是产物，去下一遍」）；三个时刻留空 = 走「一个时刻都没有 → 一律放行」那一档。 */
  const ANNOUNCE_SHAPE = {
    kind: '', provider: '', providerName: '', assetId: '', genId: '', id: '',
    type: '', format: '', status: '', src: '', rawSrc: '', url: '', dl: '',
    /* `name` 是**不带扩展名**的显示名（导演台给「场景01-…_镜头03-…_候选2」）。
       索引名、另存文件名与 FCPXML 媒体包名都读它；空着就回落到提示词前缀（历史行为）。 */
    name: '', prompt: '', model: '', tier: '', res: '', ar: '',
    duration: null, credits: null, priceMicros: null, currency: '', priceText: '',
    gstatus: '', created: '', completed: '', ts: '', localAsset: '',
  };
  const str = v => (v == null ? '' : String(v));
  function announceOne(e) {
    if (!e || typeof e !== 'object') return null;
    /* 先按生产者的原样合一份（额外字段照旧带着走，归一化不该把谁多写的东西弄丢），
       再把显式 `undefined` 补成默认值 —— 缺省与「明确没有」在这一层是同一件事。 */
    const n = Object.assign({}, ANNOUNCE_SHAPE, e);
    for (const k of Object.keys(ANNOUNCE_SHAPE)) if (n[k] === undefined) n[k] = ANNOUNCE_SHAPE[k];
    n.src = str(n.src || n.url);
    if (!n.src) return null;                                  // 没有地址 = 取不到字节，不投
    const isHttp = /^https?:/i.test(n.src);
    n.assetId = str(n.assetId) || (/^\/asset\/([A-Za-z0-9_-]+)/.exec(n.src) || [])[1] || '';
    n.genId = str(n.genId) || str(n.taskId);
    n.id = str(n.id) || n.genId || n.assetId;
    n.rawSrc = str(n.rawSrc) || str(n.raw) || (isHttp ? n.src : '');
    n.dl = str(n.dl) || (isHttp ? '' : n.src);
    n.url = str(n.url);
    /* 别名折完就删：`taskId` / `raw` 与 `genId` / `rawSrc` 是同一件事的两种写法，带着走等于一份事实
       两个出处（offer 那一路照旧读 `genId || taskId`，哪一份新哪一份旧没人说得清）。
       生产者自己多写的别的字段照旧留着 —— 归一化不该把谁多写的东西弄丢。 */
    delete n.taskId;
    delete n.raw;
    /* 本机导入不参与（这一条从前只有导演台与工作台两处判，判据却完全是同一件事） */
    if (/^la_/.test(n.assetId) || /^\/asset\/la_/.test(n.src)) return null;
    return n;
  }
  function announce(entries) {
    const list = (Array.isArray(entries) ? entries : [entries]);
    const out = [], seen = new Set();
    for (const raw of list) {
      const n = announceOne(raw);
      if (!n) continue;
      const k = keyOf(n.provider, { assetId: n.assetId, genId: n.genId, upstream: n.rawSrc || n.url });
      const dedupe = k || (n.provider + '|' + n.src);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(n);
    }
    if (!out.length) return 0;
    try { window.dispatchEvent(new CustomEvent('wb:asset-done', { detail: { entries: out } })); } catch (e) { /* 投不出去也别把生成回执带倒 */ }
    return out.length;
  }

  /* ---------- 从服务端那份索引**认回**镜像身份 ----------
     本机资产库的列表行自己就带着来源外链与任务号，所以浏览器里那份 `sk_local_mirror` 丢了
     （换端口 = 换源、清浏览器数据、无痕窗口）也不必把几百份产物重新下载一遍。
     为什么必须在代理那一份列表里认：磁盘上「同一份产物存了几次」是代理的事，
     浏览器每个源各记各的键，挡不住另一个源（另一个端口）把同一份再存一遍。
     只补索引里没有的键，已有的原样留着（它记的是最近一次真镜像）。
     键的算法与 offer/decorate **完全同一个表达式** —— 换成别的就是第二份判据，
     会出现「认回来的键与卡片算的键对不上」，表现还是「同一个任务重复出现」。 */
  /* 本次列表里**已经见过**的本机号。用途只有一个：认出「指针表指向的那份已经不在了」。
     它是**内存**的（页面一开就空），所以不需要清理，也不会在多标签页之间打架。 */
  const liveSeen = new Set();
  function learn(raw) {
    if (!saveOn() || !raw) return;
    const id = String(raw.id || '');
    if (!/^la_/.test(id)) return;
    liveSeen.add(id);
    const up = String(raw.upstream || '');
    const d = read();
    const det = (raw.detail && typeof raw.detail === 'object') ? raw.detail : null;
    /* 平台产物号 > 任务号 > 来源地址（与 keyOf 同一优先级）。老镜像的 detail 里没有
       `asset`（那时落盘只留了任务号），所以下面还留了「按任务号只出一份」的兜底，
       但**绝不**把「任务号」直接当成多图任务的身份 —— 那会把四张图并成一张。 */
    const platAsset = String((det && det.asset) || '');
    const task = String((det && det.task) || '');
    const k = keyOf(String(raw.provider || ''), { assetId: platAsset, genId: task, upstream: up });
    const patch = rec => {
      let ch = false;
      if (platAsset && String(rec.p || '') !== platAsset) { rec.p = platAsset; ch = true; }
      if (task && String(rec.g || '') !== task) { rec.g = task; ch = true; }
      if (up && String(rec.up || '') !== up) { rec.up = up; ch = true; }
      return ch;
    };
    /* ---------- 改指：指针表指的那份已经不在本机资产库里了 ----------
       指针表是**只补不改**的（下面那句「只补索引里没有的键」），所以它永远不会自己修。
       什么时候会指到一个死号？代理裁过索引（删掉同一份产物的重复副本）、用户删过本机副本、
       或从另一台机器同步来一份旧指针。一旦指死了，卡片就一直去问一个查无此号的
       /asset/<本机号>，拿到 422/404 之后靠 onMediaError 退到外链**重新下载** ——
       而本机那份明明还在。实测裁掉 207 条重复索引后，一屏就冒出十几个 422。

       判据：同一个键已有指针，而那个号**不在本机这次列出来的本机号里** → 改指到当前这条。
       代理的 /local-assets 已经按身份折过重，一份产物只出一行，所以当前这条就是权威的。
       `!d.a[id]` 这个前提别去掉：它保证当前这个号没绑在别的键上（绑了就该让旧的那条说了算）。

       **这一段必须排在 `if (d.a[id]) return;` 之前** —— 第一版放在后面，
       而被裁掉的那些号在 d.a 里全都还在，于是每次都先命中那句 return，
       改写代码一行都执行不到：症状是「自愈加了、422 一条没少」。 */
    const old = (k && d.m[k]) ? d.m[k].a : '';
    if (k && old && old !== id && !d.a[id] && !liveSeen.has(old)) {
      const rec = d.m[k];
      Object.assign(rec, {
        a: id, f: String(raw.format || '') || rec.f,
        n: String(raw.name || '') || rec.n,
        b: Number(raw.byte_length || 0) || rec.b,
        up: up || rec.up,
      });
      patch(rec);
      if (d.a[old] === k) delete d.a[old];
      d.a[id] = k;
      if (idxMaps) delete idxMaps.la[old];
      noteRecMaps(rec, k);
      queueWrite();
      return;
    }
    /* **先看这个本机号是不是已经绑过身份** —— 绑过就别再来一遍。
       踩过：`d.a[<本机号>]` 已经指向平台那条的身份（`prov|g:job_1`，offer 落盘时写的），
       而本机列表这一行自己算不出任何身份，于是又给它建了一个 `prov|f:la_xxx`，
       把 `d.a[la_xxx]` 覆盖掉了 —— 同一份东西在索引里就有了两个键：
       平台那条算出 g:job_1、本机那条算出 f:la_xxx，twinOf 合不到一起
       （表现：同一个视频两张卡、提示词只有一半有、去重那几档全红）。
       「一个本机号只能有一个身份」是这张表的全部意义，已有的那一条更权威（它带着平台信息）。 */
    if (d.a[id]) {
      const key = d.a[id], rec = d.m[key];
      if (!rec) { delete d.a[id]; }
      else {
        /* 老记录当年没有任何身份（`|f:`），现在平台列表把产物号带回来了 → 搬到 `|a:`。
           不搬的话，平台那条永远认不回这份本机副本（卡片重复、预览没有、
           「不显示云端任务」还会把它藏掉）。目标键已被占着就不动，保住先到的那份。 */
        const want = platAsset ? (String(raw.provider || '') + '|a:' + platAsset) : '';
        if (want && key !== want && /\|f:/.test(key) && !d.m[want]) {
          delete d.m[key];
          d.m[want] = rec;
          d.a[id] = want;
          patch(rec);
          idxMaps = null;              // 换键很罕见，整表重建一次比手工维护四张反查表可靠
          queueWrite();
          return;
        }
        if (patch(rec)) { noteRecMaps(rec, key); queueWrite(); }
        return;
      }
    }
    if (k && d.m[k]) {
      /* 同一个键已经被另一份本机文件占了。`|g:` 只会在「多图任务共用一个任务号」时撞；
         这条文件必须有自己的唯一身份，否则它永远进不了索引（删不掉、认不回、
         抽帧键也算不出来）—— 这就是当年「四张图只有一张有本机副本」的来路。
         `|a:` / `|u:` 撞上说明代理没去重成功，保留先到的那份，不覆盖。 */
      if (!/\|g:/.test(k)) return;
      const fk = String(raw.provider || '') + '|f:' + id;
      if (d.m[fk]) return;
      d.m[fk] = { a: id, f: String(raw.format || ''), n: String(raw.name || ''), t: 0,
        b: Number(raw.byte_length || 0), up, p: platAsset, g: task };
      d.a[id] = fk;
      noteRecMaps(d.m[fk], fk);
      queueWrite();
      return;
    }
    /* 三种身份一个都算不出来时（既没有产物号/任务号、也没有来源地址），
       这一条不是「镜像」而是**本机那个文件本身** —— 拿本机号当身份，命名空间 `|f:`
       （file），与 |a:/|g:/|u: 分开，免得和平台产物号撞在一个桶里。 */
    const key = k || (String(raw.provider || '') + '|f:' + id);
    if (d.m[key]) return;
    d.m[key] = { a: id, f: String(raw.format || ''), n: String(raw.name || ''), t: 0,
      b: Number(raw.byte_length || 0), up, p: platAsset, g: task };
    d.a[id] = key;
    /* 反查表要**当场**补上这一条，不能等下面那一次 write()：
       write 是排到微任务里去的，而调用方（normalize → pushEntry → emit）还在同一个同步块里，
       它马上就要按 la 号 / 按外链反查这一条 —— 表还是旧的那一份就查不到，
       于是「刚认回来的镜像」在同批里等于没认：早到的平台条目不换本机地址（预览图没有）、
       两条卡片也塌不到一起（同一个任务重复出现），非要等下一次加载才好。 */
    noteRecMaps(d.m[key], key);
    queueWrite();
  }

  /* 给一条**刚解析出来的条目**挂上本机镜像信息，并把 src 换成该用的那个（第一级回退）。
     在 AssetLib.normalize 里对每个资产条目调一次 —— 全项目只有这一处产生条目，
     所以「哪些页面看得到本机副本」不需要各页自己接一遍。
     `opts.allowGen`：整表里数过「这个任务只出了一条产物」之后才为 true（见 mirrorOf）。
     **幂等**：缓存里已经换过地址的那条再跑一遍也会按当前开关重新算 ——
     否则「优先用本机文件」关掉之后，首屏缓存那一眼仍然读 /asset/<本机号>，
     而列表回来才换成平台地址，看着像「开关刚才没生效」。 */
  function decorate(e, opts) {
    if (!e || e.kind !== 'asset') return e;
    const up = e.rawSrc || '';
    if (up) e.upstreamSrc = mediaSrc(up);
    /* 本机资产库那一条（条目即资产）：它自己就是本机文件，不再找镜像。
       **只按 id 认** —— 地址可能是「平台那条被换成了 /asset/la_xxx」，拿地址当判据
       会把缓存里已经换过地址的平台条目也当成自产条目，删掉本机副本之后它就不肯退回平台地址了。 */
    const selfRow = e.localSelf
      || (e.localAsset && (LA_ID(e.assetId) || LA_ID(e.id) || (!e.assetId && LA_ID(e.genId))));
    if (selfRow) return e;
    const hit = mirrorOf(e, !!(opts && opts.allowGen));
    if (hit && hit.rec && hit.rec.a) {
      /* 换成本机地址之前把平台那份记下来：删掉本机副本之后要原样退回去，
         否则卡片会一直指着一个已删除的 /asset/la_xxx。 */
      if (!e.platSrc && e.src && !/^\/asset\/la_/.test(String(e.src)) && !/^blob:/.test(String(e.src))) e.platSrc = e.src;
      e.mirrorKey = hit.k;
      e.mirror = hit.rec;
      e.localAsset = true;                    // 界面上可以「删除」（删的是本机那份）
      if (e.byteLength == null && hit.rec.b) e.byteLength = hit.rec.b;
      if (preferLocal()) e.src = Api.assetSrc(hit.rec.a);
      else if (e.platSrc) e.src = e.platSrc;
      return e;
    }
    /* 索引里已经没有这一条了（用户刚删掉本机副本 / 浏览器数据被清）：
       把上一次换过的地址退回平台那份，并把「本机」标记摘掉。 */
    if (e.platSrc) e.src = e.platSrc;
    delete e.mirrorKey; delete e.mirror;
    delete e.localAsset;
    return e;
  }

  /* ---- 第三级：两边都没了 → 明写「已丢失」 ------------------------------------
     用**一个全局捕获阶段的 error 监听**装一次，不在各页各接一遍：
     error 不冒泡但能被 document 的捕获阶段截到，所以卡片、列表、灯箱、详情面板一次全覆盖。
     判据全部来自本机索引（element 的地址 → 索引键），不需要页面把条目传进来：
       · src 是 /asset/<本机号> 挂了 → 索引里那条记着 upstream → 换 /getv?url= 回源（第二级）
       · src 是平台外链挂了 → 索引里按地址键记着本机副本 → 换 /asset/<本机号>（第一级）
       · 两边都试过还挂 → 标 lost，插一个「已丢失」角标（而不是留一张裂图让人猜） */
  const LB = '文件已丢失（本机副本与平台地址都没了）';
  function lostTip(el) {
    if (el.parentElement && el.parentElement.querySelector('.lost-tip')) return;
    const s = document.createElement('span');
    s.className = 'lost-tip';
    s.textContent = '已丢失';
    s.title = LB;
    if (el.parentElement) el.parentElement.appendChild(s);
  }
  function onMediaError(e) {
    const el = e && e.target;
    if (!el || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return;
    if (el.dataset.fb === '1') { el.dataset.lost = '1'; el.style.visibility = 'hidden'; lostTip(el); return; }
    const d = read();
    const raw = String(el.getAttribute('src') || el.getAttribute('data-src') || '');
    const am = raw.match(/^\/asset\/([A-Za-z0-9_-]+)/);
    if (am && !/^\/asset\/local/.test(raw)) {
      /* 本机那份没了 → 找它是从哪个外链取回来的 */
      const rec = d.a[am[1]] ? d.m[d.a[am[1]]] : null;
      if (rec && rec.up) {
        el.dataset.fb = '1'; el.dataset.fbUp = rec.up;
        el.setAttribute('src', '/getv?url=' + encodeURIComponent(rec.up));
        try { el.load && el.load(); } catch (e2) {}
        return;
      }
    }
    const upKey = mediaKey(raw);
    const rec2 = upKey ? maps().up[upKey] : null;
    if (rec2 && rec2.a && raw.indexOf('/asset/' + rec2.a) < 0) {
      el.dataset.fb = '1'; el.dataset.fbLoc = rec2.a;
      el.setAttribute('src', Api.assetSrc(rec2.a));
      return;
    }
    el.dataset.fb = '1'; el.dataset.lost = '1';
    el.style.visibility = 'hidden';
    lostTip(el);
  }
  let watching = false;
  function watch() {
    if (watching || typeof document === 'undefined') return;
    watching = true;
    document.addEventListener('error', onMediaError, true);
    /* 别的标签页刚镜像完一份产物 → 本页那份内存里的索引要作废。
       不作废的话，「优先用本机文件」在生成页之外的标签里永远看不见新存的那一份
       （地址算出来还是过期外链 → 抽帧失败 → 预览图没有），要刷新整个页面才好。 */
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', e => {
        if (e && e.key === K_IDX) { idx = null; idxMaps = null; idxBoot = null; bootMirrorIndex(); }
        if (e && e.key === K_PENDING) pendCache = null;
        if (e && e.key === K_SAVE) {
          if (!saveOn()) {
            /* 关掉开关：排队中的（非手动 force）不再发；待镜像清单也清掉，
               避免下次开开关时把用户已经不想存的那批一次性补下来。 */
            const drop = queue.splice(0);
            drop.forEach(j => { if (!j.force) { queued.delete(j.k); INFOS.inFlight = Math.max(0, INFOS.inFlight - 1); } else queue.push(j); });
            pendWrite([]);
            infoChanged();
          } else replayPending();
        }
      });
      /* 生成完成的事件由**本模块的 announce()** 投（四个生产点都走那一条），这一份是唯一消费方：
         自动镜像不再依赖「恰好有个列表页在加载 AssetLib」。 */
      window.addEventListener('wb:asset-done', e => {
        const es = (e && e.detail && e.detail.entries) || [];
        if (Array.isArray(es) && es.length) { try { scan(es); } catch (err) { console.warn('[AssetLocal] 生成完成入库失败：', err); } }
      });
      window.addEventListener('wb:mirror-ready', () => { try { infoChanged(); } catch (e) {} });
    }
  }

  window.AssetLocal = {
    saveOn, preferLocal, showBadge, offer, scan, announce, decorate, watch, pullMany, pullSummaryText,
    /* 等镜像指针从 IndexedDB 读回来（列表加载前等一小会儿，避免首屏用暖启动缓存判漏）。 */
    ready: () => { read(); return bootMirrorIndex(); },
    pullBusy, pullStart, pullEnd, pullBtn, pullBtnTitle, pullReceipt,
    /* 「补不补历史产物」那一档 + 判据：页面与设置页都读它，不要自己按时间戳判一遍。 */
    saveScope, markSaveOn, wantSave, saveSince,
    /* 侧栏那两块各自显示与否（设置页勾）。判据各一份，sidebar.js 直接调。 */
    sbBalOn, sbMirrorOn,
    /* 「正在存 / 存成了几份 / 失败原因」—— 页面据此把「开了没反应」变成看得见的实况。
       onInfo 返回退订函数；info() 立刻给一份当前读数（订阅时也会回调一次）。 */
    info, onInfo,
    /* 「这条产物在本机有副本吗 / 这是哪一条的镜像」：地址层（mediaSrc）与列表层（去重）都读这两个，
       索引形状（m / a 两张表）只有本模块认识 */
    localCopyOf, twinOf, learn,
    /* 「这一条在本机镜像是哪一个资产号」：**不看开关**的身份查法（缩略图缓存键用它，
       见 workbench.js 的 thumbs.keyOf）—— 开关只管画面上用哪个地址，不能管「这是哪一份东西」。 */
    localAssetIdOf,
    /* FCPXML / 本地路径类出口用：地址 → { id, format, name, bytes }（不给路径）。 */
    localFileOf,
    /* 「本机 / 云端」的**唯一**判据（徽标、存回本机的范围、列表去重、助手的读数都读它）。
       页面不许自己拼 localAsset / hasLocalAddr / assetId —— 那三种形状各拼一遍，
       就会出现「卡片写着本机、存回本机却把它算进 N 条」这种自相矛盾的界面。 */
    hasLocal, hasCloud, stateOf,
    /* 给测试 / 诊断用：按同一份身份判据查镜像记录（返回 { k, rec } 或 null）。 */
    mirrorKeyOf: e => { const hit = mirrorOf(e, true); return hit ? hit.k : ''; },
    /* 「不显示云端任务」：一个开关的生效条件（localOnly）与它唯一的判据（hideAsCloud）。
       页面只许调这两个，不许自己拼「有没有本机副本」—— 见上面的 hasLocal / hasLocalAddr。 */
    localOnly, hideAsCloud, hasLocalAddr,
    /* 「现在就把这一条存回本机」—— 收藏 / 素材库那两颗「自动下载」用的入口。
       走的是后台自动镜像同一条落盘链（同一份索引、同一道去重、同一份按类型另存），
       区别只在绕过开关与逐条回执，见上面的 pull。 */
    pull,
    /* 「自动保存：按类型分别存到哪」这一项的公共接口（设置页渲染与本页分流共用一份判据）。
       设置页只负责画与存，不自己再读一遍 localStorage、更不自己判断哪一档开没开。 */
    SAVE_KINDS, autosaveConf, setAutosaveConf, kindOf, saveFails,
    /* 设置页「已存多少 / 占了多少」用：只算条数与字节，不列清单。
       ⚠ 这一份读的是**本地指针表**，换端口 / 清浏览器数据 / 无痕窗口都会是空的 ——
       所以下面那个 syncStats() 得先把代理那份索引拉回来认一遍，数字才等于事实。 */
    stats() {
      const rs = Object.values(read().m);
      return { count: rs.length, bytes: rs.reduce((a, r) => a + (Number(r && r.b) || 0), 0) };
    },
    /* 从**代理那份索引**（.assets/index.json）现算「本机存了多少」，顺带把指针表认回来。
       为什么必须有这一步：stats() 读的那张表是「哪条产物存在本机」的**缓存**，
       本体在 .assets/。表空的时候设置页会写「本机已存 0 个产物，共 0 KB」——
       而 .assets 里其实有 83 份（实测：无痕窗口打开设置页，磁盘上明明有，页面写 0）。
       界面说的话与事实不符，正是这一页最不能出的那种毛病。
       走注册表声明的 selfAsset 列表（`local:/local-assets`），不自己拼地址；
       每一行走 learn() —— 判据还是那一份，指针表当场认回来，
       同一页下面的「补存」也才有东西可补（mirrorIds 读的就是这张表）。 */
    async syncStats() {
      try { await bootMirrorIndex(); } catch (e) {}
      try {
        const reg = await Api.registry();
        const src = (reg.providers || []).find(p => p.list && p.list.selfAsset);
        if (src) {
          const d = await Api.request(src, 'list', { query: 'limit=1000' });
          const rows = (d && (d.data || d.items)) || [];
          for (const r of rows) learn(r);
        }
      } catch (e) { /* 代理没起来就照旧报本地那份数，不要在这一页抛错 */ }
      /* 返回的是 `info()` 那一份（不是 stats()）：设置页那一行还要读在途数与最后一次失败原因，
         两个形状各回各的就会出现「count 更新了、在途数永远是 undefined」。 */
      return info();
    },
    /* 「补存」用：本机资产库里有哪些、分别属于哪一类。
       判据是 kindOf（与镜像分流那一份同一处），**只给本机号** ——
       路径一律由代理从配置读，页面递不得（见 Api.saveLocal）。 */
    mirrorIds() {
      return Object.values(read().m)
        .filter(r => r && r.a)
        .map(r => ({ id: r.a, kind: kindOf(r.f, ''), bytes: Number(r.b) || 0 }));
    },
    /* 抹掉一条本机镜像的记录（用户点「删除本机文件」成功之后）。判据与实现都在 learn 那份旁边。 */
    forgetMirror,
    /* 这里原来还有一个 forget()：全站零调用，却能把整份索引 removeItem 掉。
       「关掉自动存本机」要清索引的话，正确做法是**让下一次 read() 自然重建**
       （learn 会按代理那份列表重新认回来，见上），而不是把用户的镜像记录整份删掉 ——
       一个零调用的接口配一个整份 removeItem，就是一个谁都能踩、踩了不可逆的地雷。已删。 */
  };
  watch();
  replayPending();
})();
