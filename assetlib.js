/* 资产库共享模块：统一拉取与归一化各平台生成内容
   —— 接口调用全部「注册路由驱动」：端点 / 分页 / 字段映射 / 媒体类型 / 创建体 / 余额解析
      都读 /registry 的声明（见 proxy.js 的 REGISTRY 里 list / create / balance）。
      新接入一个平台 = 只在 REGISTRY 里加一条，本文件与各页面都不用改。
   条目：{ kind:'asset'|'task', id, genId?, type('图片'|'视频'), providerName, provider,
          format, prompt, src, dl, ts, status('done'|'running'|'queued'|'failed'), duration?, size? } */

/* ----------------------------------------------------------------------------
   签名外链：过期判定 + 会话内回源（全站唯一一份实现）
   平台产物多是对象存储的**签名地址**（VGENV 的 OSS 链接实测只管一天）。这种地址一旦被
   存进本机记录（收藏、导演台工作区里的候选镜头），第二天它必然 403，而界面上只会表现为
   「这条视频的缩略图永远加载不出来、点开只报一句 Format error」，真实原因（换个签名地址
   就好）完全看不出来。所以判定和回源都必须只有一份，放在媒体地址的出口上：
     · mediaExpired(u)  只看地址里的 Expires，不发请求 —— 首屏判定是免费的
     · healMedia(recs)  按 (provider, 任务号) 批量回源（一次列表请求解出一批），换到的新鲜
                        地址按**素材身份**（host + path，签名参数已剥）记进内存表
     · mediaSrc(u)      顺手查这张内存表 —— 页面一行都不用改：播放器、缩略图抽帧、灯箱、
                        下载链接全部跟着换成新鲜地址
   本模块不碰任何页面的数据：落盘写回由调用方在 onFresh 回调里做（收藏写 fav_items、
   导演台写 workspace），换回来的地址下次开机直接能用，不必每回都吃一轮 403。

   注意：这些必须定义在**模块作用域**（而不是某个 IIFE 里）——
   以前 mediaSrc 只写在 Api 闭包内，而 normalize()（AssetLib 闭包）与 Fav 里都是裸调用，
   于是那几处一执行就抛 ReferenceError：VGENV 的每条列表数据在归一化时全挂
   （被 Promise.allSettled 静默吞掉 → 界面上 VGENV 任务永远不出现），收藏资产也一并坏掉。
   Api.mediaSrc 仍然对外暴露同一个实现（页面统一用 Api.mediaSrc）。 */
/* 内层地址里「每次签名都会变」的参数：剥掉它们，同一份素材才认得出是同一份
   （缓存键、回源结果、去重全靠这个身份；其余 query 保留并排序 —— 有的平台把区分素材的
   id 放在 query 里，只留 host+path 会让不同素材撞成同一个）。 */
const VOLATILE_Q = /^(expires|signature|ossaccesskeyid|x-oss-[a-z-]+|key-pair-id|x-amz-[a-z0-9-]+|auth_key|policy|token|nonce|cachebust|r|v)$/i;
/* /getv?url=<内层> 与 /fetch?url=<内层>&dl=1 都包着签名外链，取内层时两种都认。 */
function innerMedia(u) {
  const s = String(u == null ? '' : u);
  if (!s) return '';
  const m = /^\/(?:getv|fetch)\?[^#]*?\burl=([^&]+)/i.exec(s);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  return /^https?:\/\//i.test(s) ? s : '';
}
/* 素材身份：内外层地址都算得出来，签名换了它不变。 */
function mediaKey(u) {
  const inner = innerMedia(u);
  if (!inner) return '';
  try {
    const x = new URL(inner, location.href);
    const keep = [...x.searchParams.entries()]
      .filter(([k]) => !VOLATILE_Q.test(k))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => k + '=' + v);
    return x.host + x.pathname + (keep.length ? '?' + keep.join('&') : '');
  } catch (e) { return inner; }
}
/* 签名过期时刻（毫秒）：读不到过期参数就返回 0（本地 /asset/<id>、平台长期地址都不该反复回源）。 */
function signedExpiry(u) {
  const inner = innerMedia(u);
  if (!inner) return 0;
  try {
    const x = new URL(inner, location.href);
    const e = Number(x.searchParams.get('Expires') || x.searchParams.get('expires')
      || x.searchParams.get('x-oss-expires') || 0);
    if (!e || !isFinite(e)) return 0;
    return e < 1e11 ? e * 1000 : e;
  } catch (e) { return 0; }
}
/* 快过期的也算过期：抽帧/下载动辄几秒，卡在边界上取到一半失效更难查。 */
function mediaExpired(u) { const exp = signedExpiry(u); return !!exp && exp <= Date.now() + 60000; }

/* ---------- 上游状态串 → 四档标准状态（done / queued / running / failed）----------
   **全项目只有这一份判据**：轮询（Api.parseItem）与列表（AssetLib 的 normalize）都调它。
   以前两边各判一次、口径还不一样 —— normalize 只认 'queued' / 'running' 两个词是活的，
   其余一律当失败；而平台真的会回 creating / pending / processing / synthesizing
   （workbench.js 的 Wb.ST 里就列着这几个）。后果正是「任务由生成中变成已完成时先显示失败」：
   还在跑的那一轮列表刷新把它算成 failed，而它又不在轮询集合里（判据同样只认两个词），
   于是卡片停在失败上不动，要等用户手动刷新（那时已经 succeeded）才变回已完成。
   规则：① registry 的 statusMap 明确映射过 → 照它；② 常见的成功 / 排队措辞直接认；
   ③ 状态串本身是失败词根 → failed；④ 其余（认不出的）→ 活的，继续等。
   宁可多等一轮，也不能把在跑的说成失败 —— 说成失败用户就会去重试，那是重复扣费。 */
const ST_DONE_RE = /^(done|succeeded|succeed|success|successful|completed|complete|finished|ready)$/i;
const ST_QUEUE_RE = /^(queued|queue|queuing|pending|waiting|scheduled)$/i;
const ST_FAIL_RE = /(fail|error|cancel|abort|reject|expire|invalid)/i;
function classifyStatus(spec, rawStatus) {
  const raw = String(rawStatus == null ? '' : rawStatus).trim();
  if (!raw) return 'running';                       // 没给状态 = 还不知道，接着等
  const declared = ((spec && spec.statusMap) || {})[raw];
  const mapped = String(declared || raw);
  if (mapped === 'done' || ST_DONE_RE.test(mapped)) return 'done';
  if (mapped === 'queued' || ST_QUEUE_RE.test(mapped)) return 'queued';
  if (mapped === 'running') return 'running';
  /* 平台在 statusMap 里明确把它映射成了别的（例如 canceled → cancelled）→ 认它是终局失败；
     没声明过、又不带失败词根的陌生状态 → 当作还在跑。 */
  if (declared || ST_FAIL_RE.test(raw)) return 'failed';
  return 'running';
}
const FRESH = new Map();      // 素材身份 → 本次会话换回的新鲜地址
const FRESHING = new Set();   // 在途的素材身份：并发批量回源不重复问同一份素材
/* 换地址时保留调用方原本的包装形式（/fetch?url=…&dl=1 的下载语义不能丢）。 */
function rewrapMedia(old, fresh) {
  if (!fresh) return old;
  const inner = innerMedia(fresh) || fresh;
  if (/^\/fetch\?/i.test(old)) return '/fetch?url=' + encodeURIComponent(inner) + (/dl=1/i.test(old) ? '&dl=1' : '');
  if (/^\/getv\?/i.test(old)) return '/getv?url=' + encodeURIComponent(inner);
  return mediaSrc(fresh);
}
function mediaSrc(url) {
  const u = String(url == null ? '' : url);
  if (!u) return '';
  /* 外链统一改走本地代理：页面里的 <img>/<video>/fetch 只碰本地地址，字节由代理取回
     （/getv 支持 Range，播放、抽帧、量体积、下载都能用），所以「所有外部访问都经过本地路由」
     这条规则没有例外，也不会因为上游没给 CORS 头而抽不出帧。 */
  const out = /^https?:\/\//i.test(u) ? '/getv?url=' + encodeURIComponent(u) : u;
  if (!mediaExpired(out)) return out;
  /* 过期地址先查会话内回源结果：只查内存表、不发请求，所以不拖首屏；
     还没换到就把旧的给出去（让画面先出来，回源在后台跑）。 */
  return rewrapMedia(out, FRESH.get(mediaKey(out)));
}
/* 一批记录换新鲜地址：rec = { provider, id|genId|assetId, url|src }（多余的字段原样留着，
   调用方靠 onFresh(rec, 新地址, 旧地址) 把它写回自己的存储）。
   按平台分组走 Api.pollMany —— 声明了 pollVia:'list' 的平台（VGENV）一次列表请求就解出
   整批；逐条问的话 N 条就是 N 次「100 条的列表」（实测 2.4 秒/次），上游被打爆、请求互相排队。
   返回真换到的条数。 */
async function healMedia(recs, opts) {
  const limit = (opts && opts.limit) || 40;
  const onFresh = opts && opts.onFresh;
  if (window.Api && Api.registry) await Api.registry().catch(() => {});   // 注册表有 60 秒缓存，不重复发包
  const stale = [], seen = new Set();
  for (const rec of (recs || [])) {
    const url = String((rec && (rec.url || rec.src)) || '');
    const id = String((rec && (rec.id || rec.genId || rec.assetId)) || '');
    if (!rec || !rec.provider || !url || !id || !mediaExpired(url)) continue;
    const key = mediaKey(url);
    if (!key || seen.has(key) || FRESHING.has(key)) continue;
    const hit = FRESH.get(key);
    if (hit) { if (onFresh) { try { onFresh(rec, hit, url); } catch (e) {} } continue; }
    seen.add(key);
    FRESHING.add(key);
    stale.push({ rec, url, id, key });
    if (stale.length >= limit) break;
  }
  let done = 0;
  const byProv = new Map();
  for (const s of stale) {
    const prov = window.Api && Api.prov ? Api.prov(s.rec.provider) : null;
    if (!prov) { FRESHING.delete(s.key); continue; }
    if (!byProv.has(prov)) byProv.set(prov, []);
    byProv.get(prov).push(s);
  }
  for (const [prov, items] of byProv) {
    let got = null;
    try { got = await Api.pollMany(prov, items.map(x => x.id)); } catch (e) {}   // 整批失败：留着下次再换
    for (const x of items) {
      FRESHING.delete(x.key);
      const p = got && got.get(x.id) && got.get(x.id).p;
      /* 只换回同类地址：接口没给外链就不动（别拿资产号拼 /asset/<id> —— 那条本地路由只服务
         本工作台自己落盘的产物，别平台的资产号进去就是 404 破图）。 */
      const next = p && p.done && p.url ? mediaSrc(p.url) : '';
      if (!next || next === x.url) continue;
      FRESH.set(x.key, next);
      if (FRESH.size > 500) FRESH.delete(FRESH.keys().next().value);
      done++;
      if (onFresh) { try { onFresh(x.rec, next, x.url); } catch (e) {} }
    }
  }
  for (const x of stale) FRESHING.delete(x.key);
  return done;
}
/* 统一取数出口：优先走 ui.js 的 Net（带超时、退避重试、可读错误文案）；
   没有 Net（极少见）时退回原生 fetch。
   —— 页面与模块里的每一次取数都应该走它：裸 fetch 没有超时，
   上游挂起时请求会永久挂着（按钮一直转、状态永远不变），错误文案也是原始英文。 */
function netFetch(url, opts) {
  return (window.Net && window.Net.fetch) ? window.Net.fetch(url, opts) : fetch(url, opts);
}

/* 读 OpenAI 风格的 SSE 流（文字 AI 的 stream:true）：一帧 `data: {json}`，收尾一帧 `data: [DONE]`。
   onDelta(片段, 种类) 按到达顺序回调，种类是 'content'（正文）或 'reasoning'（模型的思考过程）。
   返回 { text, reasoning, usage, done }；usage 取流里最后带的那一帧（要请求体带 stream_options 才有）。
   放在模块作用域、由 TextAI 调用：闭包里定义的函数跨闭包裸调会直接 ReferenceError（见 AGENTS.md §3）。 */
async function readSseStream(res, onDelta) {
  const out = { text: '', reasoning: '', usage: null, done: false };
  const feed = frame => {
    const s = String(frame || '').trim();
    if (!s.startsWith('data:')) return;          // event:/id:/`: 心跳` 都不是内容
    const body = s.slice(5).trim();
    if (body === '[DONE]') { out.done = true; return; }
    let d = null;
    try { d = JSON.parse(body); } catch { return; }
    if (d && d.usage) out.usage = d.usage;
    const err = d && d.error && (d.error.message || d.error.code || d.error);
    if (err) throw new Error(String(err));       // 流中途上游报错：让调用方拿到原因，别当成「说完了」
    const ch = (d && d.choices && d.choices[0]) || {};
    const delta = ch.delta || ch.message || {};
    const rc = delta.reasoning_content || delta.reasoning;
    if (rc) { out.reasoning += String(rc); if (onDelta) onDelta(String(rc), 'reasoning'); }
    const c = delta.content;
    if (c) { out.text += String(c); if (onDelta) onDelta(String(c), 'content'); }
  };
  const split = buf => {
    /* SSE 的一条帧以空行结尾，但按行切就够：帧里的 JSON 不会带裸换行 */
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
    return buf;
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = split(buf + dec.decode(value, { stream: true }));
    }
    feed(buf);
  } else {
    String(await res.text()).split('\n').forEach(feed);
  }
  return out;
}

/* ============================================================================
   Api —— 统一接口层（全站唯一出口）
     Api.setRegistry(REG) / Api.registry()      注册表（页面已有的 REG 传进来即可，避免重复请求）
     Api.prov(id|keyId|kind|relay)              找平台
     Api.key(prov) / Api.keyId(prov)            密钥（keyId 由 registry 声明，兼容早期别名）
     Api.request(prov, 'create'|'poll'|'list'…) 按端点名拼 URL 并请求（自动带密钥、错误可读）
     Api.create(prov, fields)                   按 registry 的 create 声明拼请求体
     Api.cancel(prov, id) / Api.detail(prov, id)
     Api.balance(prov, raw)                     按 balance.style 解析余额
     Api.listSources()                          按 relay+list 去重后的列表来源
     Api.mediaSrc / mediaKey / mediaExpired     媒体地址：外链→本地路由、素材身份、签名是否过期
     Api.healMedia(recs, {onFresh})             一批过期签名地址批量回源换新（页面不用自己判过期）
   ========================================================================== */
