/* MediaBackend —— 浏览器内媒体处理的唯一入口（取帧 / 探信息 / 抽音轨 / 兜底解码全在这一份）。
   主档 mediabunny（WebCodecs 流式解码，vendor 在 web/vendor/mediabunny.min.mjs，**按需动态 import**）；
   兜底 <video> + drawImage（浏览器原生，任何格式只要 <video> 能放就能取帧）。
   剪辑与导出都走这一份，不许再各写一套 createElement('video') —— 八处取帧点全收在这里。

   ⚠ 为什么主档是 mediabunny：远程素材（签名外链）稀疏关键帧时 <video> 的定点 seek 会塌成重复帧，
     而整段流式解码不会；取帧这一层要把「哪条链」的选择权拿在自己手里（selectChain）。
   ⚠ 兜底不丢：WebCodecs 不认的编码（老 WMV 之类）<video> 反而放得出 —— 探针不过就退兜底，
     绝不能「不支持就不给图」（那会让老素材整排空白）。
   ⚠ 经典脚本（挂 window）：Wb.vframe 是经典脚本不能 import ESM，这一份也按经典脚本写，
     内部用动态 import() 拉 mediabunny（CSP 的 script-src 'wasm-unsafe-eval' 已放行 wasm 编译）。 */
(function () {
  'use strict';

  const VENDOR = '/web/vendor/mediabunny.min.mjs';
  /* mediabunny 模块（按需动态 import + 缓存成功那一次）。
     失败时必须把这只 promise 撤掉：一次首屏网络抖动若被缓存成永久的 null，
     取帧 / 缩略图 / 抽音轨这一整场就再也不会回到主档，只能一直走 <video> 兜底。
     在途的那一次由并发调用共用（都挂在同一只 promise 上），不会为同一帧拉好几遍。 */
  let mbPromise = null;

  function loadM() {
    if (mbPromise) return mbPromise;
    const p = import(VENDOR).catch(() => {
      if (mbPromise === p) mbPromise = null;      // 只撤自己这一只，别把后来那一次的重试一起清掉
      return null;
    });
    mbPromise = p;
    return p;
  }

  /* ---------------- 兜底档：<video> + drawImage ----------------
     与旧 Wb.vframe 同一套写法（muted/playsInline/preload、meta 等 loadedmetadata、
     seek 等 seeked、drawImage 进 canvas）—— 搬进这里后 Wb.vframe 只剩转发壳。 */
  function sameSrc(src) {
    const s = String(src || '');
    return /^https?:/i.test(s) ? '/fetch?url=' + encodeURIComponent(s) : s;
  }
  function isBlobSrc(src) {
    return !!(src && typeof src === 'object' && typeof src.size === 'number'
      && (typeof src.arrayBuffer === 'function' || typeof src.slice === 'function'));
  }
  /* mediabunny 的输入源按类型选：**File / Blob 必须走 BlobSource**。
     包成 blob: 地址交给 UrlSource 时，它的分段读取在部分文件上会一直等数据
     （实测同一段视频走服务端地址 1.2 秒出帧，走 blob: 地址 12 秒超时都拿不到）。 */
  function mbSourceOf(M, src) {
    return isBlobSrc(src) ? new M.BlobSource(src) : new M.UrlSource(sameSrc(src));
  }
  function videoEl(src) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.src = sameSrc(src);
    return v;
  }
  function releaseVideo(v) {
    try { v.removeAttribute('src'); v.load(); } catch (e) { /* 解码器放不掉就让它跟着 GC 走 */ }
  }
  function videoMeta(v) {
    return new Promise((res, rej) => {
      if (v.readyState >= 1) return res();
      let done = false;
      const finMb = ok => {
        if (done) return; done = true;
        clearTimeout(to);
        v.removeEventListener("loadedmetadata", onOkMb); v.removeEventListener("error", onErrMb);
        ok ? res() : rej(new Error('视频读不出来（格式不支持，或地址已过期）'));
      };
      const onOkMb = () => finMb(true), onErrMb = () => finMb(false);
      const to = setTimeout(() => finMb(false), 20000);
      v.addEventListener("loadedmetadata", onOkMb);
      v.addEventListener("error", onErrMb);
      v.load();
    });
  }
  function videoSeek(v, t) {
    return new Promise((res, rej) => {
      let done = false;
      const finMb = ok => {
        if (done) return; done = true;
        clearTimeout(to);
        v.removeEventListener('seeked', onSeekMb); v.removeEventListener('error', onErr2Mb);
        ok ? res() : rej(new Error('视频定位失败（文件损坏或格式不支持）'));
      };
      const onSeekMb = () => finMb(true), onErr2Mb = () => finMb(false);
      const to = setTimeout(() => finMb(false), 15000);
      v.addEventListener('seeked', onSeekMb, { once: true });
      v.addEventListener('error', onErr2Mb, { once: true });
      try { v.currentTime = t; } catch (e) { finMb(false); return; }
      if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) finMb(true);
    });
  }

  /* 兜底取一帧 → { blob, w, h }（PNG）。which: 'first'|'start'|'last'|undefined + atSeconds 覆盖 */
  async function grabByVideo(src, which, atSeconds) {
    const first = which === 'first' || which === 'start';
    /* File / Blob 不能直接塞给 <video>：给它一枚临时对象地址，收尾一起放掉。 */
    const tmpUrl = isBlobSrc(src) ? URL.createObjectURL(src) : '';
    const v = videoEl(tmpUrl || src);
    try {
      await videoMeta(v);
      let dur = isFinite(v.duration) ? Number(v.duration) : 0;
      if (!(dur > 0)) {
        try { const sk = v.seekable; if (sk && sk.length) dur = Number(sk.end(sk.length - 1)) || 0; } catch (e) {}
      }
      if (atSeconds != null) {
        const t = Math.max(0, Math.min(Number(atSeconds) - 0.05, Math.max(0, dur - 0.05)));
        await videoSeek(v, t);
      } else if (dur > 0) {
        await videoSeek(v, first ? 0 : Math.max(0, dur - 0.05));
      } else if (!first) {
        /* 读不到时长（直播式 MP4 / moov 在文件尾的流）也照样能取最后一帧：
           currentTime 设一个极大值，浏览器会夹到真实末尾并触发 seeked。
           比直接报「取不到最后一帧」有用 —— 那种文件恰恰是这一条兜底最该接住的。 */
        await videoSeek(v, 1e7);
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
      releaseVideo(v);
      if (tmpUrl) { try { URL.revokeObjectURL(tmpUrl); } catch (e) { /* 放不掉就跟着页面走 */ } }
    }
  }

  /* 顺序取帧器：浏览器内导出在 WebCodecs 解不动时退逐格 seek，用的就是这一只。
     返回 { mode, next(), dispose() }：next() 给出可直接 drawImage 的 <video>，取不到给 null。
     mode='unavailable' = 连元数据都拿不到（地址过期 / 格式不支持），后面每一格都是 null。 */
  async function seekIterByVideo(src, times) {
    const v = videoEl(src);
    try { await videoMeta(v); } catch (e) {
      return {
        mode: 'unavailable',
        async next() { return null; },
        dispose() { releaseVideo(v); },
      };
    }
    let idx = 0;
    return {
      mode: 'precise-seek',
      async next() {
        if (idx >= times.length) return null;
        const t = Math.max(0, Number(times[idx++]) || 0);
        /* 定位失败照旧交这一帧（上一格画面）：导出是一条直线，不能因为一格超时整段停下 */
        try { await videoSeek(v, t); } catch (e) { /* 同上：超时就画上一帧 */ }
        return v;
      },
      dispose() { releaseVideo(v); },
    };
  }

  /* 兜底：探媒体信息（时长 / 宽高 / 有没有音轨）—— 只在 mediabunny 探不到时用 */
  async function infoByVideo(src) {
    const v = videoEl(src);
    try {
      await videoMeta(v);
      const dur = isFinite(v.duration) ? Number(v.duration) : 0;
      return {
        duration: dur, width: v.videoWidth, height: v.videoHeight,
        hasAudio: (v.mozHasAudio || v.webkitAudioDecodedByteCount > 0 || (v.audioTracks && v.audioTracks.length > 0)) || false,
        chain: 'video',
      };
    } finally {
      releaseVideo(v);
    }
  }

  /* ---------------- 主档：mediabunny ----------------
     探信息：Input + getPrimaryVideoTrack/getPrimaryAudioTrack + computeDuration。
     取帧：CanvasSink 定点 / canvases() 整段流式（由调用方选）。 */

  /* 取一帧就收：显式拿迭代器，拿完 await return() 再交还给调用方去释放
     （CanvasSink.getCanvas 内部收尾是异步的，不等它就释放 input 会抛 InputDisposedError）。
     ⚠ sink 的迭代器 yield 的是**包裹对象** { canvas, timestamp, duration }（vendor 现版本如此），
       真画布在 .canvas 上 —— 直接把 yield 值当画布用，toBlob 一类方法全不存在（media-export.js
       的两处消费点都是这么解包的，这里必须同一套）。 */
  async function canvasAt(sink, t) {
    const it = sink.canvasesAtTimestamps([t])[Symbol.asyncIterator]();
    try {
      const r = await it.next();
      return r.done ? null : (r.value && r.value.canvas) || null;
    } finally {
      try { await it.return(); } catch (e) { /* 收尾失败不影响已经拿到的帧 */ }
    }
  }

  async function infoByMb(src) {
    const M = await loadM();
    if (!M) return null;
    const input = new M.Input({ source: mbSourceOf(M, src), formats: M.ALL_FORMATS });
    try {
      const dur = await input.computeDuration();
      const vt = await input.getPrimaryVideoTrack();
      const at = await input.getPrimaryAudioTrack();
      let width = 0, height = 0;
      if (vt) {
        try {
          const st = await vt.computePacketStats(1);
          if (st && st.width) { width = st.width; height = st.height; }
        } catch (e) { /* 元数据拿不全就留 0，调用方再退 video 兜底 */ }
        if (!width) {
          try {
            const cs = (await vt.canDecode()) ? await canvasAt(new M.CanvasSink(vt), 0) : null;
            if (cs) { width = cs.width; height = cs.height; }
          } catch (e) { /* 取不到就留 0，调用方再退 video 兜底 */ }
        }
      }
      return {
        duration: Number(dur) || 0, width: width, height: height,
        hasAudio: !!at, chain: 'mediabunny',
      };
    } finally {
      try { input.disposeInput(); } catch (e) { /* dispose 失败不影响结果 */ }
    }
  }

  /* 主档取一帧：CanvasSink 定点。首帧黑画布问题：t=0 附近取 0.26s 再归一（部分 WebM 首 GOP 是合成黑帧）。
     整个解码包在 12 秒 race 里跑：输掉的那一只原本会带着 Input 挂死在解码器上（下面的「一直等
     下一个包」），缩略图轮询反复触发、同一个文件每试一次攒一只 —— 超时即 dispose，work 侧收到
     中断错误后走自己的收尾，调用方照旧退 <video> 兜底。 */
  async function grabByMb(src, which, atSeconds) {
    const M = await loadM();
    if (!M) return null;
    const first = which === 'first' || which === 'start';
    const input = new M.Input({ source: mbSourceOf(M, src), formats: M.ALL_FORMATS });
    let disposed = false, timedOut = false, to = 0;
    const disposeInput = () => { if (!disposed) { disposed = true; try { input.disposeInput(); } catch (e) { /* 同上 */ } } };
    try {
      const work = (async () => {
      const vt = await input.getPrimaryVideoTrack();
      if (!vt || !(await vt.canDecode())) return null;
      const dur = Number(await input.computeDuration());
      let t;
      if (atSeconds != null) {
        if (!Number.isFinite(dur) || dur <= 0) return null;   // 时长读不出来：交 <video> 兜底
        t = Math.max(0, Math.min(Number(atSeconds), Math.max(0, dur - 0.05)));
      } else if (first) t = 0.26;                  // 避开首 GOP 合成黑帧，取回后归一回 0
      else {
        /* 「最后一帧」不能直接拿 dur-0.05：采样器只收时间戳 ≥ 请求点的样本，
           而低帧率视频最后一帧的时间戳可能比 dur 早一整帧（10fps 就早 0.1s）——
           请求点落在最后一包之后，它会一直等下一个样本，表现就是「一直在取尾帧」。
           按实测帧率退一帧半，保证请求点落在最后一帧自己的时长里。 */
        if (!Number.isFinite(dur) || dur <= 0) return null;
        let back = 0.05;
        try {
          const st = await vt.computePacketStats(120);
          const rate = st && Number(st.averagePacketRate);
          if (rate > 0) back = Math.max(0.05, 1.5 / rate);
        } catch (e) { /* 帧率拿不到就按 0.05 兜底 */ }
        t = Math.max(0, dur - back);
      }
      const sink = new M.CanvasSink(vt);
      let canvas;
      try { canvas = await canvasAt(sink, t); } catch (e) { return null; }
      if (!canvas) return null;
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return null;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob || !blob.size) return null;
      return { blob, w, h };
      })();
      let r;
      try {
        r = await Promise.race([
          work,
          new Promise((_, rej) => { to = setTimeout(() => { timedOut = true; disposeInput(); rej(new Error('主档取帧超时')); }, 12000); }),
        ]);
      } catch (e) {
        clearTimeout(to);
        if (timedOut) { work.catch(() => {}); return null; }   // 超时 = 主档解不动，交 <video> 兜底
        return null;
      }
      clearTimeout(to);
      return r;
    } finally {
      disposeInput();
    }
  }

  /* ---------------- 批量取帧（切片预览的主链） ----------------
     一个 Input 一趟解完一条素材的帧索引：
       · 包数 ≤ 上限 → canvases(0, duration) **整段流式**（顺序解一遍，快；帧全收）；
       · 否则按调用方给的栅格定点解（canvasesAtTimestamps）—— 只对**本机**素材走这条
         （远程稀疏关键帧的定点 seek 会塌成重复帧，那是参考项目踩过的坑），远程一律退 <video> 分块。
     编码在主线程（canvas.toBlob）：mediabunny 给的已经是 canvas，不经过 slice-worker；
     worker 只留给 <video> 兜底那条。
     `plan(dur, has)` 由调用方给（数据层的密度口径在那边，slice.js 的 frameIndexPlan）：
       返回升序时刻数组，has(t) = 这一时刻已经有帧、不用再解。
     `onFrame({ t, blob })` 每出一帧报一声（边解边上屏）。返回 { frames, dur, mode }：
       mode='fallback' = mediabunny 解不动这一份（没有视频轨 / canDecode 假 / 抛错），调用方退 <video>。 */
  async function framesByMb(src, opts) {
    const o = opts || {};
    const M = await loadM();
    if (!M) return { mode: 'fallback' };
    const input = new M.Input({ source: mbSourceOf(M, src), formats: M.ALL_FORMATS });
    const made = [];
    let disposed = false, timedOut = false, to = 0;
    const disposeInput = () => { if (!disposed) { disposed = true; try { input.disposeInput(); } catch (e) { /* dispose 失败不影响结果 */ } } };
    try {
      const work = (async () => {
      const vt = await input.getPrimaryVideoTrack();
      if (!vt || !(await vt.canDecode())) return { mode: 'fallback' };
      const dur = Math.max(0.05, Number(await input.computeDuration()) || 0);
      /* 包数（元数据级，便宜）先数一遍：决定走整段流式还是定点。宽高也顺路拿到。 */
      const cap = Math.max(1, Number(o.cap) || 480);
      const stats = await vt.computePacketStats(cap + 1);
      const streamable = stats && stats.packetCount > 0 && stats.packetCount <= cap + 1;
      const has = typeof o.has === 'function' ? o.has : () => false;
      const times = (typeof o.plan === 'function' ? o.plan(dur, has) : []).filter(t => !has(t));
      /* 全都已有帧 / 全在退避：一趟都不解（索引是按趟合并的，重复解只会浪费）。 */
      if (!times.length) return { frames: made, dur, mode: 'fixed' };
      /* 远程素材（签名外链 / fetch 转发）绝不走定点 seek —— 稀疏关键帧的定点会塌成重复帧
         （参考项目踩过的坑）：包数装得下就整段流式，装不下退 <video> 分块。定点只给本机素材。 */
      const localSrc = !/^\/(fetch|getv)\?/.test(sameSrc(src));
      if (!localSrc && !streamable) return { mode: 'fallback' };
      /* 本机 + 包数装得下 + 缺的帧不多：整段流式会把已缓存的几百帧重解一遍，改走定点补缺。 */
      const wantStream = streamable && (!localSrc || times.length * 4 >= (stats.packetCount || 1));
      /* 出图宽度与调用方同口径（opts.w）：高度按真实宽高比算，缩放交给 CanvasSink
         （fit:'fill'，宽高比取整误差 ≤ 1px，不变形也不留黑边）。 */
      const vw = (stats && stats.width) || 0, vh = (stats && stats.height) || 0;
      const tw = Math.max(16, Math.min(Number(o.w) || 160, vw || Number(o.w) || 160));
      const th = vw > 0 && vh > 0 ? Math.max(1, Math.round(tw * vh / vw)) : Math.round(tw * 9 / 16);
      const q = Math.min(1, Math.max(0.3, Number(o.q) || 0.6));
      const sink = new M.CanvasSink(vt, vw ? { width: tw, height: th, fit: 'fill' } : undefined);
      /* 一帧 → JPEG Blob（主线程）。canvas 已按目标宽度出，不再二次缩放。 */
      const encode = async canvas => {
        if (!canvas) return null;
        try {
          const blob = await new Promise(r => { try { canvas.toBlob(r, 'image/jpeg', q); } catch (e) { r(null); } });
          return blob && blob.size ? blob : null;
        } catch (e) { return null; }
      };
      const emitFrame = async (t, canvas) => {
        const blob = await encode(canvas);
        if (!blob) return false;
        made.push({ t, blob });
        if (o.onFrame) { try { o.onFrame({ t, blob }); } catch (e) { /* 上屏那遍自己出错，不打断解码 */ } }
        return true;
      };
      if (wantStream) {
        const it = sink.canvases(0, dur)[Symbol.asyncIterator]();
        let firstT = null;
        try {
          for (;;) {
            const r = await it.next();
            if (r.done) break;
            const cv = r.value;
            if (!cv) continue;
            const t = Number(cv.timestamp) || 0;
            if (has(t)) continue;
            if (firstT == null) firstT = t;
            await emitFrame(t, cv.canvas);
          }
        } finally {
          try { await it.return(); } catch (e) { /* 收尾失败不影响已拿到的帧 */ }
        }
        /* 首 GOP 合成黑帧：部分 WebM 在 t=0 附近几帧是黑的，第一格改取 0.26s、时间戳归一回原值
           （参考项目同款解法）。补拍要在**流式迭代器收完之后**做 —— 同一只 sink 上不并发两路解码。 */
        if (firstT != null && firstT <= 0.1 && dur > 0.3) {
          try {
            const fix = await canvasAt(sink, 0.26);
            if (fix) {
              const blob = await encode(fix);
              if (blob) {
                const i = made.findIndex(f => f.t === firstT);
                if (i >= 0) made[i] = { t: firstT, blob };
                if (o.onFrame) { try { o.onFrame({ t: firstT, blob, replace: true }); } catch (e) { /* 同上 */ } }
              }
            }
          } catch (e) { /* 定点补不了就留着流式那一帧 */ }
        }
        return { frames: made, dur, mode: 'stream' };
      }
      /* 定点档（只给本机素材）：种子先铺轮廓（≤24 张，整条先有画面），再按栅格补满 ——
         两段在**同一个 sink** 上先后跑，段间让出主线程（层间 idle），别把滚动与播放按住。
         canvasesAtTimestamps 对**每个请求时刻恰好回一帧**（取不到回 null）、顺序与请求一致，
         所以时刻按下标对应：首格 ≤0.05 时改请求 0.26s（黑帧陷阱），登记仍用原时刻。 */
      const spread = n => {
        const out = [];
        for (let i = 0; i < n; i++) out.push(Math.round(Math.min(dur - 0.02, (i + 0.5) / n * dur) * 1000) / 1000);
        return out.filter((x, i) => !i || x !== out[i - 1]);
      };
      /* 种子只给长趟（要解的时刻多于 24 个）铺轮廓：整条先有画面，再从左到右补满；
         小补趟（缩放多出来的十几个时刻）本来就近乎即时，不需要它。 */
      const seed = times.length > 24 ? spread(Math.min(24, Math.max(6, Math.round(cap / 20)))).filter(t => !has(t)) : [];
      const groups = [seed, times].map(g => g.filter((x, i, a) => !i || x !== a[i - 1]).sort((x, y) => x - y));
      for (const g of groups) {
        if (!g.length) continue;
        const shift = g[0] <= 0.05 && dur > 0.3;
        const req = shift ? [0.26].concat(g.slice(1)) : g;
        const it = sink.canvasesAtTimestamps(req)[Symbol.asyncIterator]();
        let i = -1;
        try {
          for (;;) {
            const r = await it.next();
            if (r.done) break;
            i++;
            const t = g[i];
            if (t == null || has(t)) continue;
            await emitFrame(t, r.value && r.value.canvas);
          }
        } finally {
          try { await it.return(); } catch (e) { /* 同上 */ }
        }
        await new Promise(r => setTimeout(r, 0));      // 层间让出
      }
      return { frames: made, dur, mode: 'fixed' };
      })();
      /* 主档必须有超时：与 grab() 同一个坑 —— 「算出来的时长比真实视频长一点」的文件，
         canvasesAtTimestamps 会一直等下一个包、永远不返回。切片主链挂死的代价比取一帧更大：
         slicePump 保证同一素材一次只有一趟活，这一趟不结束，之后所有切片 / 胶片格请求全部排队。
         超时即 dispose（斩断等在解码器上的那一发）并退 fallback，调用方 frames.js 再退 <video> 分块。 */
      let r;
      try {
        r = await Promise.race([
          work,
          new Promise((_, rej) => { to = setTimeout(() => { timedOut = true; disposeInput(); rej(new Error('主档切片超时')); }, 12000); }),
        ]);
      } catch (e) {
        clearTimeout(to);
        if (timedOut) { work.catch(() => {}); return { mode: 'fallback' }; }
        throw e;
      }
      clearTimeout(to);
      return r;
    } catch (e) {
      return { mode: 'fallback' };
    } finally {
      disposeInput();
    }
  }

  /* ---------------- 音轨 → 16k 单声道 WAV ----------------
     本地语音识别要 whisper-cli 直接认的 PCM。这一步在浏览器里做，代理只跑 whisper-cli：
     AudioBufferSink 流式拿解码后的音频块 → 降混 → 线性重采样 → 16-bit → WAV。
     ⚠ 只走 mediabunny：`<video>` 兜底取不出 PCM；解不开就说清「改用在线识别」，
       不要假装成功（喂给 whisper-cli 一段空音频只会得到一句「没有内容」）。 */
  function wavHead(rate, channels, bits, dataLen) {
    const b = new ArrayBuffer(44);
    const v = new DataView(b);
    const putAscii = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    putAscii(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); putAscii(8, 'WAVE');
    putAscii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, channels, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * bits / 8, true);
    v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
    putAscii(36, 'data'); v.setUint32(40, dataLen, true);
    return new Uint8Array(b);
  }

  async function wav16ByMb(src, opts) {
    const M = await loadM();
    if (!M) throw new Error('浏览器里的 mediabunny 没加载起来，抽不了音轨（可以改用在线识别）');
    const o = opts || {};
    const rate = 16000;
    const maxSec = Math.max(10, Number(o.maxSec) || 2 * 60 * 60);
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
    /* 取消要能真的停下解码：只在 asr.js 那边 race 一个 abort 不会让后台的
       AudioBufferSink 继续抽完整条音轨。每块之前查一次，abort 就跳出 for-await，
       finally 里照常 dispose。 */
    const signal = o.signal || null;
    const throwIfAborted = () => {
      if (!signal || !signal.aborted) return;
      const e = new Error('已取消');
      e.name = 'AbortError';
      throw e;
    };
    throwIfAborted();
    const input = new M.Input({ source: mbSourceOf(M, src), formats: M.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error('这一份素材里没有音轨，没法做语音识别');
      if (!(await track.canDecode())) throw new Error('浏览器解不开这一份的音轨（可以改用在线识别）');
      const dur = Number(await input.computeDuration()) || 0;
      const capSamples = Math.ceil(Math.min(maxSec, dur > 0 ? dur + 1 : maxSec) * rate);
      const parts = [];
      let chunk = new Int16Array(rate * 10);
      let ci = 0, outCount = 0;
      const flushChunk = () => {
        if (!ci) return;
        parts.push(new Uint8Array(chunk.buffer, 0, ci * 2).slice());
        ci = 0;
      };
      const pushSample = v => {
        if (outCount >= capSamples) return false;
        const s = Math.max(-1, Math.min(1, v));
        chunk[ci++] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
        if (ci >= chunk.length) flushChunk();
        outCount++;
        return true;
      };
      /* 连续时间轴上的线性重采样：nextPos 是「下一个输出样本落在源的第几个样本」，
         块与块之间靠 prev（上一块的最后一个样本）接上；时间戳有缺口就补静音，
         否则识别出来的时间点会整体往前挤。 */
      let nextPos = 0, base = 0, prev = 0, t0 = null;
      const sink = new M.AudioBufferSink(track);
      for await (const { buffer, timestamp } of sink.buffers()) {
        throwIfAborted();
        const len = buffer.length;
        if (!len) continue;
        if (t0 == null) t0 = Number(timestamp) || 0;
        const sr = buffer.sampleRate;
        const step = sr / rate;
        base = Math.round(((Number(timestamp) || 0) - t0) * sr);
        if (nextPos < base) {
          prev = 0;
          while (nextPos < base) { if (!pushSample(0)) break; nextPos += step; }
        }
        const chs = buffer.numberOfChannels;
        const mono = new Float32Array(len);
        for (let c = 0; c < chs; c++) {
          const d = buffer.getChannelData(c);
          for (let i = 0; i < len; i++) mono[i] += d[i] / chs;
        }
        while (nextPos < base + len - 1) {
          const rel = nextPos - base;
          const i0 = Math.floor(rel), f = rel - i0;
          const a = i0 < 0 ? prev : mono[i0];
          const b = i0 < 0 ? mono[0] : mono[i0 + 1];
          if (!pushSample(a * (1 - f) + b * f)) break;
          nextPos += step;
        }
        prev = mono[len - 1];
        if (onProgress && dur > 0) onProgress(Math.min(0.99, (timestamp + buffer.duration) / dur));
        if (outCount >= capSamples) break;
      }
      flushChunk();
      throwIfAborted();
      if (outCount < rate * 0.05) throw new Error('这一份里没有可识别的音轨（音频是空的）');
      const dataLen = parts.reduce((n, p) => n + p.byteLength, 0);
      const blob = new Blob([wavHead(rate, 1, 16, dataLen)].concat(parts), { type: 'audio/wav' });
      return { blob, seconds: outCount / rate, rate };
    } finally {
      try { input.disposeInput(); } catch (e) { /* 收尾清理，失败也要走完 */ }
    }
  }

  /* ---------------- 统一出口 ---------------- */

  const MediaBackend = {
    /* 动态加载后可用性（true = mediabunny 主档就绪） */
    async ready() { return !!(await loadM()); },

    /* 探能力：给设置页报「这个浏览器能不能走 WebCodecs 主路」，导出也按它选容器。
       opts.load 为真才真的拉 vendor（探针不必为了报一行状态下载 700KB）；
       avc / vp9 / aac 是 WebCodecs 自己的配置探针（null = 这个浏览器没有那套 API）。 */
    async probe(opts) {
      const hasWC = typeof window.VideoDecoder === 'function' && typeof window.VideoEncoder === 'function';
      const hasMb = opts && opts.load ? await this.ready() : !!mbPromise;
      const check = async (kind, cfg) => {
        try {
          const E = kind === 'video' ? window.VideoEncoder : window.AudioEncoder;
          if (!E || typeof E.isConfigSupported !== 'function') return null;
          const r = await E.isConfigSupported(cfg);
          return !!(r && r.supported);
        } catch (e) { return false; }
      };
      const [avc, vp9, aac] = await Promise.all([
        check('video', { codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 4e6, framerate: 30 }),
        check('video', { codec: 'vp09.00.10.08', width: 1280, height: 720, bitrate: 4e6, framerate: 30 }),
        check('audio', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }),
      ]);
      return { webcodecs: hasWC, mediabunny: hasMb, chain: hasMb ? 'mediabunny' : 'video',
        avc: avc, vp9: vp9, aac: aac, aacVendor: !!globalThis.MediabunnyAacEncoder };
    },

    /* 音轨 → 16k 单声道 WAV（本地 ASR 与浏览器内识别的共用输入）。 */
    async wav16(src, opts) { return wav16ByMb(src, opts); },

    /* 探媒体信息：mediabunny 主档 → <video> 兜底 */
    async info(src) {
      try {
        const r = await infoByMb(src);
        if (r && r.duration > 0) return r;
      } catch (e) { /* mediabunny 解不开 → 退兜底 */ }
      try { return await infoByVideo(src); }
      catch (e) { throw e; }
    },

    /* 取一帧 → { blob, w, h }（PNG）。主档 mediabunny → 兜底 <video>。
       which: 'first'|'start'|'last'|undefined；atSeconds 有值时截该时刻。
       主档必须有超时：mediabunny 遇到「算出来的时长比真实视频长一点」的文件时，
       canvasesAtTimestamps 会一直等下一个包、永远不返回（界面表现就是「一直在取尾帧，
       取不出来」）。超时即退 <video> 兜底 —— 那一条自带 20s / 15s 上限，整条链才有界。 */
    async grab(src, which, atSeconds) {
      let got = null, to = 0;
      try {
        got = await Promise.race([
          grabByMb(src, which, atSeconds),
          new Promise((_, rej) => { to = setTimeout(() => rej(new Error('主档取帧超时')), 12000); }),
        ]);
      } catch (e) { got = null; }
      finally { clearTimeout(to); }
      if (got) return got;
      return grabByVideo(src, which, atSeconds);
    },

    /* 批量取帧（切片预览主链）：一个 Input 一趟解完。见 framesByMb 的注释。
       mode='fallback' = mediabunny 解不动，调用方退 <video> 分块。 */
    frames(src, opts) { return framesByMb(src, opts); },

    /* 取一帧并缩到最长边 maxSide 的 JPEG dataURL（首帧槽位 / 尾帧接龙用） */
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

    /* 顺序逐格定位（MediaExport 的兜底链）：times = 源秒数组 */
    async seekIter(src, times) { return seekIterByVideo(src, Array.isArray(times) ? times : []); },

    /* 缩略图尺寸的取帧（Wb.thumbs._extract 用）：512px JPEG dataURL */
    async frame(src, opts) {
      const o = opts || {};
      const at = o.at != null ? o.at : 0.1;
      try {
        const r = await this.grab(src, null, at);
        const img = await this._decode(r.blob);
        const maxSide = o.w || 512;
        const scale = Math.min(1, maxSide / Math.max(r.w, r.h));
        const cw = Math.max(1, Math.round(r.w * scale)), ch = Math.max(1, Math.round(r.h * scale));
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        return c.toDataURL('image/jpeg', o.quality || 0.82);
      } catch (e) { return ''; }
    },

    _decode(blob) {
      if (window.createImageBitmap) return createImageBitmap(blob);
      return new Promise((res, rej) => {
        const u = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(u); res(im); };
        im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('帧解码失败')); };
        im.src = u;
      });
    },

    /* 兜底实现的内部件（Wb.vframe 转发壳要用 el/meta/seek/release 这几件） */
    _video: { el: videoEl, release: releaseVideo, meta: videoMeta, seek: videoSeek, sameSrc },
  };

  window.MediaBackend = MediaBackend;
})();
