# AGENTS.md —— 在本项目里干活前先读这几条

本项目是一个**本地优先的 AI 创作工作台**：纯前端页面 + 一个本地 Node 代理（`proxy.js`，默认 `http://localhost:5175`），
所有生成平台都通过代理转发。页面：导演台 `director.html`（旧名 `index.html` 已删除，旧地址不再能打开）、**生成工作台 `studio.html`（视频 / 图像 / 语音三合一，2026-10 合并；旧
`video-gen.html` / `image-gen.html` / `audio-gen.html` 已删除，`/video.html` 之类的旧短名与 `?t=video|image|audio` 别名仍能打开）**、
素材库 `chars.html`（**拍短剧 `drama.html` 2026-10 已删除**，那一整套页面与它的后端 `drama.js` 一并清掉；`drama.js` 瘦身改名成 `chars.js`，即素材库的后端）、资产库 `assets.html`、收藏 `favorites.html`、设置 `settings.html`、用量 `usage.html`；
公共模块：`ui.js`（Net / Toast / Store / DataSync / Dropdowns / Confirm…）、`assetlib.js`（Api / AssetLib / Capabilities /
AssetTransfer / TextAI / PromptLog）、`workbench.js`（Wb：任务状态 / 轮询器 / 灯箱 / 历史 / 大文件）、`sidebar.js`、`app.js`、
`ai-chat.js`（AiChat：外壳层那一份 AI 助手 —— 可拖动悬浮球 + 右侧抽屉，只读查询本机数据与平台能力，写入动作只在用户点「执行」的确认卡片后才做）。
详细说明看 `README.md`，本文件只列**必须遵守的约定**；§3 / §3.1 / §6 / §7 四节的全文拆进了 `docs/agents-*.md` 三册，本文件那几节保留每一条约定的标题行当索引（各节末尾有指路）。
**新增一条约定时写到哪**：§1 路由、§2 能力驱动、§4 密钥与用户数据、§5 自测纪律、
§8 / §9 剪辑与轨道（导演台那一套判据的口径）→ 直接写进本文件对应一节；
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
- **同一个功能只应有一份实现**：下拉 `Dropdowns`、网络 `Net`、任务轮询 `Wb.poller`、历史 `Wb.History`、媒体地址 `Api.mediaSrc`、跨平台素材 `AssetTransfer`、IndexedDB 只走 `Kv.at(登记名)`、芯片行 `Chips.render`、**「AI 挑了哪几条」那颗芯片** `AiChip.paint`、**「写一句话让 AI 挑几条」那整条链** `AiFind.run`、缩略图 `Wb.thumbs`（外壳标记也只有一份 `mediaHTML`，画出来必须 `bind`）、详情 `Wb.detail`、卡片列表 `Wb.cards`、分页 `Wb.pager`（续拉的判据在公共层）、灯箱 `Wb.lightbox`、下载 `Wb.save` → `Net.save`、本机落盘 `AssetLocal`（含 `hideAsCloud` 那张闸）、就地二次确认 `Confirm.arm`、弹窗 `UiDialog`、提示 `Toast`、**「四档之外」那三排声明驱动控件** `AdvExtras`（判据 / 画法 / 读回，见 §2 那两条）。发现重复实现 → 收敛到公共模块，别复制。
- **「秒数 / 日期 / 文件名 / 那三个网络数字」四族各只有一张表或一份函数，页面不许再抄拼法与上下限**（`tests/selfcheck.cjs` §J ⑰–⑳ 四支）：
  `Wb.fmtSec` / `Wb.fmtClock`（「X 分 Y 秒」与 `mm:ss`）、`Wb.fmtWhen` / `fmtWhenSec` / `fmtHM` / `fmtHMS` + `ui.js` 的 `dayKey`（并**禁用浏览器 locale API**）、
  `fileSafe` / `fileStamp`（浏览器与 Node **各一份**，两边运行时不同，共 2 份定义是登记在案的例外），
  「这一条素材是哪一类」三块读法 `isAudioType` / `mediaKindOf` / `fileExtOf`（各只在 `ui.js` 一份；收成之前四页的下载扩展名口径互不相同，一条没有 `format` 字段的音频从资产库下回来是 `.png`），
  `Net.NUMS` 一张表 + `Net.num` / `storedNum` / `setNum` 三个出口（超时 / 重试 / 轮询间隔的默认值与上下限全站只那一张表，**页面里连那三个键都不许出现**）。
  四支判据一律**两头都要在**：被禁形状 0 处 **且** 公共实现有定义、有调用、**落点点名到文件**（少了落点那一头 = 「把公共层删光、页面也不问了」照样全绿）。
  行为层常驻五支：`.tmp-netnum.cjs`（25 条 vm 口径）+ `.tmp-mutnetnum.cjs`（九刀）+ `.tmp-netnumdom.cjs`（13 条真 DOM）
  + `.tmp-fileext.cjs`（27 条，真 `ui.js` 装进 vm 直接问那三块读法）+ `.tmp-mutfileext.cjs`（11 刀）。
  两支真 DOM / 行为档各抓到一个「读代码看不出来」的真缺陷：`.tmp-netnumdom.cjs` 抓到轮询退避那道 `Math.min(…, 30000)` 把用户设的 60 秒档也压成 30 秒（现在是 `Math.max(baseMs(), Math.min(…, BACKOFF_CAP))`），
  以及 `clampNum('')` 把「删空那一格」当成「填了 0」而夹成下限（超时变 5 秒、重试变「不重试」；读的那侧 `storedNum` 认「空 = 没填」，写的那侧现在也认）；
  `.tmp-fileext.cjs` 抓到 `fileExtOf` 只剥 `format` 的**前导**点与空格，`format: ' mp4 '` 被当成「认不出的 format」而退回按类型猜（尾缀于是是猜的，不是那份产物自己的）。
  **镜像链两处仪表坑**（别照着改产品）：`el.min = sp.min` 会反射成 DOM 属性，运行时 `getAttribute` 分不出「填进去的」与「抄进去的」；
  代理 `.data/<key>.json` 落的是**裸值**不是 `{data,ts}` 信封。全文在 `docs/agents-公共层与界面约定.md` 的「§J 后面那四条（⑰–⑳）」。
- **「供应商类型」那一排叫什么、按什么顺序，全站只有 `ui.js` 的 `provKindZh` / `provKinds` 一份**（2026-10-15 从四份收成：设置页一张 `KIND_ZH` + 一份手抄 `['image','video','audio','text']`，助手同样两份）：
  档名与顺序由那张表决定，**注册表将来加第五类时那一排 tab 要自己长出来** —— 抄一份键序就是「加一档要改四个地方」。
  ⚠ **三族名字不许合并**（差的就是 `audio` 那一格）：素材那族叫「音频」（`ui.js` 的 `isAudioType` / `mediaKindOf` / `fileExtOf`，Node 侧那份故意叫 `MEDIA_KIND_ZH` —— 同名而不同值迟早被后来人合成一张表）、
  供应方那一型叫「语音」（本条）、提示词归档里那一行任务叫「语音合成」（`assetlib.js` 的 `ARCHIVE_TYPE_ZH`）。
  常驻判据 `tests/selfcheck.cjs` §J ㉓ 三头（被禁形状 0 处 / 「`audio: 语音`」恰好 1 处且落点点名 `ui.js`，**一处没有也红** / 两份读法各定义 1 + 调用达下限 + 落点点名 `settings.html` 与 `ai-chat.js`），
  反向对照 `tests/mutation.cjs` ㉓A–㉓E（A 手抄键序、B 助手自己再写一张表、C 公共定义改名、D 页面退回旧符号名 `KIND_ZH`、E 放行注释与「值不同的那张表」）。
  全文在 `docs/agents-公共层与界面约定.md` 的「㉓ 供应商类型那一排」。
- **「AI 挑了哪几条 / 按什么筛」那一颗芯片全站只有 `ui.js` 的 `AiChip` 一份**（2026-10-15 从四份收成：素材库、收藏、资产库各拼一份 `innerHTML`，统一选择器 `assetlib.js` 的 `AssetPicker` 是第四份）：
  四份当时**恰好都对**，漂开的是**措辞与尺寸** —— 清除按钮的 title 一份写「回到完整名单」、另一份「回到完整列表」，✕ 的图标一颗 10 一颗 11，两份给 `window.icon` 加了守卫、两份没加（守卫在不在只决定「图标那一格空着」还是当场抛错）。
  各页真正不同的只有**芯片上写几段话**（它自己的数据）与**清掉之后各自重画什么**，所以公共层只收画法与出口；`AssetPicker` 那颗靠 `cls` / `clearId` / `iconSize` / `tip` 四个参数接进同一份实现，不是另写一颗。
  常驻判据 `tests/selfcheck.cjs` §J ㉔ 四头（被禁形状 0 处 / `AiChip` 定义恰好 1 处且落点点名 `ui.js`，**一处没有也红** / `paint`·`text`·`picked` 调用达下限（4 / 2 / 2）且 `paint` 落点点名那四个文件 / 那句默认 title 与「AI 挑的」各恰好 1 处且在 `ui.js`、旧句「名单」0 处），
  反向对照 `tests/mutation.cjs` ㉔A–㉔F；行为层另有常驻两支：`.tmp-aichip.cjs`（29 条，真 `ui.js` + 最小 DOM 桩）+ `.tmp-mutaichip.cjs`（14 刀，只临时改 `ui.js`）。
  ⚠ `clearTitle` 那**两种说法是两件事**，做文案统一时别合一句：「清除 AI 结果，回到完整列表」= 退出「AI 挑的这批」，「清除 AI 条件」= 只收回这一条 AI 筛选。
  ⚠ 那条「AI 挑的」判据只认**带尾空格**的字面量 `'AI 挑的 '`（`chars.html` 清 AI 结果时 Toast 那句「退出「AI 挑的那批」」不是副本 —— 留一条会误报的判据，下一轮就有人整档砍掉）。
  全文在 `docs/agents-公共层与界面约定.md` 的「㉔ AI 条件芯片那一颗」。
- **「写一句话让 AI 在本机这一堆里挑几条」整链全站只有 `assetlib.js` 的 `AiFind` 一份**（2026-10-16 从素材库 / 收藏两份逐字副本收成；字数与那句闸门话再收成它上面的 `shortWhy` 一个口子，三处读它：`run`、资产库 `runAiSearch`、统一选择器 `AssetPicker`）：
  两份副本漂开的第一处**不是文案，是说出去的那一格** —— 素材库那两道闸走 `Toast.err`（一定弹），收藏走 `Toast.info`（默认被 `sk_quiet_ok` 静音），于是同一个动作在一页会说一句、在另一页按了什么都没发生。所以公共层内部**零 `Toast`**，话只交给页面自己的 `say` 出口，而且顺序永远是 `done` 在前、`say` 在后（重画会重写那一行读数）。
  收的整链：两道闸（字数 / 空名单）+ 按钮忙态 + 裸 JSON 契约 +「集合 + 名次 + 理由」的记账 + 挑中后清原话。配置里那四格缺一不可：`apply`（**只写那三个字段**）/ `onPick`（放开类型档属于它，写进 `apply` 就等于点 ✕ 连用户挑的档一起改）/ `done` / `say`。
  常驻判据 `tests/selfcheck.cjs` §J ㉕ 四头（闸门话恰好 1 处且在 `assetlib.js` / `MIN_Q` 在 `assetlib.js` 之外 0 处 / `AiFind` 定义恰好 1 处，**一处没有也红** / `run`·`clear`·`shortWhy`·`needMsg` 调用达下限（2 / 2 / 3 / 1）且落点点名到文件 / 两页配置的 `apply`·`onPick`·`done`·`say` 四格齐全且 `apply` 不写 `filter`），
  反向对照 `tests/mutation.cjs` ㉕A–㉕H；行为层另有常驻两支：`.tmp-aifind.cjs`（63 条，真 `assetlib.js` + vm 沙箱）+ `.tmp-mutaifind.cjs`（20 刀，只临时改 `assetlib.js`）。
  全文在 `docs/agents-公共层与界面约定.md` 的「㉕ AI 挑几条那一族整链」。
- **「这一次刷新之后才说的那一句」全站只有 `ui.js` 的 `Toast.after` 一份**（2026-10-15 从 10 个出口收成：`settings.html` 9 处「导入设置 / 恢复默认 / 从数据文件恢复 / 用云端覆盖本机 / 还原备份 / 导入整包」+ `ui.js` 的 `DataSync.boot` 对账那一路）：
  页面自己发起 `location.reload()` 时，当场弹的那一句**活不过它自己宣布的那次刷新**（右上角与卡内读数一起被销毁），而那句写的还是默认静音的 `Toast.ok` —— 两重没落地，于是「改掉了真数据」的动作做完，刷新后的界面上一个字都没说。
  口径：单槽只留最后一句、默认走一定弹的那一档（`warn`）、**取用即清**（同一句话弹两次比不弹还招人烦）、键放 `sessionStorage` 不放 `localStorage`（界面留言不该被镜像进 `.data/` 与云同步）；`after` 只写话，**刷新永远是调用方的动作**。
  常驻判据 `tests/selfcheck.cjs` §J ㉖ 四头（真代码里「正在刷新」0 处 / `Toast.after` 那一格定义恰好 1 处且落点点名 `ui.js`，**一处没有也红** / 调用达下限 10 且 `ui.js` 与 `settings.html` 两头各有落点 / 那把键 `__toast_after_reload` 的字面量恰好 1 处且在 `ui.js`），
  反向对照 `tests/mutation.cjs` ㉖A–㉖E；行为层另有常驻两支：`.tmp-nextnote.cjs`（25 条 + 一条 ⓪：真 `ui.js` + 最小 DOM 桩，`sessionStorage` 底座**跨趟共用**才量得出「留给下一份文档」）+ `.tmp-mutnextnote.cjs`（9 刀，只临时改 `ui.js`）。
  ⚠ **判据钉的是那句话，不是「刷新」这个形状**：改完数据要刷新是对的（`reloadAfter` 那份留着，它另有 `skLeaving` + `dropPending` 两半），错的只是「当面对着一堵将要被拆的墙喊话」。
  ⚠ 探针的 `mkEnv` 必须**当场 catch 住 ui.js 求值期抛错**并打一条红（那条 ⓪）：变异档里「坏 JSON 不兜」这一刀会让整份 `ui.js` 在加载时抛，桩不接住就是「进程崩了、一行红都没有」，读起来像抓到了，其实一条判据都没跑。
  全文在 `docs/agents-公共层与界面约定.md` 的「㉖ 刷新之后那一句」。