(function () {
  let _reg = null;
  let _regTs = 0;
  let _regErr = '';                 // 上一次取注册表失败的原因（空串 = 取到了）
  const REG_TTL = 60 * 1000;        // 注册表缓存 1 分钟：代理加了平台，刷新页面就能看到
  let _env = null;                  // /env-status 的缓存（只含「有没有」+ 尾号，60 秒一份）
  let _envTs = 0;
  let _envOk = false;               // 上一次 /env-status 真的取到了吗（`{}` 与「取失败」靠它区分，见 envKnown）

  /* 跑着的 proxy.js 比这份页面代码旧 → 一次说清，别让「某个选项没出现」变成猜谜。
     （旧代理的能力声明停在老样子：例如生图的输出格式还被 forceOptions 锁成 png，
       界面就整块不显示，看着像功能坏了，其实重启一次就好了。每个标签页只提醒一次。） */
  const PROXY_VERSION_MIN = 11;
  /* 文案单独做成纯函数：好单测（页面里那条提示本身没什么分支，值不值得测的是这句话写没写清楚）。 */
  function oldProxyNotice(version) {
    const v = Number(version || 0);
    if (!v || v >= PROXY_VERSION_MIN) return '';
    return '本地代理是旧版（v' + v + '，这一版页面要 v' + PROXY_VERSION_MIN + '）：部分能力声明不会生效'
      + '（最明显的是设置页「添加自定义供应商」登记的那几家——旧代理不读 .data/sk_custom.json，'
      + '各工作台的型号下拉里根本不会出现那一家；文字 AI 那一类在旧代理上也会被当成「找不到模板」丢掉）。'
      + '请重启 proxy.js（启动.bat → 2 停止 → 1 启动）后刷新页面。';
  }
  function warnOldProxy(reg) {
    const msg = oldProxyNotice(reg && reg.version);
    if (!msg) return;
    let said = false;
    try { said = sessionStorage.getItem('sk_old_proxy_notice') === '1'; } catch (e) {}
    if (said) return;
    try { sessionStorage.setItem('sk_old_proxy_notice', '1'); } catch (e) {}
    if (window.Toast) Toast.warn(msg, 9000);
    else console.warn('[Api] ' + msg);
  }
  /* 本地代理**压根没连上**（注册表一条也没取到）—— 与 warnOldProxy 分开说：
     那一个是「连上了但版本太旧，要重启」，这一个要先「把它启动起来」，处理办法不一样。
     同样每个标签页只提醒一次（sessionStorage 当场记），提示走同一条路。
     这里只报一次**不够**：Toast 会消失，而这一页要靠它的地方（型号下拉、
     「这一家配没配密钥」、能力上限）会**一直**是错的 —— 所以页面还要靠
     regFailed() 自己画一条不会消失的提示。 */
  function warnProxyDown(reg) {
    if (reg && (reg.providers || []).length) return;
    let said = false;
    try { said = sessionStorage.getItem('sk_proxy_down_notice') === '1'; } catch (e) {}
    if (said) return;
    try { sessionStorage.setItem('sk_proxy_down_notice', '1'); } catch (e) {}
    const msg = '本地代理没连上（或还没启动）：注册表一条也没读到。'
      + '在它起来之前，这一页所有「有没有配密钥」「能出几张」「这个型号支持什么」都是错的 ——'
      + '比如语音那一栏会说「还没配语音接口」，而密钥可能好好地写在 .env 里。'
      + '把它启动起来（启动.bat → 1，或 node proxy.js）再刷新这一页。';
    if (window.Toast) Toast.warn(msg, 12000);
    else console.warn('[Api] ' + msg);
  }

  /* ---------- 本机环境（/sys-status）：一份取法、一份说法 ----------
     三个地方问的是同一件事：设置页「本机环境」那一栏、拍短剧导出前的闸门、助手的 doctor。
     各写一遍就会出现「设置页说能用、助手说不能用」，探测参数也会走样 ——
     它要在本机起子进程跑 ffmpeg -version，慢机器上几秒不够，而且**不许重试**（同一次体检打两遍）。 */
  const SYS_WHY = {
    ffmpeg: '拍短剧导出成片、烧字幕、把配音和配乐混进视频都靠它；没有它前面几步照常能走，到「导出」才拦',
    ffprobe: '量每段视频的真实秒数（字幕与配音按它排）；没有它成片时间会漂',
  };
  function sysStatus(fresh) {
    return window.Net.json('/sys-status' + (fresh ? '?fresh=1' : ''), { timeout: 20000, retry: 0 });
  }
  /* 一个探测项 → {芯片, 原因, cls}。「没读到」是黄的而不是红的：旧代理根本没这个接口，
     标成「坏了」会把人引去重装一个本来就装好的东西。 */
  function sysTool(t, name) {
    if (!t) return { name: name, chip: '没读到', why: '', cls: 'warn' };
    if (t.ok) return { name: name, chip: '能用', why: t.版本 || '', cls: 'ok' };
    return { name: name, chip: '不能用', why: t.why || '代理没说原因', cls: 'err' };
  }
  /* 目录：芯片只留「可写 / 还没建 / 写不进去」，括号里的原因单独给 —— 同一件事不要连着说两遍 */
  function sysDir(d) {
    const s = String((d && d.状态) || '');
    /* 「没读到」与「写不进去」不是一回事：前者多半是旧代理没返回这一项，标红了人去找磁盘权限 */
    if (!s) return { chip: '没读到', why: '', cls: 'warn', path: (d && d.路径) || '' };
    const short = s.split('（')[0];
    const why = s.length > short.length ? s.slice(short.length).replace(/^（/, '').replace(/）$/, '') : '';
    return { chip: short || '没读到', why: why,
      cls: s.indexOf('可写') >= 0 ? 'ok' : (s.indexOf('还没建') >= 0 ? 'warn' : 'err'),
      path: (d && d.路径) || '' };
  }
  /* 整份体检 → 给人看的几行（设置页复制出去、助手 doctor 念的都是这几行） */
  function sysStatusLines(s) {
    if (!s) return ['本机环境：没读到（代理没在运行，或者它是加 /sys-status 之前启动的旧版）'];
    const p = s.代理 || {}, dirs = s.目录 || {}, out = [];
    out.push('本地代理：注册表 v' + (p.版本 || '?') + ' · 端口 ' + (p.端口 || '?')
      + ' · Node ' + (p.进程 || '?') + ' · 目录 ' + (p.目录 || '?'));
    ['ffmpeg', 'ffprobe'].forEach(k => {
      const t = sysTool(s[k], k);
      out.push(k + '：' + t.chip + (t.why ? (t.cls === 'ok' ? '（' + t.why + '）' : '：' + t.why) : '')
        + ' —— ' + SYS_WHY[k]);
    });
    [['数据', '数据目录（.data）'], ['资产', '本机资产目录'], ['渲染', '成片目录']].forEach(pair => {
      const d = sysDir(dirs[pair[0]]);
      out.push(pair[1] + '：' + d.chip + (d.why ? '（' + d.why + '）' : '') + ' —— ' + (d.path || '?'));
    });
    return out;
  }

  /* 错误详情：上游（SparkCine 等）把「哪个字段不对」放在 error.details.issues 里，
     但顶层 message 往往只是一句「部分内容需要检查。」——只显示它等于没说。这里把 issues 拼成人话。 */
  const ISSUE_ZH = { too_small: '太短/太小', too_big: '太长/太大', invalid_type: '类型不对',
    invalid_value: '取值不在允许范围内', invalid_enum_value: '取值不在允许范围内',
    invalid_format: '格式不对', invalid_string: '格式不对', above_maximum: '超过上限',
    below_minimum: '低于下限', unrecognized_keys: '包含多余字段', not_multiple_of: '不是允许的倍数' };
  function describeIssue(it) {
    if (!it) return '';
    if (typeof it === 'string') return it;
    const raw = String(it.message || '');
    const zh = ISSUE_ZH[it.code] || '';
    const num = /expected string to have >=(\d+)/.exec(raw) ? '至少 ' + RegExp.$1 + ' 个字符'
      : /at most (\d+)/.exec(raw) ? '最多 ' + RegExp.$1
      : /at least (\d+)/.exec(raw) ? '至少 ' + RegExp.$1
      : /Invalid UUID/i.test(raw) ? '不是合法的 asset id（UUID）' : '';
    const part = [zh, num].filter(Boolean).join('，') || raw || it.code || '';
    const path = it.path || it.key || '';
    return (path ? path + '：' : '') + part;
  }
  /* 上游有些错误只有一句泛化提示（没有字段级 details），这里补一句能落地的解释。
     顺序有意义：越具体的放前面。 */
  const ERROR_HINT = [
    [/PROMPT_COMPILER|PROMPT_OPTIMI|prompt compiler/i, '平台的「提示词编译/优化」服务这次出错了（VGENV 侧，间歇性）——「这条任务没有创建、没有扣费」，稍后重试即可（本页会自动重试一次）'],
    [/需要检查|需人工|under review/i, '平台这次把提交拦下来了（上游只回这一句，实测是间歇性的：同一句提示词过一会儿就能过）——隔几十秒再来一次通常就好'],
    [/余额不足|insufficient|quota|not enough/i, '平台账户余额/额度不够，先到「用量与余额」页看看余额'],
    [/rate limit|too many|频繁|429/i, '请求太频繁，等几十秒再试'],
    [/unauthorized|invalid.*(api|token|key)|401/i, '密钥无效或过期：到「设置」重新填这个平台的密钥（或在 .env 里更新）'],
    [/forbidden|403|permission/i, '这个密钥没有调用该接口的权限（可能是账号未开通 / 权限范围不对）'],
    [/not found|unknown model|does not exist|404/i, '接口或资源不存在：模型可能已被平台下线，任务可能已过期/被清理 —— 换一个模型，或刷新列表看看'],
    [/too large|payload|413|文件过大/i, '素材太大：压缩后再传（视频/音频建议压到几十 MB 以内）'],
    [/unsupported|not support|不支持/i, '平台不支持这次请求的参数组合：换一个参数（分辨率 / 时长 / 比例）再试'],
    [/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i, '与平台的连接中断（网络抖动）：稍后重试；若是大素材上传，先确认网络稳定'],
  ];
  /* 上游「泛化校验失败」：只有一句 message、没有字段级 issues —— 实测是间歇性的（同一请求稍后就能过），
     界面会据此提示「隔一会儿再试」；但**不自动重试**（重试会连发请求、把平台限流顶得更死）。 */
  const isTransient = err => err && err.status === 400 && /VALIDATION_FAILED/i.test(err.code || '') && !(err.issues || []).length;
  function errorMessage(d, status) {
    const e = (d && d.error) || {};
    const issues = (e.details && Array.isArray(e.details.issues)) ? e.details.issues
      : (Array.isArray(e.issues) ? e.issues : []);
    const base = e.message || e.code || (d && (d.message || d.code)) || ('HTTP ' + status);
    const detail = issues.map(describeIssue).filter(Boolean).join('；');
    const hint = (ERROR_HINT.find(([re]) => re.test(base)) || [])[1] || '';
    // 有字段级明细就用明细；没有明细（上游只给了一句泛化提示）就补人能看懂的下一步
    if (detail) return base + '（' + detail + '）';
    return hint ? base.replace(/[。.]+$/, '') + '：' + hint : base;
  }
  /* 外链媒体（上游签名地址、对象存储地址）一律改走本地代理：
     页面里的 <img>/<video>/fetch 只碰本地地址，字节由代理取回（/getv 支持 Range，
     播放、抽帧、量体积、下载都能用）。这样「所有外部访问都经过本地路由」这条规则没有例外，
     也不会因为上游没给 CORS 头而抽不出帧。
     已经是本地路由的（/asset/、/getv?、/fetch?、/local-assets/）与 data:/blob: 原样返回。 */
  /* 请求：统一走 Net（带超时 + 退避重试 + 可读错误）。
     HTTP 状态先判、非 JSON 给可读提示；网络/5xx 重试 1 次（4xx 不重试）。 */
  async function rawFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    // Net 在 ui.js 里定义（各页面都先加载 ui.js）；万一没有就退回原生 fetch，不让功能整体失效
    const r = (window.Net && window.Net.fetch)
      ? await window.Net.fetch(url, { ...opts, retry: opts.retry === undefined ? 1 : opts.retry })
      : await fetch(url, opts);
    const txt = await r.text();
    let d = null, parseErr = null;
    try { d = txt ? JSON.parse(txt) : null; } catch (e) { parseErr = e; }
    if (!r.ok) {
      const err = new Error(errorMessage(d, r.status));
      err.status = r.status;
      err.code = (d && d.error && d.error.code) || (d && d.code) || '';
      err.issues = (d && d.error && d.error.details && d.error.details.issues) || (d && d.issues) || [];
      err.transient = isTransient(err);
      /* 提交类请求 + 5xx/超时：**不知道平台收没收到**。页面据此提示「可能已受理、先核对列表」，
         而不是让用户以为失败直接重试（那会在平台上留下两条重复任务）。 */
      if (['POST', 'PUT', 'PATCH'].includes(method) && (r.status >= 500 || r.status === 408 || r.status === 429)) err.maybeSubmitted = true;
      throw err;
    }
    if (d === null && parseErr) throw new Error('返回了非 JSON 内容（HTTP ' + r.status + '）');
    return d;
  }

  /* 平台的「提示词编译器」偶发失败（VGENV 的 PROMPT_COMPILER_UPSTREAM_ERROR）：
     这种错误说明任务**没有创建**，重试是安全的（不像超时/连接中断那样可能已受理）。
     页面据此自动重试一次，不要各自写正则。 */
  function isRetryableCreateError(e) {
    const t = String((e && (e.code || e.message)) || e);
    return /PROMPT_COMPILER|PROMPT_OPTIMI|prompt compiler/i.test(t);
  }

  /* 列表快照的存活时间：轮询器一轮里会把每个在跑的任务各问一次（见 Api.pollMany），
     同一轮里的请求共用一份列表，所以这个窗口只要盖住「同一轮」就够（轮询间隔 3~4 秒）。 */
  const LIST_SNAP_TTL = 1500;
  const LIST_SNAP = new Map();       // 平台 → { at, promise }（只按平台分，不按任务号）
  /* retrieve 换回来的地址缓存：同一份 file_id 在 TTL 内只问平台一次。
     TTL 要短 —— 换回来的多半是带有效期的签名地址（SiliconFlow 视频 10 分钟、OSS 类 1 小时都有），
     攥着旧地址不如重问一次；而且这一刻的产物多半当场就被存到本机了（见 /local-assets）。 */
  const RETRIEVE_TTL = 60000;
  const RETRIEVED = new Map();       // '平台|file_id' → { at, url } 或 { at, promise }（在途）

  window.Api = {
    mediaSrc,                       // 外链媒体 → 本地 /getv 路由（过期签名会顺带换成会话内回源到的新鲜地址）
    mediaKey,                       // 素材身份（host+path+稳定 query）：缓存键、去重、比对都用它
    innerMedia,                     // /getv?url=… 或 /fetch?url=…&dl=1 里取出内层外链
    signedExpiry, mediaExpired,     // 签名外链的过期时刻（毫秒）/ 是否已过期（不发请求）
    healMedia,                      // 一批过期地址按平台回源换新（onFresh 里由调用方落盘）
    classifyStatus,                 // 上游状态串 → done / queued / running / failed（唯一判据，页面别自己认词）
    /* 上游错误 → 人话（带 ERROR_HINT 的中文下一步）。TextAI 自己发请求、不走上面的 rawFetch，
       但错误文案必须一致 —— 所以这份格式化对外公开，而不是在 TextAI 里再抄一份。
       （踩过：以前 TextAI 直接调闭包内的 errorMessage，运行期 ReferenceError，界面显示
         「检索失败：errorMessage is not defined」。） */
    errorMessage,
    isRetryableCreateError,         // 平台提示词编译失败等「任务肯定没建」的错误 → 可安全重试
    setRegistry(r) { if (r && r.providers) _reg = r; },
    /* 清掉本机那些「自己会长回来」的接口缓存（设置页的清理按钮用它）：
       换密钥、代理接入新平台、上游改了能力声明却不想等 TTL 时，不必刷新整页。
       只清缓存，不动任何用户数据（历史、收藏、归档都在别处）。 */
    clearCaches() {
      _reg = null; _regTs = 0;
      _env = null; _envTs = 0; _envOk = false;
      LIST_SNAP.clear();
      clearQuoteMarks();              // 内存 + 本机记录一起清（否则下次开机又被标「不可用」）
      Object.keys(QUOTE_INFLIGHT).forEach(k => delete QUOTE_INFLIGHT[k]);
      if (window.Capabilities) { Capabilities.unavailable = false; Capabilities.sources = {}; }
    },
    async registry() {
      // 带 TTL：代理改了注册表（接入新平台）后，页面刷新即可看到，不用清缓存
      const now = Date.now();
      if (!_reg || now - _regTs > REG_TTL) {
        /* 取数走统一层：裸 fetch 没有超时也没有重试，代理刚重启时会直接落到「空注册表」 */
        try {
          const r = window.Net ? await Net.fetch('/registry', { timeout: 15000, retry: 2 }) : await fetch('/registry');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          _reg = await r.json(); _regTs = now; _regErr = '';
        }
        catch (e) {
          /* 失败**留住原因**，不静悄悄塞一个空注册表。原来的 `catch { _reg = {providers:[]} }`
             后果是整页说谎：语音那栏说「还没配语音接口」（其实密钥在 .env 里是好的）、
             型号下拉全空、「一次出 4 张」退成「再画一张」，而界面上没有任何一处
             提到「本地代理没起来」—— 用户只会去设置页反复重填密钥。
             空数组还会被当成「注册路由里没有这一类平台」继续往下传，越传越看不出根因。 */
          _regErr = (e && e.message) || String(e);
          if (!_reg) _reg = { providers: [] };
          console.warn('[Api] 注册表读不到（' + _regErr + '）—— 型号、能力与「配没配密钥」在它起来之前都不可信');
        }
      }
      warnOldProxy(_reg);
      warnProxyDown(_reg);
      return _reg;
    },
    /* 注册表读没读到（页面据此画一条不会消失的提示 + 重新连接按钮；
       空数组本身分不清「没配」与「代理没起来」，所以原因要一起交出去）。 */
    regFailed() { return !!(!(_reg && (_reg.providers || []).length) && _regErr); },
    regError() { return _regErr || ''; },
    /* 服务端环境密钥的来源状态（`{kid: {hasEnv, tail}}`，**不含密钥本体**）。
       单独缓存一份：侧栏算「这一家在不在用」要用，设置页也要 —— 各拉一次是两次同样的请求。
       ⚠ 取失败时返回的 `{}` 与「真的一家环境密钥都没有」长得一模一样，调用方必须能分开 ——
       `provUsable` 拿到空对象会把**所有只靠 .env 的平台都判成没在用**，于是「只向本机在用的平台
       取能力/型号」这件事会把真正在用的那几家整批漏掉（型号下拉全空，且没有任何报错）。
       所以成败用 `envKnown()` 单独问一句，别靠「结果是不是空对象」去猜。 */
    async envStatus() {
      const now = Date.now();
      if (!_env || now - _envTs > REG_TTL) {
        try {
          const r = window.Net ? await Net.fetch('/env-status', { timeout: 8000, retry: 0 }) : await fetch('/env-status');
          if (r && r.ok) { _env = await r.json(); _envOk = true; }
          else { _env = _env || {}; _envOk = false; }
          _envTs = now;
        } catch { if (!_env) _env = {}; _envOk = false; }
      }
      return _env;
    },
    /* 上一次 envStatus **真的取到了**吗。false 有两种（曾经有缓存但这次失败 / 还没取过），
       对调用方是同一件事：**「某家不在结果里」不能推出「这一家没有环境密钥」**。 */
    envKnown() { return !!_envOk; },
    /* 「这一家在本机算不算在用」——**只有这一份判据**。
       两处必须完全一致：设置页「供应商与密钥」那张卡列哪几家、侧栏「账户余额」列哪几家。
       各写一份就会出现「设置页里根本没有这一家、侧栏却挂着一张永远「获取失败」的卡」。
       三档算在用：自己添加进来的（`custom`）、设置里填了密钥的、服务端环境里有的。 */
    provUsable(prov, env) {
      if (!prov) return false;
      if (prov.custom) return true;
      const kid = prov.keyId || prov.id;
      /* 这里**必须**和设置页的 `keyFor` 一样直接读 localStorage，不能改走 Store.read ——
         两处读取口一旦不同分，就回到「设置页不列、侧栏列」那个毛病（这正是要修的那个 bug）。
         存的是明文字符串（Store 的信封只有代理那侧包着）。 */
      try { if (String(localStorage.getItem('sk_key_' + kid) || '').trim() !== '') return true; } catch (e) {}
      return !!(env && env[kid] && env[kid].hasEnv);
    },
    /* 跑着的代理是不是旧版由 warnOldProxy 在取注册表时顺手提醒，界面不需要单独读版本号 */
    oldProxyNotice,
    warnProxyDown,
    /* 本机环境（/sys-status）只有一份取法与一份说法：设置页那一栏、拍短剧导出的前置闸门、
       助手的 doctor 三边都要问，各写一遍就会出现「设置页说能用、助手说不能用」。 */
    sysStatus, sysTool, sysDir, sysStatusLines, SYS_WHY,
    /* 本机环境（ffmpeg / ffprobe / 三个落盘目录）：取法与说法都只在这一处，见上面那段注释 */
    sysStatus, sysTool, sysDir, sysStatusLines,
    SYS_WHY,
    providers() { return (_reg && _reg.providers) || []; },
    /* 按 id / keyId / kind / relay 找平台 */
    prov(ref) {
      const list = this.providers();
      if (!ref) return list[0] || null;
      return list.find(p => p.id === ref || p.keyId === ref)
        || list.find(p => p.kind === ref)
        || list.find(p => p.relay === ref) || null;
    },
    keyId(prov) { return (prov && (prov.keyId || prov.id)) || ''; },
    /* 按 keyId 读的 localStorage 开关（sk_key_ / sk_base_ / sk_off_ 都是这一套键名口径）。 */
    _ls(prov, prefix) {
      const id = this.keyId(prov);
      return id ? (localStorage.getItem(prefix + id) || '') : '';
    },
    /* 密钥：只认这一家自己的 keyId（registry 里 sparkcine-video 的 keyId 就是 sparkcine，共用一把）。
       绝不跨平台兜底 —— 把 A 平台的密钥发给 B 平台会直接 401（B 原本靠代理注入环境密钥可用） */
    key(prov) { return this._ls(prov, 'sk_key_'); },
    /* 本机存过的自定义上游地址（不管这一家认不认，界面要能说出「填过但不生效」） */
    baseStored(prov) { return this._ls(prov, 'sk_base_'); },
    /* 真正会发出去的地址：只有 registry 声明了 baseEditable 的平台才认。
       代理那边按同一条声明决定换不换基址（proxy.js 的 relayHit.baseEditable），
       两边判据必须一致，否则界面显示「已用自定义地址」而请求仍打到官方地址。 */
    base(prov) { return (prov && prov.baseEditable) ? this.baseStored(prov) : ''; },
    /* 这一家在设置页被勾掉了「暂时不用」 */
    isOff(prov) { return this._ls(prov, 'sk_off_') === '1'; },
    /* 新任务能用哪几家：设置页停用的那家不出现在型号下拉里。
       **只筛这一条路径** —— Api.prov() 与 REG.providers 照样能查出停用的那家，
       否则关掉一家会把它名下的历史任务渲染成「未知平台」（收藏、资产库、导演台都在读旧任务）。 */
    pickable(provs) { return (provs || this.providers()).filter(p => !this.isOff(p)); },
    forKind(kind) { return this.pickable(this.providers().filter(p => p.kind === kind)); },
    /* ---- 设置页「添加自定义供应商」那一份清单（键 sk_custom，JSON 数组）----
       页面只存「照哪一家的接口形状 + 地址 + 型号 id + 显示名」，条目怎么拼成完整声明
       全在 proxy.js 的 buildCustom 里（endpoints / create / list 都取自模板）。
       两边各拼一套就会出现「设置页看着挺好、下拉里那条是残缺的」。
       DataSync 把这一份镜像成 .data/sk_custom.json，代理读那个文件 —— 于是换机器、
       云同步、整包备份都跟着数据文件走，不用另外登记。 */
    customList() {
      try {
        const a = JSON.parse(localStorage.getItem('sk_custom') || '[]');
        return Array.isArray(a) ? a : [];
      } catch { return []; }        // 写坏过一次就不再猜：界面按「没有自定义平台」渲染，代理那边会说明读失败
    },
    customSet(list) { localStorage.setItem('sk_custom', JSON.stringify(list || [])); },
    customId() { return 'cus-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); },
    /* 删掉一家：清单里那条 + 它名下的密钥 / 停用勾选 / 万一存过的地址 / 自己填的型号一起清。
       只删清单会留下 `sk_key_cus-xxx` 这种没人认领的死数据，而且它跟着云同步出网。
       sk_text_models_ 以前没清：删掉之后它那份自填型号还留在盘上，而 keyId(null) 会兜底成
       'deepseek'，于是这份死数据在别处被读出来时表现成「别家凭空多出几个我填过的型号」。 */
    customDrop(id) {
      this.customSet(this.customList().filter(e => e && e.id !== id));
      ['sk_key_', 'sk_off_', 'sk_base_', 'sk_text_models_'].forEach(p => localStorage.removeItem(p + id));
    },
    /* 端点 URL：端点名 → relay + 模板（{id} 用 sub 替换） */
    url(prov, name, sub) {
      const ep = prov && prov.endpoints && prov.endpoints[name];
      if (!ep) throw new Error(((prov && prov.name) || '该平台') + ' 没有声明「' + name + '」接口（请在 proxy.js 的 REGISTRY 里补上）');
      // 'local:/xxx' = 代理本地端点（如本地资产库），不加 relay 前缀
      const local = ep.startsWith('local:');
      const path = local ? ep.slice('local:'.length) : prov.relay + ep;
      return sub != null ? path.replace('{id}', encodeURIComponent(sub)) : path;
    },
    headers(prov, extra) {
      const h = { ...(extra || {}) };
      const k = this.key(prov);
      if (k) h['Authorization'] = 'Bearer ' + k;
      /* 自定义基址交给代理去换（它同样会校验只允许公网 https）。
         没声明 baseEditable 的平台这里是空串 → 不带这个头，请求照旧打到 registry 里的官方地址。 */
      const b = this.base(prov);
      if (b) h['x-up-base'] = b;
      return h;
    },
    async request(prov, name, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      const q = opts.query ? ('?' + (opts.query instanceof URLSearchParams ? opts.query.toString() : String(opts.query))) : '';
      const headers = this.headers(prov, opts.headers);
      if (opts.body != null) headers['Content-Type'] = 'application/json';
      if (opts.noCache) headers['x-no-cache'] = '1';        // 强制回源，跳过代理的列表短缓存
      /* 幂等键由 registry 声明决定（create.idempotencyKey，默认支持）：
         · 支持（如 SparkCine）：带上。缺了它上游直接 400，只回一句「部分内容需要检查。」——
           所以统一在路由层兜底补上，页面封装漏传 headers 也不会再踩这个坑。
           带键的 POST 才允许 Net 层自动重试（服务端按键去重，重试不会建出第二条任务）。
         · 不支持（如 VGENV / MiMo）：不但补，还要把页面显式塞进来的删掉 ——
           没有去重保证时重试会重复建任务、重复扣费（见 ui.js 的 Net.fetch 重试策略）。 */
      const wantIdem = !((prov && prov.create && prov.create.idempotencyKey) === false);
      if (method === 'POST') {
        if (wantIdem && !headers['Idempotency-Key'] && !headers['idempotency-key']) {
          headers['Idempotency-Key'] = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        } else if (!wantIdem) {
          delete headers['Idempotency-Key']; delete headers['idempotency-key'];
        }
      }
      /* 创建任务的响应可能很慢（平台要排队 / 校验，实测 VGENV 有超过 60 秒的）：
         给它更长的总超时。否则浏览器先掐断 → 页面以为失败、平台其实已受理 → 用户重试就重复建任务。
         其它请求保持默认（「设置 → 网络与刷新」可调）。代理侧对 create 也放宽到 120 秒（见 proxy.js）。 */
      const timeout = opts.timeout != null ? opts.timeout
        : (method === 'POST' && name === 'create' ? 150000 : undefined);
      const d = await rawFetch(this.url(prov, name, opts.id) + q, {
        method: opts.method || 'GET',
        headers,
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
        timeout,
      });
      /* 任何页面创建任务都归档一份提示词（存进归档文件夹，见 PromptLog）：
         平台不返回 prompt 时（如 VGENV），资产库要靠它把提示词补显示出来。
         归档只在这一处发生（Api.create 也走这里，它不再自己存第二份）。 */
      try {
        // log:false = 页面自己归档（如语音那种没有平台任务号的），别再存一份
        // log.prompt = 界面想归档**原文**时用（导演台提交的是平台语法的描述，归档要原始描述）
        const archPrompt = (opts.log && opts.log.prompt) || (opts.body && opts.body.prompt) || '';
        if (name === 'create' && archPrompt && opts.log !== false && window.PromptLog) {
          const p = this.parseItem(prov, d);
          const id = (p && p.genId) || (d && (d.id || d.task_id || d.job_id));
          /* 注册表用本模块自己的 _reg（不是页面的 REG）：
             以前这里裸写 REG，靠「页面恰好在全局声明了 let REG」才不抛 ReferenceError —
             没有那个绑定的页面（shell、以及任何只用 Api 的脚本）会被外层那个空 catch 静默吞掉，
             表现就是「任务建了、归档里却压根没有这条」。 */
          if (id) PromptLog.save(_reg, { type: (opts.log && opts.log.type) || PromptLog.ctxType(prov),
            prompt: archPrompt, model: (opts.log && opts.log.model) || (opts.body && opts.body.model),
            provider: prov.id, task: id,
            title: opts.log && opts.log.title, meta: opts.log && opts.log.meta });
        }
      } catch (e) {}
      return d;
    },
    /* 「这个 host 属于 registry 里哪一家」=「A 家密钥打到 B 家地址」与「第三方中转」两类告警的唯一判据。
       文字 AI 与生成平台的自定义地址都走它（TextAI.baseOwner 现在只是它的旧入口名）。
       比对只看 host，不看路径：同一个域名下的不同前缀仍是同一家。
       返回值里的 `custom` 说明撞上的那一家**自己也是用户加的**：同一个网关服务两类生成（一家管图、一家管视频）
       是完全正常的用法，所以那种撞车只能提示、不能拦；只有「内置平台的官方地址」才该拦。 */
    hostOwner(REG, base, prov) {
      const b = String(base || '').trim();
      if (!b) return null;
      const hostOf = v => { try { return new URL(/^https?:\/\//i.test(String(v)) ? String(v) : 'https://' + v).host; } catch (e) { return ''; } };
      const h = hostOf(b);
      if (!h) return null;
      if (prov && hostOf(prov.base) === h) return null;                 // 就是它自己的官方地址
      const others = ((REG && REG.providers) || []).filter(x => x !== prov && hostOf(x.base) === h);
      if (others.length) return { kind: 'other-provider', host: h, name: others[0].name || others[0].id,
        id: others[0].id, custom: !!others[0].custom, official: prov && prov.base };
      /* 官方地址之外的第三方中转：同样危险（官方密钥发到别处），但要分一种说法 */
      return { kind: 'other-host', host: h, name: h, id: '', custom: false, official: prov && prov.base };
    },
    /* 「验证密钥」：挑一个**只读、不建任务**的接口问一次，把结果说成人话。
       按平台声明排优先级：余额（credits，能顺带报出余额）→ 模型清单（models）→ 任务列表（list，取 1 条）。
       `local:` 开头的端点是本工作台自己的落盘接口，问它证明不了上游密钥，所以跳过。
       这一条只有一份实现：设置页与助手都用它，别再在页面里拼一套「先试 credits 再试 list」。 */
    verifyEp(prov) {
      const ep = (prov && prov.endpoints) || {};
      const up = k => ep[k] && !String(ep[k]).startsWith('local:');
      if (up('credits')) return 'credits';
      if (up('models')) return 'models';
      if (up('list')) return 'list';
      return '';
    },
    /* 验证会打到哪一个只读端点、它中文叫什么。界面那句「正在问一次余额…」用它，
       不要再自己排一遍优先级（那是第二份判据，两边说法会慢慢走岔）。 */
    verifyTarget(prov) {
      const via = this.verifyEp(prov);
      return { via, label: via === 'credits' ? '余额' : via === 'models' ? '模型清单' : via === 'list' ? '任务列表' : '' };
    },
    /* 验证用的请求头：opts 里传了 key/base 就用**表单里刚填还没保存**的那对（设置页「验证」按钮要用它，
       否则要先保存才能试，和这一页「点保存才生效」互相别扭）；没传就用磁盘上保存过的那对。 */
    verifyHeaders(prov, opts = {}) {
      const h = {};
      const k = opts.key != null ? String(opts.key).trim() : this.key(prov);
      if (k) h['Authorization'] = 'Bearer ' + k;
      const b = opts.base != null ? (prov && prov.baseEditable ? String(opts.base).trim() : '') : this.base(prov);
      if (b) h['x-up-base'] = b;
      return h;
    },
    async verify(prov, opts = {}) {
      const t = this.verifyTarget(prov);
      if (!t.via) return { ok: false, why: '这一家没有声明任何只读的接口（余额 / 模型清单 / 列表），本机没法验证密钥' };
      const via = t.via, label = t.label;
      let d = null, err = null;
      try {
        d = await rawFetch(this.url(prov, via) + (via === 'list' ? '?limit=1' : ''),
          { headers: { ...this.verifyHeaders(prov, opts), 'x-no-cache': '1' }, timeout: 20000, retry: 0 });
      } catch (e) { err = e; }
      if (err) {
        const m = String(err.message || err);
        /* 401/403 才是密钥的问题；403 也可能是这个接口要更高权限（界面照实说，不编「密钥无效」） */
        if (err.status === 401) return { ok: false, via, label, why: '密钥被拒（HTTP 401）：' + m };
        if (err.status === 403) return { ok: false, via, label, why: '权限不足（HTTP 403）：' + m + ' —— 这把密钥能连但读不了' + label };
        if (/api.?key|密钥|auth|unauthor|invalid/i.test(m)) return { ok: false, via, label, why: '密钥或地址不对：' + m };
        return { ok: false, via, label, why: '问了一次「' + label + '」没成功：' + m };
      }
      /* 余额接口按 balance.style 解析成统一结构；另外两种只数得出条数 */
      if (via === 'credits') {
        const b = this.balance(prov, d);
        if (b && b.ok === false) return { ok: true, via, label, detail: '通了，但余额字段不在声明的位置（' + label + '读不出数）' };
        /* 积分账户原样报数，金额账户折成 ¥ 两位小数（和侧栏那一排同一个口径） */
        const money = b.unit ? (b.available + ' ' + b.unit) : ('¥' + Number(b.available || 0).toFixed(2));
        return { ok: true, via, label, detail: '余额 ' + money + (b.frozen && !b.unit ? ' · 冻结 ¥' + Number(b.frozen).toFixed(2) : '') };
      }
      const arr = Array.isArray(d) ? d : ((d && (d.data || d.items || d.models)) || []);
      if (!Array.isArray(arr)) return { ok: true, via, label, detail: '通了，但返回的不是清单（界面按能力声明兜底）' };
      return { ok: true, via, label, detail: '通了，' + label + ' ' + arr.length + ' 条' };
    },
    /* 创建任务：标准字段 → registry 声明的请求体（nest 决定哪些要嵌进 parameters） */
    createBody(prov, f = {}) {
      const spec = (prov && prov.create) || null;
      if (!spec) throw new Error(((prov && prov.name) || '该平台') + ' 没有声明 create（请在 proxy.js 的 REGISTRY 里补上）');
      const std = { model: f.model, prompt: f.prompt, tier: f.tier, duration: f.duration, res: f.res,
        ar: f.ar, quality: f.quality, count: f.count, format: f.format,
        /* size = 「宽x高」那一类画幅参数（SiliconFlow 的 image_size、OpenAI 兼容的 size）。
           与 ar（比例写法）是两种东西：平台在 create.body 里把 size 映射到自己的字段名即可，
           页面不按平台 id 分支。 */
        size: f.size };
      const body = {};
      Object.entries(spec.body || {}).forEach(([k2, src]) => {
        const v = std[src];
        if (v !== undefined && v !== null && v !== '') body[k2] = v;
      });
      Object.assign(body, spec.constants || {});
      Object.entries(spec.nest || {}).forEach(([parent, pairs]) => {
        const o = {};
        (pairs || []).forEach(pair => {
          // 声明写法：[上游字段名, 标准字段名]；也兼容直接写 [字段名]（同名）
          const up = Array.isArray(pair) ? pair[0] : pair;
          const from = Array.isArray(pair) ? (pair[1] || pair[0]) : pair;
          const v = std[from];
          if (v !== undefined && v !== null && v !== '') o[up] = v;
        });
        if (Object.keys(o).length) body[parent] = { ...(body[parent] || {}), ...o };
      });
      /* 泛型参数：页面把「上游字段名 → 值」原样交过来（如能力接口声明的 generate_audio）。
         放进 registry 声明的那个嵌套对象里（SparkCine 是 parameters），没有嵌套就放顶层。
         这样平台声明了新的参数，页面不用改、registry 也不用加映射。
         registry 的 create.topBools 声明过的字段走**顶层**（如 optimize_prompt），
         没声明的照旧进嵌套对象 —— 两类字段不能混，混了平台会拒。 */
      if (f.params && typeof f.params === 'object') {
        const tops = (spec.topBools || {});
        const keys = Object.keys(f.params).filter(k => f.params[k] !== undefined && f.params[k] !== null);
        if (keys.length) {
          const rest = [], o = {};
          keys.forEach(k => { if (Object.prototype.hasOwnProperty.call(tops, k)) body[k] = f.params[k]; else rest.push(k); });
          if (rest.length) {
            const parent = Object.keys(spec.nest || {})[0];
            if (parent) { rest.forEach(k => o[k] = f.params[k]); body[parent] = { ...(body[parent] || {}), ...o }; }
            else rest.forEach(k => body[k] = f.params[k]);
          }
        }
      }
      /* 素材输入：完全按 registry 的 inputTemplates 拼成平台要的形状。
         entries = [{ role, url?, assetId? }]（url = DataURL/公网地址，assetId = 已上传的资产）。
         没声明模板的 role 不进提交体 —— 界面早就按同一份声明拦住了（Capabilities 的槽位/互斥判断），
         走到这里还拿不到模板只可能是注册表漏写，要补的是声明，不是在代码里猜一个形状。 */
      if (Array.isArray(f.inputEntries) && f.inputEntries.length) {
        const tpls = (spec.inputTemplates) || null;
        const groups = new Map();     // to → { many, tmpl, items:[] }
        f.inputEntries.forEach(en => {
          const t = (tpls && (tpls[en.role] || tpls.__default)) || null;
          if (!t) return;
          const fill = v => {
            if (typeof v === 'string') return v.replace(/\$url/g, en.url || '').replace(/\$assetId/g, en.assetId || '').replace(/\$role/g, en.role || '');
            if (Array.isArray(v)) return v.map(fill);
            if (v && typeof v === 'object') { const o = {}; Object.entries(v).forEach(([k2, v2]) => o[k2] = fill(v2)); return o; }
            return v;
          };
          if (!groups.has(t.to)) groups.set(t.to, { many: !!t.many, tmpl: t.tmpl, items: [] });
          groups.get(t.to).items.push(fill(t.tmpl));
        });
        groups.forEach((g, to) => { if (g.items.length) body[to] = g.many ? g.items : g.items[0]; });
      }
      /* 页面显式指定 note 时才带（如导演台写镜头名）。
         **不要**退回到 `spec.note` —— 那是注册表里给界面看的说明文字（如「视频生成」），
         发给上游既没有意义，又把本项目的内部措辞漏给了平台。 */
      if (f.note) body.note = String(f.note).slice(0, 200);
      if (Array.isArray(f.inputs) && f.inputs.length) body.inputs = f.inputs;
      if (f.extra && typeof f.extra === 'object') Object.assign(body, f.extra);   // 平台特有的输入字段（参考图/首尾帧等）
      return body;
    },
    /* 某个 role 的输入模板（registry 的 create.inputTemplates 声明）：
       返回 { to, many, tmpl, needsUpload }；没声明就退回 __default，再没有就返回 null（调用方按老写法处理）。 */
    inputTemplate(prov, role) {
      const t = (prov && prov.create && prov.create.inputTemplates) || null;
      if (!t) return null;
      return t[role] || t.__default || null;
    },

    /* 请求体模板：把 {{字段}} 替换成实际值；值为空则整项省略（如没有风格描述就不发那条 message） */
    renderTemplate(tpl, vars) {
      const sub = s => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
      const walk = v => {
        if (typeof v === 'string') return sub(v);
        if (Array.isArray(v)) {
          return v.map(walk).filter(x => {
            if (x === '') return false;
            if (x && x.__drop) return false;
            if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0) return false;
            return true;
          });
        }
        if (v && typeof v === 'object') {
          const o = {};
          let dropped = false;
          Object.entries(v).forEach(([k, v2]) => {
            const w = walk(v2);
            if (w === '') { dropped = true; return; }                                   // 空占位 → 省略该项
            if (w && typeof w === 'object' && !Array.isArray(w) && !Object.keys(w).length) { dropped = true; return; }
            o[k] = w;
          });
          // 消息类对象（带 content）内容被删空时，整条省略（例如没有风格描述就不发 user 消息）
          if (dropped && Object.prototype.hasOwnProperty.call(v, 'content') && o.content === undefined) return { __drop: true };
          return o;
        }
        return v;
      };
      return walk(tpl);
    },
    async create(prov, fields) {
      const spec = (prov && prov.create) || {};
      const body = spec.template ? this.renderTemplate(spec.template, fields) : this.createBody(prov, fields);
      /* 归档交给 request 那一处统一做（以前这里又存一份：同一条任务落两个归档文件、
         还各自起一次 AI 标题）。这里只负责把「界面上真正输入的文字」传下去：
         语音那种请求体里没有 prompt 字段的，靠 fields.text 也能归档到。 */
      const log = fields.log === false ? false : {
        ...(fields.log && typeof fields.log === 'object' ? fields.log : {}),
        prompt: (fields.log && fields.log.prompt) || fields.prompt || fields.text || body.prompt || '',
      };
      return await this.request(prov, spec.endpoint || 'create', { method: 'POST', body, log });
    },
    /* 按类型另存到用户指定的文件夹（设置页「自动保存」那一卡配的）。
       **目录不在这里传** —— 代理只认它自己读到的配置，请求体里带目录会被丢掉：
       浏览器没法验证用户填的路径，代理也没法验证调用方是不是本工作台页面。 */
    async saveToDir({ type, name, mime, format, data }) {
      return rawFetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name, mime, format, data }),
      });
    },
    /* 弹系统自带的文件夹选择框，让用户点着挑一个目录回来。
       浏览器自己给不了真实路径（`<input webkitdirectory>` 只给文件夹名、File System Access
       给的是存不下来的句柄），所以这条路必须由**本机代理**去弹 —— 拿到的是一条真路径字符串，
       能存进设置、能发给代理、刷新后还在。
       `retry: 0` 是硬要求：这是 POST 且没有幂等键，而每一次重试都会在用户屏幕上**再弹一个框**。
       超时要给足 5 分钟（代理那边也是 5 分钟），用户是在慢慢翻目录，不是网络慢。 */
    async pickDir({ title, start } = {}) {
      return rawFetch('/pick-dir', {
        method: 'POST', retry: 0, timeout: 5.5 * 60 * 1000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || '', start: start || '' }),
      });
    },
    /* 提示词补显示：平台不返回 prompt 时，从归档索引里取（见 PromptLog，同步读内存缓存）
       先按「平台|任务号」精确查，再退到只按任务号查 —— 归档里写的平台名可能和列表来源不是一套
       （媒体路由把同一上游的条目归到另一个 provider id），只查前者就会误报「本机没归档」。 */
    promptFor(provId, id) {
      const P = window.PromptLog;
      if (!P || !id) return '';
      return P.cached(provId, id) || P.cachedById(id) || '';
    },
    /* 本地生成产物落盘：同步返回的二进制（语音等）存成本机资产，返回 { id, url, ... }
       大类型代理按扩展名 / mime 现算（图片、视频、音频都存得住），media_type 只在两者都认不出时才用。 */
    async saveLocalAsset({ name, mime, format, data, meta, media_type }) {
      return rawFetch('/local-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mime, format, data, media_type, meta: meta || {} }),
      });
    },
    /* 取响应里的点路径（'choices.0.message.audio.data'），数组下标也支持 */
    pickPath(raw, path) {
      return String(path || '').split('.').reduce((v, k) => (v == null ? undefined : v[/^\d+$/.test(k) ? Number(k) : k]), raw);
    },
    /* 同步返回的产物：OpenAI 兼容生图（POST {base}/images/generations）当场就把图给回来，
       没有任务号、没有轮询 —— 以前这一类平台只能等一个永远不会出现的任务号。
       三个字段名由 registry 的 create.sync 声明（items 数组的位置、url 字段、b64 字段），
       页面照声明取数，不按平台 id 分支；没声明 sync 的平台这里返回 null，走原来的「建任务→轮询」。
       返回 [{url}|{b64}]：url 多半带有效期（SiliconFlow 1 小时），所以调用方要**当场取回字节**存本机，
       不能把外链直接塞进列表 —— 明天打开就全是一排裂图。 */
    syncMedia(prov, res) {
      const s = (prov && prov.create && prov.create.sync) || null;
      if (!s || !res) return null;
      const arr = this.pickPath(res, s.items);
      if (!Array.isArray(arr) || !arr.length) return null;
      const out = [];
      arr.forEach(it => {
        if (it == null) return;
        if (typeof it === 'string') { out.push({ url: it }); return; }
        const url = s.url ? this.pickPath(it, s.url) : it.url;
        const b64 = s.b64 ? this.pickPath(it, s.b64) : it.b64_json;
        if (url) out.push({ url: String(url) });
        else if (b64) out.push({ b64: String(b64) });
      });
      return out.length ? out : null;
    },
    /* ---- 通用 retrieve 环节：产物不是直接给地址，而是先给一个「文件号」----------------
       有一族平台的产物**不给可播放地址**，只给一个 file_id / handle，要再换一次接口才拿得到
       （MiniMax 的 /v1/files/retrieve 就是这一族；很多平台的「文件下载」接口也是）。
       这一族以前只能整个平台不接：产物字段空着 → 任务卡在「生成中」，或者列表里根本没有文件。
       registry 用两处声明表达它，页面与轮询器**只调这两个入口**，不按平台 id 分支：
         endpoints.retrieve = '/v1/files/retrieve?file_id={id}'   ← {id} 在 query 里也照样替换
         retrieve: { idFrom: 'file_id', urlFrom: 'file.download_url' }
       换回来的地址写进条目的 __url，parseItem / normalize 读不到产物地址时兜底用它。
       声明了 idFrom 却没声明 endpoints.retrieve（或者平台压根没这一族）时一律返回 null，
       调用方按「没换到地址」处理，不猜字段、不按平台 id 补判据。 */
    async retrieveItem(prov, raw) {
      const cfg = (prov && prov.retrieve) || null;
      if (!cfg || !raw || typeof raw !== 'object') return null;
      if (!(prov.endpoints && prov.endpoints.retrieve)) return null;
      const fid = this.pickPath(raw, cfg.idFrom || 'file_id');
      if (fid == null || fid === '' || typeof fid === 'object') return null;
      const key = (prov.id || prov.relay || '?') + '|' + fid;
      const hit = RETRIEVED.get(key);
      if (hit) {
        if (Date.now() - hit.at < RETRIEVE_TTL) return hit.promise ? hit.promise : hit.url;
        RETRIEVED.delete(key);                       // 过期了重问（签名地址多半也过期了）
      }
      if (RETRIEVED.size > 200) RETRIEVED.delete(RETRIEVED.keys().next().value);
      const promise = this.request(prov, 'retrieve', { id: String(fid), noCache: true })
        .then(d => {
          const u = this.pickPath(d, cfg.urlFrom || 'file.download_url');
          if (u == null || typeof u === 'object') return null;      // 没换到 / 形状不对：如实当没有
          const s = String(u);
          RETRIEVED.set(key, { at: Date.now(), url: s });
          return s;
        })
        .catch(() => { RETRIEVED.delete(key); return null; });      // 失败不缓存：下一轮重问
      RETRIEVED.set(key, { at: Date.now(), url: null, promise });
      return promise;
    },
    /* 把一条轮询/列表响应里的文件号换成真实地址（就地写 raw.__url）。
       已经能从 list.map 直接取到产物地址的条目不额外问一次（省一轮请求）。 */
    async resolveItem(prov, raw) {
      if (!raw || typeof raw !== 'object' || raw.__url) return raw;
      if (!(prov && prov.retrieve)) return raw;
      const mapped = this.pick(raw, ((prov.list || {}).map || {}).outputUrl);
      if (mapped) return raw;                        // 平台这次直接给了地址：不用再换
      const url = await this.retrieveItem(prov, raw);
      if (url) raw.__url = url;
      return raw;
    },
    async cancel(prov, id) {
      return this.request(prov, 'cancel', { id, method: (prov && prov.cancelMethod) || 'POST' });
    },
    /* 详情：优先 detail 端点，没声明就用 poll */
    async detail(prov, id) {
      const hasDetail = prov && prov.endpoints && prov.endpoints.detail;
      return this.request(prov, hasDetail ? 'detail' : 'poll', { id });
    },
    /* 轮询单条任务：返回 { raw, p }（p = parseItem 结果，可能为 null）。
       优先用 detail/poll 端点；**端点不可用时退回列表端点按任务号找** ——
       VGENV 的 /v2/videos/{id} 实测是 404 空壳错误（只有 statusCode/code/message），
       只认它的后果是「任务永远停在排队中」，而且 404 还会被误判成「任务已被清理」把任务号清掉，
       于是同一个任务在界面上裂成两张：一张假的失败卡 + 列表里真实的已完成卡。
       平台也可以用 registry 的 provider.pollVia:'list' 直接声明走列表。 */
    async pollTask(prov, id) {
      const viaList = String((prov && prov.pollVia) || '') === 'list';
      let firstErr = null;
      if (!viaList) {
        try {
          const raw = await this.resolveItem(prov, await this.detail(prov, id));
          const p = this.parseItem(prov, raw);
          if (p && p.status) return { raw: raw, p: p };
          // 响应里没有状态字段（平台没实现详情接口）→ 落到下面的列表兜底
        } catch (e) { firstErr = e; }
      }
      const spec = (prov && prov.list) || {};
      if (!spec || !prov.endpoints || !prov.endpoints.list) {
        if (firstErr) throw firstErr;                       // 既没有列表声明又请求失败：如实抛出
        return { raw: null, p: null };
      }
      const query = new URLSearchParams();
      query.set(spec.limitParam || 'limit', String(spec.limit || 100));
      let d = await this.request(prov, 'list', { query, noCache: true });
      const items = (spec.dataField ? d[spec.dataField] : d.data) || [];
      const idPath = (spec.map || {}).id || 'id';
      let raw = items.find(x => String(this.pick(x, idPath)) === String(id));
      /* 第一页没找到时按游标继续翻（最多再翻 2 页）：
         「一页到底」的平台翻不动，但列表很长时老任务只在后面几页，
         只查第一页会把它误判成「平台已清理」→ 卡片被结掉、任务号被清掉。 */
      let cursor = this.listCursor(prov, d);
      for (let page = 0; !raw && cursor && page < 2; page++) {
        const q2 = new URLSearchParams();
        q2.set(spec.limitParam || 'limit', String(spec.limit || 100));
        q2.set(spec.cursorParam || 'cursor', String(cursor));
        d = await this.request(prov, 'list', { query: q2, noCache: true });
        const more = (spec.dataField ? d[spec.dataField] : d.data) || [];
        raw = more.find(x => String(this.pick(x, idPath)) === String(id));
        const next = this.listCursor(prov, d);
        if (!next || String(next) === String(cursor)) break;      // 游标没前进 → 到底
        cursor = next;
      }
      /* 文件号 → 真实地址：拿到条目后统一换一次（同一轮里同一个 file_id 只问一次）。
         没换到的照原样交给 parseItem —— 它会按「成功但产物字段空着」继续判成生成中，下一轮再换。 */
      if (raw) await this.resolveItem(prov, raw);
      return { raw: raw || null, p: raw ? this.parseItem(prov, raw) : null };
    },
    /* 列表下一页游标：registry 声明的 cursorField 优先（显式声明成空串 = 这接口不支持翻页，认了）。
       声明的字段在响应里没有时现认几个常见名字 —— 只翻第一页的话，稍老的任务在第一页找不到，
       会被误判成「平台已清理」而结掉、清掉任务号。 */
    listCursor(prov, d) {
      if (!d || typeof d !== 'object') return null;
      const cf = ((prov && prov.list) || {}).cursorField;
      if (cf === '') return null;
      const keys = ['next_cursor', 'nextCursor', 'next_token', 'nextToken', 'next_page', 'nextPage', 'next'];
      if (cf && !keys.includes(cf)) keys.unshift(cf);
      const at = o => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== '') return String(v); } return null; };
      return at(d) || at(d.pagination) || at(d.meta);
    },
    /* 批量取状态：一次问回多个任务的状态（轮询器一轮里会对每个在跑的任务各调一次）。
       · 有 detail 端点的平台 → 逐条问（语义与 pollTask 完全一致，单条失败不影响同一批里的其它条）；
       · registry 声明了 pollVia:'list' 的平台（VGENV）→ **一次列表请求解出这一批**：
         逐条问的话 N 个任务每轮就是 N 次「100 条的列表」请求（VGENV 列表实测 2.4 秒/次），
         上游被打爆、请求互相排队，状态反而更不准 —— 一条都刷不出来还一直转圈。
       同一轮（LIST_SNAP_TTL 内）的多次调用共用同一份列表快照，所以 N 条任务只打一次列表。
       返回 Map<任务号, { raw, p }>；单条出错写 { error }（页面按 404/查不到分别处置）。 */
    async pollMany(prov, ids) {
      const A = this;
      const want = [...new Set((ids || []).filter(Boolean).map(String))];
      const out = new Map();
      if (!want.length) return out;
      const spec = (prov && prov.list) || {};
      const viaList = String((prov && prov.pollVia) || '') === 'list';
      if (viaList && prov.endpoints && prov.endpoints.list) {
        const idPath = (spec.map || {}).id || 'id';
        const rows = d => (Array.isArray(d) ? d : ((d && (spec.dataField ? d[spec.dataField] : d.data)) || []));
        const snap = (key, build) => {          // 同一轮里的调用共用一次请求
          const now = Date.now(), hit = LIST_SNAP.get(key);
          if (hit && now - hit.at < LIST_SNAP_TTL) return hit.promise;
          const promise = build();
          LIST_SNAP.set(key, { at: now, promise });
          promise.catch(() => LIST_SNAP.delete(key));      // 失败不缓存，下一轮重新打
          return promise;
        };
        const pid = prov.id || prov.relay || 'list';
        const q1 = new URLSearchParams();
        q1.set(spec.limitParam || 'limit', String(spec.limit || 100));
        /* 状态刷新用代理的短缓存（列表端点的 cacheTtl）就够：视频生成以分钟计，
           为「快 2 秒」把上游那份 100 条列表每 4 秒重拉一遍不值当。 */
        const page1 = await snap(pid + '|p1', () => A.request(prov, 'list', { query: q1 }));
        const found = new Map();
        rows(page1).forEach(x => { const id = String(A.pick(x, idPath)); if (want.includes(id)) found.set(id, x); });
        /* 第一页没找全的按游标继续翻（最多再翻 2 页，与 pollTask 同一口径：
           列表很长时老任务只在后面几页）。 */
        const cursor0 = A.listCursor(prov, page1);
        if (cursor0 && want.some(id => !found.has(id))) {
          const pages = await snap(pid + '|more', async () => {
            const acc = [];
            let cursor = cursor0;
            for (let i = 0; i < 2 && cursor; i++) {
              const q = new URLSearchParams();
              q.set(spec.limitParam || 'limit', String(spec.limit || 100));
              q.set(spec.cursorParam || 'cursor', String(cursor));
              const d = await A.request(prov, 'list', { query: q });
              acc.push(d);
              const next = A.listCursor(prov, d);
              if (!next || String(next) === String(cursor)) break;      // 游标没前进 → 到底
              cursor = next;
            }
            return acc;
          });
          pages.forEach(d => rows(d).forEach(x => {
            const id = String(A.pick(x, idPath));
            if (want.includes(id) && !found.has(id)) found.set(id, x);
          }));
        }
        /* 走列表拿状态的这族平台，产物也可能只给文件号：统一换一次再解析 */
        await Promise.all([...found.values()].map(r => A.resolveItem(prov, r)));
        want.forEach(id => { const raw = found.get(id); if (raw) out.set(id, { raw, p: A.parseItem(prov, raw) }); });
        return out;      // 没找到的就不进 Map —— 页面据此判断「列表里查不到这条任务」
      }
      await Promise.all(want.map(async id => {
        try { const r = await A.pollTask(prov, id); out.set(id, { raw: (r && r.raw) || null, p: (r && r.p) || null }); }
        catch (e) { out.set(id, { error: e }); }
      }));
      return out;
    },
    /* 余额：按 balance.style 解析成统一结构 { unit, available, frozen, spent?, note?, ok, err? }
       —— 文字与语音类**不按类型过滤**（以前只有图片/视频平台声明了 credits，文字/语音一家都画不出来）。
       每种 style 自己从 raw 取数，**不要都挤在 entry 上**：OpenRouter 回 { data:{…} }（对象）、
       DeepSeek 回 { balance_infos:[…] }（数组），两者都过不了下面那条「数组取第一项 / data[0]」的
       通用入口，硬套进去只会读出一个空对象，然后侧栏显示「获取失败」。 */
    balance(prov, raw) {
      const style = (prov && prov.balance && prov.balance.style) || 'micros';
      if (style === 'wallet-credits') {
        const entry = Array.isArray(raw) ? raw[0] : ((raw && raw.data ? raw.data[0] : raw) || {});
        return { unit: '积分', available: entry.available ?? '?', frozen: entry.reserved ?? 0,
          note: entry.status || '', ok: entry.available != null };
      }
      if (style === 'openrouter-credits') {
        /* GET /api/v1/credits → { data: { total_credits, total_usage } }
           平台**没有「余额」字段**，只给累计充值与累计花费，两数相减才是剩下的；
           而且只有**管理密钥**能问（普通 API key 回 403）—— 问不到不等于余额是 0，err 要说清。 */
        const d = (raw && raw.data) || {};
        const bought = Number(d.total_credits), used = Number(d.total_usage);
        const ok = Number.isFinite(bought) && Number.isFinite(used);
        const r2 = v => Math.round(v * 1e4) / 1e4;
        return { unit: 'USD', available: ok ? r2(bought - used) : '?', frozen: 0,
          spent: Number.isFinite(used) ? r2(used) : null,
          note: '累计充值 ' + bought + ' − 累计花费 ' + used,
          ok: ok, err: ok ? '' : '没读到余额字段（这家要用「管理密钥」才能问余额，普通 API key 会被拒）' };
      }
      if (style === 'deepseek-balance') {
        /* GET /user/balance → { is_available, balance_infos:[{ currency, total_balance, granted_balance, topped_up_balance }] }
           total_balance 是**字符串**（"110.00"），不 Number 一下侧栏会拿它做字符串拼接。 */
        const list = (raw && raw.balance_infos) || (Array.isArray(raw) ? raw : []);
        const b = list[0] || {};
        const v = Number(b.total_balance);
        const ok = Number.isFinite(v);
        return { unit: b.currency || '', available: ok ? v : '?', frozen: 0,
          note: ok && b.currency ? ('单位 ' + b.currency + '（含赠金 ' + (b.granted_balance || 0) + '）') : '',
          ok: ok, err: ok ? '' : '平台没返回 balance_infos' };
      }
      if (style === 'moonshot-balance') {
        /* GET /v1/users/me/balance → { code, data: { available_balance, voucher_balance, cash_balance } }
           单位是**人民币元**（官方文档明说 available ≤ 0 就拒绝推理）。 */
        const d = (raw && raw.data) || {};
        const v = Number(d.available_balance);
        const ok = Number.isFinite(v);
        return { unit: ok ? 'CNY' : '', available: ok ? v : '?', frozen: 0,
          note: ok ? ('代金券 ' + (d.voucher_balance ?? 0) + ' + 现金 ' + (d.cash_balance ?? 0)) : '',
          ok: ok, err: ok ? '' : '平台没返回 data.available_balance' };
      }
      const entry = Array.isArray(raw) ? raw[0] : ((raw && raw.data ? raw.data[0] : raw) || {});
      const pick = v => (typeof v === 'object' && v ? (v.amount_micros ?? 0) : (v ?? 0));
      const yuan = v => Number(pick(v)) / 1e6;
      return { unit: '', available: yuan(entry.availableMicros ?? entry.available),
        frozen: yuan(entry.reservedMicros ?? entry.frozen ?? 0),
        spent: entry.spentMicros != null ? yuan(entry.spentMicros) : null,
        ok: entry.availableMicros != null || entry.available != null };
    },
    /* 取对象点路径（'parameters.quality'）—— 列表/轮询解析共用 */
    pick(raw, path) {
      if (!path) return undefined;
      return String(path).split('.').reduce((v, k) => (v == null ? undefined : v[k]), raw);
    },
    /* 把「列表条目 / 轮询响应」按 registry 的 list.map 解析成标准字段
       （轮询响应与列表条目同构，所以共用一份映射；平台差异全部在 REGISTRY 里） */
    parseItem(prov, raw) {
      if (!raw || typeof raw !== 'object') return null;
      const spec = (prov && prov.list) || {};
      const m = spec.map || {};
      const g = k => this.pick(raw, m[k]);
      const outs = g('outputs');
      const firstOut = Array.isArray(outs) ? outs[0] : null;
      const cRaw = g('credits');
      const credits = cRaw == null ? null
        : (typeof cRaw === 'object' ? (cRaw.charged ?? cRaw.held ?? null) : cRaw);
      const pm = g('priceMicros');
      const rawStatus = g('status') || '';
      /* 三档判定只有 classifyStatus 一份（见文件顶部）：认不出的状态不当终局，
         平台在产物字段写全之前常常先回一个空/陌生的状态串（SparkCine 的 statusMap 只声明了
         succeeded，中间态全落在这类）。把它算成 failed 会让卡片显示「生成失败」、轮询提前结掉，
         而真任务还在跑 —— 用户按「重试」就是重复扣费。 */
      const st = classifyStatus(spec, rawStatus);
      const isDone = st === 'done';
      const isFail = st === 'failed';
      const isLive = !isDone && !isFail;
      /* 产物落本机：**放在 parseItem 里**（唯一被所有轮询路径共用的那一份解析），不在
         pollTask / pollMany / 各页各写一遍 —— 少一个入口就意味着「某个平台的产物永远不落盘」。
         offer 只是入队（真正下载在队列里异步做），所以同步这里调它不影响返回速度。 */
      if (isDone && window.AssetLocal) {
        const up = g('outputUrl') || raw.__url || '';
        if (up) AssetLocal.offer(prov && prov.id, {
          assetId: firstOut, genId: g('id'), url: up, model: g('model'),
          prompt: g('prompt') || (window.Api ? window.Api.promptFor(prov && prov.id, g('id')) : ''),
          duration: g('duration') ?? null, tier: g('tier'), res: g('res'), ar: g('ar'),
          count: g('count'), quality: g('quality'), format: g('format'),
          credits, priceMicros: pm, currency: g('currency') || '',
          gstatus: rawStatus, created: g('created'), completed: g('completed'),
        }, up);
      }
      // 上游没给 prompt 时用本机记录兜底（例如 VGENV 的列表与详情都不返回它），并标注来源
      const rawPrompt = g('prompt') || '';
      const localPrompt = rawPrompt ? '' : (window.Api ? window.Api.promptFor(prov.id, g('id')) : '');
      return {
        prompt: rawPrompt || localPrompt || '',
        promptLocal: !rawPrompt && !!localPrompt,
        raw,
        genId: g('id'),              // 任务号也按 list.map 声明取（创建响应把 id 嵌在别处时，靠 d.id 猜会拿不到）
        status: rawStatus,            // 原样状态（页面展示用）
        done: isDone,            // 通用判定：成功 / 进行中 / 失败（各平台措辞不同，看这三个就够）
        running: !isDone && !isFail,   // 认不出的状态归到「进行中」，由调用方继续等
        failed: isFail,
        progress: (raw.progress ?? 0),
        duration: g('duration') ?? null,
        assetId: firstOut || null,
        url: g('outputUrl') || raw.__url || null,     // __url = retrieve 环节换回来的真实地址
        expires: g('expires') ?? null,        // 签名地址的过期时间（registry 里声明 expires 才有）
        credits, priceMicros: pm != null ? Number(pm) : null, currency: g('currency') || null,
        error: g('error') || null,
        model: g('model'), tier: g('tier'), res: g('res'), ar: g('ar'),
        quality: g('quality'), count: g('count'), format: g('format'),
        created: g('created'), completed: g('completed'),
      };
    },
    /* 费用文案：按 list.priceStyle 决定「积分」还是「¥」（sparkcine 积分 / vgenv 金额） */
    priceText(prov, p) {
      if (!p) return '';
      const style = (prov && prov.list && prov.list.priceStyle) || 'micros';
      if (style === 'credits') return p.credits == null ? '' : (p.credits + ' 积分');
      return p.priceMicros == null ? '' : ('¥' + (p.priceMicros / 1e6).toFixed(4));
    },
    /* 列表来源：按 relay + list 端点去重（同一上游只拉一次） */
    listSources(filter) {
      const out = [], seen = new Set();
      const kinds = (filter && filter.kinds) || null;      // 只要某几类来源（如语音工作台只要 audio）
      const ids = (filter && filter.ids) || null;
      this.providers().forEach(p => {
        if (!p.list || !p.endpoints || !p.endpoints.list) return;
        if (kinds && !kinds.includes(p.kind)) return;
        if (ids && !ids.includes(p.id)) return;
        const k = p.relay + '|' + p.endpoints.list;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ key: p.id, prov: p, spec: p.list });
      });
      return out;
    },
  };
})();

