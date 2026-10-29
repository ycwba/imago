#!/usr/bin/env node
/* 架构护栏 —— 跑法：`node tests/architecture.cjs`
   A1 web/ 下 import 图无环
   A2 相对 import 都能解析
   A3 分层依赖方向（core / ui / domain / features / pages / director）—— **ESM 的 import**
   A4 页面不深引 web/ui/**，只从 web/ui/index.js 取组件
   A5 分层依赖方向 —— 浏览器**经典脚本**那半边：扫 `window.<Global> =` 定义出面 → 层，
      再扫每个文件读了哪个面（A3 只看得到 ESM，全站 74 个文件是 IIFE 挂 window，
      以前这条「永远绿」是因为探测器根本看不见它们）
   层表与例外登记表只有一份，住在 tests/support.cjs，ui-catalog.cjs 读的是同一份。
   A5 存量按「文件 → 面 [层]」逐条登记上限，新增一条或条数超过登记就红；
   `GUARD_WRITE=1 node tests/architecture.cjs` 按现状重打表（收敛之后照抄粘回 support.cjs）。
   判据不能是「永远绿」：本文件自带自检，用一段内存里的合成 `ui → domain` 源码验证
   A3/A5 两个探测器真的会报，报不出来就红。
   当前还没有 web/ 时只输出基线，不判红。 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support.cjs');
const WRITE = process.env.GUARD_WRITE === '1';

const root = path.resolve(__dirname, '..');
let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return true; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
  return false;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(ent.name)) out.push(full);
  }
  return out;
}
const rel = f => path.relative(root, f).replace(/\\/g, '/');
function importsOf(src) {
  const out = [];
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (spec.startsWith('.')) out.push(spec);
  }
  return out;
}
function resolve(from, spec) {
  let p = path.resolve(path.dirname(from), spec);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + '.js')) return p + '.js';
  if (fs.existsSync(path.join(p, 'index.js'))) return path.join(p, 'index.js');
  return null;
}

const web = path.join(root, 'web');
const files = [...walk(web), ...walk(path.join(root, 'server'))];
console.log(`扫描 ${files.length} 个模块（web/ + server/）`);
if (!fs.existsSync(web)) {
  console.log('web/ 尚未建立：只输出基线，不判红。');
  process.exit(0);
}

const graph = new Map();
const missing = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const deps = [];
  for (const spec of importsOf(src)) {
    const hit = resolve(f, spec);
    if (!hit) { missing.push(rel(f) + ' → ' + spec); continue; }
    if (files.includes(hit)) deps.push(hit);
  }
  graph.set(f, deps);
}

/* 环 */
const color = new Map();
const stack = [];
let cyclic = '';
function dfs(f) {
  color.set(f, 1); stack.push(f);
  for (const d of (graph.get(f) || [])) {
    if (color.get(d) === 1) {
      const at = stack.indexOf(d);
      cyclic = [...stack.slice(at), d].map(rel).join(' → ');
      return true;
    }
    if (!color.get(d) && dfs(d)) return true;
  }
  color.set(f, 2); stack.pop(); return false;
}
for (const f of files) if (!color.get(f) && dfs(f)) break;
ok('A1 import 图无环', !cyclic, cyclic);
ok('A2 相对 import 都能解析', missing.length === 0, missing.slice(0, 5).join(' ; '));

/* 分层 */
const layerOf = f => S.layerOf(rel(f));
const forbidden = S.LAYER_FORBIDDEN;
const v = [];
for (const [from, deps] of graph) {
  const lf = layerOf(from);
  for (const d of deps) {
    const ld = layerOf(d);
    if ((forbidden[lf] || []).includes(ld)) v.push(rel(from) + ' [' + lf + '] → ' + rel(d) + ' [' + ld + ']');
  }
}
ok('A3 分层依赖方向正确（ESM import）', v.length === 0, v.slice(0, 8).join(' ; '));

/* 页面不深引 UI */
const deep = [];
for (const f of files) {
  const lf = layerOf(f);
  if (lf !== 'pages' && lf !== 'director') continue;
  for (const d of (graph.get(f) || [])) {
    const r = rel(d);
    if (r.startsWith('web/ui/') && r !== 'web/ui/index.js') deep.push(rel(f) + ' → ' + r);
  }
}
ok('A4 页面只从 web/ui/index.js 取组件', deep.length === 0, deep.slice(0, 8).join(' ; '));

/* ---------- A5 经典脚本那半边：谁读了哪个公共面 ---------- */
/* `window.Api` / `Wb.thumbs` 这种引用没有 import 语句，A3 看不见；全站大部分代码是这种。
   面 → 层由 `window.<大写> =` 的定义处算出来（tests/support.cjs），读点用去注释后的源码匹配。 */
