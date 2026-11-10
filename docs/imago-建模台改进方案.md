# imago 建模台改进方案

共 18 项改动 + 1 条执行纪律。每项给到：做什么、改哪些文件、怎么改、怎么算做完。

---

## 总览

| # | 改动 | 主要文件 | 批次 |
| 1 | 灯光实体化：灯进文档，与机位平级 | `schema.js` `scene.js` `SKILL.md` | B1 |
| 2 | 白膜库加语义索引，AI 能自己找模型 | `routes/model3d.js` `index-store.js` | B5 |
| 3 | AI 读侧只给大纲 + 选中子树 | `ai.js` `schema.js` `SKILL.md` | B3 |
| 4 | 文档只写非默认字段 | `schema.js` `routes/model3d.js` | B2 |
| 5 | 契约同步机制（两份逐字节）+ 白膜文档 JSON Schema + 模型迁移器 | `text-ai.js` `skills/model3d/schema.json` `tools/migrate-model.cjs` | B4 |
| 6 | 通用「阵列」原语 | `schema.js` `scene.js` `SKILL.md` | B6 |
| 7 | `loft` 沿路径扫掠 + 环间插值 | `schema.js` `scene.js` `SKILL.md` | B6 |
| 8 | 三条约定写进注释与契约 | `schema.js` `SKILL.md` | B6 |
| 9 | 建模 AI 本身的改进（复用判断 / 几何体检 / 丢件回灌 / 自查构图） | `ai.js` `lint.js` `SKILL.md` | B7 |
| 10 | AI 助手完善（进建模台 / 共用 op 词汇 / 能力声明生成工具 / 兜底回流） | `features/chat-tools.js` `features/chat.js` `domain/` | B8 |
| 11 | 新增 `更新.bat`：检测仓库更新并拉取 | `更新.bat` `update.ps1` `启动.bat` | B11 |
| 12 | `启动.bat` / `更新.bat` 三档主题 | `启动.bat` `更新.bat` `.env` | B10 |
| 13 | 默认档改成「跟随系统」（三档已存在，只改默认值） | `ui/ui.js` `shell-boot.js` | B9 |
| 14 | 首屏约束的现状与判断（本方案一处都不用放宽） | —— | —— |
| 15 | 涂鸦标注 → AI 生成运镜（多工具 + 调色板 + 3D 锚定 + 不抢视口） | `web/model3d/view.js` `web/model3d/scene.js` `web/model3d/ai.js` `text-ai.js` | B12 |
| 16 | 动画轨道增强（offset / speed / path 的 look / 叠加语义 / motion 参数化） | `anim.js` `schema.js` `mannequin.js` `rig.js` | B13 |
| 17 | 导演台与工程化改进（README 数字 / 撤销降级 / Skill 副本生成 / 共享词汇表 / engine.js 继续拆） | `director/engine.js` `domain/text-ai.js` `tools/` | B14 |
| 18 | 运镜生成：丝滑路径与镜头语言（AI 优先产 path + ease + 构图保持） | `model3d/anim.js` `model3d/schema.js` `SKILL.md` | B15 |

---
## 1. 灯光实体化：灯进文档，与机位平级

**做什么**：把现在写死在 `scene.js` 里的三盏灯改成文档里的**灯实体**，与 `cams[]`（机位）平级。
灯在属性面板里可增删改、能在视口里选中和转动、能打关键帧、能跟随节点、**AI 能直接增删改**。

### 1.1 现状

- 灯写死在 `scene.js:181-207`：`HemisphereLight(1.35)` + 主光 `DirectionalLight(2.1)` + 补光 `DirectionalLight(0.45)`，位置写死
- 白膜文档的节点种类只有 `group / prim / mannequin / crowd / asset / ref`，**没有灯**
- 属性面板有「机位」tab（位置 / 看向 / FOV / 跟随 / 打关键帧 / 取景预设），**没有任何灯的入口**
- 视口里灯不可见、不可选、不可拖
- **AI 完全碰不到灯**：`SKILL.md` 契约里没有灯，ops 词表（`update/add/remove/move/group/ungroup/cam/track/anim`）里没有灯，`applyDocOps` 里也没有灯的分支

机位已经是完整的一等对象，灯完全不是 —— 这是白膜里最大的一处不对称。

### 1.2 文档结构

灯分两层：**可增删的灯实体** + **不可增删的装置参数**。

```json
"lights": [
  { "id": "l-key", "name": "主光", "shape": "sun",
    "at": [-3.2, 4.1, 2.6], "target": [0, 0.8, 0],
    "energy": 2.1, "color": "#ffffff",
    "shadow": { "on": true, "mapSize": 2048, "bias": -0.0005, "normalBias": 0.02 } },
  { "id": "l-rim", "name": "轮廓光", "shape": "spot",
    "at": [2.4, 1.6, -2.2], "target": [0, 0.8, 0],
    "energy": 40, "color": "#8fb8ff",
    "angle": 0.5, "penumbra": 0.6, "distance": 8 }
],
"light": {
  "hemi": { "sky": "#ffffff", "ground": "#d9d4cc", "energy": 1.35 },
  "ground": { "color": "#1a1a1a", "opacity": 0.16 },
  "exposure": 1.0
}
```

### 1.3 灯有三种形态

只有这三种有位置、值得当实体：

| `shape` | 对应 | 字段 |
|---|---|---|
| `sun` | 平行光 | `at` `target` `energy` `color` `shadow` |
| `point` | 点光 | `at` `energy` `color` `distance` |
| `spot` | 聚光 | `at` `target` `energy` `color` `angle` `penumbra` `distance` |

**半球光不是灯实体** —— 它没有位置，移动它没有意义，所以归装置级 `light.hemi`。
地台与曝光同理，归 `light.ground` / `light.exposure`。

`shadow` 只对 `sun` 有效；`shadow.on: false` = 关投影（改用环境光打亮，做无影白膜）。

两段都可省。省略 `lights` = 用内置默认装置（key + fill 两盏，参数与现在逐字一致）；
省略 `light` = 默认环境光与地台。

### 1.4 改动点

| 文件 | 改什么 |
|---|---|
| `web/model3d/schema.js` | `normalizeDoc` 增加 `lights[]` 与 `light` 段归一化；`KINDS` 不动（灯不混进零件树） |
| `web/model3d/schema.js` | `normalizeTracks` 的 `of.kind` 增加第三种 `'light'`（现只有 `'cam'` 与 `'node'`）；校验集合加 `lightIds` |
| `web/model3d/scene.js` | `buildContent` 的三盏灯改为遍历 `doc.scene.lights` 建；`light` 段给环境光 / 地台 / 曝光 |
| `web/model3d/anim.js` | 新增 `sampleLights()`，与 `sampleCams()` 对称 |
| `web/model3d/view.js` | 视口里画灯的 gizmo；灯不参与出图渲染（不画实体） |
| `web/pages/model.js` + `web/pages/model/dock.js` | 属性面板加「灯光」tab（与「机位」tab 平级）。**属性面板现在拆成两处**（`model.js` 137KB + `model/dock.js` 18.5KB），先确认「机位」tab 落在哪一份，再决定新 tab 放哪 |
| `skills/model3d/SKILL.md` **+** `web/domain/text-ai.js` 的 `model3d:` 模板 | 新增 `lights[]` 与 `light` 段的字段说明 + `light` op 说明。**两份逐字节一致**（见 5.1） |

**视口 gizmo 照抄相机现成的那套**：`scene.js` 已经建了 `rigCam` + `CameraHelper`，
以及一个专供拾取的 `stage-camera-pick` 代理；`view.js` 里对应 `camGizmo` / `setCameraRigs`。
灯照着建 `light-gizmo` + `light-pick`（一个从灯位指向 `target` 的箭头 + 一个小方块），
拾取、高亮、拖动的代码路径完全复用。

### 1.5 属性面板「灯光」tab

照抄现有机位 tab 的结构：

```
灯光
  主光     sun
  轮廓光   spot
灯值
  当前灯  主光
  位置（x / y / z，米）
  看向（x / y / z，米）
  能量
  颜色
  阴影  开 / 关 · 2048 · bias · normalBias
  跟随  不跟随 / 未命名白膜 / 桌面 / 桌腿 / …
在播放头打灯光关键帧
布光预设
  默认白膜 / 三点布光 / 侧逆光 / 无影平光
```

「看向」与「跟随」的取值器与机位共用一套（节点树选择器）。

**布光预设** = 一组 `lights[]` + `light` 的整体替换。预设表与 `web/model3d/palette.js`
放一起（那里已经有 `CLAY` / `GROUND` / `TRACK_COLORS`，配色与预设同属「外观常量」）。

### 1.6 AI 怎么控制灯光

`skills/model3d/SKILL.md` 的契约里加一节「灯光」，ops 词表加第 10 个动词 `light`
（形态与现有的 `cam` op 完全对称）：

```json
{"op":"light","add":{"name":"轮廓光","shape":"spot","at":[2.4,1.6,-2.2],"target":[0,0.8,0],"energy":40,"color":"#8fb8ff"}}
{"op":"light","id":"l-key","set":{"energy":3.2,"target":[1,0.8,0]}}
{"op":"light","id":"l-fill","remove":true}
{"op":"light","set":{"exposure":1.15,"hemi":{"energy":1.1}}}
```

- `light.add` 加一盏；`light.id + set` 改一盏；`light.id + remove` 删一盏；
  `light.set` 改装置级参数（`exposure` / `hemi` / `ground`）
- `applyDocOps` 里 `light` 分支照抄 `cam` 分支的写法（`schema.js` 的 `else if (kind === 'cam')`）
- **灯轨道**：`of: {kind:'light', id:'l-key'}`，`anim.js` 里由 `sampleLights()` 求值，与 `sampleCams()` 对称
- **作用域**：修改选中实体时，灯轨道与机位轨道一样越界拒绝 ——
  `schema.js:661` 那句 `tr.of.kind !== 'node'` 要把 `'light'` 一并排除

改完之后 AI 能听懂并执行：

| 用户说 | 变成 |
|---|---|
| 把主光从左边换到右边 | `light` op 改 `l-key.target` |
| 加一盏蓝色轮廓光从右后方 | `light.add`（`shape:"spot"`） |
| 影子太重了，柔一点 | 调 `light.hemi.energy` / 降 `key.shadow.opacity` |
| 不要影子 | `light` op 改 `l-key.shadow.on: false` |
| 让灯光扫过 | 给灯打关键帧（`of.kind:'light'`） |
| 换成三点布光 | 布光预设整套替换 |

### 1.7 验收

