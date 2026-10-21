/* Net — 统一请求层（超时 / 重试 / 可读错误 / NUMS 那三个数字的唯一表）。
   从 web/ui/ui.js 拆出；加载顺序在 ui.js 之后、页面脚本之前。 */
(function () {
const sleep = ms => new Promise(r => setTimeout(r, ms));
  const RETRY_DELAY = 600;
  /* 「网络与刷新」那三个数字：默认值与上下限**只有这一张表**（§J ⑳ 守着）。
     收成一份之前有四把各写各的夹取：
       · 这里写 30 秒 / 5..300、重试 1 / 0..5；
       · 设置页显示时一份下限（5 / 0 / 2），保存时上限又另写一遍（300 / 5 / 60）；
       · 设置页标记里 `min` / `max` 属性第四份；
       · `workbench.js` 的轮询器第三份 `>= 2` 与 `Math.min(60, …)`。
     四份迟早漂开，而漂开的表现是「设置页填进去的数，运行层按另一个上限截」——
     界面上看不出被截过，用户以为自己设成了 300 秒。 */
  const NUMS = {
    timeout: { key: 'sk_net_timeout', def: 30, min: 5, max: 300 },
    retry: { key: 'sk_net_retry', def: 1, min: 0, max: 5 },
    poll: { key: 'sk_poll_sec', def: 4, min: 2, max: 60 },
  };
  /* 没存过（null / 空串）不能当成 0 —— 那会把「重试 1 次」的默认值悄悄变成「不重试」，
     网络一抖动就不重试了，很难查。存进来的值读不出数（NaN）同样退回默认，不是退回 0。
     返回 null = 「本机没存过」，调用方据此决定退回什么（轮询器退回页面自己传的 interval）。 */
  function storedNum(name) {
    const sp = NUMS[name];
    const raw = window.LS.get(sp.key);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(sp.max, Math.max(sp.min, n)) : null;
  }
  function num(name) {
    const v = storedNum(name);
    return v == null ? NUMS[name].def : v;
  }
  /* 取整 + 夹到声明的区间：给设置页回填用。填 999 要当场把输入框改成 300，
     而不是存 999、让运行层自己截 —— 那正是「看着设成了 999，实际是 300」。
     **但「清空这一格」不等于「填了 0」**：`Number('')` 是 0，直接夹就成了下限，
     于是把超时那一格删空会得到 5 秒、把重试那一格删空得到 0（＝不重试）——
     正是上面 `storedNum` 那段注释点名要防的那件事，读的那一侧守住了、写的这一侧漏了。
     空格串同样算没填（`<input type=number>` 收到非数字只剩空串，人眼看到的是「空的」）。 */
  function clampNum(name, v) {
    const sp = NUMS[name];
    if (v == null || String(v).trim() === '') return sp.def;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(sp.max, Math.max(sp.min, n)) : sp.def;
  }
  function setNum(name, v) {
    const val = clampNum(name, v);
    /* 配额满了也要回夹后的值：界面显示的是「运行层真正在用的数」，不能显示一个没存住的数 */
    try { localStorage.setItem(NUMS[name].key, String(val)); } catch {}
    reloadConfig();
    return val;
  }
  const cfg = { timeout: NUMS.timeout.def * 1000, retry: NUMS.retry.def };
  function reloadConfig() {
    cfg.timeout = num('timeout') * 1000;
    cfg.retry = num('retry');
  }
  try { reloadConfig(); } catch {}
  window.addEventListener('storage', e => { if (!e.key || String(e.key).startsWith('sk_net_')) reloadConfig(); });

  function readable(e, timeout) {
    if (!e) return new Error('请求失败');
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return new Error(timeout ? `请求超时（${Math.max(1, Math.round(timeout / 1000))} 秒没有响应）` : '请求已取消');
    }
    const m = String(e.message || e);
    if (/Failed to fetch|NetworkError|ERR_|fetch failed/i.test(m)) {
      const err = new Error('连不上本地代理（proxy.js 没启动？改完 proxy.js 要重启）');
      err.__net = true;                       // 网络层失败：交给 fetch 判断代理到底活没活着（见下）
      return err;
    }
    return e instanceof Error ? e : new Error(m);
  }
  /* 代理是否活着 —— 只在「网络层失败」时探一次，用来区分两件完全不同的事：
       · 代理真没起来 / 端口不通  → 提示重启 proxy.js 是对的；
       · 代理活着，只是这次连接被掐断（代理刚重启、上游把连接 RST、系统掐了长连接）→ 让人去重启是误导。
     这个区分在提交类请求上尤其要紧：POST 被掐断时平台很可能已经受理了，
     提示成「失败」会诱导用户再点一次 → 平台上出现两条重复任务。 */
  let aliveAt = 0, aliveOk = false, aliveProbe = null;
  function proxyAlive() {
    if (Date.now() - aliveAt < 3000) return Promise.resolve(aliveOk);
    if (aliveProbe) return aliveProbe;
    /* 探测也要有超时：端口被丢弃包（而非拒绝）时 fetch 会挂很久，错误就迟迟不显示 */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    aliveProbe = fetch('/registry', { method: 'GET', cache: 'no-store', signal: ctl.signal })
      .then(r => { aliveOk = !!r && r.ok; return aliveOk; })
      .catch(() => { aliveOk = false; return false; })
      .then(v => { clearTimeout(timer); return v; })
      .then(v => { aliveAt = Date.now(); aliveProbe = null; return v; });
    return aliveProbe;
  }

  window.Net = {
    reloadConfig,        // 设置页改完超时/重试后调用
    /* 「网络与刷新」那三个数字的唯一读法（名字是 timeout / retry / poll，不是键名 ——
       键名只在这张表里出现一次，页面与设置页都不许再写 `'sk_net_timeout'` 这种字面量）：
         num(name)         存过的值（夹过），没存过退回默认 —— 运行层用这个
         storedNum(name)   没存过 = null —— 轮询器用它区分「用户设过」与「页面传的 interval」
         setNum(name, v)   夹 + 落盘 + reloadConfig，返回真正存进去的那个数（夹这件事不单独对外，
                           单独暴露一份 clamp 只会让人拿来「先夹再自己存」，那就绕过了落盘这一半）
       界面上的 min / max 也从这张表现读（见 settings.html 那一栏），不要再抄进标记。 */
    NUMS, num, storedNum, setNum,
    /* 返回原始 Response（已判超时与重试；状态码交给调用方处理） */
    async fetch(url, opts = {}) {
      const method = String(opts.method || 'GET').toUpperCase();
      const timeout = opts.timeout === undefined ? cfg.timeout : opts.timeout;
      /* 重试策略：网络抖动 / 5xx / 429 才重试，且**默认只重试幂等方法**（GET/HEAD/PUT/DELETE/OPTIONS）。
         POST 只有在带幂等键时才允许重试 —— 服务端按键去重，重试不会建出第二条任务；
         没带键的 POST 一律不重试：请求已发出但响应超时的情况下，重试会重复建任务、重复扣费。
         （哪些平台支持幂等键由 registry 的 create.idempotencyKey 声明，见 proxy.js / api.js） */
      const hdr = opts.headers;
      const hasIdem = !!(hdr && (typeof hdr.get === 'function'
        ? hdr.get('Idempotency-Key')
        : (hdr['Idempotency-Key'] || hdr['idempotency-key'])));
      const idempotent = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method);
      const retryCfg = opts.retry === undefined ? cfg.retry : opts.retry;
      const retry = (idempotent || hasIdem) ? retryCfg : 0;
      let lastErr = null;
      for (let attempt = 0; attempt <= retry; attempt++) {
        const ctl = new AbortController();
        const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
        const ext = opts.signal;
        /* 区分「自己超时」与「调用方主动取消」：两者都是 AbortError，
           不记下来会把用户点的取消报成「请求超时」。 */
        let cancelled = false;
        const onExt = () => { cancelled = true; ctl.abort(); };
        if (ext) { if (ext.aborted) { cancelled = true; ctl.abort(); } else ext.addEventListener('abort', onExt, { once: true }); }
        try {
          const r = await fetch(url, { ...opts, signal: ctl.signal });
          // 5xx / 429 才重试：4xx 是请求本身的问题
          if (!r.ok && (r.status >= 500 || r.status === 429) && attempt < retry) {
            lastErr = new Error('HTTP ' + r.status);
            await sleep(RETRY_DELAY * (attempt + 1));
            continue;
          }
          return r;
        } catch (e) {
          lastErr = cancelled ? new Error('请求已取消') : readable(e, timeout);
          if (attempt < retry) { await sleep(RETRY_DELAY * (attempt + 1)); continue; }
          break;      // 重试也用完了：跳出循环，交给循环外的统一收尾（在那里判断「代理是否还活着」并富化文案）
        } finally {
          if (timer) clearTimeout(timer);
          if (ext) ext.removeEventListener('abort', onExt);
        }
      }
      /* 走到这里说明重试也用完了。若是网络层失败，先探一下代理：
         活着 → 说清是「连接中断」而不是「没启动」；提交类再补一句「可能已受理」，
         免得用户把一次已经成功的提交当成失败、重复点。 */
      if (lastErr && lastErr.__net) {
        const alive = await proxyAlive();
        if (alive) {
          const writing = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
          lastErr = new Error(writing
            ? '与本地代理的连接在提交过程中中断了（代理可能刚重启，或长连接被掐断）。'
              + '「这次提交可能已经到达平台」：先刷新列表核对有没有这条任务，确认没有再用「重试」，避免重复提交／重复扣费。'
            : '与本地代理的连接中断了（代理可能刚重启，或长连接被掐断）：重试一次通常就好。');
          lastErr.maybeSubmitted = writing;
        }
      }
      throw lastErr || new Error('请求失败');
    },
    /* 一次响应读成「原文 + 试解析出来的 JSON」这一步，全站只此一份。
       json() / assetlib 的 rawFetch 与 respBody / PromptLog 的 req / 导演台的 readJsonSafe 五处
       都要先做这两步再各判各的错误，以前各抄一遍：其中 PromptLog 那一份把解析失败吞进
       `catch (e) {}`，代理回了半截 JSON 时它拿到 null，报出来的是「HTTP 200」而不是「没读出来」。
       只读一次 text()：不能先 r.json() 再 r.text() —— 响应体只能读一遍，
       先试 JSON 的那一路一旦失败就没有正文了，真原因（代理写在 text/plain 里那句）会被扔掉。 */
    async readRes(r) {
      const txt = await r.text();
      let d = null, parseErr = null;
      try { d = txt ? JSON.parse(txt) : null; } catch (e) { parseErr = e; }
      return { res: r, status: r.status, ok: r.ok, txt, d, parseErr };
    },
    /* 发一次请求并把响应读成上面那份结构（超时、退避重试、可读错误都由 fetch 那一层给） */
    async read(url, opts = {}) { return this.readRes(await this.fetch(url, opts)); },
    /* 取 JSON：非 2xx 抛带 status 的错误（错误文案优先用上游给的 message） */
    async json(url, opts = {}) {
      const x = await this.read(url, opts);
      if (!x.ok) {
        const e = new Error(upstreamMsg(x.d) || ('HTTP ' + x.status));
        e.status = x.status;
        e.data = x.d;
        throw e;
      }
      if (x.d === null && x.parseErr) throw new Error('返回了非 JSON 内容（HTTP ' + x.status + '）');
      return x.d;
    },
    /* 取二进制：**先判 HTTP 状态**再转 blob，避免把错误页当成品存盘 */
    async blob(url, opts = {}) {
      const r = await this.fetch(url, opts);
      if (!r.ok) { const e = new Error('下载失败 HTTP ' + r.status); e.status = r.status; throw e; }
      const b = await r.blob();
      if (!b.size) throw new Error('下载到的内容是空的');
      return b;
    },
    /* 触发下载（统一回收 blob URL，避免内存泄漏） */
    save(blob, filename) {
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = withExt(filename || 'download', blob && blob.type);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
    },
    errorText(e, fallback) { return (e && e.message) ? e.message : String(e || (fallback || '未知错误')); },
  };
  /* 错误文案的唯一读法。全站原来有 145 处各写一遍 `(e && e.message) || e`：
     同一个错误在资产库是一条句子、在工作台是另一条，用户没法照着排查。
     第二个参数是「这个错误没带任何话时该说什么」，只给那些本来写着 `|| '取价失败'` 的调用点用，
     不是第二套文案判据 —— 有 message 时它一律不生效。
     挂成 window.errText 是因为调用点既有经典脚本也有 ESM 页面，两边都要能拿到同一份。 */
  window.errText = (e, fallback) => window.Net.errorText(e, fallback);
  function upstreamMsg(d) {
    if (!d) return '';
    return (d.error && (d.error.message || d.error.code)) || d.message || d.error || '';
  }
  /* 下载名没带扩展名时按 blob 的 MIME 补一个：素材库与灯箱递出来的是「小雅 · 预览图」这种
     人话名字，浏览器存下来就成了一个**没有类型**的文件（双击打不开、也看不出是 png 还是 webp）。
     名字里已经有一个点就原样放行（SRT / 成片那些本来就带着 `.srt` `.mp4`），
     MIME 认不出来也原样放行 —— 这一层只补，绝不改坏已经对的名字。 */
  const MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/wav-format': 'wav', 'audio/ogg': 'ogg',
    'text/plain': 'txt', 'text/vtt': 'vtt', 'application/json': 'json', 'application/pdf': 'pdf',
  };
  function withExt(name, mime) {
    if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return name;
    const ext = MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()];
    return ext ? name + '.' + ext : name;
  }
})();
