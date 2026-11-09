# 成像 · AI 创作工作台

本地优先的 AI 创作工作台：八个页面（路由表 `web/core/routes.js` 共 8 条：导演台 / 建模台 / 素材库 /
工作台 / 收藏 / 资产库 / 用量 / 设置）由 Vue 3 SPA 统一承载，生成任务与数据全部经本机 Node
代理转发与落盘。产品版本见 `package.json` 与 `CHANGELOG.md`。

- 运行时零构建：浏览器直接加载静态文件。
- 严格 CSP：运行时没有模板编译器，模板在开发期预编译成 render 函数。
- 密钥、任务、素材、成片默认只留在本机；云同步与手动下载都是可选项。
- 页面切换不刷新：KeepAlive 页面池保留筛选、滚动、多选与剪辑状态。

## 快速开始

```bash
# 1. 安装并启动（Windows）
双击 启动.bat

# 2. 或者直接跑代理
node proxy.js
```

首次开发需要安装模板编译器（运行时不需要）：

```bash
npm install
```

打开启动器后点「启动」，浏览器会打开 `http://localhost:5175/shell.html`。
端口会按 `.env` 的 `PORT`、系统环境变量、5175 的顺序自动挑一个真能 bind 的号；
启动器的「服务日志」里会写实际端口与来源。

双击 `启动.bat` 会先做一次环境自检（约 0.3 秒）再打开图形启动器；窗口里可以
启动 / 停止 / 重启服务、打开页面、复制访问地址、打开日志与项目目录。

`启动.bat` 也可以带命令使用：

| 命令 | 作用 |
| --- | --- |
| `启动.bat menu` | 功能菜单：自检、日志、目录、页面、启动器自检、清缓存、重装依赖 |
| `启动.bat check` | 环境详细自检（依赖、配置、语法、日志） |
| `启动.bat log` | 看 `proxy.log` 末尾 25 行 |
| `启动.bat dir` / `page` | 打开项目目录 / 打开工作台页面 |
| `启动.bat selftest` / `clean` / `help` | 启动器自检 / 清解析缓存 / 帮助 |

开关：`WB_LAUNCHER_DRYRUN=1` 只检查不启动，`WB_NOCOLOR=1` 关掉彩色输出。

## 页面

