#!/usr/bin/env node
/* 静态纪律判据（常驻）—— 跑法：`node tests/static-guards.cjs`
   下面这组「纪律」，以前只写在文档里，所以谁都能破：
     G1  HTML 串里不许出现内联事件（`onclick="…"`）—— CSP `script-src 'self'` 会拦
     G2  创建/提交调用点所在函数必须出现 `maybeSubmitted`
     G3  空 `catch {}` 必须写明原因（存量里混着真错误）
     G4  `#RRGGBB` 必须走令牌（`var(--x,#hex)` 的回退写法算走令牌）
     G5  页面侧不许出现 `_ddRebuild`（绕开 `Dropdowns.sync` 的私有物）
     G6  错误文案只许走 `errText`（最早数的 145 处各写一遍，同一个错误每页一句话）
     G7  助手每条动作都要在 ACTION_META 里登记 effect 与 route（漏一条=把花钱的当只读、按页过滤悄悄失效）
     G8  `window.__*` 后门：写了没人读的死钩子、页面挂的钩子卸载时不清
     G9  localStorage 读写必须在 try 内或经 `window.LS`（隐私模式一读就抛，页面不该各写一层）
     G10 全库只许一处 `createElement('link')`（页面 CSS 注入只剩 page-css.js 一份）
     G11 同一条 CSS 规则只许定义一处（同一选择器 + 同一规则体；页面根类下的覆盖不算）
     G12 两处 CSP（shell.html 的 meta / static.js 的响应头）都要放行 `'wasm-unsafe-eval'`
     G13 代理运行时不跑 ffmpeg / ffprobe（转码与取帧都在浏览器里）
     G16 `createElement('video')` 只许出现在 web/media-backend.js
     G24 公共件之外不许手写「滚动位存取对」（读 scrollTop → 重画 → 原样写回；还原只许 Wb.viewport 一份，表必须空）
   存量违例一律**登记在案**（下面的表），基线只许减不许增：新出现一条身份就直接红。
   表是数据表，不是一堆 `|| true`；`GUARD_WRITE=1 node tests/static-guards.cjs` 会按现状重打表，
   收敛之后照抄粘回来即可。
   判据不能是「永远绿」：本文件自带自检（--selftest 或每次运行末尾），用合成源码验证
   每个探测器**真的会报**，报不出来就红。 */
'use strict';
const fs = require('fs');
const S = require('./support.cjs');
const WRITE = process.env.GUARD_WRITE === '1';

/* ============================ 登记表 ============================ */
/* id 用「文件#符号」，counts 用「文件」—— 都不写行号：行号在天天变的文件里活不过一次提交。 */

/* G1 内联事件：现状 0 条 —— 这条表必须是空的，出现任何一条都是新的 CSP 违规。 */
const G1_INLINE_HANDLER = [];

/* G2 创建调用点没有「结果未知」判据：现状 7 处。每条都要说清「判据在哪儿」。 */
const G2_CREATE_NO_GUARD = [
  { id: 'web/pages/studio.js#createImageOnce', max: 1, why: '创建的错误出口在外层 submit（studio.js 顶层闭包里的 maybeSubmitErr），这一层只发不判；要补的是并到同一个出口' },
  { id: 'web/pages/studio.js#createVideoOnce', max: 1, why: '同上：视频那一路也靠外层 submit 兜「结果未知」' },
  { id: 'web/domain/gen-forms.js#create', max: 1, why: 'AiGen.create 只把 Api.create 的错误往上透传；「结果未知」的判据在 Api.maybeSubmitted（api.js）与调用方，本层不重复判' },
  { id: 'web/domain/assetlib.js#retry', max: 1, why: '重试的调用方 pages/assets.js:583 在外面判 uncertain；本层只透传错误' },
  { id: 'web/domain/gen-forms.js#synthTts', max: 1, why: '语音合成的调用方（pages/studio.js:1629 AiGen.synthTts）在上一层处理；本层只透传（拆文件后随 AiGen 进 gen-forms.js）' },
  { id: 'web/domain/chars.js#ttsOnce', max: 1, why: '角色配音两条出口（chars.js:1564/1659）的调用方在外面收错误；本层只透传' },
  { id: 'web/features/chat-tools.js#runGenerate', max: 1, why: '助手生成动作的另一个出口（会话里 3588 行那一路有 Api.maybeSubmitted 判据）；拆文件后随动作表进 chat-tools.js，待并到同一收口' },
];

/* G3 空 catch：现状 279 处 / 35 个文件（最早数的 396 处里含注释里举的反例，探测器只认代码）。
   ⚠ 2026-10-21 修探测器：`nonCodeMask` 以前不认正则字面量与模板串的 `${}` 嵌套，
   凡是有 `/["'“”《》]+$/` 这种带引号的字符类、或模板里再套模板的文件，从那一行起整份都算
   「注释里的例子」—— 同一份 engine.js 数出过 17 / 34 / 51 三个数，这张表谁也对不起谁。
   现在按「上一个真代码 token」判除法/正则、`${}` 按花括号深度配对，并与 @babel/parser 的真词法
   逐位对过（全库 0 处把真代码当串、残余只差模板定界符）。计数第一次成为真数：
   逐处补原因后 engine.js / ui.js / pages/chars.js 归零（整行删掉），另四行按现状收紧。
   整类收敛，按文件计数；同一文件里新增一条就红。
   原因同一句话（「空 catch 里混着真错误」），只有例外原因不同的才单独写。 */
const G3_EMPTY_CATCH = [
  { file: 'web/media-backend.js', max: 2, why: '新增：统一取帧器的 dispose / 兜底失败吞错（解码器释放失败不影响结果）' },
  { file: 'web/features/chat.js', max: 39, why: '存量：助手外壳（会话 / 渲染 / 发送）吞错的一批；工具循环与动作表已拆去 chat-tools.js' },
  { file: 'web/features/chat-tools.js', max: 7, why: '存量：随工具循环与动作表搬过来的一批（拆文件不改行为，逐处补原因或显式处理）' },
  { file: 'web/domain/assetlib.js', max: 7, why: '存量：AssetLib 列表归一化吞错的一批（拆出后只剩列表层与费用）' },
  { file: 'web/pages/settings.js', max: 21, why: '存量：设置页读盘/探测吞错的一批' },
  { file: 'web/pages/studio.js', max: 23, why: '存量：工作台吞错的一批' },
  { file: 'web/ui/workbench.js', max: 21, why: '存量：灯箱/工作台吞错的一批' },
  { file: 'web/ui/forms.js', max: 12, why: '存量：随表单族从 ui.js 原样搬来的一批（拆文件不改行为，逐处补原因或显式处理）' },
  { file: 'web/domain/local.js', max: 15, why: '存量：本机资产读盘吞错的一批' },
  { file: 'web/domain/api.js', max: 14, why: '存量：取数/媒体地址层吞错的一批（从 assetlib.js 拆出）' },
  { file: 'web/app.js', max: 15, why: '存量：前端入口吞错的一批' },
  { file: 'web/ui/datasync.js', max: 12, why: '存量：导入导出吞错的一批' },
  { file: 'web/domain/asset-picker.js', max: 11, why: '存量：选素材弹窗吞错的一批' },
  { file: 'web/director/index.js', max: 10, why: '存量：导演台装配吞错的一批' },
  { file: 'web/domain/text-ai.js', max: 9, why: '存量：文字 AI 吞错的一批' },
  { file: 'web/ui/sidebar.js', max: 8, why: '存量：侧栏吞错的一批' },
  { file: 'web/pages/assets.js', max: 6, why: '存量：资产库页吞错的一批' },
  { file: 'web/domain/fav.js', max: 5, why: '存量：收藏吞错的一批' },
  { file: 'web/domain/gen-forms.js', max: 8, why: '存量：型号/参数/配音表单族吞错的一批（从 assetlib.js 拆出）' },
  { file: 'web/core/page-context.js', max: 3, why: '存量：页面上下文吞错的一批' },
  { file: 'web/ui/kv.js', max: 3, why: '存量：键值存储吞错的一批' },
  { file: 'web/pages/studio/split.js', max: 3, why: '拆分片段的兜底解析与列表刷新吞错（拆不出方案另行报错；刷新失败下一轮重拉）' },
  { file: 'web/core/hooks.js', max: 2, why: '存量：生命周期钩子吞错的一批' },
  { file: 'web/domain/asset-transfer.js', max: 2, why: '存量：搬运/转存吞错的一批' },
  { file: 'web/ui/net.js', max: 2, why: '存量：统一网络层吞错的一批' },
  { file: 'web/ui/skills.js', max: 2, why: '存量：Skill 面板吞错的一批' },
  { file: 'web/boot-assistant.js', max: 2, why: '存量：开机助手吞错的一批；2026-10-25 新增一条 —— 空闲补载 needAll 那一路的 .catch（助手在各页的取数都自带兜底，补载失败不该变成 unhandled rejection，也不该打断串行链）' },
  { file: 'web/core/activity.js', max: 1, why: '存量：活动记录吞错的一批' },
  { file: 'web/director/fcpxml.js', max: 1, why: '存量：FCPXML 导出吞错的一批' },
  { file: 'web/director/split-assets.js', max: 1, why: '存量：拆素材吞错的一批' },
  { file: 'web/domain/asr.js', max: 1, why: '存量：转写吞错的一批' },
  { file: 'web/ui/toast.js', max: 1, why: '存量：提示条吞错的一批' },
];

