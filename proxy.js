// 本地代理：node proxy.js 后访问 http://localhost:5175
// 所有生成平台都走 REGISTRY 声明的 relay 前缀转发（见下方 REGISTRY）：
// 页面只认 /registry 里的声明，不认具体厂商，所以接入新平台不用改页面。
const http = require('http');
const { request: httpsRequest, Agent: HttpsAgent } = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const zlib = require('zlib');
const tls = require('tls');
/* 素材身份判据（浏览器那边 assetlib.js 用的是同一个文件的同一份，见 ident.js 顶部）。
   这里 require 而不是抄一份：落盘闸要判断「这份产物本机有没有存过」，
   而浏览器要算缓存键与跨页去重 —— 同一件事，两处各写一份就一定会漂。 */
const MediaId = require('./ident.js');

/* 端口默认 5175。PORT 也能写在项目目录的 .env 里 —— 所以这一行必须排在 loadEnvFile(true)
   **后面**：以前它排在前面（在 require 之后立刻读），.env 里写的 PORT 根本不生效，
   只有真的在命令行 set 过才管用。Windows 的 Hyper-V / winnat 会在开机时把一段连续端口
   保留走（实测这台机器把 5174~6173 整段都占了），撞上报的是 `listen EACCES` 而不是
   常见的 EADDRINUSE —— 换端口是唯一不用管理员权限的出路，所以这条路必须真的走得通。
   另外 PORT 环境变量可以另起一个实例（配合 DATA_DIR 用一份独立的数据目录），
   自动化验证时就不必在真实用户数据上跑。 */
const UPSTREAM = 'https://hi.hi.run';

/* ---------- 密钥注入（优先级：页面设置里填的 > 系统环境变量 > 同目录 .env） ----------
   1) 页面「设置」里填写的密钥存在浏览器 localStorage，请求时带 Authorization 头传过来；
   2) 没带就用环境变量（set SPARKCINE_API_KEY=xxx / setx 永久 / 系统变量）；
   3) 也可以用同目录 .env 文件（KEY=VALUE，一行一个，# 为注释），无需配置系统环境变量。
   注意：源码里不再内置任何真实密钥 —— 内置密钥会随源码外泄（本文件进版本库，
   任何拿到源码的人都能直接花你的额度）。没配密钥时启动会打印提示，去「设置」页填即可。 */
const ENV_FILE = path.join(__dirname, '.env');
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.ass': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const LOG = path.join(__dirname, 'proxy.log');
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

/* ============ API 注册路由 ============
   接入新图片/视频 API 的步骤：
   1. 在 providers 里加一条：id、kind(image|video)、relay(本地转发前缀)、
      base(上游地址)、keyEnv(密钥环境变量)、endpoints(端点模板)、models(模型及能力 modes)
   2. 客户端从 GET /registry 读取，按「所需生成模式」过滤出可用模型
   支持的 modes：
     图片: text_to_image, image_edit
     视频: text_to_video, first_last_frame, reference_images, reference_video, reference_audio
   定价声明 pricing（客户端统一据此估价，新 API 必须声明）：
     { type:'per_image_table',  currency:'积分' }                    模型自带 price{quality:单价}，×张数
     { type:'per_second_table', currency:'积分', endpoint:'models' } 从 endpoint 拉模型表，pricing.perSecond×秒数×条数
     { type:'quote',            currency:'¥',    endpoint:'price' }  实时报价接口，按参数查价×条数
     quote 那一型还可以声明三样（见 VGENV 那一条）：
       `method:'POST'` + `body:{ 上游字段名: 本地参数名 }` + `consts:{ 上游必填但不计价的字段 }`；
       `noQuote:{ when:{…}, why:'…' }` = **这一档没有询价这条路**（不是「询价失败了」）。
       VGENV 的动作换人在报价时要求带上那段参考视频，而报价是纯参数查询、拿不到用户手里的字节，
       实测十二种参数全回 422 —— 界面据此说一句「这一档平台不问价」，也不再发那一次注定失败的请求。
   模型能力：provider 声明 endpoints.models 后，客户端会调该接口拿「真实支持范围」
     （allowedValues: 分辨率/画质/比例/输出格式/时长范围/张数上限 + pricing 积分价），
     自动覆盖 registry 里写的 options（写死的只是兜底）。
     上游形状不是「parameters 对象」的那种（VGENV 的 /v3/models 是 configurations 数组，一项一档组合）
     配 `modelsShape` 点名一种归一化形状，按形状而不是按平台 id 分派。
   素材引用语法（可选）：provider 上加 refSyntax: '[image{n}]'，客户端提交前会把提示词里的
     @参考图N 自动换成该语法；不声明则原样保留（参考图仍按第 N 张 = 数组第 N 个上传）。

   list —— 「拉历史/资产」的统一声明（资产库、任务列表、剪辑素材都读它，页面不再认识具体平台）：
     dataField   条目数组在响应里的字段名
     cursorField 响应里的下一页游标字段（空 = 该接口不支持翻页）
     cursorParam 请求里的游标参数名（默认 cursor）
                 · 端点写 'local:/xxx' 表示代理本地端点（如本地资产库），不拼 relay 前缀
     limitParam  每页条数参数名；limit 建议值
     map         字段映射：标准字段 → 上游字段路径（点路径）
     statusMap   上游状态 → 标准状态（done / queued / running / failed）
     media       媒体类型判定：{ fixed:'图片' } 或 { by:'model', videoPrefix:[...], imagePrefix:[...], fallback:'图片' }
     priceStyle  'credits'（取 credits.charged ?? credits.held，单位积分）| 'micros'（price.amount_micros → 元）
     perItem     需要按条目计算时才用的额外字段（如 outputs 数组里取 asset_id）

   create —— 「创建任务」的统一声明（客户端按标准字段拼请求体，页面不再各写一份）：
     endpoint    用哪个端点（默认 create）
     body        顶层字段：标准字段名 → 上游字段名（标准字段：model/prompt/tier/duration/res/ar/quality/count/format）
     nest        需要嵌进对象里的字段：[上游字段名, 标准字段名] 成对写：{ parameters: [['aspect_ratio','ar'], ...] }
     constants   固定值（如 optimize_prompt:false）
     topBools    提交体**顶层**的布尔开关 { 字段名: {label, hint, def, priceKey?} }：
                 页面把声明出来的**每一项**都渲染成高级设置里的一颗磁贴（三种类型共用一块），
                 值随 params 一起提交，落在顶层而不是 nest 那个嵌套对象里；
                 priceKey 指向该平台定价表里的字段（开启后另加这个价），声明了就自动进估价。
                 v14 起这两项可以**按这一次请求的形状**变化（形状 = Capability 的 combo：
                 `{mode, intent}`，页面从「输入模式」那排芯片原样递过来）：
                   def:  { when: {…}, then: true, else: false }  同一开关在不同形状下默认值不同
                         （VGENV 的「保留原声」：普通生成默认关，动作换人默认开）
                   hide: { when: {…} } + hideNote               这一档**根本没有这个字段**，
                         界面不画、提交体与报价体一个字都不发（VGENV 换人时显式发
                         prompt_optimization:{mode:'raw'} 会 422，不发才是对的）
                 判据只在 assetlib.js 的 topBoolState 一份，页面 / 提交 / 报价三处都问它；
                 没有形状声明的平台（combo 为空）一律「用普通默认值、不隐藏」，行为与 v13 逐字相同
                 v15 起再加一种「不给画」的来路，因为「有没有」不总在形状里：
                   need: 'caps.xxx' + needNote / needMissingNote
                        这一项**存在**还要看**这一次的那一行能力**给不给（逐行能力来自
                        平台自己的 /models，归一化成 combo.states，见 Capabilities.shapeState）。
                        VGENV 的 turbo 就是这一种：文档写明「需独立授权与运行开放」，
                        实测同一个模式里带参考视频的那几种组合一律 false、其余为 true ——
                        按「这个型号总共有没有」画开关，就会发一个平台当场拒的字段。
                        两句说明分开写：needNote = 这一档确实不给；needMissingNote =
                        **能力清单还没取回来**（加载期），把后者写成前者就是替用户下结论。
     shapeFields 提交体**顶层**的非布尔字段 { 字段名: {label, hint, kind, from?, min?, max?,
                        none?, only?:{when,why}, emptyNote?, missingNote?} }（v15 起）：
                 与 topBools 同一套思路 —— 页面只为声明出来的项渲染控件，取值随 params 提交、
                 落在顶层，报价体按 `pricing.body` 的映射带上；判据在 Capabilities.shapeFieldState 一份。
                   kind: 'select' 取值清单来自 `from:'caps.xxx'`（逐行能力，例如 VGENV 的 2x 超分
                         只在部分 tier × 素材组合里给）；`none` 给一个「不超分（默认）」这种
                         **空值选项**（值为空串 → 提交体与报价体都不发，这一家未知/空值会被拒）
                   kind: 'int' | 'number' 用 min/max 当场校验并写进说明（seed 的 0–281474976710654
                         是文档给的，与实测 400 消息里那两个数一致）
                   only: { when: {…} } 只有这种请求形状才有这个字段（VGENV 的 motion_start_seconds
                         发到普通生成上是 422 PERSON_REPLACEMENT_INTENT_REQUIRED）
                 什么都没声明的平台这一块整块不出现，行为与 v14 逐字相同。
     note        备注字段值（有些平台会记录）
     idempotencyKey  该平台是否支持幂等键（默认 true）：
                     true  → 客户端给 POST 带上 Idempotency-Key；网络超时后允许自动重试
                     false → 不带；POST 一律不自动重试（避免网络抖动时重复建任务、重复扣费）
                     （客户端行为见 assetlib.js 的 Api.request 与 ui.js 的 Net.fetch）

   provider 级可选声明：
     keyId        与别的 provider 共用同一把密钥（sparkcine-video → sparkcine）
     pollVia      'list' = 单条轮询走列表端点、按任务号找（平台的详情端点不可用时声明；见 VGENV）
     cancelMethod 取消任务用的 HTTP 方法（默认 POST）
     noPromptField 平台不返回提示词（界面据此提示「平台不返回」）
     roleRules    按**输入角色**声明「收什么文件、单个多大」：`{ role: { accept, maxBytes, media } }`。
                   只在能力接口不给这两条时写（VGENV 的 /v3/models 只给数量），归一化时并进每一条输入规格；
                   写在平台级而不是型号级，是因为 v13 起注册表不再按型号列清单、`models[].inputRoles` 已删。
     baseEditable 允许用 x-up-base 头临时换基址（内置文字 AI 供应方的「自定义接口地址」）。
                   生成平台不走这条路，同形状的中转站在设置页「添加自定义供应商」里登记成一条新 provider
                   （见下面「自定义接口」一节）；自定义条目**连文字 AI 也不走** —— 那边 buildCustom 会把
                   baseEditable 剥掉，地址固定在它自己那份声明里，免得「界面说改了地址、其实没改」）

   balance —— 余额卡片解析方式：'wallet-credits'（available/reserved 字段）| 'micros'（availableMicros 等）   */