/* ============================================================================
   AssetLocal —— 「产物自动存本机」+「地址三级回退」
   ----------------------------------------------------------------------------
   为什么要有这一层：产物地址的**有效期完全在平台手里**。SiliconFlow 视频 10 分钟、
   一批 OSS 签名地址 1 小时、平台清理任务后连 id 都不认。以前本机只把地址攥在卡片里，
   过一阵子整列变裂图，而文件其实早就可以拿下来了。现在生成完就**当场把字节存到本机资产库**，
   于是：能看的地址过期了 → 用本机那份；本机文件被删了 → 代理按索引里的 upstream 回源；
   两边都没了 → 界面上明写「已丢失」，不再是一张裂图让人猜。

   两个开关（都在设置页，与其它界面偏好放一起）：
     sk_media_local   存不存产物到本机（默认开）。**关掉它，下面整条链都退化成旧行为**。
     sk_media_prefer  显示时优先用本机文件吗（默认开）。关掉就仍然直连平台外链 ——
                      平台自己有 CDN、更快，代价是地址一过期就什么都看不了。

   一份镜像记录：{ a: 本机资产号, f: 格式, n: 名字, t: 落盘时间, b: 字节数, up: 来源外链 }
   存在 localStorage 的 sk_local_mirror 里（只是「哪条产物在本机」的指针，不放字节）。
   ======================================================================== */
(function () {
  const K_SAVE = 'sk_media_local', K_PREFER = 'sk_media_prefer', K_IDX = 'sk_local_mirror';
  const IDX_MAX = 20000;                 // 与代理的 LOCAL_INDEX_MAX 对齐：两边都截一半就会出现「存过却取不回」
  const MIRROR_MAX = 200 * 1024 * 1024;  // 单个文件超过 200MB 不镜像（存它要占几百兆，值不值由用户自己定）
  const CONCURRENCY = 2;                 // 同时最多镜像几个：一次性下十几个视频会把上行和磁盘都占满
  const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac' };

  const on = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } };
  const saveOn = () => on(K_SAVE, 'on') !== 'off';
  const preferLocal = () => on(K_PREFER, 'on') !== 'off';

  /* ---------- 按类型分别决定「存不存 / 存到哪个文件夹」（设置页「自动保存」那一卡）----------
     键 `sk_autosave`（前缀 sk_ 已跟着设置导出/云同步走），形状：
       { image:{on:'on'|'off', dir:'D:\\AI图'}, video:{…}, audio:{…} }
     **三档的默认值全是 on** —— 与以前那个总开关一致（原来就是全存），
     所以第一次打开这一项，行为一个字都没变，只是多了「按类型分开」和「另存到指定目录」两件事。
     判据只有这一份：设置页渲染、这里分流、代理读盘，三边各写一份就一定对不上。 */
  const K_AUTOSAVE = 'sk_autosave';
  /* 「上一次另存的结果」：只在**有目录**的那几档上有意义（没目录就是默认行为，没什么可失败）。
     不进同步白名单 —— 那是「刚才发生了什么」，不是「我想要什么」，跟着云同步会把
     另一台机器上的旧路径带过来，而那台机器上那个盘符多半不存在。 */
  const K_AUTOSAVE_LOG = 'sk_autosave_log';
  function setLastSave(kind, row) {
    try {
      const d = JSON.parse(localStorage.getItem(K_AUTOSAVE_LOG) || '{}') || {};
      d[kind] = row;
      localStorage.setItem(K_AUTOSAVE_LOG, JSON.stringify(d));
    } catch (e) {}
  }
  function lastSave() { try { return JSON.parse(localStorage.getItem(K_AUTOSAVE_LOG) || '{}') || {}; } catch (e) { return {}; } }
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
  function read() {
    if (idx) return idx;
    let d = null;
    try { d = JSON.parse(localStorage.getItem(K_IDX) || 'null'); } catch (e) {}
    idx = (d && typeof d === 'object' && d.m) ? d : { v: 1, m: {} };
    if (!idx.a || typeof idx.a !== 'object') idx.a = {};      // a = 本机资产号 → 记录（给「本地被删」那级回源用）
    return idx;
  }
  function write() {
    const d = read();
    const keys = Object.keys(d.m);
    if (keys.length > IDX_MAX) for (const k of keys.slice(IDX_MAX)) { delete d.a[d.m[k].a]; delete d.m[k]; }
    try { localStorage.setItem(K_IDX, JSON.stringify(d)); } catch (e) { /* 配额满：先留着内存里的，不打断界面 */ }
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
  const nameOf = (e, ext) => {
    const p = String((e && e.prompt) || '').trim().slice(0, 20).replace(/[\\/:*?"<>|]/g, '') || 'file';
    return p + '.' + ext;
  };

  const queue = [];
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, CONCURRENCY);
        await Promise.all(batch.map(runOne));
      }
    } finally { pumping = false; }
  }
  async function runOne(job) {
    const { k, url, ent } = job;
    try {
      const blob = await AssetTransfer.blobOf(url);
      if (!blob || !blob.size) throw new Error('取回字节为空');
      if (blob.size > MIRROR_MAX) { read().skip = String(read().skip || ''); return; }
      const ext = extOf(blob, ent && ent.format);
      const b64 = await blobToB64(blob);
      const r = await Api.saveLocalAsset({
        name: nameOf(ent, ext), mime: blob.type || '', format: ext,
        data: b64,
        meta: {
          prompt: (ent && ent.prompt) || '', model: (ent && ent.model) || '',
          provider: (ent && ent.provider) || '', credits: (ent && ent.credits) ?? null,
          priceText: (ent && ent.priceText) || '', duration: (ent && ent.duration) ?? null,
          upstream: url,
          /* 任务详情留底：任务号、参数、费用、耗时、状态变迁、平台原话。
             平台那边的记录会随时间被清理，索引里这一份是「当时是什么样」的本地版本。 */
          detail: ent ? {
            task: (ent && ent.genId) || (ent && ent.taskId) || '',
            model: (ent && ent.model) || '', tier: (ent && ent.tier) || '', res: (ent && ent.res) || '',
            ar: (ent && ent.ar) || '', duration: (ent && ent.duration) ?? null, count: (ent && ent.count) ?? null,
            quality: (ent && ent.quality) || '', format: (ent && ent.format) || '',
            credits: (ent && ent.credits) ?? null, priceMicros: (ent && ent.priceMicros) ?? null,
            currency: (ent && ent.currency) || '', gstatus: (ent && ent.gstatus) || '',
            created: (ent && ent.created) || '', completed: (ent && ent.completed) || '',
            promptLocal: !!(ent && ent.promptLocal), bytes: blob.size,
          } : null,
        },
      });
      if (r && r.id) {
        const d = read();
        d.m[k] = { a: r.id, f: r.format || ext, n: r.name || '', t: Date.now(), b: blob.size, up: url };
        d.a[r.id] = k;
        write();
      }
      /* ---------- 按类型另存一份到用户指定的文件夹 ----------
         存进 .assets 资产库是**应用自己的那份**（离线能看、删了能回源），不能因为用户
         想在「D:\AI图」里看到成品就不存 —— 那是两件事。所以这里是**额外再写一份**。
         三种情况都会发生，所以每一种都要有说法：
           · 目录没填        → 什么都不做（这是默认，一句话都不该打扰）
           · 写成功          → 记一笔，设置页能回看「上次存到哪、存了什么」
           · 写不进去 / 没配 → **不打断界面**（产物该显示还是显示），但记进 lastSave 供设置页显示
         静默吞掉是这里最坏的一种：用户填完目录、以为存上了，文件其实一次都没落盘。 */
      const kind = kindOf(ext, blob.type);
      const conf = autosaveConf()[kind] || null;
      if (kind && conf && conf.on) {
        try {
          if (conf.dir) {
            const s = await Api.saveToDir({ type: kind, name: r && r.name ? r.name : nameOf(ent, ext),
              mime: blob.type || '', format: r && r.format ? r.format : ext, data: b64 });
            setLastSave(kind, s && s.ok ? { ok: true, file: s.file, dir: s.dir, at: Date.now() }
              : { ok: false, why: (s && s.error && s.error.message) || '代理没有确认写入', at: Date.now() });
          } else {
            setLastSave(kind, { ok: true, skipped: true, at: Date.now() });
          }
        } catch (e) {
          setLastSave(kind, { ok: false, why: (e && e.message) || String(e), at: Date.now() });
        }
      }
    } catch (e) {
      /* 镜像失败**不打扰界面**：它是锦上添花，产物该显示还是显示。
         也不把失败写进索引 —— 下一轮列表刷新还会再 offer 一次（成功为止）。 */
    }
  }

  const queued = new Set();
  /* 提交一条产物去存本机（幂等：已存过 / 正在存 / 关掉了开关都直接跳过） */
  function offer(provId, ent, upstream) {
    if (!saveOn()) return;
    const url = String(upstream || (ent && (ent.rawSrc || ent.raw)) || '');
    if (!url || !/^https?:/i.test(url)) return;
    const k = keyOf(provId, { assetId: ent && ent.assetId, genId: (ent && (ent.genId || ent.taskId)) || '', upstream: url });
    if (!k) return;
    if (read().m[k] || queued.has(k)) return;
    queued.add(k);
    queue.push({ k, url, ent: ent || {} });
    pump();
  }
  /* 扫一批条目（列表加载、增量加载都走它） */
  function scan(entries) {
    if (!saveOn()) return;
    (Array.isArray(entries) ? entries : [entries]).forEach(e => {
      if (!e || e.kind !== 'asset' || e.localAsset) return;
      const st = e.status || '';
      if (st && st !== 'done' && st !== 'succeeded') return;
      const up = e.rawSrc || '';
      if (!up) return;
      offer(e.provider, e, up);
    });
  }

  /* 给一条**刚解析出来的条目**挂上本机镜像信息，并把 src 换成该用的那个（第一级回退）。
     在 AssetLib.normalize 里对每个资产条目调一次 —— 全项目只有这一处产生条目，
     所以「哪些页面看得到本机副本」不需要各页自己接一遍。 */
  function decorate(e) {
    if (!e || e.kind !== 'asset' || e.localAsset) return e;
    const up = e.rawSrc || '';
    e.upstreamSrc = up ? mediaSrc(up) : '';
    const k = keyOf(e.provider, { assetId: e.assetId, genId: e.genId, upstream: up });
    if (!k) return e;
    const rec = read().m[k];
    if (!rec) return e;
    e.mirrorKey = k;
    e.mirror = rec;
    e.localAsset = true;                    // 界面上可以「删除」（删的是本机那份）
    if (e.byteLength == null && rec.b) e.byteLength = rec.b;
    /* 优先用本机：src 指向 /asset/<id>，代理那边「本地没了就按索引里的 upstream 回源」，
       所以这一条 src 本身就串起了两级；不是优先用本机时保持平台外链（平台 CDN 更快）。 */
    if (preferLocal()) e.src = '/asset/' + rec.a + '?v=2';
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
    const upKey = 'u:' + mediaKey(raw);
    const rec2 = d.m['u:' + mediaKey(raw)] || Object.values(d.m).find(r => r && r.up && mediaKey(r.up) === upKey);
    if (rec2 && rec2.a && raw.indexOf('/asset/' + rec2.a) < 0) {
      el.dataset.fb = '1'; el.dataset.fbLoc = rec2.a;
      el.setAttribute('src', '/asset/' + rec2.a + '?v=2');
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
  }

  window.AssetLocal = {
    saveOn, preferLocal, offer, scan, decorate, watch,
    /* 「自动保存：按类型分别存到哪」这一项的公共接口（设置页渲染与本页分流共用一份判据）。
       设置页只负责画与存，不自己再读一遍 localStorage、更不自己判断哪一档开没开。 */
    SAVE_KINDS, autosaveConf, setAutosaveConf, kindOf, lastSave,
    /* 设置页「已存多少 / 占了多少」用：只算条数与字节，不列清单 */
    stats() {
      const rs = Object.values(read().m);
      return { count: rs.length, bytes: rs.reduce((a, r) => a + (Number(r && r.b) || 0), 0) };
    },
    /* 关掉「存本机」时清掉本机索引（**不删磁盘上的文件**：那是用户的数据，
       删不删该由资产库里那条「删除」决定，这儿只让界面别再指望它）。 */
    forget() { idx = { v: 1, m: {}, a: {} }; try { localStorage.removeItem(K_IDX); } catch (e) {} },
  };
  watch();
})();

/* ============================================================================
   AssetLib —— 生成内容列表（读 /registry 的 list 声明，平台无关）
   ========================================================================== */
(function () {
  /* 取对象点路径（'parameters.quality'） */
  function pickPath(o, path) {
    if (!path) return undefined;
    return String(path).split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
  }
  /* 媒体类型：声明优先（fixed / by+前缀），否则按 provider.kind */
  function classifyMedia(prov, spec, raw) {
    const md = spec.media || {};
    if (md.fixed) return md.fixed;
    if (md.by) {
      const v = String(pickPath(raw, md.by) || '');
      if ((md.videoPrefix || []).some(x => v.startsWith(x))) return '视频';
      if ((md.imagePrefix || []).some(x => v.startsWith(x))) return '图片';
      return md.fallback || (prov.kind === 'video' ? '视频' : '图片');
    }
    return prov.kind === 'video' ? '视频' : '图片';
  }
  /* 上游条目 → 标准条目（字段全部来自 list.map 声明）。
     外面再包一层 normalize()：先按声明解析，再交给 AssetLocal.decorate 决定这条该显示
     本机副本还是平台地址 —— **全项目只有这一个地方产出条目**，所以本地镜像这一层
     不用各页自己接一遍（以前各页各写一遍的结果就是有的页看得到、有的页永远是裂图）。 */
  function normalizeRaw(prov, spec, raw) {
    const m = spec.map || {};
    const g = k => pickPath(raw, m[k]);
    const media = classifyMedia(prov, spec, raw);
    /* gstatus 保留「上游原话（statusMap 映射过）」给用量页展示；分支判定一律走 classifyStatus ——
       以前这里只认 'queued' / 'running' 是活的，creating / pending / processing 全被算成失败卡。 */
    const gstatus = (spec.statusMap || {})[g('status')] || g('status') || 'running';
    const st = classifyStatus(spec, g('status'));
    const fmt = media === '视频' ? 'mp4' : String(g('format') || 'png').toLowerCase();
    const credits = (() => {
      const c = g('credits');
      if (c == null) return null;
      return (typeof c === 'object') ? (c.charged ?? c.held ?? null) : c;
    })();
    const priceMicros = g('priceMicros');
    /* 本机资产库（local:/local-assets）是**多家平台共用的一条列表来源**：
       同步返回的那几家（语音 / 生图）产物都落在同一个索引里，条目自己记着是谁生成的
       （保存时写进了 provider）。按它归属性 —— 否则先读到的那家会把后面读到的全标成自己，
       卡片「平台」那一行就成了假话（生出来的图写着「MiMo」）。 */
    const selfProvId = spec.selfAsset ? String((raw && raw.provider) || '') : '';
    const routedId = (prov.mediaProviders && prov.mediaProviders[media]) || '';
    const providerId = routedId || (selfProvId && selfProvId !== prov.id ? selfProvId : prov.id);
    const ownProv = (providerId && providerId !== prov.id && providerId !== routedId && window.Api)
      ? (window.Api.prov(providerId) || null) : null;
    const providerName = (ownProv && (ownProv.displayName || ownProv.name)) || prov.displayName || prov.name;
    // 上游没给 prompt 时用本机记录兜底（例如 VGENV 的接口不返回它），并标注来源
    const rawPrompt = g('prompt') || '';
    const localPrompt = rawPrompt ? '' : (window.Api
      ? (Api.promptFor(prov.id, g('id')) || Api.promptFor(providerId, g('id'))) : '');
    const base = {
      type: media, provider: providerId, providerName, format: fmt,
      prompt: rawPrompt || localPrompt || '',
      promptLocal: !rawPrompt && !!localPrompt,
      ts: g('completed') || g('created') || '',
      genId: g('id'), gstatus, model: g('model'), mode: g('mode'),
      credits, creditsRaw: g('credits'),
      priceMicros: priceMicros != null ? Number(priceMicros) : null,
      currency: g('currency') || null,
      created: g('created'), completed: g('completed'),
      quality: g('quality'), ar: g('ar'), count: g('count'),
      duration: (media === '视频' || media === '音乐' || media === '音频') ? (g('duration') ?? null) : null,
      tier: g('tier'), res: g('res'),
    };
    // 声明里多出来的字段（chars / tokens / byteLength 等）原样带到条目上，页面按需使用
    Object.keys(m).forEach(k => { if (!(k in base)) { const v = g(k); if (v !== undefined) base[k] = v; } });
    const outs = g('outputs');         // 产物 id 列表（如 output_asset_ids）
    // 或直接给可播放 URL；给不出时兜底用 retrieve 环节换回来的（raw.__url）
    const outUrl = g('outputUrl') || raw.__url || null;
    if (spec.selfAsset) base.localAsset = true;    // 本地落盘的产物：界面上可以删除
    if (st === 'done') {
      if (spec.selfAsset) {                          // 声明「条目即资产」：本地生成产物（语音等）
        return [{ ...base, kind: 'asset', id: base.genId, assetId: base.genId, status: 'done',
          src: '/asset/' + base.genId + '?v=2',
          dl: '/asset/' + base.genId + '?dl=1&name=' + encodeURIComponent((base.prompt || 'file').slice(0, 20) + '.' + fmt) }];
      }
      if (Array.isArray(outs) && outs.length) {
        return outs.map(aid => ({ ...base, kind: 'asset', id: aid, assetId: aid, status: 'done',
          src: '/asset/' + aid + '?v=2',
          dl: '/asset/' + aid + '?dl=1&name=' + encodeURIComponent((base.prompt || 'file').slice(0, 20) + '.' + fmt) }));
      }
      // 外链产物（如 VGENV 的签名地址）统一换成 /getv 本地路由：显示、抽帧、量体积都同源
      if (outUrl) return [{ ...base, kind: 'asset', id: base.genId, status: 'done',
        src: mediaSrc(outUrl), rawSrc: outUrl, dl: '/fetch?url=' + encodeURIComponent(outUrl) + '&dl=1' }];
      // 状态已成功但产物字段还没写入（接口竞态）：按「生成中」处理，刷新后自愈
      return [{ ...base, kind: 'task', id: base.genId, status: 'running', failMsg: '' }];
    }
    if (st === 'queued' || st === 'running') {
      /* 卡片上写的是标准状态（'queued' / 'running'），原始措辞留在 gstatus 里给用量页展示 ——
         以前这里把 gstatus 直接当 status，陌生的中间态（creating / processing）就落进了下面的失败分支。 */
      return [{ ...base, kind: 'task', id: base.genId, status: st }];
    }
    return [{ ...base, kind: 'task', id: base.genId, status: 'failed', failMsg: g('error') || '' }];
  }
  /* 解析 + 本地镜像装饰（decorate 只对资产条目做处理，任务条目原样返回） */
  function normalize(prov, spec, raw) {
    let out;
    try { out = normalizeRaw(prov, spec, raw); } catch (e) { return []; }
    return (Array.isArray(out) ? out : []).map(e => (window.AssetLocal ? AssetLocal.decorate(e) : e));
  }
  /* 拉一个来源的若干页：游标不前进 / 后续页失败 → 视为到底（不阻塞其它平台） */
  async function listOne(src, st) {
    const prov = src.prov, spec = src.spec, key = src.key;
    if (st.more[key] === false) return;
    const limitParam = spec.limitParam || 'limit';
    const cursorParam = spec.cursorParam || 'cursor';
    let cursor = st.cursors[key] || '';
    for (let page = 0; page < st.pages; page++) {
      if (st.more[key] === false) break;            // 上一页已到底：不再请求（否则会重复拉第一页）
      const query = new URLSearchParams();
      query.set(limitParam, String(spec.limit || 100));
      if (cursor) query.set(cursorParam, cursor);
      let d = null;
      try {
        d = await Api.request(prov, 'list', { query, noCache: st.noCache });
      } catch (e) {
        /* 读取失败只是「本次到此为止」，**不把来源标记成到底**（不能设 more=false）——
           否则一次网络抖动 / 上游 5xx 之后，这个平台在本次会话里永远不会再翻页，
           「加载更多」点了也没反应。错误照旧交给调用方（界面提示 + 可重试）。 */
        st.errors[key] = (st.errors[key] || e.message);
        st.failed[key] = true;
        console.warn('[AssetLib] ' + (prov.name || prov.id) + (cursor ? ' 翻页失败（检查游标参数声明）' : ' 列表读取失败') + '：', e.message);
        break;
      }
      const items = (spec.dataField ? d[spec.dataField] : d.data) || [];
      /* 逐条解析并就地兜错：以前一条脏数据（缺字段、类型不对）让 normalize 抛错，
         整个来源的 promise 就 rejected —— 被 allSettled 静默吞掉，表现是「这个平台的内容全不见了」。
         现在跳过坏条目、记一条可读提示（界面会显示「部分内容加载失败」）。 */
      let skipped = 0;
      const want = (typeof st.accept === 'function') ? st.accept : null;
      items.forEach(raw => {
        try {
          normalize(prov, spec, raw).forEach(entry => { if (!want || want(entry)) st.out.push(entry); });
        }
        catch (e) { skipped++; console.warn('[AssetLib] 条目解析失败（已跳过）', e, raw); }
      });
      if (skipped) st.errors[key] = '有 ' + skipped + ' 条数据解析失败（已跳过，不影响其它条目）';
      const next = Api.listCursor(prov, d);
      const firstId = items.length ? pickPath(items[0], (spec.map || {}).id || 'id') : null;
      if (!next || next === cursor || (firstId != null && firstId === st.lastFirst[key])) {
        st.more[key] = false;                       // 没有下一页 / 游标没前进 → 到底
      } else {
        cursor = next; st.lastFirst[key] = firstId;
      }
      st.cursors[key] = cursor;
      st.emit();
    }
  }

  /* 索引窗口（最近 800 条）之外的任务：按任务号回源补，**不 await** —— 补完就地改写条目再 emit 重绘，
     首屏不为它多等一个请求。数量有限（默认 20 条），查过的会进 PromptLog 的 missed 集合，不会反复问。 */
  function refillPrompts(st, limit = 20) {
    const P = window.PromptLog;
    if (!P) return;
    const want = [];
    for (const e of st.out) {
      if (want.length >= limit) break;
      if (!e.prompt && e.genId && !P.missedFor(e.provider, e.genId)) want.push(e);
    }
    if (!want.length) return;
    Promise.allSettled(want.map(e => P.findByTask(e.provider, e.genId))).then(() => {
      want.forEach(e => {
        const p = P.cached(e.provider, e.genId) || P.cachedById(e.genId);
        if (p) { e.prompt = p; e.promptLocal = true; }
      });
      st.emit();          // 查到没查到都要重绘：没查到的卡片要从「正在归档里找」改成「两边都没有」
    });
  }

  window.AssetLib = {
    /* 上游条目 → 媒体类型（'图片' / '视频' / …）：判定规则完全来自 registry 的 list.media 声明
       （fixed / by + 前缀 / fallback），页面不要再自己写模型名前缀正则。
       同一 relay 的图/视频共用一个列表接口时，页面要靠它分辨哪条属于自己。 */
    mediaOf(prov, raw) { return classifyMedia(prov, (prov && prov.list) || {}, raw); },
    /* 时间戳归一化为「毫秒」：兼容 ISO 字符串与数字（秒或毫秒） */
    tsMs(v) {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return v > 1e12 ? v : Math.round(v * 1000);
      const t = Date.parse(v);
      return isNaN(t) ? 0 : t;
    },
    /* 加载生成内容（支持增量/分批，平台无关）
       opts.pages     本次每个来源再拉几页（默认 2）
       opts.onBatch   每拉完一页回调一次（渐进渲染，先到的先显示）
       opts.out/seen  续拉时传入上一次的条目与去重集合
       opts.cursors/more  上次返回的游标状态（原样传回即可接着拉）
       opts.kinds/ids 只加载某类来源（如语音工作台只读 kind:'audio' 的平台，别去等其他平台）
       opts.accept    只要满足条件的**标准条目**（如资产库/工作台只数某类媒体）：
                      过滤发生在解析阶段，不关心的条目根本不会进 out（也不进 onBatch）
       opts.prompts   false = 不碰提示词归档（默认会先读索引、再给缺提示词的条目回源补）
       返回 { entries, cursors, more, hasMore } */
    async load(opts = {}) {
      if (opts.reg) Api.setRegistry(opts.reg);
      await Api.registry();
      /* 提示词归档索引先就位（60 秒内不重复请求，失败也只是不补显示）：
         不等它的话，首屏卡片会先渲染成「（该平台接口不返回提示词）」，要手动刷新才好看齐。
         但最多只等 2 秒（第一次用要扫整个归档目录，可能好几秒）：
         没赶上的条目由 refillPrompts() 按任务号回源补，不能让它拖慢列表。 */
      if (window.PromptLog && opts.prompts !== false) {
        try { await Promise.race([PromptLog.load(), new Promise(r2 => setTimeout(r2, 2000))]); } catch (e) {}
      }
      const st = {
        pages: opts.pages ?? 2,
        cursors: (opts.cursors && typeof opts.cursors === 'object') ? { ...opts.cursors } : {},
        more: (opts.more && typeof opts.more === 'object') ? { ...opts.more } : {},
        lastFirst: {},
        seen: (opts.seen instanceof Set) ? opts.seen : new Set(),
        out: Array.isArray(opts.out) ? opts.out : [],
        onBatch: (typeof opts.onBatch === 'function') ? opts.onBatch : null,
        accept: (typeof opts.accept === 'function') ? opts.accept : null,
        emit() {
          /* 每批到达就顺手把这批产物排去存本机（而不是等整个 load 结束）：
             列表动辄十几秒才拉完，等它结束再开始镜像，用户看到的头几分钟全是没本机副本的。 */
          try { if (window.AssetLocal) AssetLocal.scan(this.out); } catch (e) {}
          if (!this.onBatch) return;
          try { this.onBatch(this.out); } catch (e) { console.warn('[AssetLib] onBatch 回调出错：', e); }
        },
      };
      st.errors = {};
      st.failed = {};                      // 本次有读取失败的来源（more 保持 true：界面可重试）
      st.noCache = !!opts.noCache;
      const srcs = Api.listSources({ kinds: opts.kinds, ids: opts.ids });
      await Promise.allSettled(srcs.map(src => listOne(src, st)));
      if (opts.prompts !== false) refillPrompts(st);
      const hasMore = srcs.some(src => st.more[src.key] !== false);
      return { entries: st.out, cursors: st.cursors, more: st.more, hasMore, errors: st.errors, failed: st.failed };
    },
    /* 后台数总数（分页文案要显示精确的「共 N 页」用；界面见 Wb.tally）。
       平台的列表接口只有游标与 has_more，没有总数，只能一页页翻到底数出来 ——
       所以这里按**来源声明的 limit（一般 100）**走游标，比按页面每页 12 条翻到底便宜一个量级
       （101 条图片 = 2 个请求，而不是 9 个）。
       opts.kinds/ids/reg/pages/accept 与 load 同义；accept(entry) 用来只数这一页关心的条目
       （例如视频台只数 type:'视频'）。maxPages（默认 10 页 = 约 1000 条）到底前用完时
       返回 exact:false，让界面继续显示「共 M+ 页」，不要把用户引到「数完了」的假承诺上。
       返回 { total, exact, assetIds } —— total 是**去重后的条目数**，和右栏卡片数同一个口径
       （多图任务按 normalize 展开后的每个产物各算一条）；assetIds 是这些条目的产物 id 集合，
       页面要把它和本地任务记录混排时用来去重（语音台：还没落成资产的本地记录另算）。 */
    async countAll(opts = {}) {
      const maxPages = Math.max(1, Number(opts.maxPages) || 10);
      const res = await this.load({
        pages: maxPages, kinds: opts.kinds, ids: opts.ids, reg: opts.reg,
        accept: opts.accept,            // 逐条过滤：不关心的条目根本不进结果（少占内存）
        prompts: false,                 // 只数条数，不补提示词（别为数个数去翻归档）
        out: [], seen: new Set(),
      });
      const keys = new Set(), assetIds = new Set();
      (res.entries || []).forEach(e => {
        keys.add(window.AssetLib.entryKey(e));
        const aid = e.assetId || e.id;
        if (aid != null) assetIds.add(String(aid));
      });
      // 有任何来源读失败（res.failed）时 hasMore 也一定还是 true，所以 exact 这一条同时覆盖两种不精确
      return { total: keys.size, exact: !res.hasMore, assetIds };
    },
    /* 读某个来源「当前真的存在」的条目 key 集合（只读一页）。
       只对「一页即全量」的来源有意义：selfAsset 的本地资产库（删除文件后要据此清掉本机缓存里的旧条目）。 */
    async liveKeys(prov) {
      const spec = (prov && prov.list) || null;
      if (!spec) return null;
      const query = new URLSearchParams();
      query.set(spec.limitParam || 'limit', String(spec.limit || 100));
      const d = await Api.request(prov, 'list', { query });
      const items = (spec.dataField ? d[spec.dataField] : d.data) || [];
      const keys = new Set();
      items.forEach(raw => normalize(prov, spec, raw).forEach(e => keys.add(String(e.assetId || e.id))));
      return keys;
    },
    /* 条目标识：同一条目在两次拉取之间必须得到同一个 key（增量合并去重靠它） */
    entryKey(e) {
      return [((e && e.kind) || ''), ((e && (e.id || e.assetId || e.genId)) || ''), ((e && e.assetId) || '')].join('|');
    },
    /* 合并两批条目（增量加载的核心）：
       ① 同 key 以新数据为准；
       ② 消掉「任务 → 产物」跃迁造成的重复卡 ——
          列表接口在产物刚写好时会先返回 kind:'task'（生成中），下一批返回 kind:'asset'（已完成）；
          两者 genId 相同、但 key 不同（task 用任务号，asset 用产物号），只按 key 去重会同时留下两张卡；
       ③ 产物级去重：同一个产物 id 只留信息更全的一条（有 src / 状态 / 提示词的优先）。
       多图任务（同 genId 不同 assetId）不受影响 —— 它们本来就该是多条。 */
    mergeEntries(base, add) {
      const map = new Map();
      const put = e => { if (e) map.set(this.entryKey(e), e); };
      (Array.isArray(base) ? base : []).forEach(put);
      (Array.isArray(add) ? add : []).forEach(put);
      let list = [...map.values()];
      const doneGens = new Set();
      list.forEach(e => { if (e.kind === 'asset' && e.genId) doneGens.add((e.provider || '') + '|' + e.genId); });
      if (doneGens.size) {
        list = list.filter(e => !(e.kind === 'task' && e.genId && doneGens.has((e.provider || '') + '|' + e.genId)));
      }
      const score = x => (x.src ? 2 : 0) + (x.status ? 1 : 0) + (x.prompt ? 1 : 0);
      const byAsset = new Map();
      list.forEach(e => {
        const k = e.assetId ? 'a|' + (e.provider || '') + '|' + e.assetId : this.entryKey(e);
        const prev = byAsset.get(k);
        if (!prev) { byAsset.set(k, e); return; }
        byAsset.set(k, score(e) >= score(prev) ? Object.assign({}, prev, e) : Object.assign({}, e, prev));
      });
      return [...byAsset.values()];
    },
    /* 哪些条目值得进首屏缓存：**只有已完成的**。缓存里留着「生成中 / 排队中」的快照，
       下次打开就会把早已结束的旧状态当成现状，画成一条永远不动的假任务
       （新数据往往还在后面几页，覆盖不到它）。未完成的一律等接口回来说话。 */
    cacheable(e) { return !!e && (e.kind === 'asset' || e.status === 'done' || e.status === 'failed' || e.status === 'succeeded'); },
    /* 列表首屏缓存（图片 / 视频 / 语音 / 资产库 / 导演台选素材弹窗共用这一份）：
       平台的列表接口动辄 6~14 秒，接口回来前先用上次的内容把界面填上。
       放 localStorage（换标签页、重开浏览器都还在），写爆配额时退回 sessionStorage。
       四个页面以前各写一份，其中两份**没有过滤未完成条目**（就是上面那条老毛病）。
       键沿用各页原来的名字，已有的缓存不用重建。 */
    listCache(key, cap) {
      const AL = this, LIMIT = cap || 200;
      return {
        read() {
          try {
            const c = JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || 'null');
            const arr = (c && Array.isArray(c.entries)) ? c.entries : [];
            return arr.filter(e => AL.cacheable(e));
          } catch { return []; }
        },
        write(list) {
          const keep = (Array.isArray(list) ? list : []).filter(e => AL.cacheable(e));
          const payload = JSON.stringify({ ts: Date.now(), entries: keep.slice(0, LIMIT) });
          try { localStorage.setItem(key, payload); }
          catch { try { sessionStorage.setItem(key, payload); } catch (e) {} }
          return keep.length;
        },
      };
    },
    /* 取消任务：端点与方法都来自 registry 声明 */
    async cancel(entry) {
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      return Api.cancel(prov, entry.genId || entry.id);
    },
    /* 删除来源侧素材：只对「本地落盘」的资产有效（上游没有资产存储的那种，如语音合成产物）。
       端点由 registry 声明（endpoints.remove），没声明的来源会明确报错而不是静默失败。 */
    async remove(entry) {
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      if (!prov.endpoints || !prov.endpoints.remove) {
        throw new Error((prov.displayName || prov.name || entry.provider) + ' 的素材存放在平台侧，本地无法删除');
      }
      try {
        return await Api.request(prov, 'remove', { id: entry.assetId || entry.id, method: 'DELETE' });
      } catch (e) {
        // 服务端已经没有这条素材了（别的标签页删过 / 本机记录是旧的）：对调用方算删除成功，清掉本机记录即可
        if (e && (e.status === 404 || /不存在|not found/i.test(e.message || ''))) return { alreadyGone: true };
        throw e;
      }
    },
    /* 重试：按条目的标准字段重建任务（请求体由 registry 的 create 声明决定） */
    async retry(entry) {
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      return Api.create(prov, {
        model: entry.model || (prov.models && prov.models[0] && prov.models[0].id),
        prompt: entry.prompt, tier: entry.tier, duration: entry.duration, res: entry.res,
        ar: entry.ar, quality: entry.quality, count: entry.count, format: entry.format,
      });
    },
    /* 任务详情：走 Api.pollTask（统一入口，认 registry 的 pollVia:'list'，详情页不可用时退回列表按 id 找）。
       以前这里直打 Api.detail —— VGENV 的详情端点是 404 空壳，资产库的轮询每轮都 reject，
       任务卡停在「生成中」再也不收敛（AGENTS.md：页面/模块只用 Api.pollTask 这类统一入口）。
       返回值按 list.map 解析后的 p（含 status / error / genId…），调用方形状不变。 */
    async generationDetail(genId, providerId) {
      if (!genId) return null;
      const prov = Api.prov(providerId);
      if (!prov) return null;
      const r = await Api.pollTask(prov, genId);
      return (r && r.p) || null;
    },
  };
})();