/* G4 裸色值：现状 3 处 / 3 个文件（走令牌的 `var(--x,#hex)` 回退写法不算违例）。
   图表调色板已搬进 `tokens.css` 的 `--chart-*`（页面现读 CSS 变量），不再有例外；
   剩下的两类各有各的客观理由：ASS 字幕色是字幕文件格式的字段（不是 CSS）；
   canvas 2D 的 fillStyle 读不到 CSS 变量。内联 SVG 走 `stroke="currentColor"`
   + CSS 上 `color: var(--…)`（箭头已经这么改了），所以那一类不再有例外。
   只许减：把它们换成令牌 / 传色函数之后逐条删表。 */
const G4_BARE_HEX = [
  { file: 'web/domain/asset-transfer.js', max: 1, why: 'canvas 导出前置底色 fillStyle="#fff"（asset-transfer.js:21）：2D 上下文拿不到 var()，要的是「导出必须白底」这个事实' },
  { file: 'web/ui/workbench.js', max: 1, why: '缩略图铺底 fillStyle="#000"（workbench.js:1055）：同上，canvas 不认 CSS 变量' },
  { file: 'web/media-export.js', max: 2, why: '离线导出的 canvas 2D：闪白转场的 fillStyle 与字幕描边的 fillStyle（canvas 拿不到 var()，导出的画面字节必须与主题无关）' },
];

/* G5 `_ddRebuild`：Dropdowns 的私有物，页面侧一次都不该用。现状 0 处 —— 表必须是空的，
   出现任何一条都是「绕开 Dropdowns.sync 直接调私有重建」。 */
const G5_DD_REBUILD = [];

/* G6 手写错误文案：最早数的 145 处 `(e && e.message) || e` 已全部改调 `window.errText`
   （唯一实现在 web/ui/net.js，那一层自己不算）。现状 2 处，留下的都必须是「拿不到公共件」或
   「根本不是在写文案」：只许减。 */
const G6_HAND_ERROR_TEXT = [
  { file: 'web/core/actions.js', max: 1, why: 'ESM 模块在 Node 单测里也被直接 import，那边没有 net.js：兜底只退回 e.message，文案判据仍只有 errText 那一份' },
  { file: 'web/domain/api.js', max: 1, why: '这一处读 message 是「给错误分类」（判 404 / 已取消），不是给人看的那句，换成文案层反而不对' },
];

/* G7 助手动作与它的策略登记表：一张表必须是**完整**的。
   动作面（ACTS）与策略面（ACTION_META：effect / route / undo）现在是两张表，而不是从前的四张
   （ACT_ROUTE + ACTION_EFFECT + ACTION_UNDO）—— 因为漏登记的坏法实测出现过：
   `ACTION_EFFECT[id] || 'read'` 把一条花钱的动作当只读（卡片不标 irreversible、不画撤销、
   cost 的 cancel 也不声明，出事时没人知道它扣了费），而 `ACTS[k].route` 读一个不存在的字段，
   「按当前页过滤」从来没生效过。注册时已经改成当场抛（effect 与 route 都要求），
   这一条判据让「漏登记」在页面跑起来之前就红；三个方向都数：
   整条没登记的、登记了但缺 effect / 缺 route 的、登记了而动作面没这一条的。
   现状 0 条 —— 表必须是空的。 */
const G7_ACT_EFFECT = [];

/* G8 `window.__*` 后门（~20 个钩子里混着「写了没人读的死钩子」与「页面卸载没清的钩子」）。
   两种坏法分开数，因为它们会各自漂向不同的事故：
     · 写了没人读 —— 上一代外壳读它、迁移后没人读，改一处另一处还指着旧语义（`__skFlush` 那一族就是）；
     · 页面挂的钩子卸载时不清 —— 页面被 KeepAlive 留在原地，钩子却还指着已经离开的那一页，
       下一次谁调它就在离屏的 DOM 上干活（`__charsChanged` 是这一类的现场）。
   只数代码：注释里举的反例、助手提示词里提到的名字都不算写入点也不算读。
   判据要跨文件问「谁读了这一枚」，所以语料整份读一次再缓存。 */
const G8_HOOK = [
  { id: 'window.__directorSlicePaused', max: 1, why: '产品代码不读，只有两条探针拿它观测切片取帧有没有暂停（tests/e2e/director-slice.cjs、tests/e2e/ui-visual.cjs）：留着是为了「暂停了却没停」这类回归看得见；页面改成正式钩子（core/hooks.js 的登记表）之后这一条就该删' },
];

/* G9 裸 localStorage：现状 0 处 —— 表必须是空的。
   判据只认「属性读写」：`getItem/setItem/removeItem/key/clear/length`。走 `window.LS` 的调用
   没有这个属性访问，天然不命中；唯一包装 `web/ui/ui.js` 的 `LS` 每个方法自己包了 try，
   所以连 owner 都不用开例外。 */
const G9_NAKED_LS = [];

/* G10 页面 CSS 注入：`createElement('link')` 全库只许 page-css.js 那一处。
   各页从前各写一份 ensureCss（收藏/用量还只判 href 后缀），现在统一走 `ensureCss(href,tag)`；
   这一条保证没人再开第二条注入口。 */
const G10_LINK_CREATE = [
  { file: 'web/core/page-css.js', max: 1, why: '页面样式表按需挂进 head 的唯一实现' },
];

/* G11 同一条 CSS 规则只许定义一处：同一**完整选择器 + 同一规则体**。
   只按类名数会把 `.chars-page .card` 与 `.fav-page .card` 也当成重复 —— 那是各页在
   自己根类下的覆盖，允许；真正的坏法是整块规则被复制到第二个文件
   （改一处另一处不变），或同一文件里一字不差写两遍。@keyframes 的 from/to/% 不算选择器。 */
const G11_DUP_CSS = [];
/* G14 助手附件不落本机资产库：chat.js 里 Api.saveLocalAsset 的调用数登记为 0
   （附件字节只活在内存 blob:，不进索引、不出资产库、不额外占磁盘）。 */
const G14_CHAT_SAVE = [];
/* G17 素材库页走设计令牌：chars.js 里不许出现裸十六进制色值 —— 探测器**复用 G4 的
   detectBareHex**（同一个毛病只留一把尺子，不写第二套检测），这一条只是把范围锁到
   素材库页：G4 的表里有存量登记，G17 的表恒空（chars.js 一处都不许有）。 */
const G17_CHARS_HEX = [];
/* G18 样式层的裸值：尺寸（间距/字号/圆角/描边宽）、配色、令牌兜底值 —— 一律不许再写死。
   探测器**复用 tools/tokenize-css.cjs 的规则表**（值→令牌的那张映射只有一份，
   体检、替换、判据都从这里出），这一条只负责「谁来扫、扫哪些文件」。
   tokens.css 本身不在扫描范围内 —— 那里是**值的定义处**，写裸 px 是它的本职。 */
const G18_STYLE_BARE = [];
/* G12 两处 CSP 都必须放行 WebAssembly 编译：mediabunny 的解码 / 编码走 wasm，
   少一处（meta 或响应头）页面一用取帧就整片 CSP 报错。这一条是「缺了就红」，表恒空。
   两处分别是 shell.html 的 meta 与 server/static.js 下发的响应头 —— 只改一处就是这条判据的现场。 */
const G12_CSP_WASM = [];
/* G13 代理运行时不跑外部转码器：取帧、抽音轨、合成成片全在浏览器里（MediaBackend / MediaExport），
   代理只做取数与落盘。这一条只数**代码**（注释里说「这里不跑 ffmpeg」不算违例）。
   表恒空 —— 出现任何一条就是「又有人把转码搬回服务端」。 */
const G13_NO_FFMPEG = [];
/* G16 `<video>` 解码器只许在 media-backend.js 里造：切片、导出兜底、缩略图全调它的口。
   别处再造一只就是第二套取帧链（暂停、释放、seek 超时各写一遍，行为迟早漂开）。表恒空。 */
