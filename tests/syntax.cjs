#!/usr/bin/env node
/* 语法判据（常驻）—— 跑法：`node tests/syntax.cjs`
   三档流程的第一档：`npm run check` = 模板与生成物一致 + 全部 JS 语法，<3 秒。
   `tests/all.cjs` 的语法段与 `npm run check` 共用这一份（判据不留两份，两份一定漂移）。

   为什么不再维护手写清单：旧 all.cjs 里 CLASSIC / ESM 两个数组写死了 31 + 40 个文件名，
   **新增的源码文件不进清单就永远不查**（和「spa.cjs 硬编码 render 名」是同一个毛病）。
   这里改成扫仓库：每个源码文件都必须被解析一次，解析不动才红。

   两种模式都试：
     · 脚本模式 —— 24 个 IIFE 经典脚本（挂 window.<Name>，没有 import）
     · 模块模式 —— 页面 / 导演台 / 画布那些 ESM（有 import / export）
   先尽量在进程内解析（vm.Script + vm.SourceTextModule，一次进程扫完全部文件）；
   拿不到模块 API 时退回逐文件 `node --check`（慢一个数量级，判据一模一样）。

   末尾的自检不是摆设：合成一段坏脚本与一段坏模块，探测器必须都报出来 ——
   报不出来就红（「永远绿」的判据比没有判据更危险）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const rel = p => path.relative(root, p).split(path.sep).join('/');
const abs = p => path.join(root, p);
const HAS_MODULE = typeof vm.SourceTextModule === 'function';

/* 扫哪些源码：web / server / tools / tests 四个子树 + 根级 proxy.js。
   排除项都是「不是本项目手写代码」或「用户数据」：Vue vendor、node_modules、
   以点开头的目录（.data / .assets / .renders / .skills / .git 全在里面）、
   prompts 归档、docs 文档、_backup 备份、文件 目录。 */
const SKIP_DIRS = new Set(['node_modules', '_backup', 'prompts', 'docs', '文件']);
const VENDOR = new Set(['vue.runtime.esm-browser.prod.js', 'vue.esm-browser.prod.js']);
const SUBTREES = ['web', 'server', 'tools', 'tests'];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(full, out);
    } else if (VENDOR.has(ent.name)) continue;
    else if (/\.(js|mjs|cjs)$/.test(ent.name)) out.push(full);
  }
  return out;
}

function sources() {
  const out = [];
  for (const d of SUBTREES) {
    const p = abs(d);
    if (fs.existsSync(p)) walk(p, out);
  }
  if (fs.existsSync(abs('proxy.js'))) out.push(abs('proxy.js'));
  return out.sort((a, b) => (rel(a) < rel(b) ? -1 : 1));
}

const msg = e => String((e && (e.stderr ? e.stderr.toString() : e.message)) || e || '解析失败')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 2).join(' · ').slice(0, 200);

/* 脚本模式：进程内解析。用 vm.Script 而不是 new Function —— 后者会把代码跑起来。 */
function asScript(code, name) {
  try { new vm.Script(code, { filename: name }); return ''; } catch (e) { return msg(e); }
}
/* 模块模式：优先进程内（vm.SourceTextModule 只解析、不 link、不执行）。 */
function asModule(code, name, file) {
  if (HAS_MODULE) {
    try { new vm.SourceTextModule(code, { identifier: name }); return ''; } catch (e) { return msg(e); }
  }
  /* 退回子进程：node --check 按最近的 package.json 的 "type" 与扩展名判模式。
     web/package.json 写的是 module，所以 web/ 下的 .js 直接 --check 就按 ESM 读；
     别处（tests/*.mjs 之外）的 ESM 要先复制成 .mjs 才认，这是 all.cjs 一直以来的做法。 */
  const target = (file && fs.existsSync(file)) ? file : null;
  /* .mjs 天生是模块；web/ 下的 .js 靠 web/package.json 的 "type":"module" 也被认成模块。 */
  const checkAsEsm = f => /\.mjs$/.test(f) || /(^|[\\/])web[\\/]/.test(f);
  let tmp = null;
  let probe = target;
  try {
    if (!probe || !checkAsEsm(probe)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-syntax-'));
      probe = path.join(dir, path.basename(name).replace(/\.(js|cjs)$/, '') + '.mjs');
      fs.writeFileSync(probe, code);
      tmp = dir;
    }
    cp.execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
    return '';
  } catch (e) { return msg(e); }
  finally { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} } }
}

