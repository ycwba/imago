// 本地代理：node proxy.js 后访问 http://localhost:5175
// 所有生成平台都走 REGISTRY 声明的 relay 前缀转发（见下方 REGISTRY）：
// 页面只认 /registry 里的声明，不认具体厂商，所以接入新平台不用改页面。
const http = require('http');
const { request: httpsRequest, Agent: HttpsAgent } = require('https');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const os = require('os');
const dns = require('dns');
const zlib = require('zlib');
const tls = require('tls');
const net = require('net');   // 只用来验 .env 里那个 BIND_HOST 是不是一个真的 IP 字面量
/* 素材身份判据（浏览器那边 assetlib.js 用的是同一个文件的同一份，见 ident.cjs 顶部）。
   这里 require 而不是抄一份：落盘闸要判断「这份产物本机有没有存过」，
   而浏览器要算缓存键与跨页去重 —— 同一件事，两处各写一份就一定会漂。 */
const MediaId = require('../web/domain/ident.cjs');
/* 出站地址护栏（SSRF / DNS rebinding）已拆到 server/security.js；这里保持原有调用名。 */
const { isPrivateHost, safeOutboundUrl, baseKeyOf, guardOutboundUrl } = require('./security.js');
const { UP_TIMEOUT, outboundProxy, upRequest, failUpstream, anyRequest, destroyAgents, startProxyWatcher } = require('./outbound.js');
const { createIndexStore } = require('./index-store.js');
const { createHealth } = require('./health.js');
const { acquire: acquireInstanceLock } = require('./lock.js');
const { createSkillsStore } = require('./skills-store.js');
const { createPromptsStore } = require('./prompts-store.js');
const { createDataStore } = require('./data-store.js');
const { createCloudStore } = require('./cloud-store.js');
const { createAsrStore } = require('./asr-store.js');
const { createSearchStore } = require('./search-store.js');
const { createRenderJobsStore } = require('./render-jobs-store.js');
const { handleSkills } = require('./routes/skills.js');
const { createAsrRoutes } = require('./routes/asr.js');
const { createSearchRoutes } = require('./routes/search.js');
const { handleFcpxml } = require('./routes/fcpxml.js');
const { createCapabilities } = require('./routes/capabilities.js');
const { createSystemRoutes } = require('./routes/system.js');
const { createLocalAssets } = require('./routes/local-assets.js');
const { createRenderRoutes } = require('./routes/render.js');
const { createRelayRoutes } = require('./routes/relay.js');
const { createOutboundRoutes } = require('./routes/outbound.js');
const { createRegistryRoutes } = require('./routes/registry.js');
const { createPickDirRoute } = require('./routes/pick-dir.js');
const { createMediaRoutes } = require('./routes/media.js');
const { createSaveRoutes } = require('./routes/save.js');
const { createUsageRoutes } = require('./routes/usage.js');
const { validateProviders, validateAssetStore } = require('./providers/validate.js');
const { handleStatic } = require('./routes/static.js');
/* 四个域从组合根搬出去（审查报告 §6.1-1）：注册表、本机存储层、渲染任务、转发闸。
   这里只留组合根本该做的事：构造配置与依赖、接线、分发。 */
const { REGISTRY, createRegistryConfig, resolveAssetStore } = require('./registry-config.js');
const { createLocalAssetsStore } = require('./local-assets-store.js');
const { createRenderJobs } = require('./render-jobs.js');
const { createRelayGate } = require('./relay-gate.js');

/* 端口默认 5175。PORT 也能写在项目目录的 .env 里 —— 所以这一行必须排在 loadEnvFile(true)
   **后面**：以前它排在前面（在 require 之后立刻读），.env 里写的 PORT 根本不生效，
   只有真的在命令行 set 过才管用。Windows 的 Hyper-V / winnat 会在开机时把一段连续端口
   保留走（实测这台机器把 5174~6173 整段都占了），撞上报的是 `listen EACCES` 而不是
   常见的 EADDRINUSE —— 换端口是唯一不用管理员权限的出路，所以这条路必须真的走得通。
   另外 PORT 环境变量可以另起一个实例（配合 DATA_DIR 用一份独立的数据目录），
   自动化验证时就不必在真实用户数据上跑。 */

/* ---------- 密钥注入（优先级：页面设置里填的 > 系统环境变量 > 同目录 .env） ----------
   1) 页面「设置」里填写的密钥存在浏览器 localStorage，请求时带 Authorization 头传过来；
   2) 没带就用环境变量（set SPARKCINE_API_KEY=xxx / setx 永久 / 系统变量）；
   3) 也可以用同目录 .env 文件（KEY=VALUE，一行一个，# 为注释），无需配置系统环境变量。
   注意：源码里不再内置任何真实密钥 —— 内置密钥会随源码外泄（本文件进版本库，
   任何拿到源码的人都能直接花你的额度）。没配密钥时启动会打印提示，去「设置」页填即可。 */
const ENV_FILE = path.join(ROOT, '.env');
let envLoaded = false;
let envMtime = 0;
let envKeys = [];            // 上次由 .env 写入的键，用于清理「从 .env 里删掉」的变量
/* .env 每一行**原本写的值**（不管最后有没有真的生效）。
   优先级是「同名环境变量 > .env」，于是会出现这种完全看不出来的事：
   窗口里还残留一个 set PORT=5175，.env 明明写着 6200，报出来的却是 5175 绑不上 ——
   把文件里写的那个值留着，启动信息才答得出「这个端口到底从哪来、谁压掉了谁」。 */
let envFileVals = {};
/* 读取 .env 到 process.env（系统环境变量优先，不覆盖）；
   带 mtime 缓存，请求时调用 → 改完 .env 无需重启即可生效 */
function loadEnvFile(force) {
  try {
    /* 一次 statSync 顶掉以前的 existsSync + statSync：loadEnvFile 在每个请求开头都会调，
       两次 syscall 合成一次（实测 existsSync 47 µs + statSync 22 µs / 次）。文件不存在时
       statSync 直接抛 ENOENT，语义与以前「existsSync 为假」完全一致。 */
    let st; try { st = fs.statSync(ENV_FILE); } catch { envLoaded = false; return false; }
    if (!force && st.mtimeMs === envMtime) return envLoaded;
    envMtime = st.mtimeMs;
    const nowKeys = [];
    const fileVals = {};
    let n = 0;
    const skipped = [];        // 被同名环境变量压掉的键（只记名字，值不进日志）
    fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) return;
      const k = m[1];
      let v = m[2].trim();
      // 未加引号时，# 之后视为行内注释（引号里的 # 是值的一部分）
      if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
      v = v.replace(/^(["'])([\s\S]*)\1$/, '$2');   // 只剥成对的引号，不平衡的保留原样
      nowKeys.push(k);                              // 空值也记下：允许用 KEY= 主动清空
      fileVals[k] = v;
      // 系统环境变量优先；但 .env 内部改动时允许覆盖上次由 .env 写入的值
      if (!process.env[k] || process.env['__fromEnvFile_' + k]) {
        process.env[k] = v;
        process.env['__fromEnvFile_' + k] = '1';
        if (v) n++;
      } else skipped.push(k);                         // 被同名环境变量压掉了（不是文件写错了）
    });
    // 从 .env 里删掉的键：清掉上次写入的值，否则旧密钥一直生效
    envKeys.filter(k => !nowKeys.includes(k)).forEach(k => {
      if (process.env['__fromEnvFile_' + k]) { delete process.env[k]; delete process.env['__fromEnvFile_' + k]; }
    });
    envKeys = nowKeys;
    envFileVals = fileVals;
    envLoaded = true;
    // 启动阶段 LOG 可能还没初始化（TDZ），这里吞掉即可；热加载时会正常打印
    if (force && (n || skipped.length)) {
      try {
        log(`.env 已加载 / 更新（${n} 个变量）`);
        // 只报键名：值可能是密钥，一个字都不进日志。不报出来的话，「另有 N 个被压掉」这种数字
        // 反而像丢了东西（其实那几项本来就是环境变量在给，文件里写的是空）。
        if (skipped.length) log(`       另有 ${skipped.length} 项由同名环境变量提供，.env 里的写法没生效：${skipped.join('、')}`);
      } catch {}
    }
    return true;
  } catch (e) { console.error('[警告] .env 读取失败：' + e.message); return false; }
}
loadEnvFile(true);
const PORT_ENV = Number(process.env.PORT);
const PORT = PORT_ENV || 5175;
/* 端口来源要说得出口：绑不上时报的是哪一个号、这一个号是谁给的、.env 里那个有没有生效。
   （PORT 这一行排在 loadEnvFile(true) 后面才有意义 —— 排在前面的话 .env 永远读不到。） */
const PORT_BY_FILE = !!process.env['__fromEnvFile_PORT'];
const PORT_FROM = PORT_BY_FILE ? `.env 里的 PORT=${PORT}`
  : (PORT_ENV ? `环境变量 PORT=${process.env.PORT}（同名环境变量比 .env 优先）`
    : (process.env.PORT ? `环境变量 PORT="${process.env.PORT}" 不是数字，退回默认 5175`
      : (envFileVals.PORT ? `默认 5175（.env 里写的 PORT="${envFileVals.PORT}" 不是数字）` : '默认 5175（.env 里没写 PORT）')));
const PORT_CLASH = (!PORT_BY_FILE && Number(envFileVals.PORT) && Number(envFileVals.PORT) !== PORT)
  ? [`  顺带一句：.env 里写的是 PORT=${envFileVals.PORT}，但当前环境里已有一个 PORT=${process.env.PORT}，`,
     '       同名环境变量优先级更高，把它压掉了（所以这一份用的才是 ' + PORT + '）。',
     '       想按 .env 走就在同一个窗口先执行 set PORT= （清掉残留的那个），或直接走「启动.bat」。']
  : [];

/* 密钥统一从环境变量（含 .env 热加载）读，每次现取 → 改完 .env 立即生效，不受启动时快照影响 */
const keyOf = name => (name && process.env[name]) || '';
/* 静态文件的 Content-Type。音频与字幕要一并列上：少了音频类型，本地 mp3 / wav 经静态路由
   取回来是 404（表现是「配乐选了却下载失败」，而且报错在代理下载那一步，看着像素材坏了），
   少了 .srt 则下载到的字幕没有类型、浏览器当纯文本乱码。 */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.ass': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const LOG = path.join(ROOT, 'proxy.log');
/* 日志轮转：超过 2 MiB 只保留尾部 256 KiB。启动时先转一次，运行中每写 200 行再检查一次
   （只查 statSync 的开销可以忽略），避免长时间运行把磁盘写满。 */
const LOG_MAX = 2 * 1024 * 1024;
function rotateLog() {
  try {
    const st = fs.statSync(LOG);
    if (st.size <= LOG_MAX) return;
    const tail = Buffer.alloc(256 * 1024);
    const fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
    fs.closeSync(fd);
    fs.writeFileSync(LOG, tail);
  } catch {}
}
try { rotateLog(); } catch {}
// 各平台的内置密钥（保留这个钩子：接入需要出厂密钥的平台时在这里填，默认不填任何密钥）
const DEFAULTS = {};

/* ---------- API 注册路由 / 自定义接口 / 型号清单偏好 ----------
   这三族（REGISTRY 那份数据 + 两份本机覆盖）搬到 server/registry-config.js 了（审查报告 §6.1-1），
   字段含义与接入新平台那一段文档注释都在那里。REGISTRY 是纯数据，模块级直接 require；
   两份本机覆盖要读 .data 里的文件，所以依赖装配在下面的 dataStore 之后。 */


// 浏览器可能以任意来源访问本地代理，统一放行 CORS（含预检）
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  return false;
}

/* ---------- 输入与出站调用的统一护栏 ---------- */
const MAX_BODY = 64 * 1024 * 1024;       // 单请求体上限（语音 base64 音频可能较大，留足余量）
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return String(s == null ? '' : s); } };

