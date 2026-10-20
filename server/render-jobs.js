/* ---------- ffmpeg 离线渲染服务 ----------
   POST /render          提交 EDL（clips: src/in/out/speed/volume）→ 返回 { id }
   GET  /render/status   查询进度 { state, progress, stage, out, err, log }
   GET  /render/dl       取回成片 ?name=xxx（带 Range：拖进度条与 moov 在尾部的 mp4 都要）
   POST /render/cancel   取消渲染（杀 ffmpeg 子进程 + 从队列摘掉）?id=xxx
   流程：**一次 ffmpeg 的单遍 filter_complex**（逐段输入级 -ss/-t 裁剪 → scale/pad/fps/setpts → concat
         → 配音各自 adelay 后一次 amix）；不逐段编码成 norm_N.mp4 再 concat（见 AGENTS.md §8）
   src 支持：/asset/<id>（用密钥解析最新签名链接）｜ http(s):// ｜ /local-path（经本机 http 取回）
   「/render/play」（内联播放那一条）2026-10-15 删除：页头「播放成片」那颗按钮早就整颗摘掉，
   剪辑态预览走时间线实时播、绝不为播放渲染，所以这一条路由全站零调用，是那条路留下的最后一段。
   2026-10-20 从 server/app.js 原样搬出（审查报告 §6.1-1）：任务表、队列、素材解析与 ffmpeg 子进程
   都住在这一层。RENDER_* / ENCODE_PROFILES 这些「启动时定一次」的配置与 HTTP 分发仍在组合根，
   由 app 注入进来（ROOT / PORT / RENDER_DIR / assetStore / 会话令牌 / log / keyOf / envInt …）。 */
'use strict';
const fs = require('fs');
const path = require('path');

