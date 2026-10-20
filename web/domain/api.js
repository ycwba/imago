/* 网络 / 接口层：媒体地址、状态归类、统一取数与 Api（全站唯一出口）。
   从 assetlib.js 拆出（报告 §6.1-2：按已有的 window 面切文件，不改调用点）。
   这里仍是浏览器经典脚本：顶层函数就是全站共享的那一份 —— AssetLib / TextAI /
   asset-transfer / local 都裸调 mediaKey / netFetch / respBody / readSseStream。
   加载顺序见 shell.html：api.js → assetlib.js → gen-forms.js。 */

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

   注意：这些必须定义在**模块作用域**。AssetLib 的 normalize() 与 Fav 都是裸调用；
   写成 Api 闭包内会让 VGENV 列表在 Promise.allSettled 里静默整批消失，收藏一起坏。 */
/* 「剥哪些签名参数」「怎么从 /getv 包装里取内层」这两条判据只在 ident.js 有一份。
   以前这里是本文件自己抄的一份正则，proxy.js 那边又抄了一份，注释里写着
   「两边必须一致」却没有任何东西保证它一致 —— 漂一次的后果是同一份产物被反复
   下载落盘、资产库里同一张卡重复出现 N 次。
   ident.js 没加载就在下面这行当场炸（TypeError 指向 MediaId），**不要在这加兜底副本**：
   悄悄退回第二份判据，正好是这次要拆掉的东西。 */
const { innerMedia, upKeyOf } = window.MediaId;
/* 素材身份：内外层地址都算得出来，签名换了它不变。相对地址靠 location.href 当 base；
   代理那边只吃绝对外链所以不用 base —— 那一层差异留在各自的薄壳里，
   共享的是 upKeyOf（「剥哪些参数、怎么拼」那一条真正会漂的判据）。 */
function mediaKey(u) {
  const inner = innerMedia(u);
  if (!inner) return '';
  try { return upKeyOf(new URL(inner, location.href)); } catch (e) { return inner; }
}
/* 列表接口一页多少条的兜底值（平台自己在 registry 的 `list.limit` 里声明过就用它声明的那一个）。
   写在模块作用域：`Api` 与 `AssetLib` 两个闭包都要用它，而资产库页把「跳到第 N 页」换算成
   「要拉几批」时问的也是这同一份 —— 以前那个 100 在六个调用点各抄一遍、页面再抄第七遍，
   改了声明就只对一半的地方生效。 */
const LIST_LIMIT_DEF = 100;
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
  /* 「提交结果未知」是独立的一档，既不算失败也不算在跑：算失败就会画出「重试」，用户点下去是第二次
     扣费；算在跑就会进轮询集合，而这条根本没有任务号可问。判据只有 Api.maybeSubmitted 一处。 */
  if (mapped === 'uncertain') return 'uncertain';
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
  /* 产物在本机存过（自动镜像）→ 用本机那一份。这一步放在**地址层**而不是列表层：
     以前只有 AssetLib.decorate 会换（它只服务列表条目），于是设置页那个
     「优先用本机文件」的开关只管得着资产库那张列表 —— 收藏、导演台里存着的
     还是当年的签名外链，第二天 403，表现就是「视频没有预览图、点开只回一句 Format error」，
     而本机明明有那一个文件。勾了「优先用本机」却照打外链 = 开关在骗人。
     只认 http(s) 与 /getv 包装（/fetch 的下载语义、本机地址自己都不用再换）。
     **这里不处理 /asset/<平台产物号> 那一路**：它在抽帧那边已经由缩略图键解决
     （keyOf → localAssetIdOf → 同一个本机号，抽帧地址随即变成本机文件，见 workbench.js）。
     在这一层改它会越过「优先用本机文件」开关去换**画面上取哪个字节** —— 那是开关自己的活。 */
  if (/^(https?:|\/getv\?)/i.test(u)) {
    const AL = window.AssetLocal;
    const loc = (AL && AL.localCopyOf) ? AL.localCopyOf(u) : '';
    if (loc) return loc;
  }
  /* 外链统一改走本地代理：页面里的 <img>/<video>/fetch 只碰本地地址，字节由代理取回
     （/getv 支持 Range，播放、抽帧、量体积、下载都能用），所以「所有外部访问都经过本地路由」
     这条规则没有例外，也不会因为上游没给 CORS 头而抽不出帧。 */
  const out = /^https?:\/\//i.test(u) ? '/getv?url=' + encodeURIComponent(u) : u;
  if (!mediaExpired(out)) return out;
  /* 过期地址先查会话内回源结果：只查内存表、不发请求，所以不拖首屏；
     还没换到就把旧的给出去（让画面先出来，回源在后台跑）。 */
  return rewrapMedia(out, FRESH.get(mediaKey(out)));
}
/* 本机资产地址的唯一拼法（AGENTS.md §6.3「页面不许拿 assetId 自己拼 /asset/<id>」以前只是一句
   规定、没有可走的入口，所以全站拼了 36 处，`?v=2` 这种缓存位与 `?dl=1&name=` 的编码各写各的）。
   缓存位 `v` 是这一份实现说了算：资产内容不可变，但同一号可能被重新落盘覆盖一次，
   所以留一个版本号；要按条目失效就把 vOf 换进来。 */
function assetSrc(id, opts) {
  const a = String((opts && opts.v) != null ? (opts.v) : '2');
  const s = String(id == null ? '' : id).trim();
  return s ? '/asset/' + encodeURIComponent(s) + '?v=' + encodeURIComponent(a) : '';
}
/* 已经拼好的本机地址（可能带 ?v=2）→ 下载地址：`?dl=1` 这一笔也只在这一处出现。
   收的是**地址**不是号：取字节那两条路（导演台转 dataURL、资产层取回）手上本来就是一条 src，
   不是本机资产地址的原样返回。 */
function assetDlSrc(src, name) {
  const s = String(src == null ? '' : src);
  if (!s.startsWith('/asset/')) return s;
  const n = String((name == null ? '' : name) || '').trim();
  return s + (s.includes('?') ? '&' : '?') + 'dl=1' + (n ? '&name=' + encodeURIComponent(n) : '');
}
function assetDl(id, name, opts) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return '';
  return assetDlSrc(assetSrc(s, opts), name);
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
/* 响应体只读一次，交出「解析出的 JSON」与「不是 JSON 时的那段原文」。
   为什么要有它：TextAI 那几处（型号列表 / 对话 / 流式 / 余额）自己发请求、不走 Api.rawFetch，
   以前每个调用点各写一遍 `try { r.json() } catch {}` —— 解析一失败正文就被扔掉，于是本地代理写在
   text/plain 里的那句真原因（打到哪一台、为什么连不上）在界面上只剩「HTTP 502」。
   `plain` 只在解析失败时才有内容：JSON 响应本来就该走 d，把整包 JSON 当错误文案糊到界面上是另一种难读
   （「没有返回内容」那种 200 空回复以前靠 'HTTP 200' 这句兜底才说得清，别把它换成一段正文）。
   原文交给 Api.errorMessage 兜底（见那里的 textMsg），两条路共用同一份「状态码 → 一句人话」。 */
