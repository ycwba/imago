# AGENTS.md —— 在本项目里干活前先读这几条

本项目是一个**本地优先的 AI 创作工作台**：纯前端页面 + 一个本地 Node 代理（`proxy.js`，默认 `http://localhost:5175`），
所有生成平台都通过代理转发。页面：导演台 `index.html`、**生成工作台 `studio.html`（视频 / 图像 / 语音三合一，2026-10 合并；旧
`video-gen.html` / `image-gen.html` / `audio-gen.html` 已删除，`/video.html` 之类的旧短名与 `?t=video|image|audio` 别名仍能打开）**、
拍短剧 `drama.html`、素材库 `chars.html`、资产库 `assets.html`、收藏 `favorites.html`、设置 `settings.html`、用量 `usage.html`；
公共模块：`ui.js`（Net / Toast / Store / DataSync / Dropdowns / Confirm…）、`assetlib.js`（Api / AssetLib / Capabilities /
AssetTransfer / TextAI / PromptLog）、`workbench.js`（Wb：任务状态 / 轮询器 / 灯箱 / 历史 / 大文件）、`sidebar.js`、`app.js`、
`ai-chat.js`（AiChat：外壳层那一份 AI 助手 —— 可拖动悬浮球 + 右侧抽屉，只读查询本机数据与平台能力，写入动作只在用户点「执行」的确认卡片后才做）。
详细说明看 `README.md`，本文件只列**必须遵守的约定**。

## 1. 统一路由：页面不直连任何外部域名（硬性）

页面（`*.html` 的内联脚本 + 公共 `*.js`）里的**每一个**外部请求都只能打到本地代理的同源相对路径
（`/registry`、`/capabilities`、`/<relay>/*`、`/getv?url=`、`/fetch?url=`、`/getfile?url=`、`/s3put?url=`、
`/asset/<id>`、`/local-assets`、`/save`、`/pick-dir`、`/render*`、`/data`、`/prompts`、`/cloud` …）。端点、密钥、转发、字节取回全在代理里。
返回的是上游签名外链也要先过 `Api.mediaSrc(url)` 换成 `/getv?url=` 再进 `src` / `<img>` / `<video>` / `fetch()`。

- 调平台接口：`Api.request(prov, 'create'|'poll'|'list'|'cancel'|'credits'|…)`、`Api.create(prov, fields)`、`Api.createBody(prov, …)`。
- 自己拼 URL 只用 `prov.relay + prov.endpoints.*`；**不要用 `prov.base`**（上游原始地址，只给代理）。
- 取字节上传 / 转存：`AssetTransfer.blobOf()` / `toAsset()` / `crossTransfer()`（内部走 `/getfile`、`/s3put`）。
  上传进度：`/s3put` 返回 NDJSON 进度帧（`start`/`progress`/`done`/`error`），`AssetTransfer` 解析后经 `onStage('progress')`
  回调给页面；页面用 `ui.js` 的 `uploadStageText()` 生成文案（不要自己拼百分比文案，也别用 XHR 量本机回环那一段）。
- 新增平台：**只改 `proxy.js` 的 `REGISTRY.providers`**（relay / base / keyEnv / endpoints / models / create /
  inputRoles / inputTemplates / uploadFields），页面不改。端点名只有一套（`uploads` / `complete`），
  没有「老写法也认」的归一层；改了注册表结构就把 `REGISTRY.version` +1（页面靠它点名旧代理）。
- **用户自己的中转 / 网关不改代码**：设置页「添加自定义供应商」按类型（图片 / 视频 / 语音 / 文字）填表单，
  条目存 `sk_custom`（镜像 `.data/sk_custom.json`），代理 `buildCustom` **整条克隆模板**（只摘掉身份、地址、密钥来源、
  价格与「内置才有」的那批字段，名单在 `CUSTOM_STRIP` 一处点名），relay 是 `/custom/<id>`，密钥 `sk_key_<id>`，
  **不设家数上限**（v11 起）。
  所以能力、上传、端点全都自动继承 —— 页面与代理都不用为新加的一家改任何东西。
  **内置那几家也要先添加一次才进「供应商与密钥」那张卡**（v11 起；选它、地址自动填好、贴把密钥就行），
  所以「用一家内置平台的官方地址去添加它自己」是**正常路径**，不再被拦；表单与 `customProblem` 只拦
  「拿 A 家的官方地址配 B 家的接口形状」这一种必然失败的组合。
  自定义条目**没有环境密钥可回退**，也**不认 `x-up-base`**（`baseEditable` 被摘掉）—— 这是「别把 A 的密钥发到 B」的另一半。
- **设置页「供应商与密钥」只有一张卡、四个类型档（`image / video / audio / text`，`PROV_KINDS`）**：
  选中一档就**列出该类的全部供应商**（`renderProv()`，按 `keyId` 归并 —— 一家平台同时做图片与视频时
  共用一把 `sk_key_<keyId>`，只出现一张卡，不会两个输入框互相盖值），**不再有「选供应商」下拉那一行**。
  文字 AI 的**供应方、密钥、接口地址、型号、识图开关全在「文字」这一档里，一家一张卡**
  （`textBlock(m)` 画的是卡下面那半段：型号下拉 + 自己填型号 + 识图；
  另有一张独立的「文字 AI 模型与识图」卡 —— **2026-10 已删**，两处管同一家供应方必然对不上：
  在 A 卡改了地址、型号却在 B 卡上选，界面看着都对，发出去是错的）。
  文字档每张卡多一个单选框 `data-tpick`（「作用文字 AI」），落盘键仍是 `sk_text_prov`；
  **「接口地址」输入框按 `prov.baseEditable` 声明渲染，不按 kind 写死**（自定义条目该字段被代理摘掉，所以不显示）。
  型号块是**先画骨架、后填内容**：`renderProv()` 末尾只调一次 `window.__textForm.paint()`
  （取型号列表要等 `TextAI` 就绪，闭包是脚本末尾才装配好的）—— 别在 `renderProv` 里裸调闭包里的函数。
  卡里的按钮与两个下拉**一次绑定在 `#provList` 上**（委托，`renderProv` 只换 `innerHTML`，监听器不会丢）。
  **识图开关（`sk_text_vision`）是全局一项**，所以只画在当前「作用文字 AI」的那张卡上；
  每张都画一份就成了三个开关改同一个键。`saveAll` 按 `[data-tmodel]` **逐家**存 `sk_model_<keyId>`
  （不按「当前那一家」筛 —— 顺手给别家挑好的默认型号也是有效配置）。
  余额不再按类型过滤：注册表里声明了 `credits` 端点就能勾「侧栏余额」，语音 / 文字一律不靠类型写死；
  **反过来也成立 —— 没有 `credits` 端点的那张卡照样画勾选框**，只是压暗（`.krow .sbshow.dim`）并在 title 里
  写明「这家平台没有提供余额查询接口，勾了也不会显示余额」（见下面「文字 AI 是多家供应方」那段的余额小节）。
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
  参数默认值（`options.defaults`）都从能力声明现算（生成工作台的图像栏见 `modelLimits()` / `autoVals` 那一段），
  能力接口一刷新界面就跟着变；掉下来的默认值只在「用户没手动改过」时生效。
- **下拉里的选项也不许在 HTML 里写死**（不只是上限）：生成工作台「格式」那一列以前静态写着
  png/jpeg/webp 三项，能力接口没回来时看到的是一份「假能力表」，被 `forceOptions` 锁成 png 时又整块消失 ——
  两种都让人以为「格式是写死的」。现在选项清空 + 整块默认隐藏，全部由 `renderImageParams()` / `fillSel()` 现算，
  并在 hint 里写明这一列来自上游 `/models` 还是本项目的兜底声明（`Capabilities.sourceOf`）。
- **平台的接口怪癖也要声明化，不要在页面里 if (prov.id === 'xxx')**：
  详情端点不可用 → `pollVia:'list'`；取消用别的 HTTP 方法 → `cancelMethod`；接口不返回提示词 → `noPromptField`。
  页面只用 `Api.pollTask` / `Api.cancel` / `PromptLog` 这些统一入口。
- **哪些平台支持幂等键由 registry 声明**：`create.idempotencyKey`（默认 true）。SparkCine 必须 true（不带会 400）；
  VGENV / MiMo 是 false。**没有幂等键的 POST 一律不自动重试**（见 `ui.js` 的 `Net.fetch`）——
  否则「请求已到、响应超时」时重试会重复建任务、重复扣费。新平台若支持幂等去重，显式写 `idempotencyKey: true`。
- **提交体顶层的布尔开关声明成 `create.topBools`**（不进 `parameters`）：`{ 字段名: {label, hint, def} }`。
  页面只为声明了这一项的平台渲染那个开关，平台没有就不出现；值随 `params` 一起提交，
  `Api.createBody` 按这份声明把它放回顶层（混进 `parameters` 平台会拒）。

## 3. 复用公共模块，别各写一套

**跨闭包调用只走 window 上的公开接口。** 踩过一次：`mediaSrc()` 定义在 `assetlib.js` 的 Api 闭包里，
而 `normalize()`（AssetLib 闭包）和 `Fav` 里都是**裸调用**它 —— 一执行就抛 `ReferenceError`，
被 `Promise.allSettled` 静默吞掉，表现是「VGENV 的任务在所有页面都不出现、收藏也坏掉」，很难查。
所以：闭包内定义的函数只在闭包内用；要给别的闭包/页面用就挂到 `window`（`Api.xxx` / `Wb.xxx` / `ui.js` 的全局函数）。
`mediaSrc` 现在定义在模块作用域，`Api.mediaSrc` 仍是对外入口。
**同一类的第二个坑：页面内联脚本里不要用顶层 `function esc()`** —— 它会覆盖 `window.esc`，
于是 `Wb.esc → window.esc → 自己` 无限递归（`RangeError: Maximum call stack size exceeded`），
表现是**页面静默空白、控制台一条红字都没有**（递归爆栈发生在 iframe 里，外壳看不到）。
`studio.html` 踩过一次，现在本页一律 `const escA = s => window.esc(s)`。别的页面加转义函数时先看一眼
`ui.js` 挂了什么名字（`esc` / `escA` 之类），别重名。
**第三个坑、也是最不容易看见的：不只是跨闭包，**同一个闭包里**局部函数被兄弟函数裸调**也一样炸。
`drama.html` 的 `renderRewound()` 里写了 `bind('btnBackStep', …)`，而 `bind` 只是 `renderBottom()` 里的
一个 `const bind = (id, fn) => …` —— 语法检查一行都不报，页面也照常渲染，只有点那一下才
`ReferenceError: bind is not defined`，表现是**新的一屏画得好好的、那颗按钮却是死的**。
规矩：**页面里调另一个函数，先确认它在当前这条链路上真的在作用域里**；同名不要紧，
**同名但在不同函数里就一定会炸**。这一档现在有常驻自检（见 §5 的第 ⑩ 档），
它按块作用域把每个内联脚本里的裸调用解析一遍，3455 处全部落在本闭包或 `window` 上。

同一个功能只应有一份实现：下拉用 `ui.js` 的 `Dropdowns`（支持 `<optgroup>` 分组），网络用 `Net`，
任务轮询用 `Wb.poller`，历史用 `Wb.History`，媒体一律 `Api.mediaSrc`，跨平台素材用 `AssetTransfer`，
**IndexedDB 读写只用 `ui.js` 的 `Kv`，而且只写登记名**（`Kv.at('ws'|'fav'|'blobs'|'thumbs'|'dir').get/put/del/all/entries/tx`，
方法签名和 `wb_blobs` 这类字符串一样都不许再抄进页面 —— 库/表名只在 `Kv.TARGETS` 里点名一次）：连接按库名复用、
「库存在但仓库缺失」用 version+1 补建、失败不缓存 Promise（隐私模式 / 别的标签页占用时下次还能重试）
—— 这三条各页以前各写一份（共 6 份），只有导演台那份是全的。写死版本号（`open(db, 1)`）会让补建后的库永远打不开，
设置页的整包备份就曾经因此静默漏掉整个 `director_db`。整包备份要带哪几个库同样从 `Kv.TARGETS` 现算
（`backup: true` 的那些；`dir` 存的是目录句柄、过不了 JSON，故意不带 —— 别「顺手补全」）。
**动作胶囊按钮用 `ui.css` 的 `.btn-row` + `.tool`（`.tool.acc` = 主操作、`.tool.danger` + `.sp` = 顶到行尾的破坏性动作），
「AI 挑了哪些」这类条件芯片用 `.ai-chip`，侧栏余额显示哪几个接口用 `ui.js` 的 `SbBal`（键 `sb_bal_show`，只在设置页勾）；
`SbBal.prune(kids)` 清掉名单里已经不存在（或压根没有余额接口）的 kid —— 平台下架 / 改名 / keyId 变了之后，
那份隐藏名单会一直攒着死数据。侧栏每次取完余额顺手调一次（只有真清掉东西时才写盘），页面别自己再过滤或重建它。
**视频缩略图用 `Wb.thumbs`，任务卡片「详情」面板用 `Wb.detail`，右栏卡片列表用 `Wb.cards`，
分页/动态加载用 `Wb.pager`，灯箱预览用 `Wb.lightbox`，下载走 `Wb.save(url,name)` → `Net.save`**
（都在 `workbench.js`，配套样式在 `ui.css` 的 `.det-*` / `.tph` / `#lbStage`；
页面只提供适配器，别再各写一份 renderDetail / fmtDetail / 卡片列表 / 灯箱）。
发现重复实现（例如页面里自己写的下拉/灯箱/上传/详情/缩略图/分页）→ 收敛到公共模块，别复制。
**下载不再有「落点」这一层**（2026-10 全部删除）：`Wb.saver` / `showDirectoryPicker` / `showSaveFilePicker` /
`Kv.TARGETS.dir` / 设置页「下载位置」那一卡 / 卡片与灯箱上的「另存为」都没了，一律走浏览器默认下载。
`proxy.js` 的 `RENDER_DIR`（ffmpeg 成片输出）与此无关，保留不动。
**新增一个页面只改三处，代理零改动**：`app.js` 的 `PAGES`（外壳路由认它）、`sidebar.js` 的 `items`（左栏入口 + 高亮）、
`ui.js` 的 `window.PAGE_TARGETS`（「列表分页」那一张表：`page_mode_<key>` / `page_size_<key>` 要能配，设置页读它渲染这张表）。
静态服务不用往 `proxy.js` 的 `FILE_MAP` 加条目 —— 单层普通文件名 + 扩展名白名单那条兜底已经能服务 `xxx.html`
（`drama.js` / `ui.js` 同理），但**文件名不能以点开头发头**，`chars.html` 这类普通名直接通。
漏一处的表现各不相同：漏 `PAGES` = 侧栏点了不换 iframe；漏 `PAGE_TARGETS` = 页面能开、设置里却配不了它的分页；
漏 `items` = 只能手敲地址进去。
**AI 助手（`ai-chat.js`）只有一份，活在外壳层**：`shell.html` 引它（悬浮球可拖动，位置存 `ai_chat_xy`，切页只换 `#appFrame` 的内容 ——
抽屉、对话记录、正在流式写出的那条回答都不重建；抽屉**展开与否不跨刷新保存** —— 记住「上次开着」等于每次刷新都先把抽屉糊在页面上）；
十个内容页也各引一行（放在 `ui.js` / `assetlib.js` **之后**），
被直接打开时它自己挂载，套在外壳里检测到 `window.top.__SB_SHELL` 就退出（两份实例会各存一份记录、各画一个球）。
外壳为此额外引了 `assetlib.js` / `workbench.js` / `drama.js`，查询不再取决于脚下开的是哪一页。
**夹悬浮球位置的左边界要让开侧栏**（`clampXY` 读 `--sbw`：收起 66px / 展开 200px）：球是 `z-index:56`、侧栏 90，
停在它覆盖的那一条里就点不到 —— 等于把助手弄丢，而且存过的旧位置每次都重新踩回去。
要让助手看得见这一页的状态，调一次 `AiChat.pageCtx(() => ({ ... }))` 注册**只读**快照（它写到 iframe 的 `window.__acPageCtx`，
外壳那份现取；现在只有 `drama.html` 注册，因为只有那一页的状态在闭包里、外面读不到。
界面上的下拉当前值由 `domPicks()` 自己扫 DOM，页面**不要**再抄一份「我选了哪个型号」）。
硬约定：
- **读与写是两张表**：`TOOLS` 里全是 GET 与本机读（16 项：`overview` / `tasks` / `doctor` / `models` / `model` / `dramas` / `chars` / `fav` / `assets` /
  `prompts` / `usage` / `settings` / `credits` / `go` / `files` / `read_file`）；写只在 `ACTS` 里（`generate` 提交一次生成任务、
  `set_setting` 改一项设置）。**新增查询只加 `TOOLS` 一个条目**（`arg` / `doc` / `run` 三样写在一起），系统提示词里那份清单由这张表现拼 ——
  分成两处写就会出现「指令还在教模型用已经改掉的参数」。
- **助手提交的任务由外壳自己等**（`ai_chat_watch`，`K_WATCH`）：`runGenerate` 拿到任务号就 `addWatch`，`watchTick` 每 `WATCH_EVERY`
  问一轮，判据只有 `probeWatch` 一份（**轮询器与 `tasks` 查询共用**，各写一遍就会出现「球上的点说完了、助手回答里还在等」）。
  到终态才 `finishTask`：结掉 = 对话里一条 `.ac-note` + 清单少一条 + 抽屉收着时球上点个「没看的」+（勾了且授权过）一次系统通知，
  并写进 `acts`（下一轮上下文里看得见结果）。三条硬约束：
  ① **接口暂时查不到 / 这一家问不通都不算失败**（只有超过 `WATCH_TTL` 才给个「超时」的说法）—— 把「网络不通」判成「任务失败」
  就是骗人；② 到期 / 换平台导致注册表里查不到这一家时才结掉，并照实说原因；③ **绝不重新提交**，刷新后接着按任务号问
  （重新提交就是重复扣费）。`ai_chat_watch` / `ai_chat_notice` 都在 `DataSync.NOT_SYNC` 里：等待清单与通知授权是**本机这一台**的事，
  同步到另一台机器就等于把提醒弹给错的人。
- **动作必须先过确认卡片**（误触一次就是真金白银的重复扣费，见 §4）：`RUN:` 解析出来的动作**校验全部做完才画卡片**
  （型号属于哪家、参数取值在不在声明里、槽位上限、素材从哪来），卡片画出来时用户点「执行」才真提交 ——
  卡片上写明「哪一家 / 哪个型号 / 什么参数 / 哪些素材从哪个地址来」，一张卡片只认一次执行。
  **在设置页里被「停用」的一家不能提交**（`sk_off_<kid>` 是本机开关，各页下拉都按它过滤；它不在可改白名单里，
  所以助手也**不替用户打开**）：`genCheck` 直接拒，并且 `overview` / `models` 要把「停用 / 内置还是自定义」一起报出来 ——
  只报「有密钥 = 可用」就会出现「助手说能用、界面下拉里根本没有」。
  **卡片上引用的附件要按身份复核**（`chk.钉` = 序号 + 文件名 + 本机地址）：`inputs:[{file:0}]` 指的是
  **画卡片那一刻**的第 0 个附件，卡片挂着的时候用户加/删一个附件，序号就漂到别的文件上 ——
  `execRun` 把 `m.钉` 传回 `genCheck` 比一遍，对不上就拒并说出卡片上原本是哪一个（凭漂了的序号替用户提交另一张图是不安全的）。
  执行结果接回下一轮上下文，成了什么、为什么没成都不许靠猜。
- **附件的凭据只有本机地址**：`CALL: files` / `read_file` 与动作里的 `inputs` 只认 `/asset/`、`/getv/`、`/local-assets/`，
  外部直链一律拒（递出去的是「这个文件在哪」，不是「随便替我访问一个网址」）。
  附件的**身份**（名字 / 类型 / 本机资产地址 / 文本快照）存 `ai_chat_files`，换页与刷新都还在；字节要么在本机资产里、
  要么是加入时截断存的文本快照，两边都没有时 `read_file` 照实说「不在了」并让人重新拖。
- **设置项只有白名单**（`ADJUST` 那几项 + `window.PAGE_TARGETS` 的行 + `sk_model_<kid>` + **`drama.js` 的 `Drama.SET`
  那几项**）：`writableKeys()` 是**现读这几张表**拼出来的，不是手抄的键名清单 —— 再抄一份就会出现
  「设置页有这一项、助手说改不了」。单页被直接打开、这一页没引 `drama.js` 时它会现取一次脚本再读（`dramaSET()`），
  否则同一份助手在「从外壳进」和「直接开页面」两种情况下能改的清单不一样。
  数值型只校验「是个大于 0 的数」并写明单位与**它管不了什么**（整集分钟数最终仍被视频平台声明的档位夹），
  **不要在助手里另编一套上下限**（那是第二份判据）。`sk_key_*` 与 `sk_base_*` 明确拒掉 ——
  前者会把密钥写进对话记录（`ai_chat` 跟着云同步出网），后者容易造出「A 家密钥打到 B 家地址」那种必然失败的组合。
- **供应方与型号只存自己的 `ai_chat_pick`，不许写 `sk_text_prov` / `sk_model_*`**（那是设置页「点保存才生效」的动作）；
  发请求时把选中的那家**显式**当 `prov` 传给 `TextAI.chatStream`，别让它退回 `TextAI.prov(REG)`（保存值）。
- **流式进行中不许「清空」**（`paint()` 会把正在往里写字的那条气泡一起清掉 —— 字丢了，请求还在跑、还在扣 tokens）；
  断开这一层（刷新 / 关掉外壳）时 `pagehide` 要把**已经写出来的字**落盘，并写明这次断了。
  **`paint()` 是全量重画，而 `push()` 无条件调它** —— `finishTask` 由 12 秒定时器驱动，正好落在流式期间时，
  那条气泡会被摘出 DOM 当场消失。所以 `addStream()` 把节点记在 `liveEl`，`paint()` 重画完再**原样挂回去**
  （同一个节点，闭包里那几处引用照样有效，已经写出来的字也还在）。只给「清空」按钮做守卫是不够的。
