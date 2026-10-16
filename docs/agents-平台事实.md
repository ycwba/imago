# AGENTS.md 分册 · 第 6 节

本文件是 [`AGENTS.md`](../AGENTS.md) 第 6 节 的**全文分册**：正文一条没改、一行没删，只是搬了位置。
这里是 §6（已知的平台事实）的全文：各家接口怪癖、产物地址有效期、幂等键与重试那些实测结论。
AGENTS.md 里那一节保留每一条约定的标题行（红线与「唯一实现在哪」都在），改到对应的任何一处之前先来这里读全文。
§1 统一路由、§2 能力驱动、§4 密钥与用户数据、§5 改完必须自测**仍在 `AGENTS.md`**；这一册里那些「见 §5」「见 §2」指的就是那边。

---

## 6. 已知的平台事实（省得重复踩）

- **VGENV**：列表/详情都不返回 `prompt`（提示词靠本机归档 `PromptLog` → `prompts/`）；素材上传用 camelCase
  （`fileName`/`contentType`/`sizeBytes`）且**拒绝未知字段**（多发一个 `sha256` 就 400）；参考素材必须是
  `{asset_id}`（参考图是 `[{type:'image_url',image_url:{url}}]`），首尾帧走 `frame_images` 带 `frame_type`。
- **SparkCine**：上传用下划线字段且 **`sha256` 必填**；`output_format` 平台声明 png/jpeg/webp，
  但早前实测（产物字节头 / mime_type / 文件名）**回包永远是 PNG**，当时用 `forceOptions` 锁成 png；
  按用户要求**已解锁**（`options.output_formats` 给全，界面照平台声明给选项）。真要再锁回去就加回
  `forceOptions: ['output_formats']`；列表 `output_asset_ids`、详情 `outputs[].asset_id`；
  创建接口**要求 `Idempotency-Key` 请求头**，不带直接验证失败（registry 里已按 `create.idempotencyKey: true` 声明）。
- **SparkCine 视频的「平台自动润色」**：`create.topBools.optimize_prompt` 是**提交体顶层**的布尔
  （不进 `parameters`）。以前是写死的 `constants: { optimize_prompt: false }`，等于把这个功能焊死在关闭、
  界面上连入口都没有。现在声明式：生成工作台的视频栏只为声明了这一项的平台渲染开关，平台没有（VGENV）就不出现。
- **首帧槽位可以直接选视频**：生成工作台的「首帧图」既收图片也收视频 —— 选视频时在**浏览器内**取它的**最后一帧**
  当首帧（`Wb.vframe.fromFile()`，`studio.html` 的 `addSlotFiles` / `dropRefMedia` 调它，用于「把已有视频接着往下生成」）。
  只对声明了 `videoFrame` 的槽位生效（`SLOT_DEF`），要加别的槽位照抄这条。
- **VGENV 详情端点 /v2/videos/{id} 是 404 空壳**（只回 statusCode/code/message）→ registry 里声明 `pollVia:'list'`，
  单条状态靠列表接口按 id 找（`Api.pollTask`）。列表返回完整对象（含 `output.url`），列表才是状态的最终依据。
- 「任务显示成两个、其中一个是假的」这类问题的三个成因（都已修，别再引入）：
  ① 跨闭包裸调用抛 `ReferenceError` 被 allSettled 吞掉 → 数据整源失踪；
  ② 轮询端点坏了 + 404 被当成「任务已被清理」→ 本地任务被清掉任务号，于是和列表里的真任务并存；
  ③ 首屏缓存把「生成中/排队中」也持久化了 → 下次打开显示成永远不动的旧状态。
- **页面取数只走统一层**：注册表用 `Api.registry()`（带 60 秒缓存，别再各页裸 `fetch('/registry')`），
  字节取回用 `Net.blob / Net.fetch`（带超时与可读错误，别再裸 `fetch('/asset/…')`），
  平台接口用 `Api.request`。长任务（`/render`、云同步）用 `Net.fetch(..., { timeout: 0, retry: 0 })`
  —— 关掉超时、不自动重试，别让统一层把它们掐断。
- **任务卡片一律来自平台接口（语音除外）**：生成工作台的图像 / 视频栏**不建本地任务卡**，本地也不留任务记录
  （`video_tasks` 已废弃，`Wb.History` 的 `video` 规格与 DataSync 的同步键都删了；
  `HISTORY.image`（`sparkcine_gallery`）是合并前的旧生图工作台留的键，现在**只保留给设置页清理/查看**、页面已不再写入）。
  提交流程是：`create` 拿到任务号 → `adoptTask()` 立刻按任务号从接口取回那条任务、插进列表
  （取不回来就整表刷新，列表接口才是状态的最终依据）；之后由统一轮询器刷新状态。
  所以「创建中/排队中」的占位卡、孤儿认领、本地↔服务端校正这些机制都不该再出现 ——
  卡片上的任务号一定来自平台，本地记录不参与渲染。**语音是例外**：MiMo 是同步合成、上游没有任务号，
  本地记录就是它的唯一凭据（保留 `audio_tasks`）。
