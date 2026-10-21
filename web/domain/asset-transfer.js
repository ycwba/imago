/* AssetTransfer — 跨平台素材转存：取字节 / 上传成目标平台资产 / 去重缓存 / 跨平台显式转存。
   从 web/domain/assetlib.js 拆出；端点差异全部由 registry 的 uploads / complete 声明驱动。 */
(function () {
  const CACHE = new Map();          // `${provId}|${srcKey}` → asset_id
  const MAX_BYTES = 200 * 1024 * 1024;

  const pickProv = (reg, provId) => ((reg && reg.providers) || []).find(p => p.id === provId || (p.keyId || p.id) === provId) || null;

  /* 图片 Blob → 最长边 ≤ maxEdge 的 JPEG Blob：给「非上传」的图片槽位把 base64 体量压下来
     （否则一次带 5~6 张 SparkCine PNG 就把 create 请求体顶到几十 MB，上游直接 413）。
     读不出来的（HEIC、损坏、非位图）直接 reject，让调用方退回原字节。 */
  async function shrinkBlobToJpeg(blob, maxEdge, quality) {
    const bmp = await createImageBitmap(blob);
    if (!bmp) throw new Error('读不出图片位图');
    const w0 = bmp.width || 1, h0 = bmp.height || 1;
    const scale = Math.min(1, (maxEdge || 1024) / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    // JPEG 没有透明通道，透明 PNG 直接 drawImage 会把透明像素留成黑底；先铺白再画
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    try { bmp.close && bmp.close(); } catch {}
    return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('canvas 编码失败')), 'image/jpeg', quality || 0.82));
  }

  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function b64ToBlob(dataUrl, mime) {
    const arr = window.b64Bytes(String(dataUrl).split(',')[1] || '');
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }
  /* 上传用的文件名：调用方给了带尾缀的名就照用；否则现造一个。
     尾缀口径在公共层（ui.js 的 blobExtOf），这里只管名字前缀。 */
  function fileNameOf(blob, name) {
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
    return 'asset-' + Date.now() + '.' + window.blobExtOf(blob);
  }
  /* 读代理的 NDJSON 进度流（见 proxy.js 的 s3putStream）：
     progress 帧回调 onProgress(sent, total, pct)，返回最后一帧（done / error）。
     响应不是 NDJSON（代理还是旧版）时返回 null，调用方按老的「只看 HTTP 状态」处理。 */
  async function readProgressStream(res, onProgress) {
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('ndjson')) return null;
    let last = null;
    const feed = line => {
      const s = String(line || '').trim();
      if (!s) return;
      let f = null;
      try { f = JSON.parse(s); } catch { return; }
      if (f.t === 'progress') { if (onProgress) onProgress(f.sent || 0, f.total || 0, f.pct); }
      else if (f.t === 'done' || f.t === 'error') last = f;
    };
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      feed(buf);
    } else {
      String(await res.text()).split('\n').forEach(feed);
    }
    return last;
  }

  window.AssetTransfer = {
    MAX_BYTES,
    /* File/Blob → dataURL：导演台与生成工作台以前各写一份 fileToDataURL（同一个 FileReader 配方逐字重复，
       改一处要记得改两处）。放这儿是因为它就是 blobOf 的下一步 —— 取回字节 → 变成 dataURL 交给上游。 */
    toDataURL(fileOrBlob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(fileOrBlob);
      });
    },    /* 本平台资产 id 的形态（SparkCine 是 UUID）。本地资产 la_* / 别家平台的 id 直接当 asset_id 提交会被上游判为
       「Invalid UUID」→ 顶层只回一句「部分内容需要检查。」，所以提交前先用它把不属于本平台的 id 挡掉，改走上传字节。 */
    isPlatformId(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '')); },
    /* 统一取 Blob（自动选路：本地 / 同源 / 外部代理） */
    /* 读响应体并顺带报进度。为什么要自己读而不是 `r.blob()`：
       `blob()` 只给你一个成品 Blob，中途任何百分比都拿不到 ——
 而「正在把产物存到本机」这件事慢就慢在下载上（一个 200MB 的视频几分钟），
 用户在侧栏看到的却是同一个「正在存」不动。流式读一遍就为了这个数字。 */
    async readBlobWithProgress(r, onStage, total) {
      if (!onStage || !r.body || !r.body.getReader) { const b0 = await r.blob(); return b0; }
      const rd = r.body.getReader();
      const parts = [];
      let sent = 0, lastAt = 0, lastPct = -1;
      for (;;) {
        const chunk = await rd.read();
        if (chunk.done) break;
        if (!chunk.value || !chunk.value.length) continue;
        parts.push(chunk.value);
        sent += chunk.value.length;
        const now = Date.now();
        /* 每 200ms 或每跨过 1% 报一次：更密没有意义（那个数字是给人看的），
           更疏会让 100MB 的视频看起来一跳一跳。 */
        const pct = total ? Math.floor(sent * 100 / total) : -1;
        if (now - lastAt >= 200 || (pct >= 0 && pct > lastPct)) {
          lastAt = now; lastPct = pct;
          onStage('fetch', { sent, total });
        }
      }
      const all = new Blob(parts, { type: (r.headers && r.headers.get && r.headers.get('content-type')) || '' });
      onStage('fetch', { sent, total });
      return all;
    },
    async blobOf(source, onStage) {
      if (!source) throw new Error('素材为空');
      if (typeof source === 'object' && typeof source.arrayBuffer === 'function' && typeof source.size === 'number') return source;   // File / Blob
      const s = String(source);
      if (s.startsWith('data:')) {
        const mime = (/^data:([^;,]+)/.exec(s) || [])[1] || 'application/octet-stream';
        const b = b64ToBlob(s, mime);
        if (!b.size) throw new Error('dataURL 内容为空');
        return b;
      }
      // 外部链接走本地代理取回（浏览器直连会被 CORS 拦）；同源相对路径直接取
      const isExternal = /^https?:\/\//i.test(s);
      const url = isExternal ? '/getfile?url=' + encodeURIComponent(s) : Api.assetDlSrc(s);
      /* `onStage('fetch', {sent, total})` 边下边报进度：读响应体时按 chunk 累加，
         总量取 Content-Length（代理在 /getfile 那一支把上游的长度原样透出）。
         进度不需要代理额外报数：取回是同一条 TCP 链，上游慢 → 代理这边就出字节慢 →
         chunk 到得慢，客户端数出来的百分比就是真实进度。
         读不到 Content-Length（chunked）时 total = 0：调用方要按「大小未知」显示，
         不能拿 0 当分母算出个假进度。 */
      if (onStage) onStage('fetch', { sent: 0, total: 0, name: s });
      const r = await netFetch(url, { timeout: 180000, retry: 1 });   // 大视频取回可能较久；GET 可安全重试
      if (!r.ok) throw new Error('取回素材失败 HTTP ' + r.status);
      const total = Number(r.headers && (r.headers.get ? r.headers.get('content-length') : r.headers['content-length'])) || 0;
      const b = await AssetTransfer.readBlobWithProgress(r, onStage, total);
      if (!b.size) throw new Error('取回的内容为空（链接可能已过期）');
      return b;
    },

    /* 上传成指定平台的资产，返回 asset_id（按 registry 声明驱动） */
    async uploadTo(provId, blob, name, opts = {}) {
      const reg = opts.reg;
      const prov = pickProv(reg, provId);
      if (!prov) throw new Error('找不到平台：' + provId);
      const ep = prov.endpoints || {};
      const up = ep.uploads;   // registry 只认这一种端点名（uploads / complete）
      if (!up) throw new Error((prov.name || provId) + ' 暂无素材上传接口（可在 registry 里为它声明 endpoints.uploads）');
      if (blob.size > MAX_BYTES) throw new Error('素材超过 ' + window.fmtBytes(MAX_BYTES) + '，无法上传');
      /* 槽位自己的体积上限（registry 的 inputRoles.maxBytes，例如 VGENV 参考音频 ≤ 50MB）：
         以前只在页面文案里写「≤ 50MB」却没人校验，超了要等上游报错才知道。 */
      const slotMax = (opts.role && window.Capabilities && Capabilities.providerLimit)
        ? Capabilities.providerLimit(opts.reg, provId, opts.role) : 0;
      if (slotMax && blob.size > slotMax) throw new Error((opts.role ? '这个槽位' : '平台') + '收不下：上限 ' + window.fmtBytes(slotMax) + '，当前 ' + window.fmtBytes(blob.size));
      const template = Api.inputTemplate(prov, opts.role);
      if (template && template.requiresAudio) {
        if (opts.onStage) opts.onStage('prepare');
        const prepared = await netFetch('/media/prepare-reference-video', {
          method: 'POST', headers: { 'Content-Type': blob.type || opts.contentType || 'application/octet-stream' },
          body: blob, timeout: 180000, retry: 0,
        });
        if (!prepared.ok) {
          const error = await prepared.json().catch(() => null);
          throw new Error((error && error.error && error.error.message) || ('参考视频预处理失败 HTTP ' + prepared.status));
        }
        const added = prepared.headers.get('X-Audio-Added') === '1';
        blob = await prepared.blob();
        if (added) {
          name = (opts.name || name || 'reference').replace(/\.[^.]+$/, '') + '.mp4';
          opts = { ...opts, name, contentType: 'video/mp4' };
        }
        if (opts.onStage) opts.onStage('prepared', added);
        if (blob.size > MAX_BYTES) throw new Error('补全音轨后的视频超过上传大小上限');
      }
      const mime = blob.type || opts.contentType || 'application/octet-stream';
      const filename = opts.name || fileNameOf(blob, name);
      const headers = Api.headers(prov, { 'Content-Type': 'application/json' });

      /* 上传意图的字段命名由 registry 声明（SparkCine 是 filename/content_type/byte_length，
         VGENV 是 fileName/contentType/sizeBytes）—— 以前这里写死成 SparkCine 的命名，
         发给 VGENV 会因为「未知字段 + 缺必填」被拒。 */
      const UF = (prov && prov.create && prov.create.uploadFields) || {};
      const body = {};
      body[UF.fileName || 'filename'] = filename;
      body[UF.contentType || 'content_type'] = mime;
      body[UF.sizeBytes || 'byte_length'] = blob.size;
      /* sha256 由 registry 决定发不发：SparkCine **必填**（不传直接 VALIDATION_FAILED），
         VGENV **拒绝未知字段**（传了回 400「property sha256 should not exist」）。
         以前这里无条件发 sha256 → VGENV 的每一次上传都 400。 */
      if (UF.sha256 && !opts.skipHash) {
        try { body[UF.sha256] = await sha256Hex(await blob.arrayBuffer()); } catch {}
      }

      if (opts.onStage) opts.onStage('intent', filename);
      /* 上传意图的解析要经得起「2xx 但形状不对」：出站系统代理（7897 那一条链）断 TLS / 劫持时
         实测能把这一发 POST 回成一份缺字段的 2xx 响应，旧代码在这种日子直接报
         「上传意图返回异常（缺少 asset_id 或 upload.url）」并把整条合并打断。
         意图创建本身不扣费、无副作用（重问一次最多是一条新的 pending 资产），
         所以形状不对就地重试一次；字段接受嵌套（upload.url）与平铺（upload_url）两种写法；
         两次都拿不到才抛，并把原始响应体截一段带进错误（否则下一轮排查只能靠猜）。 */
      let assetId = null, putUrl = '', putMethod = 'PUT', putHeaders = {}, reused = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const intentRes = await netFetch(prov.relay + up, {
          method: 'POST', headers, body: JSON.stringify(body), timeout: 30000, retry: 0,
        });
        if (!intentRes.ok) throw new Error('取上传地址失败 HTTP ' + intentRes.status + '（' + (prov.displayName || prov.name) + ' 的上传接口）');
        const intent = await intentRes.json().catch(() => null);
        if (intent && intent.error) throw new Error((intent.error.message || intent.error) + '（' + (prov.displayName || prov.name) + ' 的上传接口）');
        assetId = intent && (intent.asset_id || intent.assetId || (intent.asset && (intent.asset.id || intent.asset.asset_id)));
        const u = (intent && intent.upload) || intent || {};
        putUrl = u.url || u.upload_url || u.uploadUrl || '';
        /* 「这一份平台上已经有了」—— 上传意图按内容（sha256）去重：同一段素材第二次上传时
           平台**只回资产号**（upload 是 null、reused:true、state 已是 READY），不会给上传地址。
           本地导入同一个视频第二次、或两个镜头用同一段素材，走的都是这一支
           （导演台「导入视频 / 素材」与导出成片时的本机转存都会到这里）。
           认不出它就会把整条合并打断在「上传意图返回异常」上，而素材其实早就传好了 ——
           重试一次也只是同一句回答。所以：有资产号 + 没有上传地址 + （reused 或已 READY）
           = 直接用这个资产号，不 PUT、不 complete（那一份本来就是完整的）。 */
        const ready = /^ready$/i.test(String((intent && intent.state) || ''));
        reused = !!assetId && !putUrl && (intent.reused === true || ready);
        if (assetId && (putUrl || reused)) {
          if (putUrl) { putMethod = u.method || 'PUT'; putHeaders = u.headers || {}; }
          break;
        }
        if (attempt === 0) { await new Promise(r => setTimeout(r, 1500)); if (opts.onStage) opts.onStage('intent', filename + '（重问上传地址）'); }
        else throw new Error('上传意图返回异常（缺少资产号或上传地址）：' + (prov.displayName || prov.name)
          + ' 回了 2xx 但里面没有 asset_id / upload.url，重试一次仍拿不到。原始返回：'
          + String(JSON.stringify(intent)).slice(0, 200));
      }
      /* 复用平台上已有的那一份：没有字节要传，也没有「确认上传」要发（它早就 READY）。 */
      if (reused) return assetId;

      if (opts.onStage) opts.onStage('put', filename);
      if (opts.onStage) opts.onStage('progress', { sent: 0, total: blob.size, pct: 0 });   // 先报 0%，状态行立刻切成进度显示
      const put = await netFetch('/s3put?url=' + encodeURIComponent(putUrl), {
        method: putMethod, headers: putHeaders, body: blob,
        timeout: 600000,        // 大素材（视频）本机 → 对象存储这一段可能要几分钟
        retry: 0,               // 上传不做自动重试：重试 = 再传一遍整份素材
      });
      /* 代理会把「本机 → 对象存储」那一公里的真实进度按 NDJSON 帧回传（真正慢的一段；
         fetch 的 upload 事件只能看到本机回环那一段，所以进度由代理给）。
         最后一帧带上游状态与响应体：对象存储的报错（签名不符、长度不符…）以前看不到，现在能显示出来。 */
      /* 进度流必须是 NDJSON（当前代理）；不是的话说明代理是旧版，按老的「只看 HTTP 状态」处理。
         但**是 NDJSON 却没收到终帧**（done/error）时，说明流被中途掐断了 ——
         这时 put.ok 是响应头早就给的 200，不能当成功，否则会对一份没传完的素材调 complete，
         平台侧留下一份残缺素材、产出损坏还没有任何报错。 */
      const isNdjson = String(put.headers.get('content-type') || '').includes('ndjson');
      const fin = await readProgressStream(put, (sent, total, pct) => {
        if (opts.onStage) opts.onStage('progress', { sent, total: total || blob.size, pct });
      });
      if (fin) {
        if (fin.t === 'error') throw new Error('素材上传失败：' + fin.message);
        if (!(fin.status >= 200 && fin.status < 300)) {
          throw new Error('素材上传失败 HTTP ' + fin.status + (fin.body ? '（' + String(fin.body).slice(0, 180) + '）' : ''));
        }
      } else if (isNdjson) {
        throw new Error('素材上传中断（进度流没有收到结束帧）：这份素材没有传完，请重试');
      } else if (!put.ok) {
        throw new Error('素材上传失败 HTTP ' + put.status);   // 兼容旧代理（响应不是进度流）
      }

      const completeTpl = ep.complete || (up + '/{id}/complete');
      const cr = await netFetch(prov.relay + completeTpl.replace('{id}', assetId), {
        method: 'POST', headers: Api.headers(prov), timeout: 30000, retry: 0,
      });
      if (!cr.ok) throw new Error('素材上传确认失败 HTTP ' + cr.status);
      return assetId;
    },

    /* 一步到位：取 Blob → 上传 → asset_id（同一素材+平台结果缓存，不重复上传） */
    async toAsset(provId, source, opts = {}) {
      const template = Api.inputTemplate(pickProv(opts.reg, provId), opts.role);
      const cacheKey = (await this._keyOf(provId, source)) + (template && template.requiresAudio ? '|audio-required' : '');
      if (!opts.noCache && cacheKey && CACHE.has(cacheKey)) return CACHE.get(cacheKey);
      const blob = await this.blobOf(source, opts.onStage);
      const aid = await this.uploadTo(provId, blob, opts.name, opts);
      if (cacheKey) {
        if (CACHE.size > 100) CACHE.clear();           // 容量保护
        CACHE.set(cacheKey, aid);
      }
      return aid;
    },
    /* 缓存键：优先用内容 md5（同名不同内容不会撞车），取不到再退回「名字+大小」 */
    async _keyOf(provId, source) {
      try {
        if (typeof source === 'string' && !source.startsWith('data:')) return provId + '|url|' + source;
        const blob = await this.blobOf(source);
        const buf = await blob.arrayBuffer();
        const h = await crypto.subtle.digest('SHA-256', buf);
        const hex = [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
        return provId + '|sha|' + hex;
      } catch {
        const name = (source && source.name) || '';
        return provId + '|' + name + '|' + ((source && source.size) || '');
      }
    },

    /* 一个来源 → 这个平台这个槽位的 inputEntry（{ role, assetId | url }）。
       形状只由 registry 的 inputTemplates 决定：needsUpload 的模板必须先上传拿资产号，
       其余转成 dataURL（本机的 /getv、/asset 地址上游访问不到，只能把字节发过去）。
       返回 null = 注册表没声明这个 role 的模板（调用方按「这个槽位发不了」处理，别猜形状）。
       source 可以是 File/Blob、dataURL、/asset/<id>、/getv?url=…、或上游外链。 */
    async entryFor(prov, role, source, opts = {}) {
      const tpl = Api.inputTemplate(prov, role);
      if (!tpl) return null;
      if (tpl.needsUpload) {
        const aid = await this.toAsset(prov.id, source, Object.assign({}, opts, { role }));
        if (!aid) throw new Error('上传后没拿到资产号');
        return { role, assetId: aid };
      }
      let blob = await this.blobOf(source, opts.onStage);
      /* 非上传槽位要把字节 base64 塞进 create 请求体：一次带 5~6 张 SparkCine 的 PNG
         （脸 + 三视图 + 首帧）很容易顶到 20~30 MB，上游直接 413「素材太大」。
         只在**图片 + 超过 250KB**时缩到最长边 1024 的 JPEG —— 参考图只是给视频 AI 认人用的，
         1024 足够；视频 / 音频原样透传（它们本来就该走上传路径）。 */
      const isImg = /^image\//i.test(blob.type || '') || /^data:image\//i.test(String(source).slice(0, 24));
      if (isImg && blob.size > 250 * 1024) {
        const shrunk = await shrinkBlobToJpeg(blob, 1024, 0.82).catch(() => null);
        if (shrunk && shrunk.size < blob.size) blob = shrunk;
      }
      const url = await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = () => rej(rd.error || new Error('读不出素材字节'));
        rd.readAsDataURL(blob);
      });
      if (!url) throw new Error('取不到素材字节');
      return { role, url };
    },

    /* 跨平台转存的显式写法：素材来自 A 平台/外部，需要变成 B 平台资产 */
    async crossTransfer(from, toProv, source, opts = {}) {
      if (opts.onStage) opts.onStage('transfer', (from && from.name) || '外部来源', toProv);
      return await this.toAsset(toProv, source, opts);
    },

    /* 「把挑来的这一张落成本机资产，要的是一个**记得住**的地址」。
       选择器递回来的条目有两种地址是「当场能用、过后就没了」：本地上传那张是 `blob:`（刷新即失效），
       资产库/收藏那张可能是上游签名外链（只管一天）。而素材库存的是**字符串地址**（随 char_lib 落盘），
       记进这两种就等于把一张已经不存在的图写进库里 —— 第二天卡片是破图，拍的时候也带不上它。
       本来就是本机资产的条目原样退回（`fresh:false`），不再存第二份。 */
    async toLocalAsset(source, opts = {}) {
      const direct = typeof source === 'string' ? source : '';
      if (/^\/asset\/[^/?#]/.test(direct)) {
        return { assetId: decodeURIComponent((/^\/asset\/([^/?#]+)/.exec(direct) || ['', ''])[1]), src: direct, fresh: false };
      }
      const blob = (typeof Blob === 'function' && source instanceof Blob) ? source : await this.blobOf(source, opts.onStage);
      if (!blob || !blob.size) throw new Error('这条素材的字节取不到了（本机文件可能已经不在了）');
      const nm = String(opts.name || blob.name || '素材').slice(0, 60);
      const fmt = (nm.match(/\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|ogg|m4a|flac|aac)$/i) || [])[1]
        || (String(blob.type || '').split('/')[1] || 'bin').replace('jpeg', 'jpg');
      const b64 = String(await this.toDataURL(blob)).split(',')[1] || '';
      if (!b64) throw new Error('读不出这条素材的字节');
      const ext = String(fmt).toLowerCase();
      /* 洗字符走公共那一份（`ui.js` 的 `fileSafe`）—— 这一处以前自己写成换 `_`，
         而「另存到指定文件夹」那条链（上面 `nameOf`）换成 `-`，同一份字节在本机记录里与在用户目录里就不同名。 */
      const safe = window.fileSafe(nm, 60);
      const r = await Api.saveLocalAsset({
        name: safe.slice(-(ext.length + 1)).toLowerCase() === '.' + ext ? safe : safe + '.' + ext,
        mime: blob.type || '', format: ext, data: b64,
        meta: { prompt: opts.prompt || '', source: opts.from || 'picker' },
      });
      const id = r && (r.assetId || r.id);
      if (!id) throw new Error('本机没收下这份素材（代理没返回资产号）');
      return { assetId: id, src: Api.assetSrc(id), fresh: true };
    },
  };
})()