/* 读请求体：超过上限直接 413，并停止接收（避免无上限 chunks.push 把内存打爆） */
function readBody(req, res, limit) {
  const max = limit || MAX_BODY;
  return new Promise(resolve => {
    const chunks = [];
    let size = 0, done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `请求体超过上限 ${Math.round(max / 1048576)} MiB` } }));
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    /* 只有一个分片时**直接返回它**，不做整份复制（P8）：`Buffer.concat([c])` 会把整个请求体
       再拷一遍，而 288 MiB 上限下这一段就是几百 MB 的峰值内存。
       （真正的大头是 base64 链路本身的 5× 放大 —— raw / utf8 串 / spec.data / 解码结果，
       那要改成流式解析 JSON 才动得了，风险与改动面都大得多，本轮只做这一步。） */
    req.on('end', () => { if (!done) { done = true; resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)); } });
    /* 请求体读一半就断（客户端取消、连接被掐）以前只 resolve(null)，而所有调用方都写
       `if (body == null) return;` —— 于是响应停在「头都没发、也永远不会发」，
       页面等到超时后报的是「超时」而不是「这次提交没送到」。这里补一个如实的 400。 */
    req.on('error', () => {
      if (done) return;
      done = true;
      try {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '读取请求体失败（连接中断），这次请求没有被执行' } }));
        }
      } catch (e) {}
      resolve(null);
    });
  });
}
/* 统一的出站请求：自动带超时（超时即 destroy 并回调 error），避免上游挂起时无人收场 */
/* ⚠ 连接复用（keep-alive，P4）**只给这两条通道**：
     · relay —— 转发平台接口（列表 / 详情 / 余额 / 建任务），
     · /capabilities —— 拉平台的能力声明。
   它们的**目标主机来自注册表声明**（prov.base / endpoints.models），不是浏览器递来的 URL，
   而 /getv /fetch /getfile /s3put 这四条取回 / 上传通道靠 `upRequest` 里默认带上的
   `lookup: guardedLookup`（见 server/outbound.js）做 **DNS rebinding 防护**：开了 keep-alive 之后，第二条请求可能复用
   第一条已经建好的 socket 而**跳过 lookup**，那道 SSRF 闸就会在复用路径上被绕过。
   所以这四条**保持每次新建**，绝不要「顺手统一」。shutdown() 里补了 agent.destroy()。 */
/* 「把 ?url= 解出来 → 过完整护栏 → 过不去就 400 并写明原因」只这一份。
   /getfile、/s3put、/fetch、/getv 四条通道以前各抄一遍（连 400 的响应头都写成了两样），
   而这类样板漂移的方向是坏的：少抄一道护栏就等于「任意本机网页可以借代理打内网」。
   返回 null 表示已经替调用方把 400 回掉了，调用方直接 return。 */
async function takeOutboundUrl(req, res, prefix, tag) {
  try { return await guardOutboundUrl(safeDecode(req.url.slice(prefix.length))); }
  catch (e) {
    log(`[${tag}] 拒绝出站：` + e.message);
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('bad url: ' + e.message);
    return null;
  }
}

/* 「上游那份响应原样流给浏览器」的响应头只算一次（/asset 与 /getv 各写了一遍同一件事）：
   状态码原样透传、失败响应绝不缓存、Range 与跨域那几个头。
   最要紧的是中间那一条 —— 签名过期回 403 时如果给它盖上 max-age 一天，
   浏览器就把这条 403 存一整天，页面表现为「这条视频的缩略图永远坏掉、怎么刷新都不恢复」，
   而换一个签名地址本来就能好。两处各写一份就意味着其中一处迟早漏掉这条守卫。
   o：{ status（上游状态码，小于 200 视为 502）、okType（成功时的 content-type，调用方算好）、
       cacheOk（成功时的 Cache-Control）、cors（要带 Access-Control-Allow-Origin）、disposition } */
function passthroughHeaders(upH, o) {
  const st = (o.status >= 200 ? o.status : 502);
  const bad = st >= 400;
  const h = {
    'content-type': bad ? (upH['content-type'] || 'text/plain; charset=utf-8') : (o.okType || 'application/octet-stream'),
    'cache-control': bad ? 'no-store' : o.cacheOk,
    'accept-ranges': upH['accept-ranges'] || 'bytes',
  };
  if (o.cors) h['Access-Control-Allow-Origin'] = '*';
  if (upH['content-range']) h['Content-Range'] = upH['content-range'];
  if (upH['content-length'] && !bad) h['Content-Length'] = upH['content-length'];
  if (o.disposition) h['content-disposition'] = o.disposition;
  return { st, bad, h };
}

/* 出站响应流 → 客户端：上游中途断开（RST / 空闲超时）时不能只让 pipe 抛错 ——
   以前几处 pipe 没有 error 监听：上游一断，代理这边刷未捕获异常，客户端拿到一个永远不结束的响应。
   统一入口：响应还没发头 → 502 + 可读原因；已经发过头 → 直接断开连接。 */
/* 把上游的字节转发给客户端。`total` 参数**刻意不再使用**：
   先前这一版想在流里回写 `X-Bytes-Sent` 头透出「上游那一段下到哪了」，但那是死代码 ——
   `pipe` 的第一次 flush 就把响应头发出去了，之后再 `setHeader` 在 Node 里是**静默空操作**，
   而浏览器侧 fetch 也要等头部到达才拿得到 `r.headers`，两边都永远读不到中途的值。
   下载进度由客户端自己算（`AssetTransfer.readBlobWithProgress` 数 chunk）：
   代理 → 上游、上游 → 代理、代理 → 浏览器三段是同一条 TCP 链，回环那一段攒不出整个缓冲，
   背压会让客户端看到的速率≈上游速率，不需要额外把头塞进流里。 */
function pipeUpstream(ur, res, tag) {
  ur.on('error', e => failUpstream(res, e.message, tag || '上游中断'));
  ur.pipe(res);
}

/* ---------- 素材上传（浏览器 → 本机代理 → 对象存储），带真实进度 ----------
   /s3put?url=<预签名地址> 的请求体就是素材本体。以前是「整块读进内存 → 一次性 PUT」：
   传 200 MB 视频就占 200 MB 堆内存，页面上还只有一句「正在上传…」。
   现在改成流式转发 + NDJSON 进度帧（每行一个 JSON），页面据此画真实进度：
     {"t":"start","total":N}                        开始（total 取自 Content-Length，可能为 0）
     {"t":"progress","sent":N,"total":N,"pct":P}    已发出多少（每 200ms 或每跨过 1% 发一帧）
     {"t":"done","status":S,"body":"…"}             上游最终状态与响应体（错误原因在这里，最多 2 KB）
     {"t":"error","message":"…"}                    转发失败
   为什么进度要由代理回：页面的 XHR/fetch 只能观测「浏览器 → 本机」这一段（回环，通常一两秒就完了），
   真正慢的是「本机 → 对象存储」那一段，只有代理看得见。 */
const S3PUT_MAX = 300 * 1024 * 1024;     // 硬上限（客户端另有 200 MiB 的业务上限）
function s3putStream(req, res, target) {
  const total = Number(req.headers['content-length'] || 0) || 0;
  const fwd = { ...req.headers };
  ['cookie', 'connection', 'origin', 'referer', 'host', 'accept-encoding'].forEach(h => delete fwd[h]);
  /* S3 预签名 PUT 一般要求 Content-Length（分块传输会被 411 拒），所以长度已知时显式带上；
     未知就交给 Node 用分块编码（部分对象存储也接受）。 */
  if (total) fwd['content-length'] = String(total);
  else delete fwd['content-length'];
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  let closed = false;
  const frame = o => { if (!closed) { try { res.write(JSON.stringify(o) + '\n'); } catch {} } };
  const finish = () => { if (!closed) { closed = true; try { res.end(); } catch {} } };
  frame({ t: 'start', total });
  const up = upRequest(target, { method: 'PUT', headers: fwd }, ur => {
    const bufs = [];
    let len = 0;
    ur.on('data', c => { len += c.length; if (len <= 8192) bufs.push(c); });   // 错误信息通常很小，只留前 8 KB
    ur.on('end', () => {
      frame({ t: 'done', status: ur.statusCode, body: Buffer.concat(bufs).toString('utf8').replace(/\s+/g, ' ').slice(0, 2000) });
      finish();
      log(`[s3put] ${ur.statusCode}${total ? ' ' + (total / 1048576).toFixed(1) + ' MB' : ''}`);
    });
    ur.on('error', e => { frame({ t: 'error', message: '读取上游响应失败：' + e.message }); finish(); });
  });
  /* 客户端提前断开（关页面 / 取消上传）：上游也要掐掉，否则那份素材会在后台继续传完，白占带宽 */
  res.on('close', () => {
    if (closed) return;
    closed = true;
    try { up.destroy(); } catch {}
    log('[s3put] 客户端断开，已中止上传');
  });
  up.on('error', e => { log('[s3put] 失败：' + e.message); frame({ t: 'error', message: e.message }); finish(); });
  req.on('error', e => { try { up.destroy(); } catch {} frame({ t: 'error', message: '读取请求体失败：' + e.message }); finish(); });
  let sent = 0, lastAt = 0, lastPct = -1;
  req.on('data', c => {
    sent += c.length;
    if (sent > S3PUT_MAX) {
      try { req.destroy(); up.destroy(); } catch {}
      frame({ t: 'error', message: '素材超过 ' + Math.round(S3PUT_MAX / 1048576) + ' MiB，已中止' });
      finish();
      return;
    }
    const now = Date.now();
    const pct = total ? Math.floor(sent * 100 / total) : -1;
    if (now - lastAt >= 200 || (pct >= 0 && pct > lastPct)) { lastAt = now; lastPct = pct; frame({ t: 'progress', sent, total, pct }); }
  });
  req.pipe(up);   // 背压由 pipe 传递：读到多少 ≈ 上游收下多少（最多领先一个 socket 缓冲）
}

let logLines = 0;
/* 连续同一句话只记「重复了几次」（P6）。实测 proxy.log 17,239 行里，
   openrouter.ai 7322 + hi.hi.run 1262 + api.vgenv.com 1225 = 9,809 / **57%** 是三类同形
   DNS 失败的重复（根因在客户端重试 ui.js 的 Net.fetch，代理侧只放大了一半）。
   这里只是**收拢**，不是把日志静音：**计数必须留着**，它是用户排障的主要依据。
   判据：与上一条逐字相同的连续重复，只在第 2 / 10 / 100 / 1000 / 10000 次各写一行带计数的；
   换一句话、或超过 30 秒没有新的重复，就立刻照常写。单次发生的话一句都不会被吞。 */
const logDedup = { msg: '', n: 0, at: 0 };
function writeLog(s) {
  console.log(s);
  try {
    fs.appendFileSync(LOG, s + '\n');
    if (++logLines % 200 === 0) rotateLog();   // 运行中轮转，不再只靠启动那一次
  } catch {}
}
function log(line) {
  // 本机时间而不是 UTC：启动器窗口把「[启动器]」与 proxy.js 两路输出并排画在同一块里，
  // 两个时钟差 8 小时（实测 23:32 与 15:32 同屏），看着就像日志是昨天的。
  const t = new Date();
  const p2 = n => (n < 10 ? '0' : '') + n;
  const out = `[${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}] ` + String(line);
  const now = Date.now();
  const key = String(line);
  if (key === logDedup.msg && now - logDedup.at < 30000) {
    logDedup.n++; logDedup.at = now;
    const n = logDedup.n;
    if (!(n === 2 || n === 10 || n === 100 || n === 1000 || n === 10000)) return;
    writeLog(out + '  （与上一行相同，前面已重复 ' + (n - 1) + ' 次）');
    return;
  }
  logDedup.msg = key; logDedup.n = 1; logDedup.at = now;
  writeLog(out);
}

/* 故障账已拆到 server/health.js；timeText 在后面定义，这里用闭包延迟取。 */
const health = createHealth({ timeText: d => timeText(d) });
const { noteFault, noteWork, healthStatus } = health;

