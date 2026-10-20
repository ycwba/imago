/* 供应商注册表（REGISTRY）与它的两份本机覆盖：设置页登记的「自定义接口」清单一族、
   型号清单偏好一族。2026-10-20 从 server/app.js 原样搬出（审查报告 §6.1-1）：
   这一份只有数据与形状，构造依赖、接线与 HTTP 分发都留在组合根 server/app.js。
   注册表条目的字段含义见下面「API 注册路由」那份文档注释。 */
'use strict';
const fs = require('fs');

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
                 判据只在 capabilities.js 的 topBoolState（对外是 Capabilities.fieldState）一份，页面 / 提交 / 报价三处都问它；
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
  version: 18,
  /* 「产物在本机只存资产号、要按资产号再换一次上游签名地址」的那一家是谁，只有这一处。
       provider    用哪一个内置供应商的 base / keyEnv（/asset/<id> 只问它换地址）
       retrieve    换地址的端点，`{id}` 是资产号占位
       urlFields   响应里「可下载地址」可能落在哪些点路径（按顺序取第一个命中的字符串）
       mimeField   响应里 MIME 的点路径（可空）
     以前这段地址、字段名与密钥的环境变量名写死在 server/render-jobs.js 与三条路由里（4 处 keyOf、
     1 处拼 URL），换一家跑「任务 + 资产号」的中转要改服务端代码 ——「新增供应商只改 REGISTRY」不成立。
     声明化之后这些调用点只问 resolveAssetStore（见文件末尾），页面问 /registry 拿 provider 字段即可。 */
  assetStore: {
    provider: 'sparkcine',
    retrieve: '/api/open/v1/assets/{id}',
    urlFields: ['url', 'download_url', 'asset.url', 'asset.download_url'],
    mimeField: 'mime_type',
  },
  /* 「型号清单」的响应形状：数组落在哪个字段（按顺序试，第一个是数组的就算命中；响应本身是数组也认）。
     以前这张字段表在六处各抄一份且互不相同：/custom/models 认 result、资产库的 verify 认 items、
     其余大多只认 data / models —— 接一家回 `{ result: [...] }` 的平台，设置页「获取型号列表」
     看得见、工作台却报「读不出清单」，两边说的是同一家的同一个接口。
     新增一种怪形状只在这里加一格；页面 Api.modelRows / 服务端 modelRowsOf 都照它取数。 */
  modelList: { fields: ['data', 'models', 'result', 'items'] },
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
        /* create 的 model **只收「厂牌/型号」完整形**（2026-10-12 实测）：拿空 prompt 触发校验，
           上游错误消息把合法值整串列了出来 —— base, cinematic, origin, minimax/h3, minimax/h3-human, minimax/h3-native。
           而 GET /v3/models 与报价接口返回/接受的都是简形（简形里 base 连斜杠都没有，发去 create 必回
           `model must match /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/`）；
           报价响应会把带斜杠别名回显成简形（minimax/h3→base…），两边各说一种方言。
           型号清单仍然实时从 /v3/models 现取（简形 id 是界面、历史、任务匹配的通用口径），
           **只在提交那一刻**按这张表换成 create 收的形 —— 表由 `Api.createBody` 统一消费，页面不判平台。
           简形↔别名 的对应是报价接口逐条实测出来的（回显字段），不是猜的。 */
        modelSendMap: { base: 'minimax/h3', cinematic: 'minimax/h3-human', origin: 'minimax/h3-native' },
        /* **没有 prompt 长度闸**（2026-10 用户实测后要求：VGENV 没有字数限制）。
           这里以前声明 `{ min: 5, max: 30000, byIntent: { person_replacement: … } }`，来源是
           一次实测到的上游校验串，于是导演台与 `Api.createBody` 都会在 5 字以下直接拦住
           —— 而实际上 VGENV 收短提示词没问题（「特写」「回头」这种两三个字的镜头描述是常态），
           那一栏旁边还写着「这一家 5–30000 字」，用户按它改提示词，改的其实是我们的想象。
           现在整块删掉：没有声明 = `promptLimitOf` 返回 null（界面不再画那截小字）、
           `createBody` 也不再拦。真正该拦的仍然拦着 —— 导演台那一条「先写这一镜的提示词」
           是**空的才拦**，跟「至少几个字」不是一回事。 */
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
            /* 三句话对应三种真原因（判据在 capabilities.js 的 whyNote，两处共用一份）：
               这一行确实没有 / 这一行还没认出来（素材没放齐）/ 清单还在读。
               以前只有第一句，于是「首尾帧那一档还没放图」也被说成「平台不给 Turbo」，
               而用户该做的事是把素材放上去了。 */
            needNote: '这一次的这一档（画质档 + 手上的素材种类）平台没给 Turbo —— 带参考视频的那几种组合一般不给，换个画质档或换个不带参考视频的组合再试',
            needUnknownNote: '这一档要求的素材还没放齐（或手上这一批的组合平台没列进清单），还看不出给不给 Turbo —— 先把上面写的那几类素材放进来',
            needMissingNote: '还在读平台的能力清单，读完才知道这一档给不给 Turbo',
          },
        },
        /* 「顶层的非布尔字段」这一类（v15 起，判据在 capabilities.js 顶层的 shapeFieldState 一份）：
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
      id: 'openrouter', name: 'OpenRouter 文字 AI', kind: 'text', relay: '/openrouter', default: true,
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
      id: 'deepseek', name: 'DeepSeek 文字 AI', kind: 'text', relay: '/textai',
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
      id: 'openai', name: 'OpenAI 文字 AI', kind: 'text', relay: '/textai',
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
      id: 'minimax-text', name: 'MiniMax 文字 AI', kind: 'text', relay: '/textai', keyId: 'minimax',
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

// 自定义接口与型号偏好都要读 .data 里的文件，所以这两族做成工厂：
// app 组合根把 dataStore 的 dataFileOf 与 security 的 safeOutboundUrl 注进来。
function createRegistryConfig(deps) {
  const { dataFileOf, safeOutboundUrl } = deps;

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

  return {
    CUSTOM_RELAY, customNotice, MODEL_PREFS_KEY, modelPrefsNotice,
    allProviders, customProviders, buildCustom, modelPrefs,
  };
}

/* assetStore 声明 + 它点名的那一家供应商 → 「换地址」要用的口径（base / keyEnv 只从供应商那里取一次）。
   没有声明、或点名的那一家不存在 → null（调用方按「这家没有资产接口」处理，不猜一家兜底）。 */
