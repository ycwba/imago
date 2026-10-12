#!/usr/bin/env node
/* 常驻自检判据 —— 跑法：`node tests/selfcheck.cjs`（不带参数就查全套）
 *
 * 为什么是常驻文件而不是 `.tmp-*`：`.tmp-*` 在 .gitignore 里，一次清理就把判据一起扫掉，
 * 于是「上一轮明明是绿的」变成「这一轮什么都没查」。以前就踩过：
 * 脚本写成 `for (const f of process.argv.slice(2))`，而我一直**不带文件**跑的 ——
 * 循环一次都不进，最后照常打印「全部通过」。空断言比没有断言更坏：
 * 它给出一个和「查过了」无法区分的绿灯。所以这里每档都守三条：
 *   ① 默认文件集，不带参数也真的查；
 *   ② 一段都没查到必须判红；
 *   ③ 输出必须带**可数的**结论，不打印就不算绿。
 *
 * 词法分析交给一个真扫描器（下面 lex），不用正则去猜：正则版把
 * 「CSS 注释」「正则字面量里的花括号」「字符串里的反引号」全算成代码，
 * 作用域栈一冲垮，判据就把 3000 多条关键字报成红 —— 判据自己不可信时，
 * 它的红和绿都只是它自己的毛病。扫描器读不完一个文件时会**自己报红**，
 * 而不是悄悄给出一份错的读数。
 *
 * §A–§L 十二个字母（§A 另有 A-2 一支，所以末行汇总报 13 条；每档的来龙去脉在
 *   docs/agents-公共层与界面约定.md 里点名，AGENTS.md §3 只留每一条的标题行当索引；
 *   AGENTS.md §5 那几条自测纪律仍在 AGENTS.md）：
 *   §A 内联脚本里的裸调用必须落在本作用域或 window 上
 *      （AGENTS.md §5 第 ⑩ 档。踩过 drama.html 的 renderRewound 调 bind()，
 *        而 bind 只是 renderBottom 里一个 const —— 语法检查一行都不报、页面照常渲染，
 *        注意点那一下才炸，表现为「新的一屏画得好好的、那颗按钮却是死的」。）
 *   §B 模板串原始文本里不许出现「块注释 + 反引号」
 *      （写在模板串里的注释不是注释、是字面文本；里面的反引号当场闭合模板串，
 *        后面整段变成字符串内容被吞进 HTML → 整页白屏 + 满屏源码当正文。
 *        坑在于抽出来单看那一段仍然合法，`new vm.Script` 照样过。）
 *   §C 素材身份判据全项目只有一份（在 ident.js）
 *   §D 引用 assetlib.js 的页面必须先引 ident.js
 *   §E 合卡规则（collapseInto）只有一份实现
 *   §F 另存那条链只有一个触发点（写盘一律挂在镜像内部）
 *   §G 另存的安全立场：页面不递目录、/save-local 不动 .assets、/save-move 先写后删
 *   §H 用户可见文案里不许出现 markdown 标记（注释与 AI 提示词不算界面）
 *   §I 「能力来源」那句话全站只有一份口径（Capabilities.srcTextOf）
 *      （踩过 studio.html 三处 + ai-chat.js 一处各写一遍：措辞两套、缓存标记两套，
 *        而其中两处把 note 整个丢了 —— note 是「这家为什么没拿到上游能力」的唯一原因。）
 *   §J 「同一个功能只应有一份实现」（b64Bytes / 落点选择器 / toast / 续拉 / 字节单位 / 芯片行 / 跨页复用载荷 / 本机落盘链）
 *   §K 页面不重复定义 ui.css 已经全有的规则（算子集、@media 上下文必须相同）
 *   §L 只许用真有的浏览器 API（黑名单按词法器 token 段比对，不按整串 indexOf ——
 *        整串写法会让这一档永远不咬人：`CSS.escape` 在 token 流里是 `CSS` / `.` / `escape` 三段）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* SC_TRACE=1 时把词法器的模板串进出打到 stderr —— 「读不完」这类报错要给得出
   「到底是哪一段没配平」，只报「剩 1 层」等于让下一个人重新查一遍。 */
const TRACE = !!process.env.SC_TRACE;
let CUR_FILE = '';                                  // TRACE 时跟着打印，混着多个文件看不出来是哪一份
const JS_FILES = ['ui.js', 'assetlib.js', 'workbench.js', 'chars.js', 'ai-chat.js', 'sidebar.js',
  'app.js', 'ident.js', 'proxy.js'];
/* 导演台的本名是 director.html（2026-10 从 index.html 改过来，那一份跳转出口已删除）。
   拍短剧页 drama.html 同日删除，它的后端 drama.js 瘦身改名成 chars.js（素材库的后端）。 */
const HTML_FILES = ['director.html', 'studio.html', 'assets.html', 'chars.html',
  'favorites.html', 'settings.html', 'usage.html', 'shell.html'];
const argFiles = process.argv.slice(2);
const targets = { js: argFiles.length ? argFiles : JS_FILES, html: argFiles.length ? [] : HTML_FILES };

let red = 0, green = 0;
const seen = new Map();
const bad = (sec, msg) => {
  red++;
  const key = sec + '|' + msg.replace(/\d+/g, '#');
  const n = (seen.get(key) || 0) + 1; seen.set(key, n);
  if (n <= 6) console.log('  [红] ' + sec + ' — ' + msg);
  else if (n === 7) console.log('  [红] ' + sec + ' — （同类第 7 条起折叠，见末尾汇总）');
};
const ok = (sec, msg) => { green++; console.log('  [绿] ' + sec + ' — ' + msg); };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const lineAt = (code, off) => code.slice(0, off).split('\n').length;


/* ================= 词法扫描器 =================
   产出 {toks:[{t,v,line}], tplRaw:[line…], err}。
   t = 'id' | 'num' | 'str' | 'tpl' | 're' | 'p'
   tplRaw 收集「模板串原始文本里出现了块注释、且那段文本里有反引号」的行号。 */
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);
function lex(code, lineBase) {
  const toks = [], tplRaw = [];
  let i = 0, line = lineBase || 1, err = null;
  /* 显式帧栈：code（代码，带花括号深度）/ tpl（模板串原始文本）。
     嵌套模板串靠这个栈自然处理 —— 第一版把 ${} 里的扫描写成一段不递归的内联循环，
     于是 `${x ? `a${y}` : ''}` 这种套嵌一进来就跑偏（导演台那一页，当时还叫 index.html，2138 行就是这么炸的：
     判据报「正则字面量跨行」，而那一行根本是一段 HTML 标签）。 */
  const st = [{ k: 'code', d: 0, at: line }];
  const top = () => st[st.length - 1];
  const lastSig = () => (toks.length ? toks[toks.length - 1] : null);
  /* 「/ 到底是除号还是正则的开头」的判据：只认**能确定**的那几种前驱。
   早先写成「前驱不在 )]} 里就算正则」，于是 `... + (cached ? ... )` 这种
   二元 + 后面跟除号时被当成正则，一路扫到行尾报「正则跨行」——
   而那一行是 workbench.js:593 的字符串拼接。（判据自己的假红。） */
const REGEX_OK_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '${', '=>']);
function regexAllowedAfter(p) {
  if (!p) return true;
  if (p.t === 'id') return KW_BEFORE_REGEX.has(p.v);
  if (p.t !== 'p') return false;
  return REGEX_OK_AFTER.has(p.v);
}
  while (i < code.length && !err) {
    const f = top(), c = code[i];
    /* ---------- 模板串原始文本：这里的一切都是字面量 ---------- */
    if (f.k === 'tpl') {
      if (c === '\\') { if (code[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { st.pop(); if (TRACE) console.error('[tpl-] ' + CUR_FILE + ' line=' + line); toks.push({ t: 'tpl', v: '`', line, s: '' }); i++; continue; }
      if (c === '$' && code[i + 1] === '{') {
        f.tok.s += '${';                       /* 插值在静态文本里记一个占位，文案扫描据此切段 */
        st.push({ k: 'code', d: 0, at: line }); if (TRACE) console.error('[${ +] ' + CUR_FILE + ' line=' + line);
        toks.push({ t: 'p', v: '${', line }); i += 2; continue;
      }
      if (c === '/' && code[i + 1] === '*') {          // ★ 这里的 /* 不是注释，是字面文本
        const end = code.indexOf('*/', i + 2);
        const seg = end < 0 ? code.slice(i) : code.slice(i, end + 2);
        if (seg.indexOf('`') >= 0) tplRaw.push(line);
        /* 跳过的这一段要数换行 —— 漏了的话行号从这里开始漂，报错位置会指到一个
           根本没有反引号的地方（第一版在 ui.js 上报「第 2189 行模板串没闭合」，
           而 2189 行是 `},`）。行号是判据的证据，漂了就等于给出一份假读数。 */
        for (const ch of seg) if (ch === '\n') line++;
        f.tok.s += seg;                         /* 注释样文本也是模板串里的字面文本，收进 s */
        i = end < 0 ? code.length : end + 2;
        continue;
      }
      if (c === '\n') line++;
      f.tok.s += c;
      i++; continue;
    }
    /* ---------- 代码 ---------- */
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') {
      const startLine = line;
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') line++; i++; }
      if (i >= code.length) { err = '第 ' + startLine + ' 行块注释没有闭合'; break; }
      i += 2; continue;
    }
    if (c === '"' || c === "'") {
      const q = c, startLine = line; i++;
      const sAt = i;                          /* 字面量的内容从这里开始 */
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') { if (code[i + 1] === '\n') line++; i += 2; continue; }
        if (code[i] === '\n') line++;
        i++;
      }
      if (i >= code.length) { err = '第 ' + startLine + ' 行字符串没有闭合'; break; }
      /* s = 字面量内容。**v 仍旧是引号**（§A 的作用域分析与 §B 的模板串检查都按 v 走，
         改它就得重跑一遍变异测试才知道有没有踩坏哪一档）；s 是后来加的，给
         「扫用户可见文案」那类工具用 —— 以前这一台扫描器只吐 token 的种类不吐内容，
         于是旁边又有人手写了一个更差的（只按行找 textContent）。 */
      toks.push({ t: 'str', v: q, line, s: code.slice(sAt, i) }); i++; continue;
    }
    if (c === '`') {
      const tk = { t: 'tpl', v: '`', line, s: '' };
      st.push({ k: 'tpl', d: 0, at: line, tok: tk });
      if (TRACE) console.error('[tpl+] ' + CUR_FILE + ' line=' + line);
      toks.push(tk); i++; continue;
    }
    if (c === '{') { f.d++; toks.push({ t: 'p', v: '{', line }); i++; continue; }
    if (c === '}') {
      if (f.d === 0 && st.length > 1) st.pop();        // 收尾的 } 属于 ${}，回到模板原始文本
      else if (f.d > 0) f.d--;
      toks.push({ t: 'p', v: '}', line }); i++; continue;
    }
    if (c === '/' && regexAllowedAfter(lastSig())) {  // 正则字面量：里面的花括号不是花括号
      const startLine = line; i++;
      let cls = false;
      while (i < code.length) {
        const d = code[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') { err = '第 ' + startLine + ' 行正则字面量跨行了'; break; }
        i++;
      }
      if (err) break;
      i++; while (i < code.length && /[a-z]/.test(code[i])) i++;
      toks.push({ t: 're', v: '/re/', line }); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let w = ''; while (i < code.length && /[\w$]/.test(code[i])) w += code[i++];
      toks.push({ t: 'id', v: w, line }); continue;
    }
    if (/[0-9]/.test(c)) { while (i < code.length && /[\w.]/.test(code[i])) i++; toks.push({ t: 'num', v: '0', line }); continue; }
    if (c === '.' && code[i + 1] === '.' && code[i + 2] === '.') { toks.push({ t: 'p', v: '...', line }); i += 3; continue; }
    /* => 必须是一个 token：拆成 = 和 > 之后，箭头后面的 / 就认不出是正则的开头
       （ui.js:403 那个 Markdown 块代码检测的正则里含 ``` —— 认错一次，
        那三个反引号就被当成了模板串边界，后面一路错到文件末尾）。 */
    if (c === '=' && code[i + 1] === '>') { toks.push({ t: 'p', v: '=>', line }); i += 2; continue; }
    if ((c === '=' || c === '<' || c === '>' || c === '!') && code[i + 1] === '=') {
      toks.push({ t: 'p', v: c + '=', line }); i += 2; continue;
    }
    toks.push({ t: 'p', v: c, line }); i++;              // 其余标点（含 + - * / % = < > ! & | ^ ~ ）
  }
  if (!err && st.length > 1) err = '模板串/花括号没收平：剩 ' + (st.length - 1) + ' 层，最里面那层开在第 ' + top().at + ' 行（' + top().k + '）';
  return { toks, tplRaw, err };
}

/* ================= §A ================= */
const BUILTINS = new Set(('globalThis window document navigator location history console fetch '
  + 'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask '
  + 'localStorage sessionStorage indexedDB caches Event CustomEvent FormData Blob File FileReader '
  + 'URL URLSearchParams Headers Request Response AbortController TextDecoder TextEncoder WebSocket Worker '
  + 'MutationObserver IntersectionObserver ResizeObserver PerformanceObserver crypto performance alert confirm '
  + 'prompt structuredClone Intl Number String Boolean Array Object Map Set WeakMap WeakSet JSON Math Date '
  + 'RegExp Error TypeError RangeError SyntaxError ReferenceError Promise Proxy Reflect Symbol BigInt Infinity '
  + 'NaN undefined isNaN parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI decodeURI '
  + 'isFinite Uint8Array Uint8ClampedArray Int8Array Int16Array Int32Array Uint16Array Uint32Array Float32Array '
  + 'Float64Array ArrayBuffer DataView DOMParser XMLSerializer Image Audio Video HTMLElement Node Element NodeList '
  + 'HTMLInputElement HTMLTextAreaElement HTMLSelectElement HTMLCanvasElement AudioContext matchMedia '
  + 'getComputedStyle scrollTo scrollBy postMessage BroadcastChannel fs path http os dns require module '
  + 'top parent self frames frameElement name status closed length origin innerWidth innerHeight '
  + 'exports process Buffer __dirname __filename MediaId NODE_ENV btoa atob TextEncoderStream '
  + 'TextDecoderStream ReadableStream WritableStream TransformStream Blob URLPattern true false null this arguments').split(/\s+/).filter(Boolean));
const NO_CALL = new Set(['function', 'class', 'const', 'let', 'var', 'new', 'typeof', 'await', 'of', 'in',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'delete', 'void', 'instanceof', 'case',
  'try', 'finally', 'throw', 'break', 'continue', 'get', 'set', 'async', 'static', 'import', 'export', 'yield']);

function harvestGlobals() {
  const g = new Set(BUILTINS);
  for (const f of targets.js) {
    if (!exists(f)) continue;
    const src = read(f);
    let m; let re = /^(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = re.exec(src))) g.add(m[1]);
    re = /(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = re.exec(src))) g.add(m[1]);
  }
  return g;
}

/* 把一段源码切成「函数帧」。每帧记自己声明了哪些名字；
   一个名字只要在**本帧或任一外层帧**里声明过就算解析到了。 */