- **创建后的「取回/核对」不要挡住按钮**：平台列表接口动辄 6~14 秒，`adoptTask()` 与「结果未知 → 核对列表」
  都必须放后台跑（只提示「正在取回/核对」），按钮的禁用窗口只覆盖 create 本身。
  唯一的例外保护：结果未知时置 `pendingUncertain`，这期间再点生成先弹确认（防止把可能已成功的提交又提交一遍），
  核对结束自动清除。
- **平台的提示词编译失败可安全重试**：VGENV 创建时会跑一步 `prompt_optimization`，子服务偶发失败返回
  `PROMPT_COMPILER_UPSTREAM_ERROR` —— 这表示**任务没创建、没扣费**，重试安全（不像超时/断连那样可能已受理）。
  统一用 `Api.isRetryableCreateError(e)` 判断（页面自动重试一次，别各写正则）。
- 提示词归档：`POST /prompts` 写文件、`GET /prompts` 列清单 + 索引、`GET /prompts/find?id=&provider=` 取全文；
  目录在设置页可改（`prompt_dir`，只存本机）。
- **`/prompts/find` 一次返回按 id 匹配到的全部归档**（`{matched, prompt, all[]}`）：`provider` 只用来决定
  「优先把哪一份当正文」，不影响是否命中。**客户端每个任务只发这一个请求** —— 以前是「带 provider 查一次、
  查不到再不带 provider 查一次」，第二次多半和第一次逐字节相同（本机根本没归档），于是每条老任务固定多一个 404。
  代理侧还会在索引里没有这条时**按文件头扫一遍目录**（索引只留最近 2000 条，窗口外的老归档不在里面），
  没有才回 404；客户端回源 404 会记进 sessionStorage 的 missed 集合，同一标签页不再问第二次。
  剩下那一个 404 是「本机确实没有这份归档」的如实答复，不是噪声；要再省就得做 `ids=` 批量查（还没做）。
- **本机资产（`/local-assets`）的大类型由代理现算，不看调用方给没给**：`proxy.js` 的 `localMediaType()` 按
  落盘扩展名 → mime → 调用方给的 `media_type` 依次判（`图片` / `视频` / `音频`），POST 与列表回读都走它 ——
  所以 `Api.saveLocalAsset()` 的调用方**不必**传 `media_type`（短剧末帧那张 PNG 以前没传，就被缺省记成了音频）。
  注册表里本机来源的 `list.media` 是 `{ by: 'media_type', ... }`，条目自己带类型；`音频` 与 `音乐` 是同一类
  （收藏页、资产库筛选、语音台列表都两个词都收），新代码别再只认其中一个。
  另：隔离验证实例要 `ASSETS_DIR=.assets-probe` 一起给 —— `LOCAL_DIR` 默认就是项目下的 `.assets`，
  只换 `DATA_DIR` 的话探针生成的素材会直接写进用户的资产库。
- **缩略图缓存键必须归一化**：VGENV 的视频在页面上是 `/getv?url=<OSS 签名地址>`，而 `Expires`/`Signature`
  每次刷新都会变 —— 用整条 URL 当缓存键等于「永远命不中、每次都重新加载视频元数据」。
  归一化只有一份：`assetlib.js` 的 `Api.mediaKey`（内层地址的 host + path + 稳定 query，易变签名参数剥掉），
  `Wb.thumbs.keyOf` 与回源去重都用它。以后接入平台时，只要产物地址带易变的签名/参数，都要先归一化再当键。
- **过期签名外链由公共层负责，页面不许自己判过期**（`assetlib.js`）：平台产物地址只管一天，一旦被**存进本机记录**
  （收藏 `fav_items`、导演台工作区 `workspace`），第二天必然 403 —— 表现是「这条视频的缩略图永远加载不出来、
  点开只回一句 Format error」，真实原因完全看不出来。三条约定：
  ① 判过期用 `Api.mediaExpired(url)`（只看地址里的 `Expires`，不发请求，还留了 60 秒余量）；
  ② 回源用 `Api.healMedia(recs, { onFresh })`：rec 只要 `{ provider, id|genId|assetId, url }`，
     它按平台分组走 `Api.pollMany`（声明了 `pollVia:'list'` 的平台**一次列表请求解出整批**，
     逐条 `pollTask` 就是 N 次「100 条的列表」，上游被打爆、请求互相排队），
     换到的新鲜地址按素材身份记进内存表；
  ③ `Api.mediaSrc(url)` 会查那张内存表 —— 所以页面**一行都不用改**：播放器、缩略图抽帧（`Wb.thumbs._source`）、
     灯箱、`/fetch?url=…&dl=1` 的下载链接都跟着换成新鲜地址。
  落盘由调用方在 `onFresh` 里做（收藏写回 `fav_items`，导演台写回工作区并 `DataSync.mirrorWs`），别指望内存表跨会话。
  开机回源这一趟必须放后台（`director.html` 的 `healStaleUrls()`），别在首屏 await —— 收藏/镜头一多就被慢接口拖住。
  **别拿 assetId 拼 `/asset/<id>` 当新鲜地址**：那条本地路由只服务本工作台落盘的产物，别平台的资产号进去就是 404 破图。
