#!/usr/bin/env node
/* 导演台按域搬线的那一层，有一类错是「语法档与 vm 自检全绿、只有真跑到那一行才炸」：
   域模块顶上 `const { … } = E` 里点名的那一位，engine.js 递进来的那一只对象里根本没有 ——
   解构出来是 undefined，走到那条分支才炸。炸法最坏的一种不是报错，是**静默失灵**：
   预览轴那一位（拖把手期间该停掉预览轴）漏在名单里，pointermove 一进那句就抛，
   于是「鼠标划过轨道」整条什么都没发生，界面上看不出坏过。

   这一档只问一件事：**每一位在模块里点了名，就必须在 E 里真有一件东西递进来**。
   E 里多出来的不算错（域模块也能经参数名遮蔽的 document / window 读全局）。
   解析器用 @babel/parser（随 @vue/compiler-dom 而来，只开发期用，不进运行时）；没有就整档跳过并报明。 */
'use strict';
const fs = require('fs');
const path = require('path');

let parser;
try { parser = require('@babel/parser'); }
catch (e) { console.log('  （跳过域接线判据：没有 @babel/parser，先跑一次 npm install）'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'web', 'director', 'engine.js');
const DIR = path.join(ROOT, 'web', 'director', 'engine');
const parse = file => parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', ecmaVersion: 2023, allowAwaitOutsideFunction: true }).program;

/* 一只对象字面量里「能静态点出名」的键：简写、`名: 值`、getter / 方法都算；
   展开（`...x`）与计算键（`[k]: v`）认不出名字，单独记一笔 —— 有它们就没法判「缺」。 */
function keysOf(obj) {
  const keys = new Set();
  let loose = 0;
  for (const p of obj.properties) {
    if (p.type === 'SpreadElement' || p.type === 'RestElement') { loose++; continue; }
    if (p.computed) { loose++; continue; }
    const k = p.key;
    if (k && (k.type === 'Identifier' || k.type === 'StringLiteral')) keys.add(k.name || k.value);
  }
  return { keys, loose };
}

/* 域模块：`export function createX(E, …) { const { a, b } = E; … }` */
function moduleFace(file) {
  const ast = parse(file);
  const creator = ast.body.find(n => n.type === 'ExportNamedDeclaration'
    && n.declaration && n.declaration.type === 'FunctionDeclaration'
    && /^create[A-Z]/.test(n.declaration.id.name));
  if (!creator) return null;
  const fn = creator.declaration;
  const paramName = fn.params[0] && fn.params[0].name;
  if (!paramName) return null;
  const names = [];
  let hasRest = false;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'ObjectPattern'
      && node.init && node.init.type === 'Identifier' && node.init.name === paramName) {
      for (const p of node.id.properties) {
        if (p.type === 'RestElement') { hasRest = true; continue; }
        const k = p.key;
        if (k && (k.type === 'Identifier' || k.type === 'StringLiteral')) names.push(k.name || k.value);
      }
    }
    for (const key in node) if (key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments') walk(node[key]);
  };
  walk(fn.body);
  return { creator: fn.id.name, names: [...new Set(names)], hasRest };
}

/* engine.js：`const X = createY({ … })` 或直接 `createY({ … })` */
function assemblyMap(file) {
  const ast = parse(file);
  const out = new Map();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier'
      && /^create[A-Z]/.test(node.callee.name)) {
      const arg = node.arguments[0];
      if (arg && arg.type === 'ObjectExpression') out.set(node.callee.name, keysOf(arg));
      else out.set(node.callee.name, { keys: new Set(), loose: 1 });   // 不是字面量：认不出，整只按宽松处理
    }
    for (const key in node) if (key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments') walk(node[key]);
  };
  walk(ast);
  return out;
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js')).sort();
const asm = assemblyMap(ENGINE);
const bad = [];
let nNames = 0;
for (const f of files) {
  const face = moduleFace(path.join(DIR, f));
  if (!face) { bad.push('engine/' + f + '：找不到 `export function createX(E, …)` 这一面'); continue; }
  const got = asm.get(face.creator);
  if (!got) { bad.push(face.creator + '（engine/' + f + '）：engine.js 里没有这一只接线对象'); continue; }
  if (face.hasRest) { console.log('  · ' + face.creator + '：顶上用了 `...` 解构，这一档判不了「缺谁」，跳过'); continue; }
  nNames += face.names.length;
  const miss = face.names.filter(n => !got.keys.has(n));
  if (miss.length) {
    bad.push(face.creator + '（engine/' + f + '）：E 里没递进来 ' + miss.length + ' 位 → ' + miss.join(', '));
    continue;
  }
  if (got.loose) console.log('  · ' + face.creator + '：E 里有展开 / 计算键，只能按点到的名字判（本轮 ' + face.names.length + ' 位全在）');
}

console.log(bad.length ? '✗ 域接线名单对不上：\n  ' + bad.join('\n  ')
  : '✓ 域接线名单逐名对上：' + files.length + ' 个域模块、' + nNames + ' 位都在 E 里');
process.exit(bad.length ? 1 : 0);