const REGISTRY = {
  /* 代理/注册表版本。页面拿它判断「跑着的 proxy.js 是不是旧版」——
     旧代理会让能力声明停在老样子（例如设置页「添加自定义供应商」登记的接口根本不进注册表，
     各工作台的型号下拉里也就看不见；v6 起文字 AI 也能登记成自定义供应商，旧代理会把它当「找不到模板」丢掉；
     v7 起文字 AI 有 9 家 OpenAI 兼容供应方并带余额接口，v8 起生图/语音多了同步返回那一族与 tts.encoding。
     v9 起产物「只给文件号、要再换一次地址」那一族有了通用 retrieve 环节，并接了 MiniMax 视频 /
     硅基流动视频 / 智谱 CogVideoX 三家视频平台。
     v10 起注册表多了一张 `interfaceShapes`：设置页「添加自定义供应商」里「供应商 = 自定义」时
     选的那一格（OpenAI 兼容接口、H3 兼容接口…），它按类型列**接口族**而不是厂商。
     v11 起两处变化：① 撤掉自定义平台「最多 12 家」的上限（`custom.max` 字段一并删掉）；
     ② 「地址不许撞模板自己的官方地址」不再算错 —— 内置平台现在也要先添加一次才进设置页的
     供应商清单，那个官方地址正是设置页自动填进去的默认值（只拦撞到**别的**内置平台）。
     v12 起本机资产库的 `list.map` 多一个 `taskId`（= 落盘时留在索引里的 `detail.task`）：
     本机那一条的 id 是文件号 la_xxx，不是平台任务号，页面要靠它才知道该拿什么去问提示词归档。
     v13 起**注册表不再列型号清单**：型号由「平台自己的 /models 现取」+「设置页自己填」两条路来，
     并新增 `.data/sk_model_prefs.json`（每家一个 `{typed, off}` —— 手填的型号与逐个「隐藏 / 展示」）。
     `models: [...]` 只剩两种去处：① 有型号接口的家 → 整条删掉（清单归接口）；
     ② 没有型号接口、或它的 /models 只列对话模型的家 → 改名 `modelDocs`，
       它不再是「清单」，只是「文档里写过这个 id 支持什么」的表，用户真填了这个 id 才用得上。
     老代理（v12 及以下）不读那份偏好：设置页里勾了「隐藏」的型号还会出现在下拉里、
     手填的型号永远进不来 —— 所以 `PROXY_VERSION_MIN` 一起升到 13，让页面把「请先重启代理」说出来。
     v14 起两处**新结构**：① provider 级 `roleRules`（每种素材「收什么文件 / 单个多大」）——
       型号清单归接口之后，这两条规矩在接口响应里根本没有，只能在这儿按平台声明一次；
       旧代理不带它，界面上「收什么文件」那一行会整块消失。
     ② `create.topBools` 的声明多了「按**这一次请求的形状**（mode + creation_intent）成不成立」一层
       （`hide.when` / `def.when`）。
       旧代理不认识这些键 → 「视频换人」模式下会把一个平台明确拒绝的开关照发过去（422）。
     v15 起把「有没有这一项」补上第三种来路，并新增一类非布尔字段：
     ① `create.topBools.*.need: 'caps.xxx'`（配 needNote / needMissingNote 两句说明）——
       存在与否不再只看形状，还要看**这一次的那一行能力**。VGENV 的 turbo 是这一种：
       /v3/models 把它写在 (tier × 素材组合) 上，带参考视频的那几种一律 false，
       按「型号总共有」画开关就会发一个被拒的字段。归一化那一份存在 `combo.states`，
       判据在 assetlib 的 Capabilities.shapeState（v15 起才有 states，旧代理没有）。
     ② `create.shapeFields`（超分档 / 随机种子 / 换人的动作起点这一类**顶层非布尔**字段）
       与 `pricing.noQuote`（这一档根本不询价）。旧代理两者都不认识：
       界面上那几项不会出现，而「动作换人」会继续对着报价接口发一次注定 422 的请求，
       把「这一档平台不问价」显示成一句失败。
     v16 起文字 AI 那九家的 `models: [...]` 全部改名 `modelDocs` —— **注册表不再下发任何一份
     文字型号清单**。这份写死的清单看着像「兜底」，实际是「型号就这几个」的假象：设置页那张清单
     与型号下拉都从它派生时，用户看到六个、下拉里也是那六个，而他自己刚取回来的几百个一个都不在里面。
     改成 modelDocs 之后它只剩两个用途（识图判定、自定义供应商的接口形状参照），不再冒充清单。
     旧页面（v15 及以下）读的是 `models`：它仍然认 modelDocs 吗？不认 → 那几个 id 的识图判定会退回「自动」，
     而型号清单本来就要靠页面点一次「获取型号列表」取回，取回的那份存在 `.data/sk_model_prefs.json` 里。
     改注册表结构时顺手 +1。 */
  version: 16,
  /* 「接口形状」= **接口族**清单，每一族点名它照哪一家内置声明实现。
     为什么与「供应商」分开：厂商（SparkCine / 硅基流动 / MiniMax…）是「我照它那一家整套走」，
     而接口形状是「我跑的就是这一套协议，厂商是谁不重要」—— 市面上大量中转站都跑 OpenAI 兼容那一套，
     它们跟 OpenAI 官方不是一家，但接口一模一样。设置页「供应商」下拉末尾那一项「自定义」就是走这份清单。
     每一项的 template 必须是一个**真实存在的内置平台 id**（buildCustom 照它整套克隆，
     这一族的能力声明、上传流程、retrieve 环节全从它来）—— 所以这里不编不存在的形状，
     加一族就是给某个内置平台补一个更好懂的名字。 */
  interfaceShapes: {
    image: [
      { id: 'openai-image', name: 'OpenAI 兼容生图（POST /images/generations，当场返回图片）',
        template: 'siliconflow-image', note: '一次请求出图、没有任务号；返回的外链一般一小时左右过期' },
      { id: 'task-asset', name: '任务 + 资产号（建任务 → 轮询 → 按资产号换签名地址取图）',
        template: 'sparkcine', note: '产物是资产号，取图要走 /asset/<id> 换一次上游签名地址' },
    ],
    video: [
      { id: 'h3-compatible', name: 'H3 兼容接口（建任务 → 轮询 → 产物走资产号）',
        template: 'sparkcine-video', note: '跑 H3 那一族的中转网关选它：模型名带 h3- 前缀那一套' },
      { id: 'vgenv-compatible', name: 'VGENV 兼容接口（建任务 → 按任务列表轮询 → 产物是签名地址）',
        template: 'vgenv', note: '没有可用的详情端点，状态靠列表接口按任务号找' },
      { id: 'file-id-retrieve', name: '文件号 + retrieve 两段式（状态接口只给 file_id，要再换一次地址）',
        template: 'minimax-video', note: '这是通用 retrieve 环节那一族：产物地址要再问一次文件接口' },
      { id: 'submit-status', name: '提交 + 状态两段式（结果地址直给，但可能只管几分钟）',
        template: 'siliconflow-video', note: '结果地址有效期很短，靠「产物自动存本机」那一层留住' },
      { id: 'async-result', name: '异步结果（结果在一个数组里，状态 PROCESSING / SUCCESS / FAIL）',
        template: 'zhipu-video', note: '结果不是单个字段而是 video_result 数组；状态是大写英文那套' },
    ],
    audio: [
      { id: 'openai-chat-audio', name: 'OpenAI 兼容对话 + 音频参数（POST /chat/completions，音频放在 audio 字段）',
        template: 'mimo', note: '文本回 assistant、音频参数放 audio 字段的那一套' },
      { id: 'tts-hex', name: '专用 TTS 接口（POST /t2a_v2，音频是十六进制不是 base64）',
        template: 'minimax-tts', note: '音频直接给十六进制串，不是 base64 也不是外链 —— 中转站基本不会这样' },
    ],
    text: [
      { id: 'openai-chat', name: 'OpenAI 兼容对话（POST /chat/completions + GET /models）',
        template: 'deepseek', note: '市面上绝大多数中转站 / 企业网关跑的就是这一套' },
    ],
  },
  providers: [
    {
      id: 'sparkcine', name: 'SparkCine 生图', displayName: 'SparkCine', kind: 'image', relay: '/sparkcine',
      base: 'https://hi.hi.run', keyEnv: 'SPARKCINE_API_KEY', site: 'https://hi.hi.run',
      // 同一个上游的列表里既有图也有视频：按媒体类型落到各自的 provider id（路由/取消/轮询用）
      mediaProviders: { '图片': 'sparkcine', '视频': 'sparkcine-video' },
      /* 这一条与 sparkcine-video 共用同一个上游与同一个 /models —— 返回的是**一份混合清单**
         （img-* 与 h3-video-* 全在一起）。`modelMedia` 点名这一条只要图片那类，
         能力层据此切分，否则视频台会列出图片模型、图片台会列出视频模型。 */
      modelMedia: '图片',
      pricing: { type: 'per_image_table', currency: '积分' },
      endpoints: {
        create: '/api/open/v1/generations',
        poll: '/api/open/v1/generations/{id}',
        list: '/api/open/v1/generations',
        cancel: '/api/open/v1/generations/{id}/cancel',
        credits: '/api/open/v1/wallet',
        models: '/api/open/v1/models',   // 模型能力（画质/比例/格式/张数/积分的真实支持范围）
        // 素材上传（跨平台转存用）：三步 intent → s3put → complete，客户端统一走 AssetTransfer
        uploads: '/api/open/v1/uploads',
        complete: '/api/open/v1/uploads/{id}/complete',
      },
      // 列表：与 sparkcine-video 是同一个上游接口（relay 相同 → 客户端只拉一次）
      list: {
        dataField: 'data', cursorField: 'next_cursor', cursorParam: 'cursor', limitParam: 'limit', limit: 100,
        cacheTtl: 8000,             // 列表上游很慢：代理层短缓存，多个页面共用（客户端 x-no-cache 可强制回源）
        map: {
          id: 'id', status: 'status', prompt: 'prompt', model: 'model', mode: 'mode',
          created: 'created_at', completed: 'completed_at',
          outputs: 'output_asset_ids', duration: 'parameters.duration',
          res: 'parameters.resolution', ar: 'parameters.aspect_ratio', quality: 'parameters.quality',
          count: 'parameters.output_count', format: 'parameters.output_format', tier: 'tier',
          credits: 'credits', priceMicros: 'price.amount_micros', currency: 'price.currency',
          error: 'error.message',
        },
        statusMap: { succeeded: 'done' },
        media: { by: 'model', videoPrefix: ['h3-'], imagePrefix: ['img-'], fallback: '图片' },
        priceStyle: 'credits',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: true,     // 平台要求带幂等键（漏了会 400）；带键的 POST 才允许自动重试
        body: { model: 'model', prompt: 'prompt' },
        nest: { parameters: [['quality','quality'], ['aspect_ratio','ar'], ['output_count','count'], ['output_format','format'], ['duration','duration']] },
        // 上传接口的字段命名（SparkCine 是下划线；AssetTransfer 按这份声明拼请求体）
        uploadFields: { fileName: 'filename', contentType: 'content_type', sizeBytes: 'byte_length', sha256: 'sha256' },
      },
      balance: { style: 'wallet-credits' },
      /* 型号清单**不在本地写死**（2026-10）：这一家的 /api/open/v1/models 实测能拿到全部 8 个型号
         与它们的画质/比例/格式/张数/参考图上限/价格，全部实时获取。
         以前这里硬写两条 img-* 兜底声明 —— 平台加一个型号要改注册表才能看见，
         而能力接口不可用时那份声明又会与实测漂移（曾经锁 png、参考图上限猜 9）。 */
    },
    {
      id: 'vgenv', name: 'VGENV 视频', displayName: 'VGENV', kind: 'video', relay: '/vgenv',
      base: 'https://api.vgenv.com', keyEnv: 'VGENV_API_KEY', site: 'https://vgenv.com',
      cancelMethod: 'DELETE',   // 取消用 DELETE（SparkCine 是 POST /cancel，不声明则为 POST）
      /* 详情端点 /v2/videos/{id} 实测是 404 空壳错误（只回 statusCode/code/message，没有任务字段）：
         拿它轮询会让任务永远停在「排队中」，而且 404 还会被误判成「任务已被清理」把任务号清掉，
         同一个任务于是在界面上裂成两张（假失败卡 + 列表里真实的完成卡）。
         列表接口返回完整对象（含 status / output.url），所以轮询声明走列表按任务号找。 */
      pollVia: 'list',
      /* 报价接口：**POST /v3/videos/quote**（2026-10 实测）。
         请求体与 create 同形，其中 **prompt 必填、要求 5–30000 字**（少一个都回 400），
         但文档明写报价「不创建 Job、不冻结余额、**不运行提示词优化或换人分析**」——
         也就是说 prompt 的**内容根本不参与计价**，它只是个必填字段。
         所以这里用 `consts` 给一个占位串，而不是把用户的提示词递过去：
         导演台那种「这一镜还没写提示词」的场合照样能报价，
         用户提示词不足 5 字或超过 30000 字时也不会把报价问挂。
         响应：`{ price: { currency:'CNY', amount_micros, unit_price_micros, catalog_version } }`，
         缺参数时平台会把默认值回显出来（不传 duration 回 15、tier 回 fast…）。
         ⚠ 别指望本地查表：GET /v3/models 的 configurations 只有档位/时长/清晰度/比例/
         2x 超分/Turbo 资格，**没有单价字段**，所以实时报价是唯一拿得到钱的路。
         旧声明指向的 GET /v2/pricing 实际不可用（页面上一律报「未开放报价接口」），已删。 */
      pricing: { type: 'quote', currency: '¥', endpoint: 'quote', method: 'POST',
        body: { model: 'model', tier: 'tier', duration: 'duration',
          resolution: 'res', aspect_ratio: 'ar', creation_intent: 'creation_intent',
          /* 超分档也进报价体：文档写明 2x 是「生成附加费」，报价接口按同一套参数算 ——
             不带过去，界面上拨了 2x 而报价纹丝不动，差价就落到创建那一刻才暴露。
             取值来自 `create.shapeFields.upscale`（页面按**那一行能力**给的档渲染，
             空值「不超分」不发），与提交体、界面共用同一份判据。 */
          upscale: 'upscale' },
        consts: { prompt: '报价预估（不创建任务）' },
        /* 动作换人**问不出价**：文档 03 节写明报价也要带上那段参考视频，而报价是一次纯参数查询、
           手里没有字节 —— 实测十二种换人参数组合全回 422 `PERSON_REPLACEMENT_INPUT_INVALID`。
           这不是「报价接口坏了」，是这一档没有这条路，所以声明成 noQuote：
           客户端直接回一句人话、连那一次注定失败的请求都不发。
           （普通生成一切正常，别照这一条把整个平台的估价关掉。） */
        noQuote: { when: { intent: 'person_replacement' },
          why: '动作换人不问价：平台要求报价时一起交那段参考视频，而这里是纯参数查询' } },
      noPromptField: true,   // 接口不返回提示词（列表/详情/V1/流水都实测过），界面据此提示"平台不返回"
      // 注意：VGENV 的列表 / 详情 / V1 兼容接口 / 余额流水都不返回 prompt（实测过），
      // 所以提示词只能靠客户端创建任务时归档一份（assetlib 的 PromptLog → /prompts 存进归档文件夹，
      // 界面据此标注「本地记录」）；若日后上游补了该字段，只要在这条 list.map.prompt 指过去就会自动覆盖。
      endpoints: {
        create: '/v2/videos',
        poll: '/v2/videos/{id}',
        list: '/v2/videos',
        cancel: '/v2/videos/{id}',
        quote: '/v3/videos/quote',
        /* 型号与能力清单（2026-10 实测）：返回该 Key 获授权的已发布模型（base/cinematic/origin）
           与每档 combinations —— 档位、时长区间与默认、分辨率/比例默认、超分与 Turbo 资格。
           形状是 `configurations[]`（数组，一项一档），不是常见的 parameters 对象，
           所以配了 `modelsShape` 让能力层按这个形状归一；**型号清单不再在本地写兜底**
           （平台加一个模型，刷新页面就能看到，页面不用改）。 */
        models: '/v3/models',
        credits: '/v1/credits',
        uploads: '/v1/assets/uploads',
        complete: '/v1/assets/{id}/complete',
      },
      modelsShape: 'vgenvConfigurations',
      /* 每一种素材「收什么文件、单个多大」——接口只给数量（inputs 的 min/max），
         类型与体积上限在文档的「素材输入」一节（2026-10 对照文档写明）：
           图片 JPEG/PNG/WebP，每张 ≤ 5 MiB（不另设总量）
           视频 MP4，≤ 200 MiB，且**必须含音频流**（无音频流创建时 422，静音轨可以）
           音频 MP3/WAV，≤ 50 MiB，单个 Video 最多一条
         为什么写在**平台级**而不是型号级：v13 起型号清单不再本地兜底，按型号写的
         `models[].inputRoles` 已随之删除，而能力接口的形状里根本没有这两条规矩 ——
         没有这一份声明，界面上「收什么文件 / 单个多大」两行会整块消失（真的丢过一次）。
         归一化时并到每一条输入规格上（assetlib 的 NORM_SHAPES.vgenvConfigurations）。 */
      roleRules: {
        reference_image: { accept: 'image/jpeg,image/png,image/webp', maxBytes: 5 * 1024 * 1024 },
        first_frame: { accept: 'image/jpeg,image/png,image/webp', maxBytes: 5 * 1024 * 1024 },
        last_frame: { accept: 'image/jpeg,image/png,image/webp', maxBytes: 5 * 1024 * 1024 },
        reference_video: { accept: 'video/mp4', maxBytes: 200 * 1024 * 1024 },
        reference_audio: { accept: 'audio/mpeg,audio/wav', maxBytes: 50 * 1024 * 1024 },
      },
      /* 型号清单**不在本地写死**：全部来自 GET /v3/models（见上面 endpoints.models）。
         平台按 Key 授权发布什么型号、每一档支持什么组合，都是它说了算 ——
         以前这里硬写一个 `minimax/h3`（连名字都是上游别名，报价时会被映射成 base），
         平台加了 cinematic/origin 我们看不见，删了档位我们还在发。 */
      list: {
        dataField: 'data', cursorField: 'next_cursor', cursorParam: 'cursor', limitParam: 'limit', limit: 100,
        cacheTtl: 8000,
        map: {
          id: 'id', status: 'status', prompt: 'prompt', model: 'model',
          created: 'created_at', completed: 'completed_at',
          outputUrl: 'output.url', expires: 'output.expires_at', duration: 'duration', tier: 'tier',
          res: 'resolution', ar: 'aspect_ratio',
          credits: 'credits', priceMicros: 'price.amount_micros', currency: 'price.currency',
          error: 'error.message',
        },
        statusMap: { succeeded: 'done' },
        media: { fixed: '视频' },
        priceStyle: 'micros',
      },
      create: {
        endpoint: 'create',
        /* 幂等键：**平台自己强烈建议带**（文档 02 节「鉴权与幂等」），以前这里写 false 是因为
           「文档没写支持」—— 那个判断错了，代价是网络抖动时**不但不重试，还不防重复**：
           超时之后我们只能报「结果未知」，用户要么干等要么手动再来一次，而后一次可能是第二份钱。
           带上之后语义是文档写明的两条：同一个 Key + **完全相同**的请求 → 返回第一次那条 Video、
           不重复冻结余额；改了参数还复用同一个 Key → 409 IDEMPOTENCY_KEY_REUSED。
           客户端的两种挂法正好对上：每次调用现生成一个新 UUID（所以参数不同必然 Key 不同），
           自动重试沿用**同一个** Key 和同一个请求体（assetlib 的 Api.request + ui.js 的 Net.fetch）。 */
        idempotencyKey: true,
        /* `creation_intent` 是**请求形状**字段而不是参数：省略 = 普通生成，
           person_replacement = 动作换人（文档 03 节那一行）。
           页面从「输入模式」选中那一档原样递进来（Api.createBody 的标准字段），
           没选换人时它是空串 → 按标准字段的规矩**整个不发**（发 `""` 上游会拒）。
           ⚠ 与之对照：`mode`（t2va / fl2va / ref2va）**不是请求字段** —— 平台按送上来的素材自己推断，
           它只当声明的上下文用，永远不进提交体。 */
        body: { model: 'model', prompt: 'prompt', tier: 'tier', duration: 'duration', resolution: 'res',
          aspect_ratio: 'ar', creation_intent: 'creation_intent' },
        /* 素材输入怎么进请求体 —— 按官方开发文档（vgenv.com/developers/docs）声明。
             未知字段会被拒绝，所以形状必须精确；tmpl 里 $url = DataURL/公网 https 地址，
             $assetId = 先上传成资产再引用。
               reference_images → [{ type:'image_url', image_url:{ url } }]（最多 9 张，与 frame_images 互斥）
               frame_images     → 同上再带 frame_type: first_frame / last_frame（首尾帧是同一个数组里的两条）
               reference_video  → { asset_id }（必须是「已上传并确认、含音频流」的 MP4，否则 422）
               reference_audio  → { asset_id }（已上传并确认的 MP3/WAV）
           以前这里是把 dataURL 直接塞进 reference_video/first_frame_image 之类的字段：
           字段名不存在 + 形状不对，于是报「nested property reference_video must be either object or array」。 */
        inputTemplates: {
          reference_image: { to: 'reference_images', many: true, tmpl: { type: 'image_url', image_url: { url: '$url' } } },
          first_frame: { to: 'frame_images', many: true, tmpl: { type: 'image_url', image_url: { url: '$url' }, frame_type: 'first_frame' } },
          last_frame: { to: 'frame_images', many: true, tmpl: { type: 'image_url', image_url: { url: '$url' }, frame_type: 'last_frame' } },
          reference_video: { to: 'reference_video', many: false, tmpl: { asset_id: '$assetId' }, needsUpload: true, requiresAudio: true },
          reference_audio: { to: 'reference_audio', many: false, tmpl: { asset_id: '$assetId' }, needsUpload: true },
        },
        /* 平台自带的提示词优化（2026-10 实测出来的能力，以前没声明 → 界面上就没有这颗开关）：
             · prompt_optimization 必须是**对象**，mode 只收 `enhance` / `raw`；
               发布尔或字符串上游一律 400（nested property … must be either object or array）。
             · **不传就是 enhance**（报价响应里会回显 prompt_optimization:{mode:"enhance"}），
               所以这一档默认开；想关就发 {mode:"raw"}。
             · 实测两种模式报价相同（300000 micros）—— 这一项在 VGENV 不额外收钱，
               所以声明里不写 priceKey（写了也只会加 0）。
             · **动作换人时这一项不存在**（文档 03 节：换人三个版本均自动分析素材，
               显式发 raw 回 422 PERSON_REPLACEMENT_ANALYSIS_REQUIRED）→ 声明成按形状隐藏，
               界面不画、提交体与报价体一个字都不发（不发 = 平台默认，正是要的结果）。 */
        topBools: {
          prompt_optimization: {
            label: '平台提示词优化',
            hint: '让平台先把提示词改写得更像视频描述再生成；关掉则原样提交（平台默认是开着的）',
            def: true,
            send: { on: { mode: 'enhance' }, off: { mode: 'raw' } },
            hide: { when: { intent: 'person_replacement' } },
            hideNote: '动作换人由平台自动分析素材与人物，没有「关掉提示词优化」这一档（显式关掉会被拒）',
          },
          /* 保留参考视频的原音轨（文档 03 节最后一列）：普通生成默认 false，**换人默认 true**。
             这一项是纯布尔、不带 send 形状，所以提交体里就是 true / false 本身。
             默认值随形状变（def.when）而不是在页面里写一句「选了换人就默认打开」——
             判据只有 topBoolState 一份，界面画的默认、提交发的默认、报价带的默认才是同一个。
             换人关掉它的后果要照文档说清：不保留原音轨，也**不保证**另外生成声音。 */
          preserve_source_audio: {
            label: '保留原视频声音',
            hint: '直接复用参考视频自己的音轨（换人时按动作起点与时长裁剪）；关掉则不保留原音轨，也不保证另外生成声音',
            def: { when: { intent: 'person_replacement' }, then: true, else: false },
          },
          /* Turbo（文档 02 节参数表：默认 false，**需独立授权与运行开放**，对生成费用加收 30%，
             附加超分不加价）。以前这里一句都没有，注释还写着「我们没有这一份授权，发过去直接 500」——
             那句是错的，而且是**双向**错：既少了一个能用的功能，也把原因说成了「没授权」。
             2026-10 实测：/v3/models 给本机这把 Key 列出的组合里大量 turbo 为 true；
             报价接口收 turbo:true，回显 `turbo_requested:true`，金额恰好是同档的 1.3 倍。
             真正的门不在「有没有授权」而在**这一次的那一行**：base 型号那八种素材组合里，
             凡是收参考视频的那几种为 false（quality 档与动作换人照给）；Origin 反倒逐行都给 Turbo
             （它给不了的是超分 —— 48 行的 upscale 全是空）。
             所以这一项声明成 `need:'caps.turbo'` —— 开关跟着那一行长灭，而不是按「这个型号总共有」画。
             不加 priceKey：这是 quote 型定价，加价由报价接口自己算（实测就是 1.3 倍）。 */
          turbo: {
            label: 'Turbo 加速档',
            hint: '平台另一条执行通道，文档写明对生成费用加收 30%（报价会照实算进去）；这一档给不给由平台按素材组合决定',
            def: false,
            need: 'caps.turbo',
            /* 三句话对应三种真原因（判据在 assetlib 的 whyNote，两处共用一份）：
               这一行确实没有 / 这一行还没认出来（素材没放齐）/ 清单还在读。
               以前只有第一句，于是「首尾帧那一档还没放图」也被说成「平台不给 Turbo」，
               而用户该做的事是把素材放上去了。 */
            needNote: '这一次的这一档（画质档 + 手上的素材种类）平台没给 Turbo —— 带参考视频的那几种组合一般不给，换个画质档或换个不带参考视频的组合再试',
            needUnknownNote: '这一档要求的素材还没放齐（或手上这一批的组合平台没列进清单），还看不出给不给 Turbo —— 先把上面写的那几类素材放进来',
            needMissingNote: '还在读平台的能力清单，读完才知道这一档给不给 Turbo',
          },
        },
        /* 「顶层的非布尔字段」这一类（v15 起，判据在 assetlib 的 Capabilities.shapeFieldState 一份）：
           与 topBools 同一种形状 —— 声明了才在高级设置里渲染，值随 params 提交、落在顶层，
           报价按 pricing.body 的映射带上；页面不写一句 `if (平台 === 'vgenv')`。
           三个都是从文档 + 实测各核过一遍的：
             upscale   文档 02 节：普通生成可请求成片 2x，默认 none，**换人不支持**；
                       能力清单把它写在 (tier × 素材组合) 上（enhanced 档与 Origin 全家没有 2x，
                       实测报价对 enhanced+2x 回 422 ENHANCED_UPSCALE_UNAVAILABLE，
                       换人+2x 回 422 PERSON_REPLACEMENT_CONFIGURATION_UNSUPPORTED）。
                       所以取值清单必须来自 `caps.upscale`（那一行给的档），不能是型号总表的并集；
                       「不超分」在上游写成 `upscale:"none"`，它不是一个档位 ——
                       归一化已经把 "none" 剔掉了（NORM_SHAPES 的 isUpLevel），
                       「不超分」这里是界面自己给的一个**空值**选项：空串不进提交体也不进报价体。
             seed      文档 02 节：0–281474976710654，省略时服务端生成并写在 Video 响应里。
                       这两个边界实测过：越界回 400，消息里点名的就是这两个数。
                       留空 = 不发这个字段（不是发 0 —— 发 0 是「固定用种子 0」，两件事）。
             motion_start_seconds
                       文档 02 节 + 03 节：**只有动作换人收**，非负，默认 0，
                       动作与保留音轨共用同一个裁剪窗口；起点 + 时长必须落在源视频内，
                       超出回 MOTION_WINDOW_EXCEEDS_SOURCE。
                       发到普通生成上实测 422 PERSON_REPLACEMENT_INTENT_REQUIRED，
                       所以声明成 `only.when`（只有那一档才画、才发）；
                       上限由**用户那段源视频**决定，平台没有声明一个数，所以这里不编一个 max。 */
        shapeFields: {
          upscale: {
            kind: 'select', label: '成片超分',
            hint: '生成时一并做 2x（文档：支持情况与加价以能力接口和报价为准）；不超分就是平台默认',
            from: 'caps.upscale',
            none: { value: '', label: '不超分（平台默认）' },
            emptyNote: '这一档（画质档 + 手上的素材种类）平台没有给超分',
            unknownNote: '这一档要求的素材还没放齐（或手上这一批的组合平台没列进清单），还看不出能不能超分 —— 先把上面写的那几类素材放进来',
            missingNote: '还在读平台的能力清单，读完才知道这一档能不能超分',
          },
          seed: {
            kind: 'int', label: '随机种子',
            hint: '0–281474976710654；留空 = 平台自己生成（会写在任务详情里，照着它才能复现同一批画面）',
            min: 0, max: 281474976710654,
          },
          motion_start_seconds: {
            kind: 'number', label: '动作起点（秒）',
            hint: '从参考视频的第几秒开始取动作与音轨，默认 0；起点 + 时长必须落在源视频里面，超出会被平台退回',
            min: 0,
            only: { when: { intent: 'person_replacement' },
              why: '只有动作换人收这一项（发到普通生成会被平台拒）' },
          },
        },
        // 上传接口的字段命名（VGENV 用驼峰，SparkCine 是下划线）
        uploadFields: { fileName: 'fileName', contentType: 'contentType', sizeBytes: 'sizeBytes' },
      },
      balance: { style: 'micros' },
    },
    {
      id: 'sparkcine-video', name: 'SparkCine 视频', displayName: 'SparkCine', kind: 'video', relay: '/sparkcine', keyId: 'sparkcine',
      base: 'https://hi.hi.run', keyEnv: 'SPARKCINE_API_KEY', site: 'https://hi.hi.run',
      pricing: { type: 'per_second_table', currency: '积分', endpoint: 'models' },
      /* 与 sparkcine 共用同一个 /models（返回混合清单），这一条只要视频那类 —— 见上面 modelMedia 的说明 */
      modelMedia: '视频',
      endpoints: {
        create: '/api/open/v1/generations',
        poll: '/api/open/v1/generations/{id}',
        list: '/api/open/v1/generations',
        cancel: '/api/open/v1/generations/{id}/cancel',
        credits: '/api/open/v1/wallet',
        models: '/api/open/v1/models',
        // 素材上传（跨平台转存用）：与生图同一套三步上传，客户端统一走 AssetTransfer
        uploads: '/api/open/v1/uploads',
        complete: '/api/open/v1/uploads/{id}/complete',
      },
      /* 型号清单同样**实时获取**（/api/open/v1/models 实测含全部 h3-video-* 型号及其能力）。
         留在这里的唯一一份声明是**输入槽位的上限与分组**（参考音频平台写 max 3，
         而提交模板是单个 {asset_id} 对象，所以按 1）—— 那是提交形状的约束，
         不是「平台支持哪些型号」的兜底。 */
      inputRoles: {
        reference_image: { max: 9, group: 'ref' },
        reference_audio: { max: 1, group: 'ref' },
      },
      // 与 sparkcine 生图同一个上游接口：list 声明保持一致（relay 相同 → 客户端只拉一次）
      list: {
        dataField: 'data', cursorField: 'next_cursor', cursorParam: 'cursor', limitParam: 'limit', limit: 100,
        map: {
          id: 'id', status: 'status', prompt: 'prompt', model: 'model', mode: 'mode',
          created: 'created_at', completed: 'completed_at',
          outputs: 'output_asset_ids', duration: 'parameters.duration',
          res: 'parameters.resolution', ar: 'parameters.aspect_ratio', quality: 'parameters.quality',
          count: 'parameters.output_count', format: 'parameters.output_format', tier: 'tier',
          credits: 'credits', priceMicros: 'price.amount_micros', currency: 'price.currency',
          error: 'error.message',
        },
        statusMap: { succeeded: 'done' },
        media: { by: 'model', videoPrefix: ['h3-'], imagePrefix: ['img-'], fallback: '视频' },
        priceStyle: 'credits',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: true,     // 与生图同一个上游（要求带幂等键）
        body: { model: 'model', prompt: 'prompt' },
        nest: { parameters: [['duration','duration'], ['resolution','res'], ['aspect_ratio','ar'], ['quality','quality'], ['output_count','count'], ['output_format','format'], ['generate_audio','genAudio']] },
        /* 提交体**顶层**的布尔开关（不进 parameters）。以前 optimize_prompt 是写死的 constants: false，
           等于把「让平台自己润色提示词」这个功能焊死在关闭状态，界面上连入口都没有。
           现在按声明给：视频工作台只为声明了这一项的平台渲染那个开关按钮，
           平台没有这一项时按钮根本不出现（页面按 Capabilities 读，不写死平台名）。 */
        topBools: {
          optimize_prompt: { label: '平台自动润色', hint: '提交后由平台侧再优化一遍提示词（第三方润色，与「AI 润色」互不影响）', def: false,
            /* priceKey = 这一项开启后另加多少钱，指向上游定价表里的那个字段
               （上面 /models 的 pricing 里就有 promptOptimizationCredits）。
               声明了就自动进估价与提示文字，页面不写死这个数。 */
            priceKey: 'promptOptimizationCredits' },
        },
        note: '视频生成',
        /* `note` 是这一家**真的收**的顶层字段（导演台把镜头名写进去，方便在平台任务列表里认）。
           声明了这一条，`Api.createBody` 才会把页面递来的 `note` 放进提交体 ——
           VGENV 那一族「未知字段会被拒绝」，不分声明就发等于给必然拒的请求多塞一个字段。
           自定义中转整条克隆模板，所以这一项自动跟着继承。 */
        acceptsNote: true,
        uploadFields: { fileName: 'filename', contentType: 'content_type', sizeBytes: 'byte_length', sha256: 'sha256' },
        /* 素材输入走 inputs 数组：[{ role, asset_id }]，且平台只认自己的资产 id
           （所以每个 role 都要先上传成资产，needsUpload=true）。
           以前这里没有声明，等于平台没声明输入形状 → 工作台会把参考素材静默丢掉。 */
        inputTemplates: {
          reference_image: { to: 'inputs', many: true, tmpl: { role: 'reference_image', asset_id: '$assetId' }, needsUpload: true },
          first_frame: { to: 'inputs', many: true, tmpl: { role: 'first_frame', asset_id: '$assetId' }, needsUpload: true },
          last_frame: { to: 'inputs', many: true, tmpl: { role: 'last_frame', asset_id: '$assetId' }, needsUpload: true },
          reference_video: { to: 'inputs', many: true, tmpl: { role: 'reference_video', asset_id: '$assetId' }, needsUpload: true },
          reference_audio: { to: 'inputs', many: true, tmpl: { role: 'reference_audio', asset_id: '$assetId' }, needsUpload: true },
        },
      },
      balance: { style: 'wallet-credits' },
    },
    {
      /* ---- 语音合成（TTS）示例平台：MiMo V2.5 ----
         接入另一家语音平台时照抄这一条改 relay/base/endpoints 与 tts 声明即可：
           · tts.voices     音色列表（工作台的下拉直接用）
           · tts.formats    输出格式
           · tts.textRole / tts.styleRole   目标文本、风格描述分别放在哪个 role 的消息里
           · tts.responsePath   base64 音频在响应里的路径（用点路径）
           · tts.minChars / tts.maxChars   文本长度上下限（语音台的就绪判定直接读它，页面不写字数）
           · models[].ttsMode   该模型怎么定音色：preset（预设音色）/ design（风格描述必填）/ clone（参考音频必填）
           · create.template   请求体模板，{{字段}} 由工作台填（空值自动省略该项）
           · list 指向本地资产库：同步返回的产物落盘后，资产库就能像读上游一样读到它 */
      id: 'mimo', name: 'MiMo 语音合成', displayName: 'MiMo', kind: 'audio', relay: '/mimo',
      base: 'https://api.xiaomimimo.com', keyEnv: 'MIMO_API_KEY', site: 'https://mimo.mi.com',
      /* 定价：不写死「免费」——按声明动态算。
         per_1k_chars = 按字数计价：模型上声明 price.per1kChars 才显示预估（未声明就明说「平台未提供价格」）。
         以后若平台开放报价接口，改成 { type:'quote', endpoint:'price' } 即可自动走实时报价。 */
      pricing: { type: 'per_1k_chars', currency: '¥' },
      endpoints: {
        create: '/v1/chat/completions',             // OpenAI 兼容：文本放 assistant，音频参数放 audio
        models: '/v1/models',                       // 动态模型列表（工作台的模型下拉直接读它）
        list: 'local:/local-assets',                // 产物落在本地资产库（local: 前缀 = 代理本地端点，不加 relay）
        remove: 'local:/local-assets/{id}',         // 删除本地产物（上游没有资产存储，只能本地删）
      },
      modelsFilter: '-tts',                         // /v1/models 里只取带 -tts 的模型（该接口也返回文本/ASR 模型）
      newModelDefaults: { modes: ['text_to_speech'], ttsMode: 'preset', options: { formats: ['wav', 'pcm16'] } },
      // 想显示预估费用：给型号加 price: { per1kChars: 0.2 }（配合 pricing.type='per_1k_chars'）；
      // 不声明就显示「平台未提供价格」，页面不会自己编价格。
      /* ttsMode 声明「这个型号怎么定音色」，工作台据此显示/校验对应输入：
         preset = 从预设音色下拉选；design = 必填风格/音色描述；clone = 必须上传参考音频。
         ⚠ 这一份**不是型号清单**（v13 起清单归它自己的 /v1/models + 设置页手填）：
         它是「文档里写过这三个 id 各自怎么定音色」的表 —— 三档的输入形态不一样
         （预设 / 描述 / 参考音频），所以不能都拿 provider 级 newModelDefaults 那份 preset 起步；
         接口只给 id 不给能力，能力就从这张表取。用户没在手填框里打过、接口也没列出的 id 不会出现在界面上。 */
      modelDocs: [
        { id: 'mimo-v2.5-tts', name: 'MiMo TTS（预设音色）', modes: ['text_to_speech'], ttsMode: 'preset',
          options: { formats: ['wav', 'pcm16'] } },
        { id: 'mimo-v2.5-tts-voicedesign', name: 'MiMo TTS（音色设计）', modes: ['text_to_speech', 'voice_design'], ttsMode: 'design',
          options: { formats: ['wav', 'pcm16'] } },
        { id: 'mimo-v2.5-tts-voiceclone', name: 'MiMo TTS（音色复刻）', modes: ['text_to_speech', 'voice_clone'], ttsMode: 'clone',
          /* 参考音频槽：语音台的选择器档位、体积校验与「支持 MP3/WAV ≤ 10MB」这句提示都读它，
             页面里不再写死 10MB / 只能选 1 个。 */
          inputRoles: { reference_audio: { max: 1, min: 1, group: 'ref', accept: 'audio/mpeg,audio/wav', maxBytes: 10 * 1024 * 1024 } },
          options: { formats: ['wav', 'pcm16'] } },
      ],
      tts: {
        voices: [
          { id: 'mimo_default', name: '默认音色', lang: '自动', gender: '' },
          { id: '冰糖', name: '冰糖', lang: '中文', gender: '女' },
          { id: '茉莉', name: '茉莉', lang: '中文', gender: '女' },
          { id: '苏打', name: '苏打', lang: '中文', gender: '男' },
          { id: '白桦', name: '白桦', lang: '中文', gender: '男' },
          { id: 'Mia', name: 'Mia', lang: '英文', gender: '女' },
          { id: 'Chloe', name: 'Chloe', lang: '英文', gender: '女' },
          { id: 'Milo', name: 'Milo', lang: '英文', gender: '男' },
          { id: 'Dean', name: 'Dean', lang: '英文', gender: '男' },
        ],
        formats: ['wav', 'pcm16'],
        textRole: 'assistant',
        styleRole: 'user',
        responsePath: 'choices.0.message.audio.data',
        mime: { wav: 'audio/wav', pcm16: 'audio/pcm' },
        maxChars: 5000,
        minChars: 5,        // 太短的文本上游会直接拒（界面据此拦住，别在页面里写死字数）
        sync: true,
      },
      list: {
        dataField: 'data', cursorField: 'next_cursor', cursorParam: 'cursor', limitParam: 'limit', limit: 100,
        map: {
          id: 'id', status: 'status', prompt: 'prompt', model: 'model', voice: 'voice',
          created: 'created_at', duration: 'duration', format: 'format', credits: 'credits',
          chars: 'chars', tokens: 'usage.total_tokens', byteLength: 'byte_length',
          /* 平台任务号：镜像落盘时留在索引里（POST 的 meta.detail.task）。本机这一条的 id 是
             la_xxx —— 那是文件号不是任务号，页面拿它去问提示词归档永远 404，
             「优先用本机文件」时老产物的卡片就一律空着（平台列表只留最近的，那些条目只剩本机这一条）。 */
          taskId: 'detail.task',
        },
        statusMap: { succeeded: 'done' },
        selfAsset: true,            // 列表条目本身就是资产（本地落盘产物）
        /* 大类型按条目自己的 media_type 现判（图片 / 视频 / 音频都可能是本机产物）——
           以前写死 fixed，助手存进资产库的参考图也一律显示成音频类，别的页面按图片筛就挑不到它。 */
        media: { by: 'media_type', videoPrefix: ['视频', 'video'], imagePrefix: ['图片', 'image'], fallback: '音频' },
        priceStyle: 'none',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: false,    // OpenAI 兼容接口没有幂等键约定 → 不带、也不自动重试（TTS 重复请求会重复扣费）
        template: {
          model: '{{model}}',
          messages: [
            { role: '{{styleRole}}', content: '{{style}}' },
            { role: '{{textRole}}', content: '{{text}}' },
          ],
          audio: { format: '{{format}}', voice: '{{voice}}' },
          stream: false,
        },
      },
    },
    {
      /* ---- 文字 AI（OpenAI 兼容）：多家并存，谁在用由页面按 sk_text_prov 选 ----
         文字 AI 以前只有 DeepSeek 一条，基址写死在客户端（sk_base_deepseek）。
         现在每家都是一条正常的 provider：relay / base / keyEnv / models 各自独立，
         新增一家只要在这里加一条，页面、设置页、余额、用量全都不用改。
         default: true = 没显式选过时的首选（客户端还会看它有没有密钥，没有就退到下一家）。 */
      id: 'openrouter', name: 'OpenRouter 文字AI', kind: 'text', relay: '/openrouter', default: true,
      base: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', baseEditable: true,
      site: 'https://openrouter.ai',
      endpoints: {
        chat: '/chat/completions',
        /* 余额：官方文档 GET /api/v1/credits → { data: { total_credits, total_usage } }。
           **只有「管理密钥」能问**（普通 API key 回 403）—— 问不到不等于余额是 0，
           解析见 assetlib.js 的 Api.balance 的 openrouter-credits。 */
        credits: '/credits',
      },
      balance: { style: 'openrouter-credits' },
      /* **这里不声明型号清单** —— 清单归它自己的 GET /api/v1/models（设置页点一次「获取型号列表」，
         拉回来的落进 .data/sk_model_prefs.json，清单与型号下拉都是那一份）。
         下面这段是 `modelDocs`：**不是清单**，只是「文档里写过这个 id、支持什么」的表，
         用户自己在设置页填了这个 id 才用得上（识图判定与自定义供应商的接口形状照它查）。
         为什么非得留这张表：OpenRouter 聚合几百个模型，真要「一份能用的清单」只有它能给，
         而我们写死的任何一份都会过期 —— 用户看到的是「型号就这几个」，然后发现下拉里全不是它们。
         `openrouter/free` **不是模型，是自动路由**（官方说明：Auto-routes to best available free model）——
         它每次随机挑一个免费模型，挑到内容审核分类器就会返回 "User Safety: safe" 这种东西，
         而拆剧本 / 定音色要的是严格 JSON，于是表现为「问一次等 60 秒、回来一段没法解析的东西」。
         所以这张表里只留几个带 `:free` 后缀的**确定**型号：
         同一个 id 每次都是同一个模型，行为可预期，OpenRouter 偶尔下架会直接报错而不是默默换人。
         （免费额度：基础档 50 次/天，充 $10 后 1000 次/天，20 次/分钟。） */
      modelDocs: [
        { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3（免费·通用与 JSON 都行）', modes: ['text'] },
        { id: 'qwen/qwen3-235b-a22b:free', name: 'Qwen3 235B（免费·中文更稳）', modes: ['text'] },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', modes: ['text'], vision: true },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', modes: ['text'], vision: true },
        { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', modes: ['text'], vision: true },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', modes: ['text'] },
      ],
    },
    {
      id: 'deepseek', name: 'DeepSeek 文字AI', kind: 'text', relay: '/textai',
      base: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', baseEditable: true,
      site: 'https://platform.deepseek.com',
      endpoints: {
        chat: '/chat/completions',
        /* 余额：官方文档 GET /user/balance → { is_available, balance_infos:[{ currency, total_balance, … }] }。
           total_balance 是**字符串**，解析见 assetlib.js 的 Api.balance 的 deepseek-balance。 */
        credits: '/user/balance',
      },
      balance: { style: 'deepseek-balance' },
      modelDocs: [
        { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', modes: ['text'] },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', modes: ['text'] },
      ],
    },
    /* ---- 下面这一组：OpenAI 兼容的文字供应方 ----
       为什么能一口气加这么多：它们**全都只提供** POST {base}/chat/completions 与 GET {base}/models，
       请求体与响应体都和 OpenAI 一样（流式、tools、vision 的字段名也一致）。
       所以端点、请求体形状、能力判定全部照上面那家 OpenRouter 走，只有地址、密钥变量与型号不同。
       **型号一条都不写死**：这些平台改型号非常频繁，写死的清单会立刻过期（用户会以为型号是固定的）。
       型号清单一律来自它自己的 GET {base}/models —— 设置页点一次「获取型号列表」就取回全量，
       取回的落进 .data/sk_model_prefs.json，设置页那张清单、型号下拉、AI 助手的下拉都从那一份派生。
       下面那一行 `modelDocs` 是**「文档里写过这个 id 支持什么」**，不是清单：
       用户自己填了这个 id 才用得上（识图判定照它查）。它不参与任何「型号有哪些」的判断。 */
    {
      id: 'openai', name: 'OpenAI 文字AI', kind: 'text', relay: '/textai',
      base: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', baseEditable: true,
      site: 'https://platform.openai.com',
      endpoints: { chat: '/chat/completions' },
      /* OpenAI 没有公开的余额 API（/dashboard/billing 要网页登录态，API key 问不了）—— 不声明，
         设置页照样画出「侧栏余额」勾选框并写明「这家没提供余额接口」。 */
      modelDocs: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini', modes: ['text'], vision: true }],
    },
    {
      id: 'moonshot', name: '月之暗面 Kimi', kind: 'text', relay: '/textai',
      base: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY', baseEditable: true,
      site: 'https://platform.moonshot.cn',
      endpoints: {
        chat: '/chat/completions',
        /* 官方文档 GET /v1/users/me/balance → { code, data: { available_balance, voucher_balance, cash_balance } }
           单位是**人民币元**；available ≤ 0 时平台直接拒绝推理。 */
        credits: '/users/me/balance',
      },
      balance: { style: 'moonshot-balance' },
      modelDocs: [{ id: 'kimi-k2.6', name: 'Kimi K2.6', modes: ['text'] }],
    },
    {
      id: 'zhipu', name: '智谱 GLM', kind: 'text', relay: '/textai',
      base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPUAI_API_KEY', baseEditable: true,
      site: 'https://open.bigmodel.cn',
      endpoints: { chat: '/chat/completions' },
      modelDocs: [{ id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', modes: ['text'] }],
    },
    {
      id: 'dashscope', name: '通义千问 百炼', kind: 'text', relay: '/textai',
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY', baseEditable: true,
      site: 'https://bailian.console.aliyun.com',
      endpoints: { chat: '/chat/completions' },
      modelDocs: [{ id: 'qwen3.6-flash', name: 'Qwen3.6 Flash', modes: ['text'] }],
    },
    {
      id: 'siliconflow', name: '硅基流动 SiliconFlow', kind: 'text', relay: '/textai',
      base: 'https://api.siliconflow.cn/v1', keyEnv: 'SILICONFLOW_API_KEY', baseEditable: true,
      site: 'https://cloud.siliconflow.cn',
      endpoints: { chat: '/chat/completions' },
      /* 硅基流动一个 key 覆盖 200+ 模型（DeepSeek / Qwen / GLM / MiniMax 都有），
         型号名是「厂商/型号」带斜杠的那种 —— 写死一份清单只会过期得更快。 */
      modelDocs: [{ id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', modes: ['text'] }],
    },
    {
      id: 'volcengine', name: '火山方舟 豆包', kind: 'text', relay: '/textai',
      base: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ARK_API_KEY', baseEditable: true,
      site: 'https://console.volcengine.com/ark',
      endpoints: { chat: '/chat/completions' },
      modelDocs: [{ id: 'doubao-seed-1-6-251015', name: '豆包 Seed 1.6', modes: ['text'] }],
    },
    {
      id: 'minimax-text', name: 'MiniMax 文字AI', kind: 'text', relay: '/textai', keyId: 'minimax',
      base: 'https://api.minimax.io/v1', keyEnv: 'MINIMAX_API_KEY', baseEditable: true,
      site: 'https://platform.minimax.io',
      endpoints: { chat: '/chat/completions' },
      modelDocs: [{ id: 'MiniMax-M3', name: 'MiniMax M3', modes: ['text'] }],
    },
    {
      /* ---- 图片：OpenAI 兼容的 images/generations（**同步返回，没有任务号**）----
         这一类接口（OpenAI 自己、硅基流动、大批中转站）形状都一样：
         POST {base}/images/generations { model, prompt, n, size|image_size, … }
           → 当场返回 { created, data: [ { url | b64_json } ] }。
         声明方式：create.sync 说清产物数组在哪、url / b64 字段叫什么；
         页面照声明把字节取回来存进本机资产库（外链一般**只有 1 小时有效**，
         直接把外链摆进列表，明天打开就是一排裂图），然后刷列表。
         跟 sparkcine 那类「建任务 → 轮询」的平台并存：create.sync 有没有决定走哪条，
         页面里没有 if (prov.id === …)。以后再接同形状的平台（OpenAI / 豆包兼容网关 / 各家中转）
         只要复制这一条换 base 与型号。 */
      id: 'siliconflow-image', name: '硅基流动 生图', displayName: 'SiliconFlow', kind: 'image',
      relay: '/siliconflow', keyId: 'siliconflow',   // 与上面那家文字共用一把密钥 → 设置页只出一张卡
      base: 'https://api.siliconflow.cn/v1', keyEnv: 'SILICONFLOW_API_KEY', site: 'https://cloud.siliconflow.cn',
      endpoints: {
        create: '/images/generations',
        list: 'local:/local-assets',               // 上游不留任务记录（同步返回也没有任务号），产物落本机资产库
        remove: 'local:/local-assets/{id}',        // 删除本地产物
      },
      create: {
        endpoint: 'create',
        idempotencyKey: false,                     // 这套接口没有幂等键约定 → 不带、也不自动重试（重试 = 重复扣费）
        sync: { items: 'data', url: 'url', b64: 'b64_json' },
        /* size = 「宽x高」那一类画幅参数（页面新增的「尺寸」列就渲染 options.sizes）。
           比例写法（16:9）发过去必被拒，所以映射的是 size 而不是 ar。
           注意 body 的方向：**键是上游字段名、值是标准字段名**（createBody 按 body[上游] = std[标准] 取值，
           nest 的 [上游, 标准] 成对写是同一个方向；写反了字段会被静默丢掉 —— 请求照发，参数一个没带上）。 */
        body: { model: 'model', prompt: 'prompt', image_size: 'size', n: 'count', output_format: 'format' },
      },
      list: {
        dataField: 'data',
        map: { id: 'id', status: 'status', prompt: 'prompt', model: 'model', created: 'created_at', format: 'format',
          taskId: 'detail.task' },        // 平台任务号留底，判据见上面 MiMo 那条的注释
        statusMap: { succeeded: 'done' },
        selfAsset: true,                            // 条目本身就是本机产物
        media: { by: 'media_type', imagePrefix: ['图片', 'image'], videoPrefix: ['视频', 'video'], fallback: '图片' },
        priceStyle: 'none',
      },
      /* ⚠ 这一份**不是型号清单**（v13 起）：这一家没在本项目里声明型号接口，
         界面上一个型号都不会出现，直到用户在设置页那张卡里自己填 id（或添加成自定义供应商）。
         这里只留「官方文档写过这两个 id 的 image_size 认哪些值」：
         image_size 只认清单里的值，下拉里写错一项 = 「选了必失败」，所以填了这两个 id 时能力照这份表取。
         平台还有 160+ 图像型号，填表外的 id 时参数面板会是空的并写明「没有能力声明」——
         那是真话，比替它编一档尺寸诚实。 */
      modelDocs: [
        { id: 'Kwai-Kolors/Kolors', name: 'Kolors（中文理解好）', modes: ['text_to_image'],
          options: { sizes: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'], max_outputs: 4 } },
        { id: 'black-forest-labs/FLUX.2-pro', name: 'FLUX.2 pro', modes: ['text_to_image'],
          options: { sizes: ['512x512', '768x1024', '1024x768', '576x1024', '1024x576'],
            output_formats: ['png', 'jpeg'], max_outputs: 1 } },
      ],
    },
    {
      /* ---- 语音：MiniMax t2a_v2（同步返回；音频是**十六进制**不是 base64）----
         沿用 mimo 那套 tts 声明（template + responsePath + 存本机），只多一个 encoding:'hex'：
         官方文档写 data.audio 是十六进制（WebSocket 指南明确说「用十六进制解码，别当 base64」），
         而 /local-assets 收的是 base64，页面按这份声明转换（认不出合法十六进制时退回按 base64 试一次）。
         一家平台同时做文字与语音时给两条 provider 同一个 keyId → 设置页只出一张密钥卡。 */
      id: 'minimax-tts', name: 'MiniMax 语音合成', displayName: 'MiniMax', kind: 'audio', relay: '/minimax', keyId: 'minimax',
      base: 'https://api.minimax.io/v1', keyEnv: 'MINIMAX_API_KEY', site: 'https://platform.minimax.io',
      pricing: { type: 'per_1k_chars', currency: '¥' },
      endpoints: {
        create: '/t2a_v2',                          // POST {model, text, stream:false, voice_setting, audio_setting}
        list: 'local:/local-assets',
        remove: 'local:/local-assets/{id}',
      },
      /* v13 起这里**没有型号清单**：这一家的 GET /v1/models 列的是对话模型（MiniMax-M3 那一批，
         与上面视频那条同一个事实），没有 t2a 型号可问 —— 所以型号来自设置页手填。
         这四项的差别只在 id（高清 / 快速 / 版本）， modes、ttsMode、格式取值完全一样，
         所以不再留一份 per-id 的表，只在 provider 级点一次名：手填进来的任何一个 id 都照这一份起步。
         （要真给某个 id 单独声明能力，就照 mimo 那样加一段 modelDocs，别在这里加清单。） */
      newModelDefaults: { modes: ['text_to_speech'], ttsMode: 'preset', options: { formats: ['mp3', 'wav', 'pcm', 'flac'] } },
      tts: {
        /* 系统音色：只列几个常用兜底，完整目录在平台控制台（那边能试听）。
           这里不编不存在的音色 id —— 填一个平台没有的 id，上游会直接拒。 */
        voices: [
          { id: 'male-qn-qingse', name: '青涩青年（男）', lang: '中文', gender: '男' },
          { id: 'female-shaonv', name: '少女（女）', lang: '中文', gender: '女' },
          { id: 'presenter_male', name: '男性主播', lang: '中文', gender: '男' },
          { id: 'presenter_female', name: '女性主播', lang: '中文', gender: '女' },
          { id: 'audiobook_male_1', name: '有声书男声', lang: '中文', gender: '男' },
          { id: 'English_expressive_narrator', name: '英文旁白', lang: '英文', gender: '男' },
        ],
        formats: ['mp3', 'wav', 'pcm', 'flac'],
        mime: { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', flac: 'audio/flac' },
        responsePath: 'data.audio',
        encoding: 'hex',          // 声明式：页面据此把十六进制转成 base64 再存
        maxChars: 10000,          // 官方写死「单次不超过 10000 字」，界面据此拦（页面不写死字数）
        minChars: 1,
        sync: true,
      },
      list: {
        dataField: 'data',
        map: { id: 'id', status: 'status', prompt: 'prompt', model: 'model', created: 'created_at',
          duration: 'extra_info.audio_duration', format: 'format', chars: 'extra_info.usage_characters',
          taskId: 'detail.task' },        // 平台任务号留底，判据见上面 MiMo 那条的注释
        statusMap: { succeeded: 'done' },
        selfAsset: true,
        media: { by: 'media_type', videoPrefix: ['视频', 'video'], imagePrefix: ['图片', 'image'], fallback: '音频' },
        priceStyle: 'none',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: false,     // 没有幂等键约定 → 不自动重试（TTS 重试 = 重复扣费）
        template: {
          model: '{{model}}', text: '{{text}}', stream: false,
          voice_setting: { voice_id: '{{voice}}', speed: 1, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: '{{format}}' },
        },
      },
    },
    {
      /* ---- 视频：MiniMax（H3）—— 官方现行协议是 **v2** ----
         2026-10 按官方文档改接 v2（原来接的是 v1 的 Video-01/Hailuo 一代）：
           POST /v2/video_generation      { model, content:[ {type, …, role} ], duration, resolution, ratio }
           GET  /v2/query/video_generation/{task_id}   ← **路径参数**（v1 是 ?task_id=）
                → { task: { status: queued|Preparing|processing|succeeded|failed|cancelled,
                            content: { url }, error } }
           成功**直接给地址**（task.content.url），v1 那个 file_id → /files/retrieve 环节在 v2 不存在。
         content[] 那一族才是多模态的正规写法：文本一项 + 图片/视频/音频项（带 role 首帧/尾帧/参考图…），
         所以 inputTemplates 的落点是 content 数组，不是 v1 的 first_frame_image 标量。
         上游只给单任务查询、没有列表接口 → 不声明 endpoints.list（资产库里来自这条线的条目
         是任务完成时自动落到本机的产物，见 studio 的本地镜像）。 */
      id: 'minimax-video', name: 'MiniMax 视频', displayName: 'MiniMax', kind: 'video', relay: '/minimax', keyId: 'minimax',
      base: 'https://api.minimax.io/v1', keyEnv: 'MINIMAX_API_KEY', site: 'https://platform.minimax.io',
      pricing: { type: 'quote', currency: '¥' },
      noPromptField: true,     // query 响应不返回提示词（界面靠 PromptLog 归档的那份补显示）
      endpoints: {
        create: '/video_generation',                    // POST /v2 形状（见下面 create）
        poll: '/query/video_generation/{id}',          // GET，任务号是**路径参数**
      },
      list: {
        map: {
          /* v2 的查询响应整体裹在 task 里：{ task: { status, content:{url}, error } } */
          id: 'task_id', status: 'task.status', prompt: 'prompt', model: 'model',
          created: 'create_time', outputUrl: 'task.content.url', error: 'task.error',
        },
        statusMap: { succeeded: 'done', failed: 'failed', cancelled: 'failed' },
        media: { fixed: '视频' },
        priceStyle: 'none',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: false,     // 没有幂等键约定 → 不自动重试（重试 = 重复扣费）
        /* v2 的 prompt 是 content[] 里的一项（type:text），不是一个平铺字段 —— body 里不放 prompt。 */
        body: { model: 'model', duration: 'duration', resolution: 'res', ar: 'ratio' },
        inputTemplates: {
          first_frame: { to: 'content', many: false, tmpl: { type: 'image_url', image_url: { url: '$url' }, role: 'first_frame' } },
          last_frame: { to: 'content', many: false, tmpl: { type: 'image_url', image_url: { url: '$url' }, role: 'last_frame' } },
          reference_image: { to: 'content', many: true, tmpl: { type: 'image_url', image_url: { url: '$url' }, role: 'reference_image' } },
          reference_video: { to: 'content', many: true, tmpl: { type: 'video_url', video_url: { url: '$url' }, role: 'reference_video' } },
          reference_audio: { to: 'content', many: true, tmpl: { type: 'audio_url', audio_url: { url: '$url' }, role: 'reference_audio' } },
        },
        /* v2 的 content[] 必须**第一项是 text**：把提示词按本地字段拼进去，
           不写在 body 里（上游不接受平铺的 prompt 字段）。 */
        textItem: { to: 'content', key: 'prompt', type: 'text' },
      },
      /* ⚠ 这一份**不是型号清单**（v13 起）：MiniMax 的 GET /v1/models 列的是**对话**模型
         （MiniMax-M3 / M2.7 / M2.5 那一批），里面没有视频型号 —— 接上去只会让视频台下拉变成一堆聊天模型，
         所以这一家既没有现取的路，也不自动列型号：型号来自设置页手填。
         这里留的是「文档写过 H3 这一档认哪些输入角色与取值」（首尾帧 / 参考图 9 张 / 参考视频 / 参考音频、
         分辨率与时长档位）：手填 `MiniMax-H3` 时能力照这份取，填别的 id 时参数面板为空并照实说明。 */
      modelDocs: [
        { id: 'MiniMax-H3', name: 'MiniMax H3', modes: ['text_to_video', 'first_last_frame', 'reference_images', 'reference_video', 'reference_audio'],
          inputRoles: {
            first_frame: { max: 1, group: 'frame' }, last_frame: { max: 1, group: 'frame' },
            reference_image: { max: 9, group: 'ref' },
            reference_video: { max: 1, group: 'ref', accept: 'video/mp4', maxBytes: 200 * 1024 * 1024 },
            reference_audio: { max: 1, group: 'ref', accept: 'audio/mpeg,audio/wav', maxBytes: 50 * 1024 * 1024 },
          },
          options: { durations: [4, 15], resolutions: ['768p', '1080p', '2K'], aspect_ratios: ['16:9', '9:16', '21:9', '4:3', '1:1', '3:4', '4:5'] } },
      ],
    },
    {
      /* ---- 视频：SiliconFlow —— 产物地址直给，但**只有 10 分钟有效期** ----
         正好是「自动把产物存到本机」要解决的那一族：不做本地镜像的话，
         明天打开资产库就是一排裂图，而条目本身还显示「已完成」。
         声明里不写 expires（平台没给过期时间），由本机镜像那一层按「存过就用本地的」兜住。 */
      id: 'siliconflow-video', name: '硅基流动 视频', displayName: 'SiliconFlow', kind: 'video',
      relay: '/siliconflow', keyId: 'siliconflow',
      base: 'https://api.siliconflow.cn/v1', keyEnv: 'SILICONFLOW_API_KEY', site: 'https://cloud.siliconflow.cn',
      pricing: { type: 'quote', currency: '¥' },
      noPromptField: true,
      endpoints: {
        create: '/video/submit',                   // POST {model, prompt, image?, image_size?} → {requestId}
        poll: '/video/status?requestId={id}',     // GET → {status, results:{videos:[{url}]}}
      },
      list: {
        map: {
          id: 'requestId', status: 'status', prompt: 'prompt', model: 'model',
          outputUrl: 'results.videos.0.url', error: 'message',
        },
        statusMap: { Succeed: 'done', Failed: 'failed' },
        media: { fixed: '视频' },
        priceStyle: 'none',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: false,
        /* image_size 只认清单里的尺寸，比例写法会被拒 → 映射标准字段 size（页面那一列是能力声明出来的）。 */
        body: { model: 'model', prompt: 'prompt', image_size: 'size' },
        inputTemplates: { first_frame: { to: 'image', many: false, tmpl: '$url' } },
      },
      /* ⚠ 这一份**不是型号清单**（v13 起）：这一家没在本项目里声明型号接口，
         界面上的型号来自设置页手填；这里只是「文档写过这两个 id 各自认什么」——
         文生视频与图生视频的 modes / 首帧槽位不一样，混成一份就会出现「界面让填首帧、上游不收」，
         所以按 id 各留一条，而不是给一个 provider 级兜底。 */
      modelDocs: [
        { id: 'Wan-AI/Wan2.1-T2V-14B-720P', name: 'Wan2.1 文生视频 14B 720P', modes: ['text_to_video'],
          options: { sizes: ['1280x720', '720x1280', '960x960'], defaults: { size: '1280x720' } } },
        { id: 'Wan-AI/Wan2.1-I2V-14B-720P', name: 'Wan2.1 图生视频 14B 720P', modes: ['first_last_frame'],
          inputRoles: { first_frame: { max: 1, group: 'frame' } },
          options: { sizes: ['1280x720', '720x1280', '960x960'], defaults: { size: '1280x720' } } },
      ],
    },
    {
      /* ---- 视频：智谱 GLM（CogVideoX）—— 「异步结果」接口那一族 ----
         创建回 {id}，状态在 /async-result/{id}，产物是 video_result 数组里的地址。
         形状与上面两家不同（结果在单独数组里、状态是 PROCESSING/SUCCESS/FAIL），
         字段全按声明取，页面没有 if (prov.id === …)。 */
      id: 'zhipu-video', name: '智谱 CogVideoX 视频', displayName: '智谱 GLM', kind: 'video', relay: '/zhipu',
      base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY', site: 'https://open.bigmodel.cn',
      pricing: { type: 'quote', currency: '¥' },
      noPromptField: true,
      endpoints: {
        create: '/videos/generations',      // POST {model, prompt, quality?} → {id}
        poll: '/async-result/{id}',         // GET → {model, status, video_result:[{url}]}
      },
      list: {
        map: {
          /* ⚠ 官方字段是 **task_status**（PROCESSING / SUCCESS / FAIL），没有 `status`。
             以前这里写成 'status'，取到空串 → classifyStatus 按「没给状态 = 还不知道」
             一直等 —— 于是任务提交成功、轮询永远转圈、永远不收敛。
             （下面 statusMap 映射的正是 task_status 的值，说明当初就是笔误。） */
          id: 'id', status: 'task_status', prompt: 'prompt', model: 'model',
          outputUrl: 'video_result.0.url', error: 'error.message',
        },
        statusMap: { SUCCESS: 'done', FAIL: 'failed' },
        media: { fixed: '视频' },
        priceStyle: 'none',
      },
      create: {
        endpoint: 'create',
        idempotencyKey: false,
        /* `size` 才是这一族的画幅字段（官方枚举 1280x720 / 1920x1080 / …，没有 resolution）。
           以前只映射 model/prompt：界面上「画质」下拉画得出来、选了也**根本没发出去**，
           上游一律按默认出片 —— 界面说了一套、系统做了另一套。
           ⚠ `quality`（官方 speed|quality）不能直接映射我们的 `tier`（fast|standard|enhanced|quality）：
           值集对不上，上游会拒。所以下面把这一家的档位**声明成它自己的值集**，
           界面上那一列显示的就是 speed / quality，映射过去才对得上。 */
        body: { model: 'model', prompt: 'prompt', size: 'size', quality: 'tier', duration: 'duration' },
      },
      /* ⚠ 这一份**不是型号清单**（v13 起）：智谱的 GET /api/paas/v4/models 列的是 glm-4.5 / glm-5
         那一批**对话**模型，不含 cogvideox —— 接上去视频台会变成聊天模型下拉。
         所以这一家的型号也来自设置页手填，这里只按 id 留「文档写过它认什么」：
         3 代能吃首尾帧、2 代只有文生视频，合成一份就会出现「界面让填末帧、上游不收」。 */
      modelDocs: [
        { id: 'cogvideox-3', name: 'CogVideoX-3', modes: ['text_to_video', 'first_last_frame'],
          inputRoles: { first_frame: { max: 1, group: 'frame' }, last_frame: { max: 1, group: 'frame' } },
          options: { tiers: ['speed', 'quality'], sizes: ['1280x720', '720x1280', '1920x1080', '1080x1920'],
            durations: [5, 10], bools: { with_audio: { def: false } },
            defaults: { tier: 'speed', size: '1920x1080', duration: 5 } } },
        { id: 'cogvideox-2', name: 'CogVideoX-2', modes: ['text_to_video'],
          options: { tiers: ['speed', 'quality'], sizes: ['1280x720', '720x1280', '1920x1080', '1080x1920'],
            durations: [5, 10], bools: { with_audio: { def: false } },
            defaults: { tier: 'speed', size: '1920x1080', duration: 5 } } },
      ],
    },
  ],
};

/* ============================================================================
   用户在设置页「添加自定义供应商」时登记的接口（图片 / 视频 / 语音 / 文字 AI）
   ----------------------------------------------------------------------------
   为什么大多不需要改代码：市面上大量的中转站 / 企业网关跑的就是这里已经支持的那套接口，
   只是**换一个地址、换一把密钥、型号清单不一样**。所以「添加一家」= 拿一条内置声明当
   **接口形状模板**，只替换 id / 名称 / 地址 / 型号；endpoints、create、list、balance、
   uploadFields 全照模板走，页面完全不知道「这一家是新加的」。
   接口形状真不一样（另一套任务与字段命名）的平台仍然要改上面的 REGISTRY —— 这里不猜、不编字段。

   文字 AI 走的是同一条路，不是另一套机制：`TextAI.all()` 现读**合并后**注册表里 `kind:'text'`
   的那几条，所以加一家自定义文字供应方之后，设置页那个下拉、润色、识图、用量都自动多一项。

   清单从哪来：设置页把表单写进 localStorage 的 `sk_custom`（一份 JSON 数组），
   ui.js 的 DataSync 顺手镜像成 `.data/sk_custom.json` —— 这一节读的就是那个文件。
   于是自定义平台自动跟着数据文件走（换机器、云同步、整包备份都不用另外登记一次）。
   条目形状：`{ id, name, kind, shape:<内置 provider id>, base:<https 地址>, models:[{id,name}] }`

   安全三条（动这里之前先读）：
   1. **地址只收公网 https**：过 safeOutboundUrl，回环 / 内网 / 明文 http / 解析到内网的域名
      一律丢掉整条并说明原因 —— 这一条路由会把浏览器递来的密钥转发出去。
   2. **绝不回退到 .env 里的内置密钥**：这一家的 base 是用户自己填的陌生主机，
      代理要是把 SPARKCINE_API_KEY 投过去，等于把内置密钥送到别人的服务器。
      所以建出来的 provider 摘掉 keyEnv / defaultKey，转发时也不查 DEFAULTS（见 relayHit 那段）。
   3. relay 前缀固定 `/custom/<id>`，和内置平台一样只接受同源请求（见 RELAY_PREFIXES）。
   ========================================================================== */
const CUSTOM_RELAY = '/custom';
/* **不设家数上限**（v11 起）。以前是 12 家，理由是「加十几家足够了，顺便封掉刷爆注册表的写法」——
   但它把两件正经事也堵死了：① 内置平台现在也要先「添加」一次才进设置页的供应商清单，
   常用平台都接一遍就撞上限；② 用户要接十几个中转站是真的会发生的（一个网关一套协议）。
   清单是**本机**文件、每条都要过一次下面的 customProblem（公网 https / 型号齐全 / 不撞别家），
   刷不爆什么，所以这一层闸撤掉，只留下面那些真判据。 */
const CUSTOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,40}$/;
/* 内置声明里不能跟着用户走的那几项：身份、地址、密钥来源，以及「同一上游按媒体类型落到
   另一条内置 provider」的路由（mediaProviders 里写的是内置 id，自定义条目套上去会指错家）。
   pricing 也摘：单价是各家自己的事，照抄内置那一份会报出假价格（用量与预估都不该骗人）。 */
const CUSTOM_STRIP = ['id', 'keyId', 'relay', 'base', 'keyEnv', 'defaultKey', 'site',
  'name', 'displayName', 'kind', 'models', 'mediaProviders', 'pricing', 'custom', 'customShape',
  /* default：内置「没显式选过时首选哪家」的旗标不能跟着复制 —— 照 OpenRouter 克隆一家，
     表现就成了「凭空多了一家默认」，润色打到用户的网关上。
     baseEditable：这一家的地址本来就是用户自己填的（就在 sk_custom 里），
     没有「官方地址 + 临时覆盖」这回事。摘掉它，代理也就**不接受**这条 relay 上的 x-up-base 头
     —— 否则浏览器递一个头就能把密钥改道送到别的主机。 */
  'default', 'baseEditable'];

const customNotice = { reason: '', dropped: [] };    // 最近一次读清单时丢掉的问题条目，/registry 带回去说明
/* 缓存要连着 notice 一起存：以前只缓存了 provs，而 customNotice 是在**进函数时就清空**的，
   于是命中缓存的那一次（/registry 被连着问两次就是它）报回去的是「没有坏条目」——
   页面那句「有 N 条自定义平台没被本地代理认」会莫名消失，而坏条目其实还在清单里。
   缓存键除了 mtime 还要带 **size**：同一毫秒里连着写两遍（一次添加连着触发两次读注册表就是这个情形）
   可能拿到同一个 mtime，于是新加的那一家读不出来 —— 表现是「我明明添加了，下拉里没有」。
   长度不同就不是同一份文件；长度与 mtime 都一样，那它本来就是同一份，命中无害。 */
let _customCache = { file: '', mtime: 0, size: -1, provs: [], reason: '', dropped: [] };
function customProviders() {
  const file = dataFileOf('sk_custom');
  let mtime = 0, size = -1;
  try { const st = fs.statSync(file); mtime = st.mtimeMs; size = st.size; } catch { mtime = 0; }
  if (_customCache.file === file && _customCache.mtime === mtime && _customCache.size === size) {
    customNotice.reason = _customCache.reason;
    customNotice.dropped = _customCache.dropped;
    return _customCache.provs;
  }
  customNotice.reason = ''; customNotice.dropped = [];
  if (!mtime) { _customCache = { file, mtime: 0, size, provs: [], reason: '', dropped: [] }; return []; }
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    customNotice.reason = '读取 .data/sk_custom.json 失败：' + e.message;
    _customCache = { file, mtime, size, provs: [], reason: customNotice.reason, dropped: [] };
    return [];
  }
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.data) ? raw.data : []);
  const out = [];
  /* 四种类型都能当模板（文字 AI 也算一类）。旧的清单里如果有拿文字平台当形状的条目，
     以前是「找不到模板」被丢掉并说明；现在它合法了，不必再让页面重新添加一次。 */
  const builtins = REGISTRY.providers;
  /* **不数家数上限**（v11 起，见上面「不设家数上限」那段）。坏条目照旧一条条说明为什么被丢掉，
     但前面有坏条目不再占位置，也不再有「第 N+1 家」这种与真问题无关的拒绝原因。 */
  list.forEach(e => {
    const id = String((e && e.id) || '').slice(0, 44);
    const bad = customProblem(e, builtins, out);
    if (bad) { customNotice.dropped.push({ id, why: bad }); return; }
    out.push(buildCustom(e, builtins.find(p => p.id === e.shape)));
  });
  _customCache = { file, mtime, size, provs: out, reason: customNotice.reason, dropped: customNotice.dropped };
  return out;
}
/* 一条自定义条目能不能用；能用返回 ''，不能用返回「为什么不能用」（界面与日志同一句话） */
function customProblem(e, builtins, already) {
  if (!e || typeof e !== 'object') return '不是对象';
  if (!CUSTOM_ID_RE.test(String(e.id || ''))) return 'id 只能是字母数字与 -_（1~41 位）';
  if (already.some(x => x.id === e.id)) return 'id 重复';
  if (builtins.some(p => p.id === e.id)) return 'id 和内置平台撞名';
  if (!builtins.some(p => p.id === e.shape)) return '找不到当模板的内置平台（shape）';
  /* 条目自己声明的类型要和模板的类型一致：不一致就是清单被手改过（或页面改过类型后留下的旧条目）。
     照模板的 kind 建出来，界面按 e.kind 分组、按模板的 kind 使用，两边对不上就是「加了但找不到」。 */
  if (e.kind && (builtins.find(p => p.id === e.shape) || {}).kind !== e.kind) {
    return '类型「' + e.kind + '」与模板「' + e.shape + '」不是同一类';
  }
  if (!/^https:\/\//i.test(String(e.base || ''))) return '地址必须以 https:// 开头';
  if (!safeOutboundUrl(String(e.base || ''))) return '地址不是公网 https（回环 / 内网 / 域名解析到内网都拒绝）';
  if (!Array.isArray(e.models) || !e.models.length) return '一个型号都没勾';
  /* 地址撞**别的**内置平台官方地址 = 拿 A 家的地址配 B 家的协议（设置页表单也拦这一种）。
     注意**不再**把「撞模板自己的官方地址」当错：v11 起内置平台也要先添加一次才进设置页清单，
     那个官方地址正是设置页自动填进去的默认值，照它添加就是「我要用这一家」。
     模板自己那个 host 要排除掉 —— 同一个上游往往有好几条内置 id（按媒体类型分的），
     它们彼此不算「撞」。 */
  const tpl = builtins.find(p => p.id === e.shape) || {};
  const other = builtins.find(p => p.base && !sameHost(p.base, tpl.base) && sameHost(e.base, p.base));
  if (other) {
    return '这个地址是「' + (other.name || other.id) + '」的官方地址，却配着「'
      + (tpl.name || tpl.id) + '」的接口形状 —— 选它自己、填密钥就能用，不用添加一遍';
  }
  return '';
}
/* 只比 host：路径不同（/v1 与 /api/v1）仍然是同一个上游，两个名字两把密钥照样说不清。 */
function sameHost(a, b) {
  const h = v => { try { return new URL(/^https?:\/\//i.test(String(v || '')) ? String(v) : 'https://' + v).host.toLowerCase(); } catch { return ''; } };
  const x = h(a), y = h(b);
  return !!x && !!y && x === y;
}
function buildCustom(e, tpl) {
  const p = {};
  Object.entries(tpl).forEach(([k, v]) => { if (!CUSTOM_STRIP.includes(k)) p[k] = v; });
  p.id = String(e.id);
  p.keyId = p.id;                                   // 密钥按这一家自己存：sk_key_<id>
  p.relay = CUSTOM_RELAY + '/' + p.id;
  p.base = safeOutboundUrl(String(e.base)).replace(/\/+$/, '');
  p.name = String(e.name || p.id).slice(0, 40);
  p.displayName = p.name;
  p.kind = tpl.kind;
  p.custom = true;
  p.customShape = tpl.id;
  p.customShapeName = tpl.displayName || tpl.name;
  /* 型号：id 在模板里出现过 → 用模板那份完整声明（只换显示名）；
     没出现过（这一家自己多出来的型号）→ 能力先照模板第一个型号起步，等它自己的 /models 覆盖。
     为什么要给个起步：档位全空的型号在工作台里既选不了比例也选不了画质，看着像坏了。 */
  /* 模板能给的能力参照物 = 模板自己的清单（v13 起多半是空的）+ 那份按 id 写的 modelDocs。
     前者归接口，后者归文档，两者都不是「替你决定这一家有什么型号」—— 用户勾了哪些才列哪些。 */
  const tmodels = (tpl.models || []).concat(tpl.modelDocs || []);
  p.models = (e.models || []).map(x => {
    const id = String((x && x.id) || (typeof x === 'string' ? x : '') || '').trim();
    const hit = tmodels.find(m => m.id === id);
    const base = hit || tmodels[0] || { modes: [] };
    const m = { ...base, id, name: String((x && x.name) || (hit && hit.name) || id).slice(0, 60) };
    if (!hit) m.optionsFrom = (tmodels[0] && tmodels[0].id) || '';
    return m;
  }).filter(m => m.id);
  return p;
}
/* ============================================================================
   型号清单偏好（设置页那一张「型号清单」卡里勾出来的）
   ----------------------------------------------------------------------------
   存 localStorage 的 `sk_model_prefs`（ui.js 的 DataSync 顺手镜像成 `.data/sk_model_prefs.json`，
   `sk_model_` 这一条 SYNCABLE 前缀盖得住它，所以云同步与整包备份都不用另外登记）：
   `{ "<keyId>": { "typed": ["型号id"], "off": ["型号id"] } }`
   两件事合在一个键里是刻意的：「显示 / 隐藏」与「自己添加 / 删掉」改的都是同一份清单，
   拆成两个键就会出现「只删得掉、藏不住」或反之（而界面上一颗勾覆盖的是整行）。
   按 **keyId** 归并（与密钥同一口径）：一家平台同时做图片与视频时共用一把密钥，
   它的型号清单也应当是一份 —— 否则「在图片那张卡藏了 img-2-5t，视频那张卡里它还在」。

   为什么**不**拿 `sk_text_models_<kid>` 继续用：那一键只管文字一类，
   生成三类若各长出一个「手填型号」的键与判据，就是同一件事的第四份实现（文字 AI 那份已经
   在 ModelPrefs 里，读旧键的一次性搬迁见 assetlib.js 的 `ModelPrefs.migrate`）。

   合并只在这一个地方做（allProviders）：/registry、relay 转发、/capabilities 三处都读它，
   分开合就会出现「设置页藏掉了、下拉里还在」。 */
const MODEL_PREFS_KEY = 'sk_model_prefs';
const modelPrefsNotice = { reason: '' };
/* 缓存键与 customProviders 同一套：mtime + size。少了 size 的话同一毫秒连写两遍拿到同一个 mtime，
   刚勾掉的那个型号在注册表里还在 —— 表现是「藏了没生效，要等下一次刷新」。 */
let _prefsCache = { file: '', mtime: 0, size: -1, map: {} };
function modelPrefs() {
  const file = dataFileOf(MODEL_PREFS_KEY);
  let mtime = 0, size = -1;
  try { const st = fs.statSync(file); mtime = st.mtimeMs; size = st.size; } catch { mtime = 0; }
  if (_prefsCache.file === file && _prefsCache.mtime === mtime && _prefsCache.size === size) return _prefsCache.map;
  if (!mtime) { _prefsCache = { file, mtime: 0, size, map: {} }; modelPrefsNotice.reason = ''; return {}; }
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    /* 读不动就当没勾过（退回上游清单），但要把原因留下：设置页那句「有 N 家勾过没被代理认」
       与「我明明藏了、它还挂着」只有这一处能说清。 */
    modelPrefsNotice.reason = '读取 .data/' + MODEL_PREFS_KEY + '.json 失败：' + e.message;
    _prefsCache = { file, mtime, size, map: {} };
    return {};
  }
  modelPrefsNotice.reason = '';
  /* 客户端可能走 Store（信封 { data: 值, ts }）也可能裸写 JSON 文本，值本身还可能是一串 JSON。
     一层层解到对象为止，最多两次 —— 超过两次就是有人手改了盘上的文件，按没勾过处理。 */
  for (let i = 0; i < 2; i++) {
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; break; } continue; }
    if (raw && !Array.isArray(raw) && typeof raw.data === 'object' && raw.data !== null) { raw = raw.data; continue; }
    break;
  }
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.entries(raw).forEach(([kid, v]) => {
      const list = a => (Array.isArray(a) ? a.map(x => String(x).trim()).filter(Boolean) : []);
      out[String(kid)] = { typed: list(v && v.typed), off: list(v && v.off) };
    });
  }
  _prefsCache = { file, mtime, size, map: out };
  return out;
}
/* 用户手填的那个型号，能力声明从哪来（**只在这一处**答这个问题）：
   ① provider 的 `modelDocs` —— 「文档里写过这个 id 支持什么」的表（见下面那五家的注释），
      它不是清单，只有用户真填了这个 id 才用得上；
   ② provider 级 `newModelDefaults` —— 这一族型号的起步能力（mimo 早就在用这一档）；
   ③ 都没有 → 只带 id。此时参数面板是空的，界面会照实说「这个型号没有能力声明」，
      而不是替平台猜一档（猜出来的档位发过去就是上游报错）。 */
function modelDeclFor(prov, id) {
  const hit = (prov.modelDocs || []).find(m => m && m.id === id);
  if (hit) return { ...hit };
  const d = prov.newModelDefaults;
  if (d) {
    const m = { id, name: id, modes: d.modes || [], options: { ...(d.options || {}) } };
    if (d.ttsMode) m.ttsMode = d.ttsMode;
    if (d.inputRoles) m.inputRoles = { ...d.inputRoles };
    return m;
  }
  return { id, name: id, modes: [], options: {} };
}
/* 把偏好合到一条 provider 上：追加手填的、剔掉勾掉的。没有偏好的家**原样返回**（不复制），
   免得每次 /registry 都把十几条声明重抄一遍 —— 也免得有人以为「复制出来的那份才是真的」。 */
function withModelPrefs(p, prefs) {
  const pref = prefs[String(p.keyId || p.id)];
  if (!pref || (!pref.typed.length && !pref.off.length)) return p;
  const models = (p.models || []).slice();
  pref.typed.forEach(id => { if (!models.some(m => m && m.id === id)) models.push(modelDeclFor(p, id)); });
  const merged = { ...p, models: pref.off.length ? models.filter(m => !pref.off.includes(String(m && m.id))) : models };
  /* 手填的型号在 /capabilities 那一侧是「接口没给过的」，apply 会把它们保留（声明优先），
     但上游真给出同 id 的声明时应当覆盖 —— 那已由 Capabilities.apply 第一段循环做掉。
     这里刻意不再往 provider 上抄一份「哪些是手填的 / 哪些被藏了」：页面本来就读同一个 localStorage 键，
     多带一份就是第二个真相源（两边不一致时没人说得清哪一份是用户刚勾的）。 */
  return merged;
}
/* 内置 + 自定义 + 型号偏好。/registry、relay 转发、/capabilities 三处都读它 —— 合并只在这一个地方做，
   免得出现「设置页加好了、能力接口却说找不到平台」。
   偏好只读一次（一次 statSync + 可能的解析）再逐家套：一条请求里问二十次同一个文件没有意义。 */
function allProviders() {
  const prefs = modelPrefs();
  return REGISTRY.providers.concat(customProviders()).map(p => withModelPrefs(p, prefs));
}


/* ---------- 注册表端点命名 ----------
   素材上传端点统一叫 uploads / complete（客户端只认这一套名字）。
   没有「老写法也认」那一层：改名就同时改声明，改完必须重启代理，
   否则页面拿到的是旧注册表、上传直接报「暂无素材上传接口」——
   这种情况由 REGISTRY.version 与页面的旧代理提示来说清楚。 */

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
const UP_TIMEOUT = 60000;                // 上游请求超时：没有它，上游挂起会永久占住连接与渲染任务
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
   而 /getv /fetch /getfile /s3put 这四条取回 / 上传通道靠 `lookup: guardedLookup`
   （见 1252 附近）做 **DNS rebinding 防护**：开了 keep-alive 之后，第二条请求可能复用
   第一条已经建好的 socket 而**跳过 lookup**，那道 SSRF 闸就会在复用路径上被绕过。
   所以这四条**保持每次新建**，绝不要「顺手统一」。shutdown() 里补了 agent.destroy()。 */
const keepAliveAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000 });

/* ============================================================================
   出站代理：本机开着代理软件（Clash / V2Ray / 公司网关…）时，项目也走它
   ---------------------------------------------------------------------------
   为什么必须自己做：Node 的 `https.request` **不认** Windows 的「系统代理」设置，
   也不认 HTTP_PROXY / HTTPS_PROXY（除非 Node ≥ 24 且显式开了 NODE_USE_ENV_PROXY）。
   于是在必须走代理才能出网的环境里，代理进程自己反而在直连 —— 所有平台请求超时 / DNS 失败，
   而界面只显示「转发失败（打到 xxx）」，看不出根因是「没走代理」。
   三件事：
     ① 找代理：环境变量（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY，大小写都认）优先；
        其次读 Windows 注册表的系统代理（HKCU\...\Internet Settings 的 ProxyEnable / ProxyServer）。
        30 秒一份缓存，所以开关代理软件不用重启本项目。
     ② 走代理：https 目标用 CONNECT 隧道（自己实现 —— 本项目不引任何依赖）；
        http 目标不代理（云同步那类自建 WebDAV 多半是本机 / 内网，代理反而添乱）。
     ③ 不该走的不走：回环 / 内网 / 链路本地地址、NO_PROXY 里列的、以及 .env 里 `PROXY_OFF=1` 时全部直连。

   安全边界（与 keep-alive 那条同一套谨慎，别顺手改）：
     走代理时 DNS 由**代理解析**，所以 /getv /fetch /getfile /s3put 那四条通道的
     `lookup: guardedLookup` 用不上（它本来就在建连时校验解析结果）。
     但那四条**仍然先过 `guardOutboundUrl`**（本地解析 + 拒绝回环/内网/保留地址），
     所以「域名指向内网」这类写法在发起请求之前就被挡掉了；
     剩下的只是「本地校验 → 代理再解析」之间被换 IP 的那一小段窗口 —— 这是走代理的固有代价，
     换来的正是「在必须走代理的网络里能用」。不想要就 PROXY_OFF=1。
   ========================================================================== */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
function parseProxySpec(s) {
  let v = String(s || '').trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;      // 只写 host:port 时补上协议
  let o = null;
  try { o = new URL(v); } catch { return null; }
  const proto = o.protocol.replace(':', '').toLowerCase();
  /* 只做 http(s) 代理：SOCKS 需要额外握手，本项目不引依赖也自己写不动。
     （写 socks5:// 时会解析不出来 → 当作没配代理，日志里那句会照实说。） */
  if (proto !== 'http' && proto !== 'https') return null;
  const host = o.hostname;
  if (!host) return null;
  const port = Number(o.port) || (proto === 'https' ? 443 : 80);
  let auth = '';
  try {
    if (o.username || o.password) {
      auth = 'Basic ' + Buffer.from(decodeURIComponent(o.username) + ':' + decodeURIComponent(o.password)).toString('base64');
    }
  } catch (e) {}
  return { proto, host, port, auth, label: proto + '://' + host + ':' + port };
}
/* Windows 的「系统代理」：ProxyEnable=1 且 ProxyServer 有值才算。
   ProxyServer 有两种写法 —— 单一地址，或按协议分开的 `http=1.2.3.4:80;https=1.2.3.4:443`。 */
function systemProxyFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const { spawnSync } = require('child_process');
    const q = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (!q || q.status !== 0 || !q.stdout) return null;
    const on = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(q.stdout);
    if (!on || parseInt(on[1], 16) !== 1) return null;
    const srv = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(q.stdout);
    if (!srv) return null;
    let spec = srv[1].trim();
    if (spec.includes('=')) {
      const parts = {};
      spec.split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim(); });
      spec = parts.https || parts.http || '';
    }
    return parseProxySpec(spec);
  } catch (e) { return null; }
}
const PROXY_TTL = 30 * 1000;
let _proxyCfg = null, _proxySrc = '', _proxyAt = 0;
function outboundProxy() {
  const now = Date.now();
  if (now - _proxyAt < PROXY_TTL) return { cfg: _proxyCfg, src: _proxySrc };
  _proxyAt = now; _proxyCfg = null; _proxySrc = '';
  if (String(process.env.PROXY_OFF || '') === '1') { _proxySrc = 'PROXY_OFF=1（.env 里关掉了，全部直连）'; return { cfg: null, src: _proxySrc }; }
  for (const k of PROXY_ENV_KEYS) {
    const c = parseProxySpec(process.env[k]);
    if (c) { _proxyCfg = c; _proxySrc = '环境变量 ' + k + ' = ' + c.label; return { cfg: _proxyCfg, src: _proxySrc }; }
  }
  const c = systemProxyFromRegistry();
  if (c) { _proxyCfg = c; _proxySrc = 'Windows 系统代理 ' + c.label; return { cfg: _proxyCfg, src: _proxySrc }; }
  return { cfg: null, src: '' };
}
/* 这些目标不走代理：本机 / 内网 / NO_PROXY 里列的。
   判据复用 isPrivateHost（回环、私有段、链路本地、保留段都在里面），不另写一份名单。 */