- **对话记录是会话表（`ai_chat` = `{v:2, cur, list:[{id,title,at,msgs,acts}]}`），不是一条扁平数组**：
  `msgs` / `acts` 仍是模块级变量，切换会话时 `bind()` 整体重新指向当前那一份 —— 现有 `msgs.push` 代码零改动。
  `load()` 要**把 v1 的扁平数组自动包成第一个会话**（不做这个迁移的用户打开就是一片空白，像记录被清空了）。
  `acts` 随会话落盘是必须的：它和 `note` 气泡是「任务出了什么结果」仅有的两个载体，
  以前 `acts` 是纯内存 `const`、一刷新就没了。
  `compose()` 除了历史还要带上最近 3 条 `note`（任务结果正文）——
  下一轮模型看不到它的话，用户追问「刚才那个任务怎么样了」助手必然答不上来。
  新建 / 历史会话的两颗按钮挂 `.ac-hd`（`#acNew` / `#acHist`），历史浮层是 `position:absolute` 盖在对话区**上面**，
  不替换对话区（替换的话点错一下，写的字就没了）。「清空」只清**当前这一段**。
- **`watchTick` 整轮包 try/catch，而且无论成败都要再排下一轮**：以前 `startWatch()` 是最后一行，
  读清单 / 探状态 / 写结果里任何一处抛错，轮询链就**静默断掉** —— 球上一直显示「在等 N 条」直到刷新，
  而任务其实早就好了。这是「任务完成后应该在会话中显示」最容易被忽略的一个成因。
  连续三轮问不通才在对话里说一次（每 12 秒塞一条会淹掉对话），并写明**这不代表任务失败**。
- **输入框：Enter 发送、Shift+Enter 换行**。`e.isComposing || e.keyCode === 229` 要放行 ——
  中文选词上屏那一下还会再触发一次 keydown，挡不住就是「刚选完字直接发出去」。
  placeholder 与 AGENTS/README 都要跟着改（写着「Ctrl+Enter 发送」而实际是 Enter 发送，就是骗人）。
  模块内**不要**拿 `open` / `close` 当函数名：它们 shadow 全局 `window.open` / `window.close`，而漏改的一处调用
  （`el.close.onclick = close`）会静默变成「按 × 把整个页面关掉」，语法检查一行都不报。
- **`/sys-status` 只有一份取法与一份说法**（`assetlib.js` 的 `Api.sysStatus(fresh)` / `Api.sysTool(t)` / `Api.sysDir(d)` /
  `Api.sysStatusLines(s)` / `Api.SYS_WHY`）：设置页「本机环境」那一栏、`Drama.Pipe.render` 导出前的闸门、助手 `doctor`
  问的是同一件事 —— 各拼一句就会出现「设置页说能用、助手说不能用」，探测参数也会走样（它要在本机起子进程跑
  `ffmpeg -version`，所以超时给足且**不许重试**，这些都在 `Api.sysStatus` 里定一次）。三边只渲染，不另编文案；
  「没读到」是黄的、「写不进去」才是红的（旧代理根本没这个接口，标红了人去找磁盘权限）。
  导出闸门那一条还要守住**只有探明不能用才拦**：这一问本身失败（404 / 超时 / 断连）就照常提交，
  否则等于把「体检读不到」说成「你 ffmpeg 坏了」。
**灯箱的 DOM 也由 `Wb.lightbox` 创建**（页面别再手写 `#lightbox` 标记，老标记它会在 `_mount()` 里自动补齐/清理）。
**缩略图的外壳标记也只有一份：`Wb.thumbs.mediaHTML(src, {key, type, mediaAttrs})`** —— 占位层 `.tph`、
`data-thumb-key`、`data-src` 全由它生成。页面自己拼 `<video class="thumb">` / 再手写第二个 `<span class="tph">`
就是第二份实现（踩过：手拼出来的 `data-thumb-key` 是**未归一化**的签名地址，缓存永远命不中；重复的 `.tph`
又因为不跟着 `.ready` 消失，把画好的一帧盖成空白）。要换包装只在 `mediaAttrs` 里传 `class`/`loading`。
**`mediaHTML` 画出来的媒体必须接线（`Wb.thumbs.bind`），而且接线要放在「所有渲染路径的汇合处」**：
资产库的卡片有两条路径（新建 `buildAssetCard` / 重绘 `paintAssetCard`），接线只挂在重绘那条上时，
**筛完类型再换一个平台，新建出来的卡片永远不抽帧**（要等下一次卡片指纹变化才有机会重绘），
表现就是「视频缩略图整排是灰的、也不报错」。现在两条路都汇到 `bindAssetCard`，接线只在那里做一次。
**抽帧失败会自动重试两次（5s / 20s）**，重试用完才在占位层写原因；占位层里有字时由 `ui.css` 的
`.tph:not(:empty)` 排成居中小灰字（各页容器宽窄不一，不写这条字会挤在左上角并溢出格子，看着就是一块纯灰）。
**首屏/列表的本地缓存只有一份：`AssetLib.listCache(key, cap)`**（生成工作台合并后是 `studio_tasks_cache_v1` 一份，
`assets_cache_v1` / `video_tasks_cache_v1` / `audio_tasks_cache_v1` 都是合并前的旧键、页面已不再写），
去重用 `AssetLib.mergeEntries(base, add)`。写缓存前它只保留**终态**条目
（`kind:'asset'` 或 `done/failed/succeeded`）—— 页面自己写一份过滤就没有这层保护，
「生成中/排队中」被持久化后下次打开就是永远不动的假任务（§6 里那三大成因之一）。
**生成工作台（视频 / 图像 / 语音合一）的两栏布局只在 `ui.css` 的「工作台共用布局」里定义一份**（`<body class="wb2">`）：
轨道宽、滚动条宽与 `scrollbar-gutter`、断点都在那里。页面 `<style>` 里只留页面专属规则（textarea / 素材 / 按钮行等），
**不要**再抄一份 `.layout` / `.col-left` / `.col-right` / `::-webkit-scrollbar` —— 之前三页各抄一份的结果是切换时右栏
宽度差 8~16px、滚动条出现/消失引起整栏重排。卡片里可能撑宽的文本（`.task .tprompt` / `.meta2`）要带 `overflow-wrap: anywhere`，
否则 grid item 的 `min-width:auto` 会把 `minmax(0,1fr)` 顶穿。
- **`.tool` 磁贴的显隐要用 `hidden`**（`ui.css` 里有 `.tool[hidden] { display: none; }` 这条兜底）：
  `.tool` 自带 `display: inline-flex`，会和浏览器默认的 `[hidden]{display:none}` 同权重、又因为写在后面而赢掉，
  于是 `el.hidden = true` 看着没反应。踩过一次：「参考音频」磁贴对任何模型都挂着（等于不是能力驱动的）。
  凡是「随能力出现/消失」的磁贴、槽位，都别用别的方式藏（例如只改文字或加 class）。
- **AI 润色是两段式，就地问**（`ui.js` 的 `InlinePolish.interactive`）：
  页面只提供两个回调 —— `ask(): Promise<{need, questions[]}>`（问要点）与 `run(answersText): Promise<{after, note}>`；
  问答面板、结果面板共用 `#polishInline` 那一块，**不开新弹窗、不换界面**。每题 = 若干候选芯片 +
  **最后一个固定是「✎ 其他」**（点它焦点进自由输入框 —— 没有这个入口就等于没有手写功能）。
  「改回答」重画**同一批问题**（保留已选），不重新问模型 —— 再问一次多半会直接回润色结果，问题就丢了。
  导演台因为编辑器会重渲染，面板状态存在 `polishUI` 里并由 `renderPolishPanel` 重画（已选答案也要存着）。
- **润色要把用户的素材交给 AI**（已实现，别再退回「只说一句」）：
  `TextAI.polishImages(REG, [{label,src}])` 把参考图压到最长边 1024 的 JPEG、按 OpenAI 多模态格式附在消息末尾，
  并写明「图1 = 参考图 1」；**只有识图型号才带**（识图判定：手动 → 接口字段 → 平台声明，不猜名字）。
  **视频 / 音频附不了**，但必须用 `TextAI.materialNote(items)` 告诉模型「类型 × 数量 + 用途 + 别凭空编造」——
  只写一句「还挂了参考视频」的话，模型既不知道有几个也不知道内容，只能靠猜。
  items: `{label, kind:'图片'|'视频'|'音频', sent:bool, hint:'用来干嘛'}`；生成工作台里一份 `polishMaterials()` 收三种类型，
  措辞只有 `materialNote` 这一份。**追问那一轮也要带同一份素材**（看过画面再问才问得出画面相关的问题）。
  **不必每次都问，且由 AI 自己决定**：点润色后先让文字 AI 读一遍内容，**它判断**该不该问
  （`TextAI.askPolish` 返回 `{need, questions}`；`need:false` 就直接进润色，不浪费一次调用）。
  **不要用字数阈值代替这个判断** —— 一句 30 字可能很清楚，一段 200 字也可能全是废话。
  设置项 `sk_polish_ask`（ai/on/off）只控制「要不要发起这一轮」，默认 ai。
  「为什么可以问、答案会被怎么用」写在提示词里：`TextAI.DEF.ASK_NOTE`（自动接在三条润色指令后面）
  与 `askPolish` 的契约段 —— 提示词没写这件事，模型就不知道自己有两段可选。
- **AI 指令的默认文本只有一份**：`assetlib.js` 的 `TextAI.DEF`（video / img / audio / story / split）+
  `TextAI.prompt(kind)`（用户改过的优先）。设置页用它初始化输入框与「恢复默认」，四个页面用它兜底 ——
  以前设置页一份、页面里各抄一份兜底长串，改一边另一边不跟着改。写指令统一按
  「身份 → 任务 → 硬性要求 → 禁止 → 输出格式」组织，**「只输出结果、不要解释」每条都要写**。
- **别把 A 的密钥发到 B 的地址**：文字 AI 的自定义地址按供应方各存各的（`sk_base_<kid>`），
  但很容易在「供应方 = DeepSeek」时把 OpenRouter 的地址填进去 → 请求带着 DeepSeek 的密钥打到 OpenRouter，
  上游只回一句 `Your api key ****xxxx is invalid`，界面看着像「我明明选了 OpenRouter 啊」。
  `TextAI.baseOwner(REG, base, prov)` 查出这个 host 属于 registry 里**别的**供应方（`kind:'other-provider'`），
  或者干脆不是官方地址（`kind:'other-host'`，第三方中转 = 官方密钥外泄）。
  设置页发现「这个 host 正好是 registry 里**另一家的官方地址**」时，**把它挪回属于它的那一栏**
  （`migrateBaseOwner`：写 `sk_base_<对方的 kid>`、当前这栏恢复默认），并给「撤销这次挪动」——
  只警告不处理的话，每次打开设置页、每次切到那家都会重报一遍。
  **只对「另一家的官方地址」做**（那种组合本来就不可能成功，不存在故意这么配的用法）；
  第三方自建中转那种 host **只警告**。手动正在输入的地址不自动动（只作用于已保存的值）。
  **官方地址要显式写出来**（`https://openrouter.ai/api/v1`），别让地址栏空着让人以为「没有默认地址」。
  **页面里不许再预填 `sk_base_<kid>`**：注册表还没加载完的那一瞬间预填，会把上一家的地址摆出来
  （表现就是「选了 OpenRouter，界面却显示 deepseek」，甚至把地址存到错的那家名下）。
- **统一选择器把规则显示出来并强制**（`assetlib.js` 的 `AssetPicker.open({ rule })`）：
  `rule` 就是 `Capabilities.rule(模型, role)` 的原样（`max` / `accept` / `maxBytes`），弹窗顶部渲染
  「本槽位规则 · 最多选 N 个 · MP3 / WAV，≤ 10.0 MB」，计数条从打开起就写「已选 0 / 8」，
  点满与上传超限当场拦并说清原因。**页面不要再自己写「最多 9 张 / 只收 mp3 / ≤10MB」**——
  数量、类型、体积三条上限都只能来自能力声明；导演台那个「视频 / 图片都能进」的入口取两个槽位里**更严**的一条。
  **能多选的槽位要能点几下就攒到上限**（不然上限 8 只能点 8 次）：**普通点 = 选中 / 取消这一张**
  （点一下加一张，**不需要按 Ctrl**——用户要的就是「点一下多选一张」，把加选挂在修饰键上反而是多余的；
  再点一次取消）、**Shift 连选一段**（到上限为止，多出来的写明「已选满 N 个，多的没选中」）；本地上传本来就是多选，
  超出位置的那几个只收能收的数量并说明。**不要加「一次选满 N 个」按钮**（按过就取消：它把「上限」当成了默认动作，
  选错还得再来一次，而且和 Shift 连选功能重叠）。可见顺序一变（筛选 / 切档位 / 翻页）**连选锚点要作废**，
  否则 Shift 会选到不相邻的一段。
- **单选也走同一条路：点选 → 底部「确定」**（`build` 的 `d.onclick` 里单选分支只 `picked` + `syncSel()`）。
  别写成「点一下就 `finish([e])` 并关窗」——选错了只能重开一次弹窗，而且和规则条上写的操作说明对不上。
  **本地上传也一样**：`uploadFiles` 不再 `finish(added[0])` 直接关窗（它还会把用户刚点中的那一条无声丢掉），
  单值槽位改成 `pick.clear()` + 选中传上来的那一个，弹窗留着等人按「确定」——
  规则条上写的是「点一张选中，按确定」，上传走另一条路就是对不上。
- **本地上传的条目必须 `pick.addMany(...)` 进同一个 `picked`**（`ui.js` 的 `PickSel` 为此加了 `add` / `addMany`，
  返回真正加进去的个数）。以前只 `upPool.unshift`，于是**三个症状一起出现**：
  ① 计数条只数点过的那一边（「已选 3 / 8」和实际拿到的 8 个对不上）；
  ② 「确定」交出的是 `pick.list()`，传的一个都没有 → 调用方 `if(!list.length) return;` 静默无动作，
  表现就是「选完加不进参考槽」；③ 单值槽位更糟，连之前选的那条一起丢。
  **上限判据只在 `PickSel.addOne` 一处**，差值由调用方照实说（「最多 N 个，多传的 M 个没选中」），别再自己编一套。
- **计数条是两条通道，别都直接写 `#apCnt`**：`syncSel()` 写常驻的「已选 N / 上限」，
  `say(t)` 写一次性说明并在 4 秒后自动让位（句柄记在 `noteT`）。两路都直写的话，
  提示会被下一次 `paint()` 当场覆盖 —— 用户看到的是「说了等于没说」。
  `PickSel` 的 `onNote`（Shift 连选溢出、已选满）也走 `say`。
- **本次上传的本地文件不进 `IntersectionObserver` 的队**（`if (io && !e.fromLocal)`）：
  它们的 `src` 是 `blob:` 地址、字节已在内存里，再等「滚到附近」只会一直显示占位符 `…`。
  另外上传条目的 `ts` 用 `Date.now()`（不是 `f.lastModified`）—— 重传一个旧文件沉到网格最底部，
  缩略图要靠滚动才出得来，看着就像「传了文件但没有缩略图」。
  缩略图键用 `encodeURIComponent(name)|size|lastModified`：`Wb.thumbs.keyOf` 会先 `split('#')[0]`，
  文件名带 `#` 时键被截断，缓存永远命不中。同一个文件重复传由 `_ukey` 去重（`compose()` 按它归并）。
- **`multiple` / `limit` 要按「这个槽位**还剩几格**」开，不是按槽位总容量**（两者不一样）：
  数据模型只存一条的槽位（导演台的参考视频 / 参考音频、生成工作台语音栏的参考音频，提交体是单数字段）
  即使平台声明 `max > 1` 也要传 `limit: 1` 并把 `rule.max` 覆盖成 1 —— 否则弹窗写着「还能加 1 个」、
  却又只能点一张（用户看到的就是「选了一个就不让选了」）。反过来，导演台**参考图**是 `sh.refImages` 数组
  （右栏写着「已有 N / maxRef 张」），必须 `multiple: room > 1, limit: room`，`room = maxRef - 已选`，
  别写死 `limit: 1`。
- **「确定」必须走 `finish(entries)`，不能直接 `close(entries)`**：`finish` 除了 resolve 还会对每个条目
  调一次 `o.onPick`。只 resolve 的话，靠回调落地的调用方（导演台三个槽位）点确定等于**什么都没发生**
  ——它不接 Promise 的返回值。回调与 Promise 只能二选一，别让同一个调用方两个都指望。
- **选择器网格的媒体要走自己的调度器，别一建卡就把 `<img>`/`<video>` 塞进 DOM**（慢的根因）：
  `build()` 只画 `.ap-wait` 占位（卡片立刻能看、能点、能多选），`IntersectionObserver`（root=`.ap-body`，
  rootMargin 400px）滚到附近才 `scheduleMedia`，按 `MEDIA_CONC`（图 8 / 视频 2）**在飞请求**封顶，
  缓存命中的（`Wb.thumbs.get`）直接放行。三个容易踩的点：
  ① **观察器回调里回查条目要从元素上取 `el._apEntry`**，不能用 `nodes.get(el)` —— `nodes` 那张表是
  「条目 → 元素」，反过来永远是 `undefined`，症状是占位格一个都填不上（观察器明明回调了，每张卡都被丢掉）；
  ② **插槽要数「在飞的网络请求」**，`fillMedia` 返回一个等 `load`/`error` 的 Promise（15 秒兜底），
  只等「插入 DOM 这个同步动作」的话等于没封顶，几十个 `<img>` 一起抢连接；
  ③ **别再叠浏览器自己的 `loading="lazy"`** —— 放行由调度器说了算，屏幕外那几张会被压着不取，
  并发插槽白占到 15 秒兜底才放行，反而更慢。
- 媒体**一律**用 `Api.mediaSrc` / `Wb.thumbs.mediaHTML` 出地址，缩略图缓存键走 `Wb.thumbs.keyOf` 归一化。
- **文本要转义**：凡是插进 `innerHTML` 的用户文字 / AI 文字都过 `Drama.esc()`（或页面自己的转义函数）。
  剧本文本、角色名、台词全是模型或用户给的原始字符串，直接拼进模板就是一条 XSS。
  纯文本内容用 `textContent`；只有确定没有用户输入的地方才用 `innerHTML`。
- **文字 AI 的调用要按「下拉里选中的供应方」**：`TextAI.models / chat / vision / visionAsync / verifyKey`
  都接受显式的 `prov`（设置页传 `curTextProv()`）。只给 `REG` 不传时用 `TextAI.prov(REG)`（已保存的那家）——
  否则「下拉选了但没保存」时，取型号会打到别家去，界面上完全看不出来。
- **`REGISTRY.version` 是「代理新不新」的判据**：改了注册表结构就 +1，`Api.registry()` 取回注册表时顺手调
  `warnOldProxy`（版本低于 `PROXY_VERSION_MIN` 时每个标签页提示一次「本地代理是旧版，部分能力声明不生效，请重启」；
  文案是纯函数 `Api.oldProxyNotice`，好单测）。页面**不要**自己再比对版本号。
  这类「选项为什么不出现」的问题必须有个说得出口的原因，不能让人猜是不是功能坏了。
- **文字 AI 是多家供应方**（`TextAI`，默认 OpenRouter）：选哪家存 `sk_text_prov`，密钥 / 基址 / 型号按
  `keyId` 各自存（`sk_key_<kid>` / `sk_base_<kid>` / `sk_model_<kid>`），**用户自己填的型号**存
  `sk_text_models_<kid>`（永远出现在下拉里，不依赖 `/models` 有没有列它，**只属于当前这家**）。
  **「当前用哪家」以下拉里选中的为唯一真相**（`curTextProv()` 直接读 `#textProv` 的 value）——
  曾经让它先看内存里的 pending、再退回「已保存的那家」，于是下拉选了 OpenRouter、
  地址警告 / 型号分组 / 保存却全按 DeepSeek 走（表现是「换了供应商还是满屏 deepseek、还不让保存」）。
  「常用接口」预设里**带 `prov` 的那两条要连供应方一起切**（只填地址会造出必然被拦的错配组合）。
  下拉按来源分两组渲染（`TextAI.modelGroups` → `接口返回（供应方名）` / `自己添加`），
  **不展示 registry 里写死的「平台内置」**（固定清单会让人以为型号是写死的；它只作 `model()` 的内部兜底）。
  **切供应方时列表整体换成那家的** —— 取回的接口列表要**按 provider 存**（以前是一份全局变量，
  切了供应方还串着上一家的型号）。「测试」与识图提示都走**下拉里当前选中的型号**（`opts.model` /
  `vision(REG, prov, model)`），别用 `TextAI.model(prov)`（那是保存值，会出现「下拉选了 A、实际发 B」）。
  另有 `TextAI.ownsModel(prov, id, fetchList)` 归属守卫：型号不属于当前这家就**不发也不存**。没显式选过时：默认供应方**能用**
  （本机有密钥或服务端 `.env` 配了）才轮到它，否则退到下一家有密钥的 —— 光换默认就把原来能用的润色弄坏，
  是不能接受的。「哪家在服务端配了密钥」从 `/env-status` 读（`TextAI.warm`，60 秒缓存），
  **不要**往 `/registry` 里塞这种标记：registry 允许跨站读，等于往外报配置。
  **识图（`TextAI.vision`）只有三级：设置页手动指定 → 接口字段 → registry 声明，全都没有就按不支持**；
  **禁止按模型名猜**（`vl` / `gpt-4o` / `claude` 这些名字会骗人：开源复刻顶着同样的名字不吃图，
  猜错就是白花 tokens），`VISION_RE` 那套已删，别再加回来。
  **别拿「能拉到型号列表」当密钥有效的证据**：OpenRouter 的 `GET /models` 是公开的（不鉴权也能拿全量 460+ 个），
  拿着无效密钥照样「获取成功」。所以设置页另有「验证密钥」按钮 —— `TextAI.verifyKey` 按余额接口的状态码判
  （免费：200 有效 / 401 无效 / 403 有效但权限不足）；鉴权类报错一律追加「用的是：哪家 + 哪把钥匙的尾号」；
  密钥入库前先摘掉 `Bearer ` 前缀与空白（头是本模块自己拼的，带前缀会变成 `Bearer Bearer sk-or-…`）。
- **自填型号「串台」的根因是静默兜底键，不是存储层没分家**：`sk_text_models_<kid>` 一直按 `keyId` 存，
  内置两家与自定义条目之间本来是隔离的；出事的是 `customKey(null)` —— 只要 `provByKid(kid)` 有一刻返回
  `null`（注册表还没就绪 / 热重载竞态 / 刚添加的供应商还没并进去），用户填的型号就被写进
  `sk_text_models_deepseek`，随后 `renderCustomModels` 又把 DeepSeek 那份画到当前这张卡上 ——
  表现正是「我填在 OpenRouter，型号跑到了另一家」。所以**所有读写自填型号的入口都要先过同一个判据**
  `TextAI.hasProv(prov)`（`!!(prov && (prov.keyId || prov.id))`），认不出这家就显式不操作 / 返回空，
  **绝不落到兜底键**。判据只有这一处，别在调用点各写一遍。`model(prov)` 拿不到平台时返回 `''`：
  发出去让上游报错，比发别家的型号诚实。删一家时 `Api.customDrop` 要连 `sk_text_models_` 一起清。