const { spawn, spawnSync, execFile } = require('child_process');
const RENDER_DIR = path.resolve(ROOT, process.env.RENDER_DIR || '.renders');   // 同 ASSETS_DIR：绝对路径要能直接用
/* 会话令牌：代理启动时生成一次，随首个页面响应种进 HttpOnly Cookie。
   LOCAL_ONLY 路由除同源检查外还要求这枚 Cookie —— 同源检查认「没有 Origin 的非浏览器调用」，
   于是任意本机进程（curl / 别的脚本）都能直接读 /data、/env-status。Cookie 只有真正加载过
   本工作台页面的浏览器才有，同源之外的页面也拿不到（SameSite=Strict + 跨站已在同源检查里拒）。 */
const SESSION_COOKIE = 'wb_session';
const SESSION_TOKEN = require('crypto').randomBytes(24).toString('hex');
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const hasSession = req => cookieValue(req, SESSION_COOKIE) === SESSION_TOKEN;
function ensureSession(req, res) {
  if (hasSession(req)) return;
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + SESSION_TOKEN + '; Path=/; HttpOnly; SameSite=Strict');
}

/* ---------- 本地生成资产库 ----------
   有些平台的产物是「同步返回」的二进制（例如语音合成直接给 base64 音频），上游没有资产 id。
   这里把这类产物落到本地目录，并对外提供与上游一致的形状：
     POST /local-assets      { name, mime, format, data(base64), meta:{prompt,model,voice,duration,provider,credits,priceText} }
                             → { id, url:'/asset/<id>', ... }
     GET  /local-assets      列表（资产库/任务列表直接用 registry 的 list 声明读它）
     GET  /asset/<id>        本地优先：命中本地文件就本地读取（支持 Range），否则回源上游
   这样「语音工作台」生成的音频能像其它资产一样出现在资产库、被资产选择器挑选与复用。 */
/* 落盘目录：默认 .assets（用户资产库）；ASSETS_DIR 指到别处 —— 隔离验证实例必须指出去，
   否则 headless 探针生成的素材会直接写进用户那份，资产库里冒出一堆假条目。
   用 path.resolve 而不是 path.join：join 把「绝对路径」当相对片段拼上去
   （path.join('/a/b', 'C:\\x') → '/a/b/C:\\x'），于是照着上面那句注释传一个绝对路径，
   目录会静默落到一个不存在的拼接路径上 —— 现象是「隔离实例照样 422 / 找不到文件」，
   很容易被误判成探针写错了。DATA_DIR / PROMPTS_DIR 本来就是 resolve，只有这两个是 join。 */
const LOCAL_DIR = path.resolve(ROOT, process.env.ASSETS_DIR || '.assets');
/* ---------- 本机落盘：磁盘余量口径、按类型另存、本机资产库 ----------
   搬到 server/local-assets-store.js（审查报告 §6.1-1）：那一大段「写媒体之前先问一句这块盘还剩多少」
   的口径、/save* 的目录索引、/local-assets 的索引与读文件都在那里，实例化在下面的依赖装配处。 */


/* 渲染这一族的几个数以前**写死在源码里**（同时跑几条、队列最多排几条、任务记录留多久），
   而本机 ffmpeg 快慢差异很大、想调只能改代码 —— 改代码又要重启，等于没人调。
   现在按 PORT 那套优先级读：同名环境变量 > .env > 这里的默认值（同样是启动时定一次，改了要重启）。
   ⚠ **非法值退回默认、并把原因留在启动日志里**，不抛错也不静默：
   「填了没生效」最容易被当成代理坏了（PORT 那一档当年就是这个口径，见上面 `PORT_FROM`）。
   生效值与来源也要一起打出来 —— 并发有没有真的按 2 跑，盯着界面上那条进度条是猜不出来的。 */
const envWarns = [];
function envInt(name, def, min, max) {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
  if (!raw) return def;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    envWarns.push(`${name}="${raw}" 不是 ${min}–${max} 之间的整数，已退回默认 ${def}`);
    return def;
  }
  return Number(raw);
}
const envFrom = name => process.env['__fromEnvFile_' + name] ? '.env' : (/^\d+$/.test(String(process.env[name] || '').trim()) ? '环境变量' : '默认');
const RENDER_KEEP = envInt('RENDER_KEEP_MIN', 30, 1, 1440) * 60 * 1000;   // 任务记录保留（进度查询用）与崩溃残留临时目录的回收，同一个分钟数
const RENDER_CONCURRENCY = envInt('RENDER_CONCURRENCY', 1, 1, 4);         // 同时跑的渲染任务数：ffmpeg 很吃 CPU，串行最稳
const RENDER_QUEUE_MAX = envInt('RENDER_QUEUE_MAX', 20, 1, 200);          // 在跑 + 排队的上限，超了当场 429
const RENDER_CLIPS_MAX = 500;   // 一单最多几段：写死，拼出来的 filter_complex 太长 ffmpeg 自己会拒
/* FCPXML 媒体包的体量闸：zip 写入器不支持 ZIP64（条目长度与偏移都是 32 位），
   而打包把所有素材一次性读进内存再 concat —— 不限量时「500 条 4K 片段」这一单先撑爆代理进程。
   单条与整包各一道，超出的素材进 missing.txt 并写明是哪一条（routes/fcpxml.js 消费这两个数）。
   整包上限刻意只到 3 GiB：留出 zip 结构本身的余量，配到 4 GiB 以上必然撞 ZIP64。 */
const FCPXML_MAX_ASSET_MB = envInt('FCPXML_MAX_ASSET_MB', 512, 1, 2048);
const FCPXML_MAX_BUNDLE_MB = envInt('FCPXML_MAX_BUNDLE_MB', 2048, 16, 3072);
/* 编码那一族以前整条写死在源码里（libx264 + veryfast + `-crf`），而本机差别很大：
   有 N 卡的人想走 NVENC（快几倍）、只想留档的人想要 H.265（同画质体积约一半）、嫌画质差的人想要 medium ——
   三个都只能改代码，改代码又要重启，等于没人调。现在按 RENDER_* 那一族同一套优先级读 `.env`
   （启动定一次，改完要重启），但**只认这张表点名的组合**：
   · 表里没有的编码器一律不接（不「猜它也能跑」）；
   · 每个编码器带**自己的** preset 词汇表 —— libx264/x265 认 veryfast，NVENC 认 fast/medium/slow/veryslow，
     同一档位喂给另一家 ffmpeg 当场拒（`-preset veryfast` 喂 h264_nvenc 就是这么炸的），所以档位清单不许共用一份；
   · 质量数还是界面那个 crf（路由里 14–32 夹紧那一份，不改它），落到不同编码器换一个写法：
     x264/x265 用 `-crf`，NVENC 用 `-rc constqp -cq`，QSV 用 `-global_quality`（这三家都收 14–32 这个数）。
   ⚠ 两种「填了但没用」必须分开说、都不能静默：
   ① 名字或档位不在表里 → 启动日志当场点名并退回默认（`envWarns` 那一族，与 RENDER_CONCURRENCY 同口径）；
   ② 名字在表里、但这台机器的 ffmpeg 构建**没编进去**（很常见：官方 Windows 版不带 QSV，没 N 卡就没有 NVENC）→
     第一次渲染前问一次 `ffmpeg -encoders`（结果缓存在进程里，只问一趟），退回 libx264，
     并把「配的是谁、为什么换」写进这一单的任务日志。成片照样出得来，但用户以为自己在用硬件编码 —— 那句必须看得见。 */