- 库里所有**不带 `lights` / `light` 段**的存量白膜，出图与改动前逐像素一致 —— 加一条建模台出图的像素基线
- 属性面板里能加一盏灯、改位置 / 朝向 / 强度 / 颜色 / 阴影，出图跟着变
- 视口里能点中灯并拖动，光照实时变化
- 灯能打关键帧，播放时朝向与能量随时间变
- 灯的「看向」能指向零件节点（机位同款跟随）
- AI 说「加一盏蓝色轮廓光从右后方」，库里多一盏灯，视口里能看见 gizmo，出图里有那盏灯
- AI 说「把主光换到右边」，`l-key.target` 变了，出图跟着变
- 「修改选中实体」模式下，AI 试图改灯轨道 → 被拒（与机位轨道同规则）
- 一份带 `lights` 的 JSON 交给另一套实现，能复现同一张图

---

## 2. 白膜库加语义索引

**做什么**：给白膜库建索引，AI 能问「库里有没有桌子」，而不是靠用户手动勾选。

### 2.1 索引落点与实现

用 `server/index-store.js` 的 `createIndexStore({ dir, log })` 建一个独立实例，目录
`.data/model-index/`。index-store 已经封装好快照 + 追加日志 + 串行写队列 + 定期压实，
原子写走 `data-hub.js` 的 `atomicWrite`，不另写一套。

```
.data/model-index/
  index.json      快照：{ id: { path, name, group, ts, outline, thumb, prompt } }
  index.jsonl     增量日志（put / del）
```

**写入口一律走 `update(fn)`，不要用 `upsert` / `remove` 直接写。**
`save` / `rename` / `delete` 都是异步路由，调用点中间有 `await`，并发请求会各拿整表
互相覆盖（index-store 头注里写明：调用点中间只要有 `await` 就必须用 `update(fn)`）。
`upsert` / `remove` / `find` 是同步原语，只在全程无 `await` 的连续操作里用。

条目的 `outline` 字段由第 3 项引入的 `outlineOf(doc)` 生成。

### 2.2 索引内容

- `outline`：节点树骨架 —— 每节点只给 `id / name / kind / shape / 子节点数`，**不给坐标**
- `prompt`：白膜建模那次的提示词，复用 `提示词/_index.json` 的归档
- `thumb`：缩略图路径，`thumb` 机制已有

### 2.3 改动点

| 文件 | 改什么 |
|---|---|
| `server/index-store.js` | 不改。直接 `createIndexStore({ dir, log })` |
| `server/routes/model3d.js` | 建索引实例；`save` / `rename` / `delete` 走 `update(fn)` 维护索引；读走 `read()` / `find()` |
| `web/domain/` | AI 面板的「AI 可调用的白模库」从手动勾选改成检索 |

### 2.4 验收

- 库里存一个「四条腿的桌子」，问 AI「库里有没有能当餐桌的」，AI 答得出并给出 `库名 :: 组/名`
- 删掉一个模型后再问，AI 不再提它
- `SKILL.md` 里「清单里没有的不要编」继续成立 —— 索引给出的就是真实清单

---

## 3. AI 读侧只给大纲 + 选中子树

**做什么**：提示词里的「当前场景」从全量改成两段：**大纲**（骨架）+ **选中子树详情**。

### 3.1 提示词长什么样

```
【场景大纲】只给骨架
  实体 未命名白膜 (group)
    ├ 桌面 (box) 4
    ├ 桌腿 (box) 4
    ├ 细颈花瓶 (lathe)
    └ 小碗 (lathe) 2
  机位 cam-1 (16:9, fov 35)

【选中实体完整细节】只给选中子树的完整字段
  细颈花瓶 …
```

大纲里的节点只给「够认出来」的摘要（id / 名字 / kind / 形状 / 子节点数）。
坐标、材质、轨道只出现在选中子树里。

**现状是「全量 + 选中子树再来一遍」** —— `ai.js` 的 `currentText()` 里
`nodes` 全量已经含选中子树，末尾又挂一份 `body.selected = n`，同一棵子树喂两遍。
改造后 `nodes` 只给大纲，选中子树单独给一份。

### 3.2 改动点

| 文件 | 改什么 |
|---|---|
| `web/model3d/schema.js` | 新增 `outlineOf(doc)` 纯函数：走一遍节点树，吐大纲行 |
| `web/model3d/ai.js` | 拼提示词时用「大纲 + 选中子树」替换「完整场景」 |
| `skills/model3d/SKILL.md` | 说明提示词是这两段；加一条「大纲里没有的 id 不要编」 |

### 3.3 验收

- 造一个 200 节点的场景，对比改造前后的提示词 token 数
- 20 节点场景里让 AI 改 A 节点，统计它顺手改坏别的节点的次数（改造前 vs 改造后）
- 选中实体为空时，提示词只有大纲

---

## 4. 文档只写非默认字段

**做什么**：落盘的 JSON 省略全部默认字段，内存里始终是完整形态。

**读侧已经做了**：`ai.js` 的 `compactNode()` 在喂给 AI 之前就把默认值剥掉了。
这一项补的是**写侧与落盘侧** —— AI 写回时仍写全字段，落盘时也写全字段
（AI 输出那一半见第 9.5 条）。

### 4.1 省略哪些

`kind` 之外的这些，每个节点现在都明写着，实际全是默认值：

```json
"fromModel": "",  "rot": [0,0,0],  "scale": [1,1,1],  "at": [0,0,0]
```

省略规则：`fromModel` 空串省；`rot` 全零省；`scale` 全一省；`at` 全零省；
`name` 空省；枚举字段取默认值省。

### 4.2 改动点

| 文件 | 改什么 |
|---|---|
| `web/model3d/schema.js` | 新增 `sparseDoc(doc)`，与 `normalizeDoc` 对称：稀疏 → 完整 |
| `server/routes/model3d.js` | 写盘前调 `sparseDoc`；读盘仍走 `normalizeDoc` 补全 |
| `skills/model3d/SKILL.md` **+** `web/domain/text-ai.js` | 加一句「省略默认字段」（配合第 9.5 条）。**两份逐字节一致** |

### 4.3 验收

- 4 个图元的白膜文档从 4.7KB 降到 **3KB 以内**
- 现有 11 个 `model3d-*` 判据**全绿且不用改**（内存形态没变）
- 稀疏文档读回来补全后，与稀疏前的完整文档逐字段相等
- 落盘文件里不再出现 `"fromModel": ""` / `"rot": [0,0,0]` 这类默认值

---

## 5. 契约同步机制 + 发布白膜文档 JSON Schema

### 5.1 先说清「契约」是什么（现状）

**契约正文有两份，必须逐字节一致：**

| 位置 | 内容 |
|---|---|
| `skills/model3d/SKILL.md` | 建模台的指令正文（内建 Skill） |
| `web/domain/text-ai.js` 的 `model3d:` 模板字符串 | 同一份正文，**程序实际发出去的那份** |
| `web/domain/text-ai/contracts.js` | 契约注册表（key → 正文来源） |
| `web/domain/text-ai.js` 的 `'model3d.json': [...]` | **占位符说明表**：每个占位符叫什么、从哪来、干什么 |

`text-ai.js:342-344` 的注释写得很清楚：

> 正文与 skills/model3d/SKILL.md 同源，**改这里必须同时改那一份**（判据 tests/e2e/smoke.cjs 逐字节比）。

`tests/e2e/smoke.cjs:46-52` 守着这条：任何一份漂了，判据报
「内置 Skill 正文与 TextAI.DEF 漂开了（同一份提示词两处维护）」。

**所以：本方案里凡是「改 SKILL.md」的地方，都要同时改 `web/domain/text-ai.js` 的 `model3d:` 模板，
两份一字不差。** 涉及：

- 第 1 项 —— 灯光字段说明、`light` op 说明
- 第 9.4 条 —— 补 `{animations}` 一节
- 第 10.2 条 —— 共享动作目录的用法说明

加新占位符（比如 `{light}`、`{outline}`）还要同步 `text-ai.js:626` 那张占位符说明表。

**`model3d.json` 是契约的 key，不是文件。** `SKILL.md` frontmatter 里的 `contract: model3d.json`
说的是「用哪份契约」，不是「有个同名文件」—— 那个文件确实不存在，但那是另一回事（见 5.2）。

顺带：`web/features/chat-tools.js` 末尾 `export { CONTRACT }` 里的 `CONTRACT = 'model3d.json'`
**没有任何调用点**（`AiChatTools.CONTRACT` 无人引用），是个悬空导出。做第 10 项时顺手清掉或接上。

### 5.2 发布白膜文档的 JSON Schema

**做什么**：给白膜文档 v3 写一份 JSON Schema，放在 `skills/model3d/schema.json`
（**别叫 model3d.json** —— 那个名字已经是契约的 key，撞了会让「契约」和「格式」两个概念混在一起）。

内容对齐 `web/model3d/schema.js` 的 `normalizeDoc`：

- 必填 / 可省字段
- 枚举取值：`KINDS` / `SHAPES` / `TONES` / `CLIP_LOOPS` / `TRACK_INTERPS` / `PATH_KINDS` / `ASPECTS`
- 每个字段的 `x-help` 说明（照抄 `schema.js` 里的注释）
- 第 1 项新增的 `lights[]` 与 `light` 段
- 第 6 项新增的 `array`

好处：外部工具能校验、AI 能拿稳定格式定义、`normalizeDoc` 与 Schema 的一致性可以写成判据。

### 5.3 `tools/migrate-model.cjs`

照 `tools/migrate-skills.cjs` 的形状写：一次性、可重跑、只认一个数据目录。

~~~sh
node tools/migrate-model.cjs --from 2 --to 3 --dir <库根>
~~~

迁移函数按版本注册，一版一行：

~~~js
const MIGRATIONS = {
  '2>3': (doc) => { /* … */ return doc; },
};
~~~

### 5.4 版本表

`schema.js` 的 `MODEL_V = 3` 旁边加一张表，记每一版之间改了什么，测试直接 import 迁移函数。

### 5.5 验收

- `skills/model3d/schema.json` 能过 JSON Schema 校验器，且用 `schema.js` 生成的合法文档 100% 能过
- **改了契约正文后，`npm run test:all` 里 `tests/e2e/smoke.cjs` 仍然绿**（两份逐字节一致）
- 拿一份 v2 文档跑迁移器，结果与 `normalizeDoc` 补全后逐字段一致

---

## 6. 通用「阵列」原语

**做什么**：把 `crowd` 的 `rows/cols/gapX/gapZ/jitter` 提成通用 `array`，任意图元都能阵列。

现在「四条腿的桌子」要靠 `mirror: true` + `repeat: {n:2, dz:0.76}` 拼 ——
一条腿 + 镜像 + 复制。镜像与复制的**展开顺序**是隐式约定（先 repeat 再 mirror 才凑得出 4 条）。

### 6.1 新字段

```json
{ "kind": "prim", "shape": "box", "id": "n-9",
  "at": [-0.72, 0.36, -0.38],
  "array": { "rows": 2, "cols": 2,
             "gapX": 1.44, "gapZ": 0.76,
             "jitter": 0 } }
```

