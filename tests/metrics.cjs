#!/usr/bin/env node
/* 源码行数 / 字节基线 —— 跑法：`node tests/metrics.cjs [--write|--strict]`
   统计源码（.js/.html/.css），排除 Vue vendor、tests、docs、备份与用户数据。
   codeLines = 去掉空行与注释后的行数；vendor 单列。
   默认只**打印**（本地要知道自己长胖了多少）；`--strict` 把两件事变成会红的判据（`tests/all.cjs` 固定带这一档）：
     M1 基线文件在且能读 —— 基线丢了，「不超基线 5%」这句就成了空话，必须红
     M2 总行数 / 代码行不超过基线 +5%（整体别膨胀；用 `--write` 重打基线承认一次正当增长）
   `--write` 重打基线（收敛之后或结构搬家用它，别为了让判据绿而写）。 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');
const STRICT = process.argv.includes('--strict');
const BASE = path.join(__dirname, 'metrics-baseline.json');
const LINE_LIMIT = 1500;          // 打印用：哪些文件算「超大」（不判红）
const GROWTH_PCT = 5;             // 「总量相对基线」判据线
/* `design/` 曾经是设计提案目录（静态预览稿，不被 shell.html / web/ 引用、不进构建、
   不进运行时），和 docs / tools 同一类 —— 拿它算源码体积只会把判据线越推越松。
   目录已删，但排除项留着：以后再放设计稿进来时，判据线不该被它顶松。 */
/* vendor：第三方 vendored 代码（vue / mediabunny / asr / three）不是我们写的，不参与行数判据 ——
   这正是这条清单原本的口径（EXCLUDE_FILES 那条注释），只是以前只排了单文件、没排整个目录。 */
