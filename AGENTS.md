# AGENTS.md —— 项目结构、硬约束与开发规范

> 本文件是当前项目的**唯一约定清单**（2026-10-18 版）。改任何一处之前先读对应章节；
> 与代码冲突时以代码为准，并把本文件改到与代码一致，不要留“以前是那样”的说明。
> 产品使用说明与功能索引见 `README.md`；本文件只写“必须遵守什么、唯一实现在哪、怎么验证”。

## 1. 项目定位

本地优先的 AI 创作工作台：

- 纯前端 Vue 3 SPA + 一个本地 Node 代理（`proxy.js` → `server/app.js`，默认 `http://localhost:5175`）。
- 所有生成平台都经本地代理转发；页面不接触平台密钥，不直连任何外部域名。
- 数据默认留在本机：`.data/`（结构化数据）、`.assets/`（本机资产）、`.renders/`（成片）、`prompts/`（提示词归档）、`.skills/`（用户 Skill）。
- 八个页面：导演台、素材库、生成工作台（视频/图像/语音）、画布、收藏、资产库、用量、设置（设置不进侧栏）。路由表只有 `web/core/routes.js` 一份。

## 2. 当前目录结构

```text
.
├─ proxy.js                     薄入口：只 require server/app.js
├─ server/
│  ├─ app.js                    组合根：配置、依赖装配、路由分发、上传/出站工具（约 1.3k 行）
│  ├─ registry-config.js        供应商注册表 REGISTRY + 本机覆盖（型号清单偏好）
│  ├─ relay-gate.js             按平台的在途转发闸与退避重试
│  ├─ local-assets-store.js     本机资产：镜像/落盘/索引口径（HTTP 适配在 routes/local-assets.js）
│  ├─ index-store.js            本机资产索引 journal（快照 + 追加日志 + `update(fn)` 串行队列）
│  ├─ render-jobs.js            渲染队列（ffmpeg 任务、并发与保留）
│  ├─ render-jobs-store.js      渲染任务账（跨重启可查的历史）
│  ├─ fs-atomic.js              原子写 / .bak / 余量与重试口径
│  ├─ data-store.js             /data 读写、原子写、.bak 备份
│  ├─ prompts-store.js          /prompts 提示词归档
│  ├─ cloud-store.js            /cloud 云同步
│  ├─ skills-store.js           .skills 清单 / 安装 / 启停
│  ├─ asr-store.js              .data/asr.json（密钥只留盘上，读接口只回 hasKey）
│  ├─ search-store.js           .data/search.json（同上）
│  ├─ static.js                 静态文件：ETag / gzip / HTML 的 CSP 头
│  ├─ security.js               同源、Cookie、出站 URL 护栏
│  ├─ outbound.js               出站 HTTP（超时 / 重试 / 代理）
│  ├─ health.js                 代理故障账（只报不自杀，也收客户端上报）
│  ├─ lock.js                   单实例锁
│  ├─ zip.js                    FCPXML 媒体包 zip
│  ├─ providers/validate.js     registry 供应商声明校验
│  └─ routes/                   system（含 /client-error）/ static / capabilities / registry /
│                               relay / outbound / local-assets / media / save / usage /
│                               render / skills / fcpxml / pick-dir / asr / search
├─ shell.html                   SPA 外壳（CSP、启动脚本、公共模块）
├─ web/
│  ├─ app.js                    Vue 外壳：hash 路由 + KeepAlive 页面池 + 生命周期
│  ├─ shell-boot.js             主题与“在外壳里”旗标（外部脚本，避免内联脚本）
│  ├─ boot-assistant.js         空闲时加载 AI 助手（`ai_chat_off` 命中就整个不下载）
│  ├─ core/                     routes / bridges / page-context / hooks / activity / actions / report
│  ├─ pages/                    favorites / usage / assets / settings / chars / studio /
│  │                            canvas（导演台在 web/director/index.js）
│  ├─ director/                 导演台：index + template.html + engine.js + 纯算法模块
│  ├─ render/                   预编译生成的 render 函数（不要手改）
│  ├─ ui/                       ui.js / forms（弹窗与表单族）/ net / store / kv / toast / datasync /
│  │                            skills / workbench / sidebar / index / local-badge / badge-state
│  ├─ domain/                   api / assetlib / gen-forms / asset-transfer / local / capabilities /
│  │                            text-ai / gen-rules / fav / prompt-log / asset-picker / ai-find / chars /
│  │                            ident / identity / semantic / asr / search / zip-read /
│  │                            chat/text-util / text-ai/contracts
│  │  └─ canvas/                自由画布：registry / doc / ops / spatial / history / gen / view
│  ├─ features/chat.js          AI 助手外壳：悬浮球 / 抽屉 / 会话 / 发送循环
│  ├─ features/chat-tools.js    助手工具循环与动作目录（TOOLS / ACTS / 两张形状表）
│  ├─ package.json             {"type":"module"}（让 node 测试按 ESM 读 web/ 模块）
│  └─ styles/                   tokens.css / ui.css / spa-*.css
├─ tools/
│  ├─ precompile-vue.cjs        模板 → render 函数（开发期）
│  ├─ tokenize-css.cjs          裸 px/色值统计（开发期，§3.4 收敛用）
│  └─ vue-templates/            模板源（开发期，不进运行时）
├─ skills/<id>/SKILL.md         内置 Skill（随页面/触发词加载）
├─ tests/                       常驻判据、单元、e2e、fixtures、数据基线
├─ docs/代码审查报告-2026-10-19.md  本轮完善与审查的输入清单
├─ 启动.bat                     UTF-8 无 BOM + chcp 65001，薄入口
├─ launcher.ps1                 UTF-8 带 BOM + CRLF，WinForms 启动器
├─ package.json                 只有开发依赖 @vue/compiler-dom
├─ vue.runtime.esm-browser.prod.js  本地 vendored Vue runtime（无编译器）
└─ vue.LICENSE.txt
```

## 3. 构建、启动、编码

### 3.1 运行时零构建

浏览器直接加载静态文件，**没有任何打包步骤**。`shell.html` 用原生 ESM 引入 `web/app.js`，
页面组件按需 `import()`。

### 3.2 开发期模板预编译（严格 CSP 的前提）

- 模板源只放在 `tools/vue-templates/*.html`；`web/` 下的组件**不许再写 `template:` 字符串**。
- 改了模板后运行：

```bash
npm install          # 只需一次：安装开发依赖 @vue/compiler-dom
npm run build        # 或 node tools/precompile-vue.cjs
npm run build:check  # 只比对，不写盘；CI / 测试用
```

- 生成物是 `web/render/*.js`：`export function render(_ctx, _cache)`，直接 import 本地
  `vue.runtime.esm-browser.prod.js`。生成文件不要手改；模板与生成物不一致时 `build:check` 必须红。
- 运行时**不再包含 Vue 模板编译器**，也不允许出现 `new Function` / `eval` / 内联 `<script>`。
- 页面组件统一写 `render: SomeRender`，不写 `template:`；新页面同样要进预编译清单。

### 3.3 严格 CSP

