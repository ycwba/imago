#!/usr/bin/env node
/* 作用域判据：四条都跑在同一份 AST 上 ——
   ① 「引用了但任何作用域都解析不到的裸名字」；
   ② 搬域接线后「求值期读晚绑的名字」（TDZ）；
   ③ `import { X } from './m.js'` 而 m.js 没有导出 X（整个模块图断掉）；
   ④ 搬域接线里「名字形状与用法对不上」（状态被当函数调用 / 对 const 写）。
   这一类 `node --check` 与 vm.Script 全绿，只有真跑到那一行才炸（2026-10-21 一轮里抓到四处：
   helper 的定义搬进了块里而调用点在块外 / 搬模块时状态留在原地 / 少一条 import / 两份共享清单漏一条），
   炸法都一样：函数走到那条分支抛 ReferenceError，把它外面的整段流程一起带停 ——
   最坏的一处让 renderMid 中断在 scheduleSave 之前，导演台从此不再落盘。

   口径（与浏览器实际行为一致，不按「看起来像模块」猜）：
   · ESM 文件只看自己的 import 与本文件作用域；
   · 经典脚本顶层的 let/const 进的是页面共享的全词法作用域，另一份经典脚本能裸读，模块不能；
   · `window.X = ` / `globalThis.X = ` 赋过值的名字算全局（本项目跨层就靠这一族）。
   解析器是 @babel/parser（开发期依赖，不进运行时）。装不上就是判据没跑：这一档抓的四类错
   全部「node --check 与 vm 脚本都绿、只有真跑到那一行才炸」，报绿跳过等于把这四把尺子收起来。 */
'use strict';
const fs = require('fs');
const path = require('path');

let parser;
try { parser = require('@babel/parser'); }
catch (e) {
  console.error('✗ 作用域判据跑不了：没有 @babel/parser（先跑一次 npm install）。'
    + '这一档缺了不会报错、只会一路报绿，所以不做静默跳过。');
  process.exit(1);
}

const BUILTIN = new Set(['console', 'Math', 'Number', 'String', 'Boolean', 'Date', 'JSON', 'Object', 'Array',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
  'FormData', 'Headers', 'Request', 'Response', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'window', 'document', 'navigator',
  'location', 'history', 'performance', 'screen', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
  'DragEvent', 'ClipboardEvent', 'InputEvent', 'FocusEvent', 'WheelEvent', 'TouchEvent', 'StorageEvent',
  'MessageEvent', 'ErrorEvent', 'PromiseRejectionEvent', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'PerformanceObserver', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'DOMException', 'Symbol', 'Intl', 'BigInt', 'fetch', 'atob', 'btoa',
  'TextEncoder', 'TextDecoder', 'Image', 'Audio', 'Video', 'BroadcastChannel', 'Worker', 'SharedWorker',
  'MessageChannel', 'MessagePort', 'OffscreenCanvas', 'CanvasRenderingContext2D', 'CanvasGradient',
  'ImageData', 'Path2D', 'DOMRect', 'DOMMatrix', 'createImageBitmap', 'getComputedStyle', 'matchMedia',
  'alert', 'confirm', 'prompt', 'open', 'close', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array',
  'Int16Array', 'Int32Array', 'Uint16Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'DataView', 'ArrayBuffer', 'SharedArrayBuffer', 'structuredClone',
  'queueMicrotask', 'FinalizationRegistry', 'RegExp', 'Function', 'Proxy', 'Reflect', 'globalThis',
  'arguments', 'super', 'this', 'escape', 'unescape', 'Notification', 'Element', 'Node', 'HTMLElement',
  'EventTarget', 'NodeFilter', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'WebSocket',
  'EventSource', 'MediaRecorder', 'MediaStream', 'AudioContext', 'IDBDatabase', 'IDBKeyRange',
  'IDBTransaction', 'IDBObjectStore', 'IDBRequest', 'IDBOpenDBRequest', 'ImageBitmap', 'DataTransfer',
  'CompressionStream', 'DecompressionStream', 'CSS', 'self', 'caches', 'importScripts', 'postMessage',
  'onmessage', 'TextMetrics', 'URLPattern', 'Crypto', 'SubtleCrypto', 'ScreenOrientation',
  /* UMD 包装那一族（`typeof module === 'object' && module`）：短路之后第二段永远走不到，不算违例。 */
  'module', 'require', 'process', 'exports']);

function bindNames(patterns, out) {
  out = out || [];
  const one = p => {
    if (!p) return;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(pr => one(pr.type === 'RestElement' ? pr.argument : (pr.value || pr.argument)));
    else if (p.type === 'ArrayPattern') p.elements.forEach(one);
    else if (p.type === 'AssignmentPattern') one(p.left);
    else if (p.type === 'RestElement') one(p.argument);
  };
  patterns.forEach(one);
  return out;
}

function walkAny(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => walkAny(x, visit));
    else if (v && typeof v === 'object' && typeof v.type === 'string') walkAny(v, visit);
  }
}

const isModuleAst = ast => ast.program.body.some(n => n.type === 'ImportDeclaration'
  || n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration' || n.type === 'ExportAllDeclaration');

function parseSrc(src) {
  return parser.parse(src, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true });
}

