/* relay 前缀转发：/<relay>/<path> → 平台 base；密钥 / 基址 / 缓存 / 转发闸都在这一层。
   处理完返回 undefined（调用方按 !== false 判），没有命中返回 false。 */
'use strict';

/* 两份短缓存的体量上限：只有这一层用它们，所以名字就住在这里（以前定义在 app.js、
   拆路由时既没跟着搬、也没注入 ctx，于是每次列表回源都在 `ur.on('end')` 里抛
   ReferenceError —— 那一处不在 Promise 链上，catch 接不住：响应永远不发、名额要等 5 分钟
   看门狗才收回，而 `tests/` 里没有任何一条覆盖到这一行。 */
const LIST_CACHE_MAX = 60;                      // 列表缓存条数上限，防止长时间运行无限增长
const LIST_CACHE_BYTES = 64 * 1024 * 1024;      // 字节上限（单条最大 8 MiB，条数封顶挡不住总量）
const LIST_CACHE_ITEM = 8 * 1024 * 1024;        // 单条列表超过就不缓存
const DETAIL_CACHE_MAX = 300;
const DETAIL_CACHE_BYTES = 64 * 1024 * 1024;    // 同上（单条最大 2 MiB）
const DETAIL_CACHE_ITEM = 2 * 1024 * 1024;      // 单条详情超过就不缓存
/* 排队这一侧的两条闸由 app.js 注入：RELAY_QUEUE_TIMEOUT_MS 与「客户端是否还活着」的判据 */