- **「同一件事在两页两种叫法」那一族全站只有三个词**（2026-10-16 收：一份平台清单 = **注册表**、一家平台 = **供应商**、下拉里选中的那一条 = **型号**）：
  「注册路由」是代理里那条路由的名字、不是清单本身，「提供商 / 供应方」是「供应商」的第三种写法，「模型」只留给 AI 这个概念（发给它的提示词正文、「本机没有看视频的模型」）——
  同一屏上两种叫法并存，人会以为坏的是两个不同的东西。口径的**出处**是设置页那几处标签（卡名「供应商与密钥」/ 按钮「＋ 添加自定义供应商」/ 表单行「供应商」），不是哪一句提示里的词。
  常驻判据 `tests/selfcheck.cjs` §J ㉗ 四头（旧句 0 处 / 禁词「提供商 · 供应方 · 注册路由 · 文字AI」各 0 处 / 新句达下限并点名落点 / 卡名与按钮仍长在 `settings.html` 的 `<h2` / `<button` 那一格里），
  反向对照 `tests/mutation.cjs` ㉗A–㉗E（A/B 各打禁词里的**不同两个词**，C 只打新句那一头，D 只打卡名那一头，E 证明注释里的历史写法不算命中）。
  ⚠ 第 ④ 头的第二头必须问**标记**：词法器只数 `<script>` 里的字符串，静态 HTML 里那两处一个都数不到（实测：`供应商与密钥` 的 7 处落点全在别页的提示句里），
    所以「卡改了名、六处提示句还指着它」只有比一次标记形状才看得见 —— 只数总量的话 6 处照样 ≥ 下限，而那一屏指的是一张界面上不存在的卡。
  ⚠ 注册表那四个显示名（`OpenRouter 文字 AI` 等）与 `usage.html` 的名称归一化是同一批：那里的正则写成 `文字\s*AI`（两种带法都认），
    因为**代理没重启时注册表递回来的还是旧名** —— 只认一种，用量页就把同一家平台摆成两张卡、同一个余额出现两遍。改 `proxy.js` 这一族要连着改那条正则。
  全文在 `docs/agents-公共层与界面约定.md` 的「㉗ 名词口径：注册表 / 供应商 / 型号」。
- **「只为解码而存在的那一只 `<video>`」外壳只有 `workbench.js` 的 `Wb.vframe.el` / `release` 一份**（取帧两条路以前各建一只、各释放一次；
  漂开的第一处永远是最低调的那一行 `muted` / `playsinline`，而**只 `pause()` 那一份解码器一直挂着、几十格之后整页拖慢** —— 缩略图速度优化优化的正是这一件事）：
  常驻判据 `tests/selfcheck.cjs` §J ㉘ 四头（workbench.js 之外自建 video 0 处 / 孤立一格 `'playsinline'` 恰好 1 处且在公共层 /
  `vframe.el(` 与 `vframe.release(` 点名 director.html **且**公共层内部 `this.el(` `this.release(` 各 ≥1 / `el(x) {` 那个形状全站恰好 1 处），
  反向对照 `tests/mutation.cjs` ㉘A–㉘E（D 那刀**只**红「公共层内部没走这份」，因为 ① 对公共层天然豁免）；行为层由 `.tmp-dirdom.cjs` 的切片格子那一族在管。
  ⚠ **④ 不按「名字全站唯一」判**：`release` 在本项目还管 Web Audio 节点、代理名额与 IndexedDB 连接让路 —— 按名字数唯一会全算成副本（第一版就是这么假红的）。
  ⚠ §J 的 ㉘–㉛ 与 §8 / §9 里 `.tmp-dirdom.cjs` 的同号 ㉘㉙㉚㉛ 是**两套编号**，别互相引用。全文在同分册的「㉘ …」。
- **「按判据清掉一批 localStorage 键」那趟扫描只有 `ui.js` 的 `Store.sweep` 一份**（清 AI 型号元数据与设置页「恢复默认」以前各抄一遍同一个循环；
  **`removeItem` 会让后面的键整体往前挪一格，正着扫就跳过一半** —— 清完还剩一堆，而回执照「表跑过一遍」说「已恢复默认」）：
  判据（哪些键归我管）**留在调用方**，两张表本来就不同。常驻判据 §J ㉙ 四头（`localStorage.length -` 恰好 1 处且在 ui.js /
  `sweep` 定义恰好 1 处 / 调用达下限 2 且点名 assetlib.js 与 settings.html / `sweep` 在 `window.Store` 那张**现取**的面上），
  反向对照 `tests/mutation.cjs` ㉙A–㉙D。⚠ ④ 是这一族最容易复犯的一头：函数写在闭包里而没挂上表，调用方拿到 undefined，清 0 把键照样报「已恢复」。
  全文在同分册的「㉙ …」。
- **「AI 回的那一串反问怎么读」那族别名只有 `assetlib.js` 的 `TextAI.qaOf` 一份**（抽屉以前自己抄了 `q / question / title` 与 `label / text`，
  抄出来的不是一份代码而是**一份代码 + 一套上限**：6 个候选不限题数 vs 8 题 × 10 候选 —— 同一次反问在两处画得不一样）：
  **每题候选上限**跟着调用方给（公共层 `QA_O_MAX`），**题数**那一档留在 ai-chat（`ASK_Q_MAX` / `ASK_O_MAX`，那是那一格的排版性质、不是反问契约），两份各圈在自己文件里。
  常驻判据 §J ㉚ 四头（`.question` 的落点全在 assetlib.js / `qaOf` 定义恰好 1 处 / 调用达下限 2 且点名 ai-chat.js /
  那三个上限名各只在自己文件里且 `qaOf` 在 `window.TextAI` 面上），反向对照 `tests/mutation.cjs` ㉚A–㉚D（B 那刀**刻意让 ③ 保持绿**）。
  全文在同分册的「㉚ …」。
- **四颗「存回本机」按钮的画法、在途守卫与回执只有 `assetlib.js` 的 `AssetLocal.pull*` 六个出口一份**（收之前四页各写一遍「图标 + 计数 + title」与各写 `dataset.busy`，回执四种说法）：
  漂出来的两处真缺陷 —— 生成工作台只看旗标、没看成「在途时整颗不要重画」（右栏每 3 秒重建，「存回本机 7 / 20」被冲回 0）；
  收藏那一档的红绿判据少算 `skip`（整屏全是「太大下不动」时 ok=0 仍报一句绿）。
  常驻判据 §J ㉛ 四头（`dataset.busy` 在 assetlib.js 之外 0 处 / 六个 `function` 定义各恰好 1 处 / 调用达下限且**四个页面各自点名** /
  title 那两句各恰好 1 处且在公共层，六个名字都在 `window.AssetLocal` 面上），反向对照 `tests/mutation.cjs` ㉛A–㉛E；
  落盘链的行为层是 `.tmp-mirror.cjs` / `.tmp-mirrorbus.cjs` / `.tmp-btn.cjs` 那三支（**这一档只管按钮那一层**，`hasLocalAddr` 与 ⑨ / ⑨-b 各有各的档）。
  全文在同分册的「㉛ …」。
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
- **导演台剪辑（本镜 / 全片轨道）的账只有一份 `c.segs`**（切开 / 向左切 / 向右切 / 删段四个入口同走 `segsOf`/`segsWrite`（「不剪了」那颗已删，见 §8 那一节），本镜与全片两处读同一份 —— 剪一刀两处同时变；配音 `{seg, at}` 跟着重算）；常驻探针：口径 `.tmp-cut.cjs`（69 条）+ 真 DOM `.tmp-cutdom.cjs`（25 条，含右栏换声音栏、轨道铺切片图、删段武装态）+ 反向对照 `.tmp-mutcut.cjs`（现役 63 刀）/ `.tmp-mutcutdom.cjs`。**「型号清单首败要刷新」的同源 GET 退避重试**同层还有一支：`.tmp-capsretry.cjs`（CDP Fetch 域掐断开页第一发 `/capabilities`，判据 = 页面自问一次 + 清单与对照趟一致 + 零平台 POST）+ `.tmp-mutcapsretry.cjs`；底座与跑法在分册同节。
- **模板那一族（`create.template`，MiMo 就是）的提交体只认识模板里写过的 `{{…}}` 键**，所以声明出来的 `create.topBools` 顶层开关会在 `Api.create` 里按声明补回顶层（公共层一处，页面不判平台）—— 少了这一段就是「开关照样画出来、勾了却一个字都不发」。
- **去重素材的「复用」回包不是异常形状**：平台按 sha256 命中已有素材时只回 `{asset_id, state:READY, reused:true, upload:null}` —— 既没有上传地址，也不用发 complete。`AssetTransfer.uploadTo` 的判据是 `reused = !!assetId && !putUrl && (intent.reused===true || /ready/i.test(state))`，命中直接 `return assetId`；**绝不许**把「有资产号但没 upload.url」当成形状不对去重试（重试就会又走一遍意图、把整条合并打断 —— 用户看到的「合并失败：缺少资产号或上传地址」就是这么来的）。常驻判据 `.tmp-reuse.cjs`（11 条）+ `.tmp-mutreuse.cjs`（变异 `reused=false` → 5 条红）。
- **合片轨道的两页签（本镜 / 全片）画的是同一套格子**：格子按 `left/width` 百分比绝对定位（全片不是 flex 流），都带 `.cut.l/.r` 红把手与 `.tl-pin` 插针，全片**每一镜**都铺自己的 `data-frs` 切片；成片秒 ↔ 源秒的换算只有 `filmToSrc`（含 `speed` 折算）一份，落点夹取只有 `filmSeek`。**插针的点击区是整条 `.tl-bar`**（`bindPinZone`，`padding:12px 0` 让上下空白也算），不是格子本身 —— 改样式时别把 padding 或 `cursor:pointer` 收掉。常驻判据：口径 `.tmp-filmtrack.cjs`（19 条）+ `.tmp-mutfilmtrack.cjs`（6 刀）；真 DOM 层**用 jsdom 那支 `.tmp-dirdom.cjs`（254 条判据）+ `.tmp-mutdirdom.cjs`（现役 143 刀）**—— 沙箱里 Chrome 起不来，`.tmp-cutdom.cjs` 那支跑不了，jsdom 这支配了假 IndexedDB（事务 `tx.oncomplete` 才兑现）、`crypto` 用 `defineProperty` 盖、`getBoundingClientRect` 要 `fakeRect`。
- **合片的出口只有页头那两颗「导出」，播放那一颗已删**：剪辑下方「重新合并 / 播放合成的视频 / 下载成片」三个按钮已删（`#mfState` 改指页头入口）。
  顶部那一排现在是「导出成片 / 导出素材 / 导入项目 / 导出项目」四颗并排（2026-10 用户点名把合片出口搬到页头）：
  **绑定也只有页头这一处** —— 剪辑栏每 3 秒随整列重建，把出口绑在那里等于每次重建都要重绑，
  而导出中写在按钮上的那句「取消渲染 45%」会被下一次重画冲掉。
  **「播放成片」那一颗（`#playFilm` → `playWholeFilm()` / `playMergedFilm()`）整颗删除**：看整片走「剪辑 → 全片」
  那一排播放器自己的 `#pbBtn` → `TlPlay.play()`，它按时间线**实时播**，**绝不为播放 `renderPost`**；
  要一个文件才点页头的「导出成片」。ffmpeg 只在 `exportFilmFFmpeg`（导出成片）与 `exportFilmAssets`（导出素材）里发生，
  所以合并中那套状态机（`merging` / `mergeProgress` / `mergeJobId` / `paintMergeBtn` / `#mfBar` 进度条 / 按钮变成「取消合并 X%」）整体删除，
  播放也从此没有可取消的第二态 —— 留着就是「按钮说它会合成，而合成又不是它发起的」。
  `exportFilmFFmpeg` 里 `if (proj.merged && filmIsCurrent(proj.merged)) { await downloadMergedFilm(); return; }` 那道快捷闸
  是「盘上那份是当前的 → 不再跑一遍 ffmpeg」的唯一落点，删播放那一条路时最容易连带把它摘掉。
  所有会改动成片内容的编辑出口仍统一走 `filmEdited()` → `renderAll(); scheduleSave();`（**不再自动重合并**：
  剪辑是连续微调，每改一个入点就跑一遍 ffmpeg 等于一直在重复合成）。
  **「盘上那份是旧的」那一格界面文案 2026-10-15 整块删除**（用户点名：镜头统计 + 陈旧说明那条）：
  成片新旧现在只在**点导出那一刻**由 `exportFilmFFmpeg` 的快捷闸（`filmIsCurrent()`）自己判，界面上不再挂一句常驻的「内容已变动」。
  **新增任何会改变成片内容的入口，仍要接 `filmEdited()`** —— 少了那一句，快捷闸会认那份旧的壳、把过期成片递出去。
  常驻判据 `.tmp-dirdom.cjs` ⑩ / ⑳a–⑳e（源码级零残留 + 各只在页头画一次 / 播放器接的是时间线那份计划 /
  点播放零次 `POST /render` / 当前那份直接落盘、过期那份真发一次合成），
  反向对照 `.tmp-mutdirdom.cjs` M14（播放那颗换成发 /render）/ M15（导出不认指纹）/ M16（`setPlan` 收到空表 = 实时预览整个没了）。
