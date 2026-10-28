# AGENTS.md —— 项目结构、硬约束与开发规范

> 本文件是当前项目的**唯一约定清单**（2026-10-18 版）。改任何一处之前先读对应章节；
> 与代码冲突时以代码为准，并把本文件改到与代码一致，不要留“以前是那样”的说明。
> **代码里不留旧实现的兼容层**（§14.6 的硬约束）：一项实现被替换或撤销，旧的那一份连着旧键、旧字段、
> 旧端点一起删掉，调用点直接接管；只有用户机器上已存在的数据（旧目录里的本体、残留的旧存储键）才需要搬迁或清理。
> 产品使用说明与功能索引见 `README.md`；本文件只写“必须遵守什么、唯一实现在哪、怎么验证”。

## 1. 项目定位

本地优先的 AI 创作工作台：

- 纯前端 Vue 3 SPA + 一个本地 Node 代理（`proxy.js` → `server/app.js`，默认 `http://localhost:5175`）。
- 所有生成平台都经本地代理转发；页面不接触平台密钥，不直连任何外部域名。
- 数据默认留在本机：`.data/`（结构化数据 —— 设置、任务记录、云同步基线，以及本机资产**账** `.data/local-assets/`；
  其中 `.data/models/` 是浏览器内识别的模型缓存，几百 MB、可整目录删掉重下）、`.skills/`（用户 Skill）。
  用户可见的产物与归档在 **`下载\拾帧\`** 下按类型分：`图片/` `视频/` `音频/` `其他/`（**产物本体就住在这里**，
  一条产物一个文件）、`提示词/`（.md 归档）。
  ⚠ **库根**只有一个算法（`server/local-root.js`）：`ASSETS_DIR` 环境变量 > `.data/sk_local_dir.json`（设置页那一格）> `下载\拾帧`。
  账（`.data/local-assets/`）跟着 `.data/` 走，**与本体分家**：换库根只动指针，账不受影响。
  ⚠ 一条产物**只有那一个本体**：同一份东西重复下载、重复补存在账上并成一张卡（§6.3），页面不往第二个目录拷一份。
  ⚠ 换根之后旧根里的文件不会自己跟过去：代理只扫**当前**根，旧根那些产物在界面上照实显示「文件不在了」，
  回源外链与费用记录照样在 —— 要接着用旧根那些字节，就把旧根整个搬进新根。
  `.renders/` 只剩 FCPXML 媒体包（浏览器内合成成片，服务端没有 ffmpeg）。
- 七个页面：导演台、素材库、生成工作台（视频/图像/语音）、收藏、资产库、用量、设置（设置不进侧栏）。路由表只有 `web/core/routes.js` 一份。

## 2. 当前目录结构

```text
.
├─ proxy.js                     薄入口：只 require server/app.js
├─ server/
│  ├─ app.js                    组合根：配置、依赖装配、路由分发、上传/出站工具（约 1.3k 行）
│  ├─ registry-config.js        供应商注册表 REGISTRY + 本机覆盖（型号清单偏好）
│  ├─ relay-gate.js             按平台的在途转发闸与退避重试
│  ├─ local-assets-store.js     本机资产：落点/双身份（fid + 采样签名）/磁盘对账/账口径（HTTP 适配在 routes/local-assets.js）
│  ├─ local-root.js             库根「本体住在哪」的唯一算法（ASSETS_DIR > .data/sk_local_dir.json > 下载\拾帧）
│  ├─ file-safe.js              文件名片段的 Node 侧那一份（与 web/ui/ui.js 同算法，登记在案的例外）
│  ├─ index-store.js            本机资产索引 journal（快照 + 追加日志 + `update(fn)` 串行队列），账在 .data/local-assets/
│  ├─ media-src.js              素材地址解析与下载（resolveSrc / downloadTo / assetInfoOf，唯一一份）
│  ├─ user-dirs.js              用户可见目录根（系统下载文件夹 → 下载\拾帧 / 提示词 / 顶层目录名，唯一一份）
│  ├─ fs-atomic.js              原子写 / .bak / 余量与重试口径
│  ├─ data-store.js             /data 读写、原子写、.bak 备份
│  ├─ prompts-store.js          /prompts 提示词归档
│  ├─ cloud-store.js            /cloud 云同步
│  ├─ skills-store.js           .skills 清单 / 安装 / 启停
│  ├─ asr-store.js              .data/asr.json（密钥只留盘上，读接口只回 hasKey）
│  ├─ search-store.js           .data/search.json（同上）
│  ├─ channel-cred.js           设置页两条「通道」（识别 / 搜索）共用的取数小件（回环判定只有这一份）
│  ├─ static.js                 静态文件：ETag / 预压缩（br→gzip→原文）/ HTML 的 CSP 头
│  ├─ security.js               同源、Cookie、出站 URL 护栏
│  ├─ outbound.js               出站 HTTP（超时 / 重试 / 代理）
│  ├─ health.js                 代理故障账（只报不自杀，也收客户端上报）
│  ├─ lock.js                   单实例锁
│  ├─ zip.js                    FCPXML 媒体包 zip
│  ├─ providers/validate.js     registry 供应商声明校验
│  └─ routes/                   system（含 /client-error）/ static / capabilities / registry /
│                               relay / outbound / local-assets / usage / cache /
│                               skills / fcpxml / pick-dir / asr / models / search /
│                               http（路由层唯一的 JSON 回包口径：sendJson / fail，默认 no-store）
├─ shell.html                   SPA 外壳（CSP、启动脚本、公共模块）
├─ web/
│  ├─ app.js                    Vue 外壳：hash 路由 + KeepAlive 页面池 + 生命周期
│  ├─ shell-boot.js             主题与“在外壳里”旗标（外部脚本，避免内联脚本）
│  ├─ boot-assistant.js         空闲时加载 AI 助手（`ai_chat_off` 命中就整个不下载）
│  ├─ core/                     routes / bridges / page-context / hooks / activity / actions / report
│  ├─ pages/                    favorites / usage / assets / settings / chars / studio（导演台在 web/director/index.js）
│  ├─ media-backend.js          浏览器内媒体后端（mediabunny 主档 + <video> 兜底：info / frame / thumbs）
│  ├─ media-export.js           浏览器内离线导出（帧计划 / 合成 / 混音 / mediabunny Output；成片与素材都走它）
│  ├─ director/                 导演台：index + template.html + engine.js + engine/<域>.js（按域搬出的热路径）+ 纯算法模块
│  ├─ render/                   预编译生成的 render 函数（不要手改）
│  ├─ ui/                       ui.js / forms（弹窗与表单族）/ net / store / kv / toast / datasync /
│  │                            skills / workbench / sidebar / index / badge-state
│  ├─ domain/                   api / assetlib / gen-forms / asset-transfer / export-dir / local / capabilities /
│  │                            text-ai / gen-rules / fav / prompt-log / asset-picker / ai-find / chars /
│  │                            ident / asset-ref / identity / semantic / asr / search / zip-read /
│  │                            chat/text-util / text-ai/contracts
│  ├─ features/chat.js          AI 助手外壳：悬浮球 / 抽屉 / 会话 / 发送循环
│  ├─ features/chat-tools.js    助手工具循环与动作目录（TOOLS / ACTS / 两张形状表）
│  ├─ package.json             {"type":"module"}（让 node 测试按 ESM 读 web/ 模块）
│  └─ styles/                   tokens.css / ui.css / wb.css / sidebar.css / chat.css / spa-*.css
├─ tools/
│  ├─ precompile-vue.cjs        模板 → render 函数（开发期）
│  ├─ tokenize-css.cjs          裸值体检 + 机械替换 + 值→令牌映射（§3.4 收敛用）
│  ├─ token-lib.cjs             上面两个工具的共用件：规则表 / 扫描范围 / 值→令牌的映射（只有这一份）
│  ├─ check-vars.cjs            令牌引用完整性（引了没定义的令牌 → 声明作废且浏览器不报错）
│  ├─ migrate-skills.cjs        一次性迁移：用户 Skill 目录换根
│  └─ vue-templates/            模板源（开发期，不进运行时）
├─ skills/<id>/SKILL.md         内置 Skill（随页面/触发词加载）
├─ tests/                       常驻判据、单元、e2e、fixtures、数据基线
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
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';
font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'; worker-src 'self' blob:
```

- `'wasm-unsafe-eval'` **只放开 WebAssembly 编译**（mediabunny 的解码/编码走 WebCodecs 与 wasm），不放开 `eval` / `new Function`；新增脚本仍必须是同源外部文件。

- `script-src 'self'`：不许内联脚本、不许内联事件处理器、不许 eval。新增脚本必须是同源外部文件。
- `style-src 'unsafe-inline'`：允许现有的 `style=` 与动态样式元素；不要新增内联 `<style>` 以外的脚本能力。
- 页面代码里的所有 URL 必须是同源相对路径；媒体用 `Api.mediaSrc()`。

### 3.4 设计规范（硬约束）

这一节是**界面层的硬约束**：令牌、主题、布局、组件、交互、验证。
下面每一条都有尺子或判据盯着 —— 违反不是「不好看」，是**判据红**。

#### 3.4.1 令牌：唯一的取值出处

- `web/styles/tokens.css` 是**唯一**的主题 / 间距 / 字号 / 圆角 / 描边宽 / 组件尺寸 / 阴影 / 动效令牌来源；
  别的样式表与页面 CSS 不许再定义 `:root` 或 `html[data-theme="dark"]` 的第二套变量。
- **令牌名 = 它的值**：`--sp-14` 就是 14px、`--fs-12-5` 就是 12.5px、`--radius-10` 就是 10px、
  `--acc-tint-18` 就是 18%。早先「序号 = 档位」的写法（`--sp-1:4px` / `--fs-1:12px`）已经全部改成按值命名 ——
  序号写法要人记「--sp-3 是几像素」，而且同一档里两套命名并存时必然漂开（`--fs-1` 与 `--fs-12` 指的是
  两个完全不同的字号，却看不出差别）。**不许回退到序号写法。**
- 尺寸档位分**主档**与**补档**：

  | 档 | 主档（新代码优先用） | 补档（收容现存值） |
  | --- | --- | --- |
  | 间距 `--sp-*` | 4 / 8 / 12 / 16 / 24 / 32 | 1–3、5–7、9–11、13–15、18–20、22、26、28、34、40、42、54、60 |
  | 字号 `--fs-*` | 12 / 13 / 14 / 16 / 20 / 24 | 其余（8.5–11.5、12.5、13.5、14.5、15、17、18、19、42） |
  | 圆角 `--radius-*` | 6 / 10 / 14 | 其余（1–5、7–9、12、20、99、999） |
  | 组件尺寸 `--sz-*` | 角色命名：`--sz-ico` `--sz-ctl` `--sz-tile` `--sz-thumb-h` `--sz-card` `--sz-scroll` `--sz-wb` | — |

  补档是「那些值本来就在那儿、只是没名字」的**收容位**，等布局重构那一轮统一收敛
  （收敛时只改 `tokens.css` 这一个文件，调用点不用动）。候选映射与影响面见 §16 的 `--collapse`。
- **不许写令牌兜底值**：`var(--x, #fallback)` 里的兜底是**同一个数的第二份拷贝**，两边会漂开。
  令牌要么在 `tokens.css` 里声明，要么由 JS 运行时写到 DOM 上（那种要在 CSS 里也声明一份默认值，
  JS 的行内样式覆盖它）。
- **`calc()` 里必须写 `var(--x)`**：`calc(-1 * --sp-4)` 是非法 CSS —— 声明整条作废、退回初始值，
  页面照常显示、只是那一处没了，肉眼极难发现。负偏移写成 `calc(-1 * var(--sp-4))`。
- **透明度只走 `--a-*` 阶梯**：`color-mix(in srgb, var(--基色) var(--a-10), transparent)`。
  阶梯是「用量 ≥4 次」的 21 档；零星百分比是存量（判据 G21 登记在案，只许减不许增）。
- 页面样式**不许再写裸的**间距 / 字号 / 圆角 / 描边宽 / 色值 / 时长。
- **模板源也在射程里**：`tools/vue-templates/*.html` 预编译进 `web/render/*.js`，等于活代码，
  它的行内 `style=` 同样不许写死。

#### 3.4.2 主题：深浅两档与「固定色」的边界

`tokens.css` 按段分清了三件事 —— **换主题时只动 ① 与深色档**：

| 段 | 内容 | 跟不跟主题走 |
| --- | --- | --- |
| ① 主题色 | `--bg` `--panel` `--line` `--txt` `--sub` `--acc` `--acc2` `--ok` `--warn` `--err` `--pri` `--input` `--thumbbg` `--atbg` `--scroll` | **跟**：深浅两档必须成对覆盖（判据 G19） |
| ①b 两档一致的固定色 | `--on-acc` `--media-bg` `--chart-1..12` | 不跟（反白字、媒体黑底、图表色两档该同值） |
| ② 派生色 | `--acc-tint-*` `--acc-line-32` `--warn-tint` | **跟**（由 ① 现算） |
| ③ 固定中性色 | `--pal-gray*` `--pal-slate*` `--pal-scrim` | 不跟（只给**深底浮层**用：灯箱、缩略图上的播放钮遮罩） |
| ③b 导演台标记色 | `--mark-cut` `--mark-ready` `--mark-mute` `--mark-loud` | **跟**：轨道里的功能标记（切点 / 就绪 / 静音 / 音量高），深浅两档各一套 |

- **导演台不再有独立深底作用域**（2026-10-25 收口）：以前它有整整一族 `--dir-*`
  （深底表面 `--dir-ink-*`、深底浅字 `--dir-fog-*`、一串标记色），两档主题下都是黑的。
  现在它的底色 / 文字 / 描边一律取 ① 段（`--bg` / `--panel` / `--panel2` / `--txt` /
  `--sub` / `--line`），**跟其他页面一样切主题**；只留下 ③b 那四枚功能标记色。
  判据：`tokens.css` 里 `--dir-` 必须 0 命中（`tests/doc-contract.cjs`）。

- 共享界面的文字 / 描边 / 底色 / 状态**一律取 ① 段**（`--err` / `--warn` / `--ok` / `--acc` / `--acc2`），
  **不许再挑固定色** —— 挑固定色的后果是「深色主题里错误色还是浅色的红」。
- 加一枚新的主题色时，**深色档必须一起加**（判据 G19）；深色档里拼错的名字不会报错，只是**静默失效**，
  同一条判据也把它抓住。
- 换主题的验收方式：切 `html[data-theme]` 后逐屏看 —— 浅/深两档的语义色必须各自成体系，
  不允许某一档里出现「另一种主题的颜色」。
- 页面确有品牌差异时，只在该页根类下覆盖**一个**变量，并写明理由；不许自己另起一套色。

#### 3.4.3 布局：两种页面外壳

| 外壳 | 用在哪 | 形状 | 定义在哪 |
| --- | --- | --- | --- |
| `.page-shell` | 素材库 / 资产库 / 收藏 / 用量 / 设置 | 页头 + 留白 + 整页滚动 | `web/styles/ui.css` |
| `.wb` | 生成工作台 | 左栏写、右栏看，两栏各自滚动 + 生成按钮 + 状态行 | `web/styles/wb.css` |
| `.sidebar` | 全站（外壳层，不在页面里） | **满 232px / 窄 56px 两个形态**，收/展的开关是左上角那块品牌砖 | `web/styles/sidebar.css` |

- **侧栏只有两个形态**（2026-10-25 收口，详见 §11.1）：满 232px（图标 + 完整名字 + 「此刻」卡）与
  窄 56px（图标 + **两字短标签**，认得出、不靠悬停）。收/展的开关是**左上角那块品牌砖** ——
  侧栏里**没有第二样收展标识**（不画箭头、不画拉片：品牌块是品牌，不是控件；箭头在两个形态里
  指向相反，看着像两件不同的事）。两态共用同一套垂直节奏（顶行 58 / 导航行 42 / 底部行 36），
  收展开时侧栏里没有任何东西上下跳。栏宽只有 `--sbw`（56）与 `--sbw-full`（232）两枚令牌，
  消费方（`#app` / 悬浮球 / 灯箱）都读它们，**不许再写死像素**。

- **外壳只有这一份**（2026-10 收口）：`.page-shell` 给全站普通页 —— 定位（`position:absolute; inset:0`）、
  滚动（整页滚）、盒模型（`box-sizing`）与留白都在它身上；以前六个页面各抄了一遍前四项，
  差一个像素就是某一页多一条滚动条、某一页少一圈留白。`.wb` 是工作台那一份（定位与盒模型同源，
  滚法不同：整页不滚，两栏各自滚）。**导演台是作用域岛，它不吃 `.page-shell` 的留白**
  （内部 `.page-main` 是整屏高的列），那一份另在 `web/styles/spa-director.css`。
- **页头只有这一份**（2026-10-25 收口，2026-10-27 去图标）：`.phead` 是各页面共用的那条横带 —— 跨页宽、**粘顶**，
  四个槽按需留空、位置不挪：`A 身份`（标题，**每页都有**）/ `B 上下文`
  （计数 / 状态 / 当前项目）/ `C 说明`（一句话：这页在干嘛）/ `D 动作`（页面级动作 ≤3 个）。
  三条硬规矩：
  ① **页面名只说一次** —— 素材库左轨不再重复写「素材库」，那里改成「目录」；
  ② **筛选与视图切换不进页头** —— 页头放「这一页能干什么」，下面那行工具条放「怎么看这一页」；
  ③ **标题不带图标** —— 那枚 26px 强调色铭牌（`.phead-ic`）已经撤掉：七页各挂一枚，
  切页时标题旁边多一格、强调色也多一个落点，标题本身反而不突出（用户点名移除）。
  `.phead-id` 就是标题容器，**不要再往里加图形 / 徽记 / 装饰**。
- **标题左缘 = 该页内容列的左缘，内容列离内容区左缘一律 32px**（`--shell-px: var(--sp-32)`）：
  七个页面各读同一枚变量，切页时标题不再左右跳。以前是五套（素材库 32 而下方三栏 0 /
  资产库等 32 / 设置 24 / 导演台 20 / 工作台「居中块 + 22」）。760 以下全站一起收到 `--sp-14`。
  判据 `tests/e2e/page-head.cjs` 直接比「标题左缘」与「内容列左缘」（±1px）。
- **两个「块」必须同宽同起点**：页头那条与页面主体那块（`.wb .layout` / 导演台 `.layout` /
  设置页的网格）读同一套定宽口径 —— 页头宽、主体窄或反过来，标题就与下面的内容对不齐。
  ⚠ 工作台那块尤其要写死宽度（`width: 100%`）：`.wb` 是 flex 列，子项带 `margin: 0 auto`
  会按**内容**定宽，而内容宽度里含着左栏那一轨 → 拖一下分栏，页面两端的空白跟着变。
  `.page-shell` 的 `padding-top` 归零（`--shell-px` 只管左右），上留白由 `.phead` 自己给 ——
  吸顶时页头已在 scrollport 顶上，没有「从 24px 跳到 0」的位移。
  素材库与工作台是**整屏不滚**的外壳：页头是它们的第一行，下面那层占满剩下（`.chars-page .mat` /
  `.wb .layout` 各改一行定位即可），所以那两页的页头不吸顶（没有可滚的容器），但形状与别的页一致。
  **导演台也是这一副契约**（`web/director/template.html` 的 `<header class="phead">`）：
  它不再自己一套 header —— 身份（导演台）+ 上下文（当前项目：短片数 / 项目名 / 已保存）
  + 动作（导出）；导演台整页不滚，所以它的页头也不吸顶。它的横向留白也从 `.page-main`
  上的 `--shell-px` 取（页头与三栏同一枚）。
- **页面自己的差异**（卡片网格、提示词区、素材槽…）留在各自的 `web/styles/spa-<id>.css` 里，
  且**必须挂在该页根类下**（`.chars-page .card`）；**不许**在页面补丁里顶层定义公共类（判据 G20）。
- **卡片列宽只有两档**：`--sz-card`（268px）与 `--sz-card-sm`（200px，紧凑视图 / 窄窗）。
  以前四页各写各的（268 / 220 / 200 / 180 / 150），切页时卡片密度忽宽忽窄。
- **翻页行一处一套，位置按外壳分**：普通页（收藏 / 素材库 / 资产库）在页面**底部**；
  **生成工作台在右栏的上方**（搜索那一排下面、结果区上面）—— 工作台是「两栏各自滚」，
  右栏自己滚，页底那一行要滚到最下面才看得见，翻页放在那儿等于没有。
  以前资产库把它塞在顶部筛选行里、工作台塞在右栏头那一排按钮中间 —— 切页要重新找位置。
  判据 `tests/e2e/pager-row.cjs` 盯「四页的翻页行都画出来」。
- 页面根元素统一是 `class="page-main <id>-page <外壳类>"`：`.page-main` 与 `<id>-page` 由路由表的
  `root` 带着，工作台页额外挂 `.wb`。
- **断点**：媒体查询里**不能**用 CSS 变量（`var()` 在 `@media` 里不成立），所以断点只能靠
  「登记 + 判据 G22」防漂移。当前登记的 11 档：520 / 620 / 700 / 720 / 760 / 820 / 900 / 960 /
  1100 / 1180 / 1200 —— 偏多，布局重构那轮再收成 3–5 档。
- **设置页是第三种外壳**（2026-10-25 重排）：**两栏两滚** —— 左边是目录轨（索引），
  右边是 15 张卡排成的一条**连续文档**；**页面自己不滚**，目录轨与那条文档各滚各的
  （与 `.wb` 工作台同一套做法）。因此：
  · 滚动的**唯一出口**是 `scrollToEl`（`web/pages/settings.js`）：它给**钉住的组标题**让出高度
    （`--setanchor`，组标题多高就让多少，由 JS 量出来写进 CSS 变量），并在落定后补校正；
    这一页不许有第二处裸 `scrollIntoView`（判据 `tests/e2e/settings-nav.cjs` 直接数源码）。
  · 目录轨与那份文档的**组名 / 栏目标题全部从 DOM 现读**（`.set-group[data-group]` 与
    `.card[data-nav]`），JS 里不许有第二份清单；轨上每行的**当前值**现读同一份真相
    （`UI_PREFS` / `PAGE_TARGETS` / `Net.NUMS` / `SET_ROWS` / 注册表 / `asr` / `search` / 体检与用量），
    不另存一份状态 —— 另存一份就会与卡里画着的那一项各说各话。
  · 轨上一共 **15 行**：**一张卡一行**。「语音识别」「联网搜索」是供应商那张卡里的两档
    （与图片 / 视频 / 语音 / 文字同一层级），轨上**不另占行** —— 轨索引的是「卡」，
    卡里的档位不重复列一遍（重复列 = 轨与卡变成两份清单）。
  · **滚动定位**：右栏滚到哪一栏，轨上那一行就亮；点轨上一行 → 右栏平滑滚到那一栏
    （当场就亮，落定不回跳；折叠组里的那一栏先展开，**展开不写盘**）。
  · 这一页**没有「保存」按钮**，所以「改完就存本机 · 刚刚存过」那句回执必须在**状态行**里
    （`.set-save`），不能没有。
- 同一条 flex 列里两块抢高度（侧栏导航 vs 余额区），**只许有一处** `flex-shrink` + `overflow-y:auto`
  当兜底；把「可缩可滚」那份额度换给另一块时，另一处的兜底要显式 revert 回来，而且 revert
  必须跟着「这一档到底画不画这一块」走。落到侧栏那两档的写法见 §11.1。

#### 3.4.4 组件：公共件复用

**同一个功能只应有一份实现**。新写任何界面块之前，先按 §7 的唯一实现清单查一遍；已有组件能表达的就直接用，
不够用就扩展公共组件，**不允许在页面里复制一份“看起来差不多”的实现**。

**JS 公共件**（页面只能从 `web/ui/index.js` 取）：

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
| 本机 / 云端标识 | `badgeOf` / `badgeHTML`（`web/ui/badge-state.js`）+ `AssetLocal.stateOf` |

**公共样式类**（`web/styles/ui.css` / `wb.css` 里的公共层）——页面只许在**自己的根类下**改它们：

| 角色 | 公共类 |
| --- | --- |
| 页面页头（跨页宽、粘顶） | `.phead` + `.phead-id`（标题，**不带图标**）/ `.phead-meta`（上下文）/ `.phead-sub`（说明）/ `.phead-acts`（动作）/ `.phead-chip`（上下文胶囊）—— **各页面共用这一条**，见 §3.4.3 |
| 文件类型筛选（图片/视频/音频） | `Wb.kindFilter`（分段控件 `.ui-seg` + 每档计数 `.seg-n`）—— 工作台 / 收藏 / 资产库**三页共用**；档位表、每档条数、点完之后做什么由页面给（见 §7） |
| 卡片 / 列表行 | `.card` `.card-surface` `.task` `.ap-item`（竖排卡片的壳：`.card-shell-media` / `.card-shell-body` / `.card-shell-actions` —— 收藏的媒体卡与素材库的角色卡共用这一副，页面只留自己的差异：图多高、怎么裁、字距多少；横排的任务卡走 `.task` 那一组） |
| 卡片公共件（状态牌 / 就地展开 / 账条 / 诊断块 / 展开带子） | `.plate`（+ `.plate--*`） `.exp` `.led` `.why` `.diag` `.exp-acts` `.band`（+ `.band-tether`）—— **资产库与收藏页共用同一副**（`web/styles/ui.css`）；接线是 `Wb.expand` / `Wb.close` / `Wb.closeAll` / `Wb.anchor`（`web/ui/workbench.js`）。**展开不许另起一层**（右检 / 抽屉 / 浮层都不算）：在原界面里把那张卡自己打开 |
| 按钮 | `.pri`（主） `.ghost`（次） `.tool`（磁贴） `.ui-linkbtn`（文字链式小动作）—— **新建按钮先读 §3.4.5 的四步**（`type="button"` / 重画走 `viewport.keep` / focus 走 `focusQuiet` / 跳页走 `GoPage`） |
| 分段 / 芯片 | `.ui-seg` `.chip` |
| 徽标 / 提示条 | `.ui-tag` `.ui-note` `.list-note` `.srcbadge` |
| 表单 | `.pgroup` `.dd` `.dd-list` `.dd-btn` `.pinl` |
| 空态 / 加载 | `.empty` `.ui-wait` |
| 工具条 / 视图切换 / 分页 | `.toolbar` `.viewtoggle` `.pager-row` `.pginfo` |
| 浮层 | `.ui-vrow` `.ui-voice` `.ui-cands` |

- 页面只允许写“这一页自己的排版与布局”；卡片、弹层、下拉、芯片、分页、缩略图、提示、确认这些**不许**
  在页面里出现第二份。发现重复实现，先把公共件补齐再把页面改过去，不要在旧副本上继续加功能。
- 存量页面里还有迁徙前手写的卡片/列表标记：**新功能与新建页面一律按上表执行**；改到哪一页就把那一页
  顺手收敛到公共件，不要再新增第二份手写实现。
- 判据 **G20** 盯着「页面补丁里不许顶层定义公共类」—— 页面差异必须写成
  `.chars-page .card` / `.studio-page .task` 这种挂在页面根类下的形式。
- 样式表都是**真实文件**：`web/styles/` 下按组件分（`ui.css` 公共件、`wb.css` 工作台外壳、
  `sidebar.css` 侧栏、`chat.css` 助手面板、`spa-<id>.css` 页面补丁），由 `shell.html` 统一挂载；
  **不许把一段 CSS 塞进 JS 模板字符串**（助手面板那 250 行曾经就藏在 `chat.js` 的模板字符串里）。
  唯一例外是 `web/director/template.html` 内嵌的 `<style>` 块 —— 导演台是作用域岛，
  那块样式跟着模板一起被 `index.js` 取用（§9.1）；它里面的取值同样走令牌。

#### 3.4.5 交互

- 所有可交互元素至少覆盖 `hover` / `focus-visible` / `active` / `disabled` / busy；
  `ui.css` 末尾有一份全站兜底，页面不要重复写同一份焦点样式。
- **程序性 focus 不许抢视口**：拿 `focus()` 只是为了「把光标续上」时一律走
  `window.focusQuiet(el)`（`web/ui/ui.js`，它带 `{ preventScroll: true }`；全站唯一一份）——
  不带的话浏览器会把那一格滚进视野，用户明明在看别处，视角却被拽走。
  真要「把某处滚过来」，走滚动那一族（设置页的 `scrollToEl` / `scrollIntoView`），别拿 focus 当滚动用。

**加一颗按钮要走的四步**（2026-10-27 立；前三条就是「点一颗按钮，页面跳回最上面」那一族的防线，
判据 `tests/e2e/viewport-keep.cjs`）：

1. **元素**：用 `<button type="button">`，**永远不用 `<a href="#">`**。`href="#"` 会产生一次
   fragment 导航 —— 即使 `preventDefault` 挡住了，中键点击 / 键盘回车 / 「在新标签打开」都还留着那条路；
   而 `<button>` 在 `form` / `dialog` 里默认是 `submit`，**`type="button"` 必须写**（漏写就是一次提交 + 页面跳走）。
   外观只用公共类（`.pri` 主 / `.ghost` 次 / `.tool` 磁贴 / `.ui-linkbtn` 文字链式小动作），不另写一份样式；
   带图标时用 `icon('xxx', 13)` 或 `data-icon` + `fillIcons`，**不许用 `textContent` 改字**（会把图标冲掉）。
2. **它换不换 DOM**：点完会**整片重画**一块「里面装着滚动容器」的区域时，那次重画必须包在
   `Wb.viewport.keep(el, fn)` 里 —— `el` 是那块要重画的**外层**（不是按钮），公共件按**锚点**在重画后
   把容器里的滚动位还回去（锚点以上的内容变高变矮都不漂）。列表刷新不用页面操心：`Wb.cards.paint`
   内部已经套了；`Wb.filterBar` / `Wb.kindFilter` 是就地改文本、不整片重画。
3. **它 focus 谁**：要让光标落进某格输入框 → `window.focusQuiet(el)`；真想让那一格进视野，另写一句
   `scrollIntoView({ block: 'nearest' })`。**别拿 focus 当滚动用**。
4. **它跳不跳页**：站内跳页只走 `GoPage.go('xxx.html')`，不写 `location.href`、不手拼 `location.hash`。

自检三问：**这颗按钮会不会换掉某块 `innerHTML`？换了套 `keep` 了吗？它会 focus 谁、带 `preventScroll` 了吗？**

#### 3.4.6 验证：四把尺子

| 尺子 | 管什么 | 命令 |
| --- | --- | --- |
| 体检 | 样式层还有没有裸值 | `node tools/tokenize-css.cjs`（`--write` 机械替换 / `--map` 看映射 / `--collapse` 看收敛影响面） |
| 引用完整性 | 有没有引了没定义的令牌（静默失效） | `node tools/check-vars.cjs` |
| 静态判据 | G18 裸值 / G19 主题色成对 / G20 页面不顶层定义公共类 / G21 透明度阶梯 / G22 断点登记 | `node tests/static-guards.cjs` |
| 视觉回归 | 画面有没有变 | `node tests/e2e/ui-visual.cjs` |

- 静态判据的存量表**只许减不许增**（`GUARD_WRITE=1` 重打表，但每条都要补一句原因）。
- 视觉回归：七条路由（工作台按视频/图像/语音分三档 → 九档），再加两档「要喂状态才画得出来」的
  「字幕编辑区 / 助手来源卡片」，共 **11 档 × 1024/1440 × 浅/深主题 = 44 个画面**，24×14 RGB 指纹；
  字幕那一档要本机 ffmpeg 造可选用的视频，没有就整档跳过并报明。
  首次或**有意改版**后：`UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs` 更新
  `tests/fixtures/visual/fingerprints.json`；不要为了让测试变绿随意放宽阈值。

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

### 3.6 文案硬约束（用户可见字符串）

- **不解释显而易见行为**：按钮能自明就不加旁注；title 不复述按钮名；说明句超过 15 字先删再考虑压短。
- **空状态只留名词短语**（「还没有产物」），不写页面用途、不教下一步。
- **加载中统一「加载中…」**（体检中 / 估价中等专用语除外）；错误提示只留「原因 + 怎么办」最短形态。
- **同一能力同一词**：取消收藏（不用「移出收藏」）、重试（不用「再试」）、已选 N 项、型号（不用「模型」）；
  同一句文案只维护一份（模板与 CSS content、模板与 JS 不许双份）。
- 模板改完必须 `npm run build`；`web/render/` 不手改。喂给模型的提示词（SKILL.md 正文、chat 的 system prompt）不是 UI 文案，不动。

## 4. 统一路由与安全边界（硬性）

### 4.1 页面不直连外部域名

页面里的每个外部请求只能打到本地代理同源相对路径：

```text
/registry /capabilities /<relay>/* /custom/<id>/* /getv /fetch /getfile /s3put
/asset/<id> /local-assets /local-assets/from-url /pick-dir /cache/*
/models/<id>/<file> /fcpxml/* /data /prompts /cloud /skills /sys-status /env-status /clear-cache
```

- 平台接口只走 `Api.request(prov, 'create'|'poll'|'list'|'cancel'|'credits'…)`、
  `Api.create`、`Api.createBody`。
- 自己拼 URL 只用 `prov.relay + prov.endpoints.*`；不要用 `prov.base`（只给代理）。
- 媒体地址一律 `Api.mediaSrc()`；缩略图缓存键用 `Api.mediaKey()` / `Wb.thumbs.keyOf()`。
- 允许的非外部地址：同源相对路径、`data:`、`blob:`。

### 4.2 本机路由与会话

- `LOCAL_ONLY` 路由：`/data`、`/prompts`、`/cloud`、`/capabilities`、`/skills`、`/local-assets`、
  `/assets-usage`、`/pick-dir`、`/env-status`、`/sys-status`、`/clear-cache`、`/cache/*`、
  `/fcpxml`、`/models`、`/getv`、`/getfile`、`/fetch`、`/s3put`、`/custom`。
- 代理启动时生成会话 Cookie `wb_session`（HttpOnly + SameSite=Strict）。本机路由除同源检查外
  还要求这枚 Cookie；没有 Cookie 的 curl 读 `/data` 会拿到 401。
- 新写探针先用 `GET /` 收下 `Set-Cookie` 再打本机路由（样板见 `tests/e2e/harness.cjs`）。
- relay 前缀与 `/asset/<id>` 也只接受同源请求（跨站 403）；relay 前缀从
  `REGISTRY.providers[].relay` 现取，不要手写。
- **relay 前缀一家一段**（2026-10-25 起，v19）：转发、转发闸、create 判定都按前缀认家，
  前缀挂了不等价的几家，第二家的请求与密钥就会打到第一家的 base 上（v19 以前八家文字 AI
  共用 `/textai`，非 DeepSeek 的密钥被原样发给 api.deepseek.com）。同一段前缀只允许
  **base / keyEnv / endpoints 完全一致**的等价声明共用（sparkcine 两家），判据在
  `server/providers/validate.js`（tests/providers-validate.cjs 盯着）。

### 4.3 出站护栏

- 代理主动取字节前必须过 `guardOutboundUrl`（异步，含 DNS）或 `safeOutboundUrl`（同步字面量）：
  只允许公网 **https**；回环 / 内网 / 链路本地 / 解析到内网的域名一律拒。
- **走系统 / 环境代理的出站是 CONNECT 隧道**（`server/outbound.js` 的 `ProxyTunnelAgent`）：
  代理来源只认「`.env` 的 PROXY_OFF=1 > 环境变量 HTTPS_PROXY 等五键 > Windows 系统代理（后台 `reg query` 每 30s 刷）」。
  隧道这条路上目标域名由代理端解析 —— `guardOutboundUrl` 的本地 DNS 校验与 `guardedLookup` 注入
  都按 `setProxyProbe` 的探针答复整道跳过（直连路径照旧），否则 Clash 一类开 fake-ip 后公网域名
  在本机全解析成 198.18.x.x、出站条条被拦；198.18.0.0/15 仍在 `isPrivateHost` 的拦截表里（直连时必须拦）。
  代理开关 / 换地址（label 变了）即 `security.resetHostGuard()` 清一次 DNS 闸缓存。
  判据 `tests/proxy-tunnel.cjs`（假代理 + 本地 TLS 目标，离线跑通 CONNECT + TLS + 复用 + 拒绝四条）。
- `/getfile`、`/s3put`、`/fetch`、`/getv` 四条通道只走 `takeOutboundUrl`，不要各自拼 400。
- 状态码原样透传；4xx/5xx 一律 `no-store`（签名过期 403 不能被缓存一整天）。

### 4.4 本机写盘的三条硬约束

- **产物本体的落点不由请求说了算**：`POST /local-assets` 与 `POST /local-assets/from-url` 只问
  `server/local-assets-store.js` 的 `bodyDirOf` / `newBodyPlace` —— 库根按 §7 那一条现算，根下按类型分
  `图片/` `视频/` `音频/` `其他/`，撞名加 `-2` / `-3`；请求体里带 `dir` 也没有哪一行去读它。
  一条产物只有那一个本体，同一份东西重复下载、重复补存在账上并成一张卡（§6.3），不往第二个目录拷一份。
- **`/from-url` 先问地址的真相再问声明**：目标地址（或名字）pathname 上认得出的扩展名压过请求体里的
  `format` —— 是媒体就按它归类（声明写错至少落点对），是文档类（`isDocExt`：srt/vtt/ass/txt/json…）
  整个 400 拒收，客户端猜不出格式兜底声明的 mp4 绕不开这道闸（字幕 / 文本的去处是下载目录与提示词归档）；
  认不出的扩展名不猜，仍按声明走。
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
- **「供应商与密钥」是账号卡流**（2026-10-27 收口）：
  · 归并按 `keyId`（`provGroups()`）：**一个账号一张卡**，卡顶那一排能力格只画这家会的几档
    （`.capcell`：实心 = 主位 / 淡底 = 在用 / 白底 = 备用 / 压暗 = 停用），一档一行
    （`.crow`：能力名 · 状态牌 · 文字档那一个型号下拉 + 测试 / 其余档「型号 n/m」就地展开清单）。
  · **等高竖排**：列宽 `--sz-acct-w`（`auto-fill` 铺满），卡高 `--sz-acct`，卡内 `.acct-mid`
    自己滚 —— 展开密钥行、展开型号面板都**不改卡的外形**（外形一变，整片重画后手指底下的位置就跳）。
  · **密钥默认收着**，开关是名字右边那颗 `.keytoggle`；名字本身链官网（↗）；
    **接口地址不在卡上改**（预设那几家一律走官方地址，中转站 / 网关加成自定义供应商）。
  · 型号面板按**槽**（`keyId:档`）存「展开的是哪一格 / 刚取回的那一份」，两档同时开着不会串档；
    落盘仍是账号级（`sk_model_<keyId>`、`.data/sk_model_prefs.json` 的 `typed` / `off` / `got`），
    面板里那一行 hint 照实说「按账号存」。**没有「每档默认型号」这一层**。
  · 添加供应商 = 卡片流末尾那张虚线卡，**两个形态、同一张卡**：常态列预设那几家（点「添加」把它请进界面
    并摊开密钥行，**什么都没写盘**；填了密钥才由自动保存落 `sk_key_<keyId>`）；
    点「＋ 自定义」这张卡自己变成「添加自定义供应商」（标题换了、右上角是「返回预设」），
    字段就在卡里填 —— **没有第二套添加界面、没有另一个表头、没有「收起」**。
    **卡片尺寸不变**（等高是这一页的规矩）：那十几行字段在卡内 `.acct-mid` 里滚。
    自定义那张表只收：接口形状 → 显示名 → 地址 → 密钥 → **能力档位**（密钥之后，与卡顶那排能力格
    同一副 `.capcell` 图标、**可多选**：第一个是主档，决定接口形状与这条自定义条目的 kind；
    其余记成 `sk_caps_<id>` 的「手动声明」）→ 型号。**没有「供应商」那一格**（要接内置那几家，
    上面那张卡的预设清单里点「添加」）。
  · **手动加一档能力**（`.capadd` / `MANUAL_OK`）：注册表里没写这家能做的那一档，可以在卡里自己声明 ——
    存 `sk_caps_<keyId>`（一个 JSON 数组），`provGroups()` 把它并在 `caps` 后面，`capProv()` 给这一档
    合成一条**只用于界面**的伪声明（`manual: true`，`endpoints` 空 → 型号面板没有「取一次」，只剩「自己填」）。
    那一行挂「手动」标记、可以「撤掉」。⚠ 只有 `image / video / audio / asr / search` 能手动加：
    生成三档加完只是**声明**（真能出图还要注册表里一条端点声明，行里写明）；识别 / 搜索走这家自己的
    地址与密钥，加完就能用；**文字对话不在这里加**（`TextAI` 按 `kind: 'text'` 筛，加在别家身上不生效）。
  · 按档筛的芯片（数字 = **账号数**）+ 摘要条 + 排序（主位 / 在用 → 备用 → 没接上）。
  · 那一排「图片 / 视频 / 语音 / 文字」分段开关与它的 `sk_prov_tab` **已撤**（`ui.js` 的
    `LEGACY_KEYS` 负责清盘）—— 一家账号一张卡之后，「当前哪一档」这个状态本身不存在。
- **语音识别**（`asr`）与**联网搜索**（`search`）与四类平台**同一层级**，但不是一类平台 ——
  是另外两种接法：表单由设置页持有、设置存服务端 `.data/asr.json` / `.data/search.json`；
  容器 id 仍是 `#asrCard` / `#searchCard`。
  ⚠ 它们是账号卡流里的**两档能力**（`EXTRA_CAPS`：图片 / 视频 / 语音 / 文字之后），
  **不是另两张卡**：表单画在**这一档所在**那张卡里那一行下面（`placeForms` 把 Vue 节点搬进
  `[data-formslot]`）。「所在」由 `hostKidOf` 定：识别看 `asr.service.providerId`、搜索看
  `search.channelId`，渠道没选 / 指的那家没接进来时落到**第一个能当文字 AI 的账号**。
  **没有通栏兜底那一块**（`.acct-extra` 已删）：与图片 / 视频一样，能力在哪张卡上、设置就在哪张卡里 ——
  以前「没哪家顶着」时表单整块挂到网格下面，等于这一档又变回了一张独立的卡。
  表单自己也**没有标题与整段说明**（不再有 `.incard-h` / 那段「三条路…」），只有键值行。
  左侧目录轨只索引「卡」，这两档在轨上**不另占行**。
  ⚠ **这两档跟着「文字对话」一起来**（2026-10-27 收口）：凡能当文字 AI 的账号，卡上就有「识」「搜」两格 ——
  与图片 / 视频同一套显示规则（这家有这一档就画这一行）。判据是**这家有 `kind:'text'` 那一条**
  （两档走的都是它的 base + 密钥 + 一个 OpenAI 兼容端点 / 一个能联网的对话模型）。
  注册表的 `extraCaps`（`['asr','search']`，白名单与「只能挂在文字供应商上」在 `server/providers/validate.js`）
  现在只是**旁注**：声明过的说明上游确实提供那个端点，没声明的行里挂一枚「未声明」——
  以前它还是显示门槛，于是同一件「有文字档」的事实被拆成三种表现（有文字的家只画「字」，
  声明过的那几处才有「识 / 搜」），一张卡上看不出这家人到底能干什么。
  `serviceProvOpts(cap)` 因此列**所有文字账号**，声明过的排前面、没声明的名字后面注明一句。
- 显示名按「类型 + 编号」预填；同名会让型号下拉分组与收藏筛选项分不开。
- 自定义条目没有环境密钥回退，也不认 `x-up-base`（防止把 A 的密钥发到 B）。

### 5.3 转发闸

- 闸按「一家平台」算，键是 `keyId || id`；四档 `.env`：`RELAY_MAX_INFLIGHT`、
  `RELAY_QUEUE_MAX`、`RELAY_RETRY_MAX`、`RELAY_WAIT_MAX_MS`。
- 排满当场回本地 429 并写明“没有扣费”；退避重试只给 GET；名额必须恰好归还一次。
- 列表/详情短缓存命中与“挂同一条在途请求”都排在闸之前；被限流不进健康故障表。

## 6. 数据与用户文件

### 6.1 绝不提交、绝不擅自删

- `.env`、`.data/`、`.assets/`、`.renders/`、`.skills/`、`node_modules/` 都在 `.gitignore`。
  `.assets/` 与 `文件/` 这两条忽略的是**库根被指回项目内**的那种情况（`ASSETS_DIR` 或设置页那一格填回老名字时，
  里面装的是用户作品，一次 `git add -A` 就把几百 MB 媒体推进历史）—— 它们是数据，不是缓存。
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
- **装配没完成之前一个字节都不许落盘**：导演台 `boot()` 读回工作区与把它挂上界面之间有一个网络往返的
  窗口，那段时间里的模块级 `WS` 还是**空的默认值**。关标签的 flush 与任何顺手排上的 `scheduleSave`
  都可能落在窗口里，把「一个工程都没有」同时盖进 IndexedDB 与 `.data/workspace.json`。
  两份落盘都先问 `web/director/engine.js` 的 `wsLoaded`（装配完成点置真）；判据
  `tests/e2e/director-boot-flush.cjs` 用拖慢 `/data` 的办法把窗口拉宽，复现那一次 flush。

### 6.3 本机资产身份

- “同一份产物”只有 `local.js` 的 `mirrorOf` 一处：平台产物号优先，其次“任务号且只出一份”，
  再次来源地址（剥签名）与本机号。
- **一条产物只有那一个本体**：落在 `<库根>\<类型>\<规范名>.<ext>`（`规范名` = 资产库里看到的那个名字，
  撞名加 `-2` / `-3`）。账在 `.data\local-assets\`（快照 + journal），**与本体分家**：换库根不动账。
- **双身份**（`server/local-assets-store.js`）：`fid` = `<dev>:<ino>`（必须按 bigint 取，普通 statSync
  把 64 位 ino 塞进 double，超过 2^53 就丢精度）+ 采样签名 `sig` = `<字节数>:<头尾各 1MB 的 sha1 前 16 位>`
  （imohash 那一族做法）。采样只用来**认回**，不用来证明「这两份是同一份东西所以可以删掉其中一份」。
- **三级认回**：相对路径 → `fid`（同卷改名 / 挪目录）→ `sig`（跨盘、换机、被同步盘重写一遍）。
  认回来把新的 `file` / `fid` / `sig` 一起写回账（认一次落一次，下一次又是常态路）；三级全落空才说“文件不在了”，
  不假装还在，也不顺手删条目 —— 条目里还挂着回源外链与那笔费用。
- **磁盘对账**：列表 / 认回 / 用量共用一份 `dirScan` 快照（30 秒 TTL，只 readdir + stat 不读内容；
  真要比内容才按字节数分桶算签名）。盘上有、账里没有的成品由 `localAdopt` 补建，**只补一次**；
  同内容的那几份并成一条账（`altPaths`），不新开卡。
- **重复下载不许多张卡**：列表与用量按「同一上游产物号（剥签名）」或「同一内容签名」并成一张卡，
  压着的份数由 `duplicates` 报出来；这份判据只有 `localUpKey` + `sig` 一处，页面不另算一套。
- **删一张卡 = 收掉这一张卡背后的每一条账与每一份字节**（`localAssetSiblings` 与列表并卡同一把尺子）：
  只删眼前那一条，同组那一条下一轮又自成一张卡或留下一个「文件已不在」的空条 —— 用户看见“删了又回来”。
  文件删不掉就不许裁索引（回 500 照实说）。
- “本机 / 云端”唯一读法是 `AssetLocal.stateOf(entry)`；页面不许自己拼
  `localAsset || hasLocalAddr(src)`。
- 自动镜像由应用级事件触发：`wb:asset-done`；`AssetLocal.watch` 统一接住并 scan。
  字节由代理流式落盘：`Api.saveLocalFromUrl` → `POST /local-assets/from-url`，不要 base64 大文件。
- 镜像指针本体在 IndexedDB（`Kv.at('mirror')`），`sk_local_mirror` 只留暖启动缓存。
- 浏览器侧镜像索引指到死号时自愈（`web/domain/local.js` 的 `learn`，判据 `tests/local-first.cjs`）：
  账行带身份（upstream / detail）就按键改指；账被整份重建、补出来的是裸行（无身份字段）时，
  按「文件名 + 字节数」把死记录接回当前账 —— 两边**各自唯一**才接（接错比不接更糟），
  旧号的指针留着给 `onMediaError` 那一跳换活号。指针维护只动指针不下载字节，
  不受「自动存本机」开关管；开关只管要不要为新产物建镜像记录。
- 过期签名外链由公共层负责：`Api.mediaExpired` / `Api.healMedia` / `Api.mediaSrc`；
  页面不许自己判过期，也不许拿 assetId 拼 `/asset/<id>`。
- **「已丢失」角标只许盖住它自己那一张图**（`web/domain/local.js` 的 `lostTip`）：
  `.lost-tip` 是 `position:absolute; inset:0`，铺开的是**最近的定位祖先** ——
  灯箱的舞台、检查器那格大图、详情层候选排那一格都不是定位容器，
  不管就变成「点一下素材卡，整屏一块已丢失」（角标 1384×900，用户只看到一句没头没尾的话）。
  所以角标按图**自己的盒子**定位；媒体槽也该自己定位（`.timg, .thumb, .sthumb-wrap` 已经这么写，
  页面自己的槽照着补 `position: relative`）。判据 `tests/e2e/ui-contract.cjs`：
  角标不许比它那一格更大。
- 读写链路的判据：`tests/e2e/local-chain.cjs`（新默认根下的落点 / 双身份 / 改名挪目录认回 /
  重复下载并成一张卡 / 删一张卡带走 altPaths / 磁盘对账只补一次）。它不开 Chrome，只起隔离实例，
  并且每一条都点名 `.*-probe` 假根，跑完自己清干净。

### 6.4 云同步

- `POST /cloud/sync`（双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
- 冲突判定靠 `.data/.cloud-state.json` 基线；不要退回“只看时间取新”。
- 远端存在但读不下来 → 判 `error` 跳过，绝不 push；本地删除必须真正执行到底。
- 浏览器对账体积相同不能直接跳过（等长修改）；对账期间本地写入先进 held 暂存表。

### 6.5 Git 远端与推送

- 远端只有一个：`https://github.com/ycwba/shizhen-workbench.git`。**它在本地克隆里的别名不固定**
  （本机这份是 `origin`，另一份工作副本里叫 `github`）—— 所以**别按远端名写命令**：
  `main` 跟踪哪个远端就跑裸 `git push` / `git pull`，那才是稳的。
  （判据 `tests/doc-contract.cjs` 盯的是**地址**，不是别名。）
- 远端 `main` 是 2026-10-22 用 `--force-with-lease` 推上去的**真实历史**（截至 2026-10-24 为 49 提交）。
  此前远端只有一个与本地无共同祖先的孤儿快照提交 `3d3f5ad`，该快照保留在远端的
  `archive/snapshot-gh` 分支。
- 看到「有共同祖先为零的另一个根提交」不是历史断了，**不要**去 `--allow-unrelated-histories`
  合并它：那是同一份代码的旧快照，合并只会把旧状态搅回新历史。
- 其它分支（`feat/drama-cast-assets-and-voice` / `fix-audio-model-dropdown-loop` /
  `workbuddy/main-ac3e0e9b`）都已在远端同名分支，且都是 `main` 的祖先，只作历史备份用。
- `.git` 里有约 2100 个悬空对象（约 390MB）来自旧状态与探针；`git gc --prune=now` 能回收，
  但**另一个 agent 会话正挂在 `C:\Users\ycwb\WorkBuddy\Worktrees\aii\main-ac3e0e9b` 这个
  linked worktree 上**，在那个会话结束前不要 prune。

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
| 侧栏（导航项与它们的文案） | `web/core/routes.js` 的 `WB_ROUTES.pages`：每一页一行，`label` 是全名（满形态显示、悬停名牌念它、读屏 `aria-label` 用它），`short` 是**两字短标签**（窄形态压在图标下面）—— **侧栏不许另抄一份**（改了页面名忘了改短标签，侧栏上就出现两个名字） |
| 可拖动分栏 | `Wb.split.enable`（把手 DOM 与落盘都在这一份；工作台两栏与导演台三栏共用，键分别是 `wb_split` / `dir_split`；`axis:'y'` 是**上下**那条 —— 导演台底栏轨道坞走它，键 `dir_dock`，高度落在 `.page-main` 的 `--dock-h`；⚠ **变量名 = CSS 里的名字**：`varName:'dock-h'` 写出的是 `--dock-h`，写成 `dock_h` 就落到 `--dock_h` 上，CSS 读不到 —— 把手看着能拖、面板纹丝不动） |
| 批量下载 | `Wb.downloadList`（资产库 / 生成工作台共用一份：逐条下载 + 进度 + 成功失败计数） |
| 多选 | `Wb.multi`（资产库 / 生成工作台共用一份：勾选集合 + 全选/取消全选 + 批量条那三处读数；页面只给 `keyOf` / `visible` / `onChange` / `mode`） |
| 跳页 | `GoPage.go`（同文档走 `window.appShow`） |
| 媒体 | `web/domain/api.js` 的 `Api.mediaSrc` / `Api.mediaKey` / `Api.mediaExpired` / `Api.healMedia` |
| 接口 / 统一取数 | `web/domain/api.js` 的 `Api`（`request` / `create` / `createBody` / `pollTask` / `list` / 余额）+ 顶层 `netFetch` / `respBody` / `classifyStatus` |
| 资产 | `AssetLib` / `AssetLocal` / `AssetTransfer` / `AssetPicker`（`AssetLib` 列表与费用口径在 `assetlib.js`） |
| 素材身份（两个地址是不是同一份产物） | `web/domain/ident.cjs` 的 `upKeyOf` / `innerMedia`（UMD 双模式：浏览器挂 `window.MediaId`、Node `require` 同一份；**必须 .cjs** —— `web/package.json` 的 type:module 会把 .js 当 ESM，UMD 的 `module.exports` 分支不会走，Node 侧拿到空 namespace） |
| 拖素材的引用载荷 | `web/domain/asset-ref.cjs` 的 `set` / `read` / `isRef` / `label`（UMD + **必须 .cjs**，理由同上；浏览器挂 `window.AssetRef`，Node 默认导入）。四个拖动源与球 / 抽屉两个落点都只经这一份，字段白名单也只有这里 |
| 任务 | `Wb.poller` / `Wb.History` / `Wb.thumbs` / `Wb.detail` / `Wb.cards` / `Wb.pager` / `Wb.viewToggle` + `VIEW_MODES` |
| 灯箱 | `Wb.lightbox` |
| 下载 | `Wb.save` → `Net.save` |
| 视频取帧 / 媒体信息 | `web/media-backend.js` 的 `MediaBackend`（mediabunny 主档 + `<video>` 兜底；`info` / `frame` / `thumbs` / `probe`）。**`createElement('video')` 只许出现在这一份里**，`Wb.vframe` 只是转发壳 |
| 浏览器内导出 | `web/media-export.js` 的 `MediaExport`（帧计划 / 合成 / 混音 / mediabunny `Output`；成片、素材、参考视频补音轨 `ensureAudioTrack` 都走它）。服务端没有 ffmpeg |
| 导出目录 | `web/domain/export-dir.js` 的 `ExportDir`（File System Access 句柄管理） |
| 成片模型（时间真相） | `web/director/film.js`（顺序 clips / 定时配音与待生成 / 字幕成片秒 / 标记 / 转场 / 行打包 / 行列眼睛与锁 / 进片闸 / 台词行；折算口 `rateOf` / `srcHeadOf` / `srcUsedOf` / `srcLenOf`；判据 `tests/director-film.mjs`） |
| 时间线编辑纯件 | `web/director/tl-cut.js` / `tl-resize.js` / `tl-ripple.js` / `tl-reorder.js` / `tl-snap.js` / `tl-scale.js` / `tl-peaks.js` / `tl-markers.js` / `tl-autoscroll.js`（切刀融合 / 裁剪滑移滑动 / 波纹 / 重排跨行 / 吸附 / 比例尺刻度 / 波形 / 标记；判据 `tests/director-tl-edit.mjs`） |
| 胶片条与取帧 | `web/director/tl-filmstrip.js`（显示层帧计划）+ `web/director/slice.js`（数据层帧索引预算）+ `engine/frames.js`（解码 / 缓存 / 退避）；判据 `tests/director-strip.mjs`、`tests/director-slice.mjs` |
| 用户目录根 | `server/user-dirs.js`（`systemDownloadsDir` / `downloadsRoot` / `promptsRoot` / `AUTOSAVE_TOP_DIR`；系统下载文件夹按注册表 KNOWNFOLDERID 取，不猜 `HOME\Downloads`） |
| 本机资产库根（本体住在哪） | `server/local-root.js`（`ASSETS_DIR` > `.data/sk_local_dir.json` > `下载\拾帧`；设置页那一格写 `sk_local_dir`，由 `DataSync` 镜像成盘上那份 JSON —— ⚠ **那份的正文就是 localStorage 原值**：字符串类的键走 `window.LS.set`，落盘是**裸文本**（`D:\作品`，不是 JSON），只有对象类的键才是 `Store` 的信封 `{"data":…,"ts":…}`；读错形状不报错，表现是「改了位置、产物还往老地方写」，判据 `tests/local-root.cjs`） |
| 本体的落点与可移植身份 | `server/local-assets-store.js`（`bodyDirNameOf` / `newBodyPlace` / `fileFidOf` / `localSigOf` / `localAdopt`；层内那份目录对账快照 `dirScan` 只此一份，外面不许再 readdir 一遍） |
| 一张「卡」背后那几条账 | `server/local-assets-store.js` 的 `localAssetSiblings`（与列表并卡同一把尺子：`localUpKey` 或 `sig`） |
| 缩略图 / 切片缓存 | `/cache/{thumbs,slices}`（`server/routes/cache.js`；跨 origin 有效，浏览器 IndexedDB 不再是持久层） |
| 能力声明 | `web/domain/capabilities.js` 的 `Capabilities` |
| 语音识别走哪条路 / 进度与扣费文案 | `web/domain/asr.js` 的 `pickRoute` / `stageText` / `routeLabel`（设置页、导演台、助手回执都只翻译这三枚，不各写一套判据） |
| 浏览器内 ASR 的算法（WAV 拆 PCM / 词级成段 / 转写清洗与可疑判定） | `web/director/asr-text.js`（worker 与 Node 判据共用同一份；换分段规则只动这里） |
| ASR 模型代下载与模型状态 | `server/routes/models.js`（`/models/<id>/<file>` + `/models/status`；双镜像按序试、每一跳过出站护栏、`.part` 原子改名、同一文件单飞） |
| 文字 AI | `web/domain/text-ai.js` 的 `TextAI`（含 `polishImages` / `qaOf` 契约） |
| 提示词归档 | `web/domain/prompt-log.js` 的 `PromptLog` |
| 收藏 | `web/domain/fav.js` 的 `Fav` |
| 素材库 | `web/domain/chars.js` 的 `Chars`（`Lib` / `Pipe` / `SET`） |
| 语义检索 | `web/domain/semantic.js` 的 `SemanticSearch.rank` |
| 导演台台词面板 | `web/director/film.js` 的 `speakerOf` / `lineTimeOf` / `lineRowHTML`（剪辑右栏「台词」那一档与配音列表共用；镜头编辑右栏没有第二份） |
| 导演台导出格式 | `web/domain/export-formats.js`（页头按钮 / `export_start` 分派 / 助手枚举与文案都读这一张表） |
| 字幕 SRT | `web/director/srt.js`（`srtParse` / `srtSerialize` / `resegment`；时间一律成片秒，判据 `tests/fcpxml-client.mjs` 与 `tests/e2e/editing-assistant.cjs`） |
| 导演台剧本视图 | `web/director/script.js` 的 `scriptTextOf` / `parseScript` / `applyScript`（按分镜现算，写入只落 `sh.prompt`） |
| 导演台接续与批量调度 | `web/director/chain.js` 的 `shotPlacement` / `chainDeps` / `splitLongShots` / `pickChainModel` / `chainModelRepick`（动不动、换成谁；能力清单没落定时「找不到」不下架）/ `quoteKeyOf` / `sumQuotes` / `runWithDeps`（engine 只调用） |
| 场景镜头命名 | `web/director/naming.js` 的 `sceneShotBase` / `candidateBase` / `voiceBase` / `clipLabel` / `stripExt` / `withExt` / `uniqueName`（本机素材名与 FCPXML 包内名同源） |
| 导演台项目组 | `web/director/groups.js` 的 `list` / `groupOf` / `assetGroupName` / `ensure` / `rename` / `remove` / `assign` / `tree`（**组名即素材组名**；老工程零迁移） |
| 拆分镜的新素材 | `web/director/board-assets.js` 的 `plan` / `stage` / `repeatCounts` / `pendingIn` / `resolve` / `shotsPending` / `libSpec`（重复出现才建、占位符词法、建档落点） |
| 发送前的请求预览 | `web/domain/api.js` 的 `buildBody` / `preview`（**与 `create` 同源**，预览 = 纯算，不发网络请求） |
| 原始请求面板 | `window.RawRequest`（`web/ui/raw-request.js`；**按需补载**；一栏预览（还没发）一栏实发（最近一次）并排，标题一枚状态标；不含 headers / 密钥，只在页面会话内存；发出去那一刻把当时的预览一起存下，对不上就在标题上标出来） |
| Skill 正文里的变量占位符 | `web/domain/gen-forms.js` 的 `window.TplVars`（`fill` / `names`；**「项目引用规则」就是它**） |
| 导演台的变量填料 | `web/director/board-vars.js` 的 `castOf` / `assetsOf` / `vars`（角色表 / 选中素材 / 现有分镜 / 时长区间） |
| Skill | `web/ui/skills.js` 的 `WbSkills`（含 `refRule`：素材范围优先） |
| Skill 的使用场景（设置页一级菜单） | `web/domain/text-ai.js` 的 `SKILL_SCENE_GROUPS` / `SKILL_SCENES`（分组 + 场景；场景名与「用在哪」沿用 `PROMPTS`，变量说明在 `SKILL_VARS`，三处同源不许各抄一份） |
| 设置页的目录轨（组 / 栏 / 当前值） | `web/pages/settings.js` 的 `groupEls` / `cardsOf` / `navTitleOf` / `NAV_VALUE`（**全部从 DOM 现读**：组名读 `.set-group[data-group]`，栏目标题读 `.card[data-nav]`，当前值读 `UI_PREFS` / `PAGE_TARGETS` / `Net.NUMS` / `SET_ROWS` / 注册表 / 体检与用量 —— JS 里不许有第二份清单，也不许另存一份状态；轨上一行 = 一张卡，**卡里的档位不另占行**） |
| 设置页「供应商与密钥」的账号卡流 | `web/pages/settings.js` 的 `provGroups`（按 `keyId` 归并出账号 + `caps`）/ `capProv` / `capState` / `hostKidOf`（这一档的设置住在哪张卡）/ `accountCardHTML` / `capRowHTML` / `modelPanelHTML` / `placeForms`（把那三块 Vue 节点搬进这一档所在的卡）/ `manualCapsOf` / `setManualCaps`（`sk_caps_<keyId>`：手动加的一档）；型号面板的槽名 `slotKey` / `provBySlot` 也只在这一份里 |
| 中文名 / 类型 | `ui.js` 的 `provKindZh` / `provKinds`、`isAudioType` / `mediaKindOf` / `fileExtOf` |
| 字数闸 | `gen-forms.js` 的 `CharLimits`（`bounds` / `tts` / `prompt` / `why` / `cntLine`） |
| 配音合成设置 | `web/domain/gen-forms.js` 的 `TtsAdv` + `AdvExtras` |
| 音色说明 | `window.VoiceNote.run`（取音色描述）/ `window.VoiceNote.runClone`（拿另一位素材的声音克隆） |
| 音色写回素材库 | `web/domain/chars.js` 的 `Chars.Pipe.saveVoiceNote`（按名字找人；已有描述不覆盖） |
| 音色克隆（两种源） | `Chars.Pipe.cloneFromCands`（这一位自己合成过的候选）/ `Chars.Pipe.cloneFromLibEntry`（素材库里另一位挂着的参考音频）—— 同一落点（`refAudio` + `voiceMode='clone'`） |
| 格式化 | `Wb.fmtSec` / `fmtClock` / `fmtWhen` / `fmtWhenSec` / `fmtHM` / `fmtHMS`；`ui.js` 的 `dayKey` |
| 文件名 | `fileSafe` / `fileStamp`（浏览器与 Node 各一份，是登记在案的例外） |
| 设置项清单 | `web/ui/ui.js` 的 `window.UI_PREFS`（`rows` / `groups` 一份派生导出、同步、恢复默认与助手白名单，判据 `tests/settings-schema.cjs`） |
| 「现在能不能按生成」 | `web/domain/gen-rules.js` 的 `window.GenRules`（页面与助手都只翻译它给的原因码，不各写一套判据） |
| 客户端错误出口 | `web/core/report.js` 的 `window.PageReport`（页面主动报只有 `pageFail`；`fatal` / `warn` 两种 kind 由这一处的两个 window 监听器发出 → `POST /client-error` → 代理健康账） |
| 视口不许被重画甩回顶 | `web/ui/workbench.js` 的 `Wb.viewport.keep(host, fn)`（重画点自己调：按**锚点**（第一个可见子元素 + 它的稳定键或下标）在重画后把容器里那只滚动位还回去，锚点以上内容变高也不会漂；外壳不再猴补 `Element.prototype.innerHTML` —— 那种写法罩不住「重画后内容变短被夹回顶」，还在全局原型上动手脚。**「点一颗按钮，视角跳到最上面」就是这一族**；判据 `tests/e2e/viewport-keep.cjs`） |
| 程序性 focus 不抢视口 | `web/ui/ui.js` 的 `window.focusQuiet(el)`（`focus({ preventScroll: true })`）。拿 `focus()` 只是为了「把光标续上」时一律走它；真要「把某处滚过来」走滚动那一族（`scrollIntoView`），别拿 focus 当滚动用（§3.4.5） |
| 文件类型筛选（图片/视频/音频） | `web/ui/workbench.js` 的 `Wb.kindFilter`（`.ui-seg` 分段 + 每档计数 `.seg-n`；档位表 / 每档条数 / 点完之后做什么由页面给；**档位集合不变时不重建 DOM**，计数只改文本与 `.on` / `hidden`；计数为 0 且非当前档的那一颗不画）。工作台 / 收藏 / 资产库三处共用，判据 `tests/e2e/kind-filter.cjs` |
| 本机索引写入口 | `server/index-store.js` 的 `update(fn)` 串行队列 + `putInto` / `dropFrom`（跨 await 的读-改-写只能走这一处） |
| 一行素材的身份键 | `AssetLib.entryKey`（页面与缓存）；裸工作台任务记录用 `Wb.taskKey` |

## 8. Vue SPA 页面

- 运行时没有构建步骤；Vue 3.5.44 runtime-only，本地 vendored。
- **vendored 依赖（运行时零构建的唯一例外，`package.json` 不加运行时依赖）**：`vue.runtime.esm-browser.prod.js`、
  `web/vendor/mediabunny.min.mjs`（媒体解码/编码）、`web/vendor/mediabunny-aac-encoder.min.js`（Chrome 没有 AAC 编码器，
  注册软件编码器；IIFE 经典脚本，挂 `MediabunnyAacEncoder` 全局）、
  `web/vendor/asr/`（`@huggingface/transformers` + ONNX Runtime 的胶水与 `.wasm`，浏览器内 Whisper 用）。
  全部按需加载，首屏不带 —— 那枚 21MB 的 ORT `.wasm` 只有 worker 起起来才拉。
- `web/app.js` 是唯一外壳：hash 路由 + `<KeepAlive>` 页面池；切页只离屏、不销毁。
  页面 DOM、滚动位置、筛选与多选状态都留在原地。
- 路由表只有 `web/core/routes.js` 的 `WB_ROUTES`：页面文件 / id / 侧栏名 / 图标 / 标题 /
  组件地址 `src` / 旧地址别名都从这里读，外壳的页面组件映射由这张表现搭。新增页面只改这一处，
  不在 `web/app.js` 或页面里另抄一份映射（`tests/spa.cjs` 拦）。
- 页面组件：默认导出，根节点 `page-main <page>-page <外壳类>`（外壳类：普通页 `.page-shell`、
  两栏工作台 `.wb`；见 §3.4.3）；私有样式挂页面根类；公共样式走
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


## 9. 导演台

### 9.1 边界

- `web/director/index.js`：Vue 页面组件 + 作用域岛（模板 HTML、样式、生命周期、`WBBridge` 安装）。
- `web/director/template.html`：导演台真实 DOM 模板（不是 Vue 模板，不参与预编译）。
  它内嵌的 `<style>` 块是**全站唯一的例外**：`index.js` 运行时把这一块取出来，
  以 `@scope (.director-page)` 注入 —— 导演台是作用域岛，样式必须跟着模板一起被取用。
  那块里的取值同样走令牌（§3.4.1），不写死。
- `web/director/engine.js`：命令式热路径的状态与接线；**这一层里的代码按域机械搬进 `web/director/engine/*.js`**，
  每一枚 `createX(E, document, window)` 只收 engine 递进来的访问器与函数（`document` / `window` 用参数名遮蔽，
  作用域岛递进来的两份代理继续生效）。engine.js 继续持有工程数据与可变状态，模块里不留第二份
  （**E 装配漏名字是运行到才炸的错**：模块解构出 `undefined`，语法档与 vm 自检都看不见 ——
  新增域模块时，engine 里那份 E 名单要与模块顶部解构逐名对着改，`tests/director-e-deps.cjs` 当场数这两份名单）：
  - `gen.js`：分镜提交、平台任务轮询、自动镜像投递与「生成全部分镜」的依赖式批量调度
  - `frames.js`：取帧、帧缓存与退避重试（`sliceKey` 稳定键 / `SLICE_FAIL_TTL` / `sliceRetryIn` /
    `fillSlices` / `sliceForgetFail`）；数据层帧索引来自 `slice.js`，显示层格数来自 `tl-filmstrip.js`
  - `timeline.js`：时间轴板（`.tl-board`）的渲染与比例尺 —— `#tlTools` 工具条就地刷、`#tlRuler*` 刻度、
    `#tlPlayhead` 针层、`#tlScroll > #tlContent` 视口与内容层、`.tl-lane` / `.tl-track` / `.tl-strip` /
    `.tl-clip` / `.tl-junction` / `.tl-marker` / `.tl-voice` / `.tl-cap` 的排布、缩放（`#tlZoomVal`）与
    三秒重建时的滚动还原
  - `strip.js`：一条画面段的胶片格绘制（`.tl-strip` + `i.tl-fr` 定宽磁贴，图片段平铺、缺帧斜纹占位、
    同一排地址不重画）与 `.tl-cap` 的字幕块内容
  - `edit.js`：板上交互（点选 / 六档选择工具 / 拖把手 / 换序换行 / 吸附 / 波纹 / 标记面板 / 右键菜单 /
    工具条全量动作）与写 film 的唯一出口 `commit` / `patchFilm`（都经 `beginEdit` 压快照）
  - `play.js`：预览播放核（双甲板接力、转场窗口、字幕按起止进出、配音起播、主时钟对齐、片尾停住）
  - `caption.js`：字幕域（右栏清单、SRT 入出、浏览器内识别入口、重切、`capSetText` / `capSetTime` /
    `capSetStyle` / `capDelete` / `capAddEntries` 这几个写口）
  - `voice.js`：配音的数据侧（时长、音色方式、位置、登记）与右栏配音列（`#vcTabs` 六档 + 入出点两框）
  - `mid.js`：中间栏整列渲染（预览甲板 + 候选条 + 动作行 + 总长）与剪辑 / 生成两态的切换。
    候选条右侧的展开 / 翻条 / 「1 / 2」是**浮在缩略图右缘的一枚小控件**（绝对定位，不占排版宽度，
    缩略图给右端留出滚动走位）；剪辑态预览与生成态**同一副尺寸**（同一条 56vh / 16:9 的盒子）。
    中栏是 `#midCol > #midBody（整片重画）+ #shotStripHost（常驻的镜头顺序条）`：
    顺序条**只属于生成态**（剪辑态里由轨道板接手，和左右两栏一样两态各有一套栏），
    它的高度走 `--strip-h`（Wb.split 的 `dir_strip`）；剪辑态播放器与生成态同一条尺寸规则，
    不够高时中栏自己滚（轨道坞也能拖矮），播放控件跟着画面走。
  - `panel.js`：右栏镜头编辑器（型号清单、输入槽位与 role、组合与互斥、参数表单）
  - `apply.js`：AI 拆分镜与改稿的落盘（新素材建档 + `@待建:` 占位符 + 分镜写入）；
    拆分镜 / 改稿**前**的「AI 反问」与过程面板也在这里（`askRound` + `splitUI` 状态 +
    `renderSplitPanel` 重画钩子，宿主与润色面板同为 `#polishInline`）
  - `export.js`：**渲染计划唯一组表** `buildRenderPlan()`（段顺序与起点、进片闸后的配音与字幕、
    每句在哪一行、本机优先地址）、导出成片（**浏览器内合成**，`MediaExport`）、FCPXML / 媒体包与
    送到剪映 / 达芬奇（`Export.resolve` / `Export.jianying` / 助手分派走 `Export.nle({app, silent})`，
    silent 不弹结果弹窗）；服务端没有渲染任务账
  - `bridge.js`：`WBBridge.director` 的 `check` / `run`（助手写入桥，按身份对账，见 §9.3）
- 纯算法按域拆开，engine 只调用：
  - `film.js`：**成片模型**（`proj.film` 的唯一数据层）—— 顺序 clips / 定时配音与待生成 / 字幕成片秒 /
    标记 / 转场 / 行打包 / 行列眼睛与锁 / 进片闸（`audibleVoices` / `visibleCaptions`）/ 台词行；
    两把尺子的唯一折算口（`rateOf` / `srcHeadOf` / `srcUsedOf` / `srcLenOf`）；判据 `tests/director-film.mjs`
  - `slice.js`：**数据层帧索引预算**（`frameIndexPlan` / `frameIndexTimes`，按素材时长分档、封顶 480 帧）——
    只回答「解多密」，摆几格是 `tl-filmstrip.js` 的事；判据 `tests/director-slice.mjs`
  - `tl-filmstrip.js`：**显示层帧计划**（`frameCountFor` 格宽 84px 档 / `planFrameTimes` 采样在格子中心 /
    `missingFrameTimes` ±0.06s 合并 / `frameCoverage` 缺口）；判据 `tests/director-strip.mjs`
  - `tl-cut.js`：切刀与融合（`splitClipAt` / `splitVoiceAt` / `splitCaptionAt` / `canMergeClips` /
    `mergeClipsAt` / `removeClipAt` / `duplicateClipAt`；源窗口 / 胶片格 / 波形按比例分家，转场归右半）
  - `tl-resize.js`：裁剪（`trimClipLeft` / `trimClipRight` / `trimVoiceLeft` / `trimVoiceRight` /
    `trimCaptionLeft` / `trimCaptionRight`）与精细编辑（`slipClip` / `rollClipsBoundary` / `slideClip`，
    边界 `filmSlipBounds` / `filmBoundaryBounds` / `filmSlideBounds`）与字幕跟随 `followCaptions`
  - `tl-ripple.js`：波纹（边界之后开跑的定时块整体平移，锁住的按行跳过并计数，标记不动）
  - `tl-reorder.js`：拖动重排与跨行（`reorderClips` / `dropIndexAt` / `moveClipToLane` /
    `moveTimedToLane` 中间行 ±1 收缩 / `compactLanes` / `newLaneBelow` / `shiftGroupStart`）
  - `tl-snap.js`：吸附（点集 `collectTimelineSnapPoints`、就近 `findClosestTimelineSnap`、
    单值 / 范围 `snapTimelineValue` / `snapTimelineRange`、引导线 `createTimelineSnapGuide`；阈值是像素）
  - `tl-scale.js`：时间轴比例尺（`tlVisible` / `tlZoomForVisible` / `tlRulerScale` / `tlTicks` /
    `tlPxPerSec` / `tlAnchoredScroll` / `tlFollowScroll`；像素 ↔ 秒只有这一份）
  - `tl-peaks.js`：波形 peaks（每秒 48 根、RMS 与峰值取大后归一化、`slicePeaks` 按比例切、重采样）
  - `tl-markers.js`：标记四类五色（`createMarker` / `markerClock` / `markerSnapPoints` / `markerCounts`）
  - `tl-autoscroll.js`：拖到视口边缘的自动滚动（与 `tl-scale` 的像素换算同源）
  - `srt.js`：SRT 解析 / 序列化 / 按字数重切（`srtParse` / `srtSerialize` / `resegment`；时间一律成片秒）
  - `script.js`：剧本视图（分镜现算成稿；改稿只写回 `prompt`，台词不在那份稿子里）
  - `board.js` / `split-assets.js`：拆分镜
  - `board-assets.js`：拆分镜的「新素材」（AI 判哪些角色/场景/物品要建档出图、占位符词法、建档落点）
  - `board-vars.js`：Skill 正文里那些**变量占位符**该填什么（角色表 / 选中素材 / 现有分镜 / 时长区间）
  - `board-preview.js`：这一镜**将要发出**的请求体（纯算，素材槽位用占位符，不触发上传）
  - `groups.js`：项目组（分组 / 改名 / 删组 / 归组 / 树；**组名即素材组名**）
  - `chain.js`：接续拆分镜与依赖式批量生成（顺序 / 依赖原因码 / 长镜头拆分 / 型号选型 / 报价键与合计 / 调度器）
  - `naming.js`：场景镜头命名（本机素材名、候选 / 配音后缀、FCPXML 片段名与去重）
  - `media.js`：候选身份 → 预览 / 导出地址（本机号只走 `AssetLocal.localAssetIdOf`，画面段、配音、切片、FCPXML 都只问这一份）
  - `fcpxml.js`：导出（单文件 / 媒体包 / 送到剪映 / 达芬奇同一份拼装器；第三方 FCPXML 的**读回已撤**）
  - `asr-text.js`：浏览器内 ASR 的纯算法面（`wavToPcm` / `groupWords` / `normalizeAsrWhitespace` /
    `applyChineseReplacements` / `isSuspiciousChineseTranscript`）—— `asr-worker.js` 与 `tests/director-asr-text.mjs`
    读同一份（**要换分段规则只动这里**）
  - `asr-worker.js`：module worker，transformers.js（Whisper q8）只在 worker 里跑；模型走同源 `/models/`、
    `allowRemoteModels` 关死、ORT 的 wasm 路径覆写到同源 `web/vendor/asr/`（默认指 CDN，CSP 下必死）；
    取消 = 整只 `terminate()`，绝不回落主线程再转一遍
  - `util.js`：导演台内部的小纯函数（`round1` / `pct` / `spdTxt` / `escHTML` / `parseJsonLoose`）
- 改算法先改模块，engine 只留调用与状态；不要在 engine 里再抄一份。

### 9.2 时间线硬约束

- **数据真相只有 `proj.film`**（`web/director/film.js`）：主画面是一列**顺序存储**的 clip
  （没有 start，成片总长 = Σ `duration`）；配音 / 待生成是定时条目（成片秒 `start` / `duration`）；
  字幕存成片秒 `start` / `end`；标记钉在成片秒；`tracks` 存行列的眼睛与锁。
  旧那套 `c.segs` / `proj.timeline` / `proj.filmOrder` / `sh.lineSeg` 等键**一行都不读**。
- **两把尺子只有两个折算口**：成片秒与源秒。折算只走 `film.js` 的 `rateOf` / `srcHeadOf` /
  `srcUsedOf` / `srcLenOf`；裁剪、切开、滑移、播放取帧、FCPXML 都问同一个口，任何一处另算一遍就是第二本账。
- **写 film 只有一个出口**：`engine/edit.js` 的 `commit` / `patchFilm`（都经 `beginEdit` 压快照、
  `filmEdited()` 落盘）。右栏卡片、工具条、助手写入桥（§9.3）都走它，不许直接改 `WS` 里的 film。
- **历史是只追加的日志 + 当前状态指针**（`historyLog` / `historyCursor`）：`beginEdit(label)` **当场**追加一条
  （状态先记改动前那一版，500ms 落盘时换成改完之后那一版）；回退 = 指针往回挪一条 + 在末尾追一条
  「回退到 xxx」（不删任何记录），重做走同一条路；上限 30 条 / 24 MB，超了从最旧一头丢。
  `可撤销` / `可重做` 是视图：可撤销 = **起点那一版** + 指针之前那几条；可重做只数 `edit` 记录
  （回退 / 重做是流水记录，不是一版状态）—— 一次编辑之后撤销栈读数是 1，不许是 0。
- **转场挂在每一段的连接点上**：`clip.transition = { id, duration }` 表示「本段 → 下一段」；
  窗 = `[本段末 − dur, 本段末)`，`dur ≤ min(2 秒, 两段各一半)`。预览每帧与导出逐帧都读
  `transitionWindow` / `transitionAtTime`（同一道夹算）；FCPXML 不写转场，但要在文件头按处报数。
- **主画面只有一轨（成片那一轨）**：没有「本镜 / 全片」两档；针、读数、剪子、缩放只有一把尺子（成片秒）。
  生成态的候选条与顺序条照旧，换候选回生成态点。
- **工具条上的动作全走 `Edit.toolAction`**：六档选择工具（左选 / 右选 / 编辑点 / 滑移 / 滑动 / 选择）、
  切刀 / 剪头剪尾 / 删除 / 复制 / 融合 / 新增一段 / 摘掉一段 / 缩短 / 加长 / 缩放三颗 / 回到播放头 /
  撤销 / 重做 / 吸附开关 / 波纹开关 / 关联 / 标记面板。按钮只派发动作名，动作本体只有一份。
- **拖播放头**：针立刻跟手（`Timeline.setPlayhead` 纯视图），画面按 ~40ms 一档追、松手补一次精确 seek ——
  每次 pointermove 都 `video.currentTime = t` 会把在途 seek 取消掉，解码永远追不上指针。
- **轨道坞能拖到最底下**（`--dock-h` 下限 48）：允许把轨道整块盖住，只剩上沿那条抓手；
  `.tl-board[data-split-fixed]` 必须带 `min-height: 0`，否则内容会把板子撑在 234 拖不下去。
- **候选条展开只换行**：卡片尺寸与不展开时逐像素相同（展开是把同一排摊成几行，不是换一副大卡）。
- **触控板 / 滚轮**（`Timeline.onWheel`）：两指横滑（`deltaX`）与普通竖向滚动（`deltaY`）都当**横向滚动**
  （时间线本来就是横的）；按住 Ctrl/⌘ 的 wheel（触控板捏合会自己带 `ctrlKey`）才是缩放，
  锚在指针底下那一秒；竖着翻行走 Alt 或把指针放到左边标签列。
- **吸附**（`tl-snap.js`）：吸附点 = 时间线 0 与末尾、播放头、各轨块边缘、各标记边缘；
  阈值是**像素**（`TL_SNAP_PX`），换算成秒只在手势层一处；Alt 绕过在 `engine/edit.js`。
- **波纹**（`tl-ripple.js`）：边界之后**开跑**的定时块整体平移；整轨 / 行锁住的按行跳过并计数；
  挂在被移动配音块上的字幕跟着走，没挂链接的字幕按自己的 start 判；**标记不动**。
  画面轨自己不参与平移（顺序存储，删一段后面的自然前移）。
- **标记四类五色**（`tl-markers.js`）：钉在成片秒、不随剪辑搬移；面板与轨道读同一份数组。
- **轨道板的形状**：`#tlBoard > #tlBoardBody`（模板里的静态壳）→ 运行时 `Timeline.render()` 画
  `#tlTools`（工具条就地刷）、`#tlRulerInner` / `#tlRulerHead`（刻度尺）、`#tlPlayhead`（针层）、
  `#tlScroll > #tlContent`（视口与内容层），里面是 `.tl-lane` / `.tl-track` / `.tl-strip`（`i.tl-fr`
  胶片格）/ `.tl-clip` / `.tl-junction`（转场 ◇）/ `.tl-marker` / `.tl-voice` / `.tl-cap`。
  三秒重建由 `Timeline.render` 自己收滚动位；同一排地址不重画（`__stripSig`）。
  标记条收起时左列那一行**整条不画**（没有留下孤零零的「标记」两个字），展开走工具条那颗旗子；
  轨道坞的拖高把手是通长的一条（`Wb.split` 的上下把手不能沿用左右把手的 10px 宽）。
- **取帧分两层**：数据层「解多密」只有 `slice.js` 的 `frameIndexPlan` / `frameIndexTimes`
  （按素材时长分档、封顶 480 帧）；显示层「摆几格」只有 `tl-filmstrip.js` 的 `frameCountFor` /
  `planFrameTimes`（格宽 84px、采样在格子中心、±0.06s 合并）。取帧本身在 `engine/frames.js`
  （`sliceKey` 稳定键；失败退避 8 秒起逐次翻倍、最久 5 分钟；用户主动 seek 放行一次）。
- **播放不渲染**：剪辑态实时播（`engine/play.js`：双甲板接力、转场窗口、字幕叠层按起止进出、
  配音按主时钟对齐、片尾停住），导出才逐帧合成（`MediaExport`）。
- **导出组表只有一份**：`engine/export.js` 的 `buildRenderPlan()` —— 段顺序与起点、进片的配音与字幕
  （`audibleVoices` / `visibleCaptions` 两道闸）、每句在哪一行、本机优先地址都在它那一侧算完；
  FCPXML（`fcpxml.js`）只翻译同一张表，不再自己累加起点或 pack 一遍行。
- **本机优先**：预览遵守 `sk_media_prefer`，**导出始终本机优先**；有本机副本不碰上游。
- **片段之间可以留空**（`clip.gap`）：空记在**后面那一段**身上（这一段前面留几秒），
  `deriveTimeline` 把空算进 start 与总长；空里 `rowAtTime` 给 `null` —— 预览放**黑**、
  导出画黑帧 + 静音、FCPXML 写 `<gap>`。切一刀的右半与复制出来的副本 `gap = 0`（紧接左半 / 原段）。
  拖动画面段往右丢会把这截空写进历史（「前面留出 X 秒空」）；往左丢贴住上一段末尾，空自动收掉。
- **拖动画面段的预览**：被拖的那一组钉在指针那一秒、带一条跟手的胶片浮层（`.tl-drag-ghost`），
  其余的段按换序后的座位让开（`.tl-board.is-dragging` 下有 120ms 过渡）——「挤开」看得见；
  跨行拖动时目标行当场高亮，行号的更改在松手那一下落盘。
- **三个可拖分栏，一套公共件**（`Wb.split`）：`dir_split`（三栏占比）/ `dir_dock`（轨道坞高度，
  `--dock-h`）/ `dir_strip`（生成态顺序条高度，`--strip-h`）。⚠ `handles[].resize` 是**列下标**，
  `0` 是合法值（轨道坞与顺序条都拖第 0 栏）。
- **黑场只有「删掉」一种**（`off`）：这一格占时不变、后面的段不前移，画面变黑的同时音频跳过那几秒；
  「空段」不再新建（老工程里存下的空段照样渲染，左右拖走即摘掉）。静音 ≠ 删画面
  （段级静音只把音量切 0，画面照样进成片）。

### 9.2.1 语义补充

- **黑场 / 静音**：`off`（删掉）占时不变、画面黑、音频跳过；段级静音只把音量切 0，画面照样进成片。
- **单轨联动的旧判据（`links.js`）已随旧模型整族删除**：现在的「跟着走」只有波纹（§9.2 那一条）
  与字幕跟随（`tl-resize.js` 的 `followCaptions`）。

### 9.3 助手写入桥

- 唯一写入桥是 `WBBridge.director`（`web/director/engine/bridge.js`）：`check(op,arg)` 纯读校验并记下
  「这一次要动谁」的身份（`targetOf`），`run(op,arg)` 按同一份参数再解析一遍 plan —— 两边对不上
  （换工程 / 块被删或换了）当场拒，让模型重新读 context。**没有修订号 CAS**：凭据是块 id，不是「第几块」。
- 只有导演台在前台可用；op 只有 `select` / `cut` / `set` / `undo` 四个。`cut` 与工具条同一批函数
  （`Edit.selectItem` + `Edit.toolAction`，或 `cutTrim` 走 `tl-resize` 的两把剪子）；`set` 走
  `Edit.patchFilm`；`undo` 只挪历史指针。选中不依赖 DOM（生成态里板是隐着的也能剪）。
- 写入前由 `Edit.openUndoWindow` 压一份快照（一个动作一条历史），收尾统一重画。
- 批量 `timeline_apply` 每条 op 各占一个撤销条目（失败逐条退回），桥的 op 不新增第五个。
- 助手动作 `select_take` / `cut_timeline` / `set_clip` / `undo_edit` 只做转发；
  绝不让模型用 `click` 去点轨道按钮。

## 10. AI 助手与 Skill

- 助手 UI 在 `web/features/chat.js`（外壳：悬浮球 / 抽屉 / 会话 / 渲染 / 发送循环）；
  工具循环与动作目录在 `web/features/chat-tools.js`（`TOOLS` / `ACTS` / `TOOL_INPUT` /
  `ACTION_META`），由 `window.AiChatTools.build(C)` 取共享函数，加载顺序 chat-tools → chat。
  会话记录、Skill 自动加载、上下文预算、密钥脱敏都在 chat.js。
- 抽屉缺省是**球旁的浮窗**：贴着悬浮球摆（左上方，放不下就翻到另一侧，最后夹进视口并让开侧栏），
  宽 `--ac-w` / 高 `--ac-h` 由左沿与下沿两根把手拖，记本机 `ai_chat_w` / `ai_chat_h`；
  **浮窗只能随球拖动** —— 拖标题栏挪的是**球**（球与浮窗是一组），浮窗永远贴着球，
  没有「拖走就不再跟」这回事（旧的 `ai_chat_fxy` 标记已作废）。
  另一档是固定右栏（`html.ac-dock`，`#app` 用内联宽度让出 `--sbw + 面板宽`，页面可继续操作，
  球让位）。偏好只存本机 `ai_chat_dock`，打开状态本身不持久；
  窗口窄于 `DOCK_MIN` 自动回浮层，放宽后按偏好恢复。
- **拖素材到球 = 引用**（面板收起也能拖）：载荷由 `AssetRef`（`web/domain/asset-ref.cjs`）写，
  落进 `refs` 队列（落盘 `ai_chat_refs`，上限 20，超出挤掉最早的并点名）并在输入框追加一行
  `[引用素材：…]`；这一轮正文里有 `【这次引用的素材】` 清单，序号与队列同下标。字节**不预取**，
  模型要看时用只读工具 `asset_open` 按序号 / 号 / 地址取（`la_` → `/asset/…`、外链过期先续签、
  只有 `fileKey` 走 `Fav.blobOf`）；取不到就照实说。输入框里的标记有灰底高亮，悬停弹这一条、
  点击开 `UiDialog` 看图、× 只移引用不删资产库；**真相是队列**，标记被改掉只影响高亮。
  拖外部文件到球仍是上传；窗口空白处不接引用（球是唯一落点）。
- 只读工具 `task_detail` 查单条任务：先按本机缓存反查平台 / 产物号 / 提示词，再向平台问一次现状；
  多条一次问（最多 8 条，同轮共用一次列表请求），查不到按原因码说清。
- 写动作只经 `web/core/actions.js` 的 `ActionRegistry`；任意脚本 `inject` 整族禁止。
- 动作默认直接执行、不强制过程可见：结果回执 + 撤销必须可见；跨页给“去看看”，定位按需。
- 内容写动作必须有 `undo` 或显式 `irreversible`；花钱动作声明 `cancel`。
- Skill：`skills/<id>/SKILL.md`；按页面 + 触发词自动加载（最多 2 个），未命中的由 `skill`
  工具按需加载。内置 Skill 正文由 `TextAI.DEF` 同源生成；正文只有「启用的 Skill → 内置默认」两级，
  设置页不改正文（`sk_polish_ask` 那一档管的是「动手前要不要先反问」）。
- **项目引用规则 = Skill 正文里的**变量占位符**（`{cast}` `{what}` `{board}` `{assets}` `{dur}` `{style}` …）：
  程序在发请求前按**当前项目**把实际内容填进去（`window.TplVars.fill`，唯一一份填法）。
  填不上的**原样留着**（AI 看到 `{cast}` 三个字也知道那是要它自己补的位子；留空会让它以为「这一段没有内容」）。
  填料在 `web/director/board-vars.js`（角色表 / 选中素材 / 现有分镜 / 时长区间），三处共用一张表。
  ⚠ 这与提示词正文里的 `@素材` 引用**是两件事**：
    · `@名字` —— 给**生成模型**的引用（挂参考图，提交前换成 `@参考图N`）；
    · `{变量}` —— 给**写稿的 AI** 的项目资料（这一份角色名单长什么样）。
- **「素材范围优先」**（frontmatter 的 `assetGroups`）：一份 Skill 声明「这个项目优先用哪几个素材组」，
  拆分镜那一路的「素材范围」下拉把它们**排在前面**（不排除其它组）。读法只有 `WbSkills.refRule` 一处。
  ⚠ 它**不是**「项目引用规则」—— 那个指的是上面的**变量占位符**（在正文里，不在 frontmatter 里）。
- **contract 白名单**在 `server/skills-store.js` 的 `CONTRACTS`：加一种新任务就在那里加一条，
  同时 `TextAI.SKILL_CONTRACT` 加一条（页面侧同一张表的另一半）。
  `board_assets.json` = 拆分镜「判断哪些新角色/场景/物品要建档并出图」那一条。
- **设置页的布局骨架**（2026-10 重划，2026-10-25 再改一次）：
  · 卡片**皮肤用公共那一件** `.card-surface`（底色 / 描边 / 圆角 / 悬停）—— 页面只留排版
    （内边距与间距）；以前这一页自己写了一份卡片皮肤（radius-8 + shadow-1、无悬停），全站两套卡片。
  · 卡标题行 = 图标位 + 标题，**不再恒留 92px 空位**
    （那一段空位没有一张卡真的用得上，齐的是空地不是内容）。
  · 卡内的分组小标题是 `.sect-t`（**必须有样式**：以前只有 class 没有样式，渲染出来跟正文一样）。
  · **两栏两滚**（2026-10-25）：左边 `.set-rail` 是目录轨（5 组 15 行，每行带**当前值**），
    右边 `.set-doc-scroll` 是 15 张卡排成的一条**连续文档**（组标题钉顶、状态行钉底）；
    **页面自己不滚**。滚法与「滚动只有一个出口」见 §3.4.3。
  · **两栏的宽度只从一枚令牌来**（`--setrail-w` = 272px）：网格列与轨本身都读它，
    轨不许比它那一列宽 —— 宽出去就压在右栏那条文档上（轨的值速记被切、卡的左缘被盖）。
    设置页的目录轨**不共用**素材库那枚 `--rail-w`（208px）：它每行还带一个「当前值」速记，
    比那根宽。两页各用各的宽度令牌，别让一根轨两个宽度（判据 `tests/e2e/settings-nav.cjs` 量这条）。
  · 卡内那些行**标签列定宽 164px**（`.krow > .kn`）—— 控件都从同一条竖线开始；
    这一页的行**不再两列并排**（`.kcols` 改回一块）：左轨占掉 272px 之后右栏只剩 900px 上下，
    两列各 400px 放不下「标签 + 下拉 + 输入框 + 单位」那一行。
- **设置页的 Skill 卡：一级菜单 = 使用场景**（`TextAI.SKILL_SCENE_GROUPS` / `SKILL_SCENES`）。
  点一个场景 → 右边给两件事：① 这一步会拿到什么（变量表，**场景级**，按 contract 取 `SKILL_VARS`
  —— 换一份写法，喂料方式不变）② 这个场景的 Skill（这一 contract 下的每一份、谁在生效、有没有冲突）。
  全量清单退到「全部 Skill」一个**二级**入口 —— 原来它与一级菜单并排，是那处重复的来源。
  槽位灯说的是「这个 contract 槽现在被谁占着」：紫=我的、灰=内置、虚线=空档（用内置默认正文）、
  红=两份都启用（`skills-store` 的口径：同一 contract 里**都启用**时，被标 `conflict` 的那份不算数 ——
  运行时与界面都取**没被标冲突**的那份，所以用户那份优先于内置那份；**已停用的那份不算冲突**）。
- **同一个 contract 同一时刻只留一份启用的（2026-10-26 改）**：启一份就把同 contract 的**别的直接停掉**
  —— 不报错、不让人先关掉再开（`server/skills-store.js` 的 `displaceSameContract`，启停与安装两条路共用）。
  内置那份同样让位（用户的顶上去，内置的自动停，这条一直如此）；**用户那份之间也改成让位**，
  以前是抛「同一个 contract 只能启用一个 Skill」。
  ⚠ 让位的那几份 id 由服务端回传（`displaced`），前端**要点名说清「哪一份停了」**，不许让人自己猜；
  界面上停用那一行当场变成「已停用」（清单回填，不靠手动刷新）。
- **新建 / 编辑一份 Skill 在浏览器里做**（设置页场景详情里的「添加新 Skill」/「编辑正文」）：
  frontmatter 由表单生成、正文自己敲，落盘走 `POST /skills/install`（新建）或 `/skills/:id/update`（改）。
  ⚠ **内置 Skill 只读**：改不了内置那一份，要改就自己新建一份占同一个 contract
  （服务端会把同 contract 的原来那份自动停用）。「复制为我的 Skill」与「导出」两条**已整族删除**
  （前端函数、`web/ui/skills.js` 的 `exportOne`、服务端 `/skills/:id/export` 路由都没了）。
- 查询结果按 `estimateTokens` 预算；发出前 `redactSecrets` 抹密钥形状。
- 设置项只有白名单（`ADJUST` + `PAGE_TARGETS` + `sk_model_<kid>` + `Chars.SET`）；
  助手的供应方/型号只在设置页选（`sk_text_prov` + `sk_model_<kid>`），抽屉里没有第二份选择。
- 流式进行中不许清空气泡；切页/刷新前已写出的字要落盘并写明断了。

## 11. 素材库 / 资产库 / 工作台

- 素材库身份锚点只有 `newChar/newScene/newProp` 的 `anchor` 与 `Chars.refPicOf`；
  页面不许自己 `c.face || c.img` 拼。
- 素材库体检数字现算，不落库；多选批量全部调单条入口；使用关系读同一份 `loadRefUse()`。
- **素材页的「默认」归设置页，页面只留「这一次用哪个」**（2026-10-25 用户要求）：
  · **页面上不许有任何「本页默认」面板**（左轨那一块与详情层那颗「用本页默认」链接都已删）；
  · 默认值在设置页「素材库」那张卡里：`Chars.SET` 的 `imgModel`（默认生图型号）/
    `ttsModel`（默认语音型号）/ `candN`（默认一次出几张候选）/ `voiceN`（默认一次出几条语音）——
    图说「张」、语音说「条」，**两项分开设**（混成一项就没法只调一边）；型号下拉只有那一份实现
    （`Chars.Pipe.modelSelectHTML`，按平台分组，带一档「自动」= 平台清单里第一个）；
  · **每一处生成位仍能当场换型号与张数**，换的那一次只管那一处；
  · **不往本机存「上次用的型号与张数」**（旧的 `char_opts` 键已停用，开页时清掉）——
    记了就会不自觉地按上次那个跑；
  · 页面上的两处现场选择：目录轨「出齐用」一行、多选批量条上的「出图 / 声音」两行；
  · ⚠ **型号清单是后到的**（`Capabilities` 从平台能力接口逐家取，落到 `prov.models` 里，
    每家落定广播一次 `wb:cap-ready`）。画型号下拉的页面必须**自己拉一次能力**并**按家补画**
    （见 `web/pages/chars.js` 的 `loadCaps` / `onCapReady`，与导演台右栏 `installCapRepaint` 同一套）——
    不接这一下，型号下拉会永远停在「没配生图平台」那句**假话**上（平台明明配好了）。
- 工作台三类型共用一页：`?t=video|image|audio`；型号与提示词分类型记住；
  右栏历史三类型合并、按 `assetId` 去重。
- 输入模式（一次请求能用哪几类素材）只有 `Capabilities.combos` 一份；判据双向
  （缺料 / 超料 / 不收 / 互斥），`mode` 不是提交字段。
- 四颗“存回本机”只走 `AssetLocal.pullMany`；页面里一次都不许出现 `AssetLocal.pull`。
- **「存回本机」的范围按页分两种**（2026-10-25 用户定的）：
  · **生成工作台 / 资产库**：这颗按钮住在**多选条**里（不是筛选行那一排），**多选之后才出现**，
    存的是**勾选的那几条** —— 不多选就点它等于「把这一屏都存一遍」，那不是用户的意思。
    范围 = `Wb.multi.selected()` 过 `AssetLocal.pullPlan`（本机已有 / 没地址 / 本地上传的都剔掉）。
  · **收藏 / 素材库**：仍是那一档（当前筛选 / 当前档）的整批，因为那两页没有多选条。
  判据在 `AssetLocal.pullPlan` 一份；按钮上的数与 title 走 `AssetLocal.pullBar` / `pullBtnTitle`。
- “不显示云端任务”是 `AssetLocal.hideAsCloud` 一张闸，不是一套筛选。
- 卡片徽标只有 `web/ui/badge-state.js` 一份（`badgeOf` / `badgeHTML`），五页同读 `AssetLocal.stateOf`。
- 选择器来源档位只有 `AssetPicker` 的 `inView` 一处；音频条目按 `noMedia` 走自己的调度，
  不许把 `<img>` 塞一段音频。
- 下载文件名、类型判断、数字格式化一律走 §7 的公共实现，不许页面各拼一份。

### 11.1 左栏（`web/ui/sidebar.js`：余额区与本机产物）

- 侧栏是**外壳顶层文档里的经典脚本**（`shell.html` 在 `ui.js` 之后、`app.js` 之前加载），不是 Vue 页面；
  取数仍走公共层（`Api` 余额 / `AssetLocal.info()`），探针不许另写一份余额卡。
- **两个形态，只有两个**（2026-10-25）：满 232px（`--sbw-full`）与窄 56px（`--sbw`），
  `sidebar.js` 每次切形态把 `--sbw` 写成当前那一态的宽度；窄窗（≤1100px）里展开是**浮层**，
  那时 `--sbw` 仍是 56（内容不让位）。消费方（`#app` / 悬浮球 / 灯箱）都读这两个变量，
  **不许再写死 200 / 66 这样的像素**（`shell.html` 里那条写死 200px 的规则已经删了）。
- **收 / 展的开关是左上角那块品牌砖**（`.sb-logo`，`role=button`），侧栏里**没有第二样收展标识**：
  不画箭头、不画拉片。品牌块是品牌，不是控件 —— 所以它做成「点它收展」的那一块，而不是
  另加一颗控件；两个形态里它是**同一块砖**（30px、离左边 13px、同一行高），手指不用记位置。
- **窄形态认得出**：导航项的图标下面常驻一枚**两字短标签**（`.sh`），文案取
  `web/core/routes.js` 每一页的 `short` 字段（导演 / 素材 / 生成 / 收藏 / 资产 / 用量）——
  **与 `label` 放在同一张表里，侧栏不许另抄一份**（改了页面名忘了改短标签，侧栏上就出现两个名字）。
  悬停弹出的名牌只负责**补全全名**，不是认路的唯一手段；窄形态下 `aria-label` 仍写全名。
  当前项在窄形态变成**实心方块**（`.ic` 染 `--pri`），满形态是淡紫底 + 内边缘那道 3px 紫条。
- 高度分配只有一套：`.sidebar` 是 fixed flex column，`nav` 拿 `flex:1 1 auto; min-height:0` 与它自己的
  `overflow-y:auto`，`.sb-bottom` / `#sbBalance` 钉死 `flex:0 0 auto`，品牌砖 `.sb-brand` 也钉死
  `flex:0 0 auto`（它同时是整栏收 / 展的开关，被挤扁就是全栏最显眼的一处错位）。余额卡能摆几张由
  `sidebar.js` 的 `BAL_CAPS` 按实测窗口高度现算 —— **导航优先于卡片**；矮窗（`max-height: 660px`）
  与窄形态整区退成压缩版，卡片块根本不画。
- **看全部供应商 = 就地展开**，不是跳页：`[data-bal="expand"]` 给 `.sidebar` 挂 `bal-exp`，
  把「唯一可缩可滚」那份额度只落在 `.sb-bal-cards` 上；此时 `nav` 改成 `flex:1 0 auto`
  —— **可以长高、绝不压缩**：长出来的那截就是导航与余额卡之间的空档，由它把底部两块
  （设置 / 换背景）顶回底边。写成 `flex:0 0 auto`（连长高也归零）时空档没人接，底部两块
  会**离底边浮起来**（展开一次、整栏错位一次，空档大到一定程度还会被挤出屏幕）。
  偏好写本机 `sb_bal_exp`，跨刷新保留。这一位在「卡片块不画的两档」必须 revert 成原样
  （`sidebar.css` 里那两段 `html:not(.sb-open) .sidebar.bal-exp nav` /
  `@media (max-height: 660px)`），否则等于拆掉 A2 的兜底。
- 余额区**不放跳转钮**：「还有 N 家，去用量页」与「去设置」两枚已撤（左下角本来就有「设置」入口，
  同一件事不给第二条捷径）。区里只许 `expand` / `collapse` / `refresh` 三枚 `.ghost mini`；
  点开压缩块走公共弹窗（`UiDialog`）看全量卡，侧栏里不堆第二摞**可见**卡。
- **满形态那张「此刻」卡**（`.sb-bal-body`）：抬头「账户余额 · N 家」+ 余额行 + 按钮行 + 本机产物行，
  顺序是「余额在上、落盘在下」；**窄形态的压缩版也是这个顺序**（家数 → 每家一个状态点 → 落盘进度条），
  两个形态读起来是同一件事。本机产物行在卡**底**（`.sb-bal-body` 的最后一块），不跟卡列表一起滚。
- **余额行是两行**（名字 + 金额 / 冻结 + 单位）：以前是「名字 / 可用 / 冻结」三行、每行带描边的小卡，
  高度是现在的两倍 —— 同样一栏高度里能多摆一家。取不到的那一家**不藏**：原因直接摆到第二行
  （红色、单行省略，全文在 `title` 里）。金额那一位**不许截**（数字截了就是假账）。
- **窄形态那排状态点**：每家一个 —— 实心紫 = 这一家取到了，空心红圈 = 这一家取不到。
  56px 里放不下三个平台名，但放得下三个「各家怎么样了」；点上有 `title` 念出是哪一家、为什么。
- 展开钮的文案是「展开」（展开后是「收起」），总家数在 `title` 里 —— **N = 总家数**，差一家就是假话；
  「展开」与「刷新余额」永远同一行（`.sb-bal-acts` 不换行、按钮 `white-space:nowrap`）。
  窗口高到卡全摆得下时这一行只有「刷新余额」（`extra === 0` 的条件不许动：没有多余卡还给一颗「展开」，
  点下去什么都不会多出来）。
- 这一区两枚开关（`[data-bal="expand"]` 与「产物存本机」明细行）的箭头用**同一套**：
  **展开 = 朝上，收起 = 朝下** —— 同一个词永远配同一个箭头，一处朝上一处朝下就得靠猜。
- 本机产物那一行就地展开明细（「本次会话存成 N 份 · 上次存成 <fmtWhen>」），只用 `AssetLocal.info()`
  的现有读数与 §7 的公共时间格式化，不为这一行写第二份；落盘重画（`wb:mirror-ready`）与整块重画
  （`sb-balance-refresh`）之后都要重新绑上点击 —— 那两条路都是 `innerHTML` 重来。
- 判据 `tests/e2e/sidebar-balance.cjs` 十档：满形态（232px + 卡面抬头 + 本机行在卡底）/
  窄形态（56px + 短标签常驻 + 状态点 + 进度条）/ 悬停名牌补全全名 / 矮窗压缩版 /
  500px 高导航完整 / 就地展开（只有卡片块在滚、「收起」钮永不被挤出容器）/ 展开偏好跨重载 /
  明细行 / 详情弹窗 / 480–1100 高度扫描 / 来回切形态。

## 12. 服务端与路由

- `server/app.js` 是组合根；每个路由只在自己的 `server/routes/*.js` 里实现，
  app 只负责构造依赖与分发（处理器返回 `false`/`undefined` 的约定别混）。
- 路由层的 JSON 回包口径只有 `server/routes/http.js` 的 `sendJson` / `fail` / `noStore`
  （默认 no-store，4xx/5xx 不许被缓存）；各路由不再自写 Content-Type 与缓存头。
- 设置页「语音识别 / 联网搜索」两条通道共用的取数小件在 `server/channel-cred.js`
  （providerOf / mirrored / channelKey / loopback 只这一份 —— 以前 routes/asr.js 与 routes/search.js
  各抄一份，两份回环判定漂开时 `http://127.evil.tld` 会被当成本机放行）。
- 静态资源：只放行根级单文件与 `web/` 子树；HTML 带 CSP、nosniff、Referrer-Policy。
  文本响应按 `Accept-Encoding` 选 brotli、退 gzip、再退原文（压不动或压完不更短就发原文，不报错），
  三档共用同一套缓存与 ETag —— 验证器末位带表示名（`-br` / `-gz` / `-id`），缺了它 304 会把
  上一轮别的编码那份字节接着用；`Vary: Accept-Encoding` 因此恒写。
- `/data` 写入是原子写 + `.bak`；`/data` 清单不包含 `.bak`。
- `/prompts`：写文件 + 索引；`/prompts/find` 按 id 返回全部归档，客户端每个任务只问一次。
- `/fcpxml/bundle`：只写 `RENDER_DIR/fcpxml-<stamp>/`，素材只按资产号 / 已过护栏的 URL 取，
  取不到写 `missing.txt`。
- **代理不转码、不合成**：取帧 / 抽音轨 / 混音 / 编码全在浏览器（`MediaBackend` / `MediaExport`），
  代理只做取数与落盘，没有渲染队列、没有编码器档位可配。成片能不能导由 `Api.exportCaps()`
  现探（WebCodecs + H.264 编码器），设置页与助手「成片环境」读的是同一份探测结果。
- **浏览器内识别的模型只由代理「代下载」**（`server/routes/models.js`）：`/models/<id>/<file>` 把
  ModelScope / HuggingFace 的字节流进 `.data/models/`，这是**唯一一份模型缓存**（worker 里
  `useBrowserCache=false`、`allowRemoteModels=false`、只认 `/models/` 这一个本地路径）。
  LOCAL_ONLY、id 只认登记表里那一个型号、每一跳都过 `guardOutboundUrl`（重定向最多 4 跳）、
  `.part` 下完才原子改名、同一文件单飞、客户端断开就掐上游并删 `.part`；`/models/status` 报「齐不齐 / 多少字节」。
- **`route:'browser'` 不许发到代理**：浏览器内那一路在页面 worker 里跑，`/asr/transcribe` 收到 browser
  当场 400。放行不会报错，但任务照建、`work()` 的「local 才本地」三元判据会**默默扣一次在线转写的钱**，
  而账上写着 browser —— 路线的真相只有 `Asr.pickRoute` 一份（§7），代理这一层只负责把不该来的挡掉。
- 代理健康账：未捕获异常 / 未接住的 Promise / 500 / 连接错误四类；只报不自杀，连接错误不算故障。
- **stdout 断了不许自旋**（`server/app.js` 的 `writeLog`）：启动器窗口一关，stdout 管道就断；
  往断掉的管道写会抛异步 EPIPE，那条 EPIPE 又被「未捕获异常」那个出口接住 → 它记一笔 → 再写一次
  → 再抛一次：**无限自旋**（实测一个实例 1.6 小时烧掉 800 多秒 CPU，端口在听却不回话，
  `proxy.log` 刷到 1.8 MB 全是同一句）。所以 stdout 断了就把这条路封掉（`outWrite` + 流的 `error` 事件），
  **日志文件照旧落盘**（那是排障的正经依据）。判据 `tests/e2e/proxy-stdout.cjs`。

## 13. 测试与验证

### 13.1 分档口径（什么时候跑哪一档）

| 档 | 命令 | 场景 | 耗时（本机实测） |
| --- | --- | --- | --- |
| 秒级 | `npm run check` | 每次保存后 | ~0.5s |
| 样式秒级 | `node tools/tokenize-css.cjs` + `node tools/check-vars.cjs` | 动了样式 / 令牌后 | <1s |
| 迭代 | `npm run test:fast` | 日常改码后 | 改动小时 3-8s；映射条数多则按比例上涨 |
| 合并 | `npm run test` | 批末回归 / **提交与推送前** | ~3s |
| 全量 | `npm run test:all` | 想连浏览器冒烟一起跑时（按需，不挡提交） | 常驻 ~3s + e2e 冒烟 6 条（4 路并发）~70s，合计 ~75s |
| 剪辑核 | `npm run test:director` | 改剪辑核时 | 纯件 4 条 + `director-core` 一次装配的冒烟（约 35s） |
| 浏览器 | `npm run test:e2e` | 按需手动跑（**不是提交与推送的前置条件**） | 49 项：读数型 4 条先独跑 + 其余 45 条 4 路并发（另含 perf/boot 与 static-encoding --live），实测约 10 分钟 |
| 观察 | `npm run test:watch` | 连续改码时 | 常驻前台；800ms 防抖 + 在途合并，触发 `map.cjs --changed --run` |
| 写入型 | `node tests/data-snapshot.cjs` | 动了写盘路径时手工 | ~0.4s |

**提交与推送前只跑 `npm run check` + `npm run test`**（秒级 + 常驻判据全量，几秒）。
**e2e 不再是前置条件**（2026-10-28 定）：浏览器档要起隔离 proxy 与独立 Chrome、单次十来分钟，
把它挡在提交前面，只会让人干脆把整档跳过去 —— 那比少跑一次更亏。
想跑就按需手动跑 `npm run test:e2e`（或 `npm run test:all` 连冒烟一起），
红了自己负责；改动面大时用 `npm run test:fast`（按 `tests/map.cjs` 的映射挑相关判据）就够。

`node tests/all.cjs` 的常驻判据走并发池（并发 min(8, CPU 核数)，输出按完成顺序整块打印、带每条耗时；
超时 SIGKILL 不死锁）；会写共享 `.data` / `.renders` / `.skills` 或**库根本体**的判据一律进串行白名单（§13.2）。
判据子进程优先用系统 node（`NODE` 环境变量可指定，拿不到回落 `process.execPath`）。

**清单只有一份：`tests/all.cjs` 里的 `run()` 登记行**（`tests/map.cjs` 的 registry 按源码文本现读这些行，
两边不一致当场红）。这里不再抄一遍全表，只说各档是哪一路：

- 静态纪律一路：`syntax` / `selfcheck` / `spa`（独立判据，不再由 selfcheck 代跑）/ `static-guards` /
  `scope-guards` / `dup-guard` / `architecture` / `metrics` / `ui-catalog` / `settings-schema` /
  `doc-contract`（AGENTS.md §3.4 那份设计规范与代码一致 —— 文档不许说谎）。
- 服务端与数据一路：`routes-smoke`（ctx 注入 + 每条端点走一遍假 req/res）/ `index-store` / `local-first` /
  `relay-retry` / `outbound-keepalive` / `proxy-tunnel`（CONNECT 隧道：CONNECT + TLS + 复用 + 拒绝，离线）/
  `assetlib-cache` / `pull-scope` / `providers-validate` / `asr-settings` /
  `zip` / `skill-hub` / `fcpxml-client` / `static-encoding`（不起实例的那一半）。
- 本机资产一路：服务端档的 `local-root`（库根那一条算法 —— 盘上那一格必须真被读出来，
  以及 `ASSETS_DIR` 压过它、默认跟系统下载文件夹走）；浏览器档的 `local-chain`（落点、双身份 fid + 采样签名、
  改名挪目录认回、重复下载并成一张卡、**删一张卡带走整组**、磁盘对账只补一次；只起隔离实例，不开 Chrome）。
- 纯算法一路：`core` / `editing` / `editor-media` / `local-edit` / `gen-rules` / `task-detail` / `asset-ref` /
  `export-formats` / `raw-preview` / `skill-refvars` / `director-*`（含 `director-asr-text`：
  浏览器内识别的分段算法 + 「worker 只认同源 `/models/`、vendored 四件在位」那两条静态判据）。
- 列表页的翻页一行：`pager-row`（资产库 / 收藏 / 角色库 / 生成工作台四页都得把翻页行**画出来**：
  宿主登记了、行看得见、上一/下一页两颗在 —— 上一轮「翻页组件不显示」就是工作台那一处
  宿主 `stPgRow` 从未登记，整行从未填过；翻页之后的行为由 `favorites-pager` 盯）。
- 页面的页头：`page-head`（各页都得是**公共那一条** `.phead`：标题在 `.phead-h1` 里且文本对得上、
  **不带图标铭牌**、标题左缘与内容列左缘对齐（±1px）、四个槽（身份 / 上下文 / 说明 / 动作）都在 ——
  防止下一轮又长出第八种页头。导演台是作用域岛（满屏三栏、页头在 `template.html` 里），不在这条站内页头的名单里）。
- 工作台左右两栏可拖：`wb-split`（把手在**本页**的 `.layout` 里 —— 文档级选择器会命中页面池里
  别的页；拖得动且跟手；**拖动全程页面两端的空白不变**；值落盘 `wb_split.sp0`；双击复位；
  站内切页再切回不丢）。
- 文件类型筛选：`kind-filter`（收藏 / 工作台 / 资产库三页共用 `Wb.kindFilter`：分段控件 + 每档计数、
  点一下换档、计数为 0 且非当前档的那一颗不画）。
- 视口不许被重画甩回顶：`viewport-keep`（裸重画确实丢位是对照；`Wb.viewport.keep` 按锚点还原；
  `Wb.cards.paint` 整箱重画也不吃位。⚠ 不碰导演台：它的重画点在 `Timeline.render` / `renderEditor` 自己的 `Wb.viewport.keep` 里）。
- 「存回本机」存的是**多选勾选的那几条**：`pull-selected`（工作台 / 资产库两页：那颗按钮住在
  多选条里、多选之后才出现、点下去只排勾选的那些；工作台的翻页行住在右栏顶上 ——
  搜索那一排下面；顺带盯「多选时勾选框看得见」，勾选框隐形的话「存选中的」就是盲存）。
- 浏览器档分两级（**按需手动跑**，不是提交前置）：`--e2e:fast` 只跑冒烟 6 条（smoke / ui-contract / ui-shared / director-perf / director-core / lock，
  4 路并发，每条自起隔离 proxy + 独立 Chrome）；`--e2e` 全量分两道 —— **读数型先独跑**
  （`ui-visual` / `director-perf` / `director-playback` / `perf/boot` 四条：并发负载会让截图指纹、帧预算
  与播放对齐这类读数失真 —— 实时播放量到的配音偏移是归位途中的瞬时值），其余（含 7 条不起 Chrome
  的服务端链路）走 4 路并发，`tests/e2e/` 48 个文件（47 条判据 + harness），
  同一档还跑 `tests/perf/boot.cjs` 与 `tests/static-encoding.cjs --live`
  （后者是同一份判据的「线上那一半」，要起隔离实例）。16 核 / 17 GB 本机实测全量约 10 分钟（串行版是 20 分钟级）；
  单条红先独立重跑再定性 —— 满载池子里的机器负载假红有先例（开机静默探针独跑 3/3 绿、满载必红那种）。
`tests/map.cjs --run` 每条报耗时，超预算（默认 20s，`MAP_BUDGET_MS` 可改）先给最慢清单再谈切 --e2e。
- **剪辑核的日常验证不要跑全量 e2e**：`npm run test:director` 是纯件 4 条 + `director-core` 的**一次装配**冒烟
  （板 / 切一刀 / 撤销 / 转场 ◇ / 标记 / 字幕块 / 缩放 / 工具条就地刷 / 历史，约 35 秒）；
  `director-edit` / `director-history` / `director-playback` 这些重交互档按需手动跑。

视觉基线更新（只在有意改版后）：

```bash
UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs                    # 全部画面
UI_VISUAL_WRITE=1 UI_VISUAL_PAGES=studio node tests/e2e/ui-visual.cjs   # 只补点名的那一页
UI_VISUAL_SAVE=1 node tests/e2e/ui-visual.cjs                     # 只留底不改基线：逐张写进 actual/（排障用）
```

### 13.2 写入型验证只跑隔离实例

```bash
PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe RENDER_DIR=.renders-probe \
  SKILLS_DIR=.skills-probe node proxy.js
```

- 不给 `ASSETS_DIR` / `RENDER_DIR` 就会写进用户真实库根（默认在 `下载\拾帧`，**仓库外**）与成片目录。
- **另一枚探针口**：`AUTOSAVE_DIR` 把整个「下载」基座指走（`server/user-dirs.js` 读它，
  库根与提示词归档的默认目录都跟着它）；打这两条链路的判据必须一起给，否则探针真的往用户成品目录里写。
- 自己 spawn 的探针要认领“答话的就是我刚起的那一份”：`/sys-status` 的三个目录都要点名，
  并判子进程没有提前退出。
- 测试结束清理 `.data-probe*` 等目录与孤儿进程；不要留在仓库里。

### 13.3 数据基线

- `node tests/data-snapshot.cjs` 比对三块与 `tests/data-baseline.json`：真实 `.data`、真实 `.renders`、
  以及**库根本体**（落点由 `server/local-root.js` 现算，不在项目里就照现在这一份盯）。
- 基线文件里只记**标签**（`.data` / `.renders` / `库根`）与计数、聚合哈希，不记用户绝对路径 —— 这份要提交。
- 写入型测试前后都要核对；真实实例上只做只读加载。
- 迁移类改动做完后要手工 `node tests/data-snapshot.cjs --write` 重打一次基线，别用 `--write` 把日常写入掩盖过去。

### 13.4 浏览器

- 只跑 headless；测试脚本自己起隔离代理与 Chrome。
- 页面 e2e 必须检查控制台错误（CSP 违规、未捕获异常、404）。
- `tests/e2e/harness.cjs` 是唯一的启动/取 Cookie/打开页面入口，别每个脚本各写一套。
- 起代理的就绪探测每一跳都带 3 秒上限、总窗口 20 秒；**起不来时先把子进程杀掉、四个探针目录清掉再抛**
  —— 代理的 stdout/stderr 管道就是判据进程的事件循环句柄，不杀的话「未就绪」已经打印出来了，
  进程还要挂到外层 600 秒超时才被 SIGKILL，端口与目录白占十分钟（`stop()` 与失败路径共用同一份收尾）。

## 14. 编码与新增功能清单

### 14.1 编码

- `.js/.mjs/.cjs/.html/.css/.md`：UTF-8；`.bat`：UTF-8 + `chcp 65001`；
  `.ps1`：UTF-8 **带 BOM** + CRLF。
- 页面样式只用 `tokens.css` 的令牌；不要在页面里写第二份主题变量或裸色值。
- 不要写裸控制字符；不可见分隔符写 `\u0001`。
- 源码里不出现真实密钥；日志不打印密钥 / Cookie / 用户路径之外的本机隐私。
- **注释自含（硬约束）**：注释不许引用报告、方案 / 执行文档、任务号或缺陷号
  （「批次 N」「R18」「A1③」「W2」「L1-L4」这类编号）—— 那些文档与任务清单删掉之后
  它们就是死指针。注释只能指向仓库里现读得到的东西：现行章节写显式（`AGENTS §7`）、
  判据写文件（`tests/e2e/sidebar-balance.cjs`）、判据文件**自己定义并使用**的组名照常
  （static-guards 的 G1–G8、architecture 的 A1–A5、ui-catalog 的 U1–U7）；两边都对不上的，
  把事实直接写全。「批次」作普通名词（生成批次、批次对象）不算引用。

### 14.2 新增页面的落点

1. `web/pages/<id>.js`（Vue 组件，默认导出，`render` 来自预编译）。
2. `tools/vue-templates/<id>.html`（模板源）+ 跑 `npm run build`。
3. `web/core/routes.js` 的 `WB_ROUTES` 加一条（含组件地址 `src` 与页面根类 `root`，`src` 相对
   `web/app.js` 写，如 `./pages/<id>.js`）；外壳的组件映射由它现搭，`web/app.js` 不用再改。
   新页面还要在 `web/core/page-context.js` 的 GET 里点名（助手快照），视觉档位与
   「哪些页必须有快照 / root」都由这张表现取，漏了直接红。
4. 私有样式 `web/styles/spa-<id>.css`（根类下），公共样式复用 `tokens.css` / `ui.css`。
   页面根元素是 `class="page-main <id>-page <外壳类>"`：普通页挂 `.page-shell`，
   工作台那样的两栏页挂 `.wb`（外壳与形状见 §3.4.3）；页面补丁里**不许**顶层定义公共类（判据 G20）。
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
  助手 `export_start` 的 enum 都从它派生。加一种导出 = 表里一行（`kind` 是 `film` / `xml` 之一）
  + engine 里一个 builder；判据 `tests/export-formats.cjs`。
- 页头只有「导出成片 / 导出媒体包」两颗平铺按钮；「导出 FCPXML」是**拆分按钮**（主钮 + 尾部 chevron
  浮层，达芬奇 / 剪映收在浮层里）。旧「导入 FCPXML / 最近导出 / 导出素材」三颗与
  `web/director/fcpxml-import.js`（第三方 FCPXML 读回）、`Export.sessionExports` 会话账本已整族删除。
- 直接送到剪映 / 达芬奇是表里的 `nle` 行（`kind:'xml'` + `nle:true`），走 `fcpxml.js` 的 `sendToNle`
  → `POST /fcpxml/import` + `/fcpxml/launch`；不是第二种导出格式，也不在页面里另写一套。
  页面按钮走 `Export.resolve()` / `Export.jianying()`，助手分派走 `Export.nle({app, silent})`（同一份 `exportNle`）。
- 纯拼装在 `web/director/*`（如 `fcpxml.js`）或 `web/domain/*`，不在页面里拼字符串。
- 缺失素材/段落一律报数（清单/状态行），不许静默丢。

### 14.6 明确禁止

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
  两个例外都只作用于**用户机器上已经存在的那些数据**，不作用于代码：
  ① 用户数据的落盘搬迁（本体从一个目录搬进另一个目录那种一次性工具，搬完即删，见 §6.3）；
  ② 清掉用户机上残留的旧存储键（`web/ui/ui.js` 的 `LEGACY_KEYS` + `sweepLegacyKeys()`）——
  读旧键**只为了删掉它**（连 `.data` 里那枚镜像一起 `DELETE /data/<键>?nobak=1`，不留 .bak），
  绝不照它渲染任何东西；这一族留着是因为「不清掉的话下次 boot 会从服务器镜像恢复回来」。
  文档与注释的同一件事：文件里不许写「以前是那样、现在不是了」的说明（本文件开头那条），
  注释不许指向已删的文档或任务号（§14.1）；但**为什么这一枚键/这一条落点已作废**要写全 ——
  那是防止有人把它接回去的唯一线索，属于「这一条为什么存在」，不是兼容层。
- 不新增第二套动作目录、页面路由表、供应商类型表、格式化函数或网络层。

### 14.7 新功能文件落点（按类型）

新增功能先按这张表决定文件，不要临时找地方塞；跨类型的改动按“最靠近数据的一层”落：

| 功能类型 | 落点 | 必须一起改 |
| --- | --- | --- |
| 新页面 | `web/pages/<id>.js` + `tools/vue-templates/<id>.html` + `web/styles/spa-<id>.css` | `web/core/routes.js` 加一条（含组件地址 `src`）、运行 `npm run build` |
| 共享 Vue 组件 | `web/ui/<name>.js`，并从 `web/ui/index.js` 导出 | 样式只进 `ui.css`/`tokens.css`；页面不许深路径 import |
| 新的公共样式 / 组件样式 | `web/styles/<组件>.css`，并在 `shell.html` 挂上 | 取值走令牌（§3.4.1）；公共类进 §3.4.4 那张表；页面补丁里不许顶层定义公共类（G20） |
| 共享纯逻辑 | `web/domain/<domain>.js`（挂一个 `window.<Domain>` 面） | 只暴露最小方法；页面不复制规则 |
| 外壳/路由/生命周期 | `web/core/*.js`、`web/app.js` | 不留页面专用全局；需要跨页桥走 `WBBridge` |
| 新服务端路由 | `server/routes/<name>.js` | 在 `server/app.js` 构造依赖与分发；敏感路由加 `LOCAL_ONLY`；补 e2e |
| 新数据/存储 | `server/<name>-store.js` | 原子写 + `.bak`；改结构先做迁移；补数据基线 |
| 新供应商 | `server/registry-config.js` 的 `REGISTRY.providers` | `REGISTRY.version` +1（结构变了才加）、`providers/validate.js`、`tests/providers-validate.cjs` |
| 新导演台纯算法 | `web/director/<domain>.js` | engine 只调用；补 `tests/director-<domain>.mjs`；涉及播放/导出再加 e2e |
| 新导演台 DOM 交互 | `web/director/engine.js` 或已有域模块 | 不许在页面层另写编辑算法；必须走 `beginEdit` / `filmEdited` |
| 新助手动作 | `web/features/chat-tools.js` 的 `ACTS` + `ACTION_META` | 策略一行：`effect` / `route` 必填、`undo` 有意不给=真退不掉；花钱动作 cancel；补 e2e（见 §14.4） |
| 新 Skill | `skills/<id>/SKILL.md` | frontmatter（id/name/triggers/pages/contract）；内置正文与 `TextAI.DEF` 同源 |
| 新导出/导入格式 | `web/director/*` 或 `web/domain/*` 的纯拼装模块 | 缺失素材报数；导出组表只有 `buildRenderPlan()` 一份（判据 `tests/fcpxml-client.mjs`） |
| 新测试 | 单元 `tests/<name>.mjs|cjs`；浏览器 `tests/e2e/<name>.cjs` | 加到 `tests/all.cjs`；断言失败要能指出落点 |
| 新视觉基线 | `tests/fixtures/visual/` | 只允许 `UI_VISUAL_WRITE=1` 更新；实际截图走 gitignore |

本轮新增能力的落位：原始请求面板 `web/ui/raw-request.js`（经典脚本；**按需补载** —— 导演台 /
生成工作台两页各自 `__spaLoadScript`，其余页不白下这一份；脚本数 / 字节预算在
`tests/spa.cjs`）；接续与批量调度 `web/director/chain.js`；场景镜头命名 `web/director/naming.js`；
发送前预览 `web/domain/api.js` 的 `buildBody` / `preview` + `web/director/board-preview.js`；
导演台项目组 `web/director/groups.js`；拆分镜的新素材 `web/director/board-assets.js`
（+ 内置 Skill `skills/board-assets/SKILL.md`，contract `board_assets.json`）；
**「项目引用规则」**（Skill 正文里的变量占位符 `{cast}` `{what}` `{board}` …）=
`web/domain/gen-forms.js` 的 `window.TplVars`（唯一一份填法）+ `web/director/board-vars.js`（填什么）；
NLE 一键导入在 `server/routes/fcpxml.js` 的 `/fcpxml/import|reveal|launch`，持久目录
`RENDER_DIR/fcpxml-import/`（`pruneRenders` 跳过这一层）；剪辑核的模型 `web/director/film.js`、
交互 `engine/edit.js`、板与刻度 `engine/timeline.js` / `engine/strip.js`、播放 `engine/play.js` 与
纯件 `web/director/tl-*.js` / `srt.js`；左栏「历史编辑记录」在 `engine/mid.js` + `template.html`
（`#editLeft`）；页头导出拆分按钮在 `engine.js` 的页头装配段（`#exportFcpMore` / `#exportFcpMenu`）；
拖素材的引用载荷 `web/domain/asset-ref.cjs`
（**必须是 .cjs**：`web/package.json` 的 type:module 会把 .js 当 ESM，UMD 的 `module.exports` 分支不会走，
经典脚本与 Node 判据两头都读同一份）。

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
6. 改完跑 `npm run build:check`、`npm run test`；e2e 按需手动跑、不挡提交；有意改版才更新视觉基线。

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
npm run check               # 秒级档：模板一致 + 全部 JS 语法（<1s）
npm run test:fast           # 迭代档：check + 按改动映射跑判据（map.cjs，报每条耗时）
npm run test                # 合并档：常驻判据全量（并发池，~3s）—— 提交与推送前跑这一档
npm run test:all            # 全量档（按需）：常驻池 + e2e 冒烟 6 条（4 路并发，共 ~75s）
npm run test:director       # 剪辑核日常档：纯件 4 条 + 一次装配的核冒烟（约 35s）
npm run test:e2e            # 浏览器档（按需，非前置）：49 项 —— 读数型 4 条独跑 + 其余 4 路并发（含视觉回归与性能）
npm run test:watch          # 观察档：fs.watch web/ server/ → map.cjs --changed --run
node tools/tokenize-css.cjs            # 样式秒级档：裸值体检（只读；--write 机械替换 / --map 映射 / --collapse 收敛影响面）
node tools/check-vars.cjs              # 令牌引用完整性（引了没定义的令牌 → 声明作废且浏览器不报错）
node tests/static-guards.cjs           # 静态纪律 21 条判据（G18 裸值 / G19 主题色成对 / G20 公共类 / G21 透明度阶梯 / G22 断点）
node tests/e2e/ui-visual.cjs           # 视觉回归 44 个画面；重打基线加 UI_VISUAL_WRITE=1
node tests/data-snapshot.cjs  # 写入型：对真实 .data / .renders 与库根本体比基线（§13.3）
powershell -NoProfile -ExecutionPolicy Bypass -File launcher.ps1 -SelfTest
set WB_LAUNCHER_DRYRUN=1 && 启动.bat
```

## 17. 已决定的架构取舍

以下是**当前有效的决定**，不是待办；改之前先确认能否同时守住行为与热路径预算：

- **导演台编辑器内部保持命令式**：候选条、轨道、切片、播放与拖动不走 Vue 组件化。
  `DirectorView` 是 Vue 页面壳；内部按域拆成纯模块（film / tl-cut / tl-resize / tl-ripple /
  tl-reorder / tl-snap / tl-scale / tl-peaks / tl-markers / tl-filmstrip / slice / srt / script /
  board / split-assets / media / fcpxml）。
  原因：这些 DOM 节点被缓存、拖拽、切片帧、插针与撤销逻辑大量引用；改成 Vue 组件会改变
  节点身份与更新时机，直接破坏“切页不丢状态 / 不重解码 / 拖动中途不重建”这些既有判据。
  剪辑交互与预览引擎同样明确不重写。因此 `engine.js` 仍是全站最大的文件（工程数据 + 可变状态 + 接线），
  “单文件 < 3k”不适用于它；但它的热路径已按域机械搬进 `web/director/engine/<域>.js`（§9.1 那张清单），
  新增能力继续往纯模块与这些域文件里放，不再往 engine.js 加界面代码。
- **DOM 代理保留**：`web/director/index.js` 的 document / window 代理是作用域岛边界，
  保证导演台的弹层、拖拽示意与键盘监听不挂到别的常驻页面；去掉它是行为回退。
- **镜像队列仍在 AssetLocal 的现有队列**：不再引入第二套 `MirrorQueue`；同一份去重 / 退避 /
  持久化逻辑只保留一处。队列索引在 IndexedDB（`Kv.at('mirror')`），`sk_local_pending`
  只是跨刷新待办的暖缓存。
- **会话历史仍存 localStorage**：`ai_chat` 要跟 `DataSync` / 云同步一起走；迁 IndexedDB
  会让对话记录从整包备份与云端消失，收益不抵损失。
- **撤销仍是项目快照栈**：导演台 `undoStack` 存 JSON 快照，足够覆盖当前编辑粒度；
  改成命令日志是独立的协作/历史功能，不与本轮 UI 收口混做。
- **令牌名 = 值，不回退到「序号 = 档位」**：序号写法要人记「--sp-3 是几像素」，
  而且同一档里两套命名并存时必然漂开（`--fs-1` 与 `--fs-12` 是两个完全不同的字号）。
  改名的成本在令牌化那一轮一次付清（718 处），之后新增一律按值命名。
- **主题色与固定色分家**：`tokens.css` ① 段跟主题走、③ 段（固定中性色）不跟；③b 段
  （导演台标记色 `--mark-cut` / `--mark-ready` / `--mark-mute` / `--mark-loud`）**跟** ——
  那四枚是轨道里的功能标记（切点 / 就绪 / 静音 / 音量高），深浅两档各一套。
  共享界面一律取语义色 —— 挑固定色的后果是「深色主题里错误色还是浅色的红」。
  加主题色必须连深色档一起加（判据 G19）。
- **页面外壳只有两种**（`.page-shell` / `.wb`），工作台那套两栏骨架的**唯一一份**在
  `web/styles/wb.css`：以前 ui.css 那份是给老工作台页的死代码、SPA 那份是逐条照抄，
  两份迟早对不上。页面差异留在 `spa-<id>.css` 且必须挂在页面根类下（判据 G20）。
- **样式表的落点**：真实文件、按组件分、由 `shell.html` 统一挂载，
  **不许把一段 CSS 塞进 JS 模板字符串**（助手面板那 250 行曾经就藏在 `chat.js` 里，
  于是改样式要翻 JS、颜色兜底值散在字符串中、别的页面也没法复用）。
- **样式层不写死，靠四把尺子守**（体检 / 引用完整性 / 五条静态判据 / 视觉回归）。
  间距与断点**暂不收敛**：补档是收容位，收敛会改画面 —— 那是布局重构那一轮的设计决定；
  候选映射与影响面已经备好（`tools/tokenize-css.cjs --collapse`），到时只改 `tokens.css` 一处。

