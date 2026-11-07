#!/usr/bin/env node
/* SPA 架构判据（常驻）—— 跑法：`node tests/spa.cjs`
   这些判据不碰浏览器，只保证「外壳 / 路由表 / 已迁移页面」这三层的接线没有各长一份：
   旧的 app.js 不再被加载、页面清单只有一份、页面池不销毁 iframe、Vue 组件只引用本地那份 Vue。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return true; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
  return false;
}
function group(t) { console.log('\n' + t); }

/* ---------- 1. 外壳只加载 SPA 那一套 ---------- */
group('§1 外壳与路由表');
const shell = read('shell.html');
const tagAt = src => shell.search(new RegExp('<script[^>]+src="' + src.replace(/\./g, '\\.') + '"'));
ok('shell 引了 web/core/routes.js 且在 web/ui/sidebar.js 之前',
  tagAt('web/core/routes.js') >= 0 && tagAt('web/core/routes.js') < tagAt('web/ui/sidebar.js'));
ok('shell 以 module 方式引 web/app.js', /<script[^>]+type="module"[^>]+src="web\/app\.js"/.test(shell));
/* 错误通道只许有一份：横幅在 ui.js、监听器与上报在 core/report.js。
   两边都装着就是两条横幅 + 两次上报，页面里再写第三份更查不动。 */
ok('shell 引了 web/core/report.js 且早于 app.js',
  tagAt('web/core/report.js') >= 0 && tagAt('web/core/report.js') < tagAt('web/app.js'));