const G16_VIDEO_CREATE = [];

/* ============================ 探测器 ============================ */
const ON_EVENTS = 'click|load|error|input|change|submit|focus|blur|keydown|keyup|scroll|toggle|abort|mouseover|mouseout|mousemove|dblclick|contextmenu|paste|copy|cut|wheel|touchstart|touchend|touchmove|pointerdown|pointerup|select|drag|dragstart|dragover|drop|animationend|animationstart|animationiteration|transitionend';
const ON_INLINE_ATTR = new RegExp('\\son(?:' + ON_EVENTS + ')\\s*=\\s*["\'`]', 'i');
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
/* G2 认的是「**真的会发出去**的创建调用」：
     · `Api.create(` / `Api.createBody(` 里的 createBody 是**纯算**（拼体，不发网络请求）——
       它算出来的那份是「将要发的请求体」，还没有发出去，所以**没有**「结果未知」可言。
       真正发出去的是 `Api.create(` 与 `Api.request(..., 'create', ...)`。
     · `Api.preview(` 同样是纯算（dry-run），不在这条判据里。
   以前用 `create[A-Za-z]*` 一网打尽，把纯算的那几个也算了进来 ——
   于是「算一份请求体」被当成了「发一次请求」，逼着人在纯算的地方硬写一句判据。 */