- **快捷闸递出去的那份文件可能已经没了：404 / 空文件必须把 `proj.merged` 当场作废**（`director.html` 的 `renderBlob` → `downloadMergedFilm`）：
  成片文件**不按数量清理**（代理只清渲染中途崩溃留下的临时目录），但 `filmIsCurrent` 比的是**指纹**、不知道盘上还有没有这个文件 ——
  所以「记着的那份」与「文件真的在不在」是两个口径（手动删过 `.renders`、设置页把渲染目录换走、上一次合成没写完都会 404），只问前者就会走进死循环：点导出 → 快捷路径 → 404 →
  记着的那份仍然「是当前的」→ 下一次点还是同一条路、同一个 404。
  `renderBlob` 对 404 挂上 `err.gone`，`downloadMergedFilm` 见 `gone`（或 `blob.size === 0`，上一次合成写崩剩个空壳）
  就 `proj.merged = null; renderAll(); scheduleSave();` 并把出路写成「再点一次右上角『导出成片』会重新合成一份」。
  **那句文案不许再指「重新合并」** —— 那三颗按钮在本项目是已删状态（见上一条），指着它们等于承诺一件页面上没有的事；
  而「作废 + 再点一次真跑 ffmpeg」是同一个缺陷的两半：光改文案，用户点了还是拿到同一个 404。
  常驻判据 `.tmp-dirdom.cjs` ⑳f / ⑳f2 / ⑳f3（404 与空文件两种坏法各一次：零次 `POST /render`、零次落盘、`proj.merged` 变 null、
  那句话点名「导出成片」且不含「重新合并」；作废之后再点必须真发一次合成），
  反向对照 `.tmp-mutdirdom.cjs` M61（调用点不走作废）/ M62（文案退回「请重新合并」）/ M63（`err.gone` 摘掉）/ M64（空文件不拦）。
