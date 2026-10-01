// 本地代理：node proxy.js 后访问 http://localhost:5175
// 所有生成平台都走 REGISTRY 声明的 relay 前缀转发（见下方 REGISTRY）：
// 页面只认 /registry 里的声明，不认具体厂商，所以接入新平台不用改页面。
const http = require('http');
const { request: httpsRequest } = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');

/* 端口默认 5175；PORT 环境变量可以另起一个实例（配合 DATA_DIR 用一份独立的数据目录），
   自动化验证时就不必在真实用户数据上跑。 */
const PORT = Number(process.env.PORT) || 5175;
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
/* 读取 .env 到 process.env（系统环境变量优先，不覆盖）；
   带 mtime 缓存，请求时调用 → 改完 .env 无需重启即可生效 */
function loadEnvFile(force) {
  try {
    if (!fs.existsSync(ENV_FILE)) { envLoaded = false; return false; }
    const st = fs.statSync(ENV_FILE);
    if (!force && st.mtimeMs === envMtime) return envLoaded;
    envMtime = st.mtimeMs;
    const nowKeys = [];
    let n = 0;
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
      // 系统环境变量优先；但 .env 内部改动时允许覆盖上次由 .env 写入的值
      if (!process.env[k] || process.env['__fromEnvFile_' + k]) {
        process.env[k] = v;
        process.env['__fromEnvFile_' + k] = '1';
        if (v) n++;
      }
    });
    // 从 .env 里删掉的键：清掉上次写入的值，否则旧密钥一直生效
    envKeys.filter(k => !nowKeys.includes(k)).forEach(k => {
      if (process.env['__fromEnvFile_' + k]) { delete process.env[k]; delete process.env['__fromEnvFile_' + k]; }
    });
    envKeys = nowKeys;
    envLoaded = true;
    // 启动阶段 LOG 可能还没初始化（TDZ），这里吞掉即可；热加载时会正常打印
    if (force && n) { try { log(`.env 已加载 / 更新（${n} 个变量）`); } catch {} }
    return true;
  } catch (e) { console.error('[警告] .env 读取失败：' + e.message); return false; }
}
loadEnvFile(true);

/* 密钥统一从环境变量（含 .env 热加载）读，每次现取 → 改完 .env 立即生效，不受启动时快照影响 */
const keyOf = name => (name && process.env[name]) || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.mp4': 'video/mp4', '.woff2': 'font/woff2' };
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
   模型能力：provider 声明 endpoints.models 后，客户端会调该接口拿「真实支持范围」
     （allowedValues: 分辨率/画质/比例/输出格式/时长范围/张数上限 + pricing 积分价），
     自动覆盖 registry 里写的 options（写死的只是兜底）。VGENV 目前没有该接口（404）→ 用兜底值。
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
     baseEditable 允许用 x-up-base 头临时换基址（文字 AI 的自定义接口地址）

   balance —— 余额卡片解析方式：'wallet-credits'（available/reserved 字段）| 'micros'（availableMicros 等）   */