function proxyBypassed(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return isPrivateHost(h);
  const list = String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  return list.some(p => p === '*' || h === p || h.endsWith('.' + p));
}
/* https 目标走 HTTP 代理的 CONNECT 隧道：先连代理 → CONNECT host:port → 在这条 socket 上做 TLS。
   覆盖 https.Agent 的 createConnection 就是全部（Agent 负责按 host:port 复用连接，
   所以隧道不会串到别的目标上去）。 */
class ProxyTunnelAgent extends HttpsAgent {
  constructor(cfg) { super({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000 }); this.cfg = cfg; }
  createConnection(options, cb) {
    const cfg = this.cfg;
    const host = options.host, port = options.port || 443;
    let done = false;
    const finish = (err, sock) => { if (done) return; done = true; cb(err, sock); };
    const mod = cfg.proto === 'https' ? httpsRequest : http.request;
    const preq = mod({
      host: cfg.host, port: cfg.port, method: 'CONNECT',
      path: host + ':' + port, agent: false, rejectUnauthorized: false,
      headers: Object.assign({ host: host + ':' + port }, cfg.auth ? { 'proxy-authorization': cfg.auth } : {}),
    });
    preq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch (e) {}
        return finish(new Error('代理拒绝 CONNECT（HTTP ' + res.statusCode + '）：' + cfg.label + ' 连不上 ' + host + ':' + port));
      }
      const tlsSock = tls.connect({
        socket,
        servername: options.servername || host,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      }, () => finish(null, tlsSock));
      tlsSock.once('error', e => finish(e));
    });
    preq.once('error', e => finish(new Error('连不上代理 ' + cfg.label + '：' + e.message)));
    preq.end();
  }
}
let _tunnelAgent = null, _tunnelKey = '';
function proxyAgentFor(cfg) {
  if (_tunnelAgent && _tunnelKey === cfg.label) return _tunnelAgent;
  try { if (_tunnelAgent) _tunnelAgent.destroy(); } catch (e) {}
  _tunnelAgent = new ProxyTunnelAgent(cfg);
  _tunnelKey = cfg.label;
  return _tunnelAgent;
}
/* 这次出站该用哪个 agent：有代理且目标不是本机/内网 → 走代理；否则直连
   （keepAlive 只给 relay / capabilities 那两条 —— 见 keepAliveAgent 上面那段边界说明）。 */
function agentFor(url, keepAlive) {
  const p = outboundProxy();
  if (p.cfg) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    if (!proxyBypassed(host)) return proxyAgentFor(p.cfg);
  }
  return keepAlive ? keepAliveAgent : undefined;
}

function upRequest(url, opts, cb) {
  /* 空闲超时可按请求覆盖（opts.timeoutMs）：创建任务这类"平台要在服务端排队、迟迟不回"的接口
     需要更长的耐心 —— 60 秒就掐断的后果是「任务其实建好了，页面却看到失败」，
     用户再点一次就成了两条重复任务（20:31 那条 VGENV 任务就是这么来的）。 */
  const o = { ...(opts || {}) };
  const idle = Number(o.timeoutMs) || UP_TIMEOUT;
  delete o.timeoutMs;
  const ka = o.keepAlive === true; delete o.keepAlive;
  if (!o.agent) o.agent = agentFor(url, ka);      // 没指定就按「本机有没有代理」自动选
  const r = httpsRequest(url, o, cb);
  r.setTimeout(idle, () => { r.destroy(new Error('上游响应超时（' + Math.round(idle / 1000) + 's）')); });
  return r;
}
/* 出站请求失败时的统一收尾。
   为什么需要它：上游「先把响应头回给我们、再把连接 RST 掉」时，错误处理器里那句
   res.writeHead(502) 会抛 ERR_HTTP_HEADERS_SENT ——以前几处处理器没判 headersSent，
   于是这种中断会在日志里刷「未捕获异常」，客户端也只能拿到一个半截响应。
   现在：响应还没开始 → 502 + 可读原因；已经开始 → 直接断开连接。
   （头已发出就没法再改状态码，断开是唯一诚实的做法：客户端会看到「传输中断」。） */
function failUpstream(res, msg, tag) {
  const body = (tag ? tag + '：' : '') + String(msg == null ? '' : msg);
  try {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  } catch {}
}

/* 按协议自选模块：云同步允许本机回环用 http（自建 WebDAV 调试），其余一律 https */
function anyRequest(url, opts, cb) {
  const o = { ...(opts || {}) };
  /* 只给 https 目标套 agent：http 目标（云同步那类自建 WebDAV）多半是本机 / 内网，
     而 http 走代理要改写成绝对 URI，代价与收益不成比例 —— 那一条保持直连。 */
  if (!o.agent && /^https:\/\//i.test(url)) o.agent = agentFor(url, false);
  const mod = /^http:\/\//i.test(url) ? http.request : httpsRequest;
  const r = mod(url, o, cb);
  r.setTimeout(UP_TIMEOUT, () => { r.destroy(new Error('请求超时（' + (UP_TIMEOUT / 1000) + 's）')); });
  return r;
}

/* ---------- 出站地址护栏（SSRF） ----------
   /fetch、/getv、/getfile、/s3put 会把「浏览器递来的 URL」原样取回/写穿，
   不设限就成了「谁都能拿这台机器当跳板」：探测内网、写内网服务。
   规则：必须 https，且主机不能是回环 / 内网 / 链路本地 / 保留地址；
   只认域名与公网 IP 字面量（内网服务常见写法都在拒绝名单里），不做 DNS 解析。
   说明：云同步（/cloud）不走这里 —— 它允许本机回环，因为地址是用户自己填的（自建 WebDAV 调试）。 */
/* IPv4 映射的 IPv6（::ffff:127.0.0.1）：URL 解析器会把它规范化成 ::ffff:7f00:1，
   DNS 结果里则常带点分写法 —— 两种都还原成 v4 再判 */
function ipv4FromMapped(s) {
  const m = /(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
  }
  const m2 = /(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  return m2 ? m2[1] : null;
}
/* IPv6 字面量：先展开成 8 组 16 位再判 —— 只比字符串的话
   '0:0:0:0:0:0:0:1'（::1 的全写）与 '::127.0.0.1'（IPv4 兼容写法）都会当成公网放行，
   而 Node 对 IP 字面量根本不做 DNS 解析，guardedLookup 那道兜底也碰不到它们。 */
function ipv6Groups(h) {
  let s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return null;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const q = [+v4[1], +v4[2], +v4[3], +v4[4]];
    if (q.some(x => x > 255)) return null;
    s = s.slice(0, v4.index).replace(/:$/, '') + ':' + ((q[0] << 8) + q[1]).toString(16) + ':' + ((q[2] << 8) + q[3]).toString(16);
  }
  if (!/^[0-9a-f:]*$/.test(s)) return null;
  const dbl = s.indexOf('::');
  let head, tail;
  if (dbl >= 0) {
    if (s.indexOf('::') !== s.lastIndexOf('::')) return null;         // 多个 :: 非法
    head = s.slice(0, dbl).split(':').filter(Boolean);
    tail = s.slice(dbl + 2).split(':').filter(Boolean);
  } else {
    head = s.split(':').filter(Boolean);
    tail = [];
    if (head.length !== 8) return null;
  }
  const need = 8 - head.length - tail.length;
  if (need < 0) return null;
  const g = [...head, ...Array(need).fill('0'), ...tail].map(x => parseInt(x, 16));
  return g.length === 8 && g.every(x => Number.isFinite(x)) ? g : null;
}
function isPrivateIpv6(h) {
  const g = ipv6Groups(h);
  if (!g) return false;                                   // 展开不出来 = 不是合法 IPv6 字面量，交给域名那条路
  const zero = g.slice(0, 6).every(x => x === 0);
  if (zero && g[6] === 0xffff) return isPrivateHost([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255].join('.'));
  if (g.every(x => x === 0)) return true;                  // ::  未指定地址
  if (zero && g[6] === 0 && g[7] === 1) return true;       // ::1 回环（含全写形式）
  if (zero && (g[6] | g[7])) {                             // IPv4 兼容 ::a.b.c.d —— 已废弃，且几乎只会指向回环
    return isPrivateHost([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255].join('.'));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true;             // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true;             // fe80::/10 链路本地
  /* 2001:db8::/32 文档地址与 3ffe::/16 旧骨干网都早就不在公网路由里，但真正要紧的是
     2000::/3 那一整段就是现有公网地址空间 —— 别把它当「保留段」一刀切拒绝。 */
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;      // 文档示例地址
  return false;
}
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;                       // 本网络/私网/回环/组播保留
    if (a === 100 && b >= 64 && b <= 127) return true;                                   // 运营商级 NAT
    if (a === 169 && b === 254) return true;                                             // 链路本地（云元数据地址就在这段）
    if (a === 172 && b >= 16 && b <= 31) return true;                                    // 私网
    if (a === 192 && (b === 168 || b === 0)) return true;                                // 私网 / 保留
    if (a === 198 && (b === 18 || b === 19)) return true;                                // 基准测试网段
    return false;
  }
  if (h.includes(':')) {
    const v4 = ipv4FromMapped(h);
    return v4 ? isPrivateHost(v4) : isPrivateIpv6(h);
  }
  return false;
}
/* 连接时再校验一次的 DNS 解析（DNS rebinding 防护）
   guardOutboundUrl 的校验与真正建连之间存在时间窗：攻击者控制的域名可以第一次解析给公网 IP
   （骗过校验），真正连接时解析到 127.0.0.1。把校验放进 lookup —— 它用的就是本次连接真正要用的解析结果。
   用法：出站请求的 opts.lookup = guardedLookup。 */
function guardedLookup(hostname, opts, cb) {
  const o = opts || {};
  dns.lookup(hostname, { ...o, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: o.family }];
    const bad = list.find(a => a && isPrivateHost(a.address));
    if (bad) return cb(new Error('目标地址解析到内网（已拒绝）：' + bad.address));
    if (o.all) return cb(null, list);
    const first = list.find(a => !o.family || a.family === o.family) || list[0];
    cb(null, first.address, first.family);
  });
}
/* 允许取回的 URL：https + 公网主机；不合法返回 null */
function safeOutboundUrl(u) {
  let o = null;
  try { o = new URL(String(u)); } catch { return null; }
  if (o.protocol !== 'https:') return null;
  if (isPrivateHost(o.hostname)) return null;
  return o.toString();
}
/* 两个基址**是不是同一个地址**：只比协议 + 主机（小写）+ 端口 + 路径（去掉末尾斜杠）。
   末尾斜杠、主机大小写、默认端口这些写法差异不算「换了地址」。
   用途见 relay 里 x-up-base 那一段：设置页添加内置平台时地址是自动填好的（就是它自己的官方地址），
   存过一次之后每个请求都会带上 x-up-base —— 不能因为「写了同一句话」就把 .env 的密钥回退关掉。 */
function baseKeyOf(u) {
  try {
    const o = new URL(String(u));
    return o.protocol + '//' + o.hostname.toLowerCase() + (o.port ? ':' + o.port : '') + o.pathname.replace(/\/+$/, '');
  } catch { return String(u == null ? '' : u).replace(/\/+$/, '').toLowerCase(); }
}
/* 解析域名，确认所有解析结果都是公网地址 —— 挡「域名指向内网」的写法
   （如 *.nip.io / *.sslip.io / localtest.me：字面量看着是公网域名，实际解析到 127.0.0.1）。
   结果按主机名缓存 5 分钟：外链视频播放会发很多 Range 请求，不能每个都解析一次。 */