| 页面 | 作用 |
| --- | --- |
| 导演台 | 分镜、候选生成、时间线剪辑、配音、成片导出、FCPXML（单文件 / 媒体包 / 工程目录）、项目文件导出 / 导入（完整工程） |
| 建模台 | 一句话让文字 AI 写出参数化白模（小人 / 图元 / 群众 / 导入的 3D 文件），流式实时预览；导入件自带动画时可选 clip 并调速度 / 循环 / 偏移；白模库是多库模板仓库（`白膜\<库>\模型\<组>\`），场景是唯一工作区（`白膜\<库>\场景\<场景组>\`），库模型放进场景即成可编辑实体；多机位，节点与机位共用一套轨道；出白膜图 / 动画 mp4 进资产库，可回传工作台与导演台当参考 |
| 工作台 | 视频 / 图像 / 语音三合一，按 `?t=video|image|audio` 切栏 |
| 素材库 | 角色 / 场景 / 道具，体检、批量、身份锚点、使用关系、语义检索 |
| 资产库 | 本机 / 云端产物、筛选、分页、批量下载与存回本机 |
| 收藏 | 跨平台收藏、备注、复用 |
| 设置 | 供应商与密钥（一家账号一张卡，六档能力平级：图片 / 视频 / 语音 / 文字 / 语音识别 / 联网搜索）、逐型号的输入能力、存放目录、数据与同步、Skill 管理 |
| 用量 | 任务与花费统计、余额 |

## 生成与导出要点

- **原始请求**：生成按钮旁的「原始请求」折叠条展示实际发给供应商的请求体（同源代理路径 + 脱敏 body，
  不含 headers / 密钥；只存在页面会话内，完整提示词仍由 `PromptLog` 归档）。
- **接续拆分镜**：AI 拆分后，只有**没有任何型号能覆盖整段时长**时才拆成接续片段；第二段起自动切到
  支持首帧的型号，并取上一镜尾帧当首帧（用户显式放了首帧时以显式为准）。
- **生成全部分镜**：按依赖提交 —— 接续镜等上一镜出画面后才开始；生成前用同一份计划报价，
  缺金额 / 只报最低消费 / 多币种都照实标注，不合计、绝不当 0。
- **素材命名**：本机素材名与 FCPXML 媒体包名同源（场景 + 镜头 + 候选 / 配音），只留一个扩展名；
  重名在写盘前就报错，不静默改名。旧素材保持原样。
- **FCPXML 三档**：单文件 `.fcpxml` 直接指向本机素材；媒体包 zip 与「导出工程目录」另带 `media/`、
  `subtitles.srt`、`missing.txt`。工程目录摊开留在本机资产库下的 `FCPXML工程/`（与「存回本机」的素材同根，
  回路径、可打开文件夹），不再额外写一份 `bundle.zip` 把素材存两遍；要发给别人就点「导出媒体包」。
  时间线保留镜头顺序、入出点、倍速、转场（按 FCPXML 语义写成居中重叠的 Cross Dissolve）、配音与字幕样式；
  缺的素材逐条列在文件头与 `missing.txt`。导入到 Final Cut Pro 或其他支持 FCPXML 的软件由用户自己完成，
  这里不启动、也不假装能替用户点导入。
- **项目文件（完整工程）**：页头短片名那颗下拉的底部有一行默认折叠的「项目文件 · 导入 / 导出」，摊开后整组缩进在一条竖线里：上面是一颗导出拆分按钮（主钮「导出当前短片」、尾钮摊开「导出当前项目组短片 / 导出全部短片」），下面一行「导入项目文件」。
  导出的是作品本身 —— 每一镜的全部候选（含没选用、失败、草稿）、提示词与台词、参考图与首尾帧、
  选用 / 裁剪 / 锁定、成片轨（画面 / 配音 / 字幕 / 标记 / 轨道状态）、画幅与项目组名；
  只认当前一版并带校验和，文件没下完整或被人改过会拒绝且一个字节都不写。导入一律追加为新短片，
  不覆盖现有作品；撞 id 换一枚、撞名字按「（导入）」→「（导入 2）」往后编号（同一个包导两次也不会重名）、在途生成标成可重试。
  项目组跟着包一起回来但只认组名：本机没有同名组就新建，已有同名组会先问你「并入那个组 / 给导入的组改名」。
  内容与本机某部完全一致的短片也会先问「跳过 / 照导并重命名」，选跳过就一部都不写
  （比对的是作品内容，名字与 id 不算，导出那台机器的组 id 也不会跟着走）。
  视频字节不进包：换机器时把视频文件（或「导出媒体包」里的 `media\`）放进本机资产库，
  再导入项目文件就会按包里的素材线索认回旧号，不用重新导入一遍。
- **本机素材只认一个目录**：设置页「本机资产库」选的那个库根（默认 `下载\成像`）下面按类型分
  `图片\` `视频\` `音频\`。资产库索引、磁盘对账、导演台导入项目都只在**这个目录**里找文件，
  不会去桌面、下载夹或机器上其它地方翻；账里指到库根外面的旧落点一律按「不在这里」处理。
  换机器时把「导出媒体包」里的 `media\` 挪进这个目录，再导入项目文件即可 —— 文件名带着
  `__la_xxx` 可移植尾标（没有尾标的按内容签名 + 字节数认），代理会把它认回原来那一枚本机号，
  不用重新导入素材；盘上已有同一份字节时也只补索引，不再下载 / 再存一份。
  导演台生成的产物一律自动存这个目录（开关只管历史产物要不要补齐；工作台的产物仍听这个开关）；
  收藏页「上传本地文件」是浏览器
  自己的一份收藏库（IndexedDB），不写库根 —— 只有在工作台 / 导演台真正用到它时才转存成本机资产。

## 目录

```text
proxy.js                      薄入口（require server/app.js）
server/
  app.js                      组合根：配置、依赖装配、路由分发
  registry-config.js          供应商注册表（新平台只改这里）
  routes/                     每组本机路由一个模块（含 model3d：白模库的多库 / 模型 / 场景 / 场景组 / 3D 文件）
  local-root.js               本机资产库根的唯一算法（ASSETS_DIR > 设置页那一格 > 下载\成像）
  local-assets-store.js       资产本体落点、双身份（fid + 采样签名）、磁盘对账
  index-store.js              资产索引（快照 + 追加日志 + 串行写队列），账在 .data\local-assets\
  user-dirs.js                用户可见目录根（系统下载文件夹 → 下载\成像 / 提示词）
  data-hub.js                 数据层唯一实现：原子写原语 + state.json 状态仓 + backup.json 快照仓 +
                              /data、/backup、/cloud、/prompts 与 ASR / 搜索 / Skill 设置
  security.js / outbound.js   同源 / Cookie / 出站护栏
  static.js                   ETag / brotli→gzip→原文 / HTML CSP 头