/* 收集全页可见的名字：window 挂出来的 + 所有经典脚本顶层的 let/const/var/class/function。 */
function collectGlobals(items) {
  const globals = new Set(BUILTIN);
  const classicLex = new Set();
  const classicFiles = new Set();
  for (const it of items) {
    walkAny(it.ast.program, n => {
      if (n.type === 'AssignmentExpression' && n.operator === '=') {
        const l = n.left;
        if (l.type === 'MemberExpression' && !l.computed && l.object.type === 'Identifier'
          && (l.object.name === 'window' || l.object.name === 'globalThis' || l.object.name === 'self')
          && l.property.type === 'Identifier') globals.add(l.property.name);
      }
    });
    if (it.isModule) continue;                         // 模块顶层名字只在自己的模块作用域里，不外溢
    classicFiles.add(it);
    for (let st of it.ast.program.body) {
      if (st.type === 'ExportNamedDeclaration' && st.declaration) st = st.declaration;
      if (st.type === 'FunctionDeclaration' && st.id) { globals.add(st.id.name); classicLex.add(st.id.name); }
      if (st.type === 'ClassDeclaration' && st.id) { globals.add(st.id.name); classicLex.add(st.id.name); }
      if (st.type === 'VariableDeclaration') bindNames(st.declarations.map(d => d.id)).forEach(x => classicLex.add(x));
    }
  }
  return { globals, classicLex, isClassic: it => classicFiles.has(it) };
}

const SKIP_KEY = new Set(['loc', 'type', 'start', 'end', 'range', 'extra', 'directives', 'regex', 'value']);