- `rows` / `cols`：整数，`rows=1` 表示单排
- `gapX` / `gapZ`：相邻间距（米），可负
- `jitter`：站姿微差幅度
- 网格以节点自身 `at` 为第一格的中心

`crowd` 改成 `{ kind: 'crowd', body, pose, array: { rows, cols, gapX, gapZ, jitter } }`，
是 `array` + 人台的一种特例。

### 6.2 改动点

| 文件 | 改什么 |
|---|---|
| `schema.js` | `array` 字段归一化（复用 `intAtLeast` / `nonNeg`） |
| `scene.js` | 新增 `buildArray(node, ctx)`，按 rows×cols 生成实例节点 |
| `SKILL.md` | `array` 写进节点种类说明；`crowd` 的说明改成引用它 |

### 6.3 验收

- 「四条腿的桌子」用一个 `array` 字段写完
- `crowd` 的现有判据 `model3d-crowd.mjs` 保持绿（只改内部实现，不改对外字段语义）

---

## 7. `loft` 沿路径扫掠 + 环间插值

**做什么**：`loft` 现在只有等高 `rings`。补两条能力。

### 7.1 沿路径扫掠

```json
{ "kind": "prim", "shape": "loft",
  "path": { "kind": "line", "from": [0,0,0], "to": [0,2,0] },
  "profile": [[0.2,0],[0.12,1],[0.16,2]],
  "seg": 24 }
```

- `path` 复用动画那套路径形状（`line/circle/rect/free`），形状定义抽成一处共用
- 截面沿路径扫掠，`profile` 给的是沿路径方向的截面轮廓
- 不写 `path` 时行为与现在完全一致（等高 `rings`）

### 7.2 环间插值

`rings` 写 3 环但想要 12 环的细腻度时，加 `subdiv: 4`：环间用 Catmull-Rom 插值补足。
段数与环数同样不设上限。

### 7.3 改动点

| 文件 | 改什么 |
|---|---|
| `schema.js` | `loft` 增加 `path` / `subdiv` 字段归一化 |
| `scene.js` | `shapeGeometry` 的 loft 分支支持路径扫掠与插值 |
| `SKILL.md` | 补进 `loft` 的字段说明 |

### 7.4 验收

- 同一个 `rings` 加 `subdiv: 4` 与不加，轮廓走向一致、细分更多
- 沿 `line` 路径扫掠出的形体，截面尺寸沿路径按 `profile` 变化

---

## 8. 把三条约定写进注释与契约

**做什么**：三条约定代码里是对的，文档没写，外部接入会踩。写进 `schema.js` 顶部注释块和
`SKILL.md`（**以及** `web/domain/text-ai.js` 的 `model3d:` 模板，两份逐字节一致，见 5.1）。

### 8.1 三条原文

```
坐标与单位：米。Y 向上，模型朝 +Z。

fov 是竖直 FOV（three 约定），不是水平角。

rot 是度制，euler 序为 three 的 Rx·Ry·Rz。证据：`scene.js:22` 是 `new THREE.Euler(x*D2R, y*D2R, z*D2R, 'XYZ')`

scale 接受数组或单个数；0 会被换成 1（0 缩放的节点在 three 里等于消失且不可再选中）。
负数保留 —— 负缩放是镜像的一种写法。
```

### 8.2 验收

- `schema.js` 顶部注释块包含以上四条
- `SKILL.md` 包含同样的四条
- `skills/model3d/schema.json` 的对应字段 `x-help` 与之一致

---

## 9. 建模 AI 本身的改进

建模 AI 这一层（`web/model3d/ai.js` + `skills/model3d/SKILL.md`）底子不错：
流式渐进解析（边收边建、实时预览）、`noTools` 的纯数据通路、`reuse` 判定、
坏 op 跳过计数、`fallback:'model'` 的如实标记、`animSpecOf` 只认 AI 真写出来的字段。
下面七条是在这个基础上提质的。

### 9.1 复用清单带上结构摘要【P0】

**现状**：`ai.js` 的 `catalogText()` 每行只有 `库名 :: id（N 个零件）：note`。
而 `note` 是模型文档里的自由文本 —— AI 自己生成的模型 `note` 恒为空串。
所以 AI 判断「库里那个能不能用」时几乎只有名字可看。

**改法**：每行追加结构摘要（复用第 3 项的 `outlineOf`）：

```
- 默认库 :: 桌子（4 个零件）[ 桌面 box / 桌腿 box×4 / 花瓶 lathe ]
```

**验收**：库里有一个「四条腿的桌子」，用户说「来个能坐的桌子」，
AI 回 `reuse:{id:'默认库 :: 桌子', mode:'as-is'}` 而不是重新造一个。

### 9.2 加几何体检，坏了自动修并回灌【P0】

**现状**：`normalizeDoc` 只校验字段合法性（`size>0`、`fov` 在 0~180），不校验几何。
契约里写着「主体居中偏下、整体高度大约 1–3 米」「人物必须有落脚点」「别贴边别顶头顶脚」
—— **全是嘱咐，没有检查**。结果：零件悬空、穿模、主体出画幅、尺寸离谱，都要等用户看出来。

**改法**：新增 `web/model3d/lint.js`，纯函数，出问题**修**而不是丢：

| 检查 | 修法 |
|---|---|
| 零件悬空（y > 0 且下方无支撑） | 下落到支撑面 |
| 主体出画幅 | 按包围盒等比缩放 / 平移回画幅内 |
| 主体整体高度不在 0.5–4 米 | 等比缩放到范围内 |
| 单件尺寸离谱（> 20 米） | 记一条警告，不自动改 |

修完把「我改了什么」写进 `say`，明细带进下一轮提示词。

**验收**：AI 写出一个悬空的桌子，界面自动把它落到桌面上，`say` 里说明落到了哪。

### 9.3 丢零件的明细回灌给 AI【P0】

**现状**：`normalizeDoc` 遇到坏节点只丢那一个并 `dropped.bad += 1`。
**AI 自己不知道丢了什么**，下一轮可能引用一个已不存在的 id，
那个 op 被 `needScope` 拒掉 → 用户看到「这一轮既没有 ops，也没有新实体」。

**改法**：把 `dropped` 从计数升级成明细（节点 id / 名字 / 丢了哪几个字段 / 为什么丢），
写进下一轮提示词的一段「上一轮的问题」。

**验收**：AI 写错一个零件形状，下一轮的提示词里能看到「上一轮丢了 n-5（缺 size）」。

### 9.4 契约补一节「{animations}」【P1】

`SKILL.md:26` 有 `{animations}` 占位，`ai.js` 的 `animationText()` 也真的填了
「库里带动画的摆件（clip 只能从这里列出的名字里选）：- 文件：clip1 / clip2」，
但**契约正文里没有一节解释这一段是什么**（只有第 52 行半句「上面「库里有动画的摆件」里列出的名字」）。
AI 只能靠半句话推断。补一节写清格式与用法。

**两份都要改**：`skills/model3d/SKILL.md` 与 `web/domain/text-ai.js` 的 `model3d:` 模板（逐字节一致，见 5.1）。

### 9.5 AI 输出也稀疏化【P1】

**现状**：`ai.js` 的 `compactNode()` 已经把**喂给 AI 的**内容稀疏了
（省掉默认的 at / rot / scale / tone / clip*），**读侧这一步已经做了**。
缺的是另外两半：

- **AI 写回时**仍然写全字段（`fromModel:""`、`rot:[0,0,0]`、`scale:[1,1,1]`）
- **落盘时**仍然写全字段

**改法**：契约加一句「省略默认字段」，并让 AI 输出走一遍同样的稀疏化。
写回的 JSON 变小 → 解析更快、token 更省、落盘更小。

### 9.6 提示词长度保护 + 选中子树只给一遍【P1】

**现状**：`currentText()` 明确「不截断」。而且选中子树被**给了两遍** ——
一遍在 `nodes` 全量里，一遍在 `body.selected`。

**改法**：

- 选中子树只给一遍（全量里那份删掉）
- 超过阈值（按字符数）自动降级成大纲 + 选中子树
- 阈值写在 `ai.js` 顶部常量里，不做配置项

**验收**：选中子树在提示词里只出现一次；200 节点的场景提示词不爆。

### 9.7 让 AI 能自查构图【P2】

**现状**：`TextAI.chatStream(REG, sys, user, { noTools: true, images }, push)` —— `noTools: true`，
AI 只能交数据，看不见自己建的模型长什么样。
契约要求「主体居中偏下」这种构图判断，AI 只能盲猜。

**改法**：开一个受限工具回路，AI 写完可以调：

- `get_scene_bbox()` —— 当前场景包围盒
- `get_selected_bbox()` —— 选中子树包围盒
- `render_thumbnail()` —— 当前构图缩略图（回到浏览器渲染一次）

拿到后自己调 `at` / `scale`。本条改动最大，CSP 下要小心工具调用的回传路径。

---

## 10. AI 助手的完善

助手层（`web/features/chat.js` 3700 行 + `web/features/chat-tools.js` 2230 行）底子很硬，
下面七条是在这个基础上补齐，不是重写。

**已有的底子**（先说清楚，免得改坏）：

- TOOLS（约 30 个只读查询）与 ACTS（写入动作）严格分离 —— 「这一张表里全是 GET 与本机读，没有任何写入」
- 写入动作必须用户在卡片上点「执行」才真做；`autoRun` 只跳过那一下点击，校验与卡片照旧
- 工具结果有字数上限（`TOOL_OUT` 7000）与 token 预算（`CTX_ROOM` 20000）
- 上下文裁剪（`HIST` 14 条 / 每条 900 字）
- 查询卡住的兜底（`STALE_MAX` 2）
- 任务查询分档说清「本机没有记录」与「平台没有这条」
- 看图走 `visionAsync`，型号不支持识图时给具体原因
- 长任务三档提示（30 / 90 / 180 秒）、撤销窗口 5 秒
- 附件身份持久化；字节不在了就说「不在了」，让用户重新拖

### 10.1 助手进得了建模台【P0】

**现状**：助手的 ACTS 覆盖素材库（角色 / 场景 / 道具增删改）、导演台（分镜 / 候选 / 时间线 / 字幕 / 生成任务），
但**没有任何建模台相关的工具或动作** —— 搜 `建模|model3d|白膜|model.html` 在两份助手文件里零命中。
助手能 `go` 跳到建模台、能 `page_state` 读它的状态，但**不能改建模台里的东西**。

八页里唯一进不去的一页，恰好是 AI 建模的主战场。

**改法**：给建模台加一组 ACTS，并**直接复用 `web/model3d/schema.js` 的 `normalizeDoc` / `applyDocOps`** ——
白膜文档的形状与 op 词汇已经现成，助手只需要一层薄适配：