const CREATE_CALL = /Api\.(?:create\s*\(|request\s*\([^;]{0,200}?['"`]create['"`])/g;
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/* 模板串里的 ${…} 是 JS 代码不是 HTML：`el.onclick = f` 写在插值里不算内联事件。
   剥掉插值体之后再看剩下的部分（`onclick="…"` 这种才是真违例）。 */
function htmlParts(text) {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let d = 1; i += 2;
      while (i < text.length && d) { if (text[i] === '{') d++; else if (text[i] === '}') d--; i++; }
      out += ' ';
      continue;
    }
    out += text[i++];
  }
  return out;
}

function detectInlineHandler(file, src) {
  const out = {};
  for (const L of S.literals(src)) {
    if (!/[<>]/.test(L.text)) continue;                 // 只看「像 HTML 的那一段」
    const html = htmlParts(L.text);
    if (!/[<>]/.test(html)) continue;
    const re = new RegExp(ON_INLINE_ATTR.source, 'gi');
    let m;
    while ((m = re.exec(html))) {
      const id = file + '#on' + m[0].replace(/^[\s"'/]*|["'/].*$/g, '').toLowerCase();
      out[id] = (out[id] || 0) + 1;
    }
  }
  return out;
}
function detectCreateNoGuard(file, src) {
  const out = {};
  const funcs = S.functionsIn(src);
  let m;
  CREATE_CALL.lastIndex = 0;
  while ((m = CREATE_CALL.exec(src))) {
    const fn = S.enclosingFunction(funcs, m.index);
    const body = fn ? src.slice(fn.bodyStart, fn.bodyEnd + 1) : src;
    if (/maybeSubmitted|maybeSubmitErr/.test(body)) continue;
    const id = file + '#' + (fn ? fn.name : '<top>');
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}
/* 注释 / 字符串覆盖的位置：判据只数**代码里**的空 catch。
   文档注释里举的反例（`再包一层 try { … } catch {}`）不是违例，把它算进去会让
   「数一下现状」这件事永远对不上，谁也不信这张表了。
   ⚠ 必须跳过**正则字面量**：`/["'“”《》]+$/` 这种字符类里带引号的写法，早先的版本把
   那个 `"` 当成字符串开头，一路吃到下一个引号 —— 从这一行起整份文件都算「注释里的例子」，
   于是 engine.js 的计数随附近代码怎么动而乱跳（实测同一份代码 17 / 34 两个数），
   「登记 22」这种数字永远和代码对不上。数不对的判据等于没有判据。
   `/` 是除法还是正则，按「上一个真代码 token」判：标点后与 return 这类关键字后才是正则。 */
const BEFORE_REGEX_KW = /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
const BEFORE_REGEX_PUNCT = '(,=:[!&|?{};+-*%~^<>';
/* `@str` / `@re` 是「上一个 token 是字符串或正则」的记号：紧跟它们的 `/` 一定是除法。 */
function mayBeRegex(last) {
  if (!last) return true;
  if (last[0] === '@') return false;
  if (/^[A-Za-z_$]/.test(last)) return BEFORE_REGEX_KW.test(last);
  return BEFORE_REGEX_PUNCT.includes(last);
}
/* 模板串要按**嵌套**扫：`` `…${x.join(',') && `内层 ${y}`}…` `` 里那枚内层反引号，
   早先的写法当成外层串的结尾，于是后半份文件在「串里 / 串外」之间来回错 ——
   真实代码里的 `catch {}` 与裸 `localStorage` 会被当成「注释里的例子」跳过，
   注释里的反例又会被当真违例数进来。同一份代码数出两个数，判据就没人信了。
   规则：模板正文整段遮掉；遇到 `${` 进代码态并压一层花括号深度，花括号配平的那个 `}` 回到模板态。 */
function nonCodeMask(src, comments) {
  const mask = new Uint8Array(src.length);
  const set = (a, b) => { for (let k = a; k < b && k < src.length; k++) mask[k] = 1; };
  const isWord = c => /[A-Za-z0-9_$]/.test(c);
  const tpl = [];                       // 每一层 `${` 所在的花括号深度
  let i = 0, last = '', depth = 0, inTpl = false;
  while (i < src.length) {
    const c = src[i];
    if (inTpl) {
      if (c === '\\') { set(i, i + 2); i += 2; continue; }
      if (c === '`') { set(i, i + 1); i++; inTpl = false; last = '@str'; continue; }
      if (c === '$' && src[i + 1] === '{') { set(i, i + 2); i += 2; inTpl = false; tpl.push(depth); depth++; last = '{'; continue; }
      set(i, i + 1); i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const s = i; while (i < src.length && src[i] !== '\n') i++;
      set(s, i); if (comments) comments.push([s, i]); continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const s = i; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2;
      const e = Math.min(i, src.length);
      set(s, e); if (comments) comments.push([s, e]); continue;
    }
    if (c === '"' || c === "'") {
      const s = i; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === c) break; i++; }
      set(s, i + 1); i++; last = '@str'; continue;
    }
    if (c === '`') { set(i, i + 1); i++; inTpl = true; continue; }
    if (c === '/' && mayBeRegex(last)) {
      const s = i; i++; let cls = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;                                          // 正则不跨行：当它不是正则，退回逐字扫
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        i++;
      }
      if (src[i] === '/') {
        i++; while (i < src.length && /[gimsuyd]/.test(src[i])) i++;     // 吃掉 flags
        set(s, i); last = '@re'; continue;
      }
      i = s + 1; last = '/'; continue;                                  // 没闭合：那一枚 `/` 按除法算
    }
    if (c === '{') { depth++; i++; last = '{'; continue; }
    if (c === '}') {
      if (depth > 0) depth--;
      if (tpl.length && depth === tpl[tpl.length - 1]) { tpl.pop(); set(i, i + 1); i++; inTpl = true; continue; }
      i++; last = '}'; continue;
    }
    if (isWord(c)) { const s = i; while (i < src.length && isWord(src[i])) i++; last = src.slice(s, i); continue; }
    i++; last = c;
  }
  return mask;
}
function detectEmptyCatch(file, src) {
  const out = {};
  const mask = nonCodeMask(src);
  let m;
  EMPTY_CATCH.lastIndex = 0;
  while ((m = EMPTY_CATCH.exec(src))) {
    if (mask[m.index]) continue;                          // 注释/字符串里的反例不算
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}
function detectBareHex(file, src) {
  const out = {};
  for (const L of S.literals(src)) {
    HEX_COLOR.lastIndex = 0;
    if (!HEX_COLOR.test(L.text)) continue;
    if (/var\(--/.test(L.text)) continue;                // `var(--令牌,#hex)` 是允许的写法
    HEX_COLOR.lastIndex = 0;
    out[file] = (out[file] || 0) + (L.text.match(HEX_COLOR) || []).length;
  }
  return out;
}
function detectDdRebuild(file, src) {
  const out = {};
  if (/(^|\/)ui\/ui\.js$/.test(file)) return out;        // 定义方（owner）自己不算违例
  const n = (src.match(/_ddRebuild\b/g) || []).length;
  if (n) out[file + '#_ddRebuild'] = n;
  return out;
}
/* 手写错误文案的三种形状：`(e && e.message) || X`、`e && e.message ? …`、`e.message || String(e)/e`。
   不抓 `String(e && e.message)`（那是拿 message 做身份比对，不是在拼文案），也不抓
   `console.warn(…, e && e.message)`（递的是对象，控制台自己展开）。 */
const HAND_ERR_TEXT = /\be\s*&&\s*e\.message\s*(?:\)\s*\|\||\?)|\be\.message\s*\|\|\s*(?:String\s*\(\s*e\s*\)|e(?![.\w]))/g;
function detectHandErrorText(file, src) {
  const out = {};
  if (/(^|\/)ui\/net\.js$/.test(file)) return out;       // 唯一实现所在层自己不算
  const mask = nonCodeMask(src);
  let m;
  HAND_ERR_TEXT.lastIndex = 0;
  while ((m = HAND_ERR_TEXT.exec(src))) {
    if (mask[m.index]) continue;
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}
/* 取一个「2 空格缩进的 const 对象字面量」的整块行（到那一条 `  };` 为止）。
   按行而不是按括号配对：ACTS 的 arg 全是带 `{ }` 的 JSON 字符串，括号配对会把块切歪。 */
function constBlockLines(src, name) {
  const L = String(src).split(/\r?\n/);
  const s = L.findIndex(l => new RegExp('^ *const ' + name + ' = *\\{').test(l));
  if (s < 0) return null;
  const body = [];
  for (let i = s + 1; i < L.length; i++) {
    if (/^ {2}\}/.test(L[i])) return body;
    body.push(L[i]);
  }
  return body;
}
function detectActEffect(file, src) {
  const out = {};
  const a = constBlockLines(src, 'ACTS');
  const m = constBlockLines(src, 'ACTION_META');
  if (!a || !m) return out;                              // 没有这两张表的文件天然不参与
  const ids = [...new Set(a.filter(l => /^ {4}[a-z_][a-z0-9_]*: *\{/.test(l))
    .map(l => l.match(/^ {4}([a-z_][a-z0-9_]*):/)[1]))];
  /* 策略表一行一条：`fill: { effect: 'ui', route: '*' },`。整行取回来再判，
     因为「写了这一条但漏了 route」和「整条没写」是两种不同的坏法。 */
  const meta = {};
  for (const l of m) {
    const mm = l.match(/^ {4}([a-z_][a-z0-9_]*): *\{(.*)\}/);
    if (mm) meta[mm[1]] = mm[2];
  }
  for (const id of ids) {
    const body = meta[id];
    if (body == null) { out[file + '#缺策略登记：' + id] = 1; continue; }
    if (!/effect: *'(?:read|ui|write|cost)'/.test(body)) out[file + '#缺 effect：' + id] = 1;
    if (!/route: *(?:'\*'|'[^']+'|[A-Z][A-Z0-9_]*)/.test(body)) out[file + '#缺 route：' + id] = 1;
  }
  for (const k of Object.keys(meta)) if (!ids.includes(k)) out[file + '#登记了但没有这条动作：' + k] = 1;
  return out;
}
/* 只留代码：注释与字符串里的名字一律抹成空格（长度不变，下标还能对上）。
   跨文件问「谁读了这一枚钩子」时必须这样数：助手提示词里那句「调用 window.__X」
   不是使用点，文档注释里举的反例也不是。 */
function codeOnly(src) {
  const mask = nonCodeMask(src);
  const a = String(src).split('');
  for (let i = 0; i < a.length; i++) if (mask[i]) a[i] = ' ';
  return a.join('');
}
/* 语料只读一次（这一条判据天生要跨文件）：整份 web 源码的「代码层」文本。
   **逐份遮好再拼**：拼接整份原文再遮，会把上一份里那个「扫描器看不闭合」的引号
   一路吃到下一份的开头（实测少了 200 多个字符、四条钩子的使用点全被遮掉），
   于是「有人读」被读成「没人读」—— 判据就变成了一批假违例。 */
let hookCorpus = null;
function hookCorpusCode() {
  if (hookCorpus == null) hookCorpus = S.webSources().map(p => codeOnly(S.read(S.rel(p)))).join('\n;\n');
  return hookCorpus;
}
const HOST_OBJ = '(?:window|globalThis|self)';
/* `try { … }` 体的字符区间（注释/字符串里的花括号已被抹成空格，配对只认真代码）。
   catch 体不算：try 里抛出的读盘错误由 catch 接住才叫「读坏了有退路」。 */
function tryRanges(src, mask) {
  const out = [];
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index]) continue;
    const start = m.index + m[0].length - 1;
    let d = 0, i = start;
    for (; i < src.length; i++) {
      if (mask[i]) continue;
      if (src[i] === '{') d++;
      else if (src[i] === '}' && --d === 0) break;
    }
    out.push([start, i]);
  }
  return out;
}
const NAKED_LS = /\blocalStorage\s*\.\s*(?:getItem|setItem|removeItem|key|clear|length)\b/g;
function detectNakedLocalStorage(file, src) {
  const out = {};
  const mask = nonCodeMask(src);
  const ranges = tryRanges(src, mask);
  let m;
  NAKED_LS.lastIndex = 0;
  while ((m = NAKED_LS.exec(src))) {
    if (mask[m.index]) continue;
    if (ranges.some(([a, b]) => m.index > a && m.index < b)) continue;
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}
/* 连注释里那句「只有这一处」也不能算：按代码层过滤，注释里的举例天然不命中。 */
const LINK_CREATE = /document\.createElement\(\s*['"]link['"]\s*\)/g;
function detectLinkCreate(file, src) {
  const out = {};
  const mask = nonCodeMask(src);
  let m;
  LINK_CREATE.lastIndex = 0;
  while ((m = LINK_CREATE.exec(src))) {
    if (mask[m.index]) continue;
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}
/* G12：这两份文件的 CSP 里必须出现 `'wasm-unsafe-eval'`（缺一处就是整片取帧报 CSP 违规）。
   判据没有「数几处」的语义 —— 有就是过，没有就是红。 */
function detectCspWasm(file, src) {
  return /'wasm-unsafe-eval'/.test(src) ? {} : { [file + '#没放行-wasm-unsafe-eval']: 1 };
}
/* G13 只数代码：注释里写「这里不跑 ffmpeg」不算违例，字符串里的 `'ffmpeg'` 恰恰就是违例
   （那正是 spawn 出去的那条命令），所以这一条剥注释、留字符串。 */
const FFMPEG_WORD = /\bff(?:mpeg|probe)\b/g;
function detectFfmpeg(file, src) {
  const code = S.stripComments(src);
  const n = (code.match(FFMPEG_WORD) || []).length;
  return n ? { [file]: n } : {};
}
/* G16 只数代码：注释里举例说明「不许自己 createElement('video')」不算违例。 */
const VIDEO_CREATE = /document\.createElement\(\s*['"]video['"]\s*\)/g;
function detectVideoCreate(file, src) {
  if (file === 'web/media-backend.js') return {};          // 唯一允许的那一份
  const out = {};
  const mask = nonCodeMask(src);
  let m;
  VIDEO_CREATE.lastIndex = 0;
  while ((m = VIDEO_CREATE.exec(src))) {
    if (mask[m.index]) continue;
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}
/* G14 助手附件不落本机资产库：chat.js 里不许再有 Api.saveLocalAsset 的调用。
   附件字节只活在内存（blob:），不进索引、不出资产库、不额外占磁盘 ——
   模型读图用 File、视频/音频模型不读、文本只存快照，落盘没有用处。 */
const SAVE_LOCAL_ASSET = /Api\.saveLocalAsset\b/g;
function detectChatSaveLocal(file, src) {
  const out = {};
  const mask = nonCodeMask(src);
  let m;
  SAVE_LOCAL_ASSET.lastIndex = 0;
  while ((m = SAVE_LOCAL_ASSET.exec(src))) {
    if (mask[m.index]) continue;
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}
/* 样式表全量只在第一次问的时候读一遍：跨文件重复天生要整份语料。 */
let cssRuleIndex = null;
function cssFiles() {
  return fs.readdirSync(S.abs('web/styles'))
    .filter(f => /\.css$/.test(f)).sort()
    .map(f => 'web/styles/' + f);
}
/* G18 要扫的范围：样式表 + 模板里的 <style> 块 + JS 的行内 style。
   tokens.css 是**值的定义处**，不扫（那里写裸 px 是它的本职）；
   web/render/ 是预编译生成物，不扫。 */
function styleSources() {
  const out = [];
  const walk = (dir, skipTokens) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === 'render' || e.name === 'vendor') continue;
      const p = dir + '/' + e.name;
      if (e.isDirectory()) walk(p, skipTokens);
      else if (/\.(css|html|js|mjs|cjs)$/.test(e.name)) {
        const rel = S.asRel(p);
        if (skipTokens && rel.endsWith('web/styles/tokens.css')) continue;
        out.push(rel);
      }
    }
  };
  walk(S.abs('web'), true);
  /* 模板源（tools/vue-templates/*.html）也扫：它预编译进 web/render/*.js，等于活代码。 */
  walk(S.abs('tools/vue-templates'), false);
  return out.sort();
}
/* G19 主题是三层：① 段只放别名（--bg: var(--bg-base)），①a 放全站唯一的浅色真值
   （--bg-base:#f2f3f9），深色档由基色现算（--bg: oklch(from var(--bg-base) 0.160 c h)）。
   配色块只覆盖 --acc-base / --acc2-base / --pri-base 三枚，且只能单挂 data-palette。
   三层各有各的坏法，分开数：
     · 别名不指基色 / 基色没定义 / 基色没有别名 —— 换色时有一层空转；
     · 深色档里写 *-base 或写死色值 —— 浅色那份真值被盖掉、深色不再跟着配色走；
     · 配色块叠上 data-theme / 多写别的语义色 —— 换配色只在一档生效，或带着别的一起漂。
   拼错的名字不会报错，只是**静默失效**。 */
const G19_THEME_PAIR = [];
function detectThemePair(file, src) {
  const out = {};
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const declsOf = block => {
    const map = new Map();
    for (const part of block.split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      if (!/^--[\w-]+$/.test(k)) continue;
      map.set(k, part.slice(i + 1).trim().replace(/\s+/g, ' '));
    }
    return map;
  };
  /* ---------- ① 段：别名指回同名基色，基色必须定义且都有别名 ----------
     段标记写在注释里，所以切片的起点要挪到**那条注释的开头**：从标记处切会把
     前半条注释留在段里，注释里的示例 `--bg: var(--bg-base)` 就会被当成一条声明
     （键名带着注释文字、正则不认 → 那枚别名整个消失）。 */
  const commentOpen = needle => {
    const i = src.indexOf(needle);
    return i < 0 ? -1 : src.lastIndexOf('/*', i);
  };
  const a = commentOpen('① 主题色');
  const b = a < 0 ? -1 : commentOpen('①b');
  const theme = declsOf(a < 0 ? '' : strip(src.slice(a, b > a ? b : undefined)));
  if (!theme.size) out[file + '#找不到「① 主题色」段（别名 + ①a 基色都在这段里）'] = 1;
  for (const [name, val] of theme) {
    if (name.endsWith('-base')) {
      if (/var\(/.test(val)) out[file + '#' + name + ' 又指回变量（基色要写死值）'] = 1;
      continue;
    }
    if (val !== 'var(' + name + '-base)') {
      out[file + '#' + name + ' 的值不是 var(' + name + '-base)（① 段只放别名）'] = 1;
    }
    if (!theme.has(name + '-base')) out[file + '#①a 里没有 ' + name + '-base（' + name + ' 没有浅色真值）'] = 1;
  }
  for (const name of theme.keys()) {
    if (name.endsWith('-base') && !theme.has(name.slice(0, -5))) {
      out[file + '#' + name + ' 没有对应的语义别名（死基色）'] = 1;
    }
  }
  /* ---------- 深色档：每枚主题色都要覆盖，且只能是从基色推导 ---------- */
  const dark = declsOf(strip((src.split('html[data-theme="dark"] {')[1] || '').split('}')[0]));
  for (const name of theme.keys()) {
    if (!name.endsWith('-base') && !dark.has(name)) out[file + '#深色档没覆盖主题色 ' + name] = 1;
  }
  for (const [name, val] of dark) {
    if (name.endsWith('-base')) {
      out[file + '#深色档里重设了基色 ' + name + '（浅色真值只在 ①a）'] = 1;
      continue;
    }
    if (/^--shadow-/.test(name)) continue;                   // 阴影可以写死
    if (name === '--atbg') {
      if (!/^color-mix\(in srgb, var\(--txt\) var\(--a-[\d.]+%?\), transparent\)$/.test(val)) {
        out[file + '#深色档的 --atbg 不是 color-mix(in srgb, var(--txt) var(--a-*), transparent)：' + val.slice(0, 60)] = 1;
      }
      continue;
    }
    if (!new RegExp('^oklch\\(from var\\(--' + name.slice(2) + '-base\\) [\\d.]+ c h\\)$').test(val)) {
      out[file + '#深色档的 ' + name + ' 不是 oklch(from var(' + name + '-base) <L> c h)：' + val.slice(0, 60)] = 1;
    }
  }
  /* ---------- 配色块：单挂 data-palette，只覆盖三枚基色 ---------- */
  for (const m of strip(src).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel.includes('data-palette')) continue;
    const hit = /^html\[data-palette="([\w-]+)"\]$/.exec(sel);
    if (!hit) { out[file + '#配色块的选择器必须单挂 data-palette：' + sel.slice(0, 60)] = 1; continue; }
    if (hit[1] === 'violet') out[file + '#violet 就是 ①a 的基色，不该有自己的块'] = 1;
    const body = declsOf(m[2]);
    const extra = [...body.keys()].filter(k => !['--acc-base', '--acc2-base', '--pri-base'].includes(k));
    if (extra.length) out[file + '#' + hit[1] + ' 块里多写了 ' + extra.join(' / ') + '（配色只换强调色）'] = 1;
    const acc = body.get('--acc-base') || '';
    if (!/^#[0-9a-fA-F]{6}$/.test(acc)) out[file + '#' + hit[1] + ' 的 --acc-base 不是六位色值：' + acc] = 1;
    for (const k of ['--acc2-base', '--pri-base']) {
      if (body.get(k) !== 'var(--acc-base)') out[file + '#' + hit[1] + ' 的 ' + k + ' 必须等于 var(--acc-base)'] = 1;
    }
  }
  return out;
}

/* G21 透明度阶梯：color-mix 的百分比只许从 --a-* 阶梯里取（阶梯本身在 tokens.css）。
   存量是布局重构前留下的零星百分比，登记在案、只许减不许增 ——
   新写的淡底不许再自己编一个百分比。 */
const G21_ALPHA = [
  { file: 'web/director/template.html', max: 34, why: '导演台深底配色那族的淡底/描边透明度（62/45/96/25/6/42/94/70/5/85/40/68/65/7/13/3/78/86/9/88/32/75/92/0 等零星档）：它们是**深底上的自定义强度**，跟阶梯里的档不是同一套语义；等布局重构那轮定了「深底强度」怎么收，再并进阶梯' },
  { file: 'web/styles/ui.css', max: 9, why: '共享件里的零星档（深底浮层上的遮罩与描边强度）：同理，深底浮层的强度与浅底淡底不是一套；收进阶梯前先留在这里' },
  { file: 'web/styles/spa-chars.css', max: 0, why: '素材库重排之后那一页的淡底强度全部收进阶梯了（原两处深底选中环已删）' },
  { file: 'web/styles/chat.css', max: 1, why: '助手面板的一处深底遮罩强度：同上' },
  { file: 'web/styles/spa-studio.css', max: 1, why: '工作台缩略图播放钮的一处深底遮罩强度：同上' },
];
let alphaLadderCache = null;
function alphaLadder() {
  if (alphaLadderCache) return alphaLadderCache;
  alphaLadderCache = new Set();
  try {
    const t = S.read('web/styles/tokens.css');
    for (const m of t.matchAll(/--a-(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)%/g)) alphaLadderCache.add(m[2]);
  } catch (e) { /* 令牌表读不到：阶梯为空，等于全部报出来（保守） */ }
  return alphaLadderCache;
}
function detectAlphaLadder(file, src) {
  const out = {};
  const ladder = alphaLadder();
  const re = /color-mix\(in srgb, var\(--[\w-]+\) (\d+(?:\.\d+)?)%, transparent\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (ladder.has(m[1])) continue;
    out[file] = (out[file] || 0) + 1;
  }
  return out;
}

/* G20 页面补丁里不许出现**顶层**公共类：公共层（ui.css / wb.css）已经有的类，
   页面文件再自己定义一遍 = 第二份实现（两份各自演化，迟早对不上）。
   页面的差异必须挂在页面根类下（.chars-page .card / .studio-page .task …）。
   现状 0 处 —— 这条是守住现状的栏杆，不是清存量。 */
const G20_TOPLEVEL = [];
let publicClassCache = null;
function publicClasses() {
  if (publicClassCache) return publicClassCache;
  publicClassCache = new Set();
  for (const f of ['web/styles/ui.css', 'web/styles/wb.css']) {
    try {
      const src = S.read(f);
      for (const m of src.matchAll(/(^|[},])\s*\.(-?[_a-zA-Z][\w-]*)/g)) publicClassCache.add(m[2]);
    } catch (e) { /* 公共层读不到：集合为空，等于不报（保守） */ }
  }
  return publicClassCache;
}
function detectToplevelPublic(file, src) {
  const out = {};
  const pub = publicClasses();
  const re = /(^|[},])\s*\.(-?[_a-zA-Z][\w-]*)\s*[,{]/g;
  let m;
  while ((m = re.exec(src))) {
    const cls = m[2];
    if (!pub.has(cls)) continue;
    const idx = m.index + m[1].length;
    const line = src.slice(idx, src.indexOf('\n', idx)).trim();
    out[file + '#顶层定义了公共类 .' + cls + '：' + line.slice(0, 60)] = 1;
  }
  return out;
}
function pagePatchFiles() {
  return fs.readdirSync(S.abs('web/styles'))
    .filter(f => /^spa-.*\.css$/.test(f))
    .sort()
    .map(f => 'web/styles/' + f);
}

/* G22 断点只许用登记的那几档：媒体查询里的 px **不能**用 CSS 变量共享
   （var() 在 @media 里不成立），所以断点值只能靠「集合 + 判据」来防漂移。
   档位名单只有 `tests/support.cjs` 的 BREAKPOINTS 一份（文档契约读同一份），
   新增断点要在那一行里加进去，并写清为什么不能并到已有档。 */
const G22_BREAKPOINT = [];
const BP_ALLOWED = new Set(S.BREAKPOINTS);
function detectBreakpoint(file, src) {
  const out = {};
  const re = /@media\s*\((?:max|min)-width:\s*(\d+)px\)/g;
  let m;
  while ((m = re.exec(src))) {
    const n = Number(m[1]);
    if (BP_ALLOWED.has(n)) continue;
    out[file + '#用了没登记的断点 ' + n + 'px'] = 1;
  }
  return out;
}

/* G23 代码注释只解释功能本身，不写文档引用：文档名 / 章节号 / 报告 / 方案 / 任务号 / 缺陷号 /
   提交号，也不写「指向某文档」这类指路。代码文件、判据文件、函数名不算文档引用 —— 那是读代码的人
   当场能核对的事实，指出来不算偷懒。
   现状 0 处：这条是守住现状的栏杆，不是清存量。 */
const G23_COMMENT_REF = [];
const COMMENT_REF = [
  { why: '文档名', re: /AGENTS(?:\.md)?/ },
  { why: '章节号', re: /§\s*[\d一二三四五六七八九十]/ },
  { why: '指路', re: /(?:详见|参见|参阅|另见|见(?:上文|下文|前文|后文))/ },
  { why: '编号', re: /(?:批次|任务|缺陷|问题|报告|方案)\s*(?:号|[#＃])\s*\d+/ },
  { why: '外部单号', re: /(?:issue|commit|PR)\s*[#＃]?\s*[0-9a-f]{4,}/i },
];
function detectCommentRef(file, src) {
  const out = {};
  const ranges = [];
  nonCodeMask(src, ranges);
  for (const [a, b] of ranges) {
    const text = String(src).slice(a, b);
    for (const p of COMMENT_REF) {
      const m = p.re.exec(text);
      if (!m) continue;
      const snippet = text.replace(/\s+/g, ' ').slice(0, 80);
      out[file + '#' + p.why + ' ' + JSON.stringify(m[0]) + '：' + snippet] = 1;
      break;
    }
  }
  return out;
}
/* 注释的射程是全部人写的源码（web / server / tests / tools / proxy.js），不只是 web。 */
function commentSources() {
  return [...S.webSources(), ...S.serverSources(), ...S.walk(S.abs('tests')), ...S.walk(S.abs('tools')), S.abs('proxy.js')];
}

/* G24 公共件之外不许手写「滚动位存取对」：同一个函数里把 scrollTop/scrollLeft 读进局部变量、
   又 innerHTML / replaceChildren 整片重画、再把读数原样写回 —— 重画换掉子树之后容器可滚上限
   已经变了，同步回写会被钳在旧上限上，表现是「点一下按钮，那一格跳回顶部」。
   要还滚动位走公共件 Wb.viewport.keep(el, fn)（web/ui/workbench.js，锚点还原），
   它是全站唯一允许这么写的地方。故意的跳位（翻页滚回页首那种「写 0」）没有读、不构成对；
   贴底跟随（写 scrollHeight）、双块同步滚（A.scrollTop = B.scrollTop）读数不进变量，也不构成对。
   探测器按函数做词法近似：只认 function 声明与带大括号的箭头函数体；对象字面量里的方法简写
   与类方法不在射程里；「挂在对象属性里攒着再还」「拆在两个函数里」的存取对这里看不见 ——
   这两类由浏览器判据 tests/e2e/viewport-clicks.cjs 的真点真量兜住。
   这张表与 G1 / G5 同族：必须保持为空，出现任何一条都是新的手写复刻。 */
const G24_SCROLL_PAIR = [];
const G24_EXEMPT = /(?:^|[\\/])ui[\\/]workbench\.js$/;
function g24FnRanges(code) {
  const out = [];
  const re = /(?:\bfunction\b[^{]*|=>)\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let d = 0, end = -1;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
      if (code[i] === '{') d++;
      else if (code[i] === '}') { d--; if (!d) { end = i; break; } }
    }
    if (end < 0) break;
    out.push([m.index, end]);
  }
  return out;
}
function detectScrollPair(file, src) {
  if (G24_EXEMPT.test(file)) return {};
  const code = codeOnly(src);
  const out = {};
  const ranges = g24FnRanges(code);
  /* 以「读」为锚：读所在的最小函数区间才算它的家。导演台那类 createX(E, document, window)
     工厂把几十个嵌套函数包在一个区间里，按「区间里有就算」会把嵌套函数里各不相干的
     重画与存取对硬凑成一对 —— 读、重画、写回三者必须同住一个最小区间。 */
  const home = i => {
    let best = null;
    for (const [a, b] of ranges) if (a <= i && i <= b && (!best || b - a < best[1] - best[0])) best = [a, b];
    return best;
  };
  /* 读的一侧：LHS 是不被点号带着的简单标识符（排掉 A.scrollTop = B.scrollTop 这类同步滚），
     RHS 里出现滚动位属性、且那一处本身不是赋值目标。 */
  const READ_INTO = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*=(?!=)[^;{}\n]*?\.scroll(?:Top|Left)\b(?!\s*(?:\+|-)?=[^=])/g;
  const WRITE_FROM = n => new RegExp(
    '\\.scroll(?:Top|Left)\\s*(?:\\+|-)?=\\s*[^;{}\\n]*(?<![\\w$])' + n.replace(/\$/g, '\\$') + '(?![\\w$])');
  for (const m of code.matchAll(READ_INTO)) {
    const r = home(m.index);
    if (!r) continue;
    /* 读之后、函数体之内：先重画、再原样写回 —— 次序反了（先写后读）构不成那一族。 */
    const rest = code.slice(m.index + m[0].length - 1, r[1] + 1);
    if (!/\.innerHTML\s*=|\.replaceChildren\s*\(|\.outerHTML\s*=/.test(rest)) continue;
    if (WRITE_FROM(m[1]).test(rest)) {
      out[file + '#手写滚动位存取对：读进 ' + m[1] + ' 又写回（该走 Wb.viewport.keep）'] = 1;
      break;
    }
  }
  return out;
}

/* G18 的探测器：规则表复用 tools/token-lib.cjs（值→令牌的映射只有一份），
   这里只负责把「哪些声明算裸值」的结果变成判据的条目。 */
const T = require('../tools/token-lib.cjs');
function detectStyleBare(file, src) {
  const out = {};
  for (const r of T.scanSource(T.maskComments(src), T.kindOfSrc(file))) {
    out[file + '#' + r.name + ': ' + String(r.value).slice(0, 60)] = 1;
  }
  return out;
}
function cssRulesOf(src) {
  const text = String(src).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    if (/^(?:from|to|\d+(?:\.\d+)?%)$/.test(sel)) continue;   // @keyframes 的关键帧不是选择器
    out.push({ sel, body: m[2].trim().replace(/\s+/g, ' ') });
  }
  return out;
}
function detectDupCss(file, src) {
  const out = {};
  const seen = new Map();
  for (const r of cssRulesOf(src)) {
    const key = r.sel + '{' + r.body + '}';
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  if (cssRuleIndex == null) {
    cssRuleIndex = new Map();
    for (const f of cssFiles()) {
      for (const r of cssRulesOf(S.read(f))) {
        const key = r.sel + '{' + r.body + '}';
        if (!cssRuleIndex.has(key)) cssRuleIndex.set(key, new Set());
        cssRuleIndex.get(key).add(f);
      }
    }
  }
  for (const [key, n] of seen) {
    if (n > 1) { out[file + '#同一规则写了 ' + n + ' 遍：' + key.slice(0, 60)] = n - 1; continue; }
    const owners = cssRuleIndex.get(key);
    if (owners && [...owners].some(f => f !== file)) out[file + '#与另一份样式表重复：' + key.slice(0, 60)] = 1;
  }
  return out;
}
function detectHookBackdoor(file, src) {
  const out = {};
  const code = codeOnly(src);
  /* 传进来的 src 可能不在语料里（自检的合成源码）：补一份，让「谁读它」在同一次调用里就能对上。
     真跑时语料本来就含这一份，重复只让计数翻倍，正负号不变。 */
  const text = hookCorpusCode() + '\n;\n' + code;
  const names = new Set([...code.matchAll(new RegExp(HOST_OBJ + '\\.(__[A-Za-z][A-Za-z0-9_]*)\\s*=(?!=)', 'g'))].map(m => m[1]));
  for (const name of names) {
    /* 读法不能只认 `window.__X`：外壳与页面隔着一层 iframe 时按 `top.__X`、`frameWin().__X` 取，
       那些是真使用点（`__sbApplyBalance`、`__acPageCtx` 就是这样被读的）。写入点才限定在 window 上
       —— 挂到别的宿主上不算开了一个全局后门。 */
    const any = (text.match(new RegExp('\\.' + name + '\\b', 'g')) || []).length;
    const asg = (text.match(new RegExp('\\.' + name + '\\s*=(?!=)', 'g')) || []).length;
    const del = (text.match(new RegExp('delete\\s+[\\w$.]*\\.' + name + '\\b', 'g')) || []).length;
    const clr = del + (text.match(new RegExp('\\.' + name + '\\s*=\\s*(?:null|undefined)\\b', 'g')) || []).length;
    const reads = any - asg - del;                        // 赋值左边与 delete 的那一次都不是读
    if (reads <= 0) out['window.' + name] = (out['window.' + name] || 0) + 1;
    else if (/\/pages\//.test(file) && !clr) out[file + '#卸载没清：window.' + name] = 1;
  }
  return out;
}

const GUARDS = [
  { key: 'G1', title: 'innerHTML 串里的内联事件', table: G1_INLINE_HANDLER, kind: 'entries', detect: detectInlineHandler,
    sample: `const h = '<button onclick="doThing()">按</button>';`,
    ok: `const h = '<button>按</button>'; box.onclick = doThing;` },
  { key: 'G2', title: '创建/提交调用点缺「结果未知」判据', table: G2_CREATE_NO_GUARD, kind: 'entries', detect: detectCreateNoGuard,
    sample: `async function makeIt(prov) { const r = await Api.create(prov, { model: 'm' }); return r; }`,
    ok: `async function makeIt(prov) { const r = await Api.create(prov, { model: 'm' }); if (Api.maybeSubmitted(r)) return 'unknown'; return r; }` },
  { key: 'G3', title: '空 catch 没写原因', table: G3_EMPTY_CATCH, kind: 'counts', detect: detectEmptyCatch,
    sample: `try { x(); } catch { }`,
    ok: `try { x(); } catch { /* 收尾清理，失败也要往下走 */ }\n// 反例写法写在注释里：try { y(); } catch {}` },
  { key: 'G4', title: '裸 #RRGGBB 没走令牌', table: G4_BARE_HEX, kind: 'counts', detect: detectBareHex,
    sample: `el.setAttribute('style', 'color:#ff0000');`,
    ok: `el.setAttribute('style', 'color:var(--pri,#6957e8)');` },
  { key: 'G5', title: '页面侧用 Dropdowns 私有物 _ddRebuild', table: G5_DD_REBUILD, kind: 'entries', detect: detectDdRebuild,
    sample: `host._ddRebuild();`,
    ok: `Dropdowns.sync(host);` },
  { key: 'G6', title: '手写错误文案没走 errText', table: G6_HAND_ERROR_TEXT, kind: 'counts', detect: detectHandErrorText,
    sample: `try { x(); } catch (e) { Toast.err((e && e.message) || String(e)); }`,
    ok: `try { x(); } catch (e) { Toast.err(errText(e)); }\n// 注释里举反例：(e && e.message) || e\nconst kind = String(e && e.message) === '已取消';` },
  { key: 'G7', title: '助手动作缺策略登记（effect / route）', table: G7_ACT_EFFECT, kind: 'entries', detect: detectActEffect,
    sample: "  const ACTS = {\n    generate: { title: 'a', run: f },\n    sneaky: { title: 'b', run: f },\n    half: { title: 'c', run: f },\n  };\n  const ACTION_META = {\n    generate: { effect: 'cost', route: '*' },\n    half: { effect: 'write' },\n  };",
    ok: "  const ACTS = {\n    generate: { title: 'a', run: f },\n    fill: { title: 'b', run: f },\n  };\n  const ACTION_META = {\n    generate: { effect: 'cost', route: '*' },\n    fill: { effect: 'ui', route: '*' },\n  };" },
  { key: 'G8', title: 'window.__* 后门：没人读的死钩子 / 页面钩子卸载没清', table: G8_HOOK, kind: 'entries', detect: detectHookBackdoor,
    /* 合成文件名要落在 pages/ 下，否则「卸载没清」那一半永远走不到（判据按写入方在哪一层分）。 */
    sampleFile: 'web/pages/synthetic.js', okFile: 'web/pages/synthetic.js',
    sample: `window.__deadOnPurpose = () => 1;`,
    ok: `window.__aliveOnPurpose = () => 1;\nfunction paint() { const f = window.__aliveOnPurpose; if (f) f(); }\nfunction leave() { window.__aliveOnPurpose = null; }` },
  { key: 'G9', title: '裸 localStorage 读写', table: G9_NAKED_LS, kind: 'counts', detect: detectNakedLocalStorage,
    sample: `const v = localStorage.getItem('sk_k');`,
    ok: `try { const v = localStorage.getItem('sk_k'); } catch (e) { /* 隐私模式：没有就没有 */ }\nconst w = window.LS.get('sk_k');` },
  { key: 'G10', title: "全库只许一处 createElement('link')", table: G10_LINK_CREATE, kind: 'counts', detect: detectLinkCreate,
    sample: `const l = document.createElement('link'); head.append(l);`,
    ok: `// 全站只有这一处 document.createElement('link')，注释里举例不算\nconst l = document.createElement('style');` },
  { key: 'G11', title: '同一条 CSS 规则定义两处（同一选择器 + 同一规则体）', table: G11_DUP_CSS, kind: 'entries', detect: detectDupCss,
    sources: cssFiles, sampleFile: 'web/styles/synthetic.css', okFile: 'web/styles/synthetic.css',
    sample: `.demo-x { color: var(--pri); }\n.demo-y { color: var(--pri); }\n.demo-x { color: var(--pri); }`,
    ok: `.demo-x { color: var(--pri); }\n.chars-page .demo-x { color: var(--sec); }\n@keyframes demo-spin { from { opacity: 0; } to { opacity: 1; } }` },
  { key: 'G12', title: "两处 CSP 都放行 'wasm-unsafe-eval'", table: G12_CSP_WASM, kind: 'entries', detect: detectCspWasm,
    sources: () => ['shell.html', 'server/static.js'], sampleFile: 'shell.html', okFile: 'shell.html',
    sample: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">`,
    ok: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'">` },
  { key: 'G13', title: '代理运行时不跑 ffmpeg / ffprobe', table: G13_NO_FFMPEG, kind: 'counts', detect: detectFfmpeg,
    sources: S.serverSources, sampleFile: 'server/app.js', okFile: 'server/app.js',
    sample: `const p = spawn('ffmpeg', ['-i', src, out]);`,
    ok: `const p = spawn(st.bin, ['-m', st.model, '-f', wav]);\n// 注释里说「这里不跑 ffmpeg」不算违例` },
  { key: 'G16', title: "createElement('video') 只许出现在 media-backend.js", table: G16_VIDEO_CREATE, kind: 'counts', detect: detectVideoCreate,
    sampleFile: 'web/ui/workbench.js', okFile: 'web/media-backend.js',
    sample: `const v = document.createElement('video');`,
    ok: `const v = document.createElement('video');  // 这一份就是唯一允许造解码器的地方` },
  { key: 'G14', title: '助手附件不落本机资产库（chat.js 里不许有 Api.saveLocalAsset）', table: G14_CHAT_SAVE, kind: 'counts', detect: detectChatSaveLocal,
    sources: () => ['web/features/chat.js'], sampleFile: 'web/features/chat.js', okFile: 'web/features/chat.js',
    sample: `Api.saveLocalAsset({ name: 'x.png', data: b64 });`,
    ok: `const rec = { file: f, src: URL.createObjectURL(f) };  // 附件只活在内存，不落资产库` },
  { key: 'G17', title: '素材库页走设计令牌（chars.js 里不许有裸十六进制色值）', table: G17_CHARS_HEX, kind: 'counts', detect: detectBareHex,
    sources: () => ['web/pages/chars.js'], sampleFile: 'web/pages/chars.js', okFile: 'web/pages/chars.js',
    sample: `el.style.color = '#e06666'; const bg = '#fff';`,
    ok: `el.style.color = 'var(--err)'; const bg = 'var(--panel)';  // 颜色只取 tokens.css 的变量` },
  { key: 'G18', title: '样式层不许再写死：尺寸 / 配色 / 令牌兜底值一律走令牌', table: G18_STYLE_BARE, kind: 'entries', detect: detectStyleBare,
    sources: styleSources, sampleFile: 'web/styles/synthetic.css', okFile: 'web/styles/synthetic.css',
    sample: `.demo-a { padding: 8px; font-size: 12px; border-radius: 6px; color: #ff0000; }`,
    ok: `.demo-a { padding: var(--sp-8); font-size: var(--fs-12); border-radius: var(--radius-6); color: var(--pri); }` },
  { key: 'G19', title: '主题色深浅两档（基色 + 推导 + 配色块）必须成对覆盖', table: G19_THEME_PAIR, kind: 'entries', detect: detectThemePair,
    sources: () => ['web/styles/tokens.css'], sampleFile: 'web/styles/tokens.css', okFile: 'web/styles/tokens.css',
    sample: `:root { /* ① 主题色 */ --bg: var(--bg-base); --txt: #000; --bg-base:#f2f3f9; --txt-base:#23262f; /* ①b */ }\n/* ② 派生色 */\nhtml[data-theme="dark"] { --bg: #111; --txt: oklch(from var(--txt-base) 0.955 c h); }\nhtml[data-theme="dark"][data-palette="ocean"] { --acc-base:#2563eb; --acc2-base:var(--acc-base); --pri-base:var(--acc-base); }`,
    ok: `:root { /* ① 主题色 */ --bg: var(--bg-base); --txt: var(--txt-base); --bg-base:#f2f3f9; --txt-base:#23262f; /* ①b */ }\n/* ② 派生色 */\nhtml[data-theme="dark"] { --bg: oklch(from var(--bg-base) 0.160 c h); --txt: oklch(from var(--txt-base) 0.955 c h); --shadow-1:0 1px 2px rgba(0,0,0,.35); }\nhtml[data-palette="ocean"] { --acc-base:#2563eb; --acc2-base:var(--acc-base); --pri-base:var(--acc-base); }` },
  { key: 'G21', title: '透明度只许从 --a-* 阶梯里取（不许自己编百分比）', table: G21_ALPHA, kind: 'counts', detect: detectAlphaLadder,
    sources: styleSources, sampleFile: 'web/styles/synthetic.css', okFile: 'web/styles/synthetic.css',
    sample: `.demo-a { background: color-mix(in srgb, var(--acc) 7%, transparent); }`,
    ok: `.demo-a { background: color-mix(in srgb, var(--acc) var(--a-10), transparent); }` },
  { key: 'G20', title: '页面补丁里不许顶层定义公共类（第二份实现）', table: G20_TOPLEVEL, kind: 'entries', detect: detectToplevelPublic,
    sources: pagePatchFiles, sampleFile: 'web/styles/spa-synthetic.css', okFile: 'web/styles/spa-synthetic.css',
    sample: `.tool { padding: 4px; }`,
    ok: `.demo-page .tool { padding: 4px; }` },
  { key: 'G22', title: '断点只许用登记的那几档（媒体查询里没法用变量共享）', table: G22_BREAKPOINT, kind: 'entries', detect: detectBreakpoint,
    sources: styleSources, sampleFile: 'web/styles/synthetic.css', okFile: 'web/styles/synthetic.css',
    sample: `@media (max-width: 999px) { .demo-a { color: var(--pri); } }`,
    ok: `@media (max-width: 760px) { .demo-a { color: var(--pri); } }` },
  { key: 'G23', title: '代码注释里不许出现文档引用（只注释功能本身）', table: G23_COMMENT_REF, kind: 'entries', detect: detectCommentRef,
    sources: commentSources, sampleFile: 'tests/synthetic.cjs', okFile: 'tests/synthetic.cjs',
    sample: `/* 见 AGENTS §7「格式化」：这一族只走 pad2 */\nconst pad2 = n => n;`,
    ok: `/* 这一族只走 pad2：手拼 mm:ss 会让各处读数各写一种 */\nconst pad2 = n => n;` },
  { key: 'G24', title: '公共件之外不许手写「滚动位存取对」（读 scrollTop → 整片重画 → 原样写回）', table: G24_SCROLL_PAIR, kind: 'entries', detect: detectScrollPair,
    sampleFile: 'web/pages/synthetic.js', okFile: 'web/pages/synthetic.js',
    sample: `function paintBox(box, html) {\n  const top = box.scrollTop;\n  box.innerHTML = html;\n  box.scrollTop = top;\n}`,
    ok: `function paintBox(box, html) { Wb.viewport.keep(box, () => { box.innerHTML = html; }); }\nfunction stickBottom(box) { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 40) box.scrollTop = box.scrollHeight; }\nback.innerHTML = render(ta.value); back.scrollTop = ta.scrollTop;\nfunction jumpTop(list) { list.scrollTop = 0; }` },
];

/* ============================ 跑 ============================ */
const files = S.webSources();
let bad = 0, total = 0;
function merge(into, from) { for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v; return into; }

function selfCheck() {
  /* 每个探测器都要能在合成违例上报出一条、在合成正确写法上闭嘴，否则它就是个装饰：
     只验「报得出」的判据会把注释里的反例也算成违例，表就再也没人和现状对得上。 */
  let allOk = true;
  for (const g of GUARDS) {
    const sf = g.sampleFile || 'synthetic/sample.js';
    const found = Object.keys(g.detect(sf, g.sample)).length > 0;
    if (!found) { allOk = false; console.log('  ✗ ' + g.key + ' 探测器对合成违例毫无反应（判据失效）'); }
    if (g.ok) {
      const falsePositive = Object.keys(g.detect(g.okFile || sf, g.ok));
      if (falsePositive.length) { allOk = false; console.log('  ✗ ' + g.key + ' 探测器把合成正确写法也报了（判据太粗）：' + falsePositive.join(' / ')); }
    }
  }
  return allOk;
}

console.log('静态纪律判据（' + files.length + ' 个 web 源码文件 · ' + GUARDS.length + ' 条判据）');
for (const g of GUARDS) {
  const current = {};
  const list = g.sources ? g.sources() : files;
  for (const p of list) { const id = S.asRel(p); merge(current, g.detect(id, S.read(id))); }
  const res = S.ratchet(current, g.table, { kind: g.kind });
  total += res.total;
  const registered = g.table.reduce((a, r) => a + r.max, 0);
  if (WRITE) {
    console.log('\n// ' + g.key + ' ' + g.title + '：当前 ' + Object.keys(current).length + ' 组 / ' + res.total + ' 处');
    S.printTable(current, g.key + ' ' + g.title, { kind: g.kind });
    continue;
  }
  const head = (res.grown.length ? '✗ ' : '✓ ') + g.key + ' ' + g.title
    + '：现 ' + res.total + ' 处 / 登记 ' + registered + ' 处（' + Object.keys(current).length + ' 组）';
  console.log(head);
  for (const x of res.grown) console.log('    ✗ 新违例 ' + x.id + ' = ' + x.n + (x.max != null ? '（登记上限 ' + x.max + '）' : '（没登记）') + (x.why ? '' : ' —— 要留就走 GUARD_WRITE 重打表并补一句原因'));
  for (const x of res.stale.slice(0, 6)) console.log('    ℹ 可以收紧：' + x.id + ' 现在 ' + x.n + '，登记 ' + x.max);
  if (res.grown.length) bad++;
}
if (!WRITE) {
  console.log('\n判据自检（合成违例必须被探到、合成正确写法不误报）');
  if (!selfCheck()) { bad++; } else console.log('  ✓ ' + GUARDS.length + ' 个探测器两边都验过');
  console.log('\n' + (bad ? '✗ ' : '✓ ') + '存量违例 ' + total + ' 处，' + bad + ' 条判据变红');
}
process.exit(bad ? 1 : 0);
