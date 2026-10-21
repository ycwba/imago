/* 只读干跑：把变异脚本里的锚点逐条到源码里查命中次数，一个字节都不写。
   （2026-10-16 从根目录 `.tmp-anchordry.cjs` 搬进 `tests/` 常驻、旧名已删；
     下面 1)~3) 点名的旧 `.tmp-mut*.cjs` 已随清理一并删除，形状说明留给以后现写的探针复用。）
   三种脚本形状都认：
     1) tuple 型（`.tmp-mutcut.cjs` / `.tmp-mutfilmtrack.cjs`）：`[名字, 编号, from, to]`，`from` 可以是成对数组，源文件由命令行第二个参数给；
     2) tuple 型带文件名（`.tmp-mutnetnum.cjs` / `.tmp-mutfileext.cjs`）：`[文件, 名字, from, to]` ——
        第一个元素看着像文件名（`.js` / `.html` / `.css` / `.cjs` 结尾）就按它现读那一份源文件，
        一把脚本改五份源码时不必为每份单独干跑一遍（第二参数给了也只用它兜住不带文件名的那些刀）；
     3) 闭包型（`.tmp-mutdirdom.cjs`）：`{ name, mut: h => rep(h, from, to), want }` —— 这里给 `rep` 换成「记账不抛错」的那一份，
        于是一支脚本几十刀一次扫完，不用每刀真跑一遍探针（一刀 40 秒，38 刀就是半小时）。
     4) 对象型（`tests/mutation.cjs`）：`{ sec, name, file, anchor, to }` —— 那里的尺子是「恰好命中 1 次」，
        所以这一档连 0 次和 ≥2 次一起报（后者会把不相干的档位一起拖红）。
   为什么值得先跑这一遍：界面文案一缩短、或公共层把两处读数收成一份（`voiceVolOf` / `voiceAx` 那两次），
   锚点就命中 0 次 —— 而脚本照样报「全绿」，那些刀**从没落下过**。
   ⚠ 第一版只读命令行给的那**一份**源文件（默认 `director.html`）。`.tmp-mutnetnum.cjs` / `.tmp-mutfileext.cjs`
     那种「每刀自带文件名」的脚本喂给它，结果是一句「命不中 11 处」—— 尺子根本没打开过那五份文件，
     而报出来的话看着像锚点漂了。所以现在按 m[0] 现读、并按每份文件各自的行尾查命中。
   用法：node tests/anchordry.cjs tests/mutation.cjs（常驻那一份，跑变异之前先干跑这一遍）；
     临时现写的旧式脚本照同样写法把第二个参数换掉即可。 */
'use strict';
const fs = require('fs');
const probe = process.argv[2];
const srcFile = process.argv[3] || 'web/director/engine.js';
const FILE_RE = /\.(js|html|css|cjs)$/;
const files = new Map();
/* 每份文件自己的行尾：`web/director/engine.js` / `ui.js` 是 CRLF，`assets.html` / `workbench.js` 是 LF，
   多行锚点只有按「那一份文件的行尾」join 才查得到命中。 */
const ofFile = f => {
  if (!files.has(f)) {
    const t = fs.readFileSync(f, 'utf8');
    files.set(f, { t, eol: t.includes('\r\n') ? '\r\n' : '\n' });
  }
  return files.get(f);
};
const first = ofFile(srcFile);
const H = first.t;
const EOL = first.eol;
const norm = x => String(Array.isArray(x) ? x.join('\n') : x).replace(/\r?\n/g, EOL);
const src = fs.readFileSync(probe, 'utf8');
/* 两种数组名：`.tmp-mut*.cjs` 叫 `MUTS`（tuple / 闭包形状），`tests/mutation.cjs` 叫 `MUT`（对象形状）。 */
const KEY = src.indexOf('const MUTS') >= 0 ? 'const MUTS' : 'const MUT';
const s = src.indexOf(KEY);
if (s < 0) { console.log('找不到 MUTS / MUT 数组：' + probe); process.exit(1); }
/* 数组末尾不能只找「行首的 `];`」，也不能找「第一个 `];`」：
   `tests/mutation.cjs` 那一份是 `},];` 收尾（行首那条根本没有），而它的 `to` 字符串里就写着
   `[\'音频\', \'音乐\'];` —— 找第一个会切在字符串中间。最怕的不是报错，是**切出一段刚好能 eval 过的前缀**：
   后面几十刀一把没查过，照样报「命中 0 处」。所以扫到括号配平为止（字符串 / 注释整块跳过），
   并且收尾必须真的是 `]`，否则当场判「这一轮不算测」。 */
