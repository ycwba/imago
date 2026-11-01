# 成像 · AI 创作工作台

本地优先的 AI 创作工作台：七个页面（导演台 / 素材库 / 工作台 / 收藏 / 资产库 /
用量 / 设置）由 Vue 3 SPA 统一承载，生成任务与数据全部经本机 Node 代理转发与落盘。

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

## 页面

| 页面 | 作用 |
| --- | --- |
| 导演台 | 分镜、候选生成、时间线剪辑、配音、成片导出、FCPXML、送到剪映 / 达芬奇 |
| 工作台 | 视频 / 图像 / 语音三合一，按 `?t=video|image|audio` 切栏 |
| 素材库 | 角色 / 场景 / 道具，体检、批量、身份锚点、使用关系、语义与视觉检索 |
| 资产库 | 本机 / 云端产物、筛选、分页、批量下载与存回本机 |
| 收藏 | 跨平台收藏、备注、复用 |
| 设置 | 供应商与密钥（一家账号一张卡，含语音识别 / 联网搜索两档）、模型偏好、存放目录、数据与同步、Skill 管理 |
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
- **送到剪映 / 达芬奇**：生成持久 FCPXML 工程与 media 包，启动软件（找得到才启动）并打开工程目录，
  最后在软件里点一次导入；剪映若没有导入 FCPXML 菜单，需在「全局设置」打开。

## 目录

```text
proxy.js                      薄入口（require server/app.js）
server/
  app.js                      组合根：配置、依赖装配、路由分发
  registry-config.js          供应商注册表（新平台只改这里）
  routes/                     每组本机路由一个模块
  local-root.js               本机资产库根的唯一算法（ASSETS_DIR > 设置页那一格 > 下载\成像）
  local-assets-store.js       资产本体落点、双身份（fid + 采样签名）、磁盘对账
  index-store.js              资产索引（快照 + 追加日志 + 串行写队列），账在 .data\local-assets\
  user-dirs.js                用户可见目录根（系统下载文件夹 → 下载\成像 / 提示词）
  data-store.js               原子写 + .bak + 读坏拒写
  prompts-store.js            提示词归档
  cloud-store.js              云同步与备份
  skills-store.js             Skill 清单 / 安装 / 启停
  security.js / outbound.js   同源 / Cookie / 出站护栏
  static.js                   ETag / brotli→gzip→原文 / HTML CSP 头
shell.html                    SPA 外壳
web/
  app.js                      路由 + KeepAlive 页面池
  core/                       路由表、页面桥、页面上下文、动作注册表
  pages/                      八个 Vue 页面组件
  director/                   导演台作用域岛 + 引擎 + 纯算法模块
  render/                     预编译 render 函数（生成物）
  ui/ net / store / kv / toast / datasync / skills / workbench / sidebar
  domain/                     资产、本机优先、能力、文字 AI、素材库、语义检索
  features/chat.js            AI 助手外壳（悬浮球 / 抽屉 / 会话 / 引用队列）
  features/chat-tools.js      助手工具循环与动作目录
  styles/                     设计令牌与页面样式
tools/
  precompile-vue.cjs          模板 → render 函数
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

用户自己的中转走设置页「添加自定义供应商」，按类型填写后自动继承能力、上传与端点；
不需要改代码。

## 开发与验证

```bash
npm run build:check
npm run test
```

改完跑这两条就够（模板一致 + 常驻判据全量，几秒）。
浏览器档（`node tests/all.cjs --e2e`）**不是提交与推送的前置条件**，要跑再手动跑：

```bash
node tests/all.cjs --e2e
```

`--e2e` 包括视觉回归（七条路由、工作台按三型分档，加上先喂状态才画得出来的字幕编辑区与助手来源卡片，
共 11 档 × 1024/1440 × 浅/深主题 = 44 个画面）、
语音识别与联网搜索（含助手回答下面的来源编号与引用卡片）、
云同步带哪些键、FCPXML 媒体包、本机资产一条链（落点 / 双身份 / 改名挪目录认回 / 重复下载并卡 / 删一张卡带走整组），
以及导演台性能预算与「切片解码失败之后自己补得回来」；
有意改版后更新基线：

```bash
UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs
PARITY_WRITE=1 node tests/e2e/parity.cjs
```

写入型验证必须起隔离实例：

```bash
PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe \
  RENDER_DIR=.renders-probe SKILLS_DIR=.skills-probe node proxy.js
```

`ASSETS_DIR` 指的是**库根**（默认在 `下载\成像`，仓库外）；打默认目录那两条链路的判据还要 `AUTOSAVE_DIR`
（把整个「下载」基座指走，`server/user-dirs.js` 读它），否则探针会往用户真成品目录里写。

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