const ENCODE_PROFILES = {
  libx264: { zh: 'H.264（CPU，到哪都能放）', dPreset: 'veryfast',
    presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    quality: v => ['-crf', String(v)] },
  libx265: { zh: 'H.265（CPU，同画质体积约一半、编码慢）', dPreset: 'medium',
    presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    quality: v => ['-crf', String(v)] },
  h264_nvenc: { zh: 'H.264（N 卡 NVENC，快）', dPreset: 'medium',
    presets: ['fast', 'medium', 'slow', 'veryslow', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    quality: v => ['-rc', 'constqp', '-cq', String(v)] },
  hevc_nvenc: { zh: 'H.265（N 卡 NVENC，快且体积小）', dPreset: 'medium',
    presets: ['fast', 'medium', 'slow', 'veryslow', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    quality: v => ['-rc', 'constqp', '-cq', String(v)] },
  h264_qsv: { zh: 'H.264（Intel 核显 Quick Sync）', dPreset: 'medium',
    presets: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    quality: v => ['-global_quality', String(v)] },
  hevc_qsv: { zh: 'H.265（Intel 核显 Quick Sync）', dPreset: 'medium',
    presets: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    quality: v => ['-global_quality', String(v)] },
};
const VCODEC_DEFAULT = 'libx264';
/* 与 envInt 同一立场：空 = 用默认（不吭声）；填了但不认 = 退回默认并把原因留在启动日志里。
   大小写与空格由这里统一抹掉，用户写 `LibX264` 或 ` libx264 ` 不该被当成「没配」。 */
function envOneOf(name, def, allow) {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim().toLowerCase();
  if (!raw) return def;
  if (allow.indexOf(raw) < 0) {
    envWarns.push(`${name}="${raw}" 不在本工作台认的名单里（可选：${allow.join(' / ')}），已退回默认 ${def}`);
    return def;
  }
  return raw;
}
const RENDER_VCODEC = envOneOf('RENDER_VCODEC', VCODEC_DEFAULT, Object.keys(ENCODE_PROFILES));
/* 档位要按**那一家**的名单验，不能拿默认家那份清单去量：配了 h264_nvenc 却填 veryfast
   （libx264 认、NVENC 不认）喂出去是「ffmpeg 当场拒」，而界面只会显示一句合成失败。
   所以这里不用 envOneOf（它只能拿一份固定名单比），自己现取这一家的名单。 */
function resolvePreset() {
  const prof = ENCODE_PROFILES[RENDER_VCODEC];
  const raw = String(process.env.RENDER_PRESET === undefined ? '' : process.env.RENDER_PRESET).trim().toLowerCase();
  if (!raw) return prof.dPreset;
  if (prof.presets.indexOf(raw) >= 0) return raw;
  envWarns.push(`RENDER_PRESET="${raw}" 不是 ${RENDER_VCODEC} 认的档位（这一家只认 ${prof.presets.join(' / ')}），已退回 ${prof.dPreset}`);
  return prof.dPreset;
}
const RENDER_PRESET = resolvePreset();
const envFromStr = name => {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
  if (!raw) return '默认';
  return process.env['__fromEnvFile_' + name] ? '.env' : '环境变量';
};

/* 监听地址：默认**只绑回环**（那份「后端可完善清单」里与安全有关的两条之一，难度低、影响面全网）。
   以前是 `server.listen(PORT)` —— 不写 host 时 Node 绑 `::`，等于这台机器**每一块网卡**都在听；
   而 `sameOriginOnly` 为了「用手机在房间里打开工作台」把本机各网卡的 IP 一律算「自己人」
   （它只认回环名与 `os.networkInterfaces()` 里那些地址，不认任何域名）。
   两条叠在一起的实际后果不是「多一个人能看页面」：同一 WiFi 下任意设备直接打
   `http://192.168.x.x:5175/data`、`/save`、`/<relay>/*` 都算同源 —— 读业务数据、
   用服务端 `.env` 里那把密钥建任务扣费，连「骗过浏览器」这一步都不需要。
   现在默认绑两只回环 socket：`127.0.0.1` 与 `::1` 各一只。**为什么两只都要** ——
   Windows 上 `localhost` 常先解析到 `::1`，只绑 v4 那一侧时第一次连接吃一次 ECONNREFUSED
   （浏览器与 .NET 会退到 v4 重试，但那正是「启动器等监听」那一档里看不懂的半秒）。
   `.env` 里写 `BIND_HOST=all` 恢复旧的「所有网卡 + 双栈」，或写具体网卡 IP 只放行那几块
   （回环那两只永远在听，见下面 resolveBind 里那一段）—— 两种都是主动放行，
   启动日志会把它写成「局域网可达」而不是悄悄绑上。
   与 PORT / 渲染 / 编码那三族同一档：启动时定一次，**改完要重启**。 */
const BIND_ALIAS = { loopback: ['127.0.0.1', '::1'], all: ['::'] };
const isLoopbackAddr = h => h === '::1' || h === 'localhost' || /^127\./.test(h);
const isAnyAddr = h => h === '::' || h === '0.0.0.0';
const bindAddrText = h => (isAnyAddr(h) ? h + '（所有网卡）' : h);
function resolveBind() {
  const raw = String(process.env.BIND_HOST === undefined ? '' : process.env.BIND_HOST).trim().toLowerCase();
  const hosts = [];
  const add = h => { if (h && hosts.indexOf(h) < 0) hosts.push(h); };
  /* 逗号分开能列好几块（`BIND_HOST=127.0.0.1,::1` 与 `all` 等价但只收指定的那两张），
     所以这里按一段一段解析，而不是「整串只能是一个名字」。 */
  const toks = raw ? raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [];
  toks.forEach(t => {
    /* 按名字数**必须问那份表真的是数组**：`BIND_HOST=constructor` 会撞上原型键、读回来是个函数，
       下一句 `.forEach` 当场 TypeError —— 与 selfcheck 的 `namedSites` 同一类「尺子自己坏」。 */
    if (Array.isArray(BIND_ALIAS[t])) { BIND_ALIAS[t].forEach(add); return; }
    const h = t.replace(/^\[|\]$/g, '');     // IPv6 字面量常带方括号写（[::1]）
    if (net.isIP(h)) { add(h); return; }
    envWarns.push(`BIND_HOST 里的「${t}」既不是 loopback / all，也不是一个 IP 字面量，这一段已忽略`);
  });
  let why = 'BIND_HOST=' + raw;
  if (!hosts.length) {
    BIND_ALIAS.loopback.forEach(add);
    why = toks.length ? '默认 只绑回环（BIND_HOST 填的都不认）' : '默认 只绑回环';
  }
  /* 通配那一只把本机所有地址（连回环一起）全收了，再列具体 IP 会让第二只监听撞 EADDRINUSE，
     所以先归并成一只并当场说明那几段是多余的 —— 而不是让警告变成「代理起不来」。 */
  if (hosts.some(isAnyAddr)) {
    const extra = hosts.filter(h => !isAnyAddr(h));
    hosts.length = 0;
    add('::');
    if (extra.length) envWarns.push(`BIND_HOST 里列了「所有网卡」，${extra.join(' / ')} 它本来就包含，`
      + '一起填还会让第二只监听撞 EADDRINUSE（已归并成 :: 一只）');
  } else {
    /* 回环那两只**永远在清单里**（通配那一档本来就包含它们）：启动器的 `/whoami` 探活
       与页面默认开的 http://localhost 都走回环，少听这一只就变成「页面打不开、
       启动器以为代理没起来」。回环不属于「局域网暴露」，带上它不放松任何东西 ——
       所以「只列了一块网卡 IP」的那一档也补上，并在日志里写明补过。 */
    if (!hosts.some(isLoopbackAddr)) why += ' + 回环';
    BIND_ALIAS.loopback.forEach(add);
  }
  return { hosts, why };
}
const BIND = resolveBind();
const BIND_LAN = BIND.hosts.some(h => !isLoopbackAddr(h));

/* ---------- ffmpeg 离线渲染：任务表 / 队列 / 素材解析 / 子进程 ----------
   搬到 server/render-jobs.js（审查报告 §6.1-1）；上面那一族 RENDER_* 与 ENCODE_PROFILES 是配置，
   留在这里由组合根注入。实例化在下面的依赖装配处。 */

/* 在请求分发里调用：处理 /render* 相关请求，返回 true 表示已处理 */


/* 列表接口短缓存（模块级：跨请求复用） */
const listCache = new Map();   // url → { ts, status, headers, body }
const detailCache = new Map(); // 单条任务详情（已完成的）短缓存：url → { ts, status, headers, body }
const DETAIL_TTL = 5 * 60 * 1000;
/* 两份缓存的「装多少」上限住在用它们的那一层（server/routes/relay.js）：
   拆路由时这里留了三行没人用的定义，而 relay 里那三处引用既没搬走也没注入 ctx，
   于是每次列表回源都在 `ur.on('end')` 里抛 ReferenceError（不在 Promise 链上，catch 接不住）。
   缓存表本体仍然在这里 —— 它是跨请求复用的模块级状态。 */
/* 在途请求合并表（single-flight，P3）。四份缓存以前都只在「已完成时命中」，miss 就直接回源：
   多个页面同时打开、各自拉同一平台的列表端点时，N 个**完全相同**的请求全部 miss、全部打上游，
   而 SparkCine 的列表端点要 6~14 s。这里配一张「在途表」：同一 key 的第二个请求不再发出去，
   而是挂到第一个的回调上，一起拿同一份响应；settle 后**立即 delete** —— 它只活在这一次在途里，
   绝不做成第二份持久缓存（持久那份是 listCache / detailCache）。 */
const listInflight = new Map();     // cacheKey → [res, …]（正在回源的同一份列表）
const detailInflight = new Map();   // cacheKey → [res, …]（正在回源的同一份详情）

/* ============================================================================
   本地数据落盘（/data）
   浏览器存储（localStorage / IndexedDB）是「私有且随时可能被清掉」的：清一次浏览器数据、
   换个浏览器、开无痕，工作区和设置就没了。这里把业务数据同时写一份到项目目录的
   .data/ 下（普通 JSON 文件），于是它变成看得见、能备份、能被云盘同步的普通文件。
     GET    /data          清单 [{ key, size, mtime }]（客户端据此判断谁更新）
     GET    /data/<key>    该键的内容
     PUT    /data/<key>    原子写入（先写 .tmp 再 rename，写一半断电也不会留下半个文件）
     DELETE /data/<key>    删除
   键名只允许 [A-Za-z0-9_-]，杜绝路径穿越。内容原样保存（客户端写入的信封结构）。
   ========================================================================== */
/* /data 的落盘、备份与路由在 server/data-store.js；云同步那一侧读同一份导出。 */
const dataStore = createDataStore({ root: ROOT, log, readBody, safeDecode });
const { DATA_KEY_RE, dataDirPath, dataFileOf, dataList, keepDataBackup, dataWriteRaw } = dataStore;
/* 注册表的两份本机覆盖读的就是 .data 里的文件，所以在 dataStore 之后装配。 */
const registryConfig = createRegistryConfig({ dataFileOf, safeOutboundUrl });
const {
  CUSTOM_RELAY, customNotice, MODEL_PREFS_KEY, modelPrefsNotice, allProviders,
} = registryConfig;
/* 本机存储层：目录与 log / MIME / dataDirPath / spawnSync 都在这一行交给它（§6.1-1）。 */
const localStore = createLocalAssetsStore({
  ROOT, LOCAL_DIR, RENDER_DIR, MIME, dataDirPath, log, spawnSync,
});
const {
  MEDIA_KIND_ZH, typeLabel, sha1Of, SAVE_KINDS, saveKindOf, saveBaseName, saveUniqueName, insideLocalDir,
  saveDirIndex, autosaveDir, autosaveDefaultDirs, autosaveUsedAdd, autosaveUsedHas, saveStaleScan,
  whyNoSpace, whyRenderSpace, sweepStaleTmp, LOCAL_INDEX_MAX, indexStore, localIndexRead, localIndexEntry,
  localIndexUpsert, localIndexRemove, localIndexUpdate, localIndexPut, localAssetEntry, localAssetRepair, localMediaType,
  productKindOfName, localAssetWhen, localUpKey, localFillMissing, localFileFromEntry, localAssetFile,
  localUsageScan, sendFileWithRange, serveLocalFile,
} = localStore;
const renderJobs = createRenderJobsStore({ dataFileOf, dataWriteRaw, log });
/* 资产下载地址从哪一家换：注册表顶层的 assetStore 声明（registry-config.js）。
   `/asset/<id>`、渲染素材解析、本机补存三处都只问这一份 —— 以前它们各自写死
   `https://hi.hi.run` + `SPARKCINE_API_KEY`，换一家平台就要在四个文件里各改一遍。
   没声明 / 点名的那家不存在 → null：调用方照实回「这家没有资产接口」，不猜一家兜底。 */
const assetStore = resolveAssetStore(REGISTRY);
/* 渲染那一域的任务表 / 队列 / 素材解析 / 子进程：配置与依赖在这一行交给它（§6.1-1）。 */
const renderDomain = createRenderJobs({
  ROOT, PORT, RENDER_DIR, assetStore, SESSION_COOKIE, SESSION_TOKEN, log, keyOf, safeDecode, envInt,
  spawn, ENCODE_PROFILES, VCODEC_DEFAULT, RENDER_VCODEC, RENDER_PRESET, RENDER_KEEP, RENDER_CONCURRENCY,
  /* RENDER_QUEUE_MAX 必须一起交给它：`renderStatus()` 那句「队列上限」与「来源」要说这两个数，
     而函数已经从组合根搬进 render-jobs.js —— 少给一个就是 `/sys-status` 当场 ReferenceError，
     设置页健康那一格与所有 e2e 的「等代理就绪」一起死（搬域时漏注入，静态判据看不见，
     只有真起一次进程才露出来）。 */
  RENDER_QUEUE_MAX,
  envFrom, envFromStr, guardOutboundUrl, upRequest, anyRequest, renderJobs,
  localAssetFile: localStore.localAssetFile, whyRenderSpace: localStore.whyRenderSpace,
});
const {
  renders, renderQueue, running, enqueueRender, pruneRenders, killJobProcs, allProcs, runFfmpeg, probe,
  mediaState, cacheSweep, assetUrlCache, assetInfoOf, resolveSrc, downloadTo, VOICE_MAX, renderStatus,
} = renderDomain;
const skillsStore = createSkillsStore({ root: ROOT, dataDir: dataDirPath(), userDir: process.env.SKILLS_DIR || '', log });
/* ASR 与联网搜索：设置/任务账本各自一个 store；密钥只留在盘上，读接口只回 hasKey。
   `/search/read` 是唯一主动出站取网页的读路由，仍然逐跳过 guardOutboundUrl。 */
const asrStore = createAsrStore({ dataDir: dataDirPath(), log });
const searchStore = createSearchStore({ dataDir: dataDirPath(), log });
const asrRoutes = createAsrRoutes({
  store: asrStore, root: ROOT, log, readBody,
  providers: () => REGISTRY.providers, keyOf, dataFileOf,
  resolveSrc, localAssetFile, downloadTo, guardOutboundUrl, anyRequest,
});
const searchRoutes = createSearchRoutes({
  store: searchStore, log, readBody,
  providers: () => REGISTRY.providers, keyOf, dataFileOf,
  guardOutboundUrl, upRequest, anyRequest,
});
/* ---------- 本机依赖体检（GET /sys-status，只同源） ----------
   导演台导出成片要 ffmpeg。没装 / 装了不在 PATH / 装的是 Windows 商店那个占位壳，
   三种在界面上都只剩「无法启动 ffmpeg」一句 —— 现在导出前就能看见是哪一种。
   探测要起子进程，**不能拿 spawnSync 卡事件循环**（两次探测最长 12 秒，期间轮询、
   /asset 取图、/getv 播放全部停摆）：改异步 execFile，结果按命令缓存在进程内；
   ?fresh=1 强制重探（刚改完 PATH 的人不该被迫重启代理才能看到变化），
   同一条命令已经在跑时无论 fresh 与否都复用那一次。 */
let _sysStatus = null;
function firstLine(s) { return String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || ''; }
const cap120 = s => (s.length > 120 ? s.slice(0, 120) + '…' : s);
const toolProbes = new Map();
function probeTool(cmd, fresh) {
  const hit = toolProbes.get(cmd);
  if (hit && (!fresh || !hit.done)) return hit.p;
  const rec = { done: false, p: null };
  rec.p = new Promise(resolve => {
    execFile(cmd, ['-version'], { windowsHide: true, cwd: ROOT, timeout: 6000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      rec.done = true;
      if (!err) {
        const line = firstLine(stdout) || firstLine(stderr);
        /* -version 的横幅走 stdout；少数构建（以及那个占位壳）走 stderr，两个都试才拿得到版本行 */
        if (!/^ffmpeg|^ffprobe/i.test(line)) { resolve({ ok: false, why: '它没报出 ffmpeg 的版本行，八成不是同一个东西：' + cap120(line) }); return; }
        resolve({ ok: true, 版本: line.slice(0, 90) });
        return;
      }
      if (err.code === 'ENOENT') { resolve({ ok: false, why: '没装，或者不在 PATH 里' }); return; }
      if (err.killed || err.signal) { resolve({ ok: false, why: '6 秒没回话被停掉（装了，但一跑就卡住）' }); return; }
      /* Windows 的「应用执行别名」会放一个占位 ffmpeg.exe：它确实能启动，只是退出来并留一句
         「还没安装」。这一句比「退出码 9009」有用得多，所以把工具自己说的话带回去。 */
      if (typeof err.code === 'number') {
        const say = firstLine(stderr) || firstLine(stdout);
        resolve({ ok: false, why: '退出码 ' + err.code + '：' + (say ? cap120(say) : '装了，但它跑不起来（PATH 里可能指向的不是真二进制）') });
        return;
      }
      resolve({ ok: false, why: '起不动：' + (err.message || err.code || err) });
    });
  });
  toolProbes.set(cmd, rec);
  return rec.p;
}
function dirState(dir) {
  let st = null;
  try { st = fs.statSync(dir); } catch (e) { return { 路径: dir, 状态: '还没建（第一次用到时代理自己会建）' }; }
  if (!st.isDirectory()) return { 路径: dir, 状态: '路径上有个同名的文件，不是目录 —— 要移走它' };
  try { fs.accessSync(dir, fs.constants.W_OK); } catch (e) { return { 路径: dir, 状态: '存在但写不进去（只读、权限，或被别的进程占着）' }; }
  return { 路径: dir, 状态: '可写' };
}
/* 「本机现在到底会怎么出片」那一份说法（renderStatus）跟着渲染域搬进 server/render-jobs.js：
   它读的就是那层的 encodersKnown 与上面那几个配置数。 */
function sysStatus(fresh) {
  /* 出站代理那一段每次现算（它 30 秒一份缓存、跟着代理软件开关变），不跟着整份体检结果一起缓存 */
  const px = outboundProxy();
  const proxyField = {
    状态: px.cfg ? ('走 ' + px.cfg.label) : '直连',
    来源: px.src || '没检测到（环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 与 Windows 系统代理都没有）',
    绕过: '回环 / 内网 / 链路本地地址与 NO_PROXY 里列的一律直连；.env 里写 PROXY_OFF=1 可整体关掉',
  };
  /* 「本机现在到底会怎么出片」每次现拼（都是同步读几个常量），因为它缓存期间 `本机` 那一格会变 ——
     第一次导出问过 `ffmpeg -encoders` 之后，体检才说得出「这台有没有配的那个编码器」。 */
  const renderField = renderStatus();
  /* 健康那一份也每次现算：它说的就是「现在这一刻」—— 存活多久、最后一次干活是什么时候、
     异常有没有新长出来。跟着整份体检缓存走的话，缓存期间出的异常会在界面上「晚 5 秒～下一次重探」才露出来，
     而这一格存在的意义正是「刚坏的那一下也要看得见」。 */
  const healthField = healthStatus();
  /* 转发闸那一份也每次现算：它报的就是「这一家有几条正在打、排了几条」，
     跟着整份体检缓存走的话，刚被限流那一下界面上看不见（与「健康」同一立场）。 */
  const relayField = relayStatus();
  const live = { 出站代理: proxyField, 渲染: renderField, 健康: healthField, 转发: relayField };
  if (_sysStatus && !fresh) { Object.assign(_sysStatus, live); return Promise.resolve(_sysStatus); }
  /* 两条探测并行跑，一条最多 6 秒；已经探过的直接命中进程内缓存（fresh 也一样复用还在跑的那一次） */
  return Promise.all([probeTool('ffmpeg', !!fresh), probeTool('ffprobe', !!fresh)]).then(([ffmpeg, ffprobe]) => {
    _sysStatus = {
      ...live,
      at: Date.now(),
      代理: { 版本: REGISTRY.version, 端口: PORT, 目录: ROOT, 进程: process.version },
      ffmpeg,
      ffprobe,
      目录: { 数据: dirState(dataDirPath()), 资产: dirState(path.resolve(LOCAL_DIR)), 渲染: dirState(path.resolve(RENDER_DIR)) },
    };
    return _sysStatus;
  });
}
/* ---------- 同源保护 ----------
   /data 里存着设置（含 API 密钥）与工作区，/env-status 暴露密钥尾号，
   /local-assets 是本机生成的素材清单，/cloud 会带着账号密码出网，/render 吃 CPU 又落盘。
   代理的 CORS 是全站放开的（Access-Control-Allow-Origin: *），不加这一层的话
   任何网页都能跨域把这些读走 —— 和之前 .env 能直接下载是同一类问题。
   判定规则（比"固定 localhost"更准，也不牺牲局域网访问）：
     · 没有 Origin 头（curl、<img>/<video> 这类不带 Origin 的请求）→ 视为本机调用，放行；
     · 有 Origin → 只认「本机回环名（localhost / 127.x / ::1）」与本机各网卡的 IP，
       且端口必须与本次请求的 Host 一致。
   这样用 http://192.168.x.x:5175 打开工作台照样能用（Origin 是本机网卡 IP）；
   而跨站页面（evil.com）与 DNS rebinding（页面来源是域名）都会被拒 —— 这里不认任何域名。 */
let localIps = new Set(), localIpsTs = 0;
function refreshLocalIps() {
  const out = new Set();
  try {
    Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(ni => {
      if (ni && ni.address && !ni.internal) out.add(ni.address.toLowerCase());
    }));
  } catch {}
  localIps = out; localIpsTs = Date.now();
}
function hostPortOf(h) {
  const s = String(h || '');
  const m = /^\[(.+)\](?::(\d+))?$/.exec(s);
  if (m) return { host: m[1].toLowerCase(), port: m[2] || '80' };
  const i = s.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i).toLowerCase(), port: s.slice(i + 1) };
  return { host: s.toLowerCase(), port: '80' };
}
/* Host 白名单 —— DNS rebinding 那一道的**唯一**有效判据。
   `Sec-Fetch-Site: same-origin` 与 Origin 都改不了，但它们说的是「页面与目标同源」：
   evil.com 把 A 记录改成 127.0.0.1 之后，那个页面打 http://evil.com:5175/data 在浏览器眼里
   **就是真同源**，两道闸一起变成开门。还站得住的只剩 Host 本身：
   只认回环别名与数字 IP 字面量，而那个 IP 还得是本机自己的地址（网卡上的 / 明确绑上去的）；
   **任何域名一律不认** —— rebinding 用的必然是一个域名。
   要用自定义主机名（`mybox.local`、反代后的域名）时在 .env 写 `ALLOW_HOSTS=a,b` 再重启，
   这一句会打进启动日志，不是悄悄放行。 */