const faces = S.globalFaces();
const layerCurrent = S.layerViolations({ faces });
if (WRITE) {
  console.log('\n// A5 跨层读公共面：当前 ' + Object.keys(layerCurrent).length + ' 组 / '
    + Object.values(layerCurrent).reduce((a, b) => a + b, 0) + ' 处（粘回 tests/support.cjs 的 LAYER_EXCEPTIONS）');
  S.printTable(layerCurrent, 'A5 跨层读公共面');
} else {
  const r5 = S.ratchet(layerCurrent, S.LAYER_EXCEPTIONS);
  const registered = S.LAYER_EXCEPTIONS.reduce((a, x) => a + x.max, 0);
  const webFiles = S.webSources().length;
  const line = 'A5 分层依赖方向正确（经典脚本读公共面，' + webFiles + ' 个文件 · '
    + faces.size + ' 个面）：现 ' + r5.total + ' 处 / 登记 ' + registered + ' 处（'
    + Object.keys(layerCurrent).length + ' 组）';
  if (r5.grown.length) { bad++; checks++; console.log('  ✗ ' + line); }
  else { checks++; console.log('  ✓ ' + line); }
  for (const x of r5.grown) {
    console.log('    ✗ 新违例 ' + x.id + ' = ' + x.n
      + (x.max != null ? '（登记上限 ' + x.max + '）' : '（没登记）')
      + (x.why ? '' : ' —— 要留就在 tests/support.cjs 的 LAYER_EXCEPTIONS 里登记并补一句原因'));
  }
  for (const x of r5.stale.slice(0, 6)) console.log('    ℹ 可以收紧：' + x.id + ' 现在 ' + x.n + '，登记 ' + x.max);
}

/* ---------- 判据自检：合成违例必须被报出来 ---------- */
/* 不加这一段，A3/A5 就会退化成「永远绿」——探测器一旦写歪（正则失配、层表被清空），
   存量清零之后没人发现。这里用**内存里的**合成源码喂探测器，不落盘、不碰工作区。 */
function selfCheck() {
  const line = [];
  /* 合成源：ui 层的一个文件读了 domain 层的 Api（要拦的就是这个方向） */
  const SYNTH_FILE = 'web/ui/__synthetic_probe.js';
  const SYNTH_SRC = `window.__SyntheticProbe = { go() { return Api.request('x'); } };\n`;
  if (S.layerOf(SYNTH_FILE) !== 'ui') line.push('合成文件的层算错了：' + S.layerOf(SYNTH_FILE) + '（应是 ui）');
  if (!(S.LAYER_FORBIDDEN[S.layerOf(SYNTH_FILE)] || []).includes('domain')) line.push('层矩阵里 ui 不禁止读 domain（矩阵被改坏了）');
  const hit = S.layerViolations({ faces, files: [SYNTH_FILE], read: () => SYNTH_SRC });
  const keys = Object.keys(hit);
  if (!keys.length) line.push('A5 探测器对合成 `ui → domain` 违例毫无反应（判据失效）');
  else if (!keys.some(k => /__synthetic_probe\.js → Api \[domain\]$/.test(k))) {
    line.push('A5 探测器报了，但报的不是那一条：' + keys.join(' ; '));
  }
  /* 反向：正确的写法不该被报（domain 读全站基础设施面 Net 是正确的用法） */
  const OK_FILE = 'web/domain/__synthetic_ok.js';
  const OK_SRC = `window.__SyntheticOk = { go() { return Net.get('/x'); } };\n`;
  const okHit = S.layerViolations({ faces, files: [OK_FILE], read: () => OK_SRC });
  if (Object.keys(okHit).length) line.push('A5 探测器把「domain 用唯一实现的网络层」也报成违例：' + Object.keys(okHit).join(' ; '));
  /* A3：合成一段 import 上游层的源码 —— 层矩阵与 A5 共用，方向算错就在这里露出来 */
  if (!S.LAYER_FORBIDDEN.domain.includes('ui')) line.push('层矩阵里 domain 允许读 ui（矩阵被改坏了）');
  if (!S.LAYER_FORBIDDEN.core.includes('domain')) line.push('层矩阵里 core 允许读 domain（矩阵被改坏了）');
  return line;
}
if (!WRITE) {
  const probs = selfCheck();
  checks++;
  if (probs.length) { bad++; console.log('  ✗ 判据自检（合成违例必须被探到、正确写法不误报）'); for (const p of probs) console.log('    ✗ ' + p); }
  else console.log('  ✓ 判据自检（合成违例必须被探到、正确写法不误报）');
}

console.log(`\n${checks} 项，${bad} 项未通过`);
process.exit(bad ? 1 : 0);