async function respBody(r) {
  const x = await window.Net.readRes(r);
  return { d: (x.d && typeof x.d === 'object') ? x.d : {}, plain: x.parseErr ? x.txt : '' };
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
/* 顶层开关（create.topBools）在线上真正发什么值 —— **一处判据**，提交体与报价体都用它。
   默认就是布尔的开 / 关；声明了 `send: { on, off }` 的按那一对发别的形状 ——
   VGENV 的提示词优化就是这种：prompt_optimization 必须是**对象**（{mode:'enhance'} / {mode:'raw'}），
   发布尔或字符串上游一律 400（2026-10 实测）。 */
function topBoolValue(decl, on) {
  if (decl && decl.send) return on ? decl.send.on : decl.send.off;
  return !!on;
}
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
  const PROXY_VERSION_MIN = 17;
  /* 文案单独做成纯函数：好单测（页面里那条提示本身没什么分支，值不值得测的是这句话写没写清楚）。
      newest 的那一条排在最前面 —— 用户撞上的永远是这一版新加的那些声明没生效，
     从最老的说起等于让他先去找一个和他无关的原因。 */
  function oldProxyNotice(version) {
    const v = Number(version || 0);
    if (!v || v >= PROXY_VERSION_MIN) return '';
    return '本地代理是旧版（v' + v + '，这一版页面要 v' + PROXY_VERSION_MIN + '）：部分能力声明不会生效'
      + '（v16 起注册表不再下发任何一份写死的文字型号清单（全部改名 modelDocs）：'
      + '型号清单一律来自平台自己的 /models，取回的落进 .data/sk_model_prefs.json。'
      + '旧代理还会把那份写死的清单当「型号有哪些」发过来，于是设置页那张清单列的是它、'
      + '型号下拉里没有它，点下去报「不在下拉的选项里」；'
      + 'v15 起「这一档到底给不给」多了一层逐行能力：VGENV 的 Turbo 与成片 2x 超分写在'
      + '(画质档 × 手上这批素材种类) 上，旧代理没有那份逐行清单，界面上这两项不会出现；'
      + '同一版还把随机种子与「动作起点（秒）」做成声明式的顶层字段（`create.shapeFields`），'
      + '旧代理不认识就整块不画；「动作换人」那一档也不再声明成「根本不询价」，'
      + '旧代理会对着报价接口发一次注定被平台拒的请求，把「这一档不问价」显示成一句失败；'
      + '同一版还按平台文档给 VGENV 带上了幂等键 —— 旧代理不带，超时后既不敢重试也挡不住重复扣费。'
      + '再往前：v14 起「每一种素材收什么文件、单个多大」写在注册表的 `roleRules` 里，'
      + '旧代理没有这一份，界面上那两行规矩会整块消失；v13 起型号清单也不在本地兜底，'
      + '旧代理不读 .data/sk_model_prefs.json，所以在设置页「自己填的型号」'
      + '与「隐藏 / 展示」在工作台里完全不生效，下拉里还是它自己那份写死的清单；'
      + '设置页「添加自定义供应商」登记的那几家也是旧代理才要读 .data/sk_custom.json，'
      + '文字 AI 那一类在更旧的代理上还会被当成「找不到模板」丢掉）。'
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
     两个地方问的是同一件事：设置页「本机环境」那一栏、助手的 doctor。
     各写一遍就会出现「设置页说能用、助手说不能用」，探测参数也会走样 ——
     它要在本机起子进程跑 ffmpeg -version，慢机器上几秒不够，而且**不许重试**（同一次体检打两遍）。 */
  const SYS_WHY = {
    ffmpeg: '导演台「导出成片 / 导出素材」靠本机 ffmpeg 把时间线拼起来、把配音混进视频；没装时生成照常能走，到导出那一步才拦。'
      + '要修：装好 ffmpeg（ffmpeg.exe 与 ffprobe.exe 放在同一个目录），把那个目录加进系统 PATH，'
      + '用启动器重启一次代理，回来点「重新体检」。',
    ffprobe: '量每一段素材的真实秒数（剪辑的出点与这一段有没有原声都按它判）；没有它成片时间会漂。'
      + '要修：它与 ffmpeg 同一个安装包里，确认 ffprobe.exe 和 ffmpeg.exe 在同一个目录、且那个目录在 PATH 里。',
    健康: '代理进程自己有没有出过错。它按设计不会为了一次异常退出（本地工具不该打断使用），所以这一格说「出过」的时候，出路只有一条：在启动器点「重启」。重启后这份账清零；页面本身就是这台代理发出来的，不能在这一页重启它。',
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
  /* 代理进程自己那份账（/sys-status 顶层「健康」）：芯片与整句都来自代理，页面只挑颜色。
     旧代理没返回这一项一律黄字「没读到」，**不写「正常」** —— 替一个从没记账的进程作保，
     比标黄更糟：人会觉得「健康那一格绿着，那异常肯定在别处」。 */
  function sysHealth(h) {
    /* 「没读到」那句也只在这里说一次：复制文本、设置页、助手三边都要用它，各写一遍就会各自漂 */
    if (!h) return { chip: '没读到', why: '这个代理还是加「健康」那一格之前启动的，重启后才有', cls: 'warn', 最近: [], 存活: '', 起于: '', 最后请求: '', 计数: null };
    return { chip: h.芯片 || '?', why: h.说明 || '', cls: h.档 || 'warn',
      最近: h.最近 || [], 存活: h.存活 || '?', 起于: h.起于 || '?', 最后请求: h.最后请求 || '?',
      计数: { 未捕获异常: h.未捕获异常 || 0, 'Promise失败': h.Promise失败 || 0, '请求出错': h.请求出错 || 0, 连接错误: h.连接错误 || 0, 页面报错: h.页面报错 || 0 } };
  }
  /* 「最近几条」那一行的拼法只在这里一份：复制文本与设置页那一行都读它，
     各写一遍就会出现「复制出去有位置、页面上没有」这种两边都对不上的小事。
     `limit` 不给或 0 = 全给（复制出去的份要完整），设置页只摆前几条并说清还有几条。 */
  function sysFaultLines(list, limit) {
    const all = list || [];
    const n = limit > 0 ? Math.min(limit, all.length) : all.length;
    const out = all.slice(0, n).map(f => '· ' + (f.时候 || '?') + ' ' + f.种类 + '：' + f.消息
      + (f.重复 > 1 ? '（同一处已重复 ' + f.重复 + ' 次）' : '') + (f.位置 ? ' @ ' + f.位置 : ''));
    if (all.length > n) out.push('· …另有 ' + (all.length - n) + ' 条（代理只留最近几条，重启后清零）');
    return out;
  }
  /* 「哪家现在挤、最近被限过几回」那几行的拼法只在这里一份（复制文本与设置页那一行的 title 都读它），
     各写一遍就会出现「复制出去有平台名、页面上没有」。`limit` 不给或 0 = 全给（复制的那份要完整），
     设置页只摆最挤的几台并说清还有几台。 */
  function relayLines(r, limit) {
    const det = (r && r.明细) || [], ev = (r && r.最近) || [], out = [];
    const n = limit > 0 ? Math.min(limit, det.length) : det.length;
    det.slice(0, n).forEach(g => out.push('· ' + g.平台 + '：在途 ' + g.在途 + ' · 排队 ' + g.排队
      + (g.退过 ? ' · 被限流后重问 ' + g.退过 + ' 次' : '') + (g.等过 ? ' · 等过名额 ' + g.等过 + ' 次' : '')
      + (g.拒过 ? ' · 排满拒了 ' + g.拒过 + ' 条' : '')));
    if (det.length > n) out.push('· …另有 ' + (det.length - n) + ' 家有账（只报最挤的几台）');
    const m = limit > 0 ? Math.min(limit, ev.length) : ev.length;
    ev.slice(0, m).forEach(x => out.push('· ' + (x.时候 || '?') + ' ' + x.平台 + ' ' + x.事
      + (x.重复 > 1 ? '（同一件已重复 ' + x.重复 + ' 次）' : '')));
    if (ev.length > m) out.push('· …另有 ' + (ev.length - m) + ' 件（只留最近几件，重启后清零）');
    return out;
  }
  /* 整份体检 → 给人看的几行（设置页复制出去、助手 doctor 念的都是这几行） */
  function sysStatusLines(s) {
    if (!s) return ['本机环境：没读到（代理没在运行，或者它是加 /sys-status 之前启动的旧版）'];
    const p = s.代理 || {}, dirs = s.目录 || {}, out = [];
    out.push('本地代理：注册表 v' + (p.版本 || '?') + ' · 端口 ' + (p.端口 || '?')
      + ' · Node ' + (p.进程 || '?') + ' · 目录 ' + (p.目录 || '?'));
    /* 健康紧跟「本地代理」：它说的就是这个进程自己。以前顶层异常只往日志打一行就继续跑，
       日志轮转 + 启动器一关就找不回来，界面上一切正常 —— 这一行是那份账唯一的出口。 */
    const hh = sysHealth(s.健康);
    if (!s.健康) out.push('代理健康：' + hh.chip + ' —— ' + hh.why + '；' + SYS_WHY.健康);
    else {
      out.push('代理健康：' + hh.chip + ' · 已运行 ' + hh.存活 + '（起于 ' + hh.起于 + '）· 最后一次干活 ' + hh.最后请求
        + (hh.cls === 'ok' ? '（' + hh.why + '）' : '：' + hh.why) + ' —— ' + SYS_WHY.健康);
      sysFaultLines(hh.最近).forEach(l => out.push('  ' + l));
    }
    /* 出站代理那一行紧跟着「本地代理」：在必须走代理才能出网的环境里，
       「平台请求有没有从代理出去」是排查「所有平台都连不上」的第一个问题。 */
    const op = s.出站代理;
    if (op) out.push('出站代理：' + (op.状态 || '?') + ' —— ' + (op.来源 || '?'));
    ['ffmpeg', 'ffprobe'].forEach(k => {
      const t = sysTool(s[k], k);
      out.push(k + '：' + t.chip + (t.why ? (t.cls === 'ok' ? '（' + t.why + '）' : '：' + t.why) : '')
        + ' —— ' + SYS_WHY[k]);
    });
    /* 成片渲染那一行说的是「现在真的会怎么出片」，不是「.env 里写了什么」：
       编码器、档位与那三个数字都是启动时定一次（改了要重启），所以来源跟着一起打出去。
       旧代理没返回这一项就不写这一行 —— 缺它不影响导出，写一句「没读到」反而像坏了。 */
    const rd = s.渲染;
    if (rd) out.push('成片渲染：' + (rd.编码 || '?') + '（' + (rd.中文名 || '?') + '）· 档位 ' + (rd.档位 || '?')
      + ' · 同时 ' + (rd.同时 || '?') + ' 条 · 队列上限 ' + (rd.队列上限 || '?') + ' · 任务记录留 ' + (rd.保留分钟 || '?') + ' 分钟'
      + ' · 本机：' + (rd.本机说明 || '?') + ' —— ' + (rd.来源 || ''));
    /* 平台转发闸那一行说的是「这一家现在挤不挤、刚才有没有被限过流」：429/503 透到页面上只是
       一句「请求失败」，看不出是被人限了、也看不出等一会儿就会好 —— 这一行是那句废话的背面。
       芯片、整句、四个数与来源都在代理那边拼好（与「成片渲染」同一立场），这里只照念。
       旧代理没返回这一项就不写这一行：没有闸时代码照样跑得动，写一句「没读到」反而像坏了。 */
    const rl = s.转发;
    if (rl) {
      out.push('平台转发闸：' + (rl.芯片 || '?') + ' —— ' + (rl.说明 || '?') + ' —— ' + (rl.来源 || ''));
      relayLines(rl).forEach(l => out.push('  ' + l));
    }
    [['数据', '数据目录（.data）'], ['资产', '本机资产目录'], ['渲染', '成片目录']].forEach(pair => {
      const d = sysDir(dirs[pair[0]]);
      out.push(pair[1] + '：' + d.chip + (d.why ? '（' + d.why + '）' : '') + ' —— ' + (d.path || '?'));
    });
    return out;
  }

  /* ---------- 本机资产库占了多少地方（/assets-usage）：一份取法、一份说法 ----------
     与上面 /sys-status 那一族同一个立场：设置页那一栏要念，将来助手也要念，
     各写一遍就会出现「这里说压了 3 份、那里说没有重复」。
     代理那侧**只数不删**（口径全文在 proxy.js 的 `localUsageScan` 上面那段注释），
     所以这一族的「出路」只能指向资产库那一条有二次确认的删除路 —— 在这一格放一颗清理按钮，
     等于让一次统计顺带动用户的作品，而统计**永远分不出**「多余的重复」与
     「被挤出索引但还要留着的历史产物」（就是 `索引外` 那一句）。
     字节与时间**只在调用时**取 window 上的公共实现：`api.js` 在有的页面比 `ui.js` 先加载，
     求值期去抓就等于抓到 undefined（全站同一族的毛病，踩过）。 */
  const USAGE_WHY = {
    重复: '同一件产物在这台机器上存了不止一次（来源外链相同，或字节完全相同）——这里只报份数，不动文件',
    索引外: '盘上有、索引里没有：多半是索引顶到上限后被挤掉的历史产物，按资产号还能补建出来，不是垃圾',
    没文件: '索引里有、盘上文件没了：这张卡在资产库点开会取不到字节（会先试着回平台重下一趟）',
    上限: '顶到上限之后新产物照样落盘，但列表里不再出现',
    没验完: '内容级判重一次有字节预算，用完就停 —— 剩下那些同大小的没读，不算「确认不重复」',
    出路: '想腾地方：到「资产库」勾上不要的那些卡片点删除（有二次确认），被删掉的文件才会真从盘上带走 —— 这一格只数不删',
  };
  function usageBytes(n) {
    const v = Number(n) || 0;
    const t = (typeof window.fmtBytes === 'function') ? window.fmtBytes(v) : '';
    return t || (v + ' B');
  }
  function usageWhen(t) {
    return (typeof window.fmtWhen === 'function' && t) ? window.fmtWhen(t) : '';
  }
  /* 旧代理没有这一条 → 404 当「没读到」（返回 null），**不许当 0 字节**：
     「数不到」与「盘上是空的」是两件事，说成后者会让人以为产物丢了。
     `retry: 0`：这是一次真扫盘（可能读到几百 MB），重一次就把用户的盘再翻一遍。 */
  async function assetsUsage() {
    try {
      return await rawFetch('/assets-usage', { method: 'GET', cache: 'no-store', retry: 0, timeout: 60000 });
    } catch (e) {
      if (e && e.status === 404) return null;
      throw e;
    }
  }
  /* 整份读数 → 给人看的几行（设置页摆出来、复制出去的都是这几行）。
     `limit` 不给或 0 = 「最占地方 / 最旧的」全摆（代理本来也只回 USAGE_TOP 条），
     设置页只摆前几条；条数不由页面写死。 */
  function usageLines(u, limit) {
    if (!u) return ['本机资产库：没读到（代理没在运行，或者它是加 /assets-usage 之前启动的旧版）'];
    const d = u.目录 || {}, t = u.总 || {}, r = u.重复 || {}, gap = u.对不上 || {}, disk = u.盘 || {};
    const out = [];
    out.push('目录：' + (d.状态 || '?') + ' —— ' + (d.路径 || '?'));
    /* 两处磁盘别混：这一格只数本机资产库（.assets，应用自己那份、离线能看、删了能回源）。
       设置页「另存到指定文件夹」里的副本属于用户的成品目录，不归这一格统计、也不归这里删。 */
    out.push('范围：只数本机资产库（.assets）；「另存到指定文件夹」的副本不在这里，也不归这一格删。');
    out.push('产物 ' + (t.文件数 || 0) + ' 个 · 共 ' + usageBytes(t.字节)
      + ' · 索引 ' + (t.索引条数 || 0) + ' 条'
      + (t.顶到上限 ? '（已顶到上限 ' + (t.上限 || '?') + ' 条 —— ' + USAGE_WHY.上限 + '）'
        : '（上限 ' + (t.上限 || '?') + ' 条）'));
    const ks = (u.按类型 || []).filter(k => k && k.条数);
    if (ks.length) out.push('按类型：' + ks.map(k => k.类型 + ' ' + usageBytes(k.字节) + '（' + k.条数 + ' 个）').join(' · '));
    const dup = (r.多出份数 || 0) > 0;
    out.push('重复：' + (dup ? '压了 ' + r.多出份数 + ' 份 · 多占 ' + usageBytes(r.多占字节)
        : (t.文件数 ? '没有' : '还没有产物')) + ' —— ' + USAGE_WHY.重复);
    if (r.组数) {
      out.push('  同来源 ' + (r.同来源组 || 0) + ' 组 · 字节相同 ' + (r.同内容组 || 0) + ' 组 · 读过 '
        + (r.验过文件 || 0) + ' 个文件（' + usageBytes(r.读了字节) + ' / 预算 ' + usageBytes(r.预算字节) + '）'
        + (r.没验份数 ? ' · 还有 ' + r.没验份数 + ' 份同大小的没验 —— ' + USAGE_WHY.没验完 : ''));
    }
    if (gap.索引外文件数) out.push('  索引外 ' + gap.索引外文件数 + ' 个（' + usageBytes(gap.索引外字节) + '）—— ' + USAGE_WHY.索引外);
    if (gap.没文件条数) out.push('  索引有、文件没了 ' + gap.没文件条数 + ' 条 —— ' + USAGE_WHY.没文件);
    if (disk.剩余 != null) out.push('这块盘剩余：' + usageBytes(disk.剩余));
    const top = n => (limit > 0 ? Math.min(limit, n.length) : n.length);
    [['最占地方', u.最大], ['最旧的', u.最旧]].forEach(pair => {
      const list = pair[1] || [], k = top(list);
      if (!list.length) return;
      list.slice(0, k).forEach(x => out.push('  · ' + x.名称 + '　' + usageBytes(x.字节) + ' · ' + x.类型
        + (x.时候 ? ' · ' + (usageWhen(x.时候) || x.时候) : '') + (x.哪家 ? ' · ' + x.哪家 : '')
        + (x.有索引 ? '' : ' · 没进索引')));
      if (list.length > k) out.push('  · …另有 ' + (list.length - k) + ' 条');
    });
    out.push(USAGE_WHY.出路);
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
  /* 哪一句算「余额 / 额度不够」：只有这一份正则。
     ERROR_HINT 用它补人话，Api.isBalanceErr 用它判「要不要给一个去充值/查余额的入口」——
     两处各写一份的话，一边认得的错误另一边不认得，界面上就会「有时有按钮、有时只有一句红字」。 */
  const BALANCE_RE = /余额不足|insufficient|quota|not enough/i;
  const ERROR_HINT = [
    [/PROMPT_COMPILER|PROMPT_OPTIMI|prompt compiler/i, '平台的「提示词编译/优化」服务这次出错了（VGENV 侧，间歇性）——「这条任务没有创建、没有扣费」，稍后重试即可（本页会自动重试一次）'],
    [/需要检查|需人工|under review/i, '平台这次把提交拦下来了（上游只回这一句，实测是间歇性的：同一句提示词过一会儿就能过）——隔几十秒再来一次通常就好'],
    [BALANCE_RE, '平台账户余额/额度不够，先到「用量与余额」页看看余额'],
    [/rate limit|too many|频繁|429/i, '请求太频繁，等几十秒再试'],
    [/unauthorized|invalid.*(api|token|key)|401/i, '密钥无效或过期：到「设置」重新填这个平台的密钥（或在 .env 里更新）'],
    [/forbidden|403|permission/i, '这个密钥没有调用该接口的权限（可能是账号未开通 / 权限范围不对）'],
    [/not found|unknown model|does not exist|404/i, '接口或资源不存在：型号可能已被平台下线，任务可能已过期/被清理 —— 换一个型号，或刷新列表看看'],
    [/too large|payload|413|文件过大/i, '素材太大：压缩后再传（视频/音频建议压到几十 MB 以内）'],
    [/unsupported|not support|不支持/i, '平台不支持这次请求的参数组合：换一个参数（分辨率 / 时长 / 比例）再试'],
    [/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i, '与平台的连接中断（网络抖动）：稍后重试；若是大素材上传，先确认网络稳定'],
    [/getaddrinfo|ENOTFOUND|EAI_AGAIN/i, '本机没能把那个域名解析成地址（DNS 给不出结果、被拦，或压根没有这个域名）：给这台电脑换一个能用的 DNS（如 223.5.5.5）再试，或在设置页把这家的接口地址换成可达的中转'],
  ];
  /* 上游「泛化校验失败」：只有一句 message、没有字段级 issues —— 实测是间歇性的（同一请求稍后就能过），
     界面会据此提示「隔一会儿再试」；但**不自动重试**（重试会连发请求、把平台限流顶得更死）。 */
  const isTransient = err => err && err.status === 400 && /VALIDATION_FAILED/i.test(err.code || '') && !(err.issues || []).length;
  /* 响应体不是 JSON 时，那一段正文就是唯一的信息：网关的错误页、以及本地代理转发失败时
     写回的那句 text/plain 真原因（「打到 openrouter.ai：getaddrinfo ENOENT …」）。
     以前只 JSON.parse 一次，解析失败就把整段扔掉，界面只剩一句 HTTP 502 —— 真实原因明明已经
     到了客户端，却被我们自己丢了，而且 502 这个数字既不说是哪一台、也不说是哪一步坏的。
     剥掉标签、压平空白、截到 200 字：够看清是哪一台哪一步，又不会把整页 HTML 糊进那一行。 */
  function textMsg(t) {
    const s = String(t == null ? '' : t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }
  function errorMessage(d, status, rawText) {
    const e = (d && d.error) || {};
    const issues = (e.details && Array.isArray(e.details.issues)) ? e.details.issues
      : (Array.isArray(e.issues) ? e.issues : []);
    const base = e.message || e.code || (d && (d.message || d.code)) || textMsg(rawText) || ('HTTP ' + status);
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
    const x = await window.Net.read(url, { ...opts, retry: opts.retry === undefined ? 1 : opts.retry });
    if (!x.ok) {
      const err = new Error(errorMessage(x.d, x.status, x.parseErr ? x.txt : ''));
      err.status = x.status;
      err.code = (x.d && x.d.error && x.d.error.code) || (x.d && x.d.code) || '';
      err.issues = (x.d && x.d.error && x.d.error.details && x.d.error.details.issues) || (x.d && x.d.issues) || [];
      err.transient = isTransient(err);
      /* 提交类请求 + 5xx/超时：**不知道平台收没收到**。页面据此提示「可能已受理、先核对列表」，
         而不是让用户以为失败直接重试（那会在平台上留下两条重复任务）。 */
      if (['POST', 'PUT', 'PATCH'].includes(method) && (x.status >= 500 || x.status === 408 || x.status === 429)) err.maybeSubmitted = true;
      throw err;
    }
    if (x.d === null && x.parseErr) {
      const t = textMsg(x.txt);
      throw new Error('返回了非 JSON 内容（HTTP ' + x.status + '）' + (t ? '：' + t : ''));
    }
    return x.d;
  }

  /* 平台的「提示词编译器」偶发失败（VGENV 的 PROMPT_COMPILER_UPSTREAM_ERROR）：
     这种错误说明任务**没有创建**，重试是安全的（不像超时/连接中断那样可能已受理）。
     页面据此自动重试一次，不要各自写正则。 */
  function isRetryableCreateError(e) {
    const t = String((e && (e.code || e.message)) || e);
    return /PROMPT_COMPILER|PROMPT_OPTIMI|prompt compiler/i.test(t);
  }

  /* 「这次提交**不知道平台收没收到**」—— 全站只此一份判据（就在它产生的地方旁边）。
     两个来源合起来：
       ① err.maybeSubmitted —— 上面那条对 5xx / 408 / 429 的标记；
       ② 传输层就断了（Net 超时、断连）—— 那时连HTTP 状态码都没拿到，平台那边可能早已受理。
     **必须把它当成「未知的成功」而不是「失败」**：用户看到「失败」最自然的反应是再点一次，
     而视频平台建任务经常超过 30 秒 —— 那不是边缘情况，是常态，那一下就是第二次扣费。
     studio.html 的 trackSubmit、director.html 的提示、以及助手这一路都读它。 */
  function maybeSubmitted(e) {
    if (!e) return false;
    if (e.maybeSubmitted) return true;
    return /超时|timeout|中断|连接|Failed to fetch|fetch failed|上游响应超时|ECONNABORTED|ETIMEDOUT/i
      .test(String(e.message || e));
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
    assetSrc,                       // 本机资产 → /asset/<号>（全站唯一拼法，页面不要再自己拼 ?v=2）
    assetDl,                        // 本机资产号 → 下载地址（?dl=1 + 可选名字，编码只在这一处）
    assetDlSrc,                     // 已经是 /asset/ 地址 → 同一地址的下载写法（取字节那两条路用它）
    mediaKey,                       // 素材身份（host+path+稳定 query）：缓存键、去重、比对都用它
    innerMedia,                     // /getv?url=… 或 /fetch?url=…&dl=1 里取出内层外链
    signedExpiry, mediaExpired,     // 签名外链的过期时刻（毫秒）/ 是否已过期（不发请求）
    healMedia,                      // 一批过期地址按平台回源换新（onFresh 里由调用方落盘）
    classifyStatus,                 // 上游状态串 → done / queued / running / failed（唯一判据，页面别自己认词）
    /* 型号清单响应 → 数组（字段表读注册表顶层 modelList.fields；服务端 modelRowsOf 同一份声明） */
    modelRows(d) {
      const f = (_reg && _reg.modelList && _reg.modelList.fields) || ['data', 'models', 'result', 'items'];
      return Array.isArray(d) ? d : (f.map(k => d && d[k]).find(Array.isArray) || []);
    },
    /* 上游错误 → 人话（带 ERROR_HINT 的中文下一步）。TextAI 自己发请求、不走上面的 rawFetch，
       但错误文案必须一致 —— 所以这份格式化对外公开，而不是在 TextAI 里再抄一份。
       （踩过：以前 TextAI 直接调闭包内的 errorMessage，运行期 ReferenceError，界面显示
         「检索失败：errorMessage is not defined」。） */
    errorMessage,
    isRetryableCreateError,         // 平台提示词编译失败等「任务肯定没建」的错误 → 可安全重试
    maybeSubmitted,              // 「可能已受理，结果未知」—— 绝不能写成「失败」，判据全站只有这一份
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
          _regErr = errText(e);
          if (!_reg) _reg = { providers: [] };
          console.warn('[Api] 注册表读不到（' + _regErr + '）—— 型号、能力与「配没配密钥」在它起来之前都不可信');
        }
      }
      warnOldProxy(_reg);
      warnProxyDown(_reg);
      /* 「这一家配没配密钥」顺带取一次：型号下拉要靠它把**没添加**的那几家筛掉
         （`pickable` → `provUsable`）。以前只有设置页调 `envStatus()`，于是导演台 / 生成工作台 /
         各页面各自的 `envKnown()` 恒为假 → 判据按「读不到就不筛」处理 → 没配密钥的厂商照样出现在
         下拉里。**不在这里补，就只能每个页面各写一行**，而漏一处就有一页不对。
         刻意不 await：它只影响下拉筛谁，不该让整页等它；失败也无所谓（envKnown 保持假 = 不筛）。 */
      if (!_envOk) { try { await this.envStatus(); } catch (e) {} }
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
    /* 本机环境（/sys-status）只有一份取法与一份说法：设置页那一栏、
       助手的 doctor 三边都要问，各写一遍就会出现「设置页说能用、助手说不能用」。 */
    sysStatus, sysTool, sysDir, sysHealth, sysFaultLines, relayLines, sysStatusLines, SYS_WHY,
    /* 本机资产库用量（/assets-usage）同一族：设置页那一栏与复制文本读这同一份。 */
    assetsUsage, usageLines, usageBytes, usageWhen, USAGE_WHY,
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
    /* 新任务能用哪几家：**停用的不出现，没添加（没配密钥）的也不出现**。
       以前这里只筛「停用」（sk_off_），于是注册表里声明了型号、但本机压根没配密钥的那几家
       （openai / moonshot / siliconflow / minimax-video …）照样出现在各页面型号下拉里 ——
       用户在生成工作台的视频下拉里看到的是 minimax/h3、T2V-01-Director 这类
       **本机根本调不通**的型号，而真正配了密钥的 vgenv 反而被挤到看不见。
       「能不能用」直接问 provUsable（**唯一一份判据**：设置页「供应商与密钥」、
       侧栏余额、这里三处共用），不再各写一份。
       **读不到 /env-status 时保持原样**：envKnown() 为假时一律放行 ——
       判据缺数据不等于「这一家没配」，把靠服务端 .env 配密钥的平台一起清掉是更坏的错。

       **只筛这一条路径**：Api.prov() 与 REG.providers 照样能查出被筛掉的那几家，
       否则关掉一家 / 没配密钥的那家，它名下的**历史任务**会被渲染成「未知平台」
       （收藏、资产库、导演台都在读旧任务 —— 那是另一个查询，不是「新任务能用谁」）。 */
    pickable(provs) {
      const list = provs || this.providers();
      return list.filter(p => {
        if (this.isOff(p)) return false;
        /* **必须把 _env 传进去**：provUsable 的环境密钥那一档读的是**参数** env，
           不传就只剩 localStorage 与 custom 两档 —— 于是**靠服务端 .env 配密钥的
           sparkcine / vgenv / mimo 会整批从下拉里消失**（比「多列出没配的」更坏：
           那是把本来能用的也弄没了）。 */
        return this.envKnown() ? this.provUsable(p, _env) : true;
      });
    },
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
    /* 删掉一家：清单里那条 + 它名下的密钥 / 停用勾选 / 万一存过的地址 / 型号偏好一起清。
       只删清单会留下 `sk_key_cus-xxx` 这种没人认领的死数据，而且它跟着云同步出网。
       自填型号那一格以前没清：删掉之后它那份型号还留在盘上，而 keyId(null) 会兜底成
       'deepseek'，于是这份死数据在别处被读出来时表现成「别家凭空多出几个我填过的型号」。 */
    customDrop(id) {
      this.customSet(this.customList().filter(e => e && e.id !== id));
      /* 清干净这一家名下的每一把钥匙。
         `sk_model_` 是漏掉过的那一个（L41）：设置页按 `sk_model_<keyId>` 存
         型号，而 EXPORTABLE 又把 `sk_model_` 整段导出去 —— 删掉一家之后它的型号选择还留在盘上，
         跟着导出/云同步跑到另一台机器；那边注册表里没有这个 keyId，这份死数据就没人认领了。 */
      ['sk_key_', 'sk_off_', 'sk_base_', 'sk_model_'].forEach(p => localStorage.removeItem(p + id));
      /* 「自己填的型号」与「隐藏了哪几个」现在住在同一份 `sk_model_prefs` 里、按 keyId 分格，
         所以这里按格子摘，而不是再往 `sk_text_models_<id>` 上删一次 —— 那个键已经并进新键了，
         留着一条删除路径等于承认还有两处记录。 */
      if (window.ModelPrefs) window.ModelPrefs.drop(id);
    },
    /* 端点 URL：端点名 → relay + 模板（{id} 用 sub 替换） */
    url(prov, name, sub) {
      const ep = prov && prov.endpoints && prov.endpoints[name];
      if (!ep) throw new Error(((prov && prov.name) || '该平台') + ' 没有声明「' + name + '」接口（这个型号没声明）');
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
      let d;
      try {
        d = await rawFetch(this.url(prov, name, opts.id) + q, {
          method: opts.method || 'GET',
          headers,
          body: opts.body != null ? JSON.stringify(opts.body) : undefined,
          timeout,
        });
      } catch (e) {
        /* 余额类错误在这一层补「这一家的余额在哪儿看」：`errorMessage` 那一层不认识 provider，
           而「去用量与余额页看看」这句话对没有余额接口的家（MiMo）是**指错路**的。
           就地改 err.message 再抛同一个对象：status / code / issues / transient / maybeSubmitted
           那几个字段一个都不能丢（丢了页面上的「可能已受理」判据就失效）。 */
        if (this.isBalanceErr(e)) { try { e.message += this.balanceHint(prov); } catch (e2) {} }
        throw e;
      }
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
      /* 建了一条真任务就说一声（判据与发送都在 workbench.js 的总线那一处）：
         此刻活着的那个页面如果手里没有这一条，它既不会去轮询、也不会自己重拉列表 ——
         表现就是「在导演台出了图，资产库不点重新加载就一直看不到」。
         包一层 try：这是通知，不能因为它把「任务其实已经建好了」这件事说成一次提交失败。 */
      if (name === 'create') {
        try { if (window.Wb && Wb.busEmit) Wb.busEmit('create', { provider: (prov && prov.id) || '' }); } catch (e) {}
      }
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
      return { via, label: via === 'credits' ? '余额' : via === 'models' ? '型号清单' : via === 'list' ? '任务列表' : '' };
    },
    /* 验证用的请求头：opts 里传了 key/base 就用**表单里此刻的那一对**（设置页「验证」按钮要用它，
       否则要先等它落盘才能试，而这一页落盘的凭据是「改完」= change，正在敲的那一半还没进盘）；
       没传就用磁盘上保存过的那对。 */
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
      if (!t.via) return { ok: false, why: '这一家没有声明任何只读的接口（余额 / 型号清单 / 列表），本机没法验证密钥' };
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
        /* 积分账户原样报数，金额账户折成 ¥ 两位小数 —— 口径只在 Api.balText 一处 */
        return { ok: true, via, label, detail: '余额 ' + (this.balText(b) || '读不出数') };
      }
      const arr = this.modelRows(d);
      if (!Array.isArray(arr)) return { ok: true, via, label, detail: '通了，但返回的不是清单（界面按能力声明兜底）' };
      return { ok: true, via, label, detail: '通了，' + label + ' ' + arr.length + ' 条' };
    },
    /* 创建任务：标准字段 → registry 声明的请求体（nest 决定哪些要嵌进 parameters） */
    createBody(prov, f = {}) {
      const spec = (prov && prov.create) || null;
      if (!spec) throw new Error(((prov && prov.name) || '该平台') + ' 没有声明怎么提交（这个型号不完整）');
      /* ---------- 提交体第一道闸：`model` 必须是**型号 id 字符串** ----------
         上游对 model 的形状校验最严（`model must be a string` + 一条 `xxx/yyy` 的正则），
         而页面很容易把**模型对象**顺手传进来 —— 因为「选中的模型」在页面里就是对象
         （`currentModel()` 给 `{prov, model}`），只有 `.id` 才是那个字符串。
         studio.html 的视频那一路就这么错了很久：图片那一路写的是 `model.id`（对）、
         视频那一路写的是裸 `model`（错），两边不一致 → 上游收到一个对象，
         回的是「model must be a string / must match …」，
         而那句话与用户在界面上做的事**毫无关系**（他明明选了型号）。
         所以在这里当场拦下并**说清怎么修**（给的是哪一项、现在的值长什么样）——
         把「一个看不懂的上游报错」变成「一句话指出代码哪一处传错了」。
         只有声明里真的要用 model 的平台才校验：TTS 那一族有的不收这个字段，
         对它们传什么都不该因此报错。 */
      const usesModel = Object.values(spec.body || {}).includes('model')
        || Object.values(spec.nest || {}).some(pairs => (pairs || []).some(x => (Array.isArray(x) ? x[1] : x) === 'model'))
        || /\{\{\s*model\s*\}\}/.test(String(spec.template || ''));
      if (usesModel) {
        if (typeof f.model !== 'string' || !f.model.trim()) {
          const got = f.model === undefined ? 'undefined（压根没传）'
            : f.model === null ? 'null'
              : (typeof f.model === 'object' ? '一个对象' + (f.model.id ? '（里面那个 id 是「' + f.model.id + '」，看起来该传的是它）' : '（它身上连 id 都没有）') : typeof f.model + '：' + String(f.model));
          throw new Error('提交给「' + ((prov && (prov.displayName || prov.name)) || prov.id) + '」的 model 要是「型号 id 字符串」，'
            + '现在拿到的是 ' + got + '。这一项由页面点明 —— 页面里「选中的模型」是对象，'
            + '传之前要取它的 `.id`（型号 id 长这样：' + ((prov && prov.models && prov.models[0] && prov.models[0].id) || 'xxx/yyy') + '）');
        }
      }
      const std = { model: f.model, prompt: f.prompt, tier: f.tier, duration: f.duration, res: f.res,
        ar: f.ar, quality: f.quality, count: f.count, format: f.format,
        /* size = 「宽x高」那一类画幅参数（SiliconFlow 的 image_size、OpenAI 兼容的 size）。
           与 ar（比例写法）是两种东西：平台在 create.body 里把 size 映射到自己的字段名即可，
           页面不按平台 id 分支。 */
        size: f.size,
        /* creation_intent = 「这一次要的是什么形状的请求」（VGENV 的动作换人是 person_replacement）。
           它和 mode 一样是**请求形状**而不是开关，但它**是一个真的上游字段**（要进提交体），
           所以走 body 映射；mode 不是字段（平台按送上来的素材自己推断），它只当声明的上下文，
           写在 f.shape 里、不进提交体 —— 这一家「未知字段会被拒绝」，多塞一个 mode 就是 400。 */
        creation_intent: f.creation_intent };
      const shape = f.shape || {};
      /* `create.modelSendMap`（VGENV）：清单与界面用简形 id（base/cinematic/origin），
         但 create 端点只收「厂牌/型号」完整形 —— 提交这一刻按声明换形，其它一切（型号下拉、
         任务匹配、历史、估价请求）仍用简形。值不在表里就原样发（用户自己填的完整形、
         以及平台哪天把简形也收了的情形，都不需要改页面）。 */
      if (spec.modelSendMap && typeof std.model === 'string' && spec.modelSendMap[std.model]) {
        std.model = spec.modelSendMap[std.model];
      }
      /* `create.promptLimits`：提交前把 prompt 的长度问题拦在本地并说清原因。
         上游这一族校验会把多条失败原因拼成一句英文（"model must match … ,prompt must be a string
         of 5–30000 characters; person replacement accepts …"），用户既看不懂也不知道改哪里。
         形状按 creation_intent 分档：动作换人允许省略（空串本来就不进提交体）或 0–2000 字。
         上下限与措辞都走 `window.CharLimits` 那一份 —— 页面闸门与这里必须是同一句话（以前这里
         自己拼第四套，于是界面上没有的措辞会在提交那一刻冒出来）。 */
      if (spec.promptLimits) {
        const b = window.CharLimits.prompt(spec.promptLimits, std.creation_intent);
        const p = std.prompt == null ? '' : String(std.prompt);
        const who = (prov && (prov.displayName || prov.name)) || '该平台';
        const bad = (p || !b.omitted) ? window.CharLimits.why(p, b, { who, noun: '提示词' }) : '';
        if (bad) throw new Error(bad);
      }
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
        const shps = (spec.shapeFields || {});
        /* 判「这一项存不存在」的上下文只有一份：形状（mode + creation_intent）+ **这一次的那一行能力**。
           `caps` 由页面按 Capabilities.shapeState 现算递进来 —— 不递的话
           声明了 `need:'caps.xxx'` 的开关会被判成「不提供」，界面已经把开关画出来了、
           提交体却把它漏掉（两边各判一半，比都不判更难查）。 */
        const sctx = { mode: shape.mode, intent: std.creation_intent, caps: shape.caps || null };
        /* `mode` 是**界面上的「输入模式」名**，不是任何一个平台的请求字段（VGENV 明确说
           「未知字段会被拒绝」，而它的请求字段表里没有 mode —— 它按送上来的素材自己推断）。
           它只当声明的上下文用（见上面 f.shape），所以在这里从「原样发给上游」那一批里摘掉。
           哪一家真的收 mode 字段，就在 create.body / nest 里点名映射，不靠这一条兜底。
           空串同样不发：`shapeFields` 里「不超分」「不设种子」交给界面的就是空值，
           而这一家「未知字段会被拒」——发 `upscale:""` 比不发更糟（与上面 body 映射同一口径）。 */
        const keys = Object.keys(f.params).filter(k => k !== 'mode'
          && f.params[k] !== undefined && f.params[k] !== null && f.params[k] !== '');
        if (keys.length) {
          const rest = [], o = {};
          keys.forEach(k => {
            if (Object.prototype.hasOwnProperty.call(tops, k)) {
              /* 这一次请求的形状（页面从 Capabilities.combo 原样递到 f.shape）
                 可能让某个开关**根本不存在**：VGENV 的动作换人由平台自动分析素材，
                 显式发 {mode:'raw'} 会被拒（422 PERSON_REPLACEMENT_ANALYSIS_REQUIRED）。
                 所以隐藏的那一项一个字都不发，让它回到平台默认 —— 比发一个会被拒的值诚实。 */
              if (!window.Capabilities.fieldState(tops[k], sctx).hidden) body[k] = topBoolValue(tops[k], f.params[k]);
            } else if (Object.prototype.hasOwnProperty.call(shps, k)) {
              /* 顶层非布尔字段同样按声明过滤：`only.when` 不成立（动作起点发到普通生成 = 422）、
                 或 `from:'caps.xxx'` 那一行没给这个值，都一个字不发。
                 值本身不转换 —— 页面按 kind 交过来的就是数或字符串，这里再兜一份等于第二份口径。 */
              if (window.Capabilities.shapeFieldState(shps[k], sctx.caps, sctx).shown) body[k] = f.params[k];
            } else rest.push(k);
          });
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
          else if (t.many) groups.get(t.to).many = true;   // 同一个落点上多个模板：只要有一个是 many，落点就得是数组
          groups.get(t.to).items.push(fill(t.tmpl));
        });
        groups.forEach((g, to) => { if (g.items.length) body[to] = g.many ? g.items : g.items[0]; });
        /* 「文本项」：有些平台把提示词放在一个**多模态数组**里而不是平铺字段
           （MiniMax v2 的 content[] 第一项必须是 {type:'text', text:提示词}，
           v1 是平铺 prompt、v2 不是 —— 两种形状不能混）。
           声明 `create.textItem: { to:'content', key:'prompt', type:'text' }` 即启用；
           它排在最前面（上游要求 text 项在前），且提示词为空时整项省略。 */
        const ti = spec.textItem;
        if (ti && f.prompt != null && String(f.prompt).trim() !== '') {
          const arr = Array.isArray(body[ti.to]) ? body[ti.to] : (body[ti.to] ? [body[ti.to]] : []);
          const item = { type: ti.type || 'text' };
          item.text = String(f.prompt);
          body[ti.to] = [item].concat(arr);
        }
      }
      /* 页面显式指定 note 时才带（如导演台写镜头名），而且**只有声明了收这一项的平台才带**
         （registry 的 `create.acceptsNote`）：VGENV 那一族「未知字段会被拒绝」，
         不分声明就发等于给一个必然被拒的请求多塞一个字段 —— 报错还指着不相干的那一句。
         **不要**退回到 `spec.note` 的**值** —— 那是注册表里给界面看的说明文字（如「视频生成」），
         发给上游既没有意义，又把本项目的内部措辞漏给了平台。 */
      if (f.note && spec.acceptsNote) body.note = String(f.note).slice(0, 200);
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
      /* 模板那一族的提交体只认识模板里写过 `{{…}}` 的那些键，而 `create.topBools` 说的是
         「这一项在**顶层**」—— 声明了却没写进模板，界面照样按声明把开关画出来（导演台那一块与
         生成工作台那三排都读这一份声明），用户勾了、发出去却没有那一项，等于承诺了一件没做的事。
         所以调用方真的递了值就按声明摆到顶层；body/nest 那一族不经过这里（createBody 已经放对位置）。 */
      if (spec.template && body && typeof body === 'object' && !Array.isArray(body)) {
        Object.keys(spec.topBools || {}).forEach(k => {
          if (!(k in body) && fields && Object.prototype.hasOwnProperty.call(fields, k)) body[k] = !!fields[k];
        });
      }
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
    /* 把**已经存在本机资产库里的成品**补一份到设置里指定的那个文件夹。
       为什么需要它：`saveToDir` 只挂在**镜像流程内部**（runOne），而镜像那一步先被
       `offer()` 的「这份产物已经存过了就跳过」挡在前面 —— 功能加上之前下载的那批
       永远不会被补写。字节已经在 .assets 里，这里只是让代理**拷一份**（不重新下载、
       不重新回源、`.assets` 那份一律不动）。
       页面递的是**本机资产号**，不是路径 —— 代理按自己读到的配置决定写到哪。 */
    async saveLocal({ ids }) {
      return rawFetch('/save-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.isArray(ids) ? ids : [] }),
      });
    },
    /* 换下载位置时把**旧目录里那些副本**搬过去（会删掉源文件）。
       目标目录只由代理读配置决定，页面只能递「旧目录从哪来」——
       而且代理会核对这个目录是不是本工作台自己写出去过的，不是就不搬。 */
    async saveMove({ kind, from }) {
      return rawFetch('/save-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, from }),
      });
    },
    /* 数一遍「旧目录里还剩多少份本工作台的副本没搬」（GET /save-stale，只读）。
       为什么页面要单独问一次磁盘：换目录那句问话只挂在「刚改完的那一刻」，
       而 2026-10-15 那次改**默认位置**（项目内 文件\<类型> → 下载\拾帧\<类型>）一个字节都没动
       `sk_autosave` 里的 `dir`（两边都是空串）—— 按配置比字符串永远比不出变化，
       于是那批成品躺在项目目录里、界面上一个入口都没有。
       返回的是代理自己搬得动的那几处（两代默认 + 它写过的目录名单），路径不由页面递。
       老代理没有这一条 → 404：调用方当「数不清」处理，不弹红字、也不假装数到 0。 */
    async saveStale() {
      return rawFetch('/save-stale', { method: 'GET', cache: 'no-store' });
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
    /* 自动镜像的新通道：浏览器只递「从哪取」，字节由本地代理流式落盘。
       旧代理没有这一条 → 404，调用方回退到 base64 那条；大文件不会再在浏览器里
       经历 Blob → base64 → fetch body 的 5 倍内存放大。 */
    async saveLocalFromUrl({ url, name, mime, format, meta, media_type }) {
      return rawFetch('/local-assets/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name, mime, format, media_type, meta: meta || {} }),
        timeout: 0,
        retry: 0,
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
    /* 「这一家到底取不取得消」的唯一判据：注册表有没有声明 cancel 端点。
       界面按它决定画 active 还是 disabled 的取消按钮，调用点不要再自己比平台 id。 */
    canCancel(prov) {
      return !!(prov && prov.endpoints && prov.endpoints.cancel);
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
      query.set(spec.limitParam || 'limit', String(spec.limit || LIST_LIMIT_DEF));
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
        q2.set(spec.limitParam || 'limit', String(spec.limit || LIST_LIMIT_DEF));
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
        q1.set(spec.limitParam || 'limit', String(spec.limit || LIST_LIMIT_DEF));
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
              q.set(spec.limitParam || 'limit', String(spec.limit || LIST_LIMIT_DEF));
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
    /* 这一次是不是「余额 / 额度不够」（判据 BALANCE_RE，全站一份）。
       页面据此把「去用量与余额」那个入口也画出来 —— 只给一句「先到用量与余额页看看」
       而那页还得自己找，等于没说。 */
    isBalanceErr(e) { return BALANCE_RE.test(String(errText(e)|| '')); },
    /* 同一家刚报过余额不足：记一次。
       十分钟内再点合成，按钮上先把这句话说在前面 —— 让用户再发一次请求去换同一句拒
       虽然不扣费，但要白等一整轮，而这一条是刚刚才确认过的。合成成功就清掉。 */
    balOut: {
      KEY: 'sk_bal_out_',
      MIN: 10 * 60 * 1000,
      mark(provId) { try { localStorage.setItem('sk_bal_out_' + String(provId || ''), String(Date.now())); } catch (e) {} },
      clear(provId) { try { localStorage.removeItem('sk_bal_out_' + String(provId || '')); } catch (e) {} },
      recent(provId) {
        try {
          const t = Number(localStorage.getItem('sk_bal_out_' + String(provId || '')) || 0);
          return !!t && (Date.now() - t) < 10 * 60 * 1000;
        } catch (e) { return false; }
      },
    },
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
        /* 字节来源有两种给法：平台直接给产物外链（VGENV / MiniMax），或**只给产物号**
           （SparkCine 那一族，取字节靠代理的 /asset/<号> 换成最新签名地址）。
           以前只认前者 —— 于是「任务完成那一刻」这一族一条都排不上镜像，界面上就是
           「自动存本机开了也没用」，要等下一次列表加载由 normalize 造出 dl 才被 scan 补上
           （而用户多半早就切走了页）。列表那一路早就认四种来源（见 byteSrcOf），
           轮询这一路漏了资产号那一种。
           多产物时每个号各排一条：以前只镜像 outs[0]，一次出 3 张就只有第 1 张落本机。 */
        const up = g('outputUrl') || raw.__url || '';
        /* 每一条都要同时给出「产物号」和「取字节的地址」两样：镜像记录的键优先按**产物号**算
           （keyOf 的 `|a:` 那一档），而列表那一路（normalize → scan）递过去的一直是裸的产物号。
           这里要是把 `/asset/<号>` 整条地址当产物号递过去，算出来的键就是 `|a:/asset/<号>` ——
           同一个文件两份记录，列表加载时再下一遍（表现为「自动存本机存了双份」）。 */
        const srcs = up ? [{ id: firstOut, url: up }]
          : (Array.isArray(outs) ? outs.filter(Boolean).map(a => ({ id: a, url: assetSrc(a) })) : []);
        for (const s of srcs) AssetLocal.offer(prov && prov.id, {
          /* provider 要跟着递：runOne 落盘时把它写进本机资产条目（「这条是本机哪一家生成的」
             是资产库列表与筛选的读数）。这一族在任务完成那一刻就先排上镜像，不给 provider 的话
             本机那一条就是空平台名，而列表那一路（scan）递的条目本来带 provider —— 两边口径得一致。 */
          provider: (prov && prov.id) || '',
          assetId: s.id, genId: g('id'), url: s.url, model: g('model'),
          prompt: g('prompt') || (window.Api ? window.Api.promptFor(prov && prov.id, g('id')) : ''),
          duration: g('duration') ?? null, tier: g('tier'), res: g('res'), ar: g('ar'),
          count: g('count'), quality: g('quality'), format: g('format'),
          credits, priceMicros: pm, currency: g('currency') || '',
          gstatus: rawStatus, created: g('created'), completed: g('completed'),
        }, s.url);
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
    /* 一个余额数字的唯一写法：平台给了 unit（「积分」/「次」）就当量数报（千分位、单位跟在后面），
       没给 unit 就是 micros 折来的元（¥ + 两位小数）。读不出数的原样报出来，不折成 ¥0.00 骗人。 */
    balNum(v, unit) {
      const u = String(unit || '').trim();
      const n = Number(v);
      if (isNaN(n)) return String(v == null ? '' : v);
      return u ? n.toLocaleString('zh-CN') : '¥' + n.toFixed(2);
    },
    /* 一整个余额句子（数字 + 单位 + 可选冻结）。报告 §4：三处各写一套，
       「积分要不要千分位」「单位放前还是放后」三个页面三个答案 —— 口径只从这里出。 */
    balText(b, opts) {
      if (!b || b.available == null || b.available === '') return '';
      const u = String(b.unit || '').trim();
      let t = u ? this.balNum(b.available, u) + ' ' + u : this.balNum(b.available, '');
      if (!(opts && opts.frozen === false)) {
        const f = Number(b.frozen);
        if (b.frozen && !isNaN(f) && f > 0) t += ' · 冻结 ' + this.balNum(f, u) + (u ? ' ' + u : '');
      }
      return t;
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
        /* 本机资产库是**多家供应商共用的一条列表**（语音 / 生图 / 自定义各家都声明它）：
           relay 各家不同，读回的却是同一份索引 —— 按 relay+端点去重会把它算成三个来源，
           于是一屏产物被读三遍、请求发三遍、条目解析三遍（每遍都 emit 一次，界面就跟着多画几次，
           这是「一闪一闪」里被重复劳动放大的那一半）。这一族只按端点去重。 */
        const k = /^local:/.test(p.endpoints.list) ? p.endpoints.list : p.relay + '|' + p.endpoints.list;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ key: p.id, prov: p, spec: p.list });
      });
      return out;
    },
  };
})();