/* 一次全文件的作用域解析：返回解析不到的裸名字清单。 */
function analyze(item, env) {
  const hits = [];
  const { globals, classicLex } = env;
  const allowClassic = env.isClassic(item);
  const scope = parent => ({ parent, b: new Set() });
  const has = (s, name) => { for (let c = s; c; c = c.parent) if (c.b.has(name)) return true; return false; };
  const add = (s, names) => names.forEach(n => s.b.add(n));
  const unknown = name => !globals.has(name) && !(allowClassic && classicLex.has(name));
  const report = (node, name, why) => hits.push({ line: node.loc && node.loc.start.line, name, why });

  /* 函数/模块作用域：参数 + var + 函数声明（嵌套函数自己的体不深入，那是另一层）。 */
  function collectFn(fn, s) {
    if (!fn) return;
    if (fn.params) add(s, bindNames(fn.params));
    const go = n => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'ExportNamedDeclaration' && n.declaration) return go(n.declaration);
      if (n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'MethodDefinition') return;
      if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') { if (n.id) s.b.add(n.id.name); return; }
      if (n.type === 'FunctionDeclaration') { if (n.id) s.b.add(n.id.name); return; }
      if (n.type === 'ClassDeclaration') { if (n.id) s.b.add(n.id.name); return; }
      if (n.type === 'VariableDeclaration' && n.kind === 'var') add(s, bindNames(n.declarations.map(d => d.id)));
      if (n.type === 'CatchClause' && n.param) add(s, bindNames([n.param]));
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'type' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(go); else if (v && typeof v.type === 'string') go(v);
      }
    };
    if (fn.body) go(fn.body);
  }
  /* 块作用域：let / const / class（这一层正是 `onPl` 那一类栽跟头的地方）。 */
  function collectBlock(bl, s) {
    for (let st of (bl.body || [])) {
      if (st.type === 'ExportNamedDeclaration' && st.declaration) st = st.declaration;
      if (st.type === 'VariableDeclaration' && st.kind !== 'var') add(s, bindNames(st.declarations.map(d => d.id)));
      else if (st.type === 'ClassDeclaration' && st.id) s.b.add(st.id.name);
    }
  }
  const fnScope = (node, parent) => {
    const s2 = scope(parent);
    collectFn(node, s2);
    if (node.id) s2.b.add(node.id.name);
    walk(node.body, s2, 'val');
    (node.params || []).forEach(p => walkDefault(p, s2));
  };
  /* 形参只是绑定，不是引用；这里只看默认值里的外层引用。 */
  function walkDefault(p, s) {
    if (!p) return;
    if (p.type === 'AssignmentPattern') walk(p.right, s, 'ref');
    if (p.type === 'ObjectPattern') p.properties.forEach(pr => walkDefault(pr.type === 'RestElement' ? pr.argument : pr.value, s));
    if (p.type === 'ArrayPattern') p.elements.forEach(e => walkDefault(e, s));
    if (p.type === 'RestElement') walkDefault(p.argument, s);
  }

  function walk(node, s, role) {
    if (!node || typeof node.type !== 'string') return;
    const t = node.type;
    if (role === 'ref' && t === 'Identifier') {
      if (!has(s, node.name) && unknown(node.name)) report(node, node.name, '裸引用');
      return;
    }
    switch (t) {
      case 'Identifier': return;                        // 绑定名、标签名这类非引用位置
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        walk(node.object, s, 'ref');
        if (node.computed) walk(node.property, s, 'ref');   // `.name` 不是引用
        return;
      }
      case 'ChainExpression': walk(node.expression, s, 'val'); return;
      case 'CallExpression':
      case 'OptionalCallExpression': {
        if (t === 'OptionalCallExpression') { walk(node.callee, s, 'ref'); if (node.computed) walk(node.property, s, 'ref'); }
        else walk(node.callee, s, 'ref');
        node.arguments.forEach(a => walk(a, s, 'ref'));
        return;
      }
      case 'ObjectProperty': {
        if (node.computed) walk(node.key, s, 'ref');
        walk(node.value, s, node.shorthand ? 'ref' : 'val');
        return;
      }
      case 'ObjectMethod': fnScope(node, s); return;
      case 'MethodDefinition':
      case 'ClassMethod':
      case 'PropertyDefinition': {
        if (node.computed) walk(node.key, s, 'ref');
        walk(node.value, s, 'val');
        return;
      }
      case 'LabeledStatement': { s.b.add(node.label.name); walk(node.body, s, 'val'); return; }
      case 'BreakStatement':
      case 'ContinueStatement': return;
      case 'ImportDeclaration':
      case 'ExportAllDeclaration': return;
      case 'ExportNamedDeclaration': {
        if (node.source) return;
        if (node.declaration) { walk(node.declaration, s, 'val'); return; }
        node.specifiers.forEach(sp => { if (sp.local && sp.local.name !== node.source) s.b.add(sp.local.name); });
        return;
      }
      case 'ExportDefaultDeclaration': walk(node.declaration, s, 'val'); return;
      case 'VariableDeclarator': walk(node.init, s, 'ref'); return;
      case 'UnaryExpression': {
        if (node.operator === 'typeof' && node.argument.type === 'Identifier') return;   // 探测未声明名字是合法写法
        walk(node.argument, s, 'ref');
        return;
      }
      case 'AssignmentExpression': {
        const l = node.left;
        if (l.type === 'Identifier' && !has(s, l.name) && unknown(l.name)) report(l, l.name, '赋值给未声明的名字');
        walk(node.right, s, 'ref');
        return;
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration': fnScope(node, s); return;
      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (node.id) s.b.add(node.id.name);
        walk(node.superClass, s, 'ref');
        walk(node.body, s, 'val');
        return;
      }
      case 'BlockStatement': {
        const b = scope(s);
        collectBlock(node, b);
        node.body.forEach(st => walk(st, b, 'val'));
        return;
      }
      case 'ForStatement': {
        const b = scope(s);
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') {
            if (node.init.kind === 'var') add(s, bindNames(node.init.declarations.map(d => d.id)));
            else add(b, bindNames(node.init.declarations.map(d => d.id)));
            node.init.declarations.forEach(d => walk(d.init, b, 'ref'));
          } else walk(node.init, b, 'ref');
        }
        walk(node.test, b, 'ref'); walk(node.update, b, 'ref'); walk(node.body, b, 'val');
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const b = scope(s);
        if (node.left.type === 'VariableDeclaration') {
          if (node.left.kind === 'var') add(s, bindNames(node.left.declarations.map(d => d.id)));
          else add(b, bindNames(node.left.declarations.map(d => d.id)));
        }
        walk(node.right, b, 'ref'); walk(node.body, b, 'val');
        return;
      }
      case 'CatchClause': {
        const c = scope(s);
        if (node.param) add(c, bindNames([node.param]));
        walk(node.body, c, 'val');
        return;
      }
      case 'TemplateLiteral': node.expressions.forEach(e => walk(e, s, 'ref')); return;
      case 'TaggedTemplateExpression': walk(node.tag, s, 'ref'); walk(node.quasi, s, 'ref'); return;
      default: break;
    }
    for (const k of Object.keys(node)) {
      if (SKIP_KEY.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(x => walk(x, s, 'ref'));
      else if (v && typeof v.type === 'string') walk(v, s, 'ref');
    }
  }

  const top = scope(null);
  for (const st of item.ast.program.body) {
    if (st.type === 'ImportDeclaration') add(top, bindNames(st.specifiers.map(sp => sp.local)));
    if (st.type === 'ExportNamedDeclaration' && !st.declaration) st.specifiers.forEach(sp => sp.local && top.b.add(sp.local.name));
  }
  collectFn({ body: item.ast.program }, top);
  collectBlock(item.ast.program, top);
  item.ast.program.body.forEach(st => walk(st, top, 'val'));
  return hits;
}

/* 判据二（同一份文件管的第二类炸法）：搬域接线之后的「求值期读晚绑的名字」。
   `const M = createM({ late }); const { late } = M;` —— 建包那一下读 `late` 就撞 TDZ，
   整个页面挂不起来（2026-10-21 导演台那句 `libPicChoices` 就是这么把 mount 打死的）。
   判据一看不见它：名字解析得到，只是那一行还没绑上。
   口径：只看挂载壳**直接子语句**里当场会跑到的表达式；函数体是推迟的，不算（包成箭头正是这个原理）。 */
