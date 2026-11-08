# 变更记录

版本号以 `package.json` 的 `version` 为唯一真相；本文件按批次记「改了什么 / 影响什么 / 要不要重打基线」。
提交历史里的 C / S / F / B / G 是批次代号，不是版本号。

## 0.3.0 — 2026-11-08

建模台 P7：把驱动层从「程序化关节角」扩成**标准骨骼通道**——人台关节由 `Group` 换成 `Bone`（结构级骨骼化，仍刚性绑定、不做蒙皮），导入的 FBX / GLB 保留自带 `animations` 并用 `AnimationMixer` 播出，任意节点获得**子关节轨道**，AI 提示词能写 `动画=` / `关节=` 并在生成时注入「库里有动画的摆件清单」。

- **人台骨骼化，视觉零变化**：`scene.js` 的 `makeJoint` 由 `new THREE.Group()` 换成 `new THREE.Bone()`，肢体网格仍是关节的硬绑定子节点（权重恒 1，没有 `Skeleton`、没有蒙皮）。`Bone` 与 `Group` 都是不渲染的 `Object3D`，渲染器只投影 `isMesh/isLine/isPoints/isSprite`，人台渲染路径里没有一处读 `.isBone`——所以这一换逐像素不变。关节自己记住 `baseRot`（基座角度）/ `baseAt`（基座位移）/ `limitDeg`（限位），子关节轨道与姿势写回都从这三个值起步。
- **写回只有一处**：新增 `web/model3d/rig.js`，角度（度）→ 关节四元数的换算只在 `quatOfDegrees` 一处；`applyPose` 每次先把每个关节复位到 base 再叠加这一轮的角度 / 位移并按限位夹取，子关节轨道不会把上一帧的增量攒起来。`jointsOf(content,id)` 返回的 Map 同时认路径（`torso/leftShoulder`）与关节名（`leftShoulder`），`registerJoint` 把两种键落到同一个 Bone。姿势 / 步态算法一行没改（正弦相位那套保留，比 clip 更省内存且参数可调），`mannequin.js` 只算角度。
- **导入件 clip 播放**：`loader.parseBytes` 保留 `gltf.animations` / `fbx.animations`（OBJ 恒空），缓存从 `Object3D` 改成 `{ proto, clips, bones, note }`；克隆一律走 `SkeletonUtils.clone`（普通 `clone(true)` 会共享同一个 `Skeleton`，两个实例互相覆盖骨骼矩阵）。新增 `web/model3d/clip.js`：`clipOf` / `clipNamesOf` / `loopOf` / `compileGait` / `mixerFor` / `bindClip` / `applyClip`。**只 `mixer.setTime(at)`、不 `mixer.update(dt)`**——按 dt 累加会与墙钟漂移；`local=(max(0,t)+offset)*speed`，循环取 `local % dur`，`once` / `hold` 夹到 `min(dur, local)`，播完按 `local >= dur` 判（不靠 `finished` 事件，出片不跑事件循环）。`setTime` 之后必须 `group.updateMatrixWorld(true)`，否则画出来的是上一帧的骨骼。
- **唯一时间源**：白膜时间轴（`doc.anim.duration` / `fps`）是唯一时间源，人台关节表与导入 clip 共用同一条 `playT`、同一个播放循环（`view.js` 的 `tick`）。`applyTime` 顺序：节点位姿 → 子关节（`rig.applyJoints`）→ 导入 clip（`mixer.setTime`），最后刷世界矩阵。`rebuild` 后重绑 mixer 并复位到 `playT`（不重绑每帧跳回绑定姿势）；`grab()` 出图 / 出片渲前同步 `setTime`，每一帧都是「这一刻」。
- **子关节轨道**：`anim.tracks[]` 新增可选 `joint` 字段（子节点路径，如 `torso/leftShoulder`，最多 6 段）；空 = 驱动整个节点（现状），写路径时只转那一个关节，`motion` / `path` 对它无效。`jointPathOf` 下钻上限 6 层、防环，找不到就 `dropped.anim += 1` 跳过。一个 track 一个 joint（不做多关节批量），轨道总数上限 60 不变。
- **数据契约（全部可选，向后兼容）**：asset 节点新增 `clip`（string≤40，空 = 停在绑定姿势）/ `clipSpeed`（0.1–4，默认 1）/ `clipLoop`（`loop` / `once` / `hold`，默认 loop）/ `clipOffset`（0–60 秒，默认 0，让同一模型的两份错开演）；`normalizeDoc` 缺省 `''/1/'loop'/0`，**不动文件版本号**，旧 `.json` 直接打开就是静态摆件，行为与改前完全一致。
- **上限闸**：同时播 clip 的导入件上限 **16**（`LIMITS.riggedAssets`），第 17 个降级为静态并记一笔「带骨骼的摆件超过 16 个，后面这些只按静态显示」落到状态行；`SkeletonUtils.clone` 成本跟骨骼数线性相关，超限不硬撑。`disposeContent` 只 dispose mixer 与自建几何，不碰共享 `Skeleton` / 骨骼几何（随手 dispose 第二次重建就黑屏）。
- **界面**：摆件卡给 clip 下拉（文件自带 clip 名 + 「无」）/ 速度数字 / 循环三选 / 偏移数字；文件没动画时显示一行灰字「这个文件里没有动画」而不是把下拉藏起来（藏起来用户会以为坏了）。时间线给 clip 轨道画一条色带（宽度 = clip 时长 / 时间轴时长，循环满带、once 按播完点截断）；对象树带动画的摆件加一枚小喇叭图标（`clip` 非空才显示）；`once` 播完状态行写「「…」的动画已播完（N 秒）」，不弹窗。
- **AI 契约**：`TextAI.DEF.model3d` 加 `动画=` / `速度=` / `循环=` / `偏移=` / `关节=` 语法段 + 约束（`clip` 只填清单里列出的名、`joint` 只填人台真有的关节路径，清单里没有的不要编）；`skills/model3d/SKILL.md` 同步，逐字节一致（`smoke.cjs` 守）。生成前把「库里有动画的摆件」拼进提示词（按文件名 + clip 名，**≤20 条、单条 ≤60 字符**，只从这次会话已解析过的文件来、不在生成前扫盘），清单为空时整段不出现（不占 token）。
- **判据**：新增 `tests/model3d-rig.mjs`（关节表双键 / 角度→四元数 / 限位夹取 / 子关节叠加）与 `tests/model3d-clip.mjs`（clip 清单 / 步态编译 / mixer setTime 采样后骨骼矩阵变化 / `SkeletonUtils.clone` 后两实例骨骼互不影响），登记进 `tests/all.cjs`；`model3d-schema` / `model3d-anim` / `model3d-dsl` 补 clip 四字段与 joint 通道用例。
- **vendor 前置说明**：`tools/vendor-three.cjs` 给 `SkeletonUtils.js` 补一行「已收」注释（0.187 的 GLTFLoader 本就要它，`loader.js` 直接 import 做蒙皮原型克隆）——它是 P7 的前置，不是新增依赖；首屏一个字节都不加（文件都已在 vendor 里，只在 heavy 页按需加载）。