| 动作 | 作用 |
|---|---|
| `model_list` | 列白膜库 / 当前场景的实体 |
| `model_read` | 读某个实体的节点树（走第 3 项那种摘要） |
| `model_edit` | 对选中实体套 `applyDocOps`（update / add / remove / move / group / ungroup / cam / track / anim） |
| `model_new` | 新建一个白膜 |
| `model_add_to_scene` | 把白膜库里的一份加进当前场景 |

**验收**：在助手抽屉里说「把那个桌子改成四条腿」，助手出一张确认卡片，
点执行后建模台里的白膜真的变了 —— 不用切页面，也不用再对建模 AI 说一遍。

### 10.2 助手与建模 AI 共用一套 op 词汇【P0】

**现状**：建模台走 `TextAI.DEF.model3d` + `web/model3d/ai.js`（模型 → `model` / `ops`）；
助手走另一套（`TOOLS` / `ACTS`）。**两套提示词、两套输出契约、互不相通。**
用户在建模台说「把桌子改成四条腿」，和在助手抽屉里说同一句话，走的是完全不同的两条路。

**改法**：把建模的 op 词汇抽成一份**共享动作目录**，两边都用它：

- 建模 AI 学会助手那套「查状态 / 引用素材 / 看图」→ 建模时能先看看素材库有没有能复用的
- 助手学会建模那套 op 词汇 → 助手能改白膜（10.1 就是它的落地）

共享目录放 `web/domain/`，两边从同一份读，别各写一遍。

契约正文仍然有两份（见 5.1）—— 共享动作目录的用法说明要同步写进 `skills/model3d/SKILL.md`
与 `web/domain/text-ai.js` 的 `model3d:` 模板。

### 10.3 工具表从页面能力声明生成【P1】

**现状**：助手已经有 `uiInventory` / `findUI` / `zoneOf` / `caps` / `usableMap` 这套「页面能力声明」的基础设施，
但 `TOOLS` 与 `ACTS` 两张表**是手写的** —— 新增一个页面的能力，要同时改助手代码。

**改法**：每个工具自己声明三件事 —— 属于哪个能力域、依赖哪些页面能力、结果裁剪档位；
系统提示词里那份清单由声明拼出来（现在已经是「由这张表现拼」，把表本身也变成声明即可）。

### 10.4 兜底信息回流给模型【P1】

**现状**：`STALE_MAX = 2` 的兜底**只发生在代码层，不写进提示词**（注释里明说）。
所以模型不知道自己的查询卡住了 —— 它不会换个问法，也不会告诉用户「这个查询好像问不通」。

**改法**：兜底触发时给模型一句结构化反馈：

> 上一轮 `tasks` 查询连续两次无变化，可能问不通，换个问法或用 `task_detail`。

模型下一轮就能自己换路子，而不是让用户重问。

### 10.5 工具结果裁剪按工具分档【P1】

**现状**：`TOOL_OUT = 7000` 一刀切。但「任务列表」和「一个文件的正文」重要度完全不同 ——
列表被截掉一半用户看不出问题，文件正文截掉一半就直接答错了。

**改法**：每个工具在声明里带一个 `maxChars` 档位（大列表 2000 / 单文件 8000 / 逐行明细 20000），
`CTX_ROOM = 20000` 的 token 预算按轮次动态分配给本轮最相关的几个结果。

### 10.6 助手能看建模台的实时视口【P2】

**现状**：助手看图只能看图片文件（`lookAtImage` → `visionAsync`）。
建模台的实时构图看不到 —— 助手能评价「一张白膜图」，评价不了「建模台里现在这个构图」。

**改法**：建模台把视口出一张缩略图暴露给助手（与第 9.7 条给建模 AI 开的 `render_thumbnail` 同一套），
助手能对当前构图给意见。

### 10.7 跨会话的知识沉淀【P2】

**现状**：会话记录有（`CAP` 60 条 / 会话、40 个会话），但**跨会话不沉淀任何知识**。
用户教过助手的事（"我们习惯用哪一家"、"角色命名用中文两字"）关掉抽屉就没了。

**改法**：设置页已有「Skill 管理」，把「教过助手的事」沉淀成 Skill；
或者加一个轻量 `notes` 存储（跟着 Store 信封走，能云同步）。

### 10.8 验收

- 在助手抽屉里说「把那个桌子改成四条腿」，助手出确认卡片，点执行后建模台的白膜真的变了
- 用户在建模台说「素材库里有没有能用的桌子」，建模 AI 能查库并复用（依赖 10.2 的共享动作目录）
- 新增一个页面的能力，只改能力声明，不改助手代码
- 助手某个查询卡住时，它下一轮会换个问法，而不是让用户重问
- 一个 500 行的大列表查询，结果不再被 7000 字一刀切
- 助手能对建模台当前构图给意见

---

## 11. 新增 `更新.bat`：检测仓库更新并拉取

**做什么**：新增一个 `更新.bat`，检测 git 仓库有没有更新，有就拉；拉不动、冲突、失败时给明确提示和下一步命令。

### 11.1 现状

- 仓库有 remote `https://github.com/ycwba/imago.git`，分支 `main`，最新提交 `da77499`（2026-11-08，建模台 0.3.0）
- **工作区常态是脏的**（本次核查时是 46 个已修改 + 3 个未跟踪：大量 `web/model3d/*`、`tests/model3d-*`、`tools/vue-templates/model.html`）。数字会变，要点不是数量，是**「脏」是常态**
- `启动.bat` 里没有任何 git 逻辑；`launcher.ps1` 里的 `Update-Status` 是「更新启动器界面状态」，与仓库更新无关，别混淆
- `启动.bat` 有两条必须继承的硬契约：
  - `start ... -WindowStyle Hidden` —— 否则桌面上多一个控制台，关掉它是硬杀，服务成孤儿
  - `launcher.ps1` 的 size+SHA1 预解析缓存（印记在 `%TEMP%\imago-launcher-parse.key`），隐藏前不解析就「双击完全没反应」；**解析失败绝不写印记**

**工作区脏是常态**，不是异常 —— `更新.bat` 必须把它当常态处理，而不是假设干净。

### 11.2 命令

与 `启动.bat` 同风格：

```
更新.bat            检测 + 有更新就拉（默认）
更新.bat check      只检测不拉
更新.bat log        更新日志
更新.bat help
```

### 11.3 流程

1. **自检**：git 在不在、是不是 git 仓库、有没有 remote、分支是不是 `main`、工作区状态、代理服务在不在跑
2. `git fetch origin`（带超时，不挂死）
3. 比较 `HEAD` 与 `origin/main`：
   - 相同 → 「已是最新」退出
   - 本地落后 → 报「落后 N 个提交」，列出前 5 条的 `hash 日期 标题`
4. **拉之前的保护**（关键一步）：
   - 工作区脏 → **先 `git stash push -u`**（含未跟踪），pull 完再 `git stash pop`
   - `stash pop` 冲突 → **不吞掉**：打印冲突文件清单，**保留 stash 不 drop**，给出恢复命令
   - `git pull` 自身冲突（远端改了同一处）→ `git merge --abort` 回退，把冲突文件列出来
5. **拉完收尾**：
   - `package-lock.json` 变了才跑 `npm ci`
   - 跑 `npm run build`（模板预编译产物必须重新生成）
   - 服务在跑就重启
   - 打印这次更新了什么：`git log --oneline 旧SHA..新SHA`

### 11.4 冲突提示要做对

必须分清三种失败，**每种都给出下一步该敲什么命令**，不要只甩一句报错：

| 情形 | 提示要点 | 给用户的命令 |
|---|---|---|
| 拉取被拒（工作区脏且远端动了同样的文件） | 哪些文件挡路 | 已自动 stash，确认后可 `git stash pop` 取回 |
| 合并冲突（有冲突标记） | 冲突文件清单 | 已 `merge --abort` 回退，手动处理后再拉 |
| 依赖 / 构建失败 | 代码已更新但构建没过 | `npm ci` / `npm run build` 重跑命令 |

**绝对不做**：`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash drop`。
用户的未提交工作比更新重要。

### 11.5 落点

| 文件 | 改什么 |
|---|---|
| `更新.bat` | 新增。薄入口：自检 → 调 `update.ps1` → 出结果。编码 UTF-8 无 BOM + CRLF + `chcp 65001` |
| `update.ps1` | 新增。真正干活：fetch / 比较 / stash / pull / 冲突处理 / 依赖与构建收尾。编码 UTF-8 带 BOM + CRLF（PowerShell 5.1 要求） |
| `启动.bat` | 加一条 `update` 子命令转调 `更新.bat` |
| `launcher.ps1` | 图形启动器加一颗「检查更新」按钮 → 调 `update.ps1 -Check` |

### 11.6 验收

- 仓库干净 + 有更新 → 拉下来、依赖装好、构建产物重建、服务能起来
- 仓库脏 + 远端动了同样的文件 → **本地改动一个不少**，界面明确提示冲突文件与恢复命令
- 仓库脏 + 远端只动了别的文件 → 自动 stash / pull / pop 成功，本地改动还在
- 远端有合并冲突 → `git merge --abort` 回到干净状态，冲突文件列出来
- `npm run build` 失败 → 明确报「代码已更新但模板预编译失败」，给出重跑命令

---

## 12. `启动.bat` 与 `更新.bat` 的三档主题

**做什么**：控制台配色跟网页端对齐，三档 —— **日间 / 夜间 / 系统（默认跟随系统）**。

### 12.1 现状

`启动.bat:45-55` 已经有一套 ANSI 颜色：

```bat
set "ESC="
set "C0=" & set "CDIM=" & set "CT=" & set "CA=" & set "CG=" & set "CY=" & set "CR=" & set "CB="
set "USE_COLOR=1"
```

八个变量（默认 / 暗 / 标题 / 强调 / 绿 / 黄 / 红 / 蓝），Win10/11 认 ANSI，
老系统或 `WB_NOCOLOR=1` 自动降级为无色。

**但它是一套手写的固定配色**，跟网页端的主题没关系；而且 `WB_NOCOLOR` 只能「开 / 关」两档。

### 12.2 改法

1. **档位存哪**：`.env` 加一行 `WB_THEME=system`（`system` / `day` / `night`）。
   **键名与网页端统一用 `system`**（网页端 `dir_theme` 的第三档就叫 `system`），别写成 `auto`。
   `.env` 已经承载本机配置（`PORT` 等）且不进版本库 ✓
