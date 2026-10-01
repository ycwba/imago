# AGENTS.md —— 在本项目里干活前先读这几条

本项目是一个**本地优先的 AI 创作工作台**：纯前端页面 + 一个本地 Node 代理（`proxy.js`，默认 `http://localhost:5175`），
所有生成平台都通过代理转发。页面：导演台 `index.html`、视频台 `video-gen.html`、图片台 `image-gen.html`、
语音台 `audio-gen.html`、资产库 `assets.html`、收藏 `favorites.html`、设置 `settings.html`、用量 `usage.html`；
公共模块：`ui.js`（Net / Toast / Store / DataSync / Dropdowns / Confirm…）、`assetlib.js`（Api / AssetLib / Capabilities /
AssetTransfer / TextAI / PromptLog）、`workbench.js`（Wb：任务状态 / 轮询器 / 灯箱 / 历史 / 大文件）、`sidebar.js`、`app.js`。
详细说明看 `README.md`，本文件只列**必须遵守的约定**。

## 1. 统一路由：页面不直连任何外部域名（硬性）

页面（`*.html` 的内联脚本 + 公共 `*.js`）里的**每一个**外部请求都只能打到本地代理的同源相对路径
（`/registry`、`/capabilities`、`/<relay>/*`、`/getv?url=`、`/fetch?url=`、`/getfile?url=`、`/s3put?url=`、
`/asset/<id>`、`/local-assets`、`/render*`、`/data`、`/prompts`、`/cloud` …）。端点、密钥、转发、字节取回全在代理里。
返回的是上游签名外链也要先过 `Api.mediaSrc(url)` 换成 `/getv?url=` 再进 `src` / `<img>` / `<video>` / `fetch()`。

- 调平台接口：`Api.request(prov, 'create'|'poll'|'list'|'cancel'|'credits'|…)`、`Api.create(prov, fields)`、`Api.createBody(prov, …)`。
- 自己拼 URL 只用 `prov.relay + prov.endpoints.*`；**不要用 `prov.base`**（上游原始地址，只给代理）。
- 取字节上传 / 转存：`AssetTransfer.blobOf()` / `toAsset()` / `crossTransfer()`（内部走 `/getfile`、`/s3put`）。
  上传进度：`/s3put` 返回 NDJSON 进度帧（`start`/`progress`/`done`/`error`），`AssetTransfer` 解析后经 `onStage('progress')`
  回调给页面；页面用 `ui.js` 的 `uploadStageText()` 生成文案（不要自己拼百分比文案，也别用 XHR 量本机回环那一段）。
- 新增平台：**只改 `proxy.js` 的 `REGISTRY.providers`**（relay / base / keyEnv / endpoints / models / create /
  inputRoles / inputTemplates / uploadFields），页面不改。
- 允许的「非外部」地址：同源相对路径、`data:`、`blob:`；设置页里的地址预设与官网链接只给人看，不参与取数。

改完自查（`②` 必须为空）：

```bash
grep -rn "https\?://" *.html *.js | grep -v "^proxy.js:" | grep -v "data:image" | grep -v "localhost:5175"
grep -rn "src *= *[^;]*https\?://" *.html *.js
```

完整路由表、原因与判定标准见 `README.md` 的「统一路由（硬性约定）」。

**同源保护覆盖到 relay 与 `/asset/`（硬性）**：除了上面那串本地路由，**relay 前缀（`/sparkcine`、`/vgenv`、`/mimo`、`/textai`…）
与 `/asset/<id>` 也只接受同源请求**（跨站 403）。代理在请求没带 `Authorization` 时会自动注入 `.env` 里的密钥，
relay 不设防 = 任意网页都能用你的密钥建任务、扣费、读余额。
新增平台**不要改这里**：前缀从 `REGISTRY.providers[].relay` 现取（`proxy.js` 的 `RELAY_PREFIXES` + `isWorkbenchOnlyUrl`）；
云同步命令必须精确写成 `/cloud/<命令>`（别再用 `replace('/cloud','')` 那套，`/cloudsync` 这类撞名路径会绕过同源检查）。

