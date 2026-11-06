# AGENTS.md —— 项目结构、硬约束与开发规范

> 本文件是当前项目的**唯一约定清单**（2026-10-29 版）。改任何一处之前先读对应章节；
> 与代码冲突时以代码为准，并把本文件改到与代码一致。只写「必须遵守什么、唯一实现在哪、怎么验证」；
> 产品使用说明与功能索引见 `README.md`。

## 目录

- [项目定位](#项目定位)
- [目录结构](#目录结构)
- [构建与运行时](#构建与运行时)
  - [零构建与模板预编译](#零构建与模板预编译)
  - [严格 CSP](#严格-csp)
- [启动器](#启动器)
- [设计规范](#设计规范)
  - [令牌](#令牌)
  - [主题](#主题)
  - [布局](#布局)
  - [组件](#组件)
  - [交互](#交互)
  - [验证](#验证)
- [文案](#文案)
- [路由与安全边界](#路由与安全边界)
  - [页面不直连外部域名](#页面不直连外部域名)
  - [本机路由与会话](#本机路由与会话)
  - [出站护栏](#出站护栏)
  - [本机写盘](#本机写盘)
- [能力驱动与供应商](#能力驱动与供应商)
  - [能力声明](#能力声明)
  - [供应商](#供应商)
  - [转发闸](#转发闸)
- [数据与用户文件](#数据与用户文件)
  - [绝不提交、绝不擅自删](#绝不提交绝不擅自删)
  - [写入可靠性](#写入可靠性)
  - [本机资产身份](#本机资产身份)
  - [云同步](#云同步)
  - [Git 远端与推送](#git-远端与推送)
- [公共层：唯一实现清单](#公共层唯一实现清单)
- [Vue SPA](#vue-spa)
- [导演台](#导演台)
  - [边界](#边界)
  - [时间线](#时间线)
  - [助手写入桥](#助手写入桥)
- [AI 助手与 Skill](#ai-助手与-skill)
- [素材库、资产库、工作台](#素材库资产库工作台)
  - [侧栏](#侧栏)
- [服务端与路由](#服务端与路由)
- [测试与验证](#测试与验证)
  - [分档](#分档)
  - [写入隔离](#写入隔离)
  - [数据基线](#数据基线)
  - [浏览器](#浏览器)
- [编码与新增功能](#编码与新增功能)
  - [编码与注释](#编码与注释)
  - [新增页面](#新增页面)
  - [新增供应商](#新增供应商)
  - [新增助手动作](#新增助手动作)
  - [新增导入导出格式](#新增导入导出格式)
  - [明确禁止](#明确禁止)
  - [文件落点](#文件落点)
- [已知平台事实](#已知平台事实)
- [已决定的架构取舍](#已决定的架构取舍)

## 项目定位

本地优先的 AI 创作工作台：

- 纯前端 Vue 3 SPA + 一个本地 Node 代理（`proxy.js` → `server/app.js`，默认 `http://localhost:5175`）。
- 所有生成平台都经本地代理转发；页面不接触平台密钥，不直连任何外部域名。
- 数据默认留在本机：`.data/`（结构化数据、云同步基线、本机资产账 `.data/local-assets/`、模型缓存
  `.data/models/`）、`.skills/`（用户 Skill）；用户可见产物与归档在 `下载\成像\` 下按 `图片/` `视频/`
  `音频/` `其他/` 分，提示词归档在 `提示词/`。
- **一条产物只有一个本体**：落在 `<库根>\<类型>\<规范名>.<ext>`，账在 `.data/local-assets/`，与本体分家；
  库根只有一条算法（`server/local-root.js`）：`ASSETS_DIR` > `.data/sk_local_dir.json` > `下载\成像`。
- `.renders/` 只剩 FCPXML 媒体包的临时落盘（`fcpxml-<stamp>/`）；持久工程目录在本机资产库下的 `FCPXML工程/<id>/`，与「存回本机」的素材同根。浏览器内合成成片，服务端没有 ffmpeg。
- 七个页面：导演台、素材库、工作台（视频 / 图像 / 语音）、收藏、资产库、用量、设置（设置不进侧栏）。
  路由表只有 `web/core/routes.js` 一份。

## 目录结构

```text
.
├─ proxy.js                     薄入口：先给 UV_THREADPOOL_SIZE 一个默认值（未设置时 8），只 require server/app.js
├─ server/
│  ├─ app.js                    组合根：配置、依赖装配、路由分发、上传 / 出站工具（约 1.3k 行）
│  ├─ registry-config.js        供应商注册表 REGISTRY + 本机覆盖（型号清单偏好）
│  ├─ relay-gate.js             按平台的在途转发闸与退避重试
│  ├─ local-assets-store.js     本机资产：落点 / 双身份（fid + 采样签名）/ 磁盘对账 / 账口径
│  ├─ local-root.js             库根「本体住在哪」的唯一算法
│  ├─ file-safe.js              文件名片段的 Node 侧那一份（与 web/ui/ui.js 同算法，登记在案的例外）
│  ├─ index-store.js            本机资产索引 journal（快照 + 追加日志 + update(fn) 串行队列）
│  ├─ media-src.js              素材地址解析与下载（resolveSrc / downloadTo / assetInfoOf）
│  ├─ user-dirs.js              用户可见目录根（下载 / 提示词 / 顶层目录名）
│  ├─ fs-atomic.js              原子写 / .bak / 余量与重试口径
│  ├─ data-store.js             /data 读写、原子写、.bak 备份
│  ├─ prompts-store.js          /prompts 提示词归档
│  ├─ cloud-store.js            /cloud 云同步
│  ├─ skills-store.js           .skills 清单 / 安装 / 启停
│  ├─ asr-store.js              .data/asr.json（密钥只留盘上，读接口只回 hasKey）
│  ├─ search-store.js           .data/search.json（同上）
│  ├─ channel-cred.js           设置页两条「通道」（识别 / 搜索）共用的取数小件（回环判定只有这一份）
│  ├─ static.js                 静态文件：ETag / 预压缩（br→gzip→原文，请求与开机预热共用同一只在途压缩）/ CSP 头 / warmStatic
│  ├─ security.js               同源、Cookie、出站 URL 护栏
│  ├─ outbound.js               出站 HTTP（超时 / 重试 / 代理）
│  ├─ health.js                 代理故障账（只报不自杀，也收客户端上报）
│  ├─ lock.js                   单实例锁
│  ├─ zip.js                    FCPXML 媒体包 zip
│  ├─ providers/validate.js     registry 供应商声明校验
│  └─ routes/                   system / static / capabilities / registry / relay / outbound / local-assets /
│                               usage / cache / skills / fcpxml / pick-dir / asr / models / search /
│                               http（路由层唯一的 JSON 回包口径：sendJson / fail，默认 no-store）
├─ shell.html                   SPA 外壳（CSP、启动脚本、公共模块）
├─ web/
│  ├─ app.js                    Vue 外壳：hash 路由 + KeepAlive 页面池 + 生命周期 + 页面预取（__spaPrefetch）
│  ├─ shell-boot.js             主题解析（配色 + 日夜两根轴，含跟随系统）与「在外壳里」旗标
│  ├─ boot-assistant.js         首屏收尾后空闲加载 AI 助手（load 事件 + rIC，4s 兜底；ai_chat_off 命中就整个不下载）
│  ├─ core/                     routes / page-css（样式表挂载与 modulepreload）/ bridges / page-context /
│  │                            hooks / activity / actions / report
│  ├─ pages/                    favorites / usage / assets / settings / chars / studio（导演台在 director/index.js）
│  │                            页面里成块的东西搬进 pages/<页>/<块>.js：chars/detail.js（素材页整屏编辑）、
│  │                            settings/accounts.js（设置页「供应商与密钥」的账号卡流）
│  ├─ media-backend.js          浏览器内媒体后端（mediabunny 主档 + <video> 兜底：info / frame / thumbs）
│  ├─ media-export.js           浏览器内离线导出（帧计划 / 合成 / 混音 / mediabunny Output）
│  ├─ director/                 index + template.html + engine.js + engine/<域>.js + 纯算法模块 / worker
│  ├─ render/                   预编译生成的 render 函数（不要手改）
│  ├─ ui/                       ui / forms / net / store / kv / toast / datasync / skills / workbench /
│  │                            sidebar / badge-state / raw-request / index
│  ├─ domain/                   api / assetlib / gen-forms / asset-transfer / export-dir / export-formats /
│  │                            local / capabilities / text-ai / gen-rules / fav / prompt-log / asset-picker /
│  │                            ai-find / chars / ident / asset-ref / identity / semantic / asr / search /
│  │                            zip-read / chat/text-util / chat/contracts
│  ├─ features/chat.js          AI 助手外壳：悬浮球 / 抽屉 / 会话 / 发送循环
│  ├─ features/chat-tools.js    助手工具循环与动作目录（TOOLS / ACTS / 两张形状表）
│  ├─ package.json             {"type":"module"}（Node 判据按 ESM 读 web/ 模块）
│  └─ styles/                   tokens / ui / wb / sidebar / chat / spa-*.css
├─ tools/
│  ├─ precompile-vue.cjs        模板 → render 函数（开发期）
│  ├─ tokenize-css.cjs          裸值体检 + 机械替换 + 值→令牌映射
│  ├─ token-lib.cjs             上面两个工具的共用件（规则表 / 扫描范围 / 值→令牌映射）
│  ├─ check-vars.cjs            令牌引用完整性
│  ├─ migrate-skills.cjs        一次性迁移：用户 Skill 目录换根
│  └─ vue-templates/            模板源（开发期，不进运行时）
├─ skills/<id>/SKILL.md         内置 Skill（随页面 / 触发词加载）
├─ tests/                       常驻判据、单元、e2e、fixtures、数据基线
├─ .gitattributes               行尾的唯一权威（文本 LF · .ps1/.bat CRLF · 二进制不换算）
├─ 启动.bat                     UTF-8 无 BOM + chcp 65001，薄入口
├─ launcher.ps1                 UTF-8 带 BOM + CRLF，WinForms 启动器
├─ package.json                 开发依赖：@vue/compiler-dom（模板预编译）+ pngjs（视觉指纹）
├─ vue.runtime.esm-browser.prod.js  本地 vendored Vue runtime（无编译器）
└─ vue.LICENSE.txt
```

## 构建与运行时

### 零构建与模板预编译

浏览器直接加载静态文件，没有打包步骤：Vue 3.5.44 runtime-only，`shell.html` 用原生 ESM 引入 `web/app.js`，
页面组件按需 `import()`。运行时没有 Vue 模板编译器，不允许 `new Function` / `eval` / 内联 `<script>`。

- 模板源只放在 `tools/vue-templates/*.html`；`web/` 下的组件不许再写 `template:` 字符串。
- 改模板后运行 `npm run build`（或 `node tools/precompile-vue.cjs`）；`npm run build:check` 只比对不写盘。
- 生成物是 `web/render/*.js`：`export function render(_ctx, _cache)`，直接 import 本地
  `vue.runtime.esm-browser.prod.js`。生成文件不要手改；模板与生成物不一致时 `build:check` 必须红。
- 页面组件统一写 `render: SomeRender`，不写 `template:`。

### 严格 CSP

`shell.html` 的 meta 与 `server/static.js` 的 HTML 响应头都下发：

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';
font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'; worker-src 'self' blob:
```

- `'wasm-unsafe-eval'` 只放开 WebAssembly 编译（mediabunny 与浏览器内 ASR 走它），不放开 `eval` / `new Function`。
- `script-src 'self'`：不许内联脚本、不许内联事件处理器、不许 eval。新增脚本必须是同源外部文件。
- `style-src 'unsafe-inline'`：允许现有的 `style=` 与动态样式元素；不要新增内联 `<style>` 以外的脚本能力。

## 启动器

- `启动.bat` 只做环境检查并拉起 `launcher.ps1`；`WB_LAUNCHER_DRYRUN=1` 只打印检查结果。
- `启动.bat` 里那句 `start ... -WindowStyle Hidden` 必须保留：否则桌面上会多一个控制台，
  关掉它是硬杀进程，服务会成孤儿。隐藏前必须先解析 `launcher.ps1`，否则「双击没反应」。
- `启动.bat` 的预解析按内容哈希缓存：对 `launcher.ps1` 算 size + SHA1（certutil）写进
  `%TEMP%\imago-launcher-parse.key`，与上次一致才跳过这次解析；哈希算不出 / 印记缺失 /
  内容有变都回到必跑解析，解析失败不写印记。不用文件时间戳 —— 分钟粒度会漏检同分钟内的等长改写。
- `launcher.ps1` 的内嵌 C# 读线程按源码 SHA256 落 DLL 缓存（`%TEMP%\imago-runner-<hash16>.dll`）：
  命中直接 `Add-Type -Path` 装载；未命中先编到 `<dll>.<PID>.tmp`、挪到正式名再装载（装载会锁文件），
  任何一步失败回退 `Add-Type -TypeDefinition` 现编 —— 语义与失败降级路径都不变。
- `launcher.ps1` 的语法用 `[System.Management.Automation.Language.Parser]::ParseFile` 查，
  `node --check` 看不见它。
- 启动器自检：`powershell -NoProfile -ExecutionPolicy Bypass -File launcher.ps1 -SelfTest`
  （`-EnvFile` / `-StateFile` / `-EnvAdd` / `-NoBrowser` 只给探针用）。
- `启动.bat` 另带命令：`menu` / `check` / `log` / `dir` / `page` / `selftest` / `clean` / `help`；
  双击仍是「检查环境 → 预解析 → 隐藏控制台拉起启动器」，命令只给排障用。
- 双击自检只留必要的外部进程：`node --version`（顺带判 node 在不在）、
  `certutil -hashfile`（预解析印记）。powershell 存在性看 `%SystemRoot%` 下的 exe，
  `.env` 的 PORT 用批处理原生 `for /f` 读 —— 不再为一行展示信息起 where / findstr / PowerShell。
  彩色检测用 `ver` 的子进程读主版本号，老系统或 `WB_NOCOLOR=1` 自动降级纯文本。
- 控制台颜色变量不许取名 `CD`：cmd 的动态变量 `%CD%` 会在变量为空时插进当前目录，
  把「无彩色」那一档的输出搅乱（踩过，已改名 `CDIM`）。
- `launcher.ps1` 的 `Update-Status` 只用状态文件与 `$DefaultPort` 拼忙线文案，
  不在每 350ms 的定时器里重读 `.env`；端口说明那一行已按需求删除。

## 设计规范

这一节是界面层的硬约束：令牌、主题、布局、组件、交互、验证。下面每一条都有尺子或判据盯着，
违反不是「不好看」，是判据红。

### 令牌

- `web/styles/tokens.css` 是**唯一**的主题 / 间距 / 字号 / 圆角 / 描边宽 / 组件尺寸 / 阴影 / 动效令牌来源；
  别的样式表与页面 CSS 不许再定义 `:root` 或 `html[data-theme="dark"]` 的第二套变量。
- **颜色分两层**：主题色段只有别名（`--bg: var(--bg-base)`），浅色真值只在基色段写一次，深色档由基色现算。
  加一枚主题色 = 别名 + 基色 + 深色推导，三处少一处判据 G19 当场红；深色档里拼错的名字不会报错、
  只是静默失效，同一条判据也抓。
- **令牌名 = 它的值**：`--sp-16` 就是 16px、`--fs-13` 就是 13px、`--radius-10` 就是 10px、
  `--acc-tint-18` 就是 18%、`--dur-180` 就是 180ms。不许回退到「序号 = 档位」的写法
  （`--sp-1:4px` / `--fs-1:12px` 这类写法会让 `--fs-1` 与 `--fs-16` 变成两个看不出差别的名字）。
- **每族只有终表这几档**（补档已全部并入，调用点只认终档名）：

  | 族 | 终表 | 角色 |
  | --- | --- | --- |
  | 间距 `--sp-*` | 2 / 4 / 8 / 12 / 16 / 24 / 32 / 64 | 微缝 / 紧凑 / 基准 / 段内距 / 卡内距 / 区块距 / 壳留白 / 大留白 |
  | 字号 `--fs-*` | 11 / 12 / 13 / 14 / 16 / 20 / 24（展示档 42 / 54） | 微字 / 次级 / 正文 / 强调正文 / 小标题 / 页头标题 / 数字展示 |
  | 圆角 `--radius-*` | 4 / 6 / 10 / 14 / 999 | 方正内件 / 控件 / 小容器 / 大卡弹窗 / 胶囊 |
  | 时长 `--dur-*` | 120 / 180 / 280 / 800 / 1200 | 快 / 基准 / 慢 / 转圈周期 / 脉冲周期 |
  | 阴影 `--shadow-*` | 1 / 2 / 3 / 4 / 5 | 抬升 / 浮层 / 重浮层 / 模态 / 深底小浮起 |
  | 控件高 `--sz-*` | `--sz-ctl-sm` 28 / `--sz-ctl` 32 / `--sz-ctl-lg` 36 / `--sz-chip` 24 / `--sz-head` 56 | 小控件 / 控件 / 大控件 / 胶囊行高 / 页头横带 |

  写裸值会被 `tools/tokenize-css.cjs` 的值吸附拉到最近一档（裸 6px → `--sp-8`），
  终表外的档名不许再出现（判据 G18 + check-vars 双重盯）。组件尺寸里
  `--sz-ico` `--sz-tile` `--sz-thumb-h` `--sz-card` `--sz-scroll` 是角色命名，另见组件节。
- **不许写令牌兜底值**：`var(--x, #fallback)` 里的兜底是同一个数的第二份拷贝，两边会漂开。
  令牌要么在 `tokens.css` 里声明，要么由 JS 运行时写到 DOM 上（那种要在 CSS 里也声明一份默认值）。
- **`calc()` 里必须写 `var(--x)`**：`calc(-1 * --sp-4)` 是非法 CSS —— 声明整条作废、退回初始值。
  负偏移写成 `calc(-1 * var(--sp-4))`。
- **透明度只走 `--a-*` 阶梯**：`color-mix(in srgb, var(--基色) var(--a-10), transparent)`。
  阶梯是 21 档（`--a-4` … `--a-90`）；零星百分比已全部就近并入阶梯（0% 写 `transparent`），
  判据 G21 登记在案的是 0 —— 不许再自己编百分比。
- 页面样式不许再写裸的间距 / 字号 / 圆角 / 描边宽 / 色值 / 时长。
- **模板源也在射程里**：`tools/vue-templates/*.html` 预编译进 `web/render/*.js`，等于活代码，
  它的行内 `style=` 同样不许写死。

### 主题

主题是两根轴：`html[data-theme]` 只放解析后的 `light` / `dark`（永远不写 `system`），
`html[data-palette]` 放配色名（`ocean` 缺省，另有 `violet` / `teal` / `berry` / `amber`）。
`tokens.css` 同时按这两档声明 `color-scheme`，原生复选框 / 滚动条才跟主题走。
解析只有一处：`web/shell-boot.js` 的 `window.__themeApply`（启动时同步跑在样式表之前，
偏好是 `system` 时按 `prefers-color-scheme` 解析、系统档变化时重解析）。侧栏那颗「换背景」、
设置页两格、助手改设置都只调它，不许自己写 `dataset.theme`（那会绕过 `system` 的解析）。

`tokens.css` 按段分清了几件事 —— 换主题时只动主题色与深色档，换配色只动配色块：

| 段 | 内容 | 跟不跟主题走 |
| --- | --- | --- |
| 主题色（只有别名） | `--bg` `--panel` `--panel2` `--line` `--txt` `--sub` `--acc` `--acc2` `--ok` `--warn` `--err` `--pri` `--input` `--thumbbg` `--atbg` `--scroll` —— 值一律是 `var(--<name>-base)` | 跟：深浅两档必须成对覆盖（判据 G19） |
| 浅色基色（全站唯一真值） | `--<name>-base` 十六枚 | 不跟（深色档由它们现算，不另写真值） |
| 两档一致的固定色 | `--on-acc` `--media-bg` `--chart-1..12` | 不跟（反白字、媒体黑底、图表色两档该同值） |
| 派生色 | `--acc-tint-*` `--acc-line-32` `--sel-bg` `--ok-tint` `--err-tint` `--warn-tint` `--control-bg` | 跟（由主题色现算） |
| 固定中性色 | `--pal-gray*` `--pal-slate*` `--pal-scrim` | 不跟（只给深底浮层用：灯箱、缩略图上的播放钮遮罩） |
| 导演台标记色 | `--mark-cut` `--mark-ready` `--mark-mute` `--mark-loud`（各自带 `*-base`） | 跟（轨道里的功能标记，深色档同样由基色现算） |

- **深色由浅色现算**：`html[data-theme="dark"]` 里每个语义色写成
  `oklch(from var(--x-base) <L> c h)` —— 只换亮度，色相与彩度沿用基色。深色档里只许出现主题语义名、
  派生色里那两枚底纹、导演台标记名与 `--shadow-*`；写 `*-base` 就是重设基色（判据 G19）。
  两枚底纹（`--atbg` 文字底纹、`--sel-bg` 选中底纹）是例外，深色档写成
  `color-mix(in srgb, var(--基色) <另一档透明度>, transparent)`：深色档的底本身是深灰、强调色是亮色，
  沿用浅色档那一档透明度会把这一格推到强调色文字的近邻亮度，读不出字。
  相对色语法要 Chrome / Edge 119+（本项目本来就要 118+ 的 `@scope`）。
- **强调色在组件里只有四种画法**，别自己攒第五种：① 选中 / 在用 = 墨 `--acc` 压在 `--sel-bg` 上；
  ② 软底（hover / 淡标签 / 说明条）= 墨 `--acc` 压在 `--acc-tint-10` 上；③ 描边与环 = `--acc-line-32`
  （焦点环用 `--focus-shadow`）；④ 实心档分两种落点：浮在任意画面（图片 / 视频 / 深底缩略图）上的那几颗
  用 `--pri` + 白字 `--on-acc`（背后的像素不由主题说了算，`--pri` 在两档都是深的，白字实测 ≥5:1），
  而压在**语义实底**（`--acc` / `--acc2` / `--ok` / `--warn` / `--err` / `--sub` / `--txt`）上的字
  墨一律是 `--panel`（把面板色从实底里掏出来）—— 深色档那几枚现算成**浅色**，白字压上去只剩 1.5–2.5:1。
  深底实心档上不许写 `--sub` / `--txt`，浅底那一族不许把淡底往深里压（hover 加一层更深的淡底 = 强调色墨掉到 4.5:1 以下）。
- **状态色（成功 / 警告 / 失败）的淡底只有三枚：`--ok-tint` / `--warn-tint` / `--err-tint`**，
  而且它们是**不透明**的（`color-mix` 压在 `--panel` 上算出来的那一个色）。状态牌会浮在缩略图槽、任意一张照片、
  卡片或页面底色上 —— 用 `color-mix(…, transparent)` 等于让「红字能不能读」由背后那些像素决定：
  实测深色档「生成失败」压在透明淡红 + 缩略图槽上只有 4.05:1，同一枚墨压在面板上是 4.91:1。
  页面里不许再现写第四枚淡底，也不许把状态淡底换回透明（`.plate--*` / `.ui-tag.*` / `#banner.*` /
  助手回执行 / 素材页图底那一条失败原因 / ghost 危险按钮的 hover 都读这三枚）。
  这三枚的墨同时兼作正文级文字墨（不设淡底的「卸载」「删除本机副本」、警示条上的说明），
  所以 `--err-base` / `--warn-base` 比「单看好看」深一档，要让它们压在 `--panel2` / `--input` 上过 4.5:1；
  深色档由基色现算，只换亮度，因此那两枚基色加深不动深色读数。
  判据 `tests/e2e/theme-modes.cjs` 第⑧步：`chip`（墨 × 自己那枚不透明淡底）与 `sem`（墨 × 真正用的面）两族
  在五套配色 × 深浅两档都钉 4.5:1。
  这四组在浅 / 深 × 五套配色下逐一量过（判据 `tests/e2e/theme-modes.cjs` 第 ⑧ 项：淡底三族 + `solid` + `knock`）。
- **配色块只换强调色**：文件末尾 `html[data-palette="ocean"|"teal"|"berry"|"amber"]` 各一块，
  只覆盖 `--acc-base` / `--acc2-base` / `--pri-base`（后两枚指回 `--acc-base`），再靠深色档的推导跟上；
  块里不写深色版本。选择器必须单挂 `data-palette`（和 `data-theme` 叠写，换配色就只在一档里生效）。
  `violet` 就是基色、没有自己的块；缺省选择是 `ocean`。
- **导演台不再有独立深底作用域**：它的底色 / 文字 / 描边一律取主题语义色（`--bg` / `--panel` /
  `--panel2` / `--txt` / `--sub` / `--line`），跟其他页面一样切主题；只留导演台标记色。
  不许再引入 `--dir-*` 一族独立深底配色（判据 `tests/doc-contract.cjs` 数 0 命中）。
- 共享界面的文字 / 描边 / 底色 / 状态一律取主题语义色（`--err` / `--warn` / `--ok` / `--acc` / `--acc2`），
  不许挑固定色 —— 挑固定色的后果是「深色主题里错误色还是浅色的红」。
- 页面确有品牌差异时，只在该页根类下覆盖**一个**变量，并写明理由；不许自己另起一套色。
- 换主题的验收：切 `html[data-theme]` 与 `html[data-palette]` 后逐屏看 —— 浅 / 深两档的语义色必须各自成体系，
  五套配色的强调色要真有区别、中性色逐字节不动（浏览器判据 `tests/e2e/theme-modes.cjs`）。

### 布局

页面外壳只有两种：

| 外壳 | 用在哪 | 形状 | 定义在哪 |
| --- | --- | --- | --- |
| `.page-shell` | 素材库 / 资产库 / 收藏 / 用量 / 设置 | 页头 + 留白 + 内容区；收藏 / 资产库 / 用量整页滚，素材库与设置页在同一个外壳里改成局部滚（见下） | `web/styles/ui.css` |
| `.wb` | 工作台 | 左栏写、右栏看，两栏各自滚动 + 生成按钮 + 状态行 | `web/styles/wb.css` |
| `.sidebar` | 全站（外壳层，不在页面里） | 满 232px / 窄 56px 两个形态，收 / 展的开关是左上角那块品牌砖 | `web/styles/sidebar.css` |

- **页头只有这一份**：`.phead` 是各页面共用的那条横带 —— 跨页宽、粘顶，四个槽按需留空、位置不挪：
  `A 身份`（标题，每页都有）/ `B 上下文`（计数 / 状态 / 当前项目）/ `C 说明`（一句话：这页在干嘛）/
  `D 动作`（页面级动作 ≤3 个）。四条硬规矩：
  ① 页面名只说一次（素材库左轨不再重复写「素材库」，那里改成「目录」）；
  ② 筛选与视图切换不进页头 —— 页头放「这一页能干什么」，下面那行工具条放「怎么看这一页」；
  ③ 标题不带图标 —— `.phead-id` 就是标题容器，不要再往里加图形 / 徽记 / 装饰；
  ④ **横带定高 `--sz-head`（56px）**：高度不随「槽里最高的那颗控件」变。
     以前纯文字页 50 / 带 32px 按钮的页 57 / 导演台那颗 33px 的导出钮 58 三种并存，
     标题顶边跟着在 y=12 与 y=16 之间跳 —— 定高之后七页都是同一个数。
     窄窗（≤760）换行时才长高，那一档用 `min-height` 说话。
- **标题左缘 = 该页内容列的左缘，内容列离内容区左缘一律 32px**（`--shell-px: var(--sp-32)`）：
  七个页面各读同一枚变量，切页时标题不再左右跳。760 以下全站一起收到 `--sp-16`。
  **那条分隔线（`border-bottom`）的起止 = 内容列的起止**：页头左右一律内缩一枚 `--shell-px`，
  谁都不再多缩一层 —— `.page-shell` 由壳的 padding 给（页头自己不补左右），
  `.wb` 与导演台由页头这一格自己内缩（壳不留白）。以前是两套口径：五页的线跟着内容缩进、
  工作台与导演台的线通栏到那一块的外缘（比内容列左右各多出一截），同一条线两种长度。
  判据 `tests/e2e/page-head.cjs` 逐页量「标题左缘 == 内容列左缘」「横带高 == `--sz-head`」
  「线左右离本页根盒子 == `--shell-px`」「标题在横带垂直居中」，再比七页的标题顶边全等。
- **页面根不许叠一层自己的装饰底**（渐变 / 图 / 第二份色）：七个页面的底恒是 `--bg`，
  页头那一格才可能是同一个不透明色。工作台曾带两团强调色径向渐变 —— 唯一一格透明的页头就是那么来的
  （平色矩形压在渐变上会露接缝），切页时标题那一条跟着变色。判据同上一条（量 `background-image` 与底色）。
- **主体那块与页头那条都铺满内容区，谁都不限宽、不居中**：
  · 页头这一格左右各内缩一枚 `--shell-px`（`.page-shell` 由壳的 padding 给，页头自己不补左右；
    `.wb` 与导演台的壳不留白，页头这一格自己内缩）→ 那条分隔线（`border-bottom`）的起止就是
    内容区内缩 32 的那一段，七页在同一个窗宽下量的都是同一条线。
  · 页面主体那块（`.wb .layout` / 导演台 `.layout` / 设置页的网格）横向 = 内容区，
    内缩同样只取那一枚 `--shell-px` → 内容列左缘 == 标题左缘 == 线的左端。
    工作台那块尤其要写死宽度（`width: 100%`）：`.wb` 是 flex 列，子项带 `margin` 会按内容定宽，
    而内容宽度里含着左栏那一轨 → 拖一下分栏，页面两端的空白跟着变。
    **这一页曾另有一档「最大宽 1440 + `margin: 0 auto`」居中**（那枚 `--sz-wb` 已随之删掉）：
    居中就把首字从 x=88 推到 300（1920 窗）/ 620（2560 窗），另外六页仍是 88 —— 切页标题左右跳的
    正是这一档，别为了「宽屏少留白」把它接回来。
  · `.page-shell` 的 `padding-top` 归零（`--shell-px` 只管左右），上留白在那一条定高里给。
- **素材库与工作台是整屏不滚的外壳**：页头是它们的第一行，下面那层占满剩下
  （`.chars-page .mat` / `.wb .layout` 各改一行定位即可），所以那两页的页头不吸顶
  （没有可滚的容器），但形状与别的页一致。
- **导演台也是这一副契约**（`web/director/template.html` 的 `<header class="phead">`）：
  身份（导演台）+ 上下文（当前短片名 + 已保存）+ 动作（导出）；导演台整页不滚，
  所以它的页头也不吸顶。它的横向留白也从 `.page-main` 上的 `--shell-px` 取（页头与三栏同一枚）。
  · 页头这一排同时摆着短片切换钮与导出钮，**一行混排只许 `--sz-ctl` 一档**（切换钮以前走胶囊档 24）。
    切换钮上念的是**当前短片名**（`#projLabel`，长到 `--sz-pname` 就截断，全文在 title 里），
    不是「我的短片 N」；页头**没有**改名输入框，也不报短片数 —— 那一格只说「现在是哪一部」。
  · 整理短片全部在它点开的那份菜单里**就地做完**，不弹表单窗、不弹确认框：改名把名称那一格换成输入框
    （Enter 保存 · Esc 收回，与素材页「新建组」那一行同一副画法）、移组在那一行下面摊开一个下拉
    （公共 `Dropdowns`：未分组 + 各组，当前组预选）、新建项目组是同一格位置的草稿行、删除走公共的
    `Confirm.arm` 就地二次确认。菜单里的每一步都会整栏重画，所以「点在外面」按事件派发路径判，
    不能看重画之后已脱链的 `e.target` —— 否则点「新建项目组」会连菜单一起收掉。
    判据 `tests/e2e/director-groups.cjs` 逐条数这几步，并盯着「菜单里出现开着的 dialog」判红。
- **设置页仍是 `.page-shell`，不是第三种外壳**：页面自己不滚，左边目录轨与右边那条文档各滚各的。
  · 左边 `.set-rail` 是目录轨（5 组 15 行，每行带当前值），右边 `.set-doc-scroll` 是 15 张卡排成的
    一条连续文档（组标题钉顶、状态行钉底）；轨上一行 = 一张卡，卡里的能力档不另占行。
  · 两栏的宽度只从一枚令牌来（`--setrail-w` = 272px）：网格列与轨本身都读它，轨不许比它那一列宽。
    这一页不共用素材库那枚 `--rail-w`（208px）—— 它每行还带一个「当前值」速记，比那根宽。
  · 滚动的唯一出口是 `scrollToEl`（`web/pages/settings.js`）：它给钉住的组标题让出高度
    （`--setanchor`，由 JS 量出来写进 CSS 变量），并在落定后补校正；这一页不许有第二处裸 `scrollIntoView`。
  · 目录轨与那份文档的组名 / 栏目标题全部从 DOM 现读（`.set-group[data-group]` 与 `.card[data-nav]`），
    JS 里不许有第二份清单；轨上每行的当前值现读同一份真相，不另存一份状态。
  · 卡片皮肤用公共的 `.card-surface`；卡内分组小标题是 `.sect-t`（必须有样式）；卡内那些行标签列定宽 164px
    （`.krow > .kn`）；行不两列并排（`.kcols` 是一块）。
  · 这一页没有「保存」按钮，所以「改完就存本机 · 刚刚存过」那句回执必须在状态行里（`.set-save`）。
- **页面自己的差异**留在各自的 `web/styles/spa-<id>.css` 里，且必须挂在该页根类下（`.chars-page .card`）。
- **卡片列宽只有两档**：`--sz-card`（268px）与 `--sz-card-sm`（200px，紧凑视图 / 窄窗）。
- **竖排网格卡的高度只有一档**：缩略图 `2 / 1` + 正文两行（提示词 / 失败原因各占定高）+ 动作两行（`--sz-ctl`）；
  等高靠「把会变高的格子钉住」实现，不靠行自适应。判据 `tests/e2e/task-cards.cjs` 既数档数（必须 1 档）也数上限。
- **翻页行一处一套，位置按外壳分**：普通页（收藏 / 素材库 / 资产库）在页面底部；
  工作台并进右栏那一排（搜索 / AI 搜索 / 多选 / 刷新 / 上一页 / 第几页 / 下一页 / 跳页 / 跳转
  同一个 `.pgroup`，在结果区上面）—— 工作台是「两栏各自滚」，页底那一行要滚到最下面才看得见，
  翻页放在那儿等于没有；这一排按「尽量一行」设计，右栏拖窄时才自己换行。
  翻页（页码真的变了）之后右栏列表滚回页首；more 档续拉不弹回开头。
  判据 `tests/e2e/pager-row.cjs` 盯「四页的翻页行都画出来」，`tests/e2e/pull-selected.cjs`
  盯「翻页与搜索同一排且排在结果区上面」。
- 页面根元素统一是 `class="page-main <id>-page <外壳类>"`：`.page-main` 与 `<id>-page` 由路由表的
  `root` 带着，工作台页额外挂 `.wb`。
- **断点**：媒体查询里不能用 CSS 变量，所以断点只能靠「登记 + 判据 G22」防漂移。
  当前登记的 5 档：520 / 760 / 900 / 1100 / 1200。

### 组件

**同一个功能只应有一份实现**。新写任何界面块之前，先按「公共层：唯一实现清单」查一遍；
已有组件能表达的就直接用，不够用就扩展公共组件，不允许在页面里复制一份「看起来差不多」的实现。

ESM 公共件只从 `web/ui/index.js` 取；经典脚本那一族（`window.*` 面）也只经「公共层：唯一实现清单」点名的入口。
页面不许深路径引用组件，也不许照着公共件再写一份「看起来差不多」的。

**普通控件的表面保持浅色**：按钮 / 下拉 / 输入 / 分段落在白底或浅底上，用底色层级与轻阴影区分；
选中态用浅强调底 + 强调文字，不用深色实心填充。品牌砖与侧栏当前项标记不在此列。

**形状与尺寸只有这几种角色**（圆角与控件高都从令牌取，不许再发明中间档）：

| 角色 | 圆角 | 高 |
| --- | --- | --- |
| 控件（按钮 / 输入 / 分段 / 下拉按钮） | `--radius-6` | 常规 `--sz-ctl`、小号 `--sz-ctl-sm`、大号 `--sz-ctl-lg` |
| 容器（表单行 / 参数卡 / 提示条 / 下拉面板 / 小卡） | `--radius-10` | 不锁高 |
| 大卡 / 弹窗（`.task`、`dialog.ui-dlg` 一族） | `--radius-14` | 弹窗按内容 |
| 胶囊（`.ui-tag` / `.ui-pill` / `.ai-chip` / `.phead-chip`） | `--radius-999` | `--sz-chip` |
| 页头横带（`.phead`） | 不画圆角 | 定高 `--sz-head`（窄窗换行才长高） |
| 方正内件（`.did` / `.seg-n` / 导演台方正覆盖） | `--radius-4` | 按内容 |

**一行混排控件只许 `--sz-ctl` 一档**：一条 flex / grid 行里摆着两种以上原子控件
（按钮、输入框、分段、下拉）时，全部取 `--sz-ctl` / `--fs-13` —— 单行输入框的公共配方
（`.toolbar input[type="search"]` / `.search` / `.ui-inp`）与 `.ghost` / `.dd-btn` / `.ui-seg`
同高；往隐藏的原生 `<select>` 的 class 里写尺寸是惰性的（画出来的是 `.dd-btn`）。
`--sz-ctl-sm` 只给**整行都小**的行用（`.ghost.mini` 与同为小号的邻居同排）；
大号 `--sz-ctl-lg` 只给单独强调的主控件。一行 32 / 28 混排是判据红，不是风格问题。

键盘焦点环只有全站兜底一份（`ui.css` 末尾的 `:focus-visible`）；组件与页面不许再写
同一圈 outline，也不许用基态 `outline: none` 把它压掉 —— 输入族的鼠标焦点反馈是
`:focus` 时 `border-color: var(--acc)`。

**公共样式类**（`web/styles/ui.css` / `wb.css` 里的公共层）—— 页面只许在自己的根类下改它们：

| 角色 | 公共类 |
| --- | --- |
| 页面页头（跨页宽、粘顶） | `.phead` + `.phead-id`（标题，不带图标）/ `.phead-meta`（上下文）/ `.phead-sub`（说明）/ `.phead-acts`（动作）/ `.phead-chip`（上下文胶囊） |
| 卡片 / 列表行 | `.card` `.card-surface` `.task` `.ap-item`（竖排卡片的壳：`.card-shell-media` / `.card-shell-body` / `.card-shell-actions`） |
| 卡片公共件 | `.plate`（+ `.plate--*`）`.exp` `.why` `.exp-acts` `.band`（+ `.band-tether`）—— 资产库与收藏页共用；接线是 `Wb.expand` / `Wb.close` / `Wb.closeAll` / `Wb.anchor` |
| 按钮 | `.pri`（主）`.ghost`（次）`.tool`（磁贴）`.ui-linkbtn`（文字链式小动作） |
| 分段 / 芯片 | `.ui-seg` `.chip` |
| 徽标 / 提示条 | `.ui-tag` `.ui-note` `.list-note` `.srcbadge` |
| 表单 | `.pgroup` `.dd` `.dd-list` `.dd-btn` `.search` `.ui-inp`（单行输入配方与工具行搜索框同一条）`.ui-in`（只管行内宽度，几何走 `.ui-inp`）`.pinl` `.split-opts`（`SplitPlan.html` 画的那一排） |
| 空态 / 加载 | `.empty` `.ui-wait` |
| 工具条 / 视图切换 / 分页 | `.toolbar` `.viewtoggle` `.pager-row` `.pginfo` |
| 浮层 | `.ui-vrow` `.ui-voice` `.ui-cands` |

- 页面只允许写「这一页自己的排版与布局」；卡片、弹层、下拉、芯片、分页、缩略图、提示、确认这些
  不许在页面里出现第二份。发现重复实现，先把公共件补齐再把页面改过去。
- 判据 G20 盯着「页面补丁里不许顶层定义公共类」—— 页面差异必须写成 `.chars-page .card` 这种形式。
- 样式表都是真实文件：公共样式表（`tokens.css` / `ui.css` / `wb.css` / `sidebar.css` / `chat.css`）
  由 `shell.html` 挂载；页面私有 `spa-<id>.css` 由路由表的 `css` 经 `web/app.js` 的 loader 挂载。
  不许把一段 CSS 塞进 JS 模板字符串。唯一例外是 `web/director/template.html` 内嵌的 `<style>` 块
  —— 导演台是作用域岛，那块样式跟着模板一起被 `index.js` 取用，取值同样走令牌。

### 交互

- 所有可交互元素至少覆盖 `hover` / `focus-visible` / `active` / `disabled` / busy；
  `ui.css` 末尾有一份全站兜底，页面不要重复写同一份焦点样式。
- **程序性 focus 不许抢视口**：拿 `focus()` 只是为了「把光标续上」时一律走 `window.focusQuiet(el)`
  （`web/ui/ui.js`，全站唯一一份，带 `{ preventScroll: true }`）。真要「把某处滚过来」，
  走滚动那一族（设置页的 `scrollToEl` / `scrollIntoView`），别拿 focus 当滚动用。
- **搜索条只有三条出口**：输入框里回车 / 点到框外 = 普通搜索；清空输入框 = 当场取消筛选
  （普通词与 AI 条件一起收回）。没有独立的「搜索」按钮。AI 搜索那颗与输入框同壳（`.fb-ai`，
  由 `AiFind.btnHTML` 画）；AI 已经消化过的那句由 `Wb.filterBar.markApplied` 登记，
  失焦时不再重跑；反过来，一次普通搜索会把 AI 条件收回（换词 = 重新找）。

**加一颗按钮要走的五步**（判据 `tests/e2e/viewport-keep.cjs` 管机制与共享件；
`tests/e2e/viewport-clicks.cjs` 真点七页的击点量纪律）：

1. **元素**：用 `<button type="button">`，永远不用 `<a href="#">` —— `href="#"` 会产生一次 fragment 导航，
   中键点击 / 键盘回车 / 「在新标签打开」都还留着那条路；而 `<button>` 在 `form` / `dialog` 里默认是
   `submit`，`type="button"` 必须写。外观只用公共类（`.pri` / `.ghost` / `.tool` / `.ui-linkbtn`），
   带图标时用 `icon('xxx', 13)` 或 `data-icon` + `fillIcons`，不许用 `textContent` 改字。
2. **它换不换 DOM**：点完会整片重画一块「里面装着滚动容器」的区域时，那次重画必须包在
   `Wb.viewport.keep(el, fn)` 里 —— `el` 是那块要重画的外层（不是按钮），公共件按锚点在重画后
   把容器里的滚动位还回去。keep **不自动向上找**（重画路径里常挂着故意滚的那一路，无条件罩祖先会把它们抹掉）：
   要稳住哪只容器，就把那一只、或它的任一个祖先当 `el` 传进来；「这一页在窄窗里改由外层滚」的
   加 `opts.outer` 连外面那只在滚的祖先一起稳住。故意的滚动（翻页回页首、会话贴底、跳到某一组）
   写在 `keep(...)` **返回之后**，别塞进 `fn` 里。列表刷新不用页面操心：`Wb.cards.paint` 内部已经套了；
   `Wb.filterBar` / `Wb.kindFilter` 是就地改文本、不整片重画。
3. **它就地展开吗**：展开一块嵌在滚动容器里的东西（型号面板、详情块）而**不**整片重画时，
   调 `Wb.viewport.reveal(块, { pin: 点中的那一行 })` —— 最小滚动把整块带进视野，再用那一行夹住：
   往下最多滚到「行顶贴容器上缘」，往上最多滚到「行底贴容器下缘」；块比容器还高时，容器里留下
   「那一行 + 块露出的那一截」，剩下的在容器里滚。绝不许把点中的那一行推出视野，
   等高卡也不许为了展开变高。它不用 `scrollIntoView` —— 那会把外面那条文档一起滚（页面整个上跳）。
4. **它 focus 谁**：要让光标落进某格输入框 → `window.focusQuiet(el)`；真想让那一格进视野，
   另写一句 `scrollIntoView({ block: 'nearest' })`。别拿 focus 当滚动用。
5. **它跳不跳页**：站内跳页只走 `GoPage.go('xxx.html')`，不写 `location.href`、不手拼 `location.hash`。

### 验证

| 尺子 | 管什么 | 命令 |
| --- | --- | --- |
| 体检 | 样式层还有没有裸值 | `node tools/tokenize-css.cjs`（`--write` 机械替换 / `--remap=sp,fs` 档位改名 / `--map` 看映射） |
| 引用完整性 | 有没有引了没定义的令牌（静默失效） | `node tools/check-vars.cjs` |
| 静态判据 | G18 裸值 / G19 主题色深浅两档成对覆盖 / G20 页面不顶层定义公共类 / G21 透明度阶梯 / G22 断点登记 / G23 注释不写文档引用 / G24 手写滚动位存取对（滚动位还原只许 `Wb.viewport` 一份）/ G25 无选择器的孤儿声明块（选择器那一行整行没了 = 整块被 CSS 错误恢复吞掉，体检与 check-vars 都看不见） | `node tests/static-guards.cjs` |
| 视觉回归 | 画面有没有变 | `node tests/e2e/ui-visual.cjs` |
| 一条命令 | 上面前三行 + 文档契约一起跑 | `npm run static` |

- 静态判据的存量表只许减不许增（`GUARD_WRITE=1` 重打表，但每条都要补一句原因）。
- 断点档位名单只有 `tests/support.cjs` 的 `BREAKPOINTS` 一份：静态判据 G22 与文档契约都读它，
  「布局」那一节列出的档位也要跟着它改 —— 改档位而不改规范，文档契约当场红。
- 视觉回归：七条路由（工作台按视频 / 图像 / 语音分三档 → 九档），再加两档「要喂状态才画得出来」的
  「字幕编辑区 / 助手来源卡片」，共 11 档 × 1024/1440 × 浅 / 深主题 = 44 个画面，24×14 RGB 指纹；
  字幕那一档的输入素材是入库的 `tests/fixtures/media/probe-clip.mp4`（2 秒样本），不依赖本机转码工具。

## 文案

- **不解释显而易见行为**：按钮能自明就不加旁注；title 不复述按钮名；说明句超过 15 字先删再考虑压短。
- **空状态只留名词短语**（「还没有产物」），不写页面用途、不教下一步。
- **加载中统一「加载中…」**（体检中 / 估价中等专用语除外）；错误提示只留「原因 + 怎么办」最短形态。
- **同一能力同一词**：取消收藏（不用「移出收藏」）、重试（不用「再试」）、已选 N 项、型号（不用「模型」）；
  同一句文案只维护一份（模板与 CSS content、模板与 JS 不许双份）。
- 喂给模型的提示词（SKILL.md 正文、chat 的 system prompt）不是 UI 文案，不动。

## 路由与安全边界

### 页面不直连外部域名

页面里的每个外部请求只能打到本地代理同源相对路径：`/registry`、relay 前缀（从注册表现取）、
`/custom/<id>/*`、`/asset/<id>`，以及下面「本机路由与会话」列出的 `LOCAL_ONLY` 路由。

- 平台接口只走 `Api.request(prov, 'create'|'poll'|'list'|'cancel'|'credits'…)`、`Api.create`、`Api.createBody`。
- 自己拼 URL 只用 `prov.relay + prov.endpoints.*`；不要用 `prov.base`（只给代理）。
- 媒体地址一律 `Api.mediaSrc()`；缩略图缓存键用 `Api.mediaKey()` / `Wb.thumbs.keyOf()`。
- 允许的非外部地址：同源相对路径、`data:`、`blob:`。

### 本机路由与会话

- `LOCAL_ONLY` 路由：`/data`、`/prompts`、`/cloud`、`/capabilities`、`/skills`、`/local-assets`、
  `/assets-usage`、`/pick-dir`、`/env-status`、`/sys-status`、`/clear-cache`、`/cache/*`、
  `/fcpxml`、`/models`、`/getv`、`/getfile`、`/fetch`、`/s3put`、`/custom`。
- 会话 Cookie `wb_session`（HttpOnly + SameSite=Strict）的令牌**跨重启不变**：落在
  `<数据目录>/.session`（探针实例各用各的 DATA_DIR，不共享）。以前每次启动随机一串，代理一重启，
  没刷新过的页面在刷新前所有本机路由都 401 —— 图片 / 视频被界面判成「已丢失」。
  本机路由除同源检查外还要求这枚 Cookie；没有 Cookie 的 curl 读 `/data` 会拿到 401。
- 新写探针先用 `GET /` 收下 `Set-Cookie` 再打本机路由（样板见 `tests/e2e/harness.cjs`）。
- relay 前缀与 `/asset/<id>` 也只接受同源请求（跨站 403）；relay 前缀从
  `REGISTRY.providers[].relay` 现取，不要手写。
- **relay 前缀一家一段**：转发、转发闸、create 判定都按前缀认家。同一段前缀只允许
  base / keyEnv / endpoints 完全一致的等价声明共用（sparkcine 两家），否则第二家的请求与密钥
  就会打到第一家的 base 上。判据在 `server/providers/validate.js`。

### 出站护栏

- 代理主动取字节前必须过 `guardOutboundUrl`（异步，含 DNS）或 `safeOutboundUrl`（同步字面量）：
  只允许公网 https；回环 / 内网 / 链路本地 / 解析到内网的域名一律拒。
- 走系统 / 环境代理的出站是 CONNECT 隧道（`server/outbound.js` 的 `ProxyTunnelAgent`）：
  代理来源只认「`.env` 的 PROXY_OFF=1 > 环境变量 HTTPS_PROXY 等五键 > Windows 系统代理」。
  隧道这条路上目标域名由代理端解析 —— `guardOutboundUrl` 的本地 DNS 校验与 `guardedLookup` 注入
  都按 `setProxyProbe` 的探针答复整道跳过（直连路径照旧），否则 Clash 一类开 fake-ip 后公网域名
  在本机全解析成 198.18.x.x、出站条条被拦；198.18.0.0/15 仍在 `isPrivateHost` 的拦截表里。
  代理开关 / 换地址（label 变了）即 `security.resetHostGuard()` 清一次 DNS 闸缓存。
  判据 `tests/proxy-tunnel.cjs`（假代理 + 本地 TLS 目标，离线跑通 CONNECT + TLS + 复用 + 拒绝四条）。
- `/getfile`、`/s3put`、`/fetch`、`/getv` 四条通道只走 `takeOutboundUrl`，不要各自拼 400。
- 状态码原样透传；4xx/5xx 一律 `no-store`（签名过期 403 不能被缓存一整天）。

### 本机写盘

- **产物本体的落点不由请求说了算**：`POST /local-assets` 与 `POST /local-assets/from-url` 只问
  `server/local-assets-store.js` 的 `bodyDirOf` / `newBodyPlace` —— 库根按 `server/local-root.js` 现算，
  根下按类型分 `图片/` `视频/` `音频/` `其他/`，规范名 = 资产库里看到的那个名字、撞名加 `-2` / `-3`；
  请求体里带 `dir` 也没有哪一行去读它。
- **`/from-url` 先问地址的真相再问声明**：目标地址（或名字）pathname 上认得出的扩展名压过请求体里的
  `format` —— 是媒体就按它归类，是文档类（`isDocExt`：srt/vtt/ass/txt/json…）整个 400 拒收；
  认不出的扩展名不猜，仍按声明走。
- `POST /pick-dir`：必须异步 `spawn`，不许 `spawnSync`；返回路径是隐私，只在 `LOCAL_ONLY` 里。
- 写盘前问余量：`whyNoSpace(dir, need, what)` 命中就 409 / 记进失败清单，一个字节都不落。
  量不到余量（没有 `statfsSync` / 目录不存在）一律放行，绝不把 `null` 当「不够」。

## 能力驱动与供应商

### 能力声明

模型支持什么（输入 role、参数取值、上限、默认值、布尔开关、输出格式、字数区间）只来自
`Capabilities` / `REGISTRY`：

- `Capabilities.specs(model)` / `modelsFor()` / `blockedRoles()` / `illegalPairs()` /
  `unsupportedRoles()` / `inputTemplate()` / `rule()` / `combos()` / `shapeState()`。
- 页面不许写死张数、参考图上限、默认值、下拉选项；平台没声明的那一档整档不画、一个字不发。
- 平台的接口怪癖也要声明化：`pollVia:'list'`、`cancelMethod`、`noPromptField`、
  `create.idempotencyKey`、`create.topBools`、`create.shapeFields`、`create.template`。
- 没有 `cancel` 端点就不许画能点的取消按钮；没有 `credits` 端点就不显示余额但保留勾选框（压暗 + title）。

### 供应商

- 新平台只改 `server/registry-config.js` 的 `REGISTRY.providers`（relay / base / keyEnv / endpoints /
  modelDocs / newModelDefaults / create / inputRoles / inputTemplates / refSyntax / uploadFields / pricing）。
  改了结构就把 `REGISTRY.version` +1。
- 「提示词里的素材引用怎么写」由 provider 级 `refSyntax` 声明：`{ picture, video, audio }` 三档模板
  （字符串是只有图片那一档的旧写法）。客户端提交前把规范的 `@参考图N` / `@视频N` / `@音频N`
  换成这一族（H3 是 `<Picture {n}>` / `<Video {n}>` / `<Audio {n}>`）；没声明就原样提交。
- 「资产号 → 最新下载地址」在哪一家换由顶层 `REGISTRY.assetStore` 声明（provider / retrieve /
  urlFields / mimeField）。`/asset/<id>`、渲染素材解析、本机补存三处都只问
  `resolveAssetStore()` 的结果，不再写死平台名或密钥名；没有声明就照实回「这家没有资产接口」。
- 「型号清单响应的数组落在哪个字段」也只由顶层 `REGISTRY.modelList.fields` 声明：页面 `Api.modelRows`
  与服务端 `/custom/models`（`modelRowsOf`）读同一份。
- 用户自定义中转走设置页「添加自定义供应商」：按类型（图片 / 视频 / 语音 / 文字）填表，存
  `sk_custom`，代理 `buildCustom` 整条克隆模板；relay `/custom/<id>`，密钥 `sk_key_<id>`。
- 内置平台也要先「添加一次」才进「供应商与密钥」卡；用官方地址添加自己是正常路径。
- 类型档：`image / video / audio / text`；文字 AI 的供应方、密钥、地址、型号、识图开关都在「文字」档里，
  一家一张卡。类型名与顺序只有 `ui.js` 的 `provKindZh` / `provKinds` 一份。
- **「供应商与密钥」是账号卡流**：
  · 归并按 `keyId`（`provGroups()`）：一个账号一张卡，卡顶那一排能力格只画这家会的几档
    （`.capcell`：强调描边 = 主位 / 淡底 = 在用 / 白底 = 备用 / 压暗 = 停用），一档一行
    （`.crow`：能力名 · 状态牌 · 文字档那一个型号下拉 + 测试 / 其余档「型号 n/m」就地展开清单）。
  · 等高竖排：列宽 `--sz-acct-w`（`auto-fill` 铺满），卡高 `--sz-acct`，卡内 `.acct-mid` 自己滚 ——
    展开密钥行、展开型号面板都不改卡的外形。型号面板摊开时钉住点中的那一行
    （`Wb.viewport.reveal(面板, { pin: 行 })`），多出的高度由 `.acct-mid` 内滚消化。
  · 密钥默认收着，开关是名字右边那颗 `.keytoggle`；名字本身链官网（↗）；
    接口地址不在卡上改（预设那几家一律走官方地址，中转站 / 网关加成自定义供应商）。
  · 型号面板按槽（`keyId:档`）存「展开的是哪一格 / 刚取回的那一份」，两档同时开着不会串档；
    落盘仍是账号级（`sk_model_<keyId>`、`.data/sk_model_prefs.json` 的 `typed` / `off` / `got`），
    面板里那一行 hint 照实说「按账号存」。没有「每档默认型号」这一层。
  · 添加供应商 = 卡片流末尾那张虚线卡，两个形态、同一张卡：常态列预设那几家（点「添加」请进界面并摊开
    密钥行，不写盘；填了密钥才由自动保存落 `sk_key_<keyId>`）；「＋ 自定义」让这张卡自己变成自定义表
    （右上角「返回预设」），没有第二套添加界面，字段在卡内 `.acct-mid` 里滚。这张表只收：接口形状 →
    显示名 → 地址 → 密钥 → 能力档位（与卡顶 `.capcell` 同一副图标、可多选：第一个是主档，决定接口形状
    与 kind；其余记成 `sk_caps_<id>` 手动声明）→ 型号。没有「供应商」那一格。
  · 手动加一档能力（`.capadd` / `MANUAL_OK`）：存 `sk_caps_<keyId>`（JSON 数组），`provGroups()` 并在
    `caps` 后面，`capProv()` 合成一条只用于界面的伪声明（`manual: true`、`endpoints` 空 → 型号面板
    没有「取一次」）。那一行挂「手动」标记、可撤掉。只有 `image / video / audio / asr` 能手动加：
    生成三档加完只是声明（真能出图还要注册表里一条端点声明，行里写明）；识别加完就能用（走这家自己的
    OpenAI 兼容 `/audio/transcriptions`）；搜索没有可通用的接口形状，不能手动加；
    文字对话不在这里加（`TextAI` 按 `kind: 'text'` 筛）。
  · 卡底右侧那枚余额与左侧栏「账户余额」是同一份：取数 / 解析 / `sb_bal_cache` 缓存只有 `sidebar.js` 的
    `balRowOf` 一份（设置页经 `window.SbBalance.rowOf` / `fetchRows` 读与补问），取回一轮广播
    `sb-balance-updated`，设置页只就地换那几枚。只有声明了 `endpoints.credits` 的账号有这一枚；
    「侧栏余额」那颗勾选只管左侧栏，不影响卡上这一枚。设置页只补问缓存里还没有的那几家 ——
    默认全勾时侧栏每一轮都问过，这边一个请求都不多发。
  · 按档筛的芯片（数字 = 账号数）+ 摘要条 + 排序（主位 / 在用 → 备用 → 没接上）。
  · 供应商那一排「图片 / 视频 / 语音 / 文字」分段开关已不存在；`sk_prov_tab` 只在 `LEGACY_KEYS` 里清盘，
    不要加回来 —— 一家账号一张卡之后，「当前哪一档」这个状态本身不存在。
- **语音识别（`asr`）与联网搜索（`search`）与四类平台同一层级，但不是一类平台**：
  · 它们是两档**真能力**：只有注册表里同时声明了 `extraCaps` 与端点声明（`asr` / `search`）的文字供应商，
    账号卡上才有「识」/「搜」那一行；没声明的家不画 —— 画上去点下去只会得到一次对不上的失败。
  · 设置与图片 / 视频同一套：**在线**那一块住在声明了这一档的那一家账号卡里那一行下面
    （`hostKidOf` 定「哪一张卡」：识别看 `asr.service.providerId`、搜索看 `search.provider`，
    没选时用自动那一家；一家都没声明就停在 `.acct-park`，屏幕上不画）。
    容器 id 仍是 `#asrCard` / `#searchCard`，由 `placeForms` 搬进 `[data-formslot]`。
    在线服务商 / 型号 / 地址 / 密钥在这一块里。
  · **本机 / 浏览器内识别是设置页合成的一张常驻账号卡**（`LOCAL_ASR_KID = '__local_asr__'`）：
    永远在账号卡流里、永远可用、不需要密钥；卡上是语音识别路线（auto / browser / local / service）、
    语言、本机运行包状态、浏览器内模型状态、测试识别。云供应商卡只留在线识别（型号 / 地址 / 密钥），
    两者不再混在一张卡上。设置仍存服务端 `.data/asr.json`。
  · 「本机环境」卡恢复成只读体检，不再放识别设置。
  · 服务端按声明调：`asr.style` 是 `openai`（multipart `/audio/transcriptions`，模型 / 返回格式 /
    语言放哪儿都按声明）或 `chat-audio`（chat/completions 的 `input_audio`，百炼 qwen3-asr-flash）；
    `search.style` 是 `api`（专用搜索接口，请求字段与结果字段在 `body` / `results` / `fields` 里映射）
    或 `chat`（对话接口里开联网 server tool，OpenRouter 的 `openrouter:web_search`）。
  · 没选渠道时 `provider` 为 `auto` / 空：服务端按「第一家声明了这一档且拿得到密钥」挑
    （搜索优先接口型，避免自动选中一个还缺对话型号的 chat 族）。
  · `MANUAL_OK` 只收 `image / video / audio / asr`：语音识别可以手动声明（走这家自己的
    OpenAI 兼容 `/audio/transcriptions`）；搜索接口各家形状不同，没有可通用的声明，不能手动加。
  · 自定义供应商克隆模板时 `extraCaps` / `asr` / `search` 一律摘掉（`CUSTOM_STRIP`）：那些端点属于模板那一家，
    安到用户自己的网关上就是错的地址。
  · 官方搜索接口（2026-10 起）：DeepSeek `POST /v1/tools/search`、智谱 `POST /paas/v4/web_search`、
    Kimi `POST /v1/tools/search_pro`、OpenRouter chat 的 `openrouter:web_search`。
    以前「联网搜索」是让对话模型输出网址 —— 模型没有联网，回的是一串编造的链接，那一版已删除。
- 显示名按「类型 + 编号」预填；同名会让型号下拉分组与收藏筛选项分不开。
- 自定义条目没有环境密钥回退，也不认 `x-up-base`（防止把 A 的密钥发到 B）。

### 转发闸

- 闸按「一家平台」算，键是 `keyId || id`；四档 `.env`：`RELAY_MAX_INFLIGHT`、`RELAY_QUEUE_MAX`、
  `RELAY_RETRY_MAX`、`RELAY_WAIT_MAX_MS`。
- 排满当场回本地 429 并写明「没有扣费」；退避重试只给 GET；名额必须恰好归还一次。
- 列表 / 详情短缓存命中与「挂同一条在途请求」都排在闸之前；被限流不进健康故障表。

## 数据与用户文件

### 绝不提交、绝不擅自删

- `.env`、`.data/`、`.renders/`、`.skills/`、`node_modules/` 都在 `.gitignore`。
  库根被指回项目内时那一族才是重点：`/成像/`（顶层）与根下的 `/图片/` `/视频/` `/音频/` `/其他/`
  `/提示词/`（跟着 `server/user-dirs.js` 的 `AUTOSAVE_TOP_DIR` / `PROMPTS_DIR_NAME` 与
  `server/local-assets-store.js` 的类型表），加上历史默认名 `.assets/` `文件/` `prompts/` ——
  里面装的是用户作品，一次 `git add -A` 就把几百 MB 媒体推进历史。它们是数据，不是缓存。
  斜杠钉在仓库根，不误伤 `web/` 与 `tests/` 里的同名子路径；探针那一族写成 `*data-probe*/` 这种
  「带不带前导点都挡」，因为手工命令里两种写法都出现过。
- 用户的工作区、历史、归档、素材是用户数据：清理前确认是测试残留，不要擅自删。
- 源码里绝不出现真实密钥；密钥只从 `.env` / 系统环境变量 / 设置页取。

### 写入可靠性

- 代理覆盖 / 删除 `.data/<key>` 前留 `<key>.bak.json`（最少 10 分钟，内容相同不留）。
- 「读不出来」绝不等于「本来就没有」：拿读取结果当写入底座的地方，必须像 `data-store.js` 那样
  再摸一次原始值；读坏就拒写并原样报错。
- 任务号一落盘就等于一次已付的钱：提交拿到 `taskId` 就写盘；删 / 放弃前先看是否还在跑；
  放弃走「不等了」（按 registry 的 `cancel` 端点撤单，撤不掉照实说「可能还在计费」）。
- 异步长任务抓住它自己那一集 / 那一条（`const mine = …`），收尾不要摸「当前」。
- 关标签前注册 flush / dirty：`window.__spaRegister(flush, dirty)`；导演台另写同步救生包
  `dir_ws_unload`（IndexedDB 异步，beforeunload 等不到）。
- **装配没完成之前一个字节都不许落盘**：导演台 `boot()` 读回工作区与把它挂上界面之间有一个网络往返的
  窗口，那段时间里的模块级 `WS` 还是空的默认值。关标签的 flush 与任何顺手排上的 `scheduleSave`
  都可能落在窗口里，把「一个工程都没有」同时盖进 IndexedDB 与 `.data/workspace.json`。
  两份落盘都先问 `web/director/engine.js` 的 `wsLoaded`（装配完成点置真）；判据
  `tests/e2e/director-boot-flush.cjs` 用拖慢 `/data` 的办法把窗口拉宽，复现那一次 flush。

### 本机资产身份

- 「同一份产物」只有 `web/domain/local.js` 的 `rowOfEntry` 一处：平台产物号优先，其次「任务号且整条任务只出一份」，
  再次本机号与来源地址（剥签名）。它查的是浏览器那张**当前会话的别名表**（`la_xxx` → 一行），
  表由代理现给：`GET /local-assets/aliases` 开机快照 + `POST /local-assets/locate` 批量补问
  （`server/local-assets-store.js` 的 `localAliases` / `localLocateBatch`，两边同一把尺子）。
- **双身份**（`server/local-assets-store.js`）：`fid` = `<dev>:<ino>`（必须按 bigint 取，普通 statSync
  把 64 位 ino 塞进 double，超过 2^53 就丢精度）+ 采样签名 `sig` = `<字节数>:<头尾各 1MB 的 sha1 前 16 位>`
  （imohash 那一族做法）。采样只用来认回，不用来证明「这两份是同一份东西所以可以删掉其中一份」。
- **三级认回**：相对路径 → `fid`（同卷改名 / 挪目录）→ `sig`（跨盘、换机、被同步盘重写一遍）。
  认回来把新的 `file` / `fid` / `sig` 一起写回账（认一次落一次）；三级全落空才说「文件不在了」，
  不假装还在，也不顺手删条目 —— 条目里还挂着回源外链与那笔费用。
- **磁盘对账**：列表 / 认回 / 用量共用一份 `dirScan` 快照（30 秒 TTL，只 readdir + stat 不读内容；
  真要比内容才按字节数分桶算签名）。盘上有、账里没有的成品由 `localAdopt` 补建，只补一次；
  同内容的那几份并成一条账（`altPaths`），不新开卡。
- **重复下载不许多张卡**：列表与用量按「同一上游产物号（剥签名）」或「同一内容签名」并成一张卡，
  压着的份数由 `duplicates` 报出来；这份判据只有 `localUpKey` + `sig` 一处，页面不另算一套。
- **删一张卡 = 收掉这一张卡背后的每一条账与每一份字节**（`localAssetSiblings` 与列表并卡同一把尺子）：
  只删眼前那一条，同组那一条下一轮又自成一张卡或留下一个「文件已不在」的空条 —— 用户看见「删了又回来」。
  文件删不掉就不许裁索引（回 500 照实说）。
- 「本机 / 云端」的读法只有 `AssetLocal.stateOf(entry)`；页面不许自己拼 `localAsset || hasLocalAddr(src)`。
- 自动镜像由应用级事件触发：`wb:asset-done`；`AssetLocal.watch` 统一接住并 scan。
  字节由代理流式落盘：`Api.saveLocalFromUrl` → `POST /local-assets/from-url`，不要 base64 大文件。
- **浏览器只留当前会话的别名表（内存），代理那一份账说了算**（`web/domain/local.js`，判据 `tests/local-first.cjs`）：
  开机取一次别名快照，列表加载时把没命中的那几条批量问一次代理；落盘回执与本机资产库列表就地补行。
  没有 localStorage / IndexedDB 副本 —— 那份按源（端口）分家的指针表换端口、清站点数据、换机器就整份失效，
  表现是「库根里文件明明在、卡上写着已丢失」。
  取表期间才落盘的行按发出时刻保住；服务端快照里没有的行被抹掉（账是真相）。
  磁盘对账补的裸行（无 `upstream`、无 `detail`）被 `offer` 按来源地址认出来时当场补上产物号 / 任务号，
  下一轮按产物号直接命中。开关只管 `scan` / `offer` 要不要为新产物取回字节。
- **表取回来之后，账里没有的本机身份不再算「本机」**（`local.js` 的 `libraryKnown` / `staleSelf`）：
  页面缓存（`assets_cache_v1` / `studio_tasks_cache_v1`）、收藏项与任务记录里都可能留着上一天的本机号
  （`/asset/la_*`、`mirrorKey`、自产条目的 assetId）。索引重建 / 本机文件被删之后这些号在别名表里查不到 ——
  `decorate` 把这一条退回平台地址，自产条目由 `staleSelf` 在进界面前摘掉，`/asset/la_*` 也不再算本机地址；
  否则卡上写着「本机+云端」、点开却是 404。表还没取回来（离线 / 开机第一帧）时「查不到」不等于「没有」，
  仍按条目自己带的标记算。
- 过期签名外链由公共层负责：`Api.mediaExpired` / `Api.healMedia` / `Api.mediaSrc`；
  页面不许自己判过期，也不许拿 assetId 拼 `/asset/<id>`。
- **云端取不到时由代理退回本机那一份**：`/getv`、`/fetch` 在上游 4xx/5xx、域名解析不了时，
  按账里记的来源地址（`localUpKey`，签名不参与）认出本机副本并发本地字节（Range 照旧；同一地址
  一分钟内直接发本机，不再每条 Range 都撞一次 403）；`/asset/<平台产物号>` 按 `detail.asset` 先找
  本机（任务号只在整条任务只出一份时认）。`resolveSrc`（FCPXML / ASR / 补存）同样本机优先。
  判据在 `server/local-assets-store.js` 的 `localEntryByUpstream` / `localEntryByPlatformId`
  （`tests/local-fallback.cjs` 常驻 + `tests/e2e/local-chain.cjs` 线上那一半）——
  浏览器别名表只是当前会话的缓存（换端口 / 清浏览器数据 / 换机器都会空），
  它不是「本机有没有这份字节」的唯一凭据，云端被清理后画面不能跟着坏。
- **磁盘对账补的那一族裸行按字节认回**：`localAdopt` 建出来的行没有 `upstream`、没有 `detail`，
  按来源地址与按平台产物号两头都查不到 —— 字节明明在库根里，卡片仍判成「没存过」。
  `POST /local-assets/from-url` 在取回字节之后、落新文件之前，按采样签名找**两头都没有身份**的那一行，
  把来源地址与平台号补写到它上面（回 `reused:true`，不落第二份字节、不开第二条账）：
  「存回本机」因此兼是修复，坏掉那一张按一次就认回来。已经有 `detail.asset` / `detail.task` 的那一行不许盖 ——
  同内容的另一份产物不是同一件事，接错比不接更糟。判据 `tests/local-byte-reclaim.cjs`（装真路由，取字节换成探针）。
- **「已丢失」角标只许盖住它自己那一张图**（`web/domain/local.js` 的 `lostTip`）：
  `.lost-tip` 是 `position:absolute; inset:0`，铺开的是最近的定位祖先 —— 灯箱的舞台、检查器那格大图、
  详情层候选排那一格都不是定位容器，不管就变成「点一下素材卡，整屏一块已丢失」。
  所以角标按图自己的盒子定位；媒体槽也该自己定位（`.timg, .thumb, .sthumb-wrap` 已经这么写，
  页面自己的槽照着补 `position: relative`）。判据 `tests/e2e/ui-contract.cjs`：角标不许比它那一格更大。
- 读写链路的判据：`tests/e2e/local-chain.cjs`（新默认根下的落点 / 双身份 / 改名挪目录认回 /
  重复下载并成一张卡 / 删一张卡带走 altPaths / 磁盘对账只补一次）。它不开 Chrome，只起隔离实例，
  并且每一条都点名 `.*-probe` 假根，跑完自己清干净。

### 云同步

- `POST /cloud/sync`（双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
- 冲突判定靠 `.data/.cloud-state.json` 基线；不要退回「只看时间取新」。
- 远端存在但读不下来 → 判 `error` 跳过，绝不 push；本地删除必须真正执行到底。
- 浏览器对账体积相同不能直接跳过（等长修改）；对账期间本地写入先进 held 暂存表。

### Git 远端与推送

- 远端只有一个：`https://github.com/ycwba/imago.git`。它在本地克隆里的别名不固定
  （本机这份是 `origin`，另一份工作副本里叫 `github`）—— 所以别按远端名写命令：
  `main` 跟踪哪个远端就跑裸 `git push` / `git pull`，那才是稳的。判据 `tests/doc-contract.cjs`
  盯的是地址，不是别名。
- 远端 `main` 是真实历史。此前远端还有一个与本地无共同祖先的孤儿快照提交，该快照保留在远端的
  `archive/snapshot-gh` 分支。看到「有共同祖先为零的另一个根提交」不是历史断了，
  不要去 `--allow-unrelated-histories` 合并它：那是同一份代码的旧快照，合并只会把旧状态搅回新历史。

## 公共层：唯一实现清单

「同一个功能只应有一份实现」。页面要用下列能力，只能走公共层；发现重复实现先收敛。

| 能力 | 唯一实现 |
| --- | --- |
| 下拉 / 浮层 | `web/ui/ui.js` 的 `Dropdowns`（程序化改完 options 后 `Dropdowns.sync(select)`） |
| 网络 | `web/ui/net.js` 的 `Net`（超时 / 重试 / `NUMS` / `num` / `storedNum` / `setNum`） |
| 本地存储 | `web/ui/store.js` 的 `Store`（信封 / 上限 / `sweep`） |
| IndexedDB | `web/ui/kv.js` 的 `Kv.at(登记名)`（登记表只有一份） |
| 提示 | `web/ui/toast.js` 的 `Toast`（`Toast.after` 只用于刷新后那一句） |
| 图标 / 加载 / 空态 | `icon()`（`web/ui/ui.js`）/ `.ui-wait` / `.empty`（按钮里带图标时不许用 `textContent` 改字） |
| 数据同步 | `web/ui/datasync.js` 的 `DataSync` |
| 弹窗 / 确认 | `UiDialog` / `Confirm.ask` / `Confirm.arm` / `Confirm.choose` |
| 分段 / 芯片 | `ui-seg` / `Chips.render` / `AiChip.paint` |
| AI 挑几条 / 就地润色 / 提示词表单 | `AiFind.run` / `InlinePolish` / `PromptForm`（正文六句只在 `TextAI`）；`AiFind.run` 先 **await 页面的重画**再写回执 —— 素材库 / 收藏的 render 是异步的，反过来的话失败 / 没挑到那一句会被「N 项」覆盖，看起来像点了没反应 |
| 「拆成几张 / 按什么维度拆」那一排选项 | `SplitPlan`（`web/ui/forms.js`）：工作台图像栏「拆分片段生成」与导演台右栏「按描述生成这一镜的画面」共用这一份 —— 张数档与维度档（`FAM[家]`）、那一排的 HTML（`html`）、读 DOM（`read`，节点取手由页面交进来，件内不查 `document`）、发给文字 AI 的「张数：…／拆分维度：…」那两行（`userLines`）都只在这里。两家的契约仍然分开（工作台 `img_split.json`、导演台 `story.json`），共享的是控制面与那两行的写法；当前值由调用方拿着（导演台右栏每 3 秒整片重画，存 DOM 会被抹掉），「自动」那句报的张数范围必须与各家契约正文里的兜底那一条一致（判据 `tests/split-plan.mjs`） |
| 「让 AI 干一件事」那颗按钮的外观 | `aiBtnHTML` / `aiBtnState`（`web/ui/ui.js`）：页面里的动作按钮外壳只有 `.tool.acc` + `.ic` 图标 + `.tx` 一行字这一种；忙与闲只换 `.tx`，那两句话挂在节点的 `data-idle` / `data-busy` 上，整栏重画（导演台右栏每 3 秒一次）也不会丢当前状态。**名字与说明句在各家族那一份里**：润色类 `InlinePolish.btnHTML`（作用域只写进 title，按钮上那行字全站同一句「AI 润色」）、AI 搜索类 `AiFind.btnHTML`（`LABEL` / `BUSY` / `TITLE` / `failText` 只在那一处；外壳按**搜索组件**画成 `.fb-ai`，与输入框同高、同档小圆角（`--radius-6`，与「多选 / 刷新」一致）、不带图标，不是紫色动作按钮）；页面不许自己拼 `<button class="tool acc">` / `<button class="fb-ai">` 或忙时重写 innerHTML（判据 `tests/selfcheck.cjs` §5b） |
| 页面尺寸 | `pageModeOf` / `pageSizeOf` / `PAGE_TARGETS` |
| 页面样式表挂载 / 模块预取 | `web/core/page-css.js` 的 `ensureCss` / `preloadModule`（全站唯一的 `createElement('link')`；样式表地址按文档根解析，模块地址按 `web/app.js` 解析 —— 与动态 `import()` 同一基准）。样式表路径只在 `WB_ROUTES.pages[].css` 存一份，挂载点在 `web/app.js` 的页面 loader；预取与真正切页共用这两份去重表 |
| 侧栏（导航项与它们的文案） | `web/core/routes.js` 的 `WB_ROUTES.pages`：每一页一行，`label` 是全名（满形态显示、悬停名牌念它、读屏 `aria-label` 用它），`short` 是两字短标签（窄形态压在图标下面）—— 侧栏不许另抄一份 |
| 可拖动分栏 | `Wb.split.enable`（把手 DOM 与落盘都在这一份；工作台两栏与导演台三栏共用，键分别是 `wb_split` / `dir_split`；`axis:'y'` 是上下那条 —— 导演台底栏轨道坞走它，键 `dir_dock`，高度落在 `.page-main` 的 `--dock-h`；变量名 = CSS 里的名字：`varName:'dock-h'` 写出的是 `--dock-h`，写成 `dock_h` 就落到 `--dock_h` 上，CSS 读不到） |
| 批量下载 | `Wb.downloadList`（资产库 / 工作台共用一份：逐条下载 + 进度 + 成功失败计数） |
| 多选 | `Wb.multi`（资产库 / 工作台共用一份：勾选集合 + 全选 / 取消全选 + 批量条那三处读数；页面只给 `keyOf` / `visible` / `onChange` / `mode`） |
| 跳页 | `GoPage.go`（同文档走 `window.appShow`） |
| 媒体 | `web/domain/api.js` 的 `Api.mediaSrc` / `Api.mediaKey` / `Api.mediaExpired` / `Api.healMedia` |
| 接口 / 统一取数 | `web/domain/api.js` 的 `Api`（`request` / `create` / `createBody` / `pollTask` / `list` / 余额）+ 顶层 `netFetch` / `respBody` / `classifyStatus` |
| 资产 | `AssetLib` / `AssetLocal` / `AssetTransfer` / `AssetPicker`（`AssetLib` 列表与费用口径在 `assetlib.js`） |
| 多选点选语义 | `PickSel`（`web/ui/ui.js`；AssetPicker 与素材库挑选共用一份） |
| 本机 / 云端徽标 | `badgeOf` / `badgeHTML`（`web/ui/badge-state.js`）+ `AssetLocal.stateOf` |
| 素材身份（两个地址是不是同一份产物） | `web/domain/ident.cjs` 的 `upKeyOf` / `innerMedia`（UMD 双模式：浏览器挂 `window.MediaId`、Node `require` 同一份；必须是 .cjs —— `web/package.json` 的 type:module 会把 .js 当 ESM） |
| 拖素材的引用载荷 | `web/domain/asset-ref.cjs` 的 `set` / `read` / `isRef` / `label`（UMD + 必须是 .cjs；浏览器挂 `window.AssetRef`，Node 默认导入）。四个拖动源与球 / 抽屉两个落点都只经这一份，字段白名单也只有这里 |
| 任务 | `Wb.poller` / `Wb.History` / `Wb.detail` / `Wb.cards` / `Wb.pager` / `Wb.viewToggle` + `VIEW_MODES` |
| 卡片展开 / 锚定 | `Wb.expand` / `Wb.close` / `Wb.closeAll` / `Wb.anchor`（资产库与收藏页共用） |
| 缩略图 / 视频预览 | `Wb.thumbs.mediaHTML` + `Wb.thumbs.keyOf` + `Wb.thumbs.bind`（键先剥签名） |
| 灯箱 | `Wb.lightbox` |
| 下载 | `Wb.save` → `Net.save` |
| 视频取帧 / 媒体信息 | `web/media-backend.js` 的 `MediaBackend`（mediabunny 主档 + `<video>` 兜底；`info` / `frame` / `thumbs` / `probe`）。`createElement('video')` 只许出现在这一份里，`Wb.vframe` 只是转发壳 |
| 浏览器内导出 | `web/media-export.js` 的 `MediaExport`（帧计划 / 合成 / 混音 / mediabunny `Output`；成片、素材、参考视频补音轨 `ensureAudioTrack` 都走它）。服务端没有 ffmpeg |
| 导出目录 | `web/domain/export-dir.js` 的 `ExportDir`（File System Access 句柄管理） |
| 成片模型（时间真相） | `web/director/film.js`（顺序 clips / 定时配音 / 字幕成片秒 / 标记 / 转场 / 行打包 / 行列眼睛与锁 / 进片闸 / 台词行；折算口 `rateOf` / `srcHeadOf` / `srcUsedOf` / `srcLenOf`；判据 `tests/director-film.mjs`） |
| 时间线编辑纯件 | `web/director/tl-cut.js` / `tl-resize.js` / `tl-ripple.js` / `tl-reorder.js` / `tl-snap.js` / `tl-scale.js` / `tl-peaks.js` / `tl-markers.js` / `tl-autoscroll.js`（切刀融合 / 裁剪滑移滑动 / 波纹 / 重排跨行 / 吸附 / 比例尺刻度 / 波形 / 标记；判据 `tests/director-tl-edit.mjs`） |
| 胶片条与取帧 | `web/director/tl-filmstrip.js`（显示层帧计划）+ `web/director/slice.js`（数据层帧索引预算）+ `engine/frames.js`（解码 / 缓存 / 退避）；判据 `tests/director-strip.mjs`、`tests/director-slice.mjs` |
| 切片帧打包 / 编码 | `web/director/slice-pack.js`（`SLICES02` 打包 / 解包）+ `web/director/slice-worker.js`（JPEG 编码 worker，只编码不 seek / 解码）；判据 `tests/director-slice-pack.mjs` |
| 导演台拆分镜 / 请求预览 / 候选地址 / 小纯函数 | `web/director/board.js` / `split-assets.js` / `board-preview.js` / `media.js` / `util.js`（拆分镜、这一镜将要发出的请求体、候选身份 → 预览 / 导出地址、导演台小纯函数） |
| FCPXML 拼装 | `web/director/fcpxml.js`（单文件 / 媒体包 zip / 持久工程目录三档共用 `buildFCPXML`；转场按 FCPXML 1.10 的居中重叠写 `<transition>`，字幕样式写 `text-style`，不绑定任何剪辑软件） |
| 浏览器内 ASR worker | `web/director/asr-worker.js`（module worker，Whisper q8；模型只走同源 `/models/`，`allowRemoteModels` 关死；取消 = `terminate()`，绝不回落主线程） |
| 用户目录根 | `server/user-dirs.js`（`systemDownloadsDir` / `downloadsRoot` / `promptsRoot` / `AUTOSAVE_TOP_DIR`；系统下载文件夹按注册表 KNOWNFOLDERID 取，不猜 `HOME\Downloads`） |
| 本机资产库根（本体住在哪） | `server/local-root.js`（`ASSETS_DIR` > `.data/sk_local_dir.json` > `下载\成像`；设置页那一格写 `sk_local_dir`，由 `DataSync` 镜像成盘上那份 JSON —— 那份的正文就是 localStorage 原值：字符串类的键走 `window.LS.set`，落盘是裸文本（`D:\作品`，不是 JSON），只有对象类的键才是 `Store` 的信封 `{"data":…,"ts":…}`；读错形状不报错，表现是「改了位置、产物还往老地方写」，判据 `tests/local-root.cjs`） |
| 本体的落点与可移植身份 | `server/local-assets-store.js`（`bodyDirNameOf` / `newBodyPlace` / `fileFidOf` / `localSigOf` / `localAdopt`；层内那份目录对账快照 `dirScan` 只此一份，外面不许再 readdir 一遍） |
| 一张「卡」背后那几条账 | `server/local-assets-store.js` 的 `localAssetSiblings`（与列表并卡同一把尺子：`localUpKey` 或 `sig`） |
| 云端取不到时的本机回退 | `server/local-assets-store.js` 的 `localEntryByUpstream` / `localEntryByPlatformId`（`/getv`、`/fetch`、`/asset` 与 `resolveSrc` 共用；浏览器别名表只是当前会话的缓存，不是唯一凭据） |
| 本机产物别名（哪条产物在本机是哪一份） | `web/domain/local.js` 的 `rowOfEntry` / `twinOf` / `decorate` + 代理 `/local-assets/aliases` / `/local-assets/locate`（`server/local-assets-store.js` 的 `aliasRowOf` / `localAliases` / `localLocateBatch`）；判据 `tests/local-first.cjs` |
| 缩略图 / 切片缓存 | `/cache/{thumbs,slices}`（`server/routes/cache.js`；跨 origin 有效，浏览器 IndexedDB 不是持久层） |
| 能力声明 | `web/domain/capabilities.js` 的 `Capabilities` |
| 语音识别走哪条路 / 进度与扣费文案 | `web/domain/asr.js` 的 `pickRoute` / `stageText` / `routeLabel`（设置页、导演台、助手回执都只翻译这三枚） |
| 浏览器内 ASR 的算法 | `web/director/asr-text.js`（WAV 拆 PCM / 词级成段 / 转写清洗与可疑判定；worker 与 Node 判据共用同一份） |
| ASR 模型代下载与模型状态 | `server/routes/models.js`（`/models/<id>/<file>` + `/models/status`；双镜像按序试、每一跳过出站护栏、`.part` 原子改名、同一文件单飞） |
| 文字 AI | `web/domain/text-ai.js` 的 `TextAI`（含 `polishImages` / `qaOf` 契约） |
| 提示词归档 | `web/domain/prompt-log.js` 的 `PromptLog` |
| 收藏 | `web/domain/fav.js` 的 `Fav` |
| 素材库 | `web/domain/chars.js` 的 `Chars`（`Lib` / `Pipe` / `SET`） |
| 语义检索 | `web/domain/semantic.js` 的 `SemanticSearch.rank` |
| 导演台台词面板 | `web/director/film.js` 的 `speakerOf` / `lineTimeOf` / `lineRowHTML`（剪辑右栏「台词」那一档与配音列表共用） |
| 导演台导出格式 | `web/domain/export-formats.js`（页头按钮 / `export_start` 分派 / 助手枚举与文案都读这一张表） |
| 字幕 SRT | `web/director/srt.js`（`srtParse` / `srtSerialize` / `resegment`；时间一律成片秒） |
| 导演台剧本视图 | `web/director/script.js` 的 `scriptTextOf` / `parseScript` / `applyScript`（按分镜现算，写入只落 `sh.prompt`） |
| 导演台接续与批量调度 | `web/director/chain.js` 的 `shotPlacement` / `chainDeps` / `splitLongShots` / `pickChainModel` / `chainModelRepick` / `quoteKeyOf` / `sumQuotes` / `runWithDeps`（engine 只调用） |
| 场景镜头命名 | `web/director/naming.js` 的 `sceneShotBase` / `candidateBase` / `voiceBase` / `clipLabel` / `stripExt` / `withExt` / `uniqueName` |
| 导演台项目组 | `web/director/groups.js` 的 `list` / `groupOf` / `assetGroupName` / `ensure` / `rename` / `remove` / `assign` / `tree`（组名即素材组名） |
| 拆分镜的新素材 | `web/director/board-assets.js` 的 `plan` / `stage` / `repeatCounts` / `pendingIn` / `resolve` / `shotsPending` / `libSpec` |
| 一镜素材的编号与引用语法 | `web/director/ref-plan.js` 的 `shotRefPlanOf` / `tokenizeRefPrompt` / `applyProviderRefSyntax`（首帧 → 尾帧 → 画面切片 → 参考图 → 参考视频 → 参考音频；芯片 / 润色附图 / 预览 / 提交体同源；平台语法由 registry 的 `refSyntax` 声明） |
| 发送前的请求预览 | `web/domain/api.js` 的 `buildBody` / `preview`（与 `create` 同源，预览 = 纯算，不发网络请求） |
| 原始请求面板 | `window.RawRequest`（`web/ui/raw-request.js`；按需补载；一栏预览、一栏实发并排，标题一枚状态标；不含 headers / 密钥，只在页面会话内存） |
| Skill 正文里的变量占位符 | `web/domain/gen-forms.js` 的 `window.TplVars`（`fill` / `names`；「项目引用规则」就是它） |
| 导演台的变量填料 | `web/director/board-vars.js` 的 `castOf` / `assetsOf` / `vars`（角色表 / 选中素材 / 现有分镜 / 时长区间） |
| Skill | `web/ui/skills.js` 的 `WbSkills`（含 `refRule`：素材范围优先） |
| Skill 的使用场景 | `web/domain/text-ai.js` 的 `SKILL_SCENE_GROUPS` / `SKILL_SCENES`（分组 + 场景；场景名与「用在哪」沿用 `PROMPTS`，变量说明在 `SKILL_VARS`） |
| 设置页的目录轨 | `web/pages/settings.js` 的 `groupEls` / `cardsOf` / `navTitleOf` / `NAV_VALUE`（全部从 DOM 现读；JS 里不许有第二份清单，也不许另存一份状态） |
| 设置页「供应商与密钥」的账号卡流 | `web/pages/settings/accounts.js` 的 `createAccountCards(deps)`：`provGroups` / `capProv` / `capState` / `priKidOf` / `autoServiceKid` / `hostKidOf` / `accountCardHTML` / `capRowHTML` / `modelPanelHTML` / `placeForms` / `manualCapsOf` / `setManualCaps` / `localAccountCardHTML`；型号面板的槽名 `slotKey` / `provBySlot` 与档位名图标 `capZh` / `capGlyph` 也只在这一份里。页面经 deps 递进注册表 / 环境密钥 / 型号面板读写 / 自动保存的现取口，卡片自己的草稿与槽位不在页面留第二份 |
| 设置页的两条通道（语音识别 / 联网搜索） | 通道自己的状态与选项在 `web/pages/settings.js`：`serviceProvOpts` / `syncServiceProvs` / `asrProvider` / `asrModelPh` / `searchEngineName` / `searchNeedsModel`；「哪张卡收这一档、表单搬到哪」跟着账号卡流住在 `web/pages/settings/accounts.js`（`LOCAL_ASR_KID` / `localAccountCardHTML` / `hostKidOf` / `placeForms` / `asrEffectiveRoute`）。在线表单在 `.acct-park`，画完网格搬进声明了这一档的云供应商卡；本机 / 浏览器内的表单在常驻的本机识别账号卡里；服务端按注册表的 `asr` / `search` 声明调 |
| 中文名 / 类型 | `ui.js` 的 `provKindZh` / `provKinds`、`isAudioType` / `mediaKindOf` / `fileExtOf`、文件类型档的档位与顺序 `mediaKindTabs` / `mediaKindRank`（全部 → 视频 → 图片 → 音频） |
| 字数闸 | `gen-forms.js` 的 `CharLimits`（`bounds` / `tts` / `prompt` / `why` / `cntLine`） |
| 配音合成设置 | `web/domain/gen-forms.js` 的 `TtsAdv` + `AdvExtras` |
| 音色说明 | `window.VoiceNote.run`（取音色描述）/ `window.VoiceNote.runClone`（拿另一位素材的声音克隆） |
| 音色写回素材库 | `web/domain/chars.js` 的 `Chars.Pipe.saveVoiceNote`（按名字找人；已有描述不覆盖） |
| 音色克隆（两种源） | `Chars.Pipe.cloneFromCands` / `Chars.Pipe.cloneFromLibEntry` —— 同一落点（`refAudio` + `voiceMode='clone'`） |
| 格式化 | `Wb.fmtSec` / `fmtClock` / `fmtWhen` / `fmtWhenSec` / `fmtHM` / `fmtHMS`；`ui.js` 的 `dayKey` |
| 文件名 | `fileSafe` / `fileStamp`（浏览器与 Node 各一份，是登记在案的例外） |
| 设置项清单 | `web/ui/ui.js` 的 `window.UI_PREFS`（`rows` / `groups` 一份派生导出、同步、恢复默认与助手白名单） |
| 主题解析 | `web/shell-boot.js` 的 `window.__themeApply`（唯一一处把偏好解析成 `data-theme` + `data-palette`；「跟随系统」听 `matchMedia`；解析完广播 `sb:theme-applied`） |
| 侧栏「换背景」的日 / 月图标 | `web/ui/sidebar.js` 的 `window.__sbThemeIcon`（每次解析完成后由 `shell-boot` 回调；按钮点击按解析后那一档取反并钉住） |
| 账户余额取数 / 缓存 | `web/ui/sidebar.js` 的 `balRowOf` + `BAL_KEY`（`sb_bal_cache`）+ `window.SbBalance.rowOf` / `fetchRows` + `sb-balance-updated` 事件；侧栏余额卡与设置页账号卡同读这一份 |
| 「现在能不能按生成」 | `web/domain/gen-rules.js` 的 `window.GenRules`（页面与助手都只翻译它给的原因码） |
| 客户端错误出口 | `web/core/report.js` 的 `window.PageReport`（页面主动报只有 `pageFail`；`fatal` / `warn` 由两个 window 监听器发出 → `POST /client-error` → 代理健康账） |
| 视口不许被重画甩回顶 | `web/ui/workbench.js` 的 `Wb.viewport`（`keep(host, fn, opts)` 按锚点在重画后把容器里的滚动位还回去，横向 scrollLeft 同一趟一起还；`opts.outer` 连外面那只在滚的祖先一起稳住；`host(el)` 从一处往上找最近一只真能滚的容器；`reveal(块, { pin })` 就地展开时最小滚动露块、用点中的那一行夹住；「点一颗按钮，视角跳到最上面」就是这一族） |
| 页头与列表之间的几何 | `web/ui/workbench.js` 的 `Wb.pageHead`（`track(root)` 量直接子级 `.phead` 并写 `--phead-h`，多选条 `.bulkbar` 的粘顶位读它；`scrollToList(root, el)` 给 `.page-shell` 滚到列表顶，扣掉页头与开着的多选条高度。资产库 / 收藏页在挂载时 `track`、卸载时断开） |
| 程序性 focus 不抢视口 | `web/ui/ui.js` 的 `window.focusQuiet(el)`（`focus({ preventScroll: true })`） |
| 文件类型筛选 | `web/ui/workbench.js` 的 `Wb.kindFilter`（`.ui-seg` 分段 + 每档计数 `.seg-n`；档位集合不变时不重建 DOM；**页面给的每一档恒画**，计数为 0 也不藏；顺序由公共件按 `mediaKindRank` 现排，页面给的数组顺序不作数）。工作台 / 收藏 / 资产库三页的档位表都取 `window.mediaKindTabs(allKey)` —— 四档一次给全，不许按「这一屏出现过的类型」现攒 |
| 筛选工具条（搜索框 / 芯片 / AI 搜索 / 计数） | `web/ui/workbench.js` 的 `Wb.filterBar`（结构与接线只有 `bind` 这一份；就地改文本、不整片重画）。搜索只有三条出口：回车 / 失焦 = 普通搜索，清空输入框 = 当场取消筛选（普通词与 AI 条件一起收回）；**不画独立的「搜索」按钮**。AI 已经把框里那句消化成条件 / 挑选集合时，页面调 `markApplied(text)` 登记 —— 失焦不会再当普通搜索重跑；页面的普通搜索会把 AI 条件收回（换词 = 重新找） |
| 本机索引写入口 | `server/index-store.js` 的 `update(fn)` 串行队列 + `putInto` / `dropFrom`（跨 await 的读-改-写只能走这一处） |
| 一行素材的身份键 | `AssetLib.entryKey`（页面与缓存）；裸工作台任务记录用 `Wb.taskKey` |

## Vue SPA

- **vendored 依赖（运行时零构建的唯一例外，`package.json` 不加运行时依赖）**：
  `vue.runtime.esm-browser.prod.js`、`web/vendor/mediabunny.min.mjs`、`web/vendor/mediabunny-aac-encoder.min.js`、
  `web/vendor/asr/`（`@huggingface/transformers` + ONNX Runtime 的胶水与 `.wasm`）。全部按需加载，首屏不带。
- `web/app.js` 是唯一外壳：hash 路由 + `<KeepAlive>` 页面池；切页只离屏、不销毁。
  页面 DOM、滚动位置、筛选与多选状态都留在原地。
- 路由表只有 `web/core/routes.js` 的 `WB_ROUTES`：页面文件 / id / 侧栏名（`label` 与两字 `short`）/
  图标 / 标题 / 组件地址 `src` / 私有样式表 `css` / 页面根类 `root` / 挂载前要补的公共件 `needs` /
  挂载后还要再 import 的 `chunk` / 是否进侧栏 `nav` / 旧地址别名都从这里读。外壳的页面组件映射由这张表现搭；
  新增页面只改这一处，不在 `web/app.js` 或页面里另抄一份映射（`tests/spa.cjs` 拦）。
  `src` / `chunk` 相对 `web/app.js` 解析（与动态 `import()` 同基准），`css` 相对外壳文档（根）。
- **每页的加载链只在 `web/app.js` 的 loader 里拼一次**：`preloadModule(src)` + `chunk` 先发出去取字节
  （modulepreload 只取字节不执行，执行时机由那次 `import()` 定），`needs` 补载与 `import(src)` 求值
  **并行走**（`Promise.all`）—— needs 的全局没有一处被页面模块在求值期硬读（导演台右栏的
  `ROLE_ZH` 由 engine/panel.js 迟取现查；页面运行后才用到的都带 `window.Capabilities &&` 守卫），
  两侧没有先后依赖。页面组件里不写 `ensureCss`（路径只在路由表存一份）。
- **预取**（`window.__spaPrefetch(file)`）：把某一页的整条链提前发出去，与切页那一路共用同一批去重表。
  两个入口：`load` 之后按 250ms 一拍一页（当前页除外，`web/app.js` 的 `schedulePrefetch`）；
  侧栏每一项的 `mouseenter` / `focus`（`web/ui/sidebar.js`）。预取失败不落缓存，真正切页时照常重试。
- 切页可见性：`spa:page` 事件与 `window.__spaActivity.visible()`；隐藏页的轮询 / 抽帧 / 缩略图要停。
- `window.__*` 是跨脚本层的钩子（经典脚本没法 import ESM，只这一族能跨过去），不是第二套公共接口：
  开了就要有人读，页面自己挂的那一枚必须在卸载时清掉（`delete` 或赋 `null`），否则钩子一直指着
  已经离屏的那一页。判据 G8 当场数这两条，新增一条就红；要留（比如只给探针观测）必须在 G8 表里写清原因。
- 助手读当前页快照走 `page-context.js` 的 `__acPageCtx`，不要靠扫 DOM 猜。

## 导演台

### 边界

- `web/director/index.js`：Vue 页面组件 + 作用域岛（模板 HTML、样式、生命周期、`WBBridge` 安装）。
- `web/director/template.html`：导演台真实 DOM 模板（不是 Vue 模板，不参与预编译）。
  它内嵌的 `<style>` 块是全站唯一的例外：`index.js` 运行时把这一块取出来，
  以 `@scope (.director-page)` 注入 —— 导演台是作用域岛，样式必须跟着模板一起被取用。
  那块里的取值同样走令牌。
- `web/director/engine.js`：命令式热路径的状态与接线；**这一层里的代码按域机械搬进
  `web/director/engine/*.js`**，每一枚 `createX(E, document, window)` 只收 engine 递进来的访问器与函数
  （`document` / `window` 用参数名遮蔽，作用域岛递进来的两份代理继续生效）。engine.js 继续持有工程数据
  与可变状态，模块里不留第二份（E 装配漏名字是运行到才炸的错：模块解构出 `undefined`，语法档与 vm 自检
  都看不见 —— 新增域模块时，engine 里那份 E 名单要与模块顶部解构逐名对着改，`tests/director-e-deps.cjs`
  当场数这两份名单）：
  - `gen.js`：分镜提交、平台任务轮询、自动镜像投递与「生成全部分镜」的依赖式批量调度
  - `frames.js`：取帧、帧缓存与退避重试（`sliceKey` 稳定键 / `SLICE_FAIL_TTL` / `sliceRetryIn` /
    `fillSlices` / `sliceForgetFail`）；数据层帧索引来自 `slice.js`，显示层格数来自 `tl-filmstrip.js`
  - `timeline.js`：时间轴板的渲染与比例尺 —— `#tlTools` 工具条就地刷、`#tlRuler*` 刻度、
    `#tlPlayhead` 针层、`#tlScroll > #tlContent` 视口与内容层、`.tl-lane` / `.tl-track` / `.tl-strip` /
    `.tl-clip` / `.tl-junction` / `.tl-marker` / `.tl-voice` / `.tl-cap` 的排布、缩放与三秒重建的滚动还原
  - `strip.js`：一条画面段的胶片格绘制（`.tl-strip` + `i.tl-fr` 定宽磁贴，图片段平铺、缺帧斜纹占位、
    同一排地址不重画）与 `.tl-cap` 的字幕块内容
  - `edit.js`：板上交互（点选 / 六档选择工具 / 拖把手 / 换序换行 / 吸附 / 波纹 / 标记面板 / 右键菜单 /
    工具条全量动作）与写 film 的唯一出口 `commit` / `patchFilm`（都经 `beginEdit` 压快照）
  - `play.js`：预览播放核（双甲板接力、转场窗口、字幕按起止进出、配音起播、主时钟对齐、片尾停住）
  - `caption.js`：字幕域（右栏清单、SRT 入出、浏览器内识别入口、重切、`capSetText` / `capSetTime` /
    `capSetStyle` / `capDelete` / `capAddEntries` 这几个写口）
  - `voice.js`：配音的数据侧（时长、音色方式、位置、登记）与右栏配音列（`#vcTabs` 六档 + 入出点两框）
  - `mid.js`：中间栏整列渲染（预览甲板 + 候选条 + 动作行 + 总长）与剪辑 / 生成两态的切换。
    候选条右侧的展开 / 翻条 / 「1 / 2」是浮在缩略图右缘的一枚小控件（绝对定位，不占排版宽度）；
    剪辑态预览与生成态同一副尺寸。中栏是 `#midCol > #midBody（整片重画）+ #shotStripHost（常驻的镜头顺序条）`：
    顺序条只属于生成态，高度按内容封顶，不提供上下拖高。
  - `panel.js`：右栏镜头编辑器（型号清单、输入槽位与 role、组合与互斥、参数表单）；
    「按描述生成这一镜的画面」那一排张数 / 拆分维度选项由公共件 `SplitPlan`（`dir` 那一族）画，
    当前值存在 engine 的模块变量里并随高级参数同一枚键落盘 —— 这一栏每 3 秒整片重画，存 DOM 会被抹掉
  - `apply.js`：AI 拆分镜与改稿的落盘（新素材建档 + `@待建:` 占位符 + 分镜写入）；
    拆分镜 / 改稿前的「AI 反问」与过程面板也在这里（`askRound` + `splitUI` 状态 + `renderSplitPanel`
    重画钩子，宿主与润色面板同为 `#polishInline`）
  - `export.js`：渲染计划唯一组表 `buildRenderPlan()`（段顺序与起点、进片闸后的配音与字幕、每句在哪一行、
    本机优先地址）、导出成片（浏览器内合成，`MediaExport`）、FCPXML 三档（`Export.fcp` 单文件 / 媒体包，
    `Export.project` 持久工程目录 + 打开文件夹）；三档与助手 `export_start` 共用 `fcpCtx()`；服务端没有渲染任务账
  - `bridge.js`：`WBBridge.director` 的 `check` / `run`（助手写入桥，按身份对账）
- 纯算法按域拆开，engine 只调用；每一份的落点、函数与判据在「公共层：唯一实现清单」的导演台各行
  （`film` / `slice` / `tl-*` / `srt` / `script` / `board*` / `groups` / `chain` / `naming` / `media` /
  `fcpxml` / `asr-text` / `asr-worker` / `util`）。改算法先改模块，engine 只留调用与状态，不要在 engine 里再抄一份。
- **一镜素材的编号与发送顺序只有一份**（`ref-plan.js` 的 `shotRefPlanOf`）：首帧 → 尾帧 → 画面切片 →
  参考图 → 参考视频 → 参考音频；画面切片同时也在 `refImages` 里时按地址去重。界面芯片、@ 候选、
  润色附图、发送前预览与真正提交的 `inputEntries` 都读这一份。提示词里的 `@名字` / `@首帧` /
  `@视频1` 由 `tokenizeRefPrompt` 换成规范的 `@参考图N` / `@视频N` / `@音频N`，再由
  `applyProviderRefSyntax` 换成平台声明的写法（registry 的 `refSyntax`：H3 一族是
  `<Picture N>` / `<Video N>` / `<Audio N>`）。页面不许另算一套编号。

### 时间线

- **数据真相只有 `proj.film`**：主画面是一列顺序存储的 clip（没有 start，成片总长 = Σ `duration`）；
  配音是定时条目（成片秒 `start` / `duration`）；字幕存成片秒 `start` / `end`；标记钉在成片秒；
  `tracks` 存行列的眼睛与锁。旧那套 `c.segs` / `proj.timeline` / `proj.filmOrder` / `sh.lineSeg` 等键一行都不读。
- **两把尺子只有两个折算口**：成片秒与源秒。折算只走 `film.js` 的 `rateOf` / `srcHeadOf` / `srcUsedOf` /
  `srcLenOf`；裁剪、切开、滑移、播放取帧、FCPXML 都问同一个口。
- **台词与配音**：台词只有 `sh.line` / `sh.lineWho` 一份；右栏「台词」里的「AI 生成台词」按 `{prompt}` / `{duration}` / `{cast}` / `{line}` 写一句能念完的台词，「生成语音」按说话人同名素材自动选 `clone` / `design` / `preset` 型号（`Chars.Pipe.voicePlanOf`），落在这一镜画面段的起点、按全片配音轨找空行；同一句旧配音替换时沿用第一条的 id。没有待生成占位块。
- **写 film 只有一个出口**：`engine/edit.js` 的 `commit` / `patchFilm`（都经 `beginEdit` 压快照、
  `filmEdited()` 落盘）。右栏卡片、工具条、助手写入桥都走它，不许直接改 `WS` 里的 film。
- **历史是只追加的日志 + 当前状态指针**（`historyLog` / `historyCursor`）：`beginEdit(label)` 当场追加一条
  （状态先记改动前那一版，500ms 落盘时换成改完之后那一版）；回退 = 指针往回挪一条 + 在末尾追一条
  「回退到 xxx」（不删任何记录），重做走同一条路；上限 30 条 / 24 MB，超了从最旧一头丢。
  可撤销 = 起点那一版 + 指针之前那几条；可重做只数 `edit` 记录（回退 / 重做是流水记录，不是一版状态）——
  一次编辑之后撤销栈读数是 1，不许是 0。
- **转场挂在每一段的连接点上**：`clip.transition = { id, duration }` 表示「本段 → 下一段」；
  窗 = `[本段末 − dur, 本段末)`，`dur ≤ min(2 秒, 两段各一半)`。预览每帧与导出逐帧都读
  `transitionWindow` / `transitionAtTime`（同一道夹算）。FCPXML 按 1.10 DTD 把每一窗写成 spine 里
  夹在两段之间、以切点为中心的 `<transition duration=2h offset=切点−h>`（Cross Dissolve）：
  片段 `offset/start/duration` 一个都不动，总时长与配音/字幕的绝对秒不变；「切点前淡入 → 跨切点各半窗」
  这个差异、自制转场映射成 Cross Dissolve、以及写不出来的那几窗（一侧是 gap / 中间有空隙）都在文件头逐条报数。
- **主画面只有一轨（成片那一轨）**：没有「本镜 / 全片」两档；针、读数、剪子、缩放只有一把尺子（成片秒）。
  生成态的候选条与顺序条照旧，换候选回生成态点。
- **轨道水平跨度只有一处算**：`engine/timeline.js` 的 `navSpanOf` = `tl-scale.js` 的 `tlNavTotal(成片 + 尾垫, 钉在成片秒最右的那一枚)`，
  后者由 `film.js` 的 `pinnedEndOf`（配音 / 字幕 / 标记）给出；尺、网格、行底色定宽与针的夹算都读它。
  少算那一枚（或针不夹）就在右边露出一条没有刻度、还能滚进去的空道，读数同时念着成片里没有的那一秒。
- **工具条上的动作全走 `Edit.toolAction`**：六档选择工具（左选 / 右选 / 编辑点 / 滑移 / 滑动 / 选择）、
  切刀 / 剪头剪尾 / 删除 / 复制 / 融合 / 新增一段 / 摘掉一段 / 缩短 / 加长 / 缩放三颗 / 回到播放头 /
  撤销 / 重做 / 吸附开关 / 波纹开关 / 关联 / 标记面板。按钮只派发动作名，动作本体只有一份。
- **拖播放头**：针立刻跟手（`Timeline.setPlayhead` 纯视图），画面按 ~40ms 一档追、松手补一次精确 seek ——
  每次 pointermove 都 `video.currentTime = t` 会把在途 seek 取消掉，解码永远追不上指针。
- **轨道坞能拖到最底下**（`--dock-h` 下限 48）：允许把轨道整块盖住，只剩上沿那条抓手；
  `.tl-board[data-split-fixed]` 必须带 `min-height: 0`，否则内容会把板子撑在 234 拖不下去。
- **候选条展开只换行**：卡片尺寸与不展开时逐像素相同（展开是把同一排摊成几行，不是换一副大卡）。
- **触控板 / 滚轮**（`Timeline.onWheel`）：两指横滑（`deltaX`）与普通竖向滚动（`deltaY`）都当横向滚动；
  按住 Ctrl/⌘ 的 wheel 才是缩放，锚在指针底下那一秒；竖着翻行走 Alt 或把指针放到左边标签列。
- **吸附**（`tl-snap.js`）：吸附点 = 时间线 0 与末尾、播放头、各轨块边缘、各标记边缘；
  阈值是像素（`TL_SNAP_PX`），换算成秒只在手势层一处；Alt 绕过在 `engine/edit.js`。
- **波纹**（`tl-ripple.js`）：边界之后开跑的定时块整体平移；整轨 / 行锁住的按行跳过并计数；
  挂在被移动配音块上的字幕跟着走，没挂链接的字幕按自己的 start 判；标记不动。
  画面轨自己不参与平移（顺序存储，删一段后面的自然前移）。
- **标记四类五色**（`tl-markers.js`）：钉在成片秒、不随剪辑搬移；面板与轨道读同一份数组。
- **轨道板的形状**：`#tlBoard > #tlBoardBody`（模板里的静态壳）→ 运行时 `Timeline.render()` 画
  `#tlTools`（工具条就地刷）、`#tlRulerInner` / `#tlRulerHead`（刻度尺）、`#tlPlayhead`（针层）、
  `#tlScroll > #tlContent`（视口与内容层），里面是 `.tl-lane` / `.tl-track` / `.tl-strip`（`i.tl-fr`
  胶片格）/ `.tl-clip` / `.tl-junction`（转场 ◇）/ `.tl-marker` / `.tl-voice` / `.tl-cap`。
  三秒重建由 `Timeline.render` 自己收滚动位；同一排地址不重画（`__stripSig`）。
  标记条收起时左列那一行整条不画；轨道坞的拖高把手是通长的一条（`Wb.split` 的上下把手不能沿用左右把手的 10px 宽）。
- **取帧分两层**：数据层「解多密」只有 `slice.js` 的 `frameIndexPlan` / `frameIndexTimes`；
  显示层「摆几格」只有 `tl-filmstrip.js` 的 `frameCountFor` / `planFrameTimes`。
  取帧本身在 `engine/frames.js`（`sliceKey` 稳定键；失败退避 8 秒起逐次翻倍、最久 5 分钟；用户主动 seek 放行一次）。
- **播放不渲染**：剪辑态实时播（`engine/play.js`），导出才逐帧合成（`MediaExport`）。
- **本机优先**：预览遵守 `sk_media_prefer`，导出始终本机优先；有本机副本不碰上游。
- **片段之间可以留空**（`clip.gap`）：空记在后面那一段身上（这一段前面留几秒），`deriveTimeline`
  把空算进 start 与总长；空里 `rowAtTime` 给 `null` —— 预览放黑、导出画黑帧 + 静音、FCPXML 写 `<gap>`。
  切一刀的右半与复制出来的副本 `gap = 0`；拖动画面段往右丢会把这截空写进历史，往左丢贴住上一段末尾，空自动收掉。
- **拖动画面段的预览**：被拖的那一组钉在指针那一秒、带一条跟手的胶片浮层（`.tl-drag-ghost`），
  其余的段按换序后的座位让开（`.tl-board.is-dragging` 下有 120ms 过渡）；跨行拖动时目标行当场高亮，
  行号的更改在松手那一下落盘。
- **两个可拖分栏，一套公共件**（`Wb.split`）：`dir_split` / `dir_dock`（`--dock-h`）。
  `handles[].resize` 是列下标，`0` 是合法值（轨道坞拖第 0 栏）；生成态中栏的顺序条不提供上下拖高。
- **黑场只有「删掉」一种**（`off`）：这一格占时不变、后面的段不前移，画面变黑的同时音频跳过那几秒；
  「空段」不新建（老工程里存下的空段照样渲染，左右拖走即摘掉）。静音 ≠ 删画面
  （段级静音只把音量切 0，画面照样进成片）。单轨联动（`links.js`）不恢复：现在的「跟着走」只有
  波纹与字幕跟随（`tl-resize.js` 的 `followCaptions`）。

### 助手写入桥

- 唯一写入桥是 `WBBridge.director`（`web/director/engine/bridge.js`）：`check(op,arg)` 纯读校验并记下
  「这一次要动谁」的身份（`targetOf`），`run(op,arg)` 按同一份参数再解析一遍 plan —— 两边对不上
  （换工程 / 块被删或换了）当场拒，让模型重新读 context。没有修订号 CAS：凭据是块 id，不是「第几块」。
- 只有导演台在前台可用；op 只有 `select` / `cut` / `set` / `undo` 四个。`cut` 与工具条同一批函数
  （`Edit.selectItem` + `Edit.toolAction`，或 `cutTrim` 走 `tl-resize` 的两把剪子）；`set` 走
  `Edit.patchFilm`；`undo` 只挪历史指针。选中不依赖 DOM（生成态里板是隐着的也能剪）。
- 写入前由 `Edit.openUndoWindow` 压一份快照（一个动作一条历史），收尾统一重画。
- 批量 `timeline_apply` 每条 op 各占一个撤销条目（失败逐条退回），桥的 op 不新增第五个。
- 助手动作 `select_take` / `cut_timeline` / `set_clip` / `undo_edit` 只做转发；
  绝不让模型用 `click` 去点轨道按钮。

## AI 助手与 Skill

- 助手 UI 在 `web/features/chat.js`（外壳：悬浮球 / 抽屉 / 会话 / 渲染 / 发送循环）；
  工具循环与动作目录在 `web/features/chat-tools.js`（`TOOLS` / `ACTS` / `TOOL_INPUT` / `ACTION_META`），
  由 `window.AiChatTools.build(C)` 取共享函数，加载顺序 chat-tools → chat。
  会话记录、Skill 自动加载、上下文预算、密钥脱敏都在 chat.js。
- **联网搜索是 TextAI 的工具循环，不是预注入**：总开关打开时，`TextAI.chat` / `chatStream` 把
  `CALL: web_search {...}` / `CALL: web_read {...}` 的工具说明接进系统提示词；模型自己决定调不调，
  结果只回灌给模型（**不画来源卡片、不显示引用**），最终输出仍是原样的正文 / JSON。
  所有文字 AI 调用默认可用；助手自己的工具循环与纯协议调用（反问 JSON / 看图说明 / 起标题 / 设置探针）
  传 `noTools: true` 退出。总开关关着时连工具说明都不加。旧的 `withSearch` / `decideSearch` /
  `Search.context` 已删除。
- **用户可见的正文生成一律流式**：拆分镜 / 各页 AI 润色 / 新台词 / 关键帧规划走 `AiStream.text` 或 `TextAI.chatStream`；只有短 JSON 判定（反问 / 拆素材）、后台标题、AI 搜索这类没有正文面板的步骤保留一次性 `chat`。
- 抽屉缺省是球旁的浮窗：贴着悬浮球摆（左上方，放不下就翻到另一侧，最后夹进视口并让开侧栏），
  宽 `--ac-w` / 高 `--ac-h` 由左沿与下沿两根把手拖，记本机 `ai_chat_w` / `ai_chat_h`；
  **浮窗只能随球拖动** —— 拖标题栏挪的是球（球与浮窗是一组），浮窗永远贴着球。
  另一档是固定右栏（`html.ac-dock`，`#app` 用内联宽度让出 `--sbw + 面板宽`，页面可继续操作，球让位）。
  偏好只存本机 `ai_chat_dock`，打开状态本身不持久；窗口窄于 `DOCK_MIN` 自动回浮层，放宽后按偏好恢复。
- **拖素材到球 = 引用**（面板收起也能拖）：载荷由 `AssetRef`（`web/domain/asset-ref.cjs`）写，
  落进 `refs` 队列（落盘 `ai_chat_refs`，上限 20，超出挤掉最早的并点名）并在输入框追加一行
  `[引用素材：…]`；这一轮正文里有 `【这次引用的素材】` 清单，序号与队列同下标。字节不预取，
  模型要看时用只读工具 `asset_open` 按序号 / 号 / 地址取；取不到就照实说。输入框里的标记有灰底高亮，
  悬停弹这一条、点击开 `UiDialog` 看图、× 只移引用不删资产库；真相是队列，标记被改掉只影响高亮。
  拖外部文件到球仍是上传；窗口空白处不接引用（球是唯一落点）。
- 只读工具 `task_detail` 查单条任务：先按本机缓存反查平台 / 产物号 / 提示词，再向平台问一次现状；
  多条一次问（最多 8 条，同轮共用一次列表请求），查不到按原因码说清。
- 写动作只经 `web/core/actions.js` 的 `ActionRegistry`；任意脚本 `inject` 整族禁止。
- 动作默认直接执行、不强制过程可见：结果回执 + 撤销必须可见；跨页给「去看看」，定位按需。
- 内容写动作必须有 `undo` 或显式 `irreversible`；花钱动作声明 `cancel`。
- Skill：`skills/<id>/SKILL.md`；按页面 + 触发词自动加载（最多 2 个），未命中的由 `skill` 工具按需加载。
  内置 Skill 正文由 `TextAI.DEF` 同源生成；正文只有「启用的 Skill → 内置默认」两级，
  设置页不改正文（`sk_polish_ask` 那一档管的是「动手前要不要先反问」）。
- **项目引用规则 = Skill 正文里的变量占位符**（`{cast}` `{what}` `{board}` `{assets}` `{dur}` …）：
  程序在发请求前按当前项目把实际内容填进去（`window.TplVars.fill`，唯一一份填法）。
  填不上的原样留着（AI 看到 `{cast}` 三个字也知道那是要它自己补的位子；留空会让它以为「这一段没有内容」）。
  填料在 `web/director/board-vars.js`（角色表 / 选中素材 / 现有分镜 / 时长区间），三处共用一张表。
  ⚠ 这与提示词正文里的 `@素材` 引用是两件事：
  · `@名字` —— 给生成模型的引用（挂参考图，提交前换成 `@参考图N`）；
  · `{变量}` —— 给写稿的 AI 的项目资料（这一份角色名单长什么样）。
- **「素材范围优先」**（frontmatter 的 `assetGroups`）：一份 Skill 声明「这个项目优先用哪几个素材组」，
  拆分镜那一路的「素材范围」下拉把它们排在前面（不排除其它组）。读法只有 `WbSkills.refRule` 一处。
  它不是「项目引用规则」—— 那个指的是上面的变量占位符（在正文里，不在 frontmatter 里）。
- **contract 白名单**在 `server/skills-store.js` 的 `CONTRACTS`：加一种新任务就在那里加一条，
  同时 `TextAI.SKILL_CONTRACT` 加一条（页面侧同一张表的另一半）。`board_assets.json` =
  拆分镜「判断哪些新角色 / 场景 / 物品要建档并出图」那一条。
- **设置页的 Skill 卡：一级菜单 = 使用场景**（`TextAI.SKILL_SCENE_GROUPS` / `SKILL_SCENES`）。
  点一个场景 → 右边给两件事：① 这一步会拿到什么（变量表，场景级，按 contract 取 `SKILL_VARS`）
  ② 这个场景的 Skill（这一 contract 下的每一份、哪一份在用）。
  全量清单退到「全部 Skill」一个二级入口。槽位灯说的是「这个 contract 槽现在被谁占着」：
  紫 = 我的、灰 = 内置 —— 槽里恒有一份在用，没有空档与冲突两态。
- **占 contract 的场景恰好一份启用（服务端硬约束，`server/skills-store.js` 一份实现）**：
  · 启一份就把同 contract 的别的直接停掉 —— 不报错、不让人先关掉再开（`displaceSameContract`，
    启停与安装两条路共用）。内置那份同样让位；用户那份之间也让位。让位的那几份 id 由服务端
    回传（`displaced`），前端要点名说清「哪一份停了」，不许让人自己猜。
  · 停掉场景里最后那份启用会被拒（400 + 「先启用另一份」的说明）；界面上那份在用的行，
    停用按钮就地压住（`isLastEnabled`）。要换 = 启用另一份，不是先停再启。
  · 卸载场景里最后那份启用时，服务端把该 contract 的内置份顶回来（没有内置就第一份用户），
    DELETE 回执 `restored` 点名，前端照说。
  · 开机 `ensureInvariants()` 把老状态文件里的「两份都启用」（留 [builtin, user] 顺序里最后启用
    那份）/「一份都不启用」（拉回内置）修一次，修了才落盘。
  · 助手那一档（不占 contract）不受限：随便启用几份、随便停。
- **新建 / 编辑一份 Skill 在浏览器里做**（设置页场景详情里的「添加新 Skill」/「编辑正文」）：
  frontmatter 由表单生成、正文自己敲，落盘走 `POST /skills/install`（新建）或 `/skills/:id/update`（改）。
  内置 Skill 只读：改不了内置那一份，要改就自己新建一份占同一个 contract（服务端会把同 contract 的
  原来那份自动停用）。「复制为我的 Skill」与「导出」两条已删除，不再恢复。
- 查询结果按 `estimateTokens` 预算；发出前 `redactSecrets` 抹密钥形状。
- 设置项只有白名单（`ADJUST` + `PAGE_TARGETS` + `sk_model_<kid>` + `Chars.SET`）；
  助手的供应方 / 型号只在设置页选（`sk_text_prov` + `sk_model_<kid>`），抽屉里没有第二份选择。
- 流式进行中不许清空气泡；切页 / 刷新前已写出的字要落盘并写明断了。

## 素材库、资产库、工作台

- 素材库身份锚点只有 `newChar/newScene/newProp` 的 `anchor` 与 `Chars.refPicOf`；
  页面不许自己 `c.face || c.img` 拼。
- 素材库体检数字现算，不落库；多选批量全部调单条入口；使用关系读同一份 `loadRefUse()`。
- **素材页的「默认」归设置页，页面只留「这一次用哪个」**：
  · 页面上不许有任何「本页默认」面板；默认值在设置页「素材库」那张卡里：`Chars.SET` 的 `imgModel`
    （默认生图型号）/ `ttsModel`（默认语音型号）/ `candN`（默认一次出几张候选）/ `voiceN`
    （默认一次出几条语音）—— 图说「张」、语音说「条」，两项分开设；型号下拉只有那一份实现
    （`Chars.Pipe.modelSelectHTML`，按平台分组，带一档「自动」= 平台清单里第一个）。
  · 每一处生成位仍能当场换型号与张数，换的那一次只管那一处。
  · 不往本机存「上次用的型号与张数」（`char_opts` 已在 `LEGACY_KEYS` 里连盘上镜像一起清掉）——
    记了就会不自觉地按上次那个跑。
  · 页面上的两处现场选择：目录轨「出齐用」一行、多选批量条上的「出图 / 声音」两行。
  · **型号清单是后到的**（`Capabilities` 从平台能力接口逐家取，落到 `prov.models` 里，每家落定广播一次
    `wb:cap-ready`）。画型号下拉的页面必须自己拉一次能力并按家补画（见 `web/pages/chars.js` 的
    `loadCaps` / `onCapReady`，与导演台右栏 `installCapRepaint` 同一套）—— 不接这一下，型号下拉会永远
    停在「没配生图平台」那句假话上。
- 工作台三类型共用一页：`?t=video|image|audio`；型号与提示词分类型记住；右栏历史三类型合并、按 `assetId` 去重。
- **视频栏与图像栏的两颗「送过去」只在页面里拼载荷，不新造写入格式**：
  · 「送进图像栏」（`web/pages/studio/cross-col.js` 的 `promptIntoImage`）把视频栏那句提示词三处一起写
    （textarea 节点 + 该型草稿 + `studio_prompt_image`），
    图像栏已有草稿且不是同一句 → 先 `Confirm.ask` 再替换；写完不自动开始生成。
  · 「送进视频栏」（卡片一颗 + 多选条一颗，同一个函数）把图片产物落进视频栏的参考素材，
    唯一出口仍是 `refIntoSlot`（拖放那一路走 `AssetRef`，两条不许各长一份）。
  · 能力闸必须在 `setType('video')` **之后**现读：`slots` / `currentModel` / `provGroups` 都问当前那一栏，
    不切过去就量不到视频栏的真相（切栏无损，三栏各留一份草稿）。放不满先问、槽满先问清栏、
    型号不收参考图或被首尾帧互斥挡住 → `Confirm.choose` 给「换一家会收的型号 / 放进首尾帧那一格 / 不动」，
    不静默改用户已选的型号，也不假装放成功了。
- 右栏的「AI 搜索」与素材库 / 收藏 / 资产库同一份 `AiFind.run`：搜索框里那句话交给文字 AI，
  它从这一栏已取回的历史（只滤掉「隐藏云端」，最多 100 条）里挑几条；挑中的集合与名次
  并进 `filteredItems()` 的筛选与排序，清掉芯片就回到完整列表。
- 这一栏的历史不按时间裁：没有「最近 30 天 / 查看全部」那一档，取回多少就列多少
  （筛子只有搜索、类型档与分页）。
- 输入模式（一次请求能用哪几类素材）只有 `Capabilities.combos` 一份；判据双向（缺料 / 超料 / 不收 / 互斥），
  `mode` 不是提交字段。
- 四颗「存回本机」只走 `AssetLocal.pullMany`；页面里一次都不许出现 `AssetLocal.pull`。
- **「存回本机」的范围按页分两种**：
  · 工作台 / 资产库 / 收藏：这颗按钮住在多选条里（不是筛选行那一排），多选之后才出现，
    存的是勾选的那几条 —— 不多选就点它等于「把这一屏都存一遍」，那不是用户的意思。
    范围 = `Wb.multi.selected()` 过 `AssetLocal.pullPlan`（本机已有 / 没地址 / 本地上传的都剔掉）。
  · 素材库：仍是那一档（当前档）的整批，因为那页没有多选条。
  判据在 `AssetLocal.pullPlan` 一份；按钮上的数与 title 走 `AssetLocal.pullBar` / `pullBtnTitle`。
- 「不显示云端任务」是 `AssetLocal.hideAsCloud` 一张闸，不是一套筛选。
- 卡片徽标只有 `web/ui/badge-state.js` 一份（`badgeOf` / `badgeHTML`），五页同读 `AssetLocal.stateOf`。
- 选择器来源档位只有 `AssetPicker` 的 `inView` 一处；音频条目按 `noMedia` 走自己的调度，
  不许把 `<img>` 塞一段音频。
- 下载文件名、类型判断、数字格式化一律走「唯一实现清单」里的公共实现，不许页面各拼一份。

### 侧栏

- 侧栏是外壳顶层文档里的经典脚本（`shell.html` 在 `ui.js` 之后、`app.js` 之前加载），不是 Vue 页面；
  取数仍走公共层（`Api` 余额 / `AssetLocal.info()`），探针不许另写一份余额卡。
- **两个形态，只有两个**：满 232px（`--sbw-full`）与窄 56px（`--sbw`），`sidebar.js` 每次切形态把
  `--sbw` 写成当前那一态的宽度；窄窗（≤1100px）里展开是浮层，那时 `--sbw` 仍是 56（内容不让位）。
  消费方（`#app` / 悬浮球 / 灯箱）都读这两个变量，不许再写死 200 / 66 这样的像素。
- **收 / 展的开关是左上角那块品牌砖**（`.sb-logo`，`role=button`），侧栏里没有第二样收展标识：
  不画箭头、不画拉片。两个形态里它是同一块砖（30px、离左边 13px、同一行高），手指不用记位置。
- **窄形态认得出**：导航项的图标下面常驻一枚两字短标签（`.sh`），文案取 `web/core/routes.js` 每一页的
  `short` 字段（导演 / 素材 / 生成 / 收藏 / 资产 / 用量）—— 与 `label` 放在同一张表里，侧栏不许另抄一份。
  悬停弹出的名牌只负责补全全名；窄形态下 `aria-label` 仍写全名。当前项在窄形态变成实心方块
  （`.ic` 染 `--pri`），满形态是淡紫底 + 内边缘那道 3px 紫条。
- 高度分配只有一套：`.sidebar` 是 fixed flex column，`nav` 拿 `flex:1 1 auto; min-height:0` 与它自己的
  `overflow-y:auto`，`.sb-bottom` / `#sbBalance` 钉死 `flex:0 0 auto`，品牌砖 `.sb-brand` 也钉死
  `flex:0 0 auto`。导航优先于卡片：矮窗（`max-height: 660px`）与窄形态整区退成压缩版，卡片块根本不画。
- **余额卡恒为全量、卡列表定高三张**：不再有「展开 / 收起」与 `sb_bal_exp` 偏好（旧键由 `LEGACY_KEYS` 清盘）。
  六家都画在 `.sb-bal-cards` 里，高度 = 三张余额行（`fitBalCards` 量第一张再乘三，矮窗那一档内边距变了也跟得上），
  第四家起在那一格自己滚 —— **滚动条藏掉**（`scrollbar-width:none` + 一条 `::-webkit-scrollbar` 0 宽规则）。
- **刷新 = 点「账户余额」抬头**（`role=button`，抬头不画图标）；这一区不再有按钮行，也不再有跳转钮。
- **收起态 / 矮窗（≤660px）看压缩块**：家数 + 每家一个状态点 + 落盘进度条；点它开一只气泡
  （`.sb-bal-pop`，挂 body、贴在压缩块右边、底边对齐）。气泡里是同一份卡 + 本机产物行，
  **没有展开 / 刷新按钮**（开的那一下自动重取一轮余额），点页面别处 / Esc / 窗口尺寸变 / 侧栏换形态就关。
  气泡与压缩块的唯一接线在 `sidebar.js` 的 `toggleBalBubble` / `paintBubble` / `placeBalBubble`。
- **满形态那张「此刻」卡**（`.sb-bal-body`）：抬头「账户余额 · N 家」+ 卡列表 + 本机产物行，
  顺序是「余额在上、落盘在下」；压缩块与气泡也是这个顺序。本机产物行在卡底，不跟卡列表一起滚。
- **余额行是两行**（名字 + 金额 / 冻结 + 单位）：取不到的那一家不藏，原因直接摆到第二行
  （红色、单行省略，全文在 `title` 里）。金额那一位不许截。
- **每家一个状态点**：实心紫 = 这一家取到了，空心红圈 = 这一家取不到；点上有 `title` 写清是哪几家。
- **本机产物行没有开关**：明细常驻（状态一行 + 「本次 N 份 / 正在下这一份 x%」一行，单行省略），
  文件名 / 已下字节在进度条的 `title` 里；第三行与那条 3px 进度轨空闲时也占着版位（轨道不画），
  下载开始 / 结束时这一块高度不变、导航不被压矮。读数只用 `AssetLocal.info()`，落盘与认回
  （`onInfo` 订阅）以及整块重画（`sb-balance-refresh`）之后由 `patchMirror` 换那一块本身。
- 判据 `tests/e2e/sidebar-balance.cjs`：满形态（全量 / 定高三张 / 不画滚动条 / 点抬头重取）/ 窄形态 /
  悬停名牌 / 气泡（右边、无按钮、开就刷新、点外与 Esc 关）/ 矮窗压缩块 / 480–1100 高度扫描 / 来回切形态。

## 服务端与路由

- `server/app.js` 是组合根；每个路由只在自己的 `server/routes/*.js` 里实现，app 只负责构造依赖与分发。
- 路由层的 JSON 回包口径只有 `server/routes/http.js` 的 `sendJson` / `fail` / `noStore`
  （默认 no-store，4xx/5xx 不许被缓存）；各路由不再自写 Content-Type 与缓存头。
- 设置页「语音识别 / 联网搜索」两条通道共用的取数小件在 `server/channel-cred.js`
  （`providerOf` / `mirrored` / `channelKey` / `channelBase` / `loopback` / `collect` / `postJson` 只这一份；
  `postJson` 是两条通道发 JSON POST 的唯一出口 —— 出站护栏、系统代理隧道、带上限收字节都在里面）。
- 静态资源：只放行根级单文件与 `web/` 子树；HTML 带 CSP、nosniff、Referrer-Policy。
  文本响应按 `Accept-Encoding` 选 brotli、退 gzip、再退原文（压不动或压完不更短就发原文，不报错），
  三档共用同一套缓存与 ETag —— 验证器末位带表示名（`-br` / `-gz` / `-id`），缺了它 304 会把
  上一轮别的编码那份字节接着用；`Vary: Accept-Encoding` 因此恒写。
- **文本资源的 brotli 在监听之后预热**（`static.js` 的 `warmStatic`，`server/app.js` 在 listen 回调里调用）：
  外壳 + `web/` 下除 `vendor/` 的 `.js/.css/.html`（约 128 份），预算 4 秒、并发 4，超预算的留给请求那一路。
  请求撞上正在预压的同一份时挂到同一只在途压缩上等结果（`compressBrCached`，按绝对路径 + mtime + size 认），
  不重复压；预热没压动的那一份记 `br=false`，后续请求不再为它试一次。
  `proxy.js` 在 `require` 之前把 `UV_THREADPOOL_SIZE` 默认设成 8（未设置时才设）—— 压缩、`stat`、DNS
  共用这只池，4 条预热线程之外仍要留给请求。判据 `tests/static-encoding.cjs`（含 `--live`）。
- `/data` 写入是原子写 + `.bak`；`/data` 清单不包含 `.bak`。
- `/prompts`：写文件 + 索引；`/prompts/find` 按 id 返回全部归档，客户端每个任务只问一次。
- `/fcpxml/bundle`：只写 `RENDER_DIR/fcpxml-<stamp>/`，素材只按资产号 / 已过护栏的 URL 取，取不到写 `missing.txt`；`bundle.zip` 只有这一条路生成。
- `/fcpxml/project`：同一份 `writeBundle`（`needZip=false`）落到**本机资产库根下的 `FCPXML工程/<id>/`**，库根由 app.js 注入的 `localRoot` 现读 —— 用户在设置页换库根，下一次导出就跟着走；不写 `bundle.zip`，不把素材存第二遍。回 `id / dir / project / missingCount / assets`。
  目录名只有 `server/user-dirs.js` 的 `FCPXML_PROJECT_DIR` 一份：导出端与 `local-assets-store.js` 的 `SKIP_DIR_NAMES` 同读它。**库根的 `dirScan` 是递归的**，不跳过这一档就会把 `media/` 里的素材副本当成用户新放进来的产物补进资产库索引、被用量体检算成重复文件（判据 `tests/e2e/fcpxml.cjs` 的 `/assets-usage`）；
  `/fcpxml/reveal` 只按这个 `id` 拼目录（不收客户端绝对路径）；库根现读意味着**换了库根后旧 id 会找不到**，404 要把「已清理」与「库根改过」两种原因一起说清，且清扫只扫当前根，旧根下的工程目录不会被自动删。两条写盘出口都只留最近 20 个目录，且**只删代理自己造的名字**（时间戳 + 随机后缀），用户在 RENDER_DIR 或资产库里自己放的同名前缀文件夹不动。
  **不启动任何外部软件**：旧的 `/fcpxml/import`、`/fcpxml/launch`（剪映 / 达芬奇）已删，导入由用户在软件里做。
- **代理不转码、不合成**：取帧 / 抽音轨 / 混音 / 编码全在浏览器（`MediaBackend` / `MediaExport`），
  代理只做取数与落盘，没有渲染队列、没有编码器档位可配。成片能不能导由 `Api.exportCaps()` 现探
  （WebCodecs + H.264 编码器），设置页与助手「成片环境」读的是同一份探测结果。
- **浏览器内识别的模型只由代理代下载**（`server/routes/models.js`）：`/models/<id>/<file>` 把
  ModelScope / HuggingFace 的字节流进 `.data/models/`，这是唯一一份模型缓存（worker 里
  `useBrowserCache=false`、`allowRemoteModels=false`、只认 `/models/` 这一个本地路径）。
  LOCAL_ONLY、id 只认登记表里那一个型号、每一跳都过 `guardOutboundUrl`（重定向最多 4 跳）、
  `.part` 下完才原子改名、同一文件单飞、客户端断开就掐上游并删 `.part`；`/models/status` 报「齐不齐 / 多少字节」。
- **`route:'browser'` 不许发到代理**：浏览器内那一路在页面 worker 里跑，`/asr/transcribe` 收到 browser
  当场 400。放行不会报错，但任务照建、`work()` 的「local 才本地」三元判据会默默扣一次在线转写的钱，
  而账上写着 browser —— 路线的真相只有 `Asr.pickRoute` 一份。
- 代理健康账：未捕获异常 / 未接住的 Promise / 500 / 连接错误四类；只报不自杀，连接错误不算故障。
- **stdout 断了不许自旋**（`server/app.js` 的 `writeLog`）：启动器窗口一关，stdout 管道就断；
  往断掉的管道写会抛异步 EPIPE，那条 EPIPE 又被「未捕获异常」那个出口接住 → 它记一笔 → 再写一次
  → 再抛一次：无限自旋。所以 stdout 断了就把这条路封掉（`outWrite` + 流的 `error` 事件），
  日志文件照旧落盘。判据 `tests/e2e/proxy-stdout.cjs`。

## 测试与验证

### 分档

| 档 | 命令 | 场景 | 耗时（本机实测） |
| --- | --- | --- | --- |
| 秒级 | `npm run check` | 每次保存后 | ~0.5s |
| 样式秒级 | `npm run static` | 动了样式 / 令牌后 | ~2.5s |
| 迭代 | `npm run test:fast` | 日常改码后 | 改动小时 3–8s；映射条数多则按比例上涨 |
| 合并 | `npm run test` | 批末回归 / 提交与推送前 | ~3s |
| 全量 | `npm run test:all` | 想连浏览器冒烟一起跑时（按需，不挡提交） | 常驻 ~3s + e2e 冒烟 6 条（4 路并发）~70s，合计 ~75s |
| 剪辑核 | `npm run test:director` | 改剪辑核时 | 纯件 5 条 + `director-core` 一次装配的冒烟（约 35s） |
| 浏览器 | `npm run test:e2e` | 按需手动跑（不是提交与推送的前置条件） | 54 项：52 条 e2e 判据 + `perf/boot` + `static-encoding --live`；读数型 5 条先独跑，其余 49 条 4 路并发，实测约 10 分钟 |
| 观察 | `npm run test:watch` | 连续改码时 | 常驻前台；800ms 防抖 + 在途合并，触发 `map.cjs --changed --run` |
| 写入型 | `node tests/data-snapshot.cjs` | 动了写盘路径时手工 | ~0.4s |

**提交与推送前只跑 `npm run check` + `npm run test`**（秒级 + 常驻判据全量，几秒）。
**e2e 不是前置条件**：浏览器档要起隔离 proxy 与独立 Chrome、单次十来分钟，把它挡在提交前面只会让人整档跳过。
想跑就按需手动跑 `npm run test:e2e`（或 `npm run test:all` 连冒烟一起）；改动面大时用 `npm run test:fast`
（按 `tests/map.cjs` 的映射挑相关判据）就够。

常驻判据的清单只有一份：`tests/all.cjs` 里的 `run()` 登记行（`tests/map.cjs` 的 registry 按源码文本现读这些行，
两边不一致当场红）。这里不再抄一遍全表，只按域说各档管什么：

- 静态纪律：`syntax` / `selfcheck` / `spa` / `static-guards` / `scope-guards` / `dup-guard` /
  `architecture` / `metrics` / `ui-catalog` / `settings-schema` / `doc-contract`。
- 服务端与数据：`routes-smoke` / `index-store` / `local-first` / `relay-retry` / `outbound-keepalive` /
  `proxy-tunnel` / `assetlib-cache` / `pull-scope` / `providers-validate` / `asr-settings` / `zip` /
  `skill-hub` / `fcpxml-client` / `static-encoding`（不起实例的那一半）。
- 本机资产：服务端档的 `local-root`；浏览器档的 `local-chain`（只起隔离实例，不开 Chrome）。
- 纯算法：`core` / `editing` / `editor-media` / `local-edit` / `gen-rules` / `task-detail` / `asset-ref` /
  `export-formats` / `raw-preview` / `skill-refvars` / `director-*`（含 `director-slice-pack` 与
  `director-asr-text` 的静态判据）。
- 页面行为：`pager-row` / `page-head` / `wb-split` / `kind-filter` / `theme-modes` / `viewport-keep` /
  `pull-selected` / `settings-nav` / `sidebar-balance` 等 —— 清单仍以 `tests/all.cjs` 为准。

浏览器档分两级（按需手动跑，不是提交前置）：
- `npm run test:all` 只跑冒烟 6 条（smoke / ui-contract / ui-shared / director-perf / director-core / lock，
  4 路并发，每条自起隔离 proxy + 独立 Chrome）。
- `npm run test:e2e` 全量分两道：读数型先独跑（`ui-visual` / `director-perf` / `director-playback` /
  `perf/boot` / `boot-heavy`：并发负载会让截图指纹、帧预算、播放对齐与「启动收尾让路」的计时窗口这类读数失真），
  其余（含 7 条不起 Chrome 的服务端链路）走 4 路并发。`tests/e2e/` 共 53 个文件（52 条判据 + harness），同一档还跑
  `tests/perf/boot.cjs` 与 `tests/static-encoding.cjs --live`。
  16 核 / 17 GB 本机实测全量约 10 分钟；单条红先独立重跑再定性 —— 满载池子里的机器负载假红有先例。
- `tests/map.cjs --run` 每条报耗时，超预算（默认 20s，`MAP_BUDGET_MS` 可改）先给最慢清单再谈切 `--e2e`。
- **剪辑核的日常验证不要跑全量 e2e**：`npm run test:director` 覆盖板 / 切一刀 / 撤销 / 转场 ◇ / 标记 /
  字幕块 / 缩放 / 工具条就地刷 / 历史；`director-edit` / `director-history` / `director-playback`
  这些重交互档按需手动跑。

视觉基线更新（只在有意改版后；不要为了让测试变绿随意放宽阈值）：

```bash
UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs                    # 全部画面
UI_VISUAL_WRITE=1 UI_VISUAL_PAGES=studio node tests/e2e/ui-visual.cjs   # 只补点名的那一页
UI_VISUAL_SAVE=1 node tests/e2e/ui-visual.cjs                     # 只留底不改基线：逐张写进 actual/（排障用）
```

### 写入隔离

判据脚本自己起的实例一律由 `tests/e2e/harness.cjs` 的 `startProxy` 现建目录：系统临时目录下的
`imago-probe-*`（一处 `mkdtemp` 父目录，`data` / `assets` / `renders` / `skills` 四个根与「下载」基座
`downloads` 全从它派生），收尾整组删除 —— 仓库根不出现 `.data-probe-*` 那一族；进程被硬杀时留下的
也只是系统临时目录里的空壳。`startProxy` 默认就把 `AUTOSAVE_DIR` 指进那个父目录（判据在 `opts.env`
里点名另一处仍然覆盖得掉）；`launcher.ps1 -SelfTest` 的三份探针目录在它自己的 `aii-launcher-*`
临时目录下，跟自检一起清。

手动起一份探针实例排障时（目录名仍用 `.data-probe` 这一族，`.gitignore` 收着）：

```bash
PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe RENDER_DIR=.renders-probe \
  SKILLS_DIR=.skills-probe AUTOSAVE_DIR=.downloads-probe node proxy.js
```

- 不给 `ASSETS_DIR` / `RENDER_DIR` 就会写进用户真实库根（默认在 `下载\成像`，仓库外）与成片目录。
- **另一枚探针口**：`AUTOSAVE_DIR` 把整个「下载」基座指走（`server/user-dirs.js` 读它，
  库根与提示词归档的默认目录都跟着它）；`startProxy` 默认给这一枚，**手动 spawn 必须自己给**，
  否则一次提示词归档（或整目录兜底重建索引）就写到用户真实的成品目录里。
- 自己 spawn 的探针要认领「答话的就是我刚起的那一份」：`/sys-status` 的三个目录都要点名，
  并判子进程没有提前退出。
- 手动跑完清理 `.data-probe*` 等目录与孤儿进程；不要留在仓库里。
- `tests/all.cjs` 的并发池只跑不写共享目录的判据；会写共享 `.data` / `.renders` / `.skills` 或库根本体的
  判据一律进串行白名单。起代理的就绪探测每一跳都带 3 秒上限、总窗口 20 秒；起不来时先把子进程杀掉、
  四个探针目录清掉再抛。

### 数据基线

- `node tests/data-snapshot.cjs` 比对三块与 `tests/data-baseline.json`：真实 `.data`、真实 `.renders`、
  以及库根本体（落点由 `server/local-root.js` 现算，不在项目里就照现在这一份盯）。
- 基线文件里只记标签（`.data` / `.renders` / `库根`）与计数、聚合哈希，不记用户绝对路径 —— 这份要提交。
- 写入型测试前后都要核对；真实实例上只做只读加载。
- 迁移类改动做完后要手工 `DATA_SNAPSHOT_WRITE=1 node tests/data-snapshot.cjs --write` 重打一次基线，
  别用 `--write` 把日常写入掩盖过去。这一份盯的是真实用户数据，所以 `--write` 先打印「哪一块要从几条 /
  多少字节换成什么」，没带那枚环境变量就拒绝落盘。

### 浏览器

- 只跑 headless；测试脚本自己起隔离代理与 Chrome。
- 页面 e2e 必须检查控制台错误（CSP 违规、未捕获异常、404）。
- `tests/e2e/harness.cjs` 是唯一的启动 / 取 Cookie / 打开页面入口，别每个脚本各写一套。

## 编码与新增功能

### 编码与注释

- **编码**：`.js/.mjs/.cjs/.html/.css/.md` UTF-8；`.bat` UTF-8（无 BOM）+ CRLF + `chcp 65001`；
  `.ps1` UTF-8 带 BOM + CRLF（PowerShell 5.1 无 BOM 会按 ANSI 解码，中文全乱）。不要在编辑器里存成 GBK。
- **行尾由 `.gitattributes` 钉，不由 `core.autocrlf` 决定**：仓库里的文本 blob 全是 LF；检出时文本给 LF，
  `.ps1` / `.bat` / `.cmd` 给 CRLF，`*.wasm` / `*.mp4` / `*.png` 与 `*.min.js` 一个字节都不换算。
  `eol` 属性压过 `core.autocrlf`，所以同一份克隆在任何机器上检出都一样。
  缺那一份文件的后果实测过：`core.autocrlf=true` 的机器全新检出 348 份文本变 CRLF，
  而 `tools/precompile-vue.cjs` 只吐 LF，`npm run build:check` 于是 10 份 render 一起假红（没有一份真的过期）。
- **注释只注释功能本身（硬约束）**：注释解释这段代码在做什么、为什么必须这样做（不明显的约束、
  踩过的坑、边界条件）；不写任何文档引用 —— 不写文档名 / 章节号 / 报告 / 方案 / 任务号 / 缺陷号 /
  提交号，也不写「详见某文档」「见上文」这类指路。代码文件、判据文件、函数名不算文档引用：
  那是读代码的人当场能核对的事实。需要读代码的人知道的事实，直接写全。
  判据 G23 扫全部人写的源码（`web/` / `server/` / `tests/` / `tools/` / `proxy.js`），现状 0 处。
- 注释不写变更史（「以前是那样」）；一处落点被撤销时，只写「为什么不能接回来」。
- 页面样式只用 `tokens.css` 的令牌；不要在页面里写第二份主题变量或裸色值。
- 不要写裸控制字符；不可见分隔符写 `\u0001`。
- 源码里不出现真实密钥；日志不打印密钥 / Cookie / 用户路径之外的本机隐私。
- 命名和结构优先于注释：能用一个好名字说清的事，不加注释。

### 新增页面

1. `web/pages/<id>.js`（Vue 组件，默认导出，`render` 来自预编译）+ `tools/vue-templates/<id>.html`（模板源），
   跑 `npm run build`。
2. `web/core/routes.js` 的 `WB_ROUTES` 加一条（组件地址 `src`、私有样式表 `css` 与页面根类 `root`）——
   外壳映射由它现搭，`web/app.js` 不用改。新页面还要在 `web/core/page-context.js` 的 GET 里点名（助手快照），
   视觉档位与「哪些页必须有快照 / root」都由这张表现取，漏了直接红。
3. 私有样式 `web/styles/spa-<id>.css`（根类下）；挂载点只有路由表那格 `css`，组件里不写 `ensureCss`，
   补丁里不顶层定义公共类（判据 G20）。
4. 后台可见性 / 保存钩子接 `spa:page` 与 `__spaRegister`。

### 新增供应商

只改 `server/registry-config.js` 的 `REGISTRY.providers`（或走设置页自定义供应商表单）；页面不改。
资产存储换了平台还要改顶层 `assetStore` 的 `provider` / `retrieve` / `urlFields`（判据 `validateAssetStore`），
不要在路由或页面里另写一家。

### 新增助手动作

1. 动作本体写在 `web/features/chat-tools.js` 的 `ACTS`（`title` / `doc` / `arg` / `check` / `run`）。
2. 策略写在同一文件的 `ACTION_META`（`effect` / `route` / `undo`，一行一条）：`effect` 与 `route`
   缺任一项 `registerActions` 当场抛，整份目录不交出来（写动作 fail-closed，见 `regClosed`）；
   全站动作 `route: '*'`，不给 `undo` 是有意声明「这一条真退不掉」。
3. 需要参数形状才在 `TOOL_INPUT` 补一条（读工具与动作共用这张形状表，不给就是 `{type:'object'}`）。
   `ACTS` / `ACTION_META` / `TOOL_INPUT` 都在 `chat-tools.js`；chat.js 只经 `window.AiChatTools`
   读它们，不另存一份。
4. `web/core/actions.js` 的 `ActionRegistry` 是执行外壳（planToken / 幂等键 / 同一个 busyKey 串行 /
   超时可中断），不在这里注册动作，也不要另写第二份动作目录或第二套工具清单。
5. 静态判据 G7 与浏览器判据（`tests/e2e/actions.cjs`）会一起数这两张表，并把「设置页看得见导演台动作」
   这类跨页泄漏直接判红。

### 新增导入导出格式

- 导演台的导出格式只有一张表 `web/domain/export-formats.js`：页头按钮、`export_start` 的校验 / 分派 / 文案、
  助手 `export_start` 的 enum 都从它派生。加一种导出 = 表里一行（`kind` 是 `film` / `xml` 之一）
  + engine 里一个 builder；判据 `tests/export-formats.cjs`。
- 页头只有一颗拆分按钮：主钮「导出成片」，尾部 chevron 浮层里收其余三种去向
  （导出 FCPXML / 导出媒体包 / 导出工程目录）。旧「导入 FCPXML / 最近导出 / 导出素材」三颗、
  「导出到剪映 / 达芬奇」两条出口与 `web/director/fcpxml-import.js`、`Export.sessionExports` 会话账本不恢复。
- 三档 XML 出口共用 `fcpxml.js` 的 `buildFCPXML`：单文件与媒体包走 `exportFCPXML(ctx, {bundle})`，
  持久工程目录走 `exportProject(ctx)` → `POST /fcpxml/project`（`project.fcpxml + media/ + subtitles.srt +
  missing.txt`，不写 zip），落在资产库下的 `FCPXML工程/`，回目录路径、可「打开文件夹 / 复制路径」，不启动软件。
  页面按钮走 `EXPORT_RUN`，助手 `export_start` 走 `Export.project({silent:true})`，判据 `tests/export-formats.cjs` /
  `tests/fcpxml-client.mjs` / `tests/e2e/fcpxml.cjs`。
- 字幕样式（字体 / 字号 / 字色 / 高亮底色 / 粗体 / 投影）写在 `text-style` 上，默认与预览、烧录同源；
  可用 `proj.fcpTitle` 或 `buildFCPXML` 的 `opts.titleStyle` 覆盖，不许在别处再抄一份常量。
- 纯拼装在 `web/director/*`（如 `fcpxml.js`）或 `web/domain/*`，不在页面里拼字符串。
- 缺失素材 / 段落一律报数（清单 / 状态行），不许静默丢。

### 明确禁止

- 不做插件机制（第三方插件、插件市场、插件沙箱）；扩展只走平台声明、页面、动作、Skill 四类落点。
- 不做任意脚本注入 / 执行任意 URL 的动作；助手动作只经 `ActionRegistry` 注册。
- 不恢复 iframe 页面池、换页 reload、上一代旧页面文件或旧路径 wrapper；旧地址只保留路由别名。
- 不在运行时做模板编译、打包或 `new Function`；模板预编译是开发期步骤。
- **不留旧代码的兼容层（硬约束）**：一项实现被替换或撤销，调用点直接接管新实现，旧实现连同它的
  旧键、旧字段、旧端点、旧路径、旧默认值一起删干净。具体禁止的写法：
  「先读旧的、读不到再读新的」这类双读双写；`legacy` / `compat` / `old` / `deprecated` / `v1` 的别名壳；
  给已删除的功能留占位注释、空函数、`return 已撤`式的桩、或者留着没人调用的定义「以防别处还在用」；
  改了数据形状却照旧形状渲染（新写一份、旧的也认）；把已撤销的开关从设置表里抹掉但仍读它的值。
  **判定只有一条：把这段代码删掉，当前这份产品的行为会不会变？** 不会变，它就是兼容层，不留。
  两个例外都只作用于用户机器上已经存在的那些数据，不作用于代码：
  ① 用户数据的落盘搬迁（本体从一个目录搬进另一个目录那种一次性工具，搬完即删）；
  ② 清掉用户机上残留的旧存储键（`web/ui/ui.js` 的 `LEGACY_KEYS` + `sweepLegacyKeys()`）——
  读旧键只为了删掉它（连 `.data` 里那枚镜像一起 `DELETE /data/<键>?nobak=1`，不留 .bak），
  绝不照它渲染任何东西；这一族留着是因为「不清掉的话下次 boot 会从服务器镜像恢复回来」。
  文档与注释的同一件事：不写变更史；注释不指向已删的文档或任务号；但为什么这一枚键 / 这一条落点
  已作废要写全 —— 那是防止有人把它接回去的唯一线索。
- 不新增第二套动作目录、页面路由表、供应商类型表、格式化函数或网络层。

### 文件落点

新增功能先按这张表决定文件，不要临时找地方塞；跨类型的改动按「最靠近数据的一层」落：

| 功能类型 | 落点 | 必须一起改 |
| --- | --- | --- |
| 新页面 | `web/pages/<id>.js` + `tools/vue-templates/<id>.html` + `web/styles/spa-<id>.css` | `web/core/routes.js` 加一条（组件地址 `src` + 私有样式表 `css` + 页面根类 `root`）、运行 `npm run build` |
| 共享 Vue 组件 | `web/ui/<name>.js`，并从 `web/ui/index.js` 导出 | 样式只进 `ui.css`/`tokens.css`；页面不许深路径 import |
| 新的公共样式 / 组件样式 | `web/styles/<组件>.css`，并在 `shell.html` 挂上 | 取值走令牌；公共类进「组件」那张表；页面补丁里不许顶层定义公共类（G20） |
| 共享纯逻辑 | `web/domain/<domain>.js`（挂一个 `window.<Domain>` 面） | 只暴露最小方法；页面不复制规则 |
| 外壳 / 路由 / 生命周期 | `web/core/*.js`、`web/app.js` | 不留页面专用全局；需要跨页桥走 `WBBridge` |
| 新服务端路由 | `server/routes/<name>.js` | 在 `server/app.js` 构造依赖与分发；敏感路由加 `LOCAL_ONLY`；补 e2e |
| 新数据 / 存储 | `server/<name>-store.js` | 原子写 + `.bak`；改结构先做迁移；补数据基线 |
| 新供应商 | `server/registry-config.js` 的 `REGISTRY.providers` | `REGISTRY.version` +1（结构变了才加）、`providers/validate.js`、`tests/providers-validate.cjs` |
| 新导演台纯算法 | `web/director/<domain>.js` | engine 只调用；补 `tests/director-<domain>.mjs`；涉及播放 / 导出再加 e2e |
| 新导演台 DOM 交互 | `web/director/engine.js` 或已有域模块 | 不许在页面层另写编辑算法；必须走 `beginEdit` / `filmEdited` |
| 新助手动作 | `web/features/chat-tools.js` 的 `ACTS` + `ACTION_META` | 策略一行：`effect` / `route` 必填、`undo` 有意不给 = 真退不掉；花钱动作 cancel；补 e2e |
| 新 Skill | `skills/<id>/SKILL.md` | frontmatter（id/name/triggers/pages/contract）；内置正文与 `TextAI.DEF` 同源 |
| 新导出 / 导入格式 | `web/director/*` 或 `web/domain/*` 的纯拼装模块 | 缺失素材报数；导出组表只有 `buildRenderPlan()` 一份 |
| 新测试 | 单元 `tests/<name>.mjs|cjs`；浏览器 `tests/e2e/<name>.cjs` | 加到 `tests/all.cjs`；断言失败要能指出落点 |
| 新视觉基线 | `tests/fixtures/visual/` | 只允许 `UI_VISUAL_WRITE=1` 更新；实际截图走 gitignore |

命名与导入边界：

- 文件名 kebab-case；页面组件 `web/pages/<route-id>.js`；导演台模块按域命名，不按阶段编号。
- 浏览器经典脚本挂一个 `window.<Name>` 面；ESM 页面 / 导演台模块用 `export`，不要两边混着挂。
- 公共层不许反向 import 页面；页面不许深路径引另一个页面的私有模块。
- 跨闭包调用只走导出面 / `window` 公开接口，不裸调兄弟闭包里的局部函数。
- 动态补载公共脚本必须写当前路径（`web/ui/workbench.js`、`web/domain/chars.js`），
  不许再出现根目录旧文件名。

## 已知平台事实

- **VGENV**：列表 / 详情不返回 `prompt`（提示词靠 `PromptLog`）；上传用 camelCase 且拒绝未知字段；
  参考素材用 `{asset_id}`，首尾帧走 `frame_images` + `frame_type`；详情端点是 404 空壳，
  注册表声明 `pollVia:'list'`，列表才是状态依据。
- **SparkCine**：上传用下划线字段 + `sha256` 必填；详情 `outputs[].asset_id`；创建要求 `Idempotency-Key`；
  视频「平台自动润色」是 `create.topBools.optimize_prompt`（顶层）。
- **MiMo**：语音同步合成，没有任务号；本地 `audio_tasks` 是唯一凭据。`tts.encoding:'hex'`
  的返回要按十六进制解码，不要当 base64。
- **MiniMax**：`t2a_v2` 的 `data.audio` 是十六进制；语音字数区间见 `tts.minChars/maxChars`。
- **VGENV 参考图**：非上传素材要转 dataURL（`reference_image` 模板 `image_url:{url}` 只收平台能取到的地址）。
- **幂等与重试**：没有幂等键的 POST 一律不自动重试；`PROMPT_COMPILER_UPSTREAM_ERROR` 表示任务未创建、
  未扣费，可安全重试（`Api.isRetryableCreateError`）。
- **缩略图缓存键**：带签名参数的地址必须先剥签名（`Api.mediaKey`），否则永远命不中。
- **文件大小 / 余量**：`whyNoSpace` 六个落点；量不到余量一律放行。

## 已决定的架构取舍

以下是当前有效的决定，不是待办；改之前先确认能否同时守住行为与热路径预算：

- **导演台编辑器内部保持命令式**：候选条、轨道、切片、播放与拖动不走 Vue 组件化。
  `DirectorView` 是 Vue 页面壳；内部按域拆成纯模块与 `engine/<域>.js`。这些 DOM 节点被缓存、拖拽、
  切片帧、插针与撤销逻辑大量引用；改成 Vue 组件会改变节点身份与更新时机，直接破坏「切页不丢状态 /
  不重解码 / 拖动中途不重建」这些既有判据。剪辑交互与预览引擎同样明确不重写。因此 `engine.js` 仍是
  全站最大的文件（工程数据 + 可变状态 + 接线）；新增能力继续往纯模块与
  域文件里放，不再往 engine.js 加界面代码。
- **DOM 代理保留**：`web/director/index.js` 的 document / window 代理是作用域岛边界，
  保证导演台的弹层、拖拽示意与键盘监听不挂到别的常驻页面；去掉它是行为回退。
- **镜像队列仍在 AssetLocal 的现有队列**：不再引入第二套 `MirrorQueue`；同一份去重 / 退避 /
  持久化逻辑只保留一处。跨刷新待办是 `sk_local_pending`（条目身份 + 元数据，不带大字段）；
  「哪条产物在本机」不落浏览器，每次向代理的别名表现问。
- **会话历史仍存 localStorage**：`ai_chat` 要跟 `DataSync` / 云同步一起走；迁 IndexedDB
  会让对话记录从整包备份与云端消失，收益不抵损失。
- **撤销仍是项目快照栈**：导演台 `undoStack` 存 JSON 快照，足够覆盖当前编辑粒度；
  改成命令日志是独立的协作 / 历史功能，不与本轮 UI 收口混做。
- **样式层不写死，靠四把尺子守**（体检 / 引用完整性 / 五条静态判据 / 视觉回归）。
  档位已全部收敛到终表（间距 8 档、字号 9 档、圆角 5 档、阴影 5 档、时长 5 档、断点 5 档），
  写裸值由 `tools/tokenize-css.cjs` 的值吸附拉进最近终档；档位名只认终表里的那些。
