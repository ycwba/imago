'use strict';
/* 按平台的在途转发闸与退避重试：2026-10-20 从 server/app.js 原样搬出。
   五个 RELAY_* 数字仍由组合根的 envInt / envFrom 现读（.env 那一档口径不变），log 与 timeText 也从组合根注入；
   闸的账本只活在这一层，/sys-status 的「转发」那一格读的就是这里的 relayStatus()。 */
function createRelayGate(deps) {
  const { envInt, envFrom, log, timeText } = deps;

  /* ---------- 按平台的在途闸 + 只读请求的退避重试（plan 后端完善清单第 7 项，2026-10-16）----------
     以前所有出站只靠 `keepAliveAgent` 的 `maxSockets: 32` 兜着，那限的是「这个进程一共多少条 socket」，
     不是「同一家平台同时在打几条」：一次批量生成、或几个标签页同时刷列表，就能把同一家打到 429；
     而 429/503 过去原样透给页面 —— 界面上是一句「请求失败」，看不出是被人限了流、也看不出等一下就会好。
     四条立场：
     ① **闸按平台算，不按 relay 前缀算**（键取 `keyId`，一家同时做图片与视频时共用一把钥匙）。
        relay 前缀一家一段（v19 起，等价声明才允许共用，判据在 providers/validate.js）——
        以前八家文字 AI 共用 /textai，按前缀就把八家算成一家；现在前缀命中谁、闸就算谁的，
        最快的家不会被最慢的家拖住，「哪家被限了」恰恰是这一格要说清的那件事。
     ② **只数同时在途，不做假令牌桶**：本机是单人工具，速率该由上游判，我们要的只是「别把一家打爆」。
        排满就等，等不到上限就**当场 429 并把原因写清**（静默让人排队等到天荒地老，比拒了更坏）。
     ③ **名额必须恰好归还一次**：归还挂在响应的 `close`（缓冲读完 / pipe 结束 / 半路掐断三种出口都会走到）
        与请求的 `error` 上，再加一道看门狗。漏还一次 = 这一家永远关在闸外，**那比没有闸更坏**。
     ④ **退避重试只给 GET**：AGENTS.md §2 那条「没有幂等键的 POST 一律不自动重试」在这里照样成立 ——
        「请求已到、响应被限」与「响应超时」同样分不清任务到底建没建，重发就是重复建任务、重复扣费。
        被限过这件事要看得见：计数进 `/sys-status` 的「转发」，界面上那一行与复制文本都只读那一份说法。 */
  const RELAY_MAX_INFLIGHT = envInt('RELAY_MAX_INFLIGHT', 8, 1, 64);       // 同一家平台同时在打几条
  const RELAY_QUEUE_MAX = envInt('RELAY_QUEUE_MAX', 32, 0, 512);           // 同一家最多允许排几条，排满当场 429
  const RELAY_RETRY_MAX = envInt('RELAY_RETRY_MAX', 2, 0, 5);              // 被限流后最多再问几次（0 = 只问一次）
  const RELAY_WAIT_MAX_MS = envInt('RELAY_WAIT_MAX_MS', 15000, 500, 120000);   // Retry-After 的上限：等满那么久不如让页面自己决定
  const RELAY_QUEUE_TIMEOUT_MS = envInt('RELAY_QUEUE_TIMEOUT_MS', 30000, 1000, 300000);  // 排队等名额最多等多久，到点回 429
  const RELAY_SLOT_MAX_MS = 300000;               // 看门狗：一条转发最多占住一个名额这么久
  const RELAY_EVENTS_MAX = 6;                     // 最近几件（与故障账同一立场：有界，正在刷屏的那种不许把它变成第二份日志）
  /* 「被限过」的计数只代表**最近**：以前这些计数只增不减，一次 429 / 一次排队超时之后，
     「转发」那一格永远显示红 / 黄，用户分不清「现在还在被限」与「很久以前被限过一次」。
     窗口内没新事件的计数到点归零（读状态时顺手清，不是定时器）。 */
  const RELAY_COUNT_WINDOW_MS = 10 * 60 * 1000;   // 10 分钟内的事件才算「现在这一阵子」
  const relayGates = new Map();                   // 平台钥匙 → { name, inflight, queue, 退过, 等过, 拒过 }
  const relayEvents = [];                         // 最近几件「被限过」的事，新的在前
  function relayGateOf(p) {
    const key = String(p.keyId || p.id || '?');
    let g = relayGates.get(key);
    if (!g) { g = { key, name: String(p.name || p.id || key), inflight: 0, queue: [], 退过: 0, 等过: 0, 拒过: 0, 走掉: 0, 等超时: 0, lastAt: 0 }; relayGates.set(key, g); }
    return g;
  }
  function noteRelayEvent(g, 事, 码) {
    g.lastAt = Date.now();
    const head = relayEvents[0];
    if (head && head.平台 === g.name && head.事 === 事 && head.码 === 码) { head.重复++; head.at = Date.now(); return; }
    relayEvents.unshift({ at: Date.now(), 平台: g.name, 事, 码: 码 || '', 重复: 1 });
    if (relayEvents.length > RELAY_EVENTS_MAX) relayEvents.length = RELAY_EVENTS_MAX;
  }
  /* 窗口外且正闲着的计数归零：用户看的是「现在怎么样」，不是账本总账。
     正有在途 / 排队的闸不动（那一格本来就「正在用」）。 */
  function decayStaleCounters(g, now) {
    if (g.inflight || g.queue.length) return;
    if (!g.lastAt || now - g.lastAt < RELAY_COUNT_WINDOW_MS) return;
    g.退过 = 0; g.等过 = 0; g.拒过 = 0; g.走掉 = 0; g.等超时 = 0; g.lastAt = 0;
  }
  /* 取一个名额再打。`onSlot(release)` 只在拿到名额那一刻调一次；`release` 幂等，重复调只算第一次。
     返回 false = 这一家此刻已经排满了，调用方必须**当场回一句拒绝**，不许把请求挂在一条永远发不出去的队列上。
     `opts.alive()`（这一条还值不值得发出去）与 `opts.timedOut(g, ms)`（排队等超时了，回发起者一句 429）
     都由调用方给：排队期间页面可能已经走了（切页 / 刷新 / 关标签），名额一释放还照发就是一条
     **没人认领的创建请求** —— 平台建了任务、可能计费，界面上永远看不见它（踩过：批量生成占满名额时最准）。
     等名额也不能无限等：排队超过 RELAY_QUEUE_TIMEOUT_MS 就把这一条从队里摘掉并明确回一句 429，
     而不是让客户端挂到自己那侧的超时。 */
  function relayTake(g, onSlot, opts) {
    const o = opts || {};
    if (g.inflight >= RELAY_MAX_INFLIGHT && g.queue.length >= RELAY_QUEUE_MAX) {
      g.拒过++; noteRelayEvent(g, '排满拒了', '429');
      return false;
    }
    let timer = null, qTimer = null, released = false;
    const pump = () => { const nxt = g.queue.shift(); if (nxt) nxt(); };
    const release = () => {
      if (released) return;
      released = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (qTimer) { clearTimeout(qTimer); qTimer = null; }
      g.inflight--;
      pump();
    };
    const start = () => {
      if (start.已了结) return;                       // 排队超时已经处理过这一条
      if (o.alive && !o.alive()) {                  // 客户端走了：不占名额、不发请求，把位子让给下一条
        start.已了结 = true;
        if (qTimer) { clearTimeout(qTimer); qTimer = null; }
        g.走掉++; noteRelayEvent(g, '排队时客户端已走', '');
        pump();
        return;
      }
      start.已了结 = true;
      if (qTimer) { clearTimeout(qTimer); qTimer = null; }
      g.inflight++;
      timer = setTimeout(() => {
        log(`[relay] ${g.name} 一个名额占满 ${Math.round(RELAY_SLOT_MAX_MS / 1000)} 秒还没归还，强制收回（这一条响应可能半路断了）`);
        release();
      }, RELAY_SLOT_MAX_MS);
      onSlot(release);
    };
    /* 排队到点还没轮到：把它从队里摘掉（不占名额、不发请求），并回发起者一句 429。
       摘不到就是已经出队了（正在起跑或已经占住名额），不用管。 */
    const expire = () => {
      if (start.已了结) return;
      const i = g.queue.indexOf(start);
      if (i < 0) return;
      g.queue.splice(i, 1);
      start.已了结 = true;
      g.等超时++; noteRelayEvent(g, '排队超时', '429');
      log(`[relay] ${g.name} 排队超过 ${Math.round(RELAY_QUEUE_TIMEOUT_MS / 1000)} 秒没轮到，回 429（这一条没有发出去）`);
      if (o.timedOut) o.timedOut(g, RELAY_QUEUE_TIMEOUT_MS);
    };
    if (g.inflight < RELAY_MAX_INFLIGHT) { start(); return true; }
    g.等过++; noteRelayEvent(g, '排队等名额', '');
    start.已了结 = false;
    g.queue.push(start);
    qTimer = setTimeout(expire, RELAY_QUEUE_TIMEOUT_MS);
    if (qTimer.unref) qTimer.unref();          // 排队超时不该成为进程不肯退出的理由
    return true;
  }
  /* 「这一份响应要不要等一会儿再问一次」：只认 GET、只认 429/503、只认还没试过上限。
     `Retry-After` 认秒数也认 HTTP-date（两家网关都给过），超过 RELAY_WAIT_MAX_MS 就不等 ——
     等五分钟与现在就告诉用户「这一家正在限流」，后者更有用。没给就按次数退避 1s / 2s / 4s。 */
  function relayRetryWait(method, ur, tries) {
    if (method !== 'GET' || tries >= RELAY_RETRY_MAX) return null;
    if (ur.statusCode !== 429 && ur.statusCode !== 503) return null;
    const raw = String((ur.headers && ur.headers['retry-after']) || '').trim();
    let ms = null;
    if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
    else if (raw) { const t = Date.parse(raw); if (!Number.isNaN(t)) ms = t - Date.now(); }
    if (ms == null) ms = 1000 * Math.pow(2, tries);
    if (ms > RELAY_WAIT_MAX_MS) return null;
    return Math.max(200, Math.round(ms));
  }
  /* 「转发这一族现在到底在怎么打」每次现算（与「渲染」「健康」同一立场：缓存期间名额会被占掉又还回来）。
     芯片与整句都在这儿拼，页面只按 `档` 上色 —— 三处说法（复制文本 / 设置页那一行 / 助手 doctor）读同一份。 */
  function relayStatus() {
    const now = Date.now();
    relayGates.forEach(g => decayStaleCounters(g, now));
    const hot = [];
    relayGates.forEach(g => { if (g.inflight || g.queue.length || g.退过 || g.等过 || g.拒过 || g.走掉 || g.等超时) hot.push(g); });
    hot.sort((a, b) => (b.拒过 * 1000 + b.退过 * 10 + b.inflight) - (a.拒过 * 1000 + a.退过 * 10 + a.inflight));
    let nBack = 0, nWait = 0, nRef = 0, nGone = 0, nExp = 0;
    relayGates.forEach(g => { nBack += g.退过; nWait += g.等过; nRef += g.拒过; nGone += g.走掉; nExp += g.等超时; });
    let chip, cls;
    if (nRef || nExp) { cls = 'err'; chip = '拒过 ' + (nRef + nExp) + ' 条'; }
    else if (nBack || nWait) { cls = 'warn'; chip = '退避 ' + nBack + ' 次 · 排队 ' + nWait + ' 次'; }
    else { cls = 'ok'; chip = '没被限过'; }
    const 明细 = hot.slice(0, 6).map(g => ({
      平台: g.name, 在途: g.inflight, 排队: g.queue.length, 退过: g.退过, 等过: g.等过, 拒过: g.拒过,
      走掉: g.走掉, 等超时: g.等超时,
    }));
    const 最近 = relayEvents.map(x => ({
      时候: timeText(new Date(x.at)), 平台: x.平台, 事: x.事 + (x.码 ? '（' + x.码 + '）' : ''), 重复: x.重复,
    }));
    const say = (cls === 'ok'
      ? '没有一家平台被打到限流过。同时在途每家最多 ' + RELAY_MAX_INFLIGHT + ' 条、排队上限 ' + RELAY_QUEUE_MAX + ' 条、'
        + '排队最多等 ' + Math.round(RELAY_QUEUE_TIMEOUT_MS / 1000) + ' 秒；'
        + '被限流时读请求会按 Retry-After 等一会儿再问一次，写请求一次都不重发（重发就是重复建任务、重复扣费）。'
      : '有平台被限流过：退避重试 ' + nBack + ' 次、排队等名额 ' + nWait + ' 次'
        + (nRef ? '、排满之后直接拒了 ' + nRef + ' 条' : '')
        + (nExp ? '、排队超过 ' + Math.round(RELAY_QUEUE_TIMEOUT_MS / 1000) + ' 秒拒了 ' + nExp + ' 条' : '')
        + (nGone ? '、排队期间客户端走了 ' + nGone + ' 条（这几条没有发出去）' : '') + '。'
        + '拒掉那几条是这个代理自己回的 429（不是平台说的），原因是同一家同时在打的请求已经排满；'
        + '要放宽就在 .env 里改那五个数并重启。')
      + '（同时在途 ' + RELAY_MAX_INFLIGHT + ' · 排队上限 ' + RELAY_QUEUE_MAX + ' · 重试 ' + RELAY_RETRY_MAX
      + ' 次 · 等名额最多 ' + Math.round(RELAY_WAIT_MAX_MS / 1000) + ' 秒 · 排队最多 ' + Math.round(RELAY_QUEUE_TIMEOUT_MS / 1000) + ' 秒）';
    return {
      档: cls, 芯片: chip, 说明: say,
      同时在途: RELAY_MAX_INFLIGHT, 排队上限: RELAY_QUEUE_MAX, 重试上限: RELAY_RETRY_MAX,
      最多等秒: Math.round(RELAY_WAIT_MAX_MS / 1000), 排队上限秒: Math.round(RELAY_QUEUE_TIMEOUT_MS / 1000),
      明细, 最近,
      来源: 'RELAY_MAX_INFLIGHT ' + envFrom('RELAY_MAX_INFLIGHT') + ' · RELAY_QUEUE_MAX ' + envFrom('RELAY_QUEUE_MAX')
        + ' · RELAY_RETRY_MAX ' + envFrom('RELAY_RETRY_MAX') + ' · RELAY_WAIT_MAX_MS ' + envFrom('RELAY_WAIT_MAX_MS')
        + ' · RELAY_QUEUE_TIMEOUT_MS ' + envFrom('RELAY_QUEUE_TIMEOUT_MS')
        + '（都写在 .env 里，改完要重启）',
    };
  }
  /* 队列排满时回给页面的那一句：形状与上游的 OpenAI 式错误一致（`error.message`），
     页面那套读数不用为这一种 429 特判；`Retry-After: 1` 与「稍后再点一次」是同一句话。 */
  function relayRefused(res, g) {
    if (res.headersSent) return;
    res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { message: '本地转发闸：' + g.name + ' 同时在途 ' + RELAY_MAX_INFLIGHT
      + ' 条、排队 ' + RELAY_QUEUE_MAX + ' 条已经排满，这一条没有发出去（没有扣费）。'
      + '稍等几秒再点一次就会轮到它；想放宽就在 .env 里改 RELAY_MAX_INFLIGHT / RELAY_QUEUE_MAX 并重启。',
      code: 'relay_queue_full' } }));
  }
  return {
    RELAY_MAX_INFLIGHT, RELAY_QUEUE_MAX, RELAY_RETRY_MAX, RELAY_WAIT_MAX_MS,
    RELAY_QUEUE_TIMEOUT_MS, RELAY_SLOT_MAX_MS, relayGates, relayEvents,
    relayGateOf, noteRelayEvent, relayTake, relayRetryWait,
    relayStatus, relayRefused,
  };
}

module.exports = { createRelayGate };