- 云同步：`POST /cloud/sync`（一键双向）/ `resolve`（冲突二选一）/ `GET /cloud/backups` + `POST /cloud/restore`。
  冲突判定靠 `.data/.cloud-state.json` 基线（点开头 = 内部状态，不参与 dataList/上传/下载）。
  改同步逻辑时**不要退回"只看时间取新"**：那会在两边都改过时静默丢一边。
  两条底线：① 远端**存在但读不下来**（GET 失败）判 `error` 并跳过，绝不 push（否则本地旧数据覆盖云端较新版本，无提示、云端无 .bak）；
  ② 本地 `removeItem` 的删除请求必须真正执行到底（`DataSync.queue` 存 body=null、`flush` 走 `delData`），否则服务器那份还在、下次 boot 又拉回来。
- 浏览器侧对账（`ui.js` 的 `DataSync.boot`）：体积相同**不能直接跳过** —— 等长修改（grid→list、等长密钥/模型名）
  体积一模一样，只比体积的话另一台机器的更新永远拉不回来；体积相同但服务器更新时仍要取回逐字节比对。
  对账期间（`booting = true`）本地写入**先进 `held` 暂存表、不立刻镜像到 `.data/`**，`finally` 里 `releaseHeld()` 补发；
  `flushKeepalive()` 发送前也要比对 `localStorage` 当前值，值已经变了就不发（`changed → location.reload()` 那条路径上，
  排队内容很可能是对账拉回之前的旧内容）。改这三处任一一个，都要在隔离实例上重跑一次「页面写入 → 刷新 → 对账」的验证
  （`PORT=6300 DATA_DIR=.data-probe ASSETS_DIR=.assets-probe node proxy.js`，别在真实实例上写）。
  **已知残留限制**：普通字符串值（`dir_theme`、`sk_key_*`、`page_mode_*` 这类没套信封的键）取不到写入时间，
  `Store.tsOf()` 返回 0，`boot()` 判不出「本地更新」，所以它只能靠上面两道闸门挡误写，不能证明顺序正确
  —— 别再往「只看 mtime 取新」的方向退化。（结构化记录一律走 `Store` 信封，`fav_items` / `ai_usage` 已收进来。）
  **但「发送前再比一眼 `localStorage` 当前值」这道闸门对 `DataSync.NO_LOCAL` 里的键必须跳过**（目前是 `workspace`：
  本体在 IndexedDB，页面把快照单独递过来，本机根本没有这个值 —— 一比就永远「不一致」，镜像静默不落地。
  踩过：`.data/workspace.json` 停在两天前，换机器 / 清缓存时恢复出来的是旧工作区，连开机回源换来的新鲜地址都没落盘）。
