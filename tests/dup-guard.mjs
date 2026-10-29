#!/usr/bin/env node
/* 重复实现零新增（同一个功能只应有一份实现）。
   跑法：`node tests/dup-guard.mjs`；收口之后重打基线：`node tests/dup-guard.mjs --write`。

   数的是「同一个名字在几个文件里定义」：函数声明、顶格 const 箭头 / function、`window.X = fn`。
    已经点名的共享件（fmtWhen / pad2 / errText / blobExtOf / mediaKindFrom / mirrorOf …）
   要求恰好 1 份；其余同名函数是收口前的存量（局部短名 put / render / esc 之类），
   登记在 tests/fixtures/dup-baseline.json 里，**只许减不许增**。
   新长出一份同名定义（两个文件都定义 `foo`）就是新的第二份实现：判据当场红。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const baseFile = path.join(root, 'tests/fixtures/dup-baseline.json');
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(root, 'web'), []), ...walk(path.join(root, 'server'), []), ...walk(path.join(root, 'tools'), [])];

/* 定义点：只认「顶格 / 两格缩进的具名定义」，对象方法（get() {}）不算 —— 那些是接口，
   同名是不同对象上的不同动作（`pager.update` 与 `cards.update` 不是重复实现）。 */
const DEFS = [
  /^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/gm,
  /\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
];
/* 导演台 engine 层算**一个文件**：engine.js 按域机械拆进 engine/*.js（按域拆开，
   只搬函数不改逻辑）。搬出去一份就计一份新的，等于「拆得越干净越有罪」—— 数的是重复实现，
   不是文件数。层**内部**真长出第二份由 tests/scope-guards.cjs 与人工走查管，这一条只守跨层。 */
const bucketOf = rel => rel.startsWith('web/director/engine/') ? 'web/director/engine.js' : rel;
function scan() {
  const map = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = bucketOf(path.relative(root, f).replace(/\\/g, '/'));
    for (const re of DEFS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        if (!map.has(m[1])) map.set(m[1], new Set());
        map.get(m[1]).add(rel);
      }
    }
  }
  return map;
}

const map = scan();
let bad = 0;
const dup = {};
for (const [name, set] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) if (set.size > 1) dup[name] = set.size;

if (WRITE) {
  const next = { ...base, names: dup };
  fs.writeFileSync(baseFile, JSON.stringify(next, null, 2) + '\n');
  console.log('已重打基线：' + Object.keys(dup).length + ' 个同名定义');
  process.exit(0);
}

const lines = [];
/* ① 已点名的共享件：恰好一份 */
for (const [name, want] of Object.entries(base.single || {})) {
  const n = map.has(name) ? map.get(name).size : 0;
  if (n !== want) {
    bad++;
    lines.push('  ✗ ' + name + '：定义在 ' + n + ' 个文件（应为 ' + want + '）'
      + (map.has(name) ? ' —— ' + [...map.get(name)].join('、') : ''));
  }
}
/* ② 存量表：只许减 */
for (const [name, max] of Object.entries(base.names || {})) {
  const n = dup[name] || 0;
  if (n > max) {
    bad++;
    lines.push('  ✗ 新长出第二份 `' + name + '`：现在 ' + n + ' 个文件，登记上限 ' + max
      + ' —— ' + [...map.get(name)].join('、'));
  } else if (n < max) {
    lines.push('  ℹ 可以收紧：' + name + ' 现在 ' + n + '，登记 ' + max);
  }
}
/* ③ 表外的新名字：出现两份就是新重复 */
for (const [name, n] of Object.entries(dup)) {
  if (base.names && base.names[name] != null) continue;
  if (base.single && base.single[name] != null) continue;
  bad++;
  lines.push('  ✗ 表外新增重复 `' + name + '`（' + n + ' 个文件）：' + [...map.get(name)].join('、')
    + ' —— 要么收成一份，要么在基线里登记原因');
}

console.log('重复实现判据（' + files.length + ' 个源码文件 · 同名 ' + Object.keys(dup).length + ' 组 · 单份 '
  + Object.keys(base.single || {}).length + ' 项）');
for (const l of lines) console.log(l);
console.log(bad ? '\n✗ ' + bad + ' 处重复实现越界' : '\n✓ 没有新增重复实现');
process.exit(bad ? 1 : 0);