const ALLOW_HOSTS = new Set(String(process.env.ALLOW_HOSTS === undefined ? '' : process.env.ALLOW_HOSTS)
  .split(/[,; ]+/).map(s => s.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
if (ALLOW_HOSTS.size) envWarns.push('ALLOW_HOSTS 已放行域名/主机名：' + [...ALLOW_HOSTS].join(' / ')
  + '（这些名字也就能访问本机服务，改了要重启）');
function hostOk(req) {
  const raw = String(req.headers.host || '');
  if (!raw) return false;                       // HTTP/1.1 必有 Host；缺了就是手搓的请求
  const host = hostPortOf(raw).host;
  if (!host) return false;
  if (isLoopbackAddr(host)) return true;        // localhost / 127.x / ::1
  if (ALLOW_HOSTS.has(host)) return true;
  if (!net.isIP(host)) return false;            // 域名：不认，DNS 把它指回 127.0.0.1 也不算
  if (Date.now() - localIpsTs > 60000) refreshLocalIps();
  if (localIps.has(host)) return true;          // 本机网卡上的地址（手机在同一 WiFi 打开工作台走这一条）
  return BIND.hosts.indexOf(host) >= 0;         // 明确绑上去的那几只
}
/* 浏览器发来的每个请求都带 Sec-Fetch-Site（脚本无法设置），比 Origin 可靠：
   · same-origin → 我们自己的页面，放行
   · none        → 用户自己在地址栏输入/书签跳转（网页做不到），只放行 GET
   · cross-site / same-site → 拦。以前只看 Origin，而「无 Origin 的 GET」一律放行 ——
     于是 <img src="http://localhost:5175/cloud/sync"> 这种不带 Origin 的跨站请求
     能直接触发状态变更（云同步、杀渲染进程、删成片）。
   · 没有这个头 = curl / node / 启动脚本，退回按 Origin 判（Origin 也没有就当本机工具）。
   localhost:3000 和 localhost:5175 是「同站不同源」，所以 same-site 也要拦：
  本机别的网页同样不该能用你的密钥建任务、读 .data/。 */
function sameOriginOnly(req) {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs) {
    if (sfs === 'same-origin') return true;
    if (sfs === 'none') return req.method === 'GET' || req.method === 'HEAD';
    return false;
  }
  const o = req.headers.origin;
  if (!o) return true;                                      // 非浏览器调用
  let u = null;
  try { u = new URL(o); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const self = hostPortOf(req.headers.host);
  if (String(port) !== self.port) return false;
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true;
  if (Date.now() - localIpsTs > 60000) refreshLocalIps();   // 网卡 IP 会变（换网络 / 休眠恢复），一分钟重读一次
  return localIps.has(host);
}
/* 只服务本工作台页面的路由（同源检查在 CORS 之前执行，见 handleRequest）。
   取回/转发类（/getv /fetch /getfile /s3put）也在里面：
   它们会把浏览器递来的 URL 取回甚至写穿，不限制来源就等于对外提供了一个匿名代理（读公网 + 写公网），
   而页面本来就只会同源调用它们。
   注意结尾的分隔符要同时认 `/`、`?` 和串尾 —— 这几条路由都带查询串（/getv?url=…），
   只写 `(\/|$)` 会让它们漏掉拦截（踩过一次）。
   `/pick-dir` 在里面是另一类理由：它把**本机磁盘上一个真实路径**回给调用方。
   不拦的话，任意网页都能在用户机器上弹一次文件夹选择框、再把用户选中的目录读走。
   另存那三条（`/save`、**`/save-local`**、**`/save-move`**）同源检查的理由更重：
   后两条会**写文件、还会删源文件**。注意 `save` 后面那截 `(?:-(?:local|move))?` ——
   写成裸 `save` 时结尾的 `(?:[/?]|$)` 匹配不上 `-`，于是这两条会**整条漏出同源检查**。
   `/client-error` 在里面是「写得进本机那本账」那一类：不要同源 + 会话 Cookie 的话，
   任意网页都能往「设置 → 代理健康」里塞自己编的报错，把那八条名额刷满、把真故障挤掉。 */
const LOCAL_ONLY = /^\/(?:data|cloud|capabilities|skills|asr|search|prompts|local-assets|assets-usage|save(?:-(?:local|move|stale))?|pick-dir|env-status|sys-status|clear-cache|client-error|render|fcpxml|media|s3put|getv|getfile|fetch|custom)(?:[/?]|$)/;
/* relay 转发前缀（/sparkcine、/vgenv、/textai…）与 /asset/ 同样只服务本工作台页面。
   以前它们不在同源检查里：代理在客户端没带 Authorization 时会**自动注入 .env 里的密钥**，
   于是任意恶意网页只要 fetch('http://localhost:5175/sparkcine/...') 就能用你的密钥建任务、扣费、读余额
   —— 和之前 .env 能被直接下载是同一类问题。新接入平台时不用改这里：前缀从 registry 现取。 */
const RELAY_PREFIXES = REGISTRY.providers
  .map(p => String(p.relay || ''))
  .filter(r => r.startsWith('/') && r !== '/')
  // 设置页新添加的自定义平台走 /custom/<id>：前缀固定，加一家不用改这里
  .concat([CUSTOM_RELAY]);
function isWorkbenchOnlyUrl(raw) {
  if (LOCAL_ONLY.test(raw)) return true;
  const pathname = String(raw || '').split('?')[0];
  if (pathname === '/asset' || pathname.startsWith('/asset/')) return true;
  return RELAY_PREFIXES.some(r => pathname === r || pathname.startsWith(r + '/'));
}
/* ---------- 按平台的在途闸 + 只读请求的退避重试 ----------
   搬到 server/relay-gate.js（审查报告 §6.1-1）：那四条立场的注释、闸的账本与 429 的说法都在那里，
   五个 RELAY_* 数字仍由这里的 envInt 现读，实例化在下面（要等 timeText 定好）。 */
/* 会改状态的路由只接受 POST（GET 一律 405）。
   以前 /cloud/sync、/render/cancel 连 GET 都执行：
   浏览器里 <img src="http://localhost:5175/cloud/sync"> 这种「不带 Origin 的 GET」
   既能躲过旧的 Origin 检查，又能真的触发同步 / 杀进程。
   同源检查是第一道，方法检查是第二道 —— 网页要发 POST 就必然带 Origin 与 Sec-Fetch-*，躲不掉。
   页面侧（设置页）本来就是用 POST 调这些命令的，所以这里只是补上约束。 */
const POST_ONLY = /^\/(?:cloud\/(?:sync|push|pull|test|resolve|restore)|render\/cancel|prompts\/open|clear-cache|custom\/models)$/;
function isPostOnlyUrl(raw) {
  return POST_ONLY.test(String(raw || '').split('?')[0]);
}

/* 提示词归档的目录校验、索引与 /prompts 路由在 server/prompts-store.js；
   这里只保留两份文件共用的文件名 / 时间格式化（渲染、健康账也读它们）。 */
/* 文件名里不能出现的字符（Windows 最严：\/:*?"<>| 加控制字符），统一换成 - */
function fileSafe(s, max) {
  const out = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 60);
  return out.replace(/^[.\s-]+|[.\s-]+$/g, '');
}
const pad2 = n => String(n).padStart(2, '0');
/* 日期那半只拼一次：归档目录名与归档正文里的「时间：」以前各抄一遍「年-月-日」，
   改补零时只会改到其中一行 —— 于是同一条记录在文件名里是 2026-10-15、在正文里是 2026-1-15。
   （浏览器那一份在 ui.js 的 dayKey；代理是 Node 进程，够不着它，所以这一侧自己留一份。） */
const dayPart = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const dirStamp = d => dayPart(d) + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
const timeText = d => dayPart(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
const promptsStore = createPromptsStore({
  root: ROOT, log, readBody, localAssetEntry, fileSafe, dirStamp, timeText,
});
const cloudStore = createCloudStore({
  log, anyRequest, guardOutboundUrl, safeOutboundUrl, readBody, dataDirPath, dataFileOf, dataList, dataWriteRaw, keepDataBackup,
  promptCloudDir: promptsStore.promptCloudDir, promptFileList: promptsStore.promptFileList,
});
const { cloudState, cloudStateLoad } = cloudStore;
const capabilities = createCapabilities({ dataDirPath, allProviders, keyOf, DEFAULTS, upRequest, log });
const { capCache } = capabilities;
const systemRoutes = createSystemRoutes({
  sysStatus, registryVersion: REGISTRY.version, port: PORT, providers: REGISTRY.providers, defaults: DEFAULTS,
  caches: { listCache, detailCache, assetUrlCache, capCache }, readBody, noteFault,
});
/* ============================================================================
   云同步（/cloud）—— 把 .data/ 里的数据同步到你自己的云存储
   ---------------------------------------------------------------------------
   当前支持 WebDAV（坚果云 / Nextcloud / 群晖 都提供），它是个人云盘里最通用的一种；
   要接别的协议（S3 兼容等）只需再加一个 adapter，路由与冲突策略不用动。
   认证信息优先用请求头传（页面「设置 → 数据与同步」里填，存浏览器、只发给本地代理），
   其次读 .env 的 CLOUD_WEBDAV_URL / CLOUD_WEBDAV_USER / CLOUD_WEBDAV_PASS。
     POST /cloud/test    测连接（PROPFIND 根目录，顺带自动建目录）
     POST /cloud/push    本地 → 云端（只上传「比远端新」的文件）
     POST /cloud/pull    云端 → 本地（只下载「比本地新」的文件）
     GET  /cloud/status  配置来源与上次同步结果
   四条都吃请求体 { prompts:1, promptDir }：勾了「连提示词归档一起」才带上 prompt_dir 这个
   本机归档目录（代理自己不知道，目录仍要过 promptsDir 的校验），归档会跟着走云端的 prompts/ 子集合。
   冲突策略：个人单机多端场景，按修改时间取新的一份；两边都改过时以更新的为准，
   被覆盖的那份在本地留一份 .bak（在 /data 清单里能看到）。
   ========================================================================== */
/* 一只服务器对象只绑一个地址（默认 `127.0.0.1` 与 `::1` 两只，见上面的 BIND），
   所以两个钩子必须挂在**造**的那一刻，不能像以前那样只往 `server` 上挂一次 ——
   那样第二只回环 socket 既没有 clientError 兜底（畸形 HTTP 帧会变成 uncaughtException），
   连接错误也不进「健康」那本账。 */
const SERVERS = [];
function makeServer() {
  const s = http.createServer((req, res) => {
    // handleRequest 是 async（出站地址护栏要解析域名），所以这里用 Promise 链兜异常：
    // 同步抛与异步拒绝都走同一个 500 分支，单个请求出错不拖垮整个代理进程。
    Promise.resolve().then(() => handleRequest(req, res)).catch(e => {
      noteFault('请求出错', e, req && req.url);
      try { log('[error] 请求处理异常 ' + req.url + '：' + (e && e.message)); } catch {}
      try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); } } catch {}
    });
  });
  /* 畸形请求（错误的 HTTP 帧）： destroy 掉，不让它变成 uncaughtException */
  s.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
  /* 兜底：顶层 try/catch 没接住的 http 层错误（如上游 socket 异常）不再刷屏，但要计数 ——
     浏览器提前断开是常态，所以它只进「连接错误」那一格，不把健康标红。 */
  s.on('connection', c => { c.on('error', e => { try { noteFault('连接错误', e); } catch {} }); });
  SERVERS.push(s);
  return s;
}
const server = makeServer();