- **文字 AI 现在是 9 家 OpenAI 兼容供应方**（OpenRouter / DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 硅基 / 火山方舟 / minimax）。
  能一口气加这么多是因为它们**全都只提供** `POST {base}/chat/completions` 与 `GET {base}/models`，
  请求体与响应体（含流式、tools、vision 字段名）与 OpenAI 一致，所以端点、请求体形状、能力判定全照 OpenRouter 走。
  **型号刻意不写死**：这些平台改型号极频繁，写死的清单会立刻过期、还会让人以为型号是固定的；
  页面点一次「获取型号列表」就是它自己的 `/models`，registry 里只留 1~2 个当 `model()` 的**内部兜底**、
  不展示在下拉里（`TextAI.modelGroups` 对非自定义条目不列 registry 声明的型号）。
- **侧栏余额：勾选框一律画，没接口的也画**（`sk_text_vision` 之外的用户已确认过的取舍）。没有 `credits` 端点的
  那张卡给 `.krow .sbshow.dim` 压暗 + title 写「这家平台没有提供余额查询接口，勾了也不会显示余额」——
  勾了不显示，好过连入口都找不到。**能核实的平台就补上真实端点**，其余不编。
  `Api.balance` 的每种 style **自己从 raw 取数**，不复用通用 `entry`（`Array.isArray(raw)?raw[0]:raw.data[0]`）：
  OpenRouter 回对象 `{data:{total_credits,total_usage}}`、DeepSeek 回数组 `{balance_infos:[{total_balance}]}`
  （**字符串，必须 `Number`**），硬套通用入口只会读出空对象。已实现 `openrouter-credits`（只有**管理密钥**能问，
  普通 API key 回 403 → `err` 必须写明「问不了」，不能当成余额 0）、`deepseek-balance`、`moonshot-balance`。
  用量页显示单位按 `b.unit` 走（`amt(v)`），别按「是不是积分」写死两个分支，否则 USD/CNY 会被显示成 ¥。
- **生成类也有两家 OpenAI 兼容的了，声明方式写在 registry 里，页面不按平台 id 分支**：
  - **图片 `create.sync`**（`{ items, url, b64 }`）：`POST {base}/images/generations` **同步返回**、
    没有任务号可轮询（`Api.syncMedia` 取产物 → `saveSyncImages` 取回字节存本机 → 刷列表）。
    **必须存本机**：这类外链一般只有 1 小时有效（硅基流动官方写明），直接摆进列表明天打开全裂。
    与「建任务 → 轮询」的平台并存：`create.sync` 有没有决定走哪条。
  - **画幅有两套参数**：`ar`（比例 `16:9`）与 `size`（`1024x1024`）是两种东西，**混发必被拒**。
    页面为此单开一列「尺寸」（`sizeWrap` / `#size`，只渲染 `options.sizes`），标准字段 `size` 在
    `Api.createBody` 的 `std` 里；`create.body` 的方向是**键=上游字段名、值=标准字段名**
    （`body[上游] = std[标准]`，与 `nest` 的 `[上游, 标准]` 同一个方向；**写反了字段会被静默丢掉**，
    请求照发、参数一个没带上，只能靠 `createBody` 的断言发现）。
  - **语音 `tts.encoding:'hex'`**：MiniMax `t2a_v2` 的 `data.audio` 是**十六进制**（官方 WebSocket 指南明确说
    「用十六进制解码，别当 base64」），而 `/local-assets` 收 base64，页面按这份声明转换；
    文档与第三方示例在这点上不一致，所以**认不出合法十六进制时退回按 base64 试一次**，两种都解不出才报错。
  - **语音台以前只服务一家**（`provGroups()` 里 `slice(0,1)`），加第二家语音平台时下拉里根本选不到它 ——
    现在按平台分组渲染（与图片/视频台同一种形状），`liveModels` 改成**按 provider 分桶** `{ 平台id: [型号] }`
    （以前是一份全局变量，第二家取回来的型号会盖掉第一家那份），谁家的 `/models` 挂了只影响那家。
    音色 / 格式 / 字数上限本来就跟 `currentModel().prov` 走，多列一家不需要新机制。
    那句「换的那请在设置页勾掉这一家的『暂时不用』」是「一次只服务一家」时写的，**已删**。
  - `refreshCaps()` 换到**没声明能力接口**的平台时必须把上一家的 `capHint` 清掉：不清的话面板上会同时挂着
    「能力来自上游接口（缓存）」和「该平台没有声明能力接口」，两行自相矛盾。
  - **本机资产库（`local:/local-assets`）是多家平台共用的一条列表来源**，条目自己记着是谁生成的
    （保存时写进 `provider`）。`AssetLib.normalize` 按**条目自己的 provider** 归属性 ——
    否则先读到的那家（语音）会把后面读到的图片全标成自己，卡片「平台」那一行就成了假话。
- **设置页统一「点保存才生效」**：任何控件的改动先只改表单 + `markDirty()`（保存按钮点亮成待保存色），
  落盘全在 `saveAll` 里一次做完。勾选类（侧栏余额）、预设按钮、下拉、输入框都算，不再有「一点就生效」的例外。
  设置页里跨闭包要用的东西挂到 `window`（`window.__textForm`），别在闭包里裸调。
- **设置页最上面那条栏目栏是**从 `.page-main > .card` 现读**的**（标题取每栏自己的 `h2`，收起着的卡不占位）：
  新加一栏不用改那里 —— 手抄一份标题清单迟早和页面不一致（同一类的错还有「下拉写死 png/jpeg」「音色写死声音 1/2/3」）。
  关键词筛选**只加 `.set-off` 类**，不碰 `hidden`（`#cusCard` 自己拿 `hidden` 表示「那张卡还没打开」，抢同一个开关就两件事搅在一起），
  也**不要** `markDirty()` —— 读一读不该把这一页点亮成「有改动没保存」，然后每次切页都弹那道闸。
  卡片被页面自己打开/收起时由 `MutationObserver` 跟着重画，但它只认「`.page-main` 直系的那个 `.card`」并节流合并；
  判据不能拿「初始化时可见的那几栏」当名单（本来就收起的卡恰恰不在里面，那样打开它芯片永远少一个）。
- **内容页 → 外壳只有一条主动通道**：`app.js` 的 `wb:close-sb-overlay`（窄窗浮层侧栏「点内容区关闭」）。
  iframe 里的点击不冒泡到外壳，所以在 iframe 文档上挂捕获监听、由**外壳自己的** `window.postMessage` 通知；
  写成 `frame.contentWindow.postMessage` 是把消息投给 iframe 自己，外壳永远收不到（踩过）。
  弹窗（`dialog[open]` / `#lbStage` / `#apDlg`）与 `[data-sb-keep]` 里的点击不算「点内容区」；
  宽窗口下侧栏是真让位、不是浮层，收到的通知必须忽略（`sidebar.js` 的 `window.__sbCloseOverlay` 负责判）。
  另有**一条被动的**：外壳换页前问一句当前 iframe 的 `window.__skDirty()`（返回一句人话 = 有没保存的改动 → 先弹确认，
  人留下就把 hash 摆回去；答应离开就调 `window.__skLeaving()` 让页面自己的 `beforeunload` 闭嘴，同一次离开只问一遍）。
  判据**只能由页面自己给**（外壳不认识设置页那 12 张卡里哪个控件脏了），页面没挂这两个函数就等于放行。
- **别在页面里手搓弹窗**：自定义内容的弹窗走 `ui.js` 的 **`UiDialog.open({title, sub, body(el), actions})`**，
  它复用 `Confirm` 那一套 `.pr-*` 外壳，全站只有一份弹窗外壳。要一段文字 + 确定/取消用 `Confirm.ask`，
  要几个选项用 `Confirm.choose`，要几个字段用 `PromptForm.open`。
  直接 `document.createElement('dialog')` 写 `.dr-head` / `.pr-foot` 就是又一份实现（踩过：样式慢慢走样，
  而且 `.pr-*` 的样式全挂在 `#prDlg` / `#cfDlg` 这些 **id 选择器**下，换个 id 的新弹窗会**完全没有样式**）。
- **页面必须自带完整的 `:root` 主题变量块**（与其它页面一致，含 `html[data-theme="dark"]`）。
  只写一两个变量（比如只写 `--pri`）看起来没事，但 `var(--panel2)` 之类取到的是**空值** ——
  「变量存在但值为空」**不会**触发 `var()` 的回退值，整条声明直接失效（背景变透明、边框消失）。
  这一条对 `.ui-tag` / `.ui-note` 这些刚提到公共层、依赖变量的组件尤其致命。