ok('全局错误监听器只在 report.js 那一份',
  !/window\.addEventListener\(\s*'error'/.test(read('web/ui/ui.js'))
  && (read('web/core/report.js').match(/window\.addEventListener\(\s*'error'/g) || []).length === 1);
ok('shell 不再加载旧的 app.js', !/<script[^>]+src="app\.js"/.test(shell));
ok('shell 不再有 iframe（内容由 Vue 外壳渲染）', !/<iframe\b/i.test(shell));
const allWebJs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) allWebJs.push(p);
  }
})(path.join(root, 'web'));
const bareLoad = allWebJs.filter(p => /__spaLoadScript\(\s*'(?:workbench|chars|assetlib|ident|ui|local|capabilities|text-ai|fav|prompt-log)\.js'/.test(fs.readFileSync(p, 'utf8')));
ok('动态加载脚本只用当前 web/ 路径（没有根目录旧文件名）', bareLoad.length === 0,
  bareLoad.map(p => path.relative(root, p)).join(', '));

/* ---------- 1b. 首屏重量 ---------- */
group('§1b 首屏重量');
const resident = [...shell.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
/* 页面用 __spaLoadScript 补载的脚本，同时常驻 shell.html = 对不打开那一页的人白下一次。
   zip-read.js 就是这个坏法：常驻在 shell.html 第 58 行，而唯一使用点（设置页读 Skill 包）
   本来就先问 `window.ZipRead` 再按需加载 —— 常驻那一行从来没被需要过。
   `__spaLoadScript` 见到全局已在就直接返回，所以常驻+补载不会报错，只会悄悄多下载，
   因此必须有这一条：靠人肉看 shell.html 是看不出来的。 */
const lazyScripts = new Set();
for (const p of allWebJs) {
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/__spaLoadScript\(\s*'([^']+)'/g)) lazyScripts.add(m[1]);
}
const bothResidentAndLazy = resident.filter(s => lazyScripts.has(s));
ok('按需补载的脚本不常驻 shell.html（不为一个页面白下一次）', bothResidentAndLazy.length === 0,
  bothResidentAndLazy.join(', '));
const residentBytes = resident.reduce((a, s) => a + (fs.existsSync(path.join(root, s)) ? fs.statSync(path.join(root, s)).size : 0), 0);
/* 上限是**现状**，不是舒适值：枚数或字节要涨，就把涨的那一枚和理由一起写进这里，
   并把这两个数一起改大。首屏这 31 枚是同步的，涨了直接进白屏时间。
   2026-10-19 两次改动一起记账：
     ·  −5.4KB：`web/domain/zip-read.js` 不再常驻，唯一使用点（设置页读 Skill 包）本来就按需加载；
     · +3.9KB：`web/domain/local.js` 长出 `announce()` —— 那是一份「生成完成」契约从四处收成一处，
       收在 local.js 是因为它同时是唯一消费方（scan / offer / 镜像队列都在这层），按需加载反而要让每个页面都补载它。
     同一批之后又补了「别名折完就删」与契约测试段，这一笔按 ±0 记账：local.js 里那段
     十六条的归一化散文压成一段、规则各自写回代码那一行，判据一条没少，首屏字节没有再涨。
     · 页面自注册收成路由表一条 `src`同样 ±0：routes.js 八条 `src` 换来的散文
       压进两行，app.js 那份手抄的 VIEWS 字面量与两处 `window.WB_VIEWS` 登记一起删掉。
     ·  −811B：设置键三份清单收成一张表 —— 界面偏好的键名从此只由 ui.js 的
       UI_PREFS 提供，SYNCABLE / EXPORTABLE / RESET_KEEP 各删掉自己抄的那一份，换回来的注释比省下的短。
     ·  +2 枚 / ±0B：把 assetlib.js 按已有的 window 面拆成 api.js / assetlib.js /
       gen-forms.js（两个巨型闭包有了命名空间边界）。拆出来的三份里删掉了描述别的文件的陈旧注释，
       净字节反而少了；枚数是结构拆分付的价（三份都必须同步常在，否则页面在首次取数时炸）。
     ·  +1 枚 / 净字节 +1.4KB：把 ui.js 的弹窗与表单族（InlinePolish / PromptReview /
       Confirm / UiDialog / PromptForm / DatePicker）切去 forms.js。这些面在任何页面第一次弹确认框 /
       润色 / 选日期时就要用，不能按需；ui.js 因此降到 1500 行以下，字节只多了文件头。
     ·  +1 枚 / +8.5KB：原始请求折叠条 `web/ui/raw-request.js`（4.5KB）加 `Api.snapOf` 的脱敏 /
       截断 / dataURL 摘要（约 4KB）。它监听的是 Api.request 投出的 `wb:raw-request` 事件：事件在请求
       发出的那一刻就投，晚一步补载脚本就会漏掉页面打开后的第一次生成（用户最先想看的恰好是那一次），
       所以不能按需；脱敏逻辑也只能在唯一请求出口里，页面侧再抄一份就多一套口径。
     ·  2026-10-20 原始请求改成「**发送前**就能看」之后，上面那条「不能按需」的理由**不再成立**：
       新的预览是**页面主动算**的（`RawRequest.schedule` → `Api.preview` 的纯算，不发网络请求），
       不再依赖「事件在请求发出的那一刻就投」；「已发送」那一份仍然收 `wb:raw-request` 事件，
       但那件事发生在用户点生成之后 —— 那时页面早就加载完了，不会漏。
       所以 `raw-request.js` 改成**按需补载**（导演台 / 工作台两页各自 `__spaLoadScript`），
       首屏少一枚 11.6KB 的脚本。
     ·  +4.7KB：同一天补的三样东西都落在**必须常驻**的那几份里，按需加载反而更贵：
       `api.js` 的 `buildBody` / `preview`（请求体拼装的唯一出口 —— 预览与实发共用它才保证
「预览的体 = 真发的体」，拆出去就要在两份之间同步，迟早走岔）；
       `chars.js` 的 `renameGroup`（写素材库的唯一出口，页面侧再抄一份就是第二份写库口径）
       与 `setPic` 投的那枚 `wb:char-pic`（素材出图 → 导演台自动补参考图的那条链）；
       `forms.js` 的「待建素材」块（弹窗的唯一实现，拆出去就成第二套弹窗）。
     ·  +2.0KB：素材库的音色收口（用户要求「使用素材进行描述或克隆」）：
       `chars.js` 的 `cloneFromLibEntry`（拿另一位素材的参考音频来克隆，与 `cloneFromCands`
       同一落点）+ `voiceBoxHTML` 里那两颗按钮（用素材的音色描述 / 用素材的声音克隆），
       以及 `asset-picker.js` 的「只要素材库」那两档（音色描述与参考音频只存在于素材身上）。
       `chars.js` 与 `asset-picker.js` 都是**按需补载**的（只有素材库页与导演台要），
       所以这一笔**不进首屏**；进首屏的是 `gen-forms.js` 的 `VoiceNote.runClone`
       （约 1.1KB，与 `VoiceNote.run` 同一族：拿素材库里的料填进面前那一格）。
     ·  +0.6KB：`skills.js` 的 `WbSkills.refRule` ——「素材范围优先」的读法只有这一处
       （取已启用的那些 Skill 声明的素材组）。它住在 Skill 的唯一客户端里，
       拆到导演台去就得在页面侧再抄一份读法。
     ·  +1.6KB：`gen-forms.js` 的 `window.TplVars` —— **Skill 正文里的变量占位符**
       （`{cast}` `{what}` `{board}` …）的**唯一一份填法**（「项目引用规则」就是它）。
       素材库的音色 / 生图、导演台的拆分镜 / 改分镜 / 新素材判定都走它 ——
       各写一份正则，规则迟早对不上（有一处认 `{x}` 另一处只认 `{{x}}`）。
     ·  +5.2KB：`text-ai.js` 的 `TextAI.DEF` 多了三份正文（拆分镜 / 改分镜 / 新素材判定），
       都改成**带变量占位符**的那一份，并把 `board_assets` 那一族补上。
       ⚠ `DEF` 与 `skills/` 里那份 SKILL.md **必须逐字相同**（判据 tests/e2e/smoke.cjs 守着
「内置 Skill 正文与 TextAI.DEF 漂开了」）—— 同一份提示词两处维护，改一处就要同步另一处。
       所以这一笔省不掉：变量机制要进正文，正文要进 `DEF`，`DEF` 在首屏。
     ·  +2.1KB（2026-10-21）：导出素材的取消态（rendering / assetsExporting / cancelled 收尾一行不落）、
       关键帧入口重入锁与按钮按运行态渲染、清空三处提示词、失败镜过滤 draft 占位 ——
       都是「错一次就双倍扣费 / 清不掉 / 永远进不了 todo」的判据，不能为了字节留着不修。
     ·  +9.3KB（2026-10-21，批 2–3 收口）：涨的每一份都落在首屏取数路径上，没有一份能按需：
       `ui.js` 的 mediaKindFrom / fileExtOf / blobExtOf（类型与扩展名判断的唯一实现）、LS 信封读取与
       错误文案；`assetlib.js` + `asset-picker.js` 的列表结果短缓存（资产库首屏请求 40+ → 12）；
       `local.js` 的镜像身份 mirrorIdOf / pullPlan（本机号与任务号只此一处）；`api.js` 的非 JSON 响应 /
       错误提示；`text-ai.js` 的余额解析与 LS 读取。拆出去只会让每页各补载一次，净字节反而更多。
     ·  +10.3KB（2026-10-21，批 4–5 收口）：同上，全在「页面第一次取数 / 第一次弹确认框」就要用的那份里：
       `assetlib.js` 的报价缓存 TTL + 上限与使用关系精确比对、`capabilities.js` 的声明键
       以本次为准（撤掉的档位不能留）、`local.js` 的 IDB 读失败与真为空分开 / 多标签合并、
       `asset-picker.js` 的 blob 差集回收、`datasync.js` 的原始键、
       `forms.js` 开窗前清残留模态、`skills.js` 的 force 不复用在途清单、
       `ui.js` 的 pageSizeOf 上限。把其中任何一份拆成按需，都会让每页各补载一次。
     ·  −250KB（2026-10-21）：`capabilities` / `text-ai` / `asset-picker` / `datasync` 这四份移出常驻，
       改由路由表的 `needs` 按页声明（web/core/routes.js）—— 上面那句「每页各补载一次」在这里不成立，
       因为补载走的是同一个 `__spaLoadScript` 的在途清单：一页一次、全站一份，用到的页照旧并发取，
       收藏 / 用量 / 资产库用不到的那几份整份不下。省下的是常驻那一层的串行阻塞：
       27 枚 / 794509 字节，四份都改在页面组件 `import()` 之前并发补载。
     ·  +0.8KB（2026-10-21）：路由表多管两件事，都在常驻那一层的 `routes.js` 里 ——
       `chunk`（导演台的 engine.js 由 index.js 挂载时才 `import()`，modulepreload 只走静态图，看不见这一层）
       与 `needAll`（全站 `needs` 的并集，从上面那张表现算；空闲兜底改读它，boot-assistant 不再抄一份
       src→全局 的名单，那张对照表只剩 routes.js 的 NEED_GLOBAL 一处）。涨的这 775 字节买的是把
「等 needs → 取页面 → 页面再取引擎」三段串并成一段。实跑 27 枚 / 795298 字节。
     ·  +0.9KB（2026-10-21，侧栏余额外壳收拢）：枚数不变，涨的只有 `sidebar.js` 一处 ——
       弹层（余额详情）里手抄的那一整套余额外壳收拢回公共件：新增 `balWrap`（区域容器一份）与
       `balCardsHTML`（卡列表 +「一家都没有 / 一张摆不下」那两种空态说法一份），侧栏与弹层各调同一份；
       `paintBal` 多一个 `full` 档（全量摆、不截断、不写摘要行那三个读数、不挂本机行订阅）。
       这是 dup-guard 判据 ③「表外新增重复」当场报出来的那一处（`paint` 在两个文件各一份），
       收口的代价就是这份公共件；把它拆成按需反而要让每个开弹层的页面补载侧栏。
       实跑 27 枚 / 796228 字节。
     ·  +0.65KB（2026-10-21，后台计数续拉）：枚数不变，涨的只有 `assetlib.js` 的 `countAll(opts.from)`
       —— 后台数总数**接着页面已经翻到的游标往后走**，不重回第 1 页。这一处省的是上游请求
       （首屏 fetchMore 拿回来的那几页，以前每个来源都被计数那一趟再取一遍），代码本身落在
       首屏常驻的取数那一份里，拆走等于每页各抄一份计数底座。常驻化判据在
       `tests/e2e/asset-requests.cjs`（首屏「取列表」≤12 笔 / load 轮数 ≤4 / 计数不许从空游标起 /
       同参数第二次 load 0 笔 / 有缓存时选择器 ≤300ms）。实跑 27 枚 / 796884 字节。
     ·  +4.4KB（2026-10-21 下午，用户复验左栏两处）：枚数不变，涨的是 `sidebar.js` —— 余额区
「展开全部 N 家」就地展开（`.bal-exp`）与本机产物明细行，按用户的原话做成**不跳页**；
       侧栏本来就是外壳顶层文档里的经典脚本，这份交互逻辑没有第二个落点。
       另有 api.js / capabilities.js / engine.js 几十行注释与 X15 的按家补画监听。实跑 27 枚 / 801362 字节。
     ·  +7.7KB（2026-10-22，拖素材到球的引用载荷）：+1 枚 `web/domain/asset-ref.cjs`（UMD .cjs，
       与 ident.cjs 同一套写法）—— 四个拖动源（素材库 / 收藏 / 资产库 / 工作台）与球 / 抽屉两个落点
       都要在 dragstart 那一刻写同一份载荷，而 dragstart 是同步事件，等到拖起来再补载已经晚了；
       字段白名单与引用标签只有这一份（「拖素材的引用载荷」）。实跑 28 枚 / 809273 字节。
     ·  +2.2KB（2026-10-22，导出目录）：+1 枚 `web/domain/export-dir.js` —— 浏览器 File System Access
       的句柄管理（选目录 / 写产物 / 清除），设置页与成片导出两处都要它；导出是**用户手势触发**的
       当下动作，句柄又存 IndexedDB（`Kv.at('dirs')`），补载那一下的等待会卡在「点导出」的正中间，
       所以这份不按需。实跑 29 枚 / 810671 字节。
     ·  +1.3KB（2026-10-22 晚，Skill 13.4 助手自选）：枚数不变，涨的是 `skills.js` ——
       `activeFor` 加 `opts.pinned`（用户点名指定优先、自动补位）与预算拆两份额度
       （SKILL_BUDGET 3000→2000 预载 / ON_DEMAND_BUDGET 1000 按需），`estTokens` 导出给
       chat-tools 的按需预算记账。Skill 是全站共用件（四个页面的润色入口都读它），拆按需会让每页各补一次。
       实跑 29 枚 / 814346 字节。
     ·  +1.1KB（2026-10-23，成片环境现探）：枚数不变，涨的是 `api.js` 的 `exportCaps()` ——
       代理不再转码（没有渲染队列可问），成片能不能导只能由页面问 WebCodecs；设置页与助手的
「成片环境」读同一份探测结果，而 api.js 本来就在首屏（余额与列表都在它上面）。
       实跑 29 枚 / 815511 字节。
     ·  +0.5KB（2026-10-23，导出选容器）：枚数不变，涨的还是 `api.js` 的 `exportCaps` 读数 ——
       导出按探针选容器（avc → mp4 / 只有 vp9 → webm，`MediaExport.pickCodec`），
       读数跟着对齐：补 VP9 分项、只有 vp9 也算「能用」（成片会出 .webm），别在能导的浏览器上喊「不能用」。
       实跑 29 枚 / 816051 字节。
     ·  +4.8KB（2026-10-24，本机副本「已丢失」自愈）：枚数不变，涨的是 `web/domain/local.js` ——
       ① `/asset/<平台产物号>` 加载失败先经 aid 表认本机副本再回源外链；② 账被整份重建（磁盘对账
       补的裸行没有 upstream / detail）时改指算不出键，镜像索引里指死的旧号按「名字 + 字节」
       接回当前账（healDeadPointers，两边各自唯一才接）；③ onMediaError 多一跳「记录已换活号」。
       AssetLocal 是镜像身份层，资产库 / 工作台 / 收藏的首屏取数都经它，没有第二个落点。
       实跑 29 枚 / 820872 字节。
     ·  +1.9KB（2026-10-25，左栏改成「满 232 / 窄 56」两个形态）：枚数不变，涨的是 `web/ui/sidebar.js` ——
       ① 窄形态的六项各带一枚**两字短标签**（`.sh`，文案从 `web/core/routes.js` 的 `short` 字段来）——
          收起之后也认得出，不靠悬停才知道这一项是什么；
       ② 窄形态的压缩块多画一排「**每家一个状态点**」（实心 = 取到了、空心红 = 取不到），
          56px 里放不下三个平台名，但放得下三个「各家怎么样了」；
       ③ 满形态的余额卡从三行收成**两行**（名字 + 金额 / 冻结 + 单位）—— 同一栏高度里能多摆一家。
       侧栏是**首屏同步脚本**（外壳一起加载），这三样都在它里面，挪不到按需去。
       实跑 29 枚 / 822796 字节。
     ·  +0.5KB（2026-10-25，引用标记里去掉内部号）：枚数不变，涨的是 `web/domain/asset-ref.cjs` ——
       新增 `shortLabel()`：正文里那行标记只写「这是哪一条」（号与类型不进标记），
       号留给悬停浮层与发给模型的那份清单。它必须与 `label()` 在**同一份**里 ——
       两者都读拖动载荷那份记录，而 dragstart 是同步事件，等拖起来再补载已经晚了
       （理由见上面 2026-10-22 那条），所以只能常驻在同一枚里。
       实跑 29 枚 / 823624 字节（这一笔里也含着另一处正在改首屏那几份的工作，按同一口径记账）。
     ·  +6.8KB（2026-10-25，路由/供应商审计修复）：枚数不变，涨的是 `web/app.js`、`web/core/routes.js`、
       `web/domain/api.js`、`web/ui/sidebar.js` 与 `web/render/app-error.js` ——
       ① 空 hash 落「上次页」+ hash 里多余 `#` 只取路由本体（app.js 的 parse 重写）；
       ② 按需脚本失败不再永久缓存（routes.js 的 pending 失败删键 + 旧标签分支清定时器）；
       ③ 页面失败块给「重试」按钮（app-error 模板 + ViewError.setup）；
       ④ createBody 按型号能力校验取值集合 / 模板族 topBools 过 fieldState（api.js）；
       ⑤ 侧栏设置入口读路由表 label/short（sidebar.js）。这些都在外壳与取数底座上，没有按需的落点。
       实跑 29 枚 / 830572 字节。
     ·  +0.8KB（2026-10-25，「已丢失」角标不许铺满整屏）：枚数不变，涨的是 `web/domain/local.js` ——
       角标是 `position:absolute; inset:0`，铺开的是「最近的定位祖先」：素材库检查器那格大图、
       详情层候选排那一格都不是定位容器，于是一张图挂了就变成「点一下素材卡整屏一块已丢失」。
       现在角标按图自己的盒子定位（父容器补定位 + 量出图那一格），另加一档小格的紧凑写法。
       这一笔里也含着另一处正在改首屏那几份的工作，按同一口径记账。
       实跑 29 枚 / 839397 字节。
    ·  +0.8KB（2026-10-25，收藏页「上传本地文件」入口加回来）：枚数不变，涨的是 `web/domain/fav.js` ——
      `addLocalFile` / `typeOfName` / `idbPut` 三件恢复（上传的本体进 IndexedDB，键仍由 Kv.at('fav') 管）。
      fav.js 是首屏常驻的取数底座：收藏页工具行那颗「上传本地文件」按钮与「拖文件进窗口」都落在它上面，
      补载那一下会卡在「点上传」的正中间（拖拽更是同步事件），所以只能常驻在同一枚里。
      实跑 29 枚 / 840222 字节。
     ·  +1.6KB（2026-10-25，本机条目删不掉 + 归属挂错名字）：枚数不变，涨的是 `web/domain/assetlib.js` ——
       ① remove() 给「条目即本机资产」的行（localSelf）直连 DELETE /local-assets：索引里 provider 只是
「谁生成的」注记（语音产物写平台 id，导入 / 盘上补账写「本机」/ 'local'），以前当平台 id 查注册表，
          'local' /「本机」查不到任何一家，这批卡（老版字幕烧录落下的 subtitle-*.png、导入的视频、
          盘上对账补的账）的删除键一点就抛「找不到平台」，永远删不掉；
       ② 归属显示：provider 注记解析不到平台时写「本机」，不再挂来源那家语音平台的 displayName
          （用户点名「字幕以图片形式出现、供应商显示的是语音的供应商」）。
       assetlib.js 是首屏常驻的列表归一层（资产库 / 工作台 / 收藏的取数都经它），判据 tests/asset-remove.cjs。
       实跑 29 枚 / 841788 字节。
     ·  +0.4KB（2026-10-25，「点一颗按钮，视角跳回最上面」修掉）：枚数不变，涨的是 `web/app.js` ——
       外壳装一份 `web/core/scroll-guard.js`（import + 一行 install + 那段说明注释）。
       新的那一份**不在首屏同步脚本里**：它是 ESM，由 app.js 静态 import 走模块图，
       不占 `<script>` 枚数（所以这里只记 app.js 那几行）。
       它不能按需：整片重画（`innerHTML`）随时都在发生，等它按需补载的那一下，
       第一批重画已经把滚动位吃掉了（那一族毛病正是「点一颗与滚动无关的按钮，视口被甩回顶」）。
       实跑 29 枚 / 842180 字节。
    ·  +0.9KB（2026-10-25，收藏动作下沉到 domain 层）：枚数不变，涨的是 `web/domain/fav.js` ——
      新增 `isEntry` / `addEntry` / `removeEntry` / `toggleEntry` 四个入口：
「把一条产物收进 / 拿出收藏」这一件事**只有这一份实现**（身份 = assetKey，
      收藏项 = fromEntry），页面只给「这一条能不能收」与「按钮长什么样」。
      卡面上那颗 ★ 与三页批量条上的「收藏 / 取消收藏」都走它。
      fav.js 是首屏常驻的取数底座（收藏是全站共用的数据层），挪不到按需去。
      实跑 29 枚 / 843038 字节。
     ·  +1.8KB（2026-10-27，时间线工具条那一族图标）：枚数不变，涨的是 `web/ui/ui.js` 的 `ICONS` ——
       标记四类 / 重做 / 吸附 / 波纹 / 六种选择工具 / 断链 / 回播放头共 12 枚（16×16 几何）。
       图标只有 `window.icon()` 这一张表，导演台的时间线工具条也从它取；
       另起一张导演台私有图标表就是第二份实现，所以留在这张表里。
       同一笔里也含着 `web/ui/skills.js` 的两行（install / update 的返回值）与另一处正在改首屏那几份的工作，
       按同一口径记账。实跑 29 枚 / 844835 字节。
     ·  +0.7KB（2026-10-27，轨道工具条那四颗「一段」的动作图标）：枚数不变，涨的还是 `web/ui/ui.js` 的 `ICONS` ——
       上一笔记下 12 枚，这一轮把「加一段 / 摘一段 / 缩短 / 加长」也补进同一张表（各一枚 16×16 几何）。
       这四颗是时间线工具条上的动作，画的是「一段」这个形状加加减号与箭头；图标只有 `window.icon()`
       这一张表，导演台从它取，另起一张私有表就是第二份实现。
       实跑 29 枚 / 845542 字节。
     · +0.3KB（2026-10-27，「点一颗按钮，视角跳回最上面」那份保护从外壳挪进公共件）：枚数不变，
       涨的是 `web/app.js` —— 外壳那份 `web/core/scroll-guard.js`（猴补 Element.prototype 的
       innerHTML / outerHTML / replaceChildren）整族删掉：它在全局原型上动手脚，只罩得住
「整片重画把滚动容器换掉」，罩不住「重画后内容变短被夹回上限」。现在由重画点自己调
       公共件 `Wb.viewport.keep`（`web/ui/workbench.js`，按锚点还原，导演台右栏 renderEditor 已在用）。
       这一份不能按需：它是外壳里那几行说明与公共件的注册点，且 keep 落在页面自己的重画里。
       判据 `tests/e2e/viewport-keep.cjs`（裸重画必须丢位 = 对照，套 keep 必须还回原位 = 机制，
       再加导演台右栏点按钮那一档实景）。实跑 29 枚 / 845837 字节。
     · +2.2KB（2026-10-27，标题去图标 + 视口与 focus 两份公共件收口）：枚数不变，涨的是三份常驻件 ——
       ① `web/ui/ui.js` 加 `window.focusQuiet`（`focus({ preventScroll: true })`，全站唯一一份；
          约 40 处裸 `.focus()` 改成调它，那些调用点都不具备「等它按需加载」的条件 ——
          点按钮就要续光标）；② `web/ui/forms.js` 的弹窗正文重画走 `Wb.viewport.keep`
          （`keepBodyScroll` 小件 + 三处重画点，forms.js 是首屏常驻的表单族）；
       ③ `web/app.js` 删掉外壳那份 `web/core/scroll-guard.js` 的 import 与安装，
          那几行说明改写成指向新公共件（净涨一点）。
       标题去图标（`.phead-ic` 整族删）落在 ui.css 与模板，不进首屏脚本；`Wb.kindFilter` /
       `Wb.viewport.keep` 落在 `web/ui/workbench.js`（按页补载，不常驻）。
       实跑 29 枚 / 848096 字节。
     · +2 字节（2026-10-27，剪辑核重构收尾按实跑重登记）：枚数不变，是同一批首屏件在这轮重构里的净漂移，
       没有新增脚本，也没有把新的导演台纯件（film.js / tl-*.js / engine/*.js）挂进首屏 ——
       它们由导演台页按需 import，不占 `<script>`。
       同一工作树里另一条正在进行的工作还在改首屏那几份（ui.js / datasync.js / page-context.js），
       登记值留约 1.5KB 余量：那批改动定稿后由它自己按实跑再登记回来。
     · 按实跑重登记（2026-10-29，主题两根轴：5 套配色 + 跟随系统，深色由浅色现算）：枚数不变（仍是 29 枚），
       涨的是三份首屏件 —— `web/shell-boot.js` 从「读一次 dir_theme 写进 data-theme」变成全站唯一的
       主题解析点：两根轴（data-theme 只放解析后的 light / dark，data-palette 放配色名）、matchMedia
       跟随系统、__themeApply / __sbThemeIcon 两个口；它必须同步跑在样式表之前（否则先闪一帧浅色），
       挪不到按需。`web/ui/ui.js` 是「主题配色 / 日间夜间」两行设置项（取值表与设置页、助手同源），
       `web/ui/sidebar.js` 是那颗日 / 夜按钮改调 __themeApply 并补图标回调。
       这一笔之后实跑 29 枚 / 838250 字节（登记上限 840000）。
     · 按实跑重登记（2026-10-29，页面加载提速）：枚数不变（仍是 29 枚），三份首屏件各长了几百字节 ——
       `web/core/routes.js` 每页多一格 `css`（页面样式表的唯一出处：挂载 / 预取都读它，页面组件里
       那些 ensureCss 调用因此删掉）；`web/ui/sidebar.js` 的导航项补上悬停 / 聚焦预取；
       `web/boot-assistant.js` 改成几份互不依赖的脚本一起取（chat.js 仍排最后）。
       这一笔省掉的是**往返**而不是首屏字节：没有新挂脚本，也没有把按需件挪进来。
       实跑 29 枚 / 841569 字节（登记上限 844000）。
     · 按实跑重登记（2026-10-30，本机资产索引改由代理说了算）：枚数不变（仍是 29 枚），净减约 17KB ——
       `web/domain/local.js` 整份重写（−19KB）：浏览器那套 localStorage + IndexedDB 镜像索引
       （按源分家、要备份 / 迁移 / 修复）删掉，只留当前会话的内存别名表（代理的
       `/local-assets/aliases` 快照 + 批量 locate + 落盘回执 + 列表学习四路）；`assetlib.js`
       每页批次后先 locate 再落卡，`datasync.js` / `kv.js` 同步摘掉 `sk_local_mirror` 与 `mirror_db`。
       同一笔里 ui.js / assetlib.js / sidebar.js 的别名表接线与角标多出约 6.5KB。
       没有新挂脚本，也没有把按需件挪进来。实跑 29 枚 / 824101 字节（登记上限 827000）。
     · 按实跑重登记（2026-10-30，旧本机身份不再冒充「本机」 + 设置页账号卡显示余额）：枚数不变（仍是 29 枚），
       两笔都落在首屏常驻件上，没有新挂脚本，也没有把按需件挪进来：
       ① `web/domain/local.js` / `assetlib.js` / `fav.js` —— 别名表取回来之后，缓存里留着的上一天本机号
          （`/asset/la_*`、`mirrorKey`、自产条目的 assetId）按账复核：账里没有那一行就不再算「本机」，
          地址退回平台 / 来源外链，自产条目在进界面前摘掉（`staleSelf`）。这三份是首屏取数底座
          （列表缓存、收藏地址、卡片徽标都经它们），挪不到按需；
       ② `web/ui/sidebar.js` —— 余额多两个口：`SbBalance.rowOf` / `fetchRows`（设置页账号卡上的余额
          读同一份缓存、走同一份取数），以及取回一轮后的 `sb-balance-updated` 广播。侧栏是外壳同步脚本，
          余额缓存与取数本来就在它里面。
       实跑 29 枚 / 831073 字节（登记上限 833000）。
     · 按实跑重登记（2026-10-31，启动提速批）：枚数不变（仍是 29 枚），四份首屏件各长了一点 ——
       `web/ui/sidebar.js` 的余额取数并船（refreshBalance 拆成「先画缓存」与取数体 fetchBalRows，
       balInflight 在途去重：开机一两秒里四路触发只发一轮请求）；`web/core/routes.js` 的 NEED_GLOBAL
       补 search.js（联网搜索在三张生成页静默失效的真缺陷 —— 对照表缺这一行时 test 为空，
       `__spaLoadScript` 当成「已经在了」直接返回，脚本根本不发）；`web/boot-assistant.js`
       改成 load 事件 + rIC 空闲加载（chat-tools + chat 的解析移出首屏窗口）；
       `web/app.js` 的 needs 与 import 并行（needs 全局唯一一处求值期硬读 —— 导演台右栏 ROLE_ZH —— 改迟取）。
       同一工作树里另一条进行中的工作也落在这几份常驻件里（ui.js / forms.js / assetlib.js / gen-forms.js），
       按同一口径记账。没有新挂脚本，也没有把按需件挪进来。
       实跑 29 枚 / 833807 字节（登记上限 836000）。
     · 按实跑重登记（2026-11-01，开机镜像不空转）：枚数不变（仍是 29 枚），
       这一笔落在首屏常驻件上，没有按需的落点：
       `web/domain/local.js` —— 自动 offer 在别名表取回来之前先按住，快照到了再按表判
       （空表当「没存过」会让开机那一屏把已经存过的产物整批重排进镜像队列，侧栏一路「正在存 N 份」）；
       跨刷新的待办回放也先等表。别名表是首屏取数底座，镜像队列本来就在这一份里。
       实跑 29 枚 / 836941 字节（登记上限 837000）。
     · 按实跑重登记（2026-11-01，余额显式刷新不被并船吞掉）：枚数不变（仍是 29 枚），
       变长的只有 `web/ui/sidebar.js` 一份（归一化换行后 +559 字符，其余 28 枚逐字节没动）——
       点「账户余额」抬头是这一区的**唯一**刷新入口，在途期间它要记住「这轮落定再补一轮」，
       并让补的那一轮重新快照一遍可用账号与筛选项（刚加的密钥必须出现在下一轮里）；
       取数与缓存本来就在这份首屏经典脚本里（设置页经 `window.SbBalance` 读同一份），没有按需的落点。
       实跑 29 枚 / 837974 字节（登记上限 838000）。
     · 按实跑重登记（2026-11-02，「拆成几张 / 按什么维度拆」那一排选项升公共件）：枚数不变（仍是 29 枚），
       变长的只有 `web/ui/forms.js` 一份（+108 行 · 归一化换行后 +6999 字符，其余 28 枚逐字节没动）——
       新增的是 `window.SplitPlan`（工作台图像栏「拆分片段生成」与导演台右栏「按描述生成这一镜的画面」
       共用那一排选项与那两行话术）。落 forms.js 而不是新脚本：读它的一家是 ESM 页面、一家是命令式岛，
       只有 window 面同时够得到两边，而这一族（Confirm / UiDialog / PromptForm / DatePicker）本来就在这一份里；
       另起一枚首屏脚本要多吃一次请求与解析，把公共件挪到按需则两边都得等它加载完。
       没有新挂脚本，也没有把按需件挪进来。实跑 29 枚 / 845081 字节（登记上限 846000）。
     · 按实跑重登记（2026-11-02，两处提交缺陷的修复落在首屏常驻件上）：枚数不变（仍是 29 枚）——
       `web/domain/api.js` 的 `parseItem` 收「详情端点的对象形产物」（`outputs:[{asset_id}]`；只认列表
       那种 id 串数组时，走详情的轮询永远拿不到产物号 —— 卡片已完成却没图、拆分占位卡解不了）；
       `web/domain/gen-forms.js` 的输出格式不再替平台猜（型号没声明 `output_formats` 就不发，
       SparkCine 的 img-2 硬塞 `output_format` 会被整条拒收），同一份里还修好了 `AiGen.adopt`
       （原来调用不存在的 `this.providers()`，素材库与导演台两条「认回在途出图」从来没成功过）。
       两处都在唯一实现里（轮询解析 / 生图提交），没有按需的落点。实跑 29 枚 / 846644 字节（登记上限 847800）。
     · 同一批继续落在首屏常驻件上（枚数不变，仍是 29 枚）：`workbench.js` 的占位牌 `plateHTML`
       （资产库与工作台任务态同一套）、全屏观看按钮 `fullBtnHTML`、详情里的进度实时刷新与「完整提示词」全文升级；
       `gen-forms.js` 的档位排序（清单仍按平台声明动态取，只按「快速→标准→增强→品质」摆顺序）。
       这几处都是三页共用的唯一实现，没有按需的落点。实跑 29 枚 / 847675 字节。
     · 按实跑重登记（2026-11-03，素材库「拿去生成」与「找相似」整族删除）：枚数不变（仍是 29 枚），
       变长的是 `web/ui/ui.js` 一份 —— 删掉 `ICONS.reuse` 那一行，加进 `LEGACY_KEYS` 的是 `sk_reuse`
       与 `char_opts` 那两条「为什么这一枚键已作废」的说明（这一族必须把理由写全：不写就会被后人
       当死代码删掉，盘上那份镜像下次 boot 又把键还回来）；`web/ui/datasync.js` 只是从 `NOT_SYNC`
       里摘掉 `sk_reuse` 那一个名字和那句旁注，短了几个字节。
       同批删掉的 `Wb.reuse`（workbench.js）、素材库的 dHash 那一族（pages/chars.js）与工作台那头的
       消费端（pages/studio.js）都不在这 29 枚里：workbench.js 按页补载、页面组件走模块图。
       没有新挂脚本，也没有把按需件挪进来。实跑 29 枚 / 848281 字节（登记上限 848500）。
     ·  +1 枚（2026-11-06，全局命令面板）：`web/ui/command.js` 挂在首屏。唤起键是 document 捕获阶段的
        一枚 keydown 监听，用户在任何一页、页面刚出来那一帧都可能按；按需补载会漏掉第一次按键
        （补载完还得等用户再按一次）。浮层本身已推迟到第一次唤起才画，所以只多这一枚薄脚本，
        字节上限不用动。实跑 30 枚 / 844594 字节。 */
const FIRST_SCREEN_MAX_SCRIPTS = 30, FIRST_SCREEN_MAX_BYTES = 848500;
ok(`首屏同步脚本 ${resident.length} 枚 / ${(residentBytes / 1024).toFixed(0)}KB 不超登记（${FIRST_SCREEN_MAX_SCRIPTS} 枚 / ${(FIRST_SCREEN_MAX_BYTES / 1024).toFixed(0)}KB）`,
  resident.length <= FIRST_SCREEN_MAX_SCRIPTS && residentBytes <= FIRST_SCREEN_MAX_BYTES,
  `${resident.length} 枚 / ${residentBytes} 字节 —— 只许减：新挂一枚脚本要连着写下它为什么不能按需`);
/* 助手关着的时候不该在空闲时段把 chat.js 整份下载并求值（389KB）。 */
const bootJs = read('web/boot-assistant.js');
/* 「关着不下载」必须是一条**结构**判据，不是文字顺序判据：注释里写了 ai_chat_off 也算出现，
   按先后排的判据会把「无条件清单 + 注释里提了一句」这种写法放过去（变异验证过：把 chat.js
   塞回 `var files = [...]`，文字顺序判据照旧绿）。看四件事：
     · 无条件那份清单里没有 chat.js / chat-tools.js；
     · chat-tools.js 是被一条 `if (!<闸>) files.push('web/features/chat-tools.js')` 加进来的；
     · chat.js 是被同一条闸下的 `if (!<闸>) one('web/features/chat.js')` 取回来的
       （几份互不依赖的脚本一起取之后，chat.js 不再跟在 files 里排最后，而是单排在这一步）；
     · 那道闸的变量名就出现在读 `localStorage.getItem('ai_chat_off')` 的那一行上。 */
const bootList = (bootJs.match(/var files = \[[^\]]*\]/) || [''])[0];
const bootGateChat = bootJs.match(/if\s*\(!([A-Za-z_$][\w$]*)\)\s*one\(\s*'web\/features\/chat\.js'\s*\)/);
const bootGateTools = bootJs.match(/if\s*\(!([A-Za-z_$][\w$]*)\)\s*files\.push\(\s*'web\/features\/chat-tools\.js'\s*\)/);
const bootGateVar = bootGateChat ? bootGateChat[1] : '';
ok('外壳空闲补载 chat.js 走 ai_chat_off 那道闸（关着不下载那一份）',
  !!bootGateChat && !!bootGateTools && bootGateTools[1] === bootGateVar
  && !/features\/chat\.js/.test(bootList) && !/features\/chat-tools\.js/.test(bootList)
  && bootJs.split(/\r?\n/).some(l => l.includes(bootGateVar) && /ai_chat_off/.test(l)),
  bootGateChat && bootGateTools
    ? (bootGateTools[1] === bootGateVar && bootGateVar
      ? '闸的变量 ' + bootGateVar + ' 没连着读 ai_chat_off，或 chat.js / chat-tools.js 仍在无条件清单里'
      : 'chat.js 与 chat-tools.js 不是同一道闸管的')
    : '找不到 `if (!<闸>) one(\'web/features/chat.js\')` 与 `if (!<闸>) files.push(\'web/features/chat-tools.js\')` 这两条 —— 关着也照下 389KB');