const hostGuardCache = new Map();      // host → { ts, err }
const HOST_GUARD_TTL = 5 * 60 * 1000;
function assertPublicHost(host) {
  const hit = hostGuardCache.get(host);
  if (hit && Date.now() - hit.ts < HOST_GUARD_TTL) {
    return hit.err ? Promise.reject(new Error(hit.err)) : Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      let msg = '';
      if (err) msg = '域名解析失败：' + err.message;
      else if (!addrs || !addrs.length) msg = '域名没有解析结果';
      else {
        const bad = addrs.find(a => isPrivateHost(a.address));
        if (bad) msg = '目标地址解析到内网（已拒绝）：' + bad.address;
      }
      if (hostGuardCache.size > 500) hostGuardCache.clear();
      hostGuardCache.set(host, { ts: Date.now(), err: msg });
      msg ? reject(new Error(msg)) : resolve(true);
    });
  });
}
/* 完整护栏：返回可用的 URL 字符串；不合法抛出可读错误（调用方转 400） */
async function guardOutboundUrl(raw) {
  const u = safeOutboundUrl(raw);
  if (!u) throw new Error('只允许取回公网 https 地址（回环 / 内网 / 明文 http 一律拒绝）');
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) await assertPublicHost(h);
  return u;
}

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
  const up = upRequest(target, { method: 'PUT', headers: fwd, lookup: guardedLookup }, ur => {
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

/* ---------- ffmpeg 离线渲染服务 ----------
   POST /render          提交 EDL（clips: src/in/out/speed/volume）→ 返回 { id }
   GET  /render/status   查询进度 { state, progress, stage, out, err, log }
   GET  /render/dl       下载成片 ?name=xxx
   POST /render/cancel   取消渲染（杀 ffmpeg 子进程 + 从队列摘掉）?id=xxx
   流程：下载每段素材 → 逐段标准化（尺寸/帧率/编码一致）→ concat 拼接 → 输出 mp4
   src 支持：/asset/<id>（用密钥解析最新签名链接）｜ http(s):// ｜ /local-path（经本机 http 取回） */
const { spawn, spawnSync } = require('child_process');
const RENDER_DIR = path.resolve(__dirname, process.env.RENDER_DIR || '.renders');   // 同 ASSETS_DIR：绝对路径要能直接用

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
const LOCAL_DIR = path.resolve(__dirname, process.env.ASSETS_DIR || '.assets');
/* ---------- 按类型另存到用户指定的文件夹（POST /save 用） ----------
   配置在 `.data/sk_autosave.json`（设置页存进 localStorage 的 `sk_autosave`，由 DataSync 镜像过来，
   所以换机器 / 云同步都跟着走 —— 里面只有目录路径，没有任何密钥）。
   形状：{ image:{on:'on'|'off', dir:'D:\\AI图'}, video:{…}, audio:{…} }。
   **目录不存在时自动建**（用户填 `D:\AI图\短剧` 而 `AI图` 还没有是常事），
   建不出来就照实报错，不静默跳过 —— 静默跳过的话界面上什么痕迹都没有，
   用户会以为「保存了」而文件其实没落盘。 */
const SAVE_KINDS = ['image', 'video', 'audio'];
const saveKindZh = { image: '图片', video: '视频', audio: '音频' };
const typeLabel = t => saveKindZh[t] || t;
/* 没指定目录时的默认落盘地：项目下的「文件」文件夹，按类型分子目录。
   为什么是这个：设置项留空原本的意思是「只存 .assets 资产库、不另存一份」，
   于是用户永远看不到自己生成的成品，得自己去一个点号开头的隐藏目录里翻。
   留空 = 用这个默认，是把「什么都不做」换成「存到看得见的地方」，
   仍然随时能改 —— 逐类型的自定义路径优先级更高（见 autosaveDir）。
   放项目目录下的理由：跟着项目走、跟着 DataSync 的仓库走，
   且不写死绝对路径（换机器、云同步之后仍然对）。 */
const autosaveDefaultDir = kind => path.join(__dirname, '文件', typeLabel(kind));
function autosaveConf() {
  /* 与下面 `dataDirPath()` 同一份表达式：这里**不能**去调它 —— 它是 2339 行的 const，
     本函数在 1400 行，调用它就依赖「模块加载完之前不会被调用」这件事（能跑，但脆）。 */
  const f = path.resolve(__dirname, process.env.DATA_DIR || '.data', 'sk_autosave.json');
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (v && typeof v === 'object') ? v : {};
  } catch { return {}; }
}
/** 这一类该存到哪个目录（'' = 这一类关了，不另存）。
    留空不再等于「不另存」：那是 2026-10 之前的默认，代价是成品只落在 .assets 这个
    点号开头的目录里，用户看不见。留空 = 用 autosaveDefaultDir（项目下 文件/<类型>）。 */
function autosaveDir(kind) {
  const c = (autosaveConf()[kind] || {});
  if (c.on === 'off') return '';
  const d = String(c.dir || '').trim();
  if (!d) return autosaveDefaultDir(kind);
  return path.resolve(d.replace(/[\\/]+$/, ''));
}
/* 「图片/视频/音频」反回 image/video/audio。类型判据只有 localMediaType 一处，
   这里只做中英互转，不另写一份扩展名名单（LOCAL_KIND_BY_EXT 已经有一份了）。 */
const saveKindOf = zh => Object.keys(LOCAL_KIND_ALIAS).find(k => LOCAL_KIND_ALIAS[k] === zh) || '';
/* 文件名：只留 basename 与安全字符（防 ../ 穿越）。三条另存路由共用这一份。 */
function saveBaseName(name, fallback) {
  return path.basename(String(name == null ? '' : name) || fallback || 'file.bin')
    .replace(/[^\w.\-一-龥]+/g, '_').replace(/^_+/, '').slice(0, 120)
    || (fallback || 'file.bin');
}
/* 在 dir 里找一个不撞名的文件名：同名加 -2 / -3 序号，**不覆盖** ——
   覆盖会把用户自己整理过的文件名换掉，而且没有任何提示。
   /save、/save-local、/save-move 三条路由共用这一份：各写一遍就会出现
   「补存那次叫 a-2、下一回生成又叫 a-2」这种同目录里两套编号。 */
function saveUniqueName(dir, base, onTooMany) {
  let file = base, n = 2;
  while (fs.existsSync(path.join(dir, file))) {
    const dot = base.lastIndexOf('.');
    file = (dot > 0 ? base.slice(0, dot) : base) + '-' + n + (dot > 0 ? base.slice(dot) : '');
    n++;
    if (n > 999) return onTooMany();
  }
  return file;
}
/* 目标目录里已经有哪些内容：建一张「字节数:摘要 → 文件名」的表。
   为什么必须有这一步：另存是**镜像的附属动作** —— 用户改目录之前新生成的那批，
   早就被 /save 写进旧目录了。不判重就补存的话，同一个视频会在新目录里出现两份：
   一份是补存拷来的 `a.mp4`，一份是搬迁搬过来的 `a-2.mp4`（撞名才加的序号）。
   只比字节数不够 —— 同长度不同内容是常事（改一帧的视频、改过参数的图），所以再比 sha1。
   整条目录只读一遍、由调用方复用，别在循环里每个 id 重扫一次（83 个产物 × 目录里几十个
   文件就是几千次全文件读）。`sha1Of` 定义在 3271 行，这里能安全引用：
   本函数只在**收到请求之后**才被调用，那时模块早已加载完。 */
/* 这个目录是不是**本机资产库本体**（.assets，或它里面的某个子目录）。
   另存那三条路由都要过这一道。为什么单独拦、而不是靠白名单：
   白名单（sk_autosave_used.json）证明的是「这个目录是本工作台写过的」，
   证明不了「搬走 / 写进去它是安全的」—— 用户把另存目录填成 .assets 是完全合法的操作，
   而那样 /save 写进去的副本会把 .assets 记进白名单，下一次换位置 /save-move 就会
   **真的把资产库里的文件搬走**。.assets 是整个工作台的本体：离线能看、删了能回源、
   缩略图全靠它，搬空了就是「资产库里什么都没有了」。
   判据只有这一份（LOCAL_DIR 同一处），三条路由各调它，不再各写一遍前缀比较。 */
function insideLocalDir(dir) {
  if (!dir) return false;
  try {
    const base = path.resolve(LOCAL_DIR), s = path.resolve(dir);
    return s === base || s.startsWith(base + path.sep);
  } catch { return false; }
}
/* 目录内容指纹表（判重按**内容 sha1 不按文件名**，见 §G）。
   以前对目录里**每一个**文件都 readFileSync + sha1 —— `文件\视频` 512 个文件 / 788 MB，
   实测外推约 1,848 ms 的**同步**阻塞（全在请求回调里），期间轮询、/asset 取图、/getv 播放
   全部停摆。而判重本来就是「同 size 才可能同内容」，所以改成**按 size 建桶、懒算 sha1**：
     · 目录里 size 只出现一次的那些，一个字节都不用读（不同内容的视频 size 几乎必然不同）；
     · 只有真拿一个 size 来查、且这个 size 在目录里出现过时，才去读那几个同 size 的文件。
   再按目录 mtime 缓存整张表（判据照抄 _customCache 的 mtime 双键，不引入新范式）：
   目录没变就直接复用，连那 512 次 statSync 都省掉。 */
const dirIndexCache = new Map();          // dir → { mtimeMs, idx }
function buildDirIndex(dir) {
  const bySize = new Map();               // size → [名字]
  try {
    for (const n of fs.readdirSync(dir)) {
      let st; try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
      if (!st.isFile()) continue;
      const arr = bySize.get(st.size); if (arr) arr.push(n); else bySize.set(st.size, [n]);
    }
  } catch { /* 目录还不存在 = 里面什么都没有 */ }
  const shaCache = new Map();             // 名字 → sha1（同一份文件在一次请求里可能被查多次）
  const shaOfName = n => {
    if (shaCache.has(n)) return shaCache.get(n);
    let h = '';
    try { h = sha1Of(fs.readFileSync(path.join(dir, n))); } catch {}
    shaCache.set(n, h);
    return h;
  };
  return {
    /* 目录里有没有与这段内容完全相同的文件？有就返回它的文件名。 */
    get(size, hash) {
      const cands = bySize.get(size);
      if (!cands) return undefined;
      for (const n of cands) if (shaOfName(n) === hash) return n;
      return undefined;
    },
    /* 本次刚写进去的文件也要能立刻被后面的同内容请求命中（与以前 sums.set 同一个语义）。 */
    add(size, hash, name) {
      const arr = bySize.get(size);
      if (arr) { if (arr.indexOf(name) < 0) arr.push(name); } else bySize.set(size, [name]);
      shaCache.set(name, hash);
    },
  };
}
function saveDirIndex(dir) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { mtimeMs = 0; }
  const hit = dirIndexCache.get(dir);
  if (hit && mtimeMs && hit.mtimeMs === mtimeMs) return hit.idx;
  const idx = buildDirIndex(dir);
  dirIndexCache.set(dir, { mtimeMs, idx });
  if (dirIndexCache.size > 16) { const k = dirIndexCache.keys().next().value; dirIndexCache.delete(k); }
  return idx;
}
/* ---------- 代理自己写过的目录名单（POST /save-move 的安全闸） ----------
   换下载位置时页面要递「从哪个旧目录搬过来」，而 /save 特意**不接受**客户端递的目录 ——
   认了它，这条路由就等于「任意本机网页往任意路径写/搬文件」。
   所以旧目录必须能被证明是**本工作台自己写出来的**：代理每写一次就把那个目录记进
   `.data/sk_autosave_used.json`，/save-move 只接受名单里的。
   代价是「早于这份名单的旧目录」搬不了 —— 那种情况页面会照实说「那个目录不是本工作台写的」，
   而不是替用户猜。 */
const autosaveUsedPath = () => path.resolve(__dirname, process.env.DATA_DIR || '.data', 'sk_autosave_used.json');
function autosaveUsedRead() {
  try { const v = JSON.parse(fs.readFileSync(autosaveUsedPath(), 'utf8')); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
  catch { return []; }
}
function autosaveUsedAdd(dir) {
  try {
    if (!dir) return;
    const list = autosaveUsedRead();
    const key = path.resolve(dir);
    if (list.some(x => path.resolve(x) === key)) return;
    list.push(key);
    fs.writeFileSync(autosaveUsedPath(), JSON.stringify(list.slice(-50), null, 0));
  } catch (e) { log('[save] 目录名单写不下去（不影响存文件）：' + e.message); }
}
function autosaveUsedHas(dir) {
  if (!dir) return false;
  const key = path.resolve(dir);
  return autosaveUsedRead().some(x => { try { return path.resolve(x) === key; } catch { return false; } });
}
const localIndexPath = () => path.join(LOCAL_DIR, 'index.json');
function localIndexRead() {
  const f = localIndexPath();
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(v)) return v;
    throw new Error('索引内容不是数组');
  } catch (e) {
    /* 索引读不出来时不能默默当空表：下一次写入会把整表覆盖，旧条目就永久丢了。
       先把坏文件改名留档（.bad-<时间戳>，人工还能找回），再按空表继续。 */
    try {
      if (!e || e.code !== 'ENOENT') {
        const bak = f + '.bad-' + Date.now();
        fs.renameSync(f, bak);
        log('[local-assets] 索引损坏（' + (e && e.message) + '）→ 已另存为 ' + path.basename(bak) + '，本次按空表继续');
      }
    } catch {}
    return [];
  }
}
/* 本机资产索引最多留多少条。**以前是 500 条（补建时 2000）** —— 那是「只存同步返回的语音/生图」
   那个年代的量级：开了「产物自动存本机」之后每一条生成产物都进这张表，500 条一晚上就满，
   满了以后新写的把旧的挤掉，被挤掉的文件还在磁盘上但索引里没了 → 资产库看不见、/asset 也取不回
   （表现为「明明存过，点开却说已丢失」）。索引里一条只有几百字节，2 万条约几 MB，放得下。 */
const LOCAL_INDEX_MAX = 20000;
function localIndexWrite(list) {
  /* 和 /data 一样先写临时文件再 rename：整表覆盖时进程被杀 / 断电会留下半截 JSON，
     下一次读取失败就按空表继续，前面所有本地资产的索引一起丢（文件还在但资产库看不到）。 */
  const f = localIndexPath();
  const tmp = f + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    log('[local-assets] 写入索引失败：' + e.message);
    /* **必须抛出去**（L50）：以前这里只写一行日志，调用方照常回 200「已保存」。
       磁盘满的时候表现是：卡片当场显示「已保存」、刷新后资产库里没有它、
       GET /local-assets 也不列它（列表只读索引）—— 字节其实好好躺在 .assets 里，
       只是没人知道它存在。回 200 等于告诉调用方「记下了」，而它并没有被记下。
       带上 indexWrite 标记，路由那边据此说清「字节在、索引不在」。 */
    const err = new Error('本机资产索引写盘失败：' + (e.message || e));
    err.indexWrite = true;
    throw err;
  }
}
function localAssetEntry(id) {
  const hit = localIndexRead().find(x => x && x.id === id);
  if (hit) return hit;
  /* 索引只留最近 500 条（写入时截断），文件本身还在盘上。
     不在这里按目录补建，被挤出索引的那条就永久取不回来：/asset/<id> 404、
     DELETE /local-assets/<id> 也 404（文件删不掉，成孤儿）。逐句配音每句存一条，很快就到 500。 */
  return localAssetRebuild(id);
}
/* 本机资产的大类型（图片 / 视频 / 音频）：先看扩展名（落盘文件名就是 <id>.<格式>，最可靠），
   再按 mime，最后按调用方给的 media_type（英文写法认成中文）。缺省过去写死 audio，
   「短剧末帧」这种没传类型的 PNG 就被记成音频，资产库按图片筛永远挑不到它。 */
const LOCAL_KIND_ALIAS = { image: '图片', video: '视频', audio: '音频' };
const LOCAL_KIND_BY_EXT = {
  png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片', bmp: '图片', avif: '图片',
  mp4: '视频', mov: '视频', webm: '视频', mkv: '视频', m4v: '视频',
  mp3: '音频', wav: '音频', m4a: '音频', aac: '音频', ogg: '音频', oga: '音频', flac: '音频',
  pcm: '音频', pcm16: '音频', opus: '音频',
};
function localMediaType(x) {
  if (!x) return '音频';
  const fmt = String(x.format || path.extname(x.file || '')).toLowerCase().replace(/^\./, '');
  if (LOCAL_KIND_BY_EXT[fmt]) return LOCAL_KIND_BY_EXT[fmt];
  const m = String((x && x.mime) || '').toLowerCase();
  if (m.startsWith('image/')) return '图片';
  if (m.startsWith('video/')) return '视频';
  if (m.startsWith('audio/')) return '音频';
  const given = String((x && x.media_type) || '').trim();
  return given ? (LOCAL_KIND_ALIAS[given.toLowerCase()] || given) : '音频';
}
/* 这一条产物「是什么时候有的」——**必须是生成时间，不是落盘时间**。
   镜像只是把平台上的产物搬到本机这一步：一次回源能把几百条老产物在同一天写进来，
   索引里的 created_at 于是全成了「今天」，按它倒序排就把资产库里唯一那张图片挤出
   选择器「全部」那一档的前 200 条（表现是「导演台开头画面切到『全部』，图片一张都不出现」）。
   落盘时留在索引里的 detail.created 才是那一件事真正发生的时间；本机自己生成的
   （逐句配音、同步产物）没有 detail，才退到 created_at。
   取不出一个能用时间就退回落盘时间，绝不返回空/0 —— 排在最底等于对界面说「没有这回事」。 */
function localAssetWhen(x) {
  const d = (x && typeof x.detail === 'object' && x.detail) || null;
  const raw = d && (d.created || d.completed);
  let v = raw;
  if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);           // 纯数字的时间串按数字判
  const ok = (typeof v === 'number' && v > 0)
    || (typeof v === 'string' && !isNaN(Date.parse(v)));
  return ok ? raw : ((x && x.created_at) || '');
}
/* 一份产物在本机资产库里的**身份**：来源外链的 host + path（+ 非易变的 query），签名参数一律不参与。
   为什么判据要放在代理这一层：镜像键 `sk_local_mirror` 存在浏览器 localStorage 里，而
   localStorage 是**按端口分家**的（5175 / 5199 / 6200 是三个源），换端口、清浏览器数据、开无痕
   都把那份索引一起清零 —— 于是每一次开页面都把**同一份产物**重新下载、重新落盘一份新文件。
   实测这台机器的索引里 290 行只对应 83 份产物（最多的一份重复 15 次，落盘时刻散在七个不同的
   会话里），磁盘 0.45 GB 中真正在用的只有 0.08 GB；而资产库 / 素材选择器看到的就是
   「同一个视频重复出现 N 张卡」。浏览器那一份只能挡同一个源，挡不住换源。
   「剥掉哪些签名参数」这条判据在 ident.js 里只有一份（浏览器那边 assetlib.js require 同一个文件）——
   以前这里是本文件自己抄的正则，注释写着「两边必须一致」却没有任何东西保证它一致，
   漂一次就是上面那个数字重新涨一遍。 */
function localUpKey(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return '';       // 这里只吃上游原始外链（meta.upstream），不会是 /getv 包装
  let x = null;
  try { x = new URL(s); } catch { return ''; }
  return MediaId.upKeyOf(x);
}
/* 索引里没有的字段才用新到的那份补上 —— 外链每次镜像的签名参数不同，但提示词 / 任务详情
   是同一件事；把已有非空值覆盖成空值等于「后到的那份把先到的信息弄丢了」。 */
const LOCAL_FILL_FIELDS = ['prompt', 'model', 'voice', 'priceText', 'upstream'];
function localFillMissing(old, inc) {
  let changed = false;
  for (const f of LOCAL_FILL_FIELDS) {
    if (!old[f] && inc[f]) { old[f] = inc[f]; changed = true; }
  }
  for (const f of ['duration', 'credits', 'chars']) {
    if (old[f] == null && inc[f] != null) { old[f] = inc[f]; changed = true; }
  }
  if (!old.usage && inc.usage) { old.usage = inc.usage; changed = true; }
  if (!old.detail && inc.detail) { old.detail = inc.detail; changed = true; }   // 生成时间在这里，缺了就只能回落盘时间
  return changed;
}
/* 按文件名补一条索引（文件名就是 <id>.<格式>），并写回索引 */
function localAssetRebuild(id) {
  const clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) return null;
  let files = [];
  try { files = fs.readdirSync(LOCAL_DIR); } catch { return null; }
  const f = files.find(x => x.startsWith(clean + '.'));
  if (!f) return null;
  let st = null;
  try { st = fs.statSync(path.join(LOCAL_DIR, f)); } catch { return null; }
  if (!st.isFile()) return null;
  const fmt = (path.extname(f).slice(1) || 'wav').toLowerCase();
  const mime = MIME['.' + fmt] || 'application/octet-stream';
  const item = {
    id: clean, file: f, name: f, mime, format: fmt,
    byte_length: st.size, created_at: st.mtime.toISOString(), media_type: localMediaType({ mime, format: fmt }),
    prompt: '', model: '', voice: '', provider: 'local', duration: null,
    credits: null, priceText: '', chars: null, usage: null, rebuilt: true,
  };
  const list = localIndexRead();
  list.unshift(item);
  /* 补建是**读**路径上的一步（文件就在眼前，条目已经拼好了），索引写不成也不该让读操作失败 ——
     真正需要「写不成就要报错」的是落盘那两条路（见 localIndexWrite 里的说明）。 */
  try { localIndexWrite(list.slice(0, LOCAL_INDEX_MAX)); }   // 补建与正常写入用同一个上限，别两处各写一个数
  catch (e) { log('[local-assets] 补建条目写索引失败（文件仍在，本次按读到的算）：' + e.message); }
  return item;
}
function localFileFromEntry(ent) {
  if (!ent || !ent.file) return null;
  const f = path.join(LOCAL_DIR, path.basename(ent.file));
  return fs.existsSync(f) ? f : null;
}
function localAssetFile(id) {
  return localFileFromEntry(localAssetEntry(id));
}
/* 本地文件读取：支持 Range（播放器可拖动进度），带长缓存（同一 id 内容恒定） */
/* 文件流 → 响应：读流出错（文件被删、被别的进程占用、磁盘读失败）时 pipe 只会抛一个没人接的 error，
   响应停在「200 头已发、正文永远不来」，页面只能干等到超时。这里把连接掐掉，让客户端立刻拿到网络错误。 */
function pipeFile(src, res) {
  src.on('error', () => { try { res.destroy(); } catch {} });
  src.pipe(res);
}
/* 带 Range 的本地文件响应（三个落盘目录 /asset、/render/play、/render/dl 共用一份）。
   headers 由调用方给（Content-Type / 缓存 / 附件名）。 */
function sendFileWithRange(req, res, file, headers) {
  const st = fs.statSync(file);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start, end;
    if (!m[1]) {
      /* bytes=-N：最后 N 字节。以前把这种情况当成「从头开始」，播放器探测文件尾部（moov 在尾部的 mp4）
         会拿到开头几百字节、判断出错。 */
      const n = parseInt(m[2], 10);
      if (!Number.isFinite(n) || n <= 0) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
      start = Math.max(0, st.size - n);
      end = st.size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : st.size - 1;
    }
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(206, headers);
    pipeFile(fs.createReadStream(file, { start, end }), res);
    return;
  }
  headers['Content-Length'] = String(st.size);
  res.writeHead(200, headers);
  pipeFile(fs.createReadStream(file), res);
}
/* entry 由调用方给时就不再全量读一遍索引：/asset/<id> 这条链手里已经握着 entry，
   以前却在这里又 localIndexRead() 一次 —— 页面上每一张缩略图、每一个 <video> 都打它，
   索引攒大之后就是每个媒体请求 2 次全量读盘解析。 */