/* 一个文件到底是不是 ESM：有顶层 import / export 就先按模块试，省掉一次注定失败的解析。
   判不准也没关系 —— 两种模式都试完才算红。 */
const LOOKS_ESM = /(^|\n)\s*(?:import\s|export\s|import\s*\()/;

function parseCode(code, name, file) {
  const esmFirst = LOOKS_ESM.test(code);
  const order = esmFirst ? [asModule, asScript] : [asScript, asModule];
  const errs = [];
  for (const fn of order) {
    const err = fn(code, name, file);
    if (!err) return { ok: true, mode: fn === asModule ? 'module' : 'script' };
    errs.push(err);
  }
  return { ok: false, error: errs[errs.length - 1] };
}

/* HTML 里的内联 <script>：严格 CSP 不该有它们（spa.cjs 管那条），
   但既然还在，语法必须先是对的 —— 两种错分开报，别混成一条红。 */
function inlineScripts(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m, i = 0;
  while ((m = re.exec(src))) { i++; out.push({ code: m[1], name: rel(file) + '#内联脚本' + i }); }
  return out;
}

/* ---------- 自检：探测器对坏代码真的有反应 ---------- */
function selfCheck() {
  const brokenScript = 'function ( { \n';
  const brokenModule = 'export const a = ;\n';
  const bad1 = parseCode(brokenScript, 'synthetic/script.js', null);
  const bad2 = parseCode(brokenModule, 'synthetic/module.js', null);
  const good = parseCode('import { x } from "./x.js";\nexport default x;\n', 'synthetic/ok.js', null);
  const rows = [];
  rows.push(['坏脚本被报出来', !bad1.ok, bad1.ok ? '解析器对语法坏的文件点了头' : '']);
  rows.push(['坏模块被报出来', !bad2.ok, bad2.ok ? '解析器对语法坏的模块点了头' : '']);
  rows.push(['正常模块不误报', good.ok, good.ok ? '' : good.error]);
  return rows;
}

function run() {
  const t0 = Date.now();
  const files = sources();
  console.log('语法判据（' + files.length + ' 个源码文件 · 解析模式：' + (HAS_MODULE ? '进程内' : 'node --check') + '）');
  let bad = 0, checks = 0;
  const report = (name, cond, detail) => {
    checks++;
    if (cond) return true;
    bad++;
    console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
    return false;
  };
  let scriptFiles = 0, moduleFiles = 0;
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8');
    const name = rel(f);
    if (!code.trim()) { report(name, false, '空文件（是删剩的还是没写完？）'); continue; }
    const r = parseCode(code, name, f);
    if (r.ok) { if (r.mode === 'module') moduleFiles++; else scriptFiles++; }
    report(name, r.ok, r.error);
  }
  for (const f of ['shell.html', 'web/director/template.html']) {
    if (!fs.existsSync(abs(f))) continue;
    const list = inlineScripts(abs(f));
    for (const s of list) report(s.name, asScript(s.code, s.name) === '', asScript(s.code, s.name));
  }
  console.log('  · 脚本模式 ' + scriptFiles + ' 个 · 模块模式 ' + moduleFiles + ' 个');
  const rows = selfCheck();
  for (const [name, cond, detail] of rows) report('自检：' + name, cond, detail);
  console.log((bad ? '✗ ' : '✓ ') + checks + ' 项，' + bad + ' 项未通过（' + (Date.now() - t0) + ' ms）');
  return bad;
}

/* 拿不到 vm.SourceTextModule 时，用一次带旗标的自我重启换回进程内解析
   （逐文件 node --check 在 Windows 上是 60ms × 文件数，会把 3 秒预算吃光）。
   旗标只在子进程里认；子进程再拿不到就老实用 node --check，不会无限递归。 */
function relaunchForModuleApi() {
  if (HAS_MODULE || process.env.AII_SYNTAX_INPROCESS === '1') return null;
  const r = cp.spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', __filename], {
    cwd: root, stdio: 'inherit', env: { ...process.env, AII_SYNTAX_INPROCESS: '1' },
  });
  if (r.error) return null;
  return r.status === null ? 1 : r.status;
}

if (require.main === module) {
  const code = relaunchForModuleApi();
  if (code !== null) process.exit(code);
  process.exit(run() ? 1 : 0);
}

module.exports = { run, sources, parseCode, HAS_MODULE };
