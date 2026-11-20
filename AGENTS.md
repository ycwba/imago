# AGENTS.md —— 硬约束与结构

> 唯一约定清单。只写：必须遵守什么、唯一实现在哪、怎么验证。
> 产品说明见 `README.md`，版本与批次见 `CHANGELOG.md`。与代码冲突时以代码为准，并同步本文件。

## 工作方式

- **大任务先立项**：跨多文件 / 多批次的改造，动工前在 `docs/` 新建 `实施-YYYY-MM-DD-<主题>-进行中.md`（名称末尾加「进行中」），写明目标、范围、步骤计划、验收命令。
- **计划四态**：计划项标 `[ ]` 未开始 / `[~]` 进行中 / `[⏸]` 停手中 / `[✓]` 已完成。**动工任何一项的第一步永远是先把该项标成 `[~]`**——先改状态、再做事情，顺序不许反；不标 `[~]` 就写码一律算违规。做完立刻改成 `[✓]`；中途停手（等验证 / 等确认 / 换批次）改成 `[⏸]` 并注明在等什么，回来动工时改回 `[~]`；停手不许退回 `[ ]`。
- **边做边记（每个小任务都要立刻回写，不许攒到批次末尾）**：**每完成一个小任务（一个 plan 勾选框、一处改动 + 一次验证），当场就回写实施文档**——把对应项从 `[~]` 改成 `[✓]`，并在「完成记录」追加一条。记录里写清：时间 `YYYY-MM-DD HH:MM`（精确到分钟）、做了什么、跑了什么验证、结果、遗留。绝不允许「代码全做完 / 全批提交前才集中补状态」——那样文档中途一直停在旧状态，与实现脱节，正是要禁止的。任务结束前文档必须与最终实现一致，计划项不得遗留 `[~]` 或 `[⏸]`。
- **完成即改名**：任务收尾时把实施文档改名为 `实施-YYYY-MM-DD-<主题>-已完成.md`（名称末尾加「已完成」），再随该批次提交。
- 小改动（单文件、一两处）不必立文档。
- 一个批次一次提交；提交前跑 `npm run check` + `npm run test`。

## 项目定位

- 本地优先的 AI 创作工作台：Vue 3 SPA + 本地 Node 代理（`proxy.js` → `server/app.js`，默认 `http://localhost:5175`）。
- 页面只与同源地址通信；平台密钥只保存在代理侧；数据默认留本机。
- 业务数据只有两份文件：`.data/state.json`（设置、密钥、云同步状态、ASR / 搜索 / Skill 状态）与 `.data/backup.json`（最多 5 份带 sha256 的快照）。
- 另有本机资产账 `.data/local-assets/`、模型缓存 `.data/models/`、用户 Skill `.skills/`。
- 用户产物落在库根 `下载\成像\`：`图片/` `视频/` `音频/` `其他/`，提示词归档 `提示词/`。库根算法只有 `server/local-root.js`：`ASSETS_DIR` > `sk_local_dir` > `下载\成像`。
- 七个页面（侧栏 6 + 设置）：导演台、工作台、素材库、收藏、资产库、用量、设置。路由表只有 `web/core/routes.js`。

## 目录结构

```text
proxy.js                  薄入口：默认 UV_THREADPOOL_SIZE=8，require server/app.js
server/
  app.js                  组合根：配置、依赖装配、路由分发
  registry-config.js      供应商注册表 REGISTRY + 本机覆盖
  relay-gate.js           按平台的在途转发闸与退避重试
  local-root.js           库根（本体住在哪）的唯一算法
  local-assets-store.js   本机资产：落点 / 双身份 / 磁盘对账
  scan-worker.js          库根走树（worker 线程）：dirScan 的走树与 fid 算法唯一实现，主线程兜底共用
  file-safe.js            Node 侧文件名实现（与 web/ui/ui.js 同算法的登记例外）
  index-store.js          本机资产索引 journal（串行 update 队列）
  media-src.js            素材地址解析与下载
  user-dirs.js / open-dir.js / win-fg.js   用户目录、打开目录、前台锚定
  data-hub.js             唯一数据层：state.json / backup.json / 云同步 / 备份 / ASR / 搜索 / Skill
  channel-cred.js         识别 / 搜索两条通道共用取数件
  static.js               静态文件（ETag / brotli / gzip / CSP / warmStatic）
  security.js / outbound.js   同源、Cookie、出站护栏 / 出站 HTTP
  health.js / lock.js / zip.js
  providers/validate.js   供应商声明校验
  routes/                 system / static / capabilities / registry / relay / outbound / local-assets /
                          usage / cache / skills / fcpxml / pick-dir / asr / models / search /
                          http（唯一 JSON 回包口径 sendJson / fail）
shell.html                SPA 外壳（CSP、启动脚本、公共模块）
web/
  app.js                  Vue 外壳：hash 路由 + KeepAlive + 页面预取
  shell-boot.js           主题解析与「在外壳里」旗标
  boot-assistant.js       首屏后空闲加载助手
  core/                   routes / page-css / bridges / page-context / hooks / activity / actions / report
  pages/                  各页面；成块逻辑进 pages/<页>/<块>.js
  media-backend.js        浏览器内媒体后端（info / frame / thumbs）
  media-export.js         浏览器内离线导出（合成 / 混音 / 编码）
  director/               index + template.html + engine.js + engine/<域>.js + 纯算法模块 / worker
  render/                 预编译 render 函数（工具生成，不手改）
  ui/                     ui / forms / net / store / kv / toast / datasync / skills / workbench /
                          sidebar / badge-state / raw-request / asset-mention / index
  domain/                 api / assetlib / gen-forms / asset-transfer / export-dir / export-formats /
                          local / capabilities / text-ai / gen-rules / fav / prompt-log / asset-picker /
                          ai-find / chars / ident / asset-ref / identity / semantic / asr / search /
                          zip-read / chat/text-util / chat/contracts
  features/               chat.js（助手外壳）/ chat-tools.js（工具循环与动作目录）
  styles/                 tokens / ui / wb / sidebar / chat / spa-*.css
tools/                    precompile-vue / tokenize-css / token-lib / check-vars /
                          sync-skill-contracts / vue-templates/