function analyzeOrder(ast) {
  const shells = [];
  ast.program.body.forEach(n => {
    if (n.type === 'FunctionDeclaration' && n.body) shells.push(n.body.body);
    if (n.type === 'ExportNamedDeclaration' && n.declaration && n.declaration.type === 'FunctionDeclaration') shells.push(n.declaration.body.body);
  });
  const hits = [];
  for (const body of shells) {
    const mods = [];
    body.forEach(st => {
      if (st.type !== 'VariableDeclaration') return;
      st.declarations.forEach(d => {
        if (!d.id || d.id.type !== 'ObjectPattern' || !d.init || d.init.type !== 'Identifier') return;
        mods.push({ mod: d.init.name, names: d.id.properties.map(p => p.value && p.value.name).filter(Boolean), from: st.loc.start.line });
      });
    });
    if (!mods.length) continue;                     /* 这一层没有域接线 */
    const owner = new Map();
    mods.forEach(m => m.names.forEach(n => { if (!owner.has(n)) owner.set(n, m); }));
    const out = [];
    const walk = (n, lazy) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
        if (lazy) return;                            /* 这一层等到调用时才跑，届时名字都已绑上 */
        n.params.forEach(p => walk(p, true));
        walk(n.body, true);
        return;
      }
      if (n.type === 'Identifier') { if (!lazy) out.push(n.name); return; }
      if (n.type === 'MemberExpression') { walk(n.object, lazy); if (n.computed) walk(n.property, lazy); return; }
      if (n.type === 'ObjectProperty') {
        if (n.shorthand) { out.push(n.key.name); return; }   /* `{ late }` 就是当场读它 */
        if (n.computed) walk(n.key, lazy);
        walk(n.value, lazy);
        return;
      }
      if (n.type === 'VariableDeclarator') { walk(n.init, lazy); return; }
      for (const k of Object.keys(n)) {
        if (SKIP_KEY.has(k) || k === 'name') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(x => walk(x, lazy));
        else if (v && typeof v.type === 'string') walk(v, lazy);
      }
    };
    body.forEach(st => {
      if (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration' || st.type === 'ImportDeclaration') return;
      const L = st.loc.start.line;
      out.length = 0;
      walk(st, false);
      const seen = new Set();
      out.forEach(n => {
        if (seen.has(n)) return;
        seen.add(n);
        const m = owner.get(n);
        if (!m || m.from <= L) return;
        hits.push({ name: n, line: L, why: '求值期读它，但 ' + m.mod + ' 的接线在 ' + m.from + ' 行才绑上（TDZ）' });
      });
    });
  }
  return hits;
}

/* 判据三（搬域这一路最容易犯的一类）：`import { X } from './m.js'`，而 m.js 根本没导出 X。
   2026-10-21 实测：engine.js 里那句是 `import { load as sliceCacheLoad }`，机械搬进
   `engine/frames.js` 时别名丢了，模块拿到一个不存在的导出名 —— 整个导演台页面的模块图当场断，
   `node --check` 通、`tests/all.cjs` 的静态判据全绿（名字在本地是「声明过的」），
   只有真加载页面才炸成「启动失败」。判据一看不见它：那一句是 import，不是裸引用。 */
function exportsOfAst(ast) {
  const names = new Set();
  let star = false, hasExport = false;
  for (const st of ast.program.body) {
    if (st.type === 'ExportDefaultDeclaration') { names.add('default'); hasExport = true; }
    else if (st.type === 'ExportAllDeclaration') { star = true; hasExport = true; }
    else if (st.type === 'ExportNamedDeclaration') {
      hasExport = true;
      (st.specifiers || []).forEach(sp => { if (sp.exported) names.add(sp.exported.name); });
      const d = st.declaration;
      if (d && d.type === 'VariableDeclaration') d.declarations.forEach(x => bindNames([x.id]).forEach(n => names.add(n)));
      else if (d && d.id) names.add(d.id.name);
    }
  }
  return { names, star, hasExport };
}
function analyzeImports(items, lookup) {
  const byFile = new Map(items.map(it => [path.resolve(it.file), it]));
  const find = lookup || ((fromFile, spec) => byFile.get(path.resolve(path.dirname(fromFile), spec)));
  const hits = [];
  for (const it of items) {
    if (!it.isModule) continue;                     // 经典脚本没有 import
    for (const st of it.ast.program.body) {
      if (st.type !== 'ImportDeclaration') continue;
      const spec = st.source && st.source.value;
      if (!spec || !spec.startsWith('.')) continue; // 裸说明符不是本层文件
      const target = find(it.file, spec);
      if (!target) continue;                        // 指向的不是这一层里的源码（worker 之类）
      const ex = exportsOfAst(target.ast);
      /* 读不出任何导出、或整份再导出：那是「不知道」，不是「没有」—— 不许当违例。 */
      if (!ex.hasExport || ex.star) continue;
      for (const sp of st.specifiers) {
        if (sp.type !== 'ImportSpecifier') continue;
        if (ex.names.has(sp.imported.name)) continue;
        hits.push({ line: st.loc && st.loc.start.line, file: it.file, name: sp.local.name,
          why: '「' + spec + '」没有导出 ' + sp.imported.name
            + (sp.local.name === sp.imported.name ? '' : '（别名 ' + sp.local.name + ' 是从源模块的导出名丢出来的）') });
      }
    }
  }
  return hits;
}