**明确不做（写明理由，避免以后被接回来）**：

- **真 `SkinnedMesh` 蒙皮 / 自动权重**：白膜是 720p 灰阶参考图，胶囊关节处的刚性断裂在这个尺度上几乎不可见；代价却是「直接改数字」这条核心竞争力崩掉（改身高 / 肩宽要把尺寸烘焙进网格并重算权重，秒级重建从毫秒变「重新生成网格」），且 AI 写不出顶点权重。留到白膜升级成彩色 / 写实渲染那一期再说。
- **骨骼编辑 UI**（增删骨 / 改层级 / 改 bind pose）：那是 DCC 的活，建模台定位是「排布 + 走位」，不是绑骨工具。
- **clip 重定向**：不同骨架共用一套 clip 需要标准骨架（如 Mixamo 命名），本期只播原文件自带的 clip。
- **IK / 物理 / 布料**：超出白膜参考的范围。
- **服务端转码**：出片仍是浏览器内 mediabunny 直出。

影响：新增四个可选字段与一个可选 `joint`，不动文件版本号、不需要重打数据基线（旧 `.json` 缺省即静态摆件）；`AGENTS.md`「不支持骨骼」改口径为「参数化骨架 + 导入 clip 播放」、公共层清单加 `rig.js` / `clip.js`，`README` 目录树补两个新文件。

浏览器实测（headless Chrome + SwiftShader，隔离探针实例；临时把 `scene.js` 的 `Bone` 换回 `Group` 跑对比，跑完按原字节还原、sha 复核一致）：

- **人台视觉零变化（硬标准）**：Bone 基线五帧前景像素 64032 / 62443 / 76726 / 89307 / 85628（人台真的画出来了），Bone↔Group 五帧（0 / 0.7 / 1.4 / 2.1 / 2.8 秒）逐像素最大通道差 **0**（阈值 ≤1）。
- **导入件播放**：UI 导入带两条 clip（swing / turn）的 `.glb` → 下拉列出 `["","swing","turn"]`、色带 100% → 选 swing 拖动差异 2.41% / 播放差异 1.80%（骨骼真的动）。
- **两份互不串**：同一文件两份、只换右边那份的 clip → 左半差异 0.000% / 右半差异 4.512%（`SkeletonUtils.clone` 隔离）。
- **倍速**：0.5 / 1 / 2 三档色带均 100%、相邻帧差异 1.08% / 1.59%、质心 x 625 / 613 / 599（同一时刻速度越大越接近末帧）。
- **once 停末帧**：clip 2 秒 / 时间轴 4 秒 → 色带 50%，拖到 t=3 状态行「「a4」的动画已播完（2.0 秒）」，末帧之后（t=3↔t=4）差异 0.000%。
- **子关节轨道**：给 `torso/leftShoulder` 打两帧 → 整体差异 1.42% / 下半屏（腿）差异 0.000%（只有那条胳膊动）。
- **出图 / 出片是「这一刻」**：静帧 t0↔t1.5 差异 2.57%；3 秒 MP4 视频帧 0.05↔1.5 差异 2.55%，视频 @1.5 与静帧 @1.5 IoU **0.993**（不是绑定姿势）。
- **老文件 / 超限**：老 `.json` 打开动画徽标 0 / clip 行数 0 / 播放 700ms 差异 0.000%（静态如常）；塞 17 个带骨骼摆件 → 第 17 个降级静态、状态行「带骨骼的摆件超过 16 个，后面这些只按静态显示」。

## 0.2.5 — 2026-11-08

相机标识加开关。

- **工具条多一颗「相机标识」toggle**（摄像机图标，在描边右边）：关掉就整个视锥不画，`aria-pressed` 跟着变，状态行回一句「相机标识：显示 / 隐藏」。
- **它是编辑辅助，所以不进模型文件**：开关存在页面偏好（`localStorage: sk_model_rig`），导出的 `.json` 里没有这个字段，别人打开你的模型不会被你的显示习惯影响。这一点与「网格 / 地面 / 描边」不同——那三个是构图的一部分，`doc.scene.view` 里本来就有。
- **可见性 = 开关 && 导演视角**：`view.js` 新增 `syncRig()`，`setDoc` / `setViewMode` 都走它；机位视角下即便开关是开的也不画（那套线正好糊在画面中央），出图 / 出片仍由 `grab()` 强制摘掉。
- 浏览器实测：导演视角 152 个「紫蓝线」采样点 → 关掉 0（`aria-pressed=false`、`localStorage=0`）→ 刷新页面仍是关（记住）→ 再开回 152 → 切机位视角 0。

## 0.2.4 — 2026-11-08

建模台：导演视角里画出了**机位相机**（视锥标识）。

- **能看见了**：`scene.js` 的 `createStage` 现在一并建出机位相机 `camC` 与视锥标识 `rig`（`THREE.CameraHelper`）。以前 `camC` 只当渲染相机用、从没进场景，所以「机位在哪、朝哪、画幅多大」只能切到机位视角凭感觉，或读面板里那六个数字。
- **锥体用影子相机画**：`rigCam` 与真机位同步位置/朝向/fov/画幅，但近远平面压到 **0.3 / 2.2 米**。按真机位那台（0.1~100）画会拉出一百米长的线；5 米也横穿主体。`updateCameraRig(stage, cam, aspect)` 是唯一同步入口，`applyCamera`（改机位）、`setAspect`（换画幅）都走它。
- **配色**：`CameraHelper` 默认是橙/红/蓝的霓虹线，白膜里统一改成调色板的 `SELECT` 强调色、不透明度 0.55 —— 看得见但不抢戏。
- **三条隐藏规则**：机位视角里不画（`setViewMode` 与 `setDoc` 都按 `mode` 设 `rig.visible`）；**出图 / 出片时临时摘掉**（`grab()` 里连选中框一起隐藏，渲完还原，否则交付物里会多一个线框）；卸载时释放 helper 的几何与材质。
- 浏览器实测：导演视角画布里「紫蓝线」采样 131 点 → 切机位视角 0 → 切回 131；出图 PNG 里 0（交付物干净）。

影响：不动数据形状、不动契约、不需要重打基线；`scene.js` 的 `createStage` 返回值多了 `camC / rig / rigCam / rigHelper` 四个字段（只有 `view.js` 用）。

## 0.2.3 — 2026-11-08