/* ============================================================================
   Capabilities —— 模型能力动态获取（统一入口）
   数据源：provider 在 /registry 里声明了 endpoints.models 的平台
     · SparkCine: GET /api/open/v1/models  → 每个模型的 parameters.allowedValues
       （画质 / 分辨率 / 比例 / 输出格式 / 时长范围 / 张数上限）+ pricing（积分价）
     · VGENV: 无能力接口（404），自动回退到 registry 里声明的 options
   用法：先 fetch('/registry')，再 await Capabilities.load(REG)，之后 REG 里每个
        model.options 已被真实能力覆盖（registry 声明仅作兜底）。
   ========================================================================== */
/* 界面上一行「收什么文件」的短名（能力声明里写的是 MIME，人看的是格式名） */
const MIME_SHORT = {
  'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP', 'image/*': '图片',
  'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/*': '视频',
  'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/*': '音频',
};
window.Capabilities = {
  /* 把上游 models 结构归一化成前端用的 options */
  norm(m) {
    const P = m.parameters || {};
    const av = k => (P[k] && Array.isArray(P[k].allowedValues)) ? P[k].allowedValues.slice() : undefined;
    const rng = k => (P[k] && P[k].minimum !== undefined) ? [P[k].minimum, P[k].maximum] : undefined;
    const cap = {
      qualities: av('quality'),
      aspect_ratios: av('aspect_ratio'),
      output_formats: av('output_format'),
      resolutions: av('resolution'),
      durations: rng('duration'),
      source: 'api',
    };
    // 一次请求出几张：上游 output_count.maximum（视频一般是 1，图片可能到 4）
    cap.max_outputs = (P.output_count && P.output_count.maximum) || undefined;
    /* 上游还给了每个参数的**默认值**，界面应该用它当初始值 ——
       不然会落到下拉的第一项（例如平台默认 768p/6 秒，界面却选成 480p/4 秒，出片质量对不上）。 */
    const defs = {};
    Object.entries(P).forEach(([k, v]) => { if (v && v.default !== undefined) defs[k] = v.default; });
    if (Object.keys(defs).length) cap.defaults = defs;
    /* 布尔型参数（如 generate_audio）：界面按这份声明动态生成「开 / 关」选项，
       新平台声明了新的布尔参数就能自动出现，不用改页面。 */
    const bools = {};
    Object.entries(P).forEach(([k, v]) => { if (v && v.valueType === 'boolean') bools[k] = { def: v.default === true }; });
    if (Object.keys(bools).length) cap.bools = bools;
    const price = {};
    ((m.pricing && m.pricing.perOutput) || []).forEach(x => { if (x.quality) price[x.quality] = x.credits; });
    if (Object.keys(price).length) cap.price = price;
    if (m.pricing && m.pricing.perSecond && m.pricing.perSecond.length) {
      cap.perSecond = m.pricing.perSecond;
      cap.minimumCredits = m.pricing.minimumCredits;
    }
    // 输入规格：上游 modes.inputs 声明的输入类型与数量上限（参考图 / 参考视频 / 参考音频 / 首尾帧…）
    const modes = m.modes || {};
    // 模式名（text_to_video / voice_design / voice_clone…）：界面按它决定展示哪些输入项
    const modes0 = Object.keys(modes);
    if (modes0.length) cap.modes = modes0;
    const specs = [], seenSpec = new Set();
    Object.entries(modes).forEach(([mode, def]) => {
      (def.inputs || []).forEach(i => {
        if (!i || !i.role) return;
        const key = i.role + '|' + (i.media_type || '');
        if (seenSpec.has(key)) {
          const hit = specs.find(x => x.role + '|' + x.media === key);
          if (hit) { hit.max = Math.max(hit.max, i.max || 1); hit.modes = [...new Set([...hit.modes, mode])]; }
          return;
        }
        seenSpec.add(key);
        specs.push({ role: i.role, media: i.media_type || '', min: i.min || 0, max: i.max || 1, modes: [mode] });
      });
    });
    if (specs.length) cap.inputSpecs = specs;
    let maxRef = 0;
    specs.forEach(sp => { if (sp.role === 'reference_image') maxRef = Math.max(maxRef, sp.max); });
    if (maxRef) cap.max_ref_images = maxRef;
    return cap;
  },
  /* ---- 输入槽位与「互斥」推导（参考图 / 参考视频 / 参考音频 / 首尾帧）----
     依据只有一个：模型的能力声明。
       · 上游 /models 的 modes 是「一次请求的形状」——每个输入 role 属于哪些 mode；
         两个 role 的 mode 集合不相交，说明一次请求只能二选一 → 界面上互斥。
         例：REFERENCE_IMAGE 在 ref 模式、FIRST_FRAME 在首尾帧模式 → 传了参考图就不能再传首尾帧。
       · registry 兜底时 modes 只是能力清单（不代表请求形状），用 __reference 合成 mode 表达
         「参考图 / 参考视频 / 参考音频可共存（Ref2VA），但与首尾帧互斥（FL2VA）」。 */
  REF_ROLES: ['reference_image', 'reference_video', 'reference_audio'],
  ROLE_MODES: {
    reference_image: ['reference_images', 'image_to_video', 'multimodal_reference'],
    reference_video: ['reference_video', 'multimodal_reference'],
    reference_audio: ['reference_audio', 'multimodal_reference'],
    first_frame: ['first_last_frame'],
    last_frame: ['first_last_frame'],
  },
  /* role 的默认分组：**不同组的 role 互斥**（一次请求只能选一组）。
     首尾帧是一组，参考素材（参考图 / 参考视频 / 参考音频）是另一组 ——
     这正是「传了首尾帧就不能再传参考图」这条规则，界面据此把它们互相置灰。 */
  ROLE_GROUP: {
    first_frame: 'frame', last_frame: 'frame',
    reference_image: 'ref', reference_video: 'ref', reference_audio: 'ref',
  },
  groupOf(role, spec) { return (spec && spec.group) || this.ROLE_GROUP[role] || role; },
  /* 该模型接受哪些输入 role、上限多少。
     来源优先级：registry 的 model.inputRoles（我们按官方文档写的，最准，决定提交模板能不能真的发出去）
             > 上游能力接口的 modes.inputs（能补上我们没声明的 role，如 mask）
             > registry 的 modes 推导（老兜底）。 */
  specs(model) {
    const o = (model && model.options) || {};
    const out = new Map();
    const declared = (model && model.inputRoles) || null;
    const api = o.inputSpecs || [];
    /* 平台自己声明了输入 role（/models 的 modes.inputs）→ **以它为准**：
       界面上的参考素材入口就按平台声明显隐（模型声明支持什么，就出现什么）。
       registry 的 inputRoles 只在同一个 role 上补上限与分组 —— 因为提交模板决定了
       「一次能收几个」，比如参考音频平台写着 max 3，但模板是单个对象，就按 1 来。 */
    if (api.length) {
      api.forEach(sp => {
        const d = (declared && declared[sp.role]) || null;
        out.set(sp.role, { role: sp.role, media: sp.media || (d && d.media) || '',
          min: sp.min || 0, max: (d && d.max) || sp.max || 1,
          accept: (d && d.accept) || '', maxBytes: (d && d.maxBytes) || 0,
          group: this.groupOf(sp.role, d || sp), modes: (sp.modes || []).slice(), src: d ? 'both' : 'api' });
      });
      return [...out.values()];
    }
    if (declared) {
      Object.entries(declared).forEach(([role, d]) => {
        if (!d) return;
        out.set(role, { role, media: d.media || '', min: d.min || 0, max: d.max || 1,
          accept: d.accept || '', maxBytes: d.maxBytes || 0,
          group: this.groupOf(role, d), modes: (d.modes || []).slice(), src: 'registry' });
      });
      return [...out.values()];
    }
    const modes = (model && model.modes) || [];
    /* max 为 0（没声明）就不推这个 role：没有声明就当作平台不接受，
       而不是猜一个数 —— 猜出来的上限和平台真实上限对不上，用户传到上限才被上游拒。 */
    const push = (role, max) => {
      if (!max) return;
      const own = (this.ROLE_MODES[role] || []).filter(m => modes.includes(m));
      if (!own.length) return;
      out.set(role, { role, media: '', min: 0, max, group: this.groupOf(role),
        modes: this.REF_ROLES.includes(role) ? own.concat('__reference') : own, src: 'modes' });
    };
    // 参考图上限：只认声明（接口给的 model.maxRefImages > registry options.max_ref_images），没声明就不出现这个槽位
    push('reference_image', model && model.maxRefImages ? model.maxRefImages : (o.max_ref_images || 0));
    push('first_frame', 1);
    push('last_frame', 1);
    push('reference_video', 1);
    push('reference_audio', 1);
    return [...out.values()];
  },
  /* 某个模型某个槽位「收什么」：数量上下限 + 接受的文件类型 + 单文件字节上限。
     界面文案、统一选择器的档位与本地上传 accept、上传前的体积校验都只读这里，
     不要在页面里写死「9 张 / 10MB / mp3-wav」。没声明就是 0 / 空串（界面要显示「平台未声明」而不是猜）。 */
  rule(model, role) {
    const sp = this.specs(model).find(x => x.role === role) || {};
    return { role, max: sp.max || 0, min: sp.min || 0, accept: sp.accept || '', maxBytes: sp.maxBytes || 0, group: sp.group || '' };
  },
  /* 槽位声明 →  AssetPicker 的 types（先看声明的 media / accept；都没写就按 role 本身推） */
  slotTypes(model, role) {
    const sp = this.specs(model).find(x => x.role === role) || {};
    const s = ((sp.media || '') + ' ' + (sp.accept || '')).toLowerCase();
    if (/audio/.test(s)) return ['音频', '音乐'];
    if (/video/.test(s)) return ['视频'];
    if (/image/.test(s)) return ['图片'];
    const byRole = {
      reference_image: ['图片'], reference_video: ['视频'], reference_audio: ['音频', '音乐'],
      /* 首尾帧槽收图片，也收「选一段视频就地取帧」（见 SLOT_DEF.videoFrame）→ 两类都给 */
      first_frame: ['图片', '视频'], last_frame: ['图片', '视频'],
    };
    return byRole[role] || ['图片', '视频', '音频', '音乐'];
  },
  /* 规则 → 一行人话：「MP3 / WAV，≤ 10.0 MB」。规则对象（Capabilities.rule）与人话这一份是共用的：
     槽位标题、就绪判定、统一选择器的提示条都调它，页面不要再各拼一次。 */
  ruleLineOf(r) {
    if (!r) return '';
    const kinds = String(r.accept || '').split(',').map(x => MIME_SHORT[(x || '').trim()] || (x || '').trim()).filter(Boolean);
    return [kinds.length ? kinds.join(' / ') : '', r.maxBytes ? '≤ ' + window.fmtBytes(r.maxBytes) : ''].filter(Boolean).join('，');
  },
  /* 槽位声明 → 一行提示：「MP3 / WAV，≤10MB」；什么都没声明就返回空串（界面不显示假规矩） */
  ruleText(model, role) { return this.ruleLineOf(this.rule(model, role)); },
  /* 平台级（跨模型）的槽位字节上限：上传前校验用（那时只知道平台、不知道模型）。
     同一 role 在各模型上声明不同就取最严的一条 —— 宁可当场拦下，也不要传上去被平台拒。
     没有声明返回 0 = 不额外限制（仍受 AssetTransfer.MAX_BYTES 那道总闸管）。 */
  providerLimit(REG, providerId, role) {
    const prov = (((REG && REG.providers) || []).find(p => p && (p.id === providerId || (p.keyId || p.id) === providerId)) || {});
    let bytes = 0;
    (prov.models || []).forEach(m => {
      const b = this.rule(m, role).maxBytes;
      if (b && (!bytes || b < bytes)) bytes = b;
    });
    return bytes;
  },
  /* 互斥表（对称）：{ role: [不能与它同时使用的 role…] } —— 不同 group 即互斥 */
  conflictMap(model) {
    const specs = this.specs(model);
    const map = {};
    specs.forEach(a => {
      const ga = a.group || this.groupOf(a.role, a);
      map[a.role] = specs.filter(b => b.role !== a.role && (b.group || this.groupOf(b.role, b)) !== ga).map(b => b.role);
    });
    return map;
  },
  /* 已经同时用上的互斥组合（界面兜底 / 提交前拦截都看它）：
     返回 [[a, b], …]，空数组表示没有冲突。blockedRoles 只给「还没被用上、但已被挡住」的 role，
     判断「当前状态本身是否已经非法」必须用这个（导入 / 历史数据可能带上非法组合）。 */
  illegalPairs(model, usedRoles) {
    const map = this.conflictMap(model);
    const used = [...new Set(usedRoles || [])];
    const pairs = [];
    used.forEach((r, i) => used.slice(i + 1).forEach(r2 => {
      if ((map[r] || []).includes(r2)) pairs.push([r, r2]);
    }));
    return pairs;
  },
  /* 已经用上、但当前模型根本不接受的 role（换模型后会遇到：旧素材还在，新模型没有这个输入） */
  unsupportedRoles(model, usedRoles) {
    const have = new Set(this.specs(model).map(s => s.role));
    return [...new Set(usedRoles || [])].filter(r => !have.has(r));
  },
  /* 按「这次要用到的输入 role」挑模型：需要哪些 role，模型声明里就得都有（空 = 只要文字生成） */
  modelsFor(providers, needRoles) {
    const need = (needRoles || []).filter(Boolean);
    return (providers || []).map(p => ({
      p,
      models: ((p && p.models) || []).filter(m => {
        const have = new Set(this.specs(m).map(s => s.role));
        return need.every(r => have.has(r));
      }),
    })).filter(g => g.models.length);
  },
  /* 界面上该禁用的 role：已用到的 role 与它们互斥、且自己还没被用上 */
  blockedRoles(model, usedRoles) {
    const map = this.conflictMap(model);
    const used = new Set(usedRoles || []);
    const blocked = new Set();
    used.forEach(r => (map[r] || []).forEach(x => { if (!used.has(x)) blocked.add(x); }));
    return blocked;
  },
  /* 提交前的兜底：互斥的输入里只保留一组（界面已阻止新造出这种状态，这里只兜住导入的历史数据）
     优先级：首尾帧 > 参考图 > 参考视频 > 参考音频 */
  submitRoles(model, usedRoles) {
    const map = this.conflictMap(model);
    const PRIORITY = ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'];
    const rank = r => { const i = PRIORITY.indexOf(r); return i < 0 ? PRIORITY.length : i; };
    const keep = new Set(), drop = new Set();
    [...new Set(usedRoles || [])].sort((a, b) => rank(a) - rank(b)).forEach(r => {
      if ([...keep].some(k => (map[k] || []).includes(r))) drop.add(r);
      else keep.add(r);
    });
    return { keep, drop };
  },
  /* ---- 本地能力接口（/capabilities）----
     页面不再直连各平台的能力端点（地址 / 密钥 / 返回格式各不相同），统一问代理这一条路由；
     代理负责找端点、注入密钥、失败时回退到 registry 声明，并附上 source / note 说明来源。
     新增平台只要在 registry 里写 endpoints.models，这里无需改动。 */
  async fetchCaps(prov, opts) {
    if (this.unavailable) return null;                 // 代理版本太旧（没有这条路由）：不再反复试
    const q = '/capabilities?provider=' + encodeURIComponent(prov.id) + ((opts && opts.force) ? '&noCache=1' : '');
    let r;
    try { r = await window.Net.fetch(q, { timeout: 25000, retry: 0 }); }
    catch (e) { console.warn('[Capabilities] 能力接口不可用：', e.message); return null; }
    if (r.status === 404) { this.unavailable = true; console.warn('[Capabilities] 代理没有 /capabilities 路由（重启 proxy.js 即可）'); return null; }
    if (!r.ok) throw new Error('能力接口 HTTP ' + r.status);
    return await r.json();
  },
  /* 把能力合并进 REG 里对应平台的模型声明：接口优先，registry 声明兜底 */
  apply(REG, providerId, capsById) {
    const list = (REG && REG.providers) || [];        // 注册表还没就绪时不要抛错
    const prov = list.find(p => p.id === providerId || (p.keyId || p.id) === providerId);
    if (!prov) return 0;
    let n = 0;
    (prov.models || []).forEach(m => {
      const cap = capsById[m.id];
      const base = Object.assign({}, m.options || {});
      if (!cap) { m.options = base; return; }          // 接口没给这个模型 → 保留声明
      const merged = Object.assign(base, {});
      /* forceOptions：registry 里声明「这一项不许被能力接口覆盖」。
         用在平台声明与实测不符的地方 —— 例如 SparkCine 生图声明了 jpeg/webp，
         实测（产物字节头 / mime_type / 文件名）却永远是 png，那就以实测为准，不给假选项。 */
      const forced = new Set(m.forceOptions || []);
      Object.keys(cap).forEach(k => { if (cap[k] !== undefined && !forced.has(k)) merged[k] = cap[k]; });
      m.options = merged;
      /* 下面几个字段以前无条件被能力接口覆盖：forceOptions 保护不到它们，
         「平台声明与实测不符」时（例如 SparkCine 只出 PNG、价格表要锁死）会出现假信息。 */
      if (cap.price && !forced.has('price')) m.price = Object.assign({}, m.price || {}, cap.price);
      if (cap.perSecond && !forced.has('perSecond')) m.perSecond = cap.perSecond;
      if (cap.max_ref_images && !forced.has('max_ref_images')) m.maxRefImages = cap.max_ref_images;
      n++;
    });
    return n;
  },
  /* 拉某个平台的最新能力并合并；返回代理给的原始答复（含 source / note） */
  async refreshProvider(REG, prov, opts) {
    const d = await this.fetchCaps(prov, opts);
    if (!d) return null;
    const byId = {};
    Object.entries(d.models || {}).forEach(([id, raw]) => { byId[id] = this.norm(raw); });
    const n = this.apply(REG, prov.id, byId);
    this.sources = this.sources || {};
    this.sources[prov.id] = { from: d.source, note: d.note || '', at: Date.now(), cached: !!d.cached, models: n };
    return d;
  },
  /* 这个平台的能力是哪来的（界面用它提示「上游接口」还是「平台声明兜底」） */
  sourceOf(prov) { return ((this.sources || {})[prov && prov.id]) || null; },
  /* 启动时把所有平台的能力拉一遍（保持原签名；失败静默，界面用 registry 兜底）
     **并发限流，不是一个一个来**：注册表里十几家平台，每家一次请求、各自最多 25 秒超时，
     串行的话慢的那一家就把「能力声明还没回来」这件事拖到几十秒 —— 各页首屏因此会长时间
     显示「还没配接口 / 一次只能出一张 / 型号下拉空」，而密钥其实好好地配着。
     4 路并发：既能把这段时间压到几秒，又不至于把上游打出限流。
     结果按模型 id 汇总（byId 是字典，合并顺序不影响结果），与串行版完全等价。 */
  async load(REG, opts) {
    const byId = {};
    this.sources = {};
    /* 只向**本机已经在用**的平台问能力，判据只有一份：`Api.provUsable`
       （自定义添加的 / 设置页填了密钥的 / `.env` 里有环境密钥的 —— 设置页「供应商与密钥」那张卡
       与侧栏余额用的是同一个函数，这里再用第三份就会出现「只配了 3 家却挨个问了十几家」）。
       原来按注册表全量问：注册表里十几家平台，每家一次能力请求，用户根本没碰过的那些也照问不误 ——
       白等好几秒、白耗上游额度，界面上还完全看不出区别。 */
    let env = {};
    let envKnown = false;
    try {
      if (window.Api && Api.envStatus) {
        env = await Api.envStatus();
        envKnown = !!(Api.envKnown && Api.envKnown());
      }
    } catch (e) { env = {}; envKnown = false; }
    const all = (REG.providers || []).filter(p => (p.models || []).length);
    const usable = p => !window.Api || !Api.provUsable ? true : Api.provUsable(p, env);
    /* 知道「哪几家有环境密钥」才敢筛；`/env-status` 没取到时退回全量 ——
       那时是**不知道**哪几家在用，不是「一家都没有」，拿「不知道」当「没有」
       会把真正在用的那几家能力全丢掉，界面上表现为型号下拉全空且不报错。 */
    const canJudge = !!(envKnown && window.Api && Api.provUsable);
    const provs = canJudge ? all.filter(usable) : all;
    console.log('[Capabilities] 问 ' + provs.length + '/' + all.length + ' 家'
      + (canJudge ? '（本机在用的：' + provs.map(p => p.id).join(', ') + '）'
        : '（/env-status 没取到，退回全量：不知道哪几家在用）')
      + '｜跳过：' + (canJudge ? all.filter(p => !usable(p)).map(p => p.id).join(', ') : '无'));
    const one = async (p) => {
      try {
        const d = await this.refreshProvider(REG, p, { force: opts && opts.force });
        if (d && d.models) Object.assign(byId, d.models);
      } catch (e) { console.warn('[Capabilities] ' + p.id + ' 能力读取失败：', e.message); }
    };
    const CAP_CONC = 4;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CAP_CONC, provs.length) }, async () => {
      while (i < provs.length) { const p = provs[i++]; await one(p); }
    }));
    const n = Object.keys(byId).length;
    if (n) console.log('[Capabilities] 已取得 ' + n + ' 个模型的能力：', Object.keys(byId).join(', '));
    else console.warn('[Capabilities] 未取得模型能力（平台可能没有能力接口），使用 registry 兜底声明');
    this.models = byId;
    return byId;
  },
};

/* ============================================================================
   Fav —— 我的收藏（跨页面共用）
     · 收藏资产库文件：{ key:'a:<provider>:<assetId>', kind:'asset', provider, providerName,
                        assetId, type, prompt, src, dl, format, duration, ts }
     · 收藏本地文件：  { key:'l:<fileKey>', kind:'local', fileKey, name, mime, type, size, ts }
       文件本体存在 IndexedDB（fav_db / files），显示时取 blob URL
     · 页面用 Fav.list() 画列表；收藏按钮用 Fav.toggle(...)；变化时派发 'fav-change' 事件
   ========================================================================== */
(function () {
  const KEY = 'fav_items';
  /* 开库、连接复用、失败不缓存（隐私模式 / 别的标签页占用）全在 ui.js 的 Kv 里，
     库/表名也只在那边的登记表里写一次（fav = fav_db/files）。
     本页可能在 ui.js 之前加载，所以取 window.Kv，而且只在函数里取（调用时才解析）。 */
  const favKv = () => window.Kv.at('fav');
  function idbPut(k, v) { return favKv().put(k, v); }
  function idbGet(k) { return favKv().get(k); }
  function idbDel(k) { return favKv().del(k).catch(() => {}); }

  /* blob URL 缓存：**有上限 + 可回收 + 按最近使用淘汰（LRU）**
     （以前只增不减，翻收藏列表会一直吃内存；只按插入顺序淘汰时，
       反复打开的同一个收藏项会因为被「续期」而把其它项挤掉 —— 命中时重新插入即可） */
  const urlCache = new Map();                  // fileKey → blobURL
  const URL_CACHE_MAX = 60;
  function cacheUrl(fileKey, url) {
    if (urlCache.has(fileKey)) urlCache.delete(fileKey);
    while (urlCache.size >= URL_CACHE_MAX) {
      const [k, u] = urlCache.entries().next().value;
      try { URL.revokeObjectURL(u); } catch {}
      urlCache.delete(k);
    }
    urlCache.set(fileKey, url);
  }
  /* 命中即续期（LRU）：返回地址的同时把它挪到队尾 */
  function touchUrl(fileKey) {
    const u = urlCache.get(fileKey);
    if (u === undefined) return '';
    urlCache.delete(fileKey);
    urlCache.set(fileKey, u);
    return u;
  }
  function releaseUrl(fileKey) {
    const u = urlCache.get(fileKey);
    if (u) { try { URL.revokeObjectURL(u); } catch {} urlCache.delete(fileKey); }
  }
  // 页面卸载时统一回收
  window.addEventListener('beforeunload', () => { urlCache.forEach(u => { try { URL.revokeObjectURL(u); } catch {} }); urlCache.clear(); });
  /* 收藏项变了：只更新本地缓存，不主动重画（页面自己决定怎么刷新，避免打字时被重绘打断） */
  /* 读写都走 ui.js 的 Store：信封里的 ts 让「浏览器 ↔ .data/」能判出谁新（裸数组那份做不到） */
  const list = () => { const a = window.Store && Store.read(KEY, []); return Array.isArray(a) ? a : []; };
  function write(arr, opts) {
    const r = window.Store && Store.write(KEY, Array.isArray(arr) ? arr : [], { label: '收藏' });
    const ok = !!(r && r.ok);
    if (opts && opts.silent) return ok;      // 静默写：不广播事件（编辑备注时用，免得页面重画打断输入）
    /* 事件里带上 failed：写不进去时页面重画出来的就是**真实**状态（未收藏），
       不能按「已收藏」渲染然后刷新后消失。 */
    try { window.dispatchEvent(new CustomEvent('fav-change', { detail: { local: true, failed: !ok } })); } catch (e) {}
    return ok;
  }
  const typeOfName = n => (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(n) ? '图片'
    : (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(n) ? '视频'
    : (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(n) ? '音频' : '文件')));

  /* 收藏一条「接口不返回提示词」的资产时，如果这条的提示词还没补上（列表那一轮回源没赶上），
     后台按任务号从本机归档补一次再写回 —— 否则「先收藏、提示词后到」的记录会永远空着，
     收藏页的卡片、搜索和导出 CSV 都跟着缺。只问声明了 noPromptField 的平台，别白跑请求。 */
  function fillFavPrompt(item) {
    const P = window.PromptLog;
    if (!P || !item || item.prompt) return;
    const id = item.genId || item.assetId || '';
    if (!id) return;
    const prov = window.Api && Api.prov ? Api.prov(item.provider) : null;
    if (!prov || !prov.noPromptField) return;
    P.findByTask(item.provider, id).then(p => {
      if (!p) return;
      const arr = list();
      const hit = arr.find(x => x.key === item.key);
      if (!hit || hit.prompt) return;
      hit.prompt = p;
      write(arr, { silent: true });      // 静默写：不广播 fav-change，免得打断正在输入的备注（下次渲染自然带上）
    }).catch(() => {});
  }

  /* 签名外链的过期判定与回源都改用模块作用域那一份（mediaExpired / healMedia）：
     收藏、导演台工作区、缩略图抽帧要判的是同一件事，写两份就会有一份漏掉。
     这里只留「换到的新地址怎么落盘」——那是收藏自己的存储。 */
  let pendingUrls = null, urlWriteTimer = 0;
  function writeUrlBack(key, url) {
    pendingUrls = pendingUrls || new Map();
    pendingUrls.set(key, url);
    clearTimeout(urlWriteTimer);
    urlWriteTimer = setTimeout(() => {
      const todo = pendingUrls; pendingUrls = null;
      if (!todo || !todo.size) return;
      const arr = list();
      let hit = 0;
      arr.forEach(x => { const u = todo.get(x.key); if (u) { x.src = u; x.dl = u; hit++; } });
      if (hit) write(arr, { silent: true });      // 静默：换地址不该把正在渲染的列表打断
    }, 600);
  }
  /* 收藏项 → healMedia 认识的记录（任务号优先，没有就退到资产号） */
  const healRec = item => ({ ...item, url: item.src || item.dl || '',
    id: item.genId || item.assetId || '' });

  window.Fav = {
    list,
    has(key) { return list().some(x => x.key === key); },
    assetKey(e) { return 'a:' + (e.provider || '') + ':' + (e.assetId || e.id || ''); },
    /* 把一条资产条目变成收藏项 */
    fromEntry(e) {
      const it = { key: this.assetKey(e), kind: 'asset', provider: e.provider, providerName: e.providerName,
        assetId: e.assetId || e.id, genId: e.genId || '', type: e.type, prompt: e.prompt || '',
        src: mediaSrc(e.src || ''), dl: e.dl || '', rawSrc: e.rawSrc || '',
        format: e.format || '', duration: e.duration || null, ts: Date.now() };
      fillFavPrompt(it);
      return it;
    },
    /* add 返回收藏项（落盘失败返回 null）；remove 返回是否删成功（写不进去 = false） */
    add(item) { return write([item].concat(list().filter(x => x.key !== item.key))) ? item : null; },
    remove(key) {
      const hit = list().find(x => x.key === key);
      if (hit && hit.kind === 'local' && hit.fileKey) { idbDel(hit.fileKey); releaseUrl(hit.fileKey); }
      return write(list().filter(x => x.key !== key));
    },
    /* 返回「这条现在在不在收藏里」。落盘失败时返回**真实状态**：
       以前无条件返回 true/false，页面按「已收藏」渲染，刷新后又消失。 */
    toggle(item) {
      if (this.has(item.key)) { this.remove(item.key); return this.has(item.key); }
      this.add(item);
      return this.has(item.key);
    },
    /* 备注：收藏的用途说明，搜索和文字 AI 都会用 */
    note(key) { const hit = list().find(x => x.key === key); return (hit && hit.note) || ''; },
    /* opts.silent：只落盘不广播 fav-change（页面正在编辑备注时用，避免整列表重画把输入打断） */
    setNote(key, note, opts) {
      const arr = list();
      const hit = arr.find(x => x.key === key);
      if (!hit) return;
      hit.note = String(note || '').trim().slice(0, 300);
      write(arr, opts);
      return hit.note;
    },
    /* 命中备注的搜索（页面搜索框用） */
    search(q) {
      const s2 = String(q || '').trim().toLowerCase();
      if (!s2) return list();
      return list().filter(x => ((x.note || '') + ' ' + (x.prompt || '') + ' ' + (x.name || '') + ' ' + (x.providerName || '') + ' ' + (x.type || '')).toLowerCase().includes(s2));
    },
    /* 给文字 AI 看的清单：名称 / 类型 / 备注（备注是重点，AI 据此判断用途） */
    text(limit) {
      return list().slice(0, limit || 80).map((x, i) => ({
        序号: i + 1, 名称: (x.prompt || x.name || '').slice(0, 80) || '(无名称)', 类型: x.type,
        来源: x.kind === 'local' ? '本地上传' : (x.providerName || '资产库'),
        备注: x.note || '', 收藏ID: x.key,
      }));
    },
    /* 上传本地文件到收藏（本体进 IndexedDB）。失败会让调用方拿到异常，不再静默 */
    async addLocalFile(file) {
      if (!file || !file.size) throw new Error('文件是空的');
      const fileKey = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        await idbPut(fileKey, file);
      } catch (e) {
        throw new Error('存不进浏览器本地库（' + (e && e.message ? e.message : '可能是隐私模式或空间不足') + '）');
      }
      return this.add({ key: 'l:' + fileKey, kind: 'local', fileKey, name: file.name || '未命名文件',
        mime: file.type || '', type: typeOfName(file.name || ''), size: file.size || 0, ts: Date.now() });
    },
    async localUrl(fileKey) {
      const hit = touchUrl(fileKey);
      if (hit) return hit;
      const b = await idbGet(fileKey).catch(() => null);
      if (!b) return '';
      const u = URL.createObjectURL(b);
      cacheUrl(fileKey, u);
      return u;
    },
    /* 显示地址：本地文件取 blob，远程用资产地址
       （过期签名由 mediaSrc 换成会话内回源到的新鲜地址，这里不用再判） */
    async urlOf(item) {
      if (!item) return '';
      if (item.kind === 'local') return await this.localUrl(item.fileKey);
      // 老收藏里可能存着外链 src：这里统一换成 /getv 本地路由（显示与取字节都同源）
      return mediaSrc(item.src || item.dl || '');
    },
    /* 这条地址是不是「签名已过期」的外链（只看地址里的 Expires，不发请求）。
       页面首屏一律先给旧地址画出来，过期的那份放后台按任务号回源换新再局部重画 ——
       urlOf 里直接 await 回源的话，收藏一多首屏就被几个平台的慢接口拖住。 */
    expired(u) { return mediaExpired(u); },
    /* 按任务号换一条新鲜的产物地址；不是签名外链 / 没有任务号 / 平台接口失败 → 空串 */
    async refreshUrl(item, cur) {
      if (!item || item.kind === 'local') return '';
      const s = cur || mediaSrc(item.src || item.dl || '');
      if (!mediaExpired(s)) return '';
      let out = '';
      await healMedia([healRec(item)], { limit: 1,
        onFresh: (rec, next) => { out = next; writeUrlBack(rec.key, next); } });
      return out;
    },
    /* 一批收藏的后台回源：收藏可能有好几百条，全放出去就是同时打几百次平台列表接口
       （一次动辄 6~14 秒），既拖死浏览器也把上游打爆 —— 限量在 healMedia 里，
       并且同一平台整批只问一次（Api.pollMany 认 registry 的 pollVia:'list'）。
       onDone(收藏项, 新地址) 由页面决定怎么局部重画。返回真换到的条数。 */
    async resignSome(recs, onDone, opts) {
      const stale = (recs || []).filter(r => r && r.kind !== 'local'
        && (r.genId || r.assetId) && mediaExpired(r.src || r.dl || ''));
      return healMedia(stale.map(healRec), { limit: (opts && opts.limit) || 12,
        onFresh: (rec, next) => { writeUrlBack(rec.key, next); try { onDone && onDone(rec, next); } catch (e) {} } });
    },
    /* 取回文件本体（交给上传/转存流程用）：先判 HTTP 状态，别把 404 页面当素材 */
    async blobOf(item) {
      if (!item) return null;
      let u = await this.urlOf(item);
      /* 这里是真要拿字节的，跟渲染不一样：地址过期就先回源换新的，
         否则请求过去只会收到 403（签名外链放几天必然如此）。 */
      if (u && this.expired(u)) u = (await this.refreshUrl(item, u)) || u;
      if (!u) return null;
      const b = await window.Net.blob(u, { timeout: 120000 });
      return b;
    },
    /* 收藏里的本地文件 → File 本体。少了它，调用方（studio 的槽位、导演台的画面槽）
       只能按「资产库素材」去转存，转存失败又被 catch 吞掉，槽里留下一个只有会话内
       blob 地址、assetId 为空的条目 —— 看着加进去了，刷新就没了。 */
    async fileOf(item) {
      if (!item || item.kind !== 'local' || !item.fileKey) return null;
      const b = await idbGet(item.fileKey).catch(() => null);
      return (b && typeof b === 'object' && b.size != null) ? b : null;
    },
    /* 收藏项 → 选择器里那种"条目"（localFav 标记让调用方知道要转 dataURL/上传） */
    async asEntry(item) {
      const u = await this.urlOf(item);
      return { kind: 'asset', id: item.key, assetId: item.assetId || '', provider: item.provider || 'fav-local',
        providerName: item.kind === 'local' ? '我的收藏（本地）' : (item.providerName || '我的收藏'),
        type: item.type, prompt: item.prompt || item.name || '', src: u, dl: u,
        format: item.format || ((item.name || '').split('.').pop() || ''), duration: item.duration || null,
        localFav: true, favItem: item, localAsset: item.kind === 'local',
        file: await this.fileOf(item) };
    },
  };
})();

