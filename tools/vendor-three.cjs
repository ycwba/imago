#!/usr/bin/env node
/* 把 npm 包里的 three 取出来，落到 web/vendor/three/ —— 这是 vendored three 的唯一入口。
   跑法：`node tools/vendor-three.cjs`（已有产物就跳过）/ `--force` 重取 / `--version=x.y.z` 换版本。

   为什么不手抄文件清单：examples/jsm 里的文件互相 import，上游每版都可能多一条依赖
   （0.187 的 GLTFLoader 要 BufferGeometryUtils + SkeletonUtils，FBXLoader 要 fflate + NURBSCurve + NURBSUtils）。
   这里只认 5 个入口，剩下的按 import 链递归取。
   `SkeletonUtils.js` 另有 `web/model3d/loader.js` 直接 import（蒙皮原型克隆必须走它）：它虽不在入口表里，
   却是常驻依赖，不是「恰好被 GLTFLoader 带进来」的可有可无件 —— 改入口表时别把它挤掉。

   为什么必须改写说明符：页面是原生 ESM，没有打包步骤，CSP 又不许 inline script，
   所以 **import map 用不了**。`from 'three'` 在浏览器里解析不了，落地时改成同目录的相对路径；
   其余 `../utils/x.js` 这类也压平到同目录（产物是一层平铺的目录，见下面 OUT_DIR 的注释）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'web', 'vendor', 'three');
const LICENSE_OUT = path.join(ROOT, 'three.LICENSE.txt');
const HEADER = '/* 由 tools/vendor-three.cjs 从 npm 包 three 生成，别手改；改动请改脚本后重跑。 */\n';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const VER_ARG = args.find(a => a.startsWith('--version='));
const VERSION = VER_ARG ? VER_ARG.slice('--version='.length) : '0.187.0';

/* 入口：只写人真正要用的那 5 个；依赖由 import 链自己带进来。 */
const ENTRIES = [
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/controls/TransformControls.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/loaders/OBJLoader.js',
  'examples/jsm/loaders/FBXLoader.js',
];
/* build 里那两件是 ESM 本体：three.module.js 里 `export * from './three.core.js'`，
   两件必须在同一目录（压平后天然满足）。 */
const BUILD = ['build/three.module.js', 'build/three.core.js'];

const IMPORT_RE = /(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g;

function run(cmd, cmdArgs, opts) {
  const r = cp.spawnSync(cmd, cmdArgs, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.status !== 0) {
    throw new Error(cmd + ' ' + cmdArgs.join(' ') + ' 失败（' + (r.status || r.signal) + '）：'
      + String(r.stderr || r.stdout || '').trim().slice(0, 600));
  }
  return String(r.stdout || '');
}

function alreadyDone() {
  if (!fs.existsSync(path.join(OUT_DIR, 'three.module.js'))) return false;
  return ENTRIES.every(rel => fs.existsSync(path.join(OUT_DIR, path.basename(rel))));
}

/* 取包：直接从 registry 拉 tgz 再解，不碰项目的 node_modules / package.json。
   不走 `npm pack` 的原因：Windows 上 spawnSync 调 npm.cmd 需要 shell，而 shell + 参数数组
   在有些 npm 版本上会被截断；这里本来也只需要一个 URL。 */
function fetchPackage() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imago-three-'));
  const tgzPath = path.join(tmp, 'three.tgz');
  const url = 'https://registry.npmjs.org/three/-/three-' + VERSION + '.tgz';
  run('node', ['-e', `
    const https=require('https'),fs=require('fs');
    const go=(u,depth)=>{ if(depth>5) throw new Error('重定向太多次');
      https.get(u,{headers:{'user-agent':'imago-vendor-three'}},r=>{
        if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){ r.resume(); return go(r.headers.location,depth+1); }
        if(r.statusCode!==200){ r.resume(); throw new Error('HTTP '+r.statusCode+' '+u); }
        const w=fs.createWriteStream(${JSON.stringify(tgzPath)});
        r.pipe(w); w.on('finish',()=>w.close(()=>process.exit(0)));
      }).on('error',e=>{ throw e; });
    };
    go(${JSON.stringify(url)},0);
  `], { cwd: tmp });
  if (!fs.existsSync(tgzPath) || fs.statSync(tgzPath).size < 1024) throw new Error('tgz 没取下来：' + url);
  /* --force-local：Git Bash 带的是 GNU tar，`C:\…` 会被当成本机名 + 远程路径（Cannot connect to C:） */
  run('tar', ['--force-local', '-xzf', tgzPath, '-C', tmp]);
  const pkg = path.join(tmp, 'package');
  if (!fs.existsSync(pkg)) throw new Error('tgz 解开后没有 package/ 目录');
  return { pkg, tmp };
}

