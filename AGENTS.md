# AGENTS.md —— 在本项目里干活前先读这几条

本项目是一个**本地优先的 AI 创作工作台**：纯前端页面 + 一个本地 Node 代理（`proxy.js`，默认 `http://localhost:5175`），
所有生成平台都通过代理转发。页面：导演台 `director.html`（旧名 `index.html` 已删除，旧地址不再能打开）、**生成工作台 `studio.html`（视频 / 图像 / 语音三合一，2026-10 合并；旧
`video-gen.html` / `image-gen.html` / `audio-gen.html` 已删除，`/video.html` 之类的旧短名与 `?t=video|image|audio` 别名仍能打开）**、
素材库 `chars.html`（**拍短剧 `drama.html` 2026-10 已删除**，那一整套页面与它的后端 `drama.js` 一并清掉；`drama.js` 瘦身改名成 `chars.js`，即素材库的后端）、资产库 `assets.html`、收藏 `favorites.html`、设置 `settings.html`、用量 `usage.html`；
公共模块：`ui.js`（Net / Toast / Store / DataSync / Dropdowns / Confirm…）、`assetlib.js`（Api / AssetLib / Capabilities /
AssetTransfer / TextAI / PromptLog）、`workbench.js`（Wb：任务状态 / 轮询器 / 灯箱 / 历史 / 大文件）、`sidebar.js`、`app.js`、
`ai-chat.js`（AiChat：外壳层那一份 AI 助手 —— 可拖动悬浮球 + 右侧抽屉，只读查询本机数据与平台能力，写入动作只在用户点「执行」的确认卡片后才做）。
详细说明看 `README.md`，本文件只列**必须遵守的约定**；§3 / §3.1 / §6 / §7 四节的全文拆进了 `docs/agents-*.md` 三册，本文件那几节保留每一条约定的标题行当索引（各节末尾有指路）。
**新增一条约定时写到哪**：§1 路由、§2 能力驱动、§4 密钥与用户数据、§5 自测纪律 → 直接写进本文件对应一节；
§3 / §3.1 公共层与界面（含 `tests/selfcheck.cjs` 那套判据的口径）→ `docs/agents-公共层与界面约定.md`；
§6 平台事实 → `docs/agents-平台事实.md`；§7 第三轮起新加的约定 → `docs/agents-第三轮约定.md`。
**搬进分册的那几节要同时在本文件补一行标题索引**（否则下一轮的人看不见那条红线），写完全册再回来这里点名。

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
- **「这一家能不能撤单」的判据只有 `Api.canCancel(prov)` 一份**（看注册表有没有声明 `cancel` 端点）：
  没声明的那几家（MiniMax / 硅基流动 / 智谱视频，以及照它们克隆的自定义中转）**不许画一颗能点的取消按钮**
  —— 点了什么都不会发生，等于承诺一件做不到的事。生成工作台画一颗压暗的并把原因写进 title（`Wb.cancelWhyNot`），
  导演台删还在跑的短片时那句「删掉会顺带撤掉这个任务」换成「这家没有取消任务的接口：本机删掉之后，
  平台上那一条还是会跑完」。都是「承诺要么实现、要么改文案」这一条的落地。
  行为探针 `.tmp-cancel.cjs`，破坏它一次的变异脚本 `.tmp-mutcancel.cjs`。
- **哪些平台支持幂等键由 registry 声明**：`create.idempotencyKey`（默认 true）。SparkCine 必须 true（不带会 400）；
  VGENV / MiMo 是 false。**没有幂等键的 POST 一律不自动重试**（见 `ui.js` 的 `Net.fetch`）——
  否则「请求已到、响应超时」时重试会重复建任务、重复扣费。新平台若支持幂等去重，显式写 `idempotencyKey: true`。
- **提交体顶层的布尔开关声明成 `create.topBools`**（不进 `parameters`）：`{ 字段名: {label, hint, def} }`。
  页面只为声明了这一项的平台渲染那个开关，平台没有就不出现；值随 `params` 一起提交，
  `Api.createBody` 按这份声明把它放回顶层（混进 `parameters` 平台会拒）。
- **`pricing.endpoint` 是「这一型的价从哪来」，不是「型号清单在哪」**（`assetlib.js` 的 `estimateCost` / `liveModelsOf`）：
  四种 `pricing.type` 里只有 `per_image_table` 与 `per_second_table` 那份实时表要现拉（它们的 `endpoint` 就是 `models`）；
  **`quote` 这一型一分钱都不从那张表读** —— 它的价来自实时报价那一次调用。VGENV 声明的 `endpoint` 是
  `quote`（`POST /v3/videos/quote`），以前不分类型先拉一次，等于把报价接口**当型号清单 GET 了一遍**：
  上游回 400 → 抛错被 `try` 吞掉 → 而失败**不落缓存**（60 秒 TTL 只挡成功那半边）→
  于是每次估价（导演台每改一次时长、每次重渲染）都白打一趟平台接口，界面上一个字都不显示。
  两条纪律：**新加一型定价先想清楚「实时表在这一型被读了几个字段」**（判据是 `estimateCost` 下面有没有读
  `liveEntry` —— 现在只有 `per_image_table` 与 `per_second_table` 两处，写成**白名单**而不是「除了 quote 都拉」，
  否则第五型又默认继承一次没人读的请求），
  并且**取价失败也要进缓存**（记 `list: null` 再照原样抛；调用方本来就会退回注册表声明的价，
  不记就是每次都往一个正在挂掉的接口重问）。常驻判据是 `.tmp-loadcheck.cjs` 那三条：
  「不轮询任务接口」「报价端点只按声明的方法问（不许被当成清单 GET）」「只按跑了几个文档问价（一次重渲染不重发）」，
  并由 `.tmp-mutquote.cjs` 把那一句白名单退回无条件拉取来证明它们真的会红。
- **导演台「画面生成」（时间切片用的那张图）的参数与参考图，口径与生成工作台图像栏同一套**（2026-10 补上，之前那条路只发 `quality`）：
  四档（画质 / 画幅 / 尺寸 / 格式）**全部现读生图型号自己的 `options`**，平台没声明的那一档整档不画、一个字不发；
  提交体、折叠摘要、归档日志都从同一份 `kfGenOpts(sh)` 派生（`kfAdvSumOf` 调它问一次「真的发出去 ar 没有」），
  **不许出现「摘要写着随这一镜 16:9、请求里压根没有 ar」**；显示名也只有一份（`kfFmtLabel` —— 踩过下拉写 `png`、摘要写 `PNG`）。
  「跟随这一镜」是一个**真取值**（空串），不参与「回落到默认档」，但只有在**这个生图型号也收这一比例**时才成立
  （借上一镜视频的 `ar` 发出去必被拒，这正是本轮修掉的那件事）。
  参考图的上限读**生图型号**的 `reference_image` 声明（不是这一镜视频型号的 `ic.maxRef`），
  且三种情况都要当场说话：超上限少带了几张、这个型号压根没有该槽位、转存失败的那几张 ——
  「点了生成」配一句「已带上参考图」而实际什么都没发，是本项目反复拦的那一类。
  常驻判据：`.tmp-kfadv.cjs`（把真函数抠进 vm 跑口径）+ `.tmp-mutkfadv.cjs`（16 个变异逐条证明会红）
  + `.tmp-kfshot.cjs`（headless 真 DOM：整档显隐、每档恰好一个 `selected`、摘要覆盖画出来的每一档、换型号后旧值不留在 option 里、折叠态落盘、三排在真 DOM 里画得出 / 接得上 / 读得回）。
  后一支要**先起隔离代理再开页**，且必须在开页前挂 `window.__SB_SHELL = 1`（`sidebar.js` 会把直接打开的内容页 replace 进外壳，
  evaluate 打到的是外壳那一份文档 —— 看着像「页面没画出来」，其实是尺子没对准）。
  真 DOM 那一组的反向对照是 `.tmp-mutkfshot.cjs`（4 刀：磁贴不画 / `hidden` 不跟声明 / 整排不接线 / 读回来却不进提交体）——
  **不要把它并进 `.tmp-mutkfadv.cjs`**：那一支跑 vm 沙箱，够不着「容器藏着 ⟺ 里面一颗控件都没有」这种只在真浏览器里成立的性质，
  合一支的结果是两头的判据都变成含糊的「文件里有没有这个符号」。
- **导演台的两条提交路径（这一镜的视频候选、时间切片用的那张画面）都必须带上「`AdvParams` 四档之外」那三排**（型号布尔 / `create.topBools` / `create.shapeFields`，2026-10 补齐导演台）：
  判据、画法、读回全在公共层 `window.AdvExtras`（`visibleCount` / `html.*` / `read` / `boolsFromDom`），页面只摆 DOM 与接线 ——
  以前导演台整块没有这三排，同一个平台在生成工作台能勾「平台自动润色」「Turbo 档」「超分」「随机种子」，在这一镜上连控件都不画、提交体一个字都不发。
  三条不能破的性质：**① 出现与否按声明数**（被形状上下文藏掉的那一项不占数，四档全空但声明了顶层开关的型号那一块也要出现）；
  **② 摘要与归档跟着提交体**（`advSumText` / `kfAdvSumText` 都是现问 `AdvExtras.read`，折叠状态下那句「现在按什么出」不许少一项）；
  **③ 越界的值在提交之前拦**（种子声明 0–100 却填了 999 → 抛错并点名是哪一项，而不是发给平台等一句 400）。
  「界面画出了开关、提交体里没有那一项」与反过来的「发了而摘要没写」在本项目算同一个缺陷的两半，常驻判据是 `tests/selfcheck.cjs` §J 第 ⑭ 支
  （定义数恰好 1 + 页面不许自写同名判据 + 每个页面确实走了 `AdvExtras.read` / `boolsFromDom`），注释里的示例名有豁免。
- **「一次请求能同时用哪几类素材」是平台声明的一族档位，全站只有一份读法**（2026-10 补：VGENV 的 `configurations[]` → 导演台与生成工作台都能选「输入模式」）：
  归并、命名、说明行、芯片排的 HTML 全在 `assetlib.js` 的 `Capabilities`（`combos` / `comboOf` / `comboLabel` / `comboScopeNote` / `comboChipsHTML` /
  `comboGaps` / `comboCovering` / `fallbackCombo` / `shapeState`），页面只摆容器与接线。四条不能破的性质：
  **① 名字与数量现读**（「视频换人」要上游列过 `person_replacement` 才有那一颗；不带意图的几档并成一颗「智能参考」，它的 `min` 只数「每个源档都要求」——
  fl2va 要求首帧而 ref2va 不收首帧，取 `max` 就把纯文字那一档被自己人拦住；这一条真抓取数据打不出，常驻合成形状 `.tmp-combo.cjs` 的 `checkMinMerge`）；
  **② 判据双向**（缺料 `min` / 超料 `max` / 这一档不收 / 互斥成对，四种一次判全并把人话拼在 `comboGaps().lines`，两页读同一份 —— 只读缺料那一头就是用户点名的缺陷）；
  **③ `mode` 不是提交字段**（并档那颗 `mode:''`，真字段只有 `creation_intent`，多发一个 `mode` 必被平台拒）；
  **④ 查不到那一行就给 `known:false`**（`shapeState` 不猜字段：清单里没有的素材组合不该被界面拼出一份「看起来能用」的参数）。
  「按钮禁用」在导演台有**三个落点**（整栏重画 / 切候选刷提示词框 / 逐字敲描述），三处必须问同一个 `shotBlockReason` ——
  后两处以前自己写成「描述非空就点亮」，于是换人档敲完字按钮就绿了、点下去才拿到 422。全文（含排版那一排落在哪、四支探针怎么跑）在 `docs/agents-公共层与界面约定.md` 的「输入模式那一排在两页的落点与排版」。
  常驻判据两对：口径层 `.tmp-combo.cjs` + `.tmp-mutcombo.cjs`（10 刀）、真 DOM 层 `.tmp-combodom.cjs` + `.tmp-mutcombodom.cjs`（5 刀，每刀点名期望的红条编号）。