/* 判据四（搬域接线的「名字形状」对不上）：`const F = createF({ REG: (...a) => REG(...a) })` ——
   接线默认按「这是函数」包箭头，而 engine 里那一枚是 `let REG = {}` 这样的**状态**。
   2026-10-21 实测四处全是这一族，且全都静默：模块里 `REG.foo` 拿到 undefined（不抛错），
   严格模式下 `Gen.voiceAssetBase(v)` 那种读法干脆把整段流程带停；`vcTab = 'gen'` 写成
   `setVcTab(...)` 的反向错（对 const 赋值）也一样只在那一行才炸。
   判据一看不见它：名字解析得到；判据二看不见它：调用点不在求值期。
   口径：只看挂载壳**直接子语句**里的 `const 名 = createX({ … })` 那一份实参（搬家工具就生成这个形状），
   三种包法各查一件事 ——
     · `k: (...a) => T(...a)`  T 必须真是函数（或解构来的、形状看不出）；
     · `k: () => T` / `k: T`   T 必须在本层存在；
     · `k: v => { T = v; }`    T 必须存在且**可写**（const / 函数声明名写了当场红）。
   不看别的对象字面量，也不猜「这个变量可能是别处赋过值的函数」—— 宁少报，不制造噪音。 */
function analyzeWires(item, env) {
  const ast = item.ast;
  const globals = (env && env.globals) || BUILTIN;
  const shells = [];
  ast.program.body.forEach(n => {
    if (n.type === 'FunctionDeclaration' && n.body) shells.push(n);
    if (n.type === 'ExportNamedDeclaration' && n.declaration && n.declaration.type === 'FunctionDeclaration') shells.push(n.declaration);
  });
  const hits = [];
  const isFnInit = i => i && (i.type === 'ArrowFunctionExpression' || i.type === 'FunctionExpression');
  for (const shell of shells) {
    const kind = new Map();
    const put = (name, k) => { if (name && !kind.has(name)) kind.set(name, k); };
    /* 本层「看得见但形状看不出」的名字：import 进来的、window 挂出来的、挂载壳自己的形参。
       它们只用来满足「存在」，不参与形状判定 —— 这一条判据要抓的是**本层自己声明**的那一枚状态
       被当成函数调用（本轮实测的 REG / voiceDraft / vcTab / Gen 全是这一族），不是猜别层的类型。 */
    ast.program.body.forEach(st => {
      if (st.type === 'ImportDeclaration') bindNames(st.specifiers.map(sp => sp.local)).forEach(n => put(n, 'import'));
    });
    (shell.params || []).forEach(pa => bindNames([pa]).forEach(n => put(n, 'param')));
    for (const st of shell.body.body) {
      if (st.type === 'VariableDeclaration') {
        st.declarations.forEach(d => {
          const names = bindNames([d.id]);
          if (d.id.type !== 'Identifier') { names.forEach(n => put(n, 'bound')); return; }  /* 解构来的：形状看不出 */
          put(names[0], isFnInit(d.init) ? 'function' : st.kind);
        });
      } else if (st.type === 'FunctionDeclaration' && st.id) put(st.id.name, 'function');
      else if (st.type === 'ClassDeclaration' && st.id) put(st.id.name, 'function');
    }
    for (const st of shell.body.body) {
      if (st.type !== 'VariableDeclaration') continue;
      for (const d of st.declarations) {
        const i = d.init;
        if (!i || i.type !== 'CallExpression' || !i.callee || i.callee.type !== 'Identifier') continue;
        if (!/^create/.test(i.callee.name)) continue;     // 只查搬域接线那一个形状
        const arg = i.arguments[0];
        if (!arg || arg.type !== 'ObjectExpression') continue;
        const where = d.id.type === 'Identifier' ? d.id.name : '一份解构';
        for (const pr of arg.properties) {
          if (pr.type !== 'ObjectProperty' || !pr.key) continue;
          const key = pr.key.name || pr.key.value;
          const v = pr.value;
          const at = pr.loc && pr.loc.start.line;
          const said = m => hits.push({ line: at, name: key, why: m });
          if (v.type === 'Identifier') {                 // `k: T` / `k,` 简写 —— 按值直递
            if (!kind.has(v.name) && !globals.has(v.name)) said('按值直递给 ' + where + '，但 ' + v.name + ' 在本层既没声明也不是全局 / import');
            continue;
          }
          if (v.type !== 'ArrowFunctionExpression') continue;
          const b = v.body;
          const single = b && b.type === 'BlockStatement' && b.body.length === 1 && b.body[0].type === 'ExpressionStatement'
            ? b.body[0].expression : b;
          const target = single && single.type === 'CallExpression' && single.callee.type === 'Identifier' ? { n: single.callee.name, call: true }
            : single && single.type === 'Identifier' ? { n: single.name, call: false }
              : single && single.type === 'AssignmentExpression' && single.left.type === 'Identifier' ? { n: single.left.name, set: true } : null;
          if (!target) continue;                          // 组装出来的体（`{ a: aOf() }` 之类）不在这一条口径里
          const k = kind.get(target.n);
          if (!k) {
            if (!globals.has(target.n)) said('包给 ' + where + ' 的 ' + key + ' 读了本层没有的 ' + target.n);
            continue;
          }
          if (k === 'bound' || k === 'param' || k === 'import') continue;   // 看不出形状，不猜
          if (target.call && k !== 'function') said(target.n + ' 声明是 ' + k + '，却按函数调用 —— 模块里读它的属性只会拿到 undefined');
          if (target.set && k !== 'let') said(target.n + ' 声明是 ' + k + '，写访问器对它赋值（严格模式当场 TypeError）');
        }
      }
    }
  }
  return hits;
}