function createRenderJobs(deps) {
  const {
    ROOT, PORT, RENDER_DIR, assetStore, SESSION_COOKIE, SESSION_TOKEN, log, keyOf, safeDecode, envInt,
    spawn, ENCODE_PROFILES, VCODEC_DEFAULT, RENDER_VCODEC, RENDER_PRESET, RENDER_KEEP,
    RENDER_CONCURRENCY, RENDER_QUEUE_MAX, envFrom, envFromStr, guardOutboundUrl, upRequest, renderJobs,
    localAssetFile, whyRenderSpace,
  } = deps;

  const renders = new Map();          // id → job
  let renderRunning = 0;
  const renderQueue = [];

  try { fs.mkdirSync(RENDER_DIR, { recursive: true }); } catch {}

  function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  const fmtTime = s => { const m = Math.floor(s / 60), sec = (s % 60).toFixed(1); return m + ':' + String(sec).padStart(4, '0'); };

  /* 正在运行的子进程（按 job.id 记）：取消 / 退出时要能真的杀掉，否则 ffmpeg 会变成孤儿进程继续吃 CPU */
  const liveProcs = new Map();     // jobId → Set<ChildProcess>
  function killJobProcs(jobId) {
    const set = liveProcs.get(jobId);
    if (!set) return 0;
    let n = 0;
    set.forEach(p => { try { p.kill('SIGKILL'); n++; } catch {} });
    set.clear();
    return n;
  }
  function allProcs() { const out = []; liveProcs.forEach(set => set.forEach(p => out.push(p))); return out; }

  /* 子进程按「任务号」登记（jobId 由调用方显式传入）：
     取消 / 退出时要能真的杀掉，否则 ffmpeg 会变成孤儿进程继续吃 CPU。
     以前靠一个全局 currentJobId 推断任务号 —— RENDER_CONCURRENCY=1 时看不出问题，
     一旦放开并发（>1），两个任务的子进程会挂到同一个 jobId 上，取消一个会把另一个也杀掉。 */
  function trackProc(jobId, p) {
    if (!jobId) return;
    if (!liveProcs.has(jobId)) liveProcs.set(jobId, new Set());
    liveProcs.get(jobId).add(p);
  }
  function untrackProc(jobId, p) {
    const set = jobId && liveProcs.get(jobId);
    if (set) { set.delete(p); if (!set.size) liveProcs.delete(jobId); }
  }
  /* 一单 ffmpeg 最多跑多久：坏输入（无限长播放列表、循环滤镜、卡在某个网络源）会把这一单永远挂住，
     而渲染只有 RENDER_CONCURRENCY 个位子 —— 挂住一个整条队列就停摆，界面上是「合成中 45%」一动不动，
     用户只能取消或重启代理。按时长算上限：max(保底, 系数 × 这一单的成片秒数)。
     系数默认 8：本机实测正常导出通常 1~3 倍实时，留 8 倍是给慢机器与重滤镜的余量；
     再慢的机器也不该让一单占着位子半小时以上 —— 到点杀掉并说清是「超时」，不是「ffmpeg 失败」。 */
  const FFMPEG_MIN_MS = envInt('FFMPEG_MIN_MS', 180000, 10000, 3600000);   // 保底 3 分钟（与片长无关的那点固定开销）
  const FFMPEG_SPEED = envInt('FFMPEG_SPEED', 8, 2, 60);                   // 最多允许「8 × 片长」的真实时间
  const FFMPEG_MAX_MS = envInt('FFMPEG_MAX_MS', 3600000, 60000, 7200000);  // 硬上限 1 小时：再久就是配错了
  function ffmpegBudgetMs(durSec) {
    const d = Number(durSec) || 0;
    const want = d > 0 ? d * 1000 * FFMPEG_SPEED : FFMPEG_MIN_MS;
    return Math.max(FFMPEG_MIN_MS, Math.min(FFMPEG_MAX_MS, Math.round(want)));
  }
  /* opts.maxMs = 0 / 不给 → 不设时限（由调用方自己的看门狗负责，例如 media.js 那条 120 秒）；
     给了就按时到点杀掉这一族的子进程，并把失败说成「超时」而不是「退出码 1」。 */
  function runFfmpeg(args, onLine, jobId, opts) {
    const maxMs = (opts && Number(opts.maxMs)) || 0;
    return new Promise((resolve, reject) => {
      /* 固定 cwd = 代理所在目录：双击启动器时 process.cwd() 可能是 System32，
         子进程不该跟着人家的目录走（所有输入输出本来都是绝对路径，这里要的只是确定性）。
         以前这一句的理由是「字幕滤镜用的相对路径」，那条死路已删。 */
      const p = spawn('ffmpeg', args, { windowsHide: true, cwd: ROOT });
      trackProc(jobId, p);
      let err = '';
      let timedOut = false, settled = false, killer = null;
      /* 唯一的结单出口：名额（这里是一个渲染位子 + 一条子进程登记）只能被释放一次。
         以前每条出口各写一遍 untrack/clearTimeout，漏一处就是「取消不掉」或「同一单结两次」。 */
      const finish = fn => {
        if (settled) return;
        settled = true;
        if (killer) { clearTimeout(killer); killer = null; }
        untrackProc(jobId, p);
        fn();
      };
      const timeoutErr = () => new Error('ffmpeg 超时（这一单最多允许 ' + Math.round(maxMs / 1000)
        + ' 秒），已终止：输入里可能有循环 / 无限长的源，或这台机器实在跑不完。'
        + '上限由 .env 的 FFMPEG_MIN_MS / FFMPEG_SPEED / FFMPEG_MAX_MS 决定，改完要重启');
      if (maxMs) {
        killer = setTimeout(() => {
          timedOut = true;
          log(`[ffmpeg] 跑满 ${Math.round(maxMs / 1000)} 秒还没完，杀掉这一单（上限见 .env 的 FFMPEG_MIN_MS / FFMPEG_SPEED / FFMPEG_MAX_MS）`);
          try { p.kill('SIGKILL'); } catch {}
          /* 杀不动（Windows 上偶发，子进程卡在 IO 上）也要把这一单结掉，不许永远挂着渲染位子 */
          setTimeout(() => finish(() => reject(timeoutErr())), 5000).unref();
        }, maxMs);
        killer.unref();
      }
      p.stderr.on('data', d => {
        const s = d.toString();
        err += s;
        /* ffmpeg 的进度行（`frame=… time=…`）行尾在不同构建里不一样：类 Unix 用一个 `\r` 覆盖同一行，
           Windows 的构建常见 `\r\n`。以前只按 `\n` 切再取**最后一条**，于是一个 chunk 里挤了三条进度时
           交出去的是「三条粘成一条」的那一串，回调的正则取到的是**最旧**那一个 `time=` ——
           进度条原地不动，甚至倒退。现在 `\r` 与 `\n` 都算分隔符，这一 chunk 里所有非空行都交出去，
           由回调自己挑最新的（`time=` 的解析只在渲染那一处用，另一个调用点不传回调）。 */
        if (onLine) s.split(/[\r\n]+/).filter(Boolean).forEach(onLine);
        if (err.length > 20000) err = err.slice(-20000);
      });
      p.on('error', e => finish(() => reject(new Error('无法启动 ffmpeg：' + e.message + '（请确认已安装并加入 PATH）'))));
      p.on('close', code => finish(() => {
        /* 被超时杀掉之后 ffmpeg 多半回一个非 0 码：那句「退出码 1」会把真正的原因（跑不完）盖掉 */
        if (timedOut) reject(timeoutErr());
        else if (code === 0) resolve(err);
        else reject(new Error('ffmpeg 失败（退出码 ' + code + '）：' + err.split(/[\r\n]+/).filter(Boolean).slice(-3).join(' | ')));
      }));
    });
  }
  /* ffprobe 也要能杀：给个 15 秒上限，坏文件不会把渲染卡死 */
  function capture(cmd, args, jobId) {
    return new Promise(resolve => {
      const p = spawn(cmd, args, { windowsHide: true });
      trackProc(jobId, p);
      let out = '';
      const done = v => { untrackProc(jobId, p); resolve(v); };
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} done(''); }, 15000);
      p.stdout.on('data', d => out += d.toString());
      p.on('close', () => { clearTimeout(timer); done(out); });
      p.on('error', () => { clearTimeout(timer); done(''); });
    });
  }
  function probe(args, jobId) { return capture('ffprobe', args, jobId); }
  /* 这台 ffmpeg 到底编进了哪些编码器 —— 只有问它自己才知道。
     `.env` 里写 h264_qsv 而装的是官方 Windows 版（不带 QSV）是很常见的一次配错，
     表现是「导出失败：Unknown encoder」一句，看不出是自己配的还是机器没有。
     结果缓存在进程里（`ffmpeg -encoders` 一次几百毫秒，且这份清单进程活着就不会变），
     Promise 而不是值：并发渲染时两条任务问一次（以前 ffprobe 那一族踩过「两条同时探、各起一个子进程」）。
     问不出来（ffmpeg 不在 PATH / 超时）返回 null，**当「不知道」而不是「没有」**：
     照用户配的走，让 ffmpeg 自己报错 —— 拿「问不到清单」去退回 libx264 等于凭空换了用户的配置。 */
  let encodersPromise = null;
  /* 已经问到的那份清单（null = 还没问过，或问不出来）。`/sys-status` 是同步的，
     不能为了报「本机有没有 H.265」在那里 await 一趟 ffmpeg —— 它只读这一份现成的结果。 */
  let encodersKnown = null;
  function listEncoders(jobId) {
    if (!encodersPromise) encodersPromise = (async () => {
      const out = await capture('ffmpeg', ['-hide_banner', '-encoders'], jobId);
      const names = new Set();
      String(out || '').split(/\r?\n/).forEach(line => {
        const parts = line.trim().split(/\s+/);
        /* 形状：6 个标志位（第一位 V/A/S = 这一条是哪一类，后面五位是 `.FSXBD` 那几种能力）→ 编码器名 → 说明。
           表头与分隔线（` V..... = Video`、` ..S... = Slice-level…`、` ------`）都在这一步被挡掉：
           前缀那一列的名字位是 `=`，而 `=` 不以字母开头。 */
        if (!/^[VAS][.FSXBD]{5}$/.test(parts[0] || '')) return;
        if (!/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(parts[1] || '')) return;
        names.add(parts[1]);
      });
      encodersKnown = names.size >= 3 ? names : null;   // 只扫出两三行 = 不像是这份输出的形状，当问不出来
      return encodersKnown;
    })().catch(() => { encodersPromise = null; encodersKnown = null; return null; });
    return encodersPromise;
  }
  /* 这一单真用哪个编码器/档位（配置值 + 这台机器真有的），以及要不要把「退回」写给用户看。
     codec 名字在表里但 ffmpeg 没编进去 → 退回 libx264 并给出原因；档位跟着退回那一家的默认档
     （很关键：配 nvenc + p5 而机器没有 nvenc 时，把 p5 喂给 libx264 又是一次当场拒）。 */
  async function pickEncode(jobId) {
    const prof = ENCODE_PROFILES[RENDER_VCODEC];
    const want = { codec: RENDER_VCODEC, preset: RENDER_PRESET, zh: prof.zh, why: '' };
    if (RENDER_VCODEC === VCODEC_DEFAULT) return want;      // 默认那一档必然在（libx264 是兜底，退它等于不退）
    const have = await listEncoders(jobId);
    if (have === null || have.has(RENDER_VCODEC)) return want;
    const fb = ENCODE_PROFILES[VCODEC_DEFAULT];
    const preset = fb.presets.indexOf(RENDER_PRESET) >= 0 ? RENDER_PRESET : fb.dPreset;
    return { codec: VCODEC_DEFAULT, preset, zh: fb.zh,
      why: `这台机器的 ffmpeg 没有 ${RENDER_VCODEC}（.env 里配的），已用 ${VCODEC_DEFAULT} 出片`
        + (preset !== RENDER_PRESET ? `，档位也从 ${RENDER_PRESET} 换成 ${preset}` : '') + '。想要它就换一个编进了它的 ffmpeg 构建。' };
  }
  function encodeVideoArgs(codec, preset, crf) {
    return ['-c:v', codec, '-preset', String(preset), ...ENCODE_PROFILES[codec].quality(crf), '-pix_fmt', 'yuv420p'];
  }

  /* 一个文件只问 ffprobe 一次：以前「有几秒」与「有没有原声」是两条命令、两个子进程，
     同一个刚落地的文件问两遍 —— 三十段就是六十次子进程等待（每段都在下载完之后干等两回）。
     `nw=1:nk=1` 打出来的是裸值：每个流一行 codec_type，最后一行是 format=duration（实测流排在前面）。
     解析不看顺序，只分两类：纯数字那一行当秒数，等于 audio 的那一行当「有原声」。
     认不出数字就当 0（与从前 `parseFloat(...) || 0` 一模一样），认不出 audio 就当没有声。 */
  async function probeFile(file, jobId) {
    const out = await probe(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'default=nw=1:nk=1', file], jobId);
    let duration = 0, hasAudio = false;
    for (const line of String(out || '').split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      if (/^[\d.]+$/.test(s)) { if (!duration) duration = parseFloat(s) || 0; continue; }
      if (s === 'audio') hasAudio = true;
    }
    return { duration, hasAudio };
  }
  const mediaState = { preparing: 0 };
  /* 缓存回收（列表 / 详情 / 资产签名地址都用它）：过期即删；仍超上限时按「最早写入」淘汰
     （Map 保持插入顺序）。以前是「超了就整个 clear()」，一次大批量请求会把还有用的缓存全清掉。 */
  /* 缓存淘汰：先按 TTL 过期，再按条数封顶；给了 maxBytes 时**再按字节**封顶（P5）。
     以前只按条数封顶，而 listCache 每条最大 8 MiB、detailCache 每条最大 2 MiB ——
     算术上限 60×8 + 300×2 = **1.08 GB 常驻 Buffer**，还在 V8 堆外，`--max-old-space-size` 拦不住。
     今天 listCache 约 9.6 MB，不是问题，是**没有闸**。 */
  function cacheSweep(cache, max, maxBytes) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (!v || !v.ttl || now - v.ts > v.ttl) cache.delete(k);
    }
    while (cache.size > max) cache.delete(cache.keys().next().value);
    if (!maxBytes) return;
    let bytes = 0;
    for (const v of cache.values()) bytes += (v && v.body ? v.body.length : 0);
    while (bytes > maxBytes && cache.size > 1) {
      const k = cache.keys().next().value;
      const v = cache.get(k);
      bytes -= (v && v.body ? v.body.length : 0);
      cache.delete(k);
    }
  }
  /* 资产下载地址缓存（/asset/<id> 与渲染/下载都走它）
     以前每取一张图都要先问一次上游「这个资产的最新签名地址」（实测 1~3.6s），而签名地址本身有 ~30 分钟有效期；
     同一个 id 在 TTL 内直接复用解析结果，取图/出图明显变快。
     缓存键带上密钥尾号：换密钥（换账号）后同一个 id 解析出的签名地址不一样，不能复用旧的。 */
  const assetUrlCache = new Map();          // id|密钥尾号 → { ts, ttl, url, mime }
  const ASSET_URL_TTL = 5 * 60 * 1000;
  const keyTagOf = k => (k ? String(k).slice(-8) : 'anon');
  /* 按点号路径取值：urlFields / mimeField 由注册表声明（如 'asset.download_url'），
     换一家平台只改声明，这里不认字段名。 */
  function pickPath(obj, dotted) {
    if (!obj || !dotted) return '';
    let cur = obj;
    for (const k of String(dotted).split('.')) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = cur[k];
    }
    return cur == null ? '' : cur;
  }
  function assetInfoOf(id, key) {
    if (!assetStore) {
      /* 注册表没声明 assetStore → 这家没有「用资产号换下载地址」的接口。
         照实说不提供，不要猜一个地址去试：猜错的后果是密钥被发到不属于它的主机。 */
      const e = new Error('当前注册表没有声明 assetStore，代理不知道去哪一家换资产下载地址');
      e.status = 501;
      return Promise.reject(e);
    }
    const ck = id + '|' + keyTagOf(key);
    const hit = assetUrlCache.get(ck);
    if (hit && Date.now() - hit.ts < (hit.ttl || ASSET_URL_TTL)) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const url = assetStore.base + String(assetStore.retrieve).replace('{id}', encodeURIComponent(id));
      const up = upRequest(url, { headers: { authorization: 'Bearer ' + key } }, ur => {
        let b = '';
        ur.on('data', c => b += c);
        ur.on('end', () => {
          let d = null;
          try { d = JSON.parse(b); } catch {}
          let urlOut = '';
          for (const f of assetStore.urlFields) {
            urlOut = pickPath(d, f);
            if (typeof urlOut === 'string' && urlOut) break;
          }
          if (!urlOut) {
            /* 把上游状态码带在错误上：/asset 据此回同样的码。
               以前一律 404，密钥失效（401）、上游 5xx 都被显示成「资产不存在」，
               页面据此把正常资产标成已删除，也看不出是该去设置页更新密钥。 */
            let msg = '资产 ' + id + ' 没有可用下载链接';
            if (ur.statusCode === 404) msg = '资产 ' + id + ' 不存在（上游 404）';
            else if (ur.statusCode === 401 || ur.statusCode === 403) msg = '读资产信息被拒 HTTP ' + ur.statusCode + '（密钥不被接受，检查设置里的 API Key）';
            else if (ur.statusCode >= 400) msg = '读资产信息失败 HTTP ' + ur.statusCode;
            const e = new Error(msg);
            e.status = ur.statusCode >= 400 ? ur.statusCode : 502;
            reject(e);
            return;
          }
          cacheSweep(assetUrlCache, 500);
          const info = { ts: Date.now(), ttl: ASSET_URL_TTL, url: urlOut, mime: pickPath(d, assetStore.mimeField) || '' };
          assetUrlCache.set(ck, info);
          resolve(info);
        });
      });
      up.on('error', reject);
      up.end();
    });
  }
  /* 把 src 解析成可下载的 https URL（/asset/<id> 会用密钥换成最新签名链接） */
  async function resolveSrc(src, reqKey) {
    const s = String(src || '');
    if (/^https?:\/\//i.test(s)) {
      /* 渲染素材同样只认公网 https，且要过**完整**护栏（含 DNS 解析判定）：
         这条路由虽然同源专属，但素材地址可能来自导入的工程文件 ——
         *.nip.io / *.sslip.io 这类「字面量看着是公网域名、实际解析到内网」的地址要挡在这一步。 */
      try { return await guardOutboundUrl(s); }
      catch (e) { throw new Error('渲染素材地址不允许：' + e.message + '（' + s.slice(0, 100) + '）'); }
    }
    const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(s);
    if (m) {
      /* **本机生成的资产**（逐句配音、预演音轨这些 /local-assets 存下来的 la_xxx）没有上游记录，
         不能一律去上游换签名链接 —— 上游当然查不到这个 id，渲染会直接失败。
         先查本地表，命中就走本机 /asset 通道（那个路由本来就先发本地文件）。
         正则也必须收下划线：本地 id 是 la_ 前缀，只认 [A-Za-z0-9-] 会把 'la_xxx' 截成 'la'。 */
      if (localAssetFile(m[1])) return `http://127.0.0.1:${PORT}/asset/${m[1]}`;
      const key = reqKey || (assetStore ? keyOf(assetStore.keyEnv) : '');
      const info = await assetInfoOf(m[1], key);
      return info.url;
    }
    // 相对路径：只允许「本机资产（上面已处理）」「/getv|/fetch 包着的公网地址」和同源静态文件。
    /* 以前任何相对路径都直接拼成 http://127.0.0.1:<PORT><path> 让代理自己去取，而代理发出的请求
       不带 Origin / Sec-Fetch-Site，sameOriginOnly 把这种「非浏览器调用」当本机工具放行 ——
       于是 /render 的 clips[].src 写成 /data/fav_items、/env-status、/prompts/find 就能把用户数据与
       密钥状态读进渲染任务里（工程文件是导入的，一句就够）。 */
    const gv = /^(?:\/getv|\/fetch)\?url=([^&]+)/i.exec(s);
    if (gv) {
      const inner = safeDecode(gv[1]);
      if (/^https?:\/\//i.test(inner)) {
        try { return await guardOutboundUrl(inner); }
        catch (e) { throw new Error('渲染素材地址不允许：' + e.message + '（' + inner.slice(0, 100) + '）'); }
      }
      throw new Error('渲染素材地址不允许：/getv 里必须包公网 https 地址（' + s.slice(0, 100) + '）');
    }
    if (/^\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')
      && /\.(html|js|css|png|jpe?g|webp|gif|svg|ico|mp4|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(s)
      && !/^\/(proxy\.(js|log|out\.log)|package(-lock)?\.json|启动\.bat)$/i.test(s)) {
      return `http://127.0.0.1:${PORT}${s}`;
    }
    throw new Error('渲染素材路径只能是 /asset/<id>、/getv?url=<公网地址> 或本机静态文件：' + s.slice(0, 100));
  }
  /* 单片渲染素材的下载上限（默认 2 GiB）：作用不是「限制正常素材」，而是防止超大 / 恶意地址把进程打爆 */
  const DOWNLOAD_MAX = 2 * 1024 * 1024 * 1024;
  /* 代理取自己那些 LOCAL_ONLY 路由（目前只有 `/asset/<id>` 的本机副本）时要带上会话 Cookie。
     这条路的调用方是服务端 fetch，不经过浏览器 —— 没有 Cookie 就被 401 挡住，而表现是
     「本机导入的视频能预览、一导出就报素材下载失败 HTTP 401」。只对本机自己的端口加，
     公网地址一个字节的 Cookie 都不带。 */
  function internalFetchHeaders(url) {
    try {
      const u = new URL(url);
      const own = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || 80) === PORT;
      return own ? { Cookie: SESSION_COOKIE + '=' + SESSION_TOKEN } : undefined;
    } catch (e) { return undefined; }
  }
  /* 流式下载到文件：以前整段 arrayBuffer() 进内存，一个超大素材就能把代理进程吃掉几百 MB 到几 GB */
  async function downloadTo(url, dest, hops) {
    /* 每一跳都重新过护栏：这一条以前用 fetch 的默认 redirect:'follow'，
       于是一个公网地址只要 302 到 http://127.0.0.1:5175/data/... 就绕过了 resolveSrc 的检查
       （代理自己的请求不带 Origin，同源拦截把本机调用当工具放行）。 */
    const depth = hops || 0;
    if (depth > 4) throw new Error('素材下载重定向次数过多（已中止）');
    let r;
    try {
      r = await fetch(url, { redirect: 'manual', headers: internalFetchHeaders(url) });
    } catch (e) {
      throw new Error('素材下载失败：' + (e && e.message ? e.message : '无法连接'));
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('素材下载失败：重定向没有给出地址');
      let next = '';
      try { next = new URL(loc, url).toString(); } catch { throw new Error('素材下载失败：重定向地址非法'); }
      if (/^https?:\/\//i.test(next)) {
        try { next = await guardOutboundUrl(next); }
        catch (e) { throw new Error('素材重定向目标不允许：' + e.message); }
      }
      return downloadTo(next, dest, depth + 1);
    }
    if (!r.ok) throw new Error('素材下载失败 HTTP ' + r.status);
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > DOWNLOAD_MAX) throw new Error('素材超过 ' + Math.round(DOWNLOAD_MAX / 1073741824) + ' GiB，已拒绝下载');
    if (!r.body) throw new Error('素材下载失败（上游没有返回内容）');
    const { Readable } = require('stream');
    const src = Readable.fromWeb(r.body);
    let size = 0;
    await new Promise((resolve, reject) => {
      let done = false;
      const out = fs.createWriteStream(dest);
      const finish = err => {
        if (done) return;
        done = true;
        try { out.destroy(); } catch {}
        try { src.destroy(); } catch {}
        err ? reject(err) : resolve();
      };
      src.on('data', c => {
        size += c.length;
        if (size > DOWNLOAD_MAX) finish(new Error('素材超过 ' + Math.round(DOWNLOAD_MAX / 1073741824) + ' GiB，已中止下载'));
      });
      src.on('error', e => finish(new Error('素材下载中断：' + e.message)));
      out.on('error', e => finish(new Error('素材写入失败：' + e.message)));
      out.on('finish', () => finish(null));
      src.pipe(out);
    });
    if (!size) throw new Error('素材为空');
    return size;
  }

  /* ============================================================================
     配音合成（/render 的 clip.voices）
     ---------------------------------------------------------------------------
     每一句的 `start` 是**相对该段自己的起点**的秒数，绝对偏移由代理按每一段在成片里的
     真实时长（`span / speed`）累加得出 —— 客户端自己累加会和实际差出零点几秒，整句就跟着漂。

     「字幕烧录」那一族（`clips[].subs` + ASS 生成 + 字体白名单）2026-10-15 整族删除：
     它是已删的拍短剧页留下的死路，现在没有任何页面发 `subs`，代理里那一段永远走不到。
     ========================================================================== */
  const VOICE_MAX = 40;                       // 单段配音条数上限（同一段台词条数；防超大请求）
  const clampVol = (v, def) => Math.min(4, Math.max(0, v == null || Number.isNaN(Number(v)) ? (def == null ? 1 : def) : Number(v)));
  /* 把任意倍速拆成 ffmpeg 允许的 `atempo` 串（单级只吃 0.5–2，超出就拆成多级相乘：4× = 2,2）。
     以前这里是 `Math.min(2, Math.max(0.5, speed))` —— 4 倍速那一格被压成 2 倍，画面对音轨快了一倍，
     而客户端的预览用的是 `playbackRate`（浏览器支持到 16）：屏幕上听着对、成片里拖沓，正是本项目拦的那一类。
     一句配音现在还能带自己那一档（乘在这一格的倍速之上，最远 4×4=16），所以这一处必须能拆。 */
  function tempoChain(rate) {
    let r = Number(rate) || 1;
    if (!isFinite(r) || Math.abs(r - 1) < 0.001) return '';
    const parts = [];
    while (r > 2.001) { parts.push('atempo=2'); r /= 2; }
    while (r < 0.499) { parts.push('atempo=0.5'); r *= 2; }
    if (Math.abs(r - 1) >= 0.001) parts.push('atempo=' + r.toFixed(4));
    return parts.length ? ',' + parts.join(',') : '';
  }

  /* 并发跑一批异步任务，**按原顺序**返回结果。
     `mapLimit` 只有这一份：下载素材、探测时长都要它 —— 一处写 Promise.all（完全不限流）、
     一处写串行 for，同一个「并发上限」就有两个口径，调参的人改一处漏一处。 */
  const DL_CONCURRENCY = 4;               // 同时下载几个片段的素材（见 renderJob 阶段一）
  async function mapLimit(list, n, fn) {
    const out = new Array(list.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => {
      while (cursor < list.length) {
        const i = cursor++;
        out[i] = await fn(list[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }
  async function renderJob(job) {
    const dir = path.join(RENDER_DIR, job.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { job.state = 'failed'; job.err = '无法创建渲染目录：' + e.message; try { renderJobs.record(job); } catch {} return; }
    const noSpace = whyRenderSpace();
    if (noSpace) { job.state = 'failed'; job.err = noSpace; job.log.push(noSpace); try { renderJobs.record(job); } catch {} return; }
    const jid = job.id;                    // 本任务的子进程都挂到这个号上（取消时按号杀，见 killJobProcs）
    const { clips, width, height, fps, crf, bgm, audioOnly, subtitles } = job.spec;
    /* audioOnly = 只出音频（导演台「导出素材」里每句配音一个文件的那一路）。
       不新开一条导出通道 —— 复用同一套下载/解码/amix，只是最后 `-vn` 掉画面、容器换 m4a。
       为什么需要它：逐句配音提交成「一条黑场 + 一句 voices」的话，出来的是一个**有画面的 mp4**
       （黑屏 + 声音），用户要的是音频文件。 */
    const wantAudio = !!audioOnly;
    // 渲染途中被取消：每一步之间检查一次，及时退出（而不是跑完整个片子）
    const abortIfCancelled = () => {
      if (job.state === 'cancelled') throw new Error('已取消');
    };
    try {
      /* ---------- 阶段一：素材与配音**并发**下载，顺手把时长 / 有无音轨量出来 ----------
         以前是一个串行 `for`：每段「下载完 → 干等本机 ffprobe 探一次」再轮到下一段，
         三十段就是三十次完整的网络往返加三十次子进程等待。下载是网络等待、ffprobe 是本机子进程，
         两者都能并发，所以这里按 `mapLimit` 一起跑 —— 上限 4：一次开三十个下载会把带宽和磁盘
         都占满，整体反而更慢，而且远端限流会把后面的几条一起打回。 */
      job.stage = '下载素材'; job.progress = 2;
      let dlDone = 0;
      const files = await mapLimit(clips.map((c, i) => ({ c, i })), DL_CONCURRENCY, async ({ c, i }) => {
        abortIfCancelled();
        /* 逐句配音先取回来（黑场段也可能有旁白，所以放在 black 判断之前）。
           每条 = { src, start, dur, vol }，start 相对**该段起点**（绝对偏移由这一段的 span 决定，
           客户端自己加会漂）。 */
        const voices = Array.isArray(c.voices) ? c.voices.slice(0, VOICE_MAX) : [];
        const vFiles = [];
        for (let k = 0; k < voices.length; k++) {
          abortIfCancelled();
          const v = voices[k];
          const vurl = await resolveSrc(v.src, job.key);
          const vext = (/\.([a-z0-9]{3,4})(\?|$)/i.exec(vurl) || [])[1] || 'mp3';
          const vdest = path.join(dir, `voice_${i}_${k}.${vext}`);
          await downloadTo(vurl, vdest);
          /* `off` = 这一句在音频文件内的起点（客户端拖左边缘切掉开头时写的，默认 0）。
             它和 start 不是一回事：start 是「在画面第几秒开始响」。
             `spd` = 这一句**自己**的倍速（默认 1），乘在这一格的 `speed` 之上 —— 与客户端 `clipVoices`
             那一处同一份读法；这里漏掉它，成片就是原速而预览与回执都说是倍速（半截承诺）。 */
          vFiles.push({ file: vdest, start: Math.max(0, Number(v.start) || 0), dur: Math.max(0.1, Number(v.dur) || 0),
            vol: clampVol(v.vol, 1), off: Math.max(0, Number(v.off) || 0),
            spd: Math.max(0.25, Math.min(4, Number(v.spd) || 1)) });
        }
        if (vFiles.length) job.log.push(`[${i + 1}/${clips.length}] 配音 ${vFiles.length} 句`);
        const speed = Math.min(4, Math.max(0.25, Number(c.speed) || 1));
        const volume = clampVol(c.volume, 1);
        if (String(c.src) === 'black') {   // 黑场：不下载，用 lavfi 生成
          const span = Math.max(0.1, (Number(c.out) || 1) - Math.max(0, Number(c.in) || 0));
          job.log.push(`[${i + 1}/${clips.length}] 黑场 ${span.toFixed(1)}s`);
          dlDone++; job.progress = 2 + Math.round((dlDone / clips.length) * 33);
          return { i, black: true, file: null, inP: 0, span, speed, volume, voices: vFiles, native: false };
        }
        const url = await resolveSrc(c.src, job.key);
        const ext = (/\.([a-z0-9]{3,4})(\?|$)/i.exec(url) || [])[1] || 'mp4';
        const dest = path.join(dir, `src_${i}.${ext}`);
        const size = await downloadTo(url, dest);
        /* 这一段在成片里占多长：用 ffprobe 出来的真实时长把 out 夹紧
           （平台给的 duration 常常比实际文件长，不夹会在片尾多出一段黑）。 */
        const inP = Math.max(0, Number(c.in) || 0);
        const meta = await probeFile(dest, jid);
        const dur = meta.duration;
        let outP = c.out != null && Number(c.out) > inP ? Number(c.out) : dur;
        if (dur && outP > dur + 0.05) outP = dur;
        const span = Math.max(0.1, outP - inP);
        const native = meta.hasAudio;
        dlDone++; job.progress = 2 + Math.round((dlDone / clips.length) * 33);
        job.log.push(`[${i + 1}/${clips.length}] 已下载 ${(size / 1048576).toFixed(2)} MB`);
        return { i, black: false, file: dest, inP, span, speed, volume, voices: vFiles, native };
      });
      if (!files.length) throw new Error('没有可渲染的片段');
      // 成片名带上任务号后缀：同名任务并发时不再互相覆盖
      const outName = (job.name || '成片') + '-' + job.id.slice(-4) + (wantAudio ? '.m4a' : '.mp4');
      const outPath = path.join(RENDER_DIR, outName);

      /* 音频策略分两种：
         · 没有逐句配音 → 沿用老规矩「所有片段都有音轨才保留，否则整片静音」（避免混流失败）
         · 有逐句配音   → 有原声 / 有配音的那几段各自成一路，最后统一 amix，
           否则「一段有声、一段无声」会让整片静音，配音跟着整段消失。 */
      const hasVoice = files.some(f => (f.voices || []).length);
      let keepAudio = true;
      for (const f of files) { if (f.black || !f.native) { keepAudio = false; break; } }
      if (hasVoice) keepAudio = true;
      job.keepAudio = keepAudio;

      /* ---------- 阶段一·五：字幕图片 ----------
         客户端已经把每条字幕按成片尺寸烧成一张透明 PNG，这里只负责取回本地。
         任何一张取不到就**整单失败**：静默跳过的结果是「导出成功、片子里少一句」，
         而回执上已经写了字幕条数。 */
      const subSpecs = wantAudio ? [] : (Array.isArray(subtitles) ? subtitles : []);
      const subFiles = [];
      if (subSpecs.length) {
        job.stage = '下载字幕'; job.progress = 35;
        let subDone = 0;
        const got = await mapLimit(subSpecs.map((s, i) => ({ s, i })), DL_CONCURRENCY, async ({ s, i }) => {
          abortIfCancelled();
          try {
            const url = await resolveSrc(s.src, job.key);
            const dest = path.join(dir, `sub_${i}.png`);
            await downloadTo(url, dest);
            return { ok: true, file: dest, start: Math.max(0, Number(s.start) || 0), end: Math.max(0, Number(s.end) || 0) };
          } catch (e) {
            return { ok: false, err: (e && e.message) || String(e) };
          } finally {
            subDone++; job.progress = 35 + Math.round((subDone / subSpecs.length) * 4);
          }
        });
        const bad = got.filter(x => !x || !x.ok);
        if (bad.length) {
          throw new Error('有 ' + bad.length + ' 条字幕图片取不到，成片没有生成（不静默丢字幕）'
            + (bad[0] && bad[0].err ? '：' + bad[0].err : ''));
        }
        got.forEach(x => subFiles.push(x));
        job.log.push('字幕 ' + subFiles.length + ' 条');
      }

      /* ---------- 阶段二：**一次** ffmpeg 出片 ----------
         以前是「每段单独编码成 norm_N.mp4 → concat 直拼」：N 段就是 N+1 次 ffmpeg 启动、
         N 次完整重编码（每段都要为 libx264 重开一遍 GOP、重写一遍封装），片头片尾还各多一次
         无谓的封装开销。这里改成**单遍 filter_complex**（与参考项目的 projectRenderPlan 同一条路）：
         每段只做 trim / scale / pad / fps 归一后 concat，音轨各自 adelay 后一次 amix，
         全程只有一次编码、一次封装。分辨率、fps、48k/双声道 AAC 与「单遍」这两件事没变；
         变的是**编码器与档位不再写死** —— 由 `.env` 的 RENDER_VCODEC / RENDER_PRESET 声明，
         没配就还是原来那一档（libx264 + veryfast + 界面那个 crf）。 */
      /* 编码档位走到这一步才现定：`.env` 里配的那个名字，在这台机器的 ffmpeg 上到底编没编进去，
         只有问一次 `ffmpeg -encoders` 才知道（结果进程内缓存，一整轮渲染只问一回）。
         本机没有 → 退回 libx264 并把原因写进这一单的日志：静默换成别的编码器，用户看到的是
         「我配了 H.265，出来的还是 H.264」，而整单报错更糟 —— 片子明明出得来。
         只出音频那一支根本没有视频流，不去问它（enc 留 null，日志里那句「编码 …」跟着不报）。 */
      const enc = wantAudio ? null : await pickEncode(jid);
      job.stage = keepAudio ? '合成（单遍编码 · 保留音频）' : '合成（单遍编码 · 静音）';
      job.progress = 40;
      const args = ['-y'];
      const vFilters = [], aFilters = [];
      const vLabels = [], aLabels = [];
      let inputCount = 0;
      const addInput = parts => { args.push(...parts); return inputCount++; };

      /* 配音的尾巴能越过自己锚着的那一段（一句长台词跨两个镜头是正常需求），所以「这一句还能响多久」
         的上界不再是「本段剩余」，而是「本句时长、并且不超出片尾」。片尾这个数必须在循环之前就拿到：
         它和循环末尾那个 `total` 必须是同一条算式（Σ span/speed），差一点就会把尾巴提前切掉。 */
      const totalFilm = Math.max(0.1, files.reduce((a, f) =>
        a + Math.max(0.1, Number(f.span) || 0) / (f.speed || 1), 0));
      let offset = 0;                     // 这一段在成片时间轴上的起点（秒）
      for (const f of files) {
        const span = Math.max(0.1, Number(f.span) || 0);
        const speed = f.speed;
        const outDur = span / speed;      // 画面 setpts 除以 speed → 成片里占这么长
        const tempo = tempoChain(speed);
        if (f.black && !wantAudio) {
          const vi = addInput(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${span.toFixed(3)}:r=${fps}`]);
          vFilters.push(`[${vi}:v]scale=${width}:${height},setsar=1,fps=${fps},setpts=(PTS-STARTPTS)/${speed},format=yuv420p[v${f.i}]`);
          vLabels.push(`[v${f.i}]`);
        } else if (f.black && wantAudio) {
          /* audioOnly：黑场段只要一个「占位输入」，画面一律不要（连黑场都不生成 ——
             逐句导出时那句配音通常就挂在一个黑场 clip 上，生成一段纯黑视频纯属白烧 CPU）。 */
        } else {
          /* 入点与长度用**输入级** -ss / -t：它走解码器 seek，比「整段解码进滤镜再 trim 掉」快得多
             —— 后者正是老实现慢的另一半（在滤镜里 trim 要把这一段完整解一遍）。 */
          const vi = addInput(['-ss', String(f.inP), '-t', String(span), '-i', f.file]);
          vFilters.push(`[${vi}:v]` + [
            `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
            'setsar=1', `fps=${fps}`,
            `setpts=(PTS-STARTPTS)/${speed}`,
            'format=yuv420p',
          ].join(',') + `[v${f.i}]`);
          vLabels.push(`[v${f.i}]`);
          if (keepAudio && f.native) {
            /* 原声：输入级 -ss/-t 已经裁好，这里只补音量 / 变速，再按成片时间轴 delay。
               normalize=0 很重要 —— 默认 amix 会按输入数把每路音量除下去，配音会越加越小。 */
            aFilters.push(`[${vi}:a]asetpts=PTS-STARTPTS,volume=${f.volume}${tempo},`
              + `adelay=delays=${Math.round(offset * 1000)}:all=1[a${f.i}]`);
            aLabels.push(`[a${f.i}]`);
          }
        }
        /* 逐句配音：延迟到「这一段起点 + 句内偏移」，**尾巴放到这一句自己的长度**（只夹到片尾）。
           以前上界是「这一段还剩多少」—— 一句比锚着的那一格长的台词，导出后只剩前半句，
           而剪辑态预览（`TlPlay.startVoices` 按绝对成片秒起播、整句放完）是全的：
           同一句话，屏幕上听得到、成片里听不到。所有音频路最后进的是同一条全局 amix，
           `adelay` 给的又是绝对秒，所以放开这一刀天然就跨得过去（盖到后面那一段的画面上），
           不需要新开一条通道；片尾那一刀由下面 `atrim=end=total` 兜住。
           `room` 在 atempo **之前**，单位是音频文件秒，所以「还能响多久」要乘回这一句的实际倍速。
           这一句的实际倍速 = 那一格画面的 `speed` × 这一句自己的 `spd`（缺省 1，与从前一模一样）：
           起点 `at` 只除画面倍速（倍速不动「从画面的第几秒开始响」），与客户端 `tlPlayPlan` 两条算式一字不差。 */
        for (let k = 0; k < f.voices.length; k++) {
          const v = f.voices[k];
          /* 切过开头的那一句从音频中间取：`-ss` 放在 `-i` 之前是**输入级 seek**（快、且不用先解一遍） */
          const ai = addInput(v.off > 0.02 ? ['-ss', String(v.off), '-i', v.file] : ['-i', v.file]);
          const at = offset + v.start / speed;
          const vrate = speed * (v.spd || 1);
          const room = Math.max(0.1, Math.min(v.dur, (totalFilm - at) * vrate));
          aFilters.push(`[${ai}:a]atrim=start=0:duration=${room.toFixed(3)},asetpts=PTS-STARTPTS,volume=${v.vol}${tempoChain(vrate)},`
            + `adelay=delays=${Math.round(at * 1000)}:all=1[av${f.i}_${k}]`);
          aLabels.push(`[av${f.i}_${k}]`);
        }
        offset += outDur;
      }
      /* 与上面 `totalFilm` 是同一个数（同一条算式、同一个累加序），所以这里直接取它：
         配音的上界与 amix 后面那道 `atrim=end=` 必须用同一把尺子，两处各算一次就会差出半句。 */
      const total = totalFilm;
      /* audioOnly 时**不搭画面链**：vLabels 是空的，concat 那一段整段跳过（见上面那段说明）。
         画面那一整支（vFilters / vMap）只在要出视频时才生成。 */
      if (vLabels.length) vFilters.push(vLabels.join('') + `concat=n=${vLabels.length}:v=1:a=0[vcat]`);

      const vMap = (() => {
        /* 字幕烧录：每张 PNG 一个输入，按 [start,end] 时间窗叠在 concat 之后。
           `enable` 用的是**成片秒**（与 total / 配音 adelay 同一条轴）；图片只有一帧，
           overlay 默认 repeatlast 会把它保持到窗口结束。PNG 已经是成片尺寸，x/y 都是 0。 */
        let label = '[vcat]';
        if (!subFiles.length || !vLabels.length) return label;
        let n = 0;
        for (const s of subFiles) {
          const a = Math.max(0, Math.min(total, Number(s.start) || 0));
          const b = Math.max(0, Math.min(total, Number(s.end) || 0));
          if (b <= a) continue;
          const si = addInput(['-i', s.file]);
          const out = `[vsub${n}]`;
          vFilters.push(`${label}[${si}:v]overlay=x=0:y=0:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'${out}`);
          label = out;
          n++;
        }
        if (n) job.log.push('烧录字幕 ' + n + ' 条');
        return label;
      })();

      /* 可选背景音乐：与成片混音（原声压低）。-stream_loop -1 是无限长，下面 atrim 到成片长度。 */
      let bgmIdx = -1;
      if (bgm) {
        const bgmFile = path.join(dir, 'bgm' + (path.extname(bgm) || '.mp3'));
        await downloadTo(await resolveSrc(bgm, job.key), bgmFile);
        bgmIdx = addInput(['-stream_loop', '-1', '-i', bgmFile]);
      }
      if (aLabels.length) {
        const ins = aLabels.slice();
        if (bgmIdx >= 0) {
          aFilters.push(`[${bgmIdx}:a]atrim=start=0:duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.35[abg]`);
          ins.push('[abg]');
        }
        aFilters.push(ins.join('')
          + `amix=inputs=${ins.length}:duration=longest:normalize=0,atrim=end=${total.toFixed(3)}`
          + ',aformat=sample_rates=48000:channel_layouts=stereo[aout]');
      }

      args.push('-filter_complex', vFilters.concat(aFilters).join(';'));
      if (wantAudio) {
        /* 只出音频：`-vn` 掉画面，容器换 m4a（aac 本来就在 m4a 里）。
           没有音轨就直接说清 —— 静默出一个 0 字节文件，用户看到的是「导了个空文件」。 */
        if (!aLabels.length) throw new Error('这一单没有音频可出（配音句已不存在，或都落在剪不到画面的位置上）');
        args.push('-vn', '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', outPath);
      } else {
        args.push('-map', vMap, ...encodeVideoArgs(enc.codec, enc.preset, crf));
        if (aLabels.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
        else args.push('-an');
        args.push('-movflags', '+faststart', outPath);
      }
      job.log.push((wantAudio ? '只出音频' : '单遍合成') + '：' + files.length + ' 段 · ' + total.toFixed(1) + ' 秒 · '
        + aLabels.length + ' 路音轨' + (enc ? ' · 编码 ' + enc.codec + ' · 档位 ' + enc.preset + ' · 质量档 ' + crf : ''));
      if (enc && enc.why) job.log.push(enc.why);
      /* 按时长给这一单一个上限：以前 runFfmpeg 完全没有时限，一个坏输入（无限长的播放列表 / 循环滤镜 /
         卡住的源）能把渲染位子和队列一起挂死，界面上永远「合成中 45%」，只有重启代理能解。 */
      const budget = ffmpegBudgetMs(total);
      job.log.push('本单时间上限 ' + Math.round(budget / 1000) + ' 秒（片长 ' + total.toFixed(1) + ' 秒）');
      await runFfmpeg(args, line => {
        /* 只往前走：`time=` 是已经写出去的输出秒数，同一次编码不会变小，但一行里挤了几条进度时
           旧值会先出现。倒退的进度条看着像「卡住了又开始跑」，比原地不动更招人烦。
           `total` 为 0 时不算（0/0 = NaN，序列化出去会变成 null，界面上那句「合成中 45%」就没了数）。 */
        let t = 0;
        for (const m of String(line).matchAll(/time=(\d+):(\d+):([\d.]+)/g)) {
          const v = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          if (v > t) t = v;
        }
        if (t > 0 && total > 0) {
          const pct = Math.min(96, 45 + Math.round((t / total) * 50));
          if (pct > job.progress) job.progress = pct;
        }
      }, jid, { maxMs: budget });
      rmrf(dir);
      const size = fs.statSync(outPath).size;
      job.progress = 100; job.state = 'done'; job.stage = '完成';
      job.out = outName; job.size = size; job.ts = Date.now();
      job.log.push(`✓ 成片完成：${outName}（${(size / 1048576).toFixed(1)} MB）`);
      log(`[render] ✓ ${outName} ${(size / 1048576).toFixed(1)} MB`);
      try { renderJobs.record(job); } catch {}
      pruneRenders();
    } catch (e) {
      const cancelled = job.state === 'cancelled';
      job.state = cancelled ? 'cancelled' : 'failed';
      job.err = cancelled ? '' : e.message;
      job.log.push(cancelled ? '✗ 已取消' : ('✗ ' + e.message));
      log(`[render] ${cancelled ? '✗ 已取消' : '✗ ' + e.message}`);
      rmrf(dir);
      try { renderJobs.record(job); } catch {}
    } finally {
      job.ts = Date.now();
      pumpRenderQueue();
    }
  }

  /* ---------- 渲染队列：并发上限 + 任务记录回收 + 成片保留上限 ---------- */
  /* 排队位置实时重算：队列里有人取走 / 取消后，后面任务的显示位置跟着前移 */
  function refreshQueuePos() { renderQueue.forEach((j, i) => { j.queuePos = i + 1; }); }
  function pumpRenderQueue() {
    while (renderRunning < RENDER_CONCURRENCY && renderQueue.length) {
      const job = renderQueue.shift();
      refreshQueuePos();
      if (job.state === 'cancelled' || job.state === 'failed') continue;
      renderRunning++;
      job.state = 'running';
      try { renderJobs.record(job); } catch {}
      renderJob(job).catch(e => log('[render] 任务异常：' + e.message)).finally(() => { renderRunning--; pumpRenderQueue(); });
    }
  }
  function enqueueRender(job) {
    job.state = 'queued';
    renderQueue.push(job);
    refreshQueuePos();
    pumpRenderQueue();
  }
  /* 每 5 分钟回收：过期的任务记录，以及渲染中途崩溃留下的临时目录（成片文件不按数量清，见 pruneRenders 里那段） */
  function pruneRenders() {
    const now = Date.now();
    renders.forEach((job, id) => {
      const done = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
      if (done && job.ts && now - job.ts > RENDER_KEEP) renders.delete(id);
    });
    try {
      /* 成片**不再按数量清理**（2026-10 用户要求：成片文件的保存不要有数量限制）。
         以前这里保留最近 20 个、更早的连文件带记录一起删 —— 而 `.renders` 是「导出成片」唯一的落点，
         删掉就是用户自己的成品凭空不见了（数据没丢，
         但要重跑一遍 ffmpeg 才拿得回来，几十秒起步）。磁盘是用户自己的，留多少由他决定。
         仍然清理的是**渲染途中崩溃留下的临时目录**（下面那一段），那是我们自己的垃圾。 */
      // 渲染中途崩溃留下的临时目录（非 30 位任务号形态的目录）
      /* `fcpxml-import` 是一键送到剪映 / 达芬奇的工程目录：它在不在、留几个由
         routes/fcpxml.js 自己按「最近 20 个」管，这里不许整棵删掉 ——
         用户可能正开着那台机器的 NLE 从这个目录导入。 */
      fs.readdirSync(RENDER_DIR).forEach(d => {
        if (d === 'fcpxml-import') return;
        const p = path.join(RENDER_DIR, d);
        try {
          if (!fs.statSync(p).isDirectory()) return;
          const st = fs.statSync(p);
          if (now - st.mtimeMs > RENDER_KEEP && !renders.has(d)) rmrf(p);
        } catch {}
      });
    } catch {}
  }
  setInterval(pruneRenders, 5 * 60 * 1000).unref?.();

  /* 「本机现在到底会怎么出片」——渲染那几个数都是**启动时定一次**的（改了要重启），
     所以体检里必须把「生效值 + 它是从哪儿来的」一起报出来：`.env` 里写了并发 2 而实际还在串行，
     界面上没有任何地方看得出来（与上面启动日志同一口径）。
     编码器在这台机器上到底有没有，只能问 ffmpeg 自己，而那是异步的（`listEncoders`）；体检是同步的，
     所以这里只读已经缓存下来的那份清单。三档分开给，**且一句都不在页面里重拼**：
     · `芯片` 短给设置页那一行上色用（ok / warn 也在这里定，页面不拿正则猜中文）；
     · `说明` 整句给复制文本与助手的 doctor —— 它们要的是能贴出去排查的那一句。
     没问过就照实说没问过：**不拿「不知道」冒充「没有」**，那会让人去重装一个本来就装好的 ffmpeg。 */
  function renderStatus() {
    const prof = ENCODE_PROFILES[RENDER_VCODEC];
    let chip = '还没问过', cls = 'warn', say;
    if (RENDER_VCODEC === VCODEC_DEFAULT) { chip = '默认档'; cls = 'ok'; say = '默认这一档，哪台 ffmpeg 都有'; }
    else if (encodersKnown === null) say = '还没问过这台 ffmpeg（第一次导出时自动问；没有它就退回 ' + VCODEC_DEFAULT + '，并在那一单的日志里写明原因）';
    else if (encodersKnown.has(RENDER_VCODEC)) { chip = '这台有'; cls = 'ok'; say = '这台 ffmpeg 编进了 ' + RENDER_VCODEC; }
    else { chip = '这台没有'; say = '这台 ffmpeg 没编进 ' + RENDER_VCODEC + ' → 导出时自动退回 ' + VCODEC_DEFAULT + '（想用它要换一个编进了它的构建）'; }
    return {
      编码: RENDER_VCODEC, 中文名: prof.zh, 档位: RENDER_PRESET,
      本机: chip, 本机档: cls, 本机说明: say,
      质量: '每单在界面上选的那个 crf（14–32）',
      同时: RENDER_CONCURRENCY, 队列上限: RENDER_QUEUE_MAX, 保留分钟: Math.round(RENDER_KEEP / 60000),
      来源: 'RENDER_VCODEC ' + envFromStr('RENDER_VCODEC') + ' · RENDER_PRESET ' + envFromStr('RENDER_PRESET')
        + ' · 并发 ' + envFrom('RENDER_CONCURRENCY') + ' · 队列 ' + envFrom('RENDER_QUEUE_MAX')
        + ' · 保留 ' + envFrom('RENDER_KEEP_MIN') + '（都写在 .env 里，改完要重启）',
    };
  }
  return {
    renders, renderQueue, enqueueRender,
    pruneRenders, renderJob, killJobProcs, allProcs,
    runFfmpeg, capture, probe, probeFile,
    pickEncode, encodersKnown, listEncoders, mediaState,
    cacheSweep, assetUrlCache, assetInfoOf, resolveSrc,
    downloadTo, VOICE_MAX, fmtTime, renderStatus,
    // 「同时在跑几条」是一个会变的数：给闭包，别给快照（app 的启动日志与 /render 路由都读它）。
    running: () => renderRunning,
  };
}

module.exports = { createRenderJobs };