function serveLocalFile(req, res, file, q, entry) {
  const base = path.basename(file);
  if (!entry) entry = localIndexRead().find(x => x && x.file === base) || {};
  const headers = {
    'Content-Type': entry.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (q && q.get('dl')) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(q.get('name') || entry.name || base);
  sendFileWithRange(req, res, file, headers);
}


const renders = new Map();          // id → job
const RENDER_KEEP = 30 * 60 * 1000;      // 任务记录保留 30 分钟（进度查询用），之后回收
const RENDER_CONCURRENCY = 1;            // 同时跑的渲染任务数：ffmpeg 很吃 CPU，串行最稳（可改大）
const OUT_KEEP = 20;                     // .renders 里最多保留最近 20 个成片，更早的自动删除
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
function runFfmpeg(args, onLine, jobId) {
  return new Promise((resolve, reject) => {
    /* 固定 cwd = 代理所在目录：字幕滤镜用的是相对路径（.renders/<id>/subs.ass），
       进程从别的目录启动时也能找到文件。 */
    const p = spawn('ffmpeg', args, { windowsHide: true, cwd: __dirname });
    trackProc(jobId, p);
    let err = '';
    p.stderr.on('data', d => {
      const s = d.toString();
      err += s;
      if (onLine) s.split(/\r?\n/).filter(Boolean).slice(-1).forEach(onLine);
      if (err.length > 20000) err = err.slice(-20000);
    });
    p.on('error', e => { untrackProc(jobId, p); reject(new Error('无法启动 ffmpeg：' + e.message + '（请确认已安装并加入 PATH）')); });
    p.on('close', code => {
      untrackProc(jobId, p);
      if (code === 0) resolve(err);
      else reject(new Error('ffmpeg 失败（退出码 ' + code + '）：' + err.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')));
    });
  });
}
/* ffprobe 也要能杀：给个 15 秒上限，坏文件不会把渲染卡死 */
function probe(args, jobId) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', args, { windowsHide: true });
    trackProc(jobId, p);
    let out = '';
    const done = v => { untrackProc(jobId, p); resolve(v); };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} done(''); }, 15000);
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => { clearTimeout(timer); done(out); });
    p.on('error', () => { clearTimeout(timer); done(''); });
  });
}
async function ffprobeDuration(file, jobId) {
  return parseFloat(await probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], jobId)) || 0;
}
async function hasAudioStream(file, jobId) {
  return (await probe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], jobId)).includes('audio');
}
let mediaPreparing = 0;
async function prepareReferenceVideo(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ error: { message: '视频预处理只接受 POST' } }));
    return;
  }
  if (mediaPreparing >= 2) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '正在处理其他参考视频，请稍后重试' } }));
    return;
  }
  mediaPreparing++;
  let dir = '', timer;
  const jid = 'media-' + require('crypto').randomUUID();
  const cancel = () => { if (!res.writableFinished) killJobProcs(jid); };
  res.on('close', cancel);
  try {
    const raw = await readBody(req, res, 200 * 1024 * 1024);
    if (raw == null || res.destroyed) return;
    if (!raw.length) throw new Error('参考视频为空');
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aii-reference-'));
    const input = path.join(dir, 'input');
    const output = path.join(dir, 'prepared.mp4');
    await fs.promises.writeFile(input, raw);
    // 禁止用户上传的播放列表让 ffmpeg 读取其他本机文件或网络地址。
    const safeInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,ogg,flv,mpegts'];
    const info = await probe(['-v', 'error', ...safeInput, '-show_entries', 'stream=codec_type', '-of', 'json', input], jid);
    if (res.destroyed) return;
    let streams;
    try { streams = JSON.parse(info).streams; } catch {}
    if (!Array.isArray(streams) || !streams.some(s => s.codec_type === 'video')) {
      throw new Error('无法识别视频，请使用有效的 MP4/MOV/WebM 文件，并确认 ffprobe 已安装');
    }
    if (streams.some(s => s.codec_type === 'audio')) {
      const mime = /^video\/[a-z0-9.+-]+$/i.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Audio-Added': '0' });
      res.end(raw);
      return;
    }
    timer = setTimeout(() => killJobProcs(jid), 120000);
    await runFfmpeg(['-nostdin', '-y', ...safeInput, '-i', input,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
      '-shortest', '-movflags', '+faststart', output], null, jid);
    if (res.destroyed) return;
    const st = await fs.promises.stat(output);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Audio-Added': '1' });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(output);
      const finish = () => { stream.destroy(); resolve(); };
      res.once('finish', finish);
      res.once('close', finish);
      stream.once('error', reject);
      stream.pipe(res);
    });
  } catch (e) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(422, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { message: '参考视频预处理失败：' + e.message } }));
    } else if (!res.destroyed) res.destroy();
  } finally {
    clearTimeout(timer);
    res.removeListener('close', cancel);
    killJobProcs(jid);
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    mediaPreparing--;
  }
}
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
function assetInfoOf(id, key) {
  const ck = id + '|' + keyTagOf(key);
  const hit = assetUrlCache.get(ck);
  if (hit && Date.now() - hit.ts < (hit.ttl || ASSET_URL_TTL)) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const up = upRequest(`${UPSTREAM}/api/open/v1/assets/${id}`, { headers: { authorization: 'Bearer ' + key } }, ur => {
      let b = '';
      ur.on('data', c => b += c);
      ur.on('end', () => {
        let d = null;
        try { d = JSON.parse(b); } catch {}
        const url = d && (d.url || d.download_url || (d.asset && (d.asset.url || d.asset.download_url)));
        if (!url) {
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
        const info = { ts: Date.now(), ttl: ASSET_URL_TTL, url, mime: (d && d.mime_type) || '' };
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
    const key = reqKey || keyOf('SPARKCINE_API_KEY');
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
/* 流式下载到文件：以前整段 arrayBuffer() 进内存，一个超大素材就能把代理进程吃掉几百 MB 到几 GB */
async function downloadTo(url, dest, hops) {
  /* 每一跳都重新过护栏：这一条以前用 fetch 的默认 redirect:'follow'，
     于是一个公网地址只要 302 到 http://127.0.0.1:5175/data/... 就绕过了 resolveSrc 的检查
     （代理自己的请求不带 Origin，同源拦截把本机调用当工具放行）。 */
  const depth = hops || 0;
  if (depth > 4) throw new Error('素材下载重定向次数过多（已中止）');
  let r;
  try {
    r = await fetch(url, { redirect: 'manual' });
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
   字幕烧录（/render 的 clip.subs）
   ---------------------------------------------------------------------------
   字幕**不是**视频平台生成的（那边出的片子没有字幕），而是由页面上的字幕组件按台词
   生成一条字幕轨，再交给本机的 ffmpeg 烧进画面（ffmpeg 带 libass + freetype + fontconfig，
   中文字幕直接可用）。

   时间轴一律**每段自带、相对该段自己的起点**（clips[i].subs[].start/end），
   偏移量由代理用 ffprobe 量每一段标准化后的**真实时长**累加得出 ——
   客户端自己累加会和实际时长差出零点几秒，字幕就会整体漂。
   ========================================================================== */
const SUB_MAX = 2000;                       // 单次渲染的字幕条数上限（防超大请求）
const VOICE_MAX = 40;                       // 单段配音条数上限（同一段台词条数；防超大请求）
const clampVol = (v, def) => Math.min(4, Math.max(0, v == null || Number.isNaN(Number(v)) ? (def == null ? 1 : def) : Number(v)));
const SUB_FONTS = ['Microsoft YaHei', '微软雅黑', 'SimHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Arial Unicode MS'];
/* ASS 时间格式 H:MM:SS.cc */
function assTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + (ss < 10 ? '0' : '') + ss.toFixed(2);
}
/* ASS 正文里 { } 是样式块、\ 是转义、换行要写成 \N */
function assText(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(').replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N')
    .trim();
}
/* 说话人配色：每个角色一种颜色，旁白用暖色（和参考产品一致：旁白一眼能认出来） */
const SUB_SPEAKER_COLORS = ['&H00FFFFFF', '&H0060E0FF', '&H00E0A0FF', '&H0080FF80', '&H00FFC060', '&H00E07070', '&H00C0C0FF', '&H00FFD0F0'];
function speakerStyleOf(name, idx) {
  const isNarr = /旁白|narrat/i.test(String(name || ''));
  return isNarr ? '&H00E8A0C8' : SUB_SPEAKER_COLORS[(idx || 0) % SUB_SPEAKER_COLORS.length];
}
/* 生成 ASS 文件内容：PlayRes 用成片尺寸，字号按高度缩放（竖屏 9:16 与横屏看起来一样大） */
function buildAss(events, width, height, fontName) {
  const fs_ = Math.max(18, Math.round(height * 0.055));
  const marginV = Math.max(24, Math.round(height * 0.09));
  const outline = Math.max(2, Math.round(fs_ * 0.09));
  /* 每个说话人一种颜色（按首次出现顺序分配 —— 同一集里同一个角色颜色稳定） */
  const styleOf = new Map();
  for (const ev of events) {
    const key = String(ev.speaker || '').trim() || '（画外）';
    if (!styleOf.has(key)) styleOf.set(key, { idx: styleOf.size, col: speakerStyleOf(key, styleOf.size) });
  }
  const nameOf = key => 'c' + styleOf.get(key).idx;
  const fmtLine = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+',
    'PlayResX: ' + width, 'PlayResY: ' + height,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: TV.709', '',
    '[V4+ Styles]', fmtLine,
  ];
  for (const [key, v] of styleOf) {
    lines.push('Style: ' + nameOf(key) + ',' + fontName + ',' + fs_ + ',' + v.col
      + ',&H000000FF,&H00202020,&H90000000,-1,0,0,0,100,100,0,0,1,' + outline + ',1,2,40,40,' + marginV + ',1');
  }
  lines.push('', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  for (const ev of events) {
    const who = String(ev.speaker || '').trim();
    const txt = assText(ev.text);
    if (!txt) continue;
    const key = who || '（画外）';
    lines.push('Dialogue: 0,' + assTime(ev.start) + ',' + assTime(Math.max(ev.start + 0.2, ev.end)) + ',' + nameOf(key)
      + ',' + who.replace(/,/g, ' ') + ',0,0,0,,' + (who ? who + '：' : '') + txt);
  }
  return lines.join('\n') + '\n';
}
/* 把每段自带的字幕（相对该段起点）按**真实时长**累加成一条整片字幕轨。
   偏移量用 ffprobe 量标准化后的实际时长 —— 客户端自己加会差零点几秒，字幕就整体漂。 */
async function collectSubEvents(clips, parts, jid) {
  const events = [];
  let base = 0;
  for (let i = 0; i < clips.length && events.length < SUB_MAX; i++) {
    const list = Array.isArray(clips[i] && clips[i].subs) ? clips[i].subs : [];
    for (const s of list) {
      const t0 = base + Math.max(0, Number(s.start) || 0);
      const t1 = base + Math.max(0, Number(s.end) || 0);
      if (t1 > t0 + 0.05) events.push({ start: t0, end: t1, text: s.text, speaker: s.speaker });
    }
    if (i < parts.length) {
      const d = await ffprobeDuration(parts[i], jid);
      if (d > 0) base += d;
    }
  }
  return events.slice(0, SUB_MAX);
}

/* 逐句配音 → 这一段自己的音轨文件（统一 aac/48k/双声道，concat 才能直拼）。
   底噪永远是 anullsrc 静音轨，平台自带的人声按 clip.volume 混进来（短剧一般传 0：
   台词是逐句合成的，平台自己生成的那路声音会和它打架）。每条配音按自己的 start 延迟后混，
   normalize=0 很重要 —— 默认 amix 会按输入数把每路音量除下去，配音会越加越小。
   末尾 apad + atrim：混出来的长度要么比画面长（最后一句拖出段外）要么短（句子之间的空隙），
   都按这一段的 span 补齐/截断，音画才对得齐。 */
async function buildClipAudio(dir, i, f, span, speed, jid) {
  const out = path.join(dir, `aud_${i}.m4a`);
  const S = Math.max(0.1, span).toFixed(3);
  const voices = f.voices || [];
  const hasNative = !f.black && f.file && (await hasAudioStream(f.file, jid));
  const args = ['-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${S}`];
  if (hasNative) args.push('-ss', String(Math.max(0, Number(f.in) || 0)), '-t', String(span), '-i', f.file);
  for (const v of voices) args.push('-i', v.file);
  const chain = ['[0:a]volume=0[sil]'];
  const ins = ['[sil]'];
  let n = 1;
  if (hasNative) {
    chain.push(`[${n}:a]volume=${clampVol(f.volume, 1)}[o]`);
    ins.push('[o]'); n++;
  }
  for (const v of voices) {
    const ms = Math.max(0, Math.round(v.start * 1000));
    /* 新版 adelay 的第二个值是布尔 all（不是「两端各自的毫秒」）：adelay=delays=300:all=1 */
    chain.push(`[${n}:a]adelay=delays=${ms}:all=1,volume=${v.vol}[v${n}]`);
    ins.push(`[v${n}]`); n++;
  }
  chain.push(`${ins.join('')}amix=inputs=${ins.length}:duration=longest:normalize=0[m]`);
  /* 变速时画面用 setpts 拉长/压短，音轨要同样变速才音画对得上 */
  const sp = Math.min(4, Math.max(0.25, Number(speed) || 1));
  chain.push(`[m]apad=whole_dur=${S},atrim=end=${S}${sp !== 1 ? `,atempo=${Math.min(2, Math.max(0.5, sp))}` : ''}[aout]`);
  await runFfmpeg([...args, '-filter_complex', chain.join(';'), '-map', '[aout]',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', out], null, jid);
  return out;
}

async function renderJob(job) {
  const dir = path.join(RENDER_DIR, job.id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { job.state = 'failed'; job.err = '无法创建渲染目录：' + e.message; return; }
  const jid = job.id;                    // 本任务的子进程都挂到这个号上（取消时按号杀，见 killJobProcs）
  const { clips, width, height, fps, crf, bgm } = job.spec;
  const hasSubs = clips.some(c => c && Array.isArray(c.subs) && c.subs.some(s => s && String(s.text || '').trim()));
  // 渲染途中被取消：每一步之间检查一次，及时退出（而不是跑完整个片子）
  const abortIfCancelled = () => {
    if (job.state === 'cancelled') throw new Error('已取消');
  };
  try {
    job.stage = '下载素材'; job.progress = 2;
    const files = [];
    for (let i = 0; i < clips.length; i++) {
      abortIfCancelled();
      const c = clips[i];
      /* 逐句配音先取回来（黑场段也可能有旁白，所以放在 black 判断之前）。
         每条 = { src, start, dur, vol }，start 相对**该段起点**（与 subs 同一套约定，
         绝对偏移由这一段的 span 决定，客户端自己加会漂）。 */
      const vFiles = [];
      const voices = Array.isArray(c.voices) ? c.voices : [];
      for (let k = 0; k < voices.length; k++) {
        abortIfCancelled();
        const v = voices[k];
        const vurl = await resolveSrc(v.src, job.key);
        const vext = (/\.([a-z0-9]{3,4})(\?|$)/i.exec(vurl) || [])[1] || 'mp3';
        const vdest = path.join(dir, `voice_${i}_${k}.${vext}`);
        await downloadTo(vurl, vdest);
        vFiles.push({ file: vdest, start: Math.max(0, Number(v.start) || 0), dur: Math.max(0.1, Number(v.dur) || 0), vol: clampVol(v.vol, 1) });
      }
      if (vFiles.length) job.log.push(`[${i + 1}/${clips.length}] 配音 ${vFiles.length} 句`);
      if (String(c.src) === 'black') {   // 黑场：不下载，用 lavfi 生成
        files.push({ ...c, file: null, black: true, size: 0, voices: vFiles });
        job.log.push(`[${i + 1}/${clips.length}] 黑场 ${((Number(c.out) - Number(c.in)) || 1).toFixed(1)}s`);
        continue;
      }
      const url = await resolveSrc(c.src, job.key);
      const ext = (/\.([a-z0-9]{3,4})(\?|$)/i.exec(url) || [])[1] || 'mp4';
      const dest = path.join(dir, `src_${i}.${ext}`);
      const size = await downloadTo(url, dest);
      files.push({ ...c, file: dest, size, voices: vFiles });
      job.progress = 2 + Math.round(((i + 1) / clips.length) * 33);
      job.log.push(`[${i + 1}/${clips.length}] 已下载 ${(size / 1048576).toFixed(2)} MB`);
    }
    /* 音频策略分两种：
       · 没有逐句配音 → 沿用老规矩「所有片段都有音轨才保留，否则整片静音」（避免 concat 混流失败）
       · 有逐句配音   → **每一段都单独铺一条统一规格的音轨**（没原声就垫静音底），
         否则「一段有声、一段无声」会让 concat 整片静音，配音跟着整段消失。 */
    const hasVoice = files.some(f => (f.voices || []).length);
    let keepAudio = true;
    for (const f of files) { if (f.black || !(await hasAudioStream(f.file, jid))) { keepAudio = false; break; } }
    if (hasVoice) keepAudio = true;
    job.keepAudio = keepAudio;
    job.stage = keepAudio ? '逐段标准化（保留音频）' : '逐段标准化（静音）';

    const parts = [];
    for (let i = 0; i < files.length; i++) {
      abortIfCancelled();
      const f = files[i];
      const out = path.join(dir, `norm_${i}.mp4`);
      const vfBase = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1', `fps=${fps}`, 'format=yuv420p',
      ].join(',');
      /* 这一段在成片里占多长：黑场按声明的 out-in，其余用 ffprobe 出来的真实时长把 out 夹紧
         （平台给的 duration 常常比实际文件长，不夹会在片尾多出一段黑）。 */
      const inP = Math.max(0, Number(f.in) || 0);
      let span = Math.max(0.1, (Number(f.out) || 1) - inP);
      if (!f.black) {
        const dur = await ffprobeDuration(f.file, jid);
        let outP = f.out != null && Number(f.out) > inP ? Number(f.out) : dur;
        if (dur && outP > dur + 0.05) outP = dur;
        span = Math.max(0.1, outP - inP);
      }
      const speed = Math.min(4, Math.max(0.25, Number(f.speed) || 1));
      /* 有逐句配音 → 这一段单独铺一条统一规格的音轨（黑场段也铺：旁白本来就配在黑场上） */
      const audFile = hasVoice ? await buildClipAudio(dir, i, f, span, speed, jid) : null;
      if (f.black) {
        /* 输入必须全排在输出选项之前：'-i' 推在 '-vf'/'-c:v' 后面会被 ffmpeg 当成
           「给已声明完输出的文件再开一个输入」，直接报 Invalid argument。 */
        const a = ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${span}:r=${fps}`];
        if (audFile) a.push('-i', audFile);
        a.push('-vf', vfBase, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf));
        if (audFile) a.push('-map', '0:v', '-map', '1:a', '-c:a', 'copy');
        else a.push('-an');
        a.push(out);
        await runFfmpeg(a, null, jid);
        parts.push(out);
        job.progress = 35 + Math.round(((i + 1) / files.length) * 45);
        job.log.push(`[${i + 1}/${files.length}] 黑场已生成 ${fmtTime(span)}${audFile ? '（含配音）' : ''}`);
        continue;
      }
      const vf = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `fps=${fps}`,
        speed !== 1 ? `setpts=PTS/${speed}` : null,
        'format=yuv420p',
      ].filter(Boolean).join(',');
      const args = ['-y', '-ss', String(inP), '-t', String(span), '-i', f.file];
      if (audFile) args.push('-i', audFile);
      args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf));
      if (audFile) args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-ar', '48000', '-ac', '2');
      else if (keepAudio) {
        const vol = clampVol(f.volume, 1);
        args.push('-af', `volume=${vol}${speed !== 1 ? ',atempo=' + Math.min(2, Math.max(0.5, speed)) : ''}`, '-c:a', 'aac', '-ar', '48000', '-ac', '2');
      } else args.push('-an');
      args.push(out);
      await runFfmpeg(args, line => { if (line.includes('time=')) job.log.push('  ' + line.trim().slice(-60)); }, jid);
      parts.push(out);
      job.progress = 35 + Math.round(((i + 1) / files.length) * 45);
      job.log.push(`[${i + 1}/${files.length}] 已标准化 ${fmtTime(span)}${speed !== 1 ? '（' + speed + '×）' : ''}`);
      if (job.log.length > 120) job.log.splice(0, job.log.length - 120);
    }
    // 拼接（已统一编码参数，可直接 copy）
    abortIfCancelled();
    job.stage = '拼接成片';
    const listFile = path.join(dir, 'concat.txt');
    fs.writeFileSync(listFile, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    // 成片名带上任务号后缀：同名任务并发时不再互相覆盖
    const outName = (job.name || '成片') + '-' + job.id.slice(-4) + '.mp4';
    const outPath = path.join(RENDER_DIR, outName);
    /* 字幕轨：clips[i].subs 各自相对本段起点，这里按真实时长累加成整片时间轴。
       有字幕就得**重新编码画面**（叠加滤镜与 -c copy 互斥），没有字幕仍是原来的直拼，速度不受影响。 */
    let subFilter = '';
    if (hasSubs) {
      job.stage = '烧字幕';
      const events = await collectSubEvents(clips, parts, jid);
      if (events.length) {
        const font = SUB_FONTS.indexOf(job.spec.subFont) >= 0 ? job.spec.subFont : SUB_FONTS[0];
        const assFile = path.join(dir, 'subs.ass');
        fs.writeFileSync(assFile, buildAss(events, width, height, font), 'utf8');
        /* 字幕文件走**相对代理目录**的路径：Windows 的绝对路径带盘符，ffmpeg 的滤镜参数里
           冒号要转义成 C\:，实测那条路读不到文件（报 original_size 非法）；
           相对路径没有冒号，干净得多。为此 runFfmpeg 固定以 __dirname 为 cwd。 */
        const rel = path.relative(__dirname, assFile).replace(/\\/g, '/');
        subFilter = 'ass=' + rel;
        job.log.push('字幕 ' + events.length + ' 条，字号按 ' + height + 'p 自适应（' + font + '）');
        job.progress = Math.max(job.progress, 85);
      }
    }
    const concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy'];
    if (subFilter) {
      // 叠字幕：画面重新编码，音频仍然直拷
      const vArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', subFilter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf)];
      if (keepAudio) vArgs.push('-c:a', 'copy'); else vArgs.push('-an');
      vArgs.push(outPath);
      if (bgm) {
        const bgmFile = path.join(dir, 'bgm' + (path.extname(bgm) || '.mp3'));
        await downloadTo(await resolveSrc(bgm, job.key), bgmFile);
        await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-stream_loop', '-1', '-i', bgmFile,
          '-filter_complex', '[0:v]' + subFilter + '[v];[1:a]volume=0.35[bg];[0:a][bg]amix=inputs=2:duration=first[a]',
          '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-c:a', 'aac', '-shortest', outPath], null, jid);
      } else {
        await runFfmpeg(vArgs, null, jid);
      }
    } else if (bgm) {
      // 可选背景音乐：与成片混音（原声压低）
      const bgmFile = path.join(dir, 'bgm' + (path.extname(bgm) || '.mp3'));
      await downloadTo(await resolveSrc(bgm, job.key), bgmFile);
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-stream_loop', '-1', '-i', bgmFile,
        '-filter_complex', '[1:a]volume=0.35[bg];[0:a][bg]amix=inputs=2:duration=first[a]',
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outPath], null, jid);
    } else {
      await runFfmpeg([...concatArgs, outPath], null, jid);
    }
    rmrf(dir);
    const size = fs.statSync(outPath).size;
    job.progress = 100; job.state = 'done'; job.stage = '完成';
    job.out = outName; job.size = size; job.ts = Date.now();
    job.log.push(`✓ 成片完成：${outName}（${(size / 1048576).toFixed(1)} MB）`);
    log(`[render] ✓ ${outName} ${(size / 1048576).toFixed(1)} MB`);
    pruneRenders();
  } catch (e) {
    const cancelled = job.state === 'cancelled';
    job.state = cancelled ? 'cancelled' : 'failed';
    job.err = cancelled ? '' : e.message;
    job.log.push(cancelled ? '✗ 已取消' : ('✗ ' + e.message));
    log(`[render] ${cancelled ? '✗ 已取消' : '✗ ' + e.message}`);
    rmrf(dir);
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
    renderJob(job).catch(e => log('[render] 任务异常：' + e.message)).finally(() => { renderRunning--; pumpRenderQueue(); });
  }
}
function enqueueRender(job) {
  job.state = 'queued';
  renderQueue.push(job);
  refreshQueuePos();
  pumpRenderQueue();
}
/* 每 5 分钟回收：过期的任务记录、以及 .renders 里超出保留数的老成片 */
function pruneRenders() {
  const now = Date.now();
  renders.forEach((job, id) => {
    const done = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
    if (done && job.ts && now - job.ts > RENDER_KEEP) renders.delete(id);
  });
  try {
    const files = fs.readdirSync(RENDER_DIR).filter(f => f.endsWith('.mp4'))
      .map(f => ({ f, ts: fs.statSync(path.join(RENDER_DIR, f)).mtimeMs }))
      .sort((a, b) => b.ts - a.ts);
    files.slice(OUT_KEEP).forEach(x => { rmrf(path.join(RENDER_DIR, x.f)); log('[render] 清理旧成片 ' + x.f); });
    // 渲染中途崩溃留下的临时目录（非 30 位任务号形态的目录）
    fs.readdirSync(RENDER_DIR).forEach(d => {
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

/* 在请求分发里调用：处理 /render* 相关请求，返回 true 表示已处理 */
function handleRender(req, res, pathname, urlObj) {
  if (req.url.startsWith('/render/status')) {
    const id = urlObj.searchParams.get('id');
    const job = renders.get(id);
    if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"任务不存在"}'); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ id: job.id, state: job.state, progress: job.progress, stage: job.stage,
      out: job.out, size: job.size, err: job.err, keepAudio: job.keepAudio, queuePos: job.queuePos,
      log: (job.log || []).slice(-14) }));
    return true;
  }
  if (req.url.startsWith('/render/cancel')) {
    // 取消渲染：杀掉正在跑的 ffmpeg 子进程，并从队列里摘掉
    const id = urlObj.searchParams.get('id');
    const job = renders.get(id);
    if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"任务不存在"}'); return true; }
    job.state = 'cancelled';
    const qi = renderQueue.indexOf(job);
    if (qi >= 0) renderQueue.splice(qi, 1);
    const killed = killJobProcs(id);
    log(`[render] 取消 ${id}（杀掉 ${killed} 个 ffmpeg 进程）`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, id, killed }));
    return true;
  }
  if (req.url.startsWith('/render/play')) {
    const name = path.basename(urlObj.searchParams.get('name') || '');
    const f = path.join(RENDER_DIR, name);
    if (!name || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    /* 要支持 Range：<video> 拖动进度、以及 ffmpeg 产出「moov 在尾部」的 mp4 都会发 Range 请求。
       以前这里写死 Accept-Ranges: none 并整文件推出去，播放器只能从头缓冲，拖进度条就卡住。 */
    sendFileWithRange(req, res, f, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    return true;
  }
  if (req.url.startsWith('/render/dl')) {
    const name = path.basename(urlObj.searchParams.get('name') || '');
    const f = path.join(RENDER_DIR, name);
    if (!name || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    sendFileWithRange(req, res, f, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"' });
    return true;
  }
  if (req.url.startsWith('/render') && req.method === 'POST') {
    readBody(req, res, 8 * 1024 * 1024).then(buf => {
      if (buf == null) return;                    // 超限已回 413
      let spec = null;
      try { spec = JSON.parse(buf.toString('utf8')); } catch {}
      if (!spec || !Array.isArray(spec.clips) || !spec.clips.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"缺少 clips"}'); return;
      }
      if (spec.clips.length > 500) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"片段过多（上限 500 段）"}'); return;
      }
      // 队列上限：避免一次性提交几百个渲染任务把 CPU 与磁盘占满
      if (renderQueue.length + renderRunning >= 20) {
        res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"渲染任务排队过多，稍后再试"}'); return;
      }
      const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const job = {
        id, state: 'queued', progress: 1, stage: '排队', log: [], out: null, err: null, size: 0, ts: Date.now(),
        key: (req.headers.authorization || '').replace(/^Bearer\s*/, '') || keyOf('SPARKCINE_API_KEY'),
        name: (spec.name || '成片').replace(/[\\/:*?"<>|]/g, '-'),
        spec: {
          /* clips 里额外放行 subs（该段自带的字幕轨，时间相对本段起点）与 volume；
             voices 是这一段的**逐句配音**（同样相对本段起点，合成时按各自的 start 延迟混进去）。
             三者都只做形状校验，取值范围在 renderJob 里夹紧 —— 不要在这里直接信任客户端 */
          clips: spec.clips.map(c => ({
            src: c && c.src, in: c && c.in, out: c && c.out, speed: c && c.speed, volume: c && c.volume,
            voices: (c && Array.isArray(c.voices) ? c.voices.slice(0, VOICE_MAX) : []).map(v => ({
              src: String(v && v.src || '').slice(0, 2000), start: Math.max(0, Number(v && v.start) || 0),
              dur: Math.max(0, Number(v && v.dur) || 0), vol: Number.isFinite(Number(v && v.vol)) ? Number(v.vol) : 1,
            })).filter(v => v.src),
            subs: (c && Array.isArray(c.subs) ? c.subs.slice(0, SUB_MAX) : []).map(s => ({
              start: Math.max(0, Number(s.start) || 0), end: Math.max(0, Number(s.end) || 0),
              text: String(s.text == null ? '' : s.text).slice(0, 200), speaker: String(s.speaker == null ? '' : s.speaker).slice(0, 40),
            })),
          })),
          width: Math.max(64, Math.min(4096, parseInt(spec.width) || 1280)),
          height: Math.max(64, Math.min(4096, parseInt(spec.height) || 720)),
          fps: Math.max(12, Math.min(60, parseInt(spec.fps) || 30)),
          crf: Math.max(14, Math.min(32, parseInt(spec.crf) || 20)),
          bgm: spec.bgm || null,
          subFont: String(spec.subFont || '').slice(0, 60),
        },
      };
      renders.set(id, job);
      pruneRenders();
      log(`[render] 新任务 ${id}：${job.spec.clips.length} 段 → ${job.spec.width}×${job.spec.height}@${job.spec.fps}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id }));
      enqueueRender(job);
    });
    return true;
  }
  return false;
}


/* 列表接口短缓存（模块级：跨请求复用） */
const listCache = new Map();   // url → { ts, status, headers, body }
const detailCache = new Map(); // 单条任务详情（已完成的）短缓存：url → { ts, status, headers, body }
const DETAIL_TTL = 5 * 60 * 1000;
const LIST_CACHE_MAX = 60;     // 列表缓存条数上限，防止长时间运行无限增长
const LIST_CACHE_BYTES = 64 * 1024 * 1024;    // 字节上限（单条最大 8 MiB，条数封顶挡不住总量）
const DETAIL_CACHE_BYTES = 64 * 1024 * 1024;  // 同上（单条最大 2 MiB）
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
const DATA_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const dataDirPath = () => path.resolve(__dirname, process.env.DATA_DIR || '.data');
const dataFileOf = key => path.join(dataDirPath(), key + '.json');
/* ---------- 本机依赖体检（GET /sys-status，只同源） ----------
   短剧导出成片要 ffmpeg。没装 / 装了不在 PATH / 装的是 Windows 商店那个占位壳，
   三种在界面上都只剩「无法启动 ffmpeg」一句 —— 现在导出前就能看见是哪一种。
   探测要起子进程，所以进程期内只探一次并缓存；?fresh=1 强制重探
   （刚改完 PATH 的人不该被迫重启代理才能看到变化）。 */
let _sysStatus = null;
function firstLine(s) { return String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || ''; }
const cap120 = s => (s.length > 120 ? s.slice(0, 120) + '…' : s);
function probeTool(cmd) {
  let r = null;
  try { r = spawnSync(cmd, ['-version'], { windowsHide: true, cwd: __dirname, timeout: 6000, encoding: 'utf8' }); }
  catch (e) { return { ok: false, why: '探测本身出错：' + ((e && e.message) || e) }; }
  if (!r) return { ok: false, why: '探测没返回' };
  if (r.error) return { ok: false, why: r.error.code === 'ENOENT' ? '没装，或者不在 PATH 里' : ('起不动：' + (r.error.message || r.error.code || r.error)) };
  if (r.signal) return { ok: false, why: '6 秒没回话被停掉（装了，但一跑就卡住）' };
  /* Windows 的「应用执行别名」会放一个占位 ffmpeg.exe：它确实能启动，只是退出来并留一句
     「还没安装」。这一句比「退出码 9009」有用得多，所以把工具自己说的话带回去。 */
  if (r.status !== 0) {
    const say = firstLine(r.stderr) || firstLine(r.stdout);
    return { ok: false, why: '退出码 ' + r.status + '：' + (say ? cap120(say) : '装了，但它跑不起来（PATH 里可能指向的不是真二进制）') };
  }
  const line = firstLine(r.stdout) || firstLine(r.stderr);
  /* -version 的横幅走 stdout；少数构建（以及那个占位壳）走 stderr，两个都试才拿得到版本行 */
  if (!/^ffmpeg|^ffprobe/i.test(line)) return { ok: false, why: '它没报出 ffmpeg 的版本行，八成不是同一个东西：' + cap120(line) };
  return { ok: true, 版本: line.slice(0, 90) };
}
function dirState(dir) {
  let st = null;
  try { st = fs.statSync(dir); } catch (e) { return { 路径: dir, 状态: '还没建（第一次用到时代理自己会建）' }; }
  if (!st.isDirectory()) return { 路径: dir, 状态: '路径上有个同名的文件，不是目录 —— 要移走它' };
  try { fs.accessSync(dir, fs.constants.W_OK); } catch (e) { return { 路径: dir, 状态: '存在但写不进去（只读、权限，或被别的进程占着）' }; }
  return { 路径: dir, 状态: '可写' };
}
function sysStatus(fresh) {
  /* 出站代理那一段每次现算（它 30 秒一份缓存、跟着代理软件开关变），不跟着整份体检结果一起缓存 */
  const px = outboundProxy();
  const proxyField = {
    状态: px.cfg ? ('走 ' + px.cfg.label) : '直连',
    来源: px.src || '没检测到（环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 与 Windows 系统代理都没有）',
    绕过: '回环 / 内网 / 链路本地地址与 NO_PROXY 里列的一律直连；.env 里写 PROXY_OFF=1 可整体关掉',
  };
  if (_sysStatus && !fresh) { _sysStatus.出站代理 = proxyField; return _sysStatus; }
  _sysStatus = {
    at: Date.now(),
    代理: { 版本: REGISTRY.version, 端口: PORT, 目录: __dirname, 进程: process.version },
    出站代理: proxyField,
    ffmpeg: probeTool('ffmpeg'),
    ffprobe: probeTool('ffprobe'),
    目录: { 数据: dirState(dataDirPath()), 资产: dirState(path.resolve(LOCAL_DIR)), 渲染: dirState(path.resolve(RENDER_DIR)) },
  };
  return _sysStatus;
}
function dataList() {
  try {
    const dir = dataDirPath();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      // *.bak.json 是覆盖前的冲突备份：留在盘上供人工找回，但不参与清单/同步/云上传
      // 点开头的（.cloud-state.json = 云同步基线）是代理自己的内部状态，同样不参与
      .filter(f => f.endsWith('.json') && !f.endsWith('.bak.json') && !f.startsWith('.'))
      .map(f => {
        /* 单个文件 stat 失败（Windows 上正被另一个进程写、或刚被删掉）不能让整张清单变成空 ——
           以前 statSync 在 try 外面，一个坏文件就跳到 catch 返回 []，
           客户端据此以为「服务器什么都没有」，于是把本地数据全量补传，云端较新那份被顶掉。 */
        try {
          const st = fs.statSync(path.join(dir, f));
          return { key: f.slice(0, -5), size: st.size, mtime: st.mtimeMs };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));
  } catch { return []; }
}
/* 覆盖 / 删除之前把旧内容留一份 <key>.bak.json。
   浏览器侧每一次写都是「最后写入者赢」：一个刚打开的页面、一个全新的浏览器上下文，
   只要在对账拉回真实数据之前写了一次它自己那份，整份用户数据就被顶掉了，
   而原先除了云同步之外没有任何找回路径（收藏就是被这样清空的）。
   这份 .bak.json 设置页「数据与备份」能列出并一键恢复（走 /cloud/backups + /cloud/restore），
   不参与清单与同步（dataList 已过滤 *.bak.json）。
   一份备份至少留 BAK_KEEP_MS：连着几次误写不会把唯一那份好数据顶掉。 */
const BAK_KEEP_MS = 10 * 60 * 1000;
function keepDataBackup(key, nextBuf) {
  if (/\.bak$/.test(key)) return true;                // 备份本身不再备份（云同步已自己留过一份）
  /* 备份失败要报出来：调用方（覆盖/删除用户数据的那几条路由）据此中止写入。
     界面已经承诺「覆盖前会留一份」，备份没成还照样覆盖 = 无提示地丢掉用户配置与密钥。 */
  const cur = dataFileOf(key), bak = dataFileOf(key + '.bak');
  let old;
  try { if (!fs.existsSync(cur)) return true; old = fs.readFileSync(cur); } catch { return true; }
  if (nextBuf && nextBuf.equals(old)) return true;         // 写的内容和本机这份一模一样 → 没什么可备份的
  try {
    if (fs.existsSync(bak)) {
      if (Date.now() - fs.statSync(bak).mtimeMs < BAK_KEEP_MS) return true;   // 刚留过，那份更旧也更值钱
      if (fs.readFileSync(bak).equals(old)) return true;                      // 内容没变，不用重复留
    }
    fs.writeFileSync(bak, old);
    return true;
  } catch (e) {
    log('[data] 备份旧内容失败 ' + key + '：' + e.message);
    return false;
  }
}
function dataWriteRaw(key, buf) {
  const dir = dataDirPath();
  fs.mkdirSync(dir, { recursive: true });
  /* 覆盖已有内容前先备份成功；备不出来就不写（宁可这次同步失败，也不能无声覆盖掉唯一的一份） */
  if (!keepDataBackup(key, buf)) throw new Error('覆盖前备份失败（磁盘满 / 文件被占用），已中止写入：' + key);
  /* 临时名带 pid + 随机串：同一个键并发写时各自写各自的临时文件，
     否则两个请求共用 <key>.json.tmp，可能把两份内容混着 rename 出去。 */
  const tmp = dataFileOf(key) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dataFileOf(key));   // 原子替换
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
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
   写成裸 `save` 时结尾的 `(?:[/?]|$)` 匹配不上 `-`，于是这两条会**整条漏出同源检查**。 */
const LOCAL_ONLY = /^\/(?:data|cloud|capabilities|prompts|local-assets|save(?:-(?:local|move))?|pick-dir|env-status|sys-status|clear-cache|render|media|s3put|getv|getfile|fetch|custom)(?:[/?]|$)/;
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

/* ============================================================================
   提示词归档（/prompts）—— 每次创建任务，把提示词存成归档文件夹里的一份文件
   ---------------------------------------------------------------------------
   上游接口基本都不返回提示词（VGENV 连列表和详情里都没有），本机留一份最省事；
   存成文件夹里的 md 而不是 localStorage，是因为它看得见、能搜索、能备份、能喂给别的工具。
     POST /prompts        写一份归档（标题 / 类型 / 时间 / 平台 / 模型 / 任务号 + 提示词正文）
     GET  /prompts        目录信息 + 最近归档清单（设置页展示）
     GET  /prompts/find   按「平台 + 任务号」取回提示词（给不返回 prompt 的平台补显示）
     POST /prompts/open   用系统文件管理器打开归档目录
     POST /prompts/export 导出全部归档（{name,text} 数组）—— 整包备份勾「连提示词归档」时走这条
     POST /prompts/import 恢复归档（**一份也不覆盖**，撞名的报出来）
   目录：请求里的 dir > .env 的 PROMPTS_DIR > 项目下的 prompts/（设置页可改）。
   文件名：<时间>-<类型>-<标题>.md；标题由文字 AI 生成，没有文字 AI 就取提示词前 10 个字。
   ========================================================================== */
const promptsDefaultDir = () => path.resolve(__dirname, process.env.PROMPTS_DIR || 'prompts');
const PROMPT_INDEX = '_index.json';        // 目录内的索引；没有就按各文件头部（front matter）重建
/* 目录名：~ 开头按用户主目录展开，其余按（相对项目目录的）绝对路径解析 */
function promptsDir(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return promptsDefaultDir();
  if (s.indexOf(String.fromCharCode(0)) >= 0) throw new Error('目录里有非法字符');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const p = (/^~($|[\\/])/.test(s) && home) ? path.join(home, s.slice(1)) : s;
  const abs = path.resolve(p);
  /* 归档目录是浏览器递来的参数（设置页可填、GET /prompts?dir= 也能指定），限定在本项目目录
     或用户目录之下：否则任何同源的请求都能把这台机器上任意位置的 .md 列出来、或往里写文件。 */
  const roots = [path.resolve(__dirname)];
  if (home) roots.push(path.resolve(home));
  const outside = roots.some(r => abs === r || abs.startsWith(r + path.sep));
  if (!outside) throw new Error('提示词目录只能在项目目录或用户目录之下：' + abs);
  return abs;
}
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
const dirStamp = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
const timeText = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const o = {};
  m[1].split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return o;
}
const promptIndexPath = dir => path.join(dir, PROMPT_INDEX);
function readPromptIndex(dir) {
  try {
    const a = JSON.parse(fs.readFileSync(promptIndexPath(dir), 'utf8'));
    return Array.isArray(a) ? a : null;
  } catch { return null; }        // null = 还没有索引（首次用 / 被删）→ 调用方重建
}
function writePromptIndex(dir, rows) {
  try { fs.writeFileSync(promptIndexPath(dir), JSON.stringify(rows.slice(0, 2000))); }
  catch (e) { log('[prompts] 索引写入失败：' + e.message); }
}
/* 只读文件头 1KB（front matter 在最前面），不必把整份提示词读进来 */
function promptMetaOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return parseFrontMatter(buf.slice(0, n).toString('utf8'));
  } catch { return null; }
}
/* 索引丢了或第一次用：扫一遍目录重建（顺带取回提示词正文，供「资产库补显示」用） */
function rebuildPromptIndex(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  const rows = [];
  files.forEach(f => {
    const o = promptMetaOf(path.join(dir, f));
    if (!o) return;
    let pr = '';
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const i = text.indexOf('## 提示词');
      if (i >= 0) pr = text.slice(i + '## 提示词'.length).replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch {}
    rows.push({ f, t: o.title || '', k: o.type || '', ts: Number(o.ts) || 0,
      p: o.provider || '', m: o.model || '', i: o.task || '', pr });
  });
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  writePromptIndex(dir, rows);
  return rows;
}
const promptRows = dir => readPromptIndex(dir) || rebuildPromptIndex(dir);

/* 按任务号兜底查一份归档：索引只留最近 2000 条（writePromptIndex 会截断），
   窗口外的老归档不在里面。不补这一步的话，「本机明明归档了」的老任务会被判成没有归档，
   客户端把它记进 missed 之后同一标签页再也不问 —— 那份归档就再也回不来了。
   只读每个文件头 1KB 比对 task，命中了才把正文读出来（比全量重建便宜得多）。 */
function scanPromptTask(dir, id, cap) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (out.length >= (cap || 50)) break;
    const o = promptMetaOf(path.join(dir, f));
    if (!o || String(o.task || '') !== id) continue;
    let pr = '';
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const i = text.indexOf('## 提示词');
      if (i >= 0) pr = text.slice(i + '## 提示词'.length).replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch {}
    out.push({ f, t: o.title || '', k: o.type || '', ts: Number(o.ts) || 0,
      p: o.provider || '', m: o.model || '', i: o.task || '', pr });
  }
  return out;
}

function handlePrompts(req, res, urlObj) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  let dir;
  try { dir = promptsDir(urlObj.searchParams.get('dir')); }
  catch (e) { json(400, { error: { message: e.message } }); return true; }
  const where = urlObj.pathname.replace(/^\/prompts\/?/, '');
  const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  if (req.method === 'GET' && !where) {
    const rows = promptRows(dir);
    // 顺带回一段索引（含提示词前 300 字）：客户端据此给「平台不返回提示词」的任务补显示
    const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit')) || 300, 1), 2000);
    json(200, { dir, defaultDir: promptsDefaultDir(), count: rows.length, recent: rows.slice(0, limit) });
    return true;
  }
  if (req.method === 'GET' && where === 'find') {
    const id = String(urlObj.searchParams.get('id') || '');
    const prov = String(urlObj.searchParams.get('provider') || '');
    if (!id) { json(400, { error: { message: '缺少 id（任务号）' } }); return true; }
    /* 本机生成的资产（/local-assets 存的 la_xxx：逐句配音、预演音轨…）压根没有上游任务号，
       按任务号去归档里找必然落空 —— 于是每开一次资产库/语音台/用量页就是一串 404。
       它们的提示词本来就存在本机索引里（保存时写进了 meta.prompt），直接回那份。 */
    if (/^la_[A-Za-z0-9]+$/.test(id)) {
      const it = localAssetEntry(id);
      json(200, { ok: true, id, matched: 1, local: true, provider: (it && it.provider) || '',
        file: (it && it.file) || '', title: (it && it.name) || '', type: 'local', prompt: (it && it.prompt) || '', all: [] });
      return true;
    }
    /* 一次把**按任务号匹配到的全部归档**都返回，客户端不用再问第二次。
       以前这里是「先按 provider 精确查、查不到再不带 provider 查一次」：
       同一个任务号在界面上要打两个请求，第二个多半还是 404（归档文件头里的平台名
       和列表来源不是一套时才用得上，例如 sparkcine / sparkcine-video 共用上游），
       于是每条老任务固定多一个 404，浏览器的网络面板被刷满、控制台全是红字。
       现在一次到位：provider 只用来决定「优先把哪一份当正文」，不影响是否命中。 */
    const rows = promptRows(dir).filter(r => r.i && r.i === id);
    if (!rows.length) rows.push(...scanPromptTask(dir, id));
    /* 「这个任务本机没归档过」是**正常结果**，不是错误 —— 平台大多不返回 prompt，
       老任务更是从没归档过。回 404 会让浏览器把每一条都记成一条红色失败：
       实测资产库一屏 13 条、语音台与用量页各十几条，控制台和网络面板全被刷满，
       而界面上什么事都没有发生（客户端本来就把 404 当空结果 catch 掉，见 assetlib.js
       的 findByTask：`catch { d = null }` → 记进 missed 集合 → 返回空串）。
       改成 200 + matched:0：客户端走的是同一段（`d.prompt` 为空 → 同样进 missed），
       语义一字不差，少掉的只有满屏红字。真正的请求错误（400 缺 id、500 读目录失败）
       仍然是错误码。 */
    if (!rows.length) { json(200, { ok: true, id, matched: 0, archived: false, prompt: '', all: [] }); return true; }
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const hit = (prov && rows.find(r => r.p === prov)) || rows.find(r => !r.p) || rows[0];
    let prompt = '';
    try {
      const text = fs.readFileSync(path.join(dir, hit.f), 'utf8');
      const i = text.indexOf('## 提示词');
      if (i >= 0) prompt = text.slice(i + '## 提示词'.length).trim();
    } catch {}
    json(200, { ok: true, id, matched: rows.length, provider: hit.p || '',
      file: hit.f, path: path.join(dir, hit.f), title: hit.t, type: hit.k, prompt,
      /* 同一任务号的其它归档（换过平台 / 重复提交）：客户端据此把每份都记进内存索引，
         换平台 id 再查时就直接命中缓存，不用再发请求。 */
      all: rows.map(r => ({ file: r.f, title: r.t, type: r.k, provider: r.p || '', ts: r.ts || 0, pr: r.pr || '' })) });
    return true;
  }
  if (req.method === 'POST' && where === 'open') {
    const cmd = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      fs.mkdirSync(dir, { recursive: true });
      require('child_process').spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
      json(200, { ok: true, dir });
    } catch (e) { json(500, { error: { message: '打不开目录：' + e.message } }); }
    return true;
  }
  if (req.method === 'POST' && !where) {
    readBody(req, res, 4 * 1024 * 1024).then(raw => {
      if (raw == null) return;
      let f = null;
      try { f = JSON.parse(raw.toString('utf8')); } catch { return json(400, { error: { message: '请求体不是合法 JSON' } }); }
      if (!f || typeof f !== 'object') return json(400, { error: { message: '请求体不是对象' } });
      const prompt = String(f.prompt == null ? '' : f.prompt);
      if (!prompt.trim()) return json(400, { error: { message: '提示词是空的' } });
      const now = new Date();
      // 正文与文件头存原样（只压成一行），只有文件名需要过滤字符 —— 模型名里的 / 不该被改掉
      const rawTitle = oneLine(f.title).slice(0, 80) || oneLine(prompt).slice(0, 10);
      const rawType = oneLine(f.type).slice(0, 40) || '任务';
      const provider = oneLine(f.provider).slice(0, 60);
      const model = oneLine(f.model).slice(0, 80);
      const task = oneLine(f.task).slice(0, 100);
      // 标题：优先用文字 AI 起的；没有就取提示词前 10 个字（再兜一层，保证文件名里一定有标题）
      const title = fileSafe(rawTitle, 60) || '未命名';
      const type = fileSafe(rawType, 24) || '任务';
      const meta = (f.meta && typeof f.meta === 'object') ? f.meta : {};
      const metaKeys = Object.keys(meta).filter(k => {
        const v = meta[k];
        return v !== undefined && v !== null && v !== '' && typeof v !== 'object';
      });
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch (e) { return json(500, { error: { message: '建不了目录（' + dir + '）：' + e.message } }); }
      const base = dirStamp(now) + '-' + type + '-' + title;
      const fm = ['---', 'title: ' + rawTitle, 'type: ' + rawType, 'ts: ' + now.getTime(), 'time: ' + timeText(now)];
      if (provider) fm.push('provider: ' + provider);
      if (model) fm.push('model: ' + model);
      if (task) fm.push('task: ' + task);
      metaKeys.forEach(k => fm.push(fileSafe(k, 24) + ': ' + oneLine(meta[k]).slice(0, 120)));
      fm.push('---');
      const body = ['', '# ' + rawTitle, '']
        .concat([
          '- 类型：' + rawType,
          '- 时间：' + timeText(now),
          provider ? '- 平台：' + provider : '',
          model ? '- 模型：' + model : '',
          task ? '- 任务号：' + task : '',
        ].filter(Boolean))
        .concat(metaKeys.map(k => '- ' + k + '：' + oneLine(meta[k])))
        .concat(['', '## 提示词', '', prompt.trim(), ''])
        .join('\n');
      /* 用 wx（独占创建）落盘：两个请求同秒进来时，后者会拿到 EEXIST 再换个名字，
         不会把前一份提示词覆盖掉（以前是「先 existsSync 再 write」—— 两个请求都看到「不存在」，
         后写的那份把先写的那份盖掉）。 */
      let file = '', wrote = false;
      for (let n = 1; n <= 50 && !wrote; n++) {
        const cand = base + (n === 1 ? '' : '-' + n) + '.md';
        try {
          fs.writeFileSync(path.join(dir, cand), fm.join('\n') + '\n' + body, { flag: 'wx' });
          file = cand; wrote = true;
        } catch (e) {
          if (e && e.code === 'EEXIST') continue;
          return json(500, { error: { message: '写不进文件（' + dir + '）：' + e.message } });
        }
      }
      if (!wrote) return json(500, { error: { message: '同一个名字的归档太多（' + base + '），换一个标题再存' } });
      // 索引里带一段提示词（前 300 字）：资产库要按「平台 + 任务号」把提示词补显示出来
      const row = { f: file, t: rawTitle, k: rawType, ts: now.getTime(), p: provider, m: model,
        i: task, pr: oneLine(prompt).slice(0, 300) };
      writePromptIndex(dir, [row].concat(promptRows(dir).filter(r => r.f !== file)));
      json(200, { ok: true, dir, file, path: path.join(dir, file), title, type });
    });
    return true;
  }
  /* 归档的整包导出 / 恢复（设置页「导出整包备份」勾「连提示词归档一起」时走这一对）。
     以前归档只躺在磁盘上的一堆 .md 里：它既不在 .data/ 里（所以云同步带不走），
     也不在 localStorage / IndexedDB 里（所以整包备份同样带不走）——
     换机器、清浏览器数据、误删目录，就只剩「没了」这一种结果。
     格式直接用 JSON 里的 {name, text}：归档是纯文本，一份几百 KB，
     万一路上万份也不会像 base64 打包文件那样把备份撑爆（真超了按 EXPORT_MAX 截断并**说清截掉多少**）。 */
  const PROMPT_PACK_MAX_FILES = 20000, PROMPT_PACK_MAX_BYTES = 64 * 1024 * 1024;
  if (req.method === 'POST' && (where === 'export' || where === 'import')) {
    readBody(req, res, 128 * 1024 * 1024).then(async raw => {
      if (raw == null) return;
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(400, { error: { message: '请求体不是合法 JSON' } }); }
      if (where === 'export') {
        const all = promptFileList(dir);
        const files = [];
        let bytes = 0, skipped = 0;
        for (const f of all) {
          if (files.length >= PROMPT_PACK_MAX_FILES || bytes >= PROMPT_PACK_MAX_BYTES) { skipped++; continue; }
          try {
            const text = fs.readFileSync(path.join(dir, f.name), 'utf8');
            bytes += text.length;
            files.push({ name: f.name, text });
          } catch (e) { skipped++; }
        }
        return json(200, { ok: true, dir, count: files.length, total: all.length, skipped, bytes, files,
          message: '归档 ' + files.length + ' 份' + (skipped ? '（还有 ' + skipped + ' 份因为超出上限没带上）' : '')
            + '，压缩后存进备份文件' });
      }
      /* 恢复：一份也不覆盖。归档文件名带时间戳、用独占创建写入，正常不会撞名；
         真撞上了（用户手工改过文件名）跳过并报出来 —— 覆盖别人的提示词比少一份严重得多。 */
      const list = Array.isArray(body.files) ? body.files : [];
      let ok = 0, dup = 0, bad = 0;
      const errs = [];
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(500, { error: { message: '建不了目录（' + dir + '）：' + e.message } }); }
      for (const it of list) {
        const name = String((it && it.name) || '');
        if (!/^[^\\/:*?"<>|\u0000-\u001f]+\.md$/i.test(name) || name === '_index.md') { bad++; continue; }
        try {
          fs.writeFileSync(path.join(dir, name), String(it.text == null ? '' : it.text), { flag: 'wx' });
          ok++;
        } catch (e) {
          if (e && e.code === 'EEXIST') { dup++; continue; }
          bad++; if (errs.length < 5) errs.push(name + '（' + e.message + '）');
        }
      }
      try { writePromptIndex(dir, rebuildPromptIndex(dir)); } catch (e) { /* 索引重建失败不影响文件本身 */ }
      json(200, { ok: true, dir, restored: ok, dup, bad, errors: errs,
        message: '恢复归档 ' + ok + ' 份' + (dup ? '，' + dup + ' 份本机已有同名（没覆盖）' : '') + (bad ? '，' + bad + ' 份没恢复' : '') });
    });
    return true;
  }
  json(405, { error: { message: '不支持的请求：' + req.method + ' ' + urlObj.pathname } });
  return true;
}

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
function cloudCfg(req) {
  const h = req.headers;
  const pick = (hdr, env) => String(h[hdr] || process.env[env] || '').trim();
  const url = pick('x-cloud-url', 'CLOUD_WEBDAV_URL').replace(/\/+$/, '');
  const user = pick('x-cloud-user', 'CLOUD_WEBDAV_USER');
  const pass = String(h['x-cloud-pass'] || process.env.CLOUD_WEBDAV_PASS || '');
  if (!url) throw new Error('还没配置云端地址：到「设置 → 数据与同步」里填，或写进 .env 的 CLOUD_WEBDAV_URL');
  // 必须 https（明文 http 会把账号密码暴露在网上）；只有本机回环地址例外，方便自建 WebDAV 调试
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url + '/');
  if (!/^https:\/\//i.test(url) && !loopback) {
    throw new Error('云端地址必须是 https://（用明文 http 传 WebDAV 会把账号密码暴露在网上）');
  }
  if (!user || !pass) throw new Error('云同步需要账号与应用密码（坚果云请在「安全选项」里生成应用密码）');
  return { url, user, pass };
}
const cloudAuth = cfg => 'Basic ' + Buffer.from(cfg.user + ':' + cfg.pass, 'utf8').toString('base64');
/* sub 为空 = 操作基地址本身；asCollection=true 时给目标补上结尾的 / ——
   WebDAV 里「集合」的规范写法就是带斜杠，MKCOL 不带会被多数服务端当成对已存在资源的请求
   （返回 409/404），目录建不出来，之后所有 PUT 都会 404。 */