/* 判据四的第二半（跨文件那一次对账）：engine 把某一位包成 `k: (...a) => X(...a)`，
   模块里却当**对象**读它（`TlPlay.plan`）—— 读的是那枚箭头函数自己的属性，永远 undefined。
   2026-10-21 就栽在 `TlPlay` 上：它在 engine 里是 `const { playSafe, TlPlay } = createPlayback(…)`
   解构来的，形状看不出来，所以第一半放过；而 renderMid 里 `TlPlay.plan.length` 当场 TypeError，
   把「进剪辑模式」整条路打断（slice / slice-perf / lines 三条 e2e 一起红）。
   口径：接线说「这是函数」，模块的用法说「这是对象」—— 两边一撞就报，任一边单独看都不算错。 */
function wirePairs(items) {
  const byFile = new Map(items.map(it => [path.resolve(it.file), it]));
  const hits = [];
  for (const it of items) {
    for (const st of it.ast.program.body) {
      if (st.type !== 'FunctionDeclaration' && !(st.type === 'ExportNamedDeclaration' && st.declaration)) continue;
      const shell = st.type === 'FunctionDeclaration' ? st : st.declaration;
      if (!shell || !shell.body) continue;
      for (const s2 of shell.body.body) {
        if (s2.type !== 'VariableDeclaration') continue;
        for (const d of s2.declarations) {
          const i = d.init;
          if (!i || i.type !== 'CallExpression' || !i.callee || i.callee.type !== 'Identifier') continue;
          const ctor = i.callee.name;
          if (!/^create/.test(ctor)) continue;
          const arg = i.arguments[0];
          if (!arg || arg.type !== 'ObjectExpression') continue;
          /* createX 是 engine 从哪一份模块 import 进来的，就去找那一份 */
          let target = null;
          for (const ms of it.ast.program.body) {
            if (ms.type !== 'ImportDeclaration' || !ms.source || !String(ms.source.value).startsWith('.')) continue;
            if (!ms.specifiers.some(sp => sp.local.name === ctor)) continue;
            target = byFile.get(path.resolve(path.dirname(it.file), ms.source.value));
          }
          if (!target) continue;
          /* 只有「模块自己新造的名字」才不参与对账。从 E 解构来的那一位
             （`const { TlPlay } = E`）恰恰就是 E 传进来的那枚值，不能算本地名字放过。 */
          const local = new Set();
          walkAny(target.ast.program, n => {
            if (n.type === 'FunctionDeclaration' && n.id) local.add(n.id.name);
            if (n.type === 'ClassDeclaration' && n.id) local.add(n.id.name);
            if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier') local.add(n.id.name);
          });
          const calls = new Set(), reads = new Map();
          walkAny(target.ast.program, n => {
            if (n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier') calls.add(n.callee.name);
            if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
              && !n.computed && n.object.type === 'Identifier' && n.property.type === 'Identifier') {
              if (!reads.has(n.object.name)) reads.set(n.object.name, n.loc && n.loc.start.line);
            }
          });
          for (const pr of arg.properties) {
            if (pr.type !== 'ObjectProperty' || !pr.key) continue;
            const key = pr.key.name || pr.key.value;
            const v = pr.value;
            if (!v || v.type !== 'ArrowFunctionExpression') continue;
            const b = v.body;
            const single = b && b.type === 'BlockStatement' && b.body.length === 1 && b.body[0].type === 'ExpressionStatement' ? b.body[0].expression : b;
            if (!(single && single.type === 'CallExpression' && single.callee && single.callee.type === 'Identifier')) continue;
            if (local.has(key)) continue;                        // 模块里有同名的自己人，不算它对不上
            if (calls.has(key)) continue;                        // 模块里真的这样调用过它
            if (reads.has(key)) hits.push({ file: it.file, line: pr.loc && pr.loc.start.line, name: key,
              why: '接线把它包成函数调用，但 ' + path.basename(target.file) + ' 里 '
                + (reads.get(key) || '?') + ' 行按对象读它（' + key + '.×）—— 读到的是 undefined' });
          }
        }
      }
    }
  }
  return hits;
}

function listFiles(dir, out) {  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listFiles(p, out);
    else if (name.endsWith('.js') && !name.startsWith('vue.runtime')) out.push(p);
  }
  return out;
}

