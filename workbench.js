/* ============================================================================
   workbench.js —— 三个生成工作台（图片 / 视频 / 语音）的公共任务层
   ---------------------------------------------------------------------------
   为什么要有这个文件：这三个页面 80% 的行为是同一件事 —— 拉任务、轮询状态、
   渲染卡片、取消 / 重试 / 删除、保存产物、分页搜索、本地历史。以前每个页面各写
   一套，于是同一个功能出现三种行为（例如「取消」只有视频台有，「重试」图片台没有，
   历史条数上限三个台各不相同）。这里把它收敛成一份实现，三个页面共用。

   用法（页面里）：
     Wb.ST              状态文案（三台统一）
     Wb.isRunning(t) / Wb.isFailed(t) / Wb.stText(s)
     Wb.actsHTML(t, o)  卡片底部那排按钮的 HTML（顺序/文案/危险色三台一致）
     Wb.bindActs(el, t, o)  给上面那排按钮接线（取消/重试/删除都带确认与报错）
     Wb.History.read(kind) / Wb.History.write(kind, list)   带版本与上限的本地历史
     Wb.Blobs.put(k, blob) / get(k) / del(k)               大文件（参考音频等）存 IndexedDB
     Wb.blob(url) / Wb.save(url, name) / Wb.saveAs(url, name)   产物下载（先判 HTTP 状态）
     Wb.poller({...})   轮询器：没任务就休眠、连续失败会提示并退避、切走标签页自动暂停
     Wb.searchNote(n)   搜索框旁的「仅筛选已加载的 N 条」说明
     Wb.ready({...})    生成按钮的就绪状态：禁用 + 悬停说明一直在，按钮下方那行原因等用户动过手才显示
     Wb.thumbs.*        缩略图缓存（视频首帧 + 图片，全站共用一份）
     Wb.vframe.*        浏览器内取视频帧（首帧槽位选视频 / 接上一镜尾帧，共用一份）
   ========================================================================== */