/* 一个文件的相对依赖（跳过裸说明符与 three/addons 注释里的字样） */
function relImports(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[3];
    if (spec === 'three') continue;
    if (!spec.startsWith('.')) continue;
    out.push(spec);
  }
  return out;
}

function rewriteSpecifiers(src, fromRel) {
  return src.replace(IMPORT_RE, (all, kw, q, spec) => {
    if (spec === 'three') return kw + q + './three.module.js' + q;
    if (!spec.startsWith('.')) return all;
    // 压平：目标就是它 basename（依赖图里同名不同目录的文件不会同时出现，最后会校验一次）
    return kw + q + './' + path.basename(spec) + q;
  });
}

function main() {
  if (!FORCE && alreadyDone()) {
    console.log('[vendor-three] 已经落地过（' + path.relative(ROOT, OUT_DIR) + '），跳过；要重取加 --force');
    return;
  }
  console.log('[vendor-three] 取 three@' + VERSION + ' …');
  const { pkg, tmp } = fetchPackage();
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = new Map();     // 落地产物名 -> 源文件（查同名冲突）
  const queue = ENTRIES.slice();
  const seen = new Set();

  function emit(relUnderPkg, dirOfFile) {
    const srcPath = path.join(pkg, dirOfFile, relUnderPkg);
    if (!fs.existsSync(srcPath)) throw new Error('包里没有这个文件：' + path.join(dirOfFile, relUnderPkg));
    const name = path.basename(srcPath);
    const prev = written.get(name);
    if (prev && prev !== srcPath) {
      throw new Error('压平后撞名：' + name + '\n  ' + prev + '\n  ' + srcPath
        + '\n（改 vendor 脚本：给其中一份加前缀，或改成子目录布局）');
    }
    if (prev) return name;
    written.set(name, srcPath);
    const raw = fs.readFileSync(srcPath, 'utf8');
    const body = rewriteSpecifiers(raw, relUnderPkg);
    fs.writeFileSync(path.join(OUT_DIR, name), HEADER + body);
    for (const spec of relImports(raw)) {
      const depPath = path.resolve(path.dirname(srcPath), spec);
      const depRel = path.relative(pkg, depPath);
      if (depRel.startsWith('..')) throw new Error('依赖跑到包外了：' + spec + '（来自 ' + srcPath + '）');
      queue.push(depRel.split(path.sep).join('/'));
    }
    return name;
  }

  for (const b of BUILD) {
    const src = path.join(pkg, b);
    if (!fs.existsSync(src)) throw new Error('包里没有 ' + b);
    const name = path.basename(src);
    const raw = fs.readFileSync(src, 'utf8');
    written.set(name, src);
    // build 两件之间的相对引用保持原样（压平后仍是同目录，路径本来就对）
    fs.writeFileSync(path.join(OUT_DIR, name), HEADER + raw);
  }

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    emit(path.basename(rel), path.dirname(rel));
  }

  const lic = path.join(pkg, 'LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, LICENSE_OUT);

  /* 落地后自检：产物里不许还剩裸说明符，也不许有跨目录的相对路径（压平后只剩 ./同名文件） */
  const bad = [];
  for (const f of fs.readdirSync(OUT_DIR)) {
    const s = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
    for (const m of s.matchAll(IMPORT_RE)) {
      const spec = m[3];
      if (spec === 'three' || spec.startsWith('/') || spec.includes('../')) bad.push(f + ' → ' + spec);
    }
  }
  if (bad.length) throw new Error('改写没干净（浏览器会解析失败）：\n  ' + bad.join('\n  '));

  const rows = fs.readdirSync(OUT_DIR).map(f => ({ f, bytes: fs.statSync(path.join(OUT_DIR, f)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  console.log('[vendor-three] 落地 ' + rows.length + ' 个文件，合计 ' + (total / 1048576).toFixed(2) + ' MB：');
  for (const r of rows) console.log('  ' + r.f + '  ' + (r.bytes / 1024).toFixed(1) + ' KB');
  console.log('[vendor-three] 许可：' + path.relative(ROOT, LICENSE_OUT));
  fs.rmSync(tmp, { recursive: true, force: true });
}

try { main(); } catch (e) {
  console.error('[vendor-three] 失败：' + (e && e.message || e));
  process.exit(1);
}