- 通用小组件用 `ui.css` 的公共类，别在页面里另写：**`.ghost`**（次要按钮）、**`.tool` / `.tool.acc` / `.tool.danger` / `.tool.on`**
  （动作磁贴）、**`.ui-seg`**（分段开关：声音 1/2/3、时段）、**`.ui-pill`**（可选胶囊：音色、档位）、
  **`.ui-tag`**（状态芯片：已选用 / 配音中 / 没拍成，带 `.ok/.run/.warn/.err`）、**`.ui-note`**（提示条，带 `.info/.err`）、
  **`.ui-hint`**（弱提示）。
  按钮文字一律 `white-space: nowrap`，**要换行请让容器换行**（容器加 `flex-wrap`）——
  否则窄容器里 flex 会把「停下（在拍的会拍完）」压成三行竖排。  - **短剧读写走 `Drama.list/get/put/remove`（键 `dramas`）**、`Drama.Lib` **素材库**（键 `drama_chars`，跨剧复用，独立于某一集）、
    `Drama.Shots` **段落列表本身的编辑**（`resequence` / `moveShot` / `duplicateShot` / `dropShot`，只动数据不生成）、
    `Drama.Subs` **字幕组件**、`Drama.Pipe` 流水线（拆剧本/画脸/配音/拍这段/出成片）、
    `Drama.Cast` **角色卡片上「声音 + 资产」那几块的唯一实现**（`voiceRowHTML` / `voiceBoxHTML` / `voiceChips` /
    `voiceTag` / `voiceName` / `assetNames` / `ASSET_KINDS`（给人看的中文标签表，与 `ASSET_PROMPTS`（画图提示词表）是两张表，别混）/
    `refAudioRule` / `voiceReady` / `preview` / `waitHTML` / `picCandsHTML` / `voiceCandsHTML`）。
    这几块**只有这一份实现**，别在页面里再写一份字幕。
  - **`Drama.Cast` 只产字符串，不绑事件**：它发的是 `data-act`（play / voice / refaudio / refclear / voicenote），
    页面自己绑点击 —— 因为「改完要不要重拍」是页面自己的事。**`voicenote` 是输入框，必须走 `oninput`/`onblur` 并从点击圈里排除**
    （否则点一下输入框等于触发一个空动作）。配套样式在 `ui.css` 的 `.ui-voice` / `.ui-voice-list` / `.ui-in`（拍短剧页与素材库页共用）。
  - **候选那一排（图片 / 声音同一套）只有三条规矩**：① **一次出几张 / 几条不许写死** —— 图片看 `D.Pipe.previewCap(型号)`
    （`max_outputs` 夹到 `FACE_CAP`），声音看 `D.Pipe.voiceCap`（preset 用音色清单长度、design/clone 用 `VOICE_CAND_CAP`），
    按钮文字「一次出 N 张」与提交时的 `count` 都从同一个函数来；按钮写着 3 张、型号只出 1 张就是骗人。
    ② **生成中要占位、但入口不能消失** —— 占位格一律 `D.Cast.waitHTML(那句进度)`（`'fill'` 档铺满缩略槽），
    而那一排里那颗触发生成的按钮在生成中**照样画出来、只是 `disabled`**：整排只剩一个转圈，看着就像「出候选的入口没了」
    （`picCandsHTML` 的 `o.tail` / `voiceCandsHTML` 的 `o.waiting` 就是为这件事留的口子，页面别再自己拼一排）。
    ③ **新一轮的候选排在前面，已经挑中的那张不被下一次生成顶掉**（`drawPreview` / `drawCharAsset` 只在没有时赋默认值，
    新的批一律进 `faces` / `assetCands[kind]` / `voiceCands`，由 `mergeCands` 去重 + 按上限裁）；
    挑一张走「用这一张 / 用这一条」，只换本机已有地址、不过生成闸门。
    **`design` / `clone` 那一位不给「用这一条」**（`voiceCap().pickable` 为假 —— 挑哪条都不改变以后拍出来的声音，
    摆一颗点了什么都不换的按钮比不摆更糟），并在排里写明为什么不能挑。
  - **「这一项正在生成」的账要按「哪一份素材的哪一项」记**（两页同一套：`GEN` Map + `gKey(kind, id)`）：
    预览图 `face#id`、每一类设定图 `asset#kind#id` / `acand#id/kind`、声音候选 `voicecands#id`、试听 `voice#id` ——
    同类连点两次拦下（`genWhy` 那句「不用再点一次」），不同类并发照旧放行。
    底栏那句话与格子里的占位**读同一份记录**（`genMsg`），页面不要再各编一句。
    闸门还要在 DOM 上露面：正在出的那颗按钮 `disabled`，只靠 JS 拦 = 用户点了没反应、看着像坏了。
  - **「拍的时候真的发出去哪些素材」与「界面上声称会自动带哪些」必须同一份**：`Drama.Pipe.planMaterials(drama, shot, model)`
    （脸 → 手挑参考图 → 三视图按 `reference_image.max` 补位 → 超上限写进 `notes`；音频按 `reference_audio.max`、说话人优先）。
    右栏的芯片与 `notes` 就是渲染这同一个返回值；**拍摄路径 `buildEntries` 也用它** —— 写成两份，界面就会说「会自动带上」而实际没带。
  - **字幕不是视频平台生成的**（那边出的片子不带字幕）：台词由 `Drama.Subs` 按每句配音的**真实时长**排成字幕轨，
    预演时叠在画面上、导出时交给本机 ffmpeg 烧进去（`/render` 的 `clips[].subs`）。
    写 `/render` 的字幕时要守三条：
    ① `clips[i].subs` 的时间**相对该段起点**，绝对偏移由代理用 ffprobe 量真实时长累加（客户端自己加会漂）；
    ② 字幕滤镜给的是**整条 `-vf`**，不能带前导逗号（`-vf ",ass=x"` 会被当成空滤镜，报 `No such filter: ''`）；
    ③ ASS 路径用**相对代理目录**的相对路径（Windows 绝对路径的盘符在滤镜里要转义成 `C\:`，实测读不到文件），
       `runFfmpeg` 因此固定 `cwd: __dirname`。
  - **配音也进成片**（和字幕同一套约定）：`clips[i].voices = [{ src, start, dur, vol }]`，
    `start` 同样**相对该段起点**，代理把每句按 `start` 延迟后与该段原声混成一条统一规格的音轨（`buildClipAudio`）。
    写这一段时守四条：
    ① `amix` 必须带 `normalize=0` —— 默认会按输入数把每路音量除下去，配音越加越小；
    ② 混完要 `apad` + `atrim` 到本段 span（句子之间的空隙、最后一句拖出段外都要按画面长度补齐/截断）；
    ③ 短剧的台词是逐句合成的，所以 `clips[i].volume` 传 0 压掉视频平台自己生成的人声（两路人声叠一起既听不清也串味）；
    ④ 只要有配音，**每一段都要铺音轨**（没原声就垫 `anullsrc` 静音底）。以前是「所有片段都有音轨才保留，
       否则整片静音」，一段有声一段无声就会把配音整段抹掉。
    ffmpeg 的参数顺序：**全部 `-i` 必须排在输出选项（`-vf`/`-c:v`/`-map`）之前**，推错位置报的是
    `you are trying to apply an input option to an output file`，很难一眼看出。
    配音文件是 `/local-assets` 存的本机资产（`la_xxx`），`resolveSrc` 要先查本地表再走上游换签名链接 ——
    本机 id 上游查不到，而且正则只认 `[A-Za-z0-9-]` 会把 `la_xxx` 截成 `la`。
  - **拍完不做任何自动判定（2026-10 去掉质检，别再加回来）**：一条片子像不像那个角色只有用户自己看得见，
    让文字 AI 识图打分给的是一句没人能核对的结论；声音与台词更没得判 —— 配音就是用该角色音色逐句合成的、
    字幕轨按这些配音的真实时长排，没有听辨模型就别假装能听出台词念错没。去掉它以后 take 只有两种结局：
    `done`（出了画面）/ `failed`（平台报错、素材没送上去、用户不等了），`failed` 就是没画面，
    所以详情块里**不给「用这一条」**（那是死代码）。
    由此带来的连锁也都改了，**别把旧描述抄回来**：右栏「自动/手动」开关删除（它唯一的作用就是「质检不过就重拍」，
    与「不自动重试花钱动作」直接冲突），拍摄循环里没有自动重拍出口，失败即停、只有用户自己点「再来 N 次」才连拍；
    `take.state` 不再有 `'qc'` 这一站。**老数据必须迁移**：`fixTakes(d)`（`list()` 里调）把停在 `state:'qc'` 的条目归一 ——
    有画面的落 `done` 并自动选中，没画面的落 `failed` 并写明原因。不迁移的话它们会被 `runningTakes` 当成「还在跑」，
    每次刷新白问平台一次，界面永远停在「质检中」。现在 `prereqs` 是唯一一道「配齐了才准花钱」的闸门
    （以前还有一道拍完才判的，那是钱花完才判）。
  - 台词的**结构检查**（漏句、空句）还在，但长在 `prereqs` 里 —— 开拍前就拦，不在拍完之后判。
  - 预演是「开头画面 + 配音 + 字幕」在**本机实时合成**的（不生成视频）；真正出片才调视频平台。
  - **音色不许自己编**：可选音色现读注册表（`Drama.Pipe.voices(REG)`：模型 `options.voices` → `prov.tts.voices`），
    没配语音平台就明说「还没配语音接口」，别摆三个假的「声音 1/2/3」——
    编出来的 id 平台根本不认，要到提交时才报错。试听走 `Drama.Pipe.previewVoice`，**与正式配音同一个 `ttsOnce`**，
    参数完全一致（免得「试听听着是 A、拍出来是 B」），并且先问一句「会合成一小段」。
  - **角色身上存的音色 id 要按当前型号现校验**（`Drama.Pipe.voiceOf(REG, drama, char)` → `{id, stale, list}`）：
    换过语音平台、或平台改了音色名之后，`char.voice` 存的是这一型号清单里没有的 id —— 直接发过去要么被平台静默换嗓子、
    要么提交才报错。`dubLine` 与 `previewVoice` 都只取 `voiceOf().id`（清单里没有就退到第一个），
    `stale` 为真时界面必须写明「存的「X」不是这个型号的声音，这次按「Y」念」—— 悄悄换掉不说，用户听到的和看到的就对不上。
  - **「这一位角色的声音从哪来」是**逐位**决定的，不是整集锁一种方式**：这一家支持哪几种由 `Drama.Pipe.ttsWays(REG, opts)`
    现算（`preset` → `voices()` 那份清单；`design` / `clone` → 声明了 `ttsMode` 的那个型号，没有就 `null`），
    **界面那一排芯片与 AI 的可选项都只列真有型号的**。`Pipe.assignVoices`（按钮受设置项 `dr_ai_voice` 闸，
    关掉时按钮 `disabled` 并把原因写进 title）按人设/外貌/有没有本人参考音频逐位回 `{name,way,voice,note}`：
    有本人参考音频的走复刻、其余走出镜描述、这一家没有描述型号才退预设。**降级必须当场做完并说出来**
    （AI 说 clone 但这位没有参考音频 → 现在就改成 design/preset，别等 `ttsOnce` 抛错）；
    方式落在 `char.voiceMode` 上由 `voiceWay` 每次现校验，结果小结就地摆在按钮下面（不开弹窗、不跳步）。
  - **型号下拉是按平台分组的二级菜单**（`Drama.Pipe.modelGroups` / `modelSelectHTML`，和生成工作台同一套）：
    `<optgroup>` 是平台名、option 文字是型号原始名。别在页面里把「平台 · 型号」拼成一个字符串 ——
    那样两家有同名型号时选不回来，`value` 也成了一个要再拆的复合值。
    **生成工作台的 `value` 例外地是 `provId::modelId` 这一个复合值**（`studio.html` 的 `renderModelOptions` / `pickOf`）：
    原因只有一个 —— 三种类型共用一个下拉、每种类型各自记住选中的型号，**只存型号名的话「自动换到支持某槽位的那家」
    会静默选不回来**（`img-2-5t` 在两家都叫这个名字）。分隔符固定 `::`、只在一个函数里拆一次；
    option 文字仍然只写型号原始名（平台名在 optgroup 上）。别「顺手简化」回纯型号名。
  - **批量拍摄按**场景链**调度（`D.Pipe.chainPlan` 读文字 AI 给每段写的 `link`）：
       · `link=auto` 的段串成一条链 —— 后一段要等前一段拍完才取得到它的最后一帧，所以链内串行；
       · 链与链之间没有依赖，一次并发 `PARALLEL_CHAINS` 条（画幅/场景不同的那些段就同时拍）。
     首尾帧接续只有一条实现：`Pipe.takeLastFrame(drama, shot, take)` → `take.linkFrame`（本机资产地址）→
     `buildEntries({firstFrame})`，页面只提供「哪一段」和进度文案，别在页面里自己抽帧或自己排队。
     **整条链要留在调度表里**（循环里跳过已选定的段，而不是把已拍的段从链里抽掉）—— 抽掉之后「上一段」就接错了。
     已选定画面的段跳过；重拍某一段请用它自己的「拍这一段 / 再重拍」。
  - **台词的说话人有两个字段，必须一起写**：`lines[i].who` 是给字幕和提示词看的**名字**，
    `whoId` 才是配音找音色的**凭据**（`dubShot` 按 `id` 匹配，避免同名不同人共用音色 —— 剧本里两位「阿May」）。
    只改 `who` 的表现是「台词看着换了人、念出来还是原来那个角色的嗓子」，而且界面看不出异常。
  - **这一页不做任何与钱有关的界面与记账**（`Drama.Cost` 已整块删除，别再写回来）：估价、单价、花费明细、币种换算
    都不出现，平台回执里带价格字段也不解析、不显示。文案里不要出现「花了多少」——
    曾经留过两处「每一次都记在『这一段花了』里」（自动模式 title、重拍提示），模块早就没了、承诺还在界面上。
    要说次数就写「每一次都会单独留在拍片记录里」。这条只管**界面与文案**（README 的短剧那几段也照办：
    说「不占一次生成 / 不用重拍」，不写「不花钱」「最贵的浪费」「按秒计价」）——
    代码注释里解释「为什么不能重复提交」（会重复扣费）该说还是得说，那是给改代码的人看的。
  - **台词秒数与段时长：一份估算，一处显示**（`Drama.Pipe.lineSec(sh, take)` / `shootFields().caps`）：
    「这一段拍几秒」的档位吸附按字数估（`estLineSec`），右栏那句「台词含收尾约 X 秒 · 这一段拍 Y 秒」优先用
    **真实配音时长**（`take.lines[].dur` 是合成回来的），没配过音才退到字数估并写明「按字数估」。
    两条都必须来自 `estLineSec` / `lineSec` —— 页面自己数一遍字就会和选档位算出的不是同一个数（原来 h2 与提示条就是两处各算）。
  - **这一页的设置项只在 `Drama.SET` 点一次名**（键统一 `dr_` 前缀：整集时长目标、两个 AI 自主权开关、
    做下一集默认沿用范围）：入口页与角色卡上的文案、**真的发给文字 AI 的那份参数**、设置页那张卡
    （`renderDramaSet` / `saveDramaSet` 照这张表渲染，不写控件、不写默认值）、助手 `writableKeys` 的白名单、
    `DataSync.SYNCABLE` 与设置页 `EXPORTABLE` 里的 `'dr_'` 全读它。抄第二份键名就会出现「界面说会、其实没发」
    和「设置页有、助手说改不了」。分钟那个输入框**不要写 `max`/`min` 数字** —— 上下限归 `durationBounds` /
    `durationFromMinutes` 一处夹（那是视频平台声明的事，见 §2）。
    `RESET_KEEP` 只留折叠面板的开合（`dr_adv_open` / `dr_story_open` = 界面偏好），其余 `dr_*` 跟着「恢复默认」清掉。
    **数值项的单位与步长跟着声明走，谁都不许写死成「分钟」**：表里既有把单位写进 `label` 的（整集时长（分钟）、
    没给 `unit`），也有单给 `unit` 的（`maxTakes` 的 `unit:'次'` + `step:'1'`）。设置页只在 `it.unit` 存在时画单位、
    步长读 `it.step || '0.5'`，助手那句说明按 `it.unit` 与 `it.hint` 拼 —— 写成固定的「单位是分钟」就会对着
    「每段最多重拍几次」说错话，界面上也会出现「重拍几次 ［3］ 分钟」。
  - **整集时长是用户自己写的分钟数（自由输入，常用档做成芯片），AI 可以改但要说清是谁改的**：`{duration}`
    进拆剧本指令，`normalizeScript` 只在 `dr_ai_dur` 开着、AI 回的秒数落在声明区间里、且与用户那个不同才采纳，
    同时把用户那一个留在 `opts.durationAsked`、打上 `durationBy:'ai'`；底栏那句（`durTarget`）必须报得出两个数
    ——「AI 定的 3 分钟（你写的是 2 分钟）」，不能悄悄改。界面按分钟、数据里一律存秒，换算只有
    `D.durationFromMinutes` 一份（页面不许再自己乘 60，两处各算就会出现两个不同的数）。
  - **画幅 / 分辨率 / 单段时长按**视频模型自己声明的取值**来**（`Drama.Pipe.videoChoices` / `videoCaps` / `shootFields`）：
    两家视频平台声明的是 `resolutions: 480p/768p/960p/1080p`、`durations: [4, 15]` ——
    页面写「720p · 每段 8 秒」是骗人，那两个值平台**根本没声明**。所以下拉本身也按声明渲染
    （**不要**在 drama.js 里写死一张 RATIOS / RESES 表），并且要能**切换视频模型**：换模型，下拉跟着变。
    三个容易踩的点：
    ① 吸附要在**两边都取出数字**再比（`'720p'` 直接减会得到 NaN，sort 比较器返回 NaN 等于不排序，
       结果所有档位都被吸到列表第一项 —— 实测 960p/1080p 都被吸成 480p）；
    ② **台词装不下时要往上调**：只按「离 wantSec 最近」吸附会吸到**更短**的一档
       （8 秒吸到 4 秒，而这一段的台词要 6 秒），把话说一半砍掉。正确做法是选**装得下的最小那一档**；
       台词比最长的档还长时在右栏明说「拍出来话会被截，拆成两段或者改短」。
    ③ 画下拉时**取键要看清单项给的是 `id` 还是 `key`**：视频模型那一组给的是 `key`（模型名带斜杠），
       渲染函数只认 `x.id` 的话，每项的 value 都成了 `undefined`，选了也不生效。
  - **角色来源（「全新角色 / 从素材库选」）要真的生效**：`opts.roleSource` 由 `Drama.applyRoleSource` 消费 ——
    拆完剧本后对每个角色去库里找**同名的**那一位，把脸 / 音色 / 资产整体拷过来；库里没有的照常画，
    并在「认角色」那一步明说谁对上了、谁没对上。`Lib.pullInto` 是**同名合并**而不是新增
    （库里的小雅拉进来会拷进这一集已有的那位，不会变成「短剧里有两个小雅」）。
  - **「从素材库选」要能让用户点名，不能只是把整库倒给 AI**（2026-10）：以前那个下拉选中之后只是把
    `roleSource` 翻成 `'lib'`，然后**整个库**都列给 AI 让它自己认名字 —— 库里攒到几十条以后，
    候选是一大锅、挑谁全凭剧情，而用户在入口页明明知道自己要用哪几个，界面上却没有一处能让他说这件事。
    现在入口页多一颗「挑角色 / 挑角色组」，用的是**第 2 步那个素材库框**（`openLibPicker({pick:true})`，
    同一套 `.ap-grid` / `.ap-item` / `PickSel`）—— 拆成两份就等于这个框有了两副面孔。
    数据落在 `opts.libPick`（存 lib id），判据**只有一份**：`Drama.libFor(drama)` / `Drama.libPickOf(drama)`，
    `castNote` 与页面上那行摘要都读它，页面**不许照着 `curLibPick` 自己再数一遍**（两处各数一遍就是
    「框里勾了 3 个、下面写着 4 个」）。四条约定：① 空 = 不点名 = 整个库（保持旧行为）；
    ② 点名的 id 在库里没了就当没有，**不退回整个库** —— 悄悄换一批人正是「界面上写着 A、实际发出去的是 B」；
    ③ id 两边都是**字符串**口径（`libPickOf` 是 `.map(String)`，页面比 `live` 集合也要 `String(c.id)`），
    用数字集合去 `has()` 字符串 id 会一个都命不中；④ **点名得能反悔**：0 勾选时主按钮仍可点，
    文案是「清空点名 · 用整个素材库」（不然点名就是个单向门 —— 切到「全新角色」再切回来只清草稿那份，
    带不走 `curLibPick`）。入口页这一按是**提交**，所以交回名单后**关掉弹窗**（第 2 步「加入这一集」不关，
    那边要连着拉好几组）；关闭前那句 toast 不能省 —— 模态开着时入口页那行摘要被 top layer 的 backdrop 挡着，
    toast 又在 `body` 上压不过 top layer，不给回执就是「点了没反应」。
    分组芯片原来只切筛选，所以额外加一颗「勾上 / 取消这一组」开关，「选角色或角色组」的「组」那一半才算做了。
  - **素材的类型只认 `kind`，卡片上「已在本集」的判据要和 `pullInto` 完全一样**（2026-10-04 端到端探针查出来的两条）：
    ① `libKindOf` 以前先按字段形状猜（有 `desc`/`time` 而没 `look` = 场景），而 `Lib.save` 会把没填的字段写成
       `undefined` —— `Store.write` 是 JSON 存盘，**undefined 的键直接被丢掉**，于是「一条还没写过外貌的角色」
       存进库再读回来就"没有 look"，被认成场景：「加入这一集」把角色塞进 `drama.scenes`，
       而「同类型 + 同名才算重复」那道拦截跟着失效（库里能攒出两条一样的角色）。
       现在库条目上存过 `kind` 就照它判（只有剧侧那些 AI 拆出来、没带 kind 的对象才退到按形状猜），
       并且 `Lib.save` 的字符串字段一律落 `''` 而不是 undefined —— **存储层里任何"这个键在不在"的判断都不能靠形状**，
       因为 JSON 往返本身就会改形状。
    ② 挑选器卡片的 `inEp` 以前只比 `libId`，于是库里那位「小雅」写着本集没有、点加入却只是并过去、
       并不多出一个人 —— 卡片说的话与真会发生的事不一致。判据必须也是「先 libId，再同名，且角色与场景各查各的名单」。
  - **`staleIn` 要把「本集存了什么进库」和「它查了什么」对齐**：`chars.html` 是**就地编辑**，
    写的是 `drama_chars`、不碰这一集的 `dramas` —— 用户在库里给「小雅」换了脸、给「河岸」改了描述，
    回到拍短剧看到的还是旧的那一份、拍摄时用的也是旧的。`Lib.staleIn` 就是那道提示条的判据。
    它原来**只遍历 `drama.characters`**，而 `adoptAll` 存进去的是**角色 + 场景两类**、提示条也摆在两者之间 ——
    场景在库里改了永远没人提醒。判据用一张 `PAIRS` 表（`[显示名, 库侧怎么取, 剧侧怎么取]`）配 `scan()` 双扫：
    角色查 `预览图 / 外貌 / 音色 / 音色描述 / 参考音频`，场景查 `预览图 / 描述 / 时段`。
    库侧**永远是 `face` / `look`**，剧侧角色也是、只有场景是 `img` / `desc` —— 这处不对称只写在 `PAIRS` 里换一次。
    只比**会真的影响拍摄**的字段，库里那个字段为空时**不算不一样**（否则清空一条会永远报「不一样」）。
    **加一类可入库的东西，记得给 `PAIRS` 补一行。**
  - **「做下一集」必须当场建好、并且被下一步真的用上**：`Confirm.choose` 先问沿用范围（角色+场景 / 只角色 / 全新，
    默认值取设置项 `D.nextInherit()`），然后 `newDrama`（`opts.nextOf` 指回上一集）拷角色与场景的引用、
    对 `libId` 存在的那些**回读素材库里最新的一份**（外貌 / 音色 / 参考音频 / 资产可能上一集又改过），
    `setActive` 后回入口页并把这一集记在 `nextDraft` —— 「开始」落在它上面拆分镜，`castNote` 那份
    「已经定下了这些人和这些场景」才真的喂给文字 AI（AI 照同名往下写 → `normalizeScript` 复用那一张脸、那一个声音）。
    踩过：只做「拷好角色、停在认角色等人重写故事」，而新建动作在「开始」里 —— 拷过来的那批成了孤儿，
    界面写着「接着用」而实际另起了一部。入口页那条「下一集已经建好」还要同时给「不要它，另起一部」的出口，
    否则人看到的是空输入框、列表里莫名多了一集。
  - **导出前要能看见「进不了成片的段」**：`Drama.Pipe.edlCheck(drama)` 返回 `{clips, missing}`，
    `render()` 见 missing 直接抛错、页面在点导出**之前**就把缺哪几段、为什么摆出来。
    别静默 `continue` —— 那样成片少了那几段、而下载的字幕里还留着它们的台词，字幕和画面对不上，
    比直接报错难查得多。
    这道拦截**只在 `exportFinal` 里做一处**：以前底栏按钮自己弹一次、`exportFinal` 里又判一次，
    两份实现两套说法（其中一份的「去拍」还把步数写成跳到第 4 步，其实该回第 3 步）。
    `renderSpec` 也要**同一次扫描**把 `clips` 和 `missing` 一起带出来 —— 以前它只给 `clips`，
    `render()` 去读 `spec.missing` 必然 `undefined.length` 当场 TypeError，点导出看着像按钮没反应。
  - **成片里要不要配音 / 字幕是每集的两个开关**（`drama.opts.dub` / `drama.opts.sub`，默认都要），
    底栏第 4 步画两颗 `.tool` 芯片（`exportToggles`）。它们**只裁送给代理的 EDL**（`edlCheck` 是唯一出口，
    代理只认 EDL），**预演与下载的 SRT 一概不受影响** —— 预演始终是画面 + 配音 + 字幕，SRT 始终是完整台词。
    **关掉配音时必须把 `clips[].volume` 放回 1**：`volume: 0` 本来就是专门为逐句配音压掉平台原声用的，
    再压着就是一条又没配音、又没原声的哑片（那不是任何人想要的）。
    导出按钮的 `title` 由 `edlWhat(cur, nv)` 现算（这次到底带配音还是平台原声、烧不烧字幕、有没有配乐）——
    写死「N 句配音会烧进成片」在关掉开关后就成假话了。
  - **步骤之间要守顺序**：讲故事 → 认角色 → 看预演（出完预演落在这一步）→ 拍成片。
    「开始拍」在第 3 步；出完预演直接跳第 4 步，就等于既没让人看预演、也按不到开始拍。
    换步统一走 `enterStep(no)`（顺带做前置条件重判），别在各处裸写 `cur.step = n; render()`。
  - **第 1 步那块转屏只在真有拆分在跑时才摆**：`render()` 里 `cur.step === 1` 要分两种 ——
    `genHas('split')` 才走 `renderBusyStep()`，否则走 `renderRewound()`（照实说「已经拆过了」+
    只读展示故事原文 + 一颗「回到第 N 步」按钮，按「拍过→4 / 有分段→3 / 有角色→2」推导）。
    踩过：`cur.step` 早就存了盘，从第 3、4 步点回「1 讲故事」看一眼 → 摆一块永远转不完的假转屏，
    底栏在第 1 步是 `hidden`、「停下」又要求 `step >= 2`，**除了再点一次顶栏没有第二个出口**，
    刷新也回不来（每次打开都落进这一屏）。两处配套：步骤栏回退到第 1 步先弹确认框
    （说清「不会被重新拆一遍」）；`renderRewound` 里**刻意不给「重新拆剧本」那个按钮** ——
    那是花钱且会整份换掉角色/场景/分段的动作，放在「我只是回来看一眼」的页面上太容易误触。
    同理 `newShot` 的第 1 段守卫：位置要显式传（`at: 0` / `at: i + 1`），
    只靠 `o.no` 的话 `duplicateShot` 的副本（建的时候还没有段号）会被当成第 1 段、接帧被收成 `off`。
  - **「一句话让 AI 改这一段」**：参考产品那句话（image10）是个输入口 + 「改」。
    它只改**开头画面描述与镜头描述**，台词/角色/场景不许动（改完可以直接重拍这一段）。
  - **机位要连景别与运镜一起给**（`CAMERAS`：固定镜头 / 缓慢推近 / 缓慢拉远 / 手持跟随 / 固定特写 / 过肩 / 俯拍）——
    机位直接进视频提示词，只写个词平台听不懂；`desc` 里**别再重复 id**（拼起来会变成「缓慢推近，缓慢推近，景别…」）。
  - **段内生成只走 `Drama.Pipe` 那一个入口**（开头画面 `drawOpen`、定妆照 `drawFace`、场景 `drawScene`、
    配音 `dubShot`、拍摄 `shoot`）：页面的按钮 handler 只调它和写 busy 文案，选中的型号 / 画风全在里面按 `opts` 现取。
    踩过：`drama.html` 的 `paintOpenImg` 自己拼一份 `AiGen.image`，既不看 `opts.imgModel` 又用写死的 `opts.style`，
    于是入口页高级设置里选的生图型号根本不生效。
  - `UiDialog` 的 `body(el, close)` 里要用关闭函数就**用它传进来的第二个参数** ——
    `onOpen` 是在 `body` 之后才调的，在 `body` 里引用 `onOpen` 里定义的东西会直接 ReferenceError。
  - **别让一个「看着能点、其实什么都不做」的控件留在界面上**。这一轮清掉三处：
    ① **拍片记录那排按钮在某些路径下根本没绑事件** —— `renderTakes` 整块换掉 `#takeBox` 的
    `innerHTML`，新节点的 `onclick` 是空的，而那几个按钮（⬇ / 不等了 / ✕ / 再重拍一次）全靠
    `bindSideCtl` 统一接线。`renderSide` 本来是「先 renderTakes 后 bindSideCtl」所以没事，
    但另外两条路不是：`paintShotState`（每次进度回调 `sayShot` 都走）只调 renderTakes；
    `refreshShot` 是 `paintSlots`（里面刚绑过一次）→ `renderTakes` 又把节点换掉。
    于是**每拍完一条、每次进度刷新，那几个按钮都是死的**：点第一下没反应（点击冒泡到外层
    `[data-ti]` 那一行 → `renderSide()` → 这才重新绑上），**第二下才生效** ——
    正是这个项目反复踩的「画得好好的、按钮是死的」。修法是在 `renderTakes` 末尾补一次
    `bindSideCtl`（**不是**在里面另写一份绑定），这样任何重建这一列的路径都必然绑完。
    ② 「结尾」槽位（`sh.endImg`）：能选、能存、扛得住「复制写法」，但 `buildEntries` 只 push
    `first_frame`、`planMaterials` 也只认 `startImg` —— **没有任何消费方**。平台有没有「末帧」
    这种输入 role 得看它自己的 `/models` 声明，没声明就不能硬塞字段（会被拒），所以改成照实说：
    title 写明「目前只存在本机，还没有发给视频平台」，并说想控制结尾靠开头画面描述与台词更直接。
    ③ `opts.quality`：从没有写入点，却每次拍摄都当 `quality: ''` 发出去；`Api.createBody`
    会把空串丢掉（`v !== ''`），所以它**从来没到过平台** —— 一个看着像「画质档」其实什么都不做的字段。
  - **「同一件事只能有一份判据」要连「产物有几种给法」也算进去**：`shoot` 与 `resumeTake`
    都要把上游产物转成本机可播的地址，而产物有三种给法（外链 url / 本机直链 src / 资产号 assetId
    —— SparkCine 的产出是资产 id、**没有** url）。原来 `shoot` 认全三种、`resumeTake` 只认前两种，
    于是**断点续拍接回来一条平台已经做成功、钱也已经扣掉的活，拿到的却是空地址**：
    段条写「✓已选用」、播放器全黑，导出还报「选用的那一条没有画面（可能上次没拍完或素材丢了）」，
    用户看到的是「这一段白花了」。现在收成 `takeVideoSrc(it)` 一份，两处都走它。
  - **「还在跑」这种判据，页面与数据层必须逐字对齐**：数据层 `Shots.dropTake` 与 `runningTakes`
    都带 `&& !t.abandoned`（用户按过「不等了」就该放行），页面 `delTake` 的前置检查原来漏了 ——
    于是弹出一句自相矛盾的话「第 N 次还在拍（不等了），等它有结果再删」，而它**永远等不到结果**，
    那颗 ✕ 从此一直按不动。少一个 `&&` 就多一颗永久失效的按钮。
  - **死代码照样要清**：零调用的 `paintBottom`、定义了并导出但**外部零调用**的
    `pickImageProv` / `pickTtsProv` / `pickModel`（`listBroken` / `Shots.resequence` 相反 ——
    内部还在用，只是不该再挂到导出面上，函数必须留）、7 条无人引用的 CSS。
    判断「有没有人用」要**跨全项目** grep，别只看本文件。
  - **判据要落在行为与顺序上**：这一轮的自检里，「查 `preselect` 这个词出现过没有」曾长期全绿 ——
    而那段代码写在 `UiDialog.open()` **之后**，而 `open()` 会**同步**调 `body()`
    （`ui.js`：`o.body(body, close)` 就在 `open` 返回之前），于是预选一次都没生效过。
    改成断言「预选计算的位置 < `UiDialog.open` 的位置」才抓住。
    同理，每写一档判据都要**逐条破坏一次**确认它真会红；破坏脚本必须先断言文件**真的被改了**
    （PowerShell here-string 配 LF 文件会静默落空，于是「负例没红」其实是补丁没打上）。
  - **同一个问题只能有一个判据，落地处超过两处就收成一份**：短剧这一轮连踩三次同一形状 ——
    「这一句是谁在说」曾经有**三套**：`lineSpeaker`（先 `whoId` 再按名字）、`dubShot`（只认 `whoId`）、
    `prereqs`（只认 `whoId`），于是右栏写着「琪琪」、发出去的是旁白的嗓子，而前置条件全绿。
    现在全部走 `Pipe.lineSpeaker`。「这一段要用到哪些角色」（`usedCharsOf` = 出场名单 ∪ 每一句的说话人）
    也只有一份。以前 `prereqs` 与质检的「声音」那项**各读各的**：前置条件看说话人、质检只看出场名单，
    于是把某句改派给一位不在出场名单里的角色，前置条件会拦、质检却放行 —— 一条判据漏人不漏话，
    另一条漏话不漏人，谁也没发现。质检去掉后 `prereqs` 是它唯一的读者，但**这条教训留着**：
    同一个概念在几个地方被独立实现，就是这一类。
  - **别把 AI 写的换成「一个看起来差不多的」**：`normalizeScript` 以前对段引用的场景名查不到就落到
    `scenes[0]`、对表外的时段一律改成「深夜」，提示词与界面上显示的都是另一件事；
    而 `linkSource` / `chainPlan` 又拿 `sceneId` 判接不接帧，一句没说清的话就把整条链改了。
    场景名查的是**三级**：完全相同 → **互相包含**（AI 写「暴风雨」、场景叫「场景二：暴风雨」
    —— 这一级是必须的，只做精确匹配会多建一个几乎同名的场景）→ 都没有就**当场建一个**；
    名字真的是空才留空。时段照 AI 写的存，只有空才走兜底值，界面上相应要能显示它
    （见上面「每个 `<select>` 都得有兜底项」）。
  - **「选好了」这句话不许配一个空结果**：素材没取到字节来源时照样存成空串并弹一句「配乐选好了」，
    用户以为铺了配乐、成片里还是原声。成功提示的前一行先判一次「真的存进去东西了吗」。
  - 台词在右栏**逐句可改**（说话人下拉 + 文本框 + 增删）——字幕轨、镜头描述、配音与拍摄都按这份走。
  - **段落顺序与段号**：`edlCheck` / `renderSpec` 按 `drama.shots` 的数组顺序拼成片，`sh.no` 是显示用的段号。
    增 / 删 / 移一律走 `Drama.Shots`（`moveShot` / `duplicateShot` / `dropShot`，内部都会 `resequence` 把 `no` 重排成 `1..n`），
    页面不要自己改 `no`，也不要只改 `no` 不动数组（那样界面与导出顺序不一致）；
    三个函数按 **shot id** 定位并返回改完后那一段的数组下标，页面的 `shotIdx` 必须按返回值改回去
    （`shotIdx` 是下标，不是身份，删一段会让它指错段）。
    `duplicateShot` 只带写法（画面描述、台词、镜头、参考素材），不带 `takes`。
    `dropShot` 只清这一集里的引用，**不删 `.assets` 里的资产文件**；该段有未到终态的 `taskId` 或正在生成时，
    确认框必须写明「本机不再认领，任务还是在平台那边跑完」。
  - **点一次「拍这一段」只发一条任务，不自动重试**：拍完不再有任何自动判定（见上面去掉质检那条），
    失败即停，把「再来 N 次 / 改台词 / 换平台」的决定权交回界面。右栏原来那个「自动 / 手动」开关
    （`opts.shotMode`）已经**删掉**，别再做回来 —— 它唯一的作用就是「没过就自动重拍」，
    而那与「不自动重试花钱动作」直接冲突。用户主动点「再来 N 次」的上限仍是 `maxTakes`。
  - 提交那一刻就把 `take.taskId` 写盘**，重新打开页面时 `Drama.Pipe.resumeAll` 拿它接着等
    （`boot()` 里调 `resumePending`）—— 这是「关掉网页也会接着拍」能落地的部分：
    活交给平台跑，本机只负责等，**不重新提交**（重新提交会重复扣费）。
    两个容易踩的点：
    ① 没有任务号的 take（画面已经在本机，`state` 已是 `done`）不该被 `taskId` 检查挡住 —— 
    别把这个检查写在「有没有画面」的前面；
    ② 续拍的等待要有上限（`RESUME_WAIT_MS`，2 分钟）—— `waitVideo` 本身是给「正在拍」用的 15 分钟长等，
       拿它做续拍会在平台持续报错时对着一个长循环干等用户。
  - **配乐混音是代理的活**，页面只管选哪一段（`opts.bgm`）：`/render` 会把它自动循环铺满整集，
    并把原声压到 0.35 与它 `amix`。别在页面里自己合成。
  - 静态服务（`proxy.js` 的 `MIME` 表 + 扩展名白名单正则）**要一起放行音频与字幕**：
    少一个扩展名，本地 mp3 / srt 取回来就是 404 —— 表现是「配乐选了却下载失败」，
    而且报错发生在代理下载素材那一步，看着像素材本身坏了。两处都要改，只改 MIME 表不够。
  - **非上传素材要转 dataURL**：`reference_image` 模板是 `image_url:{url}` 的平台（VGENV）
    收的是**它自己能取到的公网地址**，本机的 `/getv?url=…` 回环地址它根本访问不到 ——
    发过去的表现是「参考图被静默丢掉」。生成工作台是这么做的（`studio.html` 的 `srcToDataURL`），短剧跟着同一套。