## 2. 能力驱动，不写死

模型支持什么（输入 role、参数取值、上限、默认值、布尔开关、输出格式）一律来自能力声明：
`Capabilities.specs(model)` / `modelsFor()` / `blockedRoles()` / `illegalPairs()` / `unsupportedRoles()` / `inputTemplate()`。
平台自己的 `/models` 声明优先，registry 兜底（并可用 `forceOptions` 覆盖「平台声明与实测不符」的字段）。
界面要跟着能力**显隐 / 禁用 / 预禁用按钮**（缺必填、素材互斥、模型不支持都要当场拦住并写明原因），不要等提交才报错。

- **数量/上限/默认值禁止写死**：张数上限 `max_outputs`、参考图上限（`reference_image.max`）、
  参数默认值（`options.defaults`）都从能力声明现算（图片台见 `modelLimits()` / `autoVals` 那一段），
  能力接口一刷新界面就跟着变；掉下来的默认值只在「用户没手动改过」时生效。
- **平台的接口怪癖也要声明化，不要在页面里 if (prov.id === 'xxx')**：
  详情端点不可用 → `pollVia:'list'`；取消用别的 HTTP 方法 → `cancelMethod`；接口不返回提示词 → `noPromptField`。
  页面只用 `Api.pollTask` / `Api.cancel` / `PromptLog` 这些统一入口。
- **哪些平台支持幂等键由 registry 声明**：`create.idempotencyKey`（默认 true）。SparkCine 必须 true（不带会 400）；
  VGENV / MiMo 是 false。**没有幂等键的 POST 一律不自动重试**（见 `ui.js` 的 `Net.fetch`）——
  否则「请求已到、响应超时」时重试会重复建任务、重复扣费。新平台若支持幂等去重，显式写 `idempotencyKey: true`。

## 3. 复用公共模块，别各写一套

**跨闭包调用只走 window 上的公开接口。** 踩过一次：`mediaSrc()` 定义在 `assetlib.js` 的 Api 闭包里，
而 `normalize()`（AssetLib 闭包）和 `Fav` 里都是**裸调用**它 —— 一执行就抛 `ReferenceError`，
被 `Promise.allSettled` 静默吞掉，表现是「VGENV 的任务在所有页面都不出现、收藏也坏掉」，很难查。
所以：闭包内定义的函数只在闭包内用；要给别的闭包/页面用就挂到 `window`（`Api.xxx` / `Wb.xxx` / `ui.js` 的全局函数）。
`mediaSrc` 现在定义在模块作用域，`Api.mediaSrc` 仍是对外入口。

同一个功能只应有一份实现：下拉用 `ui.js` 的 `Dropdowns`（支持 `<optgroup>` 分组），网络用 `Net`，
任务轮询用 `Wb.poller`，历史用 `Wb.History`，媒体一律 `Api.mediaSrc`，跨平台素材用 `AssetTransfer`，
**动作胶囊按钮用 `ui.css` 的 `.btn-row` + `.tool`（`.tool.acc` = 主操作、`.tool.danger` + `.sp` = 顶到行尾的破坏性动作），
「AI 挑了哪些」这类条件芯片用 `.ai-chip`，侧栏余额显示哪几个接口用 `ui.js` 的 `SbBal`（键 `sb_bal_show`，只在设置页勾）**，
**视频缩略图用 `Wb.thumbs`，任务卡片「详情」面板用 `Wb.detail`，右栏卡片列表用 `Wb.cards`，
分页/动态加载用 `Wb.pager`，灯箱预览用 `Wb.lightbox`，「保存/另存为」落点用 `Wb.saver`**
（都在 `workbench.js`，配套样式在 `ui.css` 的 `.det-*` / `.tph` / `#lbStage`；
页面只提供适配器，别再各写一份 renderDetail / fmtDetail / 卡片列表 / 灯箱 / ensureDir）。
发现重复实现（例如页面里自己写的下拉/灯箱/上传/详情/缩略图/分页/保存落点）→ 收敛到公共模块，别复制。
**灯箱的 DOM 也由 `Wb.lightbox` 创建**（页面别再手写 `#lightbox` 标记，老标记它会在 `_mount()` 里自动补齐/清理）。
**三个工作台（图片 / 视频 / 语音）的两栏布局只在 `ui.css` 的「工作台共用布局」里定义一份**（`<body class="wb2">`）：
轨道宽、滚动条宽与 `scrollbar-gutter`、断点都在那里。页面 `<style>` 里只留页面专属规则（textarea / 素材 / 按钮行等），
**不要**再抄一份 `.layout` / `.col-left` / `.col-right` / `::-webkit-scrollbar` —— 之前各抄一份的结果是切换三页右栏
宽度差 8~16px、滚动条出现/消失引起整栏重排。卡片里可能撑宽的文本（`.task .tprompt` / `.meta2`）要带 `overflow-wrap: anywhere`，
否则 grid item 的 `min-width:auto` 会把 `minmax(0,1fr)` 顶穿。