function createRelayRoutes(ctx) {
  const {
    allProviders, safeOutboundUrl, baseKeyOf, keyOf, log, readBody,
    detailCache, detailInflight, listCache, listInflight, DETAIL_TTL,
    relayGateOf, relayTake, relayRefused, relayRetryWait, noteRelayEvent,
    cacheSweep, upRequest, failUpstream, pipeUpstream, DEFAULTS,
  } = ctx;

  function handleRelay(req, res) {
    /* ---------- 通用转发：所有 provider 的 relay 前缀都走这里 ----------
       /<relay>/<path> → <base><path>
         · 密钥：优先取客户端 Authorization；**只有内置平台**才允许回退到 keyEnv 环境密钥 / DEFAULTS
         · baseEditable 的平台（文字 AI）允许用 x-up-base 头临时换基址
         · 设置页新添加的自定义平台（p.custom）也在这一条里：relay 是 /custom/<id>，基址来自那份声明，
         而且**不回退环境密钥**（环境里那把是内置平台的钥匙，递给一个陌生网关等于把密钥送出去）
       改内置平台（含语音合成）在 REGISTRY 里加一条：relay/base/keyEnv/endpoints，转发自动生效；
       换地址换密钥的同形状中转站在设置页「添加自定义供应商」里填表单即可，代理不用改。 */
    /* 列表接口的短 TTL 缓存：/generations、/v2/videos 这类列表接口上游很慢（SparkCine 6~14s），
       资产库 / 图片台 / 视频台 / 导演台会重复请求同一份数据。
       只缓存 GET 列表请求，TTL 由 registry 的 list.cacheTtl 声明；客户端带 x-no-cache 头可强制回源。 */
    const relayHit = allProviders().find(p => p.relay && p.relay !== '/' && req.url.startsWith(p.relay + '/'));
    if (relayHit) {
      let base = relayHit.base;
      const upBase = req.headers['x-up-base'];
      /* 自定义基址也要过出站护栏：这一条路由会在客户端没带 Authorization 时**自动注入 .env 里的密钥**，
         以前只判 /^https:\/\//，于是把 x-up-base 指到 http 公网之外的任意主机（例如内网服务、
         127.0.0.1:5175 自己）都能把那把密钥原样送出去。只允许公网 https。 */
      let baseOverridden = false;
      if (relayHit.baseEditable && upBase) {
        const safeUp = safeOutboundUrl(upBase);
        if (!safeUp) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: { message: '自定义接口地址只允许公网 https（回环/内网/明文 http 一律拒绝）' } }));
          return;
        }
        /* 「换了地址」才算换 —— 只有**指向别处**才关掉 .env 密钥回退（见下面 keyFallback 那一段）。
           设置页添加内置平台时地址是**自动填好的**（就是它自己的官方地址），于是 sk_base_<id>
           存过之后每个请求都带着 x-up-base；以前只要带了这个头就算「换了网关」，
           .env 里那把密钥就再也不回退 —— 表现正是「.env 里明明有 OPENROUTER_API_KEY，
           点验证却报 401 Missing Authentication header（转发到 https://openrouter.ai/api/v1）」，
           而且不只验证，聊天与生成**所有**请求都会这样。
           地址与注册表里那一份等价（只差末尾斜杠 / 大小写）就按「没换」处理，用回 registry 那一份。 */
        baseOverridden = baseKeyOf(safeUp) !== baseKeyOf(relayHit.base);
        base = baseOverridden ? safeUp : relayHit.base;
      }
      /* 把地址换掉了，就**不能再用 .env 里那把内置密钥**：否则「客户端没带密钥 + 递来一个 x-up-base」
         等于把你的 SPARKCINE / OpenRouter 密钥原样送到那个主机上（它只证明得了连接，证明不了那是你的网关）。
         自定义平台没有可回退的环境密钥（建条目时 keyEnv / defaultKey 都摘掉了），缺密钥就是空 → 上游 401。 */
      const keyFallback = !relayHit.custom && !baseOverridden;
      const pathAndQuery = req.url.slice(relayHit.relay.length);
      /* 缓存键要带上实际基址与密钥尾号：同一个 relay 路径可能被打到不同的自定义地址
         （x-up-base）或不同的账号密钥，只按 req.url 作键会把 A 家的列表端给 B 家的请求。 */
      const cacheKey = req.url + '|' + base + '|' + ((req.headers.authorization || '').slice(-6));
      const listPath = relayHit.endpoints && relayHit.endpoints.list ? String(relayHit.endpoints.list).replace(/^local:/, '') : null;
      const createPath = relayHit.endpoints && relayHit.endpoints.create ? String(relayHit.endpoints.create).replace(/^local:/, '') : null;
      const listTtl = (relayHit.list && relayHit.list.cacheTtl) || 0;
      const isList = req.method === 'GET' && listPath && pathAndQuery.split('?')[0] === listPath;
      /* 创建任务：平台可能排队很久才回响应，给它更长的空闲超时（默认 60s 太短，会导致"其实建好了但页面看到失败"） */
      const isCreatePost = req.method === 'POST' && createPath && pathAndQuery.split('?')[0] === createPath;
      /* 单条任务详情（路径里带任务号）：已完成的详情不会再变，短缓存一下，
         卡片/详情反复打开就不用每次回源；进行中的任务不缓存，状态照常实时刷新。 */
      const isTaskDetail = req.method === 'GET'
        && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|job_[A-Za-z0-9]+/i.test(pathAndQuery.split('?')[0]);
      if (isTaskDetail && !req.headers['x-no-cache']) {
        const hit = detailCache.get(cacheKey);
        if (hit && Date.now() - hit.ts < (hit.ttl || DETAIL_TTL)) {
          res.writeHead(hit.status, { ...hit.headers, 'Cache-Control': 'no-store', 'X-Detail-Cache': 'hit' });
          res.end(hit.body);
          return;
        }
        /* 已经在取同一条详情 → 挂上去等，不再打第二次上游 */
        const waiters = detailInflight.get(cacheKey);
        if (waiters) { waiters.push(res); return; }
        detailInflight.set(cacheKey, []);
      }
      if (isList && listTtl && !req.headers['x-no-cache']) {
        const hit = listCache.get(cacheKey);
        if (hit && Date.now() - hit.ts < (hit.ttl || listTtl)) {
          res.writeHead(hit.status, { ...hit.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'hit' });
          res.end(hit.body);
          return;
        }
        /* 已经在取同一份列表 → 挂上去等（SparkCine 的列表要 6~14 s，这一下省得很实在） */
        const waiters = listInflight.get(cacheKey);
        if (waiters) { waiters.push(res); return; }
        listInflight.set(cacheKey, []);
      }
      /* 本请求若占了在途表，**每一条出口都必须**把等着的那些一起回掉并摘掉条目 ——
         漏一处，后来的同 key 请求就会永远挂在一张再也不会 fulfill 的表上。 */
      const inflightMap = (isTaskDetail && !req.headers['x-no-cache']) ? detailInflight
        : (isList && listTtl && !req.headers['x-no-cache']) ? listInflight : null;
      const flushInflight = respond => {
        if (!inflightMap) return;
        const ws = inflightMap.get(cacheKey) || [];
        inflightMap.delete(cacheKey);
        for (const w of ws) { try { respond(w); } catch {} }
      };
      /* 溢出之后转流式：等着的那些请求也一起边收边写，不再把整段攒在内存里 */
      const waitersOf = () => (inflightMap ? (inflightMap.get(cacheKey) || []) : []);
      const dropInflight = () => { if (inflightMap) inflightMap.delete(cacheKey); };
      readBody(req, res).then(body => {
        if (body == null) { flushInflight(w => failUpstream(w, '请求体读取失败', '上游')); return; }   // 超过上限已回 413
        const fwd = { ...req.headers };
        /* transfer-encoding 必须剥掉：下面强制带上 content-length（上游大多要求），
           两个头同时存在是非法请求，chunked 请求会直接被拒。 */
        ['cookie', 'connection', 'origin', 'referer', 'accept-encoding', 'host', 'authorization', 'content-length', 'transfer-encoding', 'x-up-base', 'x-no-cache'].forEach(h => delete fwd[h]);
        const apiKey = (req.headers.authorization || '').replace(/^Bearer\s*/, '')
          || (keyFallback ? keyOf(relayHit.keyEnv) || DEFAULTS[relayHit.keyId || relayHit.id] || relayHit.defaultKey : '') || '';
        /* 转发失败那句话的主语必须是**真打出去的那一台**：relay 前缀一家一段（v19 起，
           等价声明才允许共用，判据在 providers/validate.js），relayHit 就是这一家；
           页面还能用 x-up-base 把地址整个换掉。以前这里写 relayHit.id，
           界面就成了「deepseek 转发失败（打到 openrouter.ai）」—— 让人去别的一家翻密钥、翻设置。
           地址是页面递来的（baseOverridden）时不再报平台名，只报那一台主机 —— 这才是唯一确定的事实。 */
        const upHost = String(base).replace(/^https?:\/\//, '').split('/')[0];
        const relayTag = (baseOverridden ? '转发失败' : (relayHit.name || relayHit.id) + ' 转发失败')
          + '（打到 ' + upHost + '）';
        const relayOpts = {
          method: req.method,
          headers: { ...fwd, authorization: 'Bearer ' + apiKey, 'content-length': body.length, 'accept-encoding': 'identity' },
          timeoutMs: isCreatePost ? 120000 : 0,
          keepAlive: true,              // relay 的目标主机来自注册表声明（见 keepAliveAgent / agentFor）
        };
        /* 回话那一大段（列表缓冲 / 详情缓冲 / 直接 pipe）收成这一个函数：它现在既可能被第一次尝试调到，
           也可能被退避重试那一次调到 —— 写两遍迟早和这一遍不一致（「重试那份不写缓存」就是其中一种）。 */
        const relayRespond = ur => {
          if (isList && listTtl && ur.statusCode === 200) {
            const bufs = [];
            let total = 0, stream = null;
            /* 缓存上限不是「先全收下来再判断」：超了 8MiB 就当场改成边收边转发，
               既不再囤内存，也不会把这条正常请求变成错误。等着的那些一并转流式。 */
            const streamHead = tag => ({ ...ur.headers, 'Cache-Control': 'no-store', 'X-List-Cache': tag });
            ur.on('data', c => {
              if (stream) {
                try { res.write(c); } catch {}
                stream.ws.forEach(w => { try { w.write(c); } catch {} });
                return;
              }
              total += c.length;
              if (total > LIST_CACHE_ITEM) {
                stream = { ws: waitersOf() };
                dropInflight();
                try { res.writeHead(ur.statusCode, streamHead('miss')); } catch {}
                bufs.forEach(b => { try { res.write(b); } catch {} });
                try { res.write(c); } catch {}
                stream.ws.forEach(w => {
                  try {
                    w.writeHead(ur.statusCode, streamHead('shared'));
                    bufs.forEach(b => w.write(b));
                    w.write(c);
                  } catch {}
                });
                bufs.length = 0;
                return;
              }
              bufs.push(c);
            });
            ur.on('end', () => {
              if (stream) {
                try { res.end(); } catch {}
                stream.ws.forEach(w => { try { w.end(); } catch {} });
                return;
              }
              const buf = Buffer.concat(bufs);
              if (buf.length <= LIST_CACHE_ITEM) {
                cacheSweep(listCache, LIST_CACHE_MAX, LIST_CACHE_BYTES);
                listCache.set(cacheKey, { ts: Date.now(), ttl: listTtl, status: ur.statusCode, headers: { ...ur.headers }, body: buf });
              }
              res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'miss' });
              res.end(buf);
              flushInflight(w => { w.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'shared' }); w.end(buf); });
            });
            ur.on('error', e => {
              if (stream) {
                try { res.destroy(); } catch {}
                stream.ws.forEach(w => { try { w.destroy(); } catch {} });
                return;
              }
              failUpstream(res, e.message, '列表上游中断'); flushInflight(w => failUpstream(w, e.message, '列表上游中断'));
            });
            return;
          }
          if (isTaskDetail) {
            const bufs = [];
            let total = 0, stream = null;
            const streamHead = () => ({ ...ur.headers, 'Cache-Control': 'no-store' });
            ur.on('data', c => {
              if (stream) {
                try { res.write(c); } catch {}
                stream.ws.forEach(w => { try { w.write(c); } catch {} });
                return;
              }
              total += c.length;
              if (total > DETAIL_CACHE_ITEM) {
                stream = { ws: waitersOf() };
                dropInflight();
                try { res.writeHead(ur.statusCode, streamHead()); } catch {}
                bufs.forEach(b => { try { res.write(b); } catch {} });
                try { res.write(c); } catch {}
                stream.ws.forEach(w => {
                  try {
                    w.writeHead(ur.statusCode, streamHead());
                    bufs.forEach(b => w.write(b));
                    w.write(c);
                  } catch {}
                });
                bufs.length = 0;
                return;
              }
              bufs.push(c);
            });
            ur.on('end', () => {
              if (stream) {
                try { res.end(); } catch {}
                stream.ws.forEach(w => { try { w.end(); } catch {} });
                return;
              }
              const buf = Buffer.concat(bufs);
              // 只在「已完成 + 已经有产出」时缓存：状态刚变 done 但产出还没写入的那种绝不能缓存，
              // 否则页面的「补轮询取产出」会一直拿到空产出。
              try {
                const d = JSON.parse(buf.toString('utf8'));
                const st = String((d && d.status) || '');
                const hasOut = !!(d && ((Array.isArray(d.outputs) && d.outputs.length) || d.output_url || (d.output && d.output.url) || d.url || d.download_url));
                if (ur.statusCode === 200 && hasOut && /succeed|fail|cancel|done/i.test(st) && buf.length <= DETAIL_CACHE_ITEM) {
                  cacheSweep(detailCache, DETAIL_CACHE_MAX, DETAIL_CACHE_BYTES);
                  detailCache.set(cacheKey, { ts: Date.now(), ttl: DETAIL_TTL, status: ur.statusCode, headers: { ...ur.headers }, body: buf });
                }
              } catch {}
              res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' });
              res.end(buf);
              flushInflight(w => { w.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' }); w.end(buf); });
            });
            ur.on('error', e => {
              if (stream) {
                try { res.destroy(); } catch {}
                stream.ws.forEach(w => { try { w.destroy(); } catch {} });
                return;
              }
              failUpstream(res, e.message, '详情上游中断'); flushInflight(w => failUpstream(w, e.message, '详情上游中断'));
            });
            return;
          }
          res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' });
          pipeUpstream(ur, res, relayTag);
          /* 上游没回 200（例如列表端点 5xx）：这一支不会进缓存，等着的那些别干等，
             给一个明确的失败让它们自己重试（挂死在这里是最坏的结果）。 */
          flushInflight(w => failUpstream(w, '上游返回 ' + ur.statusCode, relayTag));
        };
        const gate = relayGateOf(relayHit);
        /* 拿到名额才真打，`release` 就是这一个名额的归还钥匙（幂等，重复调只算第一次）。
           名额跟着**整串尝试**（一次原始请求 + 至多 RELAY_RETRY_MAX 次退避重问），只在最后一次那份
           响应读完 / 请求出错 / 客户端已经走了 时才还 —— 中途还掉等于「一边说在给人限流、
           一边把名额交给下一条」，闸形同没有。看门狗（RELAY_SLOT_MAX_MS）兜住所有没还上的那条路。 */
        const relayIssue = release => {
          let tries = 0;
          let netTries = 0;
          /* 连接级瞬时故障：复用池里一条已被对端关掉的 socket 时，TLS 层报的正是
             `Client network socket disconnected before secure TLS connection was established`；
             这类错误换一条**新连接**再问一次通常就好。只给 GET（读）重试一次，POST 绝不重发
             —— 没有幂等键的创建请求重发就是可能扣两次钱。证书错误不在名单里：重试不会变好。 */
          const transientNetErr = e => {
            const code = String((e && e.code) || '');
            const msg = String((e && e.message) || '');
            if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE'
              || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ENETUNREACH') return true;
            return /ECONNRESET|ECONNABORTED|EPIPE|socket hang up|Client network socket disconnected|TLS handshake timeout|socket disconnected before secure TLS/i.test(msg);
          };
          const once = fresh => {
            const up = upRequest(base + pathAndQuery, { ...relayOpts, fresh }, ur => {
              const wait = relayRetryWait(req.method, ur, tries);
              if (wait != null) {
                tries++;
                gate.退过++; noteRelayEvent(gate, '退避重试', String(ur.statusCode));
                log(`  → (${upHost}) 被限流 ${ur.statusCode}，${wait}ms 后重问（第 ${tries} 次，只有读请求会重问）`);
                ur.resume();          // 这一份响应要丢掉，socket 还得回池子里
                setTimeout(() => {
                  /* 退避这段时间里页面可能已经走了（切页 / 刷新 / 关掉标签）：再发就是一条没人认领的
                     请求，还白占着这一家的名额。判据与队列分支同一份 `alive()`。 */
                  if (!alive()) { release(); return; }
                  once(false);
                }, wait);
                return;
              }
              ur.once('close', release);
              relayRespond(ur);
            });
            // 创建任务：回完就把列表短缓存清掉，这样刚提交的任务立刻能在资产库（列表接口）里看到
            if (isCreatePost) {
              up.on('response', ur => ur.on('end', () => { listCache.clear(); log('[cache] 创建任务 → 清空列表缓存'); }));
            }
            /* 回给页面的那句要带**真正打出去的地址**：转发失败的原因（超时 / DNS / 拒绝连接）都只说现象，
               而「是不是打到我了那个网关」恰恰是用户此刻最想确认的 —— 尤其是自定义供应商（地址是用户自己填的）、
               以及内置平台被 x-up-base 换过地址的那几种情况。（主机名与这句文案都在上面的 relayTag 里点一次名） */
            up.on('error', e => {
              if (!fresh && req.method === 'GET' && netTries < 1 && !res.headersSent && transientNetErr(e)) {
                netTries++;
                noteRelayEvent(gate, '换连接重试', e.code || 'socket');
                log(`  → (${upHost}) 连接中断（${e.message}），换一条新连接重试一次`);
                once(true);
                return;
              }
              release(); log(`  → (${upHost}) error: ${e.message}`); failUpstream(res, e.message, relayTag); flushInflight(w => failUpstream(w, e.message, relayTag));
            });
            up.end(body);
          };
          once(false);
        };
        /* 排满就**当场回一句拒绝**，不挂在这条永远排不到头的队列上（静默等人排队，比拒了更坏）。
           等着同一份缓存的其它响应也要拿到同一句 429 —— 别让其中一条干等。 */
        /* 名额句柄：拿到之后**每一条出口**都要归还（响应 close / 请求 error / 处理链抛异常），
           而且要恰好一次 —— app.js 的 release 自身幂等，这里只负责「别忘了调」。 */
        let releaseSlot = null;
        /* 「这一条还值不值得发出去」：排队等名额的那段时间里页面可能已经走了（切页 / 刷新 / 关标签）。
           以前只有退避重试那一段判过（上面 setTimeout 里那句），**队列分支漏了同一道检查** ——
           批量生成把名额占满时用户刷一下页面，名额一释放就照样把创建 POST 打到平台：
           一次没人认领的付费任务，界面上永远看不到它。 */
        const alive = () => !(res.destroyed || res.writableEnded || req.aborted);
        /* 排队超时：连接还挂着，但已经等满了 RELAY_QUEUE_TIMEOUT_MS。
           回一句 429（与排满同一形状），并写明「没有发出去、没有扣费」，不许让它继续挂着。 */
        const inflightWaiters = () => (inflightMap ? (inflightMap.get(cacheKey) || []) : []);
        const timedOut = (g, ms) => {
          const say = '本地转发闸：' + g.name + ' 排队 ' + Math.round(ms / 1000) + ' 秒没轮到（这一条没有发出去，没有扣费）。'
            + '稍等再点一次就会轮到它；想放宽就在 .env 里改 RELAY_MAX_INFLIGHT / RELAY_QUEUE_MAX / RELAY_QUEUE_TIMEOUT_MS 并重启。';
          const ws = inflightWaiters();
          for (const w of [res].concat(ws)) {
            if (w.headersSent || w.writableEnded) continue;
            try {
              w.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
              w.end(JSON.stringify({ error: { message: say, code: 'relay_queue_timeout' } }));
            } catch {}
          }
          /* 排队超时这一条出口也必须摘掉在途表：发完 429 就 return，本请求再也不会走到
             那段「把结果写给等待者」。不摘的话条目一直留在表里（数组里全是不是已了结的响应），
             后来同 key 的请求在开头那句 `if (waiters) { waiters.push(res); return; }` 上挂进去，
             再也没有人 fulfill 它 —— 上游一次 504 就把这一个详情页钉死到代理重启。 */
          dropInflight();
        };
        if (!relayTake(gate, r => { releaseSlot = r; relayIssue(r); }, { alive, timedOut })) {
          relayRefused(res, gate);
          flushInflight(w => relayRefused(w, gate));
          return;
        }
      }).catch(e => {
        /* 处理链抛异常（拼请求头 / up.end 当场拒 / 缓存那一段）：以前只回等待者，
           **发起者一条响应都拿不到** —— 客户端挂到自家超时，名额还要等 5 分钟看门狗才收回。
           这里先把名额还掉（恰好一次），再回发起者，最后回等待者。 */
        const msg = (e && e.message) || String(e);
        log('[relay] 转发处理链异常：' + msg);
        if (releaseSlot) { const r = releaseSlot; releaseSlot = null; try { r(); } catch {} }
        failUpstream(res, msg, '上游');
        flushInflight(w => failUpstream(w, msg, '上游'));
      });
      return;
    }
    return false;
  }

  return { handleRelay };
}

module.exports = { createRelayRoutes };
