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
     Wb.blob(url) / Wb.save(url, name)                       产物下载（先判 HTTP 状态，再走浏览器默认下载）
     Wb.poller({...})   轮询器：没任务就休眠、连续失败会提示并退避、切走标签页自动暂停
     Wb.searchNote(n)   搜索框旁的「仅筛选已加载的 N 条」说明
     Wb.ready({...})    生成按钮的就绪状态：禁用 + 悬停说明一直在，按钮下方那行原因等用户动过手才显示
     Wb.thumbs.*        缩略图缓存（视频首帧 + 图片，全站共用一份）
     Wb.vframe.*        浏览器内取视频帧（首帧槽位选视频 / 接上一镜尾帧，共用一份）
   ========================================================================== */
(function () {
  const esc = s => window.esc(s);          // 唯一实现在 ui.js

  /* ---------- 状态：三台共用同一套文案与判定 ----------
     文案表尽量把各家平台的措辞都收进来（succeeded / success / completed、queued / pending / waiting…），
     否则卡片上会直接摆一个英文原词，看着像状态没解析出来。 */
  const ST = {
    creating: '创建中', created: '创建中', init: '创建中', initialized: '创建中', submitted: '已提交',
    queued: '排队中', queue: '排队中', queuing: '排队中', pending: '排队中', waiting: '排队中', scheduled: '排队中',
    running: '生成中', processing: '生成中', progress: '生成中', synthesizing: '合成中',
    succeeded: '已完成', succeed: '已完成', success: '已完成', successful: '已完成',
    done: '已完成', completed: '已完成', complete: '已完成', finished: '已完成', ready: '已完成',
    failed: '生成失败', fail: '生成失败', error: '生成失败', aborted: '已中止', rejected: '被拒绝',
    cancelled: '已取消', canceled: '已取消', expired: '已过期', invalid: '无效',
  };
  /* 兜底词表：判定的**唯一判据**是 assetlib.js 的 Api.classifyStatus（它认 registry 的 statusMap），
     下面这两份只在 assetlib 还没加载时用（页面脚本顺序不该成为「状态判对判错」的因素）。 */
  const RUNNING = ['creating', 'created', 'init', 'initialized', 'submitted', 'queued', 'queue', 'queuing',
    'pending', 'waiting', 'scheduled', 'running', 'processing', 'progress', 'synthesizing'];
  const FAILED = ['failed', 'fail', 'error', 'aborted', 'rejected', 'cancelled', 'canceled', 'expired', 'invalid'];
  const cls = s => (window.Api && Api.classifyStatus) ? Api.classifyStatus(null, s) : '';
  /* 空状态不算「活的」：本地记录刚建出来时 status 可能还没写，判成在跑会让轮询器永远扫它。 */
  const norm = s => String(s == null ? '' : s).trim().toLowerCase();
  const stLive = s => { const t = norm(s); if (!t) return false;
    const c = cls(t); return c ? (c === 'running' || c === 'queued') : RUNNING.includes(t); };
  const stBad = s => { const t = norm(s); if (!t) return false;
    const c = cls(t); return c ? c === 'failed' : FAILED.includes(t); };

  /* ---------- 本地历史：统一 key / 上限，各台都走这一份 ---------- */
  /* 上限统一 200，并且写不进去会提示。
     注意：视频/图像两类任务卡片全部来自平台接口，本地不留任务记录（只有首屏缓存），
     只有**同步合成的语音**例外 —— 上游没有任务号，本机记录就是它唯一的凭据。
     image 这一条是三个工作台合并成 studio.html 之前留下的键（sparkcine_gallery）：
     新页面不再写它，但用户的 localStorage 里还有，所以规格留着 —— 设置页「清缓存」那一节
     按这张表渲染，直接删掉这一条会让这份用户数据既没人写、也没人能清。 */
  const HISTORY = {
    image: { key: 'sparkcine_gallery', cap: 200, label: '生图历史（合并前的旧工作台，已不再写入）',
      strip: it => { const o = { ...it }; delete o._blob; return o; } },
    audio: { key: 'audio_tasks', cap: 200, label: '语音任务',
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

  /* ---------- 大文件存储（IndexedDB）：参考音频、参考视频这类大对象 ----------
     开库与事务用 ui.js 的 Kv（全项目唯一一份），库/表名也只在那边的登记表里写一次（blobs = wb_blobs/blobs）。
     取用时才查登记表：ui.js 理论上可能晚于本模块加载，别在模块顶层就 window.Kv.* */
  const blobsKv = () => window.Kv.at('blobs');
  const tx = (mode, fn) => blobsKv().tx(mode, fn);

  /* ---------- 续拉的「什么时候该拉」：哨兵与容器滚共用的一份判据 ----------
     提前量按**视口高度**算，不写死 300px：一次冷请求要好几秒（实测 VGENV 一页 5.2 秒、
     SparkCine 2.9 秒），余量只有 300px 时用户永远是在底部原地等满一轮。
     追轮上限（一次触发最多连着拉几批）也从这一处来 —— 页面各自 guard 20 的写法会失控。 */
  const LEAD_VH = 1.5;
  const PULL_MAX_ROUNDS = 8;
  const pullLeadPx = h => Math.max(240, Math.round((Number(h) || 0) * LEAD_VH) || 240);
  /* near() 判「还贴着底」，step() 真去拉一批。
     **只有 step 返回 Promise 才追下一轮** —— 角色库 / 收藏那两页的回调是纯本地翻页（同步返回），
     给它们追轮就是一圈空转；反过来资产库 / 工作台返回真请求，才需要「拉完还贴着就接着拉」。
     单飞锁 busy 也在这里：一次滚动会连发几十个事件，同一个续拉不许排成一串。 */
  function makePuller(near, step) {
    let busy = false;
    return async () => {
      if (busy) return;
      busy = true;
      try {
        for (let round = 0; round < PULL_MAX_ROUNDS && near(); round++) {
          let r;
          try { r = step(); } catch (e) { console.warn('[pager] 续拉回调出错', e); break; }
          if (!r || typeof r.then !== 'function') break;
          try { await r; } catch (e) { console.warn('[pager] 续拉失败，这一轮不再追', e); break; }
        }
      } finally { busy = false; }
    };
  }

  window.Wb = {
    ST,
    stText(s) { const t = norm(s); return ST[t] || s || ''; },
    /* 活 / 失败的判定只看状态串，页面别再自己列 ['failed','cancelled'] 这种词表
       （少一个同义词就会把已完成的任务画成失败，或者把在跑的任务从轮询集合里漏掉）。 */
    stLive,
    stBad,
    isRunning(t) { return !!t && stLive(t.status); },
    isFailed(t) { return !!t && stBad(t.status); },
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
    /* 与 ui.js 的 window.fmtBytes 逐字相同（同一个守卫、同一个换算循环），只差形参名。
       原来是第三份，ui.js 那份的注释写着「界面各处共用一份」，这里没跟上。
       走惰性查找而不是模块顶层引用：这样模块加载顺序不用动。 */
    fmtSize(bytes) { return window.fmtBytes(bytes); },
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
      spec(kind) { return HISTORY[kind] || { key: kind, cap: 200, label: kind }; },
      read(kind) {
        const s = this.spec(kind);
        const v = window.Store.read(s.key, []);
        return Array.isArray(v) ? v : [];
      },
      write(kind, list) {
        const s = this.spec(kind);
        const arr = (Array.isArray(list) ? list : []).map(it => (s.strip ? s.strip(it) : it));
        const clean = arr.map(it => slimForStorage(it, 0));      // 通用瘦身：内联二进制不落盘
        let r = window.Store.write(s.key, clean, { cap: s.cap, label: s.label });
        /* 还是写不下（配额满）时降级，而不是整批失败：
           先砍一半、再只留最近 20 条 —— 「少存几条」比「一条都没存下」有用，
           Store.write 失败时已经弹过一次提示，这里只需尽力保住历史。 */
        if (!r.ok) {
          let n = 0;
          for (const cand of [Math.floor(clean.length / 2), 20]) {
            /* n 必须至少 1 且真比现有少：Math.floor(1/2)=0 时写 slice(0,0) 等于**清空历史**，
               而调用方看到的还是完整列表，以为都存下了。 */
            if (cand < 1 || cand >= clean.length) continue;
            r = window.Store.write(s.key, clean.slice(0, cand), { cap: s.cap, label: s.label });
            if (r.ok) { n = cand; break; }
          }
          /* 降级写入成功时返回真正存下来的那一段，别把没写进去的也报成已保存 */
          if (n) return clean.slice(0, n);
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
        const r = window.Store.write(s.key, [], { label: s.label });
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
      /* 这一页真的读到过首帧的那些键（get() 里记）。_prune 先淘汰没读过的：
         表里的 ts 只在**写入**时刷新，读到不会 —— 所以「最早写入」不等于「最有用」，
         天天在看的那批恰恰是第一次抽帧时写的，按 ts 淘汰会把它们最先挤掉，
         下次打开又得重抽（这就是「每次打开都需要加载」的一半原因）。 */
      _touched: new Set(),
      _aliases: new Map(),        // 旧签名键 → 归一化键，提交成功后才移除旧缓存
      _bindings: new WeakMap(),
      _jobs: new Map(),           // 每个 key 一个任务，多个 wrap 订阅同一帧
      _queue: [],
      /* 并发按「字节从哪来」分两档，不是一个数管全部：
         外链一路要过公网、量的是别人的带宽与连接数，2 张已经不少（原来就是这个值）；
         而「优先用本机文件」打开以后，产物地址是同源 /asset/la_xxx —— 读的是本机磁盘、
         由本地代理回给同一个浏览器，慢不了。以前两者共用 2 这一档，290 条视频的素材库
         首开就是 145 轮串行抽帧：整排先灰着、然后一张一张亮起来，
         看着就像「每次打开都要重新加载、还一闪一闪」。 */
      _active: { 外链: 0, 本机: 0 },
      CONCURRENCY: 2,                 // 外链（要过公网）同时在抽几张
      LOCAL_CONC: 6,                  // 本机 /asset/ 同时在抽几张
      /* 一个任务算哪一档，看它**真正去取的那个地址**（_source 会把有镜像的 /getv 换成本机地址） */
      _cls(job) {
        if (job.slow) return '外链';      // 量出来的：这个地址第一次没在「本机那么快」的时间里出帧（见 _retry）
        if (!job.cls) job.cls = /^\/asset\//.test(String(this._source(job.src) || '')) ? '本机' : '外链';
        return job.cls;
      },
      /* 一次抽帧的时间预算（三条道各有各的判据，见 _pump 里选预算那一段）：
         本机第一次只给 8 秒 —— 真落在本机磁盘上的文件（`/asset/la_*`、以及镜像回来存过的那批）
         在同源回环上取首帧远用不到 8 秒；8 秒还没出来的，多半是代理**现从上游回源**的大文件
         （`GET /asset/<id>` 是「本地优先，否则回源上游」，客户端光看地址分辨不了这两种）。
         以前一律按「本机」给 6 个并发、20 秒预算：实测一条 13MB 的产物整包要 51 秒，
         6 路同时抢同一条上游带宽 → 每路都超 20 秒 → 重试两次全超时 →
         「勾了优先用本机文件，视频卡却一片灰并且写着缩略图暂不可用」，正是用户报的那条。
         所以下一次换到慢道（并发 2）并给足 90 秒，让它**抽得到**，而不是快而空。 */
      LOCAL_FIRST_MS: 8000,
      SLOW_MS: 90000,
      EXT_MS: 20000,
      RETRIES: 2,                     // 抽帧失败后自动重试几次（见 _retry）
      RUN_TEXT: '正在取首帧…',
      /* 容量闸：**字节才是真闸，条数只当安全网**。
         实测（从 wb_thumbs 里把真实帧读出来量，.tmp-thumbsize.cjs）：
         512px JPEG dataURL 的中位 21KB、最大 25KB、平均 ~20KB —— 以前这条注释写的
         「平均 ~100KB/帧，600 条约 60MB」**高估了 5 倍**，于是 CAP 看起来正好卡在预算上，
         实际上 BYTES 那 64MB 只够装三千多条，**先被卡住的一直是 CAP=600**。
         290 条本机文件 + 上百条平台产物 + 收藏/导演台/短剧各自那一批，
         600 条正好卡在边缘上：刚好看完一轮就开始淘汰 → 「每次打开都要重新加载」复发。
         单条的硬上限是 MAXBYTES(200KB)，所以把 CAP 抬到 3000 不会让最坏情况失控 ——
         真正兜住总量的是 BYTES（3000 × 20KB ≈ 60MB，正好也在预算内）。 */
      CAP: 3000,
      BYTES: 64 * 1024 * 1024,      // 缓存总量上限（图片缩略图比视频帧大，条数之外再加一道字节闸）
      PRUNE_MIN_MS: 8000,           // 两次全表淘汰之间至少隔这么久（见 _prune 的节流注释）
      _lastPruneAt: 0,
      /* 开库、连接复用与事务全走 ui.js 的 Kv（这里以前也自己写过一份）；
         库/表名在 Kv 的登记表里（thumbs = wb_thumbs/thumbs），到调用时才取 */
      _tx(mode, fn) {
        return window.Kv.at('thumbs').tx(mode, fn);
      },
      /* 地址归一化：同一份素材无论经过什么包装，都要算出同一个键 —— 否则缩略图缓存永远命不中、
         观感就是「每次都重新加载」。要去掉三类每次都变的东西：
           · #t=0.1        播放/抽帧用的媒体片段
           · ?r=时间戳      重试时的防缓存参数
           · ?v=2           各页面固定的防缓存版本号（全站都写 2）
           · /getv?url=<签名地址> 里的签名（VGENV 走 OSS，Expires 与 Signature 每次刷新都不同）
             这种情况用内层地址的 host + path 当键（path 里带 asset/job id，是稳定的） */
      /* 内层地址里「每次签名都会变」的参数怎么剥、素材身份怎么算，只在 assetlib.js 有一份
         （Api.mediaKey / Api.innerMedia）—— 缩略图缓存键和「过期回源」必须算出同一个身份，
         否则换到新鲜地址就等于换了一个键，缓存永远命不中。 */
      keyOf(src) {
        const s = String(src == null ? '' : src).split('#')[0];
        if (!s || /^(?:blob:|data:|fav-file:)/i.test(s)) return s;
        try {
          /* 有本机镜像的那一份，键按**本机那一条**算：同一个产物在资产库是 /asset/la_xxx、
             在收藏 / 导演台是 /getv?url=<签名外链>，两个键 → 抽两次帧、缓存里存两份，
             而过期那一个还永远抽不出来 —— 表现就是「资产库有预览图，别的页面没有」。
             这一步走 localAssetIdOf（**只看身份、不看「优先用本机文件」开关**）：
             以前串的是 localCopyOf，那个函数被开关挡着，于是关掉开关同一份产物又变两个键
             （抽两次帧、闪两次，而平台外链一过期就整排空白）。开关管的是画面上取哪个字节，
             不是「这是哪一份东西」。 */
          const AL = window.AssetLocal;
          if (AL && AL.localAssetIdOf) {
            const la = AL.localAssetIdOf(s);
            if (la) return '/asset/' + la;
          }
          const inner = window.Api && Api.innerMedia ? Api.innerMedia(s) : '';
          /* 外链本身、或 /getv?url=<外链>：都用内层地址的素材身份当键（签名换了键不变） */
          if (inner && /^https?:\/\//i.test(inner)) return '/getv?url=' + Api.mediaKey(inner);
          const u = new URL(s, location.href);
          if (u.origin !== location.origin && /^https?:$/.test(u.protocol)) return '/getv?url=' + Api.mediaKey(u.href);
          if (u.searchParams.has('r')) u.searchParams.delete('r');
          /* ?v=2 是各页面自己加的固定版本号（全站都写 2，从没变过），留着它会把同一份素材拆成
             /asset/x 与 /asset/x?v=2 两个键 —— 同一张首帧被抽两次、缓存里存两份。统一剥掉。 */
          if (u.searchParams.has('v')) u.searchParams.delete('v');
          return u.origin === location.origin ? u.pathname + u.search : s;
        } catch { return s; }
      },
      get(src, key) {
        const k = this.keyOf(key || src);
        if (!k) return '';
        const v = this._map.get(k);
        /* 记一笔「这一页真的用到了它」—— _prune 按使用淘汰，不按写入时间淘汰（见那里的说明） */
        if (v) this._touched.add(k);
        return v || '';
      },
      /* 设置页「清空缩略图缓存」：缩略图随时能重建（重新抽帧/缩放），清掉最多让列表重新加载一次，
         不动任何用户数据。先等落盘事务收尾，否则刚 clear 完 dirty 又被 _flush 写回去。 */
      async clearAll() {
        const n = this._map.size;
        try { await this._flush(); } catch (e) {}
        this._map.clear();
        this._dirty.clear();
        this._touched.clear();
        this._aliases.clear();
        this._loaded = Promise.resolve(0);   // 表已空，别让下次 hydrate 再把整表读回来
        try { await this._tx('readwrite', st => st.clear()); } catch (e) {}
        return n;
      },
      /* bind 等待 hydrate 后原地换图；返回「这次读回了多少条」——
         页面拿它决定要不要整表重画（0 条就不用动）。 */
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
          this._flush();
          return n;
        })();
        return this._loaded;
      },
      _save(k, v) {
        const key = this.keyOf(k);
        // 体积闸只挡「写缓存」：四档都缩不下的帧照样要显示（调用方拿到的还是那张图），
        // 但不能让它把 wb_thumbs 撑爆 —— 缩略图丢了最多下次再抽，塞爆存储是另一回事。
        if (!key || !v || v.length > this.MAXBYTES) return;
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
            /* 节流闸（U6）：`_save` 是不 debounce 的，抽帧并发最高 6 路，首屏抽几十帧
               就是几十次 `_flush` → 几十次 `_prune`，而每次 `_prune` 都在一个 readwrite
               事务里 `getAll()` 把**整张缩略图表**读进内存排序（上限 3000 条 / 64 MB）。
               淘汰语义（`_touched` / `_dirty` 保护、两趟顺序）一个字都不动，只加一道闸：
               距上一次真扫不够 PRUNE_MIN_MS 就往后排，把几十次并成一次。 */
            const wait = Math.max(1000, this.PRUNE_MIN_MS - (Date.now() - this._lastPruneAt));
            this._pruneT = setTimeout(() => { this._lastPruneAt = Date.now(); this._prune(); }, wait);
          }
          return ok;                      // 失败保留 dirty，下一次保存 / hide 再试，不循环重试
        });
        return this._saving;
      },
      /* 容量控制：超过 CAP 条或 BYTES 字节就淘汰。两趟，各管一件事：
         ① 先删这一页**没读到过**的那些（`_touched` 以外），仍按写入时间从早到晚；
         ② 只有「这一页在用的一批本身就超额度」时才连在用的也删 —— 那种情况再怎么排
            都装不下，只能让最热的那几张也重抽一次。
         待写的（`_dirty`）任何时候都不删：刚抽出来的帧还没落盘就被删掉，等于白抽。 */
      async _prune() {
        try {
          const drop = [];
          await this._tx('readwrite', st => {
            const q = st.getAll();
            q.onsuccess = () => {
              const size = r => String(r.v || '').length;
              const rows = (q.result || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
              const gone = new Set();
              let total = rows.reduce((n, r) => n + size(r), 0);
              const free = r => {
                if (!r || this._dirty.has(r.k) || gone.has(r.k)) return;
                gone.add(r.k); st.delete(r.k); drop.push(r); total -= size(r);
              };
              const over = () => (rows.length - gone.size) > this.CAP || total > this.BYTES;
              for (const r of rows) { if (!over()) break; if (!this._touched.has(r.k)) free(r); }
              for (const r of rows) { if (!over()) break; free(r); }
            };
          });
          for (const r of drop) {
            if (!this._dirty.has(r.k) && this._map.get(r.k) === r.v) this._map.delete(r.k);
            this._touched.delete(r.k);
          }
        } catch (e) {}
      },
      /* key 可显式指定稳定身份（如 fav-file:<fileKey>），实际取帧地址仍用 src。
         opts.type === 'image' → 图片缩略图：有缓存就直接用缓存（小图，秒出、零请求），
         没有就给原地址让浏览器渐进显示，同时在后台把这张图缩一份存进同一份缓存。
         opts.inline === true → **卡片里就地播放**：即使缓存里已有首帧也仍然出 <video>，
         把那一帧当 poster（缓存命中时不出 .tph 占位层）。给「视频要能在小栏里直接看、
         点画面不强制打开灯箱」的列表用；默认行为不变（列表里仍然是一张静帧海报）。
         视频与图片共用同一套键（keyOf 归一化）与同一个 IndexedDB 存储。 */
      mediaHTML(src, opts) {
        if (!src) return '';
        const key = this.keyOf((opts && opts.key) || src);
        // 尺寸/内联样式要同时作用到「缓存里的图」和「原地址的元素」，否则出画前后会跳版式
        const extra = (opts && opts.mediaAttrs) ? ' ' + String(opts.mediaAttrs).trim() : '';
        const cached = this.get(key);
        const live = esc(this._source(src));
        const inline = !!(opts && opts.inline);
        if (opts && opts.type === 'image') {
          if (!live && !cached) return '';      // 地址取不回来（非 http 的怪协议）就别放一个空 src 让浏览器去请求本页
          // 图片不盖占位层：原生 <img> 自己会渐进显示，缓存命中时直接用缓存的小图
          return `<img${this._kattr(key)} data-src="${live}" src="${cached ? esc(cached) : live}"`
            + ` alt="" decoding="async"${extra}>`;
        }
        if (cached && !inline) return `<img${this._kattr(key)} src="${esc(cached)}" alt="" decoding="sync"${extra}><span class="tph"></span>`;
        const tag = (opts && opts.videoAttrs) || 'preload="metadata" muted playsinline';
        const poster = cached ? ` poster="${esc(cached)}"` : '';
        /* inline（卡片里就地播放）直接给 src：静默模式下那个 <video> 只是抽帧用的，
           地址由 Wb.thumbs.bind 在滚到旁边时再给；但就地播放的卡片必须自己就能播 ——
           只给 data-src 的话浏览器根本不会取字节，视频永远是一帧黑屏（这就是「卡片里的视频播不动」）。
           底图仍然用缓存里那张首帧（poster），并打上 data-thumb-play 供 bind 认出。 */
        const srcAttr = inline ? ` src="${live}"` : ` data-src="${live}"`;
        const playMark = inline ? ' data-thumb-play="1"' : '';
        return `<video${this._kattr(key)}${playMark}${srcAttr} ${tag}${poster}${extra}></video>`
          + (cached ? '' : '<span class="tph"></span>');
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
          /* 同源的本地路由也要过 mediaSrc：/getv?url=<过期签名> 在这里换成会话内回源到的
             新鲜地址（只查内存表）。抽帧和播放用的是同一个地址，过期就一起过期。 */
          if (u.origin === location.origin) {
            const local = u.pathname + u.search + u.hash;
            return window.Api && window.Api.mediaSrc ? Api.mediaSrc(local) : local;
          }
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
        /* 就地播放的视频：封面只当 poster，节点一直是那个 <video>。
           曾经在这里直接把它换成 <img> → 卡片里的视频根本播不动（很快就能从缓存命中，
           所以是「第一次能播、刷一下就不行」的那种）。 */
        if (b.inline && b.media && b.media.tagName === 'VIDEO') {
          b.showing = true;
          const w = b.wrap;
          if (frame) {
            try { b.media.setAttribute('poster', frame); } catch (e) {}
            w.classList.add(b.rc);          // 有封面就直接变亮
            return;
          }
          const lit = () => w.classList.add(b.rc);
          if (b.media.readyState >= 2) lit();
          else ['loadeddata', 'canplay', 'playing', 'error'].forEach(ev => b.media.addEventListener(ev, lit, { once: true }));
          return;
        }
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
      /* 「这一张现在就摆在视口里」的判据只有一份 —— 观察器不回调的那些容器（弹窗的 top layer、
         没有 IntersectionObserver 的老浏览器）都读它，不要在调用点各量各的。 */
      _inView(el) {
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || !r.width || !r.height) return false;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        return r.bottom > 0 && r.top < vh;
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
      /* 占位层上的一句实话：只在真的开始抽帧时写（并发 2，同时最多两张卡显示），
         排队中的不写 —— 否则快速滚动会刷出一屏「正在取首帧」，那不是当下发生的事。 */
      _note(job, text) {
        for (const b of job.subs) {
          const ph = b.wrap && b.wrap.querySelector('.tph');
          if (ph && ph.textContent !== text) ph.textContent = text;
        }
      },
      /* 抽帧失败不再一次性判死：网络抖动、/getv 一时取不回来、签名刚好过期而后台回源还没换完，
         过几秒自己就好了。有限次重试（5s / 20s），用完才把原因写在占位层上。
         以前失败即删 job + 解绑观察，卡片就永远是一块灰，只能整页重画才有机会再试一次。 */
      _retry(job) {
        /* 先降级、再数重试次数：本机道第一次是**超时**（不是播放错误）说明这个地址其实
           是代理现从上游回源的大文件（实测 13MB 整包 51 秒），8 秒预算对它本来就不够。
           给它换到慢道重跑，并且**不占** RETRIES 那两次额度 —— 记进去的话慢道那次会被算成
           「第一次重试」，剩下两次仍在快道预算里，一次都出不来，卡片照样一片灰。 */
        const slowNow = job.timedOut && !job.slow && job.cls === '本机';
        if (slowNow) { job.slow = true; job.timedOut = false; }
        const n = (job.tries || 0) + (slowNow ? 0 : 1);
        if (!job.subs.size || (!slowNow && n > this.RETRIES)) return false;
        job.tries = n;
        job.running = false;
        job.queued = true;              // 等重试期间 _attach 不要重复入队
        setTimeout(() => {
          if (this._jobs.get(job.key) !== job || !job.subs.size) return;
          this._queue.push(job);
          this._pump();
        }, slowNow ? 1000 : (n === 1 ? 5000 : 20000));
        return true;
      },
      _finish(job, frame) {
        this._note(job, '');
        if (!frame && this._retry(job)) return;
        for (const b of job.subs) {
          if (this._io) this._io.unobserve(b.wrap);
          if (!this._valid(b)) continue;
          if (frame) this._show(b, frame);
          else {
            const ph = b.wrap.querySelector('.tph');
            if (!ph) continue;
            /* 说清原因：签名过期是「换个地址就好」，不是素材坏了。这种外链一旦被存进本机记录
               （导演台的候选、收藏）就会天天 403，后台回源换到新地址后页面会重画这一张。 */
            ph.textContent = window.Api && Api.mediaExpired && Api.mediaExpired(job.src)
              ? '外链签名已过期，等待换新…' : '缩略图暂不可用';
          }
        }
        job.subs.clear();
        if (this._jobs.get(job.key) === job) this._jobs.delete(job.key);
      },
      /* 这一条任务有没有「现在就摆在屏幕上」的订阅者（一次接线会排上几百条，
         而其中看得见的只有十几条）。 */
      _jobVisible(job) {
        for (const b of job.subs) if (this._valid(b) && this._inView(b.wrap)) return true;
        return false;
      },
      _pump() {
        this._sweep();
        /* 按档取任务，不是「队头拿不到就整队停下」：
           一处素材库往往本机与外链混着（有镜像的那几条还是签名外链），
           外链那 2 个位置被慢请求占住时，本机那一批照样往下抽。
           两轮扫：**先给看得见的那十几张**，再把位置给屏幕外的。按追加顺序排队时，
           慢道只有 2 个位置、一条最贵 90 秒，而滚到底一次能排上 180 多条 ——
           实测视口里的 14 张在 232 秒里一张都没出帧（「视频卡一片灰」正是这么来的）。
           只在「这个档还有空位」时才去量矩形，档排满时整轮扫是廉价的。 */
        for (let pass = 0; pass < 2; pass++) {
          const vis = pass === 0;
          for (let i = 0; i < this._queue.length;) {
            const job = this._queue[i];
            if (this._jobs.get(job.key) !== job) { this._queue.splice(i, 1); continue; }
            const cls = this._cls(job);
            const cap = cls === '本机' ? this.LOCAL_CONC : this.CONCURRENCY;
            if (this._active[cls] >= cap) { i++; continue; }
            if (vis !== this._jobVisible(job)) { i++; continue; }
            this._queue.splice(i, 1);
            const frame = this.get(job.key);
            if (frame) { this._finish(job, frame); continue; }
            job.running = true;
            /* 时间预算按道给，并在每次开跑前把「这一次有没有超时」清掉（_retry 靠它判降级）：
               本机第一次只给 LOCAL_FIRST_MS，慢道（降级过 / 本来就是外链的）给足。 */
            job.timedOut = false;
            job.ms = job.slow ? this.SLOW_MS : (cls === '本机' ? this.LOCAL_FIRST_MS : this.EXT_MS);
            this._active[cls]++;
            this._note(job, this.RUN_TEXT);
            this._extract(job).then(v => this._finish(job, v), () => this._finish(job, '')).finally(() => {
              this._active[cls]--;
              this._pump();
            });
          }
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
          timer = setTimeout(() => { job.timedOut = true; error(); }, job.ms || this.EXT_MS);
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
        /* 卡片里就地播放的视频（mediaHTML 的 inline）：它自己就是最终面，不能被尺寸缓存换成静帧。 */
        const inline = media.tagName === 'VIDEO' && media.getAttribute('data-thumb-play') === '1';
        const b = { wrap, media, src: raw, key, rc, ident: identity || '', inline };
        this._bindings.set(wrap, b);
        // <img> 已经是最终画面（缓存小图或原图）：标 ready，图片再顺手补一份缩略到缓存里
        if (media.tagName === 'IMG') { this._show(b); this._watchImg(b); return; }
        /* 兼容旧调用者直接给 video.src 的情况；公共 HTML 始终只生成 data-src。
           inline（卡片里就地播）例外 —— 它的 src 就是这张卡要播的那一路，
           抹掉等于把它变成一个永远黑屏、永远不能播的元素。 */
        if (!inline && media.getAttribute('src')) this._release(media);
        /* 就地播放卡另给一条「自己有画面了」的快捷路：卡片里的视频不能只靠
           抽帧缓存出帧才变亮（抽帧要另开一个视频元素去 seek，耗时）。
           播放期间会自己触发 loadeddata/canplay，那时占位层就去掉。 */
        if (inline) {
          const w = b.wrap;
          const lit = () => w.classList.add(rc);
          if (media.readyState >= 2) lit();
          else ['loadeddata', 'canplay', 'playing', 'timeupdate', 'error'].forEach(ev =>
            media.addEventListener(ev, lit, { once: true }));
        }
        this.hydrate().then(() => {
          if (!this._valid(b)) return;
          this._sweep();
          const frame = this.get(key);
          if (frame) { this._show(b, frame); return; }
          let job = this._jobs.get(key);
          if (!job) { job = { key, src, subs: new Set() }; this._jobs.set(key, job); }
          job.src = b.src;
          job.subs.add(b);
          if (job.running) this._note(job, this.RUN_TEXT);   // 半路加入的卡片也要有同一句状态
          const io = this._observer();
          if (!io) { this._attach(wrap); return; }
          io.observe(wrap);
          /* 观察器只判「相对视口相交」，而 **`<dialog>` 打开以后内容在 top layer**：
             实测 root=null 的观察器对弹窗里的卡片**一次回调都没有** —— job 一直停在
             queued:false / running:false，而同一时刻手动跑一次 `_extract` **6 毫秒**就出帧。
             素材选择器（导演台/工作台那些槽位弹出的那一片）里的视频卡因此永远灰着，
             同一份素材在资产库却有预览图 —— 这正是「其他页面没有预览图」的其中一条。
             所以除了等回调，接上以后当场量一次：已经在视口里的立刻走同一条 `_attach`
             （`_attach` 自己认「已入队/在跑就不重复」，多条卡片同一 key 也不会抽两遍）。 */
          if (this._inView(wrap)) this._attach(wrap);
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
      /* 逐级降尺寸 + 降质量，直到落到 MAXBYTES 以内（四档都不到位就用最小的那张，只是不再写缓存）。
         以前这里是「超过 200KB 就整张丢掉」（return ''）：暗场 + 颗粒感的 512px JPEG 完全可能超限，
         于是帧明明抽到了却被丢掉 → 缓存里没写、下次重画再抽再丢，表现就是「这条视频的缩略图永远加载不出来」。
         图片看不出这个问题，是因为 mediaHTML 里图片有「原图」兜底；视频没有。丢帧不是保护，是死循环。 */
      _shrinkPasses() {
        return [[this.MAXSIDE, this.Q], [384, 0.6], [320, 0.5], [256, 0.42]];
      },
      _shrink(el, w, h, opaque) {
        let smallest = '';
        for (const pass of this._shrinkPasses()) {
          const out = this._shrinkOnce(el, w, h, pass[0], pass[1], opaque);
          if (out === null) return '';                 // 画不出来 / 画布被污染：继续换尺寸也没用
          if (out.length <= this.MAXBYTES) return out;
          smallest = out;                              // 记下这一档（越往后越小），留给最后兜底
        }
        return smallest;
      },
      /* 把已解码的图/帧按「最长边 side + 质量 q」缩一份（有透明像素走 PNG，否则 JPEG）。
         返回 null = 根本画不出来（调用方别再重试别的档位）；返回 '' = 画出来是空的。 */
      _shrinkOnce(el, w, h, side, q, opaque) {
        const k = Math.min(1, side / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        if (opaque) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); }
        try { ctx.drawImage(el, 0, 0, cw, ch); } catch (e) { return null; }
        try {
          const d = ctx.getImageData(0, 0, cw, ch).data;
          let alpha = false;
          for (let i = 3; i < d.length; i += 40) { if (d[i] < 250) { alpha = true; break; } }   // 每 10 个像素抽一次
          return alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', q);
        } catch (e) { return null; }   // 画布被污染 / 内存不足
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
          queue_position: '队列位置', note: '备注', priority: '优先级', webhook: '回调',
          /* VGENV 顶层回的那些（文档 02 节的参数表；turbo_requested 是「用户请求了」、
             turbo 是「平台这一次真给了」，两个都留在详情里才对得上报价与账单） */
          seed: '随机种子', upscale: '超分', turbo: 'Turbo', turbo_requested: '请求了 Turbo',
          motion_start_seconds: '动作起点(秒)', preserve_source_audio: '保留原声音',
          creation_intent: '创作意图' };
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

    /* 下载：**一律走浏览器默认方式**（Net.save = createObjectURL + <a download>，存哪由浏览器/系统决定）。
       本项目不再有「下载位置 / 另存为」这一层：没有 File System Access 的目录句柄、
       没有 showSaveFilePicker、页面也不准自己再写一份下载落点 —— 全站只有 Net.save 这一份实现。 */
    async save(url, name) {
      const b = await this.blob(url);
      window.Net.save(b, name);
      return { ok: true };
    },

    /* ---------- 卡片动作区：三台同一套按钮、同一套顺序 ---------- */
    /* o = { preview, previewLabel, download, cancel, retry, remove, removeFile }
       「详情」那一颗的文字会在展开/收起时变（详情 → 收起），而它带着一颗 chevron：
       页面用 ui.js 的 iconSet / btnText 各管一头（textContent = … 会把图标一起抹掉），
       所以这个按钮的文字必须装在 .tx 里、图标装在 .ic 里 —— 结构就固定成下面这样。 */
    actsHTML(t, o = {}) {
      const run = this.isRunning(t), failed = this.isFailed(t);
      const hasMedia = !!o.preview;
      const B = [];
      B.push('<button class="ghost dt"><span class="ic">' + icon('chevronDown', 13) + '</span><span class="tx">详情</span></button>');
      if (hasMedia) B.push('<button class="ghost pv"><span class="ic">' + icon('play', 12) + '</span> ' + esc(o.previewLabel || '预览') + '</button>');
      if (hasMedia && o.download !== false) {
        B.push('<button class="ghost dl2" title="用浏览器默认方式下载">下载</button>');
      }
      if (run && o.cancel) B.push('<button class="ghost danger cx">取消</button>');
      if (failed && o.retry) B.push('<button class="ghost rt"><span class="ic">' + icon('refresh', 12) + '</span> 重试</button>');
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
      on('.dl2', btn => busy(btn, '下载中…', () => this.save(o.dlUrl || t.dl || t.media, o.fileName || 'download')));

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
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('beforeunload', () => { stopped = true; clearTimeout(timer); });

      schedule();
      return {
        tick,
        stop() { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); },
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
      /* 页面级滚动的续拉触发器（唯一一份）：观察一根哨兵，进了视口就回调 onMore。
         与 create().bindScroll 的区别只在于**滚动发生在哪一层** —— 那份是列表容器自己滚
         （工作台的结果区），这份是整页滚（角色 / 收藏 / 资产库都是这样，列表不自带滚动条）。
         老浏览器没有 IntersectionObserver 时退回 window scroll，用同一个提前量判断。

         为什么单独立这一份：这三页原来各写一遍，机制逐字相同（哨兵 + rootMargin 300 +
         window scroll 回退 + 300 余量），只有「触发之后做什么」不同。
         **「拉完之后还要不要再来一轮」现在归这里**（IntersectionObserver 只在相交状态
         **翻转**时回调，哨兵一直留在视口里就永远不再触发 —— 这正是「滚到底等了半天什么都没出来」
         里最难复现的那一半），而**「要不要开始拉」的守卫仍留在页面手里**：
         翻页模式 / 已经到底 / 这一批读失败，页面自己 return（同步返回就等于「别追轮」）。 */
      sentinel(sel, onMore) {
        const box = (typeof sel === 'string') ? document.getElementById(sel) : sel;
        if (!box || typeof onMore !== 'function') return null;
        if (box._sentinelBound) return box._sentinelBound;   /* 同一根哨兵只绑一次 */
        const lead = pullLeadPx(window.innerHeight);
        const pull = makePuller(
          () => box.getBoundingClientRect().top < window.innerHeight + lead, onMore);
        if ('IntersectionObserver' in window) {
          const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) pull(); },
            { rootMargin: lead + 'px' });
          io.observe(box);
          box._sentinelBound = io;
        } else {
          box._sentinelBound = () => { pull(); };
          window.addEventListener('scroll', box._sentinelBound, { passive: true });
        }
        return box._sentinelBound;
      },
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
          /* 滚到底自动续拉（动态加载模式）：提前量与「拉完还贴着就再拉」都走 pullLeadPx / makePuller
             （与哨兵同一份判据，只是滚动发生在容器自己身上）。
             **返回那颗 kick（pull）**，页面「刷新后补一屏」「窗口变高了一屏没填满」都用它 —— 判据只有这一份。
             （这里原来被页面当成 `pager.fill(n)` 调过：api 上根本没有 `fill` 这个方法，调用点是
             `try { pager.fill(...) } catch {}`，于是那两条补齐的路**一次都没跑到过**。）
             绑定后先跑一次：内容不足一屏时**根本不会有任何 scroll 事件**，
             不主动跑这一次，这一屏就永远停在「看着像加载完了」。 */
          bindScroll(boxSel) {
            const box = (typeof boxSel === 'string') ? document.getElementById(boxSel) : (boxSel || o.box);
            if (!box) return null;
            if (box._pagerPull) return box._pagerPull;   // 同一个容器只绑一次
            const lead = pullLeadPx(box.clientHeight || window.innerHeight);
            const pull = makePuller(
              () => box.scrollTop + box.clientHeight >= box.scrollHeight - lead,
              () => {
                if (mode !== 'more' || !o.fill || (o.hasMore && !o.hasMore())) return;
                const g = ++reqSeq;
                return Promise.resolve(o.fill())
                  .then(() => { if (g === reqSeq && o.render) o.render(); });
              });
            box._pagerPull = pull;
            box.addEventListener('scroll', () => { pull(); }, { passive: true });
            pull();
            return pull;
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

    /* ---------- 跨页「拿去生成工作台继续」：载荷与跳转只在这里点一次名 ----------
       资产库 / 收藏 / 素材库三页都要「带着这一条素材跳到工作台对应那一栏」。以前三页各拼一份
       载荷、各写一遍地址，而**消费端只认资产号**：素材库里的一张图只有本机地址、收藏里的本地文件
       只有 IndexedDB 号，两边都没有平台资产号 —— 递过去的是 `assetId: undefined`，工作台那头
       无条件拼出 `/asset/undefined`，取字节必然 404，而界面只留一句「已复用提示词」，
       素材根本没进槽这件事在界面上看不出来。
       载荷只带**工作台真会读的字段**：地址（src）、资产号（assetId，有就带上，能省一次取字节）、
       本机文件号（fileKey，收藏的本地文件只有这个）、名字、提示词。
       别把平台 / 时长 / 画幅塞进来充数 —— 工作台一个字都不读，递了就是「界面上说带过去了、其实没带」。 */
    reuse: {
      kindOf(type) {
        const t = String(type || '');
        return t === '视频' ? 'video' : (t === '音频' || t === '音乐') ? 'audio' : 'image';
      },
      go(o) {
        const raw = String(o.src || '');
        /* 地址本身就是本机资产时，号就写在地址里 —— 认出来，页面只递地址也能走「直接引用」那条快路，
           不必到工作台那头再把字节取一遍。素材库与收藏里的本地文件正是这种情况。 */
        const m = /^\/asset\/([^/?#]+)/.exec(raw);
        const aid = String(o.assetId || (m ? decodeURIComponent(m[1]) : ''));
        const src = raw || (aid ? '/asset/' + aid + '?v=2' : '');
        const kind = o.kind || this.kindOf(o.mtype || o.type);
        const payload = { from: o.from || '', kind, assetId: aid, src,
          dl: o.dl || (aid && /^\/asset\//.test(src) ? '/asset/' + aid + '?dl=1' : ''),
          fileKey: o.fileKey || '', name: String(o.name || o.prompt || '').slice(0, 40), prompt: o.prompt || '',
          /* 参数也带上（E7）：满意某张图的画幅与质量想照着再来一版，复用后全跳回默认、
             得逐个重选 —— 这些值本来就随条目存在，直接取，不另记一份。
             只带**页面上真有那个下拉**的那几项（缺的那几个接收端会自己跳过）。 */
          tier: o.tier || '', res: o.res || '', ar: o.ar || '',
          dur: o.dur == null ? '' : String(o.dur), quality: o.quality || '', size: o.size || '' };
        try { localStorage.setItem('sk_reuse', JSON.stringify(payload)); } catch (e) {}
        location.href = 'studio.html?t=' + kind + '&reuse=1';
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
        /* 落盘加 trailing debounce（U1）：拖拽期间 `move` 按屏幕刷新率触发（60~120 Hz），
           以前每一个 pointermove 都同步写一次 localStorage（还连带 Storage 钩子的 queue）。
           wb_split 在 SYNCABLE 名单里，queue 的 800 ms 合并窗口只压得住 PUT，压不住 setItem 本身。
           拖拽中最多每 250 ms 写一次，松手时 flush 一次落定 —— 观感与「实时保存」无异。 */
        let saveT = 0;
        const flush = () => { if (saveT) { clearTimeout(saveT); saveT = 0; } try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) {} };
        const save = () => { if (saveT) clearTimeout(saveT); saveT = setTimeout(flush, 250); };
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
              flush();                       // 松手落定：把拖拽期间防抖掉的那一次补上（见 save 那段）
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

    /* ---------- 灯箱底部操作条（全站共用：信息 · 下载） ----------
       以前三台各写一份，长得不一样：图片台是两个 <button>（有 hover），视频/语音台是一个 <a>
       （没有 hover、带下划线）。现在按钮在这里统一生成，样式统一放在 ui.css 的 #lbBar 一段
       —— 结构上保证各台一致。下载走浏览器默认方式（Wb.save → Net.save）。
       页面只要提供两件事：
         fileName(item)  下载时的文件名
         urlOf(item)     下载地址；返回空字符串表示这条没有文件可下载（按钮自动隐藏） */
    lbBar: {
      _cfg: null, _item: null,
      init(cfg) {
        const bar = document.getElementById('lbBar');
        if (!bar) return;
        this._cfg = cfg || {};
        if (document.getElementById('lbSave')) return;      // 已经建过就不重复建
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ghost';
        b.id = 'lbSave';
        b.textContent = '下载';
        b.onclick = async e => {
          e.stopPropagation();
          const it = this._item;
          const url = (it && this._cfg.urlOf) ? this._cfg.urlOf(it) : '';
          if (!url) { window.Toast.warn('这条没有可下载的文件'); return; }
          const name = (this._cfg.fileName ? this._cfg.fileName(it) : '') || 'download';
          const old = b.textContent;
          b.disabled = true;
          b.textContent = '下载中…';
          try {
            await window.Wb.save(url, name);
          } catch (err) { window.Toast.err((err && err.message) || err); }
          finally { b.disabled = false; b.textContent = old; }
        };
        bar.appendChild(b);
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
        const sb = document.getElementById('lbSave');
        if (sb) sb.hidden = !url;
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
         · 信息条与「下载 / 详情」直接用 Wb.lbBar + Wb.lbDetail
         · 图片 / 视频 / 音频 / 「进行中的任务」占位都在这里渲染
       页面只声明（cfg）：
         list()            翻页范围（通常是当前视图的条目）
         keyOf(item)       在列表里定位用
         srcOf(item)       媒体地址；可以是 Promise（收藏的本地文件要先读 IndexedDB）
         nameOf(item)      下载时的文件名
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
        /* 视频 / 音频也要有加载失败的兜底：图片那一支本来就有（下面 im.onerror），
           媒体这两支漏了 —— 于是成片被清理掉之后（.renders 只保留最近 20 部）灯箱里是一片黑，
           界面上什么都不说。判据：这一条是不是成片（标签写明「成片」，且有重新合并的路）。 */
        const mediaBad = el => {
          el.onerror = () => {
            const tip = document.createElement('div');
            tip.className = 'lb-hint';
            tip.textContent = /\/(render|play)\b/.test(String(src))
              ? '成片文件已被清理（只保留最近 20 部）—— 重新合并一次就好，素材都还在'
              : '这条视频 / 音频现在读不出来（可能已过期或已被清理）';
            stage.innerHTML = '';
            stage.appendChild(tip);
          };
        };
        stage.innerHTML = '';
        if (kind === 'task') {
          stage.innerHTML = '<div class="lb-hint">' + W.esc(it.status === 'failed' ? '生成失败' : '生成中…') + '</div>';
        } else if (kind === 'video') {
          const v = mk('video');
          mediaBad(v);
          stage.appendChild(v);
        } else if (kind === 'audio') {
          const au = mk('audio');
          mediaBad(au);
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
      if (!p.endpoints || !p.endpoints.cancel) throw new Error((p.displayName || p.name || p.id) + ' 没有声明取消接口（这个平台取消不了，任务会一直跑到出结果）');
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