/* ============================================================================
   AiGen —— 「就地生成一张图」的最小实现（导演台的开头画面 / 时间切片用它；选择器不含生成入口）
     · 只走统一层：Api.create（幂等键 / 提示词归档 / 长超时都在里面）+ Api.pollTask
       （Api.pollTask 认 registry 的 pollVia:'list'，页面自己写轮询循环就会踩 VGENV 那个坑）
     · 产物统一包成 AssetLib 同构条目，调用方拿到就能直接当素材用
   ========================================================================== */
window.AiGen = {
  QUALITY_ZH: { draft: '草稿', standard: '标准', final: '精修' },
  /* 任务响应里的产物资产 id：既认 registry 列表映射声明的字段，也认几种常见写法 */
  outputIds(prov, raw) {
    if (!raw) return [];
    const m = ((prov && prov.list) || {}).map || {};
    const ids = [];
    const push = v => { const id = typeof v === 'string' ? v : (v && (v.asset_id || v.assetId || v.id)); if (id) ids.push(String(id)); };
    const flat = v => (Array.isArray(v) ? v : (v ? [v] : []));
    if (m.outputs) flat(Api.pick(raw, m.outputs)).forEach(push);
    flat(raw.output_asset_ids).forEach(push);
    flat(raw.outputs).forEach(push);
    flat(raw.output).forEach(push);
    return [...new Set(ids)];
  },
  /* PCM16 裸流封成 WAV（语音平台的同步产物要能直接播放/保存） */
  pcm16ToWav(b64, sampleRate) {
    const pcm = atob(b64);
    const n = pcm.length;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate || 24000, true); v.setUint32(28, (sampleRate || 24000) * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, pcm.charCodeAt(i));
    return buf;
  },
  b64FromBuf(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); },
  _entry(prov, o) {
    return { kind: 'asset', id: o.assetId || o.id, assetId: o.assetId || '', genId: o.genId || '', status: 'done',
      type: o.type, provider: prov.id, providerName: 'AI 生成 · ' + (prov.displayName || prov.name || ''),
      prompt: o.prompt || '', format: o.format || '', duration: o.duration || null,
      ts: new Date().toISOString(), src: o.src || ('/asset/' + o.assetId + '?v=2'),
      dl: o.dl || ('/asset/' + o.assetId + '?dl=1') };
  },
  /* 生成图：create → 轮询到 done → 取产物 id。
     `o.count` = 想要几张（候选一次出多张就靠它）。上限**不在这写死**：调用方按能力声明
     `max_outputs` 传进来，这里只兜底成 1；一张时返回的就是这一条条目（旧调用方照旧用 `.src`），
     多张时额外带 `entries[]`（`src` 仍是第一张，所以没有一处要改）。 */
  async image(o) {
    const prov = o.prov, m = o.model || {};
    const fmts = (m.options && m.options.output_formats) || ['png'];
    const fmt = fmts.includes('png') ? 'png' : fmts[0];
    const want = Math.max(1, Number(o.count) || 1);
    const gen = await Api.create(prov, {
      model: m.id, prompt: o.prompt, quality: o.quality, ar: o.ar, count: want, format: fmt,
      /* 参考图条目（短剧的「三视图按预览图生成」用它）：形状由 registry 的 inputTemplates 决定，
         调用方给的是 AssetTransfer.entryFor 出来的 { role, assetId|url }。没传就不带这个字段。 */
      inputEntries: o.inputEntries,
      log: o.log || { type: '图片生成', meta: { 画质: o.quality || '', 画幅: o.ar || '' } },
    });
    const p0 = Api.parseItem(prov, gen);
    const id = (p0 && p0.genId) || (gen && (gen.id || gen.task_id || gen.job_id));
    if (!id) throw new Error((gen && (gen.message || gen.code)) || '接口没有返回任务号');
    /* 轮询只看得到什么就取什么：产物号 / 外链先出现就立刻收（状态字段常常比产物字段晚一两个心跳）。
       失败以 Api.parseItem 的判定为准 —— 它已经把「认不出的中间态」归到进行中，不会一次就误报失败。 */
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 2500));
      let raw = null;
      try { raw = (await Api.pollTask(prov, id)).raw; } catch (e) { continue; }
      const p = raw ? Api.parseItem(prov, raw) : null;
      const ids = this.outputIds(prov, raw);
      /* 多张时要等到凑齐（或平台已经判完成）再收：只取 ids[0] 的话，
         「一次出 3 张候选」会变成「一次出 1 张、另外 2 张永远看不见」，
         而界面已经写了「正在出第 2、3 张」。 */
      if (ids.length && (ids.length >= want || (p && p.done))) {
        const list = ids.slice(0, want).map(a => this._entry(prov, { assetId: a, genId: id, type: '图片', prompt: o.prompt, format: fmt }));
        return Object.assign(list[0], { entries: list });
      }
      /* 产物是外链的不是资产 id（VGENV 这类）：一样换成 /getv 本地路由再回给调用方，
         否则拿到的是过期就 403 的签名地址。 */
      if (p && p.url) {
        const one = this._entry(prov, { id: id, genId: id, type: '图片', prompt: o.prompt, format: fmt,
          src: Api.mediaSrc(p.url), dl: '/fetch?url=' + encodeURIComponent(p.url) + '&dl=1' });
        return Object.assign(one, { entries: [one] });
      }
      const why = p && p.error && (p.error.message || p.error);
      if (why) throw new Error(why);
      if (p && p.failed) throw new Error('图片生成失败' + (p.status ? '（' + p.status + '）' : ''));
    }
    throw new Error('生成超时（可能还在排队），稍后可在资产库看到它');
  },
};

/* ============================================================================
   AssetPicker —— 全站唯一的「选择参考素材」弹窗（导演台 / 生图台 / 视频台 / 语音台共用）
     const list = await AssetPicker.open({ types: ['图片'], multiple: true, limit: 9, title: '选择参考图' });
     返回 AssetLib 同构条目数组（含 assetId / src / dl / type / prompt / duration …）。
     三个入口在同一套界面里：资产库 / 我的收藏 / 本地上传。
       · aiSearch:true —— 显示「AI 检索」入口（只在素材堆里挑，不生成）
       · upload:false  —— 关掉「本地上传」；upload:{ accept, multiple } 可覆盖按 types 推出的接受类型
       · note          —— 标题下的一行说明（例如「选视频则取它的最后一帧」）
       · onPick(entry) —— 单选时想拿到条目就走回调而不是等 Promise（弹窗会自己关掉）
     条目上可能带的来源标记：fromLocal（本机文件，src 是 blob 地址，带 file）
     这里不放生成入口：要出图 / 出视频 / 出语音都去对应的工作台，它们才是生成地方。
   ========================================================================== */
window.AssetPicker = {
  open(opts) {
    const o = Object.assign({ types: ['图片', '视频'], multiple: true, limit: 0, title: '从资产库选择', search: '' }, opts || {});
    /* rule = Capabilities.rule(模型, role) 的原样：{ max, accept, maxBytes }。
       数量上限、收什么类型、单文件多大**全部来自平台的能力声明**（registry 兜底或上游 /models），
       页面不再自己写「最多 9 张 / 只收 mp3 / ≤10MB」；本弹窗把它们显示出来并在选择时强制。 */
    const rule = o.rule || {};
    if (!o.limit) o.limit = Math.max(0, Number(rule.max) || 0);
    const cap = Math.max(0, Number(o.limit) || 0);          // 本次还能加几个
    const total = Math.max(0, Number(rule.max) || 0);       // 这个槽位一共能收几个
    const ruleText = (window.Capabilities && Capabilities.ruleLineOf) ? Capabilities.ruleLineOf(rule) : '';
    const maxBytes = Math.max(0, Number(rule.maxBytes) || 0);
    // 只选音频时不必等图片/视频平台（kinds 交给统一加载器过滤来源）
    if (!o.kinds && o.types.length && o.types.every(t => t === '音乐' || t === '音频')) o.kinds = ['audio'];
    const wantAudio = o.types.some(t => t === '音乐' || t === '音频');
    const wantImage = o.types.includes('图片');
    const wantVideo = o.types.includes('视频');
    const upAccept = (o.upload && o.upload.accept) || [
      wantImage ? 'image/jpeg,image/png,image/webp' : '',
      wantVideo ? 'video/*' : '',
      wantAudio ? 'audio/*' : '',
    ].filter(Boolean).join(',');
    const wantUpload = o.upload !== false && !!upAccept;
    return new Promise(resolve => {
      /* 「在一堆卡片里点选多个」的语义只有一份（ui.js 的 PickSel）：点一下选/取消这一张、
         Shift 连选一段、到上限当场拦下并说明、可见顺序变了锚点作废。
         这一层只管画卡片、加载缩略图与交出条目。 */
      const pick = window.PickSel({ multiple: !!o.multiple, limit: cap, total,
        keyOf: e => dKey(e), onSync: () => syncSel(), onNote: t => say(t) });
      let ready = false;
      let favOnly = !!o.favOnly;
      let typeTab = '全部';
      let aiCond = null;                         // AI 检索条件（{keywords, after, order, limit}）

      const $ = id => dlg.querySelector('#' + id);
      const escAttr = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const escAttr0 = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // 先把弹窗显示出来（带加载动画），再去取数据，避免"点了没反应"
      const dlg = document.createElement('dialog');
      dlg.id = 'apDlg';
      dlg.innerHTML = `<div class="ap-head"><b>${o.title}</b>
        <input id="apSearch" placeholder="搜索提示词 / 描述要找的素材…" value="${(o.search || '').replace(/"/g, '&quot;')}" disabled>
        ${o.aiSearch ? `<button class="ap-chip" id="apAiBtn" title="按左边搜索框里写的描述，用 AI 在这堆素材里挑（不用另外填表）">${window.icon ? window.icon('sparkles', 12) : ''} AI 检索</button><span id="apAiChip"></span>` : ''}
      </div>
        <div class="ap-chips" id="apChips">
          <button class="ap-chip${o.favOnly ? '' : ' on'}" data-fav="0">资产库</button>
          <button class="ap-chip${o.favOnly ? ' on' : ''}" data-fav="1">${window.icon ? window.icon('star', 12) : ''} 我的收藏</button>
          ${wantUpload ? `<button class="ap-chip" data-act="upload">${window.icon ? window.icon('upload', 12) : ''} 本地上传</button>` : ''}
        </div>
        <div class="ap-chips ap-types" id="apTypes" hidden></div>
        ${o.note ? `<div class="ap-sub">${o.note}</div>` : ''}
        ${(cap || ruleText) ? `<div class="ap-ruleline" id="apRule">${
          /* 本次还能加几个 vs 这个槽位一共能收几个，是两件事，分开写清楚
             （页面上已经选了一半时，只写「最多 4 个」会让人以为这个槽位只收 4 个） */
          (total && cap && total > cap ? ['本槽位最多 ' + total + ' 个', '还能加 ' + cap + ' 个'] : (cap ? ['最多选 ' + cap + ' 个'] : (total ? ['最多 ' + total + ' 个'] : [])))
            .concat([ruleText]).filter(Boolean).map(escAttr0).join(' · ')
        }${o.multiple ? '　·　点一下选一张、再点一下取消；<b>Shift</b> 连选一段；选完按「确定」' : '　·　点一张选中，按「确定」确认'}</div>` : ''}
        <div class="ap-body">
          <div class="ap-grid" id="apGrid"></div>
          <div class="ap-empty" id="apEmpty" hidden></div>
          <div class="ap-loading" id="apLoad"><span class="ap-spin"></span>正在加载资产库…</div>
        </div>
        <div class="ap-foot"><span class="cnt" id="apCnt"></span><span class="sp"></span>
          ${o.extraLabel ? `<button class="ghost" id="apExtra">${o.extraLabel}</button>` : ''}
          <button class="ghost" id="apCancel">取消</button><button class="pri" id="apOk" disabled>确定</button></div>`;
      document.body.appendChild(dlg);
      dlg.showModal();

      const grid = $('apGrid');
      const cnt = $('apCnt');
      const okBtn = $('apOk');
      const load = $('apLoad');
      const empty = $('apEmpty');
      const search = $('apSearch');
      const typesBox = $('apTypes');

      const close = out => { try { io.disconnect(); } catch {} try { dlg.close(); } catch {} dlg.remove(); resolve(out); };
      $('apCancel').onclick = () => close([]);
      dlg.addEventListener('cancel', e => { e.preventDefault(); close([]); });
      /* 交出去之前把选中的收藏条目换成新鲜地址：渲染时那一批（最多 12 条）已经换过一轮，
         没轮到的仍然带着过期外链 —— 页面拿它去转存/引用是「真要字节」的，旧地址只会收到 403
         （表现是「转存失败 HTTP 403」，而用户看到的是刚刚才选的素材）。 */
      const resignPicked = entries => {
        const recs = (entries || []).filter(e => e && e._favRec && Fav.expired && Fav.expired(e.src));
        if (!recs.length) return Promise.resolve(entries);
        say('正在更新选中收藏的地址…');
        return Fav.resignSome(recs.map(e => e._favRec), (rec, next) => {
          const e = recs.find(x => x._favRec === rec);
          if (e) { e.src = next; e.dl = next; }
        }, { limit: recs.length }).then(() => entries, () => entries);
      };
      /* 确定也走 finish：它除了交出 Promise，还会对每个条目调一次 o.onPick。
         以前确定按钮直接 close(entries)，**只 resolve 不回调** —— 导演台的槽位全是靠 onPick 落地的
         （它不接 Promise 的返回值），于是点确定等于什么都没发生。 */
      okBtn.onclick = () => finish(pick.list());
      // 额外动作（例如导演的「接上一镜结尾」）：先关掉选择器，再交给调用方处理
      const extraBtn = $('apExtra');
      if (extraBtn) extraBtn.onclick = () => { close(null); try { o.extraAction && o.extraAction(); } catch {} };
      const finish = entries => {
        resignPicked(entries).then(es => {
          if (o.onPick) { try { es.forEach(e => o.onPick(e)); } catch {} }
          close(es);
        });
      };

      const isAudio = t => t === '音频' || t === '音乐';
      const okType = t => o.types.includes(t) || (isAudio(t) && o.types.some(isAudio));
      /* 类型筛选只在真的要选两类以上时出现（音乐/音频算同一类） */
      const typeTabs = (() => {
        const t = [...new Set(o.types.map(x => isAudio(x) ? '音频' : x))];
        return t.length > 1 ? ['全部'].concat(t) : [];
      })();

      /* ---------- 条目池：资产库 / 我的收藏 / 本次本地上传 ----------
         三个来源合成一个池，按产物号去重，并且**资产库那条优先**：收藏存的是「按下收藏那一刻」的地址，
         外链签名一过期就 403（表现就是「我的收藏的缩略图加载不出来」），而列表每次都是现场取的新鲜地址。
         排序和资产库页一致：按完成时间倒序、图片与视频混排，最新的永远在最上面。 */
      const tsOf = e => AssetLib.tsMs(e.ts) || 0;
      const idOf = e => String((e && (e.assetId || e.genId || e.id)) || '');
      const dKey = e => {
        if (e._ukey) return 'u:' + e._ukey;         // 本次本地上传：blob 地址每次都变，不能拿来当键
        const i = idOf(e);
        if (i) return 'a:' + (e.provider || '') + ':' + i;
        return e.favItem ? 'f:' + e.favItem.key : (e.src ? 's:' + e.src : 'n:' + (e.name || ''));
      };
      let libPool = [];        // 资产库列表（分批到达）
      let favPool = [];        // 只在收藏里出现的条目（本地文件收藏 + 列表还没翻到的收藏）
      const upPool = [];       // 本次「本地上传」的本地文件
      let base = [];
      const compose = () => {
        const map = new Map();
        libPool.forEach(e => { e._grp = 'lib'; map.set(dKey(e), e); });
        favPool.forEach(e => {
          const k = dKey(e), hit = map.get(k);
          if (hit) { hit.fav = true; hit._favRec = hit._favRec || e._favRec; } else map.set(k, e);
        });
        upPool.forEach(e => { e._grp = 'local'; map.set(dKey(e), e); });
        base = [...map.values()].sort((a, b) => tsOf(b) - tsOf(a));
        pick.prune(new Set(base));
      };
      const refresh = () => { compose(); paint(); };

      const inView = e => e._grp === 'local' ? true
        : favOnly ? (e._grp === 'fav' || !!e.fav) : e._grp === 'lib';
      const matchesType = e => !typeTabs.length || typeTab === '全部'
        || e.type === typeTab || (typeTab === '音频' && isAudio(e.type));
      const hay = e => [e.prompt, e.name, e.providerName, (e._favRec && e._favRec.note) || ''].join(' ').toLowerCase();
      const aiMatch = e => {
        const kw = (aiCond.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
        if (kw.length && !kw.some(k => hay(e).includes(k))) return false;
        const after = aiCond.after ? Date.parse(aiCond.after) : null;
        if (after && tsOf(e) && tsOf(e) < after) return false;
        return true;
      };
      const visible = () => {
        /* AI 条件生效时，搜索框里那句原话不再参与过滤：整句几乎不可能是某条提示词的子串，
           再 AND 一层就等于「AI 挑完了又全部筛掉」。框里的字保留着，改一下就会重新按普通关键词筛
           （见 search.oninput），点 ✕ 也能退回普通筛选。 */
        const q = aiCond ? '' : search.value.trim().toLowerCase();
        let out = base.filter(e => inView(e) && matchesType(e) && (!q || hay(e).includes(q)) && (!aiCond || aiMatch(e)));
        if (aiCond) {
          if (aiCond.order === 'asc') out = out.slice().reverse();
          out = out.slice(0, Math.max(1, Math.min(200, Number(aiCond.limit) || 30)));
        }
        return out.slice(0, 200);
      };

      /* 缩略图与卡片复用：每次筛选都 grid.innerHTML 重建的话，视频缩略图就重新取一次元数据
         （观感是"闪一下、又要等一会儿"）。卡片节点按条目留着，只把新增的插到正确位置，
         已经在位的一个字都不动；缩略图统一走 Wb.thumbs（同一份首帧缓存 + 懒加载 + 并发上限）。 */
      const nodes = new Map();          // entry → 卡片元素
      /* 计数条：从一开始就写「已选 0 / 8」，上限来自能力声明，不是选满一个才出现。
         选满时立刻说清「已选满」，不让用户以为点不动是坏了（那句话本身在 PickSel 里）。
         noteT = 正在显示的那条一次性说明的定时器句柄（0 = 现在没有说明，计数条归 countText 管）。 */
      let noteT = 0;
      const syncSel = () => {
        nodes.forEach((d, e) => d.classList.toggle('sel', pick.has(e)));
        if (!noteT) cnt.textContent = pick.countText();     // 有提示在显示时别把它顶掉
        okBtn.disabled = !pick.size;
      };
      /* 计数条两条通道（以前都直接写 #apCnt，结果提示会被下一次 paint() 当场覆盖）：
         syncSel 写常驻的「已选 N / 上限」，say 写一次性说明并在几秒后自动让位。 */
      const say = t => {
        clearTimeout(noteT);
        if (!t) { noteT = 0; cnt.textContent = pick.countText(); return; }
        cnt.textContent = t;
        noteT = setTimeout(() => { noteT = 0; cnt.textContent = pick.countText(); }, 4000);
      };
      const metaOf = e => [e._grp === 'local' ? '本地文件' : e._grp === 'fav' ? '我的收藏' : (e.providerName || ''),
        e.type, e.format ? e.format.toUpperCase() : '', e.duration ? e.duration + 's' : ''].filter(Boolean).join(' · ');
      /* ---------- 网格媒体的加载调度（慢的根因就在这里）----------
         以前一次把上百张卡片的媒体**全塞进 DOM**：图片直接请求**原图**（经代理取回，
         一张几百 KB ~ 几 MB），视频 `preload="metadata"` 也要回一段 Range —— 98 张一起抢连接，
         弹窗要等很久才出图，视频更慢。
         现在：卡片先画**占位格**（立刻能看、能点、能多选），媒体滚到附近才创建，并且**并发封顶**
         （图 6 / 视频 2）—— 首屏只加载十来张，往下滚再续。缓存命中的（Wb.thumbs 已有的小图）不受排队影响。 */
      const MEDIA_CONC = { image: 8, video: 2 };
      const mediaWait = [];
      const mediaActive = { image: 0, video: 0 };
      const pendingMedia = new Map();          // 卡片 → true
      const pumpMedia = () => {
        for (let i = 0; i < mediaWait.length; i++) {
          const job = mediaWait[i];
          const lim = MEDIA_CONC[job.kind] || 4;
          /* 这一类满了要**跳过它继续看后面的**，不是 break 整个循环：
             写成 break 时「视频槽位被占满」会连带把后面的图片也一起堵死，
             而且上面那句注释本来写的就是「后面别的类还能走」。 */
          if (mediaActive[job.kind] >= lim) continue;
          mediaWait.splice(i--, 1);
          mediaActive[job.kind]++;
          Promise.resolve().then(job.run).catch(() => {}).then(() => { mediaActive[job.kind]--; pumpMedia(); });
        }
      };
      const fillMedia = (d, e) => {
        const tb = window.Wb && window.Wb.thumbs;
        const isVid = e.type === '视频';
        const host = isVid ? d.querySelector('.ap-media') : d;
        if (!host || host.dataset.filled) return;
        host.dataset.filled = '1';
        const wait = host.querySelector('.ap-wait') || (isVid ? null : d.querySelector('.ap-wait'));
        if (wait) wait.remove();
        if (isVid) {
          host.innerHTML = tb ? tb.mediaHTML(e.src, { key: e._tkey, videoAttrs: 'preload="metadata" muted playsinline' })
            : `<video preload="metadata" muted playsinline></video><span class="tph"></span>`;
        } else {
          /* 注意这里**故意不写 loading="lazy"**：放行与否由上面的调度器说了算（视口 ±400px），
             再叠一层浏览器自己的懒加载，屏幕外那几张会被一直压着不取，
             我们的并发插槽就白占着（甚至等到 15 秒兜底才放行），反而更慢。 */
          host.insertAdjacentHTML('afterbegin', tb ? tb.mediaHTML(e.src, { type: 'image', key: e._tkey, mediaAttrs: 'decoding="async" onerror="this.style.display=\'none\'"' })
            : `<img src="${escAttr(e.src)}" decoding="async" onerror="this.style.display='none'">`);
        }
        const m = isVid ? host.querySelector('video, img') : (host.matches && host.matches('img, video') ? host : host.querySelector('img, video'));
        if (m && tb) tb.bind(isVid ? host : d, m, e.src, null, e._tkey);
        return isVid ? videoSettled(host, tb, e) : loaded(m, false);
      };
      /* 视频的插槽要等**抽帧真的落地**，不能等 `<video>` 自己的 load 事件：
         mediaHTML 给视频的标记只有 `data-src`（地址由 Wb.thumbs 拿到游离元素里去抽，抽成功后
         `_show` 把这个 `<video>` **整个换成 `<img>`**）—— 挂在这个节点上的 load/error 永远不会触发，
         于是每条视频都白占满 MEDIA_CONC.video=2 的槽位直到 15 秒兜底。
         一屏超过两条时画面就按「每 15 秒放两张」的节奏出，观感正是「视频缩略图老是加载不出来」。
         改成盯容器：出现 <img>（换图）或 .ready（标记成功）就放行，占位格里写了失败文案也放行。 */
      const videoSettled = (host, tb, e) => new Promise(res => {
        let done = false, mo = null, tm = 0;
        /* fin 会先于下面那两行执行（缓存命中就直接收工），所以 mo/tm 必须先声明再赋值：
           写成 const 就是 TDZ，报「Cannot access 'tm' before initialization」，
           整条视频卡片当场抛错 —— 表现是「筛出来的视频缩略图一个都不出」。 */
        const fin = () => { if (done) return; done = true; clearTimeout(tm); if (mo) try { mo.disconnect(); } catch {} res(); };
        const settled = () => !!host.querySelector('img') || host.classList.contains('ready')
          || (host.querySelector('.tph') || {}).textContent;
        if (!tb || settled()) return fin();                       // 缓存命中或没有缩略图层：不排队
        mo = ('MutationObserver' in window) ? new MutationObserver(() => { if (settled()) fin(); }) : null;
        if (mo) mo.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
        tm = setTimeout(fin, 22000);                              // 抽帧自身上限 20 秒，这里只多留 2 秒
      });
      /* 并发封顶要数的是**在飞的网络请求**，不是「插进 DOM 的动作」：
         插完就放行的话，一次能塞进几十个 <img>，浏览器自己再去抢连接（等于没封顶）。
         所以插槽一直占到这张图真的 load（或 error）才释放。视频走上面那条 videoSettled。 */
      const loaded = m => new Promise(res => {
        if (!m) return res();
        if (m.complete) return res();                             // 已经就绪（多半是缓存命中）
        let done = false;
        const fin = () => { if (done) return; done = true; clearTimeout(tm); res(); };
        const tm = setTimeout(fin, 15000);                        // 别让一张拉不回来的图把整队堵死
        m.addEventListener('load', fin, { once: true });
        m.addEventListener('error', fin, { once: true });
      });
      const scheduleMedia = (d, e) => {
        if (!d || pendingMedia.get(d)) return;
        pendingMedia.set(d, true);
        const kind = e.type === '视频' ? 'video' : 'image';
        // 缓存里已经有小图的（多半刚刚在别处看过）直接放行，不用排队
        const cached = (window.Wb && window.Wb.thumbs) ? Wb.thumbs.get(e.src, e._tkey) : '';
        if (cached) { fillMedia(d, e); return; }
        mediaWait.push({ kind, run: () => fillMedia(d, e) });
        pumpMedia();
      };
      const io = ('IntersectionObserver' in window)
        ? new IntersectionObserver(ents => { for (const en of ents) { if (!en.isIntersecting) continue;
            /* 条目要**从元素上取**（el._apEntry）：nodes 那张表是「条目 → 元素」，
               反过来 nodes.get(元素) 永远是 undefined —— 踩过一次，症状是占位格一个都填不上：
               观察器明明回调了，每张卡却都被当成「取不到条目」直接丢掉。 */
            const e = en.target._apEntry; if (e) scheduleMedia(en.target, e);
            io.unobserve(en.target); } },
          { root: dlg.querySelector('.ap-body'), rootMargin: '400px 0px' })
        : null;
      const build = e => {
        const d = document.createElement('div');
        d.className = 'ap-item';
        d._apEntry = e;                      // 观察器回调里回查条目用（见上）
        const tb = window.Wb && window.Wb.thumbs;
        /* 音频没有画面，给一张能试听的卡片；以前按图片渲染，表现就是「收藏里的音频全是一片灰」。 */
        let media;
        if (isAudio(e.type)) {
          media = `<span class="ap-audio">${window.icon ? window.icon('speaker', 22) : '♪'}</span>`;
        } else if (e.type === '视频') {
          /* 只先画占位：真正的 <video> 滚到附近才由调度器补上（见上面的 fillMedia） */
          media = '<span class="ap-media"><span class="ap-wait">…</span></span>';
        } else {
          media = '<span class="ap-wait">…</span>';
        }
        d.innerHTML = media + `<span class="chk">✓</span>
          <div class="m"><div class="t">${String(e.prompt || e.name || '(无名称)').replace(/</g, '&lt;')}</div>${metaOf(e)}</div>`;
        if (isAudio(e.type)) {
          const b = d.querySelector('.ap-audio');
          let au = null;
          b.onclick = ev => {
            ev.stopPropagation();
            if (!au) { au = new window.Audio(e.src); au.onended = () => { au = null; b.classList.remove('playing'); }; }
            if (au.paused) { au.play().catch(() => { cnt.textContent = '这个音频放不出来（地址可能已过期）'; }); b.classList.add('playing'); }
            else { au.pause(); b.classList.remove('playing'); }
          };
          b.title = '试听';
        }
        /* 点选语义全在 ui.js 的 PickSel 里（与素材库挑选共用一份）：
           普通点 = 选中 / 取消这一张（不要求按 Ctrl）、Shift = 连选一段、到上限当场说明原因。
           单选也是「点选 → 底部确定」，不再点一下就关窗（选错了只能重开一次）。 */
        d.onclick = ev => pick.click(visible(), e, ev.shiftKey);
        if (tb && !isAudio(e.type)) {
          /* 媒体绑定交给 fillMedia（滚到附近才做），这里不再一建卡就抢连接 */
        }
        /* 本次上传的本地文件是 blob 地址（字节已经在内存里，没有网络开销），
           不排观察器的队 —— 以前它们按文件修改时间排序，位置常常在网格很下面，
           不滚动就永远是占位符「…」，看着就是「传了文件却没有缩略图」。 */
        if (io && !e.fromLocal) io.observe(d); else scheduleMedia(d, e);
        return d;
      };
      const paint = () => {
        const shown = visible();
        /* 可见顺序变了（筛选 / 切档位 / 翻页）→ 连选锚点作废，否则 Shift 会选到不相邻的一段 */
        pick.reflow(shown);
        const keep = new Set(shown);
        for (const [e, d] of [...nodes]) {
          if (keep.has(e)) continue;
          if (io) { try { io.unobserve(d); } catch {} }     // 别让观察器攒着已删的节点
          d.remove(); nodes.delete(e);
        }
        let ref = grid.firstChild;
        shown.forEach(e => {
          let d = nodes.get(e);
          if (!d) { d = build(e); nodes.set(e, d); }
          if (d !== ref) grid.insertBefore(d, ref);   // 只有新增/换序才搬，已在位的不碰
          ref = d.nextSibling;
        });
        empty.hidden = !!shown.length || !ready;
        if (!shown.length && ready) {
          const kw = (search.value || '').trim();
          empty.textContent = aiCond ? 'AI 没在这堆素材里挑出匹配的'
            : kw ? '没有匹配「' + kw.slice(0, 20) + '」的' + o.types.join(' / ') + '，换个说法试试'
              : (favOnly ? '我的收藏里还没有' : '资产库里还没有') + o.types.join(' / ')
                + (favOnly ? '，去资产库或收藏页加几条' : '，先去生成或上传吧');
        }
        syncSel();
      };
      /* 单卡重画：后台换地址后必须重建那一格。paint() 只复用已在位的节点，
         而图片签名过期时 onerror 会把 display 设成 none —— 只改 e.src 的话那一格永远空白，
         表现就是「我的收藏里的缩略图加载不出来」。 */
      const repaint = e => {
        const old = nodes.get(e);
        if (!old) return;
        if (io) { try { io.unobserve(old); } catch {} }
        pendingMedia.delete(old);
        const d = build(e);
        nodes.set(e, d);
        old.replaceWith(d);
        // 新格子别等观察器：直接排进调度（滚动位置没变，它本来就在视口里）
        scheduleMedia(d, e);
        syncSel();
      };
      /* 改了搜索框里的字，之前编译出来的 AI 条件就不再对应这句话了：清掉它，回到普通关键词筛选 */
      search.oninput = () => { if (aiCond) { aiCond = null; paintAiChip(); } paint(); };

      const renderTypes = () => {
        if (!typeTabs.length) { typesBox.hidden = true; return; }
        typesBox.hidden = false;
        typesBox.innerHTML = typeTabs.map(t => `<button class="ap-chip${t === typeTab ? ' on' : ''}" data-t="${t}">${t}</button>`).join('');
        typesBox.querySelectorAll('.ap-chip').forEach(b => b.onclick = () => { typeTab = b.dataset.t; renderTypes(); paint(); });
      };
      const setView = on => {
        favOnly = on;
        dlg.querySelectorAll('#apChips .ap-chip[data-fav]').forEach(x => x.classList.toggle('on', (x.dataset.fav === '1') === on));
        paint();
      };
      /* 顶部档位分两类：data-fav 是视图切换，data-act 是动作（本地上传）。
         以前这里把所有 .ap-chip 都当视图切换，多一个动作按钮就会把列表清空。 */
      dlg.querySelectorAll('#apChips .ap-chip').forEach(ch => {
        if (ch.dataset.fav != null) { ch.onclick = () => setView(ch.dataset.fav === '1'); return; }
        if (ch.dataset.act === 'upload') ch.onclick = () => uploadFiles(ch);
      });
      renderTypes();

      /* ---------- 本地上传：条目只活在这次弹窗里（src 是 blob 地址，带 file 供调用方取本体） ---------- */
      const uploadFiles = chBtn => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = upAccept;
        if (o.multiple) inp.multiple = true;
        inp.onchange = () => {
          const files = [...(inp.files || [])];
          if (!files.length) return;
          const added = [];
          let tooBig = 0, wrongType = 0;
          files.forEach(f => {
            const t = (/^video\//.test(f.type) || /\.(mp4|mov|webm|m4v)$/i.test(f.name)) ? '视频'
              : (/^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|oga|flac|aac)$/i.test(f.name)) ? '音频' : '图片';
            if (!okType(t)) { wrongType++; return; }
            /* 单文件体积按能力声明当场拦：传上去才发现超限，素材已经白传一遍了 */
            if (maxBytes && f.size > maxBytes) { tooBig++; return; }
            const url = URL.createObjectURL(f);
            /* 缩略图键里不能有 '#'：Wb.thumbs.keyOf 会先 split('#')[0]，
               文件名带 # 时键被截断，缓存永远命不中（症状是每次开弹窗都重抽一遍帧）。 */
            const fkey = encodeURIComponent(f.name) + '|' + f.size + '|' + (f.lastModified || 0);
            added.push({ kind: 'local', localFav: true, localAsset: true, fromLocal: true, file: f, name: f.name,
              type: t, provider: 'local', providerName: '本地文件', prompt: f.name.replace(/\.[^.]+$/, ''),
              /* 排序用「刚传上来的时刻」而不是文件修改时间：重传一个旧文件沉到网格最底部，
                 缩略图要靠滚动才出得来，看着就像「传了文件但没有缩略图」。 */
              src: url, dl: url, ts: Date.now(), _grp: 'local', duration: null,
              format: (f.name.split('.').pop() || '').toLowerCase(),
              _ukey: fkey, _tkey: 'fav-file:' + fkey });
          });
          if (!added.length) {
            say((wrongType ? '这个位置不收其中的 ' + wrongType + ' 个文件（类型不符）' : '')
              + (tooBig ? (wrongType ? '　·　' : '') + '有 ' + tooBig + ' 个超过' + (ruleText || '平台声明的上限') : ''));
            return;
          }
          /* 单值槽位：上传 = 换选这一个，与点卡片同一套语义（先清后加）。
             以前这里直接 finish(added[0]) 关窗：既和规则条上写的「点一张选中，按确定」对不上，
             又会把用户刚点中的那一条无声丢掉（槽位里落的是新文件，不是他选的那个）。 */
          if (!o.multiple) pick.clear();
          added.forEach(e => { const i = upPool.findIndex(x => x._ukey === e._ukey); if (i >= 0) upPool.splice(i, 1); upPool.unshift(e); });
          chBtn && chBtn.classList.add('on');
          setView(false); refresh();
          /* 传上来的条目**也要进选中集合**：以前只 upPool.unshift，于是
             ① 计数条里没有它们，「已选 3 / 8」和实际拿到的 8 个对不上；
             ② 点「确定」交出的是 pick.list()，一个都传不出去 → 选完「加不进参考文件」。 */
          const got = pick.addMany(added);
          const bits = [];
          if (got) bits.push('已加入 ' + got + ' 个并选中');
          if (added.length > got) bits.push('最多 ' + cap + ' 个，多传的 ' + (added.length - got) + ' 个没选中（先取消一个再传）');
          if (tooBig) bits.push('有 ' + tooBig + ' 个超过' + (ruleText || '平台声明的上限') + '，没加进来');
          if (wrongType) bits.push('有 ' + wrongType + ' 个类型不符，没加进来');
          say(bits.join('　·　') || null);
        };
        inp.click();
      };

      /* ---------- AI 检索：把一句自然语言变成筛选条件（只筛现有条目，不生成） ---------- */
      const paintAiChip = () => {
        const c = $('apAiChip');
        if (!c) return;
        /* AI 检索出来的那句话要写在 chip 上而不是计数条上：paint() 每次重画都会覆盖 #apCnt，
           放那里的话「检索成功」这条信息一闪就没了（看起来像点了没反应）。 */
        c.innerHTML = aiCond
          ? `<span class="ap-aitag" title="${escAttr(aiCond.summary || '')}">${window.icon ? window.icon('sparkles', 11) : ''} AI 检索${aiCond.summary ? ' · ' + escAttr(String(aiCond.summary).slice(0, 18)) : ''}<button id="apAiClear" title="清除 AI 条件">${window.icon ? window.icon('close', 10) : '✕'}</button></span>`
          : '';
        const b = $('apAiClear');
        if (b) b.onclick = () => { aiCond = null; paintAiChip(); paint(); };
      };
      const runAiSearch = async () => {
        if (!window.TextAI) { cnt.textContent = 'AI 检索要配一个文字模型（设置页里填）'; return; }
        /* 检索词就是上面搜索框里的文字：不再另外弹一个「输入需求」的窗口（两个框填同一件事，
           用户要在两处来回切换）。框里没写东西就当场说清楚并把光标送回去。 */
        const q = search.value.trim();
        if (q.length < 2) {
          cnt.textContent = '先在上面搜索框里写要找什么（至少两个字），再点 AI 检索';
          search.focus();
          return;
        }
        cnt.textContent = 'AI 正在理解检索需求…';
        try {
          const reg = await Api.registry();
          const names = base.slice(0, 200).map(e => ({
            名称: String(e.prompt || e.name || '').slice(0, 80), 类型: e.type,
            来源: e.providerName || '', 备注: (e._favRec && e._favRec.note) || '',
            日期: tsOf(e) ? new Date(tsOf(e)).toISOString().slice(0, 10) : null,
          }));
          const txt = await TextAI.chat(reg,
            '你是素材检索助手，只返回 JSON，不要解释或代码块标记。把需求翻译成：{"keywords":["关键词"],"after":"YYYY-MM-DD 或 null","order":"asc|desc","limit":30,"summary":"一句话"}',
            JSON.stringify({ 需求: q, 素材: names }));
          const j = TextAI.parseJson(txt);
          if (!j) throw new Error('AI 没有给出可用的检索条件');
          aiCond = j;
          paintAiChip(); paint();
          /* paint() 会重写计数条，所以这句要放在它后面，否则「AI 检索：…」一闪就没了 */
          cnt.textContent = 'AI 检索：' + String(j.summary || q).slice(0, 46);
        } catch (e) {
          cnt.innerHTML = '<span style="color:var(--err,#dc2626)">检索失败：' + escAttr((e && e.message) || String(e))
            + ' —— 改一下搜索框里的说法再试</span>';
        }
      };
      const aiBtn = $('apAiBtn');
      if (aiBtn) aiBtn.onclick = runAiSearch;

      // 异步取数据：分批到达就分批画（慢的平台不影响先到的那批先显示）
      (async () => {
        const take = entries => {
          libPool = (entries || []).filter(e => e && e.kind === 'asset' && okType(e.type));
          ready = true;
          if (load.isConnected) load.remove();
          search.disabled = false;
          refresh();
        };
        try {
          await Api.registry();                     // 收藏回源换地址要先有注册表
          const mine = window.Fav ? Fav.list().filter(x => okType(x.type)) : [];
          /* 收藏条目一次并发取地址（本地文件要读 IndexedDB）：
             以前渲染时才同步取 blob，第一次打开弹窗时地址还没就位 → 「我的收藏一片空白」。 */
          favPool = (await Promise.all(mine.map(async x => {
            const e = await Fav.asEntry(x).catch(() => null);
            if (!e) return null;
            e._grp = 'fav'; e.fav = true; e._favRec = x;
            // 稳定缩略图键：本地文件的 blob 地址每次都变，拿它当键等于永远命不中缓存
            e._tkey = x.kind === 'local' && x.fileKey ? 'fav-file:' + x.fileKey
              : ('fav-asset:' + (x.provider || '') + ':' + idOf(x));
            return e;
          }))).filter(Boolean);
          refresh();
          const res = await AssetLib.load({
            ...(opts && opts.pages ? { pages: opts.pages } : { pages: 3 }),
            kinds: o.kinds,
            onBatch: take,
          });
          take((res && res.entries) || []);
          try { search.focus(); } catch {}
          /* 列表覆盖不到的收藏：按任务号现场回源换新鲜地址（签名过期的 /getv 会 403）。
             放后台跑，别让它拖住列表；限量与并发都在 Fav.resignSome 里。 */
          if (!window.Fav) return;
          const covered = new Set(libPool.map(dKey));
          const byKey = {};
          favPool.forEach(e => { if (e._favRec && !covered.has(dKey(e))) byKey[e._favRec.key] = e; });
          await Fav.resignSome(Object.keys(byKey).map(k => byKey[k]._favRec), (rec, next) => {
            const e = byKey[rec.key];
            if (!e || next === e.src) return;
            e.src = next; e.dl = next; repaint(e);
          });
        } catch (e) {
          if (load.isConnected) load.innerHTML = '<span style="color:var(--err,#dc2626)">资产库加载失败：' + window.esc(e && e.message ? e.message : '请检查网络或密钥') + '</span>';
        }
      })();
    });
  },
};