## 4. 密钥与用户数据

- **源码里绝不出现真实密钥**：`proxy.js` 不带默认 key，只从 `.env` / 系统环境变量 / 设置页取。
- `.env`、`.data/`、`prompts/`、`.assets/`、`.renders/` 都在 `.gitignore` 里，**不要提交**，也不要把里面内容贴到日志或回复里。
- 用户的工作区、历史、归档是用户数据：清理前先确认是测试残留，别擅自删。
- **自动化 / headless 验证一律跑隔离实例，不要在 5175 上写**：`PORT=5199 DATA_DIR=.data-probe node proxy.js` 起一份独立代理，
  测试脚本的 `BASE` 默认指向它。原因：浏览器侧每一次 `localStorage.setItem` 都会镜像成 `PUT /data/<key>`（last-writer-wins），
  而启动对账 `DataSync.boot()` 是异步的 —— 在全新上下文里跑真实实例，很容易把**加载前读到的旧快照**盖回用户数据上
  （2026-10-01 就是这样把收藏库从约 400 条写成 2 条，无法恢复）。
  只读检查（加载页面看有没有报错）可以在 5175 跑，但跑前先 `sha1sum .data/*.json`、跑后再比一次，确认没变动。
- **代理侧覆盖 / 删除 `.data/<key>` 之前会留一份 `<key>.bak.json`**（`proxy.js` 的 `keepDataBackup`，最少保留 10 分钟，
  内容相同不留，`.bak` 自身不再备份）。它不出现在 `GET /data` 清单里，但设置页「数据与备份」能列出来也能一键还原
  （走 `GET /cloud/backups` + `POST /cloud/restore`，**不需要配置云**）。不要把 `*.bak.json` 加进同步或清单逻辑。
- **只服务本工作台页面的路由集中在 `proxy.js` 的 `LOCAL_ONLY`**（`/data`、`/prompts`、`/cloud`、`/capabilities`、
  `/local-assets`、`/env-status`、`/render*`，以及取回/转发类 `/getv`、`/fetch`、`/getfile`、`/s3put`）：
  跨站请求在 CORS 放行**之前**就被 403 拦掉，新增敏感路由记得加进这个正则。
  正则结尾的分隔符要同时认 `/`、`?` 和串尾（这几条路由都带查询串，只写 `(\/|$)` 会漏拦）。
- 代理会把浏览器递来的 URL 取回/写穿（`/getv`、`/fetch`、`/getfile`、`/s3put`）：一律过 `guardOutboundUrl()` ——
  只允许公网 https，回环/内网/链路本地/域名解析到内网的写法（nip.io 之类）全部拒绝，别绕过它。

## 5. 改完必须自测

