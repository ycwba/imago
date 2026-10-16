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
 *   §J 「同一个功能只应有一份实现」（b64Bytes / 落点选择器 / toast / 续拉 / 字节单位 / 芯片行 / 跨页复用载荷 / 本机落盘链 / AI 润色那六句交代与对话面板）
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

  /* 图标几何同理：ICONS 里同一个 key 写两遍是**合法 JS**，后者静默盖掉前者 ——
     改前面那一份时页面纹丝不动，而自检全绿（这一轮重画 play/pause/speaker 就踩了：
     新几何写在 play 那一组，旧的两份 speaker 还留在原处，等于新的一处从来没生效过）。
     所以按**出现次数**数同一个 key，超过 1 份就红。 */
  const icons = read('ui.js');
  const icBlock = icons.slice(icons.indexOf('window.ICONS = {'), icons.indexOf('};', icons.indexOf('window.ICONS = {')));
  const icKeys = Array.from(icBlock.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):/gm), m => m[1]);
  const icDup = [...new Set(icKeys.filter((k, i) => icKeys.indexOf(k) !== i))];
  if (icDup.length) bad('§C', 'ICONS 里这几个 key 各写了两份（后面那份静默盖掉前面那份）：' + icDup.join('、'));
  else ok('§C', 'ICONS ' + icKeys.length + ' 个图标，没有重复 key（几何只许一份）');

  if (diff.length) { /* 已在上面报过 */ }
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
    /* 每一次删源都只认两条合法的路：
         ① 这一段里已经写过目标（先写、写成功才删）；或
         ② 删之前刚验过「目标里已经是同一份内容」（那才是「搬」而不是「拷」，
            内容没丢，所以不需要再写一遍）。
       **不能**简单判「writeFileSync 必须在 unlinkSync 之前」—— ② 那一支压根不写，
       按那句话去判会把一条正确实现报成红（第一版就是这么错的）。
       也不能反过来放宽成「顺序无所谓」—— 那就等于把「先删后写」这个真缺陷放过去了。
       还有第三条：这一档只能读**词法 token 的先后**，不能读原文切片。
       第一版写的是 `between.indexOf('writeFileSync') < 0`，而这一块里有一句注释
       「真满了 writeFileSync 会崩在半个文件上」—— 注释里那三个字被当成了一次真写入，
       于是 tests/mutation.cjs 的「先删源再写目标」那一刀长年读成全绿：代码改坏了、
       判据一个字不报，比没有这一档更糟（它装作查过）。词法扫描把注释与字符串一起剥掉，
       剩下的 token 顺序才是代码里真实的执行顺序。扫描器读不完时必须红 ——
       尺子没过词法等于这一档没跑，不能默默放行。 */
    CUR_FILE = 'proxy.js:/save-move';
    const L = lex(bm, 1);
    if (L.err) bad('§G', '/save-move 这一块扫描器读不完：' + L.err + '（判据坏了，不是代理坏了）');
    else {
      const tk = L.toks;
      const calls = name => { const out = [];
        for (let k = 0; k < tk.length; k++)
          if (tk[k].t === 'id' && tk[k].v === name && tk[k + 1] && tk[k + 1].t === 'p' && tk[k + 1].v === '(') out.push(k);
        return out; };
      const un = calls('unlinkSync'), wr = calls('writeFileSync');
      const sm = [];   /* 读 sums 那张预检表的那一步 = 合法路 ② */
      for (let k = 0; k + 3 < tk.length; k++) {
        if (tk[k].t === 'id' && tk[k].v === 'sums' && tk[k + 1].t === 'p' && tk[k + 1].v === '.'
          && tk[k + 2].t === 'id' && /^(get|has)$/.test(tk[k + 2].v) && tk[k + 3].t === 'p' && tk[k + 3].v === '(') sm.push(k);
      }
      if (!un.length) bad('§G', '/save-move 里没有 unlinkSync —— 那是「搬」，搬完不删源就是「拷」，和 /save-local 没区别了');
      for (let i = 0; i < un.length; i++) {
        const lo = i ? un[i - 1] : -1;
        const before = k => k > lo && k < un[i];
        if (!wr.some(before) && !sm.some(before))
          bad('§G', '/save-move 第 ' + (i + 1) + ' 次 unlinkSync 之前既没有写入目标、也没有校验目标里已是同一份内容 —— 源文件可能白删');
      }
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
  /* 逐道点名要守住的闸。/save-move 有**两道**闸（源与目标），
     写成「这个块里存在一道 insideLocalDir 闸」就等于只查了其中一道 ——
     改坏另一道照样全绿（变异脚本当场抓出来，第二版才改成按参数点名）。
     2026-10-15：来源那一侧从「单个 srcDir」改成候选表循环（默认目录有新旧两代），
     参数名跟着没了 —— 这里改成给**每条闸的真形状**（行首那个真语句），
     否则正则永远匹配不上，§G 会假红。 */
  for (const [route, pats] of [
    ['/save', [['^\\s*if \\(insideLocalDir\\(dir\\)', 'insideLocalDir(dir)']]],
    ['/save-local', [['^\\s*if \\(insideLocalDir\\(dir\\)', 'insideLocalDir(dir)']]],
    ['/save-move', [
      ['^\\s*for \\(const d of srcDirs\\) if \\(insideLocalDir\\(d\\)\\)', '候选源目录那一圈 insideLocalDir(d)'],
      ['^\\s*if \\(insideLocalDir\\(to\\)\\)', 'insideLocalDir(to)'],
    ]],
  ]) {
    const blk = routeBlock(proxy, route);
    if (!blk) { bad('§G', "proxy.js 里找不到 '" + route + "' 的处理块"); continue; }
    /* 认的是「**行首就是一个真的语句**」，不是「文本里出现过 insideLocalDir(」。
       后者被人 `if (false && insideLocalDir(...))` 短路掉之后照样绿（第一版就是这么写的）。 */
    for (const [re, human] of pats) {
      if (!new RegExp(re, 'm').test(blk))
        bad('§G', route + ' 里没有一道**真正会执行**的 ' + human + ' 闸 —— 另存目录可能被设成 .assets 本身');
    }
  }

  /* 「逐句配音的字段不许在路由这层被丢掉」—— 一条与上面同类的判据，但属于**形状**那一族。
     `/render` 的 POST 是**逐字段重写** spec（不是原样透传），所以每加一个新字段
     （`off` = 这一句在音频文件内的起点，客户端拖左把手剪掉开头时写的），
     就必须在这张表里也加一行 —— 漏了的话是**静默失效**：
     页面发了 off、`renderJob` 也读了 off，中间这层没放行 → 被剪掉开头的那一句
     合成时又从音频第 0 秒整句放出来（试听听得出来、成片里也在，界面一个字都不说）。
     判据按「三处都要出现这个字段」来点：页面 clipVoices → 路由 spec → renderJob 读它。
     ⚠ 这里**不能**用 routeBlock()：它只认 `dataPath === '/x'` 那种（数据文件路由），
       而 /render 是 `req.url.startsWith('/render') && req.method === 'POST'` 的形状，
       拿 routeBlock 去取会取到 null 或别的块 —— 判据于是恒红，看起来像「路由漏了字段」。
       按 POST /render 那句往下切到下一个同级 `if (req.` 为止。 */
  checks++;
  {
    const dirSrc = read('director.html');
    /* renderJob 的函数体**不能**用 fnBlock()：那三个函数体「短、没有花括号」是它的前提，
       而 renderJob 满是 `${...}` 模板串（`}` 在字符串里），花括号配平必然数错 → 取到半截或取不到。
       这里按「从函数头切到下一个顶层 `function`/`async function`」来取 —— 那一层是行首顶格的，
       模板串里的 `}` 不会顶格，所以这个边界是可靠的。 */
    let rjob = '';
    const rm = /^async function renderJob\b/m.exec(proxy);
    if (rm) {
      const rest = proxy.slice(rm.index + 1);
      const nx = /^(?:async )?function \w/m.exec(rest.slice(1));
      rjob = nx ? rest.slice(0, 1 + nx.index) : rest;
    }
    const m = /if \(req\.url\.startsWith\('\/render'\)/.exec(proxy);
    let route = '';
    if (m) {
      const rest = proxy.slice(m.index);
      const nx = /^\s{2}if \(req\./m.exec(rest.slice(3));
      route = nx ? rest.slice(0, 3 + nx.index) : rest;
    }
    /* 页面这一体现在有**两处**写 `off`：没有跳过那一支 `off: off0`、有跳过那一支 `off: off0 + consumed`
       （2026-10-15 `clipVoices` 把压在灰场上的句子拆成几截时引进的这一层变量）。
       只比字面量会**假红**（变量在中间），只认其中一支又会放过「另一支不带头」这种坏法，
       而 `const off0 = Math.max(0, Number(v.off) || 0)` 这一串在整份文件里有四处（别的函数也叫这个名字），
       整份文件去比就等于「只要有一处定义在，就算 clipVoices 带了」—— 所以先把**函数体**抠出来再问这三条。
       ⚠ 这里不能用 fnBlock()：它只认 `async\s+名字`，`function clipVoices` 这种顶格写法它取到 null，
       判据会当场变成恒红（看着像「页面漏了 off」，其实是尺子没拿到正文）。 */
    let cvSrc = '';
    const cvM = /\bfunction clipVoices\s*\(/.exec(dirSrc);
    if (cvM) {
      const open = dirSrc.indexOf('{', cvM.index);
      let d = 0, j = open;
      for (; open >= 0 && j < dirSrc.length; j++) {
        const c = dirSrc[j];
        if (c === '{') d++; else if (c === '}') { d--; if (!d) { j++; break; } }
      }
      cvSrc = d ? '' : dirSrc.slice(open, j);
    }
    const offDerived = /off0\s*=\s*Math\.max\(0,\s*Number\(v\.off\)\s*\|\|\s*0\)/.test(cvSrc);
    const offWhole = /dur:\s*dur,\s*off:\s*(?:off0|Math\.max\(0,\s*Number\(v\.off\)\s*\|\|\s*0\))\s*[},]/.test(cvSrc);
    const offRuns = /off:\s*off0 \+ consumed/.test(cvSrc);
    const pageSends = cvSrc.length > 0 && offDerived && offWhole && offRuns;
    const routeKeeps = /off:\s*Math\.max\(0,\s*Number\(v\s*&&\s*v\.off\)\s*\|\|\s*0\)/.test(route);
    const jobUses = /Number\(v\.off\)\s*\|\|\s*0/.test(rjob);
    if (!m) bad('§G', "proxy.js 里找不到 POST /render 的处理块 —— 这一档尺子没底座（先确认路由还在）");
    else if (!cvSrc) bad('§G', 'director.html 里取不到 clipVoices 的函数体（改名了？花括号没配平？）—— 这一档没底座');
    else if (!pageSends) bad('§G', "director.html 的 clipVoices 里没有把配音的 off 写进提交体 —— "
      + '「这句从音频第几秒起」到不了代理，剪过开头的句子会被整句放出来'
      + '（三缺一：定义来自 v.off=' + offDerived + '、整句那一支=' + offWhole + '、拆开那几截=' + offRuns + '）');
    else if (!routeKeeps) bad('§G', "proxy.js 的 /render 路由没放行 voices[].off —— "
      + '那一层是**逐字段重写** spec 的，漏一个字段就是静默失效：页面发了、renderJob 也读了，'
      + '中间这一层没带，剪切过开头的那一句合成时又从第 0 秒整句放出来');
    else if (!jobUses) bad('§G', 'proxy.js 的 renderJob 里没有按 off 取那一句（-ss off 那一路没了）');
    else ok('§G', '配音 off 三处口径一致：页面写进提交体 → /render 路由放行 → renderJob 按它 -ss');
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
     ⑤ 字节单位数组 ['B','KB','MB','GB'] 恰好 1 处：ui.js 的 fmtBytes。
        （以前这里写的是「恰好 2 处，assets.html 那一叉是有意分叉」—— 分叉的理由是它对 0 字节
        回 '0 B' 而公共那份回空串；可 assets.html 唯一的调用点本来就写成 `a.size ? fmtSize(...) : ''`，
        0 根本走不进去，两边行为从来没差过。收成一份之后尺子必须跟着改，否则它红的是「代码变好了」。）
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

/* 「这一个对象字面量有哪些成员名」—— §J 用它现取几张公共面：workbench.js 的 `const api = {`
   （pager 的方法名）、assetlib.js 的 `window.Capabilities = {`（输入模式那一族）、
   ui.js 的 `window.Store = {` 与 assetlib.js 的 `window.TextAI / AssetLocal = {`（㉙㉚㉛ 的导出面）。
   为什么不手抄名单：抄一份名单就是第二份真相 —— 公共层加一个方法还得记得回来改判据，
   忘了就红在产品上（⑦ 那一档踩过的是 studio.html 调 `pager.fill`，api 上从来没有这个名字）。
   认 `<name> = {` 那一层花括号里处在**成员位置**的标识符：前驱是 { 或 ,（或 async/get/set 前缀），
   后继是 ( 、: 或 , 、}（简写属性）。方法体里的东西都在更深层，靠深度自然挡掉。
   ⚠ 两处必须一起数，否则深度会一路往下漏、对象在中途被当成「已经收尾」：
     · `${` 也是一次开框（词法器把插值收尾那个 `}` 当普通 `}` 吐出来，第一版就为这个在 ui.js 上
       只提出 4 个 Store 成员名 —— 少读的那几个正是 sweep 那一族，判据当场变成「面上没这个名字」的假红）；
     · 圆括号深度也要单独记：`write(key, val, opts = {})` 的形参处在成员深度上，
       不排掉的话 `val` / `opts` 会被当成成员名（名单里混进假名字，「这个名字在不在面上」就问不准了）。 */
function objectMembers(T, name) {
  const out = new Set();
  for (let k = 0; k + 2 < T.length; k++) {
    if (!(T[k].t === 'id' && T[k].v === name && T[k + 1].t === 'p' && T[k + 1].v === '='
      && T[k + 2].t === 'p' && T[k + 2].v === '{')) continue;
    let d = 0, pd = 0;
    for (let j = k + 2; j < T.length; j++) {
      const u = T[j];
      if (u.t === 'p' && (u.v === '{' || u.v === '${')) { d++; continue; }
      if (u.t === 'p' && u.v === '}') { d--; if (d === 0) break; continue; }
      if (u.t === 'p' && u.v === '(') { pd++; continue; }
      if (u.t === 'p' && u.v === ')') { pd--; continue; }
      if (d !== 1 || pd !== 0 || u.t !== 'id') continue;
      const pv = T[j - 1], nx = T[j + 1];
      const isStart = pv && (pv.t === 'p' ? (pv.v === '{' || pv.v === ',')
        : pv.t === 'id' && (pv.v === 'async' || pv.v === 'get' || pv.v === 'set'));
      if (!isStart) continue;
      if ((u.v === 'async' || u.v === 'get' || u.v === 'set') && nx && nx.t === 'id') { out.add(nx.v); continue; }
      if (nx && nx.t === 'p' && (nx.v === '(' || nx.v === ':' || nx.v === ',' || nx.v === '}')) out.add(u.v);
    }
    break;
  }
  return out;
}

/* 「这一个对象字面量里，某个成员的值那一段 token」—— §J ㉕ 用它读页面交给 AiFind 的那份配置。
   取的是**那一段 token**而不是整行文本：`apply` 今天写成一行、明天换成三行都不该让判据跟着漂，
   也不该被行尾那句注释（`// 原话已翻成 id`）顶掉。
   对象名找不到、成员找不到、或括号配不平 → 返回 null，调用方按「尺子没底座」当场红（不许悄悄放行）。
   深度口径与 objectMembers 同一套：`${` 算一次开框（插值收尾那个 `}` 会跟着减一次）。 */
function objectMemberValue(T, objName, member) {
  for (let k = 0; k + 2 < T.length; k++) {
    if (!(T[k].t === 'id' && T[k].v === objName && T[k + 1] && T[k + 1].t === 'p' && T[k + 1].v === '='
      && T[k + 2] && T[k + 2].t === 'p' && T[k + 2].v === '{')) continue;
    let d = 0;
    for (let j = k + 2; j < T.length; j++) {
      const u = T[j];
      if (u.t === 'p' && (u.v === '{' || u.v === '${')) { d++; continue; }
      if (u.t === 'p' && u.v === '}') { d--; if (d === 0) return null; continue; }
      if (d !== 1 || u.t !== 'id' || u.v !== member) continue;
      const pv = T[j - 1], nx = T[j + 1];
      if (!(pv && pv.t === 'p' && (pv.v === '{' || pv.v === ','))) continue;
      if (!(nx && nx.t === 'p' && nx.v === ':')) continue;
      let dd = 0;                                  // 值那一截自己的括号深度（{} ${} [] () 一起算）
      for (let e = j + 2; e < T.length; e++) {
        const w = T[e];
        if (w.t === 'p' && (w.v === '{' || w.v === '[' || w.v === '(' || w.v === '${')) dd++;
        else if (w.t === 'p' && (w.v === '}' || w.v === ']' || w.v === ')')) {
          if (!dd) return T.slice(j + 2, e);       // 撞上对象字面量自己的 }（最后一个成员没有尾逗号）
          dd--;
        } else if (!dd && w.t === 'p' && w.v === ',') return T.slice(j + 2, e);
      }
      return null;
    }
    return null;                                   // 找到这个对象，但没有这个成员
  }
  return null;
}

function sectionJ() {
  const red0 = red;
  const items = targets.js.map(f => ({ f, html: false })).concat(targets.html.map(f => ({ f, html: true })));
  const files = items.map(i => i.f).filter(exists);
  if (!files.length) { bad('§J', '一份源码都没读到 —— 判据本身坏了'); return 0; }

  let scanned = 0, defs = 0, calls = 0, pickers = 0, toastDefs = 0, ioInPage = 0, unitInWb = 0;
  let chipRows = 0, chipsDefs = 0, chipsCalls = 0;
  /* ⑰ 时间文案（见下面那一档的说明）：形状落在哪儿 + 公共那两份被调了几次 */
  let secShapes = 0, clockShapes = 0, fmtSecCalls = 0, fmtClockCalls = 0;
  const secShapeSites = [], clockShapeSites = [], fmtSecCallSites = [], fmtClockCallSites = [];
  /* ⑱ 日期与时刻文案（2026-10-15 收成 ui.js 那五份）：
       · locale 那三个 API 一次都不许再用（换台机器就换一种写法，且带不带秒各页不一样）；
       · 手拼「年-月-日」那个形状只许各文件留一份，且必须在公共实现里（浏览器 ui.js / 代理 Node 那份）；
       · 五个定义各 1 处且都在 ui.js，调用点两头都要在（少一头 = 尺子坏了）。 */
  const WHEN_NAMES = ['dayKey', 'fmtHM', 'fmtHMS', 'fmtWhen', 'fmtWhenSec'];
  let localeDateCalls = 0, dayShapes = 0;
  const localeDateSites = [], dayShapeSites = [];
  const whenDefs = {}, whenCalls = {}, whenDefSites = [], whenCallSites = [];
  WHEN_NAMES.forEach(n => { whenDefs[n] = 0; whenCalls[n] = 0; whenDefSites[n] = []; whenCallSites[n] = []; });
  /* ⑲ 下载文件名与「这一条素材是哪一类」（2026-10-15 收成 ui.js 那几份）：
       · 「自己写一遍文件系统保留字符的清洗」只许各侧一份 —— 浏览器 ui.js 的 fileSafe、代理 proxy.js 的那一份；
         改这一族之前是**八处四种口径**（换 - / 换 _ / 直接删、截断 20·24·60·80、兜底名各一个），
         同一张图从资产库与从生成工作台下载出来的文件名不一样，而「结尾的点与空格会被 Windows 去掉」只有一处处理过；
       · 时间戳那一段（年月日-时分秒）同理只许一份拼法，页面要就用 window.fileStamp；
       · 「是不是声音 / 按哪种媒体放 / 下载扩展名」三块读法（isAudioType / mediaKindOf / fileExtOf）
         收成 ui.js 之前是**四份各漂**：资产库那条音频下载回来叫 `.png`（数据层把 png 兜到了音频头上）、
         工作台不看 format（一张 jpeg 下回来是 .png）、收藏没有扩展名兜底（双击打不开）、
         助手卡片音频兜底 mp3 而语音台默认档是 wav。
     判据口径：needle 那一行**同时**出现 `.replace(` 才算「自己在洗名字」——
       proxy.js:3771 那条 `!/^[^\\…]+\.md$/` 是**校验**导入的归档文件名、不写回，不该算；
       而注释里描述这一族（写作 `\ / : * ? " < > |`）的行也没有 `.replace(`，同样不算。
     三块新读法的禁头按**词法器 token 的行**判，不按整行文本：这一族的旧写法在注释里是被逐字引用的
       （assetlib.js 讲「以前是 `media === '视频' ? 'mp4' : (g('format') || 'png')`」那一句），
       按整行数就自己把自己照红 —— 与 §I 开头那条纪律同一个原因。 */
  const FN_NAMES = ['fileSafe', 'fileStamp', 'isAudioType', 'mediaKindOf', 'fileExtOf'];
  let sanitizeShapes = 0;
  const sanitizeSites = [];
  const fnLines = new Map();          // '文件:行' → { f, line, s:Set(字符串 token), eq:有 === }
  const fnDefs = {}, fnCalls = {}, fnDefSites = [], fnCallSites = [];
  FN_NAMES.forEach(n => { fnDefs[n] = 0; fnCalls[n] = 0; fnDefSites[n] = []; fnCallSites[n] = []; });
  /* ⑳ 「网络与刷新」那三个数字（请求超时 / 失败重试 / 任务刷新间隔）。
     收成一张表之前有**四把**各写各的夹取：ui.js 的 Net（30 与 5..300、1 与 0..5）、
     设置页显示时的下限（5 / 0 / 2）、设置页保存时的上限（300 / 5 / 60）、
     标记里的 min/max（第四份），外加 workbench.js 轮询器里那句 `>= 2` 与 `Math.min(60, …)`。
     漂开的表现是「设置页填得进去那个数，运行层按另一个上限走」，而界面上看不出被截过。
     两头判：① 不许再自己读写那三个键、那三个输入框的标记里不许再写区间；
             ② 那张表要有定义，且设置页与轮询器确实各问了它一次（只查①会把「表被删光」读成全绿）。 */
  const NET_KEYS = ['sk_net_timeout', 'sk_net_retry', 'sk_poll_sec'];
  const NET_FIELDS = ['netTimeout', 'netRetry', 'pollSec'];
  let netKeyIO = 0; const netKeyIOSites = [];
  let netMarkBounds = 0; const netMarkBoundsSites = [];
  const NET_NAMES = ['NUMS', 'num', 'storedNum', 'setNum'];
  let numsDefs = 0; const numsDefSites = [];
  const netRefs = {}, netRefSites = {};
  NET_NAMES.forEach(n => { netRefs[n] = 0; netRefSites[n] = []; });
  /* ㉑ 「这段文本几个字、在不在这一家声明的区间里」那一族（2026-10-16 收成 assetlib.js 的 `CharLimits`，
        「定音色缺哪一格」收成 `TtsAdv.wayWhy`）。收成一份之前是**四个落点、四套措辞**：
          · 工作台就绪判定「文本至少 5 个字」/「文本超长（最多 5000 字）」，
          · 工作台提示行「平台要 5–5000 字」/「还差 3 字」，
          · 导演台配音栏「这一家要求至少 5 个字（现在 2 个字）」，
          · `Api.createBody` 提交前又拼第三种。
        措辞不一致只是难看，**计数口径不一致是缺陷**：提示行不 trim、就绪判定 trim，
        于是「界面上写着 5 个字」与「按钮说不达门槛」能同时成立；导演台那一路更明显 ——
        整栏渲染写「N 字 · 这一家 5–5000 字」，就地刷新只写「N 字」，敲第一个字就把声明的区间抹掉了。
     四头判据：① 定义恰好 1 处且在 assetlib.js；② 页面不许再出现那几句老措辞（按**字符串 token** 数，
     注释里讲历史的照不到）；③ 公共层那句 canonical 措辞得还在（否则②成了永远的空断言）；
     ④ 落点：两页各自真的在问它，assetlib 的 `createBody` 也在问（提交那一路是最后一道闸），
        而且**按文件分头数次数** —— 原来只数总次数，于是「导演台把提示词那一路整块删掉」照样全绿
        （配音那一路还有两处 `.why`，总数 4→3 仍过 ≥2）。㉑C 那一刀跑出来就是这个假绿。 */
  const CL_MEMBERS = ['tts', 'prompt', 'why', 'note', 'cntLine', 'range', 'over', 'gap', 'count', 'has', 'bounds'];
  const CL_SET = new Set(CL_MEMBERS);
  const clRefs = {}, clRefSites = {};
  CL_MEMBERS.forEach(n => { clRefs[n] = 0; clRefSites[n] = []; });
  let clDefs = 0; const clDefSites = [];
  let clRefTotal = 0;
  /* 落点计数下限**按文件**分（先量过的底座：director.html tts:2 prompt:1 why:2 cntLine:2 range:1 /
     studio.html tts:2 why:1 cntLine:1 range:1 over:1 gap:1 has:2 / assetlib.js prompt:1 why:1
     note:1 range:1 count:4 has:3 bounds:2）。为什么不能只数总数：导演台有两条栏（配音 + 提示词）
     各问一次 `why`，删掉其中一路时总数只从 4 降到 3 —— 全局 ≥2 那一条照样过，
     于是「提示词这一路的字数闸整块不见了」这件正是要抓的事在界面上无声通过。 */
  const CL_MIN_FILE = {
    'director.html': { tts: 2, prompt: 1, why: 2, cntLine: 2 },
    'studio.html': { tts: 2, why: 1, cntLine: 1 },
    'assetlib.js': { prompt: 1, why: 1 },
  };
  const CL_MIN_FILE_WHY = {
    why: '两条栏（配音 + 提示词）各问一次 —— 少一次即是其中那一路的字数闸整块不见了',
    cntLine: '整栏渲染与逐字就地刷新各写一次 —— 少一次就是当年那句「就地那一下只写 12 字」（声明的区间敲一个字就消失）',
    tts: '提交前那道闸与那一行读数各现读一次 —— 少一次就是有一路退回了自己抄 minChars/maxChars',
    prompt: '提示词那一路要按这一家的声明现算区间 —— 没了就是「页面自己编数字」或整块不闸',
  };
  /* 老措辞的指纹：这几句是「页面自己拼字数闸」的形状，公共层那一份不这么写
     （`CharLimits.why` 拼的是 `who + ' 要求' + noun + '至少 ' + b.min + ' 个字（…'`，
     所以「要求提示词至少」这五个字在公共层根本不连续出现，页面里出现即是抄了一份） */
  const CL_OLD_PHRASES = ['文本至少', '文本超长', '平台要 ', '平台最多', '平台至少要', '要求提示词至少'];
  const clOldHits = {}, clOldSites = {};
  CL_OLD_PHRASES.forEach(p => { clOldHits[p] = 0; clOldSites[p] = []; });
  let clLibChars = 0, clLibMin = 0;      // 公共层那两句措辞（底座）
  const clLibSites = [];
  let wwDefs = 0; const wwDefSites = [], wwCallSites = [];
  /* ㉒ 「把当前那一档贴到容器上」这一步（2026-10 从三页收进 workbench.js 的 `Wb.viewToggle`）：
        资产库 / 素材库 / 收藏三页以前各写一份 `grid.classList.remove('view-…') + add('view-' + 当前档)`，
        三份还互相漂 —— 资产库那份多清一个早已全局删掉的 `view-card`、另两页压根没清名单。
        清名单由**声明的档位现算**才立得住：谁再加一档而 remove 里没有它，容器上就是两个类同时挂着，
        谁赢看 CSS 源码顺序，表现是「切了档位没反应」。
        三头判据：① 前缀字面量 `view-` 只在 workbench.js 有恰好 2 处（清 + 贴），页面里 0 处；
                  ② 每一处 `Wb.viewToggle.create` 都点名容器（`target`）—— 不传就是
                     「开关能点、存档会写、按钮会高亮，唯独容器不跟着换」；
                  ③ 「有几档、每档叫什么」只在 ui.js 的 `window.VIEW_MODES` 那一行点一次名：
                     `['list', '列表']` 与 `['compact', '紧凑']` 这一对形状全站恰好各 1 处且都在 ui.js，
                     而 create 调用点**不许多传一份 `views:`**（2026-10 把这一对从七个字面量收成一处：
                     三页各自的 views、UI_PREFS 三行 opts、公共层那份兜底默认档。改一个名字要同时改七处，
                     漏一处都不会报错 —— 设置里写「列表」、进来是另一种摆法）。 */
  const VT_PAGES = ['assets.html', 'chars.html', 'favorites.html'];
  const vtPrefixSites = [], vtCreateSites = [], vtTargetedSites = [], vtModeNames = [], vtViewsArgs = [];
  /* ㉓ 「供应商类型那一排叫什么、按什么顺序排」这一族（2026-10-15 收成 ui.js 的 `provKinds` / `provKindZh`）：
       收之前有**四处**副本 —— 设置页一张表 + 一份手抄的 `['image','video','audio','text']`，
       AI 助手又抄同样的两份（它那份还多写一次键序）。注册表将来加第五类时，
       那一排 tab 与助手报告里的分档各按各的清单长，页面写「四类」而界面画三档都不会有人报。
       ⚠ 这一族与「一条素材是哪一类」（⑲ 那三块读法）不是一张表：`audio` 在这里叫「语音」（一型供应方），
         在素材那一族叫「音频」。代理 Node 那份 `MEDIA_KIND_ZH` 是素材族，故意不叫同名。
       三头判据：① 旧符号名（`KIND_ZH` / `PROV_KINDS`）与手抄键序的字面量串 0 处；
                 ② 「`audio: '语音'` 这一格」全站恰好 1 处，且落点是 ui.js（这张表的名字与取值唯一落点）；
                 ③ 两份公共读法各定义 1 处、调用各达到先量过的读数，且落点点名到文件。 */
  const PK_PAGES = ['settings.html', 'ai-chat.js'];
  const PK_ORDER = ['image', 'video', 'audio', 'text'];
  const pkOldSites = [], pkOrderSites = [], pkZhSites = [];
  const pkDefs = { provKindZh: 0, provKinds: 0 }, pkDefSites = { provKindZh: [], provKinds: [] };
  const pkCalls = { provKindZh: 0, provKinds: 0 }, pkCallSites = { provKindZh: [], provKinds: [] };
  const PK_MIN_CALLS = { provKindZh: 10, provKinds: 3 };   // 先量过：13 / 4
  /* ㉔ 「AI 芯片」那一颗（2026-10-15 收成 ui.js 的 `AiChip`）：写着「AI 挑了哪几条 / 按什么筛」并带一颗 ✕。
       收之前有**四处**各拼一份 innerHTML —— 素材库、收藏、资产库、统一选择器（assetlib 的 AssetPicker）。
       四处里两两逐字相同，漂开的是措辞与尺寸：清除按钮的 title 一份写「回到完整名单」、另一份「回到完整列表」，
       ✕ 的图标一颗 10 一颗 11，还有两份给 `window.icon` 加了守卫、两份没加（守卫在不在只决定「图标那一格是空的」还是当场抛错）。
       各页真正不同的是**芯片上写几段话**（它自己的数据）与**清掉之后各自重画什么**，所以公共层只收画法与出口。
     ⚠ 与 ⑯ 润色那一族、㉑ 字数闸同一套路：除了「形状 0 处」必须**另钉公共层那一份还在**，否则第①头是空断言。
     四头：① 页面里再拼一颗芯片（字符串里同时出现 `<span` 与 `ai-chip` / `ap-aitag`，或出现 `id="aiClear"`）0 处；
           ② `AiChip` 的定义恰好 1 处且落点 ui.js；
           ③ 三个出口（paint / text / picked）调用达下限，且 paint 的落点点名到那四个文件；
           ④ 逐句措辞：「清除 AI 结果，回到完整列表」与「AI 挑的」各恰好 1 处且在 ui.js，旧那句「回到完整名单」0 处。 */
  const AC_PAGES = ['chars.html', 'favorites.html', 'assets.html', 'assetlib.js'];
  const acShapeSites = [], acDefs = [], acClear = [], acPickPhrase = [], acOldPhrase = [];
  const acCalls = { paint: 0, text: 0, picked: 0 }, acCallSites = { paint: [], text: [], picked: [] };
  const AC_MIN = { paint: 4, text: 2, picked: 2 };   // 先量过：4 / 2 / 2
  /* ㉕ 「写一句话，让文字 AI 在本机这一堆里挑几条」那一族（2026-10-16 收成 assetlib.js 的 `AiFind`）：
       收之前素材库与收藏**各写一份整链** —— 同样两道闸、同一个按钮 busy 态、同一份 JSON 契约、
       同一套「集合 + 名次 + 理由」记账。两份漂开的第一处**不是文案，是说出去的那一格**：
       素材库那两道闸走 `Toast.err`（一定弹），收藏走 `Toast.info`（默认被 `sk_quiet_ok` 静音）——
       「搜索框里没写字就点 AI 找素材」在一页会说一句，在另一页**按了什么都没发生**（按钮转完圈自己复位，
       列表也没动，而那句解释一个字都没显示）。这是 §3「拿静音档当唯一出口等于一个字都没说出去」的又一次落地。
       另有两处**不走 `run`** 的近亲（资产库的 AI 检索、统一选择器的 AI 检索）：它们产出的是筛选条件而不是挑选集合，
       所以没并进 `run`，但字数与那句闸门话必须还是同一份 —— 收成 `AiFind.shortWhy` 这一个口子给它们问。
     ⚠ 与 ㉓ ㉔ 同一套路：除了「形状 0 处」必须**另钉公共层那一份还在**，否则第①头是空断言。
     四头：① 闸门话（「先在搜索框里写要找什么」/「至少两个字」）全站恰好 1 处且在 assetlib.js，
             而那个数 `MIN_Q` 的引用点**一处都不许**落在 assetlib.js 之外（页面读它 = 自己拼闸门）；
           ② `window.AiFind = {` 的定义恰好 1 处且落点 assetlib.js；
           ③ 四个出口的调用达下限且落点点名（run / clear → 那两页；shortWhy → assets.html + assetlib.js；
              needMsg 恰好 1 处且在 assetlib.js —— 那句话只剩一个说得出口的地方）；
           ④ 交给 AiFind 的那份配置本身：`apply` / `onPick` / `done` / `say` 四格都要在（少 `say` = 闸门话没人接，
              少 `done` = 挑完不重画），且 `apply` 那一段里**不许给 `filter` 赋值** ——
              清芯片（`AiFind.clear`）走的也是 `apply`，把「放开类型档」写进去就变成
              「点 ✕ 连我挑过的 角色/场景/道具 那一档也给我改了」（本轮就是这么从 `apply` 里搬出去的）。 */
  const AF_LIB = 'assetlib.js';
  const AF_RUN_PAGES = ['chars.html', 'favorites.html'];
  const AF_SHORT_PAGES = ['assetlib.js', 'assets.html'];
  const AF_CFG_NEED = ['apply', 'onPick', 'done', 'say'];
  const afPhraseSites = [], afMinqSites = [], afDefs = [];
  const afCalls = { run: 0, clear: 0, shortWhy: 0, needMsg: 0 }, afCallSites = { run: [], clear: [], shortWhy: [], needMsg: [] };
  const AF_MIN = { run: 2, clear: 2, shortWhy: 3, needMsg: 1 };   // 先量过：2 / 2 / 3 / 1
  const afCfgSeen = [], afCfgMiss = [], afCfgApplyBad = [];
  /* ㉖ 「这一次刷新**之后**才说的那一句」（2026-10-15 收成 ui.js 的 `Toast.after`）：
       设置页里会自己发起刷新的那几条路径（从数据文件恢复 / 导入整包备份 / 云端取回 / 用云端覆盖本机 /
       还原某份备份 / 导入设置 / 恢复默认）与 `DataSync.boot` 的对账刷新，以前统一写成
       `Toast.ok('…正在刷新…')` —— 那句话有**两重**没落地：ok 档默认被 `sk_quiet_ok` 静音，
       而 800~900 毫秒之后真的 `location.reload()`，当场弹的那一句（连 err / warn 档也一样）
       会被它自己宣布的那次刷新一起销毁。于是这些**改掉了真数据**的动作做完、页面重开，
       界面上没有任何一处说明过刚才发生了什么（看起来就是页面自己抽了一下风）。
     ⚠ 与 ㉓㉔㉕ 同一套路：除了「形状 0 处」必须**另钉公共层那一份还在**，否则第①头是空断言。
     四头：① 「正在刷新」在**真代码**里 0 处（词法器剥注释 —— 讲这段历史的注释不算）；
           ② `after` 那一格的方法定义恰好 1 处且落点 ui.js（**一处没有也红**：整块没了与页面各写一份是同一件事的两半）；
           ③ `Toast.after(` 调用达下限（先量过 10）且落点点名 ui.js 与 settings.html；
           ④ 那把 sessionStorage 键的字面量恰好 1 处且在 ui.js —— 谁抄这把键自己去 setItem，
              就绕过「取用即清」，下一次加载会把上一趟的说明再弹一遍。 */
  const NA_LIB = 'ui.js';
  const NA_PAGES = ['ui.js', 'settings.html'];
  const naOldPhrase = [], naDefs = [], naKeySites = [];
  const naCalls = { after: 0 }, naCallSites = { after: [] };
  const NA_MIN = { after: 10 };   // 先量过：10（设置页 9 + DataSync.boot 1）
  /* ㉗ 那一族名词的写法（2026-10-15 全站统一，本轮第 2 批）：
       一份平台清单 = **注册表**（「注册路由」是代理里那条路由的名字，不是清单本身 ——
         以前工作台下拉空了说「注册路由里没有…」，而设置页同一件事说「读不到注册表」，
         用户在两页看到两个名字，以为坏的是两个不同的东西）；
       一家平台 = **供应商**（页面上唯一的入口标签就是它：卡名「供应商与密钥」、
         按钮「＋ 添加自定义供应商」、表单行「供应商」。而提示句里散着「提供商 / 供应方」，
         settings.html 一张卡上同时出现「供应商」与「文字供应方」两种写法）；
       下拉里选中的那一条 = **型号**（「模型」只留给 AI 这个概念：发给它的提示词正文、
         「本机没有看视频的模型」这类。估价失败那句以前说「该模型没有 X 档定价」，
         指的就是下拉里那一条）。
     ⚠ 与 ㉓㉔㉕㉖ 同一套路：光有「旧写法 0 处」是空断言，必须**另钉新写法真有人在用**，
       还要钉住「供应商」这个词的**出处**（设置页那三处标签）—— 否则把卡改名 + 句子换成
       第三种叫法，①② 两头照样全绿。 */
  const NM_OLD = ['换一个模型', '该模型没有「', '模型表中没有', '当前文字模型（', '文字 AI 未加载',
    'AI 检索要配一个文字模型'];
  const NM_BAN = ['提供商', '供应方', '注册路由', '文字AI'];
  const NM_NEW = { '注册表里没有可用的文字 AI 供应商': 10, '注册表里没有可用的': 3, '该型号没有「': 1, '型号清单里没有': 1 };
  const NM_ANCHOR = { '供应商与密钥': 2, '添加自定义供应商': 1 };   // 先量过：settings.html 的卡名 + 按钮
  /* 上面那份落点只数 `<script>` 里的字符串，而卡名与那颗按钮写在**静态标记**里，从来不在那份清单上
     （实测：`供应商与密钥` 的 7 处落点全在别页的提示句里，设置页那一处一个都不算）。
     所以「卡改了名、六处提示句还指着它」只能对着 settings.html 的原文比一次标记形状：
     这一格必须真的长在一个标签里（改名会毁掉它，而在 JS 里新写一句提示句不会）。 */
  const NM_MARK = { '供应商与密钥': '<h2', '添加自定义供应商': '<button' };
  const nmOldSites = {}, nmBanSites = {}, nmNewSites = {}, nmAnchorSites = {};
  /* ㉘ 「只为解码而存在的那一只 `<video>`」（2026-10-16 收成 workbench.js 的 `Wb.vframe.el` / `release`）：
       取帧的两条路 —— 公共层的 `grab` 与导演台时间切片那一块 —— 以前各建一只外壳：`muted` / `playsInline` /
       那个给老浏览器看的 `playsinline` 属性各写一遍。漂开的第一处永远是最低调的那一行
       （少 `muted` → 取帧的时候声音放出来了；少 `playsInline` → 手机上整页跳去全屏播放器）。
       用完的释放同样两份，而且写法不同：一份只 `pause()`，另一份摘 `src` 再 `load()`
       —— 只 pause 的那一份解码器一直挂着，几十格之后整页拖慢（这一轮优化的正是它）。
     ⚠ 与 ㉓㉔㉕㉖㉗ 同一套路：光有「形状 0 处」是空断言，必须另钉公共层那一份还在、且真的有人在调。
     四头：① `document.createElement('video')` 落在 workbench.js 之外 0 处；
           ② 单独一格 `'playsinline'` 字符串恰好 1 处且在 workbench.js（别处的 playsinline 都混在整串
              videoAttrs / 静态标记里，不是「补给老浏览器的那一行」）；
           ③ `vframe.el(` 与 `vframe.release(` 的调用落点点名 director.html，且 workbench.js 里
              `this.el(` / `this.release(` 各 ≥1（公共层自己那份 grab 也走这条，没有留内联的第二份）；
           ④ `el(x) {` 那个形状（方法简写 + 恰好一个形参）全站恰好 1 处且在 workbench.js，
              `release` 那颗也在 workbench.js（≥1）—— 名字**不按全站唯一点数**：`release` 在本项目还管着
              Web Audio 节点（director.html）、代理名额与 IndexedDB 连接让路（proxy.js / ui.js），
              按名字数「唯一」会把它们全算成这只外壳的副本。
     ⚠ `chars.js` 与 `director.html` 里那三处 `removeAttribute('src')` 是**音频**时长探针（量一句配音几秒），
       不是取帧外壳 —— 这一档故意不管，照着 `removeAttribute` 这个名字去找副本会扑空。 */
  const VF_LIB = 'workbench.js';
  const VF_NAMES = ['el', 'release'];
  const vfCreate = [], vfInline = [], vfDefs = [], vfRelDefs = [];
  const vfCalls = {}, vfCallSites = {}, vfThis = {};
  VF_NAMES.forEach(n => { vfCalls[n] = 0; vfCallSites[n] = []; vfThis[n] = 0; });
  /* ㉙ 「按判据清掉一批 localStorage 键」那一趟扫描（2026-10-16 收成 ui.js 的 `Store.sweep`）：
       清 AI 型号元数据与设置页「恢复默认」以前各抄一遍同一个循环。抄错的方向是要命的种：
       `removeItem` 会让后面的键整体往前挪一格，**正着扫就跳过一半** —— 「恢复默认」清完还剩一堆，
       而回执照原样说「已恢复默认」（它报的是自己那张表跑过了一遍，不是真清掉了几个）。
       判据（哪些键归我管）留在调用方：一张表是 `sk_model_meta_` 前缀，另一张是 EXPORTABLE 减 RESET_KEEP，
       两边本来就不同，只有那趟扫描是同一件事。
     四头：① `localStorage.length -`（倒着扫的身份证）全站恰好 1 处且在 ui.js —— 0 处也红，
              那等于整块没了（两个调用方会退回各扫各的）；
           ② `sweep` 作为方法定义恰好 1 处且在 ui.js；
           ③ `Store.sweep(` 调用达下限且落点点名 assetlib.js 与 settings.html；
           ④ `sweep` 在 `window.Store` 那张**现取**的导出面上（函数写在闭包里而名字没挂上表 = 调用方拿到
              undefined，语法与页面渲染两关都不报，正是本仓库反复踩的那一类）。 */
  const SW_LIB = 'ui.js';
  const SW_CALL_PAGES = ['assetlib.js', 'settings.html'];
  const swBack = [], swDefs = [], swCallSites = [];
  let swCalls = 0;
  const SW_MIN = { calls: 2 };   // 先量过：2（清型号元数据 + 恢复默认）
  /* ㉚ 「AI 回的那一串反问怎么读」那一族别名（2026-10-16 收成 assetlib.js 的 `TextAI.qaOf`）：
       ai-chat 的 `askOf` 以前自己抄了一遍 `q / question / title` 与 `label / text` 这四个别名，
       抄出来的不是一份代码而是一份代码 + 一套上限（6 个候选不限题数 vs 8 题 × 10 候选）——
       于是同一个模型同一次反问，在抽屉里画得出一屏、在润色面板上被夹掉，反之也一样。
       现在**每题候选的上限**跟着调用方给（公共层收 oMax），**题数**那一档留在 ai-chat（那是「一屏装得下几题」，
       是它那一格的排版性质，不是反问契约），两份各圈在自己文件里。
     四头：① `.question` 这个属性名的落点全在 assetlib.js（第二份别名解析即红）；
           ② `qaOf` 作为方法定义恰好 1 处且在 assetlib.js；
           ③ `qaOf` 的调用达下限且点名 ai-chat.js（第二个消费方真的走了公共层）；
           ④ `QA_O_MAX` 全在 assetlib.js、`ASK_Q_MAX` / `ASK_O_MAX` 全在 ai-chat.js（上限分家不许混），
              且 `qaOf` 在 `window.TextAI` 面上。 */
  const QA_LIB = 'assetlib.js';
  const qaAlias = [], qaDefs = [], qaCallSites = [];
  let qaCalls = 0;
  const qaMaxSites = { QA_O_MAX: [], ASK_O_MAX: [], ASK_Q_MAX: [] };
  const QA_OWN = { QA_O_MAX: QA_LIB, ASK_O_MAX: 'ai-chat.js', ASK_Q_MAX: 'ai-chat.js' };
  /* ㉛ 四颗「存回本机」按钮的画法、在途守卫与回执（2026-10-16 收成 assetlib.js 的 `AssetLocal.pull*`）：
       收之前四页各写一遍「图标 + 计数 + title」，也各写一遍 `disabled` / `dataset.busy` 那两行，
       回执那一段更是四种说法。漂出来的两处真缺陷：
         · 生成工作台的守卫只看了 `dataset.busy`、没看成「在途时整颗不要重画」—— 右栏每 3 秒随整列重建一次，
           于是那句「存回本机 7 / 20」被下一次重画冲回没有进度那一版（跑了 20 条，屏幕上一直停在 0）；
         · 收藏那一档的红绿判据少算 `skip` —— 整屏全是「太大下不动」时 ok=0，仍然报一句绿。
     四头：① `dataset.busy` 在 assetlib.js 之外 0 处（「这一颗正在跑」的旗标只有一个人在写）；
           ② 六个出口（pullBusy / pullStart / pullEnd / pullBtn / pullBtnTitle / pullReceipt）
              的 `function` 定义各恰好 1 处且在 assetlib.js；
           ③ `AssetLocal.<出口>` 的调用达下限，且 pullBtn / pullReceipt / pullStart / pullEnd
              的落点各自点名那四个页面文件；
           ④ title 里那两句（「字节还不在本机」「一条都不会重下」）各恰好 1 处且在 assetlib.js，
              六个名字都在 `window.AssetLocal` 那张现取的面上。 */
  const PB_LIB = 'assetlib.js';
  const PB_NAMES = ['pullBusy', 'pullStart', 'pullEnd', 'pullBtn', 'pullBtnTitle', 'pullReceipt'];
  const PB_PAGES = { pullBtn: ['assets.html', 'chars.html', 'favorites.html', 'studio.html'],
    pullStart: ['assets.html', 'chars.html', 'favorites.html', 'studio.html'],
    pullEnd: ['assets.html', 'chars.html', 'favorites.html', 'studio.html'],
    pullReceipt: ['assets.html', 'chars.html', 'favorites.html', 'studio.html'] };
  const PB_MIN = { pullBusy: 1, pullStart: 4, pullEnd: 4, pullBtn: 4, pullReceipt: 4 };
  const pbBusySites = [], pbTitle1 = [], pbTitle2 = [];
  const pbDefs = {}, pbDefSites = {}, pbCalls = {}, pbCallSites = {};
  PB_NAMES.forEach(n => { pbDefs[n] = 0; pbDefSites[n] = []; pbCalls[n] = 0; pbCallSites[n] = []; });
  /* 「这个名字在不在我这张计数器表里」一律问**配套的落点数组**，不问计数器本身：
     计数器是普通对象字面量，token 撞上 `toString` / `constructor` 这类原型键时读回来是一个函数（truthy），
     下一句 `.push` 当场 TypeError —— 2026-10-16 就炸在这里（`qaMaxSites[t.v]` 被 `toString` 命中），
     看着像页面坏了，其实是尺子自己坏了。落点数组在原型键上是 undefined，所以 `Array.isArray` 才是那把尺。 */
  const namedSites = (sites, k) => !!k && Array.isArray(sites[k]);
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
       · 手动「自动下载」只有一条链：页面一律调 `AssetLocal.pullMany`（恰好 4 处：生成工作台 / 资产库 / 收藏 / 素材库），
         页面里**一次都不许**出现 `AssetLocal.pull` —— 谁再写一遍那个循环，分流与回执就会各漂一份；
       · 「藏不藏云端成品」只有 `hideAsCloud` 一份判据（定义 1 处且在 assetlib.js），
         页面调用点恰好 3 处，且**只许出现在资产库与生成工作台** —— 收藏 / 素材库故意不藏
         （那两页存的是人手工挑进来的东西，一条看不见就是「我收的东西没了」）；
       · 「本机有没有这份字节」只有 `hasLocalAddr` 一份，恰好 4 处（四颗「存回本机」各问一次）；
       · 页面里不许出现 `'/local-assets'` 这个字面量 —— 要落盘就调公共那一条链，
         自己 POST 等于绕过身份判据与去重（同一份产物反复下载、资产库同一张卡重复 N 次）。
         ai-chat.js 那一句是 GET 读清单，而且它是模块不是页面，所以只查 `*.html`。 */
  let dlPull = 0, pmPull = 0, hideDef = 0, hideCalls = 0, addrCalls = 0, rawLocalInPage = 0;
  let armDef = 0, armCalls = 0, armInline = 0, assetMerge = 0, mergeCalls = 0;
  const armDefSites = [], armCallSites = [], armInlineSites = [], assetMergeSites = [];
  const dlPullSites = [], pmPullSites = [], hideDefSites = [], hideCallSites = [], addrCallSites = [], rawLocalSites = [];

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
      /* 提法从 objectMembers 现取（与「真把 workbench.js 装进 vm 跑一次、问 create() 的返回值要 keys」
         逐字相等：11 个名字，两边都对过 —— 提法松或紧过一次就会报出差异，那是尺子红）。 */
      objectMembers(rw.toks, 'api').forEach(v => apiKeys.add(v));
      if (apiKeys.size < 8)
        bad('§J', '从 workbench.js 只提出 ' + apiKeys.size + ' 个 pager 方法名（实测 11 个，少于 8 就是提法坏了）：'
          + [...apiKeys].join(','));
    }
  } else bad('§J', '读不到 workbench.js —— pager 面判据没底座');

  /* ⑮ 「输入模式」那一族（素材名表、模式名、这一档收什么的说明、芯片画法、双向判据、退档判据）
        只有一份，挂在 assetlib.js 的 `window.Capabilities` 上（本轮为了「导演台使用 vgenv 时也能选模式」收的）。
     面从 assetlib.js **现取**（objectMembers，与 pager 那一面同一个提法），名单不手抄。
     这一档防三种复法：① 页面再写一份同名的表 / 函数（两页各一份 ROLE_ZH 就是本轮修掉的 ——
     同一个 role 一边叫「首帧图」一边叫「首帧」）；② 页面抄一句本该现算的措辞
     （「这一档收：」那句在两个页面逐字相同：min/max 是现读的，措辞不是）；
     ③ 只有一页在用（那等于公共层是死的，下一轮又会各写一份）。 */
  const CAP_NAMES = ['ROLE_ZH', 'INTENT_ZH', 'roleZh', 'comboLabel', 'comboGaps',
    'comboCovering', 'fallbackCombo', 'comboScopeNote', 'comboChipsHTML'];
  const CAP_SET = new Set(CAP_NAMES);
  /* 那几句「本该现算却被人抄成字面量」的说明，与芯片的 data-cid 标记 */
  const COPY_PHRASES = ['这一档收：', '这一档只用文字提示词', '换模式只改', 'data-cid='];
  const copyHits = {}, copyPageSites = {}, copyLibSites = {};
  COPY_PHRASES.forEach(p => { copyHits[p] = { lib: 0, page: 0 }; copyPageSites[p] = []; copyLibSites[p] = []; });
  const capFace = new Set();
  const capRefs = {}, capRefSites = {};
  let capClone = 0;
  const capCloneSites = [];
  /* ⑯ AI 润色那一族（2026-10 收拢：让每个地方的润色都像生成工作台那样能反问、能接着对话）。
     要钉住的三件事，各对应本轮修掉的一种复法：
       ① 对模型的六句交代（正文怎么问、反问怎么问、回答怎么附、随附图怎么用、系统串怎么拼、
          「按这句再改」怎么拼）在 `assetlib.js` 的 `TextAI` 上各只有一份定义 ——
          以前导演台的镜头提示词与配音那一句各抄一遍，改契约的人只改自己刚碰的那一处，
          于是同一段回答在不同页面发给模型的意思不一样；
       ② 页面**引用**只走 `TextAI.<名字>`，而且除了 `answersNote`（它由 `polishExtra` 内部调用，
          页面只在一处补挂「先前那几问的回答」）每一句都至少两页在用 —— 只有一页用就是公共层又死了；
       ③ 结果面板上「接着对话」那一行（输入框 / 轮次记录）的标记只在 `ui.js` 画一份，
          而每一处润色入口都必须把 `onFollow` 那根线接上：入口数与接线数对不上，
          要么页面自己另拼了一套对话行（两套样式 + 两套 busy 记账），要么按钮画出来而没人接（点了没反应）。
     类名按**字符串内容**数（词法器剥注释），所以注释里提一句「pinl-chat」不会把自己照红。 */
  const POLISH_FNS = ['polishUser', 'askUser', 'answersNote', 'polishExtra', 'polishSys', 'followPrompt'];
  const POLISH_SET = new Set(POLISH_FNS);
  /* 至少几页在用：`answersNote` 是 1（其余五句 2）—— 见上面 ② */
  const POLISH_MIN_PAGES = { answersNote: 1 };
  const pDefs = {}, pDefSites = {}, pRefFiles = {};
  POLISH_FNS.forEach(n => { pDefs[n] = 0; pDefSites[n] = []; pRefFiles[n] = new Set(); });
  const CHAT_MARKS = ['pinl-chat', 'pinl-chatin', 'pinl-talk', 'pinl-turn'];
  const chatPage = {}, chatPageSites = {};
  CHAT_MARKS.forEach(p => { chatPage[p] = 0; chatPageSites[p] = []; });
  let polishEntries = 0, followPassed = 0;
  const polishEntrySites = [], followPassSites = [];
  if (exists('assetlib.js')) {
    const ca = lex(read('assetlib.js'), 1);
    if (ca.err) bad('§J', 'assetlib.js 扫描器读不完：' + ca.err + '（Capabilities 面的判据坏了）');
    else {
      objectMembers(ca.toks, 'Capabilities').forEach(v => capFace.add(v));
      const miss = CAP_NAMES.filter(n => !capFace.has(n));
      if (miss.length) bad('§J', 'window.Capabilities 的面上没有这些名字：' + miss.join('、')
        + ' —— 输入模式那一族的唯一实现脱节了（页面在调一个公共层没有的方法，或者它被改了名）');
      /* 面太小 = 提法坏了（与 apiKeys 那一条同样的两头纪律：只查「名字在不在」的话，
         提法一旦返回空集，九条缺席会一起报出来 —— 那一句讲的是尺子，不是产品）。 */
      if (capFace.size < 20)
        bad('§J', '从 assetlib.js 只提出 ' + capFace.size + ' 个 Capabilities 成员名（实测 40 个上下，'
          + '少于 20 就是提法坏了）：' + [...capFace].join(','));
    }
  } else bad('§J', '读不到 assetlib.js —— Capabilities 面判据没底座');

  /* ㉙㉚㉛ 那三族的「名字有没有真的挂上导出面」：面**现取**（objectMembers，与 pager 的 api、
     Capabilities 同一个提法），名单不手抄。少了这一头会漏掉本仓库最常复犯的那一类 ——
     函数写在闭包里、名字没进 `window.X = {` 那张表：调用方拿到 undefined，
     「恢复默认」清掉 0 把键而回执照原样说「已恢复」，`vm.Script` 与页面渲染两关一个字都不报。 */
  const faces = {};
  const FACE_OF = { Store: 'ui.js', TextAI: QA_LIB, AssetLocal: PB_LIB };
  Object.keys(FACE_OF).forEach(nm => {
    const f = FACE_OF[nm];
    if (!exists(f)) { bad('§J', '读不到 ' + f + ' —— ' + nm + ' 面的判据没底座'); return; }
    const rF = lex(read(f), 1);
    if (rF.err) { bad('§J', f + ' 扫描器读不完：' + rF.err + '（' + nm + ' 面的判据坏了）'); return; }
    faces[nm] = objectMembers(rF.toks, nm);
    if (faces[nm].size < 5) bad('§J', '从 ' + f + ' 只提出 ' + faces[nm].size + ' 个 ' + nm
      + ' 成员名（少于 5 就是提法坏了，不是产品坏了）：' + [...faces[nm]].join(','));
  });

  /* ⑨-b 「存回本机」的范围不许跟「不显示云端任务」走（2026-10 第四轮）。
     四页各有一个「这一屏里本机还没有那份字节的」范围函数，它**不许**读那条带藏的列表：
       · 工作台 `pullScope` —— 不许用 `filteredItems`（它自己带 hideAsCloud）；
       · 资产库 `pullScope` —— 不许用 `filteredAll`（它是 `applyFilters()` 的薄封装，永远带藏）；
         `applyFilters` 本身**只有带上 `{includeHidden:true}` 才放行** —— 那一趟才等于「不问藏不藏」，
         不带参数的那次与列表用的一模一样，正是要拦的形态（所以它进 needArg 而不是 forbid）；
       · 收藏 `pullScope` / 素材库 `localPlan` —— 不许自己问 `hideAsCloud`。
     为什么单独立一条：`hideAsCloud` 的**调用点**不会因此变多（藏是在列表函数里统一做的），
     所以上面「调用点恰好 3 处」那条对这类错误完全是瞎的 —— 资产库那颗按钮就是这么漏过去的
     （范围写成 `applyFilters()`，三个开关全开时它筛出 0 条，按钮点了只会说「都已经有了」，
     而用户一条都没存）。「看着能点、其实什么都不做」正是本档要拦的东西，所以补一把能看见它的尺子。
     取函数体：从 `function 名(` 起找第一个 `{`，靠大括号配对收尾 —— 模板串 / 字符串 / 注释
     在词法器里都是整块 token，不参与配对，所以不会被它们带偏（也因此注释里提一句不算）。
     函数找不到 = 尺子没底座（改名了 / 手动入口被删了），当场红：不许悄悄退化成空断言。 */
  /* `forbid` = 出现即红；`needArg` = 只有在调用参数里出现 `includeHidden` 时才放行。 */
  const PULL_SCOPES = [
    { file: 'studio.html', fn: 'pullScope', forbid: ['filteredItems', 'hideAsCloud'], needArg: [] },
    { file: 'assets.html', fn: 'pullScope', forbid: ['filteredAll', 'hideAsCloud'], needArg: ['applyFilters'] },
    { file: 'favorites.html', fn: 'pullScope', forbid: ['hideAsCloud'], needArg: [] },
    { file: 'chars.html', fn: 'localPlan', forbid: ['hideAsCloud'], needArg: [] },
  ];
  const scopeSeen = new Set(), scopeBad = [];
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
      /* ⑨-b 取这几个范围函数的函数体，看里面有没有「带藏」的读取入口（见上面那一段说明） */
      PULL_SCOPES.forEach(spec => {
        if (spec.file !== it.f) return;
        let at = -1;
        for (let k = 0; k + 2 < T.length; k++) {
          if (T[k].t === 'id' && T[k].v === 'function' && T[k + 1] && T[k + 1].t === 'id' && T[k + 1].v === spec.fn
            && T[k + 2] && T[k + 2].t === 'p' && T[k + 2].v === '(') { at = k; break; }
        }
        if (at < 0) return;                       // 这一段里没有：换下一段（函数可能挂在后面那段脚本里）
        scopeSeen.add(spec.file);
        let i = at;
        while (i < T.length && !(T[i].t === 'p' && T[i].v === '{')) i++;
        let depth = 0;
        for (; i < T.length; i++) {
          if (T[i].t === 'p' && T[i].v === '{') depth++;
          else if (T[i].t === 'p' && T[i].v === '}') { depth--; if (!depth) break; }
          else if (T[i].t === 'id' && spec.forbid.indexOf(T[i].v) >= 0)
            scopeBad.push(spec.file + ':' + T[i].line + '（' + spec.fn + ' 里用了 ' + T[i].v + '）');
          else if (T[i].t === 'id' && spec.needArg.indexOf(T[i].v) >= 0) {
            /* 必须是一次**带 `includeHidden` 的调用**：不是调用、或者参数里没这一项，都算走上带藏那条路。
               逐 token 只看括号自己那一层以内，别的方法调用里的同名参数不算数。 */
            let hit = false;
            if (T[i + 1] && T[i + 1].t === 'p' && T[i + 1].v === '(') {
              let d = 0;
              for (let j = i + 1; j < T.length; j++) {
                const u = T[j];
                if (u.t === 'p' && u.v === '(') d++;
                else if (u.t === 'p' && u.v === ')') { d--; if (!d) break; }
                else if (u.t === 'id' && u.v === 'includeHidden') { hit = true; break; }
              }
            }
            if (!hit) scopeBad.push(spec.file + ':' + T[i].line + '（' + spec.fn + ' 里用了 ' + T[i].v
              + '，没带 includeHidden）');
          }
        }
      });
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
        /* ⑰ 时间文案那两行（2026-10-15 各收成一份）：
             · 「跑了多久」写成 `X 分 Y 秒` —— 以前有 3 份逐字相同的式子（详情面板的耗时行、
               每秒跳动的那个计时器、导演台候选卡的「已耗时」）；
             · 播放器那行 mm:ss —— 以前有 3 份（剪辑甲板 / 候选播放器 / 插针跳转后的读数）。
           两份都会各自漂（一处补零、另一处不补；一处写「1 分 0 秒」、另一处写「1 分 0 秒」变「1 分」）。
           认的是**形状**而不是符号名：字面量 `' 分 '` 落在哪儿、`':'` 那一步两侧是不是各有一次
           `padStart(2, '0')`。窗口取 ±16 个 token（`String(Math.floor(v / 60)).padStart(2, '0')`
           一句就占 12 个，取 ±6 只够看见左边那个，右边那半永远数不上 —— 那是尺子坏了不是代码坏了）。 */
        if (t.t === 'str' && t.s === ' 分 ') { secShapes++; secShapeSites.push(it.f + ':' + t.line); }
        if (t.t === 'str' && t.s === ':') {
          let pads = 0;
          for (let j = k - 16; j <= k + 16; j++) if (T[j] && T[j].t === 'id' && T[j].v === 'padStart') pads++;
          if (pads >= 2) { clockShapes++; clockShapeSites.push(it.f + ':' + t.line); }
        }
        /* 公共那两份的**调用点**：认 `Wb.fmtSec(` / `Wb.fmtClock(`（前驱是 `.`）。
           只看后面那个邻居的话，`bindTlPlay(col, keepPlay, Wb.fmtClock, keepBox)` 那种
           「把函数当引用递出去」会被数成调用 —— 它没有调用，只是交付。 */
        if (t.t === 'id' && (t.v === 'fmtSec' || t.v === 'fmtClock')
          && pv && pv.t === 'p' && pv.v === '.' && nx && nx.t === 'p' && nx.v === '(') {
          if (t.v === 'fmtSec') { fmtSecCalls++; fmtSecCallSites.push(it.f + ':' + t.line); }
          else { fmtClockCalls++; fmtClockCallSites.push(it.f + ':' + t.line); }
        }
        /* ⑱-a locale 那三个 API：`x.toLocaleDateString()` / `.toLocaleTimeString()` 直接算，
           `.toLocaleString(` 要再看一步 —— 只有接收者是 `new Date(…)` 的才算「拿它格式化日期」，
           用量页那十几处 `tokens.toLocaleString()` 是千分位，不在这一族里。
           回看做法：`(` `)` 配对退到最外层那对括号，看它左邻那个词是不是 `Date`。 */
        if (t.t === 'id' && nx && nx.t === 'p' && nx.v === '(' && pv && pv.t === 'p' && pv.v === '.') {
          const isDateLocale = t.v === 'toLocaleDateString' || t.v === 'toLocaleTimeString';
          let dateRecv = false;
          if (t.v === 'toLocaleString') {
            let j = k - 2, depth = 0;                     // T[k-1] 是 '.'
            if (T[j] && T[j].t === 'p' && T[j].v === ')') {
              for (; j >= 0; j--) {
                const q = T[j];
                if (q.t !== 'p') continue;
                if (q.v === ')') depth++;
                else if (q.v === '(' && --depth === 0) break;
              }
              const b = T[j - 1];
              dateRecv = !!b && b.t === 'id' && b.v === 'Date';
            }
          }
          if (isDateLocale || dateRecv) { localeDateCalls++; localeDateSites.push(it.f + ':' + t.line + ' ' + t.v); }
        }
        /* ⑱-b 手拼「年-月-日」的形状：`getFullYear() + '-'`。
           只认这一条连写，所以 `new Date(now.getFullYear(), now.getMonth(), …)` 那种**日期算术**不算
           （它后面跟的是 `,`），模板串里拼文件名也不算（词法器把整段当一个 tpl token）。 */
        if (t.t === 'id' && t.v === 'getFullYear' && T[k + 1] && T[k + 1].v === '('
          && T[k + 2] && T[k + 2].v === ')' && T[k + 3] && T[k + 3].v === '+'
          && T[k + 4] && T[k + 4].t === 'str' && T[k + 4].s === '-') {
          dayShapes++; dayShapeSites.push(it.f + ':' + t.line);
        }
        /* ⑱-c 公共那五份的定义与调用各数一次名 */
        if (t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && WHEN_NAMES.includes(nx.v)) {
          whenDefs[nx.v]++; whenDefSites[nx.v].push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && WHEN_NAMES.includes(t.v) && pv && pv.t === 'p' && pv.v === '.'
          && T[k - 2] && T[k - 2].t === 'id' && T[k - 2].v === 'window'
          && nx && nx.t === 'p' && nx.v === '(') {
          /* 前驱是「.」而不是「window」：词法器把 `.` 单独成一个 p token，
             所以 window 在**再前面**一个。第一版只看紧邻那个，五个计数恒为 0 ——
             而「0 次调用」这一档报的红，看着像页面退回自己拼，其实是尺子读错了仪表。 */
          whenCalls[t.v]++; whenCallSites[t.v].push(it.f + ':' + t.line);
        }
        /* ⑲-c 公共那两份的定义与调用各数一次名。
           `fileSafe` 两边各有一份同名实现（浏览器 ui.js + 代理 Node 那份，与 dayKey / dayPart 同一安排），
           所以定义数期望是 2；`fileStamp` 只在浏览器侧，期望 1。调用只数 `window.<名>(` —— 代理里是裸调。 */
        if (t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && FN_NAMES.includes(nx.v)) {
          fnDefs[nx.v]++; fnDefSites[nx.v].push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && FN_NAMES.includes(t.v) && pv && pv.t === 'p' && pv.v === '.'
          && T[k - 2] && T[k - 2].t === 'id' && T[k - 2].v === 'window'
          && nx && nx.t === 'p' && nx.v === '(') {
          fnCalls[t.v]++; fnCallSites[t.v].push(it.f + ':' + t.line);
        }
        /* ⑲-d 按行收字符串 token 与「比较」（三块新读法的禁头要用，见上面那一段的口径）。
           词法器的标点最短是**两个字符**：`===` 出来的是 '==' 加 '='（`==` 那一步先吃掉两个），
           而单独的 '=' 是赋值。所以认 `^={2,}$` —— 第一版写 `t.v === '==='`（永远匹配不上）、
           第二版写「紧邻那个也是 '='」（三个字符被切成两半，中间那个的邻居是 '=='）：
           两条都把三条判据读成 0 处，看着像页面退回自己写，其实是尺子读不到比较。
           只数比较不数赋值：`const VOICE = ['音频', '音乐']` 是一张给人看的数据表，不是判据。 */
        if (t.t === 'str' || (t.t === 'p' && /^={2,}$/.test(t.v))) {
          const lkey = it.f + ':' + t.line;
          let box = fnLines.get(lkey);
          if (!box) { box = { f: it.f, line: t.line, s: new Set(), eq: false }; fnLines.set(lkey, box); }
          if (t.t === 'str') box.s.add(t.s);
          else box.eq = true;
        }
        /* ⑳-c 那张表的定义（`const NUMS = {`）与四个出口的成员访问（`Net.num(` / `Net.NUMS[…]`）。
           不复用 ⑱/⑲ 那两支：这一族走的是 `Net.<名>`，前面是 `Net` 而不是 `window`。
           `num` / `setNum` 这种短名字只认「前驱恰是 Net + .」的那一个 ——
           页面自己 `const num = …` 再裸调 `num(` 不会被算进来（那正是这一档要禁的重复实现）。 */
        if (t.t === 'id' && t.v === 'const' && nx && nx.t === 'id' && nx.v === 'NUMS') {
          numsDefs++; numsDefSites.push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && NET_NAMES.includes(t.v) && pv && pv.t === 'p' && pv.v === '.'
          && T[k - 2] && T[k - 2].t === 'id' && T[k - 2].v === 'Net') {
          netRefs[t.v]++; netRefSites[t.v].push(it.f + ':' + t.line);
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
            else if (m.v === 'pullMany') { pmPull++; pmPullSites.push(it.f + ':' + t.line); }
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
        /* ㉑ 字数闸那一族：`CharLimits.<成员>` 的引用按成员记（两头：公共层有定义、页面真的在问），
           `window.CharLimits = {` 那一处是唯一定义点；`wayWhy` 同一套两头。 */
        if (t.t === 'id' && t.v === 'CharLimits') {
          if (nx && nx.t === 'p' && nx.v === '.' && T[k + 2] && T[k + 2].t === 'id' && CL_SET.has(T[k + 2].v)) {
            const nm = T[k + 2].v;
            clRefs[nm]++; clRefTotal++;
            clRefSites[nm].push(it.f + ':' + t.line);
          } else if (pv && pv.t === 'p' && pv.v === '.' && onWindow(T[k - 2])
            && T[k + 1] && T[k + 1].t === 'p' && T[k + 1].v === '=' && T[k + 2] && T[k + 2].t === 'p' && T[k + 2].v === '{') {
            clDefs++; clDefSites.push(it.f + ':' + t.line);
          }
        }
        if (t.t === 'id' && t.v === 'wayWhy') {
          if (pv && pv.t === 'p' && pv.v === '.' && nx && nx.t === 'p' && nx.v === '(') wwCallSites.push(it.f + ':' + t.line);
          else if (!(pv && pv.t === 'p' && pv.v === '.') && nx && nx.t === 'p' && nx.v === '(') { wwDefs++; wwDefSites.push(it.f + ':' + t.line); }
        }
        /* ㉒ 展示样式：容器类前缀那个字面量（只在公共层那一处该出现）与 create 调用点是否点名容器。
           注释里讲历史的「以前这里写 classList.add('view-' + …)」照不到 —— 词法器剥注释（与 ⑪ 同一套路）。 */
        if ((t.t === 'str' || t.t === 'tpl') && String(t.s) === 'view-') vtPrefixSites.push(it.f + ':' + t.line);
        if (t.t === 'id' && t.v === 'viewToggle' && pv && pv.t === 'p' && pv.v === '.'
          && nx && nx.t === 'p' && nx.v === '.' && T[k + 2] && T[k + 2].t === 'id' && T[k + 2].v === 'create') {
          vtCreateSites.push(it.f + ':' + t.line);
          let hasTarget = false, hasViews = false;
          for (let j = k + 3; j < Math.min(T.length, k + 320); j++) {
            const u = T[j];
            if (u.t === 'id' && u.v === 'target') { hasTarget = true; }
            if (u.t === 'id' && u.v === 'views') { hasViews = true; break; }
            if (u.t === 'p' && (u.v === ';' || u.v === '}')) break;
          }
          if (hasTarget) vtTargetedSites.push(it.f + ':' + t.line);
          if (hasViews) vtViewsArgs.push(it.f + ':' + t.line);
        }
        /* 档位名的字面量对（`['list', '列表']` / `['compact', '紧凑']`）：只许在 ui.js 的
           `window.VIEW_MODES` 那一行各点一次名。写成「按形状的 token 三元组」而不是搜字符串，
           是因为注释里讲历史的写法（`views: [['list', '列表', …]]`）必须不算副本 —— 那一刀有反向对照。 */
        if (t.t === 'p' && t.v === '[' && T[k + 1] && T[k + 1].t === 'str'
          && T[k + 2] && T[k + 2].t === 'p' && T[k + 2].v === ','
          && T[k + 3] && T[k + 3].t === 'str') {
          const a = String(T[k + 1].s), b = String(T[k + 3].s);
          if ((a === 'list' && b === '列表') || (a === 'compact' && b === '紧凑')) {
            vtModeNames.push(it.f + ':' + t.line + ' ' + a);
          }
        }
        /* ㉓ 供应商类型那一族：旧符号名 / 手抄键序 / 「audio 那一格叫语音」这个形状 / 公共两份的两头。
           形状认的是**相邻四个字符串字面量**（`'image' , 'video' , 'audio' , 'text'`）而不是搜源码文本：
           注释里讲「以前这里手写一份四档清单」必须不算副本（词法器剥注释，与 ㉒ 同一套路）。 */
        if (t.t === 'id' && (t.v === 'KIND_ZH' || t.v === 'PROV_KINDS')) pkOldSites.push(it.f + ':' + t.line + ' ' + t.v);
        if (t.t === 'str' && String(t.s) === PK_ORDER[0]) {
          let j = k, n = 0;
          while (n < PK_ORDER.length && T[j] && T[j].t === 'str' && String(T[j].s) === PK_ORDER[n]) {
            n++; j++;
            if (n < PK_ORDER.length) {
              if (!(T[j] && T[j].t === 'p' && T[j].v === ',')) break;
              j++;
            }
          }
          if (n === PK_ORDER.length) pkOrderSites.push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && t.v === 'audio' && T[k + 1] && T[k + 1].t === 'p' && T[k + 1].v === ':'
          && T[k + 2] && T[k + 2].t === 'str' && String(T[k + 2].s) === '语音') pkZhSites.push(it.f + ':' + t.line);
        if (t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && (nx.v === 'provKindZh' || nx.v === 'provKinds')) {
          pkDefs[nx.v]++; pkDefSites[nx.v].push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && (t.v === 'provKindZh' || t.v === 'provKinds') && pv && pv.t === 'p' && pv.v === '.'
          && T[k - 2] && T[k - 2].t === 'id' && T[k - 2].v === 'window'
          && nx && nx.t === 'p' && nx.v === '(') {
          pkCalls[t.v]++; pkCallSites[t.v].push(it.f + ':' + t.line);
        }
        /* ㉔ AI 芯片那一族：形状（页面又自己拼一颗）/ 定义 / 三个出口 / 逐句措辞。
           认的是**字符串 token 的内容**：注释里讲「以前这里手拼一颗 ai-chip」不算副本（与 ㉓ 同一套路）。
           公共层那份自己拼标记时把 `class="` 与 `'ai-chip'` 拆在两个 token 里（中间要插 oo.cls），
           所以「同一个字符串里既有 <span 又有 ai-chip」正好只照到副本、不照到底座。 */
        if (t.t === 'id' && t.v === 'AiChip' && pv && pv.t === 'id' && pv.v === 'const') {
          acDefs.push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && t.v === 'AiChip' && pv && pv.t === 'p' && pv.v === '.'
          && T[k - 2] && T[k - 2].t === 'id' && T[k - 2].v === 'window'
          && nx && nx.t === 'p' && nx.v === '.' && T[k + 2] && T[k + 2].t === 'id'
          && namedSites(acCallSites, T[k + 2].v)) {
          const nm24 = T[k + 2].v;
          acCalls[nm24]++; acCallSites[nm24].push(it.f + ':' + t.line);
        }
        if (t.t === 'str' || t.t === 'tpl') {
          const sc24 = String(t.s || '');
          if ((sc24.indexOf('<span') >= 0 && /ai-chip|ap-aitag/.test(sc24)) || /id="?(aiClear|apAiClear)/.test(sc24)) {
            acShapeSites.push(it.f + ':' + t.line);
          }
          if (sc24.indexOf('清除 AI 结果，回到完整列表') >= 0) acClear.push(it.f + ':' + t.line);
          /* 只认公共层那个**带尾空格**的字面量 'AI 挑的␣'（它后面紧跟条数）。chars.html 里那句
             「退出「AI 挑的那批」」是清 AI 结果时的 Toast 说明，不是芯片的副本 —— 宁可少守一条，
             也不留一条会误报的判据（误报一次，下一轮就有人整档砍掉）。 */
          if (sc24.indexOf('AI 挑的 ') >= 0) acPickPhrase.push(it.f + ':' + t.line);
          if (sc24.indexOf('回到完整名单') >= 0) acOldPhrase.push(it.f + ':' + t.line);
        }
        /* ㉕ AI 挑几条那一族：闸门那句话 / 那个数 / 公共层定义 / 四个出口。
           与 ㉓㉔ 同一套路：认 token，词法器剥掉注释 —— 讲历史的句子（「以前页面自己写 q.length < 2」）
           写在注释里不算副本。出口两头都认：页面写 `window.AiFind.run(`，assetlib.js 内部裸写 `AiFind.state(`，
           所以这里不要求前面一定挂 `window.`（只有**定义**那一头要求）。 */
        if (t.t === 'id' && t.v === 'AiFind' && pv && pv.t === 'p' && pv.v === '.'
          && T[k - 2] && onWindow(T[k - 2]) && nx && nx.t === 'p' && nx.v === '=') {
          afDefs.push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && t.v === 'AiFind' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && namedSites(afCallSites, T[k + 2].v)
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === '(') {
          const nm25 = T[k + 2].v;
          afCalls[nm25]++; afCallSites[nm25].push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && t.v === 'MIN_Q') afMinqSites.push(it.f + ':' + t.line);
        if (t.t === 'str' || t.t === 'tpl') {
          const sc25 = String(t.s || '');
          if (sc25.indexOf('先在搜索框里写要找什么') >= 0 || sc25.indexOf('至少两个字') >= 0) {
            afPhraseSites.push(it.f + ':' + t.line);
          }
        }
        /* ㉖ 刷新之后那一句：被禁的那句话 / 公共层那一格定义 / 出口 / 那把键。
           定义认的是**对象方法简写**那个形状（`,` 或 `{` 之后紧跟 `after(`），
           于是调用点 `Toast.after(`（前面是 `.`）不会被算成第二处定义；
           `reloadAfter(` 是另一个名字，词法器给的是整块 `reloadAfter`，也不会混进来。 */
        if (t.t === 'id' && t.v === 'after' && nx && nx.t === 'p' && nx.v === '('
          && pv && pv.t === 'p' && (pv.v === ',' || pv.v === '{')) {
          naDefs.push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && t.v === 'after' && pv && pv.t === 'p' && pv.v === '.'
          && nx && nx.t === 'p' && nx.v === '(') {
          naCalls.after++; naCallSites.after.push(it.f + ':' + t.line);
        }
        if (t.t === 'str' || t.t === 'tpl') {
          const sc26 = String(t.s || '');
          if (sc26.indexOf('正在刷新') >= 0) naOldPhrase.push(it.f + ':' + t.line);
          if (sc26.indexOf('__toast_after_reload') >= 0) naKeySites.push(it.f + ':' + t.line);
        }
        /* ㉗ 名词写法：旧句子 / 禁词 / 新句子 / 那三个卡上的标签。
           全部只读**词法器取出的字符串内容**（`t.s`），所以：
             · 注释里讲这段历史（「以前那句写着注册路由里没有…」）不算违规；
             · 对象键 `{ 供应方: tp.id }` 是标识符不是字符串，也不算 —— 那是助手回包里的字段名，
               改了会让 AI 读到的 JSON 换键，与「界面上那句话的写法」是两件事。 */
        if (t.t === 'str' || t.t === 'tpl') {
          const sc27 = String(t.s || '');
          for (const p of NM_OLD) {
            if (sc27.indexOf(p) < 0) continue;
            (nmOldSites[p] = nmOldSites[p] || []).push(it.f + ':' + t.line);
          }
          for (const w of NM_BAN) {
            if (sc27.indexOf(w) < 0) continue;
            (nmBanSites[w] = nmBanSites[w] || []).push(it.f + ':' + t.line);
          }
          for (const p of Object.keys(NM_NEW)) {
            const n = sc27.split(p).length - 1;
            if (!n) continue;
            (nmNewSites[p] = nmNewSites[p] || []).push(it.f + ':' + t.line);
          }
          for (const p of Object.keys(NM_ANCHOR)) {
            const n = sc27.split(p).length - 1;
            if (!n) continue;
            (nmAnchorSites[p] = nmAnchorSites[p] || []).push(it.f + ':' + t.line);
          }
        }
        /* ㉘ 取帧外壳：① 别处自建 video / ② 那一行单独的属性 / ③ 两个出口 / ④ release 的定义。
           ③ 分两头数：页面写 `Wb.vframe.el(`（前驱是 `.` 的那个 vframe），公共层自己那份 grab 写 `this.el(`
           —— 只数后者的话「grab 退回内联一份、页面全走公共」会被读成同一件事。 */
        if (t.t === 'id' && t.v === 'createElement' && nx && nx.t === 'p' && nx.v === '('
          && T[k + 2] && (T[k + 2].t === 'str' || T[k + 2].t === 'tpl') && String(T[k + 2].s) === 'video'
          && it.f !== VF_LIB) {
          vfCreate.push(it.f + ':' + t.line);
        }
        if ((t.t === 'str' || t.t === 'tpl') && String(t.s) === 'playsinline') vfInline.push(it.f + ':' + t.line);
        if (t.t === 'id' && t.v === 'vframe' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && namedSites(vfCallSites, T[k + 2].v)
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === '(') {
          const nm28 = T[k + 2].v;
          vfCalls[nm28]++; vfCallSites[nm28].push(it.f + ':' + t.line);
        }
        if (it.f === VF_LIB && t.t === 'id' && t.v === 'this' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && namedSites(vfCallSites, T[k + 2].v)
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === '(') vfThis[T[k + 2].v]++;
        /* ④ 认的是「方法简写 + 恰好一个形参」那个形状（`el(src) {`），不是光一个名字：
           `release` 这个名字全站有好几颗各管各的资源（director.html 那颗拆的是 Web Audio 节点，
           proxy.js / ui.js 里那几个是名额与 IndexedDB 连接的让路），按名字数会把它们全算成副本。
           `el` 数全站（工厂只许一只），`release` 只数 workbench.js 里那一颗（钉的是「那一份还在」，
           不是「同名方法全站唯一」）。 */
        if (t.t === 'id' && (t.v === 'el' || t.v === 'release')
          && pv && pv.t === 'p' && (pv.v === '{' || pv.v === ',')
          && nx && nx.t === 'p' && nx.v === '(' && T[k + 2] && T[k + 2].t === 'id'
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === ')'
          && T[k + 4] && T[k + 4].t === 'p' && T[k + 4].v === '{') {
          if (t.v === 'el') vfDefs.push(it.f + ':' + t.line);
          else if (it.f === VF_LIB) vfRelDefs.push(it.f + ':' + t.line);
        }
        /* ㉙ 倒扫那趟循环：`localStorage.length -` 是「倒着数」的身份证（正着扫写成 `i < localStorage.length`，
           后面跟的是 `;`，照不到）；定义认对象方法简写那个形状，于是 `Store.sweep(` 不会被算成第二处定义。 */
        if (t.t === 'id' && t.v === 'localStorage' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && T[k + 2].v === 'length'
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === '-') swBack.push(it.f + ':' + t.line);
        if (t.t === 'id' && t.v === 'sweep' && nx && nx.t === 'p' && nx.v === '('
          && pv && pv.t === 'p' && (pv.v === '{' || pv.v === ',')) swDefs.push(it.f + ':' + t.line);
        if (t.t === 'id' && t.v === 'Store' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && T[k + 2].v === 'sweep'
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === '(') {
          swCalls++; swCallSites.push(it.f + ':' + t.line);
        }
        /* ㉚ 反问别名：`.question` 只会在解析那一份里出现（`questions` 是另一个 token，OpenAI 回包顶层那个键
           与它同名不同词，不会被算进来）。上限三个数各圈各的文件，混用即红。 */
        if (t.t === 'id' && t.v === 'question' && pv && pv.t === 'p' && pv.v === '.') qaAlias.push(it.f + ':' + t.line);
        if (t.t === 'id' && t.v === 'qaOf' && nx && nx.t === 'p' && nx.v === '(') {
          if (pv && pv.t === 'p' && (pv.v === '{' || pv.v === ',')) qaDefs.push(it.f + ':' + t.line);
          else if (pv && pv.t === 'p' && pv.v === '.') { qaCalls++; qaCallSites.push(it.f + ':' + t.line); }
        }
        if (t.t === 'id' && namedSites(qaMaxSites, t.v)) qaMaxSites[t.v].push(it.f + ':' + t.line);
        /* ㉛ 四颗「存回本机」：① 在途旗标只有一个人在写 / ② 六个 function 定义 / ③ 页面调用 / ④ 那两句措辞。
           ② 认的是 `function <名字>`，③ 认的是 `AssetLocal.<名字>(` —— 公共层内部裸调那几个
           （pullBtn 里调 pullBusy / pullBtnTitle）不算页面调用，正好让③ 只数到那四页。 */
        if (t.t === 'id' && t.v === 'dataset' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && T[k + 2].v === 'busy' && it.f !== PB_LIB) {
          pbBusySites.push(it.f + ':' + t.line);
        }
        if (t.t === 'id' && t.v === 'function' && nx && nx.t === 'id' && namedSites(pbDefSites, nx.v)) {
          pbDefs[nx.v]++; pbDefSites[nx.v].push(it.f + ':' + t.line + ' function ' + nx.v);
        }
        if (t.t === 'id' && t.v === 'AssetLocal' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && namedSites(pbCallSites, T[k + 2].v)
          && T[k + 3] && T[k + 3].t === 'p' && T[k + 3].v === '(') {
          const nm31 = T[k + 2].v;
          pbCalls[nm31]++; pbCallSites[nm31].push(it.f + ':' + t.line);
        }
        if (t.t === 'str' || t.t === 'tpl') {
          const sc31 = String(t.s || '');
          if (sc31.indexOf('字节还不在本机') >= 0) pbTitle1.push(it.f + ':' + t.line);
          if (sc31.indexOf('一条都不会重下') >= 0) pbTitle2.push(it.f + ':' + t.line);
        }
        /* ⑮ 页面**引用**公共层那一份（`Capabilities.<名字>`，也认 `window.Capabilities && Capabilities.<名字>`
           这种守卫写法）与页面**又写了一份同名实现**要分开数：前者是这一档要的，后者即是分叉。 */
        if (t.t === 'id' && t.v === 'Capabilities' && nx && nx.t === 'p' && nx.v === '.'
          && T[k + 2] && T[k + 2].t === 'id' && CAP_SET.has(T[k + 2].v)) {
          const nm = T[k + 2].v;
          capRefs[nm] = (capRefs[nm] || 0) + 1;
          (capRefSites[nm] = capRefSites[nm] || []).push(it.f + ':' + t.line);
        }
        /* 同名定义 = 第二份实现，三种写法都要抓：
             function comboGaps(…)             —— 真重写一份判据
             const ROLE_ZH = { first_frame: … } —— 抄一张表
             const comboLabel = cb => cb.mode   —— 自己拼模式名
           但「一行转发」（右边点的就是 Capabilities.同名）是故意留下的：两页都要在标记里用短名，
           把长守卫表达式抄四遍只会让标记读不动。所以判据是**初始化里有没有点到 Capabilities.同名**，
           不是「页面里出没出现过这个名字」—— 后者会把转发也照红，改的人只能把公共层再抄一遍。 */
        if (it.html && t.t === 'id' && CAP_SET.has(t.v) && !(pv && pv.t === 'p' && pv.v === '.')) {
          if (pv && pv.t === 'id' && pv.v === 'function') {
            capClone++; capCloneSites.push(it.f + ':' + t.line + ' function ' + t.v);
          } else if (nx && nx.t === 'p' && (nx.v === '=' || nx.v === ':')) {
            let fwd = false;
            for (let j = k + 2; j < Math.min(T.length, k + 60); j++) {
              const u = T[j];
              if (u.t === 'p' && (u.v === ';' || u.v === '}')) break;
              if (u.t === 'id' && u.v === 'Capabilities' && T[j + 1] && T[j + 1].t === 'p' && T[j + 1].v === '.'
                && T[j + 2] && T[j + 2].t === 'id' && T[j + 2].v === t.v) { fwd = true; break; }
            }
            if (!fwd) { capClone++; capCloneSites.push(it.f + ':' + t.line + ' ' + t.v + ' ='); }
          }
        }
        /* 措辞与画法的指纹：这几句/标记只许在公共层出现，而且**逐句**点名 ——
           合成一个总数时，公共层删掉其中一句（另有三句顶着）照样全绿，那一半就成了空断言
           （第一版就是这么被变异 D 抓出来的）。
           读**词法器取出的字符串内容**而不是整行正则 —— 两页的正文注释里正在讲「这一档收：」
           那句原来怎么挂空尾巴，词法器剥注释，所以说明文字不会把自己照红（与 ②③ 同一套路）。 */
        if (t.t === 'str' || t.t === 'tpl') {
          const sc = String(t.s || '');
          for (const p of COPY_PHRASES) {
            if (sc.indexOf(p) < 0) continue;
            const rec = copyHits[p];
            if (it.html) { rec.page++; copyPageSites[p].push(it.f + ':' + t.line); }
            else { rec.lib++; copyLibSites[p].push(it.f + ':' + t.line); }
          }
          /* ㉑ 老措辞按**字符串内容**数（词法器剥注释，所以「以前这里说过文本至少 5 个字」那种
             讲历史的注释不算）。公共层那两句 canonical 拼法同时数一遍当底座：
             只剩「页面不许出现」这一头，把 CharLimits.why 整块删掉也能全绿。 */
          for (const p of CL_OLD_PHRASES) {
            if (sc.indexOf(p) < 0) continue;
            clOldHits[p]++;
            clOldSites[p].push(it.f + ':' + t.line + (it.html ? '' : '（公共层）'));
          }
          if (!it.html && sc.indexOf('个字（') >= 0) { clLibChars++; clLibSites.push(it.f + ':' + t.line); }
          if (!it.html && sc.indexOf('至少 ') >= 0) clLibMin++;
          /* ⑯-③ 对话那一行与轮次记录的类名：页面（*.html）里出现一次就是第二套实现 */
          for (const p of CHAT_MARKS) {
            if (sc.indexOf(p) < 0 || !it.html) continue;
            chatPage[p]++; chatPageSites[p].push(it.f + ':' + t.line);
          }
        }
        /* ⑯-① 六个 builder：「定义」= 名字后面直接跟 '(' 而且前面不是 '.'
           （`polishExtra(o) {` 这种对象方法简写；`TextAI.polishExtra(…)` 与 `this.polishExtra(…)` 都带前驱，算引用）。
           ⑯-② 引用按文件现记，页面有没有真的用它、用了几页都从这份集合读。 */
        if (t.t === 'id' && POLISH_SET.has(t.v)) {
          if (!(pv && pv.t === 'p' && pv.v === '.') && !(pv && pv.t === 'id' && pv.v === 'this')
            && nx && nx.t === 'p' && nx.v === '(') {
            pDefs[t.v]++; pDefSites[t.v].push(it.f + ':' + t.line);
          }
          /* 引用是 `TextAI.<名字>`：`pv` 停在中间那个点上，供应方要往前再取一位 */
          const pp = T[k - 2];
          if (pv && pv.t === 'p' && pv.v === '.' && pp && pp.t === 'id' && pp.v === 'TextAI') pRefFiles[t.v].add(it.f);
        }
        /* ⑯-③ 入口 = 页面里的 `InlinePolish.show(` / `.interactive(`；
           接线 = 页面里的 `onFollow:` / `onFollow =`。两边都只数页面，ui.js 里读 `o.onFollow` 的那几处不算。 */
        if (it.html) {
          if (t.t === 'id' && t.v === 'InlinePolish' && nx && nx.t === 'p' && nx.v === '.'
            && T[k + 2] && T[k + 2].t === 'id' && (T[k + 2].v === 'show' || T[k + 2].v === 'interactive')) {
            polishEntries++; polishEntrySites.push(it.f + ':' + t.line + ' ' + T[k + 2].v);
          }
          if (t.t === 'id' && t.v === 'onFollow' && nx && nx.t === 'p' && (nx.v === ':' || nx.v === '=')) {
            followPassed++; followPassSites.push(it.f + ':' + t.line);
          }
        }
      }
    }
  }
  if (!scanned) { bad('§J', '一段源码都没扫到 —— 空断言比没有断言更坏'); return 0; }
  /* ⑯ AI 润色那一族（定义各一份且在 assetlib.js / 至少两页真的在用 / 对话面板只有一处标记 / 入口都接线）。
     最后一条还要有**底座**：入口数为 0 就是尺子没照到（`InlinePolish` 改名了），不许退化成空断言。 */
  POLISH_FNS.forEach(n => {
    if (pDefs[n] !== 1) bad('§J', 'TextAI.' + n + ' 的定义有 ' + pDefs[n] + ' 处（'
      + (pDefSites[n].join('、') || '一处都没有') + '）—— 对模型的交代只许在 assetlib.js 写一份，'
      + '页面抄一遍就是「同一段回答在不同页面发给模型的意思不一样」');
    else if (pDefSites[n][0].split(':')[0] !== 'assetlib.js')
      bad('§J', 'TextAI.' + n + ' 的唯一定义在 ' + pDefSites[n][0] + '，不在 assetlib.js —— 判据和实现脱节了');
    const min = POLISH_MIN_PAGES[n] || 2;
    const fs2 = [...pRefFiles[n]];
    if (fs2.length < min) bad('§J', n + ' 只有 ' + (fs2.join('、') || '没有页面') + ' 在用（期望至少 ' + min + ' 页）'
      + ' —— 只有一页在用的公共层，下一轮就会有人在第二页另写一份');
  });
  CHAT_MARKS.forEach(p => {
    if (chatPage[p]) bad('§J', '页面里自己拼了 .' + p + '：' + chatPageSites[p].join('、')
      + ' —— 「接着对话」那一行只在 ui.js 的 InlinePolish.show 画一份，页面另拼就是第二套样式与第二套 busy 记账');
  });
  if (!polishEntries) bad('§J', '一处 InlinePolish.show / interactive 都没扫到 —— 润色入口判据没底座（改名了？），不许悄悄退化成空断言');
  if (followPassed !== polishEntries) bad('§J', '润色入口 ' + polishEntries + ' 处（' + polishEntrySites.join('、')
    + '），传 onFollow 的只有 ' + followPassed + ' 处（' + followPassSites.join('、')
    + '）—— 少一头就是有一个入口「面板上有那颗按钮，点了什么都不做」，多一头就是接了线却没画面板');
  PULL_SCOPES.forEach(spec => {
    if (!scopeSeen.has(spec.file))
      bad('§J', spec.file + ' 里找不到 ' + spec.fn + '() —— 「存回本机」的范围函数没了'
        + '（改名了，或者这一页的手动入口被删了）：这一档尺子没底座，不许悄悄退化成空断言');
  });
  if (scopeBad.length) bad('§J', '「存回本机」的范围跟「不显示云端任务」走了：' + scopeBad.join('、')
    + ' —— 三个开关全开时被藏起来的恰恰就是本机还没有字节的那批（那正是按钮唯一的目标），'
    + '跟着藏走会当场筛出 0 条、按钮成了「点了只会说都已经有了」的假控件。'
    + '范围要问**没带藏**的那一份：工作台 mergedItems()、资产库 applyFilters({includeHidden:true})、'
    + '收藏与素材库本来就不带藏');

  if (defs !== 1) bad('§J', 'b64Bytes 的定义有 ' + defs + ' 处（' + (defSites.join('、') || '一处都没有') + '）—— base64→字节只许一份');
  else if (defSites[0].split(':')[0] !== 'ui.js') bad('§J', 'b64Bytes 的唯一定义在 ' + defSites[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (calls < 4) bad('§J', 'b64Bytes 只被调 ' + calls + ' 次（应至少 4：ui.js 的 DataSync、assetlib.js、drama.js、director.html）—— 有一处改回了内联写法');
  if (pickers) bad('§J', '又用了「下载落点」那两个选择器：' + pickerSites.join('、') + ' —— 那一层已删，全站只剩 Net.save 一份（注释里提到不算）');
  if (toastDefs) bad('§J', '页面又自建了 toast()：' + toastSites.join('、') + ' —— 提示组件只有 ui.js 的 window.Toast 一份');
  if (ioInPage) bad('§J', '页面又自建了续拉：' + ioSites.join('、') + ' —— 页面级续拉走 Wb.pager.sentinel（模块内那几处是允许的）');
  if (unitInWb) bad('§J', 'workbench.js 里又出现了字节单位数组 —— Wb.fmtSize 必须委托 window.fmtBytes，函数体只留一份');
  const unitFiles = [...new Set(unitSites.map(s => s.split(':')[0]))].sort();
  if (unitFiles.join(',') !== 'ui.js')
    bad('§J', '字节单位数组出现在 ' + (unitSites.join('、') || '没有') + ' —— 只许 ui.js 的 fmtBytes 一处'
      + '（多一处就是有人又抄了一遍；一处没有 = fmtBytes 自己没了，那同样要红，不能让空断言冒充全绿）');
  if (chipRows) bad('§J', '页面又自己拼了芯片行：' + chipRowSites.join('、') + ' —— 芯片行只有 ui.js 的 window.Chips 一份');
  /* 两头都要在：页面 0 处自建**且** Chips 有定义有调用。少一头就是尺子坏了，
     而「0 处自建」在 Chips 也没了的情况下和「真的一处都没有」长得一模一样。 */
  if (chipsDefs !== 1) bad('§J', 'window.Chips 的定义有 ' + chipsDefs + ' 处（' + (chipsDefSites.join('、') || '一处都没有') + '）—— 芯片行只许一份');
  else if (chipsDefSites[0].split(':')[0] !== 'ui.js') bad('§J', 'window.Chips 的唯一定义在 ' + chipsDefSites[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (chipsCalls < 4) bad('§J', 'window.Chips.render 只被调 ' + chipsCalls + ' 次（应至少 4：资产库 3 行、角色库、收藏、用量）—— 有一处改回了自己拼');
  /* ⑰ 时间文案两份：形状各只许出现一次、且落在 workbench.js 的那两个函数里，调用点两头都要在。
     与上面字节单位数组同一立场：**一处没有也要红**（那等于 fmtSec 自己没了，空断言不配当全绿）。 */
  if (secShapes !== 1) bad('§J', '「X 分 Y 秒」的拼法有 ' + secShapes + ' 处（'
    + (secShapeSites.join('、') || '一处都没有') + '）—— 耗时文案只许 workbench.js 的 Wb.fmtSec 一处'
    + '（多一处就是有人又抄了一遍；一处没有 = fmtSec 自己没了，那同样要红）');
  else if (secShapeSites[0].split(':')[0] !== 'workbench.js') bad('§J', '唯一的「X 分 Y 秒」在 ' + secShapeSites[0]
    + '，不在 workbench.js 的 fmtSec 里 —— 判据和实现脱节了');
  if (clockShapes !== 1) bad('§J', 'mm:ss 的拼法有 ' + clockShapes + ' 处（'
    + (clockShapeSites.join('、') || '一处都没有') + '）—— 播放器读数只许 workbench.js 的 Wb.fmtClock 一处');
  else if (clockShapeSites[0].split(':')[0] !== 'workbench.js') bad('§J', '唯一的 mm:ss 拼法在 ' + clockShapeSites[0]
    + '，不在 workbench.js 的 fmtClock 里 —— 判据和实现脱节了');
  if (fmtSecCalls < 3) bad('§J', 'Wb.fmtSec 只被调 ' + fmtSecCalls + ' 次（应至少 3：' + fmtSecCallSites.join('、')
    + '）—— 详情面板的耗时行、每秒跳动的计时器、导演台候选卡，有一处退回自己拼');
  if (fmtClockCalls < 5) bad('§J', 'Wb.fmtClock 只被调 ' + fmtClockCalls + ' 次（应至少 5：' + fmtClockCallSites.join('、')
    + '）—— 剪辑甲板 / 候选播放器 / 插针跳转后的读数，有一处退回自己拼');
  /* ⑲-a 「自己写一遍非法字符清洗」按**整行文本**数，不走词法器：
     那串字符类写在正则字面量里，而词法器不把正则当 token（它会把 `\\/:*?"<>|` 拆成一堆 p / str），
     按 token 认形状就会漏。改成同行两个条件：出现保留字符类 **且** 出现 `.replace(` ——
     后者把它与「校验导入归档文件名」那种 `!/^[^…]+\.md$/`（proxy.js:3771，不写回、不清洗）分开，
     注释里描述这一族的行（`\ / : * ? " < > |` 带空格）同样两个条件都不满足。 */
  for (const it of items) {
    if (!exists(it.f)) continue;
    read(it.f).split(/\r?\n/).forEach((L, i) => {
      if (L.indexOf('/:*?"<>') >= 0 && L.indexOf('.replace(') >= 0) {
        sanitizeShapes++; sanitizeSites.push(it.f + ':' + (i + 1));
      }
      /* ⑳-a 同一行既碰 localStorage 又点名那三个键 = 有人又开始自己读写它们。
         不要求带引号（写 `"sk_poll_sec"` 也算）。两张同步白名单（ui.js 的 SYNCABLE、
         设置页的 EXPORTABLE）里那些行只有键名、没有 localStorage，不会误算；
         ui.js 里那张 NUMS 表与讲这件事的注释同理。
         ⑳-b 那三个输入框的标记里再出现 min= / max= —— 区间归那张表，标记里写死就是第四份上下限。 */
      if (L.indexOf('localStorage') >= 0 && NET_KEYS.some(k => L.indexOf(k) >= 0)) {
        netKeyIO++; netKeyIOSites.push(it.f + ':' + (i + 1));
      }
      if (NET_FIELDS.some(f => L.indexOf('id="' + f + '"') >= 0)
        && (L.indexOf('min=') >= 0 || L.indexOf('max=') >= 0)) {
        netMarkBounds++; netMarkBoundsSites.push(it.f + ':' + (i + 1));
      }
    });
  }
  /* ⑱ 日期与时刻（2026-10-15 收成一份的那一族）。三条都是「两头」：
     禁的东西 0 处**且**公共那一份要有定义有调用 —— 只查前一条，把 dayKey 整块删掉也会全绿。 */
  if (localeDateCalls) bad('§J', '又用 locale API 排日期/时刻：' + localeDateSites.join('、')
    + ' —— 换成 ui.js 的 dayKey / fmtHM / fmtHMS / fmtWhen / fmtWhenSec'
    + '（那三个 API 换台机器就换一种写法，而「带不带秒」「显不显示年份」各页还抄得不一样）');
  if (dayShapes !== 2) bad('§J', '手拼「年-月-日」的形状有 ' + dayShapes + ' 处（'
    + (dayShapeSites.join('、') || '一处都没有') + '）—— 浏览器那一份只许 ui.js 的 dayKey、'
    + '代理那一份只许 proxy.js 的 dayPart（Node 进程够不着 window），页面里一处都不许留'
    + '；一处没有 = 公共实现自己没了，同样要红');
  else {
    const at = dayShapeSites.map(s => s.split(':')[0]).sort().join('+');
    if (at !== 'proxy.js+ui.js') bad('§J', '那两处手拼落在 ' + dayShapeSites.join('、')
      + '，不是 ui.js 的 dayKey 与 proxy.js 的 dayPart —— 判据和实现脱节了');
  }
  const WHEN_MIN_CALLS = { dayKey: 6, fmtHM: 1, fmtHMS: 2, fmtWhen: 8, fmtWhenSec: 2 };
  WHEN_NAMES.forEach(n => {
    if (whenDefs[n] !== 1) bad('§J', 'ui.js 的 ' + n + ' 有 ' + whenDefs[n] + ' 处定义（'
      + (whenDefSites[n].join('、') || '一处都没有') + '）—— 这一族只许一份实现');
    else if (whenDefSites[n][0].split(':')[0] !== 'ui.js') bad('§J', '唯一的 ' + n + ' 定义在 '
      + whenDefSites[n][0] + '，不在 ui.js —— 判据和实现脱节了');
    if (whenCalls[n] < WHEN_MIN_CALLS[n]) bad('§J', 'window.' + n + ' 只被调 ' + whenCalls[n] + ' 次（应至少 '
      + WHEN_MIN_CALLS[n] + '：' + whenCallSites[n].join('、') + '）—— 有一处退回自己拼，或是这一份没人用了');
  });
  /* ⑲ 下载文件名（两头同上）。 */
  if (sanitizeShapes !== 2) bad('§J', '自己写「文件系统保留字符」的清洗有 ' + sanitizeShapes + ' 处（'
    + (sanitizeSites.join('、') || '一处都没有') + '）—— 浏览器那一份只许 ui.js 的 fileSafe、'
    + '代理那一份只许 proxy.js 的 fileSafe（Node 进程够不着 window），页面里一处都不许留；'
    + '留一处就有「同一张图两页下出来名字不同」「结尾的点与空格谁处理」这类各漂一口的错');
  else {
    const at2 = sanitizeSites.map(s => s.split(':')[0]).sort().join('+');
    if (at2 !== 'proxy.js+ui.js') bad('§J', '那两处清洗落在 ' + sanitizeSites.join('、')
      + '，不是 ui.js 与 proxy.js 各自那一份 fileSafe —— 判据和实现脱节了');
  }
  const FN_DEF_EXPECT = { fileSafe: 2, fileStamp: 1, isAudioType: 1, mediaKindOf: 1, fileExtOf: 1 };
  const FN_DEF_FILES = { fileSafe: 'proxy.js+ui.js', fileStamp: 'ui.js',
    isAudioType: 'ui.js', mediaKindOf: 'ui.js', fileExtOf: 'ui.js' };
  const FN_MIN_CALLS = { fileSafe: 9, fileStamp: 4, isAudioType: 12, mediaKindOf: 10, fileExtOf: 6 };
  // 先量过：fileSafe 9、fileStamp 4、isAudioType 14、mediaKindOf 11、fileExtOf 7（各页 + 公共层，见 §J 末行读数）
  FN_NAMES.forEach(n => {
    if (fnDefs[n] !== FN_DEF_EXPECT[n]) bad('§J', n + ' 有 ' + fnDefs[n] + ' 处定义（'
      + (fnDefSites[n].join('、') || '一处都没有') + '），期望 ' + FN_DEF_EXPECT[n]
      + ' —— 这一族只许浏览器一份、代理那份只在 Node 侧多一份');
    else {
      const df = fnDefSites[n].map(s => s.split(':')[0]).sort().join('+');
      if (df !== FN_DEF_FILES[n]) bad('§J', '唯一的 ' + n + ' 定义在 ' + fnDefSites[n].join('、')
        + '，不在 ' + FN_DEF_FILES[n] + ' —— 判据和实现脱节了');
    }
    if (fnCalls[n] < FN_MIN_CALLS[n]) bad('§J', 'window.' + n + ' 只被调 ' + fnCalls[n] + ' 次（应至少 '
      + FN_MIN_CALLS[n] + '：' + fnCallSites[n].join('、') + '）—— 有一处退回自己拼，或这一份没人用了');
  });
  /* ⑲-d 三块读法的「页面自己再写一遍」形状各只许留一处，且必须落在 ui.js 的那一份实现里。
     两头同一族的老规矩：0 处也要红（把 ui.js 那三行删掉，页面就会长回四份各漂）。
     认的是「同一行同时出现这几个字符串 token 且有 ===」：
       · 音频两个名字（音频 / 音乐）一起比 = 自己在判「是不是声音」；
       · video / image / audio 三个一起比 = 自己在把类型名换成媒体类别；
       · mp4 / png 一起出现 = 自己在猜下载扩展名（wav 那一份也在这行，但只认这两个就够点名）。 */
  const fnLineHits = need => {
    const out = [];
    for (const b of fnLines.values())
      if (b.eq && need.every(x => b.s.has(x))) out.push(b.f + ':' + b.line);
    return out.sort();
  };
  const FN_SHAPE_WHY = {
    audio: '「是不是声音」只许 ui.js 的 isAudioType 一份（本机产物叫「音频」、平台声明叫「音乐」，'
      + '少认一个名字就有音频被当图片下载 —— 这一族当初正是这么漂的）',
    kind: '「类型名 → video/image/audio」只许 ui.js 的 mediaKindOf 一份（灯箱、缩略图、槽位过滤各抄一遍时，'
      + '平台新增一个类型名要改四个地方）',
    ext: '「一条素材的下载扩展名」只许 ui.js 的 fileExtOf 一份（先认条目自己的 format，认不出才按类型猜）',
  };
  const FN_SHAPE_EXPECT = {
    audio: { label: '是不是声音', need: ['音频', '音乐'], at: 'ui.js' },
    kind: { label: '类型名换成媒体类别', need: ['audio', 'image', 'video'], at: 'ui.js' },
    ext: { label: '猜下载扩展名', need: ['mp4', 'png'], at: 'ui.js' },
  };
  const fnShapeHits = {};
  Object.keys(FN_SHAPE_EXPECT).forEach(k => {
    const spec = FN_SHAPE_EXPECT[k];
    const sites = fnLineHits(spec.need);
    fnShapeHits[k] = sites;
    if (sites.length !== 1) bad('§J', '自己在「' + spec.label + '」那一档又写了一遍的形状有 '
      + sites.length + ' 处（' + (sites.join('、') || '一处都没有') + '）—— ' + FN_SHAPE_WHY[k]
      + '；一处没有 = 公共实现自己没了，同样要红');
    else if (sites[0].split(':')[0] !== spec.at) bad('§J', '那一处形状落在 ' + sites[0]
      + '，不在 ' + spec.at + ' —— 判据和实现脱节了');
  });
  /* ⑳ 「网络与刷新」那三个数字（两头）。只查「不许自己读写那三个键」这一头，
     把 ui.js 的 NUMS 整块删掉、页面也不问了 —— 一样全绿，而超时/重试/轮询会退成各写各的硬编码。 */
  if (netKeyIO) bad('§J', '又出现自己读写那三个键的行：' + netKeyIOSites.join('、')
    + ' —— 读写只许走 ui.js 的 Net.num / Net.storedNum / Net.setNum（区间与默认值在 Net.NUMS 一张表里），'
    + '页面再写一遍字面量就是第五把夹取：设置页填得进去那个数、运行层按另一个上限走，界面上看不出被截过');
  if (netMarkBounds) bad('§J', '那三个输入框的标记里又写了区间：' + netMarkBoundsSites.join('、')
    + ' —— min / max 由设置页从 Net.NUMS 现填，标记里再写一份就是「标记说 5..300、表说 5..600」那种两边都真、合起来假');
  if (numsDefs !== 1) bad('§J', '`const NUMS` 有 ' + numsDefs + ' 处定义（'
    + (numsDefSites.join('、') || '一处都没有') + '）—— 这张表只许 ui.js 一份，两处就有两份上下限');
  else if (numsDefSites[0].split(':')[0] !== 'ui.js') bad('§J', '唯一的 NUMS 表在 ' + numsDefSites[0]
    + '，不在 ui.js 的 Net 里 —— 轮询器与设置页够不着它，等于没有这张表');
  const NET_REF_FILE = { NUMS: 'settings.html', num: 'settings.html', setNum: 'settings.html', storedNum: 'workbench.js' };
  NET_NAMES.forEach(n => {
    if (!netRefs[n]) bad('§J', 'Net.' + n + ' 一处都没被问到 —— 这张表没人读，'
      + NET_REF_FILE[n] + ' 那一边多半退回了硬编码');
    else {
      const nf = [...new Set(netRefSites[n].map(s => s.split(':')[0]))];
      if (!nf.includes(NET_REF_FILE[n])) bad('§J', 'Net.' + n + ' 的落点是 ' + nf.join('、')
        + '，没有 ' + NET_REF_FILE[n] + ' —— 判据和实现脱节了');
    }
  });
  /* ㉑ 字数闸那一族的四头（见上面那一段说明）。缺一头是另一种坏法：
       ① 定义恰好 1 处且在 assetlib.js —— 多一处就是有人又写了一份；
       ② 页面里那六句老措辞 0 处 —— 中一处即是第二份口径（措辞与计数各漂一半）；
       ③ 公共层「个字（」「至少 」两句还在 —— 没有它，② 是永远的空断言；
       ④ 落点三头：两页各自真的在问它、assetlib 的 createBody 也在问（提交那一路是最后一道闸）。 */
  if (clDefs !== 1) bad('§J', '`window.CharLimits = {` 的定义有 ' + clDefs + ' 处（应恰好 1 处）'
    + (clDefSites.length ? '：' + clDefSites.join('、') : '')
    + ' —— 「这段文本几个字、在不在这一家声明的区间里、差几个字」全站只许这一份');
  else if (!clDefSites[0].startsWith('assetlib.js')) bad('§J', 'CharLimits 的唯一定义在 ' + clDefSites[0]
    + '，不在 assetlib.js —— 判据和实现脱节了');
  CL_OLD_PHRASES.forEach(p => {
    const pageSites = clOldSites[p].filter(s => /\.html:/.test(s));
    if (pageSites.length) bad('§J', '页面里又出现自己拼的字数措辞「' + p + '」：' + pageSites.join('、')
      + ' —— 上下限、区间写法、现在几个字与差几个字都在 CharLimits 一份里；'
      + '页面再拼一句就会出现「界面上写着 5 个字」而「按钮说不达门槛」（trim 与不 trim 两套计数）');
  });
  if (clLibChars < 2) bad('§J', 'assetlib.js 里带「个字（」的措辞只剩 ' + clLibChars + ' 处（先量过的是 2 处：'
    + '「至少 …个字（现在 …）」与「最多 …个字（现在 …）」）—— 尺子没底座，'
    + '② 那一头的「页面不许出现」就成了永远的空断言');
  if (clLibMin < 1) bad('§J', 'assetlib.js 里没有「至少 」那一句（现量 ' + clLibMin + ' 处）—— '
    + 'CharLimits.why 的下限那一半没了，而页面那头照样全绿');
  [['why', 2], ['tts', 2]].forEach(pair => {
    const n = pair[0], min = pair[1];
    const fs = [...new Set(clRefSites[n].map(s => s.split(':')[0]))];
    ['director.html', 'studio.html'].forEach(f => {
      if (!fs.includes(f)) bad('§J', f + ' 没问 CharLimits.' + n + ' —— 它要么退回了自己拼措辞，'
        + '要么这一路的字数闸整块不见了（现在的落点：' + (clRefSites[n].join('、') || '无') + '）');
    });
    if (clRefs[n] < min) bad('§J', 'CharLimits.' + n + ' 只被问 ' + clRefs[n] + ' 次（应至少 ' + min + '）—— '
      + '有一处退回了自己算上下限');
  });
  /* 同一个断言按文件各量一遍（上面那一条量的是全局总数，导演台删掉一路时它够不着）。 */
  const clFileRefs = {};
  CL_MEMBERS.forEach(n => clRefSites[n].forEach(s => {
    const f = s.split(':')[0], m = clFileRefs[f] || (clFileRefs[f] = {});
    m[n] = (m[n] || 0) + 1;
  }));
  Object.keys(CL_MIN_FILE).forEach(f => {
    const got = clFileRefs[f] || {};
    Object.keys(CL_MIN_FILE[f]).forEach(n => {
      const min = CL_MIN_FILE[f][n], have = got[n] || 0;
      if (have < min) bad('§J', f + ' 问 CharLimits.' + n + ' ' + have + ' 次（先量过的是 ' + min
        + ' 处：' + clRefSites[n].filter(s => s.startsWith(f)).join('、') + '）—— '
        + (CL_MIN_FILE_WHY[n] || '这一族的落点少了一处'));
    });
  });
  if (!clRefSites.prompt.some(s => s.startsWith('assetlib.js')))
    bad('§J', 'assetlib.js 的 createBody 没问 CharLimits.prompt —— 提交前那一道闸要么退回了自己拼，'
      + '要么整块删了（页面判得再对，发出去还是被平台拒成 422）');
  if (clRefTotal < 20) bad('§J', 'CharLimits 那一族只看到 ' + clRefTotal + ' 处成员引用'
    + '（先量过的是 27 处：director.html 7 / studio.html 7 / assetlib.js 13）—— 少一头就是判据或调用点坏了');
  if (wwDefs !== 1) bad('§J', 'TtsAdv 的 `wayWhy(way, o)` 定义有 ' + wwDefs + ' 处（应恰好 1 处：'
    + (wwDefSites.join('、') || '一处都没有') + '）—— 「定音色缺哪一格」两页各写一句，'
    + '就是本轮收掉的那一对（一边「要先写一段声音描述」、一边「必须填写风格 / 音色描述」）');
  ['director.html', 'studio.html'].forEach(f => {
    if (!wwCallSites.some(s => s.startsWith(f))) bad('§J', f + ' 没走 TtsAdv.wayWhy —— '
      + '它自己留了一份「设计档要描述 / 复刻档要参考音频」的判断，两页迟早又长成两种说法');
  });
  /* ㉒ 两头（与 ㉑ 同一形状：先钉尺子的底座，再钉页面的那头）。 */
  const vtLib = vtPrefixSites.filter(s => s.startsWith('workbench.js'));
  const vtPage = vtPrefixSites.filter(s => /\.html:/.test(s));
  if (vtLib.length !== 2) bad('§J', 'workbench.js 里内容为 view- 的字面量有 ' + vtLib.length + ' 处（先量过的是 2 处：'
    + '清名单那一处 + 贴当前档那一处；全部落点：' + (vtPrefixSites.join('、') || '一处都没有') + '）—— '
    + '少一处就是 apply() 不贴容器或不清名单（切档位没反应 / 两个类同时挂着），'
    + '而「页面里不许出现」那一头当场变成永远的空断言');
  if (vtPage.length) bad('§J', '页面里又自己写了一遍容器类名前缀 view-：' + vtPage.join('、')
    + ' —— 把当前档贴到容器上只在 Wb.viewToggle 有一份；三页各抄一份 remove 清单就是这一轮收掉的那三处'
    + '（资产库那份多清一个早已不存在的 view-card、另两页压根没清），加一档就有人漏一档');
  const vtMiss = vtCreateSites.filter(s => vtTargetedSites.indexOf(s) < 0);
  if (vtMiss.length) bad('§J', '这一处 Wb.viewToggle.create 没点名容器（target）：' + vtMiss.join('、')
    + ' —— 开关能点、存档会写、按钮会高亮，唯独容器上的那一档不跟着换：表现正是「切了档位没反应」');
  VT_PAGES.forEach(f => {
    if (!vtCreateSites.some(s => s.startsWith(f))) bad('§J', f + ' 没有 Wb.viewToggle.create 调用点 —— '
      + '那一页的展示样式开关整块不见了（现有落点：' + (vtCreateSites.join('、') || '无') + '）');
  });
  /* ㉒ 第三头：这一对档位名只许在 ui.js 点一次名（两档各一次，共 2 处）。 */
  const vtNameOut = vtModeNames.filter(s => !s.startsWith('ui.js'));
  if (vtModeNames.length !== 2 || vtNameOut.length) bad('§J',
    '展示样式的档位名（list/列表、compact/紧凑 这一对字面量）现在有 ' + vtModeNames.length + ' 处点名（应为 2 处，'
    + '且全在 ui.js 的 window.VIEW_MODES 那一行）：' + (vtModeNames.join('、') || '一处都没有') + ' —— '
    + (vtNameOut.length ? '其中页面/公共层又抄了一份：' + vtNameOut.join('、') + '；' : '')
    + '从前这一对散在七个字面量里（三页各自的 views、UI_PREFS 三行 opts、公共层兜底默认档），'
    + '改一个名字要全找一遍，漏一处就是「设置里写着列表、进来是另一种摆法」');
  if (vtViewsArgs.length) bad('§J', '这一处 Wb.viewToggle.create 还自己传档位清单（views）：' + vtViewsArgs.join('、')
    + ' —— 有几档、每档叫什么只由 ui.js 的 window.VIEW_MODES 决定，页面再传一份就等于把统一档位名那次改动的反面写回来');

  /* ㉓ 三头：被禁形状 0 处 → 那张表只有一处点名 → 公共两份两头都在。
     缺第三头 = 「把 ui.js 那两份删光、页面也不问了」照样全绿（前两头条条是 0，0 判 0 是空的）。 */
  if (pkOldSites.length) bad('§J', '又出现「供应商类型」那两个旧符号：' + pkOldSites.join('、')
    + ' —— 这一族 2026-10-15 已收进 ui.js 的 provKinds / provKindZh，页面里再写这个名字就是引用一份不存在的定义'
    + '（Node 侧那份叫 MEDIA_KIND_ZH，管的是素材不是供应方，不同名是故意的）');
  if (pkOrderSites.length) bad('§J', '又手抄了一遍四档键序 [image, video, audio, text]：' + pkOrderSites.join('、')
    + ' —— 有几档、什么顺序只由 ui.js 那张表决定，抄一份就是注册表加第五类时那一排 tab 不会跟着长');
  const pkZhOut = pkZhSites.filter(s => !s.startsWith('ui.js'));
  if (pkZhSites.length !== 1) bad('§J', '「audio 这一格叫『语音』」的形状现在有 ' + pkZhSites.length + ' 处（'
    + (pkZhSites.join('、') || '一处都没有') + '）—— 期望恰好 1 处，落在 ui.js 的 PROV_KIND_ZH 那一行；'
    + '一处都没有就是那张表没了（改名 / 删掉），这一档会退化成永远的空断言');
  else if (pkZhOut.length) bad('§J', '供应商类型那张表在 ui.js 之外又写了一遍：' + pkZhOut.join('、')
    + ' —— 两份同名不同值的表迟早被合并，而 audio 在素材那一族叫「音频」、在这里叫「语音」');
  ['provKindZh', 'provKinds'].forEach(n => {
    if (pkDefs[n] !== 1) bad('§J', n + ' 有 ' + pkDefs[n] + ' 处定义（'
      + (pkDefSites[n].join('、') || '一处都没有') + '）—— 供应商类型的名字 / 顺序只许 ui.js 一份');
    else if (!pkDefSites[n][0].startsWith('ui.js')) bad('§J', '唯一的 ' + n + ' 定义在 ' + pkDefSites[n][0]
      + '，不在 ui.js —— 判据和实现脱节了');
    if (pkCalls[n] < PK_MIN_CALLS[n]) bad('§J', 'window.' + n + ' 只被调 ' + pkCalls[n] + ' 次（应至少 '
      + PK_MIN_CALLS[n] + '，先量过是 ' + (n === 'provKindZh' ? 13 : 4) + '）—— '
      + '少一头就是页面退回自己拼类型名（' + (pkCallSites[n].join('、') || '一处都没有') + '）');
    PK_PAGES.forEach(f => {
      if (!pkCallSites[n].some(s => s.startsWith(f))) bad('§J', f + ' 没问 window.' + n + ' —— '
        + '那一页又退回自己写类型名 / 自己抄键序了（现有落点：' + (pkCallSites[n].join('、') || '无') + '）');
    });
  });

  /* ㉔ 四头。第①头单独存在是空断言（页面一份都不拼、公共层也没了 = 全绿），所以②③④三头各钉一边：
     ②钉「画法还在且只有一份」，③钉「实现还在但没人用」，④钉「措辞只有一句话」。 */
  if (acShapeSites.length) bad('§J', '又在页面 / 模块里手拼一颗 AI 芯片：' + acShapeSites.join('、')
    + ' —— 画法与那颗 ✕ 只许 ui.js 的 AiChip 一份；当年四份副本漂开的正是清除按钮那句 title 与 ✕ 的尺寸');
  if (acDefs.length !== 1) bad('§J', 'AiChip 的定义有 ' + acDefs.length + ' 处（'
    + (acDefs.join('、') || '一处都没有') + '）—— AI 芯片的画法只许 ui.js 一份，一处都没有就是整块没了（那一档会退化成空断言）');
  else if (!acDefs[0].startsWith('ui.js')) bad('§J', '唯一的 AiChip 定义在 ' + acDefs[0] + '，不在 ui.js —— 判据和实现脱节了');
  ['paint', 'text', 'picked'].forEach(n => {
    if (acCalls[n] < AC_MIN[n]) bad('§J', 'window.AiChip.' + n + ' 只被调 ' + acCalls[n] + ' 次（应至少 '
      + AC_MIN[n] + '，先量过是 ' + AC_MIN[n] + '）—— 有一处退回自己拼 innerHTML 或整块不画芯片了（现有落点：'
      + (acCallSites[n].join('、') || '无') + '）');
  });
  AC_PAGES.forEach(f => {
    if (!acCallSites.paint.some(s => s.startsWith(f))) bad('§J', f + ' 没调 window.AiChip.paint —— 那一处退回自己拼芯片了'
      + '（现有落点：' + (acCallSites.paint.join('、') || '无') + '）');
  });
  const acClearOut = acClear.filter(s => !s.startsWith('ui.js'));
  if (acClear.length !== 1) bad('§J', '「清除 AI 结果，回到完整列表」这句现在有 ' + acClear.length + ' 处（'
    + (acClear.join('、') || '一处都没有') + '）—— 期望恰好 1 处、在 ui.js 的 AiChip.CLEAR_TITLE；'
    + '一处都没有就是那句默认文案没了（页面得自己编一句，正是当年分叉的起点）');
  else if (acClearOut.length) bad('§J', '那句清除按钮的 title 在 ui.js 之外又写了一遍：' + acClearOut.join('、')
    + ' —— 页面自己传一份同句就等于把默认值抄成第二份，改一处忘一处');
  if (acPickPhrase.length !== 1 || !acPickPhrase[0].startsWith('ui.js')) bad('§J', '「AI 挑的」那半句现在在 '
    + (acPickPhrase.join('、') || '一处都没有') + ' —— 只许 ui.js 的 AiChip.picked 拼一次，两处页面各抄一遍就是两套量词');
  if (acOldPhrase.length) bad('§J', '旧那句「回到完整名单」又出现了：' + acOldPhrase.join('、')
    + ' —— 全站这一句只有一种说法（AiChip.CLEAR_TITLE 的「列表」），名单 / 列表两套措辞是这一族收掉的原因');

  /* ㉕ 第四头先跑：那两页交给 AiFind 的配置（`const AI = { … }`）本身。
     这一段与 ⑨-b 同一套路 —— 按**成员那一段 token**读，不按整行文本：
     `apply` 今天一行、明天三行，或行尾挂一句注释，都不该让判据跟着漂；
     而「注释里写着 filter」与「代码里给 filter 赋值」更不该混为一谈（词法器剥注释）。
     函数所在脚本段找不到的那些段直接跳过（页面有多段内联脚本），但**一段都没有**要当场红 ——
     那是尺子没底座，不是代码干净。 */
  for (const it of items) {
    if (!AF_RUN_PAGES.some(f => f === it.f) || !exists(it.f)) continue;
    const srcAI = read(it.f);
    const segsAI = it.html
      ? Array.from(srcAI.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
        .filter(x => x[1].trim()).map(x => ({ code: x[1], base: lineAt(srcAI, x.index) }))
      : [{ code: srcAI, base: 1 }];
    for (const seg of segsAI) {
      CUR_FILE = it.f;
      const rAI = lex(seg.code, seg.base);
      if (rAI.err) { bad('§J', it.f + ' 扫描器读不完：' + rAI.err + '（㉕ 那份配置的判据坏了）'); continue; }
      const TAI = rAI.toks;
      const mem = objectMembers(TAI, 'AI');
      if (!mem.size) continue;                    // 这一段里没有那份配置：换下一段
      /* 缺格那一句要点名**配置自己**在哪一行，不是脚本段的开头（`favorites.html:93 缺 say`
         指着整段第一行，读的人只会去找那一段为什么有 93 行 —— 报一次就废一次红条）。 */
      let lineAI = 0;
      for (let z = 0; z + 2 < TAI.length; z++) {
        if (TAI[z].t === 'id' && TAI[z].v === 'AI' && TAI[z + 1] && TAI[z + 1].v === '='
          && TAI[z + 2] && TAI[z + 2].v === '{') { lineAI = TAI[z].line; break; }
      }
      afCfgSeen.push(it.f);
      AF_CFG_NEED.forEach(n => { if (!mem.has(n)) afCfgMiss.push(it.f + ':' + lineAI + ' 缺 ' + n); });
      const bodyAI = objectMemberValue(TAI, 'AI', 'apply');
      if (!bodyAI) { afCfgMiss.push(it.f + ' 的 apply 取不到那一段（改名了 / 括号没配平）'); continue; }
      for (let q = 0; q + 1 < bodyAI.length; q++) {
        if (bodyAI[q].t === 'id' && bodyAI[q].v === 'filter' && bodyAI[q + 1] && bodyAI[q + 1].t === 'p'
          && bodyAI[q + 1].v === '=' && !(bodyAI[q + 2] && bodyAI[q + 2].v === '=')) {
          afCfgApplyBad.push(it.f + ':' + bodyAI[q].line);
        }
      }
    }
  }
  /* 四头。①② 各钉一边（形状只有一处落点 + 定义恰好一份），③ 钉「实现还在且真有人在用」，
     ④ 钉「配置里那四格都在、且 apply 不越界」。少了 ③④，把公共层整块删光、页面也不问 = 全绿。 */
  if (afPhraseSites.length !== 1) bad('§J', 'AI 检索那句闸门话现在有 ' + afPhraseSites.length + ' 处（'
    + (afPhraseSites.join('、') || '一处都没有') + '）—— 期望恰好 1 处、在 assetlib.js 的 AiFind.needMsg；'
    + '一处都没有就是那句没了（页面得自己编一句，正是当年两份副本各编一个「上面」的起点）');
  const afPhraseOut = afPhraseSites.filter(s => !s.startsWith(AF_LIB));
  if (afPhraseSites.length === 1 && afPhraseOut.length) bad('§J', '那句闸门话在 assetlib.js 之外又写了一遍：'
    + afPhraseOut.join('、') + ' —— 「先写字再点」这一句全站只许一种说法，抄一份就会有人改自己那半句');
  const afMinqOut = afMinqSites.filter(s => !s.startsWith(AF_LIB));
  if (afMinqOut.length) bad('§J', '页面 / 别的模块自己去读那个字数 MIN_Q：' + afMinqOut.join('、')
    + ' —— 字数闸的出口是 AiFind.shortWhy（它自己现问 MIN_Q）；页面拿那个数自己拼闸门，'
    + '公共层改了字数它不会跟着改口，界面上就会出现「写着两个字、实际要三个字」');
  if (afDefs.length !== 1) bad('§J', 'AiFind 的定义有 ' + afDefs.length + ' 处（'
    + (afDefs.join('、') || '一处都没有') + '）—— 「写一句话让 AI 挑几条」整链只许 assetlib.js 一份，'
    + '一处都没有就是整块没了（两道闸与忙态会退回各页一份）');
  else if (!afDefs[0].startsWith(AF_LIB)) bad('§J', '唯一的 AiFind 定义在 ' + afDefs[0] + '，不在 assetlib.js —— 判据和实现脱节了');
  ['run', 'clear', 'shortWhy', 'needMsg'].forEach(n => {
    if (afCalls[n] < AF_MIN[n]) bad('§J', 'AiFind.' + n + ' 只被调 ' + afCalls[n] + ' 次（应至少 '
      + AF_MIN[n] + '，先量过是 ' + AF_MIN[n] + '）—— 有一处退回自己拼闸门 / 自己收那三个字段了（现有落点：'
      + (afCallSites[n].join('、') || '无') + '）');
  });
  AF_RUN_PAGES.forEach(f => {
    ['run', 'clear'].forEach(n => {
      if (!afCallSites[n].some(s => s.startsWith(f))) bad('§J', f + ' 没调 AiFind.' + n + ' —— 那一页又退回自己写一遍整链'
        + '（两道闸、按钮忙态、名次记账），两句漂开的第一处永远是提示走哪一格（现有落点：'
        + (afCallSites[n].join('、') || '无') + '）');
    });
  });
  AF_SHORT_PAGES.forEach(f => {
    if (!afCallSites.shortWhy.some(s => s.startsWith(f))) bad('§J', f + ' 没问 AiFind.shortWhy —— 那一处退回自己判字数了'
      + '（资产库与统一选择器走的不是 run，可那个数与那句话必须还是同一份；现有落点：'
      + (afCallSites.shortWhy.join('、') || '无') + '）');
  });
  if (afCalls.needMsg !== 1 || !afCallSites.needMsg.some(s => s.startsWith(AF_LIB))) bad('§J',
    'AiFind.needMsg 的调用点是 ' + (afCallSites.needMsg.join('、') || '一处都没有')
    + ' —— 期望恰好 1 处、在 assetlib.js 的 shortWhy 里：那句话只剩一个说得出口的地方，'
    + '多一处就是有人绕过字数闸直接拼文案');
  AF_RUN_PAGES.forEach(f => {
    if (!afCfgSeen.some(s => s === f)) bad('§J', f + ' 里没有交给 AiFind 的那份配置（`const AI = { … }` 找不到了）—— '
      + '这一头的判据没有底座，宁可红也不能放行');
  });
  if (afCfgMiss.length) bad('§J', '交给 AiFind 的配置缺了那一族必要的格子：' + afCfgMiss.join('、')
    + ' —— 少 `say` 等于闸门那句没地方说（本轮修的正是这一条：ok/info 默认静音，拿它当唯一出口一个字都没出去）；'
    + '少 `done` 是挑完不重画；少 `onPick` 是原话还留着把整句再 AND 过滤一遍（结果永远 0 条）');
  if (afCfgApplyBad.length) bad('§J', '配置的 `apply` 里给类型档 `filter` 赋了值：' + afCfgApplyBad.join('、')
    + ' —— 清芯片（AiFind.clear）走的也是 apply，把「放开类型档」写进去就变成'
    + '「点 ✕ 连我挑过的 角色/场景/道具 那一档也给我改了」；这一格该只在 onPick 里（挑中了才放开）');
  /* ㉖ 四头。①② 各钉一边（那句话不该再说 / 公共那一格还在且只有一份），③ 钉「实现真有人在用、
     两页都没退回当场弹 toast」，④ 钉「那把键只有一个人在数 —— 取用即清不会被第二份绕过」。 */
  if (naOldPhrase.length) bad('§J', '真代码里还有 ' + naOldPhrase.length + ' 处写着「正在刷新」：' + naOldPhrase.join('、')
    + ' —— 这一句宣布的是**接下来那一次 location.reload()**，而那次刷新会把说这句话的东西（右上角的 toast、'
    + '卡内那行读数）一起销毁，用户回头看到的是刷新完的空界面；该交给 Toast.after 说给刷新之后那份文档');
  if (naDefs.length !== 1) bad('§J', 'Toast.after 那一格的方法定义有 ' + naDefs.length + ' 处（'
    + (naDefs.join('、') || '一处都没有') + '）—— 「把这一句留到刷新之后说」整链只许 ui.js 的 Toast 一份，'
    + '一处都没有就是整块没了（那 10 个会自己发起刷新的出口会退回各写一句活不下来的 toast）');
  else if (!naDefs[0].startsWith(NA_LIB)) bad('§J', '唯一的 Toast.after 定义在 ' + naDefs[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (naCalls.after < NA_MIN.after) bad('§J', 'Toast.after 只被调 ' + naCalls.after + ' 次（应至少 ' + NA_MIN.after
    + '，先量过是 ' + NA_MIN.after + '）—— 有一处退回当场弹了，那句会被它自己宣布的那次刷新杀掉（现有落点：'
    + (naCallSites.after.join('、') || '无') + '）');
  NA_PAGES.forEach(f => {
    if (!naCallSites.after.some(s => s.startsWith(f))) bad('§J', f + ' 没调 Toast.after —— 那一处又退回当场弹 toast 了'
      + '（页面自己发起的刷新这一族在两处落地：ui.js 的 DataSync.boot 对账、settings.html 的 reloadAfter；'
      + '现有落点：' + (naCallSites.after.join('、') || '无') + '）');
  });
  if (naKeySites.length !== 1 || !naKeySites[0].startsWith(NA_LIB)) bad('§J',
    '那把 sessionStorage 键（__toast_after_reload）点名的地方是 ' + (naKeySites.join('、') || '一处都没有')
    + ' —— 期望恰好 1 处、在 ui.js：抄这把键自己去 setItem 就绕过「取用即清」，'
    + '下一次加载会把上一趟的说明再弹一遍（同一句话弹两次比不弹还招人烦）');

  /* ㉗ 四头。①② 各管一边：① 是「当年那几句被原样改回来」，② 是「以后新写的一句又用旧叫法」；
     ③ 钉新写法真的在界面上说得出（否则 ①② 是空断言 —— 把那句话整句删掉也 0 命中），
     ④ 钉「供应商」这个词的**出处**还在（卡名 + 按钮）：改名的话 ①②③ 会一起变成自证。 */
  Object.entries(nmOldSites).forEach(([p, s]) => bad('§J',
    '真代码里还有 ' + s.length + ' 处写着「' + p + '」（' + s.join('、') + '）—— 下拉里选中的那一条全站叫「型号」，'
    + '「模型」只留给 AI 这个概念（发给它的提示词正文、本机没有看视频的模型）；同一屏两种叫法，人会以为坏的是两个不同的东西'));
  Object.entries(nmBanSites).forEach(([w, s]) => bad('§J',
    '字符串里还有 ' + s.length + ' 处出现「' + w + '」（' + s.join('、') + '）—— 一家平台叫「供应商」（设置页那张卡的名字就是它），'
    + '那份清单叫「注册表」（「注册路由」是代理里那条路由的名字，不是清单本身）；'
    + '注释里讲这段历史不算，对象键不算，只有用户看得见的那句算'));
  Object.entries(NM_NEW).forEach(([p, min]) => {
    const n = (nmNewSites[p] || []).length;
    if (n < min) bad('§J', '「' + p + '」只看到 ' + n + ' 处（应至少 ' + min + '，先量过是 ' + min + '）—— '
      + '旧叫法被拦住不等于新叫法接上了：这一句是那一族提示的唯一落点，少一处就是有一页把话删了没说'
      + '（现有落点：' + ((nmNewSites[p] || []).join('、') || '无') + '）');
  });
  Object.entries(NM_ANCHOR).forEach(([p, min]) => {
    const sites = nmAnchorSites[p] || [];
    if (sites.length < min) bad('§J', '设置页上「' + p + '」只看到 ' + sites.length + ' 处（应至少 ' + min + '）—— 它是我方把提示句统一成'
      + '「供应商」的**依据**（界面入口写的是哪个词，提示句就跟着哪个词）；卡名一旦被改，这一档的 ①②③ 就全成了在替一个不存在的名字把关'
      + '（现有落点：' + (sites.join('、') || '无') + '）');
  });
  /* ④ 的第二头：别处那些「到设置页找这一卡」的提示句再多，也不算这张卡还在。
     只数总量会把「卡改名叫『平台与密钥』、而六处提示句没跟着改」读成绿灯 —— 那种状态下
     那六处指的是一张画不出来的卡，而 ①②③ 全在替一个界面上不存在的名字把关。
     问的是**标记**：这两个词得长在 `<h2` / `<button` 那一行里。词法器只数 `<script>` 里的字符串，
     上面那份落点清单里一栏 settings.html 都没有 —— 那正是「光靠字符串数不到卡名」的证据。 */
  const setLines = read('settings.html').split(/\r?\n/);
  Object.entries(NM_MARK).forEach(([p, tag]) => {
    if (setLines.some(l => l.indexOf(p) >= 0 && l.indexOf(tag) >= 0)) return;
    bad('§J', '「' + p + '」在 settings.html 里已经不在 ' + tag + ' 那一格里了（字符串落点只有别页那些提示句：'
      + ((nmAnchorSites[p] || []).join('、') || '无') + '）—— 这一档 ①②③ 的口径是从设置页那几处标签抄来的'
      + '（卡名 / 按钮 / 表单行），标签本身被改名之后，别处那些指向它的提示句就全成了指一张界面上不存在的卡，'
      + '而判据照样全绿');
  });

  /* ㉘ 四头。①② 各钉一边（别再长一只外壳 / 那一行属性只有一份），③ 钉「两条取帧路真的走这一份」，
     ④ 钉「外壳的工厂全站只有一颗、释放那一颗确实还在 workbench.js」 —— 少了③，「把 el / release 的定义留在原地、两条调用都退回内联」全绿。 */
  if (vfCreate.length) bad('§J', 'workbench.js 之外还有 ' + vfCreate.length + ' 处自己 `document.createElement(\'video\')`：'
    + vfCreate.join('、') + ' —— 为取帧建的那只 <video> 外壳只有 Wb.vframe.el 一份（静音 + playsInline + 补给老浏览器那一行），'
    + '自己建就会各漂一行：少 muted 取帧时把声音放出来，少 playsInline 手机上跳全屏播放器');
  if (vfInline.length !== 1) bad('§J', '单独一格的 \'playsinline\' 字符串有 ' + vfInline.length + ' 处（'
    + (vfInline.join('、') || '一处都没有') + '）—— 期望恰好 1 处：那是「只为解码而存在」那只外壳的指纹，'
    + '0 处就是外壳整块没了（两条取帧路会退回各建一只）');
  else if (!vfInline[0].startsWith(VF_LIB)) bad('§J', '那一行外壳属性在 ' + vfInline[0] + '，不在 workbench.js —— 判据和实现脱节了');
  VF_NAMES.forEach(nm => {
    if (vfCalls[nm] < 1) bad('§J', 'Wb.vframe.' + nm + ' 一处都没被调（先量过 director.html 各 1 处）—— '
      + '时间切片那一路又退回自己建/自己放外壳了（现有落点：' + (vfCallSites[nm].join('、') || '无') + '）');
    if (!vfCallSites[nm].some(s => s.startsWith('director.html'))) bad('§J',
      'director.html 没调 Wb.vframe.' + nm + ' —— 导演台那片切片格子是取帧量最大的一处（一屏几十格），'
      + '它不走公共外壳就等于「解码器一直挂着」那件事还在（现有落点：' + (vfCallSites[nm].join('、') || '无') + '）');
    if (vfThis[nm] < 1) bad('§J', 'workbench.js 内部没有 this.' + nm + '( —— 公共层那份 grab 仍写着内联的另一套，'
      + '于是「外壳只有一份」只剩页面那一半');
  });
  if (vfDefs.length !== 1) bad('§J', '取帧外壳的工厂（`el(x) {` 那一颗方法）有 ' + vfDefs.length + ' 处（'
    + (vfDefs.join('、') || '一处都没有') + '）—— 为取帧建的那只 <video> 只许 Wb.vframe.el 一份；'
    + '0 处等于外壳整块没了，>1 处等于别处又长出一只');
  else if (!vfDefs[0].startsWith(VF_LIB)) bad('§J', '唯一的外壳工厂在 ' + vfDefs[0] + '，不在 workbench.js —— 判据和实现脱节了');
  if (!vfRelDefs.length) bad('§J', 'workbench.js 里没有 `release(v) {` 那颗方法 —— 「用完把解码器交出去」那一步没了，'
    + '页面拿到 Wb.vframe.release 是 undefined（同名方法在别处管的是 Web Audio 节点与代理名额，不算这一颗）');

  /* ㉙ 四头。① 是「倒着扫」这个形状本身（0 处 = 整块没了，>1 = 又抄了一遍），② 定义，
     ③ 两个调用方真的在调，④ 名字在导出面上 —— 这一族最容易复犯的是「写在闭包里没挂上表」：
     调用方拿到 undefined，「恢复默认」清掉 0 把键而回执照原样说「已恢复」。 */
  if (swBack.length !== 1) bad('§J', '「从 localStorage.length 往回数」那一趟扫描有 ' + swBack.length + ' 处（'
    + (swBack.join('、') || '一处都没有') + '）—— 期望恰好 1 处、在 ui.js 的 Store.sweep：'
    + 'removeItem 会让后面的键整体往前挪一格，**正着扫就跳过一半**，而回执照「表跑过一遍」说已恢复'
    + '（一处都没有 = 整块没了，两个调用方会退回各扫各的）');
  else if (!swBack[0].startsWith(SW_LIB)) bad('§J', '唯一的倒扫在 ' + swBack[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (swDefs.length !== 1) bad('§J', 'Store.sweep 的方法定义有 ' + swDefs.length + ' 处（'
    + (swDefs.join('、') || '一处都没有') + '）—— 「按判据清一批键」只许 ui.js 的 Store 一份');
  else if (!swDefs[0].startsWith(SW_LIB)) bad('§J', '唯一的 sweep 定义在 ' + swDefs[0] + '，不在 ui.js —— 判据和实现脱节了');
  if (swCalls < SW_MIN.calls) bad('§J', 'Store.sweep 只被调 ' + swCalls + ' 次（应至少 ' + SW_MIN.calls
    + '，先量过是 ' + SW_MIN.calls + '）—— 有一处退回自己扫了（现有落点：' + (swCallSites.join('、') || '无') + '）');
  SW_CALL_PAGES.forEach(f => {
    if (!swCallSites.some(s => s.startsWith(f))) bad('§J', f + ' 没调 Store.sweep —— 那一处又退回自己写那趟循环了'
      + '（现有落点：' + (swCallSites.join('、') || '无') + '）');
  });
  if (faces.Store && !faces.Store.has('sweep')) bad('§J', 'window.Store 的面上没有 sweep —— 它写在闭包里而没挂上导出面：'
    + 'assetlib.js 与 settings.html 拿到的是 undefined，清 0 把键还说「已恢复默认」（面上有：'
    + (faces.Store ? [...faces.Store].join(',') : '提不出来') + '）');

  /* ㉚ 四头。① 钉「别名解析只有一份」（第二份必然带着一套自己的上限），④ 钉那三个数各圈各的文件：
     每题候选上限跟着调用方给、题数那一档留在抽屉（它是那一格的排版性质），混用即红。 */
  const qaAliasOut = qaAlias.filter(s => !s.startsWith(QA_LIB));
  if (qaAliasOut.length) bad('§J', 'assetlib.js 之外还有 ' + qaAliasOut.length + ' 处读 `.question` 这个别名：'
    + qaAliasOut.join('、') + ' —— 「AI 回的那一串反问怎么读」只有 TextAI.qaOf 一份，'
    + '第二份必然带一套自己的上限（抄出来过一次：6 个候选不限题数 vs 8 题 × 10 候选，同一次反问在两处画得不一样）');
  if (qaDefs.length !== 1) bad('§J', 'qaOf 的方法定义有 ' + qaDefs.length + ' 处（'
    + (qaDefs.join('、') || '一处都没有') + '）—— 期望恰好 1 处、在 assetlib.js（一处都没有就是整块没了）');
  else if (!qaDefs[0].startsWith(QA_LIB)) bad('§J', '唯一的 qaOf 定义在 ' + qaDefs[0] + '，不在 assetlib.js —— 判据和实现脱节了');
  if (qaCalls < 2) bad('§J', 'qaOf 只被调 ' + qaCalls + ' 次（先量过是 2 次：assetlib.js 内部 + ai-chat.js）—— '
    + '有一头退回自己解析反问（现有落点：' + (qaCallSites.join('、') || '无') + '）');
  if (!qaCallSites.some(s => s.startsWith('ai-chat.js'))) bad('§J',
    'ai-chat.js 没调 TextAI.qaOf —— 抽屉那一格又退回抄一遍别名表了（那正是抄出两套上限的来路）');
  Object.entries(QA_OWN).forEach(([nm, owner]) => {
    const sites = qaMaxSites[nm] || [];
    const out = sites.filter(s => !s.startsWith(owner));
    if (!sites.length) bad('§J', nm + ' 一次都没被点名 —— 那个上限没了，反问会画满整屏或一个都不画（现有落点：无）');
    if (out.length) bad('§J', nm + ' 出现在 ' + owner + ' 之外：' + out.join('、') + ' —— 每题候选的上限归公共层'
      + '（TextAI.QA_O_MAX），一屏装几题归抽屉自己的排版（ai-chat 的 ASK_Q_MAX / ASK_O_MAX），两边共用一个数就又是一份真相');
  });
  if (faces.TextAI && !faces.TextAI.has('qaOf')) bad('§J', 'window.TextAI 的面上没有 qaOf —— ai-chat.js 调的是 undefined，'
    + '那一道「先问要点再动手」的路会当场抛错');

  /* ㉛ 四头。① 钉「这一颗正在跑」的旗标只有一个人写（两处各写就会有一处忘了复位），
     ②③ 各钉一边（定义只有一份 / 四个页面真的都在用），④ 钉那两句措辞与导出面。 */
  if (pbBusySites.length) bad('§J', 'assetlib.js 之外还有 ' + pbBusySites.length + ' 处读写 dataset.busy：'
    + pbBusySites.join('、') + ' —— 「这一颗按钮正在跑」的旗标只有 AssetLocal.pullBusy / pullStart / pullEnd 一份，'
    + '页面自己写就会有一路忘记复位（按钮从此永远点不动）');
  PB_NAMES.forEach(nm => {
    if (pbDefs[nm] !== 1) bad('§J', 'AssetLocal.' + nm + ' 的函数定义有 ' + pbDefs[nm] + ' 处（'
      + (pbDefSites[nm].join('、') || '一处都没有') + '）—— 期望恰好 1 处、在 assetlib.js');
    else if (!pbDefSites[nm][0].startsWith(PB_LIB)) bad('§J', '唯一的 ' + nm + ' 定义在 ' + pbDefSites[nm][0]
      + '，不在 assetlib.js —— 判据和实现脱节了');
    const min = PB_MIN[nm];
    if (min === undefined) return;
    if (pbCalls[nm] < min) bad('§J', 'AssetLocal.' + nm + ' 只被调 ' + pbCalls[nm] + ' 次（应至少 ' + min
      + '，先量过是 ' + min + '）—— 那一颗按钮退回自己拼画法 / 守卫 / 回执了（现有落点：'
      + (pbCallSites[nm].join('、') || '无') + '）');
    (PB_PAGES[nm] || []).forEach(f => {
      if (!pbCallSites[nm].some(s => s.startsWith(f))) bad('§J', f + ' 没调 AssetLocal.' + nm
        + ' —— 那一颗「存回本机」又长回自己那一份（现有落点：' + (pbCallSites[nm].join('、') || '无') + '）');
    });
  });
  if (pbTitle1.length !== 1 || !pbTitle1[0].startsWith(PB_LIB)) bad('§J',
    '「字节还不在本机」那半句 title 点名的地方是 ' + (pbTitle1.join('、') || '一处都没有')
    + ' —— 期望恰好 1 处、在 assetlib.js：四颗按钮共用一句说法，各写一遍就会有一页说「存好了」而另一页说「取回来」');
  if (pbTitle2.length !== 1 || !pbTitle2[0].startsWith(PB_LIB)) bad('§J',
    '「已经在本机的一条都不会重下」那句点名的地方是 ' + (pbTitle2.join('、') || '一处都没有')
    + ' —— 期望恰好 1 处、在 assetlib.js：那是「不会重复扣流量 / 不会重下」的唯一承诺处');
  const pbMiss = PB_NAMES.filter(nm => faces.AssetLocal && !faces.AssetLocal.has(nm));
  if (pbMiss.length) bad('§J', 'window.AssetLocal 的面上没有这些名字：' + pbMiss.join('、')
    + ' —— 函数在闭包里、导出表漏了它：四页调到的是 undefined，点按钮一句错都被按钮自己的 disabled 挡在门外看不见');

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
  /* 2026-10 改动后重新量过（判据跟着改口，不是放宽）：
     三页的「存回本机」收成了公共层 `pullMany` 一处循环，所以
       · `AssetLocal.pull` 在**任何页面里都不许出现**（0 处）—— 谁再写一遍那一圈，
         「太大下不动」「只剩转发地址」这几档的分流与回执措辞就会各漂一份，
         而这一档防的正是「同一件事长第二份实现」；
       · `AssetLocal.pullMany` 恰好 3 处：资产库 / 收藏 / 素材库各一颗按钮。
     `pull` 本体仍在 assetlib.js（`pullMany` 里那一次裸调用），那一处是唯一入口、不需要判据钉。 */
  if (dlPull !== 0)
    bad('§J', 'AssetLocal.pull 在页面里被调了 ' + (dlPullSites.join('、') || '')
      + ' —— 期望 0 处：页面要批量取回本机一律走 AssetLocal.pullMany，'
      + '自己写这一圈会绕过同一份计数与「太大 / 取不到外链」的分流与回执');
  if (pmPull !== 4) bad('§J', 'AssetLocal.pullMany 的调用点是 ' + (pmPullSites.join('、') || '一处都没有')
    + ' —— 期望恰好 4 处：「存回本机」四颗按钮（生成工作台 / 资产库 / 收藏 / 素材库）各一处');
  const pmFiles = [...new Set(pmPullSites.map(s => s.split(':')[0]))].sort();
  if (pmPull === 4 && pmFiles.join(',') !== 'assets.html,chars.html,favorites.html,studio.html')
    bad('§J', '四颗「存回本机」落在 ' + pmFiles.join(',') + ' —— 期望是生成工作台、资产库、收藏、素材库这四页');
  if (hideDef !== 1) bad('§J', 'hideAsCloud 的定义有 ' + hideDef + ' 处（' + (hideDefSites.join('、') || '一处都没有')
    + '）—— 「不显示云端任务」的判据只许 assetlib.js 的 AssetLocal 一份');
  else if (hideDefSites[0].split(':')[0] !== 'assetlib.js')
    bad('§J', 'hideAsCloud 的唯一定义在 ' + hideDefSites[0] + '，不在 assetlib.js —— 判据和实现脱节了');
  const hideFiles = [...new Set(hideCallSites.map(s => s.split(':')[0]))].sort();
  if (hideCalls !== 3 || hideFiles.join(',') !== 'assets.html,studio.html')
    bad('§J', 'AssetLocal.hideAsCloud 的调用点是 ' + (hideCallSites.join('、') || '没有')
      + ' —— 期望 studio.html 两处 + assets.html 一处，且只在这两页：收藏 / 素材库故意不藏');
  /* 四处：「存回本机」四颗按钮（生成工作台 / 资产库 / 收藏 / 素材库）各问一次。
     数字变过三次，都是量的结果、不是放宽：
       3 →（2026-10 拍短剧页整体删除）→ 2 →（资产库补上那颗）→ 3 →（生成工作台右栏补上那颗）→ 4。
     少于 4 说明某一处改成了自己判（比如又写一个 `/asset/la_` 前缀正则），
     多于 4 说明有人在别处也写了一份「有没有本机副本」—— 那正是这一档要防的。 */
  if (addrCalls !== 4) bad('§J', 'AssetLocal.hasLocalAddr 只被调 ' + (addrCallSites.join('、') || '一次都没有')
    + ' —— 期望四处各问一次（生成工作台 / 资产库 / 收藏 / 素材库）；「本机有没有这份字节」的判据也只许这一份');
  const addrFiles = [...new Set(addrCallSites.map(s => s.split(':')[0]))].sort();
  if (addrCalls === 4 && addrFiles.join(',') !== 'assets.html,chars.html,favorites.html,studio.html')
    bad('§J', '问「本机有没有这份字节」的是 ' + addrFiles.join(',') + ' —— 期望生成工作台、资产库、收藏、素材库这四页');
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

  /* ⑭ 型号声明必须**连 modelDocs 一起读**（这一轮新加）。
     v13 起 `p.models` 只装「能力接口给的 + 用户手填的」，官方文档那张 per-id 的表在 `p.modelDocs` 里
     —— `modes`（能不能做音色复刻/设计）、`inputRoles`（**参考音频槽在不在**）、`ttsMode` 全在那里。
     页面里凡是「按 #model 的取值去找当前型号」的地方都必须两处一起查：
     漏掉一处的能力就整块消失，而界面上只会说「当前型号只支持纯文字生成」——
     用户报的两条（模仿音色没有参考素材卡片、音色描述框不出现）根因都是这一处读法。
     正反两面都要钉：既不许「只查 p.models」，也不许「只查 p.modelDocs」（后者会丢掉能力接口那份）。 */
  {
    const src = read('studio.html');
    /* currentModel 的查找那一支：必须在 p.models 与 p.modelDocs 的并集里找 */
    const hasBoth = /\.models\s*\|\|\s*\[\s*\]\s*\)\.concat\(\s*\(\s*p\.modelDocs\s*\)|\.models\s*\|\|\s*\[\s*\]\s*\)\s*,\s*\(\s*p\.modelDocs\s*\)/.test(src);
    /* audioModels 那一份（原有的）也要在并集里查 —— 两处口径必须一致 */
    const audioBoth = /declared\s*=\s*new Map\(\(\s*(?:\(p && p\.models\) \|\| \[\]\)|base)\s*\.concat\(\s*\(p && p\.modelDocs\) \|\| \[\]\)\s*\)/.test(src)
      || /const base = \(p && p\.models\) \|\| \[\];[\s\S]{0,400}?const declared = new Map\(base\.concat\(\(p && p\.modelDocs\) \|\| \[\]\)\.map/.test(src);
    if (!hasBoth) bad('§J', 'studio.html 的 currentModel() 没有在 p.models 与 p.modelDocs 的并集里找型号 —— '
      + '「按当前下拉取值取型号」这一处漏了声明层，于是纯声明驱动的那几家（MiMo 全家）'
      + '在能力刷新之后只剩空壳：参考音频槽（inputRoles）与三档模式（modes）整块不在界面上');
    if (!audioBoth) bad('§J', 'studio.html 的 audioModels() 也没有连 p.modelDocs 一起查 —— '
      + '它与 currentModel() 必须是同一份读法，两处各写一份就会有一处漏');
    if (hasBoth && audioBoth) ok('§J', 'studio.html 两处「按 id 找型号声明」都连 p.modelDocs 一起查（当前型号带得上 inputRoles / modes）');
  }

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

  /* ⑮ 三头都要在：公共层那一份在面上了、页面**没有**第二份同名实现、**且**两页都真的在引用它。
     只有前两头的话，「页面全改成不选模式」与「判据坏了」长得一模一样（⑧⑩ 同一套路）。 */
  if (capClone) bad('§J', '页面又自己写了一份输入模式的表 / 判据：' + capCloneSites.join('、')
    + ' —— 素材名表、模式名、双向判据、退档判据只有 assetlib.js 的 Capabilities 一份；'
    + '要短名就写一行转发（右边点 Capabilities.同名），抄第二份表就会出现「同一个 role 在两个页面叫两个名字」');
  /* 逐句两头都查：页面里 0 处，**且**公共层里确实还有那一句。
     只查前一头的删掉一句措辞（另几句顶着）也是全绿 —— 变异 D 第一版就是这么漏的。 */
  COPY_PHRASES.forEach(p => {
    const h = copyHits[p];
    if (h.page) bad('§J', '页面里又出现「' + p + '」：' + copyPageSites[p].join('、')
      + ' —— 这一句 / 这一个标记在 comboScopeNote 与 comboChipsHTML 里，页面抄一份就得自己维护 min/max 与画法');
    if (!h.lib) bad('§J', 'assetlib.js 里没有「' + p + '」那一句（公共层 ' + h.lib + ' 处）'
      + ' —— 尺子没底座：页面那头「不许出现」会变成永远的空断言');
  });
  const capBoth = ['ROLE_ZH', 'comboLabel', 'comboGaps', 'fallbackCombo', 'comboScopeNote', 'comboChipsHTML'];
  ['director.html', 'studio.html'].forEach(f => {
    const off = capBoth.filter(n => !(capRefSites[n] || []).some(s => s.startsWith(f)));
    if (off.length) bad('§J', f + ' 没有走 Capabilities 的这几样：' + off.join('、')
      + ' —— 它要么退回了自己拼名字 / 自己判收不收（两页各一份迟早对不上），要么整块没接输入模式');
  });
  /* 工作台还多一样：黄条上「切到『X』」那条出路要现找收得下这批素材的那一档。
     导演台没有这一问（它只在退档时问），所以只点 studio 的名。 */
  if (!(capRefSites.comboCovering || []).some(s => s.startsWith('studio.html')))
    bad('§J', 'studio.html 没有走 Capabilities.comboCovering —— 「有没有哪一档收得下这批素材」又是页面自己比 role 字符串');
  /* 引用总数下限（先量过再钉）：只查「这名字出现过一次」的话，
     把其余调用点全改回内联写法照样全绿，而那一页恰好就是会漂开的那一页。 */
  const capRefTotal = Object.values(capRefs).reduce((a, b) => a + b, 0);
  if (capRefTotal < 24) bad('§J', 'Capabilities 那一族的引用只看到 ' + capRefTotal + ' 处（先量过的是 24 处：'
    + '两页各引用 ROLE_ZH / comboLabel / comboGaps / fallbackCombo / comboScopeNote / comboChipsHTML，'
    + '工作台再多一处 comboCovering 与守卫）—— 少一头就是判据或调用点坏了');

  if (red === red0) ok('§J', '扫了 ' + scanned + ' 段源码：b64Bytes 定义 ' + defs + ' 处（被调 ' + calls + ' 次）、落点选择器 '
    + pickers + ' 处、页面自建 toast ' + toastDefs + ' 处、页面自建续拉 ' + ioInPage + ' 处、字节单位数组 ' + unitSites.length
    + ' 处、页面自建芯片行 ' + chipRows + ' 处（Chips 定义 ' + chipsDefs + ' / 被调 ' + chipsCalls
    + '）、pager 实例成员访问 ' + pagerCalls + ' 处（面上 ' + apiKeys.size + ' 个名字，越界 ' + pagerOff
    + ' 处）、跨页复用载荷写入 ' + reuseWrite + ' 处 / 读取 ' + reuseRead + ' 处 / Wb.reuse.go ' + reuseGoCalls + ' 处'
    + ' ⑨落盘链：pull ' + dlPull + ' 处、hideAsCloud 定义 ' + hideDef + ' / 调用 ' + hideCalls
    + ' 处（pullMany ' + pmPull + ' 处）、hasLocalAddr ' + addrCalls + ' 处、页面自拼 /local-assets ' + rawLocalInPage + ' 处'
    + ' ⑩就地确认：Confirm.arm 定义 ' + armDef + ' / 调用 ' + armCalls + ' / 页面手搓 ' + armInline
    + ' 处、⑪资产合并：Object.assign 摊字典 ' + assetMerge + ' 处（mergeAssetLists 被调 ' + mergeCalls + ' 次）'
    + '、⑭三排声明驱动控件：AdvExtras 定义 ' + advDef + ' 处 / 页面自写判据 ' + advCloneSites.length
    + ' 处 / 走公共读回的页面 ' + advReaders.length + ' 个'
    + ' ⑮输入模式那一族：面 ' + capFace.size + ' 个成员 / 引用 ' + capRefTotal + ' 处（'
    + CAP_NAMES.map(n => n + ':' + (capRefs[n] || 0)).join(' ') + '）/ 页面同名实现 ' + capClone
    + ' 处 / 逐句措辞：公共层 ' + COPY_PHRASES.map(p => copyHits[p].lib).join('/')
    + '、页面 ' + COPY_PHRASES.map(p => copyHits[p].page).join('/')
    + ' ⑯润色那一族：六句交代定义 ' + POLISH_FNS.map(n => n + ':' + pDefs[n]).join(' ')
    + ' / 用它的页面 ' + POLISH_FNS.map(n => n + ':' + pRefFiles[n].size).join(' ')
    + ' / 入口 ' + polishEntries + ' 处、接 onFollow ' + followPassed + ' 处 / 页面自拼对话行 '
    + CHAT_MARKS.map(p => chatPage[p]).join('/')
    + ' ⑰时间文案：「X 分 Y 秒」拼法 ' + secShapes + ' 处（Wb.fmtSec 被调 ' + fmtSecCalls
    + ' 次）/ mm:ss 拼法 ' + clockShapes + ' 处（Wb.fmtClock 被调 ' + fmtClockCalls + ' 次）'
    + ' ⑱日期与时刻：locale API ' + localeDateCalls + ' 处 / 手拼年-月-日 ' + dayShapes
    + ' 处（' + dayShapeSites.join('、') + '）/ '
    + WHEN_NAMES.map(n => n + ' 定义 ' + whenDefs[n] + ' 调用 ' + whenCalls[n]).join('、')
    + ' ⑲下载文件名：自己洗保留字符 ' + sanitizeShapes + ' 处（' + sanitizeSites.join('、') + '）/ '
    + FN_NAMES.map(n => n + ' 定义 ' + fnDefs[n] + ' 调用 ' + fnCalls[n]).join('、')
    + ' / 自己重写形状：' + Object.keys(fnShapeHits).map(k => k + ' ' + fnShapeHits[k].join('、')).join(' | ')
    + ' ⑳网络与刷新：自己读写那三个键 ' + netKeyIO + ' 处（' + netKeyIOSites.join('、') + '）/ 标记里写区间 '
    + netMarkBounds + ' 处（' + netMarkBoundsSites.join('、') + '）/ NUMS 定义 ' + numsDefs
    + ' / ' + NET_NAMES.map(n => 'Net.' + n + ':' + netRefs[n]).join(' ')
    + ' ㉑字数闸：CharLimits 定义 ' + clDefs + ' 处 / 成员引用 ' + clRefTotal + ' 处（'
    + CL_MEMBERS.map(n => n + ':' + clRefs[n]).join(' ') + '）/ 页面老措辞 '
    + CL_OLD_PHRASES.map(p => p + ':' + clOldHits[p]).join(' ') + ' / 公共层底座 个字（:' + clLibChars
    + ' 至少 :' + clLibMin + '）/ wayWhy 定义 ' + wwDefs + ' 调用 ' + wwCallSites.length + ' 处'
    + ' ㉒展示样式：view- 前缀 公共层:' + vtLib.length + ' 页面:' + vtPage.length
    + ' / create ' + vtCreateSites.length + ' 处（点名容器 ' + vtTargetedSites.length
    + '、还自传 views ' + vtViewsArgs.length + '）/ 档位名点名 ' + vtModeNames.length + ' 处（'
    + vtModeNames.map(s => s.split(':')[0]).join('、') + '）'
    + ' ㉓供应商类型：旧符号 ' + pkOldSites.length + ' / 手抄键序 ' + pkOrderSites.length + ' / '
    + '「audio:语音」形状 ' + pkZhSites.length + ' 处（' + (pkZhSites.join('、') || '无') + '）/ '
    + 'provKindZh 定义 ' + pkDefs.provKindZh + ' 调用 ' + pkCalls.provKindZh
    + ' / provKinds 定义 ' + pkDefs.provKinds + ' 调用 ' + pkCalls.provKinds
    + ' ㉔AI 芯片：自己拼的形状 ' + acShapeSites.length + ' 处 / AiChip 定义 ' + acDefs.length + ' 处（'
    + (acDefs.join('、') || '无') + '）/ paint ' + acCalls.paint + ' text ' + acCalls.text + ' picked ' + acCalls.picked
    + ' / 措辞：默认 title ' + acClear.length + ' 处、「AI 挑的」' + acPickPhrase.length + ' 处、旧句「名单」' + acOldPhrase.length + ' 处'
    + ' ㉕AI 挑几条：闸门话 ' + afPhraseSites.length + ' 处（' + (afPhraseSites.join('、') || '无') + '）/ '
    + 'MIN_Q 外溢 ' + afMinqOut.length + ' 处（' + (afMinqOut.join('、') || '无')
    + '，公共层内共 ' + afMinqSites.length + '）/ AiFind 定义 '
    + afDefs.length + ' 处（' + (afDefs.join('、') || '无') + '）/ 出口 '
    + ['run', 'clear', 'shortWhy', 'needMsg'].map(n => n + ':' + afCalls[n]).join(' ')
    + ' / 配置读到 ' + afCfgSeen.length + ' 页、缺格 ' + afCfgMiss.length + '、apply 写 filter '
    + afCfgApplyBad.length + ' 处'
    + ' ㉖刷新后那一句：「正在刷新」' + naOldPhrase.length + ' 处（' + (naOldPhrase.join('、') || '无') + '）/ '
    + 'Toast.after 定义 ' + naDefs.length + ' 处（' + (naDefs.join('、') || '无') + '）/ 调用 '
    + naCalls.after + ' 处 / 那把键 ' + naKeySites.length + ' 处（' + (naKeySites.join('、') || '无') + '）'
    + ' ㉗名词写法：旧句命中 ' + (Object.keys(nmOldSites).length ? Object.entries(nmOldSites).map(([p, s]) => p + ':' + s.length).join(' ') : '0')
    + ' / 禁词 ' + (Object.keys(nmBanSites).length ? Object.entries(nmBanSites).map(([w, s]) => w + ':' + s.length).join(' ') : '0')
    + ' / 新句 ' + Object.keys(NM_NEW).map(p => (nmNewSites[p] || []).length + '（' + p.slice(0, 10) + '…）').join(' ')
    + ' / 卡上标签 ' + Object.keys(NM_ANCHOR).map(p => p + ':' + (nmAnchorSites[p] || []).length).join(' ')
    + ' ㉘取帧外壳：外部自建 video ' + vfCreate.length + ' 处（' + (vfCreate.join('、') || '无') + '）/ 单独 playsinline '
    + vfInline.length + ' 处 / 工厂定义 ' + vfDefs.length + ' 处（' + (vfDefs.join('、') || '无')
    + '）/ 库内 release ' + vfRelDefs.length + ' 处 / 调用 '
    + VF_NAMES.map(nm => nm + ' 页面' + vfCalls[nm] + ' 内部' + vfThis[nm]).join(' ')
    + ' ㉙倒扫清键：形状 ' + swBack.length + ' 处（' + (swBack.join('、') || '无') + '）/ 定义 ' + swDefs.length
    + ' 处 / 调用 ' + swCalls + ' 处（' + (swCallSites.join('、') || '无') + '）/ 面 '
    + (faces.Store ? (faces.Store.has('sweep') ? '有 sweep' : '缺 sweep') : '提不出')
    + ' ㉚反问别名：.question 外溢 ' + qaAlias.filter(s => !s.startsWith(QA_LIB)).length + ' 处（共 ' + qaAlias.length
    + '）/ qaOf 定义 ' + qaDefs.length + ' 调用 ' + qaCalls + '（' + (qaCallSites.join('、') || '无') + '）/ 上限 '
    + Object.keys(QA_OWN).map(nm => nm + ':' + (qaMaxSites[nm] || []).length).join(' ')
    + ' ㉛存回本机四颗：dataset.busy 外溢 ' + pbBusySites.length + ' 处 / 定义 '
    + PB_NAMES.map(nm => nm + ':' + pbDefs[nm]).join(' ') + ' / 调用 '
    + PB_NAMES.map(nm => nm + ':' + pbCalls[nm]).join(' ') + ' / title 两句 '
    + pbTitle1.length + ' + ' + pbTitle2.length + ' 处 / 面缺 '
    + (faces.AssetLocal ? PB_NAMES.filter(nm => !faces.AssetLocal.has(nm)).length : '?'));
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