function cloudRequest(cfg, method, sub, headers, body, asCollection) {
  return new Promise((resolve, reject) => {
    const base = cfg.url + (sub ? '/' + String(sub).replace(/^\/+/, '') : '');
    const target = (asCollection && !base.endsWith('/')) ? base + '/' : base;
    const up = anyRequest(target, {
      method,
      headers: { Authorization: cloudAuth(cfg), 'User-Agent': 'local-workbench', ...(headers || {}) },
    }, ur => {
      const bufs = [];
      ur.on('data', c => bufs.push(c));
      ur.on('end', () => resolve({ status: ur.statusCode, body: Buffer.concat(bufs) }));
      ur.on('error', e => reject(new Error('云同步读取失败：' + e.message)));
    });
    up.on('error', e => reject(new Error('连不上云端：' + e.message)));
    up.end(body || undefined);
  });
}
/* WebDAV 的 PROPFIND 响应是 XML，这里只取我们需要的三个信息（文件名 / 修改时间 / 大小）。
   命名空间前缀各服务商不一样（d: / D: / 无），所以按标签尾巴匹配。 */
/* kind='data'（默认）只收 .json 并按 DATA_KEY_RE 过滤键名 —— 数据键那套判据；
   kind='md' 收 .md，键就是文件名 —— 提示词归档用。**不能只收 .json**：
   那样云端明明有那几份归档、这边却每次都当「云端没有」重新传一遍（传得越多越慢，
   而且真出问题时会被淹没在一堆重复上传里）。 */
function parseDavList(xml, kind) {
  const md = kind === 'md';
  const out = new Map();
  const blocks = String(xml).match(/<[a-zA-Z0-9]*:?response[\s>][\s\S]*?<\/[a-zA-Z0-9]*:?response>/g) || [];
  for (const b of blocks) {
    if (/<[a-zA-Z0-9]*:?collection\s*\/?>/.test(b)) continue;                 // 目录本身跳过
    const href = (/<[a-zA-Z0-9]*:?href>([\s\S]*?)<\/[a-zA-Z0-9]*:?href>/.exec(b) || [])[1] || '';
    const name = decodeURIComponent(href.trim().replace(/\/+$/, '').split('/').pop() || '');
    let key;
    if (md) {
      if (!/\.md$/i.test(name)) continue;
      key = name;
    } else {
      if (!name.endsWith('.json')) continue;
      key = name.slice(0, -5);
      if (!DATA_KEY_RE.test(key)) continue;
    }
    const lm = (/<[a-zA-Z0-9]*:?getlastmodified>([\s\S]*?)<\/[a-zA-Z0-9]*:?getlastmodified>/.exec(b) || [])[1] || '';
    const len = (/<[a-zA-Z0-9]*:?getcontentlength>(\d+)</.exec(b) || [])[1];
    const t = Date.parse(lm.trim());
    out.set(key, { mtime: isNaN(t) ? 0 : t, size: len ? Number(len) : 0 });
  }
  return out;
}
/* 确保云端目录存在：先 PROPFIND 问一下，不存在才 MKCOL 建（带斜杠）。
   建不出来就**直接报错并给出可操作的下一步** —— 以前这里只写日志、继续往下走，
   结果上传时每个文件都 404，界面上只看到一句「上传 ai_usage 失败 HTTP 404」，很难猜到是目录不存在。 */
async function cloudEnsureDir(cfg) {
  const probe = await cloudRequest(cfg, 'PROPFIND', '', { Depth: '0', 'Content-Type': 'application/xml' });
  if (probe.status === 401 || probe.status === 403) throw new Error('云端拒绝访问（' + probe.status + '）：账号或应用密码不对');
  if (probe.status < 400) return true;                                  // 目录已在
  if (probe.status !== 404) throw new Error('云端路径不对：PROPFIND 返回 ' + probe.status + '（检查地址是否写错）');
  const mk = await cloudRequest(cfg, 'MKCOL', '', { 'Content-Length': 0 }, undefined, true);
  if (mk.status < 400 || mk.status === 405) return true;                // 405 = 已存在
  throw new Error('云端目录不存在，自动创建也失败（MKCOL 返回 ' + mk.status + '）。'
    + '有些网盘不允许通过 WebDAV 建目录，请先在网盘网页端手动建好这个目录：' + cfg.url);
}
/* ============================================================================
   提示词归档 → 云端（默认不勾，跟着 push/pull/sync 一起走）
   ---------------------------------------------------------------------------
   归档是**只增不改**的一份份 `.md`：文件名带时间戳、落盘用独占创建（`wx`），
   所以「文件名」就是它的身份 —— 同步因此比数据键那一套简单得多，也安全得多：
     同名同内容 → 跳过；只有本机有 → 传；只有云端有 → 下载。
   **永远不删云端那份。** 归档是一份只增的创作历史，误删一整份提示词没法恢复；
   而「本机删了、云端也跟着删」要判对必须先有基线/墓碑，那是数据键那套才值得上的机制。
   这里不引入它：云端多出来的只**报数量**，由用户自己决定要不要拉下来。
   （`_index.json` 是派生索引，本机重建就行，不上传 —— 传了反而可能把另一台机器的条目带歪。）
   ========================================================================== */
const PROMPT_CLOUD_SUB = 'prompts';
const PROMPT_CLOUD_MAX = 20000;        // 单次最多传多少份，防一个跑飞的目录把网盘塞满
function promptCloudDir(raw) {
  /* 归档目录是**浏览器那边的设置**（键 prompt_dir，刻意不同步），代理自己并不知道，
     所以由设置页把当前值带过来。仍要过 promptsDir 的那道校验（只能在项目目录或用户目录之下）——
     这个参数是同源请求递来的，少一道就等于让任何同源脚本往这台机器任意位置写文件。 */
  try { return promptsDir(String(raw == null ? '' : raw)); } catch (e) { throw new Error('提示词目录不合法：' + e.message); }
}
function promptFileList(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter(n => /\.md$/i.test(n))
    .map(n => { try { const st = fs.statSync(path.join(dir, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime);
}
async function cloudEnsureSub(cfg, sub) {
  const probe = await cloudRequest(cfg, 'PROPFIND', sub, { Depth: '0', 'Content-Type': 'application/xml' });
  if (probe.status < 400) return true;
  if (probe.status === 401 || probe.status === 403) throw new Error('云端拒绝访问（' + probe.status + '）');
  if (probe.status !== 404) return false;                       // 有些网盘不给子目录 PROPFIND，试试直接写
  const mk = await cloudRequest(cfg, 'MKCOL', sub, { 'Content-Length': 0 });
  return mk.status < 400 || mk.status === 405;
}
async function cloudListSub(cfg, sub) {
  if (!(await cloudEnsureSub(cfg, sub))) return new Map();
  const r = await cloudRequest(cfg, 'PROPFIND', sub, { Depth: '1', 'Content-Type': 'application/xml' });
  if (r.status === 401 || r.status === 403) throw new Error('云端拒绝访问（' + r.status + '）');
  if (r.status === 404) return new Map();
  if (r.status >= 400) return new Map();                        // 列不出来就当没有：只会上传，不会误删
  return parseDavList(r.body.toString('utf8'), 'md');
}
/* 返回 { up, down, same, onlyRemote, failed[] }，**不删任何东西** */
async function cloudSyncPrompts(cfg, dir, cmd) {
  const out = { up: 0, down: 0, same: 0, onlyRemote: 0, skipped: 0, failed: [] };
  const dirOk = await cloudEnsureSub(cfg, PROMPT_CLOUD_SUB);
  if (!dirOk) { out.failed.push('云端建不出 ' + PROMPT_CLOUD_SUB + '/ 目录（有些网盘不允许 WebDAV 建目录，请在网盘网页端手动建一个）'); return out; }
  let remote = new Map();
  try { remote = await cloudListSub(cfg, PROMPT_CLOUD_SUB); }
  catch (e) { out.failed.push('列云端归档失败：' + e.message); return out; }
  const local = promptFileList(dir);
  const byName = new Map(local.map(f => [f.name, f]));
  for (const f of local) {
    const finfo = remote.get(f.name) || null;
    /* 「一致」先判，模式后判：这样 same 在三种模式下都是「两边一模一样」这一个意思，
       pull 模式下也能如实报出「云端已有的那几份没动」。 */
    if (finfo && Number(finfo.size) === f.size) { out.same++; continue; }   // 同名同大小：归档不会被改写，不必下载比对
    if (cmd === 'pull') { out.skipped++; continue; }            // 只下载：本地那份不动
    if (out.up >= PROMPT_CLOUD_MAX) { out.skipped++; continue; }
    try {
      const buf = fs.readFileSync(path.join(dir, f.name));
      const putOnce = () => cloudRequest(cfg, 'PUT', PROMPT_CLOUD_SUB + '/' + encodeURIComponent(f.name),
        { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': buf.length }, buf);
      let r = await putOnce();
      if (r.status === 404 || r.status === 409) { await cloudEnsureSub(cfg, PROMPT_CLOUD_SUB); r = await putOnce(); }
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      out.up++;
    } catch (e) { out.failed.push(f.name + '（' + e.message + '）'); }
  }
  for (const [name, info] of remote) {
    if (byName.has(name)) continue;
    if (cmd === 'push') { out.onlyRemote++; continue; }        // 只上传：如实报「云端有本机没有」，不往本机写
    try {
      const got = await cloudRequest(cfg, 'GET', PROMPT_CLOUD_SUB + '/' + encodeURIComponent(name), {});
      if (got.status !== 200) throw new Error('HTTP ' + got.status);
      /* 独占创建：万一本机刚生成了同名的一份，绝不把它盖掉（归档丢了比多一份严重得多） */
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), got.body, { flag: 'wx' });
      out.down++;
    } catch (e) { if (!e || e.code !== 'EEXIST') { out.onlyRemote++; out.failed.push(name + '（' + (e && e.message) + '）'); } }
  }
  return out;
}
/* 读某个数据文件里的写入时间（ts）：判「谁更新」只认它，不认文件 mtime *//* 从一份数据内容里取写入时间 ts（裸数组/字符串那种老格式没有 ts → 0） */
function tsOfBuf(buf) {
  try { const v = JSON.parse(buf.toString('utf8')); return (v && typeof v === 'object' && !Array.isArray(v) && v.ts) ? Number(v.ts) || 0 : 0; } catch { return 0; }
}
async function cloudList(cfg) {
  await cloudEnsureDir(cfg);
  const r = await cloudRequest(cfg, 'PROPFIND', '', { Depth: '1', 'Content-Type': 'application/xml' });
  if (r.status === 401 || r.status === 403) throw new Error('云端拒绝访问（' + r.status + '）：账号或应用密码不对');
  if (r.status >= 400) throw new Error('列目录失败 HTTP ' + r.status);
  return parseDavList(r.body.toString('utf8'));
}

/* ============================================================================
   能力接口（/capabilities）—— 页面问「这个平台的模型都有什么能力」只走这一条本地路由
   ---------------------------------------------------------------------------
     GET /capabilities?provider=<id|keyId>[&noCache=1]
   代理负责：
     · 按 registry 找到该平台声明的能力端点（endpoints.models）
     · 带上密钥请求上游，把返回的模型数组按 id 整理好
     · 上游没有这个端点 / 请求失败 → 返回 registry 里的兜底声明，并说明原因（note）
   这样页面不需要知道每个平台的能力接口地址、密钥和返回格式；接入新平台
   只要在 registry 里写上 endpoints.models，能力的读取与回退全自动。
   返回：{ provider, source:'api'|'registry', models:{id:原始模型对象},
           registryModels:[...], endpoint, note, fetchedAt, cached }
   —— 模型能力不会秒变，服务端缓存 60 秒；noCache=1 强制回源（设置页「重新读取」用）。
   ========================================================================== */
const capCache = new Map();          // base|endpoint → { ts, payload }
const CAP_TTL = 60 * 1000;
/* 在途合并（P3）。⚠️ `noCache=1`（设置页「重新读取」）必须走旁路：它既**不读**缓存，
   也**不加入**在途合并 —— 否则「强制刷新」会拿到别人那一次的结果，看着像刷新没生效。
   所以注册与加入都以 `!noCache` 为前提。 */
const capInflight = new Map();       // cacheKey → { p, resolve }
/* **落盘的一层**（2026-10）。以前 capCache 是纯内存的，于是「工作台的型号怎么这么慢」
   有一个固定的、每天第一次都会重演一遍的成因：代理重启（或 60 秒一过）之后，第一个打开工作台的
   页面必须**等回源**才看得到型号 —— 实测 vgenv 一次 6.9 秒、SparkCine 两家各 1.1 秒，
   而上一轮把注册表里的兜底型号清单删掉之后，这段时间里型号下拉是**空的**（不是慢，是「没有」）。
   现在把每次真取到的上游清单落到 `.data/.cap-cache.json`：
   · 只要拿得出**一天以内**的真清单（内存过期的那份或落盘的那份，取较新的）就先照它答（`stale:true`），
     同时后台回源刷新一轮 —— **有别人正在飞也一样先答**，不等那一次往返（见 handleCapabilities）；
   · 一份旧副本都没有（冷启动 / 过期）→ 照旧阻塞回源。
   文件名以点开头 = 代理自己的内部状态，和 `.cloud-state.json` 一样不进 `/data` 清单、不参与云同步
   （它记的是「上游平台有什么型号」，那是平台的事，不是用户的数据，换台机器本来就该重新问一遍）。
   ⚠ 只缓存**用服务端 .env 密钥取到的**那些家：自定义供应商的密钥只在浏览器那一侧，
   代理存不了它的清单，那些家照旧每次现问（设置页的型号清单走 /custom/models，另有自己的在途合并）。 */
const capDiskFile = () => path.join(dataDirPath(), '.cap-cache.json');
const CAP_DISK_TTL = 24 * 60 * 60 * 1000;
let capDisk = null;                  // cacheKey → { ts, payload }
function capDiskLoad() {
  if (capDisk) return capDisk;
  try { capDisk = JSON.parse(fs.readFileSync(capDiskFile(), 'utf8')) || {}; }
  catch { capDisk = {}; }
  return capDisk;
}
let capDiskWriteAt = 0;
function capDiskPut(cacheKey, payload) {
  const d = capDiskLoad();
  d[cacheKey] = { ts: Date.now(), payload };
  /* 整表重写，所以自己夹一个 2 秒的下限：一次开机十几个后台刷新挤在一起时，
     没必要为每一条都写一遍同一个文件（写的是同一个内存表，少写几次不丢东西）。 */
  if (Date.now() - capDiskWriteAt < 2000) return;
  capDiskWriteAt = Date.now();
  try {
    fs.mkdirSync(dataDirPath(), { recursive: true });
    fs.writeFileSync(capDiskFile(), JSON.stringify(d));
  } catch (e) { console.warn('[capabilities] 落盘缓存写不了：', e.message); }
}
/* 后台刷新一轮：命中落盘答完之后悄悄把上游问一遍，写进两层缓存，供下一次（或下一台页面）用。
   与 handleCapabilities 用同一个 capInflight 键，所以「同时在飞」的只有这一条。 */
function capWarm(cacheKey, prov, endpoint, apiKey) {
  if (capInflight.has(cacheKey)) return;
  let r0 = null;
  const p = new Promise(r => { r0 = r; });
  capInflight.set(cacheKey, { p, resolve: r0 });
  capFetchPayload(prov, endpoint, apiKey)
    .then(payload => {
      /* 只把真清单写进两层缓存：一次 404 / 断连不该把上一次的好清单从落盘里顶掉
         （内存那一份照旧写 —— 它 60 秒就过期，本来就该如实反映「刚刚问过」）。 */
      capCache.set(cacheKey, { ts: Date.now(), payload });
      if (payload.source === 'api') capDiskPut(cacheKey, payload);
    })
    .catch(() => {})
    .finally(() => { capInflight.delete(cacheKey); r0(); });
}

/* 真去上游问一次型号清单。四种结果各回一句话（页面那句「能力来源」直接把 note 原样显示，
   压成一句「上游接口没给或不可用」等于零信息 —— 见 assetlib.js 的 Capabilities.srcTextOf）。 */
async function capFetchPayload(prov, endpoint, apiKey) {
  const registryModels = (prov.models || []).map(m => ({
    id: m.id, name: m.name, modes: m.modes, options: m.options, price: m.price,
  }));
  const base = { provider: prov.id, name: prov.name, displayName: prov.displayName || prov.name, endpoint, registryModels };
  try {
    const r = await new Promise((resolve, reject) => {
      const up = upRequest(prov.base + endpoint, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json', 'accept-encoding': 'identity' },
        keepAlive: true,              // 目标主机来自注册表声明（见 keepAliveAgent / agentFor）
      }, ur => {
        const bufs = [];
        ur.on('data', c => bufs.push(c));
        ur.on('end', () => resolve({ status: ur.statusCode, body: Buffer.concat(bufs) }));
        ur.on('error', reject);
      });
      up.on('error', reject);
      up.end();
    });
    if (r.status >= 400) {
      return { ...base, source: 'registry', models: {}, note: '上游能力接口返回 ' + r.status + '（按平台声明兜底）' };
    }
    const j = JSON.parse(r.body.toString('utf8'));
    const list = j.data || j.models || (Array.isArray(j) ? j : []);
    const models = {};
    list.forEach(m => { if (m && m.id) models[m.id] = m; });
    if (!Object.keys(models).length) {
      return { ...base, source: 'registry', models: {}, note: '上游能力接口没有返回模型列表（按平台声明兜底）' };
    }
    return { ...base, source: 'api', models, fetchedAt: Date.now(), note: '' };
  } catch (e) {
    return { ...base, source: 'registry', models: {}, note: '上游能力接口请求失败：' + e.message + '（按平台声明兜底）' };
  }
}

async function handleCapabilities(req, res, urlObj) {
  const want = String(urlObj.searchParams.get('provider') || '');
  const noCache = urlObj.searchParams.get('noCache') === '1';
  const prov = allProviders().find(p => p.id === want || (p.keyId || p.id) === want);
  if (!prov) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '找不到平台：' + want + '（检查 registry 里的 id）' } }));
    return true;
  }
  const endpoint = (prov.endpoints && prov.endpoints.models) || null;
  const apiKey = (req.headers.authorization || '').replace(/^Bearer\s*/, '')
    || keyOf(prov.keyEnv) || DEFAULTS[prov.keyId || prov.id] || '';
  const send = payload => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return true;
  };
  const cacheKey = prov.base + '|' + endpoint;
  let capResolve = null;
  if (endpoint && !noCache) {
    const hit = capCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CAP_TTL) return send({ ...hit.payload, cached: true });
    /* 手上「还能用、但可能不是刚刚问过」的那一份清单：内存里过期的与落盘里一天内的，取较新的。
       只认真清单（source==='api'）—— 兜底那一份现在可能压根没有型号，答出去等于下拉是空的。 */
    const staleCopy = () => {
      const cand = [];
      if (hit && hit.payload && hit.payload.source === 'api') cand.push(hit);
      const d = capDiskLoad()[cacheKey];
      if (d && d.payload && d.payload.source === 'api' && Date.now() - d.ts < CAP_DISK_TTL) cand.push(d);
      return cand.sort((a, b) => b.ts - a.ts)[0] || null;
    };
    /* 已经在取同一家的能力声明 → 同一轮里几个页面同时开时会一起打上游。
       ⚠ 但「有别人在飞」**不等于**「我必须干等那一轮」：上一版这里无条件 `await wait.p`，
       于是哪怕落盘里就躺着一份一天以内的真清单，第二个、第三个请求也要等满一次上游往返
       （实测 vgenv 一次 6.8 秒 —— 用户看到的就是「工作台型号出来好慢」，而慢的那一段本来能答）。
       现在顺序是**先答旧副本、后台那一轮照旧刷**；只有旧副本一个都没有才真的等。 */
    const wait = capInflight.get(cacheKey);
    if (wait) {
      const st0 = staleCopy();
      if (st0) return send({ ...st0.payload, cached: true, stale: true });
      try { await wait.p; } catch {}
      const hit2 = capCache.get(cacheKey);
      if (hit2) return send({ ...hit2.payload, cached: true });
      /* 在途那次连兜底都没写进缓存（极少见）：自己照常往下走，回源一次 */
    } else {
      /* 内存没命中、但有一天内落盘的 → 先照那份答（型号下拉立刻就有内容），后台再回源刷新一轮
         （capWarm 自己认在途，所以这里不会重复派一整批上游请求）。 */
      const st = staleCopy();
      if (st) {
        capWarm(cacheKey, prov, endpoint, apiKey);
        return send({ ...st.payload, cached: true, stale: true });
      }
      let r0 = null;
      const p = new Promise(r => { r0 = r; });
      capInflight.set(cacheKey, { p, resolve: r0 });
      capResolve = r0;
    }
  }
  const reply = payload => {
    if (endpoint) {
      capCache.set(cacheKey, { ts: Date.now(), payload });
      if (payload.source === 'api') capDiskPut(cacheKey, payload);
      /* 以前 capCache 是**唯一一份完全没有淘汰**的缓存（全文 cacheSweep 三处调用都没它），
         而 v11 起自定义供应商不设家数上限，条目只增不减。CAP_TTL 只有 60 秒，整表清掉没代价。 */
      if (capCache.size > 200) capCache.clear();
    }
    const out = send(payload);
    if (capResolve) { const r = capResolve; capResolve = null; capInflight.delete(cacheKey); r(payload); }
    return out;
  };
  if (!endpoint) {
    return reply({ provider: prov.id, name: prov.name, displayName: prov.displayName || prov.name,
      endpoint: null, registryModels: (prov.models || []).map(m => ({ id: m.id, name: m.name,
        modes: m.modes, options: m.options, price: m.price })),
      source: 'registry', models: {}, note: '这家没有开放的型号列表接口，参数按本项目的默认声明走' });
  }
  return reply(await capFetchPayload(prov, endpoint, apiKey));
}

/* 云同步的**结果状态**（上次跑成什么样、有哪些冲突待选）——
   与基线同生共死：基线本来就是落盘的（.data/.cloud-state.json），这块却是进程内存（L51）。
   于是「报出 3 份冲突待选择 → 重启代理（或换端口起实例）→ 设置页回到『还没同步过』、
   待选清单空了」，用户以为冲突没了，按下去又跑一次，冲突重新冒出来 —— 整个过程在界面上无法解释。
   现在两块一起写进同一个文件（同一个文件、同一次写，就不存在「一个持久一个不持久」）。 */
const cloudState = { lastAt: 0, lastResult: '', conflicts: [], unread: [], lastUp: 0, lastDown: 0 };
/* 读整个文件（基线 + 这块结果状态）；写只用 read-modify-write，免得把基线那一半抹掉。 */
function cloudStateFileRead() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDirPath(), '.cloud-state.json'), 'utf8')) || {}; } catch { return {}; }
}
function cloudStateSave() {
  try {
    const cur = cloudStateFileRead();
    fs.mkdirSync(dataDirPath(), { recursive: true });
    fs.writeFileSync(path.join(dataDirPath(), '.cloud-state.json'), JSON.stringify({
      ts: Date.now(), keys: cur.keys || {},
      ui: { at: cloudState.lastAt, result: cloudState.lastResult, conflicts: cloudState.conflicts || [],
        unread: cloudState.unread || [], up: cloudState.lastUp || 0, down: cloudState.lastDown || 0 },
    }));
  } catch (e) { log('[cloud] 状态写入失败：' + e.message); }
}
/* 赋值 + 落盘一次（调用方只管说「现在是什么样」，不要自己记着还要写盘） */
function cloudStateSet(patch) {
  Object.assign(cloudState, patch || {});
  cloudStateSave();
}
function cloudStateLoad() {
  const ui = cloudStateFileRead().ui;
  if (!ui || typeof ui !== 'object') return;
  cloudState.lastAt = Number(ui.at) || 0;
  cloudState.lastResult = String(ui.result || '');
  cloudState.conflicts = Array.isArray(ui.conflicts) ? ui.conflicts : [];
  cloudState.unread = Array.isArray(ui.unread) ? ui.unread : [];
  cloudState.lastUp = Number(ui.up) || 0;
  cloudState.lastDown = Number(ui.down) || 0;
}

/* ============================================================================
   云同步的「计划」：先判定每个键该怎么动，再执行
   ---------------------------------------------------------------------------
   冲突判定靠**基线**：.data/.cloud-state.json 记着上次成功同步时每个键的内容指纹。
     · 只有本机变过（指纹 != 基线）→ 上传
     · 只有云端变过          → 下载
     · 两边都没变            → 跳过
     · **两边都变过**（都 != 基线且彼此不同）→ 冲突：不自动覆盖，列出来让用户选一边
   没有基线时（第一次同步 / 基线被删）退回老的「按内容 ts 取新」策略，
   但会在结果里标成「自动采用较新」让用户知道这次是猜的；同步成功后基线就建起来了。
   为什么要基线：只看修改时间取新，等于「两边都改过」时静默丢弃一边 —— 用户不知道哪份数据被顶掉了。
   ========================================================================== */
const CLOUD_STATE_FILE = () => path.join(dataDirPath(), '.cloud-state.json');
/* 启动就把上一次的同步结果读回来 —— 与基线同一份文件，读到什么就是什么。
   （函数声明提升，上面 cloudStateLoad 的调用点写在文件稍后，见那里。） */
function cloudBaselineRead() {
  try { const v = JSON.parse(fs.readFileSync(CLOUD_STATE_FILE(), 'utf8')); return (v && v.keys) || {}; } catch { return {}; }
}
function cloudBaselineWrite(keys) {
  try {
    /* 保留同一份文件里的 ui（结果状态）那一半：这里是**整文件覆盖**，
       不带上它就是「同步一次把上次的诊断信息抹掉」（L51 的同一个坑的另一种形态）。 */
    const cur = (() => { try { return JSON.parse(fs.readFileSync(CLOUD_STATE_FILE(), 'utf8')) || {}; } catch { return {}; } })();
    fs.mkdirSync(dataDirPath(), { recursive: true });
    fs.writeFileSync(CLOUD_STATE_FILE(), JSON.stringify(Object.assign(cur, { ts: Date.now(), keys })));
  } catch (e) { log('[cloud] 基线写入失败：' + e.message); }
}
const sha1Of = buf => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
/* 拉两边现状，给出每个键的动作：
   action: same | push | pull | delete-remote | conflict | push-auto | pull-auto | error
   localBuf / remoteBuf 一并带上（判方向和执行都要用，避免重复下载） */