(function () {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------- 状态：三台共用同一套文案与判定 ---------- */
  const ST = {
    creating: '创建中', queued: '排队中', pending: '排队中',
    running: '生成中', processing: '生成中', synthesizing: '合成中',
    succeeded: '已完成', done: '已完成', failed: '生成失败', cancelled: '已取消', canceled: '已取消',
  };
  const RUNNING = ['creating', 'queued', 'pending', 'running', 'processing', 'synthesizing'];
  const FAILED = ['failed', 'cancelled', 'canceled'];

  /* ---------- 本地历史：统一 key / 版本 / 上限，并自动接管各台的老数据 ---------- */
  /* 以前三个台的上限分别是 150 / 60 / 80，超了就静默丢弃；现在统一 200，并且写不进去会提示。
     注意：视频台**没有**这条 —— 它的任务卡片全部来自平台接口，本地不留任务记录（只有首屏缓存）。 */
  const HISTORY = {
    image: { key: 'sparkcine_gallery', version: 2, cap: 200, label: '生图历史',
      strip: it => { const o = { ...it }; delete o._blob; return o; } },
    audio: { key: 'audio_tasks', version: 2, cap: 200, label: '语音任务',
      // 参考音频的 base64 有十几 MB，绝不能进 localStorage（以前就是它把整批历史写崩的）
      strip: t => { const o = { ...t }; delete o.voiceRef; return o; } },
  };

  /* ---------- 历史落盘的通用瘦身 ----------
     单条记录里出现「内联二进制」（dataURL / 超长 base64）时绝不能进 localStorage：
     一条参考音频就有十几 MB，写一次就把整批历史顶掉。
     以前靠每个台在 strip 里手工 delete 字段，新加一个字段漏了就再炸一次
     （历史上真发生过：语音台参考音频把整批历史写崩）。这里按**体积特征**兜底，
     与字段名无关 —— 以后新加的字段不会再踩同一个坑。 */
  const SLIM_TEXT = 20000;      // 正常文本（提示词等）保留阈值：视频台最长 30000 字提示词不受影响
  function looksInlineBinary(v) {
    if (typeof v !== 'string') return false;
    if (v.startsWith('data:') && v.length > 512) return true;             // dataURL：一律不落盘
    if (v.length < SLIM_TEXT) return false;
    // 超长、不含空白、且全是 base64 字符 → 视为内联二进制（正常文本几乎不会长这样）
    return /^[A-Za-z0-9+/=]+$/.test(v.slice(0, 4096));
  }
  function slimForStorage(v, depth) {
    if (depth > 6) return undefined;
    if (Array.isArray(v)) return v.map(x => slimForStorage(x, depth + 1)).filter(x => x !== undefined);
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach(k => {
        const val = v[k];
        if (k === '_blob' || looksInlineBinary(val)) return;
        const w = slimForStorage(val, depth + 1);
        if (w !== undefined) out[k] = w;
      });
      return out;
    }
    return v === undefined ? undefined : v;
  }

  /* ---------- 大文件存储（IndexedDB）：参考音频、参考视频这类大对象 ---------- */  const DB = 'wb_blobs', STORE = 'blobs';
  let dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(DB, 1); } catch (e) { dbP = null; rej(e); return; }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => { try { d.close(); } catch {} dbP = null; };
        d.onclose = () => { dbP = null; };
        res(d);
      };
      r.onerror = () => { dbP = null; rej(r.error); };   // 失败不缓存，下次重试
      r.onblocked = () => { dbP = null; rej(new Error('IndexedDB 被其他标签页占用')); };
    });
    return dbP;
  }
  const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const q = fn(t.objectStore(STORE));
    t.oncomplete = () => res(q && q.result);
    t.onerror = () => rej(t.error);
  }));

  window.Wb = {
    ST, RUNNING, FAILED,
    stText(s) { return ST[s] || s || ''; },
    isRunning(t) { return !!t && RUNNING.includes(t.status); },
    isFailed(t) { return !!t && FAILED.includes(t.status); },
    esc,

    /* ---------- 卡片身份键（右栏 DOM 复用、详情展开状态、灯箱定位都靠它） ----------
       以前各页写成 `vid || assetId || prompt`：同一段提示词提交两条、两条又都没有任务号时
       （详情 404 后页面会把 vid 清空），两张卡撞同一个键 —— Wb.cards 认成同一张，
       展开状态和内容互相串（表现为「卡片点详情串到另一条」「两条任务显示同一张图」）。
       兜底因此换成「平台 + 创建时间 + 提示词长度与前缀」：这三项都来自平台返回的那条记录，
       刷新列表后仍能稳定复现，同时几乎不可能撞车。
       ids：本页字段优先级（图片台一条任务出多张图，asset_id 必须排在 gen_id 前）。 */
    taskKey(t, ids) {
      if (!t) return '';
      const cand = ids || [t.vid, t.gen_id, t.genId, t.asset_id, t.assetId, t.taskId, t.id];
      const id = cand.find(v => v != null && String(v) !== '');
      if (id != null) return 'i:' + String(id);
      const p = String(t.prompt || '');
      return 'x:' + (t.provider || t.providerName || '') + ':' + (t.ts || 0) + ':' + p.length + ':' + p.slice(0, 40);
    },

    /* ---------- 文件大小 ---------- */
    /* 统一的体积文案（原来只有图片台有，三台各写一份迟早会不一致） */
    fmtSize(bytes) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return '';
      const u = ['B', 'KB', 'MB', 'GB'];
      let i = 0, v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return (i ? v.toFixed(1) : v) + ' ' + u[i];
    },
    /* 实测某个媒体文件的体积 —— 上游接口基本都不返回体积（实测 VGENV / SparkCine 都没有），
       而下载整个文件只为量一下大小显然不行。这里只发一个 Range: bytes=0-0 的探测请求：
       服务端会回 Content-Range: bytes 0-0/<总大小>，拿到头就立刻断开，不下载正文。
       外部链接走代理的 /getv（同源，所以 JS 读得到这些响应头）。结果按 URL 缓存。 */
    _sizes: new Map(),
    async mediaSize(src) {
      const s = String(src || '');
      if (!s) return 0;
      if (this._sizes.has(s)) return this._sizes.get(s);
      const url = /^https?:/i.test(s) ? '/getv?url=' + encodeURIComponent(s) : s;
      const ctl = new AbortController();
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctl.signal });
        /* 只认 206（服务端支持 Range，响应头是 bytes 0-0/总长）与 200（忽略 Range、回整份）。
           416 / 403 这类错误响应的 content-length 是错误页的大小，拿它当体积会显示成错的值。 */
        if (r.status !== 206 && r.status !== 200) { ctl.abort(); return 0; }
        const cr = r.headers.get('content-range') || '';
        const total = /\/(\d+)\s*$/.exec(cr);
        let size = total ? Number(total[1]) : Number(r.headers.get('content-length') || 0);
        ctl.abort();                       // 只要响应头，正文不要
        if (!Number.isFinite(size) || size <= 0) return 0;   // 拿不到就当没有，不显示
        if (this._sizes.size > 200) this._sizes.clear();
        this._sizes.set(s, size);
        return size;
      } catch { return 0; }
    },
    /* 设置页「清空缓存」：体积探测结果（每条地址一次 Range 请求）也是缓存，清掉下次重新探 */
    clearSizes() {
      const n = this._sizes.size;
      this._sizes.clear();
      return n;
    },

    History: {
      spec(kind) { return HISTORY[kind] || { key: kind, version: 1, cap: 200, label: kind }; },
      read(kind) {
        const s = this.spec(kind);
        const v = window.Store.read(s.key, [], { version: s.version });
        return Array.isArray(v) ? v : [];
      },
      write(kind, list) {
        const s = this.spec(kind);
        const arr = (Array.isArray(list) ? list : []).map(it => (s.strip ? s.strip(it) : it));
        const clean = arr.map(it => slimForStorage(it, 0));      // 通用瘦身：内联二进制不落盘
        let r = window.Store.write(s.key, clean, { version: s.version, cap: s.cap, label: s.label });
        /* 还是写不下（配额满）时降级，而不是整批失败：
           先砍一半、再只留最近 20 条 —— 「少存几条」比「一条都没存下」有用，
           Store.write 失败时已经弹过一次提示，这里只需尽力保住历史。 */
        if (!r.ok) {
          for (const n of [Math.floor(clean.length / 2), 20]) {
            if (!clean.length || n >= clean.length) continue;
            r = window.Store.write(s.key, clean.slice(0, n), { version: s.version, cap: s.cap, label: s.label });
            if (r.ok) break;
          }
        }
        return r.ok ? clean.slice(0, s.cap) : null;      // 写失败返回 null：调用方据此知道「历史没保存」
      },
      /* 设置页的「清空缓存」要用：列出有哪些本地任务记录、按类清掉。
         只清 HISTORY 里声明过的（生图历史 / 语音任务），不要凭 key 乱删别的存储。 */
      kinds() { return Object.keys(HISTORY).map(k => ({ kind: k, key: HISTORY[k].key, label: HISTORY[k].label })); },
      clear(kind) {
        const s = HISTORY[kind];
        if (!s) return false;
        /* Store.write 返回的是 { ok, ... }，不是布尔值：按 ok 判断，别把失败当成功报给用户 */
        const r = window.Store.write(s.key, [], { version: s.version, label: s.label });
        return !!(r && r.ok);
      },
    },

    Blobs: {
      put(key, blob) { return tx('readwrite', st => st.put(blob, key)); },
      get(key) { return tx('readonly', st => st.get(key)).catch(() => null); },
      del(key) { return tx('readwrite', st => st.delete(key)).catch(() => {}); },
      /* 存一个 Blob 并生成引用键（任务里只存这个键，不存内容本身） */
      async save(blob) {
        const key = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await this.put(key, blob);
        return key;
      },
    },

    /* ---------- 浏览器内取视频帧（首帧槽位选视频时用） ----------
       <video> 解码 → seek → canvas 抓帧，全程在本机做，不经过任何服务端。
       素材地址必须同源：外链统一走 /getv 或 /fetch（同源、支持 Range），否则 canvas 被抓污、
       toBlob / toDataURL 直接抛错。视频台的「首帧槽位选视频」与导演台的「接上一镜尾帧 /
       用视频当首帧」共用这一份实现（以前两个页面各写一套：一个出 PNG File、一个出 JPEG dataURL）。 */
    vframe: {
      _same(src) {
        const s = String(src || '');
        return /^https?:/i.test(s) ? '/fetch?url=' + encodeURIComponent(s) : s;
      },
      meta(v) {
        return new Promise((res, rej) => {
          if (v.readyState >= 1) return res();
          let done = false;
          const fin = ok => {
            if (done) return; done = true;
            clearTimeout(to);
            v.removeEventListener('loadedmetadata', onOk); v.removeEventListener('error', onErr);
            ok ? res() : rej(new Error('视频读不出来（格式不支持，或地址已过期）'));
          };
          const onOk = () => fin(true), onErr = () => fin(false);
          const to = setTimeout(() => fin(false), 20000);
          v.addEventListener('loadedmetadata', onOk);
          v.addEventListener('error', onErr);
          v.load();
        });
      },
      seek(v, t) {
        return new Promise((res, rej) => {
          let done = false;
          const fin = ok => {
            if (done) return; done = true;
            clearTimeout(to);
            v.removeEventListener('seeked', onSeek); v.removeEventListener('error', onErr);
            ok ? res() : rej(new Error('视频定位失败（文件损坏或格式不支持）'));
          };
          const onSeek = () => fin(true), onErr = () => fin(false);
          const to = setTimeout(() => fin(false), 15000);
          v.addEventListener('seeked', onSeek, { once: true });
          v.addEventListener('error', onErr, { once: true });
          try { v.currentTime = t; } catch (e) { fin(false); return; }
          // 已经停在目标位置（例如取第一帧、而它本来就在 0 秒）：不会再触发 seeked，直接完成
          if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) fin(true);
        });
      },
      /* which：'last' 取最后一帧（默认）/ 'first' 取第一帧；atSeconds 有值时截该时刻（用于剪辑后的尾帧）。
         返回 { blob, w, h } */
      async grab(src, which, atSeconds) {
        const first = which === 'first' || which === 'start';
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.setAttribute('playsinline', '');
        v.src = this._same(src);
        try {
          await this.meta(v);
          let dur = isFinite(v.duration) ? Number(v.duration) : 0;
          /* duration 是 Infinity / NaN（有些流式编码的 mp4 元数据里没有时长）时以前直接跳过 seek，
             结果「最后一帧」拿到的是 0 秒那一帧 —— 静默取错帧。先试 seekable 给的范围末端。 */
          if (!(dur > 0)) {
            try { const sk = v.seekable; if (sk && sk.length) dur = Number(sk.end(sk.length - 1)) || 0; } catch (e) {}
          }
          if (atSeconds != null) {
            const t = Math.max(0, Math.min(Number(atSeconds) - 0.05, Math.max(0, dur - 0.05)));
            await this.seek(v, t);
          } else if (dur > 0) {
            await this.seek(v, first ? 0 : Math.max(0, dur - 0.05));
          } else if (!first) {
            throw new Error('这个视频读不到时长，取不到最后一帧（可改用图片作首帧，或先转码）');
          }
          const w = v.videoWidth, h = v.videoHeight;
          if (!w || !h) throw new Error('视频里没有可用画面（可能是纯音频或已损坏的文件）');
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          const blob = await new Promise(r => c.toBlob(r, 'image/png'));
          if (!blob || !blob.size) throw new Error('抓帧失败（画面为空）');
          return { blob, w, h };
        } finally {
          try { v.removeAttribute('src'); v.load(); } catch (e) {}      // 释放解码器
        }
      },
      _decode(blob) {
        if (window.createImageBitmap) return createImageBitmap(blob);
        return new Promise((res, rej) => {                              // 老浏览器兜底
          const u = URL.createObjectURL(blob);
          const im = new Image();
          im.onload = () => { URL.revokeObjectURL(u); res(im); };
          im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('帧解码失败')); };
          im.src = u;
        });
      },
      /* 抓一帧 → 最长边 maxSide（默认 1600）的 JPEG dataURL：直接当首帧图存放（要写本地存档，不能太大） */
      async dataURL(src, which, atSeconds, maxSide) {
        const { blob, w, h } = await this.grab(src, which, atSeconds);
        const img = await this._decode(blob);
        const scale = Math.min(1, (maxSide > 0 ? maxSide : 1600) / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        return c.toDataURL('image/jpeg', 0.9);
      },
      async dataURLFromFile(f, which, maxSide) {
        const tmp = URL.createObjectURL(f);
        try { return await this.dataURL(tmp, which, null, maxSide); } finally { URL.revokeObjectURL(tmp); }
      },
      /* 视频文件 → 首帧槽位要的图片素材（PNG，文件名保留来源视频名，方便用户认出来源）。
         返回 { file, url, name, type:'图片', fromVideo }；槽位 kind 由调用方补。 */
      async fromFile(f, which) {
        const last = which !== 'first' && which !== 'start';
        const tmp = URL.createObjectURL(f);
        let blob;
        try { ({ blob } = await this.grab(tmp, which)); } finally { URL.revokeObjectURL(tmp); }
        const base = String(f.name || 'video').replace(/\.[^.]+$/, '') || 'video';
        const png = new File([blob], base + (last ? '-尾帧' : '-首帧') + '.png', { type: 'image/png' });
        return { file: png, url: URL.createObjectURL(png), name: png.name, type: '图片', fromVideo: f.name || '视频' };
      },
    },

    /* ---------- 缩略图缓存：视频首帧 + 图片，全站共用一份 ----------
       问题：视频卡片一律用 <video preload="metadata"> 当缩略图 —— 每开一次页面、每翻一页都要
       重新取一次元数据（还要经本地代理去上游解析一次签名地址）。几十张卡一起发请求，
       观感就是「缩略图慢，而且每次都重新加载」。图片同理：上游地址带一次性签名，换了页面
       就等于换了一个 URL，浏览器缓存永远命不中。
       做法（原导演台的实现收敛到这里，所有页面共用一份）：
         · 视频出画后用 canvas 抽一张小图，图片加载完后缩一份小图，都存 IndexedDB 同一张表：
           下次直接当 <img> 用 —— 秒出、零请求，且各页面之间互通（同一份素材只取一次字节）
         · 没有缓存时视频用 IntersectionObserver 懒加载：滚到附近才发请求，一屏外的卡片不抢带宽；
           图片沿用浏览器自己的懒加载（loading="lazy"）
         · 视频出画前用 .tph 占位层盖着（不再是黑块）；抽帧失败不影响播放
         · 缓存键一律过 keyOf 归一化：签名/时间戳参数被剥掉，同一份素材在任何页面算出同一个键
       用法：
         html 里放 Wb.thumbs.mediaHTML(src)（图片传 { type:'image' }）；渲染后对同一元素调
         Wb.thumbs.bind(wrap, media, src)（wrap 是外层容器，视频出画后会自动加 .ready 类） */
    thumbs: {
      _map: new Map(),            // 稳定身份键 → dataURL
      _loaded: null,
      _dirty: new Set(),
      _aliases: new Map(),        // 旧签名键 → 归一化键，提交成功后才移除旧缓存
      _bindings: new WeakMap(),
      _jobs: new Map(),           // 每个 key 一个任务，多个 wrap 订阅同一帧
      _queue: [], _active: 0,
      CONCURRENCY: 2,
      CAP: 300,
      BYTES: 32 * 1024 * 1024,      // 缓存总量上限（图片缩略图比视频帧大，条数之外再加一道字节闸）
      DB: 'wb_thumbs', STORE: 'thumbs',
      _db() {
        if (this._dbP) return this._dbP;
        this._dbP = new Promise((res, rej) => {
          let r;
          try { r = indexedDB.open(this.DB, 1); } catch (e) { this._dbP = null; rej(e); return; }
          r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(this.STORE)) r.result.createObjectStore(this.STORE); };
          r.onsuccess = () => {
            const d = r.result;
            d.onclose = () => { this._dbP = null; };
            d.onversionchange = () => { d.close(); this._dbP = null; };
            res(d);
          };
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('缩略图缓存被其他标签页占用'));
        });
        this._dbP.catch(() => { this._dbP = null; });
        return this._dbP;
      },
      _tx(mode, fn) {
        return this._db().then(d => new Promise((res, rej) => {
          const t = d.transaction(this.STORE, mode);
          const q = fn(t.objectStore(this.STORE));
          t.oncomplete = () => res(q && q.result);
          t.onerror = t.onabort = () => rej(t.error || new Error('缩略图缓存事务中断'));
        }));
      },
      /* 地址归一化：同一份素材无论经过什么包装，都要算出同一个键 —— 否则缩略图缓存永远命不中、
         观感就是「每次都重新加载」。要去掉三类每次都变的东西：
           · #t=0.1        播放/抽帧用的媒体片段
           · ?r=时间戳      重试时的防缓存参数
           · ?v=2           各页面固定的防缓存版本号（全站都写 2）
           · /getv?url=<签名地址> 里的签名（VGENV 走 OSS，Expires 与 Signature 每次刷新都不同）
             这种情况用内层地址的 host + path 当键（path 里带 asset/job id，是稳定的） */
      keyOf(src) {
        const s = String(src == null ? '' : src).split('#')[0];
        if (!s || /^(?:blob:|data:|fav-file:)/i.test(s)) return s;
        try {
          const u = new URL(s, location.href);
          if (u.origin !== location.origin && /^https?:$/.test(u.protocol)) return '/getv?url=' + u.host + u.pathname;
          if (u.pathname === '/getv' && u.searchParams.has('url')) {
            const inner = u.searchParams.get('url');
            // 已归一化的 host/path 也必须幂等，不能再当成相对请求地址。
            if (!/^https?:\/\//i.test(inner)) return '/getv?url=' + inner;
            const raw = new URL(inner);
            return '/getv?url=' + raw.host + raw.pathname;
          }
          if (u.searchParams.has('r')) u.searchParams.delete('r');
          /* ?v=2 是各页面自己加的固定版本号（全站都写 2，从没变过），留着它会把同一份素材拆成
             /asset/x 与 /asset/x?v=2 两个键 —— 同一张首帧被抽两次、缓存里存两份。统一剥掉。 */
          if (u.searchParams.has('v')) u.searchParams.delete('v');
          return u.origin === location.origin ? u.pathname + u.search : s;
        } catch { return s; }
      },
      get(src, key) { return this._map.get(this.keyOf(key || src)) || ''; },
      /* 设置页「清空缩略图缓存」：缩略图随时能重建（重新抽帧/缩放），清掉最多让列表重新加载一次，
         不动任何用户数据。先等落盘事务收尾，否则刚 clear 完 dirty 又被 _flush 写回去。 */
      async clearAll() {
        const n = this._map.size;
        try { await this._flush(); } catch (e) {}
        this._map.clear();
        this._dirty.clear();
        this._aliases.clear();
        this._loaded = Promise.resolve(0);   // 表已空，别让下次 hydrate 再把整表读回来
        try { await this._tx('readwrite', st => st.clear()); } catch (e) {}
        try { await this._dropOld(); } catch (e) {}
        return n;
      },
      /* 导演台旧的 thumbFrames 表：_migrateOld 会把它并进统一缓存。清缓存时必须连它一起删，
         否则刷新页面老帧又被迁回来，看起来就是「清了但没清掉」。 */
      _oldDbExists() {
        if (!indexedDB.databases) return Promise.resolve(true);
        return indexedDB.databases()
          .then(list => (list || []).some(d => d && d.name === 'director_db'))
          .catch(() => true);
      },
      _dropOld() {
        return this._oldDbExists().then(ok => new Promise(res => {
          if (!ok) return res();
          /* 不带版本的 open() 对不存在的库会「凭空建出一个空库」——那会让导演台的
             open('director_db', 1) 不再触发 onupgradeneeded，kv 仓库永远建不起来。
             所以先确认库存在再打开；升级回调里直接关掉，绝不建表。 */
          let r;
          try { r = indexedDB.open('director_db'); } catch (e) { return res(); }
          r.onerror = r.onblocked = res;
          r.onupgradeneeded = () => { try { r.result.close(); } catch (e) {} res(); };
          r.onsuccess = () => {
            const d = r.result;
            const close = () => { try { d.close(); } catch (e) {} done(); };
            d.onversionchange = close;
            if (!d.objectStoreNames.contains('kv')) return close();
            try {
              const t = d.transaction('kv', 'readwrite');
              t.objectStore('kv').delete('thumbFrames');   // 只删这一个键，别的用户数据不动
              t.oncomplete = t.onerror = t.onabort = close;
            } catch (e) { close(); }
          };
        }));
      },
      /* bind 等待 hydrate 后原地换图；返回条数仅兼容旧调用，不需要整表重画。 */
      async hydrate() {
        if (!this._lifecycle) {
          this._lifecycle = true;
          window.addEventListener('pagehide', () => { this._flush(); });
          document.addEventListener('visibilitychange', () => { if (document.hidden) this._flush(); });
        }
        if (this._loaded) return this._loaded;
        this._loaded = (async () => {
          let n = 0;
          try {
            const rows = await this._tx('readonly', st => st.getAll());
            (rows || []).filter(r => r && r.k && typeof r.v === 'string' && r.v)
              .sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach(r => {
                const key = this.keyOf(r.k);
                if (!this._map.has(key)) { this._map.set(key, r.v); n++; }
                if (key !== r.k) { this._aliases.set(r.k, key); this._dirty.add(key); }
              });
          } catch (e) { console.warn('[Wb] 缩略图缓存读取失败（不影响播放）：', e && e.message); }
          n += await this._migrateOld();
          this._flush();
          return n;
        })();
        return this._loaded;
      },
      /* 兼容导演台旧 thumbFrames。保留旧记录作为落盘失败时的后备，不先删后存。 */
      _migrateOld() {
        return new Promise(res => {
          const skip = () => res(0);
          this._oldDbExists().then(ok => {
            if (!ok) return skip();
            let r;
            try { r = indexedDB.open('director_db'); } catch (e) { return skip(); }
            r.onerror = skip;
            r.onblocked = skip;
            r.onupgradeneeded = () => { try { r.result.close(); } catch (e) {} skip(); };   // 库不存在：没得迁移
            r.onsuccess = () => {
              const d = r.result;
              d.onversionchange = () => { try { d.close(); } catch (e) {} };   // 别把导演台的补建升级堵死
              if (!d.objectStoreNames.contains('kv')) { try { d.close(); } catch (e) {} return res(0); }
              let n = 0;
              try {
                const t = d.transaction('kv', 'readonly');
                const st = t.objectStore('kv');
                const q = st.get('thumbFrames');
                q.onsuccess = () => {
                  const m = q.result;
                  if (m && typeof m === 'object') {
                    Object.entries(m).forEach(([k, v]) => {
                      const key = this.keyOf(k);
                      if (key && typeof v === 'string' && v && !this._map.has(key)) {
                        this._map.set(key, v); this._dirty.add(key); n++;
                      }
                    });
                  }
                };
                t.oncomplete = () => { try { d.close(); } catch (e) {} res(n); };
                t.onerror = () => { try { d.close(); } catch (e) {} res(n); };
              } catch (e) { try { d.close(); } catch (e2) {} res(0); }
            };
          });
        });
      },
      _save(k, v) {
        const key = this.keyOf(k);
        if (!key || !v) return;
        this._map.set(key, v);
        this._dirty.add(key);
        this._flush();                    // 不 debounce：提帧后马上提交，快速切页也尽早落盘
      },
      _flush() {
        if (this._saving) return this._saving;
        const batch = new Map([...this._dirty].map(k => [k, this._map.get(k)]).filter(([, v]) => v));
        if (!batch.size) return Promise.resolve(true);
        const aliases = [...this._aliases].filter(([, key]) => batch.has(key));
        this._saving = this._tx('readwrite', st => {
          for (const [k, v] of batch) st.put({ k, v, ts: Date.now() }, k);
          for (const [old] of aliases) st.delete(old); // 与新键写入同一事务；失败全部回滚
        }).then(() => {
          for (const [k, v] of batch) { if (this._map.get(k) === v) this._dirty.delete(k); }
          for (const [old, key] of aliases) { if (this._aliases.get(old) === key) this._aliases.delete(old); }
          return true;
        }, () => false).then(ok => {
          this._saving = null;
          if (ok && this._dirty.size) return this._flush();
          if (ok) {
            clearTimeout(this._pruneT);
            this._pruneT = setTimeout(() => { this._prune(); }, 1000);
          }
          return ok;                      // 失败保留 dirty，下一次保存 / hide 再试，不循环重试
        });
        return this._saving;
      },
      /* 容量控制：超过 CAP 条或 BYTES 字节就按写入时间淘汰最早的
         （缩略图可重建，丢了最多再抽一次帧；视频帧和图片共用这一份额度） */
      async _prune() {
        try {
          const drop = [];
          await this._tx('readwrite', st => {
            const q = st.getAll();
            q.onsuccess = () => {
              const rows = (q.result || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
              const size = r => String(r.v || '').length;
              let total = rows.reduce((n, r) => n + size(r), 0);
              const over = Math.max(0, rows.length - this.CAP);
              rows.forEach((r, i) => {
                if (i >= over && total <= this.BYTES) return;
                if (this._dirty.has(r.k)) return;      // 待写的别删，否则刚抽的帧还没落盘就没了
                st.delete(r.k); drop.push(r); total -= size(r);
              });
            };
          });
          for (const r of drop) { if (!this._dirty.has(r.k) && this._map.get(r.k) === r.v) this._map.delete(r.k); }
        } catch (e) {}
      },
      /* key 可显式指定稳定身份（如 fav-file:<fileKey>），实际取帧地址仍用 src。
         opts.type === 'image' → 图片缩略图：有缓存就直接用缓存（小图，秒出、零请求），
         没有就给原地址让浏览器渐进显示，同时在后台把这张图缩一份存进同一份缓存。
         视频与图片共用同一套键（keyOf 归一化）与同一个 IndexedDB 存储。 */
      mediaHTML(src, opts) {
        if (!src) return '';
        const key = this.keyOf((opts && opts.key) || src);
        // 尺寸/内联样式要同时作用到「缓存里的图」和「原地址的元素」，否则出画前后会跳版式
        const extra = (opts && opts.mediaAttrs) ? ' ' + String(opts.mediaAttrs).trim() : '';
        const cached = this.get(key);
        const live = esc(this._source(src));
        if (opts && opts.type === 'image') {
          if (!live && !cached) return '';      // 地址取不回来（非 http 的怪协议）就别放一个空 src 让浏览器去请求本页
          // 图片不盖占位层：原生 <img> 自己会渐进显示，缓存命中时直接用缓存的小图
          return `<img${this._kattr(key)} data-src="${live}" src="${cached ? esc(cached) : live}"`
            + ` alt="" decoding="async"${extra}>`;
        }
        if (cached) return `<img${this._kattr(key)} src="${esc(cached)}" alt="" decoding="sync"${extra}><span class="tph"></span>`;
        const tag = (opts && opts.videoAttrs) || 'preload="metadata" muted playsinline';
        return `<video${this._kattr(key)} data-src="${live}" ${tag}${extra}></video><span class="tph"></span>`;
      },
      /* data: URL 当键会算出几 MB 的字符串：留着做内存里的查表键没问题，写进 DOM 属性就是灾难
         （每次重画都要序列化一遍）。超过 200 字符就不落到属性上，bind 会退回按 src 现算。 */
      _kattr(key) { return key && key.length <= 200 ? ` data-thumb-key="${esc(key)}"` : ''; },
      _source(src) {
        const s = String(src || '');
        if (!s) return '';
        if (/^(data:|blob:)/i.test(s)) return s;
        try {
          const u = new URL(s, location.href);
          if (!/^https?:$/.test(u.protocol)) return '';
          if (u.origin === location.origin) return u.pathname + u.search + u.hash;
          return window.Api && window.Api.mediaSrc ? window.Api.mediaSrc(u.href) : '/getv?url=' + encodeURIComponent(u.href);
        } catch { return ''; }
      },
      _valid(b) { return this._bindings.get(b.wrap) === b && b.wrap.isConnected && b.wrap.contains(b.media); },
      _release(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        video.removeAttribute('src');
        video.removeAttribute('data-src');
        try { video.load(); } catch {}
      },
      /* 保持占位 / 旧帧直到图片加载并解码完成；换图时保留导演台 sthumb 等样式。 */
      _show(b, frame) {
        if (b.showing) return;
        b.showing = true;
        const old = b.media;
        const im = old.tagName === 'IMG' ? old : document.createElement('img');
        if (im !== old) {
          for (const attr of ['class', 'style', 'width', 'height']) {
            if (old.hasAttribute(attr)) im.setAttribute(attr, old.getAttribute(attr));
          }
          im.alt = '';
          im.decoding = 'sync';
          if (b.key && b.key.length <= 200) im.setAttribute('data-thumb-key', b.key);
          im.src = frame;
        }
        const done = async () => {
          im.removeEventListener('load', done);
          im.removeEventListener('error', fail);
          if (im.decode) { try { await im.decode(); } catch { if (!im.naturalWidth) return fail(); } }
          if (!this._valid(b) || !im.naturalWidth) return;
          if (im !== old) { old.replaceWith(im); b.media = im; this._release(old); }
          b.wrap.classList.add(b.rc);
        };
        const fail = () => {
          im.removeEventListener('load', done);
          im.removeEventListener('error', fail);
          b.showing = false;
        };
        if (im.complete && im.naturalWidth) done();
        else { im.addEventListener('load', done); im.addEventListener('error', fail); }
      },
      _io: null,
      _observer() {
        if (this._io || !('IntersectionObserver' in window)) return this._io;
        this._io = new IntersectionObserver(es => {
          es.forEach(e => { if (e.isIntersecting) { this._io.unobserve(e.target); this._attach(e.target); } });
        }, { rootMargin: '320px 0px' });
        return this._io;
      },
      _attach(wrap) {
        const b = this._bindings.get(wrap);
        if (!b || !this._valid(b)) return;
        const frame = this.get(b.key);
        if (frame) { this._show(b, frame); return; }
        const job = this._jobs.get(b.key);
        if (!job || job.queued || job.running) return;
        job.queued = true;
        this._queue.push(job);
        this._pump();
      },
      _sweep() {
        for (const [key, job] of this._jobs) {
          for (const b of job.subs) {
            if (!this._valid(b)) { job.subs.delete(b); if (this._io) this._io.unobserve(b.wrap); }
          }
          if (!job.subs.size && !job.running) this._jobs.delete(key);
        }
      },
      _finish(job, frame) {
        for (const b of job.subs) {
          if (this._io) this._io.unobserve(b.wrap);
          if (!this._valid(b)) continue;
          if (frame) this._show(b, frame);
          else {
            const ph = b.wrap.querySelector('.tph');
            if (ph) ph.textContent = '缩略图暂不可用';
          }
        }
        job.subs.clear();
        if (this._jobs.get(job.key) === job) this._jobs.delete(job.key);
      },
      _pump() {
        this._sweep();
        while (this._active < this.CONCURRENCY && this._queue.length) {
          const job = this._queue.shift();
          if (this._jobs.get(job.key) !== job) continue;
          const frame = this.get(job.key);
          if (frame) { this._finish(job, frame); continue; }
          job.running = true;
          this._active++;
          this._extract(job).then(v => this._finish(job, v), () => this._finish(job, '')).finally(() => {
            this._active--;
            this._pump();
          });
        }
      },
      /* 提帧器不依附卡片 DOM：滚动 / 重画不会新开同 key 的视频流；结束、失败、超时都卸载。 */
      _extract(job) {
        return new Promise(resolve => {
          const video = document.createElement('video');
          let timer, finished = false;
          const end = frame => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            video.removeEventListener('loadeddata', capture);
            video.removeEventListener('seeked', capture);
            video.removeEventListener('error', error);
            video.removeEventListener('loadedmetadata', seek);
            this._release(video);
            resolve(frame);
          };
          const capture = () => { if (video.readyState >= 2 && !video.seeking) end(this._capture(video, job.key) || ''); };
          const error = () => end('');
          const seek = () => { try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); } catch {} };
          video.preload = 'metadata'; video.muted = true; video.playsInline = true;
          video.addEventListener('loadedmetadata', seek);
          video.addEventListener('loadeddata', capture);
          video.addEventListener('seeked', capture);
          video.addEventListener('error', error);
          timer = setTimeout(error, 20000);
          const src = this._source(job.src);
          if (!src) { end(''); return; }
          try { video.src = src; video.load(); } catch { end(''); }
        });
      },
      /* 批量接线：把一段 HTML 里所有带 data-thumb-key 的 img / video 一次接上（wrap = 它们的父节点）。
         给「整块 innerHTML 重画、但每个媒体节点不值得单独 bind」的面板用（如导演台的素材槽）。
         重复 bind 是安全的（同一个 media 会被 bind 开头的那段直接返回）。 */
      bindAll(root) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('img[data-thumb-key], video[data-thumb-key]').forEach(m => {
          const wrap = m.parentElement;
          if (!wrap) return;
          this.bind(wrap, m, m.getAttribute('data-src') || m.getAttribute('src') || '');
        });
      },
      bind(wrap, media, src, readyClass, identity) {
        const rc = readyClass || 'ready';
        if (!wrap || !media) { if (wrap) wrap.classList.add(rc); return; }
        if (media.tagName !== 'VIDEO' && media.tagName !== 'IMG') return;
        // 兼容只写 data-src 的旧调用（bind(t, media, media.getAttribute('src')) 会拿到 null）
        const raw = src || media.getAttribute('data-src') || media.getAttribute('src') || '';
        const key = this.keyOf(identity || media.getAttribute('data-thumb-key') || raw);
        const prev = this._bindings.get(wrap);
        if (prev && prev.media === media && prev.key === key && prev.rc === rc) {
          if (prev.src === raw || media.tagName === 'IMG') return;
          prev.src = raw;
          const job = this._jobs.get(key);
          if (job) { job.src = raw; return; } // 只更新等待中的地址，不重建媒体 / 重启在途请求
        }
        if (this._io) this._io.unobserve(wrap);
        const b = { wrap, media, src: raw, key, rc, ident: identity || '' };
        this._bindings.set(wrap, b);
        // <img> 已经是最终画面（缓存小图或原图）：标 ready，图片再顺手补一份缩略到缓存里
        if (media.tagName === 'IMG') { this._show(b); this._watchImg(b); return; }
        // 兼容旧调用者直接给 video.src 的情况；公共 HTML 始终只生成 data-src。
        if (media.getAttribute('src')) this._release(media);
        this.hydrate().then(() => {
          if (!this._valid(b)) return;
          this._sweep();
          const frame = this.get(key);
          if (frame) { this._show(b, frame); return; }
          let job = this._jobs.get(key);
          if (!job) { job = { key, src, subs: new Set() }; this._jobs.set(key, job); }
          job.src = b.src;
          job.subs.add(b);
          const io = this._observer();
          if (io) io.observe(wrap); else this._attach(wrap);
        });
      },
      /* 抽帧：只抽同源视频（跨域画进 canvas 会污染），失败静默（不影响播放） */
      _capture(video, key) {
        key = this.keyOf(key);
        if (!key || !video) return '';
        if (this._map.has(key)) return this._map.get(key);
        const shown = video.getAttribute('src') || video.currentSrc || '';
        try {
          const url = new URL(shown, location.href);
          if (!shown || (!/^(data:|blob:)$/.test(url.protocol) && url.origin !== location.origin)) return '';
          if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
          const frame = this._shrink(video, video.videoWidth, video.videoHeight, true);
          if (frame) this._save(key, frame);
          return frame;
        } catch (e) { return ''; } // 失败保持占位，绝不退回外链
      },
      /* 缩略图规格：图片与视频首帧共用同一套尺寸 / 编码参数 / 存储上限 —— 「不同地方的
         视频和图片缩略图走同一套缓存」的前提是它们长一个样，否则同一张网格里清晰度会打架。
         512 够资产库紧凑网格（卡片最宽 ~300px，2x 屏 600 设备像素）用，又不至于把缓存撑爆。 */
      MAXSIDE: 512, Q: 0.72, MAXBYTES: 200 * 1024,
      /* 把已解码的图/帧缩一份存成小图（最长边 MAXSIDE）。
         有透明像素就走 PNG（logo 之类），否则 JPEG；结果过大就不缓存（宁可下次重取，也不塞爆存储）。 */
      _shrink(el, w, h, opaque) {
        const k = Math.min(1, this.MAXSIDE / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) return '';
        if (opaque) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); }
        try { ctx.drawImage(el, 0, 0, cw, ch); } catch (e) { return ''; }
        let out;
        try {
          const d = ctx.getImageData(0, 0, cw, ch).data;
          let alpha = false;
          for (let i = 3; i < d.length; i += 40) { if (d[i] < 250) { alpha = true; break; } }   // 每 10 个像素抽一次
          out = alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', this.Q);
        } catch (e) { return ''; }   // 画布被污染 / 内存不足
        return out.length <= this.MAXBYTES ? out : '';
      },
      /* ---- 图片缩略图：不挡画面，等它自己加载完再缩一份进缓存 ----
         为什么不在渲染时就把 <img> 换成缓存图：原图本来就是最好的显示效果，抢在 onload 前换成
         小图会「先清晰后变糊」。所以只补缓存，命中缓存的下一次渲染（别的页面 / 下次打开）才用小图。 */
      _imgQ: [], _imgBusy: false, _imgSeen: new Set(),
      _watchImg(b) {
        if (this.get(b.key) || b.armed) return;
        b.armed = true;
        const m = b.media;
        const grab = () => this._queueImg(b);
        if (m.complete && m.naturalWidth) { grab(); return; }
        m.addEventListener('load', grab, { once: true });
      },
      _queueImg(b) {
        if (!b || !b.key || this._map.has(b.key) || this._imgSeen.has(b.key)) return;
        if (this._imgSeen.size > 2000) this._imgSeen.clear();
        this._imgSeen.add(b.key);
        this._imgQ.push(b);
        this._pumpImg();
      },
      /* 一次只缩一张，且让出主线程（缩图是同步的 canvas 编码，几十张连做会卡手） */
      _pumpImg() {
        if (this._imgBusy || !this._imgQ.length) return;
        this._imgBusy = true;
        const next = () => {
          this._imgBusy = false;
          const b = this._imgQ.shift();
          if (b) { try { this._grabImg(b); } catch (e) {} }
          if (this._imgQ.length) this._pumpImg();
        };
        if (window.requestIdleCallback) requestIdleCallback(next, { timeout: 1500 }); else setTimeout(next, 60);
      },
      _grabImg(b) {
        const m = b.media, key = b.key;
        if (!key || this._map.has(key) || !m || m.tagName !== 'IMG' || !m.naturalWidth || !m.naturalHeight) return;
        // blob: / data: 这类临时地址（又没有稳定身份键）算出来的键下次命不中，别白占存储
        if (/^(data:|blob:)/i.test(String(b.src || '')) && !/^(fav-file:|local:|asset:)/i.test(b.ident || '')) return;
        const frame = this._shrink(m, m.naturalWidth, m.naturalHeight, false);
        if (frame) this._save(key, frame);
      },
    },

    /* ---------- 任务卡片「详情」面板（资产库 / 图片 / 视频 / 语音共用一份） ----------
       以前四页各写一份 renderDetail + fmtDetail + promptBlockHTML：同一个字段四种解释，
       连「耗时」算法都不一致（VGENV 完成的任务没有 completed_at，只看它会显示成「进行中」）。
       现在统一在这里，页面只提供适配器：
         cfg = {
           prompt(item)     提示词（默认 item.prompt）
           status(item)     状态原文（默认 item.status）
           provider(item)   平台对象（经 Api.pollTask 取详情，认 pollVia；没有就只显示本地信息）
           taskId(item)     平台任务号（空 = 只显示本地信息）
           rows(item, g)    页面专有行 [[标签, 值]]（如音色 / tokens / 服务端润色）
           refs(item, g)    参考图 [{assetId,url,role}]（默认取 g.inputs 里的图片）
           openRef(ids, idx, item, g, refs)  点参考图的查看器（refs = [{assetId,url,role}]，url 优先于 id）
           actions(item, g) 额外按钮 HTML；bindActions(host, item, g) 负责接线
           onData(item, g)  拿到详情后的回调（页面保存当前详情用）
         }
       渲染入口：Wb.detail.render(item, host)（异步、可重复调用；同一任务 60 秒内不重复请求） */
    detail: {
      cfg: {}, _cache: new Map(),
      init(cfg) { this.cfg = cfg || {}; },
      _isFinished(status) { return /succeed|complet|done|fail|cancel/i.test(String(status || '')); },
      async _fetch(item) {
        const c = this.cfg;
        const prov = c.provider ? c.provider(item) : null;
        const id = c.taskId ? c.taskId(item) : '';
        if (!prov || !id || !prov.endpoints) return null;
        /* 走 Api.pollTask：它认 registry 的 pollVia:'list'，详情端点不可用时退回列表按任务号找。
           以前这里按 endpoints.detail/poll 自己拼 —— VGENV 声明了 pollVia:'list'（详情端点是 404 空壳），
           于是卡片「详情」永远只剩本地那几行，上游真实参数/参考素材看不到。 */
        const key = prov.id + '|' + id;
        const hit = this._cache.get(key);
        if (hit && Date.now() - hit.ts < hit.ttl) return hit.g;
        let g = null;
        try { g = (await window.Api.pollTask(prov, id)).raw || null; } catch (e) { return null; }
        if (!g) return null;
        const p = window.Api.parseItem(prov, g);
        if (this._cache.size > 200) this._cache.clear();
        this._cache.set(key, { ts: Date.now(), ttl: this._isFinished(p && p.status) ? 60000 : 5000, g });
        return g;
      },
      _promptHTML(prompt) {
        return '<div class="det-prompt-hd">完整提示词' + (prompt ? '<button class="ghost mini" data-copyprompt>复制</button>' : '') + '</div>'
          + '<div class="det-prompt"' + (prompt ? '' : ' style="color:var(--sub)"') + '>' + esc(prompt || '（无提示词）') + '</div>';
      },
      _shell(prompt) {
        return this._promptHTML(prompt)
          + '<div class="det-sep"></div><div class="det-body">加载详情…</div><div class="det-extra"></div>';
      },
      /* 本机归档的提示词在索引里只存了前 300 字（省内存、省流量，够列表卡片用）：
         详情面板要给人看全文，就按任务号回源取整份再换掉这一段。
         顺带覆盖另一种情况：条目压根没提示词（索引里查不到），但归档文件其实存在（索引只带最近若干条）。 */
      async _upgradePrompt(host, provId, id, shown) {
        if (!window.PromptLog || !id) return;
        let full = '';
        try { full = await PromptLog.findByTask(provId, id); } catch { return; }
        full = String(full || '');
        if (!full || full === shown || !host.isConnected) return;
        const hd = host.querySelector('.det-prompt-hd'), el = host.querySelector('.det-prompt');
        if (!hd || !el) return;
        hd.outerHTML = this._promptHTML(full);
        el.remove();
        const cp = host.querySelector('[data-copyprompt]');
        if (cp) cp.onclick = async e => {
          e.stopPropagation(); e.preventDefault();
          const ok = window.copyText ? await window.copyText(full) : false;
          cp.textContent = ok ? '已复制 ✓' : '复制失败';
          setTimeout(() => { cp.textContent = '复制'; }, 1300);
        };
      },
      _defaultRefs(g) {
        return ((g && g.inputs) || []).filter(i => i && (i.role === 'reference_image' || i.role === 'first_frame'
          || i.role === 'last_frame' || i.media_type === 'image'))
          .map(i => ({ assetId: i.asset_id || i.assetId, url: i.url, role: i.role || '参考图' }));
      },
      /* 行数据：先放「本地记录里就有的」，拿到上游详情后再补「只有接口才知道的」 */
      /* 行数据：**只显示这条任务真的有的字段** ——
         上游详情优先（它给的是实际请求值），本地记录兜底；
         空值 / 空数组 / 平台占位值（none / auto）一律不显示，
         参数里已展示过的字段（比例/分辨率/时长…）不再重复出现。 */
      _rows(item, g) {
        const c = this.cfg, it = item || {}, rows = [];
        const pm = (g && g.parameters) || {};
        const seen = new Set();
        const NOISE = new Set(['none', 'auto', 'null', 'undefined', 'n/a', 'na', '-']);
        const push = (k, v) => {
          if (v === '' || v == null) return;
          if (Array.isArray(v) && !v.length) return;                 // 空数组（如没有资产 ID）不占一行
          if (typeof v === 'number' && Number.isNaN(v)) return;
          if (typeof v === 'string' && NOISE.has(v.trim().toLowerCase())) return;
          if (seen.has(k)) return;                                    // 同名行只留第一条
          seen.add(k);
          rows.push([k, v]);
        };
        const QZ = { draft: '草稿', standard: '标准', final: '精修' };
        const MODE_ZH = { text_to_image: '文生图', image_edit: '参考图编辑', text_to_video: '文生视频',
          first_last_frame: '首尾帧', reference_images: '参考图', reference_video: '参考视频', reference_audio: '参考音频' };
        const P_ZH = { aspect_ratio: '比例', quality: '画质', resolution: '分辨率', output_count: '数量',
          duration: '时长', output_format: '格式', optimize_prompt: '优化提示词', width: '宽', height: '高', seed: '种子' };
        const T_ZH = { duration: '时长', resolution: '分辨率', aspect_ratio: '比例', progress: '进度(%)',
          queue_position: '队列位置', note: '备注', priority: '优先级', webhook: '回调' };
        /* 平台返回但「对人没用」的字段：对象类型名、内部 id、原始时间戳 */
        const T_SKIP = new Set(['object', 'source', 'route_goal', 'workspace_id', 'user_id', 'project_id',
          'revision', 'api_version', 'status_code', 'metadata', 'optimized_prompt', 'id', 'prompt',
          'inputs', 'input', 'outputs', 'output', 'parameters',
          /* 原始时间戳：上面已经用「创建时间 / 耗时 / 完成时间」表达过了，再列 ISO 串只是噪音 */
          'created_at', 'completed_at', 'updated_at', 'queued_at', 'started_at', 'finished_at', 'expires_at',
          'download_expires_at', 'uploaded_at', 'expires']);
        const isTypeName = v => typeof v === 'string' && /^(video|image|audio|list|asset|generation|job)./.test(v);
        const upParam = k => (pm[k] != null && !isTypeName(pm[k]) ? pm[k] : undefined);
        const fmtT = t => (t ? new Date(t).toLocaleString() : '');
        const finished = g ? this._isFinished(g.status) : false;
        const rawStatus = g ? g.status : (c.status ? c.status(item) : it.status);

        push('状态', ST[rawStatus] || rawStatus);
        push('模型', (g && g.model) || it.model);
        push('平台', it.providerName);
        push('类型', it.type);
        push('模式', g && (MODE_ZH[g.mode] || g.mode));
        push('档位', (g && g.tier) || it.tier);
        push('格式', String(it.format || upParam('output_format') || '').toUpperCase());
        push('比例', it.ar || upParam('aspect_ratio'));
        push('分辨率', it.res || upParam('resolution'));
        const qv = it.quality || upParam('quality');
        push('画质', qv ? (QZ[qv] || qv) : '');
        /* 时长：上游参数优先（那是实际请求值），本地记录兜底；两者只留一行 */
        const durUp = upParam('duration');
        const dur = durUp != null ? durUp : (it.duration != null ? it.duration : it.dur);
        push('时长', (dur != null && dur !== '') ? dur + ' 秒' : '');
        push('数量', upParam('output_count'));
        push('大小', it.size ? window.Wb.fmtSize(it.size) : '');
        const cost = (window.AssetLib && AssetLib.costOf) ? AssetLib.costOf(it) : { cost: null, unit: '' };
        push('费用', it.priceText || (cost.cost != null ? (cost.unit === '元' ? '¥' + Number(cost.cost).toFixed(4) : cost.cost + ' ' + cost.unit) : ''));
        if (g && g.credits) push('积分', (g.credits.charged ?? 0) + ' 已扣 / ' + (g.credits.held ?? 0) + ' 冻结');
        const micros = g ? ((g.price && g.price.amount_micros) ?? g.amount_micros) : null;
        if (micros != null) push('费用', '¥' + (Number(micros) / 1e6).toFixed(4));
        push('创建时间', (g && g.created_at) ? fmtT(g.created_at) : (it.ts ? new Date(it.ts).toLocaleString() : ''));
        if (g && g.created_at) {
          /* 是否跑完要看**状态**，不能只看 completed_at —— VGENV 完成的任务只给 updated_at */
          const endAt = g.completed_at || g.updated_at;
          const end = (finished && endAt) ? new Date(endAt) : new Date();
          const sec = Math.max(0, Math.round((end - new Date(g.created_at)) / 1000));
          const txt = sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + sec % 60 + ' 秒' : sec + ' 秒';
          push('耗时', txt + ((finished && endAt) ? '' : '（进行中）'));
          push('完成时间', finished ? fmtT(endAt) : '');
        }
        if (c.rows) (c.rows(item, g) || []).forEach(r => push(r[0], r[1]));
        if (!g) { push('错误', it.error || it.failMsg); return rows; }
        /* 剩下的参数与顶层标量：只补还没出现过的，且跳过噪音字段 */
        Object.entries(pm).forEach(([k, v]) => {
          if (v == null || typeof v === 'object' || isTypeName(v) || T_SKIP.has(k)) return;
          if (k === 'progress' && finished) return;                   // 已完成还显示「进度 100%」没意义
          push(P_ZH[k] || T_ZH[k] || k, v);
        });
        Object.entries(g).forEach(([k, v]) => {
          if (v == null || typeof v === 'object' || T_SKIP.has(k) || isTypeName(v)) return;
          if (k === 'status' || k === 'model' || k === 'mode' || k === 'tier' || k === 'error') return;
          if (k === 'progress' && finished) return;                   // 已完成还显示「进度 100%」没意义
          push(T_ZH[k] || k, v);
        });
        const outs = g.outputs || [];
        const sizes = outs.map(o => (o && o.byte_length ? window.Wb.fmtSize(o.byte_length) : '')).filter(Boolean);
        if (sizes.length) push('大小', sizes.join(' / '));
        const outIds = outs.map(o => o && o.asset_id).filter(Boolean);
        push('资产ID', outIds.length ? outIds : (it.assetId ? [it.assetId] : []));
        if (g.error) push('错误', (g.error && (g.error.message || g.error.code)) || JSON.stringify(g.error));
        push('任务ID', g.id || it.genId || it.vid || it.gen_id || '');
        return rows;
      },
      _rowsHTML(rows) {
        return (rows || []).map(r => {
          const v = Array.isArray(r[1])
            ? '<span class="det-ids">' + r[1].map(x => '<span class="did" data-id="' + esc(String(x)) + '" title="点击复制">' + esc(String(x)) + '</span>').join('') + '</span>'
            : esc(String(r[1]));
          return '<div class="det-row"><span class="k">' + esc(r[0]) + '</span><span>' + v + '</span></div>';
        }).join('');
      },
      _extraHTML(item, g) {
        const c = this.cfg;
        const refs = c.refs ? (c.refs(item, g) || []) : this._defaultRefs(g);
        let html = '';
        if (refs.length) {
          html += '<div class="det-k">参考图 / 输入图（' + refs.length + '）</div><div class="det-refs">'
            + refs.map((r, i) => {
              const src = r.assetId ? '/asset/' + r.assetId + '?v=2' : ((window.Api && Api.mediaSrc) ? Api.mediaSrc(r.url || '') : (r.url || ''));
              return '<img src="' + esc(src) + '" data-i="' + i + '" title="' + esc(r.role || '参考图') + '">';
            }).join('') + '</div>';
        }
        if (c.actions) {
          const a = c.actions(item, g);
          if (a) html += '<div class="det-sep"></div><div class="det-acts">' + a + '</div>';
        }
        return html;
      },
      _bind(host, item, g) {
        const c = this.cfg;
        const cp = host.querySelector('[data-copyprompt]');
        if (cp) cp.onclick = async e => {
          e.stopPropagation(); e.preventDefault();
          const txt = (host.querySelector('.det-prompt') || {}).textContent || '';
          if (!txt || txt === '（无提示词）') return;
          const ok = window.copyText ? await window.copyText(txt) : false;
          cp.textContent = ok ? '已复制 ✓' : '复制失败';
          setTimeout(() => { cp.textContent = '复制'; }, 1300);
        };
        host.querySelectorAll('.did').forEach(el => {
          el.onclick = async e => {
            e.stopPropagation();
            try { await navigator.clipboard.writeText(el.dataset.id || ''); el.title = '已复制 ✓'; }
            catch (err) { el.title = '复制失败'; }
          };
        });
        const imgs = [...host.querySelectorAll('.det-refs img')];
        if (imgs.length && c.openRef) {
          const refs = c.refs ? (c.refs(item, g) || []) : this._defaultRefs(g);
          /* 第 5 个参数把 refs 原样给页面：里面可能带 url（别家平台的参考图没有本家 asset_id，
             只给 id 就只能去 /asset/<id> 撞运气，多半是 404）。 */
          imgs.forEach((im, i) => im.onclick = e => { e.stopPropagation(); c.openRef(refs.map(r => r.assetId).filter(Boolean), i, item, g, refs); });
        }
        if (c.bindActions) c.bindActions(host, item, g);
      },
      /* 进行中的任务：耗时每秒跳一下（只看本地状态，不需要再请求接口） */
      _liveDuration(host, item, g) {
        if (host._detTimer) { clearInterval(host._detTimer); host._detTimer = null; }
        if (!g || !g.created_at || this._isFinished(g.status)) return;
        const row = [...host.querySelectorAll('.det-row')].find(r => {
          const k = r.querySelector('.k');
          return k && k.textContent === '耗时';
        });
        if (!row) return;
        const cell = row.lastElementChild;
        const hidden = el => { for (let n = el; n; n = n.parentElement) { if (n.hidden) return true; } return false; };
        host._detTimer = setInterval(() => {
          if (!host.isConnected || hidden(host)) { clearInterval(host._detTimer); host._detTimer = null; return; }
          const sec = Math.max(0, Math.round((Date.now() - new Date(g.created_at)) / 1000));
          cell.textContent = (sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + sec % 60 + ' 秒' : sec + ' 秒') + '（进行中）';
        }, 1000);
      },
      async render(item, host) {
        if (!host || !item) return;
        const c = this.cfg;
        const prompt = String((c.prompt ? c.prompt(item) : item.prompt) || '');
        host.innerHTML = this._shell(prompt);
        /* 提示词来自本机归档（平台接口不返回它）→ 索引里那份只有 300 字，回源补全文 */
        if (item.promptLocal || !prompt) {
          const id = c.taskId ? c.taskId(item) : (item.genId || item.id || '');
          this._upgradePrompt(host, item.provider, id, prompt);
        }
        const body = host.querySelector('.det-body');
        const extra = host.querySelector('.det-extra');
        let g = null, err = '';
        try { g = await this._fetch(item); }
        catch (e) { err = '详情接口读取失败：' + e.message + '（以下为本地记录）'; }
        if (!host.isConnected) return;          // 面板已经关掉/重画了
        body.innerHTML = (err ? '<div class="det-row"><span class="k">详情</span><span>' + esc(err) + '</span></div>' : '')
          + this._rowsHTML(this._rows(item, g));
        extra.innerHTML = this._extraHTML(item, g);
        this._bind(host, item, g);
        this._liveDuration(host, item, g);
        if (c.onData) { try { c.onData(item, g); } catch (e) {} }
      },
    },

    /* ---------- 产物取回与保存（统一先判 HTTP 状态，不再把错误页存成成品） ---------- */
    blob(url, opts) { return window.Net.blob(url, { timeout: 180000, ...(opts || {}) }); },

    /* 保存到「设置 → 目录」；没配目录就退回浏览器下载 */
    async save(url, name) {
      const b = await this.blob(url);
      return await this._toDir(name, b);
    },
    /* 每次弹保存位置 */
    async saveAs(url, name) {
      const b = await this.blob(url);
      return await this._toDir(name, b, true);
    },
    async _toDir(name, blob, forceAs) {
      // 页面可以挂 WbSaveHook 接管保存（例如图片台用 File System Access API 写目录）；
      // 没挂就用浏览器下载，行为一致、不再各写一套 fetch+blob。
      const hook = window.WbSaveHook || {};
      if (forceAs && typeof hook.asOnce === 'function') {
        try { return await hook.asOnce(name, blob); } catch (e) { if (e && e.name === 'AbortError') return { ok: false, canceled: true }; }
      } else if (!forceAs && typeof hook.toDir === 'function') {
        try { return await hook.toDir(name, blob); }
        catch (e) { if (e && e.name === 'AbortError') return { ok: false, canceled: true }; /* 目录没配 → 退回下载 */ }
      }
      window.Net.save(blob, name);
      return { ok: true, fallback: true };
    },

    /* ---------- 卡片动作区：三台同一套按钮、同一套顺序 ---------- */
    /* o = { preview, download, cancel, retry, remove, removeFile, retryTitle } */
    actsHTML(t, o = {}) {
      const run = this.isRunning(t), failed = this.isFailed(t);
      const hasMedia = !!o.preview;
      const B = [];
      B.push('<button class="ghost dt">详情</button>');
      if (hasMedia) B.push('<button class="ghost pv">' + icon('play', 12) + ' ' + esc(o.previewLabel || '预览') + '</button>');
      if (hasMedia && o.download !== false) {
        B.push('<button class="ghost dl2" title="保存到「设置 → 目录」">保存</button>');
        B.push('<button class="ghost sv2" title="每次选择保存位置">⤓ 另存为</button>');
      }
      if (run && o.cancel) B.push('<button class="ghost danger cx">取消</button>');
      if (failed && o.retry && o.canRetry !== false) B.push('<button class="ghost rt">' + icon('refresh', 12) + ' 重试</button>');
      if (o.remove) B.push('<button class="ghost danger del">删除记录</button>');
      if (o.removeFile) B.push('<button class="ghost danger delfile" title="删除本机文件（上游没有资产存储）">删除文件</button>');
      return B.join('');
    },
    /* 给动作区接线。回调都由页面提供，但「取消 / 删除」的确认、报错、按钮忙碌态在这里统一处理 */
    bindActs(el, t, o = {}) {
      const q = s => el.querySelector(s);
      const on = (sel, fn) => { const b = q(sel); if (b) b.onclick = e => { e.stopPropagation(); e.preventDefault(); fn(b); }; };

      on('.dt', () => o.onDetail && o.onDetail());
      on('.pv', () => o.onPreview && o.onPreview());
      const busy = async (btn, busyText, fn) => {
        const old = btn.innerHTML;
        btn.disabled = true; btn.textContent = busyText;
        try { await fn(); }
        catch (e) { window.Toast.err(e && e.message ? e.message : e); }
        finally { btn.disabled = false; btn.innerHTML = old; }
      };
      on('.dl2', btn => busy(btn, '保存中…', () => this.save(o.dlUrl || t.dl || t.media, o.fileName || 'download')));
      on('.sv2', btn => busy(btn, '另存中…', () => this.saveAs(o.dlUrl || t.dl || t.media, o.fileName || 'download')));

      on('.cx', async btn => {
        const ok = await window.Confirm.ask({
          title: '取消这个任务？', danger: true, okLabel: '取消任务', cancelLabel: '继续等',
          body: '取消后会通知平台停止生成。已经产生的部分可能仍会计费。',
        });
        if (!ok) return;
        await busy(btn, '取消中…', async () => {
          // 取消失败必须让用户知道（以前是静默吞掉、界面还谎报「已取消」）
          if (o.onCancel) await o.onCancel(t);
        });
      });

      on('.rt', btn => busy(btn, '重试中…', async () => {
        if (!o.onRetry) return;
        await o.onRetry(t);
      }));

      on('.del', async () => {
        const ok = await window.Confirm.ask({
          title: '删除这条记录？', danger: true, okLabel: '删除', 
          body: '只删本地这条记录（平台上的任务与已生成的文件不受影响）。',
        });
        if (ok && o.onRemove) o.onRemove(t);
      });
      on('.delfile', async () => {
        const ok = await window.Confirm.ask({
          title: '删除本机文件？', danger: true, okLabel: '删除文件',
          body: '这个产物存在本机（.assets 目录），删除后不可恢复。',
        });
        if (ok && o.onRemoveFile) await o.onRemoveFile(t);
      });
      return el;
    },

    /* ---------- 轮询器 ---------- */
    /* 统一了三个台各自的轮询行为：
         · 没有进行中的任务 → 完全不发请求（不再每 3 秒空转）
         · 连续失败 3 次 → 提示一次并退避到最长 30 秒（网络/代理断了会明确告诉你）
         · 切到别的标签页 → 暂停；切回来立刻补一次
         · 只有状态真的变了才回调 onChange（避免整列表反复重绘） */
    poller(o) {
      /* 设置页的「任务刷新间隔」优先于页面写死的 interval：
         以前是 interval || 设置值，而三个工作台与资产库都传了固定值，那项设置形同虚设。 */
      const ivSec = Number(localStorage.getItem('sk_poll_sec'));
      const interval = (Number.isFinite(ivSec) && ivSec >= 2) ? Math.min(60, ivSec) * 1000 : (o.interval || 4000);
      const label = o.label || '任务';
      let timer = null, fails = 0, warned = false, stopped = false, ticking = false;
      const taskFails = new WeakMap();       // 单任务连续失败计数（只提示一次）
      const host = (o.host || document);
      const delay = () => Math.min(interval * Math.pow(2, Math.max(0, fails - 2)), 30000);

      const runningList = () => (o.tasks() || []).filter(t => o.isRunning(t) && (o.filter ? o.filter(t) : true));

      async function tick() {
        if (stopped || ticking) return;
        if (document.hidden) return schedule();          // 看不见就不轮询
        const rs = runningList();
        if (!rs.length) { fails = 0; return schedule(); }
        ticking = true;
        let dirty = false;
        const results = await Promise.allSettled(rs.map(async t => {
          const before = o.sig ? o.sig(t) : t.status;
          await o.pollOne(t);
          const after = o.sig ? o.sig(t) : t.status;
          if (before !== after) dirty = true;
        }));
        ticking = false;
        const bad = results.filter(r => r.status === 'rejected');
        if (bad.length && bad.length === results.length) {
          fails++;
          if (fails >= 3 && !warned) {
            warned = true;
            window.Toast.warn(`${label}状态刷新连续失败：${bad[0].reason && bad[0].reason.message ? bad[0].reason.message : '网络异常'}（会自动重试）`);
          }
        } else { fails = 0; warned = false; }
        /* 单任务持续失败也要说一声：以前只统计「全军覆没」，
           某一条任务的详情端点坏了（例如 404 / 上游改了形状）时，它会永远转圈、界面却一声不吭。 */
        results.forEach((r, i) => {
          const t = rs[i];
          if (!t) return;
          if (r.status === 'rejected') {
            const n = (taskFails.get(t) || 0) + 1;
            taskFails.set(t, n);
            if (n === 3) {
              const msg = (r.reason && r.reason.message) ? r.reason.message : '上游没有返回状态';
              window.Toast.warn(`${label}：有一条任务连续 ${n} 次刷新失败：${msg}（会继续自动重试）`);
            }
          } else taskFails.delete(t);
        });
        if (dirty && o.onChange) { try { o.onChange(); } catch (e) { console.warn('[Wb] onChange 出错：', e); } }
        schedule();
      }
      function schedule() {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(tick, delay());
      }
      function onVisible() { if (!document.hidden) { fails = 0; tick(); } }
      host.addEventListener('visibilitychange', onVisible);
      window.addEventListener('beforeunload', () => { stopped = true; clearTimeout(timer); });

      schedule();
      return {
        tick,
        stop() { stopped = true; clearTimeout(timer); host.removeEventListener('visibilitychange', onVisible); },
        kick() { clearTimeout(timer); tick(); },
      };
    },

    /* ---------- 搜索框旁的说明：视频 / 语音台只能过滤「已加载」的条目 ---------- */
    searchNote(n) {
      return n + ' 条已加载（搜索只筛已加载的内容，翻页可加载更多）';
    },

    /* ---------- 列表「部分来源没取回来」的提示条 ----------
       平台列表接口一慢/一挂，右栏最容易的表现是「静默变空」或「只剩一半卡片」，
       用户不知道是没数据还是没取到。errs 是 { 来源: 错误文字 }，没有失败时返回 ''。
       配合 Wb.cards 的 notesHTML 用（约定容器带 .list-note 类，才能被原地替换/移除）；
       重试按钮的 id 由页面自己事件委托去接（列表是重建出来的，绑不上一次性监听）。 */
    loadNote(errs, retryId) {
      const ks = Object.keys(errs || {});
      if (!ks.length) return '';
      const detail = ks.slice(0, 3).map(k => this.esc(k) + '：' + this.esc(String(errs[k] || '读取失败'))).join('；')
        + (ks.length > 3 ? ' 等 ' + ks.length + ' 个平台' : '');
      return '<div class="list-note"><span class="txt">有 ' + ks.length + ' 个平台的任务这次没取回来（'
        + detail + '）。下面显示的是已经取到的部分。</span>'
        + '<button class="ghost mini" id="' + (retryId || 'listRetry') + '">重试</button></div>';
    },

    /* ---------- 任务卡片列表（右栏）：按键复用 DOM、指纹变了才重绘 ----------
       这一层原来三个台各写一份（「列表里不再有的卡片怎么移除」都写得不一样，图片台还有
       一张卡片逃出轮询的 bug —— 见 addGalleryItem 的注释）。现在统一在这里，页面只提供适配器：
         box        容器元素或 id
         keyOf(item)  稳定键（同一个条目两次渲染必须得到同一个键）
         sigOf(item)  指纹：变了才重绘这一张（避免轮询/翻页把整列重建）
         htmlOf(item) 卡片 innerHTML
         bind(el,item)     新建后绑定交互（按钮、展开状态恢复…）
         paint(el,item)    重绘已有卡片（默认 htmlOf + bind；页面想复用媒体节点就自己实现）
         emptyHTML()       空态 HTML
         notesHTML()       列表上方的提示条（如「无效记录」）：返回 '' 表示没有
       用法：const list = Wb.cards.create({...}); list.paint(items); */
    cards: {
      create(o) {
        const els = new Map();
        const box = (typeof o.box === 'string') ? document.getElementById(o.box) : o.box;
        const sigOf = o.sigOf || (() => '');
        const paint = (el, it) => {
          if (o.paint) o.paint(el, it);                      // 页面自己画（可复用媒体节点）
          else { el.innerHTML = o.htmlOf(it); if (o.bind) o.bind(el, it); }
        };
        return {
          els, box,
          el: key => els.get(String(key)),
          count: () => els.size,
          /* 全量对齐：位置没变就不动 DOM（缩略图不重解码、不闪） */
          paint(items) {
            const list = items || [];
            if (!list.length) {
              els.clear();
              box.innerHTML = (o.emptyHTML ? o.emptyHTML() : '<div class="empty">暂无内容</div>') + (o.notesHTML ? o.notesHTML() : '');
              return;
            }
            box.querySelectorAll('.empty').forEach(e => e.remove());
            if (o.notesHTML) {
              const html = o.notesHTML();
              const note = box.querySelector('.list-note');
              if (note) { if (html) note.outerHTML = html; else note.remove(); }
              else if (html) box.insertAdjacentHTML('afterbegin', html);
            }
            let ref = box.querySelector('.task');
            for (const it of list) {
              const key = String(o.keyOf(it));
              let el = els.get(key);
              if (!el) {
                el = document.createElement('div');
                el.className = 'task';
                el.dataset.tkey = key;
                els.set(key, el);
                paint(el, it);                                  // 新建也走页面的 paint：样式与重绘完全一致
                el._sig = sigOf(it);
                el._item = it;
                if (o.onNew) o.onNew(el, it);
              } else {
                el._item = it;
                if (el._sig !== sigOf(it)) { paint(el, it); el._sig = sigOf(it); }
              }
              if (el === ref) ref = ref.nextElementSibling;
              else box.insertBefore(el, ref);
            }
            while (ref) {
              const nx = ref.nextElementSibling;
              if (ref.classList && ref.classList.contains('task')) {
                if (ref.dataset && ref.dataset.tkey) els.delete(ref.dataset.tkey);
                ref.remove();
              }
              ref = nx;
            }
          },
          /* 单条重绘（页面在别处改了条目状态时用） */
          repaint(item) {
            const el = els.get(String(o.keyOf(item)));
            if (el) { paint(el, item); el._sig = sigOf(item); }
          },
          clear() { els.clear(); box.innerHTML = ''; },
        };
      },
    },

    /* ---------- 右栏分页 / 动态加载（三个工作台共用一份口径） ----------
       两种模式：
         'page'  上一页 / 下一页 + 「第 N 页 / 共 M 页」
         'more'  滚到底自动续拉（翻页按钮隐藏，避免一出一隐把右边那排挤动），
                 但**页数照样显示** —— 按已加载条数折算成第几页
       页面提供：items()（已加载的全部条目）、hasMore()、render()（重画列表）、
                fill()（把当前页需要的条目补齐，通常是「继续拉服务端列表」）、
                total()（可选：后台数准的平台总条数，没数准返回 0/null）
       搜索说明（「只筛已加载」）由本模块挂在 pgInfo 的 title 上，页面不用各写一份。 */
    pager: {
      /* 分页信息文案（唯一一份）：图片台自己的游标分页也用它，三个台的文字不会各写各的。
         平台的列表接口只有游标和 has_more，**根本没有任务总数**（SparkCine / VGENV 实测都一样），
         所以「共 M 页」有两种来历：
           ① 页面后台把游标翻到底数准了（Wb.tally / AssetLib.countAll）→ 传 total，显示精确的「共 M 页」；
           ② 还没数准（首屏刚打开、或数到一半超了轮数上限）→ 只能按**已经取回本地的条数**折算，
              后面还有内容就标加号（共 M+ 页），取完了才不带。
         收藏 / 资产库是本地全量，总数一开始就是准的。 */
      infoText({ mode, page, loaded, pageSize, hasMore, total }) {
        const size = Math.max(1, Number(pageSize) || 20);
        const n = Math.max(0, Number(loaded) || 0);
        const cur = mode === 'more' ? Math.max(0, Math.ceil(n / size) - 1) : Math.max(0, Number(page) || 0);
        const t = Number(total) > 0 ? Math.max(Number(total), n) : 0;   // 数准的总数不会比已经拿到的还少
        const pages = Math.max(1, Math.ceil((t || n) / size));
        return '第 ' + (cur + 1) + ' 页 / 共 ' + pages + (!t && hasMore ? '+' : '') + ' 页';
      },
      create(o) {
        const mode = o.mode === 'more' ? 'more' : 'page';
        const PAGE_SIZE = Math.max(1, Number(o.pageSize) || 20);
        const el = id => document.getElementById(o[id + 'Id'] || id);
        let page = 0;
        let reqSeq = 0;        // 翻页/续拉的代际号：慢的旧请求回来时用它作废
        let filling = false;   // 动态加载的单飞锁
        const api = {
          mode, PAGE_SIZE,
          get page() { return page; },
          setPage(n) { page = Math.max(0, (Number(n) || 0) | 0); },
          /* 当前页要显示的条目 */
          slice(all) {
            const list = all || o.items() || [];
            if (mode === 'more') return list;
            const total = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
            if (page > total - 1) page = total - 1;
            return list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
          },
          update() {
            const list = o.items() || [];
            const info = el('pgInfo');
            if (!info) return;
            const prev = el('pgPrev'), next = el('pgNext');
            if (mode === 'more') {
              /* 动态加载模式没有翻页按钮（避免按钮一出一隐把右边那排挤动），
                 但**当前页数照样显示** —— 按已加载条数折算成第几页 */
              if (prev) prev.style.display = 'none';
              if (next) next.style.display = 'none';
            } else {
              if (prev) { prev.style.display = ''; prev.disabled = page <= 0; }
              /* 「下一页」在最后一页要禁用：以前只禁用上一页，末页点下一页会把页码 clamp 回原地，
                 按钮看着能点却什么都不发生（收藏页只有几条时尤其明显）。
                 服务端分页（有 fill/hasMore）时没取完就还允许点，点了由 fill 去补。 */
              if (next) {
                next.style.display = '';
                const more = o.hasMore ? !!o.hasMore() : false;
                next.disabled = !more && page >= Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1);
              }
            }
            info.textContent = window.Wb.pager.infoText({
              mode, page, loaded: list.length, pageSize: PAGE_SIZE,
              hasMore: o.hasMore ? !!o.hasMore() : false,
              /* 后台数准的总条数（Wb.tally）：数好了才传，正在搜的时候不传 ——
                 搜索只筛**已经加载到本地**的条目，平台总数跟筛选结果没关系，用它折页数会骗人。 */
              total: (o.searchQ && o.searchQ()) ? 0 : (o.total ? Number(o.total()) || 0 : 0),
            });
            if (o.searchQ && o.searchQ()) info.title = window.Wb.searchNote(list.length);
            else info.removeAttribute('title');
          },
          /* 跳页：先把这一页需要的条目补齐（fill），再重画。
             连点页码 / 边滚边点时会有好几个 fill 在途，慢的那个晚回来会把新页覆盖掉，
             所以每次跳页都领一个代际号，回来发现已经不是最新的一次就什么都不做。 */
          async go(n) {
            const target = Math.max(0, n);
            const g = ++reqSeq;
            if (target > 0 && mode === 'page') {
              // 目标页需要 (target+1)*PAGE_SIZE 条：交给页面的 fill 去拉
              if (o.fill) { try { await o.fill(target + 1); } catch (e) { if (g !== reqSeq) return; throw e; } }
            }
            if (g !== reqSeq) return;
            api.setPage(target);
            if (o.render) o.render();
          },
          /* 首屏/刷新后：补到至少 n 页（动态加载模式下「一屏没填满就继续拉」也用它） */
          async ensureFilled(n) {
            const g = ++reqSeq;
            if (o.fill) { try { await o.fill(n || 1); } catch (e) {} }
            if (g !== reqSeq) return;
            if (o.render) o.render();
          },
          /* 滚到底自动续拉（动态加载模式）：内容不足一屏时也会继续拉，直到拉满或到底 */
          bindScroll(boxSel) {
            const box = (typeof boxSel === 'string') ? document.getElementById(boxSel) : (boxSel || o.box);
            if (!box || box._pagerBound) return;
            box._pagerBound = true;
            box.addEventListener('scroll', () => {
              if (mode !== 'more' || filling || !o.hasMore || !o.hasMore()) return;
              if (box.scrollTop + box.clientHeight >= box.scrollHeight - 160) {
                if (!o.fill) return;
                // 单飞：一次滚动会连发几十个 scroll 事件，别把同一个续拉排成一串
                filling = true;
                const g = ++reqSeq;
                Promise.resolve(o.fill())
                  .then(() => { if (g === reqSeq && o.render) o.render(); })
                  .catch(() => {})
                  .then(() => { filling = false; });
              }
            });
          },
          bindButtons() {
            const prev = el('pgPrev'), next = el('pgNext');
            if (prev) prev.onclick = () => api.go(page - 1);
            if (next) next.onclick = () => api.go(page + 1);
          },
          /* 搜索框回车 / 跳页输入 */
          gotoInput(inputId) {
            const inp = document.getElementById(o[inputId] || inputId);
            if (!inp) return;
            const v = Math.max(1, Math.floor(Number(inp.value) || 1)) - 1;
            inp.value = '';
            api.go(v);
          },
        };
        return api;
      },
    },

    /* ---------- 后台数总数（三个工作台共用一份） ----------
       平台没有「总条数」接口，要显示精确的「共 N 页」只能自己把游标一路翻到底数。
       这件事**不挡首屏**：页面照常先显示「共 M+ 页」，后台数完了回调里重画列表，
       文案就变成精确的「共 N 页」。规则：
         · 单飞 —— 首屏、刷新、提交后都会叫它，同一时刻只跑一趟（重复调用共享同一个 Promise）；
         · run(true) 强制重数：重数期间先按「还没数准」处理（value() 返回 0），
           不要把上一个快照当成现在的准数；
         · 数不完（超过页数上限 / 某个来源读失败）→ 继续带加号，不给「已经数完」的假承诺；
         · 不做 +1/-1 的猜测式校正 —— 新建的任务在完成前只算 1 条、完成后变成 N 条产物，
           猜一个数不如回头再数一趟（一趟也就两三个请求），所以提交/删除后调 run(true)。
       用法：const tally = Wb.tally(() => AssetLib.countAll({ accept: e => e.type === '视频' }));
             tally.onDone.push(() => renderAll());
             const pager = Wb.pager.create({ …, total: () => tally.value() });  tally.run(); */
    tally(count) {
      let res = { total: 0, exact: false };
      let p = null, again = false;
      const api = {
        run(force) {
          if (p) { if (force) again = true; return p; }   // 正在数：强制请求先记账，这趟结束再补一趟
          if (force) res = { total: res.total, exact: false };   // 重数期间先退回「共 M+ 页」，别显示旧总数
          p = Promise.resolve().then(() => count()).then(r => {
            res = { total: Math.max(0, Number(r && r.total) || 0), exact: !!(r && r.exact) };
          }, e => {
            console.warn('[Wb.tally] 后台数总数失败：', (e && e.message) || e);
            res = { total: res.total, exact: false };
          }).then(() => {
            p = null;
            api.onDone.forEach(fn => { try { fn(); } catch (e) { console.warn('[Wb.tally] 数完后的回调出错：', e); } });
            if (again) { again = false; api.run(true); }
          });
          return p;
        },
        /* 数准了才给数字（没数准返回 0，分页文案据此退回带加号的折算值） */
        value() { return res.exact ? res.total : 0; },
        onDone: [],
      };
      return api;
    },

    /* ---------- 展示样式切换（资产库 / 我的收藏共用） ----------
       两处以前各写一份图标 + localStorage 读写 + 高亮逻辑，现在只留这一份。
       用法：const vt = Wb.viewToggle.create({ el:'fView', key:'dir_asset_view',
              views:[['card','卡片', Wb.viewToggle.ROWS], ['compact','紧凑', Wb.viewToggle.GRID]],
              onPick: v => render() });
       vt.value 取当前值；坏值/旧值一律回落到第一档。样式（.viewtoggle）在 ui.css。 */
    viewToggle: {
      ROWS: '<svg width="15" height="15" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="0.6" y="1" width="12.8" height="3.2" rx="1.2"/><rect x="0.6" y="5.4" width="12.8" height="3.2" rx="1.2"/><rect x="0.6" y="9.8" width="12.8" height="3.2" rx="1.2"/></svg>',
      GRID: '<svg width="15" height="15" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="0.6" y="0.6" width="5.6" height="5.6" rx="1.4"/><rect x="7.8" y="0.6" width="5.6" height="5.6" rx="1.4"/><rect x="0.6" y="7.8" width="5.6" height="5.6" rx="1.4"/><rect x="7.8" y="7.8" width="5.6" height="5.6" rx="1.4"/></svg>',
      DENSE: '<svg width="15" height="15" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="0.6" y="0.6" width="3.6" height="3.6" rx="1"/><rect x="5.2" y="0.6" width="3.6" height="3.6" rx="1"/><rect x="9.8" y="0.6" width="3.6" height="3.6" rx="1"/><rect x="0.6" y="5.2" width="3.6" height="3.6" rx="1"/><rect x="5.2" y="5.2" width="3.6" height="3.6" rx="1"/><rect x="9.8" y="5.2" width="3.6" height="3.6" rx="1"/><rect x="0.6" y="9.8" width="3.6" height="3.6" rx="1"/><rect x="5.2" y="9.8" width="3.6" height="3.6" rx="1"/><rect x="9.8" y="9.8" width="3.6" height="3.6" rx="1"/></svg>',
      create(o) {
        const el = typeof o.el === 'string' ? document.getElementById(o.el) : o.el;
        if (!el) return null;
        const views = (o.views && o.views.length ? o.views : [['card', '卡片', this.ROWS], ['compact', '紧凑', this.GRID]]);
        const key = o.key || 'wb_view';
        let val = views[0][0];
        try { const s = localStorage.getItem(key); if (s && views.some(v => v[0] === s)) val = s; } catch (e) {}
        const paint = () => {
          el.classList.add('viewtoggle');
          el.setAttribute('role', 'group');
          el.setAttribute('aria-label', o.label || '展示样式切换');
          el.innerHTML = views.map(([v, t, ic]) =>
            `<button type="button" class="${val === v ? 'active' : ''}" data-v="${v}" title="展示样式：${t}" aria-label="${t}">${ic}</button>`).join('');
          el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
            if (val === b.dataset.v) return;
            val = b.dataset.v;
            try { localStorage.setItem(key, val); } catch (e) {}
            paint();
            if (o.onPick) o.onPick(val);
          });
        };
        paint();
        return { get value() { return val; }, paint };
      },
    },

    /* ---------- 可拖拽分栏（三个工作台 + 导演台） ----------
       拖拽条的 DOM 由这里创建：页面只要保证容器定位过（position:relative）、栏宽走 CSS 变量。
       三个工作台共用一个存储键 wb_split —— 任意一页拖过一次，另外两页立刻同宽，切页栏宽不再跳
       （这是「三页右栏必须同宽」那条约定的延续）。
       用法：Wb.split.enable({ box:'.layout', key:'wb_split',
              cols:[{ el:'.col-left' }, { el:'.col-right' }],
              handles:[{ left:0, right:1, resize:0, varName:'sp0', min:300, max:900 }] })
       handles 里 resize 指「拖这条时改哪一栏的宽度」：导演台中间那条拖的是右栏（resize:2），
       往右拖反而变窄，所以方向要按 resize 在缝隙左边还是右边自动取反。 */
    split: {
      _read(key) { try { const v = JSON.parse(localStorage.getItem(key) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } },
      enable(o) {
        const box = typeof o.box === 'string' ? document.querySelector(o.box) : o.box;
        if (!box || box._wbSplit) return null;
        const cols = (o.cols || []).map(c => (typeof c.el === 'string' ? box.querySelector(c.el) : c.el)).filter(Boolean);
        const hs = (o.handles || []).filter(h => cols[h.left] != null && cols[h.right] != null && cols[h.resize]);
        if (!hs.length) return null;
        box._wbSplit = true;
        const key = o.key || 'wb_split';
        const st = this._read(key);
        const clamp = (h, w) => Math.round(Math.min(h.max || 1200, Math.max(h.min || 160, w)));
        const save = () => { try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) {} };
        const put = (h, w) => { st[h.varName] = w; box.style.setProperty('--' + h.varName, w + 'px'); save(); };
        const clear = h => { delete st[h.varName]; box.style.removeProperty('--' + h.varName); save(); };
        hs.forEach(h => { if (Number(st[h.varName]) > 0) box.style.setProperty('--' + h.varName, clamp(h, st[h.varName]) + 'px'); });
        const made = hs.map(h => {
          const el = document.createElement('div');
          el.className = 'wb-split';
          el.title = '拖动调整左右占比 · 双击恢复默认';
          el.innerHTML = '<i></i>';
          box.appendChild(el);
          el.addEventListener('pointerdown', e => {
            if (e.button !== 0 || el._hide) return;
            const target = cols[h.resize];
            const start = e.clientX, startW = target.getBoundingClientRect().width;
            const sign = h.resize <= h.left ? 1 : -1;      // 拖的是缝隙右边的栏 → 反向
            el.setPointerCapture(e.pointerId);
            el.classList.add('on');
            document.body.classList.add('wb-splitting');
            e.preventDefault();
            const move = ev => put(h, clamp(h, startW + sign * (ev.clientX - start)));
            const up = () => {
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
              el.removeEventListener('pointercancel', up);
              el.classList.remove('on');
              document.body.classList.remove('wb-splitting');
              layout();
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
          });
          el.addEventListener('dblclick', () => { clear(h); layout(); });
          return { h, el };
        });
        /* 拖拽条贴在两栏之间那条缝的正中：位置完全按实际渲染结果算，
           所以没拖过时（弹性栏宽）和拖过之后（写死 px）都能对齐；窄到堆叠成单列时直接藏掉。 */
        function layout() {
          const b = box.getBoundingClientRect();
          made.forEach(({ h, el }) => {
            const r = cols[h.left].getBoundingClientRect(), nr = cols[h.right].getBoundingClientRect();
            const gapL = r.right - b.left, gapR = nr.left - b.left;
            // 上下堆叠（窄窗口断点）或缝隙被挤没 → 这条不可用
            const hide = nr.top - r.bottom > 4 || r.height <= 0 || gapR - gapL < 6;
            el._hide = hide;
            el.classList.toggle('hide', hide);
            if (hide) return;
            el.style.left = Math.round((gapL + gapR) / 2 - el.offsetWidth / 2) + 'px';
            el.style.top = Math.round(r.top - b.top) + 'px';
            el.style.height = Math.round(Math.max(24, Math.min(r.height, nr.height))) + 'px';
          });
        }
        layout();
        if (window.ResizeObserver) {
          const ro = new ResizeObserver(layout);
          ro.observe(box);
          cols.forEach(c => ro.observe(c));        // 左栏自己变高/变矮时条子要跟着
        }
        window.addEventListener('resize', layout);
        // 文档在后台时 ResizeObserver 不出帧（比如 iframe 刚切走又切回），回到前台要补算一次
        window.addEventListener('load', layout);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) layout(); });
        box._wbSplitLayout = layout;
        return { layout, cols, handles: made };
      },
    },

    /* ---------- 灯箱「详情」（三个工作台共用，外观与资产库灯箱一致） ----------
       预览大图 / 视频 / 音频时，底部那排会自动多一个「详情」按钮，点开就是完整的详情面板
       （与卡片上的「详情」是同一个渲染器，所以两处信息一致）。
       用法：
         Wb.lbDetail.init({ render: (item, host) => {…}, label: '详情' });
         Wb.lbDetail.show(item);     // 每次灯箱换内容时调用：收起详情并记住当前条目
       约定：页面提供 render(item, host)，host 是写入目标（页面自己的 .det-* 样式直接生效）。 */
    lbDetail: {
      _cfg: null, _item: null, _box: null, _btn: null,
      init(cfg) {
        const lb = document.getElementById('lightbox');
        const bar = document.getElementById('lbBar');
        if (!lb || !bar) return;
        this._cfg = cfg || {};
        let box = document.getElementById('lbDetailBox');
        if (!box) {
          box = document.createElement('div');
          box.id = 'lbDetailBox';
          lb.appendChild(box);
        }
        this._box = box;
        let btn = document.getElementById('lbDetailBtn');
        if (!btn) {
          btn = document.createElement('button');
          btn.className = 'ghost';
          btn.id = 'lbDetailBtn';
          btn.title = '查看这条产物的完整信息（提示词 / 参数 / 用量 / 任务号）';
          bar.appendChild(btn);      // 放最右，和资产库灯箱同序：信息 · 下载 · 详情
        }
        btn.textContent = this._cfg.label || '详情';
        btn.onclick = e => { e.stopPropagation(); this.toggle(); };
        this._btn = btn;
      },
      /* 切换灯箱内容时调用：收起详情并记住当前条目 */
      show(item) { this._item = item; this.close(); },
      close() {
        const box = this._box;
        if (box) {
          if (box._detTimer) { clearInterval(box._detTimer); box._detTimer = null; }   // 页面可能挂了状态轮询
          box.style.display = 'none';
          box.innerHTML = '';
        }
        if (this._btn) this._btn.classList.remove('on');
      },
      toggle() {
        if (!this._box || !this._item || !this._cfg || !this._cfg.render) return;
        if (this._box.style.display === 'block') { this.close(); return; }
        this._box.style.display = 'block';
        if (this._btn) this._btn.classList.add('on');
        try { this._cfg.render(this._item, this._box); }
        catch (e) {
          this._box.textContent = '详情加载失败：' + ((e && e.message) || e);
          console.warn('[Wb] 灯箱详情渲染失败：', e);
        }
      },
    },

    /* ---------- 灯箱底部操作条（三个工作台共用：信息 · 下载到本地 · ⤓ 另存为） ----------
       以前三台各写一份，长得不一样：图片台是两个 <button>（有 hover），视频/语音台是一个 <a>
       （没有 hover、带下划线、而且点了只是浏览器下载，不会存到「设置 → 目录」）。
       现在按钮在这里统一生成，样式统一放在 ui.css 的 #lbBar 一段 —— 结构上保证三台一致。
       页面只要提供两件事：
         fileName(item)  保存时的文件名
         urlOf(item)     下载地址；返回空字符串表示这条没有文件可下载（按钮自动隐藏） */
    lbBar: {
      _cfg: null, _item: null,
      init(cfg) {
        const bar = document.getElementById('lbBar');
        if (!bar) return;
        this._cfg = cfg || {};
        if (document.getElementById('lbSave')) return;      // 已经建过就不重复建
        const mk = (id, text, mode) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ghost';
          b.id = id;
          b.textContent = text;
          b.onclick = async e => {
            e.stopPropagation();
            const it = this._item;
            const url = (it && this._cfg.urlOf) ? this._cfg.urlOf(it) : '';
            if (!url) { window.Toast.warn('这条没有可下载的文件'); return; }
            const name = (this._cfg.fileName ? this._cfg.fileName(it) : '') || 'download';
            const old = b.textContent;
            b.disabled = true;
            b.textContent = mode === 'save' ? '保存中…' : '另存中…';
            try {
              // 走统一保存：先判 HTTP 状态，再按「设置 → 目录」落盘（页面用 WbSaveHook 接管目录）
              await (mode === 'save' ? window.Wb.save(url, name) : window.Wb.saveAs(url, name));
            } catch (err) { window.Toast.err((err && err.message) || err); }
            finally { b.disabled = false; b.textContent = old; }
          };
          bar.appendChild(b);
          return b;
        };
        mk('lbSave', '下载到本地', 'save');
        mk('lbSaveAs', '⤓ 另存为', 'saveas');
      },
      /* 灯箱换内容时调用：更新计数与信息，并按「有没有可下载地址」决定按钮显隐。
         o.parts 可以是字符串，也可以是 Promise<string>（例如体积要探测、尺寸要等媒体元数据），
         每个 Promise 落定后立刻重画 —— 所以信息是「逐步补齐」的，不用等全部就绪。 */
      show(item, o = {}) {
        this._item = item;
        const c = document.getElementById('lbCount');
        if (c) c.textContent = o.count || '';
        const parts = Array.isArray(o.parts) ? o.parts.slice() : (o.info != null ? [o.info] : []);
        const paint = () => this.setInfo(parts.filter(x => x != null && x !== '').join(' · '));
        paint();
        parts.forEach((p, i) => {
          if (p && typeof p.then === 'function') {
            p.then(v => { parts[i] = v || ''; if (this._item === item) paint(); })
             .catch(() => { parts[i] = ''; });
          }
        });
        const url = (this._cfg && this._cfg.urlOf) ? this._cfg.urlOf(item) : '';
        ['lbSave', 'lbSaveAs'].forEach(id => {
          const b = document.getElementById(id);
          if (b) b.hidden = !url;
        });
      },
      /* 媒体元数据加载完后再补信息（尺寸/体积等）：只改文字，不动按钮 */
      setInfo(text) {
        const i = document.getElementById('lbInfo');
        if (i) i.textContent = text || '';
      },
    },

    /* ---------- 灯箱（全站一份：资产库 / 收藏 / 三个工作台） ----------
       五个页面原来各写一份灯箱，还各有一套 DOM（#lbImg / #lbVideo / #lbAudio / #lbStage）
       与各自的信息条；收藏页干脆没有预览。现在收敛到这里：
         · DOM 由本模块创建（#lightbox > ‹ + #lbStage + › + #lbBar），页面不用再手写一遍
         · 信息条与「下载到本地 / ⤓ 另存为 / 详情」直接用 Wb.lbBar + Wb.lbDetail
         · 图片 / 视频 / 音频 / 「进行中的任务」占位都在这里渲染
       页面只声明（cfg）：
         list()            翻页范围（通常是当前视图的条目）
         keyOf(item)       在列表里定位用
         srcOf(item)       媒体地址；可以是 Promise（收藏的本地文件要先读 IndexedDB）
         nameOf(item)      下载/另存时的文件名
         kindOf(item)      'image' | 'video' | 'audio' | 'task'（其它值按图片处理）
         info(item, el)    信息行内容数组（可含 Promise）
         detail            详情渲染（默认 Wb.detail.render）
         onShow(item)      每次换内容后的回调 */
    lightbox: {
      cfg: null, list: [], idx: 0, _cur: null,
      init(cfg) {
        this.cfg = cfg || {};
        this._mount();
        const W = window.Wb;
        W.lbBar.init({
          fileName: it => (W.lightbox.cfg.nameOf ? W.lightbox.cfg.nameOf(it) : '') || 'download',
          urlOf: it => (it && it.__lbUrl) || '',
        });
        W.lbDetail.init({
          label: (cfg && cfg.detailLabel) || '详情',
          render: (item, host) => (cfg && cfg.detail ? cfg.detail(item, host) : W.detail.render(item, host)),
        });
        const lb = document.getElementById('lightbox');
        const clickOut = e => {
          if (e.target.id === 'lightbox' || e.target.id === 'lbStage') {
            const m = lb.querySelector('video, audio');
            if (m) { try { m.pause(); } catch (err) {} }
            W.lightbox.close();
          }
        };
        lb.onclick = clickOut;
        document.getElementById('lbPrev').onclick = e => { e.stopPropagation(); W.lightbox.step(-1); };
        document.getElementById('lbNext').onclick = e => { e.stopPropagation(); W.lightbox.step(1); };
        document.addEventListener('keydown', e => {
          if (lb.style.display !== 'flex') return;
          if (e.key === 'ArrowLeft') W.lightbox.step(-1);
          else if (e.key === 'ArrowRight') W.lightbox.step(1);
          else if (e.key === 'Escape') {
            const m = lb.querySelector('video, audio');
            if (m) { try { m.pause(); } catch (err) {} }
            W.lightbox.close();
          }
        });
      },
      /* 创建灯箱 DOM；页面里已经有 #lightbox（老标记：只有 #lbImg/#lbVideo/#lbAudio）时补齐结构并清掉老节点，
         这样「标记换成共用结构」这件事是自愈的，不会因为某个页面忘了改而少了 #lbStage。 */
      _mount() {
        let lb = document.getElementById('lightbox');
        if (!lb) {
          lb = document.createElement('div');
          lb.id = 'lightbox';
          lb.innerHTML = '<button class="lb-btn" id="lbPrev">‹</button>'
            + '<div id="lbStage"></div>'
            + '<button class="lb-btn" id="lbNext">›</button>'
            + '<div id="lbBar"><span id="lbCount"></span><span id="lbInfo"></span></div>';
          document.body.appendChild(lb);
          return;
        }
        if (!document.getElementById('lbStage')) {
          const stage = document.createElement('div');
          stage.id = 'lbStage';
          const next = document.getElementById('lbNext');
          lb.insertBefore(stage, next || null);
        }
        if (!document.getElementById('lbBar')) {
          const bar = document.createElement('div');
          bar.id = 'lbBar';
          bar.innerHTML = '<span id="lbCount"></span><span id="lbInfo"></span>';
          lb.appendChild(bar);
        }
        /* 老灯箱的媒体节点与信息条（#lbImg/#lbVideo/#lbAudio/#lbPanel/#lbDetail）已由本模块接管 */
        ['lbImg', 'lbVideo', 'lbAudio', 'lbPanel', 'lbDetail'].forEach(id => {
          const el = document.getElementById(id);
          if (el && !el.closest('#lbStage')) el.remove();
        });
      },
      isOpen() { const lb = document.getElementById('lightbox'); return !!lb && lb.style.display === 'flex'; },
      /* 打开：优先在当前视图里定位（找不到就单张显示被点的那条，别打开别的）。
         第二个参数可以显式给一组翻页范围（例如「详情里的参考图」这种临时列表）。 */
      open(item, listOverride) {
        const c = this.cfg || {};
        let list = (Array.isArray(listOverride) && listOverride.length) ? listOverride.slice() : ((c.list ? c.list() : []) || []);
        const key = c.keyOf ? String(c.keyOf(item) || '') : '';
        /* keyOf 在个别条目上抛错（例如老数据少了 id）不该把整个预览带崩：退回按对象定位 */
        let i = -1;
        try { i = key ? list.findIndex(x => String(c.keyOf(x)) === key) : list.indexOf(item); }
        catch (e) { i = list.indexOf(item); }
        if (i < 0) { list = [item]; i = 0; }
        this.list = list;
        this.idx = i;
        this.show();
      },
      step(d) {
        if (!this.list.length) return;
        this.idx = ((this.idx + d) % this.list.length + this.list.length) % this.list.length;
        this.show();
      },
      async show() {
        if (!this.list.length) return;
        const c = this.cfg || {};
        const it = this.list[this.idx];
        this._cur = it;
        const W = window.Wb;
        const stage = document.getElementById('lbStage');
        const lb = document.getElementById('lightbox');
        stage.innerHTML = '<div class="lb-hint">加载中…</div>';
        lb.style.display = 'flex';
        W.lbDetail.show(it);
        let src = '';
        try { src = await Promise.resolve(c.srcOf ? c.srcOf(it) : (it.src || '')); }
        catch (e) { stage.innerHTML = '<div class="lb-hint">' + W.esc('读取失败：' + ((e && e.message) || e)) + '</div>'; return; }
        if (this._cur !== it) return;                       // 期间又换了一条：丢弃这次结果
        it.__lbUrl = src || '';                             // lbBar 的下载按钮用它（同步取）
        const kind = (c.kindOf ? c.kindOf(it) : 'image') || 'image';
        const mk = tag => { const el = document.createElement(tag); el.src = src; el.controls = true; el.autoplay = true; return el; };
        stage.innerHTML = '';
        if (kind === 'task') {
          stage.innerHTML = '<div class="lb-hint">' + W.esc(it.status === 'failed' ? '生成失败' : '生成中…') + '</div>';
        } else if (kind === 'video') {
          const v = mk('video');
          stage.appendChild(v);
        } else if (kind === 'audio') {
          const au = mk('audio');
          stage.appendChild(au);
        } else if (src) {
          const im = document.createElement('img');
          im.src = src;
          im.loading = 'lazy';
          im.onerror = () => { stage.innerHTML = '<div class="lb-hint">图片不可用</div>'; };
          stage.appendChild(im);
        } else {
          stage.innerHTML = '<div class="lb-hint">这条没有可预览的内容</div>';
        }
        const parts = (c.info ? (c.info(it, stage.firstElementChild) || []) : []);
        W.lbBar.show(it, { count: (this.idx + 1) + ' / ' + this.list.length, parts });
        /* 媒体自己的尺寸/时长要等元数据：到点后重算一次信息行（页面只写 cfg.info 就行） */
        const media = stage.firstElementChild;
        if (media && (media.tagName === 'IMG' || media.tagName === 'VIDEO' || media.tagName === 'AUDIO')) {
          const ev = media.tagName === 'IMG' ? 'load' : 'loadedmetadata';
          media.addEventListener(ev, () => {
            if (this._cur !== it) return;
            W.lbBar.show(it, { count: (this.idx + 1) + ' / ' + this.list.length, parts: (c.info ? (c.info(it, media) || []) : []) });
          }, { once: true });
        }
        if (c.onShow) { try { c.onShow(it); } catch (e) {} }
      },
      close() {
        const lb = document.getElementById('lightbox');
        if (lb) lb.style.display = 'none';
        const stage = document.getElementById('lbStage');
        if (stage) stage.innerHTML = '';
        window.Wb.lbDetail.close();
      },
      /* 当前这条（灯箱详情等外部入口要用） */
      current() { return this._cur; },
    },

    /* ---------- 「下载到本地 / ⤓ 另存为」的落点：默认文件夹（File System Access） ----------
       图片台那套实现（句柄存 IndexedDB、没配目录时退回浏览器下载、重名自动 -2）收敛到这里；
       视频台/语音台原来各写一份 ensureDir/saveToDir/saveAsOnce/anchorDownload，行为还不同
       （有的吞掉取消、有的写完不提示）。页面只要声明自己的默认目录键：
         Wb.saver.init({ dirKey: 'dir_video', pickerId: 'skLib_dir_video', label: '视频', status: fn }) */
    saver: {
      cfg: null, dir: null, _legacy: false,
      init(cfg) {
        this.cfg = cfg || {};
        window.WbSaveHook = { toDir: (n, b) => this.toDir(n, b), asOnce: (n, b) => this.asOnce(n, b) };
      },
      _status(html) { try { if (this.cfg && this.cfg.status) this.cfg.status(html); } catch (e) {} },
      _idb() {
        if (this._dbP) return this._dbP;
        this._dbP = new Promise((res, rej) => {
          let r;
          try { r = indexedDB.open('sk_lib', 1); } catch (e) { this._dbP = null; rej(e); return; }
          r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
          r.onsuccess = () => res(r.result);
          r.onerror = () => { this._dbP = null; rej(r.error); };
        });
        return this._dbP;
      },
      _idbGet(k) {
        return this._idb().then(d => new Promise((res, rej) => {
          const t = d.transaction('kv', 'readonly');
          const q = t.objectStore('kv').get(k);
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        })).catch(() => null);
      },
      _idbSet(k, v) {
        return this._idb().then(d => new Promise((res, rej) => {
          const t = d.transaction('kv', 'readwrite');
          t.objectStore('kv').put(v, k);
          t.oncomplete = res;
          t.onerror = () => rej(t.error);
        })).catch(() => {});
      },
      async _verify(h) {
        try {
          return (await h.queryPermission({ mode: 'readwrite' })) === 'granted'
            || (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
        } catch (e) { return false; }
      },
      async ensureDir(interactive) {
        const c = this.cfg || {};
        const label = c.label || '文件';
        let dir = this.dir;
        if (!dir && c.dirKey) dir = await this._idbGet(c.dirKey);
        /* 兼容早期「统一目录」的老键，用户不用重新选一次 */
        if (!dir && !this._legacy) { this._legacy = true; dir = await this._idbGet('dir'); }
        if (dir && await this._verify(dir)) { this.dir = dir; return dir; }
        this.dir = null;
        if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持选择文件夹（请用 Chrome / Edge 打开）');
        if (!interactive) throw new Error('尚未设置' + label + '默认下载文件夹，请到「设置」页选择');
        dir = await window.showDirectoryPicker({ id: c.pickerId || 'skLib_dir', startIn: 'desktop', mode: 'readwrite' });
        this.dir = dir;
        if (c.dirKey) await this._idbSet(c.dirKey, dir);
        this._status('<span class="ok">默认下载文件夹已设为：' + dir.name + '，之后不再询问</span>');
        return dir;
      },
      /* 存到默认文件夹；取消选目录 → { canceled:true }；不支持 FS API / 没配目录 → 浏览器下载 */
      async toDir(name, blob) {
        let dir = null;
        try { dir = await this.ensureDir(true); }
        catch (e) {
          if (e && e.name === 'AbortError') return { ok: false, canceled: true };
          window.Net.save(blob, name);
          this._status('<span class="ok">✓ 已用浏览器下载：' + name + '（可在「设置」里指定默认文件夹）</span>');
          return { ok: true, fallback: true };
        }
        let fn = name;
        try { await dir.getFileHandle(fn, { create: false }); fn = fn.replace(/(\.\w+)$/, '-2$1'); } catch (e) {}
        const fh = await dir.getFileHandle(fn, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        this._status('<span class="ok">✓ 已保存：' + fn + '</span>');
        return { ok: true, name: fn };
      },
      /* 每次弹窗自选位置 */
      async asOnce(name, blob) {
        if (!window.showSaveFilePicker) { window.Net.save(blob, name); return { ok: true, fallback: true }; }
        const handle = await window.showSaveFilePicker({ suggestedName: name, startIn: (this.dir && this.dir) || 'desktop' });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        this._status('<span class="ok">✓ 已另存：' + handle.name + '</span>');
        return { ok: true, name: handle.name };
      },
    },

    /* ---------- 统一「生成按钮就绪状态」（三个工作台共用一份，别各写一套）----------
       这里把两件事分开：
       ① 按钮禁用 + title（悬停能看到原因）始终生效 —— 这是「拦住别提交」；
       ② 按钮下方那行说明文案**不在首屏显示**：空输入框是正常初始态，不是用户做错了，
          一打开页面就顶着「请输入提示词」等于拿一句警示色刷屏。
       只有用户在输入区真改过内容 / 动过参数（input、change）之后，卡住的原因才显示出来；
       之后它跟着实时变化，改对了自行消失。 */
    ready(o) {
      const el = x => (typeof x === 'string' ? (document.getElementById(x) || document.querySelector(x)) : x);
      const btn = el(o.btn);
      if (!btn) return;
      btn.__rdOpt = o;                                   // 每次都记下最新的 reason / tip
      if (!btn.__rdBound) {
        btn.__rdBound = true;
        btn.__rdRun = () => {
          const c = btn.__rdOpt || {};
          const why = (c.reason && c.reason()) || '';
          btn.disabled = !!why;
          btn.title = why || '';
          const tip = el(c.tip);
          if (tip) {
            tip.textContent = why;
            // 默认隐藏写在 ui.css（#goWhy{display:none}），所以这里要显式给 block，不能置空
            tip.style.display = (why && btn.__rdTouched) ? 'block' : 'none';
          }
        };
        const scope = el(o.scope) || document;
        const touch = () => { btn.__rdTouched = true; btn.__rdRun(); };
        scope.addEventListener('input', touch, true);
        scope.addEventListener('change', touch, true);
      }
      btn.__rdRun();
    },

    /* ---------- 统一「取消失败要说出来」的调用 ---------- */
    async cancelTask(prov, id) {
      /* 平台对象必须由调用方给准：这里不再回退到某一家平台 —— 任务号在别家平台上可能是另一条（还扣着钱的）任务，
         猜错家等于取消别人的任务。 */
      const p = prov || null;
      if (!p) throw new Error('不知道这条任务属于哪个平台（条目缺 provider），先刷新列表再取消');
      if (!p.endpoints || !p.endpoints.cancel) throw new Error((p.displayName || p.name || p.id) + ' 没有声明取消接口（可在 proxy.js 的 registry 里补 endpoints.cancel）');
      await window.Api.cancel(p, id);
    },
  };
})();

/* 三个工作台（<body class="wb2">）的分栏拖拽统一在这里装：
   页面不各写一遍，就不会出现某一页忘了装、切过去占比行为不一样。三页共用 wb_split 这一个键。 */
(function () {
  const boot = () => {
    if (!document.body || !document.body.classList || !document.body.classList.contains('wb2')) return;
    try {
      window.Wb.split.enable({
        box: '.layout', key: 'wb_split',
        cols: [{ el: '.col-left' }, { el: '.col-right' }],
        handles: [{ left: 0, right: 1, resize: 0, varName: 'sp0', min: 300, max: 900 }],
      });
    } catch (e) { console.warn('[Wb] 分栏拖拽初始化失败（不影响使用）：', e && e.message); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