### 3.1 生成工作台 `studio.html`（视频 / 图像 / 语音合并成一页）

原来三个独立工作台（`video-gen.html` / `image-gen.html` / `audio-gen.html`）已合并成 `studio.html`，旧文件删除。
改这个页面（或再加一种生成类型）时守住这几条：

- **类型写在地址栏里**：`?t=video|image|audio`，`setType()` 用 `history.replaceState` 同步；
  `app.js` 的 `ALIAS` 让 `/video.html` 这类旧短名也带着 `?t=` 过来，`proxy.js` 的 `FILE_MAP` 把六个旧路径
  全指向 `studio.html`。类型还与 `localStorage studio_type` 互为兜底（URL 优先）。
- **每种类型各自记住型号与提示词**：型号存 `studio_pick`（**`provId::modelId`**，见上面那条下拉约定），
  提示词存 `studio_prompt_<type>`。三块参数面板的 DOM **常驻**、按类型显隐 —— 别改成「切走前把下拉值存一遍」
  那种双口径写法。
- **模型下拉按能力分组**：视频 / 图像用 `optgroup`（平台）+ 原始型号名；语音一次只服务一家
  （`audioModels()`），别让用户在一个下拉里跨平台选型号。
- **右栏是三类型合在一起的历史**：`AssetLib.load({kinds:['image','video','audio']})` 一次读全
  （含本机资产库来源），再与语音的本地记录 `Wb.History('audio')` 合并、按 `assetId` 去重；
  默认只看最近 30 天（只是显示过滤，不删数据），另有「查看全部」。
  `AssetLib.countAll` 三类一起数很贵，合并页封顶 `maxPages: 3`。
- **视频 / 音频卡片就地播放**：`mediaBox()` 出标记、`bindCardPlay()` 接线，两种类型合用一套。
  视频走 `Wb.thumbs.mediaHTML(src, { inline: true, videoAttrs: 'playsinline preload=metadata' })`，
  音频走就地 `<audio>`（**不要**加 `controls`）。点画面不打开灯箱，看大图走卡片上的「放大」。
  卡片网格是竖版（16:9 媒体在上），样式写在 `studio.html` 的 `#result` 作用域里
  （`ui.css` 的横版 `.task` 别的页面还在用，别去改它）。
- **inline 必须由 `workbench.js` 的 `thumbs` 层保证，页面管不了这三件事**（少一件就是「视频播不动」）：
  ① `mediaHTML` 的 inline 分支**直接输出 `src`**（静默模式那个 `<video>` 只是抽帧用的，只有 `data-src`，
  浏览器根本不会取字节 → 永远一帧黑屏），并打上 `data-thumb-play="1"`；
  ② `bind()` 据此记 `b.inline` 并**跳过 `_release`**（否则刚给的 `src` 被自己抹掉）；
  ③ `_show()` 对 inline **只设 `poster`、绝不把节点换成 `<img>`**（换掉就成了「第一次能播、刷一下就不行」）。
  另外有 `poster` 就立刻 `ready`，别等 `loadeddata` —— `preload=metadata` 下浏览器可能一直不取首帧。
- **播放键统一在媒体区左下角**（`.tplay`，34px 圆形），播放中淡出、hover 回来；
  音频卡另有一个大号音频符号 `.tbg` 做背景（不是空白占位）。
- **左栏素材槽的磁贴样式是 `ui.css` 那一份**（`.assets-grid` / `.asset-slot` / `.cap` / `.x` / `.blocked` /
  `.conflict` / `.rvthumb` …），与导演台右栏共用，`studio.html` **只管怎么排**：
  `#inputArea .assets-grid` 用 `repeat(auto-fill, minmax(132px,1fr))`（列数是算出来的，不是写死三列 ——
  `ui.css` 那条固定三列搬过来会把一个槽拉成 300 多 px 的巨砖）；一次只放一个素材的槽位
  （参考视频 / 参考音频 / 首尾帧）那一块加 `.span2` 横跨两列。**不要再自绘一套磁贴。**
  数量 / 类型 / 体积上限全部来自 `Capabilities`，点开就是公共 `AssetPicker`。
- **右栏类型分类是数据驱动的**：`kindOrder` + `kindTabs()` 按 `mtype` 现算分类与计数
  （选中的分类即使计数为 0 也保留），别写死「图片 / 视频 / 音频」。
- **右栏默认动态加载**：只读 `page_mode_studio`，`'page'` 才翻页、否则 `'more'`；
  **不要**从 `page_mode_video / _image / _audio` 迁移 —— 旧默认值会把「翻页」这个要改掉的默认行为带进来。
- **卡片可以拖进左栏当参考素材**：整张卡 `draggable`，载荷是本页自产的 `application/x-studio-ref`（JSON），
  同时兼容旧 `application/x-asset-id`；落到当前模型**能接收该类型**的槽位上，必要时先 `AssetTransfer.blobOf`
  取回字节再入槽。
- **「复用这次创作」**在详情面板里（`reuseInto`），配合 `?reuse=1` + `sk_reuse` 供资产库 / 收藏页跳转；
  按目标类型自动切栏，必要时自动换到支持该槽位的型号。
- 调试提示：这一页在 iframe 里，**浏览器控制台 / 网络面板只看得到外壳顶层**，页内报错很难看见。
  真要查就在页内临时挂 `window.onerror` 往 `PUT /data/<名字>` 写一份启动日志，**查完连代码带落盘文件一起删**
  —— 别把这种诊断通道留在正式代码里。

## 4. 密钥与用户数据

- **「读不出来」绝不等于「本来就没有」**：`ui.js` 的 `Store.read` 为了「别让一条脏数据卡死整页」，
  解析失败与「不是信封」都**返回默认值**。凡是拿读取结果当**写入底座**的地方
  （现在只有 `drama.js` 的 `put`：它 `list()` → 改一处 → `saveList()`），一次普通保存就会把
  「空列表 + 当前这一集」写回去，磁盘上还完好的其它记录整批消失，并随 storage 钩子同步覆盖 `.data/`。
  所以 `drama.js` 额外有 `listBroken()`：**再摸一次原始值**，非空而读出来是空 = 读坏了，
  此时 `put` 直接返回 `{ok:false, error}` 并**一个字都不写**（页面把这句话原样弹出来：
  「已停止保存，磁盘上原来的数据没动」）。新写「读出来 → 改 → 写回去」的地方一律照这个形状。
- **任务号一落盘就等于一次已付的钱**：短剧每条拍摄在提交拿到 `taskId` 的那一刻就写盘
  （中途关网页才接得回来，重新提交就是重复扣费）。所以
  ① 删整集（`remove`）与删那一次（`dropTake`）都要先看 `runningTakes` 里有没有还在跑的，有就拒并说清；
  ② 用户想放弃时给的是**「不等了」**（`Shots.abandon` → 按 registry 的 `cancel` 端点撤单，
  撤不掉就照实说「可能还在计费」），不是让人干等满 15 分钟或关页面；标了 `abandoned` 的
  `waitVideo` 下一轮收手、`resumePending` 也不再等它，但**任务号留着**（撤单失败时它仍真实存在）。
  凡是「提交出去就收不回来」的动作，删之前与放弃之后都要有这两条路。
- **存盘失败必须看得见**：`drama.html` 全页 89 处存盘点都走本页的 `save()`（不是裸 `D.put(cur)`）——
  撞到 localStorage 配额时 `Store.write` 返回 `{ok:false}`，而界面照旧显示「已保存」、
  用户改完一刷新全部丢失。新增存盘点一律走 `save()`。
- **本页是 `dramas` 的写者，就一定要订阅 `storage`**：不订阅的话，另一个标签页删掉的一集会被本页
  随手一次存盘 `xs[i] = d` 整份撤销（表现是「刚删掉的那部又回来了」「刚拍好的那几条不见了」）。
  `chars.html` / `favorites.html` 都有，只有拍短剧页漏了。storage 事件只在**别的**标签页触发。
- **异步的活儿要**抓住它自己那一集**，收尾时别再摸 `cur`**：`drama.html` 的 `resumePending`（续等，
  每条都有一轮超时上限，整轮可能好几分钟）与 `healTakeUrls`（外链回源）都是**开跑时把对象抓在手里**
  （`const mine = cur`），收尾一律 `saveOf(mine)`，且 `cur !== mine` 时不重画界面。
  否则用户在它跑的时候切去别的集（或回列表挑另一部），结束时 `save()` 存的是**新打开的那一集**，
  这一轮接回来的画面 / 配音整批留在内存里，刷新即没 —— 一次白等。
  **拍摄那三条长任务同样适用，而且更险**（钱已经扣了）：`shootAll`（批量拍）、`shootLoop`（单段重拍）、
  `toPreview`（出预演）、`exportFinal`（渲成片）现在都是开头 `const mine = cur`、一路 `saveOf(mine)`。
  以前它们用裸 `save()`（= 存 `cur`），中途按一次「‹ 返回」（`#btnBack` 只 `stopPlayer`，**不拦人**）
  再打开另一部，这一轮拍出来的 take / 画好的开头画面 / 渲好的成片就整批只留在内存里；
  `shootAll` 收尾那句 `cur.step = 4` 还会把**别人那一部**推进到「拍成片」那一步。
  收尾动界面（`enterStep` / `render` / `askStale`）一律先判 `cur === mine`。
  同步：新增长任务时留意自检项「长任务里没有裸 `save()`」。
- **台词与配音是**拍摄那一刻**的快照，改剧本改不到已经拍好的那一条**：`dubShot` 把每句真实的文本、
  音频与时间轴存进 `take.lines[]`，`Subs.takeSubs` / `takeVoices` / `lineSec` 一律先读那份快照。
  所以用户拍完再改 `sh.lines`，成片与下载的字幕里说、烧的仍是**原来那几句**，而右栏摆着新的。
  判据只有一份：`Pipe.lineDrift(shot, take)`（去掉空句之后 `(说话人, 文本)` 的序列对不上；分隔符用
  `U+0001` 而不是空串，空串会让「说话人 A + 台词 BC」和「说话人 AB + 台词 C」撞成同一条）。
  三处都要用它，别各写一遍：① 右栏台词区最上面那条提示（槽位固定在 DOM 里、由 `paintDrift` 填，
  跟着输入重画整格会把正在敲的 textarea 换掉、光标跳走）；② `edlCheck.warns` 里一条 `kind:'lines'`
  的告诫（**只报不拦** —— 这一段本来就能进成片）；③ `lineSec` 在漂移时**不能用真配音来量秒数**，
  否则「台词含收尾约 5 秒（按真实配音）」配着一屏新长出来的句子，
  「比平台最长的档还长，拍出来话会被截」那道闸永远不会响。
  `edlCheck.warns` 的每条仍带 `kind`（去掉质检后只剩 `'lines'` 一种，但别把字段删掉 ——
  底栏那两句提醒是**按 kind 过滤**的，当年共用一句「有 N 段选用了没通过质检的那一条」把两种问题说成同一种，
  而用户照那句话一段也找不到；将来再加一种告诫时，得在底栏另起一句，别塞进同一句里）。
  成片清单按段号累加告诫（同一段可以同时中两条），别按段号覆盖。

- **源码里绝不出现真实密钥**：`proxy.js` 不带默认 key，只从 `.env` / 系统环境变量 / 设置页取。
- `.env`、`.data/`、`prompts/`、`.assets/`、`.renders/` 都在 `.gitignore` 里，**不要提交**，也不要把里面内容贴到日志或回复里。
- 用户的工作区、历史、归档是用户数据：清理前先确认是测试残留，别擅自删。
- **端口不再固定 5175**：`proxy.js` 现读 `.env` 的 `PORT`（系统环境变量优先，都没有才退到 5175；
  `PORT` 那一行必须排在 `loadEnvFile(true)` **后面**，排在前面就等于 `.env` 里写的端口永远不生效），
  `启动.bat` 认同一个优先级并把**实际跑起来的端口**记进 `.proxy-port`（停止 / 重启 / 退出都按它关，只杀 node 的进程）。
  之所以要做成这样：Windows 的 Hyper-V / winnat 开机时保留走一段连续端口（本机实测 5174~6173 整段不可用，
  **5199 也在里面**），撞上报的是 `listen EACCES`，而 `netstat` 根本看不见那个号 ——
  「这个端口能不能用」只能真 bind 一次问系统（`启动.bat` 的 `:findfree` 就是这么挑的，往上找 8000 个不到一秒）。
  保留段每次开机都可能不一样，所以文档里的端口号只是「当时实测能用」的样本，绑不上就换一个。
  **改 `启动.bat` 要先在临时目录写成 UTF-8，再 `iconv -f utf-8 -t gbk` + CRLF 落回项目里**：
  这一个文件是 GBK（`chcp 936`）而其余文件全是 UTF-8，直接用编辑器写回去，每一行中文都会成乱码，
  而且 `node --check` 那类语法自查一行都报不出来（它不是 js）。
- **自动化 / headless 验证一律跑隔离实例，不要在真实实例上写**：`PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe RENDER_DIR=.renders-probe node proxy.js`
  起一份独立代理，测试脚本的 `BASE` 默认指向它。原因：浏览器侧每一次 `localStorage.setItem` 都会镜像成 `PUT /data/<key>`（last-writer-wins），
  而启动对账 `DataSync.boot()` 是异步的 —— 在全新上下文里跑真实实例，很容易把**加载前读到的旧快照**盖回用户数据上
  （2026-10-01 就是这样把收藏库从约 400 条写成 2 条，无法恢复）。
  只读检查（加载页面看有没有报错）可以在真实实例跑（端口问 `.env` / `.proxy-port` 要），但跑前先 `sha1sum .data/*.json`、跑后再比一次，确认没变动。
  **`ASSETS_DIR` 与 `RENDER_DIR` 也必须指出去**：`POST /local-assets` 的落盘目录默认是共享的 `.assets/`（`proxy.js` 的 `LOCAL_DIR`），
  探针造的一张 PNG / 一段配音会直接进用户的资产库，而 `.data/` 那两层保护（`.bak.json`、对账）都盖不到它；
  `.renders/`（`RENDER_DIR`）同理 —— 探针导出的成片会混进用户的成片列表（那里还带「只留最近 N 个」的清理，等于顺手删了别人的片子）。
- **代理侧覆盖 / 删除 `.data/<key>` 之前会留一份 `<key>.bak.json`**（`proxy.js` 的 `keepDataBackup`，最少保留 10 分钟，
  内容相同不留，`.bak` 自身不再备份）。它不出现在 `GET /data` 清单里，但设置页「数据与备份」能列出来也能一键还原
  （走 `GET /cloud/backups` + `POST /cloud/restore`，**不需要配置云**）。不要把 `*.bak.json` 加进同步或清单逻辑。
- **只服务本工作台页面的路由集中在 `proxy.js` 的 `LOCAL_ONLY`**（`/data`、`/prompts`、`/cloud`、`/capabilities`、
  `/local-assets`、`/save`、`/pick-dir`、`/env-status`、`/sys-status`、`/render*`，以及取回/转发类 `/getv`、`/fetch`、`/getfile`、`/s3put`）：
  跨站请求在 CORS 放行**之前**就被 403 拦掉，新增敏感路由记得加进这个正则。
  `/sys-status` 尤其要防：它会在本机**起子进程**（`ffmpeg -version`）并把三个落盘目录的绝对路径带回去。
  正则结尾的分隔符要同时认 `/`、`?` 和串尾（这几条路由都带查询串，只写 `(\/|$)` 会漏拦）。
- **两条「碰用户硬盘」的本机路由**（`POST /save` 往用户指定目录写文件、`POST /pick-dir` 弹系统文件夹选择框并把
  选中的绝对路径带回来）各有两条不能破的规矩，写之前先看一眼：
  ① **目录/路径只从服务端自己读到的配置来**，`/save` 请求体里带 `dir` 一律忽略 —— 认了它，这条路由就等于
  「任意本机网页往任意路径写文件」；`/pick-dir` 的返回路径是隐私，不进 `LOCAL_ONLY` 就是把用户目录送给任意网站。
  ② **`/pick-dir` 必须用异步 `spawn`，不许 `spawnSync`**：用户挑目录可能一两分钟，而 `spawnSync` 堵死事件循环，
  那段时间整个代理一条请求都答不了（拍片轮询、配音、抽帧全卡住），表现是「点一下选择文件夹，整个应用都死了」。
  子进程还要在客户端断开时收掉，否则屏幕上会留一个没人要的框。`.tmp-pickdir.cjs` 把这几条都做成断言了。
- 代理会把浏览器递来的 URL 取回/写穿（`/getv`、`/fetch`、`/getfile`、`/s3put`）：一律过 `guardOutboundUrl()` ——
  只允许公网 https，回环/内网/链路本地/域名解析到内网的写法（nip.io 之类）全部拒绝，别绕过它。

## 5. 改完必须自测

```bash
# 语法：proxy.js 与公共 js
node -e "new (require('vm').Script)(require('fs').readFileSync('proxy.js','utf8'))"
for f in ui.js assetlib.js workbench.js drama.js sidebar.js app.js ai-chat.js; do
  node -e "new (require('vm').Script)(require('fs').readFileSync(process.argv[1],'utf8'),{filename:process.argv[1]})" "$f" && echo "OK $f";
done
# 页面内联脚本（必须用 vm.Script：new Function 抓不到严格模式/全局作用域错误）
# 注意 re 要写在循环**里面**：带 g 的共享正则会把 lastIndex 带到下一个文件，
# 于是从中间切段，报出一堆「Unexpected identifier」的假语法错误（踩过）
node -e "const fs=require('fs'),vm=require('vm');
for (const f of ['index.html','drama.html','studio.html','assets.html','favorites.html','settings.html','usage.html','shell.html']) {
  const h=fs.readFileSync(f,'utf8'), re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m,i=0;
  while ((m=re.exec(h))) { i++; new vm.Script(m[1],{filename:f+'#'+i}); }
  console.log('OK',f,i+' 段');}"
```

- 改的是 `proxy.js`（不是 `.env`）→ **必须重启代理**才生效（`启动.bat` → 2 停止 → 1 启动；或杀掉 `.proxy-port` 上那个 node 后 `node proxy.js`）。
- 改完至少把页面各加载一次（`shell.html#…` 里逐个切：index / drama / studio（视频 / 图像 / 语音三种类型都要切一遍，
  `studio.html?t=video` / `?t=image` / `?t=audio`）/ chars / favorites / assets / usage / settings，
  外加直接打开 `drama.html` 与 `studio.html`），确认没有错误横幅、没有控制台报错、关键列表/下拉有内容。
- **`vm.Script` 全绿 ≠ 模块能加载。** 一天之内踩到两处，都是「删掉页面私有实现」留下的**裸调用**，
  语法检查一行都不报：
  ① `assets.html` 的 `onBatch` 里还在写 `mergeEntries(...)`（公共层叫 `AssetLib.mergeEntries`）——
  被 `Promise.allSettled` 吞成一句 warn，资产库照样画得出来，只是每次翻页都少一批结果；
  ② `drama.js` 的导出表写了 `healTakes`，而那个函数根本没落进去 → IIFE 在 `window.Drama = (…)` 那一行
  当场 `ReferenceError`，**整个拍短剧页是空的**，页面里所有 `Drama.*` 都是 undefined。
  所以删过 helper 就顺手扫一遍（结果应为空，`AssetLib.` / `Wb.` 前缀的调用不算）：
  ```bash
  grep -rnE "(^|[^.\w$])(刚删掉的名字)\(" *.html *.js | grep -v "^proxy.js:"
  ```
  再加一次「模块真的挂上了 window」的探针：在浏览器里 `typeof window.Drama.Pipe.healTakes === 'function'`
  （或把源码 `new Function(src)()` 跑一遍看抛不抛）—— 这一条只有真加载过才验得出来。