2. **三档**：`system`（跟随系统，默认）/ `day` / `night`
3. **怎么判系统档**：批处理读注册表
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` 的 `AppsUseLightTheme`
   （`0` = 深色，`1` = 浅色）。读不到就当浅色，不崩。
4. **控制台配色怎么切**：把现有 8 个颜色变量抽成 **day / night 两套**，按档位选一套。
   night 那套把强调色提亮一档、警告色避开刺眼的纯红。
   整屏底色用 `set "color=..."`（最省事，不用额外起 PowerShell 改 RawUI）。
5. **窗口标题**：用 `title` 命令写成「成像 · 夜间」之类，用户一眼知道当前档位
6. **`更新.bat` 同款配色**：更新过程信息密，夜间尤其重要（失败红字在白底上刺眼）
7. **切换方式**：改 `.env` 的 `WB_THEME` 后重跑；或给两个 bat 加参数
   `启动.bat theme night` / `启动.bat theme system`

### 12.3 落点

| 文件 | 改什么 |
|---|---|
| `启动.bat` | 颜色段拆成 day/night 两套；加 `WB_THEME` 解析；加 `theme` 子命令；`title` 设窗口标题 |
| `更新.bat` | 同款配色 |
| `.env` | 加 `WB_THEME=system`（默认值） |
| `.env.example` | 同步加一行说明 |

**注意**：`.env` 现有格式是 `KEY=VALUE` 无引号，加的时候别破坏它。

### 12.4 验收

- `WB_THEME=system` + 系统深色 → 控制台深色；系统浅色 → 浅色
- `WB_THEME=night` → 无论系统如何都深色
- `WB_THEME=day` → 无论系统如何都浅色
- 老系统读不到注册表 → 不崩，当浅色
- `WB_NOCOLOR=1` 仍然生效（优先级最高，直接无色）

---

## 13. 默认档改成「跟随系统」

**做什么**：把网页端默认的日 / 夜档从「浅色」改成「跟随系统」。三档本身**已经存在**，
这一项只改两处默认值。

### 13.1 现状：三档早就有了

| 位置 | 事实 |
|---|---|
| `web/shell-boot.js` | `var MODES = ['light', 'dark', 'system']`；`resolveTheme()` 把 `system` 解析成 `light` / `dark` 再写 `data-theme`；`mq.addEventListener('change', …)` 监听系统档变化 |
| `web/ui/ui.js` | `UI_PREFS.rows` 里 `dir_theme` 的 `opts: [['light','浅色'],['dark','深色'],['system','跟随系统']]`，`kind:'seg'`（设置页三段分段控件） |
| `web/sidebar.js` | 侧栏那颗按钮循环写 `dir_theme` 后调 `window.__themeApply()` |
| **默认档** | `shell-boot.js` 的 fallback 是 `'light'`；`ui.js` 的 `def` 也是 `'light'` |

**`data-theme` 永远只写解析后的 `light` / `dark`**（`shell-boot.js` 头注：「永远不写 system」——
样式按它取色，`system` 只是偏好层的概念）。这个设计是对的，别动。

### 13.2 只改两处默认值

| 文件 | 改什么 |
|---|---|
| `web/shell-boot.js` | `if (MODES.indexOf(mode) < 0) mode = 'light';` → `mode = 'system'` |
| `web/ui/ui.js` | `dir_theme` 那一行的 `def: 'light'` → `def: 'system'` |

老用户本地已经存了 `light` / `dark` 的**继续按原样生效**，只有「从没设过」的人走新默认。

### 13.3 一起要改的是判据，不是门槛

现有 e2e 判据（`tests/e2e/theme-modes.cjs` 等）多半假定默认是浅色。
默认档一改，**在系统深色的机器上跑判据会红** —— 这不是门槛太严，是判据的隐含前提变了。

两条做法，选一条：

- **判据里显式设定档位**：测配色与深浅之前先写死 `dir_theme`，不依赖默认值（推荐 ——
  判据本来就不该依赖「用户没设过」这个前提）
- 或新增一条「默认档 == system」的判据，别的判据继续显式设档

### 13.4 同步那条要分清

`web/domain/datasync.js:36,148` 说明 `dir_theme` 属于「用户调出来的界面」，跟数据文件走。

- **用户显式选的档位要同步 ✓** 这条不动
- **默认值不是用户偏好** —— 「从没设过」这件事本身不该进同步，换机器时新机器走自己的默认即可

### 13.5 验收

- 全新环境（本地无 `dir_theme`）打开页面 → 跟随系统当前档
- 手动选过浅色 / 深色的老用户 → 仍按他选的走，不受影响
- 系统切夜间 → 页面立刻跟着变（已有实现，改默认值后更要成立）
- `data-theme` 永远是 `light` / `dark`，不会写出 `system`
- 判据在浅色系统与深色系统两种机器上都绿

---

## 14. 首屏约束：现状与判断

### 14.1 仓库里没有「首屏字节」这条约束

找遍 `tests/`、`tools/`、`server/`，**没有任何脚本字节预算判据**。
存在的「首屏」门槛是三道数字，在 `tests/e2e/asset-requests.cjs`：

| 门槛 | 值 | 管什么 |
|---|---|---|
| `LIST_REQ_MAX` | 12 | 资产库首屏（画到第一张卡片为止）「取列表」的请求数 |
| `LOAD_ROUNDS_MAX` | 4 | 从首屏到数完的 load 轮数（首屏一轮 + 哨兵续拉 + 计数续翻） |
| `PICKER_MS_MAX` | 300 | 有缓存时选择器打开到「首屏可选」的耗时 |

这三道管的是**请求数 / 轮数 / 耗时**，不是字节。

### 14.2 「首屏不碰大脚本」是架构原则，不是数字门槛

- `web/boot-assistant.js`：AI 助手在**首屏收尾后空闲加载**（load 事件 + rIC，4s 兜底；
  `ai_chat_off` 命中就整个不下载）
- `AGENTS.md:84`：只在一页的 ESM 图里的东西，**首屏与开机预取都不碰它**
- `web/features/chat.js` 头注的 249 KB 教训：每次切页白下载白执行 249 KB 阻塞脚本，
  把 DOMContentLoaded（也就是外壳换页的时机）往后推 —— 所以它才被拆到 idle 加载

### 14.3 本方案一处都不用放宽

逐条核对新增代码落在哪：

| 新增 | 落在哪 | 碰首屏吗 |
|---|---|---|
| 助手加建模能力（10.1 / 10.2） | `web/features/chat-tools.js` | **不碰** —— 走 `boot-assistant.js` 的 idle 加载 |
| 助手看建模台视口（10.6） | 建模台自己的页面代码 | **不碰** —— 建模台是独立 iframe，不在外壳首屏 |
| 几何体检（9.2） | `web/model3d/lint.js` | **不碰** —— 同上 |
| 默认档改 system（13） | `web/shell-boot.js` 两行 | **不碰** —— 只改一个 fallback 常量，体积不变 |
| bat 三档主题（12） | `启动.bat` / `更新.bat` | **不碰** —— 独立进程 |
| `更新.bat`（11） | 独立进程 | **不碰** |

**结论：不用放宽。**

### 14.4 真要动门槛，改的是判据的隐含前提

第 13 项把默认档改成 `system` 之后，**在系统深色的机器上跑判据会红** ——
这不是门槛太严，是判据隐含假定了「默认是浅色」。
要改的是判据（显式设档），不是门槛数字。

### 14.5 验收

- 改完之后 `npm run test:all` 在浅色系统与深色系统两种机器上都绿
- 首屏三道门槛（12 笔 / 4 轮 / 300ms）仍然绿

---

## 15. 涂鸦标注 → AI 生成运镜

**做什么**：在建模台的三维视口上用一排工具涂鸦（画笔 / 箭头 / 圆 / 矩形 / 文字 / 橡皮），颜色可切。
标注锚在 3D 里，转视角不跑位；**涂鸦时照样能转视角、拖实体**。
涂完连同当前机位一起发给 AI，AI 据此生成机位轨道（推 / 摇 / 移 / 环绕）。

### 15.1 现状

- 建模台视口是 `host` 里一个 `<canvas class="mm-canvas">`（`view.js:50-51`），**上面可以叠一层 overlay**
- **gizmo 已经存在**：`view.js:69-70` 两个 `TransformControls`（`gizmo` 平移箭头 / `gizmoR` 旋转环）挂在同一个对象上，
  一个手柄同时画平移箭头与旋转环（`view.js:67`）；`view.js:79` 已有拖拽互斥（`draggingControls.size`）
- 工具条在 `web/pages/model.js:2175`，现成的类：`mm-tools-group` / `mm-tools-lab` / `ui-seg`（分段控件）
- 路径系统已存在，但**只服务节点轨道**：
  - `scene.js:348 setTrackPaths(stage, doc)` 用 `THREE.Line` 画**场景空间**的路径
  - `anim.js:79 samplePath(path, t, duration)` 支持 line / circle / rect / free
  - 机位轨道**是支持 `path` 的**（`sampleTrack` 的 cam 分支走 `samplePath`），
- 仓库里**没有涂鸦功能**（`overlay` 在本仓库指的是字幕轨，不是绘制层）
- AI 侧：`track` op 已支持 `{"op":"track","add":{…}}`，`of.kind==='cam'` 的轨道 AI **已经能写** ——
  缺的只是「标注」这个**输入通道**和契约说明

### 15.2 工具集与调色板

工具条浮在视口上，两排（照分镜师那套）：

| 排 | 内容 |
|---|---|
| 上排 | 调色板：红 / 黄 / 绿 / 蓝 / 白 / 灰 / 黑（+「当前颜色」指示） |
| 下排 | 选择（纯导航）· 画笔 · 箭头 · 圆 · 矩形 · 文字 · 橡皮 · ✓ 完成 |

每个工具画出来的东西都是**一种图元**，带类型、颜色、3D 锚点：

| 工具 | 图元 | 说明 |
|---|---|---|
| 画笔 | `path` | 自由折线，笔宽可调 |
| 箭头 | `arrow` | 直线 + 锥形箭头 |
| 圆 | `circle` | 圆弧（可作椭圆） |
| 矩形 | `rect` | 四段折线 |
| 文字 | `text` | 点击输入一段字，贴在 3D 点上 |
| 橡皮 | — | 点到哪条删哪条 |

### 15.3 颜色是语义（这条最值钱）

颜色不是装饰，是**给 AI 的结构化信息**。约定写进契约：

| 颜色 | 含义 |
|---|---|
| 蓝 | **相机路径**（这一条是机位要走的） |
| 黄 | **主体运动** |
| 红 | 要避开 / 别放这儿 |
| 绿 | 保留 / 重点 |
| 白 | 中性说明（配合文字标注） |
| 灰 / 黑 | 背景参考，AI 可以忽略 |

这样「用不同颜色画不同的东西」直接变成给 AI 的分层输入 ——
画一条蓝线 = 相机路径；画一条红线箭头指向某处 = 别让镜头对着那儿。

### 15.4 涂鸦与视口交互**不冲突**

**这是本项最容易做错的地方**：涂鸦层是**叠加**的，不能把视口的交互吃掉。

- 「选择」档 = 纯导航（转视角 / 平移 / 拖 gizmo），完全不画
- 画笔档下：**左键点在实体或 gizmo 上 → 让 gizmo 优先**（拖实体照常）；
  **点在空白处 → 才画**
- 中键 / 右键拖动**始终**是转视角与平移，不受当前工具影响
- 实现上跟 `view.js:79` 那套 `draggingControls` 互斥是同一个思路：
  先问「gizmo 命中了吗」，命中就交给它

### 15.5 3D 锚定

标注不是屏幕空间的浮层，是**锚在 3D 里**的（与 Blender 的 annotation 一个道理）：

- 画的时候取当前指针的射线，与一个**参考深度面**求交 → 得到 3D 点
- 参考深度：默认取「当前选中实体」的中心深度；没选中就取「当前机位到焦点的距离」
- 之后用 `THREE.Line` 画（与 `setTrackPaths` 同一套），**转视角后标注跟着转**，不会跑位
- 文字标注用 `THREE.Sprite` + canvas 贴图（不引字体依赖）

### 15.6 两种解释

| 模式 | 用户画的意思 | 变成什么 |
|---|---|---|
| `camera`（默认） | **镜头这么动** | 机位沿蓝色 path 平移（推 / 摇 / 移） |
| `subject` | **主体这么走** | 主体沿黄色 path 走，相机跟拍（target 跟住） |

**平移分量由程序算，旋转 / 缩放 / 时间分配由 AI 补。** 分工是关键：

- 程序能把屏幕点换算成「机位在垂直于视线的平面上的位移」—— 纯几何，AI 算不准也没必要让它算
- 「画一个圈 = 环绕」「画一条斜线 = 一边推一边摇」「箭头指哪 = 镜头推向哪」—— 意图理解，AI 干这个

### 15.7 喂给 AI 什么

```json
{
  "mode": "camera",
  "aspect": "16:9",
  "marks": [
    { "type": "path",  "color": "blue",  "pts": [[0,0,0],[0.4,0.3,0.6]] },
    { "type": "arrow", "color": "red",   "from": [1,1,0], "to": [1.5,1,0.4] },
    { "type": "text",  "color": "green", "at": [0.8,0.6,0], "text": "这里慢一点" }
  ],
  "camPath": [[0,0,0],[0.4,0.3,0.6],[0.8,0.55,1.0]]
}
```

- `marks` 给 AI 看**类型、颜色、位置、文字** → 它读**意图**
- `camPath` 是程序从蓝色 path 换算好的机位位移 → AI **照抄**，不让模型做三维换算

再连同已有的 `current`（含当前机位与轨道）、`aspect`、`anim.duration/fps` 一起给。

### 15.8 AI 产出什么

复用现成的 `track` op，**不需要新的 op**：

```json
{"op":"track","add":{"of":{"kind":"cam","id":"cam-1"},"keys":[
  {"t":0,  "at":[3.2,2.1,4.2], "target":[0,1,0],   "fov":35},
  {"t":1.2,"at":[2.7,2.3,3.6], "target":[0.2,1.05,0],"fov":33},
  {"t":2.4,"at":[1.9,2.7,2.6], "target":[0.5,1.15,0],"fov":28}]}}
