/* 常驻判据的变异自检 —— 判据自己也会「悄悄变成一把不坏的假尺子」，
   所以改完 tests/selfcheck.cjs 一定要跑一遍这个。
   跑法：`node tests/mutation.cjs`（它会临时改源文件，跑完自动还原）。
   只重跑某几刀：`MUT_ONLY=㉑ node tests/mutation.cjs`（按「档名 + 刀名」子串筛；
   改了哪一档的判据就重跑那一带，别在另一路会话正写这份目录时跑全量 —— 见下面分片口那一段）。 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const J = path.join(ROOT, 'tests', 'selfcheck.cjs');
const FILES = ['director.html', 'assets.html', 'ident.js', 'assetlib.js', 'shell.html', 'proxy.js',
  'chars.js', 'settings.html', 'studio.html', 'ai-chat.js', 'favorites.html', 'chars.html',
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
  { sec: '§A', name: '兄弟函数里裸调局部 const（当年 drama.html 那次的原样复现；该页已删，改钉 director.html）', file: 'director.html',
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
  { sec: '§B', name: '模板串原始文本里写「块注释 + 反引号」（改钉在 director.html）', file: 'director.html',
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
  /* 这条锚点原来是**两行**（`const hash = sha1Of(buf);` + `const hit = sums.get(...)`）带 `\r\n`，
     而 proxy.js 是 LF —— 于是它一直「命中 0 次」，这一条变异等于从来没跑过（判据里的 ② 早写了
     「锚点里不含换行」，这条是漏网的）。2026-10 第二轮顺手修好：换成循环里唯一的那一行做锚点，
     插进去的 unlink 位置与原来等价（都在补存那一步、都在读回字节之后）。 */
  { sec: '§G', name: '补存那一步开始删 .assets 里的原件', file: 'proxy.js',
    anchor: "          if (sumsDir !== dir) { sumsDir = dir; sums = saveDirIndex(dir); }",
    to: "          if (sumsDir !== dir) { sumsDir = dir; sums = saveDirIndex(dir); }\n          try { fs.unlinkSync(src); } catch (e) { /* 删了 */ }" },
  { sec: '§G', name: '搬迁时先删源再写目标（写失败源文件就没了）', file: 'proxy.js',
    anchor: 'fs.writeFileSync(path.join(to, file), buf);',
    to: 'fs.unlinkSync(src); fs.writeFileSync(path.join(to, file), buf);' },
  { sec: '§G', name: '页面开始把目标目录一起递过去', file: 'assetlib.js',
    anchor: 'body: JSON.stringify({ kind, from }),',
    to: 'body: JSON.stringify({ kind, from, dir: "" }),' },
  { sec: '§G', name: '搬迁不再拦「旧目录 = .assets」（会把资产库搬空）', file: 'proxy.js',
    anchor: 'for (const d of srcDirs) if (insideLocalDir(d)) return fail(403,',
    to: 'for (const d of srcDirs) if (false && insideLocalDir(d)) return fail(403,' },
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
  { sec: '§H', name: '界面赋值的那句提示里带 markdown 标记', file: 'chars.js',
    anchor: '调大就是多画几张：',
    to: '调大就是**多画几张**：' },
  /* 这一条只钉住 UI_SINK 上新加的两个名字（sub / body）**与「以 + 开头的续写行往上找 3 行」那一条**。
     Confirm.ask / choose 的正文与副标题都走 textContent，星号会原样糊到用户脸上；
     少了这一条，名单里写没写过它们看不出来 —— 上面那一条打在 `hint:` 上，替不了这一档。
     星号注在**续写行**上（不是 sub: 那一行）：那才是当年判据一声不吭的形态。 */
  { sec: '§H', name: 'Confirm 弹窗副标题的续写行里带 markdown 标记（认 sub + 续写行这两档才会红）', file: 'settings.html',
    anchor: "          + '用后者的密钥发这个地址，上游多半会以「密钥无效」拒绝。'",
    to: "          + '用后者的**密钥**发这个地址，上游多半会以「密钥无效」拒绝。'" },
  { sec: '§H', name: '反向对照：给模型的系统提示词里用 markdown（应放行）', file: 'assetlib.js', expectGreen: true,
    anchor: "    char_image: '你是美术设定师，",
    to: "    const __MUT_SYS__ = '请**严格**按下面的说明回答，不要凭空编造';\r\n    char_image: '你是美术设定师，" },
  /* §I 的三个分支各一个变异。第一个同时会打中「判断有两处」与「旧措辞复活」两档 ——
     写第二份内联口径这两件事是同时发生的，不该拆成两个变异充数。 */
  { sec: '§I', name: '某处改回内联写法（判断多出一处 + 旧措辞复活 + note 又被丢掉）', file: 'studio.html',
    anchor: "  const where = src ? Capabilities.srcTextOf(src) : '';",
    to: "  const where = src ? (src.from === 'api' ? '来自上游 /models' : '来自本项目的平台声明（上游接口没给或不可用）') : '';" },
  /* ⚠ 这一条以前锚在一个单行三元 `return src.from === 'api' ? (…) : (…)` 上，
     而 srcTextOf 早就改成 `if (src.from === 'api') { … }` 分块写法（为了塞 stale 那一句）。
     锚点匹配不上 → replace 空转 → 变异根本没发生 → 这一档**一直**在报「通过」。
     判据自己骗自己，所以改成锚在现存的 `return src.note || …` 那一行上：
     把它换成内联的三元，旧措辞会复活，同时多出一处判断。 */
  { sec: '§I', name: 'srcTextOf 自己把 note 换成那句零信息的话', file: 'assetlib.js',
    anchor: "    return src.note || '按平台声明兜底';",
    to: "    return src.from === 'api' ? '来自上游 /models' : '来自本项目的平台声明（上游接口没给或不可用）';" },
  { sec: '§I', name: '某处不再调 srcTextOf（口径分叉，但措辞一个字没多）', file: 'studio.html',
    anchor: "    if (src) bits.push(Capabilities.srcTextOf(src));",
    to: "    if (src) bits.push('能力来自上游接口');" },
  { sec: '§G', name: '补存那步的 .assets 闸被短路掉（文本还在、永远不执行）', file: 'proxy.js',
    anchor: "if (insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }",
    to: "if (false && insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }" },
  /* §G 新增那条「配音 off 三处口径」的三个变异。
     真实事故（2026-10）：`/render` 的 POST 是**逐字段重写** spec 的，
     加了 `off` 字段时页面发了、`renderJob` 也读了，唯独中间那层没放行 ——
     结果是「剪切过开头的那一句」合成时又从音频第 0 秒整句放出来，
     而试听/预览听得到剪掉的那一截，界面一个字都不说。
     三头都要能红，少一头就说明判据只看了一头。 */
  /* 页面这两刀各钉 `clipVoices` 的一支（2026-10-15 起这一句有两条路：没被灰场拆开的整句、
     与拆成几截的每截）—— 判据现在按「函数体里三条都要在」算，所以砍任意一支都会红，
     只留一刀就是「另一支没人量」。锚点必须**整行唯一**（`const off0 = …` 那一串全文件有四处）。 */
  { sec: '§G', name: '页面不再把配音的 off 写进提交体（整句那一支丢字段 = 剪过开头的那句被整句放出来）', file: 'director.html',
    anchor: 'dur: dur, off: off0 }',
    to: 'dur: dur, off: 0 }' },
  { sec: '§G', name: '被灰场拆成几截的那一句第二段起不累加 off（三截连起来听着还是同一句的开头）', file: 'director.html',
    anchor: 'dur: Math.max(0.1, (r[1] - r[0]) * vr), off: off0 + consumed,',
    to: 'dur: Math.max(0.1, (r[1] - r[0]) * vr), off: consumed,' },
  { sec: '§G', name: '/render 路由漏放行 voices[].off（逐字段重写 spec 那一层最会漏）', file: 'proxy.js',
    anchor: 'off: Math.max(0, Number(v && v.off) || 0),',
    to: '' },
  { sec: '§G', name: 'renderJob 不再按 off 取那一句（-ss off 那一路没了）', file: 'proxy.js',
    /* 锚点以前写的是 `off: Math.max(0, Number(v.off) || 0) });` —— 后来给同一句末尾补了 `spd`，
       那串一行锚点命中 0 次，这一刀从没落下过（mutation.cjs 自己的锚点检查当场报黄）。
       现在取「这一行独有、且不含换行」的那一段：`vol: clampVol(v.vol, 1), ` 是它的身份证
       （/render 路由那一处逐字段重写时也读 off，但写法是 `v && v.off`，撞不上）。 */
    anchor: 'vol: clampVol(v.vol, 1), off: Math.max(0, Number(v.off) || 0),',
    to: 'vol: clampVol(v.vol, 1), off: 0,' },
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
   外加一条反向对照：.sb-chip / .ap-chip 是别的类名（侧栏那排与资产选择器的类型页），
   它们长得像但不是筛选芯片行，不该被算进来。没有这条对照，「§J 什么都报」和「§J 什么都不报」
   在驱动脚本里长得一模一样。
   ⚠ 这一条**不能**再用 'ai-chip' 当样本（2026-10-16 改）：㉔ 那一档（AI 芯片只许 ui.js 的
   AiChip 一份）认的是「字符串里同时出现 `<span` 与 `ai-chip`」，页面手拼一颗 ai-chip
   本来就该红 —— 拿它当「应放行」的夹具，等于让两条判据正面相撞，报出来的是夹具的错。 */
  { sec: '§J', name: '页面又自建了一份芯片行（拼 innerHTML 那种写法）', file: 'chars.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutChips1 = items => items.map(v => \'<button class="chip">\' + v + \'</button>\').join(\'\');</script>' },
  { sec: '§J', name: '页面又自建了一份芯片行（createElement + className 那种写法）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutChips2 = () => { const b = document.createElement("button"); b.className = \'chip\'; return b; };</script>' },
  { sec: '§J', name: '反向对照：.sb-chip / .ap-chip 是别的类名，不该算自建芯片行（应放行）', file: 'assets.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutChips3 = () => \'<span class="sb-chip">x</span>\' + \'<span class="ap-chip">y</span>\';</script>' },
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
     C 某一页的「自动下载」不走公共那一条链 → 红在 pullMany 掉到 3 处
       （2026-10 第二轮改口：页面里那个 `AssetLocal.pull(...)` 已经收进公共层 `pullMany`，
        所以「不走公共那一条链」现在的形状是**这一页不再调 pullMany**，
        而不是「自己再写一遍 pull」—— 后者由「pull 在页面里必须 0 处」那一条单独管）；
     D 判据长出第二份（页面里再写一个 hideAsCloud）→ 红在定义数；
     E 「存回本机」的范围又跟「不显示云端任务」走 → 红（2026-10 第四轮加的 ⑨-b 那一把尺子）。
       两页各一条：资产库退回不带参数的 `applyFilters()`、工作台退回 `filteredItems()` ——
       这是同一个错误的两种形状，而且**上一轮的 `hideAsCloud` 调用点判据对它们完全看不见**
       （藏是在列表函数里统一做的，调用点一处都不多），所以这两条变异是那把尺子唯一的凭据；
     F 反向对照：范围函数的**注释**里提一句 hideAsCloud 不该算（应放行）——
       没有它的话，「⑨-b 从来没扫到过东西」与「⑨-b 好好在扫」在驱动脚本里长得一模一样；
     反向对照：注释里提一句 fetch('/local-assets') 不该算自拼路由
       （studio.html 正文里本来就有三句这样的说明文字，基线全绿靠的正是词法器剥注释 —— 没有这一条对照，
        「⑨ 第四头永远报 0」和「⑨ 第四头根本没在扫」在驱动脚本里长得一模一样）。 */
  { sec: '§J', name: '页面自己拼 /local-assets 落盘（绕过那一道去重，应红）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.__mutLocal1 = p => Net.post("/local-assets", p);</script>' },
  { sec: '§J', name: '第三页也跟着藏云端成品（收藏 / 素材库故意不藏，应红）', file: 'chars.html',
    anchor: '  const pager = Wb.pager.create({',
    to: '  window.__mutHide = x => AssetLocal.hideAsCloud(x);\r\n  const pager = Wb.pager.create({' },
  { sec: '§J', name: '某一页的「自动下载」不走公共那一条链（pullMany 掉到 3 处，应红）', file: 'favorites.html',
    anchor: '    const s = await AssetLocal.pullMany(todo.map(it => ({',
    to: '    const s = await AssetLocal.pullAll(todo.map(it => ({' },
  { sec: '§J', name: '「存回本机」的范围又跟「不显示云端任务」走（资产库退回不带参数的 applyFilters，应红）', file: 'assets.html',
    anchor: '  return applyFilters({ includeHidden: true }).filter(a => {',
    to: '  return applyFilters().filter(a => {' },
  { sec: '§J', name: '「存回本机」的范围又跟「不显示云端任务」走（工作台退回 filteredItems，应红）', file: 'studio.html',
    anchor: '  return (mergedBatch || mergedItems()).filter(e => {',
    to: '  return (mergedBatch || filteredItems()).filter(e => {' },
  { sec: '§J', name: '反向对照：范围函数的注释里提到 hideAsCloud 不该算（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: 'function pullScope() {',
    to: 'function pullScope() {\n  /* 这一颗不跟 hideAsCloud 走：藏起来 ≠ 不该存 */' },
  { sec: '§J', name: '「藏不藏」长出第二份判据（应红在定义数）', file: 'assets.html',
    anchor: '<script src="assetlib.js"></script>',
    to: "<script src=\"ai-chat.js\"></script>\r\n<script>function hideAsCloud(o) { return !!o; }</script>" },
  { sec: '§J', name: '反向对照：注释里提到 /local-assets 不该算页面自拼路由（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '  const pager = Wb.pager.create({',
    to: "  /* 这一页以前想直接 fetch('/local-assets') 落盘，现在只走 AssetLocal.pull */\r\n  const pager = Wb.pager.create({" },
/* §J 的第 ⑭ 支（三排声明驱动控件只有 AdvExtras 一份）要四条：
     A 页面再写一份同名判据 → 红（本轮导演台补这三排之前，最容易复发的就是这个形状）；
     B 某一页整块退回自己拼 params（AdvExtras.read 的调用点少一家）→ 红
       —— 只查定义数的话「两页都不再用公共层」反而全绿，那是空断言；
     C 公共层长出第二份定义 → 红；
     D 反向对照：注释里写一句 function topBoolStateOf(d) 不该算第二份实现（应放行），
       外加页面**调用**公共层那一份也不该算。 */
  { sec: '§J', name: '页面又自己写了一份三排控件的判据（应红）', file: 'director.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function topBoolStateOf(d) { return { hidden: false, def: !!d }; }</script>' },
  { sec: '§J', name: '某一页不再走公共读回（自己拼 params，顶层开关发不出去，应红）', file: 'studio.html',
    anchor: '  return window.AdvExtras.read({',
    to: '  return window.__legacyAdvRead({' },
  { sec: '§J', name: 'AdvExtras 长出第二份定义（判据与实现脱节，应红）', file: 'assets.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>window.AdvExtras = { __mut: 1 };</script>' },
  { sec: '§J', name: '反向对照：注释里提到 function topBoolStateOf 与调用公共层那份都不该算自写判据（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 以前这一页有 function topBoolStateOf(d)，现在只调公共层那一份 */\nwindow.__mutAdvCall = d => window.AdvExtras.topBoolStateOf(d, {});\n</script>' },
/* §J 的第 ⑮ 支（输入模式那一族只有 Capabilities 一份）要五条：
     A 页面抄一张同名的素材名表 → 红（本轮修掉的就是这个形状：工作台一份「首帧图」、导演台一份「首帧」）；
     B 页面自己写一份双向判据 → 红；
     C 某一页不再走公共的芯片画法（退回自己拼）→ 红 ——「页面不许出现」这一半必须有另一半「公共那份确实在被用」，
       否则两页全断开时判据反而全绿（⑭ B 同一套路）；
     D 公共层那一句措辞没了 → 红在「尺子没底座」，别让页面那半变成空断言；
     E 反向对照：注释里提一句 function comboGaps、页面写**一行转发**（右边点的就是 Capabilities.同名）
       都不该算第二份实现 —— 把转发也照红，改的人只能把公共层再抄一遍才算「没有副本」。 */
  { sec: '§J', name: '页面又抄了一份素材名表（同一个 role 两个页面叫两个名字，应红）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>const ROLE_ZH = { first_frame: \'首帧\', reference_image: \'参考图\' };</script>' },
  { sec: '§J', name: '页面又自己写了一份双向形状判据（应红）', file: 'favorites.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>function comboGaps(m, id, counts) { return { ok: true, lines: [] }; }</script>' },
  { sec: '§J', name: '工作台不再走公共的芯片画法（页面「不许出现」那半成了空断言，应红）', file: 'studio.html',
    anchor: "  const chips = comboChips(list, cur().combo);",
    to: "  const chips = list.map(c => '<button class=\"ui-pill\" data-cid=\"' + c.id + '\">' + comboLabel(c) + '</button>').join('');" },
  { sec: '§J', name: '公共层那一句说明没了（尺子没底座，应红）', file: 'assetlib.js',
    anchor: "      ? '这一档收：' + cb.roles.map(r => this.roleZh(r.role)",
    to: "      ? '变异：措辞被改掉了 ' + cb.roles.map(r => this.roleZh(r.role)" },
  { sec: '§J', name: '反向对照：注释里提 function comboGaps 与页面的一行转发都不该算副本（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 以前这一页有 function comboGaps(model, id, counts)，现在只调公共层那一份 */\nconst ROLE_ZH = (window.Capabilities && Capabilities.ROLE_ZH) || {};\nconst comboLabel = cb => (window.Capabilities && Capabilities.comboLabel) ? Capabilities.comboLabel(cb) : \'\';\nwindow.__mutComboRef = (m, id, c) => window.Capabilities.comboGaps(m, id, c);\n</script>' },
  /* §J ⑭ 的两个变异：漏掉「连 modelDocs 一起查」的那一处必须红。
     真实事故（2026-10）：工作台 `currentModel()` 只在 `p.models` 里找型号，而纯声明驱动的
     那几家（MiMo 全家）在能力刷新之后 `p.models` 里只剩空壳壳 ——
     `inputRoles`（参考音频槽）与 `modes`（音色复刻/设计）整块不在当前型号上，
     界面上只剩「当前型号只支持纯文字生成」。用户报的两条都出在这里。
     反向对照：并集读法里**多加**一句注释不该红（判据看的是真取用，不是提到）。 */
  { sec: '§J', name: '工作台的 currentModel 不再连 modelDocs 一起查（参考音频槽与三档模式消失，应红）', file: 'studio.html',
    anchor: '    const base = (p.models || []).concat((p.modelDocs) || []);',
    to: '    const base = (p.models || []);' },
  { sec: '§J', name: '反向对照：并集读法旁边加一句说明注释不该红（应放行）', file: 'studio.html', expectGreen: true,
    anchor: '    const base = (p.models || []).concat((p.modelDocs) || []);',
    to: '    /* 这里必须连 modelDocs 一起查 */\r\n    const base = (p.models || []).concat((p.modelDocs) || []);' },
/* §J ⑰（时间文案只许一份：`Wb.fmtSec` 的「X 分 Y 秒」、`Wb.fmtClock` 的 mm:ss）的四刀 + 一条反向对照。
   这一档认的是**拼法形状**落在哪、公共那两份被真调了几次，所以两个方向都要钉：
   A/B 页面又自己拼一遍 → 形状数 2 → 红；
   C/D 公共层那一份换了写法（`'分钟'` 没有中间那个 `' 分 '` 字面量；mm:ss 的 `':'` 换成 `'.'`）→ 形状数 0 →
     「一处都没有」也要红 —— 少了这两刀，「页面全都不走公共层 + fmtSec 自己没了」和「一切正常」长得一模一样。
   E 反向对照：注释里写全这两种拼法、页面用**另一种连接符**的读数、以及一行转发调公共层，都不该算副本
     （判据要是把这三样也照红，下一个改文案的人只能把公共层再抄一遍才算「没有副本」）。 */
  { sec: '§J', name: '导演台候选卡又自己拼了一份「X 分 Y 秒」（公共那句被绕过，应红）', file: 'director.html',
    anchor: "      waited != null ? ['已耗时', Wb.fmtSec(waited)] : null,",
    to: "      waited != null ? ['已耗时', (waited >= 60 ? Math.floor(waited / 60) + ' 分 ' + (waited % 60) + ' 秒' : waited + ' 秒')] : null," },
  { sec: '§J', name: '导演台插针读数又自己拼了一份 mm:ss（padStart 两侧各一次 + 冒号，应红）', file: 'director.html',
    anchor: '    tb.textContent = Wb.fmtClock(target) + \' / \' + Wb.fmtClock(dur || 0);',
    to: '    tb.textContent = Wb.fmtClock(target) + \' / \' + Wb.fmtClock(dur || 0);\r\n    const __mutClock__ = String(Math.floor(target / 60)).padStart(2, \'0\') + \':\' + String(Math.floor(target % 60)).padStart(2, \'0\');' },
  { sec: '§J', name: '公共层那一份「X 分 Y 秒」换了措辞（形状没底座了，应红）', file: 'workbench.js',
    anchor: "      return s >= 60 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒';",
    to: "      return s >= 60 ? Math.floor(s / 60) + '分钟' + (s % 60) + '秒' : s + '秒';" },
  { sec: '§J', name: '公共层 mm:ss 的连接符改成点号（判据认的那一份不见了，应红）', file: 'workbench.js',
    anchor: "      return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(Math.floor(v % 60)).padStart(2, '0');",
    to: "      return String(Math.floor(v / 60)).padStart(2, '0') + '.' + String(Math.floor(v % 60)).padStart(2, '0');" },
  { sec: '§J', name: '反向对照：注释写全两种拼法 + 点号读数 + 一行转发都不该算副本（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 这一页以前自己拼过 Math.floor(s / 60) + \' 分 \' + (s % 60) + \' 秒\'，也拼过 String(…).padStart(2, \'0\') + \':\' + String(…).padStart(2, \'0\')，现在只调公共层那两份 */\nconst __mutDot__ = n => String(n % 60).padStart(2, \'0\') + \'.\' + String(Math.floor(n / 60)).padStart(2, \'0\');\nwindow.__mutTimeRef = n => window.Wb.fmtSec(n) + \' \' + window.Wb.fmtClock(n) + \' \' + __mutDot__(n);\n</script>' },
/* ⑱ 日期与时刻（2026-10-15 收成 ui.js 那五份 + 代理自己那一份 dayPart）：四刀各钉住判据的一头。
   最后一把是 expectGreen —— 这一档禁的是「拿 locale API 排日期」与「手拼年-月-日」，
   而数值千分位 `Number(x).toLocaleString()` 在用量页有十几处、界面文案的注释里也会提到那几个 API名，
   把它们也算副本就是一把无脑报警的尺子（报得多 ≠ 判得准）。 */
  { sec: '§J', name: '资产库日期列退回 locale 排法（换台机器就换一种写法那一族，应红）', file: 'assets.html',
    anchor: '  const date = window.fmtWhen(a.ts);',
    to: "  const date = a.ts ? new Date(a.ts).toLocaleString('zh-CN') : '';" },
  { sec: '§J', name: '导演台提交时刻又自己拼一份「年-月-日」（公共那一份被绕过，应红）', file: 'director.html',
    anchor: "  if (c.created) bits.push('提交 ' + window.fmtHM(c.created));",
    to: "  if (c.created) bits.push('提交 ' + (new Date(c.created).getFullYear() + '-' + String(new Date(c.created).getMonth() + 1).padStart(2, '0')));"},
  { sec: '§J', name: '代理侧把 dayPart 又抄第二遍（Node 那一族退回两份手拼，应红）', file: 'proxy.js',
    anchor: "const timeText = d => dayPart(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());",
    to: "const timeText = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());" },
  { sec: '§J', name: 'ui.js 的 dayKey 整份改名（判据「一处没有也要红」那一头）', file: 'ui.js',
    anchor: '  function dayKey(t) {',
    to: '  function dayKeyRenamed(t) {' },
  { sec: '§J', name: '反向对照：千分位 toLocaleString + 注释里点名那几个 API + 只加兜底的薄封装都不算副本（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 这一页以前用 toLocaleDateString 与 toLocaleString 排日期，现在只调 ui.js 那一份；\n   下面这行是**千分位**（数值），不是日期，不该被算进那一族 */\nconst __mutFmtTime__ = ts => window.fmtWhen(ts) || \'—\';\nwindow.__mutNum__ = n => Number(n).toLocaleString() + \' \' + __mutFmtTime__(n) + \' \' + window.dayKey(n) + \' \' + window.fmtHMS(n);\n</script>' },
/* ⑲ 下载文件名（2026-10-15 收成 ui.js 的 fileSafe / fileStamp + 代理自己那一份 fileSafe）：五刀各钉一头。
   这一档判据有**三头**，所以变异也分三组，缺任一组都可能「代码烂了而尺子全绿」：
   A 页面又自己洗一遍保留字符 → 「洗的形状 3 处」红；
   B/C 公共那两份各自整份改名 → 「定义数不对」与「一处没有也要红」两头（少了 B/C，
     「把 ui.js / proxy.js 的 fileSafe 删光、页面全退回自己拼」和「一切正常」在尺子里长得一样）；
   D/E 调用点退回自己拼 → 「window.fileSafe / window.fileStamp 被调次数低于下限」两头 —— 这一头钉的是
     「实现还在但没人用了」：只查定义数的话，八处下载点全被改成手拼而公共层留着一份孤儿函数，照样全绿。
   F 反向对照：注释里点名那几个保留字符、只用于**校验**（不写文件）的正则、
     转发型的薄封装（名字带 fileSafe）、以及另一条 `.replace(`（洗空白）—— 四种都不该算副本。
   ⚠ 第一刀实测**一次红两头**（「洗的形状 3 处」+「window.fileSafe 只被调 8 次」）：
     它把那一处的 `window.fileSafe(` 调用一起换成了自己拼的正则，所以调用数那一头跟着掉 —— 两条点名的是同一件事，不算误伤。 */
  { sec: '§J', name: '资产库下载名又自己洗一遍保留字符（公共那份被绕过，应红在「洗的形状 3 处」）', file: 'assets.html',
    anchor: "  return window.fileStamp(a.ts) + ' ' + window.fileSafe(a.prompt || '素材', 24) + '.' + window.fileExtOf(a);",
    to: "  return window.fileStamp(a.ts) + ' ' + String(a.prompt || '素材').replace(/[\\\\/:*?\"<>|]/g, '_').slice(0, 24) + '.' + window.fileExtOf(a);" },
  { sec: '§J', name: 'ui.js 的 fileSafe 整份改名（浏览器那一族没底座了，应红在「定义数 1 / 期望 2」）', file: 'ui.js',
    anchor: '  function fileSafe(s, max) {',
    to: '  function fileSafeRenamed(s, max) {' },
  { sec: '§J', name: 'proxy.js 的 fileSafe 整份改名（Node 那一份没了，应红在「洗的形状只剩 1 处」）', file: 'proxy.js',
    anchor: 'function fileSafe(s, max) {',
    to: 'function fileSafeNodeRenamed(s, max) {' },
  { sec: '§J', name: '导演台另存素材退回裸文件名（少一处走公共清洗，应红在「fileSafe 只被调 7 次」）', file: 'director.html',
    anchor: '        const saved = await saveBlob(window.fileSafe(j.name, 80) + \'.\' + ext, blob);',
    to: '        const saved = await saveBlob(j.name + \'.\' + ext, blob);' },
  { sec: '§J', name: '导演台成片名退回不带时间戳（公共 fileStamp 变成孤儿，应红在「fileStamp 只被调 2 次」）', file: 'director.html',
    anchor: "  return window.fileSafe((proj && proj.name) || '成片', 60) + '-成片-' + window.fileStamp() + '.' + ext;",
    to: "  return window.fileSafe((proj && proj.name) || '成片', 60) + '-成片.' + ext;" },
  { sec: '§J', name: '反向对照：注释点名保留字符 + 只校验不写文件的正则 + 转发薄封装都不算副本（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 这一页以前把 \\ / : * ? " < > | 换成一串下划线，现在只调 ui.js 那一份 */\nconst __mutBad__ = s => /[\\\\/:*?\"<>|]/.test(String(s));\nconst __mutSpace__ = s => String(s).replace(/\\s+/g, \' \');\nfunction fileSafeNote(s) { return window.fileSafe(s, 60); }\nwindow.__mutName__ = s => fileSafeNote(__mutSpace__(s)) + \' \' + __mutBad__(s) + \' \' + window.fileStamp(0);\n</script>' },
/* ⑳「网络与刷新那三个数字」（超时 / 重试 / 轮询间隔）。这一档判据有两头四支，所以变异分四组：
     A 页面又自己读写那三个键 → 红在「自己读写那三个键 1 处」；
     B 标记里把 min / max 抄回来（第四份上下限）→ 红在「标记里写区间 1 处」；
     C 别的页面又写一张 `const NUMS` → 红在「有 2 处定义」；
     D ui.js 那一份改名 → 红在「0 处定义」（只查 C 的话，「把表整块删掉」读起来像全绿）；
     E/F 两个消费者退回硬编码 → 红在「Net.storedNum / Net.setNum 一处都没被问到」——
       这两头钉的是「表还在但没人读」：设置页与轮询器各有一份自己的夹取时，界面上看不出被截过。
   ⚠「唯一定义不在 ui.js」那一支（else if）一把单锚点刀够不着：它要先删掉 ui.js 那一份、
     再在别处建一份，两次编辑。所以 C/D 两支覆盖的是同一条断言的两个分支，这里如实记下。
   G 反向对照：只点名键名的清单行（两张同步白名单那种）、别的键的 localStorage 读写、
     注释里提到 Net.NUMS（词法器会剥注释）、`id="pollSecX"` 这种撞名输入框、
     页面里一个跟 Net 无关的 `num` 局部函数 —— 五种都不该算副本。 */
  { sec: '§J', name: '设置页退回自己读那个键（页面上多出一把夹取，应红在「自己读写那三个键 1 处」）', file: 'settings.html',
    anchor: "    el.value = Net.num(row[1]);",
    to: "    el.value = Net.num(row[1]) || Number(localStorage.getItem('sk_net_timeout')) || 30;" },
  { sec: '§J', name: '标记里把 min / max 抄回来（第四份上下限，应红在「标记里写区间 1 处」）', file: 'settings.html',
    anchor: "        <input type=\"number\" id=\"netTimeout\" step=\"5\" style=\"width:78px\"> 秒</label>",
    to: "        <input type=\"number\" id=\"netTimeout\" step=\"5\" min=\"5\" max=\"300\" style=\"width:78px\"> 秒</label>" },
  { sec: '§J', name: '工作台又写一张自己的表（两份上下限，应红在「const NUMS 有 2 处定义」）', file: 'studio.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>const NUMS = { poll: { def: 4, min: 2, max: 90 } };\r\nwindow.__mutNums2__ = NUMS;\r\n</script>' },
  { sec: '§J', name: 'ui.js 那张表整块改名（浏览器侧没有底座了，应红在「0 处定义」）', file: 'ui.js',
    anchor: '  const NUMS = {',
    to: '  const NET_NUMS_TABLE = {' },
  { sec: '§J', name: '轮询器不再问那张表（改设置要刷新页面才生效，应红在「Net.storedNum 一处都没被问到」）', file: 'workbench.js',
    anchor: "const sec = window.Net && Net.storedNum ? Net.storedNum('poll') : null;",
    to: "const sec = (Number(o.interval) || 4000) / 1000;" },
  { sec: '§J', name: '设置页保存不再走 setNum（夹那一步只剩页面自己那份，应红在「Net.setNum 一处都没被问到」）', file: 'settings.html',
    anchor: "el.addEventListener('change', () => { el.value = Net.setNum(row[1], el.value); });",
    to: "el.addEventListener('change', () => { el.value = Net.num(row[1]); });" },
  { sec: '§J', name: '反向对照：键名清单 / 别的键的读写 / 注释里的 Net.NUMS / 撞名输入框 / 页面自己的 num 局部函数（应放行）', file: 'assets.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 反向对照：这一族区间只在 ui.js 的 Net.NUMS 一张表里，这里几行都不该被算成副本 */\nconst __mutKeys__ = [\'sk_net_timeout\', \'sk_poll_sec\'];\nlocalStorage.setItem(\'sk_theme_mode\', \'dark\');\nconst __mutNum__ = n => Math.min(60, Math.max(2, n));\nwindow.__mutMark__ = \'<input type="number" id="pollSecX" min="2">\';\nwindow.__mutOut__ = __mutNum__(__mutKeys__.length);\n</script>' },
/* ㉑「这段文本几个字、在不在这一家声明的区间里」那一族（`CharLimits`）与「定音色缺哪一格」（`TtsAdv.wayWhy`）。
   判据有四头，变异就按头分，每一刀点名它**应当**红在哪一头：
     A/B 两页各自退回自己拼字数措辞 → 红在「页面里又出现自己拼的字数措辞」（A 同时红在 studio 没问 CharLimits.why）；
     C 导演台把提示词那一路整块闸删掉 → **只**红在「director.html 没问 CharLimits.why」。
       这一刀是照着上一轮那条红线写的：措辞一个字都没多、成员计数也没掉到门槛以下，
       如果 ㉑ 只查「有没有老措辞」，这一刀就静默过关（「闸门整块不见了」在界面上的表现是空话照样放行）。
     D 提交前那一道闸不再问公共层 → 红在「createBody 没问 CharLimits.prompt」；
     E/F 两处唯一定义整块改名 → 各红在「定义 0 处」—— 与「定义 2 处」是两种坏法：
       改名这一种**页面调用点一个都没动**，只查「多一处」的尺子在它上面照样全绿；
     G 公共层那句 canonical 措辞被换掉 → 红在「个字（ 只剩 1 处」：钉的是**尺子的底座**，
       底座没了之后 A/B 那一头就成了永远不会响的空断言（这一刀红的不是产品，是量产品的那把尺）；
     H/I 两页各自再写一份「定音色缺哪一格」 → 红在「某一页没走 TtsAdv.wayWhy」；
     J 反向对照：注释里点名那四套老措辞（词法器剥注释）、转发薄封装、第三页多问一次 —— 三种都不该算副本。
   ⚠ 两条「计数下限」断言（成员引用总数 ≥20、单成员 ≥2）一把单锚点刀够不着：它们要一次砍掉多处调用点，
     这里如实记下，不拿「其实红在别的档上」的刀凑数。 */
  { sec: '§J', name: '㉑A 工作台语音那一路退回自己拼「文本至少 / 文本超长」（应红在「页面里又出现自己拼的字数措辞」+ studio 没问 CharLimits.why）', file: 'studio.html',
    anchor: "    const lw = window.CharLimits.why(text, window.CharLimits.tts(prov.tts));",
    to: "    const lw = (text || '').trim().length < 5 ? '文本至少 5 个字' : ((text || '').length > 5000 ? '文本超长（最多 5000 字）' : '');" },
  { sec: '§J', name: '㉑B 导演台配音那一路退回自己拼下限（应红在「页面里又出现自己拼的字数措辞」）', file: 'director.html',
    anchor: "  return window.CharLimits.why(draft.text, window.CharLimits.tts(tts));",
    to: "  return ((draft.text || '').trim().length < 5) ? '文本至少 5 个字' : '';" },
  { sec: '§J', name: '㉑C 导演台把提示词那一路的字数闸整块删掉、一个字新措辞都不写（只有「落点」这一头该红）', file: 'director.html',
    anchor: "  return window.CharLimits.why((sh && sh.prompt) || '', PL, { who: PL.who, noun: '提示词' });",
    to: "  return '';" },
  { sec: '§J', name: '㉑D 提交前那道闸不再问公共层（发出去会被平台拼成一句英文，应红在「createBody 没问 CharLimits.prompt」）', file: 'assetlib.js',
    anchor: "        const b = window.CharLimits.prompt(spec.promptLimits, std.creation_intent);",
    to: "        const b = { min: 0, max: 0, omitted: false };" },
  { sec: '§J', name: '㉑E CharLimits 整块改名：定义没了而 30 处调用点一个字没动（应红在「定义有 0 处」）', file: 'assetlib.js',
    anchor: 'window.CharLimits = {', to: 'window.CharLimitsOld = {' },
  { sec: '§J', name: '㉑F TtsAdv.wayWhy 的定义改名：两页调用点都还在（应红在「wayWhy 定义有 0 处」）', file: 'assetlib.js',
    anchor: '  wayWhy(way, o) {', to: '  wayWhyOld(way, o) {' },
  { sec: '§J', name: '㉑G 公共层那句 canonical 措辞换掉（应红在「个字（ 只剩 1 处」—— 尺子没底座，A/B 那头会变成空断言）', file: 'assetlib.js',
    anchor: "b.max + ' 个字（现在 '", to: "b.max + ' 字符(现在 '" },
  { sec: '§J', name: '㉑H 导演台自己再写一份「定音色缺哪一格」（应红在「director.html 没走 TtsAdv.wayWhy」）', file: 'director.html',
    anchor: "  return window.TtsAdv.wayWhy(way, { design: draft.design, ref: ref });",
    to: "  return way && way.mode === 'design' && !(draft.design || '') ? '必须填写风格 / 音色描述' : way && way.mode === 'clone' && !ref ? '要先选一条参考音频' : '';" },
  { sec: '§J', name: '㉑I 工作台自己再写一份「定音色缺哪一格」（应红在「studio.html 没走 TtsAdv.wayWhy」）', file: 'studio.html',
    /* 这一路原来是两行（第二个实参在下一行），锚点不许含换行 → 用 `(x => x)(` 把下一行那个对象
       实参照单吞掉，替换后仍是合法 JS（语法自查那几档跟着全绿，红的只有落点这一头）。 */
    anchor: "const ww = window.TtsAdv.wayWhy({ mode: curTtsMode() },",
    to: "const ww = (curTtsMode() === 'design' && !($('style').value || '') ? '必须填写风格 / 音色描述' : curTtsMode() === 'clone' && !slotItems('audio').length ? '要先选一条参考音频' : ''), __mutSwallow__ = (x => x)(" },
  { sec: '§J', name: '㉑J 反向对照：注释里点名四套老措辞 + 转发薄封装 + 第三页多问一次（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 反向对照：以前这一族有四套说法 —— 工作台「文本至少 5 个字」「文本超长（最多 5000 字）」、提示行「平台要 5–5000 字」「平台最多」「平台至少要」、导演台「这一家要求至少 5 个字」、提交前又拼一句「要求提示词至少」。现在全部只问 assetlib.js 那一份，注释里讲这些历史不该算副本。 */\nconst __mutCl__ = (t, b) => window.CharLimits.why(t, b);\nwindow.__mutOut__ = __mutCl__(\'小猫\', window.CharLimits.tts(null));\n</script>' },
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
    to: '  @media (max-width: 760px) { .task .tmain { flex: 1; min-width: 0; display: flex; flex-direction: column; } }\r\n  /* .task 这一组的基础样式统一在 ui.css（缩略图尺寸、状态点、日期、按钮排都在那儿），' },
/* ㉒ 展示样式那一档「贴到容器上」的一步（`Wb.viewToggle`，见上面那一段说明）。三头各一刀：
     A 公共层清名单那一行没了 → 红在「view- 只有 1 处」：这一刀同时钉住**尺子的底座** ——
       底座没了之后 B 那一头（页面不许自己写）就永远不会响；
     B 页面自己再写一遍容器类名 → 红在「页面里又自己写了一遍」；
     C create 不点名容器 → 红在「没点名容器（target）」—— 开关能点而容器不跟着换，
       正是收成公共层之前资产库那份 `VIEW` 变量与各页 applyView 的坏法；
     D 反向对照：注释里引用旧写法（词法器剥注释）+ 走公共 apply + 静态面 ROWS，三种都不该算副本。 */
  { sec: '§J', name: '㉒A 公共层清名单那一行整块没了（应红在「view- 前缀只有 1 处」—— 尺子的底座）', file: 'workbench.js',
    anchor: "          views.forEach(v => g.classList.remove('view-' + v[0]));",
    to: '          void 0;' },
  { sec: '§J', name: '㉒B 页面自己再写一遍容器类名（应红在「页面里又自己写了一遍前缀 view-」）', file: 'chars.html',
    anchor: '  const viewToggle = Wb.viewToggle.create({',
    to: "  const __mutVt__ = v => document.getElementById('grid').classList.add('view-' + v);\r\n  const viewToggle = Wb.viewToggle.create({"},
  { sec: '§J', name: '㉒C 这一页的 create 不点名容器（应红在「没点名容器（target）」—— 切档位没反应）', file: 'assets.html',
    anchor: "  el: 'fView', key: 'dir_asset_view', target: 'grid',",
    to: "  el: 'fView', key: 'dir_asset_view',",
  },
  { sec: '§J', name: '㉒D 反向对照：注释里引用旧写法 + 走公共 apply + 静态面 ROWS（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\r\n<script>\n/* 反向对照：这一页以前自己写 grid.classList.remove(\x27view-card\x27, \x27view-list\x27) + add(\x27view-\x27 + 当前档)，现在只问公共层那一份。 */\nwindow.__mutVt__ = [Wb.viewToggle.ROWS, Wb.viewToggle.GRID].length;\n</script>' },
  /* ㉒ 第三头（2026-10 把「有几档、叫什么」从七个字面量收成 ui.js 的 window.VIEW_MODES 一处）：
       E 同一份清单在 ui.js 里再抄一行 → 红在「档位名点名 4 处（应为 2）」；
       F 页面又自己传 views: → 红在「还自己传档位清单」那一头；
       G 反向对照：页面**注释里**写全旧的那一份 views: [['list', '列表', …]]（词法器剥注释）应放行 ——
         这一刀钉住「判据按 token 形状数，不是按文本搜」，否则讲历史的注释会把这一档永远照红。 */
  { sec: '§J', name: '㉒E 档位名清单在 ui.js 又抄第二行（应红在「档位名点名 4 处」）', file: 'ui.js',
    anchor: "window.VIEW_MODES = [['list', '列表'], ['compact', '紧凑']];",
    to: "window.VIEW_MODES_OLD = [['list', '列表'], ['compact', '紧凑']];\r\n  window.VIEW_MODES = [['list', '列表'], ['compact', '紧凑']];" },
  { sec: '§J', name: '㉒F 页面又自己传 views 档位清单（应红在「还自己传档位清单（views）」）', file: 'chars.html',
    anchor: "    el: 'fView', key: 'dir_char_view', target: 'grid',",
    to: "    el: 'fView', key: 'dir_char_view', target: 'grid',\n    views: [['list', '列表', Wb.viewToggle.ROWS], ['compact', '紧凑', Wb.viewToggle.GRID]]," },
  { sec: '§J', name: '㉒G 反向对照：页面注释里写全旧的那一份 views 清单（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '  const viewToggle = Wb.viewToggle.create({',
    to: "  /* 反向对照：这一页以前也传 views: [['list', '列表', Wb.viewToggle.ROWS], ['compact', '紧凑', Wb.viewToggle.GRID]] —— 现在档位名只认 ui.js 那一份。 */\n  const viewToggle = Wb.viewToggle.create({",
  },
/* ⑲（续）「一条素材是哪一类 / 下载回来叫什么」那一族（⑲，见 selfcheck 那一段的口径）。三头各钉一边：
     A 公共层里那份「是不是声音」的判据被写短（只认「音频」）→ 红在「形状只在 0 处」：
       这一刀钉的是**尺子的底座** —— 底座没了之后 B 那一头（页面不许自己再写一遍）永远不会响；
     B/C/D 三页各自把一种形状抄回本地（音频名 / 媒体类别 / 下载尾缀）→ 各红在自己那一族的「2 处」；
       三刀都**故意只改一处调用点**：调用计数下限照着过（12→13、10→10、6→6 都还在闸内），
       所以红的只有「形状被重写了一遍」这一头，不会拿计数那一头凑数。
     E 定义整块改名：五处调用点一个字没动（与 ㉑E 同一形状）→ 红在「有 0 处定义」；
     F 一页退回自己拼时间戳 → 红在「window.fileStamp 只被调 3 次（应至少 4）」；
     G 反向对照：注释里写全两种旧形状 + 数组形状（数据表，没有比较）+ 只拼字符串不算猜尾缀 + 一行转发，
       四种都不该算副本 —— 这一档判的是 token 形状，不判文本里有没有那几个字。
   ⚠ 计数下限那一头（成员引用总数、单成员 ≥2）一把单锚点刀够不着，与 ㉑ 同一立场：如实记下，不拿别的刀凑。 */
  { sec: '§J', name: '⑲A 公共层那份「是不是声音」只认「音频」（应红在「形状只在 0 处」—— 尺子没了底座）', file: 'ui.js',
    anchor: "  function isAudioType(t) { return t === '音频' || t === '音乐'; }",
    to: "  function isAudioType(t) { return t === '音频'; }" },
  { sec: '§J', name: '⑲B 资产库自己再写一遍「哪些类型名算声音」（应红在「是不是声音 2 处」）', file: 'assets.html',
    anchor: "const typeKey = t => (window.isAudioType(t) ? '音频' : t);",
    to: "const typeKey = t => (t === '音频' || t === '音乐' ? '音频' : t);" },
  { sec: '§J', name: '⑲C 工作台把「类型名换媒体类别」抄回三分支（应红在「类型名换成媒体类别 2 处」）', file: 'studio.html',
    anchor: "  const want = known ? window.mediaKindOf(it.mtype) : '';",
    to: "  const want = it.mtype === '图片' ? 'image' : it.mtype === '视频' ? 'video' : window.isAudioType(it.mtype) ? 'audio' : '';" },
  { sec: '§J', name: '⑲D 数据层退回「视频?mp4:png」自己猜尾缀（应红在「猜下载扩展名 2 处」）', file: 'assetlib.js',
    anchor: "    const fmt = window.fileExtOf({ mtype: media, format: g('format') });",
    to: "    const fmt = media === '视频' ? 'mp4' : 'png';" },
  { sec: '§J', name: '⑲E fileExtOf 的定义改名：五处调用点都还在（应红在「有 0 处定义」）', file: 'ui.js',
    anchor: '  function fileExtOf(it) {', to: '  function fileExtOfOld(it) {' },
  { sec: '§J', name: '⑲F 资产库的下载名退回自己拼时间戳（应红在「window.fileStamp 只被调 3 次」）', file: 'assets.html',
    anchor: "  return window.fileStamp(a.ts) + ' ' + window.fileSafe(a.prompt || '素材', 24) + '.' + window.fileExtOf(a);",
    to: "  return String((a && a.ts) || '') + ' ' + window.fileSafe(a.prompt || '素材', 24) + '.' + window.fileExtOf(a);" },
  { sec: '§J', name: '⑲G 反向对照：注释写全两种旧形状 + 数组数据表 + 只拼字符串 + 一行转发（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前有四套写法 —— `t === \'音频\' || t === \'音乐\'`、`media === \'视频\' ? \'mp4\' : \'png\'`、`format ? \'.\' + format : \'\'`，注释里点名它们不该算副本（词法器剥注释）。 */\n  const __mutSlotTypes__ = [\'音频\', \'音乐\'];\n  const __mutGuess__ = \'mp4\' + \'.\' + \'png\';\n  const __mutAudio__ = t => window.isAudioType(t);\n  window.__mutOut__ = __mutAudio__(__mutSlotTypes__[0]) + __mutGuess__.length;\n</script>' },
  /* ㉔ 「AI 芯片」那一颗（写着「AI 挑了哪几条 / 按什么筛」并带一颗 ✕；2026-10-15 收成 ui.js 的 `AiChip`）：
       A 页面退回自己手拼一颗 → 红在「手拼一颗 AI 芯片」。**故意把四处公共调用全留着**，
         所以这一刀只打形状那一头（不让「计数掉下闸」顺带替它作证）。
       B 公共层定义改名（四处调用点一个字没动）→ 红在「AiChip 的定义有 0 处」—— 这一头专门防「整块没了，
         于是第①头的『形状 0 处』变成空断言」。
       C 收藏页不再走公共层（实现还在、这一页没人用）→ 红三句：paint 掉到 3、picked 掉到 1、落点缺 favorites。
         一次退回手拼会同时带走三个出口，这是同一次退步的三张脸，不是三把刀。
       D 页面自己再传一遍那句默认 title → 红在「现在有 2 处」。
         ⚠ 判据里紧跟着那条 `acClearOut`（恰好 1 处而它不在 ui.js）**单刀打不到**：它要求「页面有、公共层没有」，
         而一刀只能改一个文件。这一头的实际作用是「把恰好 1 处钉死在 ui.js」，与 `acPickPhrase[0]` 同一形状。
       E 公共层那句默认 title 退回旧措辞「回到完整名单」→ 红两头：「一处都没有」（尺子的底座）+「旧句又出现了」。
       F 反向对照：注释里写全两种被禁形状、只有类名没有 `<span`、只有 id 名没有 `id="`、
         页面用 `cls`/`clearId` 参数化接进公共层并多调一次合法的 text —— 五种都不该红。
     跑法同 ㉓：`MUT_ONLY=㉔ node tests/mutation.cjs`（分片会打印红条原话，逐刀核对它红在刀名点的那一头）。 */
  { sec: '§J', name: '㉔A 页面退回手拼一颗芯片（应红在「手拼一颗 AI 芯片」，四处公共调用一个没动）', file: 'chars.html',
    anchor: "    window.AiChip.paint('aiChip', { text: aiPick ? window.AiChip.picked(aiPick.size, aiWhy) : '', onClear: clearAiPick });",
    to: "    document.getElementById('aiChip0').innerHTML = aiPick ? '<span class=ai-chip>' + String(aiWhy) + '<button id=aiClear>✕</button></span>' : '';\n    window.AiChip.paint('aiChip', { text: aiPick ? window.AiChip.picked(aiPick.size, aiWhy) : '', onClear: clearAiPick });" },
  { sec: '§J', name: '㉔B AiChip 的定义改名：四处调用点都还在（应红在「有 0 处定义」）', file: 'ui.js',
    anchor: "  const AiChip = {",
    to: "  const AiChipOld = {" },
  { sec: '§J', name: '㉔C 收藏页不再画芯片（实现还在但这一页没人用，应红在 paint 下限 + 落点缺 favorites）', file: 'favorites.html',
    anchor: "    window.AiChip.paint('aiChip', { text: aiPick ? window.AiChip.picked(aiPick.size, aiWhy) : '', onClear: clearAiPick });",
    to: "    /* 这一页退回不画芯片 */" },
  { sec: '§J', name: '㉔D 页面自己再传一遍那句默认 title（应红在「清除 AI 结果…现在有 2 处」）', file: 'chars.html',
    anchor: "    window.AiChip.paint('aiChip', { text: aiPick ? window.AiChip.picked(aiPick.size, aiWhy) : '', onClear: clearAiPick });",
    to: "    window.AiChip.paint('aiChip', { text: aiPick ? window.AiChip.picked(aiPick.size, aiWhy) : '', clearTitle: '清除 AI 结果，回到完整列表', onClear: clearAiPick });" },
  { sec: '§J', name: '㉔E 公共层那句 title 退回旧措辞（应红两头：一处都没有 + 旧句「名单」又出现）', file: 'ui.js',
    anchor: "    CLEAR_TITLE: '清除 AI 结果，回到完整列表',",
    to: "    CLEAR_TITLE: '清除 AI 结果，回到完整名单'," },
  { sec: '§J', name: '㉔F 反向对照：注释写全两种被禁形状 + 只出现类名 / id 名 + 参数化接进公共层（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前四处各手拼一颗 —— <span class="ai-chip">…<button id="aiClear" title="清除 AI 结果，回到完整名单">✕</button></span> 与 <span class="ap-aitag" id="apAiClear">，注释里点名它们不该算副本（词法器剥注释）。 */\n  const __acCls__ = \'ai-chip\';\n  const __acId__ = \'aiClear\';\n  function __acPage__({ cls = __acCls__, cid = __acId__ } = {}) {\n    window.AiChip.paint(\'aiChip\', { cls: cls, clearId: cid, text: window.AiChip.text([\'最早的在前\']), onClear: function () {} });\n  }\n  window.__acOut__ = String(__acPage__) + window.AiChip.CLEAR_TITLE.length;\n</script>' },
  /* ㉓ 「供应商类型那一排叫什么、按什么顺序」那一族（判据全文见 selfcheck 的 ㉓ 那三头）：
       A 页面退回手抄一份四档键序 → 红在「手抄键序 1 处」；
       B 助手自己再写一张表 → 红在「ui.js 之外又写了一遍」，
         这一刀**故意少动一处调用点**（13→12 仍在闸内），所以红的只有形状那一头；
       C 公共定义改名（调用点一个字没动）→ 红在「有 0 处定义」；
       D 页面退回旧符号名 KIND_ZH → 红在「旧符号 1 处」—— 那一头专抓「表删了、名字还留着」这种半收状态：
         调用计数照常过（12），可页面引用的是一份不存在的定义，运行时才炸。
       E 反向对照：注释里写全两种被禁形状、三档键序（不是那四档）、值不同的素材族表（audio: 音频）
         与一次合法调用 —— 四种都不该红。
       ⚠ A 一次红在**两头**（实测：`MUT_ONLY=㉓` 打出两条）—— 除了自己那一头，还撞 ⑲-d 的
         「类型名换成媒体类别」：那一族的形状是「`audio` / `image` / `video` 三个英文字面量一起出现」，
         而手抄的四档键序天生就是那三个字母加一个 `text`。不是判据坏了，是这一刀落在两族的交集上：
         将来谁真在页面里写这份字面量清单，两档都会响，这正是想要的。
       （为什么日志里看得见：分片跑会打印红条原话 —— `hit` 只比到「§J 里有没有红」那一层，
         不打印就永远不知道它红在哪一头，刀名里那句「应红在 X」等于没验过。） */
  { sec: '§J', name: '㉓A 设置页退回手抄四档键序（应红在「手抄键序 1 处」）', file: 'settings.html',
    anchor: "  tabs.innerHTML = window.provKinds().map(k =>",
    to: "  tabs.innerHTML = ['image', 'video', 'audio', 'text'].map(k =>" },
  { sec: '§J', name: '㉓B 助手自己再写一张「供应商类型」表（应红在「ui.js 之外又写了一遍」）', file: 'ai-chat.js',
    anchor: "类型: window.provKindZh(p.kind),",
    to: "类型: ({ image: '图片', video: '视频', audio: '语音', text: '文字' })[p.kind]," },
  { sec: '§J', name: '㉓C provKindZh 的定义改名：十三处调用点都还在（应红在「有 0 处定义」）', file: 'ui.js',
    anchor: "  function provKindZh(k) { return PROV_KIND_ZH[k] || String(k || ''); }",
    to: "  function provKindZhOld(k) { return PROV_KIND_ZH[k] || String(k || ''); }" },
  { sec: '§J', name: '㉓D 页面退回旧符号名（计数那一头照常过，应红在「旧符号 1 处」）', file: 'settings.html',
    anchor: "    + escA(window.provKindZh(k)) + '<b class=\"seg-n\">'",
    to: "    + escA(KIND_ZH[k]) + '<b class=\"seg-n\">'" },
  { sec: '§J', name: '㉓E 反向对照：注释里写全被禁的两种形状 + 三档键序 + 素材族那张表（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前手写 `const KIND_ZH = { image: \'图片\', video: \'视频\', audio: \'语音\', text: \'文字\' };` 与 `const PROV_KINDS = [\'image\', \'video\', \'audio\', \'text\'];` —— 注释里点名它们不该算副本（词法器剥注释，旧符号名只在注释里出现不算引用）。 */\n  const __pkOrder3__ = [\'image\', \'video\', \'audio\'];\n  const __pkMediaZh__ = { image: \'图片\', audio: \'音频\' };\n  window.__pkOut__ = __pkOrder3__.length + __pkMediaZh__.audio.length + window.provKindZh(\'text\').length + window.provKinds().length;\n</script>' },
  /* ㉕ 「写一句话让 AI 在本机这一堆里挑几条」那一族（2026-10-16 收成 assetlib.js 的 `AiFind`，
       字数闸再收成它上面的 `shortWhy` 一个口子 —— 三处读它：`run`、资产库 AI 检索、统一选择器）：
       A 页面把那句闸门话抄一遍 → 红在「闸门话现在有 2 处」。**故意不动任何出口调用**，
         所以这一刀只打措辞那一头（不让计数顺带替它作证）—— 与 ㉔A 同一立场。
       B 资产库退回自己读那个字数、自己拼那句 → 主红在「MIN_Q 外溢」，顺带带走闸门话与 shortWhy 两头。
         这三头本就是同一次退步的三张脸：一旦页面拿得到那个数，它迟早也会自己拼那句话。
       C 公共层定义改名（各页调用点一个字没动）→ 红在「AiFind 的定义有 0 处」——
         这一头专门防「整块没了，于是第①头的『恰好 1 处』变成空断言」。
       D 统一选择器退回自己判字数 → 红在「shortWhy 只被调 2 次」+「assetlib.js 没问 AiFind.shortWhy」，
         顺带 needMsg 从 1 变 2（那一处本来就是 needMsg 唯一的第二个合法读点，由 shortWhy 代它问）。
       E 收藏页配置里少了 `say` 那一格 → 红在「缺了那一族必要的格子」。**只删这一格**：
         公共层少一个出口就会走到「按了按钮什么都没发生」那一档（本轮修的那个缺陷的形状）。
       F 素材库不再走公共层整链 → 红两头：run 掉到 1、落点缺 chars.html（实现还在、这一页没人用）。
       G `apply` 里给类型档 `filter` 赋了值 → 红在「apply 里给 filter 赋值」——
         这一头钉的是分工：清芯片走 apply，档位在挑中那一刻放开（onPick），写在 apply 里等于点 ✕ 把用户挑的档也改了。
       H 反向对照：注释里写全三种被禁形状（那句闸门话、`AiFind.MIN_Q`、`q.length < 2`）+ 一次合法的
         shortWhy 转发 —— 都不该红（词法器剥注释，字符串判据看不见注释里的历史写法）。
     跑法同 ㉔：`MUT_ONLY=㉕ node tests/mutation.cjs`（分片会打印红条原话，逐刀核对它红在刀名点的那一头）。 */
  { sec: '§J', name: '㉕A 页面把那句闸门话抄一遍（应红在「闸门话现在有 2 处」，四处出口调用一个没动）', file: 'chars.html',
    anchor: "  function clearAiPick() { window.AiFind.clear(AI); }",
    to: "  const __afMut__ = '先在搜索框里写要找什么（至少两个字），再点「AI 找素材」';\n  function clearAiPick() { window.AiFind.clear(AI); }" },
  { sec: '§J', name: '㉕B 资产库退回自己读字数、自己拼那句（应红在「MIN_Q 外溢」，顺带带走闸门话与 shortWhy）', file: 'assets.html',
    anchor: "  const gateWhy = window.AiFind.shortWhy(q, 'AI 检索');",
    to: "  const gateWhy = q.length < window.AiFind.MIN_Q ? '先在搜索框里写要找什么（至少两个字），再点「AI 检索」' : '';" },
  { sec: '§J', name: '㉕C AiFind 的定义改名：各页调用点都还在（应红在「有 0 处定义」）', file: 'assetlib.js',
    anchor: "window.AiFind = {",
    to: "window.AiFindOld = {" },
  { sec: '§J', name: '㉕D 统一选择器退回自己判字数（应红在 shortWhy 只被调 2 次 + 落点缺 assetlib.js）', file: 'assetlib.js',
    anchor: "        const why = AiFind.shortWhy(q, 'AI 检索');",
    to: "        const why = q.length < 2 ? AiFind.needMsg('AI 检索') : '';" },
  { sec: '§J', name: '㉕E 收藏页的配置少了 say 那一格（应红在「缺了那一族必要的格子」）', file: 'favorites.html',
    anchor: "    say: t => { $('cnt').textContent = t; },",
    to: "    /* 这一页不给公共层那句出口了 */" },
  { sec: '§J', name: '㉕F 素材库不再走公共层整链（应红两头：run 掉到 1、落点缺 chars.html）', file: 'chars.html',
    anchor: "  const runAiFind = () => window.AiFind.run(AI);",
    to: "  const runAiFind = () => { aiPick = null; aiWhy = ''; render(); };" },
  { sec: '§J', name: '㉕G apply 里给类型档 filter 赋值（应红在「apply 里给 filter 赋了值」）', file: 'chars.html',
    anchor: "    apply: s => { aiPick = s.pick; aiRank = s.rank; aiWhy = s.why; },",
    to: "    apply: s => { aiPick = s.pick; aiRank = s.rank; aiWhy = s.why; filter = 'all'; }," },
  { sec: '§J', name: '㉕H 反向对照：注释写全三种被禁形状 + 一次合法转发（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前四处各写一遍闸门 —— `if (q.length < 2) { cnt.textContent = \'先在搜索框里写要找什么（至少两个字），再点「AI 检索」\'; return; }`，还直接读过 `AiFind.MIN_Q`；注释里点名它们不该算副本（词法器剥注释，字符串与标识符判据都看不见注释里的历史写法）。 */\n  function __afGate__(q) { return window.AiFind.shortWhy(q, \'AI 检索\'); }\n  window.__afOut__ = __afGate__(\'\') + __afGate__(\'一只猫\').length;\n</script>' },
  /* ㉖ 「这一次刷新**之后**才说的那一句」（2026-10-15 收成 ui.js 的 `Toast.after`，判据全文见 selfcheck 的 ㉖ 四头）：
       A 设置页退回当场弹那句「正在刷新」→ 主红在第①头（那句话又回到真代码里），顺带把第③头一起拖红
         （那一个出口不再数成 after）。这一族的本体缺陷是**两重**没落地：ok 档默认静音 + 说这句话的东西
         被它自己宣布的那次 reload 一起销毁；判据故意只钉「那句话」而不是「那种形状」，因为「改完数据要刷新」
         本身是对的（`reloadAfter` 那份留着），错的只是「当面对着一堵将要被拆的墙喊话」。
       B 公共层那一格定义改名（十处调用点一个字没动）→ 红在「定义有 0 处」——
         专防「整块没了，于是第①头的『恰好 1 处』变成空断言」（与 ㉔B / ㉕C 同一立场）。
       C 页面抄那把 sessionStorage 键、自己 setItem → 红在第④头（那把键 2 处）。
         **故意保留原那一行 Toast.after**：让这一刀只打「第二份在数同一把键」这一头。
         这一头防的不是难看，是坏行为：绕过「取用即清」，下一次加载把上一趟那句说明再弹一遍。
       D ui.js 的对账刷新退回当场弹 → 红两头：调用掉到 9、落点缺 ui.js（实现还在、这一处没人用）。
         **故意不写「正在刷新」那句**，好让这一刀只打第③头 —— 三刀各打一头，才不会互相替对方作证。
       E 反向对照：注释里写全那句被禁的话 + 那把键的字面量 + 一次合法的 `.after` 转发 —— 都不该红。
     跑法同 ㉕：`MUT_ONLY=㉖ node tests/mutation.cjs`（分片会打印红条原话，逐刀核对它红在刀名点的那一头）。 */
  { sec: '§J', name: '㉖A 设置页退回当场弹那句「正在刷新」（应红在第①头，顺带第③头）', file: 'settings.html',
    anchor: "        Toast.after('已导入 ' + wrote + ' 项设置（页面为此刷新了一次）');",
    to: "        Toast.ok('已导入 ' + wrote + ' 项设置，正在刷新…');" },
  { sec: '§J', name: '㉖B Toast.after 那一格定义改名：十处调用点都还在（应红在「有 0 处定义」）', file: 'ui.js',
    anchor: '    after(t, kind) {',
    to: '    afterRenamed(t, kind) {' },
  { sec: '§J', name: '㉖C 页面抄那把键、自己去 setItem（应红在第④头：那把键 2 处）', file: 'settings.html',
    anchor: "      Toast.after('已从数据文件恢复 ' + n + ' 项（页面为此刷新了一次）');",
    to: "      try { sessionStorage.setItem('__toast_after_reload', JSON.stringify({ t: '已从数据文件恢复 ' + n + ' 项', k: 'warn' })); } catch (e) {}\n      Toast.after('已从数据文件恢复 ' + n + ' 项（页面为此刷新了一次）');" },
  { sec: '§J', name: '㉖D 对账刷新那一处退回当场弹（应红两头：调用掉到 9 + 落点缺 ui.js）', file: 'ui.js',
    anchor: "          window.Toast.after('刚从本机数据文件同步了 ' + changed + ' 项（页面为此刷新了一次）', 'warn');",
    to: "          window.Toast.warn('刚从本机数据文件同步了 ' + changed + ' 项（页面为此刷新了一次）');" },
  { sec: '§J', name: '㉖E 反向对照：注释写全那句被禁的话 + 那把键的字面量 + 一次合法 after 转发（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="ui.js"></script>',
    to: '<script src="ui.js"></script>\n<script>\n  /* 反向对照：这一族以前写的是 `Toast.ok(\'已导入 40 项设置，正在刷新…\')`，\n     而那把键的字面量 __toast_after_reload 也曾在页面里各抄一遍、自己 setItem ——\n     注释里点名它们不该算副本（词法器剥注释，字符串判据与那把键的计数都看不见注释里的历史写法）。 */\n  if (window.Toast && window.Toast.after) window.Toast.after(\'这一句只写在注释旁边，判据不该数它\');\n</script>' },
  /* ㉗ 「同一件事在两页两种叫法」那一族（口径全文见 selfcheck 的 ㉗ 四头：
       ① 旧句 0 处 / ② 禁词 0 处 / ③ 新写法真有人在说 / ④ 「供应商」这个词的**出处**还长在设置页上）：
       A 注册表显示名退回不带空格的「文字AI」→ 红在第②头。这一刀**故意只改一家**：
         其余三家留着，红条就点名 proxy.js:794 那一个落点 —— 指得出哪儿坏了的判据才有用。
         它牵着的另一头在 usage.html：那里的名称归一化正则写成 `文字\s*AI`（两种带法都认），
         因为代理没重启时注册表递回来的还是旧名 —— 那边不松口，用量页就不会把同一家摆成两张卡。
       B 设置页那句提示退回「供应方」→ 打的还是第②头，但换**另一个词**：第②头是逐词循环，
         一词一刀才证明四个词各自有人守（只钉「注册路由」的话，「供应商 / 供应方」漂回去它看不见）。
       C 估价失败那句换成第三种叫法「这个型号没有」→ 红在第③头。
         **一句旧话都不写**，所以这一刀只打「新写法有没有人真在说」这一头 ——
         第①头 0 命中并不等于第③头有人接，那正是这一档最容易假绿的方向（把提示句整句删掉也是 0 命中）。
       D 卡名整块改名「平台与密钥」，其余六处指向它的提示句一个字没动 → 红在第④头的第二头
         （那五个字不再长在 `<h2` 那一格里）。这一刀是这一档的承重：字符串那一头 6 处仍 ≥ 下限，
         而那一屏指着的是界面上已经不存在的一张卡 —— 词法器只数 `<script>` 里的字符串，静态标记只有这一头看得见。
       E 反向对照：注释里写全四个禁词与三条旧句 → 不该红（词法器剥注释，四头数的都是字符串）。
      跑法同 ㉖：`MUT_ONLY=㉗ node tests/mutation.cjs`（分片会打印红条原话，逐刀核对它红在刀名点的那一头）。 */
  { sec: '§J', name: '㉗A 注册表显示名退回不带空格的「文字AI」（应红在第②头，并点名那一处落点）', file: 'proxy.js',
    anchor: "      id: 'openrouter', name: 'OpenRouter 文字 AI', kind: 'text', relay: '/openrouter', default: true,",
    to: "      id: 'openrouter', name: 'OpenRouter 文字AI', kind: 'text', relay: '/openrouter', default: true," },
  { sec: '§J', name: '㉗B 设置页那句提示退回「供应方」（应红在第②头的另一个词）', file: 'settings.html',
    anchor: "+ '<span class=\"hint sm\">润色时要不要把参考图一起发给它（这一项对所有文字供应商生效）</span></div>'",
    to: "+ '<span class=\"hint sm\">润色时要不要把参考图一起发给它（这一项对所有文字供应方生效）</span></div>'" },
  { sec: '§J', name: '㉗C 估价失败那句换成第三种叫法（应红在第③头：旧句 0 命中也照样算坏）', file: 'assetlib.js',
    anchor: "        return { ok: false, reason: '该型号没有「' + (q || '?') + '」档定价' };",
    to: "        return { ok: false, reason: '这个型号没有「' + (q || '?') + '」档定价' };" },
  { sec: '§J', name: '㉗D 设置页那张卡改名「平台与密钥」，六处提示句没跟着改（应红在第④头：卡名不再长在 <h2 那一格里）', file: 'settings.html',
    anchor: '    <h2 class="card-h"><span class="card-ic" data-icon="key" data-size="15"></span>供应商与密钥</h2>',
    to: '    <h2 class="card-h"><span class="card-ic" data-icon="key" data-size="15"></span>平台与密钥</h2>' },
  { sec: '§J', name: '㉗E 反向对照：注释里写全四个禁词与三条旧句（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前写的是「注册路由里没有可用的图片模型」「换一个模型再来一次」「该模型没有「X」档定价」\n     「文字AI 未加载」「没有文字 AI 提供商」「按供应方各存各的」—— 注释里点名它们不该算命中\n     （词法器剥注释，㉗ 那四头数的都是字符串，看得见的全是用户屏幕上的那一句）。 */\n  window.__nmOut__ = window.Api && window.Api.mediaSrc ? 1 : 0;\n</script>' },
  /* ㉘ 「只为解码而存在的那一只 <video>」收成 workbench.js 的 Wb.vframe.el / release（口径全文见 selfcheck 的 ㉘ 四头：
       ① workbench.js 之外不许再自己 `createElement('video')` / ② 单独一格 `'playsinline'` 恰好 1 处且在公共层 /
       ③ 两条取帧路都真的走那一份（页面 `Wb.vframe.el·release`，公共层 grab 里的 `this.el·this.release`）/
       ④ 工厂 `el(x) {` 那个形状全站恰好 1 处且在 workbench.js，`release(v) {` 那颗也还在公共层）：
       A 生成工作台自己再建一只外壳 → **只**红第①头（②③④ 一个字没动，各刀只打自己点名那一头）。
       B 素材库抄那一行给老浏览器的属性 → **只**红第②头（单独一格变 2 处）。这一刀根本不建 video，专打「那一行只有一份」。
       C 导演台时间切片那一路退回内联建壳 → 红第①头，并连带第③头那两条（页面一次都不调外壳了）。
         这一刀是这一档的承重：切片格子是取帧量最大的一处（一屏几十格），它不走公共外壳就等于「解码器一直挂着」那件事还在。
       D 公共层 grab 自己退回内联一份 → **只**红第③头「workbench.js 内部没有 this.el(」：
         第①头对公共层天然豁免，所以这里只剩一条 —— 故意不写 playsinline 那一行，免得顺带把第②头一起拖红。
       E 反向对照：注释里写全自建外壳与那一行属性 → 不该红（词法器剥注释，①② 数的都是真 token）。
      跑法同 ㉗：`MUT_ONLY=㉘ node tests/mutation.cjs`（分片会打印红条原话，逐刀核对它红在刀名点的那一头）。 */
  { sec: '§J', name: '㉘A 生成工作台自己再建一只取帧外壳（应只红在第①头，并点名 studio.html 那一处落点）', file: 'studio.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 变异：这一页又自己建了一只只为解码而存在的 <video>，最低调的那一行（muted）没抄 */\n  function __vfMutA__(s) { const v = document.createElement(\'video\'); v.src = s; return v; }\n  window.__vfOutA__ = __vfMutA__;\n</script>' },
  { sec: '§J', name: '㉘B 素材库抄那一行给老浏览器的 playsinline 属性（应只红在第②头：单独一格 2 处）', file: 'chars.html',
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 变异：外壳只有一份这件事，漂开的第一处永远是这一行属性 */\n  const __vfMutB__ = \'playsinline\';\n  window.__vfOutB__ = __vfMutB__.length;\n</script>' },
  { sec: '§J', name: '㉘C 导演台时间切片退回内联建壳（应红三头：第①头多一处落点 + 第③头「一处都没被调」与「director.html 没调」）', file: 'director.html',
    anchor: '  const v = Wb.vframe.el(src);',
    to: '  const v = document.createElement(\'video\'); v.muted = true;' },
  { sec: '§J', name: '㉘D 公共层 grab 自己退回内联一份（应只红在第③头「workbench.js 内部没有 this.el(」—— 第①头对公共层天然豁免，故意不写 playsinline 以免拖红第②头）', file: 'workbench.js',
    anchor: '        const v = this.el(src);',
    to: '        const v = document.createElement(\'video\'); v.muted = true;' },
  { sec: '§J', name: '㉘E 反向对照：注释里写全自建外壳与那一行属性（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前在页面里各写一遍 `document.createElement(\'video\')` 与那一行 `v.setAttribute(\'playsinline\', \'\')`，\n     现在只有 workbench.js 的 Wb.vframe.el 一份 —— 注释里点名它们不该算副本\n     （词法器剥注释，㉘ 的①②两头数的都是真 token；下面那一句**不带括号**的成员引用也不该算调用）。 */\n  window.__vfOutE__ = window.Wb && window.Wb.vframe && window.Wb.vframe.el ? 1 : 0;\n</script>' },
  /* ㉙ 「按判据清一批 localStorage 键」那一趟倒扫收成 ui.js 的 Store.sweep（口径全文见 selfcheck 的 ㉙ 四头：
       ① `localStorage.length -`（倒着数的身份证）全站恰好 1 处且在 ui.js / ② `sweep` 作为方法定义恰好 1 处且在 ui.js /
       ③ `Store.sweep(` 调用达下限且落点点名 assetlib.js 与 settings.html / ④ `sweep` 在 window.Store 那张**现取**的面上）：
       A 收藏页退回自己扫一遍 → **只**红第①头（形状 2 处）。抄出来的这一份特意写成倒着扫 ——
         正着扫那一种从来没人抄（它错的时候恰好也对得上「表跑过一遍」），所以第①头比的是「这个形状全站只此一处」。
       B 公共层那颗方法改名 → 红第②头，并连带第④头（面上取不到 sweep）。这一刀钉的是「写在闭包里没挂上表」那一种：
         表现是调用方拿到 undefined、清掉 0 把键而回执照原样说「已恢复默认」，语法与页面渲染两关都不报。
       C 清型号元数据那一头退回原地手写循环 → 红第①头 + 第③头那两条（调用掉到 1、落点缺 assetlib.js）。
       D 反向对照：注释里写全那趟倒扫、代码里只留一个**不带括号**的 `window.Store.sweep` 引用 → 不该红（③ 认的是带括号的调用）。
      跑法同 ㉘：`MUT_ONLY=㉙ node tests/mutation.cjs`。 */
  { sec: '§J', name: '㉙A 收藏页自己写一趟倒扫清键（应只红在第①头：形状 2 处）', file: 'favorites.html',
    anchor: '<script src="ui.js"></script>',
    to: '<script src="ui.js"></script>\n<script>\n  /* 变异：这一页又自己扫一遍 —— 判据在它自己那一栏里，扫描那一步是同一件事的第二份实现 */\n  function __swMutA__() {\n    let n = 0;\n    for (let i = localStorage.length - 1; i >= 0; i--) {\n      const k = localStorage.key(i);\n      if (k && k.indexOf(\'__mut_a__\') === 0) { localStorage.removeItem(k); n++; }\n    }\n    return n;\n  }\n  window.__swOutA__ = __swMutA__;\n</script>' },
  { sec: '§J', name: '㉙B Store 那颗方法改名：两处调用点文本没动（应红在第②头 0 处，并连带面上取不到 sweep）', file: 'ui.js',
    anchor: '    sweep(pred) {',
    to: '    sweepOld(pred) {' },
  { sec: '§J', name: '㉙C 清型号元数据那一头退回原地手写倒扫（应红三头：形状 2 处 / Store.sweep 只被调 1 次 / 落点缺 assetlib.js）', file: 'assetlib.js',
    anchor: "    return window.Store.sweep(k => k.startsWith('sk_model_meta_'));",
    to: "    let n = 0;\n    for (let i = localStorage.length - 1; i >= 0; i--) {\n      const k = localStorage.key(i);\n      if (k && k.indexOf('sk_model_meta_') === 0) { localStorage.removeItem(k); n++; }\n    }\n    return n;" },
  { sec: '§J', name: '㉙D 反向对照：注释写全那趟倒扫、代码里只有一次不带括号的 Store.sweep 引用（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="ui.js"></script>',
    to: '<script src="ui.js"></script>\n<script>\n  /* 反向对照：这一族以前在 assetlib.js 与设置页各抄一遍\n     `for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); … localStorage.removeItem(k); }` ——\n     抄错的方向是正着扫（removeItem 让后面的键整体往前挪一格，正着扫跳过一半，而回执照「表跑过一遍」说已恢复）。\n     现在只有 ui.js 的 Store.sweep 一份：注释里点名它不该算副本，下面那一句**不带括号**的成员引用也不该算调用。 */\n  window.__swOutD__ = window.Store && window.Store.sweep ? 1 : 0;\n</script>' },
  /* ㉚ 「AI 回的那一串反问怎么读」那一族别名收成 assetlib.js 的 TextAI.qaOf（口径全文见 selfcheck 的 ㉚ 四头：
       ① `.question` 这个属性名的落点全在 assetlib.js / ② `qaOf` 作为方法定义恰好 1 处且在 assetlib.js /
       ③ `qaOf` 的调用达下限且点名 ai-chat.js / ④ 那三个上限各圈在自己文件里（QA_O_MAX 归公共层，ASK_Q_MAX 与 ASK_O_MAX 归抽屉）且名字在面上）：
       A 抽屉那一头退回自己解析别名 → 红第①头 + 第③头那两条。这一刀复现的正是当年那一次：
         抄出来的不是一份代码，而是一份代码 + 一套上限（6 个候选不限题数 vs 8 题 × 10 候选），同一次反问在两处画得不一样。
       B 公共层那颗方法改名 → 红第②头，并连带第④头（TextAI 面上取不到 qaOf）。
         ③ 那一头故意保持绿：两处调用的**文本**一个字没动 —— 「名字在面上」与「有人在调」是两条独立性质，合成一条就各漏一半。
       C 公共层那一行把抽屉的题数上限抄过来 → **只**红第④头（ASK_Q_MAX 出现在 ai-chat.js 之外）：
         两个数共用一个就是「一份真相」被合并，正是当初抄出两套上限的上游病因。
       D 反向对照：注释里写全那四个别名与两个上限名 → 不该红。
      跑法同 ㉘：`MUT_ONLY=㉚ node tests/mutation.cjs`。 */
  { sec: '§J', name: '㉚A 助手抽屉退回自己解析反问别名（应红三头：.question 外溢 / qaOf 只被调 1 次 / ai-chat.js 没调）', file: 'ai-chat.js',
    anchor: '    return TextAI.qaOf(arg, ASK_O_MAX).slice(0, ASK_Q_MAX);',
    to: '    const out = [];\n    (Array.isArray(arg) ? arg : []).forEach(x => {\n      const q = String((x && (x.q || x.question || x.title)) || \'\').trim();\n      if (q) out.push({ q, options: [] });\n    });\n    return out.slice(0, ASK_Q_MAX);' },
  { sec: '§J', name: '㉚B TextAI 那颗归一方法改名：两处调用点文本没动（应红在第②头 0 处，并连带面上取不到 qaOf；③ 保持绿是刻意的）', file: 'assetlib.js',
    anchor: '  qaOf(arg, oMax) {',
    to: '  qaOfOld(arg, oMax) {' },
  { sec: '§J', name: '㉚C 公共层那一行抄进抽屉的题数上限（应只红在第④头：ASK_Q_MAX 出现在 ai-chat.js 之外）', file: 'assetlib.js',
    anchor: '  QA_O_MAX: 6,',
    to: '  QA_O_MAX: 6,\n  __mutAskQ: ASK_Q_MAX,' },
  { sec: '§J', name: '㉚D 反向对照：注释里写全那四个别名与两个上限名（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前在抽屉里自己抄一遍 `x.q || x.question || x.title` 与 `o.label || o.text`，\n     还各带一套上限（QA_O_MAX 6 个候选不限题数 / ASK_Q_MAX 8 题 × ASK_O_MAX 10 候选）——\n     注释里点名它们不该算副本（词法器剥注释，㉚ 的①④两头数的都是真 token；下面那一句不带括号的成员引用也不该算调用）。 */\n  window.__qaOutD__ = window.TextAI && TextAI.qaOf ? 1 : 0;\n</script>' },
  /* ㉛ 四颗「存回本机」按钮的画法 / 在途守卫 / 回执收成 assetlib.js 的 AssetLocal.pull*（口径全文见 selfcheck 的 ㉛ 四头：
       ① `dataset.busy` 在 assetlib.js 之外 0 处 / ② 六个出口的 `function` 定义各恰好 1 处且在 assetlib.js /
       ③ `AssetLocal.<出口>` 调用达下限且落点点名那四个页面 / ④ title 那两句各恰好 1 处且在公共层，六个名字都在现取的面上）：
       A 生成工作台在 pullStart 之后再自己写一次旗标 → **只**红第①头。这一刀钉「两处各写就会有一处忘记复位」
         —— 当年工作台那一颗就是只看了 dataset.busy、没看成「在途时整颗不要重画」，
         于是右栏每 3 秒随整列重建一次，「存回本机 7 / 20」被冲回没有进度那一版（跑了 20 条，屏幕一直停在 0）。
       B 公共层那颗画法函数改名（四页调用点文本没动）→ **只**红第②头：③ 那一头照样数到 4 次调用，
         于是「有人在调」替不来说「那份实现还在」—— 正是本仓库反复踩的「挂上了 window 但工作链断了」那一类。
       C 收藏页把 title 那半句抄进自己的 more → **只**红第④头（「字节还不在本机」变 2 处）。
       D 收藏页那颗退回自己拼按钮 → 红第③头那两条（pullBtn 掉到 3、落点缺 favorites.html）。
         C 与 D 是同一处缺陷的两半：抄一句说法 / 连画法一起抄，两个方向各打一次。
       E 反向对照：注释里写全那面旗标与 title 两句、代码里只有一次合法的 AssetLocal.pullBusy → 不该红。
      跑法同 ㉘：`MUT_ONLY=㉛ node tests/mutation.cjs`。 */
  { sec: '§J', name: '㉛A 生成工作台在公共层之外再写一次在途旗标（应只红在第①头）', file: 'studio.html',
    anchor: '  AssetLocal.pullStart(b);',
    to: '  AssetLocal.pullStart(b);\n  if (b) b.dataset.busy = \'1\';' },
  { sec: '§J', name: '㉛B 公共层那颗画法函数改名：四页调用点都还在（应只红在第②头 pullBtn 定义 0 处）', file: 'assetlib.js',
    anchor: '  function pullBtn(b, n, o) {',
    to: '  function pullBtnOld(b, n, o) {' },
  { sec: '§J', name: '㉛C 收藏页把 title 那半句抄进自己的 more（应只红在第④头：「字节还不在本机」变 2 处）', file: 'favorites.html',
    anchor: "    AssetLocal.pullBtn($('pullBtn'), pullScope().length, { what: '收藏', more: '本地上传的那一批不算。' });",
    to: "    AssetLocal.pullBtn(document.getElementById('pullBtn'), pullScope().length, { what: '收藏', more: '本地上传的那一批不算 —— 字节还不在本机的才要逐条取。' });" },
  { sec: '§J', name: '㉛D 收藏页那颗退回自己拼按钮（应红在第③头两条：pullBtn 掉到 3、落点缺 favorites.html）', file: 'favorites.html',
    anchor: "    AssetLocal.pullBtn($('pullBtn'), pullScope().length, { what: '收藏', more: '本地上传的那一批不算。' });",
    to: "    document.getElementById('pullBtn').textContent = '存回本机 ' + pullScope().length;" },
  { sec: '§J', name: '㉛E 反向对照：注释写全那面旗标与 title 两句、代码里只有一次合法的 pullBusy（应放行）', file: 'favorites.html', expectGreen: true,
    anchor: '<script src="assetlib.js"></script>',
    to: '<script src="assetlib.js"></script>\n<script>\n  /* 反向对照：这一族以前四页各写一遍 `if (b) { b.disabled = true; b.dataset.busy = \'1\'; }`，\n     title 那两句也抄成了四种：「…的字节还不在本机…」与「已经在本机的一条都不会重下。」——\n     注释里点名它们不该算命中（词法器剥注释，㉛ 的①④两头数的都是真 token），下面那一次调用走的是公共层那颗守卫。 */\n  window.__pbOutE__ = window.AssetLocal && AssetLocal.pullBusy\n    ? (AssetLocal.pullBusy(document.getElementById(\'pullBtn\')) ? 1 : 0) : 0;\n</script>' },];

let bad = 0;
restoreAll();
/* 分片口：`MUT_ONLY=㉑ node tests/mutation.cjs` 只跑名字里带着这一串的那几刀。
   为什么要这个口：这一支会**临时改写那 14 个源文件**（每刀都以启动时读到的字节为底座，跑完照原样还原），
   而同一份目录里可能正有另一路会话在改页面 —— 那一次还原会把人家的在途改动一起抹掉。
   全量跑过一遍之后，改一条判据只需重跑被点名的那一档（与 `.tmp-mutdirdom.cjs` 的 `DIRDOM_ONLY` 同一套）。
   切片切空必须当场判红：否则「0 刀要跑」会打成一句全绿，看着像这一档验过了。 */
const ONLY = String(process.env.MUT_ONLY || '').trim();
const TODO = ONLY ? MUT.filter(m => (m.sec + ' ' + m.name).includes(ONLY)) : MUT;
if (ONLY && !TODO.length) { console.log('[红] MUT_ONLY=「' + ONLY + '」没命中任何一刀（现有 ' + MUT.length
  + ' 刀，按「档名 + 刀名」子串匹配）—— 这一轮什么都没测'); process.exit(1); }
/* 把起始哈希打出来：万一上一次是被 SIGKILL 掐掉的（兜底还原拦不住那一种），
   泄漏已经变成了这一次的「起始状态」，脚本自己发现不了 —— 但两份日志一对照就看出来了。 */
console.log('起始基线（' + FILES.length + ' 个文件，跑完应完全一致）：'
  + [...before].map(([f, h]) => f.slice(0, 4) + ':' + h.slice(0, 8)).join(' '));
let r = run();
if (r.code !== 0) { bad++; console.log('[红] 基线就不绿，尺子有问题：\n' + r.out); } else console.log('[绿] 基线全绿');

for (const m of TODO) {
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
  else {
    console.log('[绿] ' + m.sec + ' ' + m.name + ' —— 变异后如期变红');
    /* 分片跑（`MUT_ONLY=`）时把**红的那几句原话**打出来。要这一档是因为上面那条 `hit` 只比到
       「§J 里有没有红」这一层：同一档里有三头判据（形状 / 定义数 / 调用数），
       刀名写着「应红在形状那一头」而实际红在调用数那一头，`hit` 照样算过 —— 
       于是「这把刀确实打到了它要钉的那一处」这句话从来没被验过。全量跑不打印（119 刀会把日志埋掉）。 */
    if (ONLY) {
      const lines = res.out.split(/\r?\n/).filter(l => l.indexOf('[红] ' + m.sec + ' ') >= 0);
      if (!lines.length) console.log('      ⚠ 抓不到红条原文（红在别的档上，或输出格式变了）');
      else lines.forEach(l => console.log('      红条：' + l.trim()));
    }
  }
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

console.log('\n' + (bad ? '变异自检红 ' + bad + ' 条' : '变异自检全绿：' + TODO.length + ' 个变异都能让对应判据变红，还原后哈希一致'
  + (ONLY ? '（本次是分片：MUT_ONLY=「' + ONLY + '」，共 ' + MUT.length + ' 刀里的这几刀）' : '')));
process.exit(bad ? 1 : 0);