/* 自动镜像的两个并发保护：同一份来源的请求只跑一趟，其余等同一个 Promise。
   这个 Map 必须在**模块作用域**（放进 handleRequest 就变成每个请求一份，等于没有锁）。 */
const localSaveLocks = new Map();
function withLocalSaveLock(key, fn) {
  if (!key) return fn();
  const prev = localSaveLocks.get(key);
  if (prev) return prev;
  const p = (async () => {
    try { return await fn(); }
    finally { localSaveLocks.delete(key); }
  })();
  localSaveLocks.set(key, p);
  return p;
}
const extOfMime = m => {
  const want = String(m || '').split(';')[0].trim().toLowerCase();
  return Object.keys(MIME).find(ext => String(MIME[ext]).split(';')[0].trim().toLowerCase() === want)?.slice(1) || '';
};
const extInUrl = u => {
  try { const p = new URL(String(u), 'http://x').pathname; return (/\.([a-z0-9]{1,6})$/i.exec(p) || [])[1] || ''; }
  catch { return ''; }
};

/* 会话令牌（SESSION_COOKIE / SESSION_TOKEN 与那两道 Cookie 闸）整块上移到上面的配置区：
   渲染层取本机素材要带着它拼内部请求头，而装配在下面的依赖层里 —— 令牌本身还是「进程启动时生成一次」。 */

/* 转发闸要 envInt（配置）与 timeText（时钟），所以在这两者都定好之后装配（§6.1-1）。 */
const relayGate = createRelayGate({ envInt, envFrom, log, timeText });
const {
  RELAY_MAX_INFLIGHT, RELAY_QUEUE_MAX, RELAY_RETRY_MAX, RELAY_WAIT_MAX_MS, RELAY_QUEUE_TIMEOUT_MS,
  relayGateOf, noteRelayEvent, relayTake, relayRetryWait, relayStatus, relayRefused,
} = relayGate;
const saveRoutes = createSaveRoutes({
  readBody, log, autosaveDir, autosaveDefaultDirs, autosaveUsedAdd, autosaveUsedHas,
  saveBaseName, saveDirIndex, saveKindOf, saveUniqueName, saveStaleScan, typeLabel,
  productKindOfName, whyNoSpace, insideLocalDir, localFileFromEntry, localIndexRead,
  localMediaType, sha1Of, SAVE_KINDS,
});
const usageRoutes = createUsageRoutes({ localUsageScan });

const mediaRoutes = createMediaRoutes({ readBody, killJobProcs, probe, runFfmpeg, state: mediaState,
  resolveSrc, downloadTo, localAssetFile, log });

const pickDirRoutes = createPickDirRoute({ spawn, log, cap120, firstLine, readBody, root: ROOT });

const registryRoutes = createRegistryRoutes({
  REGISTRY, allProviders, customNotice, modelPrefsNotice, MODEL_PREFS_KEY, readBody, guardOutboundUrl, upRequest,
});

const outboundRoutes = createOutboundRoutes({
  takeOutboundUrl, log, upRequest, failUpstream, pipeUpstream, passthroughHeaders,
  guardOutboundUrl, safeOutboundUrl, keyOf, assetInfoOf, assetStore,
  localAssetEntry, localAssetRepair, localFileFromEntry, serveLocalFile, s3putStream,
});

const relayRoutes = createRelayRoutes({
  allProviders, safeOutboundUrl, baseKeyOf, keyOf, log, readBody,
  detailCache, detailInflight, listCache, listInflight, DETAIL_TTL,
  relayGateOf, relayTake, relayRefused, relayRetryWait, noteRelayEvent,
  cacheSweep, upRequest, failUpstream, pipeUpstream, DEFAULTS,
});

const localAssets = createLocalAssets({
  readBody, log, resolveSrc, downloadTo, keyOf, assetStore, safeOutboundUrl, safeDecode,
  localUpKey, extInUrl, extOfMime, withLocalSaveLock,
  localIndexRead, localIndexUpsert, localIndexRemove, localIndexUpdate, localIndexPut, localFillMissing,
  whyNoSpace, localAssetFile, localMediaType, localAssetWhen,
  LOCAL_DIR, LOCAL_INDEX_MAX, MIME,
});

const renderRoutes = createRenderRoutes({
  readBody, log, renders, renderQueue, running,
  enqueueRender, killJobProcs, pruneRenders, sendFileWithRange, keyOf, assetStore, fileSafe,
  RENDER_DIR, RENDER_CLIPS_MAX, RENDER_QUEUE_MAX, VOICE_MAX,
  renderJobs, saveLocalCopy: localAssets.saveLocalCopy,
});