skills/<id>/SKILL.md      内置 Skill
tests/                    常驻判据、单元、e2e、fixtures、数据基线
启动.bat / launcher.ps1 / 更新.bat / update.ps1
```

## 构建与运行时

### 零构建与预编译
- 运行时零构建：Vue 3.5.44 runtime-only，`shell.html` 原生 ESM 引 `web/app.js`，页面按需 `import()`。
- 模板源只在 `tools/vue-templates/*.html`；改模板跑 `npm run build`（模板 → `web/render/*.js` + Skill 契约副本）。
- `npm run build:check` 必须绿；生成物不手改。页面组件统一 `render: SomeRender`。
- vendored 依赖只有 `vue.runtime.esm-browser.prod.js`、`web/vendor/mediabunny*`、`web/vendor/asr/`；必须留在库里，不许被忽略。

### 严格 CSP
`shell.html` meta 与 `server/static.js` 响应头同发：

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';
font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'; worker-src 'self' blob:
```

- 不许 `eval` / `new Function`；脚本与事件处理器只从同源外部文件加载。
- `connect-src` 不含 `data:` / `blob:`：dataURL 一律就地解码（`TextAI._blob`），不许 fetch 它。

### 启动器
- `启动.bat` 只做环境检查并拉起 `launcher.ps1`；`更新.bat` → `update.ps1` 是仓库更新的唯一入口。
- `启动.bat` 的预解析按 `launcher.ps1` 内容哈希缓存；`launcher.ps1` 语法用 PowerShell Parser 检查（`node --check` 看不见）。
- `launcher.ps1` 内嵌 C# 按源码 SHA256 缓存 DLL；失败回退现编。
- 更新流程：fetch → 脏则 `stash push -u` → `pull --no-edit` → `stash pop`；**绝不** reset --hard / checkout . / clean -fd / stash drop。按需 `npm ci`，必跑 `npm run build`。
- 控制台主题 `.env` 的 `WB_THEME=system|day|night`；`启动.bat theme` 写回。

## 设计规范

### 令牌
- `web/styles/tokens.css` 是主题 / 间距 / 字号 / 圆角 / 描边宽 / 组件尺寸 / 阴影 / 动效令牌的唯一来源，其他样式只引用令牌。
- **令牌名 = 值**：`--sp-16` 是 16px、`--fs-13` 是 13px、`--radius-10` 是 10px、`--acc-tint-18` 是 18%、`--dur-180` 是 180ms。
- 每族终表：
  - 间距 8 档：2 / 4 / 8 / 12 / 16 / 24 / 32 / 64
  - 字号 9 档：11 / 12 / 13 / 14 / 16 / 20 / 24 / 42 / 54
  - 圆角 5 档：4 / 6 / 10 / 14 / 999
  - 阴影 6 档：1 / 2 / 3 / 4 / 5 / ctl
  - 控件高：`--sz-ctl-sm` 28 / `--sz-ctl` 32 / `--sz-ctl-lg` 36 / `--sz-chip` 24 / `--sz-head` 56
  - 组件尺寸角色名：`--sz-ico` / `--sz-tile` / `--sz-thumb-h` / `--sz-card` / `--sz-scroll`
  - 时长 5 档：120 / 180 / 280 / 800 / 1200
  - 断点 5 档：520 / 760 / 900 / 1100 / 1200
- 裸值由 `tools/tokenize-css.cjs` 吸附到终档；档名只认终表（G18 + check-vars）。
- 令牌直接写 `var(--x)`，不写兜底值；`calc()` 里必须写 `var(--x)`（负数写 `calc(-1 * var(--sp-4))`）。
- 透明度只取 `--a-4` … `--a-90` 的 21 档阶梯；0% 写 `transparent`（G21）。
- 颜色分两层：主题色段只有别名（`--bg: var(--bg-base)`），浅色真值只写一次，深色档由基色现算。
  加主题色 = 别名 + 基色 + 深色推导三处；深色档写 `oklch(from var(--x-base) <L> c h)`，只换亮度（G19）。
- 强调色四种画法：选中 / 在用 = `--acc` 压 `--sel-bg`；软底 = `--acc` 压 `--acc-tint-10`；
  描边 / 焦点 = `--acc-line-32` / `--focus-shadow`；实心：压在图片 / 视频上的用 `--pri` + `--on-acc`，
  压在语义实底上的字墨用 `--panel`。
- 状态淡底只有 `--ok-tint` / `--warn-tint` / `--err-tint` 三枚，且必须不透明。
- 配色块只覆盖 `--acc-base` / `--acc2-base` / `--pri-base`；`violet` 是基色，缺省 `ocean`。
- 固定色只用于品牌砖、媒体底与图表；导演台用主题语义色，没有独立深底配色一族；只保留 `--mark-*` 四枚标记色（浅深两档成对覆盖）。
- 页面品牌差异只在该页根类下覆盖一个变量，并写明理由。

### 主题
- 两根轴：`html[data-theme]` 只放 `light` / `dark`；`html[data-palette]` 放配色名。
- 解析只有 `web/shell-boot.js` 的 `window.__themeApply`（含跟随系统）；直接写 `dataset.theme` 会绕过它。
- 日夜三档（浅色 / 深色 / 跟随系统）只有设置页「外观与界面」与左下角那颗主题按钮两处入口，写的是同一个键 `dir_theme`；左下角那颗点一下换一档（浅色 → 深色 → 跟随系统），当前档由 `__sbThemePaint` 画成图标与名字。
- `tokens.css` 同时按两轴声明 `color-scheme`。

### 布局
- 页面外壳只有三种：`.page-shell`（素材库 / 资产库 / 收藏 / 用量 / 设置）、`.wb`（工作台）、`.sidebar`（全站外壳）。
- 页头只有 `.phead`：四槽 `A 身份 / B 上下文 / C 说明 / D 动作`，按需留空、位置不挪；定高 `--sz-head`（56px），窄窗（≤760）换行才长高。
- 页头硬规矩：页面名只说一次；筛选与视图切换不进页头；标题只放文字；标题左缘 = 内容列左缘。
- 内容列离内容区左缘一律 32px（`--shell-px`），760 以下收到 16px；页头分隔线的起止 = 内容列起止。
- 页面根恒用 `--bg` 平色；主体与页头铺满内容区，不限宽、不居中。
- 工作台左栏 = `.wb-body`（滚）+ `.wb-dock`（钉底：估价 / 生成 / 状态）；谁在滚用 `Wb.viewport.host(el)` 现问；原始请求归正文。
- 素材库与工作台整屏不滚；导演台整页不滚；设置页左目录轨（272px，`--setrail-w`）与右 15 卡文档各滚各的，滚动只走 `scrollToEl`。
- 卡片列宽只有 `--sz-card`（268px）与 `--sz-card-sm`（200px）；竖排卡等高由网格 stretch 得到，不钉动作区行数。
- 翻页行：普通页在页底；工作台并在右栏结果区上方，与搜索同一排。
- 页面根元素统一 `class="page-main <id>-page <外壳类>"`；页面差异只在 `web/styles/spa-<id>.css` 且挂在该页根类下。
- 断点：媒体查询不能引用变量，**当前登记的 5 档：520 / 760 / 900 / 1100 / 1200**；改档位同步 `tests/support.cjs` 的 `BREAKPOINTS` 与本行（G22 / doc-contract）。

### 组件
- 同一个功能只有一份实现；新块先查「公共层唯一实现清单」。
- 普通控件表面保持浅色；用底色层级与 `--shadow-ctl` 区分；选中态用浅强调底 + 强调文字；品牌砖与侧栏当前项是实心例外。
- 形状：控件 `--radius-6` + `--sz-ctl` 家族；容器 `--radius-10`；大卡 / 弹窗 `--radius-14`；胶囊 `--radius-999`；页头不画圆角；方正内件 `--radius-4`。
- 一行混排控件统一取 `--sz-ctl` / `--fs-13`；`--sz-ctl-sm` 只给整行都小的行；`--sz-ctl-lg` 只给单独强调的主控件。
- 公共类（页面在自己的根类下覆盖差异）：
  - 页头：`.phead` `.phead-id` `.phead-meta` `.phead-sub` `.phead-acts` `.phead-chip`
  - 卡片：`.card` `.card-surface` `.task` `.ap-item` `.plate` `.exp` `.why` `.exp-acts` `.band`
  - 按钮：`.pri` `.ghost` `.tool` `.ui-linkbtn`
  - 分段 / 芯片：`.ui-seg` `.chip`
  - 徽标 / 提示：`.ui-tag` `.ui-note` `.list-note` `.srcbadge`
  - 表单：`.pgroup` `.dd` `.dd-list` `.dd-btn` `.search` `.ui-inp` `.ui-in` `.pinl` `.split-opts`
  - 空态 / 加载：`.empty` `.ui-wait`
  - 工具条 / 视图 / 分页：`.toolbar` `.viewtoggle` `.pager-row` `.pginfo`
  - 浮层：`.ui-vrow` `.ui-voice` `.ui-cands`
- 公共类只在公共样式表定义（G20）；页面补丁写 `.chars-page .card` 这种形式。
- 焦点环由 `ui.css` 末尾的 `:focus-visible` 全站兜底；输入族 `:focus` 时 `border-color: var(--acc)`。

### 交互
- 所有可交互元素必须覆盖 hover / focus-visible / active / disabled / busy。
- 程序性 focus 走 `window.focusQuiet(el)`；要让某处进视野另走 `scrollIntoView({ block: 'nearest' })`。
- 搜索三条出口：回车 / 失焦 = 普通搜索；清空 = 取消筛选；AI 搜索入口与输入框同壳。
- **加按钮五步**：
  1. 用 `<button type="button">`，外观只用公共类；图标用 `icon()` 或 `data-icon`。
  2. 会整片重画含滚动容器的区域 → 用 `Wb.viewport.keep(el, fn)` 包住；整栏换内容加 `opts.absolute`；故意的滚动写在 keep 返回之后。
  3. 就地展开 → `Wb.viewport.reveal(块, { pin: 行 })`。
  4. 续光标 → `focusQuiet(el)`。
  5. 站内跳页只走 `GoPage.go('xxx.html')`。

### 验证
| 尺子 | 管什么 | 命令 |
| --- | --- | --- |
| 体检 | 样式裸值 | `node tools/tokenize-css.cjs` |
| 引用完整性 | 未定义令牌 | `node tools/check-vars.cjs` |
| 静态判据 | G18 裸值 / G19 主题成对 / G20 公共类 / G21 透明度 / G22 断点 / G23 注释引用 / G24 滚动位 / G25 孤儿声明 | `node tests/static-guards.cjs` |
| 视觉回归 | 画面变化 | `node tests/e2e/ui-visual.cjs` |
| 一条命令 | 前三行 + 文档契约 | `npm run static` |

- 静态判据存量表只减不增；`GUARD_WRITE=1` 重打表时每条补原因。
- 视觉基线只在有意改版后更新：`UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs`；`UI_VISUAL_SAVE=1` 只留底。

## 文案
- 只写按钮自明之外的信息；说明句 ≤15 字；title 补充动作名之外的信息。
- 组件本身应该体现功能；文案只补组件表达不了的。
  硬约束 `tests/copy-guard.mjs`（npm run test）：已删句式（「这一档收：」「放哪一批素材
  就是哪一种请求」「换模式只改」「点这里」「点击选择」）与 `comboScopeNote` / `modeHead`
  标识符不回归、点按指引不进文案、磁贴数量不两头写死、磁贴渲染层字符串不写死大小、
  本条目不做防御性描述。
- 空状态用名词短语（「还没有产物」）。
- 加载中统一「加载中…」；错误提示写「原因 + 怎么办」。
- 同一能力同一词（取消收藏、重试、已选 N 项、型号）；同一句只维护一份。
- 喂给模型的提示词不是 UI 文案。

## 路由与安全边界

### 页面只与同源地址通信
- 外部请求只打同源相对路径：`/registry`、relay 前缀、`/custom/<id>/*`、`/asset/<id>`、`LOCAL_ONLY` 路由。
- 平台接口只走 `Api.request` / `Api.create` / `Api.createBody`；URL 只用 `prov.relay + prov.endpoints.*`。
- 媒体地址只用 `Api.mediaSrc()`；缩略图缓存键用 `Api.mediaKey()` / `Wb.thumbs.keyOf()`。
- 允许的非外部地址：同源相对路径、`data:`、`blob:`。

### 本机路由与会话
- `LOCAL_ONLY`：`/data` `/prompts` `/cloud` `/capabilities` `/skills` `/local-assets` `/assets-usage` `/pick-dir` `/env-status` `/sys-status` `/clear-cache` `/cache/*` `/fcpxml` `/models` `/getv` `/getfile` `/fetch` `/s3put` `/custom`。
- 会话 Cookie `wb_session`（HttpOnly + SameSite=Strict）跨重启不变，落在 `<数据目录>/.session`；本机路由除同源外还要求它。
- 新探针先 `GET /` 收 `Set-Cookie` 再打本机路由。
- relay 前缀与 `/asset/<id>` 只接受同源；同一段前缀只允许完全等价的声明共用（`server/providers/validate.js`）。

### 出站护栏
- 代理取字节前必须过 `guardOutboundUrl`（异步，含 DNS）或 `safeOutboundUrl`（同步字面量）：只放行公网 https。
- 代理链：`.env` 的 `PROXY_OFF=1` > 环境变量 > Windows 系统代理；CONNECT 隧道下本地 DNS 校验跳过，`198.18.0.0/15` 仍拦截。
- `/getfile` `/s3put` `/fetch` `/getv` 统一走 `takeOutboundUrl`；4xx/5xx 一律 no-store。

### 本机写盘
- 产物落点由服务端算：`POST /local-assets` 与 `/from-url` 只问 `server/local-assets-store.js` 的 `bodyDirOf` / `newBodyPlace`；请求体的 `dir` 不参与。
- `/from-url` 先按地址或名字的扩展名判类型：文档类（srt/vtt/ass/txt/json…）400 拒收。
- `POST /pick-dir` 必须异步 spawn；返回路径只在 `LOCAL_ONLY` 里。
- 写盘前问余量 `whyNoSpace`；量不到一律放行。

## 能力驱动与供应商
- 模型能力只来自 `Capabilities` / `REGISTRY`：`specs` / `modelsFor` / `blockedRoles` / `illegalPairs` / `inputTemplate` / `rule` / `combos` / `shapeState`。
- 张数、上限、默认值、选项由声明提供；平台没声明的不画、不发。
- 接口怪癖声明化：`pollVia` / `cancelMethod` / `noPromptField` / `idempotencyKey` / `topBools` / `shapeFields` / `template`。
- 文字 AI 三类输入按型号判：`ModelPrefs.mediaOf` > 账号级旧开关 > `/models` 字段 > 注册表 > 不支持。设置入口在账号卡 → 型号面板 → 「这个型号能收的输入」。
- 新平台只改 `server/registry-config.js` 的 `REGISTRY.providers`；结构变了 `REGISTRY.version` +1。
- 提示词素材引用语法由 provider 的 `refSyntax` 声明；资产存储由顶层 `REGISTRY.assetStore` 声明；型号数组字段由 `REGISTRY.modelList.fields` 声明。
- 自定义供应商：一张账号卡 + 一组能力（`sk_custom` 的 `caps[]`），六档平级；密钥存 `sk_key_<条目 id>`。
- 账号卡流归并按 `keyId`；型号偏好按 `<keyId>:<kind>` 分槽；余额取数只有 `sidebar.js` 的 `balRowOf` 一份。
- 识别 / 搜索是两档真能力：在线块住在声明了它的账号卡里；本机 / 浏览器内识别是常驻卡 `__local_asr__`。
- 转发闸按 `keyId || id`：`RELAY_MAX_INFLIGHT` / `RELAY_QUEUE_MAX` / `RELAY_RETRY_MAX` / `RELAY_WAIT_MAX_MS`。排满回 429 并写明「没有扣费」；退避重试只给 GET。
- 有 `cancel` 端点才有取消按钮；没有 `credits` 端点不显示余额但保留勾选框（压暗 + title）。
- 「＋ 添加能力」只给自定义账号；默认平台不再提供补档入口，旧数据已补的那一档仍显示、可撤。

## 数据与用户文件

### 提交边界与用户数据
进库的只有：源码与模板（`web/` `server/` `tools/vue-templates/`）、预编译产物（`web/render/`）、vendored 依赖（`web/vendor/`）、内置 Skill 与判据基线（`skills/` `tests/`）。

- `.env`、`.data/`、`.renders/`、`.skills/`、`node_modules/` 一律不进库。
- 库根指回项目内时，以下一律挡在提交之外：`成像/`（顶层）、`图片/`、`视频/`、`音频/`、`其他/`、`提示词/`，以及历史默认名 `.assets/`、`文件/`、`prompts/`。
- 凭据只认根级：`/*.pem` `/*.key` `/*.p12` `/*.pfx` `/.env`；`tests/fixtures/pki/` 里的自签证书必须留在库里。
- 编辑器与系统垃圾不进库：`.vscode/` `.idea/` `*.swp` `*~` `*.orig` `*.rej` `*.bak` `.DS_Store` `Thumbs.db` `desktop.ini`。
- 仓库根不许散落媒体与归档（`/*.mp4` `/*.png` `/*.zip` 这一族）；交付物只落库根或 `.renders/`。
- 被 `.gitignore` 挡着的文件不许还在库里；`web/vendor/` 不许被忽略。
- 用户的工作区、历史、归档、素材是用户数据，清理前先确认是测试残留。
- 判据：`tests/git-scope.cjs`。

### 写入可靠性
- 覆盖 / 删除 / 云端拉取 / 恢复前，`server/data-hub.js` 统一向 `.data/backup.json` 留快照（最多 5 份、带 sha256、同内容不留）。
- `state.json` 的 `checksum` 覆盖全部键；对不上判 degraded，**拒绝任何写入**，由 `/backup/status` 报给设置页。
- 任务号一落盘就等于已付的钱：拿到 `taskId` 就写盘；删 / 放弃前先看是否还在跑。
- 异步长任务只碰自己那一份（`const mine = …`）。
- 关标签前注册 flush / dirty：`window.__spaRegister(flush, dirty)`；导演台另写同步救生包。
- 装配完成之后才落盘：两份落盘先问 `wsLoaded`。

### 本机资产身份
- 「同一份产物」只有 `web/domain/local.js` 的 `rowOfEntry` 一处：产物号优先，其次任务号且整条只出一份，再次本机号与来源地址（剥签名）。
- 双身份：`fid` = `<dev>:<ino>`（bigint）+ 采样签名 `sig` = `<字节数>:<头尾各 1MB 的 sha1 前 16 位>`。
- 落盘名带可移植尾标 `<规范名>__la_xxx.<ext>`：账丢了 / 换机器按名认回同一枚 `la_` 号。
- 落字节前先 `adoptBodyByHint` 认盘（`from-url` 按规范名 + 字节数 + 尾标，base64 按 `sampleSigOfBuffer`）；认准只补索引、零写入。项目文件导入走 `POST /local-assets/rebind` 批量重绑；同来源账行在但文件没了时重下并沿用原号。
- 三级认回：相对路径 → `fid` → `sig`；认一次落一次；全落空才报「文件不在了」。
- 磁盘对账共用 `dirScan`（30 秒 TTL）；只扫当前库根，跳过 `提示词/` `FCPXML工程/` `.trash/`；盘上有账里没有的由 `localAdopt` 补建一次；同内容并成一条账（`altPaths`）。
- 重复下载并成一张卡：按同一上游产物号或同一 `sig`；删一张卡 = 收掉背后每条账与每份字节。
- 云端说成功却没有产物地址：宽限期 30 分钟内按「生成中」，过期判 `expired`；本机有唯一一份视频时当场当本机资产。
- 自动镜像由 `wb:asset-done` 触发；字节经 `POST /local-assets/from-url` 流式落盘。导演台候选 / 关键帧是 `mustSave`，不看 `sk_media_local`；历史补扫不带 `mustSave`。
- 浏览器只留当前会话别名表；账以代理为准（`/local-assets/aliases` / `/local-assets/locate`）。
- 云端取不到时由代理按 `localUpKey` / 平台产物号退回本机那一份（`/getv` `/fetch` `/asset`）。
- 「已丢失」角标按图自己的盒子定位；媒体槽必须 `position: relative`。

### 云同步
- WebDAV 三格：设置页 > `.env` 的 `CLOUD_WEBDAV_*` > 地址的内置默认（`CLOUD_DEFAULT_URL`，只在 `data-hub.js`）。
- 设置页不预填默认地址（预填会压掉 `.env`），只把它当 placeholder。
- `/cloud/sync` / `/cloud/resolve`；备份走 `/backup/*`。
- 冲突判定靠 `__cloud_baseline`，不看时间；远端读不下来判 `error` 跳过、不 push。

### Git 提交
- 一个批次一次提交 = 一个主题；不相干改动不混。
- 提交前必跑 `npm run check` + `npm run test`（浏览器 e2e 不是前置）。
- 主题一行 + 空行 + 要点列表；批次代号沿用既有字母族，不新造。
- UTF-8 无 BOM；行尾由 `.gitattributes` 定。
- 新增超过 1 MB 的非 vendored 文件先想清楚。

### Git 远端与推送
- 远端唯一：`https://github.com/ycwba/imago.git`；命令按跟踪关系写（`main` 跟踪谁就裸 `git push` / `git pull`）。
- `archive/snapshot-gh` 是无共同祖先的孤儿快照，别合、别当基线。
- 推完核对：`git ls-remote origin refs/heads/main` 与 `git rev-parse HEAD` 一致。
- TLS 握手失败多半是本机代理链：可临时 `git -c http.proxy= -c https.proxy= push`，别改仓库配置。

## 公共层：唯一实现清单

| 能力 | 唯一实现 |
| --- | --- |
| 下拉 / 浮层 | `web/ui/ui.js` 的 `Dropdowns` |
| 网络 | `web/ui/net.js` 的 `Net` |
| 本地存储 / IndexedDB | `Store` / `Kv.at(登记名)` |
| 提示 / 弹窗 / 确认 | `Toast` / `UiDialog` / `Confirm.ask` / `Confirm.arm` / `Confirm.choose` |
| 分段 / 芯片 | `ui-seg` / `Chips.render` / `AiChip.paint` |
| AI 挑几条 / 润色 / 提示词表单 | `AiFind.run` / `InlinePolish` / `PromptForm` |
| 提示词 @素材 | `createAssetMention` / `insertToken` / `mentionAt` / `libraryPicChoices` / `libraryTokenOf` / `libraryRefSrcOf` |
| 拆分片段选项 | `SplitPlan` |
| AI 动作按钮外壳 | `aiBtnHTML` / `aiBtnState`（名字在 `InlinePolish` / `AiFind` 各自家族） |
| 页面尺寸 / 跳页 | `pageModeOf` / `pageSizeOf` / `PAGE_TARGETS`；`GoPage.go` |
| 样式表挂载 / 预取 | `ensureCss` / `preloadModule` |
| 侧栏路由表 | `WB_ROUTES.pages` |
| 可拖动分栏 | `Wb.split.enable` |
| 批量下载 / 多选 | `Wb.downloadList` / `Wb.multi` |
| 媒体地址 | `Api.mediaSrc` / `mediaKey` / `mediaExpired` / `healMedia` |
| 接口取数 | `Api`（`request` / `create` / `createBody` / `pollTask` / `list` / 余额） |
| 资产 | `AssetLib` / `AssetLocal` / `AssetTransfer` / `AssetPicker` |
| 多选点选 | `PickSel` |
| 本机 / 云端徽标 | `badgeOf` / `badgeHTML` + `AssetLocal.stateOf` |
| 素材身份 | `web/domain/ident.cjs` 的 `upKeyOf` / `innerMedia` |
| 拖素材载荷 | `web/domain/asset-ref.cjs` 的 `set` / `read` / `isRef` / `label` |
| 任务 / 卡片 / 分页 | `Wb.poller` / `History` / `detail` / `cards` / `pager` / `viewToggle` |
| 卡片展开 / 锚定 | `Wb.expand` / `close` / `closeAll` / `anchor` |
| 缩略图 / 灯箱 / 下载 | `Wb.thumbs` / `Wb.lightbox` / `Wb.save` |
| 媒体取帧 / 浏览器导出 | `MediaBackend` / `MediaExport` |
| 导出目录 | `ExportDir` |
| 成片模型 / 时间线纯件 | `web/director/film.js`；`tl-cut` / `tl-resize` / `tl-ripple` / `tl-reorder` / `tl-snap` / `tl-scale` / `tl-peaks` / `tl-markers` / `tl-autoscroll` |
| 胶片条与取帧 | `tl-filmstrip.js` / `slice.js` / `engine/frames.js` |
| 切片打包 | `slice-pack.js` + `slice-worker.js` |
| 拆分镜 / 请求预览 / 候选地址 | `board.js` / `split-assets.js` / `board-preview.js` / `media.js` / `util.js` |
| FCPXML / 项目文件 | `fcpxml.js` / `project-pack.js` |
| 浏览器内 ASR | `asr-worker.js` + `asr-text.js` |
| 用户目录 / 库根 | `server/user-dirs.js` / `server/local-root.js` |
| 盘对账走树 / fid | `server/scan-worker.js`（worker 线程与主线程兜底共用同一枚） |
| 本机资产落点 / 身份 | `server/local-assets-store.js` |
| 本机产物镜像 | `web/domain/local.js` 的 `wantSave` / `offer` / `pullPlan` |
| 缩略图 / 切片缓存 | `/cache/{thumbs,slices}` |
| 能力声明 | `Capabilities` |
| ASR 路线 / 文案 | `pickRoute` / `stageText` / `routeLabel` |
| ASR 模型代下载 | `server/routes/models.js` |
| 文字 AI | `TextAI` |
| 文字型号输入能力 | `ModelPrefs.mediaOf` / `setMedia` |
| 提示词归档 / 收藏 | `PromptLog` / `Fav` + `Wb.favBtnHTML` / `bindFavBtn` / `favEntryOf` |
| 素材库 | `Chars`（`Lib` / `Pipe` / `SET`） |
| 语义检索 | `SemanticSearch.rank` |
| 导演台台词 / 导出格式 | `film.js` 的 `speakerOf` / `lineTimeOf` / `lineRowHTML`；`export-formats.js` |
| 字幕 / 剧本 / 候选语义 | `srt.js` / `script.js` / `takes.js` |
| 拆分镜文案闸门 / 接续调度 | `split-form.js` / `chain.js` |
| 场景镜头命名 / 项目组 / 拆分素材 | `naming.js` / `groups.js` / `board-assets.js` |
| 一镜素材编号 | `ref-plan.js` 的 `shotRefPlanOf` / `tokenizeRefPrompt` / `applyProviderRefSyntax` |
| 请求预览 / 原始请求 | `Api.buildBody` / `Api.preview`；`RawRequest` |
| 模板变量 / 导演台填料 | `window.TplVars` / `board-vars.js` |
| Skill / 场景 | `WbSkills` / `SKILL_SCENES` / `SKILL_SCENE_GROUPS` |
| 设置页目录轨 / 账号卡流 | `settings.js` 的 `groupEls` / `cardsOf` / `navTitleOf`；`settings/accounts.js` |
| 中文名 / 文件类型 | `provKindZh` / `mediaKindOf` / `fileExtOf` / `mediaKindTabs` |
| 字数闸 / 配音设置 | `CharLimits` / `TtsAdv` / `AdvExtras` |
| 音色说明 / 克隆 / 写回 | `VoiceNote.run` / `runClone`；`Chars.Pipe.saveVoiceNote` / `cloneFromCands` / `cloneFromLibEntry` |
| 格式化 / 文件名 / 设置项 | `Wb.fmtSec` 一族 / `fileSafe`（浏览器与 Node 各一份，登记例外）/ `UI_PREFS` |
| 主题解析 / 侧栏主题档 | `__themeApply` / `__sbThemePaint` |
| 余额取数 / 生成规则 | `balRowOf` + `SbBalance` / `GenRules` |
| 客户端错误 | `PageReport` |
| 视口滚动位 / 页头几何 | `Wb.viewport` / `Wb.pageHead` |
| 程序性 focus | `window.focusQuiet` |
| 文件类型筛选 / 筛选工具条 | `Wb.kindFilter` / `Wb.filterBar` |
| 业务数据 / 原子写 / 索引写入口 | `server/data-hub.js` / `atomicWrite` 一族 / `server/index-store.js` |
| 素材身份键 | `AssetLib.entryKey` / `Wb.taskKey` |
| 整包备份 | `PACK_VERSION` / `assertPack` / `describePack` |
| 命令面板 | `window.CommandPalette` |

## Vue SPA
- `web/app.js` 是唯一外壳：hash 路由 + `<KeepAlive>` 页面池；切页只离屏、不销毁。
- `WB_ROUTES` 是唯一路由表：页面文件 / id / 侧栏名 / 图标 / `src` / `css` / `root` / `needs` / `chunk` / `nav` / 别名。新增页面只改这一处。
- 每页加载链只在 `app.js` loader 拼一次：`preloadModule` + `chunk` 先发，`needs` 与 `import(src)` 并行。
- 预取：`window.__spaPrefetch(file)`；`load` 后按 250ms 一页（当前页除外）+ 侧栏 hover / focus。
- 切页可见性走 `spa:page` / `window.__spaActivity.visible()`。
- `window.__*` 是跨脚本唯一钩子面；页面自己挂的钩子在卸载时清掉（G8）。
- 助手读当前页快照走 `page-context.js` 的 `__acPageCtx`。

## 导演台

### 边界
- `index.js`（Vue 壳 + 作用域岛）、`template.html`（真实 DOM 模板 + 内嵌 `<style>`）、`engine.js`（命令式热路径）。
- 模板内嵌样式由 `style-scope.js` 的 `scopeCss` 加 `:where(.director-page)` 前缀后注入；取值走令牌。
- 页头同样走 `.phead` 四槽；整页不滚；横向留白取 `--shell-px`。
- engine 按域拆到 `web/director/engine/*.js`：`gen` / `shots` / `frames` / `timeline` / `strip` / `edit` / `play` / `caption` / `voice` / `render` / `mid` / `panel` / `script` / `split` / `apply` / `estimate` / `api` / `import` / `ref` / `media` / `export` / `shell` / `toolbar` / `projectfile` / `exportwire` / `sanitize` / `boot` / `bridge`。
- engine 新增依赖名必须与模块顶部解构逐名对齐（`tests/director-e-deps.cjs`）。
- 纯算法按域拆模块；engine 只调用。改算法先改模块。

### 时间线
- 数据真相只有 `proj.film`：顺序 clips（总长 = Σ duration）、定时配音、成片秒字幕、成片秒标记、行列眼睛与锁。
- 成片秒与源秒的折算只走 `film.js` 的 `rateOf` / `srcHeadOf` / `srcUsedOf` / `srcLenOf`。
- 台词只有 `sh.line` / `sh.lineWho` 一份。
- 写 film 只有 `engine/edit.js` 的 `commit` / `patchFilm`（都经 `beginEdit` 压快照）。
- 撤销 = 只追加日志 + 当前指针；上限 30 条 / 24 MB。
- 转场挂在连接点 `clip.transition`；窗 = `[末 − dur, 末)`，`dur ≤ min(2 秒, 两段各一半)`；预览与导出同一道夹算。
- 主画面只有一轨；轨道水平跨度只有 `navSpanOf` 一处（= `tlNavTotal(成片 + 尾垫)`）。
- 工具条动作全走 `Edit.toolAction`；拖播放头针跟手、画面 ~40ms 一档追、松手精确 seek。
- 轨道坞下限 48px；`.tl-board[data-split-fixed]` 必须 `min-height: 0`。
- 候选条展开只换行，卡片尺寸不变；触控板横滑 = 横向滚动，Ctrl + wheel 才缩放。
- 吸附点与阈值只有 `tl-snap.js`（`TL_SNAP_PX`）；波纹只有 `tl-ripple.js`；标记四类五色只有 `tl-markers.js`。
- 取帧分两层：数据层 `slice.js`，显示层 `tl-filmstrip.js`；退避与缓存 `engine/frames.js`。
- 播放不渲染；导出才逐帧合成；预览遵守 `sk_media_prefer`，导出始终本机优先。
- 导出组表只有 `buildRenderPlan()` 一份；三档 XML 共用 `buildFCPXML`；字幕样式默认常量只在 `fcpxml.js`。
- 片段之间可留空（`clip.gap`），空里 `rowAtTime` 为 `null`；黑场只有「删掉」（`off`）一种。

### 候选与描述
- 「画面」层已退役：一镜 = 一组候选；配置与描述都在候选上，`cfg(x)` 读配置，镜头只留身份。
- ＋候选 = 克隆当前那条；「生成全部分镜」就地更新已有待生成候选，不够才补建克隆（`takeBatchOf`）。
- 接续链按候选：`linkPrev` 在候选上；上一镜尾帧取参考候选（`tailCandOf`）。
- 剧本视图按分镜现算，候选各一行；旧工程由 `sanitizeTakes` 一次性转形状。

### 助手写入桥
- 唯一写入桥 `WBBridge.director`（`engine/bridge.js`）：`check` 纯读 + 记身份，`run` 按同一参数重解析；对不上当场拒。
- 只有导演台在前台可用；op 只有 `select` / `cut` / `set` / `undo`。
- 写入前由 `Edit.openUndoWindow` 压快照，收尾统一重画；批量 `timeline_apply` 每条 op 各占一个撤销条目。

## AI 助手与 Skill
- UI 外壳 `features/chat.js`；工具循环与动作目录 `features/chat-tools.js`（`TOOLS` / `ACTS` / `TOOL_INPUT` / `ACTION_META`），经 `window.AiChatTools.build(C)` 取共享函数。
- 联网搜索是 `TextAI` 的工具循环，不是预注入；结果只回灌模型，不画来源卡片。
- 所有文字 AI 调用默认带工具；纯协议调用（反问 JSON / 看图说明 / 起标题 / 设置探针）传 `noTools: true`。
- 正文生成一律流式；短 JSON 判定与后台步骤可一次性。
- 润色每一轮都重新准备随附素材（图片缩到 1024，音视频按 `prepareMedia` 能力闸）。
- 助手抽屉浮窗贴球；拖标题栏挪球；`ai_chat_w` / `ai_chat_h` / `ai_chat_dock` 记本机。
- 拖素材到球 = 引用：载荷只经 `AssetRef`，队列 `ai_chat_refs` 上限 20。
- 只读工具 `task_detail`。
- 写动作只经 `ActionRegistry`；`inject` 不提供；内容写动作必须有 `undo` 或显式 `irreversible`；花钱动作声明 `cancel`。
- Skill：`skills/<id>/SKILL.md`，按页面 + 触发词自动加载（最多 2 个）；内置正文退回副本由 `sync-skill-contracts` 生成，别手抄。
- 项目引用规则 = `{cast}` `{what}` `{board}` `{assets}` `{dur}` 等占位符，由 `TplVars.fill` 填；`@素材` 是另一件事。
- 「素材范围优先」读 `WbSkills.refRule`。
- contract 白名单在 `server/data-hub.js` 的 `CONTRACTS`，页面侧 `TextAI.SKILL_CONTRACT` 同步。
- 占同一 contract 的 Skill 恰好一份启用（服务端硬约束）；停最后一份被拒；卸载自动顶回内置。
- 设置页 Skill 卡一级菜单 = 使用场景；新建 / 编辑 Skill 在浏览器里做。
- 查询结果按 `estimateTokens` 预算；发出前 `redactSecrets`。
- 助手可改的设置只有 `UI_PREFS.assistSpecs()` + `assistDynamic` 门控；`sk_key_*` / `sk_base_*` 硬拒绝。

## 素材库、资产库、工作台
- 素材库身份锚点只有 `newChar/newScene/newProp` 的 `anchor` 与 `Chars.refPicOf`。
- 默认值归设置页：`Chars.SET` 的 `imgModel` / `ttsModel` / `candN` / `voiceN`；现场选择按次、不落本机。
- 型号清单后到：页面自己拉能力并监听 `wb:cap-ready` 补画。
- 工作台三类型共用一页（`?t=video|image|audio`）；型号与提示词分类型记住；历史三类型合并按 `assetId` 去重。
- 参考素材区整块接拖放，最后都进 `refIntoSlot`。
- `@素材` 与导演台同一份浮层；候选由页面按当前栏给。
- 「送进图像栏」/「送进视频栏」只在页面拼载荷，写入沿用既有落点；能力闸在 `setType('video')` 之后现读。
- 右栏 AI 搜索与素材库 / 收藏 / 资产库同一份 `AiFind.run`。
- 历史不按时间裁；筛子只有搜索、类型档与分页。
- 输入模式只有 `Capabilities.combos` 一份。
- 「存回本机」四颗只走 `AssetLocal.pullMany`；工作台 / 资产库 / 收藏存勾选，素材库存当前档整批。
- 「不显示云端任务」由 `AssetLocal.hideAsCloud` 控制；失败与在跑的不藏。
- 卡片徽标只有 `badge-state.js` 一份。
- 选择器来源档位只有 `AssetPicker.inView`。

### 侧栏
- 侧栏是外壳层经典脚本；两个形态：满 232px / 窄 56px；开关只有左上角品牌砖；消费方只读 `--sbw` / `--sbw-full`，不写像素。
- 窄形态导航项带两字短标签（`short`）；`aria-label` 用全名。
- 高度分配：`nav` 拿 `flex:1 + overflow-y:auto`，底部卡片钉死；矮窗（≤660px）压缩块。
- 余额卡全量、卡列表定高三张、滚动条藏掉；刷新 = 点「账户余额」抬头。
- 收起态 / 矮窗压缩块点开气泡；气泡在右边、开时刷一轮。
- 余额行两行（名字 + 金额 / 冻结 + 单位），每家一个状态点；本机产物行明细常驻、无开关。

## 服务端与路由
- `server/app.js` 是组合根；每个路由只在自己的 `server/routes/*.js` 里实现。
- 路由层 JSON 回包口径只有 `routes/http.js` 的 `sendJson` / `fail` / `noStore`（默认 no-store）。
- 静态资源只放行根级单文件与 `web/` 子树；HTML 带 CSP、nosniff、Referrer-Policy；文本响应 brotli > gzip > 原文，ETag 末位带表示名。
- brotli 在 listen 后预热（`warmStatic`，预算 4 秒、并发 4）；`proxy.js` 默认 `UV_THREADPOOL_SIZE=8`。
- `/data` 写入原子写 + `.bak`；清单不含 `.bak`。
- `/prompts` 写文件 + 索引；`/prompts/find` 按 id 返回全部归档。
- `/fcpxml/bundle` 只写 `RENDER_DIR/fcpxml-<stamp>/`；`/fcpxml/project` 写库根下 `FCPXML工程/<id>/`；两条出口只留最近 20 个自造目录；不启动外部软件。
- 转码与合成全在浏览器；代理只取数与落盘；`Api.exportCaps()` 现探能力。
- 浏览器内 ASR 模型只由代理代下载（`/models/`，`.part` 原子改名、单飞、出站护栏）。
- `route:'browser'` 只在页面 worker 里跑；`/asr/transcribe` 收到 browser 当场 400。
- 代理健康账四类；只报不自杀。
- stdout 断了就把这条路封掉（`writeLog`），日志照旧落盘。

## 测试与验证

### 分档
| 档 | 命令 | 场景 |
| --- | --- | --- |
| 秒级 | `npm run check` | 每次保存后 |
| 样式秒级 | `npm run static` | 动了样式 / 令牌后 |
| 迭代 | `npm run test:fast` | 日常改码后 |
| 合并 | `npm run test` | 批末 / 提交前 |
| 全量 | `npm run test:all` | 连浏览器冒烟（按需） |
| 剪辑核 | `npm run test:director` | 改剪辑核时 |
| 浏览器 | `npm run test:e2e` | 按需手动；不是提交前置 |
| 观察 | `npm run test:watch` | 连续改码时 |

- CI 只跑 `npm run ci`（= check + static + test）；浏览器 e2e 不进 CI。
- 产品版本唯一真相是 `package.json` 的 `version`；CHANGELOG 最新条目与 `/sys-status` 从它派生。
- 常驻判据清单只有 `tests/all.cjs` 的 `run()` 登记行；`tests/map.cjs` 按源码文本现读这些行。
- 单条 e2e 红先独立重跑再定性；满载池子有假红先例。

### 写入隔离
- 判据实例一律由 `tests/e2e/harness.cjs` 的 `startProxy` 现建临时目录（`imago-probe-*`），收尾整组删除。
- `startProxy` 默认给 `AUTOSAVE_DIR`；手动 spawn 必须自己给这枚，否则会写进用户真实库根。
- 手动探针用 `.data-probe` 一族（`.gitignore` 收着），跑完清理目录与孤儿进程。
- 会写共享目录或库根本体的判据进串行白名单。

### 数据基线
- `node tests/data-snapshot.cjs` 比对 `.data` / `.renders` / 库根与 `tests/data-baseline.json`。
- 基线只记标签与计数 / 聚合哈希，不记绝对路径。
- 迁移类改动后才 `DATA_SNAPSHOT_WRITE=1 … --write` 重打基线。

### 浏览器
- 只跑 headless；测试脚本自己起隔离代理与 Chrome；必须检查控制台错误。
- 启动 / 取 Cookie / 打开页面的唯一入口是 `tests/e2e/harness.cjs`。

## 编码与新增功能

### 编码与注释
- `.js/.mjs/.cjs/.html/.css/.md` UTF-8；`.bat` UTF-8 无 BOM + CRLF + chcp 65001；`.ps1` UTF-8 带 BOM + CRLF。
- 行尾由 `.gitattributes` 钉：文本 LF，`.ps1/.bat/.cmd` CRLF，二进制不换算。
- 注释只解释功能本身：不写文档引用 / 任务号 / 缺陷号 / 提交号（G23）。
- `web/package.json` 是 `{"type":"module"}`；Node 也要 require 的双模式件必须是 `.cjs`（`ident.cjs` / `asset-ref.cjs`）。
- 不可见分隔符写 `\u0001`；日志不打印密钥 / Cookie / 本机隐私。
- 命名和结构优先于注释。

### 新增页面
1. `web/pages/<id>.js` + `tools/vue-templates/<id>.html`，跑 `npm run build`。
2. `web/core/routes.js` 加一条；`page-context.js` 点名（助手快照）。
3. 私有样式 `web/styles/spa-<id>.css`，差异挂在该页根类下。
4. 接 `spa:page` 与 `__spaRegister`。

### 新增供应商 / 动作 / 格式
- 供应商：只改 `server/registry-config.js`；结构变了 `REGISTRY.version` +1。
- 助手动作：`ACTS` + `ACTION_META`（`effect` / `route` 必填；`undo` 有意不给 = 真退不掉）；`TOOL_INPUT` 补形状；执行外壳 `ActionRegistry`。
- 导入导出格式：导演台表 `web/domain/export-formats.js` 一行 + engine 一个 builder；纯拼装在 `web/director/*` 或 `web/domain/*`；缺失素材报数。
- 项目文件与导出四档分开：项目文件带全部候选与剪辑状态，视频字节不进包。

### 扩展边界
- 扩展只走四类落点：平台声明、页面、动作、Skill。
- 助手动作只经 `ActionRegistry`；页面池只有 hash 路由 + KeepAlive 一种。
- 被替换 / 撤销的实现连同旧键、旧字段、旧端点、旧路径、旧默认值一起删干净；只保留两处用户数据兼容（落盘搬迁工具、`LEGACY_KEYS` 清盘）。
- 注释与文档只写当前事实，不写变更史。

### 文件落点
| 功能类型 | 落点 | 必须一起改 |
| --- | --- | --- |
| 新页面 | `web/pages/<id>.js` + 模板源 + `spa-<id>.css` | 路由表 + `npm run build` |
| 共享 Vue 组件 | `web/ui/<name>.js` + `web/ui/index.js` | 样式只进 `ui.css` / `tokens.css` |
| 共享纯逻辑 | `web/domain/<domain>.js` | 只暴露最小方法 |
| 外壳 / 路由 / 生命周期 | `web/core/*.js` / `web/app.js` | 跨页桥走 `WBBridge` |
| 新服务端路由 | `server/routes/<name>.js` | app.js 装配 + `LOCAL_ONLY` + e2e |
| 新数据 / 存储 | `data-hub.js` 状态仓；独立账本才用 `index-store.js` | 原子重写 + sha256 + 快照 + 基线 |
| 新供应商 | `server/registry-config.js` | `validate.js` + 判据 |
| 新导演台纯算法 | `web/director/<domain>.js` | engine 只调用 + `tests/director-<domain>.mjs` |
| 新助手动作 | `chat-tools.js` 的 `ACTS` + `ACTION_META` | `TOOL_INPUT` + e2e |
| 新 Skill | `skills/<id>/SKILL.md` | frontmatter，内置正文与 `TextAI.DEF` 同源 |
| 新测试 | `tests/<name>.mjs|cjs`；浏览器 `tests/e2e/<name>.cjs` | 加到 `tests/all.cjs` |
| 新视觉基线 | `tests/fixtures/visual/` | 只允许 `UI_VISUAL_WRITE=1` 更新 |

- 文件名 kebab-case；经典脚本挂 `window.<Name>`，ESM 用 `export`；公共层只向下依赖。

## 已知平台事实
- VGENV：列表 / 详情不返回 `prompt`；上传 camelCase 拒未知字段；参考素材 `{asset_id}`；首尾帧 `frame_images` + `frame_type`；详情 404 空壳，`pollVia:'list'`。
- SparkCine：上传下划线字段 + `sha256` 必填；详情 `outputs[].asset_id`；创建要求 `Idempotency-Key`；润色是顶层 `optimize_prompt`。
- MiMo：文字与 TTS 共用 `MIMO_API_KEY`；`/v1/models` 同时列 TTS，文字档用 `modelsExclude:'-tts'`；TTS 同步、`hex` 返回按十六进制解码。
- MiniMax：`t2a_v2` 的 `data.audio` 是十六进制；字数区间见 `tts.minChars/maxChars`。
- 拾帧（shizhenvideo.com）：视频下单 `POST /web-api/jobs`（顶层 `duration_seconds`/`quality`/`aspect_ratio`），图片/音频 `POST /v1/jobs`（`tier:'A'`）；幂等键在**请求体** `idempotency_key`；素材 `/v1/uploads` 原始字节上传（文件名走 ASCII 头）；取产物 `/v1/jobs/{id}/result` 的 `pickup_url`（排队中 `ready:false` 无地址，只在 done 时换）；无任务列表接口，历史走本机资产库；报价 `estimated_cost_cny`（元）、余额 `balance_cny`；三档共用 `SHIZHEN_API_KEY`。
- 幂等：没有幂等键的 POST 不自动重试；`PROMPT_COMPILER_UPSTREAM_ERROR` 可安全重试。
- 缩略图缓存键先剥签名。

## 已决定的架构取舍
- 导演台编辑器内部保持命令式；`engine.js` 仍是最大文件，新能力往纯模块与 `engine/<域>.js` 放。
- `index.js` 的 document / window 代理保留（作用域岛边界）。
- 镜像队列只有 `AssetLocal` 现有队列；跨刷新待办 `sk_local_pending`；「哪条产物在本机」每次向代理别名表现问。
- 会话历史仍存 localStorage（要跟整包备份与云同步走）。
- 撤销仍是项目快照栈。
- 样式层靠四把尺子守：体检 / 引用完整性 / 静态判据 / 视觉回归；档位已收敛到终表。