`shell.html` 的 meta 与 `server/static.js` 的 HTML 响应头都下发：

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';
font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'
```

- `script-src 'self'`：不许内联脚本、不许内联事件处理器、不许 eval。新增脚本必须是同源外部文件。
- `style-src 'unsafe-inline'`：允许现有的 `style=` 与动态样式元素；不要新增内联 `<style>` 以外的脚本能力。
- 页面代码里的所有 URL 必须是同源相对路径；媒体用 `Api.mediaSrc()`。

### 3.4 设计令牌与视觉

- `web/styles/tokens.css` 是**唯一**的主题 / 间距 / 字号 / 圆角 / 阴影 / 动效令牌来源；
  `ui.css` 与页面 CSS 不许再定义 `:root` 或 `html[data-theme="dark"]` 的第二套变量。
- 页面样式优先用 `var(--sp-*)` / `var(--fs-*)` / `var(--radius-*)` / `var(--shadow-*)` / `var(--dur-*)`；
  新代码不要再写裸的 4/8/12/16/24/32px 间距与 6/10/14 圆角。
- 颜色只从令牌取；页面确有品牌差异（如素材库的深色强调色）时，只在该页根类下覆盖一个变量，并写明理由。
- 所有可交互元素至少覆盖 `hover` / `focus-visible` / `active` / `disabled` / busy；
  `ui.css` 末尾有一份全站兜底，页面不要重复写同一份焦点样式。
- 视觉回归：`node tests/e2e/ui-visual.cjs`（八条路由、工作台按三型分档，再加两档要先喂状态才画得出来的
  「字幕编辑区 / 助手来源卡片」共 12 档 × 1024/1440 × 浅/深主题 = 48 个画面，24×14 RGB 指纹；
  字幕那一档要本机 ffmpeg 造可选用的视频，没有就整档跳过并报明）。
  首次或有意改版后：`UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs` 更新
  `tests/fixtures/visual/fingerprints.json`；不要为了让测试变绿随意放宽阈值。

**组件复用是硬约束**：新写任何界面块之前，先按 §7 的唯一实现清单查一遍；已有组件能表达的就直接用，
不够用就扩展公共组件，**不允许在页面里复制一份“看起来差不多”的实现**。至少这些必须走公共件：

| 界面需求 | 必须使用 |
| --- | --- |
| 下拉 / 浮层 | `Dropdowns`（程序化改完 options 后 `Dropdowns.sync(select)`） |
| 弹窗 / 二次确认 | `UiDialog.open` / `Confirm.ask` / `Confirm.arm` / `Confirm.choose` |
| 提示 / 回执 | `Toast`（`Toast.after` 只用于刷新后那一句） |
| 卡片列表 / 分页 / 视图档 | `Wb.cards` / `Wb.pager` / `Wb.viewToggle` + `VIEW_MODES` |
| 缩略图 / 视频预览 | `Wb.thumbs.mediaHTML` + `Wb.thumbs.keyOf` + `Wb.thumbs.bind` |
| 灯箱 / 下载 | `Wb.lightbox` / `Wb.save` |
| 素材选择 / 多选 | `AssetPicker` / `PickSel` |
| 筛选芯片 / AI 条件芯片 | `Chips.render` / `AiChip.paint` |
| AI 挑几条 | `AiFind.run` |
| 就地润色 / 提示词表单 | `InlinePolish` / `PromptForm`（正文六句只在 `TextAI`） |
| 分段开关 / 工具磁贴 / 次要按钮 | `.ui-seg` / `.tool` / `.ghost` |
| 图标 / 加载 / 空态 | `icon()` / `.ui-wait` / `.empty`（按钮里带图标时不许用 `textContent` 改字） |
| 跳页 | `GoPage.go`（站内不再 `location.href`） |
| 本机 / 云端标识 | `LocalBadge` / `AssetLocal.stateOf` |

页面只允许写“这一页自己的排版与布局”；卡片、弹层、下拉、芯片、分页、缩略图、提示、确认这些**不许**
在页面里出现第二份。发现重复实现，先把公共件补齐再把页面改过去，不要在旧副本上继续加功能。
存量页面里还有迁徙前手写的卡片/列表标记：**新功能与新建页面一律按上表执行**；改到哪一页就把那一页
顺手收敛到公共件，不要再新增第二份手写实现。

### 3.5 启动器与编码

- `启动.bat`：UTF-8（无 BOM）+ CRLF + `chcp 65001`。只做环境检查并拉起 `launcher.ps1`；
  支持 `WB_LAUNCHER_DRYRUN=1` 只打印检查结果。改完保持 UTF-8，不要在编辑器里存成 GBK。
- `launcher.ps1`：UTF-8 **带 BOM** + CRLF（PowerShell 5.1 无 BOM 会按 ANSI 解码，中文全乱）。
  语法用 `[System.Management.Automation.Language.Parser]::ParseFile` 查，`node --check` 看不见它。
- `启动.bat` 里那句 `start ... -WindowStyle Hidden` 必须保留：否则桌面上会多一个控制台，
  关掉它是硬杀进程，服务会成孤儿。隐藏前必须先解析 `launcher.ps1`，否则“双击没反应”。
- 启动器自检：`powershell -NoProfile -ExecutionPolicy Bypass -File launcher.ps1 -SelfTest`
  （`-EnvFile` / `-StateFile` / `-EnvAdd` / `-NoBrowser` 只给探针用）。
- 其他源码 / 文档一律 UTF-8；不要写裸控制字符（制表 / 换行除外），不可见分隔符写 `\u0001`。

## 4. 统一路由与安全边界（硬性）

### 4.1 页面不直连外部域名

页面里的每个外部请求只能打到本地代理同源相对路径：

```text
/registry /capabilities /<relay>/* /custom/<id>/* /getv /fetch /getfile /s3put
/asset/<id> /local-assets /local-assets/from-url /media/* /save* /pick-dir
/render* /fcpxml/* /data /prompts /cloud /skills /sys-status /env-status /clear-cache
```

- 平台接口只走 `Api.request(prov, 'create'|'poll'|'list'|'cancel'|'credits'…)`、
  `Api.create`、`Api.createBody`。
- 自己拼 URL 只用 `prov.relay + prov.endpoints.*`；不要用 `prov.base`（只给代理）。
- 媒体地址一律 `Api.mediaSrc()`；缩略图缓存键用 `Api.mediaKey()` / `Wb.thumbs.keyOf()`。
- 允许的非外部地址：同源相对路径、`data:`、`blob:`。

### 4.2 本机路由与会话

- `LOCAL_ONLY` 路由：`/data`、`/prompts`、`/cloud`、`/capabilities`、`/skills`、`/local-assets`、
  `/assets-usage`、`/save*`、`/pick-dir`、`/env-status`、`/sys-status`、`/clear-cache`、`/render*`、
  `/fcpxml`、`/media`、`/getv`、`/getfile`、`/fetch`、`/s3put`、`/custom`。
- 代理启动时生成会话 Cookie `wb_session`（HttpOnly + SameSite=Strict）。本机路由除同源检查外
  还要求这枚 Cookie；没有 Cookie 的 curl 读 `/data` 会拿到 401。
- 新写探针先用 `GET /` 收下 `Set-Cookie` 再打本机路由（样板见 `tests/e2e/harness.cjs`）。
- relay 前缀与 `/asset/<id>` 也只接受同源请求（跨站 403）；relay 前缀从
  `REGISTRY.providers[].relay` 现取，不要手写。

### 4.3 出站护栏

- 代理主动取字节前必须过 `guardOutboundUrl`（异步，含 DNS）或 `safeOutboundUrl`（同步字面量）：
  只允许公网 **https**；回环 / 内网 / 链路本地 / 解析到内网的域名一律拒。
- `/getfile`、`/s3put`、`/fetch`、`/getv` 四条通道只走 `takeOutboundUrl`，不要各自拼 400。
- 状态码原样透传；4xx/5xx 一律 `no-store`（签名过期 403 不能被缓存一整天）。

### 4.4 本机写盘两条路

- `POST /save`（另存）/ `/save-local`（补存）/ `/save-move`（搬）：目录只从服务端配置读，
  请求体里的 `dir` 一律忽略。
- `POST /pick-dir`：必须异步 `spawn`，不许 `spawnSync`；返回路径是隐私，只在 `LOCAL_ONLY` 里。
- 写盘前问余量：`whyNoSpace(dir, need, what)` 命中就 409 / 记进失败清单，一个字节都不落。
  量不到余量（没有 `statfsSync` / 目录不存在）一律放行，绝不把 `null` 当“不够”。

## 5. 能力驱动与供应商

### 5.1 一切来自声明

模型支持什么（输入 role、参数取值、上限、默认值、布尔开关、输出格式、字数区间）只来自
`Capabilities` / `REGISTRY`：

- `Capabilities.specs(model)` / `modelsFor()` / `blockedRoles()` / `illegalPairs()` /
  `unsupportedRoles()` / `inputTemplate()` / `rule()` / `combos()` / `shapeState()`。
- 页面不许写死张数、参考图上限、默认值、下拉选项；平台没声明的那一档整档不画、一个字不发。
- 平台的接口怪癖也要声明化：`pollVia:'list'`、`cancelMethod`、`noPromptField`、
  `create.idempotencyKey`、`create.topBools`、`create.shapeFields`、`create.template`。
- 没有 `cancel` 端点就不许画能点的取消按钮；没有 `credits` 端点就不显示余额但保留勾选框（压暗 + title）。

### 5.2 供应商

- 新平台只改 `server/registry-config.js` 的 `REGISTRY.providers`（relay / base / keyEnv / endpoints /
  modelDocs / newModelDefaults / create / inputRoles / inputTemplates / uploadFields / pricing）。
  改了结构就把 `REGISTRY.version` +1。
- 「资产号 → 最新下载地址」在哪一家换由**顶层** `REGISTRY.assetStore` 声明（provider / retrieve /
  urlFields / mimeField）。`/asset/<id>`、渲染素材解析、本机补存三处都只问
  `resolveAssetStore()` 的结果，不再写死平台名或密钥名；没有声明就照实回「这家没有资产接口」。
  声明结构改了同样 `REGISTRY.version` +1。
- 「型号清单响应的数组落在哪个字段」也只由顶层 `REGISTRY.modelList.fields` 声明：页面 `Api.modelRows`
  与服务端 `/custom/models`（`modelRowsOf`）读同一份，调用点不再各写一张字段表。
- 用户自定义中转走设置页「添加自定义供应商」：按类型（图片/视频/语音/文字）填表，存
  `sk_custom`，代理 `buildCustom` 整条克隆模板；relay `/custom/<id>`，密钥 `sk_key_<id>`。
- 内置平台也要先“添加一次”才进「供应商与密钥」卡；用官方地址添加自己是正常路径。
- 类型档：`image / video / audio / text`；文字 AI 的供应方、密钥、地址、型号、识图开关
  都在「文字」档里，一家一张卡。类型名与顺序只有 `ui.js` 的 `provKindZh` / `provKinds` 一份。
- 「供应商与密钥」这一张卡的分档里还有 `asr`（语音识别）与 `search`（联网搜索）两档：
  它们不是平台供应商，而是同一层级的两种接法，表单由设置页持有、设置存服务端 `.data/asr.json` /
  `.data/search.json`；两档的容器 id 仍是 `#asrCard` / `#searchCard`。
- 显示名按「类型 + 编号」预填；同名会让型号下拉分组与收藏筛选项分不开。
- 自定义条目没有环境密钥回退，也不认 `x-up-base`（防止把 A 的密钥发到 B）。

### 5.3 转发闸

- 闸按「一家平台」算，键是 `keyId || id`；四档 `.env`：`RELAY_MAX_INFLIGHT`、
  `RELAY_QUEUE_MAX`、`RELAY_RETRY_MAX`、`RELAY_WAIT_MAX_MS`。
- 排满当场回本地 429 并写明“没有扣费”；退避重试只给 GET；名额必须恰好归还一次。
- 列表/详情短缓存命中与“挂同一条在途请求”都排在闸之前；被限流不进健康故障表。

## 6. 数据与用户文件

### 6.1 绝不提交、绝不擅自删

- `.env`、`.data/`、`.assets/`、`.renders/`、`prompts/`、`.skills/`、`node_modules/` 都在 `.gitignore`。
- 用户的工作区、历史、归档、素材是用户数据：清理前确认是测试残留，不要擅自删。
- 源码里绝不出现真实密钥；密钥只从 `.env` / 系统环境变量 / 设置页取。

### 6.2 写入可靠性

- 代理覆盖/删除 `.data/<key>` 前留 `<key>.bak.json`（最少 10 分钟，内容相同不留）。
- “读不出来”绝不等于“本来就没有”：拿读取结果当写入底座的地方，必须像 `data-store.js` 那样
  再摸一次原始值；读坏就拒写并原样报错。
- 任务号一落盘就等于一次已付的钱：提交拿到 `taskId` 就写盘；删/放弃前先看是否还在跑；
  放弃走“不等了”（按 registry 的 `cancel` 端点撤单，撤不掉照实说“可能还在计费”）。
- 异步长任务抓住它自己那一集/那一条（`const mine = …`），收尾不要摸“当前”，否则用户切走就白等。
- 关标签前注册 flush/dirty：`window.__spaRegister(flush, dirty)`；导演台另写同步救生包
  `dir_ws_unload`（IndexedDB 异步，beforeunload 等不到）。

### 6.3 本机资产身份

- “同一份产物”只有 `local.js` 的 `mirrorOf` 一处：平台产物号优先，其次“任务号且只出一份”，
  再次来源地址（剥签名）与本机号。
- “本机 / 云端”唯一读法是 `AssetLocal.stateOf(entry)`；页面不许自己拼
  `localAsset || hasLocalAddr(src)`。
- 自动镜像由应用级事件触发：`wb:asset-done`；`AssetLocal.watch` 统一接住并 scan。
  字节由代理流式落盘：`Api.saveLocalFromUrl` → `POST /local-assets/from-url`，不要 base64 大文件。
- 镜像指针本体在 IndexedDB（`Kv.at('mirror')`），`sk_local_mirror` 只留暖启动缓存。
- 过期签名外链由公共层负责：`Api.mediaExpired` / `Api.healMedia` / `Api.mediaSrc`；
  页面不许自己判过期，也不许拿 assetId 拼 `/asset/<id>`。

### 6.4 云同步

- `POST /cloud/sync`（双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
- 冲突判定靠 `.data/.cloud-state.json` 基线；不要退回“只看时间取新”。
- 远端存在但读不下来 → 判 `error` 跳过，绝不 push；本地删除必须真正执行到底。
- 浏览器对账体积相同不能直接跳过（等长修改）；对账期间本地写入先进 held 暂存表。

## 7. 公共层：唯一实现清单

“同一个功能只应有一份实现”。页面要用下列能力，只能走公共层；发现重复实现先收敛。

| 能力 | 唯一实现 |
| --- | --- |
| 下拉 / 浮层 | `web/ui/ui.js` 的 `Dropdowns` |
| 网络 | `web/ui/net.js` 的 `Net`（超时 / 重试 / `NUMS` / `num` / `storedNum` / `setNum`） |
| 本地存储 | `web/ui/store.js` 的 `Store`（信封 / 上限 / `sweep`） |
| IndexedDB | `web/ui/kv.js` 的 `Kv.at(登记名)`（登记表只有一份） |
| 提示 | `web/ui/toast.js` 的 `Toast`（含 `Toast.after`） |
| 数据同步 | `web/ui/datasync.js` 的 `DataSync` |
| 弹窗 / 确认 | `UiDialog` / `Confirm.ask` / `Confirm.arm` / `Confirm.choose` |
| 分段 / 芯片 | `ui-seg` / `Chips.render` / `AiChip.paint` |
| 页面尺寸 | `pageModeOf` / `pageSizeOf` / `PAGE_TARGETS` |
| 跳页 | `GoPage.go`（同文档走 `window.appShow`） |
| 媒体 | `web/domain/api.js` 的 `Api.mediaSrc` / `Api.mediaKey` / `Api.mediaExpired` / `Api.healMedia` |
| 接口 / 统一取数 | `web/domain/api.js` 的 `Api`（`request` / `create` / `createBody` / `pollTask` / `list` / 余额）+ 顶层 `netFetch` / `respBody` / `classifyStatus` |
| 资产 | `AssetLib` / `AssetLocal` / `AssetTransfer` / `AssetPicker`（`AssetLib` 列表与费用口径在 `assetlib.js`） |
| 任务 | `Wb.poller` / `Wb.History` / `Wb.thumbs` / `Wb.detail` / `Wb.cards` / `Wb.pager` / `Wb.viewToggle` + `VIEW_MODES` |
| 灯箱 | `Wb.lightbox` |
| 下载 | `Wb.save` → `Net.save` |
| 视频取帧 | `Wb.vframe.el` / `release`（只为解码而建的 `<video>` 只有这一份） |
| 能力声明 | `web/domain/capabilities.js` 的 `Capabilities` |
| 文字 AI | `web/domain/text-ai.js` 的 `TextAI`（含 `polishImages` / `qaOf` 契约） |
| 提示词归档 | `web/domain/prompt-log.js` 的 `PromptLog` |
| 收藏 | `web/domain/fav.js` 的 `Fav` |
| 素材库 | `web/domain/chars.js` 的 `Chars`（`Lib` / `Pipe` / `SET`） |
| 语义检索 | `web/domain/semantic.js` 的 `SemanticSearch.rank` |
| 画布能建哪几类节点 / 输入闸 | `web/domain/canvas/registry.js`（类型、`acceptsInputKind`、上限只在这一份） |
| 画布文档与合法性 | `web/domain/canvas/doc.js` 的 `sanitizeDoc` / `validDoc` / `cleanMeta` / `LIMITS` |
| 画布写入唯一出口 | `web/domain/canvas/ops.js` 的 `applyOperations`（CAS 修订号、成环、类型、连带删线都在这） |
| 画布撤销栈 | `web/domain/canvas/history.js`（补丁式、`source:'external'` 推基线） |
| 画布几何 / 视口 | `web/domain/canvas/spatial.js` / `view.js` |
| 画布生成（怎么跑、缺什么） | `web/domain/canvas/gen.js` 的 `resolve` / `whyReady` / `submit` |
| 画布节点检索排序 | `web/pages/canvas.js` 的 `rankNodes`（判据仍读 `SemanticSearch.rank`，助手与 Ctrl+F 共用这一份） |
| 导演台台词面板 | `web/director/lines.js` 的 `speakerOf` / `lineTimeOf` / `lineRowHTML`（剪辑右栏「台词」那一档两段共用；镜头编辑右栏没有第二份） |
| 导演台导出格式 | `web/domain/export-formats.js`（页头按钮 / `export_start` 分派 / 助手枚举与文案都读这一张表） |
| 导演台剧本视图 | `web/director/script.js` 的 `scriptTextOf` / `parseScript` / `applyScript`（按分镜现算，写入只落 `sh.prompt`） |
| Skill | `web/ui/skills.js` 的 `WbSkills` |
| 中文名 / 类型 | `ui.js` 的 `provKindZh` / `provKinds`、`isAudioType` / `mediaKindOf` / `fileExtOf` |
| 字数闸 | `gen-forms.js` 的 `CharLimits`（`bounds` / `tts` / `prompt` / `why` / `cntLine`） |
| 配音合成设置 | `web/domain/gen-forms.js` 的 `TtsAdv` + `AdvExtras` |
| 音色说明 | `window.VoiceNote.run` |
| 格式化 | `Wb.fmtSec` / `fmtClock` / `fmtWhen` / `fmtWhenSec` / `fmtHM` / `fmtHMS`；`ui.js` 的 `dayKey` |
| 文件名 | `fileSafe` / `fileStamp`（浏览器与 Node 各一份，是登记在案的例外） |
| 设置项清单 | `web/ui/ui.js` 的 `window.UI_PREFS`（`rows` / `groups` 一份派生导出、同步、恢复默认与助手白名单，判据 `tests/settings-schema.cjs`） |
| 「现在能不能按生成」 | `web/domain/gen-rules.js` 的 `window.GenRules`（页面与助手都只翻译它给的原因码，不各写一套判据） |
| 客户端错误出口 | `web/core/report.js` 的 `window.PageReport`（`fatal` / `warn` → `POST /client-error` → 代理健康账） |
| 本机索引写入口 | `server/index-store.js` 的 `update(fn)` 串行队列 + `putInto` / `dropFrom`（跨 await 的读-改-写只能走这一处） |
| 一行素材的身份键 | `AssetLib.entryKey`（页面与缓存）；裸工作台任务记录用 `Wb.taskKey` |

## 8. Vue SPA 页面

- 运行时没有构建步骤；Vue 3.5.44 runtime-only，本地 vendored。
- `web/app.js` 是唯一外壳：hash 路由 + `<KeepAlive>` 页面池；切页只离屏、不销毁。
  页面 DOM、滚动位置、筛选与多选状态都留在原地。
- 路由表只有 `web/core/routes.js` 的 `WB_ROUTES`：页面文件 / id / 侧栏名 / 图标 / 标题 /
  组件地址 `src` / 旧地址别名都从这里读，外壳的页面组件映射由这张表现搭。新增页面只改这一处，
  不在 `web/app.js` 或页面里另抄一份映射（`tests/spa.cjs` 拦）。
- 页面组件：默认导出，根节点 `page-main <page>-page`；私有样式挂页面根类；公共样式走
  `web/styles/`。数据/副作用走公共层，不重写。
- 切页可见性：`spa:page` 事件与 `window.__spaActivity.visible()`（裸布尔 `__spaPageVisible` 已删，两套判据并存就是「切走了还在轮询」那一类）；隐藏页的轮询 / 抽帧 / 缩略图要停。
- 页面内不要 `location.href` 换页；站内跳转走 `GoPage` / `window.appShow`。
- 关标签/刷新前用 `window.__spaRegister(flush, dirty)` 注册保存与未落盘判断。
- `window.__*` 是跨脚本层的钩子（经典脚本没法 import ESM，只这一族能跨过去），不是第二套公共接口：
  开了就要有人读，页面自己挂的那一枚必须在卸载时清掉（`delete` 或赋 `null`），否则钩子一直指着
  已经离屏的那一页。判据 `G8`（`tests/static-guards.cjs`）当场数这两条，新增一条就红；
  要留（比如只给探针观测）必须在 G8 表里写清原因。不恢复上一代 iframe 时代的同义钩子。
- 助手读当前页快照走 `page-context.js` 的 `__acPageCtx`，不要靠扫 DOM 猜。
- 新增公共 UI 组件放 `web/ui/` 并从 `web/ui/index.js` 导出；页面不要深路径引用组件。

### 8.1 画布页与它的助手写入桥

- `web/pages/canvas.js` 是画布唯一一页：文档、几何、渲染、轮询与 `WBBridge.canvas` 在同一个闭包里；
  纯算法按域在 `web/domain/canvas/`（见 §7），页面只留接线。
- **唯一写出口**是页内的 `commit()` → `ops.js` 的 `applyOperations(doc, ops, { expectedRevision })`：
  类型、输入上限、成环、删节点连带断线、修订号 +1、进撤销栈全在这一处；别的地方不许直接改文档数组。
- 助手只能走桥的 `apply`，八个写动作（`canvas_nodes_create` / `_update` / `_delete`、
  `canvas_edges_create` / `_delete`、`canvas_viewport_set`、`canvas_generation_propose`、`canvas_undo`）
  加五项只读（`canvas_get` / `canvas_search` / `canvas_node_read` / `canvas_assets_list` /
  `canvas_generation_status`），只在画布在前台时可见。CAS 凭据（`expectedRevision`、`operationId`）由
  `stampWrite` 在提交那一刻现读现补，不写进动作的 schema、也不让模型填。
- 助手写入进撤销栈时带 `source:'external'` 并推进基线：用户 Ctrl+Z 撤不到助手那一步，助手自己用
  `canvas_undo` 退；`canvas_undo` 里写的是「要退掉的那一步」的号，交到注册表前必须换成
  `undoOperationId` —— 注册表那个位子是**这一次执行**的幂等键，混用会命中上一次写入的缓存结果，
  撤销根本没跑、卡片却照着旧回执念。
- 视图（`canvas_viewport_set`）只动视口：不涨修订、不进撤销栈；`ops.js` 的 `VIEW_OPS` 是那条判据唯一出处。
- 提案与扣费分开：画卡片与 `execute:false` 那一次执行都不建任务、不发一次生成请求；只给 `nodeId`、
  一条操作都没有的那种「这一枚打算怎么跑」是纯读，不能拿「至少要一条操作」拒掉。
- 只读的那一份画布由页面自己声明 `readOnly()`：助手的写闸与界面快照都只认这一处。
- 资产引用只认本机查得到的号（`cvAssetGate`）；一条资产怎么变成节点只问桥的 `assetNode`（页面那份 `assetOpOf`）。
- 画布内检索排序只有页面那一份 `rankNodes`（判据仍读 `SemanticSearch.rank`，它回的是
  `{ item, score, why }` 那一层壳，`item` 才是检索行）；页面 Ctrl+F 与助手的 `canvas_search` 共用，助手不另排。

## 9. 导演台

### 9.1 边界

- `web/director/index.js`：Vue 页面组件 + 作用域岛（模板 HTML、样式、生命周期、`WBBridge` 安装）。
- `web/director/template.html`：导演台真实 DOM 模板（不是 Vue 模板，不参与预编译）。
- `web/director/engine.js`：命令式热路径与 DOM 接线；状态、轨道、剪辑、右栏 UI 在这里。
- 纯算法按域拆开，engine 只调用：
  - `segments.js`：段模型 / `segsOf` / `segsWrite` / 四件搬运
  - `timeline.js`：框、轴秒、灰场、`filmFrames`
  - `voice-layout.js`：配音框/选区、灰场跳过、全片轴与原因码
  - `voice-block.js`：配音块标记
  - `lines.js`：台词行渲染（说话人 → 素材库缩略图 / 占位、本镜与全片两个时间读数）
  - `script.js`：剧本视图（分镜现算成稿；改稿只写回 `prompt`，台词不在那份稿子里）
  - `waveform.js`：解码 / 包络 / SVG
  - `playback.js`：双甲板接力、黑场、配音起播
  - `plan.js`：本镜 / 全片播放计划
  - `projection.js`：镜头顺序与 clips 派生
  - `slice.js`：切片几何与采样
  - `board.js` / `split-assets.js`：拆分镜
  - `media.js`：候选身份 → 预览 / 导出地址（本机号只走 `AssetLocal.localAssetIdOf`，画面段、配音、切片、FCPXML 都只问这一份）
  - `subtitles.js`：字幕轨（台词/配音派生、SRT 导入导出、烧录与 FCPXML 都读 `currentOf`）
  - `fcpxml.js` / `fcpxml-import.js`：导出与读回（读回落进同一份工程数据）
  - `util.js`：导演台内部的小纯函数（`round1` / `pct` / `spdTxt` / `escHTML` / `parseJsonLoose`）
- 改算法先改模块，engine 只留调用与状态；不要在 engine 里再抄一份。

### 9.2 时间线硬约束

- 数据层一律**源秒**；画出来才折算成轴秒（框 ÷ 倍速）。
- 段只在候选身上存一份 `c.segs`；本镜与全片两排读同一份，剪一刀两处同时变。
- 一段 = 框 `[a,b]` + 选区 `[in,out]`；拖把手只改框内灰遮罩，不改框、不改别的格。
- 台词面板全站只有一处：剪辑右栏「台词」那一档（本镜那一句 + 其余每一句，一行只出现一次）。
  写完的台词**自动**上本镜 / 全片两条待生成轨（判据只有 `pendingLineOf` 一份），点轨道占位与点那一行
  是同一个出口 `openPendingVoice`；改台词要 `beginEdit()` 压快照、松手 `filmEdited()`（字幕按台词派生、会烧进成片）。
- 台词与提示词互不带动：`sh.line` / `sh.lineWho` 与 `sh.prompt` 各写各的，剧本视图只写 `prompt`；
  AI 拆分镜仍按画面生成台词并落进同一份字段（那是生成，不是同步）。
- 切片按框取帧；缓存键走稳定身份；缩放只重排、不整列重画。
- 取帧失败按**退避**记账并自己重试：轨道没有定时重画，一次解码超时若只压进一张长 TTL 表，
  界面就是一直斜纹（用户不动一下好不了）；8 秒起、逐次翻倍、最久 5 分钟，到点由 `sliceRetryIn`
  那条定时器照着还活着的栏目再排一遍活。
- 播放不渲染：剪辑态实时播，导出才跑 ffmpeg；播放器控制条只有 `pbBarHTML` 一份。
- 合并/导出只从页头入口触发；任何会改变成片内容的编辑必须先 `filmEdited()`。
- 导出成片前先判 `filmIsCurrent()`；404/空文件要作废 `proj.merged` 并让用户再点一次导出。
- 本地优先：预览遵守 `sk_media_prefer`，**导出始终本机优先**；有本机副本不碰上游。
- FCPXML 只读当前时间线：素材优先真实本机文件，缺失仍建离线 asset，不许静默丢段；
  配音按 `at / 画面倍速` 挂到对应段，黑场写 `<gap>`。

### 9.3 助手写入桥

- 唯一写入桥是 `WBBridge.director`（`web/core/bridges.js`）：`check(op,arg)` 纯读校验，
  `run(op,arg)` 执行；op 为 `select` / `cut` / `set` / `undo`。
- 只有导演台在前台可用；切段走编辑器自己的 `cutSegs → segsWrite → reanchorVoices`；
  写入前 `beginEdit()` 压撤销快照；行锁/状态/越界在 check 阶段拦。
- 助手动作 `select_take` / `cut_timeline` / `set_clip` / `undo_edit` 只做转发；
  绝不让模型用 `click` 去点轨道按钮。

## 10. AI 助手与 Skill

- 助手 UI 在 `web/features/chat.js`（外壳：悬浮球 / 抽屉 / 会话 / 渲染 / 发送循环）；
  工具循环与动作目录在 `web/features/chat-tools.js`（`TOOLS` / `ACTS` / `TOOL_INPUT` /
  `ACTION_META`），由 `window.AiChatTools.build(C)` 取共享函数，加载顺序 chat-tools → chat。
  会话记录、Skill 自动加载、上下文预算、密钥脱敏都在 chat.js。
- 抽屉有两种停靠：浮层（盖在页面上）/ 固定右栏（`html.ac-dock`，`#app` 用内联宽度让出
  `--sbw + 面板宽`，页面可继续操作）。偏好只存本机 `ai_chat_dock`，打开状态本身不持久；
  窗口窄于 `DOCK_MIN` 自动回浮层，放宽后按偏好恢复。
- 写动作只经 `web/core/actions.js` 的 `ActionRegistry`；任意脚本 `inject` 整族禁止。
- 动作默认直接执行、不强制过程可见：结果回执 + 撤销必须可见；跨页给“去看看”，定位按需。
- 内容写动作必须有 `undo` 或显式 `irreversible`；花钱动作声明 `cancel`。
- Skill：`skills/<id>/SKILL.md`；按页面 + 触发词自动加载（最多 2 个），未命中的由 `skill`
  工具按需加载。内置 Skill 正文由 `TextAI.DEF` 同源生成；用户手改的 `sk_polish_*` 仍最优先。
- 查询结果按 `estimateTokens` 预算；发出前 `redactSecrets` 抹密钥形状。
- 设置项只有白名单（`ADJUST` + `PAGE_TARGETS` + `sk_model_<kid>` + `Chars.SET`）；
  助手的供应方/型号只在设置页选（`sk_text_prov` + `sk_model_<kid>`），抽屉里没有第二份选择。
- 流式进行中不许清空气泡；切页/刷新前已写出的字要落盘并写明断了。

## 11. 素材库 / 资产库 / 工作台

- 素材库身份锚点只有 `newChar/newScene/newProp` 的 `anchor` 与 `Chars.refPicOf`；
  页面不许自己 `c.face || c.img` 拼。
- 素材库体检数字现算，不落库；多选批量全部调单条入口；使用关系读同一份 `loadRefUse()`。
- 工作台三类型共用一页：`?t=video|image|audio`；型号与提示词分类型记住；
  右栏历史三类型合并、按 `assetId` 去重。
- 输入模式（一次请求能用哪几类素材）只有 `Capabilities.combos` 一份；判据双向
  （缺料 / 超料 / 不收 / 互斥），`mode` 不是提交字段。
- 四颗“存回本机”只走 `AssetLocal.pullMany`；页面里一次都不许出现 `AssetLocal.pull`。
- “不显示云端任务”是 `AssetLocal.hideAsCloud` 一张闸，不是一套筛选。
- 卡片徽标只有 `web/ui/local-badge.js` 一份，五页同读 `AssetLocal.stateOf`。
- 选择器来源档位只有 `AssetPicker` 的 `inView` 一处；音频条目按 `noMedia` 走自己的调度，
  不许把 `<img>` 塞一段音频。
- 下载文件名、类型判断、数字格式化一律走 §7 的公共实现，不许页面各拼一份。

## 12. 服务端与路由

- `server/app.js` 是组合根；每个路由只在自己的 `server/routes/*.js` 里实现，
  app 只负责构造依赖与分发（处理器返回 `false`/`undefined` 的约定别混）。
- 静态资源：只放行根级单文件与 `web/` 子树；HTML 带 CSP、nosniff、Referrer-Policy。
- `/data` 写入是原子写 + `.bak`；`/data` 清单不包含 `.bak`。
- `/prompts`：写文件 + 索引；`/prompts/find` 按 id 返回全部归档，客户端每个任务只问一次。
- `/render`：本地长任务，客户端用 `Net.fetch(..., { timeout: 0, retry: 0 })`；POST 不自动重试。
- `/fcpxml/bundle`：只写 `RENDER_DIR/fcpxml-<stamp>/`，素材只按资产号 / 已过护栏的 URL 取，
  取不到写 `missing.txt`。
- 渲染编码器与档位走 `.env` 的 `RENDER_VCODEC` / `RENDER_PRESET`：
  档位名单跟着编码器走，质量数按编码器换写法，问不出 `ffmpeg -encoders` 当“不知道”不当“没有”。
- 渲染队列上限 `RENDER_QUEUE_MAX`、并发 `RENDER_CONCURRENCY`、保留 `RENDER_KEEP_MIN`；
  超了当场 429。启动日志把实际生效值与来源一起打印。
- 代理健康账：未捕获异常 / 未接住的 Promise / 500 / 连接错误四类；只报不自杀，连接错误不算故障。

## 13. 测试与验证

### 13.1 必跑

```bash
npm run build:check                 # 模板与 render 一致
node tests/all.cjs --e2e            # 语法 + 常驻判据 + 单元 + 架构 + 指标 + 浏览器 e2e
```

`tests/all.cjs` 覆盖：`selfcheck`（内含 `tests/spa.cjs` 的架构判据）/ `editing` /
`local-first` / `index-store` / `core` / `ui-catalog` / `editor-media` / `local-edit` /
`fcpxml-client` / 导演台各纯函数 / 画布各纯函数（`canvas-registry` / `-doc` / `-ops` /
`-history` / `-spatial` / `-gen`）/ `providers-validate` / `asr-settings` / `asset-text` /
`skill-hub` / `zip` / `architecture` / `metrics`；`--e2e` 另跑 smoke / ui-visual / proxy /
cloud-sync / asr / search / assets-text / chat-actions / actions / actions-feedback / chat-context /
chat-search-cite / assistant-dock / drag-guard / director-perf / parity / skills / skill-hub / fcpxml /
editing-assets / director-slice / director-lines / editing-assistant /
render-jobs / canvas / canvas-assistant / canvas-port / ui-contract / ui-shared / lock。

视觉基线更新（只在有意改版后）：

```bash
UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs                    # 全部画面
UI_VISUAL_WRITE=1 UI_VISUAL_PAGES=canvas node tests/e2e/ui-visual.cjs   # 只补点名的那一页
PARITY_WRITE=1 node tests/e2e/parity.cjs
```

### 13.2 写入型验证只跑隔离实例

```bash
PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe RENDER_DIR=.renders-probe \
  SKILLS_DIR=.skills-probe node proxy.js
```

- 不给 `ASSETS_DIR` / `RENDER_DIR` 就会写进用户真实资产库与成片目录。
- 自己 spawn 的探针要认领“答话的就是我刚起的那一份”：`/sys-status` 的三个目录都要点名，
  并判子进程没有提前退出。
- 测试结束清理 `.data-probe*` 等目录与孤儿进程；不要留在仓库里。

### 13.3 数据基线

- `node tests/data-snapshot.cjs` 比对 `.data / .assets / .renders` 与 `tests/data-baseline.json`。
- 写入型测试前后都要核对；真实实例上只做只读加载。

### 13.4 浏览器

- 只跑 headless；测试脚本自己起隔离代理与 Chrome。
- 页面 e2e 必须检查控制台错误（CSP 违规、未捕获异常、404）。
- `tests/e2e/harness.cjs` 是唯一的启动/取 Cookie/打开页面入口，别每个脚本各写一套。

## 14. 编码与新增功能清单

### 14.1 编码

- `.js/.mjs/.cjs/.html/.css/.md`：UTF-8；`.bat`：UTF-8 + `chcp 65001`；
  `.ps1`：UTF-8 **带 BOM** + CRLF。
- 页面样式只用 `tokens.css` 的令牌；不要在页面里写第二份主题变量或裸色值。
- 不要写裸控制字符；不可见分隔符写 `\u0001`。
- 源码里不出现真实密钥；日志不打印密钥 / Cookie / 用户路径之外的本机隐私。

### 14.2 新增页面的落点

1. `web/pages/<id>.js`（Vue 组件，默认导出，`render` 来自预编译）。
2. `tools/vue-templates/<id>.html`（模板源）+ 跑 `npm run build`。
3. `web/core/routes.js` 的 `WB_ROUTES` 加一条（含组件地址 `src` 与页面根类 `root`，`src` 相对
   `web/app.js` 写，如 `./pages/<id>.js`）；外壳的组件映射由它现搭，`web/app.js` 不用再改。
   新页面还要在 `web/core/page-context.js` 的 GET 里点名（助手快照），视觉档位与
   「哪些页必须有快照 / root」都由这张表现取，漏了直接红。
4. 私有样式 `web/styles/spa-<id>.css`（根类下），公共样式复用 `tokens.css` / `ui.css`。
5. 需要后台可见性/保存钩子时接 `spa:page` 与 `__spaRegister`。
6. 动态补载公共脚本只用当前路径（`web/ui/workbench.js` / `web/domain/chars.js`）；
   `__spaLoadScript('workbench.js')` 这类根目录旧文件名已被 `tests/spa.cjs` 拦截。

### 14.3 新增供应商

只改 `server/registry-config.js` 的 `REGISTRY.providers`（或走设置页自定义供应商表单）；页面不改。
若注册表结构变了，`REGISTRY.version` +1，并更新 `server/providers/validate.js` 的校验与
`tests/providers-validate.cjs`。资产存储换了平台还要改顶层 `assetStore` 的 `provider` / `retrieve` /
`urlFields`（判据 `validateAssetStore`），不要在路由或页面里另写一家。

### 14.4 新增助手动作

1. 动作本体写在 `web/features/chat-tools.js` 的 `ACTS`（`title` / `doc` / `arg` / `check` / `run`）。
2. 策略写在同一文件的 `ACTION_META`（`effect` / `route` / `undo`，一行一条）：`effect` 与 `route`
   缺任一项 `registerActions` 当场抛，整份目录不交出来（写动作 fail-closed，见 `regClosed`）；
   全站动作 `route: '*'`，不给 `undo` 是有意声明「这一条真退不掉」。
3. 需要参数形状才在 `TOOL_INPUT` 补一条（读工具与动作共用这张形状表，不给就是 `{type:'object'}`）。
   `ACTS` / `ACTION_META` / `TOOL_INPUT` 都在 `chat-tools.js`；chat.js 只经 `window.AiChatTools`
   读它们，不另存一份。
4. `web/core/actions.js` 的 `ActionRegistry` 是执行外壳（planToken / 幂等键 / 同一个 busyKey 串行 /
   超时可中断），不在这里注册动作，也不要另写第二份动作目录或第二套工具清单。
5. 结果必须给回执；需要撤销的写动作必须真的能撤销；花钱动作（`cost`）声明 cancel。
6. 静态判据 `G7`（`tests/static-guards.cjs`）与浏览器判据（`tests/e2e/actions.cjs`）会一起数这两张表，
   并把「设置页看得见导演台动作」这类跨页泄漏直接判红。

### 14.5 新增导入导出格式

- 导演台的**导出格式**只有一张表 `web/domain/export-formats.js`：页头按钮、`export_start` 的校验/分派/文案、
  助手 `export_start` 的 enum 都从它派生。加一种导出 = 表里一行（`kind` 是 `film` / `files` / `xml` 之一）
  + engine 里一个 builder；判据 `tests/export-formats.cjs`。
- 纯拼装在 `web/director/*`（如 `fcpxml.js`）或 `web/domain/*`，不在页面里拼字符串。
- 导出素材的文件名带成片时间点（`clipTimeLabel` / `voiceFilmRange`），不要只给哈希名。
- 缺失素材/段落一律报数（清单/状态行），不许静默丢。

### 14.6 明确禁止

- 不做插件机制（第三方插件、插件市场、插件沙箱）；扩展只走平台声明、页面、动作、Skill 四类落点。
- 不做任意脚本注入 / 执行任意 URL 的动作；助手动作只经 `ActionRegistry` 注册。
- 不恢复 iframe 页面池、换页 reload、上一代旧页面文件或旧路径 wrapper；旧地址只保留路由别名。
- 不在运行时做模板编译、打包或 `new Function`；模板预编译是开发期步骤。
- 不为了“兼容”保留两套实现：新实现直接接管调用点，旧实现删除；用户数据迁移是唯一例外。
- 不新增第二套动作目录、页面路由表、供应商类型表、格式化函数或网络层。

### 14.7 新功能文件落点（按类型）

新增功能先按这张表决定文件，不要临时找地方塞；跨类型的改动按“最靠近数据的一层”落：

| 功能类型 | 落点 | 必须一起改 |
| --- | --- | --- |
| 新页面 | `web/pages/<id>.js` + `tools/vue-templates/<id>.html` + `web/styles/spa-<id>.css` | `web/core/routes.js` 加一条（含组件地址 `src`）、运行 `npm run build` |
| 共享 Vue 组件 | `web/ui/<name>.js`，并从 `web/ui/index.js` 导出 | 样式只进 `ui.css`/`tokens.css`；页面不许深路径 import |
| 共享纯逻辑 | `web/domain/<domain>.js`（挂一个 `window.<Domain>` 面） | 只暴露最小方法；页面不复制规则 |
| 外壳/路由/生命周期 | `web/core/*.js`、`web/app.js` | 不留页面专用全局；需要跨页桥走 `WBBridge` |
| 新服务端路由 | `server/routes/<name>.js` | 在 `server/app.js` 构造依赖与分发；敏感路由加 `LOCAL_ONLY`；补 e2e |
| 新数据/存储 | `server/<name>-store.js` | 原子写 + `.bak`；改结构先做迁移；补数据基线 |
| 新供应商 | `server/registry-config.js` 的 `REGISTRY.providers` | `REGISTRY.version` +1（结构变了才加）、`providers/validate.js`、`tests/providers-validate.cjs` |
| 新导演台纯算法 | `web/director/<domain>.js` | engine 只调用；补 `tests/director-<domain>.mjs`；涉及播放/导出再加 e2e |
| 新导演台 DOM 交互 | `web/director/engine.js` 或已有域模块 | 不许在页面层另写编辑算法；必须走 `beginEdit` / `filmEdited` |
| 新助手动作 | `web/features/chat-tools.js` 的 `ACTS` + `ACTION_META` | 策略一行：`effect` / `route` 必填、`undo` 有意不给=真退不掉；花钱动作 cancel；补 e2e（见 §14.4） |
| 新 Skill | `skills/<id>/SKILL.md` | frontmatter（id/name/triggers/pages/contract）；内置正文与 `TextAI.DEF` 同源 |
| 新导出/导入格式 | `web/director/*` 或 `web/domain/*` 的纯拼装模块 | 缺失素材报数；补 golden/parity |
| 新测试 | 单元 `tests/<name>.mjs|cjs`；浏览器 `tests/e2e/<name>.cjs` | 加到 `tests/all.cjs`；断言失败要能指出落点 |
| 新视觉基线 | `tests/fixtures/visual/` | 只允许 `UI_VISUAL_WRITE=1` 更新；实际截图走 gitignore |

命名与导入边界：

- 文件名 kebab-case；页面组件 `web/pages/<route-id>.js`；导演台模块按域命名，不按阶段编号。
- 浏览器经典脚本挂一个 `window.<Name>` 面；ESM 页面/导演台模块用 `export`，不要两边混着挂。
- 公共层不许反向 import 页面；页面不许深路径引另一个页面的私有模块。
- 跨闭包调用只走导出面/`window` 公开接口，不裸调兄弟闭包里的局部函数。
- 动态补载公共脚本必须写当前路径（`web/ui/workbench.js`、`web/domain/chars.js`），
  不许再出现根目录旧文件名。

### 14.8 新增界面的检查顺序

1. 先查 §7 唯一实现清单与 §3.4 组件表：有没有现成组件/公共类？
2. 有 → 直接用；不够用 → 改公共件并补测试，**不在页面里复制**。
3. 只写这一页自己的布局；颜色/间距/字号/圆角/阴影/动效只取 `tokens.css`。
4. 键盘焦点、禁用、busy、空态、加载态、深浅主题、1024/1440 都要过一遍。
5. 有 AI 文案 / 用户文案进 `innerHTML` 必须 `esc`；有图标按钮不许 `textContent` 改字。
6. 改完跑 `npm run build:check`、`node tests/all.cjs --e2e`；有意改版才更新视觉基线。

## 15. 已知平台事实（当前有效的部分）

- **VGENV**：列表/详情不返回 `prompt`（提示词靠 `PromptLog`）；上传用 camelCase 且拒绝未知字段；
  参考素材用 `{asset_id}`，首尾帧走 `frame_images` + `frame_type`；详情端点是 404 空壳，
  注册表声明 `pollVia:'list'`，列表才是状态依据。
- **SparkCine**：上传用下划线字段 + `sha256` 必填；详情 `outputs[].asset_id`；
  创建要求 `Idempotency-Key`；视频“平台自动润色”是 `create.topBools.optimize_prompt`（顶层）。
- **MiMo**：语音同步合成，没有任务号；本地 `audio_tasks` 是唯一凭据。`tts.encoding:'hex'`
  的返回要按十六进制解码，不要当 base64。
- **MiniMax**：`t2a_v2` 的 `data.audio` 是十六进制；语音字数区间见 `tts.minChars/maxChars`。
- **VGENV 参考图**：非上传素材要转 dataURL（`reference_image` 模板 `image_url:{url}` 只收平台能取到的地址）。
- **幂等与重试**：没有幂等键的 POST 一律不自动重试；`PROMPT_COMPILER_UPSTREAM_ERROR` 表示任务未创建、
  未扣费，可安全重试（`Api.isRetryableCreateError`）。
- **缩略图缓存键**：带签名参数的地址必须先剥签名（`Api.mediaKey`），否则永远命不中。
- **转发闸**：按 `keyId || id` 归并；排满当场 429、只重试 GET、名额恰好归还一次。
- **文件大小/余量**：`whyNoSpace` 六个落点；量不到余量一律放行。

## 16. 常用命令

```bash
npm install                 # 开发依赖（仅模板编译器 + 视觉指纹）
npm run build               # 模板 → web/render/*.js
npm run build:check         # 校验模板与生成物一致
node tests/all.cjs          # 常驻测试
node tests/all.cjs --e2e    # 全量（含视觉回归、性能、parity 与浏览器）
powershell -NoProfile -ExecutionPolicy Bypass -File launcher.ps1 -SelfTest
set WB_LAUNCHER_DRYRUN=1 && 启动.bat
```

## 17. 已决定的架构取舍

以下是**当前有效的决定**，不是待办；改之前先确认能否同时守住行为与热路径预算：

- **导演台编辑器内部保持命令式**：候选条、轨道、切片、播放与拖动不走 Vue 组件化。
  `DirectorView` 是 Vue 页面壳；内部按域拆成纯模块（segments / timeline / voice-layout /
  playback / plan / projection / slice / board / split-assets / media / subtitles / fcpxml）。
  原因：这些 DOM 节点被缓存、拖拽、切片帧、插针与撤销逻辑大量引用；改成 Vue 组件会改变
  节点身份与更新时机，直接破坏“切页不丢状态 / 不重解码 / 拖动中途不重建”这些既有判据。
  方案 §9 也明确不重写剪辑交互与预览引擎。因此 `engine.js` 仍是大文件，
  “单文件 < 3k”不适用于它；新增能力继续往纯模块里放。
- **DOM 代理保留**：`web/director/index.js` 的 document / window 代理是作用域岛边界，
  保证导演台的弹层、拖拽示意与键盘监听不挂到别的常驻页面；去掉它是行为回退。
- **镜像队列仍在 AssetLocal 的现有队列**：不再引入第二套 `MirrorQueue`；同一份去重 / 退避 /
  持久化逻辑只保留一处。队列索引在 IndexedDB（`Kv.at('mirror')`），`sk_local_pending`
  只是跨刷新待办的暖缓存。
- **会话历史仍存 localStorage**：`ai_chat` 要跟 `DataSync` / 云同步一起走；迁 IndexedDB
  会让对话记录从整包备份与云端消失，收益不抵损失。
- **撤销仍是项目快照栈**：导演台 `undoStack` 存 JSON 快照，足够覆盖当前编辑粒度；
  改成命令日志是独立的协作/历史功能，不与本轮 UI 收口混做。