```bash
# 语法：proxy.js 与公共 js
node -e "new (require('vm').Script)(require('fs').readFileSync('proxy.js','utf8'))"
# 页面内联脚本（必须用 vm.Script：new Function 抓不到严格模式/全局作用域错误）
node -e "const fs=require('fs'),vm=require('vm'),re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
for (const f of ['index.html','video-gen.html','image-gen.html','audio-gen.html','assets.html','favorites.html','settings.html','usage.html','shell.html']) {
  const h=fs.readFileSync(f,'utf8'); let m,i=0;
  while ((m=re.exec(h))) { i++; new vm.Script(m[1],{filename:f+'#'+i}); }
  console.log('OK',f,i+' 段');}"
```

- 改的是 `proxy.js`（不是 `.env`）→ **必须重启代理**才生效（`启动.bat` → 2 停止 → 1 启动；或 kill 占用 5175 的进程后 `node proxy.js`）。
- 改完至少把八个页面各加载一次，确认没有错误横幅、没有控制台报错、关键列表/下拉有内容。
- 涉及创建任务的改动：真实跑一次最小的（图片 draft 1 张 / 语音短文本），别只靠干跑；上游报错时看清是哪个字段。

## 6. 已知的平台事实（省得重复踩）

- **VGENV**：列表/详情都不返回 `prompt`（提示词靠本机归档 `PromptLog` → `prompts/`）；素材上传用 camelCase
  （`fileName`/`contentType`/`sizeBytes`）且**拒绝未知字段**（多发一个 `sha256` 就 400）；参考素材必须是
  `{asset_id}`（参考图是 `[{type:'image_url',image_url:{url}}]`），首尾帧走 `frame_images` 带 `frame_type`。
- **SparkCine**：上传用下划线字段且 **`sha256` 必填**；`output_format` 声明了 png/jpeg/webp 但**实测只出 PNG**（已锁 png）；
  列表 `output_asset_ids`、详情 `outputs[].asset_id`；创建接口**要求 `Idempotency-Key` 请求头**，不带直接验证失败
  （registry 里已按 `create.idempotencyKey: true` 声明）。
- **首帧槽位可以直接选视频**：视频工作台的「首帧图」既收图片也收视频 —— 选视频时在**浏览器内**取它的**最后一帧**
  当首帧（`video-gen.html` 的 `grabVideoFrame()` / `frameItemFromVideoFile()`，用于「把已有视频接着往下生成」）。
  只对声明了 `videoFrame` 的槽位生效（`SLOT_DEF`），要加别的槽位照抄这条。
- **VGENV 详情端点 /v2/videos/{id} 是 404 空壳**（只回 statusCode/code/message）→ registry 里声明 `pollVia:'list'`，
  单条状态靠列表接口按 id 找（`Api.pollTask`）。列表返回完整对象（含 `output.url`），列表才是状态的最终依据。
- 「任务显示成两个、其中一个是假的」这类问题的三个成因（都已修，别再引入）：
  ① 跨闭包裸调用抛 `ReferenceError` 被 allSettled 吞掉 → 数据整源失踪；
  ② 轮询端点坏了 + 404 被当成「任务已被清理」→ 本地任务被清掉任务号，于是和列表里的真任务并存；
  ③ 首屏缓存把「生成中/排队中」也持久化了 → 下次打开显示成永远不动的旧状态。
- **页面取数只走统一层**：注册表用 `Api.registry()`（带 60 秒缓存，别再各页裸 `fetch('/registry')`），
  字节取回用 `Net.blob / Net.fetch`（带超时与可读错误，别再裸 `fetch('/asset/…')`），
  平台接口用 `Api.request`。长任务（`/render`、云同步）用 `Net.fetch(..., { timeout: 0, retry: 0 })`
  —— 关掉超时、不自动重试，别让统一层把它们掐断。