async function cloudPlan(cfg, withKeys) {
  const remote = await cloudList(cfg);
  const locals = new Map(dataList().map(f => [f.key, f]));
  const base = cloudBaselineRead();
  const isKeyFile = k => k.startsWith('sk_key_');
  const items = [];
  for (const key of new Set([...remote.keys(), ...locals.keys()])) {
    if (!withKeys && isKeyFile(key)) continue;
    /* 本地这份读不下来（被占用 / 权限 / 半个文件）时要和「本地确实没有」区分开：
       都当成「没有」的话，下面会判成 delete-remote 把云端那份好数据删掉。 */
    let localBuf = null, localErr = '';
    if (locals.has(key)) {
      try { localBuf = fs.readFileSync(dataFileOf(key)); }
      catch (e) { localErr = '本机数据文件读不下来：' + e.message; }
    }
    const remoteInfo = remote.get(key) || null;
    let remoteBuf = null, remoteErr = '';
    if (remoteInfo) {
      try {
        const got = await cloudRequest(cfg, 'GET', key + '.json', {});
        if (got.status === 200) remoteBuf = got.body;
        else remoteErr = 'HTTP ' + got.status;
      } catch (e) { remoteErr = e.message; }
    }
    const it = { key, localBuf, remoteBuf, remoteInfo, remoteErr, localErr,
      /* 时间只用来看和显示（判方向靠基线）：内容里没有 ts（纯字符串值 / 裸数组老格式）时
         退回文件修改时间 —— 否则冲突列表里两边都是"—"，用户没法判断谁更新。 */
      localTs: localBuf ? (tsOfBuf(localBuf) || Math.round(locals.get(key).mtime)) : 0,
      remoteTs: remoteBuf ? (tsOfBuf(remoteBuf) || (remoteInfo ? Math.round(remoteInfo.mtime) : 0)) : 0 };
    items.push(Object.assign(it, { action: cloudClassify(it, base[key] || null) }));
  }
  return items;
}
function cloudClassify(it, base) {
  const l = it.localBuf, r = it.remoteBuf;
  /* 远端**存在但没读下来**（网络抖动 / 401 / 超时）：绝不能当成「本地独有」去 push ——
     那会用本地旧数据覆盖云端较新的一份（无冲突提示、云端也没有 .bak）。判成 error 跳过这个键。 */
  if (it.remoteErr || it.localErr) return 'error';
  if (!l && !r) return 'same';
  if (!r) return 'push';
  /* 本地没有、云端有：
     · 基线里有这个键 = 这台机器曾经同步过这份数据，现在它没了 → 用户在本地删了它，
       删除也要镜像到云端（否则下次同步又把它拉回来，「删不掉」）。
     · 基线里没有 = 换了机器 / 清空过 .data → 这是要**恢复**的数据，从云端拉回来。
     这两种情况长得一样，只有基线能区分，所以没有基线时绝不做删除。 */
  if (!l) return base && base.h ? 'delete-remote' : 'pull';
  if (Buffer.compare(l, r) === 0) return 'same';
  if (base && base.h) {
    const lc = sha1Of(l) !== base.h, rc = sha1Of(r) !== base.h;
    if (lc && rc) return 'conflict';
    if (lc) return 'push';
    if (rc) return 'pull';
    return 'conflict';                 // 都等于基线却又不同：基线过期 / 手工改过 → 交给用户
  }
  // 没有基线：按内容里的写入时间猜（结果里会标注是自动决定的）
  const lt = it.localTs || 0, rt = it.remoteTs || (it.remoteInfo ? it.remoteInfo.mtime : 0) || 0;
  if (rt && lt && rt > lt + 1000) return 'pull-auto';
  if (lt && rt && lt > rt + 1000) return 'push-auto';
  return 'conflict';
}
/* 上传（404/409 会重建目录重试一次）；返回 true 表示成功 */
async function cloudPushKey(cfg, key, buf) {
  const putOnce = () => cloudRequest(cfg, 'PUT', key + '.json', { 'Content-Type': 'application/json', 'Content-Length': buf.length }, buf);
  let put = await putOnce();
  if (put.status === 404 || put.status === 409) { await cloudEnsureDir(cfg); put = await putOnce(); }
  if (put.status >= 400) throw new Error('上传 ' + key + ' 失败 HTTP ' + put.status
    + (put.status === 401 || put.status === 403 ? '（账号或应用密码不对）' : '（检查云端目录是否存在）'));
  return true;
}
/* 删除云端的一份（本地删除的镜像）。404 当作「本来就没有」= 成功。 */
async function cloudDeleteKey(cfg, key) {
  const d = await cloudRequest(cfg, 'DELETE', key + '.json', {});
  if (d.status >= 400 && d.status !== 404) throw new Error('删除云端 ' + key + ' 失败 HTTP ' + d.status);
  return true;
}
/* 下载：覆盖前先把本机那份存成 .bak.json（云同步唯一的"后悔药"） */function cloudPullKey(key, remoteBuf, backupList) {
  if (fs.existsSync(dataFileOf(key))) {
    dataWriteRaw(key + '.bak', fs.readFileSync(dataFileOf(key)));
    if (backupList) backupList.push(key + '.bak.json');
  }
  dataWriteRaw(key, remoteBuf);
}
/* 清单接口：给设置页展示「云端有哪些、本地有哪些、各自多大/多新」 */
function cloudBackups() {
  try {
    const dir = dataDirPath();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.bak.json')).map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { key: f.slice(0, -'.bak.json'.length), file: f, size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/* ---------- /data 与 /cloud 的一组路由（在 handleRequest 里调用；返回 true 表示已处理） ---------- */
function handleData(req, res, urlObj) {
  /* 这几条比较用 pathname：用原始 req.url 的话，带查询串的写法（/data?x=1）
     匹配不上、掉到静态服务回 404 —— 客户端拿到的是「接口不存在」而不是数据。 */
  const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
  if (dataPath === '/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ dir: dataDirPath(), files: dataList() }));
    return true;
  }
  if (req.url.startsWith('/data/')) {
    const key = safeDecode(req.url.slice('/data/'.length).split('?')[0]);
    if (!DATA_KEY_RE.test(key)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"非法的数据键名"}'); return true; }
    const f = dataFileOf(key);
    if (req.method === 'GET') {
      if (!fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"没有这份数据"}'); return true; }
      /* 先读再写头：Windows 上文件可能正被另一个进程占着（EBUSY），
         读到一半才抛的话 200 头已经发出，客户端只会等到超时，看不出是读取失败。 */
      let buf = null;
      try { buf = fs.readFileSync(f); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '读取数据文件失败：' + e.message } }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(buf);
      return true;
    }
    if (req.method === 'PUT') {
      /* 请求体就是客户端那份 localStorage 值，**原样落盘**。
         这里刻意不要求 JSON：同步的键里有一大半存的是普通字符串
         （dir_theme=dark、sk_polish_*=提示词文本、sk_key_*=密钥、page_mode_=page…），
         以前要求「必须是合法 JSON」会把这些全挡在 400。
         只做最基本的健康检查：非空、不含 NUL 字节。 */
      readBody(req, res, 32 * 1024 * 1024).then(buf => {
        if (buf == null) return;
        const text = buf.toString('utf8');
        if (!text.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '内容是空的' } }));
          return;
        }
        if (text.includes(String.fromCharCode(0))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '内容含 NUL 字节，拒绝写入' } }));
          return;
        }
        dataWriteRaw(key, buf);
        const st = fs.statSync(f);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, key, size: st.size, mtime: st.mtimeMs }));
      }).catch(e => {
        /* 落盘失败（磁盘满 / 文件被别的进程占用 / 键名不合法）一定要回错误：
           以前这里没有 catch，Promise 静默拒绝、响应永远不发，
           页面只能等到超时，DataSync 还以为这次写出去了。 */
        log('[data] 写入失败 ' + key + '：' + e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '写入数据文件失败：' + e.message } }));
        } else try { res.end(); } catch {}
      });
      return true;
    }
    if (req.method === 'DELETE') {
      /* 删不掉必须回错误，不能假装成功：客户端把「已删除」记进队列就不再重试，
         而服务器那份还在 → 下次启动对账把它拉回浏览器，用户看到「删了又回来」。 */
      /* `?nobak=1` = 删干净、不留 .bak。**只给「一次性清死键」用**（ui.js 的 sweepLegacyKeys）：
         走普通删除会给每个作废的键都留一份备份，于是设置页的「备份清单」里永远挂着
         几行用户根本认不出、也永远不会去恢复的键名（page_mode_video.bak 之类）——
         那是**已经宣告作废**的东西，为它留后悔药就是纯噪音。
         别的删除路径（清空某项数据、云同步删远端）一律要留备份，别顺手带上这个参数。
         顺带说明：`.bak` 文件只能经内部路由访问，`/data/<key>` 的键名白名单不允许点号
         （DATA_KEY_RE），所以浏览器侧没法单独去删它 —— 只能靠这里**一开始就别生成**。 */
      const q = req.url.split('?')[1] || '';
      const nobak = /(^|&)nobak=1(&|$)/.test(q);
      try {
        if (fs.existsSync(f)) { if (!nobak) keepDataBackup(key); fs.unlinkSync(f); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        log('[data] 删除失败：' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '删除数据文件失败：' + e.message } }));
      }
      return true;
    }
  }

  /* ---------- 云同步 ---------- */
  if (req.url.startsWith('/cloud')) {
    /* 命令必须精确匹配 /cloud/<cmd>（/cloud 本身 = status）。
       以前用 replace('/cloud','') 取子路径 —— /cloudsync、/cloudresolve、/cloudpull 这类
       「撞名路径」也会命中，而 LOCAL_ONLY 的同源检查要求 cloud 后面是 /、? 或串尾，
       于是这些路径**绕过同源保护**就能触发云同步（还会带着 .env 里的 WebDAV 凭据出网）。 */
    const pn = urlObj.pathname;
    const cmd = pn === '/cloud' ? 'status' : (/^\/cloud\/[A-Za-z]+$/.test(pn) ? pn.slice('/cloud/'.length) : '');
    if (!cmd) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '没有这条云同步命令：' + pn + '（路径必须精确写成 /cloud/<命令>）' } }));
      return true;
    }
    if (cmd === 'status' && req.method === 'GET') {
      const hasEnv = !!(process.env.CLOUD_WEBDAV_URL && process.env.CLOUD_WEBDAV_USER);
      let prompts = null;
      try { const d = promptCloudDir(urlObj.searchParams.get('dir')); prompts = { dir: d, count: promptFileList(d).length }; }
      catch (e) { prompts = { error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        dir: dataDirPath(), files: dataList().length,
        envConfigured: hasEnv, lastAt: cloudState.lastAt, lastResult: cloudState.lastResult,
        conflicts: cloudState.conflicts || [], lastUp: cloudState.lastUp || 0, lastDown: cloudState.lastDown || 0,
        unread: cloudState.unread || [], prompts,
      }));
      return true;
    }
    /* 备份清单：覆盖前留下的 .bak.json（云同步唯一能"后悔"的地方），设置页可一键恢复 */
    if (cmd === 'backups' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, dir: dataDirPath(), items: cloudBackups() }));
      return true;
    }
    /* 恢复某份备份：把 .bak.json 拷回 <key>.json（本机数据文件 → 下次页面加载/刷新时进浏览器） */
    if (cmd === 'restore' && req.method === 'POST') {
      (async () => {
        try {
          const raw = await readBody(req, res, 1 * 1024 * 1024);
          if (raw == null) return;
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const key = String(body.key || '');
          if (!DATA_KEY_RE.test(key)) throw new Error('非法的数据键名：' + key);
          const bak = dataFileOf(key + '.bak');                    // 备份名是 <key>.bak.json（不是 <key>.json.bak.json）
          if (!fs.existsSync(bak)) throw new Error('这份数据没有备份（' + key + '.bak.json 不存在）');
          dataWriteRaw(key, fs.readFileSync(bak));                 // 覆盖当前这份
          const base = cloudBaselineRead(); delete base[key];      // 基线作废：下次同步按现状重新判定
          cloudBaselineWrite(base);
          log('[cloud] 已从备份恢复 ' + key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, message: '已用备份覆盖本机数据文件：' + key + '（刷新页面后生效）' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      })();
      return true;
    }
    /* 冲突二选一：{ key, side:'local'|'remote' } —— 选本机就上传覆盖云端，选云端就下载覆盖本机 */
    if (cmd === 'resolve' && req.method === 'POST') {
      (async () => {
        try {
          const cfg = cloudCfg(req);
          const raw = await readBody(req, res, 1 * 1024 * 1024);
          if (raw == null) return;
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const key = String(body.key || '');
          const side = String(body.side || '');
          if (!DATA_KEY_RE.test(key)) throw new Error('非法的数据键名：' + key);
          if (side !== 'local' && side !== 'remote') throw new Error('side 只能是 local 或 remote');
          const base = cloudBaselineRead();
          const backups = [];
          if (side === 'local') {
            if (!fs.existsSync(dataFileOf(key))) throw new Error('本机没有这份数据：' + key);
            const buf = fs.readFileSync(dataFileOf(key));
            await cloudPushKey(cfg, key, buf);
            base[key] = { h: sha1Of(buf), ts: Date.now() };
            log('[cloud] 冲突解决：' + key + ' → 用本机覆盖云端');
          } else {
            await cloudEnsureDir(cfg);
            const got = await cloudRequest(cfg, 'GET', key + '.json', {});
            if (got.status !== 200) throw new Error('云端读不到这份数据 HTTP ' + got.status);
            cloudPullKey(key, got.body, backups);
            base[key] = { h: sha1Of(got.body), ts: Date.now() };
            log('[cloud] 冲突解决：' + key + ' → 用云端覆盖本机（覆盖前已备份 .bak.json）');
          }
          cloudBaselineWrite(base);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, side, backups,
            message: (side === 'local' ? '已用本机版本覆盖云端：' : '已用云端版本覆盖本机（已留备份）：') + key }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      })();
      return true;
    }
    if (cmd === 'test' || cmd === 'push' || cmd === 'pull' || cmd === 'sync') {
      (async () => {
        try {
          const cfg = cloudCfg(req);
          /* 提示词归档默认不传（body 里带 prompts:1 才走）。归档里是创作正文，
             比设置更不该默认出网；但它又恰恰是**丢了就没了**的那类东西（本地 .md 不进整包备份），
             所以给一个明确的开关，而不是替用户决定。
             body 放在最前面读：「测试连接」也要用它，好让「测一下」真的测出备份能不能成，
             而不是只测出一个连得上、传上去照样失败的假通过。 */
          let body = {};
          try {
            const raw = await readBody(req, res, 256 * 1024);
            if (raw && raw.length) body = JSON.parse(raw.toString('utf8') || '{}');
          } catch (e) { body = {}; }
          if (cmd === 'test') {
            await cloudEnsureDir(cfg);
            const list = await cloudList(cfg);
            let msg = '连接正常（云端已有 ' + list.size + ' 份数据）';
            let prompts = null;
            if (body.prompts) {
              try {
                const pdir = promptCloudDir(body.promptDir);
                const local = promptFileList(pdir).length;
                const subOk = await cloudEnsureSub(cfg, PROMPT_CLOUD_SUB);
                const remote = subOk ? await cloudListSub(cfg, PROMPT_CLOUD_SUB) : new Map();
                prompts = { dir: pdir, local, remote: remote.size, ok: !!subOk };
                msg += subOk
                  ? '；归档可传（本机 ' + local + ' 份 · 云端 ' + remote.size + ' 份）'
                  : '；归档目录建不出来（有些网盘不允许 WebDAV 建目录，请在网盘网页端手动建一个 ' + PROMPT_CLOUD_SUB + '/）';
              } catch (e) { prompts = { error: e.message }; msg += '；归档不可用：' + e.message; }
            }
            cloudStateSet({ lastAt: Date.now(), lastResult: msg });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, remoteCount: list.size, prompts, message: msg }));
            return;
          }
          /* 密钥默认不进云端：sk_key_* 是各处平台的 API 密钥，传到第三方网盘属于额外风险。
             设置页勾选「同步密钥」后会带 x-cloud-keys: 1，那时才参与上传/下载。 */
          const withKeys = String(req.headers['x-cloud-keys'] || '') === '1';
          const withPrompts = !!body.prompts;
          const base = cloudBaselineRead();
          let nUp = 0, nDown = 0, nDel = 0, same = 0;
          const details = [], conflicts = [], autoPicked = [], averted = [], backups = [], unread = [], skipDel = [], failed = [];
          for (const it of await cloudPlan(cfg, withKeys)) {
            const key = it.key, a = it.action;
            /* 单个键失败（某份上传被拒 / 云端拒绝删除）不要拖垮整次同步：
               以前这里没有 try，一份失败就跳到最外层 catch，后面的键全部不处理，
               而且基线不写回 → 用户看到「失败」却不知道哪份失败、下次还得从头再来。 */
            try {
              /* push 模式只上传、pull 模式只下载（老按钮的语义保留：手动控制方向）；
                 sync 模式两边都做（一键同步）。 */
              const wantPush = (a === 'push' || a === 'push-auto') && cmd !== 'pull';
              const wantPull = (a === 'pull' || a === 'pull-auto') && cmd !== 'push';
              /* 远端有这份、但这次没读下来：跳过并报出来（绝不 push 覆盖，见 cloudClassify） */
              if (a === 'error') { unread.push(key + '（' + (it.remoteErr || it.localErr || '读取失败') + '）'); continue; }
              if (a === 'conflict') { conflicts.push({ key, localTs: it.localTs, remoteTs: it.remoteTs }); continue; }
              /* 本地删掉的键要把云端那份也删掉，否则下次同步又把它拉回来（「删了又回来」）。
                 pull 模式不动云端；删除前先把云端内容存成 .bak.json，留一条找回的路。 */
              if (a === 'delete-remote') {
                if (cmd === 'pull') { skipDel.push(key); continue; }
                if (it.remoteBuf) { dataWriteRaw(key + '.bak', it.remoteBuf); backups.push(key + '.bak.json'); }
                await cloudDeleteKey(cfg, key);
                delete base[key];
                nDel++; details.push('✗ ' + key);
                continue;
              }
              if (a === 'same') { same++; if (it.localBuf) base[key] = { h: sha1Of(it.localBuf), ts: Date.now() }; continue; }
              if (a === 'push-auto' || a === 'pull-auto') autoPicked.push(key + '（' + (a === 'push-auto' ? '取本机' : '取云端') + '，首次同步没有基线）');
              if (wantPush) {
                if (!it.localBuf) continue;
                await cloudPushKey(cfg, key, it.localBuf);
                base[key] = { h: sha1Of(it.localBuf), ts: Date.now() };
                nUp++; details.push('↑ ' + key);
              } else if (wantPull) {
                if (!it.remoteBuf) continue;
                cloudPullKey(key, it.remoteBuf, backups);
                base[key] = { h: sha1Of(it.remoteBuf), ts: Date.now() };
                nDown++; details.push('↓ ' + key);
              } else if (cmd === 'pull' && it.localBuf && it.remoteBuf) {
                averted.push(key);          // pull 模式遇到该上传的：不动它（本次只做下载）
              } else if (cmd === 'push' && it.localBuf && it.remoteBuf) {
                averted.push(key);          // push 模式遇到该下载的：不动它（本次只做上传）
              }
            } catch (ek) { failed.push(key + '（' + ek.message + '）'); }
          }
          cloudBaselineWrite(base);
          /* 提示词归档跟着这一次同步走（勾了才走）。数据键全部处理完再动它 ——
             归档是独立的一份文件集合，不共用上面的基线，失败也不该影响数据键的结果。 */
          let prompts = null;
          if (withPrompts) {
            try {
              const pdir = promptCloudDir(body.promptDir);
              prompts = Object.assign({ dir: pdir }, await cloudSyncPrompts(cfg, pdir, cmd));
            } catch (e) { prompts = { error: e.message, failed: [e.message] }; }
          }
          /* 状态接口据此让设置页显示「待选择」清单；一起落盘，重启代理也还在（L51） */
          cloudStateSet({ lastAt: Date.now(), conflicts, lastUp: nUp, lastDown: nDown });
          const parts = [];
          if (nUp) parts.push('已上传 ' + nUp + ' 份');
          if (nDown) parts.push('已下载 ' + nDown + ' 份');
          if (nDel) parts.push('已删除云端 ' + nDel + ' 份（本机删掉的，云端同步删除；覆盖前留了 .bak）');
          if (skipDel.length) parts.push(skipDel.length + ' 份本机已删除但本次是「只下载」，没动云端');
          if (same) parts.push(same + ' 份一致');
          if (conflicts.length) parts.push('「' + conflicts.length + ' 份冲突待选择」');
          if (unread.length) parts.push(unread.length + ' 份读不下来（已跳过，未覆盖云端）');
          if (failed.length) parts.push('「' + failed.length + ' 份处理失败」');
          if (prompts) {
            if (prompts.error) parts.push('提示词归档：' + prompts.error);
            else {
              if (prompts.up) parts.push('归档上传 ' + prompts.up + ' 份');
              if (prompts.down) parts.push('归档下载 ' + prompts.down + ' 份');
              if (prompts.onlyRemote) parts.push('云端有 ' + prompts.onlyRemote + ' 份这次没拿下来'
                + (cmd === 'push' ? '（这次是「只上传」；点「↓ 从云端下载」或「⇅ 一键双向同步」即可取回）' : ''));
              if (prompts.same) parts.push('归档 ' + prompts.same + ' 份一致');
              if (prompts.failed && prompts.failed.length) parts.push('「归档 ' + prompts.failed.length + ' 份处理失败」');
            }
          }
          cloudStateSet({ lastResult: parts.join('，') || '没有需要同步的数据', unread });
          log('[cloud] ' + cloudState.lastResult + (details.length ? '：' + details.join(' ') : '')
            + (unread.length ? '；读不下来：' + unread.join(' ') : '')
            + (failed.length ? '；失败：' + failed.join(' ') : '')
            + (prompts && prompts.failed && prompts.failed.length ? '；归档失败：' + prompts.failed.join(' ') : ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: nUp + nDown, up: nUp, down: nDown, del: nDel, same, details,
            conflicts, autoPicked, averted, backups, unread, failed, skipDel, prompts, message: cloudState.lastResult }));
        } catch (e) {
          cloudStateSet({ lastResult: '失败：' + e.message });
          log('[cloud] 失败：' + e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      })();
      return true;
    }
  }
  return false;
}

/* ---------- 静态文件（工作台自己的前端资源）----------
   以前这里是「readFile + Cache-Control: no-store」：内容页在 iframe 里，每次切页都是一次
   全新的文档导航，no-store 让浏览器把同一批 JS/CSS 重新下载、重新解析、重新执行一遍
   （实测一次切页实际传 ~2 MB）。改成 ETag + 304：内容没变就只回一个 304 空响应，
   浏览器复用本地那份。再给 text/* 加 gzip：JS 实测 1,189 KB → 433 KB（-63.6%）。
   语义上 no-store 与 ETag 冲突，这里二选一 —— 用 no-cache（可缓存但每次必须带 ETag 回验）。
   注意：**只有这一处静态资源这么做**；/render*、/asset/*、/local-assets、带签名的媒体路由
   的 no-store 是有意的，绝不能跟着改（见 AGENTS「统一路由（硬性约定）」）。 */
const staticGz = new Map();          // full → { mtimeMs, size, buf }：按 mtime+size 失效的压缩结果
const STATIC_GZ_MAX = 64;            // 只留最近若干份，避免无界（静态文件本来就那十几个）
function serveStatic(req, res, full, ext) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const etag = '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
    const type = MIME[ext] || 'application/octet-stream';
    /* 只压文本类：图片 / 字体 / 视频已经压过或压不动，压了白费 CPU 还可能变大 */
    const compressible = /^(text\/|application\/(javascript|json|svg))/.test(type) || /^image\/svg/.test(type);
    const wantGz = compressible && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const head = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
    if (wantGz) head['Vary'] = 'Accept-Encoding';
    const cached = staticGz.get(full);
    if (wantGz && cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      head['Content-Encoding'] = 'gzip';
      head['Content-Length'] = String(cached.buf.length);
      res.writeHead(200, head);
      res.end(req.method === 'HEAD' ? undefined : cached.buf);
      return;
    }
    fs.readFile(full, (err2, buf) => {
      if (err2) { res.writeHead(404); res.end('not found'); return; }
      if (req.method === 'HEAD') { head['Content-Length'] = String(buf.length); res.writeHead(200, head); res.end(); return; }
      if (!wantGz) { head['Content-Length'] = String(buf.length); res.writeHead(200, head); res.end(buf); return; }
      zlib.gzip(buf, (err3, gz) => {
        if (err3 || !gz) { head['Content-Length'] = String(buf.length); res.writeHead(200, head); res.end(buf); return; }
        staticGz.set(full, { mtimeMs: st.mtimeMs, size: st.size, buf: gz });
        if (staticGz.size > STATIC_GZ_MAX) { const k = staticGz.keys().next().value; staticGz.delete(k); }
        head['Content-Encoding'] = 'gzip';
        head['Content-Length'] = String(gz.length);
        res.writeHead(200, head);
        res.end(gz);
      });
    });
  });
}

const server = http.createServer((req, res) => {
  // handleRequest 是 async（出站地址护栏要解析域名），所以这里用 Promise 链兜异常：
  // 同步抛与异步拒绝都走同一个 500 分支，单个请求出错不拖垮整个代理进程。
  Promise.resolve().then(() => handleRequest(req, res)).catch(e => {
    try { log('[error] 请求处理异常 ' + req.url + '：' + (e && e.message)); } catch {}
    try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); } } catch {}
  });
});
/* 畸形请求（错误的 HTTP 帧）：回 400，不让它变成 uncaughtException */
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });

async function handleRequest(req, res) {
  loadEnvFile(false);   // 热加载 .env：改完密钥不用重启
  /* 路由比较统一用去掉查询串的路径：用原始 req.url 的话 /registry?v=1、/env-status?t=1
     这类带查询串的写法会匹配不上、掉到静态服务回 404。 */
  const dataPath = req.url.split('?')[0];
  /* 同源判定必须在 cors() 之前：跨站请求连预检都拿不到放行，也读不到任何响应内容。
     （CORS 是全站放开的，先放行再拒绝的话，跨站页面虽然拿不到数据，但连 403 都能读到；
       而且 /render 这类会吃 CPU / 落盘的路由也不该让外部页面碰到。） */
  if (isWorkbenchOnlyUrl(req.url) && !sameOriginOnly(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '只允许本工作台页面访问（跨站请求已拒绝）' } }));
    return;
  }
  if (isPostOnlyUrl(req.url) && req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
    res.end(JSON.stringify({ error: { message: '这条命令会改本机/云端状态，必须用 POST 调用：' + req.url.split('?')[0] } }));
    return;
  }
  if (cors(req, res)) return;
  if (req.url.split('?')[0] === '/media/prepare-reference-video') {
    await prepareReferenceVideo(req, res);
    return;
  }
  /* 能力接口：页面问「这个平台的模型有什么能力」走这一条 —— 端点、密钥、兜底都在代理里 */
  if (req.url.startsWith('/capabilities')) { handleCapabilities(req, res, new URL(req.url, 'http://127.0.0.1')); return; }
  /* 提示词归档：写文件/查提示词/打开目录（见上方「提示词归档」一节） */
  if (dataPath === '/prompts' || dataPath.startsWith('/prompts/')) {
    handlePrompts(req, res, new URL(req.url, 'http://127.0.0.1'));
    return;
  }
  if (handleData(req, res, new URL(req.url, 'http://127.0.0.1'))) return;
  /* 本机依赖体检：短剧导出成片要 ffmpeg，设置页与助手的「一键体检」都读这一份。
     以前只有点导出才收到一句「无法启动 ffmpeg：…（请确认已安装并加入 PATH）」——
     没装 / 装了不在 PATH / 装的是 Windows 商店那个占位壳，三种在界面上长得一模一样。 */
  if (dataPath === '/sys-status') {
    const body = JSON.stringify(sysStatus(req.url.includes('fresh=1')));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  /* 「这个端口上是不是本项目」—— 启动器判断身份用的一条。
     为什么必须有它：以前判据是「端口上有人在听」，而那个号上可能是**别的 node 程序**。
     后果不是「打不开页面」，而是启动器会把那个号当成「本项目在跑」直接开页面，
     而点「停止」时按「监听者不是 node 才不动」那条闸继续往下走 —— **杀掉别人机器上的 node 进程**。
     这一条只回一个身份标记，不含任何密钥、地址或用户数据。
     launcher.ps1 的 Test-OurProxy 读的是 app + registry.version 两个字段。 */
  if (dataPath === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ app: 'shiji-workbench', registry: REGISTRY.version, port: PORT, pid: process.pid }));
    return;
  }
  if (dataPath === '/env-status') {
    // 密钥来源状态：只暴露「环境变量里有没有密钥」和密钥尾号（用于判断本地是否存了同一把默认密钥），不泄露完整密钥
    const out = {};
    for (const p of REGISTRY.providers) {
      const kid = p.keyId || p.id;
      if (out[kid] !== undefined) continue;
      const v = process.env[p.keyEnv] || DEFAULTS[kid] || '';
      out[kid] = { hasEnv: !!v, tail: v ? String(v).slice(-4) : '' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(out));
    return;
  }
  /* 清空代理侧的接口缓存（设置页的「清理缓存」按钮）。
     这四份都只是「上游数据的副本」，清掉最多多等一次请求，绝不动用户数据：
       listCache/detailCache —— 列表与任务详情的短缓存（几秒~几分钟）
       assetUrlCache        —— 资产签名地址（换账号/签名失效时清）
       capCache             —— /capabilities 结果（平台改了能力声明，不想等 TTL）
     hostGuardCache 故意不清：那是 SSRF 防护的 DNS 结果，清了只会让外链请求重新解析域名。 */
  if (dataPath === '/clear-cache' && req.method === 'POST') {
    const n = { list: listCache.size, detail: detailCache.size, assetUrl: assetUrlCache.size, cap: capCache.size };
    listCache.clear(); detailCache.clear(); assetUrlCache.clear(); capCache.clear();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, cleared: n }));
    return;
  }
  if (dataPath === '/registry') {
    // 供客户端按能力过滤模型；设置页添加的自定义平台合并在这里（清单来自 .data/sk_custom.json）
    const body = JSON.stringify({
      ...REGISTRY,
      providers: allProviders(),
      /* 有哪些条目被丢掉、为什么：界面据此说清「我明明添加了，下拉里没有」，
         而不是让人去猜是不是功能坏了（原因文本见 customProblem） */
      custom: { dropped: customNotice.dropped, reason: customNotice.reason },
      /* 型号清单偏好读不动时要说出来（与上面 custom.notice 同一立场）：
         不然「我把这个型号藏了，下拉里怎么还在」只能靠猜。 */
      modelPrefs: { reason: modelPrefsNotice.reason, key: MODEL_PREFS_KEY },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
    return;
  }
  /* 添加自定义供应商时的「获取型号列表」：拿**表单里现填的**形状 + 地址 + 密钥，问一次它自己的型号表。
     为什么必须留在代理里、不能由页面直连：这条路由要把用户的密钥递到他自己填的那个主机，
     「只收公网 https / 拒回环与内网 / 域名解析到内网也拒」那套判据（safeOutboundUrl，
     与 buildCustom 用的是同一个）以及「绝不回退 .env 里的内置密钥」都在这一层。
     页面自己发就等于把这套安全判据抄第二份 —— 而漏一份就是「密钥发去了不该去的主机」。
     走已有平台的 relay 也不行：图片/视频/语音那几家都没有 baseEditable，
     代理会拒掉 x-up-base（那是故意的，见 relay 转发那段注释）。 */
  if (dataPath === '/custom/models' && req.method === 'POST') {
    readBody(req, res, 8 * 1024).then(raw => {
      if (raw == null) return;
      let q = {};
      try { q = JSON.parse(raw.toString('utf8')) || {}; } catch {}
      const tpl = REGISTRY.providers.find(p => p.id === String(q.shape || ''));
      const bad2 = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: msg })); };
      if (!tpl) { bad2(400, '找不到当模板的内置平台：' + (q.shape || '(空)')); return; }
      const key = String(q.key || '').replace(/^\s*Bearer\s+/i, '').trim();
      if (!key) { bad2(400, '没有密钥 —— 型号列表是要鉴权的接口'); return; }
      /* 地址校验用**异步那份** guardOutboundUrl（除了字面量 IP 还会解析域名、拦住 *.nip.io
         这类「看着是公网、实际指向 127.0.0.1」的写法），与取外链字节那条路同一套判据。
         buildCustom 落盘时用的是同步那份 —— 那是「先存下来、真正发请求时再判」；
         这里马上就要把密钥递出去，必须先判干净。 */
      guardOutboundUrl(String(q.base || '')).then(base => {
        /* 型号表端点：声明了就用它；OpenAI 兼容的那一族都在 base + /models（文字 AI 也走这条，
           TextAI.rawModels 拼的就是 relay + '/models'）。没有声明就算 /models 而不是报错 ——
           报「这一类没有型号列表接口」会让「其实有」的平台没法用。 */
        const ep = (tpl.endpoints && tpl.endpoints.models) || '/models';
        const url = base.replace(/\/+$/, '') + ep;
        /* 这条路由对「问不到型号」的回答一直是 200 + { ok:false, error }（上游回了非 200 也这么答），
           连不通也走同一份 —— 设置页那一句 `d.error` 才拿得到真实原因。
           以前只有 ur 上挂了 failUpstream，而**域名解析不出来**的错误是发在请求对象上的
           （ur 压根没被创建），于是这个响应永远不结束：页面只能等到自己的超时，
           报出来的是「连不上本地代理（proxy.js 没启动？）」—— 而代理活得好好的。 */
        const out = o => {
          if (res.headersSent) { try { res.destroy(); } catch {} return; }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(o));
        };
        const fail = e => out({ ok: false, from: url, error: '连不通（打到 ' + url + '）：' + String((e && e.message) || e || '') });
        const rq = upRequest(url, { method: 'GET', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, timeoutMs: 20000 }, ur => {
          const bufs = [];
          ur.on('data', c => bufs.push(c));
          ur.on('end', () => {
            const buf = Buffer.concat(bufs);
            if (ur.statusCode !== 200) {
              const txt = buf.toString('utf8', 0, 400).replace(/\s+/g, ' ').trim();
              out({ ok: false, from: url, error: '它回了 HTTP ' + ur.statusCode + (txt ? '：' + txt : '') });
              return;
            }
            let d = {};
            try { d = JSON.parse(buf.toString('utf8')) || {}; } catch (e) {}
            const arr = d.data || d.models || d.result || (Array.isArray(d) ? d : []);
            const models = (Array.isArray(arr) ? arr : [])
              .map(m => { const id = m && (m.id || m.name); if (!id) return null; return { id: String(id), name: String((m && (m.display_name || m.name)) || id) }; })
              .filter(Boolean);
            out({ ok: models.length > 0, from: url, count: models.length, models,
              error: models.length ? '' : '它回了 200，但响应里没有型号列表（不是 id 数组）' });
          });
          ur.on('error', fail);
        });
        /* upRequest 的 timeoutMs 是**空闲**超时：域名解析那一步还没有 socket，不受它管。
           不加这道墙钟的话，一个解析不出来的地址会让设置页的「获取型号列表」一直转圈。 */
        const wall = setTimeout(() => { try { rq.destroy(new Error('等待上游超过 25 秒')); } catch (e) {} }, 25000);
        rq.on('close', () => clearTimeout(wall));
        rq.on('error', e => { clearTimeout(wall); fail(e); });
      }).catch(e => bad2(400, '地址不可用：' + e.message));
    });
    return;
  }
  /* ============================================================================
     弹系统原生的「选择文件夹」（POST /pick-dir）
     ---------------------------------------------------------------------------
     为什么是代理干的活：设置页那个目录输入框，用户要的是「点一下、弹资源管理器、自己挑」。
     纯前端做不到 —— 浏览器的 `<input type=file webkitdirectory>` **只给文件夹名不给全路径**，
     File System Access API 给的是句柄、不是字符串、也存不下来。老老实实只留一个输入框
     是把平台的限制原样甩给用户，所以这条路由让**本机代理**去弹系统自带的那个对话框
     （和 `probeTool` 探 ffmpeg、`/local-assets/open` 开资源管理器是同一类：只有本机进程能弹）。

     **用哪个 PowerShell 决定弹出来的是哪个框**（实测，两者不是同一个东西）：
       · `pwsh`（PowerShell 7，.NET 8 的 WinForms，程序集在 `Program Files\PowerShell\7\`）
         → `FolderBrowserDialog` 是**现代 IFileDialog** 实现：左边有快速访问/此电脑，
           上面有地址栏、可搜索、能新建文件夹 —— **和 Chrome 选「下载文件夹」是同一个壳**。
       · `powershell.exe`（5.1，GAC 里的 .NET Framework WinForms）
         → 老式 `SHBrowseForFolder` 树形框，没有地址栏、不能搜索。
     所以**优先找 pwsh，找不到才退回 5.1**，并且把用的哪一个回报给页面（`modern` 字段），
     别让人以为选了个框其实弹出来的是另一个。

     注入防护：start/title **一律走环境变量传进子进程**，脚本文本里不拼任何用户输入，
     再用 `-EncodedCommand`（UTF-16LE base64）传脚本本身 —— PowerShell 不会对参数做二次解析，
     所以路径里有引号、括号、分号、反引号都不会被当成命令。

     路径走 **base64(UTF-8)** 回传，不直接写文本：子进程 stdout 是管道，走的是
     「重定向输出」那套编码而不是控制台编码，`D:\AI生成\图片` 这种中文路径有变成乱码的
     可能 —— 路径一旦存错，界面显示「已保存」而文件永远落在别处，且不报错。

     退出码：0 = 选好了（stdout 一行 base64 路径）；3 = 用户取消（**不是失败**，页面不该弹红字）；
             其它 = 真出错了，把 stderr 的话照实带回页面。
     ========================================================================== */
  if (dataPath === '/pick-dir' && req.method === 'POST') {
    const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { message: msg } })); };
    if (process.platform !== 'win32') return fail(501, '弹系统文件夹选择框目前只做了 Windows（这台机器是 ' + process.platform + '），还是手填路径吧');
    const SCRIPT = [
      "$ErrorActionPreference = 'Stop'",
      "try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop } catch { Write-Output 'NOFORMS'; exit 9 }",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      /* AutoUpgradeEnabled = 现代 IFileDialog（.NET Core 3.0+ 上 FolderBrowserDialog 的默认实现）。
         显式写出来是为了「这个框是哪个」不靠默认值：默认值哪天变了，这里弹出来的框就悄悄换了样子。 */
      "$d.AutoUpgradeEnabled = $true",
      "$d.ShowNewFolderButton = $true",
      "$t = $env:AII_PICK_TITLE; if ($t) { $d.Description = $t }",
      "$s = $env:AII_PICK_START",
      "if ($s -and (Test-Path -LiteralPath $s -PathType Container)) { $d.SelectedPath = $s }",
      "$r = $null; try { $r = $d.ShowDialog() } catch { Write-Output ('SHOWFAIL: ' + $_.Exception.Message); exit 4 }",
      "if ($r -ne [System.Windows.Forms.DialogResult]::OK) { exit 3 }",
      "$p = $d.SelectedPath; if (-not $p) { Write-Output 'NOPATH'; exit 5 }",
      /* base64(UTF-8) 传路径：绕开「管道输出用重定向编码」这个坑（中文目录名会变乱码） */
      "[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))",
      "exit 0",
    ].join('; ');
    /* 优先 pwsh（现代框），退回 Windows PowerShell 5.1（老框）—— 两者都试过再报错 */
    /* ⚠ 顺序就是优先级：**pwsh 在前**（现代框），5.1 只在没有 pwsh 的机器上兜底。
       写成 5.1 在前的话这台机器明明装了 PowerShell 7，却还是弹出那个没有地址栏的老树形框
       —— 自检 `.tmp-pickdir.cjs` 里有一条就是钉这个顺序的（踩过）。 */
    const psCandidates = [
      { exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', modern: true },
      { exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), modern: false },
    ];
    const ps = psCandidates.find(c => { try { return fs.existsSync(c.exe); } catch (e) { return false; } });
    /* start 只是「对话框打开时停在哪」，可以为空；认不出来的（不存在 / 不是目录 / 太长）就当没给。
       title 只影响对话框顶上那行字，截到 60 个字符免得有人往里塞整段文章。 */
    readBody(req, res, 16 * 1024).then(raw => {
      if (raw == null) return;
      let title = '', start = '';
      try {
        const sp = JSON.parse(raw.toString('utf8')) || {};
        title = String(sp.title || '').trim().slice(0, 60);
        const s = String(sp.start || '').trim();
        if (s && s.length <= 400 && path.isAbsolute(s) && fs.existsSync(s) && fs.statSync(s).isDirectory()) start = s;
      } catch (e) { /* start / title 只影响对话框长什么样，读不到就用默认，不算错 */ }
      const env2 = Object.assign({}, process.env, {
        AII_PICK_TITLE: title || '选择要保存到的文件夹',
        AII_PICK_START: start,
      });
      try {
        if (!ps) return fail(501, '这台机器上既没有 PowerShell 7 也没有 Windows PowerShell，还是手填路径吧');
        /* ⚠ 必须用**异步** spawn，不能用 spawnSync：
           用户在文件夹选择框里慢慢翻目录可能一两分钟，而 spawnSync 是**堵死事件循环**的 ——
           那段时间里整个代理一条请求都答不了：正在跑的拍片任务轮询、配音、抽帧全卡住，
           表现是「点一下选择文件夹，整个应用都死了」。踩过一次。
           `-STA` 是硬要求（WinForms 对话框要单线程套间，MTA 下弹出来是空白或者直接抛），
           `-EncodedCommand` 见上面的注入防护。 */
        const p = spawn(ps.exe, ['-NoProfile', '-STA', '-WindowStyle', 'Hidden',
          '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
          { env: env2, windowsHide: false, cwd: __dirname });
        let out = '', err = '', over = false, timer = null;
        const done = fn => { if (over) return; over = true; if (timer) clearTimeout(timer); try { p.kill(); } catch (e) {} fn(); };
        /* 兜底上限：用户开着框忘了选，不能一直占着一个连接 */
        timer = setTimeout(() => done(() => fail(504, '5 分钟没人选，代理把它关掉了（选完点「选择…」再试一次）')), 300000);
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
        p.on('error', e => done(() => fail(500, '弹不出文件夹选择框：' + (e.message || e.code))));
        p.on('close', code => done(() => {
          /* 取消**不是失败**：回 200 + cancelled，页面据此安静收手，不弹红字 */
          if (code === 3) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ok: false, cancelled: true })); }
          if (code !== 0) {
            const say = firstLine(out) || firstLine(err);
            if (say === 'NOFORMS') return fail(500, '这台机器的 PowerShell 装不上窗体组件（System.Windows.Forms），弹不出选择框 —— 还是手填路径吧');
            return fail(500, '文件夹选择框没起来：' + cap120(say || ('退出码 ' + code)));
          }
          /* stdout 是 base64(UTF-8)。解不出来 / 解出来不是绝对路径时**退回按原文读** ——
             万一某台机器上脚本换了个版本，也不至于直接报「没回路径」把整条功能废掉。 */
          const rawLine = firstLine(out);
          let dir = '';
          try { dir = Buffer.from(rawLine, 'base64').toString('utf8'); } catch (e) { dir = ''; }
          if (!path.isAbsolute(dir)) dir = rawLine;
          if (!dir || !path.isAbsolute(dir)) return fail(500, '文件夹选择框没回路径（这是本机 PowerShell 的问题，不是设置的问题）');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          /* modern=false 意味着弹出来的是 5.1 的老式树形框（没有地址栏、不能搜索）——
             页面据此把这件事说清楚，而不是让用户以为「系统就是这个样」。 */
          res.end(JSON.stringify({ ok: true, dir, modern: !!ps.modern }));
        }));
        /* 客户端自己走了（关了页面/切走）就把子进程收掉，别让一个没人要的框留在屏幕上 */
        res.on('close', () => { if (!over) { over = true; if (timer) clearTimeout(timer); try { p.kill(); } catch (e) {} } });
      } catch (e) {
        log('[pick-dir] ' + e.message);
        fail(500, '弹文件夹选择框时出错：' + e.message);
      }
    });
    return true;
  }
  /* ============================================================================
     按类型另存到用户指定的文件夹（POST /save）
     ---------------------------------------------------------------------------
     背景：设置页「自动保存」现在只能全开或全关，产物一律落在项目下的 .assets/。
     用户要的是**按类型分别决定存不存、分别存到哪个文件夹**（图一个目录、片一个目录）。
     目录由用户自己填（浏览器不允许网页拿到真实路径，所以只能文本输入 + 校验），
     **代理不猜也不枚举目录**：只往「配置里写着的那个目录」里写一个文件，
     写不写得进去（路径不存在、没权限、被别的程序占着）当场照实回话，页面不假装成功。

     安全：① 这条路由在 LOCAL_ONLY 里（同源检查，跨站直接 403 —— 任意网页往你硬盘写文件是严重问题）；
           ② **目录只从服务端读的配置来**，请求体里带目录一律忽略（否则就成了「让任意网页指定落盘路径」）；
           ③ 文件名一律 path.basename + 白名单字符（防 ../ 穿越）；
           ④ 类型只认 image / video / audio 三档，别的当 400，不接受调用方自造。
     ========================================================================== */
  if (dataPath === '/save' && req.method === 'POST') {
    readBody(req, res, 288 * 1024 * 1024).then(raw => {      // base64 媒体较大，给足
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch {}
      const bad3 = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg } })); };
      if (!spec || !spec.data) return bad3(400, '缺少 data(base64)');
      const type = String(spec.type || '').toLowerCase();
      if (!SAVE_KINDS.includes(type)) return bad3(400, 'type 只能是 ' + SAVE_KINDS.join(' / '));
      /* ⚠ 目录**只从配置读**。请求体里就算递了 dir 也一视同仁地丢掉：
         一旦认客户端递的目录，这条路由就等于「任意本机网页往任意路径写文件」。 */
      const dir = autosaveDir(type);
      if (!dir) return bad3(409, '设置里没有给' + typeLabel(type) + '指定文件夹（先到设置页填一个）');
      if (insideLocalDir(dir)) return bad3(409, '另存目录不能设成本机资产库本体（.assets）—— 产物本来就存在那儿了，请换一个普通文件夹');
      const fmt = String(spec.format || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const base = saveBaseName(spec.name, 'file.' + (fmt || 'bin'));
      try {
        fs.mkdirSync(dir, { recursive: true });
        const buf = Buffer.from(String(spec.data), 'base64');
        const file = saveUniqueName(dir, base, () => null);
        if (!file) return bad3(409, '那个目录里已经有一千个同名文件了');
        const full = path.join(dir, file);
        fs.writeFileSync(full, buf);
        autosaveUsedAdd(dir);          // 这个目录从此可以当「旧目录」被搬走（见 /save-move）
        log(`[save] ${type} → ${dir}${path.sep}${file}（${(buf.length / 1024).toFixed(0)} KB）`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, type, dir, file, bytes: buf.length, path: full }));
      } catch (e) {
        /* 目录写不进去**照实说**：路径不存在 / 没权限 / 盘满 / 别的程序占着。
           页面照原样显示这一句，用户才知道要去改设置，而不是看到「保存失败」然后猜。 */
        log('[save] 写入失败：' + e.message);
        bad3(500, '写不进 ' + dir + '：' + (e && e.code ? e.code + ' ' : '') + e.message);
      }
    });
    return;
  }
  /* ============================================================================
     把**已经存在本机资产库里的成品**补一份到用户指定的文件夹（POST /save-local）
     ---------------------------------------------------------------------------
     为什么需要这一条：`/save` 只挂在**镜像流程内部**（assetlib.js 的 runOne），
     而镜像那一步先被 `offer()` 的「这份产物已经存过了就跳过」挡在前面。
     于是功能加上之前下载的那批（实测这台机器是 83 个 / 86.4 MB）永远不会被补写 ——
     用户打开开关、目录也填对了，`文件\` 里还是空的，而界面上看不出任何异常。
     这里补的就是那条缺口：**字节已经在 .assets 里，不重新下载、不重新回源，直接拷一份。**
     `.assets` 里那份**一律不动** —— 它是资产库的本体（离线能看、删了能回源、
     缩略图全靠它），移走了等于把工作台弄坏。

     安全与 /save 同款：LOCAL_ONLY 同源、目录只从配置读（请求体里的 dir 一律忽略）、
     文件名只认索引里已登记的本机号（不接受调用方自造路径或文件名）。
     ========================================================================== */
  if (dataPath === '/save-local' && req.method === 'POST') {
    readBody(req, res, 8 * 1024 * 1024).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch {}
      const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { message: msg } })); };
      const ids = Array.isArray(spec && spec.ids) ? spec.ids.filter(x => typeof x === 'string') : [];
      if (!ids.length) return fail(400, '没有要补存的产物');
      if (ids.length > 2000) return fail(400, '一次最多补存 2000 个');
      const index = localIndexRead();
      const saved = [], missing = [], noKind = [], full = [], dup = [];
      let bytes = 0;
      /* 目标目录的内容表按目录缓存：ids 里三种类型会各写各的目录，
         目录一变就重扫一次（saveDirIndex 按 mtime 缓存整张表，目录没变就直接复用）。 */
      let sumsDir = '', sums = null;
      for (const id of ids) {
        const ent = index.find(x => x && x.id === id);
        if (!ent) { missing.push(id); continue; }
        /* 类型判据复用 localMediaType（扩展名 → mime → media_type），不另写一份名单 */
        const kind = saveKindOf(localMediaType(ent));
        if (!kind) { noKind.push(id); continue; }
        const dir = autosaveDir(kind);
        if (!dir) { full.push({ id, kind, why: typeLabel(kind) + '这一类现在是关着的' }); continue; }
        if (insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }
        const src = localFileFromEntry(ent);
        if (!src) { missing.push(id); continue; }
        try {
          fs.mkdirSync(dir, { recursive: true });
          const buf = fs.readFileSync(src);
          /* 已经有同一份内容就别再拷 —— 用户改目录之前新生成的那批早就躺在旧目录里，
             不挡这一下就会在新目录里出现两份同一个视频（见 saveDirIndex 的注释）。 */
          if (sumsDir !== dir) { sumsDir = dir; sums = saveDirIndex(dir); }
          const hash = sha1Of(buf);
          const hit = sums.get(buf.length, hash);
          if (hit) { autosaveUsedAdd(dir); dup.push({ id, kind, file: hit, dir }); continue; }
          const base = saveBaseName(ent.name || ent.file || (id + '.' + (ent.format || 'bin')),
            id + '.' + (ent.format || 'bin'));
          const file = saveUniqueName(dir, base, () => null);
          if (!file) { full.push({ id, kind, why: '那个目录里已经有一千个同名文件了' }); continue; }
          fs.writeFileSync(path.join(dir, file), buf);
          autosaveUsedAdd(dir);
          sums.add(buf.length, hash, file);   // 本次刚写的也要进表，后面那个同内容的 id 就不会再拷一遍
          bytes += buf.length;
          saved.push({ id, kind, file, dir });
        } catch (e) { full.push({ id, kind, why: '写不进 ' + dir + '：' + (e && e.code ? e.code + ' ' : '') + e.message }); }
      }
      log('[save-local] 补存：存了 ' + saved.length + ' 个（' + (bytes / 1048576).toFixed(1) + ' MB）'
        + (dup.length ? '，那边已经有了 ' + dup.length + ' 个' : '')
        + (missing.length ? '，索引/文件已不在 ' + missing.length + ' 个' : '')
        + (noKind.length ? '，不归任何一类 ' + noKind.length + ' 个' : '')
        + (full.length ? '，没存成 ' + full.length + ' 个' : ''));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, saved, dup, missing, noKind, full, bytes }));
    });
    return;
  }
  /* ============================================================================
     换下载位置时把**旧目录里那些副本**搬过去（POST /save-move）
     ---------------------------------------------------------------------------
     为什么不合并进 /save-local：搬走会**删掉源文件**，性质与「再拷一份」不同，
     走两条路由、两种返回，页面才能分别告诉用户「哪些是复制、哪些是搬走」。
     目录：目标**只从配置读**（同 /save）；来源必须过 `autosaveUsedHas` ——
     证明它是本工作台自己写出来的目录，否则这条路由就成了「搬任意路径的文件」。
     顺序：先写目标、写成功才删源（写失败源文件留在原地，绝不反过来）。
     ========================================================================== */
  if (dataPath === '/save-move' && req.method === 'POST') {
    readBody(req, res, 1024 * 1024).then(raw => {
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch {}
      const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { message: msg } })); };
      const kind = String((spec && spec.kind) || '').toLowerCase();
      if (!SAVE_KINDS.includes(kind)) return fail(400, 'kind 只能是 ' + SAVE_KINDS.join(' / '));
      const fromRaw = String((spec && spec.from) || '').trim();
      if (!fromRaw) return fail(400, '没有要搬的旧目录');
      /* from 传空串 / '@default' = 「旧的也是默认目录」。这一支**不需要**白名单：
         路径是代理自己算的（autosaveDefaultDir），不是客户端递进来的 ——
         白名单是拿来挡「客户端指定源目录」的，这一支压根没有客户端指定的路径。 */
      const srcIsDefault = (fromRaw === '@default' || fromRaw === '');
      const to = autosaveDir(kind);                       // 目标只由配置决定，请求体里的 dir 一律忽略
      if (!to) return fail(409, typeLabel(kind) + '这一类现在是关着的');
      let srcDir;
      try { srcDir = srcIsDefault ? autosaveDefaultDir(kind) : path.resolve(fromRaw); }
      catch { return fail(400, '旧目录不是一个有效路径'); }
      /* 白名单挡不住一种情况：用户把「另存目录」**填成 .assets 或它的某个子目录**。
         那样 /save 写进去的副本会让那个目录进白名单（autosaveUsedAdd），
         之后这条路由就会**真的从资产库里把文件搬走** —— 而 .assets 是整个工作台的本体：
         离线能看、删了能回源、缩略图全靠它，搬空了资产库就空了。
         白名单证明的是「这个目录是本工作台写的」，证明不了「搬走它是安全的」，
         所以资产库本体要单独拦 —— 判据是 insideLocalDir 那一份，三条路由共用。 */
      if (insideLocalDir(srcDir)) return fail(403, '那个目录是本机资产库本体（.assets），不从那里搬 —— 资产库一空，工作台就看不到东西了');
      if (insideLocalDir(to)) return fail(403, '另存目录不能设成本机资产库本体（.assets）—— 请换一个普通文件夹');
      if (srcDir === to) return res.writeHead(200, { 'Content-Type': 'application/json' }),
        res.end(JSON.stringify({ ok: true, moved: [], bytes: 0, note: '新旧目录是同一个，没什么可搬' }));
      if (!srcIsDefault && !autosaveUsedHas(srcDir)) return fail(403, '那个目录不是本工作台写出去的，不搬（只搬自动存到过的目录）');
      let names = [];
      try { names = fs.readdirSync(srcDir); } catch (e) { return fail(404, '读不出旧目录：' + e.message); }
      const moved = [], skipped = [], failed = [], dup = [];
      let bytes = 0;
      try { fs.mkdirSync(to, { recursive: true }); } catch (e) { return fail(500, '建不出 ' + to + '：' + e.message); }
      const sums = saveDirIndex(to);     // 目标里已有的内容，搬之前先看一眼，避免搬出 xxx-2 这种重复
      for (const name of names) {
        const src = path.join(srcDir, name);
        let st; try { st = fs.statSync(src); } catch { continue; }
        if (!st.isFile()) continue;
        /* 属不属于这一类：复用 localMediaType（扩展名那一份名单），不另判 */
        if (localMediaType({ file: name }) !== typeLabel(kind)) { skipped.push(name); continue; }
        try {
          const buf = fs.readFileSync(src);
          const hash = sha1Of(buf);
          /* 目标里已经有同一份内容：**不重写**，只把源文件删掉 —— 这仍然是「搬」，
             内容在新目录里好好的一份；不这么做的话，用户补存过的那批会被搬成第二份。
             删源之前已经确认过内容一致，所以这一步不会丢东西。 */
          const hit = sums.get(buf.length, hash);
          if (hit) { fs.unlinkSync(src); autosaveUsedAdd(to); dup.push({ from: name, to: hit }); continue; }
          const base = saveBaseName(name, name);
          const file = saveUniqueName(to, base, () => null);
          if (!file) { failed.push({ name, why: '新目录里已经有一千个同名文件了' }); continue; }
          fs.writeFileSync(path.join(to, file), buf);
          fs.unlinkSync(src);                            // 写成功了才删源
          autosaveUsedAdd(to);
          /* 记账**先于**任何可能抛异常的缓存写入** —— 这一段早先写成 sums.set(sig, file)，
             sig 从未声明，于是每搬一个文件都在记账那一行抛 ReferenceError：
             文件已经搬成功了，界面却报「没搬成」，还顺手造出 a.mp4 与 a-2.mp4 两份。
             位置刻意放在 fs.unlinkSync 之后 —— 字节已经落地才算搬成。 */
          bytes += buf.length;
          moved.push({ from: name, to: file });
          /* 本次刚写进去的文件要能立刻被后面同内容的请求命中 —— 与 /save-local 同一句 */
          sums.add(buf.length, hash, file);
        } catch (e) {
          /* 内部标识符不原样甩给用户：ReferenceError 是我们的错，不是他目录的错 */
          const why = (e instanceof ReferenceError)
            ? '内部错误（记账那一步出错），文件其实已经搬好了 —— 请把这份日志给作者'
            : ((e && e.code ? e.code + ' ' : '') + (e && e.message));
          failed.push({ name, why });
        }
      }
      log('[save-move] ' + kind + ' ' + srcDir + ' → ' + to + '：搬走 ' + moved.length
        + ' 个（' + (bytes / 1048576).toFixed(1) + ' MB）'
        + (dup.length ? '，那边已有同样内容、只删了源 ' + dup.length + ' 个' : '')
        + '，不是这一类 ' + skipped.length + ' 个'
        + (failed.length ? '，没搬成 ' + failed.length + ' 个' : ''));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, from: srcDir, to, moved, dup, skipped, failed, bytes }));
    });
    return;
  }
  if (dataPath === '/local-assets' && req.method === 'POST') {
    // 保存一份本地生成产物（语音 / 自动镜像的图像视频），返回可供资产库引用的 id / url
    /* 288 MiB：客户端递的是 base64（比原文件大 4/3），一段 100MB 的视频 base64 就有 133MB。
       128 MiB 那道闸是给「同步合成的音频」设的，开了产物镜像之后视频必然撞墙
       （撞墙的表现是代理回 413，而页面只显示「保存失败」，看不出是体积上限）。 */
    readBody(req, res, 288 * 1024 * 1024).then(raw => {      // base64 媒体较大，给足
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch {}
      if (!spec || !spec.data) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"缺少 data(base64)"}'); return; }
      try {
        const buf = Buffer.from(String(spec.data), 'base64');
        const fmt = String(spec.format || 'wav').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'wav';
        const mime = spec.mime || (MIME['.' + fmt] || 'application/octet-stream');
        const meta = spec.meta || {};
        // WAV 头里能直接算出时长（字节率），不用客户端再解析
        let duration = meta.duration || null;
        if (fmt === 'wav' && buf.length > 44 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WAVE') {
          try {
            const byteRate = buf.readUInt32LE(28);
            const dataSize = buf.readUInt32LE(40);
            if (byteRate > 0 && dataSize > 0) duration = Math.round((dataSize / byteRate) * 10) / 10;
          } catch {}
        }
        /* 来源外链先算出来：它是「这份产物本机有没有存过」的凭据（见 localUpKey）。 */
        const up = safeOutboundUrl(String(meta.upstream || '')) || '';
        const upKey = localUpKey(up);
        const list0 = upKey ? localIndexRead() : [];
        const twin = upKey ? list0.find(x => x && localUpKey(x.upstream) === upKey) : null;
        if (twin) {
          /* 已经有一份了：**不再落第二个文件**。客户端那份镜像键丢了（换端口 / 清浏览器数据 /
             平台这次没给产物号）不代表盘上没有 —— 这里挡住才是唯一跨源有效的一道闸。
             顺手复用它的 id：别的页面、收藏、导演台工作区里存过的 `/asset/<那个 id>` 照样能播。 */
          const fp = path.join(LOCAL_DIR, path.basename(String(twin.file || '')));
          let size = -1;
          try { size = fs.statSync(fp).size; } catch {}
          if (size !== buf.length) {
            fs.mkdirSync(LOCAL_DIR, { recursive: true });
            fs.writeFileSync(fp, buf);                     // 文件被删过 / 字节数不符：按原 id 补回来
            twin.byte_length = buf.length;
            if (twin.format !== fmt) { twin.format = fmt; twin.mime = mime; twin.file = path.basename(fp); }
          }
          const filled = localFillMissing(twin, { prompt: meta.prompt || '', model: meta.model || '',
            voice: meta.voice || '', priceText: meta.priceText || '', duration, credits: meta.credits ?? null,
            chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
            usage: meta.usage || null, detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null });
          if (filled) localIndexWrite(list0);              // 一个字段都没补上就不动盘（整表覆盖不是免费的）
          log(`[local-assets] 已有本机副本 ${twin.id}（同一份产物，第 ${list0.filter(x => localUpKey(x && x.upstream) === upKey).length} 次镜像被挡下）`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ...twin, status: 'succeeded', url: '/asset/' + twin.id, reused: true }));
          return;
        }
        const id = 'la_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const file = id + '.' + fmt;
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_DIR, file), buf);
        const item = {
          id, file, name: spec.name || file, mime,
          format: fmt, byte_length: buf.length, created_at: new Date().toISOString(),
          media_type: localMediaType(spec),
          prompt: meta.prompt || '', model: meta.model || '', voice: meta.voice || '',
          provider: meta.provider || 'local', duration,
          credits: meta.credits ?? null, priceText: meta.priceText || '',
          chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
          usage: meta.usage || null,
          /* 镜像回源用：这份文件是从哪个外链取回来的字节。
             /asset/<id> 在**本地文件被删掉**时靠它回源（见 /asset 那段），这是三级回退的中间一级 ——
             以前本地文件一没就只剩 404，界面上直接判成「已删除」，其实上游那份可能还能取。 */
          upstream: up,
          /* 任务详情原样带走：提示词、参数、费用、耗时、状态变迁。
             平台那边的记录会随时间被清理，索引里这一份是「任务当时是什么样」的本地留底。 */
          detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null,
        };
        const list = localIndexRead();
        list.unshift(item);
        localIndexWrite(list.slice(0, LOCAL_INDEX_MAX));
        log(`[local-assets] 新增 ${id}（${item.format}，${(buf.length / 1024).toFixed(0)} KB）`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...item, status: 'succeeded', url: '/asset/' + id }));
      } catch (e) {
        log('[local-assets] 保存失败：' + e.message);
        /* 索引写不成时把话说到位（L50）：字节确实已经写进 .assets 了，缺的只是索引那一行。
           不这么说的话，调用方看到 500 会当「整件事都没成」而丢掉已经存好的那份，
           或者反过来（以前）看到 200 而当「成了」—— 两种说法都和盘上的实情对不上。 */
        const msg = e && e.indexWrite
          ? ('字节已经写进本机资产库（.assets）了，但索引没写成：' + e.message
            + '。库里面现在看不到它。腾出磁盘空间后再保存一次；'
            + '索引缺失的那一条会在下次读取时按文件名自动补回来。')
          : e.message;
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg } }));
      }
    });
    return;
  }
  if (req.url.startsWith('/local-assets/') && req.method === 'DELETE') {
    // 删除本地生成资产（上游没有资产存储、文件只在本机的，比如语音合成产物）
    const id = safeDecode(req.url.slice('/local-assets/'.length).split('?')[0]);
    const list = localIndexRead();
    const hit = list.find(x => x && x.id === id);
    if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '本地资产不存在：' + id } })); return; }
    /* **文件删不掉就不许裁索引**（L49）。为什么这条最要紧：索引是这些文件唯一的查找途径 ——
       条目一没，那个 mp4 在资产库里看不见、/asset/<id> 也 404，而它明明还躺在 .assets 里，
       只是再也没人能按名字找回来（文件名是 la_xxx.mp4，人认不出来）。
       什么情况下删不掉：文件正被播放器 / 预览器打开、被同步盘（OneDrive 之类）占着、
       被杀毒软件扫着 —— 都是常见情形，不是罕见边角。
       立场与 /data 的 DELETE 完全一样（那边注释写得很清楚：删不掉必须回错误，
       否则用户看到「删了又回来」）—— 这条路由当时是同一件事的第二份实现，这边漏了。 */
    if (hit.file) {
      const f = path.join(LOCAL_DIR, path.basename(hit.file));
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); }
        catch (e) {
          log('[local-assets] 删除文件失败，索引没有动：' + e.message);
          res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: { message: '文件删不掉（' + (e.code || e.message)
            + '）：它可能正被播放器 / 同步盘 / 杀毒软件占着。这一条原样留着（资产库里还在，还能打开）——'
            + '关掉占着它的程序再删一次。' } }));
          return;
        }
      }
    }
    try { localIndexWrite(list.filter(x => x && x.id !== id)); }
    catch (e) {
      /* 文件已经删掉了，但索引没写回去：这一条会「复活」成一条指向不存在文件的记录，
         下次打开会显示成「已丢失」。如实说，别回「已删除」——那会让用户以为干净了。 */
      log('[local-assets] 文件已删、索引未更新：' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { message: '文件已经删掉了，但索引没能更新（' + e.message
        + '）：下次打开这一条会显示成「已丢失」。再删一次它就能从列表里清掉。' } }));
      return;
    }
    log(`[local-assets] 已删除 ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, id }));
    return;
  }
  if (dataPath === '/local-assets' && req.method === 'GET') {
    // 列表：形状与上游列表一致（data + next_cursor），资产库用 registry 的 list 声明直接读
    // 大类型每次现算 —— 老索引里写死过 'audio'，按扩展名重算才能把那张 PNG 认回图片
    // 时间也每次现算：索引里那份 created_at 是**落盘**时刻，一次回源能把几百条老产物写成「今天」，
    // 按它排序就把资产库里唯一的图片挤出选择器「全部」那一档的前 200 条（见 localAssetWhen）。
    /* 同一个产物的多份副本只报一份（保留索引里最靠前的那一条 = 最新的一次镜像）。
       这些重复是**镜像键丢了**那段历史留下的（POST 那一道闸已经把它挡住，不再新增），
       文件仍在盘上，只是不再当成 N 个任务摆在界面上。`duplicates` 报出还压着多少份，
       要清理由用户自己决定 —— 删文件是删用户数据，代理不擅自动手。 */
    const all = localIndexRead().map(x => ({ ...x, created_at: localAssetWhen(x), media_type: localMediaType(x), status: 'succeeded', object: 'asset' }));
    const items = [];
    const seen = new Set();
    let dups = 0;
    for (const x of all) {                               // 顺序就是索引顺序（新→旧）
      const k = localUpKey(x.upstream);
      if (k) { if (seen.has(k)) { dups++; continue; } seen.add(k); }
      items.push(x);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ object: 'list', data: items, has_more: false, next_cursor: null, duplicates: dups }));
    return;
  }

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
    readBody(req, res).then(body => {
      if (body == null) { flushInflight(w => failUpstream(w, '请求体读取失败', '上游')); return; }   // 超过上限已回 413
      const fwd = { ...req.headers };
      /* transfer-encoding 必须剥掉：下面强制带上 content-length（上游大多要求），
         两个头同时存在是非法请求，chunked 请求会直接被拒。 */
      ['cookie', 'connection', 'origin', 'referer', 'accept-encoding', 'host', 'authorization', 'content-length', 'transfer-encoding', 'x-up-base', 'x-no-cache'].forEach(h => delete fwd[h]);
      const apiKey = (req.headers.authorization || '').replace(/^Bearer\s*/, '')
        || (keyFallback ? keyOf(relayHit.keyEnv) || DEFAULTS[relayHit.keyId || relayHit.id] || relayHit.defaultKey : '') || '';
      /* 转发失败那句话的主语必须是**真打出去的那一台**，不能是「前缀排第一的那家」：
         relay 前缀可以好几家共用（九家文字 AI 里有八家的 relay 都是 /textai，上面那个 find 只按前缀
         拿到排在最前的 deepseek），页面还能用 x-up-base 把地址整个换掉。以前这里写 relayHit.id，
         界面就成了「deepseek 转发失败（打到 openrouter.ai）」—— 让人去别的一家翻密钥、翻设置。
         地址是页面递来的（baseOverridden）时不再报平台名，只报那一台主机 —— 这才是唯一确定的事实。 */
      const upHost = String(base).replace(/^https?:\/\//, '').split('/')[0];
      const relayTag = (baseOverridden ? '转发失败' : (relayHit.name || relayHit.id) + ' 转发失败')
        + '（打到 ' + upHost + '）';
      const up = upRequest(base + pathAndQuery, {
        method: req.method,
        headers: { ...fwd, authorization: 'Bearer ' + apiKey, 'content-length': body.length, 'accept-encoding': 'identity' },
        timeoutMs: isCreatePost ? 120000 : 0,
        keepAlive: true,              // relay 的目标主机来自注册表声明（见 keepAliveAgent / agentFor）
      }, ur => {
        if (isList && listTtl && ur.statusCode === 200) {
          const bufs = [];
          ur.on('data', c => bufs.push(c));
          ur.on('end', () => {
            const buf = Buffer.concat(bufs);
            if (buf.length <= 8 * 1024 * 1024) {
              cacheSweep(listCache, LIST_CACHE_MAX, LIST_CACHE_BYTES);
              listCache.set(cacheKey, { ts: Date.now(), ttl: listTtl, status: ur.statusCode, headers: { ...ur.headers }, body: buf });
            }
            res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'miss' });
            res.end(buf);
            flushInflight(w => { w.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'shared' }); w.end(buf); });
          });
          ur.on('error', e => { failUpstream(res, e.message, '列表上游中断'); flushInflight(w => failUpstream(w, e.message, '列表上游中断')); });
          return;
        }
        if (isTaskDetail) {
          const bufs = [];
          ur.on('data', c => bufs.push(c));
          ur.on('end', () => {
            const buf = Buffer.concat(bufs);
            // 只在「已完成 + 已经有产出」时缓存：状态刚变 done 但产出还没写入的那种绝不能缓存，
            // 否则页面的「补轮询取产出」会一直拿到空产出。
            try {
              const d = JSON.parse(buf.toString('utf8'));
              const st = String((d && d.status) || '');
              const hasOut = !!(d && ((Array.isArray(d.outputs) && d.outputs.length) || d.output_url || (d.output && d.output.url) || d.url || d.download_url));
              if (ur.statusCode === 200 && hasOut && /succeed|fail|cancel|done/i.test(st) && buf.length <= 2 * 1024 * 1024) {
                cacheSweep(detailCache, 300, DETAIL_CACHE_BYTES);
                detailCache.set(cacheKey, { ts: Date.now(), ttl: DETAIL_TTL, status: ur.statusCode, headers: { ...ur.headers }, body: buf });
              }
            } catch {}
            res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' });
            res.end(buf);
            flushInflight(w => { w.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' }); w.end(buf); });
          });
          ur.on('error', e => { failUpstream(res, e.message, '详情上游中断'); flushInflight(w => failUpstream(w, e.message, '详情上游中断')); });
          return;
        }
        res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' });
        pipeUpstream(ur, res, relayTag);
        /* 上游没回 200（例如列表端点 5xx）：这一支不会进缓存，等着的那些别干等，
           给一个明确的失败让它们自己重试（挂死在这里是最坏的结果）。 */
        flushInflight(w => failUpstream(w, '上游返回 ' + ur.statusCode, relayTag));
      });
      // 创建任务：回完就把列表短缓存清掉，这样刚提交的任务立刻能在资产库（列表接口）里看到
      if (isCreatePost) {
        up.on('response', ur => ur.on('end', () => { listCache.clear(); log('[cache] 创建任务 → 清空列表缓存'); }));
      }
      /* 回给页面的那句要带**真正打出去的地址**：转发失败的原因（超时 / DNS / 拒绝连接）都只说现象，
         而「是不是打到我了那个网关」恰恰是用户此刻最想确认的 —— 尤其是自定义供应商（地址是用户自己填的）、
         以及内置平台被 x-up-base 换过地址的那几种情况。（主机名与这句文案都在上面的 relayTag 里点一次名） */
      up.on('error', e => { log(`  → (${upHost}) error: ${e.message}`); failUpstream(res, e.message, relayTag); flushInflight(w => failUpstream(w, e.message, relayTag)); });
      up.end(body);
    }).catch(e => { flushInflight(w => failUpstream(w, (e && e.message) || String(e), '上游')); });
    return;
  }
  if (req.url.startsWith('/getfile?url=')) {
    // 取回通道：把外部 https 资源（如 VGENV CDN 的视频）以同源方式流给浏览器
    // 用途：把非 SparkCine 资产转存成 SparkCine 资产（参考视频 / 参考音频）
    const target = await takeOutboundUrl(req, res, '/getfile?url=', 'getfile');
    if (!target) return;
    log(`[getfile] GET ${target.slice(0, 120)}`);
    /* 跟随重定向：**每一跳都重新过完整护栏**（含 DNS 解析到内网的判定）。
       以前重定向目标只过 safeOutboundUrl（纯字面量），*.nip.io / *.sslip.io 这类
       「看着是公网域名、实际解析到 127.0.0.1」的地址借一次 302 就能进内网（SSRF）。
       限制 3 跳；上一跳的响应必须主动 resume()，否则 socket 挂在那不走。 */
    const fetchHop = (url, hops) => {
      const up = upRequest(url, {
        method: 'GET',
        headers: { 'accept': '*/*', 'accept-encoding': 'identity' },
        lookup: guardedLookup,
      }, ur => {
        log(`  → ${ur.statusCode}`);
        if (ur.statusCode >= 300 && ur.statusCode < 400 && ur.headers.location) {
          ur.resume();                                     // 丢弃这一跳的响应体
          if (hops >= 3) { failUpstream(res, '重定向次数过多（超过 3 跳）', 'getfile'); return; }
          let next = '';
          try { next = new URL(ur.headers.location, url).toString(); } catch {}
          if (!next) { failUpstream(res, '重定向目标地址无法解析', 'getfile'); return; }
          guardOutboundUrl(next).then(u2 => fetchHop(u2, hops + 1), e => failUpstream(res, e.message, 'getfile 重定向'));
          return;
        }
        /* 把上游的长度**原样透出**（不 CORS 敏感，客户端读得到就能算下载进度）——
           以前一个头都没有，于是「正在把产物存到本机」只能显示「正在存 N 份」，
           一个 200MB 的视频下到 5% 与 95% 在界面上长得一模一样，用户只能干等。
           没有长度（chunked）时客户端会看到 null，按「大小未知」显示（不假装有进度）。
           本机实测：开着 Windows 系统代理（Clash 一类，走上面的 CONNECT 隧道）时，
           jsdelivr 的响应常被中转**重新分块、丢掉 Content-Length** —— 那是隧道那一跳的事实，
           不是这段透传坏了（PROXY_OFF=1 直连同一个地址，头原样到达）。别去改这里找 bug。 */
        const len = Number(ur.headers['content-length'] || 0) || null;
        const hd = {
          'Content-Type': ur.headers['content-type'] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
        };
        if (len) hd['Content-Length'] = String(len);
        res.writeHead(ur.statusCode, hd);
        pipeUpstream(ur, res, 'getfile', len);
      });
      up.on('error', e => { log(`  → getfile error: ${e.message}`); failUpstream(res, e.message, 'getfile'); });
      up.end();
    };
    fetchHop(target, 0);
    return;
  }
  if (req.url.startsWith('/s3put?url=')) {
    // 素材上传通道：浏览器无法直传 S3（跨域），由代理携带签名头转发 PUT。
    // 请求体流式转发、进度以 NDJSON 帧回给页面（见 s3putStream）。
    const target = await takeOutboundUrl(req, res, '/s3put?url=', 's3put');
    if (!target) return;
    s3putStream(req, res, target);
    return;
  }
  if (handleRender(req, res, req.url.split('?')[0], new URL(req.url, 'http://127.0.0.1'))) return;
  if (req.url.startsWith('/asset/')) {
    // 资产通道：本地生成的资产优先（语音等同步产物），其余现场解析上游最新签名链接并流给浏览器
    const m = req.url.match(/^\/asset\/([A-Za-z0-9_-]+)(\?|$)/);
    if (!m) { res.writeHead(400); res.end('bad id'); return; }
    const q = new URL(req.url, 'http://x').searchParams;
    const localEnt = localAssetEntry(m[1]);
    const localF = localFileFromEntry(localEnt);
    if (localF) { serveLocalFile(req, res, localF, q, localEnt); return; }
    /* 本地文件没了，但索引里记着这一份是从哪个外链取回来的（自动镜像时写下的）→ 回源。
       这是「API/本地三级回退」的中间一级：没有它，本地文件一被删就只剩 404，
       界面据此判成「已删除」，而上游那份其实可能还取得到（地址过期了也能重新从列表换一份新的）。
       绕一跳 /getv 而不是直接 302 到外链：页面因此始终同源，签名地址、Range、跨域那些问题一个都不会冒出来。 */
    const up0 = safeOutboundUrl(String((localAssetEntry(m[1]) || {}).upstream || ''));
    if (up0) {
      res.writeHead(302, { 'Location': '/getv?url=' + encodeURIComponent(up0), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const key = (req.headers.authorization || '').replace(/^Bearer\s*/, '') || keyOf('SPARKCINE_API_KEY');
    assetInfoOf(m[1], key).then(info => {
      // Range 透传给 CDN：视频缩略图只取元数据、播放器可拖动进度，不再整段回源
      const upHeaders = { 'user-agent': 'local-workbench', connection: 'close' };
      if (req.headers.range) upHeaders.range = req.headers.range;
      upRequest(info.url, { headers: upHeaders }, ir => {
        /* 状态码原样透传、失败响应绝不缓存 —— 判据在 passthroughHeaders（与 /getv 同一份）。
           这一份的特别处只在：成功时用索引里记的 mime，并且同一 URL 内容恒定 → 盖一年 immutable，
           未命中才回源（失败仍然 no-store，见公共层那段注释）。 */
        const { st, h } = passthroughHeaders(ir.headers, {
          status: ir.statusCode,
          okType: info.mime || ir.headers['content-type'] || 'application/octet-stream',
          cacheOk: 'public, max-age=31536000, immutable',
          disposition: (!q.get('dl') || st >= 400) ? '' : `attachment; filename*=UTF-8''${encodeURIComponent(q.get('name') || 'image.png')}`,
        });
        res.writeHead(st, h);
        pipeUpstream(ir, res, '资产取回');
      }).on('error', e => failUpstream(res, e.message, '资产取回失败')).end();
    }).catch(e => {
      res.writeHead((e && e.status) || 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(String((e && e.message) || e));
    });
    return;
  }
  if (req.url.startsWith('/fetch?url=')) {
    // 素材下载通道：把任意 https 图片经本地代理取回，绕过浏览器跨域限制（网络瞬断自动重试 2 次）
    const target = await takeOutboundUrl(req, res, '/fetch?url=', 'fetch');
    if (!target) return;
    let attempt = 0;
    const go = () => {
      attempt++;
      const up = upRequest(target, { headers: { 'user-agent': 'local-workbench', connection: 'close' }, lookup: guardedLookup }, ur => {
        res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/octet-stream', 'cache-control': 'no-store' });
        pipeUpstream(ur, res, 'fetch');
      });
      up.on('error', e => {
        if (attempt < 3 && !res.headersSent) { log(`  fetch retry ${attempt}: ${e.message}`); setTimeout(go, 500); }
        else failUpstream(res, e.message, 'fetch');
      });
      up.end();
    };
    go();
    return;
  }
  if (req.url.startsWith('/getv?url=')) {
    // 外链媒体通道：把任意 https 资源（视频/图片）经本地代理取回，支持 Range。
    // 页面里的播放、抽帧（canvas 需要同源）、体积探测、下载都走它（见 README「统一路由（硬性约定）」），
    // 所以上游签名地址不会出现在任何 src 里。
    const target = await takeOutboundUrl(req, res, '/getv?url=', 'getv');
    if (!target) return;
    const upHeaders = { 'user-agent': 'local-workbench', connection: 'close' };
    if (req.headers.range) upHeaders.range = req.headers.range;
    const up = upRequest(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: upHeaders, lookup: guardedLookup }, ur => {
      /* 失败响应绝不缓存、Range 要原样透出、状态码不许压成 200 —— 判据在 passthroughHeaders（与 /asset 同一份）。 */
      const { st, h } = passthroughHeaders(ur.headers, {
        status: ur.statusCode,
        okType: ur.headers['content-type'] || 'video/mp4',
        cacheOk: 'public, max-age=86400',
        cors: true,
      });
      res.writeHead(st, h);
      pipeUpstream(ur, res, 'getv');
    });
    up.on('error', e => failUpstream(res, e.message, 'getv'));
    up.end();
    return;
  }
  /* 三个工作台合并成 studio.html 之后，旧路径仍然能打开（手输 /video.html、老书签、
     代理自己的探针脚本都还打这些地址）：统一落到 studio.html，类型由 studio_type / ?t= 决定。 */
  const FILE_MAP = { '/': 'shell.html', '/app.html': 'shell.html', '/shell.html': 'shell.html', '/director.html': 'director.html', '/studio.html': 'studio.html', '/image.html': 'studio.html', '/image-gen.html': 'studio.html', '/video.html': 'studio.html', '/video-gen.html': 'studio.html', '/audio.html': 'studio.html', '/audio-gen.html': 'studio.html', '/roles.html': 'favorites.html', '/favorites.html': 'favorites.html', '/assets.html': 'assets.html', '/settings.html': 'settings.html', '/usage.html': 'usage.html', '/usage': 'usage.html', '/sidebar.js': 'sidebar.js', '/app.js': 'app.js', '/assetlib.js': 'assetlib.js' };
  const urlPath = safeDecode(req.url.split('?')[0]);
  let file = FILE_MAP[urlPath];
  if (!file) {
    /* 只放行「工作台自己的前端资源」：单层普通文件名 + 允许的扩展名。
       显式挡掉点开头的文件（.env / .gitignore / .assets …）与代理源码、日志、启动脚本、
       包清单（package.json 可能带脚本与依赖信息），
       免得任意网页（CORS 是放开的）能把密钥配置和源码读走。 */
    if (!/^\/[A-Za-z0-9._-]+$/.test(urlPath) || urlPath.includes('..') || /^\/\./.test(urlPath)) {
      res.writeHead(404); res.end('not found'); return;
    }
    /* 静态服务的扩展名白名单。音频与字幕要一并放行（与 MIME 表保持一致）：
       少了它们，本地 mp3 / wav / srt 取回来是 404 —— 表现是「配乐选了却下载失败」，
       而且报错发生在代理下载素材那一步，看着像素材本身坏了。 */
    if (!/\.(html|js|css|png|jpe?g|webp|gif|svg|ico|json|mp4|webm|woff2?|mp3|wav|m4a|aac|ogg|flac|srt|vtt|ass|txt)$/i.test(urlPath)) {
      res.writeHead(404); res.end('not found'); return;
    }
    if (/^\/(proxy\.(js|log|out\.log)|package(-lock)?\.json|启动\.bat)$/i.test(urlPath)) { res.writeHead(404); res.end('not found'); return; }
    file = urlPath;
  }
  const full = path.resolve(__dirname, file.replace(/^\/+/, ''));
  if (!full.startsWith(path.resolve(__dirname) + path.sep)) { res.writeHead(404); res.end('not found'); return; }
  serveStatic(req, res, full, path.extname(file));
}

/* 把上一次的云同步结果读回来（L51）。
   以前这块只在进程内存里，重启代理就归零 —— 设置页从「3 份冲突待选择」变回「还没同步过」，
   用户以为冲突没了，按一下又跑出同样的冲突，整个过程在界面上无法解释。
   与基线写在同一个文件里（.data/.cloud-state.json），所以在这里一次性读回。 */
cloudStateLoad();
if (cloudState.lastAt) {
  log('[cloud] 上次同步结果（从盘上读回）：' + (cloudState.lastResult || '（无记录）')
    + (cloudState.conflicts.length ? '，其中 ' + cloudState.conflicts.length + ' 份冲突待选择' : ''));
}

server.listen(PORT, () => {
  const kids = REGISTRY.providers.map(p => p.keyEnv).filter((v, i, a) => v && a.indexOf(v) === i);
  const missing = kids.filter(k => !keyOf(k));
  log(`proxy 已启动: http://localhost:${PORT}（端口来自 ${PORT_FROM}${envLoaded ? '；已加载 .env，改完自动热加载' : '；未找到 .env，可用环境变量'}）`);
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
  if (renderQueue.length || renderRunning) log(`[render] 恢复队列：${renderQueue.length} 个待处理`);
}).on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`[错误] 端口 ${PORT} 已被占用：项目可能已在运行（直接访问 http://localhost:${PORT}），或先用「启动.bat」里的停止功能关闭旧进程`);
  else if (e.code === 'EACCES') {
    /* EACCES 在 Windows 上几乎总是「这个端口被系统保留段占了」，不是权限不够：
       Hyper-V / WSL2 的 winnat 开机时按 100 端口一段地划走，报出来既不是 EADDRINUSE
       也看不出原因，只有一行 permission denied。把查法与三条出路一次说清。
       还要先说清这个号是谁给的（环境变量 / .env / 默认）—— 不然窗口里残留一个
       set PORT=5175 时，人只会对着「.env 明明写了 6200 为什么还报 5175」干瞪眼。 */
    console.error([
      `[错误] 端口 ${PORT} 绑不上（EACCES）。Windows 上这通常不是权限问题，而是这个端口落在系统保留段里`,
      `       （Hyper-V / WSL2 的 winnat 开机时按段划走，一整个连续段几百个号，netstat 上看不见它们）。`,
      `  这一次用的端口来自：${PORT_FROM}`,
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
  try { server.close(); } catch {}
  try { keepAliveAgent.destroy(); } catch {}     // 复用池里的空闲 socket 也要关掉，别把进程吊在那儿
  try { if (_tunnelAgent) _tunnelAgent.destroy(); } catch {}   // 走代理时的隧道连接同理
  setTimeout(() => process.exit(code), 120);
}
process.on('SIGINT', () => { log('[退出] 收到 Ctrl+C'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
process.on('uncaughtException', e => { try { log('[致命] 未捕获异常：' + (e && e.stack || e)); } catch {} });   // 记录但不退出：本地工具，别让一次异常打断使用
process.on('unhandledRejection', e => { try { log('[警告] 未处理的 Promise 失败：' + (e && e.message || e)); } catch {} });
/* 兜底：顶层 try/catch 没接住的 http 层错误（如上游 socket 异常）不再刷屏 */
server.on('connection', s => { s.on('error', () => {}); });