const REGISTRY = {
  version: 1,
  providers: [
    {
      id: 'sparkcine', name: 'SparkCine 生图', displayName: 'SparkCine', kind: 'image', relay: '/sparkcine',
      base: 'https://hi.hi.run', keyEnv: 'SPARKCINE_API_KEY', site: 'https://hi.hi.run',
      // 同一个上游的列表里既有图也有视频：按媒体类型落到各自的 provider id（路由/取消/轮询用）
      mediaProviders: { '图片': 'sparkcine', '视频': 'sparkcine-video' },
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
      models: [
        /* 输出格式：平台 /models 声明了 png / jpeg / webp，但**实测不生效** ——
           提交 output_format: jpeg 后产物仍是 PNG（文件名 .png、mime_type=image/png、字节头 89 50 4E 47），
           只有一个 metadata.declaredMimeType 记着你选过 jpeg。所以这里用 forceOptions 锁成 png，
           界面上不再给「选了也没用」的格式选项（等上游真支持了，去掉 forceOptions 即可）。 */
        /* 参考图上限：与上游 /api/open/v1/models 的 image_edit 声明对齐（实测 max 8）。
           以前生图模型没写 inputRoles，能力接口不可用时界面会退到「9 张」的猜测值，
           于是「能选 9 张、提交被上游拒」—— 兜底声明必须和平台真说的数一致。
           （上游还声明了 mask:1，但提交模板里没有能带 mask 的字段，所以不声明：
             没模板的槽位给了入口也发不出去，不如不出现。） */
        { id: 'img-2-5s', name: 'IMG-2.5S', modes: ['text_to_image', 'image_edit'], price: { draft: 1, standard: 2, final: 5 }, unit: '积分/张',
          forceOptions: ['output_formats'],
          inputRoles: { reference_image: { max: 8, group: 'ref' } },
          options: { qualities: ['draft', 'standard', 'final'], aspect_ratios: ['1:1', '5:4', '4:3', '3:2', '16:9', '2:1', '21:9', '3:4', '2:3', '9:16', '1:2', '1:3'], output_formats: ['png'], max_outputs: 4 } },
        { id: 'img-2-5t', name: 'IMG-2.5T', modes: ['text_to_image', 'image_edit'], price: { draft: 1, standard: 2, final: 5 }, unit: '积分/张',
          forceOptions: ['output_formats'],
          inputRoles: { reference_image: { max: 8, group: 'ref' } },
          options: { qualities: ['draft', 'standard', 'final'], aspect_ratios: ['1:1', '5:4', '4:3', '3:2', '16:9', '2:1', '21:9', '3:4', '2:3', '9:16', '1:2', '1:3'], output_formats: ['png'], max_outputs: 4 } },
      ],
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
      pricing: { type: 'quote', currency: '¥', endpoint: 'price' },
      noPromptField: true,   // 接口不返回提示词（列表/详情/V1/流水都实测过），界面据此提示"平台不返回"
      // 注意：VGENV 的列表 / 详情 / V1 兼容接口 / 余额流水都不返回 prompt（实测过），
      // 所以提示词只能靠客户端创建任务时归档一份（assetlib 的 PromptLog → /prompts 存进归档文件夹，
      // 界面据此标注「本地记录」）；若日后上游补了该字段，只要在这条 list.map.prompt 指过去就会自动覆盖。
      endpoints: {
        create: '/v2/videos',
        poll: '/v2/videos/{id}',
        list: '/v2/videos',
        cancel: '/v2/videos/{id}',
        price: '/v2/pricing',
        credits: '/v1/credits',
        assetUpload: '/v1/assets/uploads',
        assetComplete: '/v1/assets/{id}/complete',
      },
      models: [
        {
          id: 'minimax/h3', name: 'Minimax H3',
          modes: ['text_to_video', 'first_last_frame', 'reference_images', 'reference_video', 'reference_audio'],
          /* 这个模型实际接受的输入 role 与上限（界面按它显示/禁用槽位）。
             group 表示「一次请求只能选一组」：首尾帧是一组，参考素材（图/视频/音频）是另一组
             —— 传了 first_frame/last_frame 就不能再传 reference_images（VGENV 文档明确互斥），
             界面据此把另一组置灰，而不是等提交时才报错。 */
          inputRoles: {
            first_frame: { max: 1, group: 'frame' },
            last_frame: { max: 1, group: 'frame' },
            reference_image: { max: 9, group: 'ref' },
            /* accept / maxBytes 是「这个槽位原样收什么样的文件」：界面文案、统一选择器的本地上传档位、
               上传前的体积校验都读它，不要在页面里写死「MP4 ≤ 200MB」。
               首尾帧不声明 accept：那一槽是「选视频就地取帧」（见 video-gen.html 的 SLOT_DEF.videoFrame），
               交给平台的永远是图片，按槽位声明会把这个功能拦掉。 */
            reference_video: { max: 1, group: 'ref', accept: 'video/mp4', maxBytes: 200 * 1024 * 1024 },
            reference_audio: { max: 1, group: 'ref', accept: 'audio/mpeg,audio/wav', maxBytes: 50 * 1024 * 1024 },
          },
          options: {
            tiers: ['fast', 'standard', 'enhanced', 'quality'],
            resolutions: ['480p', '768p'],
            durations: [4, 15],
            aspect_ratios: ['9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9', '21:9'],
            // VGENV 没有能力接口，上面这些是兜底；默认值也由我们定（否则会落到列表第一项）
            defaults: { duration: 5, resolution: '768p', aspect_ratio: '16:9' },
          },
        },
      ],
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
        idempotencyKey: false,    // 平台没声明支持幂等键 → 不带、也不自动重试（避免重复建任务重复扣费）
        body: { model: 'model', prompt: 'prompt', tier: 'tier', duration: 'duration', resolution: 'res', aspect_ratio: 'ar' },
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
        // 上传接口的字段命名（VGENV 用驼峰，SparkCine 是下划线）
        uploadFields: { fileName: 'fileName', contentType: 'contentType', sizeBytes: 'sizeBytes' },
      },
      balance: { style: 'micros' },
    },
    {
      id: 'sparkcine-video', name: 'SparkCine 视频', displayName: 'SparkCine', kind: 'video', relay: '/sparkcine', keyId: 'sparkcine',
      base: 'https://hi.hi.run', keyEnv: 'SPARKCINE_API_KEY', site: 'https://hi.hi.run',
      pricing: { type: 'per_second_table', currency: '积分', endpoint: 'models' },
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
      /* 兜底声明：与上游 /api/open/v1/models 的实测结果对齐（接口不可用时用它，
         避免界面少给选项 —— 例如漏掉 960p/1080p、漏掉参考音频、漏掉「生成音频」开关）。
         上游给了能力接口时以接口为准。 */
      models: [
        { id: 'h3-video', name: 'H3 视频（SparkCine）',
          modes: ['text_to_video', 'image_to_video', 'multimodal_reference'],
          /* 这个模型收哪些参考素材：以平台 /models 的声明为准（它只声明了
             image_to_video / multimodal_reference 两个输入 role：reference_image 与 reference_audio），
             所以界面上只会出现「参考图 / 参考音频」两个入口 —— 首尾帧、参考视频在这个模型上不显示
             （平台没声明 → 不赌它支持，免得用户传完才在上游报错）。
             这里只补上限与分组：参考音频平台写着 max 3，但提交模板是单个 {asset_id} 对象，所以按 1。
             这份声明同时也是能力接口不可用时的兜底。 */
          inputRoles: {
            reference_image: { max: 9, group: 'ref' },
            reference_audio: { max: 1, group: 'ref' },
          },
          options: {
            resolutions: ['480p', '768p', '960p', '1080p'],
            aspect_ratios: ['16:9', '9:16'],
            durations: [4, 15],
            // 默认值：上游声明 duration=6 / resolution=768p / aspect_ratio=16:9 / generate_audio=true
            defaults: { duration: 6, resolution: '768p', aspect_ratio: '16:9', generate_audio: true },
            bools: { generate_audio: { def: true } },
          } },
      ],
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
        constants: { optimize_prompt: false },
        note: '视频工作台',
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
           · tts.audioParam 音频参数对象名（请求体里放 format/voice 的对象）
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
      // 想显示预估费用：给模型加 price: { per1kChars: 0.2 }（配合 pricing.type='per_1k_chars'）；
      // 不声明就显示「平台未提供价格」，页面不会自己编价格。
      // ttsMode 声明「这个模型怎么定音色」，工作台据此显示/校验对应输入：
      //   preset = 从预设音色下拉选；design = 必填风格/音色描述；clone = 必须上传参考音频
      models: [
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
        audioParam: 'audio',
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
        },
        statusMap: { succeeded: 'done' },
        selfAsset: true,            // 列表条目本身就是资产（本地落盘产物）
        media: { fixed: '音乐' },
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
      id: 'deepseek', name: 'DeepSeek 文字AI', kind: 'text', relay: '/textai',
      base: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', baseEditable: true,
      site: 'https://platform.deepseek.com',
      endpoints: { chat: '/chat/completions' },
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', modes: ['text'] },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', modes: ['text'] },
      ],
    },
  ],
};