建模台：工具条补齐取景与地面开关；「角色」这个概念换成**实体**，任意实体都能隐藏 / 锁定。

- **工具条**：在「网格 / 描边」旁补了**地面**开关（`view.ground`，以前只能在 `doc` 里写），并新增**取景**三档 —— 近景（对上半身，不切头）/ 中景（整体装进画面）/ 全景（再退一档）。实现是 `view.js` 新增的 `frameTo(kind)`：与 `fit()` 同一套包围盒，只是「看哪里」与「退多远」不同，按一颗键就在三种常用景别之间跳，不用自己拖到合适为止。
- **实体化**：右栏「对象树」改叫**实体**，每行给中文类别徽标（组 / 图元 / 人台 / 群像 / 摆件 / 引用）——人台不再被当成特殊品类叫「角色」，一切进场景的东西都是实体。
- **隐藏 / 锁定对任意实体一视同仁**：树里每行两枚小按钮（眼睛 / 锁），属性面板顶部也有「显示」「锁定」两个开关。
  · **隐藏**只影响渲染（`scene.js` 早就认 `visible === false`，只是一直没有入口），实体还留在树里、面板里改回来即可；
  · **锁定**只影响交互：视口拾取跳过它（`view.js` 的 raycast 按 `findNode` 查锁）、选中时不挂变换手柄、数值框只读；
  · 隐藏的行在树里压暗、锁定的行锁钮高亮，不用点开面板就知道状态。
- **命名不再打架**：工具条那三档是「取景」（改导演相机），属性面板里那组是「机位预设」（改 `doc.scene.camera`，机位视角用的那台）——原来两边都叫「近景/中景/全景」，现在工具条带「取景」小标签、面板改叫「机位预设」。
- **判据**：`tests/model3d-scene.mjs` 加一组（43 → 48 项）：隐藏的实体建出来不可见但仍留在场景树里、`locked` 原样保留且不影响外观。顺带把 `view.frame` 改名 `frameTo`（与 `server/app.js` 的 `frame` 撞名，dup-guard 抓到了）。

影响：不改任何数据形状（`visible` / `locked` 本来就在 schema 里，缺的只是入口），不需要重打基线。浏览器实测：隐藏「立柱」后画布非背景像素 253 → 190、行变暗、眼睛变闭眼；锁定「主角」后点选到它、`at.0` 输入框 `disabled`；取景近景/全景的非背景像素 561 / 136（同一画面）。

## 0.2.2 — 2026-11-08

建模台生成时**看得见 AI 正在写什么**。

- **流式回显**：`web/model3d/ai.js` 的流式回调多交一份原文（`onText(buf, nodeCount)`，每个 chunk 一次），右栏 AI 面板里因此多了一块：AI 说的那一句（`say`，逐字长出来、带闪块光标）+ 一行进度（`已收 N 个零件 · x KB`）+ 原文尾巴（等宽、低对比、只留最后 480 字并自动滚到底 —— 看的是「在动」，不是读 JSON）。收完把这句话留在面板上作「上一轮：…」。
- **只刷新这一块**：`paintStream()` 只改那三行字，且 60ms 合一次 —— 整块 `paintSide()` 重画会把输入框重建掉，用户正补一句话时焦点会跳走。切页 / 卸载时把定时器停掉。
- **顺带修掉两处旧账**：`st.aiText` 原来是个从没被赋值的死字段（面板里那段 `st.aiText ? …` 永远不生效），现在收的是上一轮的 `say`；`onSay` 原先写 `st.note` 并整块重画右栏，改成只更流式块，底部状态行改由 `note('正在生成…')` / 收尾时的 `note('建了 N 个零件')` 负责。

影响：不动数据形状、不动契约、不需要重打基线；样式全走令牌（`--panel2` / `--txt` / `--font-mono` / `--dur-800` / `--dur-280`）。浏览器实测（stub 掉 `chatStream`，10 字/45ms 推）：`say` 依次为「正在想…」→「先摆一个方台，再立一根柱」→「…柱子」，进度 0→1→2 个零件、原文长度 0→20→40→…单调增长，收尾面板留「上一轮：…」，视口里方台与立柱随节点到位出现。

## 0.2.1 — 2026-11-08

建模台两处「改了不生效」的修补。

- **置脏必须连着一帧**：`web/model3d/view.js` 的 `markDirty()` 原来只把 `dirty` 立起来、不排 rAF，而 `setDoc / rebuild / applyCamera / setSelection / setAspect` 全都只调它 —— 于是导入摆件、换画幅、选中之后画布停在旧帧，直到用户碰一下视口才更新。表现就是「导入的 OBJ 明明画了却看不见」：`renderer.info` 的三角形数确实涨了（draw 已发），但逐像素比对整张画布零差异，因为读到的一直是重绘前的旧帧。现在 `markDirty()` 顺手 `kick()`（kick 自带「已在排 / 已卸 / 不可见」三重闸，闲时零帧的性质不变），`resize()` 里那句多余的 kick 一并去掉。
- **出图结果区没有宿主**：`paintResult()` 找 `[data-r="mmResult"]`，模板里从来没有这一格，于是「刚出的这一份：下载 / 回传工作台 / 回传导演台」三颗按钮从未渲染过，`handBack` 也就无从点起。模板在轨道坞下面补了 `.mm-result` 宿主，空着时不占高度（`.mm-result:empty { display: none }`），出过东西才让出一条；样式只用令牌。

影响：不动任何数据形状，不需要重打基线；模板改了，`npm run build` 要重跑一次（生成物已同步）。浏览器实测：导入 `.obj` 后静置 1.5 秒，墙自己出现在画布上（1901 个墙色采样点）；出图 182,949 字节落库；出片 3.00 秒 avc1 MP4（88 KB）；工作台 → 建模提示词原样带入，建模 → 回传工作台走到 `refIntoSlot`；全景图画幅内像素由天空色变橙、清空后复原。

## 0.2.0 — 2026-11-08

第八页「建模台」：一句话让文字 AI 直接写出一棵**参数化零件树**（不是 text-to-3D 服务），流式接收、边收边在 three 视口里长出来；模型存成库根下的真文件、按组管理；随时把当前机位渲成白膜图片或白膜动画 mp4，落进本机资产库；并能从工作台「润色」旁那颗「建模」带提示词进来、出图后回传给工作台 / 导演台当参考素材。

