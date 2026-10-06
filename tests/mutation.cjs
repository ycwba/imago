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
  'drama.js', 'settings.html'];
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
const write = (f, b) => fs.writeFileSync(path.join(ROOT, f), b);
const restoreAll = () => { for (const [f, b] of orig) write(f, b); };

const MUT = [
  { sec: '§A', name: '兄弟函数里裸调局部 const（drama.html 那次的原样复现）', file: 'drama.html',
    anchor: '<script src="ai-chat.js"></script>',
    to: '<script src="ai-chat.js"></script>\r\n<script>function __mutA__(){ const onlyHere = function(){return 1;}; return onlyHere(); } function __mutB__(){ return onlyHere(); }</script>' },
  { sec: '§A', name: '调一个压根没声明的名字', file: 'assets.html',
    anchor: '<script src="ai-chat.js"></script>',
    to: '<script src="ai-chat.js"></script>\r\n<script>__neverDeclared__();</script>' },
  { sec: '§B', name: '模板串原始文本里写「块注释 + 反引号」', file: 'drama.html',
    anchor: '<script src="ai-chat.js"></script>',
    to: '<script src="ai-chat.js"></script>\r\n<script>var __mutB__ = `前缀 /* 注释里有个反引号 ` 后面`;</script>' },
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
    anchor: "const sig = buf.length + ':' + sha1Of(buf);",
    to: "const sig = buf.length + ':' + sha1Of(buf); try { fs.unlinkSync(src); } catch (e) { /* 删了 */ }" },
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
  { sec: '§H', name: '反向对照：给模型的系统提示词里用 markdown（应放行）', file: 'drama.js', expectGreen: true,
    anchor: "const K_DRAMAS = 'dramas';",
    to: "const __MUT_SYS__ = '请**严格**按下面的说明回答，不要凭空编造';\r\nconst K_DRAMAS = 'dramas';" },
  { sec: '§G', name: '补存那步的 .assets 闸被短路掉（文本还在、永远不执行）', file: 'proxy.js',
    anchor: "if (insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }",
    to: "if (false && insideLocalDir(dir)) { full.push({ id, kind, why: '另存目录被设成了本机资产库本体（.assets），不往里写' }); continue; }" },
];

let bad = 0;
restoreAll();
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
const nums = /查了 (\d+) 段内联脚本 \/ (\d+) 处裸调用/.exec(plain);
if (!nums || Number(nums[1]) < 5 || Number(nums[2]) < 100) { bad++; console.log('[黄] 不带参数时没有真的在查'); }
else console.log('[绿] 不带参数也真查：' + nums[1] + ' 段 / ' + nums[2] + ' 处');

console.log('\n' + (bad ? '变异自检红 ' + bad + ' 条' : '变异自检全绿：' + MUT.length + ' 个变异都能让对应判据变红，还原后哈希一致'));
process.exit(bad ? 1 : 0);