function matchParen(toks, i) {                     // i 指向 '('，返回配对的 ')' 的下标
  let d = 0;
  for (let j = i; j < toks.length; j++) {
    const v = toks[j];
    if (v.t !== 'p') continue;
    if (v.v === '(' || v.v === '${') d++;
    else if (v.v === ')') { d--; if (d === 0) return j; }
    else if (v.v === '}') { if (d === 0) return j - 1; }
  }
  return -1;
}
function analyse(toks) {
  /* 帧用「编号 + 父指针」而不是数组下标：数组下标在函数结束时会被 pop 掉，
     而判断「这个名字能不能解析」要问到调用点**当时**那条作用域链上的每一层。
     声明与调用分两遍语义：先把整段的声明都收进各自的帧，再回头看调用 ——
     function 声明是提升的，`stopped()` 写在 `function stopped(){}` 之前完全合法，
     单遍扫会把这几百处正常代码全判成裸调用。 */
  const all = [{ names: new Set(), parent: -1 }];        // 0 = 模块层
  const stack = [0];
  const cur = () => all[stack[stack.length - 1]].names;
  const calls = [];
  /* 「下一个 id 是这条声明的**声明目标**吗」——
     以前这里是一个 `declRun`（遇到 const/let/var 置 1、遇到 `;` 清 0），
     而它在 `= 表达式` 里**一路有效**：`const isAudioType = t => t === '音频'` 里
     箭头函数的形参 `t` 于是被当成了**模块层的**声明收进去。
     后果不是这一档自己报错，而是**别处写错时它报不出来**：
     某个函数里写了 `t.dur`（把另一个函数的局部变量拿来用）本该报红，
     而模块层恰好有个被误收的 `t`，`resolves` 就说「解析得到」—— 判据静默失效。
     （studio.html 的 `t is not defined` 就是这么漏过去的。）
     现在改成两个状态：`inDecl`（在一条声明语句里）+ `declExpect`（下一个 id 是声明目标）。
     只有紧跟 const/let/var 的那个 id、以及**声明语句顶层**逗号之后的 id 才算声明目标；
     表达式里的裸标识符一个都不收。 */
  /* `declParen` = 看见 const/let/var 那一瞬的括号深度。
     为什么不能用「paren === 0」判断「我在语句层」：这些页面的内联脚本整段被
     `(function(){ … })()` 包着，于是 paren **整段都 ≥ 1**，`paren === 0` 一次都不成立 ——
     `const a = 1, b = 2` 里 `b` 这种「逗号后面的声明符」一个都收不到
     （更早的版本是靠「形参规则」歪打正着收下的，那把形参规则修对之后它们就全丢了，
     drama.html 的 `let grpRow, grid, …` 只剩第一个 grpRow，`useBtn.disabled` 立刻变假红）。
     现在按「看见声明关键字时的层」比：逗号回到同一层才算下一个声明符。 */
  let inDecl = false, declExpect = false, declParen = 0;
  const braceStack = [];        // 每个 `{` 是「进了帧」(true) 还是「解构」(false)，`}` 按 LIFO 消费
  /* 成员访问的**基对象**（`t.dur` 里的 `t`）也收一份。为什么要收：
     §A 原来只查裸调用，而 `t.dur` 是成员访问 —— 一个「把别的函数的局部变量拿来用」
     的错误（studio.html 真发生过：submitVideo 里写了 createVideoOnce 的 `t.dur`）
     就这样从这条判据下面走过去了，表现是点生成什么都不发生。
     只收「后面跟点、且前面不是点」的那个 id：链式 `a.b.c` 里只有 a 是基对象。 */
  const members = [];
  let paren = 0;
  /* ------------------ 形参必须挂到**它自己那个函数**的帧上 ------------------
     踩过的坑：老写法把形参直接 `cur().add()`，而扫到形参列表时函数体的 `{`
     还没出现 —— 于是 `function setType(t, fromUser) {…}` 里的 `t` 落进了
     **模块层**，`const isAudioType = t => …` 里的 `t` 同样落进模块层。
     后果是整份文件里任何地方写 `t.xxx` 都「解析得到」，§A 新加的成员访问判据
     因此在 studio.html 上一直不咬人（注回 `t.dur` 照样全绿，反向对照当场拆穿）。
     现在的做法：形参先攒在 `pending` 里，等**函数体的那个 `{`** 开帧之后再灌进去。
     表达式体的箭头函数（`t => t.a`）没有 `{`，就当场开一个「箭头帧」，
     由最近的分隔符（`;` `,` `)` `]` `}` 里先到的那一个）收口 —— 见 popArrows。 */
  const parens = [];            // 每个 `(` 一组：{ cands, fn, ctrl }，`)` 时决定这批 id 是不是形参
  let pending = [];             // 已确认是形参、等着灌进「即将出现的函数体帧」的名字
  const arrows = [];            // 表达式体箭头：{ depth, len }
  const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'with', 'return']);
  const flushPending = () => { for (const q of pending) cur().add(q); pending = []; };
  /* 收口：只收最里面那一个，且必须「箭头之后没再开过帧」（`stack.length <= len`）——
     否则 `x.map(t => { return t.a; })` 里那个 `;` 会把箭头帧提前收掉，
     后面 `t.a` 就变成解析不到。 */
  /* 收口的分隔符只认 `;` `)` `}` —— 逗号与 `]` 都不算。
     两处都踩过假红，形状是同一个：**表达式体是个字面量**。
       · 逗号：`xs.map(c => [c.a, c.b])` 在第一个逗号处就把箭头帧收掉了，
         后面那个 `c.b` 立刻「解析不到」；
       · `]`：`rows: it => [['类型', D.LIB_KINDS[D.libKindOf(it.item)]]]` 里
         内层 `]` 与箭头**同一个括号深度**（方括号没进 depth 计数），也被当成收口。
     少收几个只会让箭头帧稍微多活一会儿（`f(t => t.a, other)` 里 `other`
     也落进箭头帧），那是更宽松、不会误报的一侧。 */
  const popArrows = v => {
    while (arrows.length) {
      const a = arrows[arrows.length - 1];
      if (stack.length > a.len) return;                    // 里面还开着帧 → 表达式没结束
      const close = (v === '}') ? true : (paren <= a.depth);
      if (!close) return;
      stack.pop(); arrows.pop();
    }
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], nx = toks[i + 1], p = toks[i - 1];
    if (t.t === 'p' && (t.v === ';' || t.v === ')' || t.v === '}')) popArrows(t.v);
    if (t.t === 'p' && t.v === '(') {
      paren++;
      const o = toks[i - 1];
      const after = toks[i - 2];
      const isFn = !!o && ((o.t === 'id' && o.v === 'function')
        || (o.t === 'id' && after && after.t === 'id' && after.v === 'function'));
      parens.push({ cands: [], fn: isFn, head: o, ctrl: !!o && o.t === 'id' && CONTROL.has(o.v) });
      continue;
    }
    if (t.t === 'p' && t.v === ')') {
      if (paren > 0) paren--;
      const g = parens.pop() || { cands: [], fn: false, head: null, ctrl: true };
      /* 这一组到底是不是形参列表 —— 只有三种情况算：
           ① 紧跟 `function`（含具名）；② `)` 后面就是 `=>`（箭头形参，可能是空 `()`）；
           ③ `)` 后面就是 `{` 且左括号前面是普通标识符（`foo(a) {…}` 方法简写 / `get x()`）。
         其余一律丢掉：`f(a, b)` 的实参、`if (x)` 的条件都不该被当成声明 ——
         老写法无条件收，于是模块层被塞满了别人调用的实参名，判据跟着变瞎。
         注意 `catch (e) {` 也算「不是形参组」（ctrl），`e` 由下面 catch 那条单独收。 */
      const method = nx && nx.t === 'p' && nx.v === '{' && !g.ctrl
        && g.head && g.head.t === 'id';
      /* `catch (e) { … }` 的 `e` 也挂到 catch 块那一帧上（CONTROL 里含 catch，
         所以上面那条 method 认不出它，单列一条）。 */
      const catchGrp = nx && nx.t === 'p' && nx.v === '{'
        && g.head && g.head.t === 'id' && g.head.v === 'catch';
      if (g.fn || (nx && nx.t === 'p' && nx.v === '=>') || method || catchGrp) pending = g.cands;
      continue;
    }
    /* `{` 有两种身份，**必须分开**：
         · 块 / 函数体 / 模板串的 `${`  → 进一层新帧
         · **解构声明**（`const { a, b } = x`、`for (const { k, v } of …)`）→ **不进帧**：
           它里面的 `a`/`b`/`k`/`v` 是**外层**的绑定，收进一个没人用得到的子帧就等于
           「这些名字在外层解析不到」—— usage.html 的 `series`/`buckets`、
           chars.html 的 `rec` 全被这一条误报过（它们都是合法的解构）。
       `braceStack` 按 LIFO 记下每个 `{` 是哪一种，`}` 才配得对
       （只看「有没有 push 过帧」会错位：解构里的对象字面量仍要进帧）。 */
    if (t.t === 'p' && (t.v === '{' || t.v === '${')) {
      const pv2 = toks[i - 1];
      const destr = t.v === '{' && pv2 && pv2.t === 'id'
        && (pv2.v === 'const' || pv2.v === 'let' || pv2.v === 'var');
      if (destr) braceStack.push(false);                       // 解构：不进帧，名字归外层
      else {
        all.push({ names: new Set(), parent: stack[stack.length - 1] });   // ${ 也进一层
        stack.push(all.length - 1);
        braceStack.push(true);
        flushPending();                                        // ★ 函数体开帧 → 形参这时才灌进去
      }
      continue;
    }
    if (t.t === 'p' && t.v === '}') {
      if (braceStack.pop() && stack.length > 1) stack.pop();    // 只有进过帧的那个才 pop
      continue;
    }
    if (t.t === 'p' && t.v === '=>') {
      /* 单形参箭头 `e => …`：形参就是 `=>` 左边那个标识符 —— 必须在这里补一道，
         因为 `addEventListener('x', e => {` 这种写法里 `e` 所在的括号组
         **要到下面几十行才闭合**，而 `e` 早被「括号里的候选形参」收走了，
         `)` 那时才轮到判断，`=>` 却已经先到 —— 候选没人取，`e` 就这么丢了
         （director.html 第 13 行丢的 `e` 会让紧接着的 `e.reason` 变成假红）。 */
      const prevT = toks[i - 1];
      if (prevT && prevT.t === 'id' && !NO_CALL.has(prevT.v)) pending = [prevT.v];
      /* 表达式体的箭头：开一个帧，形参灌进去；块体的箭头交给紧跟着的 `{`（见上）。 */
      if (!(nx && nx.t === 'p' && nx.v === '{')) {
        all.push({ names: new Set(), parent: stack[stack.length - 1] });
        stack.push(all.length - 1);
        arrows.push({ depth: paren, len: stack.length });
        flushPending();
      }
      continue;
    }
    /* `,` 只在**声明语句的顶层**才是「下一个也是声明目标」的分隔符：
       `const a = f(x, y), b = 2` 里那个 f(…) 内的逗号不在顶层（paren > 0），不置位。 */
    /* 声明语句顶层的 `,`、以及**正在解构**时的 `,` —— 两种都意味着「下一个 id 也是绑定名」。
       后者必须收：`for (const { key, rec } of …)` 里那个逗号在 `for (` 之内（paren > 0），
       只认 paren === 0 的话 `rec` 收不到，循环体里用它就是误报。 */
    if (t.t === 'p' && t.v === ',' && inDecl && paren === declParen) { declExpect = true; continue; }
    if (t.t === 'p' && t.v === ';' && inDecl && paren <= declParen) { inDecl = false; declExpect = false; continue; }
    if (t.t !== 'id') continue;
    const w = t.v;
    if (NO_CALL.has(w)) {
      if (w === 'const' || w === 'let' || w === 'var') { inDecl = true; declExpect = true; declParen = paren; continue; }
      if ((w === 'function' || w === 'class') && nx && nx.t === 'id') cur().add(nx.v);
      continue;
    }
    const isMember = p && p.t === 'p' && p.v === '.';
    /* 基对象：后面是点、自己前面不是点（`a.b.c` 里 a 是基对象、b 是属性名）。 */
    if (nx && nx.t === 'p' && nx.v === '.' && !isMember) {
      members.push({ name: w, line: t.line, frame: stack[stack.length - 1] });
    }
    /* 多声明符：`const d = new Date(), pad = n => …` 里第二个之后的也得算声明
       （漏了它，pad() / p2() 会在模板串里被报成裸调用 —— 而它们确实是本段声明的） */
    if (declExpect && !isMember) { cur().add(w); declExpect = false; continue; }
    if (p && p.t === 'id' && (p.v === 'const' || p.v === 'let' || p.v === 'var'
      || p.v === 'function' || p.v === 'class')) { cur().add(w); continue; }
    if (p && p.t === 'p' && p.v === '{' && nx && nx.t === 'p' && (nx.v === ',' || nx.v === '}')) {
      cur().add(w);                                       // 解构 { a, b } = …
      /* **括号里**的那一对 `{}` 是形参模式而不是一个块：它一遇到自己的 `}` 就把帧收掉，
         只 `cur().add` 的话名字随帧消失，箭头体里再用它就被报成「本文件别处声明过、这里解析不到」
         （`opts.map(({ p, ms }) => …)` 的三条假红就是这么来的 —— `ms` 后面是 `}` 走了候选那条，
         `p` 后面是逗号反而被这一分支吃进了没人用的帧里）。
         多交给那组括号当候选是安全的：候选只在 `)` 判定「确实是形参列表」时才当真，否则整批丢掉。 */
      if (paren > 0 && parens.length) parens[parens.length - 1].cands.push(w);
      continue;
    }
    /* 形参与箭头参数：先攒进**当前这一组括号**，`)` 时再判它是不是形参。
       宁可放宽（把实参也当候选），也别把正常代码判成红 —— 反正不是形参就在 `)` 丢掉。
       `]` 也要认 —— 数组解构形参的**最后一个**名字后面是 `]`（`([k, t]) => …` 里的 t）。
       `}` 同理 —— **对象解构形参**的最后一个名字后面是 `}`（`opts.map(({ p, ms }) => …)`
       里的 `ms` 就是这么丢的：`p` 后面是逗号、收进了候选，`ms` 后面是 `}`、名单里没有这一项，
       于是 §A 报「ms 在本文件别处声明过但这里解析不到」—— 三条假红全出在这一行写法上。
       放宽是安全的：候选只在 `)` 后面接 `=>` / `function` / 方法简写时才当真（见上面那条判定）。 */
    if (paren > 0 && !isMember && parens.length
      && nx && nx.t === 'p' && (nx.v === ',' || nx.v === ')' || nx.v === '=' || nx.v === '=>' || nx.v === ']' || nx.v === '}')) {
      parens[parens.length - 1].cands.push(w); continue;
    }
    if (nx && nx.t === 'p' && nx.v === '(') {
      if (isMember) continue;                                        // 成员访问
      if (p && p.t === 'id' && (p.v === 'get' || p.v === 'set' || p.v === 'async' || p.v === 'static')) continue;
      if (p && p.t === 'p' && p.v === '{') continue;                // { foo() { … } } 方法定义
      const close = matchParen(toks, i + 1);
      const after = close >= 0 ? toks[close + 1] : null;
      if (after && after.t === 'p' && after.v === '{') continue;   // 逗号后面接 { 的也是方法简写
      calls.push({ name: w, line: t.line, frame: stack[stack.length - 1] });
    }
  }
  return { all, calls, members };
}
/* 这个名字能不能从第 k 层作用域解析到 */
function resolves(all, k, name) {
  for (let j = k; j >= 0; j = all[j].parent) if (all[j].names.has(name)) return true;
  return false;
}


/* 「这个名字在本文件里被声明成过局部变量吗」——
   用来把 `t.dur` 这类错挑出来，同时**不**误伤浏览器给的隐式全局
   （HTML 里 `id="side"` 会让 `side` 变成 window 上的属性，那种用法是合法的，
   而它不会出现在下面这份名单里 —— 它从来没被 const/let/var 声明过）。
   只收 const/let/var 与 function 声明：形参不算（形参本来就该在函数里解析得到，
   解析不到说明确实用错了地方，但那种情况下面「基对象」那条会更早报出来）。 */