- **「挂上了 window、界面也画得出来」≠ 它的工作链走得通。** `ai-chat.js` 第一版就是这种情况：语法全绿、球和抽屉都在，
  但 `load()` 定义了**从没被调用** —— 于是「换页之后接着上次问」这个它自称的核心能力其实是坏的。
  所以新模块要跑一次「真发一轮请求」的回合：外部依赖 mock 掉（把 `TextAI.chatStream` 换成脚本队列，
  先吐一行 `CALL: overview {}` 再吐正文，这样查询那条路才走得到）、花钱的口子焊死
  （`Api.create` / `Api.createBody` / 任何 POST 到平台的 `Api.request` 换成抛错，跑完断言一次都没被调）。
  同一轮里顺手各断一次：查询结果接回 → 最终成气泡、未知查询与坏 JSON 会退回重写、次数用完那一轮不再查（CALL 行不留在正文里）、
  流式中途「停止」保住已写的字、「清空」在流式中被拦住、AI 回的 HTML 不会变成节点。这几条都不是看代码能看出来的。
  **动作那一半要单独跑**（`RUN:` 画的确认卡片是钱与设置的唯一入口）：合法动作 → 卡片出现时一次都没提交、
  点「执行」才恰好提交一次（顶层参数按声明摆回去、素材从本机地址取字节）、同一张卡片再点不重复提交；
  非法动作（型号不属于这家、取值不在声明里、素材是外部直链）→ **根本不能画出卡片**，也不能提交；
  `set_setting` 里 `sk_key_*` / `sk_base_*` 要在点执行之前就拒掉。
- **`vm.Script` 全绿 + 模块挂上了 ≠ 数据写对了。** 踩到第三类：`Drama.Lib.save` 用一份**手写的字段拷贝清单**
  往库里写（`look/bio/face/voice/…`），`name` 与 `kind` 不在清单里 —— 第一次入库时 `base` 是空的，
  于是**建出来的角色没有名字也没有类型**，而「同名 = 同一个人」的合并判据（`x.name === char.name`）跟着失效。
  语法、加载、页面渲染**三关都不报**（卡片照样画出来，标题那一格是空的）。
  所以给存储层加/删字段，必须真跑一遍「新建 → 改一处 → 刷新还在」：
  在 6300 隔离实例上用 iframe 探针点一遍 `PromptForm` 建角色、改类型下拉、名字 blur 保存，
  再用 `Drama.Lib.get(id)` 回读断言（`errors=none` 只证明没抛异常，不证明字段落盘了）。
  顺带一条：用户真实的 `.data/drama_chars.json` 当时还不存在（库是空的），才没被这个 bug 污染 ——
  这类「写坏一份用户数据」的坑只有先查一遍现网文件才能确认影响面。
- 涉及创建任务的改动：真实跑一次最小的（图片 draft 1 张 / 语音短文本），别只靠干跑；上游报错时看清是哪个字段。
- **接线一致性要单独查一遍，语法自测查不出来**：新加的按钮 `id="btnX"` 有没有 `bind`、
  新加的 `data-a="X"` 有没有 `sideAct` 的分支、页面用到的 `D.Pipe.xxx` 在不在 `Pipe` 导出表里、
  同一层有没有**重名的 function 定义**（后一份会静默盖掉前一份，本轮就撞过：
  `reshootShots` 写了两份，前一份的确认逻辑就再也不会跑）。这一类全绿 ≠ 页面点得动。
  `drama.html` 顺便还能查出**正文里混进 HTML 的 `Confirm.ask` / `toast` 字面量**（两者都是 `textContent`）。
- **光有「重名」这一档不够，还得查「够不着」**：上一条只抓同一个层级上的重名，
  而「`renderRewound()` 裸调 `bind()`，而 `bind` 只是 `renderBottom()` 里的局部 const」这种
  跨兄弟函数的裸调用，重名那档完全看不见（同名反而是它骗过检查的原因）。
  判据要**按块作用域解析**：先把注释、字符串内容、正则挖空（模板串的 `${…}` 留原样，那是真代码），
  再逐 `{}` 记「这个字符处在哪个块 / 这个块的外一层是谁」，然后对每个块收集它**直接**声明的名字
  （`function` / `class` / `const|let|var` 的**全部**声明项 —— `const a = 1, b = 2` 的 `b` 也要收，
  正则停在第一个就漏）/ 形参（`function f(a)`、单参箭头、`(a, b) =>`、对象与类里的方法简写 `body(el, close) {`），
  最后每个裸调用从它所在块往外一层层找。**`−1` 是脚本顶层作用域，也要查** ——
  多数页面是「顶层声明 + IIFE 里用」的形状，只查块会全判成查不到。
  还要排掉三类不是调用的写法：`new X(`、对象方法简写（`)` 之后紧跟 `{`）、
  以及 `window.X` 导出的公共层。`Assets/Index/Studio/Settings/Usage/Drama/Chars` 八个页面
  现在共 3455 处裸调用全部解析得到，这一档就该是绿的。
- **数据层要拿真源码跑一遍桩，不能只读代码**：`drama.js` 装进最小 window 桩
  （`Store` 与 `localStorage` **必须共用同一份底座** —— 真实现就是 `Store` 写 `localStorage`，
  两者分开就等于没测 `listBroken`；`Store` 还要照抄信封 `{data,ts}` + `cap` 的语义）。
  跨 realm 的数组不能 `assert.deepStrictEqual`（原型不同，会报 "same structure but not
  reference-equal"），先 `JSON.stringify` 再比。桩里没有任何语音 / 视频平台，
  `voiceReady` 的正向、`prereqs` 的声音缺口这类场景造不出来，只能验反向。
  桩里放的是**真源码**时，`setTimeout` 要换成能手动触发的（`{f, ms, done}` + 一个 `fire()`），
  否则「武装态超时自动还原」这种根本测不了 —— 手写的假 setTimeout 等于没测。
- **跨闭包的 UI 逻辑要单独测，别只靠接线核对**：`Confirm.arm`（就地二次确认）抽一小段极简 DOM 桩
  （`classList` / `innerHTML`↔`textContent` 互相同步 / `isConnected`）就能把四条行为钉住：
  第一次点只武装、第二次点才放行、点别处或 Esc 还原、整块重画后按 key 找回。
  桩最容易漏的一条：**`innerHTML` 赋值必须同步 `textContent`**（真实 DOM 就是这样），
  不补这一条，「还原成原来的样子」这一条会假失败，看着像代码有 bug。
  再一条：**`querySelector` 返回的影子节点必须缓存并把改动写回宿主** ——
  每次返回新对象的话，`iconSet` 改的是一个临时节点，
  断言读宿主的 `innerHTML` 永远看不到变化（「改了没反应」是桩的锅，不是代码的）。
  第三条：**`textContent` 也要代理**（`btnText` 走的是 `textContent` 不是 `innerHTML`），
  只代理 `innerHTML` 的话按钮改字那条会假失败。
  还有：**第二个 vm 沙箱也要自己挂 `window = sandbox`**（`ui.js` 在加载时就读 `window.addEventListener`），
  以及桩里的 `setInterval` 会一直吊着事件循环，**末尾要 `process.exit(BAD ? 1 : 0)`** ——
  否则 PowerShell 的 `| Select-Object -Last` 等不到 EOF，命令看起来像卡死。
- **扫字面标记的自检，正例绿了不算数，要再做一次负例**：第 ⑦ 档「每个 `<select>` 都有兜底项」
  原来只匹配文件里字面写出的 `<select>…</select>`，而入口页那几个下拉是 `sel()` /
  `Pipe.modelSelectHTML()` **拼出来的**（文件里根本没有字面 `</select>`）—— 正好漏掉了怀疑有问题的那几个。
  现在的做法是：把 `sel` / `sceneOptsHTML` / `timeOptsHTML` / `modelSelectHTML` **原样抠出来放进最小 `vm` 沙箱跑**，
  喂「当前值不在列表里」的输入，断言输出里那个值有 `selected`；型号下拉还多断言一条 ——
  **界面显示的那一个**与 `Pipe.videoOf` 数据层会用的那一个**必须是同一个**（存的值已下架时靠 `videoOf` 退回第一个）。
  **每一档写完都要手动把它破坏一次，确认它真的会红**，再改回来：
  上一版的判据是「文件里出现 `missNote` 这个词就算过」，于是把兜底整段删掉、只留参数名，它照样全绿 ——
  一档永远不会失败的自检，等于没有这一档。**判据要落在行为上，不能落在符号名上。**
  第 ⑦-b 档还踩了一次同样的事：判据自己写错了（`.map(` 之后定位参数列表的 `(` 算错了一格，
  回调体被截断；`${` 的配平从 `$` 的下一位起扫，把 `${` 自己的 `{` 当成嵌套，`depth` 永不归零 →
  整档一路返回 null、**怎么改代码都是绿的**）。负例没红不是「代码没问题」，是**判据坏了** ——
  排查顺序永远是：先确认判据在坏代码上会红，再去改代码。
- **提示文案里不许手抄字段清单**：数据层有一张「比哪几个字段」的表，
  页面那句 toast 就自己写了一遍「预览图 / 外貌 / 音色 / 描述」—— 那张表里明明有八个
  （音色描述 / 参考音频 / 时段都漏了），替用户在报 5 个字段的名。
  文案里的数量、名字、取值范围一律现算（`stale.flatMap(x => x.what)` 去重后 `join(' / ')`）。
  这与「数量/上限不许写死」是同一条：清单和数值都是数据，抄一遍就会各自漂。
- **源码里不许有裸的控制字符**（制表 / 换行除外）：真的踩到过 —— `lineDrift` 用 U+0001 当分隔符
  （空串会让「说话人 A + 台词 BC」和「说话人 AB + 台词 C」撞成同一条），当时图省事把**裸字符**写进了引号里，
  于是**任何编辑器打开那一行看到的是 `+ '' +`**：看起来分隔符丢了，判据无声地退化成空串，
  而「拆成两段才认得出」那条性质当场失效。一行代码、一条注释、一个全绿的自检都发现不了 ——
  **得主动去数字节**。要用不可见分隔符就写转义 `'\u0001'`，读者能看见、编辑器不吞：
  ```bash
  node -e "const fs=require('fs');for(const f of fs.readdirSync('.').filter(x=>/\.(js|html|md|css)$/.test(x))){const b=fs.readFileSync(f);for(let i=0;i<b.length;i++){const c=b[i];if(c<32&&c!==9&&c!==10&&c!==13){console.log(f+' 偏移'+i+' U+'+c.toString(16));break}}}"
  ```
  改这类分隔符**必须再跑一遍它那个函数的行为断言**（`.tmp-drift.cjs` 那 14 条：空串分不出的那条是主角），
  「语法过了」在这里什么都不能证明 —— 因为改动前后源码长得一模一样。
- **浏览器里验「图标换没换」要看截图，不能看 `query(kind:'dom')` 的 HTML**：
  那条查询会把 `<svg>` 从输出里剥掉，`.ic` 一律显示成空壳
  （`<span class="ic"></span>`），于是「图标在不在」永远验不出来，看着像 `iconSet` 没生效。
- **本机 shell.html 装在 iframe 里，浏览器自动化点不进内容页**（`click` / `scroll` / `query`
  都收不到；`query(kind:'editable')` 拿得到 ref 但 `mutationAllowed:false`；
  `inspect` 对 `settings.html` 这种大页超 64KiB 预算还会误判 `authentication_user_takeover`）。
  绕法是**直接顶层打开那一页**（同源，localStorage 数据一致），但坐标点击仍不可靠 ——
  报出来的 rect 空间与截图空间会差一个 DPR 比例，同一处点第一次中第二次不中。
  验不到像素的新按钮，就靠上面那条「接线一致性 + 数据层桩」兜底，并在交付里照实说明哪些只验到代码层。

## 6. 已知的平台事实（省得重复踩）

- **VGENV**：列表/详情都不返回 `prompt`（提示词靠本机归档 `PromptLog` → `prompts/`）；素材上传用 camelCase
  （`fileName`/`contentType`/`sizeBytes`）且**拒绝未知字段**（多发一个 `sha256` 就 400）；参考素材必须是
  `{asset_id}`（参考图是 `[{type:'image_url',image_url:{url}}]`），首尾帧走 `frame_images` 带 `frame_type`。
- **SparkCine**：上传用下划线字段且 **`sha256` 必填**；`output_format` 平台声明 png/jpeg/webp，
  但早前实测（产物字节头 / mime_type / 文件名）**回包永远是 PNG**，当时用 `forceOptions` 锁成 png；
  按用户要求**已解锁**（`options.output_formats` 给全，界面照平台声明给选项）。真要再锁回去就加回
  `forceOptions: ['output_formats']`；列表 `output_asset_ids`、详情 `outputs[].asset_id`；
  创建接口**要求 `Idempotency-Key` 请求头**，不带直接验证失败（registry 里已按 `create.idempotencyKey: true` 声明）。
- **SparkCine 视频的「平台自动润色」**：`create.topBools.optimize_prompt` 是**提交体顶层**的布尔
  （不进 `parameters`）。以前是写死的 `constants: { optimize_prompt: false }`，等于把这个功能焊死在关闭、
  界面上连入口都没有。现在声明式：生成工作台的视频栏只为声明了这一项的平台渲染开关，平台没有（VGENV）就不出现。
- **首帧槽位可以直接选视频**：生成工作台的「首帧图」既收图片也收视频 —— 选视频时在**浏览器内**取它的**最后一帧**
  当首帧（`Wb.vframe.fromFile()`，`studio.html` 的 `addSlotFiles` / `dropRefMedia` 调它，用于「把已有视频接着往下生成」）。
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
- **任务卡片一律来自平台接口（语音除外）**：生成工作台的图像 / 视频栏**不建本地任务卡**，本地也不留任务记录
  （`video_tasks` 已废弃，`Wb.History` 的 `video` 规格与 DataSync 的同步键都删了；
  `HISTORY.image`（`sparkcine_gallery`）是合并前的旧生图工作台留的键，现在**只保留给设置页清理/查看**、页面已不再写入）。
  提交流程是：`create` 拿到任务号 → `adoptTask()` 立刻按任务号从接口取回那条任务、插进列表
  （取不回来就整表刷新，列表接口才是状态的最终依据）；之后由统一轮询器刷新状态。
  所以「创建中/排队中」的占位卡、孤儿认领、本地↔服务端校正这些机制都不该再出现 ——
  卡片上的任务号一定来自平台，本地记录不参与渲染。**语音是例外**：MiMo 是同步合成、上游没有任务号，
  本地记录就是它的唯一凭据（保留 `audio_tasks`）。
- **创建后的「取回/核对」不要挡住按钮**：平台列表接口动辄 6~14 秒，`adoptTask()` 与「结果未知 → 核对列表」
  都必须放后台跑（只提示「正在取回/核对」），按钮的禁用窗口只覆盖 create 本身。
  唯一的例外保护：结果未知时置 `pendingUncertain`，这期间再点生成先弹确认（防止把可能已成功的提交又提交一遍），
  核对结束自动清除。
- **平台的提示词编译失败可安全重试**：VGENV 创建时会跑一步 `prompt_optimization`，子服务偶发失败返回
  `PROMPT_COMPILER_UPSTREAM_ERROR` —— 这表示**任务没创建、没扣费**，重试安全（不像超时/断连那样可能已受理）。
  统一用 `Api.isRetryableCreateError(e)` 判断（页面自动重试一次，别各写正则）。
- 提示词归档：`POST /prompts` 写文件、`GET /prompts` 列清单 + 索引、`GET /prompts/find?id=&provider=` 取全文；
  目录在设置页可改（`prompt_dir`，只存本机）。
- **`/prompts/find` 一次返回按 id 匹配到的全部归档**（`{matched, prompt, all[]}`）：`provider` 只用来决定
  「优先把哪一份当正文」，不影响是否命中。**客户端每个任务只发这一个请求** —— 以前是「带 provider 查一次、
  查不到再不带 provider 查一次」，第二次多半和第一次逐字节相同（本机根本没归档），于是每条老任务固定多一个 404。
  代理侧还会在索引里没有这条时**按文件头扫一遍目录**（索引只留最近 2000 条，窗口外的老归档不在里面），
  没有才回 404；客户端回源 404 会记进 sessionStorage 的 missed 集合，同一标签页不再问第二次。
  剩下那一个 404 是「本机确实没有这份归档」的如实答复，不是噪声；要再省就得做 `ids=` 批量查（还没做）。
- **本机资产（`/local-assets`）的大类型由代理现算，不看调用方给没给**：`proxy.js` 的 `localMediaType()` 按
  落盘扩展名 → mime → 调用方给的 `media_type` 依次判（`图片` / `视频` / `音频`），POST 与列表回读都走它 ——
  所以 `Api.saveLocalAsset()` 的调用方**不必**传 `media_type`（短剧末帧那张 PNG 以前没传，就被缺省记成了音频）。
  注册表里本机来源的 `list.media` 是 `{ by: 'media_type', ... }`，条目自己带类型；`音频` 与 `音乐` 是同一类
  （收藏页、资产库筛选、语音台列表都两个词都收），新代码别再只认其中一个。
  另：隔离验证实例要 `ASSETS_DIR=.assets-probe` 一起给 —— `LOCAL_DIR` 默认就是项目下的 `.assets`，
  只换 `DATA_DIR` 的话探针生成的素材会直接写进用户的资产库。
- **缩略图缓存键必须归一化**：VGENV 的视频在页面上是 `/getv?url=<OSS 签名地址>`，而 `Expires`/`Signature`
  每次刷新都会变 —— 用整条 URL 当缓存键等于「永远命不中、每次都重新加载视频元数据」。
  归一化只有一份：`assetlib.js` 的 `Api.mediaKey`（内层地址的 host + path + 稳定 query，易变签名参数剥掉），
  `Wb.thumbs.keyOf` 与回源去重都用它。以后接入平台时，只要产物地址带易变的签名/参数，都要先归一化再当键。
- **过期签名外链由公共层负责，页面不许自己判过期**（`assetlib.js`）：平台产物地址只管一天，一旦被**存进本机记录**
  （收藏 `fav_items`、导演台工作区 `workspace`），第二天必然 403 —— 表现是「这条视频的缩略图永远加载不出来、
  点开只回一句 Format error」，真实原因完全看不出来。三条约定：
  ① 判过期用 `Api.mediaExpired(url)`（只看地址里的 `Expires`，不发请求，还留了 60 秒余量）；
  ② 回源用 `Api.healMedia(recs, { onFresh })`：rec 只要 `{ provider, id|genId|assetId, url }`，
     它按平台分组走 `Api.pollMany`（声明了 `pollVia:'list'` 的平台**一次列表请求解出整批**，
     逐条 `pollTask` 就是 N 次「100 条的列表」，上游被打爆、请求互相排队），
     换到的新鲜地址按素材身份记进内存表；
  ③ `Api.mediaSrc(url)` 会查那张内存表 —— 所以页面**一行都不用改**：播放器、缩略图抽帧（`Wb.thumbs._source`）、
     灯箱、`/fetch?url=…&dl=1` 的下载链接都跟着换成新鲜地址。
  落盘由调用方在 `onFresh` 里做（收藏写回 `fav_items`，导演台写回工作区并 `DataSync.mirrorWs`），别指望内存表跨会话。
  开机回源这一趟必须放后台（`index.html` 的 `healStaleUrls()`），别在首屏 await —— 收藏/镜头一多就被慢接口拖住。
  **别拿 assetId 拼 `/asset/<id>` 当新鲜地址**：那条本地路由只服务本工作台落盘的产物，别平台的资产号进去就是 404 破图。
- 云同步：`POST /cloud/sync`（一键双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
  冲突判定靠 `.data/.cloud-state.json` 基线（点开头 = 内部状态，不参与 dataList/上传/下载）。
  改同步逻辑时**不要退回"只看时间取新"**：那会在两边都改过时静默丢一边。
  两条底线：① 远端**存在但读不下来**（GET 失败）判 `error` 并跳过，绝不 push（否则本地旧数据覆盖云端较新版本，无提示、云端无 .bak）；
  ② 本地 `removeItem` 的删除请求必须真正执行到底（`DataSync.queue` 存 body=null、`flush` 走 `delData`），否则服务器那份还在、下次 boot 又拉回来。
- 浏览器侧对账（`ui.js` 的 `DataSync.boot`）：体积相同**不能直接跳过** —— 等长修改（grid→list、等长密钥/模型名）
  体积一模一样，只比体积的话另一台机器的更新永远拉不回来；体积相同但服务器更新时仍要取回逐字节比对。
  对账期间（`booting = true`）本地写入**先进 `held` 暂存表、不立刻镜像到 `.data/`**，`finally` 里 `releaseHeld()` 补发；
  `flushKeepalive()` 发送前也要比对 `localStorage` 当前值，值已经变了就不发（`changed → location.reload()` 那条路径上，
  排队内容很可能是对账拉回之前的旧内容）。改这三处任一一个，都要在隔离实例上重跑一次「页面写入 → 刷新 → 对账」的验证
  （`PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe node proxy.js`，别在真实实例上写）。
  **已知残留限制**：普通字符串值（`dir_theme`、`sk_key_*`、`page_mode_*` 这类没套信封的键）取不到写入时间，
  `Store.tsOf()` 返回 0，`boot()` 判不出「本地更新」，所以它只能靠上面两道闸门挡误写，不能证明顺序正确
  —— 别再往「只看 mtime 取新」的方向退化。（结构化记录一律走 `Store` 信封，`fav_items` / `ai_usage` 已收进来。）
  **但「发送前再比一眼 `localStorage` 当前值」这道闸门对 `DataSync.NO_LOCAL` 里的键必须跳过**（目前是 `workspace`：
  本体在 IndexedDB，页面把快照单独递过来，本机根本没有这个值 —— 一比就永远「不一致」，镜像静默不落地。
  踩过：`.data/workspace.json` 停在两天前，换机器 / 清缓存时恢复出来的是旧工作区，连开机回源换来的新鲜地址都没落盘）。

## 7. 新增约定（2026-10 第三轮）