- **任务卡片一律来自平台接口（语音除外）**：图片台 / 视频台**不再建本地任务卡**，本地也不留任务记录
  （`video_tasks` 已废弃，`Wb.History` 的 `video` 规格与 DataSync 的同步键都删了）。
  提交流程是：`create` 拿到任务号 → `adoptTask()` 立刻按任务号从接口取回那条任务、插进列表
  （取不回来就整表刷新，列表接口才是状态的最终依据）；之后由统一轮询器刷新状态。
  所以「创建中/排队中」的占位卡、孤儿认领、本地↔服务端校正这些机制都不该再出现 ——
  卡片上的任务号一定来自平台，本地记录不参与渲染。**语音台是例外**：MiMo 是同步合成、上游没有任务号，
  本地记录就是它的唯一凭据（保留 `audio_tasks`）。
- **创建后的「取回/核对」不要挡住按钮**：平台列表接口动辄 6~14 秒，`adoptTask()` 与「结果未知 → 核对列表」
  都必须放后台跑（只提示「正在取回/核对」），按钮的禁用窗口只覆盖 create 本身。
  唯一的例外保护：结果未知时置 `pendingUncertain`，这期间再点生成先弹确认（防止把可能已成功的提交又提交一遍），
  核对结束自动清除。
- **平台的提示词编译失败可安全重试**：VGENV 创建时会跑一步 `prompt_optimization`，子服务偶发失败返回
  `PROMPT_COMPILER_UPSTREAM_ERROR` —— 这表示**任务没创建、没扣费**，重试安全（不像超时/断连那样可能已受理）。
  统一用 `Api.isRetryableCreateError(e)` 判断（页面自动重试一次，别各写正则）。
- 提示词归档：`POST /prompts` 写文件、`GET /prompts` 列清单 + 索引、`GET /prompts/find?provider=&id=` 取全文；
  目录在设置页可改（`prompt_dir`，只存本机）。
- **缩略图缓存键必须归一化**：VGENV 的视频在页面上是 `/getv?url=<OSS 签名地址>`，而 `Expires`/`Signature`
  每次刷新都会变 —— 用整条 URL 当缓存键等于「永远命不中、每次都重新加载视频元数据」。
  `Wb.thumbs.keyOf` 因此只取内层地址的 host + path（path 里带 asset/job id）。以后接入平台时，
  只要产物地址带易变的签名/参数，都要先归一化再当键（缓存、去重、比对一律如此）。
- 云同步：`POST /cloud/sync`（一键双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
  冲突判定靠 `.data/.cloud-state.json` 基线（点开头 = 内部状态，不参与 dataList/上传/下载）。
  改同步逻辑时**不要退回"只看时间取新"**：那会在两边都改过时静默丢一边。
  两条底线：① 远端**存在但读不下来**（GET 失败）判 `error` 并跳过，绝不 push（否则本地旧数据覆盖云端较新版本，无提示、云端无 .bak）；
  ② 本地 `removeItem` 的删除请求必须真正执行到底（`DataSync.queue` 存 body=null、`flush` 走 `delData`），否则服务器那份还在、下次 boot 又拉回来。
- 浏览器侧对账（`ui.js` 的 `DataSync.boot`）：体积相同**不能直接跳过** —— 等长修改（grid→list、等长密钥/模型名）
  体积一模一样，只比体积的话另一台机器的更新永远拉不回来；体积相同但服务器更新时仍要取回逐字节比对。
  对账期间（`booting = true`）本地写入**先进 `held` 暂存表、不立刻镜像到 `.data/`**，`finally` 里 `releaseHeld()` 补发；
  `flushKeepalive()` 发送前也要比对 `localStorage` 当前值，值已经变了就不发（`changed → location.reload()` 那条路径上，
  排队内容很可能是对账拉回之前的旧内容）。改这三处任一一个，都要用 `bootgate.cjs` 在隔离实例上重跑一次。
  **已知残留限制**：纯数组值（`fav_items` 这类）没有 ts 信封，`Store.tsOf()` 返回 0，`boot()` 判不出「本地更新」，
  所以它只能靠上面两道闸门挡误写，不能证明顺序正确 —— 别再往「只看 mtime 取新」的方向退化。