## 3. 复用公共模块，别各写一套

（**这一节的正文搬到了分册**：下面每条只留标题行当索引，红线照旧每次都要看到；全文、判据口径与探针在哪，看这一节末尾的指路。）
（**另有几条在原文里是段落而不是列表项，拆分时不会被自动收进索引，手抄在这里** —— 它们是本节最常被引用的一批红线：）
- **跨闭包调用只走 `window` 上的公开接口**：闭包内定义的函数只在闭包内用；页面内联脚本也不要顶层 `function esc()`（会盖掉 `window.esc` 造成无限递归，表现为整页静默空白）。同一个闭包里兄弟函数裸调局部的 `const` 同样是炸点（`drama.html` 踩过 `bind`）。
- **同一个功能只应有一份实现**：下拉 `Dropdowns`、网络 `Net`、任务轮询 `Wb.poller`、历史 `Wb.History`、媒体地址 `Api.mediaSrc`、跨平台素材 `AssetTransfer`、IndexedDB 只走 `Kv.at(登记名)`、芯片行 `Chips.render`、缩略图 `Wb.thumbs`（外壳标记也只有一份 `mediaHTML`，画出来必须 `bind`）、详情 `Wb.detail`、卡片列表 `Wb.cards`、分页 `Wb.pager`（续拉的判据在公共层）、灯箱 `Wb.lightbox`、下载 `Wb.save` → `Net.save`、本机落盘 `AssetLocal`（含 `hideAsCloud` 那张闸）、就地二次确认 `Confirm.arm`、弹窗 `UiDialog`、提示 `Toast`、**「四档之外」那三排声明驱动控件** `AdvExtras`（判据 / 画法 / 读回，见 §2 那两条）。发现重复实现 → 收敛到公共模块，别复制。
- **「这一镜能不能生成」的落点有几处，判据就只有一份**：导演台那三个落点（整栏重画的模板 / 切候选刷提示词框 / 逐字敲描述）都走 `shotBlockReason`（公共入口 `syncGenGate`），页面不许留第二套「描述非空就点亮」。空提示词与缺料是两句话，各占一行不合成。
- **栏目标签那一格不许被压缩**（`.ed-label > span:first-child { flex: none }` 只在 `ui.css` 一份）：右边那句说明现在是现读能力声明拼出来的，可以很长，压下去就把「输入模式」挤成一列一个字；「输入模式」那一排还排在素材区标签**之前**（判据比的是标签节点，不是槽位）。
- **素材区那一排与两页的排版只在真 DOM 里成立**：常驻判据 `.tmp-combodom.cjs` + `.tmp-mutcombodom.cjs`（5 刀，每刀点名期望的红条编号；两页源码是 CRLF，变异锚点只能取单行）。全文见 `docs/agents-公共层与界面约定.md` 的「输入模式那一排在两页的落点与排版」。
- **素材身份判据只有一份，在 `ident.js`**（浏览器与 Node 双模式；引 `assetlib.js` 的页面必须先引它，§D 守着）；合卡规则同样只有一份（`collapseInto`）。
- **导演台的短片轮询与外链回源也已接进公共实现**：节奏归 `Wb.poller`、回源归 `Api.healMedia`，页面只给适配器与文案；行为探针 `.tmp-dpoll.cjs`（九件事，含「每一轮拿到的壳对象是同一个」）。
- **导演台左栏「场景图」那一层只回答「图从哪来、这句要不要说」**：能不能收参考图 / 第几张 / 是不是重复，一律走 `addLibPicToShot`，不在这里重写第二份（优先级：左栏挑的 → 素材库同名那条 → 没有；`sc.noPic` 是「连库里那张也不认领」，不是清空 `sc.img`）。
- **「同一个场景」只有一把尺子（`nameKey`），落点只有一个（`placeScenesInto`）**：AI 分镜追加与「手动拆分（`#` 换场）」两条路共用它；同名**并进那一场**（push，不覆盖、不压平），场景图归属以**目标那一场**为准且只喂这次新建的镜头，返回 `at` 给调用方放光标。
- **顶部那行结果只写一次（两句拼成一行），带不上的原因走 `Toast.warn`**：`Toast.ok` / `Toast.info` 默认被 `sk_quiet_ok` 静音，拿它当唯一出口等于一个字都没说出去；「本来就没图」不吭声，「型号没有槽位 / 互斥 / 超上限」必须吭。
- 这一层的四支探针：`.tmp-scene.cjs`（vm 口径）+ `.tmp-scenedom.cjs`（真 DOM 接线，含「改名时打字框节点不换」）+ `.tmp-mutscene.cjs`（26 刀反向对照），探针每次开跑**先复位**那几个场景的 `img` / `refImages`（工作区会落进 `.data-probe/`，脏底座会让第二轮假红）。
- **真 DOM 行为探针有两个坑：等页面「采纳完」不能靠 sleep（DataSync 对账会 `reload()` 把探针正打着的文档整个换掉 —— 等法要有判据：`__synced_*` 旗标 + 种子读数 + `performance.timeOrigin` 连续 1.6s 不变），造数用 `PUT /data/<key>` 种子 + 克隆平台声明注入 + 花钱口子焊死**。常驻样板 `.tmp-gennew.cjs`（导演台生成闸 22 条，含「重画后按钮仍禁用」「强行点亮再点只算一次」），跑法与全貌在分册「跑 headless…」那一段。
- **导演台「生成这一镜」的防重复扣费是两道闸、判据只有一份**：① 模板 `#genOne` 按 `canGen && !genOneBusy` 渲染 disabled（`pushPlaceholders → renderAll` 换掉 DOM 后新按钮同样压暗）；② handler 入口 `if (genOneBusy) return;`（`genOneBusy=true` 在入口设、`finally` 复位）。「已有视频再点生成」的分支（`shotHasVideo → spawnCandidateShot` 新建候选镜头并挂占位）就走这两个闸后面 —— 往 `#genOne` 模板或 handler 里加任何新分支，先想清楚这道闸还盖不盖得住（`.tmp-gennew.cjs` 的 ④/④b/⑧/⑩ 就是钉这三条）。
- **导演台剪辑（本镜 / 全片轨道）的账只有一份 `c.segs`**（切开 / 向左切 / 向右切 / 删段 / 不剪了五个入口同走 `segsOf`/`segsWrite`，本镜与全片两处读同一份 —— 剪一刀两处同时变；配音 `{seg, at}` 跟着重算）；常驻探针：口径 `.tmp-cut.cjs`（24 条）+ 真 DOM `.tmp-cutdom.cjs`（25 条，含右栏换声音栏、轨道铺切片图、删段武装态）+ 反向对照 `.tmp-mutcut.cjs` / `.tmp-mutcutdom.cjs`。**「型号清单首败要刷新」的同源 GET 退避重试**同层还有一支：`.tmp-capsretry.cjs`（CDP Fetch 域掐断开页第一发 `/capabilities`，判据 = 页面自问一次 + 清单与对照趟一致 + 零平台 POST）+ `.tmp-mutcapsretry.cjs`；底座与跑法在分册同节。
- **模板那一族（`create.template`，MiMo 就是）的提交体只认识模板里写过的 `{{…}}` 键**，所以声明出来的 `create.topBools` 顶层开关会在 `Api.create` 里按声明补回顶层（公共层一处，页面不判平台）—— 少了这一段就是「开关照样画出来、勾了却一个字都不发」。
- **主题变量（`:root` / `html[data-theme="dark"]`）只在 `ui.css` 顶部定义一份**：页面私有变量漏定义 = `var()` 静默取不到值（「变量存在但值为空」不会触发回退）。
- **新增一个页面只改三处**：`app.js` 的 `PAGES`、`sidebar.js` 的 `items`、`ui.js` 的 `PAGE_TARGETS`，代理零改动；漏一处的表现各不相同。
- **跑 headless / 自动化测试前先给 `.data/` 落基线**：`--user-data-dir` 不等于隔离数据，`Store.write` 会镜像进代理的 `.data/*.json`；没设过的键也会被写。
- **写判据与临时脚本时的几条纪律**：读数与预期相反**先怀疑仪表**（先证尺子再信读数）；每档写完都要把它破坏一次确认它真会红，**变异后仍全绿 = 这一档是假的**；一次性迁移脚本**第二次跑会把自己上一轮的产物当成原文覆盖掉真东西**（本轮就踩过：拆分脚本再跑一次，三册正文被索引重写了一遍）。`atob→Uint8Array` 那批「临时扫描脚本自己撞的坑」逐条在分册 §3 那一段里。
- `/save`：镜像流程内部（`assetlib.js` 的 `runOne`）顺手多写一份，只挂在那一处（§F 守着）。
- `/save-local`：补存。字节已经在 `.assets` 里，直接拷一份，不重新下载、不回源、`.assets` 那份一律不动（§G 守着）。它存在是因为上面那条链先被那道守卫挡在前面 ——开关打开之前下载的那批永远不会被补写，用户把开关打开、目录也填对了，目录里还是空的…
- `/save-move`：搬。换下载位置时把旧目录里那些副本挪过去，会删源文件。与补存分成两条路由、两种返回，页面才能分别告诉用户「哪些是复制、哪些是搬走」。
- 顺序永远是先搬后补：反过来会出问题 —— 补存把旧的又拷了一份到新目录，紧接着搬迁再搬一份，同一个视频在新目录里就是两份（撞名的那个还带 `-2`）。
- 四条硬约束（各有一条判据守着，别在调用点另写一遍）：① 目录只从配置读，请求体里带 `dir` 一律忽略（与 `/save` 同款立场，§G）；② `/save-move` 的来源必须过 `autosaveUsedHas`（`.data/sk_autosave_used.json…
- 设置页的提醒只在勾开关 / 改完路径 / 挑完目录时触发，绝不在 `oninput`（逐字输入）时触发：打一个字弹一次框，而且那时的目录多半还是半个。
- `.assets` 是资产库的本体，不是另存的源：`/save-local` 只拷不删、§G 守着；而且本机文件真没了还有三级回退（代理 `/asset/<id>` 本地优先 → 索引里的 `upstream` 重下 →问平台 `assetInfoOf()` 要地址），所以「搬走…
- 读与写是两张表：`TOOLS` 里全是 GET 与本机读（`overview` / `tasks` / `history` / `models` / `model` / `chars` / `fav` / `assets` /`prompts` /…
- 助手提交的任务由外壳自己等（`ai_chat_watch`，`K_WATCH`）：`runGenerate` 拿到任务号就 `addWatch`，`watchTick` 每 `WATCH_EVERY`问一轮，判据只有 `probeWatch` 一份（轮询器与 `tasks` 查询…
- 动作必须先过确认卡片（误触一次就是真金白银的重复扣费，见 §4）：`RUN:` 解析出来的动作校验全部做完才画卡片（型号属于哪家、参数取值在不在声明里、槽位上限、素材从哪来），卡片画出来时用户点「执行」才真提交 ——卡片上写明「哪一家 / 哪个型号 / 什么参数 / 哪些素材从哪…
- 附件的凭据只有本机地址：`CALL: files` / `read_file` 与动作里的 `inputs` 只认 `/asset/`、`/getv/`、`/local-assets/`，外部直链一律拒（递出去的是「这个文件在哪」，不是「随便替我访问一个网址」）。
- 设置项只有白名单（`ADJUST` 那几项 + `window.PAGE_TARGETS` 的行 + `sk_model_<kid>` + `chars.js` 的 `Chars.SET` 那几项）：`writableKeys()` 是现读这几张表拼出来的，不是手抄的键名清单 ——…
- 助手自己在界面上挑的那一家 / 那一个型号只存 `ai_chat_pick`，绝不写 `sk_text_prov`（「作用文字 AI」是设置页「点保存才生效」的动作，替用户改就等于把他选的供应方换了）。
- 流式进行中不许「清空」（`paint()` 会把正在往里写字的那条气泡一起清掉 —— 字丢了，请求还在跑、还在扣 tokens）；断开这一层（刷新 / 关掉外壳）时 `pagehide` 要把已经写出来的字落盘，并写明这次断了。
- 抽屉里「贴到底」的账只有一份，而且要在布局落定之后算（`paint(jump)` 的三种贴底条件 + `note()` 在改布局之前取 `atBottom`、显示完再按新视口贴一次）：`#acNote` 那一行一显出来就把 `.ac-body` 吃掉 26px，「贴完底再补一句回执」的顺序于是停在底部上方一行多 —— 最后那句看不全。判据 `.tmp-acnote.cjs` + `.tmp-mutacnote.cjs` 第 ⑥ 刀…
- 对话记录是会话表（`ai_chat` = `{v:2, cur, list:[{id,title,at,msgs,acts}]}`），不是一条扁平数组：`msgs` / `acts` 仍是模块级变量，切换会话时 `bind()` 整体重新指向当前那一份 —— 现有 `msgs.p…
- `watchTick` 整轮包 try/catch，而且无论成败都要再排下一轮：以前 `startWatch()` 是最后一行，读清单 / 探状态 / 写结果里任何一处抛错，轮询链就静默断掉 —— 球上一直显示「在等 N 条」直到刷新，而任务其实早就好了。
- 输入框：Enter 发送、Shift+Enter 换行。`e.isComposing || e.keyCode === 229` 要放行 ——中文选词上屏那一下还会再触发一次 keydown，挡不住就是「刚选完字直接发出去」。placeholder 与 AGENTS/README…
- `/sys-status` 只有一份取法与一份说法（`assetlib.js` 的 `Api.sysStatus(fresh)` / `Api.sysTool(t)` / `Api.sysDir(d)` /`Api.sysStatusLines(s)` / `Api.SYS_WH…
- `.tool` 磁贴的显隐要用 `hidden`（`ui.css` 里有 `.tool[hidden] { display: none; }` 这条兜底）：`.tool` 自带 `display: inline-flex`，会和浏览器默认的 `[hidden]{display:n…
- AI 润色是两段式，就地问（`ui.js` 的 `InlinePolish.interactive`）：页面只提供两个回调 —— `ask(): Promise<{need, questions[]}>`（问要点）与 `run(answersText): Promise<{aft…
- 润色要把用户的素材交给 AI（已实现，别再退回「只说一句」）：`TextAI.polishImages(REG, [{label,src}])` 把参考图压到最长边 1024 的 JPEG、按 OpenAI 多模态格式附在消息末尾，并写明「图1 = 参考图 1」；只有识图型号才带…
- AI 指令的默认文本只有一份：`assetlib.js` 的 `TextAI.DEF`（video / img / audio / story / split）+`TextAI.prompt(kind)`（用户改过的优先）。
- 别把 A 的密钥发到 B 的地址：文字 AI 的自定义地址按供应方各存各的（`sk_base_<kid>`），但很容易在「供应方 = DeepSeek」时把 OpenRouter 的地址填进去 → 请求带着 DeepSeek 的密钥打到 OpenRouter，上游只回一句 `Yo…
- 统一选择器把规则显示出来并强制（`assetlib.js` 的 `AssetPicker.open({ rule })`）：`rule` 就是 `Capabilities.rule(模型, role)` 的原样（`max` / `accept` / `maxBytes`），弹窗顶…
- 单选也走同一条路：点选 → 底部「确定」（`build` 的 `d.onclick` 里单选分支只 `picked` + `syncSel()`）。
- 本地上传的条目必须 `pick.addMany(...)` 进同一个 `picked`（`ui.js` 的 `PickSel` 为此加了 `add` / `addMany`，返回真正加进去的个数）。
- 计数条是两条通道，别都直接写 `#apCnt`：`syncSel()` 写常驻的「已选 N / 上限」，`say(t)` 写一次性说明并在 4 秒后自动让位（句柄记在 `noteT`）。
- 本次上传的本地文件不进 `IntersectionObserver` 的队（`if (io && !e.fromLocal)`）：它们的 `src` 是 `blob:` 地址、字节已在内存里，再等「滚到附近」只会一直显示占位符 `…`。
- `multiple` / `limit` 要按「这个槽位还剩几格」开，不是按槽位总容量（两者不一样）：数据模型只存一条的槽位（导演台的参考视频 / 参考音频、生成工作台语音栏的参考音频，提交体是单数字段）即使平台声明 `max > 1` 也要传 `limit: 1` 并把 `ru…
- 「确定」必须走 `finish(entries)`，不能直接 `close(entries)`：`finish` 除了 resolve 还会对每个条目调一次 `o.onPick`。
- 选择器网格的媒体要走自己的调度器，别一建卡就把 `<img>`/`<video>` 塞进 DOM（慢的根因）：`build()` 只画 `.ap-wait` 占位（卡片立刻能看、能点、能多选），`IntersectionObserver`（root=`.ap-body`，root…
- 媒体一律用 `Api.mediaSrc` / `Wb.thumbs.mediaHTML` 出地址，缩略图缓存键走 `Wb.thumbs.keyOf` 归一化。
- 写进本机记录的地址必须是「记得住的」地址，`blob:` 与上游签名外链都不算（2026-10 素材库踩过）：选择器（`AssetPicker`）递回来的条目有两种地址是「当场能用、过后就没了」—— 本地上传那一张是 `blob:`（刷新即失效），资产库 / 收藏那一张多半是包着…
- 文本要转义：凡是插进 `innerHTML` 的用户文字 / AI 文字都过 `Chars.esc()`（或页面自己的转义函数）。
- 文字 AI 的调用要按「下拉里选中的供应方」：`TextAI.models / chat / vision / visionAsync / verifyKey`都接受显式的 `prov`（设置页传 `curTextProv()`）。
- `REGISTRY.version` 是「代理新不新」的判据：改了注册表结构就 +1，`Api.registry()` 取回注册表时顺手调`warnOldProxy`（版本低于 `PROXY_VERSION_MIN` 时每个标签页提示一次「本地代理是旧版，部分能力声明不生效，请重…
- 文字 AI 是多家供应方（`TextAI`，默认 OpenRouter）：选哪家存 `sk_text_prov`，密钥 / 基址 / 型号按`keyId` 各自存（`sk_key_<kid>` / `sk_base_<kid>` / `sk_model_<kid>`），用户自己填…
- 自填型号「串台」的根因是静默兜底键，不是存储层没分家：`sk_text_models_<kid>` 一直按 `keyId` 存，内置两家与自定义条目之间本来是隔离的；出事的是 `customKey(null)` —— 只要 `provByKid(kid)` 有一刻返回`null`…
- 文字 AI 现在是 9 家 OpenAI 兼容供应方（OpenRouter / DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 硅基 / 火山方舟 / minimax）。
- 侧栏余额：勾选框一律画，没接口的也画（`sk_text_vision` 之外的用户已确认过的取舍）。没有 `credits` 端点的那张卡给 `.krow .sbshow.dim` 压暗 + title 写「这家平台没有提供余额查询接口，勾了也不会显示余额」——勾了不显示，好过连…
- 生成类也有两家 OpenAI 兼容的了，声明方式写在 registry 里，页面不按平台 id 分支：
  - 图片 `create.sync`（`{ items, url, b64 }`）：`POST {base}/images/generations` 同步返回、没有任务号可轮询（`Api.syncMedia` 取产物 → `saveSyncImages` 取回字节存本机 → 刷列表）。
  - 画幅有两套参数：`ar`（比例 `16:9`）与 `size`（`1024x1024`）是两种东西，混发必被拒。页面为此单开一列「尺寸」（`sizeWrap` / `#size`，只渲染 `options.sizes`），标准字段 `size` 在`Api.createBody`…
  - 语音 `tts.encoding:'hex'`：MiniMax `t2a_v2` 的 `data.audio` 是十六进制（官方 WebSocket 指南明确说「用十六进制解码，别当 base64」），而 `/local-assets` 收 base64，页面按这份声明转换；文档…
  - 语音台以前只服务一家（`provGroups()` 里 `slice(0,1)`），加第二家语音平台时下拉里根本选不到它 ——现在按平台分组渲染（与图片/视频台同一种形状），`liveModels` 改成按 provider 分桶 `{ 平台id: [型号] }`（以前是一份全局…
  - `refreshCaps()` 换到没声明能力接口的平台时必须把上一家的 `capHint` 清掉：不清的话面板上会同时挂着「能力来自上游接口（缓存）」和「该平台没有声明能力接口」，两行自相矛盾。
  - 本机资产库（`local:/local-assets`）是多家平台共用的一条列表来源，条目自己记着是谁生成的（保存时写进 `provider`）。
- 设置页统一「点保存才生效」：任何控件的改动先只改表单 + `markDirty()`（保存按钮点亮成待保存色），落盘全在 `saveAll` 里一次做完。
- 设置页最上面那条栏目栏是从 `.page-main > .card` 现读的（标题取每栏自己的 `h2`，收起着的卡不占位）：新加一栏不用改那里 —— 手抄一份标题清单迟早和页面不一致（同一类的错还有「下拉写死 png/jpeg」「音色写死声音 1/2/3」）。
- 内容页 → 外壳只有一条主动通道：`app.js` 的 `wb:close-sb-overlay`（窄窗浮层侧栏「点内容区关闭」）。
- 别在页面里手搓弹窗：自定义内容的弹窗走 `ui.js` 的 `UiDialog.open({title, sub, body(el), actions})`，它复用 `Confirm` 那一套 `.pr-*` 外壳，全站只有一份弹窗外壳。
- `PromptForm` 要「选了这一项，别几项跟着改口」只有一条路：传 `onChange(key, api)`。公共层不认识具体语义，它只交出三个口子 —— `api.values()` 读现在的值、`api.set(key, {label,placeholder,hint,…
- 主题变量（`:root` / `html[data-theme="dark"]`）只在 `ui.css` 顶部定义一份，页面不要再抄（2026-10 收拢，见上面「提示组件只有 `Toast` 一份」那段的纪律）。
- 通用小组件用 `ui.css` 的公共类，别在页面里另写：`.ghost`（次要按钮）、`.tool` / `.tool.acc` / `.tool.danger` / `.tool.on`（动作磁贴）、`.ui-seg`（分段开关：声音 1/2/3、时段）、`.ui-pill`…
  - `Chars.Cast` 只产字符串，不绑事件：它发的是 `data-act`（play / voice / refaudio / refclear / voicenote），页面自己绑点击 —— 因为「画完之后要不要写进哪一处」是页面自己的事。
  - ⚠ **本组下面大半条目属于 2026-10 已删除的拍短剧页**（`drama.html` 与它的后端）。它们作为「踩过的坑」保留 —���
    `Drama.Pipe.shoot` / `Subs` / `planMaterials` / `edlCheck` / `renderSpec` / `applyRoleSource` / `newDrama` 等符号**已经不存在**，
    照着去找会扑空。其中**仍然成立**的那几条（音色不许自己编、文本要转义、型号下拉按平台分组、设置项只在一处点名）
    已经迁到素材库页，现由 `chars.js` 与 `chars.html` 实现。
  - 候选那一排（图片 / 声音同一套）只有三条规矩：① 一次出几张 / 几条不许写死 —— 图片看 `D.Pipe.previewCap(型号)`（`max_outputs` 夹到 `FACE_CAP`），声音看 `D.Pipe.voiceCap`（preset 用音色清单长度、de…
  - 「这一项正在生成」的账要按「哪一份素材的哪一项」记（两页同一套：`GEN` Map + `gKey(kind, id)`）：预览图 `face#id`、每一类设定图 `asset#kind#id` / `acand#id/kind`、声音候选 `voicecands#id`、试听…
  - 「拍的时候真的发出去哪些素材」与「界面上声称会自动带哪些」必须同一份：`Drama.Pipe.planMaterials(drama, shot, model)`（脸 → 手挑参考图 → 三视图按 `reference_image.max` 补位 → 超上限写进 `notes`；…
  - 字幕不是视频平台生成的（那边出的片子不带字幕）：台词由 `Drama.Subs` 按每句配音的真实时长排成字幕轨，预演时叠在画面上、导出时交给本机 ffmpeg 烧进去（`/render` 的 `clips[].subs`）。
  - 配音也进成片（和字幕同一套约定）：`clips[i].voices = [{ src, start, dur, vol }]`，`start` 同样相对该段起点，代理把每句按 `start` 延迟后与该段原声混成一条统一规格的音轨（`buildClipAudio`）。
  - 拍完不做任何自动判定（2026-10 去掉质检，别再加回来）：一条片子像不像那个角色只有用户自己看得见，让文字 AI 识图打分给的是一句没人能核对的结论；声音与台词更没得判 —— 配音就是用该角色音色逐句合成的、字幕轨按这些配音的真实时长排，没有听辨模型就别假装能听出台词念错没。
  - 台词的结构检查（漏句、空句）还在，但长在 `prereqs` 里 —— 开拍前就拦，不在拍完之后判。
  - 预演是「开头画面 + 配音 + 字幕」在本机实时合成的（不生成视频）；真正出片才调视频平台。
  - 音色不许自己编：可选音色现读注册表（`Chars.Pipe` 的音色判据，模型 `options.voices` → `prov.tts.voices`），没配语音平台就明说「还没配语音接口」，别摆三个假的「声音 1/2/3」——编出来的 id 平台根本不认，要到提交时才报错。
  - 角色身上存的音色 id 要按当前型号现校验（`Drama.Pipe.voiceOf(REG, drama, char)` → `{id, stale, list}`）：换过语音平台、或平台改了音色名之后，`char.voice` 存的是这一型号清单里没有的 id —— 直接发过去…
  - 「这一位角色的声音从哪来」是逐位决定的，不是整集锁一种方式：这一家支持哪几种由 `Drama.Pipe.ttsWays(REG, opts)`现算（`preset` → `voices()` 那份清单；`design` / `clone` → 声明了 `ttsMode` 的那个型…
  - 型号下拉是按平台分组的二级菜单（`Chars.Pipe.modelSelectHTML`，和生成工作台同一套）：`<optgroup>` 是平台名、option 文字是型号原始名。
  - 批量拍摄按场景链调度（`D.Pipe.chainPlan` 读文字 AI 给每段写的 `link`）：· `link=auto` 的段串成一条链 —— 后一段要等前一段拍完才取得到它的最后一帧，所以链内串行；· 链与链之间没有依赖，一次并发 `PARALLEL_CHAINS` 条…
  - 台词的说话人有两个字段，必须一起写：`lines[i].who` 是给字幕和提示词看的名字，`whoId` 才是配音找音色的凭据（`dubShot` 按 `id` 匹配，避免同名不同人共用音色 —— 剧本里两位「阿May」）。
  - 这一页不做任何与钱有关的界面与记账（`Drama.Cost` 已整块删除，别再写回来）：估价、单价、花费明细、币种换算都不出现，平台回执里带价格字段也不解析、不显示。
  - 台词秒数与段时长：一份估算，一处显示（`Drama.Pipe.lineSec(sh, take)` / `shootFields().caps`）：「这一段拍几秒」的档位吸附按字数估（`estLineSec`），右栏那句「台词含收尾约 X 秒 · 这一段拍 Y 秒」优先用真实配音…
  - 设置项只在一处点一次名（`Chars.SET`，键统一 `char_` 前缀）：素材库页面上的文案、真的发给文字 AI 的那份参数、设置页那张卡（`renderCharsSet` / `saveCharsSet`）与 AI 助手能改的清单，四处读同一张表。
  - 整集时长是用户自己写的分钟数（自由输入，常用档做成芯片），AI 可以改但要说清是谁改的：`{duration}`进拆剧本指令，`normalizeScript` 只在 `dr_ai_dur` 开着、AI 回的秒数落在声明区间里、且与用户那个不同才采纳，同时把用户那一个留在 `op…
  - 画幅 / 分辨率 / 单段时长按视频模型自己声明的取值来（`Drama.Pipe.videoChoices` / `videoCaps` / `shootFields`）：两家视频平台声明的是 `resolutions: 480p/768p/960p/1080p`、`durati…
  - 角色来源（「全新角色 / 从素材库选」）要真的生效：`opts.roleSource` 由 `Drama.applyRoleSource` 消费 ——拆完剧本后对每个角色去库里找同名的那一位，把脸 / 音色 / 资产整体拷过来；库里没有的照常画，并在「认角色」那一步明说谁对上了、谁没对上。
  - 「从素材库选」要能让用户点名，不能只是把整库倒给 AI（2026-10）：以前那个下拉选中之后只是把`roleSource` 翻成 `'lib'`，然后整个库都列给 AI 让它自己认名字 —— 库里攒到几十条以后，候选是一大锅、挑谁全凭剧情，而用户在入口页明明知道自己要用哪几个，…
  - 素材的类型只认 `kind`，卡片上「已在本集」的判据要和 `pullInto` 完全一样（2026-10-04 端到端探针查出来的两条）：① `libKindOf` 以前先按字段形状猜（有 `desc`/`time` 而没 `look` = 场景），而 `Lib.save` 会…
  - `staleIn` 要把「本集存了什么进库」和「它查了什么」对齐：`chars.html` 是就地编辑，写的是 `char_lib`（当时还叫 `drama_chars`）、不碰这一集的 `dramas` —— 用户在库里给「小雅」换了脸、给「河岸」改了描述，回到拍短剧看到的还是旧的那一份、拍摄时用的也是旧的。
  - 「做下一集」必须当场建好、并且被下一步真的用上：`Confirm.choose` 先问沿用范围（角色+场景 / 只角色 / 全新，默认值取设置项 `D.nextInherit()`），然后 `newDrama`（`opts.nextOf` 指回上一集）拷角色与场景的引用、对 `l…
  - 导出前要能看见「进不了成片的段」：`Drama.Pipe.edlCheck(drama)` 返回 `{clips, missing}`，`render()` 见 missing 直接抛错、页面在点导出之前就把缺哪几段、为什么摆出来。
  - 成片里要不要配音 / 字幕是每集的两个开关（`drama.opts.dub` / `drama.opts.sub`，默认都要），底栏第 4 步画两颗 `.tool` 芯片（`exportToggles`）。
  - 步骤之间要守顺序：讲故事 → 认角色 → 看预演（出完预演落在这一步）→ 拍成片。「开始拍」在第 3 步；出完预演直接跳第 4 步，就等于既没让人看预演、也按不到开始拍。换步统一走 `enterStep(no)`（顺带做前置条件重判），别在各处裸写 `cur.step = n; …
  - 第 1 步那块转屏只在真有拆分在跑时才摆：`render()` 里 `cur.step === 1` 要分两种 ——`genHas('split')` 才走 `renderBusyStep()`，否则走 `renderRewound()`（照实说「已经拆过了」+只读展示故事原文 …
  - 「一句话让 AI 改这一段」：参考产品那句话（image10）是个输入口 + 「改」。它只改开头画面描述与镜头描述，台词/角色/场景不许动（改完可以直接重拍这一段）。
  - 机位要连景别与运镜一起给（`CAMERAS`：固定镜头 / 缓慢推近 / 缓慢拉远 / 手持跟随 / 固定特写 / 过肩 / 俯拍）——机位直接进视频提示词，只写个词平台听不懂；`desc` 里别再重复 id（拼起来会变成「缓慢推近，缓慢推近，景别…」）。
  - 段内生成只走 `Drama.Pipe` 那一个入口（开头画面 `drawOpen`、定妆照 `drawFace`、场景 `drawScene`、配音 `dubShot`、拍摄 `shoot`）：页面的按钮 handler 只调它和写 busy 文案，选中的型号 / 画风全在里面按…
  - `UiDialog` 的 `body(el, close)` 里要用关闭函数就用它传进来的第二个参数 ——`onOpen` 是在 `body` 之后才调的，在 `body` 里引用 `onOpen` 里定义的东西会直接 ReferenceError。
  - 别让一个「看着能点、其实什么都不做」的控件留在界面上。这一轮清掉三处：① 拍片记录那排按钮在某些路径下根本没绑事件 —— `renderTakes` 整块换掉 `#takeBox` 的`innerHTML`，新节点的 `onclick` 是空的，而那几个按钮（⬇ / 不等了 / …
  - 「同一件事只能有一份判据」要连「产物有几种给法」也算进去：`shoot` 与 `resumeTake`都要把上游产物转成本机可播的地址，而产物有三种给法（外链 url / 本机直链 src / 资产号 assetId—— SparkCine 的产出是资产 id、没有 url）。
  - 「还在跑」这种判据，页面与数据层必须逐字对齐：数据层 `Shots.dropTake` 与 `runningTakes`都带 `&& !t.abandoned`（用户按过「不等了」就该放行），页面 `delTake` 的前置检查原来漏了 ——于是弹出一句自相矛盾的话「第 N 次还…
  - 死代码照样要清：零调用的 `paintBottom`、定义了并导出但外部零调用的`pickImageProv` / `pickTtsProv` / `pickModel`（`listBroken` / `Shots.resequence` 相反 ——内部还在用，只是不该再挂到导出…
  - 判据要落在行为与顺序上：这一轮的自检里，「查 `preselect` 这个词出现过没有」曾长期全绿 ——而那段代码写在 `UiDialog.open()` 之后，而 `open()` 会同步调 `body()`（`ui.js`：`o.body(body, close)` 就在 `…
  - 同一个问题只能有一个判据，落地处超过两处就收成一份：短剧这一轮连踩三次同一形状 ——「这一句是谁在说」曾经有三套：`lineSpeaker`（先 `whoId` 再按名字）、`dubShot`（只认 `whoId`）、`prereqs`（只认 `whoId`），于是右栏写着「琪琪…
  - 别把 AI 写的换成「一个看起来差不多的」：`normalizeScript` 以前对段引用的场景名查不到就落到`scenes[0]`、对表外的时段一律改成「深夜」，提示词与界面上显示的都是另一件事；而 `linkSource` / `chainPlan` 又拿 `sceneId…
  - 「选好了」这句话不许配一个空结果：素材没取到字节来源时照样存成空串并弹一句「配乐选好了」，用户以为铺了配乐、成片里还是原声。
  - 台词在右栏逐句可改（说话人下拉 + 文本框 + 增删）——字幕轨、镜头描述、配音与拍摄都按这份走。
  - 段落顺序与段号：`edlCheck` / `renderSpec` 按 `drama.shots` 的数组顺序拼成片，`sh.no` 是显示用的段号。
  - 点一次「拍这一段」只发一条任务，不自动重试：拍完不再有任何自动判定（见上面去掉质检那条），失败即停，把「再来 N 次 / 改台词 / 换平台」的决定权交回界面。
  - 提交那一刻就把 `take.taskId` 写盘，重新打开页面时 `Drama.Pipe.resumeAll` 拿它接着等（`boot()` 里调 `resumePending`）—— 这是「关掉网页也会接着拍」能落地的部分：活交给平台跑，本机只负责等，不重新提交（重新提交会重复扣费）。
  - 配乐混音是代理的活，页面只管选哪一段（`opts.bgm`）：`/render` 会把它自动循环铺满整集，并把原声压到 0.35 与它 `amix`。
  - 静态服务（`proxy.js` 的 `MIME` 表 + 扩展名白名单正则）要一起放行音频与字幕：少一个扩展名，本地 mp3 / srt 取回来就是 404 —— 表现是「配乐选了却下载失败」，而且报错发生在代理下载素材那一步，看着像素材本身坏了。
  - 非上传素材要转 dataURL：`reference_image` 模板是 `image_url:{url}` 的平台（VGENV）收的是它自己能取到的公网地址，本机的 `/getv?url=…` 回环地址它根本访问不到 ——发过去的表现是「参考图被静默丢掉」。

### 3.1 生成工作台 `studio.html`（视频 / 图像 / 语音合并成一页）
- 类型写在地址栏里：`?t=video|image|audio`，`setType()` 用 `history.replaceState` 同步；`app.js` 的 `ALIAS` 让 `/video.html` 这类旧短名也带着 `?t=` 过来，`proxy.js` 的 `F…
- 每种类型各自记住型号与提示词：型号存 `studio_pick`（`provId::modelId`，见上面那条下拉约定），提示词存 `studio_prompt_<type>`。
- 模型下拉按能力分组：视频 / 图像用 `optgroup`（平台）+ 原始型号名；语音一次只服务一家（`audioModels()`），别让用户在一个下拉里跨平台选型号。
- 右栏是三类型合在一起的历史：`AssetLib.load({kinds:['image','video','audio']})` 一次读全（含本机资产库来源），再与语音的本地记录 `Wb.History('audio')` 合并、按 `assetId` 去重；默认只看最近 30 …
- 视频 / 音频卡片就地播放：`mediaBox()` 出标记、`bindCardPlay()` 接线，两种类型合用一套。视频走 `Wb.thumbs.mediaHTML(src, { inline: true, videoAttrs: 'playsinline preload=m…
- inline 必须由 `workbench.js` 的 `thumbs` 层保证，页面管不了这三件事（少一件就是「视频播不动」）：① `mediaHTML` 的 inline 分支直接输出 `src`（静默模式那个 `<video>` 只是抽帧用的，只有 `data-src`，浏…
- 播放键统一在媒体区左下角（`.tplay`，34px 圆形），播放中淡出、hover 回来；音频卡另有一个大号音频符号 `.tbg` 做背景（不是空白占位）。
- 左栏素材槽的磁贴样式是 `ui.css` 那一份（`.assets-grid` / `.asset-slot` / `.cap` / `.x` / `.blocked` /`.conflict` / `.rvthumb` …），与导演台右栏共用，`studio.html` 只管怎…
- 右栏类型分类是数据驱动的：`kindOrder` + `kindTabs()` 按 `mtype` 现算分类与计数（选中的分类即使计数为 0 也保留），别写死「图片 / 视频 / 音频」。
- 右栏默认动态加载：只读 `page_mode_studio`，`'page'` 才翻页、否则 `'more'`；不要从 `page_mode_video / _image / _audio` 迁移 —— 旧默认值会把「翻页」这个要改掉的默认行为带进来。
- 卡片可以拖进左栏当参考素材：整张卡 `draggable`，载荷是本页自产的 `application/x-studio-ref`（JSON），同时兼容旧 `application/x-asset-id`；落到当前模型能接收该类型的槽位上，必要时先 `AssetTransfer.…
- 「把一条素材推进它那一类的槽位」全站只有 `studio.html` 的 `refIntoSlot(mtype, p, o)` 一份，三个入口都走它：右栏卡片拖进左栏（`dropRefMedia`）、详情面板的「复用这次创作」（`reuseInto`）、跨页带过来的那一条（`ap…
- 跨页载荷只由 `workbench.js` 的 `Wb.reuse.go(o)` 拼，只由 `studio.html` 读一次（§J 第 ⑧ 支守着这个「各一份」）：素材库 / 收藏 / 资产库三页各写一份 JSON 时，消费端只认平台资产号，而素材库那张图只有本机地址、收藏里的…
- 图像栏「拆分片段批量生成」只有图像栏有（`#splitBtn` + 就地面板 `#splitInline`，张数与拆分维度用户定）：文字 AI 出方案（指令 `TextAI.DEF.img_split`，在 `NO_ASK` 里 —— 它要 JSON，不能拼追问说明；设置页 PR…
- 调试提示：这一页在 iframe 里，浏览器控制台 / 网络面板只看得到外壳顶层，页内报错很难看见。真要查就在页内临时挂 `window.onerror` 往 `PUT /data/<名字>` 写一份启动日志，查完连代码带落盘文件一起删—— 别把这种诊断通道留在正式代码里。

↑ 这一节每一条约定的**全文（为什么、当年怎么漂开的、配套判据与探针在哪）**在 `docs/agents-公共层与界面约定.md`。
只照上面这一行标题动手，会漏掉它点名的那些「不许」—— 改到这一节点名的任何一处之前先读那一条的全文。
本节引言里那套 **`tests/selfcheck.cjs` 常驻判据（§A–§L 十二个字母；§A 另有 A-2 一支，所以它末行汇总报的是 13 条）**——
每档的口径、变异与反向对照也在同一册里；跑法是 `node tests/selfcheck.cjs`，改过任何「唯一实现」之后必须再跑一次 `node tests/mutation.cjs`（它临时改源文件，**别和另一路会话同时写这份目录**）。

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
  启动器 `launcher.ps1` 认同一个优先级并把**实际跑起来的端口**记进 `.proxy-port`（停止 / 重启 / 退出 / **关掉那个窗口**都按它关，只杀 node 的进程）。
  之所以要做成这样：Windows 的 Hyper-V / winnat 开机时保留走一段连续端口（本机实测 5174~6173 整段不可用，
  **5199 也在里面**），撞上报的是 `listen EACCES`，而 `netstat` 根本看不见那个号 ——
  「这个端口能不能用」只能真 bind 一次问系统（`launcher.ps1` 的 `Find-FreePort` 就是这么挑的，往上找 8000 个不到一秒）。
  保留段每次开机都可能不一样，所以文档里的端口号只是「当时实测能用」的样本，绑不上就换一个。
- **启动这一层现在是两份文件，改行为只改那一份**：`启动.bat` 是薄入口（只负责拉起 `launcher.ps1`，找不到就照实说并给出
  「直接跑 `node proxy.js`」的出路），界面 / 起停 / 端口判据 / 日志全在 `launcher.ps1` 里。
  **`启动.bat` 是 GBK（`chcp 936`）而其余文件全是 UTF-8**：改它要先在临时目录写成 UTF-8，再
  `iconv -f utf-8 -t gbk` + CRLF 落回项目里，直接用编辑器写回去每一行中文都会成乱码，
  而且 `node --check` 那类语法自查一行都报不出来（它不是 js）。
  **那一句 `start` 必须带 `-WindowStyle Hidden`**（截图上暴露的：桌面上同时挂着 GUI 和一个空的
  「Windows PowerShell」控制台）。理由不是「难看」：控制台那一个**更好按**，而关掉它是**硬杀进程**
  （`FormClosing` 根本不走）—— 端口上的服务当场变成没人认领的孤儿，「关掉这个窗口会停掉服务」只剩 GUI 那一个出口。
  藏掉控制台就带来另一个坏法：`launcher.ps1` 一旦解析不过，双击是**完全没反应**（窗口不出现、日志也没有）。
  所以 bat 在 `start` **之前**用 `Parser::ParseFile` 预检一次，不过就把原因打在自己这块看得见的控制台里并 `exit /b 1`。
  两条路都要有探针验过（原来那份 `.tmp-batwin.cjs` 已删，改这一层时现写：A 桩界面起来后按 pid 枚举窗口，
  控制台必须在；B 故意给一份语法坏的 `launcher.ps1`，必须看得见原因且退出码是 1）。
  `launcher.ps1` **必须是 UTF-8 带 BOM + CRLF**：PS 5.1 不带 BOM 就按系统 ANSI 代码页读，界面上每一句中文都是乱码，
  而 `Add-Type` 那段编译错误也会跟着一起看不出来。
  自检：`powershell -NoProfile -ExecutionPolicy Bypass -File launcher.ps1 -SelfTest`（跑的就是界面用的那一份真源码，
  `-EnvFile` / `-StateFile` / `-EnvAdd` / `-NoBrowser` 是给它用的探针口，所以全程不碰用户真实的 `.env`、`.proxy-port`、`.data`）。
  **`-EnvAdd` 在命令行上只能连成一串递（`-EnvAdd A=1,B=2,C=3`），launcher 自己按逗号拆**：
  `-File` 那条路上 PowerShell 只会把**一个** argv 绑给 `[string[]]`（本机实测四种写法：三项各占一个 argv 只收到
  第一项；带引号的逗号串会连引号一起进来；只有 `-Command "& x -EnvAdd 'A=1','B=2','C=3'"` 才绑成三个，
  而双击走的是 `-File`，所以那条路不算）。这一条要紧是因为漏掉的那两个是 `ASSETS_DIR` / `RENDER_DIR` ——
  探针生成的素材与成片会直接写进用户真实的 `.assets` / `.renders`（那里没有 `.data` 的 `.bak` 与对账保护），
  而「真实 `.data` 一个字节都没动」这项断言**照样全绿**。判据要落在 `/sys-status` 的三个目录上（数据 / 资产 / 渲染都点名），
  只查 `DATA_DIR` 等于没查。
  **界面里每一个 `[类型]` 字面量都要在自检里点一遍名**（`Get-TypeLiteralReport`，自检 ⓪-b 档）：
  踩过一次真崩在用户面前 —— `[System.Windows.Forms.MessageBoxIcons]` 多写一个 s（正确是单数 `MessageBoxIcon`），
  `Parser::ParseFile` 与 `node --check` 那一类语法自查**一个字都不报**，只有运行到那一条分支
  （「服务不是这个窗口起的，要停吗？」）才弹 WinForms 那面「未处理的异常」大字报，而那条分支平时根本走不到。
  所以这一档不测行为、只测名字。两个必须写在一起的细节：
  ① `-as [type]` 之外还要按 `AppDomain` 走一遍，否则本文件里 `Add-Type` 编出来的 `Native.Dpi` /
  `WorkbenchRunner` 会**假红**；② 还要断言「扫到的类型字面量 ≥ 20 个」，因为**扫出 0 个也算全过**
  （`TypeAst` 在 PS 5.1 里是 internal，写它的名字去判类型就会撞上这一档正要抓的那个错，要认它两个公开子类
  `TypeExpressionAst` / `TypeConstraintAst`）。三个变异各钉住一半：改坏类型名 → 只那一条红并点名错的那一个；
  点名函数恒返回 `$null` → 整份名单红；扫描条件恒假 → 报「共 0 个」。
  **状态灯与日志必须说同一件事（自检 ⓪-c 档，`Get-StartFlagOrder`）**：等监听那个块里「端口上真有人在听」
  要排在「等满了没有」前面。反过来的那一版界面不会报错，只会**说谎** —— 日志里早写着
  「proxy 已启动：http://localhost:6500」、页面也开好了，顶上还挂着「正在启动 / 正在等服务监听上 6500」
  整整 25 秒（截图拍到过）。判据落在**两处落地的先后**上：查「块里出现过 `Proxy-Running` 这个词」会算上注释，
  查「出现过 `StartingSince = $null`」超时那一条也满足，两种都是假绿的尺子。
  写这一档时又撞见一次「尺子自己坏」：PS 5.1 的 `IfStatementAst` **没有 `Condition` 属性**（只有
  `Clauses`，每项是个 Tuple：`Item1` 条件、`Item2` 那一段），拿 `.Condition.Extent.Text` 去比永远拿到 null，
  于是新加的那一条报「找不到那块」—— 看着像代码不对，是判据读错了仪表。
  `BinaryOperatorType` 在这个 run-space 里**根本解析不到**（正好被 ⓪-b 那一档当场抓出来），所以比较符不要写枚举，
  认「右操作数是 `$StartGiveUpSec` 的 `BinaryExpressionAst`」就够（赋值不是二元比较，字符串里提一句变量名也不会冒充）。
  三个变异各钉一半：退回先问超时 → 红在「问监听在第 N 行，问超时在第 N 行」；拿掉超时 → 红在「没有超时那一条」；
  外层条件改名 → 红在「这样的等待块有 0 处」。
  **要看界面上某一瞬间长什么样，得自己截图，不能靠 MCP 那一跳**（它的往返延迟比「正在启动」这一秒的状态还长，
  拍到的一定是之后的样子）。两个必须做对的细节，做错了就是「截到的不是那个窗口」：
  ① `Get-Process` 的 `MainWindowHandle` 对 `powershell.exe` 起的 GUI 常常是**那个蓝色控制台**，
  要按类名前缀 `WindowsForms` 现枚举该 pid 的可见顶层窗口；
  ② 截屏进程必须 `SetProcessDPIAware`，否则 `GetWindowRect` 给的是虚拟化坐标而 `CopyFromScreen` 用真实像素，
  截出来偏掉一大块（本项目实测 125% 缩放下偏到窗口外面，只拍到一条边）。
  另外**连拍十几张（每 350~400ms 一张）**才掐得住那种一秒就过的状态；关窗用 `PostMessage WM_CLOSE`，
  不要用 `Kill`（那正是跳过 `FormClosing` 的那条路，等于没测）。
  改完这一层要**连 `launcher.ps1` 一起进 `tests/selfcheck.cjs` 那类语法自查之外**单独跑一次：PS 的语法用
  `[System.Management.Automation.Language.Parser]::ParseFile(...)`，`node --check` 对它什么都看不见。
- **自动化 / headless 验证一律跑隔离实例，不要在真实实例上写**：`PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe RENDER_DIR=.renders-probe node proxy.js`
  起一份独立代理，测试脚本的 `BASE` 默认指向它。原因：浏览器侧每一次 `localStorage.setItem` 都会镜像成 `PUT /data/<key>`（last-writer-wins），
  而启动对账 `DataSync.boot()` 是异步的 —— 在全新上下文里跑真实实例，很容易把**加载前读到的旧快照**盖回用户数据上
  （2026-10-01 就是这样把收藏库从约 400 条写成 2 条，无法恢复）。
  只读检查（加载页面看有没有报错）可以在真实实例跑（端口问 `.env` / `.proxy-port` 要），但跑前先 `sha1sum .data/*.json`、跑后再比一次，确认没变动。
  **自己 `spawn` 一份代理的探针，必须当场认领「答话的就是我刚起的那一份」**：`canBind` 在 Windows 上会说谎
  （现成监听者绑在 `::` 双栈，探针只试 IPv4 → 报「空着」，真去 `listen` 才 EADDRINUSE），于是子进程当场退出，
  而探针那句「等 `/registry` 答得上来」的轮询由**另一个还在跑的实例**答了 —— 变异那一轮改的是磁盘上的 `proxy.js`，
  读数来自一份从没改过的进程，三个变异全被读成「没有变化」，前四档判据也只是在替别人打分。
  认法：`DATA_DIR` 用探针独有的名字，起好后取 `/sys-status` 的「目录.数据.路径」点它的名（别的实例冒充不了），
  同时判子进程 `exitCode !== null`（自己退了就把它的日志带出来，别继续等人家回话）。
  常驻样板：`.tmp-outurl.cjs` 的 `startProxy()`。
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
  子进程还要在客户端断开时收掉，否则屏幕上会留一个没人要的框。
  （原来那份 `.tmp-pickdir.cjs` 已删 —— 改这两条路由时现写：① 请求体带 `dir` 必须被忽略；
  ② 挂着 `/pick-dir` 的同时并发打 `/registry`，代理必须还能答。）
- **代理递出去的字节与拒掉的地址，判据各只有一份**（`proxy.js`）：
  ⓪ 护栏本身是 `guardOutboundUrl(raw)`：只允许公网 **https**，回环 / 内网 / 链路本地 / 域名解析到内网的写法
  （`*.nip.io` 之类）全部拒绝；`safeOutboundUrl` 是它的同步版（只查字面量），异步那份还会真去解析一次 DNS。
  ① `takeOutboundUrl(req, res, prefix, tag)` = 「解 `?url=` → 过 `guardOutboundUrl` → 过不去回 400 并写明原因」，
  `/getfile`、`/s3put`、`/fetch`、`/getv` **四条通道都只走它**。以前各抄一遍，连 400 的响应头都写成两样；
  少抄一道护栏就等于「任意本机网页可以借代理打内网」。**不要在路由里再裸调 `guardOutboundUrl` 自己拼 400**
  （`resolveSrc` / 重定向跳数那几处是**要抛错**给上层的，不是回复端，故意没并进来）。
  ② `passthroughHeaders(upH, o)` = 「状态码原样透传（小于 200 视为 502）+ 4xx/5xx 一律 `no-store` +
  Range 与跨域头跟着上游」，`/asset` 与 `/getv` 共用。要紧的是中间那一条：签名过期回 403 时若给它盖上
  `max-age=86400`，浏览器就把这条 403 存一整天，表现是「这条视频的缩略图永远坏掉、怎么刷新都不恢复」，
  而换一个签名地址本来就能好 —— 两处各写一份就意味着其中一处迟早漏掉这道守卫。
  行为侧的常驻探针是 **`.tmp-outurl.cjs`**（隔离实例：四条通道各拒一次回环地址 + `*.nip.io` + 明文 http，
  再从注册表现取 relay/端点找一条**真能取到**的产物地址验 200/一天缓存/CORS、4xx 透传且不缓存、
  `Range` 拿到 206 与 `Content-Range`；末尾三个变异 —— 失败也缓存 / 状态码压成 200 / 护栏摘掉 ——
  各钉住对应的判据，改完按 SHA256 核对还原）。
  **已知照不到的一角**（别以为全覆盖）：`/asset` 那一支要真取到上游字节才走得到公共层，
  隔离实例没配 SparkCine 密钥时只进 `catch`，所以「只把 `/asset` 调用点的 `cacheOk` 写错」这类改动它报不出来。

## 5. 改完必须自测

```bash
# 语法：proxy.js 与公共 js
node -e "new (require('vm').Script)(require('fs').readFileSync('proxy.js','utf8'))"
for f in ui.js assetlib.js workbench.js chars.js sidebar.js app.js ai-chat.js; do
  node -e "new (require('vm').Script)(require('fs').readFileSync(process.argv[1],'utf8'),{filename:process.argv[1]})" "$f" && echo "OK $f";
done
# 页面内联脚本（必须用 vm.Script：new Function 抓不到严格模式/全局作用域错误）
# 注意 re 要写在循环**里面**：带 g 的共享正则会把 lastIndex 带到下一个文件，
# 于是从中间切段，报出一堆「Unexpected identifier」的假语法错误（踩过）
node -e "const fs=require('fs'),vm=require('vm');
for (const f of ['director.html','studio.html','chars.html','assets.html','favorites.html','settings.html','usage.html','shell.html']) {
  const h=fs.readFileSync(f,'utf8'), re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m,i=0;
  while ((m=re.exec(h))) { i++; new vm.Script(m[1],{filename:f+'#'+i}); }
  console.log('OK',f,i+' 段');}"
```

- 改的是 `proxy.js`（不是 `.env`）→ **必须重启代理**才生效（启动器窗口里点「重启」；或杀掉 `.proxy-port` 上那个 node 后 `node proxy.js`）。
- 改完至少把页面各加载一次（`shell.html#…` 里逐个切：director / studio（视频 / 图像 / 语音三种类型都要切一遍，
  `studio.html?t=video` / `?t=image` / `?t=audio`）/ chars / favorites / assets / usage / settings，
  外加直接打开 `chars.html` 与 `studio.html`），确认没有错误横幅、没有控制台报错、关键列表/下拉有内容。
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
  顺带一条：用户真实的 `.data/char_lib.json`（当时还叫 `drama_chars.json`）当时还不存在（库是空的），才没被这个 bug 污染 ——
  这类「写坏一份用户数据」的坑只有先查一遍现网文件才能确认影响面。
- 涉及创建任务的改动：真实跑一次最小的（图片 draft 1 张 / 语音短文本），别只靠干跑；上游报错时看清是哪个字段。
- **接线一致性要单独查一遍，语法自测查不出来**：新加的按钮 `id="btnX"` 有没有 `bind`、
  新加的 `data-a="X"` 有没有 `sideAct` 的分支、页面用到的 `D.Pipe.xxx` 在不在 `Pipe` 导出表里、
  同一层有没有**重名的 function 定义**（后一份会静默盖掉前一份，本轮就撞过：
  `reshootShots` 写了两份，前一份的确认逻辑就再也不会跑）。这一类全绿 ≠ 页面点得动。
  当时的拍短剧页顺便还能查出**正文里混进 HTML 的 `Confirm.ask` / `toast` 字面量**（两者都是 `textContent`）。
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
  以及 `window.X` 导出的公共层。当时九个页面（`director` / `studio` / `drama` / `assets` / `chars`
  / `favorites` / `settings` / `usage` / `shell`）的 19 段内联脚本现在共 1453 处裸调用全部解析得到，
  这一档就该是绿的。
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
  改这类分隔符**必须再跑一遍它那个函数的行为断言**（原来那份 `.tmp-drift.cjs` 已经删了，要改就现写一份：
  喂 `lineDrift` 一批 `{whoId, text}` 对，重点是「说话人 A + 台词 BC」与「说话人 AB + 台词 C」
  用空串当分隔符会撞成同一条 —— 那一条判不出来就是分隔符退回空串了），
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

（**这一节的正文搬到了分册**：下面每条只留标题行当索引，红线照旧每次都要看到；全文、判据口径与探针在哪，看这一节末尾的指路。）
- VGENV：列表/详情都不返回 `prompt`（提示词靠本机归档 `PromptLog` → `prompts/`）；素材上传用 camelCase（`fileName`/`contentType`/`sizeBytes`）且拒绝未知字段（多发一个 `sha256` 就 400…
- SparkCine：上传用下划线字段且 `sha256` 必填；`output_format` 平台声明 png/jpeg/webp，但早前实测（产物字节头 / mime_type / 文件名）回包永远是 PNG，当时用 `forceOptions` 锁成 png；按用户要求已解…
- SparkCine 视频的「平台自动润色」：`create.topBools.optimize_prompt` 是提交体顶层的布尔（不进 `parameters`）。
- 首帧槽位可以直接选视频：生成工作台的「首帧图」既收图片也收视频 —— 选视频时在浏览器内取它的最后一帧当首帧（`Wb.vframe.fromFile()`，`studio.html` 的 `addSlotFiles` / `dropRefMedia` 调它，用于「把已有视频接着往下生成」）。
- VGENV 详情端点 /v2/videos/{id} 是 404 空壳（只回 statusCode/code/message）→ registry 里声明 `pollVia:'list'`，单条状态靠列表接口按 id 找（`Api.pollTask`）。
- 「任务显示成两个、其中一个是假的」这类问题的三个成因（都已修，别再引入）：① 跨闭包裸调用抛 `ReferenceError` 被 allSettled 吞掉 → 数据整源失踪；② 轮询端点坏了 + 404 被当成「任务已被清理」→ 本地任务被清掉任务号，于是和列表里的真任务并存…
- 页面取数只走统一层：注册表用 `Api.registry()`（带 60 秒缓存，别再各页裸 `fetch('/registry')`），字节取回用 `Net.blob / Net.fetch`（带超时与可读错误，别再裸 `fetch('/asset/…')`），平台接口用 `A…
- 任务卡片一律来自平台接口（语音除外）：生成工作台的图像 / 视频栏不建本地任务卡，本地也不留任务记录（`video_tasks` 已废弃，`Wb.History` 的 `video` 规格与 DataSync 的同步键都删了；`HISTORY.image`（`sparkcine_…
- 创建后的「取回/核对」不要挡住按钮：平台列表接口动辄 6~14 秒，`adoptTask()` 与「结果未知 → 核对列表」都必须放后台跑（只提示「正在取回/核对」），按钮的禁用窗口只覆盖 create 本身。
- 平台的提示词编译失败可安全重试：VGENV 创建时会跑一步 `prompt_optimization`，子服务偶发失败返回`PROMPT_COMPILER_UPSTREAM_ERROR` —— 这表示任务没创建、没扣费，重试安全（不像超时/断连那样可能已受理）。
- 提示词归档：`POST /prompts` 写文件、`GET /prompts` 列清单 + 索引、`GET /prompts/find?id=&provider=` 取全文；目录在设置页可改（`prompt_dir`，只存本机）。
- `/prompts/find` 一次返回按 id 匹配到的全部归档（`{matched, prompt, all[]}`）：`provider` 只用来决定「优先把哪一份当正文」，不影响是否命中。
- 本机资产（`/local-assets`）的大类型由代理现算，不看调用方给没给：`proxy.js` 的 `localMediaType()` 按落盘扩展名 → mime → 调用方给的 `media_type` 依次判（`图片` / `视频` / `音频`），POST 与列表回…
- 缩略图缓存键必须归一化：VGENV 的视频在页面上是 `/getv?url=<OSS 签名地址>`，而 `Expires`/`Signature`每次刷新都会变 —— 用整条 URL 当缓存键等于「永远命不中、每次都重新加载视频元数据」。
- 过期签名外链由公共层负责，页面不许自己判过期（`assetlib.js`）：平台产物地址只管一天，一旦被存进本机记录（收藏 `fav_items`、导演台工作区 `workspace`），第二天必然 403 —— 表现是「这条视频的缩略图永远加载不出来、点开只回一句 Format…
- 云同步：`POST /cloud/sync`（一键双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
- 浏览器侧对账（`ui.js` 的 `DataSync.boot`）：体积相同不能直接跳过 —— 等长修改（grid→list、等长密钥/模型名）体积一模一样，只比体积的话另一台机器的更新永远拉不回来；体积相同但服务器更新时仍要取回逐字节比对。

↑ 这一节每一条约定的**全文（为什么、当年怎么漂开的、配套判据与探针在哪）**在 `docs/agents-平台事实.md`。
只照上面这一行标题动手，会漏掉它点名的那些「不许」—— 改到这一节点名的任何一处之前先读那一条的全文。

## 7. 新增约定（2026-10 第三轮）

（**这一节的正文搬到了分册**：下面每条只留标题行当索引，红线照旧每次都要看到；全文、判据口径与探针在哪，看这一节末尾的指路。）
- retrieve 是「产物只给文件号」那一族的通用环节，不是某一家平台的补丁：注册表用 endpoints.retrieve（{id} 在 query 里也照样替换）+ `retrieve: { idFrom, urlFrom } ` 两处声明表达；`Api.resolveIte…
- 产物「自动存本机 + 地址三级回退」只有一份实现，在 `assetlib.js` 的 `AssetLocal`：① 平台地址过期 → 用本机副本（`AssetLib.normalize` 里 `decorate` 换 `src`，勾了「优先用本机」才换）；② 本机文件被删 → 代…
- 「不显示云端任务」是一张闸，不是一套筛选（`AssetLocal.hideAsCloud(o)` 是全项目唯一判据，内部现问`localOnly()` = 三档开关都开着）：页面不许自己拼「三个开关都开着 + 本机没有这份字节」，也不许在列表里另加一条 `if (云端) return false`。
- 两颗「自动下载」（`favorites.html` 的 `#pullBtn`、`chars.html` 的 `#btnLocal`）只走 `AssetLocal.pull` 这一条落盘链：与后台自动镜像同一个队列、同一份身份判据（`keyOf`）、同一道去重、同一份按类型另存；页…
- 下拉浮层挂到容器外面用 `fixed` 定位，不留在 `<select>` 原来的位置上（`ui.js` 的 `Dropdowns` + `ui.css` 的 `.dd-list`）：原地展开时任何祖先的 `overflow` 都会把它裁掉（生成工作台 `.adv` 是 hidd…
- `.dd-list` 的坐标两分支都必须显式写 `'auto'`，不能靠 `= ''` 清空（`ui.js` 的 `place()`）：`= ''` 清掉的是内联样式，而 `ui.css:298` 的 `.dd-list` 自己带着 `top: 0`。
- 浮层挂在哪一个容器由 `ui.js` 的 `hostFor(select)` 现判：普通页面挂 `body`，`<dialog>` 里的挂那一个 dialog。
- 重画一块区域要回收孤立的浮层：`Dropdowns.build()` 开头自己调 `sweepPortals()`，别再往容器里塞一份。
- 资产库 / 素材库 / 收藏三页的展示档位名统一成 `list` / `compact`（`Wb.viewToggle` 的 `views` 数组）。
- `/custom/models` 必须留在代理：它要把用户密钥递到用户自填的主机，同步的 `safeOutboundUrl` 只查字面量 IP、异步的 `guardOutboundUrl` 还查 DNS 解析结果（页面直连等于把这套判据抄第二份）；且图片 / 视频 / 语音那几家…
- 自定义供应商的型号一律现取，不预填模板里那份硬编码清单（那份是「内置那一家」的声明，照抄给用户的中转站等于替它编型号）：表单只画「已保存 / 接口返回 / 手填」三类，接口返回的一律不勾（由用户自己挑），勾选态 = 已保存 ∪ 手填，重新拉一次不会把上次勾的冲掉。
- 程序化填完 `<select>` 的 options 之后必须调 `Dropdowns.sync(那个 select 本身)`（`sync` 的 root 可以是select 自己，与 `build` 对称）。
- 「添加自定义供应商」这一格是新增入口，点它必须复位成新增态（`cusOpen` 里先 `cusReset()`）：不复位的话，先编辑了 A 家再点这个按钮，按钮还写着「保存这一家」、类型还锁在 A 家那一档，看着像点了没反应，填完一提交才发现改的是上一条。
- 显示名按「类型 + 编号」预填（图片1 / 视频1 / 语音1 / 文字1），编号只数这一类已有的：以前预填的是照模板名字拼的「SparkCine 中转」—— 一次加三家就全是同一个名字，而显示名正是型号下拉的分组名与收藏里的筛选项，重名会让那几组分不开。
- 改 / 删已添加的那几家要能在「添加」这张卡里就地完成（`paintCusMine` 一份清单 + 编辑 / 删除）：供应商那张卡上也有这两个按钮，但那是按类型分档画的 —— 语音那一档加的只有切到语音才看得见，删一家要在四档之间来回找。
- `REGISTRY.interfaceShapes` 是「接口族」清单，与「供应商」分开（v10 起）：设置页「添加自定义供应商」里`供应商` = 照哪一家内置平台整套走（选了就不用再挑接口形状，整行收起来），`接口形状` = 选「自定义」之后才出现的协议族（OpenAI 兼容 …
- 「类型」只有一个来源：顶部那排类型档（图片 / 视频 / 语音 / 文字），表单里不再给类型下拉：在哪一档点「＋ 添加自定义供应商」，加出来的就是那一类（`cusKind()` 读 `provTab`）。
- 下拉重画后的「回落」校验，合法取值集合必须把 `CUS_CUSTOM`（「自定义」）算进去：`renderCus` 填完 options 会做一次回落（`if (!pSel.value || !okIds.includes(pSel.value)) …`），而 `okIds = …
- 加 / 删一家之后 `afterCustomChanged()` 必须 `paintCusMine()`：`renderProv()` 只重画供应商卡上那一片，它不碰 `#cusMine`。
- 自动预填的显示名要跟着换类型走，人手打过的不能动（`cusAutoName` 记着「当前这个名字是自动填的」）：切档时只有 `$('cusName').value` 为空或仍等于自动填的那个，才换成新类型的编号（`cusFillName()`）。
- 「供应商与密钥」那张卡只列本机在用的那几家（v11 起，`provUsable()`）：`m.custom`（自己添加进来的）或 `keyState(m) !== '还没填密钥'`（设置里填了 / `.env` 里有服务端密钥）。
- 接口地址跟着刚选好的那一家自动填（`cusFillBase` / `cusSyncBase`，与显示名同一套记账）：选内置供应商就填它官网的 `base`，选某一族接口形状就填那一族的模板 `base`。
- 「地址撞模板自己的官方地址」不再是错（v11 起，代理与表单两边都改了）：内置平台现在也要先添加一次才进那张清单，而那个官方地址正是表单自动填进去的默认值 —— 选一家、贴密钥、点添加就是「我要用这一家」。
- 自定义平台不设家数上限（v11 起，`CUSTOM_MAX` 与 `/registry` 的 `custom.max` 一起删掉）：以前 12 家那道闸把两件正经事也堵死了 —— 内置平台现在也要先添加一次才进清单，常用平台都接一遍就撞上限；用户接十几个中转站是真的会发生。
- `/registry` 的自定义清单缓存要连着 notice 一起存，键里还要带 size（`customProviders`）：① `customNotice` 以前在进函数时就清空，命中缓存那一次报回去的是「没有坏条目」，页面那句「有 N 条自定义平台没被本地代理认」会莫名消…
- 删掉一家自定义平台，侧栏那张余额卡要当场消失（`sidebar.js` 的 `window.__sbBalanceDrop(kid)`）：余额那一轮是 60 秒一次，而 `refreshBalance()` 进来第一件事是拿 `localStorage` 的缓存先画一遍（为了切页…
- 「功能已经改了、键却还留着」的那批键要一次性清掉，别只删代码（`ui.js` 的 `LEGACY_KEYS` + `sweepLegacyKeys()`）：留着不只是占地方：每次同步都要带着它们跑一趟、整包备份与云同步会把它们一起带走换台机器又是一份死数据，更要命的是让人以为「这…
- 「添加自定义供应商」里那个供应商下拉的选项文字只给平台名（`renderCus` 的 `pSel.innerHTML`）：不要在后面缀「（N 个型号）」。
- 「这一家在本机算不算在用」只有一份判据，在 `assetlib.js` 的 `Api.provUsable`：三档算在用 —— 自己添加进来的（`custom`）、`sk_key_<keyId>` 有着落的、`.env` / 系统环境里有的；剩下一档（内置平台且一把钥匙都没有）两…
- 每张供应商卡都要写明「这一把密钥现在是从哪来的」（`settings.html` 的 `keySourceNote`）：密钥有三个来源——设置页自己存的那份（`.data/sk_key_<keyId>.json`）、`.env` / 系统环境变量、以及刚输入还没保存的草稿。
- 悬浮球吸边：左右任意高度都吸，上下完全不吸（`ai-chat.js` 的 `snapXY`）：判据是「球心落在可用区的哪一半」，松手时在左半边去最左、右半边去最右。
- 摆放与「拖完松手」必须走同一条吸附判据（`ai-chat.js` 的 `placeBall()` 里 `clampXY → snapXY → clampXY`）：以前启动摆放只 clamp 不吸，于是两种情况把球留在半屏 —— ① 全新 profile 的默认坐标是「离右边留 1…
- 提示词归档要有备份出口 —— 它曾经两头都漏（`POST /prompts/export` / `/prompts/import` + `/cloud/*` 的 `prompts/` 子集合）：归档是磁盘上的一堆 `.md`，既不在 `.data/`（云同步带不走）也不在 loc…
  - 能力声明回来之前，不许说「你没配 X 接口」：`boot` 先画界面、`loadCaps` 后台取注册表，取回来之前 `ttsWays` / `videoChoices` 会落到「没有这一家」的兜底分支，于是页面会说「还没配语音接口」/「还没配视频接口」—— 而用户什么都没做错，他配了。
  - 要花钱的入口按「会发出几条真任务」分级，多于一条必须先问：现在三处都是 `Confirm.ask` ——单段连拍（`n > 1`）、「重拍没成的 N 段」（`reshootShots`）、以及底栏「开始拍」（`shootAll`，2026-10 补上的）。
  - 界面上的提示必须指出路，不能只说「补好就行」：底栏那条红条原来只有「⚠ 第 N 段还缺: … —— 补好就能拍这一段」，而底栏「开始拍」只是加了 `.dr-dim` 变暗、并没有 disabled（点得动，会开 `showPrereq`，那里有「去设置」「去认角色」两颗按 `fix` 分类的按钮）。
- 界面上的承诺要么实现、要么改文案（拍短剧「质检没过时：自动 / 手动」那一排的 title）：原来写着「自动：没通过就一直重拍到过为止」，而底栏「开始拍」是整集连拍，那条路每段只拍一条、失败就停 —— tooltip 承诺了一件页面上永远不会发生的事。
- 成片这类「导出过一次」的东西不能变成终态：`renderSpec` 顺带算一个 `stamp`（每条用哪一次拍摄、什么开关、什么画幅、有没有配乐），导出成功时存进 `drama.finalStamp`；之后任何一次改动都会让它对不上，底栏据此说「这一份成片是旧的」并给一条重新导出。
- 下载一律走 `Wb.save(url, name)` → `Net.save(blob, name)`，不许 `window.location.href`：成片文件在代理的 `.renders/` 里只留最近 20 部，直跳过去撞上 404 时浏览器静默失败，用户只看到「点了没反应」。
- 字幕轨与配音轨的时间基准只能有一份：`dubShot` 已经把每句真实的 `start`/`end` 存进 `take.lines[]`（它跳过空句、空句不占时间），`takeSubs` 就必须照那份画。
- 页面要用数据层的内部函数，就把它加进 `Pipe` 的导出表：本轮页面要读 `renderSpec` 的 `stamp`，而它没导出 → 运行到那里就是 `undefined`（语法自测与控制台都不会报，只在那一条路径上炸）。
- `Confirm.ask` 的正文走 `textContent`：`<br>` / `<b>` 会原样显示成标签。要排版就用 `UiDialog.open({ body(el) { el.innerHTML = … } })`。同样地 `Toast` 也是 `textConten…
- 删除一律走 `Confirm.arm` 就地二次确认，不弹窗（`ui.js`，两个页面共用一份）：第一次点把按钮自己变成「确认删掉」，第二次点才真做；点别处 / 按 Esc / 过 5 秒自动还原，整页同时只有一个「确认中」。
- 武装态要经得起整块重画：给 `Confirm.arm` 传 `key`（这一次的稳定身份，如 `takeId`），重画之后用 `Confirm.restoreArmed(key => 容器.querySelector('[data-tid="'+key+'"]'))` 挂回去。
- 弹窗撤掉后，拦得住的判断必须从提示升级成硬拦：`dropShot` 以前只把「这一段还在跑」写进确认框正文，现在按 `runningTakes` 真拒（与 `dropTake` / `remove` 同一判据）—— 提示会被错过，拒不会。
- 本条与上面「失败原因要留在卡片上」不冲突：那条说的是持久状态（这一条失败了，原因要留在卡片上直到重试）；这里的 note 说的是这一次待执行的动作，活 5 秒，toast 是对的载体。
- 用户能撤回自己造成的结果：段、拍片、台词、整集都能删，角色与场景却只增不减 ——AI 拆出 8 个角色，其中「路人甲」不要了却无处可删，而重名校验又不许再加同名，唯一的出路是回第 1 步重拆，把画好的 8 张脸、配好的音色全丢掉。
- 「手动新建」的东西别直接甩一个占位名：`+ 加一个场景` 原来连点两次就造出两个都叫「新场景」的，而 `Lib.save` 按「同名 + 同类型」合并、`pullInto` 按名字认人 → 存库时两条塌成一条、「加入这一集」永远并到第一个。
- 「看哪一条」与「用哪一条」是两个口径，不能合成一个变量：舞台播的、字幕叠的、预演听的都是`takeAt`（`sh.takes[takeIdx] || curTake(sh)`，跟着人点的那一行走），而段条状态、成片拼段、取上一段末帧读 `curTake`（选用的那一条）。
- 闸门要分档，「有一轮在跑」不等于「什么都干不了」：`drama.html` 的 `genWhy` 按 `FLOW_EXCL`（独占轮：拆剧本 / 出预演 / 批量拍 / 出成片 / AI 定音色）与旁听轮分开判。
- 失败原因要留在卡片上，不能只弹一次 toast：`genUnit` 把错误传给 repaint（`repaint('')` 开始、`finally { repaint(err) }`），画脸 / 角色资产的回调据此写 `c.faceErr`，卡片上那一行红字才留得住；`voice…
- 前置条件的判据不许和页面空态文案打架：`prereqs` 原来把「这一段根本没有台词行」也算成「没有台词」并拦住开拍，而右栏那一格写着「这一段没有台词（纯空镜也行）」——该点的没点（留了台词行却一行字没填），不该拦的拦了（纯空镜不让拍）。
- 清单类弹窗的按钮要按缺口分类各给一条路，不能只认一种：`showPrereq` 原来只有 `fix === 'cast'`与「别的」两个分支，混在一起时（一位角色没画脸 + 某段台词空着）弹窗列出两条问题、按钮只把人丢进角色页，台词那条永远指不到地方。
- 链路接续会悄悄作废，要留得住「接的是哪一次」：`take.linkFrame` 只是一张图，看不出它是哪一次拍的末帧。加 `take.linkFrom`（来源那一次的 id）之后，`Pipe.staleChains` 判得出「某段选用那一条接的还是上一段旧版本的末帧」（`link…
- 文件名规则统一在 `Pipe.fileSafe` / `Pipe.takeName` 一处：剧名是用户自己起的，可能带 `\ / : * ? " < > |`，浏览器会各自换成一个下划线或直接截断，下载目录里于是躺着一堆「第2次.mp4」看不出是哪一集。
- 「重拍」这类批量动作按段号收口到一份实现：`reshootShots(nos, what)` 统一处理「确认每段都是一条真任务、单独计费」+「拍到上限的段（`takesLeft` 为 0）单独点出来并跳过」，然后交给 `shootAll(pick)`。
- 图标几何只允许有 `ICONS` 一份，分工是「操作 → SVG，散文 → 字符」：可点的动作（按钮 / 文字钮 / 芯片 / 段条上的加号）一律 `ICONS` 里的线描 SVG；`⚠ ✓ ✗ ● ?` 这类句子里的状态标记留在文字层 —— 它们出现在 `toast()` 与 …
- 带图标的按钮不能用 `textContent` 改字：`textContent = …` 会把图标一起抹掉，不报错，只是「图标忽然不见了」，按钮从此变成一个没图标的口袋按钮。
- 按钮里塞了 SVG 之后，`e.target` 就不再是按钮本身：点在图标上时 `e.target` 是 `<svg>` 或`<span class="ic">`，`e.target.dataset.xxx` 读不到（属性在按钮上）——短剧列表那个删除按钮原来是 `if (e.t…
- `data-icon` 只能写在静态标记里：`fillIcons()` 只在 `DOMContentLoaded` 跑一次，模板字符串里的 `data-icon` 永远不会被填上（`icon()` 返回空串 → 空的 `.ic`）。
- 图标只套一层 `.ic`：`ic()` 自己就产出 `<span class="ic">…</span>`，外面再包一层就成了`<span class="ic"><span class="ic">`，多一个盒子、padding 与对齐跟着漂（短剧列表的删除按钮踩过）。
- 页面级快捷键先想清楚「哪些时候不许抢」，四条缺一条就是最招人烦的毛病：① 焦点在 `INPUT / TEXTAREA / SELECT / contenteditable` 一律放行（连 `<select>` 也要 ——方向键是在换选项，不是切段；中文选词上屏那一下还会再触发 k…
- 纯读的导出不必过 `genWhy`：花钱闸门只管「会再开一次生成」的动作。「导出整集剧本 .txt」是 `Pipe.scriptText(cur)` 拼纯文本 + `Net.save`，一分钱不花；正文拼在数据层（好单测），页面只负责变成文件。别为了「统一」给只读动作也套一道提示…
- 每个 `<select>` 都得有兜底项：`<select>` 里一项 `selected` 都没有时，浏览器默默显示第一项，于是「存着的值恰好不在选项里」这件事在界面上完全看不出来 —— 看着写着「场景一」，数据与提示词里却是「不指定」，右栏说琪琪、真发出去的是旁白。
- 反过来：一个 `<select>` 里也只能有一个 `selected` —— 浏览器的规则是最后一个带 `selected` 的赢（不是第一个、也不报错），于是`ladder.map(s => \`<option ${custom ? '' : ' selected'}>\`)…
- 「现算出来的那一行字」在依赖还没就绪时不能先摆一个兜底值：`paintSecs()` 那一行是`readOpts()` 现读下拉得来的，而能力声明没回来时下拉整个还不存在 —— `readOpts()` 全部落到兜底，`duration` 取到 `bounds.min`（视频平台…
- 素材库三类素材的说法只有一张表：`chars.html` 的 `KIND_FIELDS`（`kindF(k)`）（2026-10）：同一栏对角色叫「外貌 / 人物特点」、对道具叫「道具描述」、对场景叫「场景描述」，以前新建表单与卡片编辑区各写一套，漂开是迟早的事。
- 建素材的表单是一张表单，三种类型都在里面选（不是三颗按钮各开一格）：选了类型就把那一类的说法换上来（`PromptForm` 的 `onChange`），不重画整张表单。

↑ 这一节每一条约定的**全文（为什么、当年怎么漂开的、配套判据与探针在哪）**在 `docs/agents-第三轮约定.md`。
只照上面这一行标题动手，会漏掉它点名的那些「不许」—— 改到这一节点名的任何一处之前先读那一条的全文。