- **
etrieve 是「产物只给文件号」那一族的通用环节，不是某一家平台的补丁**：注册表用 ndpoints.retrieve
  （{id} 在 query 里也照样替换）+ `retrieve: { idFrom, urlFrom } ` 两处声明表达；
  `Api.resolveItem(prov, raw)` 在**轮询与列表两条路上各换一次**，换回来的地址写进条目的 `__url`，
  `parseItem` / `normalize` 读不到产物地址时兜底用它。**只调这一个入口，不按平台 id 补判据**；
  没换到就照原样判成「生成中」，下一轮再换。挂进去的点是 `parseItem`（所有轮询路径共用的那一份解析）——
  少一个入口就意味着「某个平台的产物永远不落盘 / 永远拿不到地址」。
- **产物「自动存本机 + 地址三级回退」只有一份实现，在 `assetlib.js` 的 `AssetLocal`**：
  ① 平台地址过期 → 用本机副本（`AssetLib.normalize` 里 `decorate` 换 `src`，勾了「优先用本机」才换）；
  ② 本机文件被删 → 代理按索引里的 `upstream` 302 到 `/getv`（**绕一跳而不是直指外链**，页面因此始终同源）；
  ③ 两边都没了 → 装在 `document` **捕获阶段**的 `error` 监听插「已丢失」角标
  （error 不冒泡但捕获阶段截得到，所以卡片 / 列表 / 灯箱 / 详情面板一次全覆盖，页面一行都不用改）。
  入队只有 `offer`（同步入队）与 `scan`（列表每批到达时扫一遍）两个口，下载在队列里异步做。
  **镜像索引 `sk_local_mirror` 刻意不进 `DataSync.SYNCABLE`**（本体在 `.assets/`，换机器那些 `la_xxx` 压根不存在）；
  两个开关（`sk_media_local` / `sk_media_prefer`）要进。代理的 `LOCAL_INDEX_MAX`（2 万）与客户端的 `IDX_MAX`
  **必须一样** —— 两边各截一半会出现「明明存过，点开却说已丢失」。
- **下拉浮层挂 `body` 用 `fixed` 定位，不留在 `<select>` 原来的位置上**（`ui.js` 的 `Dropdowns` + `ui.css` 的 `.dd-list`）：
  原地展开时任何祖先的 `overflow` 都会把它裁掉（生成工作台 `.adv` 是 hidden、左右栏是 `auto`、外层 `.layout` 还是 hidden
  —— 一个下拉要穿三层裁剪）。**逐个容器去改 overflow 等于把同一个毛病抄 N 份**，根在浮层脱离文档流。
  下方空间不足 160px 而上方更宽裕时自动加 `.up` 往上开；页面滚动 / 窗口变化按 `rAF` 重新 `place`。
  **`ai-chat.js` 里那条 `.ac-picks .dd-list` 容器特例已经删掉了，别再加回来。**
- **资产库 / 素材库 / 收藏三页的展示档位名统一成 `list` / `compact`**（`Wb.viewToggle` 的 `views` 数组）。
  以前资产库叫「卡片」、另两页叫「列表」，同一个概念在 `UI_PREFS.rows` 里要写两种词，还漏了 `dir_char_view`
  —— 表现是「在设置里选了列表，进来是另一种摆法」。**三页的名字、`UI_PREFS.rows` 的行、`RESET_KEEP` 必须同时改。**
- **`/custom/models` 必须留在代理**：它要把用户密钥递到用户自填的主机，同步的 `safeOutboundUrl` 只查字面量 IP、
  异步的 `guardOutboundUrl` 还查 DNS 解析结果（页面直连等于把这套判据抄第二份）；且图片 / 视频 / 语音那几家
  没有 `baseEditable`，走内置 relay 会被代理拒 `x-up-base`（故意的），所以只能新开一条路由。
  `upRequest` 的 `timeoutMs` 是**空闲**超时，域名解析那一步还没有 socket、不受它管 —— 必须自己加墙钟（25s），
  否则一个解析不出来的地址会让设置页「获取型号列表」一直转圈。
- **自定义供应商的型号一律现取，不预填模板里那份硬编码清单**（那份是「内置那一家」的声明，照抄给用户的中转站等于替它编型号）：
  表单只画「已保存 / 接口返回 / 手填」三类，**接口返回的一律不勾**（由用户自己挑），勾选态 = 已保存 ∪ 手填，
  重新拉一次不会把上次勾的冲掉。`buildCustom` 那边会按用户勾的 id 合并模板能力声明，不用改。
- **程序化填完 `<select>` 的 options 之后必须调 `Dropdowns.sync(那个 select 本身)`**（`sync` 的 root 可以是
  select 自己，与 `build` 对称）。公共下拉的浮层里那份选项列表是 **`build` 那一刻的快照**：
  只改 `select.innerHTML` 不通知它，按钮上写着什么、点开列出什么会对不上 ——
  表现就是「接口形状里没有预定义的（点开是空的）」。这条对**任何**动态填选项的地方都成立
  （`usage.html` 那句「选项变了，同步公共自定义下拉」是同一件事的另一个写法）。
- **「添加自定义供应商」这一格是新增入口，点它必须复位成新增态**（`cusOpen` 里先 `cusReset()`）：
  不复位的话，先编辑了 A 家再点这个按钮，按钮还写着「保存这一家」、类型还锁在 A 家那一档，
  看着像点了没反应，填完一提交才发现改的是上一条。
- **显示名按「类型 + 编号」预填（图片1 / 视频1 / 语音1 / 文字1），编号只数这一类已有的**：
  以前预填的是照模板名字拼的「SparkCine 中转」—— 一次加三家就全是同一个名字，而显示名正是
  型号下拉的分组名与收藏里的筛选项，重名会让那几组分不开。
- **改 / 删已添加的那几家要能在「添加」这张卡里就地完成**（`paintCusMine` 一份清单 + 编辑 / 删除）：
  供应商那张卡上也有这两个按钮，但那是**按类型分档画的** —— 语音那一档加的只有切到语音才看得见，
  删一家要在四档之间来回找。
- **`REGISTRY.interfaceShapes` 是「接口族」清单，与「供应商」分开**（v10 起）：设置页「添加自定义供应商」里
  `供应商` = 照哪一家**内置平台**整套走（选了就**不用**再挑接口形状，整行收起来），`接口形状` = 选「自定义」之后
  才出现的**协议族**（OpenAI 兼容 / H3 兼容…），与厂商无关 —— 跑 OpenAI 兼容那一套的中转站跟 OpenAI 官方不是一家，
  但接口一模一样。**每一族的 `template` 必须是真实存在的内置平台 id**（`buildCustom` 照它整套克隆：能力声明、
  上传流程、retrieve 环节全从它来），所以这里不编不存在的形状 —— 加一族就是给某个内置平台补一个更好懂的名字。
  落盘条目里的 `prov` / `shapeId` 只为**编辑时原样还原**（代理只读 `shape`），老条目没这两个字段时按
  `shape` 反推：它是内置 id 就还原成「选了那一家」，否则落到「自定义」并挑第一个照它的族。
  **填完 options 一定要先定 `select.value` 再 `Dropdowns.sync`**（反过来会按钮写着第一家、真实选中的是「自定义」）。
- **「类型」只有一个来源：顶部那排类型档（图片 / 视频 / 语音 / 文字），表单里不再给类型下拉**：
  在哪一档点「＋ 添加自定义供应商」，加出来的就是那一类（`cusKind()` 读 `provTab`）。
  以前给了一个下拉，结果「在语音那档点添加、类型却落在图片」只能靠人去核对，
  而多出来这一个控件并不能帮人选出更对的类型（类型不是他选的，是他脚下那一档定的）。
  换类型 = 点那排档，钩子挂在 `renderProv()` 的类型档点击上（`cusKindChanged()`，卡收着时不动）；
  `cusEdit` 也要跟着改成「把面板切到那一条的 `provTab` 并 `renderProv()`」，不是给下拉设值。
  别让它凭空消失：计数行里写成静态文字（「图片类 · 四种类型合计已添加 N / M 家 · 这一类 K 家」）。
- **下拉重画后的「回落」校验，合法取值集合必须把 `CUS_CUSTOM`（「自定义」）算进去**：
  `renderCus` 填完 options 会做一次回落（`if (!pSel.value || !okIds.includes(pSel.value)) …`），
  而 `okIds = provs.map(p => p.id).concat([CUS_CUSTOM])`。
  只拿 `provs`（内置那几家）去校验，就会把用户刚点的「自定义」当成非法值弹回第一家 ——
  症状是**「接口形状」那一行永远出不来**（看着像那一行坏了，其实是选中值被回弹了）。
  这条与上面「先定 value 再 sync」是同一处代码的两半，一起改。
- **加 / 删一家之后 `afterCustomChanged()` 必须 `paintCusMine()`**：`renderProv()` 只重画供应商卡上那一片，
  它不碰 `#cusMine`。少这一句的症状是「删掉了，但『已添加』里那一行还挂着」，
  再点它那个删除会得到「清单里找不到这一条」，要等重新展开这张卡才消失。
- **自动预填的显示名要跟着换类型走，人手打过的不能动**（`cusAutoName` 记着「当前这个名字是自动填的」）：
  切档时只有 `$('cusName').value` 为空**或**仍等于自动填的那个，才换成新类型的编号
  （`cusFillName()`）。只判空不够 —— 自动填的名字一直非空，不记这一份的话，
  在视频那档展开表单、再顺手点一下「图片」档，带过去的就是「视频1」，
  加出来一个图片类却叫「视频1」的家（正是「类型与显示名对不上」那一类毛病）。
  `cusEdit` 载入清单里的名字时要 `cusAutoName = ''`（那是记录，不是自动填的）。
- **「供应商与密钥」那张卡只列本机在用的那几家**（v11 起，`provUsable()`）：`m.custom`（自己添加进来的）
  **或** `keyState(m) !== '还没填密钥'`（设置里填了 / `.env` 里有服务端密钥）。一把密钥都没有的内置平台**不列** ——
  摆一张填不了也用不上的卡既回答不了「我在用哪几家」，又把真在用的挤到下面；想用它就走「＋ 添加自定义供应商」
  （选它、地址自动填好、贴把密钥、点添加），它会作为**自定义那一家**出现在卡片上，自带编辑 / 删除。
  连带要改的：类型档上的小数字从「注册表里几家可选」改成「**现在列着几家**」，
  可选家数挪到汇总行（「图片类：已接 1 家 · 注册表里共 2 家可选」）——
  空列表上面挂个「2」会让人以为该有两家。
  文字 AI 不受影响：`TextAI.all()` 直接读注册表，供应方下拉与那张卡本来就是两套数据源。
- **接口地址跟着刚选好的那一家自动填**（`cusFillBase` / `cusSyncBase`，与显示名同一套记账）：
  选内置供应商就填它官网的 `base`，选某一族接口形状就填那一族的模板 `base`。
  **空着或仍等于上一个自动填的值才替换，手打过的不动**（`cusAutoBase` 记着「当前这个是自动填的」，
  `cusEdit` 载入清单条目时要清成 `''`）。渲染入口统一在 `renderCus()` 末尾调 `cusSyncBase()`，
  「这一类没登记接口形状」那一支提前 `return` 也要先调一次。
- **「地址撞模板自己的官方地址」不再是错**（v11 起，代理与表单两边都改了）：内置平台现在也要先添加一次
  才进那张清单，而那个官方地址正是表单自动填进去的默认值 —— 选一家、贴密钥、点添加就是「我要用这一家」。
  真正要拦的只剩一种：**拿 A 家的官方地址配 B 家的接口形状**（`hostOwner` / `customProblem` 里那条判据）。
  `customProblem` 那条还要注意排除**与模板同 host** 的内置 id：同一个上游常按媒体类型分成好几条内置 id，
  它们彼此不算撞。
- **自定义平台不设家数上限**（v11 起，`CUSTOM_MAX` 与 `/registry` 的 `custom.max` 一起删掉）：
  以前 12 家那道闸把两件正经事也堵死了 —— 内置平台现在也要先添加一次才进清单，常用平台都接一遍就撞上限；
  用户接十几个中转站是真的会发生。清单是**本机**文件、每条都要过一次 `customProblem`
  （公网 https / 型号齐全 / 不撞别家 / id 合法），刷不爆什么。
  页面那边 `cusMax()` 与「点添加时报错」的那道闸一起删，计数行只报「已接 N 家」，
  **按钮任何时候都不禁用** —— 禁用了又没有上限可讲，就只剩「按钮坏了」一种解释。
- **`/registry` 的自定义清单缓存要连着 notice 一起存，键里还要带 size**（`customProviders`）：
  ① `customNotice` 以前在**进函数时就清空**，命中缓存那一次报回去的是「没有坏条目」，
  页面那句「有 N 条自定义平台没被本地代理认」会莫名消失，而坏条目还在清单里；
  ② 同一毫秒里连着写两遍可能拿到同一个 `mtime`，新加的那一家读不出来 ——
  表现是「我明明添加了，下拉里没有」。键用 `file + mtimeMs + size`：长度不同就不是同一份文件。
- **删掉一家自定义平台，侧栏那张余额卡要当场消失**（`sidebar.js` 的 `window.__sbBalanceDrop(kid)`）：
  余额那一轮是 60 秒一次，而 `refreshBalance()` 进来第一件事是**拿 `localStorage` 的缓存先画一遍**
  （为了切页/刷新时余额立刻可见）—— 被删掉的那家在缓存里还留着，不先剔掉的话，用户点完删除看着
  「根本没删掉」，要再等一分钟才消失。所以设置页 `cusRemove` 走的是 `afterCustomChanged(droppedKid)`：
  收尾时摘掉隐藏名单里那个 kid，再调一次外壳这个口（`top.__sbBalanceDrop`，与 `__sbApplyTheme` 同一套路；
  页面被直接打开时没有外壳，try 一包就完了）。
  口里三件事：剔 `BAL_KEY` 缓存里那一行（**只改 `rows`、不动 `ts`** —— 缓存的新鲜度必须如实反映最后一次真取数）、
  摘隐藏名单里那个 kid、然后按剩下的缓存重画。**剩一张时不画空壳**：`balRows` 空了就退回 `refreshBalance()` 重取。
  连带要改的还有 `refreshBalance()` 那一支：`SbBal.prune` 以前排在「`map` 非空」的分支里，
  于是「平台全下架 / keyId 全改了」这种情况下隐藏名单**永远清不掉**（只增不减地攒着）—— `!map.size` 早退前也要 prune 一次。
- **「功能已经改了、键却还留着」的那批键要一次性清掉，别只删代码**（`ui.js` 的 `LEGACY_KEYS` + `sweepLegacyKeys()`）：
  留着不只是占地方：每次同步都要带着它们跑一趟、整包备份与云同步会把它们一起带走换台机器又是一份死数据，
  更要命的是**让人以为「这些设置还在管用」**，去改一个改了也没人看的地方。
  以后再删掉一个功能就照着加一行，**并写清为什么作废**（`audio_tasks` 还在用，别顺手一起删）。
  ① **必须排在 `DataSync.boot()` 之后**：boot 会拿 `.data/` 里的文件去补 localStorage（清过浏览器数据后靠它恢复），
  先清本地再对账，那几份死文件会被「恢复」回来 —— 顺序反了等于没清。
  ② 镜像走 `DELETE /data/<键>?nobak=1`：代理删东西默认留一份 `.bak`（云同步的「后悔药」），
  但这批键是**已经宣告作废**的，为它们留备份只会让设置页的「备份清单」里永远挂着几行
  用户认不出、也永远不会去恢复的键名。`nobak` **只给这一处用**，别的删除路径（清空某项数据、云同步删远端）照旧留备份。
  ③ 本机一个都没有就一个请求都不发 —— 不为了「可能有」去打扰代理。
- **「添加自定义供应商」里那个供应商下拉的选项文字只给平台名**（`renderCus` 的 `pSel.innerHTML`）：
  不要在后面缀「（N 个型号）」。那一栏标签位窄，拖着括号会把长名字截掉，
  也让末尾那项「自定义」在视觉上不像同一类东西；型号数量靠「点获取型号列表」现问
  （型号下拉里本来就是那一份，写死在这里等于第二份会过期的数字）。
- **「这一家在本机算不算在用」只有一份判据，在 `assetlib.js` 的 `Api.provUsable`**：
  三档算在用 —— 自己添加进来的（`custom`）、`sk_key_<keyId>` 有着落的、`.env` / 系统环境里有的；
  剩下一档（内置平台且一把钥匙都没有）**两处都不列**：设置页「供应商与密钥」那张卡，
  以及侧栏「账户余额」。以前只有设置页过滤、侧栏不过滤，于是「没添加、没密钥」的月之暗面
  也在侧栏占着一张卡，内容永远是「获取失败」—— 一张永远失败的卡不是信息，是噪音。
  两个坑：① **读 `sk_key_` 必须用裸 `localStorage.getItem`，不能改走 `Store.read`** ——
  两处读取口一旦不同分，就回到「设置页不列、侧栏列」那个毛病（正是要修的那个 bug）；
  ② `/env-status` 走 `Api.envStatus()`（带 60 秒缓存），设置页与侧栏共用一份，别各拉一次。
  **「配了却读不通」的那几家仍然要出现、并且照样显示「获取失败」** —— 那是真错误，不能一起藏掉。
  `SbBal.prune` 仍然拿**注册表**那份名单（不是过滤后的）：隐藏与否是显示偏好，
  不能因为一把钥匙暂时没配就把它从名单里抹掉（配回来时又冒出来才叫添乱）。
  一家在用的都没有时，**要把 `BAL_KEY` 缓存一起清空**再画那张说明卡 ——
  不清的话下次开页面会先拿缓存把旧行画出来，用户看着像没生效。
- **每张供应商卡都要写明「这一把密钥现在是从哪来的」**（`settings.html` 的 `keySourceNote`）：
  密钥有**三个**来源——设置页自己存的那份（`.data/sk_key_<keyId>.json`）、`.env` / 系统环境变量、
  以及刚输入还没保存的草稿。以前只画一个密码框，填过的人自己都忘了填过，
  于是「`.env` 里明明没有 DeepSeek，它怎么还列着」只能靠猜（多半是以前在卡上粘过一把）。
  查文件是查不出来的（键名对不上），所以只能写在卡上。顺带把「清除」按钮的用处说清。
- **悬浮球吸边：左右任意高度都吸，上下完全不吸**（`ai-chat.js` 的 `snapXY`）：
  判据是「球心落在**可用区**的哪一半」，松手时在左半边去最左、右半边去最右。
  以前是「离边 ≤26px 才吸」，窗口宽时等于大部分地方都不吸，往边上甩一把却没吸住 ——
  手感成了「有时候吸有时候不吸」。**上下不吸**是因为一条竖排的边才看得出「贴住了」，
  四边都贴就成了贴角，反而不知道它算哪一边。
  分界线用**可用区**（扣掉侧栏之后 `minX = 8 + sbW()`、`maxX = innerWidth - BALL - 6`）的中点，
  不是窗口中点：侧栏展开时可用区整体偏右，拿窗口中点判会把明显偏右的位置也吸到左边。
  设关（键 `ai_chat_snap`，存 `'0'`）时**原样落手**。`clampXY` 仍然兜底把球夹在窗口内。
- **提示词归档要有备份出口 —— 它曾经两头都漏**（`POST /prompts/export` / `/prompts/import` + `/cloud/*` 的 `prompts/` 子集合）：
  归档是磁盘上的一堆 `.md`，**既不在 `.data/`（云同步带不走）也不在 localStorage / IndexedDB
  （整包备份同样带不走）** —— 换机器、清浏览器数据、误删目录，就只剩「没了」这一种结果。
  两条出口都**默认关**（正文出网 / 备份文件变大都该由用户自己决定），
  但「关」不等于「没有」，设置页与状态行都要说清它没被带上。
  ① **云端**：跟着 push / pull / sync 一起走 `prompts/` 子集合（`x-cloud-prompts` 那个开关放在
  请求体 `prompts:1` 里，因为归档目录 `prompt_dir` 是**浏览器那边的本机设置**、代理自己不知道，
  要由设置页一起递过去，且仍要过 `promptsDir()` 的目录校验）。
  **只推不删**：归档是只增的创作历史，误删没法恢复；「本机删了、云端也跟着删」要判对得先有基线/墓碑，
  那是数据键那套才值得上的机制，这里不引入 —— 云端多出来的**只报数量**，由用户自己去拉。
  「一致」的判据是**同名同大小**（归档落盘用独占创建、不会被改写），且要先判模式后判「只上传/只下载」，
  这样 `same` 在三种模式下都是同一个意思。`PROMPT_CLOUD_SUB` 建不出来时要**报出来**
  （有些网盘不允许 WebDAV 建目录），不能闷着头传然后每份都 404。
  ② **整包备份**：导出弹窗多一个「数据 + 提示词归档」选项（`DataSync.exportAll(includeBlobs, includePrompts)`，
  归档塞进 `pack.prompts`）。**带不上要明说**（`pack.promptsError`）——
  悄悄导出一个「少了提示词」的备份还报成功，比导不出更坏。
  ③ **恢复一份都不覆盖**（`flag:'wx'`）：归档丢了比多一份严重得多，撞名的报出来让人自己看。
  文件名要按 Windows 最严的那套字符过滤并挡掉 `../`，否则备份文件就是个往目录外写文件的入口。
  ④ `_index.json` 是派生索引，**不上传**（传了可能把另一台机器的条目带歪），本机重建。
  - **能力声明回来之前，不许说「你没配 X 接口」**：`boot` 先画界面、`loadCaps` 后台取注册表，
    取回来之前 `ttsWays` / `videoChoices` 会落到「没有这一家」的兜底分支，于是页面会说
    「还没配语音接口」/「还没配视频接口」—— 而用户**什么都没做错**，他配了。
    这类话既吓人又指错了路（会让人跑去设置页重填一遍密钥）。
    已有三道闸，别以为只有入口页那两道：`paintOpts`（不画下拉，写「正在读平台能力声明…」）、
    `paintSecs`（不写数字，`duration` 那时全是兜底值），以及 **`renderBottom` 的 `capPending`**
    —— 第三道是 2026-10 补上的：前置条件里 `key:'voice'` 那一条依赖能力，加载期要被压住
    （缺脸 / 台词空不依赖，照常显示）。实测过同一条 prereq 在能力回来前后会从
    「还没配语音接口」变成「还没定音色」，中间那一瞬就是句假话。
    压住的那一条要另给一句中性说明（「先不报缺」），**不许假装通过**。
  - **要花钱的入口按「会发出几条真任务」分级，多于一条必须先问**：现在三处都是 `Confirm.ask` ——
    单段连拍（`n > 1`）、「重拍没成的 N 段」（`reshootShots`）、以及底栏「开始拍」
    （`shootAll`，**2026-10 补上的**）。最后这条原来**一点确认都没有**：它一次开 `total` 条真任务、
    各自计费，75 段的一集点一下就是 75 条开出去 —— 全站最贵的按钮反而是最没防护的那个。
    三处判据是同一条：**多于一条就要先问**，一条不问（一段就是一条任务，界面上数得出来，多问只是骚扰）。
    两条容易写错的：
    ① 确认闸必须排在 `showPrereq` **之后** —— 前置不齐时先问「拍 N 段吗」、再告诉用户其实一段都拍不了，
    比直接开前置清单更让人糊涂；
    ② 排在 `genSet('batch')` **之前** —— 没确认就不该先占住整轮的记账（那正是拦住「再点一次开始拍」的那道）。
    `reshootShots` 自己已经问过了，所以它调 `shootAll` 要传 `confirmed`（第二个参数），
    否则连点两下弹两次框。`Confirm.ask` 的正文走 `textContent`，**只能写纯文本**，塞 `<b>` 会显示成一串标签。
  - **界面上的提示必须指出路，不能只说「补好就行」**：底栏那条红条原来只有
    「⚠ 第 N 段还缺: … —— 补好就能拍这一段」，而底栏「开始拍」只是加了 `.dr-dim` 变暗、
    **并没有 disabled**（点得动，会开 `showPrereq`，那里有「去设置」「去认角色」两颗按 `fix` 分类的按钮）。
    不指路的话，用户看到一颗变暗的按钮只会以为它坏了。现在红条补一句「点下面『开始拍』会逐条列出来，
    并直接给出去补的路」，`title` 也从「前置条件还没齐」改成把这条路写出来。
    `prereqs` 每条自带的 `why`（「到设置页填一个语音平台的密钥」这类可执行的那半句）**只在
    `showPrereq` 里说全**，红条不复述 —— 同一件事说两遍，两遍就会对不上。