/* ============================================================================
   分发表（报告 §6.1-1：`handleRequest` 的 if 链 → `[match, handler]` 表）
   ----------------------------------------------------------------------------
   一行一条路由。`match(a)` 只判地址与方法，`run(a)` 只管交给那个路由模块，
   `stop` 说清「这一条回了没有」：
     always    —— 这条地址归它，跑完就结束（原来那些无条件 return 的分支）
     ifNotFalse —— 处理器返回 false 表示「我看过了但不归我」，要继续往下找（原来 `!== false` 那些）
     ifTrue    —— 处理器自己回真假（原来 `if (xxx.handle(...)) return;` 那一族）
   为什么值得换成表：if 链里「顺序」是隐性的 —— 谁插错一位，`/media/info` 就会被 `/media/*`
   先接走，或者某一条忘了 return 就往后多跑一段，两种都不会报错。表里顺序就是数组下标，
   新增一条只能显式插在某一格之间。
   安全闸（Host / 同源 / 会话 / POST-only）不在表里，它们在**进表之前**跑完 ——
   闸的顺序由代码位置保证，不靠表里的某一行，也不许有人往表头插一条路由把闸绕过去。 */
/* 「这一条不判地址，交给处理器自己认」：处理器回 false 就是不归它，接着往下问。 */
const ANY = () => true;
const ROUTE_TABLE = [
  {
    name: 'media/prepare-reference-video',
    match: a => a.path === '/media/prepare-reference-video',
    stop: 'ifNotFalse', run: a => mediaRoutes.handlePrepareReferenceVideo(a.req, a.res),
  },
  {
    name: 'media/info',
    match: a => a.path === '/media/info' && a.method === 'POST',
    stop: 'always', run: a => mediaRoutes.handleMediaInfo(a.req, a.res),
  },
  /* FCPXML：媒体包 / 一键导入工程 / 打开目录 / 启动软件，四条都在 routes/fcpxml.js 里分派；
     只走本机路由，输出到 RENDER_DIR；取不到的素材写 missing.txt */
  {
    name: 'fcpxml',
    match: a => a.method === 'POST' && (a.path === '/fcpxml' || a.path.startsWith('/fcpxml/')),
    stop: 'always', run: a => handleFcpxml(a.req, a.res, {
      renderDir: RENDER_DIR,
      maxAssetBytes: FCPXML_MAX_ASSET_MB * 1024 * 1024,
      maxBundleBytes: FCPXML_MAX_BUNDLE_MB * 1024 * 1024,
      resolveSrc,
      downloadTo,
      localAssetFile,
      fileSafe,
      log,
      readJson: async (rq, limit) => {
        const b = await readBody(rq, a.res, limit);
        if (b == null) throw new Error('请求体读取失败');
        return JSON.parse(b.toString('utf8'));
      },
    }),
  },
  { name: 'capabilities', match: a => a.req.url.startsWith('/capabilities'), stop: 'always', run: a => capabilities.handleCapabilities(a.req, a.res, a.urlObj) },
  /* Skill：清单 / 全文 / references / 安装 / 启停 / 导出；解析与写盘只在 skills-store 一处 */
  {
    name: 'skills',
    match: a => a.path === '/skills' || a.path.startsWith('/skills/'),
    stop: 'always', run: a => handleSkills(a.req, a.res, {
      store: skillsStore,
      readJson: async (rq, limit) => {
        const b = await readBody(rq, a.res, limit);
        if (b == null) throw new Error('请求体读取失败');
        return JSON.parse(b.toString('utf8'));
      },
    }),
  },
  /* 提示词归档：写文件 / 查提示词 / 打开目录（见 server/prompts-store.js） */
  { name: 'prompts', match: a => a.path === '/prompts' || a.path.startsWith('/prompts/'), stop: 'always', run: a => promptsStore.handlePrompts(a.req, a.res, a.urlObj) },
  /* ASR：设置 / 提交 / 查任务 / 取消（本地 whisper 或在线 OpenAI 兼容） */
  { name: 'asr', match: a => a.path === '/asr' || a.path.startsWith('/asr/'), stop: 'always', run: a => asrRoutes.handleAsr(a.req, a.res) },
  /* 联网搜索：设置 / 查询 / 读网页；结果只在内存缓存，失败不自动重试 */
  { name: 'search', match: a => a.path === '/search' || a.path.startsWith('/search/'), stop: 'always', run: a => searchRoutes.handleSearch(a.req, a.res) },
  /* —— 下面这几条**不在这里判地址**：判据在各自的路由模块里（回 false 就是「不归我」）。
     为什么不在表里重抄一份前缀：relay 那一条要问 `allProviders()`（设置页新加的自定义平台
     relay 是 `/custom/<id>`，是运行时才长出来的），`/asset/<id>` 归 outbound 而不是 local-assets，
     `save` 那一条有四个后缀 —— 在这儿再写一份匹配就是第二套实现，两份漂开就变成
     「某条路由时好时坏」那种最难查的 bug。表在这里管的是**顺序**：谁先问、谁兜底。 */
  { name: 'data', match: ANY, stop: 'ifTrue', run: a => dataStore.handleData(a.req, a.res, a.urlObj) },
  { name: 'cloud', match: ANY, stop: 'ifTrue', run: a => cloudStore.handleCloud(a.req, a.res, a.urlObj) },
  { name: 'system', match: ANY, stop: 'ifTrue', run: a => systemRoutes.handleSystem(a.req, a.res, a.urlObj) },
  { name: 'registry', match: ANY, stop: 'ifNotFalse', run: a => registryRoutes.handleRegistry(a.req, a.res, a.urlObj) },
  { name: 'pick-dir', match: ANY, stop: 'ifNotFalse', run: a => pickDirRoutes.handlePickDir(a.req, a.res, a.path) },
  /* ============================================================================
     按类型另存到用户指定的文件夹（POST /save、/save-local、/save-move、GET /save-stale）
     ---------------------------------------------------------------------------
     目录由服务端配置决定，请求体里带目录一律忽略；文件名走 path.basename + 白名单字符。
     同源那一闸见上面 LOCAL_ONLY 那段注释，落盘细节见 routes/save.js 文件头。 */
  { name: 'save', match: ANY, stop: 'ifNotFalse', run: a => saveRoutes.handleSave(a.req, a.res, a.path) },
  { name: 'usage', match: ANY, stop: 'ifNotFalse', run: a => usageRoutes.handleUsage(a.req, a.res, a.path) },
  /* ---------- 让代理直接按 URL 把字节拉回本机（自动镜像的新通道）----------
     浏览器不再下载整段 Blob → base64 → POST：那条链在 200MB 视频上会有 5 倍内存放大，
     并且受 288MB 请求体上限约束。这里由代理流式落盘，浏览器只拿到资产号。 */
  { name: 'local-assets', match: ANY, stop: 'ifNotFalse', run: a => localAssets.handleLocalAssets(a.req, a.res, a.urlObj) },
  { name: 'relay', match: ANY, stop: 'ifNotFalse', run: a => relayRoutes.handleRelay(a.req, a.res) },
  { name: 'render', match: ANY, stop: 'ifTrue', run: a => renderRoutes.handleRender(a.req, a.res, a.path, a.urlObj) },
  { name: 'outbound', match: ANY, stop: 'ifNotFalse', run: a => outboundRoutes.handleOutbound(a.req, a.res) },
  /* 兜底：静态文件。三个工作台合并成 studio.html 之后，旧路径（/video.html、老书签、
     探针脚本）仍然能打开，统一落到 studio.html，类型由 studio_type / ?t= 决定。 */
  { name: 'static', match: () => true, stop: 'always', run: a => handleStatic(a.req, a.res, { root: ROOT, mime: MIME }) },
];

async function handleRequest(req, res) {
  loadEnvFile(false);   // 热加载 .env：改完密钥不用重启
  /* 路由比较统一用去掉查询串的路径：用原始 req.url 的话 /registry?v=1、/env-status?t=1
     这类带查询串的写法会匹配不上、掉到静态服务回 404。 */
  const dataPath = req.url.split('?')[0];
  noteWork(dataPath);   // 「这个端口上的进程还在不被用」—— 健康那一格要说的是干活，不是体检
  /* Host 闸放在**最前面，连静态页面也算**：Host 不认时把 SPA 发过去，
     等于把整台机器交到那个域名手里（页面里每一条相对路由都是本机能力）。 */
  if (!hostOk(req)) {
    log('[拒绝] Host 不在白名单：' + (req.headers.host || '(缺失)') + ' —— ' + req.method + ' ' + req.url);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '这个地址不是本工作台认的主机名（Host: '
      + (req.headers.host || '缺失') + '）。本机请用 http://localhost:' + PORT
      + ' 打开；确实要用别的名字，在 .env 里写 ALLOW_HOSTS 并重启（DNS 重绑定攻击就是这么挡的）' } }));
    return;
  }
  /* 同源判定必须在 cors() 之前：跨站请求连预检都拿不到放行，也读不到任何响应内容。
     （CORS 是全站放开的，先放行再拒绝的话，跨站页面虽然拿不到数据，但连 403 都能读到；
       而且 /render 这类会吃 CPU / 落盘的路由也不该让外部页面碰到。） */
  if (isWorkbenchOnlyUrl(req.url) && !sameOriginOnly(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '只允许本工作台页面访问（跨站请求已拒绝）' } }));
    return;
  }
  /* 同源之后还有一道会话：没有加载过本工作台页面的进程拿不到 Cookie。
     `/asset`、`/getv` 这些取字节的路由也在 isWorkbenchOnlyUrl 里 —— 浏览器的 <video>/<img>
     会带同源 Cookie，所以只挡住「根本没打开过页面」的调用方。 */
  if (isWorkbenchOnlyUrl(req.url) && !hasSession(req)) {
    /* 被拒的响应**不带 Set-Cookie**：以前种令牌排在检查之前，等于「先给你令牌再告诉你没权限」，
       而闸外的调用方只要重试一次就带着刚拿到的 Cookie 过 hasSession。
       令牌只在过了闸、确实要发东西时才种。 */
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '缺少本机会话：先打开工作台页面再调用这条路由' } }));
    return;
  }
  if (isPostOnlyUrl(req.url) && req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
    res.end(JSON.stringify({ error: { message: '这条命令会改本机/云端状态，必须用 POST 调用：' + req.url.split('?')[0] } }));
    return;
  }
  ensureSession(req, res);
  if (cors(req, res)) return;
  /* 每请求一份的分发上下文。`urlObj` 惰性建：绝大多数请求（静态、relay）根本不读它，
     而畸形地址（`/%zz` 那一类）在惰性建之前仍要走完整条链才报错，与改表之前的行为一致。 */
  const a = { req, res, path: dataPath, method: req.method, _u: null,
    get urlObj() { return this._u || (this._u = new URL(req.url, 'http://127.0.0.1')); } };
  for (const r of ROUTE_TABLE) {
    if (!r.match(a)) continue;
    const v = await r.run(a);
    if (r.stop === 'always') return;
    if (r.stop === 'ifNotFalse' ? v !== false : !!v) return;
    /* 处理器说「不归我」：接着往下找，最后由 static 那条兜底 —— 与原来那条链一致。 */
  }
}

/* 把上一次的云同步结果读回来（L51）。
   以前这块只在进程内存里，重启代理就归零 —— 设置页从「3 份冲突待选择」变回「还没同步过」，
   用户以为冲突没了，按一下又跑出同样的冲突，整个过程在界面上无法解释。
   结果状态单独一份文件（.data/.cloud-state.json），同步基线另存一份（.cloud-baseline.json），
   谁写谁的，不用再 read-modify-write 把对方那一半读回来。 */
cloudStateLoad();
if (cloudState.lastAt) {
  log('[cloud] 上次同步结果（从盘上读回）：' + (cloudState.lastResult || '（无记录）')
    + (cloudState.conflicts.length ? '，其中 ' + cloudState.conflicts.length + ' 份冲突待选择' : ''));
}