shell.html                    SPA 外壳
web/
  app.js                      路由 + KeepAlive 页面池
  core/                       路由表、页面桥、页面上下文、动作注册表
  pages/                      七个 Vue 页面组件（导演台在 director/index.js，合计 8 个页面）
  model3d/                    建模台的三维内核：schema（v3 模型 / 场景）/ entities（库模型 ↔ 场景实体）/ mannequin（小人）/ rig.js（关节写回 · 子关节轨道）/ crowd / scene / loader + clip.js（导入件与动画播放）/ anim / view / vault / ai / capture
  director/                   导演台作用域岛 + 引擎 + 纯算法模块
  render/                     预编译 render 函数（生成物）
  ui/ net / store / kv / toast / datasync / skills / workbench / sidebar
  domain/                     资产、本机优先、能力、文字 AI、素材库、语义检索
  features/chat.js            AI 助手外壳（悬浮球 / 抽屉 / 会话 / 引用队列）
  features/chat-tools.js      助手工具循环与动作目录
  styles/                     设计令牌与页面样式
  vendor/                     vendored 第三方（运行时零构建的唯一例外）：three / mediabunny / asr
tools/
  precompile-vue.cjs          模板 → render 函数
  vendor-three.cjs            从 npm 包取出 three、改写裸说明符、落到 web/vendor/three/（幂等）
  vue-templates/              模板源（开发期）
  migrate-skills.cjs          一次性：用户 Skill 目录换根
