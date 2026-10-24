/* 令牌引用完整性体检：每一条 `var(--x)` 都必须在 tokens.css（或运行时由 JS 写入的行内样式）里有定义。
   漏一个定义 = 那条样式**静默失效**（浏览器不报错，只是那一个值退回继承/初始值），
   所以要有一把尺子量它，而不是等肉眼发现。

   用法：
     node tools/check-vars.cjs            列出未定义的令牌引用（退出码 1）
     node tools/check-vars.cjs --json     输出机器可读结果

   规则表与扫描范围与 tools/tokenize-css.cjs 共用 tools/token-lib.cjs —— 同一个毛病只留一把尺子。 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./token-lib.cjs');

/* 运行时写在 DOM 行内样式上的令牌：CSS 里查不到是正常的，查一下 JS 里有没有真的写。
   分栏比例那几枚（--sp0 / --sp1）由 Wb.split 用**拼出来的名字**写上去
   （box.style.setProperty('--' + h.varName, …)），静态扫不到，所以在这里登记成「运行时令牌」。 */
const RUNTIME_VARS = {
  '--sp0': 'web/ui/workbench.js',
  '--sp1': 'web/ui/workbench.js',
  '--sp2': 'web/ui/workbench.js',
  '--sbw': 'web/ui/sidebar.js',
  '--setnavh': 'web/pages/settings.js',
  '--frs-w': 'web/director/engine/lanes.js',
  '--tlh-voice': 'web/director/template.html',
  '--tlh-inset': 'web/director/template.html',
  '--tlh-gap': 'web/director/template.html',
  '--tlh-pad': 'web/director/template.html',
  '--tlh-ruler': 'web/director/template.html',
  '--tlh-pic': 'web/director/template.html',
  '--tlh-min': 'web/director/template.html',
  '--seg-lab-h': 'web/director/template.html',
  '--seg-wv-h': 'web/director/template.html',
  '--tl-step-px': 'web/director/engine/lanes.js',
  '--film-ar': 'web/director/engine.js',
  '--ac-w': 'web/features/chat.js',
  '--ac-h': 'web/features/chat.js',
  '--ac-top': 'web/features/chat.js',
  '--ac-left': 'web/features/chat.js',
  '--ac-to': 'web/features/chat.js',
  '--ac-ball': 'web/features/chat.js',
  '--dp-cal': 'web/styles/spa-assets.css',
};

/** 定义：tokens.css 里的 `--x:`，以及任何 CSS / 模板 <style> 里的局部自定义属性
    （`.foo { --bar: 10px }` 作用域内有效），以及 JS 里 setProperty 写到 DOM 上的。
    三类都算「有定义」，否则局部变量会被误报成 bug。 */
function definedVars(files) {
  const def = new Set();
  for (const f of files) {
    const src = L.maskCommentsKeepLength(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) def.add(m[1]);
    for (const m of src.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9-]+)['"]/g)) def.add(m[1]);
  }
  return def;
}

const allFiles = L.walkSrc(path.join(L.ROOT, 'web'), p => /\.(js|mjs|cjs|css|html)$/.test(p));
const tplDir = path.join(L.ROOT, 'tools', 'vue-templates');
const tplFiles = fs.existsSync(tplDir)
  ? fs.readdirSync(tplDir).filter(f => f.endsWith('.html')).map(f => path.join(tplDir, f))
  : [];
const scanFiles = allFiles.concat(tplFiles);
const def = definedVars(scanFiles);

const bad = [];
const used = new Map();
for (const f of scanFiles) {
  const rel = path.relative(L.ROOT, f).replace(/\\/g, '/');
  const src = L.maskCommentsKeepLength(fs.readFileSync(f, 'utf8'));
  const lines = src.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      const name = m[1];
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(`${rel}:${i + 1}`);
      if (def.has(name)) continue;
      if (RUNTIME_VARS[name]) continue;          // 运行时由 JS 写上去的令牌
      bad.push({ name, at: `${rel}:${i + 1}` });
    }
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ bad, count: bad.length }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

console.log(`令牌引用体检：${scanFiles.length} 个源文件，引用了 ${used.size} 枚令牌`);
if (!bad.length) {
  console.log('✓ 没有未定义的令牌引用');
  process.exit(0);
}
console.log(`✗ ${bad.length} 处引用了未定义的令牌：`);
const byName = new Map();
for (const b of bad) {
  if (!byName.has(b.name)) byName.set(b.name, []);
  byName.get(b.name).push(b.at);
}
for (const [name, ats] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${name}  ×${ats.length}`);
  ats.slice(0, 6).forEach((a) => console.log(`      ${a}`));
  if (ats.length > 6) console.log(`      …另 ${ats.length - 6} 处`);
}
process.exit(1);