- **平台转发闸按「一家平台」算，不按 relay 前缀算**（2026-10 补，`.env` 那一族 `RELAY_*`）：
  **为什么要有闸**：资产库 / 图片台 / 视频台 / 导演台四页会同时问同一家平台的列表接口（SparkCine 那份列表动辄 6~14 秒），
  而网关侧的并发上限（429/503）比这更早到。以前每条请求都直接打出去，撞回来的是一句上游 429，界面只显示「转发失败」，
  看不出是「问得太多」还是「密钥坏了」，于是用户反复点、越点越挤。
  **闸的形状**（`proxy.js`，四档全部 `envInt` 读 `.env`，启动定一次、改了要重启，启动日志把生效值与来源一起打出来）：
  `RELAY_MAX_INFLIGHT` 同一家同时在途几条（默认 8）、`RELAY_QUEUE_MAX` 同一家最多排几条（默认 32，排满**当场拒**）、
  `RELAY_RETRY_MAX` 被限流后读请求最多重问几次（默认 2，0 = 只问一次）、`RELAY_WAIT_MAX_MS` 一次最多等多久（默认 15 秒）。
  键是 `String(p.keyId || p.id || '?')` —— 一家平台同时做图片与视频时**共用一把 `sk_key_<keyId>`**（§1 那条按 keyId 归并），
  所以也必须共用同一份配额。按 `/sparkcine` 这种 relay 前缀建闸会把「同一家」拆成两个互不相干的计数，
  而前缀排第一的那家还会冒充另一个 —— 所以 `RELAY_PREFIXES` 这个名字在闸那一段里一次都不许出现（判据 ② 的一档钉这条）。
  **三条最容易写坏的性质**：
  ① **排满必须当场拒绝，不许静默排队**。`relayTake` 返回 false 就回 429 —— 这一条是**本地代理**回的，请求根本没发出去，
     所以那句 `error.message` 要写明「没有扣费」，并点名是哪一家、哪两个数、去 `.env` 改哪两个键。
     挂在同一条在途请求上的其它响应也要拿到同一句 429（`flushInflight`），别让其中一条干等。
     `res.headersSent` 之后一个字都不能再写（那份响应已经在流里了）。静默让人排在永远排不到头的队列上，比拒了更坏。
  ② **退避重试只给 GET**：§2 那条「没有幂等键的 POST 一律不自动重试」在这里照样成立 ——
     「请求已到、响应超时」时重发一次就是重复建任务、重复扣费。`relayRetryWait(method, ur, tries)` 的第一道闸就是
     `method !== 'GET'`，而**调用点必须传 `req.method`**（在那里写死 `'GET'` 等于把这条判据从「看请求方法」
     退化成「看代码里那个字面量」，判据 ② 当场红）。`Retry-After` 秒数与 HTTP-date 两种网关都给过；没有就 `1000 * 2 ** tries`；
     下限 200ms，算出来超过 `RELAY_WAIT_MAX_MS` 就不等、把决定权交回页面。丢掉那份响应之前要 `ur.resume()`
     （否则 keep-alive 的 socket 不回连接池），重发前先判 `res.destroyed || res.writableEnded`（客户端已经走了就别白打一趟）。
  ③ **名额必须恰好归还一次**：`release` 幂等（`if (released) return;`），落点只有四处 —— 最终那份响应的 `ur.once('close')`、
     请求 `error`、客户端已走、`RELAY_SLOT_MAX_MS` 看门狗。名额跟着**整串尝试**（原始一次 + 至多重问那几次），
     中途提前还掉等于「一边说在限流、一边把名额给下一条」，闸形同没有；漏还一次则这一家永远关在闸外，**那比没有闸更坏**。
     看门狗必须长过创建任务那 120 秒的耐心（`RELAY_SLOT_MAX_MS > 120000`，判据把它钉成一条真比较，不写进注释）。
  另两条别破：列表 / 详情短缓存**命中**与「挂到同一条正在飞的请求」都在闸**之前** return，所以命中缓存不占名额
  （否则导演台每改一次时长都要多占一个名额，限流反而被自家缓存放大）；被限过的账**不进**健康故障表
  （`noteFault` 一次都不调 —— 那是「代理自己有病」，被上游限流不是，两本账混了以后「代理健康」那一行永远说不清）。
  **可见化**：`relayStatus()` 每次现算（与「渲染」「健康」同一立场，**不进** `_sysStatus` 缓存 —— 刚被限流那一下界面上要看得见），
  三档 `ok` / `warn` / `err`：**只有真拒过（`拒过`）才红**，只排队 / 只重问算 warn（请求照样成功，只是慢了）。
  读法与说法只有一份：`assetlib.js` 的 `Api.relayLines(r, limit)`（`sysStatusLines` 与设置页那一行都调它，
  页面不许自己拼「在途 N · 排队 N」），`settings.html` 那一行上色读 `rl.档`、**不许拿正则猜中文**；
  旧代理没返回 `转发` 就整行不画、也**不写「没读到」**（与 `渲染` 同一立场；`健康` 那一行相反 —— 它要写「没读到」。
  两种立场各钉一次判据，别收成一条）。界面上「哪家被限过」只有那一行，出路是 `.env` 那两个键 + 重启。
  **常驻判据 `.tmp-relay.cjs`（四层：闸本体口径进 vm / relay 通路的接线位置 / `sysStatusLines` 的说法 / 设置页那一行的源码）**。
  真 HTTP 行为层为什么没做：relay 的 `base` 与 `x-up-base` 都要过 `safeOutboundUrl`（只允许公网 https），自定义条目也拦回环，
  所以「起一个假上游测真实通路」这条路被自家出站护栏挡死；`httpsRequest` 又是模块级 `const`（文件第 5 行 destructure），
  事后 monkey-patch `require('https').request` 打不到它。因此接线那一层量的是**源码位置**（`upRequest` 必须在 `relayIssue` 之内、
  `relayTake` 必须在拒绝之前、归还落点有界），排队 / 排满 / 归还 / 重试矩阵则在 vm 里用**真源码**跑满。