const arrEnd = (t, open) => {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < t.length; i++) { if (t[i] === '\\') i++; else if (t[i] === c) break; }
      continue;
    }
    if (c === '/' && t[i + 1] === '/') { const nl = t.indexOf('\n', i); i = nl < 0 ? t.length : nl; continue; }
    if (c === '/' && t[i + 1] === '*') { const cl = t.indexOf('*/', i + 2); i = cl < 0 ? t.length : cl + 1; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
};
const fast = src.indexOf('\n];', s);
const end = fast >= 0 ? fast + 2 : arrEnd(src, src.indexOf('[', s + KEY.length)) + 1;
const body = src.slice(s + KEY.length, end).replace(/^\s*=\s*/, '');
if (!/\]\s*$/.test(body)) { console.log('数组没被完整读出来（截在「…' + body.slice(-28).replace(/\s+/g, ' ') + '」）—— 这一轮不算测'); process.exit(1); }
const MUTS = eval('(' + body + ')');

let miss = 0, total = 0, cur = '';
const perFile = new Map();
/* 闭包型：`rep` 走全局（eval 出来的箭头在它自己那份作用域里找不到 `rep`，就落到这里） */
global.rep = (h, from, to) => {
  total++;
  if (h.indexOf(from) < 0) { miss++; console.log('MISS [' + cur + '] ' + from.slice(0, 72)); }
  return h.split(from).join(to);
};
const names = [];
for (const m of MUTS) {
  if (typeof m.mut === 'function') {
    cur = m.name || '';
    try { m.mut(H); } catch (m2) { console.log('抛错 [' + cur + ']：' + m2.message.slice(0, 60)); }
    names.push((m.name || '').split(' ')[0]);
  } else if (m && typeof m.anchor === 'string') {
    /* 4) 对象型（`tests/mutation.cjs`）：`{ sec, name, file, anchor, to }` —— 那里的硬规矩是
       「锚点在那份文件里**恰好命中 1 次**」，命中 0 次或 ≥2 次都会打成「[黄] 尺子坏了」，
       所以这一档不问 EOL、不做归一化，照 `s.split(anchor).length - 1` 那一条判据原样数一遍。 */
    total++;
    const box = ofFile(m.file);
    const n = box.t.split(m.anchor).length - 1;
    perFile.set(m.file, (perFile.get(m.file) || 0) + 1);
    if (n !== 1) { miss++; console.log('MISS [' + m.file + '] 命中 ' + n + ' 次 :: ' + (m.name || '').slice(0, 60) + ' :: ' + m.anchor.slice(0, 72)); }
    names.push(String(m.name || ''));
  } else {
    /* ⚠ 数组锚点是「连续几行拼成的一条锚点」—— 变异脚本那边 `norm()` 就是按行 join 后再去 `replace`，
       所以查命中也必须整条一起查。原来这里写的是 `m[2].map(p => p[0])`，取的是每一行的**第一个字符**
       （一个空格），于是一条早就漂掉的三行锚点照样报「命中」：干跑全绿、刀从没落下过
       （2026-10-15 给 ⑱ 那一族对锚点时抓出来的尺子缺陷 —— 那次 `segsOf` 里两行锚点已经没了却报 0 miss）。 */
    const multi = typeof m[0] === 'string' && FILE_RE.test(m[0]);
    const file = multi ? m[0] : srcFile;
    const box = ofFile(file);
    const nm = x => String(Array.isArray(x) ? x.join('\n') : x).replace(/\r?\n/g, box.eol);
    perFile.set(file, (perFile.get(file) || 0) + 1);
    /* `m[2]` 有三种形状：一条字符串 / 几行拼成的一条锚点（元素全是字符串）/ **一组 `[from, to]` 对**
       （`.tmp-mutfilmtrack.cjs` 的 ⑤c：「这一族守卫有两道，砍一道测不出」）。
       原来这里不分别第二、三种，把整组对一起 `join('\n')` —— 元素本身是数组，join 出来的是
       「from,to」用逗号粘起来的一串垃圾，于是那一刀**永远**报 MISS（2026-10-15 干跑 ⑤c 时撞上：
       看着像锚点漂了，实际是尺子把一条好锚点读成了一串不存在的字）。 */
    const raw = (Array.isArray(m[2]) && m[2].every(x => Array.isArray(x))) ? m[2].map(p => p[0]) : [m[2]];
    for (const a of raw) {
      total++;
      if (!box.t.includes(nm(a))) { miss++; console.log('MISS [' + file + '] ' + m[1] + ' :: ' + nm(a).slice(0, 72)); }
    }
    names.push(String(m[1] || ''));
  }
}
console.log(probe + '：锚点共 ' + total + ' 处（' + names.length + ' 刀，'
  + (perFile.size ? [...perFile.entries()].map(([f, n]) => f + ' ' + n + ' 刀').join(' / ') : srcFile + ' 全部')
  + '），命不中 ' + miss + ' 处；EOL ' + (EOL === '\r\n' ? 'CRLF' : 'LF') + '，默认源 ' + srcFile);
if (miss) {
  console.log('这些刀现在等于没打 —— 先把锚点对到现源码，再真跑变异脚本。');
  process.exit(1);
}