const EXCLUDE_DIRS = new Set(['tests', 'docs', '_backup', '.git', 'node_modules', 'prompts', '文件', '.shots', '.data', '.assets', '.renders', 'render', 'tools', 'design', 'vendor']);
/* vendored 第三方（本地带上、运行时零构建）：压过的产物不是我们的代码，不参与行数判据 */
const EXCLUDE_FILES = new Set(['vue.runtime.esm-browser.prod.js', 'mediabunny-aac-encoder.min.js']);
const EXTS = new Set(['.js', '.html', '.css']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(ent.name)) && !EXCLUDE_FILES.has(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/* 去掉注释，保留字符串与模板串里的内容。够用的扫描器，不猜 HTML/CSS 语义。 */
function stripJs(src) {
  let out = '', i = 0, q = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { if (i + 1 < src.length) out += src[++i]; i++; continue; }
      if (c === q) q = '';
      i++; continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c; i++;
  }
  return out;
}
function stripHtml(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}
function stripCss(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}
function strip(src, ext) {
  if (ext === '.html') return stripHtml(src);
  if (ext === '.css') return stripCss(src);
  return stripJs(src);
}
function countLines(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (const l of lines) if (l.trim()) n++;
  return n;
}
function human(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function collect() {
  const files = walk(root);
  const rows = [];
  let totalBytes = 0, codeBytes = 0, totalLines = 0, codeLines = 0;
  for (const full of files) {
    const rel = path.relative(root, full).replace(/\\/g, '/');
    const ext = path.extname(full);
    const buf = fs.readFileSync(full);
    const text = buf.toString('utf8');
    const code = strip(text, ext);
    const cLines = countLines(code);
    const cBytes = Buffer.byteLength(code, 'utf8');
    const tLines = countLines(text);
    rows.push({ file: rel, lines: tLines, codeLines: cLines, bytes: buf.length, codeBytes: cBytes });
    totalBytes += buf.length; codeBytes += cBytes; totalLines += tLines; codeLines += cLines;
  }
  rows.sort((a, b) => b.lines - a.lines);
  const vendor = path.join(root, 'vue.runtime.esm-browser.prod.js');
  const vendorInfo = fs.existsSync(vendor) ? {
    file: 'vue.runtime.esm-browser.prod.js',
    lines: fs.readFileSync(vendor, 'utf8').split(/\r?\n/).length,
    bytes: fs.statSync(vendor).size,
  } : null;
  return { at: new Date().toISOString(), totalLines, codeLines, totalBytes, codeBytes, moduleCount: rows.filter(r => /\.(js|html)$/.test(r.file)).length, files: rows, vendor: vendorInfo };
}

const cur = collect();
console.log(`源码文件 ${cur.files.length} 个（JS/HTML ${cur.moduleCount}）`);
console.log(`总行数 ${cur.totalLines} · 代码行 ${cur.codeLines}（注释/空行 ${cur.totalLines - cur.codeLines}）`);
console.log(`总字节 ${human(cur.totalBytes)} · 代码字节 ${human(cur.codeBytes)}`);
if (cur.vendor) console.log(`Vue vendor 单列：${cur.vendor.lines} 行 / ${human(cur.vendor.bytes)}`);
console.log('\n最大的 15 个文件：');
for (const r of cur.files.slice(0, 15)) console.log(`  ${String(r.lines).padStart(6)} 行  ${String(r.codeLines).padStart(6)} 代码  ${r.file}`);

/* ---------- --strict 的三条判据（本地不加这个参数就只是打印） ---------- */
function overPct(curVal, baseVal, pct) {
  return baseVal > 0 && curVal > baseVal * (1 + pct / 100);
}
function bigFilesOver(rows) {
  const out = {};
  for (const r of rows) if (r.lines > LINE_LIMIT) out[r.file] = r.lines;
  return out;
}
/* 探测器自检：判据自己不验证自己，就会退化成永远绿 —— 合成一份「胖了 20% 的基线」，
   报不出来就是这条判据坏了。 */
function selfCheck() {
  const probs = [];
  if (!overPct(106, 100, GROWTH_PCT)) probs.push('总量判据对「+6%」没反应');
  if (overPct(104, 100, GROWTH_PCT)) probs.push('总量判据把「+4%」也报红（阈值算错）');
  return probs;
}
function strictGate(cur) {
  let bad = 0, checks = 0;
  const ok = (name, cond, detail) => {
    checks++;
    if (cond) { console.log('  ✓ ' + name); return true; }
    bad++;
    console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
    return false;
  };
  let base = null, baseErr = '';
  try {
    base = JSON.parse(fs.readFileSync(BASE, 'utf8')).baseline;
    if (!base || typeof base.totalLines !== 'number') baseErr = '基线里没有 totalLines（跑 `node tests/metrics.cjs --write` 重打）';
  } catch (e) { baseErr = e.code === 'ENOENT' ? 'tests/metrics-baseline.json 不存在' : '基线 JSON 读不动：' + e.message; }
  ok(`M1 基线可读（总量判据要有东西可比）`, !!base && !baseErr, baseErr);

  const pct = (a, b) => (b ? ((a - b) / b * 100).toFixed(1) : '∞') + '%';
  if (base && !baseErr) {
    ok(`M2 总行数不超基线 +${GROWTH_PCT}%（现 ${cur.totalLines} / 基线 ${base.totalLines} = ${pct(cur.totalLines, base.totalLines)}）`,
      !overPct(cur.totalLines, base.totalLines, GROWTH_PCT),
      '胖了 ' + (cur.totalLines - base.totalLines) + ' 行：要么是真该删的死代码，要么用 --write 承认这次搬家');
    ok(`M2 代码行不超基线 +${GROWTH_PCT}%（现 ${cur.codeLines} / 基线 ${base.codeLines} = ${pct(cur.codeLines, base.codeLines)}）`,
      !overPct(cur.codeLines, base.codeLines, GROWTH_PCT),
      '胖了 ' + (cur.codeLines - base.codeLines) + ' 行');
  } else {
    checks += 2; bad += 2;
    console.log('  ✗ M2 总行数/代码行不超基线 +' + GROWTH_PCT + '% —— 没有基线，无从判');
  }

  const probs = selfCheck();
  ok('判据自检（合成「胖了 20%」必须被报出来）', probs.length === 0, probs.join(' ; '));
  console.log('\n' + checks + ' 项，' + bad + ' 项未通过');
  return bad;
}

if (WRITE) {
  fs.writeFileSync(BASE, JSON.stringify({ version: 1, baseline: cur }, null, 2) + '\n');
  console.log('\n已写入基线：tests/metrics-baseline.json');
  process.exit(0);
}
let bad = 0;
if (fs.existsSync(BASE) || STRICT) {
  let base = null;
  try { base = JSON.parse(fs.readFileSync(BASE, 'utf8')).baseline; } catch (e) {}
  if (base) {
    const d = (a, b) => (a - b >= 0 ? '+' : '') + (a - b);
    console.log('\n相对基线：');
    console.log(`  总行数 ${d(cur.totalLines, base.totalLines)} · 代码行 ${d(cur.codeLines, base.codeLines)}`);
    console.log(`  总字节 ${d(cur.totalBytes, base.totalBytes)} · 代码字节 ${d(cur.codeBytes, base.codeBytes)}`);
  }
}
if (STRICT) {
  console.log('\n严格判据：');
  bad += strictGate(cur);
} else {
  const over = bigFilesOver(cur.files);
  console.log('\n超过 ' + LINE_LIMIT + ' 行的文件：' + Object.keys(over).length + ' 个（只打印，不判红）');
}
process.exit(bad ? 1 : 0);