/* 判据自检：两条必须探到的合成违例 + 两条不许误报的合成正确写法。 */
function selfCheck() {
  const bad = [];
  const good = [];
  const a = parseSrc(`(function(){ function outer(ok){ if(ok){ const helper=()=>1; helper(); } helper(); } window.A=outer; })();`);
  const b = parseSrc(`(function(){ const C={ build(c){ const { GIVEN }=c; return GIVEN+NOT_GIVEN; } }; window.B=C; })();`);
  const c = parseSrc(`(function(){ function outer(ok){ let helper=()=>1; if(ok){ helper(); } helper(); } window.C=outer; })();`);
  const d = parseSrc(`(function(){ const C={ build(c){ const { GIVEN, GIVEN2 }=c; return GIVEN+GIVEN2; } }; window.D=C; })();`);
  const envOf = (ast, mod) => collectGlobals([{ ast, isModule: mod, label: 'self' }]);
  const mk = (ast, mod) => ({ ast, src: '', file: 'self', isModule: !!mod });
  const count = (ast, mod) => analyze(mk(ast, mod), envOf(ast, mod)).length;
  if (count(a) < 1) bad.push('块内 const 块外裸调没探到');
  if (count(b) < 1) bad.push('共享清单里漏一条没探到');
  if (count(c) > 0) good.push('同一块里先声明后使用被误报');
  if (count(d) > 0) good.push('两份清单都对上被误报');
  const n = s => analyzeOrder(parseSrc(s));
  const oBad = [
    /* 建包那一下直接读搬域的名字：接线在下一行才绑上 */
    'function mount(){ const P = createP({ late });\n const { late } = P; }',
    /* 同一个壳里两处接线，读的是更晚那一条 */
    'function mount(){ const P = createP({ b: () => b });\n const { b } = P;\n const Q = createQ({ c });\n const { c } = Q; }',
  ];
  const oGood = [
    /* 包成箭头 = 推迟到调用时才读 */
    'function mount(){ const P = createP({ late: (...a) => late(...a) });\n const { late } = P; }',
    /* 函数体里的调用点不在求值期跑 */
    'function mount(){ function use(){ return late; }\n const P = createP({});\n const { late } = P; }',
    /* 接线在前，后面才用 */
    'function mount(){ const P = createP({});\n const { late } = P;\n const x = late; }',
  ];
  oBad.forEach((s, i) => { if (!n(s).length) bad.push('接线顺序违例 #' + (i + 1) + ' 没探到'); });
  oGood.forEach((s, i) => { const h = n(s); if (h.length) good.push('接线顺序正确写法 #' + (i + 1) + ' 被误报（' + h[0].name + '）'); });
  /* 判据三的合成样本：一份真导出 + 三种 import 写法（对得上 / 带别名对得上 / 名字根本不存在）。 */
  const tgt = { file: 't.js', isModule: true, ast: parseSrc('export function load(k){} export const put = 1; export default 2;') };
  const imp = src => ({ file: 'i.js', isModule: true, ast: parseSrc(src) });
  const look = () => tgt;
  const iBad = [imp(`import { nope } from './t.js'; window.Q = nope;`)];
  const iGood = [imp(`import { load, put } from './t.js'; window.Q = [load, put];`),
    imp(`import { load as sliceCacheLoad } from './t.js'; window.Q = sliceCacheLoad;`),
    imp(`import def from './t.js'; window.Q = def;`),
    imp(`import * as all from './t.js'; window.Q = all;`)];
  iBad.forEach((it, i) => { if (!analyzeImports([it], look).length) bad.push('import 名字对不上导出 #' + (i + 1) + ' 没探到'); });
  iGood.forEach((it, i) => { const h = analyzeImports([it], look); if (h.length) good.push('import 正确写法 #' + (i + 1) + ' 被误报（' + h[0].name + '）'); });
  /* 判据四的合成样本：接线形状与名字声明对不上（本轮实测到的那四种错法各一条）。 */
  const w = s => analyzeWires({ ast: parseSrc(s), file: 'self', isModule: false }, { globals: BUILTIN });
  const wBad = [
    'function mount(){ let REG={a:1}; const F = createF({ REG: (...a) => REG(...a) }); }',
    'function mount(){ const P = createP({ X: (...a) => Nope(...a) }); }',
    'function mount(){ const K = 1; const P = createP({ setK: v => { K = v; } }); }',
    'function mount(){ function k(){} const P = createP({ X: Nope }); }',
  ];
  const wGood = [
    'function mount(){ function REG(){} const P = createP({ REG: (...a) => REG(...a) }); }',
    'function mount(){ let REG={}; const P = createP({ REGOf: () => REG, setREG: v => { REG = v; } }); }',
    'function mount(){ const { fillSlices } = Board; const P = createP({ fillSlices: (...a) => fillSlices(...a) }); }',
    'function mount(){ const o = { X: (...a) => Nope(...a) }; const P = createP({ Y: 1 }); }',
    'function mount(document, window){ const P = createP({ doc: () => document, fire: (...a) => window.dispatchEvent(...a) }); }',
  ];
  wBad.forEach((s, i) => { if (!w(s).length) bad.push('接线形状违例 #' + (i + 1) + ' 没探到'); });
  wGood.forEach((s, i) => { const h = w(s); if (h.length) good.push('接线形状正确写法 #' + (i + 1) + ' 被误报（' + h[0].name + '）'); });
  /* 判据四第二半的合成样本：一份 engine + 一份模块，跨文件对账（本轮 TlPlay 那一类）。 */
  const pair = (engSrc, modSrc, modBody) => wirePairs([
    { file: 'eng.js', src: '', isModule: true, ast: parseSrc(engSrc) },
    { file: path.join('m', 'x.js'), src: '', isModule: true, ast: parseSrc(modSrc.replace('@@BODY@@', modBody)) },
  ]);
  const ENG = `import { createX } from './m/x.js';
export function mount(){ const TlPlay = {}; const TP = TlPlay; const X = createX({ TP: (...a) => TP(...a), fn: (...a) => fn(...a) }); }
function fn(){}`;
  const MOD = `export function createX(E){ const { TP, fn } = E; @@BODY@@ return { go }; }`;
  const pBad = pair(ENG, MOD, 'function go(){ return TP.plan.length; }');
  if (!pBad.length) bad.push('接线包成调用、模块按对象读（TlPlay 那一类）没探到');
  const pGood = [
    pair(ENG, MOD, 'function go(){ return fn(TP); }'),                 // 模块真的这样调用它
    pair(ENG, MOD, 'function go(){ const TP = { plan: [] }; return TP.plan.length; }'),  // 模块自己的同名局部名
    pair(ENG, MOD, 'function go(){ const { plan } = E.TP || {}; return plan; }'),         // 读的是 E 那一层，不是裸名字
  ];
  pGood.forEach((h, i) => { if (h.length) good.push('跨文件对账正确写法 #' + (i + 1) + ' 被误报（' + h[0].name + '）'); });
  bad.concat(good).forEach(x => console.log('  ✗ 判据自检：' + x));
  return !bad.length && !good.length;
}

