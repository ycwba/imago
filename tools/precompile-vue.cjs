/* 预编译 Vue 模板：tools/vue-templates/*.html → web/render/*.js
   运行时只加载 render 函数（严格 CSP：script-src 'self'，不需要 unsafe-eval）。
   开发期改了模板就跑 `node tools/precompile-vue.cjs`；`--check` 只比对不写盘。 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const TPL_DIR = path.join(root, 'tools', 'vue-templates');
const OUT_DIR = path.join(root, 'web', 'render');
const VUE_RUNTIME = '../../vue.runtime.esm-browser.prod.js';
const NAMES = [
  'app-loading', 'app-error', 'app-shell',
  /* 画布页已下线（2026-10-24）：模板、页面、样式与那一族测试一并删除，
     预编译清单里也就不再有它 —— 清单里留着一条会去找一份不存在的模板，直接构建失败。 */
  'assets', 'chars', 'favorites', 'settings', 'studio', 'usage', 'director',
];

function getCompiler() {
  try { return require('@vue/compiler-dom'); }
  catch (e) {
    throw new Error('缺少开发依赖 @vue/compiler-dom：先在项目根目录跑一次 npm install（运行时不需要它）');
  }
}

function build(name, compile) {
  /* 行尾先归一化：模板源在 Windows 上检出是 CRLF，编译器会把 \r\n **原样编进注释文本**，
     于是产物随「这台机器怎么检出」变 —— 同一份模板在两台机器上编出两份产物，
     build:check 也就跟着随机地红。归一化成 LF，产物才与检出方式无关。 */
  const raw = fs.readFileSync(path.join(TPL_DIR, name + '.html'), 'utf8');
  const src = raw.replace(/\r\n/g, '\n');
  const errors = [];
  const warnings = [];
  const out = compile.compile(src, {
    mode: 'module',
    prefixIdentifiers: true,
    hoistStatic: true,
    onError: e => errors.push(e),
    onWarn: e => warnings.push(e),
  });
  if (errors.length) {
    const lines = errors.map(e => (e.loc ? `${e.loc.start.line}:${e.loc.start.column} ` : '') + e.message);
    throw new Error(name + '.html 编译失败：\n  ' + lines.join('\n  '));
  }
  const code = out.code.replace(/from "vue"/g, 'from "' + VUE_RUNTIME + '"');
  return '/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/' + name + '.html 编译，别手改。 */\n'
    + code.trimEnd() + '\n';
}

const check = process.argv.includes('--check');
const compile = getCompiler();
fs.mkdirSync(OUT_DIR, { recursive: true });
let bad = 0;
for (const name of NAMES) {
  const outFile = path.join(OUT_DIR, name + '.js');
  const next = build(name, compile);
  const prev = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (check) {
    if (prev !== next) { bad++; console.log('✗ ' + name + '.js 与模板不一致：跑 npm run build'); }
  } else if (prev !== next) {
    fs.writeFileSync(outFile, next, 'utf8');
    console.log('✓ ' + name + '.js');
  }
}
if (check) {
  if (bad) { console.log('\n✗ ' + bad + ' 份 render 函数过期'); process.exit(1); }
  console.log('✓ ' + NAMES.length + ' 份 render 函数与模板一致');
}