function localDeclaredNames() {
  const out = new Map();                       // 名字 → 声明所在的行号数组
  const add = (n, line) => { if (!out.has(n)) out.set(n, []); out.get(n).push(line); };
  for (const f of targets.html.concat(targets.js)) {
    if (!exists(f)) continue;
    const src = read(f);
    const at = idx => src.slice(0, idx).split(String.fromCharCode(10)).length;
    let m;
    /* 声明名：`const|let|var` 后面那一段（到 `=` / `;` / 换行为止）里的**每个声明符**。
       两个坑都在这儿踩过：
         · 只收紧跟 let 的第一个名字 → `let grpRow, grid, …, delBtn;` 里后面那几个收不到
           （drama.html 的 delBtn 就是这么被误报的）；
         · 把 `X = …` 一律当声明 → `useBtn = el.querySelector(…)` 这种**赋值**也被收成声明，
           于是「声明行」里躺着的是赋值点，判「同不同一个顶层函数」时对不上。 */
    const reDecl = /\b(?:const|let|var)\s+([^=;\n]*)/g;
    while ((m = reDecl.exec(src))) {
      const seg = m[1];
      const line = at(m.index);
      if (/[{[]/.test(seg)) {           // 解构：把里面的标识符都收进来（多收无妨，只是更宽松）
        (seg.match(/[A-Za-z_$][\w$]*/g) || []).forEach(n => add(n, line));
      } else {
        seg.split(',').forEach(part => {
          /* 只取每一段的**第一个**标识符：`for (const x of xs)` 的 `of xs` 里
             `of` / `xs` 不是声明名。 */
          const one = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(part);
          if (one) add(one[1], line);
        });
      }
    }
    const re3 = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = re3.exec(src))) add(m[1], at(m.index));
  }
  return out;
}

/* 「这两个行号落不落在**同一个函数体**里」—— 区分两种「解析不到」：
     · 同在一个函数体里 → 嵌套闭包引用（`let delBtn` 在外层函数体、里层箭头函数用它），合法，放行；
     · 分属两个函数体 → 把上一个函数的局部变量拿到下一个函数里用了（`t.dur` 那种），报红。
   用**词法器配平**算每个 `function …{…}` 的行区间。不按缩进：同一段里 0 缩进与 2 缩进的
   顶层函数混着，靠缩进定「顶层」会认错（第一版就是这么错的，delBtn 那条一直误报）。
   只认 `function` 关键字、不认箭头函数：箭头函数通常很短，它的外层几乎总有一个 function，
   于是「同一函数体」仍然成立 —— 宁可宽一点，也不要误报。 */
function fnRanges(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (!(toks[i].t === 'id' && toks[i].v === 'function')) continue;
    let j2 = i + 1;
    while (j2 < toks.length) {                       // 找到函数体的 `{`
      const x = toks[j2];
      if (x.t === 'p' && (x.v === ';' || x.v === '{')) break;
      j2++;
    }
    if (!(j2 < toks.length && toks[j2].v === '{')) continue;
    let depth = 0, k2 = j2;
    for (; k2 < toks.length; k2++) {
      const x = toks[k2];
      if (x.t === 'p' && (x.v === '{' || x.v === '${')) depth++;
      else if (x.t === 'p' && x.v === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ start: toks[i].line, end: (toks[k2] || toks[j2]).line });
  }
  return out;
}
function sameFnOf(ranges, a, b) {
  return ranges.some(r => r.start <= a && a <= r.end && r.start <= b && b <= r.end);
}

/* §A-2：**模块文件**里的裸调用，只报一类 ——
   名字在本文件里当过「对象 / 类的属性方法」（`foo(a) { … }`），
   却没被声明成任何绑定，然后被当成裸函数调用了。
   为什么要单独收这一条：assetlib.js 里 `readBlobWithProgress` 是 `window.AssetTransfer` 的成员，
   而 `blobOf` 里写的是裸名 `readBlobWithProgress(...)` —— 于是**每一次「自动存本机」都抛
   `readBlobWithProgress is not defined`**，整条下载链是死的，界面上只写「获取失败」。
   而 §A 原来只扫 HTML 内联脚本，一行都没查过模块文件，这个错从判据底下整个走过去了。
   范围收得这么窄是有意的：模块文件里裸调用满天飞（window 上的全局、别的模块导出的名字、
   IIFE 参数），全查会误报一片；而「本文件里当过属性方法、又没被声明」几乎没有第二种解释。 */
function memberSites(toks) {
  /* 属性方法：`name ( … ) {`，且 `name` 前面是 `{` `,` `;` 或 get/set/async/static ——
     只看「后面跟着 ( 且配对的 ) 后面是 {」，能同时盖住对象字面量与 class 体。 */
  const prop = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'id' || NO_CALL.has(t.v)) continue;
    const nx = toks[i + 1];
    if (!(nx && nx.t === 'p' && nx.v === '(')) continue;
    /* matchParen 收的是**左括号的下标**（analyse 里传的是 id 的下标 + 1，因为那里只有 id 可用）。
       这里 i 指的是 id，所以左括号是 i+1 —— 传 i+2 会从括号**里面**开始数，
       深度永远回不到 0，一路扫到几百行外，判据整个失效（§A-2 第一版就是这么不咬人的）。 */
    const close = matchParen(toks, i + 1);
    const after = close >= 0 ? toks[close + 1] : null;
    if (!(after && after.t === 'p' && after.v === '{')) continue;
    const p = toks[i - 1];
    const p2 = toks[i - 2];
    const okPrev = !p || (p.t === 'p' && (p.v === '{' || p.v === ',' || p.v === ';'))
      || (p.t === 'id' && (p.v === 'async' || p.v === 'get' || p.v === 'set' || p.v === 'static'))
      || (p && p.t === 'p' && p.v === '*' && p2);
    if (okPrev) prop.add(t.v);
  }
  return prop;
}
/* 本文件里被当过**形参**的名字（含箭头函数与对象方法简写的形参列表）。
   为什么必须单独收：`function makePuller(near, step) { … step() … }` 里的 `step`
   完全合法，而它不是 `function/const/let/var` 声明 —— 不收就会把这一整套
   「把回调当参数传进来再调」的正常写法全判成红（workbench.js / drama.js 各一处，实测如此）。 */
function paramNames(toks) {
  const out = new Set();
  const addIds = (a, b) => { for (let j = a; j < b; j++) if (toks[j] && toks[j].t === 'id' && !NO_CALL.has(toks[j].v)) out.add(toks[j].v); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'id' && toks[i + 1] && toks[i + 1].t === 'p' && toks[i + 1].v === '=>') {
      if (!NO_CALL.has(t.v)) out.add(t.v);          // 单形参箭头
      continue;
    }
    if (!(t.t === 'p' && t.v === '(')) continue;
    const o = toks[i - 1], o2 = toks[i - 2];
    const isFn = !!o && ((o.t === 'id' && o.v === 'function')
      || (o.t === 'id' && o2 && o2.t === 'id' && o2.v === 'function'));
    const close = matchParen(toks, i);          // i 就是左括号本身（见 memberSites 里那段说明）
    const after = close >= 0 ? toks[close + 1] : null;
    const isArrow = !!(after && after.t === 'p' && after.v === '=>');
    /* 方法简写那一支要**双重确认**：`name(…) {` 之外，`name` 前面还得是 `{` `,` `;`
       或 async/get/set/static —— 否则 `Object.assign(a, b) {` 这种「调用之后恰好跟了个花括号」
       会被当成参数列表，一路 addIds 把后面几十行的标识符全收进「形参名单」，
       于是 §A-2 要抓的那个名字被它误当成形参放行（实测：readBlobWithProgress 就是这么漏的）。 */
    const pv = toks[i - 2];
    const prevOk = !pv || (pv.t === 'p' && (pv.v === '{' || pv.v === ',' || pv.v === ';'))
      || (pv.t === 'id' && (pv.v === 'async' || pv.v === 'get' || pv.v === 'set' || pv.v === 'static'));
    const isMethod = !!(o && o.t === 'id' && !NO_CALL.has(o.v) && prevOk
      && after && after.t === 'p' && after.v === '{');
    if (!isFn && !isArrow && !isMethod) continue;
    if (close > i) addIds(i + 1, close);
  }
  return out;
}
function sectionA2() {
  const globals = harvestGlobals();
  let files = 0, calls = 0, badCalls = 0;
  for (const f of targets.js) {
    if (!exists(f)) continue;
    files++;
    const src = read(f);
    CUR_FILE = f;
    const r = lex(src, 1);
    if (r.err) { bad('§A', f + ' 扫描器读不完：' + r.err + '（判据坏了）'); continue; }
    const an = analyse(r.toks);
    const prop = memberSites(r.toks);
    const params = paramNames(r.toks);      // 通过形参传进来的回调：合法，见 paramNames
    /* 本文件里出现过的**任何**绑定名：宁可放宽，也不要误报。 */
    const decl = new Set();
    let m;
    let re = /\b(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = re.exec(src))) decl.add(m[1]);
    re = /(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = re.exec(src))) decl.add(m[1]);
    re = /\b(?:import|export)\s*\{([^}]*)\}/g;
    while ((m = re.exec(src))) (m[1].match(/[A-Za-z_$][\w$]*/g) || []).forEach(x => decl.add(x));
    const seen = new Set();
    for (const c of an.calls) {
      calls++;
      if (globals.has(c.name) || decl.has(c.name) || params.has(c.name)) continue;
      if (!prop.has(c.name)) continue;
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      badCalls++;
      bad('§A', f + ':' + c.line + ' 裸调用 ' + c.name + '() —— 这个名字在本文件里只是某个对象 / 类的**属性方法**，'
        + '从没被声明成绑定（多半该写 `XXX.' + c.name + '(...)`）：调用它必然抛 `'
        + c.name + ' is not defined`，而调用点看上去完全正常');
    }
  }
  if (files && !badCalls) ok('§A', '模块文件也查了：' + files + ' 份 / ' + calls + ' 处裸调用，'
    + '没有「拿对象方法当裸函数调」的那一类（assetlib.js 的 readBlobWithProgress 就是这么断的下载链）');
  return files;
}
function sectionA() {
  const globals = harvestGlobals();
  /* 本文件里被声明过的局部名（见上面那段注释：用来只报「拿错作用域」这一种）。 */
  const locals = localDeclaredNames();
  let segs = 0, calls = 0, misses = 0, lexErr = 0, badBase = 0, mems = 0, judged = 0;
  for (const f of targets.html) {
    if (!exists(f)) { bad('§A', f + ' 不存在'); continue; }
    const html = read(f);
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m, si = 0;
    while ((m = re.exec(html))) {
      if (!m[1].trim()) continue;
      si++; segs++;
      const base = lineAt(html, m.index);
      CUR_FILE = f;
      const r = lex(m[1], base);
      if (r.err) { lexErr++; bad('§A', f + ' 第 ' + si + ' 段扫描器读不完：' + r.err + '（判据坏了，不是页面坏了）'); continue; }
      const an = analyse(r.toks);
      /* 所有 `function` 区间 + 去掉**脚本容器**（`(function(){ … })()` 那个）之后的那一份。
         为什么要去容器：这些页面的内联脚本几乎都被 IIFE 包着，于是任意两个顶层函数
         都有一个「公共函数」= 整个脚本 —— 拿它当「同一个函数」就等于全部放行
         （第一版就是这么漏掉 `t.dur` 的：注回去照样全绿）。
         判据：起点在段首几行、终点在段尾几行 → 它就是那个容器。 */
      const allRanges = fnRanges(r.toks);
      const lastLine = r.toks.length ? r.toks[r.toks.length - 1].line : base;
      const ranges = allRanges.filter(x => !(x.start <= base + 2 && x.end >= lastLine - 2));
      for (const c of an.calls) {
        calls++;
        if (globals.has(c.name)) continue;
        if (resolves(an.all, c.frame, c.name)) continue;
        misses++; bad('§A', f + ':' + c.line + ' 裸调用 ' + c.name + '() 既不在本作用域也不在 window 上');
      }
      /* 成员访问的基对象：只报「这个名字在本文件里被声明过、但当前位置解析不到」的 ——
         那正是「把别的函数的局部变量拿来用」（studio.html 的 `t.dur` 就是这么错的）。
         不报别的：HTML 的隐式全局（`side.value`）、页面自己挂到 window 上的名字都不在这份名单里。 */
      for (const b2 of an.members) {
        mems++;
        /* **builtin 优先**：`top` / `name` / `length` 这些既是浏览器的全局，
           又常被本项目当局部变量名用（settings.html 就有 `const top = window.top || window`）。
           同时命中时按「它是全局」放行 —— 宁可放过，也不要报一条要人查半天才知道是误报的红。
           真正抓的是「这个名字**只**在别处被声明过」（如 `t.dur` 里的 t）。 */
        if (globals.has(b2.name)) continue;
        const declLines = locals.get(b2.name);
        if (!declLines) continue;
        /* 形参那条路已经修好了（见 analyse 里形参挂在函数自己的帧上），
           所以这里 `resolves` 就足够判：解析得到 = 合法（含形参、闭包、模块级）；
           解析不到 = 这个名字在本文件里被声明过、但**不在当前作用域链上**：
           正是「把别的函数的局部变量拿来用」。 */
        judged++;
        if (resolves(an.all, b2.frame, b2.name)) continue;
        badBase++; bad('§A', f + ':' + b2.line + ' ' + b2.name + '.… —— 「' + b2.name
          + '」在本文件里被声明过（第 ' + declLines.slice(0, 3).join('、') + ' 行等），'
          + '但这里解析不到：多半是把上一个函数的局部变量拿来用了');
      }
    }
  }
  if (segs === 0) bad('§A', '一段内联脚本都没查到 —— 判据本身坏了（不带参数时不该出现）');
  else if (!misses && !lexErr && !badBase) ok('§A', '查了 ' + segs + ' 段内联脚本：' + calls + ' 处裸调用、'
    + mems + ' 处成员访问的基对象（其中 ' + judged + ' 个名字在本文件里被声明过，逐个问过作用域链），'
    + '全部落在本作用域或 window 上');
  return segs;
}

/* ================= §B ================= */
function sectionB() {
  let segs = 0, hits = 0;
  const run = (file, code, base) => {
    segs++; CUR_FILE = file;
    const r = lex(code, base || 1);
    if (r.err) { bad('§B', file + ' 扫描器读不完：' + r.err + '（判据坏了，不是代码坏了）'); return; }
    if (r.tplRaw.length) { hits += r.tplRaw.length; bad('§B', file + ' 第 ' + r.tplRaw.slice(0, 3).join('/') + ' 行：模板串里有「块注释 + 反引号」→ 整页白屏'); }
  };
  for (const f of targets.html) {
    if (!exists(f)) continue;
    const html = read(f);
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) if (m[1].trim()) run(f, m[1], lineAt(html, m.index));
  }
  for (const f of targets.js) if (exists(f)) run(f, read(f), 1);
  if (segs === 0) bad('§B', '一段都没扫 —— 判据本身坏了');
  else if (!hits) ok('§B', '扫了 ' + segs + ' 段源码，模板串里没有「块注释 + 反引号」这种写法');
  return segs;
}