skills/<id>/SKILL.md          内置 Skill
tests/                        常驻判据 + 单元 + e2e
```

完整结构与硬约束见 `AGENTS.md`。

## 严格 CSP 与模板预编译

`shell.html` 与代理的 HTML 响应都下发：

```text
script-src 'self'; object-src 'none'; base-uri 'self'
```

运行时加载的是 `vue.runtime.esm-browser.prod.js`（无编译器）。页面模板源在
`tools/vue-templates/*.html`，构建生成 `web/render/*.js`：

```bash
npm run build        # 改了模板之后
npm run build:check  # 校验生成物
```

不要在 `web/` 里写 `template:` 字符串；不要加内联 `<script>` / 内联事件处理器。
`style-src` 仍允许 `unsafe-inline`（现有页面大量使用内联样式与动态样式元素）。

## 本机优先

- 产物身份只有一份判据：`AssetLocal` 的 `rowOfEntry`（查的是代理现给的别名表：`/local-assets/aliases` + `/local-assets/locate`）。
- 本机 / 云端状态只有 `AssetLocal.stateOf(entry)`。
- 自动镜像由 `wb:asset-done` 事件触发，字节由代理流式落盘进**本机资产库根**的类型子目录
  （默认 `下载\成像\图片|视频|音频|其他\`，设置页可改；一条产物只有一份本体，文件名按「场景+镜头+候选」规范名，撞名加 `-2`）。
- 索引与本体分家：账在 `.data\local-assets\`（快照 + 追加日志），本体在库里。
  每条账带**两个身份**——`fid`（设备+inode，改名认得）与采样内容签名（字节数 + 首尾各 1MB 的哈希，挪盘认得），
  所以手动改名、整目录搬到另一块盘，下一轮磁盘对账还能把账认回来；同一任务重复下载只出一张卡。
- 过期签名外链由 `Api.mediaExpired` / `Api.healMedia` / `Api.mediaSrc` 统一处理。
- 导演台导出始终优先本机副本；预览是否优先本机由设置项 `sk_media_prefer` 控制。
- 「存回本机」四颗按钮共用 `AssetLocal.pullMany`；工作台 / 资产库 / 收藏那一颗在**多选条**里，
  多选之后才出现，存的是**勾选的那几条**。

## 添加一家平台

只改 `server/registry-config.js` 的 `REGISTRY.providers`（relay / base / keyEnv / endpoints / modelDocs /
create / inputRoles / inputTemplates / uploadFields / pricing），页面不改。
注册表结构变化时把 `REGISTRY.version` +1；资产存储换平台改顶层 `REGISTRY.assetStore`。

用户自己的中转走设置页「添加 / 编辑供应商」：先填地址与密钥，再**多选六档能力**（图片生成 /
视频生成 / 语音合成 / 文字 AI / 语音识别 / 联网搜索），每一档各自选接口形状与型号；
文字型号可以逐条声明 图 / 音 / 视 输入能力。一个供应商 = 一张账号卡，代理按档各建一条 provider、
共用同一把密钥，自动继承能力、上传与端点。不需要改代码。

## 开发与验证

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 改了 `tools/vue-templates/*.html` 后重生成 `web/render/*.js` |
| `npm run build:check` | 只比对模板与生成物，不写盘 |
| `npm run check` | 每次保存后：`build:check` + 语法判据 |
| `npm run static` | 动了样式 / 令牌后：裸值体检、令牌引用、静态与文档契约 |
| `npm run test` | 合并 / 提交与推送前：常驻判据全量 |
| `npm run test:fast` | 按 `tests/map.cjs` 的映射挑改动相关的判据 |
| `npm run test:all` | 常驻判据 + 浏览器冒烟 6 条 |
| `npm run test:director` | 改剪辑核时的纯件与一次装配冒烟 |
| `npm run test:e2e` | 浏览器全量（按需手动跑，不是提交前置） |
| `npm run test:watch` | 连续改码时前台观察，800ms 防抖 |
| `npm run ci` | `check` + `static` + `test`，本地与 GitHub Actions 共用这一条 |

```bash
npm run build:check
npm run test
```

改完跑这两条就够（模板一致 + 常驻判据全量，几秒）。
浏览器档（`npm run test:e2e`）**不是提交与推送的前置条件**，要跑再手动跑：

```bash
npm run test:e2e
```

`--e2e` 包括视觉回归（八条路由（含设置页）、工作台按三型分档，加上先喂状态才画得出来的字幕编辑区与助手来源卡片，
共 12 档 × 1024/1440 × 浅/深主题 = 48 个画面）、
语音识别与联网搜索（含助手回答下面的来源编号与引用卡片）、
云同步带哪些键、FCPXML 媒体包与工程目录、本机资产一条链（落点 / 双身份 / 改名挪目录认回 / 重复下载并卡 / 删一张卡带走整组），
以及导演台性能预算与「切片解码失败之后自己补得回来」；
有意改版后更新基线：

```bash
UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs
PARITY_WRITE=1 node tests/e2e/parity.cjs
```

写入型验证必须起隔离实例：

```bash
PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe \
  RENDER_DIR=.renders-probe SKILLS_DIR=.skills-probe AUTOSAVE_DIR=.downloads-probe node proxy.js
```

`ASSETS_DIR` 指的是**库根**（默认在 `下载\成像`，仓库外）；手动起探针时还要 `AUTOSAVE_DIR`
（把整个「下载」基座指走，`server/user-dirs.js` 读它），否则提示词归档会往用户真成品目录里写。
判据自己起的实例由 `tests/e2e/harness.cjs` 的 `startProxy` 统一带上这一枚，不用每条判据各写一遍。

`node tests/data-snapshot.cjs` 用来确认真实 `.data`、`.renders` 与库根本体没有被测试改动。
测试细节、公共层唯一实现清单、平台事实与编码规范都在 `AGENTS.md`。

## 编码

- 源码与文档：UTF-8。
- `启动.bat`：UTF-8 + `chcp 65001`。
- `launcher.ps1`：UTF-8 带 BOM + CRLF（PowerShell 5.1 的要求）。
- 不要提交 `.env`、`.data/`、`.assets/`、`.renders/`、`文件/`、`.skills/`：后两个是库根可能被指回项目内时的落点，里面是用户作品。
- 产物本体默认在系统下载文件夹的 `成像\` 下，不在仓库里；仓库里的 `.data\local-assets\` 只是账。

## 第三方

- Vue 3.5.44 runtime-only，本地 vendored（`vue.runtime.esm-browser.prod.js`），MIT，
  许可证见 `vue.LICENSE.txt`。
- 开发依赖 `@vue/compiler-dom` 只用于预编译模板，不进入运行时。