```

契约里新增一节「涂鸦运镜」，写清：图元的类型与颜色含义、两种模式、`marks` 与 `camPath` 的分工、
以及「节奏（多快推、什么时候停）由你决定」。

### 15.9 落点

| 文件 | 改什么 |
|---|---|
| `web/model3d/view.js` | overlay 层与采集；`getMarks()` / `setMarks()` / `clearMarks()`；**pointer 分流**（gizmo 优先，其次画）；3D 锚定求交 |
| `web/model3d/scene.js` | 新增 `setSketchMarks(stage, marks)`（照 `setTrackPaths` 的 `THREE.Line` 画法）+ `screenToCamPath(marks, cam, aspect)` |
| `web/model3d/ai.js` | `vars` 加 `sketch`；把标注附进这一轮提示词；**标注不进 doc** |
| `web/pages/model.js` | 工具条加「标注」入口；浮出**悬浮工具条 + 调色板**（照图：上排颜色、下排工具、右下角 ✓） |
| `web/domain/text-ai.js` | `model3d:` 契约正文加「涂鸦运镜」一节（含颜色语义表）；`'model3d.json'` 占位符说明表加 `sketch` 一行 |
| `skills/model3d/SKILL.md` | **同源的第二份**，逐字节一致（见 5.1） |

### 15.10 机位 path 的朝向
机位轨道**本来就支持 `path`**（`sampleTrack` 的 cam 分支走 `samplePath`），别记反了。

缺的是**朝向** —— `sampleTrack` 的 cam 分支取了 `p.at` 却丢掉 `p.yawDeg`，
机位沿圆周走时镜头不跟着转。补法见 **16.2**（path 加 `look` 字段）。

**但仍然要让 AI 走这条路** —— AI 产出的应是**一条丝滑的样条 path**
（几何 + 速度 + 构图三件事都丝滑），不是把涂鸦点直接当路径用。怎么做见 **18**。
---

## 16. 动画轨道增强

现有轨道系统（`web/model3d/anim.js` 221 行纯函数 + `schema.js` 的轨道归一化）底子扎实：
path 给位移、keys 逐属性覆盖、关节轨道与姿势表落同一根 Bone、机位 follow 让位于 target 关键帧、
path 与 keys 可同时挂（先定走位再修某两帧）。
下面十处是补齐它。

### 16.1 轨道加 offset / speed / 自己的 duration【P0】

**现状**：**所有轨道都从 t=0 开始、都跑满整条时间轴**。

- `sampleTrack(track, t, duration)` 的 duration 一律取全局 `anim.duration`
- 没有`起点偏移`，没有`倍速`，没有`轨道自己的长度`

**后果**：

- 「先走两秒再转圈」做不到 —— 没有 offset
- 「一条轨道 2 秒走完、另一条 6 秒走完」做不到 —— duration 是全局的
- 「跟一条轨道快一点」做不到 —— 没有 speed

**改法**：track 加三个字段

```json
{ "id": "t-2", "of": { "kind": "node", "id": "n-3" },
  "offset": 2.0,      // 这条轨道从第 2 秒才开始
  "speed": 1.5,       // 倍速
  "duration": 3.0,    // 这条轨道自己的长度，缺省用 anim.duration
  "path": { "kind": "circle", "from": [0,0,0], "radius": 1.5 } }