const sb = read('web/ui/sidebar.js');
ok('侧栏页面清单来自 WB_ROUTES', /WB_ROUTES[\s\S]{0,80}\.pages/.test(sb));
ok('侧栏不再自己写死页面数组', !/const\s+items\s*=\s*\[\s*\{\s*file:\s*'director\.html'/.test(sb));

/* ---------- 2. 路由表是唯一一份 ---------- */
group('§2 路由表');
const sandbox = { window: {} };
vm.runInNewContext(read('web/core/routes.js'), sandbox, { filename: 'web/core/routes.js' });
const R = sandbox.window.WB_ROUTES;
ok('WB_ROUTES 存在', !!R && Array.isArray(R.pages));
ok('页面数量 ≥ 7', R && R.pages.length >= 7, R ? String(R.pages.length) : '');
const ids = new Set(), files = new Set();
let dup = '';
for (const p of (R ? R.pages : [])) {
  if (ids.has(p.id)) dup = '重复 id：' + p.id;
  if (files.has(p.file)) dup = '重复文件：' + p.file;
  ids.add(p.id); files.add(p.file);
  /* 组件代码地址也在这一张表上（外壳的 VIEWS 由它现搭）：`src` 是相对 web/app.js 的说明符，
     少了这一条就是「路由表说有这一页、外壳搭不出组件」—— 点了不报错，只是永远转圈。 */
  if (!p.src || !/^\.\//.test(p.src)) dup = '路由条目没有组件地址 src：' + p.file;
  else if (!fs.existsSync(path.join(root, 'web', p.src.replace(/^\.\//, '')))) dup = '路由的 src 指不到文件：' + p.file + ' → ' + p.src;
  /* 页面根类同样只在这一张表上（助手快照靠它找根节点）。少了它界面不报错，快照只是退化成
     「页面：某页」一行字 —— 看不见的问题只能在这里判住。 */
  if (!p.root || !/^\.[a-z0-9-]+$/.test(p.root)) dup = '路由条目没有页面根类 root：' + p.file;
  /* 已迁到 Vue 的页面不再有同名 HTML：判据改成「HTML 或 web/pages/<id>.js 至少有一个」，
     两边都删掉才是断链。 */
  const html = path.join(root, p.file);
  const comp = path.join(root, p.id === 'director' ? 'web/director/index.js' : 'web/pages/' + p.id + '.js');
  if (!fs.existsSync(html) && !fs.existsSync(comp)) dup = '路由没有对应实现：' + p.file;
}
ok('id / 文件都不重复且都存在', !dup, dup);
ok('默认页是导演台', R && R.defaultPage === 'director.html');
ok('旧地址别名仍指向工作台页面', R && Object.values(R.alias).every(v => (R.byFile[(v || '').split('?')[0]])));
/* 助手快照那一层不许再数一遍页面：page-context.js 的 GET 按 file 点名，名单从这里现取。
   「注册了页面但助手看不见它的界面」不会报错，只是每一轮上下文里少一项 —— 只能这样判住。 */
const pcSrc = read('web/core/page-context.js');
const missingSnap = (R ? R.pages : []).filter(p => !pcSrc.includes("'" + p.file + "'")).map(p => p.file);
ok('每一页都在助手快照里点过名（页面名单不抄第二份）', missingSnap.length === 0, '缺：' + missingSnap.join(', '));

/* ---------- 3. 页面池：切页不 reload ---------- */
group('§3 keep-alive 页面池');
const core = read('web/app.js');
/* 页面组件映射只许由路由表派生。从前外壳在 VIEWS 字面量后面接了一个 `window.WB_VIEWS` 合并，
   页面在自己的模块被 import 时往里写 —— 那份合并早在路由表快照时就跑完了，写进去没人读，
   于是「页面自注册」看着像扩展点、其实是死代码，而且两张表会漂移（路由有、外壳没有 = 白屏转圈）。
   三条一起判：外壳按 R.pages 现搭 / 说明符取自 p.src / 整站再没有一处写 WB_VIEWS。 */
const wbViewsWriters = allWebJs.filter(p => /window\.WB_VIEWS\s*=/.test(fs.readFileSync(p, 'utf8')));
ok('页面组件映射由路由表现搭（外壳不再手抄第二份、WB_VIEWS 后门已关）',
  /for\s*\(const p of R\.pages/.test(core) && /import\(p\.src\)/.test(core) && wbViewsWriters.length === 0,
  wbViewsWriters.map(p => path.relative(root, p)).join(', '));
ok('页面以 KeepAlive 缓存（切页只离屏）', /KeepAlive/.test(read('web/render/app-shell.js')) && /PageFrame/.test(core) && /spa-page-host/.test(core));
ok('切页只改 display，不改 iframe.src', !/\.src\s*=\s*route\.src/.test(core) && !/frame\.src\s*=/.test(core));
ok('池里没有销毁内容页的调用', !/\.remove\(\)/.test(core) && !/removeChild\(/.test(core));
ok('启动了 hash 路由', /hashchange/.test(core));
ok('暴露了 window.appShow', /window\.appShow\s*=/.test(core));
ok('同文档页面拿到响应式可见性', /provide\('spaActiveFile'/.test(core));
ok('未迁移页面拿到 spa:page 事件', /spa:page/.test(core));
ok('有全局错误处理', /config\.errorHandler/.test(core));

/* ---------- 4. 站内跳转不再整页刷新 ---------- */
group('§4 站内跳转');
const ui = read('web/ui/ui.js');
ok('GoPage 优先走同文档 appShow', /host\.appShow\(f,\s*true\)/.test(ui));

/* ---------- 5. 已迁移页面与 Vue 组件一一对应 ---------- */
group('§5 Vue 页面');
ok('本地 Vue 构建存在', fs.existsSync(path.join(root, 'vue.runtime.esm-browser.prod.js')));
const pagesDir = path.join(root, 'web/pages');
const components = fs.readdirSync(pagesDir).filter(f => /\.js$/.test(f)).map(f => ({ name: 'web/pages/' + f, base: f.replace(/\.js$/, '') }));
components.push({ name: 'web/director/index.js', base: 'director' });
ok('至少有一个已迁移页面', components.length >= 1, String(components.length));
for (const c of components) {
  const f = c.name;
  const base = c.base;
  const src = read(f);
  ok(f + ' 从本地 vue runtime 引入', /from\s+'(?:\.\.\/\.\.\/|\.\/)vue\.runtime\.esm-browser\.prod\.js'/.test(src));
  ok(f + ' 有默认导出组件', /export\s+default\b/.test(src));
  /* 只拦「会真去取外部字节」的写法；`/^https?:\/\//` 校验、输入框 placeholder 与
     用户自填的网关模板都不是请求（这条管的是请求，不是字符串里出现 https）。 */
  ok(f + ' 不直连外部地址',
    !/\b(?:fetch|import|src|href)\s*\(?\s*['"]https?:\/\//i.test(src) &&
    !/<script[^>]+src=["']https?:/i.test(src));
  const page = base + '.html';
  /* 这一页的组件必须挂在路由表那一条上（外壳的 VIEWS 由它现搭）：按 src 反查，
     而不是看外壳有没有抄一份文件名。 */
  const want = './' + f.replace(/^web\//, '');
  const reg = R.pages.find(p => p.file === page);
  ok(f + ' 由路由表登记（页面 ' + page + ' 的 src 指向它）', !!reg && reg.src === want,
    reg ? '路由里这一条的 src 是 ' + reg.src : '路由表里没有 ' + page);
  /* 语法：把 ESM 复制成 .mjs 交给 node --check（不在项目目录里留临时文件） */
  const tmp = path.join(os.tmpdir(), 'spa-check-' + process.pid + '-' + base + '.mjs');
  fs.writeFileSync(tmp, src);
  let synOk = true, synMsg = '';
  try { cp.execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { synOk = false; synMsg = String(e.stderr || e.message).split('\n').slice(0, 2).join(' '); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  ok(f + ' 语法通过', synOk, synMsg);
}
for (const f of ['web/app.js', 'web/core/routes.js', 'web/pages/favorites.js', 'web/pages/usage.js', 'web/pages/assets.js', 'web/director/index.js']) {
  if (!fs.existsSync(path.join(root, f))) continue;
  const src = read(f);
  ok(f + ' 不含外部地址', !/https?:\/\//.test(src));
}

/* ---------- 7. 严格 CSP：模板预编译，运行时不再有编译器 ---------- */
group('§7 严格 CSP / 模板预编译');
ok('shell 带 script-src \'self\' 且没有 unsafe-eval（wasm-unsafe-eval 只放行 wasm 编译）',
  /http-equiv="Content-Security-Policy"/.test(shell) && /script-src 'self'/.test(shell)
  && !/(?:^|[\s;])'unsafe-eval'/.test(shell) && /'wasm-unsafe-eval'/.test(shell));
ok('shell 没有内联脚本（CSP 会拦）', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(shell));
ok('外壳不再引用完整版 Vue（编译器已移除）', !fs.existsSync(path.join(root, 'vue.esm-browser.prod.js')));
ok('本地 Vue runtime 存在', fs.existsSync(path.join(root, 'vue.runtime.esm-browser.prod.js')));
const compFiles = ['web/app.js', ...components.map(c => c.name)];
ok('组件源码里没有 template 字符串', compFiles.every(f => !/\btemplate\s*:/.test(read(f))));
ok('组件都接上了预编译 render', compFiles.every(f => /import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*'[^']*\/render\//.test(read(f)) || /from\s*'[^']*\/render\//.test(read(f))));
const renderDir = path.join(root, 'web/render');
/* render 清单**从模板扫出来**，不写死名字（以前这里是一行 11 个字符串的清单，
   新建一个模板忘了生成、或删了一个页面留下一份孤儿 render，都不会红）。
   现在多一个 / 少一个都红：模板与生成物必须一一对应。 */
const tplNames = fs.readdirSync(path.join(root, 'tools/vue-templates'))
  .filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, '')).sort();
const renderNames = fs.readdirSync(renderDir)
  .filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')).sort();
ok('模板都生成了 render 函数（' + tplNames.length + ' 份，清单来自 tools/vue-templates/）',
  tplNames.length > 0 && tplNames.every(n => renderNames.includes(n)),
  '缺：' + tplNames.filter(n => !renderNames.includes(n)).join(', ') + '（跑 `npm run build`）');
ok('render/ 里没有孤儿生成物（模板删了生成物没删）',
  renderNames.every(n => tplNames.includes(n)),
  '多：' + renderNames.filter(n => !tplNames.includes(n)).join(', '));
ok('render 函数引用本地 runtime（不是 "vue" 裸包名）',
  renderNames.every(n => /from "\.\.\/\.\.\/vue\.runtime\.esm-browser\.prod\.js"/.test(read('web/render/' + n + '.js'))));
let pre = null;
try { pre = cp.spawnSync(process.execPath, ['tools/precompile-vue.cjs', '--check'], { cwd: root, encoding: 'utf8' }); }
catch (e) { pre = { status: -1, stderr: String(e && e.message || e) }; }
ok('预编译产物与模板一致（npm run build:check）', pre && pre.status === 0, pre ? (pre.stdout + pre.stderr).trim().slice(-300) : '');
const appSrc = ['web/app.js', ...(R ? R.pages : []).map(p => 'web/' + p.src.replace(/^\.\//, ''))]
  .map(read).join('\n');
ok('应用代码没有 new Function / eval（注释里提历史不算）',
  !/new\s+Function\s*\(/.test(appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
  && !/(^|[^.\w$])eval\s*\(/.test(appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

/* ---------- 6. 静态资源白名单能吃下 SPA 文件 ---------- */
group('§6 静态资源');
const proxy = read('server/app.js') + read('server/routes/static.js');
for (const f of ['vue.runtime.esm-browser.prod.js', 'web/app.js', 'web/core/routes.js', 'web/pages/favorites.js']) {
  ok('代理能服务 ' + f, /\.(html\|js\|css)/.test(proxy) || /js\|css/.test(proxy));
}
ok('代理根路径仍指向 shell.html', /'\/':\s*'shell\.html'/.test(proxy));

/* ---------- 8. 视觉规范：令牌唯一来源 / 页面不写第二套主题 ---------- */
group('§8 视觉规范');
const tokensCss = read('web/styles/tokens.css');
const uiCss = read('web/styles/ui.css');
const stripCss = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const pageCss = fs.readdirSync(path.join(root, 'web/styles'))
  .filter(f => /^spa-.*\.css$/.test(f)).map(f => stripCss(read('web/styles/' + f))).join('\n');
ok('tokens.css 有间距/字号/圆角/阴影/动效令牌',
  /--sp-1/.test(tokensCss) && /--fs-1/.test(tokensCss) && /--radius-1/.test(tokensCss)
  && /--shadow-1/.test(tokensCss) && /--dur-1/.test(tokensCss));
ok('ui.css 不再定义第二套 :root / 深色主题变量',
  !/(^|\n)\s*:root\s*\{/.test(uiCss) && !/html\[data-theme="dark"\]\s*\{/.test(uiCss));
ok('页面 CSS 不再定义 :root 变量', !/(^|\n)\s*:root\s*\{/.test(pageCss));
const pageHex = (pageCss.match(/#[0-9a-fA-F]{3,8}\b/g) || []);
ok('页面 CSS 没有裸色值', pageHex.length === 0, pageHex.join(', '));
ok('公共与页面 CSS 至少在用间距/字号/圆角令牌',
  /var\(--sp-/.test(uiCss) && /var\(--fs-/.test(uiCss) && /var\(--radius-/.test(pageCss)
  && /var\(--sp-/.test(pageCss));
console.log('\n' + (bad ? '✗ ' : '✓ ') + checks + ' 项，' + bad + ' 项未通过');
process.exit(bad ? 1 : 0);