/* ============================================================================
   TextAI —— 文字 AI（OpenAI 兼容）统一入口
     · 供应商：REG 里 kind === 'text' 的那几条，用哪一家存 sk_text_prov（默认 OpenRouter）
     · 模型：接口 /models 拉到的 + registry 兜底 + **用户自己填的**（sk_text_models_<keyId>），
             当前选中存 sk_model_<keyId>
     · 基址：可填自定义 OpenAI 兼容地址，存 sk_base_<keyId>（走 x-up-base 头临时换基址）
   用法：await TextAI.chat(REG, systemPrompt, userPrompt)  → 返回文本
        await TextAI.chat(REG, sys, user, { images })      → 带图（模型支持识图时按 OpenAI 多模态格式提交）
        await TextAI.models(REG)                          → 返回模型 id 数组（顺带缓存「能否识图」）
        await TextAI.askPolish(REG, sys, user, opts)  → 让它判断该不该反问（返回 {need, questions[]}）
        await TextAI.visionAsync(REG)                     → 先取接口能力再判定识图
        await TextAI.polishImages(REG, [{label, src}])    → 润色要附带的图片 + 给界面看的一句说明
   ========================================================================== */
window.TextAI = {
  /* ---- 各类 AI 指令的**内置默认**（唯一一份）----
     以前这五条各有两份：设置页一份、四个工作台页面里又各抄了一份兜底串，
     改一边另一边不跟着改。现在默认文本只写在这里：
       · 设置页用它初始化输入框、也用它做「恢复默认」
       · 页面用 TextAI.prompt('video' | 'img' | 'audio') 取「用户改过的，没有就用默认」
     写这几条时统一按「身份 → 任务 → 硬性要求 → 禁止 → 输出格式」组织：
     模型对**具体约束**的遵守率远高于「请你润色得更好」这种泛泛要求，
     而「只输出结果、不要解释」这一条必须每条都写，否则模型爱加前缀与总结。 */
  DEF: {
    /* 三条润色指令（video / img / audio）末尾都会自动接上这段「补充信息」：
       把「可以反问」这件事和它的用法写进提示词，模型才知道自己有两段可选、答案会被怎么用。
       （问不问问由 AI 自己判断，判据与契约见 TextAI.askPolish；用户在设置里选「从不问」时这段也不会用到。） */
    ASK_NOTE: '补充信息：你可以在动手前向用户追问 —— 界面会先把你提的问题列成可点选的候选，'
      + '用户在每题里点选或自己写字，你的下一轮就会收到这些答案。\n'
      + '· 只有在「补上缺失信息会明显改变成片效果」时才问（典型缺口：风格取向、光线与时间、镜头怎么动、画幅、情绪基调）。\n'
      + '· 用户已经写明的不要再问；缺几项就问几项，每一题都要能点选。\n'
      + '· 收到答案后：把每条答案当作**硬约束**落实进结果，不要再自行改动，也不要再反问同一件事。',
    video: '你是资深的 AI 视频提示词工程师，把用户的镜头描述改写成视频生成模型能直接吃的高质量中文提示词。\n\n改写要求：\n'
      + '1. 保留用户的主体、动作与场景意图，只在这些维度上补细节；不要替换主题，不要新增用户没提的剧情。\n'
      + '2. 按「主体 → 动作 → 场景与时间 → 光线与色调 → 镜头语言 → 氛围质感」的顺序组织，读下来是一段连贯中文。\n'
      + '3. 镜头语言要落到具体动作（缓慢推进、环绕跟拍、固定长镜头、手持跟随、俯冲…），不要写「镜头感很好」这类空话。\n'
      + '4. 用户文字里的 @参考图1、@角色名 这类素材引用标记必须**原样保留**，不能改写、不能删。\n'
      + '5. 用户已经明确给出的风格、光线、时长、画幅、景别要尊重，不要反过来推翻。\n'
      + '6. 不要编造品牌、台词、具体人名或数字。\n\n'
      + '输出：只输出润色后的提示词本身。不要标题、不要引号、不要解释、不要 markdown、不要给多个方案。',
    img: '你是资深的 AI 图片提示词工程师，把用户的描述改写成文生图模型能直接吃的高质量中文提示词。\n\n改写要求：\n'
      + '1. 保留主体与意图，只补细节；不替换主题、不新增用户没提的元素。\n'
      + '2. 按「主体 → 动作或状态 → 构图（景别/机位/画幅）→ 光线与时间 → 风格与媒介 → 材质与细节 → 氛围」的顺序组织。\n'
      + '3. 风格要落到具体流派或媒介（写实摄影、胶片、赛博朋克、水彩、3D 渲染、扁平插画…），不要只写「高级感」「有质感」。\n'
      + '4. 用户文字里的 @参考图1 这类素材引用标记必须**原样保留**。\n'
      + '5. 用户已给的画幅、画质、光线要尊重。\n'
      + '6. 不要编造品牌、人物姓名、招牌文字。\n\n'
      + '输出：只输出润色后的提示词本身。不要标题、不要引号、不要解释、不要 markdown、不要给多个方案。',
    audio: '你是配音稿编辑，把用户给的文字改写成适合语音合成的口播稿。\n\n改写要求：\n'
      + '1. 口语化：拆成长短句，删掉「此外」「综上所述」「值得注意的是」这类书面语连接词。\n'
      + '2. 数字、百分比、英文缩写、年份写成中文读法（2024 → 二零二四；3.5% → 百分之三点五；GDP → G D P）。\n'
      + '3. 在语义停顿处断句并标好逗号句号；不用分号、破折号、省略号（合成出来会别扭）。\n'
      + '4. 保留原意与信息量：不加内容、不删条件、不加标题、不加序号。\n'
      + '5. 人名、地名、品牌按常见读法处理；读不出来的地方保留原文即可。\n\n'
      + '输出：只输出改写后的稿件本身，不要任何解释。',
    story: '你是分镜师。根据一个镜头的描述与时长，决定需要几张关键画面，并按时间顺序给出每一张的文生图提示词。\n\n要求：\n'
      + '1. 只返回 JSON，不要任何解释、不要 markdown 代码块。格式：{"frames":[{"t":0,"prompt":"画面提示词"}]}\n'
      + '2. 3–6 张；t 从 0 开始递增、不超过镜头时长、间隔尽量均匀。\n'
      + '3. 每条 prompt 写清主体、动作、构图、光线、氛围。\n'
      + '4. 不写镜头运动（推拉摇移由程序统一加，写了会打架）。\n'
      + '5. 不编造人物姓名与品牌。',
    split: '你是分镜师。把剧本或文案拆成「场景 → 镜头」，并给出适合视频生成的镜头提示词。\n\n要求：\n'
      + '1. 只返回 JSON，不要任何解释、不要 markdown 代码块。格式：\n'
      + '   {"title":"短片名","scenes":[{"name":"场景 1","shots":[{"prompt":"镜头提示词","duration":5,"note":"一句画面说明"}]}]}\n'
      + '2. 场景名简短（不超过 8 个字）；镜头时长 3–8 秒的整数，并按原文信息量分配。\n'
      + '3. prompt 写清主体、动作、场景、镜头运动、光线、氛围；不编造台词与人物姓名。\n'
      + '4. 原文的信息点要全部覆盖，不要合并成一句长镜头。\n'
      + '5. 末尾的镜头数 / 每镜时长约束由程序自动追加，你不用自己数。',
    /* ---- 拍短剧（drama.html）传给三类 AI 的指令 ----
       花括号 {xxx} 是本项目的占位符，由 drama.js 在提交前替换成当次的事实（总时长、画幅、外貌、台词…）；
       改指令时占位符可以挪位置、可以删，但别改成别的名字 —— 程序只认这一套。
       drama_story 是入口页「AI 帮我完善」（散文，允许反问）；
       下面三条不走「反问」那一段（短剧缺的信息由这三条自己补全），所以写在 NO_ASK 里。 */
    drama_story: '你是短剧编剧助手。用户给你一句或一段故事点子，把它写成**能直接拆成分镜的短剧故事梗概**。\n\n'
      + '要求：\n'
      + '1. 3~5 段话，讲清：主要人物（给名字）、他/她想要什么、拦着的是什么、转折点在哪、结尾留一个钩子。\n'
      + '2. 情节要能拍：写看得见的动作与场景，不写内心独白式的抽象描述。\n'
      + '3. 保留用户已经定下的人名、设定与结局走向，不要改成另一个故事。\n'
      + '4. 台词可以暗示，但不要在这里写完整对白（后面会由拆剧本那一步逐句生成）。\n'
      + '5. 用户没给的细节（时代、地点、职业）自己补一个常见的，不要反问。\n\n'
      + '禁止：不要解释、不要小标题、不要 markdown，只输出故事正文。',
    drama_split: '你是一位短剧编剧兼分镜师。用户给你一段故事，你要把它拆成可以直接拍的短剧剧本。\n\n'
      + '拆法：先定角色与场景，再按「谁、在哪、说什么」把故事切成若干段；每一段都要能一次拍完。\n\n'
      + '硬性要求：\n'
      + '1. 整集目标时长约 {duration} 秒。**这一家视频平台能出的单段时长只有这几个档：{durs} 秒** —— '
      + '每段的 wantSec 只能从这几个数里挑，挑中间的值没有意义（平台会把它吸到某一档，'
      + '等于你白填，还可能吸到比台词需要的更短的那一档）。台词多的剧情要自己拆成多段，'
      + '段数由你按总时长和剧情密度决定；每一段都不超过 {maxShot} 秒。\n'
      + '2. {duration} 只是用户给的目标。**这个目标合不合适由你判断**：按这个故事的信息量，'
      + '太短就把情节压成一句话、太长就得靠空镜凑 —— 需要调整时，在顶层 `duration` 里返回你定的整集秒数，'
      + '并让每段的 wantSec 加起来对得上它；合适就原样返回同一个数。\n'
      + '3. 每段的 wantSec 按「这一段的台词念完要多久」挑**装得下的最小那一档**。{caps}\n'
      + '   **所以拆段时按台词的字数来卡**：一档装不下就把它拆成两段（说话人分两句说、'
      + '或者一个人说一句另一个人接一句），而不是把这一段塞进长档了事 —— '
      + '塞进长档拍出来就是后面拖一大段空镜。\n'
      + '   **不要所有段都填同一个数**：台词少的段落填最短档，台词多的段落才用长档。\n'
      + '4. 画风、光线、色调、氛围由你按剧情决定，并为**每一段**写一句 style（例如「冷调夜戏，手持跟拍」）——'
      + '用户没有指定画风，不要在追问里反问，直接定。\n'
      + '5. 角色：给名字、身份、性格、外貌（要能画出来：年龄、脸型、发型、服装）；出镜的 kind="actor"，只出声的 kind="narrator"。\n'
      + '6. 场景：给名字与一段环境描述（空间、摆设、光线），必须能直接当画面提示词用。\n'
      + '6b. 道具：把剧情里**靠它推动、或者反复出现的那一两件实物**认下来（信、手机、伞、名单、钥匙、行李箱…），'
      + '给 name（短，2~6 字）、bio（一句话：什么用、在哪几段出现）、look（材质、颜色、大小、磨损，要能照着画）。'
      + '**只认真正出镜的物件**——墙上的挂钟、地上的水渍、路人身上的衣服这类背景杂物不要列。'
      + '这一栏可以为空（没有关键道具就写 []，别硬凑）。\n'
      + '7. 分段：每段给标题、场景、时间、出场角色、**逐句台词**（who 用角色名，每句不超过 25 字、口语化）、'
      + '镜头（1~3 个，写清画面内容与景别运镜）、开头那一帧的画面描述 openDesc。\n'
      + '8. 相邻两段如果发生在**同一个场景、人物接着上一段的状态**，把 link 写成 "auto"（拍摄时会把上一段最后一帧当作下一段的首帧参考，'
      + '保证人和场景前后一致）；换了场景或不需要相接就写 "off"。\n'
      + '9. 画幅 {ratio}。\n'
      + '{cast}\n\n'
      + '禁止：不要解释、不要 markdown 代码块、不要输出 JSON 以外的任何字符；不要新增用户没提的主线剧情；不要编造品牌名。\n\n'
      + '只输出 JSON，格式：\n'
      + '{"title":"这一集的名字","duration":60,"characters":[{"name":"…","kind":"actor|narrator","bio":"一句话人设","look":"外貌"}],\n'
      + '"scenes":[{"name":"…","desc":"环境描述"}],\n'
      + '"props":[{"name":"…","bio":"什么用、在哪几段出现","look":"外观设定"}],\n'
      + '"shots":[{"title":"…","scene":"场景名","time":"深夜|白天|黄昏|清晨",\n'
      + '"style":"这一段画风","link":"auto|off","chars":["角色名"],"lines":[{"who":"角色名","text":"台词"}],\n'
      + '"shots":[{"desc":"镜头内容","camera":"景别/运镜","sec":3}],"openDesc":"开头那一帧的画面","wantSec":4}]}',
    drama_image: '你是短剧的美术设定师，为下面这一张图写出**文生图模型能直接吃的高质量中文提示词**。\n\n'
      + '这一张是：{what}\n'
      + '角色/场景：{name}\n'
      + '外貌或环境设定：{look}\n'
      + '整集画风取向：{style}\n'
      + '画幅：{ar}\n\n'
      + '硬性要求：\n'
      + '1. 按「主体 → 状态或动作 → 构图（景别/机位/背景）→ 光线与色调 → 风格与媒介 → 细节」组织成一段连贯中文。\n'
      + '2. 严格沿用上面的设定，不要替换人物、不要新增人物、不要改服装；设定里没写的细节可以自己补，但要常见且不抢戏。\n'
      + '3. 画风格落到具体流派与光线，不要只写「高级感」「有质感」。\n'
      + '4. 这一张里只会有一个人（或一个人都没有）；**不要顺手加路人、手、镜子里的第二个人**。\n'
      + '5. 结尾必须带上：无文字、无水印、无字幕。\n\n'
      + '只输出提示词本身，不要标题、引号、编号或解释。',
    /* 道具图**单独一条指令**（2026-10）：道具与角色/场景的画法不一样 ——
       要的是「一件物品的完整陈列」，提示词里写一句「不要人物/不要手/不要环境」就够，
       混在 drama_image 的 {what} 里等于把这一条铁律交给调用方每次现写，
       少写一次道具图上就多出一个人，而它是要整集每段当参考图发出去的。 */
    drama_prop: '你是短剧的道具设定师，为下面这一件道具写出**文生图模型能直接吃的高质量中文提示词**。\n\n'
      + '这件道具：{name}\n'
      + '设定：{look}\n'
      + '整集画风取向：{style}\n'
      + '画幅：{ar}\n\n'
      + '硬性要求：\n'
      + '1. 按「整件物品 → 材质与工艺 → 颜色与磨损 → 构图（居中/微距/平视）→ 光线与背景 → 风格与媒介」组织成一段连贯中文。\n'
      + '2. **画面里只有这一件物品本身**：不要人物、不要手、不要身体、不要环境场景、不要包装盒、不要第二件配件。\n'
      + '3. 物品要**完整入镜**、轮廓清楚，四条边都看得见（不要裁掉一角、不要只拍局部特写）。\n'
      + '4. 严格沿用上面的设定，不要换成另一件东西；设定里没写的细节可以补，但要常见、要有年代感。\n'
      + '5. 背景写「纯净浅色背景 + 柔和侧光」，方便它被裁成参考图。\n'
      + '6. 结尾必须带上：无文字、无水印、无字幕。\n\n'
      + '只输出提示词本身，不要标题、引号、编号或解释。',
    drama_video: '你是短剧的分镜师，把下面这段剧情写成**视频生成模型能直接吃的高质量中文提示词**。\n\n'
      + '这一段要的画面：{open}\n'
      + '镜头：{shots}\n'
      + '台词（角色用中文原声说出来）：{lines}\n'
      + '出场人物（按参考图里的那张脸画，别换人）：{cast}\n'
      + '人物特点备查（性格、背景、外貌细节）：\n{traits}\n'
      + '场景：{scene}\n'
      + '这一段画风：{style}\n'
      + '时长 {sec} 秒，画幅 {ar}。\n\n'
      + '硬性要求：\n'
      + '1. 按「主体 → 动作 → 场景与时间 → 光线与色调 → 镜头语言 → 氛围质感」组织成一段连贯中文。\n'
      + '2. 镜头语言落到具体动作（缓慢推进、固定特写、手持跟随…），不要写「镜头感很好」这类空话。\n'
      + '3. 台词要念得完：按给定时长安排说话节奏，别塞进念不完的内容。\n'
      + '4. 人物长相、服装必须与参考图一致，段与段之间不能换人换装 —— '
      + '**长相由参考图负责，别用文字把外貌再复述一遍**。\n'
      + '5. 「人物特点备查」那一栏**由你自己取舍**：只写进这一段真的看得出来的那几条'
      + '（例：特写里能看见的旧疤、符合当下情绪的性格），与这一段画面无关的（背景故事、职业、'
      + '这幕里看不到的细节）一条都不要抄进去；整栏都用不上就一个字也别提。\n'
      + '6. 不要编造品牌、招牌文字、额外人物。\n\n'
      + '禁止：画面里不要字幕、不要水印、不要标题卡。\n\n'
      + '只输出提示词本身，不要解释、不要 markdown。',
    drama_voice: '你是短剧的配音导演。下面这一集的角色清单来了，你要**逐位**决定：她的声音从哪里来，'
      + '并把要用的东西写出来。\n\n'
      + '这家语音平台能提供的定音色方式（只能从这里选，写别的方式发不出去）：\n{ways}\n\n'
      + '可选的预设音色清单（way="preset" 时 voice 必须**一字不差**地用下面某一行的 id）：\n{preset}\n\n'
      + '本集角色：\n{cast}\n\n'
      + '硬性要求：\n'
      + '1. 每位角色一条，name 照抄清单里的名字（不要改名、不要合并、不要新增角色）。\n'
      + '2. way 的取舍：角色那一行写了「已经有她本人的参考音频」→ 用 "clone"（复刻本人的嗓子，别另造）；\n'
      + '其余出镜角色一律用 "design"（按人设造一条新嗓子，人物之间才有区别）；\n'
      + '**只有这家平台完全没有 design 方式时**才允许退到 "preset"，从上面那份清单里挑最贴性格的一个。\n'
      + 'preset 是最后一档 —— 那一排嗓子是全平台共用的，谁挑都一样，不符合「每个人声音不同」这件事。\n'
      + '3. way="design" 时必须写 note：一段 30~80 字的**音色描述**，说清性别与大致年龄、音质（清亮/沙哑/鼻音重）、'
      + '语速、情绪底子、说话习惯（爱叹气、尾音上扬、咬字硬），并且要**从这个人的人设和外貌推出来** —— '
      + '六十岁的老太太和二十岁的程序员不能是同一条描述。\n'
      + '4. **同一条里不能出现两个角色**；不同角色的 note 要能听出区别，别所有人都写「温和的女声」。\n'
      + '5. 旁白（只出声的）：note 写成适合念白的那种（稳、吐字清楚、不抢戏）。\n'
      + '6. way="preset" 时必须写 voice（清单里的 id），note 可省；way="clone" 时 voice 和 note 都留空。\n\n'
      + '禁止：不要解释、不要 markdown 代码块、不要输出 JSON 以外的任何字符；'
      + '不要编造清单里没有的音色 id；不要改动角色的性格与外貌设定。\n\n'
      + '只输出 JSON，格式：\n'
      + '{"roles":[{"name":"角色名","way":"clone|design|preset","voice":"预设清单里的 id，或空",'
      + '"note":"音色描述，或空"}]}',

    /* ---- 拍短剧 · 设定补写（2026-10 从 drama.html 的内联字符串搬到这里）----
       这五条以前直接写死在页面里：用户改不到、设置页列不出来、页面一改文案就与别处走样。
       搬进 DEF 之后它们与别的指令一样「用户改过的优先、没有就用默认」，也能在设置页按分类找到。
       它们都是「一次把活干完」的短任务（缺的信息自己补），所以全在 NO_ASK 里。 */
    drama_look: '你是美术设定师。把用户写的角色外貌补成一条能直接拿去画定妆照的描述。\n\n'
      + '角色：{name}\n'
      + '人设：{bio}\n'
      + '用户写的外貌：{look}\n\n'
      + '要求：\n'
      + '1. 写清年龄、脸型五官、发型发色、体型、皮肤质感、常穿的衣服与配饰 —— 要具体到能照着画出来。\n'
      + '2. **保持与原文一致**：用户写了什么就保留什么，不要替换人物、不要新增人物、不要改年龄。\n'
      + '3. 原文没提到的部分自己补，补出来的要常见、要在同一设定里说得通，不要堆砌形容词。\n'
      + '4. 写成一两句话，不要分段、不要列条目。\n\n'
      + '只输出描述本身，不要解释、不要 markdown、不要引号。',
    drama_scenedesc: '你是场景设定师。把用户写的场景补成一段能直接当画面提示词用的描述。\n\n'
      + '场景：{name}\n'
      + '时段：{time}\n'
      + '用户写的描述：{look}\n\n'
      + '要求：\n'
      + '1. 写清空间大小、结构、材质、主要摆设与陈设、光线来源与方向、色调、时间氛围。\n'
      + '2. **保持与原文一致**，不要换成另一个地方；原文没写的部分自己补，补得具体、能照着画。\n'
      + '3. 这是**空场景**（还没有人站进去）：不要写人物、路人、剪影。\n'
      + '4. 结尾不要写镜头运镜（那是拍摄那一步的事），也不要写文字、招牌与字幕。\n'
      + '5. 写成一整段，不要列条目。\n\n'
      + '只输出描述本身，不要解释、不要 markdown、不要引号。',
    drama_propdesc: '你是美术设定师。把用户写的这件道具补成一条能直接拿去画陈列图的描述。\n\n'
      + '道具：{name}\n'
      + '用途：{bio}\n'
      + '用户写的描述：{look}\n\n'
      + '要求：\n'
      + '1. 写清材质、工艺、颜色、大小比例、形状细节、使用痕迹（磨损、划痕、锈迹、折痕）与年代感。\n'
      + '2. **保持与原文一致**，不要换成另一件东西；原文没写的部分自己补。\n'
      + '3. 描述的是**这一件物品本身**：不要写人物、手、房间、桌面，也不要提别的配件。\n'
      + '4. 写成一两句话，不要列条目。\n\n'
      + '只输出描述本身，不要解释、不要 markdown、不要引号。',
    drama_open: '你是分镜师。把这一段的开头画面描述写细。\n\n'
      + '这一段的开头：{desc}\n'
      + '出场人物：{cast}\n'
      + '场景：{scene}\n\n'
      + '要求：\n'
      + '1. 一句话说清：人物在哪、在做什么、光线什么感觉、镜头多近（景别）。\n'
      + '2. 保持原意，不要改成另一个动作或另一个画面。\n'
      + '3. 不要写镜头运镜（推拉摇移由拍摄那一步统一处理），不要写台词、字幕、水印。\n\n'
      + '只输出这一句描述，不要解释、不要 markdown。',
    /* 细分镜头里**某一镜**的画面描述（第 3/4 步右栏展开一镜后那个「AI 优化」）。
       与 `drama_open` 分开：那是「整段的开头那一眼」，这一条是「这一段第 N 镜里发生什么」——
       同一句话套用会出现「把整段的开场又写一遍」或「补一个不在这一镜里的人物」。
       `{size}` / `{camera}` 是用户已经选定的景别与机位，**照抄不要改**：
       程序把这两个值原样拼在描述后面交给视频模型，模型在这里另写一套就会和下拉里选的对不上。 */
    drama_subshot: '你是分镜师。把下面这一镜的画面描述写细。\n\n'
      + '这一镜现在的写法：{desc}\n'
      + '这一段已经选定的景别：{size}\n'
      + '这一段已经选定的机位：{camera}\n'
      + '出场人物：{cast}\n'
      + '场景：{scene}\n\n'
      + '要求：\n'
      + '1. 一句话说清：这一镜里人物在做什么、在画面哪个位置、光线什么感觉。\n'
      + '2. **保持原意**，不要改成另一个动作、另一个画面，也不要补不在这一镜里的人物。\n'
      + '3. 不要写台词、字幕、水印，也不要重写景别与机位（那两栏用户自己选）。\n'
      + '4. 这一镜只有 ' + '{sec}' + ' 秒左右，所以只写这个时间跨度内看得见的东西，不要跨镜。\n\n'
      + '只输出这一句描述，不要解释、不要 markdown。',
    drama_retouch: '你是分镜师。用户会给一段短剧的当前写法与一句修改要求，你要**只按那句话**改这一段。\n\n'
      + '要求：\n'
      + '1. 台词、角色、场景、段落标题**一律不改**；只改镜头内容、景别运镜与时长。\n'
      + '2. 镜头数量与原来一致。\n'
      + '3. 用户那句话里点名的元素必须全部落实（例：「机位压低一点」→ 每一镜的 camera 都要真的压低）。\n'
      + '4. 只输出 JSON，不要解释、不要 markdown：\n'
      + '{"openDesc":"改后的开头画面描述","shots":[{"desc":"镜头内容","camera":"景别与运镜","sec":3}]}',
    drama_camera: '你是分镜师。用户要为一个镜头挑机位，你要给出几个**明显不同**的机位方案。\n\n'
      + '这一段的开头画面：{desc}\n'
      + '出场人物：{cast}\n'
      + '场景：{scene}\n'
      + '现在用的机位：{cur}\n\n'
      + '要求：\n'
      + '1. 给 **{n} 个**方案，**彼此要在方位或景别上真的不一样**'
      + '（比如一个中景平视、一个近景俯视、一个远景侧逆光）—— 三个都写「中景平视」等于只给了一个。\n'
      + '2. 每个方案两个字段：\n'
      + '   · `label`：**给人看的标签**，4~10 个字，格式照「左前方·中景」「正面·大俯拍·远景」'
      + '（方位或角度 + 「·」 + 景别），不要超过 10 个字。\n'
      + '   · `desc`：**给生图 AI 的画面描述**，一到两句，写清机位怎么摆、景别多近、'
      + '人物在画面里的位置与视线方向、光线从哪来。不要写运镜（推拉摇移由拍摄那一步处理），'
      + '不要写台词、字幕、水印。\n'
      + '3. 每个方案都要**能用上面的画面描述画出来**：场景、人物、动作保持原样，只换怎么看它。\n'
      + '4. 至少有一个方案贴近「现在用的机位」或它的反面，方便用户对照，不至于全部推翻重选。\n'
      + '5. 只输出 JSON，不要解释、不要 markdown：\n'
      + '{"cams":[{"label":"左前方·中景","desc":"……"},{"label":"……","desc":"……"}]}',
  },
  /* ---------- 提示词的分类表（2026-10） ----------
     设置页「提示词润色」那张卡**按这张表画**：分类标题、每条的名称、它用在哪、占位符说明全在这里。
     以前那 11 条是设置页里写死的 11 个 `.polish-block`（外加保存 / 读取 / 恢复默认三处各抄一遍键名），
     加一条指令要改四个地方，漏一处就是「设置页列出来了、存盘没存上」或者反过来。
     格式：反引号包起来的会渲染成 <code>，其余按纯文本转义。 */
  PROMPTS: [
    { id: 'gen', name: '通用润色（生成工作台 / 导演台）',
      note: '这几条是用户点「AI 润色」时用的，改它们影响所有页面。',
      items: [
        { key: 'video', label: '视频提示词润色', used: '生成工作台「视频」那一栏的「AI 润色」 · 导演台右栏「AI 润色提示词」' },
        { key: 'img', label: '图片提示词润色', used: '图片工作台「AI 润色」' },
        { key: 'audio', label: '配音稿润色', used: '生成工作台「语音」那一栏的「AI 润色」' },
        { key: 'story', label: '分镜切片规划（决定张数 + 每张提示词）', used: '导演台右栏「按描述生成这一镜的画面」',
          ref: '要求文字 AI `只返回 JSON`（`{"frames":[{"t":0,"prompt":"…"}]}`），由它决定生成几张、每张在第几秒、每张画什么。改这条时请保留 JSON 格式要求，否则会退化成按 2.5 秒硬切片。' },
        { key: 'split', label: '剧本拆分镜', used: '导演台「贴剧本，一键拆分镜」',
          ref: '要求文字 AI `只返回 JSON`（`{"title":"…","scenes":[{"name":"场景 1","shots":[{"prompt":"…","duration":5}]}]}`）；末尾会由程序自动补上「镜头数 / 每镜时长」两条约束。改这条时请保留 JSON 格式要求。' },
      ] },
    { id: 'write', name: '拍短剧 · 写剧本',
      note: '这两条决定「故事写成什么样」：一条把点子写成梗概，一条把梗概拆成能拍的分段。',
      items: [
        { key: 'drama_story', label: '故事完善（一句点子 → 能拆分的梗概）', used: '拍短剧第一页「✧ AI 帮我完善」',
          tip: '这一条是**散文**，所以它会跟着下面「润色前要不要先反问」那个设置走；输出会原样写回故事框，你可以接着改。' },
        { key: 'drama_split', label: '拆剧本（故事 → 角色 / 场景 / 分段）', used: '拍短剧「开始」把故事交给文字 AI 拆成可拍的分段',
          ref: '要求文字 AI `只返回 JSON`，由它决定分几段、每段多长、每段画风。改这条时请保留 JSON 格式要求。\n`{duration}` = 整集总时长（秒，页面上填的那一个数），`{maxShot}` = 视频平台声明的单段上限，`{ratio}` = 画幅，`{cast}` = 已经定下的人与地方（沿留下来的那一批，以及选了「从素材库选」时库里已有的角色与场景），让它按同样的名字复用脸、音色与场景图。\n占位符可以挪位置、可以删，但别改成别的名字 —— 程序只认这一套。' },
      ] },
    { id: 'asset', name: '拍短剧 · 素材出图',
      note: '这几条决定「每一条素材长什么样」：出图前先由文字 AI 把设定写成高质量提示词，再交给图片 AI。',
      items: [
        { key: 'drama_image', label: '角色脸 / 三视图 / 场景图提示词', used: '拍短剧「认角色」那一步画脸、画三视图、画场景图',
          ref: '占位符：`{what}` 要画什么（角色定妆照 / 三视图 / 空场景图）、`{name}` 角色或场景名、`{look}` 外貌与环境设定、`{style}` 这一段画风、`{ar}` 画幅。' },
        { key: 'drama_prop', label: '道具图提示词', used: '拍短剧「认角色」→「道具」那一步画道具图',
          ref: '占位符：`{name}` 道具名、`{look}` 道具设定、`{style}` 这一段画风、`{ar}` 画幅。\n道具图与角色/场景的画法不同（只要一件物品、完整入镜、不要人物），所以单独一条指令 —— 它要整集每段都作为参考图发出去，混进上一条里少写一句就多出一个人。' },
      ] },
    { id: 'shoot', name: '拍短剧 · 拍摄与画面',
      note: '这几条决定「拍出来的那一段」：提交给视频 AI 的话、每一段的开头画面、以及「一句话改这一段」。',
      items: [
        { key: 'drama_video', label: '视频提示词', used: '拍短剧「拍这一段」提交给视频 AI 的那段话',
          ref: '`{open}` 开头那一帧的画面、`{shots}` 镜头清单、`{lines}` 逐句台词、`{cast}` 出场人物、`{traits}` 人物特点备查、`{props}` 这一集认下的道具、`{scene}` 场景、`{style}` 这一段画风、`{sec}` 这一段时长、`{ar}` 画幅。\n这一条改坏的表现是「人物与参考图不一致 / 台词念不完」，因为程序把参考图与时长都按这里的说法交给模型。' },
        { key: 'drama_open', label: '开头画面写细', used: '拍短剧第 3 步每段那一格「写细」',
          ref: '占位符：`{desc}` 现在的开头描述、`{cast}` 出场人物、`{scene}` 场景。' },
        { key: 'drama_subshot', label: '细分镜头写细', used: '拍短剧第 3/4 步右栏展开一镜后的「AI 优化」',
          ref: '占位符：`{desc}` 这一镜现在的写法、`{size}` 用户已选的景别、`{camera}` 用户已选的机位、`{sec}` 这一镜约几秒、`{cast}` 出场人物、`{scene}` 场景。\n`{size}` / `{camera}` 是**照抄**给模型的参考（模型不该另写一套），改坏的表现是「下拉里选的景别和提示词里写的不一样」。' },
        { key: 'drama_retouch', label: '一句话改这一段', used: '拍短剧第 3 步每段那一格「改这一段」',
          ref: '要求文字 AI `只返回 JSON`（`{"openDesc":"…","shots":[{"desc":"…","camera":"…","sec":3}]}`）。改这条时请保留 JSON 格式要求：程序按它重写这一段的镜头，解析不出来就等于什么都没改。' },
        { key: 'drama_camera', label: '机位候选', used: '拍短剧第 3 步每段那一格「机位」（出 N 张构图图让你挑）',
          ref: `占位符：\`{n}\` 要几个机位方案、\`{desc}\` 这一段的开头画面、\`{cast}\` 出场人物、\`{scene}\` 场景、\`{cur}\` 现在用的机位。\n要求返回 \`{"cams":[{"label":"左前方·中景","desc":"给生图 AI 的画面描述"}]}\`，改坏的表现是「出不了候选图」——程序按它逐个出图，挑中的那张标签会写进这一段的镜头。` },
      ] },
    { id: 'voice', name: '拍短剧 · 声音',
      note: '这一条决定「谁怎么出声」：它逐位决定每位角色的声音从哪里来。',
      items: [
        { key: 'drama_voice', label: '给每位角色定音色', used: '拍短剧「认角色」→「✧ 让 AI 给每位角色定声音」',
          ref: '`{ways}` = 这一家语音平台真能用的定音色方式（预设 / 声音描述 / 参考音频复刻），`{preset}` = 平台声明的预设音色清单（`id｜名字 · 语言 · 性别`），`{cast}` = 这一集的角色清单（人设、外貌、有没有本人的参考音频）。\n要求文字 AI `只返回 JSON`（`{"roles":[{"name":"…","way":"preset|design|clone","voice":"…","note":"…"}]}`），改这条时请保留 JSON 格式要求：程序按 `name` 对上角色、按 `way` 挑对应型号，音色 id 只认清单里真有的那一些（编一个 id 平台不认，要到配音时才报错）。' },
      ] },
    { id: 'desc', name: '拍短剧 · 设定补写',
      note: '这几条是第 2 步那三颗「✧ AI 优化」：把你随手写的一句话补成能直接拿去画 / 去拍的设定。',
      items: [
        { key: 'drama_look', label: '角色外貌补细', used: '拍短剧「认角色」角色卡上的「✧ AI 优化」',
          ref: '占位符：`{name}` 角色名、`{bio}` 一句话人设、`{look}` 你现在写的外貌。' },
        { key: 'drama_scenedesc', label: '场景描述补细', used: '拍短剧「认角色」场景卡上的「✧ AI 优化」',
          ref: '占位符：`{name}` 场景名、`{time}` 时段、`{look}` 你现在写的描述。' },
        { key: 'drama_propdesc', label: '道具描述补细', used: '拍短剧「认角色」道具卡上的「✧ AI 优化」',
          ref: '占位符：`{name}` 道具名、`{bio}` 用途、`{look}` 你现在写的描述。' },
      ] },
  ],
  /* 取「用户改过的，没有就用内置默认」——页面与设置页共用这一份。
     askNote=true 时把「补充信息」那段也接上（只有会反问的三条润色指令要）。 */
  /* 这些指令是「一次把活干完」的（短剧那四条：缺的信息由指令自己补全），
     接上「可以反问」只会让模型把输出变成问题，所以显式排除。
     **story / split 也在这一列里**（导演台那两条）：它们要的是 JSON / 结构化分镜，
     页面拿 `parseJsonLoose` / `parseFrames` 去解 —— 模型一旦先反问，解出来就是空，
     界面报「AI 没有给出可用的分镜结构」。而设置页把 `prompt('story')` 的结果**整段写回**
     `sk_polish_story`（那是用户在设置页里能改的那一栏），只要 ASK_NOTE 被拼上去，
     下一次打开设置页再点保存，导演台读到的就是带着「你可以追问」的指令。 */
  NO_ASK: ['drama_split', 'drama_image', 'drama_prop', 'drama_video', 'drama_voice', 'story', 'split', 'drama_camera',
    /* 设定补写那五条（2026-10 搬进 DEF）：它们要的是一段描述 / 一段 JSON，
       模型先反问一句，页面就把这一格填成了一句话 —— 比不问更糟。 */
    'drama_look', 'drama_scenedesc', 'drama_propdesc', 'drama_open', 'drama_retouch', 'drama_subshot'],
  prompt(kind, askNote) {
    const raw = localStorage.getItem(this.promptKey(kind)) || this.DEF[kind] || '';
    /* NO_ASK 那几条还要**摘掉尾部那段追问说明**：story / split 以前不在名单里，
       设置页一保存就把 ASK_NOTE 整段写进了 sk_polish_story / sk_polish_split ——
       加进 NO_ASK 只管得住「以后不再拼」，已经被污染的那一份还在用户机器上，
       下一次读出来照样带着「你可以追问」，而这两条要的是 JSON（见上面那段注释）。 */
    if (this.NO_ASK.indexOf(kind) >= 0) return this.stripAskNote(raw);
    const note = (askNote === false || !this.DEF.ASK_NOTE) ? '' : this.DEF.ASK_NOTE;
    if (!note || raw.indexOf('补充信息') >= 0) return raw;      // 用户自己已经写了就不重复追加
    return raw + '\n\n' + note;
  },
  /* 只摘**结尾**那一段（我们自动拼的位置）；用户在中间自己写的同样文字不动。 */
  stripAskNote(v) {
    const s = String(v || ''), note = String(this.DEF.ASK_NOTE || '');
    if (!note || !s.endsWith(note)) return s;
    return s.slice(0, -note.length).replace(/\s+$/, '');
  },
  promptKey(kind) { return 'sk_polish_' + kind; },
  /* 供应方（多家并存，默认 OpenRouter）：
     文字 AI 以前只有 DeepSeek 一条，基址还写死在客户端（sk_base_deepseek）。现在每家都是
     registry 里一条正常的 provider（relay / base / keyEnv / models 各自独立），
     用哪一家由设置页选（sk_text_prov 存 provider id），密钥/基址/型号都按 keyId 各自存。
     没显式选过的：优先「默认供应方」，但它得真的能用（本机有密钥，或服务端 .env 配了），
     否则退到下一家有密钥的 —— 光换默认就把原来能用的润色弄坏，是不能接受的。 */
  all(REG) { return ((REG && REG.providers) || []).filter(p => p.kind === 'text'); },
  provKey() { return 'sk_text_prov'; },
  savedProv(REG) {
    const want = localStorage.getItem(this.provKey());
    if (!want) return null;
    const list = this.all(REG);
    return list.find(p => p.id === want) || list.find(p => (p.keyId || p.id) === want) || null;
  },
  /* 「能用」= 本机填了密钥，或服务端 .env 配了（_envIds 由 warm() 从 /env-status 读，60 秒缓存）。
     读 /env-status 而不是让代理往 /registry 里塞标记：registry 是同源可读但也允许跨站读的，
     往里加「这台机器有没有某平台的密钥」等于往外报配置。 */
  usable(prov) {
    if (!prov) return false;
    if (this.key(prov)) return true;
    return !!(this._envIds && this._envIds[this.keyId(prov)]);
  },
  prov(REG) {
    const list = this.all(REG);
    if (!list.length) return null;
    const saved = this.savedProv(REG);
    if (saved) return saved;
    const def = list.find(p => p.default && this.usable(p));
    if (def) return def;
    return list.find(p => this.usable(p)) || list[0];
  },
  async warm(REG) {
    /* 先看缓存：60 秒内的结果直接用，不要每次都发一次 /env-status。
       以前是先取、再判缓存 —— 判到缓存就把刚取回的结果丢掉，等于白跑一个请求，
       而且 _envIds 只在未命中那条路上重建（缓存命中时环境密钥变了也不会被发现）。 */
    const now = Date.now();
    if (this._envCache && now - this._envCache.ts < 60000) return this._envCache.data;
    try {
      const d = await netFetch('/env-status', { timeout: 8000 }).then(r => r.json());
      this._envCache = { ts: now, data: d || {} };
      this._envIds = {};
      Object.keys(d || {}).forEach(k => { if (d[k] && d[k].hasEnv) this._envIds[k] = true; });
      return d || {};
    } catch { return this._envCache ? this._envCache.data : {}; }
  },
  keyId(prov) { return (prov && (prov.keyId || prov.id)) || 'deepseek'; },
  /* 内存覆盖表（按 keyId）：设置页「获取型号列表 / 验证密钥 / 测试」这三个按钮要用**刚填还没保存**
     的密钥与地址发一次请求。以前它们为了这件事直接写 localStorage（`sk_key_*` / `sk_base_*`），
     等于绕过了这一页「点保存才生效」的约定 —— 用户填一半切走，保存的却是半成品。
     现在只把值放进这份表里，发完请求（或离开设置页）就清掉，磁盘上始终是保存过的那份。 */
  formOverride: {},
  setFormOverride(prov, vals) {
    const k = this.keyId(prov);
    if (vals) this.formOverride[k] = vals; else delete this.formOverride[k];
    return this.formOverride[k] || null;
  },
  key(prov) {
    const o = this.formOverride[this.keyId(prov)];
    if (o && o.key) return o.key;
    return localStorage.getItem('sk_key_' + this.keyId(prov)) || '';
  },
  /* 自定义基址：按供应方各存各的（sk_base_<keyId>）；没填就用 registry 里的地址。
     有值时以 x-up-base 头临时换基址，所以「常用接口预设」对任何一家都照样能用。
     **自定义供应商不走这一条**：那一家的地址本来就是用户自己在 sk_custom 里填的，
     没有「官方地址 + 临时覆盖」这回事；代理那边也把它建条目的 baseEditable 摘了（不认这个头）。
     所以这里必须跟着返回空 —— 否则界面上填了地址、请求里带了头、代理却照原样转发，
     成了「界面说改了，其实没改」。 */
  base(prov) {
    if (prov && prov.custom) return '';
    const o = this.formOverride[this.keyId(prov)];
    if (o && o.base) return o.base;
    return localStorage.getItem('sk_base_' + this.keyId(prov)) || '';
  },
  /* 这个自定义地址是不是**另一家**的？
     地址是按供应方各存各的（`sk_base_<keyId>`），但用户很容易在「供应方 = DeepSeek」时
     把 OpenRouter 的地址填进去 —— 于是请求带着 **DeepSeek 的密钥**打到 OpenRouter，
     上游回一句「Your api key ****xxxx is invalid」，而界面上看着像「我明明选了 OpenRouter 啊」。
     查法：这个地址的 host 是不是 registry 里**别的**供应方的 base host。 */
  /* 判据只有一份（Api.hostOwner，比对的是**全平台**的地址）：这里留旧入口名给设置页与测试用。
     以前只比文字 AI 那几家，生成平台也能填自定义地址后就变成两份判据 —— 同一串地址在文字 AI 里报警、
     在生图平台里不报，那种「到底哪家会被串密钥」的差别没人能解释。 */
  baseOwner(REG, base, prov) { return Api.hostOwner(REG, base, prov); },
  /* ---- 模型：接口列表 / registry 兜底 / **用户自己填的型号** 三者合并 ----
     「自己添加型号」是硬要求：OpenRouter 这类聚合平台有几百个型号，/models 一次全拉回来
     未必顺滑，而用户手上往往就认准一两个写法。所以自定义型号单独存一份（sk_text_models_<keyId>），
     永远出现在下拉里，不依赖 /models 有没有列它。 */
  customKey(prov) { return 'sk_text_models_' + this.keyId(prov); },
  /* 「认出这一家了吗」——**单独一处判据**。
     为什么必须单独判：keyId(null) 会兜底成 'deepseek'（早期只有一家文字 AI 时留下的行为），
     于是只要 prov 一旦是 null（注册表还没就绪、代理热重载、刚加的那家还没并进 REG），
     用户在这张卡上自己填的型号就会被写进 **DeepSeek** 的那一份，
     接着 renderCustomModels 又把 DeepSeek 的自填型号原样画到这张卡的芯片区 ——
     表现正是「我填的型号跑到了另一家供应商里」，而且没有任何报错。
     兜底键在「读」上无害（读不到就当没填），在「写」上是有害的，所以写的地方一律先问这一句。 */
  hasProv(prov) { return !!(prov && (prov.keyId || prov.id)); },
  custom(prov) {
    if (!this.hasProv(prov)) return [];
    try {
      const v = JSON.parse(localStorage.getItem(this.customKey(prov)) || '[]');
      return Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];
    } catch { return []; }
  },
  addCustom(prov, id) {
    const s = String(id || '').trim();
    if (!s) return [];
    if (!this.hasProv(prov)) return [];        // 认不出这一家就不写：宁可不加，也不能写到别家去
    const list = this.custom(prov);
    if (!list.includes(s)) list.push(s);
    try { localStorage.setItem(this.customKey(prov), JSON.stringify(list.slice(-200))); } catch {}
    return list;
  },
  removeCustom(prov, id) {
    if (!this.hasProv(prov)) return [];        // 同上：删除也不能落到兜底键上
    const list = this.custom(prov).filter(x => x !== String(id));
    try { localStorage.setItem(this.customKey(prov), JSON.stringify(list)); } catch {}
    return list;
  },
  /* ---- 型号：**完全动态** ----
     下拉里放两类：① 这一家接口返回的（点「获取型号列表」拿到的）② 用户自己填的。
     registry 里声明的那几个「平台内置」**不展示**（那是一份写死的清单，用户看到会以为型号是固定的，
     而且切供应方时那几行特别像串台）。但它仍作为**内部兜底**：一个型号都没选时 `model()` 不会返回空。
     **例外：用户自己添加的供应方**（`prov.custom`）—— 它那串型号是他在「添加自定义供应商」里一个个勾出来的，
     属于「他自己声明的这家有什么」，不是我们写死的平台表，所以照实列出来（否则刚加完一家网关、型号下拉是空的，
     还得再点一次「获取型号列表」才能用；`ownsModel` 也认这一份，免得「添加了却不让你保存」）。
     fetchList 必须是**这一家**的接口列表（以前页面里是全局一份，切了供应方还串着上一家的型号）。
     返回 { groups: [{label, ids:[]}], ids: [] }，调用方直接渲染成 <optgroup>（Dropdowns 支持）。 */
  modelGroups(prov, fetchList) {
    const seen = new Set();
    const uniq = ids => ids.map(String).filter(id => { if (!id || seen.has(id)) return false; seen.add(id); return true; });
    const fetched = uniq((fetchList || []).map(m => (m && m.id ? m.id : m)));
    const custom = uniq(this.custom(prov));
    const declared = prov && prov.custom ? uniq((prov.models || []).map(m => (m && m.id) || m)) : [];
    const groups = [];
    if (fetched.length) groups.push({ label: '接口返回（' + ((prov && prov.name) || '当前接口') + '）', ids: fetched });
    if (custom.length) groups.push({ label: '自己添加', ids: custom });
    if (declared.length) groups.push({ label: '添加这一家时勾的型号', ids: declared });
    /* 一个都没取到时，别让已保存的型号凭空消失 —— 单独一组标出来（它可能已下架，也可能是还没点获取） */
    const saved = this.model(prov);
    if (saved && !seen.has(saved)) groups.push({ label: '当前选中（这家接口还没取过列表）', ids: [saved] });
    return { groups, ids: groups.reduce((a, x) => a.concat(x.ids), []) };
  },
  /* 这个型号是不是属于这一家？（设置页守门用：切了供应方却把上一家的型号存/发出去，就是错配） */
  ownsModel(prov, id, fetchList) {
    const s = String(id || '').trim();
    if (!s) return false;
    return this.modelGroups(prov, fetchList).ids.indexOf(s) >= 0;
  },
  /* 选中的模型：设置页存下来的优先，其次用户自己填的第一个，最后 registry 声明的第一个。
     **认不出供应方时返回空**：modelGroups 会拿它填「当前选中」那一组，
     而 keyId(null) 兜底成 'deepseek' —— 于是别家保存的型号会出现在这张卡的下拉里
     （同一个坑，第二个入口）。发请求时 model 为空，上游会直接报错，
     这比「界面看着是这一家、实际发的是别家的型号」诚实。 */
  model(prov) {
    if (!this.hasProv(prov)) return '';
    const saved = localStorage.getItem('sk_model_' + this.keyId(prov));
    if (saved) return saved;
    const firstCustom = this.custom(prov)[0];
    if (firstCustom) return firstCustom;
    return (prov && prov.models && prov.models[0] && prov.models[0].id) || 'deepseek-chat';
  },
  /* ---- 识图（视觉）能力判定 ----
     只有两级，**不再按模型名猜**（名字会骗人：同一家的命名五花八门，猜错就白带图浪费 tokens，
     或者该带图却不带、润色质量下降）：
       ① 设置页手动指定（sk_text_vision = on / off）
       ② **接口返回的字段**：拉 /models 时看模型条目里有没有「image / vision」这类多模态声明
          （input_modalities、architecture.input_modalities、capabilities.vision、supports_vision…）
       ③ registry 里该模型声明的 vision: true/false（接入新平台时写死）
     三个来源都没说 → **按不支持处理**（少带图只是少一层参考，不会凭空多花 tokens 或编错），
     并在界面上说清「接口与平台声明都没说，要用就手动开启」。
     为什么以接口为准：同一家的模型名会变、多家共用一套命名，名字猜错会白带图（浪费 tokens） */
  META_TTL: 12 * 60 * 60 * 1000,      // 模型能力缓存 12 小时（能力很少变，不必每次都拉）
  _meta: null,                        // { [modelId]: { vision, why } }
  visionMode() { return localStorage.getItem('sk_text_vision') || 'auto'; },   // auto | on | off
  /* 润色前要不要先反问（sk_polish_ask）：
       ai（默认）= **交给 AI 判断** —— 把「描述够不够写」交给模型：它读完内容自己决定
                    是先问几个问题，还是直接进润色。程序不按字数拍板（一句 30 字可能很清楚，
                    一段 200 字也可能全是废话，字数说明不了「够不够」）。
       on  = 强制先问；off = 从不问。
     「为什么可以问」这件事也写进了 AI 提示词（askPolish 的契约段与 TextAI.DEF 的「补充信息」段），
     模型才知道自己有两段可选、问到的东西会怎么被用。 */
  askMode() { return localStorage.getItem('sk_polish_ask') || 'ai'; },
  shouldAsk() {
    const m = this.askMode();
    return m !== 'off';                       // ai / on 都要先问模型，由它决定问不问
  },
  /* 从一条模型条目里找「能不能吃图片」的证据。返回 { vision: true|false|null, field }，
     null = 这个接口没给可用信号（交给下一级判定）。 */
  IMAGE_TOKENS: /^(image|images|vision|visual|multimodal|vl)$/i,
  detectVision(m) {
    if (!m || typeof m !== 'object') return { vision: null, field: '' };
    const hasImg = arr => Array.isArray(arr) && arr.some(x => this.IMAGE_TOKENS.test(String(x).trim()));
    /* ① 明确表达「输入模态」的字段（最可靠，别和输出模态混） */
    const named = [
      ['input_modalities', m.input_modalities],
      ['input_modalities', m.architecture && m.architecture.input_modalities],
      ['input_modalities', m.capabilities && m.capabilities.input_modalities],
      ['input_modalities', m.modalities && m.modalities.input],
      ['input_modalities', m.model_spec && m.model_spec.input_modalities],
    ];
    for (const [field, v] of named) if (Array.isArray(v)) return { vision: hasImg(v), field };
    /* ② 布尔开关：vision / supports_vision / capabilities.vision … */
    const bools = [
      ['vision', m.vision], ['vision', m.supports_vision], ['vision', m.supportsVision],
      ['vision', m.vision_enabled], ['vision', m.capabilities && m.capabilities.vision],
      ['vision', m.capabilities && m.capabilities.image], ['vision', m.architecture && m.architecture.vision],
    ];
    for (const [field, v] of bools) if (typeof v === 'boolean') return { vision: v, field };
    /* ③ 泛化的能力/标签数组（features / tags / capabilities 本身是数组） */
    const loose = [['features', m.features], ['tags', m.tags], ['capabilities', m.capabilities]];
    for (const [field, v] of loose) if (hasImg(v)) return { vision: true, field };
    return { vision: null, field: '' };
  },
  metaKey(prov) { return 'sk_model_meta_' + this.keyId(prov); },
  /* 清掉「这个模型能不能吃图片」的 12 小时判定缓存（换供应商 / 换模型后判定看着不变时用）。
     设置页的清理按钮调用；返回清了几条。 */
  clearMeta() {
    this._meta = null;
    this._metaFor = '';
    let n = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sk_model_meta_')) { localStorage.removeItem(k); n++; }
    }
    return n;
  },
  /* 素材清单 → 一段写给 AI 的话。
     问题：参考图能随消息附上（识图模型），**视频 / 音频附不了**。以前只在提示词里塞一句
     「这次还挂了参考视频（沿用它的运镜与节奏）」—— 模型既不知道有几个、也不知道发的是什么，
     只能靠猜。这里把**类型 + 数量 + 用途**一次说清，并明确「没附上的别凭空编造」。
     items: [{ label:'参考图 1', kind:'图片', sent:true }, { label:'参考视频', kind:'视频', sent:false, hint:'沿用它的运镜和节奏' }]
     返回可直接接在系统提示词后面的一段话。 */
  materialNote(items) {
    const list = (items || []).filter(x => x && x.label);
    if (!list.length) return '';
    const group = (pred) => {
      const m = new Map();
      list.filter(pred).forEach(x => { const k = x.kind || '素材'; m.set(k, (m.get(k) || 0) + 1); });
      return [...m.entries()].map(([k, n]) => k + ' ×' + n).join('、');
    };
    const parts = [];
    const sent = group(x => x.sent);
    const notSent = group(x => !x.sent);
    if (sent) parts.push('用户已随这条消息附上：' + sent + '（图编号见消息末尾的「随附图片」，请按 图N 引用）');
    if (notSent) {
      const hints = list.filter(x => !x.sent && x.hint).map(x => x.label + '（' + x.hint + '）');
      parts.push('用户还有**无法随消息附上**的素材：' + notSent
        + (hints.length ? '，用途分别是 ' + hints.join('、') : '')
        + '。你看不到它们的内容，只能按这里的说明理解，**不要凭空编造画面或声音细节**。');
    }
    return '【用户随这段内容附带的素材】' + parts.join('；') + '。';
  },
  /* 拉一次 /models 的**原始条目**（不裁剪字段，识图判定要用原始字段） */
  keyTail(prov) { const k = this.key(prov); return k ? k.slice(-4) : ''; },
  /* 报错时带上一句「用的是哪家、哪把钥匙」：密钥类报错最常见的坑是「以为换了这家，其实请求还发给了上一家」
     （以前基址与密钥都写死一家，切不开）。 */
  who(prov) {
    const p = prov || null;
    const name = (p && p.name) || '文字 AI';
    const kid = this.keyId(p);
    const local = this.key(p);
    return name + '（密钥：' + (local ? '本机保存，尾号 ' + local.slice(-4)
      : ((this._envIds && this._envIds[kid]) ? '服务端 .env' : '没配')) + '）';
  },
  /* 鉴权类错误补一句「谁在拒你」。OpenRouter 这类上游的原文是 "Authentication Fails, Your api key: ****b27a is invalid"，
     不指出用的是哪一把，用户根本不知道该去改哪一格。 */
  authHint(prov, status, msg) {
    const s = String(msg || '');
    if (!/^40[13]$/.test(String(status == null ? '' : status)) && !/auth|api key|密钥|unauthorized|invalid key/i.test(s)) return '';
    return '　用的是：' + this.who(prov);
  },
  /* prov 可以显式指定：设置页按下拉里**选中的那家**取型号，而不是已保存的那家
     （以前只有 prov(REG) 一条路，下拉选了没保存时会打到别家去）。 */
  async rawModels(REG, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const r = await netFetch(prov.relay + '/models', { headers: this._headers(prov), timeout: 20000 });
    /* 文字 AI 的失败也要过 ERROR_HINT：上游只回一句「Insufficient Balance」时，
       界面得说清是余额/额度不够、去哪儿处理，而不是把英文原样甩在计数条上。
       错误体不一定是 JSON（网关的 HTML 错误页），先兜成空对象，别把真正的状态码错成解析异常。 */
    let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
    if (!r.ok) {
      const m = window.Api.errorMessage(d, r.status);
      throw new Error(m + this.authHint(prov, r.status, m));
    }
    return d.data || d.models || (Array.isArray(d) ? d : []);
  },
  /* 载入并缓存「模型 → 能否识图」：优先读缓存，过期或 force 时回源。
     回源失败**不写缓存**（否则一次网络抖动会把判定固化 12 小时），并保留上一次的结果。 */
  async loadModelMeta(REG, provIn, opts = {}) {
    const prov = provIn || this.prov(REG);
    if (!prov) return this._meta || {};
    const ck = this.metaKey(prov);
    if (!opts.force) {
      try {
        const c = JSON.parse(localStorage.getItem(ck) || 'null');
        if (c && c.ts && Date.now() - c.ts < this.META_TTL && c.byId) { this._meta = c.byId; this._metaFor = prov.id; return c.byId; }
      } catch {}
    }
    try {
      const raw = await this.rawModels(REG, prov);
      const byId = {};
      raw.forEach(m => {
        const id = m && (m.id || m.name);
        if (id) byId[id] = this.detectVision(m);
      });
      this._meta = byId;
      this._metaFor = prov.id;              // 内存里这份能力属于哪家（换供应方要重拉）
      try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), byId })); } catch {}
      return byId;
    } catch (e) {
      console.warn('[TextAI] 读模型能力失败（沿用上次判定）：', e.message);
      return this._meta || {};
    }
  },
  vision(REG, provIn, modelIn) {
    const prov = provIn || this.prov(REG);
    const model = modelIn || this.model(prov);
    const mode = this.visionMode();
    if (mode === 'on') return { ok: true, model, why: '设置里已开启识图' };
    if (mode === 'off') return { ok: false, model, why: '设置里已关闭识图' };
    // ② 接口字段（最权威）
    const hit = (this._meta || {})[model];
    if (hit && hit.vision !== null) {
      return { ok: !!hit.vision, model, why: '接口字段 ' + (hit.field || 'capabilities') + (hit.vision ? ' 声明支持图片' : ' 未包含 image') };
    }
    // ③ 注册表声明
    const decl = ((prov && prov.models) || []).find(m => m && m.id === model);
    if (decl && decl.vision !== undefined) return { ok: !!decl.vision, model, why: '平台声明' };
    /* 接口与平台声明都没说 → 按不支持。**不猜模型名**：名字会骗人（gpt-4o / claude 这类名字
       经常出现在不支持图的开源复刻上，vl 后缀也可能是纯文本微调），猜错就是白花 tokens。 */
    return { ok: false, model, why: '接口与平台声明都没说这个型号能不能吃图片' };
  },
  /* 异步版：确保拿到接口能力后再判定（润色 / 对话前调用） */
  async visionAsync(REG, provIn, modelIn) {
    const prov = provIn || this.prov(REG);
    const model = modelIn || this.model(prov);
    /* 换了供应方就重拉那家的能力（缓存按 keyId 分开存，内存这份得对上号才用） */
    if (!this._meta || this._metaFor !== (prov && prov.id)) { try { await this.loadModelMeta(REG, prov); } catch {} }
    return this.vision(REG, prov, model);
  },
  /* 图片编号说明：让模型知道「图N 是哪张素材」（图片按同一顺序附在后面） */
  imageLegend(images) {
    if (!images || !images.length) return '';
    return '【随附图片（按顺序）】' + images.map((it, i) => `图${i + 1} = ${it.label}`).join('；')
      + '。请结合图片内容润色，并在提示词里按上面的编号指代素材。';
  },
  /* 取字节：File/Blob 直接用，跨域链接经本地代理 /fetch */
  async _blob(src) {
    // 不用 instanceof：跨 iframe / 沙箱来的 File 过不了构造器判断，按能力（arrayBuffer）识别更稳
    if (src && typeof src === 'object' && typeof src.arrayBuffer === 'function') return src;
    const s = String(src || '');
    const u = /^https?:/i.test(s) && s.indexOf(location.origin) !== 0 ? '/fetch?url=' + encodeURIComponent(s) : s;
    const r = await netFetch(u, { timeout: 60000, retry: 1 });
    if (!r.ok) throw new Error('素材读取失败 HTTP ' + r.status);
    return await r.blob();
  },
  /* 缩到最长边 edge 再转 dataURL：识图只做参考，不需要原图分辨率，省流量和 tokens */
  async shrink(src, edge, quality) {
    const blob = await this._blob(src);
    if (/^(video|audio)\//.test(blob.type || '')) return null;
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) return null;
    const max = edge || 1024;
    const scale = Math.min(1, max / Math.max(bmp.width || 1, bmp.height || 1));
    const w = Math.max(1, Math.round((bmp.width || 1) * scale)), h = Math.max(1, Math.round((bmp.height || 1) * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    try { bmp.close && bmp.close(); } catch {}
    return cv.toDataURL('image/jpeg', quality || 0.85);
  },
  /* 批量压缩（读不出来的素材直接跳过，不影响润色） */
  async prepImages(list, opts) {
    const max = (opts && opts.max) || 6, edge = (opts && opts.edge) || 1024;
    const out = [];
    for (const it of (list || []).slice(0, max)) {
      try { const url = await this.shrink(it.src, edge); if (url) out.push({ label: it.label, url }); } catch {}
    }
    return out;
  },
  /* 润色前统一入口：返回 { images, note }
     note 一句说明，直接贴到润色弹窗的 hint 里（附带了几张图 / 为什么没带图）
     opts.prov / opts.model：按「界面上选中的那一家 / 那一个型号」判识图（AI 助手就是这样，
       它选的供应方和设置页保存的可能不是同一个）；不传就沿用保存值。 */
  async polishImages(REG, list, opts) {
    const items = (list || []).filter(x => x && x.src);
    if (!items.length) return { images: [], note: '' };
    const vis = await this.visionAsync(REG, opts && opts.prov, opts && opts.model);
    if (!vis.ok) return { images: [], note: `当前文字模型（${vis.model}）未启用识图（${vis.why}），本次只按文字润色；可在设置页把「识图能力」设为支持` };
    const max = (opts && opts.max) || 6;
    const images = await this.prepImages(items, opts);
    if (!images.length) return { images: [], note: '素材图没能读出来（可能已过期或不是图片），本次只按文字润色' };
    const more = items.length > images.length ? `（素材共 ${items.length} 张，只带了前 ${images.length} 张）` : '';
    return { images, note: '已附带 ' + images.length + ' 张素材图供文字 AI 识别：' + images.map((x, i) => '图' + (i + 1) + ' = ' + x.label).join('、') + more };
  },
  _headers(prov) {
    const h = { 'Content-Type': 'application/json' };
    const k = this.key(prov);
    if (k) h['Authorization'] = 'Bearer ' + k;
    const b = this.base(prov);
    if (b) h['X-Up-Base'] = b;
    return h;
  },
  /* 拉取该接口的模型列表（OpenAI 兼容 GET /models）
     prov = 要问哪一家（设置页传下拉里选中的那个）；不传就用当前在用的那家。
     顺带把「模型 → 能否识图」的接口声明记进缓存（vision 判定优先用它） */
  async models(REG, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const raw = await this.rawModels(REG, prov);
    // 同一次请求里顺手更新识图能力缓存，避免为了判定再拉一次 /models
    try {
      const byId = {};
      raw.forEach(m => { const id = m && (m.id || m.name); if (id) byId[id] = this.detectVision(m); });
      if (Object.keys(byId).length) {
        this._meta = byId;
        this._metaFor = prov.id;
        localStorage.setItem(this.metaKey(prov), JSON.stringify({ ts: Date.now(), byId }));
      }
    } catch (e) { console.warn('[TextAI] 识图能力缓存写入失败：', e.message); }
    return raw.map(m => ({ id: m.id || m.name, name: m.id || m.name, owned: m.owned_by || '' })).filter(m => m.id);
  },
  /* 服务端是否配了该平台的环境密钥（读 /env-status，缓存 60 秒） */
  async envHas(prov) {
    const kid = this.keyId(prov);
    const now = Date.now();
    if (this._envCache && now - this._envCache.ts < 60000) return !!(this._envCache.data[kid] || {}).hasEnv;
    try {
      const d = await netFetch('/env-status', { timeout: 8000 }).then(r => r.json());
      this._envCache = { ts: now, data: d || {} };
      this._envIds = this._envIds || {};
      Object.keys(d || {}).forEach(k => { if (d[k] && d[k].hasEnv) this._envIds[k] = true; });
      return !!(d[kid] || {}).hasEnv;
    } catch { return false; }
  },
  /* 本地用量记录：走 ui.js 的 Store（信封里的 ts 让数据文件对账能判新旧）。
     坏值（非数组 / 解析失败）一律当空处理，免得一条脏数据让后续每次调用都静默失败、用量再也记不上 */
  readUsageLog() {
    const v = window.Store && Store.read('ai_usage', []);
    return Array.isArray(v) ? v : [];
  },
  /* 能不能跑：本地填了密钥，或服务端有环境密钥（.env / 系统环境变量）。
     顺便把「哪几家在服务端配了密钥」记进 _envIds —— prov() 要靠它判断默认供应方能不能用。 */
  async canRun(REG) {
    await this.warm(REG);
    const prov = this.prov(REG);
    if (!prov) return false;
    if (this.key(prov)) return true;
    return await this.envHas(prov);
  },
  /* 文字 AI 返回的「一段 JSON」→ 对象：模型常把结果包在 ```json 代码块或前后加一句废话，
     三处（统一选择器 / 资产库 / 收藏页）以前各写一份解析，行为还不一样。统一到这里。 */
  parseJson(txt) {
    let s = String(txt == null ? '' : txt).trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  },
  /* 一次对话的请求体只拼一份：chat 与 chatStream 共用（各拼一份的话，
     识图编号、型号来源这两条迟早分叉）。 */
  async _body(REG, prov, sys, user, opts) {
    const o = Object.assign({}, opts || {});
    /* o.model = 页面当下选中的那个型号（设置页可能还没点保存）；不给就用本机保存的。
       「测试」按钮必须走它，否则会出现「下拉选了 A、实际发的是 B」。 */
    const model = o.model || this.model(prov);
    const images = (o.images || []).filter(x => x && x.url);
    const useVision = images.length > 0 && (await this.visionAsync(REG, prov, model)).ok;
    const content = useVision
      ? [{ type: 'text', text: user + '\n\n' + this.imageLegend(images) }]
        .concat(images.map(it => ({ type: 'image_url', image_url: { url: it.url } })))
      : user;
    return { model, body: {
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content }],
    } };
  },
  /* 用量落账也只有一份（流式与非流式都要记，否则流式上线后每日曲线会缺一块）。
     记录里的时间字段叫 at（发生时间），不叫 ts —— 信封自己占用了 ts（写入时间，
     数据文件对账比新旧用），两个含义混在一个键名里迟早算错。 */
  _logUsage(prov, model, d) {
    try {
      const u = (d && d.usage) || {};
      const arr = this.readUsageLog();
      arr.push({ at: Date.now(), prov: this.keyId(prov), model,
        pt: u.prompt_tokens || u.input_tokens || 0, ct: u.completion_tokens || u.output_tokens || 0 });
      Store.write('ai_usage', arr.slice(-500), { label: '文字 AI 用量' });
    } catch {}
  },
  /* 对话：返回纯文本（不强制本地密钥：留空时由代理注入环境变量里的密钥）
     opts.images = [{ label, url(dataURL) }]：模型支持识图时按 OpenAI 多模态格式带上，
     并在正文末尾附「图N = 哪张素材」的编号说明（模型据此在提示词里指代素材）。 */
  async chat(REG, sys, user, opts, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const { model, body } = await this._body(REG, prov, sys, user, opts);
    const r = await netFetch(prov.relay + (prov.endpoints?.chat || '/chat/completions'), {
      method: 'POST',
      headers: this._headers(prov),
      body: JSON.stringify(body),
      timeout: 120000,     // 长剧本拆解 / 带图润色本来就慢：给足时间，但不要无限等
      retry: 0,            // POST 不重试（没有幂等键，重试可能重复计费）
    });
    /* 同 rawModels：错误体可能不是 JSON，先兜住；翻译统一走 Api.errorMessage（闭包外的 TextAI 不能直接
       调 errorMessage，那是 Api 闭包里的私有函数 —— 以前这么调会抛 ReferenceError）。 */
    let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
    if (!r.ok) {
      const m = window.Api.errorMessage(d, r.status);
      throw new Error(m + this.authHint(prov, r.status, m));
    }
    const out = ((d.choices || [])[0] || {}).message?.content;
    if (!out || !String(out).trim()) throw new Error('文字 AI 没有返回内容');
    this._logUsage(prov, model, d);
    return String(out).trim();
  },
  /* 流式对话：边收边把片段交给 onDelta(片段, 'content'|'reasoning')，返回正文全文。
     为什么要它：写剧本 / 分镜这种长文本动辄十几秒，一次性等回来界面只能干转圈，
     人看不到 AI 正在写什么，也就无从判断方向对不对、要不要中途停。
     opts.signal 传给 Net.fetch —— 调用方要能真的中断这一次生成。
     降级有三条，任何一条都不报错（用户的「流式」只是体验，不该变成新的失败面）：
       ① 上游/代理没按 SSE 回（content-type 不是 event-stream）→ 当成一次性 chat 解析；
       ② 4xx 且请求体里的流式参数被拒（一些第三方中转把 stream_options 当未知字段）→ 先去掉这个
          可选参数再试一次流式，仍被拒才彻底退回非流式；
       ③ 退回只在**请求还没被受理**时成立 —— 已经收到过内容说明这次多半已受理，
          重发等于说两遍话、花两次钱，那种情况直接把错误抛回调用方。
     非 2xx 的错误文案与非流式同一条路（Api.errorMessage + authHint），别让人只看得到英文原文。 */
  async chatStream(REG, sys, user, opts, onDelta, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const o = Object.assign({}, opts || {});
    if (o.stream === false) return await this.chat(REG, sys, user, o, prov);
    const { model, body } = await this._body(REG, prov, sys, user, o);
    const url = prov.relay + (prov.endpoints?.chat || '/chat/completions');
    const hdr = Object.assign({}, this._headers(prov), { accept: 'text/event-stream' });
    /* 长等：流式本来就是一点点往外吐，Net 的默认超时会在模型思考时把连接掐掉。
       超时关掉（timeout:0），但不重试（retry:0）—— POST 没有幂等键。 */
    const ask = (extra) => netFetch(url, {
      method: 'POST', headers: hdr, body: JSON.stringify(Object.assign({}, body, extra)),
      timeout: 0, retry: 0, signal: o.signal,
    });
    let r = null, sentStreamOpts = true;
    try {
      /* include_usage：不带这一条，流式请求就再也记不到 tokens，用量页会静默少一块 */
      r = await ask({ stream: true, stream_options: { include_usage: true } });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('已经取消这次生成');
      throw e;
    }
    if (!r.ok) {
      let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
      const m = window.Api.errorMessage(d, r.status);
      /* 可以安全重发的只有「请求被拒」这一类 4xx：没受理、没扣费，去掉一个可选参数再试一次不会说两遍话。
       鉴权 / 欠费那种重发也还是同一个错（而且文案里带 key/余额，改它没意义），直接抛回去。
       判据不能只认 stream_options 这个字面（上游的说法五花八门：unknown parameter / not supported / extra field），
       也不能反过来什么 4xx 都重试 —— 那会把一次真正的坏请求变成两次。 */
      const hard = /40[13]|api.?key|密钥|auth|balance|credit|quota|insufficient|payment/i;
      if (!(r.status >= 400 && r.status < 500) || hard.test(m)) throw new Error(m + this.authHint(prov, r.status, m));
      sentStreamOpts = false;
      r = await ask({ stream: true });          // 只退回「不认这个可选参数」，仍是流式
      if (!r.ok) {
        let d2 = {}; try { d2 = (await r.json()) || {}; } catch (e) {}
        const m2 = window.Api.errorMessage(d2, r.status);
        if (!/stream|流式/i.test(m2)) throw new Error(m2 + this.authHint(prov, r.status, m2));
        return await this.chat(REG, sys, user, o, prov);   // ② 这家压根不流式
      }
    }
    /* content-type 要在**每一次**请求之后现取：退回重试时它是新响应的头，
       拿第一次那一份会一直停在「application/json」，于是流式响应被当成整包 JSON 去 parse，
       报出来的是「没有返回内容」这种和真实原因毫无关系的话（实测踩过）。 */
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('event-stream')) {
      /* ① 没流式：整包 JSON 也照样能用，只是没有过程显示 */
      let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
      const out = ((d.choices || [])[0] || {}).message?.content;
      if (!out || !String(out).trim()) {
        const m = window.Api.errorMessage(d, r.status);
        throw new Error((m && m !== 'HTTP ' + r.status ? m : '文字 AI 没有返回内容') + this.authHint(prov, r.status, m));
      }
      this._logUsage(prov, model, d);
      const txt = String(out);
      if (onDelta) { try { onDelta(txt, 'content'); } catch (e) {} }
      return txt.trim();
    }
    /* 中途断掉时「已经收到多少字」要如实说出来：面板上明明有字，只报一句「连接中断」
       会让人以为一个字都没拿到、又重发一次（那次是白花一轮 tokens 的）。 */
    let got = 0;
    let s = null;
    try {
      s = await readSseStream(r, (piece, kind) => {
        if (kind === 'content') got += piece.length;
        if (onDelta) { try { onDelta(piece, kind); } catch (e) {} }
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('已经取消这次生成');
      if (got) throw new Error('这次生成中途断了（已经收到 ' + got + ' 字，界面里能看到）：' + e.message);
      if (sentStreamOpts && /stream_options|unknown|unsupported|extra/i.test(e.message)) {
        return await this.chat(REG, sys, user, o, prov);
      }
      throw e;
    }
    if (!s.text.trim()) {
      if (s.reasoning.trim()) throw new Error('文字 AI 只回了思考过程，没有正文（换个型号试试）');
      throw new Error('文字 AI 没有返回内容');
    }
    this._logUsage(prov, model, { usage: s.usage });
    return s.text.trim();
  },
  /* ---- 反问（两段式润色的第一段）----
     润色之前先问几个最影响成片的要点，让用户点选或自己写；拿到回答再润色第二段。
     约定只回 JSON {"questions":[{"q":"…","options":["…"]}]}；模型不听话就按纯文本兜底解析，
     再不行返回 [] —— 调用方据此跳过问答直接润色，绝不因为「模型没按格式回」把功能卡死。 */
  parseQuestions(txt) {
    const j = this.parseJson(txt);
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.questions) ? j.questions : null);
    const out = [];
    if (arr) {
      arr.forEach(x => {
        const q = String((x && (x.q || x.question || x.title)) || '').trim();
        if (!q) return;
        const os = (Array.isArray(x.options) ? x.options : (Array.isArray(x.choices) ? x.choices : []))
          .map(o => String((o && (o.label || o.text)) || o || '').trim()).filter(Boolean).slice(0, 6);
        out.push({ q, options: os });
      });
      if (out.length) return out;
    }
    /* 兜底：回的是「1. 问题」+「- 选项」这种纯文本 */
    let cur = null;
    String(txt || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).forEach(l => {
      const m = /^(?:\d+[.、)]|[-*•])\s*(.+)$/.exec(l);
      if (!m) return;
      const body = m[1].trim();
      if (!body) return;
      if (/[?？]$/.test(body)) { cur = { q: body, options: [] }; out.push(cur); return; }
      if (cur && cur.options.length < 6) cur.options.push(body);
    });
    return out.filter(x => x.q);
  },
  /* 两段式润色的第一段：**让 AI 自己决定要不要问**，并把问题一次问完。
     判据不按字数（字数说明不了「够不够写」），由模型读完内容判断：缺了会明显影响成片的信息就问，
     已经够具体就 need=false，直接进润色。
     契约（写进提示词里，模型才知道自己有两段可选、答案会被怎么用）：
       {"need": true|false, "questions":[{"q":"问题","options":["候选1","候选2"]}]}
     返回 { need, questions }：调用方（InlinePolish.interactive / 导演台）据此决定要不要出问答面板。 */
  async askPolish(REG, sys, user, opts) {
    const sysAsk = String(sys || '')
      + '\n\n【这一轮你的任务：判断这段内容值不值得先问问题】\n'
      + '判断标准：如果补上缺失信息能明显改变成片效果，就问；如果内容已经足够具体（主体、动作、场景/氛围、'
      + '风格取向都说了），就直接说 need=false，别为了显得认真而提问。\n'
      + '提问要求：\n'
      + '1. 只问「缺的那部分」，缺几项问几项；不要复述用户已经写明的内容，也不要为了显得认真而把已经说清的再问一遍。\n'
      + '2. 每个问题都要具体到**能点选**（例：「光线与时间？黄金时刻 / 冷调夜景 / 阴天柔光」），'
      + '不要问「你还有什么要求」这种空问题。\n'
      + '3. options 给 3–4 个互斥的中文候选，覆盖常见选择；不要加解释、不要加「其它」。\n'
      + '4. 用户会在这些候选之外自己写字（每题都有一个自由输入框），所以候选不必穷尽。\n'
      + '5. 只输出 JSON，不要任何解释、不要 markdown 代码块：'
      + '{"need":true,"questions":[{"q":"问题","options":["候选1","候选2","候选3"]}]}\n'
      + '   不问就写 {"need":false,"questions":[]}。';
    let raw = '';
    try { raw = await this.chat(REG, sysAsk, user, opts); }
    catch (e) { return { need: false, questions: [], error: e.message }; }
    const j = this.parseJson(raw) || {};
    const questions = this.parseQuestions(raw);
    /* need 明确为 false 就别问；字段缺失时按「有问题就问」处理（保守：多问一次不至于毁掉结果） */
    const need = j && j.need === false ? false : questions.length > 0;
    return { need, questions };
  },
};

