/* AssetLocal — 本机镜像：落盘身份、待存队列、自动存本机、状态判据（stateOf / hasLocal / hideAsCloud）。
   从 web/domain/assetlib.js 拆出；mediaKey / mediaSrc / classifyStatus 是 api.js 顶层的全局函数。 */
(function () {
  const K_SAVE = 'sk_media_local', K_PREFER = 'sk_media_prefer';
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
     `mode` 缺省读设置；传字符串是给探针留一个「不改设置也能问一遍」的口子。 */
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
  const CONCURRENCY = 2;                 // 同时最多镜像几个：一次性下十几个视频会把上行和磁盘都占满
  const on = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } };
  /* 「产物存本机」开关的唯一谓词。设置页、侧栏、镜像队列与资产库列表都只问这一枚：
     手抄一份 `localStorage.getItem('sk_media_local') !== 'off'` 就是第二套默认值 ——
     缺省那一边（没存过 = 开）漂了，表现是「界面说开着，队列一条不排」。 */
  function saveOn() { return on(K_SAVE, 'on') !== 'off'; }
  const preferLocal = () => on(K_PREFER, 'on') !== 'off';
  const showBadge = () => on(K_BADGE, 'on') !== 'off';
  /* 「只看本机有的」真生效的条件是三条都开着：没存本机就永远没有本机副本，
     不优先读本机就谈不上「只看本机」—— 只勾第三档时它**等于没勾**（设置页那一项也就不画）。 */
  const localOnly = () => saveOn() && preferLocal() && on(K_HIDE_CLOUD, '') === '1';

  /* 产物只有一份，就住在资产库根的类型子目录里，而那个根默认就是 下载\成像 —— 用户翻得到的地方。
     库根本身可以在设置页「本机资产库」那一格改，它不是浏览器里的偏好而是**代理要读的那份**，
     所以它走 `sk_local_dir`（localStorage → DataSync 镜像成 .data/sk_local_dir.json，
     代理的 localRoot() 现读），不在这里留第二份判据。 */

  /* ---------- 本机别名表（哪条产物在本机、对应哪个本机号）----------
     真相只有代理那一份账（.data/local-assets/）与库根里的字节。浏览器这一份是**当前会话的查表
     缓存**：开机向 GET /local-assets/aliases 要一份，列表加载时再用 POST /local-assets/locate
     补问没命中的那几条，落盘回执与本机资产库列表也会就地补行。
     不再有 localStorage / IndexedDB 副本：那份按源（端口）分家的指针表换端口、清站点数据、
     换机器就整份失效，表现是「库根里文件明明在、卡上写着已丢失」。
     行形状与代理 aliasRowOf 同一份：{ id, assetId, taskId, up, upstream, format, name, bytes,
     file, mediaType, createdAt }；`id` 是本机号 la_xxx，assetId / taskId 是平台身份。 */
  let rows = new Map();        // la 号 → 行
  let byAid = new Map();       // 平台产物号 → 行（同一个号多行时先到先得）
  let byTask = new Map();      // 平台任务号 → 行列表（多图任务一个号多份文件）
  let byUp = new Map();        // 来源地址剥签名后的键 → 行（先到先得）
  let readyAt = 0;             // 上一次成功取回别名表的时刻
  let readying = null;         // 在途的那一次取表：并发调用挂同一只
  const READY_TTL = 5000;      // 列表加载时最多沿用这么旧的表；超过就用新的一份
  const LA_ID = s => /^la_/.test(String(s || ''));
  /* 表有没有被**成功取回来过**：没有（离线 / 开机第一帧）时「表里查不到」不等于
     「本机没有」，这时仍按条目自己带的标记算；取回来之后账才是唯一真相 ——
     缓存里留着的上一天本机号（索引重建过 / 文件被删了）不再算「本机有」。 */
  const libraryKnown = () => readyAt > 0;
  /* 一条条目自己写着的本机号（la_xxx）：本机资产库那一条的 assetId / id，
     以及没有平台产物号时退回 genId 的那一族。 */
  function selfRowId(o) {
    if (!o) return '';
    const aid = String(o.assetId || '');
    if (LA_ID(aid)) return aid;
    if (LA_ID(o.id)) return String(o.id);
    if (!aid && LA_ID(o.genId)) return String(o.genId);
    return '';
  }

  function resetMaps() { byAid = new Map(); byTask = new Map(); byUp = new Map(); }
  function indexRow(row) {
    if (row.assetId && !byAid.has(row.assetId)) byAid.set(row.assetId, row);
    if (row.taskId) {
      const list = byTask.get(row.taskId);
      if (list) list.push(row); else byTask.set(row.taskId, [row]);
    }
    if (row.up && !byUp.has(row.up)) byUp.set(row.up, row);
  }
  function reindex() { resetMaps(); rows.forEach(indexRow); }
  /* 一行从哪儿来都走这里：别名快照、locate 回复、落盘回执、本机资产库列表。 */
  function rowOfServer(raw) {
    if (!raw) return null;
    const id = String(raw.id || '');
    if (!LA_ID(id)) return null;
    const d = (raw.detail && typeof raw.detail === 'object') ? raw.detail : null;
    const upstream = String(raw.upstream || '');
    const up = String(raw.up || (upstream && window.MediaId ? mediaKey(upstream) : ''));
    return {
      id,
      assetId: String(raw.assetId || (d && d.asset) || ''),
      taskId: String(raw.taskId || (d && d.task) || ''),
      up,
      upstream,
      format: String(raw.format || ''),
      name: String(raw.name || ''),
      bytes: Number(raw.byte_length) || 0,
      file: String(raw.file || ''),
      mediaType: String(raw.media_type || ''),
      createdAt: String(raw.created_at || (d && (d.created || d.completed)) || ''),
      at: Date.now(),
    };
  }
  function putRow(raw) {
    const row = rowOfServer(raw);
    if (!row) return null;
    const prev = rows.get(row.id);
    if (prev) {
      if (byAid.get(prev.assetId) === prev) byAid.delete(prev.assetId);
      if (byUp.get(prev.up) === prev) byUp.delete(prev.up);
      const list = prev.taskId ? byTask.get(prev.taskId) : null;
      if (list) {
        const i = list.indexOf(prev);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) byTask.delete(prev.taskId);
      }
    }
    rows.set(row.id, row);
    indexRow(row);
    return row;
  }
  function dropRow(id) {
    if (!rows.has(id)) return false;
    rows.delete(id);
    reindex();                 // 先到先得那两张表要补位，整表重排比逐个维护可靠
    return true;
  }
  /* 平台列表说了产物号 / 任务号，而本机这一行是磁盘对账补的裸行（两头都空）：
     在本次会话里把身份补上，后续按产物号就能直接命中。落盘那一份身份由代理在补存时写回。 */
  function adoptIdentity(row, assetId, taskId) {
    if (!row) return false;
    let ch = false;
    if (assetId && !row.assetId) { row.assetId = assetId; ch = true; }
    if (taskId && !row.taskId) { row.taskId = taskId; ch = true; }
    if (ch) reindex();
    return ch;
  }
  async function fetchAliases() {
    /* 请求发出前记时刻：这一段里才落盘的那几条不会被一份**早于它**的快照抹掉。 */
    const startedAt = Date.now();
    const d = await window.Net.json('/local-assets/aliases', { cache: 'no-store' });
    const list = (d && Array.isArray(d.rows)) ? d.rows : null;
    if (!list) throw new Error('本机别名表格式不对');
    const next = new Map();
    for (const raw of list) {
      const row = rowOfServer(raw);
      if (!row) continue;
      row.at = 0;              // 服务端来的行没有「本会话新落盘」的资格
      next.set(row.id, row);
    }
    rows.forEach((r, id) => { if (!next.has(id) && r.at >= startedAt) next.set(id, r); });
    rows = next;
    reindex();
    readyAt = Date.now();
    infoChanged();
    /* 快照就位：按住的那批自动 offer 现在才判得清「本机有没有」，当场判一遍。 */
    flushHeld();
  }
  /* 等别名表就位（并发调用共用同一只在途请求）。失败不抛：拿不到表只是「这一轮认不出本机副本」，
     列表照常显示；下一次 ready 再试。 */
  function ready(maxAge) {
    const ttl = maxAge == null ? READY_TTL : Math.max(0, Number(maxAge) || 0);
    if (readyAt && Date.now() - readyAt < ttl) return Promise.resolve();
    if (readying) return readying;
    if (!window.Net || typeof window.Net.json !== 'function') return Promise.resolve();
    readying = fetchAliases().catch(() => {}).then(() => { readying = null; });
    return readying;
  }
  /* 一次问一批「这几条平台产物在本机是哪一份」。返回与 items 同下标的行数组（没命中是 null）。 */
  async function locateRows(items) {
    const list = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, 2000);
    if (!list.length || !window.Net || typeof window.Net.json !== 'function') return list.map(() => null);
    let d = null;
    try {
      d = await window.Net.json('/local-assets/locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: list }),
      });
    } catch (e) { return list.map(() => null); }
    const out = (d && Array.isArray(d.rows)) ? d.rows : [];
    return list.map((_, i) => (out[i] ? putRow(out[i]) : null));
  }
  /* 列表进界面前把这一批里还没命中的条目问一遍服务端，再按结果重新 decorate。
     allowGen 取**条目自己声明的出图份数**（outCount === 1）：多图任务只镜像了一份时，
     按任务号认会把四张卡一起指到那一个文件上。 */
  async function locate(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const todo = [];
    for (const e of list) {
      if (!e || e.kind !== 'asset') continue;
      if (e.localSelf || LA_ID(e.assetId) || LA_ID(e.id)) continue;
      const allowGen = Number(e.outCount) === 1;
      if (rowOfEntry(e, allowGen)) continue;
      const assetId = String(e.assetId || '');
      const taskId = String(e.genId || e.taskId || '');
      const url = String(e.rawSrc || e.upstreamSrc || '');
      if (!assetId && !taskId && !url) continue;
      todo.push({ e, allowGen, item: { assetId, taskId, url, allowGen } });
    }
    if (!todo.length) return 0;
    const got = await locateRows(todo.map(x => x.item));
    let n = 0;
    got.forEach((row, i) => {
      if (!row) return;
      decorate(todo[i].e, { allowGen: todo[i].allowGen });
      n++;
    });
    return n;
  }

  /* 「这一条对应本机哪一份文件」—— **全项目只有这一份身份判据**。
     decorate / twinOf / hasLocal / 列表合卡都走它，页面不许自己拼 provider+id。
     按可靠度依次试：平台产物号 → 任务号（只有**表里这个任务恰好只有一份本机文件**时才许用，
     多图任务按任务号合会把四张并成一张）→ 本机号 → 地址（/asset/la_xxx、剥签名的上游地址）。
     `allowGen` 由调用方给：decorate 只在条目自己声明 outCount === 1 时为 true；
     twinOf 一律不给 ——「合卡」比「换地址」更需要保守。 */
  function rowOfEntry(e, allowGen) {
    if (!e) return null;
    const aid = String(e.assetId || '');
    if (aid && !LA_ID(aid)) {
      const row = byAid.get(aid);
      if (row) return row;
    }
    if (allowGen) {
      const tid = String(e.genId || e.taskId || '');
      const list = tid ? byTask.get(tid) : null;
      if (list && list.length === 1) return list[0];
    }
    const self = LA_ID(aid) ? aid : (LA_ID(e.id) ? String(e.id) : '');
    if (self) {
      const row = rows.get(self);
      if (row) return row;
    }
    for (const u of [e.rawSrc, e.upstreamSrc, e.raw, e.url, e.dl, e.src, e.media]) {
      const la = laOfAddr(u);
      if (la) {
        const row = rows.get(la);
        if (row) return row;
      }
      const k = mediaKey(u);
      if (k) {
        const row = byUp.get(k);
        if (row) return row;
      }
    }
    return null;
  }
  /* `/asset/<号>` 这个地址写的是哪一份本机文件：la_ 就是本机号；平台产物号（或任务号）按表反查。
     任务号只认「恰好一份」—— 与 rowOfEntry 同一条保守规则。
     ⚠ la_ 那一支也要查表（表取回来之后）：索引重建 / 文件被删之后，缓存与收藏里还留着
     `/asset/la_xxx`，认得它就会把一条早已没有字节的东西标成「本机」。 */
  function laOfAddr(u) {
    const s = String(u == null ? '' : u);
    const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(s);
    if (!m) return '';
    if (LA_ID(m[1])) return !libraryKnown() || rows.has(m[1]) ? m[1] : '';
    const row = byAid.get(m[1]);
    if (row) return row.id;
    const list = byTask.get(m[1]);
    return list && list.length === 1 ? list[0].id : '';
  }
  /* 有本机副本时给本机地址（没开「优先用本机文件」/ 查不到都返回空串）。
     代理那一级在本机文件不在时会按账里的来源地址回源，界面上的 error 监听再兜一层。 */
  function localCopyOf(u) {
    if (!preferLocal()) return '';
    const la = localAssetIdOf(u);
    return la ? Api.assetSrc(la) : '';
  }
  /* 这条地址对应**本机那一份的资产号**，不看「优先用本机文件」开关。
     开关决定的是「画面上用哪个地址」，不是「这是哪一份东西」—— 所以凡是「同一份产物」的判据
     （缩略图缓存键、列表合并、跨页去重）都必须走这一份而不是上面那个。
     键跟着开关走的话，关掉开关后同一个视频在缓存里成了两份 —— 抽两次帧、存两份小图。 */
  function localAssetIdOf(u) {
    const s = String(u == null ? '' : u);
    if (!s) return '';
    const la = laOfAddr(s);
    if (la) return la;
    const k = mediaKey(s);                     // mediaKey 自己会拆 /getv 包装（判据只有一份）
    if (!k) return '';
    const row = byUp.get(k);
    return row ? row.id : '';
  }
  /* 「这一条地址对应的本机文件长什么样」：给 FCPXML 这种要**磁盘路径**的出口用。
     `path` 是账里相对库根的落点；账行没有这一项时是空串，调用方按「不知道路径」处理。 */
  function localFileOf(u) {
    const id = localAssetIdOf(u);
    if (!id) return null;
    const row = rows.get(id);
    return { id, format: String((row && row.format) || ''), name: String((row && row.name) || ''),
      bytes: Number((row && row.bytes) || 0), path: String((row && row.file) || '') };
  }
  /* 一条产物在本机别名表里的身份（合卡键）。**平台列表那一条**由 decorate 挂上 mirrorKey；
     **本机资产库那一条**（条目即资产，id 就是 la_xxx）自己就是一份文件，身份就是本机号。
     收藏 / 工作区里那条既没有 mirrorKey、又不是 la_xxx 的：按产物号 / 地址现算，
     **只在表里确有那一行时**才算数 —— 没有副本的产物各按各的 id 判，不多合并任何东西。
     这里刻意不按任务号认：多图任务的一张产物被当成整条任务的镜像，四张卡会指向同一个文件。 */
  function twinOf(e) {
    if (!e) return '';
    /* 镜像标记也要对账：缓存里留着上一天的 `la:la_xxx`（索引重建 / 文件被删之后），
       当它还算同一份的话，一条打不开的旧卡会跟平台那条并成一张，地址也换不回来。 */
    if (e.mirrorKey) {
      const id = String(e.mirrorKey).replace(/^la:/, '');
      if (!libraryKnown() || rows.has(id)) return e.mirrorKey;
    }
    if (e.localSelf || LA_ID(e.assetId) || LA_ID(e.id)) {
      const id = LA_ID(e.assetId) ? String(e.assetId) : String(e.id || '');
      if (LA_ID(id) && (!libraryKnown() || rows.has(id))) return 'la:' + id;
    }
    const row = rowOfEntry(e, false);
    return row ? 'la:' + row.id : '';
  }

  /* 一条东西在排队表上的身份，**条目与卡片两种形状算得出同一个**（卡片的 `taskId` = 条目的 `genId`，
     卡片还多一个 `raw`）。与 offer / hideAsCloud / pullPlan 那三处同一个表达式 —— 换一套就会出现
     「卡片说在队列里、表里说没存过」，藏与不藏就全凭运气。 */
  function keyFor(o) {
    const p = String((o && o.provider) || '');
    if (o && o.assetId && !LA_ID(o.assetId)) return p + '|a:' + o.assetId;
    const g = String((o && (o.genId || o.taskId)) || '');
    if (g && !LA_ID(g)) return p + '|g:' + g;
    const u = o && (o.rawSrc || o.upstreamSrc || o.raw || o.url);
    const k = u ? mediaKey(String(u)) : '';
    return k ? p + '|u:' + k : '';
  }
  /* 这一条在本机到底有没有字节。**判据只在这一处**，页面不许自己拼 `localAsset` / `mirrorKey` /
     `/asset/` 前缀 —— 那几样分属「decorate 挂上的」「本机资产库那条」「平台列表那一条」三种形状，
     自己拼一定会漏一种。 */
  function hasLocal(o) {
    if (!o) return false;
    if (o.local || o.fromLocal || o.kind === 'local') return true;
    /* 「本机」标记（decorate 挂的 / 本机资产库那条 / 本地任务记录）在表取回来之后要问账：
       缓存里可能留着上一天的本机标记，索引重建 / 文件被删之后它就成了假话 ——
       卡片写着「本机+云端」、点开却是 404。 */
    if (o.localAsset || o.localSelf || o.mirrorKey || o.mirror) {
      if (!libraryKnown()) return true;
      const ids = [];
      if (o.mirrorKey) ids.push(String(o.mirrorKey).replace(/^la:/, ''));
      if (o.mirror && o.mirror.a) ids.push(String(o.mirror.a));
      const self = selfRowId(o);
      if (self) ids.push(self);
      if (ids.some(id => LA_ID(id) && rows.has(id))) return true;
    }
    if (twinOf(o)) return true;
    /* 地址本身就写着本机文件号（`/asset/la_xxx`）也算 —— laOfAddr 会按表核对，
       表还没取回来时照旧认（离线也要能看自己库里的东西）。
       `media` 是工作台卡片上的地址字段（同一个东西的另一个名字）。 */
    return !!(localAssetIdOf(o.src) || localAssetIdOf(o.rawSrc) || localAssetIdOf(o.dl) || localAssetIdOf(o.media));
  }
  /* 这一条在平台那边存不存在（能不能再从云端取回来）。
     与 hasLocal 分开：本机自产（MiMo 语音、本地上传）只有本机这一份，平台没有可回源的产物；
     而「平台列表那一条 + 本机镜像」两边都有 —— 徽标要写「本机+云端」而不是任选一个。 */
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

  /* 名字怎么洗归公共那一份（`ui.js` 的 `fileSafe`）。这一处以前自己写了第二份非法字符正则，
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
  /* `dlName` 是**当前占着这一格的那一份叫什么**（用户要看到的不只是「N 份在途」，
     还要知道是哪一个文件卡住了这一轮）。字节是代理取的，浏览器这一侧没有进度可读，
     所以这里只有名字、没有百分比。
     `dlot` 是**占着这一格的是哪一份**（runOne 里那个 k）：并发两份时只摆一个名字，
     不写它就会出现两个文件抢同一行、两个名字互相覆盖。 */
  const INFOS = { inFlight: 0, ok: 0, fail: 0, lastErr: '', lastAt: 0,
    dlot: '', dlName: '', listeners: new Set() };
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
  /* `queued` 里**含正在跑的那几项**（runOne 结束才 delete），`INFOS.inFlight` 也是它们 ——
     两数相加等于把每一份在途都数了两遍。取较大者：等待中的只在 queued 里，
     跑着的两处都有；哪个口径完整取决于「刚 offer 还没 pump」这一瞬，取 max 两边都不漏。 */
  let count = 0, bytes = 0;
  rows.forEach(r => { count++; bytes += Number(r.bytes) || 0; });
  /* `dead` = 本机存不下的那几条（跨会话记着，见 pendBump）；`deadWhy` 是最后一次的成因。
     侧栏把份数摆在行里、把成因放进 title —— 用户要的是「少了几份、为什么少」，不是日志。 */
  const dead = pendDead();
  return { inFlight: Math.max(INFOS.inFlight, queued.size), ok: INFOS.ok, fail: INFOS.fail,
    lastErr: INFOS.lastErr, lastAt: INFOS.lastAt, dlName: INFOS.dlName,
    count, bytes, dead: dead.length, deadWhy: String((dead[dead.length - 1] || {}).lastErr || ''), on: saveOn() };
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
      /* ---- 侧栏那行「正在下这一份 · 名字」的全部数据来源 ----
         取字节的是代理（`POST /local-assets/from-url` 边下边落盘），浏览器这一侧没有经过字节流，
         所以这一格只报得出「正在弄哪一份」，报不出百分比。
         CONCURRENCY=2 时两份同时在途，名字只摆一份：**先抢到的那份占着**，直到它落盘，
         免得那一行在两个文件之间来回跳（比只写个数更难读）；它完了另一份接手。 */
      const dlName = String((ent && (ent.prompt || ent.title)) || '').trim().slice(0, 24);
      const claimDl = () => {
        if (INFOS.dlot === k) return true;
        if (INFOS.dlot) return false;                 // 另一份正占着位置
        INFOS.dlot = k; INFOS.dlName = dlName;
        return true;
      };
      if (claimDl()) infoChanged();                   // 先把「正在存这一份（名字）」摆出来
      /* 留在账上的任务详情：只有身份与那笔费用，字节数由代理落盘时自己报（`byte_length`）。 */
      const detailOf = () => ent ? {
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
        promptLocal: !!(ent && ent.promptLocal),
      } : null;
      const metaBase = {
        prompt: (ent && ent.prompt) || '', model: (ent && ent.model) || '',
        provider: (ent && ent.provider) || '', credits: (ent && ent.credits) ?? null,
        priceText: (ent && ent.priceText) || '', duration: (ent && ent.duration) ?? null,
        upstream: url,
      };
      /* 只有一条通道：代理按地址把字节流式落盘（`POST /local-assets/from-url`）。
         浏览器不再「整段读进内存 → base64 → `POST /local-assets`」：那条链有 5× 内存放大
         （raw / utf8 串 / data / 解码结果），还受代理 288 MiB 请求体上限约束 —— 同一件事，
         代理自己取字节既没有上限也没有放大。
         排进队列的地址只有两种形状（`offer` 那三道闸）：http(s) 外链与同源代理路由，
         两种都由代理取得；`blob:` / `data:` 进不了队列，所以这里不必再按地址分支。 */
      /* 地址 pathname 上认得出的扩展名比「条目声明」大：平台把字幕 / 文本也挂成产物地址时，
         条目那份兜底的 format（缺省 mp4）会替它撒谎 —— 按地址真相送格式，服务端那道
         文档类闸（isDocExt）才拦得住，这份东西就不会进资产库。 */
      const urlExt = (() => {
        try {
          if (!/^(https?:|\/\/)/i.test(String(url || ''))) return '';
          return (new URL(url).pathname.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || '';
        } catch (e) { return ''; }
      })();
      const guessExt = urlExt
        || String((ent && ent.format) || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
        || (ent && window.isAudioType && isAudioType(ent.type) ? 'wav' : '')
        || (/\.(wav|mp3|m4a|aac|ogg|flac)(?:\?|$)/i.exec(String(url || '')) || [])[1]
        || 'mp4';
      let r = null;
      try {
        r = await Api.saveLocalFromUrl({
          url, name: nameOf(ent, guessExt), mime: '',
          format: urlExt || (ent && ent.format) || '',
          meta: Object.assign({}, metaBase, { detail: detailOf() }),
        });
      } finally {
        /* 这一跳由代理下载，浏览器这一侧没有字节流；一回来就把「正在下这一份」收掉
           （抛错也收），否则侧栏会一直停在上一份，另一个任务也抢不到这个位置。 */
        if (INFOS.dlot === k) { INFOS.dlot = ''; INFOS.dlName = ''; infoChanged(); }
      }
      if (r && r.id) {
        const size = Number(r.byte_length) || 0;
        /* 落盘回执本身就是一条账行（代理那次写入的结果）：直接收进别名表。
           代理返回 `reused` 时它给的是已经存在的那一条 —— 收进来同样对，本机号不会换。 */
        const row = putRow(Object.assign({}, r, {
          upstream: String(r.upstream || url),
          byte_length: size,
        }));
        queued.delete(k);          // 成功也要摘：留在在途表里下一轮就不会再 offer（那份已经存过了）
        pendDone(k);
        infoNote(true);
        /* 本机多了一份产物就说一声：别的页面那一张卡还挂在平台外链上（「已存本机」的标记、
           与本机那一条合成一张卡都靠重拉列表时的 decorate / 合表），不重拉就一直停在云端形态。 */
        try { if (window.Wb && Wb.busEmit) Wb.busEmit('local', { id: r.id, key: k, row }); } catch (e) {}
        tell(null, { id: r.id, size: size });
      } else {
        /* 代理收了请求却没给资产号 = 这份字节其实没落地，回执必须报失败，
           不然按钮说「已存好 N 条」而索引里一条都没有。 */
        throw new Error('代理没有返回资产号');
      }
      /* 到这里就结束了：**产物只有这一份**。
         以前镜像之后还要再按类型拷一份到用户指定的文件夹，实测一次生成写两遍同样的字节
         （359 份产物里 344 份字节完全相同），两份都躺在用户自己的盘上。
         库根现在就是用户翻得到的 下载\成像\，本体落 图片\ / 视频\ / 音频\ 并用可读的规范名 ——
         资产库、播放器、FCPXML 媒体包与用户自己开的那个文件夹是同一份文件，不再第二份。 */
    } catch (e) {
      /* 镜像失败**不打扰界面**：它是锦上添花，产物该显示还是显示。
         也不把失败写进索引 —— 下一轮列表刷新还会再 offer 一次（成功为止）。
         所以要把这一条从在途表里摘掉：以前失败的那一条永远留在表里，
         「再 offer 一次」根本不会发生，用户再点一次「自动下载」也是一颗死按钮。 */
      const err = e instanceof Error ? e : new Error(String(errText(e) || '存不进本机'));
      queued.delete(k);
      pendBump(k, err);
      infoNote(false, err);
      tell(err);
    } finally {
      /* 在途计数在 finally 里减：runOne 里的成功与抛错两条出口都要走它一次，
         而在这些出口上分别写一遍减法就会漏。 */
      INFOS.inFlight = Math.max(0, INFOS.inFlight - 1);
      infoChanged();
    }
  }

  const queued = new Set();
  /* ---------- 表还没取回来时按住的自动 offer ----------
     别名表是「本机有没有这一份」的唯一真相；表取回来之前一条都查不到。拿空表当「没存过」，
     开机那一屏几百条会全部排进镜像队列 —— 侧栏一路「正在存 N 份」，而绝大多数早就存过了。
     所以自动那一路（非 force）先按 k 按住，等快照到了再判；手动「存回本机」不经过这里
     （用户当下点下去的那一条要照常排队、照实回执）。 */
  const held = new Map();
  let heldRetryT = 0;
  function retryHeld() {
    if (heldRetryT || !held.size || libraryKnown()) return;
    heldRetryT = setTimeout(() => {
      heldRetryT = 0;
      /* 定时器排上之后快照可能自己就回来了（那一路已经 flush 过），别为此再问一次 */
      if (!held.size || libraryKnown()) return;
      ready(0).then(() => { if (!libraryKnown()) retryHeld(); });
    }, 10000);
  }
  function holdOffer(k, provId, ent, url, o) {
    if (held.has(k)) return;
    held.set(k, { provId, ent, url, o });
    retryHeld();
  }
  function flushHeld() {
    if (!held.size || !libraryKnown()) return;
    const list = [...held.values()];
    held.clear();
    for (const x of list) {
      try { offer(x.provId, x.ent, x.url, x.o); } catch (e) { /* 一条坏了不许挡住其余 */ }
    }
  }
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
      'priceText', 'chars', 'tokens', 'usage', 'gstatus', 'created', 'completed', 'promptLocal', 'byteLength',
      /* 回放时「按任务号认本机那一份」要靠它：只有声明一次出一份的条目才许按任务号认 */
      'outCount']
      .forEach(k => { if (ent[k] != null) out[k] = ent[k]; });
    return Object.assign(out, { kind: 'asset', status: 'done' });
  };
  function pendPut(k, url, ent, force) {
    if (!k || !url) return;
    const list = pendRead();
    const at = list.findIndex(x => x.k === k);
    const prev = at >= 0 ? list[at] : null;
    /* force = 用户当场按下的那颗「存回本机 / 自动下载」：tries 归零、死账一起清掉，
       这一条照实再试一次（清不掉的话 offer 在 dead 那一问就 return，按钮按下去一个字不回）。
       非 force 那一路走不到这里 —— offer 先在 dead 那一问拦住了。 */
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
  /* 清单里这一条的记录（没有 = 这一轮还没为它排过队）。 */
  function pendOf(k) { return k ? (pendRead().find(x => x.k === k) || null) : null; }
  /* 「本机存不下」的那几条（`dead`）：份数与最后一次的成因一起报给侧栏那一行。 */
  function pendDead() { return pendRead().filter(x => x.dead); }
  /* 一次失败：退避加倍；六次之后把这一条记成**死账留在清单里**（不再 splice 掉）。
     以前这里是 `splice` —— 条目从清单里消失，下次开机 `replayPending` 看不见它，`tries` 从 0 重来，
     一份真存不下的产物（上游清了 / 签名过期 / 代理取不动）于是每次开机都重排一遍：
     表现就是「明明没什么要存的，每次启动产物存本机都开张」。
     留着记录才是「跨会话别再自动试」；而它仍在这份清单里 = 仍算「本机还没有这一份」，
     不假装存好了，也不从「已存 N 份」的数字里偷偷少掉一份。 */
  function pendBump(k, err) {
    if (!k) return;
    const list = pendRead();
    const i = list.findIndex(x => x.k === k);
    if (i < 0) return;
    const rec = list[i];
    rec.tries = (rec.tries || 0) + 1;
    rec.lastErr = String(errText(err) || '存不进本机').slice(0, 160);
    if (rec.tries >= 6) { rec.dead = true; pendSkip.delete(k); pendWrite(list); return; }
    rec.nextAt = Date.now() + Math.min(10 * 60 * 1000, 15000 * Math.pow(2, rec.tries));
    pendSkip.set(k, rec.nextAt);
    pendWrite(list);
  }
  let pendReplayT = 0;
  function replayPending() {
    if (pendReplayT) return;
    pendReplayT = setTimeout(async () => {
      pendReplayT = 0;
      if (!saveOn()) return;
      /* 先等别名表：清单里几乎都是上一轮已经存过的条目，表没就位时「查不到」会被当成
         「没存过」，整份清单开机就重新排一遍。表这次取不回来也不丢 —— offer 会按住它们。 */
      await ready();
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
  /* 抹掉「这一份本机文件」在别名表里的那一行 —— 用户刚在资产库点「删除本机文件」之后调它。
     不抹的话卡片会一直去问一个查无此号的 /asset/<本机号>，拿到 422 之后又重新下载一遍。
     **只动别名表，不碰平台那份素材，也不把这条从列表里摘掉** —— 那是资产库页的事。
     参数收本机号、`la:` 合卡键、`{mirror:{a}}`、`{a}` 四种形状：调用点手上是哪一种都行。 */
  function forgetMirror(x) {
    const s = String((x && (x.a || (x.mirror && x.mirror.a))) || x || '');
    const id = s.replace(/^la:/, '');
    if (!LA_ID(id)) return false;
    return dropRow(id);
  }
  /* 提交一条产物去存本机（幂等：已存过 / 正在存 / 关掉了开关都直接跳过）。
     返回这一条的去向，页面据此说话：
       'saved' 索引里已经有了（或按来源地址认出同一条）· 'busy' 后台那一轮正在存
       'queued' 排上了 · 'held' 别名表还没取回来，先按住（表到了自动接回）
       'skip' 这一轮不该再自动试它（退避没到 / 已记成存不下的死账）
       '' 这一条存不了（开关没开、或手里根本没有一条取得到字节的地址）。
     opts.force：绕过「自动存本机」开关 —— 收藏与素材库那两颗「自动下载」是用户**当下点下去**的，
       开关没开就什么都不做等于一颗死按钮（别让一个「看着能点、其实什么都不做」的控件留在界面上）。
       它还绕过退避与死账：用户按了就照实再试一次。
     opts.cb(err, {id})：只对 force 那一批有意义（见 runOne 上的 tell），后台自动镜像照旧静默。 */
  function offer(provId, ent, upstream, opts) {
    const o = opts || {};
    if (!saveOn() && !o.force) return '';
    const raw0 = String(upstream || (ent && (ent.rawSrc || ent.raw)) || byteSrcOf(ent));
    /* 剥出内层外链再判协议：以前只收 https，于是「从收藏点自动下载」一条都排不上，
       而界面上一句回执都没有。
       **同源路由也要收**（/asset/<id>、/getv?url=…、/fetch?url=…&dl=1）：代理自己就能下这些，
       而「平台返回产物 id」那一族只有它们（见 byteSrcOf 的注释）——
       只收 https 时这一族永远排不上队列，「自动存本机」看起来就是没开张。
       这三条就是 `server/media-src.js` 的 `resolveSrc` 取得到字节的全部同源路由（代理里
       只有 `/local-assets` 那一族**不**发字节：它写账、列表与删，不供文件），闸门与它对齐。 */
    const isHttp = /^https?:/i.test(raw0);
    const isSameOrigin = /^\/(?:asset|getv|fetch)\b/.test(raw0);
    if (!isHttp && !isSameOrigin) return '';
    const url = isHttp ? raw0 : String(window.MediaId.innerMedia(raw0) || raw0);
    if (!/^https?:/i.test(url) && !/^\/(?:asset|getv|fetch)\b/.test(url)) return '';
    const k = keyFor({ provider: provId, assetId: ent && ent.assetId, genId: (ent && (ent.genId || ent.taskId)) || '', url });
    if (!k) return '';
    /* 表还没取回来：「本机有没有这一份」这一刻判不出来（表里查不到 ≠ 没存过）。
       自动那一路按住，等快照到了再判（见 holdOffer / flushHeld）；手动 force 不等。 */
    if (!o.force && !libraryKnown()) { holdOffer(k, provId, ent, url, o); return 'held'; }
    const platAsset = String((ent && ent.assetId) || '');
    const taskId = String((ent && (ent.genId || ent.taskId)) || '');
    /* 表里已经有这一份就别再下一遍（判据只有 rowOfEntry 一份：产物号 → 任务号（唯一）→ 地址）。
       按任务号那一路只在**条目自己声明只出一份**时才许用 —— 多图任务只镜像了一份时，
       按任务号认会把第二张也当成「已存过」而跳过。地址那一路补上「签名换了、路径没变」的情况。 */
    const saved = rowOfEntry(ent, Number(ent && ent.outCount) === 1)
      || (mediaKey(url) ? byUp.get(mediaKey(url)) : null);
    if (saved) {
      /* 这次才知道的产物号 / 任务号补到那一行上：下一轮按产物号就能直接命中。 */
      adoptIdentity(saved, platAsset, taskId);
      pendDone(k);
      if (o.cb) o.cb(null, { id: saved.id, kept: true });
      return 'saved';
    }
    /* 已经试过六次还没存成的那一份（死账）不再自动排 —— 判据与原因写在 pendBump 上。
       手动那一路（force）例外：pendPut 当场清掉死账、tries 归零，用户按下去就照实再试一次。 */
    const pend = pendOf(k);
    if (pend && pend.dead && !o.force) return 'skip';
    if (!o.force && (pendSkip.get(k) || 0) > Date.now()) return 'skip';
    if (queued.has(k)) return 'busy';
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

  /* 列表加载时的自动补存（J 的唯一入口）：对一屏里「本机还没有」的条目逐条 pull。
     判据用 wantSave 那一份（已含「本机已有不算」「按 scope 判新不新旧」）——
     页面不许自己判，只递条目数组。并发上限由镜像队列自己管（2 条），不新造队列。
     只对**已渲染的那一屏**排（页面自己传当前页的 items），不预排全部。 */
  function offerAll(items, opts) {
    if (!saveOn()) return 0;
    let n = 0;
    for (const it of (Array.isArray(items) ? items : [])) {
      if (!it) continue;
      if (!wantSave(it)) continue;
      const r = pull(it, opts);
      if (r === 'queued') n++;
    }
    return n;
  }

  /* ---------- 「这一屏还要存回本机哪几条」只有这一份 ----------
     资产库 / 收藏 / 工作台三处以前各筛一遍（一处看 kind、一处看 hasLocal、一处看 stateOf），
     判据漂了就会出现「卡片写着本机、按钮却还算它一条」。entries 由页面先按自己的筛选 / 分页筛好，
     这里只做四件事：本地上传的不算、没有地址的不算、本机已有字节的不算、按 keyOf 去重。
     返回**新数组**（沿用原顺序），不丢也补不进页面那一屏之外的东西。 */
  function pullPlan(entries, o) {
    const opts = o || {};
    const keyOf = typeof opts.keyOf === 'function' ? opts.keyOf : keyFor;
    const seen = new Set();
    const out = [];
    for (const e of (Array.isArray(entries) ? entries : [])) {
      if (!e || e.kind === 'local' || e.fromLocal) continue;
      if (!(e.src || e.dl || e.rawSrc || e.media || e.url)) continue;
      const k = keyOf(e);
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      if (stateOf(e).local) continue;
      out.push(e);
    }
    return out;
  }
  /* 范围算完之后按钮上那个数也只有这一份；返回的就是点下去要存的那一批。 */
  function pullBar(b, plan, o) {
    const list = Array.isArray(plan) ? plan : [];
    pullBtn(b, list.length, o);
    return list;
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
     四页（工作台 / 资产库 / 收藏 / 素材库）以前各抄一遍这三件事，抄出两处真缺陷：
       · 工作台的守卫只看了 dataset.busy、没看成「在途时整颗不要重画」，
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
    if (!n) return opts.empty || (zone + '的' + what + '本机都已经有了');
    return zone + '有 ' + n + ' ' + (opts.unit || '条') + what
      + '的字节还不在本机（外链一过期就是破图）：逐条取回本机资产库，已经在本机的一条都不会重下。'
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
      if (/^\/(?:asset|getv|fetch)\b/.test(s) && s.indexOf('?dl=1') >= 0) return s;
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

  /* ---------- 「生成完成」这条事件的唯一生产处 ----------
     导演台 / 工作台 / assetlib._announce 三处各自 dispatch 时字段集合互不相同（导演台带
     priceMicros、工作台不带；一家写 `src`、一家写 `url`），消费方只能逐字段可选容错，
     加一个字段就要改三处。现在三个生产点都只调 announce()，三条归一化规则
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
      const k = keyFor(n);
      const dedupe = k || (n.provider + '|' + n.src);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(n);
    }
    if (!out.length) return 0;
    try { window.dispatchEvent(new CustomEvent('wb:asset-done', { detail: { entries: out } })); } catch (e) { /* 投不出去也别把生成回执带倒 */ }
    return out.length;
  }

  /* 本机资产库列表里的每一行都是账里的真账：收进别名表。
     它与别名快照同一份读法（rowOfServer），所以同一份文件从哪条路进来都长成同一行。
     这一步**不问「自动存本机」开关** —— 它记的是已经躺在库根里的字节，一个字节都不下载；
     那个开关管的是 offer / runOne 要不要为新产物把字节取回来。 */
  function learn(raw) { return putRow(raw); }

  /* 一条「本机自产」的条目（条目即资产），而账里已经没有它那个本机号 ——
     索引被重建过 / 本机文件被删了，可首屏缓存里还留着上一天的那一条。
     它既没有字节、又顶着「本机」标记与平台那条各占一张卡：列表进界面前摘掉
     （settleEntries），徽标也不许再写「本机」。表还没取回来时一律 false。 */
  function staleSelf(o) {
    if (!o || !libraryKnown() || o.kind !== 'asset') return false;
    if (!o.localSelf && !(o.localAsset && LA_ID(o.assetId))) return false;
    const id = selfRowId(o);
    return !!id && !rows.has(id);
  }
  /* 地址写着 /asset/la_xxx，而账里那一行已经不在了：卡片不能一直指着一个打不开的地址。
     按「decorate 记下的平台地址 → 来源外链 → 平台产物号 / 任务号」依次换回去；
     都没有就保持原样，交给 error 监听标「已丢失」。 */
  function healDeadSrc(e) {
    const cur = String(e.src || '');
    if (!/^\/asset\/la_/.test(cur)) return;
    for (const c of [e.platSrc, e.rawSrc, e.upstreamSrc]) {
      const s = String(c || '');
      if (s && !/^\/asset\/la_/.test(s) && !/^blob:/.test(s)) { e.src = mediaSrc(s); return; }
    }
    const aid = String(e.assetId || '');
    const tid = String(e.taskId || e.genId || '');
    if (aid && !LA_ID(aid)) { e.src = Api.assetSrc(aid); return; }
    if (tid && !LA_ID(tid)) e.src = Api.assetSrc(tid);
  }

  /* 给一条**刚解析出来的条目**挂上本机镜像信息，并把 src 换成该用的那个（第一级回退）。
     在 AssetLib.normalize 里对每个资产条目调一次 —— 全项目只有这一处产生条目，
     所以「哪些页面看得到本机副本」不需要各页自己接一遍。
     `opts.allowGen`：条目自己声明「这个任务只出了这一份」之后才为 true（见 rowOfEntry）。
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
    if (selfRow) {
      /* 账里已经没有这一行（索引重建 / 本机文件被删），缓存里却还留着它：
         不能再顶着 /asset/la_xxx 冒充本机 —— 摘掉本机标记，地址按平台那份补。 */
      if (staleSelf(e)) { e.localAsset = false; healDeadSrc(e); }
      return e;
    }
    const row = rowOfEntry(e, opts && opts.allowGen != null ? !!opts.allowGen : Number(e.outCount) === 1);
    if (row) {
      /* 换成本机地址之前把平台那份记下来：删掉本机副本之后要原样退回去，
         否则卡片会一直指着一个已删除的 /asset/la_xxx。 */
      if (!e.platSrc && e.src && !/^\/asset\/la_/.test(String(e.src)) && !/^blob:/.test(String(e.src))) e.platSrc = e.src;
      e.mirrorKey = 'la:' + row.id;
      /* 页面读的是这一份：`a` 是本机号（删除入口拿它删），其余字段给卡片与按钮用。 */
      e.mirror = { a: row.id, f: row.format, n: row.name, b: row.bytes,
        up: row.upstream, p: row.assetId, g: row.taskId, fp: row.file };
      e.localAsset = true;                    // 界面上可以「删除」（删的是本机那份）
      if (e.byteLength == null && row.bytes) e.byteLength = row.bytes;
      if (preferLocal()) e.src = Api.assetSrc(row.id);
      else if (e.platSrc) e.src = e.platSrc;
      return e;
    }
    /* 别名表里没有这一条（用户刚删掉本机副本 / 索引重建过 / 表还没取回来）：
       把上一次换过的地址退回平台那份，并把「本机」标记摘掉。
       平台那份也没记下来（缓存里存的就是 /asset/la_xxx）时按来源地址 / 平台号补一个。 */
    if (e.platSrc) e.src = e.platSrc;
    healDeadSrc(e);
    delete e.mirrorKey; delete e.mirror;
    delete e.localAsset;
    return e;
  }

  /* 一张图 / 一段视频取不到字节时的两级回退（async：内存表没命中要问一次代理）。
     判据全部来自别名表与代理那一份账，不需要页面把条目传进来：
       · src 是 /asset/<平台产物号> 挂了 → 问代理「这一条在本机是哪一份」→ 换 /asset/<本机号>
       · src 是 /asset/<本机号> 挂了 → 账里那条记着来源地址 → 换 /getv?url= 回源
       · src 是平台外链挂了 → 按地址（剥签名）反查本机副本 → 换 /asset/<本机号>
       · 两边都试过还挂 → 标 lost，插一个「已丢失」角标（而不是留一张裂图让人猜）
     每个元素只回退一次：`dataset.fb` 在**同步**那一步就钉住，并发的第二个 error 直接判丢失。 */
  const LB = '文件已丢失（本机副本与平台地址都没了）';
  function lostTip(el) {
    const parent = el.parentElement;
    if (!parent) return;
    if (parent.querySelector('.lost-tip')) return;
    const s = document.createElement('span');
    s.className = 'lost-tip';
    s.textContent = '已丢失';
    s.title = LB;
    parent.appendChild(s);
    /* 角标只盖**这一张图**。
       `.lost-tip` 是 position:absolute; inset:0 —— 它铺开的是「最近的定位祖先」，
       而灯箱的舞台、检查器那格大图、详情层的候选排、角色资产那一格**都不是定位容器**：
       于是一张图挂了就变成「整屏一块已丢失」（点一下素材卡全屏变灰，用户只看到一句没头没尾的话）。
       所以这里两步：
         ① 给图那一格的父容器补上定位（只这一处，不动全站；position:relative 不改排版）；
         ② 按图**自己的盒子**把角标摆进去 —— 父容器比图大时（候选排那一格：图 + 名字），
            角标只盖图那一块，不把旁边的字也盖掉。 */
    try {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w > 0 && h > 0) {
        /* offsetLeft/Top 是相对 offsetParent 的**边框盒**，绝对定位的包含块是**内边距盒**：
           差一个边框宽（clientLeft/clientTop），减掉。 */
        s.style.left = (el.offsetLeft - parent.clientLeft) + 'px';
        s.style.top = (el.offsetTop - parent.clientTop) + 'px';
        s.style.width = w + 'px';
        s.style.height = h + 'px';
        s.style.right = 'auto';
        s.style.bottom = 'auto';
        /* 那一格太小（角色资产那个 34px 缩略图）：三个字会挤成竖排一列，换紧凑写法。 */
        if (w < 64 || h < 40) s.classList.add('is-tiny');
      }
    } catch (e) { /* 量不出来就退回「铺满那一格」，总比铺满整屏好 */ }
  }
  function markLost(el) {
    el.dataset.lost = '1';
    el.style.visibility = 'hidden';
    lostTip(el);
  }
  async function onMediaError(e) {
    const el = e && e.target;
    if (!el || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return;
    if (el.dataset.fb === '1') { markLost(el); return; }
    const raw = String(el.getAttribute('src') || el.getAttribute('data-src') || '');
    const swapTo = src => {
      el.dataset.fb = '1';
      el.setAttribute('src', src);
      try { el.load && el.load(); } catch (e2) {}
    };
    const am = raw.match(/^\/asset\/([A-Za-z0-9_-]+)/);
    if (am && !/^\/asset\/local/.test(raw)) {
      const pid = am[1];
      /* 内存表先认一遍：绝大多数回退命中在这一步（`/asset/<平台产物号>` 与 `/asset/<本机号>` 都认）。 */
      const la = localAssetIdOf(raw);
      if (la && raw.indexOf('/asset/' + la) < 0) { el.dataset.fbLoc = la; swapTo(Api.assetSrc(la)); return; }
      el.dataset.fb = '1';                     // 下面要 await，先钉住「只回退一次」
      const got = await locateRows([{ assetId: pid, taskId: pid, allowGen: true }]);
      const row = got[0] || rows.get(pid);
      if (row && row.id !== pid) {
        /* 账里记着另一份本机文件：换本机号再试（行是代理按磁盘验过的，不是猜的）。 */
        el.dataset.fbLoc = row.id;
        el.setAttribute('src', Api.assetSrc(row.id));
        try { el.load && el.load(); } catch (e2) {}
        return;
      }
      /* 失效地址本身就是本机号：账里还记着它是从哪个外链取回来的 → 回源那一份。 */
      if (row && row.upstream) {
        el.dataset.fbUp = row.upstream;
        el.setAttribute('src', '/getv?url=' + encodeURIComponent(row.upstream));
        try { el.load && el.load(); } catch (e2) {}
        return;
      }
      markLost(el);
      return;
    }
    /* 平台外链 / /getv 包装挂了：先按地址反查本机副本（签名剥掉，判据只有 mediaKey 一份）。 */
    const key = mediaKey(raw);
    const hit = key ? byUp.get(key) : null;
    if (hit) {
      el.dataset.fbLoc = hit.id;
      swapTo(Api.assetSrc(hit.id));
      return;
    }
    el.dataset.fb = '1';
    let inner = raw;
    try { if (window.MediaId) inner = String(window.MediaId.innerMedia(raw) || raw); } catch (e2) {}
    const got = await locateRows([{ url: inner }]);
    const row = got[0];
    if (row) {
      el.dataset.fbLoc = row.id;
      el.setAttribute('src', Api.assetSrc(row.id));
      try { el.load && el.load(); } catch (e2) {}
      return;
    }
    markLost(el);
  }
  let watching = false;
  const WAKE_STALE = 30000;
  function watch() {
    if (watching || typeof document === 'undefined') return;
    watching = true;
    document.addEventListener('error', onMediaError, true);
    /* 别的标签页 / 别的页面刚镜像完一份产物 → 别名表要重新问一次代理。
       不问的话，「优先用本机文件」在生成页之外的标签里永远看不见新存的那一份
       （地址算出来还是过期外链 → 抽帧失败 → 预览图没有），要刷新整个页面才好。
       回到前台时也补一次：跨标签的镜像没有事件可听，而标签在后台时定时器会被节流。 */
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', e => {
        if (e && e.key === K_PENDING) pendCache = null;
        if (e && e.key === K_SAVE) {
          if (!saveOn()) {
            /* 关掉开关：排队中的（非手动 force）不再发；待镜像清单也清掉，
               避免下次开开关时把用户已经不想存的那批一次性补下来。 */
            const drop = queue.splice(0);
            drop.forEach(j => { if (!j.force) { queued.delete(j.k); INFOS.inFlight = Math.max(0, INFOS.inFlight - 1); } else queue.push(j); });
            pendWrite([]);
            held.clear();          // 按住的自动 offer 一并作废：开关关了，它们不该等表回来再排
            infoChanged();
          } else replayPending();
        }
      });
      const wake = () => {
        if (document.hidden) return;
        if (readyAt && Date.now() - readyAt < WAKE_STALE) return;
        ready(0);
      };
      window.addEventListener('focus', wake);
      document.addEventListener('visibilitychange', wake);
      /* 生成完成的事件由**本模块的 announce()** 投（四个生产点都走那一条），这一份是唯一消费方：
         自动镜像不再依赖「恰好有个列表页在加载 AssetLib」。 */
      window.addEventListener('wb:asset-done', e => {
        const es = (e && e.detail && e.detail.entries) || [];
        if (Array.isArray(es) && es.length) { try { scan(es); } catch (err) { console.warn('[AssetLocal] 生成完成入库失败：', err); } }
      });
    }
  }

  window.AssetLocal = {
    showBadge, offer, scan, announce, decorate, watch, pullMany, pullSummaryText,
    pullPlan, pullBar, offerAll,
    /* 等别名表就位（列表加载前调一次：首屏缓存要先按它换成本机地址，否则会先用过期外链画一帧）。
       并发调用共用同一只在途请求；拿不到表不抛错，列表照常显示。 */
    ready,
    /* 列表进界面前把这一批里还没命中的条目问一遍代理，再按结果重新 decorate（见 locate）。 */
    locate,
    pullBusy, pullStart, pullEnd, pullBtn, pullReceipt,
    /* 「产物存本机」开关的唯一谓词（saveOn）+「补不补历史产物」那一档与判据：
       页面与设置页都读它们，不要自己抄一遍 `localStorage.getItem('sk_media_local') !== 'off'`。 */
    saveOn, saveScope, markSaveOn, wantSave,
    /* 侧栏那两块各自显示与否（设置页勾）。判据各一份，sidebar.js 直接调。 */
    sbBalOn, sbMirrorOn,
    /* 「正在存 / 存成了几份 / 失败原因」—— 页面据此把「开了没反应」变成看得见的实况。
       onInfo 返回退订函数；info() 立刻给一份当前读数（订阅时也会回调一次）。 */
    info, onInfo,
    /* 「这条产物在本机有副本吗 / 这是哪一条的镜像」：地址层（mediaSrc）与列表层（去重）都读这两个，
       别名表的形状只有本模块认识 */
    localCopyOf, twinOf, learn,
    /* 「本机资产库那一条在账里已经没有了」：索引重建 / 文件被删之后，首屏缓存里留着的
       自产条目由 settleEntries 用它摘掉（见 staleSelf）。 */
    staleSelf,
    /* 「这一条在本机镜像是哪一个资产号」：**不看开关**的身份查法（缩略图缓存键用它，
       见 workbench.js 的 thumbs.keyOf）—— 开关只管画面上用哪个地址，不能管「这是哪一份东西」。 */
    localAssetIdOf,
    /* FCPXML / 本地路径类出口用：地址 → { id, format, name, bytes, path }。 */
    localFileOf,
    /* 「本机 / 云端」的**唯一**判据（徽标、存回本机的范围、列表去重、助手的读数都读它）。
       页面不许自己拼 localAsset / hasLocalAddr / assetId —— 那三种形状各拼一遍，
       就会出现「卡片写着本机、存回本机却把它算进 N 条」这种自相矛盾的界面。
       hasLocal / hasCloud 是这一枚内部的判据，不外挂：外面拿到两枚就会自己拼状态。 */
    stateOf,
    /* 「不显示云端任务」：一个开关的生效条件（localOnly）与它唯一的判据（hideAsCloud）。
       页面只许调这两个，「有没有本机副本」一律问 stateOf。 */
    localOnly, hideAsCloud, hasLocalAddr,
    /* 「现在就把这一条存回本机」—— 收藏 / 素材库那两颗「自动下载」用的入口。
       走的是后台自动镜像同一条落盘链（同一份别名表、同一道去重、同一个规范名落点），
       区别只在绕过开关与逐条回执，见上面的 pull。 */
    pull,
    /* 设置页「已存多少 / 占了多少」用：只算条数与字节，不列清单。表还没取回来时是 0 ——
       要事实数字就走 syncStats()（它先取表）。 */
    stats() {
      let count = 0, bytes = 0;
      rows.forEach(r => { count++; bytes += Number(r.bytes) || 0; });
      return { count, bytes };
    },
    /* 从**代理那份账**（.data\local-assets\）现算「本机存了多少」。
       为什么必须有这一步：浏览器这份别名表是当前会话的缓存，本体在库根
       （默认 下载\成像）的类型子目录里；表还没取回来时设置页会写
       「本机已存 0 个产物，共 0 KB」，而库里其实有几百份 —— 这一页最不能说的话就是假话。
       先问一次别名快照；再走注册表声明的 selfAsset 列表把每一行认进来
       （那一份带着人类可读的提示词与模型字段，统计以外还要用）。 */
    async syncStats() {
      try { await ready(0); } catch (e) {}
      try {
        const reg = await Api.registry();
        const src = (reg.providers || []).find(p => p.list && p.list.selfAsset);
        if (src) {
          const d = await Api.request(src, 'list', { query: 'limit=1000' });
          const list = (d && (d.data || d.items)) || [];
          for (const r of list) learn(r);
        }
      } catch (e) { /* 代理没起来就照旧报本地那份数，不要在这一页抛错 */ }
      /* 返回的是 `info()` 那一份（不是 stats()）：设置页那一行还要读在途数与最后一次失败原因，
         两个形状各回各的就会出现「count 更新了、在途数永远是 undefined」。 */
      return info();
    },
    /* 抹掉一份本机文件在别名表里的那一行（用户点「删除本机文件」成功之后）。 */
    forgetMirror,
  };
  watch();
  replayPending();
  /* 开机就把别名表取回来：首屏缓存与 mediaSrc 都要按它换地址，晚一步就会先画一帧过期外链。
     不等它 —— 取不回来也照常启动，列表那一路的 ready() 会再问一次。 */
  ready();
})();