function resolveAssetStore(reg) {
  const d = reg && reg.assetStore;
  if (!d || !d.retrieve) return null;
  const p = (reg.providers || []).find(x => x && x.id === d.provider);
  if (!p) return null;
  return {
    provider: p.id,
    base: String(p.base || '').replace(/\/+$/, ''),
    keyEnv: p.keyEnv || '',
    retrieve: d.retrieve,
    urlFields: Array.isArray(d.urlFields) && d.urlFields.length ? d.urlFields : ['url'],
    mimeField: d.mimeField || '',
  };
}

/* 型号清单响应 → 数组（形状只认顶层 modelList.fields 那一份声明）。
   页面那份是 Api.modelRows —— 两边跑在不同的运行时（CJS / 经典脚本），无法共享一个文件，
   但字段表与判定顺序都取自同一处声明，漂不了。 */
function modelRowsOf(reg, d) {
  if (Array.isArray(d)) return d;
  const fields = (reg && reg.modelList && Array.isArray(reg.modelList.fields) && reg.modelList.fields.length)
    ? reg.modelList.fields : ['data', 'models', 'result', 'items'];
  for (const f of fields) {
    const v = d && d[f];
    if (Array.isArray(v)) return v;
  }
  return [];
}

module.exports = { REGISTRY, createRegistryConfig, resolveAssetStore, modelRowsOf };