/* ============================================================================
   AssetTransfer —— 跨平台素材转存通用通道
   ---------------------------------------------------------------------------
   场景：素材来自 A 平台 / 本地 / 外部链接，但要用作 B 平台的输入
        （参考图、参考视频、参考音频、首尾帧…）。各平台上传流程不同，
        这里统一成三步：取字节 → 上传成目标平台资产 → 返回 asset_id。

     · blobOf(source)      统一取 Blob：
         File/Blob ｜ dataURL ｜ blob: ｜ 同源相对路径（/asset/xx）
         ｜ 外部 https 链接（自动经本地代理 /getfile 取回，绕过跨域）
     · uploadTo(provId, blob, name, opts)
         上传成该平台资产；**平台差异完全由 registry 的 endpoints 声明驱动**：
           endpoints.uploads   —— 取上传意图（POST，返回 {upload:{url}, asset_id}）
           endpoints.complete  —— 标记完成（POST，{id} 会被替换）
         未声明 uploads 的平台 → 明确抛错「暂无素材上传接口」（如 VGENV）
     · toAsset(provId, source, opts)   一步到位（带去重缓存，同一素材不重复上传）
     · crossTransfer(fromInfo, toProv, source, opts)   跨平台转存的显式写法

   以后接入新平台：只要在 proxy.js 的 registry 里给它写上 uploads/complete
   两个端点，本模块即可自动支持，业务代码无需改动。
   ========================================================================== */
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
    const bin = atob(String(dataUrl).split(',')[1] || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }
  function extOf(blob, name) {
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
    const m = (blob.type || '').split('/')[1] || 'bin';
    const map = { quicktime: 'mov', mpeg: 'mp3', 'x-wav': 'wav', jpeg: 'jpg' };
    return 'asset-' + Date.now() + '.' + (map[m] || m);
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
    /* 本平台资产 id 的形态（SparkCine 是 UUID）。本地资产 la_* / 别家平台的 id 直接当 asset_id 提交会被上游判为
       「Invalid UUID」→ 顶层只回一句「部分内容需要检查。」，所以提交前先用它把不属于本平台的 id 挡掉，改走上传字节。 */
    isPlatformId(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '')); },
    /* 统一取 Blob（自动选路：本地 / 同源 / 外部代理） */
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
      const url = isExternal ? '/getfile?url=' + encodeURIComponent(s)
        : (s.startsWith('/asset/') ? s + (s.includes('?') ? '&' : '?') + 'dl=1' : s);
      if (onStage) onStage('fetch', s);
      const r = await netFetch(url, { timeout: 180000, retry: 1 });   // 大视频取回可能较久；GET 可安全重试
      if (!r.ok) throw new Error('取回素材失败 HTTP ' + r.status);
      const b = await r.blob();
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
      const filename = opts.name || extOf(blob, name);
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
      const intentRes = await netFetch(prov.relay + up, {
        method: 'POST', headers, body: JSON.stringify(body), timeout: 30000, retry: 0,
      });
      if (!intentRes.ok) throw new Error('取上传地址失败 HTTP ' + intentRes.status + '（' + (prov.displayName || prov.name) + ' 的上传接口）');
      const intent = await intentRes.json();
      if (intent.error) throw new Error(intent.error.message || '上传意图获取失败');
      const assetId = intent.asset_id || intent.assetId || (intent.asset && intent.asset.id);
      if (!assetId || !intent.upload || !intent.upload.url) throw new Error('上传意图返回异常（缺少 asset_id 或 upload.url）');

      if (opts.onStage) opts.onStage('put', filename);
      const putHeaders = intent.upload.headers || {};
      if (opts.onStage) opts.onStage('progress', { sent: 0, total: blob.size, pct: 0 });   // 先报 0%，状态行立刻切成进度显示
      const put = await netFetch('/s3put?url=' + encodeURIComponent(intent.upload.url), {
        method: intent.upload.method || 'PUT', headers: putHeaders, body: blob,
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
  };
})();