```

落点：`schema.js` 的 `normalizeTracks` 加归一化；
```js
// anim.js：轨道自己的时间与时长
const off = Number(track.offset) || 0;
const sp  = Number(track.speed)  || 1;
const dur = Number(track.duration) || duration;      // 轨道自己的
const lt  = Math.max(0, (t - off) * sp);
const u   = clamp01(lt / dur);
```

注意`offset` 与现有`path`的`u = t / duration`语义要统一：
改成`(t - offset) * speed / duration`，否则`offset`与`speed`会互相打架。

### 16.2 path 加 look：机位沿路径走时朝向怎么办【P0】

**现状**（`anim.js` 的 `sampleTrack`）：

```js
if (of.kind === 'cam') {
  const out = { at: null, target: null, fov: null };
  const p = track.path ? samplePath(track.path, t, duration) : null;
  if (p) out.at = p.at;          // ← 取了 at，p.yawDeg 扔了
  …
}
// node 分支反而用上了：
out.rot = [0, p.yawDeg, 0];      // 人脸朝前
```

**机位轨道是支持 path 的**（别记反了），缺的是**朝向**：
机位沿圆周 path 走时，位置在绕圈，但镜头一直朝原 `target` 不动 —— 
这不是「环绕主体」，是「绕着圈看别处」。

**改法**：path 加 `look` 字段，三档：

| `look` | 含义 |
|---|---|
| `target`（默认给机位用） | 沿路径走，同时看向某个节点（写节点 id） |
| `heading` | 沿路径切线看（`samplePath` 已经算好 `yawDeg`，直接用） |
| `fixed` | 保持轨道自身的 target（= 现在的行为） |

node 轨道不受影响（它已经用 yawDeg 转朝向）。

### 16.3 path 与 keys 的叠加语义【P1】

**现状**（`anim.js`）：

```js
const useKeys = k && (!track.path || !keys.length || t >= keys[0].t);
```

逐属性覆盖是对的，但**时间上不是叠加**：有 path 的轨道，**过了第一帧就完全由关键帧接管**，
路径形状丢失。所以头注说的「先定走位，再修某两帧」在代码里其实是
「第一帧之前走路径，之后全靠关键帧」，中间不混。

**改法**：`keys` 加 `mode`：

```json
{ "mode": "override", "keys": [ … ] }   // 现状：接管
{ "mode": "offset",   "keys": [ … ] }   // 相对 path 的偏移量
```

`offset` 模式下，采样结果 = path 的位置 + 关键帧的偏移量。
做「沿路径走但整体偏高一点」「沿路径走但中途停一下」这类事，不用把路径整段重录。

### 16.4 motion 参数化【P1】

**现状**（`mannequin.js:181` 的 `gaitControls`）：
步频 **1.65 / 2.45**、臂摆 **26 / 48** 全是常量（注释：「与参考项目同一组常数」）。
只有 walk / run 两档，速度固定。

**改法**：`motion` 从字符串升级成对象（旧值继续认）：

```json
"motion": { "kind": "walk", "speed": 0.8, "stride": 1.0, "arm": 1.0 }
```

步频 = 基准 × speed，臂摆幅度 = 基准 × arm，stride 调步幅。
「慢慢走」「碎步快走」「跑但步子小」就都能表达了。

### 16.5 关键帧加 scale / visible【P2】

**现状**：`anim.js:18` 的 `sampleKeys` 只处理 `at / rot / pose / target / fov`。

- 「推近到脸」只能靠改 fov 或挪机位 —— **物体本身长大做不到**
- 物体「出现 / 消失 / 闪现」也做不了

**改法**：`keys` 加 `scale`（三轴，lerp）与 `visible`（bool，STEP）。

### 16.6 节点轨道加 follow【P2】

**现状**：机位有 `follow`（跟一个节点），**节点轨道没有** —— 只能从固定起点走。
「让 A 跟着 B 走」只能把 B 的轨迹手工复制过去。

**改法**：节点轨道加 `follow`（相对另一个节点），或 `path.followFrom`。

### 16.7 关键帧逐帧缓动【P2】

**现状**：`interp`（smooth / linear / hold）在**轨道级**，一条轨道里所有关键帧共用一档。

**改法**：`keys` 每帧可带 `ease`，覆盖轨道级默认。
「起步缓、中间匀、收尾顿」的质感差别就出来了。

### 16.8 solo：只看这一条轨道【P2】

**现状**：`enabled: false` 只能整条停用，没有「只看这一条」。
调一条轨道时其他都在动，看不清自己调的。

**改法**：track 加 `solo: true`，采样时只取 solo 的轨道（可多条）。

### 16.9 三层叠加的顺序要写死【P1】

**现状**：`rig.js:5` 写着「applyPose 每次先把关节复位到 base，再叠加这一轮的角度与位移」，
而 `mannequin.js:214` 的 `controlsOf` 叠的是「姿势表 + 步态 + controls」。
**姿势表、motion 步态、关节轨道三者能同时作用在同一个关节上**，但三者的先后顺序在契约里没写死 ——
顺序一变，结果就变。

**改法**：在契约里明确一条顺序并写进判据，例如：

> base 姿势 → 关节轨道的 rot（叠加）→ 姿势表的 pose（覆盖）→ motion 步态（叠加）

（具体顺序由项目定，关键是**写死并有判据**。）

### 16.10 轨道行的关键帧编辑【P2】

**现状**：建模台的轨道行在 `web/pages/model/dock.js`（`addTrack(kind)` 在 154 行；
底部有「节点轨道」「机位轨道」两颗按钮在 341-342 行；空态文案在 346 行）。
**增删关键帧、拖时间这些交互做到哪一步，这次没逐个看** —— 
要动关键帧粒度（16.3 / 16.5 / 16.7 都落在关键帧上），得先把这块摸清。

### 16.11 落点

| 文件 | 改什么 |
|---|---|
| `web/model3d/schema.js` | `normalizeTracks` 加 `offset` / `speed` / `duration` / `solo`；`normalizePath` 加 `look`；关键帧加 `scale` / `visible` / `ease` / `mode`；`motion` 接受对象 |
| `web/model3d/anim.js` | 轨道自己的时间与时长；`path` 的 `look` 分流；`keys` 的 `offset` 叠加模式与逐帧 `ease`；`scale` / `visible` 采样；`solo` 过滤 |
| `web/model3d/mannequin.js` | `gaitControls` 接受速度 / 步幅 / 臂摆参数 |
| `web/model3d/rig.js` | 三层叠加顺序固定成一条 |
| `web/pages/model/dock.js` | 轨道行显示 offset / speed / solo；关键帧编辑（视 16.10 的结论） |
| `web/domain/text-ai.js` + `skills/model3d/SKILL.md` | 契约正文加「轨道」一节（新字段的含义、叠加顺序、颜色语义）—— **两份逐字节一致**（见 5.1） |

### 16.12 验收

- 一条轨道 `offset: 2` 后，第 2 秒之前它不动，之后才动
- `speed: 2` 的轨道比同路径的轨道快一倍，且两者**在同一条时间轴上错开**
- 机位沿 circle path 走时镜头**跟着转**（`look: "heading"`），也能`look: "target"` 环绕某个节点
- `keys.mode: "offset"` 的轨道保留路径形状，只被关键帧做偏移
- `motion` 带 `speed: 0.5` 时步频是原来的一半
- 关键帧能改物体缩放与显隐
- `solo` 后只有被 solo 的轨道在动
- 关节轨道 + 姿势表 + 步态同时作用时，结果与判据里写死的顺序一致

---

## 17. 导演台与工程化改进

导演台已经按域拆得很细（`engine.js` import 了 27 个域模块，注释明写「按域**机械搬出**（内部保持命令式，`engine.js` 只留状态与接线）」）。
空间不在重构，在**几处文档与实现的漂移**和**跨 Skill 的重复**。

### 17.1 README 的「最多 50 步」是过时的【P0】

**现状**：`web/director/engine.js:264-268` 自己写着：

> 快照是整份工作区 JSON（含内联图片），必须限总量：以前无上限保留 50 份，大工程会吃掉上百 MB 内存。
> **两档上限都不在界面上**（README 与项目介绍曾写「最多 50 步」，实际是 **30 步 / 24 MB**）

实际值在 `engine.js:268`：

```js
const UNDO_MAX_BYTES = 24 * 1024 * 1024, UNDO_MAX_COUNT = 30;
```

**改法**：README 与产品介绍里的「最多 50 步」改成「**30 步 / 24 MB**」。

### 17.2 撤销的静默降级没告诉用户【P0】

**现状**：`engine.js:314-317` 有一条静默降级：

```js
if (json.length > UNDO_MAX_BYTES / 2) {
  undoSkipWhy = '这一份工作区太大（…，超过单份上限 …）';
```

单份工作区快照超过 **12 MB** 就不进撤销栈。用户按 Ctrl+Z 没反应，**界面上完全看不到原因**
（`undoSkipWhy` 只是存在变量里）。

**改法**：把 `undoSkipWhy` 露出来 —— 撤销按钮的 tooltip 或一行灰字。
用户宁可知道「这一版太大了不能撤销」，也不要以为撤销坏了。

### 17.3 Skill 正文副本改成构建期生成【P1】

**现状**：`web/domain/text-ai.js` 的结构是

```js
SKILL_CONTRACT: {
  video: 'polish.video', img: 'polish.image', audio: 'polish.voice', follow: 'polish.follow', …
}
```

键是**用途**，值是 **Skill id**。正文由 `web/ui/skills.js` 在启动时按已启用的 Skill 备进 `window.__skillBodies`；
**没备到就退回 `text-ai.js` 里的同源副本**。

于是每个 Skill 的正文有**两份**：

- `skills/<id>/SKILL.md`（用户可改）
- `web/domain/text-ai.js` 的 DEF 副本（退回用）

**13 个 Skill → 26 份正文**，`tests/e2e/smoke.cjs` 逐字节比守着。

**改法**：**别再手抄**。`tools/` 下已经有 `precompile-vue.cjs`（模板 → render 函数）这个先例，
加一个 `tools/sync-skill-contracts.cjs` —— **从 `skills/*/SKILL.md` 生成 `text-ai.js` 里那份副本**。
手抄 13 份逐字节相同的正文，迟早有一份漂。

顺带把「用户改了 Skill 文件但没刷新页面时用旧副本」这条降级路径在设置页说清楚。

### 17.4 导演台 9 个 Skill 共享一份词汇表【P1】

9 个 Skill 服务导演台：`board-assets` · `board-edit` · `line-write` · `split-follow` · `split-script` · `storyboard-frames` · `image-prompt` · `video-prompt` · `voice-script`。

它们必然共享一套词汇：**镜头 take / 候选 candidate / 素材 / 占位符 / 首帧 / 尾帧 / 草稿 / 选中**。
每个 Skill 各自解释一遍，就会出现「同一个词在两个 Skill 里含义不同」。

项目其实已经意识到这点（`web/director/engine/board-assets.js:207`：「判据是**声明**的，不写死在代码里」）。

**改法**：抽一份**共享词汇表**放在 `skills/` 下，9 个 Skill 引用同一份。改一个词只改一处。

### 17.5 `engine.js` 继续按域搬【P2】

已经拆了 27 个域，剩 5194 行，里面还没搬走的成规模的域：

| 分节 | 行号起 | 该去哪 |
|---|---|---|
| ④ AI 分镜：拆新 / 改现有 / 加镜头 | 698 | `script.js`（已存在，扩它） |
| 拆分镜之前 / 拆分镜素材落盘 / 接续生成 | 811–1137 | `split.js` |
| 候选卡片 | 1223 | `render.js` |
| 生成轮询引擎 | 1627 | `gen.js`（已存在） |
| 渲染左栏 / 中栏 | 1641 / 2174 | `render.js` |
| 视频模型与参数 | 2592 | registry 层（别硬编码在引擎里） |
| 润色指令 / 选画面 / 参考图 | 2973–3239 | `ref-plan.js`（已存在） |

**判据**：搬完 `engine.js` 只剩「工作区状态 + 事件接线 + 撤销日志」三样，**目标 < 1500 行**。
搬法照现有那套 —— 「按域机械搬出，区间内代码逐字保留，只有点名的几处引擎可变状态改经接口」，**别重写**。

### 17.6 生成依赖链可视化【P2】

**现状**：`web/director/engine/gen.js` 的状态机（todo / running / done / failed）+ 依赖式批量调度，
注释里的规则相当讲究：

- 「只有『正在跑』或『排进了这一批、马上要提交』的镜头才许等」
- 「等一个 todo 且不在批的镜头」→ 直接报错
- 「这一镜留下的是一条 failed 候选；只按『有没有非草稿候选』筛的话，这些镜头**永远**进不了 todo」

这些规则**只写在代码注释里**，界面上看不出「第 7 镜在等第 3 镜的第 2 个候选」。

**改法**：把依赖链画出来 —— 待生成列表里每条标出「等谁」，等到了打个勾。
「为什么不动」不可见，是生成类产品最常见的困惑来源。

### 17.7 设置项收进声明【P2】

**现状**：`web/pages/settings.js` **3958 行 / 212KB**，是全项目最长的页面文件（比建模台页面的 2741 行还长）。

「一份声明驱动」的机制已经在用了（`ui/ui.js` 的 `UI_PREFS`，助手与建模台都读它），
但 3958 行说明**还有大量设置项没进声明** —— 现在是「声明一部分 + 硬编码一部分」。

**改法**：剩下的收进同一套声明。收益是现成的：每项设置自动获得
「默认值 / 校验 / 说明 / 同步标记 / 助手可读写」五件事，不用再手写第五遍。

---

## 18. 运镜生成：丝滑的路径与镜头语言

**做什么**：让 AI 生成的运镜不是「几个生硬的 at 关键帧」，而是
**一条平滑的样条路径 + 跟得住的构图 + 有缓急的速度曲线**。

### 18.1 现状：机位轨道基本只能是关键帧，走的是直线段

- 机位轨道的 `keys` 逐帧 lerp（`sampleKeys` 的 at / rot / target / fov），**段与段之间是直线，转角是尖的**
- `path` 那条路是现成的：`free` 走 `catmull()` 的 Catmull-Rom（`anim.js` 里已有），`line` / `circle` / `rect` 是硬几何
- 但现状是：
  - **AI 产的是 keys，不是 path** —— 契约里机位轨道的默认写法就是「打关键帧」
  - `path` 的 `look` 缺失（见 16.2）→ 环绕做不出来
  - `samplePath` 的 `u = clamp01(t / duration)` 是**匀速** → 起停突兀

### 18.2 三件事做完才叫「丝滑」

| | 维度 | 现状 | 要什么 |
|---|---|---|---|
| 1 | **几何丝滑** | 关键帧直线段 | 机位沿**样条**走 |
| 2 | **速度丝滑** | 匀速 | 起停有缓入缓出 |
| 3 | **构图丝滑** | target 固定，主体在画面里漂 | target 跟住主体，主体基本不动 |

第 3 条最容易被忽略，但它是「晕不晕」的关键 —— 镜头跟着主体走、主体在画幅里的位置基本不变，观众就不晕。

### 18.3 几何：让 AI 优先产 path，keys 只用来「修」

**能力已经有了**（path 在轨道上，机位轨道也能用），缺的是**契约里告诉 AI 优先用它**。

契约里把机位轨道的推荐写法改成：

```json
{"op":"track","add":{
  "of":{"kind":"cam","id":"cam-1"},
  "path":{"kind":"free","closed":false,
          "pts":[[3.2,2.1,4.2],[2.9,2.3,3.6],[2.2,2.6,2.8],[1.6,2.7,1.9]]},
  "look":"target","lookAt":"n-1",
  "ease":"inout",
  "keys":[]}}
```

- `free` 走 Catmull-Rom（`anim.js` 已有的 `catmull()`）→ 几何天然丝滑
- `keys` 保留，用来「先定走位，再修某两帧」（配合 16.3 的 `offset` 模式）
- **给 AI 的硬约束**：**控制点给 4–8 个就够**，别给几十个关键帧

### 18.4 速度：ease

**现状**：`samplePath` 的 `u = clamp01(t / duration)` 是**匀速**。
匀速的推轨在观感上就是「机器在推」。

**改法**：path 与轨道都加 `ease`：`inout`（默认，起停缓）/ `in` / `out` / `linear` / `hold`。
和 16.1 的轨道级 `speed` 配合：**speed 决定快慢，ease 决定起停**。

### 18.5 构图：主体别乱跑

- 16.2 的 `look: "target"`（看向某个节点 id）→ 主体钉在画幅中心
- 更好：再加一个 `framing` 档 —— `center`（正中）/ `keep`（主体保持在原位，镜头跟）
  / `rule3`（三分法留余量，主体不顶在正中）

### 18.6 给 AI 一份镜头语言表

契约里现在**没有任何运镜词汇**，AI 只能凭感觉写坐标。加一张表：

| 用户说 | 参数 |
|---|---|
| 推近 / 拉远 | path 沿视线方向；或 fov 关键帧 |
| 摇（横摇） | path 沿水平弧；target 跟着走 |
| 移（平移） | path 沿水平直线，target 固定 |
| 跟 | `look:"target"` + path 与主体平行 |
| 升 / 降 | path 的 y 分量 |
| 环绕 | path circle + `look:"target"` |
| 手持 | path 的 pts 密一点 + 每点带小抖动（用 key 的 rot 加噪声） |
| 定格 / 停住 | path 只走一半 + keys 里 hold |

再加几条硬约束写进契约：

- **一次运镜只做一件事**（推 + 摇 + 环绕一起来会晕）
- **控制点 4–8 个就够**
- **主体在画幅里别超过 1/3 边长**
- **运镜有起有停**，别匀速到底

### 18.7 落地

| 文件 | 改什么 |
|---|---|
| `web/model3d/anim.js` | `samplePath` 加 `ease`；path 的 `look` 分流（16.2）；`free` 控制点下限 |
| `web/model3d/schema.js` | `normalizePath` 加 `look` / `lookAt` / `framing` / `ease`；track 加 `ease` |
| `web/model3d/ai.js` | 多给 AI 一份「当前可用机位与其现有轨道」，让它知道在改哪一条 |
| `web/domain/text-ai.js` **+** `skills/model3d/SKILL.md` | 契约正文加「运镜」一节：镜头语言表 + 上述硬约束 + 「机位优先给 path」—— **两份逐字节一致**（见 5.1） |

### 18.8 验收

- AI 生成一条环绕运镜：path 是 circle、`look` 是 target，**主体在画幅里基本不动**
- 同一条运镜，起停有缓入缓出（不是匀速）
- AI 给的控制点在 **4–8 个**之间（不是几十个关键帧）
- 「推近」这类指令，AI 产的是 path 而不是一串 fov 关键帧
- 一次运镜只做一件事（契约里写了，且判据能看出来）
- 「环绕」在 `look` 补上之后才真正成立（16.2）

---

## 19. 执行纪律：一份进度文档

**做什么**：这套方案有 18 项、15 个批次，跨建模台 / 助手 / 导演台 / 工具链四处。
动代码之前先建一份**进度文档**，逐项记录状态，每完成一项当场更新。

### 19.1 进度文档放哪、长什么样

- 位置：`docs/imago-改进进度.md`（与本方案同目录；入库时两份一起放进仓库的 `docs/`）
- 一行一项，编号与本方案一一对应（§1–§18）
- 状态四档：`○` 未开始　`◐` 进行中　`●` 已完成　`✕` 阻塞
- 每行记：编号 · 标题 · 批次 · 状态 · 一句话进展 · 最后更新日期
- 开头写：目标、来源文档、状态图例、**依赖关系**（哪一项卡着哪一项）
- 末尾两段：
  - **「已知问题与更正」** —— 实施中新发现的「文档与代码对不上」
  - **「实施日志」** —— 每次动手的日期 / 改了什么 / 怎么验的

### 19.2 更新纪律（这是关键）

- **动某一项的代码之前**，先把那一行改成 `◐ 进行中`
- **改完并验过之后**，改成 `● 已完成`，并写清「改了什么 / 怎么验的 / 有没有偏差」
- **发现新问题**（文档与代码冲突、依赖变了、方案要改）→ 追加到「已知问题与更正」，必要时回头改本方案
- **一项都没动就不要标完成** —— 这份状态要能当交接单用

### 19.3 为什么值得单独写一条

这套方案里已经出现过两次「文档说的和代码不一样」：

- README 写「最多 50 步」，实现是 30 步 / 24 MB
- 方案里写「机位轨道不认 path」，实际支持（只是朝向被丢）

两份文档不同步的时候，**进度文档就是把「谁在改、改到哪、验过没有」钉住的地方**。

### 19.4 验收

- 进度文档存在，18 项齐全，状态初值正确
- 每项动手前后状态都变过
- 每一项「已完成」都带验证方式
- 「已知问题与更正」区记着实施中新发现的冲突

---

## 批次与顺序

| 批次 | 内容 | 依赖 |
|---|---|---|
| **B1** | 第 1 项 灯光实体化（含 AI 控制） | 无 |
| **B2** | 第 4 项 文档稀疏化、第 9.5 条 AI 输出稀疏化 | 无 |
| **B3** | 第 3 项 AI 读侧稀疏化、第 9.6 条长度保护 | B2 |
| **B4** | 第 5 项 契约同步 + Schema + 迁移器、第 9.4 条补 `{animations}` 一节 | B1、B2（格式定了再发布） |
| **B5** | 第 2 项 白膜库语义索引 | B4（索引按稳定 schema 建）、B3（`outlineOf`） |
| **B6** | 第 6、7、8 项 阵列原语 / loft 扫掠 / 约定文档化 | 无 |
| **B7** | 第 9 项 建模 AI 提质 | B3（`outlineOf`）、B2（稀疏化） |
| **B8** | 第 10 项 助手完善 | B4（共享动作目录跟着契约走）、B1（`light` op 进共享目录） |
| **B9** | 第 13 项 默认档改跟随系统 | 无（三档已存在，只改默认值） |
| **B10** | 第 12 项 bat 三档主题 | 无（与网页端各自实现，键名统一用 `system`） |
| **B11** | 第 11 项 `更新.bat` | 无（独立） |
| **B12** | 第 15 项 涂鸦生成运镜 | 无（AI 侧复用现成的 `track` op） |
| **B13** | 第 16 项 动画轨道增强 | 无（采样层是纯函数，改动集中） |
| **B14** | 第 17 项 导演台与工程化改进 | 17.1 / 17.2 立刻可做（一条 README + 一个 tooltip） |
| **B15** | 第 18 项 运镜生成增强 | 16.2（look）、16.1（speed / offset） |

B1 与 B2 并行，都是纯增量。B1 完成后文档才自足，B3 之后提示词成本才降得下来。

---

## 附录：改前的基线数据

做验收时拿这些数做对照。

| 项 | 值 |
|---|---|
| 4 个图元的白膜文档体积 | **4.7KB**（节点样板字段占约四成） |
| 每个节点当前明写的默认字段 | `fromModel:""` `rot:[0,0,0]` `scale:[1,1,1]` |
| 出图分辨率 | 1280×720（16:9） |
| 出图耗时 | 秒回（浏览器内编码） |
| AI 提示词里的当前场景 | 完整节点 / 机位 / 轨道 |
| 灯光装置位置 | `scene.js:181-207`，硬编码 |
| 模型文档迁移器 | 无 |
| AI 侧现状 | `compactNode()` 已把**读侧**稀疏化；**写侧与落盘侧**未稀疏 |
| 选中子树喂几遍 | **两遍**（`nodes` 全量一份 + `body.selected` 一份） |
| AI 几何校验 | 无。只查字段合法性，不查悬空 / 穿模 / 出画幅 / 尺寸 |
| 复用清单内容 | `库名 :: id（N 个零件）：note`，而 AI 生成的模型 `note` 恒为空串 |
| `model3d.json` | **不是文件**，是契约的 key（frontmatter 的 `contract:` 说的是「用哪份契约」） |
| 涂鸦功能 | 无。gizmo 已有（`view.js:69-70` 两个 TransformControls，`view.js:79` 有拖拽互斥）；`overlay` 在本仓库指字幕轨 |
| 契约正文份数 | **两份**（`skills/model3d/SKILL.md` + `web/domain/text-ai.js` 的 `model3d:` 模板），逐字节判据 `tests/e2e/smoke.cjs` 守着 |
| 契约注册表 | `web/domain/text-ai/contracts.js`（不是 `web/domain/contracts.js`） |
| 占位符说明表 | `text-ai.js:626` 的 `'model3d.json': [...]`，加占位符要同步这张表 |
| 属性面板 | `web/pages/model.js` 137KB + `web/pages/model/dock.js` 18.5KB，**拆成两处** |
| 节点 rot 应用 | `scene.js:22` `new THREE.Euler(x*D2R, y*D2R, z*D2R, 'XYZ')` —— 度制 + three 序，确认 |
| `.data/` 已占用 | `cache` / `local-assets` / `models`（Whisper 权重）—— 索引要用 `.data/model-index/` |
| 撤销上限 | `engine.js:268` **30 步 / 24 MB**，单份快照 > 12 MB 不进撤销栈（静默）；README 写的是「50 步」—— **过时** |
| Skill 正文份数 | **两份**（`skills/<id>/SKILL.md` + `text-ai.js` 的 DEF 副本），13 个 Skill = 26 份，逐字节判据 `tests/e2e/smoke.cjs` |
| 导演台域模块 | `engine.js` 已 import **27 个**域模块，自身 5194 行（目标 < 1500） |
| 设置页 | `web/pages/settings.js` **3958 行**，全项目最长的页面文件 |
| 动画轨道 | `anim.js` 221 行纯函数。**机位轨道是支持 path 的**（`sampleTrack` 的 cam 分支走 `samplePath`），但**朝向被丢**（取了 `p.at` 没取 `p.yawDeg`）；轨道无 offset / speed / 独立 duration；`motion` 步频写死 1.65/2.45 |