/* ================= §C ================= */
function sectionC() {
  if (!targets.html.length) { bad('§C', '没指定页面，跨文件唯一性判不了 —— 这次是只查 js 的用法'); return 0; }
  const sites = [];
  for (const f of JS_FILES.concat(HTML_FILES)) {
    if (!exists(f)) continue;
    const src = read(f);
    /* 按**出现次数**数，不按文件数 —— 同一个文件里出现第二份同样要红
       （第一版只判「这个文件有没有」，于是往 ident.js 里加一份副本它照样全绿，
        而那正是这一档要抓的东西）。 */
    const nVol = (src.match(/VOLATILE_Q\s*=\s*\//g) || []).length;
    for (let i = 0; i < nVol; i++) sites.push(f + ':VOLATILE_Q');
    for (const fn of ['upKeyOf', 'localUpKey', 'mediaKey', 'innerMedia']) {
      const n = (src.match(new RegExp('function\\s+' + fn + '\\s*\\(', 'g')) || []).length;
      for (let i = 0; i < n; i++) sites.push(f + ':' + fn);
    }
  }
  /* 比的是**个数**不是集合包含 —— 第二版用 `extra = sites.filter(...)`，
   同一处出现两次时两个副本都「在名单里」，于是多出来的那份被静默吃掉，判据照样全绿。 */
  const expectMap = { 'ident.js:VOLATILE_Q': 1, 'ident.js:innerMedia': 1, 'ident.js:upKeyOf': 1,
    'proxy.js:localUpKey': 1, 'assetlib.js:mediaKey': 1 };
  const gotMap = {};
  sites.forEach(s => { gotMap[s] = (gotMap[s] || 0) + 1; });
  const diff = [];
  [...new Set([...Object.keys(expectMap), ...Object.keys(gotMap)])].forEach(k => {
    const e = expectMap[k] || 0, g = gotMap[k] || 0;
    if (e !== g) diff.push(k + ' 期望 ' + e + ' 份、实到 ' + g + ' 份');
  });
  if (diff.length) bad('§C', '同一机制的实现份数对不上：' + diff.join('；') + '（一个机制只许一份实现）');
  else ok('§C', '身份判据共 ' + sites.length + ' 处定义，与预期的 ' + Object.keys(expectMap).length + ' 处逐一对上，没有副本');
  return sites.length;
}

/* ================= §D ================= */
function sectionD() {
  if (!targets.html.length) { bad('§D', '没指定页面，引入顺序判不了 —— 这次是只查 js 的用法'); return 0; }
  let pages = 0, wrong = 0;
  for (const f of targets.html) {
    if (!exists(f)) { bad('§D', f + ' 不存在'); continue; }
    const L = read(f).split(/\r?\n/).map(x => x.trim());
    const ia = L.findIndex(x => x.indexOf('"ident.js"') >= 0);
    const ib = L.findIndex(x => x.indexOf('"assetlib.js"') >= 0);
    if (ib < 0) continue;
    pages++;
    if (ia < 0) { wrong++; bad('§D', f + ' 引了 assetlib.js 却没引 ident.js —— assetlib 会在解构那一行当场炸'); }
    else if (ia > ib) { wrong++; bad('§D', f + ' 的 ident.js 排在 assetlib.js **后面**，解构会拿到 undefined'); }
  }
  if (!pages) bad('§D', '一个引 assetlib.js 的页面都没查到 —— 判据本身坏了');
  else if (!wrong) ok('§D', '查了 ' + pages + ' 个引 assetlib.js 的页面，ident.js 都在它前面');
  return pages;
}

/* ================= §E ================= */
function sectionE() {
  if (!exists('assetlib.js')) { bad('§E', 'assetlib.js 不存在'); return 0; }
  const src = read('assetlib.js'), has = re => re.test(src);
  if (!has(/function\s+collapseInto\s*\(/)) bad('§E', 'collapseInto 不见了 —— 合并判据的那一份实现被删了');
  else if (!has(/const\s+pushEntry\s*=\s*\(st,\s*e\)\s*=>\s*collapseInto\s*\(\s*st\s*,\s*e\s*\)/)) bad('§E', 'pushEntry 不再是 collapseInto 的薄封装（又长出第二份规则了）');
  else if (!has(/function\s+collapseTwins\s*\(list\)\s*\{\s*const\s+st\s*=\s*\{\s*out:\s*\[\],\s*twins:\s*new Map\(\)\s*\}/)) bad('§E', 'collapseTwins 不再是 collapseInto 的薄封装（又长出第二份规则了）');
  else if (/\n\s*function\s+pushEntry\s*\(st,\s*e\)\s*\{/.test(src)) bad('§E', 'pushEntry 又长出了自己的规则体');
  else ok('§E', '合卡规则只有 collapseInto 一份，pushEntry 与 collapseTwins 都是它的薄封装');
  return 1;
}

/* ================= §F ================= */
/* 从 proxy.js 里切出一个路由的处理块：起点是 `if (dataPath === '<route>'`，
   终点是**下一个**同形状的 `if (dataPath === '`。代理里的路由是一串平铺的顶层
   `if (dataPath === ...)`，所以「到下一个为止」正好等于这一段 —— 不做花括号配平，
   那要正确处理字符串/正则里的括号，比它要挡的东西更容易出错。 */
function routeBlock(src, route) {
  const m = new RegExp("if \\(dataPath === '" + route + "'").exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + 1);
  const nx = /^\s*if \(dataPath === '/m.exec(rest);
  return nx ? rest.slice(0, nx.index) : rest;
}
/* §F 另存那条链**只有一个触发点**：写盘一律挂在镜像流程内部。
   为什么会有人再加一个：另存看着像个独立功能，于是有人从别处再调一次 /save ——
   那样就绕过了 offer() 的「这份产物已经存过了就跳过」，同一份东西反复写、
   还把「为什么没落盘」这件事变得没法推理。这里把三个入口各锁一个调用点，
   并且要求它们待在预期的那一个文件里。 */
function sectionF() {
  if (!targets.html.length) { bad('§F', '没指定页面，调用点分布判不了 —— 这次是只查 js 的用法'); return 0; }
  const red0 = red;                       // 本档自己红了几条（不能看全局：前面几档的红不该吞掉本档的绿）
  /* 预期：入口 → [调用它的那一处必须在哪个文件、几处]
     `/save` 的字面量只在 assetlib.js 的 Api 定义里出现一次；
     三个 Api.* 入口各恰好一个调用点。 */
  const EXPECT = [
    { lit: null, fn: 'saveToDir', file: 'assetlib.js' },
    { lit: '/save', fn: null, file: 'assetlib.js' },
    { lit: null, fn: 'saveLocal', file: 'settings.html' },
    { lit: null, fn: 'saveMove', file: 'settings.html' },
  ];
  const browser = JS_FILES.filter(f => f !== 'proxy.js').concat(HTML_FILES);
  let sites = 0;
  for (const e of EXPECT) {
    const hits = [];
    for (const f of browser) {
      if (!exists(f)) continue;
      const src = read(f);
      if (e.lit) {
        /* 端点字面量：只数 `rawFetch('/save'` —— 用 `'/save'` 裸串会把
           '/save-local'、'/save-move' 也算进来（那正是这一档最想分开的两条路由）。 */
        const n = (src.split("rawFetch('" + e.lit + "'").length - 1);
        for (let i = 0; i < n; i++) hits.push(f);
      } else {
        const n = (src.split('Api.' + e.fn + '(').length - 1);
        for (let i = 0; i < n; i++) hits.push(f);
      }
    }
    sites += hits.length;
    const name = e.lit ? ("端点 " + e.lit) : ('Api.' + e.fn);
    if (hits.length !== 1) bad('§F', name + ' 在浏览器侧有 ' + hits.length + ' 个调用点（' + (hits.join('、') || '一个都没有') + '）—— 另存只许挂在镜像那一处');
    else if (hits[0] !== e.file) bad('§F', name + ' 的调用点在 ' + hits[0] + '，不该在那儿（应在 ' + e.file + '）');
  }
  if (!sites) bad('§F', '一个调用点都没查到 —— 判据本身坏了');
  else if (red === red0) ok('§F', '另存三个入口 + /save 字面量共 ' + sites + ' 处调用点，各只有一个、且都在预期的那一处');
  return sites;
}

/* ================= §G ================= */
/* 从 assetlib.js 里切出一个 `async fn(...) { … }` 的函数体（按花括号配平）。
   这三个函数体都很短、字符串里没有花括号，所以直接配平是安全的；
   真配不平就返回 null，让判据报红而不是给一个半截的读数。 */
function fnBlock(src, name) {
  const m = new RegExp('async\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++; }
  return depth ? null : src.slice(m.index, i);
}
/* §G 另存那三条路的安全立场，以及「.assets 里那份一律不动」。
   前者：页面只递本机号与**旧目录**，目标路径一律由代理从配置读 ——
   浏览器递过去的路径没法验证，代理也没法验证调用方是不是本工作台的页面；
   `/save` 早就这么定了（请求体里带 dir 会被丢掉）。一条新的另存路由若开始接受
   客户端递的目标目录，这条路线就变成「任意本机网页往任意路径写文件」。
   后者：/save-local 是**拷一份**，.assets 那份是资产库的本体（离线能看、删了能回源），
   移走等于把工作台弄坏 —— 所以那一段里不允许出现任何删/改名；
   而 /save-move 恰恰相反，必须「先写目标、写成功才删源」，顺序反了就是数据丢失。 */
function sectionG() {
  if (!exists('proxy.js')) { bad('§G', 'proxy.js 不存在'); return 0; }
  const red0 = red;
  const proxy = read('proxy.js'), alib = exists('assetlib.js') ? read('assetlib.js') : '';
  let checks = 0;
  for (const f of ['saveToDir', 'saveLocal', 'saveMove']) {
    const b = fnBlock(alib, f);
    checks++;
    if (!b) { bad('§G', 'assetlib.js 里找不到 Api.' + f + ' 的函数体'); continue; }
    const leak = /\b(dir|path|to)\s*:/.exec(b);
    if (leak) bad('§G', 'Api.' + f + ' 的请求体里出现了「' + leak[1] + '」—— 目录只能由代理从配置读，页面递不得');
  }
  const bl = routeBlock(proxy, '/save-local');
  checks++;
  if (!bl) bad('§G', "proxy.js 里找不到 '/save-local' 的处理块");
  else {
    const kill = /\b(unlinkSync|rmSync|renameSync|rmdirSync|copyFileSync|cpSync)\s*\(/.exec(bl);
    if (kill) bad('§G', '/save-local 里出现了 ' + kill[1] + ' —— 补存是「拷一份」，.assets 那份一律不动');
  }
  const bm = routeBlock(proxy, '/save-move');
  checks++;
  if (!bm) bad('§G', "proxy.js 里找不到 '/save-move' 的处理块");
  else {
    const un = [...bm.matchAll(/unlinkSync\(/g)].map(x => x.index);
    if (!un.length) bad('§G', '/save-move 里没有 unlinkSync —— 那是「搬」，搬完不删源就是「拷」，和 /save-local 没区别了');
    for (let i = 0; i < un.length; i++) {
      /* 每一次删源都只认两条合法的路：
           ① 这一段里已经写过目标（先写、写成功才删）；或
           ② 删之前刚验过「目标里已经是同一份内容」（那才是「搬」而不是「拷」，
              内容没丢，所以不需要再写一遍）。
         **不能**简单判「writeFileSync 必须在 unlinkSync 之前」—— ② 那一支压根不写，
         按那句话去判会把一条正确实现报成红（第一版就是这么错的）。
         也不能反过来放宽成「顺序无所谓」—— 那就等于把「先删后写」这个真缺陷放过去了。 */
      const from = i ? un[i - 1] + 12 : 0;
      const between = bm.slice(from, un[i]);
      if (between.indexOf('writeFileSync') < 0 && !/\bsums\s*\.\s*(get|has)\s*\(/.test(between))
        bad('§G', '/save-move 第 ' + (i + 1) + ' 次 unlinkSync 之前既没有写入目标、也没有校验目标里已是同一份内容 —— 源文件可能白删');
    }
  }
  /* 「另存目录不许是 .assets」这道闸，三条路由都得过，而且判据只许一份。
     白名单（sk_autosave_used.json）挡不住这一种：用户把另存目录填成 .assets 完全合法，
     而那样 /save 写进去的副本会把 .assets 记进白名单，下一次换位置 /save-move
     就会真的从资产库里搬走文件 —— 资产库一空，工作台就什么都看不到了。
     各路由自己写一遍前缀比较，下次有人加第四条另存路由就会漏掉。 */
  checks++;
  const defs = (proxy.match(/function\s+insideLocalDir\s*\(/g) || []).length;
  if (defs !== 1) bad('§G', 'insideLocalDir 的实现有 ' + defs + ' 份（一个机制只许一份实现）');
  /* 逐道点名要守住的参数。/save-move 有**两道**闸（源与目标），
     写成「这个块里存在一道 insideLocalDir 闸」就等于只查了其中一道 ——
     改坏另一道照样全绿（变异脚本当场抓出来，第二版才改成按参数点名）。 */
  for (const [route, args] of [['/save', ['dir']], ['/save-local', ['dir']], ['/save-move', ['srcDir', 'to']]]) {
    const blk = routeBlock(proxy, route);
    if (!blk) { bad('§G', "proxy.js 里找不到 '" + route + "' 的处理块"); continue; }
    /* 认的是「**行首就是一个真的 if 语句**」，不是「文本里出现过 insideLocalDir(」。
       后者被人 `if (false && insideLocalDir(...))` 短路掉之后照样绿（第一版就是这么写的）。 */
    for (const a of args) {
      if (!new RegExp('^\\s*if \\(insideLocalDir\\(' + a + '\\)', 'm').test(blk))
        bad('§G', route + ' 里没有一道**真正会执行**的 insideLocalDir(' + a + ') 闸 —— 另存目录可能被设成 .assets 本身');
    }
  }

  if (!checks) bad('§G', '一处都没查 —— 判据本身坏了');
  else if (red === red0) ok('§G', '查了 ' + checks + ' 处：三个页面入口都不递目录、三条另存路由都过 insideLocalDir、'
    + '/save-local 不动 .assets、/save-move 的每一次删源前面都有「已写入」或「已验明同一份内容」');
  return checks;
}

/* ================= §H =================
   用户可见文案里不许出现 markdown 标记。
   踩过两次：settings.html 的另存提示里写 `**额外**`、drama.html 的机位按钮 title 里写 `**看着挑**` ——
   界面不渲染 markdown，于是两个星号原样摆给用户看。源码里看不出问题（那两处就是普通中文字符串），
   只有真打开页面才看得见，所以它必须是一条**常驻**判据，不能靠「改的时候顺手看一眼」。

   为什么不是「全文找 **」：`**` 在本项目是源码注释的强调写法，注释里到处都是；
   ai-chat.js 拼给模型的系统提示词更是**故意**要 markdown（模型才认）。
   照那条查会报几百条，然后大家就不看了 —— 一条天天报红的判据等于没有判据。
   判据只认两处真正会摆到屏幕上的地方：
     ① 页面里 <script>/<style>/注释之外的**静态正文与属性值**（写死在 HTML 里的字）；
     ② JS 里**挂在界面属性名上**的字符串字面量（textContent / innerHTML / title / placeholder …）。
   注释天然查不到（lex 直接跳过整段），AI 提示词天然查不到（它们不挂在界面属性名上）。

   判「界面属性名」只认**同一行**，外加「以 `+` 开头的续写行往上找 3 行」（见 sinkLineOf）：
   写成「不管续写、随便往下看两行」就会把 `$('hint').textContent = 'a'; toast('**b**')`
   里那个 b 也算成界面文案 —— 假红比漏红更费人。
   `sub` / `body` 是 `Confirm.ask` / `Confirm.choose` 的正文与副标题（都走 `textContent`），
   2026-10 补进来：那一处 `sub: '**沿用上一次…**'` 语法、渲染都不报错，只有点开那颗按钮才看见两个星号。
   `UiDialog` 的 `body(el) { … }` 不会被这一条命中 —— 名字后面紧跟的是 `(el)` 不是 `:` / `=`。 */
const UI_SINK = /\b(?:textContent|innerText|innerHTML|outerHTML|insertAdjacentHTML|title|placeholder|alt|label|ariaLabel|aria-label|hint|note|desc|empty|tooltip|caption|sub|body)\s*[:=]/;
/* 「这段带 markdown 的文字，是挂在哪个界面属性上的」——ls 里第 i 行那段脚本。
   同一行认不出来时**只往上找 3 行**，且必须每一行都以 `+` 开头（字符串续写）才继续：
   界面文案经常是这么写的
       sub: '机位会写进…' + (cur2 ? '…' : '…')
         + '　·　想**看着图挑**，点下面那颗「出 N 个机位图」',
   形如 sub: 的属性名在第一行、带星号的字面量在第二行 —— 只认同一行就整段漏过去，
   而 `Confirm.choose` 把它当副标题原样摆到屏幕上（drama.html:4582-4583 踩过，
   判据当时一声不吭）。
   限定「以 + 开头」是为了不把 `$('hint').textContent = 'a'; toast('**b**')` 里那个 b 算进来：
   那种写法本行不以 + 开头，走到上一层就停了 —— 假红比漏红更费人（见上面那段注释）。 */
function sinkLineOf(ls, i) {
  for (let k = 0; k < 4; k++, i--) {
    if (i < 0) return -1;
    const ctx = ls[i] || '';
    if (UI_SINK.test(ctx)) return i;
    if (!/^\s*\+/.test(ctx)) return -1;
  }
  return -1;
}

function sectionH() {
  const red0 = red;
  let checks = 0;
  const all = targets.js.map(f => ({ f, html: false })).concat(targets.html.map(f => ({ f, html: true })));
  for (const item of all) {
    const f = item.f;
    if (!exists(f)) { bad('§H', f + ' 不存在'); continue; }
    const src = read(f);
    /* ① 静态正文与属性值：把 script / style / 注释整块挖掉，剩下的就是会直接显示的字。
       ⚠ 挖法必须连**标签本身**一起挖（下面那句连 `<script…>` 一起替换成换行）——
       只挖标签之间的内容会留下一堆孤立的模板串片段
       （页面把整段 UI 写在 col.innerHTML = \`…\` 里，那一整块就变成了「正文」），
       于是 `${idx}</span>\` 里跨过插值的那一段会被当成静态正文，
       正好在它后面挨着 `**` 时报一条根本不存在的红。
       这就是「尺子自己坏掉」的样子：第一版就是这么写的，
       加了两颗按钮（文案里没有 markdown）之后 §H 突然红了。 */
    if (item.html) {
      checks++;
      const visible = src.replace(/<script[\s\S]*?<\/script>/gi, '\n')
        .replace(/<style[\s\S]*?<\/style>/gi, '\n')
        .replace(/<!--[\s\S]*?-->/g, '\n');
      for (const m of visible.matchAll(/\*\*[^*\n]{1,60}\*\*/g)) {
        const ln = lineAt(visible, m.index);
        bad('§H', f + ' 第 ' + ln + ' 行静态正文里有 markdown 标记：' + m[0].slice(0, 46));
      }
    }
    /* ② 内联脚本（HTML 里切出来）/ 整个模块文件 */
    const segs = item.html
      ? Array.from(src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
        .filter(m => m[1].trim()).map(m => ({ code: m[1], base: lineAt(src, m.index) }))
      : [{ code: src, base: 1 }];
    for (const seg of segs) {
      CUR_FILE = f;
      const r = lex(seg.code, seg.base);
      if (r.err) { bad('§H', f + ' 扫描器读不完：' + r.err + '（判据坏了，不是页面坏了）'); continue; }
      const ls = seg.code.replace(/\r\n/g, '\n').split('\n');
      for (const t of r.toks) {
        if (t.t !== 'str' && t.t !== 'tpl') continue;
        if (!t.s || t.s.indexOf('**') < 0) continue;
        /* 模板串是「静态文本 / 插值」交替的，一段一段看；判据落在它所在那一行 */
        for (const piece of String(t.s).split('${')) {
          if (piece.indexOf('**') < 0) continue;
          checks++;
          /* 行号要按**这一段**去查：lex 拿的是 seg.base（那一页 <script> 在整份文件里的行号），
             所以 token 的 line 是「全文件的行号」，而 ls 是「这段脚本自己的第几行」。
             写成 ls[t.line - 1] 时模块（base=1）恰好没错，页面内联脚本却整体偏移几百行 ——
             ctx 取到的是另一行，UI_SINK 永远对不上，**内联脚本那一支等于一直在假绿**
             （2026-10 加 sub/body 两个界面属性名时靠变异才发现：星号注进 drama.html 的
              Confirm.choose 副标题，判据一声不吭，而 checks 计数确实涨了 —— 字找到了，行取错了）。 */
          const at = sinkLineOf(ls, t.line - seg.base);
          if (at < 0) continue;
          bad('§H', f + ' 第 ' + (seg.base + at) + ' 行 markdown 标记漏进界面：' + piece.trim().slice(0, 44));
        }
      }
    }
  }
  if (!checks) bad('§H', '一处都没查 —— 判据本身坏了');
  else if (red === red0) ok('§H', '查了 ' + checks + ' 处界面文案（' + targets.html.length + ' 个页面的静态正文与内联脚本、'
    + targets.js.length + ' 个模块），没有 markdown 标记漏到界面上');
  return checks;
}

/* ================= §I =================
   「能力来源」这句话全站只有一份口径（Capabilities.srcTextOf）。
   踩过：同一份 Capabilities.sourceOf() 的结果，studio.html 里有三处各写一遍
   （型号下拉下的副注、格式下拉下的 #formatHint、换平台后的 #capHint），ai-chat.js 里还有第四处。
   措辞两套、缓存标记两套，而其中两处把 note 整个丢了 —— note 正是 proxy.js 四处兜底各给的
   「这家为什么没拿到上游能力」（没声明该端点 / 返回 404 / 没返回模型列表 / 请求失败），
   压成一句「上游接口没给或不可用」等于零信息，而同一屏上另一处正写着真正的原因。

   指纹选「from 与 'api' 的比较」：任何一处要报能力来源，都必须先分 api 还是兜底
   （不分就拿不到 note），所以这个比较是那套机制躲不掉的指纹 —— 写第二份就一定留下第二处。
   指纹**用词法器找，不用正则**：上面那段注释里就写着「来自上游 /models」，
   而这类判据的文档顺口提一句被收掉的措辞是常事，正则会当场把自己照红。
   同一个原因，措辞黑名单也只查字符串字面量与模板串的静态文本，不查注释。 */
function sectionI() {
  const red0 = red;
  const items = targets.js.map(f => ({ f, html: false })).concat(targets.html.map(f => ({ f, html: true })));
  const files = items.map(i => i.f).filter(exists);
  if (!files.length) { bad('§I', '一份源码都没读到 —— 判据本身坏了'); return 0; }

  /* ① 实现只有一份：这个形态精确到函数头，注释里不会长这样 */
  const items2 = [];
  let defs = 0, inHome = 0, sites = [], strScan = 0;

  for (const it of items) {
    if (!exists(it.f)) continue;
    const src = read(it.f);
    const m = /srcTextOf\s*\(\s*src\s*\)\s*\{/.exec(src);
    if (m) defs++;
    const segs = it.html
      ? Array.from(src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
        .filter(x => x[1].trim()).map(x => ({ code: x[1], base: lineAt(src, x.index) }))
      : [{ code: src, base: 1 }];
    for (const seg of segs) {
      CUR_FILE = it.f;
      const r = lex(seg.code, seg.base);
      if (r.err) { bad('§I', it.f + ' 扫描器读不完：' + r.err + '（判据坏了，不是页面坏了）'); continue; }
      const T = r.toks;
      /* ① 从 from 那一行起、到函数配平的那一行止 —— 只有它体内的判断才算「这一份」 */
      let rng = null;
      if (m && !it.html) {
        let j = m.index + m[0].length, depth = 1;
        while (j < src.length && depth) { const c = src[j]; if (c === '{') depth++; else if (c === '}') depth--; j++; }
        if (!depth) rng = { a: lineAt(src, m.index), b: lineAt(src, j) };
      }
      for (let k = 0; k + 2 < T.length; k++) {
        /* `===` 被词法器拆成 `==` 与 `=` 两个 token，所以只认「以等号打头的比较符」 */
        if (T[k].t !== 'id' || T[k].v !== 'from') continue;
        /* === 被词法器拆成 == 与 = 两个 token，只看紧邻那一个就永远匹配不上（第一版 §I 一上线就报 0 处）。
           先把连续的「以等号打头的比较符」跳过去；j === k + 1 排掉压根没有比较符的情况。 */
        let j = k + 1;
        while (j < T.length && T[j].t === 'p' && /^=+$/.test(String(T[j].v))) j++;
        if (j === k + 1) continue;
        /* 字符串字面量只吐一个 token：v 是引号、内容在 s 里 —— 当成「引号 + 内容」两个去看就永远对不上 */
        if (T[j].t !== 'str' || T[j].s !== 'api') continue;
        const inside = !!(rng && T[k].line >= rng.a && T[k].line <= rng.b);
        if (inside) inHome++;
        items2.push({ f: it.f, ln: T[k].line, inside });
      }
      /* ② 被收掉的那几套措辞，只在字符串字面量 / 模板串静态文本里查（注释不算界面） */
      for (const t of T) {
        if (t.t !== 'str' && t.t !== 'tpl') continue;
        const s = String(t.s || '');
        if (!s) continue;
        for (const phrase of STALE) {
          strScan++;
          if (s.indexOf(phrase) < 0) continue;
          bad('§I', '被收掉的旧措辞「' + phrase + '」又出现在 ' + it.f + ' 第 ' + t.line + ' 行的文案里');
        }
      }
    }
  }
  sites = items2;

  if (defs !== 1) bad('§I', 'srcTextOf 的实现有 ' + defs + ' 份 —— 一份数据只许一份口径');
  if (sites.length !== 1) {
    bad('§I', '「能力来源是 api 还是兜底」这个判断有 ' + sites.length + ' 处（'
      + (sites.map(s => s.f + ':' + s.ln).join('、') || '一处都没有')
      + '）—— 多出来的那处就是又一次内联写法，而内联写法一定要不了 note');
  } else if (!sites[0].inside) {
    bad('§I', '唯一那处判断在 ' + sites[0].f + ':' + sites[0].ln + '，不在 assetlib.js 的 srcTextOf 体内 —— 判据和实现脱节了');
  } else if (inHome !== 1) {
    bad('§I', 'srcTextOf 体内有 ' + inHome + ' 处 api 判断（应为 1）');
  }

  /* ③ 定义了却没人调 = 这档判据被悄悄废掉。4 = studio.html 三处（副注 / 格式下拉提示 /
     换平台提示）+ ai-chat.js 一处（助手续述给用户）。少一处就是有一处改回了内联写法。 */
  let calls = 0;
  for (const it of items) {
    if (!exists(it.f)) continue;
    const src = read(it.f);
    const n = src.split('srcTextOf(').length - 1;   /* 属性访问也算调用，不能排除掉前面的 '.' */
    calls += it.f === 'assetlib.js' ? Math.max(0, n - 1) : n;
  }
  if (calls < 4) bad('§I', 'srcTextOf 只被调 ' + calls + ' 次（应至少 4 次：studio.html 的副注、格式下拉提示、换平台提示，ai-chat.js 的助手续述）—— 有一处改回了内联写法');

  if (red === red0) ok('§I', '查了 ' + files.length + ' 份源码：能力来源只有 assetlib.js 的 srcTextOf 一处判断（被调 ' + calls
    + ' 次），' + strScan + ' 段文案字面量里没有旧措辞');
  return sites.length;
}
const STALE = ['来自上游 /models', '上游接口没给或不可用', '来自本项目的平台声明', '本项目兜底声明（还没从'];

/* ================= §J =================
   「同一个功能只应有一份实现」—— 把这几轮收拢的结果钉住，免得它们悄悄长回来。
   下面每一条的期望值都是**先量过的真实分布**，不是猜的（量完发现三条设想全错，见下）：
     ① b64Bytes 的定义恰好 1 处，且在 ui.js —— base64→字节那段以前在 4 个地方各抄一份
        （导演台导出 / 拍短剧音色试听 / 资产库字节转存 / ui.js 自己的 DataSync）。
     ② 它的调用至少 4 处 —— 有人把某处改回内联写法时，定义数不变而调用数掉下来，这条先红。
     ③ showSaveFilePicker / showDirectoryPicker 作为标识符 0 处 —— 「下载落点」那一层已删干净。
        **注释里可以提**（workbench.js 与 director.html 各有一句就在说明它被删了），
        词法器剥注释，所以那两处不算。这一档正是靠词法器才分得开「提到」与「真调用」——
        用正则去查的话，恰恰会被那两句说明文字照红。
     ④ 页面里 function toast( 为 0 处 —— 提示组件只有 ui.js 的 window.Toast 一份。
     ⑤ 字节单位数组 ['B','KB','MB','GB'] 恰好 2 处：ui.js 与 assets.html。
        **后者是有意的分叉**：它的守卫是 b == null || isNaN(...)，对 0 / 负数 / Infinity
        的输出与公共那份不同（0 会显示成 '0 B'），合并就改了行为，所以不收。
        另配一条负向断言：workbench.js 里不许再出现 —— Wb.fmtSize 必须委托 window.fmtBytes。
     ⑥ 页面里 new IntersectionObserver( 为 0 处 —— 页面级续拉走 Wb.pager.sentinel；
        模块内那几处是允许的（assetlib.js 的懒抽帧、workbench.js 自己的两处），所以**只查页面**。
     ⑦ 页面对 Wb.pager.create() 返回值的成员访问，名字必须在 workbench.js 的 api 面上。
        踩过：studio.html 三处 `try { pager.fill(n) } catch {}` —— api 上**从来没有** fill，
        TypeError 被那句 try/catch 吞掉，于是「刷新后补齐 / 窗口变高再拉 / 首屏再拉」三条路
        一次都没跑到过，而语法自测与控制台都不报（§5 里「页面要用数据层的东西就得先进导出表」那一类）。
        api 那张面**从 workbench.js 现取**（认 `const api = {` 那一层花括号里的成员名，
        带 async/get/set 前缀的也算），不手抄名单 —— 抄一份名单就是第二份真相，
        公共层加一个方法还得记得回来改判据，忘了就红在产品上。

   写这一档时踩到的两件事，都记在这儿免得重犯：
   - **指纹太松会把不相干的写法一起抓**。第一版拿 `new Uint8Array(x.length)` 当
     base64→字节的指纹，结果 studio.html 那段 `new Uint8Array(h.length / 2)`
     （**十六进制 → 文本**）被一起照红。真想改用 charCodeAt，一量发现它全项目 5 处
     （还有两种哈希算法和一个 WAV 头写入），于是这条指纹整个不成立 —— 宁可少守一条，
     也不留一条会误报的。
   - **量脚本自己漏传 lineBase**，页面内联脚本报出来的行号是相对脚本开头的，
     studio.html 真正在 1403 行的那处被报成 1170，看着像词法器解析跑偏。
     先怀疑产品之前先怀疑尺子，这次就是这么查清的。 */
/* 「这一个赋值挂在 window 上吗」—— §J 判「某组件的实现有几处」时用。
   为什么需要它：`obj.X = ...` 与 `window.X = ...` 在词法器里长得几乎一样
   （只差左边那个 token 是`id` 还是「`window` 这个 id 后面跟一个点」），
   而前者只是**把手里的东西挂到一个对象上**（注入执行环境里的 `P.Chips = mod('Chips')` 就是），
   不是第二个实现 —— 不区分就会凭空报一条红，而且改代码的人永远查不出哪里错了。 */
function onWindow(tok) {
  if (!tok) return false;
  const v = String(tok.s || tok.v || '');
  return v === 'window' || v === 'globalThis' || v === 'self' || v === 'top' || v === 'parent';
}

function sectionJ() {
  const red0 = red;
  const items = targets.js.map(f => ({ f, html: false })).concat(targets.html.map(f => ({ f, html: true })));
  const files = items.map(i => i.f).filter(exists);
  if (!files.length) { bad('§J', '一份源码都没读到 —— 判据本身坏了'); return 0; }

  let scanned = 0, defs = 0, calls = 0, pickers = 0, toastDefs = 0, ioInPage = 0, unitInWb = 0;
  let chipRows = 0, chipsDefs = 0, chipsCalls = 0;
  let pagerCalls = 0, pagerOff = 0;
  const defSites = [], pickerSites = [], toastSites = [], ioSites = [], unitSites = [];
  const chipRowSites = [], chipsDefSites = [], chipsCallSites = [], pagerOffSites = [];
  /* ⑧ 跨页「拿去生成」的载荷：写的人只许有一个（workbench.js 的 `Wb.reuse.go`），
     读的人只许有一个（studio.html 那一处，读完就删）。三页以前各拼一份 JSON、各写一遍地址，
     而消费端只认平台资产号 —— 素材库与收藏里的本地文件压根没有那个号，
     于是递过去 `/asset/undefined`，界面还说「已复用」。收成一份之后拿这一档钉住。 */
  let reuseWrite = 0, reuseRead = 0, reuseGoCalls = 0;
  const reuseWriteSites = [], reuseReadSites = [];
  /* ⑨ 本机落盘这一条链（本轮加的）：
       · 手动「自动下载」只有 `AssetLocal.pull` 这一个落盘口，恰好 2 处、分属收藏与素材库各一颗；
       · 「藏不藏云端成品」只有 `hideAsCloud` 一份判据（定义 1 处且在 assetlib.js），
         页面调用点恰好 3 处，且**只许出现在资产库与生成工作台** —— 收藏 / 素材库故意不藏
         （那两页存的是人手工挑进来的东西，一条看不见就是「我收的东西没了」）；
       · 「本机有没有这份字节」只有 `hasLocalAddr` 一份，恰好 2 处（两颗按钮各问一次）；
       · 页面里不许出现 `'/local-assets'` 这个字面量 —— 要落盘就调公共那一条链，
         自己 POST 等于绕过身份判据与去重（同一份产物反复下载、资产库同一张卡重复 N 次）。
         ai-chat.js 那一句是 GET 读清单，而且它是模块不是页面，所以只查 `*.html`。 */
  let dlPull = 0, hideDef = 0, hideCalls = 0, addrCalls = 0, rawLocalInPage = 0;
  let armDef = 0, armCalls = 0, armInline = 0, assetMerge = 0, mergeCalls = 0;
  const armDefSites = [], armCallSites = [], armInlineSites = [], assetMergeSites = [];
  const dlPullSites = [], hideDefSites = [], hideCallSites = [], addrCallSites = [], rawLocalSites = [];

  /* ⑦-a pager 的 api 面：从 workbench.js 现取，不手抄名单（见上面 ⑦ 的说明）。
     认 `const api = {` 那一层花括号里处在成员位置的标识符：前驱是 { 或 ,（或 async/get/set 前缀），
     后继是 ( 、: 或 , 、}（简写属性）。方法体里的东西都在更深层，靠深度自然挡掉。
     这一份提法与「真把 workbench.js 装进 vm 跑一次、问 create() 的返回值要 keys」逐字相等
     （11 个名字，两边都对过 —— 提法松或紧过一次就会报出差异，那是尺子红）。
   ⑧ 跨页「拿去生成」的载荷（sk_reuse）：写入恰好 1 处且在 workbench.js，读 / 删恰好 2 处且都在
      studio.html，Wb.reuse.go 至少被调 3 次。三页（资产库 / 收藏 / 素材库）以前各拼一份 JSON、
      各写一遍地址，而消费端只认平台资产号 —— 素材库那张图只有本机地址、收藏里的本地文件只有
      IndexedDB 号，两边递过去的 assetId 都是空，于是拼出 `/asset/undefined`、取字节必然 404，
      而界面只留一句「已复用提示词」，素材根本没进槽这件事在界面上看不出来。
      **第三头（被调次数）不是凑数**：只查「写入一份」的话，把三页的入口全拆掉它照样全绿。 */
  const apiKeys = new Set();
  if (exists('workbench.js')) {
    const rw = lex(read('workbench.js'), 1);
    if (rw.err) bad('§J', 'workbench.js 扫描器读不完：' + rw.err + '（pager 面的判据坏了）');
    else {
      const W = rw.toks;
      for (let k = 0; k + 2 < W.length; k++) {
        if (!(W[k].t === 'id' && W[k].v === 'api' && W[k + 1].t === 'p' && W[k + 1].v === '='
          && W[k + 2].t === 'p' && W[k + 2].v === '{')) continue;
        let d = 0;
        for (let j = k + 2; j < W.length; j++) {
          const u = W[j];
          if (u.t === 'p' && u.v === '{') { d++; continue; }
          if (u.t === 'p' && u.v === '}') { d--; if (d === 0) break; continue; }
          if (d !== 1 || u.t !== 'id') continue;
          const pv = W[j - 1], nx = W[j + 1];
          const isStart = pv && (pv.t === 'p' ? (pv.v === '{' || pv.v === ',')
            : pv.t === 'id' && (pv.v === 'async' || pv.v === 'get' || pv.v === 'set'));
          if (!isStart) continue;
          if ((u.v === 'async' || u.v === 'get' || u.v === 'set') && nx && nx.t === 'id') { apiKeys.add(nx.v); continue; }
          if (nx && nx.t === 'p' && (nx.v === '(' || nx.v === ':' || nx.v === ',' || nx.v === '}')) apiKeys.add(u.v);
        }
        break;
      }
      if (apiKeys.size < 8)
        bad('§J', '从 workbench.js 只提出 ' + apiKeys.size + ' 个 pager 方法名（实测 11 个，少于 8 就是提法坏了）：'
          + [...apiKeys].join(','));
    }
  } else bad('§J', '读不到 workbench.js —— pager 面判据没底座');

  for (const it of items) {
    if (!exists(it.f)) continue;
    const src = read(it.f);
    const segs = it.html
      ? Array.from(src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
        .filter(x => x[1].trim()).map(x => ({ code: x[1], base: lineAt(src, x.index) }))
      : [{ code: src, base: 1 }];
    for (const seg of segs) {
      CUR_FILE = it.f;
      const r = lex(seg.code, seg.base);
      if (r.err) { bad('§J', it.f + ' 扫描器读不完：' + r.err + '（判据坏了，不是页面坏了）'); continue; }
      scanned++;
      const T = r.toks;
      /* ⑦-b 这一段里「= Wb.pager.create(...)」的那个变量名（三个页面都叫 pager，但按段现认，不写死） */
      const inst = new Set();
      for (let k = 0; k + 6 < T.length; k++)
        if (T[k].t === 'id' && T[k + 1] && T[k + 1].v === '=' && T[k + 2] && T[k + 2].v === 'Wb'
          && T[k + 3] && T[k + 3].v === '.' && T[k + 4] && T[k + 4].v === 'pager'
          && T[k + 5] && T[k + 5].v === '.' && T[k + 6] && T[k + 6].v === 'create') inst.add(T[k].v);
      for (let k = 0; k < T.length; k++) {
        const t = T[k], nx = T[k + 1], pv = T[k - 1];
        /* ① 定义那处的下一个 token 也是 '('，所以要先排掉前面是 function 的那一次 */
        if (t.t === 'id' && t.v === 'b64Bytes' && nx && nx.v === '(') {
          if (pv && pv.t === 'id' && pv.v === 'function') { defs++; defSites.push(it.f + ':' + t.line); }
          else calls++;
        }
        if (t.t === 'id' && (t.v === 'showSaveFilePicker' || t.v === 'showDirectoryPicker')) {
          pickers++; pickerSites.push(it.f + ':' + t.line + ' ' + t.v);
        }
        if (it.html && t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && nx.v === 'toast') {
          toastDefs++; toastSites.push(it.f + ':' + t.line);
        }
        if (it.html && t.t === 'id' && t.v === 'IntersectionObserver' && nx && nx.v === '(') {
          ioInPage++; ioSites.push(it.f + ':' + t.line);
        }
        if (t.t === 'p' && t.v === '[' && T[k + 1] && T[k + 1].s === 'B' && T[k + 3] && T[k + 3].s === 'KB'
          && T[k + 5] && T[k + 5].s === 'MB' && T[k + 7] && T[k + 7].s === 'GB') {
          unitSites.push(it.f + ':' + t.line);
          if (it.f === 'workbench.js') unitInWb++;
        }
        /* ② 芯片行：页面里不许再自己拼一颗 .chip 出来。
           指纹用词法器取的字符串/模板串**内容**，不是正则扫源码 ——
           旧写法有两种，模板串里 class="chip${…}" 与 className = 'chip' + …，
           而正文里讲这件事的注释、.ai-chip / .ap-chip 这些别的类名都不该被算进来。
           （'ai-chip' 不匹配 class=["']chip，因为它多了一段前缀。） */
        if (it.html && (t.t === 'tpl' || t.t === 'str')) {
          const sc = t.s || '';
          /* 第二支要回看**两个** token：b.className = 'chip' 里，'chip' 前面是「=」，
             className 在再前面一个。只看紧邻那个就永远匹配不上（这类「差一位」的红/绿都别当结论）。 */
          const pv2 = T[k - 2];
          if (/class(Name)?\s*=\s*["'`]chip/.test(sc)
            || (t.t === 'str' && sc === 'chip' && pv2 && pv2.t === 'id' && pv2.v === 'className')) {
            chipRows++; chipRowSites.push(it.f + ':' + t.line);
          }
        }
        /* 芯片行的公共实现：window.Chips 一份定义 + 页面若干调用，两头都得在（少一头就是尺子坏了）。
           注意两种写法的邻居不一样：调用是 Chips.render（`.` 在**后**），
           定义是 window.Chips = {（`.` 在**前**）—— 一开始只看了后面那个，
           于是定义数恒为 0，还差点把「定义没了」当成正常。 */
        if (t.t === 'id' && t.v === 'Chips') {
          if (nx && nx.t === 'p' && nx.v === '.') {
            const nx2 = T[k + 2];
            if (nx2 && nx2.t === 'id' && nx2.v === 'render') { chipsCalls++; chipsCallSites.push(it.f + ':' + t.line); }
          } else if (pv && pv.t === 'p' && pv.v === '.' && nx && nx.t === 'p' && nx.v === '='
            /* 定义只认**挂在 window 上的**那个（`window.Chips = {` / 顶层裸赋值 `Chips = {`）。
               不看这一点就会把「往一个对象上挂一个同名属性」（注入的执行环境里
               `P.Chips = mod('Chips')` 就是这么写的）数成第二个定义 ——
               那不是实现，只是把手里的东西递出去。 */
            && onWindow(T[k - 2])) {
            chipsDefs++; chipsDefSites.push(it.f + ':' + t.line);
          }
        }
        /* ⑧ 跨页复用的载荷：认「(setItem|getItem|removeItem|readLS)\s*(\s*'sk_reuse'」这一串 token。
           用词法器而不是正则，是因为 ui.js 的 NOT_SYNC 名单里也点名了 'sk_reuse'（那是**同步**的事，
           不是读写），正则扫全文会把它一起算进来；而它长成 `…, 'sk_reuse', …`，前驱是 ','，天然不匹配。 */
        if (t.t === 'id' && (t.v === 'setItem' || t.v === 'getItem' || t.v === 'removeItem' || t.v === 'readLS')
          && nx && nx.t === 'p' && nx.v === '(') {
          const nx2 = T[k + 2];
          if (nx2 && nx2.t === 'str' && nx2.s === 'sk_reuse') {
            if (t.v === 'setItem') { reuseWrite++; reuseWriteSites.push(it.f + ':' + t.line); }
            else { reuseRead++; reuseReadSites.push(it.f + ':' + t.line + ' ' + t.v); }
          }
        }
        if (t.t === 'id' && t.v === 'reuse' && pv && pv.t === 'p' && pv.v === '.'
          && nx && nx.t === 'p' && nx.v === '.' && T[k + 2] && T[k + 2].t === 'id' && T[k + 2].v === 'go') {
          reuseGoCalls++;
        }
        /* ⑨ 本机落盘链：认「AssetLocal . 方法」这一串 token（`.` 在后，与 Chips 那一档同一形状）。
           注释里那句「落盘走 AssetLocal.pull」不算 —— 词法器剥注释，两个页面的说明文字正好用它讲这件事。 */
        if (t.t === 'id' && t.v === 'AssetLocal' && nx && nx.t === 'p' && nx.v === '.') {
          const m = T[k + 2], open = T[k + 3];
          if (m && m.t === 'id' && open && open.t === 'p' && open.v === '(') {
            if (m.v === 'pull') { dlPull++; dlPullSites.push(it.f + ':' + t.line); }
            else if (m.v === 'hideAsCloud') { hideCalls++; hideCallSites.push(it.f + ':' + t.line); }
            else if (m.v === 'hasLocalAddr') { addrCalls++; addrCallSites.push(it.f + ':' + t.line); }
          }
        }
        if (t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && nx.v === 'hideAsCloud') {
          hideDef++; hideDefSites.push(it.f + ':' + t.line);
        }
        /* 字符串与模板串的**内容**里出现 /local-assets 才算页面自己拼了那条路由；
           正文注释里那三处（studio.html 讲 base64、讲本机资产库来源、讲十六进制）不在这里。 */
        if (it.html && (t.t === 'str' || t.t === 'tpl') && String(t.s || '').indexOf('/local-assets') >= 0) {
          rawLocalInPage++; rawLocalSites.push(it.f + ':' + t.line);
        }
        /* ⑩ 「就地二次确认」的实现处数。全站只许 ui.js 的 Confirm.arm 一份
             （后果说明 / Esc 取消 / 点别处取消 / 整页唯一 / 5 秒窗口，五件事都在那一份里）。
             这一档是被 L5 逼出来的：导演台自己写过一份 armConfirm、资产库内联抄过第三份，
             两份都**少了护栏**，最缺护栏的那份还允许同时点亮两颗删除按钮、两颗一起执行。
             判据抓两件事：`window.Confirm = {` 这个**唯一定义点**必须恰好 1 处（在 ui.js），
             以及 `Confirm.arm(` 的调用点至少若干处 —— 只查定义的话，
             「页面全改回手搓」与「判据坏了」长得一模一样。
             另外扫页面里 `dataset.armed` 那一串字符串：那是自建实现的指纹，
             ui.js 的 Confirm 自己内部也会写（paintArmed），所以只算 `*.html` 里的。 */
        if (t.t === 'id' && t.v === 'Confirm') {
          if (nx && nx.t === 'p' && nx.v === '.') {
            const nx2 = T[k + 2];
            if (nx2 && nx2.t === 'id' && nx2.v === 'arm') { armCalls++; armCallSites.push(it.f + ':' + t.line); }
          } else if (pv && pv.t === 'p' && pv.v === '.' && nx && nx.t === 'p' && nx.v === '='
            && onWindow(T[k - 2])) {      // 同上：只看 window.Confirm = {...} 那一个
            armDef++; armDefSites.push(it.f + ':' + t.line);
          }
        }
        /* 指纹：页面自建的那份实现必然有个**自己的函数**（director.html 叫 armConfirm、
           资产库内联那份没有名字但会先点亮一个 dataset标记）。
           函数名这一条比字符串可靠：`dataset.armed` 在词法器里是属性访问，不产生 str token，
           按字符串扫会把真的手搓实现也放过（实测注进去照样全绿 —— 那就是一把坏尺子）。
           所以这里盯住**「页面里定义了一个名字里带 confirm / armConfirm 的确认函数」**：
           这类名字在全项目只应该出现在 ui.js 的 Confirm 组件注释里，页面里出现即是分叉。
           反向对照：往 drama.html 里塞一个 `function armConfirm(){}`，本档必须报红。 */
        if (it.html && t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && /confirm/i.test(nx.v)) {
          armInline++; armInlineSites.push(it.f + ':' + t.line + ' function ' + nx.v);
        }
        /* ⑪ 资产合并只有一份：`.assets =` 右边出现 Object.assign 就是摊成字典那一份实现。
             判据选 `Object.assign` 而不是 `mergeAssetLists` 的调用数 ——
             摊字典这件事在别的名字下也能写出来（spread 也一样），盯住那个调用更耐改。
             drama.js / drama.html 两处正文里都写着「以前是 Object.assign」，
             词法器剥注释，所以说明文字不会把自己照红。 */
        if (t.t === 'id' && t.v === 'Object' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && T[k + 2].v === 'assign'
          && T[k - 1] && T[k - 1].t === 'p' && T[k - 1].v === '.') {
          const p = T[k - 1], pk = k - 2;
          if (p && pk && T[pk] && T[pk].t === 'id' && T[pk].v === 'assets') {
            assetMerge++; assetMergeSites.push(it.f + ':' + t.line);
          }
        }
        /* 反向对照：`Cast.mergeAssetLists` / `D.Cast.mergeAssetLists` 的调用点数 */
        if (t.t === 'id' && t.v === 'mergeAssetLists') mergeCalls++;
        /* ⑦-c 对 pager 实例的成员访问：名字必须在那张现取的 api 面上。
           `Wb.pager.sentinel(...)` 这种**静态面**要排掉（它的前驱是 '.'，而 `pager` 恰好也是实例名）。
           注释里写的 `pager.fill(...)` 不算 —— 这一档上线时 studio.html 就有一句正在讲它坏在哪，
           词法器剥注释，所以说明文字不会把自己照红（与 ③ 同一套路）。 */
        if (t.t === 'id' && inst.has(t.v) && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && !(pv && pv.t === 'p' && pv.v === '.')) {
          pagerCalls++;
          if (apiKeys.size >= 8 && !apiKeys.has(T[k + 2].v)) {
            pagerOff++;
            pagerOffSites.push(it.f + ':' + t.line + ' pager.' + T[k + 2].v);
          }
        }
      }
    }
  }
  if (!scanned) { bad('§J', '一段源码都没扫到 —— 空断言比没有断言更坏'); return 0; }

  if (defs !== 1) bad('§J', 'b64Bytes 的定义有 ' + defs + ' 处（' + (defSites.join('、') || '一处都没有') + '）—— base64→字节只许一份');
  else if (defSites[0].split(':')[0] !== 'ui.js') bad('§J', 'b64Bytes 的唯一定义在 ' + defSites[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (calls < 4) bad('§J', 'b64Bytes 只被调 ' + calls + ' 次（应至少 4：ui.js 的 DataSync、assetlib.js、drama.js、director.html）—— 有一处改回了内联写法');
  if (pickers) bad('§J', '又用了「下载落点」那两个选择器：' + pickerSites.join('、') + ' —— 那一层已删，全站只剩 Net.save 一份（注释里提到不算）');
  if (toastDefs) bad('§J', '页面又自建了 toast()：' + toastSites.join('、') + ' —— 提示组件只有 ui.js 的 window.Toast 一份');
  if (ioInPage) bad('§J', '页面又自建了续拉：' + ioSites.join('、') + ' —— 页面级续拉走 Wb.pager.sentinel（模块内那几处是允许的）');
  if (unitInWb) bad('§J', 'workbench.js 里又出现了字节单位数组 —— Wb.fmtSize 必须委托 window.fmtBytes，函数体只留一份');
  const unitFiles = [...new Set(unitSites.map(s => s.split(':')[0]))].sort();
  if (unitFiles.join(',') !== 'assets.html,ui.js')
    bad('§J', '字节单位数组出现在 ' + (unitSites.join('、') || '没有') + ' —— 期望只有 ui.js 与 assets.html 两处（后者守卫不同，是有意的分叉）');
  if (chipRows) bad('§J', '页面又自己拼了芯片行：' + chipRowSites.join('、') + ' —— 芯片行只有 ui.js 的 window.Chips 一份');
  /* 两头都要在：页面 0 处自建**且** Chips 有定义有调用。少一头就是尺子坏了，
     而「0 处自建」在 Chips 也没了的情况下和「真的一处都没有」长得一模一样。 */
  if (chipsDefs !== 1) bad('§J', 'window.Chips 的定义有 ' + chipsDefs + ' 处（' + (chipsDefSites.join('、') || '一处都没有') + '）—— 芯片行只许一份');
  else if (chipsDefSites[0].split(':')[0] !== 'ui.js') bad('§J', 'window.Chips 的唯一定义在 ' + chipsDefSites[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (chipsCalls < 4) bad('§J', 'window.Chips.render 只被调 ' + chipsCalls + ' 次（应至少 4：资产库 3 行、角色库、收藏、用量）—— 有一处改回了自己拼');
  /* ⑦ 两头：调用点全在面上，**且**确实看到了 18 处访问（先量过：studio 10 / chars 4 / favorites 4）。
     只有前一条的话，把 `inst` 那一段认坏了（一个实例名都收不到）就等于「全过」。 */
  if (pagerOff) bad('§J', '页面调了 Wb.pager.create() 返回值上**没有**的方法：' + pagerOffSites.join('、')
    + ' —— 调用点要是套着 try/catch，TypeError 会被静默吞掉，那条路一次都跑不到（studio.html 的 pager.fill 就是）');
  if (pagerCalls < 18) bad('§J', '只看到 ' + pagerCalls + ' 处对 pager 实例的成员访问（先量过的是 18 处：studio 10 / chars 4 / favorites 4）—— 少一头就是判据或调用点坏了');
  /* ⑧ 三头都要在：写的人一份、读的人一份、**且**真看到 3 个页面在递载荷。
     少了第三头，「一份写入点」会因为三页全被改成不递素材而照样全绿 —— 那正是这一档要防的反面。 */
  if (reuseWrite !== 1) bad('§J', '往 localStorage 写 sk_reuse 的地方有 ' + reuseWrite + ' 处（'
    + (reuseWriteSites.join('、') || '一处都没有') + '）—— 跨页复用的载荷只许 workbench.js 的 Wb.reuse.go 一份，页面自己拼就会各漏一种地址带法');
  else if (reuseWriteSites[0].split(':')[0] !== 'workbench.js')
    bad('§J', 'sk_reuse 的唯一定义在 ' + reuseWriteSites[0] + '，不在 workbench.js —— 判据和实现脱节了');
  const readFiles = [...new Set(reuseReadSites.map(s => s.split(':')[0]))];
  if (reuseRead !== 2 || readFiles.join(',') !== 'studio.html')
    bad('§J', '读 / 删 sk_reuse 的地方是 ' + (reuseReadSites.join('、') || '没有') + ' —— 期望 studio.html 两处（读出一次 + 用完即删），'
      + '消费端多一处就会把同一条载荷读两遍、第二遍是空的');
  if (reuseGoCalls < 3) bad('§J', 'Wb.reuse.go 只被调 ' + reuseGoCalls + ' 次（先量过的是 3 次：资产库 / 收藏 / 素材库）'
    + ' —— 有一页的「拿去生成」又退回自己拼载荷，或压根没了入口');
  /* ⑨ 三头都要在，而且**两头是「恰好」**：这一档防的是「长第二份」，
     所以既不能少（把某一页的按钮改成自己 POST）也不能多（第三页偷偷也藏云端成品）。 */
  if (dlPull !== 2) bad('§J', 'AssetLocal.pull 的调用点是 ' + (dlPullSites.join('、') || '一处都没有')
    + ' —— 期望恰好 2 处（收藏 #pullBtn / 素材库 #btnLocal 各一颗）：手动落盘只有这一条链，'
    + '多出的一处多半是自己 POST /local-assets，会绕过身份判据与去重');
  const pullFiles = [...new Set(dlPullSites.map(s => s.split(':')[0]))].sort();
  if (dlPull === 2 && pullFiles.join(',') !== 'chars.html,favorites.html')
    bad('§J', '两颗「自动下载」落在 ' + pullFiles.join(',') + ' —— 期望是收藏页与素材库这两页');
  if (hideDef !== 1) bad('§J', 'hideAsCloud 的定义有 ' + hideDef + ' 处（' + (hideDefSites.join('、') || '一处都没有')
    + '）—— 「不显示云端任务」的判据只许 assetlib.js 的 AssetLocal 一份');
  else if (hideDefSites[0].split(':')[0] !== 'assetlib.js')
    bad('§J', 'hideAsCloud 的唯一定义在 ' + hideDefSites[0] + '，不在 assetlib.js —— 判据和实现脱节了');
  const hideFiles = [...new Set(hideCallSites.map(s => s.split(':')[0]))].sort();
  if (hideCalls !== 3 || hideFiles.join(',') !== 'assets.html,studio.html')
    bad('§J', 'AssetLocal.hideAsCloud 的调用点是 ' + (hideCallSites.join('、') || '没有')
      + ' —— 期望 studio.html 两处 + assets.html 一处，且只在这两页：收藏 / 素材库故意不藏');
  /* 两处：收藏与素材库那两颗「自动下载」按钮各问一次。
     原来还有第三处（拍短剧页 chooseBgm 选完配乐后问一次，E-52），
     2026-10 拍短剧页整体删除，随之只剩这两处 —— 数字随之从 3 改成 2，不是判据放宽。
     少于 2 说明某一处改成了自己判，多于 2 说明有人在别处也写了一份
     「有没有本机副本」（那正是这一档要防的）。 */
  if (addrCalls !== 2) bad('§J', 'AssetLocal.hasLocalAddr 只被调 ' + (addrCallSites.join('、') || '一次都没有')
    + ' —— 期望两处各问一次（收藏 / 素材库）；「本机有没有这份字节」的判据也只许这一份');
  if (rawLocalInPage) bad('§J', '页面又自己拼了 /local-assets：' + rawLocalSites.join('、')
    + ' —— 落盘只有公共那两个口（页面的手动按钮走 AssetLocal.pull，模块走 Api.saveLocalAsset），'
    + '页面自己拼路由等于绕过那一道按身份的去重');
  /* ⑩ 两头都要在：定义恰好 1 处（在 ui.js）**且**页面里确实看到若干处调用。
     只查定义的话，「全站一处调用都没有」与「判据坏了」长得一模一样。 */
  if (armDef !== 1) bad('§J', '「就地二次确认」的实现有 ' + armDef + ' 处（' + (armDefSites.join('、') || '一处都没有')
    + '）—— 只许 ui.js 的 Confirm.arm 一份；页面自建的那份少了护栏（Esc 不取消、点别处不取消、无后果说明）');
  else if (armDefSites[0].split(':')[0] !== 'ui.js')
    bad('§J', 'Confirm.arm 的唯一定义在 ' + armDefSites[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (armInline) bad('§J', '页面里又自建了确认函数：' + armInlineSites.join('、')
    + ' —— 就地二次确认只许 ui.js 的 Confirm.arm 一份（后果说明 / Esc / 点别处 / 整页唯一都在它那儿）');
  if (armCalls < 5) bad('§J', 'Confirm.arm 只被调 ' + armCalls + ' 处（应至少 5：导演台四处 + 资产库一处）'
    + ' —— 要么有页面改回了手搓，要么这一档的调用点识别坏了');
  /* ⑪ 同两头：0 处自摊 + mergeAssetLists 确实在用。 */
  if (assetMerge) bad('§J', '又用 Object.assign 摊资产：' + assetMergeSites.join('、')
    + ' —— 资产是**列表**，摊成字典后 Array.isArray 为false，每一张图都变成「读不到」。改调 Cast.mergeAssetLists');
  if (!mergeCalls) bad('§J', 'Cast.mergeAssetLists 一处调用都没看到 —— 「资产合并只有一份」这把尺子不成立');
  /* ⑫ 「按 id 找平台」不许兜底到别家。导演台的 provOf 以前是
        `find(按 id) || find(kind==='video') || {假平台}` —— 认不出就默默取第一家视频平台，
        于是「模型属于 A、请求发给了 B」。项目里两家视频平台的型号 id 形状不同
        （h3-video vs minimax/h3），上游校验 model must match xxx/yyy，
        那个看不懂的报错就是这么来的，而界面上型号那一栏明明选的是 A。
     判据：出现「find(...) || find(... kind ...)」这种**跨类型兜底**就报红。 */
  const fallbacks = [];
  for (const it of items) {
    const src = read(it.f);
    if (!src) continue;
    for (const m of src.matchAll(/\|\|\s*(?:list|[A-Za-z_$][\w$]*)\.find\(\s*\w+\s*=>\s*\w+\.kind\s*===\s*'/g)) {
      fallbacks.push(it.f + ':' + lineAt(src, m.index));
    }
  }
  /* ⑬ 提交体的 `model` 必须是**型号 id 字符串**——那道闸必须在（assetlib.js 的 createBody 里）。
     为什么写成「闸存在性」而不是扫每处调用点：调用点的形状太多
     （`model: model.id` / `model: t.model` / `model: fields.model` 都可能是对的），
     静态认不出来；而这里的判据是明确的 —— 「传对象要在发出去之前被拦下」。
     这一条拦的正是工作台视频那一路的 bug：图片那一路写 `model.id`（对）、
     视频那一路写裸 `model`（错），上游收到对象后回的是「model must be a string」，
     与用户在界面上做的事毫无关系。 */
  let gate = 0;
  {
    const src = read('assetlib.js');
    if (/typeof\s+f\.model\s*!==\s*'string'/.test(src)) gate = 1;
  }
  if (!gate) bad('§J', 'assetlib.js 的 createBody 里没有「model 必须是字符串」那道闸 —— '
    + '去掉它之后，页面把模型**对象**顺手传进来时会一路发到上游，'
    + '换回一句「model must be a string / must match xxx/yyy」，而那句话与用户的操作毫无关系');

  if (fallbacks.length) bad('§J', '按 id 找平台时兜底到了别家：' + fallbacks.join('、')
    + ' —— 认不出平台要**停下并说清**（用户在设置页重新勾一下即可），不能默默发给另一家：'
    + '型号形状不同会让上游报一个与操作无关的格式错误');

  /* ⑭ 「AdvParams 那四档之外」的三排声明驱动控件（型号布尔参数 / create.topBools / create.shapeFields）
        的**判据 + 画法 + 读回**只有 `assetlib.js` 的 `AdvExtras` 一份。
     为什么单独钉这一档：导演台以前整块没有这三排 —— 同一个平台在生成工作台能勾「平台自动润色」
     「Turbo 档」「超分」「种子」，在这一镜上连控件都不画、提交体里一个字都不发（本轮补上）。
     补完之后最容易复发的形状是「页面各自再写一份判据」：两份 hide/need 判断迟早漂开，
     表现就是「界面已经把开关画出来了、提交体却把它漏掉」，而两边各判一半比都不判更难查。 */
  let advDef = 0; const advDefSites = [], advCloneSites = [];
  for (const it of items) {
    const src = read(it.f);
    if (!src) continue;
    for (const m of src.matchAll(/window\.AdvExtras\s*=\s*\{/g)) {
      advDef++; advDefSites.push(it.f + ':' + lineAt(src, m.index));
    }
    if (!it.html) continue;
    /* 页面里再写一份同名的判据 = 第二份实现（这些名字都是公共层那一份的语义，页面不该再有定义） */
    for (const m of src.matchAll(/function\s+(topBoolStateOf|shapeFieldStateOf|topBoolDecls|shapeFieldDecls|topBoolParams|shapeFieldParams|shapeFieldsSummary|shapeFieldBad)\s*\(/g)) {
      /* 注释行里提到的不算（「以前这里叫 topBoolStateOf」这类说明句很常见）。
         调公共层那一份 `window.AdvExtras.topBoolStateOf(` 也不算 —— 正则本来就要求 `function` 开头。 */
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lead = src.slice(lineStart, m.index).trim();
      if (/^(\/\/|\*|\/\*)/.test(lead)) continue;
      advCloneSites.push(it.f + ':' + lineAt(src, m.index) + ' ' + m[1]);
    }
  }
  if (advDef !== 1) bad('§J', '`window.AdvExtras = {` 的定义有 ' + advDef + ' 处（应恰好 1 处）'
    + (advDefSites.length ? '：' + advDefSites.join('、') : '')
    + ' —— 三排声明驱动控件的判据、画法、读回只许公共层那一份');
  else if (!advDefSites[0].startsWith('assetlib.js')) bad('§J',
    'AdvExtras 的唯一定义在 ' + advDefSites[0] + '，不在 assetlib.js —— 判据和实现脱节了');
  if (advCloneSites.length) bad('§J', '页面又自己写了一份三排控件的判据：' + advCloneSites.join('、')
    + ' —— 公共层那份（AdvExtras.topBoolStateOf / shapeFieldStateOf / *Decls / read）就是为这个而存在的；'
    + '两份判据迟早漂开，漂开的表现是「界面画出了开关、提交体里没有那一项」');
  /* 两头都要真的在用：只查定义数的话，某一页整块退回私有实现也能全绿 */
  const advReaders = items.filter(it => it.html && /AdvExtras\.read\(/.test(read(it.f) || '')).map(it => it.f);
  const advDoms = items.filter(it => it.html && /AdvExtras\.boolsFromDom\(/.test(read(it.f) || '')).map(it => it.f);
  ['director.html', 'studio.html'].forEach(f => {
    if (!advReaders.some(x => x.endsWith(f))) bad('§J', f + ' 没有走 `AdvExtras.read(` 读那三排的提交参数 —— '
      + '它要么退回了自己拼 params（顶层开关与形状字段就发不出去），要么整块没有这三排（导演台本轮修掉的就是这一种）');
    if (!advDoms.some(x => x.endsWith(f))) bad('§J', f + ' 的型号布尔那一排没有走 `AdvExtras.boolsFromDom(` —— '
      + '页面自己扫一遍 [data-bool] 就等于第二份读法，而它分不清「这一排属于当前类型」');
  });

  if (red === red0) ok('§J', '扫了 ' + scanned + ' 段源码：b64Bytes 定义 ' + defs + ' 处（被调 ' + calls + ' 次）、落点选择器 '
    + pickers + ' 处、页面自建 toast ' + toastDefs + ' 处、页面自建续拉 ' + ioInPage + ' 处、字节单位数组 ' + unitSites.length
    + ' 处、页面自建芯片行 ' + chipRows + ' 处（Chips 定义 ' + chipsDefs + ' / 被调 ' + chipsCalls
    + '）、pager 实例成员访问 ' + pagerCalls + ' 处（面上 ' + apiKeys.size + ' 个名字，越界 ' + pagerOff
    + ' 处）、跨页复用载荷写入 ' + reuseWrite + ' 处 / 读取 ' + reuseRead + ' 处 / Wb.reuse.go ' + reuseGoCalls + ' 处'
    + ' ⑨落盘链：pull ' + dlPull + ' 处、hideAsCloud 定义 ' + hideDef + ' / 调用 ' + hideCalls
    + ' 处、hasLocalAddr ' + addrCalls + ' 处、页面自拼 /local-assets ' + rawLocalInPage + ' 处'
    + ' ⑩就地确认：Confirm.arm 定义 ' + armDef + ' / 调用 ' + armCalls + ' / 页面手搓 ' + armInline
    + ' 处、⑪资产合并：Object.assign 摊字典 ' + assetMerge + ' 处（mergeAssetLists 被调 ' + mergeCalls + ' 次）'
    + '、⑭三排声明驱动控件：AdvExtras 定义 ' + advDef + ' 处 / 页面自写判据 ' + advCloneSites.length
    + ' 处 / 走公共读回的页面 ' + advReaders.length + ' 个');
  return defs + calls;
}
/* ================= §K =================
   「页面不重复定义 ui.css 已经有的规则」—— 把这一轮删掉的 7 处冗余钉住。

   判定口径比「两条文字长得一样」宽一档，也比它严一档：
     · 宽：算**子集**。页面写的每一条属性只要 ui.css 里以**同样的值**有，就算冗余。
       （`.task .timg img` 页面只写 width/height/object-fit，ui.css 那条还有一条 display:block，
        照样是冗余 —— display:block 本来就已经在生效，删掉页面那份什么都不变。
        只认「逐字相同」的话这类一个都漏 —— 本轮 7 处里只有 2 处是逐字相同。）
     · 严：**@media 上下文必须相同**。页面那条在 @media 里、公共那条在顶层时两边作用范围不同，
       删掉页面那份就会改掉小屏表现。所以键里带 at-rule 栈。
     · 值写错一位就**不算**冗余（那是分叉，要人拍板，不归这一档管）。
   期望值 0 —— 期望表是量出来的：刚删完那 7 处重跑仍是 0。
   这一档自带一个反向对照（见 tests/mutation.cjs）：同一条规则放进 @media 里、或值改一位，都该放行；
   没有那条对照的话，「§K 什么都报」和「§K 什么都不报」在驱动脚本里长得一模一样。 */
function cssStripComments(css) {
  let out = '', i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const seg = css.slice(i, end < 0 ? css.length : end + 2);
      for (const ch of seg) out += (ch === '\n' ? '\n' : '');   /* 换行占位：行号是这档的证据 */
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    out += css[i++];
  }
  return out;
}
function cssDecls(body) {
  const parts = []; let cur = '', d = 0, q = '';
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') { d++; cur += ch; continue; }
    if (ch === ')') { d--; cur += ch; continue; }
    /* cur 必须清空：忘了清空的话所有声明累积成一个字符串，第一条属性会吃掉后面全部内容，
       于是多声明规则永远判不出「已被覆盖」——读数会**假成 0**，看着干净反而最该怀疑。 */
    if (ch === ';' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = new Map();
  for (const p of parts) {
    const k = p.indexOf(':');
    if (k < 0) continue;
    const prop = p.slice(0, k).trim().toLowerCase();
    if (prop) out.set(prop, p.slice(k + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}
function cssRules(css, off, media) {
  const out = [];
  let i = 0;
  const lineAt = o => off + css.slice(0, o).split('\n').length - 1;
  const block = start => {                       /* 括号感知的花括号配平：字符串/属性选择器里的括号不算 */
    let d = 1, j = start;
    while (j < css.length && d > 0) {
      const c = css[j];
      if (c === '(' || c === '[') { const close = c === '(' ? ')' : ']'; j++; let q = ''; while (j < css.length && css[j] !== close) { if (css[j] === '"' || css[j] === "'") { q = css[j]; j++; while (j < css.length && css[j] !== q) j++; } j++; } j++; continue; }
      if (c === '"' || c === "'") { const q = c; j++; while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; } j++; continue; }
      if (c === '{') d++;
      else if (c === '}') d--;
      j++;
    }
    return [start, j - 1];
  };
  while (i < css.length) {
    let k = i;                                   /* 先跳过规则之间的空白与残留分号 ——
                                                    不跳的话 i 停在**上一条规则的收尾花括号**上，
                                                    行号会少算「规则之间空了几行」 */
    while (k < css.length && (css[k] === ' ' || css[k] === '\n' || css[k] === '\t' || css[k] === '\r' || css[k] === ';')) k++;
    if (k >= css.length) break;
    i = k;
    if (css[i] === '}') { i++; continue; }
    const braceAt = css.indexOf('{', i);
    if (braceAt < 0) break;
    const sel = css.slice(i, braceAt).trim();
    const [bs, be] = block(braceAt + 1);
    const ln = lineAt(i);
    if (sel.charAt(0) === '@') {
      if (sel.indexOf('@keyframes') < 0 && sel.indexOf('@font-face') < 0) {
        const inner = sel.indexOf('(') > 0 ? sel.slice(sel.indexOf('(') + 1, sel.lastIndexOf(')')).trim() : '';
        out.push(...cssRules(css.slice(bs, be), ln, (media ? media + ' && ' : '') + sel.split('(')[0] + (inner ? '(' + inner + ')' : '')));
      }
    } else out.push({ sel: sel, body: css.slice(bs, be), line: ln, media: media || '' });
    i = be + 1;
  }
  return out;
}
function sectionK() {
  const red0 = red;
  if (!targets.html.length) { bad('§K', '没指定页面，这一档不成立'); return 0; }
  if (!exists('ui.css')) { bad('§K', 'ui.css 不在，这一档不成立'); return 0; }

  const map = new Map();                          /* "at-rule 栈||选择器" -> [{file,line,decls}] */
  const eat = (css, file) => {
    const clean = cssStripComments(css);
    const chunks = [];
    if (file.endsWith('.css')) chunks.push({ css: clean, off: 1 });
    else {
      let at = 0;
      while (true) {
        const a = clean.indexOf('<style>', at);
        if (a < 0) break;
        const b = clean.indexOf('</style>', a);
        if (b < 0) break;
        chunks.push({ css: clean.slice(a + 7, b), off: clean.slice(0, a).split('\n').length });
        at = b + 8;
      }
    }
    for (const ch of chunks) for (const r of cssRules(ch.css, ch.off, '')) {
      for (const one of r.sel.split(',')) {         /* `.a,.b{…}` 只写一次算一份 */
        const sel = one.trim().replace(/\s+/g, ' ');
        if (!sel) continue;
        const key = r.media + '||' + sel;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ file: file, line: r.line, decls: cssDecls(r.body) });
      }
    }
  };
  eat(read('ui.css'), 'ui.css');
  for (const f of targets.html) if (exists(f)) eat(read(f), f);

  let pairs = 0, hits = 0;
  const where = [];
  for (const [key, list] of map) {
    const cs = list.filter(x => x.file === 'ui.css');
    if (!cs.length) continue;
    const cm = cs[0].decls;
    for (const p of list) {
      if (p.file === 'ui.css' || !p.decls.size) continue;
      pairs++;
      let covered = true;
      for (const [prop, val] of p.decls) {
        if (!cm.has(prop) || cm.get(prop) !== val) { covered = false; break; }
      }
      if (covered) { hits++; where.push(p.file + ':' + p.line + ' 的 ' + key.split('||')[1] + (key.split('||')[0] ? '（@' + key.split('||')[0] + ' 里）' : '')); }
    }
  }
  if (!pairs) { bad('§K', '一对都没比上 —— 解析器多半坏了（空断言比没有断言更坏）'); return 0; }
  if (hits) bad('§K', '页面里有 ' + hits + ' 条规则 ui.css 已经全有，重复写一遍只会两边慢慢漂掉：\n       ' + where.slice(0, 6).join('\n       '));

  if (red === red0) ok('§K', '比了 ' + pairs + ' 对（公共里有、页面也写了同一个选择器的规则），页面没有一条是 ui.css 已经全有的');
  return hits;
}
/* 跑全套是命令入口才做的事；被 require 时只导出下面那台词法扫描器。

   为什么抽出来：文案 / 漏字检查的脚本需要**同一台**扫描器取字符串字面量，
   旁边再手写一个更差的（只跳过整行注释，313 行里绝大多数是跨行注释的正文），
   那就是「一个机制写两份」—— 而更差的那份会给出一份看起来很合理的读数。 */
/* ================= §L =================
   「只许用真有的浏览器 API」—— 这一档是被 `CSS.escape` 逼出来的。

   那一行写在助手的控件定位里（`labelOf` 找 label[for] 时用了
   `querySelector('label[for="' + CSS.escape(id) + '"]')`）。它读起来完全正常、
   语法检查也过，但 **`CSS.escape` 不是标准 API** —— 那一页一加载就抛
   `TypeError: CSS.escape is not a function`，于是**助手的三条 UI 原语全废**
   （点不到任何按钮），而页面上没有任何可见症状：只有控制台一条红字。
   这类错静态查不出来（它就是一个合法的成员访问），只有真跑起来才会炸，
   所以这一档按「名字本身就不在白名单里」来判。

   白名单是**真有的**那几十个（document / window / localStorage / fetch /
   requestAnimationFrame / getComputedStyle / CSS.escape 不在里面，见下）。
   反向对照：把 CSS.escape 换成 querySelectorAll 那种写法（浏览器有）就该放行。 */
/* 注意写法：名单里存的是**词法器认得出的几段**，不是一个整串。
   `CSS.escape` 在 token 流里是三个（`CSS` / `.` / `escape`），按整串去 indexOf 永远匹配不上 ——
   第一版就是这么写的，注回去实测**照样全绿**，一把不咬人的尺子比没有尺子更坏。
   判据照§C 那几档的形状：`['CSS', '.', 'escape']` 这样的 token 序列。 */
const BANNED_API = [
  [['CSS', '.', 'escape'], 'CSSOM 草案里的 API，实现极少（当年就在这里栽过：助手三条 UI 原语全废，界面上却什么都没有）—— 用 querySelectorAll("label[for]") 再按 getAttribute 比对'],
  [['CSS', '.', 'supports'], '这一页不需要特性检测；真要用先确认目标浏览器有'],
  [['structuredClone'], '不存在的全局（Node 有、浏览器没有）'],
];
function sectionL() {
  const red0 = red;
  const items = targets.js.map(f => ({ f, html: false })).concat(targets.html.map(f => ({ f, html: true })));
  const files = items.map(i => i.f).filter(exists);
  if (!files.length) { bad('§L', '一份源码都没读到 —— 判据本身坏了'); return 0; }
  const hits = [];
  let scanned = 0;
  for (const it of items) {
    const src = read(it.f);
    if (!src) continue;
    /* 页面要扫的是**内联脚本**（页面自己的 JS），模块文件扫全文。
       行号用 lineAt 换算成文件里的真行 —— 报一个脚本内偏移的号会让人以为解析跑偏。 */
    const units = it.html
      ? Array.from(src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
        .filter(x => x[1].trim()).map(x => ({ code: x[1], base: lineAt(src, x.index) }))
      : [{ code: src, base: 1 }];
    for (const u of units) {
      const r = lex(u.code, u.base);
      if (r.err) continue;
      scanned++;
      const T = r.toks;
      for (const [seq, why] of BANNED_API) {
        for (let k = 0; k + seq.length <= T.length; k++) {
          let eq = true;
          for (let j = 0; j < seq.length; j++) {
            const tk = T[k + j];
            const v = String(tk.s || tk.v || '');
            if (v !== seq[j]) { eq = false; break; }
          }
          if (eq) hits.push({ f: it.f, line: T[k].line, name: seq.join('.'), why });
        }
      }
    }
  }
  if (!scanned) { bad('§L', '一段源码都没扫到 —— 空断言比没有断言更坏'); return 0; }
  if (hits.length) {
    const byName = {};
    for (const h of hits) (byName[h.name] = byName[h.name] || []).push(h.f + ':' + h.line);
    const whyOf = n => { const b = BANNED_API.find(x => x[0].join('.') === n); return b ? b[1] : ''; };
    bad('§L', '用了浏览器里**不存在**的 API：'
      + Object.keys(byName).map(n => n + '（' + byName[n].join('、') + '）—— ' + whyOf(n)).join('；')
      + '。这类错静态语法检查查不出来（它就是一次合法的成员访问），只有真跑起来才炸 —— '
      + '而炸的时候界面上往往什么都没有，只有控制台一条红字。');
  } else {
    ok('§L', '扫了 ' + scanned + ' 段源码：' + BANNED_API.length + ' 个不存在/非标准的浏览器 API 一个都没用到');
  }
  return hits.length;
}

function runAll() {
console.log('§A 内联脚本裸调用的作用域'); sectionA(); sectionA2();
console.log('§B 模板串里的「块注释 + 反引号」'); sectionB();
console.log('§C 素材身份判据只有一份'); sectionC();
console.log('§D ident.js 排在 assetlib.js 前面'); sectionD();
console.log('§E 合卡规则只有一份'); sectionE();
console.log('§F 另存那条链只有一个触发点'); sectionF();
console.log('§G 另存的安全立场与 .assets 原件不动'); sectionG();
console.log('§H 用户可见文案里不许有 markdown 标记'); sectionH();
console.log('§I 「能力来源」那句话全站只有一份口径'); sectionI();
console.log('§J 「同一个功能只应有一份实现」'); sectionJ();
console.log('§K 页面不重复定义 ui.css 已有的规则'); sectionK();
  console.log('§L 只许用真有的浏览器 API'); sectionL();

const over = [...seen.entries()].filter(([, n]) => n > 6);
if (over.length) console.log('\n（折叠的同类红：' + over.map(([k, n]) => k.split('|')[0] + ' ' + k.split('|')[1] + ' ×' + (n - 6)).join('；') + '）');
console.log('共 ' + green + ' 档绿 / ' + red + ' 条红');
process.exit(red ? 1 : 0);
}

/* cssRules / cssDecls / cssStripComments 一并导出：临时扫描脚本要列「某个选择器在 ui.css 与各页里
   各长什么样」时，必须用**同一台** CSS 解析器 —— §K 判的就是这件事，旁边再手写一个只认单行声明的
   版本，会给出一份比 §K 更宽松或更严的读数，而那份读数看起来同样合理。 */
/* analyse / resolves / localDeclaredNames 一并导出：写「为什么这一档没抓到那个 bug」这类
   临时调试脚本时要用**同一台**作用域分析器（旁边手写一份只会给出另一份看起来同样合理的读数）。 */
module.exports = { lex, runAll, sectionA, sectionA2, memberSites, paramNames, sectionB, sectionC, sectionD, sectionE, sectionF, sectionG, sectionH,
  sectionI, sectionJ, sectionK, sectionL, routeBlock, fnBlock, cssRules, cssDecls, cssStripComments,
  analyse, resolves, localDeclaredNames };
if (require.main === module) runAll();