const unparsed = [];
const items = listFiles(path.join(__dirname, '..', 'web'), []).map(f => {
  const src = fs.readFileSync(f, 'utf8');
  let ast;
  try { ast = parseSrc(src); }
  catch (e) {
    /* 解析不了 = 这一份文件对这个探测器完全隐形：它一句违例也报不出来，
       必须当场判红，不能让「存量 0 处」盖住一个连语法都不过的文件。 */
    unparsed.push(path.relative(process.cwd(), f) + ' —— ' + e.message);
    return null;
  }
  return { file: f, src, ast, isModule: isModuleAst(ast) };
}).filter(Boolean);

const env = collectGlobals(items);
let total = 0, order = 0, impBad = 0, wireBad = 0;
const rows = [];
const orderRows = [];
const impRows = [];
const wireRows = [];
for (const it of items) {
  const hits = analyze(it, env);
  if (hits.length) {
    total += hits.length;
    rows.push('  ' + path.relative(process.cwd(), it.file) + '：' + hits.map(h => h.name + ' @' + h.line + '（' + h.why + '）').join('、'));
  }
  const oh = analyzeOrder(it.ast);
  if (oh.length) {
    order += oh.length;
    orderRows.push('  ' + path.relative(process.cwd(), it.file) + '：' + oh.map(h => h.name + ' @' + h.line + '（' + h.why + '）').join('、'));
  }
  const wh = analyzeWires(it, env);
  if (wh.length) {
    wireBad += wh.length;
    wireRows.push('  ' + path.relative(process.cwd(), it.file) + '：' + wh.map(h => h.name + ' @' + h.line + '（' + h.why + '）').join('、'));
  }
}
const ih = analyzeImports(items);
if (ih.length) {
  impBad = ih.length;
  ih.forEach(h => impRows.push('  ' + path.relative(process.cwd(), h.file) + ' @' + h.line + '：' + h.why));
}
const ph = wirePairs(items);
if (ph.length) {
  wireBad += ph.length;
  ph.forEach(h => wireRows.push('  ' + path.relative(process.cwd(), h.file) + ' @' + h.line + '：' + h.why));
}

console.log('作用域判据（' + items.length + ' 个 web 源码文件）');
if (unparsed.length) {
  unparsed.forEach(x => console.log('  ✗ 解析失败：' + x));
  console.log('✗ ' + unparsed.length + ' 个文件连语法都不过，探测器对它隐形');
  process.exit(1);
}
if (rows.length) rows.forEach(r => console.log(r));
else console.log('  ✓ 没有解析不到的裸引用');
if (orderRows.length) orderRows.forEach(r => console.log(r));
else console.log('  ✓ 没有求值期读晚绑的搬域名字');
if (impRows.length) impRows.forEach(r => console.log(r));
else console.log('  ✓ 具名 import 都对得上源模块的导出');
if (wireRows.length) wireRows.forEach(r => console.log(r));
else console.log('  ✓ 搬域接线的名字形状与用法都对得上');
if (!selfCheck()) { console.log('✗ 作用域判据自己的合成违例没探到（探测器坏了，不是代码坏了）'); process.exit(1); }
const bad = total + order + impBad + wireBad;
console.log(bad ? '✗ 裸引用 ' + total + ' 处 / 接线顺序 ' + order + ' 处 / import 对不上导出 ' + impBad
  + ' 处 / 接线形状对不上 ' + wireBad
  + ' 处 —— 前两类跑到那一行就是 ReferenceError，后两类是整个模块图断掉或静默拿到 undefined'
  : '✓ 判据自检通过，存量 0 处');
process.exit(bad ? 1 : 0);
