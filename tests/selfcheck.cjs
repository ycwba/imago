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
 * 八档：
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
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* SC_TRACE=1 时把词法器的模板串进出打到 stderr —— 「读不完」这类报错要给得出
   「到底是哪一段没配平」，只报「剩 1 层」等于让下一个人重新查一遍。 */
const TRACE = !!process.env.SC_TRACE;
let CUR_FILE = '';                                  // TRACE 时跟着打印，混着多个文件看不出来是哪一份
const JS_FILES = ['ui.js', 'assetlib.js', 'workbench.js', 'drama.js', 'ai-chat.js', 'sidebar.js',
  'app.js', 'ident.js', 'proxy.js'];
const HTML_FILES = ['index.html', 'studio.html', 'drama.html', 'assets.html', 'chars.html',
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
     于是 `${x ? `a${y}` : ''}` 这种套嵌一进来就跑偏（index.html:2138 就是这么炸的：
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
  let paren = 0, declRun = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], nx = toks[i + 1], p = toks[i - 1];
    if (t.t === 'p' && t.v === '(') { paren++; continue; }
    if (t.t === 'p' && t.v === ')') { if (paren > 0) paren--; continue; }
    if (t.t === 'p' && (t.v === '{' || t.v === '${')) {
      all.push({ names: new Set(), parent: stack[stack.length - 1] });   // ${ 也进一层
      stack.push(all.length - 1);
      continue;
    }
    if (t.t === 'p' && t.v === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (t.t === 'p' && t.v === ';' && paren === 0) { declRun = 0; continue; }
    if (t.t !== 'id') continue;
    const w = t.v;
    if (NO_CALL.has(w)) {
      if (w === 'const' || w === 'let' || w === 'var') { declRun = 1; continue; }
      if ((w === 'function' || w === 'class') && nx && nx.t === 'id') cur().add(nx.v);
      continue;
    }
    const isMember = p && p.t === 'p' && p.v === '.';
    /* 多声明符：`const d = new Date(), pad = n => …` 里第二个之后的也得算声明
       （漏了它，pad() / p2() 会在模板串里被报成裸调用 —— 而它们确实是本段声明的） */
    if (declRun && !isMember) { cur().add(w); continue; }
    if (p && p.t === 'id' && (p.v === 'const' || p.v === 'let' || p.v === 'var'
      || p.v === 'function' || p.v === 'class')) { cur().add(w); continue; }
    if (p && p.t === 'p' && p.v === '{' && nx && nx.t === 'p' && (nx.v === ',' || nx.v === '}')) {
      cur().add(w); continue;                                       // 解构 { a, b } = …
    }
    if (p && p.t === 'id' && p.v === 'catch') { cur().add(w); continue; }
    /* 形参与箭头参数：宁可放宽（把实参也收进来），也别把正常代码判成红 */
    if (paren > 0 && !isMember
      && nx && nx.t === 'p' && (nx.v === ',' || nx.v === ')' || nx.v === '=' || nx.v === '=>')) { cur().add(w); continue; }
    if (nx && nx.t === 'p' && nx.v === '=>') { cur().add(w); continue; }
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
  return { all, calls };
}
/* 这个名字能不能从第 k 层作用域解析到 */
function resolves(all, k, name) {
  for (let j = k; j >= 0; j = all[j].parent) if (all[j].names.has(name)) return true;
  return false;
}


function sectionA() {
  const globals = harvestGlobals();
  let segs = 0, calls = 0, misses = 0, lexErr = 0;
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
      for (const c of an.calls) {
        calls++;
        if (globals.has(c.name)) continue;
        if (resolves(an.all, c.frame, c.name)) continue;
        misses++; bad('§A', f + ':' + c.line + ' 裸调用 ' + c.name + '() 既不在本作用域也不在 window 上');
      }
    }
  }
  if (segs === 0) bad('§A', '一段内联脚本都没查到 —— 判据本身坏了（不带参数时不该出现）');
  else if (!misses && !lexErr) ok('§A', '查了 ' + segs + ' 段内联脚本 / ' + calls + ' 处裸调用，全部落在本作用域或 window 上');
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

   判「界面属性名」只认**同一行**：写成「往下看两行」就会把
   `$('hint').textContent = 'a'; toast('**b**')` 里那个 b 也算成界面文案 —— 假红比漏红更费人。 */
const UI_SINK = /\b(?:textContent|innerText|innerHTML|outerHTML|insertAdjacentHTML|title|placeholder|alt|label|ariaLabel|aria-label|hint|note|desc|empty|tooltip|caption)\s*[:=]/;

function sectionH() {
  const red0 = red;
  let checks = 0;
  const all = targets.js.map(f => ({ f, html: false })).concat(targets.html.map(f => ({ f, html: true })));
  for (const item of all) {
    const f = item.f;
    if (!exists(f)) { bad('§H', f + ' 不存在'); continue; }
    const src = read(f);
    /* ① 静态正文与属性值：把 script / style / 注释整块挖掉，剩下的就是会直接显示的字 */
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
          const ctx = ls[t.line - 1] || '';
          if (!UI_SINK.test(ctx)) continue;
          bad('§H', f + ' 第 ' + t.line + ' 行 markdown 标记漏进界面：' + piece.trim().slice(0, 44));
        }
      }
    }
  }
  if (!checks) bad('§H', '一处都没查 —— 判据本身坏了');
  else if (red === red0) ok('§H', '查了 ' + checks + ' 处界面文案（' + targets.html.length + ' 个页面的静态正文与内联脚本、'
    + targets.js.length + ' 个模块），没有 markdown 标记漏到界面上');
  return checks;
}

/* 跑全套是命令入口才做的事；被 require 时只导出下面那台词法扫描器。
   为什么抽出来：文案 / 漏字检查的脚本需要**同一台**扫描器取字符串字面量，
   旁边再手写一个更差的（只跳过整行注释，313 行里绝大多数是跨行注释的正文），
   那就是「一个机制写两份」—— 而更差的那份会给出一份看起来很合理的读数。 */
function runAll() {
console.log('§A 内联脚本裸调用的作用域'); sectionA();
console.log('§B 模板串里的「块注释 + 反引号」'); sectionB();
console.log('§C 素材身份判据只有一份'); sectionC();
console.log('§D ident.js 排在 assetlib.js 前面'); sectionD();
console.log('§E 合卡规则只有一份'); sectionE();
console.log('§F 另存那条链只有一个触发点'); sectionF();
console.log('§G 另存的安全立场与 .assets 原件不动'); sectionG();
console.log('§H 用户可见文案里不许有 markdown 标记'); sectionH();

const over = [...seen.entries()].filter(([, n]) => n > 6);
if (over.length) console.log('\n（折叠的同类红：' + over.map(([k, n]) => k.split('|')[0] + ' ' + k.split('|')[1] + ' ×' + (n - 6)).join('；') + '）');
console.log('共 ' + green + ' 档绿 / ' + red + ' 条红');
process.exit(red ? 1 : 0);
}

module.exports = { lex, runAll, sectionA, sectionB, sectionC, sectionD, sectionE, sectionF, sectionG, sectionH, routeBlock, fnBlock };
if (require.main === module) runAll();
