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
/* 错误通道只许有一份（§6.1-5）：横幅在 ui.js、监听器与上报在 core/report.js。
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

/* ---------- 1b. 首屏重量（报告 §6.2「首屏同步加载约 966KB / 24 个脚本」） ---------- */
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
   2026-10-19 两次改动一起记账（报告 §6.2「首屏」）：
     ·  −5.4KB：`web/domain/zip-read.js` 不再常驻，唯一使用点（设置页读 Skill 包）本来就按需加载；
     · +3.9KB：`web/domain/local.js` 长出 `announce()` —— 那是一份「生成完成」契约从四处收成一处，
       收在 local.js 是因为它同时是唯一消费方（scan / offer / 镜像队列都在这层），按需加载反而要让每个页面都补载它。
     同一批之后又补了「别名折完就删」与契约测试段（§6.2 ③），这一笔按 ±0 记账：local.js 里那段
     十六条的归一化散文压成一段、规则各自写回代码那一行，判据一条没少，首屏字节没有再涨。
     · 页面自注册收成路由表一条 `src`（§6.2「死代码」）同样 ±0：routes.js 八条 `src` 换来的散文
       压进两行，app.js 那份手抄的 VIEWS 字面量与两处 `window.WB_VIEWS` 登记一起删掉。
     ·  −811B：设置键三份清单收成一张表（§6.2「5 份清单」）—— 界面偏好的键名从此只由 ui.js 的
       UI_PREFS 提供，SYNCABLE / EXPORTABLE / RESET_KEEP 各删掉自己抄的那一份，换回来的注释比省下的短。
     ·  +2 枚 / ±0B：报告 §6.1-2 把 assetlib.js 按已有的 window 面拆成 api.js / assetlib.js /
       gen-forms.js（两个巨型闭包有了命名空间边界）。拆出来的三份里删掉了描述别的文件的陈旧注释，
       净字节反而少了；枚数是结构拆分付的价（三份都必须同步常在，否则页面在首次取数时炸）。
     ·  +1 枚 / 净字节 +1.4KB：报告 §6.1-2 把 ui.js 的弹窗与表单族（InlinePolish / PromptReview /
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
       所以 `raw-request.js` 改成**按需补载**（导演台 / 生成工作台 / 画布三页各自 `__spaLoadScript`），
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
     ·  +0.6KB：`skills.js` 的 `WbSkills.refRule` —— 「素材范围优先」的读法只有这一处
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
       所以这一笔省不掉：变量机制要进正文，正文要进 `DEF`，`DEF` 在首屏。 */
const FIRST_SCREEN_MAX_SCRIPTS = 32, FIRST_SCREEN_MAX_BYTES = 1028086;
ok(`首屏同步脚本 ${resident.length} 枚 / ${(residentBytes / 1024).toFixed(0)}KB 不超登记（${FIRST_SCREEN_MAX_SCRIPTS} 枚 / ${(FIRST_SCREEN_MAX_BYTES / 1024).toFixed(0)}KB）`,
  resident.length <= FIRST_SCREEN_MAX_SCRIPTS && residentBytes <= FIRST_SCREEN_MAX_BYTES,
  `${resident.length} 枚 / ${residentBytes} 字节 —— 只许减：新挂一枚脚本要连着写下它为什么不能按需`);
/* 助手关着的时候不该在空闲时段把 chat.js 整份下载并求值（389KB）。 */
const bootJs = read('web/boot-assistant.js');
/* 「关着不下载」必须是一条**结构**判据，不是文字顺序判据：注释里写了 ai_chat_off 也算出现，
   按先后排的判据会把「无条件清单 + 注释里提了一句」这种写法放过去（变异验证过：把 chat.js
   塞回 `var files = [...]`，文字顺序判据照旧绿）。看三件事：
     · 无条件那份清单里没有 chat.js；
     · chat.js 是被一条 `if (!<闸>) files.push('web/features/chat.js')` 加进来的；
     · 那道闸的变量名就出现在读 `localStorage.getItem('ai_chat_off')` 的那一行上。 */
const bootList = (bootJs.match(/var files = \[[^\]]*\]/) || [''])[0];
const bootGate = bootJs.match(/if\s*\(!([A-Za-z_$][\w$]*)\)\s*files\.push\(\s*'web\/features\/chat-tools\.js'\s*,\s*'web\/features\/chat\.js'\s*\)/);
const bootGateVar = bootGate ? bootGate[1] : '';
ok('外壳空闲补载 chat.js 走 ai_chat_off 那道闸（关着不下载那一份）',
  !!bootGate && !/features\/chat\.js/.test(bootList)
  && bootJs.split(/\r?\n/).some(l => l.includes(bootGateVar) && /ai_chat_off/.test(l)),
  bootGate ? '闸的变量 ' + bootGateVar + ' 没连着读 ai_chat_off，或 chat.js 仍在无条件清单里'
    : '找不到 `if (!<闸>) files.push(\'web/features/chat-tools.js\', \'web/features/chat.js\')` 这一条 —— 关着也照下 389KB');

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
const wbjs = read('web/ui/workbench.js');
ok('复用跳转不再直接 location.href', !/location\.href\s*=\s*'studio\.html\?t='/.test(wbjs) && /GoPage\.go\(target\)/.test(wbjs));

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
     用户自填的网关模板都不是请求（§1 管的是请求，不是字符串里出现 https）。 */
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
ok('shell 带 script-src \'self\' 且没有 unsafe-eval',
  /http-equiv="Content-Security-Policy"/.test(shell) && /script-src 'self'/.test(shell) && !/unsafe-eval/.test(shell));
ok('shell 没有内联脚本（CSP 会拦）', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(shell));
ok('外壳不再引用完整版 Vue（编译器已移除）', !fs.existsSync(path.join(root, 'vue.esm-browser.prod.js')));
ok('本地 Vue runtime 存在', fs.existsSync(path.join(root, 'vue.runtime.esm-browser.prod.js')));
const compFiles = ['web/app.js', ...components.map(c => c.name)];
ok('组件源码里没有 template 字符串', compFiles.every(f => !/\btemplate\s*:/.test(read(f))));
ok('组件都接上了预编译 render', compFiles.every(f => /import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*'[^']*\/render\//.test(read(f)) || /from\s*'[^']*\/render\//.test(read(f))));
const renderDir = path.join(root, 'web/render');
/* render 清单**从模板扫出来**，不写死名字（报告 §7.4：以前这里是一行 11 个字符串的清单，
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
ok('页面 CSS 没有裸色值（品牌覆盖 --pri 除外）',
  pageHex.every(x => x.toLowerCase() === '#9d8bff'), pageHex.join(', '));
ok('公共与页面 CSS 至少在用间距/字号/圆角令牌',
  /var\(--sp-/.test(uiCss) && /var\(--fs-/.test(uiCss) && /var\(--radius-/.test(pageCss)
  && /var\(--sp-/.test(pageCss));
console.log('\n' + (bad ? '✗ ' : '✓ ') + checks + ' 项，' + bad + ' 项未通过');
process.exit(bad ? 1 : 0);