- **three 落地走脚本、不走手抄**：`tools/vendor-three.cjs`（幂等，`--force` 重取）从 5 个入口（`OrbitControls` / `TransformControls` / `GLTFLoader` / `OBJLoader` / `FBXLoader`）递归解析 import 链，把 `from 'three'` 改写成 `./three.module.js`、其余相对路径压平，连同 `build/{three.module.js,three.core.js}` 落到 `web/vendor/three/`（12 个文件 · 2.6 MB）；MIT 许可随包为 `three.LICENSE.txt`。上游加一个依赖，重跑脚本就跟着走。没有 import map（CSP 拦 inline script），所以裸说明符必须在落地时改写 —— 这是 vendor 这一步的唯一理由。
- **首屏一个字节都不加**：three 只在建模台的 ESM 图里；路由表给这一页加了 `heavy: true`，开机那串空闲预取跳过它（把 2 MB 拖进后台预取会把「资源静默窗口」一路推后，TTI 从 2.2 秒涨到 3.65 秒 —— 实测），悬停侧栏 / 真点进来时照常提前取。`tests/perf/boot.cjs --strict` 守这条：首屏脚本 529.5KB（+16.8KB，主要是 `TextAI.DEF.model3d` 的契约正文）、TTI 2200ms 不变。
- **模型文件是本体，不另立账**：`<库根>\白膜\<组>\<名>.json`（+ 同名 `.png` 缩略图），导入的 3D 文件在 `<库根>\白膜\_模型文件\`（下划线开头的组名保留给这一层）。`server/routes/model3d.js` 七条端点（list / file / thumb / asset 读 / asset 写 / save / delete）进 `LOCAL_ONLY`；`id` 是「组/名」，解码后必须仍在 `白膜` 根内，写盘全走 `atomicWrite`，改名 / 移组走 `renameWithRetry`（Windows 上被占用会报具体原因）。
- **DSL 与拾取**：`kind` 六种（group / prim / mannequin / crowd / asset / ref），`prim` 十种形状（含 `loft` 放样 / `lathe` 旋转体 / `extrude` 拉伸），`mirror` 与 `repeat` 在进场景前展开；`ref` 深度上限 4、同链防环；节点 400、深 8 层、三角 6 万是硬上限。小人 8 体型 × 20 姿势 + 步态正弦，群众走 `InstancedMesh`（按灰阶合批，400 人只剩几笔绘制），拾取按 `instanceId` 反查。
- **本地 3D 文件导入**：`.fbx` / `.obj` / `.glb` / 内嵌 `.gltf` 四种，`web/model3d/loader.js` 按扩展名分派、按文件缓存原型、高度归一成 1 米且脚底落在 y=0、文件里的灯与相机剔掉；`clay` 开关按**节点**决定（白膜化是每个摆件自己的事）。Draco / KTX2 压缩、OBJ 的 MTL 与贴图外链、`.gltf` 的外链 `.bin`、骨骼动画都不支持，界面上直接说清是哪一种（不是静默失败）。
- **AI 契约 `model3d.json`**：正文在 `skills/model3d/SKILL.md`，与 `TextAI.DEF.model3d` 同源（`tests/e2e/smoke.cjs` 逐字节比）。输出只有一份 JSON：`{say, reuse:{id,mode,why}|null, model:{scene,anim}}`；`reuse.mode = as-is` 直接加载目标模型，`base` 交出改完的整棵树（不搞 op 补丁，解析与撤销都简单）。流式按括号配平从 `"nodes":[` 里抓**已完整的节点对象**，每收全一个就重建一次场景 —— 模型是一个零件一个零件长出来的。
- **出图 / 出片**：`web/media-export.js` 新增 `exportCanvas({canvas,width,height,fps,duration,draw,…})`，与 `exportFilm` 共用 `pickCodec` / `framePlan` / `MB.Output`，逐帧 `draw(t)` 必须同步画完（中间再 await 会出黑帧）；静帧走 `view.shot(w,h)` 的离屏 RenderTarget 读回。两条都只经 `Api.saveLocalAsset` 落库，`meta.model = '3D白膜'` 带上提示词与时长。
- **入口与回传**：工作台「润色」右边那颗「建模」（音频栏收起）、导演台同一位置那颗、`AssetPicker` 的「3D 白膜」来源（只在收图片 / 视频时出现）。跨页只经 `web/model3d/bridge.js`（`window.Model3D`，几十行、按需 import）写一枚一次性口袋（`model3d_handoff`，10 分钟有效，不进云同步）；目标页在 `onActivated` 消费 —— 页面池常驻，第二次回来时 `setup` 不会再跑。落槽仍走唯一出口：工作台 `refIntoSlot`、导演台 `addRefImage` / `pickRefMedia(sh,'refvideo', preset)`。
- **判据**：新增 `tests/model3d-{schema,dsl,mannequin,crowd,scene,loader,anim}.mjs` 与 `tests/model3d-vault.cjs`（隔离库根，不碰用户目录），八条都登记进 `tests/all.cjs`；`tests/metrics.cjs` 的 `EXCLUDE_DIRS` 加 `vendor`（第三方不是我们的代码，这条清单原本就是这个口径，只是以前只排了单文件）；`tests/command-palette.cjs` 的命令面板切片会一直读到 `ui.css` 末尾，新加的白膜弹窗样式因此收进独立分节并改用令牌（`--sz-mq-*`）。

影响：新增库根目录 `白膜\`（跟着 `sk_local_dir` 走），不改任何既有数据形状，不需要重打 `tests/data-baseline.json`；新增路由 `/model3d*`（进 `LOCAL_ONLY`，同源 + 会话 Cookie 双闸）；`tests/metrics-baseline.json` 与 `tests/fixtures/dup-baseline.json` 按新体量重打一次（总行数 +584，`vendor` 已排除）。「首屏不带大件」与「页面级按需加载」两条没有放宽。

## 0.1.0 — 2026-11-06

首次纳入语义化版本管理与自动化门禁。

- **本机素材只认库根 · 换机器不用重新导入**：落盘名带可移植尾标 `<规范名>__la_xxx.<ext>`，账丢了 / 换机器时 `localAdopt` 与 `/asset/<旧号>` 按名认回**同一枚** `la_` 号；项目文件导出时附带每条本机素材的旧号 / 落点 / 字节数（`media` 段，独立校验和），导入时走新增的 `POST /local-assets/rebind` 批量重绑，老文件、改过名、只有媒体包 `media\` 的情况都能认回。`/local-assets/from-url` 与 `POST /local-assets`（base64）在落字节前先认盘：前者按规范名 + 可移植尾标，后者按内容签名（`sampleSigOfBuffer`，与磁盘对账同一把尺子），认准就只补索引，零下载零写入。新增 `absInRoot` 闸门：账里指到库根外面的落点按「不在这里」处理，索引 / 对账 / 播放都只在设置页选的那一个目录里找（`dirScan` 本来就只扫库根，跳过 `提示词\` / `FCPXML工程\` / `.trash\`），设置页把这条口径写在「本机资产库」卡上。
- **导演台生成产物不受开关影响**：只有导演台「刚出结果」的候选与关键帧带 `mustSave`（`gen-forms` 只透传调用方给的标记），`sk_media_local` 关掉也照存；开机 / 导入后的历史补扫 `announceDoneCandidates` **不带**这个标记，不再因为打开老工程就强制下载一批旧候选；工作台不传，仍听开关。设置页两行文案随之改为「历史产物自动存本机 / 历史产物补存哪一档」。
- **导演台短片菜单收整**：项目文件的导入 / 导出在页头短片下拉底部默认折叠，摊开后导出收成一颗拆分按钮（主钮「导出当前短片」、尾钮「导出全部短片」），导入仍是一行；删掉菜单里「全部候选 / 提示词 / 剪辑状态」与「视频字节不在包里…」两段说明（导出回执与导入确认框里的说明保留）。同一项目组下连点「＋ 新建短片」不再得到一排同名作品：默认名按组内序号排（`未命名短片 1/2/…`），序号**同组内连续**、不同组允许同名（菜单按组画成树，组名已经区分），不会再出现「甲组 1、2，乙组占掉 3，甲组下一部成 4」的空洞。判据在 `web/director/groups.js` 的 `nextProjectName`。`tests/director-groups.mjs` 与两条真浏览器 e2e 同步覆盖折叠、拆分按钮、导出全部与序号。
- **本机素材链路的几处修补**：同来源账行还在、文件却被删时，`/local-assets/from-url` 重下一份并**沿用原号**（不再回 `reused` 假成功、让前端拿到 404）；`rebind` 整批共用一份表与一份快照、最后一次落盘，`total` 报请求条数、`omitted` 报没处理的尾巴；按号补建只剩 `adoptBodyByHint` 一份判据（`localAssetRepair` 只留负缓存），命中已被别的账登记的文件时只挂别名、不补第二条账，同号旧行补建时保留 `upstream/detail`；`from-url` 下载后的「裸行认回」与「内容指纹命中」合成一次查表；999 个同名后的兜底文件名把时间戳插在可移植尾标**前面**（号不再丢）；项目文件的素材线索校验失败改为只丢线索、作品照常导入，导出回执与确认框统一成「把视频文件放进库根即可认回」；「投过了」标记改存内存 WeakSet，不再随工作区 / 项目文件漂到新机器让历史补扫整批跳过。
- **数据保存与备份收敛**：服务端 `data-store / cloud-store / prompts-store / fs-atomic / asr-store / search-store / skills-store` 七份合成 `server/data-hub.js` 一份，磁盘上的业务数据从一堆 `<key>.json` / `.bak.json` / `.cloud-*.json` 收成 `.data/state.json` 与 `.data/backup.json` 两份。旧文件一次性迁移：`state.json` 写齐后回读逐键比对校验和与正文，全通过才把旧文件挪进暂存目录逐个删除；不做旧格式兼容层。`server/local-root.js` / `registry-config.js` / 资产索引 / FCPXML / 本机资产路由改从状态仓读键，原子写原语也只留 `data-hub.js` 这一份。
- **统一备份中心**：新增 `/backup/{status,export,verify,create,preview,restore,import}`。快照轮转 5 份、带 sha256，覆盖 / 删除 / 云端拉取 / 恢复前自动留一份；删除 / 云端覆盖 / 迁移 / 恢复前 / 手动这几类撤销点强制新增，普通覆写 10 分钟内去重。`state.json` 校验和不通过时拒绝写入并由 `/backup/status` 报出 degraded（两份文件都得健康才算 `ok`）；旧 `/cloud/backups` 与 `/cloud/restore` 删除。
- **导演台项目文件（导出 / 导入完整工程）**：页头短片下拉底部新增「导出当前短片 / 导出全部短片 / 导入项目文件」三颗入口。包里带每一镜的全部候选（含未选用 / 失败 / 草稿）、提示词与台词、参考图与首尾帧、选用 / 裁剪 / 锁定、成片轨、画幅与项目组名；与页头那四档「只带选中画面」的导出互不替代。格式闸门 / 校验和 / 清洗 / 导入归一化收在新建的 `web/director/project-pack.js` 一份纯件里：只认 v1，旧版 / 高版本 / 校验和对不上一律零写入拒绝；导出只清 `blob:` 临时地址与视口游标并报数；导入追加为新短片，撞 id 换一枚、撞名加后缀、在途生成标成可重试，绝不覆盖现有作品。视频字节不进包；换机器时把视频文件（媒体包的 `media\` 也行）放进本机资产库，导入会按随包的素材线索认回旧号。新增 `tests/director-project-pack.mjs`（111 项）与 `tests/e2e/director-project-pack.cjs`（59 项，真浏览器点按钮、导出读字节、导入、坏包零写入）。
- **整包备份 v2**：`web/ui/datasync.js` 的 `PACK_VERSION` 升到 2，包里恒带 `/backup/export` 出的服务端快照（业务键 / 资产索引 / 提示词归档 / 云同步状态与基线）。导入先让代理校验 checksum，对不上就一项都不写；提示词归档不再从 `PromptLog` 导第二份。设置页把数据、快照、设置导出与云同步收成一张「数据与备份」卡，覆盖前不再往下载目录丢 JSON，改留一份可在界面上直接恢复的快照。新增 `tests/data-hub.cjs`（迁移 / 降级 / 逻辑视图 / 轮转 / 恢复 / 端点，70 项）并登记进 `tests/all.cjs`。
- 新增 `npm run ci`（`check` + `static` + `test`）与 `.github/workflows/ci.yml`：push / PR 在 Windows + Node 22 上跑秒级判据；浏览器 e2e 仍不作提交前置。
- `/sys-status` 增加独立的「产品版本」字段，设置页「本机环境」与复制文本同时显示；`代理.版本` 仍是供应商注册表版本，语义不变。
- `tests/doc-contract.cjs` 增加三条契约：README 的页面数 = 路由表条数、README 的 scripts 清单 = `package.json` 的 scripts、CHANGELOG 的最新版本 = `package.json` 的 version。
- README 修正页面数、e2e 命令口径，补全 scripts 清单。
- 整包备份导入加格式闸门：只认当前一版（现为 v2），旧版 / 未来版本 / 无版本 / 缺服务端快照一律拒绝且零写入；确认框在导入前显示差异摘要（覆盖哪些、保留哪些、归档同名不覆盖）；写入失败的项在回执里报数，不再静默吞掉。新增 `tests/data-pack.cjs` 并登记进 `tests/all.cjs`。
- 新增全局命令面板 `web/ui/command.js`（Ctrl/Cmd+K 唤起）：候选页只从 `WB_ROUTES.pages` 现取、跳页只走 `GoPage.go`；全局只占一个唤起键，↑↓ / Enter / Esc 在面板内消化并截断，避让导演台键盘作用域岛；输入框与输入法合成中不抢键。新增 `tests/command-palette.cjs`，`tests/spa.cjs` 首屏脚本预算按「为什么不能按需」记账 +1 枚。
- 设置页只留标签与状态：删掉页面副标题、每张卡的说明行、`.pb-tip` 提示条、缓存逐项说明、Skill 区的解释文案、目录轨的组说明，以及账号卡上「不经过云供应商 / 转发到某地址」那几句；界面偏好与产物存放那几段长说明收成短句，账号摘要、同步状态与存档位说明一并压短。
- 设置项右侧的说明文字一并删掉：界面偏好的三句（产物自动存本机 / 优先用本机文件 / 不显示云端任务）、素材库那五项（音色方式、默认生图型号、默认语音型号、出几张候选、出几条语音）、失败重试的「填 0 = 不重试」、反问档位的「也管导演台的拆分镜 / 改分镜」。`Chars.SET` 与 `UI_PREFS` 里对应的 `hint` 字段一并去掉，渲染处不再有 hint 分支（不留「声明了但没人读」的字段）。`tests/director-split-ask.mjs` 那一条从「文案里写清它也管拆分镜」改为守接线（设置页的键名 = `TextAI.askMode` 读的键）。
- 设置页左栏目录轨不再摆「值速记」：每行只剩图标 + 栏目标题（原来每行右边压着一列「5 家 · 图 1 / 视…」「300 秒 · 重试 1…」这类短字，长一点就被截成省略号）。`NAV_VALUE` / `navValueOf` / `uiPrefLabel` 与样式里的 `.set-rail-lead` / `.set-rail-v` 一并删掉，不留死代码；`tests/e2e/settings-nav.cjs` 的「值速记填满」断言随之去掉，组标题上的条数保留。
- 设置页的紧凑勾选行（`.krow.tight`：侧栏默认展开 / 操作成功也给一声提示 / 各项开关）底色从 `--panel2` 的灰底改成卡片面（浅色档纯白），与供应商卡同一口径。
- 设置页卡内那一族「白面」组件（供应商卡 / 汇总条 / 润色块 / 云同步面板 / 搜索结果正文 / Skill 变量空态）底色统一到卡片面：浅色档是纯白（原来是 `--panel2` 的灰蓝），供应商卡改由发丝描边分层（原来描边透明，白底上会看不见）；深色档与卡面同色、同样靠描边分层。强调色不动。
- 设置页剩下的块级灰底一并收进同一口径：数据行（`.krow`：数据文件 / 浏览器存储 / 云同步 / 备份）、供应商卡里的能力子块（`.incard` / `.capform-text`）、型号清单面板（`.mpanel`）、Skill 预览与筛选条都改成卡片面。灰只留给小控件与状态牌（按钮 / 芯片 / 输入框 / 停用态）。
- 新增控件阴影 `--shadow-ctl`（按钮 `.ghost` / `.pri` / `.tool`、下拉 `.dd-btn`、输入框与 `.ui-pill` 统一读它）：贴边 1px 的描边影 + 底边硬投影 + 一圈小光晕，上下左右四边都有边界；原来这些控件只带 `--shadow-1`（1px 2px 的小偏移），落在白卡上只剩底边一条、看着是平的。深色档换成浅描边影 + 黑投影（深底上黑描边看不见，控件会与卡片连成一片）。
- 导演台「高级设置」里那颗时长数字框也改用 `--shadow-ctl`（描边让位给影，补 hover / focus 态），与同一张卡里的下拉、开关同一层厚度。
- 提示词归档不再单独选位置：默认目录改成**库根下的 `提示词\`**（`server/data-hub.js` 的默认值由注入的 `localRoot` 现算，白名单放行用户挑的库根），设置页那一格从输入框改成只读路径；`prompt_dir` 本地键与 `PromptLog.dir` / `setDir` 一并删除，云同步与整包导出不再传 `promptDir`，`user-dirs.promptsRoot` 随之删掉。`tests/local-root.cjs` 增加三条判据（与库根同根、换根跟着换、库根在下载目录之外也合法）。
- 「打开目录」统一到 `server/open-dir.js`（提示词归档与 FCPXML 工程共用）：Windows 上先起 explorer，再用 `AttachThreadInput` + `SetForegroundWindow` 把那个窗口拽到应用前面。以前由后台代理拉起的资源管理器会被前台锁压在应用窗口后面 —— 点了「已导出 FCPXML 工程目录」，文件夹其实开了，用户只看见自己的窗口没动。前台锚定的 P/Invoke 片段抽到 `server/win-fg.js`，与设置页「选择文件夹」共用一份。
- 任务卡动作区不再钉死两行（`ui.css` 去掉 `grid-template-rows: repeat(2, --sz-ctl)`，改 `grid-auto-rows`）：只有「展开详情 / 下载」两颗的完成卡，第二行原来整行空着，卡片底部多出 36px 空洞。等高仍成立 —— 同一排由更高的那张 stretch 定行高，多出的空间被 `.acts` 的 `margin-top:auto` 收在正文下方，按钮始终贴着卡片底边。资产库紧凑档与收藏页的 `card-acts` 同吃这一条。
- 卡面「下载」从 10% 淡紫底改成 `--sel-bg` 淡紫底 + `--acc-line-32` 描边 + 强调色加粗 + 轻投影（实心 `--pri` 试过，用户回「过于深」，一屏六张卡各压一块深紫太重）；hover 只抬阴影，不加深填充。
- 工作台右栏任务卡加「收藏」那颗星：与资产库同一份公共件 `Wb.favBtnHTML` / `Wb.bindFavBtn`（`web/ui/workbench.js`），条目归一 `Wb.favEntryOf`（资产库 `src/type/duration`、工作台 `raw/mtype/durationSec` 只在这一处对），资产库原来私有的一份删掉。ui 层不读 domain 的收藏表：按钮只按 `on` 画，收 / 拿由页面把 `isOn / toggle` 两句接进去（分层方向判据 U5 从 87 处降到 85 处）。没有产物号的任务不画星；`cardSig` 带收藏位，别的页收 / 拿之后回来会重画；`fav-change` 在挂载时订阅、卸载时摘掉。`tests/e2e/task-cards.cjs` 加三条判据（有字节的卡都画星 / 没字节的不画 / 点一下真的进收藏）。
- 动态加载档的跳页改成「按每页条数取回 + 落位」：落点算式收进公共件 `Wb.viewport.revealPage(cards, pageNo, pageSize)`（工作台右栏与资产库共用），输入第 N 页后除了把前面几页取回来，还会把第 N 页的头一条滚进视野（不够就落到最后一条）。以前只取不落，画面停在第一条，看着像没跳。工作台那颗按钮文案也从「取到第 N 页」改回「跳页」，title 写明每页多少条；`tests/e2e/pager-row.cjs` 加一条落点判据（第 20 页落到第 39 张、超出页数落到最后一张、容器真的滚了）。
- 工作台左栏改成「正文一段滚 + 生成区钉在栏底」两段（`.wb .col-left > .wb-body` / `.wb-dock`，与导演台右栏 `ed-body` / `ed-footer` 同一副）：以前整栏是一只滚动容器、生成按钮跟在内容最末 —— 提示词长或参考素材多时要一路滚到底才够得着按钮，窗口高而内容短时按钮又浮在半空、下面留一大片空白。现在左栏自己不滚，估价 · 生成按钮 · 不可用原因 · 状态行 · 余额 / 重复提交提示钉在栏底（`margin-top:auto`，内容没占满也贴底）；「原始请求」那块能展开整份 JSON 的归正文，放钉底里一展开就把按钮挤走。≤1100px 单列时整块 `.layout` 在滚，钉底段改 `position:sticky;bottom:0` 贴住视口底。`Wb.viewport.host` 会自己爬进 `.wb-body`，重画还位那三处调用点不用改。`.wb #status` / `#goWhy` 两条样式原来写的是 id（Vue 版这两只元素只有 `data-r`、从不写 id），从迁到 SPA 起就没命中过，这次按 `data-r` 选。新增 `tests/e2e/studio-dock.cjs`（高窗贴底 / 矮窗正文滚而按钮不动 / 换类型不丢 / 单列 sticky），`tests/all.cjs` 与判据条数同步。

影响：只动文案与配色，不改数据形状，不需要重打 `tests/data-baseline.json`；`tests/e2e/settings-nav.cjs` 的「每组一句说明」与「回车必滚动」两条断言按新口径调整（筛选后只剩含命中的卡，落点已在首屏时不再硬滚）。

影响：工作台左栏那一条不改数据形状；视觉回归里 `settings` 与 `chat-src` 那 6 档基线按上一批设置页改版后的实际画面重拍（改版当时没跑 `ui-visual`，基线还停在旧外观），工作台四档不变。

影响：归档位置只剩库根一处（换台机器不会带着路径走）。以前填过 `prompt_dir` 的机器，那一格会被旧键清理带走，归档回到「库根\提示词」；老目录里的 .md 不自动搬（与换库根不搬产物同一口径），要找回来把整个目录挪进新位置即可。

影响：三批都不改数据形状，不需要重打 `tests/data-baseline.json`；命令面板是新增外壳级浮层，默认隐藏，不进视觉回归画面。

影响：只动文档、判据与一个只读状态字段，不改数据形状，不需要重打 `tests/data-baseline.json`。

- WebDAV 默认云端文件夹名跟仓库名对齐：`ai-workbench` → `imago`（`web/pages/settings.js` 的 `CLOUD_DEFAULT_URL`；设置页输入框的 placeholder 由模板绑到同一份常量，不再两处各写一遍地址）。

影响：只改默认地址，不改数据形状、不需要重打 `tests/data-baseline.json`。浏览器里已存过 `sk_cloud_url` 的机器不受影响（旧地址原样保留），要用新目录得在设置页自己改；云端旧目录里的文件不会自动搬。

- 云同步修两处「`.env` 填了却像没生效」：`/cloud/status` 的 `envConfigured` 改按 `CLOUD_WEBDAV_USER` + `CLOUD_WEBDAV_PASS` 判定（地址常由设置页给，不该要求 `CLOUD_WEBDAV_URL` 也非空）；组合根给云同步 store 补注入 `writeKey`，此前同步状态与基线写不进 `state.json`（日志报 `writeKey is not a function`），设置页一直显示「还没有同步过」。设置页状态行改成「凭据在代理侧（账号密码留空即用）」，说清 `.env` 的账号密码不会回显。`tests/data-hub.cjs` 加 6 条判据（来源判定 / 页面覆盖 / 状态落盘 / 凭据回退）。

影响：不改数据形状、不需要重打 `tests/data-baseline.json`；`.env` 里已配账号密码的机器，重开设置页就能在状态行看到凭据来源。

- 设置页与 `.env` 的口径统一成「页面留空 = 用 `.env`，页面填了 = 以页面为准」：云同步地址栏不再把空串顶回默认地址（`initCloud` 只在本机从没存过这个键时给示例值），三格 placeholder 都点明留空用 `.env`；服务端 `cloudCfg` 原本就是这套优先级，这次给 URL 那一格补上回退/覆盖判据。`.env.example` 补上口径说明，并修正提示词归档目录那段过时注释（现在跟着库根走，设置页只读）。`tests/data-hub.cjs` 加 2 条、`tests/settings-schema.cjs` 加 3 条判据。

影响：不改数据形状、不需要重打 `tests/data-baseline.json`；本机存过地址的老配置不会被自动清空，想改用 `.env` 的地址要自己在设置页清空地址栏（并在 `.env` 里填好 `CLOUD_WEBDAV_URL`）。

- WebDAV 地址补最后一档内置默认 `https://dav.jianguoyun.com/dav/imago/`（文件夹名跟仓库名一致），三格口径收敛为「页面填了 > `.env` > 内置默认（只有地址有）」。默认地址只定义在 `server/data-hub.js` 的 `CLOUD_DEFAULT_URL`，经 `/cloud/status` 的 `defaultUrl` 下发给设置页做输入提示；设置页不再把默认地址预填进输入框（预填等于「页面填了」，会把 `.env` 写的地址压掉），账号与应用密码仍没有默认值。`server/app.js` / `.env.example` / `AGENTS.md` 同步口径，`tests/data-hub.cjs` 加 4 条（默认回退 / 空白视为留空 / 状态下发 / store 暴露）、`tests/settings-schema.cjs` 加 2 条改 1 条判据。

影响：不改数据形状、不需要重打 `tests/data-baseline.json`；`.env` 里 `CLOUD_WEBDAV_URL` 留空、账号密码已配的机器，不用再补地址就能测试连接与同步（页面地址栏保持空），页面里已存过地址的本机仍以存的值为准。

- 导演台短片菜单里三颗项目文件入口收成**同一层级**：`导出当前短片` / `导出全部短片` / `导入项目文件` 统一用 `.pm-io` 行（同样的图标位与右对齐 hint），删掉「导出拆分按钮 + 尾钮缩进子级」那套结构 —— 以前导出是带边框的按钮、导入是一行，导入看起来低了一级。`pmIOSplitOpen` 状态与 `.pm-io-split` / `.pm-io-sub` 样式一并删除；三行补上 `role="button"` 与 Enter / 空格键盘可达。`tests/e2e/director-project-pack.cjs` 改为守「三颗同级、顺序固定、没有拆分与子级」，`tests/all.cjs` 注释同步。

影响：只动导演台短片菜单的结构与样式，不改工作区 / 项目包数据形状，不需要重打 `tests/data-baseline.json`；菜单默认折叠，页面级视觉基线不用重拍。

- 导演台「项目文件」恢复**导出拆分按钮**并补第三档范围：左半「导出当前短片」直接导出，行尾 chevron 是单独一格热区（撑满整行高、竖细线分隔），摊开「导出全部短片」与新增的「导出当前项目组短片」（同组全部，hint 带组名与部数）；「导入项目文件」仍是并排同级的一行，不与导出分主次。当前短片没归组时按组导出那格标为不可用（`.pm-io-off` + `aria-disabled`），点一下把原因写进状态栏。`exportProjectPack(scope)` 由布尔改成 `'current' | 'all' | 'group'`（`true` 仍兼容为全部），按组导出的文件名带组名；`clearProjMenuStates` 一并复位尾钮。`tests/e2e/director-project-pack.cjs` 重写为 34 条（两颗同级入口 / 尾钮两种范围 / 三部短片分档：当前 1 · 全部 3 · 本组 2 / 未归组不可用 / 收起再摊开不残留次级），`tests/all.cjs` 注释同步。

影响：只动导演台短片菜单的结构、样式与导出入口，不改工作区 / 项目包数据形状，不需要重打 `tests/data-baseline.json`；菜单默认折叠，页面级视觉基线不用重拍。

- 导演台项目文件：导出尾钮里「导出当前项目组短片」挪到「导出全部短片」**之上**（窄范围在前、全量在后），组名与部数的 hint 不变。项目组随包往返改为**只认组名**：导出时把 `groupId` 抹掉（组 id 是导出那台机器的工作区身份，跨机器要么指空、要么撞进本地另一拨同 id 的组），只带 `groupName`；导入时本机有同名组就并进那个组、没有就按名字现建一个，同一份包导两次不会得到两个「默认组」。确认框先说明「本机没有同名组就新建、已有同名组就并进那个组」，导入回执分别报「新建 N 个项目组（组名）」与「N 个项目组并入了现有同名组」，导出回执加上组数。老包 / 手改过的包里若还留着 `groupId`，导入归一化会一并抹掉。`tests/director-project-pack.mjs` 加 8 条（组 id 不随包走 / 带 groupId 的老包要抹掉 / 组数统计 / 确认框说明），`tests/e2e/director-project-pack.cjs` 扩到 44 条（顺序 / 组名认领 / 同名并入现有组 / 无同名组现建 / 回执措辞），`tests/all.cjs` 注释与 `AGENTS.md` 同步。

影响：只动导演台项目文件的导出顺序与组归位口径，不改工作区数据结构、不需要重打 `tests/data-baseline.json`；项目包仍是 v1（组名本来就在 `projects` 的校验和里），旧包照常能导，只是导入后不会再带着导出那台机器的组 id。菜单默认折叠，页面级视觉基线不用重拍。

- 导演台项目文件导入：撞名后缀不再只判一次，改成往后连续编号 —— 第一次「X（导入）」、再撞「X（导入 2）」/「X（导入 3）」……。判定同时看**本机已有短片**与**这一批里刚分出去的名字**：同一个包连导两次（本机还留着原片和上一份「（导入）」）以前会得到两部都叫「X（导入）」的短片，包里本来就带两部同名短片时也一样，现在都能分开。实现在 `web/director/project-pack.js` 的 `pickProjectName`（`prepareProjectPackImport` 内），导入回执改成「N 部短片因重名加了「（导入）」后缀」。`tests/director-project-pack.mjs` 加 7 条（第二次 / 第三次导入接着编号、同一批同名当场分开、没撞名不改名），`tests/e2e/director-project-pack.cjs` 扩到 46 条（同一份包连导三次后组内与全菜单都不存在同名短片）。

影响：只动导入归一化的命名规则，不改项目包格式（仍是 v1）、不改工作区数据结构，不需要重打 `tests/data-baseline.json`；已经导进来的重名短片不会被自动改名，只影响之后的导入。菜单默认折叠，页面级视觉基线不用重拍。

- 导演台项目文件：导入前把两处「要不要动你的东西」的问句交回给用户，不再替人决定。① **项目组重名**：本机已有同名组时先问「并入现有同名组 / 给导入的组改名」——选改名就给导入的那一组加「（导入）」后缀（本机连这个名字也有就接着编 2、3…），同一个组里的几部只改一次名，本机原有的组与短片一个字节都不动；本机没有同名组时照旧直接新建，不问。② **内容完全一致**：按作品内容算指纹（`projPackFingerprint`，id / 名字 / 组 / 面板补的 `combo`·`adv`·`duration` / 空默认值都不进指纹，成片轨照比），包里的短片与本机某部一模一样时先问「跳过这些 / 照导并重命名」；选跳过就一部都不写、也不再问组名与确认框，回执直接说明「N 部与本机一致，一部都没重复导入」。两问都取消 = 整次导入放弃，工作区不动。实现：`web/director/project-pack.js` 新增 `scanProjectPackConflicts`（只报事实）与 `projPackFingerprint`，`prepareProjectPackImport` 接 `groupPolicy` / `groupTaken` / `skipIndexes` 三个口子并回报 `skipped` / `renamedGroups`；`web/director/engine.js` 串起两问与回执。
- 导演台项目文件菜单：摊开后的入口不再用强调色（蓝色），改成正文色 —— 它们只是菜单里的一段，不该比短片行更抢眼；同时整组缩进进 `.pm-io-body` 的一条竖线里，一眼看得出是长在「项目文件 · 导入 / 导出」那一行下面，而不是与上面的短片行同级。
- 判据：`tests/director-project-pack.mjs` 加 13 条（指纹只认内容 / 面板默认值不算 / 成片轨时长照比 / 组名撞车扫描 / 合并与改名两种策略 / 同组只改一次名 / 跳过不入列表），`tests/e2e/director-project-pack.cjs` 扩到 59 条（多窗导入的走法、改名后本机原组一部不少、全跳过时行数不变且不再弹确认框、入口缩进与配色），`tests/all.cjs` 注释、`AGENTS.md`、`README.md` 同步。顺带把「素材线索校验和对不上」那条判据改成现在代码的语义：只丢线索、作品照常导入。

影响：只动导演台项目文件的导入交互与菜单观感，不改项目包格式（仍是 v1）、不改工作区数据结构，不需要重打 `tests/data-baseline.json`；本机已有的短片与组不会被改名或合并（改名只发生在**导入的那一份**上）。菜单默认折叠，页面级视觉基线不用重拍。