/* 同一个 DATA_DIR 只允许一个代理写 journal / index / .data；第二个实例直接拒绝启动。 */
const registryCheck = validateProviders(REGISTRY.providers);
if (!registryCheck.ok) log('[registry] 声明校验未通过：' + registryCheck.errors.join('；'));
else if (registryCheck.sharedRelays.length) log('[registry] 声明校验通过（共用 relay：' + registryCheck.sharedRelays.join(' / ') + '）');
/* assetStore 声明坏掉不会让任何一条路由抛错，只会表现成「资产永远取不回」 —— 启动时点名报出来。 */
const assetStoreCheck = validateAssetStore(REGISTRY);
if (!assetStoreCheck.ok) log('[registry] assetStore 声明未通过：' + assetStoreCheck.errors.join('；'));
let instanceLock = null;
try {
  instanceLock = acquireInstanceLock({ dir: dataDirPath(), port: PORT, log });
} catch (e) {
  log('[致命] ' + ((e && e.message) || e));
  process.exit(1);
}
process.on('exit', () => { try { if (instanceLock) instanceLock.release(); } catch (e) {} });

/* 系统代理在后台读（`reg query` 走异步 + 每 30 秒一次）：请求路径上 synchronous spawn 会把
   事件循环按住最长 3 秒，渲染进度、媒体流、健康检查一起停。 */
startProxyWatcher();

/* 第二个参数（地址）才是「只绑回环」这一档的实质落点：`listen(PORT)` 不写 host 时
   Node 绑的是 `::`，等于所有网卡都在听，上面那份默认就整条失效。 */
server.listen(PORT, BIND.hosts[0], () => {
  const kids = REGISTRY.providers.map(p => p.keyEnv).filter((v, i, a) => v && a.indexOf(v) === i);
  const missing = kids.filter(k => !keyOf(k));
  log(`proxy 已启动: http://localhost:${PORT}（端口来自 ${PORT_FROM}${envLoaded ? '；已加载 .env，改完自动热加载' : '；未找到 .env，可用环境变量'}）`);
  /* 渲染那一族的三个数**启动时定一次**（改了要重启，与 PORT / ASSETS_DIR 同一档），
     所以生效值与来源必须打在启动日志里：不然「.env 里写了 2、实际还在串行」这件事在界面上没有任何地方看得出来。 */
  log(`渲染：同时 ${RENDER_CONCURRENCY} 条（${envFrom('RENDER_CONCURRENCY')}）· 在跑与排队最多 ${RENDER_QUEUE_MAX} 条`
    + `（${envFrom('RENDER_QUEUE_MAX')}）· 任务记录与崩溃残留留 ${Math.round(RENDER_KEEP / 60000)} 分钟后回收`
    + `（${envFrom('RENDER_KEEP_MIN')}）· 这三项写在 .env 里，改完要重启`);
  /* 编码那两项与上面三个数字同一档（启动时定一次），所以同样要把「生效值 + 从哪来」打出来：
     配了 H.265 而日志里还是 libx264，说明填的名字不在这张表里（下面 envWarns 会点名）；
     日志说用 NVENC 而成片又是 H.264 的体积，那是本机 ffmpeg 没编进去（原因在每一单的渲染日志里）。 */
  log(`编码：${RENDER_VCODEC}（${ENCODE_PROFILES[RENDER_VCODEC].zh}，来自 ${envFromStr('RENDER_VCODEC')}）· `
    + `档位 ${RENDER_PRESET}（来自 ${envFromStr('RENDER_PRESET')}）· 质量档还是界面上那一个 crf · 改完要重启`);
  /* 转发闸那五个数与上面两族同一档（启动时定一次、改了要重启），所以同样要把「生效值 + 从哪来」打出来：
     .env 里写了 4 而排队还是按 8 走，只有这一行说得出是哪一项没生效（填法不对的由下面 envWarns 点名）。 */
  log(`转发闸：同一家同时在途 ${RELAY_MAX_INFLIGHT} 条（${envFrom('RELAY_MAX_INFLIGHT')}）· 排队上限 ${RELAY_QUEUE_MAX} 条`
    + `（${envFrom('RELAY_QUEUE_MAX')}）· 被限流后读请求最多重问 ${RELAY_RETRY_MAX} 次（${envFrom('RELAY_RETRY_MAX')}）`
    + `· 一次最多等 ${Math.round(RELAY_WAIT_MAX_MS / 1000)} 秒（${envFrom('RELAY_WAIT_MAX_MS')}）`
    + `· 排队最多等 ${Math.round(RELAY_QUEUE_TIMEOUT_MS / 1000)} 秒（${envFrom('RELAY_QUEUE_TIMEOUT_MS')}）· 都写在 .env 里，改完要重启`);
  /* 监听地址与上面几族同一档（启动定一次、改了要重启），所以也要把「绑在哪、从哪来、别人连不连得到」打出来。
     这一行不是装饰：默认只绑回环之后，「手机打不开工作台」与「局域网里谁能用这台机器的密钥」
     是同一件事的两面，只有这一行说得出此刻是哪一面。 */
  log(`监听：${BIND.hosts.map(bindAddrText).join(' + ')}（${BIND.why}）· `
    + (BIND_LAN
      ? '⚠ 局域网可达 —— 同一网络里的任何设备都能读这台机器的业务数据、并用服务端 .env 里的密钥建任务，只有确实要从别的设备用才这么配'
      : '只有本机连得上（别的设备要访问就在 .env 写 BIND_HOST=all，然后重启）'));
  /* 其余的绑定地址（默认那一档就是 `::1`）等第一只绑成之后再起：先绑成功的那一只已经证明
     这个端口能用，后面那些绑不上时（机器关了 IPv6、或那一张网卡被临时拿走）只警告、不退出 ——
     少了这一段，一台关了 IPv6 的机器会整个应用起不来，而它只是少一个回环别名。 */
  BIND.hosts.slice(1).forEach(h => {
    makeServer().listen(PORT, h).on('error', e => {
      log(`[警告] ${bindAddrText(h)} 没绑上（${e.code || e.message}）—— 上面那些地址照常在听，`
        + (isLoopbackAddr(h) ? '本机用这个别名（localhost 解析到它时）会连不上' : '这一张网卡上的设备连不上'));
    });
  });
  envWarns.forEach(w => log('[警告] ' + w));
  /* 崩溃残留不必等到下一次 5 分钟定时器：上一次被硬杀 / 断电留下的临时写入文件，
     在开机这一刻就是纯垃圾（年龄闸只保护**别的实例正在写**的那一个）。
     渲染那一族的残留目录同理 —— pruneRenders 本来就在跑，只是以前第一次要等 5 分钟。 */
  try {
    const swept = sweepStaleTmp();
    if (swept) log(`[清理] 删掉 ${swept} 个崩溃残留的临时写入文件（.data / 资产库里那种 .tmp-<pid>-<串>）`);
    pruneRenders();
  } catch (e) { log('[清理] 启动清扫跳过：' + (e.code || e.message)); }
  /* 出站代理那一句放在启动信息里：在必须走代理才能出网的环境里，
     「有没有走代理」是第一个要确认的事，而页面上只看得到「转发失败（打到 xxx）」。 */
  const px0 = outboundProxy();
  if (px0.cfg) {
    log(`出站代理：${px0.src} —— 平台请求与媒体取回都从它出去（本机 / 内网地址与 NO_PROXY 里的仍直连）。`);
    log('       想关掉：在 .env 里写一行 PROXY_OFF=1，或把代理软件的系统代理关掉（30 秒内自动跟上）。');
  } else if (px0.src) {
    log(`出站代理：${px0.src}`);
  } else {
    log('出站代理：没检测到（直连）。本机开着代理软件却连不上平台时，在 .env 里写 HTTPS_PROXY=http://127.0.0.1:端口。');
  }
  if (missing.length) {
    log(`[提示] 以下平台还没配密钥，对应工作台会报「未配置密钥」：${missing.join('、')}。`);
    log('       填法：项目目录的 .env（KEY=VALUE 一行一个，改完自动生效），或页面「设置」里填写。');
  }
  if (renderQueue.length || running()) log(`[render] 恢复队列：${renderQueue.length} 个待处理`);
}).on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`[错误] ${BIND.hosts[0]}:${PORT} 已被占用：项目可能已在运行（直接访问 http://localhost:${PORT}），或先用「启动.bat」里的停止功能关闭旧进程`);
  else if (e.code === 'EACCES') {
    /* EACCES 在 Windows 上几乎总是「这个端口被系统保留段占了」，不是权限不够：
       Hyper-V / WSL2 的 winnat 开机时按 100 端口一段地划走，报出来既不是 EADDRINUSE
       也看不出原因，只有一行 permission denied。把查法与三条出路一次说清。
       还要先说清这个号是谁给的（环境变量 / .env / 默认）—— 不然窗口里残留一个
       set PORT=5175 时，人只会对着「.env 明明写了 6200 为什么还报 5175」干瞪眼。 */
    console.error([
      `[错误] ${BIND.hosts[0]} 上的 ${PORT} 号端口绑不上（EACCES）。Windows 上这通常不是权限问题，而是这个端口落在系统保留段里`,
      `       （Hyper-V / WSL2 的 winnat 开机时按段划走，一整个连续段几百个号，netstat 上看不见它们）。`,
      `  这一次用的端口来自：${PORT_FROM}；绑的地址是：${BIND.hosts.map(bindAddrText).join(' + ')}（${BIND.why}）`,
      ...PORT_CLASH,
      `  查一下是不是这一类：netsh interface ipv4 show excludedportrange protocol=tcp   （看 ${PORT} 落在哪个区间里）`,
      `  出路 1（不动系统、不用管理员，最快）：换一个真能 bind 的号 —— 直接跑「启动.bat」选 1，它会现测一个并说清换成了哪个；`,
      `       或者在项目目录的 .env 里写一行 PORT=那个号 固定下来（改这里要重启代理才生效）。`,
      `       页面全部走同源相对路径，换端口不影响任何功能。`,
      `  出路 2：重启电脑。保留段每次开机重新划分，多半就挪走了。`,
      `  出路 3（管理员，想把 ${PORT} 永久留给自己）：`,
      `       net stop winnat`,
      `       netsh int ipv4 add excludedportrange protocol=tcp startport=${PORT} numberofports=1 store=persistent`,
      `       net start winnat`,
      `       代价：中间这几秒 WSL / Hyper-V 的共享网络会断。`,
    ].join('\n'));
  }
  else console.error('[错误] 启动失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});

/* ---------- 退出与兜底：Ctrl+C / 崩溃时杀掉 ffmpeg 子进程，不留孤儿 ---------- */
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const n = allProcs().length;
  if (n) { log(`[退出] 结束 ${n} 个 ffmpeg/ffprobe 子进程`); allProcs().forEach(p => { try { p.kill('SIGKILL'); } catch {} }); }
  /* 回环那两只（可能还有网卡那一只）一起关；第二只没绑上时它还挂在 SERVERS 里，
     对一只从没 listening 的 server 调 close() 会回 ERR_SERVER_NOT_RUNNING，所以先问 listening。 */
  SERVERS.forEach(s => { try { if (s.listening) s.close(); } catch {} });
  destroyAgents();                     // keep-alive 池 + 代理隧道
  try { if (instanceLock) instanceLock.release(); } catch {}
  setTimeout(() => process.exit(code), 120);
}
process.on('SIGINT', () => { log('[退出] 收到 Ctrl+C'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
/* 顶层这四个出口全都「记一笔 + 继续活」：本地工具里，一次异常打断使用比带病跑更糟。
   但「继续活」不等于「什么都不说」—— 每一笔都进 `noteFault` 那份有界的账，
   随 /sys-status 的「健康」递到设置页与助手那里（见上面的故障账一节）。 */
process.on('uncaughtException', e => { try { noteFault('未捕获异常', e); log('[致命] 未捕获异常：' + (e && e.stack || e) + '（已记进「设置 → 本机环境 → 代理健康」；进程按设计继续跑，要清掉这份账请在启动器点「重启」）'); } catch {} });
process.on('unhandledRejection', e => { try { noteFault('Promise失败', e); log('[警告] 未处理的 Promise 失败：' + (e && e.message || e)); } catch {} });
/* 「客户端连接错误记一笔」那个钩子挂在 `makeServer` 里（见上面）：一只 server 只绑一个地址，
   挂在这儿的旧写法只盖得住第一只，第二只回环 socket 就漏了 —— 别再加回来。 */