/* ============================================================================
   PromptLog —— 提示词归档
   ---------------------------------------------------------------------------
   每次创建任务都把提示词存成归档文件夹里的一份文件（走本地代理的 /prompts 落盘）。
   文件名 = <时间>-<类型>-<标题>.md，正文含标题 / 时间 / 类型 / 平台 / 模型 / 任务号。
   标题由文字 AI 起（一句短标题）；没配文字 AI 或调用失败就取提示词前 10 个字。
   目录在「设置 → 提示词归档」里改（prompt_dir，只存本机：路径换台机器就不一样了，不参与云同步）。

   为什么不用 localStorage：那份记录只在当前浏览器里、看不见也搜不了；
   存成文件夹之后能直接翻、能同步、能喂给别的工具，任务号 → 提示词也能按需查回来。
   ========================================================================== */
(function () {
  const DIR_KEY = 'prompt_dir';
  const cache = new Map();          // '平台|任务号' → 提示词（同步读，供资产库补显示）
  const byTask = new Map();         // 任务号 → 提示词：归档时写的平台名可能和列表来源不一样
                                    //（如媒体路由把 sparkcine 的视频条目归到 sparkcine-video），只按「平台|任务号」查就会 miss
  const remember = (provId, id, prompt) => {
    if (!id) return;
    const p = String(prompt || '');
    cache.set(keyOf(provId, id), p);
    if (!byTask.has(String(id))) byTask.set(String(id), p);
    /* 两张表都要各自封顶：以前淘汰 byTask 时用**当前这次调用的 provId** 去拼 cache 键，
       被淘汰那条的键根本删不掉，于是 cache 一整个会话只增不减。 */
    if (cache.size > 4000) cache.delete(cache.keys().next().value);
    if (byTask.size > 4000) byTask.delete(byTask.keys().next().value);
  };
  const titles = new Map();         // 提示词 → 标题（同一次会话里同一个提示词只问一次文字 AI）
  const inflight = new Map();
  let loadedAt = 0, loading = null, warned = false;

  const dir = () => { try { return localStorage.getItem(DIR_KEY) || ''; } catch (e) { return ''; } };
  const setDir = d => { try { d ? localStorage.setItem(DIR_KEY, d) : localStorage.removeItem(DIR_KEY); } catch (e) {} };
  const keyOf = (provId, id) => (provId || '') + '|' + id;

  async function req(path, opts) {
    const o = opts || {};
    const r = (window.Net && window.Net.fetch)
      ? await window.Net.fetch('/prompts' + path, { ...o, retry: o.retry === undefined ? 1 : o.retry })
      : await fetch('/prompts' + path, o);
    const txt = await r.text();
    let d = null;
    try { d = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) {
      const err = new Error((d && d.error && d.error.message) || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return d;
  }
  /* 归档失败只提示一次：创作流程不该因为存不了提示词被打断 */
  function warnOnce(e) {
    if (warned || !window.Toast) return;
    warned = true;
    Toast.warn('提示词没能归档到文件夹（' + e.message + '）：可到「设置 → 提示词归档」检查目录', 7000);
  }

  /* 归档的整包导出 / 恢复（走代理的 POST /prompts/export 与 /prompts/import）。
     以前归档只躺在磁盘上的一堆 .md 里：不在 .data/（云同步带不走），
     也不在 localStorage / IndexedDB 里（整包备份同样带不走）——
     换机器、清浏览器数据、误删目录，就只剩「没了」这一种结果。 */
  const dirQuery = () => { const d = dir(); return d ? '?dir=' + encodeURIComponent(d) : ''; };
  async function exportAll() { return await req('/export' + dirQuery(), { method: 'POST', body: '{}' }); }
  async function importAll(files) {
    return await req('/import' + dirQuery(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files || [] }), timeout: 120000, retry: 0,
    });
  }

  /* 兜底标题：提示词前 10 个字（去掉换行与多余空白） */
  const fallbackTitle = prompt => String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 10);
  function cleanTitle(s) {
    const line = String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    return line
      .replace(/^#+\s*/, '')
      .replace(/^(标题|Title)\s*[:：]\s*/i, '')
      .replace(/^["'“”「『（(]+|["'“”」』）)]+$/g, '')
      .replace(/[。，、,.!！?？;；:：]+$/g, '')
      .trim().slice(0, 24);
  }
  /* 让文字 AI 起标题；没配文字 AI / 超时 / 返回不可用 → 空串（调用方用前 10 个字兜底） */
  async function aiTitle(REG, prompt) {
    const k = String(prompt).slice(0, 600);
    if (titles.has(k)) return titles.get(k);
    if (inflight.has(k)) return inflight.get(k);
    const job = (async () => {
      try {
        const sys = '你是命名助手：把用户给的创作提示词概括成一句能当文件名的短标题。\n'
          + '要求：中文提示词给 8–16 个汉字，英文提示词给 3–6 个单词；用名词短语，'
          + '概括画面主体与场景，不要写「一段视频」「生成图片」这类废话，不要标点。\n'
          + '只输出标题本身：不要引号、不要书名号、不要解释、不要多个方案。';
        const out = await Promise.race([
          TextAI.chat(REG, sys, k),
          new Promise((_, rej) => setTimeout(() => rej(new Error('起标题超时')), 12000)),
        ]);
        return cleanTitle(out);
      } catch (e) { return ''; }
      finally { inflight.delete(k); }
    })();
    inflight.set(k, job);
    const t = await job;
    titles.set(k, t);
    if (titles.size > 300) titles.delete(titles.keys().next().value);
    return t;
  }

  /* 归档一份提示词（不 await 也不抛错：调用方 fire-and-forget 即可，不拖慢创建任务） */
  async function save(REG, info) {
    const prompt = String((info && info.prompt) || '').trim();
    if (!prompt) return null;
    try {
      const title = String((info.title || '')).trim() || (await aiTitle(REG, prompt)) || fallbackTitle(prompt);
      const body = {
        dir: info.dir !== undefined ? info.dir : dir(),
        title, type: info.type || '任务', prompt,
        provider: info.provider || '', model: info.model || '',
        task: info.task || '', meta: info.meta || null,
      };
      const d = await req('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), timeout: 20000 });
      // 顺手更新内存索引：刚提交的任务立刻能在资产库里看到提示词，不必等下次刷新
      if (d && d.ok && info.provider && info.task) remember(info.provider, info.task, prompt.slice(0, 300));
      return d;
    } catch (e) { warnOnce(e); return null; }
  }

  /* 归档索引 → 内存缓存（资产库补显示用；同步读缓存，所以这里后台拉一次） */
  async function load(force) {
    if (!force && Date.now() - loadedAt < 60000) return cache.size;
    if (loading) return loading;
    loading = (async () => {
      try {
        // limit 默认 300 太少：索引里没有的老任务，卡片就只能显示「（该平台接口不返回提示词）」
        const d = await req('?dir=' + encodeURIComponent(dir()) + '&limit=800', { timeout: 15000 });
        (d.recent || []).forEach(r => { if (r.p && r.i) remember(r.p, r.i, r.pr || ''); });
        loadedAt = Date.now();
        return cache.size;
      } catch (e) { return cache.size; }
      finally { loading = null; }
    })();
    return loading;
  }
  const cached = (provId, id) => (id ? cache.get(keyOf(provId, id)) || '' : '');
  /* 只按任务号查（归档里的平台名和列表来源对不上时用得上，见 byTask 注释） */
  const cachedById = id => (id ? byTask.get(String(id)) || '' : '');
  /* 回源查过、确认本机没有归档（'平台|任务号'）：不再重复问，界面也敢说「本机没归档」。
     这个结论要**活过页面刷新**：视频台一屏就是 20+ 条没有归档的老任务，集合只存内存的话
     每次刷新都重新回源问一遍（实测一次加载 40 多个 404 请求）。
     存 sessionStorage —— 同一标签页内有效，不进 .data/、不进云同步（它是缓存，不是用户数据）。 */
  const MISSED_KEY = 'pl_missed_v1';
  const missed = new Set();
  try {
    const raw = sessionStorage.getItem(MISSED_KEY);
    if (raw) for (const x of JSON.parse(raw)) if (typeof x === 'string') missed.add(x);
  } catch (e) {}
  let missedTimer = 0;
  const saveMissed = () => {
    clearTimeout(missedTimer);
    missedTimer = setTimeout(() => {
      try { sessionStorage.setItem(MISSED_KEY, JSON.stringify([...missed].slice(-3000))); } catch (e) {}
    }, 300);
  };
  const fulls = new Map();            // 任务号 → 归档里的**全文**（索引只带前 300 字，够卡片用，详情面板要整份）
  const finding = new Map();          // 任务号 → 进行中的查询：同一任务并发只发一次请求
  const setFull = (id, p) => {
    if (fulls.size > 400) fulls.delete(fulls.keys().next().value);
    fulls.set(String(id), p);
  };
  /* 按任务号回源取**整份**归档提示词（详情面板、以及索引窗口外的老任务用） */
  async function findByTask(provId, id) {
    if (!id) return '';
    const k = String(id);
    if (fulls.has(k)) return fulls.get(k);
    if (missed.has(keyOf(provId, id)) || missed.has(keyOf('', id))) return '';
    if (finding.has(k)) return finding.get(k);
    const job = (async () => {
      const enc = encodeURIComponent;
      /* **一个任务号只发一个请求**：provider 只告诉服务端「优先返回哪一份」，
         匹配到的全部归档都在 all 里一起带回来。
         以前这里是「带 provider 查一次 → 查不到再不带 provider 查一次」，
         而第二次多半和第一次逐字节相同（本机根本没归档），于是每条老任务固定多一个 404。
         provider 传不传都一样能用，所以现在总是带上 —— 少一半请求，也少一半噪声。 */
      let d = null;
      try { d = await req('/find?id=' + enc(id) + '&provider=' + enc(provId || ''), { timeout: 15000 }); }
      catch (e) { d = null; }                        // 404 = 本机没有归档，不是错误
      finding.delete(k);
      if (d && d.prompt) {
        const p = String(d.prompt);
        setFull(id, p);
        remember(provId, id, p.slice(0, 300));
        /* 同一任务号的其它归档（换过平台 id 重复提交的那些）也记下来：
           换 provider 再查时直接命中缓存，省一次请求。 */
        (d.all || []).forEach(a => { if (a && a.provider && a.pr) remember(a.provider, id, String(a.pr)); });
        missed.delete(keyOf(provId, id)); missed.delete(keyOf('', id));
        saveMissed();
        return p;
      }
      if (missed.size > 4000) { missed.clear(); }
      missed.add(keyOf(provId, id)); missed.add(keyOf('', id));
      saveMissed();
      return '';
    })();
    finding.set(k, job);
    return job;
  }
  /* 这条任务是不是「本机确实没有归档」（回源查过才算，没查过返回 false）：
     界面据此区分「平台不返回提示词，但本机归档里能找到」和「两边都没有」。 */
  const missedFor = (provId, id) => !!id && (missed.has(keyOf(provId, id)) || missed.has(keyOf('', id)));
  /* 归档目录信息（设置页展示） */
  const list = () => req('?dir=' + encodeURIComponent(dir()));
  const open = () => req('/open?dir=' + encodeURIComponent(dir()), { method: 'POST' });
  /* 平台默认类型：页面没指定时按平台种类给一个（图片 / 视频 / 语音 / 文字） */
  const KIND_ZH = { image: '图片生成', video: '视频生成', audio: '语音合成', text: '文字' };
  const ctxType = prov => KIND_ZH[(prov && prov.kind) || ''] || '任务';

  /* 启动后拉一次索引（资产库给不返回提示词的任务补显示要用），之后每 5 分钟对一次；
     代理没在跑就静默失败 —— 归档是锦上添花，不能挡住页面本身。 */
  setTimeout(() => load(false), 2500);
  setInterval(() => load(true), 5 * 60 * 1000);

  /* 「本机没有这条归档」的结论（sessionStorage）：清掉它会重新按任务号回源问一遍。
     刚往归档目录里手工补了文件、或换了归档目录时用它，不用刷新页面。 */
  const clearMissed = () => { const n = missed.size; missed.clear(); saveMissed(); loadedAt = 0; return n; };

  window.PromptLog = { save, load, cached, cachedById, findByTask, missedFor, clearMissed, list, open, dir, setDir, ctxType, fallbackTitle, cleanTitle, aiTitle, exportAll, importAll };
})();

/* ============================================================================
   TextAI 余额（不再折算金额：文字 AI 只记录 tokens 用量，展示见「用量与余额」页）
   ========================================================================== */
/* 各平台余额接口规格（只有声明了 url 的能精确查询） */
window.TextAI.BALANCE = {
  deepseek: { url: '/user/balance', parse: d => {
    const b = (d.balance_infos || [])[0] || {};
    return { ok: true, currency: b.currency || 'CNY', amount: Number(b.total_balance || 0),
      extra: `充值 ${b.topped_up_balance ?? '—'} · 赠送 ${b.granted_balance ?? '—'}`, available: d.is_available !== false };
  } },
  moonshot: { url: '/users/me/balance', parse: d => {
    const b = (d.data || {});
    const amount = Number(b.available_balance ?? 0);
    return { ok: true, currency: 'CNY', amount, extra: `现金 ${b.cash_balance ?? '—'} · 代金券 ${b.voucher_balance ?? '—'}`, available: true };
  } },
  siliconflow: { url: '/user/info', parse: d => {
    const b = (d.data || {});
    const amount = Number(b.totalBalance ?? b.balance ?? 0);
    return { ok: true, currency: 'CNY', amount, extra: b.chargeBalance != null ? `充值余额 ${b.chargeBalance}` : '', available: true };
  } },
  /* OpenRouter 的 /credits 只认**管理密钥**，普通 API key 会回 403 —— 那是正常的，
     页面会照实显示原因。侧栏余额卡不画它（那边只有 micros / 积分两种解析形状，硬套会显示成 ¥0.00）。 */
  openrouter: { url: '/credits', parse: d => {
    const b = (d && d.data) || {};
    const total = Number(b.total_credits ?? 0), used = Number(b.total_usage ?? 0);
    return { ok: true, currency: 'USD', amount: Math.max(0, total - used),
      extra: `充值 $${total.toFixed(2)} · 已用 $${used.toFixed(2)}`, available: true };
  } },
};
/* 查询某文字 AI 平台的余额（未声明接口的返回 {ok:false, reason}）
   带出 status：鉴权类判定要用它（401 = 密钥无效；403 = 密钥有效但权限不够，例如 OpenRouter 只让管理密钥查余额）。 */
window.TextAI.fetchBalance = async function (REG, prov) {
  const kid = this.keyId(prov);
  const spec = this.BALANCE[kid];
  if (!spec) return { ok: false, unsupported: true, reason: '该平台没有公开的余额查询接口' };
  try {
    const r = await netFetch(prov.relay + spec.url, { headers: this._headers(prov), timeout: 15000 });
    let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
    if (!r.ok) {
      const reason = (d.error && (d.error.message || d.error.code)) || ('HTTP ' + r.status);
      return { ok: false, status: r.status, reason: reason + this.authHint(prov, r.status, reason) };
    }
    const out = spec.parse(d);
    return out.ok ? out : { ok: false, status: r.status, reason: '返回格式不符' };
  } catch (e) { return { ok: false, reason: e.message }; }
};

/* 验证「这把密钥到底能不能用」——不花钱的那种判法。
   为什么需要它：OpenRouter 的 `GET /models` 是**公开**的（不鉴权也能拉到全量型号），
   所以「获取模型列表成功」完全不能证明密钥有效，等真正润色时才炸出一句
   "Authentication Fails, Your api key: ****xxxx is invalid"，很容易以为是别的地方配错了。
   判据用余额接口的状态码（免费、不计费）：
     200 → 密钥有效（顺带报余额）
     401 → 密钥无效
     403 → 密钥有效但这个接口要更高权限（OpenRouter 的 /credits 只认管理密钥）→ 当作「有效」
     无接口 / 其它 → unknown，让用户点「测试」发一条消息来验
   返回 { state, text }，settings.html 直接显示。 */
window.TextAI.verifyKey = async function (REG, prov) {
  const p = prov || this.prov(REG);
  if (!p) return { state: 'unknown', text: '注册路由里没有文字 AI 供应方' };
  const r = await this.fetchBalance(REG, p);
  if (r.ok) return { state: 'ok', text: '✓ 密钥可用（余额 ' + (r.currency || '') + (Number(r.amount) || 0).toFixed(2) + (r.extra ? ' · ' + r.extra : '') + '）' };
  if (r.status === 401) return { state: 'invalid', text: '✗ 密钥无效：上游 401 拒绝了这把钥匙（' + this.who(p) + '）' };
  if (r.status === 403) return { state: 'ok', text: '✓ 密钥可用（余额接口要更高权限，普通密钥 403 属正常；余额看 ' + (p.site || '平台后台') + '）' };
  if (r.unsupported) return { state: 'unknown', text: '这个平台没有免费的余额接口，验不了密钥：点「测试」发一条消息来验（会消耗一点额度）' };
  return { state: 'unknown', text: '没验成：' + (r.reason || '未知原因') + '　（' + this.who(p) + '）' };
};

/* 资产/任务条目 → 统一的费用 { cost, unit }：积分优先，其次金额（micros → 元） */
window.AssetLib.costOf = function (e) {
  if (!e) return { cost: null, unit: '' };
  if (e.credits != null && e.credits !== '') {
    const n = (e.credits && typeof e.credits === 'object') ? (e.credits.charged ?? e.credits.held ?? null) : Number(e.credits);
    if (n != null && !isNaN(n)) return { cost: n, unit: '积分' };
  }
  if (e.priceMicros != null) {
    const n = Number(e.priceMicros) / 1e6;
    if (!isNaN(n)) return { cost: n, unit: '元' };
  }
  return { cost: null, unit: '' };
};

/* ============================================================================
   AssetLib.estimateCost —— 生成前的费用预估（导演台 / 图片台 / 视频台 / 语音台共用）
   定价方式全部读 registry 的 provider.pricing 声明（新平台只声明，不改页面）：
     per_image_table   模型自带 price{档位:单价}，× 张数
     per_second_table  拉 endpoint（一般是 models）里的 pricing.perSecond，× 秒数 × 条数
     quote             调 endpoint 实时报价（?duration=&resolution=&tier=&aspect_ratio=）
     per_1k_chars      模型自带 price.per1kChars，× 字数/1000
   返回 { ok, text, detail, reason }：ok=false 时 reason 是「为什么没有价格」，界面照实显示。
   opts.cache：可选的按 key 缓存（平台模型表拉取很慢，页面传一个 Map/对象即可复用）
   opts.qualityLabel：把质量档位翻成中文（可选） */
/* 报价接口打不通的平台（VGENV 的 /v2/pricing 是 404 空壳）：一次判定记下来，整个会话不再问。
   不记的话用户每改一次档位/时长都要白打一次请求（一次 15 秒超时），列表和参数区跟着发抖。 */
const QUOTE_UNAVAILABLE = new Set();
const QUOTE_INFLIGHT = {};      // 同参数正在飞的报价请求 → 共享同一个 Promise
/* 判定要落到本机：以前只在内存里记，于是每次刷新页面都要重新吃一串 404
   （导演台一次重排就给每个分镜估一次价）。记一小时，过期后再探一次，平台真开了报价也不用改代码。 */
const QUOTE_MARK_KEY = 'sk_quote_unavailable';
const QUOTE_MARK_TTL = 3600 * 1000;
function quoteMarks() {
  try {
    const m = JSON.parse(localStorage.getItem(QUOTE_MARK_KEY) || '{}');
    const now = Date.now();
    Object.keys(m).forEach(k => { if (!(m[k] > now)) delete m[k]; });
    return m;
  } catch (e) { return {}; }
}
function quoteDead(k) { return QUOTE_UNAVAILABLE.has(k) || Object.prototype.hasOwnProperty.call(quoteMarks(), k); }
function markQuoteDead(k) {
  QUOTE_UNAVAILABLE.add(k);
  try {
    const m = quoteMarks();
    m[k] = Date.now() + QUOTE_MARK_TTL;
    localStorage.setItem(QUOTE_MARK_KEY, JSON.stringify(m));
  } catch (e) {}
}
function clearQuoteMarks() {
  QUOTE_UNAVAILABLE.clear();
  try { localStorage.removeItem(QUOTE_MARK_KEY); } catch (e) {}
}
window.AssetLib.estimateCost = async function (prov, model, p = {}, opts = {}) {
  const pr = (prov && prov.pricing) || null;
  if (!pr) return { ok: false, reason: '该 API 未声明定价方式' };
  const n = Number(p.count || 1) || 1;
  const cur = pr.currency || '';
  try {
    if (pr.type === 'per_image_table') {
      const unit = model && model.price ? model.price[p.quality] : null;
      if (unit == null) {
        const q = opts.qualityLabel ? (opts.qualityLabel[p.quality] || p.quality) : p.quality;
        return { ok: false, reason: '该模型没有「' + (q || '?') + '」档定价' };
      }
      return { ok: true, text: '约 ' + (unit * n) + ' ' + cur, detail: unit + ' ' + cur + '/张 × ' + n + ' 张' };
    }
    if (pr.type === 'per_second_table') {
      const cache = opts.cache || {};
      const ck = 'mt_' + prov.id;
      if (!cache[ck]) cache[ck] = await Api.request(prov, pr.endpoint || 'models');
      const list = cache[ck].data || cache[ck].models || [];
      const m = list.find(x => x && x.id === (model && model.id));
      const sec = Number(p.duration || 5);
      const ps = ((m && m.pricing && m.pricing.perSecond) || []).find(x => x.resolution === p.res);
      if (ps) {
        const total = Math.round(ps.credits * sec * n * 100) / 100;
        return { ok: true, text: '约 ' + total + ' ' + cur, detail: ps.credits + ' ' + cur + '/秒 × ' + sec + '秒 × ' + n + ' 条' };
      }
      if (m && m.pricing && m.pricing.minimumCredits) return { ok: true, text: '最低 ' + m.pricing.minimumCredits + ' ' + cur };
      return { ok: false, reason: '模型表中没有 ' + (p.res || '?') + ' 的单价' };
    }
    if (pr.type === 'quote') {
      const ep = pr.endpoint || 'price';
      const qk = (prov && prov.id ? prov.id : String(ep)) + '|' + ep;
      if (quoteDead(qk)) return { ok: false, reason: '该平台未开放报价接口' };
      const q = '?duration=' + sec0(p.duration) + '&resolution=' + (p.res || '') + '&tier=' + (p.tier || '') + '&aspect_ratio=' + (p.ar || '');
      const full = Api.url(prov, ep) + q;
      /* 同参数的并发只发一趟：导演台一次重排会给每个分镜估一次价，参数常常一模一样，
         报价接口又是 15 秒超时的那种 —— 七条一样的请求既白等也打上游。 */
      if (QUOTE_INFLIGHT[full]) return await QUOTE_INFLIGHT[full];
      const one = (async () => {
        const r0 = await Net.fetch(full, { headers: Api.headers(prov), timeout: 15000, retry: 0 });
        if (r0.status === 404) { markQuoteDead(qk); return { ok: false, reason: '该平台未开放报价接口' }; }
        if (!r0.ok) return { ok: false, reason: '报价接口 HTTP ' + r0.status };
        const d = await r0.json();
        const micros = (d.price && d.price.amount_micros) ?? d.amount_micros ?? (d.data && d.data.price && d.data.price.amount_micros);
        if (micros) {
          const each = Number(micros) / 1e6;
          return { ok: true, text: '约 ¥' + (each * n).toFixed(2), detail: '¥' + each.toFixed(2) + '/条 × ' + n + ' 条' };
        }
        return { ok: false, reason: d.message || '报价接口未返回价格' };
      })();
      QUOTE_INFLIGHT[full] = one;
      try { return await one; } finally { delete QUOTE_INFLIGHT[full]; }
    }
    if (pr.type === 'per_1k_chars') {
      const unit = model && model.price ? model.price.per1kChars : null;
      if (unit == null) return { ok: false, reason: '平台未提供价格' };
      const chars = Number(p.chars || 0);
      if (!chars) return { ok: false, reason: '还没有文本，无法预估' };
      const total = chars / 1000 * Number(unit);
      return { ok: true, text: '约 ' + (pr.currency || '¥') + total.toFixed(4),
        detail: chars + ' 字 × ' + (pr.currency || '¥') + unit + '/千字' };
    }
    return { ok: false, reason: '未知的定价类型 ' + pr.type };
  } catch (e) { return { ok: false, reason: (e && e.message) || '报价请求失败' }; }
};
function sec0(v) { return Number(v || 5); }
