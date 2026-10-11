/* 常驻判据的变异自检 —— 判据自己也会「悄悄变成一把不坏的假尺子」，
   所以改完 tests/selfcheck.cjs 一定要跑一遍这个。
   跑法：`node tests/mutation.cjs`（它会临时改源文件，跑完自动还原）。 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const J = path.join(ROOT, 'tests', 'selfcheck.cjs');
const FILES = ['drama.html', 'assets.html', 'ident.js', 'assetlib.js', 'shell.html', 'proxy.js',
  'drama.js', 'settings.html', 'studio.html', 'ai-chat.js', 'favorites.html', 'chars.html',
  'workbench.js', 'ui.js'];
/* ① 读进来时的字节就是唯一的还原依据 —— 绝不做「把 to 替换回 from」那种二次字符串还原：
      to 一旦是空串，replace('', x) 会把 x 插到文件最前面，当场污染源文件。 */
const orig = new Map(FILES.map(f => [f, fs.readFileSync(path.join(ROOT, f))]));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const before = new Map([...orig].map(([f, b]) => [f, sha(b)]));

function run() {
  try {
    return { code: 0, out: execFileSync(process.execPath, [J], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (e) { return { code: e.status || 1, out: (e.stdout || '') + (e.stderr || '') }; }
}
/* Windows 上写文件会被第三方**短暂**占住（本机实测：Defender / 索引器一闪，
   `fs.writeFileSync` 报 `errno -4094 UNKNOWN open`，一次就抛）。
   这里绝不能「一次失败就抛」—— 抛在 restoreAll 中间就等于**留下变异过的一半源文件**，
   而 `orig` 是启动时读的字节，下一次运行会把那份污染当基线照单还原，最后还报一句「哈希一致」。
   所以退避重试；真的重试完还不行就明确报错并说清是哪一档（宁可停下，也不要带着坏状态继续跑）。 */
function write(f, b) {
  const p = path.join(ROOT, f);
  let last = null;
  for (let k = 0; k < 12; k++) {
    try { fs.writeFileSync(p, b); return; }
    catch (e) { last = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
  }
  throw new Error('写不回 ' + f + '（重试 12 次仍然被占用：' + (last && last.code) + '）—— '
    + '源文件可能停在变异状态，先手工核对再跑判据');
}
const restoreAll = () => { for (const [f, b] of orig) write(f, b); };

/* 兜底还原：这个脚本会**临时改源文件**，所以「怎么结束」比「怎么开始」更要紧。
   实测漏过一次：那时有 30 个变异就要跑 30 遍全套判据（现在 44 个），前台 60 秒窗口不够，进程被收走，
   proxy.js 里留下了 §G 那个 `if (false && insideLocalDir(to))` 就没再被还原。
   更糟的是**下一次运行看不出这件事** —— orig 是「读进来时的字节」，
   那份泄漏就成了新的起始状态，被照单还原，最后还报一句「哈希一致」。
   所以除了正常路径的还原，这里再挂上 exit 与信号处理器：
   未捕获异常、Ctrl-C、SIGHUP 都会走到（只有 SIGKILL 拦不住）。
   同理，**别用短超时跑它** —— 超时中断和杀进程是一回事。 */
let restored = false;
const safeRestore = () => { if (restored) return; restored = true; try { restoreAll(); } catch (e) { /* 兜底还原自己失败就只能人工看了 */ } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { safeRestore(); process.exit(130); });
process.on('exit', safeRestore);

const MUT = [
  { sec: '§A', name: '兄弟函数里裸调局部 const（drama.html 那次的原样复现）', file: 'drama.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function __mutA__(){ const onlyHere = function(){return 1;}; return onlyHere(); } function __mutB__(){ return onlyHere(); }</script>' },
  { sec: '§A', name: '调一个压根没声明的名字', file: 'assets.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>__neverDeclared__();</script>' },
  /* ↓ 这一条钉的是 `studio.html` 真发生过的 `t is not defined`：
     把一个函数的局部 const 拿到**兄弟函数**里当成员访问的基对象用。
     它原先从判据下面整个走过去了（旧版只查裸调用，而 `t.dur` 是成员访问），
     表现出来的样子是「点生成什么都不发生」。修好作用域分析之后它才真的咬人；
     下面两条反向对照是同一批加的 —— 没有它们，「§A 什么都报」与
     「§A 报得准」在这里长得一模一样。 */
  { sec: '§A', name: '兄弟函数里拿别人的局部 const 当基对象（t is not defined 的原样复现）', file: 'assets.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function __mutA4__(){ const __mutT__ = { dur: 1 }; return __mutT__.dur; } function __mutA5__(){ return __mutT__.dur; }</script>' },
  { sec: '§A', name: '反向对照：外层函数声明、里层箭头函数用（合法闭包，应放行）', file: 'assets.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function __mutA6__(){ const __mutT2__ = { dur: 1 }; return () => __mutT2__.dur; }</script>' },
  { sec: '§A', name: '反向对照：表达式体箭头把自己的形参当基对象（应放行）', file: 'assets.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function __mutA7__(){ const f = __mutT3__ => __mutT3__.dur; return f; }</script>' },
  /* ↓ 模块文件那一半（§A-2）。真实事故：assetlib.js 里 `readBlobWithProgress` 是
     `window.AssetTransfer` 的属性方法，而 `blobOf` 里写成了裸名调用 ——
     每一次「自动存本机」都抛 `readBlobWithProgress is not defined`，
     整条下载链是死的，界面只写「获取失败」。当时 §A 只扫 HTML 内联脚本，
     一行都没查过模块文件，所以这个错从判据底下整个走过去。
     反向对照必须有：模块里「把回调当形参传进来再调」的写法满地都是，
     没有这一条，§A-2 把整类写法全判成红也看不出来。 */
  { sec: '§A', name: '模块里把对象方法当裸函数调（assetlib 下载链断掉的那一次）', file: 'assetlib.js',
    anchor: 'const b = await AssetTransfer.readBlobWithProgress(r, onStage, total);',
    to: 'const b = await readBlobWithProgress(r, onStage, total);' },
  { sec: '§A', name: '反向对照：模块里通过形参传进来的回调调一次（应放行）', file: 'workbench.js', expectGreen: true,
    anchor: 'window.Wb = {',
    to: 'function __mutCb(near, step) { return step(); }\n  window.Wb = {' },
  { sec: '§B', name: '模板串原始文本里写「块注释 + 反引号」', file: 'drama.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>var __mutB__ = `前缀 /* 注释里有个反引号 ` 后面`;</script>' },
  { sec: '§C', name: '多出第二份 VOLATILE_Q 正则', file: 'ident.js',
    anchor: 'const VOLATILE_Q = /^(expires|signature',
    to: 'const VOLATILE_Q = /^(a|b)$/i; const LOCAL_VOLATILE_Q = /^(expires|signature' },
  { sec: '§D', name: '某页把 ident.js 删掉', file: 'shell.html',
    anchor: '<script src="ident.js"></script>\r\n', to: '' },
  { sec: '§E', name: 'pushEntry 不再委托 collapseInto', file: 'assetlib.js',
    anchor: 'const pushEntry = (st, e) => collapseInto(st, e);',
    to: 'const pushEntry = (st, e) => { st.out.push(e); };' },
  { sec: '§F', name: '多出第二个 /save 调用点（绕过镜像那道守卫）', file: 'assetlib.js',
    anchor: 'const queued = new Set();',
    to: 'const queued = new Set(); Api.saveToDir({});' },
  { sec: '§G', name: '补存那一步开始删 .assets 里的原件', file: 'proxy.js',
    anchor: "          const hash = sha1Of(buf);\r\n          const hit = sums.get(buf.length, hash);",
    to: "          const hash = sha1Of(buf);\r\n          try { fs.unlinkSync(src); } catch (e) { /* 删了 */ }\r\n          const hit = sums.get(buf.length, hash);" },
  { sec: '§G', name: '搬迁时先删源再写目标（写失败源文件就没了）', file: 'proxy.js',
    anchor: 'fs.writeFileSync(path.join(to, file), buf);',
    to: 'fs.unlinkSync(src); fs.writeFileSync(path.join(to, file), buf);' },
  { sec: '§G', name: '页面开始把目标目录一起递过去', file: 'assetlib.js',
    anchor: 'body: JSON.stringify({ kind, from }),',
    to: 'body: JSON.stringify({ kind, from, dir: "" }),' },
  { sec: '§G', name: '搬迁不再拦「旧目录 = .assets」（会把资产库搬空）', file: 'proxy.js',
    anchor: 'if (insideLocalDir(srcDir)) return fail(403,',
    to: 'if (false && insideLocalDir(srcDir)) return fail(403,' },
  { sec: '§G', name: '搬迁不再拦「目标目录 = .assets」', file: 'proxy.js',
    anchor: 'if (insideLocalDir(to)) return fail(403,',
    to: 'if (false && insideLocalDir(to)) return fail(403,' },
  /* §H 的两个分支各一个变异。只测 JS 那一支的话，「静态正文」那一支可能压根没接上，
     而判据照样全绿 —— 那是假绿。
     反向对照（expectGreen）证明它也不是无脑报警：拼给模型的系统提示词里 ** 是**故意**要的，
     漏进去就该放行。没有这一条的话，「§H 什么都报」和「§H 什么都不报」在下面的驱动里长得一模一样。 */
  { sec: '§H', name: '页面静态正文里出现 markdown 标记', file: 'settings.html',
    anchor: '<h1><span data-icon="gear" data-size="18"></span> 设置</h1>',
    to: '<h1><span data-icon="gear" data-size="18"></span> 设置 **这里不该有星号**</h1>' },
  { sec: '§H', name: '界面赋值的那句提示里带 markdown 标记', file: 'drama.js',
    anchor: '机位是每一段单独出的：',
    to: '机位是**每一段**单独出的：' },
  /* 这一条只钉住 UI_SINK 上新加的两个名字（sub / body）。
     Confirm.ask / choose 的正文与副标题都走 textContent，星号会原样糊到用户脸上；
     少了这一条，名单里写没写过它们看不出来 —— 上面那一条打在 `hint:` 上，替不了这一档。 */
  { sec: '§H', name: 'Confirm.choose 的副标题里带 markdown 标记（认 sub 这一档才会红）', file: 'drama.html',
    anchor: "sub: '下一集是新故事；画幅 / 画质 / 模型 / 配乐照这一集沿用',",
    to: "sub: '下一集是新故事；**画幅 / 画质 / 模型 / 配乐**照这一集沿用'," },
  { sec: '§H', name: '反向对照：给模型的系统提示词里用 markdown（应放行）', file: 'drama.js', expectGreen: true,
    anchor: "const K_DRAMAS = 'dramas';",
    to: "const __MUT_SYS__ = '请**严格**按下面的说明回答，不要凭空编造';\r\nconst K_DRAMAS = 'dramas';" },
  /* §I 的三个分支各一个变异。第一个同时会打中「判断有两处」与「旧措辞复活」两档 ——
     写第二份内联口径这两件事是同时发生的，不该拆成两个变异充数。 */
  { sec: '§I', name: '某处改回内联写法（判断多出一处 + 旧措辞复活 + note 又被丢掉）', file: 'studio.html',
    anchor: "  const where = src ? Capabilities.srcTextOf(src) : '';",
    to: "  const where = src ? (src.from === 'api' ? '来自上游 /models' : '来自本项目的平台声明（上游接口没给或不可用）') : '';" },
  { sec: '§I', name: 'srcTextOf 自己把 note 换成那句零信息的话', file: 'assetlib.js',
    anchor: "    return src.from === 'api' ? ('能力来自上游接口' + (src.cached ? '（缓存）' : '')) : (src.note || '按平台声明兜底');",
    to: "    return src.from === 'api' ? '来自上游 /models' : '来自本项目的平台声明（上游接口没给或不可用）';" },
  { sec: '§I', name: '某处不再调 srcTextOf（口径分叉，但措辞一个字没多）', file: 'studio.html',
    anchor: "    if (src) bits.push(Capabilities.srcTextOf(src));",
    to: "    if (src) bits.push('能力来自上游接口');" },
  { sec: '§G', name: '补存那步的 .assets 闸被短路掉（文本还在、永远不执行）', file: 'proxy.js',
    anchor: "if (insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }",
    to: "if (false && insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }" },
/* §J 的五个分支各一个变异。这一档守的是「同一个功能只应有一份实现」，
     而这类判据最容易变成一把**不坏的假尺子**：指纹太松会把不相干的写法一起抓
     （第一版拿 new Uint8Array(x.length) 当 base64→字节的指纹，把 studio.html 那段
      new Uint8Array(h.length / 2)（十六进制→文本）也照红了）；指纹太紧又查不出副本。
     每条变异都必须真的让对应那档变红，否则这一档就是摆设。 */
  { sec: '§J', name: '页面又抄了一份 base64→字节', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function b64Bytes(b){ const s=atob(b||\'\'); const a=new Uint8Array(s.length); for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i); return a; }</script>' },
  { sec: '§J', name: '「下载落点」那个选择器复活（注释里提到不算）', file: 'assets.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutJ = () => showSaveFilePicker();</script>' },
  { sec: '§J', name: '页面又自建了一份 toast()', file: 'chars.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function toast(m){ const d=document.createElement("div"); d.textContent=m; document.body.appendChild(d); }</script>' },
  { sec: '§J', name: 'Wb.fmtSize 又开始自己换算（不再委托 fmtBytes）', file: 'workbench.js',
    anchor: '    fmtSize(bytes) { return window.fmtBytes(bytes); },',
    to: "    fmtSize(bytes) { const u = ['B','KB','MB','GB']; let i = 0, v = Number(bytes); while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return (i ? v.toFixed(1) : v) + ' ' + u[i]; }," },
  { sec: '§J', name: '页面又自建了一份续拉（不走 Wb.pager.sentinel）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>new IntersectionObserver(function () {});</script>' },
/* §J 的第 ⑦ 支（页面对 Wb.pager.create() 返回值的成员访问必须在 api 面上）要三个变异：
     A 公共层改个方法名 → 页面那几处调用点必须红（证明面是**现取**的，不是名单）；
     B 把坏写法 pager.fill(...) 放回去 → 红（这正是 2026-10 真实存在过的 bug）；
     C 让实例名认不出来（换个变量名）→ 红在「只看到 14 处访问」那一条 ——
       没有这一条，「越界 0 处」到底是「调用点都在面上」还是「一处都没扫到」就分不开。
   外加一条反向对照：注释里提一句 pager.fill 不算（那一行正在解释它坏在哪，
   与 ③ 的 showSaveFilePicker 同一套路，靠词法器剥注释才分得开「提到」与「真调用」）。 */
  { sec: '§J', name: '公共层把 bindScroll 改名，页面调用点没跟上（api 面现取，应红）', file: 'workbench.js',
    anchor: '          bindScroll(boxSel) {',
    to: '          bindScrollRenamed(boxSel) {' },
  { sec: '§J', name: '把坏写法 pager.fill(...) 放回 studio.html（api 上没这个方法，应红）', file: 'studio.html',
    anchor: "  pullMore = pager.bindScroll('result');",
    to: "  try { pager.fill(pager.page + 2); } catch (e) {}\r\n  pullMore = pager.bindScroll('result');" },
  { sec: '§J', name: '尺子坏了也要红：换掉接收 create() 返回值的变量名（访问数从 18 掉下来）', file: 'chars.html',
    anchor: '  const pager = Wb.pager.create({',
    to: '  const pagerRenamed = Wb.pager.create({' },
  { sec: '§J', name: '反向对照：注释里提到 pager.fill 不该算越界（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '  const pager = Wb.pager.create({',
    to: '  /* 这一页以前也写过 pager.fill(n) —— api 上根本没有这个方法，别加回来 */\r\n  const pager = Wb.pager.create({' },
/* §J 芯片行的三个变异：旧写法有两种（拼 innerHTML 的模板串、createElement + className），
   **两种都要测** —— 只测一种的话，另一种写法复活了判据照样全绿。
   外加一条反向对照：.ai-chip / .ap-chip 是别的类名（那是「AI 挑了哪些」芯片与资产选择器的类型页），
   它们长得像但不是筛选芯片行，不该被算进来。没有这条对照，「§J 什么都报」和「§J 什么都不报」
   在驱动脚本里长得一模一样。 */
  { sec: '§J', name: '页面又自建了一份芯片行（拼 innerHTML 那种写法）', file: 'chars.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutChips1 = items => items.map(v => \'<button class="chip">\' + v + \'</button>\').join(\'\');</script>' },
  { sec: '§J', name: '页面又自建了一份芯片行（createElement + className 那种写法）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutChips2 = () => { const b = document.createElement("button"); b.className = \'chip\'; return b; };</script>' },
  { sec: '§J', name: '反向对照：.ai-chip / .ap-chip 是别的类名，不该算自建芯片行（应放行）', file: 'assets.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutChips3 = () => \'<span class="ai-chip">x</span>\' + \'<span class="ap-chip">y</span>\';</script>' },
/* §J 的第 ⑧ 支（跨页复用载荷只有一份）要三个变异 + 一条反向对照：
     A 页面自己再拼一份载荷（写第二处 sk_reuse）→ 红；
     B 消费端多读一遍（读到第二次就已经被前一处删掉了，正是这个 bug 的形状）→ 红；
     C 把某一页的入口摘掉（Wb.reuse.go 掉到 2 次）→ 红 —— 没有这一条，
       「写入只有一份」会因为三页全都不递素材而照样全绿，那是空断言。
   反向对照：注释里写一句 localStorage.setItem('sk_reuse', ...) 不该算第二处写入
   （与 ③ 的 showSaveFilePicker 同一套路，靠词法器剥注释才分得开「提到」与「真写」）。 */
  { sec: '§J', name: '页面又自己拼了一份跨页载荷（写入点变成两处，应红）', file: 'chars.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutReuse1 = p => { try { localStorage.setItem("sk_reuse", JSON.stringify(p)); } catch (e) {} };</script>' },
  { sec: '§J', name: '消费端把同一条载荷读两遍（读取点变成三处，应红）', file: 'studio.html',
    anchor: "  try { localStorage.removeItem('sk_reuse'); } catch (e) {}",
    to: "  try { localStorage.getItem('sk_reuse'); localStorage.removeItem('sk_reuse'); } catch (e) {}" },
  { sec: '§J', name: '某一页的「复用」不再走公共那一份（Wb.reuse.go 掉到 2 次，应红）', file: 'assets.html',
    anchor: "  Wb.reuse.go({ from: 'assets'",
    to: "  Wb.reuse.goX({ from: 'assets'" },
  { sec: '§J', name: '反向对照：注释里提到 setItem(sk_reuse) 不该算第二处写入（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '  const pager = Wb.pager.create({',
    to: '  /* 这一页以前自己 localStorage.setItem(\'sk_reuse\', ...) 拼载荷，现在只走 Wb.reuse.go */\r\n  const pager = Wb.pager.create({' },
/* §J 的第 ⑨ 支（本机落盘链只有一条，2026-10 加「自动下载」两颗按钮时立的）要四个变异 + 一条反向对照：
     A 页面自己拼 /local-assets 落盘 → 红（绕过身份判据与去重，正是这一档要防的第一号长法）；
     B 第三页也去藏云端成品 → 红在「调用点 4 处 / 出现在 chars.html」那一条；
     C 某一页的「自动下载」不走公共那一条链 → 红在 pull 掉到 1 处；
     D 判据长出第二份（页面里再写一个 hideAsCloud）→ 红在定义数；
     反向对照：注释里提一句 fetch('/local-assets') 不该算自拼路由
       （studio.html 正文里本来就有三句这样的说明文字，基线全绿靠的正是词法器剥注释 —— 没有这一条对照，
        「⑨ 第四头永远报 0」和「⑨ 第四头根本没在扫」在驱动脚本里长得一模一样）。 */
  { sec: '§J', name: '页面自己拼 /local-assets 落盘（绕过那一道去重，应红）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutLocal1 = p => Net.post("/local-assets", p);</script>' },
  { sec: '§J', name: '第三页也跟着藏云端成品（收藏 / 素材库故意不藏，应红）', file: 'chars.html',
    anchor: '  const pager = Wb.pager.create({',
    to: '  window.__mutHide = x => AssetLocal.hideAsCloud(x);\r\n  const pager = Wb.pager.create({' },
  { sec: '§J', name: '某一页的「自动下载」不走公共那一条链（pull 掉到 1 处，应红）', file: 'favorites.html',
    anchor: '  const st = AssetLocal.pull(it, {',
    to: '  const st = AssetLocal.pullX(it, {' },
  { sec: '§J', name: '「藏不藏」长出第二份判据（应红在定义数）', file: 'assets.html',
    anchor: '<script src="assetlib.js"></script>',
    to: "<script src=\"ai-chat.js\"></script>\r\n<script>function hideAsCloud(o) { return !!o; }</script>" },
  { sec: '§J', name: '反向对照：注释里提到 /local-assets 不该算页面自拼路由（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '  const pager = Wb.pager.create({',
    to: "  /* 这一页以前想直接 fetch('/local-assets') 落盘，现在只走 AssetLocal.pull */\r\n  const pager = Wb.pager.create({" },
/* §K 的三个变异：一条正向 + **两条反向对照**。
   反向对照是必须的：这一档判的是「重复」，最容易变成一把无脑报警的尺子 ——
   值差一位（那是分叉，要人拍板）、@media 上下文不同（作用范围不同，删掉会改小屏表现），
   这两种都**不该**报。没有这两条的话，「§K 什么都报」和「§K 什么都不报」在驱动脚本里长得一模一样。 */
  { sec: '§K', name: '页面又抄了一条 ui.css 已经全有的规则（应红）', file: 'assets.html',
    anchor: '  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），',
    to: '  .task .tmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }\r\n  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），' },
  { sec: '§K', name: '反向对照：值差一位 —— 那是分叉不是重复（应放行）', file: 'assets.html', expectGreen: true,
    anchor: '  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），',
    to: '  .task .tmain { flex: 2; min-width: 0; display: flex; flex-direction: column; }\r\n  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），' },
  { sec: '§K', name: '反向对照：同一条规则但写在 @media 里 —— 作用范围不同（应放行）', file: 'assets.html', expectGreen: true,
    anchor: '  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），',
    to: '  @media (max-width: 760px) { .task .tmain { flex: 1; min-width: 0; display: flex; flex-direction: column; } }\r\n  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），' },];

let bad = 0;
restoreAll();
/* 把起始哈希打出来：万一上一次是被 SIGKILL 掐掉的（兜底还原拦不住那一种），
   泄漏已经变成了这一次的「起始状态」，脚本自己发现不了 —— 但两份日志一对照就看出来了。 */
console.log('起始基线（' + FILES.length + ' 个文件，跑完应完全一致）：'
  + [...before].map(([f, h]) => f.slice(0, 4) + ':' + h.slice(0, 8)).join(' '));
let r = run();
if (r.code !== 0) { bad++; console.log('[红] 基线就不绿，尺子有问题：\n' + r.out); } else console.log('[绿] 基线全绿');

for (const m of MUT) {
  restoreAll();
  const s = orig.get(m.file).toString('utf8');
  const n = s.split(m.anchor).length - 1;
  /* ② 锚点里不含换行（行尾风格一变就 0 命中，量的是尺子不是产品）；
        ③ 方向是「现在的正确写法 → 改坏的样子」。 */
  if (n !== 1) { bad++; console.log('[黄] ' + m.sec + ' ' + m.name + '：锚点在 ' + m.file + ' 命中 ' + n + ' 次（尺子坏了，不是产品坏了）'); continue; }
  write(m.file, Buffer.from(s.replace(m.anchor, m.to), 'utf8'));
  const res = run();
  const hit = res.out.indexOf('[红] ' + m.sec + ' ') >= 0;
  if (m.expectGreen) {
    if (res.code === 0) console.log('[绿] ' + m.sec + ' ' + m.name + ' —— 如期放行');
    else { bad++; console.log('[黄→红] ' + m.sec + ' ' + m.name + ' —— 不该红的也红了，这档判据在无脑报警'); }
    continue;
  }
  if (res.code === 0) { bad++; console.log('[黄→红] ' + m.sec + ' ' + m.name + ' —— 变异后仍全绿，这档判据是假的'); }
  else if (!hit) { bad++; console.log('[黄→红] ' + m.sec + ' ' + m.name + ' —— 红了，但红在别的档上'); }
  else console.log('[绿] ' + m.sec + ' ' + m.name + ' —— 变异后如期变红');
}

/* ④ 全部还原后按 SHA256 核对（专抓「脚本自己把源文件弄坏了」） */
restoreAll();
let polluted = 0;
for (const [f, h] of before) {
  if (sha(fs.readFileSync(path.join(ROOT, f))) !== h) { polluted++; console.log('[红] ' + f + ' 没还原干净（SHA256 不一致）'); }
}
if (polluted) bad++;
r = run();
if (r.code !== 0) { bad++; console.log('[红] 还原后仍不绿：\n' + r.out); } else console.log('[绿] 全部还原、哈希一致、再跑一遍仍全绿');

/* 判据自身的两条硬约定 */
restoreAll();
try {
  execFileSync(process.execPath, [J, '不存在的文件.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  bad++; console.log('[黄] 指定不存在的文件时仍然 exit 0');
} catch (e) { console.log('[绿] 指定不存在的文件会判红（exit ' + (e.status || 1) + '）'); }
const plain = execFileSync(process.execPath, [J], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
/* §A 的结论句里这两个数是「真的查了」的证据。改措辞时这里要跟着改 ——
   不然判据照常全绿，而这条守门员自己悄悄失效（它守的正是「不带参数也真查」）。 */
const nums = /查了 (\d+) 段内联脚本：(\d+) 处裸调用、(\d+) 处成员访问/.exec(plain);
if (!nums || Number(nums[1]) < 5 || Number(nums[2]) < 100 || Number(nums[3]) < 100) {
  bad++; console.log('[黄] 不带参数时没有真的在查');
} else console.log('[绿] 不带参数也真查：' + nums[1] + ' 段 / ' + nums[2] + ' 处裸调用 / ' + nums[3] + ' 处成员访问');

console.log('\n' + (bad ? '变异自检红 ' + bad + ' 条' : '变异自检全绿：' + MUT.length + ' 个变异都能让对应判据变红，还原后哈希一致'));
process.exit(bad ? 1 : 0);