- **界面上的承诺要么实现、要么改文案**（拍短剧「质检没过时：自动 / 手动」那一排的 title）：
  原来写着「自动：没通过就一直重拍到过为止」，而底栏「开始拍」是**整集连拍**，
  那条路每段只拍一条、失败就停 —— tooltip 承诺了一件页面上永远不会发生的事。
  这类「自动/手动」「开/关」的分段控件，**每一档都要有一条真实生效的路径**；
  两档真的不一样时，title 里要写清**哪一条路是哪一档**（不是各写各的效果）。
  拍短剧那一排后来是**整条删掉**的（去掉质检后它失去了定义），这也是合法的第三条路 ——
  一个开关的两档已经不再对应两种行为时，留着它比删掉它更坏。
  反过来，「让批量也自动重拍」看着更贴合承诺，但一集 75 段 × 每段 3 次 = 账单按三倍走，
  而用户点的是「开始拍」不是「自动重拍全片」—— 这种要钱的地方宁可把话说清楚。
- **成片这类「导出过一次」的东西不能变成终态**：`renderSpec` 顺带算一个 `stamp`
  （每条用哪一次拍摄、什么开关、什么画幅、有没有配乐），导出成功时存进 `drama.finalStamp`；
  之后任何一次改动都会让它对不上，底栏据此说「这一份成片是旧的」并给一条**重新导出**。
  以前只要 `finalVideo` 非空，那个位置就永远是下载按钮：重拍过、改过台词、
  动过配音/字幕开关，界面照样递给你一份旧成片，一个字都不提示。
  **指纹的算法只在这一处**，页面不许自己拼一份（两处各拼一份就会「永远对不上」或「永远对得上」）。
- **下载一律走 `Wb.save(url, name)` → `Net.save(blob, name)`，不许 `window.location.href`**：
  成片文件在代理的 `.renders/` 里只留最近 20 部，直跳过去撞上 404 时浏览器**静默失败**，
  用户只看到「点了没反应」。`Wb.save` 先判 HTTP 状态再存，失败要 toast 说出真实原因
  （「代理只留最近 20 部成片，这一份可能已经被清掉了」）。内存里的 Blob（字幕 SRT）走 `Net.save(blob, name)`。
- **字幕轨与配音轨的时间基准只能有一份**：`dubShot` 已经把每句真实的 `start`/`end` 存进 `take.lines[]`
  （它跳过空句、空句不占时间），`takeSubs` 就必须照那份画。以前它自己从 0.35 重新累加、
  还给每句垫 0.6 秒下限、空句占 0.2 秒 —— 于是「烧进画面的字幕」与「听到的人声」逐句漂，
  段越长偏得越明显。**没有配音时**（预览 / 预演）才按字数现排。
- **页面要用数据层的内部函数，就把它加进 `Pipe` 的导出表**：本轮页面要读 `renderSpec` 的 `stamp`，
  而它没导出 → 运行到那里就是 `undefined`（语法自测与控制台都不会报，只在那一条路径上炸）。
  `drama.js` 的导出注释已经点名「没列到的是内部单一实现」—— 页面要跨闭包调它，就先加进那张表。
- **`Confirm.ask` 的正文走 `textContent`**：`<br>` / `<b>` 会原样显示成标签。
  要排版就用 `UiDialog.open({ body(el) { el.innerHTML = … } })`。
  同样地 `Toast` 也是 `textContent`。
- **删除一律走 `Confirm.arm` 就地二次确认，不弹窗**（`ui.js`，两个页面共用一份）：
  第一次点把**按钮自己**变成「确认删掉」，第二次点才真做；点别处 / 按 Esc / 过 5 秒自动还原，
  整页同时只有一个「确认中」。为什么不弹窗：删一段、删一次拍摄、删一个角色是**连着点**的动作，
  每点一下弹一次模态框，页面节奏被打断一次，而且窗一关，焦点、滚动位置、正在看的那一段全得重新找回来。
  写法固定成两行（`if (Confirm.arm(btn, '确认删掉', { note })) return;` 在前，真做在后）——
  **第一次点必须 return**，否则会「武装的同时也删掉」。
  `opts.note` 是原来写在确认框正文里的**后果**（弹窗没了那几句话得留在眼前，用 toast 响在武装那一秒），
  **只写这次删除真正会连带发生的**：「会连带去掉 N 条拍摄」「N 段台词改由旁白念」这种；
  不影响这次操作的话（「文件不删」「素材库里还在」）一句都别写。
  花钱的确认（「一次拍 N 次」「重拍这 N 段」）**仍然用 `Confirm.ask`** —— 它们不是高频，且正文长。
- **武装态要经得起整块重画**：给 `Confirm.arm` 传 `key`（这一次的稳定身份，如 `takeId`），
  重画之后用 `Confirm.restoreArmed(key => 容器.querySelector('[data-tid="'+key+'"]'))` 挂回去。
  没有这一步，拍片记录那一列（每次进度回调都整块 `innerHTML`）会把武装态冲掉，
  表现是「点一下变确认、进度一来又变回 ✕、再点一下又变确认」。
  监听（`pointerdown` / `keydown`）装在 `document` **捕获阶段**，且目标在 `button.armed` 里就放过 ——
  那是第二次点击，得由 `arm` 自己处理（`disarm()` 后返回 `false` 放行）。
- **弹窗撤掉后，拦得住的判断必须从提示升级成硬拦**：`dropShot` 以前只把「这一段还在跑」写进确认框正文，
  现在按 `runningTakes` 真拒（与 `dropTake` / `remove` 同一判据）—— 提示会被错过，拒不会。
  页面自己账上在跑的那一层（`genHas('open'|'dub'|'shoot', sh.id)`）数据层看不到，由页面先拒。
- **本条与上面「失败原因要留在卡片上」不冲突**：那条说的是**持久状态**（这一条失败了，
  原因要留在卡片上直到重试）；这里的 note 说的是**这一次待执行的动作**，活 5 秒，toast 是对的载体。
- **用户能撤回自己造成的结果**：段、拍片、台词、整集都能删，**角色与场景却只增不减** ——
  AI 拆出 8 个角色，其中「路人甲」不要了却无处可删，而重名校验又不许再加同名，
  唯一的出路是回第 1 步重拆，把画好的 8 张脸、配好的音色全丢掉。
  `D.dropChar` / `D.dropScene` 与 `dropShot` 同一约定：**只摘掉这一集里的引用**，
  素材库那一条不动（那是跨剧复用的）；台词**不删**（可能还想要），只把 `whoId` 清空。
  同理，**改名要连素材库那一份一起改**（`pullInto` / `applyRoleSource` 都按名字认人，
  两边名字分叉就会造出第二个同名角色，而「存进素材库」按钮此刻是禁用的、补不回来）。
- **「手动新建」的东西别直接甩一个占位名**：`+ 加一个场景` 原来连点两次就造出两个都叫「新场景」的，
  而 `Lib.save` 按「同名 + 同类型」合并、`pullInto` 按名字认人 → 存库时两条塌成一条、
  「加入这一集」永远并到第一个。角色走 `charInfo`（有重名校验）绕开了这个坑，场景没有。
  现在按序号去重并接着弹改名框。
- **「看哪一条」与「用哪一条」是两个口径，不能合成一个变量**：舞台播的、字幕叠的、预演听的都是
  `takeAt`（`sh.takes[takeIdx] || curTake(sh)`，跟着人点的那一行走），而**段条状态、成片拼段、
  取上一段末帧**读 `curTake`（选用的那一条）。以前只有一个 `curTake`：点开「第 2 次」的详情，
  展开的是这一条、舞台播的还是选用的那一条，字幕也跟着错 —— 而「看」本来就不该改变「用」。
- **闸门要分档，「有一轮在跑」不等于「什么都干不了」**：`drama.html` 的 `genWhy` 按 `FLOW_EXCL`
  （独占轮：拆剧本 / 出预演 / 批量拍 / 出成片 / AI 定音色）与**旁听轮**分开判。
  `resume`（续等）是旁听轮 —— 它拿着**上次就已经提交出去**的任务号去问平台结果，一个字都不新提交、
  也不花钱，真正会撞的只有「再拍一次那几段」（`SHOOT_KINDS`：batch / shoot / dub / preview）。
  以前不分档：续等一开始（它是全页最长的一个等待，每条都有一轮超时上限）画脸、试听音色、
  角色资产、声音候选全被同一句「先等一下」按哑，而「停下」中止的又是**上一次**派出去的活，按了也白等。
  **新增整轮动作时往 `FLOW_EXCL` 里点名**；真的是旁听轮就别往里放。
- **失败原因要留在卡片上，不能只弹一次 toast**：`genUnit` 把错误传给 repaint
  （`repaint('')` 开始、`finally { repaint(err) }`），画脸 / 角色资产的回调据此写 `c.faceErr`，
  卡片上那一行红字才留得住；`voiceCandsHTML` 也不再把失败候选整个滤掉，而是留一条
  「有 N 条没出来：…」。以前 `repaint()` 不带参数，下一次重画就把原因擦掉了。
- **前置条件的判据不许和页面空态文案打架**：`prereqs` 原来把「这一段根本没有台词行」也算成
  「没有台词」并拦住开拍，而右栏那一格写着「这一段没有台词（纯空镜也行）」——
  该点的没点（留了台词行却一行字没填），不该拦的拦了（纯空镜不让拍）。
  现在只拦 `blankLine`（有行、全空），纯空镜放行。
- **清单类弹窗的按钮要按缺口分类各给一条路，不能只认一种**：`showPrereq` 原来只有 `fix === 'cast'`
  与「别的」两个分支，混在一起时（一位角色没画脸 + 某段台词空着）弹窗列出两条问题、按钮只把人
  丢进角色页，台词那条永远指不到地方。现在每条 prereq 自带 `fix` / `cid` / `shot`，
  按类别各出一个按钮，并把目标卡**滚过去闪两下**（`.dr-hit`）——
  十几张角色卡里让人自己找是哪一位缺脸，等于没指路。
- **链路接续会悄悄作废，要留得住「接的是哪一次」**：`take.linkFrame` 只是**一张图**，看不出它是哪一次拍的
  末帧。加 `take.linkFrom`（来源那一次的 id）之后，`Pipe.staleChains` 判得出
  「某段选用那一条接的还是上一段**旧**版本的末帧」（`linkFrom !== 上一段现在选用的那一条`），
  单段重拍完当场提示 + 给一条重拍，底栏与成片清单常驻一行。
  **只报，不拦**：接不接得上由用户定（也可能那一段拍得本来就看不出差别）。
- **文件名规则统一在 `Pipe.fileSafe` / `Pipe.takeName` 一处**：剧名是用户自己起的，
  可能带 `\ / : * ? " < > |`，浏览器会各自换成一个下划线或直接截断，下载目录里于是躺着一堆
  「第2次.mp4」看不出是哪一集。成片、字幕、单次拍摄三个下载都走它，页面不许自己拼 `(cur.title||'短剧') + …`。
- **「重拍」这类批量动作按段号收口到一份实现**：`reshootShots(nos, what)` 统一处理
  「确认每段都是一条真任务、单独计费」+「拍到上限的段（`takesLeft` 为 0）单独点出来并跳过」，
  然后交给 `shootAll(pick)`。`shootAll` 的 `pick` 参数就是「这一轮拍哪几段」：
  不传 = 还没选定画面的都拍（「开始拍」），传判据 = 「重拍没过的 N 段」。
  **链调度、接帧、并发、停下、收尾全都同一份** —— 另写一遍就会出现「批量能接帧、单段不能」。
  同一条链上**不拍的段只跳过、不抽掉**（抽掉「上一段」就接错了）。
- **图标几何只允许有 `ICONS` 一份，分工是「操作 → SVG，散文 → 字符」**：
  可点的动作（按钮 / 文字钮 / 芯片 / 段条上的加号）一律 `ICONS` 里的线描 SVG；
  `⚠ ✓ ✗ ● ?` 这类**句子里的状态标记**留在文字层 —— 它们出现在 `toast()` 与 `.ui-note` 的
  `textContent` 里，换成 SVG 只会显示成标签源码，而且和 `.toast .ic` 那个圆形色块、
  `.chk` 勾选框、`prereqs` 表格的 ✓/✗ 本来就是同一套语言。
  方向/chevron/关闭/复制/上下箭头这些几何以前**没有可复用的**，写不出来的格子会渲染成空方块
  （比 emoji 更糟 —— 看着像图标坏了），所以这一轮补了 `close` `check` `chevronDown/Up`
  `arrowLeft/Up/Down` `copy` `camera` `music` `importInto` `stepBack/stepNext`。
  **页面不许手写 path。**
- **带图标的按钮不能用 `textContent` 改字**：`textContent = …` 会把图标一起抹掉，不报错，
  只是「图标忽然不见了」，按钮从此变成一个没图标的口袋按钮。
  结构固定成 `<span class="ic">…</span><span class="tx">…</span>`，
  改文字走 `btnText(btn, txt)`、换图标走 `iconSet(btn, name)`（找不到 `.ic` 时整颗换掉 ——
  舞台那种只有一颗图标的按钮）。`ICONS` 缺的几何在 `icon()` 里**返回空串**，
  所以图标名写错的表现是「那一格空的」，不是报错 —— 新加图标后要过一遍「名字是否都在 `ICONS` 里」的核对。
- **按钮里塞了 SVG 之后，`e.target` 就不再是按钮本身**：点在图标上时 `e.target` 是 `<svg>` 或
  `<span class="ic">`，`e.target.dataset.xxx` 读不到（属性在按钮上）——
  短剧列表那个删除按钮原来是 `if (e.target.dataset.del)`，换图标之后这一下会掉进
  「打开这一集」那条路，看着就是「点了删除，结果短剧打开了」。
  统一先 `const b = e.target.closest('[data-del]')` 再从 `b` 上读；
  委托里已经 `forEach(el => el.onclick = …)` 绑好的那些（`data-a` / `data-act`）本来就读 `el`，不受影响。
- **`data-icon` 只能写在静态标记里**：`fillIcons()` 只在 `DOMContentLoaded` 跑一次，
  模板字符串里的 `data-icon` 永远不会被填上（`icon()` 返回空串 → 空的 `.ic`）。
  动态片段一律 `ic('name', size)`（drama.html / drama.js 里那个薄封装，默认带上 `<span class="ic">`）。
  踩过一次：拍短剧的**入口页**（`renderEntry()` 整页是 `body.innerHTML = \`…\``）里
  「AI 帮我完善」「上传剧本文件」和高级设置那个箭头都写成了 `data-icon` —— 三个图标**一个都没画出来**，
  按钮成了没有图标的口袋，而自检当时没抓到（正则写成「两个反引号之间」，模板里有嵌套反引号就漏了）。
  判据按**落点**来：`data-icon` 出现在任何 `<script>` 里 = 运行时拼出来的 = 死的。
  `.ic` 的 baseline 缝由 `ui.css` 的 `:where(button, .ui-linkbtn, .ghost, .tool, .pinl-opt) .ic` 消掉 ——
  用 `:where()` 保持零权重，`.toast .ic`（圆形色块 + 文字）、`.asset-slot .ic`（18px 图形）
  这些**装在 `.ic` 里但不是图标**的格子仍走各自的规则。
- **图标只套一层 `.ic`**：`ic()` 自己就产出 `<span class="ic">…</span>`，外面再包一层就成了
  `<span class="ic"><span class="ic">`，多一个盒子、padding 与对齐跟着漂（短剧列表的删除按钮踩过）。
  `bare=1`（裸 svg）只在**已经有别的外壳**时用 —— `.chev` / `.dr-pick small` / `.dr-seg .plus`
  这类布局容器是外壳，`.ic` 不是。两种错法都写进了自检。
- **页面级快捷键先想清楚「哪些时候不许抢」**，四条缺一条就是最招人烦的毛病：
  ① 焦点在 `INPUT / TEXTAREA / SELECT / contenteditable` 一律放行（连 `<select>` 也要 ——
  方向键是在换选项，不是切段；中文选词上屏那一下还会再触发 keydown，`isComposing` / `keyCode 229` 也要放行）；
  ② 带 `Ctrl / Alt / Meta` 放行；③ **焦点在 `button / a / summary` 上也放行** ——
  空格与回车是「激活这个控件」的键，刚点过「删掉这一次」时按空格应该是**确认删除**；
  ④ 灯箱开着或有 `<dialog>` 弹窗时放行（`← →` 在灯箱里是**翻候选**，两处一起响应就是
  「翻着候选、背后的段也换了」）。走带按钮点完 `blur()`，否则焦点留在钮上、空格会去重新点它。
- **纯读的导出不必过 `genWhy`**：花钱闸门只管「会再开一次生成」的动作。
  「导出整集剧本 .txt」是 `Pipe.scriptText(cur)` 拼纯文本 + `Net.save`，一分钱不花；
  正文拼在数据层（好单测），页面只负责变成文件。别为了「统一」给只读动作也套一道提示。
- **每个 `<select>` 都得有兜底项**：`<select>` 里一项 `selected` 都没有时，**浏览器默默显示第一项**，
  于是「存着的值恰好不在选项里」这件事在界面上完全看不出来 —— 看着写着「场景一」，
  数据与提示词里却是「不指定」，右栏说琪琪、真发出去的是旁白。四个成因连着踩了四次：
  ① `dropScene` 把 `sh.sceneId` 清成 `''`（所以选项里必须有真的「不指定场景」这一项，
  判据按「在不在清单里」而不是「是不是空串」—— 场景被删掉之后 id 也可能对不上任何一项）；
  ② `dropChar` 清了 `l.whoId` 却留着 `l.who`（判据统一走 `Pipe.lineSpeaker(drama, line)`：
  先 `whoId`、再按名字兜一层，都认不出返回 `null`，这时摆一项「未指定（按旁白念）」）；
  ③ 素材库带进来的时段是表外的值（`timeOptsHTML(s)`：不在表里就**照实列出来并选中**，
  既不骗人也让用户能直接改回表里的档）；
  ④ **入口页的画幅 / 画质是同一个坑的第四张脸**：`sel(id, list, cur2, missNote)` 原来只把
  「在清单里」的那些项画出来，存的值一旦落空就**默默退回第一项**（`readOpts()` 读到的也是第一项，
  用户上一部设的 16:9 被静默改成 9:16），而 `#advSum` 那句摘要还在念旧的 16:9 —— 两处自相矛盾。
  现在 `sel()` 自己兜底：当前值不在列表里就**照实列出来并选中**，后面括一句 `missNote`
  （入口页传「这一家没声明，拍的时候自动对齐」）—— 这是**故意保留**用户上次的选择，
  与①②③那种「值已经失效了，摆一个兜底项」不同，所以文案要分开写。判据已进自检第 ⑦ 档。
- **反过来：一个 `<select>` 里也只能有**一个** `selected`** —— 浏览器的规则是
  **最后一个带 `selected` 的赢**（不是第一个、也不报错），于是
  `ladder.map(s => \`<option ${custom ? '' : ' selected'}>\`)` 这种「条件里不看循环变量」的写法
  会让整列选项全带 `selected`。踩过：整集时长那个下拉 `ladder = [60,120,180,300]`，
  上一部存的是 60 秒（1 分钟），`custom` 为假 → 四项全带 `selected` → **选中 300**：
  界面上摆着「5 分钟」、`readOpts()` 读到的也是 300（**点「开始」就建出 5 分钟的剧**），
  而高级设置的摘要照实写着「1 分钟」—— 用户一次都没碰过，两处却已经对不上了。
  正确写法是 `s === curSec ? ' selected' : ''`。判据是自检第 ⑦-b 档：
  **`.map(IDENT => …)` 里每处 `selected` 所在的 `${…}` 条件都必须提到那个 `IDENT`**
  （只看「回调体里有没有这个变量」不够 —— `value="${s}"` 也含 `s`，会整个漏掉；
  外层 `g.map` 套着内层 `m.map` 时要先把内层挖掉再看外层）。
- **「现算出来的那一行字」在依赖还没就绪时不能先摆一个兜底值**：`paintSecs()` 那一行是
  `readOpts()` 现读下拉得来的，而能力声明没回来时**下拉整个还不存在** —— `readOpts()` 全部落到兜底，
  `duration` 取到 `bounds.min`（视频平台最短的一档），于是先摆出「整集目标 4 秒」：
  一个用户从没选过的数，还比真值小十几倍。`paintOpts()` 早就有 `if (!capsReady) …` 的守卫，
  **`paintSecs()` 漏了同一句** —— 凡是「读界面上的控件」算出来的显示，守卫要一起加。
  （caps 回来后 `renderEntry()` 会自己重跑，所以等一下就好，不需要轮询。）