/* ---------- 注册表规范化：接入新平台时省事，别让同一种能力有两种写法 ----------
   1) 素材上传端点统一成 uploads / complete：老平台写成 assetUpload / assetComplete 也认，
      客户端（AssetTransfer）只认一套名字，声明了就能用。
   2) kind 缺省时按 relay 推断（同 relay 的平台共用一条上游）。 */
(function normalizeRegistry() {
  const UPLOAD_ALIAS = { uploads: 'assetUpload', upload_intent: 'assetUpload', complete: 'assetComplete' };
  REGISTRY.providers.forEach(p => {
    p.endpoints = p.endpoints || {};
    Object.entries(UPLOAD_ALIAS).forEach(([std, legacy]) => {
      if (!p.endpoints[std] && p.endpoints[legacy]) p.endpoints[std] = p.endpoints[legacy];
    });
  });
})();

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
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}
/* 统一的出站请求：自动带超时（超时即 destroy 并回调 error），避免上游挂起时无人收场 */
function upRequest(url, opts, cb) {
  /* 空闲超时可按请求覆盖（opts.timeoutMs）：创建任务这类"平台要在服务端排队、迟迟不回"的接口
     需要更长的耐心 —— 60 秒就掐断的后果是「任务其实建好了，页面却看到失败」，
     用户再点一次就成了两条重复任务（20:31 那条 VGENV 任务就是这么来的）。 */
  const o = { ...(opts || {}) };
  const idle = Number(o.timeoutMs) || UP_TIMEOUT;
  delete o.timeoutMs;
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
  const mod = /^http:\/\//i.test(url) ? http.request : httpsRequest;
  const r = mod(url, opts, cb);
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
/* IPv6 字面量：只挡回环 / 未指定 / 唯一本地（fc00::/7）/ 链路本地（fe80::/10）与 IPv4 映射，
   其余放行 —— 双栈主机的 AAAA 记录是公网地址，一刀切拒绝会把正常域名也挡掉。 */
function isPrivateIpv6(h) {
  const s = String(h || '').toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;                       // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;                       // fe80::/10 链路本地
  const v4 = ipv4FromMapped(s);                                        // IPv4 映射地址 → 按 v4 判
  if (v4) return isPrivateHost(v4);
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

/* 出站响应流 → 客户端：上游中途断开（RST / 空闲超时）时不能只让 pipe 抛错 ——
   以前几处 pipe 没有 error 监听：上游一断，代理这边刷未捕获异常，客户端拿到一个永远不结束的响应。
   统一入口：响应还没发头 → 502 + 可读原因；已经发过头 → 直接断开连接。 */
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
function log(line) {
  const out = `[${new Date().toISOString().slice(11, 19)}] ` + String(line);
  console.log(out);
  try {
    fs.appendFileSync(LOG, out + '\n');
    if (++logLines % 200 === 0) rotateLog();   // 运行中轮转，不再只靠启动那一次
  } catch {}
}

/* ---------- ffmpeg 离线渲染服务 ----------
   POST /render          提交 EDL（clips: src/in/out/speed/volume）→ 返回 { id }
   GET  /render/status   查询进度 { state, progress, stage, out, err, log }
   GET  /render/dl       下载成片 ?name=xxx
   GET  /render/list     列出已渲染成片
   流程：下载每段素材 → 逐段标准化（尺寸/帧率/编码一致）→ concat 拼接 → 输出 mp4
   src 支持：/asset/<id>（用密钥解析最新签名链接）｜ http(s):// ｜ /local-path（经本机 http 取回） */
const { spawn } = require('child_process');
const RENDER_DIR = path.join(__dirname, '.renders');

/* ---------- 本地生成资产库 ----------
   有些平台的产物是「同步返回」的二进制（例如语音合成直接给 base64 音频），上游没有资产 id。
   这里把这类产物落到本地目录，并对外提供与上游一致的形状：
     POST /local-assets      { name, mime, format, data(base64), meta:{prompt,model,voice,duration,provider,credits,priceText} }
                             → { id, url:'/asset/<id>', ... }
     GET  /local-assets      列表（资产库/任务列表直接用 registry 的 list 声明读它）
     GET  /asset/<id>        本地优先：命中本地文件就本地读取（支持 Range），否则回源上游
   这样「语音工作台」生成的音频能像其它资产一样出现在资产库、被资产选择器挑选与复用。 */
const LOCAL_DIR = path.join(__dirname, '.assets');
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
  }
}
function localAssetEntry(id) { return localIndexRead().find(x => x && x.id === id) || null; }
function localAssetFile(id) {
  const it = localAssetEntry(id);
  if (!it || !it.file) return null;
  const f = path.join(LOCAL_DIR, path.basename(it.file));
  return fs.existsSync(f) ? f : null;
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
function serveLocalFile(req, res, file, q) {
  const base = path.basename(file);
  const entry = localIndexRead().find(x => x && x.file === base) || {};
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
    const p = spawn('ffmpeg', args, { windowsHide: true });
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
function cacheSweep(cache, max) {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (!v || !v.ttl || now - v.ts > v.ttl) cache.delete(k);
  }
  while (cache.size > max) cache.delete(cache.keys().next().value);
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
  const m = /^\/asset\/([A-Za-z0-9-]+)/.exec(s);
  if (m) {
    const key = reqKey || keyOf('SPARKCINE_API_KEY');
    const info = await assetInfoOf(m[1], key);
    return info.url;
  }
  // 相对路径：当作本机代理的静态资源（便于测试与本地素材）
  return `http://127.0.0.1:${PORT}${s.startsWith('/') ? s : '/' + s}`;
}
/* 单片渲染素材的下载上限（默认 2 GiB）：作用不是「限制正常素材」，而是防止超大 / 恶意地址把进程打爆 */
const DOWNLOAD_MAX = 2 * 1024 * 1024 * 1024;
/* 流式下载到文件：以前整段 arrayBuffer() 进内存，一个超大素材就能把代理进程吃掉几百 MB 到几 GB */
async function downloadTo(url, dest) {
  const r = await fetch(url);
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

async function renderJob(job) {
  const dir = path.join(RENDER_DIR, job.id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { job.state = 'failed'; job.err = '无法创建渲染目录：' + e.message; return; }
  const jid = job.id;                    // 本任务的子进程都挂到这个号上（取消时按号杀，见 killJobProcs）
  const { clips, width, height, fps, crf, bgm } = job.spec;
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
      if (String(c.src) === 'black') {   // 黑场：不下载，用 lavfi 生成
        files.push({ ...c, file: null, black: true, size: 0 });
        job.log.push(`[${i + 1}/${clips.length}] 黑场 ${((Number(c.out) - Number(c.in)) || 1).toFixed(1)}s`);
        continue;
      }
      const url = await resolveSrc(c.src, job.key);
      const ext = (/\.([a-z0-9]{3,4})(\?|$)/i.exec(url) || [])[1] || 'mp4';
      const dest = path.join(dir, `src_${i}.${ext}`);
      const size = await downloadTo(url, dest);
      files.push({ ...c, file: dest, size });
      job.progress = 2 + Math.round(((i + 1) / clips.length) * 33);
      job.log.push(`[${i + 1}/${clips.length}] 已下载 ${(size / 1048576).toFixed(2)} MB`);
    }
    // 音频策略：所有片段都有音轨才保留，否则整片静音（避免 concat 混流失败）
    let keepAudio = true;
    for (const f of files) { if (f.black || !(await hasAudioStream(f.file, jid))) { keepAudio = false; break; } }
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
      if (f.black) {
        const d = Math.max(0.1, (Number(f.out) || 1) - (Number(f.in) || 0));
        await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${d}:r=${fps}`, '-vf', vfBase, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-an', out], null, jid);
        parts.push(out);
        job.progress = 35 + Math.round(((i + 1) / files.length) * 45);
        job.log.push(`[${i + 1}/${files.length}] 黑场已生成 ${fmtTime(d)}`);
        continue;
      }
      const dur = await ffprobeDuration(f.file, jid);
      let inP = Math.max(0, Number(f.in) || 0);
      let outP = f.out != null && Number(f.out) > inP ? Number(f.out) : dur;
      if (dur && outP > dur + 0.05) outP = dur;
      const span = Math.max(0.1, outP - inP);
      const speed = Math.min(4, Math.max(0.25, Number(f.speed) || 1));
      const vf = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `fps=${fps}`,
        speed !== 1 ? `setpts=PTS/${speed}` : null,
        'format=yuv420p',
      ].filter(Boolean).join(',');
      const args = ['-y', '-ss', String(inP), '-t', String(span), '-i', f.file, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf)];
      if (keepAudio) {
        const vol = Math.min(4, Math.max(0, f.volume == null ? 1 : Number(f.volume)));
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
    const concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy'];
    if (bgm) {
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
  if (req.url.startsWith('/render/delete')) {
    // 删除成片（.renders 下的文件 + 任务记录）
    const name = path.basename(urlObj.searchParams.get('name') || '');
    const f = path.join(RENDER_DIR, name);
    if (!name || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"成片不存在"}'); return true; }
    rmrf(f);
    for (const [id, job] of renders) { if (job.out === name) { renders.delete(id); break; } }
    log('[render] 已删除成片 ' + name);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, name }));
    return true;
  }
  if (req.url.startsWith('/render/list')) {
    const items = fs.existsSync(RENDER_DIR) ? fs.readdirSync(RENDER_DIR).filter(f => f.endsWith('.mp4')).map(f => {
      const st = fs.statSync(path.join(RENDER_DIR, f));
      return { name: f, size: st.size, ts: st.mtimeMs };
    }).sort((a, b) => b.ts - a.ts) : [];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ dir: RENDER_DIR, items }));
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
          clips: spec.clips,
          width: Math.max(64, Math.min(4096, parseInt(spec.width) || 1280)),
          height: Math.max(64, Math.min(4096, parseInt(spec.height) || 720)),
          fps: Math.max(12, Math.min(60, parseInt(spec.fps) || 30)),
          crf: Math.max(14, Math.min(32, parseInt(spec.crf) || 20)),
          bgm: spec.bgm || null,
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
  if (/\.bak$/.test(key)) return;                     // 备份本身不再备份（云同步已自己留过一份）
  const cur = dataFileOf(key), bak = dataFileOf(key + '.bak');
  let old;
  try { if (!fs.existsSync(cur)) return; old = fs.readFileSync(cur); } catch { return; }
  if (nextBuf && nextBuf.equals(old)) return;         // 写的内容和本机这份一模一样 → 没什么可备份的
  try {
    if (fs.existsSync(bak)) {
      if (Date.now() - fs.statSync(bak).mtimeMs < BAK_KEEP_MS) return;   // 刚留过，那份更旧也更值钱
      if (fs.readFileSync(bak).equals(old)) return;                      // 内容没变，不用重复留
    }
    fs.writeFileSync(bak, old);
  } catch (e) { log('[data] 备份旧内容失败 ' + key + '：' + e.message); }
}
function dataWriteRaw(key, buf) {
  const dir = dataDirPath();
  fs.mkdirSync(dir, { recursive: true });
  keepDataBackup(key, buf);
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
   只写 `(\/|$)` 会让它们漏掉拦截（踩过一次）。 */
const LOCAL_ONLY = /^\/(?:data|cloud|capabilities|prompts|local-assets|env-status|clear-cache|render|media|s3put|getv|getfile|fetch)(?:[/?]|$)/;
/* relay 转发前缀（/sparkcine、/vgenv、/textai…）与 /asset/ 同样只服务本工作台页面。
   以前它们不在同源检查里：代理在客户端没带 Authorization 时会**自动注入 .env 里的密钥**，
   于是任意恶意网页只要 fetch('http://localhost:5175/sparkcine/...') 就能用你的密钥建任务、扣费、读余额
   —— 和之前 .env 能被直接下载是同一类问题。新接入平台时不用改这里：前缀从 registry 现取。 */
const RELAY_PREFIXES = REGISTRY.providers
  .map(p => String(p.relay || ''))
  .filter(r => r.startsWith('/') && r !== '/');
function isWorkbenchOnlyUrl(raw) {
  if (LOCAL_ONLY.test(raw)) return true;
  const pathname = String(raw || '').split('?')[0];
  if (pathname === '/asset' || pathname.startsWith('/asset/')) return true;
  return RELAY_PREFIXES.some(r => pathname === r || pathname.startsWith(r + '/'));
}
/* 会改状态的路由只接受 POST（GET 一律 405）。
   以前 /cloud/sync、/render/cancel、/render/delete 连 GET 都执行：
   浏览器里 <img src="http://localhost:5175/cloud/sync"> 这种「不带 Origin 的 GET」
   既能躲过旧的 Origin 检查，又能真的触发同步 / 杀进程 / 删成片。
   同源检查是第一道，方法检查是第二道 —— 网页要发 POST 就必然带 Origin 与 Sec-Fetch-*，躲不掉。
   页面侧（设置页）本来就是用 POST 调这些命令的，所以这里只是补上约束。 */
const POST_ONLY = /^\/(?:cloud\/(?:sync|push|pull|test|resolve|restore)|render\/(?:cancel|delete)|prompts\/open|clear-cache)$/;
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
  return path.resolve(p);
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
    const hit = id ? promptRows(dir).find(r => r.i && r.i === id && (!prov || !r.p || r.p === prov)) : null;
    if (!hit) { json(404, { error: { message: '这个任务没有归档提示词' } }); return true; }
    let prompt = '';
    try {
      const text = fs.readFileSync(path.join(dir, hit.f), 'utf8');
      const i = text.indexOf('## 提示词');
      if (i >= 0) prompt = text.slice(i + '## 提示词'.length).trim();
    } catch {}
    json(200, { ok: true, file: hit.f, path: path.join(dir, hit.f), title: hit.t, type: hit.k, prompt });
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
function parseDavList(xml) {
  const out = new Map();
  const blocks = String(xml).match(/<[a-zA-Z0-9]*:?response[\s>][\s\S]*?<\/[a-zA-Z0-9]*:?response>/g) || [];
  for (const b of blocks) {
    if (/<[a-zA-Z0-9]*:?collection\s*\/?>/.test(b)) continue;                 // 目录本身跳过
    const href = (/<[a-zA-Z0-9]*:?href>([\s\S]*?)<\/[a-zA-Z0-9]*:?href>/.exec(b) || [])[1] || '';
    const name = decodeURIComponent(href.trim().replace(/\/+$/, '').split('/').pop() || '');
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -5);
    if (!DATA_KEY_RE.test(key)) continue;
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
/* 读某个数据文件里的写入时间（ts）：判「谁更新」只认它，不认文件 mtime */
/* 从一份数据内容里取写入时间 ts（裸数组/字符串那种老格式没有 ts → 0） */
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

async function handleCapabilities(req, res, urlObj) {
  const want = String(urlObj.searchParams.get('provider') || '');
  const noCache = urlObj.searchParams.get('noCache') === '1';
  const prov = REGISTRY.providers.find(p => p.id === want || (p.keyId || p.id) === want);
  if (!prov) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '找不到平台：' + want + '（检查 registry 里的 id）' } }));
    return true;
  }
  const registryModels = (prov.models || []).map(m => ({
    id: m.id, name: m.name, modes: m.modes, options: m.options, price: m.price,
  }));
  const endpoint = (prov.endpoints && prov.endpoints.models) || null;
  const base = { provider: prov.id, name: prov.name, displayName: prov.displayName || prov.name, endpoint, registryModels };

  const cacheKey = prov.base + '|' + endpoint;
  if (endpoint && !noCache) {
    const hit = capCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CAP_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...hit.payload, cached: true }));
      return true;
    }
  }
  const reply = payload => {
    if (endpoint) capCache.set(cacheKey, { ts: Date.now(), payload });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return true;
  };
  if (!endpoint) return reply({ ...base, source: 'registry', models: {}, note: '该平台没有声明能力接口（registry 里补 endpoints.models 即可）' });

  const apiKey = (req.headers.authorization || '').replace(/^Bearer\s*/, '')
    || keyOf(prov.keyEnv) || DEFAULTS[prov.keyId || prov.id] || '';
  try {
    const r = await new Promise((resolve, reject) => {
      const up = upRequest(prov.base + endpoint, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json', 'accept-encoding': 'identity' },
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
      return reply({ ...base, source: 'registry', models: {}, note: '上游能力接口返回 ' + r.status + '（按平台声明兜底）' });
    }
    const j = JSON.parse(r.body.toString('utf8'));
    const list = j.data || j.models || (Array.isArray(j) ? j : []);
    const models = {};
    list.forEach(m => { if (m && m.id) models[m.id] = m; });
    if (!Object.keys(models).length) {
      return reply({ ...base, source: 'registry', models: {}, note: '上游能力接口没有返回模型列表（按平台声明兜底）' });
    }
    return reply({ ...base, source: 'api', models, fetchedAt: Date.now(), note: '' });
  } catch (e) {
    return reply({ ...base, source: 'registry', models: {}, note: '上游能力接口请求失败：' + e.message + '（按平台声明兜底）' });
  }
}

const cloudState = { lastAt: 0, lastResult: '' };

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
function cloudBaselineRead() {
  try { const v = JSON.parse(fs.readFileSync(CLOUD_STATE_FILE(), 'utf8')); return (v && v.keys) || {}; } catch { return {}; }
}
function cloudBaselineWrite(keys) {
  try { fs.mkdirSync(dataDirPath(), { recursive: true }); fs.writeFileSync(CLOUD_STATE_FILE(), JSON.stringify({ ts: Date.now(), keys })); }
  catch (e) { log('[cloud] 基线写入失败：' + e.message); }
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
  if (req.url === '/data' && req.method === 'GET') {
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
      try {
        if (fs.existsSync(f)) { keepDataBackup(key); fs.unlinkSync(f); }   // 删掉的那份也留个找回的路
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
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        dir: dataDirPath(), files: dataList().length,
        envConfigured: hasEnv, lastAt: cloudState.lastAt, lastResult: cloudState.lastResult,
        conflicts: cloudState.conflicts || [], lastUp: cloudState.lastUp || 0, lastDown: cloudState.lastDown || 0,
        unread: cloudState.unread || [],
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
          if (cmd === 'test') {
            await cloudEnsureDir(cfg);
            const list = await cloudList(cfg);
            cloudState.lastAt = Date.now();
            cloudState.lastResult = '连接正常（云端已有 ' + list.size + ' 份数据）';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, remoteCount: list.size, message: cloudState.lastResult }));
            return;
          }
          /* 密钥默认不进云端：sk_key_* 是各处平台的 API 密钥，传到第三方网盘属于额外风险。
             设置页勾选「同步密钥」后会带 x-cloud-keys: 1，那时才参与上传/下载。 */
          const withKeys = String(req.headers['x-cloud-keys'] || '') === '1';
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
          cloudState.lastAt = Date.now();
          cloudState.conflicts = conflicts;       // 状态接口据此让设置页显示「待选择」清单
          cloudState.lastUp = nUp; cloudState.lastDown = nDown;
          const parts = [];
          if (nUp) parts.push('已上传 ' + nUp + ' 份');
          if (nDown) parts.push('已下载 ' + nDown + ' 份');
          if (nDel) parts.push('已删除云端 ' + nDel + ' 份（本机删掉的，云端同步删除；覆盖前留了 .bak）');
          if (skipDel.length) parts.push(skipDel.length + ' 份本机已删除但本次是「只下载」，没动云端');
          if (same) parts.push(same + ' 份一致');
          if (conflicts.length) parts.push('**' + conflicts.length + ' 份冲突待选择**');
          if (unread.length) parts.push(unread.length + ' 份读不下来（已跳过，未覆盖云端）');
          if (failed.length) parts.push('**' + failed.length + ' 份处理失败**');
          cloudState.lastResult = parts.join('，') || '没有需要同步的数据';
          cloudState.unread = unread;
          log('[cloud] ' + cloudState.lastResult + (details.length ? '：' + details.join(' ') : '')
            + (unread.length ? '；读不下来：' + unread.join(' ') : '')
            + (failed.length ? '；失败：' + failed.join(' ') : ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: nUp + nDown, up: nUp, down: nDown, del: nDel, same, details,
            conflicts, autoPicked, averted, backups, unread, failed, skipDel, message: cloudState.lastResult }));
        } catch (e) {
          cloudState.lastResult = '失败：' + e.message;
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
  if (req.url === '/prompts' || req.url.startsWith('/prompts/') || req.url.startsWith('/prompts?')) {
    handlePrompts(req, res, new URL(req.url, 'http://127.0.0.1'));
    return;
  }
  if (handleData(req, res, new URL(req.url, 'http://127.0.0.1'))) return;
  if (req.url === '/env-status') {
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
  if (req.url === '/clear-cache' && req.method === 'POST') {
    const n = { list: listCache.size, detail: detailCache.size, assetUrl: assetUrlCache.size, cap: capCache.size };
    listCache.clear(); detailCache.clear(); assetUrlCache.clear(); capCache.clear();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, cleared: n }));
    return;
  }
  if (req.url === '/registry') {
    // 供客户端按能力过滤模型
    const body = JSON.stringify(REGISTRY);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
    return;
  }
  if (req.url === '/local-assets' && req.method === 'POST') {
    // 保存一份本地生成产物（语音等），返回可供资产库引用的 id / url
    readBody(req, res, 128 * 1024 * 1024).then(raw => {      // base64 音频较大，给 128 MiB
      if (raw == null) return;
      let spec = null;
      try { spec = JSON.parse(raw.toString('utf8')); } catch {}
      if (!spec || !spec.data) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"缺少 data(base64)"}'); return; }
      try {
        const buf = Buffer.from(String(spec.data), 'base64');
        const fmt = String(spec.format || 'wav').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'wav';
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
        const id = 'la_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const file = id + '.' + fmt;
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_DIR, file), buf);
        const item = {
          id, file, name: spec.name || file, mime: spec.mime || ('audio/' + fmt),
          format: fmt, byte_length: buf.length, created_at: new Date().toISOString(),
          media_type: spec.media_type || 'audio',
          prompt: meta.prompt || '', model: meta.model || '', voice: meta.voice || '',
          provider: meta.provider || 'local', duration,
          credits: meta.credits ?? null, priceText: meta.priceText || '',
          chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
          usage: meta.usage || null,
        };
        const list = localIndexRead();
        list.unshift(item);
        localIndexWrite(list.slice(0, 500));
        log(`[local-assets] 新增 ${id}（${item.format}，${(buf.length / 1024).toFixed(0)} KB）`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...item, status: 'succeeded', url: '/asset/' + id }));
      } catch (e) {
        log('[local-assets] 保存失败：' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } }));
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
    try {
      if (hit.file) { const f = path.join(LOCAL_DIR, path.basename(hit.file)); if (fs.existsSync(f)) fs.unlinkSync(f); }
    } catch (e) { log('[local-assets] 删除文件失败：' + e.message); }
    localIndexWrite(list.filter(x => x && x.id !== id));
    log(`[local-assets] 已删除 ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, id }));
    return;
  }
  if (req.url.startsWith('/local-assets') && req.method === 'GET') {
    // 列表：形状与上游列表一致（data + next_cursor），资产库用 registry 的 list 声明直接读
    const items = localIndexRead().map(x => ({ ...x, status: 'succeeded', object: 'asset' }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ object: 'list', data: items, has_more: false, next_cursor: null }));
    return;
  }

  /* ---------- 通用转发：所有 provider 的 relay 前缀都走这里 ----------
     /<relay>/<path> → <base><path>
       · 密钥：优先取客户端 Authorization，其次读 keyEnv 声明的环境变量，最后用 defaultKey（如声明了）
       · baseEditable 的平台允许用 x-up-base 头临时换基址（文字 AI 的自定义接口地址）
     新接入一个平台（含语音合成）只要在 REGISTRY 里加一条：relay/base/keyEnv/endpoints，转发自动生效。 */
  /* 列表接口的短 TTL 缓存：/generations、/v2/videos 这类列表接口上游很慢（SparkCine 6~14s），
     资产库 / 图片台 / 视频台 / 导演台会重复请求同一份数据。
     只缓存 GET 列表请求，TTL 由 registry 的 list.cacheTtl 声明；客户端带 x-no-cache 头可强制回源。 */
  const relayHit = REGISTRY.providers.find(p => p.relay && p.relay !== '/' && req.url.startsWith(p.relay + '/'));
  if (relayHit) {
    let base = relayHit.base;
    const upBase = req.headers['x-up-base'];
    if (relayHit.baseEditable && upBase && /^https:\/\//.test(upBase)) base = upBase;
    const pathAndQuery = req.url.slice(relayHit.relay.length);
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
      const hit = detailCache.get(req.url);
      if (hit && Date.now() - hit.ts < (hit.ttl || DETAIL_TTL)) {
        res.writeHead(hit.status, { ...hit.headers, 'Cache-Control': 'no-store', 'X-Detail-Cache': 'hit' });
        res.end(hit.body);
        return;
      }
    }
    if (isList && listTtl && !req.headers['x-no-cache']) {
      const hit = listCache.get(req.url);
      if (hit && Date.now() - hit.ts < (hit.ttl || listTtl)) {
        res.writeHead(hit.status, { ...hit.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'hit' });
        res.end(hit.body);
        return;
      }
    }
    readBody(req, res).then(body => {
      if (body == null) return;                    // 超过上限已回 413
      const fwd = { ...req.headers };
      /* transfer-encoding 必须剥掉：下面强制带上 content-length（上游大多要求），
         两个头同时存在是非法请求，chunked 请求会直接被拒。 */
      ['cookie', 'connection', 'origin', 'referer', 'accept-encoding', 'host', 'authorization', 'content-length', 'transfer-encoding', 'x-up-base', 'x-no-cache'].forEach(h => delete fwd[h]);
      const apiKey = (req.headers.authorization || '').replace(/^Bearer\s*/, '')
        || keyOf(relayHit.keyEnv) || DEFAULTS[relayHit.keyId || relayHit.id] || relayHit.defaultKey || '';
      const up = upRequest(base + pathAndQuery, {
        method: req.method,
        headers: { ...fwd, authorization: 'Bearer ' + apiKey, 'content-length': body.length, 'accept-encoding': 'identity' },
        timeoutMs: isCreatePost ? 120000 : 0,
      }, ur => {
        if (isList && listTtl && ur.statusCode === 200) {
          const bufs = [];
          ur.on('data', c => bufs.push(c));
          ur.on('end', () => {
            const buf = Buffer.concat(bufs);
            if (buf.length <= 8 * 1024 * 1024) {
              cacheSweep(listCache, LIST_CACHE_MAX);
              listCache.set(req.url, { ts: Date.now(), ttl: listTtl, status: ur.statusCode, headers: { ...ur.headers }, body: buf });
            }
            res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store', 'X-List-Cache': 'miss' });
            res.end(buf);
          });
          ur.on('error', e => failUpstream(res, e.message, '列表上游中断'));
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
                cacheSweep(detailCache, 300);
                detailCache.set(req.url, { ts: Date.now(), ttl: DETAIL_TTL, status: ur.statusCode, headers: { ...ur.headers }, body: buf });
              }
            } catch {}
            res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' });
            res.end(buf);
          });
          ur.on('error', e => failUpstream(res, e.message, '详情上游中断'));
          return;
        }
        res.writeHead(ur.statusCode, { ...ur.headers, 'Cache-Control': 'no-store' });
        pipeUpstream(ur, res, relayHit.id);
      });
      // 创建任务：回完就把列表短缓存清掉，这样刚提交的任务立刻能在资产库（列表接口）里看到
      if (isCreatePost) {
        up.on('response', ur => ur.on('end', () => { listCache.clear(); log('[cache] 创建任务 → 清空列表缓存'); }));
      }
      up.on('error', e => { log(`  → ${relayHit.id} error: ${e.message}`); failUpstream(res, e.message, relayHit.id + ' 转发失败'); });
      up.end(body);
    });
    return;
  }
  if (req.url.startsWith('/getfile?url=')) {
    // 取回通道：把外部 https 资源（如 VGENV CDN 的视频）以同源方式流给浏览器
    // 用途：把非 SparkCine 资产转存成 SparkCine 资产（参考视频 / 参考音频）
    let target;
    try { target = await guardOutboundUrl(safeDecode(req.url.slice('/getfile?url='.length))); }
    catch (e) { log('[getfile] 拒绝出站：' + e.message); res.writeHead(400); res.end('bad url: ' + e.message); return; }
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
        res.writeHead(ur.statusCode, {
          'Content-Type': ur.headers['content-type'] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
        });
        pipeUpstream(ur, res, 'getfile');
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
    let target;
    try { target = await guardOutboundUrl(safeDecode(req.url.slice('/s3put?url='.length))); }
    catch (e) { log('[s3put] 拒绝出站：' + e.message); res.writeHead(400); res.end('bad url: ' + e.message); return; }
    s3putStream(req, res, target);
    return;
  }
  if (handleRender(req, res, req.url.split('?')[0], new URL(req.url, 'http://127.0.0.1'))) return;
  if (req.url.startsWith('/asset/')) {
    // 资产通道：本地生成的资产优先（语音等同步产物），其余现场解析上游最新签名链接并流给浏览器
    const m = req.url.match(/^\/asset\/([A-Za-z0-9_-]+)(\?|$)/);
    if (!m) { res.writeHead(400); res.end('bad id'); return; }
    const q = new URL(req.url, 'http://x').searchParams;
    const localF = localAssetFile(m[1]);
    if (localF) { serveLocalFile(req, res, localF, q); return; }
    const key = (req.headers.authorization || '').replace(/^Bearer\s*/, '') || keyOf('SPARKCINE_API_KEY');
    assetInfoOf(m[1], key).then(info => {
      // Range 透传给 CDN：视频缩略图只取元数据、播放器可拖动进度，不再整段回源
      const upHeaders = { 'user-agent': 'local-workbench', connection: 'close' };
      if (req.headers.range) upHeaders.range = req.headers.range;
      upRequest(info.url, { headers: upHeaders }, ir => {
        /* 状态码要原样透传：以前只分「206 或 200」，签名过期(403)/资产已删(404) 的错误页
           会被当成一张图发回 200，还盖上 immutable 一年的缓存 —— 页面显示破图、
           之后每次刷新都命中那条缓存，怎么都修不好。 */
        const st = ir.statusCode >= 200 ? ir.statusCode : 502;
        const bad = st >= 400;
        const h = {
          'content-type': bad ? (ir.headers['content-type'] || 'text/plain; charset=utf-8')
            : (info.mime || ir.headers['content-type'] || 'application/octet-stream'),
          // 同一 URL 内容恒定：浏览器正常缓存即可，未命中时才回源（失败响应不缓存）
          'Cache-Control': bad ? 'no-store' : 'public, max-age=31536000, immutable',
          'Accept-Ranges': 'bytes',
        };
        if (ir.headers['content-range']) h['Content-Range'] = ir.headers['content-range'];
        if (ir.headers['content-length'] && !bad) h['Content-Length'] = ir.headers['content-length'];
        if (!bad && q.get('dl')) h['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(q.get('name') || 'image.png')}`;
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
    let target;
    try { target = await guardOutboundUrl(safeDecode(req.url.slice('/fetch?url='.length))); }
    catch (e) { log('[fetch] 拒绝出站：' + e.message); res.writeHead(400); res.end('bad url: ' + e.message); return; }
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
    let target;
    try { target = await guardOutboundUrl(safeDecode(req.url.slice('/getv?url='.length))); }
    catch (e) { log('[getv] 拒绝出站：' + e.message); res.writeHead(400); res.end('bad url: ' + e.message); return; }
    const upHeaders = { 'user-agent': 'local-workbench', connection: 'close' };
    if (req.headers.range) upHeaders.range = req.headers.range;
    const up = upRequest(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: upHeaders, lookup: guardedLookup }, ur => {
      const h = {
        'content-type': ur.headers['content-type'] || 'video/mp4',
        'accept-ranges': ur.headers['accept-ranges'] || 'bytes',
        'cache-control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      };
      if (ur.headers['content-range']) h['Content-Range'] = ur.headers['content-range'];
      if (ur.headers['content-length']) h['Content-Length'] = ur.headers['content-length'];
      res.writeHead(ur.statusCode, h);
      pipeUpstream(ur, res, 'getv');
    });
    up.on('error', e => failUpstream(res, e.message, 'getv'));
    up.end();
    return;
  }
  const FILE_MAP = { '/': 'shell.html', '/app.html': 'shell.html', '/shell.html': 'shell.html', '/index.html': 'index.html', '/director.html': 'director.html', '/image.html': 'image-gen.html', '/image-gen.html': 'image-gen.html', '/video.html': 'video-gen.html', '/video-gen.html': 'video-gen.html', '/audio.html': 'audio-gen.html', '/audio-gen.html': 'audio-gen.html', '/roles.html': 'favorites.html', '/favorites.html': 'favorites.html', '/assets.html': 'assets.html', '/settings.html': 'settings.html', '/usage.html': 'usage.html', '/usage': 'usage.html', '/sidebar.js': 'sidebar.js', '/app.js': 'app.js', '/assetlib.js': 'assetlib.js' };
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
    if (!/\.(html|js|css|png|jpe?g|webp|gif|svg|ico|json|mp4|woff2?)$/i.test(urlPath)) {
      res.writeHead(404); res.end('not found'); return;
    }
    if (/^\/(proxy\.(js|log|out\.log)|package(-lock)?\.json|启动\.bat)$/i.test(urlPath)) { res.writeHead(404); res.end('not found'); return; }
    file = urlPath;
  }
  const full = path.resolve(__dirname, file.replace(/^\/+/, ''));
  if (!full.startsWith(path.resolve(__dirname) + path.sep)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

server.listen(PORT, () => {
  const kids = REGISTRY.providers.map(p => p.keyEnv).filter((v, i, a) => v && a.indexOf(v) === i);
  const missing = kids.filter(k => !keyOf(k));
  log(`proxy 已启动: http://localhost:${PORT}${envLoaded ? '（已加载 .env，改完自动热加载）' : '（未找到 .env，可用环境变量）'}`);
  if (missing.length) {
    log(`[提示] 以下平台还没配密钥，对应工作台会报「未配置密钥」：${missing.join('、')}。`);
    log('       填法：项目目录的 .env（KEY=VALUE 一行一个，改完自动生效），或页面「设置」里填写。');
  }
  if (renderQueue.length || renderRunning) log(`[render] 恢复队列：${renderQueue.length} 个待处理`);
}).on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`[错误] 端口 ${PORT} 已被占用：项目可能已在运行（直接访问 http://localhost:${PORT}），或先用「启动.bat」里的停止功能关闭旧进程`);
  else console.error('[错误] 启动失败：' + e.message);
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
  setTimeout(() => process.exit(code), 120);
}
process.on('SIGINT', () => { log('[退出] 收到 Ctrl+C'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
process.on('uncaughtException', e => { try { log('[致命] 未捕获异常：' + (e && e.stack || e)); } catch {} });   // 记录但不退出：本地工具，别让一次异常打断使用
process.on('unhandledRejection', e => { try { log('[警告] 未处理的 Promise 失败：' + (e && e.message || e)); } catch {} });
/* 兜底：顶层 try/catch 没接住的 http 层错误（如上游 socket 异常）不再刷屏 */
server.on('connection', s => { s.on('error', () => {}); });