- **字数闸一律按供应商声明，页面不许自己编数字，而那份「编数字」的活全站只有 `assetlib.js` 的 `window.CharLimits` 一份**（`bounds / tts / prompt / has / count / range / note / cntLine / over / gap / why`，2026-10-16 收拢）：提示词走 `promptLimitOf`（`resolvedModel→provOf→create.promptLimits`；**现在注册表里没有任何一家声明** —— VGENV 那条 5–30000 来自一次实测到的上游校验串，而用户实测短提示词（「特写」这种两三个字的镜头描述）照收，于是那一栏旁边的「这一家 5–30000 字」是替平台编的限制、整块删了；**机制留着**，下一轮谁家真声明就照样生效），没声明的供应商一个字都不显示、也不拦；配音走 `tts.minChars/maxChars`（MiMo 5–5000、MiniMax 1–10000），显示在 `#voiceCnt`、越界写 `#voiceLenWhy` 并压暗 `#voiceAdd`。四个落点一律问公共层，不再各拼一句：工作台 `submitBlockReason` 的语音分支、导演台 `voiceLenWhy`、`#voiceCnt` 那行读数（**初次渲染与 `oninput` 就地刷新同一句 `cntLine`** —— 就地那一下只写「N 字」就等于把声明的区间抹掉，敲第一个字后界面上就没有那一家了）、`Api.createBody` 提交前那一道闸。收成一份之前正是**四套说法 + 两套计数**：提示行不 trim、就绪判定 trim，于是「界面上写着 5 个字」与「按钮说不达门槛」能同时成立。常驻判据 `tests/selfcheck.cjs` §J ㉑ 四头（唯一定义且在 assetlib.js / 页面不许再出现那六句老措辞（按**字符串 token** 数，注释里讲历史的照不到）/ 公共层那句 canonical 措辞还在（少了它「页面不许出现」就成了空断言）/ **落点按文件分头数次数**（`CL_MIN_FILE`：director.html `tts≥2 prompt≥1 why≥2 cntLine≥2`、studio.html `tts≥2 why≥1 cntLine≥1`、assetlib.js `prompt≥1 why≥1`）—— 原来只数**全局**次数，于是「导演台把提示词那一路整块删掉」照样全绿：配音那一路还剩两处 `.why`，总数 4→3 仍过 ≥2，㉑C 那一刀跑出来正是这个假绿），外加 `TtsAdv.wayWhy` 定义 1 处、两页各调一次），反向对照 `tests/mutation.cjs` ㉑A–㉑J 十刀（其中两刀专门钉「整块闸删掉、一个字新措辞都不写」与「尺子的底座被换掉」——只查老措辞的尺子在这两刀上照样全绿）；口径两头 `.tmp-createbody.cjs`（**自己 spawn 一份隔离代理**，按 `/sys-status` 的数据 / 资产 / 渲染三个目录认领「答话的就是我刚起的这一份」—— 原先写死打 6300，读到的是那份进程**启动时**的注册表：上一轮把 `promptLimits` 从磁盘删掉之后 6300 上还挂着删除之前起的实例，探针于是红在「注册表里明明有声明」，**红的是仪表不是产品**；真注册表无声明 → 三字**必须放行**；合成声明 → 该拦的照样拦）+ `.tmp-mutcb.cjs` 四刀（want 点名的那几条必须**全红**，缺一条就报「红在别处」；⑯「换人档恰好 2000 字放行」与 ⑨「没声明 → 三字照发」是**故意不红**的档，脚本头注点名各自归谁钉），真 DOM `.tmp-dirdom.cjs` ②c/③/④/④b/**④c（打字之后那行读数仍是整句）** + `.tmp-mutdirdom.cjs` M2a（读数那头）/ M2b（闸门那头）/ M2c（就地刷新自己拼）。
- **导演台右栏「插入语音」与语音工作台共用同一份元件**：平台型号走 `voiceReg()`（registry 声明 + 各家 `/models` 现拉，套 `modelsFilter` 与 `ModelPrefs.isOff`，**能力必须从 `modelDocs` 回填 `modes`/`ttsMode`/`inputRoles`** —— v13 起 `p.models` 可能只剩一个带 id 的空壳，只读它就等于三档掉回预设那一档），音色走 `Chars.Pipe.voices`，「合成设置」块 `#voiceAdv` 由 `tts.formats` + `create.topBools` 声明驱动（开关状态键 `provId::field`，换供应商不串味），提交走 `AiGen.synthTts(…, bools)`。改这一栏前先看语音工作台那一份，别在这里长出第二套判据。
- **「这一句按哪种方式定音色」跟着下拉选中的那一个型号走，判据只有 `Chars.Pipe.ttsWayOfChosen` 一份**（导演台 `voiceWayOf` 与工作台 `curTtsMode()` 都问它）：以前导演台按「这一家有没有预设音色」排优先级（preset > design > clone），于是**选了「音色设计」型号而画的还是预设音色下拉**，选了「音色复刻」时连「选参考音频」那张卡都不出现 —— 三个型号挂在同一家平台上，下拉里全都列得出来。三档控件（`#voicePick` / `#voiceDesign` / `#voiceRefPick`）各自只在对应型号下出现。
  合成前那两道闸也**只有一份**（`voiceWayWhy` 定音色必填的那样东西 + `voiceLenWhy` 字数区间，两者都只是转发 —— 判据分别是 `TtsAdv.wayWhy` 与 `CharLimits.why`，见上面那条字数闸），右栏初次渲染、`paintVoiceGate()` 就地重画、`addVoiceAtPin` 花钱前问的是同三个函数；`design` 档描述空着、`clone` 档没参考音频 → 按钮禁用并把缺的那一格写进 `#voiceWayWhy`（工作台 `submitBlockReason` 的语音分支同一套，**两句的先后顺序也同一套**：先问定音色、再问字数）。常驻判据 `.tmp-dirdom.cjs` ②e–②l，反向对照 `.tmp-mutdirdom.cjs` 的 M5（`ttsWayOfChosen` 退回按平台排优先级）与 M6（`voiceReg` 不回填 `modelDocs`），两刀各钉红 ②g/②h/②i/②j/②k；`tests/selfcheck.cjs` §J ㉑ 还钉「两页都必须真的走 `TtsAdv.wayWhy`」（收成一份之前正是两页各一种说法：一边「要先写一段声音描述」、一边「必须填写风格 / 音色描述」）。
  **夹具的 `create.template` 必须真的带 `{{style}}` 与 `audio.voice`**（`ttsModeUsable` 量的就是这个模板有没有位置放）—— 夹具少写就把 design 判成「这一家放不下」，那是夹具的错，不是页面的。
- **主题变量（`:root` / `html[data-theme="dark"]`）只在 `ui.css` 顶部定义一份**：页面私有变量漏定义 = `var()` 静默取不到值（「变量存在但值为空」不会触发回退）。
- **新增一个页面只改三处**：`app.js` 的 `PAGES`、`sidebar.js` 的 `items`、`ui.js` 的 `PAGE_TARGETS`，代理零改动；漏一处的表现各不相同。
- **「这一页现在怎么翻 / 一页几条」的读法只有一份**（`ui.js` 的 `pageModeOf(key)` / `pageSizeOf(key)`，默认档现读 `PAGE_TARGETS`）：四个页面 + 设置页那张表 + `ai-chat.js` 的读数以前各抄一遍「取存储 || 兜底」，兜底数还各自写死 24 / 18 —— 新页面**不要再自己读那两个键**。常驻桩测 `.tmp-pagesize.cjs`，全文在分册「新增一个页面只改三处」那一段之后。
- **跑 headless / 自动化测试前先给 `.data/` 落基线**：`--user-data-dir` 不等于隔离数据，`Store.write` 会镜像进代理的 `.data/*.json`；没设过的键也会被写。
- **写判据与临时脚本时的几条纪律**：读数与预期相反**先怀疑仪表**（先证尺子再信读数）；每档写完都要把它破坏一次确认它真会红，**变异后仍全绿 = 这一档是假的**；一次性迁移脚本**第二次跑会把自己上一轮的产物当成原文覆盖掉真东西**（本轮就踩过：拆分脚本再跑一次，三册正文被索引重写了一遍）。**跑「会临时改写源码」的变异脚本之前，先跑一次只读的锚点干跑** `node .tmp-anchordry.cjs .tmp-mutcut.cjs`（把脚本里的 `MUTS` 字面量抠出来，按现文件的行尾逐条查命中，一个字节都不写）—— 界面文案一缩短、或公共层把两处读数收成一份（`voiceVolOf` / `voiceAx` 那两次），锚点就命中 0 次：脚本照样报「全绿」，而那些刀**从没落下过**（2026-10-14 一次 dry run 就查出当时那份 `.tmp-mutcut.cjs` 44 刀、`.tmp-mutfilmtrack.cjs` 6 刀全命中，才敢真跑；同一轮 `.tmp-mutdirdom.cjs` 的 M8 正是这样被抓出来的）。`atob→Uint8Array` 那批「临时扫描脚本自己撞的坑」逐条在分册 §3 那一段里。
- `/save`：镜像流程内部（`assetlib.js` 的 `runOne`）顺手多写一份，只挂在那一处（§F 守着）。
- `/save-local`：补存。字节已经在 `.assets` 里，直接拷一份，不重新下载、不回源、`.assets` 那份一律不动（§G 守着）。它存在是因为上面那条链先被那道守卫挡在前面 ——开关打开之前下载的那批永远不会被补写，用户把开关打开、目录也填对了，目录里还是空的…
- `/save-move`：搬。换下载位置时把旧目录里那些副本挪过去，会删源文件。与补存分成两条路由、两种返回，页面才能分别告诉用户「哪些是复制、哪些是搬走」。
- 另存目录**留空**的落点 = 系统下载文件夹下的 `拾帧\<类型>`（2026-10-15 起）：留空不再等于「不另存」；`autosaveDir()` 的 `''` 只剩「这一类被关掉」一个来源（`/save` 的 409 文案跟着改）；老默认（项目内 `文件\<类型>`）由 `/save-move` 的 `@default` **两代一起认**（`autosaveDefaultDirs`）；探针口 `AUTOSAVE_DIR` / `AUTOSAVE_LEGACY_DIR`（老目录在开发机上就是真实成品，必须指走），常驻判据 `.tmp-savedir.cjs`。全文在分册「另存到用户指定文件夹」那一段。
- 顺序永远是先搬后补：反过来会出问题 —— 补存把旧的又拷了一份到新目录，紧接着搬迁再搬一份，同一个视频在新目录里就是两份（撞名的那个还带 `-2`）。
- **「旧目录里还剩多少没搬」只能由代理现扫磁盘**（`GET /save-stale`，2026-10-15 补）：只读、只认 GET、进 `LOCAL_ONLY`（跨站 403）、`no-store`，`saveStaleScan()` 的来源表与 `/save-move` **共用同一份**（`autosaveDefaultDirs` 两代默认 + `autosaveUsedRead()` 自己写出去过的目录），排除当前目标与 `insideLocalDir`（`.assets` 是资产本体，永远不算「还没搬」）。四条各自的理由：
  ① **`on: false` 的那一类照样数得出**（关掉开关不等于那些副本不存在），但界面那一行两颗按钮必须 `disabled` 并把「先在上面打开开关」写进 title —— 目标是配置算出来的，这一类没开就没有目标，按下去只会拿 409；
  ② **老代理回 404 = 「数不清」，绝不是「旧目录里是空的」**：`Api.saveStale` 走 `rawFetch`，非 2xx 抛错并带 `err.status`，页面按 status 分成 `old` / `io` / `none` 三句不同的话（`AS_STALE_TXT`），`io` 还要把代理回的真实原因带出来。那一句假话下面正好压着一颗会删源文件的按钮；
  ③ **数字与体积一律现读，页内一个都不估**（`mbOf` 只格式化代理给的字节）；
  ④ **失败态不许粘住**：`paintAsStale` 进来先 `el.hidden = false`，只有「真数不出货」那一支才收起 —— 上一趟数到 0 时那一排是收起的，这一趟代理挂了，那句「数不清」写进仍然 hidden 的壳子等于一个字没露（表现是「那一排整块消失」，比报红更糟；本轮真缺陷，变异 S20 钉着）。
- **「界面上那个数字」与「真搬得动的东西」必须共用一份严格类型判据**：`productKindOfName()` 按文件名认出「这一处目录里的这个文件是哪一类的产物」，**数（`/save-stale`）与搬（`/save-move`）都只认它**。松一头的后果是实的：用户在旧目录里放着自己的 `notes.txt`，界面数出「还有 4 个」，点「搬过来」把这 4 个连别人的文件一起**移走并删源**。判据严 = 数出来的每一个都真搬得动；判据松 = 那个数字是一次删源的承诺。
- **「本机资产库占多大地方」这一格只数不删**（`GET /assets-usage` → `proxy.js` 的 `localUsageScan()`，2026-10-16 补，plan 后端完善清单第 5 项）：只读、只认 GET、进 `LOCAL_ONLY`（跨站 403）、`no-store`，判重身份复用 `localUpKey`（与 `GET /local-assets` 那份**同一个**，剥掉签名参数）、类型复用 `productKindOfName`、时刻复用 `localAssetWhen`。这一格存在的理由只有一句「在盘涨到几十 GB 之前先看得见」，而它最容易坏掉的四种方式全是**说错话**：
  ① **「数不到」与「本来就没有」是两个口径** —— 旧代理回 404 时 `Api.assetsUsage` 交回 `null`，页面说「这一项旧代理不支持，重启一下再点重新数一遍」，**绝不许报「0 B / 盘上是空的」**（那是一句会让用户以为自己的产物丢了的假话，而且他接下来会去找「回收站」）；其它状态（503 / 超时）继续抛、另起一句「数不出本机资产库：+ 代理给的原因」。
  ② **「一键清理」永远不长在这一格上**：一次统计动不到用户的作品。而重复组只是「多出来的份数与字节」，`LOCAL_INDEX_MAX` 之外被挤掉索引却仍要留着的历史产物、以及 `索引有、文件没了` 那批**在磁盘扫描里长得一模一样** —— 统计分不出哪一些能删。所以这一格唯一的出路是 `USAGE_WHY.出路` 那一句：指着「资产库」那一次带二次确认的删除（页面只 `GoPage`，不写 DELETE）。
  ③ **判重口径与 `GET /local-assets` 分家** = 界面出现「这里说没重复、列表里同一份卡三张」；`同来源` 与 `同内容` 是两族（后者 host 不同、字节相同，只按来源认就会漏），两族各认一半、并成一族算，「留下的那一份」按**哪一份新**而不是哪一份大。
  ④ **内容级判重要有字节预算**（`USAGE_HASH_BUDGET` = 96 MB，只有 `size` 相同才去读；`usageShaCache` 上界 8000 条，长跑进程里缓存自己也要有界）：没有它整目录同步读会把事件循环按住几秒，期间轮询 / 取图 / 播放全停；用完预算必须说「还有 N 份同大小的没验」（`判完:false`），不许装作判完。
  另外三条同一立场的：字节与时刻一律走公共层（`usageBytes` → `window.fmtBytes`、`usageWhen` → `window.fmtWhen`，页面与公共层都不许再拼一张单位表 / 用 locale 排日期，坏时间与 0 不冒充 1970）；上限那个数字**现读代理的**（页面不许抄 20000）；扫描一个字节都不写不删（崩溃残留的 `.tmp-` 与 `index.json.bad-*` 只是**不算产物**，不是顺手清掉 —— 那是另一格「清理缓存」的活）。常驻判据 `.tmp-usage.cjs`（四层：① assetlib 那一份说法进 vm、沙箱里的 `fmtBytes`/`fmtWhen` 桩故意长得不像，输出没带 `[[B…]]` 就是没走公共实现；② 代理侧两个纯函数进 vm，连依赖表一起抠 —— 表改了而这一档不红才是问题；③ 设置页那一栏源码级；④ 隔离实例真跑：造五份产物 + 手写索引，含「两次扫描之后目录逐字节没动」「跨站被 `LOCAL_ONLY` 拦在 403」「目录其实是个文件时 HTTP 照样答、档必须标红」；夹具的期望值由 `FIX` 现算，不留手抄数字。变异三族 MP1–MP6（打在 scratch 副本上，磁盘 `proxy.js` 一个字节不动）/ MA–MF / MS1–MS6（打在内存文本上）各点名期望变红的编号）。
- **换目录那句问话不能只挂在「刚改完那一刻」**：那一刻只有一次机会，错过（或者压根没弹）几百份成品就永远躺在旧目录里。所以两条出口都要有，且**动文件的实现只有一份**（`settings.html` 的 `doFollow(c, pick)`：问话那条路径与下面那一排两颗按钮都走它，先搬后补、计数全部来自代理回执）：① 改完目录 / 勾开关 / 挑完目录那一刻问一次（`askFollowTarget`），② 卡内常驻那一排「旧目录里还没搬走的」（`[data-as-stale]`，一类一行，搬完自己重数、数空就整排收起不留两颗会失败的按钮）。三个容易各漂一处的细节：
  **「恢复默认」必须 `force`**（三格清成空串而上一版**也是空串**，按配置比字符串永远读出「什么都没改」，那句问话在这台机器上一次都没弹过 —— 用户报的正是这件事）；`force` 那一趟改读**磁盘那份数**；
  **同一页里答过「先不动」的那一类不再自动问第二次**（`AS_DISMISSED`），但**用户真的改了目录时必须照问**（`changed` 绕过它），否则下一次生成又往他刚拒绝的地方放；
  **`Confirm.arm` 只管「搬」那颗**（它会删源，第一次点只武装），「只补存」不删东西、一次点击就发 —— 给它也套上武装态等于白挡用户一次。
- **问话与回执里那句「搬到哪儿」只能读刚写进配置的那一个**（`askFollowTarget` 里 `c.to = chg[k.id].to || ''`，2026-10-15）：缓存那份扫描是**改之前**数出来的，它的 `to` 还停在旧位置（代理按它当时读到的配置算，而刚落盘那一次镜像还没跑到代理），拿它说话就是「问你要不要搬到 A，点完实际搬到 B」—— 真目标一直由代理从配置读、页面递不过去，所以这里错的**只有那一句显示的话，而那句话正是用户点「搬过去」唯一的依据**（变异 S16 钉这一条）。同理：回执那句必须按**原因码**说话（`asked` / `skip` / `nothing` / `nochange` / `busy` / `noapi` 各有一句，`asFollowMsg` 一处派）—— 以前只有「问过了」与「没得挪」两档，于是**明明数出 3 个、框也弹了、用户点了先不动**，回执却说「旧目录里此刻数不出还没搬的副本」，那是假话，还顺手把唯一的常驻入口否了（变异 S28 / S29 各钉一半）。
- 上面这几条的常驻判据：代理侧 `.tmp-stale.cjs`（23 条，末尾自带 N1–N5 变异：临时改写 `proxy.js` 再按 SHA256 核对还原 —— 它会碰磁盘，**别和另一路会话同时跑**）；界面侧 `.tmp-setdom.cjs`（jsdom 真 DOM，⑥i 一族 + ⑬ 一族 40 条：数得到 → 看得见 → 按得动 → 自己重数，含 `/pick-dir` 三档桩「真挑中 / 用户取消 / 弹不出来」与「挑完路径落进输入框并当场落盘、还能在框里改」）+ 反向对照 `.tmp-mutsetdom.cjs` S16–S32（每刀 `want` 点名期望变红的编号；`SETDOM_ONLY=S16,S20` 分片跑，全量连跑会被系统收走内存）。
- 四条硬约束（各有一条判据守着，别在调用点另写一遍）：① 目录只从配置读，请求体里带 `dir` 一律忽略（与 `/save` 同款立场，§G）；② `/save-move` 的来源必须过 `autosaveUsedHas`（`.data/sk_autosave_used.json…
- 设置页的提醒只在勾开关 / 改完路径 / 挑完目录时触发，绝不在 `oninput`（逐字输入）时触发：打一个字弹一次框，而且那时的目录多半还是半个。
- `.assets` 是资产库的本体，不是另存的源：`/save-local` 只拷不删、§G 守着；而且本机文件真没了还有三级回退（代理 `/asset/<id>` 本地优先 → 索引里的 `upstream` 重下 →问平台 `assetInfoOf()` 要地址），所以「搬走…
- 读与写是两张表：`TOOLS` 里全是 GET 与本机读（`overview` / `tasks` / `history` / `models` / `model` / `chars` / `fav` / `assets` /`prompts` /…
- 助手提交的任务由外壳自己等（`ai_chat_watch`，`K_WATCH`）：`runGenerate` 拿到任务号就 `addWatch`，`watchTick` 每 `WATCH_EVERY`问一轮，判据只有 `probeWatch` 一份（轮询器与 `tasks` 查询…
- 动作必须先过确认卡片（误触一次就是真金白银的重复扣费，见 §4）：`RUN:` 解析出来的动作校验全部做完才画卡片（型号属于哪家、参数取值在不在声明里、槽位上限、素材从哪来），卡片画出来时用户点「执行」才真提交 ——卡片上写明「哪一家 / 哪个型号 / 什么参数 / 哪些素材从哪…
- 附件的凭据只有本机地址：`CALL: files` / `read_file` 与动作里的 `inputs` 只认 `/asset/`、`/getv/`、`/local-assets/`，外部直链一律拒（递出去的是「这个文件在哪」，不是「随便替我访问一个网址」）。
- 设置项只有白名单（`ADJUST` 那几项 + `window.PAGE_TARGETS` 的行 + `sk_model_<kid>` + `chars.js` 的 `Chars.SET` 那几项）：`writableKeys()` 是现读这几张表拼出来的，不是手抄的键名清单 ——…
- 助手自己在界面上挑的那一家 / 那一个型号只存 `ai_chat_pick`，绝不写 `sk_text_prov`（「作用文字 AI」是设置页「文字」那一档每张卡上的单选，替他改就等于把他选的供应方换了）。
- 流式进行中不许「清空」（`paint()` 会把正在往里写字的那条气泡一起清掉 —— 字丢了，请求还在跑、还在扣 tokens）；断开这一层（刷新 / 关掉外壳）时 `pagehide` 要把已经写出来的字落盘，并写明这次断了。
- 抽屉里「贴到底」的账只有一份，而且要在布局落定之后算（`paint(jump)` 的三种贴底条件 + `note()` 在改布局之前取 `atBottom`、显示完再按新视口贴一次）：`#acNote` 那一行一显出来就把 `.ac-body` 吃掉 26px，「贴完底再补一句回执」的顺序于是停在底部上方一行多 —— 最后那句看不全。判据 `.tmp-acnote.cjs` + `.tmp-mutacnote.cjs` 第 ⑥ 刀…
- 对话记录是会话表（`ai_chat` = `{v:2, cur, list:[{id,title,at,msgs,acts}]}`），不是一条扁平数组：`msgs` / `acts` 仍是模块级变量，切换会话时 `bind()` 整体重新指向当前那一份 —— 现有 `msgs.p…
- `watchTick` 整轮包 try/catch，而且无论成败都要再排下一轮：以前 `startWatch()` 是最后一行，读清单 / 探状态 / 写结果里任何一处抛错，轮询链就静默断掉 —— 球上一直显示「在等 N 条」直到刷新，而任务其实早就好了。
- 输入框：Enter 发送、Shift+Enter 换行。`e.isComposing || e.keyCode === 229` 要放行 ——中文选词上屏那一下还会再触发一次 keydown，挡不住就是「刚选完字直接发出去」。placeholder 与 AGENTS/README…
- `/sys-status` 只有一份取法与一份说法（`assetlib.js` 的 `Api.sysStatus(fresh)` / `Api.sysTool(t)` / `Api.sysDir(d)` /`Api.sysStatusLines(s)` / `Api.SYS_WH…
- **「带病还在跑」要看得见：代理自己记一份**有界**故障账**（`proxy.js` 的 `noteFault` / `noteWork` / `healthStatus` → `/sys-status` 顶层 `健康`，进设置页「本机环境」与助手 doctor）：四个顶层出口各记一笔（未捕获异常 / 没接住的 Promise / 请求处理里抛出、回了一句页面收不到的 500 / 连接错误）。两条立场别混：**只报不自杀**（出路只有「在启动器点重启」，重启后这份账清零）与 **`连接错误` 不算故障**（浏览器提前断开一天几十次，标红就是骗人重装）。条数封顶、同一句重复只抬计数；`/sys-status` 自己**不算**「最后一次干活」；体检命中缓存**也要重算健康**。三份读法（`Api.sysHealth` / `Api.sysFaultLines` + `sysStatusLines` / 设置页那一行 / 助手 doctor）**只读代理给的字段** —— 页面不许算 `cls`、不许拿中文猜档、**不许替旧代理说「正常」**。全文在分册 §3，常驻判据 `.tmp-health.cjs`（三层：口径进 vm、复制文本真拼一遍、隔离实例真打 + 掐 15 次连接；反向对照 MH1–MH19，变异只打在内存语料上）。
- `.tool` 磁贴的显隐要用 `hidden`（`ui.css` 里有 `.tool[hidden] { display: none; }` 这条兜底）：`.tool` 自带 `display: inline-flex`，会和浏览器默认的 `[hidden]{display:n…
- **设置页「资产库磁盘用量」那一栏与「本机环境」共用同一份芯片行形状（`chipRow` 一份）与同一份说法（行文只来自 `Api.usageLines`）**：上色只认代理给的 `档`、页面不拿中文猜，404 与真出错分两句话说且都不编数字，出路那颗只负责带去资产库（这一栏**没有清理出口**、不写盘、不进同步）。全文在分册 §3「本机资产库占多大地方」那一段，代理侧立场与安全在 §4，常驻判据 `.tmp-usage.cjs` 层 ③ + 变异 MS1–MS6。
- AI 润色是两段式，就地问（`ui.js` 的 `InlinePolish.interactive`）：页面只提供两个回调 —— `ask(): Promise<{need, questions[]}>`（问要点）与 `run(answersText): Promise<{aft…
- 润色要把用户的素材交给 AI（已实现，别再退回「只说一句」）：`TextAI.polishImages(REG, [{label,src}])` 把参考图压到最长边 1024 的 JPEG、按 OpenAI 多模态格式附在消息末尾，并写明「图1 = 参考图 1」；只有识图型号才带…
- AI 指令的默认文本只有一份：`assetlib.js` 的 `TextAI.DEF`（video / img / audio / story / split）+`TextAI.prompt(kind)`（用户改过的优先）。
- 润色「对模型的交代」六句只有一份，「出结果后接着对话」那一行也只有一份（2026-10）：`TextAI.polishUser / askUser / answersNote / polishExtra / polishSys / followPrompt` 是发出去那几句话的**唯一**落点，页面只传参数；对话行 `.pinl-chat` 只在 `ui.js` 的 `InlinePolish.show` 画，且**传了 `onFollow` 才画**、流式走 `ctl.push`、轮次 `o.talk` 由页面持有。常驻判据：`tests/selfcheck.cjs` §J ⑯ + `.tmp-polish.cjs`（19 条，真拼一遍发给模型的正文）…
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
- 设置页改完就自动落盘（2026-10-15，旧的「点保存才生效」那一层整族删除）：唯一触发口是文档级 `change` 委托（逐字敲不算改完），`markChanged()` 只排一个 400ms 定时器，到点 `runSave()` → `saveAllNow()`；那颗「保存全部设置」按钮、那条「待保存」橙色层与 `markDirty()` 这个名字都不许长回来，导入导出与恢复默认排在最下方（不浮动）且先 `flushPending()` 存稳。
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
本节引言里那套 **`tests/selfcheck.cjs` 常驻判据（§A–§L 十二个字母；§A / §C / §G / §J 各有两支，所以它末行汇总报的是 16 条）**——
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
  `.renders/`（`RENDER_DIR`）同理 —— 探针导出的成片会混进用户的成片列表，而且**那里不再按数量清理**，每一份都一直躺着，得自己按名字认领删掉（顺手删整目录等于删掉用户的片子）。
- **代理侧覆盖 / 删除 `.data/<key>` 之前会留一份 `<key>.bak.json`**（`proxy.js` 的 `keepDataBackup`，最少保留 10 分钟，
  内容相同不留，`.bak` 自身不再备份）。它不出现在 `GET /data` 清单里，但设置页「数据与备份」能列出来也能一键还原
  （走 `GET /cloud/backups` + `POST /cloud/restore`，**不需要配置云**）。不要把 `*.bak.json` 加进同步或清单逻辑。
- **只服务本工作台页面的路由集中在 `proxy.js` 的 `LOCAL_ONLY`**（`/data`、`/prompts`、`/cloud`、`/capabilities`、
  `/local-assets`、`/assets-usage`、`/save`（含 `-local` / `-move` / `-stale`）、`/clear-cache`、`/pick-dir`、`/env-status`、`/sys-status`、`/render*`，以及取回/转发类 `/getv`、`/fetch`、`/getfile`、`/s3put`）：
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
- **「往盘上写字节之前先问一眼余量」与「启动先扫自家垃圾」是两条各自一份的判据**（`proxy.js`，2026-10 按后端完善清单第 11、14 项加的）：
  ① **`whyNoSpace(dir, need, what)` 只有六个落点**（`/save` 另存、`/save-local` 补存、`/save-move` 搬迁、
  `/local-assets` 的两条写盘链、以及渲染开跑前的 `whyRenderSpace()`），**判据在写入点之前**：返回一句人话就当场 409 /
  记进 `full[].why` / `failed[].why`，**一个字节都不落**；`ffmpeg` 还没起就退，`.renders` 里不留半个 mp4。
  两个 helper 都必须**同时点名目录、要写多少、只剩多少、留多少余量**（`DISK_HEADROOM = 32MB` 那句「还要留…给改名与备份」），
  渲染那一档只有下限（`RENDER_MIN_FREE = 256MB`），**不许猜一个成片大小**。
  **量不到就一律放行**：老 Node 没有 `fs.statfsSync`、目录还不存在（它会抛错）→ `freeBytesOf` 给 `null` → `whyNoSpace` 给 `null`。
  「这台机器测不出剩余空间」绝不能变成「这台机器什么都写不了」，所以**不许把 `null` 当成「不够」**。
  ② **`sweepStaleTmp()` 在 `server.listen` 那一趟就调**（不递参数 = 只扫 `.data` 与 `.assets` 自家两个目录，**不碰 `.renders`**，
  那里的老任务残留由 `pruneRenders` 同一趟回收）。三道闸缺一条就是删错东西：
  **形状**（只认原子写自己写出来的 `.tmp-<pid>-<2~8 位小写字母数字>`，用户文件名再奇怪也不碰 —— 这条路由清的是自家垃圾）、
  **年龄**（写完不满 15 分钟的一律不动：同机另一个实例正在写的那一个与残留形状**一模一样**；不用 pid 判活，Windows 会回收 pid，撞号的残留反而永远清不掉）、
  **尽力而为**（读不到目录 / 被别的程序占着删不掉只记一行，**绝不影响启动**）。
  ③ **渲染那三个数字全部走 `envInt`**：`RENDER_KEEP_MIN`（30 分钟，任务记录与崩溃残留同一个年龄）、`RENDER_CONCURRENCY`（1，ffmpeg 很吃 CPU）、
  `RENDER_QUEUE_MAX`（20，超了当场 429），启动日志把**实际生效值与它来自哪里**（`.env` / 系统环境变量 / 兜底）一起说出来 ——
  只报数不报来源，用户改了 `.env` 没重启就永远看不出来。
  常驻判据 **`.tmp-diskhygiene.cjs`**（口径层：把那两个 helper 的真源码抠进 vm、桩 `fs` 造「不够 / 问不出来 / 年龄」；
  真实例层：四个落盘基座全指进 `os.tmpdir()`，先种残留再起实例，再验「盘够时六个写入出口一个都不拦」；
  六个变异 —— 余量闸抬到比任何盘都大 / 再加摘掉 `/save` 那一句、证明红定位到那一行 / 摘掉启动清扫 /
  形状闸退回「名字里有 `.tmp-` 就删」/ 摘掉年龄闸 / 渲染下限抬到比任何盘都大，各钉一半，改完按 SHA256 核对还原）。
  **两条这一轮学到的探针纪律**：**变异要让判据在「对的原因」上红** —— 把余量闸抬到最大时 `/local-assets` 先被拦，
  索引里就没条目了，于是 `/save-local` 会进 `missing` 而不是 `full[].why`、`/save-move` 会进白名单 403，
  看着像「拦住了」其实钉的是另一条链；探针必须**自己把索引与 `sk_autosave_used.json` 种好**、并给补存用**与另存不同 size** 的字节
  （同 size 同 sha1 会被 `saveDirIndex` 判成 `dup` 直接跳过写盘）。
  以及 **`/sys-status` 的 `ffmpeg` 在顶层**（`{代理, 出站代理, ffmpeg:{ok,版本}, ffprobe, 目录:{数据,资产,渲染}}`），
  读成 `.工具.ffmpeg` 那一档会天天「跳过」，而报告看着全绿。
- **编码器与档位也不再写死在渲染那一行**（`proxy.js` 的 `ENCODE_PROFILES` / `envOneOf` / `resolvePreset` / `listEncoders` / `pickEncode` /
  `encodeVideoArgs` / `renderStatus` 一整族，2026-10 按后端完善清单第 3 项）：`.env` 的 `RENDER_VCODEC` / `RENDER_PRESET` 声明，
  没配就还是原来那一档（libx264 + veryfast + 界面上那个 crf，分辨率 / fps / 单遍编码一个字节没动）。四条不能各漂一处的性质：
  **① 档位名单跟着编码器走**（`-preset veryfast` 喂 h264_nvenc 是 ffmpeg 当场拒），所以 `resolvePreset` 故意不用「只能比一份固定名单」的
  `envOneOf`，自己现取这一家的 `presets`；**② 质量数落到不同编码器换写法**（x264/x265 `-crf`、NVENC `-rc constqp -cq`、QSV `-global_quality`），
  渲染调用点只走 `encodeVideoArgs` 一处，源码里再出现一份硬编码编码器名就是两个口径（给哑巴视频补静音轨那条 `-c:v copy` 不算）；
  **③ 「填了但没用」有两种，都不能静默**：名字或档位不在表里 → 启动日志 `envWarns` 当场点名并退回；在表里但**这台 ffmpeg 没编进去**
  （很常见：官方 Windows 版不带 QSV，没 N 卡就没有 NVENC）→ 第一次渲染前问一次 `ffmpeg -encoders`（进程内缓存一份 Promise，
  问失败要能重问、不许把坏结果留在缓存里），退回 libx264 并把「配的是谁、为什么换、档位跟着换成什么」写进那一单的 `job.log`；
  **④ 问不出清单当「不知道」，不当「没有」**（拿它退回 libx264 等于凭空换了用户的配置，还会让人去重装一个本来就装好的 ffmpeg）。
  体检里那三档「默认档 / 还没问过 / 这台有 / 这台没有」由 `renderStatus()` **一处**拼话，`/sys-status` 顶层新增 `渲染`；
  三份读法（`assetlib.js` 的 `sysStatusLines` 复制文本、设置页「本机环境」那一行、助手的 doctor）**只读代理给的字段** ——
  页面不许拿正则猜中文来上色（`本机档` 就是颜色），旧代理没返回这一项就**整行不写**（写一句「没读到」反而像坏了）。
  常驻判据 **`.tmp-encode.cjs`**（口径 21 条 + 反向对照 20 刀 ME1–ME20：档位名单收成一家 / 不抹大小写与空格 / 坏编码器静默退回 /
  标志位列数错 / 「问不出」当「这台没有」/ 默认档白问一趟 / 退回时档位不重验 / 只扫出一行也算清单 / 不问就说没有 /
  体检里数字写死 / 调用点退回硬编码 / 页面猜中文 / 复制文本缺一半 / 旧代理也硬拼一行 / doctor 不说用的是谁 /
  坏 Promise 留在缓存 / 留空也吵 / 默认档说「还没问过」/ QSV 发 `-crf` / 本机有也给人退回）。
  `ffmpeg -encoders` 的回包形状（6 位标志列、表头与分隔线）是本机实测抓下来的，不是照着文档猜的。

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
- **平台转发闸按「一家平台」算，不按 relay 前缀算**（`proxy.js` 的 `RELAY_MAX_INFLIGHT` / `RELAY_QUEUE_MAX` / `RELAY_RETRY_MAX` / `RELAY_WAIT_MAX_MS`，四档写在 `.env`、启动定一次、改了要重启）：闸的键是 `keyId || id`（一家同时做图片与视频 = 共用一把钥匙，也共用同一份配额）；排满**当场回本地代理的 429 并写明「没有扣费」**（静默让人排在永远排不到头的队列上比拒了更坏）；**退避重试只给 GET**（§2 那条「没有幂等键的 POST 一律不自动重试」在这里照样成立）；**名额必须恰好归还一次**（`release` 幂等 + `RELAY_SLOT_MAX_MS` 看门狗，漏还一次等于这一家永远关在闸外，那比没有闸更坏）；列表/详情短缓存命中与「挂同一条在途请求」都排在闸**之前**返回，命中不占名额；被限过的计数进 `/sys-status` 的「转发」（与「渲染」「健康」同一立场每次现算），页面只读那一份说法、上色读 `档`，**不许拿正则猜中文**。判据三层与变异在 `.tmp-relay.cjs`。
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
- 四颗「存回本机」（生成工作台 `#pullLocalBtn`、资产库 `#pullLocalBtn`、收藏 `#pullBtn`、素材库 `#btnLocal`）只走 `AssetLocal.pullMany` 这一条落盘链：与后台自动镜像同一个队列、同一份身份判据（`keyOf`）、同一道去重、同一份按类型另存；**页面里一次都不许出现 `AssetLocal.pull`**（循环、计数、回执措辞都在公共层那一份里）；页…
- 下拉浮层挂到容器外面用 `fixed` 定位，不留在 `<select>` 原来的位置上（`ui.js` 的 `Dropdowns` + `ui.css` 的 `.dd-list`）：原地展开时任何祖先的 `overflow` 都会把它裁掉（生成工作台 `.adv` 是 hidd…
- `.dd-list` 的坐标两分支都必须显式写 `'auto'`，不能靠 `= ''` 清空（`ui.js` 的 `place()`）：`= ''` 清掉的是内联样式，而 `ui.css:298` 的 `.dd-list` 自己带着 `top: 0`。
- 浮层挂在哪一个容器由 `ui.js` 的 `hostFor(select)` 现判：普通页面挂 `body`，`<dialog>` 里的挂那一个 dialog。
- 重画一块区域要回收孤立的浮层：`Dropdowns.build()` 开头自己调 `sweepPortals()`，别再往容器里塞一份。
- 资产库 / 素材库 / 收藏三页的展示档位名统一成 `list` / `compact`（**2026-10-15 起档位名只在 `ui.js` 的 `VIEW_MODES` 点一次名**，页面不传 `views:` 也不自己写容器类名；`Wb.viewToggle` 只画法与读回，判据 §J ㉒）。
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
- 下载一律走 `Wb.save(url, name)` → `Net.save(blob, name)`，不许 `window.location.href`：成片落在代理的 `.renders/` 里（**不按数量清理**，但用户手动删过、或设置页把渲染目录换走之后那一份就不在了），直跳过去撞上 404 时浏览器静默失败，用户只看到「点了没反应」。
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

## 8. 新增约定（2026-10 第四轮 · 合成 / 剪辑 / 轨道 / 语音栏 / 本地镜像）
- **服务端合成只有一条路，而且是「单遍 filter_complex」**（`proxy.js` 的 `renderJob`）：一次 ffmpeg 里做
  逐段裁剪归一（输入级 `-ss/-t`，不要在滤镜里 `trim`）+ `scale/pad/setsar/fps/setpts/format` + `concat`，
  音轨各自 `adelay` 后一次 `amix=normalize=0` + `atrim`，BGM 混进同一个 amix（**concat 之后不再接任何画面滤镜**）。
  **不许退回「每段编码成 norm_N.mp4 再 concat -c copy」**（N 段就是 N+1 次 ffmpeg 与 N 次完整重编码）。
  素材下载与时长/音轨探测并发（`mapLimit` + `DL_CONCURRENCY`，全项目只此一份限流实现）。
- **每段素材的 ffprobe 只问一次**（`proxy.js` 的 `probeFile`，2026-10-15 收成一条命令）：`-show_entries format=duration:stream=codec_type -of default=nw=1:nk=1`
  同时拿回「有几秒」与「有没有原声」，调用点读的是 `{duration, hasAudio}` 这一对。以前是两条命令两个子进程，
  同一个刚落地的文件问两遍 —— 三十段就是六十次子进程等待，而它排在下载之后、正在关键路径上。**不许再拆回两条**；
  解析**不看行序**（本机实测：流类型排在前面、时长在最后，纯数字行才是秒数，`N/A` 不许当数），
  `probe()` 在 ffprobe 非零退出 / 15 秒超时 / 起不动时一律 resolve `''`，所以探测坏掉是「当 0 秒 + 当没原声」而不是打断整单。
  常驻判据 `.tmp-ffprobe.cjs`（十条口径 + 反向对照 M1–M6；变异打在**内存里那段函数文本**上，磁盘一个字节不动，
  所以它能和别的探针同时跑）；调用点那两条分支（夹出点 / 混不混原声）要真发 `/render` 才量得到，归 `.tmp-voiceover.cjs`。
  **同一批里删掉的还有 `/render/play` 那条路由**（页头「播放成片」那颗早就整颗摘掉，剪辑态走时间线实时播、绝不为播放渲染，
  全站零调用）—— 成片出口只有 `/render/dl`，别为「在网页里直接播渲染好的那份」再开一条。
- **「字幕烧录」那一族 2026-10-15 整族删除**（用户点名的废弃代码清理）：`clips[].subs` 与 `spec.subFont` 两个路由字段、
  `SUB_FONTS` 字体白名单 / `SUB_MAX` / `assTime` / `assText` / `SUB_SPEAKER_COLORS` / `speakerStyleOf` / `buildAss` /
  `collectSubEvents` / `hasSubs` / `job.stage='烧字幕'` 那一段滤镜共 75 行 helper 一起摘掉，源头是**已删除的拍短剧页 `Drama.Subs`**
  —— 现在没有任何页面发 `subs`，代理里那一段永远走不到。**别再照着这些名字找渲染链**，也别为了「想要字幕」把它们加回来：
  台词要进画面走的是另一条路（先把字做进素材本身），不是代理里的 ASS 滤镜。
  常驻判据 `.tmp-voiceover.cjs` 现在钉的是合成侧六件事（① 跨段整句 / ② 只夹到片尾 / ③ 不越界不多放 / ④ `off` 输入级 seek /
  ⑤ 画面 `speed` 乘回 `room` / **⑥ 句自己的 `spd` 真的乘进 tempo**），反向对照 M1–M5 各钉一半；
  **⑥ 这一档是补上的**：客户端那四处（露出 / 写数据 / 进播放计划 / 进指纹）以前没有任何一支尺子问过成片里那一句到底念多快，
  把 `vrate` 退回 `speed` 时全站判据照样全绿 —— 「界面能拖、成片里听不出」就是这一类假开关。
- **剪辑态预览不渲染**（`director.html` 的 `TlPlay`）：按时间线调度现成素材，两个 `<video>` 甲板接力、
  配音按成片绝对时间起播。`renderMid` 每 3 秒重画，**正在播时要把 `.player-box` 摘下来再塞回去**
  （节点不动才不断播），且只在计划指纹 `TlPlay.fp` 变化时才 `seek`。
  成片秒 ↔ 源秒的折算只有 `TlPlay.srcT()` 一份（本镜档的插针按源秒走）。
- **轨道上的东西要「看得出来」**：声音块画真波形（`voicePeaks`：AudioContext 解码 → RMS+峰值包络 → 归一化，
  按地址缓存），音量只有右栏那一枚 `#tlVol` 滑块（`input` 只改读数、`change` 才落盘）；
  视频切片并发取帧（`SLICE_WORKERS`）+ 缩到 160px 宽 + `requestVideoFrameCallback` 等真帧。
- **语音那一栏的「合成设置」只有一份**（`assetlib.js` 的 `TtsAdv` + `AdvExtras`）：输出格式、音色、
  平台 `create.topBools`、`create.shapeFields` 的画法与读回，工作台语音栏与导演台「加一句配音」共用。
  **同一批顶层开关不许画两遍** —— 以前工作台画了 `#topBools` 与私有 `#boolBoxA` 两排，提交读的是私有那排，
  公共那排「勾了不算数」。
- 多行输入框用 `ui.css` 的 `.ui-ta`（`.ui-inp` 的多行兄弟），页面不许再各写一条 `textarea` 规则。
- 「跳到工作台另一页」用 `ui.js` 的 `GoPage`：页面在 iframe 里，换页要交外壳的 `parent.appShow`，
  自己 `location.href` 只换掉 iframe 内部（侧栏高亮不动、地址栏不变）。
- **时间轴只有两件东西：一个比例尺 + 一对「框 / 选区」**（`director.html` 的剪辑轨，2026-10 第四轮重做）：
  ① 比例尺 `pxPerSec`（`tlCurrentPps`）—— 内容层 `.tl-inner` 宽度 = `总时长 × pxPerSec`，
  `.tl-bar` 是横向滚动容器（纵向只留 padding：overflow 的裁剪边界是 padding box，
  插针/剪子上下各超出 6–8px 靠它才不被切）；行内元素**继续用百分比**，所以「换比例尺」只有一处落点。
  缩放 = 「−/＋」与 Ctrl/⌘+滚轮，**围绕视野中心那一秒**（`tlAnchorT`）；重画之间用 `tlScrollWant`
  保住滚动位置（整列每 3 秒重建一次，不还原就会被弹回最左边）。
  ② 一段 = **框 `[a,b]`**（切开时定下、拖把手不改；决定这一格的位置与宽度）+ **选区 `[in,out]`**
  （真正进成片的部分）。拖左右把手只改框内那两块灰的宽度 —— 格子不缩、别的格与它们的切片一个字节不动。
  **两条轨同一套**（本镜 = 候选的段；全片 = 各段按自己的框摊开，`filmFrames`）：改一处必须同时改另一处。
  切片取帧区间也只能取**框**（取选区的话，剪一刀整排就要重新解码，而用户看到的就是「每次剪切都在重新加载」）。
- **配音轨的那一句也是「框 + 选区」，与画面轨同一套几何；块上不许有删除键**（`director.html`，2026-10 第四轮补齐）：
  配音除了 `at/dur/off`（= **选区**，三处消费者 `clipVoices` → `/render` 的 `clips[].voices` → `renderJob` 与预览 `TlPlay` 只读这三个，合成口径一个字都不动）还有一对
  **`fa/fb`（= 框，与 `at` 同基准：相对锚定那一段的选区起点）**，只有一份读法 `voiceFrameOf(v)`（老数据没 `fa/fb` → 现算 `fa=at, fb=at+dur`，框等于选区、一块灰都不画）。
  排版一律按框摆 `left/width`（`voiceBlockHTML(v, box, sel, …)` / `paintVoice`），选区只决定框内**两块**灰（`.vo-off` / `.vo-off.r`）有多宽。三条最容易各漂一处的地方：
  ① 位置算式只有一份 `voiceBase(v)` + `voiceLeft(v)`，**首屏渲染与拖动中的就地重画必须同源**（以前一支用 `v.at`、另一支用 `s.in + v.at`，段被向左切过之后两者差一个 `s.in`，表现正是用户报的「不是覆盖左右，而是整体缩放」）；
  ② **画面剪一刀要连框一起平移**（`reanchorVoices`：`at` 挪了多少，`fa/fb` 就挪多少）—— 画面改的是「这一段从源里第几秒开始算」，不是「用户盖掉了音频的哪一截」；只挪选区等于把用户在音轨上的剪辑痕迹无声抹平；
  ③ 删除只在**点中之后那一排剪辑条**上（`#tlTools [data-cut="drop"]` + `Confirm.arm` 武装态）；块里那颗 × 已从标记 / CSS / 绑定三处一起摘掉（操作逻辑与画面轨一致，34px 高的行也放不下，而且「块上一个 ×、条上一个删掉」是两个出口）。
  常驻判据 `.tmp-dirdom.cjs`：⑦e/⑦h/⑦i（拖动中：`left`/`width` 与**两块灰**四路一起量，整体缩放必红）、⑦e2（松手整栏重画仍按框摆 —— 与 ⑦e 是两条路，各钉一边）、⑦f（拖块体 = 整框平移、框宽不变）、⑦j（块内没有删除节点，量节点不是量文案）、⑦k（画面再剪一刀后块的绝对位置与两块灰一格不动，且 `at` 与 `fa` **同量位移**）；
  反向对照 `.tmp-mutdirdom.cjs` M8（宽度退回 `dur` = 整体缩放）/ M9（拖动中不写左灰）/ M10（× 加回来）/ M11（`reanchorVoices` 不平移框）。
- **两轨的功能只有「同一排按钮 + 一个目标」这一种形状**（`director.html`，2026-10 按参考图重构这一轮）：剪辑条 `#tlTools` 全站一根，`[data-cut]` 六颗（试听 + 切开 / 向左 / 向右 / 删掉 / 融合；
  **「不剪了」那颗 2026-10-14 已删** —— 它把「一键抹掉这一条上所有剪切」放在最顺手的位置，而 `undo`（Ctrl+Z / 页头「撤销」）
  本来就是干这件事的且还能退回去；文案里指着它的地方一起换成那条真出路，见 `cutSegs` 的拒绝语与 `paintTrimRow`。
  **「空隙」那颗 2026-10-15 也整族删除**（用户点名），颗数只以标记为准 —— 判据 `.tmp-dirdom.cjs` ㉛a 当场数 DOM 键集合），
  目标由 `tlCutTarget()` 一处决定（**= 最后点的那一轨**，记在 `proj.tlLane`；点了配音块 = 配音，点了画面格 = 画面段），入口只有 `runCut(way)` 一个，音量入口只有 `setCutVol()` 一个。
  **目标只跟着用户的手换轨，不跟着播放头换轨**（用户点名的「不要优先删除语音」就是这个换轨时机）：
  所有「改东西」的入口读 `tlVoiceHit()`（目标不是配音时一律 null），不要读 `tlVoiceSel()`（那只问选中着谁）；
  `setPin` 的第 6 个参数 `lane` 与 `filmApplyAt` 的 `opts.lane` 是**唯一**把目标交出去的出口（`'pic'` / `'voice'` 两个方向都走它），
  播放跟随 / 每 3 秒整栏重画 / `syncPlayhead` 都不许传 —— 传了就是「点了一句配音 → 一次重画 → 滑块调的是画面段」，
  而这一条 vm.Script 与看代码都看不出来，只有 ⑰b3/⑰e2 那种「推一次针再问目标」的判据抓得住。
  **音量只有一枚滑块**（`#tlVol`，0–200%、步进 0.1 = 无级；`input` 只改读数与正在响的声音，`change` 才写数据 + `filmEdited()`）——
  块底那根 `.vgrip` 拖条与「音量 ±」两颗已从标记 / CSS / 绑定三处摘掉：留着就是用户点名的那两件事（鼠标扫过音轨变成「调整」光标、无级调退化成几档）。
  **锁轨是三处落地，缺一处就是假锁**：把手不画（`voiceBlockHTML` 的 `vLocked` / `renderShotTrack` 的 `picLocked`）+ 剪子与滑块压暗（`syncTlTools`）+ **函数入口硬拒**（`runCut` 与 `setCutVol` 都问 `tlLockWhy()`）。
  判据只有一份（`laneState/laneLocked/laneHidden/laneToggle` 写 `proj.lane = {pic,voice}` 两轨各记各的），按钮只是它的两个出口；锁一轨不许牵连另一轨。
  形状照参考图：`.tl-grid` 两列（左列 `.tl-side` 轨名 = 眼睛 + 锁两颗，**不随横向滚动**；右列 `.tl-bar` 是滚动容器），**插针只有一根**且挂在内容层 `#tlInner` 上（穿刻度尺 + 画面行 + 声音行，切页签不换宿主）。
  常驻判据 `.tmp-dirdom.cjs`：⑰a/⑰a2（芯片 + 只有一根工具条 + 旧出口零残留）、⑰b/⑰b2/⑰c/⑰c2（选中 → 值域 → 数据 / 读数 / 块上标色 / 成片指纹四处一起变）、⑰d/⑰e（一根针）、
  ⑰f/⑰g/⑰g2/⑰g3（锁的三处落地 + 不牵连画面 + 解锁还原）、⑰h/⑰h2/⑰i（收一轨问的是**算出来的 display**，不是 class 加没加）、
  ⑰b3/⑰e2（推一次针之后目标是交回画面轨 / 仍留在配音轨，两个方向各一条）；
  反向对照 `.tmp-mutdirdom.cjs` M17（拖条加回来）/ M18（锁着仍画把手）/ M19（`runCut` 那道锁摘掉）/ M20（`setCutVol` 那道锁摘掉）/ M21（针退回画在某一行里）/ M22（只加 class、样式没跟上）/
  M28（目标退回「只看选中着谁」）/ M29+M30（`setPin` 那个参数**两个方向**：照抢 / 永不交回）/ M31+M32（`filmApplyAt` 同样两个方向）。
- **两条轨是同一份账的四件事，各自都只有一处落点**（`director.html`，2026-10-14 用户点名的剪辑八条）：
  **① 本镜有配音 → 全片必须有配音**：同一句配音在两条轨上「画不画得出来」必须是同一个判据。
  `voiceFilmSpan()` 找不到它锚着的那一格时**只能返回 null**（以前这里没闸：拿 0 当那一格的起点照样算出 `{from:0,to:dur}`，
  于是「本镜」那一排把挂在**没选用的候选**上的一句当成「别的镜压过来的那一截」画了出来，而全片那一排按 `candId` 精确匹配什么也不画 ——
  用户点名的第 1 条正是这两行的差）；画不出来交回调用方，由 `voiceFilmGap()` 说清为什么（`unsel/nocand/nogseg/shotout/noaudio/noshot`，
  全站只这一份，两条轨共用），能当场替用户补的只有 `VOICE_GAP_FIX` 那三个，其余一律把原因写出来而不是闷掉。
  **② 焦点只在用户手势或真播放时改**：整栏重画会重建播放器，而 `TlPlay.seek()` 开头**无条件** emit 一次
  （新建那一只递来的是 0 秒），于是「我刚切一刀 / 只是改了个顺序，剪刀又指回第一段、本镜变成了另一条」。
  `syncPlayhead` 本镜档与 `filmApplyAt` 全片档同一立场：`!TlPlay.playing` 时只按数据里的 `proj.cutAt` 就地重画针（`paintPin`），
  **不走 `setPin`**（那一条会把目标轨与 `curCand` 一起交出去）；这一条 vm.Script 与看代码都看不出来，只有 ㉘a/㉕b 那种
  「推一次针再问焦点」的判据抓得住。拖轨道**换顺序**与在轨道上**点一格**的分界只有 `trackDragged()`（350ms 窗口）一处：
  浏览器在 drag 松手后照样补一次 click，那颗针必须被当成拖的一部分丢掉（㉕c），而判据要连 `trackDragT` 的年龄一起读 ——
  探针自己等过 350ms 就等于合法过期，这一档会假绿（时序窗口本身是仪表的一部分）。
  **③ 空白处也放针 + 加一条轨道 + 每一行都能单独删**：点击区是整条 `.tl-bar`（见上面那一节），落点不要求在格子上；
  行数只有 `addLaneRow()` / `dropLaneRow()` 两个入口（**不是**一个「+/−」共用函数 —— 删行要按行号收，加行不看行号，两者的拒绝清单不一样），
  五种情况各给一句拒绝的原因（这一轨是收起的 / 到 `TRACK_LANES_MAX` 上限 / 只剩一行 / 第 1 行是锚行 / 那一行此刻不存在），
  `syncLaneSide` 的 `plus.disabled = full || hid` 与那些 title 只解释「为什么按不动」，不另判一份。
  **删一行不许吞内容**：`shiftLaneRows` 把被删那行的块并到上面一行、再往下的行整体补一格，且**段/句的 `ln` 与每行基数音量 `proj.lane[k].vols[ln]` 一起挪**
  （只挪块的话，删掉第 2 行后「第 3 行的 60%」还挂在 3 上，压到补上来的那一行）；画面轨要遍历**所有候选**，不只当前那条 —— 否则行会自己长回来。
  **④ 右栏只摆「此刻指着那一轨」的功能**：判据只有 `tlPanel()` 一份，它与 `tlCutTarget()` 只差两条硬条件 ——
  什么都没点过时照旧开配音那一侧，且**这条候选一句配音都没有时永远开配音那一侧**（否则第一句配音永远加不上）；
  点画面轨时「插入语音 / 音色 / 合成设置」整块收掉，只留 speed 那一族。新加一排控件先问它属于哪一侧，别在页面里再判一次目标。
  常驻判据 `.tmp-dirdom.cjs` ㉔（孤句两条轨同现）/ ㉕（拖顺序不换本镜，含 ㉕c 那个 click）/ ㉖（空白放针 + 加轨道到顶与 −）/
  ㉗（右栏按目标收放，含 ㉗c「一条配音都没有」那一侧）/ ㉘（段数芯片与读数同一份口径 + 播放跟随）/ ㉙（那一行读数只报三个数 + 「不剪了」零残留）；
  反向对照 `.tmp-mutdirdom.cjs` M46（`voiceFilmSpan` 编位置）/ M47（quiet 不拦 playing）/ M48（`trackDragged` 摘掉）/
  M49（只认格子，空白不放针）/ M50–M53（行数不落地 / − 挂每一行 / − 不看空不空 / ＋ 永不压暗）/
  M54–M56（右栏那一块永不收，三个方向各一刀）/ M57（芯片分母退回 `segs.length`）/ M58（读数说两遍）/ M59（「不剪了」加回来）/ M60（本镜档播放跟随不看 playing）。
- **配音的尾巴不必留在起点那一格内：只夹起点，框与选区都可以跨到后面那一格 / 下一镜**（`director.html` + `proxy.js`，2026-10-14 用户点名的「修复音频不能跨越不同视频片段」）：
  **① 三处夹取只夹「选区起点落在这一格里」，不许再带上句子的长度** —— 本镜那一排 `put` 的 `maxFa = Math.max(0, segLen(sg) - selOff)`、
  全片那一排 `filmMove` 的 `Math.max(0, keep - selOff)`、右把手的上界 `lim = Math.max(fr.fb, at0 + content)`
  （`content` 按音频尽头 `srcDur - off` 算，不是按格子）。旧的那三处都写成 `… - dur`（整条选区都得留在这一格内），
  于是**一句比格子长的台词拖到段首就顶住，鼠标在走而数字不动**；而合成侧同样只夹到片尾
  （`proxy.js` 的 `room = Math.max(0.1, Math.min(v.dur, (totalFilm - at) * speed))`，`total` 用 `totalFilm`）——
  界面放开、合成还截断，与界面截断、合成放开，是同一个缺陷的两半。
  **② 拖动中途既不量化、也不重建整栏**：`roundVoice` 只在松手那一次做（三路手势的 `up` 各一次），
  中途只 `paintVoice` 就地重画这一块（含块上那行小字 `.vt` 的秒数 —— 位置在走而秒数不动就等于没说清「改了长度」）；
  手里有拖动时 `renderMid()` 必须让路（判据只有 `dragBusy()` 一份），撞在拖动中途重建会把手指底下的节点换掉，
  表现是「拖到一半画面不动，松手才跳到位」，而轮询每 3 秒就会撞一次。
  **③ 越界的那一截两条轨都要画得出，只读的那一截必须给出路**：全片那一排按 `voiceFilmSpan` 摆，块可以画过自己那一格的右沿；
  别的镜压进来的那一截画成 `.tl-v.spill`，**一颗把手都不给**（那一排的时间基是它自己那一镜的源秒，拖了会拿错段长），
  但点它必须 `focusVoiceShot` 跳回它自己那一镜 —— 「画得出却点不动」与「点得动却摆错位置」在本项目算同一个缺陷的两半（承诺要么实现、要么改文案）。
  **④ 递进预览与合成的那一份也必须是整句**：`clipVoices()` 是唯一的消费者口径（剪辑态播放计划 `tlPlayPlan` → `/render` 的 `clips[].voices` → 指纹三处都读它），
  它只在「选区起点已经出了这一格」（孤儿）时丢句，**不许按这一格剩余长度截**；界面放开而这里还夹就等于「看得见、听着还是半句」。
  常驻判据 `.tmp-dirdom.cjs` ㉚a/㉚b/㉚b2/㉚c/㉚d/㉚e/㉚f/㉚f2/㉚g/㉚h/㉚i（㉚g 是拖动中途**自己踢一次** `renderMid()` 再问节点身份，不等 3 秒定时器 —— 靠时序的判据会偶发假绿；㉚i 量的是播放计划那一份的 `at/dur`，不是样式），
  合成侧 `.tmp-voiceover.cjs`（真发一次 `/render`、用 ffprobe 量产物里那一句还剩几秒）；
  反向对照 `.tmp-mutdirdom.cjs` M65（`maxFa` 退回 `- dur`）/ M66（`filmMove` 同一道旧夹取）/ M67（右把手上界退回框右沿）/
  M68（拖动中不更新那行小字）/ M69（`renderMid` 不让路）/ M70+M71（两路手势中途量化）/ M72（spill 仍画把手）/ M73（点那一截不跳回去）/ M74（`clipVoices` 按这一格剩余长度截断）。
  **探针自己要守的两条**：每组手势前用 `seedW()` 重种底座**并把页签切回那一排**（上一族停在「全片」时，本镜那一排读到 0 个格子、把手按 0.02 秒/像素走 —— 看着像页面坏了，是尺子开在另一排上）；
  越界基准只能按**块自己那一格的左沿**去认格子（`ownCellR`），拿最后一格当界永远量不出越界 —— 它的右沿就是 100%。
- **播放器那一排控件是一份标记、四处同一件事**（`director.html` 的 `pbBarHTML()`，用户点名的第 9 条）：剪辑态甲板与候选播放器共用同一段标记（左下 = 播放 / 暂停 + 时长读数，右下 = 静音 + 全屏，`.sp` 那根撑开的把两边分开，全屏排在最后 = 视觉最右下角），
  三颗圆按钮同一档尺寸、`display:flex` + 双向居中 + `padding:0` —— **svg 掉到圆心下方**的病根就是原来的 inline 基线排法；hover 不再 `scale()`（整排在抖）。
  静音那颗有四件事，只做到两件就是假开关：**图标换口、title 换句、`dir_muted` 落盘、真的静音**（剪辑态走 `TlPlay.setMuted`，候选播放器走 `pl.muted`）。
  常驻判据 `.tmp-dirdom.cjs` ㉑a/㉑b/㉑c/㉑d（㉑b 问 `getComputedStyle`，㉑d 点两下量四处一起换口再退回来）；
  反向对照 M23（`.sp` 换名字 → 靠右那一头塌）/ M24（退回 inline 基线）/ M25（图标写死）/ M26（title 写死）/ M27（只改外观与旗标、不 `setMuted`）。
  **两条比法上的坑**：svg 要按**同一把尺子序列化**再比（`icon()` 出的串没有 `xmlns`，节点 `outerHTML` 会补上，字符串永远对不上）；`dir_muted` 要按**布尔**比（从没写过的键读回来是 `null`，按字符串比「退回来」就把判据钉死在夹具上）。
  **右下那颗全屏有四个落点，少一个就是「看着能点、其实什么都不做」**（2026-10-15 补齐：`pbBarHTML()` 把它画在两个播放器上，而接线函数 `bindPbFull` 一度**全站零调用**）：
  ① 候选播放器（`renderMid` 那一支）② 剪辑态那两个甲板（`bindTlPlay` 那一支，同一段标记、**另一条接线**）③ `selectCandidate()` 里「播放区整块重画」那条分支（换到没有画面的那条再换回来 —— 新节点上是一颗全新的按钮，上一处的接线跟不过去）④ 已经在全屏里再点同一颗必须走 `exitFullscreen`，不是又进一次。
  **宿主只能是整块 `.player-box`**（只让 `<video>` 进去 = 全屏里根本没有退出那颗，那一排控件留在屏幕外）。
  常驻判据 `.tmp-dirdom.cjs` ㉑e/㉑f/㉑g/㉑h（jsdom 没有 Fullscreen API：`requestFullscreen` / `exitFullscreen` 换成记录调用的桩，`document.fullscreenElement` 由探针自己摆 —— 浏览器里那一只是系统写的）；
  反向对照 `.tmp-mutdirdom.cjs` M136（甲板那条不接）/ M137（候选那支不接）/ M138（重画后不重接）/ M139（宿主退回 `<video>`）。
  **两条夹具纪律**（这一组第一次跑就撞出来的「假红」）：模式要**显式摆**，不能盲点 `#trimBtn` —— 前面已有判据把剪辑态开着了，「点一下切换」会把要测的那一条切成另一条，两次点击各测一条路而标签对调，读数是巧对的（等于没测）；
  换候选要挑**不是正在看**的那一条，`selectCandidate` 对 `at === proj.curCand` 直接 return，拿当前那条去点等于没调用 —— 只有一条候选有画面时就把账上的 `proj.curCand` 挪开再选回来，走的仍是同一条重画分支。
- **「存回本机」的范围不许跟「不显示云端任务」走**：藏起来是「列表里先别显示它」，不是「这份东西我不需要」，
  而三个开关全开时被藏掉的恰恰就是本机还没有字节的那批 —— 正是那颗按钮唯一的目标。
  跟着藏走会当场筛出 0 条，按钮成了「点了只会说都已经有了」的假控件。
  四页各自的范围函数（工作台 / 资产库的 `pullScope`、素材库的 `localPlan`）必须读**没带藏**的那一份
  （工作台 `mergedItems()`、资产库 `applyFilters({includeHidden:true})`、收藏与素材库本来就不带藏）。
  注意 `hideAsCloud` 的**调用点**判据对这类错误是瞎的（藏是在列表函数里统一做的，调用点一处都不多），
  所以专门有 §J ⑨-b 一把尺子（取函数体、大括号配对）＋ 两条变异＋一条反向对照钉住它。
- **余额 / 额度不够这类错误要给出口**：判据只有 `Api.isBalanceErr`（与 `ERROR_HINT` 共用一条正则），
  十分钟内同一家再点先拦住（`Api.balOut`）并给「仍然再试一次」；
  **可点的入口只能画在页面自己的 DOM 里** —— `setStatus` 过 `sanitizeHTML`，`button` 会被抹成纯文本。

## 9. 新增约定（2026-10 第五轮 · 轨道八条：落点分档 / 跨行 / 缩略图卡 / 行级四件套；「空隙」那一条已删）

- **右栏开哪一侧跟着「用户点在哪一轨」换档，三档只有一份判据**（`director.html` 的 `tlPanel()`，用户点名的第 ①②③④ 条）：
  点一句配音 = 声音那一侧（倍速那一排见下面「配音那一侧的倍速」那条），点一格画面 = **画面那一侧（倍速 / 入出点），哪怕这一条候选一句配音都没有**，
  点在没有块的轨道空白上 = 声音那一侧（那就是「加一句配音」的入口）。什么也没点过的初始态照旧开配音那一侧。
  **旧口径把「这条候选有没有配音」排在落点之前** —— 于是第 ② 条在最常见的那一镜上必然落空（点了画面格却只见「生成配音」），
  而它本来要保护的「第一句加不上」如今由落点给；两条性质别再用一道闸混判（`cutCand()`/`shotVoices()` 那一档已从 `tlPanel` 摘掉）。
  剪辑针与声音行同样与「有没有块」无关：`filmVoiceHTML` 无条件画行、`.tl-pin` 挂在内容层 `#tlInner` 上（不属于任何一行）。
  常驻判据 `.tmp-dirdom.cjs` ㉗a/㉗b/**㉗c（点画面格 → 倍速露出）/㉗c2（同一份数据点空白 → 加一句配音露出）/㉗c3（谁都没点过 → 配音那一侧）** + ㉛b/㉛c/㉛d/㉛d2/㉛e；
  反向对照 `.tmp-mutdirdom.cjs` M54/M55（两块各自永不收）/ **M56（初始态与点空白也开画面那一侧 = 第一句配音没有入口）/ M91（把「有没有配音」那道闸排回落点之前 = 第 ② 条落空）**。
- **「空隙」那一族整条已删（2026-10-15 用户点名），不要再照着旧名字找锚点**：`#tlTools` 上那颗 `data-cut="gap"`、
  `tlGapClip()` / `tlGapHit()` / `applyGap()` / `proj.gapAt` / `GAP_MIN`/`GAP_MAX` / `.tl-seg.gap` 标记与判据 ㉛h0–㉛o、
  反向对照原 M77–M82 六刀一并摘掉（`.tmp-mutdirdom.cjs` 里那条注释是删除记录的唯一落点）。
  **段与段之间要留白**走的是另一条早已存在的路：「删掉」那一格变成**黑场**（`clip.gray` → 代理 `src:'black'` 走 lavfi，
  时长还是那几秒），配音照样能压在黑场上（判据 ㉚j / M76 —— 撤掉「空隙」不等于撤掉「黑屏配旁白」这条出路）。
  新加「剪完之后画面少了 X 秒」这类功能前先问一句：黑场那张牌是不是已经回答了同一个问题。
- **画面轨那条「关键帧 + 速度曲线」整族已删（2026-10-15 用户点名），段的速度只剩滑块一个写点**：
  `setCutSpd`（画面段 0.25–4）与 `setVoiceSpd`（配音句）两枚滑块留下，格子上那一排关键帧磁贴与「缓入 / 匀速 / 缓出」三颗按钮
  连同 handler 一起摘掉 —— **「一段一个倍速」与「一条曲线」是两件事**，别把曲线当回「精细控制」再长出一份。
  ⚠ 源码里 `sh.keyframes` 这个名字还在，但它是**时间切片的参考图**（画面生成那一路，见 §2「导演台画面生成」那条），
  与已删的那排轨道磁贴不是一回事 —— 照着名字去找轨道功能会扑空。
- **压在「被剪掉的头 / 尾」那两块灰上的配音要跟着拉长，且两条轨 + 预览 + 合成四处同一把尺子**（`director.html`，2026-10-15 用户拿截图点名的第 18 条）：
  一份读法 `graySpans()` 同时报**整格黑场**与**格子里那两块 `.mask`**（入出点剪掉的头尾），第三个标记区分「成片里的真洞」与「只是被剪掉」：
  ① 块上那一段画成 `.vo-skip`（像跳过的视频条那样变灰 = 那几秒听不到）；② 块**往后拉长**到灰场结束那一点，而拉长的长度只能与
  「自己那一排没有灰场时」比（拿另一排的宽度当基线量到的是假红）；③ 拉长**不许**改 `at/dur/off` 那三个合成字段，只改排版与那行读数
  （`filmSec`，不是 `end − 起点` —— 后者等于「轨道跨多长」，与听着的一句差一截）；④ 预览与合成那一份尺子只认整格黑场
  （`filmLayGray` ≠ `filmGray`，`grayWall` 还得看 `s.off`），否则一句被劈成两条、听着是半句。
  常驻判据 ㉞a–㉞g（含 ㉞g = 拖动中途就地重画那一半），反向对照 M106–M111 + M108。
- **配音那一侧的倍速：露出 / 写数据 / 进播放计划 / 进指纹四处都要认**（第 ③ 条补齐的一半，`v.spd`）：
  指着画面格时那一排整块收掉（与 ㉛b/㉛c 互为一对），写着「乘那一格画面 ×A → 成片 ×A+B」那句必须现算（不是拼一个看起来差不多的数）；
  只改「念多快」，起点与时长一个字节不动；调回 ×1 时**键整个摘掉**、指纹逐字复原（默认值不许占位，否则旧工程一改就全变「陈旧」）。
  判据 ㉜a–㉜i，反向对照 M94–M104。
- **拖动示意那张卡两条轨、两路手势都得有**（第 ⑧ 条）：`dragGhostShow / dragGhostMove / dragGhostHide` 三个动作在同一趟手势里配齐（起手一次、每次位移跟一次、松手一定收），
  画面格放它**已经解出来的切片**（`.frs > .fr` 的 background-image），配音块放**它自己那份波形**（`.wv-box > svg` 克隆节点）——
  **拖动中途不重新解码、不重算包络**，取不到就降级成占位（宁可少一张图，也不让一次拖动等一趟解码）；
  那行字取块 / 格子上本身的小字（`.lab` / `.vt`），不许另拼一句。卡片挂 `document.body` + `fixed`（轨道是横向滚动容器，画在里面会被 overflow 裁掉）。
- **跨行与「每一行独立删」是同一份行号**（第 ⑤⑥ 条）：画面段写 `s.ln`（唯一出口 `setCellLane`）、配音句写 `v.ln`（唯一出口 `bindVoiceLane` 松手那一次），
  两个页签读同一个数 —— 「在本镜挪到第 3 行、切到全片还在第 3 行」不是同步逻辑是没有第二份账；
  每一行（第 2 行往上）的标签上各有一颗「×」，落地只有 `dropLaneRow` → `shiftLaneRows`（这一行的块并到上面一行、再往下的补格，**段 / 句的 `ln` 与每行基数音量 `proj.lane[k].vols[ln]` 一起挪**，画面轨要遍历**所有候选**否则行自己长回来）。
  常驻判据 ㉖c/㉖d/㉛f/㉛f2/㉛f3/㉛g0/㉛g/㉛g2/㉛g3/㉛g4/㉛e2，反向对照 M50–M53 + M83–M88 + M92/M93。
  **绕回原行的那一路不许打 ✓**（一个数都没改还说「挪到了」就是假回执，㉛g4 钉这一条）。
- **加出来的每一行都有四件套：收起 / 锁定 / 添加 / 基数音量，而「行级」与「轨级」是两份判据不是两套按钮**（`director.html`，2026-10-15 用户点名的第 19 条）：
  读侧只有 `rowFlag` / `rowHidden` / `rowLocked`（`ln <= 0` 回退到轨级，**整条轨永远压得住单行，反过来不成立**），
  写侧只有 `rowFlagToggle`（ln 0 直接拒并指着轨名那两颗）与 `setLaneVol`（基数按行记在 `proj.lane[k].vols[ln]`，**只有 ≠1 才占键**）；
  `laneRowCtlHTML` 画四件套、`syncLaneSide` 画完之后**逐行现量现写** `disabled` / `title` / 滑块值（拼模板那一刻量到的是上一次渲染的行数）。
  四件不能各漂一处的老纪律在这里照样成立：
  **① 锁三处落地按「这一行」**（`voiceBlockHTML` 的 `vLocked = rowLocked('voice', vLn)` 只管自己那一行 + 滑块 `disabled` + 函数入口硬拒），
  **② 收起是「不画」不是「画出来再禁用」**，判据必须问 `getComputedStyle` 的 `display` 而不是 class ——
  这一条当场抓出一个真缺陷：`.tl-lane.hid > *`（0,2,0）被几百行之后那句 `.tl-lane .tl-v{display:flex}`（同 0,2,0）盖掉，
  行级收起只压扁了行高、块还全画着；整条轨那一档用的是 `.tl-grid.hid-voice .tl-lane > *`（0,3,0）所以从来没露馅。
  **那条前缀是承重的，不是排版**（改 CSS 时删掉 `.tl-grid` 只是让选择器短一点，功能当场塌一半）；
  **③ 眼睛与锁永不 `disabled`** —— 它们正是「让这一行重新能动、能看见」的那颗出口；
  **④ 插一行 / 删一行时块上的 `ln` 与按行的三张表（`vols` / `hides` / `locks`）走同一个映射**（`mapLaneBlockRows` + `moveRowFlags` 过 `ROW_FLAG_COLS`，
  `to > 0` 才占键 —— 并进第 0 行的那份没有地方记就随它消失，别留一份「看不见的加压」；塌空的表整个 `delete`）。
  另两条落地：`bindPinZone` 的点击区排除名单必须同时排掉**滑块与右边那枚百分数读数**（`.tl-hvol-sl, .tl-hvol`）——
  只排滑块会留下一个「点上去只该看数、却把剪针搬走了」的读数；`labOf('tlVolLab', …)` 与行标签 `prevLab` 一起把「这一段 / 这一句 / 这一行」写进标签，
  段与句的音量是**乘在行基数之上**（`picVolOf` / `voiceVolOf` 各一处，光写不说等于承诺一件算不出来事）。
  常驻判据 ㊱a–㊱z（四件套齐全 / 锚行只有轨级两颗 / 行级收起与锁定各量 `display` 与把手节点 / 三张表插删两趟 / 拖动中途只改读数 / 右栏四处同一个数 / 收尾指纹逐字复原），
  反向对照 M112–M127 + M125b（CSS 前缀 / `vLocked` 退回轨级 / 入口闸退回轨级 / 滑块与眼睛各自假 disabled / 插删各砍一半映射 / `to > 0` 摘掉 /
  input 就写数据 / change 不传行号 / 点击区只排滑块 / 标签退回「音量」/ 乘算退回覆盖 / 锚行也画 × / 「去哪儿解锁」两个方向各一刀
  —— 那一句返回值本来就分两岔（整条轨锁着 / 只锁了这一行），一个变异只能打中一岔，所以成对写）。
  **「这一行的基数音量为什么调不了」也只许有一份实现 = `laneVolWhy(k, ln)`**（2026-10-16 补，同一族的**措辞**那一半）：
  函数入口那道硬拒（`setLaneVol` 的横幅）与右栏那枚滑块的 `title` 以前**各拼一遍** `rowNm + '已锁定：这一行的基数音量不调。'`，
  于是整条轨锁着时界面说的是「配音轨第 1 行已锁定」，而行标签上那颗锁明明亮着、点它解不开 —— 同一句里既报错行号、又指着对的锁，两句半真半假。
  它和 `rowLockWhy`（拖 / 剪那一句）是**两个口径**：后者只回答「为什么动不了」，音量这一句要带「基数音量不调」与自己的出路，
  所以不是把两处并成一处，而是把重复的措辞收成一份、分岔照 `laneLocked` 走（整条 → 「整条配音轨已锁定（锁的是这条轨，不是单独这一行）」）。
  常驻判据 ㊱d2b（整条轨锁着时横幅与 `#laneVoiceBox.title` **两处**都说「整条配音轨」且**都不说**「第 N 行」，那一盒同时压暗），
  反向对照 M153（分岔永不会走到 → 两处一起报成第 N 行）/ M154（入口闸自己再拼一份）/ M155（右栏 title 自己再拼一份）——
  后两刀各打一个消费者：只并一处，另一处迟早漂回去。
- **右栏那张卡只有五个名词，口径表只写在 `paintTlAdjust` 的注释里一处**（2026-10-16 用户点名的「对画面和配音的声音配置里关于『段』『轨』『句』的描述前后统一」）：
  `段` = 画面轨上被切出来的一段（`c.segs` 的一条）→「这一段」；`句` = 配音轨上的一句配音（`proj.voices` 的一条）→「这一句」；
  `行` = 一条轨里的一条横带（`ln`，只决定画在哪，不决定时间）→「第 N 行」；`轨` = 画面轨 / 配音轨整一条（锁、收起、基数音量都有**轨级**与**行级**两档）；
  `镜` = 一条候选镜头（`candidates` 的一条）→「这一镜」，**不用「这一条」**。
  **`格` 只许指轨道上那个看得见的方块**（黑场与 ㉞ 那一族的性质靠它，不能一并抹掉），不再当「段」的别名；
  `颗 / 枚` 的分工是按钮用颗、滑块用枚。
  三条最容易各漂一处的地方：**① 标签与 title 跟着目标现写**（`labOf(id, t)` 是唯一落点，它顺手把同一句写进相邻滑块的 `aria-label` ——
  只改看得见的字，读屏里还停在静态「音量」，M135 钉这一条）；
  **② 指路句必须指着此刻看得见的那一排**（`spdWhy()` 在指着配音时说「用『这一句倍速』那一排」；
  写成「上面那一排『倍速』」是错的 —— 画面那一排此刻整块 `hidden`，且它的名字已经不叫「倍速」，见 ㊲k）；
  **③ 同一件事在两处列数不许两个名字**（「落在哪 → 这一镜已有 N 句」与「这一镜上的配音 → N 句」都叫「这一镜」，
  以前一格写「这一镜」一格写「这一条」，同一张卡里两个名字看着像两个东西）。
  常驻判据 `.tmp-dirdom.cjs` **㉝a–㉝d + ㉝z**（真 DOM 里两种落点各读一次：逐节点点名标签 / `aria-label` / 框上 `title` / 那行读数 / `^第 \d+ 行$` / `^这一镜…$`，
  再把整张卡**看得见的**文本 + `title` + `aria-label` 拼起来扫一遍旧别名），反向对照 `.tmp-mutdirdom.cjs` **M150–M152**（标签退回「这一格音量」/ 列表退回「这一条上的配音」/ 行读数退回「第 N 格」）。
  ⚠ 扫描只认 `closest('[hidden]')`、**不认 `getComputedStyle`**：`paintTlGroups` 只翻 `hidden` 属性（节点不销毁），
  而 jsdom 的 UA 样式表对 `[hidden] → display:none` 的覆盖并不可靠 —— 用 display 当尺子会把收着的那一排也算进「看得见」，那一档就永远红。
  ⚠ 粗比（「整张卡不许出现『句』字」）也不成立：换行那两颗按钮的 `title` 天生同时管段与句（「把芯片指着的这一段 / 这一句挪到上一行」），
  所以 ① 这一半只能**逐节点点名**，只有 ③ 那一半（旧别名）可以整片扫。
- **变异脚本的锚点有一类必须写两行**：`director.html` 是 CRLF，而同一句 `dragGhostHide();` 在三路手势里各出现一次 ——
  单行锚点 `rep()` 会一次改坏三处、把不相干的档位一起拖红。带上**下一行**当身份证，换行写成 `\r\n`（见 M93）。
  跑任何「会临时改写源码」的变异之前先 `node .tmp-anchordry.cjs .tmp-mutdirdom.cjs` 只读干跑一遍命中（现役 143 刀；最早一轮 94 刀时一次 dry 抓出 5 处失配）。

↑ **§8 / §9 与 §3 / §3.1 / §6 / §7 的分家规则不同**：按开头那套写法，剪辑与轨道（§8 / §9）的正文
**一直直接写在本文件对应一节里**，不另搬分册；上面各条点名的判据与探针口径就是全文，
这里不再指向 `docs/`（那两册只承载 §3 / §3.1 / §6 / §7 的全文）。
